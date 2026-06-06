// playtaud — Taud music player + visualiser for TVDOS.
//
// "An industrial control panel for impossible music."
// See ../taud_music_player_with_visualiser.md for the design spec.

const taud = require('taud')

// ── Format constants ────────────────────────────────────────────────────────
const TAUD_MAGIC       = [0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64]
const TAUD_HEADER_SIZE = 32
const TAUD_SONG_ENTRY  = 32
const PATTERN_SIZE     = 512
const ROWS_PER_PAT     = 64
const NUM_CUES         = 1024
const CUE_SIZE         = 32
const NUM_VOICES       = 20
const CUE_EMPTY        = 0xFFF

// Cue instruction bytes (cue offset 30).
const CUE_NOP    = 0x00
const CUE_HALT   = 0x01
const CUE_LEN    = 0x02
const CUE_BAK    = 0x80
const CUE_FWD    = 0x90
const CUE_JMP    = 0xF0

// Pattern cell sentinels.
const NOTE_NOP    = 0x0000
const NOTE_KEYOFF = 0x0001
const NOTE_CUT    = 0x0002

// Instrument archetypes.
const ARCH_DRUM  = 0
const ARCH_BASS  = 1
const ARCH_PAD   = 2
const ARCH_LEAD  = 3
const ARCH_METAL = 4

// ── Layout ──────────────────────────────────────────────────────────────────
// 80 cols × 32 rows.  All rows/cols are 1-indexed (TVDOS con convention).
const COLS = 80
const ROWS = 32

const ROW_TOP_BORDER  = 1
const ROW_TITLE       = 2
const ROW_STATUS      = 3
const ROW_ORDER_SEP   = 4
const ROW_ORDER       = 5
const ROW_TONAL_SEP   = 6
const ROW_TONAL_TOP   = 7
const ROW_TONAL_BOT   = 27 // allow visuals to invade the top row of drums
const ROW_DRUMS_TOP   = 27
const ROW_DRUMS_BOT   = 29 // 3-row percussion strip, flush against canvas
const ROW_STEREO      = 30
const ROW_TICK        = 31
const ROW_BOT_BORDER  = 32

// Inside-the-border columns are 2..79.  Lane width = 78.
const COL_INSIDE_L = 2
const COL_INSIDE_R = 79
const LANE_W       = 78

// BASS / PAD / LEAD / METAL all share the same continuous pitch canvas — they
// differ only in glyph and colour ramp.  DRUM keeps its own atonal strip since
// percussion has no meaningful pitch.
const TONAL_LANE = { top: ROW_TONAL_TOP, bot: ROW_TONAL_BOT }
const LANE_BY_ARCH = {
    [ARCH_LEAD] : TONAL_LANE,
    [ARCH_METAL]: TONAL_LANE,
    [ARCH_PAD]  : TONAL_LANE,
    [ARCH_BASS] : TONAL_LANE,
    [ARCH_DRUM] : { top: ROW_DRUMS_TOP, bot: ROW_DRUMS_BOT }
}

// Pitch range pinned to the musically useful span.  Notes outside clamp to the
// canvas top / bottom.  C2..C9 covers what trackers actually play; full
// 0..0xFFFF would compress everything into the middle band.
const PITCH_RANGE_LO = 0x2000   // ~C2
const PITCH_RANGE_HI = 0xA000   // ~C9

// Colours — TSVM palette indices.  Picked to read as amber/CRT chrome with
// archetype-coded events.  Background-transparent (255) lets the cell colour
// fall through to the terminal default for ergonomic resize behaviour.
const COL_BG          = 0     // solid black panel background
const COL_BORDER      = 250   // light grey panel chrome
const COL_LABEL       = 220   // amber panel label
const COL_DIM         = 235   // muted text
const COL_TITLE       = 230   // bright white-yellow song title
const COL_VALUE       = 254   // bright white numeric values
const COL_TICK_LIVE   = 76    // green tick light
const COL_TICK_DEAD   = 20    // dim green
const COL_ORDER_PAST  = 235
const COL_ORDER_CUR   = 226   // bright yellow active cue
const COL_ORDER_FUT   = 250
const COL_ORDER_HALT  = 196   // red HALT marker
const COL_ARCH = {
    [ARCH_LEAD] : [220,214,208,202],     // amber→orange decay ramp
    [ARCH_METAL]: [201,199,197,89 ],     // bright magenta→deep
    [ARCH_PAD]  : [117, 75, 33, 17],     // sky→deep blue
    [ARCH_BASS] : [202,166,130, 94],     // orange→burnt umber
    [ARCH_DRUM] : [254,250,246,240]      // white→grey
}

// ── Argument parsing ────────────────────────────────────────────────────────
if (!exec_args[1] || exec_args[1] === '-h' || exec_args[1] === '--help') {
    println("Usage: playtaud <file.taud> [songIndex]")
    println("  Plays a Taud tracker module with a text-mode visualiser.")
    println("  Hold Backspace to exit.")
    return 0
}

const filePath = _G.shell.resolvePathInput(exec_args[1]).full
const songArg  = exec_args[2] ? (exec_args[2] | 0) : 0

// ── File parsing ────────────────────────────────────────────────────────────
//
// We parse the Taud file in JS to keep our own copies of patterns/cues for the
// visualiser to consult on every row change, then hand the heavy lifting
// (sample+inst upload, pattern upload, cue upload, playhead config) over to
// libtaud.uploadTaudFile.  Reading the file twice is fine — these modules are
// small (≤1 MB compressed).

function _peekU32LE(ptr, off) {
    return ((sys.peek(ptr+off)   & 0xFF)       ) |
           ((sys.peek(ptr+off+1) & 0xFF) <<  8 ) |
           ((sys.peek(ptr+off+2) & 0xFF) << 16 ) |
           ((sys.peek(ptr+off+3) & 0xFF) * 0x1000000)
}

