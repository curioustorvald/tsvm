
const FBUF_SIZE = 560*448
let infile = sys.malloc(120000) // somewhat arbitrary

let outfilename = exec_args[1]

if (!outfilename) return 1

function appendToOutfile(bytes) {
    filesystem.open("A", outfilename, "A")
    filesystem.writeBytes("A", bytes)
}

function appendToOutfilePtr(ptr, len) {
    filesystem.open("A", outfilename, "A")
    dma.ramToCom(ptr, 0, len)
}

// write header to the file
let headerBytes = [
    0x1F, 0x54, 0x53, 0x56, 0x4D, 0x4D, 0x4F, 0x56, // magic
    0x30, 0x02, // width (560)
    0xC0, 0x01, // height (448)
    0x1E, 0x00, // FPS (30)
    0x34, 0x00, 0x00, 0x00, // frame count (52)
    0x10, 0x00, // type 16 frames
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // reserved
]

filesystem.open("A", outfilename, "W")
filesystem.writeBytes("A", headerBytes)

for (let f = 1; f <=52; f++) {
    let fname = `/movtestimg/${(''+f).padStart(3,'0')}.jpg`
    filesystem.open("A", fname, "R")
    let fileLen = filesystem.getFileLen("A")
    dma.comToRam(0, 0, infile, fileLen)


    print(`Encoding frame ${f}...`)

    let frameSize = [
        (fileLen >>> 0) & 255,
        (fileLen >>> 8) & 255,
        (fileLen >>> 16) & 255,
        (fileLen >>> 24) & 255
    ]

    appendToOutfile(frameSize)
    appendToOutfilePtr(infile, fileLen)

    print(` ${fileLen} bytes\n`)
}

sys.free(infile)
