// Created by Claude on 2025-08-18.
// TSVM Enhanced Video (TEV) Format Decoder - YCoCg-R 4:2:0 Version
// Usage: playtev moviefile.tev [options]
// Options: -i (interactive), -debug-mv (show motion vector debug visualization)

const WIDTH = 560
const HEIGHT = 448
const BLOCK_SIZE = 16  // 16x16 blocks for YCoCg-R
const TEV_MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x54, 0x45, 0x56] // "\x1FTSVM TEV"
const TEV_VERSION = 2  // YCoCg-R version
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

if (interactive) {
    con.move(1,1)
    println("Push and hold Backspace to exit")
}

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
if (version !== TEV_VERSION) {
    println(`Unsupported TEV version: ${version} (expected ${TEV_VERSION})`)
    return 1
}

let width = seqread.readShort()
let height = seqread.readShort()
let fps = seqread.readOneByte()
let totalFrames = seqread.readInt()
let quality = seqread.readOneByte()
let hasAudio = seqread.readOneByte()

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

// Allocate frame buffers - malloc works correctly, addresses are start addresses
const CURRENT_RGB_ADDR = sys.malloc(FRAME_SIZE)
const PREV_RGB_ADDR = sys.malloc(FRAME_SIZE)


// Working memory for blocks (minimal allocation)
let ycocgWorkspace = sys.malloc(BLOCK_SIZE * BLOCK_SIZE * 3) // Y+Co+Cg workspace
let dctWorkspace = sys.malloc(BLOCK_SIZE * BLOCK_SIZE * 4) // DCT coefficients (floats)

// Initialize RGB frame buffers to black (0,0,0)
sys.memset(CURRENT_RGB_ADDR, 0, FRAME_PIXELS * 3)
sys.memset(PREV_RGB_ADDR, 0, FRAME_PIXELS * 3)

// Initialize display framebuffer to black
sys.memset(DISPLAY_RG_ADDR, 0, FRAME_PIXELS) // Black in RG plane
sys.memset(DISPLAY_BA_ADDR, 15, FRAME_PIXELS) // Black with alpha=15 (opaque) in BA plane

let frameCount = 0
let stopPlay = false
let akku = FRAME_TIME
let akku2 = 0.0
let mp2Initialised = false
let audioFired = false

const BIAS_LIGHTING_MIN = 1.0 / 16.0
let oldBgcol = [BIAS_LIGHTING_MIN, BIAS_LIGHTING_MIN, BIAS_LIGHTING_MIN]

// 4x4 Bayer dithering matrix
const BAYER_MATRIX = [
    [ 0, 8, 2,10],
    [12, 4,14, 6],
    [ 3,11, 1, 9],
    [15, 7,13, 5]
]


// Apply Bayer dithering to reduce banding when quantizing to 4-bit
function ditherValue(value, x, y) {
    // Get the dither threshold for this pixel position
    const threshold = BAYER_MATRIX[y & 3][x & 3]
    
    // Scale threshold from 0-15 to 0-15.9375 (16 steps over 16 values)
    const scaledThreshold = threshold / 16.0
    
    // Add dither and quantize to 4-bit (0-15)
    const dithered = value + scaledThreshold
    return Math.max(0, Math.min(15, Math.floor(dithered * 15 / 255)))
}

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

                // Copy current RGB frame to previous frame buffer for next frame reference
                // memcpy(source, destination, length) - so CURRENT (source) -> PREV (destination)
                sys.memcpy(CURRENT_RGB_ADDR, PREV_RGB_ADDR, FRAME_PIXELS * 3)

            } else if (packetType == TEV_PACKET_IFRAME || packetType == TEV_PACKET_PFRAME) {
                // Video frame packet (always includes rate control factor)
                let payloadLen = seqread.readInt()
                
                // Always read rate control factor (4 bytes, little-endian float)
                let rateFactorBytes = seqread.readBytes(4)
                let view = new DataView(new ArrayBuffer(4))
                for (let i = 0; i < 4; i++) {
                    view.setUint8(i, sys.peek(rateFactorBytes + i))
                }
                let rateControlFactor = view.getFloat32(0, true) // true = little-endian
                //serial.println(`rateControlFactor = ${rateControlFactor}`)
                sys.free(rateFactorBytes)
                payloadLen -= 4 // Subtract rate factor size from payload
                
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
                try {
                    // Use gzip decompression (only compression format supported in TSVM JS)
                    actualSize = gzip.decompFromTo(compressedPtr, payloadLen, blockDataPtr)
                } catch (e) {
                    // Decompression failed - skip this frame
                    serial.println(`Frame ${frameCount}: Gzip decompression failed, skipping (compressed size: ${payloadLen}, error: ${e})`)
                    sys.free(compressedPtr)
                    continue
                }

                // Hardware-accelerated TEV YCoCg-R decoding to RGB buffers (with rate control factor)
                try {
                    graphics.tevDecode(blockDataPtr, CURRENT_RGB_ADDR, PREV_RGB_ADDR, width, height, quality, debugMotionVectors, rateControlFactor)

                    // Upload RGB buffer to display framebuffer with dithering
                    graphics.uploadRGBToFramebuffer(CURRENT_RGB_ADDR, DISPLAY_RG_ADDR, DISPLAY_BA_ADDR,
                                                  width, height, frameCount)

                    // Defer audio playback until a first frame is sent
                    if (!audioFired) {
                        audio.play(0)
                        audioFired = true
                    }
                } catch (e) {
                    serial.println(`Frame ${frameCount}: Hardware YCoCg-R decode failed: ${e}`)
                }

                sys.free(compressedPtr)

                setBiasLighting()

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
    printerrln(`TEV YCoCg-R decode error: ${e}`)
    errorlevel = 1
}
finally {
    // Cleanup working memory (graphics memory is automatically managed)
    sys.free(ycocgWorkspace)
    sys.free(dctWorkspace)
    sys.free(blockDataPtr)
    if (CURRENT_RGB_ADDR > 0) sys.free(CURRENT_RGB_ADDR)
    if (PREV_RGB_ADDR > 0) sys.free(PREV_RGB_ADDR)

    audio.stop(0)
    audio.purgeQueue(0)

    if (interactive) {
        //con.clear()
    }
}

con.move(cy, cx) // restore cursor
return errorlevel