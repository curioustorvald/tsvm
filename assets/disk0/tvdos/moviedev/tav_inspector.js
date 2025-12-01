// TAV Packet Inspector - JavaScript port for TSVM
// Ported from tav_inspector.c by CuriousTorvald and Claude
// Usage: tav_inspector <input.tav> <output.txt> [options]

const seqread = require('seqread')

// Frame mode constants
const FRAME_MODE_SKIP = 0x00
const FRAME_MODE_INTRA = 0x01
const FRAME_MODE_DELTA = 0x02

// Packet type constants
const TAV_PACKET_IFRAME = 0x10
const TAV_PACKET_PFRAME = 0x11
const TAV_PACKET_GOP_UNIFIED = 0x12
const TAV_PACKET_GOP_UNIFIED_MOTION = 0x13
const TAV_PACKET_PFRAME_RESIDUAL = 0x14
const TAV_PACKET_BFRAME_RESIDUAL = 0x15
const TAV_PACKET_PFRAME_ADAPTIVE = 0x16
const TAV_PACKET_BFRAME_ADAPTIVE = 0x17
const TAV_PACKET_AUDIO_MP2 = 0x20
const TAV_PACKET_AUDIO_PCM8 = 0x21
const TAV_PACKET_AUDIO_TAD = 0x24
const TAV_PACKET_SUBTITLE = 0x30
const TAV_PACKET_SUBTITLE_TC = 0x31
const TAV_PACKET_VIDEOTEX = 0x3F
const TAV_PACKET_AUDIO_TRACK = 0x40
const TAV_PACKET_VIDEO_CH2_I = 0x70
const TAV_PACKET_VIDEO_CH2_P = 0x71
const TAV_PACKET_VIDEO_CH3_I = 0x72
const TAV_PACKET_VIDEO_CH3_P = 0x73
const TAV_PACKET_VIDEO_CH4_I = 0x74
const TAV_PACKET_VIDEO_CH4_P = 0x75
const TAV_PACKET_VIDEO_CH5_I = 0x76
const TAV_PACKET_VIDEO_CH5_P = 0x77
const TAV_PACKET_VIDEO_CH6_I = 0x78
const TAV_PACKET_VIDEO_CH6_P = 0x79
const TAV_PACKET_VIDEO_CH7_I = 0x7A
const TAV_PACKET_VIDEO_CH7_P = 0x7B
const TAV_PACKET_VIDEO_CH8_I = 0x7C
const TAV_PACKET_VIDEO_CH8_P = 0x7D
const TAV_PACKET_VIDEO_CH9_I = 0x7E
const TAV_PACKET_VIDEO_CH9_P = 0x7F
const TAV_PACKET_EXIF = 0xE0
const TAV_PACKET_ID3V1 = 0xE1
const TAV_PACKET_ID3V2 = 0xE2
const TAV_PACKET_VORBIS_COMMENT = 0xE3
const TAV_PACKET_CD_TEXT = 0xE4
const TAV_PACKET_EXTENDED_HDR = 0xEF
const TAV_PACKET_LOOP_START = 0xF0
const TAV_PACKET_LOOP_END = 0xF1
const TAV_PACKET_SCREEN_MASK = 0xF2
const TAV_PACKET_GOP_SYNC = 0xFC
const TAV_PACKET_TIMECODE = 0xFD
const TAV_PACKET_SYNC_NTSC = 0xFE
const TAV_PACKET_SYNC = 0xFF
const TAV_PACKET_NOOP = 0x00

const QLUT = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096]
const CLAYOUT = ["Luma-Chroma", "Luma-Chroma-Alpha", "Luma", "Luma-Alpha", "Chroma", "Chroma-Alpha"]
const VERDESC = ["null", "YCoCg tiled, uniform", "ICtCp tiled, uniform", "YCoCg monoblock, uniform", "ICtCp monoblock, uniform", "YCoCg monoblock, perceptual", "ICtCp monoblock, perceptual", "YCoCg tiled, perceptual", "ICtCp tiled, perceptual"]
const TEMPORAL_WAVELET = ["Haar", "CDF 5/3"]

