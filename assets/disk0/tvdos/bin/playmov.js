// playmov — all-in-one movie player (MOV/iPF, TEV, TAV, TAP).
//
// Consolidates playmv1 / playtev / playtav behind one decode library
// (mediadec.mjs) and one simple pipeline:
//
//   loop:
//     read input (quit / pause / seek / volume / cue / ASCII-toggle)
//     [backend] dec.step()  -> decode the next due frame into a RAM RGB888 frame
//     [player]  hold the frame
//     [postprocessor] subtitle state resolved by the library
//     [draw]    graphics: dec.blit() (upload RAM frame to adapter) + dec.bias()
//               ASCII:    dec.sampleGray + aa.mjs straight off the RAM frame (no upload)
//               then subtitle overlay + playgui chrome
//
// Usage: playmov FILE [-i] [-ascii] [-colour] [-deblock] [-boundaryaware]
//                     [-deinterlace=yadif|bwdif] [-debug-mv]
//   -i        interactive (controls + on-screen chrome)
//   -ascii    start in ASCII-render mode (proves the framebuffer flow; aa.mjs)
//   -colour   colourise ASCII glyphs from the video (implies -ascii); -color alias
//   (others forwarded to the TEV backend, matching playtev)
// Controls: Bksp quit | Space pause | Left/Right seek | Up/Down volume
//           PgUp/PgDn cue prev/next | A toggle ASCII | C toggle colour

const mediadec = require("mediadec")
const gui      = require("playgui")
const K        = require("keysym")

// aa.mjs (the ASCII renderer) is OPTIONAL. If it isn't installed, playmov still
// plays everything normally; ASCII mode just isn't available (-ascii is ignored
// and the A key is inert). require() throws when the module is missing, so guard it.
let aa = null
try { aa = require("aa") } catch (e) { aa = null }   // hopper/include/aa.mjs

const AA_FONT_PATH = "A:/tvdos/tsvm.chr"
const VOL_STEP = 16

// Text-plane palette indices: 0 = GUI background (translucent black), 240 = pure
// opaque black, 255 = transparent (GraphicsAdapter: "palette 255 is always
// transparent").  aa.mjs paints cell backgrounds with 255, so over live graphics
// the picture bleeds through the ASCII; we force opaque 240 instead.
const COL_TRANSPARENT = 255
const COL_PURE_BLACK = 240
const GUI_BG = 0

// Text fore/back-plane addressing (mirrors aa.mjs _TA_FORE / _TA_BACK / _TA_BASE),
// VT-aware.
const TXT_FORE_OFF = 2
const TXT_BACK_OFF = 2562
const TXT_AREA_BASE = 253950
const AA_W = 80, AA_H = 32
const asciiBackFill = new Uint8Array(AA_W * AA_H).fill(COL_PURE_BLACK)

// Resolve the address of text-area byte `off` for the current environment
// (VT pane: forward from VT_TEXT_PLANE; physical: backward from the GPU base),
// exactly as aa.mjs's _va() does, so writes land in the same plane aa.flush uses.
function txtAddr(off) {
    if (typeof globalThis.VT_TEXT_PLANE !== 'undefined')
        return globalThis.VT_TEXT_PLANE + off
    return graphics.getGpuMemBase() - TXT_AREA_BASE - off
}

// Overwrite every text cell's background with opaque pure-black (240), so ASCII
// glyphs sit on solid black instead of aa.mjs's transparent (255) cells.
function paintAsciiBgOpaque() {
    sys.pokeBytes(txtAddr(TXT_BACK_OFF), asciiBackFill, asciiBackFill.length)
}

// ── Colour postprocessor (-colour) ───────────────────────────────────────────
// AAlib chooses each glyph from brightness; colour mode additionally tints the
// glyph's FOREGROUND (never the background) with the nearest opaque colour of
// the TSVM 256-palette, sampled from the video's RGB plane.
//
// That palette is a *separable* 6×8×5 RGB cube (indices 0–239, white corner at
// 239) plus a 15-step grey ramp (indices 240–254 = 0,17,…,238; index 255 is
// always transparent and cube index 0 is translucent, so both are excluded as
// ink).  Because the cube is separable, its nearest entry is just the independent
// nearest level per channel; the global nearest opaque colour is then whichever
// of {best cube, best grey} is closer — all via small precomputed LUTs, O(1)/cell.
const CUBE_R = [0, 51, 102, 153, 204, 255]
const CUBE_G = [0, 34, 68, 102, 153, 187, 221, 255]
const CUBE_B = [0, 68, 136, 187, 255]

