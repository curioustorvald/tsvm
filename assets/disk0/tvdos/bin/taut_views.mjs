/**
 * TAUT views module — Samples viewer + Instruments viewer + live-play blob/cursor.
 *
 * Extracted verbatim from taut.js on 2026-06-21 (one contiguous block: SAMPLES
 * VIEWER + INSTRUMENTS VIEWER + LIVE-PLAY BLOB). Runs in-process in taut.js's
 * context via init(HUB). Read-only engine constants come in through HUB.C; engine
 * helper functions through HUB; live engine state (song / panel / playback mode)
 * through HUB getters. The shared blob/cursor primitives stay intra-module here
 * (both viewers use them) — only the engine<->views calls cross HUB.
 *
 * \uXXXX escapes are preserved byte-for-byte from the original (copied, not
 * retyped) — TSVM's string parser is not Unicode.
 */

const win  = require("wintex")
const keys = require("keysym")
const taud = require("taud")

function init(HUB) {
    const C = HUB.C
    const {
        SCRW, SCRH, CELL_PH, CELL_PW, VERT, NUM_VOICES, PLAYHEAD, PLAYMODE_NONE,
        PTNVIEW_HEIGHT, PTNVIEW_OFFSET_Y, SLIDER_TW_SMALL, SLIDER_TW_WIDE,
        VIEW_INSTRMNT, VIEW_SAMPLES, sym, fullPathObj, songsMeta,
        colBackPtn, colBLACK, colHighlight, colInst, colScrollBar, colSep, colStatus,
        colTabActive, colTabBarBack, colTabBarBack2, colTabBarOrn, colTabInactive,
        colVoiceHdr, colVol, colWHITE,
    } = C
    const {
        noteToStr, fillLine, drawControlHint, openInlineNumEdit,
        addPanelMouseRegion, switchToPanel,
    } = HUB

// SAMPLES VIEWER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// The Samples tab is an internal viewer: sample list on the left, properties +
// "used by" instrument list + waveform graphics on the right, and an Edit
// button that opens the in-process openSampleEdit modal (below).
//
// Sample identity in .taud is derived from (samplePtr, sampleLen) inside the
// 256-byte instrument records (terranmon.txt §"Instrument bin"). Conversion
// scripts pack samples into the 8 MB pool in slot order, so sorting unique
// pointers ascending lines up with SNam[i] in the project-data block.

// Peripheral memory window offsets, from terranmon.txt:1985-2044.
const TAUT_SBANK_SIZE       = 524288  // 512 K window for sample bin
const TAUT_INST_WINDOW_OFF  = 720896  // directly-addressable bin $00..$FF starts here in peri space
const TAUT_AUXBIN_WINDOW_OFF = 655360 // auxiliary bin window (Metainstrument-layer-only), BANKED via MMIO 48
const TAUT_INST_RECORD_SIZE = 256
const TAUT_INST_COUNT       = 256     // directly-addressable slots 0..255 (pattern-reachable); slot 0 unused
const TAUT_AUXBANK_RECORDS  = 256     // instrument records per aux bank (one 64K window page)
// Host with the MMIO-48 banked aux bin ($100..$3FF, 1024 slots) exposes setAuxBank; an
// older host has only the single unbanked aux page ($100..$1FF, 512 slots).
const hasBankedAux = (typeof audio !== 'undefined' && typeof audio.setAuxBank === 'function')
const TAUT_INST_TOTAL = hasBankedAux ? 1024 : 512  // aux 256.. ($100..); not pattern-reachable

// Peripheral byte offset of instrument `slot`'s record. 0..255 live in the
// directly-addressable bin; 256.. in the auxiliary bin, which sits at a LOWER peri
// address (terranmon.txt:2036-2044), is reachable only as meta layers, and is BANKED:
// this selects the aux bank holding `slot` (side effect) and returns the in-window offset.
function instRecordBase(slot) {
    if (slot < TAUT_INST_COUNT)
        return TAUT_INST_WINDOW_OFF + slot * TAUT_INST_RECORD_SIZE
    const auxIdx = slot - TAUT_INST_COUNT                    // 0-based aux record index
    if (hasBankedAux) audio.setAuxBank((auxIdx / TAUT_AUXBANK_RECORDS) | 0)   // MMIO 48 bank 0..2
    return TAUT_AUXBIN_WINDOW_OFF + (auxIdx % TAUT_AUXBANK_RECORDS) * TAUT_INST_RECORD_SIZE
}

// Read one 256-byte instrument record straight out of the audio adapter.
function readInstRecord(slot) {
    const memBase = audio.getMemAddr()
    const base    = instRecordBase(slot)
    const rec = new Uint8Array(TAUT_INST_RECORD_SIZE)
    for (let i = 0; i < TAUT_INST_RECORD_SIZE; i++) {
        rec[i] = sys.peek(memBase - (base + i)) & 0xFF
    }
    return rec
}

// Build a 256-entry flag array where flag[slot] = 1 when `slot` is a NON-meta instrument
// that is referenced as a layer child of some Metainstrument — i.e. an individual layer the
// user punched into a pattern directly when they should have used the meta instrument.
// Reads only the meta marker (bytes 2/3 == 0xFFFF) + each layer's instIdx (offsets 4,14,24..).
function buildMetaLayerChildSlots() {
    const memBase = audio.getMemAddr()
    const isMeta = new Uint8Array(TAUT_INST_COUNT)
    const child  = new Uint8Array(TAUT_INST_COUNT)
    for (let slot = 1; slot < TAUT_INST_COUNT; slot++) {
        const base = TAUT_INST_WINDOW_OFF + slot * TAUT_INST_RECORD_SIZE
        if ((sys.peek(memBase - (base + 2)) & 0xFF) === 0xFF &&
            (sys.peek(memBase - (base + 3)) & 0xFF) === 0xFF) {
            isMeta[slot] = 1
            const count = sys.peek(memBase - (base + 1)) & 0xFF
            let o = 4
            for (let i = 0; i < count && o + 10 <= TAUT_INST_RECORD_SIZE; i++, o += 10) {
                // 10-bit layer index: low 8 bits in byte 0, bits 8..9 in bits 6..7 of the
                // vol-start byte (offset +8). Aux-bin layers ($100..$3FF) can't be punched
                // into a pattern, so only flag directly-addressable children.
                const idxLo = sys.peek(memBase - (base + o)) & 0xFF
                const volSt = sys.peek(memBase - (base + o + 8)) & 0xFF
                const idx   = idxLo | (((volSt >> 6) & 0x3) << 8)
                if (idx >= 1 && idx < TAUT_INST_COUNT) child[idx] = 1
            }
        }
    }
    const flagged = new Uint8Array(TAUT_INST_COUNT)
    for (let slot = 1; slot < TAUT_INST_COUNT; slot++)
        if (child[slot] && !isMeta[slot]) flagged[slot] = 1
    return flagged
}

// Build a 256-entry flag array: perc[slot] = 1 when `slot` is a percussion instrument
// (the editor's retuner / transposer MUST NOT touch notes that reference such a slot).
// The flag lives in a different byte for the two record kinds:
//   - ordinary instrument: sample-flags byte 14, bit 4 (P)  — terranmon.txt:2127-2132
//   - Metainstrument:       type/flags byte 0, bit 1 (P)    — terranmon.txt:2419-2428
//     (a meta has no byte-14 flag — bytes 4.. are its layer table — so it carries its
//      own P bit, which midi2taud sets for drum kits and the editor toggles.)
const SAMPLE_FLAG_PERCUSSION = 0x10   // ordinary inst, byte 14 bit 4
const META_FLAG_PERCUSSION   = 0x02   // Metainstrument, byte 0 bit 1
function buildPercussionSlots() {
    const memBase = audio.getMemAddr()
    const perc = new Uint8Array(TAUT_INST_COUNT)
    for (let slot = 1; slot < TAUT_INST_COUNT; slot++) {
        const base = TAUT_INST_WINDOW_OFF + slot * TAUT_INST_RECORD_SIZE
        const isMeta = (sys.peek(memBase - (base + 2)) & 0xFF) === 0xFF &&
                       (sys.peek(memBase - (base + 3)) & 0xFF) === 0xFF
        const flagByte = isMeta ? (sys.peek(memBase - base) & 0xFF)
                                : (sys.peek(memBase - (base + 14)) & 0xFF)
        if (flagByte & (isMeta ? META_FLAG_PERCUSSION : SAMPLE_FLAG_PERCUSSION)) perc[slot] = 1
    }
    return perc
}

// Decode the fields the viewer actually cares about. Offsets from terranmon.txt:2071+.
function decodeInstRecord(rec) {
    const samplePtr  = (rec[0]) | (rec[1] << 8) | (rec[2] << 16) | (rec[3] * 0x1000000)
    const sampleLen  = rec[4] | (rec[5] << 8)
    const c4Rate     = rec[6] | (rec[7] << 8)
    const playStart  = rec[8] | (rec[9] << 8)
    const loopStart  = rec[10] | (rec[11] << 8)
    const loopEnd    = rec[12] | (rec[13] << 8)
    const sampleFlags = rec[14]
    const instGV     = rec[171]
    const defNoteVol = rec[196]
    const detune     = rec[184] | (rec[185] << 8)
    return {
        samplePtr, sampleLen, c4Rate, playStart, loopStart, loopEnd,
        sampleFlags, instGV, defNoteVol, detune
    }
}

// Scan all 256 instruments and build the deduped sample list. Each returned
// entry is { ptr, len, c4Rate, playStart, loopStart, loopEnd, sampleFlags,
// usedBy[], name }. usedBy is a list of instrument slot numbers (1..255).
let samplesCache = null

// Ixmp ("instrument extra samples") introspection — present once the host VM
// exposes the patch read-back API. On an un-rebuilt host it's absent and the
// Samples tab simply lists the base-record samples (no patch samples).
const hasIxmpAPI = (typeof audio !== 'undefined' &&
    typeof audio.getInstrumentPatchCount === 'function' &&
    typeof audio.getInstrumentPatches === 'function')

// Per-patch on-wire length from its version byte (terranmon.txt §Ixmp; mirrors
// taud.mjs#patchLen / AudioJSR223Delegate). 31 common bytes + present blocks.
function ixmpPatchLen(ver) {
    return 31
        + ((ver & 0x80) ? 15 : 0)   // x: extra-base-info (flags1+flags2+fadeout+cutoff+reson+atten)
        + ((ver & 0x02) ? 54 : 0)   // v: volume envelope
        + ((ver & 0x04) ? 54 : 0)   // p: panning envelope
        + ((ver & 0x08) ? 54 : 0)   // f: filter envelope
        + ((ver & 0x10) ? 54 : 0)   // P: pitch envelope
}

// Walk instrument `slot`'s Ixmp patches; invoke cb(samplePtr, sampleLen, extra) per
// patch. Patch common-byte layout (terranmon.txt §Ixmp): u32 ptr@7, u16 len@11,
// u16 playStart@13, loopStart@15, loopEnd@17, rate@19, u8 loopMode@23. No-op without API.
function forEachIxmpPatchSample(slot, cb) {
    if (!hasIxmpAPI) return
    if (audio.getInstrumentPatchCount(slot) <= 0) return
    const b = audio.getInstrumentPatches(slot)
    if (!b || b.length < 31) return
    const u16 = (o) => (b[o] & 0xFF) | ((b[o+1] & 0xFF) << 8)
    let o = 0
    while (o + 31 <= b.length) {
        const ver = b[o] & 0xFF
        const len = ixmpPatchLen(ver)
        if (o + len > b.length) break
        const ptr = (b[o+7] & 0xFF) | ((b[o+8] & 0xFF) << 8) |
                    ((b[o+9] & 0xFF) << 16) | ((b[o+10] & 0xFF) * 0x1000000)
        cb(ptr, u16(o+11), {
            c4Rate: u16(o+19), playStart: u16(o+13),
            loopStart: u16(o+15), loopEnd: u16(o+17),
            sampleFlags: b[o+23] & 0xFF
        })
        o += len
    }
}

// Count an instrument's EXTRA samples: distinct Ixmp patch samples (by ptr:len) that differ
// from the base record's own sample. Drives the Gen.1 "… et al. (N extra samples)" hint for
// multisample (SF2-derived) instruments. 0 when the host lacks the Ixmp API or the instrument
// is single-sampled. Patches that re-use the base sample (e.g. velocity layers sharing one
// slice but with their own envelopes) are NOT counted — "samples", not "patches".
function instExtraSampleCount(slot, basePtr, baseLen) {
    if (!hasIxmpAPI) return 0
    const seen = {}
    let n = 0
    forEachIxmpPatchSample(slot, (ptr, len) => {
        if (len === 0) return
        if (ptr === basePtr && len === baseLen) return
        const k = ptr + ':' + len
        if (!seen[k]) { seen[k] = true; n++ }
    })
    return n
}

function buildSampleIndex() {
    const byPtr = new Map()
    const addSample = (slot, ptr, len, extra) => {
        if (len === 0) return
        const key = ptr + ':' + len
        if (!byPtr.has(key)) {
            byPtr.set(key, Object.assign({
                ptr: ptr, len: len, c4Rate: 0, playStart: 0,
                loopStart: 0, loopEnd: 0, sampleFlags: 0, usedBy: [], name: ''
            }, extra || {}))
        }
        const e = byPtr.get(key)
        if (e.usedBy.indexOf(slot) < 0) e.usedBy.push(slot)
    }
    // Scan both bins: $00..$FF and the auxiliary $100..$3FF (multi-layer presets keep
    // their layer subinstruments there, so their samples live only in aux records).
    for (let i = 1; i < TAUT_INST_TOTAL; i++) {
        const rec = readInstRecord(i)
        // Metainstruments (samplePtr high 16 bits == 0xFFFF) carry no sample of their
        // own — only a layer table — so skip their bogus base pointer here.
        if (((rec[2] | (rec[3] << 8)) & 0xFFFF) !== 0xFFFF) {
            const d = decodeInstRecord(rec)
            addSample(i, d.samplePtr, d.sampleLen, {
                c4Rate: d.c4Rate, playStart: d.playStart, loopStart: d.loopStart,
                loopEnd: d.loopEnd, sampleFlags: d.sampleFlags
            })
        }
        // Ixmp patch samples (extra multisamples that velocity/key layers reference).
        forEachIxmpPatchSample(i, (ptr, slen, ex) => addSample(i, ptr, slen, ex))
    }
    const list = Array.from(byPtr.values()).sort((a, b) => a.ptr - b.ptr)
    const names = (songsMeta && songsMeta.sampleNames) || []
    for (let i = 0; i < list.length; i++) {
        // SNam is pool-ordered and 0-based; converters keep sample order
        // identical to pool order, so list[i] corresponds to names[i].
        const n = names[i]
        list[i].name = (n != null) ? n : ''
    }
    return list
}

function refreshSamplesCache() { samplesCache = buildSampleIndex() }

// ── Layout ───────────────────────────────────────────────────────────────────
// Panel area is rows PTNVIEW_OFFSET_Y .. SCRH-1 (the hint bar lives at SCRH).
// Columns mirror the Patterns tab: list body | scroll-bar col | VERT separator | right pane.
const SMP_LIST_X      = 1
const SMP_LIST_BODY_W = 27                              // text width of one list row
const SMP_LIST_W      = SMP_LIST_BODY_W + 1             // body + 1-col scroll indicator
const SMP_LIST_SCROLL_X = SMP_LIST_X + SMP_LIST_BODY_W  // scroll-indicator column
const SMP_LIST_Y    = PTNVIEW_OFFSET_Y
const SMP_LIST_H    = PTNVIEW_HEIGHT                    // full panel height
const SMP_SEP_X     = SMP_LIST_X + SMP_LIST_W           // vertical separator column
const SMP_RIGHT_X   = SMP_SEP_X + 1
const SMP_RIGHT_Y   = PTNVIEW_OFFSET_Y
const SMP_PROP_H    = 10                  // rows 5..14
const SMP_USED_Y    = SMP_RIGHT_Y + SMP_PROP_H            // header row
const SMP_USED_HDR_H = 1
const SMP_USED_LIST_H = 5
const SMP_WAVE_Y    = SMP_USED_Y + SMP_USED_HDR_H + SMP_USED_LIST_H   // row 21
const SMP_BTN_Y     = SCRH - 1            // bottom-most panel row, reserved for Edit button
const SMP_WAVE_H_ROWS = SMP_BTN_Y - SMP_WAVE_Y                        // visual rows used by the waveform

const colSmpListBg     = colBackPtn
const colSmpListSel    = colHighlight
const colSmpListNumFg  = colInst
const colSmpListNameFg = colStatus
const colSmpPropLabel  = colVoiceHdr
const colSmpPropValue  = colWHITE
const colSmpUsedHdr    = colVoiceHdr
const colSmpUsedFg     = colInst
const colSmpWaveLine   = 77        // bright cyan-ish; visible on dark bg
const colSmpWaveMid    = 246       // dim grey for zero-line
const colSmpWaveFunk   = 221       // orange — loop bytes live-inverted by funk repeat (S$Fx)

// Funk-repeat introspection API (getVoiceFunkSpeed / getInstrumentFunkMask) ships with this
// feature; on an un-rebuilt host VM it's absent and the waveform stays the stored sample.
const hasFunkAPI = (typeof audio !== 'undefined' &&
    typeof audio.getVoiceFunkSpeed === 'function' &&
    typeof audio.getInstrumentFunkMask === 'function')

let smpListScroll = 0
let smpListCursor = 0

// followCursor=true (keyboard nav) scrolls the view to keep the cursor visible;
// false (full redraw / free wheel scroll) leaves the scroll where it is, only
// clamping it to the valid range — so a wheel scroll can move the view without
// moving the selection (mirrors the Advanced Edit list).
function clampSamplesCursor(followCursor = true) {
    const n = samplesCache ? samplesCache.length : 0
    if (smpListCursor < 0) smpListCursor = 0
    if (smpListCursor >= n) smpListCursor = Math.max(0, n - 1)
    if (followCursor) {
        if (smpListCursor < smpListScroll) smpListScroll = smpListCursor
        if (smpListCursor >= smpListScroll + SMP_LIST_H)
            smpListScroll = smpListCursor - SMP_LIST_H + 1
    }
    const maxS = Math.max(0, n - SMP_LIST_H)
    if (smpListScroll > maxS) smpListScroll = maxS
    if (smpListScroll < 0) smpListScroll = 0
}

function drawSamplesListColumn() {
    const n = samplesCache ? samplesCache.length : 0
    for (let row = 0; row < SMP_LIST_H; row++) {
        const idx = smpListScroll + row
        const y = SMP_LIST_Y + row
        con.move(y, SMP_LIST_X)
        if (idx >= n) {
            con.color_pair(colSmpListNameFg, colSmpListBg)
            print(' '.repeat(SMP_LIST_BODY_W))
            continue
        }
        const s = samplesCache[idx]
        const isSel = (idx === smpListCursor)
        const back  = isSel ? colSmpListSel : colSmpListBg
        const numStr = (idx + 1).toString(16).toUpperCase().padStart(2, '0')
        const nameRaw = (s.name && s.name.length) ? s.name : '(sample ' + (idx + 1) + ')'
        const nameW = SMP_LIST_BODY_W - 6   // ' NN  name ' totals 6 + N chars
        const nameStr = (nameRaw.length > nameW ? nameRaw.substring(0, nameW) : nameRaw.padEnd(nameW))
        con.color_pair(colSmpListNumFg, back); print(' ' + numStr + ' ')
        con.color_pair(colSmpListNameFg, back); print(' ')
        con.color_pair(isSel ? colWHITE : colSmpListNameFg, back); print(nameStr)
        con.color_pair(colSmpListNameFg, back); print(' ')
    }
    // scroll indicator on the rightmost column of the list area (left of the separator)
    if (n > SMP_LIST_H) {
        const maxScroll = n - SMP_LIST_H
        const indPos = (maxScroll === 0) ? 0 : ((smpListScroll * (SMP_LIST_H - 1) / maxScroll) | 0)
        for (let r = 0; r < SMP_LIST_H; r++) {
            con.move(SMP_LIST_Y + r, SMP_LIST_SCROLL_X)
            con.color_pair(colScrollBar, colSmpListBg)

            let scrollChar = (r == 0) ? sym.taut_scrollgutter_top : (r == SMP_LIST_H - 1) ? sym.taut_scrollgutter_bot : sym.taut_scrollgutter_mid
            if (r == indPos) scrollChar += 3;
            con.addch(scrollChar)
        }
    } else {
        for (let r = 0; r < SMP_LIST_H; r++) {
            con.move(SMP_LIST_Y + r, SMP_LIST_SCROLL_X)
            con.color_pair(colStatus, colSmpListBg); print(' ')
        }
    }
}

function drawSamplesSeparator() {
    con.color_pair(colSep, colBackPtn)
    for (let y = SMP_LIST_Y; y < SCRH; y++) {
        con.move(y, SMP_SEP_X); con.prnch(VERT)
    }
}

function loopModeName(flags) {
    const lp = flags & 3
    const sus = (flags >>> 2) & 1
    const names = ['none', 'forward', 'pingpong', 'oneshot']
    return names[lp] + (sus ? ' (sustain)' : '')
}

function drawSamplesProperties() {
    const rightW = SCRW - SMP_RIGHT_X + 1
    // Clear right side
    for (let r = 0; r < SMP_PROP_H + SMP_USED_HDR_H + SMP_USED_LIST_H; r++) {
        con.move(SMP_RIGHT_Y + r, SMP_RIGHT_X)
        con.color_pair(colSmpPropValue, colBackPtn)
        print(' '.repeat(rightW))
    }

    const n = samplesCache ? samplesCache.length : 0
    if (n === 0) {
        con.move(SMP_RIGHT_Y, SMP_RIGHT_X)
        con.color_pair(colSmpPropLabel, colBackPtn)
        print('No samples in this project.')
        return
    }

    const s = samplesCache[smpListCursor]
    if (!s) return

    const rows = [
        ['Sample #', (smpListCursor + 1).toString(16).toUpperCase().padStart(2, '0') + '  ($' + s.ptr.toString(16).toUpperCase().padStart(6, '0') + ')'],
        ['Name',     s.name && s.name.length ? s.name : '(unnamed)'],
        ['Length',   s.len + ' bytes  ($' + s.len.toString(16).toUpperCase().padStart(4, '0') + ')'],
        ['Rate@C4',  s.c4Rate + ' Hz'],
        ['Play st.', '$' + s.playStart.toString(16).toUpperCase().padStart(4, '0')],
        ['Loop',     loopModeName(s.sampleFlags) +
                        '  [$' + s.loopStart.toString(16).toUpperCase().padStart(4, '0') +
                        '..$' + s.loopEnd.toString(16).toUpperCase().padStart(4, '0') + ']'],
        ['Bank',     ((s.ptr / TAUT_SBANK_SIZE) | 0) + '/15'],
        ['Used by',  s.usedBy.length + ' instrument' + (s.usedBy.length === 1 ? '' : 's')],
    ]

    for (let i = 0; i < rows.length; i++) {
        const y = SMP_RIGHT_Y + i
        con.move(y, SMP_RIGHT_X)
        con.color_pair(colSmpPropLabel, colBackPtn)
        print((rows[i][0] + '         ').substring(0, 10))
        con.color_pair(colSmpPropValue, colBackPtn)
        const v = rows[i][1]
        const valMax = rightW - 11
        print(v.length > valMax ? v.substring(0, valMax) : v)
    }
}

// Vertical scroll for the "Used by instruments" list (small in this viewer).
let smpUsedScroll = 0

function drawSamplesUsedBy() {
    const s = (samplesCache && samplesCache[smpListCursor]) || null
    const used = s ? s.usedBy : []
    const names = (songsMeta && songsMeta.instNames) || []
    const visible = SMP_USED_LIST_H

    const rightW = SCRW - SMP_RIGHT_X + 1
    con.move(SMP_USED_Y, SMP_RIGHT_X)
    con.color_pair(colSmpUsedHdr, colBackPtn)
    print(`Used by instruments (${used.length}):`.padEnd(rightW))

    if (smpUsedScroll > Math.max(0, used.length - visible))
        smpUsedScroll = Math.max(0, used.length - visible)
    if (smpUsedScroll < 0) smpUsedScroll = 0

    for (let r = 0; r < visible; r++) {
        const y = SMP_USED_Y + 1 + r
        con.move(y, SMP_RIGHT_X)
        con.color_pair(colSmpPropValue, colBackPtn)
        const idx = smpUsedScroll + r
        if (idx >= used.length) {
            print(' '.repeat(rightW))
            continue
        }
        const slot = used[idx]
        const iname = names[slot] || '(unnamed)'
        // Aux-bin slots ($100..$3FF) print as 3 hex digits; size the name field off the
        // actual label length so the row stays within the right pane.
        const numStr = '$' + slot.toString(16).toUpperCase().padStart(2, '0')
        con.color_pair(colSmpUsedFg, colBackPtn)
        print(' ' + numStr + ' ')
        con.color_pair(colSmpPropValue, colBackPtn)
        const nameW = rightW - 2 - numStr.length
        print(iname.length > nameW ? iname.substring(0, nameW) : iname.padEnd(nameW))
    }
}

// ── Waveform rendering ──────────────────────────────────────────────────────
// Renders one sample under the right panel as baseline-filled bars (each bar is
// a plotRect anchored at the zero line, extending to the sample amplitude),
// using the graphics layer. Samples are unsigned 8-bit; bank-switch is required
// because only 512 K of the 8 MB pool is mapped at a time. We restore bank 0
// (the playback-expected default) when done.

// Pixel rect occupied by the waveform inside the Samples viewer. Both the
// waveform painter and the leave-Samples cleanup need to reach for the same
// geometry, so it lives in one helper.
function sampleWaveformRect() {
    return {
        x: (SMP_RIGHT_X - 1) * CELL_PW,
        y: (SMP_WAVE_Y - 1) * CELL_PH,
        w: (SCRW - SMP_RIGHT_X + 1) * CELL_PW,
        h: SMP_WAVE_H_ROWS * CELL_PH,
    }
}

function clearSampleWaveformArea() {
    const r = sampleWaveformRect()
    graphics.plotRect(r.x-2, r.y-2, r.w+4, r.h+4, 255)   // 255 = transparent
}

// Instrument slot of an active voice that's funk-repeating (S$Fx) one of the sample's `usedBy`
// instruments, or -1. Returns -1 when not playing / no funking voice / API absent. Drives the
// per-frame repaint cadence only — the *displayed* mask comes from funkMaskForSample, which also
// honours masks that persist after the funking voice has gone idle.
function findFunkInstForSample(usedBy) {
    if (!hasFunkAPI) return -1
    const numVox = (HUB.getSong() && HUB.getSong().numVoices) ? HUB.getSong().numVoices : NUM_VOICES
    for (let v = 0; v < numVox; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        if (audio.getVoiceFunkSpeed(PLAYHEAD, v) <= 0) continue
        const inst = audio.getVoiceInstrument(PLAYHEAD, v)
        if (usedBy.indexOf(inst) >= 0) return inst
    }
    return -1
}

// Funk XOR mask to DISPLAY for this sample, or null. The per-instrument mask persists in the engine
// for the whole playback session (cleared only on stop-and-replay), so once a loop has been
// funk-inverted the overlay must stay even after the funking voice goes idle — matching ProTracker,
// whose destructive EFx edits never revert until the song is reloaded. Prefer an actively-funking
// instrument (its mask is live this frame); otherwise show any usedBy instrument that still carries
// a non-empty mask from earlier in the session.
function funkMaskForSample(usedBy, activeInst) {
    if (!hasFunkAPI) return null
    if (activeInst > 0) {
        const m = audio.getInstrumentFunkMask(activeInst)
        if (m && m.length > 0) return m
    }
    for (let i = 0; i < usedBy.length; i++) {
        const m = audio.getInstrumentFunkMask(usedBy[i])
        if (m && m.length > 0) return m
    }
    return null
}

// Whether a voice was actively funk-repeating the displayed sample on the last paint. Drives the
// per-frame repaint cadence in tickFunkWaveform (repaint while the live mask changes, plus one
// settling frame after it stops). The painted overlay itself persists — the engine keeps the mask.
let funkWaveLast = false

function drawSampleWaveform() {
    const r = sampleWaveformRect()
    const wx0 = r.x, wy0 = r.y, wW = r.w, wH = r.h

    // Clear waveform area to transparent (255 = transparent against text bg)
    clearSampleWaveformArea()

    const s = (samplesCache && samplesCache[smpListCursor]) || null
    if (!s || s.len === 0) { funkWaveLast = false; return }

    // Funk-repeat overlay. The per-instrument XOR mask flips loop-region bytes by 0xFF and persists
    // in the engine until stop-and-replay, so the overlay must remain even after the voice that
    // funked the sample goes idle — matching ProTracker's destructive EFx, whose inverted bytes
    // never revert until the song is reloaded. We therefore key the overlay off the persisted mask,
    // not off a currently-active funking voice. funkLE is clamped to the snapshot mask's coverage so
    // the bit lookup can never run off the (host) array.
    let funkMask = null, funkLS = 0, funkLE = 0
    let activeFunk = false
    if (HUB.getPlaybackMode() !== PLAYMODE_NONE && s.loopEnd > s.loopStart) {
        const activeInst = findFunkInstForSample(s.usedBy)
        activeFunk = (activeInst > 0)
        const m = funkMaskForSample(s.usedBy, activeInst)
        if (m) {
            funkMask = m
            funkLS = s.loopStart
            funkLE = Math.min(s.loopEnd, funkLS + m.length * 8)
        }
    }
    funkWaveLast = activeFunk

    const memBase  = audio.getMemAddr()
    const prevBank = audio.getSampleBank() || 0
    let curBank = -1

    // Zero line and value→y mapping (unsigned 8-bit: 255 → top, 0 → bottom).
    const baseY = wy0 + (wH >>> 1)
    const yOf = (v) => wy0 + (((wH * (255 - v)) / 255) | 0)

    // Read sample byte p (0..len-1) applying the live funk-flip overlay; sets the
    // shared `flippedAny` flag whenever a byte was inverted by the funk mask.
    let flippedAny = false
    const readByte = (p) => {
        const abs = s.ptr + p
        const bank = (abs / TAUT_SBANK_SIZE) | 0
        if (bank !== curBank) { audio.setSampleBank(bank); curBank = bank }
        let v = sys.peek(memBase - (abs - bank * TAUT_SBANK_SIZE)) & 0xFF
        if (funkMask !== null && p >= funkLS && p < funkLE) {
            const k = p - funkLS
            if ((funkMask[k >>> 3] >>> (k & 7)) & 1) { v ^= 0xFF; flippedAny = true }
        }
        return v
    }

    // Zero/baseline line
    graphics.plotRect(wx0, baseY, wW, 1, colSmpWaveMid)

    // Per-sample bar width: how many pixels each sample spans, at least 1px.
    const rectW = Math.max(1, Math.ceil(wW / s.len))

    if (s.len <= wW) {
        // Fewer samples than pixels: one baseline-filled bar per sample.
        for (let i = 0; i < s.len; i++) {
            flippedAny = false
            const yv = yOf(readByte(i))
            const top = Math.min(baseY, yv)
            graphics.plotRect(wx0 + ((i * wW / s.len) | 0), top, rectW,
                              Math.max(1, Math.abs(baseY - yv)),
                              flippedAny ? colSmpWaveFunk : colSmpWaveLine)
        }
    } else {
        // More samples than pixels: reduce each 1px column to its min/max and
        // fill from the baseline through the envelope (a solid filled waveform).
        for (let col = 0; col < wW; col++) {
            const start = (col * s.len / wW) | 0
            const end   = Math.min(s.len, (((col + 1) * s.len / wW) | 0))
            if (end <= start) continue
            const step = Math.max(1, ((end - start) / 8) | 0)
            let mn = 255, mx = 0
            flippedAny = false
            for (let p = start; p < end; p += step) {
                const v = readByte(p)
                if (v < mn) mn = v
                if (v > mx) mx = v
            }
            const yTop = Math.min(baseY, yOf(mx))
            const yBot = Math.max(baseY, yOf(mn))
            graphics.plotRect(wx0 + col, yTop, 1, Math.max(1, yBot - yTop + 1),
                              flippedAny ? colSmpWaveFunk : colSmpWaveLine)
        }
    }

    // Restore bank 0 for playback (engine expects bank 0 as default)
    audio.setSampleBank(prevBank)
}

// Per-frame driver: while a voice is funk-repeating the displayed sample, repaint the waveform
// each frame so the overlay tracks the live mask. One settling repaint fires after funk stops
// (funkWaveLast); the persisted overlay then stays until the engine clears the mask on replay.
function tickFunkWaveform() {
    if (HUB.getPanel() !== VIEW_SAMPLES) { funkWaveLast = false; return }
    const s = (samplesCache && samplesCache[smpListCursor]) || null
    const funking = !!(s && s.len > 0 && HUB.getPlaybackMode() !== PLAYMODE_NONE &&
                       findFunkInstForSample(s.usedBy) > 0)
    if (funking || funkWaveLast) drawSampleWaveform()
}

function computeSampleRAMBytes() {
    if (!samplesCache) return 0
    let total = 0
    for (let i = 0; i < samplesCache.length; i++) total += samplesCache[i].len
    return total
}

// 16 banks x 524288 = 8 MB = 8192k. Hardcoded to match the user-visible budget.
const SMP_RAM_MAX_K = 8192

function formatSampleRamK(bytes) {
    const k = bytes / 1024
    return (k < 10  ? k.toFixed(2)
         :  k < 100 ? k.toFixed(1)
         :           Math.round(k).toString())
}

function drawSamplesRamFooter() {
    const bytes = computeSampleRAMBytes()
    const ramStr = formatSampleRamK(bytes) + 'k / ' + SMP_RAM_MAX_K + 'k'
    const y = PTNVIEW_OFFSET_Y//SMP_RIGHT_Y + SMP_PROP_H - 1
    con.move(y, SCRW - 13)
    // con.color_pair(colSmpPropLabel, colBackPtn)
    // print(('Sample RAM' + '         ').substring(0, 10))
    con.color_pair(colSmpPropValue, colBackPtn)
    print(ramStr)
}

function drawSamplesEditButton() {
    const y = SMP_BTN_Y
    con.move(y, SMP_RIGHT_X)
    con.color_pair(colSmpUsedHdr, colBackPtn)
    print('[ E ]')
    con.color_pair(colSmpPropValue, colBackPtn)
    const label = ' Edit sample'
    print(label)
    const rest = SCRW - (SMP_RIGHT_X + 5 + label.length) + 1
    if (rest > 0) print(' '.repeat(rest))
}

function clearSamplesPanel() {
    // Panel area only — leave the hint row (SCRH) alone; drawControlHint owns it.
    for (let y = PTNVIEW_OFFSET_Y; y < SCRH; y++) fillLine(y, colSmpPropValue, colBackPtn)
}

function drawSamplesContents(wo) {
    if (samplesCache === null) refreshSamplesCache()
    clampSamplesCursor(false)                 // respect the current scroll (free wheel scroll)
    clearSamplesPanel()
    drawSamplesListColumn()
    drawSamplesSeparator()
    drawSamplesProperties()
    drawSamplesRamFooter()
    drawSamplesUsedBy()
    drawSampleWaveform()
    drawSamplesEditButton()
    // The list column just repainted col 1 with a leading space on every row,
    // so any prior blob is gone — invalidate the cache, then re-stamp blobs
    // immediately when playback is live so the user does not see a one-frame gap.
    invalidateSamplesBlob()
    if (HUB.getPlaybackMode() !== PLAYMODE_NONE) drawSamplesPlayBlobs()
    // Same reasoning for the waveform playhead cursor — drawSampleWaveform just
    // wiped the area, so its prior column is irrelevant. Re-stamp if playing.
    invalidateSmpCursor()
    if (HUB.getPlaybackMode() !== PLAYMODE_NONE) drawSampleCursor()
}

// Jump into the in-process instrument viewer with the cursor parked on `instSlot`.
// `instSlotToIdx` is the {slot → cache index} map built by refreshInstrumentsCache;
// when the slot isn't in the cache (rare — empty slot with no name), we fall back
// to cursor 0 instead of failing the switch.
function launchInstrumentViewerFor(instSlot) {
    if (instrumentsCache === null) refreshInstrumentsCache()
    const idx = (instSlotToIdx && instSlotToIdx[instSlot] != null) ? instSlotToIdx[instSlot] : -1
    if (idx >= 0) instListCursor = idx
    clampInstrumentsCursor()
    switchToPanel(VIEW_INSTRMNT)
}

function samplesInput(wo, event) {
    if (event[0] !== 'key_down') return
    const keysym     = event[1]
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 8 : 1

    const n = samplesCache ? samplesCache.length : 0
    if (n === 0) {
        if (keysym === 'e' || keysym === 'E') {
            openSampleEdit(-1)
        }
        return
    }

    if (keysym === '<UP>')   { smpListCursor -= moveDelta; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<DOWN>') { smpListCursor += moveDelta; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<PAGE_UP>')   { smpListCursor -= SMP_LIST_H; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<PAGE_DOWN>') { smpListCursor += SMP_LIST_H; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<HOME>') { smpListCursor = 0; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<END>')  { smpListCursor = n - 1; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }

    if (keysym === 'e' || keysym === 'E') {
        openSampleEdit(smpListCursor)
        return
    }

    if (keysym === '\n') {
        // Open the first instrument that uses this sample in the (stub) inst viewer
        const s = samplesCache[smpListCursor]
        if (s && s.usedBy.length > 0) {
            launchInstrumentViewerFor(s.usedBy[0])
        }
        return
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// END SAMPLES VIEWER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////


/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// INSTRUMENTS VIEWER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Mirrors the Samples tab skeleton: list on the left, multi-tabbed property pane
// on the right. Tabs are General / Volume / Panning / Pitch / Filter — the latter
// four each carry an envelope graph rendered through the graphics layer. Pitch and
// Filter edit the two pf-envelope slots, routed by each slot's m-bit.
//
// All field offsets/encodings follow terranmon.txt §"Instrument bin" (offsets
// 0..196). Envelope nodes (offsets 21 / 71 / 121) are 25 × {value u8, time u8}
// where the time byte is a 3.5 unsigned minifloat — converted here using the
// same decoder formula as ThreeFiveMinifloat.kt / taud_common.py MINUFLOAT_LUT.

// 3.5 unsigned minifloat: exp = bits 7..5 (0..7), mant = bits 4..0 (0..31).
//   exp == 0 : value = mant / 256                        (smallest non-zero step = 1/256 s)
//   exp >  0 : value = (mant + 32) * 2^(exp - 9)         (max = 15.75 s at 0xFF)
function envTimeFromByte(b) {
    const exp  = (b >>> 5) & 7
    const mant =  b        & 31
    return (exp === 0) ? (mant / 256) : ((mant + 32) * Math.pow(2, exp - 9))
}

// ── Envelope node editing (web items M7/M8/36/37 port) ─────────────────────
// The env tabs are editable: mouse-drag a node on the graph (2D — value from
// Y, the PRECEDING segment's duration from X, minifloat-quantised) or use the
// keyboard (',' '.' select node; '-'/'=' value; '[' ']' duration; 'n'/'x'
// add/delete). The rightmost 1-ENV_TIME_FRAC of the plot stays empty so the
// last node can always be grabbed and dragged further right to extend the
// envelope (item 37). First edit of an inactive Pitch/Filter role CLAIMS the
// slot (present bit 13 + role m-bit 7), same as the Present checkbox.
const ENV_TIME_FRAC = 0.8
let envSelNode   = 0
let envSelKey    = ''      // "slot:tab" — selection resets when it changes
let envDragState = null    // { idx } while a node drag is in progress

// Nearest 3.5-minifloat byte for a duration in seconds (encode side of
// envTimeFromByte; 256-entry nearest scan — plenty fast for UI use).
let _mfSecs = null
function minifloatFromSec(sec) {
    if (!_mfSecs) { _mfSecs = new Array(256); for (let b = 0; b < 256; b++) _mfSecs[b] = envTimeFromByte(b) }
    let best = 0, bestD = Infinity
    for (let b = 0; b < 256; b++) {
        const d = Math.abs(_mfSecs[b] - sec)
        if (d < bestD) { bestD = d; best = b }
    }
    return best
}

function envLastIdx(env) { return (env.terminatorIdx >= 0) ? env.terminatorIdx : (env.nodes.length - 1) }

// Cumulative node times (node 0 at t=0) + total span (min 1e-6 for the axis).
function envTimes(env) {
    const last = envLastIdx(env)
    const xs = [0]
    let acc = 0
    for (let i = 1; i <= last; i++) { acc += env.nodes[i - 1].durSec; xs.push(acc) }
    return { xs: xs, total: Math.max(acc, 1e-6), last: last }
}

// Claim an inactive Pitch/Filter role ahead of the first edit.
function envClaimRoleIfNeeded(e, env) {
    const role = (instSubTab === INST_TAB_FILT) ? 'filter' : (instSubTab === INST_TAB_PIT) ? 'pitch' : null
    if (!role || env.present) return
    const rec = readInstRecord(e.slot)
    let lo = rec[env.loopOff], hi = rec[env.loopOff + 1] | (1 << 5)
    if (role === 'filter') lo |= (1 << 7); else lo &= ~(1 << 7)
    instWriteBytes(e.slot, [[env.loopOff, lo], [env.loopOff + 1, hi]])
}

// Raw 25-slot working copy of this envelope's node bytes (full bytes — value
// writes preserve any bits outside the value mask).
function envRawNodes(e, env) {
    const rec = readInstRecord(e.slot)
    const out = new Array(25)
    for (let i = 0; i < 25; i++) out[i] = { v: rec[env.nodeBase + i * 2] & 0xFF, d: rec[env.nodeBase + i * 2 + 1] & 0xFF }
    return out
}
function envCommitNodes(e, env, nodes) {
    const pairs = []
    for (let i = 0; i < 25; i++) {
        pairs.push([env.nodeBase + i * 2, nodes[i].v])
        pairs.push([env.nodeBase + i * 2 + 1, nodes[i].d])
    }
    envClaimRoleIfNeeded(e, env)
    instWriteBytes(e.slot, pairs)
    e.decoded = decodeInstFull(readInstRecord(e.slot))
}

// Insert a node after `sel`: split its segment (interior) or extend the tail
// (the last node gains a 0.1 s span, a fresh terminator lands after it).
function envAddNode(e, env, sel) {
    const last = envLastIdx(env), active = last + 1
    if (active >= 25) return false
    const mask = env.valueMax
    const nodes = envRawNodes(e, env)
    if (sel >= active - 1) {
        nodes[active - 1] = { v: nodes[active - 1].v, d: Math.max(1, minifloatFromSec(0.1)) }
        nodes[active]     = { v: nodes[active - 1].v, d: 0 }
        envSelNode = active
    } else {
        const totalS = envTimeFromByte(nodes[sel].d)
        const halfB  = Math.max(1, minifloatFromSec(totalS / 2))
        const midVal = Math.round(((nodes[sel].v & mask) + (nodes[sel + 1].v & mask)) / 2) & mask
        for (let i = 24; i > sel + 1; i--) nodes[i] = nodes[i - 1]
        nodes[sel]     = { v: nodes[sel].v, d: halfB }
        nodes[sel + 1] = { v: midVal, d: Math.max(1, minifloatFromSec(Math.max(totalS - envTimeFromByte(halfB), 0))) }
        envSelNode = sel + 1
    }
    envCommitNodes(e, env, nodes)
    return true
}

// Delete node `sel` (node 0 is anchored at t=0). Interior: the removed
// segment merges into the previous node so later timing is kept; deleting the
// terminator truncates — the previous node becomes the terminator with its
// value intact (deliberately NOT the web's shift, which could synthesise a
// value-0 terminator and trip the Schism cut rule).
function envRemoveNode(e, env, sel) {
    const last = envLastIdx(env)
    if (sel === 0 || last < 1 || sel > last) return false
    const nodes = envRawNodes(e, env)
    if (sel === last) {
        nodes[sel - 1] = { v: nodes[sel - 1].v, d: 0 }
    } else {
        const merged = envTimeFromByte(nodes[sel - 1].d) + envTimeFromByte(nodes[sel].d)
        nodes[sel - 1] = { v: nodes[sel - 1].v, d: Math.max(1, minifloatFromSec(merged)) }
        for (let i = sel; i < 24; i++) nodes[i] = nodes[i + 1]
        nodes[24] = { v: 0, d: 0 }
    }
    envSelNode = Math.max(0, sel - 1)
    envCommitNodes(e, env, nodes)
    return true
}

// Edit the loop or sustain RANGE (node indices) + its enable bit via a
// dialog ('o' / 'p' on an env tab). Writes the LOOP/SUSTAIN word bytes with
// every other bit preserved: enable = lo bit 5, end = lo bits 0..4, start =
// hi bits 0..4 (carry / m / present bits untouched).
function envRangeDialog(e, env, which) {
    const isLoop = (which === 'loop')
    const off = isLoop ? env.loopOff : env.sustOff
    const res = win.showDialog({
        title: (isLoop ? 'Envelope loop' : 'Envelope sustain') + ' (node indices)',
        drawFrame: HUB.popups.popupDrawFrame, colours: HUB.popups.popupColours,
        fields: [
            { label: 'Enabled (0/1):', width: 3, maxLength: 1, initial: (isLoop ? env.loopEnable : env.sustEnable) ? '1' : '0' },
            { label: 'Start node:',    width: 4, maxLength: 2, initial: '' + (isLoop ? env.loopStart : env.sustStart) },
            { label: 'End node:',      width: 4, maxLength: 2, initial: '' + (isLoop ? env.loopEnd : env.sustEnd) },
        ],
        buttons: [{ label: 'OK', action: 'ok' }, { label: 'Cancel', action: 'cancel' }],
    })
    if (res.action === 'ok') {
        const last = envLastIdx(env)
        const en = (parseInt('' + res.values[0], 10) || 0) !== 0
        let a = parseInt('' + res.values[1], 10); if (isNaN(a)) a = isLoop ? env.loopStart : env.sustStart
        let b = parseInt('' + res.values[2], 10); if (isNaN(b)) b = isLoop ? env.loopEnd : env.sustEnd
        a = Math.max(0, Math.min(last, a)); b = Math.max(0, Math.min(last, b))
        if (b < a) { const t = a; a = b; b = t }
        const rec = readInstRecord(e.slot)
        envClaimRoleIfNeeded(e, env)
        instWriteBytes(e.slot, [
            [off,     (rec[off] & 0xC0) | (en ? 0x20 : 0) | (b & 0x1F)],
            [off + 1, (rec[off + 1] & ~0x1F) | (a & 0x1F)],
        ])
        e.decoded = decodeInstFull(readInstRecord(e.slot))
    }
    drawInstrumentsContents()
}

// Apply one drag event to the grabbed node: value from Y; for idx>0 the X
// position re-times the PRECEDING segment (node 0 is fixed at t=0). The frac
// clamp reaches 1/ENV_TIME_FRAC so dragging into the right headroom extends
// the envelope. Graph-only repaint while dragging; release repaints the tab.
function envApplyDrag(e, px, py) {
    if (!envDragState) return
    const bundle = envBundleForCurrentTab(e)
    if (!bundle) return
    const env = bundle.env
    const r = instEnvelopeRect()
    const idx = envDragState.idx
    const mask = env.valueMax
    const value = Math.max(0, Math.min(mask, Math.round(((r.y + r.h - 1 - py) / (r.h - 1)) * mask)))
    const rec = readInstRecord(e.slot)
    const vOff = env.nodeBase + idx * 2
    const pairs = [[vOff, (rec[vOff] & ~mask) | value]]
    if (idx > 0) {
        const t = envTimes(env)
        const frac = Math.max(0, Math.min(1 / ENV_TIME_FRAC, (px - r.x) / ((r.w - 1) * ENV_TIME_FRAC)))
        const seg = Math.max(frac * t.total - t.xs[idx - 1], 0)
        pairs.push([env.nodeBase + (idx - 1) * 2 + 1, Math.max(1, minifloatFromSec(seg))])
    }
    envClaimRoleIfNeeded(e, env)
    instWriteBytes(e.slot, pairs)
    e.decoded = decodeInstFull(readInstRecord(e.slot))
    const b2 = envBundleForCurrentTab(e)
    clearInstrumentsEnvelopeArea()
    drawEnvelopeGraph(b2.env, undefined, envSelNode)
}

// Mouse-down on the right pane, below the checkbox/slider hits: grab the
// nearest env node (by x distance) on an env tab. Returns true when consumed.
function envMouseDown(ev) {
    const e = instrumentsCache ? instrumentsCache[instListCursor] : null
    if (!e || e.decoded.isMeta || instSubTab < INST_TAB_VOL) return false
    const bundle = envBundleForCurrentTab(e)
    if (!bundle) return false
    const env = bundle.env
    const r = instEnvelopeRect()
    const px = ev[1], py = ev[2]
    if (py < r.y - 4 || py > r.y + r.h + 4) return false
    const t = envTimes(env)
    let best = -1, bestD = 8
    for (let i = 0; i <= t.last; i++) {
        const nx = r.x + (((t.xs[i] / t.total) * (r.w - 1) * ENV_TIME_FRAC) | 0)
        const d = Math.abs(nx - px)
        if (d < bestD) { bestD = d; best = i }
    }
    if (best < 0) return true            // in the graph area but no node: consume quietly
    envSelNode = best
    envDragState = { idx: best }
    envApplyDrag(e, px, py)
    return true
}

// Keyboard node editing on an env tab. Returns true when the key was consumed.
function envHandleKey(e, env, ks) {
    const last = envLastIdx(env)
    if (envSelNode > last) envSelNode = last
    const idx = envSelNode
    const mask = env.valueMax
    const bumpValue = (delta) => {
        const rec = readInstRecord(e.slot)
        const off = env.nodeBase + idx * 2
        const nv = Math.max(0, Math.min(mask, (rec[off] & mask) + delta))
        envClaimRoleIfNeeded(e, env)
        instWriteBytes(e.slot, [[off, (rec[off] & ~mask) | nv]])
        e.decoded = decodeInstFull(readInstRecord(e.slot))
    }
    const bumpDur = (delta) => {
        if (idx === 0) return
        const rec = readInstRecord(e.slot)
        const off = env.nodeBase + (idx - 1) * 2 + 1
        const nd = Math.max(1, Math.min(255, rec[off] + delta))
        envClaimRoleIfNeeded(e, env)
        instWriteBytes(e.slot, [[off, nd]])
        e.decoded = decodeInstFull(readInstRecord(e.slot))
    }
    if (ks === 'o') { envRangeDialog(e, env, 'loop');    return true }
    if (ks === 'p') { envRangeDialog(e, env, 'sustain'); return true }
    if (ks === ',')      { envSelNode = Math.max(0, idx - 1) }
    else if (ks === '.') { envSelNode = Math.min(last, idx + 1) }
    else if (ks === '-') bumpValue(-1)
    else if (ks === '=') bumpValue(1)
    else if (ks === '_') bumpValue(-8)
    else if (ks === '+') bumpValue(8)
    else if (ks === '[') bumpDur(-1)
    else if (ks === ']') bumpDur(1)
    else if (ks === '{') bumpDur(-16)
    else if (ks === '}') bumpDur(16)
    else if (ks === 'n') { if (!envAddNode(e, env, idx)) return true }
    else if (ks === 'x') { if (!envRemoveNode(e, env, idx)) return true }
    else return false
    drawInstrumentsContents()
    return true
}

// Decode one of the three envelopes from the 256-byte instrument record. `kind`
// selects the node array (vol/pan/pf) and the LOOP/SUSTAIN word locations.
//   nodes: {value, durByte, durSec} array, truncated at the first dur=0 node
//          (the terminator — see terranmon.txt §envelope nodes "0 = hold").
//   terminatorIdx: index of the terminator, or -1 if all 25 slots are walked.
function decodeEnvelope(rec, kind) {
    const isPf     = (kind === 'pf' || kind === 'pf2')
    const nodeBase = (kind === 'vol') ? 21  : (kind === 'pan') ? 71  : (kind === 'pf2') ? 201 : 121
    const loopOff  = (kind === 'vol') ? 15  : (kind === 'pan') ? 17  : (kind === 'pf2') ? 197 : 19
    const sustOff  = (kind === 'vol') ? 189 : (kind === 'pan') ? 191 : (kind === 'pf2') ? 199 : 193
    const valMask  = (kind === 'vol') ? 0x3F : 0xFF
    const loopWord = rec[loopOff] | (rec[loopOff + 1] << 8)
    const sustWord = rec[sustOff] | (rec[sustOff + 1] << 8)
    const present    = ((loopWord >>> 13) & 1) === 1
    const loopEnable = ((loopWord >>> 5)  & 1) === 1
    const loopStart  =  (loopWord >>> 8)  & 0x1F
    const loopEnd    =  (loopWord)        & 0x1F
    const carry      = ((loopWord >>> 6)  & 1) === 1
    const panUseDef  = (kind === 'pan') && (((loopWord >>> 7) & 1) === 1)
    const pfFilter   = isPf              && (((loopWord >>> 7) & 1) === 1)
    const sustEnable = ((sustWord >>> 5)  & 1) === 1
    const sustStart  =  (sustWord >>> 8)  & 0x1F
    const sustEnd    =  (sustWord)        & 0x1F
    const nodes = []
    let terminatorIdx = -1
    for (let i = 0; i < 25; i++) {
        const value   = rec[nodeBase + i * 2]     & valMask
        const durByte = rec[nodeBase + i * 2 + 1] & 0xFF
        const durSec  = envTimeFromByte(durByte)
        nodes.push({ value, durByte, durSec })
        if (durByte === 0) { terminatorIdx = i; break }
    }
    return {
        kind, present, loopEnable, loopStart, loopEnd, carry,
        panUseDef, pfFilter, sustEnable, sustStart, sustEnd,
        nodes, terminatorIdx, valueMax: valMask,
        loopOff, sustOff, nodeBase     // byte offsets — the editor pokes these directly
    }
}

// Decode a Metainstrument record (terranmon.txt §"Metainstrument definition"):
// byte0 = type (0 = layered), byte1 = layer count, bytes2-3 = 0xFFFF identifier,
// then `count` 10-byte layer descriptors from byte4. Each: u8 instIdx-low, u8 mixOctet
// (Perceptually-Significant-Octet dB, 159 = unity), s16 detune (4096-TET),
// u16 pitchStart, u16 pitchEnd, u8 volStart, u8 volEnd (0..63). The layer instrument
// index is 10 bits: low 8 in byte 0, bits 8..9 (the aux-bin $100..$3FF selector) in bits
// 6..7 of the volStart byte (offset +8); volStart/volEnd themselves are bits 0..5.
function decodeMetaRecord(rec) {
    const count = rec[1] & 0xFF
    const layers = []
    let o = 4
    for (let i = 0; i < count && o + 10 <= 256; i++, o += 10) {
        let det = rec[o+2] | (rec[o+3] << 8); if (det >= 0x8000) det -= 0x10000
        layers.push({
            instIdx:    (rec[o] & 0xFF) | (((rec[o+8] >> 6) & 0x3) << 8),
            mixOctet:   rec[o+1] & 0xFF,
            detune:     det,
            pitchStart: rec[o+4] | (rec[o+5] << 8),
            pitchEnd:   rec[o+6] | (rec[o+7] << 8),
            volStart:   rec[o+8] & 0x3F,
            volEnd:     rec[o+9] & 0x3F
        })
    }
    return { isMeta: true, metaType: rec[0] & 0xFF, layers }
}

// True when a 256-byte record is a Metainstrument (samplePtr high 16 bits == 0xFFFF).
function recordIsMeta(rec) { return ((rec[2] | (rec[3] << 8)) & 0xFFFF) === 0xFFFF }

// Decode the full 256-byte instrument record into a structured object suitable
// for display. Field offsets/encodings track terranmon.txt §"Instrument bin".
function decodeInstFull(rec) {
    if (recordIsMeta(rec)) return decodeMetaRecord(rec)
    const samplePtr      = (rec[0]) | (rec[1] << 8) | (rec[2] << 16) | (rec[3] * 0x1000000)
    const sampleLen      = rec[4]  | (rec[5]  << 8)
    const c4Rate         = rec[6]  | (rec[7]  << 8)
    const playStart      = rec[8]  | (rec[9]  << 8)
    const sLoopStart     = rec[10] | (rec[11] << 8)
    const sLoopEnd       = rec[12] | (rec[13] << 8)
    const sampleFlags    = rec[14]
    const igv            = rec[171]
    const fadeoutLo      = rec[172]
    const fadeoutHi      = rec[173]
    const fadeout        = fadeoutLo | ((fadeoutHi & 0x0F) << 8)
    const volSwing       = rec[174]
    const vibSpeed       = rec[175]
    const vibSweep       = rec[176]
    const defPan         = rec[177]
    const pitchPanCenter = rec[178] | (rec[179] << 8)
    let   pitchPanSep    = rec[180]; if (pitchPanSep >= 128) pitchPanSep -= 256
    const panSwing       = rec[181]
    const defCutoff      = rec[182]
    const defReso        = rec[183]
    // Filter interpretation mode — byte 173 bit 4 (terranmon §Instrument bin). false = IT (8-bit
    // cutoff/resonance in bytes 182/183), true = SoundFont (16-bit: cutoff cents in 182<<8|252,
    // resonance centibels in 183<<8|253). Mirrors AudioAdapter.TaudInst.filterSfMode.
    const filterSfMode   = ((fadeoutHi >>> 4) & 1) === 1
    const defCutoff16    = (rec[182] << 8) | rec[252]
    const defReso16      = (rec[183] << 8) | rec[253]
    let   detune         = rec[184] | (rec[185] << 8); if (detune >= 0x8000) detune -= 0x10000
    const instFlag       = rec[186]
    // NNA UI value: 0..3 = traditional (bits 0-1); 4 = Key Lift (bit 5 set,
    // bits 0-1 = 00 — the 0b100 "Nnn" pattern, terranmon byte 186).
    const nna            = ((instFlag >>> 5) & 1) ? 4 : (instFlag & 3)
    const vibWaveform    = (instFlag >>> 2) & 7
    const vibDepth       = rec[187]
    const vibRate        = rec[188]
    const dcByte         = rec[195]
    const dct            = dcByte & 3
    const dca            = (dcByte >>> 2) & 3
    const defNoteVol     = rec[196]
    // Two pf-envelope slots (slot 1 bytes 19/121/193, slot 2 bytes 197/201/199).
    // Route each into the pitch or filter role by its m-bit (LOOP-word bit 7):
    // 0 = pitch, 1 = filter — mirrors AudioAdapter.resolveActiveEnvelopes (a present
    // slot wins its role; slot 2 is processed last). Empty roles bind to the free
    // complementary slot so the Pitch/Filter tabs can create one in-place; on a
    // fully-blank instrument the defaults match midi2taud's fixed convention
    // (slot 1 = filter, slot 2 = pitch — see project_midi2taud), resolved filter-first.
    const pfEnv  = decodeEnvelope(rec, 'pf')
    const pf2Env = decodeEnvelope(rec, 'pf2')
    let pitchEnv = null, filterEnv = null
    if (pfEnv.present)  { if (pfEnv.pfFilter)  filterEnv = pfEnv;  else pitchEnv = pfEnv }
    if (pf2Env.present) { if (pf2Env.pfFilter) filterEnv = pf2Env; else pitchEnv = pf2Env }
    if (!filterEnv) filterEnv = (pitchEnv === pfEnv) ? pf2Env : pfEnv
    if (!pitchEnv)  pitchEnv  = (filterEnv === pf2Env) ? pfEnv : pf2Env
    return {
        samplePtr, sampleLen, c4Rate, playStart, sLoopStart, sLoopEnd, sampleFlags,
        igv, fadeout, volSwing, vibSpeed, vibSweep, defPan,
        pitchPanCenter, pitchPanSep, panSwing, defCutoff, defReso,
        filterSfMode, defCutoff16, defReso16,
        detune, nna, vibWaveform, vibDepth, vibRate, dct, dca, defNoteVol,
        volEnv: decodeEnvelope(rec, 'vol'),
        panEnv: decodeEnvelope(rec, 'pan'),
        pfEnv, pf2Env, pitchEnv, filterEnv
    }
}

// Scan slots 1..1023 (directly-addressable bin $01..$FF then auxiliary bin $100..$3FF).
// Keep any slot that either has a non-empty sample length, is a Metainstrument, or has a
// project-data INam entry. Returns a flat list — UI cursor walks this, not raw slot
// numbers — and a {slot → cacheIdx} reverse map for launchInstrumentViewerFor's
// jump-to-slot path. Aux-bin instruments ($100..$3FF) are the layer subinstruments of
// multi-layer Metainstruments; they are editable here but are NOT pattern-addressable.
let instrumentsCache = null
let instSlotToIdx    = null

function buildInstrumentIndex() {
    const list = []
    const names = (songsMeta && songsMeta.instNames) || []
    for (let i = 1; i < TAUT_INST_TOTAL; i++) {
        const rec = readInstRecord(i)
        const sampleLen = rec[4] | (rec[5] << 8)
        const isMeta = ((rec[2] | (rec[3] << 8)) & 0xFFFF) === 0xFFFF
        const nm = names[i] || ''
        if (sampleLen === 0 && nm === '' && !isMeta) continue
        list.push({ slot: i, name: nm, decoded: decodeInstFull(rec) })
    }
    instSlotToIdx = {}
    for (let i = 0; i < list.length; i++) instSlotToIdx[list[i].slot] = i
    return list
}

function refreshInstrumentsCache() { instrumentsCache = buildInstrumentIndex() }

// Ascending pattern-addressable instrument slots ($01..$FF) the editor's
// instrument steppers may land on: present in the instrument census and NOT a
// meta layer child (item 59 — a layer child must be referenced through its
// Metainstrument, so the '{' '}' steppers and the edit-mode seed skip it).
function selectableInstrumentSlots() {
    if (!instrumentsCache) refreshInstrumentsCache()
    const childFlags = buildMetaLayerChildSlots()
    const out = []
    for (let i = 0; i < instrumentsCache.length; i++) {
        const slot = instrumentsCache[i].slot
        if (slot > 255) break                        // aux bin: not pattern-addressable
        if (childFlags[slot]) continue
        out.push(slot)
    }
    return out
}

// ── Metainstrument audition helpers (web item 51) ───────────────────────────
// A STRICT metainstrument only sounds where its Ixmp zones actually place a
// sample, so an arbitrary jammed pitch is often silent. auditionNoteFor(slot,
// note) returns the nearest note (within the meta's layer bboxes) that will
// actually sound, or -1 when no retry is needed (not a meta / already sounds
// at `note`) or none exists. Mirrors the web engine's _metaSoundsAt /
// _auditionNoteFor; note ENTRY keeps the exact pitch — only jam auditions use
// this.
function _layerChildSoundsAt(patchCache, instIdx, note, vol) {
    // Strict gating follows the engine: the child sounds only where one of its
    // patches covers the trigger; a child with NO patches never sounds strictly.
    if (!hasIxmpAPI) return true                  // can't introspect: don't gate
    let patches = patchCache[instIdx]
    if (patches === undefined) patches = patchCache[instIdx] = decodeIxmpPatches(instIdx)
    if (patches === null) return true
    for (let i = 0; i < patches.length; i++) {
        const p = patches[i]
        if (note >= p.pitchStart && note <= p.pitchEnd &&
            vol  >= p.volStart   && vol  <= p.volEnd) return true
    }
    return false
}

function _metaSoundsAt(meta, strict, patchCache, note, vol) {
    for (let i = 0; i < meta.layers.length; i++) {
        const L = meta.layers[i]
        if (note < L.pitchStart || note > L.pitchEnd) continue
        if (vol  < L.volStart   || vol  > L.volEnd)   continue
        if (!strict) return true
        let n = note + L.detune
        if (n < 0x20) n = 0x20; else if (n > 0xFFFF) n = 0xFFFF
        if (_layerChildSoundsAt(patchCache, L.instIdx, n, vol)) return true
    }
    return false
}

// ── Project housekeeping: bank cleanup (web item 60 port) ──────────────────
// Drop instruments no pattern cell references (keeping meta-layer children of
// used metas) and free the sample bytes only they used. `usedTop` = the
// pattern-referenced slot numbers ($01..$FF) of the current song. Applies
// straight to the device — records zeroed, Ixmp cleared, pool gaps zeroed —
// and realigns songsMeta INam (blank removed slots) / SNam (rebuilt for the
// surviving census by ptr:len identity). Returns { removedInsts, freedBytes,
// keptSamples }.
function housekeepBank(usedTop) {
    refreshSamplesCache()
    // Old census names by span identity, captured BEFORE any removal.
    const oldNameByKey = {}
    for (let i = 0; i < samplesCache.length; i++) {
        const e = samplesCache[i]
        oldNameByKey[e.ptr + ':' + e.len] = e.name || ''
    }

    // Existence scan + overall content end (records cached for the closure).
    const exists = new Uint8Array(TAUT_INST_TOTAL)
    const recs = {}
    const recOf = (s) => recs[s] || (recs[s] = readInstRecord(s))
    let overallEnd = 0
    for (let s = 1; s < TAUT_INST_TOTAL; s++) {
        const rec = recOf(s)
        const isMeta = recordIsMeta(rec)
        const len = rec[4] | (rec[5] << 8)
        const hasPatches = hasIxmpAPI && audio.getInstrumentPatchCount(s) > 0
        if (len > 0 || isMeta || hasPatches) exists[s] = 1
        if (!isMeta && len > 0) {
            const d = decodeInstRecord(rec)
            if (d.samplePtr + d.sampleLen > overallEnd) overallEnd = d.samplePtr + d.sampleLen
        }
        forEachIxmpPatchSample(s, (ptr, slen) => {
            if (slen > 0 && ptr + slen > overallEnd) overallEnd = ptr + slen
        })
    }

    // Pattern-referenced slots + meta-layer dependency closure.
    const used = new Uint8Array(TAUT_INST_TOTAL)
    const queue = []
    for (let i = 0; i < usedTop.length; i++) {
        const s = usedTop[i]
        if (s >= 1 && s < TAUT_INST_TOTAL && exists[s] && !used[s]) { used[s] = 1; queue.push(s) }
    }
    while (queue.length) {
        const s = queue.pop()
        const rec = recOf(s)
        if (!recordIsMeta(rec)) continue
        const layers = decodeMetaRecord(rec).layers
        for (let i = 0; i < layers.length; i++) {
            const c = layers[i].instIdx & 0x3FF
            if (c >= 1 && c < TAUT_INST_TOTAL && exists[c] && !used[c]) { used[c] = 1; queue.push(c) }
        }
    }

    // Zero the unused records (and their Ixmp patches) on the device.
    const zeros256 = new Array(256).fill(0)
    const removed = []
    for (let s = 1; s < TAUT_INST_TOTAL; s++) {
        if (!exists[s] || used[s]) continue
        audio.uploadInstrument(s, zeros256)
        if (hasIxmpAPI) audio.uploadInstrumentPatches(s, [])
        removed.push(s)
    }

    // Surviving census (deduped by ptr:len, ptr-sorted).
    const keepKeys = {}
    const keep = []
    const addSpan = (ptr, len) => {
        if (len <= 0) return
        const k = ptr + ':' + len
        if (!keepKeys[k]) { keepKeys[k] = true; keep.push({ ptr: ptr, len: len, key: k }) }
    }
    for (let s = 1; s < TAUT_INST_TOTAL; s++) {
        if (!used[s]) continue
        const rec = recOf(s)
        if (!recordIsMeta(rec)) { const d = decodeInstRecord(rec); addSpan(d.samplePtr, d.sampleLen) }
        forEachIxmpPatchSample(s, (ptr, slen) => addSpan(ptr, slen))
    }
    keep.sort((a, b) => a.ptr - b.ptr)

    // Zero the pool gaps between kept spans, bounded by the old content end
    // (shared samples are kept; the gzip capture then compresses the freed
    // bytes to nothing).
    let freedBytes = 0
    const zeroChunk = new Uint8Array(65536)
    const zeroGap = (from, to) => {
        let n = to - from
        if (n <= 0) return
        freedBytes += n
        let at = from
        while (n > 0) {
            const take = Math.min(n, zeroChunk.length)
            writeSampleSpan(at, take === zeroChunk.length ? zeroChunk : new Uint8Array(take))
            at += take; n -= take
        }
    }
    let cursor = 0
    for (let i = 0; i < keep.length; i++) {
        const sp = keep[i]
        if (sp.ptr > cursor) zeroGap(cursor, Math.min(sp.ptr, overallEnd))
        if (sp.ptr + sp.len > cursor) cursor = sp.ptr + sp.len
    }
    if (cursor < overallEnd) zeroGap(cursor, overallEnd)

    // Names: blank removed INam entries; realign SNam to the surviving census.
    const inames = (songsMeta && songsMeta.instNames) || []
    for (let i = 0; i < removed.length; i++)
        if (removed[i] < inames.length) inames[removed[i]] = ''
    while (inames.length && !inames[inames.length - 1]) inames.pop()
    if (songsMeta) {
        const snames = keep.map((sp) => oldNameByKey[sp.key] || '')
        while (snames.length && !snames[snames.length - 1]) snames.pop()
        songsMeta.sampleNames = snames
    }

    refreshSamplesCache()
    refreshInstrumentsCache()
    clampSamplesCursor()
    clampInstrumentsCursor()
    if (HUB.markUnsaved) HUB.markUnsaved()
    return { removedInsts: removed.length, freedBytes: freedBytes, keptSamples: keep.length }
}

// ── new metainstrument from existing instruments (web item 72) ──

const META_MAX_LAYERS = 25

// True when a slot holds nothing at all (no record bytes, no patches).
function slotIsFree(slot) {
    if (slot < 1 || slot >= TAUT_INST_TOTAL) return false
    if (hasIxmpAPI && audio.getInstrumentPatchCount(slot) > 0) return false
    const rec = readInstRecord(slot)
    for (let i = 0; i < 256; i++) if (rec[i] !== 0) return false
    return true
}

// Pack a 256-byte metainstrument record — the byte-inverse of decodeMetaRecord.
// Layer 0 is the FOREGROUND layer; the rest spawn as background children.
function buildMetaRecord(layers, flagsByte) {
    const use = layers.slice(0, META_MAX_LAYERS)
    const bytes = new Array(256).fill(0)
    bytes[0] = (flagsByte || 0) & 0xFF
    bytes[1] = use.length & 0xFF            // the CAPPED count — byte 1 must match
                                            // the rows actually emitted below
    bytes[2] = 0xFF; bytes[3] = 0xFF        // samplePtr high 16 = the meta sentinel
    let o = 4
    for (let i = 0; i < use.length; i++) {
        const L = use[i]
        const det = L.detune & 0xFFFF
        bytes[o]     = L.instIdx & 0xFF
        bytes[o + 1] = L.mixOctet & 0xFF
        bytes[o + 2] = det & 0xFF; bytes[o + 3] = (det >>> 8) & 0xFF
        bytes[o + 4] = L.pitchStart & 0xFF; bytes[o + 5] = (L.pitchStart >>> 8) & 0xFF
        bytes[o + 6] = L.pitchEnd & 0xFF;   bytes[o + 7] = (L.pitchEnd >>> 8) & 0xFF
        bytes[o + 8] = (L.volStart & 0x3F) | (((L.instIdx >>> 8) & 0x3) << 6)
        bytes[o + 9] = L.volEnd & 0x3F
        o += 10
    }
    return bytes
}

// Build a metainstrument out of instruments already in the bank (web item 72).
// Each pick is COPIED into a free aux slot ($100+, which pattern cells can't
// address) and the copies become the layers — the picked originals stay put,
// still selectable and still valid in every pattern that plays them. Copies
// share their source's sample pointers, so no pool bytes are spent and the
// census (hence SNam) is unchanged. A pick must not itself be a metainstrument:
// the engine resolves layers with triggerNote, which never re-enters the meta
// branch, so metas can't nest. NOT undoable.
// Returns { metaSlot, childSlots } or { error }.
function createMetaFromInstruments(picks, name) {
    if (!picks || picks.length === 0) return { error: 'No instruments selected.' }
    if (picks.length > META_MAX_LAYERS)
        return { error: 'At most ' + META_MAX_LAYERS + ' layers (' + picks.length + ' picked).' }
    for (let i = 0; i < picks.length; i++)
        if (recordIsMeta(readInstRecord(picks[i])))
            return { error: 'A metainstrument cannot be layered inside another.' }

    const taken = {}
    let metaSlot = -1
    for (let s = 1; s <= 255; s++) if (slotIsFree(s)) { metaSlot = s; break }
    if (metaSlot < 0) return { error: 'No free instrument slots in $01-$FF.' }
    taken[metaSlot] = true

    const childSlots = []
    const layers = []
    let next = 256
    for (let i = 0; i < picks.length; i++) {
        while (next < TAUT_INST_TOTAL && (taken[next] || !slotIsFree(next))) next++
        if (next >= TAUT_INST_TOTAL) return { error: 'No free sub-instrument slots ($100+).' }
        const child = next
        taken[child] = true
        const src = readInstRecord(picks[i])
        const bytes = new Array(256)
        for (let k = 0; k < 256; k++) bytes[k] = src[k] & 0xFF
        audio.uploadInstrument(child, bytes)
        if (hasIxmpAPI && typeof audio.uploadInstrumentPatches === 'function' &&
            audio.getInstrumentPatchCount(picks[i]) > 0) {
            const blob = audio.getInstrumentPatches(picks[i])
            const copy = new Array(blob.length)
            for (let k = 0; k < blob.length; k++) copy[k] = blob[k] & 0xFF
            audio.uploadInstrumentPatches(child, copy)
        }
        childSlots.push(child)
        // Full-rect layer at unity mix, no detune: every layer sounds on every
        // trigger until the user narrows it in Advanced Edit.
        layers.push({ instIdx: child, mixOctet: 159, detune: 0,
                      pitchStart: 0x0000, pitchEnd: 0xFFFF, volStart: 0, volEnd: 63 })
    }
    audio.uploadInstrument(metaSlot, buildMetaRecord(layers, 0))

    // Names: the meta's own, and each copy inherits its source's so the layer
    // table reads meaningfully.
    if (songsMeta) {
        const inames = songsMeta.instNames || (songsMeta.instNames = [])
        const put = (slot, text) => {
            while (inames.length <= slot) inames.push('')
            inames[slot] = text || ''
        }
        for (let i = 0; i < picks.length; i++) put(childSlots[i], inames[picks[i]] || '')
        put(metaSlot, name || '')
    }
    refreshSamplesCache()
    refreshInstrumentsCache()
    clampInstrumentsCursor()
    if (HUB.invalidateMetaLayerFlags) HUB.invalidateMetaLayerFlags()
    if (HUB.markUnsaved) HUB.markUnsaved()
    return { metaSlot: metaSlot, childSlots: childSlots }
}

// ── renumber one instrument (web item 73) ──

// Move instrument `from` to the free note-addressable slot `to` ($01-$FF;
// occupied targets are refused rather than silently swapped). References that
// are pure wiring follow automatically — the Ixmp blob, the INam entry and every
// metainstrument layer pointing at `from`. Pattern cells are a musical choice
// and are handled by the caller (HUB.remapPatternInstrument). NOT undoable.
// Returns { ok: true } or { error }.
function renumberInstrument(from, to) {
    if (to < 1 || to > 255) return { error: 'An instrument number must be $01-$FF.' }
    if (from === to) return { error: 'The instrument already has that number.' }
    if (slotIsFree(from)) return { error: 'That instrument slot is empty.' }
    if (!slotIsFree(to)) return { error: '$' + to.toString(16).toUpperCase().padStart(2, '0') + ' is already taken.' }

    const src = readInstRecord(from)
    const bytes = new Array(256)
    for (let k = 0; k < 256; k++) bytes[k] = src[k] & 0xFF
    audio.uploadInstrument(to, bytes)
    audio.uploadInstrument(from, new Array(256).fill(0))

    if (hasIxmpAPI && typeof audio.uploadInstrumentPatches === 'function' &&
        audio.getInstrumentPatchCount(from) > 0) {
        const blob = audio.getInstrumentPatches(from)
        const copy = new Array(blob.length)
        for (let k = 0; k < blob.length; k++) copy[k] = blob[k] & 0xFF
        audio.uploadInstrumentPatches(to, copy)
        audio.uploadInstrumentPatches(from, [])
    }

    // Metainstrument layers are raw record bytes, and the engine only re-parses
    // them in loadRecord — so a pointing meta gets its WHOLE record re-uploaded
    // (the same gotcha commitLayers exists for).
    for (let s = 1; s < TAUT_INST_TOTAL; s++) {
        if (s === from) continue
        const rec = readInstRecord(s)
        if (!recordIsMeta(rec)) continue
        const layers = decodeMetaRecord(rec).layers
        let hit = false
        for (let i = 0; i < layers.length; i++)
            if ((layers[i].instIdx & 0x3FF) === from) { layers[i].instIdx = to; hit = true }
        if (hit) audio.uploadInstrument(s, buildMetaRecord(layers, rec[0]))
    }

    if (songsMeta) {
        const inames = songsMeta.instNames || (songsMeta.instNames = [])
        while (inames.length <= Math.max(from, to)) inames.push('')
        inames[to] = inames[from] || ''
        inames[from] = ''
        while (inames.length && !inames[inames.length - 1]) inames.pop()
    }
    refreshSamplesCache()
    refreshInstrumentsCache()
    clampInstrumentsCursor()
    if (HUB.invalidateMetaLayerFlags) HUB.invalidateMetaLayerFlags()
    if (HUB.markUnsaved) HUB.markUnsaved()
    return { ok: true }
}

// ── Ixmp patch cleanup (web item 74) ──

// A patch that can never sound: an empty pitch/velocity range, or no sample.
function patchIsDegenerate(p) {
    return p.len <= 0 || p.pitchEnd < p.pitchStart || p.volEnd < p.volStart
}

// Is `p`'s rectangle fully covered by the union of the `earlier` (higher-priority)
// patches? Patch order IS trigger-match priority — the engine takes the first hit —
// so a fully-covered patch is unreachable. Exact test: compress every boundary
// inside p onto a grid and check each cell has a coverer (pairwise containment
// would miss rectangles that only cover p when COMBINED).
function patchIsShadowed(p, earlier) {
    const covers = []
    for (let i = 0; i < earlier.length; i++) {
        const q = earlier[i]
        if (patchIsDegenerate(q)) continue
        if (q.pitchStart <= p.pitchEnd && q.pitchEnd >= p.pitchStart &&
            q.volStart <= p.volEnd && q.volEnd >= p.volStart) covers.push(q)
    }
    if (covers.length === 0) return false
    const axis = (lo, hi, getStart, getEnd) => {
        const seen = {}
        const cuts = [lo]; seen[lo] = true
        for (let i = 0; i < covers.length; i++) {
            const s = getStart(covers[i]), e = getEnd(covers[i]) + 1
            if (s > lo && s <= hi && !seen[s]) { seen[s] = true; cuts.push(s) }
            if (e > lo && e <= hi && !seen[e]) { seen[e] = true; cuts.push(e) }
        }
        return cuts.sort((a, b) => a - b)
    }
    const xs = axis(p.pitchStart, p.pitchEnd, (q) => q.pitchStart, (q) => q.pitchEnd)
    const ys = axis(p.volStart, p.volEnd, (q) => q.volStart, (q) => q.volEnd)
    for (let i = 0; i < xs.length; i++) {
        for (let j = 0; j < ys.length; j++) {
            const x = xs[i], y = ys[j]
            // (x, y) is a compressed cell's lowest corner: covering it covers the
            // whole cell (no rectangle boundary runs through a cell's interior).
            let hit = false
            for (let k = 0; k < covers.length; k++) {
                const q = covers[k]
                if (x >= q.pitchStart && x <= q.pitchEnd && y >= q.volStart && y <= q.volEnd) { hit = true; break }
            }
            if (!hit) return false
        }
    }
    return true
}

// Housekeeping: drop instrument patches that can never be triggered (web item
// 74) — orphan blobs (the slot holds no record), degenerate rectangles, and
// patches shadowed by higher-priority ones. Applies straight to the device and
// realigns songsMeta SNam to the surviving census (ptr:len identity), like
// housekeepBank. NOT undoable. Returns { removedPatches, removedBlobs, touched }.
function housekeepIxmp() {
    if (!hasIxmpAPI || typeof audio.uploadInstrumentPatches !== 'function') return null
    refreshSamplesCache()
    const oldNameByKey = {}
    for (let i = 0; i < samplesCache.length; i++) {
        const e = samplesCache[i]
        oldNameByKey[e.ptr + ':' + e.len] = e.name || ''
    }

    let removedPatches = 0, removedBlobs = 0, touched = 0
    for (let s = 1; s < TAUT_INST_TOTAL; s++) {
        if (audio.getInstrumentPatchCount(s) <= 0) continue
        const patches = decodeIxmpPatches(s)
        if (!patches || patches.length === 0) continue
        const rec = readInstRecord(s)
        let empty = true
        for (let k = 0; k < 256; k++) if (rec[k] !== 0) { empty = false; break }
        if (empty) {                          // orphan blob: nothing can trigger it
            audio.uploadInstrumentPatches(s, [])
            removedPatches += patches.length
            removedBlobs++
            touched++
            continue
        }
        const keep = []
        for (let i = 0; i < patches.length; i++) {
            const p = patches[i]
            if (patchIsDegenerate(p) || patchIsShadowed(p, keep)) { removedPatches++; continue }
            keep.push(p)
        }
        if (keep.length === patches.length) continue
        audio.uploadInstrumentPatches(s, keep.length ? encodeIxmpPatches(keep) : [])
        if (keep.length === 0) removedBlobs++
        touched++
    }
    if (touched === 0) return { removedPatches: 0, removedBlobs: 0, touched: 0 }

    // Dropped patches can drop sample spans out of the census — realign SNam.
    refreshSamplesCache()
    if (songsMeta) {
        const snames = samplesCache.map((e) => oldNameByKey[e.ptr + ':' + e.len] || '')
        while (snames.length && !snames[snames.length - 1]) snames.pop()
        songsMeta.sampleNames = snames
    }
    refreshInstrumentsCache()
    clampSamplesCursor()
    clampInstrumentsCursor()
    if (HUB.markUnsaved) HUB.markUnsaved()
    return { removedPatches, removedBlobs, touched }
}

function auditionNoteFor(slot, note) {
    if (slot < 1 || slot >= TAUT_INST_TOTAL) return -1
    const rec = readInstRecord(slot)
    if (!recordIsMeta(rec)) return -1
    const meta   = decodeMetaRecord(rec)
    const strict = (meta.metaType & 0x01) !== 0
    const vol    = 0x3F                            // jam triggers at full note volume
    const patchCache = {}
    if (_metaSoundsAt(meta, strict, patchCache, note, vol)) return -1
    let lo = 0xFFFF, hi = 0x20
    for (let i = 0; i < meta.layers.length; i++) {
        const L = meta.layers[i]
        if (L.pitchStart < lo) lo = L.pitchStart
        if (L.pitchEnd   > hi) hi = L.pitchEnd
    }
    if (lo < 0x20) lo = 0x20
    if (hi < lo) return -1
    // Sweep outward from the requested note at a fine step, clamped to the
    // bboxes' union (a jam event, so the cost is irrelevant).
    const step = 0x20
    for (let d = 0; d <= hi - lo; d += step) {
        const up = note + d, dn = note - d
        if (up >= lo && up <= hi && _metaSoundsAt(meta, strict, patchCache, up, vol)) return up
        if (dn >= lo && dn <= hi && _metaSoundsAt(meta, strict, patchCache, dn, vol)) return dn
    }
    return -1
}

// ── Layout ─────────────────────────────────────────────────────────────────
const INST_LIST_X        = 1
const INST_LIST_BODY_W   = 27
const INST_LIST_W        = INST_LIST_BODY_W + 1
const INST_LIST_SCROLL_X = INST_LIST_X + INST_LIST_BODY_W
const INST_LIST_Y        = PTNVIEW_OFFSET_Y
const INST_LIST_H        = PTNVIEW_HEIGHT
const INST_SEP_X         = INST_LIST_X + INST_LIST_W
const INST_RIGHT_X       = INST_SEP_X + 1
const INST_RIGHT_Y       = PTNVIEW_OFFSET_Y
const INST_RIGHT_W       = SCRW - INST_RIGHT_X + 1
const INST_BTN_Y         = SCRH - 1
const INST_TAB_Y         = INST_RIGHT_Y                       // tab strip row
const INST_BODY_Y        = INST_RIGHT_Y + 2                   // first content row
const INST_BODY_H        = INST_BTN_Y - INST_BODY_Y           // content rows (excludes button)

// General tab content does not fit in the 24-row body area of an 80x32 terminal,
// so it splits into two pages (sample/volume/panning on page 1;
// filter/vibrato/note-actions/tuning on page 2).
const INST_TAB_NAMES = ['Gen.1', 'Gen.2', 'Volume', 'Pan', 'Pitch', 'Filter']
const INST_TAB_GEN1 = 0, INST_TAB_GEN2 = 1, INST_TAB_VOL = 2, INST_TAB_PAN = 3, INST_TAB_PIT = 4, INST_TAB_FILT = 5

const colInstListBg     = colBackPtn
const colInstListSel    = colHighlight
const colInstListNumFg  = colInst
const colInstListNameFg = colStatus
const colInstGroupHdr   = colVoiceHdr
const colInstLabel      = colStatus
const colInstValue      = colWHITE
const colInstHighlight  = colVol
const colInstEnvLine    = 77            // bright cyan-ish, same as sample wave
const colInstEnvNode    = 198           // pink-ish — node markers stand out from line
const colInstEnvAxis    = 246           // dim grey for zero/center line
const colInstEnvHair    = 251           // darker grey — quarter-point hairlines (dashed)
const colInstEnvLoop    = 220           // muted yellow-orange — loop range band
const colInstEnvSust    = 145           // muted yellow-green — loop range band
const colInstEnvLoopSuper= 230           // muted yellow-orange — loop range band
const colInstEnvSustSuper= 155           // muted yellow-green — loop range band

let instListScroll = 0
let instListCursor = 0
let instSubTab     = INST_TAB_GEN1

// The instrument slot currently highlighted in the Instruments panel — used by the pattern
// editor as the seed "current instrument" for note jamming. Falls back to slot 1.
function getSelectedInstrumentSlot() {
    const e = instrumentsCache && instrumentsCache[instListCursor]
    return (e && e.slot) ? e.slot : 1
}

// followCursor: see clampSamplesCursor — false = free wheel scroll without moving
// the selection.
function clampInstrumentsCursor(followCursor = true) {
    const n = instrumentsCache ? instrumentsCache.length : 0
    if (instListCursor < 0) instListCursor = 0
    if (instListCursor >= n) instListCursor = Math.max(0, n - 1)
    if (followCursor) {
        if (instListCursor < instListScroll) instListScroll = instListCursor
        if (instListCursor >= instListScroll + INST_LIST_H)
            instListScroll = instListCursor - INST_LIST_H + 1
    }
    const maxS = Math.max(0, n - INST_LIST_H)
    if (instListScroll > maxS) instListScroll = maxS
    if (instListScroll < 0) instListScroll = 0
}

function drawInstrumentsListColumn() {
    const n = instrumentsCache ? instrumentsCache.length : 0
    for (let row = 0; row < INST_LIST_H; row++) {
        const idx = instListScroll + row
        const y = INST_LIST_Y + row
        con.move(y, INST_LIST_X)
        if (idx >= n) {
            con.color_pair(colInstListNameFg, colInstListBg)
            print(' '.repeat(INST_LIST_BODY_W))
            continue
        }
        const e = instrumentsCache[idx]
        const isSel = (idx === instListCursor)
        const back  = isSel ? colInstListSel : colInstListBg
        // Aux-bin slots ($100..$3FF) render as 3 hex digits; shrink the name field by
        // that extra digit so the row stays INST_LIST_BODY_W wide and aligned.
        const numStr = e.slot.toString(16).toUpperCase().padStart(2, '0')
        const nameRaw = (e.name && e.name.length) ? e.name : '(instrument $' + numStr + ')'
        const nameW = INST_LIST_BODY_W - 4 - numStr.length
        const nameStr = (nameRaw.length > nameW ? nameRaw.substring(0, nameW) : nameRaw.padEnd(nameW))
        con.color_pair(colInstListNumFg, back); print(' ' + numStr + ' ')
        con.color_pair(colInstListNameFg, back); print(' ')
        con.color_pair(isSel ? colWHITE : colInstListNameFg, back); print(nameStr)
        con.color_pair(colInstListNameFg, back); print(' ')
    }
    // scroll indicator column
    if (n > INST_LIST_H) {
        const maxScroll = n - INST_LIST_H
        const indPos = (maxScroll === 0) ? 0 : ((instListScroll * (INST_LIST_H - 1) / maxScroll) | 0)
        for (let r = 0; r < INST_LIST_H; r++) {
            con.move(INST_LIST_Y + r, INST_LIST_SCROLL_X)
            con.color_pair(colScrollBar, colInstListBg)

            let scrollChar = (r == 0) ? sym.taut_scrollgutter_top : (r == INST_LIST_H - 1) ? sym.taut_scrollgutter_bot : sym.taut_scrollgutter_mid
            if (r == indPos) scrollChar += 3;
            con.addch(scrollChar)        }
    } else {
        for (let r = 0; r < INST_LIST_H; r++) {
            con.move(INST_LIST_Y + r, INST_LIST_SCROLL_X)
            con.color_pair(colStatus, colInstListBg); print(' ')
        }
    }
}

function drawInstrumentsSeparator() {
    con.color_pair(colSep, colBackPtn)
    for (let y = INST_LIST_Y; y < SCRH; y++) {
        con.move(y, INST_SEP_X); con.prnch(VERT)
    }
}

// Geometry helper for one tab chip in the right-pane tab strip. Tabs partition
// INST_RIGHT_W into 4 equal-width chips with a 1-col gap at each boundary; the
// click handler uses the same formula in reverse to map cx → tab index.
function instTabRect(tabIdx) {
    const slotW = (INST_RIGHT_W / INST_TAB_NAMES.length) | 0
    return { x: INST_RIGHT_X + tabIdx * slotW, y: INST_TAB_Y, w: slotW }
}

function drawInstrumentsTabStrip() {
    // background row for the tab strip
    con.move(INST_TAB_Y, INST_RIGHT_X)
    con.color_pair(colTabBarOrn, colTabBarBack)
    print(' '.repeat(INST_RIGHT_W))
    for (let i = 0; i < INST_TAB_NAMES.length; i++) {
        const r = instTabRect(i)
        const active = (instSubTab === i)
        const fg = active ? colTabActive : colTabInactive
        const bg = active ? colTabBarBack2 : colTabBarBack
        con.move(r.y, r.x)
        con.color_pair(fg, bg)
        const lbl = INST_TAB_NAMES[i]
        const pad = Math.max(0, r.w - lbl.length)
        const padL = pad >>> 1
        const padR = pad - padL

        let colFore = active ? colTabActive : colTabInactive
        let colBack = active ? colTabBarBack2 : colTabBarBack
        let colFore2 = active ? colTabBarBack2 : colTabBarBack
        let colBack2 = active ? colTabBarBack : colTabBarBack
        let spcL = active ? sym.leftshade : ' '
        let spcR = active ? sym.rightshade : ' '

        con.color_pair(colFore2, colBack2); print(spcL)
        con.color_pair(colFore, colBack); print(' '.repeat(padL-1) + lbl + ' '.repeat(padR-1))
        con.color_pair(colFore2, colBack2); print(spcR)
    }
    // 1-row gap under the tabs
    con.move(INST_TAB_Y + 1, INST_RIGHT_X)
    con.color_pair(colInstValue, colBackPtn)
    print(' '.repeat(INST_RIGHT_W))
}

// Clear the right-pane body area (tab content rows + button row).
function clearInstrumentsBody() {
    for (let r = 0; r < INST_BODY_H + 1; r++) {
        con.move(INST_BODY_Y + r, INST_RIGHT_X)
        con.color_pair(colInstValue, colBackPtn)
        print(' '.repeat(INST_RIGHT_W))
    }
}

// ── Text helpers ───────────────────────────────────────────────────────────
function _hex(n, w) { return n.toString(16).toUpperCase().padStart(w, '0') }
function _signed(n) { return (n >= 0 ? '+' : '') + n }

function loopModeNameInst(flags) {
    const lp = flags & 3
    const sus = (flags >>> 2) & 1
    const names = ['None', 'Forward', 'Pingpong', 'Oneshot']
    return names[lp] + (sus ? ' (sustain)' : '')
}
// Clickable button-group option lists. NNA's 5th option is Key Lift (flag bit 5,
// the 0b100 pattern: MIDI-exact key-up — envelope jumps to the release nodes);
// DCT uses every value; DCA's 4th slot is reserved (dropped); vibrato exposes
// the 5 engine-supported waves (sine/ramp-dn/square/random/ramp-up — see
// AudioAdapter.advanceAutoVibrato).
const NNA_NAMES      = ['Off', 'Cut', 'Cont.', 'Fade', 'Lift']
const DCT_NAMES      = ['Never', 'Note', 'Sample', 'Inst.']
const DCA_OPTIONS    = ['Cut', 'Off', 'Fade']
// Filter interpretation mode (base byte 173 bit 4): IT all-pole vs SoundFont biquad.
const FILTER_MODE_OPTIONS = ['ImpulseTracker', 'SoundFont2']
const VIB_WF_OPTIONS = ['\u00D8\u00D9', '\u00A5\u00A6', '\u00B4\u00B4', '\u00F3\u00F3', '\u00B5\u00B6']//['Sine', 'Ramp-dn', 'Square', 'Random', 'Ramp-up']

// Place a value at column INST_RIGHT_X + labelW. Labels are colour
// colInstLabel; values are colInstValue. Truncates to fit INST_RIGHT_W.
function drawLabelRow(y, label, value, labelW) {
    if (labelW == null) labelW = 12
    con.move(y, INST_RIGHT_X)
    con.color_pair(colInstLabel, colBackPtn)
    print((label + ' '.repeat(labelW)).substring(0, labelW))
    con.color_pair(colInstValue, colBackPtn)
    const maxV = INST_RIGHT_W - labelW
    const v = (value == null) ? '' : String(value)
    print(v.length > maxV ? v.substring(0, maxV) : v)
}

function drawGroupHeader(y, title) {
    con.move(y, INST_RIGHT_X)
    con.color_pair(colInstGroupHdr, colBackPtn)
    const txt = '\u00FB\u00FB ' + title + ' '
    const dashes = Math.max(0, INST_RIGHT_W - txt.length)
    print(txt + `\u00FB`.repeat(dashes))
}

// ── Inline value sliders (Gen.1 / Gen.2 knob editing) ──────────────────────
// A horizontal slider painted alongside a numeric field. The knob is one 7-px
// cell wide and slides with per-pixel precision via the sym.slider1..7 glyphs
// (slider1 = knob snug in one cell; slider2..7 straddle two cells at a 1..6 px
// offset). The trough is a flat colBLACK bar capped by inverse-video round pads
// (0xAB left, 0xAA right). Two trough widths only: small (10) and wide (20).
//
// Clicking/dragging a trough drives the knob: the label updates live as the knob
// moves, and the instrument byte(s) are written only on mouse release (see
// runSliderDrag). instSliders is rebuilt on every Gen.1/Gen.2 body repaint and
// hit-tested by the panel's slider mouse region.
const SLIDER_LABEL_W  = 10
const SLIDER_END_COL  = SCRW - 1                       // common right edge
const SLIDER_SMALL_SX = SLIDER_END_COL - (SLIDER_TW_SMALL + 1)  // small left-pad col
const SLIDER_WIDE_SX  = SLIDER_END_COL - (SLIDER_TW_WIDE  + 1)  // wide  left-pad col
const SLIDER_VALUE_W  = SLIDER_SMALL_SX - (INST_RIGHT_X + SLIDER_LABEL_W)
const SLIDER_NUM_X    = INST_RIGHT_X + SLIDER_LABEL_W   // editable raw-number capsule (left-cap col)

const sliderGlyphs = [sym.slider1, sym.slider2, sym.slider3, sym.slider4,
                      sym.slider5, sym.slider6, sym.slider7]

// Rebuilt by drawInstTabGeneral1/2; each entry is
//   { y, sx, tw, troughLeftPx, min, max, render(val), commit(val) }.
let instSliders = []

// Rebuilt by drawInstTabGeneral2 (radio button groups) and the envelope tabs
// (checkboxes); hit-tested by the panel body mouse region. Cleared every redraw,
// so they only ever hold the currently-shown tab's widgets.
//   instButtons:    { y, x, w, value, commit(value) }
//   instCheckboxes: { y, xs, xe, off, bit }   (off = instrument byte, bit index)
let instButtons    = []
let instCheckboxes = []

// Paint the trough + knob for value-fraction `frac` (0..1) at (y, sx).
function drawSlider(y, sx, tw, frac) {
    const pmax = (tw - 1) * CELL_PW
    const p    = Math.round((frac < 0 ? 0 : frac > 1 ? 1 : frac) * pmax)
    const cell = (p / CELL_PW) | 0
    const sub  = p - cell * CELL_PW
    const cells = new Array(tw).fill(' ')
    if (sub === 0) cells[cell] = sliderGlyphs[0]
    else {
        const g = sliderGlyphs[sub]            // 2-char glyph straddling cell..cell+1
        cells[cell] = g[0]
        if (cell + 1 < tw) cells[cell + 1] = g[1]
    }
    con.color_pair(colBLACK, colStatus); con.move(y, sx);          con.prnch(0xAB)
    con.color_pair(colStatus, colBLACK); con.move(y, sx + 1);      print(cells.join(''))
    con.color_pair(colBLACK, colStatus); con.move(y, sx + tw + 1); con.prnch(0xAA)
}

// Pixel X (mouse) → quantised slider value, knob centred under the cursor.
// Value ⇄ trough-fraction (0..1) mapping. Linear by default; when `signedLog`
// the trough is symmetric-logarithmic (symlog) — value 0 at the centre, small
// values (fine detune) claiming most of the travel while the ±8-octave extremes
// stay reachable. log(1+|v|) is near-LINEAR through zero, so 0 is exactly the
// centre and ±1 read as distinct positions (pure log has no value at 0 and
// collapses every |v|<=1 onto the centre). Mirrors the web instruments.js path.
function sliderSpanMag(min, max) { return Math.max(Math.abs(min), Math.abs(max), 2) }
function sliderValToFrac(min, max, val, signedLog) {
    if (!signedLog) {
        const knob = (val < min) ? min : (val > max) ? max : val
        return (max === min) ? 0 : (knob - min) / (max - min)
    }
    const mag = sliderSpanMag(min, max)
    const a = Math.min(Math.abs(val), mag)
    const dir = val < 0 ? -1 : 1
    const pos = dir * (Math.log(1 + a) / Math.log(1 + mag))   // -1..1
    return (pos + 1) / 2
}
function sliderFracToVal(min, max, frac, signedLog) {
    let v
    if (!signedLog) {
        v = Math.round(min + frac * (max - min))
    } else {
        const mag = sliderSpanMag(min, max)
        const pos = frac * 2 - 1   // -1..1
        const dir = pos < 0 ? -1 : 1
        v = dir * Math.round(Math.exp(Math.abs(pos) * Math.log(1 + mag)) - 1)
    }
    return v < min ? min : v > max ? max : v
}

function sliderMouseToVal(s, pxX) {
    const pmax = (s.tw - 1) * CELL_PW
    let knob = Math.round((pxX - s.troughLeftPx) - CELL_PW / 2)
    if (knob < 0) knob = 0
    if (knob > pmax) knob = pmax
    const frac = (pmax === 0) ? 0 : knob / pmax
    return sliderFracToVal(s.min, s.max, frac, s.signedLog)
}

// Write byte pairs [[offset, value], ...] into instrument `slot`'s peripheral
// record. The audio adapter decodes these live, so edits take effect at once.
function instWriteBytes(slot, pairs) {
    const memBase = audio.getMemAddr()
    const base = instRecordBase(slot)
    for (let i = 0; i < pairs.length; i++) {
        sys.poke(memBase - (base + pairs[i][0]), pairs[i][1] & 0xFF)
    }
    HUB.markUnsaved()
}

// Drag interaction: live label updates while held, commit on release, ESC cancels.
function runSliderDrag(s, downEvent) {
    let val = sliderMouseToVal(s, downEvent[1])
    let committed = false
    s.render(val)
    let dragging = true
    while (dragging) {
        input.withEvent(e => {
            const t = e[0]
            if (t === 'mouse_move') {
                const nv = sliderMouseToVal(s, e[1])
                if (nv !== val) { val = nv; s.render(val) }
            } else if (t === 'mouse_up') {
                dragging = false; committed = true
            } else if (t === 'key_down' && e[1] === '<ESC>') {
                dragging = false
            }
            // mouse_down echo and other events are ignored during a drag
        })
    }
    if (committed) s.commit(val)
    if (s.repaint) s.repaint(); else drawInstrumentsContents()
}

// Annotation helpers — short context shown next to the raw-number capsule
// (the capsule itself already shows the decimal value). Kept terse for the
// narrow value field.
function annHex(v)    { return '$' + _hex(v, 2) }
function annHex4(v)   { return '$' + _hex(v, 4) }
function annFilter(v) { return (v === 0xFF) ? 'off' : '$' + _hex(v, 2) }
function annFadeout(v) {
    if (v <= 0)    return 'none'
    if (v >= 1024) return 'cut'
    return '~' + Math.round(1024 / v) + 't'
}
// SF-mode filter annotations. Cutoff is SoundFont absolute cents → Hz
// (8.176·2^(cents/1200), matching AudioAdapter.refreshVoiceFilter); resonance is
// centibels → dB (cb/10). Kept ≤6 cols to fit the narrow value field.
function annSfCutoff(v) {
    if (v >= 0xFFFF) return 'off'
    const hz = 8.176 * Math.pow(2, v / 1200)
    if (hz >= 10000) return Math.round(hz / 1000) + 'k'
    if (hz >= 1000)  return (hz / 1000).toFixed(1) + 'k'
    return Math.round(hz) + ''
}
function annSfReso(v) {
    if (v >= 0xFFFF) return 'flat'
    const db = v / 10
    return (db >= 10 ? Math.round(db) : db.toFixed(1)) + 'dB'
}

// Draw an editable raw-number field: a black (col 240) capsule with CP437
// half-block end caps (0xDD left, 0xDE right). The black-bg + cap scheme marks
// the field as "type a number here". `x` is the left-cap column; `digits` number
// cells follow (left-aligned, space-padded), then the right cap.
function drawNumCapsule(y, x, digits, numStr) {
    con.color_pair(colBackPtn,   colBLACK); con.move(y, x);              con.prnch(0xDD)
    con.color_pair(colInstValue, colBLACK); con.move(y, x + 1)
    print((numStr + ' '.repeat(digits)).substring(0, digits))
    con.color_pair(colBackPtn,   colBLACK); con.move(y, x + 1 + digits); con.prnch(0xDE)
}

// Emit a small-slider row: label, editable raw-number capsule, annotation, knob.
// `ann(val)` returns the short annotation (or null); `encode(val)` returns the
// byte pairs to poke on commit.
function sliderRow(y, e, label, val0, min, max, ann, encode, reupload) {
    const sx = SLIDER_SMALL_SX, tw = SLIDER_TW_SMALL
    const digits = Math.max(String(min).length, String(max).length)
    const nx = SLIDER_NUM_X, nw = digits + 2
    const annX = nx + nw, annW = sx - annX          // fill up to the slider's left pad
    const render = (val) => {
        const knob = (val < min) ? min : (val > max) ? max : val   // clamp position only
        con.move(y, INST_RIGHT_X)
        con.color_pair(colInstLabel, colBackPtn)
        print((label + ' '.repeat(SLIDER_LABEL_W)).substring(0, SLIDER_LABEL_W))
        drawNumCapsule(y, nx, digits, String(val))
        con.move(y, annX); con.color_pair(colInstValue, colBackPtn)
        const a = ann ? (' ' + ann(val)) : ''
        print((a + ' '.repeat(annW)).substring(0, annW))
        drawSlider(y, sx, tw, (max === min) ? 0 : (knob - min) / (max - min))
    }
    render(val0)
    instSliders.push({
        y, sx, tw, troughLeftPx: sx * CELL_PW, min, max, render,
        numY: y, numX: nx, numW: nw, ndig: digits,   // raw-number capsule geometry
        val: val0,                                    // base for wheel ±1 / edit prefill (clamped on use)
        commit: (v) => {
            if (reupload) {
                // Metainstrument: a live poke is invisible — getByte serves the cached
                // metaRaw and setByte uses the normal-record layout. So read the current
                // record, splice in the edited byte(s), and re-upload; loadRecord then
                // re-parses metaRaw + the layer table.
                const rec = Array.prototype.slice.call(readInstRecord(e.slot))
                const pairs = encode(v)
                for (let k = 0; k < pairs.length; k++) rec[pairs[k][0]] = pairs[k][1] & 0xFF
                audio.uploadInstrument(e.slot, rec)
                HUB.markUnsaved()
            } else {
                instWriteBytes(e.slot, encode(v))
            }
            e.decoded = decodeInstFull(readInstRecord(e.slot))
        }
    })
}

// Emit the wide two-row Detune slider: knob on `y`, cents readout on `y+1`.
// The knob spans the FULL signed 16-bit range (-32768..32767) on a signed-
// logarithmic scale — value 0 at the centre, fine control near zero in both
// directions, the ±8-octave extremes still reachable. The wheel still nudges
// ±1 for exact values.
function detuneRow(y, e, val0) {
    const sx = SLIDER_WIDE_SX, tw = SLIDER_TW_WIDE
    const min = -0x8000, max = 0x7fff
    const digits = 6                       // fits a full signed 16-bit display
    const nx = INST_RIGHT_X + 4, nw = digits + 2
    const render = (val) => {
        con.move(y, INST_RIGHT_X)
        con.color_pair(colInstLabel, colBackPtn)
        print(('  Detune:' + ' '.repeat(20)).substring(0, sx - INST_RIGHT_X))
        drawSlider(y, sx, tw, sliderValToFrac(min, max, val, true))
        // Readout row: editable raw-number capsule + cents.
        con.move(y + 1, INST_RIGHT_X); con.color_pair(colInstValue, colBackPtn); print('    ')
        drawNumCapsule(y + 1, nx, digits, String(val))
        const cents = val * 1200 / 4096   // 1 octave = 4096 TET steps = 1200 cents
        con.move(y + 1, nx + nw); con.color_pair(colInstValue, colBackPtn)
        const s = '  (' + cents.toFixed(1) + ' cents, 4096-TET)'
        print((s + ' '.repeat(INST_RIGHT_W)).substring(0, SCRW - (nx + nw) + 1))
    }
    render(val0)
    instSliders.push({
        y, sx, tw, troughLeftPx: sx * CELL_PW, min, max, signedLog: true, render,
        numY: y + 1, numX: nx, numW: nw, ndig: digits,   // capsule on the readout row
        val: val0,                                        // true value; snapped into range on interact
        commit: (v) => { instWriteBytes(e.slot, [[184, v & 0xFF], [185, (v >> 8) & 0xFF]]); e.decoded = decodeInstFull(readInstRecord(e.slot)) }
    })
}

// Hit-test the live instSliders list (Gen.1/Gen.2 only). Separate tests for the
// knob trough (drag / wheel) and the raw-number capsule (click-to-edit / wheel).
// Sliders are live on the Gen.1/Gen.2 tabs, and on the Metainstrument layer view
// (which registers per-layer Mix/Detune sliders regardless of sub-tab).
function instSlidersActive() {
    if (instSubTab === INST_TAB_GEN1 || instSubTab === INST_TAB_GEN2) return true
    const e = instrumentsCache && instrumentsCache[instListCursor]
    return !!(e && e.decoded && e.decoded.isMeta)
}
function sliderTroughAt(cy, cx) {
    if (!instSlidersActive()) return null
    for (let i = 0; i < instSliders.length; i++) {
        const s = instSliders[i]
        if (cy === s.y && cx >= s.sx && cx <= s.sx + s.tw + 1) return s
    }
    return null
}
function sliderCapsuleAt(cy, cx) {
    if (!instSlidersActive()) return null
    for (let i = 0; i < instSliders.length; i++) {
        const s = instSliders[i]
        if (cy === s.numY && cx >= s.numX && cx < s.numX + s.numW) return s
    }
    return null
}

// Hit-test the live instButtons / instCheckboxes lists. Rebuilt every body
// redraw, so they only hold the current tab's widgets — no subtab gate needed.
function instButtonAt(cy, cx) {
    for (let i = 0; i < instButtons.length; i++) {
        const b = instButtons[i]
        if (cy === b.y && cx >= b.x && cx < b.x + b.w) return b
    }
    return null
}
function instCheckboxAt(cy, cx) {
    for (let i = 0; i < instCheckboxes.length; i++) {
        const c = instCheckboxes[i]
        if (cy === c.y && cx >= c.xs && cx <= c.xe) return c
    }
    return null
}

// Open the inline number editor over a slider's capsule; commit clamps to range.
function editSliderNumber(s) {
    const nv = openInlineNumEdit(s.numY, s.numX + 1, s.ndig, s.val, s.min, s.max)
    if (nv !== null) { s.val = nv; s.commit(nv) }
    drawInstrumentsContents()   // repaint (restores capsule styling; reflects new value)
}

// ── Pill buttons & checkboxes (instrument property toggles) ─────────────────
// Reuse the input-field "capsule" look (drawNumCapsule) as a tappable control: a
// pill with CP437 half-block end caps that blend the fill colour into the panel
// background. Unselected = black fill / white text; selected = white fill / black
// text. Used as radio-style enum pickers (NNA/DCT/DCA/vibrato wave) and, in
// checkbox form, for the envelope boolean flags.

// Read-modify-write a `width`-bit field at `shift` of instrument byte `off`,
// preserving the surrounding bits. Re-reads first so a concurrent engine write
// isn't clobbered, then refreshes the decoded cache.
function instWriteField(e, off, shift, width, v) {
    const mask = ((1 << width) - 1) << shift
    const rec  = readInstRecord(e.slot)
    const nb   = (rec[off] & ~mask) | ((v << shift) & mask)
    instWriteBytes(e.slot, [[off, nb]])
    e.decoded = decodeInstFull(readInstRecord(e.slot))
}

// Flip a single bit of instrument byte `off` (checkbox click).
function toggleInstBit(e, off, bit) {
    const rec = readInstRecord(e.slot)
    instWriteBytes(e.slot, [[off, rec[off] ^ (1 << bit)]])
    e.decoded = decodeInstFull(readInstRecord(e.slot))
}

// Flip a single bit of a Metainstrument's byte via the re-upload path. A live poke is
// invisible on a meta because getByte serves the cached metaRaw and setByte uses the
// normal-record layout (same reason sliderRow re-uploads — see its commit). Used by the
// meta percussion checkbox (byte 0 bit 1).
function toggleMetaBit(e, off, bit) {
    const rec = Array.prototype.slice.call(readInstRecord(e.slot))
    rec[off] ^= (1 << bit)
    audio.uploadInstrument(e.slot, rec)
    HUB.markUnsaved()
    e.decoded = decodeInstFull(readInstRecord(e.slot))
}

// Draw one pill button at (y, x). Cap scheme mirrors drawNumCapsule so it reads
// as the same "interactive field" affordance. Returns the pill's total width
// (2 caps + a 1-space-padded label).
function drawButton(y, x, label, selected) {
    const fill  = selected ? colWHITE : colBLACK
    const txt   = selected ? colBLACK : colInstValue
    const inner = ' ' + label + ' '
    con.color_pair(colBackPtn, fill); con.move(y, x);                    con.prnch(0xDD)
    con.color_pair(txt,        fill); con.move(y, x + 1);                print(inner)
    con.color_pair(colBackPtn, fill); con.move(y, x + 1 + inner.length); con.prnch(0xDE)
    return inner.length + 2
}

// Emit a labelled radio-button group: a label, then one pill per option (the
// active one selected). Pills wrap to the next row when they would overrun the
// right pane (vibrato's 5 waves need this). Each pill is registered into
// instButtons with commit(optionIndex). Returns the number of rows consumed.
const BTN_GROUP_LABEL_W = 8
function buttonGroupRow(y, label, options, current, commit) {
    con.move(y, INST_RIGHT_X); con.color_pair(colInstLabel, colBackPtn)
    print((label + ' '.repeat(BTN_GROUP_LABEL_W)).substring(0, BTN_GROUP_LABEL_W))
    const x0 = INST_RIGHT_X + BTN_GROUP_LABEL_W
    let x = x0, rows = 1
    for (let i = 0; i < options.length; i++) {
        const w = options[i].length + 4            // ' ' + label + ' ' + 2 caps
        if (x !== x0 && x + w - 1 > SCRW) { y++; rows++; x = x0 }   // wrap to next row
        drawButton(y, x, options[i], i === current)
        instButtons.push({ y, x, w, value: i, commit })
        x += w + 1                                 // 1-col gap between pills
    }
    return rows
}

// Draw "label<capsule>" and register the label+capsule span as a clickable toggle of
// byte `off` bit `bit`. The tick glyph sits inside the same black half-block-cap capsule
// as the number fields (drawNumCapsule) so it reads as an interactive control. Returns
// the column just past the capsule, so callers can append trailing text there. `onToggle`,
// when given, replaces the default single-bit flip (used by the Pitch/Filter Present box,
// which must also stamp the slot's pitch/filter m-bit).
function drawCheckbox(y, x, label, labelW, checked, off, bit, onToggle) {
    con.move(y, x); con.color_pair(colInstLabel, colBackPtn)
    print((label + ' '.repeat(labelW)).substring(0, labelW))
    // Capsule = [▌ left cap][glyph][▐ right cap], cap colours mirroring drawNumCapsule
    // EXACTLY: fg = panel bg, bg = black, with 0xDD (left-half) / 0xDE (right-half) so the
    // black fills only the INNER half of each cap. Swapping the cap chars or the fg/bg
    // order would push the black onto the outer halves and widen the pill by 2 px.
    const gx = x + labelW
    con.color_pair(colBackPtn,   colBLACK); con.move(y, gx);     con.prnch(0xDD)
    con.color_pair(colInstValue, colBLACK); con.move(y, gx + 1); print(checked ? sym.ticked : sym.unticked)
    con.color_pair(colBackPtn,   colBLACK); con.move(y, gx + 2); con.prnch(0xDE)
    instCheckboxes.push({ y, xs: x, xe: gx + 2, off, bit, onToggle })
    return gx + 3
}

// ── Tab body: General (page 1 + page 2) ───────────────────────────────────
// Page 1 (Gen.1):
//   Sample binding   — sample link, length, c4Rate, play/loop positions, loop mode
//   Volume           — IGV, default note vol, fadeout, vol swing
//   Panning          — default pan + "use" flag, pitch-pan centre/separation, pan swing
// Page 2 (Gen.2):
//   Filter           — default cutoff/resonance
//   Vibrato          — waveform, speed, depth, sweep, rate
//   Note actions     — NNA, DCT/DCA
//   Tuning           — signed 4096-TET detune offset
//
// Two pages because the 80x32 terminal's 24-row body cannot hold every field at
// once; the user explicitly OK'd this split.
function drawInstTabGeneral1(e) {
    const d = e.decoded
    let y = INST_BODY_Y
    const sampleNames = (songsMeta && songsMeta.sampleNames) || []
    // Map decoded.samplePtr+len back to a sample-name slot (best-effort: same
    // dedup convention as buildSampleIndex).
    let sampleLabel = '(none)'
    if (d.sampleLen > 0) {
        // Walk samplesCache if it's been built; otherwise fall back to slot 0.
        if (samplesCache === null) refreshSamplesCache()
        let smpIdx = -1
        for (let i = 0; i < samplesCache.length; i++) {
            if (samplesCache[i].ptr === d.samplePtr && samplesCache[i].len === d.sampleLen) {
                smpIdx = i; break
            }
        }
        if (smpIdx >= 0) {
            const sn = sampleNames[smpIdx] || ''      // SNam is pool-ordered, 0-based
            sampleLabel = '$' + _hex(smpIdx + 1, 2) + (sn.length ? '  ' + sn : '  (unnamed)')
        } else {
            sampleLabel = '@$' + _hex(d.samplePtr, 6)
        }
    }

    // Multisample (Ixmp) instruments bind extra samples beyond the base record; flag that
    // inline with "… et al." and a wrapped count line, so the single "Sample:" field isn't
    // mistaken for the whole instrument.
    const extraN = instExtraSampleCount(e.slot, d.samplePtr, d.sampleLen)

    drawGroupHeader(y++, 'Sample binding')
    let smpVal = sampleLabel
    if (extraN > 0) {
        // Truncate the base label first so the multi-byte doubledot escape in the suffix is
        // never cut by drawLabelRow's own length clamp (which would garble the TTY stream).
        const suffix  = ' ' + sym.doubledot + ' et al.'
        const maxBase = (INST_RIGHT_W - 12) - suffix.length
        if (smpVal.length > maxBase) smpVal = smpVal.substring(0, maxBase)
        smpVal += suffix
    }
    drawLabelRow(y++, '  Sample:',  smpVal)
    if (extraN > 0)
        drawLabelRow(y++, '', '(' + extraN + ' extra sample' + (extraN === 1 ? '' : 's') + ')')
    drawLabelRow(y++, '  Length:',  d.sampleLen + ' bytes ($' + _hex(d.sampleLen, 4) + ')  Rate@C4: ' + d.c4Rate + ' Hz')
    drawLabelRow(y++, '  Play st:', '$' + _hex(d.playStart, 4))
    drawLabelRow(y++, '  Loop:',    loopModeNameInst(d.sampleFlags) +
                                    '  [$' + _hex(d.sLoopStart, 4) + '..$' + _hex(d.sLoopEnd, 4) + ']')
    // Percussion (sample-flags byte 14 bit 4): the retuner/transposer skips this
    // instrument's notes (terranmon.txt:2127-2132).
    const isPerc = ((d.sampleFlags >> 4) & 1) !== 0
    const percX  = drawCheckbox(y, INST_RIGHT_X, '  Percuss:', 12, isPerc, 14, 4)
    con.move(y, percX); con.color_pair(colInstValue, colBackPtn)
    print(isPerc ? ' on' : ' off')
    y++

    y++
    drawGroupHeader(y++, 'Volume')
    sliderRow(y++, e, '  Inst.GV:', d.igv,        0, 255,  annHex, (v) => [[171, v]])
    sliderRow(y++, e, '  DefNote:', d.defNoteVol, 0, 255,  annHex, (v) => [[196, v]])
    sliderRow(y++, e, '  Fadeout:', d.fadeout,    0, 1024, annFadeout, (v) => [[172, v & 0xFF], [173, (v >> 8) & 0x0F]])
    sliderRow(y++, e, '  Swing:',   d.volSwing,   0, 255,  annHex, (v) => [[174, v]])

    y++
    drawGroupHeader(y++, 'Panning')
    sliderRow(y++, e, '  Default:', d.defPan,      0,    255, annHex, (v) => [[177, v]])
    sliderRow(y++, e, '  Sep:',     d.pitchPanSep, -128, 127, null,       (v) => [[180, v & 0xFF]])
    sliderRow(y++, e, '  Swing:',   d.panSwing,    0,    255, annHex, (v) => [[181, v]])
    // Pitch-Pan Centre — 16-bit noteVal (bytes 178/179). Editable like the other
    // numeric fields: drag the knob, wheel ±1, or click the capsule to type a decimal;
    // the annotation shows it in the familiar $XXXX hex.
    sliderRow(y++, e, '  PPanCnt:', d.pitchPanCenter, 0, 0xFFFF, annHex4,
              (v) => [[178, v & 0xFF], [179, (v >> 8) & 0xFF]])
    // "Use default pan" mirrors the Pan tab's UseDef checkbox (pan loopWord bit 7).
    const ppx = drawCheckbox(y, INST_RIGHT_X, '  Use def.pan:', 14, d.panEnv.panUseDef, 17, 7)
    con.move(y, ppx); con.color_pair(colInstValue, colBackPtn)
    print(d.panEnv.panUseDef ? ' on' : ' off')
    y++
}

function drawInstTabGeneral2(e) {
    const d = e.decoded
    let y = INST_BODY_Y

    drawGroupHeader(y++, 'Filter')
    // Filter mode — base byte 173 bit 4 (false=IT, true=SoundFont). The two modes use
    // different value widths, so the cutoff/resonance sliders below switch range, writeback
    // bytes and annotation with the mode. Toggling re-reads the record (drawInstrumentsContents
    // re-runs after commit), so the sliders re-render in the new mode. Note: toggling does not
    // convert the stored numbers — IT byte 182 becomes the SF cutoff high byte, etc.
    y += buttonGroupRow(y, '  Mode:', FILTER_MODE_OPTIONS, d.filterSfMode ? 1 : 0,
                        (v) => instWriteField(e, 173, 4, 1, v))
    if (d.filterSfMode) {
        // SoundFont: cutoff = absolute cents (high byte 182, low byte 252), resonance =
        // centibels above DC gain (high byte 183, low byte 253). Slider spans the SF2-spec
        // initialFilterFc range (1500..13500 cents ≈ 40 Hz..20 kHz) and Q's 0..96 dB (0..960 cB).
        sliderRow(y++, e, '  Cutoff:', d.defCutoff16, 1500, 13500, annSfCutoff,
                  (v) => [[182, (v >> 8) & 0xFF], [252, v & 0xFF]])
        sliderRow(y++, e, '  Reso:',   d.defReso16,   0,    960,   annSfReso,
                  (v) => [[183, (v >> 8) & 0xFF], [253, v & 0xFF]])
    } else {
        // ImpulseTracker: 8-bit cutoff/resonance (byte 182/183); 0xFF = off.
        sliderRow(y++, e, '  Cutoff:', d.defCutoff, 0, 255, annFilter, (v) => [[182, v]])
        sliderRow(y++, e, '  Reso:',   d.defReso,   0, 255, annFilter, (v) => [[183, v]])
    }

    y++
    drawGroupHeader(y++, 'Vibrato')
    // Vibrato waveform — instFlag (byte 186) bits 2..4.
    y += buttonGroupRow(y, '  Wave:', VIB_WF_OPTIONS, d.vibWaveform & 7,
                        (v) => instWriteField(e, 186, 2, 3, v))
    sliderRow(y++, e, '  Speed:', d.vibSpeed, 0, 255, annHex, (v) => [[175, v]])
    sliderRow(y++, e, '  Depth:', d.vibDepth, 0, 255, annHex, (v) => [[187, v]])
    sliderRow(y++, e, '  Sweep:', d.vibSweep, 0, 255, annHex, (v) => [[176, v]])
    sliderRow(y++, e, '  Rate:',  d.vibRate,  0, 255, annHex, (v) => [[188, v]])

    y++
    drawGroupHeader(y++, 'Note actions')
    // NNA — instFlag (byte 186) bits 0..1; DCT/DCA — dcByte (byte 195) bits 0..1 / 2..3.
    y += buttonGroupRow(y, '  NNA:', NNA_NAMES,   d.nna, (v) => {
        instWriteField(e, 186, 5, 1, v === 4 ? 1 : 0)        // Key Lift bit
        instWriteField(e, 186, 0, 2, v === 4 ? 0 : v)        // traditional nn
    })
    y += buttonGroupRow(y, '  DCT:', DCT_NAMES,   d.dct & 3, (v) => instWriteField(e, 195, 0, 2, v))
    y += buttonGroupRow(y, '  DCA:', DCA_OPTIONS, d.dca & 3, (v) => instWriteField(e, 195, 2, 2, v))

    y++
    drawGroupHeader(y++, 'Tuning')
    detuneRow(y, e, d.detune)
    y += 2
}

// ── Envelope rendering (shared by Volume/Panning/Pitch tabs) ───────────────

// Pick a "nice" time-grid interval for `totalTime` (seconds). Aims for at most
// ~8 vertical hairlines, choosing from a fixed ladder so the number rendered
// next to "Total:" reads cleanly (no 0.157s grids). The smallest viable step
// covers fast envelopes (~50 ms); the top of the ladder covers the 15.75 s
// maximum the 3.5 minifloat can encode.
function pickEnvTimeGrid(totalTime) {
    const ladder = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0]
    for (let i = 0; i < ladder.length; i++) {
        if (totalTime / ladder[i] <= 8) return ladder[i]
    }
    return ladder[ladder.length - 1]
}

// Pixel rect of the envelope-graph area for the given tab content row range.
// Width spans the full right pane; height is the lower half of the body area.
function instEnvelopeRect() {
    const graphRowY = INST_BODY_Y + 7      // 7 rows of text above the graph
    const x = (INST_RIGHT_X - 1) * CELL_PW
    const y = (graphRowY - 1) * CELL_PH
    const w = INST_RIGHT_W * CELL_PW
    const h = (INST_BTN_Y - graphRowY) * CELL_PH
    return { x, y, w, h, graphRowY }
}

// Clear graphics overlay over the right-pane envelope graph. Called by
// drawInstrumentsContents on every redraw and by switchToPanel when leaving
// the instrument viewer (mirrors clearSampleWaveformArea for the same reason).
function clearInstrumentsEnvelopeArea() {
    const r = instEnvelopeRect()
    graphics.plotRect(r.x-2, r.y-2, r.w+4, r.h+4, 255)
    // Also clear the row of text that the graph overlays would otherwise visually
    // smudge — the body redraw paints these rows blank anyway, but switchToPanel
    // bypasses the body redraw on exit.
}

// Bresenham line via plotPixel. Used to connect envelope nodes.
function envPlotLine(x0, y0, x1, y1, col) {
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    // Guard against pathological inputs; envelope coords are screen-bound.
    let safety = 4096
    while (safety-- > 0) {
        graphics.plotPixel(x0, y0, col)
        if (x0 === x1 && y0 === y1) break
        const e2 = 2 * err
        if (e2 >= dy) { err += dy; x0 += sx }
        if (e2 <= dx) { err += dx; y0 += sy }
    }
}

// Draw the envelope chart for one envelope (vol/pan/pf). Plots:
//   • Quarter-point dashed hairlines as a faint reference grid.
//   • Solid axis line (bottom for vol, mid for pan/pitch).
//   • Loop / sustain wrap regions as faint vertical bands behind the curve.
//   • Polyline through all active nodes; each node a 3×3 marker.
// Time axis: cumulative durSec across nodes, scaled to fit graph width.
// Value axis: 0 at bottom, env.valueMax at top.
function drawEnvelopeGraph(env, rectOverride, selIdx) {
    const r = rectOverride || instEnvelopeRect()
    if (!rectOverride) clearInstrumentsEnvelopeArea()  // clear (caller clears its own area when overriding)

    // Dashed reference hairlines at quarter points of the value range. Drawn
    // first so the solid axis line / loop bands / polyline can stack on top.
    // For pan/pitch the 50% level is the main axis; we skip it here to keep
    // the solid line visually distinct from the dashes.
    const hairFracs = (env.kind === 'vol') ? [0.25, 0.5, 0.75] : [0.25, 0.75]
    for (let fi = 0; fi < hairFracs.length; fi++) {
        const yy = r.y + r.h - 1 - ((hairFracs[fi] * (r.h - 1)) | 0)
        for (let xx = r.x; xx < r.x + r.w; xx += 6) {
            graphics.plotRect(xx, yy, 2, 1, colInstEnvHair)
        }
    }

    // Solid axis line — bottom of graph for vol, mid for pan/pitch.
    if (env.kind !== 'vol') {
        const midY = r.y + (r.h >>> 1)
        graphics.plotRect(r.x, midY, r.w, 1, colInstEnvAxis)
    } else {
        graphics.plotRect(r.x, r.y + r.h - 1, r.w, 1, colInstEnvAxis)
    }

    // No envelope to draw when there are zero active nodes (shouldn't happen
    // for well-formed records, but be defensive).
    const lastIdx = (env.terminatorIdx >= 0) ? env.terminatorIdx : (env.nodes.length - 1)
    if (lastIdx < 0) return

    // Cumulative time of each node (node 0 is at t=0; node i is at sum of
    // dur[0..i-1] for i>=1). The terminator's own dur is 0 so it lands at
    // the sum of the preceding nodes.
    const xs = new Array(lastIdx + 1)
    let acc = 0
    xs[0] = 0
    for (let i = 1; i <= lastIdx; i++) {
        acc += env.nodes[i - 1].durSec
        xs[i] = acc
    }
    // When total time is 0 (single-node held envelope), give the x-axis a
    // tiny non-zero span so node 0 still renders at the left edge.
    const totalTime = Math.max(acc, 1e-6)

    const valueMax = env.valueMax || 0xFF
    // Item 37: only ENV_TIME_FRAC of the width maps the time axis; the right
    // headroom keeps the last node grabbable / extensible by drag.
    const pxX = (t) => r.x + Math.min(r.w - 1, Math.max(0, ((t / totalTime) * (r.w - 1) * ENV_TIME_FRAC) | 0))
    const pxY = (v) => r.y + r.h - 1 - Math.min(r.h - 1, Math.max(0, ((v / valueMax) * (r.h - 1)) | 0))

    // Vertical time-grid hairlines. Same dashed style as the value-axis
    // hairlines (2 px on, 4 px off) but oriented vertically; spacing comes
    // from pickEnvTimeGrid so we never spam more than ~8 lines across the
    // graph regardless of envelope duration.
    if (acc > 0) {
        const grid = pickEnvTimeGrid(totalTime)
        for (let t = grid; t < totalTime; t += grid) {
            const xx = pxX(t)
            for (let yy = r.y; yy < r.y + r.h; yy += 6) {
                graphics.plotRect(xx, yy, 1, 2, colInstEnvHair)
            }
        }
    }

    // Loop / sustain bands behind the polyline.
    if (env.loopEnable && env.loopStart <= lastIdx && env.loopEnd <= lastIdx) {
        const x0 = pxX(xs[env.loopStart])
        const x1 = pxX(xs[env.loopEnd])
        const bw = Math.max(1, x1 - x0)
        graphics.plotRect(x0, r.y, bw, r.h, colInstEnvLoop, 2)
        // start & end hairline
        graphics.plotRect(x0, r.y, 1, r.h, colInstEnvLoopSuper)
        graphics.plotRect(x1, r.y, 1, r.h, colInstEnvLoopSuper)
    }
    if (env.sustEnable && env.sustStart <= lastIdx && env.sustEnd <= lastIdx) {
        const x0 = pxX(xs[env.sustStart])
        const x1 = pxX(xs[env.sustEnd])
        const bw = Math.max(1, x1 - x0)
        graphics.plotRect(x0, r.y, bw, r.h, colInstEnvSust, 2)
        // start & end hairline
        graphics.plotRect(x0, r.y, 1, r.h, colInstEnvSustSuper)
        graphics.plotRect(x1, r.y, 1, r.h, colInstEnvSustSuper)
    }

    // Polyline through the envelope.
    for (let i = 0; i < lastIdx; i++) {
        envPlotLine(pxX(xs[i]), pxY(env.nodes[i].value),
                    pxX(xs[i + 1]), pxY(env.nodes[i + 1].value), colInstEnvLine)
    }
    // Node markers (3×3 squares centred on the node coordinate); the SELECTED
    // node (editing cursor) gets a 5×5 bright halo.
    for (let i = 0; i <= lastIdx; i++) {
        const cx = pxX(xs[i]), cy = pxY(env.nodes[i].value)
        graphics.plotRect(cx - 1, cy - 1, 3, 3, colInstEnvNode)
    }
    if (selIdx !== undefined && selIdx >= 0 && selIdx <= lastIdx) {
        const cx = pxX(xs[selIdx]), cy = pxY(env.nodes[selIdx].value)
        graphics.plotRect(cx - 2, cy - 2, 5, 5, 230)
        graphics.plotRect(cx - 1, cy - 1, 3, 3, colInstEnvNode)
    }
}

// Common envelope-tab body: a few lines of summary text above the graph, then
// the envelope graph. `extraCb`, when given, is a per-kind extra checkbox
// descriptor { label, checked, onText, offText } (e.g. pan's "Use default pan").
// Present / Carry / Loop / Sustain (+ that extra flag) are clickable checkboxes
// wired to their backing bits. Bit map (see decodeEnvelope): loopWord =
// rec[loopOff] | rec[loopOff+1]<<8, so Present is high-byte bit 5 (loopWord bit
// 13); Carry/Loop/extra are loopOff bits 6/5/7; Sustain is sustOff bit 5. The
// byte offsets come from the decoded env (slot-aware: the pitch and filter roles
// live in either of the two pf-slots — bytes 19.. or 197..). `role`
// ('pitch'/'filter') makes the Present toggle also stamp the slot's m-bit so a
// freshly-enabled role routes to the right target.
function drawInstTabEnvelope(e, env, kindLabel, extraCb, role) {
    let y = INST_BODY_Y
    const loopOff = env.loopOff
    const sustOff = env.sustOff

    drawGroupHeader(y++, kindLabel + ' envelope')

    // Present (P bit) — loopWord bit 13 lives in the high byte (loopOff+1) bit 5.
    // For a pitch/filter role, enabling Present must also set the slot's m-bit
    // (loopOff bit 7: 0 = pitch, 1 = filter) so the engine routes it correctly.
    const presentToggle = role ? (() => {
        const rec = readInstRecord(e.slot)
        let lo = rec[loopOff], hi = rec[loopOff + 1]
        hi ^= (1 << 5)                                           // flip Present
        if (role === 'filter') lo |= (1 << 7); else lo &= ~(1 << 7)   // stamp m-bit
        instWriteBytes(e.slot, [[loopOff, lo], [loopOff + 1, hi]])
        e.decoded = decodeInstFull(readInstRecord(e.slot))
    }) : null
    let px = drawCheckbox(y, INST_RIGHT_X, '  Present:', 12, env.present, loopOff + 1, 5, presentToggle)
    con.move(y, px); con.color_pair(colInstValue, colBackPtn)
    print(env.present ? ' yes (P=1)' : ' no  (P=0)')
    y++

    // Node count + Carry checkbox share one row so the text block stays ≤ 7 rows
    // (the envelope graph below starts at INST_BODY_Y + 7).
    const realCount = (env.terminatorIdx >= 0) ? (env.terminatorIdx + 1) : env.nodes.length
    con.move(y, INST_RIGHT_X); con.color_pair(colInstLabel, colBackPtn)
    print(('  Nodes:' + ' '.repeat(12)).substring(0, 12))
    con.move(y, INST_RIGHT_X + 12); con.color_pair(colInstValue, colBackPtn)
    print((realCount + ' / 25' + ' '.repeat(8)).substring(0, 8))
    drawCheckbox(y, INST_RIGHT_X + 21, 'Carry:', 7, env.carry, loopOff, 6)
    y++

    // Loop enable (+ range when on)
    let lx = drawCheckbox(y, INST_RIGHT_X, '  Loop:', 12, env.loopEnable, loopOff, 5)
    con.move(y, lx); con.color_pair(colInstValue, colBackPtn)
    print(env.loopEnable ? (' [' + env.loopStart + '..' + env.loopEnd + ']') : ' off')
    y++

    // Sustain enable (+ range when on)
    let sx = drawCheckbox(y, INST_RIGHT_X, '  Sustain:', 12, env.sustEnable, sustOff, 5)
    con.move(y, sx); con.color_pair(colInstValue, colBackPtn)
    print(env.sustEnable ? (' [' + env.sustStart + '..' + env.sustEnd + ']') : ' off')
    y++

    // Per-kind extra flag (Pan: use-default-pan) — rides loopWord bit 7 (loopOff
    // bit 7). The pf-slots use that same bit as the pitch/filter m-bit, which the
    // tab itself now owns (see presentToggle), so they pass no extraCb.
    if (extraCb) {
        let ex = drawCheckbox(y, INST_RIGHT_X, extraCb.label, 12, extraCb.checked, loopOff, 7)
        con.move(y, ex); con.color_pair(colInstValue, colBackPtn)
        print(' ' + (extraCb.checked ? extraCb.onText : extraCb.offText))
        y++
    }

    // Total envelope length + the time-grid step the graph below uses, so the
    // dashed vertical hairlines have a readable scale.
    const lastIdx = (env.terminatorIdx >= 0) ? env.terminatorIdx : (env.nodes.length - 1)
    let totalSec = 0
    for (let i = 0; i < lastIdx; i++) totalSec += env.nodes[i].durSec
    const gridStep = pickEnvTimeGrid(Math.max(totalSec, 1e-6))
    // Editing cursor: reset the node selection when the inst/tab changed, clamp
    // to the node count, and show the selected node's value + duration.
    const selKey = e.slot + ':' + instSubTab
    if (selKey !== envSelKey) { envSelKey = selKey; envSelNode = 0 }
    if (envSelNode > lastIdx) envSelNode = lastIdx
    const selN = env.nodes[envSelNode]
    drawLabelRow(y++, '  Length:', totalSec.toFixed(3) + ' s  grid ' + gridStep + ' s'
        + '  N' + envSelNode + ': v=' + (selN ? selN.value : 0)
        + ' d=' + (selN ? selN.durSec.toFixed(3) : '0') + 's')

    drawEnvelopeGraph(env, undefined, envSelNode)
}

function drawInstTabVolume(e)  { drawInstTabEnvelope(e, e.decoded.volEnv, 'Volume', null) }
function drawInstTabPanning(e) {
    drawInstTabEnvelope(e, e.decoded.panEnv, 'Panning', {
        label: '  UseDef:', checked: e.decoded.panEnv.panUseDef,
        onText: 'on   (chan-pan source: byte $B1)',
        offText: 'off  (chan-pan source: byte $B1)'
    })
}
// Pitch and Filter each get their own tab now (the record carries two pf-slots,
// one per role — see decodeInstFull). Each tab edits whichever slot its role
// resolved to; the Present toggle stamps the slot's m-bit for that role.
function drawInstTabPitch(e)  { drawInstTabEnvelope(e, e.decoded.pitchEnv,  'Pitch',  null, 'pitch')  }
function drawInstTabFilter(e) { drawInstTabEnvelope(e, e.decoded.filterEnv, 'Filter', null, 'filter') }

// Metainstrument view (terranmon.txt §"Metainstrument definition"): the record
// carries no sample of its own — only a layer table fanned out at trigger time.
// One row per layer: target instrument, mix volume (Perceptually-Significant
// octet; 159 = unity), sample detune (4096-TET → cents), and the pitch × velocity
// rectangle that gates the layer.
function metaMixAnn(v)  { return (v === 159) ? 'unity' : ('$' + _hex(v, 2)) }
function metaDetAnn(v)  { const c = v * 1200 / 4096; return (c >= 0 ? '+' : '') + c.toFixed(0) + 'c' }

function drawInstTabMeta(e) {
    const d = e.decoded
    let y = INST_BODY_Y
    drawGroupHeader(y++, 'Metainstrument  (' + d.layers.length + ' layer' +
                         (d.layers.length === 1 ? '' : 's') + ')')
    // Percussion (type/flags byte 0 bit 1): the retuner/transposer skips notes that
    // reference this meta (terranmon.txt:2419-2428). A meta carries its own P bit —
    // bytes 4.. are the layer table, so there is no byte-14 flag to read here. The
    // onToggle re-uploads (a live poke is invisible on a meta — see toggleMetaBit).
    const isPerc = ((d.metaType >> 1) & 1) !== 0
    const percX  = drawCheckbox(y, INST_RIGHT_X, '  Percuss:', 12, isPerc, 0, 1,
                                (ee) => toggleMetaBit(ee, 0, 1))
    con.move(y, percX); con.color_pair(colInstValue, colBackPtn)
    print(isPerc ? ' on' : ' off')
    y++
    // Each layer gets a read-only context line (target inst + pitch/vel rect) plus an
    // editable Mix-volume and Detune slider (registered in instSliders, so mouse drag /
    // wheel / click-to-type all work; commit re-uploads the record so the engine re-parses
    // the layer table). Fit as many as the body allows.
    const rowsPerLayer = 3
    const avail = INST_BTN_Y - y - 1
    const shown = Math.min(d.layers.length, Math.max(1, (avail / rowsPerLayer) | 0))
    for (let i = 0; i < shown; i++) {
        const L = d.layers[i]
        const o = 4 + i * 10                       // byte offset of this layer's descriptor
        const rect = 'pitch ' + noteToStr(L.pitchStart) + sym.doubledot + noteToStr(L.pitchEnd) +
                     '  vel ' + L.volStart + sym.doubledot + L.volEnd
        con.move(y, INST_RIGHT_X); con.color_pair(colInstGroupHdr, colBackPtn)
        print((' L' + i + ' \u008426u inst $' + _hex(L.instIdx, 2) + '  ' + rect + ' '.repeat(INST_RIGHT_W))
              .substring(0, INST_RIGHT_W))
        y++
        sliderRow(y++, e, '  Mix:', L.mixOctet, 0, 255, metaMixAnn,
                  (v) => [[o + 1, v & 0xFF]], true)
        sliderRow(y++, e, '  Detune:', L.detune, -4096, 4096, metaDetAnn,
                  (v) => [[o + 2, v & 0xFF], [o + 3, (v >> 8) & 0xFF]], true)
    }
    if (shown < d.layers.length) {
        con.move(y, INST_RIGHT_X); con.color_pair(colInstGroupHdr, colBackPtn)
        print(` ${sym.doubledot}${sym.doubledot} ` + (d.layers.length - shown) + ' more layer(s) (resize / not shown)')
    }
}

// ── Edit button (bottom row) ───────────────────────────────────────────────
function drawInstrumentsEditButton() {
    const y = INST_BTN_Y
    con.move(y, INST_RIGHT_X)
    con.color_pair(colInstGroupHdr, colBackPtn); print('[ E ]')
    con.color_pair(colInstValue,    colBackPtn)
    const label = ' Advanced Edit'
    print(label)
    const rest = INST_RIGHT_W - (5 + label.length)
    if (rest > 0) print(' '.repeat(rest))
}

function clearInstrumentsPanel() {
    for (let y = PTNVIEW_OFFSET_Y; y < SCRH; y++) fillLine(y, colInstValue, colBackPtn)
}

function drawInstrumentsContents(wo) {
    if (instrumentsCache === null) refreshInstrumentsCache()
    clampInstrumentsCursor(false)             // respect the current scroll (free wheel scroll)
    instSliders.length = 0   // rebuilt by the Gen.1/Gen.2 body drawers below
    instButtons.length = 0   // rebuilt by Gen.2 button groups
    instCheckboxes.length = 0 // rebuilt by Gen.1 / envelope-tab checkboxes
    clearInstrumentsPanel()
    drawInstrumentsListColumn()
    drawInstrumentsSeparator()
    drawInstrumentsTabStrip()

    const n = instrumentsCache ? instrumentsCache.length : 0
    if (n === 0) {
        con.move(INST_BODY_Y, INST_RIGHT_X)
        con.color_pair(colInstGroupHdr, colBackPtn)
        print('No instruments in this project.')
        // wipe any old envelope graph
        clearInstrumentsEnvelopeArea()
        drawInstrumentsEditButton()
        return
    }
    const e = instrumentsCache[instListCursor]
    // Body redraw wipes its rows before re-rendering, so don't paint the graph
    // until after the text tabs are drawn — otherwise plotRect-555 fill at the
    // end of the body redraw would erase the graph again.
    clearInstrumentsEnvelopeArea()
    // Metainstruments have no sample/envelopes — show their layer table on every
    // sub-tab (the Gen/env drawers would read absent fields and mis-render).
    if (e.decoded.isMeta)                  drawInstTabMeta(e)
    else if (instSubTab === INST_TAB_GEN1) drawInstTabGeneral1(e)
    else if (instSubTab === INST_TAB_GEN2) drawInstTabGeneral2(e)
    else if (instSubTab === INST_TAB_VOL)  drawInstTabVolume(e)
    else if (instSubTab === INST_TAB_PAN)  drawInstTabPanning(e)
    else if (instSubTab === INST_TAB_PIT)  drawInstTabPitch(e)
    else                                   drawInstTabFilter(e)
    drawInstrumentsEditButton()
    // List redraw wiped col 1 across every row — invalidate, then re-stamp
    // immediately while playing so the live indicator isn't blank for a frame.
    invalidateInstrumentsBlob()
    if (HUB.getPlaybackMode() !== PLAYMODE_NONE) drawInstrumentsPlayBlobs()
    // Envelope-graph cursor: the panel rebuild wiped any prior hairline; invalidate
    // and re-stamp so the user doesn't see it blink off on tab / inst switches.
    invalidateEnvCursor()
    if (HUB.getPlaybackMode() !== PLAYMODE_NONE) drawEnvelopeCursor()
}

function instrumentsInput(wo, event) {
    if (event[0] !== 'key_down') return
    const keysym     = event[1]
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 8 : 1

    const n = instrumentsCache ? instrumentsCache.length : 0
    if (n === 0) {
        if (keysym === '\n' || keysym === 'E') {   // Enter / Shift+E opens a new instrument
            openAdvancedInstEdit(-1)
        }
        return
    }
    if (keysym === '<UP>')        { instListCursor -= moveDelta; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<DOWN>')      { instListCursor += moveDelta; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<PAGE_UP>')   { instListCursor -= INST_LIST_H; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<PAGE_DOWN>') { instListCursor += INST_LIST_H; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<HOME>')      { instListCursor = 0; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<END>')       { instListCursor = n - 1; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    // Tab cycling. <LEFT>/<RIGHT> walk subtab, mirroring the IT mouse-tab feel.
    if (keysym === '<LEFT>')      { instSubTab = (instSubTab + INST_TAB_NAMES.length - 1) % INST_TAB_NAMES.length; drawInstrumentsContents(); return }
    if (keysym === '<RIGHT>')     { instSubTab = (instSubTab + 1) % INST_TAB_NAMES.length; drawInstrumentsContents(); return }
    // Number keys 1..6 jump directly to a tab. Convenient when arrow keys are taken.
    if (keysym === '1') { instSubTab = INST_TAB_GEN1; drawInstrumentsContents(); return }
    if (keysym === '2') { instSubTab = INST_TAB_GEN2; drawInstrumentsContents(); return }
    if (keysym === '3') { instSubTab = INST_TAB_VOL;  drawInstrumentsContents(); return }
    if (keysym === '4') { instSubTab = INST_TAB_PAN;  drawInstrumentsContents(); return }
    if (keysym === '5') { instSubTab = INST_TAB_PIT;  drawInstrumentsContents(); return }
    if (keysym === '6') { instSubTab = INST_TAB_FILT; drawInstrumentsContents(); return }
    // Envelope node editing on the env tabs (web M7/M8 port): ',' '.' select
    // node, '-'/'=' value -/+1 ('_'/'+' -/+8), '[' ']' preceding-segment
    // duration -/+1 ('{' '}' -/+16 — overriding the octave/inst steppers on
    // these tabs), 'n' adds a node after the selection, 'x' deletes it.
    if (keyJustHit && instSubTab >= INST_TAB_VOL) {
        const selE = instrumentsCache[instListCursor]
        if (selE && !selE.decoded.isMeta) {
            const envB = envBundleForCurrentTab(selE)
            if (envB && envHandleKey(selE, envB.env, keysym)) return
        }
    }
    // [ ] steps the jam octave, { } the current pattern instrument (web item 47.2).
    if (keyJustHit && (keysym === '[' || keysym === ']')) { if (HUB.stepJamOctave) HUB.stepJamOctave(keysym === ']' ? 1 : -1); return }
    if (keyJustHit && (keysym === '{' || keysym === '}')) { if (HUB.stepCurrentInstrument) HUB.stepCurrentInstrument(keysym === '}' ? 1 : -1); return }
    // Note jamming: audition the selected instrument with the piano keys (a..k / w..u).
    const sel = instrumentsCache[instListCursor]
    if (HUB.tryJamFromEvent && HUB.tryJamFromEvent(event, sel ? sel.slot : 0)) return
    // Open Advanced Edit: Enter or Shift+E (lowercase 'e' is the D# jam key).
    if (keysym === '\n' || keysym === 'E') {
        if (sel) openAdvancedInstEdit(sel.slot)
        return
    }
    // Uppercase, so the lowercase piano jam keeps working: M = new
    // metainstrument (web item 72), R = renumber this instrument (item 73).
    if (keyJustHit && keysym === 'M') { openNewMetaPopup(); return }
    if (keyJustHit && keysym === 'R') { if (sel) openRenumberPopup(sel.slot); return }
}

// New-metainstrument popup (web item 72): tick the instruments to layer, name
// it, and createMetaFromInstruments copies each pick into a $100+ sub-slot.
// Metainstruments are not offered — layers can't nest (see createMetaFromInstruments).
function openNewMetaPopup() {
    const chrome = { drawFrame: HUB.popups.popupDrawFrame, colours: HUB.popups.popupColours }
    const cache = instrumentsCache || []
    const childFlags = buildMetaLayerChildSlots()
    const items = []
    for (let i = 0; i < cache.length; i++) {
        const e = cache[i]
        if (e.slot > 255 || childFlags[e.slot] || e.decoded.isMeta) continue
        items.push({ slot: e.slot, picked: false,
                     label: '$' + e.slot.toString(16).toUpperCase().padStart(2, '0') +
                            ' ' + (e.name || '').substring(0, 20) })
    }
    if (items.length === 0) {
        win.showDialog(Object.assign({ title: 'New metainstrument',
            message: ['No ordinary instruments to layer.'],
            buttons: [{ label: 'OK', action: 'ok', default: true }] }, chrome))
        return
    }
    const res = win.showDialog(Object.assign({
        title: 'New metainstrument',
        message: ['Picks are COPIED to $100+ and layered;', 'the originals stay in the list.'],
        fields: [{ label: 'Name:', width: 22, initial: '' }],
        list: {
            items: items, height: Math.min(items.length, 10), width: 30,
            drawWell: false, scrollbarChars: HUB.popups.popupScrollbarChars,
            renderItem: (ctx) => {
                const it = ctx.item
                con.move(ctx.y, ctx.x)
                const useBg = (ctx.isCursor && ctx.focused) ? colHighlight : C.colPopupBack
                con.color_pair(it.picked ? colVoiceHdr : colWHITE, useBg)
                const line = ' ' + (it.picked ? sym.ticked : sym.unticked) + ' ' + it.label
                print(line.padEnd(ctx.w, ' ').substring(0, ctx.w))
            },
            // Space / click ticks a row; Enter commits through OK.
            onActivate: (item, _idx, key) => {
                if (key === ' ' || key === 'click') { item.picked = !item.picked; return null }
                if (key === '\n') return 'ok'
                return null
            },
        },
        buttons: [{ label: 'Create', action: 'ok' }, { label: 'Cancel', action: 'cancel' }],
    }, chrome))
    if (res.action !== 'ok') return
    const picks = items.filter((it) => it.picked).map((it) => it.slot)
    const r = createMetaFromInstruments(picks, ('' + (res.values[0] || '')).trim())
    const msg = r.error ? r.error
        : 'Created meta $' + r.metaSlot.toString(16).toUpperCase().padStart(2, '0') +
          ' with ' + r.childSlots.length + ' layer(s).'
    if (!r.error) {
        // Land on the new meta so Advanced Edit is one keypress away.
        for (let i = 0; i < instrumentsCache.length; i++)
            if (instrumentsCache[i].slot === r.metaSlot) { instListCursor = i; break }
        clampInstrumentsCursor()
    }
    win.showDialog(Object.assign({ title: 'New metainstrument', message: [msg],
        buttons: [{ label: 'OK', action: 'ok', default: true }] }, chrome))
}

// Renumber-instrument popup (web item 73): hex target + an opt-in tick for the
// pattern cells (off by default — moving an instrument out from under its notes
// is a musical decision, while the patches/name/layer wiring always follows).
function openRenumberPopup(from) {
    const chrome = { drawFrame: HUB.popups.popupDrawFrame, colours: HUB.popups.popupColours }
    const hex2 = (v) => '$' + v.toString(16).toUpperCase().padStart(2, '0')
    const refs = HUB.countPatternInstrument ? HUB.countPatternInstrument(from) : 0
    const cellRow = { picked: false, label: 'Point ' + refs + ' pattern cell(s) at it' }
    const res = win.showDialog(Object.assign({
        title: 'Renumber instrument ' + hex2(from),
        message: ['Patches, name and metainstrument', 'layers follow automatically.'],
        fields: [{ label: 'New number (hex):', width: 4, maxLength: 2,
                   initial: from.toString(16).toUpperCase().padStart(2, '0') }],
        list: refs > 0 ? {
            items: [cellRow], height: 1, width: 30, drawWell: false, showScrollbar: false,
            scrollbarChars: HUB.popups.popupScrollbarChars,
            renderItem: (ctx) => {
                const it = ctx.item
                con.move(ctx.y, ctx.x)
                const useBg = (ctx.isCursor && ctx.focused) ? colHighlight : C.colPopupBack
                con.color_pair(it.picked ? colVoiceHdr : colWHITE, useBg)
                const line = ' ' + (it.picked ? sym.ticked : sym.unticked) + ' ' + it.label
                print(line.padEnd(ctx.w, ' ').substring(0, ctx.w))
            },
            onActivate: (item, _idx, key) => {
                if (key === ' ' || key === 'click') { item.picked = !item.picked; return null }
                if (key === '\n') return 'ok'
                return null
            },
        } : null,
        buttons: [{ label: 'Renumber', action: 'ok' }, { label: 'Cancel', action: 'cancel' }],
    }, chrome))
    if (res.action !== 'ok') return
    const to = parseInt(('' + (res.values[0] || '')).replace('$', '').trim(), 16)
    let msg
    if (!isFinite(to)) msg = 'That is not a hexadecimal number.'
    else {
        const r = renumberInstrument(from, to)
        if (r.error) msg = r.error
        else {
            let moved = 0
            if (cellRow.picked && HUB.remapPatternInstrument) moved = HUB.remapPatternInstrument(from, to)
            msg = 'Moved ' + hex2(from) + ' to ' + hex2(to) +
                  (moved ? '; ' + moved + ' pattern cell(s) followed.' : '.')
            for (let i = 0; i < instrumentsCache.length; i++)
                if (instrumentsCache[i].slot === to) { instListCursor = i; break }
            clampInstrumentsCursor()
        }
    }
    win.showDialog(Object.assign({ title: 'Renumber instrument', message: [msg],
        buttons: [{ label: 'OK', action: 'ok', default: true }] }, chrome))
}

function registerInstrumentsMouse() {
    // Left list
    addPanelMouseRegion(INST_LIST_X, INST_LIST_Y, INST_SEP_X - INST_LIST_X, INST_LIST_H, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            const n = instrumentsCache ? instrumentsCache.length : 0
            const target = instListScroll + (cy - INST_LIST_Y)
            if (target < 0 || target >= n) return
            instListCursor = target
            clampInstrumentsCursor()
            drawInstrumentsContents()
        },
        onWheel: (cy, cx, dy) => {
            // free scroll: move the view, not the selection (cursor may scroll off)
            const n = instrumentsCache ? instrumentsCache.length : 0
            const maxS = Math.max(0, n - INST_LIST_H)
            instListScroll = Math.max(0, Math.min(maxS, instListScroll + dy * 3))
            drawInstrumentsContents()
        }
    })
    // Right-pane tab strip: clicking a chip selects that tab.
    for (let i = 0; i < INST_TAB_NAMES.length; i++) {
        const idx = i
        const r = instTabRect(i)
        addPanelMouseRegion(r.x, r.y, r.w, 1, {
            onClick: (cy, cx, btn) => {
                if (btn !== 1) return
                instSubTab = idx
                drawInstrumentsContents()
            }
        })
    }
    // Edit button
    addPanelMouseRegion(INST_RIGHT_X, INST_BTN_Y, 22, 1, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            const n = instrumentsCache ? instrumentsCache.length : 0
            const slot = (n > 0) ? instrumentsCache[instListCursor].slot : -1
            openAdvancedInstEdit(slot)
        }
    })
    // Slider body (Gen.1 / Gen.2): one region that hit-tests the live instSliders
    // list. Click the raw-number capsule to type a value; click/drag the knob to
    // slide; wheel over either nudges by ±1 (wheel up = +1) and commits each notch.
    addPanelMouseRegion(INST_RIGHT_X, INST_BODY_Y, INST_RIGHT_W, INST_BODY_H, {
        onClick: (cy, cx, btn, ev) => {
            if (btn !== 1) return
            const e = instrumentsCache ? instrumentsCache[instListCursor] : null
            const cb = instCheckboxAt(cy, cx)
            if (cb) { if (e) { if (cb.onToggle) cb.onToggle(e); else toggleInstBit(e, cb.off, cb.bit); drawInstrumentsContents() } return }
            const b = instButtonAt(cy, cx)
            if (b) { b.commit(b.value); drawInstrumentsContents(); return }
            const c = sliderCapsuleAt(cy, cx)
            if (c) { editSliderNumber(c); return }
            const s = sliderTroughAt(cy, cx)
            if (s) { runSliderDrag(s, ev); return }
            // Env tabs: grab + drag the nearest envelope node (2D edit).
            envMouseDown(ev)
        },
        onHover: (cy, cx, ev) => {
            // Continue an envelope-node drag while the button stays held.
            if (!envDragState) return
            if ((sys.peek(-37) & 0x01) === 0) {
                envDragState = null
                drawInstrumentsContents()
                return
            }
            const e = instrumentsCache ? instrumentsCache[instListCursor] : null
            if (e) envApplyDrag(e, ev[1], ev[2])
        },
        onRelease: () => {
            if (envDragState) { envDragState = null; drawInstrumentsContents() }
        },
        onWheel: (cy, cx, dy) => {
            const s = sliderTroughAt(cy, cx) || sliderCapsuleAt(cy, cx)
            if (!s) return
            const nv = Math.max(s.min, Math.min(s.max, s.val + (dy < 0 ? 1 : -1)))
            if (nv === s.val) return
            s.val = nv
            s.render(nv)
            s.commit(nv)
        }
    })
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// END INSTRUMENTS VIEWER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// LIVE-PLAY BLOB (Samples / Instruments column 1)
/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Per-row marker painted in column 1 of the Samples / Instruments list while a
// voice is actively sounding the corresponding sample / instrument. The glyph
// (sym.blob1..blob10) tracks the loudest active voice that references the row;
// sym.blob0 wipes the cell. The glyph FOREGROUND is colour-coded by polyphony —
// the number of notes (live voices + NNA ghosts) currently sounding the row —
// via a green→yellow→orange→red heat ramp. Per-row last-drawn (level, colour
// bucket) is cached so the per-frame repaint only redraws rows that changed —
// mirrors the bounded-work pattern used by drawVoiceMeters().

const smpBlobPrev  = new Array(SMP_LIST_H).fill(-1)
const instBlobPrev = new Array(INST_LIST_H).fill(-1)

// Polyphony heat ramp for the blob foreground: more simultaneously-sounding notes → hotter.
const colBlobPoly1 = 34   // blue  — 1 note
const colBlobPoly2 = 76   // green  — 2 note
const colBlobPoly3 = 230  // yellow — 3 notes
const colBlobPoly4 = 221  // orange — 4 notes
const colBlobPoly5 = 211  // red    — 5+ notes
const blobPolyCols = [colBlobPoly1, colBlobPoly2, colBlobPoly3, colBlobPoly4, colBlobPoly5]

// Note count → ramp bucket: 0 (silent), 1..3 verbatim, 4+ saturates at 4.
function blobPolyBucket(count) {
    if (count <= 0) return 0
    return count >= 5 ? 5 : count
}

// getActiveNoteCounts (the foreground+ghost polyphony API) ships with this feature; on an
// un-rebuilt host VM it's absent and blobs fall back to the plain number-column colour.
const hasNoteCountAPI = (typeof audio !== 'undefined' && typeof audio.getActiveNoteCounts === 'function')

// getVoiceSamplePtr/Length expose the sample a voice is ACTUALLY sounding (the resolved Ixmp
// patch sample, not just the instrument's base record). When present, the Samples blobs and
// waveform cursor key off the true (ptr,len) so a multisample instrument only lights / cursors
// the one sample currently playing. Absent on an un-rebuilt host → fall back to instrument match
// (every sample the playing instrument references lights up, the old behaviour).
const hasVoiceSampleAPI = (typeof audio !== 'undefined' &&
    typeof audio.getVoiceSamplePtr === 'function' &&
    typeof audio.getVoiceSampleLength === 'function')

// getVoiceEnvFilter{Index,Time} expose the filter-envelope playhead for the new
// Filter tab's live cursor. Absent on an un-rebuilt host → the Filter graph still
// draws, only the moving cursor is skipped (see envBundleForCurrentTab).
const hasFilterEnvAPI = (typeof audio !== 'undefined' &&
    typeof audio.getVoiceEnvFilterIndex === 'function' &&
    typeof audio.getVoiceEnvFilterTime === 'function')

function invalidateSamplesBlob()     { for (let i = 0; i < smpBlobPrev.length;  i++) smpBlobPrev[i]  = -1 }
function invalidateInstrumentsBlob() { for (let i = 0; i < instBlobPrev.length; i++) instBlobPrev[i] = -1 }

// Walks the live voice slots and returns {instrumentId → loudest effective volume}.
// Silent / inactive voices are skipped. Volumes are 0.0..1.0.
function activeInstVolumes() {
    const out = {}
    const numVox = (HUB.getSong() && HUB.getSong().numVoices) ? HUB.getSong().numVoices : NUM_VOICES
    for (let v = 0; v < numVox; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        const inst = audio.getVoiceInstrument(PLAYHEAD, v)
        if (!inst) continue
        const vol = audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0
        if (!(vol > 0)) continue
        if (!(inst in out) || out[inst] < vol) out[inst] = vol
    }
    return out
}

// Per-SAMPLE live stats keyed by "ptr:len" → { vol, count } across the voices ACTUALLY
// sounding that exact sample (max effective volume + voice count for the polyphony heat ramp).
// Only meaningful when hasVoiceSampleAPI; lets the Samples tab light just the playing sample of
// a multisample instrument rather than every sample it references.
function activeSampleStats() {
    const out = {}
    const numVox = (HUB.getSong() && HUB.getSong().numVoices) ? HUB.getSong().numVoices : NUM_VOICES
    for (let v = 0; v < numVox; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        const len = audio.getVoiceSampleLength(PLAYHEAD, v)
        if (len <= 0) continue
        const key = audio.getVoiceSamplePtr(PLAYHEAD, v) + ':' + len
        const vol = audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0
        let s = out[key]
        if (!s) s = out[key] = { vol: 0, count: 0 }
        if (vol > s.vol) s.vol = vol
        s.count++
    }
    return out
}

// 0.0 → 0 (clear); (0, 1] → 1..10 via ceil so the quietest audible voice still shows blob1.
function blobLevelForVolume(v) {
    if (!(v > 0)) return 0
    let lvl = Math.ceil(v * 10)
    if (lvl < 1)  lvl = 1
    if (lvl > 10) lvl = 10
    return lvl
}

function drawSamplesPlayBlobs() {
    if (HUB.getPanel() !== VIEW_SAMPLES || !samplesCache) return
    const playing  = (HUB.getPlaybackMode() !== PLAYMODE_NONE)
    // Prefer the per-sample stats (lights only the actually-sounding sample of a multisample
    // instrument); fall back to the instrument-volume match on hosts without getVoiceSamplePtr.
    const useSmp   = playing && hasVoiceSampleAPI
    const smpStats = useSmp ? activeSampleStats() : null
    const instVols = (playing && !useSmp) ? activeInstVolumes() : null
    const counts   = (playing && !useSmp && hasNoteCountAPI) ? audio.getActiveNoteCounts(PLAYHEAD) : null
    const n = samplesCache.length
    for (let row = 0; row < SMP_LIST_H; row++) {
        const idx = smpListScroll + row
        let level = 0, poly = 0
        if (playing && idx < n) {
            const s = samplesCache[idx]
            if (useSmp) {
                const st = smpStats[s.ptr + ':' + s.len]
                if (st) { level = blobLevelForVolume(st.vol); poly = blobPolyBucket(st.count) }
            } else {
                const ub = s.usedBy
                let m = 0, c = 0
                for (let j = 0; j < ub.length; j++) {
                    const w = instVols[ub[j]] || 0
                    if (w > m) m = w
                    if (counts) c += counts[ub[j]] || 0
                }
                level = blobLevelForVolume(m)
                poly  = blobPolyBucket(c)
            }
        }
        // Ghost-only rows have notes sounding but no exposed foreground volume — floor the glyph
        // to blob1 so the colour-coded marker is still visible.
        if (poly > 0 && level === 0) level = 1
        const key = level * 8 + poly   // cache combines glyph level + colour bucket
        if (smpBlobPrev[row] === key) continue
        const isSel = (idx === smpListCursor)
        const back  = isSel ? colSmpListSel : colSmpListBg
        const fg    = (poly > 0) ? blobPolyCols[poly - 1] : colSmpListNumFg
        con.move(SMP_LIST_Y + row, SMP_LIST_X)
        con.color_pair(fg, back)
        print(sym['blob' + level])
        smpBlobPrev[row] = key
    }
}

function drawInstrumentsPlayBlobs() {
    if (HUB.getPanel() !== VIEW_INSTRMNT || !instrumentsCache) return
    const playing  = (HUB.getPlaybackMode() !== PLAYMODE_NONE)
    const instVols = playing ? activeInstVolumes() : null
    const counts   = (playing && hasNoteCountAPI) ? audio.getActiveNoteCounts(PLAYHEAD) : null
    const n = instrumentsCache.length
    for (let row = 0; row < INST_LIST_H; row++) {
        const idx = instListScroll + row
        let level = 0, poly = 0
        if (playing && idx < n) {
            const slot = instrumentsCache[idx].slot
            level = blobLevelForVolume(instVols[slot] || 0)
            poly  = blobPolyBucket(counts ? (counts[slot] || 0) : 0)
        }
        // Ghost-only rows sound but expose no foreground volume — floor to blob1 so the colour shows.
        if (poly > 0 && level === 0) level = 1
        const key = level * 8 + poly
        if (instBlobPrev[row] === key) continue
        const isSel = (idx === instListCursor)
        const back  = isSel ? colInstListSel : colInstListBg
        const fg    = (poly > 0) ? blobPolyCols[poly - 1] : colInstListNumFg
        con.move(INST_LIST_Y + row, INST_LIST_X)
        con.color_pair(fg, back)
        print(sym['blob' + level])
        instBlobPrev[row] = key
    }
}

// ── Playback-position cursor (sample waveform + vol/pan/pitch envelope graphs) ───────────────
// Vertical hairline glyph painted in the text layer at the column closest to the live
// playback position of EVERY voice that's sounding the displayed sample / instrument — one
// hairline per voice. Sub-pixel offset within the cell picks between vhairline1..vhairline7
// (vhairlineN draws the line N pixels from the cell's left edge; vhairline4 is the cell centre
// on a 7-px cell). When several voices want the same text column they are resolved quiet→loud,
// so the loudest voice's hairline wins the shared column.

const colPlayCursor = 215 // same hue used for the timeline play row

// Last-drawn state so each frame only repaints when something actually moved. Now that we draw
// one hairline per voice, *Cols is the list of text columns currently stamped and *Sig is a
// signature of the resolved per-column glyphs (so we can detect when any hairline moved).
// envCursorPrev{Tab,Inst}: the (tab, instrument-slot) the env hairlines belong to.
let envCursorPrevCols = []
let envCursorPrevSig  = ''
let envCursorPrevTab  = -1
let envCursorPrevInst = -1
let smpCursorPrevCols = []
let smpCursorPrevSig  = ''
let smpCursorPrevIdx  = -1

function invalidateEnvCursor() { envCursorPrevCols = []; envCursorPrevSig = ''; envCursorPrevTab = -1; envCursorPrevInst = -1 }
function invalidateSmpCursor() { smpCursorPrevCols = []; smpCursorPrevSig = ''; smpCursorPrevIdx = -1 }

// Map a pixel-space X coordinate to (text-column, vhairline glyph) such that the glyph's
// drawn line lands within ±½ a sub-pixel of xPix. Cell pixels are 1-indexed positions
// (left edge = pos 1), matching the vhairlineN naming.
function pixelToHairline(xPix) {
    const col0 = Math.floor(xPix / CELL_PW)
    let pos    = xPix - col0 * CELL_PW + 1   // 1..CELL_PW
    if (pos < 1) pos = 1
    if (pos > 7) pos = 7
    return { col: col0 + 1, hair: sym['vhairline' + pos] }
}

// All active voices currently bound to `slot` (1..255), as {voice, vol}. Empty if none.
function activeVoicesForInstSlot(slot) {
    const out = []
    const numVox = (HUB.getSong() && HUB.getSong().numVoices) ? HUB.getSong().numVoices : NUM_VOICES
    for (let v = 0; v < numVox; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        if (audio.getVoiceInstrument(PLAYHEAD, v) !== slot) continue
        out.push({ voice: v, vol: audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0 })
    }
    return out
}

// All active voices currently sounding the samplesCache entry `s`, as {voice, vol}. When the
// host exposes the per-voice active sample (hasVoiceSampleAPI), match on the true (ptr,len) so a
// voice playing a DIFFERENT sample of an instrument that also references `s` is excluded — its
// samplePos would normalise against the wrong length and paint a bogus cursor. Without the API,
// fall back to matching any voice on an instrument in `s.usedBy` (the old behaviour).
function activeVoicesForSample(s) {
    const out = []
    const numVox = (HUB.getSong() && HUB.getSong().numVoices) ? HUB.getSong().numVoices : NUM_VOICES
    for (let v = 0; v < numVox; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        if (hasVoiceSampleAPI) {
            if (audio.getVoiceSampleLength(PLAYHEAD, v) !== s.len) continue
            if (audio.getVoiceSamplePtr(PLAYHEAD, v) !== s.ptr) continue
        } else {
            if (s.usedBy.indexOf(audio.getVoiceInstrument(PLAYHEAD, v)) < 0) continue
        }
        out.push({ voice: v, vol: audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0 })
    }
    return out
}

// Collapse a list of {col, hair, vol} hairline hits into a per-column glyph map, resolving
// shared columns quiet→loud so the loudest voice's hairline wins. Returns { cols, colMap, sig }
// where cols is the sorted column list, colMap maps col→glyph, and sig detects visual changes.
function resolveHairlineHits(hits) {
    hits.sort((a, b) => a.vol - b.vol)
    const colMap = {}
    for (let i = 0; i < hits.length; i++) colMap[hits[i].col] = hits[i].hair
    const cols = Object.keys(colMap).map(Number).sort((a, b) => a - b)
    let sig = ''
    for (let i = 0; i < cols.length; i++) sig += cols[i] + ':' + colMap[cols[i]] + ','
    return { cols, colMap, sig }
}

// Pull the envelope object + JSR223 getter pair for the active inst sub-tab. Returns null
// for tabs without a graph (Gen.1 / Gen.2) AND for Metainstruments, whose decoded record has
// no vol/pan/pf envelopes (it carries a layer table instead) — drawInstTabMeta renders every
// sub-tab for them, so without this guard the VOL/PAN/PIT branches return { env: undefined }
// and the cursor walker dereferences env.terminatorIdx on undefined.
function envBundleForCurrentTab(e) {
    if (e.decoded.isMeta) return null
    if (instSubTab === INST_TAB_VOL) return { env: e.decoded.volEnv,
        idxFn: 'getVoiceEnvVolIndex',   timeFn: 'getVoiceEnvVolTime' }
    if (instSubTab === INST_TAB_PAN) return { env: e.decoded.panEnv,
        idxFn: 'getVoiceEnvPanIndex',   timeFn: 'getVoiceEnvPanTime' }
    if (instSubTab === INST_TAB_PIT) return { env: e.decoded.pitchEnv,
        idxFn: 'getVoiceEnvPitchIndex', timeFn: 'getVoiceEnvPitchTime' }
    if (instSubTab === INST_TAB_FILT) return { env: e.decoded.filterEnv,
        // Filter-env playhead getters ship with this feature; on an un-rebuilt host VM
        // they're absent — the graph still draws, only the live play-cursor is skipped.
        idxFn: hasFilterEnvAPI ? 'getVoiceEnvFilterIndex' : null,
        timeFn: hasFilterEnvAPI ? 'getVoiceEnvFilterTime' : null }
    return null
}

// First/last text row covered by the inst-tab envelope graph. Mirrors instEnvelopeRect()
// in text-coord units so we know which rows to stamp / erase the hairline on.
function envGraphTextRows() {
    const graphRowY = INST_BODY_Y + 7
    return { y0: graphRowY, y1: INST_BTN_Y - 1 }
}

// Same idea for the Samples-tab waveform.
function smpWaveTextRows() {
    return { y0: SMP_WAVE_Y, y1: SMP_BTN_Y - 1 }
}

function paintEnvCursorAt(col, hairSym) {
    const rng = envGraphTextRows()
    con.color_pair(colPlayCursor, 255)
    for (let y = rng.y0; y <= rng.y1; y++) {
        con.move(y, col)
        print(hairSym)
    }
}

function eraseEnvCursorIfAny() {
    if (envCursorPrevCols.length === 0) return
    const rng = envGraphTextRows()
    con.color_pair(colInstValue, 255)
    for (let k = 0; k < envCursorPrevCols.length; k++) {
        const col = envCursorPrevCols[k]
        for (let y = rng.y0; y <= rng.y1; y++) {
            con.move(y, col)
            print(' ')
        }
    }
    envCursorPrevCols = []
    envCursorPrevSig  = ''
    envCursorPrevTab  = -1
    envCursorPrevInst = -1
}

function paintSmpCursorAt(col, hairSym) {
    const rng = smpWaveTextRows()
    con.color_pair(colPlayCursor, 255)
    for (let y = rng.y0; y <= rng.y1; y++) {
        con.move(y, col)
        print(hairSym)
    }
}

function eraseSmpCursorIfAny() {
    if (smpCursorPrevCols.length === 0) return
    const rng = smpWaveTextRows()
    con.color_pair(colSmpPropValue, 255)
    for (let k = 0; k < smpCursorPrevCols.length; k++) {
        const col = smpCursorPrevCols[k]
        for (let y = rng.y0; y <= rng.y1; y++) {
            con.move(y, col)
            print(' ')
        }
    }
    smpCursorPrevCols = []
    smpCursorPrevSig  = ''
    smpCursorPrevIdx  = -1
}

function drawEnvelopeCursor() {
    if (HUB.getPanel() !== VIEW_INSTRMNT) { invalidateEnvCursor(); return }
    if (!instrumentsCache || instrumentsCache.length === 0) { eraseEnvCursorIfAny(); return }
    const e = instrumentsCache[instListCursor]
    if (!e) { eraseEnvCursorIfAny(); return }
    const bundle = envBundleForCurrentTab(e)
    // Gen.1 / Gen.2 (and Metainstruments) have no envelope graph — wipe any stale hairline and
    // bail. The !bundle.env check also covers a malformed record whose env slot is missing.
    if (!bundle || !bundle.env) { eraseEnvCursorIfAny(); return }
    const env = bundle.env
    const lastIdx = (env.terminatorIdx >= 0) ? env.terminatorIdx : (env.nodes.length - 1)
    if (lastIdx < 0) { eraseEnvCursorIfAny(); return }

    const hits = []
    if (HUB.getPlaybackMode() !== PLAYMODE_NONE && bundle.idxFn) {
        // Cumulative time at each node (mirrors xs[] in drawEnvelopeGraph) — shared by all voices.
        let acc = 0
        const xs = new Array(lastIdx + 1)
        xs[0] = 0
        for (let i = 1; i <= lastIdx; i++) { acc += env.nodes[i - 1].durSec; xs[i] = acc }
        const totalTime = Math.max(acc, 1e-6)
        const r = instEnvelopeRect()
        const voices = activeVoicesForInstSlot(e.slot)
        for (let k = 0; k < voices.length; k++) {
            const v = voices[k].voice
            const envIdx  = audio[bundle.idxFn](PLAYHEAD, v)
            const envTime = audio[bundle.timeFn](PLAYHEAD, v)
            if (envIdx < 0) continue
            const ei = Math.max(0, Math.min(lastIdx, envIdx))
            const segLen = (ei < lastIdx) ? env.nodes[ei].durSec : 0
            const tInto  = Math.max(0, Math.min(segLen, envTime))
            const elapsed = xs[ei] + tInto
            const xPix = r.x + Math.min(r.w - 1, Math.max(0, ((elapsed / totalTime) * (r.w - 1)) | 0))
            const sel = pixelToHairline(xPix)
            hits.push({ col: sel.col, hair: sel.hair, vol: voices[k].vol })
        }
    }
    const res = resolveHairlineHits(hits)

    if (res.sig === envCursorPrevSig &&
        envCursorPrevTab  === instSubTab &&
        envCursorPrevInst === e.slot) return

    eraseEnvCursorIfAny()
    if (res.cols.length > 0) {
        for (let i = 0; i < res.cols.length; i++) paintEnvCursorAt(res.cols[i], res.colMap[res.cols[i]])
        envCursorPrevCols = res.cols
        envCursorPrevSig  = res.sig
        envCursorPrevTab  = instSubTab
        envCursorPrevInst = e.slot
    }
}

function drawSampleCursor() {
    if (HUB.getPanel() !== VIEW_SAMPLES) { invalidateSmpCursor(); return }
    if (!samplesCache || samplesCache.length === 0) { eraseSmpCursorIfAny(); return }
    const s = samplesCache[smpListCursor]
    if (!s || s.len <= 0) { eraseSmpCursorIfAny(); return }

    const hits = []
    if (HUB.getPlaybackMode() !== PLAYMODE_NONE) {
        const r = sampleWaveformRect()
        const voices = activeVoicesForSample(s)
        for (let k = 0; k < voices.length; k++) {
            const pos = audio.getVoiceSamplePos(PLAYHEAD, voices[k].voice)
            if (pos < 0) continue
            const norm = Math.max(0, Math.min(1, pos / s.len))
            const xPix = r.x + Math.min(r.w - 1, Math.max(0, (norm * (r.w - 1)) | 0))
            const sel = pixelToHairline(xPix)
            hits.push({ col: sel.col, hair: sel.hair, vol: voices[k].vol })
        }
    }
    const res = resolveHairlineHits(hits)

    if (res.sig === smpCursorPrevSig && smpCursorPrevIdx === smpListCursor) return

    eraseSmpCursorIfAny()
    if (res.cols.length > 0) {
        for (let i = 0; i < res.cols.length; i++) paintSmpCursorAt(res.cols[i], res.colMap[res.cols[i]])
        smpCursorPrevCols = res.cols
        smpCursorPrevSig  = res.sig
        smpCursorPrevIdx  = smpListCursor
    }
}

// Samples-panel mouse regions (analogue of registerInstrumentsMouse). Moved into
// the module on 2026-06-21 because it reads samples-private state (SMP_* geometry,
// smpListCursor / smpListScroll / smpUsedScroll, samplesCache); the engine's
// rebuildPanelMouseRegions calls it via the HUB.views alias.
function registerSamplesMouse() {
    // Left list (incl. scroll-indicator column, but excluding the separator).
    addPanelMouseRegion(SMP_LIST_X, SMP_LIST_Y, SMP_SEP_X - SMP_LIST_X, SMP_LIST_H, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            const n = samplesCache ? samplesCache.length : 0
            const target = smpListScroll + (cy - SMP_LIST_Y)
            if (target < 0 || target >= n) return
            smpListCursor = target
            smpUsedScroll = 0
            clampSamplesCursor()
            drawSamplesContents()
        },
        onWheel: (cy, cx, dy) => {
            // free scroll: move the view, not the selection (cursor may scroll off)
            const n = samplesCache ? samplesCache.length : 0
            const maxS = Math.max(0, n - SMP_LIST_H)
            smpListScroll = Math.max(0, Math.min(maxS, smpListScroll + dy * 3))
            drawSamplesContents()
        }
    })
    // Right "Used by" list: click launches inst viewer for that slot
    addPanelMouseRegion(SMP_RIGHT_X, SMP_USED_Y + 1, SCRW - SMP_RIGHT_X + 1, SMP_USED_LIST_H, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            const s = samplesCache && samplesCache[smpListCursor]
            if (!s) return
            const idx = smpUsedScroll + (cy - (SMP_USED_Y + 1))
            if (idx < 0 || idx >= s.usedBy.length) return
            launchInstrumentViewerFor(s.usedBy[idx])
        },
        onWheel: (cy, cx, dy) => {
            const s = samplesCache && samplesCache[smpListCursor]
            if (!s) return
            smpUsedScroll += dy
            drawSamplesUsedBy()
        }
    })
    // Bottom-row Edit button
    addPanelMouseRegion(SMP_RIGHT_X, SMP_BTN_Y, 18, 1, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            openSampleEdit(smpListCursor)
        }
    })
}

