// Created by Claude on 2025-08-18.
// TSVM Enhanced Video (TEV) Format Decoder - YCoCg-R 4:2:0 Version
// Usage: playtev moviefile.tev [options]
// Options: -i (interactive), -debug-mv (show motion vector debug visualization)

const WIDTH = 560
const HEIGHT = 448
const BLOCK_SIZE = 16  // 16x16 blocks for YCoCg-R
const TEV_MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x54, 0x45, 0x56] // "\x1FTSVM TEV"
const TEV_VERSION_YCOCG = 2  // YCoCg-R version
const TEV_VERSION_XYB = 3    // XYB version
const SND_BASE_ADDR = audio.getBaseAddr()
const pcm = require("pcm")
const MP2_FRAME_SIZE = [144,216,252,288,360,432,504,576,720,864,1008,1152,1440,1728]

// Block encoding modes
const TEV_MODE_SKIP = 0x00
const TEV_MODE_INTRA = 0x01  
const TEV_MODE_INTER = 0x02
const TEV_MODE_MOTION = 0x03

// Packet types
const TEV_PACKET_IFRAME = 0x10
const TEV_PACKET_PFRAME = 0x11
const TEV_PACKET_AUDIO_MP2 = 0x20
const TEV_PACKET_SYNC = 0xFF

const interactive = exec_args[2] && exec_args[2].toLowerCase() == "-i"
const debugMotionVectors = exec_args[2] && exec_args[2].toLowerCase() == "-debug-mv"
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
if (fullFilePathStr.startsWith('$:/TAPE') || fullFilePathStr.startsWith('$:\\TAPE')) {
    seqread = seqreadtape
    seqread.seek(0)
} else {
    seqread = seqreadserial
}

seqread.prepare(fullFilePathStr)

con.clear()
con.curs_set(0)
graphics.setGraphicsMode(4) // 4096-color mode  
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
    let oldFgColor = con.get_color_fore()
    let oldBgColor = con.get_color_back()

    con.color_pair(255, 255)  // transparent to clear

    // Clear bottom 4 lines for subtitles
    for (let row = 29; row <= 32; row++) {
        con.move(row, 1)
        for (let col = 1; col <= 80; col++) {
            print(" ")
        }
    }

    con.color_pair(oldFgColor, oldBgColor)
}

function displaySubtitle(text, position = 0) {
    if (!text || text.length === 0) {
        clearSubtitleArea()
        return
    }

    // Set subtitle colors: yellow (230) on black (0)
    let oldFgColor = con.get_color_fore()
    let oldBgColor = con.get_color_back()
    con.color_pair_pair(230, 0)

    // Split text into lines
    let lines = text.split('\n')

    // Calculate position based on subtitle position setting
    let startRow, startCol

    switch (position) {
        case 0: // bottom center
            startRow = 32 - lines.length + 1
            break
        case 1: // bottom left
            startRow = 32 - lines.length + 1
            break
        case 2: // center left
            startRow = 16 - Math.floor(lines.length / 2)
            break
        case 3: // top left
            startRow = 2
            break
        case 4: // top center
            startRow = 2
            break
        case 5: // top right
            startRow = 2
            break
        case 6: // center right
            startRow = 16 - Math.floor(lines.length / 2)
            break
        case 7: // bottom right
            startRow = 32 - lines.length + 1
            break
        default:
            startRow = 32 - lines.length + 1  // Default to bottom center
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
            case 0: // bottom center
            case 4: // top center
                startCol = Math.max(1, Math.floor((80 - line.length) / 2) + 1)
                break
            case 1: // bottom left
            case 2: // center left
            case 3: // top left
                startCol = 2
                break
            case 5: // top right
            case 6: // center right
            case 7: // bottom right
                startCol = Math.max(1, 80 - line.length)
                break
            default:
                startCol = Math.max(1, Math.floor((80 - line.length) / 2) + 1)
        }

        con.move(row, startCol)
        print(line)  // Unicode-capable print function
    }

    con.color_pair(oldFgColor, oldBgColor)
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

// Check magic number
let magic = seqread.readBytes(8)
let magicMatching = true
let actualMagic = []

TEV_MAGIC.forEach((b, i) => {
    let testb = sys.peek(magic + i) & 255
    actualMagic.push(testb)
    if (testb != b) {
        magicMatching = false
    }
})
sys.free(magic)

if (!magicMatching) {
    println("Not a TEV file (MAGIC mismatch) -- got " + actualMagic.join())
    return 1
}

// Read header
let version = seqread.readOneByte()
if (version !== TEV_VERSION_YCOCG && version !== TEV_VERSION_XYB) {
    println(`Unsupported TEV version: ${version} (expected ${TEV_VERSION_YCOCG} for YCoCg-R or ${TEV_VERSION_XYB} for XYB)`)
    return 1
}

let colorSpace = (version === TEV_VERSION_XYB) ? "XYB" : "YCoCg-R"
if (interactive) {
    con.move(1,1)
    println(`Push and hold Backspace to exit | TEV Format ${version} (${colorSpace})`)
}