function parseTaud(path, songIndex) {
    const fh = files.open(path)
    if (!fh.exists) throw Error("playtaud: file not found: " + path)
    const fileSize = fh.size
    const ptr = sys.malloc(fileSize)
    fh.pread(ptr, fileSize, 0)
    fh.close()

    for (let i = 0; i < 8; i++) {
        if ((sys.peek(ptr + i) & 0xFF) !== TAUD_MAGIC[i]) {
            sys.free(ptr)
            throw Error("playtaud: bad Taud magic")
        }
    }

    const numSongs = sys.peek(ptr + 9) & 0xFF
    const compSize = _peekU32LE(ptr, 10)
    const projOff  = _peekU32LE(ptr, 14)

    if (songIndex < 0 || songIndex >= numSongs) {
        sys.free(ptr)
        throw Error("playtaud: song index " + songIndex + " of " + numSongs)
    }

    const songTableOff = TAUD_HEADER_SIZE + compSize
    const entryOff     = songTableOff + songIndex * TAUD_SONG_ENTRY
    const songOff      = _peekU32LE(ptr, entryOff)
    const numVoices    = sys.peek(ptr + entryOff + 4) & 0xFF
    const numPats      = (sys.peek(ptr + entryOff + 5) & 0xFF) |
                         ((sys.peek(ptr + entryOff + 6) & 0xFF) << 8)
    const bpm          = (sys.peek(ptr + entryOff + 7) & 0xFF) + 25
    const tickRate     = sys.peek(ptr + entryOff + 8) & 0xFF
    const patCompSize  = _peekU32LE(ptr, entryOff + 18)
    const cueCompSize  = _peekU32LE(ptr, entryOff + 22)

    // Decompress patterns into JS arrays.
    const patBinSize = numPats * PATTERN_SIZE
    const patBinPtr  = sys.malloc(patBinSize)
    gzip.decompFromTo(ptr + songOff, patCompSize, patBinPtr)

    const patterns = new Array(numPats)
    for (let p = 0; p < numPats; p++) {
        const buf = new Uint8Array(PATTERN_SIZE)
        for (let k = 0; k < PATTERN_SIZE; k++)
            buf[k] = sys.peek(patBinPtr + p * PATTERN_SIZE + k) & 0xFF
        patterns[p] = buf
    }
    sys.free(patBinPtr)

    // Decompress cue sheet.  Find last non-empty cue for the order strip.
    const cueSheetSize = NUM_CUES * CUE_SIZE
    const cuePtr       = sys.malloc(cueSheetSize)
    gzip.decompFromTo(ptr + songOff + patCompSize, cueCompSize, cuePtr)

    const cues = new Array(NUM_CUES)
    let lastCue = -1
    for (let c = 0; c < NUM_CUES; c++) {
        const ptns = new Array(NUM_VOICES)
        for (let i = 0; i < 10; i++) {
            const lo = sys.peek(cuePtr + c * CUE_SIZE +  i) & 0xFF
            const mi = sys.peek(cuePtr + c * CUE_SIZE + 10 + i) & 0xFF
            const hi = sys.peek(cuePtr + c * CUE_SIZE + 20 + i) & 0xFF
            ptns[i*2]   = ((hi >> 4) << 8) | ((mi >> 4) << 4) | (lo >> 4)
            ptns[i*2+1] = ((hi & 0xF) << 8) | ((mi & 0xF) << 4) | (lo & 0xF)
        }
        const i30 = sys.peek(cuePtr + c * CUE_SIZE + 30) & 0xFF
        const i31 = sys.peek(cuePtr + c * CUE_SIZE + 31) & 0xFF
        const cue = { ptns: ptns, i30: i30, i31: i31 }
        cues[c] = cue
        let occupied = (i30 !== CUE_NOP)
        if (!occupied) {
            for (let v = 0; v < NUM_VOICES; v++) {
                if (ptns[v] !== CUE_EMPTY) { occupied = true; break }
            }
        }
        if (occupied) lastCue = c
        // HALT terminates traversal — anything past it is unreachable.
        if (i30 === CUE_HALT) break
    }
    if (lastCue < 0) lastCue = 0

    // Decode an 0x1E-separated name table into a 256-slot array.  Names in the
    // file are slot-indexed starting at slot 0 (typically blank); trailing
    // empty slots are trimmed in the source so we top up with '' to length 256.
    function decodeNameTable(payload, secLen) {
        const out = new Array(256)
        for (let i = 0; i < 256; i++) out[i] = ''
        let slot = 0
        let buf = ''
        for (let k = 0; k < secLen; k++) {
            const b = sys.peek(ptr + payload + k) & 0xFF
            if (b === 0x1E) {
                if (slot < 256) out[slot] = buf
                slot++; buf = ''
                if (slot >= 256) break
            } else {
                buf += String.fromCharCode(b)
            }
        }
        if (slot < 256) out[slot] = buf
        return out
    }

    // Optional project data: song name, composer, instrument names, sample names.
    let projName = '', songName = '', composer = ''
    let instNames   = new Array(256); for (let i = 0; i < 256; i++) instNames[i]   = ''
    let sampleNames = new Array(256); for (let i = 0; i < 256; i++) sampleNames[i] = ''
    if (projOff !== 0 && projOff + 16 <= fileSize) {
        const projMagic = [0x1E,0x54,0x61,0x75,0x64,0x50,0x72,0x4A]
        let ok = true
        for (let i = 0; i < 8; i++) {
            if ((sys.peek(ptr + projOff + i) & 0xFF) !== projMagic[i]) { ok = false; break }
        }
        if (ok) {
            let p = projOff + 16
            while (p + 8 <= fileSize) {
                const fc = String.fromCharCode(
                    sys.peek(ptr + p)   & 0xFF, sys.peek(ptr + p+1) & 0xFF,
                    sys.peek(ptr + p+2) & 0xFF, sys.peek(ptr + p+3) & 0xFF)
                const secLen = _peekU32LE(ptr, p + 4)
                const payload = p + 8
                if (payload + secLen > fileSize) break
                if (fc === 'PNam') {
                    let s = ''
                    for (let k = 0; k < secLen; k++) {
                        const b = sys.peek(ptr + payload + k) & 0xFF
                        if (b === 0) break
                        s += String.fromCharCode(b)
                    }
                    projName = s
                }
                else if (fc === 'INam') { instNames   = decodeNameTable(payload, secLen) }
                else if (fc === 'SNam') { sampleNames = decodeNameTable(payload, secLen) }
                else if (fc === 'sMet') {
                    let q = payload
                    const qEnd = payload + secLen
                    while (q + 5 <= qEnd) {
                        const idx = sys.peek(ptr + q) & 0xFF
                        const subLen = _peekU32LE(ptr, q + 1)
                        const subStart = q + 5
                        if (subStart + subLen > qEnd) break
                        let r = subStart + 4   // skip notation(2)+pri(1)+sec(1)
                        const strs = ['','','']
                        for (let si = 0; si < 3 && r < subStart + subLen; si++) {
                            let s = ''
                            while (r < subStart + subLen) {
                                const b = sys.peek(ptr + r) & 0xFF; r++
                                if (b === 0) break
                                s += String.fromCharCode(b)
                            }
                            strs[si] = s
                        }
                        if (idx === songIndex) {
                            songName = strs[0]
                            composer = strs[1]
                        }
                        q = subStart + subLen
                    }
                }
                p = payload + secLen
            }
        }
    }

    sys.free(ptr)
    return {
        path, songIndex, numSongs, numVoices, numPats,
        bpm, tickRate,
        patterns, cues, lastCue,
        projName, songName, composer,
        instNames, sampleNames
    }
}

const song = parseTaud(filePath, songArg)

// ── Hand the file to the audio adapter ─────────────────────────────────────
// Occupy the first idle playhead rather than always grabbing #0, so launching
// playtaud doesn't cut off music already playing on another playhead. Falls
// back to #0 when all four are busy.
const PLAYHEAD = audio.getFreePlayhead(0)
audio.resetParams(PLAYHEAD)
audio.purgeQueue(PLAYHEAD)
taud.uploadTaudFile(filePath, songArg, PLAYHEAD)

// ── Instrument archetype classification ─────────────────────────────────────
//
// The visualiser needs each instrument to be classified as DRUM / BASS / PAD /
// LEAD / METAL.  We can't run a full FFT in TVDOS JS at startup, but the
// archetype is determined by a small set of proxies that map cleanly off the
// instrument record + a 1024-byte sample probe:
//
//   - sampleLength < 4 KiB and not looped       → DRUM (one-shot percussion)
//   - looped + low natural pitch                → BASS
//   - looped + slow attack envelope             → PAD
//   - high zero-crossing rate                   → METAL (bright / FM-like)
//   - everything else                           → LEAD
//
// Empty instrument slots (samplePtr == 0 and sampleLength == 0) are skipped.

