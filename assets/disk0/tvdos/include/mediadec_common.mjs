/*
 * mediadec_common.mjs — shared front-end utilities for the mediadec library.
 *
 * Holds everything the three movie backends (iPF/MOV, TEV, TAV) duplicated in
 * the old standalone players: magic constants, packet-type / SSF-opcode tables,
 * the TAV quality LUT, seqread selection, the audio router, the subtitle
 * engine, bias lighting, and the two `sampleGray` source samplers used by the
 * player's ASCII-render path.
 *
 * Runs in the same GraalVM context as the player, so the host globals
 * (sys/graphics/audio/con/serial/files/gzip) are visible directly, exactly as
 * in seqread.mjs / playgui.mjs.
 */

// ── Magic numbers ───────────────────────────────────────────────────────────
const MAGIC_MOV = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x4D, 0x4F, 0x56] // "\x1FTSVMMOV"
const MAGIC_TEV = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x54, 0x45, 0x56] // "\x1FTSVMTEV"
const MAGIC_TAV = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x54, 0x41, 0x56] // "\x1FTSVMTAV"
const MAGIC_TAP = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x54, 0x41, 0x50] // "\x1FTSVMTAP"
const MAGIC_UCF = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x55, 0x43, 0x46] // "\x1FTSVMUCF"

// ── MP2 frame-size table (shared by iPF/TEV/TAV) ────────────────────────────
const MP2_FRAME_SIZE = [144,216,252,288,360,432,504,576,720,864,1008,1152,1440,1728]

// ── SSF subtitle opcodes (shared) ───────────────────────────────────────────
const SSF_OP_NOP = 0x00
const SSF_OP_SHOW = 0x01
const SSF_OP_HIDE = 0x02
const SSF_OP_MOVE = 0x03
const SSF_OP_UPLOAD_LOW_FONT = 0x80
const SSF_OP_UPLOAD_HIGH_FONT = 0x81

// ── TAV quality LUT (index → quantiser) ─────────────────────────────────────
const QLUT = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096]

// ── Display-plane addresses (4bpp / mode 4) ─────────────────────────────────
const DISP_RG = -1048577
const DISP_BA = -1310721
const DISP_PLANE3 = -1310721 - 262144   // mode-8 third plane base (for getRGBfromScr)

// ── seqread selection ───────────────────────────────────────────────────────
// Mirrors the tape-vs-disk branch every old player carried.  Returns a prepared
// seqread module instance (a stateful singleton — only one decoder at a time).
function openSeqread(fullPathStr) {
    let sr
    if (fullPathStr.startsWith('$:/TAPE') || fullPathStr.startsWith('$:\\TAPE')) {
        sr = require("seqreadtape")
        sr.prepare(fullPathStr)
        sr.seek(0)
    } else {
        sr = require("seqread")
        sr.prepare(fullPathStr)
    }
    return sr
}

// Read the 8-byte magic into a JS array (frees the scratch buffer).
function readMagic(sr) {
    let p = sr.readBytes(8)
    let out = []
    for (let i = 0; i < 8; i++) out.push(sys.peek(p + i) & 255)
    sys.free(p)
    return out
}

function magicEquals(got, want) {
    for (let i = 0; i < 8; i++) if (got[i] !== want[i]) return false
    return true
}

// Detect container format from the 8-byte magic. Returns 'mov'|'tev'|'tav'|'tap'|'ucf'|null.
function detectFormat(magic) {
    if (magicEquals(magic, MAGIC_MOV)) return 'mov'
    if (magicEquals(magic, MAGIC_TEV)) return 'tev'
    if (magicEquals(magic, MAGIC_TAV)) return 'tav'
    if (magicEquals(magic, MAGIC_TAP)) return 'tap'
    if (magicEquals(magic, MAGIC_UCF)) return 'ucf'
    return null
}

// ── Luma ─────────────────────────────────────────────────────────────────────
// BT.601 integer luma from 8-bit RGB.
function luma8(r, g, b) { return (r * 77 + g * 150 + b * 29) >> 8 }

