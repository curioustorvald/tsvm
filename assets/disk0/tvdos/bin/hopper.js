/**
 * Hopper is a package manager for TVDOS
 * Created by CuriousTorvald on 2026-04-16
 */

const SYSTEM_PACKEAGE_DEF_DIR  = "A:/tvdos/hopper"
const USER_BASE_DIR            = "A:/hopper"
const USER_PACKAGE_DEF_DIR     = `${USER_BASE_DIR}/manifests`
const USER_PACKAGE_BIN_DIR     = `${USER_BASE_DIR}/bin`
const USER_PACKAGE_INCLUDE_DIR = `${USER_BASE_DIR}/include`
const MANIFEST_EXT = "hop.per"
const MIRROR_LIST_PATH = `${SYSTEM_PACKEAGE_DEF_DIR}/mirrors.list`

const net = require("net")

// SYNOPSIS
// hopper {search,se} [--provides, --requires, --description, --author] query
//// default searches from ProperName
// hopper {install,in} query [-v version]
// hopper {remove,rm} query

// ============================================================
// Manifest parsing
// ============================================================

function splitList(s) {
    if (!s) return []
    return s.split(";").map(it => it.trim()).filter(it => it.length > 0)
}

function parseManifest(text) {
    const m = {}
    text.split("\n").forEach(rawLine => {
        const line = rawLine.replace(/\r$/, "")
        if (line.length === 0) return
        const idx = line.indexOf(":")
        if (idx < 0) return
        const key = line.substring(0, idx).trim()
        const value = line.substring(idx + 1).trim()
        m[key] = value
    })
    return m
}

function readManifestFile(path) {
    const f = files.open(path)
    if (!f.exists || f.isDirectory) return undefined
    const m = parseManifest(f.sread())
    m._manifestPath = path
    return m
}

function _listManifestsFrom(dirPath, origin) {
    const dir = files.open(dirPath)
    if (!dir.exists || !dir.isDirectory) return []
    const out = []
    dir.list().forEach(entry => {
        if (entry.isDirectory) return
        if (!entry.name.toLowerCase().endsWith(MANIFEST_EXT)) return
        const m = readManifestFile(entry.fullPath)
        if (m !== undefined) {
            m._origin = origin
            out.push(m)
        }
    })
    return out
}

// System packages (shipped with TVDOS) live in SYSTEM_PACKAGE_DEF_DIR
// and are read-only as far as hopper is concerned. User packages,
// installed by `hopper install`, live under USER_PACKAGE_DEF_DIR. The
// resolver treats both as "installed", but the install/remove paths
// refuse to modify anything tagged `_origin === "system"`.
function listInstalledManifests() {
    return _listManifestsFrom(SYSTEM_PACKEAGE_DEF_DIR, "system")
        .concat(_listManifestsFrom(USER_PACKAGE_DEF_DIR, "user"))
}

function findInstalledManifest(name) {
    // Prefer user-installed copy when a system package with the same name
    // also exists -- but that combination is normally refused at install.
    const userDirect = `${USER_PACKAGE_DEF_DIR}/${name}.${MANIFEST_EXT}`
    let m = readManifestFile(userDirect)
    if (m !== undefined) { m._origin = "user"; return m }

    const sysDirect = `${SYSTEM_PACKEAGE_DEF_DIR}/${name}.${MANIFEST_EXT}`
    m = readManifestFile(sysDirect)
    if (m !== undefined) { m._origin = "system"; return m }

    const all = listInstalledManifests()
    for (let i = 0; i < all.length; i++) {
        if ((all[i].HopperPackageName || "") === name) return all[i]
    }
    return undefined
}

// Yes/no prompt. Empty input falls back to `defaultYes`.
function confirm(prompt, defaultYes) {
    const hint = defaultYes ? "[Y/n]" : "[y/N]"
    print(`${prompt} ${hint} `)
    const ans = (read() || "").trim().toLowerCase()
    if (ans === "") return !!defaultYes
    return ans === "y" || ans === "yes"
}

// ============================================================
// Install layout helpers
// ============================================================
//
// User-installed packages live under `A:/hopper/`. Files are routed
// by extension: `.mjs` includes go under `include/`, everything else
// (`.js`, `.alias`, `.lfs`, data blobs, ...) lands in `bin/`. The
// downloaded manifest is saved under `manifests/` with a
// `SystemPackagePath` field appended that lists the resulting paths.

