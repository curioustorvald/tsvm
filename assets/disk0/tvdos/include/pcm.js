const HW_SAMPLING_RATE = 30000
function printdbg(s) { if (0) serial.println(s) }
function printvis(s) { if (1) println(s) }
function sampleToVisual(i) {
    let rawstr = Math.abs(i).toString(2)
    if (i < 0) rawstr = rawstr.padStart(16, '0')
    else       rawstr = rawstr.padEnd(16, '0')

    let strPiece = rawstr.substring(0, Math.ceil(Math.abs(i) / 2048))
    if (i == 0)
        return '               ][               '
    if (i < 0)
        return strPiece.padStart(16, ' ') + '                '
    else
        return '                ' + strPiece.padEnd(16, ' ')
}
function clamp(val, low, hi) { return (val < low) ? low : (val > hi) ? hi : val }
function clampS16(i) { return clamp(i, -32768, 32767) }
const uNybToSnyb = [0,1,2,3,4,5,6,7,-8,-7,-6,-5,-4,-3,-2,-1]
// returns: [unsigned high, unsigned low, signed high, signed low]
function getNybbles(b) { return [b >> 4, b & 15, uNybToSnyb[b >> 4], uNybToSnyb[b & 15]] }
function s8Tou8(i) { return i + 128 }
function s16Tou8(i) {
//    return s8Tou8((i >> 8) & 255)
    // apply dithering
    let ufval = (i / 65536.0) + 0.5
    let ival = randomRound(ufval * 256.0)
    return ival|0
}
function u16Tos16(i) { return (i > 32767) ? i - 65536 : i }
function randomRound(k) {
    if (Math.random() < (k - (k|0)))
        return Math.ceil(k)
    else
        return Math.floor(k)
}
function lerp(start, end, x) {
    return (1 - x) * start + x * end
}
function lerpAndRound(start, end, x) {
    return Math.round(lerp(start, end, x))
}




/**
 * config: { nChannels:2, bitsPerSample:16, samplingRate:48000, blockSize:4 }
 */
function decodeLPCM(inPtr, outPtr, inputLen, config) {
    let bytes = config.bitsPerSample / 8

    if (2 == bytes) {
        if (HW_SAMPLING_RATE == config.samplingRate) {
            if (2 == config.nChannels) {
                for (let k = 0; k < inputLen / 2; k+=2) {
                    let sample = [
                        u16Tos16(sys.peek(inPtr + k*2 + 0) | (sys.peek(inPtr + k*2 + 1) << 8)),
                        u16Tos16(sys.peek(inPtr + k*2 + 2) | (sys.peek(inPtr + k*2 + 3) << 8))
                    ]
                    sys.poke(outPtr + k, s16Tou8(sample[0]))
                    sys.poke(outPtr + k + 1, s16Tou8(sample[1]))
                    // soothing visualiser(????)
                    printvis(`${sampleToVisual(sample[0])} | ${sampleToVisual(sample[1])}`)
                }
                return inputLen / 2
            }
            else if (1 == config.nChannels) {
                for (let k = 0; k < inputLen; k+=1) {
                    let sample = u16Tos16(sys.peek(inPtr + k*2 + 0) | (sys.peek(inPtr + k*2 + 1) << 8))
                    sys.poke(outPtr + k*2, s16Tou8(sample))
                    sys.poke(outPtr + k*2 + 1, s16Tou8(sample))
                    // soothing visualiser(????)
                    printvis(`${sampleToVisual(sample)}`)
                }
                return inputLen
            }
        }
        // resample!
        else {
            // for rate 44100 16 bits, the inputLen will be 8232, if EOF not reached; otherwise pad with zero
            let indexStride = config.samplingRate / HW_SAMPLING_RATE // note: a sample can span multiple bytes (2 for s16b)
            let indices = (inputLen / indexStride) / config.nChannels / bytes
            let sample = [
                u16Tos16(sys.peek(inPtr+0) | (sys.peek(inPtr+1) << 8)),
                u16Tos16(sys.peek(inPtr+bytes) | (sys.peek(inPtr+bytes+1) << 8))
            ]

            printdbg(`indices: ${indices}; indexStride = ${indexStride}`)

            // write out first sample
            sys.poke(outPtr+0, s16Tou8(sample[0]))
            sys.poke(outPtr+1, s16Tou8(sample[1]))
            let sendoutLength = 2

            for (let i = 1; i < indices; i++) {
                for (let channel = 0; channel < config.nChannels; channel++) {
                    let iEnd = i * indexStride // sampleA, sampleB
                    let iA = iEnd|0
                    if (Math.abs((iEnd / iA) - 1.0) < 0.0001) {
                        // iEnd on integer point (no lerp needed)
                        let iR = Math.round(iEnd)
                        sample[channel] = u16Tos16(sys.peek(inPtr + config.blockSize*iR + bytes*channel) | (sys.peek(inPtr + config.blockSize*iR + bytes*channel + 1) << 8))
                    }
                    else {
                        // iEnd not on integer point (lerp needed)
                        // sampleA = samples[iEnd|0], sampleB = samples[1 + (iEnd|0)], lerpScale = iEnd - (iEnd|0)
                        // sample = lerp(sampleA, sampleB, lerpScale)
                        let sampleA = u16Tos16(sys.peek(inPtr + config.blockSize*iA + bytes*channel + 0) | (sys.peek(inPtr + config.blockSize*iA + bytes*channel + 1) << 8))
                        let sampleB = u16Tos16(sys.peek(inPtr + config.blockSize*iA + bytes*channel + config.blockSize) | (sys.peek(inPtr + config.blockSize*iA + bytes*channel + config.blockSize + 1) << 8))
                        let scale = iEnd - iA
                        sample[channel] = (lerpAndRound(sampleA, sampleB, scale))

                    }
                    // soothing visualiser(????)
                    printvis(`${sampleToVisual(sample[0])} | ${sampleToVisual(sample[1])}`)

                    // writeout
                    sys.poke(outPtr + sendoutLength, s16Tou8(sample[channel]));sendoutLength += 1
                    if (config.nChannels == 1) {
                        sys.poke(outPtr + sendoutLength, s16Tou8(sample[channel]));sendoutLength += 1
                    }
                }
            }
            // pad with zero (might have lost the last sample of the input audio but whatever)
            for (let k = 0; k < sendoutLength % config.nChannels; k++) {
                sys.poke(outPtr + sendoutLength, 0)
                sendoutLength += 1
            }
            return sendoutLength // for full chunk, this number should be equal to indices * 2
        }
    }
    else {
        throw Error(`24-bit or 32-bit PCM not supported (bits per sample: ${config.bitsPerSample})`)
    }
}



