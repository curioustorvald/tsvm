#!/usr/bin/env python3
"""midi2taud.py — Convert Standard MIDI (.mid) + SoundFont 2 (.sf2) to TSVM Taud (.taud)

Usage:
    python3 midi2taud.py song.mid soundfont.sf2 [output.taud]
                         [--perc-force-mapping BANK INST]
                         [--rpb N] [--speed N] [--fadeout N]
                         [--bend-epsilon CENTS] [--drum-keyoff]
                         [-v] [--no-project-data]

Behaviour (per midi2taud.md):
  * Pitch bends are preserved as much as possible. A note starting under a
    non-zero bend triggers directly at the bent 4096-TET pitch (Taud notes
    are 4096-TET, so the trigger encodes the exact shifted pitch). Bend
    movement during a note is approximated as linear segments: each segment
    is one row carrying the exact 4096-TET target note plus tone portamento
    (G $xxxx, units/tick) sized to land on the target by row end. Jittery
    curves are simplified via --bend-epsilon (cents). RPN 0,0 pitch-bend
    range messages are honoured; bend values are computed as floats from
    the full 14-bit word (MIDIs that only drive the MSB work transparently).
  * Both MIDI key-off idioms — real note-off messages and note-on with
    velocity 0 — are translated into Taud KEY_OFF. Percussion-channel
    key-offs are dropped by default (GM percussion ignores note-off, and
    emitting them would chop one-shot drum tails); --drum-keyoff re-enables.
  * The SF2 key/velocity sample-layering model is recreated faithfully. Each
    preset's zones are partitioned into the fewest mutually-DISJOINT layers
    (--max-layers cap, default 4); each layer becomes one normal Taud instrument
    with its zones as Ixmp patches (velocity axis round(vel × 63/127)). A preset
    needing >1 layer is emitted as a Metainstrument (terranmon.txt "Metainstrument
    definition"): the note references the meta slot and the engine fans out one
    voice per matching layer, so SF2's simultaneous layering (and detune-stacks)
    now sound — overlapping zones are no longer dropped. Single-layer presets stay
    plain instruments. Stereo SF2 samples are mixed to mono. Unused instruments,
    patches, and samples are trimmed.
  * The SF2 volume-envelope ADSR is preserved on the (instrument-scope) Taud
    volume envelope: delay/attack/hold/decay nodes and a sustain region held
    while the key is on. There is NO release leg — the SF2 *release segment*
    is the Volume Fadeout (with NNA Note Fade): on key-off the voice holds at
    the sustain node and fades to silence over the SF2 releaseVolEnv time
    (the full release, scaled to FluidSynth's PERCEIVED release length because
    the engine's fadeout is linear in amplitude, not dB — see _zone_fadeout).
    Per-layer Ixmp patches carry their own fadeout when their release differs.
    The canonical zone's ADSR represents the instrument.
  * Polyphony rides the engine's New Note Action (matching MIDI semantics):
    every instrument (drum kits included) gets NNA = Note Fade, so a voice
    column is reusable the moment its note releases — the release/fade tail
    moves to a background ghost on the next trigger and dies over its own
    release time. Voice budget defaults to 16 columns (--max-voices); overflow
    releases the oldest pedal-held or soonest-ending note early, not cut.
  * SF2 exclusiveClass (gen 57) is honoured on the percussion channel: a new note
    in a class chokes any ringing note of the same class (e.g. a closed hi-hat
    silences a ringing open hi-hat), matching FluidSynth's kill-by-exclusive-class.
    The choke is the new fast note-fade (note 0x0004, ~0.3 s) emitted at the next
    same-class onset; without it long percussion tails wash over the whole beat.
  * Sub-row timing is carried by S $Dx note delays (one row = `--speed`
    ticks; one beat = `--rpb` rows). The grid (Tickspeed + RPB) is auto-set by
    default from the tempo map, the MIDI time signatures and onset-subdivision
    analysis: rpb·speed fine-ticks per beat is chosen to represent the finest
    subdivision actually used, keep every tempo inside the Taud BPM register
    (25..280), and stay near the proven 24-fts/beat grid — so plain 4/4 @ 120
    BPM still reproduces the old speed 6 / rpb 4. Passing --rpb or --speed pins
    that axis and auto-fits the other; pass both to fully override. As a final
    step, a bend- or polyphony-heavy song with rpb < 8 has its rpb doubled (and
    speed halved, so F and the tempo are unchanged) up to 8: the extra rows give
    key-offs, exclusiveClass chokes, bend portamento (G) and channel-volume (M)
    effects more distinct rows to land on, so fewer are eaten by same-row / per-
    cell-slot collisions. Disabled by pinning --rpb or --speed.
    MIDI tempo changes map to T $xx00 set-tempo effects; channel volume /
    expression (CC7 × CC11) map to M $xx00 channel-volume effects so they
    never disturb the velocity-driven patch selection axis.
  * Cues are broken at every time-signature change, and each section is packed
    into whole-bar cues (the largest multiple of its bar length that fits in 64
    rows) so the tracker's bar/beat highlighting (sMet beat divisions) lines up
    with the music.
"""

import argparse
import array
import bisect
import math
import os
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
    SAMPLEBIN_SIZE, INSTBIN_SIZE, SAMPLEINST_SIZE, SAMPLE_LEN_LIMIT,
    PATTERN_ROWS, PATTERN_BYTES, NUM_PATTERNS_MAX, NUM_CUES, CUE_SIZE, NUM_VOICES,
    NOTE_NOP, NOTE_KEYOFF, NOTE_FASTFADE, TAUD_C4,
    TOP_G, TOP_M, TOP_S, TOP_T,
    SEL_SET, SEL_FINE,
    CUE_INST_NOP, CUE_INST_HALT,
    resample_linear, encode_cue, deduplicate_patterns, encode_song_entry,
    compress_blob, build_project_data, cue_instruction_len,
    cue_instruction_halt_at, last_note_cue_index, nearest_minifloat,
    IXMP_PAN_NO_OVERRIDE, atten_cb_to_octet,
)

SIGNATURE = b'midi2taud/TSVM'   # 14 bytes
UNITS_PER_SEMI = 4096.0 / 12.0  # 4096-TET units per 12-TET semitone

# Effect priorities for the shared per-cell effect slot. Higher wins when a
# later pass needs the slot: SD note delays carry trigger timing and are
# never overwritten; T tempo is global and may evict G/M; M only takes free
# slots.
PRIO_FREE  = 0
PRIO_M     = 1
PRIO_PORTA = 2
PRIO_DELAY = 3
PRIO_TEMPO = 4


def key_to_noteval(key: float) -> int:
    """MIDI key (float, 60 = middle C) → Taud 4096-TET noteVal (C4 = 0x5000)."""
    return max(0x20, min(0xFFFF, round(TAUD_C4 + (key - 60.0) * UNITS_PER_SEMI)))


# ── MIDI parser ───────────────────────────────────────────────────────────────

def _read_varlen(data: bytes, pos: int):
    val = 0
    while True:
        b = data[pos]; pos += 1
        val = (val << 7) | (b & 0x7F)
        if not (b & 0x80):
            return val, pos


def _parse_track(data: bytes, pos: int, end: int) -> list:
    """Parse one MTrk body → list of (abs_tick, event_tuple)."""
    evs = []
    tick = 0
    status = 0
    while pos < end:
        delta, pos = _read_varlen(data, pos)
        tick += delta
        if pos >= end:
            break
        b = data[pos]
        if b & 0x80:
            status = b
            pos += 1
        elif status < 0x80:
            vprint(f"  warning: corrupt track data at {pos:#x}, truncating track")
            break

        if status == 0xFF:                       # meta
            mtype = data[pos]; pos += 1
            ln, pos = _read_varlen(data, pos)
            payload = data[pos:pos+ln]; pos += ln
            if mtype == 0x51 and ln >= 3:
                uspq = int.from_bytes(payload[:3], 'big')
                if uspq > 0:
                    evs.append((tick, ('tempo', 60000000.0 / uspq)))
            elif mtype == 0x03:
                txt = payload.decode('latin-1', errors='replace').strip()
                if txt:
                    evs.append((tick, ('title', txt)))
            elif mtype == 0x58 and ln >= 2:        # time signature (FF 58 04 nn dd cc bb)
                # nn = numerator, dd = denominator as a negative power of 2
                # (2 = quarter, 3 = eighth). cc/bb (clocks-per-click, 32nds-per-
                # quarter) carry no information the Taud grid needs.
                evs.append((tick, ('timesig', payload[0], payload[1])))
            elif mtype == 0x2F:
                evs.append((tick, ('eot',)))
                break
            status = 0                           # meta cancels running status
        elif status in (0xF0, 0xF7):             # sysex
            ln, pos = _read_varlen(data, pos)
            pos += ln
            status = 0
        else:
            hi = status & 0xF0
            ch = status & 0x0F
            if hi in (0xC0, 0xD0):
                d1 = data[pos]; pos += 1
                if hi == 0xC0:
                    evs.append((tick, ('prog', ch, d1)))
            else:
                d1 = data[pos]; d2 = data[pos+1]; pos += 2
                if hi == 0x90:
                    if d2 > 0:
                        evs.append((tick, ('on', ch, d1, d2)))
                    else:
                        evs.append((tick, ('off', ch, d1)))   # vel-0 idiom
                elif hi == 0x80:
                    evs.append((tick, ('off', ch, d1)))
                elif hi == 0xB0:
                    evs.append((tick, ('cc', ch, d1, d2)))
                elif hi == 0xE0:
                    evs.append((tick, ('bend', ch, (d2 << 7) | d1)))
                # 0xA0 polyphonic aftertouch: ignored
    return evs


def parse_midi(path: str):
    """Returns (division, merged_events). division: ('ppq', tpq) or
    ('smpte', fps, tpf). merged_events: [(tick, seq, event_tuple)] sorted."""
    with open(path, 'rb') as f:
        data = f.read()

    if data[:4] == b'RIFF':                      # RMID wrapper
        pos = 12
        while pos + 8 <= len(data):
            cid = data[pos:pos+4]
            sz  = struct.unpack_from('<I', data, pos+4)[0]
            if cid == b'data':
                data = data[pos+8 : pos+8+sz]
                break
            pos += 8 + sz + (sz & 1)

    if data[:4] != b'MThd':
        sys.exit("error: not a MIDI file (bad MThd magic)")
    hlen = struct.unpack_from('>I', data, 4)[0]
    fmt, ntrk, div = struct.unpack_from('>HHH', data, 8)
    if fmt == 2:
        vprint("  warning: SMF format 2 — tracks merged on a shared timeline")

    if div & 0x8000:
        fps = -struct.unpack_from('b', data, 12)[0]
        tpf = div & 0xFF
        division = ('smpte', fps, tpf)
    else:
        division = ('ppq', max(1, div))

    pos = 8 + hlen
    merged = []
    seq = 0
    tracks_found = 0
    while pos + 8 <= len(data) and tracks_found < ntrk:
        cid = data[pos:pos+4]
        sz  = struct.unpack_from('>I', data, pos+4)[0]
        body_start = pos + 8
        pos = body_start + sz
        if cid != b'MTrk':
            continue
        tracks_found += 1
        for tick, ev in _parse_track(data, body_start, min(pos, len(data))):
            merged.append((tick, seq, ev))
            seq += 1
    merged.sort(key=lambda e: (e[0], e[1]))
    return division, merged


# ── Note / controller extraction ──────────────────────────────────────────────

class Note:
    __slots__ = ('ch', 'key', 'vel', 'start_ft', 'end_ft', 'inst_key',
                 'bend0', 'slot', 'voice', 'drum', 'pedal_ft', 'excl_cut_ft')
    def __init__(self, ch, key, vel, start_ft, inst_key, bend0):
        self.ch       = ch
        self.key      = key
        self.vel      = vel
        self.start_ft = start_ft
        self.end_ft   = None
        self.inst_key = inst_key
        self.bend0    = bend0
        self.slot     = 0
        self.voice    = -1
        self.drum     = (inst_key[0] == 'd')
        self.pedal_ft = None     # physical key-up time when only the pedal holds it
        self.excl_cut_ft = None  # ft at which a same-exclusiveClass note chokes this one


class _ChState:
    __slots__ = ('bank', 'prog', 'rpn_msb', 'rpn_lsb', 'range_semi',
                 'range_cents', 'cur_bend', 'bend_ft', 'bend_val',
                 'cc7_ft', 'cc7_val', 'cc11_ft', 'cc11_val',
                 'cc10_ft', 'cc10_val', 'sus', 'pending', 'active')
    def __init__(self):
        self.bank = 0
        self.prog = 0
        self.rpn_msb = 0x7F
        self.rpn_lsb = 0x7F
        self.range_semi  = 2
        self.range_cents = 0
        self.cur_bend = 0.0
        self.bend_ft  = [0];   self.bend_val = [0.0]
        self.cc7_ft   = [0];   self.cc7_val  = [100]    # GM default
        self.cc11_ft  = [0];   self.cc11_val = [127]
        self.cc10_ft  = [];    self.cc10_val = []       # empty = never set
        self.sus = False
        self.pending = []        # notes held by the sustain pedal
        self.active  = {}        # key → Note


def _curve_at(fts: list, vals: list, ft: int, default):
    i = bisect.bisect_right(fts, ft) - 1
    return vals[i] if i >= 0 else default


def _curve_push(fts: list, vals: list, ft: int, val):
    if fts and fts[-1] == ft:
        vals[-1] = val
    else:
        fts.append(ft); vals.append(val)


class Song:
    __slots__ = ('notes', 'channels', 'tempo_ft', 'tempo_bpm', 'title', 'end_ft',
                 'timesig_ft', 'timesig')


def extract_song(division, merged, rpb: int, speed: int) -> Song:
    """Walk merged MIDI events, producing note instances (with both key-off
    idioms resolved to a definite end time), per-channel bend/CC curves, and
    the tempo map — all on the Taud fine-tick (ft) grid where one row =
    `speed` fts and one beat = `rpb` rows."""
    if division[0] == 'ppq':
        tpq = division[1]
        def to_ft(tick):
            return round(tick * rpb * speed / tpq)
    else:
        _, fps, tpf = division
        tps = max(1.0, float(fps * tpf))         # ticks per second
        # SMPTE timing has no musical beats: pin a 120 BPM equivalent grid.
        def to_ft(tick):
            return round((tick / tps) * 2.0 * rpb * speed)
        vprint("  info: SMPTE division — pinned to a 120 BPM-equivalent grid")

    chs = [_ChState() for _ in range(16)]
    notes = []
    tempo_ft, tempo_bpm = [], []
    timesig_ft, timesig = [], []          # ft → (numerator, denom_power)
    title = None
    max_ft = 0

    def end_note(n: Note, ft: int):
        if n.end_ft is None:
            n.end_ft = max(ft, n.start_ft)

    for tick, _seq, ev in merged:
        ft = to_ft(tick)
        if ft > max_ft:
            max_ft = ft
        kind = ev[0]

        if kind == 'on':
            _, ch, key, vel = ev
            st = chs[ch]
            prev = st.active.pop(key, None)
            if prev is not None:                 # re-strike: close the old one
                end_note(prev, ft)
            ik = ('d', st.prog) if ch == 9 else ('m', st.bank, st.prog)
            n = Note(ch, key, vel, ft, ik, st.cur_bend)
            st.active[key] = n
            notes.append(n)

        elif kind == 'off':
            _, ch, key = ev
            st = chs[ch]
            n = st.active.pop(key, None)
            if n is not None:
                if st.sus:
                    n.pedal_ft = ft
                    st.pending.append(n)
                else:
                    end_note(n, ft)

        elif kind == 'bend':
            _, ch, val14 = ev
            st = chs[ch]
            # MUST be float maths: 14-bit word (or MSB-only 7-bit source,
            # which simply leaves the low 7 bits zero) → ±range semitones.
            norm  = (float(val14) - 8192.0) / 8192.0
            semis = norm * (st.range_semi + st.range_cents / 100.0)
            st.cur_bend = semis
            _curve_push(st.bend_ft, st.bend_val, ft, semis)

        elif kind == 'cc':
            _, ch, num, val = ev
            st = chs[ch]
            if num == 0:
                st.bank = val
            elif num == 7:
                _curve_push(st.cc7_ft, st.cc7_val, ft, val)
            elif num == 10:
                _curve_push(st.cc10_ft, st.cc10_val, ft, val)
            elif num == 11:
                _curve_push(st.cc11_ft, st.cc11_val, ft, val)
            elif num == 64:
                if val >= 64:
                    st.sus = True
                else:
                    st.sus = False
                    for n in st.pending:
                        end_note(n, ft)
                    st.pending.clear()
            elif num == 100:
                st.rpn_lsb = val
            elif num == 101:
                st.rpn_msb = val
            elif num in (98, 99):                # NRPN deselects RPN
                st.rpn_msb = st.rpn_lsb = 0x7F
            elif num == 6:
                if st.rpn_msb == 0 and st.rpn_lsb == 0:
                    st.range_semi = val
            elif num == 38:
                if st.rpn_msb == 0 and st.rpn_lsb == 0:
                    st.range_cents = val
            elif num in (120, 123):              # all sound / notes off
                for n in list(st.active.values()):
                    end_note(n, ft)
                st.active.clear()
                for n in st.pending:
                    end_note(n, ft)
                st.pending.clear()
            elif num == 121:                     # reset all controllers
                st.cur_bend = 0.0
                _curve_push(st.bend_ft, st.bend_val, ft, 0.0)
                _curve_push(st.cc11_ft, st.cc11_val, ft, 127)
                st.sus = False
                for n in st.pending:
                    end_note(n, ft)
                st.pending.clear()
                st.rpn_msb = st.rpn_lsb = 0x7F

        elif kind == 'prog':
            _, ch, val = ev
            chs[ch].prog = val

        elif kind == 'tempo':
            tempo_ft.append(ft); tempo_bpm.append(ev[1])

        elif kind == 'timesig':
            sig = (ev[1], ev[2])
            if timesig_ft and timesig_ft[-1] == ft:
                timesig[-1] = sig             # last event at this ft wins
            elif not timesig or timesig[-1] != sig:
                timesig_ft.append(ft); timesig.append(sig)

        elif kind == 'title':
            if title is None:
                title = ev[1]

    # Close anything still ringing at end-of-file.
    for st in chs:
        for n in list(st.active.values()):
            end_note(n, max_ft)
        st.active.clear()
        for n in st.pending:
            end_note(n, max_ft)
        st.pending.clear()

    dropped = [n for n in notes if n.end_ft <= n.start_ft]
    if dropped:
        vprint(f"  info: dropped {len(dropped)} zero-length note(s)")
    notes = [n for n in notes if n.end_ft > n.start_ft]
    notes.sort(key=lambda n: (n.start_ft, n.ch, n.key))

    song = Song()
    song.notes     = notes
    song.channels  = chs
    song.tempo_ft  = tempo_ft
    song.tempo_bpm = tempo_bpm
    song.timesig_ft = timesig_ft
    song.timesig    = timesig
    song.title     = title
    song.end_ft    = max_ft
    return song