// Pre-formatted "N (Kk/Mk)" sample-RAM summary for the engine's Project panel,
// which used to read samplesCache.length / SMP_RAM_MAX_K directly (both private here).
function sampleRamSummary() {
    const count = (samplesCache || []).length
    return `${count} (${formatSampleRamK(computeSampleRAMBytes())}k/${SMP_RAM_MAX_K}k)`
}

// ── In-process sub-editors ──────────────────────────────────────────────────
// Replace the old taut_sampleedit / taut_instredit separate programs. Each runs
// its own modal input loop (nested inside the panel's input handler, like
// openInlineHexEdit). Going in-process means we DON'T call stopPlayback on entry,
// so sound keeps playing while the editor is open — the audio engine advances
// autonomously; updatePlayback() is only the on-screen sync. We deliberately do
// NOT tick updatePlayback here, because currentPanel is still VIEW_SAMPLES /
// VIEW_INSTRMNT and it would repaint the viewer's blobs / cursor on top of the
// editor UI. The Advanced Edit instead draws its OWN live playing-region
// visualisation each spin via the optional onTick callback (reading the voice-state
// API directly, repainting only the blob cells — NOT updatePlayback). On exit the
// editors refresh the cache and repaint the parent viewer via HUB.drawAll().
//
// Mouse: callers clear the panel mouse regions on entry and register their own (so a
// click in the editor area never hits the stale viewer regions); HUB.dispatchMouseEvent
// then routes to the editor's own regions PLUS the always-on transport regions
// (MOUSE_PANEL.concat(MOUSE_GLOBAL)), so transport play/stop works while editing.
// Keys are NOT gated on keyJustHit, so held keys auto-repeat (e.g. Up/Dn to scroll).
function editorModalLoop(onKey, onTick) {
    // The raw-keyboard grab set by the main loop persists while we are nested here
    // (same as openInlineHexEdit / the popups), so no need to re-assert it per spin.
    // A mouse click on a tab (transport stays on the same panel) switches currentPanel
    // via the global tab regions; detect that and close the editor so the new panel
    // isn't drawn underneath a still-running modal (the teardown then paints it).
    const startPanel = HUB.getPanel()
    let done = false, swallow = true
    const finish = () => { done = true }
    while (!done) {
        input.withEvent(ev => {
            if (swallow && (ev[0] === 'key_down' || ev[0] === 'mouse_down')) { swallow = false; return }
            if (HUB.dispatchMouseEvent(ev)) { if (HUB.getPanel() !== startPanel) finish(); return }
            if (ev[0] !== 'key_down') return
            const ks = ev[1]
            if (ks === '<ESC>' || ks === '<ESCAPE>' || ks === '<TAB>') { if (1 === ev[2]) finish(); return }
            onKey(ks, finish, (1 === ev[2]), ev)
        })
        if (!done && onTick) onTick()      // don't overpaint the new panel after a switch
    }
}