// ── Audio router ─────────────────────────────────────────────────────────────
// One playhead, deferred play(). Handles the per-packet audio codecs shared by
// the backends. TAV's bundled-MP2 (0x40) pre-decode/streaming stays in the TAV
// backend because it interleaves with the GOP display loop.
function makeAudioRouter(sr) {
    const playhead = audio.getFreePlayhead(0)
    const SND_BASE = audio.getBaseAddr()
    const SND_MEM  = audio.getMemAddr()
    audio.resetParams(playhead)
    audio.purgeQueue(playhead)
    audio.setPcmMode(playhead)
    let volume = 255
    audio.setMasterVolume(playhead, volume)

    let mp2Init = false
    let fired = false

    return {
        playhead: playhead,
        sndBase: SND_BASE,
        sndMem: SND_MEM,

        // Fire playback once, on the first displayed frame.
        fire() { if (!fired) { audio.play(playhead); fired = true } },
        isFired() { return fired },

        stop() { audio.stop(playhead) },
        resume() { audio.play(playhead) },
        purge() { audio.purgeQueue(playhead); fired = false },

        setVolume(v) { volume = (v < 0) ? 0 : (v > 255) ? 255 : v; audio.setMasterVolume(playhead, volume) },
        getVolume() { return volume },

        // MP2 packet: payload already length-known by caller; reads `len` bytes.
        mp2(len) {
            if (!mp2Init) { mp2Init = true; audio.mp2Init() }
            sr.readBytes(len, SND_BASE - 2368)
            audio.mp2Decode()
            audio.mp2UploadDecoded(playhead)
        },
        // MP2 frame whose size is implicit in the iPF packet type.
        ensureMp2() { if (!mp2Init) { mp2Init = true; audio.mp2Init() } },

        // TAD packet.
        tad(sampleLen, payloadLen) {
            sr.readBytes(payloadLen, SND_MEM - 917504)
            audio.tadDecode()
            audio.tadUploadDecoded(playhead, sampleLen)
        },
        // Native (zstd PCMu8) packet.
        nativePcm(zstdLen) {
            let zstdPtr = sys.malloc(zstdLen)
            sr.readBytes(zstdLen, zstdPtr)
            let pcmPtr = sys.malloc(65536)
            let pcmLen = gzip.decompFromTo(zstdPtr, zstdLen, pcmPtr)
            if (pcmLen > 65536) { sys.free(zstdPtr); sys.free(pcmPtr); throw Error(`PCM data too long -- got ${pcmLen} bytes`) }
            audio.putPcmDataByPtr(playhead, pcmPtr, pcmLen, 0)
            audio.setSampleUploadLength(playhead, pcmLen)
            audio.startSampleUpload(playhead)
            sys.free(zstdPtr)
            sys.free(pcmPtr)
        },
        // Raw PCM (iPF 0x1000/0x1001): payload bytes streamed directly.
        rawPcm(len) {
            let frame = sr.readBytes(len)
            audio.putPcmDataByPtr(playhead, frame, len, 0)
            audio.setSampleUploadLength(playhead, len)
            audio.startSampleUpload(playhead)
            sys.free(frame)
        },

        close() { audio.stop(playhead); audio.purgeQueue(playhead) }
    }
}

