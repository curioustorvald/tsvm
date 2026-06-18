#!/usr/bin/env python3
"""
taud_inspect.py — pretty-printer / debugger for Taud (.taud / .tsii / .tpif) files.

Parses the Taud serialisation format (terranmon.txt §"Taud serialisation format",
§"Audio Adapter", TAUD_NOTE_EFFECTS.md) and dumps:

  * DETAILED  — every sample + instrument: base sample fields, all four envelopes
                (vol / pan / pitch / filter, both pf-env slots routed by their
                m-bit), the full instrument record, Ixmp extra-sample patches with
                their pitch×volume assignment rectangles and per-patch
                envelopes/extra-base blocks, and Metainstrument layering (per-layer
                rectangle, mix-dB, detune).
  * BRIEF     — song table, pattern/cue overview, project-data metadata
                (names, author, copyright, message, per-song metadata, notations).

Usage:
  python3 taud_inspect.py FILE.taud [options]

Options:
  --song N            Which song to summarise patterns/cues for (default: all).
  --inst N            Restrict instrument detail to slot N (decimal or 0x..).
  --no-instruments    Skip the (verbose) instrument/sample section.
  --samples           Include raw PCM stats (peak/RMS) for each sample region.
  --pattern P         Dump every non-empty row of pattern P (decimal or 0x..).
  --cues              Dump the full cue/order list for the selected song(s).
  --cue C             Dump one cue's voice→pattern map (decimal or 0x..).
  --max-cues N        Limit the cue overview to the first N cues (default 64).

Container kinds (top two bits of the version byte):
  00 full .taud   — sample+inst image + song table + patterns
  10 .tsii        — sample+inst image only (numSongs == 0)
  11 .tpif        — patterns only (sample+inst section absent)
"""

import argparse
import gzip
import struct
import sys

try:
    import zstandard as zstd
except ImportError:
    zstd = None


# ── compression ──────────────────────────────────────────────────────────────

def decomp(b):
    """Auto-detect zstd / gzip by 4-byte magic and decompress (terranmon §File Structure)."""
    if b[:4] == bytes([0x28, 0xB5, 0x2F, 0xFD]):
        if zstd is None:
            raise RuntimeError("zstd blob but the 'zstandard' module is not installed")
        return zstd.ZstdDecompressor().decompress(b, max_output_size=64 * 1024 * 1024)
    if b[:2] == bytes([0x1F, 0x8B]):
        return gzip.decompress(b)
    raise ValueError("unknown compression magic %r" % (b[:4],))


# ── little-endian readers ────────────────────────────────────────────────────

def u8(d, o):  return d[o]
def s8(d, o):  return d[o] - 256 if d[o] >= 128 else d[o]
def u16(d, o): return struct.unpack_from('<H', d, o)[0]
def s16(d, o): return struct.unpack_from('<h', d, o)[0]
def u24(d, o): return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)
def u32(d, o): return struct.unpack_from('<I', d, o)[0]


# ── unit conversions ─────────────────────────────────────────────────────────

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# 4096-TET: octave = 4096 units; C at octave 0 = 0x1000 (terranmon.txt §Play Data).
# noteVal * 12 / 4096 gives a MIDI-style semitone index (C4 = 0x5000 -> 60).
def note_name(nv):
    midi = nv * 12.0 / 4096.0
    n = round(midi)
    cents = (midi - n) * 100.0
    idx = n % 12
    octv = n // 12 - 1
    s = "%s%d" % (NOTE_NAMES[idx], octv)
    if abs(cents) >= 1.0:
        s += "%+dc" % round(cents)
    return s

# Pattern-cell note sentinels (terranmon.txt §Play Data "Special values").
def cell_note(nv):
    if nv == 0x0000: return "---"        # no-op
    if nv == 0x0001: return "===OFF"     # key-off
    if nv == 0x0002: return "^^^CUT"     # note cut
    if nv == 0x0003: return "~~~FADE"    # note fade
    if nv == 0x0004: return "vvvFAST"    # fast fade
    if 0x0010 <= nv <= 0x001F: return "Int%X" % (nv - 0x10)
    if nv < 0x0020: return "?%04X" % nv  # reserved
    return "%s($%04X)" % (note_name(nv), nv)


# 3.5 unsigned minifloat, rebiased 2026-05-07: smallest step 1/256 s, max 15.75 s
# (terranmon.txt §"Table of 3.5 Minifloat values"). High 3 bits = exponent,
# low 5 bits = mantissa. exp 0 is the denormal range.
def minifloat35(b):
    exp = (b >> 5) & 0x07
    man = b & 0x1F
    if exp == 0:
        return man / 256.0
    return (2 ** (exp - 1)) * (32 + man) / 256.0


# "Perceptually Significant Octet to Decibel Table" (terranmon.txt). 159 = 0 dB.
def octet_to_db(o):
    if o <= 0:
        return float('-inf')
    db = 0.0
    if o >= 159:
        for x in range(160, o + 1):
            db += 0.125 if x <= 207 else (0.25 if x <= 231 else 0.5)
    else:
        for x in range(158, o - 1, -1):
            db -= 0.125 if x >= 111 else (0.25 if x >= 87 else (0.5 if x >= 63 else 1.0))
    return db

def db_str(o):
    d = octet_to_db(o)
    if d == float('-inf'):
        return "-inf dB (silent)"
    return "%+.3g dB" % d


