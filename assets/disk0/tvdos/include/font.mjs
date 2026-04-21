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

function resetHighRom() {
    sys.poke(-1299460, 21)
}

function resetLowRom() {
    sys.poke(-1299460, 20)
}

exports = { setHighRom, setLowRom, resetHighRom, resetLowRom }
