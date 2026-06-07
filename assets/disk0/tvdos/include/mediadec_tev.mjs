/*
 * mediadec_tev.mjs — TEV (TSVM Enhanced Video) backend for the mediadec library.
 *
 * Ported from assets/disk0/tvdos/bin/playtev.js.  DCT codec, YCoCg-R / ICtCp,
 * motion compensation, optional deblock / boundary-aware decoding, interlaced
 * (yadif/bwdif) support, NTSC frame duplication, MP2 audio, SSF + SSF-TC
 * subtitles.  Decodes into an off-screen RGB888 ping-pong buffer; blit() uploads
 * it (deferred from decode so the ASCII path can sample the same buffer).
 */

const TEV_VERSION_YCOCG = 2
const TEV_VERSION_ICtCp = 3

const TEV_PACKET_IFRAME = 0x10
const TEV_PACKET_PFRAME = 0x11
const TEV_PACKET_AUDIO_MP2 = 0x20
const TEV_PACKET_SUBTITLE = 0x30
const TEV_PACKET_SUBTITLE_TC = 0x31
const TEV_PACKET_SYNC = 0xFF

function create(magic, sr, fileLength, opts, common) {
    const audioR = common.makeAudioRouter(sr)
    const subEngine = common.makeSubtitleEngine(sr, -1300607)   // TEV font-ROM base

    // Header
    let version = sr.readOneByte()
    if (version !== TEV_VERSION_YCOCG && version !== TEV_VERSION_ICtCp) {
        throw Error(`Unsupported TEV version: ${version}`)
    }
    let width = sr.readShort()
    let height = sr.readShort()
    let fps = sr.readOneByte()
    let totalFrames = sr.readInt()
    let qualityY = sr.readOneByte()
    let qualityCo = sr.readOneByte()
    let qualityCg = sr.readOneByte()
    let flags = sr.readOneByte()
    let videoFlags = sr.readOneByte()
    sr.readOneByte()  // unused
    const hasAudio = !!(flags & 1)
    const hasSubtitle = !!(flags & 2)
    const isInterlaced = !!(videoFlags & 1)
    const isNTSC = !!(videoFlags & 2)
    const colorSpace = (version === TEV_VERSION_ICtCp) ? "ICtCp" : "YCoCg"

    // Options
    const debugMV = !!opts.debugMotionVectors
    const enableDeblock = !!opts.enableDeblocking
    const enableBoundaryAware = !!opts.enableBoundaryAwareDecoding
    const deinterlaceAlgo = opts.deinterlaceAlgorithm || "yadif"

    graphics.setGraphicsMode(4)
    graphics.clearPixels(0)
    graphics.clearPixels2(0)
    // NB: palette 0 is translucent black by default (used by the playgui chrome);
    // we deliberately do NOT redefine it, nor reset it on close.

    const FRAME_PIXELS = width * height
    const FRAME_SIZE = 560 * 448 * 3
    const FIELD_SIZE = 560 * 224 * 3

    const RGB_BUFFER_A = sys.malloc(FRAME_SIZE)
    const RGB_BUFFER_B = sys.malloc(FRAME_SIZE)
    sys.memset(RGB_BUFFER_A, 0, FRAME_PIXELS * 3)
    sys.memset(RGB_BUFFER_B, 0, FRAME_PIXELS * 3)
    let CURRENT_RGB = RGB_BUFFER_A
    let PREV_RGB = RGB_BUFFER_B

    const CURR_FIELD = isInterlaced ? sys.malloc(FIELD_SIZE) : 0
    const PREV_FIELD = isInterlaced ? sys.malloc(FIELD_SIZE) : 0
    const NEXT_FIELD = isInterlaced ? sys.malloc(FIELD_SIZE) : 0
    if (isInterlaced) {
        sys.memset(CURR_FIELD, 0, FIELD_SIZE); sys.memset(PREV_FIELD, 0, FIELD_SIZE); sys.memset(NEXT_FIELD, 0, FIELD_SIZE)
    }
    let curField = CURR_FIELD, prevField = PREV_FIELD, nextField = NEXT_FIELD

    sys.memset(common.DISP_RG, 0, FRAME_PIXELS)
    sys.memset(common.DISP_BA, 15, FRAME_PIXELS)

    const FRAME_TIME = 1.0 / fps
    const FRAME_TIME_NS = 1000000000.0 / fps
    const applyBias = common.makeBias(width, height, 4)

    const info = {
        format: 'tev', width: width, height: height, fps: fps,
        totalFrames: totalFrames, hasAudio: hasAudio, hasSubtitles: hasSubtitle,
        isInterlaced: isInterlaced, colourSpace: colorSpace, graphicsMode: 4, isStill: false
    }

    let akku = FRAME_TIME
    let lastT = sys.nanoTime()
    let frameCount = 0
    let trueFrameCount = 0
    let frameDuped = false
    let paused = false
    let currentFrameType = "I"
    let videoRate = 0
    let currentFrameSrc = CURRENT_RGB

    const blockDataPtr = sys.malloc(FRAME_SIZE)

    function rotateFields() { let t = prevField; prevField = curField; curField = nextField; nextField = t }

    function decodeVideo(packetType) {
        let payloadLen = sr.readInt()
        videoRate = payloadLen
        let compressedPtr = sr.readBytes(payloadLen)
        currentFrameType = (packetType == TEV_PACKET_IFRAME) ? "I" : "P"

        // NTSC frame duplication: drop one decode every 1000 frames (≈29.97).
        if (isNTSC && frameCount % 1000 == 501 && !frameDuped) {
            frameDuped = true
            sys.free(compressedPtr)
            return false   // keep previous frame on screen
        }
        frameDuped = false

        let actualSize
        try { actualSize = gzip.decompFromTo(compressedPtr, payloadLen, blockDataPtr) }
        catch (e) { sys.free(compressedPtr); serial.println(`TEV frame ${frameCount}: gzip failed: ${e}`); return false }

        let decodingHeight = isInterlaced ? (height / 2) | 0 : height
        if (isInterlaced) {
            graphics.tevDecode(blockDataPtr, nextField, curField, width, decodingHeight, qualityY, qualityCo, qualityCg, trueFrameCount, debugMV, version, enableDeblock, enableBoundaryAware)
            graphics.tevDeinterlace(trueFrameCount, width, decodingHeight, prevField, curField, nextField, CURRENT_RGB, deinterlaceAlgo)
            rotateFields()
        } else {
            graphics.tevDecode(blockDataPtr, CURRENT_RGB, PREV_RGB, width, decodingHeight, qualityY, qualityCo, qualityCg, trueFrameCount, debugMV, version, enableDeblock, enableBoundaryAware)
        }
        currentFrameSrc = CURRENT_RGB
        sys.free(compressedPtr)
        return true
    }

    function step() {
        const now = sys.nanoTime()
        if (paused) { lastT = now; return { type: 'idle' } }
        akku += (now - lastT) / 1000000000.0
        lastT = now

        if (sr.getReadCount() >= fileLength) return { type: 'eof' }
        if (akku < FRAME_TIME) return { type: 'idle' }

        let packetType = sr.readOneByte()

        if (packetType == TEV_PACKET_SYNC) {
            akku -= FRAME_TIME
            frameCount++
            trueFrameCount++
            // Swap ping-pong: the just-shown frame becomes the reference.
            let t = CURRENT_RGB; CURRENT_RGB = PREV_RGB; PREV_RGB = t
            return { type: 'idle' }
        }
        else if (packetType == TEV_PACKET_IFRAME || packetType == TEV_PACKET_PFRAME) {
            let shown = decodeVideo(packetType)
            if (shown) {
                // audio after frame 0 (progressive) / frame 1 (interlaced)
                if (!isInterlaced || frameCount > 0) audioR.fire()
                if (subEngine.hasEvents()) subEngine.poll(frameCount * FRAME_TIME_NS)
                return { type: 'frame', frameCount: frameCount }
            }
            return { type: 'idle' }
        }
        else if (packetType == TEV_PACKET_AUDIO_MP2) {
            let audioLen = sr.readInt()
            audioR.mp2(audioLen)
            return { type: 'idle' }
        }
        else if (packetType == TEV_PACKET_SUBTITLE) {
            let size = sr.readInt(); subEngine.parseLegacy(size); return { type: 'idle' }
        }
        else if (packetType == TEV_PACKET_SUBTITLE_TC) {
            let size = sr.readInt(); subEngine.parseTC(size); return { type: 'idle' }
        }
        else if (packetType == 0x00) {
            return { type: 'idle' }   // stray arg-terminator byte
        }
        else {
            serial.println(`TEV unknown packet type 0x${packetType.toString(16)}`)
            return { type: 'eof' }
        }
    }

    // Present only; bias lighting is a separate, player-driven stage (bias() below).
    function blit() {
        graphics.uploadRGBToFramebuffer(currentFrameSrc, width, height, frameCount, false)
    }

    // Player calls blit() (which uploads currentFrameSrc) before sampleGray in
    // ASCII mode, so we read the framebuffer the upload just produced.
    function sampleGray(dst, w, h) { common.sampleGrayScreen(width, height, dst, w, h, 4) }

    return {
        info: info,
        subtitle: subEngine.subtitle,
        get frameCount() { return frameCount },
        get currentTimecodeNs() { return Math.floor(frameCount * FRAME_TIME_NS) },
        get videoRate() { return videoRate * fps },
        get frameMode() { return currentFrameType },
        get qY() { return qualityY }, get qCo() { return qualityCo }, get qCg() { return qualityCg },
        cues: [],

        step: step,
        blit: blit,
        bias() { applyBias() },
        sampleGray: sampleGray,
        pause(p) { paused = p; if (p) audioR.stop(); else { audioR.resume(); lastT = sys.nanoTime() } },
        isPaused() { return paused },
        setVolume(v) { audioR.setVolume(v) },
        getVolume() { return audioR.getVolume() },
        seekSeconds(_n) { /* TEV has no index; seeking unsupported */ },
        cue(_d) {},

        close() {
            sys.free(blockDataPtr)
            sys.free(RGB_BUFFER_A); sys.free(RGB_BUFFER_B)
            if (isInterlaced) { sys.free(CURR_FIELD); sys.free(PREV_FIELD); sys.free(NEXT_FIELD) }
            audioR.close()
        }
    }
}

exports = { create }
