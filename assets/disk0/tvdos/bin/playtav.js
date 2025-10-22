// Created by CuriousTorvald and Claude on 2025-09-13.
// TSVM Advanced Video (TAV) Format Decoder - DWT-based compression
// Adapted from the working playtev.js decoder
// Usage: playtav moviefile.tav [options]
// Options: -i (interactive)

const MAXMEM = sys.maxmem()

const WIDTH = 560
const HEIGHT = 448
const TAV_MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x54, 0x41, 0x56] // "\x1FTSVM TAV"
const UCF_MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x55, 0x43, 0x46] // "\x1FTSVM UCF"
const TAV_VERSION = 1  // Initial DWT version
const UCF_VERSION = 1
const ADDRESSING_EXTERNAL = 0x01
const ADDRESSING_INTERNAL = 0x02
const SND_BASE_ADDR = audio.getBaseAddr()
const pcm = require("pcm")
const MP2_FRAME_SIZE = [144,216,252,288,360,432,504,576,720,864,1008,1152,1440,1728]

// Tile encoding modes (same as TEV block modes)
const TAV_MODE_SKIP = 0x00
const TAV_MODE_INTRA = 0x01  
const TAV_MODE_INTER = 0x02
const TAV_MODE_MOTION = 0x03

// Packet types (same as TEV)
const TAV_PACKET_IFRAME = 0x10
const TAV_PACKET_PFRAME = 0x11
const TAV_PACKET_GOP_UNIFIED = 0x12  // Unified 3D DWT GOP (temporal + spatial)
const TAV_PACKET_AUDIO_MP2 = 0x20
const TAV_PACKET_AUDIO_NATIVE = 0x21
const TAV_PACKET_AUDIO_PCM_16LE = 0x22
const TAV_PACKET_AUDIO_ADPCM = 0x23
const TAV_PACKET_SUBTITLE = 0x30
const TAV_PACKET_AUDIO_BUNDLED = 0x40  // Entire MP2 audio file in single packet
const TAV_PACKET_EXTENDED_HDR = 0xEF
const TAV_PACKET_GOP_SYNC = 0xFC  // GOP sync (N frames decoded from GOP block)
const TAV_PACKET_TIMECODE = 0xFD
const TAV_PACKET_SYNC_NTSC = 0xFE
const TAV_PACKET_SYNC = 0xFF
const TAV_FILE_HEADER_FIRST = 0x1F

// Wavelet filter types
const WAVELET_5_3_REVERSIBLE = 0
const WAVELET_9_7_IRREVERSIBLE = 1
const WAVELET_BIORTHOGONAL_13_7 = 2
const WAVELET_DD4 = 16
const WAVELET_HAAR = 255

// Subtitle opcodes (SSF format - same as TEV)
const SSF_OP_NOP = 0x00
const SSF_OP_SHOW = 0x01
const SSF_OP_HIDE = 0x02
const SSF_OP_MOVE = 0x03
const SSF_OP_UPLOAD_LOW_FONT = 0x80
const SSF_OP_UPLOAD_HIGH_FONT = 0x81

// Subtitle state
let subtitleVisible = false
let subtitleText = ""
let subtitlePosition = 0  // 0=bottom center (default)

// Parse command line options
let interactive = false
let filmGrainLevel = null

if (exec_args.length > 2) {
    for (let i = 2; i < exec_args.length; i++) {
        const arg = exec_args[i].toLowerCase()
        if (arg === "-i") {
            interactive = true
        }
        else if (arg.startsWith("--filter-film-grain")) {
            // Extract noise level from argument
            const parts = arg.split(/[=\s]/)
            if (parts.length > 1) {
                const level = parseInt(parts[1])
                if (!isNaN(level) && level >= 1 && level <= 32767) {
                    filmGrainLevel = level
                }
            }
            // Try next argument if no '=' found
            else if (i + 1 < exec_args.length) {
                const level = parseInt(exec_args[i + 1])
                if (!isNaN(level) && level >= 1 && level <= 32767) {
                    filmGrainLevel = level
                    i++ // Skip next arg
                }
            }
        }
    }
}

const fullFilePath = _G.shell.resolvePathInput(exec_args[1])
const FILE_LENGTH = files.open(fullFilePath.full).size

let videoRateBin = []
let errorlevel = 0
let notifHideTimer = 0
const NOTIF_SHOWUPTIME = 3000000000
let [cy, cx] = con.getyx()

let gui = require("playgui")
let seqread = undefined
let fullFilePathStr = fullFilePath.full

let fontUploaded = false

// Select seqread driver to use
if (fullFilePathStr.startsWith('$:/TAPE') || fullFilePathStr.startsWith('$:\\TAPE')) {
    seqread = require("seqreadtape")
    seqread.prepare(fullFilePathStr)
    seqread.seek(0)
} else {
    seqread = require("seqread")
    seqread.prepare(fullFilePathStr)
}

con.clear()
con.curs_set(0)
graphics.setGraphicsMode(4) // initially set to 4bpp mode
graphics.setGraphicsMode(5) // set to 8bpp mode. If GPU don't support it, mode will remain to 4
graphics.clearPixels(0)
graphics.clearPixels2(0)
graphics.clearPixels3(0)
graphics.clearPixels4(0)

const gpuGraphicsMode = graphics.getGraphicsMode()

// Initialize audio
audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setMasterVolume(0, 255)

// set colour zero as half-opaque black
graphics.setPalette(0, 0, 0, 0, 7)

function processSubtitlePacket(packetSize) {

    // Read subtitle packet data according to SSF format
    // uint24 index + uint8 opcode + variable arguments

    let index = 0
    // Read 24-bit index (little-endian)
    let indexByte0 = seqread.readOneByte()
    let indexByte1 = seqread.readOneByte()
    let indexByte2 = seqread.readOneByte()
    index = indexByte0 | (indexByte1 << 8) | (indexByte2 << 16)

    let opcode = seqread.readOneByte()
    let remainingBytes = packetSize - 4  // Subtract 3 bytes for index + 1 byte for opcode

    switch (opcode) {
        case SSF_OP_SHOW: {
            // Read UTF-8 text until null terminator
            if (remainingBytes > 1) {
                let textBytes = seqread.readBytes(remainingBytes)
                let textStr = ""

                // Convert bytes to string, stopping at null terminator
                for (let i = 0; i < remainingBytes - 1; i++) {  // -1 for null terminator
                    let byte = sys.peek(textBytes + i)
                    if (byte === 0) break
                    textStr += String.fromCharCode(byte)
                }

                sys.free(textBytes)
                subtitleText = textStr
                subtitleVisible = true
                gui.displaySubtitle(subtitleText, fontUploaded, subtitlePosition)
            }
            break
        }

        case SSF_OP_HIDE: {
            subtitleVisible = false
            subtitleText = ""
            gui.clearSubtitleArea()
            break
        }

        case SSF_OP_MOVE: {
            if (remainingBytes >= 2) {  // Need at least 1 byte for position + 1 null terminator
                let newPosition = seqread.readOneByte()
                seqread.readOneByte()  // Read null terminator

                if (newPosition >= 0 && newPosition <= 7) {
                    subtitlePosition = newPosition

                    // Re-display current subtitle at new position if visible
                    if (subtitleVisible && subtitleText.length > 0) {
                        gui.clearSubtitleArea()
                        gui.displaySubtitle(subtitleText, fontUploaded, subtitlePosition)
                    }
                }
            }
            break
        }

        case SSF_OP_UPLOAD_LOW_FONT:
        case SSF_OP_UPLOAD_HIGH_FONT: {
            // Font upload - read payload length and font data
            if (remainingBytes >= 3) {  // uint16 length + at least 1 byte data
                let payloadLen = seqread.readShort()

                serial.println(`Uploading ${(opcode == SSF_OP_UPLOAD_LOW_FONT) ? 'low' : 'high'} font rom (${payloadLen} bytes)`)

                if (remainingBytes >= payloadLen + 2) {
                    let fontData = seqread.readBytes(payloadLen)

                    // upload font data
                    for (let i = 0; i < Math.min(payloadLen, 1920); i++) sys.poke(-133121 - i, sys.peek(fontData + i))
                    sys.poke(-1299460, (opcode == SSF_OP_UPLOAD_LOW_FONT) ? 18 : 19)

                    sys.free(fontData)
                }

                fontUploaded = true
            }
            break
        }

        case SSF_OP_NOP:
        default: {
            // Skip remaining bytes
            if (remainingBytes > 0) {
                let skipBytes = seqread.readBytes(remainingBytes)
                sys.free(skipBytes)
            }

            if (interactive && opcode !== SSF_OP_NOP) {
                serial.println(`[SUBTITLE UNKNOWN] Index: ${index}, Opcode: 0x${opcode.toString(16).padStart(2, '0')}`)
            }
            break
        }
    }
}

const QLUT = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096];

