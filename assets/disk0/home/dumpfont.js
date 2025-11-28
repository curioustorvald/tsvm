if (!_TVDOS) {
    println("This program can only run on TVDOS")
    return 1
}
if (!exec_args[1]) {
    println("Usage: dumpfont <rom_prefix>")
    println("       e.g. if rom_prefix is 'home/myfont', the output files will be 'home/myfont_low.chr' and 'home/myfont_high.chr'")
    return 1
}

const fullFilePath = _G.shell.resolvePathInput(exec_args[1]).full
let lowfilename = fullFilePath + "_low.chr"
let highfilename = fullFilePath + "_high.chr"

let workarea = sys.malloc(1920)

// dump low rom
sys.poke(-1299460, 16)
for (let i = 0; i < 1920; i++) {
    let byte = sys.peek(-133121 - i)
    sys.poke(workarea + i, byte)
}

const lowfile = files.open(lowfilename)
lowfile.pwrite(workarea, 1920, 0)
println("Wrote CHR rom " + lowfilename)

// dump high rom
sys.poke(-1299460, 17)
for (let i = 0; i < 1920; i++) {
    let byte = sys.peek(-133121 - i)
    sys.poke(workarea + i, byte)
}

const highfile = files.open(highfilename)
highfile.pwrite(workarea, 1920, 0)
println("Wrote CHR rom " + highfilename)

sys.free(workarea)