# ── Auto timing (Tickspeed + RPB) ──────────────────────────────────────────────

# Candidate beat subdivisions tested by the onset analyser (per quarter note).
_SUBDIV_CANDIDATES = (1, 2, 3, 4, 6, 8, 12, 16)
# Fraction-of-a-quarter tolerance for an onset to count as "on" a 1/D grid.
_SUBDIV_TOL = 0.04
# Coverage at which a subdivision is accepted as the finest one in use. 0.95
# keeps the picker from chasing the last few percent of ornament/swing onsets
# into a needlessly fine grid (those land on the sub-row S$Dx grid anyway).
_SUBDIV_THRESHOLD = 0.95
# The proven default resolution (rpb 4 × speed 6). The picker anchors F=rpb·speed
# at the smallest multiple of the detected subdivision that is >= this, so any
# subdivision dividing 24 (1/2..1/12 and triplets) reproduces the old 6/4 grid.
# NOTE: row/pattern count depends only on rpb (rows = beats×rpb); speed is "free"
# sub-row + tempo precision, so the picker spends it rather than minimising F.
_F_TARGET = 24
# Taud BPM register is bias-25 in [25, 280]; tick rate Hz = bpm·2/5.
_TAUD_BPM_LO, _TAUD_BPM_HI = 25, 280

# RPB bump: bend- or polyphony-heavy songs cram more triggers / key-offs / chokes
# / bend-G / channel-M into each beat than emit_cells can place on distinct rows,
# so events get eaten by same-row & per-cell-slot collisions. Raising rows-per-beat
# (doubling rpb, halving tickspeed so F=rpb·speed — hence the tempo — is unchanged)
# spreads them out. Applied only when both axes are auto and rpb < 8.
_BUMP_TARGET_RPB       = 8     # raise rpb up to (at least) this
_BUMP_BEND_MIN_EVENTS  = 24    # "significant pitch-bend": at least this many...
_BUMP_BEND_MIN_DENSITY = 0.25  # ... non-centre bend events, and >= this per note
_BUMP_POLY_PEAK        = 10    # "many polyphony": peak simultaneous notes >= this


def _peak_polyphony(merged) -> int:
    """Peak count of simultaneously-sounding (channel, key) notes across the song.
    Sustain pedal is ignored — this is a polyphony proxy, not exact voicing."""
    active = set()
    cur = peak = 0
    for _tick, _seq, ev in merged:
        if ev[0] == 'on':
            k = (ev[1], ev[2])
            if k not in active:
                active.add(k); cur += 1
                if cur > peak:
                    peak = cur
        elif ev[0] == 'off':
            k = (ev[1], ev[2])
            if k in active:
                active.discard(k); cur -= 1
    return peak


def _detect_subdivision(onsets, tpq: int) -> int:
    """Finest beat subdivision (per quarter) the onsets actually use.

    Returns the smallest D from _SUBDIV_CANDIDATES whose 1/D grid covers
    >= _SUBDIV_THRESHOLD of onsets within _SUBDIV_TOL; else the best-covering
    candidate (so heavily syncopated/swing material lands on a usable grid
    rather than forcing the maximum)."""
    if not onsets:
        return 1
    best_d, best_cov = 1, -1.0
    for d in _SUBDIV_CANDIDATES:
        hits = 0
        for t in onsets:
            frac = (t % tpq) / tpq
            if abs(frac - round(frac * d) / d) <= _SUBDIV_TOL:
                hits += 1
        cov = hits / len(onsets)
        if cov >= _SUBDIV_THRESHOLD:
            return d
        if cov > best_cov:
            best_d, best_cov = d, cov
    return best_d