// TAV header structure (32 bytes vs TEV's 24 bytes)
let header = {
    magic: new Array(8),
    version: 0,
    width: 0,
    height: 0,
    fps: 0,
    totalFrames: 0,
    waveletFilter: 0,     // TAV-specific: wavelet filter type
    decompLevels: 0,      // TAV-specific: decomposition levels
    qualityY: 0,          // TAV-specific: Y channel quality
    qualityCo: 0,         // TAV-specific: Co channel quality
    qualityCg: 0,         // TAV-specific: Cg channel quality
    extraFlags: 0,
    videoFlags: 0,
    qualityLevel: 0,
    channelLayout: 0,
    entropyCoder: 0,      // 0 = Twobit-map, 1 = EZBC
    fileRole: 0
}

// Read and validate header
for (let i = 0; i < 8; i++) {
    header.magic[i] = seqread.readOneByte()
}

// Validate magic number
let magicValid = true
for (let i = 0; i < 8; i++) {
    if (header.magic[i] !== TAV_MAGIC[i]) {
        magicValid = false
        break
    }
}

if (!magicValid) {
    printerrln("Error: Invalid TAV file format")
    errorlevel = 1
    return
}

header.version = seqread.readOneByte()
header.width = seqread.readShort()
header.height = seqread.readShort()
header.fps = seqread.readOneByte()
header.totalFrames = seqread.readInt()
header.waveletFilter = seqread.readOneByte()
header.decompLevels = seqread.readOneByte()
header.qualityY = seqread.readOneByte()
header.qualityCo = seqread.readOneByte()
header.qualityCg = seqread.readOneByte()
header.extraFlags = seqread.readOneByte()
header.videoFlags = seqread.readOneByte()
header.qualityLevel = seqread.readOneByte() // the decoder expects biased value
header.channelLayout = seqread.readOneByte()
header.entropyCoder = seqread.readOneByte()

// Skip reserved bytes (2) and device orientation (1)
seqread.skip(3)

header.fileRole = seqread.readOneByte()

if (header.version < 1 || header.version > 8) {
    printerrln(`Error: Unsupported TAV version ${header.version}`)
    errorlevel = 1
    return
}

// Helper function to decode channel layout name
function getChannelLayoutName(layout) {
    switch (layout) {
        case 0: return "Y-Co-Cg"
        case 1: return "Y-Co-Cg-A"
        case 2: return "Y-only"
        case 3: return "Y-A"
        case 4: return "Co-Cg"
        case 5: return "Co-Cg-A"
        default: return `Unknown (${layout})`
    }
}

const hasAudio = (header.extraFlags & 0x01) !== 0
const hasSubtitles = (header.extraFlags & 0x02) !== 0
const progressiveTransmission = (header.extraFlags & 0x04) !== 0
const roiCoding = (header.extraFlags & 0x08) !== 0

const isInterlaced = (header.videoFlags & 0x01) !== 0
const isNTSC = (header.videoFlags & 0x02) !== 0
const isLossless = (header.videoFlags & 0x04) !== 0

// Calculate tile dimensions (112x112 vs TEV's 16x16 blocks)
const tilesX = Math.ceil(header.width / 2)
const tilesY = Math.ceil(header.height / 2)
const numTiles = 4

console.log(`TAV Decoder`)
console.log(`Resolution: ${header.width}x${header.height}`)
console.log(`FPS: ${header.fps}`)
console.log(`Total frames: ${header.totalFrames}`)
console.log(`Wavelet filter: ${header.waveletFilter === WAVELET_5_3_REVERSIBLE ? "5/3 reversible" : header.waveletFilter === WAVELET_9_7_IRREVERSIBLE ? "9/7 irreversible" : header.waveletFilter === WAVELET_BIORTHOGONAL_13_7 ? "Biorthogonal 13/7" : header.waveletFilter === WAVELET_DD4 ? "DD-4" : header.waveletFilter === WAVELET_HAAR ? "Haar" : "unknown"}`)
console.log(`Decomposition levels: ${header.decompLevels}`)
console.log(`Quality: Y=${QLUT[header.qualityY]}, Co=${QLUT[header.qualityCo]}, Cg=${QLUT[header.qualityCg]}`)
console.log(`Channel layout: ${getChannelLayoutName(header.channelLayout)}`)
console.log(`Entropy coder: ${header.entropyCoder === 0 ? "Twobit-map" : header.entropyCoder === 1 ? "EZBC" : "Unknown"}`)
console.log(`Tiles: ${tilesX}x${tilesY} (${numTiles} total)`)
console.log(`Colour space: ${header.version % 2 == 0 ? "ICtCp" : "YCoCg-R"}`)
console.log(`Features: ${hasAudio ? "Audio " : ""}${hasSubtitles ? "Subtitles " : ""}${progressiveTransmission ? "Progressive " : ""}${roiCoding ? "ROI " : ""}`)
console.log(`Video flags raw: 0x${header.videoFlags.toString(16)}`)
console.log(`Scan type: ${isInterlaced ? "Interlaced" : "Progressive"}`)

// Adjust decode height for interlaced content
// For interlaced: header.height is display height (448)
// Each field is half of display height (448/2 = 224)
let decodeHeight = isInterlaced ? (header.height >> 1) : header.height

// Frame buffer addresses - same as TEV
const FRAME_PIXELS = header.width * header.height
const FRAME_SIZE = FRAME_PIXELS * 3  // RGB buffer size

// Triple-buffering: Fixed slot sizes in videoBuffer (48 MB total)
const BUFFER_SLOTS = 3  // Three slots: playing, ready, decoding
const MAX_GOP_SIZE = 21  // Maximum frames per slot (21 * 752KB = ~15.8MB per slot)
const SLOT_SIZE = MAX_GOP_SIZE * FRAME_SIZE  // Fixed slot size regardless of actual GOP size

console.log(`Triple-buffering: ${BUFFER_SLOTS} slots, max ${MAX_GOP_SIZE} frames/slot, ${(SLOT_SIZE / 1048576).toFixed(1)}MB per slot`)

const RGB_BUFFER_A = sys.malloc(FRAME_SIZE)
const RGB_BUFFER_B = sys.malloc(FRAME_SIZE)

// Field buffers for interlaced mode (half-height fields)
const FIELD_SIZE = header.width * decodeHeight * 3
const CURR_FIELD_BUFFER = isInterlaced ? sys.malloc(FIELD_SIZE) : 0
const PREV_FIELD_BUFFER = isInterlaced ? sys.malloc(FIELD_SIZE) : 0
const NEXT_FIELD_BUFFER = isInterlaced ? sys.malloc(FIELD_SIZE) : 0

// Ping-pong buffer pointers (swap instead of copy)
let CURRENT_RGB_ADDR = RGB_BUFFER_A
let PREV_RGB_ADDR = RGB_BUFFER_B

// Initialize field buffers to black for interlaced mode
if (isInterlaced) {
    sys.memset(CURR_FIELD_BUFFER, 0, FIELD_SIZE)
    sys.memset(PREV_FIELD_BUFFER, 0, FIELD_SIZE)
    sys.memset(NEXT_FIELD_BUFFER, 0, FIELD_SIZE)
}

// Field buffer pointers for temporal deinterlacing
let prevFieldAddr = PREV_FIELD_BUFFER
let currentFieldAddr = CURR_FIELD_BUFFER
let nextFieldAddr = NEXT_FIELD_BUFFER

// Audio state
let audioBufferBytesLastFrame = 0
let frame_cnt = 0
let frametime = 1000000000.0 / header.fps
let mp2Initialised = false
let audioFired = false


// Performance tracking variables (from TEV)
let decompressTime = 0
let decodeTime = 0
let uploadTime = 0
let biasTime = 0

const nativeWidth = graphics.getPixelDimension()[0]
const nativeHeight = graphics.getPixelDimension()[1]
const BIAS_LIGHTING_MIN = 1.0 / 16.0
let oldBgcol = [BIAS_LIGHTING_MIN, BIAS_LIGHTING_MIN, BIAS_LIGHTING_MIN]

let notifHidden = false

function getRGBfromScr(x, y) {
    let offset = y * WIDTH + x
    let fb1 = sys.peek(-1048577 - offset)
    let fb2 = sys.peek(-1310721 - offset)
    let fb3 = sys.peek(-1310721 - (262144 * (gpuGraphicsMode - 4)) - offset)

    if (gpuGraphicsMode == 4)
        return [(fb1 >>> 4) / 15.0, (fb1 & 15) / 15.0, (fb2 >>> 4) / 15.0]
    else
        return [fb1 / 255.0, fb2 / 255.0, fb3 / 255.0]
}

