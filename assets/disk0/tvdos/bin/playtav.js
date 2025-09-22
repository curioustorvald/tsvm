// Created by Claude on 2025-09-13.
// TSVM Advanced Video (TAV) Format Decoder - DWT-based compression
// Adapted from the working playtev.js decoder
// Usage: playtav moviefile.tav [options]
// Options: -i (interactive), -debug-mv (show motion vector debug visualization)
//          -deinterlace=algorithm (yadif or bwdif, default: yadif)
//          -deblock (enable post-processing deblocking filter)

const WIDTH = 560
const HEIGHT = 448
const TILE_SIZE = 112  // 112x112 tiles for DWT (perfect fit for TSVM 560x448 resolution)
const TAV_MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x54, 0x41, 0x56] // "\x1FTSVM TAV"
const TAV_VERSION = 1  // Initial DWT version
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
const TAV_PACKET_SYNC = 0xFF

// Wavelet filter types
const WAVELET_5_3_REVERSIBLE = 0
const WAVELET_9_7_IRREVERSIBLE = 1

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
let debugMotionVectors = false
let deinterlaceAlgorithm = "yadif"
let enableDeblocking = false  // Default: disabled (use -deblock to enable)

if (exec_args.length > 2) {
    for (let i = 2; i < exec_args.length; i++) {
        const arg = exec_args[i].toLowerCase()
        if (arg === "-i") {
            interactive = true
        } else if (arg === "-debug-mv") {
            debugMotionVectors = true
        } else if (arg === "-deblock") {
            enableDeblocking = true
        } else if (arg.startsWith("-deinterlace=")) {
            deinterlaceAlgorithm = arg.substring(13)
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

let seqreadserial = require("seqread")
let seqreadtape = require("seqreadtape")
let seqread = undefined
let fullFilePathStr = fullFilePath.full

// Select seqread driver to use
if (fullFilePathStr.startsWith('$:/TAPE') || fullFilePathStr.startsWith('$:\\\\TAPE')) {
    seqread = seqreadtape
    seqread.prepare(fullFilePathStr)
    seqread.seek(0)
} else {
    seqread = seqreadserial
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

// Subtitle display functions
function clearSubtitleArea() {
    // Clear the subtitle area at the bottom of the screen
    // Text mode is 80x32, so clear the bottom few lines
    let oldFgColour = con.get_color_fore()
    let oldBgColour = con.get_color_back()

    con.color_pair(255, 255)  // transparent to clear

    // Clear bottom 4 lines for subtitles
    for (let row = 29; row <= 32; row++) {
        con.move(row, 1)
        for (let col = 1; col <= 80; col++) {
            print(" ")
        }
    }

    con.color_pair(oldFgColour, oldBgColour)
}

function getVisualLength(line) {
    // Calculate the visual length of a line excluding formatting tags
    let visualLength = 0
    let i = 0

    while (i < line.length) {
        if (i < line.length - 2 && line[i] === '<') {
            // Check for formatting tags and skip them
            if (line.substring(i, i + 3).toLowerCase() === '<b>' ||
                line.substring(i, i + 3).toLowerCase() === '<i>') {
                i += 3  // Skip tag
            } else if (i < line.length - 3 &&
                      (line.substring(i, i + 4).toLowerCase() === '</b>' ||
                       line.substring(i, i + 4).toLowerCase() === '</i>')) {
                i += 4  // Skip closing tag
            } else {
                // Not a formatting tag, count the character
                visualLength++
                i++
            }
        } else {
            // Regular character, count it
            visualLength++
            i++
        }
    }

    return visualLength
}

function displayFormattedLine(line) {
    // Parse line and handle <b> and <i> tags with colour changes
    // Default subtitle colour: yellow (231), formatted text: white (254)

    let i = 0
    let inBoldOrItalic = false

    // insert initial padding block
    con.color_pair(0, 255)
    con.prnch(0xDE)
    con.color_pair(231, 0)

    while (i < line.length) {
        if (i < line.length - 2 && line[i] === '<') {
            // Check for opening tags
            if (line.substring(i, i + 3).toLowerCase() === '<b>' ||
                line.substring(i, i + 3).toLowerCase() === '<i>') {
                con.color_pair(254, 0)  // Switch to white for formatted text
                inBoldOrItalic = true
                i += 3
            } else if (i < line.length - 3 &&
                      (line.substring(i, i + 4).toLowerCase() === '</b>' ||
                       line.substring(i, i + 4).toLowerCase() === '</i>')) {
                con.color_pair(231, 0)  // Switch back to yellow for normal text
                inBoldOrItalic = false
                i += 4
            } else {
                // Not a formatting tag, print the character
                print(line[i])
                i++
            }
        } else {
            // Regular character, print it
            print(line[i])
            i++
        }
    }

    // insert final padding block
    con.color_pair(0, 255)
    con.prnch(0xDD)
    con.color_pair(231, 0)
}

function displaySubtitle(text, position = 0) {
    if (!text || text.length === 0) {
        clearSubtitleArea()
        return
    }

    // Set subtitle colours: yellow (231) on black (0)
    let oldFgColour = con.get_color_fore()
    let oldBgColour = con.get_color_back()
    con.color_pair(231, 0)

    // Split text into lines
    let lines = text.split('\n')

    // Calculate position based on subtitle position setting
    let startRow, startCol
    // Calculate visual length without formatting tags for positioning
    let longestLineLength = lines.map(s => getVisualLength(s)).sort().last()

    switch (position) {
        case 2: // center left
        case 6: // center right
        case 8: // dead center
            startRow = 16 - Math.floor(lines.length / 2)
            break
        case 3: // top left
        case 4: // top center
        case 5: // top right
            startRow = 2
            break
        case 0: // bottom center
        case 1: // bottom left
        case 7: // bottom right
        default:
            startRow = 32 - lines.length
            startRow = 32 - lines.length
            startRow = 32 - lines.length  // Default to bottom center
    }

    // Display each line
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim()
        if (line.length === 0) continue

        let row = startRow + i
        if (row < 1) row = 1
        if (row > 32) row = 32

        // Calculate column based on alignment
        switch (position) {
            case 1: // bottom left
            case 2: // center left
            case 3: // top left
                startCol = 1
                break
            case 5: // top right
            case 6: // center right
            case 7: // bottom right
                startCol = Math.max(1, 78 - getVisualLength(line) - 2)
                break
            case 0: // bottom center
            case 4: // top center
            case 8: // dead center
            default:
                startCol = Math.max(1, Math.floor((80 - longestLineLength - 2) / 2) + 1)
                break
        }

        con.move(row, startCol)

        // Parse and display line with formatting tag support
        displayFormattedLine(line)
    }

    con.color_pair(oldFgColour, oldBgColour)
}

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
                displaySubtitle(subtitleText, subtitlePosition)
            }
            break
        }

        case SSF_OP_HIDE: {
            subtitleVisible = false
            subtitleText = ""
            clearSubtitleArea()
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
                        clearSubtitleArea()
                        displaySubtitle(subtitleText, subtitlePosition)
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
                if (remainingBytes >= payloadLen + 2) {
                    let fontData = seqread.readBytes(payloadLen)

                    // upload font data
                    for (let i = 0; i < Math.min(payloadLen, 1920); i++) sys.poke(-1300607 - i, sys.peek(fontData + i))
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
    reserved: new Array(7)
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

// Skip reserved bytes
for (let i = 0; i < 7; i++) {
    seqread.readOneByte()
}

if (header.version < 1 || header.version > 6) {
    printerrln(`Error: Unsupported TAV version ${header.version}`)
    errorlevel = 1
    return
}

const hasAudio = (header.extraFlags & 0x01) !== 0
const hasSubtitles = (header.extraFlags & 0x02) !== 0
const progressiveTransmission = (header.extraFlags & 0x04) !== 0
const roiCoding = (header.extraFlags & 0x08) !== 0

const isInterlaced = (header.videoFlags & 0x01) !== 0
const isNTSC = (header.videoFlags & 0x02) !== 0
const isLossless = (header.videoFlags & 0x04) !== 0

// Calculate tile dimensions (112x112 vs TEV's 16x16 blocks)
const tilesX = Math.ceil(header.width / TILE_SIZE)
const tilesY = Math.ceil(header.height / TILE_SIZE)
const numTiles = tilesX * tilesY

console.log(`TAV Decoder`)
console.log(`Resolution: ${header.width}x${header.height}`)
console.log(`FPS: ${header.fps}`)
console.log(`Total frames: ${header.totalFrames}`)
console.log(`Wavelet filter: ${header.waveletFilter === WAVELET_5_3_REVERSIBLE ? "5/3 reversible" : "9/7 irreversible"}`)
console.log(`Decomposition levels: ${header.decompLevels}`)
console.log(`Quality: Y=${header.qualityY}, Co=${header.qualityCo}, Cg=${header.qualityCg}`)
console.log(`Tiles: ${tilesX}x${tilesY} (${numTiles} total)`)
console.log(`Colour space: ${header.version === 2 ? "ICtCp" : "YCoCg-R"}`)
console.log(`Features: ${hasAudio ? "Audio " : ""}${hasSubtitles ? "Subtitles " : ""}${progressiveTransmission ? "Progressive " : ""}${roiCoding ? "ROI " : ""}`)

// Frame buffer addresses - same as TEV
const FRAME_PIXELS = header.width * header.height
const FRAME_SIZE = FRAME_PIXELS * 3  // RGB buffer size

const RGB_BUFFER_A = sys.malloc(FRAME_SIZE)
const RGB_BUFFER_B = sys.malloc(FRAME_SIZE)

// Ping-pong buffer pointers (swap instead of copy)
let CURRENT_RGB_ADDR = RGB_BUFFER_A
let PREV_RGB_ADDR = RGB_BUFFER_B

// Motion vector storage
let motionVectors = new Array(numTiles)
for (let i = 0; i < numTiles; i++) {
    motionVectors[i] = { mvX: 0, mvY: 0, rcf: 1.0 }
}

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

let blockDataPtr = sys.malloc(2377744)

// Function to try reading next TAV file header at current position
function tryReadNextTAVHeader() {
    // Save current position
    let currentPos = seqread.getReadCount()

    // Try to read magic number
    let newMagic = new Array(8)
    try {
        for (let i = 0; i < 8; i++) {
            newMagic[i] = seqread.readOneByte()
        }

        // compensating the old encoder emitting extra sync packets
        while (newMagic[0] == 255) {
            newMagic.shift(); newMagic[7] = seqread.readOneByte()
        }

        // Check if it matches TAV magic
        let isValidTAV = true
        for (let i = 0; i < 8; i++) {
            if (newMagic[i] !== TAV_MAGIC[i]) {
                isValidTAV = false
                serial.printerr("Header mismatch: got "+newMagic.join())
                break
            }
        }

        if (isValidTAV) {
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
                reserved: new Array(7)
            }

            // Skip reserved bytes
            for (let i = 0; i < 7; i++) {
                seqread.readOneByte()
            }

            return newHeader
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
    let totalFilesProcessed = 0

    while (!stopPlay && seqread.getReadCount() < FILE_LENGTH) {
        // Check if we've finished the current file
        if (header.totalFrames > 0 && frameCount >= header.totalFrames) {
            console.log(`Completed file ${currentFileIndex}: ${frameCount} frames`)

            // Try to read next TAV file header
            let nextHeader = tryReadNextTAVHeader()
            if (nextHeader) {
                // Found another TAV file - update header and reset counters
                header = nextHeader
                frameCount = 0
                currentFileIndex++
                totalFilesProcessed++

                console.log(`\nStarting file ${currentFileIndex}:`)
                console.log(`Resolution: ${header.width}x${header.height}`)
                console.log(`FPS: ${header.fps}`)
                console.log(`Total frames: ${header.totalFrames}`)
                console.log(`Wavelet filter: ${header.waveletFilter === WAVELET_5_3_REVERSIBLE ? "5/3 reversible" : "9/7 irreversible"}`)
                console.log(`Quality: Y=${header.qualityY}, Co=${header.qualityCo}, Cg=${header.qualityCg}`)

                // Reset motion vectors for new file
                for (let i = 0; i < numTiles; i++) {
                    motionVectors[i] = { mvX: 0, mvY: 0, rcf: 1.0 }
                }

                // Continue with new file
                continue
            } else {
                // No more TAV files found
                console.log(`\nNo more TAV files found. Total files processed: ${currentFileIndex}`)
                break
            }
        }

        // Original playback loop condition (but without totalFrames check since we handle it above)
        if (seqread.getReadCount() >= FILE_LENGTH) {
            break
        }

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
            const packetType = seqread.readOneByte()

            if (packetType === TAV_PACKET_SYNC) {
                // Sync packet - no additional data
                akku -= FRAME_TIME
                frameCount++
                trueFrameCount++

                // Swap ping-pong buffers instead of expensive memcpy (752KB copy eliminated!)
                let temp = CURRENT_RGB_ADDR
                CURRENT_RGB_ADDR = PREV_RGB_ADDR
                PREV_RGB_ADDR = temp

            } else if (packetType === TAV_PACKET_IFRAME || packetType === TAV_PACKET_PFRAME) {
                // Video packet
                const compressedSize = seqread.readInt()
                const isKeyframe = (packetType === TAV_PACKET_IFRAME)

                // Read compressed tile data
                let compressedPtr = seqread.readBytes(compressedSize)
                updateDataRateBin(compressedSize)

                let actualSize
                let decompressStart = sys.nanoTime()
                try {
                    // Use gzip decompression (only compression format supported in TSVM JS)
                    actualSize = gzip.decompFromTo(compressedPtr, compressedSize, blockDataPtr)
                    decompressTime = (sys.nanoTime() - decompressStart) / 1000000.0
                } catch (e) {
                    decompressTime = (sys.nanoTime() - decompressStart) / 1000000.0
                    console.log(`Frame ${frameCount}: Gzip decompression failed, skipping (compressed size: ${compressedSize}, error: ${e})`)
                    sys.free(compressedPtr)
                    continue
                }

                try {
//                    serial.println(actualSize)
                    let decodeStart = sys.nanoTime()

                    // Call TAV hardware decoder (like TEV's tevDecode but with RGB buffer outputs)
                    graphics.tavDecode(
                        blockDataPtr,
                        CURRENT_RGB_ADDR, PREV_RGB_ADDR,  // RGB buffer pointers (not float arrays!)
                        header.width, header.height,
                        header.qualityY, header.qualityCo, header.qualityCg,
                        frameCount,
                        header.waveletFilter,      // TAV-specific parameter
                        header.decompLevels,       // TAV-specific parameter
                        isLossless,
                        header.version             // TAV version for colour space detection
                    )

                    decodeTime = (sys.nanoTime() - decodeStart) / 1000000.0

                    // Upload RGB buffer to display framebuffer (like TEV)
                    let uploadStart = sys.nanoTime()
                    graphics.uploadRGBToFramebuffer(CURRENT_RGB_ADDR, header.width, header.height, frameCount, false)
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

            } else if (packetType === TAV_PACKET_AUDIO_MP2) {
                // MP2 Audio packet
                let audioLen = seqread.readInt()

                if (!mp2Initialised) {
                    mp2Initialised = true
                    audio.mp2Init()
                }

                seqread.readBytes(audioLen, SND_BASE_ADDR - 2368)
                audio.mp2Decode()
                audio.mp2UploadDecoded(0)

            } else if (packetType === TAV_PACKET_SUBTITLE) {
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
                con.move(1, 1)
                print(' '.repeat(79))
                notifHidden = true
            }

            if (!hasSubtitles) {
                con.move(31, 1)
                con.color_pair(253, 0)
                if (currentFileIndex > 1) {
                    print(`File ${currentFileIndex}: ${frameCount}/${header.totalFrames} (${((frameCount / akku2 * 100)|0) / 100}f)         `)
                } else {
                    print(`Frame: ${frameCount}/${header.totalFrames} (${((frameCount / akku2 * 100)|0) / 100}f)         `)
                }
                con.move(32, 1)
                con.color_pair(253, 0)
                print(`VRate: ${(getVideoRate() / 1024 * 8)|0} kbps                               `)
                con.move(1, 1)
            }
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
    sys.free(blockDataPtr)
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
}

graphics.setPalette(0, 0, 0, 0, 0)
con.move(cy, cx) // restore cursor
return errorlevel