const SND_BASE = audio.getBaseAddr()
const SND_MEM  = audio.getMemAddr()
const INST_REC_SIZE = 256
const INST_BASE_OFF = 720896         // peripheral mem offset of instrument bin

function readInstByte(slot, byteOff) {
    return sys.peek(SND_MEM - (INST_BASE_OFF + slot * INST_REC_SIZE + byteOff)) & 0xFF
}
function readInstU16(slot, byteOff) {
    return readInstByte(slot, byteOff) | (readInstByte(slot, byteOff + 1) << 8)
}
function readInstU32(slot, byteOff) {
    return readInstByte(slot, byteOff)              |
           (readInstByte(slot, byteOff + 1) <<  8)  |
           (readInstByte(slot, byteOff + 2) << 16)  |
           (readInstByte(slot, byteOff + 3) * 0x1000000)
}

const SAMPLE_BANK_SIZE = 524288

function probeSample(samplePtr, sampleLen) {
    // Read up to PROBE_LEN bytes starting at samplePtr inside the 8 MB pool,
    // bank-switching the visible window as needed.  Returns {zcr, rms} where
    // zcr ∈ [0,1] is the fraction of adjacent samples that change sign.
    const PROBE_LEN = Math.min(sampleLen, 1024)
    if (PROBE_LEN < 2) return { zcr: 0, rms: 0 }

    const savedBank = audio.getSampleBank()

    let prevSign = 0
    let crosses = 0
    let sumSq = 0
    let lastBank = -1
    for (let i = 0; i < PROBE_LEN; i++) {
        const abs = samplePtr + i
        const bank = (abs / SAMPLE_BANK_SIZE) | 0
        const winOff = abs - bank * SAMPLE_BANK_SIZE
        if (bank !== lastBank) {
            audio.setSampleBank(bank)
            lastBank = bank
        }
        const b = sys.peek(SND_MEM - winOff) & 0xFF
        const s = b - 128
        sumSq += s * s
        const sign = s >= 0 ? 1 : -1
        if (i > 0 && sign !== prevSign) crosses++
        prevSign = sign
    }
    if (savedBank !== null && savedBank !== undefined && savedBank !== lastBank)
        audio.setSampleBank(savedBank)
    const zcr = crosses / (PROBE_LEN - 1)
    const rms = Math.sqrt(sumSq / PROBE_LEN) / 128
    return { zcr, rms }
}

// Keyword priors over instrument / sample names.  Tested first because a name
// like "Kick 808" should override the acoustic heuristic (a looped clean kick
// sample reads like BASS to the spectral probe but is unambiguously percussion
// to a human).  Order matters: drum and metal beat bass / lead so compound
// names like "kick bass" or "metal pad" are classified by the more specific
// keyword.  All matches are substring tests against the lower-cased
// concatenation of instrument name + sample name.
const NAME_RULES = [
    { arch: ARCH_DRUM, words: [
        'kick','snare','hat','drum','perc','clap','cymb','tom','ride',
        'crash','rim','clave','cowbell','shaker','tamb','conga','bongo',
        'snr','kik','bdrum','sdrum','kit','break','909','707','606',
        ' bd',' sd',' hh',' bd1',' bd2',' sd1',' sd2',' sn',' tst',' tsk'
    ]},
    { arch: ARCH_METAL, words: [
        'metal','ring mod','ringmod','noise','glass','chime','clang',
        'sweep','riser','blip','zap','laser','bitcrush','crush','fm ','xwav'
    ]},
    { arch: ARCH_BASS, words: [
        'bass','sub','808','b-line','bassline','b.s.'
    ]},
    { arch: ARCH_PAD, words: [
        'pad','string','choir','atmo','ambient','warm','wash','organ',
        'vox','vocal',' voc','ahh','ohh','strg','aero',' wind','rhodes'
    ]},
    { arch: ARCH_LEAD, words: [
        'lead','solo','saw','pulse','synth','piano',' pno','guitar',
        ' gtr','horn','brass',' sax','trumpet','flute','pluck','melody',
        'square','triangle'
    ]}
]

function classifyByName(nameStr) {
    if (!nameStr) return null
    // Pad with leading space so " bd" / " gtr" word-edge matchers fire when
    // the abbreviation starts the name.
    const t = ' ' + nameStr.toLowerCase() + ' '
    for (let i = 0; i < NAME_RULES.length; i++) {
        const rule = NAME_RULES[i]
        for (let j = 0; j < rule.words.length; j++) {
            if (t.indexOf(rule.words[j]) >= 0) return rule.arch
        }
    }
    return null
}

function classifyByAcoustic(slot, samplePtr, sampleLen, c4Rate) {
    const flags    = readInstByte(slot, 14)
    const loopMode = flags & 0x03      // 0 = no loop, 1 = forward, 2 = pingpong, 3 = oneshot
    const looped   = (loopMode === 1 || loopMode === 2)

    // Walk the volume envelope.  Each point: u16 value (low byte 0..63) +
    // u16 offset (only low byte's minifloat used for timing).  Coarse attack
    // estimate = number of envelope nodes before the peak.
    let peakVal = 0, peakIdx = 0
    for (let i = 0; i < 25; i++) {
        const v = readInstByte(slot, 21 + i * 2) & 0x3F
        if (v > peakVal) { peakVal = v; peakIdx = i }
    }
    const attackSlow = peakIdx >= 3
    const attackFast = peakIdx === 0

    const { zcr, rms } = probeSample(samplePtr, sampleLen)

    if (sampleLen < 4096 && !looped) return ARCH_DRUM
    if (zcr > 0.30 && rms > 0.10) return ARCH_METAL
    if (c4Rate > 0 && c4Rate < 4000 && rms > 0.05) return ARCH_BASS
    if (looped && attackSlow) return ARCH_PAD
    if (looped && attackFast && peakVal >= 40) return ARCH_LEAD
    if (!looped && sampleLen >= 4096) return ARCH_LEAD
    return ARCH_LEAD
}

function classifyInstrument(slot) {
    const samplePtr = readInstU32(slot, 0)
    const sampleLen = readInstU16(slot, 4)
    const c4Rate    = readInstU16(slot, 6)
    if (sampleLen === 0) return null   // empty slot

    // Name-based prior first — a kick called "Kick" is a kick even if its
    // envelope/spectrum could read as something else.  Falls back to the
    // acoustic heuristic when name has no keyword hits.
    const nameHit = classifyByName(song.instNames[slot] + ' ' + song.sampleNames[slot])
    if (nameHit !== null) return nameHit

    return classifyByAcoustic(slot, samplePtr, sampleLen, c4Rate)
}

const archByInst = new Uint8Array(256)    // 0 = drum by default; we mask with a presence array
const instPresent = new Uint8Array(256)
for (let slot = 1; slot < 256; slot++) {
    const arch = classifyInstrument(slot)
    if (arch !== null) {
        archByInst[slot] = arch
        instPresent[slot] = 1
    }
}
audio.setSampleBank(0)   // restore the bank window to bank 0 after probing

// ── Console setup ───────────────────────────────────────────────────────────
con.curs_set(0)
con.clear()

function mvprn(row, col, ch) { con.mvaddch(row, col, ch) }
function mvtext(row, col, s) { con.move(row, col); print(s) }
function colour(fg, bg) { con.color_pair(fg, bg) }

