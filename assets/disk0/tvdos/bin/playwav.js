// playwav — WAV (LPCM/ADPCM) player with the shared playgui visualiser.
// Usage: playwav <file.wav> [-i]

const fileHandle = files.open(_G.shell.resolvePathInput(exec_args[1]).full)
const filePath   = fileHandle.fullPath

const WAV_FORMATS  = ["LPCM", "ADPCM"]
const WAV_CHANNELS = ["Mono", "Stereo", "3ch", "Quad", "4.1", "5.1", "6.1", "7.1"]
const interactive  = exec_args[2] && exec_args[2].toLowerCase() === "-i"

const seqread = require("seqread")
const pcm     = require("pcm")
const gui     = interactive ? require("playgui") : null

function printdbg(s) { if (0) serial.println(s) }

function GCD(a, b) {
    a = Math.abs(a); b = Math.abs(b)
    if (b > a) { const t = a; a = b; b = t }
    while (true) {
        if (b === 0) return a
        a %= b
        if (a === 0) return b
        b %= a
    }
}
function LCM(a, b) { return (!a || !b) ? 0 : Math.abs((a * b) / GCD(a, b)) }

// Load the visualiser's font ROM now, while no audio file is streaming. The drive is
// single-file-open, so loading it lazily during playback would corrupt the audio stream.
if (gui) gui.preloadAssets()

seqread.prepare(filePath)
if (seqread.readFourCC() !== "RIFF") throw Error("File not RIFF")
const FILE_SIZE = seqread.readInt()
if (seqread.readFourCC() !== "WAVE") throw Error("File is RIFF but not WAVE")

let BLOCK_SIZE = 0
let INFILE_BLOCK_SIZE = 0
const QUEUE_MAX = 8

let pcmType, nChannels, samplingRate, blockSize, bitsPerSample, byterate
let adpcmSamplesPerBlock
let readPtr, decodePtr
const comments = {}

function bytesToSec(i) {
    if (adpcmSamplesPerBlock) {
        const generatedSamples = i / blockSize * adpcmSamplesPerBlock
        return generatedSamples / samplingRate
    }
    return i / byterate
}

function checkIfPlayable() {
    if (pcmType !== 1 && pcmType !== 2) return `PCM Type not LPCM/ADPCM (${pcmType})`
    if (nChannels < 1 || nChannels > 2) return `Audio not mono/stereo but instead has ${nChannels} channels`
    if (pcmType !== 1 && samplingRate !== pcm.HW_SAMPLING_RATE)
        return `Format is ADPCM but sampling rate is not ${pcm.HW_SAMPLING_RATE}: ${samplingRate}`
    return "playable!"
}

function decodeInfilePcm(inPtr, outPtr, inputLen) {
    if (pcmType === 1)
        return pcm.decodeLPCM(inPtr, outPtr, inputLen, { nChannels, bitsPerSample, samplingRate, blockSize })
    if (pcmType === 2)
        return pcm.decodeMS_ADPCM(inPtr, outPtr, inputLen, { nChannels })
    throw Error(`PCM Type not LPCM or ADPCM (${pcmType})`)
}

let stopPlay = false
let errorlevel = 0

