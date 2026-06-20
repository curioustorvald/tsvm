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

// Load the visualiser's font ROM now, while no audio file is streaming (single-file-open drive).
if (gui) gui.preloadAssets()

seqread.prepare(filePath)

const readPtr = sys.malloc(BLOCK_SIZE)
// Occupy the first idle playhead rather than always grabbing #0, so playback
// doesn't cut off audio already running on another playhead. Falls back to #0
// when all four are busy.
const PLAYHEAD = audio.getFreePlayhead(0)
audio.resetParams(PLAYHEAD)
audio.purgeQueue(PLAYHEAD)
audio.setPcmMode(PLAYHEAD)
audio.setMasterVolume(PLAYHEAD, 255)

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
        if (interactive && gui.audioIsExitRequested()) {
            // Stop immediately and drop everything still queued, so audio doesn't keep playing
            // the buffered chunks after the user quits.
            audio.stop(PLAYHEAD); audio.purgeQueue(PLAYHEAD)
            stopPlay = true; break
        }

        // Top the queue up to QUEUE_MAX chunks with a DIRECT enqueue (no putPcmData/startUpload
        // handshake, no sys.sleep). The handshake dropped chunks under load → skips/fast-forward.
        while (audio.getPosition(PLAYHEAD) < QUEUE_MAX && seqread.getReadCount() < FILE_SIZE) {
            const remainingBytes = FILE_SIZE - seqread.getReadCount()
            readLength = (remainingBytes < INFILE_BLOCK_SIZE) ? remainingBytes : INFILE_BLOCK_SIZE
            if (readLength <= 0) break

            seqread.readBytes(readLength, readPtr)

            // Raw PCMu8 stereo — sampleCount = bytes / 2.
            if (interactive) gui.audioFeedPcm(readPtr, readLength >> 1)

            audio.queuePcmDataByPtr(PLAYHEAD, readPtr, readLength)
        }
        audio.play(PLAYHEAD)

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
    // Never leave the playhead in 'play' mode for the next program. On a clean finish, let the
    // queued tail play out first; on Backspace/error, stop immediately.
    if (!stopPlay && errorlevel === 0) {
        let guard = 0
        while (audio.getPosition(PLAYHEAD) > 0 && guard++ < 1500) sys.sleep(20) // drain, capped ~30s
    }
    audio.stop(PLAYHEAD)
    audio.purgeQueue(PLAYHEAD)

    if (readPtr !== undefined) sys.free(readPtr)
    if (interactive) gui.audioClose()
}

return errorlevel
