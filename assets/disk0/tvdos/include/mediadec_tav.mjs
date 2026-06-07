/*
 * mediadec_tav.mjs — TAV (TSVM Advanced Video) backend for the mediadec library.
 *
 * Ported from assets/disk0/tvdos/bin/playtav.js — the heaviest backend.  DWT
 * codec with: I/P frames, unified 3D-DWT GOPs (async triple-buffer + overflow
 * queue), interlaced fields (yadif), TAP still images, UCF cue files +
 * multi-file concatenation, Left/Right + cue seeking, screen masking, videotex
 * (text-mode video), bundled MP2, and MP2/TAD/native-PCM audio, plus extended
 * headers (XFPS) and timecode-driven subtitles.
 *
 * The original main-loop body becomes step(): each call performs one iteration
 * (optional packet read + GOP state machine + a time-gated display) and returns
 * 'frame' when a frame is displayed.  The actual upload is deferred to blit()
 * (or sampleGray() in ASCII mode), which is the only structural change from the
 * original — it lets the same decoded frame feed either the graphics path or
 * the ASCII path.
 */

const TAV_VERSION = 1
const UCF_VERSION = 1
const ADDRESSING_EXTERNAL = 0x01
const ADDRESSING_INTERNAL = 0x02
const TAV_TEMPORAL_LEVELS = 2

const TAV_PACKET_IFRAME = 0x10
const TAV_PACKET_PFRAME = 0x11
const TAV_PACKET_GOP_UNIFIED = 0x12
const TAV_PACKET_AUDIO_MP2 = 0x20
const TAV_PACKET_AUDIO_NATIVE = 0x21
const TAV_PACKET_AUDIO_PCM_16LE = 0x22
const TAV_PACKET_AUDIO_ADPCM = 0x23
const TAV_PACKET_AUDIO_TAD = 0x24
const TAV_PACKET_SUBTITLE = 0x30
const TAV_PACKET_SUBTITLE_TC = 0x31
const TAV_PACKET_VIDEOTEX = 0x3F
const TAV_PACKET_AUDIO_BUNDLED = 0x40
const TAV_PACKET_EXTENDED_HDR = 0xEF
const TAV_PACKET_SCREEN_MASK = 0xF2
const TAV_PACKET_GOP_SYNC = 0xFC
const TAV_PACKET_TIMECODE = 0xFD
const TAV_PACKET_SYNC_NTSC = 0xFE
const TAV_PACKET_SYNC = 0xFF
const TAV_FILE_HEADER_FIRST = 0x1F

const BLIP = '\x847u'

const BUFFER_SLOTS = 3
const MAX_GOP_SIZE = 24

