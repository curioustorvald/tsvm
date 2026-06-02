// Common GUI for media player
// Created by CuriousTorvald on 2025-09-30.

// Subtitle display functions
function clearSubtitleArea() {
    // Clear the subtitle area at the bottom of the screen
    // Text mode is 80x32, so clear the bottom few lines
    let oldFgColour = con.get_color_fore()
    let oldBgColour = con.get_color_back()

    con.color_pair(255, 255)  // transparent to clear

    // Clear bottom 4 lines for subtitles
    for (let row = 28; row <= 31; row++) {
        con.move(row, 1)
        for (let col = 1; col <= 80; col++) {
            print(" ")
        }
    }

    con.color_pair(oldFgColour, oldBgColour)
}

function getVisualLength(line) {
    // Remove HTML tags and count the remaining text using unicode.strlen()
    const withoutTags = line.replace(/<\/?[bi]>/gi, '')
    return unicode.visualStrlen(withoutTags)
}

function displayFormattedLine(line, useUnicode) {
    // Parse line and handle <b> and <i> tags with colour changes
    // Default subtitle colour: yellow (231), formatted text: white (254)

    let i = 0
    let inBoldOrItalic = false
    let buffer = ""  // Accumulate characters for batch printing

    // Helper function to flush the buffer
    function flushBuffer() {
        if (buffer.length > 0) {
            useUnicode ? unicode.print(buffer) : print(buffer)
            buffer = ""
        }
    }

    // insert initial padding block
    con.color_pair(0, 255)
    con.prnch(0xDE)
    con.color_pair(231, 0)

    while (i < line.length) {
        if (i < line.length - 2 && line[i] === '<') {
            // Check for opening tags
            if (line.substring(i, i + 3).toLowerCase() === '<b>' ||
                line.substring(i, i + 3).toLowerCase() === '<i>') {
                flushBuffer()  // Flush before color change
                con.color_pair(254, 0)  // Switch to white for formatted text
                inBoldOrItalic = true
                i += 3
            } else if (i < line.length - 3 &&
                      (line.substring(i, i + 4).toLowerCase() === '</b>' ||
                       line.substring(i, i + 4).toLowerCase() === '</i>')) {
                flushBuffer()  // Flush before color change
                con.color_pair(231, 0)  // Switch back to yellow for normal text
                inBoldOrItalic = false
                i += 4
            } else {
                // Not a formatting tag, add to buffer
                buffer += line[i]
                i++
            }
        } else {
            // Regular character, add to buffer
            buffer += line[i]
            i++
        }
    }

    // Flush any remaining buffered text
    flushBuffer()

    // insert final padding block
    con.color_pair(0, 255)
    con.prnch(0xDD)
    con.color_pair(231, 0)
}

function displaySubtitle(text, useUnicode = false, position = 0) {
    if (!text || text.length === 0) {
        clearSubtitleArea()
        return
    }

    // Set subtitle colours: yellow (231) on black (0)
    let oldFgColour = con.get_color_fore()
    let oldBgColour = con.get_color_back()
    con.color_pair(231, 0)

    // Split text into lines
    let lines = text.split('\n')

    // Calculate position based on subtitle position setting
    let startRow, startCol
    // Calculate visual length without formatting tags for positioning
    let longestLineLength = lines.map(s => getVisualLength(s)).sort().last()

    switch (position) {
        case 2: // center left
        case 6: // center right
        case 8: // dead center
            startRow = 16 - Math.floor(lines.length / 2)
            break
        case 3: // top left
        case 4: // top center
        case 5: // top right
            startRow = 2
            break
        case 0: // bottom center
        case 1: // bottom left
        case 7: // bottom right
        default:
            startRow = 31 - lines.length
            startRow = 31 - lines.length
            startRow = 31 - lines.length  // Default to bottom center
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
            case 1: // bottom left
            case 2: // center left
            case 3: // top left
                startCol = 1
                break
            case 5: // top right
            case 6: // center right
            case 7: // bottom right
                startCol = Math.max(1, 78 - getVisualLength(line) - 2)
                break
            case 0: // bottom center
            case 4: // top center
            case 8: // dead center
            default:
                startCol = Math.max(1, Math.floor((80 - longestLineLength - 2) / 2) + 1)
                break
        }

        con.move(row, startCol)

        // Parse and display line with formatting tag support
        displayFormattedLine(line, useUnicode)
    }

    con.color_pair(oldFgColour, oldBgColour)
}

function emit(c) {
    return "\x84"+c+"u"
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)

    return [hours, minutes, secs]
        .map(val => val.toString().padStart(2, '0'))
        .join(':')
}

function drawProgressBar(progress, width) {
    // Clamp progress between 0 and 1
    progress = Math.max(0, Math.min(1, progress));

    // Calculate position in "half-character" resolution
    const position = progress * width * 2;
    const charIndex = Math.floor(position / 2);
    const isRightHalf = (position % 2) >= 1;

    let bar = '';

    for (let i = 0; i < width; i++) {
        if (i == charIndex) {
            bar += isRightHalf ? '\xDE' : '\xDD';
        } else {
            bar += '\xC4';
        }
    }

    return bar;
}

/*
status = {
    videoRate: int,
    frameCount: int,
    totalFrames: int,
    fps: int,
    frameMode: String,
    qY: int,
    qCo: int,
    qCg: int,
    akku: float,
    fileName: String,
    fileOrd: int,
    currentStatus: int (0: stop/init, 1: play, 2: pause),
    resolution: string,
    colourSpace: string
}

*/
function printBottomBar(status) {
    con.color_pair(253, 0)
    con.move(32, 1)

    const fullTimeInSec = status.totalFrames / status.fps
    const progress = status.frameCount / (status.totalFrames - 1)
    const elapsed = progress * fullTimeInSec
    const remaining = (1 - progress) * fullTimeInSec

    const BAR = '\xB3'
    const statIcon = [emit(0xFE), emit(0x10), emit(0x13)]
    let sLeft = `${emit(0x1E)}${status.fileOrd}${emit(0x1F)}${BAR}${statIcon[status.currentStatus]} `
    let sRate = `${BAR}${(''+((status.videoRate/128)|0)).padStart(6, ' ')}`
    let timeElapsed = formatTime(elapsed)
    let timeRemaining = formatTime(remaining)
    let barWidth = 80 - (sLeft.length - 8 - ((status.currentStatus == 0) ? 1 : 0) + timeElapsed.length + timeRemaining.length + sRate.length) - 2
    let bar = drawProgressBar(progress, barWidth)

    let s = sLeft + timeElapsed + ' ' + bar + ' ' + timeRemaining + sRate
    print(s);con.addch(0x4B)

    con.move(1, 1)
}