// Box-drawing constants (CP437).
const BX_TL = 0xC9, BX_TR = 0xBB, BX_BL = 0xC8, BX_BR = 0xBC    // ╔ ╗ ╚ ╝
const BX_V  = 0xBA, BX_H  = 0xCD                                // ║ ═
const SEP_L = 0xC7, SEP_R = 0xB6                                // ╟ ╢ — T into double-bar side, single dashes between

function drawSeparator(row, label) {
    // ╟── LABEL ─── ... ─╢ across the full width.  Side T-pieces overwrite the
    // ║ side bars at columns 1 / COLS on the separator row.
    colour(COL_BORDER, COL_BG)
    mvprn(row, 1, SEP_L)
    for (let x = 2; x < COLS; x++) mvprn(row, x, BX_H)
    mvprn(row, COLS, SEP_R)
    if (label) {
        colour(COL_LABEL, COL_BG)
        mvtext(row, 5, ' ' + label + ' ')
    }
}

function drawFrame() {
    colour(COL_BORDER, COL_BG)
    // Top border with embedded "TAUD" label.
    mvprn(ROW_TOP_BORDER, 1, BX_TL)
    for (let x = 2; x < COLS; x++) mvprn(ROW_TOP_BORDER, x, BX_H)
    mvprn(ROW_TOP_BORDER, COLS, BX_TR)
    colour(COL_LABEL, COL_BG)
    mvtext(ROW_TOP_BORDER, 4, ' TAUD ')
    colour(COL_DIM, COL_BG)

    // Bottom border + exit hint.
    colour(COL_BORDER, COL_BG)
    mvprn(ROW_BOT_BORDER, 1, BX_BL)
    for (let x = 2; x < COLS; x++) mvprn(ROW_BOT_BORDER, x, BX_H)
    mvprn(ROW_BOT_BORDER, COLS, BX_BR)
    colour(COL_DIM, COL_BG)
    mvtext(ROW_BOT_BORDER, 4, ' Hold BkSp to exit ')

    // Side bars.
    colour(COL_BORDER, COL_BG)
    for (let r = 2; r < ROWS; r++) {
        mvprn(r, 1, BX_V)
        mvprn(r, COLS, BX_V)
    }

    // Internal separators.  No DRUMS separator — the percussion strip sits
    // flush against the pitch canvas bottom (drums are visually distinct via
    // their scatter glyphs and need no chrome to be readable).
    drawSeparator(ROW_ORDER_SEP,  "ORDER")
    drawSeparator(ROW_TONAL_SEP,  "VISUALS")
}

function clearInside(row) {
    colour(COL_DIM, COL_BG)
    con.move(row, COL_INSIDE_L)
    print(' '.repeat(LANE_W))
}

function drawTitle() {
    clearInside(ROW_TITLE)
    let title = song.songName || (song.projName || song.path.split('/').pop())
    if (title.length > 60) title = title.substring(0, 57) + '...'
    colour(COL_TITLE, COL_BG)
    mvtext(ROW_TITLE, COL_INSIDE_L + 1, title)
    if (song.composer) {
        const composerStr = 'by ' + song.composer
        const x = COL_INSIDE_R - composerStr.length
        if (x > COL_INSIDE_L + title.length + 2) {
            colour(COL_DIM, COL_BG)
            mvtext(ROW_TITLE, x, composerStr)
        }
    }
}

function pad(n, w) {
    let s = '' + n
    while (s.length < w) s = ' ' + s
    return s
}

let lastStatus = ''
function drawStatus(curCue) {
    const bpm  = audio.getBPM(PLAYHEAD) || song.bpm
    const tick = audio.getTickRate(PLAYHEAD) || song.tickRate
    const cueStr = pad(curCue, 3) + '/' + pad(song.lastCue, 3)
    const s = 'BPM ' + pad(bpm,3) + '  Tick ' + pad(tick,2) +
              '  Voices ' + pad(song.numVoices,2) + '  Cue ' + cueStr
    if (s === lastStatus) return
    lastStatus = s
    clearInside(ROW_STATUS)
    colour(COL_VALUE, COL_BG)
    mvtext(ROW_STATUS, COL_INSIDE_L + 1, s)

    // Progress dashes on the right side of the status row.
    const total = song.lastCue + 1
    const frac = total > 1 ? curCue / (total - 1) : 0
    const barW = 22
    const bx0 = COL_INSIDE_R - barW
    colour(COL_DIM, COL_BG)
    for (let i = 0; i < barW; i++) {
        const filled = i < Math.round(frac * barW)
        colour(filled ? COL_ORDER_CUR : COL_DIM, COL_BG)
        mvprn(ROW_STATUS, bx0 + i, filled ? 0x7C /*│*/ : 0x2E /*.*/)
    }
}

// ── Order strip ─────────────────────────────────────────────────────────────
// Each cue gets one column.  When the song is short enough to fit (≤ LANE_W
// cues), we show the lot; otherwise we centre a window around the current cue
// so it never moves off-screen.
let orderState = { lastCue: -2, lastLeft: -1 }
function drawOrderStrip(curCue) {
    const total = song.lastCue + 1
    let left = 0
    if (total <= LANE_W) {
        left = 0
    } else {
        // Centre window on curCue.
        left = curCue - (LANE_W >> 1)
        if (left < 0) left = 0
        if (left + LANE_W > total) left = total - LANE_W
    }
    if (curCue === orderState.lastCue && left === orderState.lastLeft) return
    orderState.lastCue = curCue
    orderState.lastLeft = left

    clearInside(ROW_ORDER)
    for (let i = 0; i < LANE_W; i++) {
        const c = left + i
        if (c >= total) break
        const cue = song.cues[c]
        let ch = 0x7C       // │   default future
        let fg = COL_ORDER_FUT
        if (c < curCue) { ch = 0xB3 /*│*/; fg = COL_ORDER_PAST }
        else if (c === curCue) { ch = 0xDB /*█*/; fg = COL_ORDER_CUR }
        if (cue.i30 === CUE_HALT) {
            ch = 0xD8 /*Ø*/   // halt marker
            fg = COL_ORDER_HALT
        } else if ((cue.i30 & 0xF0) === CUE_JMP) {
            ch = 0xAA /*ª*/   // jump
        } else if ((cue.i30 & 0xF0) === CUE_BAK || (cue.i30 & 0xF0) === CUE_FWD) {
            ch = 0xF7 /*≈ ish*/
        }
        colour(fg, COL_BG)
        mvprn(ROW_ORDER, COL_INSIDE_L + i, ch)
    }
}

// ── Event-driven visualiser ─────────────────────────────────────────────────
//
// One event slot per tracker voice.  A real note (≥ 0x0020) on a row creates a
// new event in that voice's slot (replacing whatever was there).  The event
// then lives as long as the engine reports the voice as active — so a long
// sustained pad persists while its envelope holds, a short percussion sample
// dies as soon as its volume envelope hits zero, and a retrigger immediately
// replaces the old event with a fresh one.
//
// Per render frame we sample the live state (volume / pan / noteVal), update
// each event's `peakVol`, and derive a stage:
//   - ATTACK   : ageFrames < 3              → bolder glyphs, brightest colour
//   - SUSTAIN  : volFrac > 0.6              → standard glyphs, mid colour
//   - RELEASE  : volFrac ≤ 0.6              → lighter glyphs, dim colour
//
// volFrac = liveVol / peakVol — i.e. how loud the voice is *relative to its
// own attack peak*, which decouples brightness from per-instrument loudness
// differences and turns the colour ramp into a faithful envelope tracer.

