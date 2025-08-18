// Created by Claude on 2025-08-18.
// TSVM Enhanced Video (TEV) Format Decoder - YCoCg-R 4:2:0 Version
// Usage: playtev moviefile.tev [options]

const WIDTH = 560
const HEIGHT = 448
const BLOCK_SIZE = 16  // 16x16 blocks for YCoCg-R
const TEV_MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x54, 0x45, 0x56] // "\x1FTSVM TEV"
const TEV_VERSION = 2  // YCoCg-R version

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
const fullFilePath = _G.shell.resolvePathInput(exec_args[1])
const FILE_LENGTH = files.open(fullFilePath.full).size

// Quantization tables for Y channel (16x16 - just use first 8 quality levels)
const QUANT_TABLES_Y = [
    // Quality 0 (lowest) - 8x8 pattern repeated to 16x16
    (() => {
        const base = [80, 60, 50, 80, 120, 200, 255, 255,
                     55, 60, 70, 95, 130, 255, 255, 255,
                     70, 65, 80, 120, 200, 255, 255, 255,
                     70, 85, 110, 145, 255, 255, 255, 255,
                     90, 110, 185, 255, 255, 255, 255, 255,
                     120, 175, 255, 255, 255, 255, 255, 255,
                     245, 255, 255, 255, 255, 255, 255, 255,
                     255, 255, 255, 255, 255, 255, 255, 255]
        const extended = []
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                extended.push(base[(y % 8) * 8 + (x % 8)])
            }
        }
        return extended
    })(),
    [40, 30, 25, 40, 60, 100, 128, 150, 28, 30, 35, 48, 65, 128, 150, 180], // Quality 1 (simplified)
    [20, 15, 13, 20, 30, 50, 64, 75, 14, 15, 18, 24, 33, 64, 75, 90],       // Quality 2
    [16, 12, 10, 16, 24, 40, 51, 60, 11, 12, 14, 19, 26, 51, 60, 72],       // Quality 3
    [12, 9, 8, 12, 18, 30, 38, 45, 8, 9, 11, 14, 20, 38, 45, 54],           // Quality 4
    [10, 7, 6, 10, 15, 25, 32, 38, 7, 7, 9, 12, 16, 32, 38, 45],            // Quality 5
    [8, 6, 5, 8, 12, 20, 26, 30, 6, 6, 7, 10, 13, 26, 30, 36],             // Quality 6
    // Quality 7 (highest)
    (() => {
        const base = [2, 1, 1, 2, 3, 5, 6, 7,
                     1, 1, 1, 2, 3, 6, 7, 9,
                     1, 1, 2, 3, 5, 6, 7, 9,
                     1, 2, 3, 4, 6, 7, 9, 10,
                     2, 3, 5, 6, 7, 9, 10, 11,
                     3, 4, 6, 7, 9, 10, 11, 12,
                     6, 6, 7, 9, 10, 11, 12, 13,
                     6, 7, 9, 10, 11, 12, 13, 13]
        const extended = []
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                extended.push(base[(y % 8) * 8 + (x % 8)])
            }
        }
        return extended
    })()
]

// Quantization tables for chroma channels (8x8)
const QUANT_TABLES_C = [
    // Quality 0 (lowest)
    [120, 90, 75, 120, 180, 255, 255, 255,
     83, 90, 105, 143, 195, 255, 255, 255,
     105, 98, 120, 180, 255, 255, 255, 255,
     105, 128, 165, 218, 255, 255, 255, 255,
     135, 165, 278, 255, 255, 255, 255, 255,
     180, 263, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255],
    [60, 45, 38, 60, 90, 150, 192, 225],       // Quality 1 (simplified)
    [30, 23, 19, 30, 45, 75, 96, 113],         // Quality 2
    [24, 18, 15, 24, 36, 60, 77, 90],          // Quality 3
    [18, 14, 12, 18, 27, 45, 57, 68],          // Quality 4
    [15, 11, 9, 15, 23, 38, 48, 57],           // Quality 5
    [12, 9, 8, 12, 18, 30, 39, 45],            // Quality 6
    // Quality 7 (highest)
    [3, 2, 2, 3, 5, 8, 9, 11,
     2, 2, 2, 3, 5, 9, 11, 14,
     2, 2, 3, 5, 8, 9, 11, 14,
     2, 3, 5, 6, 9, 11, 14, 15,
     3, 5, 8, 9, 11, 14, 15, 17,
     5, 6, 9, 11, 14, 15, 17, 18,
     9, 9, 11, 14, 15, 17, 18, 20,
     9, 11, 14, 15, 17, 18, 20, 20]
]

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

let frameTime = 1.0 / fps

// Ultra-fast approach: always render to display, use dedicated previous frame buffer
const FRAME_PIXELS = width * height

// Frame buffer addresses for graphics display
const DISPLAY_RG_ADDR = -1048577   // Main graphics RG plane (displayed)
const DISPLAY_BA_ADDR = -1310721   // Main graphics BA plane (displayed)

// RGB frame buffers (24-bit: R,G,B per pixel)
const CURRENT_RGB_ADDR = sys.malloc(560*448*3) // Current frame RGB buffer
const PREV_RGB_ADDR = sys.malloc(560*448*3)    // Previous frame RGB buffer