function printTopBar(status, moreInfo) {
    con.color_pair(253, 0)
    con.move(1)

    const BAR = '\xB3'

    if (moreInfo) {
        let filename = status.fileName.split("\\").pop()

        let sF = `F ${(''+status.frameCount).padStart((''+status.totalFrames).length, ' ')}${status.frameMode}/${status.totalFrames}`
        let sQ = `Q${(''+status.qY).padStart(4,' ')},${(''+status.qCo).padStart(2,' ')},${(''+status.qCg).padStart(2,' ')}`
        let sFPS = `${(status.frameCount / status.akku).toFixed(2)}f`
        let sRes = `${status.resolution}`
        let sCol = `${status.colourSpace}`

        let sLeft = sF + BAR + sQ + BAR + sFPS + BAR + sRes + BAR + sCol + BAR
        let filenameSpace = 80 - sLeft.length
        if (filename.length > filenameSpace) {
            filename = filename.slice(0, filenameSpace - 1) + '~'
        }
        let remainingSpc = filenameSpace - status.fileName.length
        let sRight = (remainingSpc > 0) ? ' '.repeat(filenameSpace - status.fileName.length + 3) : ''

        print(sLeft + filename + sRight)
    } else {
        let s = status.fileName
        if (s.length > 80) {
            s = s.slice(0, 79) + '~'
        }
        let spcs = 80 - s.length
        let spcsLeft = (spcs / 2)|0
        let spcsRight = spcs - spcsLeft
        print(' '.repeat(spcsLeft))
        print(s)
        print(' '.repeat(spcsRight))
    }

    con.move(1, 1)
}

// ── Audio player visualiser ─────────────────────────────────────────────────
// Shared by playwav/playmp2/playpcm/playtad.  Design follows
// `assets/playwav_visualiser_design_2_for_tsvm.md`:
//   * 3-row ASCII wavescope (mid signal envelope) on rows 3..5
//   * 22-col progress dashes on the right side of the song-title row
//   * 24-row XY-scope + wavelet-modulated persistence visualiser on rows 7..30
//   * stereo energy bar on row 31
//
// The visualiser fuses two displays the design doc calls complementary:
//   * XY-scope geometry (rotated 45° so L plots along the `\` diagonal and R
//     along `/`) gives spatial motion and stereo image.
//   * Haar wavelet features (transient / noise / sustain energies) steer the
//     beam's behaviour — transients evaporate it and emit sparks, sustained
//     content lets trails breathe longer, mid noise jitters the beam.
//
// The wavelet is therefore a *modulator*, not a renderer.  No FFT, no pitch
// tracking, no per-frame allocation in the hot loop.

const AG_COLS = 80
const AG_ROWS = 32
const AG_COL_INSIDE_L = 2
const AG_COL_INSIDE_R = 79
const AG_LANE_W       = 78

const AG_ROW_TOP_BORDER = 1
const AG_ROW_TITLE      = 2
const AG_ROW_WAVE_TOP   = 3
const AG_ROW_WAVE_BOT   = 5     // 3-row wavescope
const AG_ROW_VIS_SEP    = 6
const AG_ROW_VIS_TOP    = 7
const AG_ROW_VIS_BOT    = 30    // 24-row wavelet visualiser
const AG_ROW_STEREO     = 31
const AG_ROW_BOT_BORDER = 32

const AG_VIS_H = AG_ROW_VIS_BOT - AG_ROW_VIS_TOP + 1   // 24
const AG_VIS_W = AG_LANE_W                              // 78

// Palette (TSVM 256-colour indices)
const AG_COL_BG       = 0
const AG_COL_BORDER   = 250
const AG_COL_LABEL    = 220
const AG_COL_DIM      = 235
const AG_COL_TITLE    = 230
const AG_COL_VALUE    = 254
const AG_COL_PROG_ON  = 226     // bright yellow (matches Taud)

// Box-drawing constants (CP437)
const AG_BX_TL = 0xC9, AG_BX_TR = 0xBB, AG_BX_BL = 0xC8, AG_BX_BR = 0xBC
const AG_BX_V  = 0xBA, AG_BX_H  = 0xCD
const AG_SEP_L = 0xC7, AG_SEP_R = 0xB6

// Density stairs for visualiser + stereo bar
const AG_STAIRS = [0x20, 0xB0, 0xB1, 0xB2, 0xDB]   // ' ', ░, ▒, ▓, █

// Electron-beam colour ramp.  Index 0 = silent (background), last = freshly
// drawn beam.  Amber-on-black mimics analog vector-scope CRT phosphor — the
// glyph shape carries the spatial information, the colour ramp carries age.
const AG_BEAM_PAL = [AG_COL_BG, 94, 130, 166, 220]

// Five wavelet levels (Haar decomp).  These are used only as modulators —
// they never get rendered as bars.  Indexing:
//   AG_WL_TRANSIENT — top-octave detail (8 kHz..16 kHz at 32 kHz Fs).
//                     Spikes on percussion attacks, vocal consonants, cymbals.
//   AG_WL_NOISE     — upper-mid detail (4..8 kHz).  Drives beam jitter.
//   AG_WL_BODY      — mid detail (2..4 kHz).
//   AG_WL_TONAL     — lower-mid detail (1..2 kHz).
//   AG_WL_BASS      — low detail (0.5..1 kHz).  Slows the decay (sustain).
const AG_N_BANDS    = 5
const AG_WL_TRANSIENT = 0
const AG_WL_NOISE     = 1
const AG_WL_BODY      = 2
const AG_WL_TONAL     = 3
const AG_WL_BASS      = 4

// Stereo bar colour ramp (5 levels) — uses the tonal blue gradient so the
// stereo strip reads as the "ground" beneath the wavelet cloud.
const AG_STEREO_COL = [AG_COL_DIM, 17, 33, 75, 117]

// ── State ───────────────────────────────────────────────────────────────────
//
// All state lives in module scope so a player just does:
//     const gui = require('playgui')
//     gui.audioInit({...})
//     while (...) { ...; gui.audioFeedPcm(ptr, n); gui.audioRender(); }
//     gui.audioClose()
//
// Multiple concurrent players in one process are not supported — but TVDOS
// only runs one foreground command at a time, so that's fine.

const AG_SNAPSHOT_N = 1024   // power of 2; covers ~32 ms at 32 kHz
const ag_snapL = new Float32Array(AG_SNAPSHOT_N)
const ag_snapR = new Float32Array(AG_SNAPSHOT_N)

const AG_WORK_N = AG_SNAPSHOT_N   // scratch buffers for Haar pyramid
const ag_workMid = new Float32Array(AG_WORK_N)
const ag_workTmp = new Float32Array(AG_WORK_N >> 1)
const ag_bandEnergy = new Float32Array(AG_N_BANDS)

// Sub-500 Hz residual — drops out of the wavelet modulator set on purpose,
// but we keep its RMS around to drive the bass mark.
let ag_bassEnergy = 0

// Persistence buffer — float intensity per cell, plus the glyph last written
// there.  Decay shrinks intensity each frame; new beam samples overwrite the
// glyph and bump intensity.
const ag_persist      = new Float32Array(AG_VIS_H * AG_VIS_W)
const ag_persistGlyph = new Int16Array(AG_VIS_H * AG_VIS_W)

