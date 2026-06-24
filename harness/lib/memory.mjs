// harness/lib/memory.mjs
//
// Faithful-enough port of the TSVM VM memory model (tsvm_core/.../VM.kt) for the
// Node.js test harness.
//
//  - 8 MiB flat user space (addresses >= 0)              -- VM.usermem
//  - 64-byte malloc units, first-fit allocator           -- VM.malloc/calloc/free
//  - peripherals occupy NEGATIVE address space, one 1 MiB
//    block per slot (offset = -addr-1 within the block)  -- VM.translateAddr
//  - slot 0 = IOSpace  (keyboard + timer MMIO registers)
//  - slot 1 = GPU      (framebuffer + text area)         -- getGpuMemBase() == -1048577
//  - slot 2 = Audio    (sample bin window)
//
// The single-1MiB-block-per-slot layout reproduces the byte offsets that
// VMJSR223Delegate.getDev() resolves to, so direct-VRAM apps (the `vaddr`
// pattern) and sys.memcpy/pokeBytes against the GPU text area behave the same
// as on the real machine.

export const USER_SPACE_SIZE = 8192 * 1024 // 8 MiB
export const MALLOC_UNIT = 64
export const MALLOC_RESERVED_BLOCKS = 4 // first 256 bytes never handed out
export const PERI_BLOCK_SIZE = 1048576 // 1 MiB per peripheral slot

// GPU memory-area offsets (mirror VMJSR223Delegate.getDev, GraphicsAdapter)
export const GPU_TEXT_AREA_OFFSET = 253950 // textArea base within the GPU block
export const GPU_TEXT_AREA_SIZE = 7682 // cursor(2) + fore(2560) + back(2560) + char(2560)
export const GPU_SLOT = 1
export const IO_SLOT = 0
export const AUDIO_SLOT = 2

const mask8 = (v) => v & 0xff
// signed byte -> 0..255 the way Kotlin `.toInt().and(255)` does
const toUint = (b) => b & 0xff

class Peripheral {
    constructor(name) {
        this.name = name
        this.block = new Uint8Array(PERI_BLOCK_SIZE)
    }

    // offset is within the 1 MiB block. Subclasses override for MMIO behaviour.
    peek(offset) {
        return this.block[offset]
    }

    poke(offset, value) {
        this.block[offset] = mask8(value)
    }
}

// IOSpace: services the handful of MMIO registers the base environment touches
// (keyboard snapshot + uptime / wall-clock timers). Register index N is reached
// from JS as sys address -(N+1).
class IOSpace extends Peripheral {
    constructor(vm) {
        super("io")
        this.vm = vm
    }

    poke(offset, value) {
        super.poke(offset, value)
        // reg 39 (addr -40): latch the raw keyboard snapshot into regs 40..47
        if (offset === 39 && (value & 0xff) !== 0) {
            const snap = this.vm.rawKeys
            for (let i = 0; i < 8; i++) this.block[40 + i] = snap[i] | 0
        }
        // reg 38 (addr -39): cooked-input request flag (no-op latch here; the
        // harness services readKey() directly from the input queue)
        // reg 68 (addr -69): latch the timers
        if (offset === 68 && (value & 0xff) !== 0) {
            this._latchTimers()
        }
    }

    _latchTimers() {
        const up = BigInt(Math.max(0, Date.now() - this.vm.bootTime))
        const ep = BigInt(Date.now())
        // uptime millis little-endian at regs 72..79 (read via peek(-73-i))
        for (let i = 0n; i < 8n; i++)
            this.block[72 + Number(i)] = Number((up >> (8n * i)) & 0xffn)
        // wall-clock millis little-endian at regs 80..87 (read via peek(-81-i))
        for (let i = 0n; i < 8n; i++)
            this.block[80 + Number(i)] = Number((ep >> (8n * i)) & 0xffn)
    }
}

