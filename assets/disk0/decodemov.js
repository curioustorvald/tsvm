
let filename = exec_args[1]

const FBUF_SIZE = 560*448
const MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x4D, 0x4F, 0x56]

let status = filesystem.open("A", filename, "R")
if (status) return status

println("Reading...")

//let bytes = filesystem.readAllBytes("A")

con.clear()

let readCount = 0

function readBytes(length) {
    /*let ret = new Int8Array(length)
    for (let k = 0; k < length; k++) {
        ret[k] = bytes[readCount]
        readCount += 1
    }
    return ret*/

    let ptr = sys.malloc(length)
    let requiredBlocks = (readCount == 0) + Math.floor((readCount + length) / 4096) - Math.floor(readCount / 4096)
    let port = filesystem._toPorts("A")

    let completedReads = 0

    for (let bc = 0; bc < requiredBlocks; bc++) {
        if (readCount % 4096 == 0) {
            com.sendMessage(port[0], "READ")
            let thisBlockLen = com.fetchResponse(port[0]) // [0, 4095]
            let remaining = Math.min(4096, length - completedReads)

            // copy from read buffer to designated position
            sys.memcpy(-4097, ptr + readCount, remaining)

            // increment readCount properly
            readCount += remaining
            completedReads += remaining
        }
        else {
            let padding = 4096 - (readCount % 4096)
            let remaining = Math.min(padding, length - completedReads)

            // copy from read buffer to designated position
            sys.memcpy(-4097 - padding, ptr + readCount, remaining)

            // increment readCount properly
            readCount += remaining
            completedReads += remaining
        }
    }

    return ptr
}

function readInt() {
    let b = readBytes(4)
    let i = (sys.peek(b) & 255) | ((sys.peek(b+1) & 255) << 8) | ((sys.peek(b+2) & 255) << 16) | ((sys.peek(b+3) & 255) << 24)
    sys.free(b)
    return i
}

function readShort() {
    let b = readBytes(2)
    let i = (sys.peek(b) & 255) | ((sys.peek(b+1) & 255) << 8)
    sys.free(b)
    return i
}


let magic = readBytes(8)

// check if magic number matches
MAGIC.forEach((b,i) => {
    if (sys.peek(magic + i) & 255 != b) return 1
})
sys.free(magic)


let width = readShort()
let height = readShort()
let fps = readShort()
let frameCount = readInt() % 16777216

serial.println(`Dim: (${width}x${height}), FPS: ${fps}, Frames: ${frameCount}`)

let fbuf = sys.malloc(FBUF_SIZE)

for (let f = 0; f < frameCount; f++) {
    serial.println(`Frame #${f+1}`)

    let payloadLen = readInt()
    let gzippedPtr = readBytes(payloadLen)

    gzip.decompFromTo(gzippedPtr, payloadLen, fbuf) // should return FBUF_SIZE

    dma.ramToFrame(fbuf, 0, FBUF_SIZE)
    sys.free(gzippedPtr)
}

sys.free(fbuf)