// Skip-redraw cache — only emit a cell when its glyph or colour changes.
const ag_cellGlyph = new Int16Array(AG_VIS_H * AG_VIS_W).fill(-1)
const ag_cellFg    = new Int16Array(AG_VIS_H * AG_VIS_W).fill(-1)
const ag_waveGlyph = new Int16Array(AG_LANE_W * 3).fill(-1)
const ag_stereoGlyph = new Int16Array(AG_LANE_W).fill(-1)
const ag_stereoFg    = new Int16Array(AG_LANE_W).fill(-1)
let ag_lastBassFg    = -1

// Render rate-limiter — playmp2 spins ~32 Hz, playtad ~1 Hz, playwav ~100 Hz
// at decode time.  Clamp visual refresh to 20 Hz so each caller can spam
// audioRender() without worrying about pacing.
let ag_lastRenderNs = 0
const AG_RENDER_INTERVAL_NS = 50 * 1000 * 1000   // 50 ms

// Latest progress fraction so we redraw the bar only when it changes.
let ag_lastProgressIdx = -1
let ag_lastTimeStr = ''

// Init params held for re-use during render.
let ag_initParams = null

function ag_color(fg, bg) { con.color_pair(fg, bg) }
function ag_mvprn(row, col, ch) { con.mvaddch(row, col, ch) }
function ag_mvtext(row, col, s) { con.move(row, col); print(s) }

function ag_pad(n, w) {
    let s = '' + n
    while (s.length < w) s = ' ' + s
    return s
}

function ag_secToReadable(n) {
    const mins = ('' + ((n / 60) | 0)).padStart(2, '0')
    const secs = ('' + (n % 60)).padStart(2, '0')
    return mins + ':' + secs
}

function ag_drawSeparator(row, label) {
    ag_color(AG_COL_BORDER, AG_COL_BG)
    ag_mvprn(row, 1, AG_SEP_L)
    for (let x = 2; x < AG_COLS; x++) ag_mvprn(row, x, AG_BX_H)
    ag_mvprn(row, AG_COLS, AG_SEP_R)
    if (label) {
        ag_color(AG_COL_LABEL, AG_COL_BG)
        ag_mvtext(row, 5, ' ' + label + ' ')
    }
}

function ag_drawFrame() {
    // Top border with embedded format tag.
    ag_color(AG_COL_BORDER, AG_COL_BG)
    ag_mvprn(AG_ROW_TOP_BORDER, 1, AG_BX_TL)
    for (let x = 2; x < AG_COLS; x++) ag_mvprn(AG_ROW_TOP_BORDER, x, AG_BX_H)
    ag_mvprn(AG_ROW_TOP_BORDER, AG_COLS, AG_BX_TR)
    if (ag_initParams.tag) {
        ag_color(AG_COL_LABEL, AG_COL_BG)
        ag_mvtext(AG_ROW_TOP_BORDER, 4, ' ' + ag_initParams.tag + ' ')
    }

    // Bottom border with exit hint.
    ag_color(AG_COL_BORDER, AG_COL_BG)
    ag_mvprn(AG_ROW_BOT_BORDER, 1, AG_BX_BL)
    for (let x = 2; x < AG_COLS; x++) ag_mvprn(AG_ROW_BOT_BORDER, x, AG_BX_H)
    ag_mvprn(AG_ROW_BOT_BORDER, AG_COLS, AG_BX_BR)
    ag_color(AG_COL_DIM, AG_COL_BG)
    ag_mvtext(AG_ROW_BOT_BORDER, 4, ' Hold BkSp to exit ')

    // Side bars.
    ag_color(AG_COL_BORDER, AG_COL_BG)
    for (let r = 2; r < AG_ROWS; r++) {
        ag_mvprn(r, 1, AG_BX_V)
        ag_mvprn(r, AG_COLS, AG_BX_V)
    }

    // Inner separator over the visualiser canvas.  The wavescope strip sits
    // flush against the title row — no separator there.
    ag_drawSeparator(AG_ROW_VIS_SEP, 'VISUALS')
}

function ag_clearInside(row) {
    ag_color(AG_COL_DIM, AG_COL_BG)
    con.move(row, AG_COL_INSIDE_L)
    print(' '.repeat(AG_LANE_W))
}

function ag_drawTitle() {
    ag_clearInside(AG_ROW_TITLE)
    let title = ag_initParams.title || ''
    // Reserve 24 cols on the right for time string + progress bar.
    if (title.length > AG_LANE_W - 26) title = title.substring(0, AG_LANE_W - 29) + '...'
    ag_color(AG_COL_TITLE, AG_COL_BG)
    ag_mvtext(AG_ROW_TITLE, AG_COL_INSIDE_L + 1, title)
}

// Progress: time string + 22-wide dashes ramp (matches playtaud).  Called by
// the player via audioSetProgress; redraws only when something changed.
function ag_drawProgress(progress, elapsedSec, totalSec) {
    const barW = 22
    const bx0 = AG_COL_INSIDE_R - barW
    const filled = Math.round(progress * barW)

    const timeStr = ag_secToReadable(elapsedSec) + '/' + ag_secToReadable(totalSec)
    if (timeStr !== ag_lastTimeStr) {
        ag_lastTimeStr = timeStr
        ag_color(AG_COL_VALUE, AG_COL_BG)
        ag_mvtext(AG_ROW_TITLE, bx0 - timeStr.length - 1, timeStr)
    }

    if (filled === ag_lastProgressIdx) return
    ag_lastProgressIdx = filled

    for (let i = 0; i < barW; i++) {
        const lit = i < filled
        ag_color(lit ? AG_COL_PROG_ON : AG_COL_DIM, AG_COL_BG)
        ag_mvprn(AG_ROW_TITLE, bx0 + i, lit ? 0x7C /*│*/ : 0x2E /*.*/)
    }
}

// ── PCM ingestion ───────────────────────────────────────────────────────────
//
// feedPcm copies the most recent SNAPSHOT_N samples from a PCMu8-stereo-
// interleaved buffer into our snapshot.  `ptr` can be a positive heap address
// (LPCM/ADPCM decoded buffer, raw PCM) or a negative peripheral address (TAD
// decoded buffer, MP2 mediaDecodedBin) — TSVM peripheral memory grows toward
// 0, so reads use a signed step `vec`.

function audioFeedPcm(ptr, sampleCount) {
    if (!sampleCount) return
    const vec = ptr >= 0 ? 1 : -1
    const inv128 = 1 / 128

    if (sampleCount >= AG_SNAPSHOT_N) {
        // Take last AG_SNAPSHOT_N samples — discard the rest.
        const start = sampleCount - AG_SNAPSHOT_N
        for (let i = 0; i < AG_SNAPSHOT_N; i++) {
            const off = (start + i) * 2 * vec
            ag_snapL[i] = ((sys.peek(ptr + off) & 0xFF) - 128) * inv128
            ag_snapR[i] = ((sys.peek(ptr + off + vec) & 0xFF) - 128) * inv128
        }
    } else {
        // Shift snapshot left by `sampleCount` and append all new samples.
        const shift = sampleCount
        const keep  = AG_SNAPSHOT_N - shift
        for (let i = 0; i < keep; i++) {
            ag_snapL[i] = ag_snapL[i + shift]
            ag_snapR[i] = ag_snapR[i + shift]
        }
        for (let i = 0; i < shift; i++) {
            const off = i * 2 * vec
            ag_snapL[keep + i] = ((sys.peek(ptr + off) & 0xFF) - 128) * inv128
            ag_snapR[keep + i] = ((sys.peek(ptr + off + vec) & 0xFF) - 128) * inv128
        }
    }
}