// ── Sample DSP (ports of the web app's sampledsp.js) ────────────────────────
// Length-preserving pure functions over U8 PCM spans (centre 0x80): take a
// Uint8Array, return a NEW one of the same length. Length-changing edits
// (trim, resample) stay out of scope — they'd ripple every pool pointer.

/** Peak-normalise to full scale (max deviation from centre → 127). */
function dspNormalise(bytes) {
    let maxDev = 0
    for (let i = 0; i < bytes.length; i++) {
        const d = Math.abs(bytes[i] - 128)
        if (d > maxDev) maxDev = d
    }
    const out = new Uint8Array(bytes.length)
    if (maxDev === 0) { out.set(bytes); return out }
    const scale = 127 / maxDev
    for (let i = 0; i < bytes.length; i++)
        out[i] = Math.max(0, Math.min(255, Math.round(128 + (bytes[i] - 128) * scale)))
    return out
}

/** Linear fade from silence into full level across the span. */
function dspFadeIn(bytes) {
    const out = new Uint8Array(bytes.length)
    const n = Math.max(1, bytes.length - 1)
    for (let i = 0; i < bytes.length; i++)
        out[i] = Math.round(128 + (bytes[i] - 128) * (i / n))
    return out
}

/** Linear fade from full level out to silence across the span. */
function dspFadeOut(bytes) {
    const out = new Uint8Array(bytes.length)
    const n = Math.max(1, bytes.length - 1)
    for (let i = 0; i < bytes.length; i++)
        out[i] = Math.round(128 + (bytes[i] - 128) * (1 - i / n))
    return out
}

