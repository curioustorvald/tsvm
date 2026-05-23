/*
 * lfs.mjs — programmatic extractor for TVDOS Linear File Strip archives.
 *
 *   let lfs = require("A:/tvdos/include/lfs.mjs")
 *
 *   // Pull one entry out:
 *   let fd  = lfs.extractOne("A:/path/archive.lfs", "wanted.bin")
 *   // → file descriptor for $:/TMP/<random>/wanted.bin
 *
 *   // Unpack the whole archive:
 *   let dir = lfs.extractAll("A:/path/archive.lfs")
 *   // → directory descriptor for $:/TMP/<random>/
 *
 * Both functions accept an `autoDecompress` boolean (default true). When
 * a payload's first four bytes match the gzip (1F 8B 08 xx) or zstd
 * (28 B5 2F FD) magic, the payload is inflated through gzip.decomp()
 * before being written. The check is done on the payload bytes — the
 * archived filename is irrelevant.
 *
 * Both functions require a relative-path archive (one produced by
 * `lfs -c -r`); fully qualified archives carry drive letters that would
 * not make sense rerooted under $:/TMP.
 */

const TMP_ROOT     = "$:/TMP"
const HASH_ALPHABET = "YBNDRFG8EJKMCPQXOTLVWIS2A345H769"
const HASH_LEN     = 32
const LFS_HEADER   = "TVDOSLFS\x01"
const LFS_HEADER_LEN = 16
const LFS_FLAG_RELATIVE = 0x01


function _makeHash(n) {
    let s = ""
    const m = HASH_ALPHABET.length
    for (let i = 0; i < n; i++) s += HASH_ALPHABET[Math.floor(Math.random() * m)]
    return s
}

function _isCompressed(s) {
    if (s.length < 4) return false
    const b0 = s.charCodeAt(0), b1 = s.charCodeAt(1)
    const b2 = s.charCodeAt(2), b3 = s.charCodeAt(3)
    if (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) return true            // gzip
    if (b0 === 0x28 && b1 === 0xb5 && b2 === 0x2f && b3 === 0xfd) return true  // zstd
    return false
}

function _decompress(payload) {
    // gzip.decomp transparently handles both gzip and zstd; returns Java byte[].
    return btostr(gzip.decomp(payload))
}

function _readArchive(lfsPath) {
    const fd = files.open(lfsPath)
    if (!fd.exists)     throw new Error("LFS archive not found: " + lfsPath)
    if (fd.isDirectory) throw new Error("LFS archive is a directory: " + lfsPath)

    const bytes = fd.sread()
    try { fd.close() } catch (_) {}

    if (bytes.substring(0, LFS_HEADER.length) !== LFS_HEADER)
        throw new Error("Not an LFS archive: " + lfsPath)

    const flags = bytes.charCodeAt(11)
    if ((flags & LFS_FLAG_RELATIVE) === 0)
        throw new Error("LFS archive does not use relative paths: " + lfsPath)

    return bytes
}

function _allocTmpDir() {
    const path = TMP_ROOT + "/" + _makeHash(HASH_LEN)
    const dir  = files.open(path)
    dir.mkDir()
    return { fd: dir, path: path }
}

function _normPath(p) {
    return p.replace(/\//g, "\\")
}

function _writeFile(destDirPath, archivePath, payload) {
    const parts = _normPath(archivePath).split("\\").filter(p => p.length > 0)
    if (parts.length === 0) return null

    const leaf = parts.pop()
    let curPath = destDirPath
    for (let i = 0; i < parts.length; i++) {
        curPath = curPath + "/" + parts[i]
        const cur = files.open(curPath)
        if (!cur.exists) cur.mkDir()
    }
    const outfile = files.open(curPath + "/" + leaf)
    if (!outfile.exists) outfile.mkFile()
    outfile.swrite(payload)
    return outfile
}


function extractOne(lfsPath, filename, autoDecompress) {
    if (autoDecompress === undefined) autoDecompress = true
    if (filename === undefined || filename === null || filename === "")
        throw new Error("filename is required")

    const bytes  = _readArchive(lfsPath)
    const needle = _normPath(filename)

    let curs = LFS_HEADER_LEN
    while (curs < bytes.length) {
        const fileType = bytes.charCodeAt(curs)
        const pathlen  = (bytes.charCodeAt(curs+1) << 8) | bytes.charCodeAt(curs+2)
        curs += 3
        const path = bytes.substring(curs, curs + pathlen)
        curs += pathlen
        const filelen = (bytes.charCodeAt(curs) << 24)
                      | (bytes.charCodeAt(curs+1) << 16)
                      | (bytes.charCodeAt(curs+2) << 8)
                      |  bytes.charCodeAt(curs+3)
        curs += 4

        if (_normPath(path) === needle) {
            let payload = bytes.substring(curs, curs + filelen)
            if (autoDecompress && _isCompressed(payload)) payload = _decompress(payload)

            const dest  = _allocTmpDir()
            const leaf  = needle.split("\\").pop()
            const outfile = files.open(dest.path + "/" + leaf)
            if (!outfile.exists) outfile.mkFile()
            outfile.swrite(payload)
            return outfile
        }

        curs += filelen
    }

    throw new Error("File not found in archive: " + filename)
}


function extractAll(lfsPath, autoDecompress) {
    if (autoDecompress === undefined) autoDecompress = true

    const bytes = _readArchive(lfsPath)
    const dest  = _allocTmpDir()

    let curs = LFS_HEADER_LEN
    while (curs < bytes.length) {
        const fileType = bytes.charCodeAt(curs)
        const pathlen  = (bytes.charCodeAt(curs+1) << 8) | bytes.charCodeAt(curs+2)
        curs += 3
        const path = bytes.substring(curs, curs + pathlen)
        curs += pathlen
        const filelen = (bytes.charCodeAt(curs) << 24)
                      | (bytes.charCodeAt(curs+1) << 16)
                      | (bytes.charCodeAt(curs+2) << 8)
                      |  bytes.charCodeAt(curs+3)
        curs += 4

        let payload = bytes.substring(curs, curs + filelen)
        if (autoDecompress && _isCompressed(payload)) payload = _decompress(payload)
        _writeFile(dest.path, path, payload)

        curs += filelen
    }

    return dest.fd
}


exports = { extractOne, extractAll }