// ── Wavelet analysis ───────────────────────────────────────────────────────
//
// In-place Haar decomposition.  Five levels on 1024 samples gives band
// passes (at 32 kHz): [8k..16k], [4k..8k], [2k..4k], [1k..2k], [500..1k].
// Sub-500 Hz ends up in the approximation and is intentionally dropped —
// otherwise the bass would dominate every track.

function ag_analyseHaar() {
    // mid = (L + R) / 2
    for (let i = 0; i < AG_SNAPSHOT_N; i++) {
        ag_workMid[i] = (ag_snapL[i] + ag_snapR[i]) * 0.5
    }
    let len = AG_SNAPSHOT_N
    const SQ_HALF = 0.70710678   // 1/sqrt(2) keeps L2 norm
    for (let lv = 0; lv < AG_N_BANDS; lv++) {
        const half = len >> 1
        let sumSq = 0
        for (let i = 0; i < half; i++) {
            const a = ag_workMid[i * 2]
            const b = ag_workMid[i * 2 + 1]
            const lo = (a + b) * SQ_HALF
            const hi = (a - b) * SQ_HALF
            ag_workMid[i] = lo
            ag_workTmp[i] = hi
            sumSq += hi * hi
        }
        // Higher-freq levels naturally have weaker energy in music; scale
        // each band by an empirical gain so all five read at comparable
        // brightness on typical material.
        const gain = 3.0 + lv * 1.5
        const rms = Math.sqrt(sumSq / half) * gain
        ag_bandEnergy[lv] = rms > 1 ? 1 : rms
        len = half
    }
    // Residual approximation in ag_workMid[0..len-1] holds the sub-500 Hz
    // energy that the modulator pipeline intentionally discards.  Reuse it
    // to drive the bass mark.
    let bassSumSq = 0
    for (let i = 0; i < len; i++) {
        const v = ag_workMid[i]
        bassSumSq += v * v
    }
    const bassRms = Math.sqrt(bassSumSq / len) * 1.8
    ag_bassEnergy = bassRms > 1 ? 1 : bassRms
}

// ── Mini-AAlib (embedded, for the wavescope) ───────────────────────────────
//
// Stripped port of `disk0/hopper/include/aa.mjs`, sized to one job: convert a
// small pixel-space brightness buffer into ASCII glyphs with three monochrome
// intensities (DIM / NORMAL / BOLD).  No dither.  No brightness / contrast /
// gamma / inversion.  No REVERSE / SPECIAL / BOLDFONT attribute support.
// See aa.mjs for the full algorithm, credits (Jan Hubicka & the AA-group,
// 1997), and the long-form comments — those are not duplicated here.
//
// Tables (params + 65536-entry LUT + filltable) are built once on first use
// from the TSVM 7×14 font ROM, so the wavescope's glyph-selection matches the
// brightness profile of the cells the hardware text mode actually paints.

const AA_FONT_PATH = "A:/tvdos/tsvm.chr"
const AA_NORMAL = 0
const AA_DIM    = 1
const AA_BOLD   = 2
const AA_NATTRS = 3
const AA_NCHARS = 256 * AA_NATTRS
const AA_DIMMUL  = 5.3
const AA_BOLDMUL = 2.7
const AA_MUL = 8
const AA_VAL = 13                          // uniform-cell threshold
const AA_PRIORITY = [4, 5, 3]              // NORMAL, DIM, BOLD (matches aalib)

let aa_font = null                         // { width, height, data }
let aa_params = null                       // Uint16Array((NCHARS+1)*5)
let aa_table = null                        // Uint16Array(65536)
let aa_filltable = null                    // Uint16Array(256)

function aa_loadFont() {
    if (aa_font) return aa_font
    const fh = files.open(AA_FONT_PATH)
    if (!fh.exists) throw Error("playgui: font ROM not found: " + AA_FONT_PATH)
    const blob = fh.bread()
    const FW = 7, FH = 14, ROM = 1920
    if (blob.length !== ROM && blob.length !== ROM * 2) {
        throw Error("playgui: bad font ROM size " + blob.length)
    }
    const data = new Uint8Array(256 * FW * FH)
    const halves = blob.length / ROM
    const startHalf = (halves === 2) ? 0 : 1
    for (let h = 0; h < halves; h++) {
        const romStart = h * ROM
        const charBase = (startHalf + h) * 128
        for (let c = 0; c < 128; c++) {
            const srcBase = romStart + c * FH
            const dstBase = (charBase + c) * FW * FH
            for (let r = 0; r < FH; r++) {
                const b = blob[srcBase + r] & 0xFF
                for (let x = 0; x < FW; x++) {
                    data[dstBase + r * FW + x] = ((b >> (6 - x)) & 1) ? 0xFF : 0x00
                }
            }
        }
    }
    aa_font = { width: FW, height: FH, data: data }
    return aa_font
}

function aa_alowed(i) {
    const c = i & 0xff
    const attr = (i >>> 8)
    if (attr >= AA_NATTRS) return false
    // printable ASCII, space, or extended (>160) — keep AA_EIGHT chars so the
    // glyph palette includes the TSVM ROM's box-drawing / shade / dot range.
    if (!(c >= 33 && c <= 126) && c !== 0x20 && !(c > 160)) return false
    return true
}

// (NE, NW, SE, SW) brightness for glyph `code` under `attr`. Quadrant labelling
// follows aalib's bit-numbering quirk; the LUT lookup later swaps the halves
// back to natural orientation. See aa.mjs:_glyphValues for the long-form note.
function aa_glyphValues(code, attr, out) {
    const fd = aa_font.data
    const fw = aa_font.width
    const fh = aa_font.height
    const base = code * fw * fh
    const halfW = fw >> 1
    const halfH = fh >> 1
    const leftW = halfW
    const topH  = halfH
    let v1 = 0, v2 = 0, v3 = 0, v4 = 0
    for (let r = 0; r < topH; r++) {
        const rowBase = base + r * fw
        for (let x = 0; x < leftW; x++) if (fd[rowBase + x]) v2++
        for (let x = leftW; x < fw;   x++) if (fd[rowBase + x]) v1++
    }
    for (let r = topH; r < fh; r++) {
        const rowBase = base + r * fw
        for (let x = 0; x < leftW; x++) if (fd[rowBase + x]) v4++
        for (let x = leftW; x < fw;   x++) if (fd[rowBase + x]) v3++
    }
    v1 *= AA_MUL; v2 *= AA_MUL; v3 *= AA_MUL; v4 *= AA_MUL
    if (attr === AA_DIM) {
        v1 = (v1 + 1) / AA_DIMMUL
        v2 = (v2 + 1) / AA_DIMMUL
        v3 = (v3 + 1) / AA_DIMMUL
        v4 = (v4 + 1) / AA_DIMMUL
    } else if (attr === AA_BOLD) {
        v1 *= AA_BOLDMUL
        v2 *= AA_BOLDMUL
        v3 *= AA_BOLDMUL
        v4 *= AA_BOLDMUL
    }
    out[0] = v1; out[1] = v2; out[2] = v3; out[3] = v4
}

