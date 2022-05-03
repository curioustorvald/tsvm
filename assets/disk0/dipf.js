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
let ipfType = readByte()
sys.free(readBytes(9)) // skip 10 bytes

graphics.setGraphicsMode(4)

let infile =
    (0 == ipfType) ? readBytes((imgw * imgh / 16) * ((hasAlpha) ? 20 : 12)) :
    (3 == ipfType) ? readBytes((imgw * imgh / 16) * ((hasAlpha) ? 24 : 16)) : null

if (null == infile) {
    printerrln("Unsupported IPF configuration: "+ipfType)
    sys.free(infile)
    return 1
}

if (0 == ipfType)
    graphics.decodeIpf1(infile, -1048577, -1310721, imgw, imgh, hasAlpha)
else if (3 == ipfType)
    graphics.decodeIpf2(infile, -1048577, -1310721, imgw, imgh, hasAlpha)

sys.free(infile)