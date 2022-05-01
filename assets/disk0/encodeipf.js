/*
TSVM Interchangeable Picture Format

Image is divided into 4x4 blocks and each block is serialised, then the entire file is gzipped


# File Structure
\x1F T S V M i P F
[HEADER]
[Blocks.gz]

- Header
    uint16 WIDTH
    uint16 HEIGHT
    uint16 HAS ALPHA
    byte[10] RESERVED

- *.gz
    uint32 UNCOMPRESSED SIZE
    *      PAYLOAD

- Blocks
    4x4 pixels are sampled, then divided into YCoCg planes.
    CoCg planes are "chroma subsampled" by 4:2:0, then quantised to 4 bits (8 bits for CoCg combined)
    Y plane is quantised to 4 bits

    By doing so, CoCg planes will reduce to 4 pixels
    For the description of packing, pixels in Y plane will be numbered as:
        0 1 2 3
        4 5 6 7
        8 9 A B
        C D E F

    Bits are packed like so:

    uint32 SUBSAMPLING MASK (unimplemented; dont write this)
    uint8 [Cg-Top Left | Co-Top Left]
    uint16 [Y1 | Y0 | Y5 | Y4]
    uint8 [Cg-Top Right | Co-Top Right]
    uint16 [Y3 | Y2 | Y7 | Y6]
    uint8 [Cg-Bottom Left | Co-Bottom Left]
    uint16 [Y9 | Y8 | YD | YC]
    uint8 [Cg-Bottom Right | Co-Bottom Right]
    uint16 [YB | YA | YF | YE]
    (total: 16 bytes)

    If has alpha, append following bytes for alpha values
    uint16 [a1 | a0 | a5 | a4]
    uint16 [a3 | a2 | a7 | a6]
    uint16 [a9 | a8 | aD | aC]
    uint16 [aB | aA | aF | aE]
    (total: 24 bytes)

    Subsampling mask:

    Least significant byte for top-left, most significant for bottom-right
    For example, this default pattern

    00 00 01 01
    00 00 01 01
    10 10 11 11
    10 10 11 11

    turns into:

    01010000 -> 0x30
    01010000 -> 0x30
    11111010 -> 0xFA
    11111010 -> 0xFA

    which packs into: [ 30 | 30 | FA | FA ] (because little endian)

 */

if (!exec_args[2]) {
    printerrln("Usage: encodeipf input.jpg output.ipf")
    return 1
}

let configUseAlpha = true

filesystem.open("A", exec_args[1], "R")

let status = com.getStatusCode(0)
let infile = undefined
if (0 != status) return status

// read file
let fileLen = filesystem.getFileLen("A")
infile = sys.malloc(fileLen)
dma.comToRam(0, 0, infile, fileLen)

// decode
const [imgw, imgh, imageData, channels] = graphics.decodeImage(infile, fileLen) // stored as [R | G | B | (A)]
sys.free(infile)
let hasAlpha = (4 == channels) && configUseAlpha
let outBlock = sys.malloc(64)
let blockSize = Math.ceil(imgh / 4.0) * Math.ceil(imgw / 4.0)
let blockWidth = Math.ceil(imgw / 4.0)

println(`Dim: ${imgw}x${imgh}, channels: ${channels}, Has alpha: ${hasAlpha}`)

// TODO write output to dedicated ptr and gzip it
let writeCount = 0
let writeBuf = sys.malloc(blockSize * ((hasAlpha) ? 20 : 12))

function chromaToFourBits(f) {
    let r = Math.round(f * 8) + 7
    return (r < 0) ? 0 : (r > 15) ? 15 : r
}

