/*
 * synopsis.mjs -- TVDOS Synopsis Format (TSF) loader, cache and completion
 * resolver.
 *
 * A TSF document (see the "Command Synopsis Format" chapter of the manual and
 * tvdos_synopsis_format_draft.md) is a JSON file describing a command's
 * command-line interface: its options, positional arguments, subcommands,
 * argument types, completion sources and validation constraints.  This module
 * turns those documents into the answers command.js needs while the user is
 * typing -- chiefly "what can come next at the caret?".
 *
 * Where the documents live
 * ------------------------
 *   * Apps          : colocated with the executable, full filename + ".synopsis"
 *                     e.g. \tvdos\bin\geturl.js  ->  \tvdos\bin\geturl.js.synopsis
 *   * Built-in       : the shell coreutils are not files, so their synopses live
 *     coreutils       in a dedicated directory, \tvdos\synopsis\<name>.synopsis.
 *                     Aliases (ls -> dir, rm -> del, ...) resolve to the
 *                     canonical command's file automatically.
 *
 * Caching (two layers)
 * --------------------
 * Parsing JSON and compiling a completion model on every TAB would be wasteful,
 * so results are cached:
 *   1. In memory, for the life of the shell session (command.js keeps the
 *      require() handle, so this object persists across keystrokes).
 *   2. On disk, under \tvdos\cache\synopsis\, as a compiled-model blob.  The
 *      TSVM file layer exposes no reliable modification time, so the cache is
 *      validated against the source file's *byte size* plus a CACHE_VERSION
 *      stamp.  A source edit that preserves the byte count will not invalidate
 *      the disk cache -- an accepted trade-off.  Every disk operation is
 *      best-effort: a failure never breaks completion, it just falls back to
 *      re-parsing.
 *
 * Public API
 * ----------
 *   getCompletion(commandToken, prefixTokens, word) -> result | { ok:false }
 *   getModel(commandToken)            -> compiled model | null
 *   getSummary(commandToken)          -> one-line summary | null
 *   getUsage(commandToken)            -> generated usage string | null
 *   resolveSynopsisPath(commandToken) -> full path | null
 *   registerProvider(name, fn)        -> register an `internal` completion source
 *   clearCache()                      -> drop the in-memory caches
 */

const TSF_VERSION   = "1.0"
const CACHE_VERSION = 1                         // bump when compile()'s output shape changes
const SYN_DIR       = "\\tvdos\\synopsis"        // built-in / coreutil synopses
const CACHE_PARENT  = "\\tvdos\\cache"
const CACHE_DIR     = "\\tvdos\\cache\\synopsis" // compiled-model disk cache

///////////////////////////////////////////////////////////////////////////////
// small local helpers (deliberately mirror command.js internals)
///////////////////////////////////////////////////////////////////////////////

function drive() { return (typeof _G !== "undefined" && _G.shell) ? _G.shell.getCurrentDrive() : "A" }

function trimStartRevSlash(s) {
    let cnt = 0
    while (cnt < s.length && s[cnt] === '\\') cnt += 1
    return s.substring(cnt)
}

function isValidDriveLetter(l) {
    if (typeof l === 'string' || l instanceof String) {
        let lc = l.charCodeAt(0)
        return (l == '$' || 65 <= lc && lc <= 90 || 97 <= lc && lc <= 122)
    }
    return false
}

function fileExists(p) { try { return files.open(p).exists } catch (e) { return false } }
function fileSize(p)   { try { return files.open(p).size | 0 } catch (e) { return 0 } }
function readText(p)   { try { let f = files.open(p); return f.exists ? f.sread() : null } catch (e) { return null } }

let _cacheDirReady = false
function ensureCacheDir() {
    if (_cacheDirReady) return
    let d = drive()
    let segs = [CACHE_PARENT, CACHE_DIR]
    for (let i = 0; i < segs.length; i++) {
        try { let f = files.open(`${d}:${segs[i]}`); if (!f.exists) f.mkDir() } catch (e) { /* best-effort */ }
    }
    _cacheDirReady = true
}
function writeText(p, s) {
    try { ensureCacheDir(); files.open(p).swrite(s); return true } catch (e) { return false }
}