def auto_timing(division, merged, rpb_fixed, speed_fixed, max_voices) -> tuple:
    """Choose (rpb, speed, info) for the Taud grid from the tempo map, the MIDI
    time signatures and onset-subdivision analysis. A non-None rpb_fixed /
    speed_fixed pins that axis (the user passed it); the other is auto-fit. Both
    pinned → returned verbatim. When both are auto, a final RPB bump raises
    rows-per-beat for bend/polyphony-heavy songs (see the _BUMP_* constants)."""
    # SMPTE has no musical beat grid; the ft mapping pins a 120 BPM equivalent,
    # so there is nothing to optimise — keep the proven default / pinned values.
    if division[0] != 'ppq':
        return (rpb_fixed or 4, speed_fixed or 6,
                "SMPTE division — auto timing skipped")
    tpq = division[1]

    onsets = [tick for (tick, _seq, ev) in merged if ev[0] == 'on']
    tempos = sorted((tick, ev[1]) for (tick, _seq, ev) in merged if ev[0] == 'tempo')
    first_onset = onsets[0] if onsets else 0
    last_tick = max((tick for tick, _s, _e in merged), default=0)

    def bpm_at(tick):
        i = bisect.bisect_right([t for t, _ in tempos], tick) - 1
        return tempos[i][1] if i >= 0 else 120.0

    bpm0 = bpm_at(first_onset)
    all_bpms = {b for _t, b in tempos} or {120.0}
    bend_events = sum(1 for (_t, _s, ev) in merged if ev[0] == 'bend' and ev[2] != 8192)
    bends_present = bend_events > 0
    peak_poly = _peak_polyphony(merged)

    subdiv = _detect_subdivision(onsets, tpq)
    # Anchor: smallest multiple of the subdivision that is >= the proven grid, so
    # it represents the rhythm exactly (F % subdiv == 0) without going below 24.
    f_want = -(-_F_TARGET // subdiv) * subdiv

    rpb_opts   = [rpb_fixed] if rpb_fixed else [4, 8, 2, 16]
    speed_lo   = 2 if bends_present else 1
    speed_opts = [speed_fixed] if speed_fixed else list(range(1, 16))

    def taud_bpm(bpm, F):
        return round(bpm * F / 24.0)

    best = None       # (sort_key, rpb, speed)
    for rpb in rpb_opts:
        for speed in speed_opts:
            if speed < speed_lo:
                continue
            F = rpb * speed
            init_ok   = _TAUD_BPM_LO <= taud_bpm(bpm0, F) <= _TAUD_BPM_HI
            rhythm_ok = (F % subdiv == 0)
            clamped   = sum(1 for b in all_bpms
                            if not _TAUD_BPM_LO <= taud_bpm(b, F) <= _TAUD_BPM_HI)
            key = (0 if init_ok else 1,        # initial tempo must fit the register
                   clamped,                    # fewest tempo changes forced to clamp
                   [4, 8, 2, 16].index(rpb),   # prefer the conventional rpb=4 (rows
                                               #   = beats×rpb, so this caps pattern
                                               #   count and keeps the highlight grid)
                   abs(F - f_want),            # spend speed to reach the subdiv grid
                   0 if rhythm_ok else 1,      # ... exactly, if a tie remains
                   abs(speed - 6))              # tie-break: near the proven speed 6
            if best is None or key < best[0]:
                best = (key, rpb, speed)

    _, rpb, speed = best

    # ── RPB bump for bend/polyphony-heavy songs (both axes auto only) ──
    # Double rpb / halve speed (F, hence tempo, unchanged) until rpb reaches the
    # target, while speed stays an integer >= the portamento floor and the bumped
    # grid is estimated to fit the cue / pattern budget (so a long dense song does
    # not flip a working conversion into a hard error — pin --rpb 4 to opt out).
    bend_heavy = (bend_events >= _BUMP_BEND_MIN_EVENTS and
                  bend_events >= _BUMP_BEND_MIN_DENSITY * max(1, len(onsets)))
    many_poly  = peak_poly >= _BUMP_POLY_PEAK
    bumped = False
    if rpb_fixed is None and speed_fixed is None and rpb < _BUMP_TARGET_RPB \
            and (bend_heavy or many_poly):
        total_quarters = max(0, last_tick - first_onset) / tpq
        nvoices_est = min(max_voices, peak_poly + 1)

        def fits(rpb_try):
            est_rows = math.ceil(total_quarters * rpb_try) + rpb_try
            est_cues = math.ceil(est_rows / 56) + 4   # /56 (not 64) + margin: odd meters
            return est_cues <= NUM_CUES and est_cues * nvoices_est <= NUM_PATTERNS_MAX

        while (rpb < _BUMP_TARGET_RPB and speed % 2 == 0
               and speed // 2 >= speed_lo and rpb * 2 <= 16 and fits(rpb * 2)):
            rpb *= 2; speed //= 2; bumped = True

    info = (f"bpm0 {bpm0:.1f}, finest 1/{subdiv}-quarter subdivision, "
            f"{'bends present, ' if bends_present else ''}"
            f"F={rpb * speed} fts/beat (want {f_want}) → Taud BPM "
            f"{taud_bpm(bpm0, rpb * speed)}")
    if bumped:
        why = " + ".join(w for w, on in
                         (("dense bends", bend_heavy), ("high polyphony", many_poly)) if on)
        info += (f"; RPB bumped to {rpb} / speed {speed} to spread events "
                 f"({why}; peak poly {peak_poly})")
    return rpb, speed, info


# ── SF2 parser ────────────────────────────────────────────────────────────────

GEN_START_OFF        = 0
GEN_END_OFF          = 1
GEN_STARTLOOP_OFF    = 2
GEN_ENDLOOP_OFF      = 3
GEN_START_COARSE     = 4
GEN_MODENV2PITCH     = 7      # modEnvToPitch (signed cents at full mod-env)
GEN_FILTERFC         = 8      # initialFilterFc (absolute cents; default 13500 = open)
GEN_FILTERQ          = 9      # initialFilterQ (cB of resonance; default 0)
GEN_MODENV2FILT      = 11     # modEnvToFilterFc (signed cents at full mod-env)
GEN_END_COARSE       = 12
GEN_EXCLUSIVECLASS   = 57     # drum mutual-exclusion group (instrument-level; 0 = none)
GEN_PAN              = 17
GEN_DELAY_MODENV     = 25
GEN_ATTACK_MODENV    = 26
GEN_HOLD_MODENV      = 27
GEN_DECAY_MODENV     = 28
GEN_SUSTAIN_MODENV   = 29     # 0.1% units of full-scale DECREASE (0..1000)
GEN_RELEASE_MODENV   = 30
GEN_DELAY_VOLENV     = 33
GEN_ATTACK_VOLENV    = 34
GEN_HOLD_VOLENV      = 35
GEN_DECAY_VOLENV     = 36
GEN_SUSTAIN_VOLENV   = 37     # centibels of attenuation, 0..1440
GEN_RELEASE_VOLENV   = 38
GEN_INSTRUMENT       = 41
GEN_KEYRANGE         = 43
GEN_VELRANGE         = 44
GEN_STARTLOOP_COARSE = 45
GEN_INITATTEN        = 48     # initialAttenuation (cB; per-zone static gain)
GEN_ENDLOOP_COARSE   = 50
GEN_COARSETUNE       = 51
GEN_FINETUNE         = 52
GEN_SAMPLEID         = 53
GEN_SAMPLEMODES      = 54
GEN_SCALETUNING      = 56
GEN_ROOTKEY          = 58

_SIGNED_GENS = frozenset({GEN_START_OFF, GEN_END_OFF, GEN_STARTLOOP_OFF,
                          GEN_ENDLOOP_OFF, GEN_START_COARSE, GEN_END_COARSE,
                          GEN_STARTLOOP_COARSE, GEN_ENDLOOP_COARSE,
                          GEN_PAN, GEN_COARSETUNE, GEN_FINETUNE,
                          GEN_DELAY_VOLENV, GEN_ATTACK_VOLENV, GEN_HOLD_VOLENV,
                          GEN_DECAY_VOLENV, GEN_RELEASE_VOLENV,
                          GEN_MODENV2PITCH, GEN_MODENV2FILT,
                          GEN_DELAY_MODENV, GEN_ATTACK_MODENV, GEN_HOLD_MODENV,
                          GEN_DECAY_MODENV, GEN_RELEASE_MODENV,
                          # cB/cents value-generators that are ADDITIVE (and so may be
                          # NEGATIVE) at the preset level. Their instrument-level absolutes
                          # all sit well under 0x8000 (atten≤1440, filterFc≤13500, Q≤960,
                          # sustain≤1440/1000), so reading them signed is lossless there and
                          # correct for relative preset deltas. Without this a preset zone
                          # carrying e.g. initialAttenuation 0xFFFE (a −2 cB boost) was read
                          # as 65534 cB → ~−6575 dB → the whole instrument went silent
                          # (SGM 'Synth Strings 1' vol-env nodes stuck at 0).
                          GEN_INITATTEN, GEN_FILTERFC, GEN_FILTERQ,
                          GEN_SUSTAIN_VOLENV, GEN_SUSTAIN_MODENV})


def _timecents_to_sec(tc: int) -> float:
    """SF2 timecents → seconds (2^(tc/1200)); default -12000 ≈ 1 ms."""
    return 2.0 ** (max(-12000, min(8000, tc)) / 1200.0)


class SFSampleHdr:
    __slots__ = ('name', 'start', 'end', 'loopstart', 'loopend', 'rate',
                 'origkey', 'correction', 'link', 'stype')


class SFZone:
    """One effective preset×instrument zone (post combination)."""
    __slots__ = ('keylo', 'keyhi', 'vello', 'velhi', 'sample', 'rootkey',
                 'tune_cents', 'modes', 'pan', 'scale', 'a_start', 'a_end',
                 'loop_abs_start', 'loop_abs_end', 'pair', 'rate', 'name',
                 'env_delay', 'env_attack', 'env_hold', 'env_decay',
                 'env_sustain_cb', 'env_release',
                 # initialAttenuation (cB static per-zone gain) + static filter.
                 'atten_cb', 'filter_fc', 'filter_q',
                 # modulation envelope (drives pitch and/or filter) + its targets.
                 'm_delay', 'm_attack', 'm_hold', 'm_decay', 'm_sustain_pc',
                 'm_release', 'me2pitch', 'me2filt',
                 # exclusiveClass (gen 57): drum mutual-exclusion group (0 = none).
                 'excl_class')


class SF2:
    __slots__ = ('presets', 'shdrs', 'file', 'smpl_off', 'smpl_size')

    def read_frames(self, start_frame: int, n_frames: int) -> array.array:
        """Read n_frames of 16-bit PCM starting at absolute frame index."""
        n_avail = max(0, min(n_frames, self.smpl_size // 2 - start_frame))
        a = array.array('h')
        if n_avail <= 0:
            return a
        self.file.seek(self.smpl_off + start_frame * 2)
        a.frombytes(self.file.read(n_avail * 2))
        if sys.byteorder == 'big':
            a.byteswap()
        return a


def _gen_amount(oper: int, raw: int) -> int:
    if oper in _SIGNED_GENS:
        return raw - 0x10000 if raw >= 0x8000 else raw
    return raw


def _parse_bags(bag_data, gen_data, start_bag, end_bag, terminal_gen):
    """Resolve bags [start_bag, end_bag) into (global_gens, [zone_gens...]).
    Each zone_gens is {oper: amount}; zones lacking the terminal generator
    other than a leading global zone are discarded per the SF2 spec."""
    glob = {}
    zones = []
    n_bags = len(bag_data) // 4
    for bi in range(start_bag, end_bag):
        g0 = struct.unpack_from('<H', bag_data, bi*4)[0]
        g1 = (struct.unpack_from('<H', bag_data, (bi+1)*4)[0]
              if bi + 1 < n_bags else len(gen_data) // 4)
        gens = {}
        for gi in range(g0, min(g1, len(gen_data) // 4)):
            oper, raw = struct.unpack_from('<HH', gen_data, gi*4)
            gens[oper] = _gen_amount(oper, raw)
        if terminal_gen in gens:
            zones.append(gens)
        elif bi == start_bag and not zones:
            glob = gens
    return glob, zones


def parse_sf2(path: str) -> SF2:
    f = open(path, 'rb')
    hdr = f.read(12)
    if hdr[:4] != b'RIFF' or hdr[8:12] != b'sfbk':
        sys.exit("error: not an SF2 file (bad RIFF/sfbk magic)")
    riff_end = 8 + struct.unpack_from('<I', hdr, 4)[0]

    pdta = {}
    smpl_off = smpl_size = 0
    pos = 12
    while pos + 8 <= riff_end:
        f.seek(pos)
        chdr = f.read(8)
        if len(chdr) < 8:
            break
        cid = chdr[:4]
        sz  = struct.unpack_from('<I', chdr, 4)[0]
        if cid == b'LIST':
            ltype = f.read(4)
            inner = pos + 12
            inner_end = pos + 8 + sz
            while inner + 8 <= inner_end:
                f.seek(inner)
                shdr_ = f.read(8)
                scid = shdr_[:4]
                ssz  = struct.unpack_from('<I', shdr_, 4)[0]
                if ltype == b'pdta':
                    pdta[scid.decode('latin-1')] = f.read(ssz)
                elif ltype == b'sdta' and scid == b'smpl':
                    smpl_off, smpl_size = inner + 8, ssz
                inner += 8 + ssz + (ssz & 1)
        pos += 8 + sz + (sz & 1)

    for need in ('phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr'):
        if need not in pdta:
            sys.exit(f"error: SF2 missing required pdta sub-chunk '{need}'")
    if not smpl_size:
        sys.exit("error: SF2 has no smpl chunk (sample data)")

    sf = SF2()
    sf.file = f
    sf.smpl_off, sf.smpl_size = smpl_off, smpl_size

    shdr_data = pdta['shdr']
    sf.shdrs = []
    for i in range(len(shdr_data) // 46 - 1):    # last record is EOS sentinel
        s = SFSampleHdr()
        off = i * 46
        s.name = shdr_data[off:off+20].split(b'\x00')[0].decode('latin-1',
                                                                errors='replace')
        (s.start, s.end, s.loopstart, s.loopend, s.rate) = \
            struct.unpack_from('<IIIII', shdr_data, off+20)
        s.origkey    = shdr_data[off+40]
        s.correction = struct.unpack_from('b', shdr_data, off+41)[0]
        s.link, s.stype = struct.unpack_from('<HH', shdr_data, off+42)
        if s.rate == 0:
            s.rate = 8363
        sf.shdrs.append(s)

    # Instruments: index → (global_gens, [zone_gens])
    inst_data, ibag, igen = pdta['inst'], pdta['ibag'], pdta['igen']
    n_inst = len(inst_data) // 22 - 1
    inst_zones = []
    for i in range(n_inst):
        b0 = struct.unpack_from('<H', inst_data, i*22 + 20)[0]
        b1 = struct.unpack_from('<H', inst_data, (i+1)*22 + 20)[0]
        inst_zones.append(_parse_bags(ibag, igen, b0, b1, GEN_SAMPLEID))

    # Presets
    phdr, pbag, pgen = pdta['phdr'], pdta['pbag'], pdta['pgen']
    n_pre = len(phdr) // 38 - 1
    sf.presets = {}
    scale_warned = False
    for i in range(n_pre):
        off = i * 38
        pname = phdr[off:off+20].split(b'\x00')[0].decode('latin-1',
                                                          errors='replace')
        preset, bank, bag0 = struct.unpack_from('<HHH', phdr, off+20)
        bag1 = struct.unpack_from('<H', phdr, (i+1)*38 + 24)[0]
        pglob, pzones = _parse_bags(pbag, pgen, bag0, bag1, GEN_INSTRUMENT)

        zones = []
        for pz_raw in pzones:
            pz = dict(pglob); pz.update(pz_raw)
            ii = pz[GEN_INSTRUMENT]
            if not (0 <= ii < n_inst):
                continue
            iglob, izones = inst_zones[ii]
            pk = pz.get(GEN_KEYRANGE, 0x7F00)
            pv = pz.get(GEN_VELRANGE, 0x7F00)
            pklo, pkhi = pk & 0xFF, (pk >> 8) & 0xFF
            pvlo, pvhi = pv & 0xFF, (pv >> 8) & 0xFF
            for iz_raw in izones:
                iz = dict(iglob); iz.update(iz_raw)
                si = iz[GEN_SAMPLEID]
                if not (0 <= si < len(sf.shdrs)):
                    continue
                s = sf.shdrs[si]
                if s.stype & 0x8000:             # ROM sample
                    continue
                ik = iz.get(GEN_KEYRANGE, 0x7F00)
                iv = iz.get(GEN_VELRANGE, 0x7F00)
                klo = max(ik & 0xFF, pklo); khi = min((ik >> 8) & 0xFF, pkhi)
                vlo = max(iv & 0xFF, pvlo); vhi = min((iv >> 8) & 0xFF, pvhi)
                if klo > khi or vlo > vhi:
                    continue

                z = SFZone()
                z.keylo, z.keyhi = klo, khi
                z.vello, z.velhi = vlo, vhi
                z.sample = si
                rk = iz.get(GEN_ROOTKEY, -1)
                z.rootkey = rk if 0 <= rk <= 127 else \
                            (s.origkey if s.origkey <= 127 else 60)
                z.tune_cents = ((iz.get(GEN_COARSETUNE, 0)
                                 + pz.get(GEN_COARSETUNE, 0)) * 100
                                + iz.get(GEN_FINETUNE, 0)
                                + pz.get(GEN_FINETUNE, 0)
                                + s.correction)
                z.modes = iz.get(GEN_SAMPLEMODES, 0) & 3
                z.pan   = max(-500, min(500, iz.get(GEN_PAN, 0)
                                        + pz.get(GEN_PAN, 0)))
                z.scale = iz.get(GEN_SCALETUNING, 100)
                if z.scale != 100 and klo != khi and not scale_warned:
                    vprint("  warning: scaleTuning != 100 on a multi-key zone "
                           "— pitch is exact only at the zone's centre key")
                    scale_warned = True
                # Volume-envelope ADSR (timecents at inst level, preset adds).
                z.env_delay  = _timecents_to_sec(iz.get(GEN_DELAY_VOLENV,  -12000)
                                                 + pz.get(GEN_DELAY_VOLENV,  0))
                z.env_attack = _timecents_to_sec(iz.get(GEN_ATTACK_VOLENV, -12000)
                                                 + pz.get(GEN_ATTACK_VOLENV, 0))
                z.env_hold   = _timecents_to_sec(iz.get(GEN_HOLD_VOLENV,   -12000)
                                                 + pz.get(GEN_HOLD_VOLENV,   0))
                z.env_decay  = _timecents_to_sec(iz.get(GEN_DECAY_VOLENV,  -12000)
                                                 + pz.get(GEN_DECAY_VOLENV,  0))
                z.env_sustain_cb = max(0, min(1440, iz.get(GEN_SUSTAIN_VOLENV, 0)
                                              + pz.get(GEN_SUSTAIN_VOLENV, 0)))
                z.env_release = _timecents_to_sec(iz.get(GEN_RELEASE_VOLENV, -12000)
                                                  + pz.get(GEN_RELEASE_VOLENV, 0))
                # initialAttenuation: per-zone static gain in cB (preset adds to inst).
                # Clamped to the SF2 spec range [0, 1440] so any out-of-range value can
                # never collapse the folded vol-env to silence (see _SIGNED_GENS note).
                z.atten_cb = max(0, min(1440, iz.get(GEN_INITATTEN, 0)
                                        + pz.get(GEN_INITATTEN, 0)))
                # Static low-pass filter. initialFilterFc is absolute cents (default
                # 13500 ≈ open); initialFilterQ is cB of resonance (default 0).
                z.filter_fc = iz.get(GEN_FILTERFC, 13500) + pz.get(GEN_FILTERFC, 0)
                z.filter_q  = max(0, iz.get(GEN_FILTERQ, 0) + pz.get(GEN_FILTERQ, 0))
                # Modulation envelope (drives pitch via modEnvToPitch and/or filter via
                # modEnvToFilterFc). Times are timecents; sustain is 0.1%-of-full DECREASE.
                z.m_delay   = _timecents_to_sec(iz.get(GEN_DELAY_MODENV,  -12000)
                                                + pz.get(GEN_DELAY_MODENV,  0))
                z.m_attack  = _timecents_to_sec(iz.get(GEN_ATTACK_MODENV, -12000)
                                                + pz.get(GEN_ATTACK_MODENV, 0))
                z.m_hold    = _timecents_to_sec(iz.get(GEN_HOLD_MODENV,   -12000)
                                                + pz.get(GEN_HOLD_MODENV,   0))
                z.m_decay   = _timecents_to_sec(iz.get(GEN_DECAY_MODENV,  -12000)
                                                + pz.get(GEN_DECAY_MODENV,  0))
                z.m_sustain_pc = max(0, min(1000, iz.get(GEN_SUSTAIN_MODENV, 0)
                                            + pz.get(GEN_SUSTAIN_MODENV, 0)))
                z.m_release = _timecents_to_sec(iz.get(GEN_RELEASE_MODENV, -12000)
                                                + pz.get(GEN_RELEASE_MODENV, 0))
                z.me2pitch  = iz.get(GEN_MODENV2PITCH, 0) + pz.get(GEN_MODENV2PITCH, 0)
                z.me2filt   = iz.get(GEN_MODENV2FILT,  0) + pz.get(GEN_MODENV2FILT,  0)
                # exclusiveClass is instrument-level and NON-additive (SF2.04 §8.1.2 #57):
                # a new note in class C kills sounding notes of the same class on the same
                # channel (FluidSynth fluid_synth_kill_by_exclusive_class). Drum kits use it
                # so a closed hi-hat (42) chokes a ringing open hi-hat (46).
                z.excl_class = iz.get(GEN_EXCLUSIVECLASS, 0)
                z.a_start = (s.start + iz.get(GEN_START_OFF, 0)
                             + 32768 * iz.get(GEN_START_COARSE, 0))
                z.a_end   = (s.end + iz.get(GEN_END_OFF, 0)
                             + 32768 * iz.get(GEN_END_COARSE, 0))
                z.a_start = max(0, z.a_start)
                z.a_end   = max(z.a_start, min(z.a_end, sf.smpl_size // 2))
                z.loop_abs_start = (s.loopstart + iz.get(GEN_STARTLOOP_OFF, 0)
                                    + 32768 * iz.get(GEN_STARTLOOP_COARSE, 0))
                z.loop_abs_end   = (s.loopend + iz.get(GEN_ENDLOOP_OFF, 0)
                                    + 32768 * iz.get(GEN_ENDLOOP_COARSE, 0))
                z.pair = None
                z.rate = s.rate
                z.name = s.name
                zones.append(z)
        if zones:
            sf.presets[(bank, preset)] = (pname, zones)
    return sf


# ── Preset resolution / Taud instrument building ──────────────────────────────

def resolve_preset(sf: SF2, inst_key, perc_force):
    """inst_key: ('m', bank, prog) or ('d', prog). Returns (name, zones) or None."""
    if inst_key[0] == 'd':
        prog = inst_key[1]
        cands = []
        if perc_force is not None:
            cands.append(tuple(perc_force))
        cands += [(128, prog), (128, 0)]
    else:
        _, bank, prog = inst_key
        cands = [(bank, prog), (0, prog)]
    for c in cands:
        if c in sf.presets:
            return sf.presets[c]
    # Last resort: same program number in any bank, then nothing.
    prog = inst_key[1] if inst_key[0] == 'd' else inst_key[2]
    for (b, p) in sorted(sf.presets):
        if p == prog:
            return sf.presets[(b, p)]
    return None


def merge_stereo_zones(zones: list, shdrs: list) -> list:
    """Collapse L/R zone pairs into single mono zones. Two flavours are merged:
      (1) LINKED stereo — samples are each other's sampleLink with L/R types;
      (2) PAN stereo — two MONO-typed zones with the same key/vel rect and
          opposite hard pan (±500). SGM/Timbres store most "stereo" samples this
          way (e.g. 'VA LGFF C3-L' / '…-R'), NOT as linked L/R.
    The merged zone mixes both channels to mono and drops the pan override.
    Merging is essential: an unmerged R zone fully overlaps its L zone, so the
    disjointify spills it into a SECOND layer that then plays CENTRED alongside
    the L zone — a spurious +6 dB doubling. Lone L/R zones keep their channel."""
    out = []
    used = set()
    for i, z in enumerate(zones):
        if i in used:
            continue
        s = shdrs[z.sample]
        partner = None
        if s.stype in (2, 4) and 0 <= s.link < len(shdrs):
            for j in range(i + 1, len(zones)):
                if j in used:
                    continue
                z2 = zones[j]
                if (z2.sample == s.link
                        and (z2.keylo, z2.keyhi, z2.vello, z2.velhi)
                            == (z.keylo, z.keyhi, z.vello, z.velhi)
                        and z2.modes == z.modes
                        and z2.rootkey == z.rootkey):
                    partner = j
                    break
        if partner is None and z.pan is not None and abs(z.pan) >= 400:
            for j in range(i + 1, len(zones)):
                if j in used:
                    continue
                z2 = zones[j]
                if (z2.sample != z.sample
                        and z2.pan is not None and abs(z2.pan) >= 400
                        and (z.pan < 0) != (z2.pan < 0)        # opposite sides
                        and (z2.keylo, z2.keyhi, z2.vello, z2.velhi)
                            == (z.keylo, z.keyhi, z.vello, z.velhi)
                        and z2.modes == z.modes
                        and z2.rootkey == z.rootkey):
                    partner = j
                    break
        if partner is not None:
            used.add(partner)
            z2 = zones[partner]
            z.pair = (z.sample, z2.sample, z2.a_start)
            z.pan = None                          # mixed to mono → centred
            z.a_end = z.a_start + min(z.a_end - z.a_start,
                                      z2.a_end - z2.a_start)
        out.append(z)
    return out


def apply_exclusive_class(song, sf, perc_force):
    """SF2 exclusiveClass (gen 57): starting a note in class C kills any ringing note
    of the same class on the same channel — FluidSynth's
    fluid_synth_kill_by_exclusive_class (fluid_synth.c:5453). GM drum kits use it so a
    closed hi-hat (key 42) chokes a ringing open hi-hat (key 46); without it the open
    hi-hat's multi-second tail washes over the whole beat and buries the other hits.

    Resolve each percussion note's exclusiveClass from the SF2 zone it plays, then within
    each (channel, class) serialise the chokes: every note is cut at the next note of the
    same class that starts strictly later. `emit_cells` emits a fast note-fade
    (NOTE_FASTFADE) at that point and `allocate_voices` keeps the choked voice foreground
    until then. Drum channel only — GM melodic presets do not set gen 57, and a hard choke
    would fight the melodic key-off/release machinery."""
    zone_cache = {}
    def excl_of(n):
        if not n.drum:
            return 0
        zones = zone_cache.get(n.inst_key)
        if zones is None:
            res = resolve_preset(sf, n.inst_key, perc_force)
            zones = merge_stereo_zones(res[1], sf.shdrs) if res else []
            zone_cache[n.inst_key] = zones
        # SF2 zone selection: first zone whose key/velocity rect contains the note.
        for z in zones:
            if z.keylo <= n.key <= z.keyhi and z.vello <= n.vel <= z.velhi:
                return z.excl_class
        return 0

    groups = {}
    for n in song.notes:
        c = excl_of(n)
        if c:
            groups.setdefault((n.ch, c), []).append(n)

    n_cut = 0
    for notes in groups.values():
        notes.sort(key=lambda n: n.start_ft)
        for i, n in enumerate(notes):
            for j in range(i + 1, len(notes)):
                if notes[j].start_ft > n.start_ft:    # next strictly-later onset chokes n
                    n.excl_cut_ft = notes[j].start_ft
                    n_cut += 1
                    break
    if n_cut:
        vprint(f"  exclusiveClass: {n_cut} percussion choke(s) across "
               f"{len(groups)} group(s)")


def _rect_of_zone(z: SFZone):
    """Zone key/vel ranges → Taud (pitch_lo, pitch_hi, vol_lo, vol_hi).
    Pitch bounds sit on half-semitone boundaries so triggers carrying an
    initial pitch bend (< 50 cents) still land inside the right rectangle;
    adjacent zones stay disjoint. Velocity per Ixmp note 5: round(v·63/127)."""
    if z.keylo <= 0:
        plo = 0x0000
    else:
        plo = max(0, min(0xFFFF, round(TAUD_C4 + (z.keylo - 0.5 - 60) * UNITS_PER_SEMI)))
    if z.keyhi >= 127:
        phi = 0xFFFF
    else:
        phi = max(0, min(0xFFFF, round(TAUD_C4 + (z.keyhi + 0.5 - 60) * UNITS_PER_SEMI) - 1))
    vlo = round(z.vello * 63 / 127)
    vhi = round(z.velhi * 63 / 127)
    return (plo, phi, vlo, vhi)


def _rect_subtract(r, k):
    """Pieces of rectangle r not covered by rectangle k (≤ 4 pieces)."""
    p0, p1, v0, v1 = r
    q0, q1, w0, w1 = k
    if p1 < q0 or p0 > q1 or v1 < w0 or v0 > w1:
        return [r]
    pieces = []
    if p0 < q0: pieces.append((p0, q0 - 1, v0, v1))
    if p1 > q1: pieces.append((q1 + 1, p1, v0, v1))
    m0, m1 = max(p0, q0), min(p1, q1)
    if v0 < w0: pieces.append((m0, m1, v0, w0 - 1))
    if v1 > w1: pieces.append((m0, m1, w1 + 1, v1))
    return pieces


class MonoSample:
    """One pooled (deduplicated) mono u8 sample slice."""
    __slots__ = ('pair', 'a_start', 'frames', 'rate', 'name',
                 'data', 'ratio', 'offset', 'loop_native', 'synth_loop', 'synth_decay')
    def __init__(self, z: SFZone):
        self.pair    = z.pair                    # None or (idxL, idxR, b_start)
        self.a_start = z.a_start
        self.frames  = max(0, z.a_end - z.a_start)
        self.rate    = z.rate
        self.name    = z.name
        self.data    = None
        self.ratio   = 1.0
        self.offset  = 0
        # SF2 loop in NATIVE frames (mirrors the Patch loop test), or None when this
        # slice has no loop. Used by build_sample_inst_bin to decide how to fit an
        # over-length sample: a no-loop sample gets a synthesized loop, a looped one
        # is preserved (kept at 32 kHz when its loop fits, else fit-to-cap). Dedup
        # keeps the first zone's loop (same slice ⇒ same loop in practice).
        ls_n = max(0, min(z.loop_abs_start - z.a_start, self.frames))
        le_n = max(0, min(z.loop_abs_end   - z.a_start, self.frames))
        self.loop_native = (ls_n, le_n) if (z.modes in (1, 3) and le_n - ls_n >= 2) else None
        # Set when a too-long, originally UN-looped sample is resampled to the 32 kHz
        # floor and given a synthesized sustain loop (see _synth_sustain_loop): a
        # (loop_start, loop_end) pair in the FINAL output-frame domain (already scaled
        # by every resample) and the seconds over which a peak->0 vol-envelope fades
        # the looped note to silence (_synth_decay_vol_env). When set, the loop points
        # and vol-envelope of EVERY record/patch using this sample are overridden.
        self.synth_loop  = None
        self.synth_decay = None

    def key(self):
        return (self.pair[0], self.pair[1], self.a_start, self.frames) \
            if self.pair else (-1, -1, self.a_start, self.frames)

    def render(self, sf: SF2):
        if self.data is not None:
            return
        n = min(self.frames, 1 << 24)            # hard sanity cap (16M frames)
        if self.pair:
            la = sf.read_frames(self.a_start, n)
            ra = sf.read_frames(self.pair[2], n)
            m  = min(len(la), len(ra))
            self.data = bytes((((la[i] + ra[i]) >> 1) >> 8) + 128 & 0xFF
                              for i in range(m))
        else:
            la = sf.read_frames(self.a_start, n)
            self.data = bytes(((s >> 8) + 128) & 0xFF for s in la)
        self.frames = len(self.data)


class Patch:
    """One Ixmp-patch-to-be: a disjoint rect plus the zone's sample fields."""
    __slots__ = ('rect', 'zone', 'ms', 'loop_start', 'loop_end', 'loop_mode',
                 'detune', 'pan8', 'hits')
    def __init__(self, rect, z: SFZone, ms: MonoSample):
        self.rect = rect
        self.zone = z
        self.ms   = ms
        ls = z.loop_abs_start - z.a_start
        le = z.loop_abs_end   - z.a_start
        nf = max(0, z.a_end - z.a_start)
        ls = max(0, min(ls, nf)); le = max(0, min(le, nf))
        if z.modes in (1, 3) and le - ls >= 2:
            self.loop_mode  = 1 | (0x4 if z.modes == 3 else 0)
            self.loop_start = ls
            self.loop_end   = le
        else:
            self.loop_mode  = 0
            self.loop_start = 0
            self.loop_end   = 0
        # samplingRate = SF2 rate; the rootkey/tuning shift goes into the
        # signed 4096-TET detune so MIDI key 60 always means noteVal 0x5000.
        # scaleTuning (cents per key, 0 = fixed-pitch drums) is folded in
        # around the zone's centre key: exact for single-key zones, exact
        # everywhere when scale = 100.
        k_ref = (z.keylo + z.keyhi) / 2.0
        det = round(((k_ref - z.rootkey) * (z.scale / 100.0)
                     - (k_ref - 60.0)) * UNITS_PER_SEMI
                    + z.tune_cents * 4096.0 / 1200.0)
        self.detune = max(-0x8000, min(0x7FFF, det))
        if z.pan is None:
            self.pan8 = IXMP_PAN_NO_OVERRIDE
        else:
            self.pan8 = max(0, min(255, round(127.5 + z.pan * 255.0 / 1000.0)))
        self.hits = 0

    def to_ixmp_dict(self, canonical, bpm0, fadeout_override):
        r = self.ms.ratio
        # Synthesized-loop samples carry their loop in the final output-frame domain
        # (already resampled) and force a plain forward loop; otherwise the zone's SF2
        # loop scaled by this sample's resample ratio.
        if self.ms.synth_loop is not None:
            ls_w, le_w, lm_w = self.ms.synth_loop[0], self.ms.synth_loop[1], 1
        else:
            ls_w = round(self.loop_start * r)
            le_w = round(self.loop_end   * r)
            lm_w = self.loop_mode
        d = {
            'pitch_start':         self.rect[0],
            'pitch_end':           self.rect[1],
            'volume_start':        self.rect[2],
            'volume_end':          self.rect[3],
            'sample_ptr':          self.ms.offset,
            'sample_length':       min(len(self.ms.data), 0xFFFF),
            'play_start':          0,
            'loop_start':          min(0xFFFF, ls_w),
            'loop_end':            min(0xFFFF, le_w),
            'sampling_rate':       max(1, min(0xFFFF, round(self.ms.rate * r))),
            'sample_detune':       self.detune,
            'loop_mode':           lm_w,
            'default_pan':         self.pan8,
            'default_note_volume': 0,            # no override → base DNV
            'vibrato_speed':       0,
            'vibrato_sweep':       0,
            'vibrato_depth':       0,
            'vibrato_rate':        0,
            'vibrato_waveform':    0xFF,         # no override
        }
        # Per-patch overrides — emitted ONLY when they differ from the canonical
        # zone (whose envelopes/filter live in the base instrument record, which the
        # patch falls through to when a block is absent). This is what gives SF2
        # velocity / key layers their own ADSR + filter while keeping patches lean.
        z, c = self.zone, canonical.zone
        # Effective vol-env: a synthesized-loop sample uses a peak->0 decay (no sustain),
        # else the zone's SF2 ADSR. Emitted only when it differs from the canonical's.
        vol_self  = _effective_vol_env(z, self.ms)
        vol_canon = _effective_vol_env(c, canonical.ms)
        if vol_self != vol_canon:
            d['vol_env'] = vol_self
        # SF-mode filter: mode flag + 16-bit cutoff cents / Q centibels + filter env.
        sf_s, cut_s, res_s, filt_s = _zone_filter_sf(z)
        sf_c, cut_c, res_c, filt_c = _zone_filter_sf(c)
        pit_s = _pitch_env_block(z) if z.me2pitch else None
        pit_c = _pitch_env_block(c) if c.me2pitch else None
        # Emit the 'x' block when filter (mode/cutoff/resonance/env) OR initialAttenuation
        # differs from the canonical (base) zone. initialAttenuation is a per-voice gain (NOT
        # folded into the env); when 'x' is present it carries this patch's atten, else the
        # voice inherits the base record's atten. A differing filter ENV must co-emit 'x'
        # because the env's node ratios scale the patch's OWN peak cutoff (the 'x' cutoff).
        att_s = atten_cb_to_octet(z.atten_cb)
        att_c = atten_cb_to_octet(c.atten_cb)
        # Volume Fadeout = this patch's own SF2 release segment; emit 'x' when it (or any
        # filter / atten field) differs from the canonical zone so the per-layer release
        # time is faithful (an absent 'x' falls through to the base record's fadeout). A
        # synthesized-loop sample keeps its key-off fadeout too: the peak->0 decay vol-env
        # (no sustain wrap) only fades the HELD note to silence ~SF2_SYNTH_DECAY_SEC after
        # note-on; on key-off the voice must still release over the SF2 release time as
        # FluidSynth does. Forcing 0 here left key-off inert, so released notes rang for the
        # whole 10 s decay (audible on piano/pizz/mallet patches in Musyng Kite & Timbres
        # of Heaven 4.00 whose long unlooped samples take the synth-loop path).
        fo_s = _zone_fadeout(z, bpm0, fadeout_override)
        fo_c = _zone_fadeout(c, bpm0, fadeout_override)
        filt_differs = (filt_s != filt_c)
        if (sf_s != sf_c or cut_s != cut_c or res_s != res_c or att_s != att_c
                or filt_differs or fo_s != fo_c):
            d['extra'] = {'fadeout':            fo_s,
                          'filter_sf_mode':     sf_s,
                          'default_cutoff':     cut_s,
                          'default_resonance':  res_s,
                          'initial_attenuation': att_s}
        if filt_s is not None and filt_differs:
            d['filter_env'] = filt_s
        if pit_s is not None and pit_s != pit_c:
            d['pitch_env'] = pit_s
        return d


class TaudInstrument:
    __slots__ = ('slot', 'inst_key', 'name', 'patches', 'canonical', 'usable')
    # patches: kept Patch list in zone order, canonical Patch INCLUDED
    # (the Ixmp emitter skips it; the base record carries its fields).


def _rect_overlap(a, b) -> bool:
    """True when two (pitch_lo, pitch_hi, vol_lo, vol_hi) rectangles intersect."""
    p0, p1, v0, v1 = a
    q0, q1, w0, w1 = b
    return not (p1 < q0 or p0 > q1 or v1 < w0 or v0 > w1)


def _partition_layers(zones: list, registry: dict, max_layers: int):
    """Split zones into disjoint layers by ITERATED first-wins disjointify.

    Layer 0 is the classic disjointify result: each zone is rectangle-SUBTRACTED
    against the rects already placed in the layer, so its non-overlapping pieces
    tile in. This is essential — the velocity axis quantises 0..127 → 0..63, so
    adjacent SF2 velocity splits round to ranges that touch/overlap by ~1 unit;
    subtraction absorbs that boundary sliver into the first zone instead of
    spawning a spurious extra layer (which would DOUBLE the level at boundary
    velocities). Only a zone that is *fully* covered by the layer below — SF2's
    real simultaneous layering, detune-stacks, duplicate zones — spills down to
    the next layer, where the same disjointify runs over the spilled set. Returns
    ([ [(rect, zone, ms), …] per layer ], dropped_zone_count)."""
    remaining = []
    for z in zones:
        ms = MonoSample(z)
        if ms.frames < 2:
            continue
        ms = registry.setdefault(ms.key(), ms)
        remaining.append((z, ms))

    layers = []
    while remaining and len(layers) < max_layers:
        kept_rects = []
        layer = []
        spill = []
        for z, ms in remaining:
            pieces = [_rect_of_zone(z)]
            for k in kept_rects:
                pieces = [p2 for p in pieces for p2 in _rect_subtract(p, k)]
                if not pieces:
                    break
            pieces = [p for p in pieces if p[0] <= p[1] and p[2] <= p[3]]
            if not pieces:
                spill.append((z, ms))          # fully overlapped → next layer
                continue
            for p in pieces:
                kept_rects.append(p)
                layer.append((p, z, ms))
        if layer:
            layers.append(layer)
        remaining = spill
    return layers, len(remaining)


def _build_layer_instrument(name: str, items: list, trig: dict):
    """One normal TaudInstrument from a layer's disjoint (rect, zone, ms) items,
    trimmed to patches actually hit by a trigger. None when no patch is hit
    (the layer is silent for the whole song → dropped)."""
    all_patches = [Patch(r, z, ms) for (r, z, ms) in items]
    for (nv, v6), cnt in trig.items():
        for p in all_patches:
            r = p.rect
            if r[0] <= nv <= r[1] and r[2] <= v6 <= r[3]:
                p.hits += cnt
                break
    kept = [p for p in all_patches if p.hits > 0]
    if not kept:
        return None
    ti = TaudInstrument()
    ti.name = name
    ti.patches = kept
    ti.canonical = max(kept, key=lambda p: p.hits)
    ti.usable = True
    ti.slot = 0
    ti.inst_key = None
    return ti


def build_presets(sf: SF2, slot_keys: list, triggers: dict, perc_force,
                  registry: dict, max_layers: int) -> dict:
    """For each preset (inst_key), partition its SF2 zones into disjoint layers
    and build one normal TaudInstrument per layer (trimmed to triggered patches).
    Returns dict[inst_key → (name, [layer TaudInstrument])]. Downstream, a preset
    with >1 layer becomes a Metainstrument; a single-layer preset stays a plain
    instrument. `registry` dedupes MonoSamples across all presets/layers."""
    presets = {}
    for ik in slot_keys:
        res = resolve_preset(sf, ik, perc_force)
        if res is None:
            vprint(f"  warning: no SF2 preset for {ik!r} — its notes are dropped")
            presets[ik] = ('(missing preset)', [])
            continue
        name, zones = res
        zones = merge_stereo_zones(zones, sf.shdrs)
        layer_items, dropped = _partition_layers(zones, registry, max_layers)
        if dropped:
            vprint(f"  warning: '{name}': {dropped} zone(s) exceed the "
                   f"{max_layers}-layer cap and were dropped (raise --max-layers)")
        trig = triggers.get(ik, {})
        layers = [ti for items in layer_items
                  if (ti := _build_layer_instrument(name, items, trig)) is not None]
        if not layers and layer_items:
            # Nothing triggered (out-of-range): keep the single patch nearest the
            # mean trigger pitch so the preset still sounds (matches the old path).
            mean_nv = (sum(nv * c for (nv, _), c in trig.items())
                       / max(1, sum(trig.values()))) if trig else TAUD_C4
            flat = [Patch(r, z, ms) for items in layer_items for (r, z, ms) in items]
            best = min(flat, key=lambda p: abs((p.rect[0] + p.rect[1]) / 2 - mean_nv))
            ti = TaudInstrument()
            ti.name = name; ti.patches = [best]; ti.canonical = best
            ti.usable = True; ti.slot = 0; ti.inst_key = ik
            layers = [ti]
        for ti in layers:
            ti.inst_key = ik
        presets[ik] = (name, layers)
        if layers:
            vprint(f"  preset '{name}': {len(zones)} zone(s) → {len(layers)} layer(s)"
                   + (" → Metainstrument" if len(layers) > 1 else ""))
        else:
            vprint(f"  warning: '{name}': no usable zones — notes dropped")
    return presets


# Metainstrument mix-volume octet for an unmixed layer (159 = 0 dB / unity); the
# converter folds per-zone level/tune into each layer instrument's patches, so the
# meta layers stay neutral. (terranmon.txt "Perceptually Significant Octet …".)
META_UNITY_OCTET = 159


def _layer_bbox(ti: 'TaudInstrument'):
    """Bounding (pitch_lo, pitch_hi, vol_lo, vol_hi) over a layer instrument's kept
    patch rects — the Metainstrument layer's gating rectangle."""
    rs = [p.rect for p in ti.patches]
    return (min(r[0] for r in rs), max(r[1] for r in rs),
            min(r[2] for r in rs), max(r[3] for r in rs))


# ── Sample pool + instrument bin ──────────────────────────────────────────────

def _env_seg_count(t_sec: float) -> int:
    """Number of linear segments to approximate an exponential (linear-dB) ramp of
    `t_sec` seconds. Short ramps keep the old 2-segment shape; long ramps (the 5–20 s
    SF2 decays/releases that a 2-point line collapses badly) get up to 8 segments so
    the curve stays smooth (issue 4)."""
    return max(3, min(8, 2 + round(t_sec / 2.0)))


def _adsr_to_env(z: SFZone):
    """SF2 volume-envelope ADSR → (env_points, sustain_idx, release_sec).

    env_points is up to 25 (value 0..63, minifloat_idx) pairs; each node's
    minifloat encodes the time to the NEXT node (engine interpolates values
    linearly across that span). The envelope carries the delay/attack/hold/decay
    legs and ENDS at the sustain node — there is NO release leg. The engine wraps
    on the sustain node while the key is held (SUSTAIN word); on key-off it holds
    at that terminal node and the Volume Fadeout (emitted with NNA Note Fade) is
    the SF2 *release segment* (see _zone_fadeout). SF2's decay is LINEAR in dB
    (exponential in amplitude); per the SF2 spec decayVolEnv is the full-100dB
    time, truncated by the sustain level. The decay leg is sampled at equal-time
    (= equal-dB) points and emitted as a piecewise-linear-amplitude approximation
    — segment count scales with its duration (issue 4) so multi-second decays
    don't collapse to a 2-point line. release_sec (= SF2 releaseVolEnv) is returned
    only to feed the fadeout calc.
    """
    EPS = 0.004                       # below the minifloat resolution (1/256 s)
    sus_cb = min(z.env_sustain_cb, 1000.0)     # clamp to 100 dB full-scale
    slevel = 10.0 ** (-z.env_sustain_cb / 200.0)
    s63 = max(0, min(63, round(63 * slevel)))
    pts = []                          # (value, delta_sec_to_next)
    if z.env_delay >= EPS:
        pts.append((0, z.env_delay))
    if z.env_attack >= EPS:
        pts.append((0, z.env_attack))
    hold = z.env_hold if z.env_hold >= EPS else 0.0
    # Decay leg: peak (63) → sustain (s63), exponential amplitude over `edec` seconds.
    # The peak node carries the hold time. The final decay node is the sustain node
    # (appended below), so the in-between nodes are f = 1/n .. (n-1)/n.
    if s63 < 63:
        edec = z.env_decay * sus_cb / 1000.0
        if edec >= EPS:
            n = _env_seg_count(edec)
            seg = edec / n
            pts.append((63, hold + seg))                       # peak, held then 1st seg
            for i in range(1, n):                              # f = 1/n .. (n-1)/n
                f = i / n
                v = round(63 * 10.0 ** (-(sus_cb * f) / 200.0))
                pts.append((max(s63, min(63, v)), seg))
        else:
            pts.append((63, hold))
    sustain_idx = len(pts)            # the node appended next is the sustain node
    rel = z.env_release
    # No release leg: the sustain node is the terminal node. While the key is held the
    # engine wraps on it (SUSTAIN word); after key-off it holds there and the Volume
    # Fadeout (NNA Note Fade) performs the SF2 release segment (see _zone_fadeout). A
    # zero sustain leaves a terminal 0 node, so the engine retires the voice naturally
    # at the end of decay.
    pts.append((s63, 0.0))            # sustain node = terminator
    env = [(v, nearest_minifloat(d)) for v, d in pts[:25]]
    while len(env) < 25:
        env.append((env[-1][0], 0))
    return env, min(sustain_idx, 24), rel


# Envelope LOOP-word bits (terranmon.txt base byte 15/17/19).
ENV_PRESENT_BIT = 0x2000          # P — envelope present in source (LOOP-word bit 13)
ENV_SUS_ENABLE  = 0x0020          # b — enable the SUSTAIN wrap (SUSTAIN-word bit 5)
ENV_PF_FILTER   = 0x0080          # m — pitch/filter LOOP-word bit 7 (1 = filter)


def _atten_gain(atten_cb: float) -> float:
    """SF2 initialAttenuation (cB) → linear amplitude multiplier (≤ 1.0)."""
    return 10.0 ** (-max(0.0, atten_cb) / 200.0)


def _vol_env_block(z: SFZone):
    """Taud volume-envelope block dict from a zone's SF2 ADSR — the PURE ADSR shape
    at full 0..63 resolution. initialAttenuation is NO LONGER folded into the node
    peak (it would crush a heavily-attenuated env to peak ~3 and zero its tail, e.g.
    SGM 'Fantasia'); it is now carried as a separate per-voice gain — base record
    bytes 251-252 / Ixmp 'x' block initialAttenuation — applied in the mixer. Returns
    (block_dict, sustain_idx, release_sec)."""
    env, sidx, rel = _adsr_to_env(z)
    nodes = [(max(0, min(63, v)), mf) for (v, mf) in env]
    sustain = ENV_SUS_ENABLE | ((sidx & 0x1F) << 8) | (sidx & 0x1F)
    return {'loop': ENV_PRESENT_BIT, 'sustain': sustain, 'nodes': nodes}, sidx, rel


# SF2 initialFilterFc default ≈ 13500 cents (~20 kHz) means "no filter / fully open".
SF2_FILTER_OPEN_CENTS = 13500
# Taud SF-mode "filter off" sentinel for the 16-bit cutoff/resonance fields.
SF_FILTER_OFF = 0xFFFF


def _zone_filter_sf(z: SFZone):
    """Resolve a zone's filter into Taud SF-mode parameters.

    Taud SF mode (base byte 173 bit 4 / patch 'x' flag) stores the cutoff as
    SoundFont **absolute cents** and resonance as **centibels above DC gain** —
    the engine computes freq = 8.176·2^(cents/1200) and dmpfac = 10^(−Qcb/200),
    so there is no ImpulseTracker ~5 kHz cutoff ceiling. When the zone has a
    modulation envelope driving the cutoff, the stored cutoff is the PEAK the
    envelope reaches and the filter-env nodes scale it back down (see
    [_filter_env_block_sf]); the engine's `currentCutoff = baseCut · envValue`
    then reproduces the SF2 sweep exactly (linear-in-cents = the right log-Hz
    sweep).

    Returns (sf_mode, cutoff16, resonance16, filter_env_block_or_None).
    sf_mode False → no filter (IT-mode 'off')."""
    base_fc = z.filter_fc
    amt     = z.me2filt
    has_static = base_fc < SF2_FILTER_OPEN_CENTS
    has_env    = bool(amt)
    if not has_static and not has_env:
        return False, SF_FILTER_OFF, SF_FILTER_OFF, None
    peak = max(1, min(0xFFFE, round(base_fc + max(0, amt))))   # engine baseCut
    qcb  = max(0, min(0xFFFE, round(z.filter_q)))              # cB above DC gain
    env  = _filter_env_block_sf(z, base_fc, amt, peak) if has_env else None
    return True, peak, qcb, env


def _filter_env_block_sf(z: SFZone, base_fc: float, amt: float, peak: int) -> dict:
    """Filter envelope in SF-cents domain. Each node value = cutoff_cents(u)/peak·255
    following the SF2 modulation-envelope DAHDSR (u walks 0→1→sustain), where
    cutoff_cents(u) = base_fc + amt·u. 0xFF (255) = fully open at `peak`; the
    release returns to the base cutoff. The engine multiplies `peak` (= baseCut)
    by node/255 each tick, so the node ratios reproduce the SF2 cutoff sweep."""
    EPS   = 0.004
    sus_u = 1.0 - z.m_sustain_pc / 1000.0          # mod-env sustain level (0..1)

    def nodeval(u: float) -> int:
        cents = base_fc + amt * u
        return max(0, min(255, round(255.0 * cents / peak)))

    pts = []                                        # (value_byte, secs_to_next)
    if z.m_delay >= EPS:
        pts.append((nodeval(0.0), z.m_delay))
    pts.append((nodeval(0.0), z.m_attack if z.m_attack >= EPS else 0.0))
    hold = z.m_hold if z.m_hold >= EPS else 0.0
    if sus_u < 1.0 and z.m_decay >= EPS:
        pts.append((nodeval(1.0), hold + z.m_decay))
        sustain_idx = len(pts)
        pts.append((nodeval(sus_u), z.m_release if z.m_release >= EPS else 0.0))
    else:
        pts.append((nodeval(1.0), hold))
        sustain_idx = len(pts) - 1
    pts.append((nodeval(0.0), 0.0))                 # release returns to base cutoff
    nodes = [(v, nearest_minifloat(d)) for v, d in pts[:25]]
    while len(nodes) < 25:
        nodes.append((nodes[-1][0], 0))
    sustain_idx = min(sustain_idx, 24)
    loop    = ENV_PRESENT_BIT | ENV_PF_FILTER       # m-bit set = filter role
    sustain = ENV_SUS_ENABLE | ((sustain_idx & 0x1F) << 8) | (sustain_idx & 0x1F)
    return {'loop': loop, 'sustain': sustain, 'nodes': nodes}


# The engine's Volume Fadeout is LINEAR IN AMPLITUDE (fadeoutVolume drops 1→0 by
# fadeStep/1024 per tick — AudioAdapter.kt ~L3679), whereas FluidSynth's release ramps
# attenuation LINEARLY IN dB (amplitude decays exponentially: −96 dB over releaseVolEnv).
# Matching the two on "time to the absolute floor" makes the linear fade sound MUCH longer:
# a linear-amplitude fade is still at −6 dB at 50 % of its length and −20 dB only at 90 %,
# while FluidSynth is already −96 dB (silent) by then. The perceived release tail ends when
# FluidSynth has dropped ≈22 dB; for the linear fade to land there at the same wall-clock
# time it must complete in ≈0.25·releaseVolEnv (see the −18..−24 dB crossing band). This
# scale brings the fadeout in line with FluidSynth's audible release length.
_RELEASE_PERCEPTUAL_SCALE = 0.25


def _zone_fadeout(z: SFZone, bpm0: int, fadeout_override) -> int:
    """Volume Fadeout step encoding the zone's SF2 release segment (gen 38,
    releaseVolEnv). With NNA Note Fade the fadeout IS the release: on key-off the
    voice fades to silence over the release time.

    FluidSynth's release (fluid_rvoice.c:54-55, fluid_voice.c:1092-1094) ramps the
    volume-envelope coefficient LINEARLY from its value at key-off down to 0, where
    amplitude = cb2amp(960·(1−volenv_val)) — i.e. the coefficient is linear in dB. The
    release rate is fixed: a full 1.0→0 ramp takes `releaseVolEnv` seconds, so a note
    released at coefficient v reaches silence in v·releaseVolEnv. v is HIGH whenever the
    note is still audible at key-off — which is the norm for the long-decay instruments
    (bells, organs, harpsichord, sitar, mute guitar) that Timbres of Heaven & friends
    encode with a silent sustain (sustainVolEnv≈1000 cB) and a multi-second decay: the
    decay IS the sound, and the key is lifted long before it reaches the silent sustain.
    So the fadeout must reflect the FULL releaseVolEnv, NOT a sustain-scaled fraction.

    The earlier model scaled by (1000−sus_cb)/1000 (the release time FROM the sustain
    level), which is only correct for a note held all the way to its sustain. For the
    decay instruments above (sus_cb≈1000) it collapsed to ~0 → an instant cut on key-off
    instead of FluidSynth's seconds-long release — released organ/bell/harpsichord notes
    were chopped off. Dropping the factor leaves the common sustained instruments
    (sus_cb≈0, factor was ≈1) unchanged and gives the decay instruments a real release.

    The engine's fadeout is linear in AMPLITUDE while FluidSynth's release is linear in
    dB (see [_RELEASE_PERCEPTUAL_SCALE]); matching the floor-reaching time would make the
    audible tail ~4× too long, so fade_sec is scaled to FluidSynth's perceived release.
    fadeStep makes the fadeout complete in fade_sec at bpm0: the engine subtracts
    fadeStep/1024 of unit volume per song tick, and the tick rate is bpm0·2/5 Hz, giving
    fadeStep = 2560/(fade_sec·bpm0)."""
    if fadeout_override is not None:
        return min(0xFFF, max(0, fadeout_override))
    fade_sec = max(0.02, _RELEASE_PERCEPTUAL_SCALE * z.env_release)
    return max(1, min(0xFFF, round(2560.0 / (fade_sec * bpm0))))


def _extra_block(z: SFZone, bpm0: int, fadeout_override) -> dict:
    """The 'x' block: release-segment fadeout + SF-mode static cutoff/resonance + filter mode."""
    sf_mode, cut16, res16, _ = _zone_filter_sf(z)
    return {'fadeout':            _zone_fadeout(z, bpm0, fadeout_override),
            'filter_sf_mode':     sf_mode,
            'default_cutoff':     cut16,
            'default_resonance':  res16}


def _pitch_env_block(z: SFZone) -> dict:
    """Pitch ('P') envelope block from the SF2 modulation envelope (DAHDSR),
    scaled by modEnvToPitch. Engine value mapping (byte/255; 0.5 = 0x80 = unity):
    envValue 1.0 → +16 semitones, so value = 0.5 + semis/32. The mod-env is
    unipolar 0→1; release returns to unity (0x80). (Filter envelopes are built
    separately in cents domain by [_filter_env_block_sf].)"""
    EPS = 0.004
    amount_cents = z.me2pitch
    sus_lvl = 1.0 - z.m_sustain_pc / 1000.0          # mod-env sustain level (0..1)

    def mapval(u: float) -> int:
        val = 0.5 + (amount_cents * u / 100.0) / 32.0
        return max(0, min(255, round(255 * max(0.0, min(1.0, val)))))

    pts = []                                          # (value_byte, secs_to_next)
    if z.m_delay >= EPS:
        pts.append((mapval(0.0), z.m_delay))
    pts.append((mapval(0.0), z.m_attack if z.m_attack >= EPS else 0.0))
    hold = z.m_hold if z.m_hold >= EPS else 0.0
    if sus_lvl < 1.0 and z.m_decay >= EPS:
        pts.append((mapval(1.0), hold + z.m_decay))
        sustain_idx = len(pts)
        pts.append((mapval(sus_lvl), z.m_release if z.m_release >= EPS else 0.0))
    else:
        pts.append((mapval(1.0), hold))
        sustain_idx = len(pts) - 1
    pts.append((mapval(0.0), 0.0))                    # release returns to unity (0x80)
    nodes = [(v, nearest_minifloat(d)) for v, d in pts[:25]]
    while len(nodes) < 25:
        nodes.append((nodes[-1][0], 0))
    sustain_idx = min(sustain_idx, 24)
    loop = ENV_PRESENT_BIT                            # m-bit clear = pitch role
    sustain = ENV_SUS_ENABLE | ((sustain_idx & 0x1F) << 8) | (sustain_idx & 0x1F)
    return {'loop': loop, 'sustain': sustain, 'nodes': nodes}


def _zone_pf_envs(z: SFZone):
    """Return (filter_env_block_or_None, pitch_env_block_or_None) for a zone's
    modulation envelope. SF2's single mod-env can drive both targets at once;
    the filter leg is built in SF-cents domain (see [_zone_filter_sf])."""
    _, _, _, filt = _zone_filter_sf(z)
    pit = _pitch_env_block(z) if z.me2pitch else None
    return filt, pit


# ── SF2 long-sample resampling + synthesized sustain loop ─────────────────────
#
# Per-sample handling when a rendered MonoSample exceeds the 65535-frame u16 cap
# (terranmon.txt sample_length is u16). Two strategies, by the rate that fitting
# the WHOLE sample into 65535 frames would leave:
#   (1)/(2) rate >= SF2_RESAMPLE_FLOOR_HZ  → downsample the whole sample to 65535
#           frames (quality stays acceptable, full sample preserved).
#   (3)     rate <  SF2_RESAMPLE_FLOOR_HZ  → resample to the 32 kHz floor instead
#           (keeps full bandwidth), keep the first 65535 frames, and — when the
#           sample has NO loop of its own — synthesize a near-seamless forward
#           loop near the end so held notes keep sounding, plus a peak->0 decay
#           vol-envelope (see _synth_decay_vol_env) that retires the voice
#           ~SF2_SYNTH_DECAY_SEC after the note fires.
SF2_RESAMPLE_FLOOR_HZ = 32000        # TSVM native audio rate (= full-bandwidth floor)
SF2_SYNTH_DECAY_SEC   = 10.0         # looped-note fade-to-silence span (from note-on)
SF2_LOOP_HINT         = 8192         # spec's "last 8192 samples" → MAX loop period searched
SF2_LOOP_MIN_PERIOD   = 512          # min loop period (avoid buzzy ultra-short loops)
SF2_LOOP_MATCH_WIN    = 256          # forward-window length used to score a loop seam
SF2_LOOP_MATCH_STEP   = 2            # stride within the match window (speed/quality trade)
SF2_LOOP_COARSE_STEP  = 32           # period stride for the coarse search pass


def _synth_sustain_loop(data: bytes, cap: int, hint: int):
    """Pick a near-seamless forward loop near the end of a resampled, originally
    UN-looped sample, and truncate it to <= `cap` frames. Returns
    (body, loop_start, loop_end) with the loop region [loop_start, loop_end)
    (loop_end exclusive — matches the engine's mode-1 wrap, AudioAdapter.kt:2126).

    The loop is chosen by minimising the sum-of-squared-difference between the
    W-frame windows that FOLLOW loop_start and loop_end. Forward playback wraps
    loop_end -> loop_start, so matching data[loop_start+k] ~= data[loop_end+k]
    makes the post-wrap texture continue the pre-wrap texture seamlessly (the k=0
    term also matches the immediate seam value). `hint` (the spec's "last 8192
    samples") is the MAXIMUM loop period searched, NOT taken at face value: the
    analysis settles on the smoothest-looping period in [SF2_LOOP_MIN_PERIOD, hint]
    via a coarse sweep refined locally."""
    keep = min(len(data), cap)
    W    = SF2_LOOP_MATCH_WIN
    # loop_end sits W frames before the kept end so the forward match window
    # [loop_end, loop_end + W) stays within the data.
    loop_end = keep - W
    p_max = min(hint, loop_end)
    p_min = min(SF2_LOOP_MIN_PERIOD, p_max)
    if loop_end <= p_min:                      # too short to loop (not expected in case 3)
        return data[:keep], max(0, keep - 2), keep

    def seam_err(ls: int) -> int:
        s  = 0
        le = loop_end
        for k in range(0, W, SF2_LOOP_MATCH_STEP):
            d = data[ls + k] - data[le + k]
            s += d * d
        return s

    best_p = p_min
    best_e = seam_err(loop_end - best_p)
    p = p_min + SF2_LOOP_COARSE_STEP
    while p <= p_max:
        e = seam_err(loop_end - p)
        if e < best_e:
            best_e, best_p = e, p
        p += SF2_LOOP_COARSE_STEP
    lo = max(p_min, best_p - SF2_LOOP_COARSE_STEP)
    hi = min(p_max, best_p + SF2_LOOP_COARSE_STEP)
    for p in range(lo, hi + 1):
        e = seam_err(loop_end - p)
        if e < best_e:
            best_e, best_p = e, p

    loop_start = max(0, min(loop_end - 2, loop_end - best_p))
    return data[:keep], loop_start, loop_end


def _synth_decay_vol_env(decay_sec: float) -> dict:
    """Volume-envelope block for a synthesized-loop sample: an immediate peak that
    decays exponentially (linear-dB) to silence over `decay_sec`, with NO sustain
    or loop wrap. The looped sample would otherwise sound forever; this envelope
    fades it from the instant the note fires and — because there is no wrap
    (resolveEnvWrap returns range (-1,-1)) — the engine's fall-through
    'envelope ends at 0 => cut' rule (AudioAdapter.kt:1693/1701) retires the voice
    once it reaches the terminal 0 node, ~decay_sec after firing, regardless of
    key state. The drop spans the representable 63->1 range (~36 dB); the final
    node is a true 0 terminator."""
    DROP_CB = 360.0                            # 63 -> 1 fills the whole decay span
    n   = _env_seg_count(decay_sec)
    seg = decay_sec / n
    pts = [(63, seg)]                          # peak, held one segment then decays
    for i in range(1, n):
        v = round(63 * 10.0 ** (-(DROP_CB * (i / n)) / 200.0))
        pts.append((max(1, min(63, v)), seg))
    pts.append((0, 0.0))                       # terminal 0 node => fall-through cut
    nodes = [(v, nearest_minifloat(d)) for v, d in pts[:25]]
    while len(nodes) < 25:
        nodes.append((0, 0))
    return {'loop': ENV_PRESENT_BIT, 'sustain': 0, 'nodes': nodes}


def _effective_vol_env(z: SFZone, ms: 'MonoSample') -> dict:
    """Volume-envelope block for a (zone, sample): a synthesized-loop sample fades
    from note-on via a peak->0 decay (no sustain), overriding the SF2 ADSR;
    otherwise the zone's SF2 ADSR shape (_vol_env_block)."""
    if ms is not None and ms.synth_decay is not None:
        return _synth_decay_vol_env(ms.synth_decay)
    blk, _, _ = _vol_env_block(z)
    return blk


def build_sample_inst_bin(sf: SF2, pool: list, layer_insts: list, meta_records: list,
                          fadeout_override, bpm0: int, force_synth_loop: bool = False):
    """Render & pool every used MonoSample (with the 65535-byte per-sample
    and 8 MB global caps), write the 256-byte normal-instrument records for every
    layer instrument, then the Metainstrument records. Returns the raw
    SAMPLEINST_SIZE image.

    `force_synth_loop`: when a looped sample's loop sits past the 65535-frame cap
    even at 32 kHz (case 3c), replace its real loop with a synthesized one at the
    32 kHz floor instead of muffling the whole sample down to fit (the default).
    Trades the genuine sustain loop for full bandwidth + a 10 s decay — useful for
    banks of multi-second far-loop instruments (e.g. Timbres of Heaven)."""
    for ms in pool:
        ms.render(sf)

    # Per-sample u16 cap. A sample over the 65535-frame limit is shrunk one of two
    # ways (see the SF2 long-sample section above): downsample the whole thing when
    # that keeps the rate >= 32 kHz; otherwise resample to the 32 kHz floor, keep the
    # first 65535 frames and synthesize a sustain loop + decay (only when the sample
    # has no loop of its own — a sample with an SF2 loop is left to fall-through, as
    # its loop already lets it sustain within whatever frames fit).
    for ms in pool:
        native_len = len(ms.data)
        if native_len <= SAMPLE_LEN_LIMIT:
            continue
        r_fit    = SAMPLE_LEN_LIMIT / native_len
        rate_fit = ms.rate * r_fit
        r32      = SF2_RESAMPLE_FLOOR_HZ / ms.rate
        # loop_end in 32 kHz frames (0 when unlooped) decides whether a 32 kHz render
        # still contains the loop within the 65535-frame cap.
        le32 = round(ms.loop_native[1] * r32) if ms.loop_native else 0

        def _fit_whole():
            """(1)/(2) downsample the WHOLE sample to <= 65535 frames. Used when the
            fitted rate stays >= 32 kHz, or as the fall-back for a looped sample whose
            loop sits past the cap at 32 kHz (only fit-to-cap keeps that far loop)."""
            ms.data   = resample_linear(ms.data, r_fit)
            ms.ratio *= len(ms.data) / native_len

        def _synth_path():
            """(3) resample to the 32 kHz floor (full bandwidth), keep the first 65535
            frames and synthesize a near-seamless sustain loop near the end, plus a
            peak->0 decay vol-envelope that fades the looped note to silence from
            note-on. Used for unlooped long samples, and (with --force-synth-loop) for
            looped samples whose real loop won't fit at the floor. synth_loop takes
            precedence over any real loop_native in the record/patch writers."""
            resampled = resample_linear(ms.data, r32)
            ms.ratio *= len(resampled) / native_len    # effective rate -> 32 kHz
            ms.data   = resampled
            body, ls, le = _synth_sustain_loop(ms.data, SAMPLE_LEN_LIMIT, SF2_LOOP_HINT)
            ms.data        = body
            ms.synth_loop  = (ls, le)
            ms.synth_decay = SF2_SYNTH_DECAY_SEC
            return ls, le, len(body)

        if rate_fit >= SF2_RESAMPLE_FLOOR_HZ:
            _fit_whole()
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap; "
                   f"resampling by {r_fit:.4f} (rate {rate_fit:.0f} Hz)")
        elif ms.loop_native is None:
            # (3) No loop: synthesize one at the 32 kHz floor.
            ls, le, n = _synth_path()
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap, long & unlooped; "
                   f"32 kHz, kept {n} frames, synth loop [{ls}..{le}] "
                   f"+ {SF2_SYNTH_DECAY_SEC:.0f}s decay")
        elif le32 <= SAMPLE_LEN_LIMIT - 2:
            # (3) Looped, and the loop fits at the 32 kHz floor: resample to 32 kHz and
            # keep the first 65535 frames. The per-patch loop points (native * ratio)
            # land within the kept data, so the SF2 loop + ADSR are preserved at full
            # bandwidth (a sustain-loop release tail past loop_end is truncated to fit).
            resampled = resample_linear(ms.data, r32)
            ms.ratio *= len(resampled) / native_len
            ms.data   = resampled[:SAMPLE_LEN_LIMIT]
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap, long & looped; "
                   f"32 kHz, kept first {len(ms.data)} frames (loop_end {le32})")
        elif force_synth_loop:
            # (3c, forced) Looped, far loop, but --force-synth-loop: drop the genuine
            # loop and synthesize one at the 32 kHz floor rather than muffling the whole
            # sample. Full bandwidth + a 10 s decay, at the cost of the real sustain.
            ls, le, n = _synth_path()
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap, long, looped, far "
                   f"loop; FORCED synth: 32 kHz, kept {n} frames, synth loop [{ls}..{le}] "
                   f"+ {SF2_SYNTH_DECAY_SEC:.0f}s decay")
        else:
            # (3) Looped but the loop sits past the 65535-frame cap at 32 kHz (a far-end
            # sustain loop on a multi-second sample): the floor rate can't hold it, so
            # downsample the whole sample to fit — the ratio-scaled loop stays valid,
            # at a sub-32 kHz rate. (This is the pre-existing fit-to-cap behaviour;
            # --force-synth-loop swaps it for the synth path above.)
            _fit_whole()
            vprint(f"  info: '{ms.name}' {native_len} frames > 64K cap, long, looped, "
                   f"far loop; fit-to-cap by {r_fit:.4f} (rate {ms.rate * r_fit:.0f} Hz)")

    # Global 8 MB pool cap. Resamples every sample down equally; synthesized loop
    # points ride the same ratio so the loop stays valid in the shrunken data.
    total = sum(len(ms.data) for ms in pool)
    if total > SAMPLEBIN_SIZE:
        g = SAMPLEBIN_SIZE / total
        vprint(f"  info: sample pool overflow ({total} bytes); "
               f"resampling all by {g:.4f}")
        for ms in pool:
            old = len(ms.data)
            ms.data = resample_linear(ms.data, g)
            ms.ratio *= len(ms.data) / old
            if ms.synth_loop is not None:
                le = min(len(ms.data) - 1, round(ms.synth_loop[1] * g))
                ls = max(0, min(le - 2, round(ms.synth_loop[0] * g)))
                ms.synth_loop = (ls, le)

    sample_bin = bytearray(SAMPLEBIN_SIZE)
    pos = 0
    for ms in pool:
        n = min(len(ms.data), SAMPLEBIN_SIZE - pos)
        if n < len(ms.data):
            vprint(f"  warning: pool full, truncating '{ms.name}'")
            ms.data = ms.data[:n]
            if ms.synth_loop is not None:        # keep the synthesized loop inside the data
                le = min(n - 1, ms.synth_loop[1])
                ms.synth_loop = (max(0, min(le - 2, ms.synth_loop[0])), le)
        sample_bin[pos:pos+n] = ms.data
        ms.offset = pos
        pos += n
    vprint(f"  sample pool: {len(pool)} sample(s), {pos} bytes")

    inst_bin = bytearray(INSTBIN_SIZE)
    for ti in layer_insts:
        if not ti.usable:
            continue
        c  = ti.canonical
        ms = c.ms
        r  = ms.ratio
        base = ti.slot * 256
        struct.pack_into('<I', inst_bin, base + 0, ms.offset)
        struct.pack_into('<H', inst_bin, base + 4, min(len(ms.data), 0xFFFF))
        struct.pack_into('<H', inst_bin, base + 6,
                         max(1, min(0xFFFF, round(ms.rate * r))))
        struct.pack_into('<H', inst_bin, base + 8, 0)            # play start
        # Synthesized-loop samples carry their loop in the final output-frame domain
        # (already scaled by every resample) and force a plain forward loop (mode 1);
        # otherwise the canonical zone's SF2 loop, scaled by this sample's ratio.
        if ms.synth_loop is not None:
            ls_w, le_w, lm_w = ms.synth_loop[0], ms.synth_loop[1], 1
        else:
            ls_w = round(c.loop_start * r)
            le_w = round(c.loop_end   * r)
            lm_w = c.loop_mode
        struct.pack_into('<H', inst_bin, base + 10, min(0xFFFF, ls_w))
        struct.pack_into('<H', inst_bin, base + 12, min(0xFFFF, le_w))
        inst_bin[base + 14] = lm_w

        def wenv(loop_off, sus_off, nodes_off, blk):
            struct.pack_into('<H', inst_bin, base + loop_off, blk['loop'] & 0xFFFF)
            struct.pack_into('<H', inst_bin, base + sus_off,  blk['sustain'] & 0xFFFF)
            nodes = list(blk['nodes'])
            for k in range(25):
                v, mf = nodes[k] if k < len(nodes) else (nodes[-1][0] if nodes else 0, 0)
                inst_bin[base + nodes_off + k*2]     = v & 0xFF
                inst_bin[base + nodes_off + k*2 + 1] = mf & 0xFF

        # Volume envelope from the canonical zone's SF2 ADSR (delay/attack/hold/decay,
        # single-node sustain held while key is on). There is NO release leg: on key-off
        # the voice holds at the sustain node and the Volume Fadeout (NNA Note Fade) is
        # the SF2 release segment (see _zone_fadeout). initialAttenuation is carried
        # separately (byte 251 / 'x' octet), not folded into the node peak. Non-canonical
        # zones with a different ADSR carry their own per-patch vol_env (see
        # Patch.to_ixmp_dict); the base record is the canonical / fall-through. A
        # synthesized-loop sample instead uses a peak->0 decay envelope (no sustain) so
        # its otherwise-infinite loop fades to silence ~SF2_SYNTH_DECAY_SEC after firing.
        wenv(15, 189, 21, _effective_vol_env(c.zone, ms))
        # Pan envelope: none (default unity nodes; P bit clear in LOOP word).
        struct.pack_into('<H', inst_bin, base + 17, 0)
        for k in range(25):
            inst_bin[base + 71 + k*2] = 0x80
        # Pitch/filter envelopes — SEPARATE, fixed slots (issue 2): slot #1 (bytes
        # 19/121) is the FILTER envelope (m-bit set), defaulting flat to 0xFF
        # (fully OPEN — the engine's filter-env neutral, since currentCutoff =
        # baseCut·envValue and 1.0 = open); slot #2 (bytes 197/201) is the PITCH
        # envelope (m-bit clear), defaulting flat to 0x80 (unity, no transpose). A
        # flat slot keeps its LOOP word at 0 (P-bit clear) so the engine ignores it.
        sf_mode, cut16, res16, filt_env = _zone_filter_sf(c.zone)
        pit_env = _pitch_env_block(c.zone) if c.zone.me2pitch else None
        for k in range(25):
            inst_bin[base + 121 + k*2] = 0xFF                    # filter-env (slot 1) flat = open
            inst_bin[base + 201 + k*2] = 0x80                    # pitch-env (slot 2) flat = unity
        if filt_env is not None:
            wenv(19, 193, 121, filt_env)
        if pit_env is not None:
            wenv(197, 199, 201, pit_env)

        # Volume Fadeout = the SF2 release segment (NNA Note Fade below). Derived from
        # the canonical zone's full releaseVolEnv; see _zone_fadeout for the timecent→step
        # derivation and why it is NOT sustain-scaled. A synthesized-loop sample keeps
        # its key-off fadeout too: the peak->0 decay vol-env (no sustain wrap) only fades
        # the HELD note to silence over ~SF2_SYNTH_DECAY_SEC from note-on; on key-off the
        # voice must still release over the SF2 release time (FluidSynth does), else the
        # released note rings for the whole decay span instead of stopping.
        fo = _zone_fadeout(c.zone, bpm0, fadeout_override)
        inst_bin[base + 171] = 0xFF                              # IGV (unit)
        inst_bin[base + 172] = fo & 0xFF
        # byte 173: bits 0-3 = fadeout high nibble, bit 4 = SF filter mode (cutoff/resonance
        # are 16-bit SoundFont cents/centibels in bytes 182<<8|252 / 183<<8|253).
        inst_bin[base + 173] = ((fo >> 8) & 0x0F) | (0x10 if sf_mode else 0)
        inst_bin[base + 177] = (0x80 if c.pan8 == IXMP_PAN_NO_OVERRIDE
                                else c.pan8)                     # default pan
        struct.pack_into('<H', inst_bin, base + 178, TAUD_C4)    # PPC
        inst_bin[base + 182] = (cut16 >> 8) & 0xFF               # cutoff high (SF cents / IT byte)
        inst_bin[base + 252] = cut16 & 0xFF                      # cutoff low  (SF mode)
        inst_bin[base + 183] = (res16 >> 8) & 0xFF               # resonance high
        inst_bin[base + 253] = res16 & 0xFF                      # resonance low (SF mode)
        struct.pack_into('<H', inst_bin, base + 184, c.detune & 0xFFFF)
        # NNA = Note Fade (0b11) for every instrument, drum kits included. On any
        # key-off the voice holds at the sustain node and the Volume Fadeout performs
        # the SF2 release segment; when a fresh note displaces this voice the engine
        # ghosts it and starts the same fadeout, so released/displaced notes always
        # die over their own release time. (Supersedes the old melodic Key-Lift /
        # drum Continue split — the release now lives in the fadeout, not env nodes.)
        inst_bin[base + 186] = 0b11
        inst_bin[base + 196] = 255                               # default note vol
        # initialAttenuation (byte 251, dB-table octet) — the canonical zone's static gain,
        # applied per-voice by the mixer (no longer folded into the vol-env). Per-patch zones
        # with a different attenuation carry their own octet in the Ixmp 'x' block.
        inst_bin[base + 251] = atten_cb_to_octet(c.zone.atten_cb) & 0xFF

    # Metainstrument records: a 0xFFFF-sentinel sample pointer (high 16 bits) plus a
    # layer table (terranmon.txt "Metainstrument definition"). Layers stay neutral
    # (unity mix, zero detune); per-zone level/tune already live in each layer
    # instrument's patches. The note references the meta slot; the engine fans out.
    for meta_slot, _name, layer_descs in meta_records:
        base = meta_slot * 256
        inst_bin[base + 0] = 0                                  # type 0 = layered
        inst_bin[base + 1] = len(layer_descs) & 0xFF            # layer count
        inst_bin[base + 2] = 0xFF; inst_bin[base + 3] = 0xFF    # identifier (hi 16 bits)
        o = base + 4
        for layer_slot, rect in layer_descs:
            plo, phi, vlo, vhi = rect
            inst_bin[o]     = layer_slot & 0xFF
            inst_bin[o + 1] = META_UNITY_OCTET
            struct.pack_into('<h', inst_bin, o + 2, 0)          # sample detune (neutral)
            struct.pack_into('<H', inst_bin, o + 4, plo & 0xFFFF)
            struct.pack_into('<H', inst_bin, o + 6, phi & 0xFFFF)
            inst_bin[o + 8] = vlo & 0x3F
            inst_bin[o + 9] = vhi & 0x3F
            o += 10

    return bytes(sample_bin) + bytes(inst_bin)


# ── Cell grid (voices × rows) ────────────────────────────────────────────────

def _cell(cells: dict, v: int, row: int) -> dict:
    c = cells.get((v, row))
    if c is None:
        c = {'note': NOTE_NOP, 'inst': 0, 'vol': (SEL_FINE, 0),
             'pan': (SEL_FINE, 0), 'eff': None, 'prio': PRIO_FREE}
        cells[(v, row)] = c
    return c


def allocate_voices(notes: list, speed: int, max_voices: int) -> int:
    """Greedy per-row interval scheduling onto as few columns as possible.

    The engine's New Note Action does the heavy lifting (matching MIDI
    polyphony semantics): a fresh trigger on an occupied voice migrates the
    old note into the mixer's background-ghost pool, so a voice is reusable
    the moment its note is *released* — the Note-Fade tail rides the ghost
    (fading over the instrument's SF2 release). Melodic voices free at their
    key-off row; drum voices (no key-off by default) free on the very next
    row. Stealing is therefore graceful: the victim is released early, not cut.

    Mutates note.voice (and truncates stolen notes' end_ft). Returns the
    number of voices used."""
    cap = max(1, min(max_voices, NUM_VOICES))
    v_end  = []     # voice → first row at which it is free again
    v_slot = []     # voice → last instrument slot (affinity only)
    v_note = []     # voice → currently scheduled note
    stolen = 0
    for n in notes:
        srow = n.start_ft // speed
        free = [v for v in range(len(v_end)) if v_end[v] <= srow]
        v = next((x for x in free if v_slot[x] == n.slot),
                 free[0] if free else -1)
        if v < 0:
            if len(v_end) < cap:
                v = len(v_end)
                v_end.append(0); v_slot.append(0); v_note.append(None)
            else:
                # Steal preference: notes held only by the sustain pedal lose
                # least (their key is already up); otherwise the note ending
                # soonest. Either way NNA turns the steal into an early release.
                pedal = [x for x in range(len(v_end))
                         if v_note[x] is not None
                         and v_note[x].pedal_ft is not None
                         and v_note[x].pedal_ft <= n.start_ft]
                cand = pedal if pedal else range(len(v_end))
                v = min(cand, key=lambda x: v_end[x])
                victim = v_note[v]
                if victim is not None and victim.end_ft > n.start_ft:
                    victim.end_ft = n.start_ft
                stolen += 1
        if n.drum:
            end_row = srow + 1                       # ghost carries the ring
        else:
            end_row = max(srow + 1, n.end_ft // speed)   # free at key-off row
        if n.excl_cut_ft is not None:
            # exclusiveClass choke: hold the voice through the choke row so this note stays
            # FOREGROUND until then (the fast-fade cell must land on it, not a ghost), and so
            # the choking same-class note cannot reuse this column at the choke row.
            crow = n.excl_cut_ft // speed
            if crow <= srow:
                crow = srow + 1
            end_row = max(end_row, crow + 1)
        n.voice = v
        v_end[v], v_slot[v], v_note[v] = end_row, n.slot, n
    if stolen:
        vprint(f"  info: polyphony exceeded {cap} voices; {stolen} note(s) "
               f"released early (NNA ghost keeps the tail)")
    return len(v_end)


def emit_cells(song: Song, insts: dict, speed: int, rpb: int,
               eps_units: float, drum_keyoff: bool, shift_ft: int,
               max_voices: int) -> tuple:
    """Place triggers, key-offs, portamento bend segments, M channel-volume
    and T tempo effects into the (voice,row) cell grid.
    Returns (cells, n_voices, total_rows, taud_bpm0)."""
    notes = [n for n in song.notes if n.slot > 0]

    def midi_bpm_at(ft):
        i = bisect.bisect_right(song.tempo_ft, ft) - 1
        return song.tempo_bpm[i] if i >= 0 else 120.0

    scale = rpb * speed / 24.0

    def taud_bpm(b):
        t = round(b * scale)
        if not (25 <= t <= 280):
            vprint(f"  warning: tempo {b:.1f} BPM maps to Taud {t}, "
                   f"clamped to 25..280 (try a different --rpb/--speed)")
        return max(25, min(280, t))

    n_voices = allocate_voices(notes, speed, max_voices)
    if n_voices == 0:
        sys.exit("error: no playable notes")
    vprint(f"  voices: {n_voices} used (cap {max_voices}; NNA carries tails)")

    cells = {}

    # ── Pass 1: triggers ──
    for n in notes:
        row, tick = n.start_ft // speed, n.start_ft % speed
        c = _cell(cells, n.voice, row)
        nv = key_to_noteval(n.key + n.bend0)
        c['note'] = nv
        c['inst'] = n.slot
        c['vol']  = (SEL_SET, round(n.vel * 63 / 127))
        st = song.channels[n.ch]
        if st.cc10_ft:
            pan = _curve_at(st.cc10_ft, st.cc10_val, n.start_ft + shift_ft, 64)
            c['pan'] = (SEL_SET, round(pan * 63 / 127))
        if tick > 0:
            c['eff']  = (TOP_S, 0xD000 | (tick << 8))
            c['prio'] = PRIO_DELAY

    # ── Pass 2: key-offs (both MIDI idioms arrive here as note.end_ft) ──
    skipped_offs = 0
    for n in notes:
        if n.drum and not drum_keyoff:
            continue
        row, tick = n.end_ft // speed, n.end_ft % speed
        srow = n.start_ft // speed
        if row == srow:
            # Sub-row note (shorter than one tracker row): its key-off would land on
            # its OWN trigger row, where the trigger cell already sits — pass 2 would
            # then skip it ("row taken") and the note would ring forever until the next
            # trigger on this voice. Push the key-off to the next row (tick 0) so a
            # staccato note rounds up to ~1 row instead of hanging. If the next row is
            # itself a fresh trigger, that note cuts/NNAs this one anyway (skip is fine).
            row = srow + 1
            tick = 0
        c = cells.get((n.voice, row))
        if c is None:
            c = _cell(cells, n.voice, row)
            c['note'] = NOTE_KEYOFF
            if tick > 0:
                c['eff']  = (TOP_S, 0xD000 | (tick << 8))
                c['prio'] = PRIO_DELAY
        elif c['note'] == NOTE_NOP:
            c['note'] = NOTE_KEYOFF
            if tick > 0 and c['eff'] is None:
                c['eff']  = (TOP_S, 0xD000 | (tick << 8))
                c['prio'] = PRIO_DELAY
        else:
            skipped_offs += 1    # row taken by a retrigger — which cuts/NNAs anyway
    if skipped_offs:
        vprint(f"  info: {skipped_offs} key-off(s) absorbed by same-row retriggers")

    # ── Pass 2b: exclusiveClass chokes (fast note-fade) ──
    # The choked note holds its voice through the choke row (allocate_voices), so the
    # NOTE_FASTFADE lands on it while it is still foreground. The next same-class note
    # plays on a different column, so this never collides with a fresh trigger.
    for n in notes:
        if n.excl_cut_ft is None:
            continue
        srow = n.start_ft // speed
        row, tick = n.excl_cut_ft // speed, n.excl_cut_ft % speed
        if row <= srow:          # choke within the trigger row → round up one row
            row = srow + 1
            tick = 0
        c = cells.get((n.voice, row))
        if c is None:
            c = _cell(cells, n.voice, row)
            c['note'] = NOTE_FASTFADE
            if tick > 0:
                c['eff']  = (TOP_S, 0xD000 | (tick << 8))
                c['prio'] = PRIO_DELAY
        elif c['note'] in (NOTE_NOP, NOTE_KEYOFF):
            c['note'] = NOTE_FASTFADE          # choke supersedes a natural key-off
            if tick > 0 and c['eff'] is None:
                c['eff']  = (TOP_S, 0xD000 | (tick << 8))
                c['prio'] = PRIO_DELAY
        # else: row already holds a fresh trigger — that note cuts/NNAs this one anyway.

    # ── Pass 3: pitch-bend portamento segments ──
    # One linear segment per row: the cell carries the exact 4096-TET target
    # plus G at units/tick sized to land on it by row end (G slides on the
    # speed-1 non-first ticks). Targets within eps_units are skipped (jitter
    # simplification).
    seg_count = 0
    if speed >= 2:
        for n in notes:
            st = song.channels[n.ch]
            if len(st.bend_ft) <= 1 and n.bend0 == 0.0:
                continue
            start_row = n.start_ft // speed
            end_row   = n.end_ft   // speed
            cur = key_to_noteval(n.key + n.bend0)
            for r in range(start_row + 1, end_row):
                ftr = min((r + 1) * speed, n.end_ft) + shift_ft
                target = key_to_noteval(
                    n.key + _curve_at(st.bend_ft, st.bend_val, ftr, 0.0))
                if abs(target - cur) < eps_units:
                    continue
                if (n.voice, r) in cells:
                    continue
                step = -(-abs(target - cur) // (speed - 1))
                c = _cell(cells, n.voice, r)
                c['note'] = target
                c['eff']  = (TOP_G, min(0xFFFF, step))
                c['prio'] = PRIO_PORTA
                cur = target
                seg_count += 1
    elif any(len(st.bend_ft) > 1 for st in song.channels):
        vprint("  warning: --speed 1 cannot express portamento; "
               "pitch-bend movement dropped")
    if seg_count:
        vprint(f"  bend: {seg_count} portamento segment(s) emitted")

    # ── Pass 4: M channel volume (CC7 × CC11), per voice chronologically ──
    by_voice = {}
    for n in notes:
        by_voice.setdefault(n.voice, []).append(n)
    m_emitted = 0
    for v, vnotes in by_voice.items():
        vnotes.sort(key=lambda n: n.start_ft)
        m_state = 0x3F                            # engine channel_vol default
        for n in vnotes:
            st = song.channels[n.ch]
            for r in range(n.start_ft // speed, n.end_ft // speed + 1):
                ftr = r * speed + shift_ft
                m = round(_curve_at(st.cc7_ft,  st.cc7_val,  ftr, 100) / 127
                          * _curve_at(st.cc11_ft, st.cc11_val, ftr, 127) / 127
                          * 63)
                if m == m_state:
                    continue
                c = _cell(cells, v, r)
                if c['eff'] is not None:
                    continue                      # slot busy — retry next row
                c['eff']  = (TOP_M, (m & 0x3F) << 8)
                c['prio'] = PRIO_M
                m_state = m
                m_emitted += 1
    if m_emitted:
        vprint(f"  cc: {m_emitted} M channel-volume effect(s) emitted")

    total_rows = max(r for (_v, r) in cells) + 1

    # ── Pass 5: T tempo changes ──
    bpm0 = midi_bpm_at(shift_ft)                  # tempo in effect at row 0
    last = taud_bpm(bpm0)
    t_emitted = t_evict = 0
    for ft, b in zip(song.tempo_ft, song.tempo_bpm):
        row = (ft - shift_ft) // speed
        if row < 0:
            continue
        if row >= total_rows:
            break
        tb = taud_bpm(b)
        if tb == last:
            continue
        placed = False
        victim = None
        for v in range(n_voices):
            c = cells.get((v, row))
            if c is None or c['eff'] is None:
                c = _cell(cells, v, row)
                c['eff']  = (TOP_T, ((tb - 25) & 0xFF) << 8)
                c['prio'] = PRIO_TEMPO
                placed = True
                break
            if c['prio'] < PRIO_DELAY and (victim is None
                                           or c['prio'] < victim['prio']):
                victim = c
        if not placed and victim is not None:
            if victim['prio'] == PRIO_PORTA:
                victim['note'] = NOTE_NOP         # orphan G note would retrigger
            victim['eff']  = (TOP_T, ((tb - 25) & 0xFF) << 8)
            victim['prio'] = PRIO_TEMPO
            placed = True
            t_evict += 1
        if placed:
            last = tb
            t_emitted += 1
    if t_emitted:
        vprint(f"  tempo: {t_emitted} T effect(s)"
               + (f" ({t_evict} evicted a lesser effect)" if t_evict else ""))

    return cells, n_voices, total_rows, taud_bpm(bpm0)


# ── Pattern / cue emission and final assembly ────────────────────────────────

def plan_cues(timesig_ft: list, timesig: list, total_rows: int,
              shift_ft: int, speed: int, rpb: int) -> tuple:
    """Plan the cue layout: break a cue at every time-signature change, and pack
    each section into whole-bar cues — the largest multiple of the section's bar
    length that fits in 64 rows (so the tracker's bar/beat highlight lines up).

    Returns (cue_starts, cue_lens, init_bar_rows). cue_starts[i] is the absolute
    starting row of cue i; cue_lens[i] is its playable row count (<= 64). A
    constant 4/4 song still yields 64-row (= 4-bar) cues."""
    def timesig_at(row):
        ft = row * speed + shift_ft
        i = bisect.bisect_right(timesig_ft, ft) - 1
        return timesig[i] if i >= 0 else (4, 2)   # MIDI default = 4/4

    def bar_rows_of(sig):
        num, dpow = sig
        bar_quarters = num * 4.0 / (2 ** dpow)    # bar length in quarter notes
        return max(1, round(bar_quarters * rpb))

    breaks = {(ft - shift_ft) // speed for ft in timesig_ft}
    bounds = sorted({0, total_rows} | {r for r in breaks if 0 < r < total_rows})

    cue_starts, cue_lens = [], []
    for bi in range(len(bounds) - 1):
        seg_start, seg_end = bounds[bi], bounds[bi + 1]
        br = bar_rows_of(timesig_at(seg_start))
        cue_max = br * (PATTERN_ROWS // br) if br <= PATTERN_ROWS else PATTERN_ROWS
        r = seg_start
        while r < seg_end:
            length = min(cue_max, seg_end - r)
            cue_starts.append(r)
            cue_lens.append(length)
            r += length
    return cue_starts, cue_lens, bar_rows_of(timesig_at(0))


def build_pattern_bin(cells: dict, n_voices: int,
                      cue_starts: list, cue_lens: list) -> bytes:
    """Pack patterns for cues that may start at arbitrary rows and run fewer
    than 64 rows (bar-aligned / time-signature-broken cues). Rows past a cue's
    length are silent padding (the LEN cue instruction stops playback there)."""
    n_cues = len(cue_starts)
    out = bytearray(n_cues * n_voices * PATTERN_BYTES)
    pos = 0
    for ci, (start, length) in enumerate(zip(cue_starts, cue_lens)):
        for v in range(n_voices):
            for r in range(PATTERN_ROWS):
                base = pos + r * 8
                c = cells.get((v, start + r)) if r < length else None
                if c is None:
                    out[base + 3] = 0xC0
                    out[base + 4] = 0xC0
                    continue
                struct.pack_into('<H', out, base, c['note'] & 0xFFFF)
                out[base + 2] = c['inst'] & 0xFF
                vs, vv = c['vol']
                ps, pv = c['pan']
                out[base + 3] = (vv & 0x3F) | ((vs & 3) << 6)
                out[base + 4] = (pv & 0x3F) | ((ps & 3) << 6)
                if c['eff'] is not None:
                    op, arg = c['eff']
                    out[base + 5] = op & 0xFF
                    struct.pack_into('<H', out, base + 6, arg & 0xFFFF)
            pos += PATTERN_BYTES
    return bytes(out)


def assemble_taud(sf: SF2, song: Song, layer_insts: list, meta_records: list,
                  slot_name: dict, pool: list, args) -> bytes:
    speed, rpb = args.speed, args.rpb

    # Leading-silence trim: shift the grid so the first trigger is row 0.
    first_row = min(n.start_ft // speed for n in song.notes if n.slot > 0)
    shift_ft = first_row * speed
    if shift_ft:
        vprint(f"  info: trimming {first_row} leading silent row(s)")
        for n in song.notes:
            n.start_ft -= shift_ft
            n.end_ft   -= shift_ft
            if n.excl_cut_ft is not None:
                n.excl_cut_ft -= shift_ft

    eps_units = args.bend_epsilon * 4096.0 / 1200.0
    cells, n_voices, total_rows, bpm0 = emit_cells(
        song, None, speed, rpb, eps_units, args.drum_keyoff, shift_ft,
        args.max_voices)

    # Cue layout: break at time-signature changes, pack into whole-bar cues.
    cue_starts, cue_lens, init_bar_rows = plan_cues(
        song.timesig_ft, song.timesig, total_rows, shift_ft, speed, rpb)
    n_cues = len(cue_starts)

    if n_cues > NUM_CUES:
        sys.exit(f"error: song needs {n_cues} cues > {NUM_CUES} limit "
                 f"(try a smaller --rpb)")
    if n_cues * n_voices > NUM_PATTERNS_MAX:
        sys.exit(f"error: {n_cues} cues × {n_voices} voices "
                 f"> {NUM_PATTERNS_MAX} pattern limit")

    pat_bin = build_pattern_bin(cells, n_voices, cue_starts, cue_lens)

    # Trim trailing note-free cues: the MIDI release pass emits a final cue that
    # is just key-offs (and the silence after the song's last note), which shows
    # up as a dead bar at the end (e.g. M_E1M1's lone-key-off terminus cue). Drop
    # whole cues with no actual note; the new last cue then HALTs at its own
    # length. Special notes (key-off/cut/fade) are not notes here.
    last_cue = last_note_cue_index(pat_bin, n_cues, n_voices)
    if 0 <= last_cue < n_cues - 1:
        dropped = n_cues - 1 - last_cue
        n_cues = last_cue + 1
        cue_starts = cue_starts[:n_cues]
        cue_lens   = cue_lens[:n_cues]
        pat_bin    = pat_bin[:n_cues * n_voices * PATTERN_BYTES]
        vprint(f"  info: trimmed {dropped} trailing note-free cue(s)")

    pat_bin, remap, n_unique = deduplicate_patterns(pat_bin, n_cues * n_voices)
    n_breaks = sum(1 for ft in song.timesig_ft
                   if 0 < (ft - shift_ft) // speed < total_rows)
    vprint(f"  patterns: {n_cues * n_voices} → {n_unique} unique; "
           f"{n_cues} cue(s), {n_voices} voice(s), {total_rows} rows"
           + (f"; {n_breaks} time-signature break(s)" if n_breaks > 0 else ""))

    sheet = bytearray(NUM_CUES * CUE_SIZE)
    for ci in range(NUM_CUES):
        sheet[ci*CUE_SIZE:(ci+1)*CUE_SIZE] = encode_cue([], 0)
    for ci in range(n_cues):
        pats = [remap[ci * n_voices + v] for v in range(n_voices)]
        if ci == n_cues - 1:
            # Halt after this cue's own length (a partial final bar plays only its
            # rows instead of the full 64-row pattern).
            instr = cue_instruction_halt_at(cue_lens[ci])
        elif cue_lens[ci] < PATTERN_ROWS:
            instr = cue_instruction_len(cue_lens[ci])
        else:
            instr = CUE_INST_NOP
        sheet[ci*CUE_SIZE:(ci+1)*CUE_SIZE] = encode_cue(pats, instr)

    # ── Sample + instrument bin ──
    sampleinst_raw = build_sample_inst_bin(sf, pool, layer_insts, meta_records,
                                           args.fadeout, bpm0,
                                           force_synth_loop=args.force_synth_loop)
    assert len(sampleinst_raw) == SAMPLEINST_SIZE
    compressed = compress_blob(sampleinst_raw, "sample+inst bin")
    comp_size  = len(compressed)

    pat_comp = compress_blob(pat_bin,      "pattern bin")
    cue_comp = compress_blob(bytes(sheet), "cue sheet")

    song_table_off = TAUD_HEADER_SIZE + comp_size
    song_off       = song_table_off + TAUD_SONG_ENTRY
    entry = encode_song_entry(
        song_offset=song_off,
        num_voices=n_voices,
        num_patterns=n_unique,
        bpm_stored=(bpm0 - 25) & 0xFF,
        tick_rate=speed,
        base_note=0xA000,
        base_freq=8363.0,
        flags_byte=0x00,                          # linear pitch mode
        pat_bin_comp_size=len(pat_comp),
        cue_sheet_comp_size=len(cue_comp),
        global_vol=0xFF,
        mixing_vol=args.mixing_vol,
    )

    # ── Project data: names + the Ixmp section recreating SF2 layering ──
    proj_data = b''
    proj_off  = 0
    if not args.no_project_data:
        # Names indexed by slot (0 = unused). Layer slots carry the (suffixed) layer
        # instrument name; meta slots carry the bare preset name.
        max_slot = max([0] + list(slot_name))
        inst_names = ['' for _ in range(max_slot + 1)]
        for s, nm in slot_name.items():
            inst_names[s] = nm
        smp_names  = [''] + [ms.name for ms in pool]
        ixmp = {}
        for ti in layer_insts:
            if not ti.usable:
                continue
            pl = [p.to_ixmp_dict(ti.canonical, bpm0, args.fadeout)
                  for p in ti.patches if p is not ti.canonical]
            if pl:
                ixmp[ti.slot] = pl
        if ixmp:
            vprint(f"  ixmp: {sum(len(p) for p in ixmp.values())} patch(es) "
                   f"across {len(ixmp)} instrument(s)")
        title = song.title or os.path.splitext(os.path.basename(args.input))[0]
        # sMet beat divisions drive the tracker's row highlighting: primary =
        # rows per NOTATED beat (the time-sig denominator), secondary = rows per
        # bar. Using the denominator beat (not the rpb=rows-per-quarter) keeps the
        # primary highlight a divisor of the bar — e.g. 7/8 → 2 rows (eighth), bar
        # 14: 14 % 2 == 0, aligned; rpb=4 would drift (14 % 4 != 0). 4/4 → 4.
        i = bisect.bisect_right(song.timesig_ft, shift_ft) - 1
        _, init_dpow = song.timesig[i] if i >= 0 else (4, 2)
        beat_pri = max(1, round(rpb * 4 / (2 ** init_dpow)))
        song_meta = [{'index': 0, 'name': title,
                      'notation': 240,    # 24-TET (MIDI is 12-TET but 24 is harmless & cleaner pre-pitchbend transpose notation); 0 = raw/hex display
                      'beat_pri': max(1, min(255, beat_pri)),
                      'beat_sec': max(1, min(255, init_bar_rows))}]
        proj_data = build_project_data(
            project_name=title,
            instrument_names=inst_names,
            sample_names=smp_names,
            song_metadata=song_meta,
            ixmp_patches=ixmp or None,
        )

    header = (TAUD_MAGIC
              + bytes([TAUD_VERSION, 1])
              + struct.pack('<I', comp_size)
              + struct.pack('<I', 0)              # patched below if proj data
              + (SIGNATURE + b' ' * 14)[:14])
    assert len(header) == TAUD_HEADER_SIZE

    out = bytearray()
    out += header
    out += compressed
    out += entry
    out += pat_comp
    out += cue_comp
    if proj_data:
        proj_off = len(out)
        struct.pack_into('<I', out, 14, proj_off)
        out += proj_data
        vprint(f"  project data: {len(proj_data)} bytes @ {proj_off}")
    return bytes(out)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',     help='Input .mid file')
    ap.add_argument('soundfont', help='SoundFont 2 (.sf2) sample library')
    ap.add_argument('output', nargs='?', default=None,
                    help='Output .taud (default: input stem + .taud)')
    ap.add_argument('--perc-force-mapping', nargs=2, type=int, default=None,
                    metavar=('BANK', 'INST'),
                    help='Force the percussion channel to this SF2 preset '
                         '(default: bank 128, channel program)')
    ap.add_argument('--rpb', type=int, default=None, choices=(2, 4, 8, 16),
                    help='Rows per beat (default: auto from time signatures + '
                         'onset analysis). Passing a value pins this axis and '
                         'auto-fits --speed')
    ap.add_argument('--speed', type=int, default=None,
                    help='Ticks per row, 1..15 (default: auto, see --rpb). '
                         'Passing a value pins this axis and auto-fits --rpb')
    ap.add_argument('--fadeout', type=int, default=None,
                    help='Override the computed fadeout step (0..4095). By '
                         'default each instrument/patch gets a Volume Fadeout '
                         'reproducing its SF2 release segment (the full '
                         'releaseVolEnv), played out via NNA Note Fade')
    ap.add_argument('--max-voices', type=int, default=20,
                    help='Voice-column budget, 1..20 (default 20). NNA '
                         'background ghosts carry release/ring tails, so '
                         'few foreground voices are needed; songs exceeding '
                         'the budget release the oldest pedal-held or '
                         'soonest-ending note early')
    ap.add_argument('--max-layers', type=int, default=25,
                    help='Max simultaneous layers per note (default 25). Each SF2 '
                         'preset is split into this many disjoint layers; presets '
                         'needing >1 layer become a Metainstrument. 1 disables '
                         'layering (first-zone-wins, like the old behaviour). '
                         'Covers ~93%% of big-bank presets at 4, ~98%% at 5')
    ap.add_argument('--bend-epsilon', type=float, default=4.0,
                    help='Pitch-bend simplification threshold in cents '
                         '(default 4.0); smaller = more faithful')
    ap.add_argument('--mixingvol', type=int, default=180, dest='mixing_vol',
                    metavar='0..255',
                    help='Song Mixingvol, 0..255 (default 180). Headroom for '
                         'the summed polyphony before the final mix clips')
    ap.add_argument('--drum-keyoff', action='store_true',
                    help='Emit KEY_OFF for percussion-channel notes too '
                         '(GM drums normally ignore note-off)')
    ap.add_argument('--force-synth-loop', action='store_true',
                    help='For looped samples whose loop sits past the 65535-frame '
                         'cap even at 32 kHz (multi-second far-loop instruments, '
                         'e.g. Timbres of Heaven): replace the real loop with a '
                         'synthesized one at 32 kHz + a 10 s decay, instead of '
                         'muffling the whole sample down to fit. Trades the genuine '
                         'sustain loop for full bandwidth')
    ap.add_argument('--no-project-data', action='store_true',
                    help='Omit the Project Data section — NOTE: this also '
                         'omits Ixmp, collapsing every instrument to its '
                         'canonical sample')
    ap.add_argument('-v', '--verbose', action='store_true')
    args = ap.parse_args()
    set_verbose(args.verbose)

    if args.speed is not None and not (1 <= args.speed <= 15):
        sys.exit("error: --speed must be 1..15")
    if not (1 <= args.max_voices <= 20):
        sys.exit("error: --max-voices must be 1..20")
    if not (1 <= args.max_layers <= 25):
        sys.exit("error: --max-layers must be 1..25")
    if not (0 <= args.mixing_vol <= 255):
        sys.exit("error: --mixingvol must be 0..255")
    if args.output is None:
        args.output = os.path.splitext(args.input)[0] + '.taud'

    vprint(f"parsing MIDI '{args.input}'…")
    division, merged = parse_midi(args.input)

    # Resolve the Taud grid (Tickspeed + RPB) before mapping ticks to fine-ticks.
    # A pinned --rpb/--speed fixes that axis; the rest is auto-fit.
    args.rpb, args.speed, timing_info = auto_timing(
        division, merged, args.rpb, args.speed, args.max_voices)
    vprint(f"  timing: rpb {args.rpb}, speed {args.speed} ({timing_info})")

    song = extract_song(division, merged, args.rpb, args.speed)
    vprint(f"  {len(song.notes)} note(s), {len(song.tempo_ft)} tempo event(s), "
           f"{len(song.timesig_ft)} time-signature event(s)")
    if not song.notes:
        sys.exit("error: MIDI contains no playable notes")

    vprint(f"parsing SF2 '{args.soundfont}'…")
    sf = parse_sf2(args.soundfont)
    vprint(f"  {len(sf.presets)} preset(s), {len(sf.shdrs)} sample header(s)")

    # SF2 exclusiveClass percussion choking (closed hi-hat silences open hi-hat, etc.).
    apply_exclusive_class(song, sf, args.perc_force_mapping)

    # Presets in first-use order; triggers keyed by the exact (noteVal-with-initial-
    # bend, vol6) pair the patterns will carry, so layer trimming sees precisely what
    # the engine matches at runtime.
    slot_keys = []
    seen_keys = set()
    triggers  = {}
    for n in song.notes:
        if n.inst_key not in seen_keys:
            seen_keys.add(n.inst_key)
            slot_keys.append(n.inst_key)
        t = triggers.setdefault(n.inst_key, {})
        k = (key_to_noteval(n.key + n.bend0), round(n.vel * 63 / 127))
        t[k] = t.get(k, 0) + 1
    vprint(f"  {len(slot_keys)} preset(s) in use")

    registry = {}
    presets = build_presets(sf, slot_keys, triggers, args.perc_force_mapping,
                            registry, args.max_layers)

    # Allocate instrument-bin slots: each layer is a normal instrument; a preset with
    # >1 layer also takes a Metainstrument slot the note references. Single-layer
    # presets stay plain instruments (no meta, no extra slot).
    next_slot   = 1
    layer_insts = []      # all normal instruments, .slot assigned
    meta_records = []     # (meta_slot, name, [(layer_slot, bbox_rect)])
    slot_name   = {}      # slot → display name
    note_slot   = {}      # inst_key → slot a note triggers (0 = unplayable)
    for ik in slot_keys:
        name, layers = presets[ik]
        if not layers:
            note_slot[ik] = 0
            continue
        need = len(layers) + (1 if len(layers) > 1 else 0)
        if next_slot + need - 1 > 255:
            vprint(f"  warning: 255-slot budget exhausted — preset '{name}' dropped")
            note_slot[ik] = 0
            continue
        for li, ti in enumerate(layers):
            ti.slot = next_slot; next_slot += 1
            layer_insts.append(ti)
            slot_name[ti.slot] = name if len(layers) == 1 else f"{name} L{li}"
        if len(layers) == 1:
            note_slot[ik] = layers[0].slot
        else:
            meta_slot = next_slot; next_slot += 1
            meta_records.append((meta_slot, name,
                                 [(ti.slot, _layer_bbox(ti)) for ti in layers]))
            slot_name[meta_slot] = name
            note_slot[ik] = meta_slot
    vprint(f"  slots: {next_slot - 1} used — {len(layer_insts)} instrument(s), "
           f"{len(meta_records)} Metainstrument(s)")

    # Tag notes with their trigger slot; notes whose preset failed to resolve drop.
    unplayable = 0
    for n in song.notes:
        n.slot = note_slot.get(n.inst_key, 0)
        if n.slot == 0:
            unplayable += 1
    if unplayable:
        vprint(f"  warning: {unplayable} note(s) dropped (unresolvable preset)")
    song.notes = [n for n in song.notes if n.slot > 0]
    if not song.notes:
        sys.exit("error: no notes survived preset resolution")

    # Pool = every sample referenced by a kept patch (canonical included), in
    # deterministic first-reference order. Everything else is trimmed.
    pool = []
    seen = set()
    for ti in layer_insts:
        for p in ti.patches:
            if id(p.ms) not in seen:
                seen.add(id(p.ms))
                pool.append(p.ms)

    taud = assemble_taud(sf, song, layer_insts, meta_records, slot_name, pool, args)
    sf.file.close()

    with open(args.output, 'wb') as f:
        f.write(taud)
    print(f"wrote {len(taud)} bytes to '{args.output}'")


if __name__ == '__main__':
    main()
