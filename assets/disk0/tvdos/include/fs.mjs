/*
 * fs.mjs — NodeJS-compatible Filesystem module for TVDOS
 *
 * Wraps the TVDOS Kernel filesystem interface (`files.open()` and the
 * TVDOSFileDescriptor methods exposed by TVDOS.SYS) with the NodeJS
 * `fs` API surface. Both synchronous (`*Sync`) and callback-style
 * asynchronous variants are provided, plus a `promises` namespace.
 *
 * The TSVM has no real concurrency, so all the "async" calls execute
 * synchronously and then invoke the callback (or resolve the promise)
 * immediately.
 *
 * Path handling
 * -------------
 * Paths must be one of:
 *   * Drive-prefixed absolute path:  "A:/foo/bar"  or  "A:\\foo\\bar"
 *   * Special device path:           "$:/CON", "$:/NUL", "$:/TMP/...", ...
 *   * Reserved single name:          "CON", "NUL", "RND", ...
 *   * Relative / drive-less:         resolved through the active shell
 *                                    (`_G.shell.resolvePathInput`) when
 *                                    available; otherwise prefixed with
 *                                    "A:" (the boot drive).
 *
 * Buffers
 * -------
 * TVDOS does not ship NodeJS Buffer. The functions return / accept
 * `Uint8Array` instances when binary data is expected, and JavaScript
 * strings when an encoding ("utf8" / "utf-8" / "binary" / "ascii") is
 * supplied. `Uint8Array` instances also gain a `.toString(encoding)`
 * shim when produced inside this module.
 *
 * Usage
 * -----
 *   let fs = require("A:/tvdos/include/fs.mjs")
 *   let txt = fs.readFileSync("A:/etc/motd", "utf8")
 *   fs.writeFileSync("A:/tmp/hello.txt", "hi", "utf8")
 *   fs.readdirSync("A:/").forEach(println)
 */


///////////////////////////////////////////////////////////////////////////////
// Constants (NodeJS fs.constants subset)
///////////////////////////////////////////////////////////////////////////////

const F_OK = 0
const X_OK = 1
const W_OK = 2
const R_OK = 4

const O_RDONLY  = 0
const O_WRONLY  = 1
const O_RDWR    = 2
const O_CREAT   = 0o100
const O_EXCL    = 0o200
const O_TRUNC   = 0o1000
const O_APPEND  = 0o2000

const S_IFMT    = 0o170000
const S_IFREG   = 0o100000
const S_IFDIR   = 0o040000
const S_IFCHR   = 0o020000
const S_IFBLK   = 0o060000
const S_IFIFO   = 0o010000
const S_IFLNK   = 0o120000
const S_IFSOCK  = 0o140000

const constants = {
    F_OK, X_OK, W_OK, R_OK,
    O_RDONLY, O_WRONLY, O_RDWR,
    O_CREAT, O_EXCL, O_TRUNC, O_APPEND,
    S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFBLK, S_IFIFO, S_IFLNK, S_IFSOCK,
}


///////////////////////////////////////////////////////////////////////////////
// Internal helpers
///////////////////////////////////////////////////////////////////////////////

function _makeError(code, syscall, path, msg) {
    let m = msg || (code + (path ? ", " + syscall + " '" + path + "'" : ""))
    let e = new Error(m)
    e.code = code
    e.errno = -1
    e.syscall = syscall
    if (path !== undefined) e.path = path
    return e
}

function _enoent(syscall, path)  { return _makeError("ENOENT", syscall, path, "ENOENT: no such file or directory, " + syscall + " '" + path + "'") }
function _eexist(syscall, path)  { return _makeError("EEXIST", syscall, path, "EEXIST: file already exists, " + syscall + " '" + path + "'") }
function _eisdir(syscall, path)  { return _makeError("EISDIR", syscall, path, "EISDIR: illegal operation on a directory, " + syscall + " '" + path + "'") }
function _enotdir(syscall, path) { return _makeError("ENOTDIR", syscall, path, "ENOTDIR: not a directory, " + syscall + " '" + path + "'") }
function _ebadf(syscall)         { return _makeError("EBADF", syscall, undefined, "EBADF: bad file descriptor, " + syscall) }

function _isReservedName(name) {
    return (typeof files !== 'undefined') && files.reservedNames.includes(String(name).toUpperCase())
}

function _currentDriveLetter() {
    if (typeof _G !== 'undefined' && _G.shell) {
        if (typeof _G.shell.getCurrentDrive === 'function')
            return _G.shell.getCurrentDrive()
        if (_G.shell.CURRENT_DRIVE !== undefined)
            return _G.shell.CURRENT_DRIVE
    }
    return "A"
}