// Working memory for blocks (minimal allocation)
let ycocgWorkspace = sys.malloc(BLOCK_SIZE * BLOCK_SIZE * 3) // Y+Co+Cg workspace
let dctWorkspace = sys.malloc(BLOCK_SIZE * BLOCK_SIZE * 4) // DCT coefficients (floats)

// Initialize RGB frame buffers to black (0,0,0)
for (let i = 0; i < FRAME_PIXELS; i++) {
    // Current frame RGB: black
    sys.poke(CURRENT_RGB_ADDR + i*3, 0)     // R
    sys.poke(CURRENT_RGB_ADDR + i*3 + 1, 0) // G  
    sys.poke(CURRENT_RGB_ADDR + i*3 + 2, 0) // B
    
    // Previous frame RGB: black
    sys.poke(PREV_RGB_ADDR + i*3, 0)        // R
    sys.poke(PREV_RGB_ADDR + i*3 + 1, 0)    // G
    sys.poke(PREV_RGB_ADDR + i*3 + 2, 0)    // B
}

// Initialize display framebuffer to black
for (let i = 0; i < FRAME_PIXELS; i++) {
    sys.poke(DISPLAY_RG_ADDR - i, 0)  // Black in RG plane
    sys.poke(DISPLAY_BA_ADDR - i, 15) // Black with alpha=15 (opaque) in BA plane
}

let frameCount = 0
let stopPlay = false

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

// Main decoding loop - simplified for performance
try {
    while (!stopPlay && seqread.getReadCount() < FILE_LENGTH && frameCount < totalFrames) {
        // Handle interactive controls
        if (interactive) {
            sys.poke(-40, 1)
            if (sys.peek(-41) == 67) { // Backspace
                stopPlay = true
                break
            }
        }
            
        // Read packet (1 byte: type)
        let packetType = seqread.readOneByte()

        if (packetType == 0xFF) { // Sync packet
            // Read length (should be 0)
            let syncLen = seqread.readInt()
            
            // Sync packet - frame complete
            frameCount++

            // Copy current RGB frame to previous frame buffer for next frame reference
            // This is the only copying we need, and it happens once per frame after display
            sys.memcpy(PREV_RGB_ADDR, CURRENT_RGB_ADDR, FRAME_PIXELS * 3)

        } else if (packetType == TEV_PACKET_IFRAME || packetType == TEV_PACKET_PFRAME) {
            // Video frame packet
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
            // Calculate proper buffer size for TEV YCoCg-R blocks
            let blocksX = (width + 15) >> 4  // 16x16 blocks
            let blocksY = (height + 15) >> 4
            let tevBlockSize = 1 + 4 + 2 + (256 * 2) + (64 * 2) + (64 * 2) // mode + mv + cbp + Y(16x16) + Co(8x8) + Cg(8x8)
            let decompressedSize = blocksX * blocksY * tevBlockSize * 2 // Double for safety
            let blockDataPtr = sys.malloc(decompressedSize)

            let actualSize
            try {
                // Use gzip decompression (only compression format supported in TSVM JS)
                actualSize = gzip.decompFromTo(compressedPtr, payloadLen, blockDataPtr)
            } catch (e) {
                // Decompression failed - skip this frame
                serial.println(`Frame ${frameCount}: Gzip decompression failed, skipping (compressed size: ${payloadLen}, error: ${e})`)
                sys.free(blockDataPtr)
                sys.free(compressedPtr)
                continue
            }
            
            // Hardware-accelerated TEV YCoCg-R decoding to RGB buffers
            try {
                graphics.tevDecode(blockDataPtr, CURRENT_RGB_ADDR, PREV_RGB_ADDR,
                                 width, height, quality)
                
                // Upload RGB buffer to display framebuffer with dithering
                graphics.uploadRGBToFramebuffer(CURRENT_RGB_ADDR, DISPLAY_RG_ADDR, DISPLAY_BA_ADDR,
                                              width, height, frameCount)
            } catch (e) {
                serial.println(`Frame ${frameCount}: Hardware YCoCg-R decode failed: ${e}`)
            }

            sys.free(blockDataPtr)
            sys.free(compressedPtr)

        } else if (packetType == TEV_PACKET_AUDIO_MP2) {
            // Audio packet - skip for now
            let audioLen = seqread.readInt()
            seqread.skip(audioLen)

        } else {
            println(`Unknown packet type: 0x${packetType.toString(16)}`)
            break
        }

        // Simple progress display
        if (interactive) {
            con.move(31, 1)
            graphics.setTextFore(161)
            print(`Frame: ${frameCount}/${totalFrames} (${Math.round(frameCount * 100 / totalFrames)}%) YCoCg-R`)
            con.move(32, 1)
            graphics.setTextFore(161)
            print(`VRate: ${(getVideoRate() / 1024 * 8)|0} kbps                               `)
            con.move(1, 1)
        }
    }

} catch (e) {
    printerrln(`TEV YCoCg-R decode error: ${e}`)
    errorlevel = 1
} finally {
    // Cleanup working memory (graphics memory is automatically managed)
    sys.free(ycocgWorkspace)
    sys.free(dctWorkspace)
    sys.free(CURRENT_RGB_ADDR)
    sys.free(PREV_RGB_ADDR)

    audio.stop(0)
    audio.purgeQueue(0)

    if (interactive) {
        //con.clear()
    }
}

con.move(cy, cx) // restore cursor
return errorlevel