try {
    while (!stopPlay && seqread.getReadCount() < FILE_SIZE - 8) {
        const chunkName = seqread.readFourCC()
        const chunkSize = seqread.readInt()
        printdbg(`Reading '${chunkName}' at ${seqread.getReadCount() - 8}`)

        if (chunkName === "fmt ") {
            pcmType       = seqread.readShort()
            nChannels     = seqread.readShort()
            samplingRate  = seqread.readInt()
            byterate      = seqread.readInt()
            blockSize     = seqread.readShort()
            bitsPerSample = seqread.readShort()
            if (pcmType !== 2) {
                seqread.skip(chunkSize - 16)
            } else {
                seqread.skip(2)
                adpcmSamplesPerBlock = seqread.readShort()
                seqread.skip(chunkSize - (16 + 4))
            }

            if (pcmType === 1) {
                const incr = LCM(blockSize, samplingRate / GCD(samplingRate, pcm.HW_SAMPLING_RATE))
                while (BLOCK_SIZE < 4096) BLOCK_SIZE += incr
                INFILE_BLOCK_SIZE = BLOCK_SIZE * bitsPerSample / 8
            } else if (pcmType === 2) {
                BLOCK_SIZE = blockSize
                INFILE_BLOCK_SIZE = BLOCK_SIZE
            }

            if (interactive) {
                const tag = "WAV"
                const title = fileHandle.name +
                    `  ${WAV_FORMATS[pcmType-1]} ${WAV_CHANNELS[nChannels-1]} ${byterate*0.008*(pcmType === 2 ? 2 : 1)}kbps`
                gui.audioInit({ title, tag })
            }
        }
        else if (chunkName === "LIST") {
            const startOffset = seqread.getReadCount()
            const subChunkName = seqread.readFourCC()
            while (seqread.getReadCount() < startOffset + chunkSize) {
                if (subChunkName === "INFO") {
                    let key = seqread.readFourCC()
                    let valueLen = seqread.readInt()
                    while (key.charCodeAt(0) === 0) {
                        const kbytes = [key.charCodeAt(1), key.charCodeAt(2), key.charCodeAt(3), valueLen & 255]
                        const klen   = [(valueLen >>> 8) & 255, (valueLen >>> 16) & 255, (valueLen >>> 24) & 255, seqread.readOneByte()]
                        key = String.fromCharCode.apply(null, kbytes)
                        valueLen = klen[0] | (klen[1] << 8) | (klen[2] << 16) | (klen[3] << 24)
                    }
                    comments[key] = seqread.readString(valueLen)
                } else {
                    seqread.skip(startOffset + chunkSize - seqread.getReadCount())
                }
            }
        }
        else if (chunkName === "data") {
            const startOffset = seqread.getReadCount()
            const reason = checkIfPlayable()
            if (reason !== "playable!") throw Error("WAVE not playable: " + reason)

            readPtr   = sys.malloc(pcmType === 2 ? BLOCK_SIZE : BLOCK_SIZE * bitsPerSample / 8)
            decodePtr = sys.malloc(BLOCK_SIZE * pcm.HW_SAMPLING_RATE / samplingRate)

            // Occupy the first idle playhead rather than always grabbing #0, so
            // playback doesn't cut off audio already running on another playhead.
            // Falls back to #0 when all four are busy.
            const PLAYHEAD = audio.getFreePlayhead(0)
            audio.resetParams(PLAYHEAD)
            audio.purgeQueue(PLAYHEAD)
            audio.setPcmMode(PLAYHEAD)
            audio.setMasterVolume(PLAYHEAD, 255)

            let readLength = 1
            while (!stopPlay && seqread.getReadCount() < startOffset + chunkSize && readLength > 0) {
                if (interactive && gui.audioIsExitRequested()) {
                    // Stop immediately and drop everything still queued, so audio doesn't keep
                    // playing the ~half-second of buffered chunks after the user quits.
                    audio.stop(PLAYHEAD); audio.purgeQueue(PLAYHEAD)
                    stopPlay = true; break
                }

                // Top the queue up to QUEUE_MAX chunks with a DIRECT enqueue (no putPcmData/
                // setSampleUploadLength/startSampleUpload handshake, no sys.spin). The handshake
                // routes through a single-slot pcmBin and dropped chunks when fed in a burst, which
                // skipped/fast-forwarded the song. queuePcmDataByPtr enqueues synchronously.
                while (audio.getPosition(PLAYHEAD) < QUEUE_MAX &&
                       seqread.getReadCount() < startOffset + chunkSize) {
                    const remainingBytes = FILE_SIZE - 8 - seqread.getReadCount()
                    readLength = (remainingBytes < INFILE_BLOCK_SIZE) ? remainingBytes : INFILE_BLOCK_SIZE
                    if (readLength <= 0) break

                    seqread.readBytes(readLength, readPtr)
                    const decodedSampleLength = decodeInfilePcm(readPtr, decodePtr, readLength)

                    // Hand the decoded PCMu8 stereo block to the visualiser before queueing —
                    // the buffer is reused next iteration.
                    if (interactive) gui.audioFeedPcm(decodePtr, decodedSampleLength >> 1)

                    audio.queuePcmDataByPtr(PLAYHEAD, decodePtr, decodedSampleLength)
                }
                audio.play(PLAYHEAD)

                if (interactive) {
                    const cur = seqread.getReadCount() - startOffset
                    const tot = FILE_SIZE - startOffset - 8
                    gui.audioSetProgress(cur / tot, bytesToSec(cur), bytesToSec(tot))
                    gui.audioRender()
                }
                sys.sleep(10)
            }

            // Release the playhead so it isn't left in 'play' mode for the next program. On a clean
            // finish, let the queued tail play out first; on Backspace/error, stop immediately.
            if (!stopPlay && errorlevel === 0) {
                let guard = 0
                while (audio.getPosition(PLAYHEAD) > 0 && guard++ < 1500) sys.sleep(20) // drain, ~30s cap
            }
            audio.stop(PLAYHEAD)
            audio.purgeQueue(PLAYHEAD)
        }
        else {
            seqread.skip(chunkSize)
        }

        sys.spin()
    }
} catch (e) {
    printerrln(e)
    // Recover + show the host (Java) stack trace, which `e` alone does not carry.
    try { printerrln(sys.printStackTrace(e)) } catch (_) {}
    errorlevel = 1
} finally {
    if (readPtr   !== undefined) sys.free(readPtr)
    if (decodePtr !== undefined) sys.free(decodePtr)
    if (interactive) gui.audioClose()
}

return errorlevel