let _rNear = null, _gNear = null, _bNear = null   // 0–255 value → cube level index
let _greyIdx = null, _greyVal = null              // 0–255 mean → grey palette idx / value
const colourBuf = new Uint8Array(AA_W * AA_H * 3)  // sampled R,G,B per cell
const foreBuf   = new Uint8Array(AA_W * AA_H)       // resolved palette ink per cell

function _nearestLevel(levels) {
    const lut = new Uint8Array(256)
    for (let v = 0; v < 256; v++) {
        let best = 0, bestD = 1e9
        for (let k = 0; k < levels.length; k++) {
            const d = Math.abs(v - levels[k])
            if (d < bestD) { bestD = d; best = k }
        }
        lut[v] = best
    }
    return lut
}

function ensureColourLuts() {
    if (_rNear) return
    _rNear = _nearestLevel(CUBE_R)
    _gNear = _nearestLevel(CUBE_G)
    _bNear = _nearestLevel(CUBE_B)
    // Grey-ramp candidates: palette idx 240+k holds grey value 17·k, k = 0..14
    // (idx 240 = black … 254 = 238; idx 255 is transparent, so it is excluded).
    const gv = [], gi = []
    for (let k = 0; k < 15; k++) { gv.push(17 * k); gi.push(240 + k) }
    _greyIdx = new Uint8Array(256)
    _greyVal = new Uint8Array(256)
    for (let m = 0; m < 256; m++) {
        let best = 0, bestD = 1e9
        for (let k = 0; k < gv.length; k++) {
            const d = Math.abs(m - gv[k])
            if (d < bestD) { bestD = d; best = k }
        }
        _greyIdx[m] = gi[best]; _greyVal[m] = gv[best]
    }
}

function nearestPaletteIndex(r, g, b) {
    const ri = _rNear[r], gi = _gNear[g], bi = _bNear[b]
    const cr = CUBE_R[ri], cg = CUBE_G[gi], cb = CUBE_B[bi]
    const dCube = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb)
    // Nearest grey level sits at the rounded mean of the channels (the vertex of
    // the achromatic-distance parabola); rounding — not flooring — makes the
    // {cube vs grey} pick the exact global nearest opaque palette entry.
    const m = ((r + g + b) / 3 + 0.5) | 0
    const gvv = _greyVal[m]
    const dGrey = (r - gvv) * (r - gvv) + (g - gvv) * (g - gvv) + (b - gvv) * (b - gvv)
    // Prefer grey on ties (so near-black resolves to opaque grey idx 240, not the
    // translucent cube corner); `|| 240` is a belt-and-braces guard for idx 0.
    const cubeIdx = ri * 40 + gi * 5 + bi
    return (dGrey <= dCube) ? _greyIdx[m] : (cubeIdx || 240)
}

// Sample the frame's colour per cell, map to nearest palette ink, and write the
// foreground plane (over what aa.flush wrote). Background is left to
// paintAsciiBgOpaque(); only the FG is colourised, per spec.
function applyColourFore(dec) {
    dec.sampleColour(colourBuf, AA_W, AA_H)
    for (let i = 0, n = AA_W * AA_H; i < n; i++)
        foreBuf[i] = nearestPaletteIndex(colourBuf[i * 3], colourBuf[i * 3 + 1], colourBuf[i * 3 + 2])
    sys.pokeBytes(txtAddr(TXT_FORE_OFF), foreBuf, foreBuf.length)
}

// ── Parse args ───────────────────────────────────────────────────────────────
let interactive = false
let asciiMode = false
let colourMode = false
const decOpts = { interactive: false, deinterlaceAlgorithm: "yadif" }

for (let i = 2; i < exec_args.length; i++) {
    const arg = ("" + exec_args[i]).toLowerCase()
    if (arg === "-i") { interactive = true; decOpts.interactive = true }
    else if (arg === "-ascii") asciiMode = true
    else if (arg === "-colour" || arg === "-color") { asciiMode = true; colourMode = true }
    else if (arg === "-debug-mv") decOpts.debugMotionVectors = true
    else if (arg === "-deblock") decOpts.enableDeblocking = true
    else if (arg === "-boundaryaware") decOpts.enableBoundaryAwareDecoding = true
    else if (arg.startsWith("-deinterlace=")) decOpts.deinterlaceAlgorithm = arg.substring(13)
    else if (arg.startsWith("--filter-film-grain")) {
        const parts = arg.split(/[=\s]/)
        if (parts.length > 1) { const lv = parseInt(parts[1]); if (!isNaN(lv)) decOpts.filmGrainLevel = lv }
    }
}