function aa_calcparams() {
    aa_loadFont()
    aa_params = new Uint16Array((AA_NCHARS + 1) * 5)
    const tmp = new Float64Array(4)
    let ma1 = 0, ma2 = 0, ma3 = 0, ma4 = 0, msum = 0
    let mi1 = 50000, mi2 = 50000, mi3 = 50000, mi4 = 50000, misum = 50000
    for (let i = 0; i < AA_NCHARS; i++) {
        if (!aa_alowed(i)) continue
        aa_glyphValues(i & 0xff, i >>> 8, tmp)
        const v1 = tmp[0], v2 = tmp[1], v3 = tmp[2], v4 = tmp[3]
        if (v1 > ma1) ma1 = v1
        if (v2 > ma2) ma2 = v2
        if (v3 > ma3) ma3 = v3
        if (v4 > ma4) ma4 = v4
        const s = v1 + v2 + v3 + v4
        if (s > msum) msum = s
        if (v1 < mi1) mi1 = v1
        if (v2 < mi2) mi2 = v2
        if (v3 < mi3) mi3 = v3
        if (v4 < mi4) mi4 = v4
        if (s < misum) misum = s
    }
    msum -= misum
    mi1 = misum / 4; mi2 = misum / 4; mi3 = misum / 4; mi4 = misum / 4
    ma1 = msum / 4;  ma2 = msum / 4;  ma3 = msum / 4;  ma4 = msum / 4
    for (let i = 0; i < AA_NCHARS; i++) {
        aa_glyphValues(i & 0xff, i >>> 8, tmp)
        const v1r = tmp[0], v2r = tmp[1], v3r = tmp[2], v4r = tmp[3]
        const sr = v1r + v2r + v3r + v4r
        let sum = Math.floor((sr - misum) * (1020 / msum) + 0.5)
        let v1 = Math.floor((v1r - mi1) * (255 / ma1) + 0.5)
        let v2 = Math.floor((v2r - mi2) * (255 / ma2) + 0.5)
        let v3 = Math.floor((v3r - mi3) * (255 / ma3) + 0.5)
        let v4 = Math.floor((v4r - mi4) * (255 / ma4) + 0.5)
        if (v1 > 255) v1 = 255; else if (v1 < 0) v1 = 0
        if (v2 > 255) v2 = 255; else if (v2 < 0) v2 = 0
        if (v3 > 255) v3 = 255; else if (v3 < 0) v3 = 0
        if (v4 > 255) v4 = 255; else if (v4 < 0) v4 = 0
        if (sum > 1020) sum = 1020; else if (sum < 0) sum = 0
        aa_params[i * 5 + 0] = v1
        aa_params[i * 5 + 1] = v2
        aa_params[i * 5 + 2] = v3
        aa_params[i * 5 + 3] = v4
        aa_params[i * 5 + 4] = sum
    }
}

function aa_pow2(x) { return x * x }
function aa_pos(i1, i2, i3, i4) { return (i1 << 12) + (i2 << 8) + (i3 << 4) + i4 }
function aa_dist(i1, i2, i3, i4, i5, y1, y2, y3, y4, y5) {
    return 2 * (aa_pow2(i1 - y1) + aa_pow2(i2 - y2) + aa_pow2(i3 - y3) + aa_pow2(i4 - y4))
           + aa_pow2(i5 - y5)
}
function aa_dist1(i1, i2, i3, i4, i5, y1, y2, y3, y4, y5) {
    return aa_pow2(i1 - y1) + aa_pow2(i2 - y2) + aa_pow2(i3 - y3) + aa_pow2(i4 - y4)
           + 2 * aa_pow2(i5 - y5)
}

function aa_mktable() {
    if (!aa_params) aa_calcparams()
    aa_table = new Uint16Array(65536)
    aa_filltable = new Uint16Array(256)
    const next = new Int32Array(65536)
    for (let i = 0; i < 65536; i++) next[i] = i
    let first = -1, last = -1
    function add(i) {
        if (next[i] === i && last !== i) {
            if (last !== -1) { next[last] = i; last = i }
            else { last = first = i }
        }
    }
    for (let i = 0; i < AA_NCHARS; i++) {
        if (!aa_alowed(i)) continue
        const i1 = aa_params[i * 5 + 0]
        const i2 = aa_params[i * 5 + 1]
        const i3 = aa_params[i * 5 + 2]
        const i4 = aa_params[i * 5 + 3]
        const i5 = aa_params[i * 5 + 4]
        const p1 = i1 >> 4, p2 = i2 >> 4, p3 = i3 >> 4, p4 = i4 >> 4
        const p = aa_pos(p1, p2, p3, p4)
        if (aa_table[p]) {
            const ex = aa_table[p]
            const ex1 = aa_params[ex * 5 + 0]
            const ex2 = aa_params[ex * 5 + 1]
            const ex3 = aa_params[ex * 5 + 2]
            const ex4 = aa_params[ex * 5 + 3]
            const ex5 = aa_params[ex * 5 + 4]
            const pp1 = (p1 << 4) | p1
            const pp2 = (p2 << 4) | p2
            const pp3 = (p3 << 4) | p3
            const pp4 = (p4 << 4) | p4
            const ppsum = pp1 + pp2 + pp3 + pp4
            const dNew = aa_dist(i1, i2, i3, i4, i5,  pp1, pp2, pp3, pp4, ppsum)
            const dOld = aa_dist(ex1, ex2, ex3, ex4, ex5,  pp1, pp2, pp3, pp4, ppsum)
            if (dNew > dOld) continue
            if (dNew === dOld && AA_PRIORITY[(i >>> 8)] <= AA_PRIORITY[(ex >>> 8)]) continue
        }
        aa_table[p] = i
        add(p)
    }
    for (let q = 0; q < 256; q++) {
        let mindist = Infinity
        let best = 0
        for (let i = 0; i < AA_NCHARS; i++) {
            if (!aa_alowed(i)) continue
            const d1 = aa_dist1(aa_params[i * 5 + 0], aa_params[i * 5 + 1],
                                aa_params[i * 5 + 2], aa_params[i * 5 + 3],
                                aa_params[i * 5 + 4],
                                q, q, q, q, q * 4)
            if (d1 < mindist ||
                (d1 === mindist && AA_PRIORITY[(i >>> 8)] > AA_PRIORITY[(best >>> 8)])) {
                aa_filltable[q] = i
                mindist = d1
                best = i
            }
        }
    }
    // BFS propagation: claim neighbour slots that we cover better than whoever
    // got there first.  Lifted verbatim from aamktabl.c via aa.mjs.
    while (true) {
        if (last !== -1) next[last] = last
        else break
        const blocked = last
        let i = first
        if (i === -1) break
        first = -1; last = -1
        let prev
        do {
            const m0 = (i >> 12) & 15
            const m1 = (i >> 8) & 15
            const m2 = (i >> 4) & 15
            const m3 = i & 15
            const c = aa_table[i]
            const cp0 = aa_params[c * 5 + 0]
            const cp1 = aa_params[c * 5 + 1]
            const cp2 = aa_params[c * 5 + 2]
            const cp3 = aa_params[c * 5 + 3]
            const cp4 = aa_params[c * 5 + 4]
            for (let dm = 0; dm < 4; dm++) {
                for (let sgn = -1; sgn <= 1; sgn += 2) {
                    let n0 = m0, n1 = m1, n2 = m2, n3 = m3
                    if (dm === 0)      { n0 += sgn; if (n0 < 0 || n0 >= 16) continue }
                    else if (dm === 1) { n1 += sgn; if (n1 < 0 || n1 >= 16) continue }
                    else if (dm === 2) { n2 += sgn; if (n2 < 0 || n2 >= 16) continue }
                    else               { n3 += sgn; if (n3 < 0 || n3 >= 16) continue }
                    const index = aa_pos(n0, n1, n2, n3)
                    const ch = aa_table[index]
                    if (ch === c || index === blocked) continue
                    let replace = !ch
                    if (!replace) {
                        const ii1 = (n0 << 4) | n0
                        const ii2 = (n1 << 4) | n1
                        const ii3 = (n2 << 4) | n2
                        const ii4 = (n3 << 4) | n3
                        const iisum = ii1 + ii2 + ii3 + ii4
                        const dNew = aa_dist(ii1, ii2, ii3, ii4, iisum,
                                             cp0, cp1, cp2, cp3, cp4)
                        const dOld = aa_dist(ii1, ii2, ii3, ii4, iisum,
                                             aa_params[ch * 5 + 0],
                                             aa_params[ch * 5 + 1],
                                             aa_params[ch * 5 + 2],
                                             aa_params[ch * 5 + 3],
                                             aa_params[ch * 5 + 4])
                        if (dNew < dOld) replace = true
                    }
                    if (replace) { aa_table[index] = c; add(index) }
                }
            }
            prev = i
            i = next[i]
            next[prev] = prev
        } while (i !== prev)
    }
}

