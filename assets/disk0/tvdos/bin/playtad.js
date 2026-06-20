// playtad — TAD (TSVM Advanced Audio) player with the shared playgui visualiser.
// Usage: playtad <file.tad> [-i | -d]
//   -i   Interactive mode (visualiser + progress bar; hold Backspace to exit)
//   -d   Dump mode (print the first three chunks to serial for debugging)

const SND_BASE_ADDR = audio.getBaseAddr()
const SND_MEM_ADDR  = audio.getMemAddr()
// tadInputBin at offset 917504, tadDecodedBin at 983040.  Both addressed via
// negative pointers — peripheral memory grows toward 0.
const TAD_INPUT_ADDR   = SND_MEM_ADDR - 917504
const TAD_DECODED_ADDR = SND_MEM_ADDR - 983040

if (!SND_BASE_ADDR) return 10

if (!exec_args[1] || exec_args[1] === "-h" || exec_args[1] === "--help") {
    serial.println("Usage: playtad <file.tad> [-i | -d]")
    serial.println("  -i  Interactive mode (visualiser + progress bar)")
    serial.println("  -d  Dump first three chunks for debugging")
    return 0
}

const interactive = exec_args[2] && exec_args[2].toLowerCase() === "-i"
const dumpCoeffs  = exec_args[2] && exec_args[2].toLowerCase() === "-d"
const gui = interactive ? require("playgui") : null

class SequentialFileBuffer {
    constructor(path) {
        if (Array.isArray(path)) throw Error("arg #1 is path(string), not array")
        this.path = path
        this.file = files.open(path)
        this.length = this.file.size
        this.seq = require("seqread")
        this.seq.prepare(path)
    }
    readBytes(size, ptr) { return this.seq.readBytes(size, ptr) }
    readByte() {
        const ptr = this.seq.readBytes(1)
        const val = sys.peek(ptr)
        sys.free(ptr)
        return val
    }
    readShort() {
        const ptr = this.seq.readBytes(2)
        const val = sys.peek(ptr) | (sys.peek(ptr + 1) << 8)
        sys.free(ptr)
        return val
    }
    readInt() {
        const ptr = this.seq.readBytes(4)
        const val = sys.peek(ptr) | (sys.peek(ptr + 1) << 8) | (sys.peek(ptr + 2) << 16) | (sys.peek(ptr + 3) << 24)
        sys.free(ptr)
        return val
    }
    unread(diff) {
        const newSkipLen = this.seq.getReadCount() - diff
        this.seq.prepare(this.path)
        this.seq.skip(newSkipLen)
    }
    rewind() { this.seq.prepare(this.path) }
    getReadCount() { return this.seq.getReadCount() }
}

// Load the visualiser's font ROM now, while no audio file is streaming (single-file-open drive).
if (gui) gui.preloadAssets()

const filebuf   = new SequentialFileBuffer(_G.shell.resolvePathInput(exec_args[1]).full)
const FILE_SIZE = filebuf.length

if (FILE_SIZE < 7) {
    serial.println(`ERROR: File too small (${FILE_SIZE} bytes). Expected TAD format.`)
    return 1
}

// Peek the first chunk header so we know the chunk size for the rough bytes-
// to-seconds conversion shown in the progress bar.
const firstSampleCount = filebuf.readShort()
const firstMaxIndex    = filebuf.readByte()
const firstPayloadSize = filebuf.readInt()

if (firstSampleCount < 0 || firstSampleCount > 65536) {
    serial.println(`ERROR: Invalid sample count ${firstSampleCount}. File may be corrupted.`)
    return 1
}
if (firstMaxIndex < 0 || firstMaxIndex > 255) {
    serial.println(`ERROR: Invalid max index ${firstMaxIndex}. File may be corrupted.`)
    return 1
}
if (firstPayloadSize < 1 || firstPayloadSize > 65536) {
    serial.println(`ERROR: Invalid payload size ${firstPayloadSize}. File may be corrupted.`)
    return 1
}

filebuf.rewind()

const AVG_CHUNK_SIZE = 7 + firstPayloadSize
const SAMPLE_RATE    = 32000
const bufRealTimeLen = Math.floor((firstSampleCount / SAMPLE_RATE) * 1000)

if (dumpCoeffs) {
    serial.println(`TAD Coefficient Dump Mode`)
    serial.println(`File: ${filebuf.file.name}`)
    serial.println(`First chunk: ${firstSampleCount} samples, Q${firstMaxIndex}, ${firstPayloadSize} bytes payload`)
    serial.println(`Chunk Duration: ${bufRealTimeLen} ms`)
    serial.println(``)
}

let bytes_left    = FILE_SIZE
let decodedLength = 0
let chunkNumber   = 0

function bytesToSec(i) {
    return Math.round((i / FILE_SIZE) * (FILE_SIZE / AVG_CHUNK_SIZE) * (bufRealTimeLen / 1000))
}

