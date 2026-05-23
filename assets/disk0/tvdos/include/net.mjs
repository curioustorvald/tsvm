/*
 * net.mjs — Internet text-fetch helper for TVDOS
 *
 * Wraps the HttpModem peripheral (driven by `_TVDOS.DRV.FS.NET`, see
 * TVDOS.SYS:1001-1034) behind a small, regular-URL-friendly API. The
 * helper looks up whichever drive letter the boot probe assigned to the
 * HTTP modem and translates ordinary URLs (`https://host/path`) into the
 * scheme-without-double-slash form (`https:host/path`) that the modem
 * expects on the wire.
 *
 * Usage
 * -----
 *     let net = require("A:/tvdos/include/net.mjs")
 *
 *     if (!net.isAvailable())
 *         printerrln("No HTTP modem attached")
 *
 *     let body = net.fetchText("https://example.com/index.html")
 *     if (body === null) printerrln("Fetch failed")
 *     else println(body)
 */


let _cachedDrive = null

/** Scan TVDOS drive table for an HTTP-typed device. Returns the drive
 *  letter (e.g. "B") or null. */
function _findHttpDrive() {
    if (typeof _TVDOS === 'undefined' || !_TVDOS.DRIVEINFO) return null
    if (_cachedDrive !== null && _TVDOS.DRIVEINFO[_cachedDrive] &&
        _TVDOS.DRIVEINFO[_cachedDrive].type === 'HTTP')
        return _cachedDrive

    for (let letter in _TVDOS.DRIVEINFO) {
        let info = _TVDOS.DRIVEINFO[letter]
        if (info && info.type === 'HTTP') {
            _cachedDrive = letter
            return letter
        }
    }
    return null
}

/** Convert a regular URL into the form the HTTP modem accepts:
 *  - strip the `//` between scheme and authority
 *  - drop any URL fragment
 *  - assume `https` when no scheme is provided
 */
function _normaliseUrl(url) {
    if (typeof url !== 'string')
        throw new TypeError("url must be a string")
    let s = url.trim()
    if (s.length === 0) throw new Error("url is empty")

    // Drop fragment — the modem speaks to the server, # is client-side.
    let hash = s.indexOf('#')
    if (hash >= 0) s = s.substring(0, hash)

    // scheme://host/path  →  scheme:host/path
    let m = s.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/(.*)$/)
    if (m) return m[1].toLowerCase() + ':' + m[2]

    // Already in scheme:host/path form (the modem's native shape)
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:[^/]/.test(s)) return s

    // No scheme — default to https
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(s))
        return 'https:' + s.replace(/^\/\//, '')

    return s
}


let net = {}

/** Returns the drive letter currently bound to the HTTP modem, or null
 *  when no such device is attached. */
net.getHttpDrive = function () {
    return _findHttpDrive()
}

/** True iff an HTTP modem is reachable through TVDOS. */
net.isAvailable = function () {
    return _findHttpDrive() !== null
}

/** Translate a URL into the `<drive>:\<modem-url>` form that
 *  `files.open()` would route through `_TVDOS.DRV.FS.NET`. Useful when
 *  another component wants the descriptor directly. Throws if no HTTP
 *  modem is attached. */
net.toModemPath = function (url) {
    let drive = _findHttpDrive()
    if (drive === null) throw new Error("No HTTP modem device is attached")
    return drive + ':\\' + _normaliseUrl(url)
}

/** Open a TVDOS file descriptor backed by the HTTP modem for the given
 *  URL. The descriptor's sread()/bread() trigger the actual fetch.
 *  Throws if no HTTP modem is attached. */
net.open = function (url) {
    return files.open(net.toModemPath(url))
}

/** Fetch the body of `url` as a string. Returns the response text on
 *  success, or null when the modem reports a non-zero status (bad URL,
 *  I/O error, etc.). Throws if no HTTP modem is attached. */
net.fetchText = function (url) {
    let fd = net.open(url)
    let text = fd.sread()
    try { fd.close() } catch (_) {}
    return (text === undefined) ? null : text
}

/** Like fetchText, but throws an Error instead of returning null on
 *  fetch failure. */
net.fetchTextOrThrow = function (url) {
    let body = net.fetchText(url)
    if (body === null) throw new Error("Failed to fetch URL: " + url)
    return body
}


exports = net