/** Normalise a path for files.open(). */
function _normalisePath(path) {
    if (path === undefined || path === null)
        throw new TypeError("path is required")
    if (typeof path !== 'string')
        throw new TypeError("path must be a string")
    if (path.length === 0)
        throw new Error("path is empty")

    // Reserved single name (CON, NUL, RND, ...)
    if (_isReservedName(path)) return path.toUpperCase()

    // Special device path: $:/something or $DEVxxx/...
    if (path[0] === '$') return path

    // Drive-prefixed absolute path
    if (path.length >= 2 && path[1] === ':') return path

    // Try the active shell first
    if (typeof _G !== 'undefined' && _G.shell &&
        typeof _G.shell.resolvePathInput === 'function') {
        try {
            let r = _G.shell.resolvePathInput(path)
            if (r && r.full) return r.full
        } catch (_) { /* fall through */ }
    }

    // Fallback: assume an absolute path on the current drive
    let d = _currentDriveLetter()
    if (path[0] === '/' || path[0] === '\\') return d + ":" + path
    return d + ":/" + path
}

/** Open and return a TVDOSFileDescriptor; throws on bad arguments. */
function _fd(path) {
    return files.open(_normalisePath(path))
}

function _bytesToString(bytes) {
    let s = ''
    let len = bytes.length
    for (let i = 0; i < len; i++) {
        let b = bytes[i]
        s += String.fromCharCode((b < 0) ? (256 + b) : (b & 0xff))
    }
    return s
}

function _stringToU8(str) {
    let buf = new Uint8Array(str.length)
    for (let i = 0; i < str.length; i++) {
        buf[i] = str.charCodeAt(i) & 0xff
    }
    return _attachToString(buf)
}

function _arrayToU8(arr) {
    let buf = new Uint8Array(arr.length)
    for (let i = 0; i < arr.length; i++) {
        let b = arr[i]
        buf[i] = (b < 0) ? (256 + b) & 0xff : b & 0xff
    }
    return _attachToString(buf)
}

/** Add a NodeJS-Buffer-like .toString(encoding) shim onto a Uint8Array. */
function _attachToString(u8) {
    if (u8.__tvdosFsToString) return u8
    Object.defineProperty(u8, 'toString', {
        value: function (encoding, start, end) {
            let s = (start === undefined) ? 0 : (start | 0)
            let e = (end === undefined) ? this.length : (end | 0)
            if (s < 0) s = 0
            if (e > this.length) e = this.length
            if (e < s) e = s
            let enc = (encoding || 'utf8').toLowerCase()
            if (enc === 'hex') {
                let out = ''
                for (let i = s; i < e; i++) out += (this[i] < 16 ? '0' : '') + this[i].toString(16)
                return out
            }
            if (enc === 'base64') {
                let raw = ''
                for (let i = s; i < e; i++) raw += String.fromCharCode(this[i])
                if (typeof base64 !== 'undefined' && base64.encode) return base64.encode(raw)
                return raw
            }
            // utf8/utf-8/binary/latin1/ascii — TSVM strings are all 8-bit clean
            let s2 = ''
            for (let i = s; i < e; i++) s2 += String.fromCharCode(this[i])
            return s2
        },
        enumerable: false, configurable: true, writable: true,
    })
    Object.defineProperty(u8, '__tvdosFsToString', {
        value: true, enumerable: false,
    })
    return u8
}

/** Resolve `data` argument to a Uint8Array regardless of the input shape. */
function _toBytes(data, encoding) {
    if (data === undefined || data === null)
        throw new TypeError("data is required")
    if (data instanceof Uint8Array) return data
    if (data instanceof Int8Array)  return _arrayToU8(data)
    if (Array.isArray(data))        return _arrayToU8(data)
    if (typeof data === 'string')   return _stringToU8(data)
    // Buffer-like with .length and indexed access
    if (typeof data.length === 'number') return _arrayToU8(data)
    throw new TypeError("Unsupported data type")
}

/** Parse NodeJS open()-style flags string into capability flags. */
function _parseFlags(flags) {
    if (flags === undefined || flags === null) flags = 'r'
    if (typeof flags === 'number') {
        return {
            read:      ((flags & 3) === O_RDONLY) || ((flags & 3) === O_RDWR),
            write:     ((flags & 3) === O_WRONLY) || ((flags & 3) === O_RDWR),
            create:    (flags & O_CREAT) !== 0,
            exclusive: (flags & O_EXCL) !== 0,
            truncate:  (flags & O_TRUNC) !== 0,
            append:    (flags & O_APPEND) !== 0,
            raw:       flags,
        }
    }
    let f = String(flags)
    let r = { read: false, write: false, create: false, exclusive: false, truncate: false, append: false, raw: f }
    switch (f) {
        case 'r':   r.read = true; break
        case 'r+':  r.read = true; r.write = true; break
        case 'rs':  // deprecated alias
        case 'sr':  r.read = true; break
        case 'rs+':
        case 'sr+': r.read = true; r.write = true; break
        case 'w':   r.write = true; r.create = true; r.truncate = true; break
        case 'wx':
        case 'xw':  r.write = true; r.create = true; r.truncate = true; r.exclusive = true; break
        case 'w+':  r.read = true; r.write = true; r.create = true; r.truncate = true; break
        case 'wx+':
        case 'xw+': r.read = true; r.write = true; r.create = true; r.truncate = true; r.exclusive = true; break
        case 'a':   r.write = true; r.create = true; r.append = true; break
        case 'ax':
        case 'xa':  r.write = true; r.create = true; r.append = true; r.exclusive = true; break
        case 'a+':  r.read = true; r.write = true; r.create = true; r.append = true; break
        case 'ax+':
        case 'xa+': r.read = true; r.write = true; r.create = true; r.append = true; r.exclusive = true; break
        default: throw new TypeError("Unknown file open flag: " + flags)
    }
    return r
}