/** Reverse the span (loop points are NOT remapped). */
function dspReverse(bytes) {
    const out = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i]
    return out
}

/** Polarity swap: reflect every sample about the 0x80 DC centre. */
function dspInvert(bytes) {
    const out = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++)
        out[i] = Math.max(0, Math.min(255, 256 - bytes[i]))
    return out
}

/** Remove DC offset (item 68): shift the whole span so its mean sits at the
 *  0x80 centre. A pure bias shift — the waveform shape is untouched except
 *  where clamping bites on an extreme offset. */
function dspRemoveDC(bytes) {
    const out = new Uint8Array(bytes.length)
    if (bytes.length === 0) return out
    let sum = 0
    for (let i = 0; i < bytes.length; i++) sum += bytes[i]
    const bias = Math.round(sum / bytes.length) - 128
    for (let i = 0; i < bytes.length; i++)
        out[i] = Math.max(0, Math.min(255, bytes[i] - bias))
    return out
}

// Read / write a pool span straight out of / into the banked sample window
// (same addressing as drawSampleWaveform's readByte). Writes are heard
// immediately — the engine mixes from this memory — and persist through the
// device-capture save path.
function readSampleSpan(ptr, len) {
    const memBase = audio.getMemAddr()
    const prevBank = audio.getSampleBank() || 0
    let curBank = -1
    const out = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
        const abs = ptr + i
        const bank = (abs / TAUT_SBANK_SIZE) | 0
        if (bank !== curBank) { audio.setSampleBank(bank); curBank = bank }
        out[i] = sys.peek(memBase - (abs - bank * TAUT_SBANK_SIZE)) & 0xFF
    }
    audio.setSampleBank(prevBank)
    return out
}