// ── Subtitle engine ──────────────────────────────────────────────────────────
// Parses SSF (frame-locked 0x30) and SSF-TC (timecode 0x31) packets and exposes
// the *active* subtitle as state; the player renders it (the "postprocessor"
// stage).  Font-ROM uploads are hardware writes, so the engine performs them.
//   fontUploadBase: -1300607 (TEV) or -133121 (TAV) — kept per-format for parity.
function makeSubtitleEngine(sr, fontUploadBase) {
    const subtitle = { visible: false, text: "", position: 0, useUnicode: false, dirty: false }
    let events = []
    let nextIndex = 0
    let fontUploaded = false

    function uploadFont(opcode, remainingBytes) {
        if (remainingBytes >= 3) {
            let payloadLen = sr.readShort()
            if (remainingBytes >= payloadLen + 2) {
                let fontData = sr.readBytes(payloadLen)
                for (let i = 0; i < Math.min(payloadLen, 1920); i++) sys.poke(fontUploadBase - i, sys.peek(fontData + i))
                sys.poke(-1299460, (opcode == SSF_OP_UPLOAD_LOW_FONT) ? 18 : 19)
                sys.free(fontData)
            }
            fontUploaded = true
            subtitle.useUnicode = true
        }
    }

    return {
        subtitle: subtitle,
        get fontUploaded() { return fontUploaded },

        // Frame-locked subtitle packet (0x30): applies immediately.
        parseLegacy(packetSize) {
            sr.readOneByte(); sr.readOneByte(); sr.readOneByte() // 24-bit index
            let opcode = sr.readOneByte()
            let remainingBytes = packetSize - 4
            switch (opcode) {
                case SSF_OP_SHOW: {
                    if (remainingBytes > 1) {
                        let tb = sr.readBytes(remainingBytes)
                        let s = ""
                        for (let i = 0; i < remainingBytes - 1; i++) { let b = sys.peek(tb + i); if (b === 0) break; s += String.fromCharCode(b) }
                        sys.free(tb)
                        subtitle.text = s; subtitle.visible = true; subtitle.useUnicode = fontUploaded; subtitle.dirty = true
                    }
                    break
                }
                case SSF_OP_HIDE: { subtitle.visible = false; subtitle.text = ""; subtitle.dirty = true; break }
                case SSF_OP_MOVE: {
                    if (remainingBytes >= 2) {
                        let pos = sr.readOneByte(); sr.readOneByte()
                        if (pos >= 0 && pos <= 8) { subtitle.position = pos; subtitle.dirty = true }
                    }
                    break
                }
                case SSF_OP_UPLOAD_LOW_FONT:
                case SSF_OP_UPLOAD_HIGH_FONT: { uploadFont(opcode, remainingBytes); break }
                default: { if (remainingBytes > 0) { let s = sr.readBytes(remainingBytes); sys.free(s) } break }
            }
        },

        // Timecode subtitle packet (0x31): buffered, applied by poll().
        parseTC(packetSize) {
            let i0 = sr.readOneByte(), i1 = sr.readOneByte(), i2 = sr.readOneByte()
            let index = i0 | (i1 << 8) | (i2 << 16)
            let tc = 0
            for (let i = 0; i < 8; i++) { tc += sr.readOneByte() * Math.pow(2, i * 8) }
            let opcode = sr.readOneByte()
            let remainingBytes = packetSize - 12
            let text = null
            if (remainingBytes > 1 && (opcode === SSF_OP_SHOW || (opcode >= 0x10 && opcode <= 0x2F))) {
                let tb = sr.readBytes(remainingBytes)
                text = ""
                for (let i = 0; i < remainingBytes - 1; i++) { let b = sys.peek(tb + i); if (b === 0) break; text += String.fromCharCode(b) }
                sys.free(tb)
            } else if (remainingBytes > 0) {
                let s = sr.readBytes(remainingBytes); sys.free(s)
            }
            events.push({ timecode_ns: tc, index: index, opcode: opcode, text: text })
        },

        // Advance through timecode events whose time has been reached.
        poll(currentTimeNs) {
            while (nextIndex < events.length) {
                let ev = events[nextIndex]
                if (ev.timecode_ns > currentTimeNs) break
                switch (ev.opcode) {
                    case SSF_OP_SHOW: subtitle.text = ev.text || ""; subtitle.visible = true; subtitle.useUnicode = fontUploaded; subtitle.dirty = true; break
                    case SSF_OP_HIDE: subtitle.visible = false; subtitle.text = ""; subtitle.dirty = true; break
                    case SSF_OP_MOVE:
                        if (ev.text && ev.text.length > 0) {
                            let pos = ev.text.charCodeAt(0)
                            if (pos >= 0 && pos <= 8) { subtitle.position = pos; subtitle.dirty = true }
                        }
                        break
                }
                nextIndex++
            }
        },

        // After a seek: jump the event cursor to the first event at/after `tc`.
        resetTo(tc) {
            nextIndex = 0
            for (let i = 0; i < events.length; i++) { if (events[i].timecode_ns >= tc) { nextIndex = i; break } }
            subtitle.visible = false; subtitle.text = ""; subtitle.dirty = true
        },

        hasEvents() { return events.length > 0 }
    }
}