// Graceful degradation: ASCII (and therefore colour) mode needs aa.mjs.
if (asciiMode && !aa) {
    serial.println("playmov: aa.mjs not found; ASCII mode unavailable, -ascii/-colour ignored")
    asciiMode = false
    colourMode = false
}

if (!exec_args[1]) { printerrln("usage: playmov FILE [-i] [-ascii] [-colour] [options]"); return 1 }
const fullPath = _G.shell.resolvePathInput(exec_args[1]).full

// ── ASCII-render state (aa.mjs) — lazily initialised on first use ────────────
let aaCtx = null
let aaParams = null
function ensureAscii() {
    if (aaCtx) return
    const font = aa.loadChrFontROM(AA_FONT_PATH)
    aaCtx = aa.init(AA_W, AA_H, { font: font })
    aaParams = aa.getrenderparams()
    aaParams.dither = aa.AA_FLOYD_S
    ensureColourLuts()   // cheap; keeps the C-key colour toggle ready
}

// ── Open ─────────────────────────────────────────────────────────────────────
let [cy, cx] = con.getyx()
let errorlevel = 0
let dec = null
let stage = "open"          // breadcrumb for the error log

try {
    dec = mediadec.open(fullPath, decOpts)
    const info = dec.info

    // NB: palette 0 is translucent black by default — exactly what the playgui
    // chrome (bg colour 0) wants — so we never redefine it. (Backends must not
    // either, or the chrome turns opaque for the next file played.)

    if (info.isStill) { con.move(1, 1); println("Push and hold Backspace to exit") }

    let startNs = 0
    let lastKey = 0
    let quit = false

    // Build the playgui status object for the on-screen chrome.
    function status() {
        const usingCues = dec.cues && dec.cues.length > 0
        const akku = startNs ? (sys.nanoTime() - startNs) / 1000000000.0 : 0.0001
        return {
            fps: info.fps,
            videoRate: dec.videoRate | 0,
            frameCount: dec.frameCount,
            totalFrames: info.totalFrames,
            frameMode: dec.frameMode,
            qY: dec.qY || 0, qCo: dec.qCo || 0, qCg: dec.qCg || 0,
            akku: akku,
            fileName: usingCues ? dec.cues[dec.currentCueIndex].name : fullPath,
            fileOrd: usingCues ? (dec.currentCueIndex + 1) : (dec.currentFileIndex || 1),
            resolution: `${info.width}x${info.height}${info.isInterlaced ? 'i' : ''}`,
            colourSpace: info.colourSpace,
            currentStatus: dec.isPaused() ? 2 : 1
        }
    }

    // Entering ASCII: clear the text plane; the pixel framebuffer is left as-is and
    // simply covered each frame by solid-black (240) text cells (see draw()).
    // Bias lighting is pinned to pure black ONCE here and not updated again while
    // in ASCII (draw() skips the bias stage), so the backdrop stays steady.
    function enterAsciiVisual() {
        ensureAscii()
        graphics.setBackground(0, 0, 0)
        graphics.clearPixelsAll(0, 0, 0, 0)
        con.clear()
    }

    // Leaving ASCII: fill the viewing area with transparency (255), NOT the GUI's
    // translucent-black (colour 0), so the resumed video shows through cleanly.
    function exitAsciiVisual() {
        con.color_pair(COL_TRANSPARENT, COL_TRANSPARENT)
        con.clear()
    }

    function toggleAscii() {
        asciiMode = !asciiMode
        if (asciiMode) enterAsciiVisual()
        else exitAsciiVisual()
    }

    // Colour only affects the foreground plane and is re-applied every drawn
    // frame, so toggling it just flips the flag; the next flush+draw reverts the
    // ink to aa.mjs's grey when off. Ensure the LUTs exist if A was never pressed.
    function toggleColour() {
        if (!aaCtx) ensureColourLuts()
        colourMode = !colourMode
    }

    // ── Input ─────────────────────────────────────────────────────────────────
    // Bksp is hold-to-quit (like the old players); everything else is edge-
    // triggered so a held key fires once.  Quit + ASCII/colour toggles work even
    // without -i; the rest of the transport is interactive-only.
    function readInput() {
        sys.poke(-40, 1)
        const key = sys.peek(-41)
        if (key == K.BACKSPACE) { quit = true; return }
        if (key && key !== lastKey) {
            if (key == K.A) { if (aa) toggleAscii() }        // inert when aa.mjs is absent
            else if (key == K.C) { if (aa) toggleColour() }  // colour shows only while in ASCII
            else if (interactive) {
                switch (key) {
                    case K.SPACE: dec.pause(!dec.isPaused()); break
                    case K.LEFT:  dec.seekSeconds(-5.5); break
                    case K.RIGHT: dec.seekSeconds(5.0); break
                    case K.UP:    dec.setVolume(dec.getVolume() + VOL_STEP); break
                    case K.DOWN:  dec.setVolume(dec.getVolume() - VOL_STEP); break
                    case K.PAGE_UP:   dec.cue(-1); break
                    case K.PAGE_DOWN: dec.cue(1); break
                }
            }
        }
        lastKey = key
    }

    // ── Draw a decoded frame: RAM frame -> screen / ASCII -> overlays -> chrome ─
    function draw() {
        if (asciiMode) {
            // The decoded frame already sits in RAM (TEV/TAV) or on the display
            // planes (iPF), so sample it WITHOUT uploading to the video adapter,
            // then cover the picture with solid-black (240) text cells (cheaper
            // than clearing the pixel planes).
            dec.sampleGray(aaCtx.imagebuffer, aaCtx.imgW, aaCtx.imgH)
            aa.render(aaCtx, aaParams)
            aa.flush(aaCtx)
            if (colourMode) applyColourFore(dec)     // recolour the FG plane from the video's RGB
            paintAsciiBgOpaque()                     // cover with opaque 240 (not transparent 255)
        } else {
            dec.blit()                               // upload the RAM frame to the video adapter
            dec.bias()                               // bias lighting (player-owned stage; graphics only)
        }

        // Postprocessor output: subtitle overlay (text plane, on top of the frame).
        if (asciiMode) {
            // aa.flush rewrote the whole text plane, so redraw the subtitle each frame.
            if (dec.subtitle.visible) gui.displaySubtitle(dec.subtitle.text, dec.subtitle.useUnicode, dec.subtitle.position)
            dec.subtitle.dirty = false
        } else if (dec.subtitle.dirty) {
            gui.clearSubtitleArea()
            if (dec.subtitle.visible) gui.displaySubtitle(dec.subtitle.text, dec.subtitle.useUnicode, dec.subtitle.position)
            dec.subtitle.dirty = false
        }

        if (interactive) { gui.printBottomBar(status()); gui.printTopBar(status(), 1) }
    }

    // Start in ASCII if requested (-ascii). Done here, after the helpers above are
    // defined, since they are block-scoped function declarations.
    if (asciiMode) enterAsciiVisual()

    // ── Main loop ───────────────────────────────────────────────────────────
    while (!quit) {
        stage = "input"; readInput()
        if (quit) break

        stage = "step"
        const ev = dec.step()
        if (ev.type === 'eof') break
        if (ev.type === 'error') { errorlevel = 1; break }
        if (ev.type === 'frame') {
            if (!startNs) startNs = sys.nanoTime()
            stage = "draw"; draw()
        } else {
            // 'idle' or 'newfile' — nothing to draw this turn.
            sys.sleep(1)
        }
    }
}
catch (e) {
    // Log to serial too (persists in the console log next to errorlevel) and
    // keep it on screen — con.clear() in finally only runs on success.
    serial.printerr("playmov failed at stage [" + stage + "]: " + e)
    if (e && e.message) serial.println("  message: " + e.message)
    if (e && e.stack) serial.println("  stack: " + e.stack)
    if (e && e.printStackTrace) e.printStackTrace()
    printerrln(e)
    errorlevel = 1
}
finally {
    if (dec) dec.close()
    if (aa && aaCtx) aa.close(aaCtx)
    if (errorlevel === 0) con.clear()
    con.curs_set(1)
    con.move(cy, cx)
}

return errorlevel