// Strip query/fragment and take the last `/`-separated component of `url`.
function urlBasename(url) {
    let s = String(url || "")
    const qm = s.indexOf("?");   if (qm   >= 0) s = s.substring(0, qm)
    const hash = s.indexOf("#"); if (hash >= 0) s = s.substring(0, hash)
    const slash = s.lastIndexOf("/")
    return (slash < 0) ? s : s.substring(slash + 1)
}

function routeForBasename(name) {
    return (String(name || "").toLowerCase().endsWith(".mjs"))
        ? USER_PACKAGE_INCLUDE_DIR
        : USER_PACKAGE_BIN_DIR
}

// Convert a USER_BASE_DIR-relative absolute path ("A:/hopper/bin/foo.js")
// into its declarable form ("/hopper/bin/foo.js"), matching the
// `SystemPackagePath` convention used by the system manifests.
function declarablePath(absPath) {
    let p = String(absPath || "").replace(/\\/g, "/")
    if (/^[A-Za-z]:/.test(p)) p = p.substring(2)
    return p
}

// Parse PackageFileList (semicolon-separated full URLs) into a list of
// download descriptors: { url, basename, localPath }.
function parsePackageFileList(s) {
    const out = []
    splitList(s || "").forEach(url => {
        const base = urlBasename(url)
        if (base.length === 0) return
        const dir  = routeForBasename(base)
        out.push({ url: url, basename: base, localPath: `${dir}/${base}` })
    })
    return out
}

function ensureUserDirs() {
    [USER_BASE_DIR, USER_PACKAGE_BIN_DIR, USER_PACKAGE_INCLUDE_DIR, USER_PACKAGE_DEF_DIR].forEach(p => {
        const d = files.open(p)
        if (!d.exists) d.mkDir()
    })
}

// Re-emit a parsed manifest, preserving insertion order, dropping
// internal `_*` keys, and replacing any pre-existing SystemPackagePath
// with the locally-computed one so the field always reflects what is
// actually on disk.
function serializeManifest(manifestObj, installedPathStr) {
    const lines = []
    Object.keys(manifestObj).forEach(k => {
        if (k.length > 0 && k[0] === "_") return
        if (k === "SystemPackagePath") return
        lines.push(`${k}:${manifestObj[k]}`)
    })
    lines.push(`SystemPackagePath:${installedPathStr}`)
    return lines.join("\n") + "\n"
}

// Delete every file declared in `manifest.SystemPackagePath` plus the
// manifest file itself. Wildcards are expanded via `expandSystemPath`.
function deleteInstalledFiles(manifest) {
    const removed = []
    splitList(manifest.SystemPackagePath || "").forEach(p => {
        expandSystemPath(p).forEach(abs => {
            const fd = files.open(abs)
            if (!fd.exists) return
            try { fd.remove(); removed.push(abs) }
            catch (e) { printerrln(`  ! failed to remove ${abs}: ${e}`) }
        })
    })
    if (manifest._manifestPath) {
        const mfd = files.open(manifest._manifestPath)
        if (mfd.exists) {
            try { mfd.remove(); removed.push(manifest._manifestPath) }
            catch (e) { printerrln(`  ! failed to remove ${manifest._manifestPath}: ${e}`) }
        }
    }
    return removed
}

// ============================================================
// SemVer (strict X.Y.Z) and constraint matching
// ============================================================
//
// Versions are strict Semantic Versioning: three non-negative integer
// components MAJOR.MINOR.PATCH. No pre-release / build metadata.
//
// Constraint grammar (intentionally small, expandable later):
//   *           any version
//   X.*         major X, any minor/patch
//   X.Y.*       major X, minor Y, any patch
//   X.Y.Z       exact
//   ^X.Y.Z      >= X.Y.Z and < (X+1).0.0  (major-compatible)
//   ~X.Y.Z      >= X.Y.Z and < X.(Y+1).0  (minor-compatible)
//   >=X.Y.Z / >X.Y.Z / <=X.Y.Z / <X.Y.Z / =X.Y.Z
//
// Multiple comma-separated constraints are AND-ed: "^1.2.0,<1.5.0".

