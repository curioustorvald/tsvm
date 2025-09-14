// Created by Claude on 2025-09-13.
// TSVM Advanced Video (TAV) Format Decoder - DWT-based compression
// Adapted from the working playtev.js decoder
// Usage: playtav moviefile.tav [options]
// Options: -i (interactive), -debug-mv (show motion vector debug visualization)
//          -deinterlace=algorithm (yadif or bwdif, default: yadif)
//          -deblock (enable post-processing deblocking filter)

const WIDTH = 560
const HEIGHT = 448
const TILE_SIZE = 64  // 64x64 tiles for DWT (vs 16x16 blocks in TEV)
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
graphics.setGraphicsMode(4) // 4096-color mode  
graphics.clearPixels(0)
graphics.clearPixels2(0)

// Initialize audio
audio.resetParams(0)
audio.purgeQueue(0)

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
    con.puts("Error: Invalid TAV file format")
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

if (header.version !== TAV_VERSION) {
    con.puts(`Error: Unsupported TAV version ${header.version}`)
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
const multiResolution = (header.videoFlags & 0x08) !== 0

// Calculate tile dimensions (64x64 vs TEV's 16x16 blocks)
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

let FRAME_TIME = 1.0 / header.fps

let frameCount = 0 
let trueFrameCount = 0
let frameDuped = false
let stopPlay = false
let akku = FRAME_TIME
let akku2 = 0.0

let blockDataPtr = sys.malloc(560*448*3)

// Playback loop - properly adapted from TEV
try {
    let t1 = sys.nanoTime()
    while (!stopPlay && seqread.getReadCount() < FILE_LENGTH && frameCount < header.totalFrames) {

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
                    // Duplicate every 1000th frame if NTSC (same as TEV)
                    if (!isNTSC || frameCount % 1000 != 501 || frameDuped) {
                        frameDuped = false

                        let decodeStart = sys.nanoTime()

                        // Call TAV hardware decoder (like TEV's tevDecode but with RGB buffer outputs)
                        graphics.tavDecode(
                            blockDataPtr,
                            CURRENT_RGB_ADDR, PREV_RGB_ADDR,  // RGB buffer pointers (not float arrays!)
                            header.width, header.height,
                            header.qualityY, header.qualityCo, header.qualityCg,
                            frameCount,
                            debugMotionVectors,
                            header.waveletFilter,      // TAV-specific parameter
                            header.decompLevels,       // TAV-specific parameter
                            enableDeblocking,
                            isLossless
                        )

                        decodeTime = (sys.nanoTime() - decodeStart) / 1000000.0

                        // Upload RGB buffer to display framebuffer (like TEV)
                        let uploadStart = sys.nanoTime()
                        graphics.uploadRGBToFramebuffer(CURRENT_RGB_ADDR, header.width, header.height, frameCount, true)
                        uploadTime = (sys.nanoTime() - uploadStart) / 1000000.0
                    } else {
                        frameCount -= 1
                        frameDuped = true
                        console.log(`Frame ${frameCount}: Duplicating previous frame`)
                    }

                } catch (e) {
                    console.log(`Frame ${frameCount}: decode failed: ${e}`)
                }

                sys.free(compressedPtr)

                let biasStart = sys.nanoTime()
                setBiasLighting()
                biasTime = (sys.nanoTime() - biasStart) / 1000000.0

                // Log performance data every 60 frames
                if (frameCount % 60 == 0 || frameCount == 0) {
                    let totalTime = decompressTime + decodeTime + uploadTime + biasTime
                    console.log(`Frame ${frameCount}: Decompress=${decompressTime.toFixed(1)}ms, Decode=${decodeTime.toFixed(1)}ms, Upload=${uploadTime.toFixed(1)}ms, Bias=${biasTime.toFixed(1)}ms, Total=${totalTime.toFixed(1)}ms`)
                }

            } else if (packetType === TAV_PACKET_AUDIO_MP2 && hasAudio) {
                // Audio packet - same as TEV
                let audioPtr = seqread.readBytes(compressedSize)

                // Send to audio hardware
                for (let i = 0; i < compressedSize; i++) {
                    vm.poke(SND_BASE_ADDR + audioBufferBytesLastFrame + i, sys.peek(audioPtr + i))
                }
                audioBufferBytesLastFrame += compressedSize
                sys.free(audioPtr)

            } else if (packetType === TAV_PACKET_SUBTITLE && hasSubtitles) {
                // Subtitle packet - same format as TEV
                let subtitlePtr = seqread.readBytes(compressedSize)

                // Process subtitle (simplified)
                if (compressedSize >= 4) {
                    const index = (sys.peek(subtitlePtr) << 16) | (sys.peek(subtitlePtr + 1) << 8) | sys.peek(subtitlePtr + 2)
                    const opcode = sys.peek(subtitlePtr + 3)

                    if (opcode === SSF_OP_SHOW && compressedSize > 4) {
                        let text = ""
                        for (let i = 4; i < compressedSize && sys.peek(subtitlePtr + i) !== 0; i++) {
                            text += String.fromCharCode(sys.peek(subtitlePtr + i))
                        }
                        subtitleText = text
                        subtitleVisible = true
                    } else if (opcode === SSF_OP_HIDE) {
                        subtitleVisible = false
                    }
                }
                sys.free(subtitlePtr)
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

            if (notifHidden) {
                con.move(31, 1)
                con.color_pair(253, 0)
                //print(`Frame: ${frameCount}/${header.totalFrames} (${((frameCount / akku2 * 100)|0) / 100}f)         `)
            }
        }

        t1 = t2
    }
}
catch (e) {
    printerrln(`TAV decode error: ${e}`)
    errorlevel = 1
}
finally {
    // Cleanup
    sys.free(blockDataPtr)
    sys.free(RGB_BUFFER_A)
    sys.free(RGB_BUFFER_B)

    graphics.setGraphicsMode(0) // Return to text mode
    con.curs_set(1)
    con.clear()

    if (errorlevel === 0) {
        console.log(`Playback completed: ${frameCount} frames`)
    } else {
        console.log(`Playbook failed with error ${errorlevel}`)
    }
}

graphics.setPalette(0, 0, 0, 0, 0)
con.move(cy, cx) // restore cursor
return errorlevel