function getPacketTypeName(type) {
    switch (type) {
        case TAV_PACKET_IFRAME: return "I-FRAME"
        case TAV_PACKET_PFRAME: return "P-FRAME"
        case TAV_PACKET_GOP_UNIFIED: return "GOP (3D DWT Unified)"
        case TAV_PACKET_GOP_UNIFIED_MOTION: return "GOP (3D DWT Unified with Motion Data)"
        case TAV_PACKET_PFRAME_RESIDUAL: return "P-FRAME (residual)"
        case TAV_PACKET_BFRAME_RESIDUAL: return "B-FRAME (residual)"
        case TAV_PACKET_PFRAME_ADAPTIVE: return "P-FRAME (quadtree)"
        case TAV_PACKET_BFRAME_ADAPTIVE: return "B-FRAME (quadtree)"
        case TAV_PACKET_AUDIO_MP2: return "AUDIO MP2"
        case TAV_PACKET_AUDIO_PCM8: return "AUDIO PCM8 (zstd)"
        case TAV_PACKET_AUDIO_TAD: return "AUDIO TAD (zstd)"
        case TAV_PACKET_SUBTITLE: return "SUBTITLE (SSF frame-locked)"
        case TAV_PACKET_SUBTITLE_TC: return "SUBTITLE (SSF-TC timecoded)"
        case TAV_PACKET_VIDEOTEX: return "VIDEOTEX (text-mode video)"
        case TAV_PACKET_AUDIO_TRACK: return "AUDIO TRACK (Separate MP2)"
        case TAV_PACKET_EXIF: return "METADATA (EXIF)"
        case TAV_PACKET_ID3V1: return "METADATA (ID3v1)"
        case TAV_PACKET_ID3V2: return "METADATA (ID3v2)"
        case TAV_PACKET_VORBIS_COMMENT: return "METADATA (Vorbis)"
        case TAV_PACKET_CD_TEXT: return "METADATA (CD-Text)"
        case TAV_PACKET_EXTENDED_HDR: return "EXTENDED HEADER"
        case TAV_PACKET_LOOP_START: return "LOOP START"
        case TAV_PACKET_LOOP_END: return "LOOP END"
        case TAV_PACKET_SCREEN_MASK: return "SCREEN MASK"
        case TAV_PACKET_GOP_SYNC: return "GOP SYNC"
        case TAV_PACKET_TIMECODE: return "TIMECODE"
        case TAV_PACKET_SYNC_NTSC: return "SYNC (NTSC)"
        case TAV_PACKET_SYNC: return "SYNC"
        case TAV_PACKET_NOOP: return "NO-OP"
        default:
            if (type >= 0x70 && type <= 0x7F) {
                return "MUX VIDEO"
            }
            return "UNKNOWN"
    }
}

// Read int64 (little-endian)
function readInt64() {
    let lo = seqread.readInt() >>> 0
    let hi = seqread.readInt() >>> 0
    return lo + hi * 4294967296
}

// Read uint24 (little-endian)
function readUint24() {
    let b0 = seqread.readOneByte()
    let b1 = seqread.readOneByte()
    let b2 = seqread.readOneByte()
    return b0 | (b1 << 8) | (b2 << 16)
}

// Get frame info from compressed data
function getFrameInfo(compressedSize) {
    let info = { mode: -1, quantiser: 0xFF }

    if (compressedSize === 0) return info

    // Read compressed data into memory
    let compressedPtr = sys.malloc(compressedSize)
    if (compressedPtr === 0) {
        seqread.skip(compressedSize)
        return info
    }

    seqread.readBytes(compressedSize, compressedPtr)

    // Decompress (max 2MB buffer)
    let decompressedSize = 2 * 1024 * 1024
    let decompressedPtr = sys.malloc(decompressedSize)
    if (decompressedPtr === 0) {
        sys.free(compressedPtr)
        return info
    }

    try {
        let actualSize = gzip.decompFromTo(compressedPtr, compressedSize, decompressedPtr)

        if (actualSize >= 1) {
            info.mode = sys.peek(decompressedPtr) & 0xFF
        }
        if (info.mode !== FRAME_MODE_SKIP && actualSize >= 2) {
            info.quantiser = sys.peek(decompressedPtr + 1) & 0xFF
        }
    } catch (e) {
        // Decompression failed, keep default values
    }

    sys.free(decompressedPtr)
    sys.free(compressedPtr)

    return info
}