// ── Bias lighting ────────────────────────────────────────────────────────────
// Samples the screen borders and drifts the background colour toward them —
// the "ambilight" the old players ran after each frame upload.  Mode-aware
// (4/5/8 bpp) read-back, matching playtav's getRGBfromScr.
function makeBias(width, height, graphicsMode) {
    const BIAS_MIN = 1.0 / 16.0
    let old = [BIAS_MIN, BIAS_MIN, BIAS_MIN]
    const nativeWidth = graphics.getPixelDimension()[0]
    const nativeHeight = graphics.getPixelDimension()[1]
    const STRIDE = 560

    function rgbFromScr(x, y) {
        let off = y * STRIDE + x
        let fb1 = sys.peek(DISP_RG - off)
        let fb2 = sys.peek(DISP_BA - off)
        if (graphicsMode == 5) {
            let fb3 = sys.peek(DISP_PLANE3 - off)
            return [((fb1 >>> 2) & 31) / 31.0, (((fb1 & 3) << 3) | ((fb2 >>> 5) & 7)) / 31.0, (fb2 & 31) / 31.0]
        } else if (graphicsMode == 4) {
            return [(fb1 >>> 4) / 15.0, (fb1 & 15) / 15.0, (fb2 >>> 4) / 15.0]
        } else {
            let fb3 = sys.peek(DISP_PLANE3 - off)
            return [fb1 / 255.0, fb2 / 255.0, fb3 / 255.0]
        }
    }

    return function setBiasLighting() {
        let samples = []
        let offsetX = Math.floor((nativeWidth - width) / 2)
        let offsetY = Math.floor((nativeHeight - height) / 2)
        let stepX = Math.max(8, Math.floor(width / 18))
        let stepY = Math.max(8, Math.floor(height / 17))
        let margin = Math.min(8, Math.floor(width / 70))

        for (let x = margin; x < width - margin; x += stepX) {
            samples.push(rgbFromScr(x + offsetX, margin + offsetY))
            samples.push(rgbFromScr(x + offsetX, height - margin - 1 + offsetY))
        }
        for (let y = margin; y < height - margin; y += stepY) {
            samples.push(rgbFromScr(margin + offsetX, y + offsetY))
            samples.push(rgbFromScr(width - margin - 1 + offsetX, y + offsetY))
        }

        let out = [0.0, 0.0, 0.0]
        samples.forEach(rgb => { out[0] += rgb[0]; out[1] += rgb[1]; out[2] += rgb[2] })
        out[0] = BIAS_MIN + (out[0] / samples.length / 2.0)
        out[1] = BIAS_MIN + (out[1] / samples.length / 2.0)
        out[2] = BIAS_MIN + (out[2] / samples.length / 2.0)

        let bgr = (old[0] * 5 + out[0]) / 6.0
        let bgg = (old[1] * 5 + out[1]) / 6.0
        let bgb = (old[2] * 5 + out[2]) / 6.0
        old = [bgr, bgg, bgb]
        graphics.setBackground(Math.round(bgr * 255), Math.round(bgg * 255), Math.round(bgb * 255))
    }
}

// ── sampleGray source ────────────────────────────────────────────────────────
// Fill an ASCII brightness buffer (dst, dstW×dstH) by nearest-sampling the GPU
// framebuffer (the shared "player framebuffer" the backend has just blit()ted
// to).  Reading the screen — rather than each backend's private frame store —
// keeps one sampler for every format/kind (TAV's GOP videoBuffer is Java-heap
// and has no JS-addressable VM address, so reading it directly is impossible).
//
// Only ~dstW·dstH peeks per call, so it is cheap regardless of frame size.
// Pixel `off` is backward-addressed (DISP_RG-off / DISP_BA-off), matching how
// every decoder writes the framebuffer.  `mode` selects 4/5/8-bpp unpacking
// (mirrors playtav's getRGBfromScr).
function sampleGrayScreen(width, height, dst, dstW, dstH, mode) {
    for (let y = 0; y < dstH; y++) {
        let sy = (y * height / dstH) | 0
        let dstRow = y * dstW
        for (let x = 0; x < dstW; x++) {
            let sx = (x * width / dstW) | 0
            let off = sy * 560 + sx
            let fb1 = sys.peek(DISP_RG - off) & 255
            let fb2 = sys.peek(DISP_BA - off) & 255
            let r, g, b
            if (mode == 5) {
                r = ((fb1 >>> 2) & 31) * 255 / 31
                g = (((fb1 & 3) << 3) | ((fb2 >>> 5) & 7)) * 255 / 31
                b = (fb2 & 31) * 255 / 31
            } else if (mode == 8) {
                r = fb1; g = fb2; b = sys.peek(DISP_PLANE3 - off) & 255
            } else {   // mode 4
                r = (fb1 >>> 4) * 17
                g = (fb1 & 15) * 17
                b = (fb2 >>> 4) * 17
            }
            dst[dstRow + x] = luma8(r | 0, g | 0, b | 0)
        }
    }
}

exports = {
    MAGIC_MOV, MAGIC_TEV, MAGIC_TAV, MAGIC_TAP, MAGIC_UCF,
    MP2_FRAME_SIZE, QLUT,
    SSF_OP_NOP, SSF_OP_SHOW, SSF_OP_HIDE, SSF_OP_MOVE,
    SSF_OP_UPLOAD_LOW_FONT, SSF_OP_UPLOAD_HIGH_FONT,
    DISP_RG, DISP_BA,
    openSeqread, readMagic, detectFormat, magicEquals,
    luma8,
    makeAudioRouter, makeSubtitleEngine, makeBias,
    sampleGrayScreen
}
