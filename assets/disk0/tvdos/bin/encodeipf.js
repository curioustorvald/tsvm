if (exec_args[3] == undefined) {
    println("encodeipf <1/2> <input picture> <output filename> [-noalpha]")
    return 1
}

let noalpha = exec_args[4] != undefined && exec_args[4].toLowerCase() == "-noalpha"

let infile = files.open(_G.shell.resolvePathInput(exec_args[2]).full)
let outfile = files.open(_G.shell.resolvePathInput(exec_args[3]).full)

let ipfType = (exec_args[1]|0) - 1
let encodefun = ([graphics.encodeIpf1, graphics.encodeIpf2])[ipfType]
if (encodefun === undefined) throw Error(`Unknown IPF format: ${exec_args[1]}`)

// read input file
let infilePtr = sys.malloc(infile.size)
infile.pread(infilePtr, infile.size, 0)

// decode input image
const [imgw, imgh, channels, imageDataPtr] = graphics.decodeImage(infilePtr, infile.size) // stored as [R | G | B | (A)]
sys.free(infilePtr)
let hasAlpha = (4 == channels) && !noalpha

// encode image
let ipfBlockCount = Math.ceil(imgw / 4.0) * Math.ceil(imgh / 4.0)
let ipfSizePerBlock = 12 + 4*(ipfType) + 8*hasAlpha
let ipfRawSize = ipfSizePerBlock * ipfBlockCount
let ipfarea = sys.malloc(ipfRawSize)
let gzippedImage = sys.malloc(28 + ipfRawSize+8) // ipf file header + somewhat arbitrary number. Get the actual count using 28+gzlen
encodefun(imageDataPtr, ipfarea, imgw, imgh, channels, hasAlpha, 0)
let gzlen = gzip.compFromTo(ipfarea, ipfRawSize, gzippedImage + 28)


sys.free(ipfarea)

// write to the output bin
//// write header
;[
    0x1F, 0x54, 0x53, 0x56, 0x4D, 0x69, 0x50, 0x46, // magic
    imgw & 255, (imgw >> 8) & 255, // width
    imgh & 255, (imgh >> 8) & 255, // height
    0+hasAlpha, // has alpha
    ipfType, // ipf type
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // reserved
    (gzlen >>> 0) & 255, // uncompressed size
    (gzlen >>> 8) & 255,
    (gzlen >>> 16) & 255,
    (gzlen >>> 24) & 255
].forEach((b,i) => sys.poke(gzippedImage + i, b))

outfile.mkFile()
outfile.pwrite(gzippedImage, 28 + gzlen, 0)
//dma.ramToCom(writeBuf, 0, writeCount)
sys.free(gzippedImage)
println(`Wrote ${28 + gzlen} bytes to the file`)