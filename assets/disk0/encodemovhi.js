
const FBUF_SIZE = 560*448
let infile = sys.malloc(120000) // somewhat arbitrary
let imagearea = sys.malloc(FBUF_SIZE*3)
let decodearea1 = sys.malloc(FBUF_SIZE)
let decodearea2 = sys.malloc(FBUF_SIZE)
let gzippedImage1 = sys.malloc(180000) // somewhat arbitrary
let gzippedImage2 = sys.malloc(180000) // somewhat arbitrary

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
    0x02, 0x00, // type 2 frames
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // reserved
]

filesystem.open("A", outfilename, "W")
filesystem.writeBytes("A", headerBytes)

for (let f = 1; f <=52; f++) {
    let fname = `/movtestimg/${(''+f).padStart(3,'0')}.jpg`
    filesystem.open("A", fname, "R")
    let fileLen = filesystem.getFileLen("A")
    dma.comToRam(0, 0, infile, fileLen)

    graphics.decodeImageTo(infile, fileLen, imagearea)

    print(`Encoding frame ${f}...`)

    graphics.imageToDirectCol(imagearea, decodearea1, decodearea2, 560, 448, 3, f)

    let gzlen1 = gzip.compFromTo(decodearea1, FBUF_SIZE, gzippedImage1)
    let gzlen2 = gzip.compFromTo(decodearea2, FBUF_SIZE, gzippedImage2)

    let frameSize1 = [
        (gzlen1 >>> 0) & 255,
        (gzlen1 >>> 8) & 255,
        (gzlen1 >>> 16) & 255,
        (gzlen1 >>> 24) & 255
    ]
    let frameSize2 = [
        (gzlen2 >>> 0) & 255,
        (gzlen2 >>> 8) & 255,
        (gzlen2 >>> 16) & 255,
        (gzlen2 >>> 24) & 255
    ]

    appendToOutfile(frameSize1)
    appendToOutfilePtr(gzippedImage1, gzlen1)

    appendToOutfile(frameSize2)
    appendToOutfilePtr(gzippedImage2, gzlen2)

    print(` ${gzlen1 + gzlen2} bytes\n`)
}

sys.free(infile)
sys.free(imagearea)
sys.free(decodearea1)
sys.free(decodearea2)
sys.free(gzippedImage1)
sys.free(gzippedImage2)