// Parse extended header
function parseExtendedHeader(output) {
    let numPairs = seqread.readShort()
    output.push(` - ${numPairs} key-value pairs:\n`)

    for (let i = 0; i < numPairs; i++) {
        let key = seqread.readFourCC()
        let valueType = seqread.readOneByte()

        let valueTypeStr = "Unknown"
        switch (valueType) {
            case 0x00: valueTypeStr = "Int16"; break
            case 0x01: valueTypeStr = "Int24"; break
            case 0x02: valueTypeStr = "Int32"; break
            case 0x03: valueTypeStr = "Int48"; break
            case 0x04: valueTypeStr = "Int64"; break
            case 0x10: valueTypeStr = "Bytes"; break
        }

        output.push(`    ${key} (type: ${valueTypeStr} (0x${valueType.toString(16).padStart(2,'0')})): `)

        if (valueType === 0x04) {  // Int64
            let value = readInt64()

            if (key === "CDAT") {
                let timeSec = Math.floor(value / 1000000)
                let date = new Date(timeSec * 1000)
                output.push(date.toUTCString())
            } else {
                output.push((value / 1000000000).toFixed(6) + " seconds")
            }
        } else if (valueType === 0x10) {  // Bytes
            let length = seqread.readShort()
            let data = seqread.readString(length)
            output.push(`"${data}"`)
        } else {
            output.push("Unknown type")
        }

        if (i < numPairs - 1) {
            output.push("\n")
        }
    }
}

// Parse subtitle packet
function parseSubtitlePacket(size, isTimecoded, output) {
    let index = readUint24()

    let timecodeNs = 0
    let headerSize = 4  // 3 bytes index + 1 byte opcode
    if (isTimecoded) {
        timecodeNs = readInt64()
        headerSize += 8
    }

    let opcode = seqread.readOneByte()

    output.push(` [Index=${index}`)
    if (isTimecoded) {
        output.push(`, Time=${(timecodeNs / 1000000000).toFixed(3)}s`)
    }
    output.push(`, Opcode=0x${opcode.toString(16).padStart(2,'0')}`)

    switch (opcode) {
        case 0x01: output.push(" (SHOW)"); break
        case 0x02: output.push(" (HIDE)"); break
        case 0x03: output.push(" (MOVE)"); break
        case 0x80: output.push(" (UPLOAD LOW FONT)"); break
        case 0x81: output.push(" (UPLOAD HIGH FONT)"); break
        default:
            if (opcode >= 0x10 && opcode <= 0x2F) output.push(" (SHOW LANG)")
            else if (opcode >= 0x30 && opcode <= 0x41) output.push(" (REVEAL)")
            break
    }
    output.push("]")

    // Read text content for SHOW commands
    let remaining = size - headerSize
    if ((opcode === 0x01 || (opcode >= 0x10 && opcode <= 0x2F) || (opcode >= 0x30 && opcode <= 0x41)) && remaining > 0) {
        let text = seqread.readString(remaining)
        // Clean up control characters
        text = text.replace(/[\n\r\t]/g, ' ')
        output.push(` Text: "${text}"`)
    } else {
        seqread.skip(remaining)
    }
}

