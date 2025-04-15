// some manual config shits
let TOTAL_FRAMES = 3813
let FPS = 30
let WIDTH = 560
let HEIGHT = 448
let PATHFUN = (i) => `/ddol/${(''+i).padStart(5,'0')}.png`

if (WIDTH % 4 != 0 || HEIGHT % 4 != 0) {
    printerrln(`Frame dimension is not multiple of 4 (${WIDTH}x${HEIGHT})`)
    return 5
}

const FBUF_SIZE = WIDTH * HEIGHT
let infile = sys.malloc(512000) // somewhat arbitrary
let imagearea = sys.malloc(FBUF_SIZE*3)
let decodearea = sys.malloc(FBUF_SIZE)
let ipfarea1 = sys.malloc(FBUF_SIZE)
let ipfarea2 = sys.malloc(FBUF_SIZE)
let ipfDelta = sys.malloc(FBUF_SIZE)
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

let ipfAreaOld = ipfarea2
let ipfAreaNew = ipfarea1


for (let f = 1; f <= TOTAL_FRAMES; f++) {
    let fname = PATHFUN(f)
    filesystem.open("A", fname, "R")
    let fileLen = filesystem.getFileLen("A")
    dma.comToRam(0, 0, infile, fileLen)

    let [_1, _2, channels, _3] = graphics.decodeImageTo(infile, fileLen, imagearea)

    const val IPF_BLOCK_SIZE = (channels == 3) ? 12 : 20;

    print(`Frame ${f}/${TOTAL_FRAMES} (Ch: ${channels}) ->`)

//    graphics.imageToDisplayableFormat(imagearea, decodearea, 560, 448, 3, 1)
    graphics.encodeIpf1(imagearea, ipfAreaNew, WIDTH, HEIGHT, channels, false, 0)

    // get the difference map
    let patchEncodedSize = graphics.encodeIpf1d(ipfAreaOld, ipfAreaNew, ipfDelta, WIDTH, HEIGHT, 0.90)

    // decide whether or not the patch encoding should be used
    let gzlen = gzip.compFromTo(
        (patchEncodedSize) ? ipfDelta : ipfAreaNew,
        patchEncodedSize || FBUF_SIZE,
        gzippedImage
    )
    let frameSize = [
        (gzlen >>> 0) & 255,
        (gzlen >>> 8) & 255,
        (gzlen >>> 16) & 255,
        (gzlen >>> 24) & 255
    ]
    appendToOutfile(frameSize)
    appendToOutfilePtr(gzippedImage, gzlen)

    print(` ${gzlen} bytes\n`)

    // swap two pointers
    let t = ipfAreaOld
    ipfAreaOld = ipfAreaNew
    ipfAreaNew = t
}

sys.free(infile)
sys.free(imagearea)
sys.free(decodearea)
sys.free(ipfarea1)
sys.free(ipfarea2)
sys.free(ipfDelta)
sys.free(gzippedImage)