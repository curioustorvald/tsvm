// monplay.js -- Monotone (.mon) test music player.
//
// Reads a MONOTONE module and renders it, on the fly, to the built-in beeper
// (IOSpace MMIO 93..97). Per the brief: all .mon note effects are IGNORED
// except the arpeggio (0xy), and the module's (up to 3) simultaneous voices
// are MULTIPLEXED onto the beeper's hardware arpeggio effect.
//
//   usage: monplay <file.mon>
//
// Format reference: reference_materials/monotone-tracker-parser-lua/ and
// reference_materials/MONOTONE/MTSRC/MT_PLAY.PAS .

// ---------------------------------------------------------------------------
// Beeper hardware (IOSpace). MMIO byte m is reached at JS address -(m+1):
//   93 RO  -> reading uploads the staged command (the strobe)
//   94..97 -> PPPPPPPP / pppppp_QQ / AAAAAAAA / BBBBBBBB
// The square wave is f = (3579545/16) / (2 * divider); divider 0 = silence.
// ---------------------------------------------------------------------------
const BEEP_UPLOAD = -94   // read MMIO 93 to upload
const BEEP_P_HI   = -95   // MMIO 94: PPPPPPPP
const BEEP_P_LO   = -96   // MMIO 95: pppppp_QQ
const BEEP_A      = -97   // MMIO 96: A
const BEEP_B      = -98   // MMIO 97: B

const BEEP_HALFCLOCK = 3579545 / 16 / 2   // f = BEEP_HALFCLOCK / divider
const DIVIDER_MAX = 0x3FFF                 // 14-bit
const A0_HZ = 27.5                         // MONOTONE note index 1 == A0 == 27.5 Hz

// Beeper note effects (QQ field)
const QQ_NONE = 0, QQ_TWO = 2, QQ_THREE = 3

function uploadBeeper(divider, effect, a, b) {
    if (divider < 0) divider = 0
    if (divider > DIVIDER_MAX) divider = DIVIDER_MAX
    sys.poke(BEEP_P_HI, (divider >> 6) & 0xFF)
    sys.poke(BEEP_P_LO, ((divider & 0x3F) << 2) | (effect & 3))
    sys.poke(BEEP_A, a & 0xFF)
    sys.poke(BEEP_B, b & 0xFF)
    sys.peek(BEEP_UPLOAD)   // strobe: commit the staged command
}
function silenceBeeper() { uploadBeeper(0, QQ_NONE, 0, 0) }

// MONOTONE note index (1 = A0) -> beeper frequency divider.
function noteToDivider(note) {
    const hz = A0_HZ * Math.pow(2, (note - 1) / 12)
    let d = Math.round(BEEP_HALFCLOCK / hz)
    if (d < 1) d = 1
    if (d > DIVIDER_MAX) d = DIVIDER_MAX
    return d
}

// Build a beeper command that multiplexes the currently-sounding voices.
//
// The hardware arpeggio plays note0 then note0 minus a (positive) offset, so the
// base divider must be the LARGEST (lowest pitch) and the others are reached by
// subtraction:
//   2 notes -> effect 2, 16-bit delta (always exact)
//   3 notes -> effect 3, two 8-bit deltas (exact only when both deltas <= 255)
// When three widely-spaced notes don't fit effect 3's 8-bit deltas we keep the
// two extremes (bass + melody, correct pitch) via effect 2 rather than play three
// wrong pitches.
function buildCommand(dividers) {
    // de-duplicate, then sort descending (largest divider == lowest pitch first)
    const ds = Array.from(new Set(dividers)).sort((x, y) => y - x)

    if (ds.length === 0) return [0, QQ_NONE, 0, 0]
    if (ds.length === 1) return [ds[0], QQ_NONE, 0, 0]
    if (ds.length === 2) {
        const diff = ds[0] - ds[1]   // >= 0
        return [ds[0], QQ_TWO, diff & 0xFF, (diff >> 8) & 0xFF]
    }

    // >= 3 voices: keep the lowest, a middle, and the highest.
    const lo = ds[0], hi = ds[ds.length - 1], mid = ds[ds.length >> 1]
    const a = lo - mid, b = mid - hi
    if (a <= 0xFF && b <= 0xFF) return [lo, QQ_THREE, a, b]

    // Too wide for effect 3's 8-bit deltas: fall back to bass + melody.
    const diff = lo - hi
    return [lo, QQ_TWO, diff & 0xFF, (diff >> 8) & 0xFF]
}

// ---------------------------------------------------------------------------
// Load and parse the .mon file
// ---------------------------------------------------------------------------
const pathArg = exec_args[1]
if (!pathArg) {
    println("usage: monplay <file.mon>")
    return 1
}

const full = _G.shell.resolvePathInput(pathArg).full
const FILE_LENGTH = files.open(full).size

