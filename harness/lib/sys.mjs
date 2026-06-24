// harness/lib/sys.mjs
//
// The `sys` global -- a JS reimplementation of VMJSR223Delegate.kt against the
// harness VMMemory + TTY. Blocking / hardware behaviours are adapted for a
// single-threaded headless run:
//   - sys.sleep / sys.spin are no-ops by default (configurable)
//   - sys.readKey() consumes vm.inputQueue instead of blocking on a keyboard
//   - sys.waitForMemChg() is bounded (nothing can write memory concurrently in
//     a single-threaded harness) and throws if the condition never holds.

export function makeSys(vm) {
    const mem = vm.mem
    const tty = vm.tty

    const sys = {
        getVmId: () => String(vm.id),

        // ----- memory -------------------------------------------------------
        poke: (addr, value) => mem.poke(addr | 0, value | 0),
        peek: (addr) => mem.peek(addr | 0),
        poke_float: (addr, value) => mem.pokeFloat(addr | 0, +value),
        peek_float: (addr) => mem.peekFloat(addr | 0),
        malloc: (size) => mem.malloc(size | 0),
        calloc: (size) => mem.calloc(size | 0),
        free: (ptr) => mem.free(ptr | 0),
        forceAlloc: (ptr, size) => mem.forceAlloc(ptr | 0, size | 0),
        memset: (dest, ch, count) => mem.memset(dest | 0, ch | 0, count | 0),
        memcpy: (from, to, len) => mem.memcpy(from | 0, to | 0, len | 0),
        pokeBytes: (dest, src, len) => mem.pokeBytes(dest | 0, src, len | 0),
        getUsedMem: () => mem.allocatedBlockCount * 64,
        getMallocStatus: () => mem.getMallocStatus(),
        maxmem: () => mem.memsize,

        // ----- time ---------------------------------------------------------
        nanoTime: () => {
            const t = process.hrtime.bigint()
            return t // BigInt; callers usually diff it
        },
        uptime: () => Date.now() - mem.bootTime,
        currentTimeInMills: () => Date.now(),

        // ----- output -------------------------------------------------------
        print: (s) => {
            if (vm.hooks.print) vm.hooks.print(String(s))
            else tty.write(String(s))
        },
        println: (s) => {
            const str = (s === undefined ? "" : String(s)) + "\n"
            if (vm.hooks.print) vm.hooks.print(str)
            else tty.write(str)
        },

        // ----- input --------------------------------------------------------
        readKey: () => {
            if (vm.inputQueue.length > 0) return vm.inputQueue.shift() | 0
            if (vm.opts.strictInput) throw new Error("sys.readKey(): input queue empty (feed keys with vm.feedKeys/feedLine)")
            return -1
        },
        read: () => {
            const sb = []
            while (vm.inputQueue.length > 0) {
                const key = vm.inputQueue.shift() | 0
                if (key === 13 || key === 10) break
                if (key === 8) { if (sb.length) sb.pop() }
                else if (key >= 0x20 && key <= 0x7e) sb.push(String.fromCharCode(key))
            }
            const line = sb.join("")
            tty.write(line + "\n")
            return line
        },
        readNoEcho: () => {
            const sb = []
            while (vm.inputQueue.length > 0) {
                const key = vm.inputQueue.shift() | 0
                if (key === 13 || key === 10) break
                if (key === 8) { if (sb.length) sb.pop() }
                else if (key >= 0x20 && key <= 0x7e) sb.push(String.fromCharCode(key))
            }
            tty.write("\n")
            return sb.join("")
        },

        // ----- scheduling (headless adaptations) ----------------------------
        spin: () => { if (vm.opts.realSleep) sleepBusy(4) },
        sleep: (time) => { if (vm.opts.realSleep) sleepBusy(Number(time)) },
        waitForMemChg: (addr, andMask, xorMask) => {
            xorMask = xorMask || 0
            let spins = 0
            const max = vm.opts.maxWaitSpins
            while (((sys.peek(addr) ^ xorMask) & andMask) === 0) {
                if (++spins > max)
                    throw new Error(`sys.waitForMemChg(addr=${addr}): condition never met after ${max} spins ` +
                        `(no concurrent writer in single-threaded harness; raise vm.opts.maxWaitSpins or set the byte first)`)
            }
        },

        // ----- sysrq / rom --------------------------------------------------
        getSysrq: () => vm.sysrqDown,
        unsetSysrq: () => { vm.sysrqDown = false },
        mapRom: (slot) => { vm.romMapping = slot & 0xff },
        romReadAll: () => vm.roms[vm.romMapping] || "",

        // ----- diagnostics --------------------------------------------------
        printStackTrace: (e) => {
            let s = "===== host stack trace =====\n"
            if (e == null) s += "(the caught value was null/undefined)\n"
            else if (e instanceof Error) s += (e.stack || e.toString()) + "\n"
            else s += String(e) + "\n"
            process.stderr.write(s)
            return s
        },

        // ----- object code (COCC) -- needs the compress delegate ------------
        toObjectCode: (ptr) => {
            ptr |= 0
            const peek = sys.peek
            const payloadSize = ptr >= 0
                ? (peek(ptr + 1) << 16) | (peek(ptr + 2) << 8) | peek(ptr + 3)
                : (peek(ptr - 1) << 16) | (peek(ptr - 2) << 8) | peek(ptr - 3)
            const decrypted = decryptPayload(sys, ptr, payloadSize, ptr < 0)
            const image = vm.compress.decompBytes(decrypted)
            return Buffer.from(image).toString("latin1")
        },
    }

    return sys
}

// busy-wait used only when vm.opts.realSleep is set (kept tiny; avoid in tests)
function sleepBusy(ms) {
    const end = Date.now() + ms
    while (Date.now() < end) { /* spin */ }
}

// faithful port of VMJSR223Delegate.decryptPayload (RLE-keystream XOR)
function decryptPayload(sys, ptr, payloadSize, dec) {
    let key = "00"
    let keyBytes = [0x00]
    let keyCursor = 0

    const seq = (s) => {
        let out = ""
        let cnt = 0
        let oldchar = s[0]
        for (const ch of s) {
            if (ch === oldchar) cnt++
            else { out += String(cnt) + oldchar; cnt = 1 }
            oldchar = ch
        }
        return out + cnt + oldchar
    }
    const getNewKeySeq = () => {
        key = seq(key)
        keyBytes = new Array((key.length / 2) | 0)
        keyCursor = 0
        for (let i = 0; i < key.length; i += 2)
            keyBytes[i / 2] = parseInt(key.substring(i, Math.min(i + 2, key.length)), 16) & 0xff
    }

    const out = new Uint8Array(payloadSize)
    for (let outcnt = 0; outcnt < payloadSize; outcnt++) {
        const b = !dec ? sys.peek(ptr + 4 + outcnt) : sys.peek(ptr - 4 - outcnt)
        out[outcnt] = (b ^ keyBytes[keyCursor++]) & 0xff
        if (keyCursor >= keyBytes.length) getNewKeySeq()
    }
    return out
}
