// harness/lib/compress.mjs
//
// `gzip` (CompressorDelegate -- note: the namespace is a misnomer, it is Zstd)
// and `base64` (Base64Delegate). Node v22.15+ ships native Zstd in node:zlib;
// gzip-wrapped payloads are also accepted on decompress (matching decomp()'s
// header sniff).

import zlib from "node:zlib"

const GZIP = (b) => b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08
const ZSTD = (b) => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd

function compBytes(bytes) {
    return zlib.zstdCompressSync(Buffer.from(bytes))
}

function decompBytes(bytes) {
    const b = Buffer.from(bytes)
    if (GZIP(b)) return zlib.gunzipSync(b)
    if (ZSTD(b)) return zlib.zstdDecompressSync(b)
    throw new Error("gzip.decomp: unrecognised header (not gzip or zstd)")
}

// latin1 (ISO-8859-1) is VM.CHARSET
const strToBytes = (s) => Buffer.from(String(s), "latin1")
const bytesToArr = (buf) => Uint8Array.from(buf) // unsigned 0..255

export function makeCompress(vm) {
    const mem = vm.mem

    // write a byte run to a destination VM address. For positive addresses this
    // pokes forward; for negative (device) addresses the original copies the
    // reversed buffer ending at `output` -- approximated here with a backward
    // poke, which is the common device convention. (Most harness use is
    // positive output, which is exact.)
    const writeOut = (bytes, output, reversedForDevice) => {
        if (output >= 0 || !reversedForDevice) {
            for (let i = 0; i < bytes.length; i++) mem.poke(output + i, bytes[i])
        } else {
            for (let i = 0; i < bytes.length; i++) mem.poke(output - i, bytes[bytes.length - 1 - i])
        }
        return bytes.length
    }

    const gzip = {
        comp: (input) => bytesToArr(compBytes(typeof input === "string" ? strToBytes(input) : input)),
        decomp: (input) => bytesToArr(decompBytes(typeof input === "string" ? strToBytes(input) : input)),

        compFromTo: (input, len, output) => {
            const inbytes = mem.readBytes(input, len)
            const out = compBytes(Uint8Array.from(inbytes))
            return writeOut(out, output, true)
        },
        decompFromTo: (input, len, output) => {
            const inbytes = mem.readBytes(input, len)
            const out = decompBytes(Uint8Array.from(inbytes))
            return writeOut(out, output, false) // Kotlin always pokes forward here
        },
        compTo: (input, output) => {
            const out = compBytes(typeof input === "string" ? strToBytes(input) : Uint8Array.from(input))
            return writeOut(out, output, true)
        },
        decompTo: (input, output) => {
            const out = decompBytes(typeof input === "string" ? strToBytes(input) : Uint8Array.from(input))
            return writeOut(out, output, true)
        },

        // internal helper used by sys.toObjectCode
        decompBytes: (bytes) => decompBytes(bytes),
        compBytes: (bytes) => compBytes(bytes),
    }

    const base64 = {
        atob: (inputstr) => bytesToArr(Buffer.from(String(inputstr), "base64")),
        atostr: (inputstr) => Buffer.from(String(inputstr), "base64").toString("latin1"),
        btoa: (inputbytes) => {
            const buf = typeof inputbytes === "string"
                ? strToBytes(inputbytes)
                : Buffer.from(Uint8Array.from(inputbytes))
            return buf.toString("base64")
        },
        atoptr: (inputstr) => {
            const bytes = Buffer.from(String(inputstr), "base64")
            const ptr = mem.malloc(bytes.length + 4)
            for (let i = 0; i < bytes.length; i++) mem.poke(ptr + i, bytes[i])
            return ptr
        },
    }

    return { gzip, base64 }
}