function writeSampleSpan(ptr, bytes) {
    const memBase = audio.getMemAddr()
    const prevBank = audio.getSampleBank() || 0
    let curBank = -1
    for (let i = 0; i < bytes.length; i++) {
        const abs = ptr + i
        const bank = (abs / TAUT_SBANK_SIZE) | 0
        if (bank !== curBank) { audio.setSampleBank(bank); curBank = bank }
        sys.poke(memBase - (abs - bank * TAUT_SBANK_SIZE), bytes[i] & 0xFF)
    }
    audio.setSampleBank(prevBank)
}

// Tools with a `fn` apply that DSP to the sample's pool span in place; L/S
// load/save the span from/to disk; D toggles the freehand draw. Everything is
// length-preserving — crop/resample belongs to import time (future endeavour).
const SMP_EDIT_TOOLS = [
    { key: 'L', label: 'Load .wav / .raw from disk', io: 'load' },
    { key: 'S', label: 'Save sample as .wav',        io: 'save' },
    { key: 'D', label: 'Draw waveform freehand (toggle)' },
    { key: 'V', label: 'Reverse',           fn: dspReverse },
    { key: 'N', label: 'Normalise to peak', fn: dspNormalise },
    { key: 'F', label: 'Fade in',           fn: dspFadeIn },
    { key: 'G', label: 'Fade out',          fn: dspFadeOut },
    { key: 'I', label: 'Invert (polarity)', fn: dspInvert },
    { key: 'O', label: 'Remove DC offset',  fn: dspRemoveDC },
]