export class VMMemory {
    constructor(opts = {}) {
        this.userspace = new Uint8Array(USER_SPACE_SIZE)
        this.memsize = USER_SPACE_SIZE
        this.mallocBlockSize = (USER_SPACE_SIZE / MALLOC_UNIT) | 0
        this.mallocMap = new Uint8Array(this.mallocBlockSize) // 1 = allocated
        this.mallocSizes = new Map() // blockIndex -> blockCount
        this.allocatedBlockCount = 0

        this.bootTime = Date.now()
        // raw keyboard snapshot (8 bytes) surfaced through con.poll_keys()
        this.rawKeys = new Uint8Array(8)
        // cooked key queue consumed by sys.readKey()
        this.inputQueue = []

        this.peripherals = []
        this.peripherals[IO_SLOT] = new IOSpace(this)
        this.peripherals[GPU_SLOT] = new Peripheral("gpu")
        this.peripherals[AUDIO_SLOT] = new Peripheral("snd")
    }

    // ----- address translation ---------------------------------------------

    // Returns { array, index } for a single byte, or null for open bus.
    _resolve(addr) {
        if (addr >= 0) {
            if (addr >= this.memsize) throw new Error(`Illegal access: ${addr} >= ${this.memsize}`)
            return { array: this.userspace, index: addr, peri: null }
        }
        const rel = -addr - 1
        const slot = Math.floor(rel / PERI_BLOCK_SIZE)
        const off = rel % PERI_BLOCK_SIZE
        const peri = this.peripherals[slot]
        if (!peri) return null
        return { array: peri.block, index: off, peri, off }
    }

    peek(addr) {
        const r = this._resolve(addr | 0)
        if (r === null) throw new Error(`OpenBus peek at ${addr}`)
        if (r.peri) return toUint(r.peri.peek(r.off))
        return toUint(r.array[r.index])
    }

    poke(addr, value) {
        const r = this._resolve(addr | 0)
        if (r === null) throw new Error(`OpenBus poke at ${addr}`)
        if (r.peri) r.peri.poke(r.off, value)
        else r.array[r.index] = mask8(value)
    }

    peekFloat(addr) {
        const b = new Uint8Array(4)
        for (let i = 0; i < 4; i++) b[i] = this.peek(addr + i)
        return new Float32Array(b.buffer)[0]
    }

    pokeFloat(addr, value) {
        const f = new Float32Array([value])
        const b = new Uint8Array(f.buffer)
        for (let i = 0; i < 4; i++) this.poke(addr + i, b[i])
    }

    // ----- malloc (first-fit, faithful to VM.findEmptySpace) ----------------

    _nextClearBit(from) {
        let i = from
        while (i < this.mallocBlockSize && this.mallocMap[i] === 1) i++
        return i
    }

    _findEmptySpace(blockSize) {
        let cursorHead = MALLOC_RESERVED_BLOCKS
        const cursorHeadMaxInclusive = this.mallocBlockSize - blockSize
        while (cursorHead <= cursorHeadMaxInclusive) {
            cursorHead = this._nextClearBit(cursorHead)
            const cursorTail = cursorHead + blockSize - 1
            if (cursorTail > this.mallocBlockSize) return null
            if (this.mallocMap[cursorTail] === 0) {
                let notEmpty = false
                for (let k = cursorHead; k <= cursorTail; k++)
                    notEmpty = notEmpty || this.mallocMap[k] === 1
                if (!notEmpty) {
                    for (let k = cursorHead; k <= cursorTail; k++) this.mallocMap[k] = 1
                    return cursorHead
                }
            }
            cursorHead = cursorTail + 1
        }
        return null
    }

    malloc(size) {
        if (size <= 0) throw new Error(`Invalid malloc size: ${size}`)
        const blocks = Math.ceil(size / MALLOC_UNIT)
        const start = this._findEmptySpace(blocks)
        if (start === null) throw new Error(`OutOfMemory: no space for ${blocks} blocks (${size} bytes)`)
        this.allocatedBlockCount += blocks
        this.mallocSizes.set(start, blocks)
        return start * MALLOC_UNIT
    }