function parseVersion(v) {
    const m = String(v || "0.0.0").trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
    if (!m) return [0, 0, 0]
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

function compareVersion(a, b) {
    const A = parseVersion(a), B = parseVersion(b)
    for (let i = 0; i < 3; i++) {
        if (A[i] !== B[i]) return (A[i] < B[i]) ? -1 : 1
    }
    return 0
}

function _matchSingleConstraint(version, c) {
    c = c.trim()
    if (c === "" || c === "*") return true

    // Operator form: ^, ~, >=, <=, >, <, =
    let opMatch = c.match(/^(\^|~|>=|<=|>|<|=)\s*(\d+\.\d+\.\d+)$/)
    if (opMatch) {
        const op = opMatch[1]
        const target = opMatch[2]
        const cmp = compareVersion(version, target)
        const [tM, tm] = parseVersion(target)
        switch (op) {
            case "=":  return cmp === 0
            case ">":  return cmp >  0
            case ">=": return cmp >= 0
            case "<":  return cmp <  0
            case "<=": return cmp <= 0
            case "^":  return cmp >= 0 && compareVersion(version, `${tM + 1}.0.0`) < 0
            case "~":  return cmp >= 0 && compareVersion(version, `${tM}.${tm + 1}.0`) < 0
        }
    }

    // Wildcard form: X.*, X.Y.*, X.x, X.Y.x, or exact X.Y.Z
    const parts = c.split(".")
    const vparts = parseVersion(version)
    for (let i = 0; i < parts.length && i < 3; i++) {
        if (parts[i] === "*" || parts[i] === "x" || parts[i] === "X") return true
        const expected = parseInt(parts[i], 10)
        if (isNaN(expected) || vparts[i] !== expected) return false
    }
    // All listed parts matched literally; remaining parts (if any) must be 0
    for (let i = parts.length; i < 3; i++) {
        if (vparts[i] !== 0) return false
    }
    return true
}

function satisfies(version, constraint) {
    if (!constraint) return true
    return constraint.split(",").every(c => _matchSingleConstraint(version, c))
}

function parseRequires(s) {
    const out = []
    splitList(s || "").forEach(entry => {
        // "<name>" or "<name> <constraint>"
        const idx = entry.search(/\s+/)
        if (idx < 0) {
            out.push({ name: entry, constraint: "*" })
        } else {
            out.push({ name: entry.substring(0, idx), constraint: entry.substring(idx + 1).trim() })
        }
    })
    return out
}

// HopperProvides entries are "<name>" or "<name> <version>". A bare name
// falls back to the package's own HopperPackageVersion — the same idea
// as RPM's `Provides: aalib = 1.2.0` (where the package's real name and
// version may differ from the virtual identity it exposes).
function parseProvides(s, fallbackVersion) {
    const out = []
    splitList(s || "").forEach(entry => {
        const idx = entry.search(/\s+/)
        if (idx < 0) {
            out.push({ name: entry, version: fallbackVersion })
        } else {
            const v = entry.substring(idx + 1).trim()
            out.push({ name: entry.substring(0, idx), version: v || fallbackVersion })
        }
    })
    return out
}

// Look up the version a candidate exposes for `name`. If `name` matches
// the package's own name (or isn't declared in HopperProvides at all),
// returns the package's own version.
function providedVersionOf(candidate, name) {
    if (candidate.provides) {
        for (let i = 0; i < candidate.provides.length; i++) {
            if (candidate.provides[i].name === name) return candidate.provides[i].version
        }
    }
    return candidate.version
}

// ============================================================
// Candidate index (installed + upstream)
// ============================================================

function _manifestToCandidate(m, source) {
    const name    = m.HopperPackageName || ""
    const version = m.HopperPackageVersion || "0.0.0"
    const provides = parseProvides(m.HopperProvides || "", version)
    // Every package implicitly provides itself at its own version. Only
    // synthesise this when the manifest didn't declare it explicitly.
    if (name && !provides.some(p => p.name === name)) {
        provides.unshift({ name: name, version: version })
    }
    return {
        name:     name,
        version:  version,
        requires: parseRequires(m.HopperRequires || ""),
        provides: provides,
        source:   source, // "installed" | "upstream"
        manifest: m
    }
}

// Returns map: packageName -> array<Candidate>
function buildCandidateIndex() {
    const idx = new Map()
    function add(c) {
        if (!idx.has(c.name)) idx.set(c.name, [])
        // De-dupe (name+version+source)
        const arr = idx.get(c.name)
        if (arr.some(x => x.version === c.version && x.source === c.source)) return
        arr.push(c)
    }

    listInstalledManifests().forEach(m => add(_manifestToCandidate(m, "installed")))
    fetchRemoteCandidates().forEach(m => add(_manifestToCandidate(m, "upstream")))

    return idx
}

// Anything that satisfies a requirement on `name`: a package whose own
// HopperPackageName matches OR whose HopperProvides declares `name`.
// Each candidate now carries `provides` as {name, version} pairs; the
// package's own (name, version) is always present (see
// _manifestToCandidate), so a single pass over `provides` is enough.
function findProviders(idx, name) {
    const out = []
    const seen = new Set()
    idx.forEach(candidates => {
        candidates.forEach(c => {
            if (seen.has(c)) return
            if (c.provides.some(p => p.name === name)) {
                out.push(c)
                seen.add(c)
            }
        })
    })
    return out
}

// Sort: installed first (no churn), then highest version, then upstream order.
function sortCandidates(cands) {
    return cands.slice().sort((a, b) => {
        if (a.source !== b.source) return (a.source === "installed") ? -1 : 1
        return -compareVersion(a.version, b.version)
    })
}

// ============================================================
// Resolver (snapshot-based backtracking; precursor to a SAT solver)
// ============================================================
//
// State: chosen :: Map<packageName, Candidate>
// At every choice point we snapshot the whole map so that backtracking
// also undoes any transitive picks. The candidate ordering encodes the
// preference policy:
//
//   1. Keep installed if it satisfies the constraint.
//   2. Otherwise pick the newest upstream version that satisfies.
//   3. If newer versions cause downstream conflicts, walk older versions
//      (downgrade) until either something fits or candidates are exhausted.
//
// The structure is intentionally close to DPLL: each "decision" is the
// candidate we assign to a variable, and "unit propagation" is the
// recursive resolve() call over each requirement. Replacing this with
// clause learning / a watched-literals scheme later would be local.

function resolveAll(idx, requirements) {
    const chosen = new Map()
    const issues = []

    function snapshot()           { return new Map(chosen) }
    function restore(snap)        { chosen.clear(); snap.forEach((v, k) => chosen.set(k, v)) }

    function _resolve(reqName, constraint, trail) {
        const existing = chosen.get(reqName)
        if (existing !== undefined) {
            const v = providedVersionOf(existing, reqName)
            return satisfies(v, constraint)
                ? { ok: true }
                : { ok: false, reason: `${reqName} pinned to ${v}, but ${trail.join(" -> ")} requires ${constraint}` }
        }

        const providers = findProviders(idx, reqName)
        if (providers.length === 0) {
            return { ok: false, reason: `no package provides "${reqName}" (required by ${trail.join(" -> ") || "<root>"})` }
        }
        // Satisfaction checks the virtual version the candidate exposes
        // for `reqName` (HopperProvides), not necessarily the package's
        // own HopperPackageVersion.
        const matching = sortCandidates(providers.filter(c => satisfies(providedVersionOf(c, reqName), constraint)))
        if (matching.length === 0) {
            const versions = providers.map(p => `${providedVersionOf(p, reqName)}[${p.source}]`).join(", ")
            return { ok: false, reason: `no version of "${reqName}" satisfies ${constraint} (available: ${versions})` }
        }

        let lastReason = null
        for (let i = 0; i < matching.length; i++) {
            const cand = matching[i]
            const snap = snapshot()
            chosen.set(cand.name, cand)

            let allOk = true
            const subTrail = trail.concat([`${cand.name}@${cand.version}`])
            for (let j = 0; j < cand.requires.length; j++) {
                const req = cand.requires[j]
                const r = _resolve(req.name, req.constraint, subTrail)
                if (!r.ok) {
                    allOk = false
                    lastReason = r.reason
                    break
                }
            }
            if (allOk) return { ok: true }
            restore(snap)
        }

        return { ok: false, reason: lastReason || `no working candidate for "${reqName}"` }
    }

    requirements.forEach(req => {
        const r = _resolve(req.name, req.constraint, [])
        if (!r.ok) issues.push(r.reason)
    })

    return { chosen, issues }
}

// Compare resolved assignment against currently-installed state.
function classifyPlan(idx, chosen) {
    const installedByName = new Map()
    listInstalledManifests().forEach(m => installedByName.set(m.HopperPackageName, m))

    const actions = []
    chosen.forEach((cand, name) => {
        const inst = installedByName.get(name)
        if (cand.source === "installed") {
            actions.push({ action: "keep", name, version: cand.version })
        }
        else if (inst === undefined) {
            actions.push({ action: "install", name, version: cand.version })
        }
        else {
            const cmp = compareVersion(cand.version, inst.HopperPackageVersion)
            if      (cmp > 0) actions.push({ action: "upgrade",   name, from: inst.HopperPackageVersion, to: cand.version })
            else if (cmp < 0) actions.push({ action: "downgrade", name, from: inst.HopperPackageVersion, to: cand.version })
            else              actions.push({ action: "reinstall", name, version: cand.version })
        }
    })
    return actions
}

function printPlan(actions, target) {
    const changing = actions.filter(a => a.action !== "keep")
    if (changing.length === 0) {
        println(`Nothing to do: ${target} is already installed and satisfied.`)
        return
    }
    println("Plan:")
    changing.forEach(a => {
        switch (a.action) {
            case "install":   println(`  + install    ${a.name} ${a.version}`); break
            case "upgrade":   println(`  ^ upgrade    ${a.name} ${a.from} -> ${a.to}`); break
            case "downgrade": println(`  v downgrade  ${a.name} ${a.from} -> ${a.to}`); break
            case "reinstall": println(`  = reinstall  ${a.name} ${a.version}`); break
        }
    })
}

// ============================================================
// Remote mirrors
// ============================================================
//
// `mirrors.list` lives next to the installed package manifests.
// Each non-empty, non-`#` line is the URL prefix of a Hopper mirror.
// The mirror MUST expose `<prefix>mirror_manifest` (key:value pairs
// describing the mirror) and `<prefix>filelist` (CSV with rows of
// `packagename,version,hoppermanifest-filename`).
//
// Trailing slash on the prefix is optional and will be added if missing.

function loadMirrorList() {
    const f = files.open(MIRROR_LIST_PATH)
    if (!f.exists || f.isDirectory) return []
    return f.sread().split("\n")
        .map(line => line.replace(/\r$/, "").trim())
        .filter(line => line.length > 0 && line[0] !== "#")
        .map(line => line.endsWith("/") ? line : (line + "/"))
}

function parseFileList(text) {
    const out = []
    text.split("\n").forEach(raw => {
        const line = raw.replace(/\r$/, "").trim()
        if (line.length === 0 || line[0] === "#") return
        const parts = line.split(",")
        if (parts.length < 3) return
        out.push({
            name:    parts[0].trim(),
            version: parts[1].trim(),
            file:    parts[2].trim(),
        })
    })
    return out
}

function fetchManifestsFromMirror(prefix) {
    const mfText = net.fetchText(prefix + "mirror_manifest")
    if (mfText === null) {
        printerrln(`  ! could not reach mirror: ${prefix}`)
        return []
    }
    const mirror = parseManifest(mfText)
    const mirrorName = mirror.HopperMirrorName || prefix

    const flText = net.fetchText(prefix + "filelist")
    if (flText === null) {
        printerrln(`  ! mirror "${mirrorName}" has no filelist`)
        return []
    }

    const out = []
    parseFileList(flText).forEach(entry => {
        const manifestText = net.fetchText(prefix + entry.file)
        if (manifestText === null) {
            printerrln(`  ! mirror "${mirrorName}" missing ${entry.file}`)
            return
        }
        const m = parseManifest(manifestText)
        m._mirrorName   = mirrorName
        m._mirrorPrefix = prefix
        m._manifestUrl  = prefix + entry.file
        out.push(m)
    })
    return out
}

// Per-invocation memoisation. Search and install both pull the same
// data; we only want to hit the network once per `hopper ...` call.
let _remoteCache = null

function fetchRemoteCandidates() {
    if (_remoteCache !== null) return _remoteCache

    const mirrors = loadMirrorList()
    if (mirrors.length === 0) {
        _remoteCache = []
        return _remoteCache
    }

    if (!net.isAvailable()) {
        printerrln("Warning: no HTTP modem attached; remote mirrors will be skipped.")
        _remoteCache = []
        return _remoteCache
    }

    const out = []
    mirrors.forEach(prefix => {
        fetchManifestsFromMirror(prefix).forEach(m => out.push(m))
    })
    _remoteCache = out
    return _remoteCache
}

// ============================================================
// Search
// ============================================================

function fieldCandidates(manifest, field) {
    switch (field) {
        case "provides":    return splitList(manifest.HopperProvides || "")
        case "requires":    return splitList(manifest.HopperRequires || "")
        case "description": return [manifest.ProperDescription || ""]
        case "author":      return [manifest.ProperAuthor || ""]
        default:            return [manifest.ProperName || "", manifest.HopperPackageName || ""]
    }
}

function matchesQuery(manifest, field, query) {
    const q = query.toLowerCase()
    return fieldCandidates(manifest, field).some(c => c.toLowerCase().indexOf(q) >= 0)
}

function printSearchResult(m, origin) {
    const name = m.ProperName || m.HopperPackageName || "(unnamed)"
    const ver  = m.HopperPackageVersion || "?"
    println(`  [${origin}] ${name} -- ${m.HopperPackageName} ${ver}`)
    if (m.ProperDescription) println(`           ${m.ProperDescription}`)
}

function cmdSearch(args) {
    let field = "name"
    let query = undefined
    for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if      (a === "--provides")    field = "provides"
        else if (a === "--requires")    field = "requires"
        else if (a === "--description") field = "description"
        else if (a === "--author")      field = "author"
        else if (a.startsWith("--"))    { printerrln(`Unknown option: ${a}`); return 1 }
        else                            query = a
    }
    if (query === undefined) {
        printerrln("Usage: hopper search [--provides|--requires|--description|--author] <query>")
        return 1
    }

    println(`Searching installed packages in ${SYSTEM_PACKEAGE_DEF_DIR} ...`)
    const sysHits = listInstalledManifests().filter(m => matchesQuery(m, field, query))
    if (sysHits.length === 0) println("  (no matches)")
    else sysHits.forEach(m => printSearchResult(m, "installed"))

    println("")
    println("Searching remote mirrors ...")
    const remote = fetchRemoteCandidates()
    if (remote.length === 0) {
        println("  (no mirrors configured or reachable)")
    }
    else {
        const netHits = remote.filter(m => matchesQuery(m, field, query))
        if (netHits.length === 0) println("  (no matches)")
        else netHits.forEach(m => printSearchResult(m, m._mirrorName || "remote"))
    }

    return 0
}

