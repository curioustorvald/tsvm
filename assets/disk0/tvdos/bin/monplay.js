// monplay.js -- Monotone (.mon) music player for the built-in beeper.
//
// Reads a MONOTONE module and renders it, on the fly, to the beeper
// (IOSpace MMIO 93..97). All eight Monotone note effects are supported.
// The module's simultaneous voices are multiplexed onto the beeper's
// hardware arpeggio; when the notes fall outside what the hardware
// arpeggiator can express, the multiplex is done in software instead.
//
//   usage: monplay <file.mon>     (Ctrl+Shift+T+R or the Stop key to stop)
//
// Engine ported from reference_materials/MONOTONE/MTSRC/MT_PLAY.PAS;
// format from reference_materials/monotone-tracker-parser-lua/ .

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

const BEEP_HALFCLOCK = (3579545.4545454545 / 16.0) / 2   // f = BEEP_HALFCLOCK / divider
const DIVIDER_MAX = 0x3FFF                 // 14-bit

const QQ_NONE = 0, QQ_TWO = 2, QQ_THREE = 3   // beeper note-effect (QQ field)

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

// Hz -> beeper frequency divider.
function freqToDivider(hz) {
    if (hz <= 0) return 0
    let d = Math.round(BEEP_HALFCLOCK / hz)
    if (d < 1) d = 1
    if (d > DIVIDER_MAX) d = DIVIDER_MAX
    return d
}

// ---------------------------------------------------------------------------
// MONOTONE pitch tables (MT_PLAY.PAS constants)
// ---------------------------------------------------------------------------
const IBO = 12                 // intervals between octaves (semitones)
const IBN = 8                  // sub-intervals between notes (for vibrato/porta)
const MAX_NOTE = 100           // 3 + numOctaves(8)*12 + 1
const MAX_INTERVAL = MAX_NOTE * IBN
const NOTE_OFF = 127           // noteEnd
const MIN_HZ = 20              // slide-down floor (20 + MTV1MinParmxx)
const MAX_HZ = 65472           // slide-up ceiling (65535 - MTV1MaxParmxx)
const VIB_SIZE = 32            // MTV1VibTableSize
const VIB_DEPTH = 64           // MTV1VibTableDepth = IBN*(MTV1MaxParmxy+1)

// notesHz[interval] -- the exact integer-Hz table MT_PLAY.PAS builds (A0 == 27.5 Hz
// at interval IBN), so slides/porta operate on the same rounded Hz values.
const NOTESHZ = (() => {
    const t = new Array(MAX_INTERVAL + 1)
    const mult = Math.pow(2, 1 / (IBO * IBN))   // 2^(1/96)
    t[0] = 440
    let hz = 27.5; t[IBN] = Math.round(hz)
    for (let i = IBN - 1; i >= 1; i--) { hz /= mult; if (hz < 19) hz = 19; t[i] = Math.round(hz) }
    hz = 27.5; t[IBN] = Math.round(hz)
    for (let i = IBN + 1; i <= MAX_INTERVAL; i++) { hz *= mult; t[i] = Math.round(hz) }
    return t
})()

// 32-entry signed sine, amplitude VIB_DEPTH, one full cycle (sinPeriod == 1).
const VIBTABLE = (() => {
    const v = new Array(VIB_SIZE)
    for (let b = 0; b < VIB_SIZE; b++) v[b] = Math.round(VIB_DEPTH * Math.sin(b * Math.PI / VIB_SIZE * 2))
    return v
})()

const clampInterval = (i) => (i < 0) ? 0 : (i > MAX_INTERVAL) ? MAX_INTERVAL : i
const noteHz = (note) => NOTESHZ[clampInterval(note * IBN)]
const intervalHz = (interval) => NOTESHZ[clampInterval(interval)]