let width = seqread.readShort()
let height = seqread.readShort()
let fps = seqread.readOneByte()
let totalFrames = seqread.readInt()
let qualityY = seqread.readOneByte()
let qualityCo = seqread.readOneByte()
let qualityCg = seqread.readOneByte()
let flags = seqread.readOneByte()
let hasAudio = flags & 1
let hasSubtitle = flags & 2
let unused1 = seqread.readOneByte()
let unused2 = seqread.readOneByte()

serial.println(`TEV Format ${version} (${colorSpace}); Q: ${qualityY} ${qualityCo} ${qualityCg}`)

function updateDataRateBin(rate) {
    videoRateBin.push(rate)
    if (videoRateBin.length > fps) {
        videoRateBin.shift()
    }
}

function getVideoRate(rate) {
    let baseRate = videoRateBin.reduce((a, c) => a + c, 0)
    let mult = fps / videoRateBin.length
    return baseRate * mult
}

let FRAME_TIME = 1.0 / fps
// Ultra-fast approach: always render to display, use dedicated previous frame buffer
const FRAME_PIXELS = width * height

// Frame buffer addresses for graphics display
const DISPLAY_RG_ADDR = -1048577   // Main graphics RG plane (displayed)
const DISPLAY_BA_ADDR = -1310721   // Main graphics BA plane (displayed)

// RGB frame buffers (24-bit: R,G,B per pixel)
const FRAME_SIZE = 560*448*3  // Total frame size = 752,640 bytes

// Ping-pong frame buffers to eliminate memcpy overhead
const RGB_BUFFER_A = sys.malloc(FRAME_SIZE)
const RGB_BUFFER_B = sys.malloc(FRAME_SIZE)

// Ping-pong buffer pointers (swap instead of copy)
let CURRENT_RGB_ADDR = RGB_BUFFER_A
let PREV_RGB_ADDR = RGB_BUFFER_B

// Initialize RGB frame buffers to black (0,0,0)
sys.memset(RGB_BUFFER_A, 0, FRAME_PIXELS * 3)
sys.memset(RGB_BUFFER_B, 0, FRAME_PIXELS * 3)

// Initialize display framebuffer to black
sys.memset(DISPLAY_RG_ADDR, 0, FRAME_PIXELS) // Black in RG plane
sys.memset(DISPLAY_BA_ADDR, 15, FRAME_PIXELS) // Black with alpha=15 (opaque) in BA plane

let frameCount = 0
let stopPlay = false
let akku = FRAME_TIME
let akku2 = 0.0
let mp2Initialised = false
let audioFired = false

// Performance tracking variables
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
    for (let x = 8; x < 560; x+=32) {
        samples.push(getRGBfromScr(x, 3))
        samples.push(getRGBfromScr(x, 445))
    }
    for (let y = 29; y < 448; y+=26) {
        samples.push(getRGBfromScr(8, y))
        samples.push(getRGBfromScr(552, y))
    }

    let out = [0.0, 0.0, 0.0]
    samples.forEach(rgb=>{
        out[0] += rgb[0]
        out[1] += rgb[1]
        out[2] += rgb[2]
    })
    out[0] = BIAS_LIGHTING_MIN + (out[0] / samples.length / 2.0) // darken a bit
    out[1] = BIAS_LIGHTING_MIN + (out[1] / samples.length / 2.0)
    out[2] = BIAS_LIGHTING_MIN + (out[2] / samples.length / 2.0)

    let bgr = (oldBgcol[0]*5 + out[0]) / 6.0
    let bgg = (oldBgcol[1]*5 + out[1]) / 6.0
    let bgb = (oldBgcol[2]*5 + out[2]) / 6.0

    oldBgcol = [bgr, bgg, bgb]

    graphics.setBackground(Math.round(bgr * 255), Math.round(bgg * 255), Math.round(bgb * 255))
}

let blockDataPtr = sys.malloc(560 * 448 * 3)

