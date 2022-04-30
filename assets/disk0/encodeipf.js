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

    uint8 [Cg-Top Left | Co-Top Left]
    uint16 [Y1 | Y0 | Y5 | Y4]
    uint8 [Cg-Top Right | Co-Top Right]
    uint16 [Y3 | Y2 | Y7 | Y6]
    uint8 [Cg-Bottom Left | Co-Bottom Left]
    uint16 [Y9 | Y8 | YD | YC]
    uint8 [Cg-Bottom Right | Co-Bottom Right]
    uint16 [YB | YA | YF | YE]
    (total: 96 bytes)

    If has alpha, append following bytes for alpha values
    uint16 [a1 | a0 | a5 | a4]
    uint16 [a3 | a2 | a7 | a6]
    uint16 [a9 | a8 | aD | aC]
    uint16 [aB | aA | aF | aE]
    (total: 160 bytes)



 */

if (!exec_args[2]) {
    printerrln("Usage: entsvmipf input.jpg output.ipf")
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
let hasAlpha = (4 == channels) && configUseAlpha
let blockCount = Math.ceil(imgh / 4.0) * Math.ceil(imgw / 4.0)
let serialisedBlocks = sys.malloc((hasAlpha) ? blockCount * 20 : blockCount * 12)
let blocksWriteCount = 0
for (let blockY = 0; blockY < Math.ceil(imgh / 4.0); blockY++) {
for (let blockX = 0; blockX < Math.ceil(imgw / 4.0); blockx++) {
    let pixelWordOffset = channels * (blockY * 4) * imgw + (blockX * 4)
    let ys = Uint8Array(16)
    let as = Uint8Array(16)
    let cos = Float32Array(16)
    let cgs = Float32Array(16)
    for (let py = 0; py < 4; py++) { for (let px = 0; px < 4; px++) {
        let offset = imageData + pixelWordOffset + 4 * (px + py * imgw)
        let r = sys.peek(offset) / 255.0
        let g = sys.peek(offset+1) / 255.0
        let b = sys.peek(offset+2) / 255.0
        let a = (hasAlpha) ? sys.peek(offset+3) / 255.0 : 1.0

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
    cos1 = Math.round((((cos[0]+cos[1]+cos[4]+cos[5]) / 4.0) + 1) * 15)
    cos2 = Math.round((((cos[2]+cos[3]+cos[6]+cos[7]) / 4.0) + 1) * 15)
    cos3 = Math.round((((cos[8]+cos[9]+cos[12]+cos[13]) / 4.0) + 1) * 15)
    cos4 = Math.round((((cos[10]+cos[11]+cos[14]+cos[15]) / 4.0) + 1) * 15)
    cgs1 = Math.round((((cgs[0]+cgs[1]+cgs[4]+cgs[5]) / 4.0) + 1) * 15)
    cgs2 = Math.round((((cgs[2]+cgs[3]+cgs[6]+cgs[7]) / 4.0) + 1) * 15)
    cgs3 = Math.round((((cgs[8]+cgs[9]+cgs[12]+cgs[13]) / 4.0) + 1) * 15)
    cgs4 = Math.round((((cgs[10]+cgs[11]+cgs[14]+cgs[15]) / 4.0) + 1) * 15)

    // append encoded blocks
    let outBlock = serialisedBlocks + blocksWriteCount

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

        blocksWriteCount += 8
    }
    blocksWriteCount += 12

}}

// TODO open outfile, write header, write serialisedBlocks.gz