# Fadeout field semantics (terranmon.txt instrument byte 172-173).
def fadeout_str(v):
    if v == 0:
        return "0 (no fade)"
    if v >= 1024:
        return "%d (1-tick cut)" % v
    # graduated fade: completes in 1024/v ticks
    return "%d (~%d ticks; %.1f s @ 50 Hz)" % (v, round(1024 / v), (1024 / v) / 50.0)


# ── envelope decode ──────────────────────────────────────────────────────────

def parse_env_word_loop(w):
    """LOOP word 0b 00P_sssss_Xcb_eeeee (terranmon §instrument 15/17/19/197)."""
    return {
        'end':   w & 0x1F,
        'b':     (w >> 5) & 1,    # enable loop wrap
        'c':     (w >> 6) & 1,    # carry
        'bit7':  (w >> 7) & 1,    # pan: use-default-pan; pf: m (0=pitch,1=filter)
        'start': (w >> 8) & 0x1F,
        'P':     (w >> 13) & 1,   # envelope present
        'raw':   w,
    }

def parse_env_word_sustain(w):
    """SUSTAIN word 0b 000_sssss_00b_eeeee (terranmon §instrument 189/191/193/199)."""
    return {'end': w & 0x1F, 'b': (w >> 5) & 1, 'start': (w >> 8) & 0x1F, 'raw': w}

def parse_env_nodes(d, off):
    """25 nodes of (value, time-minifloat). Returns (nodes, authored_last_index).

    The encoder pads unused slots by repeating the last authored node's VALUE with
    time 0 (taud_common._encode_env_block). The authored portion therefore ends at
    the last index before that trailing constant-value, zero-time pad run. NOTE: a
    zero-time node is NOT necessarily a terminator — for pitch/filter envelopes it is
    an instant transition the engine skips (advancePfRole); only the final authored
    node holds. So we trim the pad run rather than stopping at the first zero-time."""
    nodes = []
    for i in range(25):
        val = d[off + i * 2]
        mf = d[off + i * 2 + 1]
        nodes.append((val, mf, minifloat35(mf)))
    last = 24
    while last > 0 and nodes[last][1] == 0 and nodes[last][0] == nodes[last - 1][0]:
        last -= 1
    return nodes, last


def fmt_env(loop, sus, nodes, term, role, valfmt=lambda v: "%3d" % v):
    """Pretty multi-line envelope description."""
    out = []
    flags = []
    if loop['P']:
        flags.append("PRESENT")
    else:
        flags.append("absent(P=0)")
    if loop['b']:
        flags.append("loop[%d..%d]" % (loop['start'], loop['end']))
    if loop['c']:
        flags.append("carry")
    if sus['b']:
        if sus['start'] == sus['end']:
            flags.append("sustain-point@%d" % sus['start'])
        else:
            flags.append("sustain-loop[%d..%d]" % (sus['start'], sus['end']))
    out.append("%-14s %s" % (role + ":", "  ".join(flags)))
    if not loop['P']:
        return "\n".join(out)   # absent envelope: node array is ignored by the engine
    # show authored nodes up to the last authored index (or the furthest wrap index)
    last = max(term, loop['end'] if loop['b'] else 0, sus['end'] if sus['b'] else 0)
    last = min(last, 24)
    parts = []
    cum = 0.0
    for i in range(last + 1):
        val, mf, sec = nodes[i]
        cum += sec
        tag = ""
        if i == term:
            tag = "H"            # final authored node: holds here if no active wrap
        elif mf == 0:
            tag = "!"            # zero-duration: instant jump (skipped for pitch/filter)
        parts.append("[%d]%s@%.3fs%s" % (i, valfmt(val), cum, ("(" + tag + ")") if tag else ""))
    pad = 25 - (last + 1)
    line = "                 " + " ".join(parts)
    if pad > 0:
        line += "  (+%d pad)" % pad
    out.append(line)
    return "\n".join(out)


# ── instrument record decode ─────────────────────────────────────────────────

NNA_NAMES = {0: "Note Off", 1: "Note Cut", 2: "Continue", 3: "Note Fade"}
VIBWAVE = {0: "sine", 1: "ramp-down", 2: "square", 3: "random", 4: "ramp-up"}
LOOPMODE = {0: "no loop", 1: "loop", 2: "ping-pong", 3: "oneshot"}
DCT_NAMES = {0: "off", 1: "note", 2: "sample", 3: "instrument"}
DCA_NAMES = {0: "note cut", 1: "note off", 2: "note fade"}


def is_meta(rec):
    return (u32(rec, 0) >> 16) == 0xFFFF


def parse_meta(rec):
    """Metainstrument: bytes 0..3 alias the sample pointer (0xFFFF_ll_tt)."""
    typ = rec[0]
    count = rec[1]
    layers = []
    for i in range(count):
        o = 4 + i * 10
        if o + 10 > 256:
            break
        layers.append({
            'inst':       rec[o],
            'mixvol':     rec[o + 1],
            'detune':     s16(rec, o + 2),
            'pitch_start': u16(rec, o + 4),
            'pitch_end':  u16(rec, o + 6),
            'vol_start':  rec[o + 8],
            'vol_end':    rec[o + 9],
        })
    return {'type': typ >> 1, 'strict': typ & 1, 'count': count, 'layers': layers}