function setBiasLighting() {
    let samples = []
    let width = header.width; let height = header.height

    let offsetX = Math.floor((nativeWidth - width) / 2)
    let offsetY = Math.floor((nativeHeight - height) / 2)

    let sampleStepX = Math.max(8, Math.floor(width / 18))
    let sampleStepY = Math.max(8, Math.floor(height / 17))
    let borderMargin = Math.min(8, Math.floor(width / 70))

    for (let x = borderMargin; x < width - borderMargin; x += sampleStepX) {
        samples.push(getRGBfromScr(x + offsetX, borderMargin + offsetY))
        samples.push(getRGBfromScr(x + offsetX, height - borderMargin - 1 + offsetY))
    }

    for (let y = borderMargin; y < height - borderMargin; y += sampleStepY) {
        samples.push(getRGBfromScr(borderMargin + offsetX, y + offsetY))
        samples.push(getRGBfromScr(width - borderMargin - 1 + offsetX, y + offsetY))
    }

    let out = [0.0, 0.0, 0.0]
    samples.forEach(rgb=>{
        out[0] += rgb[0]
        out[1] += rgb[1]
        out[2] += rgb[2]
    })
    out[0] = BIAS_LIGHTING_MIN + (out[0] / samples.length / 2.0)
    out[1] = BIAS_LIGHTING_MIN + (out[1] / samples.length / 2.0)
    out[2] = BIAS_LIGHTING_MIN + (out[2] / samples.length / 2.0)

    let bgr = (oldBgcol[0]*5 + out[0]) / 6.0
    let bgg = (oldBgcol[1]*5 + out[1]) / 6.0
    let bgb = (oldBgcol[2]*5 + out[2]) / 6.0

    oldBgcol = [bgr, bgg, bgb]

    graphics.setBackground(Math.round(bgr * 255), Math.round(bgg * 255), Math.round(bgb * 255))
}

function updateDataRateBin(rate) {
    videoRateBin.push(rate)
    if (videoRateBin.length > 10) {
        videoRateBin.shift()
    }
}

function getVideoRate() {
    let baseRate = videoRateBin.reduce((a, c) => a + c, 0)
    let mult = header.fps / videoRateBin.length
    return baseRate * mult
}

let FRAME_TIME = 1.0 / header.fps

let frameCount = 0 
let trueFrameCount = 0
let stopPlay = false
let akku = FRAME_TIME
let akku2 = 0.0
let nextFrameTime = 0  // Absolute time when next frame should display (nanoseconds)
let currentFileIndex = 1  // Track which file we're playing in concatenated stream
let totalFilesProcessed = 0
let decoderDbgInfo = {}

// GOP triple-buffering state (3 slots: playing, ready, decoding)
let currentGopBufferSlot = 0  // Which buffer slot is currently being displayed (0, 1, or 2)
let currentGopSize = 0         // Number of frames in current GOP being displayed
let currentGopFrameIndex = 0   // Which frame of current GOP we're displaying
let readyGopData = null        // GOP that's already decoded and ready to play (next in line)
let decodingGopData = null     // GOP currently being decoded in background
let asyncDecodeInProgress = false  // Track if async decode is running
let asyncDecodeSlot = 0        // Which slot the async decode is targeting

// I-frame (non-GOP) timing control
let iframeReady = false        // Track if an I-frame/P-frame is decoded and ready to display
let asyncDecodeGopSize = 0     // Size of GOP being decoded async
let asyncDecodePtr = 0         // Compressed data pointer to free after decode
let asyncDecodeStartTime = 0   // When async decode started (for diagnostics)
let shouldReadPackets = true   // Gate packet reading: false when all 3 buffers are full

// Pre-decoded audio state (for bundled audio packet 0x40)
let predecodedPcmBuffer = null  // Buffer holding pre-decoded PCM data
let predecodedPcmSize = 0       // Total size of pre-decoded PCM
let predecodedPcmOffset = 0     // Current position in PCM buffer for streaming
const PCM_UPLOAD_CHUNK = 2304   // Upload 1152 stereo samples per chunk (one MP2 frame worth)

let cueElements = []
let currentCueIndex = -1  // Track current cue position
let iframePositions = []  // Track I-frame positions for seeking: [{offset, frameNum}]

// Helper function to clean up async decode state (prevents memory leaks)
function cleanupAsyncDecode() {
    // Free first GOP decode memory if in progress
    if (asyncDecodeInProgress && asyncDecodePtr && asyncDecodePtr !== 0) {
        sys.free(asyncDecodePtr)
        asyncDecodeInProgress = false
        asyncDecodePtr = 0
        asyncDecodeGopSize = 0
    }

    // Free ready GOP memory if present
    if (readyGopData !== null && readyGopData.compressedPtr && readyGopData.compressedPtr !== 0) {
        sys.free(readyGopData.compressedPtr)
        readyGopData.compressedPtr = 0
    }
    readyGopData = null

    // Free decoding GOP memory if present
    if (decodingGopData !== null && decodingGopData.compressedPtr && decodingGopData.compressedPtr !== 0) {
        sys.free(decodingGopData.compressedPtr)
        decodingGopData.compressedPtr = 0
    }
    decodingGopData = null

    // Free pre-decoded PCM buffer if present
    if (predecodedPcmBuffer !== null) {
        sys.free(predecodedPcmBuffer)
        predecodedPcmBuffer = null
        predecodedPcmSize = 0
        predecodedPcmOffset = 0
    }

    // Reset GOP playback state
    currentGopSize = 0
    currentGopFrameIndex = 0
    nextFrameTime = 0  // Reset frame timing
    shouldReadPackets = true  // Resume packet reading after cleanup
}

// Function to find nearest I-frame before or at target frame
function findNearestIframe(targetFrame) {
    if (iframePositions.length === 0) return null

    // Find the largest I-frame position <= targetFrame
    let result = null
    for (let i = iframePositions.length - 1; i >= 0; i--) {
        if (iframePositions[i].frameNum <= targetFrame) {
            result = iframePositions[i]
            break
        }
    }

    // If targetFrame is before first I-frame, return first I-frame
    return result || iframePositions[0]
}

// Function to scan forward and find next I-frame at or after target frame
function scanForwardToIframe(targetFrame, currentPos) {
    // Save current position
    let savedPos = seqread.getReadCount()

    try {
        let scanFrameCount = frameCount

        // Scan forward through packets
        while (seqread.getReadCount() < FILE_LENGTH) {
            let packetPos = seqread.getReadCount()
            let pType = seqread.readOneByte()

            // Handle sync packets (increment frame counter)
            if (pType === TAV_PACKET_SYNC || pType === TAV_PACKET_SYNC_NTSC) {
                if (pType === TAV_PACKET_SYNC) {
                    scanFrameCount++
                }
                continue
            }

            // Found I-frame at or after target?
            if (pType === TAV_PACKET_IFRAME && scanFrameCount >= targetFrame) {
                // Record this I-frame position for future use
                iframePositions.push({offset: packetPos, frameNum: scanFrameCount})
                return {offset: packetPos, frameNum: scanFrameCount}
            }

            // Skip over packet payload (all non-sync packets have uint32 size)
            if (pType !== TAV_PACKET_SYNC && pType !== TAV_PACKET_SYNC_NTSC && pType !== TAV_FILE_HEADER_FIRST) {
                let payloadSize = seqread.readInt()
                seqread.skip(payloadSize)
            } else if (pType === TAV_FILE_HEADER_FIRST) {
                // Hit next file header, stop scanning
                break
            }
        }

        // Didn't find I-frame, restore position
        return null

    } catch (e) {
        // Error or EOF during scan
        serial.printerr(`Scan error: ${e}`)
        return null
    } finally {
        // Restore original position
        seqread.seek(savedPos)
    }
}