// ---------------------------------------------------------------------------
// Voice multiplexing
//
// The hardware arpeggio plays note0 then note0 minus a positive offset, so the
// base divider must be the LARGEST (lowest pitch) and the others are reached by
// subtraction. Returns either a single hardware command {sw:false, cmd:[...]}
// or, when the notes don't fit, a software-arpeggio plan {sw:true, dividers:[...]}.
//   1 note  -> effect 0
//   2 notes -> effect 2 (16-bit delta: always expressible)
//   3 notes -> effect 3 (two 8-bit deltas: only when both <= 255)
//   otherwise (3 wide / 4+ voices) -> software arpeggio over ALL the notes
// ---------------------------------------------------------------------------
function planMultiplex(dividers) {
    const ds = Array.from(new Set(dividers)).sort((x, y) => y - x)   // descending

    if (ds.length === 0) return { sw: false, cmd: [0, QQ_NONE, 0, 0] }
    if (ds.length === 1) return { sw: false, cmd: [ds[0], QQ_NONE, 0, 0] }
    if (ds.length === 2) {
        const diff = ds[0] - ds[1]
        return { sw: false, cmd: [ds[0], QQ_TWO, diff & 0xFF, (diff >> 8) & 0xFF] }
    }
    if (ds.length === 3) {
        const a = ds[0] - ds[1], b = ds[1] - ds[2]
        if (a <= 0xFF && b <= 0xFF) return { sw: false, cmd: [ds[0], QQ_THREE, a, b] }
    }
    return { sw: true, dividers: ds }   // out of hardware range -> software
}

// ---------------------------------------------------------------------------
// Human-readable trace (one beeper command per tick)
// ---------------------------------------------------------------------------
const NOTE_NAMES = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"]
function freqToNote(hz) {
    if (hz <= 0) return "---"
    const n = Math.round(12 * Math.log2(hz / 27.5))   // semitones above A0 (27.5 Hz)
    return NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor((n + 9) / 12)
}
const fmtNote = (div) => {
    // const hz = (div > 0) ? Math.round(BEEP_HALFCLOCK / div) : 0
    // return `${freqToNote(hz)}(${hz}Hz)`
    return ' ' + (''+div).padStart(5) + ' '
}

// The notes a (hardware) beeper command actually cycles through.
function playedDividers(div, effect, a, b) {
    if (div === 0) return []
    if (effect === QQ_TWO) return [div, div - ((b << 8) | a)]
    if (effect === QQ_THREE) return [div, div - a, div - a - b]
    return [div]
}

