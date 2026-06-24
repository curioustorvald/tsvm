// harness/test/t_compress.mjs -- gzip (Zstd) + base64 round-trips, including
// the in-memory compFromTo/decompFromTo variants.

import { createVM, makeT } from "../index.mjs"

export function run() {
    const t = makeT("compress")
    const vm = createVM({ tvdos: false })
    const { gzip, base64, sys } = vm.sandbox

    // ---- gzip.comp / gzip.decomp round-trip (Zstd under the hood) ----
    const text = "the quick brown fox ".repeat(50)
    const comp = gzip.comp(text)
    t.ok(comp.length < text.length, "gzip.comp shrinks repetitive text")
    const back = gzip.decomp(comp)
    t.eq(String.fromCharCode(...back), text, "gzip.decomp restores the text")

    // ---- in-memory compFromTo / decompFromTo ----
    const src = "ABCDEFGH".repeat(64) // 512 bytes
    for (let i = 0; i < src.length; i++) sys.poke(1000 + i, src.charCodeAt(i))
    const clen = gzip.compFromTo(1000, src.length, 20000)
    t.ok(clen > 0, "compFromTo returns a length")
    const dlen = gzip.decompFromTo(20000, clen, 30000)
    t.eq(dlen, src.length, "decompFromTo restores the original length")
    let ok = true
    for (let i = 0; i < src.length; i++) if (sys.peek(30000 + i) !== src.charCodeAt(i)) ok = false
    t.ok(ok, "decompFromTo restores the bytes")

    // ---- base64 ----
    t.eq(base64.btoa("Man"), "TWFu", "base64.btoa")
    t.eq(base64.atostr("TWFu"), "Man", "base64.atostr")
    const bytes = base64.atob("TWFu")
    t.eq(bytes[0], 77, "base64.atob first byte 'M'")

    vm.dispose()
    return t.report()
}
