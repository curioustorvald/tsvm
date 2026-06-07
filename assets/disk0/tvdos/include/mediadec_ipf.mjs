/*
 * mediadec_ipf.mjs — legacy MOV / iPF backend for the mediadec library.
 *
 * Ported from assets/disk0/tvdos/bin/playmv1.js.  Decodes iPF1 / iPF1a /
 * iPF2 / iPF2a / iPF1-delta video packets straight to the 4bpp display planes
 * (the proven, fast path), plus MP2 and raw-PCM audio and the background-colour
 * packet.  Presents at decode time (so blit() is a no-op); bias lighting is a
 * separate player-driven stage via the bias() method; the ASCII path reads the
 * planes back via common.sampleGrayScreen.
 */

const WIDTH = 560
const HEIGHT = 448
const FBUF_SIZE = WIDTH * HEIGHT

function create(magic, sr, fileLength, opts, common) {
    const audioR = common.makeAudioRouter(sr)

    // Header (after the 8-byte magic): w, h, fps, frameCount, queue info.
    let width = sr.readShort()
    let height = sr.readShort()
    let fps = sr.readShort(); if (fps == 0) fps = 9999
    const FRAME_COUNT = sr.readInt() % 16777216
    sr.readShort()                 // skip unused
    sr.readShort()                 // audioQueueInfo (unused for playback)
    sr.skip(10)

    graphics.setGraphicsMode(4)
    graphics.clearPixels(255)
    graphics.clearPixels2(240)

    const FRAME_TIME = 1.0 / fps
    const applyBias = common.makeBias(width, height, 4)

    const ipfbuf = sys.malloc(FBUF_SIZE)

    const info = {
        format: 'ipf', width: width, height: height, fps: fps,
        totalFrames: FRAME_COUNT, hasAudio: true, hasSubtitles: false,
        isInterlaced: false, colourSpace: 'YCoCg', graphicsMode: 4, isStill: false
    }

    // No subtitles in iPF; expose an inert state object for the uniform API.
    const subtitle = { visible: false, text: "", position: 0, useUnicode: false, dirty: false }

    let akku = FRAME_TIME
    let lastT = sys.nanoTime()
    let doFrameskip = true
    let autoBg = true
    let framesRead = 0
    let frameCount = 0
    let paused = false

    function setBackgroundPacket() {
        autoBg = false
        let rgbx = sr.readInt()
        graphics.setBackground((rgbx & 0xFF000000) >>> 24, (rgbx & 0x00FF0000) >>> 16, (rgbx & 0x0000FF00) >>> 8)
    }

    function step() {
        const now = sys.nanoTime()
        if (paused) { lastT = now; return { type: 'idle' } }
        akku += (now - lastT) / 1000000000.0
        lastT = now

        if (sr.getReadCount() >= fileLength) return { type: 'eof' }
        if (akku < FRAME_TIME) return { type: 'idle' }

        // Drain accumulated time into a frame budget (frameskip drops late frames).
        let frameUnit = 0
        while (akku >= FRAME_TIME) { akku -= FRAME_TIME; frameUnit += 1 }
        if (!doFrameskip) frameUnit = 1

        let displayed = false
        while (frameUnit >= 1 && sr.getReadCount() < fileLength) {
            let packetType = sr.readShort()

            if (0xFFFF === packetType) {            // sync — one frame boundary
                frameUnit -= 1
            }
            else if (0xFEFF === packetType) {       // explicit background colour
                setBackgroundPacket()
            }
            else if (packetType < 2047) {           // video
                if (packetType == 4 || packetType == 5 || packetType == 260 || packetType == 261) {
                    let decodefun = (packetType > 255) ? graphics.decodeIpf2 : graphics.decodeIpf1
                    let payloadLen = sr.readInt()
                    if (framesRead >= FRAME_COUNT) return { type: 'eof' }
                    framesRead += 1
                    let gz = sr.readBytes(payloadLen)
                    if (frameUnit == 1) {
                        gzip.decompFromTo(gz, payloadLen, ipfbuf)
                        decodefun(ipfbuf, common.DISP_RG, common.DISP_BA, width, height, (packetType & 255) == 5)
                        audioR.fire()
                        displayed = true
                        frameCount += 1
                    }
                    sys.free(gz)
                }
                else if (packetType == 516) {       // iPF1-delta
                    doFrameskip = false
                    let payloadLen = sr.readInt()
                    if (framesRead >= FRAME_COUNT) return { type: 'eof' }
                    framesRead += 1
                    let gz = sr.readBytes(payloadLen)
                    if (frameUnit == 1) {
                        gzip.decompFromTo(gz, payloadLen, ipfbuf)
                        graphics.applyIpf1d(ipfbuf, common.DISP_RG, common.DISP_BA, width, height)
                        audioR.fire()
                        displayed = true
                        frameCount += 1
                    }
                    sys.free(gz)
                }
                else {
                    throw Error(`Unknown iPF video packet type ${packetType} at ${sr.getReadCount() - 2}`)
                }
            }
            else if (4096 <= packetType && packetType <= 6143) {   // audio
                let readLength = (packetType >>> 8 == 17)
                    ? common.MP2_FRAME_SIZE[(packetType & 255) >>> 1]
                    : sr.readInt()
                if (readLength == 0) throw Error("iPF audio read length is zero")
                if (packetType >>> 8 == 17) {        // MP2
                    audioR.ensureMp2()
                    sr.readBytes(readLength, audioR.sndBase - 2368)
                    audio.mp2Decode()
                    audio.mp2UploadDecoded(0)
                }
                else if (packetType == 0x1000 || packetType == 0x1001) {   // raw PCM
                    audioR.rawPcm(readLength)
                }
                else {
                    throw Error(`iPF audio packet type ${packetType} at ${sr.getReadCount() - 2}`)
                }
            }
            else {
                // Unknown — stop to avoid desync (matches old players' break).
                return { type: 'eof' }
            }
        }

        return displayed ? { type: 'frame', frameCount: frameCount } : { type: 'idle' }
    }

    // The frame is already on the display planes (decoded there in step()), so
    // presenting is a no-op. Bias lighting is a separate, player-driven stage
    // (bias() below) and is skipped when an explicit background packet disabled it.
    function blit() { }

    // Frame is already on the display planes, so the player can sample the screen.
    function sampleGray(dst, w, h) { common.sampleGrayScreen(width, height, dst, w, h, 4) }

    return {
        info: info,
        subtitle: subtitle,
        get frameCount() { return frameCount },
        get currentTimecodeNs() { return Math.floor(frameCount * (1000000000.0 / fps)) },
        get videoRate() { return 0 },
        get frameMode() { return ' ' },
        cues: [],

        step: step,
        blit: blit,
        bias() { if (autoBg) applyBias() },   // skipped when an explicit bg packet set the colour
        sampleGray: sampleGray,
        pause(p) { paused = p; if (p) audioR.stop(); else { audioR.resume(); lastT = sys.nanoTime() } },
        isPaused() { return paused },
        setVolume(v) { audioR.setVolume(v) },
        getVolume() { return audioR.getVolume() },
        seekSeconds(_n) { /* iPF has no index; seeking unsupported */ },
        cue(_d) { /* no cues */ },

        close() {
            sys.free(ipfbuf)
            audioR.close()
        }
    }
}

exports = { create }