def parse_instrument(rec):
    """Decode a 256-byte normal instrument record into a dict."""
    sf_mode = (rec[173] >> 4) & 1   # filter interpretation mode (m bit)
    fadeout = rec[172] | ((rec[173] & 0x0F) << 8)
    flag = rec[186]
    inst = {
        'sample_ptr':   u32(rec, 0),
        'sample_len':   u16(rec, 4),
        'rate':         u16(rec, 6),
        'play_start':   u16(rec, 8),
        'loop_start':   u16(rec, 10),
        'loop_end':     u16(rec, 12),
        'loop_mode':    rec[14] & 0x03,
        'loop_sustain': (rec[14] >> 2) & 1,
        'igv':          rec[171],
        'fadeout':      fadeout,
        'sf_filter':    sf_mode,
        'vol_swing':    rec[174],
        'vib_speed':    rec[175],
        'vib_sweep':    rec[176],
        'default_pan':  rec[177],
        'ppc':          u16(rec, 178),
        'pps':          s8(rec, 180),
        'pan_swing':    rec[181],
        'detune':       s16(rec, 184),
        'nna':          flag & 0x03,
        'vib_wave':     (flag >> 2) & 0x07,
        'key_lift':     (flag >> 5) & 1,
        'vib_depth':    rec[187],
        'vib_rate':     rec[188],
        'dct':          rec[195] & 0x03,
        'dca':          (rec[195] >> 2) & 0x03,
        'default_note_vol': rec[196],
        'init_atten':   rec[251],
    }
    if sf_mode:
        inst['cutoff'] = (rec[182] << 8) | rec[252]      # absolute cents
        inst['resonance'] = (rec[183] << 8) | rec[253]   # centibels
    else:
        inst['cutoff'] = rec[182]      # IT 0..254 / 255=off
        inst['resonance'] = rec[183]

    # envelopes
    inst['vol_env'] = (parse_env_word_loop(u16(rec, 15)),
                       parse_env_word_sustain(u16(rec, 189)),
                       *parse_env_nodes(rec, 21))
    inst['pan_env'] = (parse_env_word_loop(u16(rec, 17)),
                       parse_env_word_sustain(u16(rec, 191)),
                       *parse_env_nodes(rec, 71))
    inst['pf1'] = (parse_env_word_loop(u16(rec, 19)),
                   parse_env_word_sustain(u16(rec, 193)),
                   *parse_env_nodes(rec, 121))
    inst['pf2'] = (parse_env_word_loop(u16(rec, 197)),
                   parse_env_word_sustain(u16(rec, 199)),
                   *parse_env_nodes(rec, 201))
    return inst


# ── Ixmp patch decode ────────────────────────────────────────────────────────

IXMP_VER_I, IXMP_VER_V, IXMP_VER_P, IXMP_VER_F, IXMP_VER_PITCH, IXMP_VER_X = \
    0x01, 0x02, 0x04, 0x08, 0x10, 0x80


def parse_ixmp_patch(d, o, end):
    """Decode one variable-length Ixmp patch. Returns (patch_dict, next_offset)."""
    ver = d[o]
    common = struct.unpack_from('<BHHBBIHHHHHhBBBBBBBB', d, o)
    p = {
        'ver': ver,
        'pitch_start': common[1], 'pitch_end': common[2],
        'vol_start': common[3], 'vol_end': common[4],
        'sample_ptr': common[5], 'sample_len': common[6],
        'play_start': common[7], 'loop_start': common[8], 'loop_end': common[9],
        'rate': common[10], 'detune': common[11],
        'loop_mode': common[12] & 0x03, 'loop_sustain': (common[12] >> 2) & 1,
        'default_pan': common[13], 'default_note_vol': common[14],
        'vib_speed': common[15], 'vib_sweep': common[16],
        'vib_depth': common[17], 'vib_rate': common[18], 'vib_wave': common[19],
    }
    q = o + 31
    if ver & IXMP_VER_X:
        flags1 = u32(d, q)
        flags2 = u32(d, q + 4)
        p['x'] = {
            'sf_filter': flags1 & 1,
            'flags1': flags1, 'flags2': flags2,
            'fadeout': u16(d, q + 8),
            'cutoff': u16(d, q + 10),
            'resonance': u16(d, q + 12),
            'init_atten': d[q + 14],
        }
        q += 15
    for key, bit in (('vol_env', IXMP_VER_V), ('pan_env', IXMP_VER_P),
                     ('filter_env', IXMP_VER_F), ('pitch_env', IXMP_VER_PITCH)):
        if ver & bit:
            loop = parse_env_word_loop(u16(d, q))
            sus = parse_env_word_sustain(u16(d, q + 2))
            nodes, term = parse_env_nodes(d, q + 4)
            p[key] = (loop, sus, nodes, term)
            q += 54
    return p, q


def parse_ixmp_section(payload):
    """One Ixmp project-data section payload -> {instId: [patch,...]}."""
    res = {}
    q = 0
    end = len(payload)
    while q + 4 <= end:
        inst_id = payload[q]
        cnt = u24(payload, q + 1)
        q += 4
        patches = []
        ok = True
        for _ in range(cnt):
            if q + 31 > end:
                ok = False
                break
            patch, nq = parse_ixmp_patch(payload, q, end)
            if nq > end:
                ok = False
                break
            patches.append(patch)
            q = nq
        res.setdefault(inst_id, []).extend(patches)
        if not ok:
            break
    return res


# ── project data ─────────────────────────────────────────────────────────────

PROJ_MAGIC = bytes([0x1E, 0x54, 0x61, 0x75, 0x64, 0x50, 0x72, 0x4A])  # \x1ETaudPrJ