// Decode a file into U8 PCM for the editor's Load tool: RIFF/WAVE (PCM 8- or
// 16-bit, first channel) or, failing the RIFF magic, raw unsigned-8 bytes.
// Returns { pcm, rate, note } or null (WAV present but unsupported codec).
// The pool span's LENGTH is fixed — the caller truncates / centre-pads; any
// crop/resample belongs to import time (a future endeavour), not this editor.
function fileToU8Pcm(bytes) {
    const n = bytes.length
    const rd16 = (o) => (bytes[o] & 0xFF) | ((bytes[o + 1] & 0xFF) << 8)
    const rd32 = (o) => rd16(o) | (rd16(o + 2) << 16)
    const tag = (o) => String.fromCharCode(bytes[o] & 0xFF, bytes[o + 1] & 0xFF, bytes[o + 2] & 0xFF, bytes[o + 3] & 0xFF)
    if (n >= 44 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
        let o = 12, fmt = -1, data = -1, dataLen = 0
        while (o + 8 <= n) {
            const id = tag(o), sz = rd32(o + 4)
            if (id === 'fmt ') fmt = o + 8
            else if (id === 'data') { data = o + 8; dataLen = Math.min(sz, n - (o + 8)) }
            o += 8 + sz + (sz & 1)
        }
        if (fmt < 0 || data < 0) return null
        const audioFmt = rd16(fmt), ch = Math.max(1, rd16(fmt + 2))
        const rate = rd32(fmt + 4), bits = rd16(fmt + 14)
        if (audioFmt !== 1 || (bits !== 8 && bits !== 16)) return null
        const bytesPerFrame = ch * (bits >> 3)
        const frames = (dataLen / bytesPerFrame) | 0
        const out = new Uint8Array(frames)
        for (let i = 0; i < frames; i++) {
            const so = data + i * bytesPerFrame
            if (bits === 8) out[i] = bytes[so] & 0xFF
            else { let v = rd16(so); if (v >= 0x8000) v -= 0x10000; out[i] = ((v >> 8) + 128) & 0xFF }
        }
        return { pcm: out, rate: rate, note: 'WAV ' + bits + '-bit ' + ch + 'ch @' + rate + 'Hz' }
    }
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = bytes[i] & 0xFF
    return { pcm: out, rate: 0, note: 'raw ' + n + 'B' }
}

function openSampleEdit(slot) {
    const SAMPLE_IDX = (slot !== undefined && slot >= 0) ? (slot | 0) : smpListCursor
    const Y = PTNVIEW_OFFSET_Y
    const cStatus = 253, cContent = 240, cHdr = 230, cEmph = 211, cDim = 246, cBack = 255, cSel = 41
    let toolCursor = 0
    let drawMode = false

    const s = (samplesCache && samplesCache[SAMPLE_IDX]) || null

    // ── waveform pane (bottom strip; buffer-backed so repaints are cheap) ──
    const WAVE_ROW0 = Y + 4 + 3 + SMP_EDIT_TOOLS.length + 1          // first text row of the pane
    const WAVE_ROWS = Math.max(3, SCRH - 2 - WAVE_ROW0)
    const wx0 = 2 * CELL_PW, wW = (SCRW - 4) * CELL_PW
    const wy0 = (WAVE_ROW0 - 1) * CELL_PH, wH = WAVE_ROWS * CELL_PH
    let wave = null                                                   // Uint8Array copy of the pool span
    const refreshWave = () => { wave = (s && s.len > 0) ? readSampleSpan(s.ptr, s.len) : null }
    const yOf = (v) => wy0 + (((wH - 1) * (255 - v)) / 255 | 0)
    const baseY = wy0 + (wH >>> 1)

    // Repaint waveform pixel columns [colA..colB] (inclusive) from the buffer.
    const paintWave = (colA, colB) => {
        if (!wave) return
        if (colA === undefined) { colA = 0; colB = wW - 1 }
        colA = Math.max(0, colA); colB = Math.min(wW - 1, colB)
        for (let col = colA; col <= colB; col++) {
            graphics.plotRect(wx0 + col, wy0, 1, wH, 255)             // clear column (transparent)
            const start = (col * wave.length / wW) | 0
            let end = (((col + 1) * wave.length / wW) | 0)
            if (end <= start) end = start + 1
            let mn = 255, mx = 0
            for (let i = start; i < end && i < wave.length; i++) {
                const v = wave[i]
                if (v < mn) mn = v
                if (v > mx) mx = v
            }
            const yTop = yOf(mx), yBot = yOf(mn)
            graphics.plotRect(wx0 + col, baseY, 1, 1, colSmpWaveMid)  // zero line under the wave
            graphics.plotRect(wx0 + col, yTop, 1, Math.max(1, yBot - yTop + 1), colSmpWaveLine)
        }
    }

    // ── freehand draw ('D' tool, web item 53's painter): drag on the pane ──
    // Pixel → sample index/value; consecutive events are linearly interpolated
    // and each stroke segment is committed straight to the pool span (heard
    // live; persists through the device-capture save).
    let lastDraw = null
    const drawAt = (px, py) => {
        if (!wave || !drawMode) return
        const col = Math.max(0, Math.min(wW - 1, px - wx0))
        const i = Math.max(0, Math.min(wave.length - 1, (col * wave.length / wW) | 0))
        const v = Math.max(0, Math.min(255, 255 - (((py - wy0) * 255) / (wH - 1) | 0)))
        const from = lastDraw || { i: i, v: v }
        const lo = Math.min(from.i, i), hi = Math.max(from.i, i)
        for (let k = lo; k <= hi; k++) {
            const t = (hi === lo) ? 0 : (k - lo) / (hi - lo)
            wave[k] = Math.round(from.i <= i ? from.v + (v - from.v) * t
                                             : v + (from.v - v) * t) & 0xFF
        }
        writeSampleSpan(s.ptr + lo, wave.subarray(lo, hi + 1))
        lastDraw = { i: i, v: v }
        if (HUB.markUnsaved) HUB.markUnsaved()
        const colOf = (idx) => (idx * wW / wave.length) | 0
        paintWave(colOf(lo) - 1, colOf(hi) + 1)
    }

    const drawTools = () => {
        const x = 5, y0 = Y + 4
        con.move(y0, x);     con.color_pair(cHdr, cBack); print('Editing actions')
        con.move(y0 + 1, x); con.color_pair(cDim, cBack); print('-'.repeat(16))
        for (let i = 0; i < SMP_EDIT_TOOLS.length; i++) {
            const y = y0 + 3 + i, t = SMP_EDIT_TOOLS[i], sel = (i === toolCursor), back = sel ? cSel : cBack
            con.move(y, x); con.color_pair(cHdr, back); print(' ' + t.key + ' ')
            con.color_pair(cStatus, back); print('  ')
            con.color_pair(sel ? cEmph : cStatus, back)
            let label = t.label
            if (t.key === 'D') label += drawMode ? '  [ON]' : ''
            const w = SCRW - x - 6
            print(label.length > w ? label.substring(0, w) : label.padEnd(w))
        }
    }
    const flash = (msg) => {
        con.move(WAVE_ROW0 - 1, 5); con.color_pair(cEmph, cBack)
        print(msg.padEnd(SCRW - 8))
    }
    // Apply a tool: DSP tools rewrite the sample's pool span in place (heard
    // immediately; persists through the device-capture save); 'D' toggles the
    // freehand draw mode; L/S go through the path dialog to disk.
    // Path prompt for the Load / Save tools (full path incl. drive letter).
    const pathDialog = (title, initial) => {
        const res = win.showDialog({
            title: title,
            drawFrame: HUB.popups.popupDrawFrame, colours: HUB.popups.popupColours,
            fields: [{ label: 'Path:', width: 36, maxLength: 120, initial: initial }],
            buttons: [{ label: 'OK', action: 'ok' }, { label: 'Cancel', action: 'cancel' }],
        })
        return (res.action === 'ok') ? ('' + (res.values[0] || '')).trim() : null
    }
    const defaultDir = _G.shell.getCurrentDrive() + ':\\'
    // Load a .wav/.raw INTO the fixed-length pool span: truncated when longer,
    // silence-padded (0x80) when shorter. No rate conversion — the flash
    // reports the file's own rate so a mismatch is visible.
    const loadFromDisk = () => {
        if (!s || s.len === 0) { flash('No sample span to load into.'); return }
        const path = pathDialog('Load sample (.wav / .raw)', defaultDir)
        drawEditorFrame()
        if (!path) return
        let bytes = null
        try {
            const fh = files.open(path)
            if (fh.exists) { bytes = fh.bread(); fh.close() }
        } catch (e2) { bytes = null }
        if (!bytes || !bytes.length) { flash('Cannot read: ' + path); return }
        const dec = fileToU8Pcm(bytes)
        if (!dec) { flash('Unsupported WAV (PCM 8/16-bit only).'); return }
        const span = new Uint8Array(s.len).fill(0x80)
        const n = Math.min(dec.pcm.length, s.len)
        for (let i = 0; i < n; i++) span[i] = dec.pcm[i]
        writeSampleSpan(s.ptr, span)
        if (HUB.markUnsaved) HUB.markUnsaved()
        refreshWave(); paintWave()
        flash('Loaded ' + dec.note +
              (dec.pcm.length > s.len ? ' (truncated to ' + s.len + 'B)' :
               dec.pcm.length < s.len ? ' (padded to ' + s.len + 'B)' : ''))
    }
    // Save the span as a PCM u8 mono .wav at the census rate.
    const saveToDisk = () => {
        if (!s || s.len === 0) { flash('No sample data to save.'); return }
        const path = pathDialog('Save sample as .wav',
            defaultDir + 'SAMPLE' + (SAMPLE_IDX + 1).toString(16).toUpperCase().padStart(2, '0') + '.WAV')
        drawEditorFrame()
        if (!path) return
        const data = readSampleSpan(s.ptr, s.len)
        const rate = s.c4Rate || 8363
        const out = []
        const w32 = (v) => out.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF)
        const w16v = (v) => out.push(v & 0xFF, (v >>> 8) & 0xFF)
        const str4 = (t2) => { for (let i = 0; i < 4; i++) out.push(t2.charCodeAt(i)) }
        str4('RIFF'); w32(36 + s.len); str4('WAVE')
        str4('fmt '); w32(16); w16v(1); w16v(1); w32(rate); w32(rate); w16v(1); w16v(8)
        str4('data'); w32(s.len)
        for (let i = 0; i < s.len; i++) out.push(data[i])
        try {
            const fh = files.open(path)
            fh.bwrite(out)
            fh.flush(); fh.close()
            flash('Saved ' + s.len + 'B @' + rate + 'Hz -> ' + path)
        } catch (e2) {
            flash('Cannot write: ' + path)
        }
    }
    const runAction = (idx) => {
        const t = SMP_EDIT_TOOLS[idx]; if (!t) return
        if (t.key === 'D') {
            drawMode = !drawMode
            drawTools()
            flash(drawMode ? 'Draw mode ON: drag on the waveform below.' : 'Draw mode off.')
            return
        }
        if (t.io === 'load') { loadFromDisk(); return }
        if (t.io === 'save') { saveToDisk(); return }
        if (!t.fn) return
        if (!s || s.len === 0) { flash('No sample data to edit.'); return }
        writeSampleSpan(s.ptr, t.fn(readSampleSpan(s.ptr, s.len)))
        if (HUB.markUnsaved) HUB.markUnsaved()
        refreshWave()
        paintWave()
        flash('Applied: ' + t.label)
    }

    // frame (also repainted after a Load/Save path dialog closes over it)
    const drawEditorFrame = () => {
        for (let y = Y; y < SCRH; y++) { con.move(y, 1); con.color_pair(cContent, cBack); print(' '.repeat(SCRW)) }
        con.move(Y + 1, 3); con.color_pair(cHdr, cBack); print('[ Sample Editor ]  ')
        con.color_pair(cEmph, cBack); print('Sample ')
        con.color_pair(cStatus, cBack)
        print(SAMPLE_IDX >= 0 ? ('#' + (SAMPLE_IDX + 1).toString(16).toUpperCase().padStart(2, '0')) : '(none)')
        if (s) {
            con.color_pair(cDim, cBack)
            print('   ptr ' + s.ptr + '  len ' + s.len + (s.name ? '  "' + s.name + '"' : ''))
        }
        con.move(Y + 2, 3); con.color_pair(cDim, cBack); print('Edits apply to the pool sample in place (fixed length: load truncates/pads).')
        drawTools()
        refreshWave()
        paintWave()
        con.move(SCRH, 1); con.color_pair(cStatus, cBack); print(' '.repeat(SCRW - 1))
        con.move(SCRH, 1)
        con.color_pair(cHdr, cBack); print('Up/Dn ');  con.color_pair(cStatus, cBack); print('Tool ')
        con.color_pair(cHdr, cBack); print('Enter ');   con.color_pair(cStatus, cBack); print('Apply ')
        con.color_pair(cHdr, cBack); print('D ');       con.color_pair(cStatus, cBack); print('Draw ')
        con.color_pair(cHdr, cBack); print('Esc/Tab '); con.color_pair(cStatus, cBack); print('Back')
    }
    drawEditorFrame()

    // Editor-owned mouse regions (the covered Samples-viewer regions are
    // cleared so a click never hits them; transport stays live via the global
    // regions). The waveform pane draws with pixel precision — the raw pixel
    // coords ride in the event (ev[1]/ev[2], same source pixelToCell reads).
    HUB.clearPanelMouseRegions()
    HUB.addPanelMouseRegion(1, WAVE_ROW0, SCRW, WAVE_ROWS, {
        onClick: (cy, cx, btn, ev) => {
            if (btn !== 1) return
            lastDraw = null
            drawAt(ev[1], ev[2])
        },
        onHover: (cy, cx, ev) => {
            // continue the stroke while the button is held; otherwise arm a new one
            if ((sys.peek(-37) & 0x01) !== 0) drawAt(ev[1], ev[2])
            else lastDraw = null
        },
        onRelease: () => { lastDraw = null },
    })

    editorModalLoop((ks, finish, first) => {
        if (ks === '<UP>')   { if (toolCursor > 0) toolCursor--; drawTools(); return }
        if (ks === '<DOWN>') { if (toolCursor < SMP_EDIT_TOOLS.length - 1) toolCursor++; drawTools(); return }
        if (!first) return                       // the rest are discrete; ignore key-repeat
        if (ks === '\n') { runAction(toolCursor); return }
        for (let i = 0; i < SMP_EDIT_TOOLS.length; i++) {
            if (ks === SMP_EDIT_TOOLS[i].key.toLowerCase() || ks === SMP_EDIT_TOOLS[i].key) {
                toolCursor = i; drawTools(); runAction(i); return
            }
        }
    })

    // teardown: sample data may have changed -> rebuild + repaint the parent viewer.
    graphics.plotRect(wx0 - 2, wy0 - 2, wW + 4, wH + 4, 255)   // clear the editor waveform pixels
    refreshSamplesCache()
    clampSamplesCursor()
    HUB.drawAll()
    HUB.rebuildPanelMouseRegions()
}