///////////////////////////////////////////////////////////////////////////////
// executable + synopsis-path resolution
///////////////////////////////////////////////////////////////////////////////

// Find the runnable file a bare command name would resolve to, mirroring the
// search order command.js uses (current directory, then PATH, with PATHEXT).
function findExecutable(cmd) {
    let d = drive()
    if (isValidDriveLetter(cmd[0]) && cmd[1] === ':') {
        try { let f = files.open(cmd); return f.exists ? f.fullPath : null } catch (e) { return null }
    }
    let pwd = (typeof _G !== "undefined" && _G.shell) ? _G.shell.getPwd() : [""]
    let searchDir = (cmd.charAt(0) === '/') ? [""] : ["/" + pwd.join("/")].concat(_TVDOS.getPath())
    let pathExt = []
    if (cmd.split(".")[1] === undefined) {
        (_TVDOS.variables.PATHEXT || "").split(';').forEach(function (it) {
            if (it.length) { pathExt.push(it); pathExt.push(it.toUpperCase()) }
        })
    } else {
        pathExt.push("")
    }
    for (let i = 0; i < searchDir.length; i++) {
        for (let j = 0; j < pathExt.length; j++) {
            let search = searchDir[i]; if (!search.endsWith('\\')) search += '\\'
            let sp = trimStartRevSlash(search + cmd + pathExt[j])
            try { let f = files.open(`${d}:\\${sp}`); if (f.exists) return f.fullPath } catch (e) { /* keep looking */ }
        }
    }
    return null
}

// Resolve a command token to the full path of its .synopsis document, or null.
function resolveSynopsisPath(token) {
    if (!token) return null
    let d = drive()
    let lower = token.toLowerCase()

    // built-in coreutil? -> \tvdos\synopsis\<name>.synopsis
    // try the typed name first, then any alias that shares the same function so
    // `ls` finds dir.synopsis without a duplicate file.
    if (typeof _G !== "undefined" && _G.shell && _G.shell.coreutils &&
        typeof _G.shell.coreutils[lower] === 'function') {
        let fn = _G.shell.coreutils[lower]
        let names = [lower]
        Object.keys(_G.shell.coreutils).forEach(function (k) {
            if (_G.shell.coreutils[k] === fn && names.indexOf(k) < 0) names.push(k)
        })
        for (let i = 0; i < names.length; i++) {
            let p = `${d}:${SYN_DIR}\\${names[i]}.synopsis`
            if (fileExists(p)) return p
        }
        return null
    }

    // app -> <executable>.synopsis colocated with the program
    let exe = findExecutable(token)
    if (!exe) return null
    let p = exe + ".synopsis"
    return fileExists(p) ? p : null
}

///////////////////////////////////////////////////////////////////////////////
// TSF compilation -- raw document -> completion model
///////////////////////////////////////////////////////////////////////////////

