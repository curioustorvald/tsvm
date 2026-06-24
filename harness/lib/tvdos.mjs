// harness/lib/tvdos.mjs
//
// The TVDOS userland layer: `files`, `_TVDOS`, `_G.shell`, and `require`,
// reimplemented against the host filesystem.
//
//   - Drive A: maps to the real assets/disk0 tree (configurable).
//   - Writes go to a copy-on-write OVERLAY directory, so tests never mutate the
//     repo. Reads check the overlay first, then the real disk; removals are
//     recorded as tombstones.
//   - The descriptor API mirrors TVDOS.SYS's TVDOSFileDescriptor (sread/bread/
//     pread/swrite/bwrite/pwrite/append/list/mkDir/mkFile/remove/size/exists/
//     isDirectory/...).
//   - A few reserved device files are supported: NUL, ZERO, RND, CON.

import fs from "node:fs"
import path from "node:path"

const RESERVED_NAMES = [
    "AUX", "COM1", "COM2", "COM3", "COM4", "CON", "FB1", "FB2", "FBIPF",
    "HFB1", "HFB2", "HFB3", "HFB4", "LPT1", "LPT2", "LPT3", "LPT4", "MEM",
    "NUL", "PMEM0", "PMEM1", "PMEM2", "PMEM3", "PMEM4", "PMEM5", "PMEM6",
    "PMEM7", "PRN", "RND", "TMP", "XFB", "ZERO",
]

const DEFAULT_VARIABLES = {
    DOSDIR: "\\tvdos",
    LANG: "EN",
    KEYBOARD: "us_qwerty",
    PATH: "\\tvdos\\bin;\\home",
    INCLPATH: "\\tvdos\\include;\\home",
    PATHEXT: ".com;.bat;.app;.js;.alias",
    HELPPATH: "\\tvdos\\help",
    OS_NAME: "TSVM Disk Operating System",
    OS_VERSION: "1.4",
    USERCONFIGPATH: "\\home\\config",
}

const latin1 = (buf) => Buffer.from(buf).toString("latin1")
const toBuf = (str) => Buffer.from(String(str), "latin1")

