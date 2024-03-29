/*let music = files.open("A:/orstphone-hdma.bytes")
let samples = sys.malloc(65536)
music.pread(samples, 65534)

audio.setPcmMode(0)
audio.setMasterVolume(0, 255)
audio.putPcmDataByPtr(samples, 65534, 0)
audio.setLoopPoint(0, 65534)
audio.play(0)*/

let filename = exec_args[1]
const port = _TVDOS.DRV.FS.SERIAL._toPorts("A")[0]

let filex = files.open(_G.shell.resolvePathInput(filename).full)
const FILE_SIZE = filex.size



//println("Reading...")
//serial.println("!!! READING")

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



let readCount = 0
function readBytes(length, ptrToDecode) {
    let ptr = (ptrToDecode === undefined) ? sys.malloc(length) : ptrToDecode
    let requiredBlocks = Math.floor((readCount + length) / 4096) - Math.floor(readCount / 4096)

    let completedReads = 0

//    serial.println(`readBytes(${length}); readCount = ${readCount}`)

    for (let bc = 0; bc < requiredBlocks + 1; bc++) {
        if (completedReads >= length) break

        if (readCount % 4096 == 0) {
//            serial.println("READ from serial")
            // pull the actual message
            sys.poke(-4093 - port, 6);sys.sleep(0) // spinning is required as Graal run is desynced with the Java side

            let blockTransferStatus = ((sys.peek(-4085 - port*2) & 255) | ((sys.peek(-4086 - port*2) & 255) << 8))
            let thisBlockLen = blockTransferStatus & 4095
            if (thisBlockLen == 0) thisBlockLen = 4096 // [1, 4096]
            let hasMore = (blockTransferStatus & 0x8000 != 0)


//            serial.println(`block: (${thisBlockLen})[${[...Array(thisBlockLen).keys()].map(k => (sys.peek(-4097 - k) & 255).toString(16).padStart(2,'0')).join()}]`)

            let remaining = Math.min(thisBlockLen, length - completedReads)

//            serial.println(`Pulled a block (${thisBlockLen}); readCount = ${readCount}, completedReads = ${completedReads}, remaining = ${remaining}`)

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

//            serial.println(`padding = ${padding}; remaining = ${remaining}`)
//            serial.println(`block: (${thisBlockLen})[${[...Array(thisBlockLen).keys()].map(k => (sys.peek(-4097 - padding - k) & 255).toString(16).padStart(2,'0')).join()}]`)
//            serial.println(`Reusing a block (${thisBlockLen}); readCount = ${readCount}, completedReads = ${completedReads}`)

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

let sampleSize = FILE_SIZE
const BLOCK_SIZE = 4096
const QUEUE_MAX = 4 // according to the spec

audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setMasterVolume(0, 255)

// FIXME: when a playback was interrupted using SHIFT-CTRL-T-R, then re-tried, the ghost from the previous run
//        briefly manifests, even if you're queueing only once

const decodePtr = sys.malloc(BLOCK_SIZE)

while (sampleSize > 0) {
    let queueSize = audio.getPosition(0)

//    serial.println(`[js] Trying to upload samples, queueSize = ${queueSize}`)
    print(".")

    if (queueSize <= 1) {
        serial.println(`[js] Queue size: ${queueSize}; uploading ${QUEUE_MAX - queueSize} samples`)

        println()
        println((FILE_SIZE - sampleSize) / FILE_SIZE * 100 + " %")

        // upload four samples for lag-safely
        for (let repeat = QUEUE_MAX - queueSize; repeat > 0; repeat--) {
            let readLength = (sampleSize < BLOCK_SIZE) ? sampleSize : BLOCK_SIZE
            readBytes(readLength, decodePtr)

            audio.putPcmDataByPtr(decodePtr, readLength, 0)
            audio.setSampleUploadLength(0, readLength)
            audio.startSampleUpload(0)

            sampleSize -= readLength

            if (repeat > 1) sys.sleep(10)
        }

        audio.play(0)
    }

//    audio.setMasterVolume(0, (Math.random()*255)|0)


    sys.sleep(10)
}

//audio.stop(0)
sys.free(decodePtr)
