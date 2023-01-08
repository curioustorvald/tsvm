// this program will serve as a step towards the ADPCM decoding, and tests if RIFF data are successfully decoded.

let filename = _G.shell.resolvePathInput(exec_args[1]).full
function printdbg(s) { if (0) serial.println(s) }

const seqread = require("seqread")
const pcm = require("pcm")



function printComments() {
    for (const [key, value] of Object.entries(comments)) {
        printdbg(`${key}: ${value}`)
    }
}

function GCD(a, b) {
    a = Math.abs(a)
    b = Math.abs(b)
    if (b > a) {var temp = a; a = b; b = temp}
    while (true) {
        if (b == 0) return a
        a %= b
        if (a == 0) return b
        b %= a
    }
}

function LCM(a, b) {
    return (!a || !b) ? 0 : Math.abs((a * b) / GCD(a, b))
}



//println("Reading...")
//serial.println("!!! READING")

seqread.prepare(filename)




// decode header
if (seqread.readFourCC() != "RIFF") {
    throw Error("File not RIFF")
}

const FILE_SIZE = seqread.readInt() // size from "WAVEfmt"

if (seqread.readFourCC() != "WAVE") {
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
    if (pcmType != 1 && pcmType != 2) return `PCM Type not LPCM/ADPCM (${pcmType})`
    if (nChannels < 1 || nChannels > 2) return `Audio not mono/stereo but instead has ${nChannels} channels`
    if (pcmType != 1 && samplingRate != pcm.HW_SAMPLING_RATE) return `Format is ADPCM but sampling rate is not ${pcm.HW_SAMPLING_RATE}: ${samplingRate}`
    return "playable!"
}
// @return decoded sample length (not count!)
function decodeInfilePcm(inPtr, outPtr, inputLen) {
    // LPCM
    if (1 == pcmType)
        return pcm.decodeLPCM(inPtr, outPtr, inputLen, { nChannels, bitsPerSample, samplingRate, blockSize })
    else if (2 == pcmType)
        return pcm.decodeMS_ADPCM(inPtr, outPtr, inputLen, { nChannels })
    else
        throw Error(`PCM Type not LPCM or ADPCM (${pcmType})`)
}
// read chunks loop
while (seqread.getReadCount() < FILE_SIZE - 8) {
    let chunkName = seqread.readFourCC()
    let chunkSize = seqread.readInt()
    printdbg(`Reading '${chunkName}' at ${seqread.getReadCount() - 8}`)

    // here be lotsa if-else
    if ("fmt " == chunkName) {
        pcmType = seqread.readShort()
        nChannels = seqread.readShort()
        samplingRate = seqread.readInt()
        seqread.skip(4)
        blockSize = seqread.readShort()
        bitsPerSample = seqread.readShort()
        seqread.skip(chunkSize - 16)

        // define BLOCK_SIZE as integer multiple of blockSize, for LPCM
        // ADPCM will be decoded per-block basis
        if (1 == pcmType) {
            // get GCD of given values; this wll make resampling headache-free
            let blockSizeIncrement = LCM(blockSize, samplingRate / GCD(samplingRate, pcm.HW_SAMPLING_RATE))

            while (BLOCK_SIZE < 4096) {
                BLOCK_SIZE += blockSizeIncrement // for rate 44100, BLOCK_SIZE will be 4116
            }
            INFILE_BLOCK_SIZE = BLOCK_SIZE * bitsPerSample / 8 // for rate 44100, INFILE_BLOCK_SIZE will be 8232
        }
        else if (2 == pcmType) {
            BLOCK_SIZE = blockSize
            INFILE_BLOCK_SIZE = BLOCK_SIZE
        }

        printdbg(`Format: ${pcmType}, Channels: ${nChannels}, Rate: ${samplingRate}, BitDepth: ${bitsPerSample}`)
        printdbg(`BLOCK_SIZE=${BLOCK_SIZE}, INFILE_BLOCK_SIZE=${INFILE_BLOCK_SIZE}`)
    }
    else if ("LIST" == chunkName) {
        let startOffset = seqread.getReadCount()
        let subChunkName = seqread.readFourCC()
        while (seqread.getReadCount() < startOffset + chunkSize) {
            printdbg(`${chunkName} ${subChunkName}`)
            if ("INFO" == subChunkName) {
                let key = seqread.readFourCC()
                let valueLen = seqread.readInt()
                let value = seqread.readString(valueLen)
                comments[key] = value
            }
            else {
                seqread.skip(startOffset + chunkSize - seqread.getReadCount())
            }
        }
        printComments()
    }
    else if ("data" == chunkName) {
        let startOffset = seqread.getReadCount()

        printdbg(`WAVE size: ${chunkSize}, startOffset=${startOffset}`)
        // check if the format is actually playable
        let unplayableReason  = checkIfPlayable()
        if (unplayableReason != "playable!") throw Error("WAVE not playable: "+unplayableReason)

        if (pcmType == 2)
            readPtr = sys.malloc(BLOCK_SIZE)
        else
            readPtr = sys.malloc(BLOCK_SIZE * bitsPerSample / 8)

        decodePtr = sys.malloc(BLOCK_SIZE * pcm.HW_SAMPLING_RATE / samplingRate)

        audio.resetParams(0)
        audio.purgeQueue(0)
        audio.setPcmMode(0)
        audio.setMasterVolume(0, 255)

        let readLength = 1
        while (seqread.getReadCount() < startOffset + chunkSize && readLength > 0) {
            let queueSize = audio.getPosition(0)
            if (queueSize <= 1) {
                // upload four samples for lag-safely
                for (let repeat = QUEUE_MAX - queueSize; repeat > 0; repeat--) {
                    let remainingBytes = FILE_SIZE - 8 - seqread.getReadCount()

                    readLength = (remainingBytes < INFILE_BLOCK_SIZE) ? remainingBytes : INFILE_BLOCK_SIZE
                    if (readLength <= 0) {
                        printdbg(`readLength = ${readLength}`)
                        break
                    }

                    printdbg(`offset: ${seqread.getReadCount()}/${FILE_SIZE + 8}; readLength: ${readLength}`)

                    seqread.readBytes(readLength, readPtr)

                    let decodedSampleLength = decodeInfilePcm(readPtr, decodePtr, readLength)
                    printdbg(`        decodedSampleLength: ${decodedSampleLength}`)

                    audio.putPcmDataByPtr(decodePtr, decodedSampleLength, 0)
                    audio.setSampleUploadLength(0, decodedSampleLength)
                    audio.startSampleUpload(0)

                    if (repeat > 1) sys.sleep(10)
                }

                audio.play(0)
            }

            let remainingBytes = FILE_SIZE - 8 - seqread.getReadCount()
            printdbg(`readLength = ${readLength}; remainingBytes2 = ${remainingBytes}; seqread.getReadCount() = ${seqread.getReadCount()}; startOffset + chunkSize = ${startOffset + chunkSize}`)
            sys.spin()

            sys.sleep(10)
        }
    }
    else {
        seqread.skip(chunkSize)
    }


    let remainingBytes = FILE_SIZE - 8 - seqread.getReadCount()
    printdbg(`remainingBytes2 = ${remainingBytes}`)
    sys.spin()
}

audio.stop(0)
if (readPtr !== undefined) sys.free(readPtr)
if (decodePtr !== undefined) sys.free(decodePtr)