function compile(doc) {
    if (!doc || typeof doc !== 'object') return null
    let symbols = doc.symbols || {}

    // ---- options: every symbol of kind "option" is an offerable flag ----
    let flags = []      // one entry per option symbol
    let flagMap = {}    // flag string ("-r", "--recursive", "--no-recursive") -> entry
    Object.keys(symbols).forEach(function (id) {
        let s = symbols[id]
        if (!s || s.kind !== 'option') return
        let value = s.value || null
        let hasValue = !!value
        let entry = {
            id: id,
            long: s.long || null,
            short: s.short || null,
            summary: s.summary || '',
            negatable: !!s.negatable,
            hasValue: hasValue,
            valueRequired: hasValue ? (value.required !== false) : false,
            value: value
        }
        flags.push(entry)
        if (entry.long)  flagMap[entry.long]  = entry
        if (entry.short) flagMap[entry.short] = entry
        if (entry.negatable && entry.long) flagMap['--no-' + entry.long.replace(/^--/, '')] = entry
    })

    // ---- positionals + subcommands, in grammar order ----
    let positionals = []
    let subcommands = []
    let seenSub = {}
    function walk(node, inRepeat) {
        if (!node || typeof node !== 'object') return
        switch (node.type) {
            case 'sequence':
            case 'choice':
                (node.children || []).forEach(function (c) { walk(c, inRepeat) }); break
            case 'optional':  walk(node.child, inRepeat); break
            case 'repeat':    walk(node.child, true); break
            case 'oneOrMore': walk(node.child, true); break
            case 'reference': {
                let sym = symbols[node.symbol]
                if (!sym) return
                if (sym.kind === 'positional') {
                    positionals.push({
                        id: node.symbol,
                        name: sym.name || node.symbol,
                        type: sym.type || 'string',
                        values: sym.values || null,
                        completion: sym.completion || null,
                        summary: sym.summary || '',
                        repeatable: !!inRepeat
                    })
                } else if (sym.kind === 'subcommand') {
                    if (!seenSub[node.symbol]) {
                        seenSub[node.symbol] = true
                        subcommands.push({ name: sym.name || node.symbol, summary: sym.summary || '', tsf: sym.tsf || null })
                    }
                }
                break // option / group references add no positional ordering
            }
            default: break
        }
    }
    walk(doc.synopsis, false)

    return {
        cacheVersion: CACHE_VERSION,
        tsfVersion: doc.tsfVersion || null,
        name: doc.name || null,
        summary: doc.summary || '',
        description: doc.description || '',
        symbols: symbols,
        synopsisNode: doc.synopsis || null,
        flags: flags,
        flagMap: flagMap,
        positionals: positionals,
        subcommands: subcommands,
        constraints: doc.constraints || []
    }
}

///////////////////////////////////////////////////////////////////////////////
// loading + caching
///////////////////////////////////////////////////////////////////////////////

let _mem = {}          // synopsisPath -> { srcSize, model }
let _resolveMemo = {}  // "drive|pwd|token" -> synopsisPath | null

function cacheKey(p) {
    // FNV-1a 32-bit hash, prefixed with a sanitised basename for readability.
    let h = 2166136261
    for (let i = 0; i < p.length; i++) { h ^= p.charCodeAt(i); h = (h * 16777619) >>> 0 }
    let base = (p.split(/[\\/]/).pop() || 'syn').replace(/[^A-Za-z0-9._-]/g, '_')
    return base + '_' + ('00000000' + h.toString(16)).slice(-8)
}
function cachePath(synPath) { return `${drive()}:${CACHE_DIR}\\${cacheKey(synPath)}.json` }

function loadModel(synPath) {
    if (!synPath) return null
    let srcSize = fileSize(synPath)

    // 1. in-memory
    let mem = _mem[synPath]
    if (mem && mem.srcSize === srcSize) return mem.model

    // 2. disk cache (size + version validated)
    let cachedText = readText(cachePath(synPath))
    if (cachedText) {
        try {
            let c = JSON.parse(cachedText)
            if (c && c.cacheVersion === CACHE_VERSION && c.srcSize === srcSize && c.model) {
                _mem[synPath] = { srcSize: srcSize, model: c.model }
                return c.model
            }
        } catch (e) { /* corrupt cache -> re-parse */ }
    }

    // 3. parse the source
    let src = readText(synPath)
    if (src === null) return null
    let doc
    try { doc = JSON.parse(src) }
    catch (e) { try { serial.printerr("synopsis: bad JSON in " + synPath + ": " + e) } catch (_) {} ; return null }
    let model = compile(doc)
    if (!model) return null

    _mem[synPath] = { srcSize: srcSize, model: model }
    writeText(cachePath(synPath), JSON.stringify({ cacheVersion: CACHE_VERSION, srcSize: srcSize, model: model }))
    return model
}