// Render an imgW × imgH brightness buffer (imgW = scrW*2, imgH = scrH*2) into
// per-cell (glyph, attr) outputs.  No dither, no params.
function aa_render(img, scrW, scrH, tbOut, attrOut) {
    if (!aa_table) aa_mktable()
    const tbl = aa_table
    const fill = aa_filltable
    const wi = scrW * 2
    for (let y = 0; y < scrH; y++) {
        let pos  = 2 * y * wi
        let pos1 = y * scrW
        for (let x = 0; x < scrW; x++) {
            const i1 = img[pos + 1]       // NE
            const i2 = img[pos]           // NW
            const i3 = img[pos + wi + 1]  // SE
            const i4 = img[pos + wi]      // SW
            const s = i1 + i2 + i3 + i4
            const avg = s >> 2
            let val
            if (Math.abs(i1 - avg) < AA_VAL &&
                Math.abs(i2 - avg) < AA_VAL &&
                Math.abs(i3 - avg) < AA_VAL &&
                Math.abs(i4 - avg) < AA_VAL) {
                val = fill[avg]
            } else {
                val = tbl[((i2 >> 4) << 12) | ((i1 >> 4) << 8) |
                          ((i4 >> 4) << 4)  |  (i3 >> 4)]
            }
            attrOut[pos1] = val >> 8
            tbOut[pos1]   = val & 0xff
            pos  += 2
            pos1 += 1
        }
    }
}

// ── Wavescope (rows 3..5) ──────────────────────────────────────────────────
//
// Peak-detected envelope plotted into a 156×6 pixel buffer (2× cell res),
// then converted to ASCII glyphs by the mini-AAlib above.  Mid-signal only —
// stereo info lives on the bottom bar.
//
// Three monochrome intensities pick out the wave's body / peaks: DIM cells
// are the dim trace, NORMAL cells are the bulk of the waveform, BOLD cells
// land on the brightest patches (full-blocked peaks).  Amber → white ramp
// mimics phosphor bloom.

const AA_WAVE_W = AG_LANE_W                  // 78 cells
const AA_WAVE_H = AG_ROW_WAVE_BOT - AG_ROW_WAVE_TOP + 1   // 3 cells
const AA_WAVE_IW = AA_WAVE_W * 2             // 156 px
const AA_WAVE_IH = AA_WAVE_H * 2             //   6 px

const ag_waveImg  = new Uint8Array(AA_WAVE_IW * AA_WAVE_IH)
const ag_waveTb   = new Uint8Array(AA_WAVE_W * AA_WAVE_H)
const ag_waveAttr = new Uint8Array(AA_WAVE_W * AA_WAVE_H)

// AA_NORMAL=0, AA_DIM=1, AA_BOLD=2  → amber phosphor palette.
const AG_WAVE_FG = [166, 130, AG_COL_LABEL]

function ag_drawWavescope() {
    const N  = AG_SNAPSHOT_N
    const IW = AA_WAVE_IW
    const IH = AA_WAVE_IH
    const img = ag_waveImg
    img.fill(0)

    // Per-pixel-column envelope: vertical line from max to min sample value.
    const samplesPerCol = N / IW
    const yScale = (IH - 1) * 0.5
    for (let c = 0; c < IW; c++) {
        const s = (c * samplesPerCol) | 0
        const e = (((c + 1) * samplesPerCol) | 0)
        let mn = 1.0, mx = -1.0
        for (let i = s; i < e; i++) {
            const v = (ag_snapL[i] + ag_snapR[i]) * 0.5
            if (v < mn) mn = v
            if (v > mx) mx = v
        }
        // [-1, 1] → [0, IH-1]; +1 sits at the top, -1 at the bottom.
        let yT = ((1 - mx) * yScale + 0.5) | 0
        let yB = ((1 - mn) * yScale + 0.5) | 0
        if (yT < 0) yT = 0; else if (yT > IH - 1) yT = IH - 1
        if (yB < 0) yB = 0; else if (yB > IH - 1) yB = IH - 1
        for (let y = yT; y <= yB; y++) img[y * IW + c] = 0xFF
    }

    aa_render(img, AA_WAVE_W, AA_WAVE_H, ag_waveTb, ag_waveAttr)

    // Blit, skipping cells whose packed (attr<<8 | glyph) key is unchanged.
    for (let r = 0; r < AA_WAVE_H; r++) {
        for (let c = 0; c < AA_WAVE_W; c++) {
            const idx = r * AA_WAVE_W + c
            const att = ag_waveAttr[idx]
            const ch  = ag_waveTb[idx]
            const key = (att << 8) | ch
            if (ag_waveGlyph[idx] === key) continue
            ag_waveGlyph[idx] = key
            ag_color(AG_WAVE_FG[att] || AG_COL_LABEL, AG_COL_BG)
            ag_mvprn(AG_ROW_WAVE_TOP + r, AG_COL_INSIDE_L + c, ch)
        }
    }
}

