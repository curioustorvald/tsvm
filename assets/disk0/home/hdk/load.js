if (exec_args[1] === undefined) {
    println("Usage: load myfile.out")
    println("   This will load the binary image onto the Core Memory")
    return 1
}

let infilePath = _G.shell.resolvePathInput(exec_args[1]).full
let infile = files.open(infilePath)

const metaArea = sys.malloc(12)
infile.pread(metaArea, 12, 0)
let intent = sys.peek(metaArea+4) // 2 for executable, 3 for shared
let addrToLoad = (sys.peek(metaArea+5) << 16) | (sys.peek(metaArea+6) << 8) | (sys.peek(metaArea+7))
const imageSize = (sys.peek(metaArea+9) << 16) | (sys.peek(metaArea+10) << 8) | (sys.peek(metaArea+11))
sys.free(metaArea)


if (addrToLoad == 0)
    addrToLoad = sys.malloc(imageSize + 4)
else
    sys.forceAlloc(addrToLoad, imageSize + 4)

// if it's a shared library, put it into the global table
if (3 == intent) {
    // create the table if it's not there
    if (!_G.SO)
        _G.SO = {}

    let libname = infile.path.split("\\").last().substringBeforeLast(".")
    _G.SO[libname] = addrToLoad
}

// writes IMAGE_SIZE and the BINARY_IMAGE directly to the memory
infile.pread(addrToLoad, imageSize + 4, 8)
infile.close()

// write magic 0xA5 to the beginning of the image area
sys.poke(addrToLoad, 0xA5)

println(addrToLoad.toString(16).toUpperCase() + "h")
return addrToLoad