///////////////////////////////////////////////////////////////////////////////
// Stats / Dirent
///////////////////////////////////////////////////////////////////////////////

function _now() {
    let ms = (typeof sys !== 'undefined' && sys.currentTimeInMills) ? sys.currentTimeInMills() : 0
    return new Date(ms)
}

class Stats {
    constructor(fd) {
        let isDir = false
        let size = 0
        try {
            isDir = fd.isDirectory
        } catch (_) { /* device files may misbehave */ }
        if (!isDir) {
            try { size = fd.size } catch (_) { size = 0 }
        }

        this.dev      = 0
        this.ino      = 0
        this.mode     = isDir ? (S_IFDIR | 0o755) : (S_IFREG | 0o644)
        this.nlink    = 1
        this.uid      = 0
        this.gid      = 0
        this.rdev     = 0
        this.size     = size
        this.blksize  = 4096
        this.blocks   = (size + 511) >> 9

        let t = _now()
        this.atime    = t
        this.mtime    = t
        this.ctime    = t
        this.birthtime = t
        let tms = t.getTime()
        this.atimeMs    = tms
        this.mtimeMs    = tms
        this.ctimeMs    = tms
        this.birthtimeMs = tms

        this._isDir = isDir
    }
    isFile()           { return !this._isDir }
    isDirectory()      { return this._isDir }
    isBlockDevice()    { return false }
    isCharacterDevice(){ return false }
    isSymbolicLink()   { return false }
    isFIFO()           { return false }
    isSocket()         { return false }
}

class Dirent {
    constructor(name, parentPath, isDir) {
        this.name       = name
        this.parentPath = parentPath
        this.path       = parentPath
        this._isDir     = !!isDir
    }
    isFile()           { return !this._isDir }
    isDirectory()      { return this._isDir }
    isBlockDevice()    { return false }
    isCharacterDevice(){ return false }
    isSymbolicLink()   { return false }
    isFIFO()           { return false }
    isSocket()         { return false }
}


///////////////////////////////////////////////////////////////////////////////
// File descriptor table  (TVDOS does not expose integer fds, so we synthesise)
///////////////////////////////////////////////////////////////////////////////

let _fdCounter = 3   // reserve 0/1/2 for stdio
const _fdTable  = {}

function _allocFd(entry) {
    let id = _fdCounter++
    _fdTable[id] = entry
    return id
}

function _getFd(fd, syscall) {
    if (typeof fd !== 'number' || _fdTable[fd] === undefined)
        throw _ebadf(syscall || 'read')
    return _fdTable[fd]
}


///////////////////////////////////////////////////////////////////////////////
// Synchronous API
///////////////////////////////////////////////////////////////////////////////

function existsSync(path) {
    try {
        return _fd(path).exists
    } catch (_) {
        return false
    }
}

function accessSync(path, mode) {
    let fd = _fd(path)
    if (!fd.exists) throw _enoent('access', path)
    // TVDOS has no permission bits — every existing file is read/write/exec.
    return undefined
}

function statSync(path, options) {
    let fd = _fd(path)
    let throwIfNoEntry = !options || options.throwIfNoEntry !== false
    if (!fd.exists) {
        if (throwIfNoEntry) throw _enoent('stat', path)
        return undefined
    }
    return new Stats(fd)
}

function lstatSync(path, options) {
    // TVDOS has no symlinks, so lstat == stat.
    return statSync(path, options)
}

function fstatSync(fd, options) {
    let entry = _getFd(fd, 'fstat')
    return new Stats(entry.descriptor)
}

function readFileSync(path, options) {
    let encoding = null
    if (typeof options === 'string') encoding = options
    else if (options && options.encoding) encoding = options.encoding

    // fd path
    if (typeof path === 'number') {
        let entry = _getFd(path, 'read')
        let bytes = entry.buffer
        if (encoding) return _attachToString(bytes).toString(encoding)
        return _attachToString(new Uint8Array(bytes))
    }

    let fd = _fd(path)
    if (!fd.exists) throw _enoent('open', path)
    if (fd.isDirectory) throw _eisdir('read', path)

    if (encoding) {
        // sread() is a single Kernel round-trip and returns a JS string.
        let s = fd.sread()
        try { fd.close() } catch (_) {}
        // The string is already 8-bit-clean; for utf8/utf-8/binary/ascii we
        // return it as-is. Hex/base64 require the byte view.
        let enc = encoding.toLowerCase()
        if (enc === 'utf8' || enc === 'utf-8' || enc === 'binary' || enc === 'latin1' || enc === 'ascii')
            return s
        return _attachToString(_stringToU8(s)).toString(encoding)
    }

    let bytes = fd.bread()
    try { fd.close() } catch (_) {}
    return _arrayToU8(bytes)
}

