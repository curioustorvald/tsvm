if (!_TVDOS) {
    println("This program can only run on TVDOS")
    return 1
}
if (!exec_args[1]) {
    println("Usage: dumpfont <rom_prefix>")
    println("       e.g. if rom_prefix is 'home/myfont', the output files will be 'home/myfont_low.chr' and 'home/myfont_high.chr'")
    return 1
}

let lowfilename = exec_args[1] + "_low.chr"
let highfilename = exec_args[1] + "_high.chr"

let workarea = sys.malloc(1920)

// dump low rom
sys.poke(-1299460, 16)
for (let i = 0; i < 1920; i++) {
    let byte = sys.peek(-1300607 - i)
    sys.poke(workarea + i, byte)
}

filesystem.open("A", lowfilename, "W")
dma.ramToCom(workarea, filesystem._toPorts("A")[0], 1920)
println("Wrote CHR rom " + lowfilename)

// dump high rom
sys.poke(-1299460, 17)
for (let i = 0; i < 1920; i++) {
    let byte = sys.peek(-1300607 - i)
    sys.poke(workarea + i, byte)
}

filesystem.open("A", highfilename, "W")
dma.ramToCom(workarea, filesystem._toPorts("A")[0], 1920)
println("Wrote CHR rom " + highfilename)

sys.free(workarea)