    calloc(size) {
        const ptr = this.malloc(size)
        const blocks = Math.ceil(size / MALLOC_UNIT)
        this.userspace.fill(0, ptr, ptr + blocks * MALLOC_UNIT)
        return ptr
    }

    free(ptr) {
        const index = (ptr / MALLOC_UNIT) | 0
        const count = this.mallocSizes.get(index)
        if (count === undefined) throw new Error(`No allocation for pointer 0x${ptr.toString(16)}`)
        for (let k = index; k < index + count; k++) this.mallocMap[k] = 0
        this.mallocSizes.delete(index)
        this.allocatedBlockCount -= count
    }

    forceAlloc(ptr, size) {
        const blocks = Math.ceil(size / MALLOC_UNIT)
        const start = (ptr / MALLOC_UNIT) | 0
        let previouslyUnallocated = 0
        for (let i = start; i < start + blocks; i++) {
            if (this.mallocMap[i] === 0) previouslyUnallocated++
            this.mallocMap[i] = 1
        }
        this.allocatedBlockCount += previouslyUnallocated
        this.mallocSizes.set(start, blocks)
    }

    // ----- bulk ops (faithful to VM.memcpy/memset, getDev fast path) --------

    // Resolve a contiguous backing array for a forward run of `len` bytes, or
    // null if the run is not a single contiguous device window (e.g. it hits
    // MMIO registers) -- in which case the caller falls back to byte-wise poke,
    // mirroring VM.getDev() returning null.
    _getDev(from, len) {
        if (from >= 0) {
            if (from + len > this.memsize) return null
            return { array: this.userspace, base: from }
        }
        const rel = -from - 1
        const slot = Math.floor(rel / PERI_BLOCK_SIZE)
        const off = rel % PERI_BLOCK_SIZE
        const peri = this.peripherals[slot]
        if (!peri) return null
        // IOSpace registers are not a flat copyable window
        if (peri.name === "io") return null
        if (off + len > PERI_BLOCK_SIZE) return null
        return { array: peri.block, base: off }
    }

    memcpy(from, to, len) {
        from |= 0; to |= 0; len |= 0
        const fromVec = from >= 0 ? 1 : -1
        const toVec = to >= 0 ? 1 : -1
        const fromDev = this._getDev(from, len)
        const toDev = this._getDev(to, len)
        if (fromDev && toDev) {
            for (let i = 0; i < len; i++) toDev.array[toDev.base + i] = fromDev.array[fromDev.base + i]
        } else {
            for (let i = 0; i < len; i++) this.poke(to + i * toVec, this.peek(from + i * fromVec))
        }
    }

    // src is an array-like of byte values
    pokeBytes(dest, src, len) {
        dest |= 0; len |= 0
        const dev = this._getDev(dest, len)
        if (dev) {
            for (let i = 0; i < len; i++) dev.array[dev.base + i] = mask8(src[i])
        } else {
            const vec = dest >= 0 ? 1 : -1
            for (let i = 0; i < len; i++) this.poke(dest + i * vec, src[i])
        }
    }

    memset(dest, ch, count) {
        dest |= 0; count |= 0
        const vec = dest >= 0 ? 1 : -1
        for (let i = 0; i < count; i++) this.poke(dest + i * vec, ch)
        return dest
    }

    // ----- helpers used by the host delegates -------------------------------

    // read `len` bytes starting at addr (forward for positive, backward for
    // negative) into a plain JS array of unsigned bytes.
    readBytes(addr, len) {
        const out = new Array(len)
        const vec = addr >= 0 ? 1 : -1
        for (let i = 0; i < len; i++) out[i] = this.peek(addr + i * vec)
        return out
    }

    getMallocStatus() {
        return [MALLOC_UNIT, this.allocatedBlockCount]
    }
}