def split_names(blob):
    """0x1E-separated string table (INam / SNam / pNam)."""
    if not blob:
        return []
    return [s.decode('utf-8', 'replace') for s in blob.split(b'\x1E')]


def parse_project_data(data, proj_off):
    """Walk FourCC sections. Returns dict of {fourcc: [payload,...]} plus parsed extras."""
    sections = {}
    if proj_off == 0 or proj_off + 16 > len(data):
        return sections
    if data[proj_off:proj_off + 8] != PROJ_MAGIC:
        return sections
    p = proj_off + 16
    while p + 8 <= len(data):
        fourcc = data[p:p + 4].decode('latin-1')
        seclen = u32(data, p + 4)
        payload = data[p + 8:p + 8 + seclen]
        if p + 8 + seclen > len(data):
            break
        sections.setdefault(fourcc, []).append(payload)
        p += 8 + seclen
    return sections


def parse_smet(payload):
    """sMet — per-song metadata (terranmon §Project Data sMet)."""
    songs = []
    p = 0
    n = len(payload)
    while p + 5 <= n:
        idx = payload[p]
        size = u32(payload, p + 1)
        body = payload[p + 5:p + 5 + size]
        p += 5 + size
        notation = u16(body, 0) if len(body) >= 2 else 0
        beat_pri = body[2] if len(body) >= 3 else 0
        beat_sec = body[3] if len(body) >= 4 else 0
        # three null-terminated UTF-8 strings: name, composer, copyright
        rest = body[4:]
        strs = rest.split(b'\x00')
        name = strs[0].decode('utf-8', 'replace') if len(strs) > 0 else ''
        comp = strs[1].decode('utf-8', 'replace') if len(strs) > 1 else ''
        copyr = strs[2].decode('utf-8', 'replace') if len(strs) > 2 else ''
        songs.append({'idx': idx, 'notation': notation, 'beat_pri': beat_pri,
                      'beat_sec': beat_sec, 'name': name, 'composer': comp,
                      'copyright': copyr})
    return songs


# ── pattern / cue decode ─────────────────────────────────────────────────────

PATTERN_SIZE = 512
CUE_SIZE = 32

EFFECT_NAMES = {
    '0': "arpeggio", '1': "global-behaviour", '5': "filter cutoff",
    '6': "resonance", '7': "pattern ditto", '8': "bitcrusher", '9': "overdrive",
    'A': "set speed", 'B': "jump to cue", 'C': "break to row", 'D': "vol slide",
    'E': "pitch down", 'F': "pitch up", 'G': "tone porta", 'H': "vibrato",
    'I': "tremor", 'J': "arpeggio(micro)", 'K': "vib+volslide", 'L': "porta+volslide",
    'M': "set chan vol", 'N': "chan vol slide", 'O': "sample offset",
    'P': "chan pan slide", 'Q': "retrigger", 'R': "tremolo", 'S': "special",
    'T': "tempo", 'U': "fine vibrato", 'V': "set global vol", 'W': "global vol slide",
    'X': "fine set pan", 'Y': "panbrello",
}

SEL_NAMES = {0: "set", 1: "up", 2: "dn", 3: "fine"}

# S $Xy.. subcommands (TAUD_NOTE_EFFECTS.md §S).
S_SUB = {
    0x1: "glissando", 0x2: "finetune", 0x3: "vib-wave", 0x4: "trem-wave",
    0x5: "panb-wave", 0x6: "fine-pat-delay", 0x7: "note/inst action",
    0x8: "set-pan", 0xB: "pattern-loop", 0xC: "note-cut", 0xD: "note-delay",
    0xE: "pattern-delay", 0xF: "funk-repeat",
}


def describe_effect(sym, arg):
    """Human-readable note for one effect cell."""
    if sym == 'S':
        sub = (arg >> 12) & 0xF
        if sub == 0x8:
            return "set pan = $%02X" % (arg & 0xFF)
        if sub == 0xF:
            return "funk-repeat $%03X" % (arg & 0xFFF)
        return "%s %d" % (S_SUB.get(sub, "S?"), (arg >> 8) & 0xF)
    return EFFECT_NAMES.get(sym, "")


def op_symbol(op):
    if op < 10:
        return str(op)
    if op <= 35:
        return chr(55 + op)   # 10 -> 'A'
    return "?%02X" % op


def vol_col(b):
    sel = b >> 6
    val = b & 0x3F
    if sel == 3 and val == 0:
        return "--"        # no-op (3.00)
    return "%s%02X" % (SEL_NAMES[sel][0], val)


def cue_patterns(cue_bin, ci):
    """Decode one cue's 20 voice→pattern numbers + instruction bytes."""
    e = cue_bin[ci * 32:ci * 32 + 32]
    pats = []
    for v in range(20):
        bi = v // 2
        if v % 2 == 0:
            lo = (e[bi] >> 4) & 0xF
            mi = (e[10 + bi] >> 4) & 0xF
            hi = (e[20 + bi] >> 4) & 0xF
        else:
            lo = e[bi] & 0xF
            mi = e[10 + bi] & 0xF
            hi = e[20 + bi] & 0xF
        pats.append((hi << 8) | (mi << 4) | lo)
    return pats, e[30], e[31]


