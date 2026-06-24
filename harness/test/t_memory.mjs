// harness/test/t_memory.mjs -- VM memory model: peek/poke, malloc, memcpy,
// pokeBytes, peripheral text-area addressing.

import { createVM, makeT } from "../index.mjs"

export function run() {
    const t = makeT("memory")
    const vm = createVM({ tvdos: false })
    const { sys, graphics } = vm.sandbox

    // ---- peek/poke + byte masking ----
    sys.poke(100, 0x41)
    t.eq(sys.peek(100), 0x41, "poke/peek byte")
    sys.poke(101, 300) // wraps to 300 & 0xff = 44
    t.eq(sys.peek(101), 44, "poke masks to byte")
    sys.poke(102, -1)
    t.eq(sys.peek(102), 255, "poke -1 reads back 255 (unsigned)")

    // ---- malloc: aligned, non-overlapping, reserved region honoured ----
    const a = sys.malloc(10)
    const b = sys.malloc(10)
    t.ok(a >= 256, "malloc skips the 256-byte reserved region")
    t.eq(a % 64, 0, "malloc is 64-byte aligned")
    t.ok(b >= a + 64, "second malloc does not overlap the first")
    sys.free(a)
    const c = sys.malloc(10)
    t.eq(c, a, "freed block is reused")

    // ---- float access ----
    sys.poke_float(200, 3.5)
    t.ok(Math.abs(sys.peek_float(200) - 3.5) < 1e-6, "poke_float/peek_float round-trip")

    // ---- memcpy + pokeBytes ----
    for (let i = 0; i < 8; i++) sys.poke(300 + i, i + 1)
    sys.memcpy(300, 400, 8)
    let ok = true
    for (let i = 0; i < 8; i++) if (sys.peek(400 + i) !== i + 1) ok = false
    t.ok(ok, "memcpy userspace->userspace")
    sys.pokeBytes(500, [9, 8, 7, 6], 4)
    t.eq(sys.peek(502), 7, "pokeBytes writes the array")

    // ---- memset ----
    sys.memset(600, 0xAB, 16)
    t.eq(sys.peek(607), 0xAB, "memset fills")

    // ---- peripheral text-area addressing (the vaddr pattern) ----
    // getGpuMemBase() - 253950 is the physical text-area base; byte m sits at
    // base - m. Writing there must be visible to the GPU text plane.
    const gpuBase = graphics.getGpuMemBase() - 253950
    t.eq(graphics.getGpuMemBase(), -1048577, "getGpuMemBase == -1048577 (GPU slot 1)")
    // char plane byte 0 is at text-area offset 5122 (cursor2 + fore2560 + back2560)
    sys.poke(gpuBase - 5122, 0x58 /* 'X' */)
    t.eq(vm.tty.block[vm.tty._charIdx(0, 0)], 0x58, "direct-VRAM poke lands in the char plane")

    vm.dispose()
    return t.report()
}
