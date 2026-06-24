function setHighRom(fullPath) {
    const fontFile = files.open(fullPath)

    // upload font
    const fontData = fontFile.bread()
    for (let i = 0; i < 1920; i++) sys.poke(-133121 - i, fontData[i])
    sys.poke(-1299460, 19) // write to high rom

    fontFile.close()
}

function setLowRom(fullPath) {
    const fontFile = files.open(fullPath)

    // upload font
    const fontData = fontFile.bread()
    for (let i = 0; i < 1920; i++) sys.poke(-133121 - i, fontData[i])
    sys.poke(-1299460, 18) // write to low rom

    fontFile.close()
}

// Upload only a contiguous range of high-ROM glyphs (chars 0x80..0xFF), leaving
// every other glyph as currently staged. The font ROM hardware always commits
// all 128 high-half glyphs from the staging buffer at once, so a true "upload
// by specific chars" works by poking only the wanted glyphs into the staging
// buffer (the rest still hold the previous full upload) and then committing.
//
// `fullPath` is a full 128-glyph high-ROM .chr (char-major, 14 bytes/glyph;
// see tvdos/tuidev/font_rom_builder.c). `firstChar`/`lastChar` are inclusive
// byte values in 0x80..0xFF. CALLER NOTE: this preserves the staging buffer's
// other glyphs, so it assumes the last full font upload was the High ROM
// (setLowRom shares the same staging buffer and would clobber it).
function setHighRomChars(fullPath, firstChar, lastChar) {
    const fontFile = files.open(fullPath)
    const fontData = fontFile.bread()
    fontFile.close()

    const GLYPH_BYTES = 14 // font_rom_builder.c GLYPH_BYTES
    for (let c = firstChar; c <= lastChar; c++) {
        const off = (c - 0x80) * GLYPH_BYTES
        for (let l = 0; l < GLYPH_BYTES; l++) sys.poke(-133121 - (off + l), fontData[off + l])
    }
    sys.poke(-1299460, 19) // commit staging buffer to high rom
}

function resetHighRom() {
    sys.poke(-1299460, 21)
}

function resetLowRom() {
    sys.poke(-1299460, 20)
}

exports = { setHighRom, setLowRom, setHighRomChars, resetHighRom, resetLowRom }