function writeFileSync(path, data, options) {
    let encoding = 'utf8'
    let flag = 'w'
    if (typeof options === 'string') {
        encoding = options
    } else if (options) {
        if (options.encoding) encoding = options.encoding
        if (options.flag)     flag = options.flag
    }

    // fd path
    if (typeof path === 'number') {
        let entry = _getFd(path, 'write')
        if (typeof data === 'string') {
            entry.descriptor.swrite(data)
        } else {
            let u8 = _toBytes(data, encoding)
            entry.descriptor.bwrite(Array.from(u8))
        }
        try { entry.descriptor.flush() } catch (_) {}
        return undefined
    }

    let fd = _fd(path)
    let parsed = _parseFlags(flag)

    if (parsed.exclusive && fd.exists)
        throw _eexist('open', path)
    if (!fd.exists) fd.mkFile()

    if (parsed.append && fd.exists && !parsed.truncate) {
        if (typeof data === 'string') {
            fd.sappend(data)
        } else {
            let u8 = _toBytes(data, encoding)
            fd.bappend(Array.from(u8))
        }
    } else {
        if (typeof data === 'string') {
            fd.swrite(data)
        } else {
            let u8 = _toBytes(data, encoding)
            fd.bwrite(Array.from(u8))
        }
    }

    try { fd.flush() } catch (_) {}
    try { fd.close() } catch (_) {}
    return undefined
}

function appendFileSync(path, data, options) {
    let encoding = 'utf8'
    if (typeof options === 'string') encoding = options
    else if (options && options.encoding) encoding = options.encoding

    if (typeof path === 'number') {
        let entry = _getFd(path, 'write')
        if (typeof data === 'string') entry.descriptor.sappend(data)
        else                          entry.descriptor.bappend(Array.from(_toBytes(data, encoding)))
        try { entry.descriptor.flush() } catch (_) {}
        return undefined
    }

    let fd = _fd(path)
    if (!fd.exists) fd.mkFile()

    if (typeof data === 'string') fd.sappend(data)
    else                          fd.bappend(Array.from(_toBytes(data, encoding)))

    try { fd.flush() } catch (_) {}
    try { fd.close() } catch (_) {}
    return undefined
}

function unlinkSync(path) {
    let fd = _fd(path)
    if (!fd.exists) throw _enoent('unlink', path)
    if (fd.isDirectory) throw _eisdir('unlink', path)
    let r = fd.remove()
    if (r !== 0 && r !== true && r !== undefined)
        throw _makeError('EIO', 'unlink', path, "removing failed with status " + r)
    return undefined
}

function rmdirSync(path, options) {
    let recursive = !!(options && options.recursive)
    let fd = _fd(path)
    if (!fd.exists) throw _enoent('rmdir', path)
    if (!fd.isDirectory) throw _enotdir('rmdir', path)

    if (recursive) {
        _rmRecursive(fd)
    } else {
        let r = fd.remove()
        if (r !== 0 && r !== true && r !== undefined)
            throw _makeError('ENOTEMPTY', 'rmdir', path, "directory not empty or removal failed (" + r + ")")
    }
    return undefined
}

function rmSync(path, options) {
    let recursive = !!(options && options.recursive)
    let force     = !!(options && options.force)
    let fd
    try { fd = _fd(path) }
    catch (e) {
        if (force) return undefined
        throw e
    }
    if (!fd.exists) {
        if (force) return undefined
        throw _enoent('stat', path)
    }
    if (fd.isDirectory) {
        if (!recursive)
            throw _makeError('EISDIR', 'unlink', path, "EISDIR: is a directory, use { recursive: true } to remove")
        _rmRecursive(fd)
    } else {
        fd.remove()
    }
    return undefined
}

function _rmRecursive(fd) {
    if (fd.isDirectory) {
        let kids = fd.list() || []
        for (let i = 0; i < kids.length; i++) {
            let n = kids[i].name
            if (n === '.' || n === '..' || n === '') continue
            _rmRecursive(kids[i])
        }
    }
    fd.remove()
}

function mkdirSync(path, options) {
    let recursive = false
    if (typeof options === 'object' && options) {
        if (options.recursive !== undefined) recursive = !!options.recursive
    }

    let np  = _normalisePath(path)
    let fd  = files.open(np)
    if (fd.exists) {
        if (recursive) return undefined
        throw _eexist('mkdir', path)
    }

    if (recursive) {
        // Walk parents and create missing ones first. fd.parentPath does not
        // include the drive letter, so reattach it.
        let parent = files.open(fd.driveLetter + ":" + fd.parentPath)
        if (!parent.exists && parent.path && parent.path !== "\\" && parent.path !== "")
            mkdirSync(parent.fullPath, { recursive: true })
        let ok = fd.mkDir()
        if (!ok) throw _makeError('EIO', 'mkdir', path, "mkdir failed")
        return fd.fullPath
    }

    let ok = fd.mkDir()
    if (!ok) throw _makeError('EIO', 'mkdir', path, "mkdir failed")
    return undefined
}