// ============================================================
// Install
// ============================================================
//
// Each upstream manifest declares its payload via `PackageFileList`,
// a semicolon-separated list of full URLs. Hopper fetches each URL and
// drops the result in /hopper/bin (default) or /hopper/include (.mjs).
// The locally-saved manifest gets a `SystemPackagePath` field appended
// listing the resulting absolute paths, which is what `cmdRemove` later
// walks to clean up.

function _installOne(action, candidate) {
    const m = candidate.manifest
    const files_ = parsePackageFileList(m.PackageFileList)
    if (files_.length === 0) {
        printerrln(`  ! ${candidate.name}: upstream manifest has no PackageFileList; cannot install`)
        return false
    }

    // Fetch first, write second: a single 404 should not leave a
    // half-installed package behind.
    const fetched = []
    for (let i = 0; i < files_.length; i++) {
        const f = files_[i]
        println(`  fetch  ${f.url}`)
        const body = net.fetchText(f.url)
        if (body === null || body === undefined) {
            printerrln(`  ! failed to fetch ${f.url}`)
            return false
        }
        fetched.push({ entry: f, body: body })
    }

    // If we are replacing an existing user-installed copy, remove its
    // old files first so a renamed payload doesn't leave orphans.
    if (action !== "install") {
        const oldManifestPath = `${USER_PACKAGE_DEF_DIR}/${candidate.name}.${MANIFEST_EXT}`
        const old = readManifestFile(oldManifestPath)
        if (old !== undefined) {
            splitList(old.SystemPackagePath || "").forEach(p => {
                expandSystemPath(p).forEach(abs => {
                    const fd = files.open(abs)
                    if (fd.exists) {
                        try { fd.remove() }
                        catch (e) { printerrln(`  ! could not remove old ${abs}: ${e}`) }
                    }
                })
            })
        }
    }

    // Write payload files.
    fetched.forEach(item => {
        const fd = files.open(item.entry.localPath)
        if (!fd.exists) fd.mkFile()
        fd.swrite(item.body)
        println(`  write  ${item.entry.localPath}`)
    })

    // Save the manifest with SystemPackagePath appended.
    const sysPath = fetched.map(item => declarablePath(item.entry.localPath)).join(";")
    const manifestPath = `${USER_PACKAGE_DEF_DIR}/${candidate.name}.${MANIFEST_EXT}`
    const mfd = files.open(manifestPath)
    if (!mfd.exists) mfd.mkFile()
    mfd.swrite(serializeManifest(m, sysPath))
    println(`  write  ${manifestPath}`)
    return true
}

