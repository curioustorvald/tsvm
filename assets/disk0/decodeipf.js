if (!exec_args[1]) {
    printerrln("Usage: decodeipf input.ipf")
    return 1
}

let filename = exec_args[1]

const MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x69, 0x50, 0x46]
const port = filesystem._toPorts("A")[0]


com.sendMessage(port, "DEVRST\x17")
com.sendMessage(port, `OPENR"${filename}",1`)
let statusCode = com.getStatusCode(port)

if (statusCode != 0) {
    printerrln(`No such file (${statusCode})`)
    return statusCode
}

com.sendMessage(port, "READ")
statusCode = com.getStatusCode(port)
if (statusCode != 0) {
    printerrln("READ failed with "+statusCode)
    return statusCode
}

con.clear(); con.curs_set(0)

let readCount = 0

function readBytes(length) {
    let ptr = sys.malloc(length)
    let requiredBlocks = Math.floor((readCount + length) / 4096) - Math.floor(readCount / 4096)

    let completedReads = 0

    //serial.println(`readBytes(${length}); readCount = ${readCount}`)

    for (let bc = 0; bc < requiredBlocks + 1; bc++) {
        if (completedReads >= length) break

        if (readCount % 4096 == 0) {
            //serial.println("READ from serial")
            // pull the actual message
            sys.poke(-4093 - port, 6);sys.sleep(0) // spinning is required as Graal run is desynced with the Java side

            let blockTransferStatus = ((sys.peek(-4085 - port*2) & 255) | ((sys.peek(-4086 - port*2) & 255) << 8))
            let thisBlockLen = blockTransferStatus & 4095
            if (thisBlockLen == 0) thisBlockLen = 4096 // [1, 4096]
            let hasMore = (blockTransferStatus & 0x8000 != 0)


            //serial.println(`block: (${thisBlockLen})[${[...Array(thisBlockLen).keys()].map(k => (sys.peek(-4097 - k) & 255).toString(16).padStart(2,'0')).join()}]`)

            let remaining = Math.min(thisBlockLen, length - completedReads)

            //serial.println(`Pulled a block (${thisBlockLen}); readCount = ${readCount}, completedReads = ${completedReads}, remaining = ${remaining}`)

            // copy from read buffer to designated position
            sys.memcpy(-4097, ptr + completedReads, remaining)

            // increment readCount properly
            readCount += remaining
            completedReads += remaining
        }
        else {
            let padding = readCount % 4096
            let remaining = length - completedReads
            let thisBlockLen = Math.min(4096 - padding, length - completedReads)

            //serial.println(`padding = ${padding}; remaining = ${remaining}`)

            //serial.println(`block: (${thisBlockLen})[${[...Array(thisBlockLen).keys()].map(k => (sys.peek(-4097 - padding - k) & 255).toString(16).padStart(2,'0')).join()}]`)

            //serial.println(`Reusing a block (${thisBlockLen}); readCount = ${readCount}, completedReads = ${completedReads}`)

            // copy from read buffer to designated position
            sys.memcpy(-4097 - padding, ptr + completedReads, thisBlockLen)

            // increment readCount properly
            readCount += thisBlockLen
            completedReads += thisBlockLen
        }
    }

    //serial.println(`END readBytes(${length}); readCount = ${readCount}\n`)

    return ptr
}

function readInt() {
    let b = readBytes(4)
    let i = (sys.peek(b) & 255) | ((sys.peek(b+1) & 255) << 8) | ((sys.peek(b+2) & 255) << 16) | ((sys.peek(b+3) & 255) << 24)

    //serial.println(`readInt(); bytes: ${sys.peek(b)}, ${sys.peek(b+1)}, ${sys.peek(b+2)}, ${sys.peek(b+3)} = ${i}\n`)

    sys.free(b)
    return i
}

function readShort() {
    let b = readBytes(2)
    let i = (sys.peek(b) & 255) | ((sys.peek(b+1) & 255) << 8)

    //serial.println(`readShort(); bytes: ${sys.peek(b)}, ${sys.peek(b+1)} = ${i}\n`)

    sys.free(b)
    return i
}

function readByte() {
    let b = readBytes(1)
    let i = (sys.peek(b) & 255)

    //serial.println(`readShort(); bytes: ${sys.peek(b)}, ${sys.peek(b+1)} = ${i}\n`)

    sys.free(b)
    return i
}


let magic = readBytes(8)
let magicMatching = true

// check if magic number matches
MAGIC.forEach((b,i) => {
    let testb = sys.peek(magic + i) & 255 // for some reason this must be located here
    if (testb != b) {
        magicMatching = false
    }
})
sys.free(magic)
if (!magicMatching) {
    println("Not an IPF file (MAGIC mismatch)")
    return 1
}

let imgw = readShort()
let imgh = readShort()
let hasAlpha = (readShort() != 0)
sys.free(readBytes(10)) // skip 10 bytes

// TODO: gzip

function clampRGB(f) {
    return (f > 1.0) ? 1.0 : (f < 0.0) ? 0.0 : f
}

