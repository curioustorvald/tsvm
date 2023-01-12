// usage: playwav audiofile.wav [/i]
let filename = _G.shell.resolvePathInput(exec_args[1]).full
function printdbg(s) { if (0) serial.println(s) }

const interactive = exec_args[2] && exec_args[2].toLowerCase() == "/i"
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
let byterate;
let comments = {};
let adpcmSamplesPerBlock;
let readPtr = undefined
let decodePtr = undefined

function bytesToSec(i) {
    if (adpcmSamplesPerBlock) {
        let newByteRate = samplingRate
        let generatedSamples = i / blockSize * adpcmSamplesPerBlock
        return generatedSamples / newByteRate
    }
    else {
        return i / byterate
    }
}
function secToReadable(n) {
    let mins = ''+((n/60)|0)
    let secs = ''+(n % 60)
    return `${mins.padStart(2,'0')}:${secs.padStart(2,'0')}`
}
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
let stopPlay = false
con.curs_set(0)
if (interactive) {
    println("Push and hold Backspace to exit")
}
let [cy, cx] = con.getyx()
let [__, CONSOLE_WIDTH] = con.getmaxyx()
let paintWidth = CONSOLE_WIDTH - 16
function printPlayBar(startOffset) {
    if (interactive) {
        let currently = seqread.getReadCount() - startOffset
        let total = FILE_SIZE - startOffset - 8

        let currentlySec = Math.round(bytesToSec(currently))
        let totalSec = Math.round(bytesToSec(total))

        con.move(cy, 1)
        print(' '.repeat(15))
        con.move(cy, 1)

        print(`${secToReadable(currentlySec)} / ${secToReadable(totalSec)}`)

        con.move(cy, 15)
        print(' ')
        let progressbar = '\x84205u'.repeat(paintWidth + 1)
        print(progressbar)

        con.mvaddch(cy, 16 + Math.round(paintWidth * (currently / total)), 0xDB)
    }
}
// read chunks loop
while (!stopPlay && seqread.getReadCount() < FILE_SIZE - 8) {
    let chunkName = seqread.readFourCC()
    let chunkSize = seqread.readInt()
    printdbg(`Reading '${chunkName}' at ${seqread.getReadCount() - 8}`)

    // here be lotsa if-else
    if ("fmt " == chunkName) {
        pcmType = seqread.readShort()
        nChannels = seqread.readShort()
        samplingRate = seqread.readInt()
        byterate = seqread.readInt()
        blockSize = seqread.readShort()
        bitsPerSample = seqread.readShort()
        if (pcmType != 2) {
            seqread.skip(chunkSize - 16)
        }
        else {
            seqread.skip(2)
            adpcmSamplesPerBlock = seqread.readShort()
            seqread.skip(chunkSize - (16 + 4))
        }

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
        while (!stopPlay && seqread.getReadCount() < startOffset + chunkSize && readLength > 0) {
            if (interactive) {
                sys.poke(-40, 1)
                if (sys.peek(-41) == 67) {
                    stopPlay = true
                }
            }


            let queueSize = audio.getPosition(0)
            if (queueSize <= 1) {

                printPlayBar(startOffset)

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

                    printPlayBar(startOffset)
                }

                audio.play(0)
            }

            let remainingBytes = FILE_SIZE - 8 - seqread.getReadCount()
            printdbg(`readLength = ${readLength}; remainingBytes2 = ${remainingBytes}; seqread.getReadCount() = ${seqread.getReadCount()}; startOffset + chunkSize = ${startOffset + chunkSize}`)


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