function readdirSync(path, options) {
    let withFileTypes = !!(options && options.withFileTypes)
    let fd = _fd(path)
    if (!fd.exists) throw _enoent('scandir', path)
    if (!fd.isDirectory) throw _enotdir('scandir', path)

    let kids = fd.list() || []
    let parentFull = fd.fullPath
    let result = []
    for (let i = 0; i < kids.length; i++) {
        let name = kids[i].name
        if (name === '.' || name === '..' || name === '') continue
        if (withFileTypes) {
            result.push(new Dirent(name, parentFull, kids[i].isDirectory))
        } else {
            result.push(name)
        }
    }
    return result
}

function renameSync(oldPath, newPath) {
    let src = _fd(oldPath)
    if (!src.exists) throw _enoent('rename', oldPath)
    if (src.isDirectory)
        throw _makeError('EPERM', 'rename', oldPath, "EPERM: rename of directories is not supported")

    let dst = _fd(newPath)
    if (dst.exists && dst.isDirectory)
        throw _eisdir('rename', newPath)

    let bytes = src.bread()
    if (!dst.exists) dst.mkFile()
    dst.bwrite(bytes)
    try { dst.flush() } catch (_) {}
    try { dst.close() } catch (_) {}
    src.remove()
    return undefined
}

function copyFileSync(src, dest, mode) {
    let s = _fd(src)
    if (!s.exists) throw _enoent('copyfile', src)
    if (s.isDirectory) throw _eisdir('copyfile', src)

    let d = _fd(dest)
    // mode: COPYFILE_EXCL = 1
    if ((mode | 0) & 1) {
        if (d.exists) throw _eexist('copyfile', dest)
    }
    if (d.isDirectory) throw _eisdir('copyfile', dest)

    if (!d.exists) d.mkFile()
    d.bwrite(s.bread())
    try { d.flush() } catch (_) {}
    try { d.close() } catch (_) {}
    try { s.close() } catch (_) {}
    return undefined
}

function cpSync(src, dest, options) {
    let recursive = !!(options && options.recursive)
    let force     = (options && options.force === false) ? false : true
    let s = _fd(src)
    if (!s.exists) throw _enoent('cp', src)

    if (s.isDirectory) {
        if (!recursive)
            throw _makeError('EISDIR', 'cp', src, "EISDIR: source is a directory, use { recursive: true }")
        _cpDir(s, _fd(dest), force)
    } else {
        copyFileSync(src, dest, force ? 0 : 1)
    }
    return undefined
}

function _cpDir(srcFd, destFd, force) {
    if (!destFd.exists) destFd.mkDir()
    let kids = srcFd.list() || []
    for (let i = 0; i < kids.length; i++) {
        let n = kids[i].name
        if (n === '.' || n === '..' || n === '') continue
        let child = kids[i]
        let childDest = files.open(destFd.fullPath + "/" + n)
        if (child.isDirectory) {
            _cpDir(child, childDest, force)
        } else {
            if (childDest.exists && !force) continue
            if (!childDest.exists) childDest.mkFile()
            childDest.bwrite(child.bread())
            try { childDest.flush() } catch (_) {}
            try { childDest.close() } catch (_) {}
        }
    }
}

function realpathSync(path, options) {
    let fd = _fd(path)
    if (!fd.exists) throw _enoent('realpath', path)
    return fd.fullPath
}

function truncateSync(path, len) {
    if (len === undefined) len = 0
    if (len < 0) len = 0
    let fd = _fd(path)
    if (!fd.exists) throw _enoent('open', path)
    if (fd.isDirectory) throw _eisdir('truncate', path)
    let bytes = fd.bread()
    let cur = bytes.length
    let out
    if (len <= cur) {
        out = bytes.slice(0, len)
    } else {
        out = new Array(len)
        for (let i = 0; i < cur; i++) out[i] = bytes[i]
        for (let i = cur; i < len; i++) out[i] = 0
    }
    fd.bwrite(out)
    try { fd.flush() } catch (_) {}
    try { fd.close() } catch (_) {}
    return undefined
}

function ftruncateSync(fd, len) {
    let entry = _getFd(fd, 'ftruncate')
    return truncateSync(entry.descriptor.fullPath, len)
}

function utimesSync(path, atime, mtime) {
    // TVDOS does not record timestamps; treat as a touch().
    let fd = _fd(path)
    if (!fd.exists) throw _enoent('utime', path)
    fd.touch()
    return undefined
}
function futimesSync(fd, atime, mtime) {
    let entry = _getFd(fd, 'futimes')
    entry.descriptor.touch()
    return undefined
}
function lutimesSync(path, atime, mtime) { return utimesSync(path, atime, mtime) }