function cmdInstall(args) {
    let query = undefined
    let version = undefined
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "-v") { version = args[i + 1]; i++ }
        else if (args[i].startsWith("--")) { printerrln(`Unknown option: ${args[i]}`); return 1 }
        else query = args[i]
    }
    if (query === undefined) {
        printerrln("Usage: hopper install <package> [-v <version>]")
        return 1
    }

    const targetConstraint = version || "*"
    const verSuffix = (targetConstraint !== "*") ? ` (${targetConstraint})` : ""
    println(`Resolving ${query}${verSuffix} ...`)

    const idx = buildCandidateIndex()

    // Sanity check: target must exist in the index (installed or upstream).
    if (findProviders(idx, query).length === 0) {
        printerrln(`Error: package "${query}" not found (not on upstream, not installed).`)
        return 4
    }

    // Seed order matters: the target goes FIRST so its (possibly tight)
    // constraints can drive upgrades of dependencies. The installed-set
    // requirements follow at "*" so the resolver still has to keep them
    // alive (preferring installed candidates when their version still fits,
    // otherwise upgrading or downgrading them).
    const seed = [{ name: query, constraint: targetConstraint }]
    listInstalledManifests().forEach(m => {
        if (m.HopperPackageName === query) return
        seed.push({ name: m.HopperPackageName, constraint: "*" })
    })

    const { chosen, issues } = resolveAll(idx, seed)
    if (issues.length > 0) {
        printerrln("Resolution failed:")
        issues.forEach(reason => printerrln(`  - ${reason}`))
        printerrln("")
        printerrln("No solution found -- not installable.")
        return 3
    }

    const plan = classifyPlan(idx, chosen)
    printPlan(plan, query)

    const changing = plan.filter(a => a.action !== "keep")
    if (changing.length === 0) return 0

    // Pre-flight: refuse to clobber system packages, and require every
    // upstream candidate to actually carry a payload list.
    const blockers = []
    changing.forEach(a => {
        const cand = chosen.get(a.name)
        const inst = findInstalledManifest(a.name)
        if (inst && inst._origin === "system") {
            blockers.push(`${a.name}: cannot ${a.action} -- a system package with that name is already installed`)
        }
        if (cand && cand.source === "upstream" && !(cand.manifest.PackageFileList && cand.manifest.PackageFileList.length > 0)) {
            blockers.push(`${a.name}: upstream manifest declares no PackageFileList`)
        }
    })
    if (blockers.length > 0) {
        printerrln("Cannot proceed:")
        blockers.forEach(b => printerrln(`  - ${b}`))
        return 5
    }

    if (!net.isAvailable()) {
        printerrln("No HTTP modem attached; cannot fetch package files.")
        return 6
    }

    println("")
    if (!confirm("Proceed with installation?", true)) {
        println("Aborted.")
        return 0
    }

    ensureUserDirs()

    let failed = 0
    for (let i = 0; i < changing.length; i++) {
        const a = changing[i]
        const cand = chosen.get(a.name)
        if (a.action === "install" || a.action === "reinstall") {
            println(`${a.action} ${a.name} ${a.version}`)
        } else {
            println(`${a.action} ${a.name} ${a.from} -> ${a.to}`)
        }
        if (!_installOne(a.action, cand)) {
            failed++
            printerrln(`  ! ${a.name}: aborted`)
            break
        }
    }
    if (failed > 0) {
        printerrln(`${failed} package(s) failed to install.`)
        return 7
    }

    println("Done.")
    return 0
}