function getModel(token) {
    if (!token) return null
    let key = drive() + '|' + ((typeof _G !== "undefined" && _G.shell) ? _G.shell.getPwdString() : '') + '|' + token
    let synPath
    if (Object.prototype.hasOwnProperty.call(_resolveMemo, key)) synPath = _resolveMemo[key]
    else { synPath = resolveSynopsisPath(token); _resolveMemo[key] = synPath }
    return synPath ? loadModel(synPath) : null
}

function clearCache() { _mem = {}; _resolveMemo = {}; _cacheDirReady = false }

///////////////////////////////////////////////////////////////////////////////
// internal completion providers (for `"completion": { "method": "internal" }`)
///////////////////////////////////////////////////////////////////////////////

let _providers = {}
function registerProvider(name, fn) { _providers[name] = fn }
function safeProvider(name, word, model) {
    let fn = _providers[name]
    if (!fn) return []
    try { return fn(word, model) || [] } catch (e) { return [] }
}

// "commands" -- runnable command names (coreutils + PATH executables).
registerProvider('commands', function (word) {
    word = (word || '').toLowerCase()
    let out = [], seen = {}
    function add(n) { let k = n.toLowerCase(); if (seen[k]) return; seen[k] = true; out.push(n) }
    if (typeof _G !== "undefined" && _G.shell && _G.shell.coreutils)
        Object.keys(_G.shell.coreutils).forEach(function (k) { if (k.toLowerCase().indexOf(word) === 0) add(k) })
    try {
        let d = drive()
        let exts = (_TVDOS.variables.PATHEXT || "").split(';')
            .filter(function (e) { return e.length }).map(function (e) { return e.toLowerCase() })
        _TVDOS.getPath().forEach(function (dir) {
            let full = (dir === '') ? `${d}:\\` : `${d}:${dir.charAt(0) === '\\' ? dir : '\\' + dir}`
            try {
                let f = files.open(full); if (!f.exists || !f.isDirectory) return
                ;(f.list() || []).forEach(function (it) {
                    if (it.isDirectory) return
                    let nl = (it.name || '').toLowerCase()
                    if (!exts.some(function (e) { return nl.endsWith(e) })) return
                    let nm = it.name
                    exts.forEach(function (e) { if (nm.toLowerCase().endsWith(e)) nm = nm.substring(0, nm.length - e.length) })
                    if (nm.toLowerCase().indexOf(word) === 0) add(nm)
                })
            } catch (e) { /* skip unreadable dir */ }
        })
    } catch (e) { /* ignore */ }
    return out
})

// "envvars" -- environment variable names.
registerProvider('envvars', function (word) {
    word = word || ''
    try {
        return Object.keys(_TVDOS.variables || {}).filter(function (k) {
            return k.toLowerCase().indexOf(word.toLowerCase()) === 0
        })
    } catch (e) { return [] }
})

///////////////////////////////////////////////////////////////////////////////
// completion query
///////////////////////////////////////////////////////////////////////////////

// Turn a `values` array (bare values or { value, summary } objects) into
// completion candidates whose value matches `word` as a prefix.
function valuesToCandidates(values, word) {
    if (!values) return []
    word = word || ''
    let out = []
    values.forEach(function (v) {
        let val, sum
        if (v && typeof v === 'object' && ('value' in v)) { val = '' + v.value; sum = v.summary || '' }
        else { val = '' + v; sum = '' }
        if (val.indexOf(word) === 0) out.push({ label: val, value: val + ' ', summary: sum, isDir: false })
    })
    return out
}