// Full Ixmp patch parse (byte layout per AudioJSR223Delegate.uploadInstrumentPatches:
// 31 common bytes, then optional blocks x[15] v[54] p[54] f[54] P[54] in that order;
// the existing forEachIxmpPatchSample only reads a subset). Returns null without the
// host patch API, [] when the instrument has no patches.
function decodeIxmpPatches(slot) {
    if (!hasIxmpAPI) return null
    if (audio.getInstrumentPatchCount(slot) <= 0) return []
    const b = audio.getInstrumentPatches(slot)
    if (!b || b.length < 31) return []
    const u8  = (o) => b[o] & 0xFF
    const u16 = (o) => (b[o] & 0xFF) | ((b[o+1] & 0xFF) << 8)
    const s16 = (o) => { const v = u16(o); return v >= 0x8000 ? v - 0x10000 : v }
    const u32 = (o) => (b[o] & 0xFF) | ((b[o+1] & 0xFF) << 8) | ((b[o+2] & 0xFF) << 16) | ((b[o+3] & 0xFF) * 0x1000000)
    const out = []
    let o = 0
    while (o + 31 <= b.length) {
        const ver = u8(o), len = ixmpPatchLen(ver)
        if (o + len > b.length) break
        let hasExtra = false, fadeoutStep = 0, extraCutoff = 0xFF, extraResonance = 0xFF, extraAtten = 0, filterSfMode = false
        if (ver & 0x80) {                       // 'x' block is always first after the common bytes
            const xp = o + 31
            filterSfMode   = (u8(xp) & 0x01) !== 0
            fadeoutStep    = u16(xp + 8)
            extraCutoff    = u16(xp + 10)
            extraResonance = u16(xp + 12)
            extraAtten     = u8(xp + 14)
            hasExtra = true
        }
        // Optional v/p/f/P envelope blocks follow the (optional) x block, in order.
        // Parse each present block into the same shape decodeEnvelope produces so the
        // graph renderer can draw it (filter→'pf', pitch→'pf2' roles).
        let bp = o + 31 + (hasExtra ? 15 : 0)
        const hasVol = (ver&0x02)!==0, hasPan = (ver&0x04)!==0, hasFil = (ver&0x08)!==0, hasPit = (ver&0x10)!==0
        let volEnv = null, panEnv = null, filterEnv = null, pitchEnv = null
        if (hasVol) { volEnv    = patchEnvFromBlock(b, bp, 'vol'); bp += 54 }
        if (hasPan) { panEnv    = patchEnvFromBlock(b, bp, 'pan'); bp += 54 }
        if (hasFil) { filterEnv = patchEnvFromBlock(b, bp, 'pf');  bp += 54 }
        if (hasPit) { pitchEnv  = patchEnvFromBlock(b, bp, 'pf2'); bp += 54 }
        const raw = new Array(len)
        for (let k = 0; k < len; k++) raw[k] = b[o + k] & 0xFF
        out.push({
            kind: 'patch', ver, raw,
            pitchStart: u16(o+1), pitchEnd: u16(o+3), volStart: u8(o+5), volEnd: u8(o+6),
            ptr: u32(o+7), len: u16(o+11), playStart: u16(o+13), loopStart: u16(o+15), loopEnd: u16(o+17),
            rate: u16(o+19), detune: s16(o+21), loopMode: u8(o+23), pan: u8(o+24), noteVol: u8(o+25),
            vibSpeed: u8(o+26), vibSweep: u8(o+27), vibDepth: u8(o+28), vibRate: u8(o+29), vibWave: u8(o+30),
            hasExtra, fadeoutStep, filterSfMode, extraCutoff, extraResonance, extraAtten,
            hasVol, hasPan, hasFil, hasPit, volEnv, panEnv, filterEnv, pitchEnv,
        })
        o += len
    }
    return out
}

// Inverse of decodeIxmpPatches (web writePatchesBlob's role): rebuilds the
// flat on-wire patch bytes for uploadInstrumentPatches. Each patch keeps its
// ORIGINAL raw bytes (x block + envelope blocks verbatim) and only the 30
// common field bytes are re-stamped from the (possibly edited) fields — so
// blocks we don't edit round-trip byte-exactly. A patch with no raw (newly
// added) is a fresh 31-byte base-info record (ver $01).
function encodeIxmpPatches(list) {
    const out = []
    for (let n = 0; n < list.length; n++) {
        const p = list[n]
        const start = out.length
        if (p.raw && p.raw.length >= 31) {
            for (let k = 0; k < p.raw.length; k++) out.push(p.raw[k] & 0xFF)
        } else {
            out.push(0x01)
            for (let k = 1; k < 31; k++) out.push(0)
        }
        const o = start
        const w16 = (off, v) => { out[o + off] = v & 0xFF; out[o + off + 1] = (v >>> 8) & 0xFF }
        w16(1, p.pitchStart); w16(3, p.pitchEnd)
        out[o + 5] = p.volStart & 0xFF; out[o + 6] = p.volEnd & 0xFF
        out[o + 7] = p.ptr & 0xFF; out[o + 8] = (p.ptr >>> 8) & 0xFF
        out[o + 9] = (p.ptr >>> 16) & 0xFF; out[o + 10] = (p.ptr >>> 24) & 0xFF
        w16(11, p.len); w16(13, p.playStart); w16(15, p.loopStart); w16(17, p.loopEnd)
        w16(19, p.rate); w16(21, p.detune & 0xFFFF)
        out[o + 23] = p.loopMode & 0xFF
        out[o + 24] = p.pan & 0xFF
        out[o + 25] = p.noteVol & 0xFF
        out[o + 26] = p.vibSpeed & 0xFF; out[o + 27] = p.vibSweep & 0xFF
        out[o + 28] = p.vibDepth & 0xFF; out[o + 29] = p.vibRate & 0xFF
        out[o + 30] = p.vibWave & 0xFF
    }
    return out
}

// Reconstruct a decodeEnvelope-shaped object from one 54-byte patch envelope block
// (loop word, sustain word, 25 value/dur node pairs) by staging it into a synthetic
// 256-byte record at the offsets decodeEnvelope reads for that kind, then reusing
// decodeEnvelope (so the bit-parsing / valueMax / pf-role logic isn't duplicated).
function patchEnvFromBlock(b, off, kind) {
    const loopOff  = (kind==='vol')?15  : (kind==='pan')?17  : (kind==='pf')?19  : 197
    const sustOff  = (kind==='vol')?189 : (kind==='pan')?191 : (kind==='pf')?193 : 199
    const nodeBase = (kind==='vol')?21  : (kind==='pan')?71  : (kind==='pf')?121 : 201
    const rec = new Array(256).fill(0)
    rec[loopOff]   = b[off]   & 0xFF; rec[loopOff+1] = b[off+1] & 0xFF
    rec[sustOff]   = b[off+2] & 0xFF; rec[sustOff+1] = b[off+3] & 0xFF
    for (let i = 0; i < 50; i++) rec[nodeBase + i] = b[off + 4 + i] & 0xFF
    return decodeEnvelope(rec, kind)
}