const STAGE_ATTACK  = 0
const STAGE_SUSTAIN = 1
const STAGE_RELEASE = 2
const ATTACK_FRAMES = 3
const SUSTAIN_VOL_FLOOR = 0.6

const events = new Array(NUM_VOICES)
for (let v = 0; v < NUM_VOICES; v++) events[v] = null

function noteValToLanePitchY(note, top, bot) {
    // 4096-TET notes are already log-scaled (256 units = 1 semitone, 4096 =
    // 1 octave).  We clamp to PITCH_RANGE_LO..PITCH_RANGE_HI and divide the
    // canvas evenly so each row is ~1/3 of an octave (with 18 rows over 7
    // octaves) — high notes at the top, low at the bottom.
    const laneH = bot - top + 1
    const n = Math.max(PITCH_RANGE_LO, Math.min(PITCH_RANGE_HI, note))
    const norm = (n - PITCH_RANGE_LO) / (PITCH_RANGE_HI - PITCH_RANGE_LO)
    let pos = Math.floor(norm * laneH)
    if (pos < 0) pos = 0
    if (pos > laneH - 1) pos = laneH - 1
    return bot - pos
}

function panToCol(pan) {
    // pan 0..255 → COL_INSIDE_L+1 .. COL_INSIDE_R-1
    const inner = LANE_W - 2
    let x = COL_INSIDE_L + 1 + Math.round((pan / 255) * inner)
    if (x < COL_INSIDE_L + 1) x = COL_INSIDE_L + 1
    if (x > COL_INSIDE_R - 1) x = COL_INSIDE_R - 1
    return x
}

// Per-voice last-row state, so we only spawn an event on transitions.
const voiceLastNote = new Int32Array(NUM_VOICES)
const voiceLastInst = new Uint8Array(NUM_VOICES)
for (let v = 0; v < NUM_VOICES; v++) { voiceLastNote[v] = -1 }

let lastSeenCue = -1
let lastSeenRow = -1

function spawnEventsForRow(cueIdx, rowIdx) {
    const cue = song.cues[cueIdx]
    if (!cue) return
    for (let v = 0; v < song.numVoices; v++) {
        const patIdx = cue.ptns[v]
        if (patIdx === CUE_EMPTY) { voiceLastNote[v] = -1; continue }
        if (patIdx >= song.numPats) continue
        const pat = song.patterns[patIdx]
        if (!pat) continue
        const off = rowIdx * 8
        const note = pat[off] | (pat[off + 1] << 8)
        const inst = pat[off + 2]
        const panB = pat[off + 4]
        const panSel = (panB >> 6) & 3
        const panVal = panB & 0x3F
        // Only real notes (≥ 0x0020) trigger events.
        if (note < 0x0020) continue
        // Resolve the effective instrument: if the cell carries inst=0, reuse
        // the previous instrument bound to this voice.
        const effInst = inst !== 0 ? inst : voiceLastInst[v]
        if (effInst === 0) continue
        const arch = archByInst[effInst]
        let pan = 128
        if (panSel === 0) pan = (panVal / 63 * 255) | 0
        const livePan = audio.getVoiceEffectivePan(PLAYHEAD, v)
        if (typeof livePan === 'number' && livePan !== 128) pan = livePan
        // Replace whatever was in voice v's slot.  peakVol seeds at 0 and is
        // tracked per-frame so the colour ramp normalises by attack peak,
        // not by an arbitrary 0..1 absolute scale.
        events[v] = {
            arch: arch, instrId: effInst, voice: v,
            note: note, pan: pan,
            ageFrames: 0,
            peakVol: 0,
            glyphSeed: (cueIdx * 64 + rowIdx + v * 1280) & 0xFFFF
        }
        voiceLastNote[v] = note
        voiceLastInst[v] = effInst
    }
}

// ── Dynamic matrix background ────────────────────────────────────────────────
//
// Behind the event lanes runs a "terminal matrix" of the raw tracker data,
// re-spelled as pseudo-opcodes and streamed one row's worth at a time in
// lock-step with the playhead's row cadence.  Each tracker cell on the current
// row contributes up to four 7-char tokens (only for the sub-fields it carries):
//
//   NT:nnnn   note            (4-hex noteVal)
//   VO:i.jj   volume column   (i = selector 0..3, jj = 2-digit value 00..63)
//   PN:k.ll   pan column      (k = selector 0..3, ll = 2-digit value 00..63)
//   Fs:eeee   effect          (s = base-36 opcode symbol, eeee = 4-hex argument)
//
// Tokens flow left-to-right and wrap at the canvas edge; when the print head
// runs off the bottom the whole matrix scrolls up one row so the head stays on
// the bottom line — the oldest line rolls off the top, like a terminal.  A cue
// change instead wraps the print head straight back to the top, so each cue
// opens a fresh page over the ageing tail of the last.  Column
// wrapping only ever breaks between a token's three 2-char atoms AA / bb / cc —
// never mid-atom — and a colon that would land at a line edge is dropped, so a
// line never starts or ends with ':' (it may start with a single separator
// space).  Each freshly printed cell is brightest and decays one palette step
// per row, trailing a comet tail behind the head.
const BG_TOP   = ROW_TONAL_TOP          // matrix shares the whole visuals canvas
const BG_BOT   = ROW_DRUMS_BOT
const BG_ROWS  = BG_BOT - BG_TOP + 1
const BG_L     = COL_INSIDE_L
const BG_COLS  = LANE_W
const BG_BLANK = ' '.repeat(BG_COLS)

// Palette runs dim → bright per the spec; fresh text takes the bright end.
const BG_PALETTE = [244,243,242,241]  // index 0 = freshest .. last = oldest
const BG_LIFE    = 32 // rows a cell stays lit before going dark

const bgChar = new Uint8Array(BG_ROWS * BG_COLS)
const bgLvl  = new Int8Array(BG_ROWS * BG_COLS)   // 0 = dark, BG_LIFE = freshest
const bgDith = new Uint8Array(BG_ROWS * BG_COLS)  // per-cell ordered-dither threshold 0..15

// Ordered colour dithering.  Each opcode atom (the AA / bb / cc of an "AA:bbcc"
// token) is stamped with ONE 4×4 Bayer threshold taken from its start cell, so
// the atom dithers as a coherent unit while neighbouring atoms differ — this
// stipples the otherwise-flat palette bands of the ageing tail into a smooth
// gradient.  The threshold biases the floor() that picks between the two palette
// entries bracketing a cell's fractional colour index.
const BG_BAYER = [
     0,  8,  2, 10,
    12,  4, 14,  6,
     3, 11,  1,  9,
    15,  7, 13,  5
]
const BG_DITHER_N = 16
function bgBayerAt(gr, gc) { return BG_BAYER[(gr & 3) * 4 + (gc & 3)] }