// One human-readable line for the command uploaded this tick. swInfo, when set,
// describes the software-arpeggio rotation: {idx, n, all:[dividers]}.
function describeCommand(cmd, swInfo) {
    const div = cmd[0], eff = cmd[1], a = cmd[2], b = cmd[3]
    if (swInfo) {
        const notes = swInfo.all.map((d, i) => (i === swInfo.idx) ? `[${fmtNote(d).substring(1,6)}]` : fmtNote(d)).join(" ")
        return `sw${swInfo.idx + 1}/${swInfo.n}`.padEnd(6) + " " + notes
    }
    if (div === 0) return "silent"
    const label = (eff === QQ_THREE) ? "arp3" : (eff === QQ_TWO) ? "arp2" : "tone"
    return label.padEnd(6) + " " + playedDividers(div, eff, a, b).map(fmtNote).join(" ")
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
if (VOICES < 1 || VOICES > 12) {
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

// MT_PLAY.PAS: 60 Hz tick, default tempo (ticks/row) = max(voices, 4).
const TICK_HZ = 60
const TICK_NANO = 1e9 / TICK_HZ
const DEFAULT_TEMPO = Math.max(VOICES, 4)

println(`MONOTONE: ${full}`)
println(`  voices ${VOICES}, orders ${orders.length} (songlen ${SONG_LEN}), ` +
        `${DEFAULT_TEMPO} ticks/row @ ${TICK_HZ}Hz`)
println("  (Hold backspace to stop)")
println("  tick    pos          beeper command (one tick per line)")

// ---------------------------------------------------------------------------
// Per-voice playback state
// ---------------------------------------------------------------------------
const voiceOn      = new Array(VOICES).fill(false)  // is the voice sounding?
const voiceNote    = new Array(VOICES).fill(0)      // held note index (1..MAX_NOTE)
const voiceFreq    = new Array(VOICES).fill(0)      // current frequency (integer Hz)
const voiceEff     = new Array(VOICES).fill(0)      // effect type 0..7
const voiceP1      = new Array(VOICES).fill(0)      // first effect arg
const voiceP2      = new Array(VOICES).fill(0)      // second effect arg (two-arg effects)
const portaTarget  = new Array(VOICES).fill(0)      // 3xx: frequency to slide toward
const portaDelta   = new Array(VOICES).fill(0)      // 3xx: Hz per tick
const vibSpeed     = new Array(VOICES).fill(0)      // 4xy: oscillation speed
const vibDepth     = new Array(VOICES).fill(0)      // 4xy: depth (intervals)
const vibIndex     = new Array(VOICES).fill(0)      // 4xy: vibrato table position

// Effect indices (eff>>6): 0=Arp 1=SlideUp 2=SlideDown 3=Porta 4=Vibrato
//                          5=PosJump(B) 6=PatBreak(D) 7=SetSpeed(F)
const EFF_ARP = 0, EFF_UP = 1, EFF_DOWN = 2, EFF_PORTA = 3, EFF_VIB = 4
const EFF_JUMP = 5, EFF_BREAK = 6, EFF_SPEED = 7

// Latch a new row of cells (the "tick 0" pass). Sets the per-voice note/effect and
// returns the row's global control: tempo (Fxx), jumpOrder (Bxx), breakRow (Dxx).
function applyRow(pattern, row) {
    const ctrl = { tempo: -1, jumpOrder: -1, breakRow: -1 }

    for (let v = 0; v < VOICES; v++) {
        const w = cellWord(pattern, row, v)
        const note = w >> 9
        const effWord = w & 0x1FF
        const eff = effWord >> 6

        // two-arg effects (Arp, Vibrato) carry x=(bits5..3), y=(bits2..0);
        // all others carry one 6-bit arg.
        let p1, p2
        if (eff === EFF_ARP || eff === EFF_VIB) { p1 = (effWord >> 3) & 7; p2 = effWord & 7 }
        else { p1 = effWord & 0x3F; p2 = 0 }
        voiceEff[v] = eff; voiceP1[v] = p1; voiceP2[v] = p2

        // Note handling. Porta (3xx) keeps the old frequency: the note only sets
        // the slide target, it doesn't jump the pitch.
        if (note === NOTE_OFF) voiceOn[v] = false
        else if (note >= 1 && note <= MAX_NOTE && eff !== EFF_PORTA) {
            voiceOn[v] = true; voiceNote[v] = note; voiceFreq[v] = noteHz(note); vibIndex[v] = 0
        }
        // note === 0 (or out-of-range) -> continue holding

        // Tick-0 effect setup
        switch (eff) {
            case EFF_PORTA:
                if (note >= 1 && note <= MAX_NOTE) portaTarget[v] = noteHz(note)
                if (p1 !== 0) portaDelta[v] = p1
                break
            case EFF_VIB:
                if (p1 !== 0) vibSpeed[v] = p1
                if (p2 !== 0) vibDepth[v] = p2
                vibIndex[v] = (vibIndex[v] + vibSpeed[v]) & (VIB_SIZE - 1)
                break
            case EFF_JUMP:  ctrl.jumpOrder = p1; break
            case EFF_BREAK: ctrl.breakRow = p1;  break
            case EFF_SPEED: ctrl.tempo = p1;     break
        }
    }
    return ctrl
}

// Apply a voice's effect for tick t (t >= 1; tick 0 is the note load above).
function applyTickEffects(v, t) {
    switch (voiceEff[v]) {
        case EFF_ARP:
            if (voiceP1[v] !== 0 || voiceP2[v] !== 0) {
                const phase = t % 3
                const off = (phase === 1) ? voiceP1[v] : (phase === 2) ? voiceP2[v] : 0
                voiceFreq[v] = noteHz(voiceNote[v] + off)
            }
            break
        case EFF_UP:
            voiceFreq[v] = Math.min(MAX_HZ, voiceFreq[v] + voiceP1[v])
            break
        case EFF_DOWN:
            voiceFreq[v] = Math.max(MIN_HZ, voiceFreq[v] - voiceP1[v])
            break
        case EFF_PORTA:
            if (voiceFreq[v] < portaTarget[v]) voiceFreq[v] = Math.min(portaTarget[v], voiceFreq[v] + portaDelta[v])
            else if (voiceFreq[v] > portaTarget[v]) voiceFreq[v] = Math.max(portaTarget[v], voiceFreq[v] - portaDelta[v])
            break
        case EFF_VIB: {
            vibIndex[v] = (vibIndex[v] + vibSpeed[v]) & (VIB_SIZE - 1)
            const off = Math.trunc(VIBTABLE[vibIndex[v]] * vibDepth[v] / VIB_DEPTH)
            voiceFreq[v] = intervalHz(voiceNote[v] * IBN + off)
            break
        }
        // EFF_JUMP / EFF_BREAK / EFF_SPEED are tick-0 only
    }
}

const sleepUntil = (nano) => { const ms = (nano - sys.nanoTime()) / 1e6; if (ms >= 1) sys.sleep(Math.floor(ms)) }

function cmdToInt(cmd) {
    return cmd[0] | (cmd[1] << 8) | (cmd[2] << 16) | (cmd[3] << 24);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
let nextTick = sys.nanoTime()
let swPhase = 0               // software-arpeggio rotation (persists across ticks)
let globalTick = 0           // running tick counter (for the trace)
let ticksPerRow = DEFAULT_TEMPO
let stopReq = false
const checkStop = () => {
    if ((sys.peek(-49) & 1) !== 0) stopReq = true          // MMIO 48 bit0 = SIGTERM
    else if (con.poll_keys()[0] === 67) stopReq = true     // Stop key
    return stopReq
}

let oldDiv = 0xFFFFFFFF

try {
    let o = 0
    let startRow = 0
    while (o < orders.length && !stopReq) {
        const pattern = orders[o]
        let nextOrder = o + 1, nextStartRow = 0, branched = false

        for (let row = startRow; row < PATTERN_ROWS && !stopReq; row++) {
            const ctrl = applyRow(pattern, row)
            if (ctrl.tempo >= 0) ticksPerRow = Math.max(ctrl.tempo, 1)   // Fxx

            for (let t = 0; t < ticksPerRow; t++) {
                if (checkStop()) break
                if (t > 0) for (let v = 0; v < VOICES; v++) applyTickEffects(v, t)

                const dividers = []
                for (let v = 0; v < VOICES; v++) if (voiceOn[v]) dividers.push(freqToDivider(voiceFreq[v]))

                const plan = planMultiplex(dividers)
                let cmd, swInfo = null
                if (plan.sw) {
                    const idx = swPhase % plan.dividers.length
                    cmd = [plan.dividers[idx], QQ_NONE, 0, 0]
                    swInfo = { idx: idx, n: plan.dividers.length, all: plan.dividers }
                    swPhase++
                } else {
                    cmd = plan.cmd
                }
                uploadBeeper(cmd[0], cmd[1], cmd[2], cmd[3])

                let cmdInt = cmdToInt(cmd)

                if (oldDiv != cmdInt) {
                    println(`${String(globalTick).padStart(6, '0')}  ` +
                        `c${String(o).padStart(2)} r${String(row).padStart(2)} t${String(t).padStart(2)}  ` +
                        describeCommand(cmd, swInfo))
                }

                globalTick++

                nextTick += TICK_NANO

                oldDiv = cmdInt
                sleepUntil(nextTick)
            }

            if (ctrl.jumpOrder >= 0) { nextOrder = ctrl.jumpOrder; nextStartRow = 0; branched = true; break }      // Bxx
            if (ctrl.breakRow >= 0) { nextOrder = o + 1; nextStartRow = ctrl.breakRow; branched = true; break }    // Dxx
        }

        // Bxx/Dxx wrap past the end of the order list (looping); a natural fall-off ends the song.
        if (nextOrder >= orders.length) { if (!branched) break; nextOrder = 0 }
        o = nextOrder
        startRow = (nextStartRow >= PATTERN_ROWS) ? 0 : nextStartRow
    }
}
finally {
    silenceBeeper()
    sys.free(buf)
}

return 0
