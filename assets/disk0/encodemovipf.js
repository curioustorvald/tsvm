// some manual config shits
let TOTAL_FRAMES = 3813
let FPS = 30
let WIDTH = 560
let HEIGHT = 448
let PATHFUN = (i) => `/ddol/${(''+i).padStart(5,'0')}.png`


const FBUF_SIZE = WIDTH * HEIGHT
let infile = sys.malloc(512000) // somewhat arbitrary
let imagearea = sys.malloc(FBUF_SIZE*3)
let decodearea = sys.malloc(FBUF_SIZE)
let ipfarea = sys.malloc(FBUF_SIZE)
let gzippedImage = sys.malloc(512000) // somewhat arbitrary

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
    WIDTH & 255, (WIDTH >> 8) & 255, // width
    HEIGHT & 255, (HEIGHT >> 8) & 255, // height
    FPS & 255, (FPS >> 8) & 255, // FPS
    TOTAL_FRAMES & 255, (TOTAL_FRAMES >> 8) & 255, (TOTAL_FRAMES >> 16) & 255, (TOTAL_FRAMES >> 24) & 255, // frame count
    0x04, 0x00, // type 4 frames (force no-alpha)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // reserved
]

filesystem.open("A", outfilename, "W")
filesystem.writeBytes("A", headerBytes)

for (let f = 1; f <= TOTAL_FRAMES; f++) {
    let fname = PATHFUN(f)
    filesystem.open("A", fname, "R")
    let fileLen = filesystem.getFileLen("A")
    dma.comToRam(0, 0, infile, fileLen)

    graphics.decodeImageTo(infile, fileLen, imagearea)

    print(`Encoding frame ${f}...`)

//    graphics.imageToDisplayableFormat(imagearea, decodearea, 560, 448, 3, 1)
    graphics.encodeIpf1(imagearea, ipfarea, WIDTH, HEIGHT, 3, false, f)

    let gzlen = gzip.compFromTo(ipfarea, FBUF_SIZE, gzippedImage)

    let frameSize = [
        (gzlen >>> 0) & 255,
        (gzlen >>> 8) & 255,
        (gzlen >>> 16) & 255,
        (gzlen >>> 24) & 255
    ]

    appendToOutfile(frameSize)
    appendToOutfilePtr(gzippedImage, gzlen)

    print(` ${gzlen} bytes\n`)
}

sys.free(infile)
sys.free(imagearea)
sys.free(decodearea)
sys.free(ipfarea)
sys.free(gzippedImage)