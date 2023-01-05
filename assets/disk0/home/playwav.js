// this program will serve as a step towards the ADPCM decoding, and tests if RIFF data are successfully decoded.

let HW_SAMPLING_RATE = 30000
let filename = exec_args[1]
const port = _TVDOS.DRV.FS.SERIAL._toPorts("A")[0]
function printdbg(s) {
    if (1) serial.println(s)
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
    let i = (sys.peek(b)) | (sys.peek(b+1) << 8) | (sys.peek(b+2) << 16) | (sys.peek(b+3) << 24)
    sys.free(b)
    return i
}

function readShort() {
    let b = readBytes(2)
    let i = (sys.peek(b)) | (sys.peek(b+1) << 8)
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

function lerp(start, end, x) {
    return (1 - x) * start + x * end
}
function lerpAndRound(start, end, x) {
    return Math.round(lerp(start, end, x))
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

function clampS16(i) { return (i < -32768) ? -32768 : (i > 32767) ? 32767 : i }
const uNybToSnyb = [0,1,2,3,4,5,6,7,-8,-7,-6,-5,-4,-3,-2,-1]
// returns: [unsigned high, unsigned low, signed high, signed low]
function getNybbles(b) { return [b >> 4, b & 15, uNybToSnyb[b >> 4], uNybToSnyb[b & 15]] }
function s16Tou8(i) { return ((i >>> 8)) + 128 }
function u16Tos16(i) { return (i > 32767) ? i - 65536 : i }
function checkIfPlayable() {
    if (pcmType != 1 && pcmType != 2) return `PCM Type not LPCM/ADPCM (${pcmType})`
    if (nChannels != 2) return `Audio not stereo but instead has ${nChannels} channels`
    if (pcmType != 1 && samplingRate != HW_SAMPLING_RATE) return `Format is ADPCM but sampling rate is not ${HW_SAMPLING_RATE}: ${samplingRate}`
    return "playable!"
}
function decodeLPCM(inPtr, outPtr, inputLen) {
    let bytes = bitsPerSample / 8

    if (2 == bytes) {
        if (HW_SAMPLING_RATE == samplingRate) {
            for (let k = 0; k < inputLen / 2; k++) {
                sys.poke(outPtr + k, s16Tou8(sys.peek(inPtr + k*2 + 1)))
            }
            return inputLen / 2
        }
        // resample!
        else {
            // for rate 44100 16 bits, the inputLen will be 8232, if EOF not reached; otherwise pad with zero
            let indexStride = samplingRate / HW_SAMPLING_RATE // note: a sample can span multiple bytes (2 for s16b)
            let indices = (inputLen / indexStride) / nChannels / bytes
            let sample = [
                u16Tos16(sys.peek(inPtr+0) | (sys.peek(inPtr+1) << 8)),
                u16Tos16(sys.peek(inPtr+2) | (sys.peek(inPtr+3) << 8))
            ]

            printdbg(`indices: ${indices}; indexStride = ${indexStride}`)

            // write out first sample
            sys.poke(outPtr+0, s16Tou8(sample[0]))
            sys.poke(outPtr+1, s16Tou8(sample[1]))
            let sendoutLength = 2

            for (let i = 1; i < indices; i++) {
                for (let channel = 0; channel < nChannels; channel++) {
                    let iEnd = i * indexStride // sampleA, sampleB
                    let iA = iEnd|0
                    if (Math.abs((iEnd / iA) - 1.0) < 0.0001) {
                        // iEnd on integer point (no lerp needed)
                        let iR = Math.round(iEnd)
                        sample[channel] = u16Tos16(sys.peek(inPtr + 4*iR + 2*channel) | (sys.peek(inPtr + 4*iR + 2*channel + 1) << 8))
                    }
                    else {
                        // iEnd not on integer point (lerp needed)
                        // sampleA = samples[iEnd|0], sampleB = samples[1 + (iEnd|0)], lerpScale = iEnd - (iEnd|0)
                        // sample = lerp(sampleA, sampleB, lerpScale)
                        let sampleA = u16Tos16(sys.peek(inPtr + 4*iA + 2*channel + 0) | (sys.peek(inPtr + 4*iA + 2*channel + 1) << 8))
                        let sampleB = u16Tos16(sys.peek(inPtr + 4*iA + 2*channel + 4) | (sys.peek(inPtr + 4*iA + 2*channel + 5) << 8))
                        let scale = iEnd - iA
                        sample[channel] = (lerpAndRound(sampleA, sampleB, scale))

                    }
                    // soothing visualiser(????)
                    /*let ls = sample[0].toString(2)
                    if (sample[0] < 0)
                        ls = ls.padStart(16, ' ') + '                '
                    else
                        ls = '                ' + ls.padEnd(16, ' ')

                    let rs = sample[1].toString(2)
                    if (sample[1] < 0)
                        rs = rs.padStart(16, ' ') + '                '
                    else
                        rs = '                ' + rs.padEnd(16, ' ')

                    println(`${ls} | ${rs}`)*/

                    // writeout
                    sys.poke(outPtr + sendoutLength, s16Tou8(sample[channel]))
                    sendoutLength += 1
                }
            }
            // pad with zero (might have lost the last sample of the input audio but whatever)
            for (let k = 0; k < sendoutLength % nChannels; k++) {
                sys.poke(outPtr + sendoutLength, 0)
                sendoutLength += 1
            }
            return sendoutLength // for full chunk, this number should be equal to indices * 2
        }
    }
    else {
        throw Error(`24-bit or 32-bit PCM not supported (bits per sample: ${bitsPerSample})`)
    }
}
// @see https://wiki.multimedia.cx/index.php/Microsoft_ADPCM
// @see https://github.com/Snack-X/node-ms-adpcm/blob/master/index.js
function decodeMS_ADPCM(inPtr, outPtr, blockSize) {
    const adaptationTable = [
      230, 230, 230, 230, 307, 409, 512, 614,
      768, 614, 512, 409, 307, 230, 230, 230
    ]
    const coeff1 = [256, 512, 0, 192, 240, 460, 392]
    const coeff2 = [  0,-256, 0,  64,   0,-208,-232]
    if (2 == nChannels) {
        let predictorL = sys.peek(inPtr + 0)
//        if (predictorL < 0 || predictorR > 6) throw Error(`undefined predictorL ${predictorL}`)
        let coeffL1 = coeff1[predictorL]
        let coeffL2 = coeff2[predictorL]
        let predictorR = sys.peek(inPtr + 1)
//        if (predictorR < 0 || predictorR > 6) throw Error(`undefined predictorR ${predictorR}`)
        let coeffR1 = coeff1[predictorR]
        let coeffR2 = coeff2[predictorR]
        let deltaL = sys.peek(inPtr + 2) | (sys.peek(inPtr + 3) << 8)
        let deltaR = sys.peek(inPtr + 4) | (sys.peek(inPtr + 5) << 8)
        // write initial two samples
        let samL1 = u16Tos16(sys.peek(inPtr + 6) | (sys.peek(inPtr + 7) << 8))
        let samR1 = u16Tos16(sys.peek(inPtr + 8) | (sys.peek(inPtr + 9) << 8))
        let samL2 = u16Tos16(sys.peek(inPtr + 10) | (sys.peek(inPtr + 11) << 8))
        let samR2 = u16Tos16(sys.peek(inPtr + 12) | (sys.peek(inPtr + 13) << 8))
        sys.poke(outPtr + 0, s16Tou8(samL2))
        sys.poke(outPtr + 1, s16Tou8(samR2))
        sys.poke(outPtr + 2, s16Tou8(samL1))
        sys.poke(outPtr + 3, s16Tou8(samR1))

        let bytesSent = 4
        // start delta-decoding
        for (let curs = 14; curs < blockSize; curs++) {
            let byte = sys.peek(inPtr + curs)
            let [unybL, unybR, snybL, snybR] = getNybbles(byte)
            // predict
            predictorL = clampS16(((samL1 * coeffL1 + samL2 * coeffL2) >> 8) + (snybL * deltaL))
            predictorR = clampS16(((samR1 * coeffR1 + samR2 * coeffR2) >> 8) + (snybR * deltaR))
            // sendout
            sys.poke(outPtr + bytesSent, s16Tou8(predictorL));bytesSent += 1;
            sys.poke(outPtr + bytesSent, s16Tou8(predictorR));bytesSent += 1;
            // shift samples
            samL2 = samL1
            samL1 = predictorL
            samR2 = samR1
            samR1 = predictorR
            // compute next adaptive scale factor
            deltaL = (deltaL * adaptationTable[unybL]) >> 8
            deltaR = (deltaR * adaptationTable[unybR]) >> 8
            // saturate delta to lower bound of 16
            if (deltaL < 16) deltaL = 16
            if (deltaR < 16) deltaR = 16
        }

        return bytesSent
    }
    else {
        throw Error(`Only stereo sound decoding is supported (channels: ${nCHannels})`)
    }
}
// @return decoded sample length (not count!)
function decodeInfilePcm(inPtr, outPtr, inputLen) {
    // LPCM
    if (1 == pcmType)
        return decodeLPCM(inPtr, outPtr, inputLen)
    else if (2 == pcmType)
        return decodeMS_ADPCM(inPtr, outPtr, inputLen)
    else
        throw Error(`PCM Type not LPCM or ADPCM (${pcmType})`)
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

        // define BLOCK_SIZE as integer multiple of blockSize, for LPCM
        // ADPCM will be decoded per-block basis
        if (1 == pcmType) {
            // get GCD of given values; this wll make resampling headache-free
            let blockSizeIncrement = LCM(blockSize, samplingRate / GCD(samplingRate, HW_SAMPLING_RATE))

            while (BLOCK_SIZE < 4096) {
                BLOCK_SIZE += blockSizeIncrement // for rate 44100, BLOCK_SIZE will be 4116
            }
            INFILE_BLOCK_SIZE = BLOCK_SIZE * bitsPerSample / 8 // for rate 44100, INFILE_BLOCK_SIZE will be 8232
        }
        else if (2 == pcmType) {
            BLOCK_SIZE = blockSize
            INFILE_BLOCK_SIZE = BLOCK_SIZE
        }


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

                    let decodedSampleLength = decodeInfilePcm(readPtr, decodePtr, readLength)
                    printdbg(`        decodedSampleLength: ${decodedSampleLength}`)

                    audio.putPcmDataByPtr(decodePtr, decodedSampleLength, 0)
                    audio.setSampleUploadLength(0, decodedSampleLength)
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