// BG_PALETTE[0] is reserved for the freshest row — the cells appended this very
// row (lvl == BG_LIFE) — no matter how large BG_LIFE is.  Its continuous index
// is pinned to exactly 0, which no dither bias can lift, so it stays solid.
// Ageing levels carry a *fractional* palette index in [1, BG_LAST]; the dither
// resolves that fraction into a spatial mix of the two bracketing entries.
const BG_LAST = BG_PALETTE.length - 1
const bgContLut = new Float32Array(BG_LIFE + 1)
bgContLut[BG_LIFE] = 0
for (let lvl = 1; lvl < BG_LIFE; lvl++) {
    const span = BG_LIFE - 2                  // ageing steps between the endpoints
    const age  = (BG_LIFE - 1) - lvl          // 0 = freshest aged .. span = oldest
    const t    = span > 0 ? age / span : 0
    let f = 1 + t * (BG_LAST - 1)             // continuous index in [1, BG_LAST]
    if (f > BG_LAST) f = BG_LAST
    if (f < 1) f = 1
    bgContLut[lvl] = f
}

let bgHeadR = 0, bgHeadC = 0

// Scroll the whole matrix up one row: every row inherits the one below it, the
// top line rolls off, and the freed bottom line is cleared.  Levels and dither
// travel with their cells, so the comet tail stays intact and the decay reads
// as a continuous upward drift rather than a wrap-around jump.
function bgScrollUp() {
    bgChar.copyWithin(0, BG_COLS)
    bgLvl.copyWithin(0, BG_COLS)
    bgDith.copyWithin(0, BG_COLS)
    const last = (BG_ROWS - 1) * BG_COLS
    bgChar.fill(0, last)
    bgLvl.fill(0, last)
    bgDith.fill(0, last)
}

function bgNewline() {
    if (bgHeadR + 1 >= BG_ROWS) bgScrollUp()   // at the bottom: scroll instead of wrapping to the top
    else bgHeadR++
    bgHeadC = 0
}

function bgPut(code) {                   // single glue char; caller guarantees room
    const idx = bgHeadR * BG_COLS + bgHeadC
    bgChar[idx] = code; bgLvl[idx] = BG_LIFE; bgDith[idx] = bgBayerAt(bgHeadR, bgHeadC)
    bgHeadC++
}

function bgPutAtom(c0, c1) {             // 2-char atom; wraps as a unit, dithers as a unit
    if (bgHeadC + 2 > BG_COLS) bgNewline()
    const base = bgHeadR * BG_COLS
    const d = bgBayerAt(bgHeadR, bgHeadC)   // one threshold for the whole atom
    bgChar[base + bgHeadC] = c0; bgLvl[base + bgHeadC] = BG_LIFE; bgDith[base + bgHeadC] = d; bgHeadC++
    bgChar[base + bgHeadC] = c1; bgLvl[base + bgHeadC] = BG_LIFE; bgDith[base + bgHeadC] = d; bgHeadC++
}

// Lay out one "AA:bbcc" token (prefix2 = 2 chars, val4 = 4 chars) with the
// break rules above.
function bgEmitToken(prefix2, val4) {
    if (bgHeadC > 0) {                   // separator space between tokens
        if (bgHeadC + 3 > BG_COLS) bgNewline()   // ...carried to the next line if needed
        bgPut(0x20)
    }
    bgPutAtom(prefix2.charCodeAt(0), prefix2.charCodeAt(1))   // AA
    if (bgHeadC + 3 <= BG_COLS) {        // colon + bb both fit on this line
        bgPut(0x3A)                      // ':'
        bgPutAtom(val4.charCodeAt(0), val4.charCodeAt(1))     // bb
    } else {                             // drop the colon, bb opens the next line
        bgNewline()
        bgPutAtom(val4.charCodeAt(0), val4.charCodeAt(1))     // bb
    }
    bgPutAtom(val4.charCodeAt(2), val4.charCodeAt(3))         // cc (may wrap)
}

// Advance the matrix by one tracker row: decay every lit cell one step, then
// stream the pseudo-opcodes for whatever the row's cells carry.  Within a cue
// the head marches down and the matrix scrolls under it (see bgNewline); a cue
// change wraps the head back to the top to open a fresh page.
function bgAdvanceRow(cueIdx, rowIdx, cueChanged) {
    for (let i = 0; i < bgLvl.length; i++) {
        if (bgLvl[i] > 0) bgLvl[i]--
    }
    if (cueChanged) { bgHeadR = 0; bgHeadC = 0 }
    const cue = song.cues[cueIdx]
    if (!cue) return
    const off = rowIdx * 8
    for (let v = 0; v < song.numVoices; v++) {
        const patIdx = cue.ptns[v]
        if (patIdx === CUE_EMPTY || patIdx >= song.numPats) continue
        const pat = song.patterns[patIdx]
        if (!pat) continue
        const note   = pat[off] | (pat[off + 1] << 8)
        const voleff = pat[off + 3]
        const paneff = pat[off + 4]
        const effop  = pat[off + 5]
        const effarg = pat[off + 6] | (pat[off + 7] << 8)
        if (note !== 0)
            bgEmitToken('NT', note.toString(16).toUpperCase().padStart(4, '0'))
        if (voleff !== 0 && voleff !== 0xC0)
            bgEmitToken('VO', (voleff >>> 6) + '.' + (voleff & 63).toString(10).padStart(2, '0'))
        if (paneff !== 0 && paneff !== 0xC0)
            bgEmitToken('PN', (paneff >>> 6) + '.' + (paneff & 63).toString(10).padStart(2, '0'))
        if (effop !== 0)
            bgEmitToken('F' + effop.toString(36).toUpperCase()[0],
                        effarg.toString(16).toUpperCase().padStart(4, '0'))
    }
}

// Paint the matrix as the canvas backdrop; the event lanes draw over it.  Each
// strip is blanked in one shot, then its lit cells are overlaid (spaces and dark
// cells skipped), batching colour switches so same-age runs share one call.
function drawBackground() {
    let curFg = -1
    for (let gr = 0; gr < BG_ROWS; gr++) {
        const sr = BG_TOP + gr
        colour(COL_DIM, COL_BG); curFg = COL_DIM
        con.move(sr, BG_L)
        print(BG_BLANK)
        const base = gr * BG_COLS
        for (let gc = 0; gc < BG_COLS; gc++) {
            const lvl = bgLvl[base + gc]
            if (lvl <= 0) continue
            const ch = bgChar[base + gc]
            if (ch === 0x20) continue
            let idx = Math.floor(bgContLut[lvl] + (bgDith[base + gc] + 0.5) / BG_DITHER_N)
            if (idx > BG_LAST) idx = BG_LAST
            if (idx < 0) idx = 0
            const fg = BG_PALETTE[idx]
            if (fg !== curFg) { colour(fg, COL_BG); curFg = fg }
            mvprn(sr, BG_L + gc, ch)
        }
    }
}

function envColour(arch, volFrac) {
    // Brightest entry at volFrac == 1 (envelope peak); dimmest at silence.
    const ramp = COL_ARCH[arch]
    const dim = 1 - Math.max(0, Math.min(1, volFrac))
    let idx = Math.floor(dim * ramp.length)
    if (idx >= ramp.length) idx = ramp.length - 1
    return ramp[idx]
}

