// this program will serve as a step towards the ADPCM decoding, and tests if RIFF data are successfully decoded.


let filename = exec_args[1]
const port = _TVDOS.DRV.FS.SERIAL._toPorts("A")[0]
function printdbg(s) {
    if (0) serial.println(s)
}


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
    if (length <= 0) return
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

function readFourCC() {
    let b = readBytes(4)
    let s = String.fromCharCode(sys.peek(b), sys.peek(b+1), sys.peek(b+2), sys.peek(b+3))
    sys.free(b)
    return s
}

function readString(length) {
    let b = readBytes(length)
    let s = ""
    for (let k = 0; k < length; k++) {
        s += String.fromCharCode(sys.peek(b + k))
    }
    sys.free(b)
    return s
}

function discardBytes(n) {
    let b = readBytes(n)
    if (b !== undefined) sys.free(b)
}



function printComments() {
    for (const [key, value] of Object.entries(comments)) {
        printdbg(`${key}: ${value}`)
    }
}


// decode header
if (readFourCC() != "RIFF") {
    throw Error("File not RIFF")
}

const FILE_SIZE = readInt() // size from "WAVEfmt"

if (readFourCC() != "WAVE") {
    throw Error("File is RIFF but not WAVE")
}

let BLOCK_SIZE = 0
let INFILE_BLOCK_SIZE = 0
const QUEUE_MAX = 4 // according to the spec

let pcmType;
let nChannels;
let samplingRate;
let blockSize;
let bitsPerSample;
let comments = {};

let readPtr = undefined
let decodePtr = undefined

function checkIfPlayable() {
    if (pcmType != 1) return `PCM Type not LPCM (${pcmType})`
    if (nChannels != 2) return `Audio not stereo but instead has ${nChannels} channels`
    if (samplingRate != 30000) return `Sampling rate is not 30000: ${samplingRate}`
    return "playable!"
}
function decodeInfilePcm(inPtr, outPtr, inputLen) {
    // LPCM
    if (1 == pcmType) {
        let bytes = bitsPerSample / 8
        if (2 == bytes) {
            for (let k = 0; k < inputLen / 2; k++) {
                let s8 = sys.peek(inPtr + k*2 + 1) & 255
                let u8 = s8 + 128
                sys.poke(outPtr + k, u8)
            }

            return inputLen / 2
        }
        else {
            throw Error(`24-bit or 32-bit PCM not supported (bits per sample: ${bitsPerSample})`)
        }
    }
    else {
        throw Error(`PCM Type not LPCM or ADPCM (${pcmType})`)
    }
}
// read chunks loop
while (readCount < FILE_SIZE - 8) {
    let chunkName = readFourCC()
    let chunkSize = readInt()
    printdbg(`Reading '${chunkName}' at ${readCount - 8}`)

    // here be lotsa if-else
    if ("fmt " == chunkName) {
        pcmType = readShort()
        nChannels = readShort()
        samplingRate = readInt()
        discardBytes(4)
        blockSize = readShort()
        bitsPerSample = readShort()
        discardBytes(chunkSize - 16)

        // define BLOCK_SIZE as integer multiple of blockSize
        while (BLOCK_SIZE < 4096) {
            BLOCK_SIZE += blockSize
        }

        INFILE_BLOCK_SIZE = BLOCK_SIZE * bitsPerSample / 8

        printdbg(`BLOCK_SIZE=${BLOCK_SIZE}, INFILE_BLOCK_SIZE=${INFILE_BLOCK_SIZE}`)
    }
    else if ("LIST" == chunkName) {
        let startOffset = readCount
        let subChunkName = readFourCC()
        while (readCount < startOffset + chunkSize) {
            printdbg(`${chunkName} ${subChunkName}`)
            if ("INFO" == subChunkName) {
                let key = readFourCC()
                let valueLen = readInt()
                let value = readString(valueLen)
                comments[key] = value
            }
            else {
                discardBytes(startOffset + chunkSize - readCount)
            }
        }
        printComments()
    }
    else if ("data" == chunkName) {
        let startOffset = readCount

        printdbg(`WAVE size: ${chunkSize}, startOffset=${startOffset}`)
        // check if the format is actually playable
        let unplayableReason  = checkIfPlayable()
        if (unplayableReason != "playable!") throw Error("WAVE not playable: "+unplayableReason)

        readPtr = sys.malloc(BLOCK_SIZE * bitsPerSample / 8)
        decodePtr = sys.malloc(BLOCK_SIZE)

        audio.resetParams(0)
        audio.purgeQueue(0)
        audio.setPcmMode(0)
        audio.setMasterVolume(0, 255)

        let readLength = 1
        while (readCount < startOffset + chunkSize && readLength > 0) {
            let queueSize = audio.getPosition(0)
            if (queueSize <= 1) {
                // upload four samples for lag-safely
                for (let repeat = QUEUE_MAX - queueSize; repeat > 0; repeat--) {
                    let remainingBytes = FILE_SIZE - 8 - readCount

                    readLength = (remainingBytes < INFILE_BLOCK_SIZE) ? remainingBytes : INFILE_BLOCK_SIZE
                    if (readLength <= 0) {
                        printdbg(`readLength = ${readLength}`)
                        break
                    }

                    printdbg(`offset: ${readCount}/${FILE_SIZE + 8}; readLength: ${readLength}`)

                    readBytes(readLength, readPtr)

                    let decodedSampleCount = decodeInfilePcm(readPtr, decodePtr, readLength)
                    printdbg(`        decodedSampleCount: ${decodedSampleCount}`)

                    audio.putPcmDataByPtr(decodePtr, decodedSampleCount, 0)
                    audio.setSampleUploadLength(0, decodedSampleCount)
                    audio.startSampleUpload(0)

                    if (repeat > 1) sys.sleep(10)
                }

                audio.play(0)
            }

            let remainingBytes = FILE_SIZE - 8 - readCount
            printdbg(`readLength = ${readLength}; remainingBytes2 = ${remainingBytes}; readCount = ${readCount}; startOffset + chunkSize = ${startOffset + chunkSize}`)
            sys.spin()

            sys.sleep(10)
        }
    }
    else {
        discardBytes(chunkSize)
    }


    let remainingBytes = FILE_SIZE - 8 - readCount
    printdbg(`remainingBytes2 = ${remainingBytes}`)
    sys.spin()
}

audio.stop(0)
if (readPtr !== undefined) sys.free(readPtr)
if (decodePtr !== undefined) sys.free(decodePtr)