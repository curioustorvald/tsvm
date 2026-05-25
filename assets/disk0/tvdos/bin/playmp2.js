// playmp2 — MPEG-1/2 Audio Layer II player with the shared playgui visualiser.
// Usage: playmp2 <file.mp2> [-i]

const SND_BASE_ADDR = audio.getBaseAddr()
if (!SND_BASE_ADDR) return 10

const MP2_BITRATES     = ["???", 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
const MP2_CHANNELMODES = ["Stereo", "Joint", "Dual", "Mono"]

const pcm = require("pcm")
const interactive = exec_args[2] && exec_args[2].toLowerCase() === "-i"
const gui = interactive ? require("playgui") : null

function printdbg(s) { if (0) serial.println(s) }

class SequentialFileBuffer {
    constructor(path, offset, length) {
        if (Array.isArray(path)) throw Error("arg #1 is path(string), not array")
        this.path = path
        this.file = files.open(path)
        this.offset = offset || 0
        this.originalOffset = offset
        this.length = length || this.file.size
        this.seq = require("seqread")
        this.seq.prepare(path)
    }
    readBytes(size, ptr) { return this.seq.readBytes(size, ptr) }
    get fileHeader() { return this.seq.fileHeader }
}

const filebuf       = new SequentialFileBuffer(_G.shell.resolvePathInput(exec_args[1]).full)
const FILE_SIZE     = filebuf.length
const FRAME_SIZE    = audio.mp2GetInitialFrameSize(filebuf.fileHeader)
const MEDIA_BITRATE = MP2_BITRATES[filebuf.fileHeader[2] >>> 4]
const MEDIA_CHANNEL = MP2_CHANNELMODES[filebuf.fileHeader[3] >>> 6]

// mediaDecodedBin sits at MMIO offset 64 in the audio peripheral and holds
// 2304 bytes (1152 stereo u8 samples per MP2 frame).  Peripheral memory grows
// toward 0 so the canonical pointer is SND_BASE_ADDR - 64.
//
// IMPORTANT: single-byte sys.peek on this address hits AudioAdapter.peek()
// which maps the lower offsets to sampleBin, not mediaDecodedBin (the
// MMIO/Memory-Space split — see CLAUDE.md).  To get the decoded PCM into the
// visualiser, we sys.memcpy mediaDecodedBin → a RAM scratch buffer; memcpy
// uses VM.getDev internally which DOES route the MMIO read correctly.
//
// VM.getDev's range check on mediaDecodedBin (relPtrInDev) is half-open and
// won't let us copy the full 2304 bytes — we copy 2302 (one stereo sample
// short of the frame, invisible at visualiser resolution).
const MP2_DECODED_ADDR    = SND_BASE_ADDR - 64
const MP2_VIS_COPY_BYTES  = 2302
const MP2_VIS_SAMPLE_COUNT = MP2_VIS_COPY_BYTES >> 1   // 1151
const mp2VisScratch = interactive ? sys.malloc(MP2_VIS_COPY_BYTES) : 0

let bytes_left    = FILE_SIZE
let decodedLength = 0

const bufRealTimeLen = 36   // one MP2 frame at 32 kHz ≈ 36 ms

audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setPcmQueueCapacityIndex(0, 2)
const QUEUE_MAX = audio.getPcmQueueCapacity(0)
audio.setMasterVolume(0, 255)
audio.play(0)
audio.mp2Init()

function bytesToSec(i) { return i / (FRAME_SIZE * 1000 / bufRealTimeLen) }

if (interactive) {
    const tag   = "MP2"
    const title = `${filebuf.file.name}  ${MEDIA_CHANNEL} ${MEDIA_BITRATE}kbps`
    gui.audioInit({ title, tag })
}

let stopPlay = false
let errorlevel = 0
try {
    while (bytes_left > 0 && !stopPlay) {
        if (interactive && gui.audioIsExitRequested()) { stopPlay = true; break }

        filebuf.readBytes(FRAME_SIZE, SND_BASE_ADDR - 2368)
        audio.mp2Decode()

        // After decode, 1152 PCMu8 stereo samples sit in mediaDecodedBin
        // (MMIO).  Bounce them through RAM so single-byte peek in the
        // visualiser pipeline can reach them — see MP2_DECODED_ADDR notes.
        if (interactive) {
            sys.memcpy(MP2_DECODED_ADDR, mp2VisScratch, MP2_VIS_COPY_BYTES)
            gui.audioFeedPcm(mp2VisScratch, MP2_VIS_SAMPLE_COUNT)
        }

        if (audio.getPosition(0) >= QUEUE_MAX) {
            while (audio.getPosition(0) >= (QUEUE_MAX >>> 1)) {
                if (interactive) gui.audioRender()
                sys.sleep(bufRealTimeLen)
            }
        }
        audio.mp2UploadDecoded(0)

        if (interactive) {
            gui.audioSetProgress(decodedLength / FILE_SIZE,
                                 bytesToSec(decodedLength), bytesToSec(FILE_SIZE))
            gui.audioRender()
        }
        sys.sleep(10)

        bytes_left    -= FRAME_SIZE
        decodedLength += FRAME_SIZE
    }
} catch (e) {
    printerrln(e)
    errorlevel = 1
} finally {
    if (interactive) {
        if (mp2VisScratch) sys.free(mp2VisScratch)
        gui.audioClose()
    }
}

return errorlevel