function advSampleName(ptr, len) {
    const c = samplesCache || []
    for (let i = 0; i < c.length; i++) if (c[i].ptr === ptr && c[i].len === len) return c[i].name || ''
    return ''
}
function advSampleLabel(ptr, len) {
    const nm = advSampleName(ptr, len)
    return (nm ? '"' + nm + '" ' : '') + '($' + (ptr >>> 0).toString(16).toUpperCase().padStart(6, '0') + ', ' + len + 'B)'
}
function advInstName(slot) {
    const names = (songsMeta && songsMeta.instNames) || []
    return names[slot] || ''
}
function hx4(n) { return (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0') }
function signedC(detune) { const c = detune * 1200 / 4096; return (c >= 0 ? '+' : '') + c.toFixed(0) + 'c' }
function ovr(val, isDefault) { return isDefault ? '--' : ('$' + (val & 0xFF).toString(16).toUpperCase().padStart(2, '0')) }

// Advanced Edit — read-only comprehensive visualiser of an instrument's Ixmp
// patch layout (keyzones / velocity layers over Pitch x Volume), with a live
// overlay of the currently-sounding voices. Layout: patch list (left, scrollable,
// with live blobs) + zone map (top-right) + selected-patch detail + envelope graph
// (bottom-right). Mouse-aware (patches + transport). See plan Step 2.
function openAdvancedInstEdit(slot) {
    const SLOT = (slot !== undefined && slot >= 0) ? (slot | 0) : -1
    // Drop any list-view jam audition, but ONLY while stopped — this view shows a live overlay of
    // the song's sounding voices, and jamStop deactivates every voice, which would cut live playback.
    if (HUB.getPlaybackMode() === PLAYMODE_NONE && typeof audio.jamStop === 'function') audio.jamStop(PLAYHEAD)
    const Y = PTNVIEW_OFFSET_Y - 1            // start one row above the normal panel top (row 4), 1 row taller
    const cHdr = colVoiceHdr, cStatus = colStatus, cDim = colSep, cBack = 255

    // ── geometry ────────────────────────────────────────────────────────────
    const LIST_X = 1, LIST_W = 22
    const LIST_BLOB_X = LIST_X                       // col 1: live-play blob
    const LIST_TEXT_X = LIST_X + 1                    // col 1 = blob, last col = scroll gutter
    const LIST_TEXT_W = LIST_W - 2
    const LIST_SCROLL_X = LIST_X + LIST_W - 1
    const SEP_X  = LIST_X + LIST_W
    const R_X    = SEP_X + 2
    const LIST_Y = Y + 2
    const LIST_H = SCRH - LIST_Y                      // list fills down to the row above the hint
    const MAP_X  = R_X + 3                            // 3 cols of vol-axis labels
    const MAP_W  = SCRW - MAP_X + 1
    const MAP_Y  = Y + 3
    const MAP_H  = 8
    const MAP_BOT = MAP_Y + MAP_H - 1
    const DET_Y  = MAP_BOT + 3
    const ENV_HDR_Y    = DET_Y + 5                   // env tab-strip row
    const ENV_INFO_Y   = DET_Y + 6                   // env length / grid info row (like the base inst panel)
    const ENV_TOP_Y    = DET_Y + 7                   // first env-graph / wavescope text row
    const ENV_RECT = { x: (R_X - 1) * CELL_PW, y: (ENV_TOP_Y - 1) * CELL_PH,
                       w: (SCRW - R_X + 1) * CELL_PW, h: (SCRH - ENV_TOP_Y) * CELL_PH }

    // base palette for non-selected patch rects (background colours; black labels)
    const PAL = [150, 180, 110, 215, 141, 80, 209, 116]
    const baseBg = colBackPtn, baseFg = cDim
    // env-section tabs: 4 envelopes + the sample wavescope. Reserve ~8 cols at the
    // right of the tab row for the "(patch)/(base)" source label (item 1).
    const ENV_TABS = ['Vol', 'Pan', 'Filter', 'Pitch', 'Wave']
    const ENV_WAVE = 4
    const ENV_TABW = Math.max(8, ((SCRW - R_X + 1 - 8) / ENV_TABS.length) | 0)
    const ENV_SRC_X = R_X + ENV_TABS.length * ENV_TABW + 1
    const ENV_IDXFN = ['getVoiceEnvVolIndex', 'getVoiceEnvPanIndex', 'getVoiceEnvFilterIndex', 'getVoiceEnvPitchIndex']
    const ENV_TIMEFN = ['getVoiceEnvVolTime', 'getVoiceEnvPanTime', 'getVoiceEnvFilterTime', 'getVoiceEnvPitchTime']

    // ── model ─────────────────────────────────────────────────────────────────
    let rec      = (SLOT >= 0) ? readInstRecord(SLOT) : null
    const isMeta = rec ? recordIsMeta(rec) : false
    let meta     = isMeta ? decodeMetaRecord(rec) : null
    const base   = (rec && !isMeta) ? decodeInstFull(rec) : null
    let patches = (rec && !isMeta) ? decodeIxmpPatches(SLOT) : null
    const noApi  = (!isMeta && patches === null)
    const baseEnvs = base ? [base.volEnv, base.panEnv, base.filterEnv, base.pitchEnv] : [null, null, null, null]

    // Unified zone list (each: pitchStart/End, volStart/End, kind, label, detail src).
    const zones = []
    if (isMeta) {
        meta.layers.forEach((L) => zones.push({ kind: 'layer', layer: L,
            pitchStart: L.pitchStart, pitchEnd: L.pitchEnd, volStart: L.volStart, volEnd: L.volEnd }))
    } else if (rec) {
        (patches || []).forEach((p) => zones.push(p))
        // base fallback entry — drawn as the backdrop, listed last
        zones.push({ kind: 'base', pitchStart: 0, pitchEnd: 0xFFFF, volStart: 0, volEnd: 63 })
    }
    let selIdx = 0, listScroll = 0, envKind = 0

    // ── pitch range (union of real zones; base alone -> whole-map backdrop) ────
    let minP = Infinity, maxP = -Infinity
    zones.forEach((z) => { if (z.kind !== 'base') { if (z.pitchStart < minP) minP = z.pitchStart; if (z.pitchEnd > maxP) maxP = z.pitchEnd } })
    if (!isFinite(minP)) { minP = 0x1000; maxP = 0x9000 }
    if (maxP <= minP) maxP = minP + 1

    const colOf = (note) => {
        let c = MAP_X + Math.round((note - minP) / (maxP - minP) * (MAP_W - 1))
        if (c < MAP_X) c = MAP_X; if (c > MAP_X + MAP_W - 1) c = MAP_X + MAP_W - 1
        return c
    }
    // map-rect of each non-base zone (precomputed for fill + hit-test)
    const rectOf = (z) => ({
        cx0: colOf(z.pitchStart), cx1: colOf(z.pitchEnd),
        ry0: MAP_Y + Math.round((63 - Math.min(63, z.volEnd))   / 63 * (MAP_H - 1)),
        ry1: MAP_Y + Math.round((63 - Math.max(0,  z.volStart)) / 63 * (MAP_H - 1)),
    })
    let rects = zones.map((z) => z.kind === 'base' ? null : rectOf(z))

    // Rebuild zones/range/rects after a patch edit (the model consts above are
    // built once at entry; edits re-run the same derivation).
    function rebuildModel(nextSel) {
        zones.length = 0
        if (isMeta) {
            meta.layers.forEach((L) => zones.push({ kind: 'layer', layer: L,
                pitchStart: L.pitchStart, pitchEnd: L.pitchEnd, volStart: L.volStart, volEnd: L.volEnd }))
        } else if (rec) {
            (patches || []).forEach((p) => zones.push(p))
            zones.push({ kind: 'base', pitchStart: 0, pitchEnd: 0xFFFF, volStart: 0, volEnd: 63 })
        }
        minP = Infinity; maxP = -Infinity
        zones.forEach((z) => { if (z.kind !== 'base') { if (z.pitchStart < minP) minP = z.pitchStart; if (z.pitchEnd > maxP) maxP = z.pitchEnd } })
        if (!isFinite(minP)) { minP = 0x1000; maxP = 0x9000 }
        if (maxP <= minP) maxP = minP + 1
        rects = zones.map((z) => z.kind === 'base' ? null : rectOf(z))
        if (nextSel !== undefined) selIdx = nextSel
        selIdx = Math.max(0, Math.min(selIdx, zones.length - 1))
        clampList()
    }

    // zone index covering a map cell (first matching non-base rect), or -1 = base
    const zoneAtCell = (col, row) => {
        for (let i = 0; i < zones.length; i++) {
            const r = rects[i]; if (!r) continue
            if (col >= r.cx0 && col <= r.cx1 && row >= r.ry0 && row <= r.ry1) return i
        }
        return -1
    }
    const baseIdx = () => { for (let i = 0; i < zones.length; i++) if (zones[i].kind === 'base') return i; return -1 }
    const zoneBg = (i) => (i < 0) ? baseBg : (i === selIdx) ? colHighlight : PAL[i % PAL.length]
    const zoneFg = (i) => (i < 0) ? baseFg : (i === selIdx) ? colWHITE : colBLACK
    function clampList() {
        if (selIdx < listScroll) listScroll = selIdx
        if (selIdx >= listScroll + LIST_H) listScroll = selIdx - LIST_H + 1
        const maxS = Math.max(0, zones.length - LIST_H)
        if (listScroll > maxS) listScroll = maxS
        if (listScroll < 0) listScroll = 0
    }

    // selected zone's envelope for the current envKind (patch's own, else base's).
    function envForSel() {
        const z = zones[selIdx]
        if (!z) return null
        if (z.kind === 'layer') return null
        if (z.kind === 'patch') {
            const e = [z.volEnv, z.panEnv, z.filterEnv, z.pitchEnv][envKind]
            if (e) return { env: e, src: 'patch' }
        }
        return baseEnvs[envKind] ? { env: baseEnvs[envKind], src: 'base' } : null
    }

    // ── patch editing (web 49b port; non-meta instruments) ────────────────────
    // All edits stream through commitPatches: rebuild the on-wire blob, upload
    // it to the device (persists via the capture save + is heard immediately),
    // re-decode, rebuild the model and repaint. NOT undoable.
    const dlgChrome = { drawFrame: HUB.popups.popupDrawFrame, colours: HUB.popups.popupColours }
    const OKCANCEL = [{ label: 'OK', action: 'ok' }, { label: 'Cancel', action: 'cancel' }]
    function numOf(str, radix, dflt) {
        const n = parseInt(('' + (str == null ? '' : str)).trim(), radix)
        return isNaN(n) ? dflt : n
    }
    function selPatch() {
        const z = zones[selIdx]
        return (z && z.kind === 'patch') ? z : null
    }
    function commitPatches(nextSel) {
        audio.uploadInstrumentPatches(SLOT, encodeIxmpPatches(patches))
        HUB.markUnsaved()
        refreshSamplesCache()
        patches = decodeIxmpPatches(SLOT) || []
        rebuildModel(nextSel)
        repaintAll()
    }
    // New patch seeded from the base record (full pitch/vol rect; pan $FF /
    // noteVol 0 / vibWave $FF = the inherit sentinels the engine honours).
    function addPatch() {
        if (isMeta || !rec || noApi || !base) return
        patches = patches || []
        patches.push({
            kind: 'patch', ver: 0x01, raw: null,
            pitchStart: 0x0020, pitchEnd: 0xFFFF, volStart: 0, volEnd: 63,
            ptr: base.samplePtr, len: base.sampleLen, playStart: base.playStart,
            loopStart: base.sLoopStart, loopEnd: base.sLoopEnd,
            rate: base.c4Rate, detune: 0, loopMode: base.sampleFlags & 0x07,
            pan: 0xFF, noteVol: 0,
            vibSpeed: 0, vibSweep: 0, vibDepth: 0, vibRate: 0, vibWave: 0xFF,
            hasExtra: false, fadeoutStep: 0, filterSfMode: false,
            extraCutoff: 0xFF, extraResonance: 0xFF, extraAtten: 0,
            hasVol: false, hasPan: false, hasFil: false, hasPit: false,
            volEnv: null, panEnv: null, filterEnv: null, pitchEnv: null,
        })
        commitPatches(patches.length - 1)
    }
    function duplicatePatch() {
        const p = selPatch(); if (!p) return
        const copy = {}
        for (const k in p) copy[k] = p[k]
        if (p.raw) copy.raw = p.raw.slice(0)
        patches.splice(selIdx + 1, 0, copy)
        commitPatches(selIdx + 1)
    }
    function deletePatch() {
        const p = selPatch(); if (!p) return
        const res = win.showDialog(Object.assign({
            title: 'Delete patch',
            message: ['Delete patch ' + selIdx.toString(16).toUpperCase() + '? This cannot be undone.'],
            buttons: [{ label: 'Delete', action: 'ok' }, { label: 'Cancel', action: 'cancel', default: true }],
        }, dlgChrome))
        if (res.action === 'ok') { patches.splice(selIdx, 1); commitPatches(Math.max(0, selIdx - 1)) }
        else repaintAll()
    }
    // Reorder — patch order IS the trigger match priority (first hit wins).
    function movePatch(d) {
        const p = selPatch(); if (!p) return
        const j = selIdx + d
        if (j < 0 || j >= patches.length) return
        patches[selIdx] = patches[j]; patches[j] = p
        commitPatches(j)
    }
    function editZoneRect() {
        const p = selPatch(); if (!p) return
        const res = win.showDialog(Object.assign({
            title: 'Zone rectangle (hex)',
            fields: [
                { label: 'Pitch lo:',      width: 6, maxLength: 4, initial: p.pitchStart.toString(16).toUpperCase() },
                { label: 'Pitch hi:',      width: 6, maxLength: 4, initial: p.pitchEnd.toString(16).toUpperCase() },
                { label: 'Vol lo (0-3F):', width: 4, maxLength: 2, initial: p.volStart.toString(16).toUpperCase() },
                { label: 'Vol hi (0-3F):', width: 4, maxLength: 2, initial: p.volEnd.toString(16).toUpperCase() },
            ],
            buttons: OKCANCEL,
        }, dlgChrome))
        if (res.action === 'ok') {
            p.pitchStart = Math.min(0xFFFF, Math.max(0, numOf(res.values[0], 16, p.pitchStart)))
            p.pitchEnd   = Math.min(0xFFFF, Math.max(0, numOf(res.values[1], 16, p.pitchEnd)))
            p.volStart   = Math.min(63, Math.max(0, numOf(res.values[2], 16, p.volStart)))
            p.volEnd     = Math.min(63, Math.max(0, numOf(res.values[3], 16, p.volEnd)))
            commitPatches(selIdx)
        } else repaintAll()
    }
    function editTuning() {
        const p = selPatch(); if (!p) return
        const res = win.showDialog(Object.assign({
            title: 'Tuning / level',
            message: ['Pan $FF and NoteVol $00 mean "inherit base".'],
            fields: [
                { label: 'Rate Hz (dec):',   width: 7, maxLength: 5, initial: '' + p.rate },
                { label: 'Detune (dec):',    width: 8, maxLength: 6, initial: '' + p.detune },
                { label: 'Pan (hex):',       width: 4, maxLength: 2, initial: p.pan.toString(16).toUpperCase() },
                { label: 'NoteVol (hex):',   width: 4, maxLength: 2, initial: p.noteVol.toString(16).toUpperCase() },
            ],
            buttons: OKCANCEL,
        }, dlgChrome))
        if (res.action === 'ok') {
            p.rate    = Math.min(65535, Math.max(1, numOf(res.values[0], 10, p.rate)))
            p.detune  = Math.min(32767, Math.max(-32768, numOf(res.values[1], 10, p.detune)))
            p.pan     = Math.min(255, Math.max(0, numOf(res.values[2], 16, p.pan)))
            p.noteVol = Math.min(255, Math.max(0, numOf(res.values[3], 16, p.noteVol)))
            commitPatches(selIdx)
        } else repaintAll()
    }
    function editLoop() {
        const p = selPatch(); if (!p) return
        const res = win.showDialog(Object.assign({
            title: 'Play / loop (frames, dec)',
            fields: [
                { label: 'Play start:', width: 7, maxLength: 5, initial: '' + p.playStart },
                { label: 'Loop start:', width: 7, maxLength: 5, initial: '' + p.loopStart },
                { label: 'Loop end:',   width: 7, maxLength: 5, initial: '' + p.loopEnd },
                { label: 'Mode (0-7):', width: 3, maxLength: 1, initial: '' + (p.loopMode & 0x07) },
            ],
            buttons: OKCANCEL,
        }, dlgChrome))
        if (res.action === 'ok') {
            p.playStart = Math.min(65535, Math.max(0, numOf(res.values[0], 10, p.playStart)))
            p.loopStart = Math.min(65535, Math.max(0, numOf(res.values[1], 10, p.loopStart)))
            p.loopEnd   = Math.min(65535, Math.max(0, numOf(res.values[2], 10, p.loopEnd)))
            p.loopMode  = (p.loopMode & ~0x07) | (Math.min(7, Math.max(0, numOf(res.values[3], 10, p.loopMode & 0x07))))
            commitPatches(selIdx)
        } else repaintAll()
    }
    // Bind a pooled sample from the census; rate/playStart/loops follow it.
    function bindSample() {
        const p = selPatch(); if (!p) return
        const list = samplesCache || []
        if (list.length === 0) return
        const items = list.map((sm, i) => ({
            label: ' #' + (i + 1).toString(16).toUpperCase().padStart(2, '0') + ' '
                 + (sm.name || '(unnamed)').substring(0, 18) + '  len ' + sm.len,
            smp: sm,
        }))
        const res = win.showDialog(Object.assign({
            title: 'Bind sample',
            list: { items: items, height: Math.min(items.length, 14), width: 36, cursor: 0,
                    scrollbarChars: HUB.popups.popupScrollbarChars },
            buttons: OKCANCEL,
        }, dlgChrome))
        if (res.action === 'ok' && res.listItem) {
            const sm = res.listItem.smp
            p.ptr = sm.ptr; p.len = sm.len; p.rate = sm.c4Rate
            p.playStart = sm.playStart; p.loopStart = sm.loopStart; p.loopEnd = sm.loopEnd
            p.loopMode = sm.sampleFlags & 0x07
            commitPatches(selIdx)
        } else repaintAll()
    }

    // ── envelope overrides on patches (web 49b Note-7 behaviour) ──────────────
    // 'O' on an env tab toggles the selected patch's own envelope block for
    // that kind. Enabling COPIES the base envelope — for Filter/Pitch, the
    // slot currently holding the role — and stamps present bit 13 (+ the role
    // m-bit 7 for filter/pitch) per spec Note 7; disabling cuts the block.
    // Node editing then works on the patch's own block with the same keys as
    // the base tabs (',' '.' select, '-'/'=' value, '[' ']' duration).
    const ENV_KIND_SPECS = [
        { bit: 0x02, flag: 'hasVol', envProp: 'volEnv' },
        { bit: 0x04, flag: 'hasPan', envProp: 'panEnv' },
        { bit: 0x08, flag: 'hasFil', envProp: 'filterEnv' },
        { bit: 0x10, flag: 'hasPit', envProp: 'pitchEnv' },
    ]
    let advEnvSel = 0
    // Byte offset of kind `k`'s 54-byte block inside p.raw, or -1 when absent.
    function patchBlockOff(p, k) {
        let off = 31 + (p.hasExtra ? 15 : 0)
        for (let i = 0; i < ENV_KIND_SPECS.length; i++) {
            if (i === k) return p[ENV_KIND_SPECS[i].flag] ? off : -1
            if (p[ENV_KIND_SPECS[i].flag]) off += 54
        }
        return -1
    }
    function toggleEnvOverride() {
        const pz = selPatch()
        if (!pz || envKind >= ENV_WAVE || !pz.raw || pz.raw.length < 31) return
        const spec = ENV_KIND_SPECS[envKind]
        // canonical insert position for this kind (blocks ride in v,p,f,P order)
        let at = 31 + (pz.hasExtra ? 15 : 0)
        for (let i = 0; i < envKind; i++) if (pz[ENV_KIND_SPECS[i].flag]) at += 54
        if (pz[spec.flag]) {
            pz.raw = pz.raw.slice(0, at).concat(pz.raw.slice(at + 54))
            pz[spec.flag] = false
            pz.raw[0] = pz.raw[0] & ~spec.bit
        } else {
            const baseEnv = baseEnvs[envKind]
            if (!baseEnv) return
            const rec2 = readInstRecord(SLOT)
            const blk = new Array(54)
            blk[0] = rec2[baseEnv.loopOff] & 0xFF
            blk[1] = (rec2[baseEnv.loopOff + 1] | 0x20) & 0xFF      // present bit 13
            if (envKind === 2) blk[0] |= 0x80                        // filter role m-bit
            else if (envKind === 3) blk[0] &= ~0x80                  // pitch role m-bit clear
            blk[2] = rec2[baseEnv.sustOff] & 0xFF
            blk[3] = rec2[baseEnv.sustOff + 1] & 0xFF
            for (let i = 0; i < 50; i++) blk[4 + i] = rec2[baseEnv.nodeBase + i] & 0xFF
            pz.raw = pz.raw.slice(0, at).concat(blk, pz.raw.slice(at))
            pz[spec.flag] = true
            pz.raw[0] = pz.raw[0] | spec.bit
        }
        pz.ver = pz.raw[0]
        advEnvSel = 0
        commitPatches(selIdx)
    }
    // Keyboard node editing on the selected patch's OWN env block. Returns
    // true when the key was consumed (base-sourced envs stay read-only here —
    // edit those on the Instruments tabs).
    function patchEnvEditKey(ks) {
        if (envKind >= ENV_WAVE) return false
        const pz = selPatch(); if (!pz) return false
        const spec = ENV_KIND_SPECS[envKind]
        if (!pz[spec.flag]) return false
        const bOff = patchBlockOff(pz, envKind)
        if (bOff < 0 || !pz.raw) return false
        const envObj = pz[spec.envProp]
        const last = envObj ? envLastIdx(envObj) : 0
        if (advEnvSel > last) advEnvSel = last
        if (ks === ',') { advEnvSel = Math.max(0, advEnvSel - 1); drawEnvGraph(); return true }
        if (ks === '.') { advEnvSel = Math.min(last, advEnvSel + 1); drawEnvGraph(); return true }
        const mask = (envKind === 0) ? 0x3F : 0xFF
        const vOff = bOff + 4 + advEnvSel * 2
        const dOff = bOff + 4 + (advEnvSel - 1) * 2 + 1
        const raw = pz.raw
        let touched = false
        if (ks === '-' || ks === '=' || ks === '_' || ks === '+') {
            const d = (ks === '=') ? 1 : (ks === '-') ? -1 : (ks === '+') ? 8 : -8
            raw[vOff] = (raw[vOff] & ~mask) | Math.max(0, Math.min(mask, (raw[vOff] & mask) + d))
            touched = true
        } else if ((ks === '[' || ks === ']' || ks === '{' || ks === '}') && advEnvSel > 0) {
            const d = (ks === ']') ? 1 : (ks === '[') ? -1 : (ks === '}') ? 16 : -16
            raw[dOff] = Math.max(1, Math.min(255, raw[dOff] + d))
            touched = true
        }
        if (!touched) return false
        commitPatches(selIdx)
        return true
    }

    // ── meta LAYER editing (record bytes, not Ixmp) ────────────────────────────
    // Layer edits rebuild the 256-byte record and go through uploadInstrument:
    // the engine only re-parses metaLayers in loadRecord — per-byte pokes would
    // update the raw window but leave the parsed layer table stale (the same
    // gotcha the web's setMetaBytesOp exists for). Layers are 10-byte rows from
    // byte 4; count in byte 1; the 10-bit child index splits low-8 / bits 8..9
    // into volStart's bits 6..7. Max 25 layers. NOT undoable.
    const META_MAX_LAYERS = 25
    function selLayer() {
        const z = zones[selIdx]
        return (z && z.kind === 'layer') ? z.layer : null
    }
    function layersCopy() {
        return meta.layers.map((L) => ({ instIdx: L.instIdx, mixOctet: L.mixOctet, detune: L.detune,
            pitchStart: L.pitchStart, pitchEnd: L.pitchEnd, volStart: L.volStart, volEnd: L.volEnd }))
    }
    function commitLayers(layers, nextSel, flagsByte) {
        const r2 = readInstRecord(SLOT)
        const bytes = new Array(256)
        for (let i = 0; i < 256; i++) bytes[i] = r2[i] & 0xFF
        if (flagsByte !== undefined) bytes[0] = flagsByte & 0xFF
        bytes[1] = layers.length & 0xFF
        bytes[2] = 0xFF; bytes[3] = 0xFF
        let o = 4
        for (let i = 0; i < layers.length; i++) {
            const L = layers[i]
            bytes[o]     = L.instIdx & 0xFF
            bytes[o + 1] = L.mixOctet & 0xFF
            const det = L.detune & 0xFFFF
            bytes[o + 2] = det & 0xFF; bytes[o + 3] = (det >>> 8) & 0xFF
            bytes[o + 4] = L.pitchStart & 0xFF; bytes[o + 5] = (L.pitchStart >>> 8) & 0xFF
            bytes[o + 6] = L.pitchEnd & 0xFF;   bytes[o + 7] = (L.pitchEnd >>> 8) & 0xFF
            bytes[o + 8] = (L.volStart & 0x3F) | (((L.instIdx >>> 8) & 0x3) << 6)
            bytes[o + 9] = L.volEnd & 0x3F
            o += 10
        }
        audio.uploadInstrument(SLOT, bytes)
        HUB.markUnsaved()
        rec = readInstRecord(SLOT)
        meta = decodeMetaRecord(rec)
        refreshInstrumentsCache()
        rebuildModel(nextSel)
        repaintAll()
    }
    // Child-instrument picker: any non-meta census entry (incl. aux bin $100+).
    function pickChildInstrument() {
        const cache = instrumentsCache || []
        const items = []
        for (let i = 0; i < cache.length; i++) {
            const e2 = cache[i]
            if (e2.decoded.isMeta || e2.slot === SLOT) continue
            items.push({ label: ' $' + e2.slot.toString(16).toUpperCase().padStart(2, '0')
                              + ' ' + (e2.name || '').substring(0, 22), slot: e2.slot })
        }
        if (items.length === 0) return -1
        const res = win.showDialog(Object.assign({
            title: 'Layer instrument',
            list: { items: items, height: Math.min(items.length, 14), width: 34, cursor: 0,
                    scrollbarChars: HUB.popups.popupScrollbarChars },
            buttons: OKCANCEL,
        }, dlgChrome))
        return (res.action === 'ok' && res.listItem) ? res.listItem.slot : -1
    }
    function addLayer() {
        if (meta.layers.length >= META_MAX_LAYERS) return
        const slot2 = pickChildInstrument()
        if (slot2 < 0) { repaintAll(); return }
        const layers = layersCopy()
        layers.push({ instIdx: slot2, mixOctet: 159, detune: 0,
                      pitchStart: 0x0020, pitchEnd: 0xFFFF, volStart: 0, volEnd: 63 })
        commitLayers(layers, layers.length - 1)
    }
    function duplicateLayer() {
        const L = selLayer(); if (!L) return
        if (meta.layers.length >= META_MAX_LAYERS) return
        const layers = layersCopy()
        layers.splice(selIdx + 1, 0, { instIdx: L.instIdx, mixOctet: L.mixOctet, detune: L.detune,
            pitchStart: L.pitchStart, pitchEnd: L.pitchEnd, volStart: L.volStart, volEnd: L.volEnd })
        commitLayers(layers, selIdx + 1)
    }
    function deleteLayer() {
        const L = selLayer(); if (!L) return
        const res = win.showDialog(Object.assign({
            title: 'Delete layer',
            message: ['Delete layer ' + selIdx + ' (inst $' + L.instIdx.toString(16).toUpperCase() + ')?',
                      'This cannot be undone.'],
            buttons: [{ label: 'Delete', action: 'ok' }, { label: 'Cancel', action: 'cancel', default: true }],
        }, dlgChrome))
        if (res.action === 'ok') {
            const layers = layersCopy()
            layers.splice(selIdx, 1)
            commitLayers(layers, Math.max(0, selIdx - 1))
        } else repaintAll()
    }
    // Layer 0 is the FOREGROUND layer (the rest spawn as background children).
    function moveLayer(d) {
        const L = selLayer(); if (!L) return
        const j = selIdx + d
        if (j < 0 || j >= meta.layers.length) return
        const layers = layersCopy()
        const t2 = layers[selIdx]; layers[selIdx] = layers[j]; layers[j] = t2
        commitLayers(layers, j)
    }
    function editLayerRect() {
        const L = selLayer(); if (!L) return
        const res = win.showDialog(Object.assign({
            title: 'Layer rectangle (hex)',
            fields: [
                { label: 'Pitch lo:',      width: 6, maxLength: 4, initial: L.pitchStart.toString(16).toUpperCase() },
                { label: 'Pitch hi:',      width: 6, maxLength: 4, initial: L.pitchEnd.toString(16).toUpperCase() },
                { label: 'Vol lo (0-3F):', width: 4, maxLength: 2, initial: L.volStart.toString(16).toUpperCase() },
                { label: 'Vol hi (0-3F):', width: 4, maxLength: 2, initial: L.volEnd.toString(16).toUpperCase() },
            ],
            buttons: OKCANCEL,
        }, dlgChrome))
        if (res.action === 'ok') {
            const layers = layersCopy()
            const T = layers[selIdx]
            T.pitchStart = Math.min(0xFFFF, Math.max(0, numOf(res.values[0], 16, T.pitchStart)))
            T.pitchEnd   = Math.min(0xFFFF, Math.max(0, numOf(res.values[1], 16, T.pitchEnd)))
            T.volStart   = Math.min(63, Math.max(0, numOf(res.values[2], 16, T.volStart)))
            T.volEnd     = Math.min(63, Math.max(0, numOf(res.values[3], 16, T.volEnd)))
            commitLayers(layers, selIdx)
        } else repaintAll()
    }
    function editLayerMix() {
        const L = selLayer(); if (!L) return
        const res = win.showDialog(Object.assign({
            title: 'Layer mix / detune',
            message: ['Mix is the PSO octet: 159 = 0 dB, lower = quieter.'],
            fields: [
                { label: 'Mix (0-255):',        width: 5, maxLength: 3, initial: '' + L.mixOctet },
                { label: 'Detune (dec 4096T):', width: 8, maxLength: 6, initial: '' + L.detune },
            ],
            buttons: OKCANCEL,
        }, dlgChrome))
        if (res.action === 'ok') {
            const layers = layersCopy()
            const T = layers[selIdx]
            T.mixOctet = Math.min(255, Math.max(0, numOf(res.values[0], 10, T.mixOctet)))
            T.detune   = Math.min(32767, Math.max(-32768, numOf(res.values[1], 10, T.detune)))
            commitLayers(layers, selIdx)
        } else repaintAll()
    }
    function bindLayerInst() {
        const L = selLayer(); if (!L) return
        const slot2 = pickChildInstrument()
        if (slot2 < 0) { repaintAll(); return }
        const layers = layersCopy()
        layers[selIdx].instIdx = slot2
        commitLayers(layers, selIdx)
    }
    // Strict gating flag (byte 0 bit 0): a strict meta only sounds where a
    // layer child's patches cover the note (terranmon Metainstrument def).
    function toggleStrict() {
        commitLayers(layersCopy(), selIdx, (rec[0] & 0xFF) ^ 0x01)
    }

    // ── drawing ────────────────────────────────────────────────────────────────
    function clearPanel() {
        for (let y = Y; y < SCRH; y++) { con.move(y, 1); con.color_pair(cStatus, cBack); print(' '.repeat(SCRW)) }
    }
    function drawHeader() {
        const nm = (SLOT >= 0) ? (advInstName(SLOT)) : ''
        con.move(Y, LIST_X); con.color_pair(cHdr, cBack)
        let h = 'Advanced Edit'
        if (SLOT >= 0) h += '  Inst $' + SLOT.toString(16).toUpperCase().padStart(2,'0') + (nm ? ' "' + nm + '"' : '')
        if (isMeta)      h += '  Metainstrument  ' + meta.layers.length + ' layers' + ((rec[0] & 0x01) ? ' [strict]' : '')
        else if (rec)    h += '  ' + (patches ? patches.length : 0) + ' patches'
        print(h.substring(0, SCRW - 1))
        // separator
        con.color_pair(cDim, cBack)
        for (let y = LIST_Y; y < SCRH; y++) { con.move(y, SEP_X); con.prnch(VERT) }
    }
    function drawList() {
        // NOTE: does not clampList() — wheel scroll is free (selection may scroll off).
        // Keyboard / click selection calls clampList via redrawSel to keep it visible.
        con.move(Y + 1, LIST_X); con.color_pair(cHdr, cBack); print((isMeta ? 'Layers' : 'Patches').padEnd(LIST_W))
        const n = zones.length, maxS = Math.max(0, n - LIST_H)
        const thumb = (n > LIST_H && maxS > 0) ? ((listScroll * (LIST_H - 1) / maxS) | 0) : -1
        for (let r = 0; r < LIST_H; r++) {
            const i = listScroll + r
            const y = LIST_Y + r
            const sel = (i === selIdx && i < n), back = sel ? colHighlight : cBack
            // blob column (col 1) — refreshLiveVoices paints the glyph during playback;
            // here we just lay down the row background so the selection bar is continuous.
            con.move(y, LIST_BLOB_X); con.color_pair(sel ? colWHITE : cStatus, back); print(' ')
            con.move(y, LIST_TEXT_X)
            if (i >= n) { con.color_pair(cStatus, cBack); print(' '.repeat(LIST_TEXT_W)) }
            else {
                const z = zones[i]
                if (z.kind === 'base') {
                    con.color_pair(sel ? colWHITE : cStatus, back)
                    print(('base ' + (base ? advSampleLabel(base.samplePtr, base.sampleLen) : '')).padEnd(LIST_TEXT_W).substring(0, LIST_TEXT_W))
                } else {
                    // blue, zero-padded index (matching the Samples / Instruments lists), then name
                    const numStr = i.toString(16).toUpperCase().padStart(2, '0')
                    const name = (z.kind === 'layer')
                        ? ('>$' + z.layer.instIdx.toString(16).toUpperCase().padStart(2, '0') + ' ' + advInstName(z.layer.instIdx))
                        : advSampleLabel(z.ptr, z.len)
                    con.color_pair(colInst, back); print(numStr + ' ')
                    con.color_pair(sel ? colWHITE : cStatus, back)
                    print(name.padEnd(LIST_TEXT_W - 3).substring(0, LIST_TEXT_W - 3))
                }
            }
            // scroll gutter
            con.move(y, LIST_SCROLL_X)
            if (n > LIST_H) {
                con.color_pair(colScrollBar, cBack)
                let g = (r === 0) ? sym.taut_scrollgutter_top : (r === LIST_H - 1) ? sym.taut_scrollgutter_bot : sym.taut_scrollgutter_mid
                if (r === thumb) g += 3
                con.addch(g)
            } else { con.color_pair(cStatus, cBack); print(' ') }
        }
    }
    function drawMap() {
        // axis label row
        con.move(Y + 1, R_X); con.color_pair(cHdr, cBack); print('vel' + sym.middot + 'PITCH ' + sym.middot + sym.middot + '>')
        // vol axis labels (63 top, 0 bottom)
        con.color_pair(cDim, cBack)
        con.move(MAP_Y, R_X);   print('63')
        con.move(MAP_BOT, R_X); print(' 0')
        // base backdrop
        for (let row = MAP_Y; row <= MAP_BOT; row++) { con.move(row, MAP_X); con.color_pair(baseFg, baseBg); print(' '.repeat(MAP_W)) }
        // patch / layer rects
        for (let i = 0; i < zones.length; i++) {
            const r = rects[i]; if (!r) continue
            const bg = zoneBg(i), fg = zoneFg(i)
            for (let row = r.ry0; row <= r.ry1; row++) { con.move(row, r.cx0); con.color_pair(fg, bg); print(' '.repeat(r.cx1 - r.cx0 + 1)) }
            con.move(r.ry0, r.cx0); con.color_pair(fg, bg); print(i.toString(16).toUpperCase().substring(0, Math.max(1, r.cx1 - r.cx0 + 1)))
        }
        // pitch labels under the map: leftmost + rightmost note names
        con.move(MAP_BOT + 1, MAP_X); con.color_pair(cDim, cBack)
        const lo = (noteToStr(minP) || '').trim(), hi = (noteToStr(maxP) || '').trim()
        print(lo.padEnd(MAP_W - hi.length) + hi)
    }
    function drawDetail() {
        for (let y = DET_Y; y < ENV_HDR_Y; y++) { con.move(y, R_X); con.color_pair(cStatus, cBack); print(' '.repeat(SCRW - R_X + 1)) }
        const z = zones[selIdx]; if (!z) return
        const W = SCRW - R_X
        const put = (dy, fg, s) => { con.move(DET_Y + dy, R_X); con.color_pair(fg, cBack); print(String(s).substring(0, W)) }
        const rng = (a, b) => (noteToStr(a) || '').trim() + '-' + (noteToStr(b) || '').trim()
        if (noApi) { put(0, cStatus, 'Patch read-back unavailable on this host VM.'); put(1, cDim, 'Showing base sample only.'); }
        if (z.kind === 'layer') {
            const L = z.layer
            put(0, cHdr,   'Layer ' + selIdx.toString(16).toUpperCase() + '  -> Inst $' + L.instIdx.toString(16).toUpperCase().padStart(2,'0') + '  ' + advInstName(L.instIdx))
            put(1, cStatus,'Pitch ' + rng(L.pitchStart, L.pitchEnd) + '   Vol ' + L.volStart + '-' + L.volEnd)
            const cents = (L.detune * 1200 / 4096)
            put(2, cStatus,'Mix octet ' + L.mixOctet + (L.mixOctet === 159 ? ' (unity)' : '') + '   Detune ' + (cents >= 0 ? '+' : '') + cents.toFixed(0) + 'c')
            return
        }
        if (z.kind === 'base') {
            if (!base) return
            put(0, cHdr,   'Base sample  ' + advSampleLabel(base.samplePtr, base.sampleLen))
            put(1, cStatus,'Rate@C4 ' + base.c4Rate + 'Hz   Loop ' + loopModeName(base.sampleFlags) + ' [' + hx4(base.sLoopStart) + '..' + hx4(base.sLoopEnd) + ']')
            put(2, cStatus,'(fallback for notes/vels no patch covers)')
            return
        }
        // patch
        put(0, cHdr,    'Patch ' + selIdx.toString(16).toUpperCase() + '  ' + advSampleLabel(z.ptr, z.len))
        put(1, cStatus, 'Pitch ' + rng(z.pitchStart, z.pitchEnd) + '   Vol ' + z.volStart + '-' + z.volEnd + '   Rate ' + z.rate + 'Hz   Det ' + signedC(z.detune))
        put(2, cStatus, 'Loop ' + loopModeName(z.loopMode) + ' [' + hx4(z.loopStart) + '..' + hx4(z.loopEnd) + ']   Pan ' + ovr(z.pan, z.pan === 0xFF) + '   NoteVol ' + ovr(z.noteVol, z.noteVol === 0))
        const envs = (z.hasVol?'V':sym.middot) + (z.hasPan?'P':sym.middot) + (z.hasFil?'F':sym.middot) + (z.hasPit?'p':sym.middot)
        let xline = 'Env ' + envs
        if (z.hasExtra) xline += '  ' + (z.filterSfMode ? 'SF' : 'IT') + ' Cut ' + hx4(z.extraCutoff) + ' Q ' + hx4(z.extraResonance) + ' Fade $' + z.fadeoutStep.toString(16).toUpperCase() + (z.extraAtten ? ' Att ' + z.extraAtten : '')
        put(3, cStatus, xline)
        put(4, cDim,    'Vibr ' + (z.vibWave === 0xFF ? 'base' : ('w' + z.vibWave + ' spd' + z.vibSpeed + ' dep' + z.vibDepth)))
    }
    // The selected zone's sample (for the wavescope), or null for a meta layer.
    function selSample() {
        const z = zones[selIdx]; if (!z) return null
        if (z.kind === 'patch') return { ptr: z.ptr, len: z.len, loopStart: z.loopStart, loopEnd: z.loopEnd }
        if (z.kind === 'base' && base) return { ptr: base.samplePtr, len: base.sampleLen, loopStart: base.sLoopStart, loopEnd: base.sLoopEnd }
        return null
    }

    // Compact sample-waveform (wavescope) — a standalone min/max filled draw into the
    // env-section rect (does NOT reuse the funk-aware viewer drawSampleWaveform). The
    // live play position is overlaid by drawEnvCursor (wave branch).
    function drawAdvWave(smp, r) {
        const wx0 = r.x, wy0 = r.y, wW = r.w, wH = r.h
        const baseY = wy0 + (wH >>> 1)
        const yOf = (v) => wy0 + (((wH * (255 - v)) / 255) | 0)
        const memBase = audio.getMemAddr()
        const prevBank = audio.getSampleBank() || 0
        let curBank = -1
        const readByte = (p) => {
            const abs = smp.ptr + p
            const bank = (abs / TAUT_SBANK_SIZE) | 0
            if (bank !== curBank) { audio.setSampleBank(bank); curBank = bank }
            return sys.peek(memBase - (abs - bank * TAUT_SBANK_SIZE)) & 0xFF
        }
        graphics.plotRect(wx0, baseY, wW, 1, colSmpWaveMid)        // zero line
        if (smp.len <= wW) {
            const rectW = Math.max(1, Math.ceil(wW / smp.len))
            for (let i = 0; i < smp.len; i++) {
                const yv = yOf(readByte(i)), top = Math.min(baseY, yv)
                graphics.plotRect(wx0 + ((i * wW / smp.len) | 0), top, rectW, Math.max(1, Math.abs(baseY - yv)), colSmpWaveLine)
            }
        } else {
            for (let col = 0; col < wW; col++) {
                const start = (col * smp.len / wW) | 0, end = Math.min(smp.len, (((col + 1) * smp.len / wW) | 0))
                if (end <= start) continue
                const step = Math.max(1, ((end - start) / 8) | 0)
                let mn = 255, mx = 0
                for (let p = start; p < end; p += step) { const v = readByte(p); if (v < mn) mn = v; if (v > mx) mx = v }
                const yT = yOf(mx), yB = yOf(mn)
                graphics.plotRect(wx0 + col, Math.min(yT, yB), 1, Math.max(1, Math.abs(yB - yT)), colSmpWaveLine)
            }
        }
        audio.setSampleBank(prevBank)                              // restore active bank
    }

    // Env-section tab strip (clickable). 4 envelopes + Wave. Matches the instruments
    // viewer's drawInstrumentsTabStrip style (shade-cap edges, colTabActive/Inactive).
    function drawEnvTabs() {
        con.move(ENV_HDR_Y, R_X); con.color_pair(colTabBarOrn, colTabBarBack); print(' '.repeat(SCRW - R_X + 1))
        for (let i = 0; i < ENV_TABS.length; i++) {
            const x = R_X + i * ENV_TABW, active = (i === envKind)
            const lbl = ENV_TABS[i]
            const pad = Math.max(0, ENV_TABW - lbl.length), padL = pad >>> 1, padR = pad - padL
            const colFore  = active ? colTabActive   : colTabInactive
            const colBack  = active ? colTabBarBack2  : colTabBarBack
            const colFore2 = active ? colTabBarBack2  : colTabBarBack
            const spcL = active ? sym.leftshade  : ' '
            const spcR = active ? sym.rightshade : ' '
            con.move(ENV_HDR_Y, x)
            con.color_pair(colFore2, colTabBarBack); print(spcL)
            con.color_pair(colFore, colBack); print(' '.repeat(Math.max(0, padL - 1)) + lbl + ' '.repeat(Math.max(0, padR - 1)))
            con.color_pair(colFore2, colTabBarBack); print(spcR)
        }
    }

    // Envelope graph / wavescope (graphics overlay) under the tab strip. The play
    // cursor is painted on top each tick (drawEnvCursor); bg 255 = transparent, so
    // the text tabs / cursor sit over the graphics.
    let envCurCols = [], envCurSig = '~'
    function clearEnvGraphics() { graphics.plotRect(ENV_RECT.x - 2, ENV_RECT.y - 2, ENV_RECT.w + 4, ENV_RECT.h + 4, 255) }
    function drawEnvGraph() {
        envCurCols = []; envCurSig = '~'
        clearEnvGraphics()
        for (let y = ENV_INFO_Y; y < SCRH; y++) { con.move(y, R_X); con.color_pair(cStatus, cBack); print(' '.repeat(SCRW - R_X + 1)) }
        drawEnvTabs()
        if (envKind === ENV_WAVE) {
            const smp = selSample()
            if (!smp || smp.len === 0) { con.move(ENV_TOP_Y, R_X); con.color_pair(cDim, cBack); print('(no sample)') }
            else {
                con.move(ENV_INFO_Y, R_X); con.color_pair(cDim, cBack); print('Length ' + smp.len + ' B')
                drawAdvWave(smp, ENV_RECT)
            }
            return
        }
        const sel = envForSel()
        // source indicator on the tab row (item 1) — the graph rows host the play
        // cursor, which would otherwise erase it.
        con.move(ENV_HDR_Y, ENV_SRC_X); con.color_pair(colTabInactive, colTabBarBack)
        print((sel ? '(' + sel.src + ')' : '').padEnd(SCRW - ENV_SRC_X + 1).substring(0, SCRW - ENV_SRC_X + 1))
        if (!sel || !sel.env || !sel.env.present) {
            con.move(ENV_TOP_Y - 1, R_X); con.color_pair(cDim, cBack)
            print(zones[selIdx] && zones[selIdx].kind === 'layer' ? '(see the layer instrument)' : 'no ' + ENV_TABS[envKind].toLowerCase() + ' envelope')
            return
        }
        // length + time-grid step, like the base instrument panel's envelope tab
        const env = sel.env
        const lastIdx = (env.terminatorIdx >= 0) ? env.terminatorIdx : (env.nodes.length - 1)
        let totalSec = 0
        for (let i = 0; i < lastIdx; i++) totalSec += env.nodes[i].durSec
        con.move(ENV_INFO_Y, R_X); con.color_pair(cDim, cBack)
        print('Length ' + totalSec.toFixed(3) + ' s   grid ' + pickEnvTimeGrid(Math.max(totalSec, 1e-6)) + ' s')
        drawEnvelopeGraph(sel.env, ENV_RECT, sel.src === 'patch' ? advEnvSel : undefined)
    }
    function drawEnvCursor() {
        // Compute the displayed env's playhead hairline column(s), then repaint only
        // when they change (sig guard, like the viewer's drawEnvelopeCursor) so the
        // busy-loop doesn't flicker the hairline every spin.
        let cols = [], colMap = {}
        const playing = HUB.getPlaybackMode() !== PLAYMODE_NONE
        if (SLOT >= 0 && playing && envKind === ENV_WAVE) {
            // Wavescope: hairline at each voice's sample play position (getVoiceSamplePos).
            const smp = selSample()
            if (smp && smp.len > 0) {
                const hits = []
                const voices = activeVoicesForInstSlot(SLOT)
                for (let k = 0; k < voices.length; k++) {
                    const v = voices[k].voice
                    if (audio.getVoiceSamplePtr(PLAYHEAD, v) !== smp.ptr || audio.getVoiceSampleLength(PLAYHEAD, v) !== smp.len) continue
                    const pos = audio.getVoiceSamplePos(PLAYHEAD, v); if (pos < 0) continue
                    const xPix = ENV_RECT.x + Math.min(ENV_RECT.w - 1, Math.max(0, ((pos / smp.len) * (ENV_RECT.w - 1)) | 0))
                    const h = pixelToHairline(xPix)
                    hits.push({ col: h.col, hair: h.hair, vol: voices[k].vol })
                }
                const res = resolveHairlineHits(hits); cols = res.cols; colMap = res.colMap
            }
        } else if (SLOT >= 0 && playing && envKind !== ENV_WAVE) {
            const sel = envForSel()
            const okFilter = !(envKind === 2 && !hasFilterEnvAPI)
            if (sel && sel.env && sel.env.present && okFilter) {
                const env = sel.env
                const lastIdx = (env.terminatorIdx >= 0) ? env.terminatorIdx : (env.nodes.length - 1)
                if (lastIdx >= 0) {
                    let acc = 0; const xs = new Array(lastIdx + 1); xs[0] = 0
                    for (let i = 1; i <= lastIdx; i++) { acc += env.nodes[i - 1].durSec; xs[i] = acc }
                    const totalTime = Math.max(acc, 1e-6)
                    const idxFn = ENV_IDXFN[envKind], timeFn = ENV_TIMEFN[envKind]
                    const hits = []
                    const voices = activeVoicesForInstSlot(SLOT)
                    for (let k = 0; k < voices.length; k++) {
                        const v = voices[k].voice
                        const ei0 = audio[idxFn](PLAYHEAD, v); if (ei0 < 0) continue
                        const ei = Math.max(0, Math.min(lastIdx, ei0))
                        const segLen = (ei < lastIdx) ? env.nodes[ei].durSec : 0
                        const tInto = Math.max(0, Math.min(segLen, audio[timeFn](PLAYHEAD, v)))
                        const xPix = ENV_RECT.x + Math.min(ENV_RECT.w - 1, Math.max(0, (((xs[ei] + tInto) / totalTime) * (ENV_RECT.w - 1)) | 0))
                        const h = pixelToHairline(xPix)
                        hits.push({ col: h.col, hair: h.hair, vol: voices[k].vol })
                    }
                    const res = resolveHairlineHits(hits); cols = res.cols; colMap = res.colMap
                }
            }
        }
        const sig = cols.map((c) => c + colMap[c]).join(',')
        if (sig === envCurSig) return
        for (let k = 0; k < envCurCols.length; k++) {     // erase old hairlines (transparent)
            con.color_pair(cStatus, cBack)
            for (let y = ENV_TOP_Y; y < SCRH; y++) { con.move(y, envCurCols[k]); print(' ') }
        }
        for (let c = 0; c < cols.length; c++) {           // paint new
            con.color_pair(colPlayCursor, cBack)
            for (let y = ENV_TOP_Y; y < SCRH; y++) { con.move(y, cols[c]); print(colMap[cols[c]]) }
        }
        envCurCols = cols.slice(); envCurSig = sig
    }
    function drawHint() {
        con.move(SCRH, 1); con.color_pair(cStatus, cBack); print(' '.repeat(SCRW - 1))
        con.move(SCRH, 1)
        con.color_pair(cHdr, cBack); print('Up/Dn ');  con.color_pair(cStatus, cBack); print((isMeta ? 'Layer ' : 'Patch '))
        con.color_pair(cHdr, cBack); print(sym.panle + sym.panri + ' '); con.color_pair(cStatus, cBack); print('Tab ')
        if (!isMeta && rec && !noApi) {
            con.color_pair(cHdr, cBack); print('N/C/X '); con.color_pair(cStatus, cBack); print('new/dup/del ')
            con.color_pair(cHdr, cBack); print('K/J ');   con.color_pair(cStatus, cBack); print('order ')
            con.color_pair(cHdr, cBack); print('E/T/L/S '); con.color_pair(cStatus, cBack); print('edit ')
            con.color_pair(cHdr, cBack); print('O '); con.color_pair(cStatus, cBack); print('env ')
        } else if (isMeta && rec) {
            con.color_pair(cHdr, cBack); print('N/C/X '); con.color_pair(cStatus, cBack); print('new/dup/del ')
            con.color_pair(cHdr, cBack); print('K/J ');   con.color_pair(cStatus, cBack); print('order ')
            con.color_pair(cHdr, cBack); print('E/T/S '); con.color_pair(cStatus, cBack); print('edit ')
            con.color_pair(cHdr, cBack); print('G ');     con.color_pair(cStatus, cBack); print('strict ')
        }
        con.color_pair(cHdr, cBack); print('Esc '); con.color_pair(cStatus, cBack); print('Back')
    }

    // ── live overlay (onTick): map blobs + patch-list blobs + env/wave cursor ──
    // voicePeak[v] = { note, peak } tracks the spawn-volume proxy: the PEAK effective
    // volume since the note started (reset on note change). The map blob's Y uses this
    // so it pins to the trigger velocity instead of drifting down as the env decays.
    let liveSig = '~'
    const voicePeak = []
    function refreshLiveVoices() {
        if (SLOT < 0 || zones.length === 0) { drawEnvCursor(); return }
        const song = HUB.getSong()
        const nv = (song && song.numVoices) ? song.numVoices : NUM_VOICES
        const playing = (HUB.getPlaybackMode() !== PLAYMODE_NONE)
        const blobs = []
        const litVol = new Array(zones.length).fill(0)   // max CURRENT eff vol per zone (brightness)
        const litCnt = new Array(zones.length).fill(0)   // sounding-voice count per zone (heat)
        for (let v = 0; v < nv; v++) {
            // During playback show only THIS instrument's voices; during a (stopped) jam
            // audition show the active jam voice(s) — a meta plays its foreground layer under
            // a layer instrument, not SLOT, so don't filter on SLOT while stopped.
            if (!audio.getVoiceActive(PLAYHEAD, v) || (playing && audio.getVoiceInstrument(PLAYHEAD, v) !== SLOT)) { voicePeak[v] = null; continue }
            const note = audio.getVoiceNote(PLAYHEAD, v)
            const eff  = audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0
            let pk = voicePeak[v]
            if (!pk || pk.note !== note) pk = voicePeak[v] = { note, peak: eff }
            else if (eff > pk.peak) pk.peak = eff
            const sv = Math.round(pk.peak * 63)          // spawn-volume proxy
            blobs.push({ col: colOf(note), row: MAP_Y + Math.round((63 - Math.min(63, Math.max(0, sv))) / 63 * (MAP_H - 1)) })
            // which patch-list row is this voice sounding? (match the playing sample)
            const sp = audio.getVoiceSamplePtr(PLAYHEAD, v), sl = audio.getVoiceSampleLength(PLAYHEAD, v)
            let zi = -1
            for (let i = 0; i < zones.length; i++) { const z = zones[i]; if (z.kind === 'patch' && z.ptr === sp && z.len === sl) { zi = i; break } }
            if (zi < 0) zi = baseIdx()
            if (zi >= 0) { if (eff > litVol[zi]) litVol[zi] = eff; litCnt[zi]++ }
        }
        const sig = blobs.map((b) => b.col + ':' + b.row).sort().join(',') + '|' +
                    litVol.map((x, i) => blobLevelForVolume(x) + 'x' + litCnt[i]).join(',')
        if (sig !== liveSig) {
            liveSig = sig
            drawMap()                                  // clears prior map blobs
            for (let k = 0; k < blobs.length; k++) {
                const b = blobs[k]
                con.move(b.row, b.col); con.color_pair(colWHITE, zoneBg(zoneAtCell(b.col, b.row))); print(sym.playhead)
            }
            // patch-list blobs in col 1: glyph shape = volume level, fg = polyphony heat.
            for (let r = 0; r < LIST_H; r++) {
                const i = listScroll + r; if (i >= zones.length) break
                const lvl = Math.max(litCnt[i] > 0 ? 1 : 0, blobLevelForVolume(litVol[i]))
                const bucket = blobPolyBucket(litCnt[i])
                con.move(LIST_Y + r, LIST_BLOB_X)
                con.color_pair(bucket > 0 ? blobPolyCols[bucket - 1] : cStatus, (i === selIdx) ? colHighlight : cBack)
                print(lvl > 0 ? sym['blob' + lvl] : ' ')
            }
        }
        drawEnvCursor()
    }

    // ── mouse ───────────────────────────────────────────────────────────────────
    const redrawSel = () => { clampList(); drawList(); drawMap(); drawDetail(); drawEnvGraph(); liveSig = '~' }
    function registerMouse() {
        HUB.clearPanelMouseRegions()
        HUB.addPanelMouseRegion(LIST_X, LIST_Y, LIST_W, LIST_H, {
            onClick: (cy, cx, btn) => {
                if (btn !== 1) return
                const i = listScroll + (cy - LIST_Y)
                if (i >= 0 && i < zones.length) { selIdx = i; redrawSel() }
            },
            onWheel: (cy, cx, dy) => {
                const maxS = Math.max(0, zones.length - LIST_H)
                listScroll = Math.max(0, Math.min(maxS, listScroll + dy * 3))
                drawList()
            },
        })
        HUB.addPanelMouseRegion(MAP_X, MAP_Y, MAP_W, MAP_H, {
            onClick: (cy, cx, btn) => {
                if (btn !== 1) return
                let zi = zoneAtCell(cx, cy); if (zi < 0) zi = baseIdx()
                if (zi >= 0) { selIdx = zi; redrawSel() }
            },
        })
        // env/wave tab strip (click), + wheel anywhere in the graph body to cycle
        for (let t = 0; t < ENV_TABS.length; t++) {
            const tx = R_X + t * ENV_TABW
            HUB.addPanelMouseRegion(tx, ENV_HDR_Y, ENV_TABW, 1, {
                onClick: (cy, cx, btn) => { if (btn === 1) { envKind = t; drawEnvGraph(); liveSig = '~' } },
            })
        }
        HUB.addPanelMouseRegion(R_X, ENV_TOP_Y, SCRW - R_X + 1, SCRH - ENV_TOP_Y, {
            onWheel: (cy, cx, dy) => { envKind = (envKind + (dy < 0 ? 1 : ENV_TABS.length - 1)) % ENV_TABS.length; drawEnvGraph(); liveSig = '~' },
        })
    }

    // ── compose ────────────────────────────────────────────────────────────────
    // Wipe ALL graphics in the panel area first — the instruments viewer leaves an
    // envelope graph (graphics overlay at instEnvelopeRect, higher than our ENV_RECT)
    // when entered from a Vol/Pan/... tab; clearPanel only clears text, so those pixels
    // would linger. 255 = transparent.
    graphics.plotRect(0, (Y - 1) * CELL_PH, SCRW * CELL_PW, (SCRH - Y + 1) * CELL_PH, 255)
    function repaintAll() {
        clearPanel(); clearEnvGraphics(); drawHeader(); drawList()
        if (rec && !noApi || isMeta) drawMap()
        else if (noApi) { con.move(MAP_Y, MAP_X); con.color_pair(cDim, cBack); print('(patch map unavailable on this host)') }
        drawDetail(); drawEnvGraph(); drawHint()
        liveSig = '~'
    }
    repaintAll()
    registerMouse()

    editorModalLoop((ks, finish, first, ev) => {
        // Note jamming: audition the instrument being edited with the piano keys (a..k / w..u).
        if (SLOT >= 1 && HUB.tryJamFromEvent && HUB.tryJamFromEvent(ev, SLOT)) return
        if (zones.length === 0) return
        if (ks === '<UP>')    { if (selIdx > 0) { selIdx--; redrawSel() } return }
        if (ks === '<DOWN>')  { if (selIdx < zones.length - 1) { selIdx++; redrawSel() } return }
        if (ks === '<PAGE_UP>')   { selIdx = Math.max(0, selIdx - LIST_H); redrawSel(); return }
        if (ks === '<PAGE_DOWN>') { selIdx = Math.min(zones.length - 1, selIdx + LIST_H); redrawSel(); return }
        if (ks === '<HOME>')  { selIdx = 0; redrawSel(); return }
        if (ks === '<END>')   { selIdx = zones.length - 1; redrawSel(); return }
        if (!first) return
        if (ks === '<LEFT>')  { envKind = (envKind + ENV_TABS.length - 1) % ENV_TABS.length; drawEnvGraph(); liveSig = '~'; return }
        if (ks === '<RIGHT>') { envKind = (envKind + 1) % ENV_TABS.length; drawEnvGraph(); liveSig = '~'; return }
        // ── patch editing (web 49b port; uppercase so the piano jam keeps the
        // lowercase letters): N new, C duplicate, X delete, K/J reorder,
        // E zone rect, T tuning/level, L play/loop, S bind sample, O toggles
        // the env-kind override; ',' '.' / '-' '=' / '[' ']' edit the patch's
        // OWN env nodes when the override is on. ──
        if (!isMeta && rec && !noApi) {
            if (ks === 'O') { toggleEnvOverride(); return }
            if (patchEnvEditKey(ks)) return
            if (ks === 'N') { addPatch(); return }
            if (ks === 'C') { duplicatePatch(); return }
            if (ks === 'X') { deletePatch(); return }
            if (ks === 'K') { movePatch(-1); return }
            if (ks === 'J') { movePatch(1); return }
            if (ks === 'E') { editZoneRect(); return }
            if (ks === 'T') { editTuning(); return }
            if (ks === 'L') { editLoop(); return }
            if (ks === 'S') { bindSample(); return }
        }
        // ── meta LAYER editing: N new, C duplicate, X delete, K/J reorder
        // (layer 0 = the foreground layer), E rect, T mix/detune, S bind the
        // child instrument, G toggles strict gating. ──
        if (isMeta && rec) {
            if (ks === 'N') { addLayer(); return }
            if (ks === 'C') { duplicateLayer(); return }
            if (ks === 'X') { deleteLayer(); return }
            if (ks === 'K') { moveLayer(-1); return }
            if (ks === 'J') { moveLayer(1); return }
            if (ks === 'E') { editLayerRect(); return }
            if (ks === 'T') { editLayerMix(); return }
            if (ks === 'S') { bindLayerInst(); return }
            if (ks === 'G') { toggleStrict(); return }
        }
    }, refreshLiveVoices)

    // Silence any lingering jam audition only when stopped; during playback there is none and
    // jamStop would cut the live song on the way back out of Advanced Edit.
    if (HUB.getPlaybackMode() === PLAYMODE_NONE && typeof audio.jamStop === 'function') audio.jamStop(PLAYHEAD)
    clearEnvGraphics()                               // don't leave the graph over the restored viewer
    refreshInstrumentsCache()
    clampInstrumentsCursor()
    HUB.drawAll()
    HUB.rebuildPanelMouseRegions()
}

    return {
        drawSamplesContents, samplesInput, drawInstrumentsContents, instrumentsInput,
        refreshSamplesCache, refreshInstrumentsCache,
        drawSamplesPlayBlobs, drawInstrumentsPlayBlobs, drawSampleCursor, drawEnvelopeCursor, tickFunkWaveform,
        clearSampleWaveformArea, clearInstrumentsEnvelopeArea, clampSamplesCursor,
        drawSamplesUsedBy, computeSampleRAMBytes, formatSampleRamK, launchInstrumentViewerFor,
        registerInstrumentsMouse, registerSamplesMouse, sampleRamSummary,
        drawSlider, drawNumCapsule, runSliderDrag,
        getSelectedInstrumentSlot, buildMetaLayerChildSlots, buildPercussionSlots,
        selectableInstrumentSlots, auditionNoteFor, housekeepBank, housekeepIxmp,
    }
}

exports = { init }