def cue_instruction(b30, b31):
    """Decode cue instruction bytes (terranmon §Cue Sheet 32768..)."""
    if b30 == 0 and b31 == 0:
        return None
    hi = b30 & 0xF0
    if hi == 0x80:
        return "BACK %d" % (((b30 & 0xF) << 8) | b31)
    if hi == 0x90:
        return "FWD %d" % (((b30 & 0xF) << 8) | b31)
    if hi == 0xF0:
        return "JMP -> pat %d" % (((b30 & 0xF) << 8) | b31)
    if b30 == 0x02:
        return "LEN %d rows" % ((b31 & 0x3F) + 1)
    if b30 == 0x01:
        if (b31 & 0xC0) == 0x40:
            return "HALT @ row %d" % (b31 & 0x3F)
        if (b31 & 0x3F) == 0:
            return "HALT"
        return "FADE -> row %d" % (b31 & 0x3F)
    return "?%02X%02X" % (b30, b31)


# ── output helpers ───────────────────────────────────────────────────────────

def hr(title=""):
    if title:
        return "\n" + "=" * 78 + "\n  " + title + "\n" + "=" * 78
    return "=" * 78

def sub(title):
    return "\n" + "-" * 78 + "\n  " + title + "\n" + "-" * 78


# ── sample stats ─────────────────────────────────────────────────────────────

def sample_stats(samplebin, ptr, length):
    """Raw PCM stats. Samples are 8-bit unsigned, centre 128 (terranmon §Sound Hardware)."""
    if length <= 0 or ptr + length > len(samplebin):
        return None
    peak = 0
    acc = 0.0
    nonsilent = 0
    for i in range(ptr, ptr + length):
        dev = samplebin[i] - 128
        a = abs(dev)
        if a > peak:
            peak = a
        if a > 1:
            nonsilent += 1
        acc += dev * dev
    rms = (acc / length) ** 0.5
    return {'peak': peak, 'rms': rms, 'nonsilent': nonsilent}