function chmodSync(path, mode)            { /* no perm bits in TVDOS */ return undefined }
function lchmodSync(path, mode)           { return undefined }
function fchmodSync(fd, mode)             { _getFd(fd, 'fchmod'); return undefined }
function chownSync(path, uid, gid)        { return undefined }
function lchownSync(path, uid, gid)       { return undefined }
function fchownSync(fd, uid, gid)         { _getFd(fd, 'fchown'); return undefined }

function readlinkSync(path, options) {
    // No symlinks in TVDOS — every existing node is its own target.
    let fd = _fd(path)
    if (!fd.exists) throw _enoent('readlink', path)
    return fd.fullPath
}
function symlinkSync(target, path, type)        { throw _makeError('ENOSYS', 'symlink', path, "ENOSYS: symlinks not supported on TVDOS") }
function linkSync(existingPath, newPath)        { return copyFileSync(existingPath, newPath, 0) }


///////////////////////////////////////////////////////////////////////////////
// open / close / read / write (fd-style)
///////////////////////////////////////////////////////////////////////////////

function openSync(path, flags, mode) {
    let parsed = _parseFlags(flags)
    let fd = _fd(path)

    if (parsed.exclusive && fd.exists)
        throw _eexist('open', path)
    if (!fd.exists) {
        if (!parsed.create && !parsed.write)
            throw _enoent('open', path)
        if (parsed.create || parsed.write)
            fd.mkFile()
    }

    // Read existing contents (truncate -> empty).
    let buffer
    if (parsed.truncate) {
        buffer = []
    } else {
        try { buffer = fd.bread() } catch (_) { buffer = [] }
    }

    let position = parsed.append ? buffer.length : 0
    let entry = {
        descriptor: fd,
        flags:      parsed,
        position:   position,
        buffer:     buffer,
        dirty:      parsed.truncate,
        path:       fd.fullPath,
    }
    return _allocFd(entry)
}

function closeSync(fd) {
    let entry = _getFd(fd, 'close')
    if (entry.dirty) {
        entry.descriptor.bwrite(entry.buffer)
        try { entry.descriptor.flush() } catch (_) {}
    }
    try { entry.descriptor.close() } catch (_) {}
    delete _fdTable[fd]
    return undefined
}

/**
 * readSync(fd, buffer, offset, length, position)
 *   buffer    Uint8Array / Int8Array / Array
 *   offset    where in `buffer` to start writing
 *   length    bytes to read
 *   position  position in the file, or null for current
 */
function readSync(fd, buffer, offset, length, position) {
    let entry = _getFd(fd, 'read')
    if (!entry.flags.read) throw _ebadf('read')

    if (typeof offset === 'object' && offset !== null) {
        // readSync(fd, buffer, options)
        let opts = offset
        offset   = opts.offset === undefined ? 0 : opts.offset
        length   = opts.length === undefined ? (buffer.length - offset) : opts.length
        position = opts.position === undefined ? null : opts.position
    }
    if (offset === undefined) offset = 0
    if (length === undefined) length = buffer.length - offset
    if (position === null || position === undefined) position = entry.position

    let src = entry.buffer
    let avail = src.length - position
    if (avail < 0) avail = 0
    let n = Math.min(length, avail)
    for (let i = 0; i < n; i++) {
        let b = src[position + i]
        buffer[offset + i] = (b < 0) ? (256 + b) & 0xff : b & 0xff
    }
    if (arguments.length < 5 || position === entry.position)
        entry.position += n
    return n
}

/**
 * writeSync(fd, buffer, offset, length, position)
 * writeSync(fd, string [, position [, encoding]])
 */
function writeSync(fd, buffer, offset, length, position) {
    let entry = _getFd(fd, 'write')
    if (!entry.flags.write) throw _ebadf('write')

    let bytes
    let writeLen
    let writePos

    if (typeof buffer === 'string') {
        let str = buffer
        let pos = (typeof offset === 'number') ? offset : null
        bytes = []
        for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff)
        writeLen = bytes.length
        writePos = (pos === null || pos === undefined) ? entry.position : pos
    } else {
        let off = (offset === undefined) ? 0 : offset
        let len = (length === undefined) ? (buffer.length - off) : length
        let pos = (position === undefined || position === null) ? entry.position : position
        bytes = []
        for (let i = 0; i < len; i++) {
            let b = buffer[off + i]
            bytes.push((b < 0) ? (256 + b) & 0xff : b & 0xff)
        }
        writeLen = len
        writePos = pos
    }

    if (entry.flags.append) writePos = entry.buffer.length

    let buf = entry.buffer
    let needed = writePos + writeLen
    if (needed > buf.length) {
        // grow
        let grown = new Array(needed)
        for (let i = 0; i < buf.length; i++) grown[i] = buf[i]
        for (let i = buf.length; i < writePos; i++) grown[i] = 0
        buf = grown
    }
    for (let i = 0; i < writeLen; i++) buf[writePos + i] = bytes[i]
    entry.buffer = buf
    entry.dirty  = true
    if (position === undefined || position === null || entry.flags.append) {
        entry.position = writePos + writeLen
    }
    return writeLen
}