// Parse videotex packet
function parseVideotexPacket(size, output) {
    let compressedPtr = sys.malloc(size)
    if (compressedPtr === 0) {
        seqread.skip(size)
        output.push(` - size=${size} bytes`)
        return
    }

    seqread.readBytes(size, compressedPtr)

    let decompressSize = 8192
    let decompressedPtr = sys.malloc(decompressSize)
    if (decompressedPtr === 0) {
        sys.free(compressedPtr)
        output.push(` - size=${size} bytes`)
        return
    }

    try {
        let actualSize = gzip.decompFromTo(compressedPtr, size, decompressedPtr)

        if (actualSize >= 2) {
            let rows = sys.peek(decompressedPtr) & 0xFF
            let cols = sys.peek(decompressedPtr + 1) & 0xFF
            let ratio = (actualSize / size).toFixed(2)
            output.push(` - size=${size} bytes (decompressed: ${actualSize} bytes, grid: ${cols}x${rows}, ratio: ${ratio}:1)`)
        } else {
            output.push(` - size=${size} bytes (decompression failed)`)
        }
    } catch (e) {
        output.push(` - size=${size} bytes (decompression failed)`)
    }

    sys.free(decompressedPtr)
    sys.free(compressedPtr)
}

// Main function
function main() {
    if (exec_args.length < 3) {
        println("Usage: tav_inspector <input.tav> <output.txt>")
        println("  Analyzes TAV file packets and writes report to output file")
        return 1
    }

    let inputPath = _G.shell.resolvePathInput(exec_args[1]).full
    let outputPath = _G.shell.resolvePathInput(exec_args[2]).full
    const FILE_LENGTH = files.open(inputPath).size

    // Prepare sequential reader
    try {
        seqread.prepare(inputPath)
    } catch (e) {
        println(`Error: Cannot open file ${inputPath}`)
        println(e.toString())
        return 1
    }

    let output = []

    // Read and verify TAV header (32 bytes)
    let magic = seqread.readString(8)
    let expectedMagic = "\x1FTSVMTAV"
    if (magic !== expectedMagic) {
        println("Error: Invalid TAV magic number")
        return 1
    }

    // Parse header fields
    let version = seqread.readOneByte()
    let baseVersion = (version > 8) ? (version - 8) : version
    let temporalMotionCoder = (version > 8) ? 1 : 0
    let width = seqread.readShort()
    let height = seqread.readShort()
    let fps = seqread.readOneByte()
    let totalFrames = seqread.readInt()
    let wavelet = seqread.readOneByte()
    let decompLevels = seqread.readOneByte()
    let quantY = seqread.readOneByte()
    let quantCo = seqread.readOneByte()
    let quantCg = seqread.readOneByte()
    let extraFlags = seqread.readOneByte()
    let videoFlags = seqread.readOneByte()
    let quality = seqread.readOneByte()
    let channelLayout = seqread.readOneByte()
    let entropyCoder = seqread.readOneByte()
    let encoderPreset = seqread.readOneByte()
    seqread.skip(3)  // Reserved bytes

    let waveletNames = ["LGT 5/3", "CDF 9/7", "CDF 13/7", "Reserved", "Reserved",
                        "Reserved", "Reserved", "Reserved", "Reserved",
                        "Reserved", "Reserved", "Reserved", "Reserved",
                        "Reserved", "Reserved", "Reserved", "DD-4"]

    // Write header information
    output.push("TAV Packet Inspector\n")
    output.push(`File: ${inputPath}\n`)
    output.push("==================================================\n\n")

    output.push("TAV Header:\n")
    output.push(`  Version:          ${version} (base: ${baseVersion} - ${VERDESC[baseVersion]}, temporal: ${TEMPORAL_WAVELET[temporalMotionCoder]})\n`)
    output.push(`  Resolution:       ${width}x${height}\n`)
    output.push(`  Frame rate:       ${fps} fps`)
    if (videoFlags & 0x02) output.push(" (NTSC)")
    output.push("\n")
    output.push(`  Total frames:     ${totalFrames}\n`)
    output.push(`  Wavelet:          ${wavelet}`)
    if (wavelet < 17) output.push(` (${waveletNames[wavelet === 16 ? 16 : wavelet]})`)
    if (wavelet === 255) output.push(" (Haar)")
    output.push("\n")
    output.push(`  Decomp levels:    ${decompLevels}\n`)
    output.push(`  Quantisers:       Y=${QLUT[quantY]}, Co=${QLUT[quantCo]}, Cg=${QLUT[quantCg]} (Index=${quantY},${quantCo},${quantCg})\n`)
    if (quality > 0)
        output.push(`  Quality:          ${quality - 1}\n`)
    else
        output.push("  Quality:          n/a\n")
    output.push(`  Channel layout:   ${CLAYOUT[channelLayout]}\n`)
    output.push(`  Entropy coder:    ${entropyCoder === 0 ? "Twobit-map" : "EZBC"}\n`)
    output.push("  Encoder preset:   ")
    if (encoderPreset === 0) {
        output.push("Default\n")
    } else {
        let presets = []
        if (encoderPreset & 0x01) presets.push("Sports")
        if (encoderPreset & 0x02) presets.push("Anime")
        output.push(presets.join(", ") + "\n")
    }
    output.push("  Flags:\n")
    output.push(`    Has audio:      ${(extraFlags & 0x01) ? "Yes" : "No"}\n`)
    output.push(`    Has subtitles:  ${(extraFlags & 0x02) ? "Yes" : "No"}\n`)
    output.push(`    Progressive:    ${(videoFlags & 0x01) ? "No (interlaced)" : "Yes"}\n`)
    output.push(`    Lossless:       ${(videoFlags & 0x04) ? "Yes" : "No"}\n`)
    if (extraFlags & 0x04) output.push("    Progressive TX: Enabled\n")
    if (extraFlags & 0x08) output.push("    ROI encoding:   Enabled\n")
    output.push("\nPackets:\n")
    output.push("==================================================\n")

    // Statistics
    let stats = {
        iframeCount: 0,
        pframeCount: 0,
        pframeIntraCount: 0,
        pframeDeltaCount: 0,
        pframeSkipCount: 0,
        gopUnifiedCount: 0,
        gopUnifiedMotionCount: 0,
        gopSyncCount: 0,
        totalGopFrames: 0,
        audioCount: 0,
        audioMp2Count: 0,
        audioPcm8Count: 0,
        audioTadCount: 0,
        audioTrackCount: 0,
        subtitleCount: 0,
        videotexCount: 0,
        timecodeCount: 0,
        syncCount: 0,
        syncNtscCount: 0,
        extendedHeaderCount: 0,
        metadataCount: 0,
        loopPointCount: 0,
        muxVideoCount: 0,
        unknownCount: 0,
        totalVideoBytes: 0,
        totalAudioBytes: 0,
        audioMp2Bytes: 0,
        audioPcm8Bytes: 0,
        audioTadBytes: 0,
        audioTrackBytes: 0,
        videotexBytes: 0
    }

    let packetNum = 0
    let currentFrame = 0

    // Parse packets
    try {
        while (seqread.getReadCount() < FILE_LENGTH) {
            let packetOffset = seqread.getReadCount()
            let packetType = seqread.readOneByte()

            output.push(`Packet ${packetNum} (offset 0x${packetOffset.toString(16).toUpperCase()}): Type 0x${packetType.toString(16).padStart(2,'0').toUpperCase()} (${getPacketTypeName(packetType)})`)

            switch (packetType) {
                case TAV_PACKET_EXTENDED_HDR:
                    stats.extendedHeaderCount++
                    parseExtendedHeader(output)
                    break

                case TAV_PACKET_TIMECODE:
                    stats.timecodeCount++
                    let timecodeNs = readInt64()
                    let timecodeSec = (timecodeNs / 1000000000).toFixed(6)
                    output.push(` - ${timecodeSec} seconds (Frame ${currentFrame})`)
                    break

                case TAV_PACKET_GOP_UNIFIED:
                case TAV_PACKET_GOP_UNIFIED_MOTION:
                    let gopSize = seqread.readOneByte()

                    let size0 = 0
                    if (packetType === TAV_PACKET_GOP_UNIFIED_MOTION) {
                        size0 = seqread.readInt()
                        stats.totalVideoBytes += size0
                        stats.gopUnifiedMotionCount++
                        seqread.skip(size0)
                    }

                    let size1 = seqread.readInt()
                    stats.totalVideoBytes += size1
                    seqread.skip(size1)

                    stats.totalGopFrames += gopSize
                    if (packetType === TAV_PACKET_GOP_UNIFIED) {
                        stats.gopUnifiedCount++
                    }

                    let totalSize = size0 + size1
                    let bytesPerFrame = (totalSize / gopSize).toFixed(2)
                    output.push(` - GOP size=${gopSize}, data size=${totalSize} bytes (${bytesPerFrame} bytes/frame)`)
                    break

                case TAV_PACKET_GOP_SYNC:
                    let frameCount = seqread.readOneByte()
                    stats.gopSyncCount++
                    currentFrame += frameCount
                    output.push(` - ${frameCount} frames decoded from GOP block`)
                    break

                case TAV_PACKET_IFRAME:
                case TAV_PACKET_PFRAME:
                case TAV_PACKET_VIDEO_CH2_I:
                case TAV_PACKET_VIDEO_CH2_P:
                case TAV_PACKET_VIDEO_CH3_I:
                case TAV_PACKET_VIDEO_CH3_P:
                case TAV_PACKET_VIDEO_CH4_I:
                case TAV_PACKET_VIDEO_CH4_P:
                case TAV_PACKET_VIDEO_CH5_I:
                case TAV_PACKET_VIDEO_CH5_P:
                case TAV_PACKET_VIDEO_CH6_I:
                case TAV_PACKET_VIDEO_CH6_P:
                case TAV_PACKET_VIDEO_CH7_I:
                case TAV_PACKET_VIDEO_CH7_P:
                case TAV_PACKET_VIDEO_CH8_I:
                case TAV_PACKET_VIDEO_CH8_P:
                case TAV_PACKET_VIDEO_CH9_I:
                case TAV_PACKET_VIDEO_CH9_P:
                    let size = seqread.readInt()
                    stats.totalVideoBytes += size

                    let frameInfo = getFrameInfo(size)

                    if (packetType === TAV_PACKET_PFRAME ||
                        (packetType >= 0x71 && packetType <= 0x7F && (packetType & 1))) {
                        // P-frame
                        if (packetType === TAV_PACKET_PFRAME) {
                            stats.pframeCount++
                            if (frameInfo.mode === FRAME_MODE_INTRA) stats.pframeIntraCount++
                            else if (frameInfo.mode === FRAME_MODE_DELTA) stats.pframeDeltaCount++
                            else if (frameInfo.mode === FRAME_MODE_SKIP) stats.pframeSkipCount++
                            currentFrame++
                        } else {
                            stats.muxVideoCount++
                        }
                    } else {
                        // I-frame
                        if (packetType === TAV_PACKET_IFRAME) {
                            stats.iframeCount++
                            currentFrame++
                        } else {
                            stats.muxVideoCount++
                        }
                    }

                    output.push(` - size=${size} bytes`)

                    if (frameInfo.mode >= 0) {
                        if (frameInfo.mode === FRAME_MODE_SKIP) output.push(" [SKIP]")
                        else if (frameInfo.mode === FRAME_MODE_DELTA) output.push(" [DELTA]")
                        else if (frameInfo.mode === FRAME_MODE_INTRA) output.push(" [INTRA]")

                        if (frameInfo.mode !== FRAME_MODE_SKIP) {
                            if (frameInfo.quantiser !== 0xFF) {
                                output.push(` [Q=${frameInfo.quantiser}]`)
                            }
                        }
                    }

                    if (packetType >= 0x70 && packetType <= 0x7F) {
                        let channel = Math.floor((packetType - 0x70) / 2) + 2
                        output.push(` (Channel ${channel})`)
                    }
                    break

                case TAV_PACKET_AUDIO_MP2:
                    stats.audioCount++
                    stats.audioMp2Count++
                    let mp2Size = seqread.readInt()
                    stats.totalAudioBytes += mp2Size
                    stats.audioMp2Bytes += mp2Size
                    output.push(` - size=${mp2Size} bytes`)
                    seqread.skip(mp2Size)
                    break

                case TAV_PACKET_AUDIO_PCM8:
                    stats.audioCount++
                    stats.audioPcm8Count++
                    let pcm8Size = seqread.readInt()
                    stats.totalAudioBytes += pcm8Size
                    stats.audioPcm8Bytes += pcm8Size
                    output.push(` - size=${pcm8Size} bytes (zstd compressed)`)
                    seqread.skip(pcm8Size)
                    break

                case TAV_PACKET_AUDIO_TAD:
                    stats.audioCount++
                    stats.audioTadCount++

                    let sampleCount0 = seqread.readShort()
                    let payloadSizePlus7 = seqread.readInt()
                    let sampleCount = seqread.readShort()
                    let quantiser = seqread.readOneByte()
                    let compressedSize = seqread.readInt()

                    stats.totalAudioBytes += compressedSize
                    stats.audioTadBytes += compressedSize

                    output.push(` - samples=${sampleCount}, size=${compressedSize} bytes, quantiser=${quantiser * 2 + 1} steps (index ${quantiser})`)
                    seqread.skip(compressedSize)
                    break

                case TAV_PACKET_AUDIO_TRACK:
                    stats.audioCount++
                    stats.audioTrackCount++
                    let trackSize = seqread.readInt()
                    stats.totalAudioBytes += trackSize
                    stats.audioTrackBytes += trackSize
                    output.push(` - size=${trackSize} bytes (separate track)`)
                    seqread.skip(trackSize)
                    break

                case TAV_PACKET_SUBTITLE:
                case TAV_PACKET_SUBTITLE_TC:
                    stats.subtitleCount++
                    let subSize = seqread.readInt()
                    output.push(` - size=${subSize} bytes`)
                    parseSubtitlePacket(subSize, packetType === TAV_PACKET_SUBTITLE_TC, output)
                    break

                case TAV_PACKET_VIDEOTEX:
                    stats.videotexCount++
                    let vtSize = seqread.readInt()
                    stats.videotexBytes += vtSize
                    parseVideotexPacket(vtSize, output)
                    break

                case TAV_PACKET_EXIF:
                case TAV_PACKET_ID3V1:
                case TAV_PACKET_ID3V2:
                case TAV_PACKET_VORBIS_COMMENT:
                case TAV_PACKET_CD_TEXT:
                    stats.metadataCount++
                    let metaSize = seqread.readInt()
                    output.push(` - size=${metaSize} bytes`)
                    seqread.skip(metaSize)
                    break

                case TAV_PACKET_LOOP_START:
                case TAV_PACKET_LOOP_END:
                    stats.loopPointCount++
                    output.push(" (no payload)")
                    break

                case TAV_PACKET_SCREEN_MASK:
                    let frameNumber = seqread.readInt()
                    let top = seqread.readShort()
                    let right = seqread.readShort()
                    let bottom = seqread.readShort()
                    let left = seqread.readShort()
                    output.push(` - Frame=${frameNumber} [top=${top}, right=${right}, bottom=${bottom}, left=${left}]`)
                    break

                case TAV_PACKET_SYNC:
                    stats.syncCount++
                    break

                case TAV_PACKET_SYNC_NTSC:
                    stats.syncNtscCount++
                    break

                case TAV_PACKET_NOOP:
                    // Silent no-op
                    break

                default:
                    stats.unknownCount++
                    output.push(" (UNKNOWN)")
                    break
            }

            output.push("\n")
            packetNum++
        }
    } catch (e) {
        output.push(`\nError during packet parsing: ${e}\n`)
    }

    // Print summary
    output.push("\n==================================================\n")
    output.push("Summary Statistics:\n")
    output.push("==================================================\n")
    output.push(`Total packets:        ${packetNum}\n`)
    output.push("\nVideo:\n")
    output.push(`  I-frames:           ${stats.iframeCount}\n`)
    output.push(`  P-frames:           ${stats.pframeCount}`)
    if (stats.pframeCount > 0) {
        output.push(` (INTRA: ${stats.pframeIntraCount}, DELTA: ${stats.pframeDeltaCount}, SKIP: ${stats.pframeSkipCount}`)
        let knownModes = stats.pframeIntraCount + stats.pframeDeltaCount + stats.pframeSkipCount
        if (knownModes < stats.pframeCount) {
            output.push(`, Unknown: ${stats.pframeCount - knownModes}`)
        }
        output.push(")")
    }
    output.push("\n")
    if (stats.gopUnifiedCount + stats.gopUnifiedMotionCount > 0) {
        let avgFramesPerGop = (stats.totalGopFrames / (stats.gopUnifiedCount + stats.gopUnifiedMotionCount)).toFixed(1)
        output.push(`  3D GOP packets:     ${stats.gopUnifiedCount + stats.gopUnifiedMotionCount} (total frames: ${stats.totalGopFrames}, avg ${avgFramesPerGop} frames/GOP)\n`)
        output.push(`  GOP sync packets:   ${stats.gopSyncCount}\n`)
    }
    output.push(`  Mux video:          ${stats.muxVideoCount}\n`)
    output.push(`  Total video bytes:  ${stats.totalVideoBytes} (${(stats.totalVideoBytes / 1024 / 1024).toFixed(2)} MB)\n`)
    output.push("\nAudio:\n")
    output.push(`  Total packets:      ${stats.audioCount}\n`)
    if (stats.audioMp2Count > 0) {
        output.push(`    MP2:              ${stats.audioMp2Count} packets, ${stats.audioMp2Bytes} bytes (${(stats.audioMp2Bytes / 1024 / 1024).toFixed(2)} MB)\n`)
    }
    if (stats.audioPcm8Count > 0) {
        output.push(`    PCM8 (zstd):      ${stats.audioPcm8Count} packets, ${stats.audioPcm8Bytes} bytes (${(stats.audioPcm8Bytes / 1024 / 1024).toFixed(2)} MB)\n`)
    }
    if (stats.audioTadCount > 0) {
        output.push(`    TAD32 (zstd):     ${stats.audioTadCount} packets, ${stats.audioTadBytes} bytes (${(stats.audioTadBytes / 1024 / 1024).toFixed(2)} MB)\n`)
    }
    if (stats.audioTrackCount > 0) {
        output.push(`    Separate track:   ${stats.audioTrackCount} packets, ${stats.audioTrackBytes} bytes (${(stats.audioTrackBytes / 1024 / 1024).toFixed(2)} MB)\n`)
    }
    output.push(`  Total audio bytes:  ${stats.totalAudioBytes} (${(stats.totalAudioBytes / 1024 / 1024).toFixed(2)} MB)\n`)
    output.push("\nOther:\n")
    output.push(`  Timecodes:          ${stats.timecodeCount}\n`)
    output.push(`  Subtitles:          ${stats.subtitleCount}\n`)
    if (stats.videotexCount > 0) {
        output.push(`  Videotex frames:    ${stats.videotexCount} (${stats.videotexBytes} bytes, ${(stats.videotexBytes / 1024 / 1024).toFixed(2)} MB)\n`)
    }
    output.push(`  Extended headers:   ${stats.extendedHeaderCount}\n`)
    output.push(`  Metadata packets:   ${stats.metadataCount}\n`)
    output.push(`  Loop points:        ${stats.loopPointCount}\n`)
    output.push(`  Sync packets:       ${stats.syncCount}\n`)
    output.push(`  NTSC sync packets:  ${stats.syncNtscCount}\n`)
    output.push(`  Unknown packets:    ${stats.unknownCount}\n`)

    // Write output to file
    try {
        let outputStr = output.join("")
        files.open(outputPath).swrite(outputStr)
        println(`Analysis complete. Report written to ${outputPath}`)
        return 0
    } catch (e) {
        println(`Error writing output file: ${e}`)
        return 1
    }
}

return main()
