let status = 0
let workarea = sys.malloc(1920)

// install LOCHRROM
let hangulRomL = files.open("A:/tvdos/i18n/hang_lo.chr")
if (!hangulRomL.exists) {
    printerrln("hang_lo.chr not found")
    sys.free(workarea)
    return status
}
hangulRomL.pread(workarea, 1920, 0)
for (let i = 0; i < 1920; i++) sys.poke(-133121 - i, sys.peek(workarea + i))
sys.poke(-1299460, 18)


// install HICHRROM
let hangulRomH = files.open("A:/tvdos/i18n/hang_hi.chr")
if (!hangulRomH.exists) {
    printerrln("hang_hi.chr not found")
    sys.free(workarea)
    sys.poke(-1299460, 20) // clean up the crap
    return status
}
hangulRomH.pread(workarea, 1920, 0)
for (let i = 0; i < 1920; i++) sys.poke(-133121 - i, sys.peek(workarea + i))
sys.poke(-1299460, 19)



sys.free(workarea)
