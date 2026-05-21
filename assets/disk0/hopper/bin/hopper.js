/**
 * Hopper is a package manager for TVDOS
 * Created by CuriousTorvald on 2026-04-16
 */

const SYSTEM_PACKEAGE_DEF_DIR = "A:/tvdos/hopper"
const MANIFEST_EXT = "hop.per"

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

function listInstalledManifests() {
    const dir = files.open(SYSTEM_PACKEAGE_DEF_DIR)
    if (!dir.exists || !dir.isDirectory) return []
    const out = []
    dir.list().forEach(entry => {
        if (entry.isDirectory) return
        if (!entry.name.toLowerCase().endsWith(MANIFEST_EXT)) return
        const m = readManifestFile(entry.fullPath)
        if (m !== undefined) out.push(m)
    })
    return out
}

function findInstalledManifest(name) {
    const direct = `${SYSTEM_PACKEAGE_DEF_DIR}/${name}${MANIFEST_EXT}`
    const m = readManifestFile(direct)
    if (m !== undefined) return m
    const all = listInstalledManifests()
    for (let i = 0; i < all.length; i++) {
        if ((all[i].HopperPackageName || "") === name) return all[i]
    }
    return undefined
}

function isSystemPackage(manifest) {
    return !!(manifest.SystemPackagePath) // true if the field is truthy (not undefined, not empty string, not string '0', etc.)
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

// ============================================================
// Candidate index (installed + upstream)
// ============================================================

function _manifestToCandidate(m, source) {
    return {
        name:     m.HopperPackageName || "",
        version:  m.HopperPackageVersion || "0.0.0",
        requires: parseRequires(m.HopperRequires || ""),
        provides: splitList(m.HopperProvides || ""),
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

// Anything that satisfies a requirement on `name`: package whose own name is
// `name`, OR whose HopperProvides includes `name`.
function findProviders(idx, name) {
    const direct = idx.get(name) ? idx.get(name).slice() : []
    const indirect = []
    idx.forEach(candidates => {
        candidates.forEach(c => {
            if (c.name === name) return // already in `direct`
            if (c.provides.indexOf(name) >= 0) indirect.push(c)
        })
    })
    return direct.concat(indirect)
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
            return satisfies(existing.version, constraint)
                ? { ok: true }
                : { ok: false, reason: `${reqName} pinned to ${existing.version}, but ${trail.join(" -> ")} requires ${constraint}` }
        }

        const providers = findProviders(idx, reqName)
        if (providers.length === 0) {
            return { ok: false, reason: `no package provides "${reqName}" (required by ${trail.join(" -> ") || "<root>"})` }
        }
        const matching = sortCandidates(providers.filter(c => satisfies(c.version, constraint)))
        if (matching.length === 0) {
            const versions = providers.map(p => `${p.version}[${p.source}]`).join(", ")
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
// Search
// ============================================================

// Dummy "remote" repository -- pretends to be a network query result.
// Multiple entries per HopperPackageName represent multiple available
// versions; the resolver picks among them.
const FAKE_REMOTE_PACKAGES = [
    // doomster: single version, needs libgl 1.*
    {
        HopperPackageName: "doomster", HopperPackageVersion: "0.9.3",
        ProperName: "Doomster", ProperAuthor: "id Sortware",
        ProperDescription: "First-person shooter game for TSVM",
        HopperProvides: "doomster;", HopperRequires: "tvdos 1.*;libgl 1.*"
    },

    // libfft: three versions
    {
        HopperPackageName: "libfft", HopperPackageVersion: "0.1.0",
        ProperName: "LibFFT", ProperAuthor: "Soraya Vaughn",
        ProperDescription: "Fast Fourier Transform library for TSVM",
        HopperProvides: "libfft;", HopperRequires: "tvdos 1.*"
    },
    {
        HopperPackageName: "libfft", HopperPackageVersion: "0.2.0",
        ProperName: "LibFFT", ProperAuthor: "Soraya Vaughn",
        ProperDescription: "Fast Fourier Transform library for TSVM",
        HopperProvides: "libfft;", HopperRequires: "tvdos 1.*"
    },
    {
        HopperPackageName: "libfft", HopperPackageVersion: "1.0.0",
        ProperName: "LibFFT", ProperAuthor: "Soraya Vaughn",
        ProperDescription: "Fast Fourier Transform library for TSVM",
        HopperProvides: "libfft;", HopperRequires: "tvdos 1.*"
    },

    // chatlite: 2.1.5 fits installed wintex 1.*; 3.0.0 demands wintex 2.*
    {
        HopperPackageName: "chatlite", HopperPackageVersion: "2.1.5",
        ProperName: "ChatLite", ProperAuthor: "TerraNetworks Co.",
        ProperDescription: "Lightweight IRC-style chat client",
        HopperProvides: "chatlite;", HopperRequires: "tvdos 1.*;wintex 1.*"
    },
    {
        HopperPackageName: "chatlite", HopperPackageVersion: "3.0.0",
        ProperName: "ChatLite", ProperAuthor: "TerraNetworks Co.",
        ProperDescription: "Lightweight IRC-style chat client",
        HopperProvides: "chatlite;", HopperRequires: "tvdos 1.*;wintex 2.*"
    },

    // snakey
    {
        HopperPackageName: "snakey", HopperPackageVersion: "1.4.0",
        ProperName: "Snakey", ProperAuthor: "Iben Holst",
        ProperDescription: "Classic snake game with TerranBASIC scripting",
        HopperProvides: "snakey;", HopperRequires: "tvdos 1.*;libterranbasic 1.*"
    },

    // libgl future version (lets superchef pull in an upgrade)
    {
        HopperPackageName: "libgl", HopperPackageVersion: "2.0.0",
        ProperName: "LibGL", ProperAuthor: "CuriousTorvald",
        ProperDescription: "TVDOS Graphics Library, next-generation",
        HopperProvides: "libgl;", HopperRequires: ""
    },

    // superchef: requires libgl 2.* -- triggers an upgrade of installed libgl
    {
        HopperPackageName: "superchef", HopperPackageVersion: "1.0.0",
        ProperName: "SuperChef", ProperAuthor: "Pavlo Kvasnik",
        ProperDescription: "Recipe-driven build automation",
        HopperProvides: "superchef;", HopperRequires: "tvdos 1.*;libgl 2.*"
    },

    // phantomedit: needs something that does not exist -> unresolvable
    {
        HopperPackageName: "phantomedit", HopperPackageVersion: "0.1.0",
        ProperName: "PhantomEdit", ProperAuthor: "anonymous",
        ProperDescription: "Editor for non-existent files",
        HopperProvides: "phantomedit;", HopperRequires: "libquantum 1.*"
    },

    // fake updated version of Microtone
    {
        HopperPackageName: "microtone", HopperPackageVersion: "1.3.0",
        ProperName: "Microtone", ProperAuthor: "CuriousTorvald",
        ProperDescription: "Fake updated version of Microtone",
        HopperProvides: "microtone;", HopperRequires: "tvdos 1.*;libgl 2.*"
    },
]

// Indirection point: in the future this should hit a real upstream.
function fetchRemoteCandidates() {
    return FAKE_REMOTE_PACKAGES
}

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
    println("Searching remote repository ...")
    const netHits = FAKE_REMOTE_PACKAGES.filter(m => matchesQuery(m, field, query))
    if (netHits.length === 0) println("  (no matches)")
    else netHits.forEach(m => printSearchResult(m, "remote"))

    return 0
}

// ============================================================
// Install (pure dummy)
// ============================================================

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

    println("")
    if (!confirm("Proceed with installation?", true)) {
        println("Aborted.")
        return 0
    }

    println("Fetching manifests from remote ...")
    println("Downloading package payloads ...")
    println("Verifying integrity ...")
    changing.forEach(a => {
        if (a.action === "install" || a.action === "reinstall") {
            println(`  ${a.action} ${a.name} ${a.version}`)
        } else {
            println(`  ${a.action} ${a.name} ${a.from} -> ${a.to}`)
        }
    })
    println("(dummy install: no files were actually created)")
    return 0
}

// ============================================================
// Remove (dry-run; resolves file list from manifest)
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

    const name = m.ProperName || m.HopperPackageName || query
    const ver  = m.HopperPackageVersion || "?"
    println(`Preparing removal of ${name} (${m.HopperPackageName} ${ver}) ...`)

    const paths = splitList(m.SystemPackagePath || "")
    println("")
    println("The following files would be deleted:")
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

    println("(dry-run: no files were actually deleted)")
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