// ── XY-scope persistence visualiser (rows 7..30) ───────────────────────────
//
// 45°-rotated vectorscope, standard convention.  Each PCM sample plots at
//     col = centre_col + (L − R) · SX
//     row = centre_row + (L + R) · SY
// giving the four canonical traces:
//     in-phase mono (L = R)    → vertical line   ((L−R)=0, (L+R) varies)
//     out-of-phase mono (L=−R) → horizontal line ((L+R)=0, (L−R) varies)
//     pure L  (R = 0)          → lower-right diagonal — the `\` axis
//     pure R  (L = 0)          → lower-left  diagonal — the `/` axis
// (Positive mono sits below centre because screen row increases downward.)
// The glyph per cell follows channel dominance, the cell's intensity is
// bumped on every hit, and a global decay shrinks stale traces back to zero.
//
// Wavelet energies are used as *modulators* — the design's central idea:
//
//   transient  → faster decay + scattered spark emission
//   bass/tonal → slower decay (sustained content breathes longer)
//   noise      → small jitter on plot position (texture fuzz)
//
// TSVM terminal cells are ~2:1 (taller than wide); SX is set to ~2×SY so the
// scope reads roughly circular under steady mono content.

const AG_XY_CX = AG_VIS_W >> 1     // centre column inside visualiser canvas
const AG_XY_CY = AG_VIS_H >> 1     // centre row
const AG_XY_SX = 18                // (L−R) → horizontal extent ±36 cells
const AG_XY_SY = 9                 // (L+R) → vertical   extent ±18 cells

// Bass mark: 2×2 cell indicator pinned to the centre of the vectorscope so
// the bass "subwoofer" sits underneath the beam's pivot point.  Half-blocks
// form a compact 16×16-pixel "dot" centred in the 16×32-pixel 2×2 area.
const AG_BASS_VIS_R0 = AG_XY_CY - 1
const AG_BASS_VIS_C0 = AG_XY_CX - 1
const AG_BASS_VIS_R1 = AG_BASS_VIS_R0 + 1
const AG_BASS_VIS_C1 = AG_BASS_VIS_C0 + 1
const AG_BASS_SCR_R  = AG_ROW_VIS_TOP + AG_BASS_VIS_R0
const AG_BASS_SCR_C  = AG_COL_INSIDE_L + AG_BASS_VIS_C0

// Glyphs.
const AG_G_DOT  = 0xFA  // ·
const AG_G_BSL  = 0x5C  // \\
const AG_G_FSL  = 0x2F  // /
const AG_G_XCR  = 0x58  // X
const AG_G_SPK  = 0x2A  // *
const AG_G_HBAR = 0xC4  // ─

function ag_updateXYScope() {
    // Wavelet-driven modulators, all in [0, 1].
    const transient = ag_bandEnergy[AG_WL_TRANSIENT]
    const noise     = ag_bandEnergy[AG_WL_NOISE]
    const sustain   = ag_bandEnergy[AG_WL_BASS] * 0.6 + ag_bandEnergy[AG_WL_TONAL] * 0.4

    // Decay: base 0.93, longer for sustained content, much shorter for sharp
    // transients.  Clamped so a screaming hi-hat never freezes the trails and
    // a deep pad never overflows.
    let decay = 0.93 + 0.05 * (sustain > 1 ? 1 : sustain)
                     - 0.10 * (transient > 1 ? 1 : transient)
    if (decay < 0.72) decay = 0.72
    if (decay > 0.985) decay = 0.985

    // Decay all cells.
    for (let i = 0; i < ag_persist.length; i++) {
        ag_persist[i] *= decay
    }

    // Plot every sample in the snapshot.  Step 1 keeps lines continuous
    // visually; with 1024 samples per ~50 ms frame, most cells get multiple
    // hits and the persistence builds the "beam" silhouette.
    const SX = AG_XY_SX
    const SY = AG_XY_SY
    const cx = AG_XY_CX
    const cy = AG_XY_CY
    const jitterAmt = noise * 0.06        // noise-driven beam fuzz
    const plotBoost = 0.05

    for (let i = 0; i < AG_SNAPSHOT_N; i++) {
        const L = ag_snapL[i]
        const R = ag_snapR[i]
        const mono = L + R                 // vertical axis  ∈ [-2, 2]
        const side = L - R                 // horizontal axis ∈ [-2, 2]
        // Wavelet-driven jitter is symmetric — substitute a deterministic
        // pseudo-random by mixing the snapshot index so we don't churn the
        // shared Math.random() PRNG 1024× per frame.
        const jx = (((i * 1103515245 + 12345) & 0xFFFF) / 65536 - 0.5) * jitterAmt
        const jy = (((i * 1664525     + 1013904223) & 0xFFFF) / 65536 - 0.5) * jitterAmt
        let col = cx + ((side + jx) * SX) | 0
        let row = cy + ((mono + jy) * SY) | 0
        if (col < 0 || col >= AG_VIS_W || row < 0 || row >= AG_VIS_H) continue

        const absL = L < 0 ? -L : L
        const absR = R < 0 ? -R : R
        let glyph
        if (absL + absR < 0.04) {
            glyph = AG_G_DOT
        } else if (absL > absR * 1.25) {
            glyph = AG_G_BSL                 // L-dominant → \
        } else if (absR > absL * 1.25) {
            glyph = AG_G_FSL                 // R-dominant → /
        } else {
            glyph = AG_G_XCR                 // mixed     → X
        }

        const idx = row * AG_VIS_W + col
        let nv = ag_persist[idx] + plotBoost
        if (nv > 1.0) nv = 1.0
        ag_persist[idx] = nv
        ag_persistGlyph[idx] = glyph
    }

    // Transient spark emission — when high-freq energy peaks, scatter a few
    // bright `*` glyphs across the canvas.  Cap at ~32 sparks to stay cheap.
    if (transient > 0.32) {
        const nSparks = ((transient - 0.32) * 60) | 0
        for (let s = 0; s < nSparks && s < 32; s++) {
            const c = (Math.random() * AG_VIS_W) | 0
            const r = (Math.random() * AG_VIS_H) | 0
            const idx = r * AG_VIS_W + c
            if (ag_persist[idx] < 0.85) ag_persist[idx] = 0.85
            ag_persistGlyph[idx] = AG_G_SPK
        }
    }
}

function ag_drawVisualiser() {
    for (let r = 0; r < AG_VIS_H; r++) {
        const rowOff = r * AG_VIS_W
        const screenY = AG_ROW_VIS_TOP + r
        const inBassRow = (r === AG_BASS_VIS_R0 || r === AG_BASS_VIS_R1)
        for (let c = 0; c < AG_VIS_W; c++) {
            // Bass mark owns its 2×2 cells — let ag_drawBassMark() paint them.
            if (inBassRow && (c === AG_BASS_VIS_C0 || c === AG_BASS_VIS_C1)) continue
            const idx = rowOff + c
            const e = ag_persist[idx]
            let levelIdx = (e * 5) | 0
            if (levelIdx > 4) levelIdx = 4
            if (levelIdx < 0) levelIdx = 0
            const glyph = (levelIdx === 0) ? 0x20 : ag_persistGlyph[idx]
            const fg    = AG_BEAM_PAL[levelIdx]
            if (ag_cellGlyph[idx] === glyph && ag_cellFg[idx] === fg) continue
            ag_cellGlyph[idx] = glyph
            ag_cellFg[idx]    = fg
            ag_color(fg, AG_COL_BG)
            ag_mvprn(screenY, AG_COL_INSIDE_L + c, glyph)
        }
    }
}