// Occupy the first idle playhead rather than always grabbing #0, so playback
// doesn't cut off audio already running on another playhead. Falls back to #0
// when all four are busy.
const PLAYHEAD = audio.getFreePlayhead(0)
audio.resetParams(PLAYHEAD)
audio.purgeQueue(PLAYHEAD)
audio.setPcmMode(PLAYHEAD)
audio.setPcmQueueCapacityIndex(PLAYHEAD, 2)
const QUEUE_MAX = audio.getPcmQueueCapacity(PLAYHEAD)
audio.setMasterVolume(PLAYHEAD, 255)
audio.play(PLAYHEAD)

if (interactive) {
    gui.audioInit({
        title: `${filebuf.file.name}  TAD Q${firstMaxIndex} ${SAMPLE_RATE/1000}kHz`,
        tag: "TAD"
    })
}

let stopPlay = false
let errorlevel = 0
try {
    while (bytes_left > 0 && !stopPlay) {
        if (interactive && gui.audioIsExitRequested()) {
            // Stop immediately and drop everything still queued, so audio doesn't keep playing
            // the buffered chunks after the user quits.
            audio.stop(PLAYHEAD); audio.purgeQueue(PLAYHEAD)
            stopPlay = true; break
        }

        const sampleCount = filebuf.readShort()
        const maxIndex    = filebuf.readByte()
        const payloadSize = filebuf.readInt()

        if (sampleCount < 0 || sampleCount > 65536) {
            serial.println(`ERROR: Chunk ${chunkNumber}: Invalid sample count ${sampleCount}.`)
            errorlevel = 1; break
        }
        if (maxIndex < 0 || maxIndex > 255) {
            serial.println(`ERROR: Chunk ${chunkNumber}: Invalid max index ${maxIndex}.`)
            errorlevel = 1; break
        }
        if (payloadSize < 1 || payloadSize > 65536) {
            serial.println(`ERROR: Chunk ${chunkNumber}: Invalid payload size ${payloadSize}.`)
            errorlevel = 1; break
        }
        if (payloadSize + 7 > bytes_left) {
            serial.println(`ERROR: Chunk ${chunkNumber}: Chunk size exceeds remaining file size.`)
            errorlevel = 1; break
        }

        if (dumpCoeffs && chunkNumber < 3) {
            serial.println(`=== Chunk ${chunkNumber} ===`)
            serial.println(`  Sample Count: ${sampleCount}`)
            serial.println(`  Max Index: ${maxIndex}`)
            serial.println(`  Payload Size: ${payloadSize} bytes`)
        }

        // Read entire chunk (header + payload) into TAD input buffer.
        filebuf.unread(7)
        filebuf.readBytes(7 + payloadSize, TAD_INPUT_ADDR)

        audio.tadDecode()
        audio.tadUploadDecoded(PLAYHEAD, sampleCount)
        // After upload tadDecodedBin still holds the chunk until the next
        // tadDecode call, so it's safe to keep slicing samples out of it
        // during the playback wait below.

        if (!dumpCoeffs) {
            // TAD chunks are typically 1 s long, so feeding the visualiser
            // once would freeze it for ~1 s.  Walk the chunk in 2048-sample
            // slices (~64 ms each at 32 kHz) so the wavescope and XY-scope
            // stay in step with what the audio engine is actually playing.
            const chunkMs       = Math.floor((sampleCount / SAMPLE_RATE) * 1000)
            const TAD_VIS_SLICE = 2048
            if (interactive) {
                gui.audioSetProgress(decodedLength / FILE_SIZE,
                                     bytesToSec(decodedLength), bytesToSec(FILE_SIZE))
                let sliceOff = 0
                while (sliceOff < sampleCount && !stopPlay) {
                    if (gui.audioIsExitRequested()) {
                        audio.stop(PLAYHEAD); audio.purgeQueue(PLAYHEAD)
                        stopPlay = true; break
                    }
                    const sliceN = Math.min(TAD_VIS_SLICE, sampleCount - sliceOff)
                    // tadDecodedBin is negative-addressed: sample i sits at
                    // TAD_DECODED_ADDR - i*2.  audioFeedPcm flips the read
                    // direction for negative ptrs internally.
                    gui.audioFeedPcm(TAD_DECODED_ADDR - sliceOff * 2, sliceN)
                    gui.audioRender()
                    sys.sleep(Math.floor((sliceN / SAMPLE_RATE) * 1000))
                    sliceOff += sliceN
                }
            } else {
                sys.sleep(chunkMs)
            }
        }

        const chunkSize = 7 + payloadSize
        bytes_left    -= chunkSize
        decodedLength += chunkSize
        chunkNumber++

        if (dumpCoeffs && chunkNumber >= 3) {
            serial.println(`... (remaining chunks omitted)`)
        }
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

    if (interactive) gui.audioClose()
}

return errorlevel