// Main decoding loop - simplified for performance
try {
    let t1 = sys.nanoTime()
    while (!stopPlay && seqread.getReadCount() < FILE_LENGTH && frameCount < totalFrames) {

        // Handle interactive controls
        if (interactive) {
            sys.poke(-40, 1)
            if (sys.peek(-41) == 67) { // Backspace
                stopPlay = true
                break
            }
        }

        if (akku >= FRAME_TIME) {
            // Read packet (1 byte: type)
            let packetType = seqread.readOneByte()

            if (packetType == 0xFF) { // Sync packet
                akku -= FRAME_TIME

                // Sync packet - frame complete
                frameCount++

                // Swap ping-pong buffers instead of expensive memcpy (752KB copy eliminated!)
                let temp = CURRENT_RGB_ADDR
                CURRENT_RGB_ADDR = PREV_RGB_ADDR
                PREV_RGB_ADDR = temp

            } else if (packetType == TEV_PACKET_IFRAME || packetType == TEV_PACKET_PFRAME) {
                // Video frame packet (always includes rate control factor)
                let payloadLen = seqread.readInt()
                let compressedPtr = seqread.readBytes(payloadLen)
                updateDataRateBin(payloadLen)


                // Basic sanity check on compressed data
                if (payloadLen <= 0 || payloadLen > 1000000) {
                    serial.println(`Frame ${frameCount}: Invalid payload length: ${payloadLen}`)
                    sys.free(compressedPtr)
                    continue
                }

                // Decompress using gzip
                // Optimized buffer size calculation for TEV YCoCg-R blocks
                let blocksX = (width + 15) >> 4  // 16x16 blocks
                let blocksY = (height + 15) >> 4
                let tevBlockSize = 1 + 4 + 2 + (256 * 2) + (64 * 2) + (64 * 2) // mode + mv + cbp + Y(16x16) + Co(8x8) + Cg(8x8)
                let decompressedSize = Math.max(payloadLen * 4, blocksX * blocksY * tevBlockSize) // More efficient sizing

                let actualSize
                let decompressStart = sys.nanoTime()
                try {
                    // Use gzip decompression (only compression format supported in TSVM JS)
                    actualSize = gzip.decompFromTo(compressedPtr, payloadLen, blockDataPtr)
                    decompressTime = (sys.nanoTime() - decompressStart) / 1000000.0  // Convert to milliseconds
                } catch (e) {
                    // Decompression failed - skip this frame
                    decompressTime = (sys.nanoTime() - decompressStart) / 1000000.0  // Still measure time
                    serial.println(`Frame ${frameCount}: Gzip decompression failed, skipping (compressed size: ${payloadLen}, error: ${e})`)
                    sys.free(compressedPtr)
                    continue
                }

                // Hardware-accelerated TEV decoding to RGB buffers (YCoCg-R or XYB based on version)
                try {
                    let decodeStart = sys.nanoTime()
                    graphics.tevDecode(blockDataPtr, CURRENT_RGB_ADDR, PREV_RGB_ADDR, width, height, [qualityY, qualityCo, qualityCg], debugMotionVectors, version)
                    decodeTime = (sys.nanoTime() - decodeStart) / 1000000.0  // Convert to milliseconds

                    // Upload RGB buffer to display framebuffer with dithering
                    let uploadStart = sys.nanoTime()
                    graphics.uploadRGBToFramebuffer(CURRENT_RGB_ADDR, width, height, frameCount)
                    uploadTime = (sys.nanoTime() - uploadStart) / 1000000.0  // Convert to milliseconds
                    

                    // Defer audio playback until a first frame is sent
                    if (!audioFired) {
                        audio.play(0)
                        audioFired = true
                    }
                } catch (e) {
                    serial.println(`Frame ${frameCount}: Hardware ${colorSpace} decode failed: ${e}`)
                }

                sys.free(compressedPtr)

                let biasStart = sys.nanoTime()
                setBiasLighting()
                biasTime = (sys.nanoTime() - biasStart) / 1000000.0  // Convert to milliseconds
                
                // Log performance data every 60 frames (and also frame 0 for debugging)
                if (frameCount % 60 == 0 || frameCount == 0) {
                    let totalTime = decompressTime + decodeTime + uploadTime + biasTime
                    serial.println(`Frame ${frameCount}: Decompress=${decompressTime.toFixed(1)}ms, Decode=${decodeTime.toFixed(1)}ms, Upload=${uploadTime.toFixed(1)}ms, Bias=${biasTime.toFixed(1)}ms, Total=${totalTime.toFixed(1)}ms`)
                }

            } else if (packetType == TEV_PACKET_AUDIO_MP2) {
                // MP2 Audio packet
                let audioLen = seqread.readInt()

                if (!mp2Initialised) {
                    mp2Initialised = true
                    audio.mp2Init()
                }

                seqread.readBytes(audioLen, SND_BASE_ADDR - 2368)
                audio.mp2Decode()
                audio.mp2UploadDecoded(0)

            } else if (packetType == TEV_PACKET_SUBTITLE) {
                // Subtitle packet - NEW!
                let packetSize = seqread.readInt()
                processSubtitlePacket(packetSize)
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
                con.clear()
                notifHidden = true
            }

            con.move(31, 1)
            graphics.setTextFore(161)
            print(`Frame: ${frameCount}/${totalFrames} (${((frameCount / akku2 * 100)|0) / 100}f)         `)
            con.move(32, 1)
            graphics.setTextFore(161)
            print(`VRate: ${(getVideoRate() / 1024 * 8)|0} kbps                               `)
            con.move(1, 1)
        }

        t1 = t2
    }
}
catch (e) {
    printerrln(`TEV ${colorSpace} decode error: ${e}`)
    errorlevel = 1
}
finally {
    // Cleanup working memory (graphics memory is automatically managed)
    sys.free(blockDataPtr)
    if (RGB_BUFFER_A > 0) sys.free(RGB_BUFFER_A)
    if (RGB_BUFFER_B > 0) sys.free(RGB_BUFFER_B)

    audio.stop(0)
    audio.purgeQueue(0)

    if (interactive) {
        //con.clear()
    }
}

con.move(cy, cx) // restore cursor
return errorlevel