# ── main inspection ──────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Inspect / debug Taud (.taud/.tsii/.tpif) files.")
    ap.add_argument("file")
    ap.add_argument("--song", type=int, default=None, help="only summarise this song's patterns/cues")
    ap.add_argument("--inst", type=lambda x: int(x, 0), default=None, help="restrict instrument detail to slot N")
    ap.add_argument("--no-instruments", action="store_true")
    ap.add_argument("--samples", action="store_true", help="include raw PCM stats per sample region")
    ap.add_argument("--pattern", type=lambda x: int(x, 0), default=None, help="dump rows of pattern P")
    ap.add_argument("--cues", action="store_true", help="dump cue order list")
    ap.add_argument("--cue", type=lambda x: int(x, 0), default=None, help="dump one cue's voice->pattern map")
    ap.add_argument("--max-cues", type=int, default=64)
    args = ap.parse_args()

    data = open(args.file, 'rb').read()
    if data[:8] != bytes([0x1F, 0x54, 0x53, 0x56, 0x4D, 0x61, 0x75, 0x64]):
        sys.exit("not a Taud file (bad magic)")

    version = data[8]
    num_songs = data[9]
    comp_size = u32(data, 10)
    proj_off = u32(data, 14)
    signature = data[18:32].decode('latin-1').rstrip(' \x00')

    kind = version & 0xC0
    kind_name = {0x00: "full .taud", 0x80: ".tsii (sample+inst only)",
                 0xC0: ".tpif (patterns only)"}.get(kind, "unknown")
    base_ver = version & 0x3F

    print(hr("CONTAINER"))
    print("file               : %s (%d bytes)" % (args.file, len(data)))
    print("kind               : %s" % kind_name)
    print("format version     : %d (version byte 0x%02X)" % (base_ver, version))
    print("songs              : %d" % num_songs)
    print("sample+inst comp   : %d bytes" % comp_size)
    print("project data offset: %s" % ("%d" % proj_off if proj_off else "0 (none)"))
    print("tracker signature  : %r" % signature)

    # -- project data (parse first; names feed the instrument/song sections) ----
    sections = parse_project_data(data, proj_off)
    inam = split_names(sections['INam'][0]) if 'INam' in sections else []
    snam = split_names(sections['SNam'][0]) if 'SNam' in sections else []
    pnam = split_names(sections['pNam'][0]) if 'pNam' in sections else []
    ixmp_by_inst = {}
    for payload in sections.get('Ixmp', []):
        for k, v in parse_ixmp_section(payload).items():
            ixmp_by_inst.setdefault(k, []).extend(v)
    smet = parse_smet(sections['sMet'][0]) if 'sMet' in sections else []

    def inst_name(i):
        return inam[i] if i < len(inam) and inam[i] else ""

    # -- sample + instrument bin ------------------------------------------------
    samplebin = None
    instbin = None
    if kind != 0xC0 and comp_size > 0:
        blob = decomp(data[32:32 + comp_size])
        SAMPLE_SIZE = 8 * 1024 * 1024
        samplebin = blob[:SAMPLE_SIZE]
        instbin = blob[SAMPLE_SIZE:SAMPLE_SIZE + 65536]

    if instbin is not None and not args.no_instruments:
        print(hr("SAMPLES & INSTRUMENTS"))
        present = []
        for i in range(256):
            rec = instbin[i * 256:i * 256 + 256]
            has_ixmp = i in ixmp_by_inst
            if is_meta(rec):
                present.append(i)
            elif u32(rec, 0) != 0 or u16(rec, 4) != 0 or has_ixmp or inst_name(i):
                present.append(i)
        if args.inst is not None:
            present = [i for i in present if i == args.inst]
        print("present instruments: %d  %s" % (len(present),
              "(filtered to slot %d)" % args.inst if args.inst is not None else ""))

        # sample-bin high-water mark
        hi = 0
        for i in range(256):
            rec = instbin[i * 256:i * 256 + 256]
            if not is_meta(rec):
                hi = max(hi, u32(rec, 0) + u16(rec, 4))
        for plist in ixmp_by_inst.values():
            for p in plist:
                hi = max(hi, p['sample_ptr'] + p['sample_len'])
        print("sample-bin used    : up to %d bytes (0x%X) of 8 MB pool" % (hi, hi))

        for i in present:
            rec = instbin[i * 256:i * 256 + 256]
            nm = inst_name(i)
            print(sub("INSTRUMENT %d (0x%02X)%s" % (i, i, ("  \"%s\"" % nm) if nm else "")))

            if is_meta(rec):
                m = parse_meta(rec)
                print("  METAINSTRUMENT  type=%d  strict-layering=%s  layers=%d"
                      % (m['type'], "yes" if m['strict'] else "no (legacy)", m['count']))
                print("  %-3s %-26s %-9s %-7s %-26s %s"
                      % ("#", "layer instrument", "mix", "detune", "pitch range", "vol range"))
                for li, L in enumerate(m['layers']):
                    lnm = inst_name(L['inst'])
                    label = "inst %d%s" % (L['inst'], ('  "%s"' % lnm) if lnm else "")
                    pr = "%s..%s" % (note_name(L['pitch_start']), note_name(L['pitch_end']))
                    mix = octet_to_db(L['mixvol'])
                    mixs = "-inf" if mix == float('-inf') else "%+.3gdB" % mix
                    print("  %-3d %-26s %-9s %+6d  %-26s %d..%d"
                          % (li, label[:26], mixs, L['detune'], pr,
                             L['vol_start'], L['vol_end']))
                continue

            inst = parse_instrument(rec)
            print("  BASE SAMPLE")
            print("    pointer=0x%06X  length=%d  rate@C4=%d Hz"
                  % (inst['sample_ptr'], inst['sample_len'], inst['rate']))
            print("    play_start=%d  loop=%d..%d  loop_mode=%s%s"
                  % (inst['play_start'], inst['loop_start'], inst['loop_end'],
                     LOOPMODE[inst['loop_mode']],
                     "  (sustain-loop)" if inst['loop_sustain'] else ""))
            if inst['detune']:
                print("    sample detune=%+d (4096-TET units)" % inst['detune'])
            if args.samples and samplebin is not None:
                st = sample_stats(samplebin, inst['sample_ptr'], inst['sample_len'])
                if st:
                    print("    pcm: peak=%d/128  rms=%.1f  non-silent=%d/%d"
                          % (st['peak'], st['rms'], st['nonsilent'], inst['sample_len']))

            print("  INSTRUMENT")
            print("    global volume=%d  default note vol=%d(->%d/63)  init atten=%s"
                  % (inst['igv'], inst['default_note_vol'],
                     round(inst['default_note_vol'] * 63 / 255),
                     db_str(inst['init_atten']) if inst['init_atten'] else "unity(0)"))
            print("    fadeout=%s" % fadeout_str(inst['fadeout']))
            print("    NNA=%s  key-lift=%s  DCT=%s  DCA=%s"
                  % (NNA_NAMES[inst['nna']], "yes" if inst['key_lift'] else "no",
                     DCT_NAMES[inst['dct']], DCA_NAMES[inst['dca']]))
            print("    default pan=%d  pitch-pan centre=%s sep=%+d  swing(vol/pan)=%d/%d"
                  % (inst['default_pan'], note_name(inst['ppc']), inst['pps'],
                     inst['vol_swing'], inst['pan_swing']))
            if inst['sf_filter']:
                print("    filter(SF mode): cutoff=%d cents  resonance=%d cB"
                      % (inst['cutoff'], inst['resonance']))
            else:
                cu = "off" if inst['cutoff'] == 255 else str(inst['cutoff'])
                rz = "off" if inst['resonance'] == 255 else str(inst['resonance'])
                print("    filter(IT mode): cutoff=%s  resonance=%s" % (cu, rz))
            print("    vibrato: wave=%s speed=%d sweep=%d depth=%d rate=%d"
                  % (VIBWAVE.get(inst['vib_wave'], '?'), inst['vib_speed'],
                     inst['vib_sweep'], inst['vib_depth'], inst['vib_rate']))

            print("  ENVELOPES")
            print("    " + fmt_env(*inst['vol_env'], role="volume").replace("\n", "\n    "))
            print("    " + fmt_env(*inst['pan_env'], role="panning").replace("\n", "\n    "))
            for slot, key in (("pf-slot1", 'pf1'), ("pf-slot2", 'pf2')):
                loop = inst[key][0]
                role = ("filter" if loop['bit7'] else "pitch") + "(" + slot + ")"
                print("    " + fmt_env(*inst[key], role=role).replace("\n", "\n    "))

            # Ixmp patches
            patches = ixmp_by_inst.get(i, [])
            if patches:
                print("  IXMP PATCHES (%d) — pitch×volume assignment rectangles" % len(patches))
                for pi, p in enumerate(patches):
                    flags = []
                    if p['ver'] & IXMP_VER_X: flags.append("x")
                    if p['ver'] & IXMP_VER_V: flags.append("v")
                    if p['ver'] & IXMP_VER_P: flags.append("p")
                    if p['ver'] & IXMP_VER_F: flags.append("f")
                    if p['ver'] & IXMP_VER_PITCH: flags.append("P")
                    print("    patch %d  ver=0x%02X[%s]" % (pi, p['ver'], "".join(flags) or "i"))
                    print("      rect: pitch %s..%s ($%04X..$%04X)  vol %d..%d"
                          % (note_name(p['pitch_start']), note_name(p['pitch_end']),
                             p['pitch_start'], p['pitch_end'], p['vol_start'], p['vol_end']))
                    print("      sample: ptr=0x%06X len=%d rate@C4=%d play=%d loop=%d..%d mode=%s%s detune=%+d"
                          % (p['sample_ptr'], p['sample_len'], p['rate'], p['play_start'],
                             p['loop_start'], p['loop_end'], LOOPMODE[p['loop_mode']],
                             " sus" if p['loop_sustain'] else "", p['detune']))
                    extras = []
                    if p['default_pan'] != 0xFF: extras.append("pan=%d" % p['default_pan'])
                    if p['default_note_vol'] != 0: extras.append("note-vol=%d" % p['default_note_vol'])
                    if p['vib_wave'] != 0xFF:
                        extras.append("vib(w=%s,sp=%d,sw=%d,d=%d,r=%d)"
                                      % (VIBWAVE.get(p['vib_wave'], '?'), p['vib_speed'],
                                         p['vib_sweep'], p['vib_depth'], p['vib_rate']))
                    if extras:
                        print("      overrides: " + "  ".join(extras))
                    if 'x' in p:
                        x = p['x']
                        if x['sf_filter']:
                            filt = "cutoff=%d cents resonance=%d cB" % (x['cutoff'], x['resonance'])
                        else:
                            filt = "cutoff=%s resonance=%s" % (
                                "off" if x['cutoff'] == 0xFFFF else x['cutoff'],
                                "off" if x['resonance'] == 0xFFFF else x['resonance'])
                        print("      extra: filter-mode=%s %s  fadeout=%s  init-atten=%s"
                              % ("SF" if x['sf_filter'] else "IT", filt,
                                 fadeout_str(x['fadeout']),
                                 db_str(x['init_atten']) if x['init_atten'] else "unity(0)"))
                    for key, role in (('vol_env', 'volume'), ('pan_env', 'panning'),
                                      ('filter_env', 'filter'), ('pitch_env', 'pitch')):
                        if key in p:
                            print("      " + fmt_env(*p[key], role=role).replace("\n", "\n      "))

    # -- songs ------------------------------------------------------------------
    if kind != 0x80 and num_songs > 0:
        print(hr("SONGS"))
        song_table_off = 32 + comp_size
        song_range = range(num_songs) if args.song is None else [args.song]
        for s in song_range:
            if s < 0 or s >= num_songs:
                continue
            eoff = song_table_off + 32 * s
            soff = u32(data, eoff)
            nvoices = data[eoff + 4]
            npats = u16(data, eoff + 5)
            bpm = data[eoff + 7] + 25
            tickrate = data[eoff + 8]
            tuning_base = u16(data, eoff + 9)
            base_freq = struct.unpack_from('<f', data, eoff + 11)[0]
            gbflags = data[eoff + 15]
            gvol = data[eoff + 16]
            mvol = data[eoff + 17]
            patc = u32(data, eoff + 18)
            cuec = u32(data, eoff + 22)
            tone = gbflags & 0x03
            interp = (gbflags >> 2) & 0x07
            tone_names = {0: "linear-pitch", 1: "Amiga-period", 2: "linear-freq", 3: "reserved"}
            interp_names = {0: "default", 1: "none", 2: "Amiga500", 3: "Amiga1200",
                            4: "SNES Gaussian", 5: "NES DPCM"}

            meta = next((m for m in smet if m['idx'] == s), None)
            title = ('  "%s"' % meta['name']) if meta and meta['name'] else ""
            print(sub("SONG %d%s" % (s, title)))
            if meta:
                if meta['composer']:
                    print("  composer   : %s" % meta['composer'])
                if meta['copyright']:
                    print("  copyright  : %s" % meta['copyright'])
                print("  notation   : %d   beat division: %d/%d rows"
                      % (meta['notation'], meta['beat_pri'], meta['beat_sec']))
            # classic tracker timing: tick = 2500/BPM ms -> ticks/s = BPM/2.5;
            # tickrate is the speed (ticks per row), so rows/s = ticks/s / tickrate.
            ticks_s = bpm / 2.5
            print("  voices=%d  patterns=%d  BPM=%d  speed(tickrate)=%d  -> %.1f ticks/s, %.1f rows/s"
                  % (nvoices, npats, bpm, tickrate, ticks_s, ticks_s / tickrate if tickrate else 0))
            print("  tuning base note=$%04X (%s)  base freq=%.3f Hz"
                  % (tuning_base if tuning_base else 0xA000,
                     note_name(tuning_base if tuning_base else 0xA000),
                     base_freq if base_freq else 8363.0))
            print("  global vol=%d  mixing vol=%d  tone-mode=%s  interpolation=%s"
                  % (gvol, mvol, tone_names[tone], interp_names.get(interp, '?')))
            print("  pat-bin comp=%d  cue-sheet comp=%d  (song offset=%d)" % (patc, cuec, soff))

            # decompress patterns + cues for overview
            try:
                pat_bin = decomp(data[soff:soff + patc])
                cue_bin = decomp(data[soff + patc:soff + patc + cuec])
            except Exception as e:
                print("  [could not decompress patterns/cues: %s]" % e)
                continue
            npat_real = len(pat_bin) // PATTERN_SIZE
            ncue_real = len(cue_bin) // CUE_SIZE

            # non-empty pattern count
            nonempty = 0
            for p in range(npat_real):
                blk = pat_bin[p * PATTERN_SIZE:(p + 1) * PATTERN_SIZE]
                if any(blk):
                    nonempty += 1
            # used cue count (last cue with any non-FFF voice or instruction)
            used_cues = 0
            for c in range(ncue_real):
                pats, b30, b31 = cue_patterns(cue_bin, c)
                if any(x != 0xFFF for x in pats) or (b30 or b31):
                    used_cues = c + 1
            print("  patterns in bin=%d (%d non-empty)   cues used=%d" % (npat_real, nonempty, used_cues))

            do_cues = args.cues and (args.song is None or args.song == s)
            if do_cues or (args.cue is not None and (args.song is None or args.song == s)):
                print("  ORDER LIST (cue -> per-voice pattern):")
                clist = range(min(used_cues, args.max_cues)) if do_cues else [args.cue]
                for c in clist:
                    if c >= ncue_real:
                        continue
                    pats, b30, b31 = cue_patterns(cue_bin, c)
                    ins = cue_instruction(b30, b31)
                    body = " ".join("v%d=%03X" % (vi, x) for vi, x in enumerate(pats) if x != 0xFFF)
                    print("    cue %3d: %s%s" % (c, body, ("   [%s]" % ins) if ins else ""))

            if args.pattern is not None and (args.song is None or args.song == s):
                dump_pattern(pat_bin, args.pattern, nvoices, cue_bin, ncue_real)

    # -- project-data metadata (brief) -----------------------------------------
    print(hr("PROJECT DATA"))
    if not sections:
        print("(none)")
    else:
        order = ['PNam', 'PCom', 'PCpr', 'Pmsg', 'INam', 'SNam', 'pNam', 'sMet', 'nota', 'Ixmp']
        text = {'PNam': 'name', 'PCom': 'author', 'PCpr': 'copyright', 'Pmsg': 'message'}
        for fc in order:
            if fc not in sections:
                continue
            if fc in text:
                print("%-6s: %s" % (text[fc], sections[fc][0].decode('utf-8', 'replace').rstrip('\x00')))
        if inam:
            named = [(i, n) for i, n in enumerate(inam) if n]
            print("INam  : %d instrument names" % len(named))
            for i, n in named[:64]:
                print("        [%3d] %s" % (i, n))
            if len(named) > 64:
                print("        ... (%d more)" % (len(named) - 64))
        if snam:
            named = [(i, n) for i, n in enumerate(snam) if n]
            print("SNam  : %d sample names" % len(named))
            for i, n in named[:64]:
                print("        [%3d] %s" % (i, n))
            if len(named) > 64:
                print("        ... (%d more)" % (len(named) - 64))
        if pnam:
            named = [(i, n) for i, n in enumerate(pnam) if n]
            print("pNam  : %d pattern names" % len(named))
        if ixmp_by_inst:
            total = sum(len(v) for v in ixmp_by_inst.values())
            print("Ixmp  : %d patches across %d instruments %s"
                  % (total, len(ixmp_by_inst), sorted(ixmp_by_inst.keys())))
        if smet:
            print("sMet  : %d song metadata entries" % len(smet))
        for fc in sorted(sections):
            if fc not in order:
                print("%-6s: %d section(s) (not decoded)" % (fc, len(sections[fc])))