function drawEventDrum(ev, stage, volFrac) {
    const lane = LANE_BY_ARCH[ARCH_DRUM]
    const cx = panToCol(ev.pan)
    const laneH = lane.bot - lane.top + 1
    const seed = ev.glyphSeed
    colour(envColour(ARCH_DRUM, volFrac), COL_BG)
    // Radial scatter — three points around centre, deterministic per-frame
    // shuffle off glyphSeed so the eye reads the burst as motion rather than
    // a static cluster.  Number of points contracts in RELEASE.
    const age = ev.ageFrames
    const xs = [
        cx - 2 - ((seed >> age) & 3),
        cx + 1 + ((seed >> (age + 3)) & 3),
        cx +     ((seed >> (age + 6)) & 1) - ((seed >> (age + 8)) & 1)
    ]
    const ys = [
        lane.top + ((seed >> age) & 1),
        lane.bot - ((seed >> (age + 4)) & 1),
        lane.top + ((seed >> (age + 2)) % laneH)
    ]
    const glyphs = stage === STAGE_ATTACK  ? [0x2A,0x2A,0x2A]   // bright * burst
                 : stage === STAGE_SUSTAIN ? [0xF9,0x2A,0x2E]   // · * .
                                           : [0xF9,0x2E,0xF9]   // · . ·  (sparse)
    const points = stage === STAGE_RELEASE ? 2 : 3
    for (let i = 0; i < points; i++) {
        if (xs[i] >= COL_INSIDE_L && xs[i] <= COL_INSIDE_R)
            mvprn(ys[i], xs[i], glyphs[(i + age) % 3])
    }
}

function drawEventBass(ev, stage, volFrac, liveNote) {
    const lane = LANE_BY_ARCH[ARCH_BASS]
    const cx = panToCol(ev.pan)
    colour(envColour(ARCH_BASS, volFrac), COL_BG)
    const note = (liveNote !== null && liveNote > 0) ? liveNote : ev.note
    const y = noteValToLanePitchY(note, lane.top, lane.bot)
    // Slab width tracks the envelope: full block during ATTACK, half-block in
    // SUSTAIN, thin core in RELEASE.  Volume-scaled width carries the visual
    // "weight" of a heavy decaying bass.
    const baseW = stage === STAGE_ATTACK ? 4
                : stage === STAGE_SUSTAIN ? 3
                                          : 2
    const halfW = Math.max(1, Math.floor(baseW * Math.max(volFrac, 0.25)))
    const glyph = stage === STAGE_ATTACK ? 0xDB  /*█*/
                : stage === STAGE_SUSTAIN ? 0xDC /*▄*/
                                          : 0xDF /*▀*/
    for (let dx = -halfW; dx <= halfW; dx++) {
        const x = cx + dx
        if (x >= COL_INSIDE_L && x <= COL_INSIDE_R)
            mvprn(y, x, glyph)
    }
}

function drawEventPad(ev, stage, volFrac, liveNote) {
    const lane = LANE_BY_ARCH[ARCH_PAD]
    const cx = panToCol(ev.pan)
    colour(envColour(ARCH_PAD, volFrac), COL_BG)
    // Fog hugging the pitch row.  Centre weight (▓) tracks the envelope —
    // softens to ▒ then ░ as the pad releases.  Spread grows slowly with age
    // so long sustains don't pile into a single bright spot.
    const note = (liveNote !== null && liveNote > 0) ? liveNote : ev.note
    const y = noteValToLanePitchY(note, lane.top, lane.bot)
    const spread = 1 + Math.min(3, ev.ageFrames >> 3)
    const core = stage === STAGE_ATTACK ? 0xB2 /*▓*/
               : stage === STAGE_SUSTAIN ? 0xB1 /*▒*/
                                         : 0xB0 /*░*/
    const flank = stage === STAGE_RELEASE ? 0xB0 : 0xB1
    const halo  = stage === STAGE_RELEASE ? 0x20 : 0xB0
    const glyphs = [halo, flank, core, flank, halo]
    for (let i = -2; i <= 2; i++) {
        const x = cx + i * spread
        if (x >= COL_INSIDE_L && x <= COL_INSIDE_R)
            mvprn(y, x, glyphs[i + 2])
    }
}

function drawEventLead(ev, stage, volFrac, livePan, liveNote) {
    const lane = LANE_BY_ARCH[ARCH_LEAD]
    // Live pan/note enable the stair-stepped vibrato motion the spec wants.
    const pan = (livePan !== null && livePan !== undefined) ? livePan : ev.pan
    const note = (liveNote !== null && liveNote > 0) ? liveNote : ev.note
    const cx = panToCol(pan)
    colour(envColour(ARCH_LEAD, volFrac), COL_BG)
    const y = noteValToLanePitchY(note, lane.top, lane.bot)
    // Tail length tracks how long the voice has been audible, capped at 8.
    // In ATTACK the tail is empty (just the head); in SUSTAIN it grows out
    // to its full length; in RELEASE it dissolves to dots.
    const tailLen = stage === STAGE_ATTACK ? 0
                  : Math.min(8, Math.floor(ev.ageFrames / 2))
    const trailChar = stage === STAGE_SUSTAIN ? 0xCD /*═*/
                    : stage === STAGE_RELEASE ? 0xF9 /*·*/
                                              : 0xC4 /*─*/
    for (let i = 1; i <= tailLen; i++) {
        const xl = cx - i
        if (xl >= COL_INSIDE_L && xl <= COL_INSIDE_R)
            mvprn(y, xl, trailChar)
        const xr = cx + i
        if (xr >= COL_INSIDE_L && xr <= COL_INSIDE_R)
            mvprn(y, xr, trailChar)
    }
    const head = stage === STAGE_ATTACK ? 0xFE /*■*/
               : stage === STAGE_RELEASE ? 0x09 /*°*/
                                         : 0x6F /*o*/
    mvprn(y, cx, head)
}

function drawEventMetal(ev, stage, volFrac, liveNote) {
    const lane = LANE_BY_ARCH[ARCH_METAL]
    const cx = panToCol(ev.pan)
    const note = (liveNote !== null && liveNote > 0) ? liveNote : ev.note
    colour(envColour(ARCH_METAL, volFrac), COL_BG)
    const yBase = noteValToLanePitchY(note, lane.top, lane.bot)
    // ╱╲╱╲ angular pair, stepping diagonally each frame.  Width contracts in
    // RELEASE so a decaying metallic ping shrinks into a single sharp tick
    // rather than holding its full silhouette to the end.
    const step = ev.ageFrames % 4
    const offs = [0, 1, 0, -1]
    const y = Math.max(lane.top, Math.min(lane.bot, yBase + offs[step]))
    const reach = stage === STAGE_RELEASE ? 1 : 2
    for (let i = -reach; i <= reach; i++) {
        const x = cx + i
        if (x < COL_INSIDE_L || x > COL_INSIDE_R) continue
        mvprn(y, x, ((i + step) & 1) ? 0x2F /*/*/ : 0x5C /*\\*/)
    }
}