for (let blockY = 0; blockY < Math.ceil(imgh / 4.0); blockY++) {
for (let blockX = 0; blockX < Math.ceil(imgw / 4.0); blockX++) {
//    println(`Encoding block ${1 + blockY * blockWidth + blockX}/${blockSize}`) // print statement is making things slower...

    let ys = new Uint8Array(16)
    let as = new Uint8Array(16)
    let cos = new Float32Array(16)
    let cgs = new Float32Array(16)

    // TODO 4x4 bayer dither

    for (let py = 0; py < 4; py++) { for (let px = 0; px < 4; px++) {
        // TODO oob-check
        let ox = blockX * 4 + px
        let oy = blockY * 4 + py
        let offset = channels * (oy * imgw + ox)

        let r = sys.peek(imageData + offset) / 255.0
        let g = sys.peek(imageData + offset+1) / 255.0
        let b = sys.peek(imageData + offset+2) / 255.0
        let a = (hasAlpha) ? sys.peek(imageData + offset+3) / 255.0 : 1.0

        let co = r - b // [-1..1]
        let tmp = b + co / 2.0
        let cg = g - tmp // [-1..1]
        let y = tmp + cg / 2.0 // [0..1]

        let index = py * 4 + px
        ys[index] = Math.round(y * 15)
        as[index] = Math.round(a * 15)
        cos[index] = co
        cgs[index] = cg
    }}

    // subsample by averaging
    let cos1 = chromaToFourBits((cos[0]+cos[1]+cos[4]+cos[5]) / 4.0)
    let cos2 = chromaToFourBits((cos[2]+cos[3]+cos[6]+cos[7]) / 4.0)
    let cos3 = chromaToFourBits((cos[8]+cos[9]+cos[12]+cos[13]) / 4.0)
    let cos4 = chromaToFourBits((cos[10]+cos[11]+cos[14]+cos[15]) / 4.0)
    let cgs1 = chromaToFourBits((cgs[0]+cgs[1]+cgs[4]+cgs[5]) / 4.0)
    let cgs2 = chromaToFourBits((cgs[2]+cgs[3]+cgs[6]+cgs[7]) / 4.0)
    let cgs3 = chromaToFourBits((cgs[8]+cgs[9]+cgs[12]+cgs[13]) / 4.0)
    let cgs4 = chromaToFourBits((cgs[10]+cgs[11]+cgs[14]+cgs[15]) / 4.0)

    // append encoded blocks to the file
    let outBlock = writeBuf + writeCount

    sys.poke(outBlock+ 0, (cgs1 << 4) | cos1)
    sys.poke(outBlock+ 1, (ys[1] << 4) | ys[0])
    sys.poke(outBlock+ 2, (ys[5] << 4) | ys[4])
    sys.poke(outBlock+ 3, (cgs2 << 4) | cos2)
    sys.poke(outBlock+ 4, (ys[3] << 4) | ys[2])
    sys.poke(outBlock+ 5, (ys[7] << 4) | ys[6])
    sys.poke(outBlock+ 6, (cgs3 << 4) | cos3)
    sys.poke(outBlock+ 7, (ys[9] << 4) | ys[8])
    sys.poke(outBlock+ 8, (ys[13] << 4) | ys[12])
    sys.poke(outBlock+ 9, (cgs4 << 4) | cos4)
    sys.poke(outBlock+10, (ys[11] << 4) | ys[10])
    sys.poke(outBlock+11, (ys[15] << 4) | ys[14])

    if (hasAlpha) {
        sys.poke(outBlock+12, (as[1] << 4) | as[0])
        sys.poke(outBlock+13, (as[5] << 4) | as[4])
        sys.poke(outBlock+14, (as[3] << 4) | as[2])
        sys.poke(outBlock+15, (as[7] << 4) | as[6])
        sys.poke(outBlock+16, (as[9] << 4) | as[8])
        sys.poke(outBlock+17, (as[13] << 4) | as[12])
        sys.poke(outBlock+18, (as[11] << 4) | as[10])
        sys.poke(outBlock+19, (as[15] << 4) | as[14])
        writeCount += 8
    }
    writeCount += 12

}}

// write header to the output file
let headerBytes = [
    0x1F, 0x54, 0x53, 0x56, 0x4D, 0x69, 0x50, 0x46, // magic
    imgw & 255, (imgw >>> 8) & 255, // width
    imgh & 255, (imgh >>> 8) & 255, // height
    ((hasAlpha) ? 1 : 0), 0x00, // has alpha
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // reserved
]

filesystem.open("A", exec_args[2], "W")
filesystem.writeBytes("A", headerBytes)
filesystem.open("A", exec_args[2], "A")
dma.ramToCom(writeBuf, 0, writeCount)

sys.free(outBlock)
sys.free(imageData)
sys.free(writeBuf)