// Function to try reading next TAV file header at current position
function tryReadNextTAVHeader() {
    // Save current position
    let currentPos = seqread.getReadCount()

    // Try to read magic number
    let newMagic = new Array(7)
    try {
        for (let i = 0; i < newMagic.length; i++) {
            newMagic[i] = seqread.readOneByte()
        }

        // compensating the old encoder emitting extra sync packets
        while (newMagic[0] == 255) {
            newMagic.shift(); newMagic[newMagic.length - 1] = seqread.readOneByte()
        }

        // Check if it matches TAV magic
        let isValidTAV = true
        let isValidUCF = true
        for (let i = 0; i < newMagic.length; i++) {
            if (newMagic[i] !== TAV_MAGIC[i+1]) {
                isValidTAV = false
            }
        }
        for (let i = 0; i < newMagic.length; i++) {
            if (newMagic[i] !== UCF_MAGIC[i+1]) {
                isValidUCF = false
            }
        }

        if (!isValidTAV && !isValidUCF) {
            serial.printerr("Header mismatch: got "+newMagic.join())
            return 1
        }


        if (isValidTAV) {
            serial.println("Got next video file")

            // Read the rest of the header
            let newHeader = {
                magic: newMagic,
                version: seqread.readOneByte(),
                width: seqread.readShort(),
                height: seqread.readShort(),
                fps: seqread.readOneByte(),
                totalFrames: seqread.readInt(),
                waveletFilter: seqread.readOneByte(),
                decompLevels: seqread.readOneByte(),
                qualityY: seqread.readOneByte(),
                qualityCo: seqread.readOneByte(),
                qualityCg: seqread.readOneByte(),
                extraFlags: seqread.readOneByte(),
                videoFlags: seqread.readOneByte(),
                qualityLevel: seqread.readOneByte(),
                channelLayout: seqread.readOneByte(),
                fileRole: seqread.readOneByte(),
                reserved: new Array(4)
            }

            serial.println("File header: " + JSON.stringify(newHeader))

            // Skip reserved bytes
            for (let i = 0; i < 4; i++) {
                seqread.readOneByte()
            }

            return newHeader
        }
        else if (isValidUCF) {
            serial.println("Got Universal Cue Format")

            // TODO read and store the cue, then proceed to read next TAV packet (should be 0x1F)
            let version = seqread.readOneByte()
            if (version !== UCF_VERSION) {
                serial.println(`Error: Unsupported UCF version: ${version} (expected ${UCF_VERSION})`)
                return 2
            }

            let numElements = seqread.readShort()
            let cueSize = seqread.readInt()
            seqread.skip(1)

            serial.println(`UCF Version: ${version}, Elements: ${numElements}`)

            // Parse cue elements
            for (let i = 0; i < numElements; i++) {
                let element = {}

                element.addressingModeAndIntent = seqread.readOneByte()
                element.addressingMode = element.addressingModeAndIntent & 15
                let nameLength = seqread.readShort()
                element.name = seqread.readString(nameLength)

                if (element.addressingMode === ADDRESSING_EXTERNAL) {
                    let pathLength = seqread.readShort()
                    element.path = seqread.readString(pathLength)
                    serial.println(`Element ${i + 1}: ${element.name} -> ${element.path} (external)`)
                } else if (element.addressingMode === ADDRESSING_INTERNAL) {
                    // Read 48-bit offset (6 bytes, little endian)
                    let offsetBytes = []
                    for (let j = 0; j < 6; j++) {
                        offsetBytes.push(seqread.readOneByte())
                    }

                    // Split into low 32 bits and high 16 bits
                    let low32 = 0
                    for (let j = 0; j < 4; j++) {
                        low32 |= (offsetBytes[j] << (j * 8))
                    }

                    let high16 = 0
                    for (let j = 4; j < 6; j++) {
                        high16 |= (offsetBytes[j] << ((j - 4) * 8))
                    }

                    // Combine using multiplication (avoids bitwise 32-bit limit)
                    element.offset = (high16 * 0x100000000) + (low32 >>> 0)

                    serial.println(`Element ${i + 1}: ${element.name} -> offset ${element.offset} (internal)`)
                } else {
                    serial.println(`Error: Unknown addressing mode: ${element.addressingMode}`)
                    return 5
                }

                cueElements.push(element)
            }

            // skip zeros
            let readCount = seqread.getReadCount()
            serial.println(`Skip to first video (${readCount} -> ${cueSize})`)
            seqread.skip(cueSize - readCount + 1)
            currentFileIndex -= 1
            return tryReadNextTAVHeader()
        }
        else {
            serial.printerr("File not TAV/UCF. Magic: " + newMagic.join())
            return 7
        }
    } catch (e) {
        serial.printerr(e)

        // EOF or read error - restore position and return null
        // Note: seqread doesn't have seek, so we can't restore position
        // This is okay since we're at EOF anyway
    }

    return null
}

let lastKey = 0
let skipped = false
let paused = false
let debugPrintAkku = 0

