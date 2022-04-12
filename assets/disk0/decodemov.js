
let filename = exec_args[1]
const FBUF_SIZE = 560*448

let status = filesystem.open("A", filename, "R")
if (status) return status

println("Reading...")

let bytes = filesystem.readAllBytes("A")

con.clear()

let readCount = 0

function readBytes(length) {
    let ret = new Int8Array(length)
    for (let k = 0; k < length; k++) {
        ret[k] = bytes[readCount]
        readCount += 1
    }
    return ret
}

function readInt() {
    let b = readBytes(4)
    return (b[0] & 255) | ((b[1] & 255) << 8) | ((b[2] & 255) << 16) | ((b[3] & 255) << 24)
}

function readShort() {
    let b = readBytes(2)
    return (b[0] & 255) | ((b[1] & 255) << 8)
}


let magic = readBytes(8)

if (String.fromCharCode.apply(null, magic) != '\x1fTSVMMOV') return 1

let width = readShort()
let height = readShort()
let fps = readShort()
let frameCount = readInt() % 16777216

let fbuf = sys.malloc(FBUF_SIZE)

for (let f = 0; f < frameCount; f++) {
    let payloadLen = readInt()
    let gzipped = readBytes(payloadLen)
    gzip.decompTo(gzipped, fbuf)
    dma.ramToFrame(fbuf, 0, FBUF_SIZE)
}

sys.free(fbuf)