function ycocgToRGB(cocg, ys, as) { // ys: 4 Y-values
    // return [R1|G1, B1|A1, R2|G2, B2|A2, R3|G3, B3|A3, R4|G4, B4|A4]

//    cocg = 0x7777
//    ys = 0x0000

    let co = ((cocg & 15) - 7) / 8
    let cg = (((cocg >>> 4) & 15) - 7) / 8

    let y1 = (ys & 15) / 15.0
    let a1 = as & 15
    let tmp = y1 - cg / 2.0
    let g1 = clampRGB(cg + tmp)
    let b1 = clampRGB(tmp - co / 2.0)
    let r1 = clampRGB(b1 + co)

    let y2 = ((ys >>> 4) & 15) / 15.0
    let a2 = (as >>> 4) & 15
    tmp = y2 - cg / 2.0
    let g2 = clampRGB(cg + tmp)
    let b2 = clampRGB(tmp - co / 2.0)
    let r2 = clampRGB(b2 + co)

    let y3 = ((ys >>> 8) & 15) / 15.0
    let a3 = (as >>> 8) & 15
    tmp = y3 - cg / 2.0
    let g3 = clampRGB(cg + tmp)
    let b3 = clampRGB(tmp - co / 2.0)
    let r3 = clampRGB(b3 + co)

    let y4 = ((ys >>> 12) & 15) / 15.0
    let a4 = (as >>> 12) & 15
    tmp = y4 - cg / 2.0
    let g4 = clampRGB(cg + tmp)
    let b4 = clampRGB(tmp - co / 2.0)
    let r4 = clampRGB(b4 + co)

    return [
        (Math.round(r1 * 15) << 4) | Math.round(g1 * 15),
        (Math.round(b1 * 15) << 4) | a1,
        (Math.round(r2 * 15) << 4) | Math.round(g2 * 15),
        (Math.round(b2 * 15) << 4) | a2,
        (Math.round(r3 * 15) << 4) | Math.round(g3 * 15),
        (Math.round(b3 * 15) << 4) | a3,
        (Math.round(r4 * 15) << 4) | Math.round(g4 * 15),
        (Math.round(b4 * 15) << 4) | a4,
    ]
}

graphics.setGraphicsMode(4)

for (let blockY = 0; blockY < Math.ceil(imgh / 4.0); blockY++) {
for (let blockX = 0; blockX < Math.ceil(imgw / 4.0); blockX++) {
    let rg = new Uint8Array(16) // [R1G1, R2G2, R3G3, R4G4, ...]
    let ba = new Uint8Array(16)

    let cocg1 = readByte()
    let y1 = readShort()
    let cocg2 = readByte()
    let y2 = readShort()
    let cocg3 = readByte()
    let y3 = readShort()
    let cocg4 = readByte()
    let y4 = readShort()

    if (blockX == 0 && blockY == 0) {
        serial.println(`cocg: ${(cocg1 & 15).toString(16)} ${((cocg1 >>> 4) & 15).toString(16)}`)
        serial.println(`y: ${y1.toString(16)}`)
        serial.println(`cocg: ${cocg2.toString(16)}`)
        serial.println(`y: ${y2.toString(16)}`)
        serial.println(`cocg: ${cocg3.toString(16)}`)
        serial.println(`y: ${y3.toString(16)}`)
        serial.println(`cocg: ${cocg4.toString(16)}`)
        serial.println(`y: ${y4.toString(16)}`)
    }

    let a1 = 65535; let a2 = 65535; let a3 = 65535; let a4 = 65535

    if (hasAlpha) {
        a1 = readShort()
        a2 = readShort()
        a3 = readShort()
        a4 = readShort()
    }

    let corner = ycocgToRGB(cocg1, y1, a1)
    rg[0] = corner[0];ba[0] = corner[1]
    rg[1] = corner[2];ba[1] = corner[3]
    rg[4] = corner[4];ba[4] = corner[5]
    rg[5] = corner[6];ba[5] = corner[7]

    corner = ycocgToRGB(cocg2, y2, a2)
    rg[2] = corner[0];ba[2] = corner[1]
    rg[3] = corner[2];ba[3] = corner[3]
    rg[6] = corner[4];ba[6] = corner[5]
    rg[7] = corner[6];ba[7] = corner[7]

    corner = ycocgToRGB(cocg3, y3, a3)
    rg[8] = corner[0];ba[8] = corner[1]
    rg[9] = corner[2];ba[9] = corner[3]
    rg[12] = corner[4];ba[12] = corner[5]
    rg[13] = corner[6];ba[13] = corner[7]

    corner = ycocgToRGB(cocg4, y4, a4)
    rg[10] = corner[0];ba[10] = corner[1]
    rg[11] = corner[2];ba[11] = corner[3]
    rg[14] = corner[4];ba[14] = corner[5]
    rg[15] = corner[6];ba[15] = corner[7]


    // move decoded pixels into memory
    for (let py = 0; py < 4; py++) { for (let px = 0; px < 4; px++) {
        let ox = blockX * 4 + px
        let oy = blockY * 4 + py
        let offset = oy * 560 + ox
        sys.poke(-1048577 - offset, rg[py * 4 + px])
        sys.poke(-1310721 - offset, ba[py * 4 + px])
    }}
}}