function fsyncSync(fd) {
    let entry = _getFd(fd, 'fsync')
    if (entry.dirty) {
        entry.descriptor.bwrite(entry.buffer)
        entry.dirty = false
    }
    try { entry.descriptor.flush() } catch (_) {}
    return undefined
}
function fdatasyncSync(fd) { return fsyncSync(fd) }


///////////////////////////////////////////////////////////////////////////////
// Asynchronous (callback) wrappers
///////////////////////////////////////////////////////////////////////////////

function _maybeAsync(syncFn, args, hasCallback) {
    let cb = hasCallback ? args[args.length - 1] : undefined
    if (typeof cb !== 'function') {
        // no callback supplied — silently swallow result; matches old node behaviour
        try { syncFn.apply(null, args) } catch (_) {}
        return
    }
    let realArgs = Array.prototype.slice.call(args, 0, args.length - 1)
    try {
        let result = syncFn.apply(null, realArgs)
        cb(null, result)
    } catch (e) {
        cb(e)
    }
}

function exists(path, callback) {
    if (typeof callback !== 'function') return
    callback(existsSync(path))
}
function access(path, mode, callback) {
    if (typeof mode === 'function') { callback = mode; mode = F_OK }
    try { accessSync(path, mode); callback(null) } catch (e) { callback(e) }
}
function stat(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { callback(null, statSync(path, options)) } catch (e) { callback(e) }
}
function lstat(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { callback(null, lstatSync(path, options)) } catch (e) { callback(e) }
}
function fstat(fd, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { callback(null, fstatSync(fd, options)) } catch (e) { callback(e) }
}
function readFile(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { callback(null, readFileSync(path, options)) } catch (e) { callback(e) }
}
function writeFile(path, data, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { writeFileSync(path, data, options); callback(null) } catch (e) { callback(e) }
}
function appendFile(path, data, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { appendFileSync(path, data, options); callback(null) } catch (e) { callback(e) }
}
function unlink(path, callback)         { try { unlinkSync(path); callback(null) } catch (e) { callback(e) } }
function rmdir(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { rmdirSync(path, options); callback(null) } catch (e) { callback(e) }
}
function rm(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { rmSync(path, options); callback(null) } catch (e) { callback(e) }
}
function mkdir(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { callback(null, mkdirSync(path, options)) } catch (e) { callback(e) }
}
function readdir(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { callback(null, readdirSync(path, options)) } catch (e) { callback(e) }
}
function rename(o, n, callback)         { try { renameSync(o, n); callback(null) } catch (e) { callback(e) } }
function copyFile(s, d, mode, callback) {
    if (typeof mode === 'function') { callback = mode; mode = 0 }
    try { copyFileSync(s, d, mode); callback(null) } catch (e) { callback(e) }
}
function cp(s, d, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { cpSync(s, d, options); callback(null) } catch (e) { callback(e) }
}
function realpath(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { callback(null, realpathSync(path, options)) } catch (e) { callback(e) }
}
function truncate(path, len, callback) {
    if (typeof len === 'function') { callback = len; len = 0 }
    try { truncateSync(path, len); callback(null) } catch (e) { callback(e) }
}
function ftruncate(fd, len, callback) {
    if (typeof len === 'function') { callback = len; len = 0 }
    try { ftruncateSync(fd, len); callback(null) } catch (e) { callback(e) }
}
function utimes(path, a, m, callback)  { try { utimesSync(path, a, m); callback(null) } catch (e) { callback(e) } }
function futimes(fd, a, m, callback)   { try { futimesSync(fd, a, m); callback(null) } catch (e) { callback(e) } }
function lutimes(path, a, m, callback) { try { lutimesSync(path, a, m); callback(null) } catch (e) { callback(e) } }
function chmod(path, m, callback)      { try { chmodSync(path, m); callback(null) } catch (e) { callback(e) } }
function lchmod(path, m, callback)     { try { lchmodSync(path, m); callback(null) } catch (e) { callback(e) } }
function fchmod(fd, m, callback)       { try { fchmodSync(fd, m); callback(null) } catch (e) { callback(e) } }
function chown(path, u, g, callback)   { try { chownSync(path, u, g); callback(null) } catch (e) { callback(e) } }
function lchown(path, u, g, callback)  { try { lchownSync(path, u, g); callback(null) } catch (e) { callback(e) } }
function fchown(fd, u, g, callback)    { try { fchownSync(fd, u, g); callback(null) } catch (e) { callback(e) } }
function readlink(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    try { callback(null, readlinkSync(path, options)) } catch (e) { callback(e) }
}
function symlink(target, path, type, callback) {
    if (typeof type === 'function') { callback = type; type = undefined }
    try { symlinkSync(target, path, type); callback(null) } catch (e) { callback(e) }
}
function link(existingPath, newPath, callback) {
    try { linkSync(existingPath, newPath); callback(null) } catch (e) { callback(e) }
}