// Playback loop - properly adapted from TEV with multi-file support
try {
    let t1 = sys.nanoTime()

    // Continue loop while:
    // 1. Reading packets (not EOF yet), OR
    // 2. There are buffered GOPs to play (after EOF)
    while (!stopPlay && (seqread.getReadCount() < FILE_LENGTH || currentGopSize > 0 || readyGopData !== null || decodingGopData !== null || asyncDecodeInProgress)) {


        // Handle interactive controls
        if (interactive) {
            sys.poke(-40, 1)
            let keyCode = sys.peek(-41)

            if (!lastKey) {
                if (keyCode == 67) { // Backspace
                    stopPlay = true
                    break
                }
                else if (keyCode == 62) { // SPACE - pause/resume
                    paused = !paused
                    if (paused) {
                        audio.stop(0)
                        serial.println(`Paused at frame ${frameCount}`)
                    } else {
                        audio.play(0)
                        serial.println(`Resumed`)
                    }
                }
                else if (keyCode == 19 && cueElements.length > 0) { // Up arrow - previous cue
                    currentCueIndex = (currentCueIndex <= 0) ? cueElements.length - 1 : currentCueIndex - 1
                    let cue = cueElements[currentCueIndex]

                    if (cue.addressingMode === ADDRESSING_INTERNAL) {
                        serial.println(`Seeking to cue: ${cue.name} (offset ${cue.offset})`)
                        cleanupAsyncDecode()  // Free any pending async decode memory
                        seqread.seek(cue.offset)
                        frameCount = 0
                        akku = FRAME_TIME
                        akku2 = 0.0
                        audio.purgeQueue(0)
                        if (paused) {
                            audio.play(0)
                            audio.stop(0)
                        }
                        skipped = true
                    }
                }
                else if (keyCode == 20 && cueElements.length > 0) { // Down arrow - next cue
                    currentCueIndex = (currentCueIndex >= cueElements.length - 1) ? 0 : currentCueIndex + 1
                    let cue = cueElements[currentCueIndex]

                    if (cue.addressingMode === ADDRESSING_INTERNAL) {
                        serial.println(`Seeking to cue: ${cue.name} (offset ${cue.offset})`)
                        cleanupAsyncDecode()  // Free any pending async decode memory
                        seqread.seek(cue.offset)
                        frameCount = 0
                        akku = FRAME_TIME
                        akku2 = 0.0
                        audio.purgeQueue(0)
                        if (paused) {
                            audio.play(0)
                            audio.stop(0)
                        }
                        skipped = true
                    }
                }
                else if (keyCode == 21) { // Left arrow - seek back 5.5s
                    let targetFrame = Math.max(0, frameCount - Math.floor(header.fps * 5.5))
                    let seekTarget = findNearestIframe(targetFrame)

                    if (seekTarget) {
                        serial.println(`Seeking back to frame ${seekTarget.frameNum} (offset ${seekTarget.offset})`)
                        cleanupAsyncDecode()  // Free any pending async decode memory
                        seqread.seek(seekTarget.offset)
                        frameCount = seekTarget.frameNum
                        akku = FRAME_TIME
                        akku2 -= 5.5
                        audio.purgeQueue(0)
                        if (paused) {
                            audio.play(0)
                            audio.stop(0)
                        }
                        skipped = true
                    }
                }
                else if (keyCode == 22) { // Right arrow - seek forward 5s
                    let targetFrame = Math.min(header.totalFrames - 1, frameCount + Math.floor(header.fps * 5.0))

                    // Try to find in already-decoded I-frames first
                    let seekTarget = findNearestIframe(targetFrame)

                    // If not found or behind current position, scan forward
                    if (!seekTarget || seekTarget.frameNum <= frameCount) {
                        serial.println(`Scanning forward for I-frame near frame ${targetFrame}...`)
                        seekTarget = scanForwardToIframe(targetFrame, seqread.getReadCount())
                    }

                    if (seekTarget && seekTarget.frameNum > frameCount) {
                        serial.println(`Seeking forward to frame ${seekTarget.frameNum} (offset ${seekTarget.offset})`)
                        cleanupAsyncDecode()  // Free any pending async decode memory
                        seqread.seek(seekTarget.offset)
                        frameCount = seekTarget.frameNum
                        akku = FRAME_TIME
                        akku2 += 5.0
                        audio.purgeQueue(0)
                        if (paused) {
                            audio.play(0)
                            audio.stop(0)
                        }
                        skipped = true
                    } else if (!seekTarget) {
                        serial.println(`No I-frame found ahead`)
                    }
                }
            }

            lastKey = keyCode
        }

        // GATED PACKET READING
        // Stop reading when all 3 buffers are full (GOP playing + ready GOP + decoding GOP)
        // Resume reading when GOP finishes (one buffer becomes free)
        // Also stop reading at EOF
        if (shouldReadPackets && !paused && seqread.getReadCount() < FILE_LENGTH) {
            // Read packet header (record position before reading for I-frame tracking)
            let packetOffset = seqread.getReadCount()
            var packetType = seqread.readOneByte()

//            serial.println(`Packet ${packetType} at offset ${seqread.getReadCount() - 1}`)

            // Try to read next TAV file header
            if (packetType == TAV_FILE_HEADER_FIRST) {
                let nextHeader = tryReadNextTAVHeader()
                if (nextHeader) {
                    // Found another TAV file - update header and reset counters
                    header = nextHeader
                    frameCount = 0
                    akku = 0.0
                    akku2 = 0.0
                    FRAME_TIME = 1.0 / header.fps
                    audio.purgeQueue(0)
                    currentFileIndex++
                    if (skipped) {
                        skipped = false
                    } else {
                        currentCueIndex++
                    }
                    totalFilesProcessed++

                    console.log(`\nStarting file ${currentFileIndex}:`)
                    console.log(`Resolution: ${header.width}x${header.height}`)
                    console.log(`FPS: ${header.fps}`)
                    console.log(`Total frames: ${header.totalFrames}`)
                    console.log(`Wavelet filter: ${header.waveletFilter === WAVELET_5_3_REVERSIBLE ? "5/3 reversible" : header.waveletFilter === WAVELET_9_7_IRREVERSIBLE ? "9/7 irreversible" : header.waveletFilter === WAVELET_BIORTHOGONAL_13_7 ? "Biorthogonal 13/7" : header.waveletFilter === WAVELET_DD4 ? "DD-4" : header.waveletFilter === WAVELET_HAAR ? "Haar" : "unknown"}`)
                    console.log(`Quality: Y=${header.qualityY}, Co=${header.qualityCo}, Cg=${header.qualityCg}`)

                    // Continue with new file
                    packetType = seqread.readOneByte()
                }
                else {
                    serial.printerr("Header read failed: " + JSON.stringify(nextHeader))
                    break
                }
            }

            if (packetType === TAV_PACKET_SYNC || packetType == TAV_PACKET_SYNC_NTSC) {
                // Sync packet - no additional data (for I/P frames, not GOPs)
                akku -= FRAME_TIME
                if (packetType == TAV_PACKET_SYNC) {
                    frameCount++
                }

                trueFrameCount++

                // Swap ping-pong buffers
                let temp = CURRENT_RGB_ADDR
                CURRENT_RGB_ADDR = PREV_RGB_ADDR
                PREV_RGB_ADDR = temp

            }
            else if (packetType === TAV_PACKET_IFRAME || packetType === TAV_PACKET_PFRAME) {
                // Record I-frame position for seeking
                if (packetType === TAV_PACKET_IFRAME) {
                    iframePositions.push({offset: packetOffset, frameNum: frameCount})
                }

                // Video packet
                const compressedSize = seqread.readInt()

                // Read compressed tile data
                let compressedPtr = seqread.readBytes(compressedSize)
                updateDataRateBin(compressedSize)

                try {
                    let decodeStart = sys.nanoTime()

                    // For interlaced mode, decode to field buffer at half height
                    let decodeTarget = isInterlaced ? currentFieldAddr : CURRENT_RGB_ADDR

                    // Debug interlaced mode
                    if (frameCount === 0 && isInterlaced) {
                        serial.println(`[DEBUG] Interlaced mode active:`)
                        serial.println(`  decodeHeight: ${decodeHeight}`)
                        serial.println(`  currentFieldAddr: ${currentFieldAddr}`)
                        serial.println(`  prevFieldAddr: ${prevFieldAddr}`)
                        serial.println(`  nextFieldAddr: ${nextFieldAddr}`)
                        serial.println(`  FIELD_SIZE: ${FIELD_SIZE}`)
                    }

                    // grain synthesis is now part of the spec
                    // TODO if filmGrainLevel != null, user requested custom film grain level

                    // Call new TAV hardware decoder that handles Zstd decompression internally
                    // Note: No longer using JS gzip.decompFromTo - Kotlin handles Zstd natively
                    decoderDbgInfo = graphics.tavDecodeCompressed(
                        compressedPtr,             // Pass compressed data directly
                        compressedSize,            // Size of compressed data
                        decodeTarget, PREV_RGB_ADDR,  // RGB buffer pointers (field buffer for interlaced)
                        header.width, decodeHeight,   // Use half height for interlaced
                        header.qualityLevel, QLUT[header.qualityY], QLUT[header.qualityCo], QLUT[header.qualityCg],
                        header.channelLayout,      // Channel layout for variable processing
                        trueFrameCount,
                        header.waveletFilter,      // TAV-specific parameter
                        header.decompLevels,       // TAV-specific parameter
                        isLossless,
                        header.version,            // TAV version for colour space detection
                        header.entropyCoder        // Entropy coder: 0 = Twobit-map, 1 = EZBC
                    )

                    decodeTime = (sys.nanoTime() - decodeStart) / 1000000.0
                    decompressTime = 0  // Decompression time now included in decode time

                    // For interlaced: deinterlace fields into full frame, otherwise upload directly
                    let uploadStart = sys.nanoTime()
                    if (isInterlaced) {
                        if (frameCount === 0) {
                            serial.println(`[DEBUG] Calling tavDeinterlace for first frame`)
                        }
                        // Weave fields using temporal deinterlacing (yadif algorithm)
                        try {
                            graphics.tavDeinterlace(trueFrameCount, header.width, decodeHeight,
                                                    prevFieldAddr, currentFieldAddr, nextFieldAddr,
                                                    CURRENT_RGB_ADDR, "yadif")
                            if (frameCount === 0) {
                                serial.println(`[DEBUG] tavDeinterlace succeeded`)
                            }
                        } catch (deinterlaceError) {
                            serial.printerr(`[ERROR] tavDeinterlace failed: ${deinterlaceError}`)
                            serial.printerr(`  frame: ${trueFrameCount}, width: ${header.width}, height: ${decodeHeight}`)
                            serial.printerr(`  prevField: ${prevFieldAddr}, currField: ${currentFieldAddr}, nextField: ${nextFieldAddr}`)
                            throw deinterlaceError
                        }

                        // Rotate field buffers for next frame: NEXT -> CURRENT -> PREV
                        let tempField = prevFieldAddr
                        prevFieldAddr = currentFieldAddr
                        currentFieldAddr = nextFieldAddr
                        nextFieldAddr = tempField
                    } else {
                        if (frameCount === 0) {
                            serial.println(`[DEBUG] Progressive mode - no deinterlacing`)
                        }
                    }

                    // Don't upload immediately - let timing loop handle it
                    // Mark frame as ready for time-based display
                    iframeReady = true
                    uploadTime = 0  // Upload will happen in timing section below

                } catch (e) {
                    console.log(`Frame ${frameCount}: decode failed: ${e}`)
                } finally {
                    sys.free(compressedPtr)
                }

            }
            else if (packetType === TAV_PACKET_GOP_UNIFIED) {
                // GOP Unified packet (temporal 3D DWT)
                // DOUBLE-BUFFERING: Decode GOP N+1 while playing GOP N to eliminate hiccups

                // Read GOP packet data
                const gopSize = seqread.readOneByte()
                const compressedSize = seqread.readInt()
                let compressedPtr = seqread.readBytes(compressedSize)
                updateDataRateBin(compressedSize)

                // TRIPLE-BUFFERING LOGIC (3 slots: playing, ready, decoding):
                // - If no GOP playing: decode first GOP to slot 0
                // - If GOP playing but no ready GOP: decode to ready slot (next in rotation)
                // - If GOP playing and ready GOP exists but no decoding: decode to decoding slot
                // - Otherwise: all 3 buffers full, ignore packet

                // Check GOP size fits in slot
                if (gopSize > MAX_GOP_SIZE) {
                    console.log(`[GOP] Error: GOP size ${gopSize} exceeds max ${MAX_GOP_SIZE} frames`)
                    sys.free(compressedPtr)
                    break
                }

                if (currentGopSize === 0 && !asyncDecodeInProgress) {
                    // Case 1: No active GOP and no decode in progress - decode first GOP
                    const bufferSlot = currentGopBufferSlot
                    const bufferOffset = bufferSlot * SLOT_SIZE

                    // Defensive: free any old async decode memory
                    if (asyncDecodePtr !== 0) {
                        sys.free(asyncDecodePtr)
                        asyncDecodePtr = 0
                    }

                    // Start async decode
                    graphics.tavDecodeGopToVideoBufferAsync(
                        compressedPtr, compressedSize, gopSize,
                        header.width, header.height,
                        header.qualityLevel,
                        QLUT[header.qualityY], QLUT[header.qualityCo], QLUT[header.qualityCg],
                        header.channelLayout,
                        header.waveletFilter, header.decompLevels, 2,
                        header.entropyCoder,
                        bufferOffset
                    )

                    asyncDecodeInProgress = true
                    asyncDecodeSlot = bufferSlot
                    asyncDecodeGopSize = gopSize
                    asyncDecodePtr = compressedPtr
                    asyncDecodeStartTime = sys.nanoTime()

                } else if (currentGopSize === 0 && asyncDecodeInProgress) {
                    // Case 2: First GOP still decoding - buffer GOPs without starting decode
                    // These will be decoded once playback starts
                    if (readyGopData === null) {
                        // Buffer as ready GOP (will decode when first GOP finishes)
                        const nextSlot = (currentGopBufferSlot + 1) % BUFFER_SLOTS
                        readyGopData = {
                            gopSize: gopSize,
                            slot: nextSlot,
                            compressedPtr: compressedPtr,
                            compressedSize: compressedSize,
                            needsDecode: true,  // Flag that decode hasn't started yet
                            startTime: 0,
                            timeRemaining: 0
                        }
                        if (interactive) {
                            console.log(`[GOP] Buffered GOP ${gopSize} frames to ready slot during first GOP decode`)
                        }
                    } else if (decodingGopData === null) {
                        // Buffer as decoding GOP (will decode after ready GOP)
                        const decodingSlot = (currentGopBufferSlot + 2) % BUFFER_SLOTS
                        decodingGopData = {
                            gopSize: gopSize,
                            slot: decodingSlot,
                            compressedPtr: compressedPtr,
                            compressedSize: compressedSize,
                            needsDecode: true,  // Flag that decode hasn't started yet
                            startTime: 0,
                            timeRemaining: 0
                        }
                        if (interactive) {
                            console.log(`[GOP] Buffered GOP ${gopSize} frames to decoding slot during first GOP decode`)
                        }

                        // CRITICAL: Stop reading packets now that all 3 buffers are full
                        shouldReadPackets = false
                        if (interactive) {
                            console.log(`[GOP] All 3 buffers full during first GOP decode - stopping packet reading`)
                        }
                    } else {
                        // All 3 buffers full - discard this GOP (shouldn't happen now with gate)
                        if (interactive) {
                            console.log(`[GOP] WARNING: All 3 buffers full during first GOP decode - discarding GOP ${gopSize} frames`)
                        }
                        sys.free(compressedPtr)
                    }

                } else if (currentGopSize > 0 && readyGopData === null && !asyncDecodeInProgress && graphics.tavDecodeGopIsComplete()) {
                    // Case 3: GOP playing, no ready GOP, no decode in progress - decode to ready slot
                    const nextSlot = (currentGopBufferSlot + 1) % BUFFER_SLOTS
                    const nextOffset = nextSlot * SLOT_SIZE

                    const framesRemaining = currentGopSize - currentGopFrameIndex
                    const timeRemaining = framesRemaining * FRAME_TIME * 1000.0

                    // Start async decode to ready slot
                    graphics.tavDecodeGopToVideoBufferAsync(
                        compressedPtr, compressedSize, gopSize,
                        header.width, header.height,
                        header.qualityLevel,
                        QLUT[header.qualityY], QLUT[header.qualityCo], QLUT[header.qualityCg],
                        header.channelLayout,
                        header.waveletFilter, header.decompLevels, 2,
                        header.entropyCoder,
                        nextOffset
                    )

                    // Set async decode tracking variables
                    asyncDecodeInProgress = true
                    asyncDecodeSlot = nextSlot
                    asyncDecodeGopSize = gopSize
                    asyncDecodePtr = compressedPtr
                    asyncDecodeStartTime = sys.nanoTime()

                    readyGopData = {
                        gopSize: gopSize,
                        slot: nextSlot,
                        compressedPtr: compressedPtr,
                        startTime: asyncDecodeStartTime,
                        timeRemaining: timeRemaining
                    }

                    // CRITICAL: Stop reading packets immediately after starting decode
                    // to prevent next GOP from being discarded in Case 5
                    shouldReadPackets = false
                    if (interactive) {
                        console.log(`[GOP] Case 3: Started decode to ready slot - stopping packet reading`)
                    }

                } else if (currentGopSize > 0 && readyGopData !== null && decodingGopData === null && !asyncDecodeInProgress && graphics.tavDecodeGopIsComplete()) {
                    // Case 4: GOP playing, ready GOP exists, no decoding GOP, no decode in progress - decode to decoding slot
                    const decodingSlot = (currentGopBufferSlot + 2) % BUFFER_SLOTS
                    const decodingOffset = decodingSlot * SLOT_SIZE

                    const framesRemaining = currentGopSize - currentGopFrameIndex
                    const timeRemaining = framesRemaining * FRAME_TIME * 1000.0

                    // Start async decode to decoding slot
                    graphics.tavDecodeGopToVideoBufferAsync(
                        compressedPtr, compressedSize, gopSize,
                        header.width, header.height,
                        header.qualityLevel,
                        QLUT[header.qualityY], QLUT[header.qualityCo], QLUT[header.qualityCg],
                        header.channelLayout,
                        header.waveletFilter, header.decompLevels, 2,
                        header.entropyCoder,
                        decodingOffset
                    )

                    // Set async decode tracking variables
                    asyncDecodeInProgress = true
                    asyncDecodeSlot = decodingSlot
                    asyncDecodeGopSize = gopSize
                    asyncDecodePtr = compressedPtr
                    asyncDecodeStartTime = sys.nanoTime()

                    decodingGopData = {
                        gopSize: gopSize,
                        slot: decodingSlot,
                        compressedPtr: compressedPtr,
                        startTime: asyncDecodeStartTime,
                        timeRemaining: timeRemaining
                    }

                    // CRITICAL: Stop reading packets immediately after starting decode
                    // All 3 buffers are now full (playing + ready + decoding)
                    shouldReadPackets = false
                    if (interactive) {
                        console.log(`[GOP] Case 4: Started decode to decoding slot - all buffers full, stopping packet reading`)
                    }

                } else {
                    // Case 5: All 3 buffers full (playing + ready + decoding) - ignore packet
                    if (interactive) {
                        console.log(`[GOP] Case 5: Discarding GOP ${gopSize} frames (current=${currentGopSize}, ready=${readyGopData !== null}, decoding=${decodingGopData !== null}, asyncInProgress=${asyncDecodeInProgress})`)
                    }
                    sys.free(compressedPtr)
                }
            }
            else if (packetType === TAV_PACKET_GOP_SYNC) {
                // GOP sync packet - just skip it, frame display is time-based
                const framesInGOP = seqread.readOneByte()
                // Ignore - we display frames based on time accumulator, not this packet

                // CRITICAL: Stop reading packets if all 3 buffers are full
                // (one GOP playing + ready GOP + decoding GOP)
                if (currentGopSize > 0 && readyGopData !== null && decodingGopData !== null) {
                    shouldReadPackets = false
                    if (interactive) {
                        console.log(`[GOP] All 3 buffers full - stopping packet reading`)
                    }
                }
            }
            else if (packetType === TAV_PACKET_AUDIO_BUNDLED) {
                // Bundled audio packet - entire MP2 file pre-decoded to PCM
                // This removes MP2 decoding from the frame timing loop
                let totalAudioSize = seqread.readInt()

                if (!mp2Initialised) {
                    mp2Initialised = true
                    audio.mp2Init()
                }

                if (interactive) {
                    serial.println(`Pre-decoding ${(totalAudioSize / 1024).toFixed(1)} KB of MP2 audio...`)
                }

                // Allocate temporary buffer for MP2 data
                let mp2Buffer = sys.malloc(totalAudioSize)
                seqread.readBytes(totalAudioSize, mp2Buffer)

                // Estimate PCM size: MP2 ~10:1 compression ratio, so PCM ~10x larger
                // Each MP2 frame decodes to 2304 bytes PCM (1152 stereo 16-bit samples)
                // Allocate generous buffer (12x MP2 size to be safe)
                const estimatedPcmSize = totalAudioSize * 12
                predecodedPcmBuffer = sys.malloc(estimatedPcmSize)
                predecodedPcmSize = 0
                predecodedPcmOffset = 0

                // Decode entire MP2 file to PCM
                const MP2_DECODE_CHUNK = 2304  // ~2 MP2 frames at 192kbps
                let srcOffset = 0

                while (srcOffset < totalAudioSize) {
                    let remaining = totalAudioSize - srcOffset
                    let chunkSize = Math.min(MP2_DECODE_CHUNK, remaining)

                    // Copy MP2 chunk to audio peripheral decode buffer
                    sys.memcpy(mp2Buffer + srcOffset, SND_BASE_ADDR - 2368, chunkSize)

                    // Decode to PCM (goes to SND_BASE_ADDR)
                    audio.mp2Decode()

                    // Copy decoded PCM from peripheral to our storage buffer
                    // Each decode produces 2304 bytes of PCM
                    sys.memcpy(SND_BASE_ADDR, predecodedPcmBuffer + predecodedPcmSize, 2304)
                    predecodedPcmSize += 2304

                    srcOffset += chunkSize
                }

                // Free MP2 buffer (no longer needed)
                sys.free(mp2Buffer)

                if (interactive) {
                    serial.println(`Pre-decoded ${(predecodedPcmSize / 1024).toFixed(1)} KB PCM (from ${(totalAudioSize / 1024).toFixed(1)} KB MP2)`)
                }

            }
            else if (packetType === TAV_PACKET_AUDIO_MP2) {
                // Legacy MP2 Audio packet (for backwards compatibility)
                let audioLen = seqread.readInt()

                if (!mp2Initialised) {
                    mp2Initialised = true
                    audio.mp2Init()
                }

                seqread.readBytes(audioLen, SND_BASE_ADDR - 2368)
                audio.mp2Decode()
                audio.mp2UploadDecoded(0)

            }
            else if (packetType === TAV_PACKET_AUDIO_NATIVE) {
                // PCM length must not exceed 65536 bytes!
                let zstdLen = seqread.readInt()
                let zstdPtr = sys.malloc(zstdLen)
                seqread.readBytes(zstdLen, zstdPtr)
//                serial.println(`PCM8 audio (${zstdLen} -> ????)`)
                let pcmPtr = sys.malloc(65536) //SND_BASE_ADDR - 65536
                let pcmLen = gzip.decompFromTo(zstdPtr, zstdLen, pcmPtr) // <- segfaults!
                if (pcmLen > 65536) throw Error(`PCM data too long -- got ${pcmLen} bytes`)

                audio.putPcmDataByPtr(pcmPtr, pcmLen, 0)

                audio.setSampleUploadLength(0, pcmLen)
                audio.startSampleUpload(0)
                sys.free(zstdPtr)

                sys.free(pcmPtr)
            }
            else if (packetType === TAV_PACKET_SUBTITLE) {
                // Subtitle packet - same format as TEV
                let packetSize = seqread.readInt()
                processSubtitlePacket(packetSize)
            }
            else if (packetType === TAV_PACKET_EXTENDED_HDR) {
                // Extended header packet - metadata key-value pairs
                let numPairs = seqread.readShort()

                if (interactive) {
                    serial.println(`[EXTENDED HEADER] ${numPairs} key-value pairs:`)
                }

                for (let i = 0; i < numPairs; i++) {
                    // Read key (4 bytes)
                    let keyBytes = seqread.readBytes(4)
                    let key = ""
                    for (let j = 0; j < 4; j++) {
                        key += String.fromCharCode(sys.peek(keyBytes + j))
                    }
                    sys.free(keyBytes)

                    // Read value type
                    let valueType = seqread.readOneByte()

                    if (valueType === 0x04) {  // Uint64
                        let valueLow = seqread.readInt()
                        let valueHigh = seqread.readInt()
                        // Combine into 64-bit value (JS uses double, loses precision beyond 2^53)
                        let value = valueHigh * 0x100000000 + (valueLow >>> 0)

                        if (interactive) {
                            if (key === "CDAT") {
                                // Creation date - convert to human readable
                                let seconds = Math.floor(value / 1000000000)
                                let date = new Date(seconds * 1000)
                                serial.println(`  ${key}: ${date.toISOString()}`)
                            } else {
                                // BGNT/ENDT - show as seconds
                                serial.println(`  ${key}: ${(value / 1000000000).toFixed(6)}s`)
                            }
                        }
                    } else if (valueType === 0x10) {  // Bytes
                        let length = seqread.readShort()
                        let dataBytes = seqread.readBytes(length)
                        let dataStr = ""
                        for (let j = 0; j < length; j++) {
                            dataStr += String.fromCharCode(sys.peek(dataBytes + j))
                        }
                        sys.free(dataBytes)

                        if (interactive) {
                            serial.println(`  ${key}: "${dataStr}"`)
                        }
                    } else {
                        if (interactive) {
                            serial.println(`  ${key}: Unknown type 0x${valueType.toString(16)}`)
                        }
                    }
                }
            }
            else if (packetType === TAV_PACKET_TIMECODE) {
                // Timecode packet - time since stream start in nanoseconds
                let timecodeLow = seqread.readInt()
                let timecodeHigh = seqread.readInt()
                let timecodeNs = timecodeHigh * 0x100000000 + (timecodeLow >>> 0)

                // Optionally display timecode in interactive mode (can be verbose)
                // Uncomment for debugging:
//                if (interactive && frameCount % 60 === 0) {
//                    serial.println(`[TIMECODE] Frame ${frameCount}: ${(timecodeNs / 1000000000).toFixed(6)}s`)
//                }
            }
            else if (packetType == 0x00) {
                // Silently discard, faulty subtitle creation can cause this as 0x00 is used as an argument terminator
            } else {
                println(`Unknown packet type: 0x${packetType.toString(16)}`)
                break
            }
        } // end of !paused packet read block

        let t2 = sys.nanoTime()
        if (!paused) {
            // Only accumulate time if we have a GOP to play
            // Don't accumulate during first GOP decode or we'll get fast playback
            if (currentGopSize > 0) {
                akku += (t2 - t1) / 1000000000.0
            }
            akku2 += (t2 - t1) / 1000000000.0
        }

        // STATE MACHINE: Explicit GOP playback with spin-waits

        // Step 1: If first GOP decode in progress AND no GOP is currently playing, wait for it
        if (asyncDecodeInProgress && currentGopSize === 0) {
            if (!graphics.tavDecodeGopIsComplete()) {
                // Spin-wait for first GOP decode (nothing else to do)
                sys.sleep(1)
            }
            else {
                // First GOP decode completed, start playback
                const [r1, r2] = graphics.tavDecodeGopGetResult()
                decodeTime = (sys.nanoTime() - asyncDecodeStartTime) / 1000000.0
                decoderDbgInfo = r2

                currentGopSize = asyncDecodeGopSize
                currentGopFrameIndex = 0
                currentGopBufferSlot = asyncDecodeSlot
                asyncDecodeInProgress = false

                // Set first frame time to NOW
                nextFrameTime = sys.nanoTime()

                // Resume packet reading only if not all 3 buffers are full
                // (might have buffered GOP 2 and 3 during GOP 1 decode)
                if (!(currentGopSize > 0 && readyGopData !== null && decodingGopData !== null)) {
                    shouldReadPackets = true
                    if (interactive) {
                        console.log(`[GOP] First GOP ready - resuming packet reading (ready=${readyGopData !== null}, decoding=${decodingGopData !== null})`)
                    }
                } else {
                    if (interactive) {
                        console.log(`[GOP] First GOP ready - all 3 buffers full, keeping packet reading paused`)
                    }
                }

//                if (interactive) {
//                    console.log(`[GOP] First GOP ready (slot ${asyncDecodeSlot}, ${asyncDecodeGopSize} frames) in ${decodeTime.toFixed(1)}ms - starting playback`)
//                }

                // Free compressed data
                sys.free(asyncDecodePtr)
                asyncDecodePtr = 0
                asyncDecodeGopSize = 0

                // Start decode of buffered ready GOP if it exists
                if (readyGopData !== null && readyGopData.needsDecode) {
                    const framesRemaining = currentGopSize - currentGopFrameIndex
                    const timeRemaining = framesRemaining * FRAME_TIME * 1000.0

                    graphics.tavDecodeGopToVideoBufferAsync(
                        readyGopData.compressedPtr, readyGopData.compressedSize, readyGopData.gopSize,
                        header.width, header.height,
                        header.qualityLevel,
                        QLUT[header.qualityY], QLUT[header.qualityCo], QLUT[header.qualityCg],
                        header.channelLayout,
                        header.waveletFilter, header.decompLevels, 2,
                        header.entropyCoder,
                        readyGopData.slot * SLOT_SIZE
                    )

                    // CRITICAL FIX: Set async decode tracking variables so decode is properly tracked
                    asyncDecodeInProgress = true
                    asyncDecodeSlot = readyGopData.slot
                    asyncDecodeGopSize = readyGopData.gopSize
                    asyncDecodePtr = readyGopData.compressedPtr
                    asyncDecodeStartTime = sys.nanoTime()

                    readyGopData.needsDecode = false
                    readyGopData.startTime = asyncDecodeStartTime
                    readyGopData.timeRemaining = timeRemaining

                    if (interactive) {
                        console.log(`[GOP] Started decode of buffered GOP ${readyGopData.gopSize} frames (slot ${readyGopData.slot})`)
                    }
                }
            }
        }

        // Fire audio on first frame
        if (!audioFired) {
            audio.play(0)
            audioFired = true
        }

        // Step 2a: Display I-frame/P-frame with proper frame timing
        if (!paused && iframeReady && currentGopSize === 0) {
            // Initialize timing on first I-frame
            if (nextFrameTime === 0) {
                nextFrameTime = sys.nanoTime()
            }

            // Spin-wait for next frame time
            while (sys.nanoTime() < nextFrameTime && !paused) {
                sys.sleep(1)
            }

            if (!paused) {
                let uploadStart = sys.nanoTime()
                graphics.uploadRGBToFramebuffer(CURRENT_RGB_ADDR, header.width, header.height, trueFrameCount, false)
                uploadTime = (sys.nanoTime() - uploadStart) / 1000000.0

                // Apply bias lighting
                let biasStart = sys.nanoTime()
                setBiasLighting()
                biasTime = (sys.nanoTime() - biasStart) / 1000000.0

                // Fire audio on first frame
                if (!audioFired) {
                    audio.play(0)
                    audioFired = true
                }

                frameCount++
                trueFrameCount++
                iframeReady = false

                // Swap ping-pong buffers for next frame
                let temp = CURRENT_RGB_ADDR
                CURRENT_RGB_ADDR = PREV_RGB_ADDR
                PREV_RGB_ADDR = temp

                // Schedule next frame
                nextFrameTime += (frametime)  // frametime is in nanoseconds from header

                // Log performance data every 60 frames
                if (frameCount % 60 == 0) {
                    console.log(`Frame ${frameCount}: Upload=${uploadTime.toFixed(1)}ms, Bias=${biasTime.toFixed(1)}ms`)
                }
            }
        }

        // Step 2 & 3: Display current GOP frame if it's time
        if (!paused && currentGopSize > 0 && currentGopFrameIndex < currentGopSize) {
            // Spin-wait for next frame time
            while (sys.nanoTime() < nextFrameTime && !paused) {
                sys.sleep(1)
            }

            if (!paused) {
                const bufferSlot = currentGopBufferSlot
                const bufferOffset = bufferSlot * SLOT_SIZE

                let uploadStart = sys.nanoTime()
                graphics.uploadVideoBufferFrameToFramebuffer(currentGopFrameIndex, header.width, header.height, trueFrameCount, bufferOffset)
                uploadTime = (sys.nanoTime() - uploadStart) / 1000000.0

                if (interactive && currentGopFrameIndex === 0) {
                    console.log(`[GOP] Playing GOP: ${currentGopSize} frames from slot ${currentGopBufferSlot}`)
                }

                // Apply bias lighting
                let biasStart = sys.nanoTime()
                if (currentGopFrameIndex === 0 || currentGopFrameIndex === currentGopSize - 1) {
                    setBiasLighting()
                }
                biasTime = (sys.nanoTime() - biasStart) / 1000000.0

                // Fire audio on first frame
                if (!audioFired) {
                    audio.play(0)
                    audioFired = true
                }

                currentGopFrameIndex++
                frameCount++
                trueFrameCount++

                // Upload pre-decoded PCM audio if available (keeps audio queue fed)
                if (predecodedPcmBuffer !== null && predecodedPcmOffset < predecodedPcmSize) {
                    let remaining = predecodedPcmSize - predecodedPcmOffset
                    let uploadSize = Math.min(PCM_UPLOAD_CHUNK, remaining)

                    // Copy PCM chunk to audio peripheral memory
                    sys.memcpy(predecodedPcmBuffer + predecodedPcmOffset, SND_BASE_ADDR, uploadSize)

                    // Set upload parameters and trigger upload to queue
                    audio.setSampleUploadLength(0, uploadSize)
                    audio.startSampleUpload(0)

                    predecodedPcmOffset += uploadSize
                }

                // Start decode of buffered decoding GOP if ready GOP decode is complete
                if (decodingGopData !== null && decodingGopData.needsDecode && graphics.tavDecodeGopIsComplete()) {
                    const framesRemaining = currentGopSize - currentGopFrameIndex
                    const timeRemaining = framesRemaining * FRAME_TIME * 1000.0

                    graphics.tavDecodeGopToVideoBufferAsync(
                        decodingGopData.compressedPtr, decodingGopData.compressedSize, decodingGopData.gopSize,
                        header.width, header.height,
                        header.qualityLevel,
                        QLUT[header.qualityY], QLUT[header.qualityCo], QLUT[header.qualityCg],
                        header.channelLayout,
                        header.waveletFilter, header.decompLevels, 2,
                        header.entropyCoder,
                        decodingGopData.slot * SLOT_SIZE
                    )

                    // CRITICAL FIX: Set async decode tracking variables so decode is properly tracked
                    asyncDecodeInProgress = true
                    asyncDecodeSlot = decodingGopData.slot
                    asyncDecodeGopSize = decodingGopData.gopSize
                    asyncDecodePtr = decodingGopData.compressedPtr
                    asyncDecodeStartTime = sys.nanoTime()

                    decodingGopData.needsDecode = false
                    decodingGopData.startTime = asyncDecodeStartTime
                    decodingGopData.timeRemaining = timeRemaining

                    if (interactive) {
                        console.log(`[GOP] Started decode of buffered GOP ${decodingGopData.gopSize} frames from decoding slot (slot ${decodingGopData.slot})`)
                    }
                }

                // Schedule next frame
                nextFrameTime += (frametime)  // frametime is in nanoseconds from header
            }
        }

        // Step 4-7: GOP finished? Transition to ready GOP (triple-buffering)
        if (!paused && currentGopSize > 0 && currentGopFrameIndex >= currentGopSize) {
            if (interactive) {
                console.log(`[GOP] GOP finished: played ${currentGopFrameIndex}/${currentGopSize} frames from slot ${currentGopBufferSlot}`)
            }
            if (readyGopData !== null) {
                // If ready GOP still needs decode, start it now (defensive - should already be started)
                if (readyGopData.needsDecode) {
                    graphics.tavDecodeGopToVideoBufferAsync(
                        readyGopData.compressedPtr, readyGopData.compressedSize, readyGopData.gopSize,
                        header.width, header.height,
                        header.qualityLevel,
                        QLUT[header.qualityY], QLUT[header.qualityCo], QLUT[header.qualityCg],
                        header.channelLayout,
                        header.waveletFilter, header.decompLevels, 2,
                        header.entropyCoder,
                        readyGopData.slot * SLOT_SIZE
                    )
                    readyGopData.needsDecode = false
                    readyGopData.startTime = sys.nanoTime()
                }

                // Ready GOP exists - wait for it to finish decoding if still in progress
                while (!graphics.tavDecodeGopIsComplete() && !paused) {
                    sys.sleep(1)
                }

                if (!paused) {
                    const [r1, r2] = graphics.tavDecodeGopGetResult()
                    decodeTime = (sys.nanoTime() - readyGopData.startTime) / 1000000.0

                    // Free compressed data
                    sys.free(readyGopData.compressedPtr)

                    // Transition to ready GOP
                    currentGopBufferSlot = readyGopData.slot
                    currentGopSize = readyGopData.gopSize
                    currentGopFrameIndex = 0

                    // Promote decoding GOP to ready GOP
                    readyGopData = decodingGopData
                    decodingGopData = null

                    // CRITICAL: Only clear async decode tracking if NO decode is in progress
                    // (the promoted readyGop might be decoding from Case 4)
                    if (graphics.tavDecodeGopIsComplete()) {
                        asyncDecodeInProgress = false
                        asyncDecodePtr = 0
                        asyncDecodeGopSize = 0
                    }

                    // Resume packet reading now that one buffer is free (decoding slot available)
                    shouldReadPackets = true
                    if (interactive) {
                        console.log(`[GOP] Transition complete - resuming packet reading (asyncInProgress=${asyncDecodeInProgress})`)
                    }
                }
            } else {
                // No ready GOP available - hiccup (shouldn't happen with triple-buffering)
                if (interactive) {
                    console.log(`[GOP] ✗ HICCUP - ready GOP NOT READY! Playback paused.`)
                }
                currentGopSize = 0
                currentGopFrameIndex = 0

                // Resume packet reading to get next GOP
                shouldReadPackets = true
            }
        }

        // Simple progress display
        if (interactive) {
            notifHideTimer += (t2 - t1)
            if (!notifHidden && notifHideTimer > (NOTIF_SHOWUPTIME + FRAME_TIME)) {
                // clearing function here
                notifHidden = true
            }

            con.color_pair(253, 0)
            let guiStatus = {
                fps: header.fps,
                videoRate: getVideoRate(),
                frameCount: frameCount,
                totalFrames: header.totalFrames,
                frameMode: decoderDbgInfo.frameMode,
                qY: decoderDbgInfo.qY,
                qCo: decoderDbgInfo.qCo,
                qCg: decoderDbgInfo.qCg,
                akku: akku2,
                fileName: (cueElements.length > 0) ? `${cueElements[currentCueIndex].name}` : fullFilePathStr,
                fileOrd: (cueElements.length > 0) ? currentCueIndex+1 : currentFileIndex,
                resolution: `${header.width}x${header.height}${(isInterlaced) ? 'i' : ''}`,
                colourSpace: header.version % 2 == 0 ? "ICtCp" : "YCoCg",
                currentStatus: paused ? 2 : 1  // 2 = paused, 1 = playing
            }
            gui.printBottomBar(guiStatus)
            gui.printTopBar(guiStatus, 1)
        }


        debugPrintAkku += (t2 - t1)
        if (debugPrintAkku > 5000000000) {
            debugPrintAkku -= 5000000000
            serial.println(`[PLAYTAV] decoding time = ${(decodeTime).toFixed(2)} ms`)
        }

        // Small sleep to prevent 100% CPU and control loop rate
        // Allows continuous packet reading while maintaining proper frame timing
        sys.sleep(1)

        t1 = t2
    }
}
catch (e) {
    serial.printerr(`TAV decode error: ${e}`)
    errorlevel = 1
}
finally {
    // Cleanup
    sys.free(RGB_BUFFER_A)
    sys.free(RGB_BUFFER_B)

    // Free field buffers if interlaced
    if (isInterlaced) {
        sys.free(CURR_FIELD_BUFFER)
        sys.free(PREV_FIELD_BUFFER)
        sys.free(NEXT_FIELD_BUFFER)
    }

    // Free pre-decoded PCM buffer if present
    if (predecodedPcmBuffer !== null) {
        sys.free(predecodedPcmBuffer)
    }

    con.curs_set(1)
    con.clear()

    if (errorlevel === 0) {
        if (currentFileIndex > 1) {
            console.log(`Playback completed: ${currentFileIndex} files processed`)
        } else {
            console.log(`Playback completed: ${frameCount} frames`)
        }
    } else {
        console.log(`Playback failed with error ${errorlevel}`)
    }

    // reset font rom
    sys.poke(-1299460, 20)
    sys.poke(-1299460, 21)

    audio.stop(0)
    audio.purgeQueue(0)
}

graphics.setPalette(0, 0, 0, 0, 0)
con.move(cy, cx) // restore cursor
return errorlevel