// Candidates implied by an argument descriptor (a positional, or an option's
// `value`).  Returns { candidates, filesystem } where `filesystem` is false or
// one of 'path' | 'file' | 'directory' -- a request that the caller ALSO offer
// matching filesystem entries.
function descriptorCandidates(desc, word, model) {
    word = word || ''
    let none = { candidates: [], filesystem: false }
    if (!desc) return none

    let method = (desc.completion && desc.completion.method) || (desc.type === 'enum' ? 'enum' : null)

    // explicit completion block
    if (method === 'none') return none
    if (method === 'enum') return { candidates: valuesToCandidates(desc.values, word), filesystem: false }
    if (method === 'list') {
        let items = (desc.completion && (desc.completion.items || desc.completion.values)) || desc.values || []
        return { candidates: valuesToCandidates(items, word), filesystem: false }
    }
    if (method === 'internal') {
        let prov = desc.completion && desc.completion.provider
        return { candidates: valuesToCandidates(safeProvider(prov, word, model), word), filesystem: false }
    }
    // method 'command' (run a program for candidates) is intentionally not
    // executed here -- side-effect / latency safety -- so it falls through to
    // the type defaults below.

    // no completion block (or unhandled method): default behaviour by type
    switch (desc.type) {
        case 'path':      return { candidates: [], filesystem: 'path' }
        case 'file':      return { candidates: [], filesystem: 'file' }
        case 'directory': return { candidates: [], filesystem: 'directory' }
        case 'boolean':   return { candidates: valuesToCandidates(['true', 'false'], word), filesystem: false }
        case 'command':   return { candidates: valuesToCandidates(safeProvider('commands', word, model), word), filesystem: false }
        case 'enum':      return { candidates: valuesToCandidates(desc.values, word), filesystem: false }
        case 'user':      if (_providers['users'])  return { candidates: valuesToCandidates(safeProvider('users', word, model), word), filesystem: false }; break
        case 'group':     if (_providers['groups']) return { candidates: valuesToCandidates(safeProvider('groups', word, model), word), filesystem: false }; break
        default: break
    }
    // string / integer / float / url / hostname / unknown: a soft `values`
    // list may still help; otherwise there is nothing to offer.
    if (desc.values) return { candidates: valuesToCandidates(desc.values, word), filesystem: false }
    return none
}

// Every textual form a flag may be typed as (long, short, and the --no- form).
function flagForms(entry) {
    let forms = []
    if (entry.long)  forms.push(entry.long)
    if (entry.short) forms.push(entry.short)
    if (entry.negatable && entry.long) forms.push('--no-' + entry.long.replace(/^--/, ''))
    return forms
}

// Count how many positional arguments `tokens` (the args already typed before
// the caret) have consumed, skipping option flags and the values they take.
function countPositionals(tokens, model) {
    let n = 0, skip = false
    for (let i = 0; i < tokens.length; i++) {
        let t = tokens[i]
        if (skip) { skip = false; continue }       // this token was an option's value
        if (t.length > 0 && t.charAt(0) === '-') {
            if (t.indexOf('=') >= 0) continue         // inline value -- no following value token
            let e = model.flagMap[t]
            if (e && e.hasValue && e.valueRequired) skip = true
            continue
        }
        n++
    }
    return n
}

function finalise(r) { return { ok: true, candidates: r.candidates, filesystem: r.filesystem } }

/*
 * Main entry point used by command.js.
 *
 *   commandToken : the command (first word on the line)
 *   prefixTokens : the argument tokens already typed, in order, EXCLUDING the
 *                  word currently under the caret
 *   word         : the partial word under the caret (may be "")
 *
 * Returns { ok:false } when there is no synopsis for the command (the caller
 * should fall back to its own default completion).  Otherwise returns
 *   { ok:true, candidates:[{label,value,summary,isDir}], filesystem:<flag> }
 * where `filesystem` (false | 'path' | 'file' | 'directory') asks the caller to
 * additionally offer matching filesystem entries.
 */