function renderEvents() {
    drawBackground()
    for (let v = 0; v < song.numVoices; v++) {
        const ev = events[v]
        if (!ev) continue
        // The engine's `active` flag is the source of truth — set by note-on,
        // cleared by note-cut, sample-end, envelope-end-of-decay, or NNA cut.
        // Once it drops, the voice is genuinely silent so the visual goes too.
        if (!audio.getVoiceActive(PLAYHEAD, v)) { events[v] = null; continue }

        const liveVol  = audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0
        const livePan  = audio.getVoiceEffectivePan(PLAYHEAD, v)
        const liveNote = audio.getVoiceNote(PLAYHEAD, v)

        if (liveVol > ev.peakVol) ev.peakVol = liveVol
        ev.ageFrames++

        // volFrac normalises by attack peak — sustain holds near 1.0,
        // release walks toward 0.  Floor on the denominator avoids division
        // blowups when an event is born and read on the same frame
        // (peakVol == 0 until the first audible sample).
        const denom = ev.peakVol > 0.01 ? ev.peakVol : 0.01
        const volFrac = Math.max(0, Math.min(1, liveVol / denom))

        const stage = ev.ageFrames < ATTACK_FRAMES ? STAGE_ATTACK
                    : volFrac > SUSTAIN_VOL_FLOOR  ? STAGE_SUSTAIN
                                                   : STAGE_RELEASE

        switch (ev.arch) {
            case ARCH_DRUM:  drawEventDrum (ev, stage, volFrac); break
            case ARCH_BASS:  drawEventBass (ev, stage, volFrac, liveNote); break
            case ARCH_PAD:   drawEventPad  (ev, stage, volFrac, liveNote); break
            case ARCH_LEAD:  drawEventLead (ev, stage, volFrac, livePan, liveNote); break
            case ARCH_METAL: drawEventMetal(ev, stage, volFrac, liveNote); break
        }
    }
}

// ── Stereo bar + tick lights ────────────────────────────────────────────────
function drawStereo() {
    // Aggregate per-voice live volume by stereo position into a 76-wide bar.
    const W = LANE_W
    const bins = new Float32Array(W)
    for (let v = 0; v < song.numVoices; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        const vol = Math.pow(audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0, 0.125)
        if (vol <= 0) continue
        const pan = audio.getVoiceEffectivePan(PLAYHEAD, v)
        let col = Math.round((pan / 255) * (W - 1))
        if (col < 0) col = 0
        if (col >= W) col = W - 1
        // Gaussian-ish 7-cell spread so individual voices don't read as single
        // spikes — the eye reads bars best with some neighbouring mass.
        bins[col] += vol
        if (col >= 3) bins[col - 3] += vol * 0.05
        if (col >= 2) bins[col - 2] += vol * 0.3
        if (col >= 1) bins[col - 1] += vol * 0.75
        if (col < W - 1) bins[col + 1] += vol * 0.75
        if (col < W - 2) bins[col + 2] += vol * 0.3
        if (col < W - 3) bins[col + 3] += vol * 0.05
    }
    const stairs = [0x20, 0xB0, 0xB1, 0xB2, 0xDB]   // space ░ ▒ ▓ █
    for (let i = 0; i < W; i++) {
        const v = bins[i]
        let idx = Math.min(stairs.length - 1, Math.floor(v * 1.6))
        if (idx <= 0) idx = 0
        const fg = idx === 0 ? COL_DIM
                 : idx === 1 ? COL_ARCH[ARCH_PAD][3]
                 : idx === 2 ? COL_ARCH[ARCH_PAD][2]
                 : idx === 3 ? COL_ARCH[ARCH_PAD][1]
                             : COL_ARCH[ARCH_PAD][0]
        colour(fg, COL_BG)
        mvprn(ROW_STEREO, COL_INSIDE_L + i, stairs[idx])
    }
}

// Tick indicator: row of lights, one per tick within the current row.
let tickLightsLast = -1
function drawTickLights(tickInRow, tickRate) {
    if (tickInRow === tickLightsLast) return
    tickLightsLast = tickInRow
    clearInside(ROW_TICK)
    const N = Math.min(tickRate, 24)
    colour(COL_DIM, COL_BG)
    mvtext(ROW_TICK, COL_INSIDE_L + 1, 'TICK ')
    for (let i = 0; i < N; i++) {
        const lit = i < tickInRow
        colour(lit ? COL_TICK_LIVE : COL_TICK_DEAD, COL_BG)
        mvprn(ROW_TICK, COL_INSIDE_L + 6 + i * 2, lit ? 0xFE /*■*/ : 0xF9 /*·*/)
    }
    // Voice activity counter on the right.
    let nActive = 0
    for (let v = 0; v < song.numVoices; v++) {
        if (audio.getVoiceActive(PLAYHEAD, v)) nActive++
    }
    colour(COL_DIM, COL_BG)
    const s = 'ACTIVE ' + pad(nActive, 2) + '/' + pad(song.numVoices, 2)
    mvtext(ROW_TICK, COL_INSIDE_R - s.length, s)
}

// ── Initial paint ───────────────────────────────────────────────────────────
drawFrame()
drawTitle()
drawStatus(0)
drawOrderStrip(0)

// ── Playback ────────────────────────────────────────────────────────────────
audio.setCuePosition(PLAYHEAD, 0)
audio.setTrackerRow(PLAYHEAD, 0)
audio.setMasterVolume(PLAYHEAD, 255)
audio.play(PLAYHEAD)

let stopReq = false
let errorlevel = 0
// Track tick boundaries by polling at ~30 Hz.  The Taud engine doesn't expose
// a per-tick counter, so we synthesise one by counting render frames between
// row-changes and scaling against the song's tickRate — this is good enough
// for the tick-light pulse and event ageing, and stays in lock-step with the
// row index since both the renderer and the engine advance off the same wall
// clock.

let ticksPerRow = Math.max(1, song.tickRate)
let synthTick = 0 // tick within current row, 0..ticksPerRow-1
try {
    while (audio.isPlaying(PLAYHEAD) && !stopReq) {
        // Backspace polling (mirrors playtad).
        sys.poke(-40, 1)
        if (sys.peek(-41) === 67) stopReq = true

        const curCue = audio.getCuePosition(PLAYHEAD)
        const curRow = audio.getTrackerRow(PLAYHEAD)
        if (curCue !== lastSeenCue || curRow !== lastSeenRow) {
            // Row boundary — spawn new events, advance the matrix background
            // (scrolls within a cue, wraps to the top on a cue change), reset
            // tick count.
            spawnEventsForRow(curCue, curRow)
            bgAdvanceRow(curCue, curRow, curCue !== lastSeenCue)
            lastSeenCue = curCue
            lastSeenRow = curRow
            synthTick = 0
            // Pull a fresh tickRate read here in case a T effect changed it
            // mid-song.
            ticksPerRow = Math.max(1, audio.getTickRate(PLAYHEAD) || song.tickRate)
        } else {
            // Same row — advance the synthetic tick counter against wall time.
            // Tick period (ms) = (60000 / BPM) / 24 ... but the spec is
            // engine-internal.  We approximate via tickRate frames per row
            // and the row-boundary cadence we last observed.
            synthTick++
            if (synthTick >= ticksPerRow) synthTick = ticksPerRow - 1
        }

        // Event ageing happens inside renderEvents() now — it ticks ageFrames,
        // updates peakVol from the live mixer reading, and retires voices the
        // engine has marked inactive.

        drawStatus(curCue)
        drawOrderStrip(curCue)
        renderEvents()
        drawStereo()
        drawTickLights(synthTick, ticksPerRow)

        sys.sleep((2500 / audio.getBPM(PLAYHEAD))|0) // one visual frame = one tick
    }
}
catch (e) {
    printerrln(e)
    errorlevel = 1
}
finally {
    audio.stop(PLAYHEAD)
    con.move(ROW_BOT_BORDER + 1, 1)
    con.curs_set(1)
}

return errorlevel
