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

// ============================================================
// Search
// ============================================================

// Dummy "remote" repository -- pretends to be a network query result.
const FAKE_REMOTE_PACKAGES = [
    {
        HopperPackageName: "doomster",
        HopperPackageVersion: "0.9.3",
        ProperName: "Doomster",
        ProperAuthor: "id Sortware",
        ProperDescription: "First-person shooter game for TSVM",
        HopperProvides: "doomster;",
        HopperRequires: "tvdos 1.*;libgl 1.*"
    },
    {
        HopperPackageName: "libfft",
        HopperPackageVersion: "0.1.0",
        ProperName: "LibFFT",
        ProperAuthor: "Soraya Vaughn",
        ProperDescription: "Fast Fourier Transform library for TSVM",
        HopperProvides: "libfft;",
        HopperRequires: "tvdos 1.*"
    },
    {
        HopperPackageName: "chatlite",
        HopperPackageVersion: "2.1.5",
        ProperName: "ChatLite",
        ProperAuthor: "TerraNetworks Co.",
        ProperDescription: "Lightweight IRC-style chat client",
        HopperProvides: "chatlite;",
        HopperRequires: "tvdos 1.*;wintex 1.*"
    },
    {
        HopperPackageName: "snakey",
        HopperPackageVersion: "1.4.0",
        ProperName: "Snakey",
        ProperAuthor: "Iben Holst",
        ProperDescription: "Classic snake game with TerranBASIC scripting",
        HopperProvides: "snakey;",
        HopperRequires: "tvdos 1.*;libterranbasic 1.*"
    }
]

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

    const verSuffix = version ? ` (v${version})` : ""
    println(`Resolving ${query}${verSuffix} ...`)
    println(`Fetching manifest from remote ...`)
    println(`Resolving dependencies ...`)
    println(`Downloading package payload ...`)
    println(`Verifying integrity ...`)
    println(`Writing manifest to ${SYSTEM_PACKEAGE_DEF_DIR}/${query}${MANIFEST_EXT} ...`)
    println(`Installed ${query}${verSuffix}.`)
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
