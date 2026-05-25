// playpcm — raw PCMu8 stereo player with the shared playgui visualiser.
// Usage: playpcm <file.pcm> [-i]

const fileHandle = files.open(_G.shell.resolvePathInput(exec_args[1]).full)
const filePath   = fileHandle.fullPath

const interactive = exec_args[2] && exec_args[2].toLowerCase() === "-i"
const pcm     = require("pcm")
const seqread = require("seqread")
const gui     = interactive ? require("playgui") : null

const FILE_SIZE = files.open(filePath).size

let BLOCK_SIZE = 4096
const INFILE_BLOCK_SIZE = BLOCK_SIZE
const QUEUE_MAX = 8

const samplingRate = pcm.HW_SAMPLING_RATE
const byterate     = 2 * samplingRate

function bytesToSec(i) { return i / byterate }

seqread.prepare(filePath)

const readPtr = sys.malloc(BLOCK_SIZE)
audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setMasterVolume(0, 255)

if (interactive) {
    gui.audioInit({
        title: `${fileHandle.name}  Raw PCM 32kHz Stereo`,
        tag: "PCM"
    })
}

let stopPlay = false
let errorlevel = 0
let readLength = 1
try {
    while (!stopPlay && seqread.getReadCount() < FILE_SIZE && readLength > 0) {
        if (interactive && gui.audioIsExitRequested()) { stopPlay = true; break }

        const queueSize = audio.getPosition(0)
        if (queueSize <= 1) {
            for (let repeat = QUEUE_MAX - queueSize; repeat > 0; repeat--) {
                const remainingBytes = FILE_SIZE - seqread.getReadCount()
                readLength = (remainingBytes < INFILE_BLOCK_SIZE) ? remainingBytes : INFILE_BLOCK_SIZE
                if (readLength <= 0) break

                seqread.readBytes(readLength, readPtr)

                // Raw PCMu8 stereo — sampleCount = bytes / 2.
                if (interactive) gui.audioFeedPcm(readPtr, readLength >> 1)

                audio.putPcmDataByPtr(0, readPtr, readLength, 0)
                audio.setSampleUploadLength(0, readLength)
                audio.startSampleUpload(0)

                if (repeat > 1) sys.sleep(10)
            }
            audio.play(0)
        }

        if (interactive) {
            const cur = seqread.getReadCount()
            gui.audioSetProgress(cur / FILE_SIZE, bytesToSec(cur), bytesToSec(FILE_SIZE))
            gui.audioRender()
        }
        sys.sleep(10)
    }
} catch (e) {
    printerrln(e)
    errorlevel = 1
} finally {
    if (readPtr !== undefined) sys.free(readPtr)
    if (interactive) gui.audioClose()
}

return errorlevel
