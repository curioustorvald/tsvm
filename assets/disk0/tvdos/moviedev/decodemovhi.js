
let filename = exec_args[1]

const FBUF_SIZE = 560*448
const MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x4D, 0x4F, 0x56]
const port = filesystem._toPorts("A")[0]

println("Reading...")

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
    println("Not a movie file (MAGIC mismatch)")
    return 1
}


let width = readShort()
let height = readShort()
let fps = readShort(); if (fps == 0) fps = 9999
let frameTime = 1.0 / fps
let frameCount = readInt() % 16777216
let type = readShort()
sys.free(readBytes(12)) // skip 12 bytes
let akku = frameTime
let framesRendered = 0
//serial.println(readCount) // must say 18
//serial.println(`Dim: (${width}x${height}), FPS: ${fps}, Frames: ${frameCount}`)

if (type != 2) {
    printerrln("Not a type 2 mov")
    return 1
}

let fbuf1 = sys.malloc(FBUF_SIZE)
let fbuf2 = sys.malloc(FBUF_SIZE)
graphics.setGraphicsMode(4)

let startTime = sys.nanoTime()
while (framesRendered < frameCount) {
    //serial.println(`Frame #${f+1}`)

    let t1 = sys.nanoTime()

    if (akku >= frameTime) {
        akku -= frameTime

        // plane 1
        let payloadLen1 = readInt()
        let gzippedPtr1 = readBytes(payloadLen1)
        let payloadLen2 = readInt()
        let gzippedPtr2 = readBytes(payloadLen2)

        gzip.decompFromTo(gzippedPtr1, payloadLen1, fbuf1) // should return FBUF_SIZE
        gzip.decompFromTo(gzippedPtr2, payloadLen2, fbuf2) // should return FBUF_SIZE
        dma.ramToFrame(fbuf1, 0, FBUF_SIZE)
        dma.ramToFrame2(fbuf2, 0, FBUF_SIZE)

        sys.free(gzippedPtr1)
        sys.free(gzippedPtr2)


        framesRendered += 1
    }
    sys.sleep(1)

    let t2 = sys.nanoTime()
    akku += (t2 - t1) / 1000000000.0
}
let endTime = sys.nanoTime()

sys.free(fbuf1)
sys.free(fbuf2)

let timeTook = (endTime - startTime) / 1000000000.0

//println(`Actual FPS: ${frameCount / timeTook}`)