function getCompletion(commandToken, prefixTokens, word) {
    let model = getModel(commandToken)
    if (!model) return { ok: false }
    word = word || ''
    prefixTokens = prefixTokens || []

    // (1) the caret is on an option flag
    if (word.length > 0 && word.charAt(0) === '-') {
        // inline value form:  --flag=partial
        if (word.indexOf('--') === 0 && word.indexOf('=') >= 0) {
            let eq = word.indexOf('=')
            let flagPart = word.substring(0, eq)
            let valPart = word.substring(eq + 1)
            let entry = model.flagMap[flagPart]
            if (entry && entry.hasValue) {
                let r = descriptorCandidates(entry.value, valPart, model)
                r.candidates = r.candidates.map(function (c) {
                    return { label: c.label, value: flagPart + '=' + c.value.replace(/ $/, '') + ' ', summary: c.summary, isDir: false }
                })
                return { ok: true, candidates: r.candidates, filesystem: false }
            }
            return { ok: true, candidates: [], filesystem: false }
        }
        // list flags matching the prefix
        let out = []
        model.flags.forEach(function (e) {
            flagForms(e).forEach(function (f) {
                if (f.indexOf(word) === 0) out.push({ label: f, value: f + ' ', summary: e.summary, isDir: false })
            })
        })
        return { ok: true, candidates: out, filesystem: false }
    }

    // (2) the caret is on the value of the immediately preceding option
    let prev = prefixTokens.length > 0 ? prefixTokens[prefixTokens.length - 1] : null
    if (prev && prev.charAt(0) === '-' && prev.indexOf('=') < 0) {
        let entry = model.flagMap[prev]
        if (entry && entry.hasValue && entry.valueRequired)
            return finalise(descriptorCandidates(entry.value, word, model))
    }

    // (3) a positional argument (or a subcommand in the first slot)
    let posIndex = countPositionals(prefixTokens, model)
    if (posIndex === 0 && model.subcommands.length > 0) {
        let out = model.subcommands
            .filter(function (s) { return s.name.indexOf(word) === 0 })
            .map(function (s) { return { label: s.name, value: s.name + ' ', summary: s.summary, isDir: false } })
        return { ok: true, candidates: out, filesystem: false }
    }
    let desc = null
    if (model.positionals.length > 0) {
        if (posIndex < model.positionals.length) desc = model.positionals[posIndex]
        else {
            let last = model.positionals[model.positionals.length - 1]
            if (last && last.repeatable) desc = last
        }
    }
    // No descriptor for this slot -> let the caller use its default completion.
    if (!desc) return { ok: false }
    return finalise(descriptorCandidates(desc, word, model))
}

///////////////////////////////////////////////////////////////////////////////
// generated help (per the spec, usage text is derived output, not normative)
///////////////////////////////////////////////////////////////////////////////

function grammarToText(node, symbols) {
    if (!node || typeof node !== 'object') return ''
    switch (node.type) {
        case 'sequence':
            return (node.children || []).map(function (c) { return grammarToText(c, symbols) })
                .filter(function (s) { return s.length }).join(' ')
        case 'choice':
            return '(' + (node.children || []).map(function (c) { return grammarToText(c, symbols) }).join(' | ') + ')'
        case 'optional':
            return '[' + grammarToText(node.child, symbols) + ']'
        case 'repeat': {
            // a repeat over a group is the familiar [OPTION...] slot
            let child = node.child
            if (child && child.type === 'reference' && symbols[child.symbol] && symbols[child.symbol].kind === 'group')
                return '[' + grammarToText(child, symbols) + '...]'
            return grammarToText(child, symbols) + '...'
        }
        case 'oneOrMore': {
            let t = grammarToText(node.child, symbols)
            return t + ' [' + t + '...]'
        }
        case 'reference': {
            let s = symbols[node.symbol]
            if (!s) return node.symbol
            if (s.kind === 'group')      return 'OPTION'
            if (s.kind === 'option')     return s.long || s.short || node.symbol
            if (s.kind === 'subcommand') return s.name || node.symbol
            if (s.kind === 'positional') return s.name || node.symbol
            return node.symbol
        }
        default: return ''
    }
}

function getUsage(token) {
    let m = getModel(token)
    if (!m) return null
    let body = grammarToText(m.synopsisNode, m.symbols)
    return ((m.name || token) + (body ? ' ' + body : '')).trim()
}

function getSummary(token) {
    let m = getModel(token)
    return m ? (m.summary || '') : null
}

///////////////////////////////////////////////////////////////////////////////
// Module exports
///////////////////////////////////////////////////////////////////////////////

exports = {
    getCompletion,
    getModel,
    getSummary,
    getUsage,
    resolveSynopsisPath,
    registerProvider,
    clearCache,
    TSF_VERSION,
}