// ============================================================
// Remove
// ============================================================

// Convert a SystemPackagePath entry (e.g. "/tvdos/bin/taut*") into a
// concrete list of files on the A: drive. Supports a simple '*' wildcard
// in the filename component.
function expandSystemPath(pattern) {
    const sysDrive = "A:"

    if (pattern.indexOf("*") < 0) {
        return [`${sysDrive}${pattern}`]
    }

    const fwd = pattern.lastIndexOf("/")
    const bck = pattern.lastIndexOf("\\")
    const lastSep = Math.max(fwd, bck)
    const dirPart  = (lastSep < 0) ? "" : pattern.substring(0, lastSep)
    const namePart = (lastSep < 0) ? pattern : pattern.substring(lastSep + 1)

    const dir = files.open(`${sysDrive}${dirPart}/`)
    if (!dir.exists || !dir.isDirectory) return []

    const escaped = namePart.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
    const re = new RegExp(`^${escaped}$`, "i")

    const out = []
    dir.list().forEach(entry => {
        if (entry.isDirectory) return
        if (re.test(entry.name)) out.push(entry.fullPath)
    })
    return out
}

function cmdRemove(args) {
    const query = args[0]
    if (query === undefined) {
        printerrln("Usage: hopper remove <package>")
        return 1
    }

    const m = findInstalledManifest(query)
    if (m === undefined) {
        printerrln(`Package not installed: ${query}`)
        return 2
    }
    if (m._origin === "system") {
        printerrln(`Cannot remove ${query}: it is a system package.`)
        return 6
    }

    const name = m.ProperName || m.HopperPackageName || query
    const ver  = m.HopperPackageVersion || "?"
    println(`Preparing removal of ${name} (${m.HopperPackageName} ${ver}) ...`)

    const paths = splitList(m.SystemPackagePath || "")
    println("")
    println("The following files will be deleted:")
    if (paths.length === 0) {
        println("  (manifest declares no files)")
    }
    paths.forEach(p => {
        const expanded = expandSystemPath(p)
        if (expanded.length === 0) {
            println(`  (no match on disk) ${p}`)
        }
        else {
            expanded.forEach(e => println(`  ${e}`))
        }
    })
    println(`  ${m._manifestPath}`)

    println("")
    if (!confirm("Proceed with removal?", false)) {
        println("Aborted.")
        return 0
    }

    const removed = deleteInstalledFiles(m)
    removed.forEach(p => println(`  removed ${p}`))
    if (removed.length === 0) println("  (nothing was removed)")
    return 0
}

// ============================================================
// Dispatch
// ============================================================

function printUsage() {
    println("Hopper - Package manager for TVDOS")
    println("")
    println("Usage:")
    println("  hopper {search,se} [--provides|--requires|--description|--author] <query>")
    println("  hopper {install,in} <package> [-v <version>]")
    println("  hopper {remove,rm} <package>")
}

const _hopperArgs = (typeof exec_args !== "undefined" && exec_args) ? exec_args.slice(1) : []
const _hopperCmd  = _hopperArgs[0]
const _hopperRest = _hopperArgs.slice(1)

switch (_hopperCmd) {
    case "search":
    case "se":
        return cmdSearch(_hopperRest)
    case "install":
    case "in":
        return cmdInstall(_hopperRest)
    case "remove":
    case "rm":
        return cmdRemove(_hopperRest)
    case undefined:
        printUsage()
        return 0
    default:
        printerrln(`Unknown command: ${_hopperCmd}`)
        printUsage()
        return 1
}