def dump_pattern(pat_bin, pidx, nvoices, cue_bin, ncue_real):
    """Dump every non-empty row of one pattern."""
    npat = len(pat_bin) // PATTERN_SIZE
    if pidx < 0 or pidx >= npat:
        print("  [pattern %d out of range 0..%d]" % (pidx, npat - 1))
        return
    print(sub("PATTERN 0x%03X (%d) rows" % (pidx, pidx)))
    base = pidx * PATTERN_SIZE
    EMPTY = True
    for r in range(64):
        o = base + r * 8
        note = u16(pat_bin, o)
        inst = pat_bin[o + 2]
        volb = pat_bin[o + 3]
        panb = pat_bin[o + 4]
        op = pat_bin[o + 5]
        arg = u16(pat_bin, o + 6)
        # empty cell: note 0, inst 0, no op, vol/pan no-op (3.00)
        if note == 0 and inst == 0 and op == 0 and arg == 0 \
           and (volb >> 6) == 3 and (volb & 0x3F) == 0 \
           and (panb >> 6) == 3 and (panb & 0x3F) == 0:
            continue
        EMPTY = False
        sym = op_symbol(op)
        if op == 0 and arg == 0:
            fx = "...."
        else:
            fx = "%s%04X" % (sym, arg)
        en = "" if (op == 0 and arg == 0) else describe_effect(sym, arg)
        print("  r%2d  %-12s i%02X  v=%s p=%s  %-6s %s"
              % (r, cell_note(note), inst, vol_col(volb), vol_col(panb), fx,
                 ("; " + en) if en else ""))
    if EMPTY:
        print("  (pattern is empty)")


if __name__ == "__main__":
    main()