export function makeTvdos(vm) {
    const mem = vm.mem
    const diskRoot = vm.opts.diskRoot
    const overlayRoot = vm.opts.overlayRoot
    const drives = { A: diskRoot, ...(vm.opts.drives || {}) }

    fs.mkdirSync(overlayRoot, { recursive: true })

    // ----- host path helpers -----------------------------------------------
    // a VM path segment list -> a relative host path
    const segsOf = (vmPath) => vmPath.replaceAll("\\", "/").split("/").filter((s) => s.length > 0)
    const realPath = (drive, vmPath) => path.join(drives[drive] || diskRoot, ...segsOf(vmPath))
    const overlayPath = (drive, vmPath) => path.join(overlayRoot, drive, ...segsOf(vmPath))
    const tombstonePath = (drive, vmPath) => overlayPath(drive, vmPath) + ".__tomb__"

    const isTomb = (d, p) => fs.existsSync(tombstonePath(d, p))
    const clearTomb = (d, p) => { try { fs.rmSync(tombstonePath(d, p)) } catch {} }
    const setTomb = (d, p) => { fs.mkdirSync(path.dirname(tombstonePath(d, p)), { recursive: true }); fs.writeFileSync(tombstonePath(d, p), "") }

    // returns the host path that currently backs a read, or null if absent
    const readBacking = (d, p) => {
        if (isTomb(d, p)) return null
        const ov = overlayPath(d, p)
        if (fs.existsSync(ov)) return ov
        const rl = realPath(d, p)
        if (fs.existsSync(rl)) return rl
        return null
    }

    // ensure a writable overlay copy exists (copy-on-write from the real disk);
    // returns the overlay host path
    const materialise = (d, p) => {
        const ov = overlayPath(d, p)
        fs.mkdirSync(path.dirname(ov), { recursive: true })
        if (!fs.existsSync(ov)) {
            const rl = realPath(d, p)
            if (fs.existsSync(rl) && !isTomb(d, p) && fs.statSync(rl).isFile())
                fs.copyFileSync(rl, ov)
        }
        clearTomb(d, p)
        return ov
    }

    // ----- the device drivers (NUL/ZERO/RND/CON) ---------------------------
    const deviceDriver = (name) => {
        switch (name) {
            case "NUL": return {
                exists: true, isDir: false, size: () => 0,
                read: () => new Uint8Array(0), write: () => {}, append: () => {},
            }
            case "ZERO": return {
                exists: true, isDir: false, size: () => 0,
                read: (n) => new Uint8Array(n || 0), write: () => {}, append: () => {},
            }
            case "RND": return {
                exists: true, isDir: false, size: () => 0,
                read: (n) => { const b = new Uint8Array(n || 0); for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0; return b },
                write: () => {}, append: () => {},
            }
            case "CON": return {
                exists: true, isDir: false, size: () => 0,
                read: () => new Uint8Array(0),
                write: (bytes) => vm.tty.write(latin1(bytes)),
                append: (bytes) => vm.tty.write(latin1(bytes)),
            }
            default: return null
        }
    }

    // ----- file descriptor --------------------------------------------------
    class HostFileDescriptor {
        constructor(fullPath, isDevice) {
            this._device = null
            if (isDevice) {
                // reserved name or $:-device path
                const upper = fullPath.toUpperCase()
                const devName = upper.replace(/^\$:[\\/]*/, "").split(/[\\/]/)[0]
                this._driveLetter = "$"
                this._path = "\\" + (devName || upper)
                this._device = deviceDriver(devName) || deviceDriver(upper)
                if (!this._device) throw new Error(`${devName || upper} is not a supported device file in the harness`)
                return
            }
            let p = fullPath.replaceAll("/", "\\")
            this._driveLetter = p[0].toUpperCase()
            p = p.substring(2) // strip "A:"
            while (p.endsWith("\\")) p = p.substring(0, p.length - 1)
            while (p.startsWith("\\")) p = p.substring(1)
            this._path = "\\" + p
        }

        get driveLetter() { return this._driveLetter }
        get path() { return this._path }
        get fullPath() { return `${this._driveLetter}:${this._path}` }
        get name() { return this._path.split("\\").filter(Boolean).pop() || "" }
        get extension() {
            const n = this.name; const d = n.lastIndexOf(".")
            return d < 0 ? "" : n.substring(d + 1)
        }
        get parentPath() { const li = this._path.lastIndexOf("\\"); return this._path.substring(0, li) }

        _backing() { return readBacking(this._driveLetter, this._path) }

        get exists() {
            if (this._device) return this._device.exists
            return this._backing() !== null
        }
        get isDirectory() {
            if (this._device) return this._device.isDir
            const b = this._backing()
            return b !== null && fs.statSync(b).isDirectory()
        }
        get size() {
            if (this._device) return this._device.size()
            const b = this._backing()
            if (b === null) throw new Error(`No such file: ${this.fullPath}`)
            return fs.statSync(b).size
        }

        // ---- reads ----
        bread() {
            if (this._device) return this._device.read(0)
            const b = this._backing()
            if (b === null) throw new Error(`No such file: ${this.fullPath}`)
            return Uint8Array.from(fs.readFileSync(b))
        }
        sread() { return latin1(this.bread()) }
        pread(ptr, count, offset) {
            offset = offset | 0; count = count | 0
            const all = this.bread()
            for (let i = 0; i < count; i++) mem.poke(ptr + i, all[offset + i] || 0)
        }

        // ---- writes (to overlay) ----
        _writeAll(buf) {
            if (this._device) return this._device.write(Uint8Array.from(buf))
            const ov = overlayPath(this._driveLetter, this._path)
            fs.mkdirSync(path.dirname(ov), { recursive: true })
            fs.writeFileSync(ov, Buffer.from(buf))
            clearTomb(this._driveLetter, this._path)
        }
        _appendAll(buf) {
            if (this._device) return this._device.append(Uint8Array.from(buf))
            const ov = materialise(this._driveLetter, this._path)
            fs.appendFileSync(ov, Buffer.from(buf))
        }
        bwrite(bytes) { this._writeAll(Uint8Array.from(bytes)) }
        swrite(string) { this._writeAll(toBuf(string)) }
        pwrite(ptr, count, offset) {
            offset = offset | 0; count = count | 0
            // existing content (or empty), patched at [offset, offset+count)
            let base = this.exists && !this.isDirectory ? Buffer.from(this.bread()) : Buffer.alloc(0)
            const needed = offset + count
            if (base.length < needed) base = Buffer.concat([base, Buffer.alloc(needed - base.length)])
            for (let i = 0; i < count; i++) base[offset + i] = mem.peek(ptr + i)
            this._writeAll(base)
        }
        bappend(bytes) { this._appendAll(Uint8Array.from(bytes)) }
        sappend(string) { this._appendAll(toBuf(string)) }
        pappend(ptr, count) {
            count = count | 0
            const buf = Buffer.alloc(count)
            for (let i = 0; i < count; i++) buf[i] = mem.peek(ptr + i)
            this._appendAll(buf)
        }

        // ---- metadata ops ----
        flush() {}
        close() {}
        touch() { if (!this.exists) this.mkFile() }
        mkFile() {
            const ov = overlayPath(this._driveLetter, this._path)
            fs.mkdirSync(path.dirname(ov), { recursive: true })
            if (!fs.existsSync(ov)) fs.writeFileSync(ov, "")
            clearTomb(this._driveLetter, this._path)
        }
        mkDir() {
            const ov = overlayPath(this._driveLetter, this._path)
            fs.mkdirSync(ov, { recursive: true })
            clearTomb(this._driveLetter, this._path)
        }
        remove() {
            const ov = overlayPath(this._driveLetter, this._path)
            if (fs.existsSync(ov)) fs.rmSync(ov, { recursive: true, force: true })
            // tombstone if it also exists on the real disk
            if (fs.existsSync(realPath(this._driveLetter, this._path))) setTomb(this._driveLetter, this._path)
        }
        list() {
            if (!this.isDirectory) return undefined
            const d = this._driveLetter, p = this._path
            const names = new Set()
            const realDir = realPath(d, p)
            const ovDir = overlayPath(d, p)
            if (fs.existsSync(realDir) && fs.statSync(realDir).isDirectory())
                for (const e of fs.readdirSync(realDir)) names.add(e)
            if (fs.existsSync(ovDir) && fs.statSync(ovDir).isDirectory())
                for (const e of fs.readdirSync(ovDir)) { if (!e.endsWith(".__tomb__")) names.add(e) }
            const childBase = p === "\\" ? "" : p
            const out = []
            for (const nm of names) {
                if (isTomb(d, childBase + "\\" + nm)) continue
                out.push(files.open(`${d}:${childBase}\\${nm}`))
            }
            return out
        }
    }

    // ----- files ------------------------------------------------------------
    const files = {}
    files.reservedNames = RESERVED_NAMES.slice()
    files.open = (fullPath) => {
        if (fullPath == undefined) throw new Error("path is undefined")
        if (RESERVED_NAMES.includes(String(fullPath).toUpperCase()))
            return new HostFileDescriptor(String(fullPath).toUpperCase(), true)
        if (fullPath[2] !== "/" && fullPath[2] !== "\\")
            throw new Error("Expected full path with drive letter, got " + fullPath)
        if (fullPath[0] === "$") return new HostFileDescriptor(fullPath.toUpperCase(), true)
        return new HostFileDescriptor(fullPath, false)
    }
    files.readText = (fullPath) => files.open(fullPath).sread()
    files.HostFileDescriptor = HostFileDescriptor

    // ----- _TVDOS + env -----------------------------------------------------
    const variables = { ...DEFAULT_VARIABLES, ...(vm.opts.env || {}) }
    applyCommandrc(files, variables, vm.opts.applyCommandrc)
    const _TVDOS = {
        VERSION: "1.4",
        variables,
        getPath: () => [""].concat(variables.PATH.split(";")),
        DRIVES: { A: ["A", 1] },
        DRIVEFS: { A: "HOST" },
        DRIVEINFO: {},
    }

    // ----- _G.shell (path resolution + cwd) ---------------------------------
    const shellState = { drive: "A", pwd: [""] } // pwd[0] is the root ""
    const resolvePathInput = (input) => {
        if (input === undefined) return undefined
        const pathstr0 = String(input).replaceAll("\\", "/")
        let pathstr, driveLetter = shellState.drive
        if (pathstr0[2] !== "/" && pathstr0[2] !== "\\") {
            pathstr = pathstr0
        } else {
            pathstr = pathstr0.substring(2)
            driveLetter = pathstr0[0].toUpperCase()
        }
        const startsWithSlash = pathstr.startsWith("/")
        const newPwd = []
        const ipwd = (startsWithSlash ? [""] : shellState.pwd).concat(
            pathstr.split("/").filter((it) => it.length > 0))
        ipwd.forEach((it) => {
            if (it === ".." && newPwd[1] !== undefined) newPwd.pop()
            else if (it !== ".." && it !== ".") newPwd.push(it)
        })
        const resolved = "\\" + newPwd.join("\\").substring(1)
        return { string: resolved, pwd: newPwd, drive: driveLetter, full: `${driveLetter}:${resolved}` }
    }

    const _G = {
        shell: {
            resolvePathInput,
            getCurrentDrive: () => shellState.drive,
            setCurrentDrive: (d) => { shellState.drive = String(d).toUpperCase() },
            getPwd: () => shellState.pwd.slice(),
            setPwd: (arr) => { shellState.pwd = arr.slice() },
            // chdir helper for tests
            cd: (input) => {
                const r = resolvePathInput(input)
                const fd = files.open(r.full)
                if (!fd.exists || !fd.isDirectory) throw new Error(`Not a directory: ${r.full}`)
                shellState.drive = r.drive; shellState.pwd = r.pwd
            },
        },
    }

    // ----- require (TVDOS module loader) ------------------------------------
    // Resolves an absolute VM path (or a bare path the caller already resolved),
    // reads the source, and evaluates it in the sandbox with the TVDOS module
    // contract: `let exports = {}; <src>; Object.freeze(exports)`.
    const require = (absdir) => {
        const full = absdir[1] === ":" ? absdir : resolvePathInput(absdir).full
        const moduleFile = files.open(full)
        if (!moduleFile.exists) throw new Error("No such file: " + full)
        const src = moduleFile.sread()
        return vm.evalModule(src, full)
    }

    return { files, _TVDOS, _G, require }
}

// minimal `set NAME=VALUE` applier for assets/disk0/commandrc, with $NAME and
// $PATH-style expansion. Best-effort; failures are non-fatal.
function applyCommandrc(files, variables, rcPathOrFalse) {
    if (rcPathOrFalse === false) return
    try {
        const fd = files.open(rcPathOrFalse || "A:/commandrc")
        if (!fd.exists) return
        for (const raw of fd.sread().split(/\r?\n/)) {
            const line = raw.trim()
            const m = /^set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
            if (!m) continue
            const name = m[1]
            const value = m[2].replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, v) => variables[v] ?? "")
            variables[name] = value
        }
    } catch { /* ignore */ }
}
