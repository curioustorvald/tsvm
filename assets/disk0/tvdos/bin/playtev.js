// Created by Claude on 2025-08-17.
// TSVM Enhanced Video (TEV) Format Decoder
// Usage: playtev moviefile.tev [options]

const WIDTH = 560
const HEIGHT = 448
const BLOCK_SIZE = 8
const TEV_MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x54, 0x45, 0x56] // "\x1FTSVM TEV"

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

// Quantization tables (8 quality levels)
const QUANT_TABLES = [
    // Quality 0 (lowest) 
    [80, 60, 50, 80, 120, 200, 255, 255,
     55, 60, 70, 95, 130, 255, 255, 255,
     70, 65, 80, 120, 200, 255, 255, 255,
     70, 85, 110, 145, 255, 255, 255, 255,
     90, 110, 185, 255, 255, 255, 255, 255,
     120, 175, 255, 255, 255, 255, 255, 255,
     245, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255],
    // Quality 1-6 (simplified)
    [40, 30, 25, 40, 60, 100, 128, 150,
     28, 30, 35, 48, 65, 128, 150, 180,
     35, 33, 40, 60, 100, 128, 150, 180,
     35, 43, 55, 73, 128, 150, 180, 200,
     45, 55, 93, 128, 150, 180, 200, 220,
     60, 88, 128, 150, 180, 200, 220, 240,
     123, 128, 150, 180, 200, 220, 240, 250,
     128, 150, 180, 200, 220, 240, 250, 255],
    [20, 15, 13, 20, 30, 50, 64, 75,
     14, 15, 18, 24, 33, 64, 75, 90,
     18, 17, 20, 30, 50, 64, 75, 90,
     18, 22, 28, 37, 64, 75, 90, 100,
     23, 28, 47, 64, 75, 90, 100, 110,
     30, 44, 64, 75, 90, 100, 110, 120,
     62, 64, 75, 90, 100, 110, 120, 125,
     64, 75, 90, 100, 110, 120, 125, 128],
    [16, 12, 10, 16, 24, 40, 51, 60,
     11, 12, 14, 19, 26, 51, 60, 72,
     14, 13, 16, 24, 40, 51, 60, 72,
     14, 17, 22, 29, 51, 60, 72, 80,
     18, 22, 37, 51, 60, 72, 80, 88,
     24, 35, 51, 60, 72, 80, 88, 96,
     49, 51, 60, 72, 80, 88, 96, 100,
     51, 60, 72, 80, 88, 96, 100, 102],
    [12, 9, 8, 12, 18, 30, 38, 45,
     8, 9, 11, 14, 20, 38, 45, 54,
     11, 10, 12, 18, 30, 38, 45, 54,
     11, 13, 17, 22, 38, 45, 54, 60,
     14, 17, 28, 38, 45, 54, 60, 66,
     18, 26, 38, 45, 54, 60, 66, 72,
     37, 38, 45, 54, 60, 66, 72, 75,
     38, 45, 54, 60, 66, 72, 75, 77],
    [10, 7, 6, 10, 15, 25, 32, 38,
     7, 7, 9, 12, 16, 32, 38, 45,
     9, 8, 10, 15, 25, 32, 38, 45,
     9, 11, 14, 18, 32, 38, 45, 50,
     12, 14, 23, 32, 38, 45, 50, 55,
     15, 22, 32, 38, 45, 50, 55, 60,
     31, 32, 38, 45, 50, 55, 60, 63,
     32, 38, 45, 50, 55, 60, 63, 65],
    [8, 6, 5, 8, 12, 20, 26, 30,
     6, 6, 7, 10, 13, 26, 30, 36,
     7, 7, 8, 12, 20, 26, 30, 36,
     7, 9, 11, 15, 26, 30, 36, 40,
     10, 11, 19, 26, 30, 36, 40, 44,
     12, 17, 26, 30, 36, 40, 44, 48,
     25, 26, 30, 36, 40, 44, 48, 50,
     26, 30, 36, 40, 44, 48, 50, 52],
    // Quality 7 (highest)
    [2, 1, 1, 2, 3, 5, 6, 7,
     1, 1, 1, 2, 3, 6, 7, 9,
     1, 1, 2, 3, 5, 6, 7, 9,
     1, 2, 3, 4, 6, 7, 9, 10,
     2, 3, 5, 6, 7, 9, 10, 11,
     3, 4, 6, 7, 9, 10, 11, 12,
     6, 6, 7, 9, 10, 11, 12, 13,
     6, 7, 9, 10, 11, 12, 13, 13]
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
let flags = seqread.readOneByte()
let width = seqread.readShort()
let height = seqread.readShort()
let fps = seqread.readShort()
let totalFrames = seqread.readInt()
let quality = seqread.readOneByte()
seqread.skip(5) // Reserved bytes

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

let hasAudio = (flags & 0x01) != 0
let frameTime = 1.0 / fps

//println(`TEV Video: ${width}x${height}, ${fps} FPS, ${totalFrames} frames, Q${quality}`)
//if (hasAudio) println("Audio: MP2 32kHz")
//println(`Blocks: ${(width + 7) >> 3}x${(height + 7) >> 3} (${((width + 7) >> 3) * ((height + 7) >> 3)} total)`)

// Ultra-fast approach: always render to display, use dedicated previous frame buffer
const FRAME_PIXELS = width * height

// Frame buffer addresses for graphics display
const DISPLAY_RG_ADDR = -1048577   // Main graphics RG plane (displayed)
const DISPLAY_BA_ADDR = -1310721   // Main graphics BA plane (displayed)

// RGB frame buffers (24-bit: R,G,B per pixel)
const CURRENT_RGB_ADDR = sys.malloc(560*448*3) // Current frame RGB buffer
const PREV_RGB_ADDR = sys.malloc(560*448*3)    // Previous frame RGB buffer

// Working memory for blocks (minimal allocation)
let rgbWorkspace = sys.malloc(BLOCK_SIZE * BLOCK_SIZE * 3) // 192 bytes
let dctWorkspace = sys.malloc(BLOCK_SIZE * BLOCK_SIZE * 3 * 4) // 768 bytes (floats)

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

// Dequantize DCT coefficient
function dequantizeCoeff(coeff, quant, isDC) {
    if (isDC) {
        // DC coefficient also needs dequantization
        return coeff * quant
    } else {
        return coeff * quant
    }
}

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

// 8x8 Inverse DCT implementation
function idct8x8(coeffs, quantTable) {
    const N = 8
    let block = new Array(64)
    
    // Dequantize coefficients
    for (let i = 0; i < 64; i++) {
        block[i] = dequantizeCoeff(coeffs[i], quantTable[i], i === 0)
    }
    
    // IDCT constants
    const cos = Math.cos
    const sqrt2 = Math.sqrt(2)
    const c = new Array(8)
    c[0] = 1.0 / sqrt2
    for (let i = 1; i < 8; i++) {
        c[i] = 1.0
    }
    
    let result = new Array(64)
    
    // 2D IDCT
    for (let x = 0; x < N; x++) {
        for (let y = 0; y < N; y++) {
            let sum = 0.0
            for (let u = 0; u < N; u++) {
                for (let v = 0; v < N; v++) {
                    let coeff = block[v * N + u]
                    let cosU = cos((2 * x + 1) * u * Math.PI / (2 * N))
                    let cosV = cos((2 * y + 1) * v * Math.PI / (2 * N))
                    sum += c[u] * c[v] * coeff * cosU * cosV
                }
            }
            result[y * N + x] = sum / 4.0
        }
    }
    
    // Convert to pixel values (0-255)
    for (let i = 0; i < 64; i++) {
        result[i] = Math.max(0, Math.min(255, Math.round(result[i] + 128)))
    }
    
    return result
}

// Hardware-accelerated decoding uses graphics.tevIdct8x8() instead of pure JS

// Hardware-accelerated TEV block decoder 
function decodeBlock(blockData, blockX, blockY, prevRG, prevBA, currRG, currBA, quantTable) {
    let mode = blockData.mode
    let startX = blockX * BLOCK_SIZE
    let startY = blockY * BLOCK_SIZE
    
    if (mode == TEV_MODE_SKIP) {
        // Copy from previous frame
        for (let dy = 0; dy < BLOCK_SIZE; dy++) {
            for (let dx = 0; dx < BLOCK_SIZE; dx++) {
                let x = startX + dx
                let y = startY + dy
                if (x < width && y < height) {
                    let offset = y * width + x
                    let prevRGVal = sys.peek(prevRG + offset)
                    let prevBAVal = sys.peek(prevBA + offset)
                    sys.poke(currRG - offset, prevRGVal)  // Graphics memory uses negative addressing
                    sys.poke(currBA - offset, prevBAVal)
                }
            }
        }
    } else if (mode == TEV_MODE_MOTION) {
        // Motion compensation: copy from previous frame with motion vector offset
        for (let dy = 0; dy < BLOCK_SIZE; dy++) {
            for (let dx = 0; dx < BLOCK_SIZE; dx++) {
                let x = startX + dx
                let y = startY + dy
                let refX = x + blockData.mvX
                let refY = y + blockData.mvY
                
                if (x < width && y < height && refX >= 0 && refX < width && refY >= 0 && refY < height) {
                    let dstOffset = y * width + x
                    let refOffset = refY * width + refX
                    let refRGVal = sys.peek(prevRG + refOffset)
                    let refBAVal = sys.peek(prevBA + refOffset)
                    sys.poke(currRG - dstOffset, refRGVal)  // Graphics memory uses negative addressing
                    sys.poke(currBA - dstOffset, refBAVal)
                } else if (x < width && y < height) {
                    // Out of bounds reference - use black
                    let dstOffset = y * width + x
                    sys.poke(currRG - dstOffset, 0)  // Graphics memory uses negative addressing
                    sys.poke(currBA - dstOffset, 15)
                }
            }
        }
    } else {
        // INTRA or INTER modes: Full DCT decoding
        
        // Extract DCT coefficients for each channel (R, G, B)
        let rCoeffs = blockData.dctCoeffs.slice(0 * 64, 1 * 64)  // R channel
        let gCoeffs = blockData.dctCoeffs.slice(1 * 64, 2 * 64)  // G channel  
        let bCoeffs = blockData.dctCoeffs.slice(2 * 64, 3 * 64)  // B channel
        
        // Perform IDCT for each channel
        let rBlock = idct8x8(rCoeffs, quantTable)
        let gBlock = idct8x8(gCoeffs, quantTable)
        let bBlock = idct8x8(bCoeffs, quantTable)
        
        // Fill 8x8 block with IDCT results
        for (let dy = 0; dy < BLOCK_SIZE; dy++) {
            for (let dx = 0; dx < BLOCK_SIZE; dx++) {
                let x = startX + dx
                let y = startY + dy
                if (x < width && y < height) {
                    let blockOffset = dy * BLOCK_SIZE + dx
                    let imageOffset = y * width + x
                    
                    // Get RGB values from IDCT results
                    let r = rBlock[blockOffset]
                    let g = gBlock[blockOffset]
                    let b = bBlock[blockOffset]
                    
                    // Apply Bayer dithering when converting to 4-bit values
                    let r4 = ditherValue(r, x, y)
                    let g4 = ditherValue(g, x, y)
                    let b4 = ditherValue(b, x, y)
                    
                    let rgValue = (r4 << 4) | g4  // R in MSB, G in LSB
                    let baValue = (b4 << 4) | 15  // B in MSB, A=15 (opaque) in LSB
                    
                    // Write to graphics memory
                    sys.poke(currRG - imageOffset, rgValue)  // Graphics memory uses negative addressing
                    sys.poke(currBA - imageOffset, baValue)
                }
            }
        }
    }
}

// Secondary buffers removed - using frame buffers directly

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
            
        // Read packet (2 bytes: type + subtype)
        let packetType = seqread.readShort()

        if (packetType == 0xFFFF) { // Sync packet
            // Sync packet - frame complete
            frameCount++

            // Copy current RGB frame to previous frame buffer for next frame reference
            // This is the only copying we need, and it happens once per frame after display
            sys.memcpy(CURRENT_RGB_ADDR, PREV_RGB_ADDR, FRAME_PIXELS * 3)

        } else if ((packetType & 0xFF) == TEV_PACKET_IFRAME || (packetType & 0xFF) == TEV_PACKET_PFRAME) {
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

            // Decompress using zstd (if available) or gzip fallback
            // Calculate proper buffer size for TEV blocks (conservative estimate)
            let blocksX = (width + 7) >> 3
            let blocksY = (height + 7) >> 3
            let tevBlockSize = 1 + 4 + 2 + (64 * 3 * 2) // mode + mv + cbp + dct_coeffs
            let decompressedSize = blocksX * blocksY * tevBlockSize * 2 // Double for safety
            let blockDataPtr = sys.malloc(decompressedSize)

            let actualSize
            let decompMethod = "gzip"
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
            
            // Hardware decode complete

            // Hardware-accelerated TEV decoding to RGB buffers (blazing fast!)
            try {
                graphics.tevDecode(blockDataPtr, CURRENT_RGB_ADDR, PREV_RGB_ADDR,
                                 width, height, quality)
                
                // Upload RGB buffer to display framebuffer with dithering
                graphics.uploadRGBToFramebuffer(CURRENT_RGB_ADDR, DISPLAY_RG_ADDR, DISPLAY_BA_ADDR,
                                              width, height, frameCount)
            } catch (e) {
                serial.println(`Frame ${frameCount}: Hardware decode failed: ${e}`)
            }

            sys.free(blockDataPtr)
            sys.free(compressedPtr)

        } else if ((packetType & 0xFF) == TEV_PACKET_AUDIO_MP2) {
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
            print(`Frame: ${frameCount}/${totalFrames} (${Math.round(frameCount * 100 / totalFrames)}%)`)
            con.move(32, 1)
            graphics.setTextFore(161)
            print(`VRate: ${(getVideoRate() / 1024 * 8)|0} kbps                               `)
            con.move(1, 1)
        }
    }

} catch (e) {
    printerrln(`TEV decode error: ${e}`)
    errorlevel = 1
} finally {
    // Cleanup working memory (graphics memory is automatically managed)
    sys.free(rgbWorkspace)
    sys.free(dctWorkspace)
    sys.free(CURRENT_RGB_ADDR)
    sys.free(PREV_RGB_ADDR)


    audio.stop(0)
    audio.purgeQueue(0)

    if (interactive) {
        //con.clear()
    }
}

return errorlevel