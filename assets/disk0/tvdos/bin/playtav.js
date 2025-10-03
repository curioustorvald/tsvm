// Created by Claude on 2025-09-13.
// TSVM Advanced Video (TAV) Format Decoder - DWT-based compression
// Adapted from the working playtev.js decoder
// Usage: playtav moviefile.tav [options]
// Options: -i (interactive)

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
const TAV_PACKET_AUDIO_MP2 = 0x20
const TAV_PACKET_SUBTITLE = 0x30
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

if (exec_args.length > 2) {
    for (let i = 2; i < exec_args.length; i++) {
        const arg = exec_args[i].toLowerCase()
        if (arg === "-i") {
            interactive = true
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
graphics.setGraphicsMode(4) // 4096-colour mode  
graphics.clearPixels(0)
graphics.clearPixels2(0)

// Initialize audio
audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setMasterVolume(0, 255)

// set colour zero as half-opaque black
graphics.setPalette(0, 0, 0, 0, 9)


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
                gui.displaySubtitle(subtitleText, subtitlePosition)
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
                        gui.displaySubtitle(subtitleText, subtitlePosition)
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
header.fileRole = seqread.readOneByte()

// Skip reserved bytes
seqread.skip(4)

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
console.log(`Tiles: ${tilesX}x${tilesY} (${numTiles} total)`)
console.log(`Colour space: ${header.version % 2 == 0 ? "ICtCp" : "YCoCg-R"}`)
console.log(`Features: ${hasAudio ? "Audio " : ""}${hasSubtitles ? "Subtitles " : ""}${progressiveTransmission ? "Progressive " : ""}${roiCoding ? "ROI " : ""}`)

// Frame buffer addresses - same as TEV
const FRAME_PIXELS = header.width * header.height
const FRAME_SIZE = FRAME_PIXELS * 3  // RGB buffer size

const RGB_BUFFER_A = sys.malloc(FRAME_SIZE)
const RGB_BUFFER_B = sys.malloc(FRAME_SIZE)

// Ping-pong buffer pointers (swap instead of copy)
let CURRENT_RGB_ADDR = RGB_BUFFER_A
let PREV_RGB_ADDR = RGB_BUFFER_B

// Audio state
let audioBufferBytesLastFrame = 0
let frame_cnt = 0
let frametime = 1000000000.0 / header.fps
let nextFrameTime = 0
let mp2Initialised = false
let audioFired = false


// Performance tracking variables (from TEV)
let decompressTime = 0
let decodeTime = 0
let uploadTime = 0
let biasTime = 0

const BIAS_LIGHTING_MIN = 1.0 / 16.0
let oldBgcol = [BIAS_LIGHTING_MIN, BIAS_LIGHTING_MIN, BIAS_LIGHTING_MIN]

let notifHidden = false

function getRGBfromScr(x, y) {
    let offset = y * WIDTH + x
    let rg = sys.peek(-1048577 - offset)
    let ba = sys.peek(-1310721 - offset)
    return [(rg >>> 4) / 15.0, (rg & 15) / 15.0, (ba >>> 4) / 15.0]
}

function setBiasLighting() {
    let samples = []
    let nativeWidth = graphics.getPixelDimension()[0]
    let nativeHeight = graphics.getPixelDimension()[1]
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
    if (videoRateBin.length > header.fps) {
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
let currentFileIndex = 1  // Track which file we're playing in concatenated stream
let totalFilesProcessed = 0
let decoderDbgInfo = {}

let cueElements = []

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

                    element.offset = 0
                    for (let j = 0; j < 6; j++) {
                        element.offset |= (offsetBytes[j] << (j * 8))
                    }

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

// Playback loop - properly adapted from TEV with multi-file support
try {
    let t1 = sys.nanoTime()

    while (!stopPlay && seqread.getReadCount() < FILE_LENGTH) {


        // Handle interactive controls
        if (interactive) {
            sys.poke(-40, 1)
            if (sys.peek(-41) == 67) { // Backspace
                stopPlay = true
                break
            }
        }

        if (akku >= FRAME_TIME) {
            // Read packet header
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
                    currentFileIndex++
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
                // Sync packet - no additional data
                akku -= FRAME_TIME
                if (packetType == TAV_PACKET_SYNC) {
                    frameCount++
                }

                trueFrameCount++

                // Swap ping-pong buffers instead of expensive memcpy (752KB copy eliminated!)
                let temp = CURRENT_RGB_ADDR
                CURRENT_RGB_ADDR = PREV_RGB_ADDR
                PREV_RGB_ADDR = temp

            }
            else if (packetType === TAV_PACKET_IFRAME || packetType === TAV_PACKET_PFRAME) {
                // Video packet
                const compressedSize = seqread.readInt()

                // Read compressed tile data
                let compressedPtr = seqread.readBytes(compressedSize)
                updateDataRateBin(compressedSize)

                try {
                    let decodeStart = sys.nanoTime()

                    // Call new TAV hardware decoder that handles Zstd decompression internally
                    // Note: No longer using JS gzip.decompFromTo - Kotlin handles Zstd natively
                    decoderDbgInfo = graphics.tavDecodeCompressed(
                        compressedPtr,             // Pass compressed data directly
                        compressedSize,            // Size of compressed data
                        CURRENT_RGB_ADDR, PREV_RGB_ADDR,  // RGB buffer pointers
                        header.width, header.height,
                        header.qualityLevel, QLUT[header.qualityY], QLUT[header.qualityCo], QLUT[header.qualityCg],
                        header.channelLayout,      // Channel layout for variable processing
                        trueFrameCount,
                        header.waveletFilter,      // TAV-specific parameter
                        header.decompLevels,       // TAV-specific parameter
                        isLossless,
                        header.version             // TAV version for colour space detection
                    )

                    decodeTime = (sys.nanoTime() - decodeStart) / 1000000.0
                    decompressTime = 0  // Decompression time now included in decode time

                    // Upload RGB buffer to display framebuffer (like TEV)
                    let uploadStart = sys.nanoTime()
                    graphics.uploadRGBToFramebuffer(CURRENT_RGB_ADDR, header.width, header.height, trueFrameCount, false)
                    uploadTime = (sys.nanoTime() - uploadStart) / 1000000.0

                    // Defer audio playback until a first frame is sent
                    if (isInterlaced) {
                        // fire audio after frame 1
                        if (!audioFired && frameCount > 0) {
                            audio.play(0)
                            audioFired = true
                        }
                    }
                    else {
                        // fire audio after frame 0
                        if (!audioFired) {
                            audio.play(0)
                            audioFired = true
                        }
                    }
                } catch (e) {
                    console.log(`Frame ${frameCount}: decode failed: ${e}`)
                } finally {
                    sys.free(compressedPtr)
                }


                let biasStart = sys.nanoTime()
                setBiasLighting()
                biasTime = (sys.nanoTime() - biasStart) / 1000000.0

                // Log performance data every 60 frames
                if (frameCount % 60 == 0 || frameCount == 0) {
                    let totalTime = decompressTime + decodeTime + uploadTime + biasTime
                    console.log(`Frame ${frameCount}: Decompress=${decompressTime.toFixed(1)}ms, Decode=${decodeTime.toFixed(1)}ms, Upload=${uploadTime.toFixed(1)}ms, Bias=${biasTime.toFixed(1)}ms, Total=${totalTime.toFixed(1)}ms`)
                }

            }
            else if (packetType === TAV_PACKET_AUDIO_MP2) {
                // MP2 Audio packet
                let audioLen = seqread.readInt()

                if (!mp2Initialised) {
                    mp2Initialised = true
                    audio.mp2Init()
                }

                seqread.readBytes(audioLen, SND_BASE_ADDR - 2368)
                audio.mp2Decode()
                audio.mp2UploadDecoded(0)

            }
            else if (packetType === TAV_PACKET_SUBTITLE) {
                // Subtitle packet - same format as TEV
                let packetSize = seqread.readInt()
                processSubtitlePacket(packetSize)
            } else if (packetType == 0x00) {
                // Silently discard, faulty subtitle creation can cause this as 0x00 is used as an argument terminator
            } else {
                println(`Unknown packet type: 0x${packetType.toString(16)}`)
                break
            }
        }

        let t2 = sys.nanoTime()
        akku += (t2 - t1) / 1000000000.0
        akku2 += (t2 - t1) / 1000000000.0

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
                qY: decoderDbgInfo.qY,
                qCo: decoderDbgInfo.qCo,
                qCg: decoderDbgInfo.qCg,
                akku: akku2,
                fileName: fullFilePathStr,
                fileOrd: currentFileIndex,
                resolution: `${header.width}x${header.height}`,
                colourSpace: header.version % 2 == 0 ? "ICtCp" : "YCoCg",
                currentStatus: 1
            }
            gui.printBottomBar(guiStatus)
            gui.printTopBar(guiStatus, 1)
        }

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

    sys.poke(-1299460, 20)
    sys.poke(-1299460, 21)
}

graphics.setPalette(0, 0, 0, 0, 0)
con.move(cy, cx) // restore cursor
return errorlevel