// ── Bass mark (rows 29-30, cols 2-3) ───────────────────────────────────────
// Brightness-only indicator driven by the sub-500 Hz residual of the Haar
// pyramid.  Uses indices 1..4 of the beam palette so the dot never falls all
// the way to background — a quiet track still shows a faint amber ember.

function ag_drawBassMark() {
    let idx = (ag_bassEnergy * 4) | 0
    if (idx > 3) idx = 3
    if (idx < 0) idx = 0
    const fg = AG_BEAM_PAL[idx + 1]
    if (fg === ag_lastBassFg) return
    ag_lastBassFg = fg
    ag_color(fg, AG_COL_BG)
    ag_mvprn(AG_BASS_SCR_R,     AG_BASS_SCR_C,     0xDC)
    ag_mvprn(AG_BASS_SCR_R,     AG_BASS_SCR_C + 1, 0xDC)
    ag_mvprn(AG_BASS_SCR_R + 1, AG_BASS_SCR_C,     0xDF)
    ag_mvprn(AG_BASS_SCR_R + 1, AG_BASS_SCR_C + 1, 0xDF)
}

// ── Stereo energy bar (row 31) ─────────────────────────────────────────────
//
// Same idea as playtaud.drawStereo() but driven by raw PCM: for each sample,
// pan = side/|mid| → bin index, energy = sqrt(|mid|+|side|).  Gaussian-ish
// 7-cell spread so individual sample clusters read as bars, not single spikes.

function ag_drawStereo() {
    const W = AG_LANE_W
    const bins = new Float32Array(W)
    const N    = AG_SNAPSHOT_N

    for (let i = 0; i < N; i++) {
        const L = ag_snapL[i]
        const R = ag_snapR[i]
        const mid  = (L + R) * 0.5
        const side = (L - R) * 0.5
        const absM = mid < 0 ? -mid : mid
        const absS = side < 0 ? -side : side
        // Pan estimate, clamped — `side/|mid|` blows up near silence so we
        // floor the denominator.  This is a coarse stereo image, not a
        // calibrated readout.
        let pan = side / (absM + 0.02)
        if (pan < -1) pan = -1; else if (pan > 1) pan = 1
        const energy = Math.pow(absM + absS, 0.5)
        if (energy <= 0) continue

        let col = ((pan + 1) * 0.5 * (W - 1)) | 0
        if (col < 0) col = 0; else if (col >= W) col = W - 1
        bins[col] += energy
        if (col >= 3)     bins[col - 3] += energy * 0.05
        if (col >= 2)     bins[col - 2] += energy * 0.3
        if (col >= 1)     bins[col - 1] += energy * 0.75
        if (col < W - 1)  bins[col + 1] += energy * 0.75
        if (col < W - 2)  bins[col + 2] += energy * 0.3
        if (col < W - 3)  bins[col + 3] += energy * 0.05
    }
    // Calibrated for "typical" 32 kHz × 1024-sample snapshot at modest level.
    const norm = 8.0 / N
    for (let i = 0; i < W; i++) {
        const v = bins[i] * norm
        let idx = (v * 1.6) | 0
        if (idx > 4) idx = 4
        if (idx < 0) idx = 0
        const glyph = AG_STAIRS[idx]
        const fg    = AG_STEREO_COL[idx]
        if (ag_stereoGlyph[i] === glyph && ag_stereoFg[i] === fg) continue
        ag_stereoGlyph[i] = glyph
        ag_stereoFg[i]    = fg
        ag_color(fg, AG_COL_BG)
        ag_mvprn(AG_ROW_STEREO, AG_COL_INSIDE_L + i, glyph)
    }
}

// ── Public API ─────────────────────────────────────────────────────────────
//
// audioInit({ title, tag }): paint the static frame.
//   title : song title shown on row 2 (left)
//   tag   : 3-5 char format label embedded in the top border (e.g. "WAV", "MP2")
//
// audioFeedPcm(ptr, sampleCount): hand the visualiser a fresh slice of
//   PCMu8-stereo-interleaved samples (typically the freshly decoded chunk).
//
// audioSetProgress(progress, elapsedSec, totalSec): update the title-row
//   progress bar.  Cheap — only redraws on change.
//
// audioRender(): repaint wavescope + visualiser + stereo bar from the latest
//   snapshot.  Internally rate-limited to ~20 Hz so callers can invoke
//   liberally without juggling frame timing.
//
// audioClose(): restore cursor + move out of the panel for a clean exit.

function audioInit(params) {
    ag_initParams = params || {}
    ag_lastRenderNs = 0
    ag_lastProgressIdx = -1
    ag_lastTimeStr = ''
    for (let i = 0; i < ag_snapL.length; i++) { ag_snapL[i] = 0; ag_snapR[i] = 0 }
    for (let i = 0; i < ag_persist.length; i++) ag_persist[i] = 0
    ag_persistGlyph.fill(0x20)
    ag_cellGlyph.fill(-1); ag_cellFg.fill(-1)
    ag_waveGlyph.fill(-1)
    ag_stereoGlyph.fill(-1); ag_stereoFg.fill(-1)
    ag_bassEnergy = 0
    ag_lastBassFg = -1

    con.curs_set(0)
    con.clear()
    ag_drawFrame()
    ag_drawTitle()
}

function audioSetProgress(progress, elapsedSec, totalSec) {
    if (progress < 0) progress = 0; else if (progress > 1) progress = 1
    ag_drawProgress(progress, elapsedSec | 0, totalSec | 0)
}

function audioRender() {
    const now = sys.nanoTime()
    if (now - ag_lastRenderNs < AG_RENDER_INTERVAL_NS) return
    ag_lastRenderNs = now

    ag_analyseHaar()
    ag_updateXYScope()
    ag_drawWavescope()
    ag_drawVisualiser()
    ag_drawBassMark()
    ag_drawStereo()
}

function audioClose() {
    con.move(AG_ROW_BOT_BORDER + 1, 1)
    con.curs_set(1)
}

// ── Exit polling ───────────────────────────────────────────────────────────
// Mirror the Backspace-to-quit convention already in playtaud.

function audioIsExitRequested() {
    sys.poke(-40, 1)
    return sys.peek(-41) === 67
}

exports = {
    clearSubtitleArea,
    displaySubtitle,
    printTopBar,
    printBottomBar,
    audioInit,
    audioFeedPcm,
    audioSetProgress,
    audioRender,
    audioClose,
    audioIsExitRequested
}