const seqread = require("seqread")
seqread.prepare(full)
const buf = seqread.readBytes(FILE_LENGTH)
const B = (off) => sys.peek(buf + off) & 255   // byte at file offset

// magic: 0x08 "MONOTONE"
const MAGIC = [0x08, 0x4D, 0x4F, 0x4E, 0x4F, 0x54, 0x4F, 0x4E, 0x45]
if (!MAGIC.every((m, i) => B(i) === m)) {
    println("Not a MONOTONE file: " + full)
    sys.free(buf)
    return 1
}

const SONG_LEN = B(0x5C)   // number of orders (informational)
const VOICES   = B(0x5D)
if (VOICES < 1 || VOICES > 8) {
    println("Bad voice count: " + VOICES)
    sys.free(buf)
    return 1
}

// Order list: 0x5F.. , 0xFF-terminated (max 256 entries).
const orders = []
for (let i = 0; i < 256; i++) {
    const p = B(0x5F + i)
    if (p === 0xFF) break
    orders.push(p)
}

// Pattern data: 64 rows x VOICES x 2 bytes, voice-interleaved, little-endian,
// stored sequentially from 0x15F regardless of the order list.
const PATTERN_ROWS = 0x40
const PATTERN_BASE = 0x15F
const PATTERN_SIZE = PATTERN_ROWS * 2 * VOICES
const cellWord = (pattern, row, voice) => {
    const off = PATTERN_BASE + pattern * PATTERN_SIZE + (row * VOICES + voice) * 2
    return B(off) | (B(off + 1) << 8)
}

// MT_PLAY.PAS: 60 Hz tick, tempo (ticks/row) = max(voices, 4).
const TICK_HZ = 60
const TICK_NANO = 1e9 / TICK_HZ
const TICKS_PER_ROW = Math.max(VOICES, 4)

println(`MONOTONE: ${full}`)
println(`  voices ${VOICES}, orders ${orders.length} (songlen ${SONG_LEN}), ` +
        `${TICKS_PER_ROW} ticks/row @ ${TICK_HZ}Hz`)
println("  (Ctrl+Shift+T+R to stop)")

// ---------------------------------------------------------------------------
// Playback state (per voice)
// ---------------------------------------------------------------------------
const NOTE_OFF = 0x7F
const voiceNote   = new Array(VOICES).fill(0)      // held note (1..0x7E)
const voiceOn     = new Array(VOICES).fill(false)  // is the voice sounding?
const voiceArpX   = new Array(VOICES).fill(0)      // arpeggio 2nd-note offset
const voiceArpY   = new Array(VOICES).fill(0)      // arpeggio 3rd-note offset

// Latch a new row of cells. All effects are ignored except arpeggio (0xy):
// effect type = eff>>6, arpeggio is type 0 with nonzero args x=(eff>>3)&7, y=eff&7.
function applyRow(pattern, row) {
    for (let v = 0; v < VOICES; v++) {
        const w = cellWord(pattern, row, v)
        const note = w >> 9
        const eff = w & 0x1FF

        if (note === NOTE_OFF) voiceOn[v] = false
        else if (note >= 1 && note <= 0x7E) { voiceOn[v] = true; voiceNote[v] = note }
        // note === 0 -> continue holding the previous note

        if (eff !== 0 && (eff >> 6) === 0) { voiceArpX[v] = (eff >> 3) & 7; voiceArpY[v] = eff & 7 }
        else { voiceArpX[v] = 0; voiceArpY[v] = 0 }
    }
}

// A voice's effective note this tick, honouring its arpeggio (base / +x / +y).
function effectiveNote(v, tickInRow) {
    let n = voiceNote[v]
    if (voiceArpX[v] !== 0 || voiceArpY[v] !== 0) {
        const phase = tickInRow % 3
        if (phase === 1) n += voiceArpX[v]
        else if (phase === 2) n += voiceArpY[v]
    }
    return n
}

const stopRequested = () => (sys.peek(-49) & 1) !== 0   // MMIO 48 bit0 = SIGTERM

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
let nextTick = sys.nanoTime()
try {
    let o = 0
    while (o < orders.length) {
        const pattern = orders[o]
        for (let row = 0; row < PATTERN_ROWS; row++) {
            applyRow(pattern, row)
            for (let t = 0; t < TICKS_PER_ROW; t++) {
                if (stopRequested()) return 0

                const dividers = []
                for (let v = 0; v < VOICES; v++) {
                    if (voiceOn[v] && voiceNote[v] >= 1) dividers.push(noteToDivider(effectiveNote(v, t)))
                }
                const cmd = buildCommand(dividers)
                uploadBeeper(cmd[0], cmd[1], cmd[2], cmd[3])

                nextTick += TICK_NANO
                const waitMs = (nextTick - sys.nanoTime()) / 1e6
                if (waitMs >= 1) sys.sleep(Math.floor(waitMs))
            }
        }
        o++
    }
}
finally {
    silenceBeeper()
    sys.free(buf)
}

return 0