function open(path, flags, mode, callback) {
    if (typeof flags === 'function') { callback = flags; flags = 'r'; mode = 0o666 }
    else if (typeof mode === 'function') { callback = mode; mode = 0o666 }
    try { callback(null, openSync(path, flags, mode)) } catch (e) { callback(e) }
}
function close(fd, callback) {
    try { closeSync(fd); if (callback) callback(null) } catch (e) { if (callback) callback(e) }
}
function read(fd, buffer, offset, length, position, callback) {
    // Variadic — collapse to (fd, buffer, offset, length, position, cb).
    if (typeof offset === 'function')   { callback = offset; offset = undefined; length = undefined; position = undefined }
    else if (typeof length === 'function')   { callback = length; length = undefined; position = undefined }
    else if (typeof position === 'function') { callback = position; position = undefined }
    try {
        let n = readSync(fd, buffer, offset, length, position)
        callback(null, n, buffer)
    } catch (e) { callback(e) }
}
function write(fd, buffer, offset, length, position, callback) {
    if (typeof offset === 'function')   { callback = offset; offset = undefined; length = undefined; position = undefined }
    else if (typeof length === 'function')   { callback = length; length = undefined; position = undefined }
    else if (typeof position === 'function') { callback = position; position = undefined }
    try {
        let n = writeSync(fd, buffer, offset, length, position)
        callback(null, n, buffer)
    } catch (e) { callback(e) }
}
function fsync(fd, callback)     { try { fsyncSync(fd); callback(null) } catch (e) { callback(e) } }
function fdatasync(fd, callback) { try { fdatasyncSync(fd); callback(null) } catch (e) { callback(e) } }


///////////////////////////////////////////////////////////////////////////////
// Promise API   (only when the host JS engine supplies Promise)
///////////////////////////////////////////////////////////////////////////////

let promises = undefined
if (typeof Promise !== 'undefined') {
    let _wrap = function (syncFn) {
        return function () {
            let args = arguments
            return new Promise(function (resolve, reject) {
                try { resolve(syncFn.apply(null, args)) }
                catch (e) { reject(e) }
            })
        }
    }
    promises = {
        access:     _wrap(accessSync),
        appendFile: _wrap(appendFileSync),
        chmod:      _wrap(chmodSync),
        chown:      _wrap(chownSync),
        copyFile:   _wrap(copyFileSync),
        cp:         _wrap(cpSync),
        lchmod:     _wrap(lchmodSync),
        lchown:     _wrap(lchownSync),
        link:       _wrap(linkSync),
        lstat:      _wrap(lstatSync),
        lutimes:    _wrap(lutimesSync),
        mkdir:      _wrap(mkdirSync),
        readdir:    _wrap(readdirSync),
        readFile:   _wrap(readFileSync),
        readlink:   _wrap(readlinkSync),
        realpath:   _wrap(realpathSync),
        rename:     _wrap(renameSync),
        rm:         _wrap(rmSync),
        rmdir:      _wrap(rmdirSync),
        stat:       _wrap(statSync),
        symlink:    _wrap(symlinkSync),
        truncate:   _wrap(truncateSync),
        unlink:     _wrap(unlinkSync),
        utimes:     _wrap(utimesSync),
        writeFile:  _wrap(writeFileSync),
    }
}


///////////////////////////////////////////////////////////////////////////////
// Module exports
///////////////////////////////////////////////////////////////////////////////

exports = {
    // constants
    constants,
    F_OK, X_OK, W_OK, R_OK,
    O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND,
    S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFBLK, S_IFIFO, S_IFLNK, S_IFSOCK,

    // classes
    Stats, Dirent,

    // sync
    accessSync, existsSync, statSync, lstatSync, fstatSync,
    readFileSync, writeFileSync, appendFileSync,
    unlinkSync, rmdirSync, rmSync, mkdirSync, readdirSync,
    renameSync, copyFileSync, cpSync,
    realpathSync,
    truncateSync, ftruncateSync,
    utimesSync, futimesSync, lutimesSync,
    chmodSync, lchmodSync, fchmodSync,
    chownSync, lchownSync, fchownSync,
    readlinkSync, symlinkSync, linkSync,
    openSync, closeSync, readSync, writeSync,
    fsyncSync, fdatasyncSync,

    // async (callback)
    access, exists, stat, lstat, fstat,
    readFile, writeFile, appendFile,
    unlink, rmdir, rm, mkdir, readdir,
    rename, copyFile, cp,
    realpath,
    truncate, ftruncate,
    utimes, futimes, lutimes,
    chmod, lchmod, fchmod,
    chown, lchown, fchown,
    readlink, symlink, link,
    open, close, read, write,
    fsync, fdatasync,

    // promise namespace (undefined if Promise is not available)
    promises,
}