/**
 * config: { nChannels:2 }
 */
// @see https://wiki.multimedia.cx/index.php/Microsoft_ADPCM
// @see https://github.com/videolan/vlc/blob/master/modules/codec/adpcm.c#L423
function decodeMS_ADPCM(inPtr, outPtr, blockSize, config) {
    const adaptationTable = [
      230, 230, 230, 230, 307, 409, 512, 614,
      768, 614, 512, 409, 307, 230, 230, 230
    ]
    const coeff1 = [256, 512, 0, 192, 240, 460, 392]
    const coeff2 = [  0,-256, 0,  64,   0,-208,-232]
    let readOff = 0
    if (blockSize < 7 * config.nChannels) return
    if (2 == config.nChannels) {
        let predL = clamp(sys.peek(inPtr + 0), 0, 6)
        let coeffL1 = coeff1[predL]
        let coeffL2 = coeff2[predL]
        let predR = clamp(sys.peek(inPtr + 1), 0, 6)
        let coeffR1 = coeff1[predR]
        let coeffR2 = coeff2[predR]
        let deltaL = u16Tos16(sys.peek(inPtr + 2) | (sys.peek(inPtr + 3) << 8))
        let deltaR = u16Tos16(sys.peek(inPtr + 4) | (sys.peek(inPtr + 5) << 8))
        // write initial two samples
        let samL1 = u16Tos16(sys.peek(inPtr + 6) | (sys.peek(inPtr + 7) << 8))
        let samR1 = u16Tos16(sys.peek(inPtr + 8) | (sys.peek(inPtr + 9) << 8))
        let samL2 = u16Tos16(sys.peek(inPtr + 10) | (sys.peek(inPtr + 11) << 8))
        let samR2 = u16Tos16(sys.peek(inPtr + 12) | (sys.peek(inPtr + 13) << 8))
        sys.poke(outPtr + 0, s16Tou8(samL2))
        sys.poke(outPtr + 1, s16Tou8(samR2))
        sys.poke(outPtr + 2, s16Tou8(samL1))
        sys.poke(outPtr + 3, s16Tou8(samR1))

//        printvis(`isamp\t${samL2}\t${samR2}\t${samL1}\t${samR1}`)

        let bytesSent = 4
        // start delta-decoding
        for (let curs = 14; curs < blockSize; curs++) {
            let byte = sys.peek(inPtr + curs)
            let [unybL, unybR, snybL, snybR] = getNybbles(byte)
            // predict
            let predictorL = clampS16(((samL1 * coeffL1 + samL2 * coeffL2) >> 8) + snybL * deltaL)
            let predictorR = clampS16(((samR1 * coeffR1 + samR2 * coeffR2) >> 8) + snybR * deltaR)
            // shift samples
            samL2 = samL1
            samL1 = predictorL
            samR2 = samR1
            samR1 = predictorR
            // compute next adaptive scale factor
            deltaL = ((adaptationTable[unybL] * deltaL) >> 8)
            deltaR = ((adaptationTable[unybR] * deltaR) >> 8)
            // clamp delta
            if (deltaL < 16) deltaL = 16
            if (deltaR < 16) deltaR = 16

            // another soothing numbers wheezg-by(?)
            printvis(`b ${(''+byte).padStart(3,' ')} nb ${(''+unybL).padStart(2,' ')} ${(''+unybR).padStart(2,' ')}  pred${(''+predictorL).padStart(9,' ')}${(''+predictorR).padStart(9,' ')}\tdelta\t${deltaL}\t${deltaR}`)
//            printvis(`${sampleToVisual(predictorL)} | ${sampleToVisual(predictorR)}`)

            // sendout
            sys.poke(outPtr + bytesSent, s16Tou8(predictorL));bytesSent += 1;
            sys.poke(outPtr + bytesSent, s16Tou8(predictorR));bytesSent += 1;
        }
        return bytesSent
    }
    else if (1 == config.nChannels) {
        let predL = clamp(sys.peek(inPtr + 0), 0, 6)
        let coeffL1 = coeff1[predL]
        let coeffL2 = coeff2[predL]
        let deltaL = u16Tos16(sys.peek(inPtr + 1) | (sys.peek(inPtr + 2) << 8))
        // write initial two samples
        let samL1 = u16Tos16(sys.peek(inPtr + 3) | (sys.peek(inPtr + 4) << 8))
        let samL2 = u16Tos16(sys.peek(inPtr + 5) | (sys.peek(inPtr + 6) << 8))
        sys.poke(outPtr + 0, s16Tou8(samL2))
        sys.poke(outPtr + 1, s16Tou8(samL2))
        sys.poke(outPtr + 2, s16Tou8(samL1))
        sys.poke(outPtr + 3, s16Tou8(samL1))

//        printvis(`isamp\t${samL2}\t${samL1}`)

        let bytesSent = 4
        // start delta-decoding
        for (let curs = 7; curs < blockSize; curs++) {
            let byte = sys.peek(inPtr + curs)
            let [unybL, unybR, snybL, snybR] = getNybbles(byte)

            //// upper nybble ////
            // predict
            let predictorL = clampS16(((samL1 * coeffL1 + samL2 * coeffL2) >> 8) + snybL * deltaL)
            // shift samples
            samL2 = samL1
            samL1 = predictorL
            // compute next adaptive scale factor
            deltaL = ((adaptationTable[unybL] * deltaL) >> 8)
            // clamp delta
            if (deltaL < 16) deltaL = 16

            // another soothing numbers wheezg-by(?)
            printvis(`b ${(''+byte).padStart(3,' ')} nb ${(''+unybL).padStart(2,' ')}  pred${(''+predictorL).padStart(9,' ')}\tdelta\t${deltaL}`)

            // sendout
            sys.poke(outPtr + bytesSent, s16Tou8(predictorL));bytesSent += 1;
            sys.poke(outPtr + bytesSent, s16Tou8(predictorL));bytesSent += 1;

            //// lower nybble ////
            // predict
            predictorL = clampS16(((samL1 * coeffL1 + samL2 * coeffL2) >> 8) + snybR * deltaL)
            // shift samples
            samL2 = samL1
            samL1 = predictorL
            // compute next adaptive scale factor
            deltaL = ((adaptationTable[unybR] * deltaL) >> 8)
            // clamp delta
            if (deltaL < 16) deltaL = 16

            // another soothing numbers wheezg-by(?)
            printvis(`b ${(''+byte).padStart(3,' ')} nb ${(''+unybR).padStart(2,' ')}  pred${(''+predictorL).padStart(9,' ')}\tdelta\t${deltaL}`)

            // sendout
            sys.poke(outPtr + bytesSent, s16Tou8(predictorL));bytesSent += 1;
            sys.poke(outPtr + bytesSent, s16Tou8(predictorL));bytesSent += 1;
        }

        return bytesSent
    }
    else {
        throw Error(`Only stereo and mono sound decoding is supported (channels: ${config.nChannels})`)
    }
}


exports = { HW_SAMPLING_RATE, randomRound, decodeMS_ADPCM, decodeLPCM }