function create(magic, sr, fileLength, opts, common, isTap) {
    const QLUT = common.QLUT
    const audioR = common.makeAudioRouter(sr)
    const subEngine = common.makeSubtitleEngine(sr, -133121)   // TAV font-ROM base
    const SND_BASE = audioR.sndBase
    const AUDIO_DEVICE = audioR.playhead

    // ── Header (32 bytes incl. magic) ───────────────────────────────────────
    let version = sr.readOneByte()
    let width = sr.readShort()
    let height = sr.readShort()
    let fps = sr.readOneByte()
    let fps_num = fps, fps_den = 1
    let totalFrames = sr.readInt()
    let waveletFilter = sr.readOneByte()
    let decompLevels = sr.readOneByte()
    let qualityY = sr.readOneByte()
    let qualityCo = sr.readOneByte()
    let qualityCg = sr.readOneByte()
    let extraFlags = sr.readOneByte()
    let videoFlags = sr.readOneByte()
    let qualityLevel = sr.readOneByte()
    let channelLayout = sr.readOneByte()
    let entropyCoder = sr.readOneByte()
    let encoderPreset = sr.readOneByte()
    sr.skip(2)                       // reserved + device orientation
    let fileRole = sr.readOneByte()

    let baseVersion = (version > 8) ? (version - 8) : version
    let temporalMotionCoder = (version > 8) ? 1 : 0
    if (baseVersion < 1 || baseVersion > 8) throw Error(`Unsupported TAV base version ${baseVersion}`)

    const hasAudio = (extraFlags & 0x01) !== 0
    const hasSubtitles = (extraFlags & 0x02) !== 0
    let isInterlaced = (videoFlags & 0x01) !== 0
    let isNTSC = (videoFlags & 0x02) !== 0
    let isLossless = (videoFlags & 0x04) !== 0
    let colourSpace = (version % 2 == 0) ? "ICtCp" : "YCoCg"

    // ── Graphics ─────────────────────────────────────────────────────────────
    graphics.setGraphicsMode(4)
    graphics.setGraphicsMode(5)
    graphics.clearPixels(0); graphics.clearPixels2(0); graphics.clearPixels3(0); graphics.clearPixels4(0)
    let gpuGraphicsMode = graphics.getGraphicsMode()

    let decodeHeight = isInterlaced ? (height >> 1) : height
    let frametime = 1000000000.0 / fps
    let FRAME_TIME = 1.0 / fps
    let applyBias = common.makeBias(width, height, gpuGraphicsMode)

    // ── Frame buffers ────────────────────────────────────────────────────────
    let FRAME_SIZE = width * height * 3
    const SLOT_SIZE = MAX_GOP_SIZE * width * height * 3
    const RGB_BUFFER_A = sys.malloc(FRAME_SIZE)
    const RGB_BUFFER_B = sys.malloc(FRAME_SIZE)
    sys.memset(RGB_BUFFER_A, 0, FRAME_SIZE)
    sys.memset(RGB_BUFFER_B, 0, FRAME_SIZE)
    let CURRENT_RGB = RGB_BUFFER_A
    let PREV_RGB = RGB_BUFFER_B

    const FIELD_SIZE = width * decodeHeight * 3
    const CURR_FIELD = isInterlaced ? sys.malloc(FIELD_SIZE) : 0
    const PREV_FIELD = isInterlaced ? sys.malloc(FIELD_SIZE) : 0
    const NEXT_FIELD = isInterlaced ? sys.malloc(FIELD_SIZE) : 0
    if (isInterlaced) { sys.memset(CURR_FIELD, 0, FIELD_SIZE); sys.memset(PREV_FIELD, 0, FIELD_SIZE); sys.memset(NEXT_FIELD, 0, FIELD_SIZE) }
    let prevField = PREV_FIELD, curField = CURR_FIELD, nextField = NEXT_FIELD

    const info = {
        format: isTap ? 'tap' : 'tav', width: width, height: height, fps: fps,
        totalFrames: totalFrames, hasAudio: hasAudio, hasSubtitles: hasSubtitles,
        isInterlaced: isInterlaced, colourSpace: colourSpace, graphicsMode: gpuGraphicsMode,
        isStill: !!isTap
    }

    // ── Playback / GOP state ─────────────────────────────────────────────────
    let frameCount = 0, trueFrameCount = 0
    let akku = FRAME_TIME, akku2 = 0.0
    let firstFrameIssued = false
    let nextFrameTime = 0
    let paused = false
    let decoderDbgInfo = {}
    let videoRate = 0
    let videoRateBin = []

    let currentGopBufferSlot = 0, currentGopSize = 0, currentGopFrameIndex = 0
    let readyGopData = null, decodingGopData = null
    let asyncDecodeInProgress = false, asyncDecodeSlot = 0, asyncDecodeGopSize = 0
    let asyncDecodePtr = 0, asyncDecodeStartTime = 0
    let iframeReady = false
    let shouldReadPackets = true
    let overflowQueue = []

    let predecodedPcmBuffer = null, predecodedPcmSize = 0, predecodedPcmOffset = 0
    const PCM_UPLOAD_CHUNK = 2304

    let cueElements = [], currentCueIndex = -1, skipped = false
    let iframePositions = []
    let currentFileIndex = 1

    // Subtitle/timecode
    let currentTimecodeNs = 0, baseTimecodeNs = 0, baseTimecodeFrameCount = 0

    // Screen mask
    let screenMaskEntries = [], screenMaskTop = 0, screenMaskRight = 0, screenMaskBottom = 0, screenMaskLeft = 0

    // Deferred-display descriptor consumed by blit()/sampleGray().
    let pending = { kind: null, src: 0, frameIndex: 0, bufferOffset: 0, frameNo: 0, gopSize: 0 }

    let lastT = sys.nanoTime()

    // ── Helpers ──────────────────────────────────────────────────────────────
    function updateDataRateBin(rate) { videoRateBin.push(rate); if (videoRateBin.length > 10) videoRateBin.shift() }
    function getVideoRate() { let b = videoRateBin.reduce((a, c) => a + c, 0); return b * fps / videoRateBin.length }

    function parseXFPS(s) {
        let p = s.split("/")
        if (p.length === 2) { let n = parseInt(p[0], 10), d = parseInt(p[1], 10); if (!isNaN(n) && !isNaN(d) && d > 0) { fps_num = n; fps_den = d; fps = n / d; return true } }
        return false
    }

    function updateScreenMask(frameNum) {
        if (screenMaskEntries.length === 0) return
        for (let i = screenMaskEntries.length - 1; i >= 0; i--) {
            if (screenMaskEntries[i].frameNum <= frameNum) {
                screenMaskTop = screenMaskEntries[i].top; screenMaskRight = screenMaskEntries[i].right
                screenMaskBottom = screenMaskEntries[i].bottom; screenMaskLeft = screenMaskEntries[i].left
                return
            }
        }
    }
    function fillMaskedRegions() { return }   // disabled upstream; kept for parity

    function rotateFields() { let t = prevField; prevField = curField; curField = nextField; nextField = t }

    function cleanupAsyncDecode() {
        if (asyncDecodeInProgress && asyncDecodePtr) { sys.free(asyncDecodePtr); asyncDecodeInProgress = false; asyncDecodePtr = 0; asyncDecodeGopSize = 0 }
        if (readyGopData && readyGopData.compressedPtr) { sys.free(readyGopData.compressedPtr); readyGopData.compressedPtr = 0 }
        readyGopData = null
        if (decodingGopData && decodingGopData.compressedPtr) { sys.free(decodingGopData.compressedPtr); decodingGopData.compressedPtr = 0 }
        decodingGopData = null
        if (predecodedPcmBuffer !== null) { sys.free(predecodedPcmBuffer); predecodedPcmBuffer = null; predecodedPcmSize = 0; predecodedPcmOffset = 0 }
        currentGopSize = 0; currentGopFrameIndex = 0; nextFrameTime = 0; shouldReadPackets = true
    }

    function findNearestIframe(targetFrame) {
        if (iframePositions.length === 0) return null
        let result = null
        for (let i = iframePositions.length - 1; i >= 0; i--) { if (iframePositions[i].frameNum <= targetFrame) { result = iframePositions[i]; break } }
        return result || iframePositions[0]
    }

    function scanForwardToIframe(targetFrame) {
        let savedPos = sr.getReadCount()
        try {
            let scanFrameCount = frameCount
            while (sr.getReadCount() < fileLength) {
                let packetPos = sr.getReadCount()
                let pType = sr.readOneByte()
                if (pType === TAV_PACKET_SYNC || pType === TAV_PACKET_SYNC_NTSC) { if (pType === TAV_PACKET_SYNC) scanFrameCount++; continue }
                if (pType === TAV_PACKET_IFRAME && scanFrameCount >= targetFrame) { iframePositions.push({ offset: packetPos, frameNum: scanFrameCount }); return { offset: packetPos, frameNum: scanFrameCount } }
                if (pType !== TAV_PACKET_SYNC && pType !== TAV_PACKET_SYNC_NTSC && pType !== TAV_FILE_HEADER_FIRST) { let s = sr.readInt(); sr.skip(s) }
                else if (pType === TAV_FILE_HEADER_FIRST) break
            }
            return null
        } catch (e) { serial.printerr(`Scan error: ${e}`); return null }
        finally { sr.seek(savedPos) }
    }

    function applyNewHeader(h) {
        version = h.version; width = h.width; height = h.height; fps = h.fps
        totalFrames = h.totalFrames; waveletFilter = h.waveletFilter; decompLevels = h.decompLevels
        qualityY = h.qualityY; qualityCo = h.qualityCo; qualityCg = h.qualityCg
        extraFlags = h.extraFlags; videoFlags = h.videoFlags; qualityLevel = h.qualityLevel
        channelLayout = h.channelLayout
        baseVersion = (version > 8) ? (version - 8) : version
        temporalMotionCoder = (version > 8) ? 1 : 0
        isInterlaced = (videoFlags & 0x01) !== 0; isNTSC = (videoFlags & 0x02) !== 0; isLossless = (videoFlags & 0x04) !== 0
        colourSpace = (version % 2 == 0) ? "ICtCp" : "YCoCg"
        decodeHeight = isInterlaced ? (height >> 1) : height
        frametime = 1000000000.0 / fps; FRAME_TIME = 1.0 / fps
        applyBias = common.makeBias(width, height, gpuGraphicsMode)
        info.width = width; info.height = height; info.fps = fps; info.totalFrames = totalFrames
        info.isInterlaced = isInterlaced; info.colourSpace = colourSpace
    }

    // Returns a header object on success, or null/error code.
    function tryReadNextTAVHeader() {
        let newMagic = new Array(7)
        try {
            for (let i = 0; i < newMagic.length; i++) newMagic[i] = sr.readOneByte()
            while (newMagic[0] == 255) { newMagic.shift(); newMagic[newMagic.length - 1] = sr.readOneByte() }

            let isValidTAV = true, isValidUCF = true
            for (let i = 0; i < newMagic.length; i++) { if (newMagic[i] !== common.MAGIC_TAV[i + 1]) isValidTAV = false }
            for (let i = 0; i < newMagic.length; i++) { if (newMagic[i] !== common.MAGIC_UCF[i + 1]) isValidUCF = false }
            if (!isValidTAV && !isValidUCF) { serial.printerr("Header mismatch: got " + newMagic.join()); return null }

            if (isValidTAV) {
                let h = {
                    version: sr.readOneByte(), width: sr.readShort(), height: sr.readShort(),
                    fps: sr.readOneByte(), totalFrames: sr.readInt(), waveletFilter: sr.readOneByte(),
                    decompLevels: sr.readOneByte(), qualityY: sr.readOneByte(), qualityCo: sr.readOneByte(),
                    qualityCg: sr.readOneByte(), extraFlags: sr.readOneByte(), videoFlags: sr.readOneByte(),
                    qualityLevel: sr.readOneByte(), channelLayout: sr.readOneByte(), fileRole: sr.readOneByte()
                }
                for (let i = 0; i < 4; i++) sr.readOneByte()   // reserved
                return h
            }
            // UCF cue file: parse cue table then recurse to the following TAV header.
            let uver = sr.readOneByte()
            if (uver !== UCF_VERSION) { serial.println(`Unsupported UCF version ${uver}`); return null }
            let numElements = sr.readShort()
            let cueSize = sr.readInt()
            sr.skip(1)
            for (let i = 0; i < numElements; i++) {
                let el = {}
                el.addressingModeAndIntent = sr.readOneByte()
                el.addressingMode = el.addressingModeAndIntent & 15
                let nameLen = sr.readShort()
                el.name = sr.readString(nameLen)
                if (el.addressingMode === ADDRESSING_EXTERNAL) { let pl = sr.readShort(); el.path = sr.readString(pl) }
                else if (el.addressingMode === ADDRESSING_INTERNAL) {
                    let ob = []
                    for (let j = 0; j < 6; j++) ob.push(sr.readOneByte())
                    let low32 = 0; for (let j = 0; j < 4; j++) low32 |= (ob[j] << (j * 8))
                    let high16 = 0; for (let j = 4; j < 6; j++) high16 |= (ob[j] << ((j - 4) * 8))
                    el.offset = (high16 * 0x100000000) + (low32 >>> 0)
                } else { serial.println(`Unknown addressing mode ${el.addressingMode}`); return null }
                cueElements.push(el)
            }
            let rc = sr.getReadCount()
            sr.skip(cueSize - rc + 1)
            currentFileIndex -= 1
            return tryReadNextTAVHeader()
        } catch (e) { serial.printerr(e); return null }
    }

    function feedPredecodedPcm() {
        if (predecodedPcmBuffer !== null && predecodedPcmOffset < predecodedPcmSize) {
            let remaining = predecodedPcmSize - predecodedPcmOffset
            let uploadSize = Math.min(PCM_UPLOAD_CHUNK, remaining)
            sys.memcpy(predecodedPcmBuffer + predecodedPcmOffset, SND_BASE, uploadSize)
            audio.setSampleUploadLength(AUDIO_DEVICE, uploadSize)
            audio.startSampleUpload(AUDIO_DEVICE)
            predecodedPcmOffset += uploadSize
        }
    }

    function startAsyncGop(d) {
        graphics.tavDecodeGopToVideoBufferAsync(
            d.compressedPtr, d.compressedSize, d.gopSize,
            width, decodeHeight, baseVersion >= 5, qualityLevel,
            QLUT[qualityY], QLUT[qualityCo], QLUT[qualityCg], channelLayout,
            waveletFilter, decompLevels, TAV_TEMPORAL_LEVELS, entropyCoder,
            d.slot * SLOT_SIZE, temporalMotionCoder, encoderPreset
        )
        asyncDecodeInProgress = true; asyncDecodeSlot = d.slot; asyncDecodeGopSize = d.gopSize
        asyncDecodePtr = d.compressedPtr; asyncDecodeStartTime = sys.nanoTime()
    }

    // ── Decode one I/P video packet into CURRENT_RGB (or field buffer) ───────
    function decodeIPFrame(packetType, packetOffset) {
        updateScreenMask(frameCount)
        if (packetType === TAV_PACKET_IFRAME) iframePositions.push({ offset: packetOffset, frameNum: frameCount })
        const compressedSize = sr.readInt()
        let compressedPtr = sr.readBytes(compressedSize)
        updateDataRateBin(compressedSize)
        videoRate = compressedSize
        try {
            let decodeTarget = isInterlaced ? curField : CURRENT_RGB
            decoderDbgInfo = graphics.tavDecodeCompressed(
                compressedPtr, compressedSize, decodeTarget, PREV_RGB,
                width, decodeHeight, qualityLevel,
                QLUT[qualityY], QLUT[qualityCo], QLUT[qualityCg], channelLayout,
                trueFrameCount, waveletFilter, decompLevels, isLossless, version, entropyCoder, encoderPreset
            )
            if (isInterlaced) {
                graphics.tavDeinterlace(trueFrameCount, width, decodeHeight, prevField, curField, nextField, CURRENT_RGB, "yadif")
                rotateFields()
            }
            iframeReady = true
        } catch (e) { console.log(`TAV frame ${frameCount}: decode failed: ${e}`) }
        finally { sys.free(compressedPtr) }
    }

    // ── GOP packet handling (Cases 1–5 + overflow) ──────────────────────────
    function handleGopPacket() {
        const gopSize = sr.readOneByte()
        const compressedSize = sr.readInt()
        let compressedPtr = sr.readBytes(compressedSize)
        updateDataRateBin(compressedSize / gopSize)
        decoderDbgInfo.frameMode = " "

        if (gopSize > MAX_GOP_SIZE) { sys.free(compressedPtr); return }

        if (currentGopSize === 0 && !asyncDecodeInProgress) {
            if (asyncDecodePtr !== 0) { sys.free(asyncDecodePtr); asyncDecodePtr = 0 }
            startAsyncGop({ compressedPtr, compressedSize, gopSize, slot: currentGopBufferSlot })
        }
        else if (currentGopSize === 0 && asyncDecodeInProgress) {
            if (readyGopData === null) {
                readyGopData = { gopSize, slot: (currentGopBufferSlot + 1) % BUFFER_SLOTS, compressedPtr, compressedSize, needsDecode: true, startTime: 0, timeRemaining: 0 }
            } else if (decodingGopData === null) {
                decodingGopData = { gopSize, slot: (currentGopBufferSlot + 2) % BUFFER_SLOTS, compressedPtr, compressedSize, needsDecode: true, startTime: 0, timeRemaining: 0 }
                shouldReadPackets = false
            } else { sys.free(compressedPtr) }
        }
        else if (currentGopSize > 0 && readyGopData === null && !asyncDecodeInProgress && graphics.tavDecodeGopIsComplete()) {
            let nextSlot = (currentGopBufferSlot + 1) % BUFFER_SLOTS
            startAsyncGop({ compressedPtr, compressedSize, gopSize, slot: nextSlot })
            readyGopData = { gopSize, slot: nextSlot, compressedPtr, startTime: asyncDecodeStartTime, timeRemaining: 0 }
            shouldReadPackets = false
        }
        else if (currentGopSize > 0 && readyGopData !== null && decodingGopData === null && !asyncDecodeInProgress && graphics.tavDecodeGopIsComplete()) {
            let decodingSlot = (currentGopBufferSlot + 2) % BUFFER_SLOTS
            startAsyncGop({ compressedPtr, compressedSize, gopSize, slot: decodingSlot })
            decodingGopData = { gopSize, slot: decodingSlot, compressedPtr, startTime: asyncDecodeStartTime, timeRemaining: 0 }
            shouldReadPackets = false
        }
        else {
            overflowQueue.push({ gopSize, compressedPtr, compressedSize })
        }
    }

    // ── One packet ───────────────────────────────────────────────────────────
    // Returns true if a multi-file header switch happened (caller emits 'newfile').
    function readOnePacket() {
        let packetOffset = sr.getReadCount()
        let packetType = sr.readOneByte()
        let newfile = false

        if (packetType == TAV_FILE_HEADER_FIRST) {
            let nh = tryReadNextTAVHeader()
            if (nh) {
                applyNewHeader(nh)
                frameCount = 0; akku = 0.0; akku2 = 0.0; firstFrameIssued = false
                baseTimecodeNs = 0; baseTimecodeFrameCount = 0; currentTimecodeNs = 0
                audio.purgeQueue(AUDIO_DEVICE)
                currentFileIndex++
                if (skipped) skipped = false; else currentCueIndex++
                packetType = sr.readOneByte()
                newfile = true
            } else { return { eof: true } }
        }

        if (packetType === TAV_PACKET_SYNC || packetType == TAV_PACKET_SYNC_NTSC) {
            // vestigial in TAV's time-based model
        }
        else if (packetType === TAV_PACKET_IFRAME || packetType === TAV_PACKET_PFRAME) {
            decodeIPFrame(packetType, packetOffset)
        }
        else if (packetType === TAV_PACKET_GOP_UNIFIED) {
            handleGopPacket()
        }
        else if (packetType === TAV_PACKET_GOP_SYNC) {
            sr.readOneByte()   // frames-in-GOP (ignored; time-based)
            if (currentGopSize > 0 && readyGopData !== null && decodingGopData !== null) shouldReadPackets = false
        }
        else if (packetType === TAV_PACKET_AUDIO_BUNDLED) {
            let totalAudioSize = sr.readInt()
            audioR.ensureMp2()
            let mp2Buffer = sys.malloc(totalAudioSize)
            sr.readBytes(totalAudioSize, mp2Buffer)
            const estimatedPcmSize = totalAudioSize * 12
            predecodedPcmBuffer = sys.malloc(estimatedPcmSize); predecodedPcmSize = 0; predecodedPcmOffset = 0
            const MP2_DECODE_CHUNK = 2304
            let srcOffset = 0
            while (srcOffset < totalAudioSize) {
                let chunkSize = Math.min(MP2_DECODE_CHUNK, totalAudioSize - srcOffset)
                sys.memcpy(mp2Buffer + srcOffset, SND_BASE - 2368, chunkSize)
                audio.mp2Decode()
                sys.memcpy(SND_BASE, predecodedPcmBuffer + predecodedPcmSize, 2304)
                predecodedPcmSize += 2304
                srcOffset += chunkSize
            }
            sys.free(mp2Buffer)
        }
        else if (packetType === TAV_PACKET_AUDIO_MP2) { let len = sr.readInt(); audioR.mp2(len) }
        else if (packetType === TAV_PACKET_AUDIO_TAD) { let sampleLen = sr.readShort(); let payloadLen = sr.readInt(); audioR.tad(sampleLen, payloadLen) }
        else if (packetType === TAV_PACKET_AUDIO_NATIVE) { let zstdLen = sr.readInt(); audioR.nativePcm(zstdLen) }
        else if (packetType === TAV_PACKET_SUBTITLE) { let size = sr.readInt(); subEngine.parseLegacy(size) }
        else if (packetType === TAV_PACKET_SUBTITLE_TC) { let size = sr.readInt(); subEngine.parseTC(size) }
        else if (packetType === TAV_PACKET_VIDEOTEX) {
            let compressedSize = sr.readInt()
            let compressedPtr = sr.readBytes(compressedSize)
            let decompressedPtr = sys.malloc(8192)
            gzip.decompFromTo(compressedPtr, compressedSize, decompressedPtr)
            let rows = sys.peek(decompressedPtr), cols = sys.peek(decompressedPtr + 1)
            let gridSize = rows * cols
            sys.memcpy(decompressedPtr + 2, -1302529, gridSize * 3)
            sys.free(compressedPtr); sys.free(decompressedPtr)
            iframeReady = true   // displayed via the I/P path (uploads CURRENT_RGB under the text)
        }
        else if (packetType === TAV_PACKET_EXTENDED_HDR) {
            let numPairs = sr.readShort()
            for (let i = 0; i < numPairs; i++) {
                let keyBytes = sr.readBytes(4); let key = ""
                for (let j = 0; j < 4; j++) key += String.fromCharCode(sys.peek(keyBytes + j))
                sys.free(keyBytes)
                let valueType = sr.readOneByte()
                if (valueType === 0x04) { sr.readInt(); sr.readInt() }
                else if (valueType === 0x10) {
                    let length = sr.readShort(); let dataBytes = sr.readBytes(length); let dataStr = ""
                    for (let j = 0; j < length; j++) dataStr += String.fromCharCode(sys.peek(dataBytes + j))
                    sys.free(dataBytes)
                    if (key === "XFPS" && parseXFPS(dataStr)) { frametime = 1000000000.0 / fps; FRAME_TIME = 1.0 / fps }
                }
            }
        }
        else if (packetType === TAV_PACKET_SCREEN_MASK) {
            let frameNum = sr.readInt()
            let top = sr.readOneByte() | (sr.readOneByte() << 8)
            let right = sr.readOneByte() | (sr.readOneByte() << 8)
            let bottom = sr.readOneByte() | (sr.readOneByte() << 8)
            let left = sr.readOneByte() | (sr.readOneByte() << 8)
            screenMaskEntries.push({ frameNum, top, right, bottom, left })
        }
        else if (packetType === TAV_PACKET_TIMECODE) {
            let lo = sr.readInt(), hi = sr.readInt()
            let tc = hi * 0x100000000 + (lo >>> 0)
            baseTimecodeNs = tc; baseTimecodeFrameCount = frameCount; currentTimecodeNs = tc
            decoderDbgInfo.frameMode = BLIP
        }
        else if (packetType == 0x00) { /* stray arg-terminator byte */ }
        else { serial.println(`TAV unknown packet 0x${packetType.toString(16)}`); return { eof: true } }

        return { newfile: newfile }
    }

    // ── step(): one main-loop iteration ─────────────────────────────────────
    function step() {
        // TAP still: show the pre-decoded frame once, then idle.
        if (isTap) {
            if (!firstFrameIssued) { firstFrameIssued = true; pending = { kind: 'rgb', src: CURRENT_RGB, frameNo: 0 }; return { type: 'frame', frameCount: 1 } }
            return { type: 'idle' }
        }

        // EOF: stream exhausted and nothing buffered.
        if (sr.getReadCount() >= fileLength && currentGopSize === 0 && readyGopData === null && decodingGopData === null && !asyncDecodeInProgress && overflowQueue.length === 0) {
            return { type: 'eof' }
        }

        let newfileEvent = false

        // 1) Gated packet read.
        if (shouldReadPackets && !paused && sr.getReadCount() < fileLength) {
            let r = readOnePacket()
            if (r.eof) return { type: 'eof' }
            if (r.newfile) newfileEvent = true
        }

        // Time accumulation (only while a GOP plays / after first frame).
        let t2 = sys.nanoTime()
        if (!paused && firstFrameIssued) {
            let dt = (t2 - lastT) / 1000000000.0
            if (currentGopSize > 0) akku += dt
            akku2 += dt
        }
        lastT = t2

        let displayed = false

        // Step 1: first-GOP decode wait.
        if (asyncDecodeInProgress && currentGopSize === 0) {
            if (!graphics.tavDecodeGopIsComplete()) { sys.sleep(1) }
            else {
                const res = graphics.tavDecodeGopGetResult(); decoderDbgInfo = res[1]
                currentGopSize = asyncDecodeGopSize; currentGopFrameIndex = 0; currentGopBufferSlot = asyncDecodeSlot
                asyncDecodeInProgress = false
                if (nextFrameTime === 0) nextFrameTime = sys.nanoTime()
                if (!(currentGopSize > 0 && readyGopData !== null && decodingGopData !== null)) shouldReadPackets = true
                sys.free(asyncDecodePtr); asyncDecodePtr = 0; asyncDecodeGopSize = 0
                if (readyGopData !== null && readyGopData.needsDecode) {
                    startAsyncGop(readyGopData); readyGopData.needsDecode = false; readyGopData.startTime = asyncDecodeStartTime
                }
            }
        }

        // Step 2a: display I/P frame when due.
        if (!paused && iframeReady && currentGopSize === 0) {
            if (nextFrameTime === 0) nextFrameTime = sys.nanoTime()
            while (sys.nanoTime() < nextFrameTime && !paused) sys.sleep(1)
            if (!paused) {
                pending = { kind: 'rgb', src: CURRENT_RGB, frameNo: trueFrameCount }
                audioR.fire()
                firstFrameIssued = true
                frameCount++; trueFrameCount++; iframeReady = false
                currentTimecodeNs = Math.floor(akku2 * 1000000000)
                if (subEngine.hasEvents()) subEngine.poll(currentTimecodeNs)
                let t = CURRENT_RGB; CURRENT_RGB = PREV_RGB; PREV_RGB = t
                nextFrameTime += frametime
                displayed = true
            }
        }

        // Step 2&3: display GOP frame when due.
        if (!paused && currentGopSize > 0 && currentGopFrameIndex < currentGopSize) {
            while (sys.nanoTime() < nextFrameTime && !paused) sys.sleep(1)
            if (!paused) {
                if (isInterlaced) pending = { kind: 'gop-interlaced', frameIndex: currentGopFrameIndex, bufferOffset: currentGopBufferSlot * SLOT_SIZE, frameNo: trueFrameCount, gopSize: currentGopSize }
                else pending = { kind: 'gop', frameIndex: currentGopFrameIndex, bufferOffset: currentGopBufferSlot * SLOT_SIZE, frameNo: trueFrameCount, gopSize: currentGopSize }
                audioR.fire()
                firstFrameIssued = true
                currentGopFrameIndex++; frameCount++; trueFrameCount++
                currentTimecodeNs = Math.floor(akku2 * 1000000000)
                if (subEngine.hasEvents()) subEngine.poll(currentTimecodeNs)
                feedPredecodedPcm()
                if (decodingGopData !== null && decodingGopData.needsDecode && graphics.tavDecodeGopIsComplete()) {
                    startAsyncGop(decodingGopData); decodingGopData.needsDecode = false; decodingGopData.startTime = asyncDecodeStartTime
                }
                nextFrameTime += frametime
                displayed = true
            }
        }

        // Step 4–7: GOP finished → transition to ready GOP (triple-buffer rotate).
        if (!paused && currentGopSize > 0 && currentGopFrameIndex >= currentGopSize) {
            if (readyGopData !== null) {
                if (readyGopData.needsDecode) { startAsyncGop(readyGopData); readyGopData.needsDecode = false; readyGopData.startTime = sys.nanoTime() }
                while (!graphics.tavDecodeGopIsComplete() && !paused) sys.sleep(1)
                if (!paused) {
                    graphics.tavDecodeGopGetResult()
                    sys.free(readyGopData.compressedPtr)
                    currentGopBufferSlot = readyGopData.slot; currentGopSize = readyGopData.gopSize; currentGopFrameIndex = 0
                    readyGopData = decodingGopData; decodingGopData = null
                    if (graphics.tavDecodeGopIsComplete()) { asyncDecodeInProgress = false; asyncDecodePtr = 0; asyncDecodeGopSize = 0 }
                    shouldReadPackets = true
                    // Drain overflow queue into a free slot.
                    if (overflowQueue.length > 0 && !asyncDecodeInProgress && graphics.tavDecodeGopIsComplete()) {
                        const ov = overflowQueue.shift()
                        let targetSlot = (readyGopData === null) ? (currentGopBufferSlot + 1) % BUFFER_SLOTS
                                        : (decodingGopData === null) ? (currentGopBufferSlot + 2) % BUFFER_SLOTS : -1
                        if (targetSlot < 0) overflowQueue.unshift(ov)
                        else {
                            startAsyncGop({ compressedPtr: ov.compressedPtr, compressedSize: ov.compressedSize, gopSize: ov.gopSize, slot: targetSlot })
                            let rec = { gopSize: ov.gopSize, slot: targetSlot, compressedPtr: ov.compressedPtr, startTime: asyncDecodeStartTime, timeRemaining: 0 }
                            if (readyGopData === null) readyGopData = rec; else decodingGopData = rec
                        }
                    }
                }
            } else {
                currentGopSize = 0; currentGopFrameIndex = 0; shouldReadPackets = true
            }
        }

        sys.sleep(1)

        if (newfileEvent) return { type: 'newfile', frameCount: frameCount }
        return displayed ? { type: 'frame', frameCount: frameCount } : { type: 'idle' }
    }

    // ── Present / sample ─────────────────────────────────────────────────────
    function blit() {
        if (pending.kind === 'rgb') {
            graphics.uploadRGBToFramebuffer(pending.src, width, height, pending.frameNo, false)
        } else if (pending.kind === 'gop') {
            graphics.uploadVideoBufferFrameToFramebuffer(pending.frameIndex, width, height, pending.frameNo, pending.bufferOffset)
            updateScreenMask(frameCount); fillMaskedRegions()
        } else if (pending.kind === 'gop-interlaced') {
            graphics.uploadInterlacedGopFrameToFramebuffer(pending.frameIndex, pending.gopSize, width, decodeHeight, height, pending.frameNo, pending.bufferOffset, prevField, curField, nextField, CURRENT_RGB)
            updateScreenMask(frameCount); fillMaskedRegions()
        }
        // bias lighting is a separate, player-driven stage (bias() below)
    }

    // Player calls blit() before sampleGray() in ASCII mode, so the framebuffer
    // already holds the current frame regardless of kind.
    function sampleGray(dst, w, h) { common.sampleGrayScreen(width, height, dst, w, h, gpuGraphicsMode) }
    function sampleColour(dst, w, h) { common.sampleColourScreen(width, height, dst, w, h, gpuGraphicsMode) }

    // ── TAP still: decode the single image now ──────────────────────────────
    if (isTap) {
        let packetType = sr.readOneByte()
        while (packetType !== TAV_PACKET_IFRAME && sr.getReadCount() < fileLength) {
            if (packetType === TAV_PACKET_EXTENDED_HDR) {
                let numPairs = sr.readShort()
                for (let i = 0; i < numPairs; i++) {
                    let kb = sr.readBytes(4); let key = ""; for (let j = 0; j < 4; j++) key += String.fromCharCode(sys.peek(kb + j)); sys.free(kb)
                    let vt = sr.readOneByte()
                    if (vt === 0x04) sr.skip(8)
                    else if (vt === 0x10) { let len = sr.readShort(); let db = sr.readBytes(len); if (key === "XFPS") { let s = ""; for (let j = 0; j < len; j++) s += String.fromCharCode(sys.peek(db + j)); parseXFPS(s) } sys.free(db) }
                }
            } else if (packetType === TAV_PACKET_SCREEN_MASK) { sr.skip(12) }
            else if (packetType === TAV_PACKET_TIMECODE) { sr.skip(8) }
            else { let size = sr.readInt(); sr.skip(size) }
            packetType = sr.readOneByte()
        }
        if (packetType === TAV_PACKET_IFRAME) {
            const compressedSize = sr.readInt()
            const compressedPtr = sr.readBytes(compressedSize)
            graphics.tavDecodeCompressed(compressedPtr, compressedSize, CURRENT_RGB, PREV_RGB, width, height, qualityLevel, QLUT[qualityY], QLUT[qualityCo], QLUT[qualityCg], channelLayout, 0, waveletFilter, decompLevels, isLossless, version, entropyCoder, 2)
            sys.free(compressedPtr)
        }
    }

    return {
        info: info,
        subtitle: subEngine.subtitle,
        get frameCount() { return frameCount },
        get currentTimecodeNs() { return currentTimecodeNs },
        get akku() { return akku2 },
        get videoRate() { return getVideoRate() },
        get frameMode() { return decoderDbgInfo.frameMode || ' ' },
        get qY() { return decoderDbgInfo.qY }, get qCo() { return decoderDbgInfo.qCo }, get qCg() { return decoderDbgInfo.qCg },
        get cues() { return cueElements },
        get currentCueIndex() { return currentCueIndex },
        get currentFileIndex() { return currentFileIndex },

        step: step,
        blit: blit,
        bias() { applyBias() },
        sampleGray: sampleGray,
        sampleColour: sampleColour,

        pause(p) {
            paused = p
            if (p) audioR.stop()
            else { audioR.resume(); lastT = sys.nanoTime() }
        },
        isPaused() { return paused },
        setVolume(v) { audioR.setVolume(v) },
        getVolume() { return audioR.getVolume() },

        seekSeconds(n) {
            if (isTap) return
            let target
            if (n < 0) target = Math.max(0, frameCount - Math.floor(fps * (-n)))
            else target = Math.min(totalFrames - 1, frameCount + Math.floor(fps * n))
            let seekTarget = findNearestIframe(target)
            if (n > 0 && (!seekTarget || seekTarget.frameNum <= frameCount)) seekTarget = scanForwardToIframe(target)
            if (!seekTarget) return
            if (n > 0 && seekTarget.frameNum <= frameCount) return
            cleanupAsyncDecode()
            sr.seek(seekTarget.offset)
            frameCount = seekTarget.frameNum; akku = FRAME_TIME; akku2 += n; firstFrameIssued = false
            baseTimecodeNs = Math.floor(seekTarget.frameNum * frametime); baseTimecodeFrameCount = seekTarget.frameNum; currentTimecodeNs = baseTimecodeNs
            subEngine.resetTo(baseTimecodeNs)
            audio.purgeQueue(AUDIO_DEVICE)
            skipped = true
        },

        cue(d) {
            if (cueElements.length === 0) return
            currentCueIndex = (d < 0)
                ? ((currentCueIndex <= 0) ? cueElements.length - 1 : currentCueIndex - 1)
                : ((currentCueIndex >= cueElements.length - 1) ? 0 : currentCueIndex + 1)
            let cue = cueElements[currentCueIndex]
            if (cue.addressingMode !== ADDRESSING_INTERNAL) return
            cleanupAsyncDecode()
            sr.seek(cue.offset)
            frameCount = 0; akku = FRAME_TIME; akku2 = 0.0; firstFrameIssued = false
            baseTimecodeNs = 0; baseTimecodeFrameCount = 0; currentTimecodeNs = 0
            subEngine.resetTo(0)
            audio.purgeQueue(AUDIO_DEVICE)
            skipped = true
        },

        close() {
            cleanupAsyncDecode()
            sys.free(RGB_BUFFER_A); sys.free(RGB_BUFFER_B)
            if (isInterlaced) { sys.free(CURR_FIELD); sys.free(PREV_FIELD); sys.free(NEXT_FIELD) }
            while (overflowQueue.length > 0) { const ov = overflowQueue.shift(); sys.free(ov.compressedPtr) }
            audioR.close()
            sys.poke(-1299460, 20); sys.poke(-1299460, 21)   // reset font ROM
            graphics.resetPalette()
        }
    }
}

exports = { create }
