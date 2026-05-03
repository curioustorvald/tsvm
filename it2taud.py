#!/usr/bin/env python3
"""it2taud.py — Convert ImpulseTracker (.it) to TSVM Taud (.taud)

Usage:
    python3 it2taud.py input.it output.taud [-v] [--no-decompress]

Limits:
    - Up to 20 IT channels (excess dropped; hard error if chunk count
      × channel count > 4095).
    - IT patterns with >64 rows are split into ⌈rows/64⌉ consecutive
      Taud patterns. Pattern-loop (SBx) crossing a chunk boundary is
      warned; B/C effects are remapped to new cue indices.
    - IT2.14/IT2.15 compressed samples are decoded unless --no-decompress.
    - IT instrument volume/pan/pitch-or-filter envelopes (up to 25 nodes,
      sustain & env loops) are converted directly to the new Taud 192-byte
      instrument format. NNA actions are ignored. Each IT instrument
      resolves to its C-5 canonical sample.
    - Pitch and filter envelopes are emitted natively (engine-evaluated);
      auto-vibrato, fadeout, PPS/PPC, default pan, volume/pan swing, and
      initial filter cutoff/resonance are forwarded to the engine via
      the new instrument fields.
    - AdLib / OPL instruments are skipped.

Effect support:
    A-Z dispatch per TAUD_NOTE_EFFECTS.md. IT-specific: Cxx is binary
    (not BCD like ST3). V scales by ×2 (IT 0-128 → Taud 0-255). X is
    the full 8-bit IT pan. Y panbrello nibble-repeats. Z (MIDI macro)
    dropped. S6x fine-pattern-delay forwarded directly to Taud S$6x. SAx
    high-offset dropped. S7x NNA /
    past-note / envelope toggles forwarded directly (IT sub-codes match
    Taud one-to-one). Vol-column pitch-slide / tone-porta / vibrato sub-
    commands forwarded to main effect slot when empty; dropped otherwise.
    Per-effect private memory cohorts resolved eagerly (D/K/L share;
    E/F optionally linked with G per flag bit 5).
"""

import argparse
import gzip
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
    SAMPLEBIN_SIZE, INSTBIN_SIZE, SAMPLEINST_SIZE,
    PATTERN_ROWS, PATTERN_BYTES, NUM_PATTERNS_MAX, NUM_CUES, CUE_SIZE, NUM_VOICES,
    NOTE_NOP, NOTE_KEYOFF, NOTE_CUT, TAUD_C4,
    TOP_NONE, TOP_A, TOP_B, TOP_C, TOP_D, TOP_E, TOP_F, TOP_G, TOP_H, TOP_I,
    TOP_J, TOP_K, TOP_L, TOP_O, TOP_Q, TOP_R, TOP_S, TOP_T, TOP_U, TOP_V, TOP_W, TOP_Y,
    SEL_SET, SEL_UP, SEL_DOWN, SEL_FINE,
    EFF_A, EFF_B, EFF_C, EFF_D, EFF_E, EFF_F, EFF_G, EFF_H, EFF_I, EFF_J,
    EFF_K, EFF_L, EFF_M, EFF_N, EFF_O, EFF_P, EFF_Q, EFF_R, EFF_S, EFF_T,
    EFF_U, EFF_V, EFF_W, EFF_X, EFF_Y, EFF_Z,
    J_SEMI_TABLE,
    d_arg_to_col, resample_linear, encode_cue, deduplicate_patterns,
    normalise_sample, encode_song_entry,
)


# ── IT constants ─────────────────────────────────────────────────────────────

IT_MAGIC      = b'IMPM'
IT_SMP_MAGIC  = b'IMPS'
IT_INST_MAGIC = b'IMPI'

IT_NOTE_OFF   = 255
IT_NOTE_CUT   = 254
IT_NOTE_FADE  = 246   # treated as key-off

IT_ORD_END    = 255
IT_ORD_SKIP   = 254

IT_FLAG_STEREO        = 0x01
IT_FLAG_USE_INST      = 0x04
IT_FLAG_LINEAR        = 0x08
IT_FLAG_OLD_EFFECTS   = 0x10
IT_FLAG_LINK_GEF      = 0x20   # link G memory with E/F

# Sample flags (Flg byte at IMPS+0x12)
IT_SMP_ASSOC      = 0x01
IT_SMP_16BIT      = 0x02
IT_SMP_STEREO     = 0x04
IT_SMP_COMPRESSED = 0x08
IT_SMP_LOOP       = 0x10
IT_SMP_SUS_LOOP   = 0x20
IT_SMP_PINGPONG   = 0x40
IT_SMP_PINGPONG_SUS = 0x80

# Vol-column byte ranges (inclusive lower, inclusive upper)
VC_VOL_LO,    VC_VOL_HI    =   0,  64
VC_FVUP_LO,   VC_FVUP_HI   =  65,  74   # fine vol up  A (value = vc-64, 1..10)
VC_FVDN_LO,   VC_FVDN_HI   =  75,  84   # fine vol down B (value = vc-74, 1..10)
VC_VUP_LO,    VC_VUP_HI    =  85,  94   # vol slide up  C (value = vc-84, 1..10)
VC_VDN_LO,    VC_VDN_HI    =  95, 104   # vol slide dn  D (value = vc-94, 1..10)
VC_PDN_LO,    VC_PDN_HI    = 105, 114   # pitch dn      E (value = vc-104, 1..10)
VC_PUP_LO,    VC_PUP_HI    = 115, 124   # pitch up      F (value = vc-114, 1..10)
VC_PAN_LO,    VC_PAN_HI    = 128, 192   # set pan 0..64 (value = vc-128)
VC_TPORTA_LO, VC_TPORTA_HI = 193, 202   # tone porta    G
VC_VIB_LO,    VC_VIB_HI    = 203, 212   # vibrato       H (depth 1..10)

VC_TPORTA_TABLE = (0, 1, 4, 8, 16, 32, 64, 96, 128, 255)

# IT effects that recall last non-zero arg (per-effect-private, with cohort exceptions).
# V (Set Global Volume) recalls in IT compat mode — the first V $00 resolves to the
# header's global_vol, not literal 0. Without this, songs starting with V $00 silence.
IT_MEM_EFFECTS = frozenset({
    EFF_D, EFF_E, EFF_F, EFF_G, EFF_H, EFF_I, EFF_J,
    EFF_K, EFF_L, EFF_N, EFF_O, EFF_P, EFF_Q, EFF_R,
    EFF_S, EFF_T, EFF_U, EFF_X, EFF_Y,
    # EFF_V excluded: V00 means literal 0 in IT, not recall.
    # EFF_W excluded: Taud engine handles W recall natively (same private-slot semantics).
})


# ── Taud constants (it-specific) ──────────────────────────────────────────────

SIGNATURE        = b'it2taud/TSVM  '   # 14 bytes

# ThreeFiveMiniUfloat LUT — 256 entries, seconds 0.0..126.0 (must match Kotlin)
_MINUFLOAT_LUT = [
    0.0, 0.03125, 0.0625, 0.09375, 0.125, 0.15625, 0.1875, 0.21875,
    0.25, 0.28125, 0.3125, 0.34375, 0.375, 0.40625, 0.4375, 0.46875,
    0.5, 0.53125, 0.5625, 0.59375, 0.625, 0.65625, 0.6875, 0.71875,
    0.75, 0.78125, 0.8125, 0.84375, 0.875, 0.90625, 0.9375, 0.96875,
    1.0, 1.03125, 1.0625, 1.09375, 1.125, 1.15625, 1.1875, 1.21875,
    1.25, 1.28125, 1.3125, 1.34375, 1.375, 1.40625, 1.4375, 1.46875,
    1.5, 1.53125, 1.5625, 1.59375, 1.625, 1.65625, 1.6875, 1.71875,
    1.75, 1.78125, 1.8125, 1.84375, 1.875, 1.90625, 1.9375, 1.96875,
    2.0, 2.0625, 2.125, 2.1875, 2.25, 2.3125, 2.375, 2.4375,
    2.5, 2.5625, 2.625, 2.6875, 2.75, 2.8125, 2.875, 2.9375,
    3.0, 3.0625, 3.125, 3.1875, 3.25, 3.3125, 3.375, 3.4375,
    3.5, 3.5625, 3.625, 3.6875, 3.75, 3.8125, 3.875, 3.9375,
    4.0, 4.125, 4.25, 4.375, 4.5, 4.625, 4.75, 4.875,
    5.0, 5.125, 5.25, 5.375, 5.5, 5.625, 5.75, 5.875,
    6.0, 6.125, 6.25, 6.375, 6.5, 6.625, 6.75, 6.875,
    7.0, 7.125, 7.25, 7.375, 7.5, 7.625, 7.75, 7.875,
    8.0, 8.25, 8.5, 8.75, 9.0, 9.25, 9.5, 9.75,
    10.0, 10.25, 10.5, 10.75, 11.0, 11.25, 11.5, 11.75,
    12.0, 12.25, 12.5, 12.75, 13.0, 13.25, 13.5, 13.75,
    14.0, 14.25, 14.5, 14.75, 15.0, 15.25, 15.5, 15.75,
    16.0, 16.5, 17.0, 17.5, 18.0, 18.5, 19.0, 19.5,
    20.0, 20.5, 21.0, 21.5, 22.0, 22.5, 23.0, 23.5,
    24.0, 24.5, 25.0, 25.5, 26.0, 26.5, 27.0, 27.5,
    28.0, 28.5, 29.0, 29.5, 30.0, 30.5, 31.0, 31.5,
    32.0, 33.0, 34.0, 35.0, 36.0, 37.0, 38.0, 39.0,
    40.0, 41.0, 42.0, 43.0, 44.0, 45.0, 46.0, 47.0,
    48.0, 49.0, 50.0, 51.0, 52.0, 53.0, 54.0, 55.0,
    56.0, 57.0, 58.0, 59.0, 60.0, 61.0, 62.0, 63.0,
    64.0, 66.0, 68.0, 70.0, 72.0, 74.0, 76.0, 78.0,
    80.0, 82.0, 84.0, 86.0, 88.0, 90.0, 92.0, 94.0,
    96.0, 98.0, 100.0, 102.0, 104.0, 106.0, 108.0, 110.0,
    112.0, 114.0, 116.0, 118.0, 120.0, 122.0, 124.0, 126.0,
]

def _nearest_minifloat(sec: float) -> int:
    """Return ThreeFiveMiniUfloat index (0-255) for the nearest representable seconds value."""
    if sec <= 0.0:
        return 0
    if sec >= 126.0:
        return 255
    lo, hi = 0, len(_MINUFLOAT_LUT) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if _MINUFLOAT_LUT[mid] < sec:
            lo = mid + 1
        else:
            hi = mid
    # lo is first index where LUT[lo] >= sec; check lo-1 for nearest
    if lo > 0 and abs(_MINUFLOAT_LUT[lo - 1] - sec) <= abs(_MINUFLOAT_LUT[lo] - sec):
        return lo - 1
    return lo


# ── IT header parser ──────────────────────────────────────────────────────────

class ITHeader:
    __slots__ = ('title', 'ord_count', 'ins_count', 'smp_count', 'pat_count',
                 'cwt', 'cmwt', 'flags', 'special',
                 'global_vol', 'mix_vol', 'initial_speed', 'initial_tempo',
                 'pan_sep', 'linear_slides', 'use_instruments',
                 'link_gef', 'old_effects',
                 'chnl_pan', 'chnl_vol',
                 'order_list', 'ins_ptrs', 'smp_ptrs', 'pat_ptrs')

def parse_it_header(data: bytes) -> ITHeader:
    if len(data) < 0xC0:
        sys.exit("error: file too short to be IT")
    if data[0:4] != IT_MAGIC:
        sys.exit("error: not an IT file (bad magic)")

    h = ITHeader()
    h.title         = data[0x04:0x1E].rstrip(b'\x00').decode('latin-1', errors='replace')
    h.ord_count     = struct.unpack_from('<H', data, 0x20)[0]
    h.ins_count     = struct.unpack_from('<H', data, 0x22)[0]
    h.smp_count     = struct.unpack_from('<H', data, 0x24)[0]
    h.pat_count     = struct.unpack_from('<H', data, 0x26)[0]
    h.cwt           = struct.unpack_from('<H', data, 0x28)[0]
    h.cmwt          = struct.unpack_from('<H', data, 0x2A)[0]
    h.flags         = struct.unpack_from('<H', data, 0x2C)[0]
    h.special       = struct.unpack_from('<H', data, 0x2E)[0]
    h.global_vol    = data[0x30]
    h.mix_vol       = data[0x31]
    h.initial_speed = data[0x32]
    h.initial_tempo = data[0x33]
    h.pan_sep       = data[0x34]
    h.linear_slides    = bool(h.flags & IT_FLAG_LINEAR)
    h.use_instruments  = bool(h.flags & IT_FLAG_USE_INST)
    h.link_gef         = bool(h.flags & IT_FLAG_LINK_GEF)
    h.old_effects      = bool(h.flags & IT_FLAG_OLD_EFFECTS)

    h.chnl_pan = list(data[0x40:0x80])
    h.chnl_vol = list(data[0x80:0xC0])

    off = 0xC0
    h.order_list = list(data[off:off + h.ord_count])
    off += h.ord_count

    h.ins_ptrs = [struct.unpack_from('<I', data, off + i*4)[0]
                  for i in range(h.ins_count)]
    off += h.ins_count * 4

    h.smp_ptrs = [struct.unpack_from('<I', data, off + i*4)[0]
                  for i in range(h.smp_count)]
    off += h.smp_count * 4

    h.pat_ptrs = [struct.unpack_from('<I', data, off + i*4)[0]
                  for i in range(h.pat_count)]
    return h


# ── IT2.14 / IT2.15 sample decompressor ──────────────────────────────────────

def _wrap8(v: int) -> int:
    """Wrap to signed int8 range (C int8 overflow behaviour)."""
    v &= 0xFF
    return v if v < 128 else v - 256

def _wrap16(v: int) -> int:
    """Wrap to signed int16 range."""
    v &= 0xFFFF
    return v if v < 32768 else v - 65536

def _sign_extend(val: int, bits: int) -> int:
    sign_bit = 1 << (bits - 1)
    return (val & (sign_bit - 1)) - (val & sign_bit)

def _it214_decompress_block(payload: bytes, num_samples: int,
                             is_16bit: bool, is_it215: bool) -> list:
    """Decode one compressed block payload. Returns list of signed int output samples.

    Algorithm from libxmp / schism source:
      8-bit:  init_width=9,  short escape reads 3 bits, mid border=(1<<w)-8
      16-bit: init_width=17, short escape reads 4 bits, mid border=(1<<w)-16
    """
    bit_buf  = 0
    bit_cnt  = 0
    byte_pos = 0

    def read_bits(n):
        nonlocal bit_buf, bit_cnt, byte_pos
        while bit_cnt < n:
            b = payload[byte_pos] if byte_pos < len(payload) else 0
            bit_buf |= b << bit_cnt
            byte_pos += 1
            bit_cnt  += 8
        val      = bit_buf & ((1 << n) - 1)
        bit_buf >>= n
        bit_cnt  -= n
        return val

    if is_16bit:
        init_width   = 17
        range_count  = 16    # escape range size in mid form
        border_sub   = 8     # = range_count / 2; centres escape range on signed midpoint
        escape_bits  = 4     # bits to read in short-form escape
    else:
        init_width   = 9
        range_count  = 8
        border_sub   = 4
        escape_bits  = 3

    width = init_width
    d1 = d2 = 0
    out = []
    n = 0

    mask = (1 << (init_width - 1)) - 1   # 0xFF (8-bit) or 0xFFFF (16-bit)

    while n < num_samples:
        v = read_bits(width)

        is_data = False
        if width < 7:
            # Mode A (short): single escape code at v == 1<<(width-1).
            if v == (1 << (width - 1)):
                new_w = read_bits(escape_bits) + 1
                width = new_w if new_w < width else new_w + 1   # skip-self
                continue
            # Else: data, sign-extend from `width` bits.
            delta = _sign_extend(v, width)
            is_data = True
        elif width < init_width:
            # Mode B (mid): `range_count` escape codes occupy values (border, border+range_count].
            # The encoder simply does NOT emit data values that would collide with this slot —
            # it widens first. So values *above* the escape range are sign-extended verbatim,
            # not collapsed. Reference: schismtracker fmt/compression.c:103-127 and
            # MilkyTracker XModule.cpp:629-640.
            # border = (mask >> (init_width-width)) - border_sub, where border_sub
            # = range_count / 2.
            # 8-bit:  width=7 → border=63-4=59, width=8 → border=127-4=123
            # 16-bit: width=7..16 with border_sub=8.
            border = (mask >> (init_width - width)) - border_sub
            if border < v <= border + range_count:
                new_w = v - border
                width = new_w if new_w < width else new_w + 1   # skip-self
                continue
            delta = _sign_extend(v, width)
            is_data = True
        else:
            # Mode C (full): top bit (bit init_width-1) signals width change.
            top_bit = 1 << (init_width - 1)
            if v & top_bit:
                width = (v & (top_bit - 1)) + 1
                continue
            # Else: data is (init_width-1) bits wide, sign-extend from there.
            delta = _sign_extend(v, init_width - 1)
            is_data = True

        if is_data:
            if is_16bit:
                d1 = _wrap16(d1 + delta)
                if is_it215:
                    d2 = _wrap16(d2 + d1)
                    out.append(d2)
                else:
                    out.append(d1)
            else:
                d1 = _wrap8(d1 + delta)
                if is_it215:
                    d2 = _wrap8(d2 + d1)
                    out.append(d2)
                else:
                    out.append(d1)
            n += 1

    return out

def it214_decompress(blob: bytes, smp_offset: int, num_samples: int,
                     is_16bit: bool, is_it215: bool) -> bytes:
    """Decode IT2.14/IT2.15 compressed sample data. Returns raw PCM bytes (signed)."""
    block_size = 0x4000 if is_16bit else 0x8000
    pos = smp_offset
    out_samples = []

    while len(out_samples) < num_samples:
        if pos + 2 > len(blob):
            break
        block_len = struct.unpack_from('<H', blob, pos)[0]
        pos += 2
        payload   = blob[pos:pos + block_len]
        pos      += block_len

        remaining = num_samples - len(out_samples)
        chunk_n   = min(remaining, block_size)
        chunk = _it214_decompress_block(payload, chunk_n, is_16bit, is_it215)
        out_samples.extend(chunk)

    if is_16bit:
        result = bytearray(len(out_samples) * 2)
        for i, s in enumerate(out_samples):
            struct.pack_into('<h', result, i * 2, max(-32768, min(32767, s)))
        return bytes(result)
    else:
        return bytes(s & 0xFF for s in out_samples)


# ── IT sample parser ──────────────────────────────────────────────────────────

class ITSample:
    __slots__ = ('name', 'filename', 'gv', 'vol', 'flags', 'cvt', 'dfp',
                 'c5_speed', 'length', 'loop_beg', 'loop_end',
                 'sus_beg', 'sus_end', 'smp_point',
                 'has_loop', 'is_16bit', 'is_stereo', 'is_compressed',
                 'is_signed', 'sample_data',
                 'av_speed', 'av_depth', 'av_sweep', 'av_wave')

def parse_samples(data: bytes, h: ITHeader, decompress: bool) -> list:
    samples = []
    # IT2.15 compression is signaled PER-SAMPLE via cvt bit 2 (0x04), not globally
    # via the file's cwt. Reference: OpenMPT ITTools.cpp, libxmp it_load.c.
    for i, ptr in enumerate(h.smp_ptrs):
        if ptr == 0 or ptr + 0x50 > len(data):
            vprint(f"  warning: sample {i+1} pointer {ptr:#x} out of range, skipping")
            samples.append(None)
            continue
        if data[ptr:ptr+4] != IT_SMP_MAGIC:
            vprint(f"  warning: sample {i+1} at {ptr:#x} has bad magic, skipping")
            samples.append(None)
            continue

        s = ITSample()
        s.filename    = data[ptr+0x04:ptr+0x10].rstrip(b'\x00').decode('latin-1', errors='replace')
        s.gv          = data[ptr+0x11]
        s.flags       = data[ptr+0x12]
        s.vol         = data[ptr+0x13]
        s.name        = data[ptr+0x14:ptr+0x2E].rstrip(b'\x00').decode('latin-1', errors='replace')
        s.cvt         = data[ptr+0x2E]
        s.dfp         = data[ptr+0x2F]
        s.length      = struct.unpack_from('<I', data, ptr+0x30)[0]
        s.loop_beg    = struct.unpack_from('<I', data, ptr+0x34)[0]
        s.loop_end    = struct.unpack_from('<I', data, ptr+0x38)[0]
        s.c5_speed    = struct.unpack_from('<I', data, ptr+0x3C)[0] or 8363
        s.sus_beg     = struct.unpack_from('<I', data, ptr+0x40)[0]
        s.sus_end     = struct.unpack_from('<I', data, ptr+0x44)[0]
        s.smp_point   = struct.unpack_from('<I', data, ptr+0x48)[0]
        # Auto-vibrato (per-sample): IMPS+0x4C..0x4F.
        s.av_speed   = data[ptr + 0x4C]
        s.av_depth   = data[ptr + 0x4D]
        s.av_sweep   = data[ptr + 0x4E]
        s.av_wave    = data[ptr + 0x4F]

        s.has_loop     = bool(s.flags & IT_SMP_LOOP)
        s.is_16bit     = bool(s.flags & IT_SMP_16BIT)
        s.is_stereo    = bool(s.flags & IT_SMP_STEREO)
        s.is_compressed = bool(s.flags & IT_SMP_COMPRESSED)
        s.is_signed    = bool(s.cvt & 0x01)
        s.sample_data  = b''

        has_data = bool(s.flags & IT_SMP_ASSOC) and s.length > 0
        if has_data:
            if s.is_compressed:
                if not decompress:
                    vprint(f"  warning: '{s.name}' is IT2.14 compressed, --no-decompress → silent")
                else:
                    try:
                        is_it215 = bool(s.cvt & 0x04)
                        raw = it214_decompress(data, s.smp_point, s.length,
                                               s.is_16bit, is_it215)
                        s.sample_data = normalise_sample(raw, True,
                                                          s.is_16bit, s.is_stereo, s.name)
                        s.length = len(s.sample_data)
                        s.loop_beg = min(s.loop_beg, s.length)
                        s.loop_end = min(s.loop_end, s.length)
                        s.sus_beg = min(s.sus_beg, s.length)
                        s.sus_end = min(s.sus_end, s.length)
                    except Exception as e:
                        vprint(f"  warning: '{s.name}' decompression failed ({e}), silent")
            else:
                byte_len = s.length * (2 if s.is_16bit else 1) * (2 if s.is_stereo else 1)
                if s.smp_point + byte_len > len(data):
                    vprint(f"  warning: '{s.name}' sample data out of range, zeroing")
                    s.sample_data = bytes(min(s.length, 256))
                else:
                    raw = data[s.smp_point : s.smp_point + byte_len]
                    s.sample_data = normalise_sample(raw, s.is_signed,
                                                      s.is_16bit, s.is_stereo, s.name)
                    s.length    = len(s.sample_data)
                    s.loop_beg  = min(s.loop_beg, s.length)
                    s.loop_end  = min(s.loop_end,  s.length)
                    s.sus_beg   = min(s.sus_beg,  s.length)
                    s.sus_end   = min(s.sus_end,  s.length)
        samples.append(s)
    return samples


# ── IT instrument parser ──────────────────────────────────────────────────────

class ITInstrument:
    __slots__ = ('name', 'dfp', 'gv', 'canonical_sample', 'canonical_volume',
                 'vol_envelope', 'pan_envelope', 'vol_env_sustain', 'pan_env_sustain',
                 'pf_envelope', 'pf_env_sustain', 'pf_is_filter',
                 'ifc', 'ifr', 'fadeout', 'pps', 'ppc', 'rv', 'rp', 'nna',
                 'dct', 'dca')
    # vol_envelope / pan_envelope / pf_envelope: list of 25 (value, minifloat_idx) tuples, or None
    # *_env_sustain: int (16-bit, 0b 0ut sssss pcb eeeee), 0 = no envelope
    # pf_is_filter: bool — pf envelope mode (False = pitch, True = filter)
    # ifc / ifr  : initial filter cutoff / resonance (0..127, 0 if not set)
    # fadeout    : 0..1024 (IT FadeOut field; doubled to 0..2048 when written to Taud's 12-bit field)
    # pps / ppc  : pitch-pan separation (signed -32..+32) and centre note (0..119)
    # rv / rp    : random volume swing (0..100) / random pan swing (0..64)
    # nna        : new note action (IT 0=cut, 1=continue, 2=note off, 3=note fade)

def parse_instruments(data: bytes, h: ITHeader) -> list:
    insts = []
    for i, ptr in enumerate(h.ins_ptrs):
        if ptr == 0 or ptr + 0x48 > len(data):
            insts.append(None); continue
        if data[ptr:ptr+4] != IT_INST_MAGIC:
            insts.append(None); continue

        inst = ITInstrument()
        inst.name = data[ptr+0x20:ptr+0x3A].rstrip(b'\x00').decode('latin-1', errors='replace')
        # NNA at IMPI+0x11 (new format). 0=cut, 1=continue, 2=note off, 3=note fade.
        inst.nna  = data[ptr + 0x11] & 0x03
        # DCT (Duplicate Check Type) and DCA (Duplicate Check Action), per Schism iti.c:80-94.
        # DCT: 0=off, 1=note, 2=sample, 3=instrument.
        # DCA: 0=note cut, 1=note off, 2=note fade.
        inst.dct  = data[ptr + 0x12] & 0x03
        inst.dca  = data[ptr + 0x13] & 0x03
        inst.fadeout = struct.unpack_from('<H', data, ptr + 0x14)[0]   # 0..1024
        # PPS is signed -32..+32; PPC is the centre note (IT note number 0..119, C-5=60).
        inst.pps  = struct.unpack_from('b', data, ptr + 0x16)[0]
        inst.ppc  = data[ptr + 0x17]
        inst.gv   = data[ptr+0x18]
        dfp_raw   = data[ptr+0x19]
        inst.dfp  = dfp_raw & 0x7F if (dfp_raw & 0x80) else None  # None = don't use
        inst.rv   = data[ptr + 0x1A]   # 0..100
        inst.rp   = data[ptr + 0x1B]   # 0..64

        # Keyboard table: 240 bytes at ptr+0x44, 120 pairs of (note, sample_1based)
        keyboard = []
        for n in range(120):
            kb_note = data[ptr + 0x44 + n*2]
            kb_smp  = data[ptr + 0x44 + n*2 + 1]
            keyboard.append(kb_smp)  # 0 = no sample

        # Pick C-5 (note 60) sample; fall back to most-frequent non-zero
        c5_smp = keyboard[60] if 60 < len(keyboard) else 0
        if c5_smp == 0:
            from collections import Counter
            freq = Counter(s for s in keyboard if s != 0)
            c5_smp = freq.most_common(1)[0][0] if freq else 0

        inst.canonical_sample = c5_smp   # 1-based sample index, 0 = none
        inst.canonical_volume  = min(inst.gv, 64)

        # Initial filter cutoff/resonance (high bit = enabled, low 7 bits = value).
        # Per Schism iti.c struct it_instrument: name[26] occupies 0x20..0x39,
        # ifc is at 0x3A, ifr at 0x3B. Off-by-one would silently disable filters
        # on every IT instrument because name's last byte is always NUL.
        ifc_raw = data[ptr + 0x3A]
        ifr_raw = data[ptr + 0x3B]
        # Taud uses full 0..255 range (double IT's resolution): IT 0..127 → Taud 0..254,
        # IT "off" (high bit clear) → Taud 255.
        inst.ifc = (ifc_raw & 0x7F) * 2 if (ifc_raw & 0x80) else 255
        inst.ifr = (ifr_raw & 0x7F) * 2 if (ifr_raw & 0x80) else 255

        # Parse IT envelopes (new-format only, ≥cmwt 0x200)
        # Vol envelope at ptr+0x130; pan envelope at ptr+0x182; pf envelope at ptr+0x1D4
        ticks_per_sec = max(h.initial_tempo * 2.0 / 5.0, 1.0)
        inst.vol_envelope, inst.vol_env_sustain = _parse_it_envelope(
            data, ptr + 0x130, kind='vol', ticks_per_sec=ticks_per_sec)
        inst.pan_envelope, inst.pan_env_sustain = _parse_it_envelope(
            data, ptr + 0x182, kind='pan', ticks_per_sec=ticks_per_sec)
        # pf envelope: byte 0 bit 7 distinguishes filter (1) from pitch (0).
        pf_flag_byte = data[ptr + 0x1D4] if ptr + 0x1D4 < len(data) else 0
        inst.pf_is_filter = bool(pf_flag_byte & 0x80)
        inst.pf_envelope, inst.pf_env_sustain = _parse_it_envelope(
            data, ptr + 0x1D4, kind=('filter' if inst.pf_is_filter else 'pitch'),
            ticks_per_sec=ticks_per_sec)
        insts.append(inst)
    return insts


def _parse_it_envelope(data: bytes, env_ptr: int, kind: str,
                       ticks_per_sec: float) -> tuple:
    """Parse one IT envelope block (vol / pan / pitch / filter) into up to 25
    Taud (value, minifloat_idx) points + a 16-bit sustain/flags word.

    Returns (points_list, sus_word). points_list has 25 entries (padded
    with hold-zeros) or None if the envelope is disabled.

    kind:
      'vol'    — IT 0..64    →  Taud 0..63  (byte 1 = volume)
      'pan'    — IT -32..+32 →  Taud 0..255 (0x80 = centre)
      'pitch'  — IT -32..+32 →  Taud 0..255 (0x80 = unity, 1 unit ≈ 1 semitone)
      'filter' — IT -32..+32 →  Taud 0..255 (0x80 = unity cutoff)

    sus_word layout (16 bits, 0b 0ut sssss pcb eeeee):
        bit 14 = u (enable sustain/loop)
        bit 13 = t (sustain — breaks on key-off when set)
        bits 12..8 = sustain/loop start (5-bit index 0..24)
        bit  7 = p   (vol: fadeout-zero; pan: use default pan; pf: filter mode)
        bit  6 = c   (envelope carry)
        bit  5 = b   (use envelope at all)
        bits 4..0 = sustain/loop end (5-bit index 0..24)
    """
    if env_ptr + 82 > len(data):
        return None, 0
    flags = data[env_ptr]
    if not (flags & 0x01):
        return None, 0          # envelope not enabled

    num_nodes  = max(1, min(data[env_ptr + 1], 25))
    it_lpb     = data[env_ptr + 2]
    it_lpe     = data[env_ptr + 3]
    it_slb     = data[env_ptr + 4]
    it_sle     = data[env_ptr + 5]
    has_env_loop = bool(flags & 0x02)
    has_sus_loop = bool(flags & 0x04)
    carry        = bool(flags & 0x08)
    is_filter    = bool(flags & 0x80) and kind in ('pitch', 'filter')

    # Priority: sus loop > env loop (Taud carries one loop region).
    if has_sus_loop:
        use_lb, use_le = it_slb, it_sle
        has_loop = True
        is_sustain = True
    elif has_env_loop:
        use_lb, use_le = it_lpb, it_lpe
        has_loop = True
        is_sustain = False
    else:
        use_lb = use_le = -1
        has_loop = False
        is_sustain = False

    # Read IT nodes: (int8 value, uint16 tick_pos LE)
    nodes = []
    for n in range(num_nodes):
        nptr = env_ptr + 6 + n * 3
        if nptr + 2 >= len(data):
            break
        val  = struct.unpack_from('b', data, nptr)[0]
        tick = struct.unpack_from('<H', data, nptr + 1)[0]
        nodes.append((val, tick))
    if not nodes:
        return None, 0

    def _to_taud_val(it_val: int) -> int:
        if kind == 'vol':
            return min(63, max(0, round(it_val * 63 / 64)))
        if kind == 'pan':
            return min(255, max(0, round((it_val + 32) * 255 / 64)))
        # pitch / filter: -32..+32 → 0..255 (0x80 = unity)
        return min(255, max(0, round((it_val + 32) * 255 / 64)))

    pad_value = (63 if kind == 'vol' else 0x80)

    # Build Taud envelope points with delta-time minifloats. We keep all
    # IT nodes verbatim (up to 25), so loop indices stay valid.
    points = []
    for k in range(25):
        if k < len(nodes):
            val, tick = nodes[k]
            taud_val = _to_taud_val(val)
            if k < len(nodes) - 1:
                _, next_tick = nodes[k + 1]
                delta_sec    = max(0.0, (next_tick - tick) / ticks_per_sec)
                mf_idx       = _nearest_minifloat(delta_sec)
            else:
                mf_idx = 0          # last real node: hold
        else:
            # Pad: hold at last real node's value.
            taud_val = points[-1][0] if points else pad_value
            mf_idx   = 0
        points.append((taud_val, mf_idx))

    # Build 16-bit sus word.
    sus_word = 0x0020   # b = 1 (use envelope) — set whenever the envelope is enabled
    if carry:
        sus_word |= 0x0040
    if is_filter:
        sus_word |= 0x0080
    if has_loop and 0 <= use_lb < 25 and 0 <= use_le < 25:
        sus_word |= 0x4000                      # u
        if is_sustain:
            sus_word |= 0x2000                  # t
        sus_word |= (use_lb & 0x1F) << 8        # sssss
        sus_word |= (use_le & 0x1F)             # eeeee

    return points, sus_word


# ── IT pattern parser ─────────────────────────────────────────────────────────

class ITRow:
    __slots__ = ('note', 'inst', 'vol', 'effect', 'effect_arg', 'volcol',
                 'pan_set', 'aux_effect')
    def __init__(self):
        self.note       = -1        # -1=empty, 0-119=pitch, IT_NOTE_*
        self.inst       = 0         # 1-based
        self.vol        = -1        # -1=not set
        self.effect     = 0
        self.effect_arg = 0
        self.volcol     = -1        # raw IT vol-col byte, -1 = not set
        self.pan_set    = None      # 0..63 from vol-col, or None
        self.aux_effect = None      # (cmd,arg) from vol-col, or None

def _parse_one_pattern(data: bytes, ptr: int) -> tuple:
    """Returns (grid: list[64_channels][rows], row_count: int)."""
    if ptr == 0 or ptr + 8 > len(data):
        return [[ITRow() for _ in range(PATTERN_ROWS)] for _ in range(64)], PATTERN_ROWS

    data_len  = struct.unpack_from('<H', data, ptr)[0]
    row_count = struct.unpack_from('<H', data, ptr+2)[0]
    end = ptr + 8 + data_len
    pos = ptr + 8

    grid = [[ITRow() for _ in range(row_count)] for _ in range(64)]

    # Per-channel last-data memory
    last_mask    = [0]   * 64
    last_note    = [0]   * 64
    last_inst    = [0]   * 64
    last_volcol  = [0]   * 64
    last_cmd     = [0]   * 64
    last_arg     = [0]   * 64

    row = 0
    while row < row_count and pos < end:
        chan_byte = data[pos]; pos += 1
        if chan_byte == 0:
            row += 1
            continue
        ch = (chan_byte - 1) & 63
        if chan_byte & 0x80:
            if pos >= end: break
            last_mask[ch] = data[pos]; pos += 1
        mask = last_mask[ch]

        cell = grid[ch][row]

        if mask & 0x01:
            last_note[ch] = data[pos]; pos += 1
        if mask & 0x02:
            last_inst[ch] = data[pos]; pos += 1
        if mask & 0x04:
            last_volcol[ch] = data[pos]; pos += 1
        if mask & 0x08:
            last_cmd[ch] = data[pos]; pos += 1
            last_arg[ch] = data[pos]; pos += 1

        if mask & 0x11:   cell.note       = last_note[ch]
        if mask & 0x22:   cell.inst       = last_inst[ch]
        if mask & 0x44:   cell.volcol     = last_volcol[ch]
        if mask & 0x88:
            cell.effect     = last_cmd[ch]
            cell.effect_arg = last_arg[ch]

    return grid, row_count

def parse_patterns(data: bytes, h: ITHeader) -> list:
    """Returns list of (grid, row_count) tuples."""
    patterns = []
    for ptr in h.pat_ptrs:
        grid, rows = _parse_one_pattern(data, ptr)
        patterns.append((grid, rows))
    return patterns


# ── Note encoding (IT linear 0-119 → Taud pitch units) ───────────────────────

def encode_note_it(it_note: int) -> int:
    if it_note == IT_NOTE_OFF or it_note == IT_NOTE_FADE:
        return NOTE_KEYOFF
    if it_note == IT_NOTE_CUT:
        return NOTE_CUT
    if 0 <= it_note <= 119:
        # IT middle C is C-5 (note 60); Taud reference is C-4 (TAUD_C4 = 0x5000).
        # IT C-5 anchors to Taud C-4, so offset = it_note - 60.
        semis = it_note - 60
        val = round(TAUD_C4 + semis * 4096 / 12)
        return max(1, min(0xFFFD, val))
    return NOTE_NOP


# ── Vol-column decoder ────────────────────────────────────────────────────────

def decode_volcol(vc: int):
    """Return (vol_sel, vol_value, pan_set, aux_effect) or None for each field."""
    if vc < 0:   # not set
        return SEL_FINE, 0, None, None
    if vc <= VC_VOL_HI:
        return SEL_SET, min(vc, 0x3F), None, None
    if VC_FVUP_LO <= vc <= VC_FVUP_HI:
        mag = vc - VC_FVUP_LO + 1   # 1..10
        return SEL_FINE, (mag & 0x1F) | 0x20, None, None   # fine up
    if VC_FVDN_LO <= vc <= VC_FVDN_HI:
        mag = vc - VC_FVDN_LO + 1
        return SEL_FINE, mag & 0x1F, None, None              # fine down
    if VC_VUP_LO <= vc <= VC_VUP_HI:
        return SEL_UP, vc - VC_VUP_LO + 1, None, None
    if VC_VDN_LO <= vc <= VC_VDN_HI:
        return SEL_DOWN, vc - VC_VDN_LO + 1, None, None
    if VC_PDN_LO <= vc <= VC_PDN_HI:
        # Pitch slide down: each unit = 4 ST3 coarse units (1/16 semitone each)
        units = (vc - VC_PDN_LO + 1) * 4
        return SEL_FINE, 0, None, (EFF_E, units & 0xFF)
    if VC_PUP_LO <= vc <= VC_PUP_HI:
        units = (vc - VC_PUP_LO + 1) * 4
        return SEL_FINE, 0, None, (EFF_F, units & 0xFF)
    if VC_PAN_LO <= vc <= VC_PAN_HI:
        pan64 = vc - VC_PAN_LO   # 0..64
        pan6  = min(0x3F, round(pan64 * 63 / 64))
        return SEL_FINE, 0, pan6, None
    if VC_TPORTA_LO <= vc <= VC_TPORTA_HI:
        spd = VC_TPORTA_TABLE[vc - VC_TPORTA_LO]
        return SEL_FINE, 0, None, (EFF_G, spd & 0xFF)
    if VC_VIB_LO <= vc <= VC_VIB_HI:
        depth = vc - VC_VIB_LO + 1   # 1..10
        return SEL_FINE, 0, None, (EFF_H, depth & 0x0F)
    return SEL_FINE, 0, None, None


# ── Effect translator ─────────────────────────────────────────────────────────

def encode_effect_it(cmd: int, arg: int, ch: int = 0, row: int = 0,
                     amiga_mode: bool = False) -> tuple:
    """Return (taud_op, taud_arg16, vol_override, pan_override).

    Differs from s3m2taud.encode_effect in:
      - Cxx: binary row number, not BCD
      - V: IT global vol 0-128 scaled ×2
      - X: IT full 8-bit pan → 6-bit
      - S6x: fine pattern delay forwarded; S7x forwarded; SAx/SFx dropped

    amiga_mode mirrors the inverse of the IT ``linear_slides`` flag.  When
    set, E/F coarse pitch-slide arguments are emitted as raw IT period units
    (the engine applies them directly in period space); when clear they are
    quantised to 4096-TET units via ``round(× 64/3)``.  Fine/extra-fine
    slides and tone portamento (G) are always linear regardless of mode.
    """
    if cmd == 0:
        return (TOP_NONE, 0, None, None)

    if cmd == EFF_A:
        if arg == 0:
            return (TOP_NONE, 0, None, None)
        return (TOP_A, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_B:
        return (TOP_B, arg & 0xFF, None, None)

    if cmd == EFF_C:
        # IT stores binary (not BCD like ST3)
        row_num = arg & 0xFF
        if row_num >= PATTERN_ROWS:
            row_num = 0
        return (TOP_C, row_num & 0xFF, None, None)

    if cmd == EFF_D:
        return (TOP_D, (arg & 0xFF) << 8, None, None)

    if cmd in (EFF_E, EFF_F):
        # Coarse: 1/16 semitone = 64/3 Taud units in linear mode; raw IT period
        # units in Amiga mode (engine consumes them in period space).
        # Fine/extra-fine (Exx with hi ∈ {E,F}): 1/64 semitone = 16/3 Taud units
        # in linear mode; raw IT period units in Amiga mode (engine consumes
        # them in period space, applied once per row at tick 0).
        op = TOP_E if cmd == EFF_E else TOP_F
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        if hi in (0xE, 0xF) and lo > 0:
            if amiga_mode:
                return (op, 0xF000 | (lo & 0xFFF), None, None)
            return (op, 0xF000 | (round(lo * 16 / 3) & 0xFFF), None, None)
        if amiga_mode:
            return (op, arg & 0xFFFF, None, None)
        return (op, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd == EFF_G:
        return (TOP_G, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd in (EFF_H, EFF_I, EFF_R, EFF_U):
        op = {EFF_H: TOP_H, EFF_I: TOP_I, EFF_R: TOP_R, EFF_U: TOP_U}[cmd]
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (op, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == EFF_J:
        hi_semi = (arg >> 4) & 0xF
        lo_semi = arg & 0xF
        return (TOP_J, (J_SEMI_TABLE[hi_semi] << 8) | J_SEMI_TABLE[lo_semi], None, None)

    if cmd == EFF_K:
        return (TOP_H, 0x0000, d_arg_to_col(arg), None)

    if cmd == EFF_L:
        return (TOP_G, 0x0000, d_arg_to_col(arg), None)

    if cmd == EFF_M:
        return (TOP_NONE, 0, (SEL_SET, min(arg, 0x3F)), None)

    if cmd == EFF_N:
        return (TOP_NONE, 0, d_arg_to_col(arg), None)

    if cmd == EFF_O:
        return (TOP_O, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_P:
        return (TOP_NONE, 0, None, d_arg_to_col(arg))

    if cmd == EFF_Q:
        return (TOP_Q, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_S:
        sub = (arg >> 4) & 0xF
        val = arg & 0xF
        if sub in (0x1, 0x2, 0x3, 0x4, 0xB, 0xC, 0xD, 0xE):
            return (TOP_S, (sub << 12) | (val << 8), None, None)
        if sub == 0x5:
            return (TOP_S, 0x5000 | (val << 8), None, None)
        if sub == 0x8:
            # IT S8x: 4-bit → nibble-repeat into 8-bit SEL_SET pan
            pan8 = (val << 4) | val
            return (TOP_S, 0x8000 | pan8, None, None)
        if sub == 0x6:
            # IT S6x = fine pattern delay (extends row by x ticks) — maps directly.
            return (TOP_S, 0x6000 | (val << 8), None, None)
        if sub == 0x7:
            # NNA / past-note / envelope on-off — IT S7x maps directly to Taud S $7x00
            # (same sub-code table). No payload to translate.
            return (TOP_S, 0x7000 | (val << 8), None, None)
        if sub == 0x9:
            return (TOP_NONE, 0, None, None)  # sound control — drop silently
        if sub == 0xA:
            vprint(f"    dropped SA{val:X} (high offset) at ch{ch} row{row}")
            return (TOP_NONE, 0, None, None)
        if sub == 0xF:
            vprint(f"    dropped SF{val:X} (MIDI macro) at ch{ch} row{row}")
            return (TOP_NONE, 0, None, None)
        return (TOP_NONE, 0, None, None)

    if cmd == EFF_T:
        if arg >= 0x20:
            return (TOP_T, ((arg - 0x18) & 0xFF) << 8, None, None)
        return (TOP_T, arg & 0xFF, None, None)

    if cmd == EFF_V:
        # IT global vol is 0-128; Taud uses 0-255 → ×2
        taud_v = min(arg * 2, 0xFF)
        return (TOP_V, (taud_v & 0xFF) << 8, None, None)

    if cmd == EFF_W:
        # W$xy: same nibble-pair layout as D, passed in the high byte.
        return (TOP_W, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_X:
        return (TOP_S, 0x8000 | (arg & 0xFF), None, None)

    if cmd == EFF_Y:
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (TOP_Y, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == EFF_Z:
        vprint(f"    dropped Z{arg:02X} (MIDI macro) at ch{ch} row{row}")
        return (TOP_NONE, 0, None, None)

    return (TOP_NONE, 0, None, None)


# ── IT recall resolution ──────────────────────────────────────────────────────

def resolve_it_recalls(patterns_rows: list, order_list: list,
                       num_channels: int, link_gef: bool,
                       old_effects: bool = False) -> None:
    """Walk in order, resolve zero-arg recalls per-effect-per-channel.

    IT effect memory groups:
      - D / K / L: shared vol-slide cohort
      - E / F (/ G when link_gef): shared pitch-slide cohort
      - G: own slot (or part of EF cohort when link_gef)
      - All others: private slots

    old_effects=True (IT_FLAG_OLD_EFFECTS): E00/F00 are ST3-style stops —
    they do NOT recall and are suppressed to TOP_NONE. All other effects
    still recall normally even in old_effects mode.

    V and W are excluded from IT_MEM_EFFECTS and are not resolved here:
    V00 in IT means literal 0 (not recall); W recall is handled natively
    by the Taud engine's private W memory slot.
    """
    # last_mem[ch][eff_key] = last_non_zero_arg
    # eff_key: integer 1-26 for most effects; we merge cohorts by normalising.
    last_mem = [{} for _ in range(num_channels)]

    # Effects that stop rather than recall when arg=0 in old_effects mode (ST3 compat).
    # E/F: pitch slide stop. J: arpeggio stop (J00 = return to normal pitch in ST3).
    OLD_EFF_STOPS = frozenset({EFF_E, EFF_F, EFF_J})

    def cohort_key(cmd):
        if cmd in (EFF_D, EFF_K, EFF_L):
            return EFF_D   # vol-slide cohort
        if link_gef and cmd in (EFF_E, EFF_F, EFF_G):
            return EFF_E   # EFG cohort
        if not link_gef and cmd in (EFF_E, EFF_F):
            return EFF_E   # EF cohort
        return cmd

    for order in order_list:
        if order >= IT_ORD_END:
            break
        if order >= len(patterns_rows):
            continue
        grid, rows = patterns_rows[order]
        for r in range(rows):
            for ch in range(num_channels):
                if ch >= len(grid):
                    continue
                cell = grid[ch][r]
                if cell.effect not in IT_MEM_EFFECTS:
                    continue
                key = cohort_key(cell.effect)
                if cell.effect_arg == 0:
                    if old_effects and cell.effect in OLD_EFF_STOPS:
                        # E00/F00 in old_effects = stop slide — suppress entirely.
                        # Taud's E $0000 also recalls, so convert to no-op here.
                        cell.effect = 0
                    else:
                        cell.effect_arg = last_mem[ch].get(key, 0)
                else:
                    last_mem[ch][key] = cell.effect_arg


# ── Pattern row-chunk splitter ────────────────────────────────────────────────

def split_patterns(patterns_rows: list):
    """
    Returns (chunks, chunk_map).
      chunks: flat list of 64-row grids (list of 64 × 64-channel ITRow arrays)
      chunk_map: list per source pattern of [chunk_idx_0, chunk_idx_1, ...]
    """
    chunks   = []
    chunk_map = []

    for pi, (grid, rows) in enumerate(patterns_rows):
        if rows == 0:
            chunk_map.append([])
            continue

        n_chunks = (rows + PATTERN_ROWS - 1) // PATTERN_ROWS
        if n_chunks > 1:
            vprint(f"  pattern {pi}: {rows} rows → {n_chunks} chunks")

        pat_chunks = []
        for k in range(n_chunks):
            r0 = k * PATTERN_ROWS
            r1 = min(r0 + PATTERN_ROWS, rows)
            # Build a 64-row grid for this chunk
            chunk_grid = []
            for ch in range(64):
                ch_rows = []
                src = grid[ch] if ch < len(grid) else []
                for ri in range(PATTERN_ROWS):
                    sr = r0 + ri
                    if sr < r1 and ri < len(src):
                        ch_rows.append(src[sr])
                    else:
                        ch_rows.append(ITRow())
                chunk_grid.append(ch_rows)

            # If this is not the last chunk, add a C $0000 on ch0 row (r1-r0-1)
            # to immediately break to next order (skip padding rows).
            # Only needed when the last real row of this chunk is < 63.
            if k < n_chunks - 1:
                last_real = r1 - r0 - 1
                pad_row = chunk_grid[0][last_real]
                if pad_row.effect == 0:
                    pad_row.effect     = EFF_C
                    pad_row.effect_arg = 0
            elif rows < PATTERN_ROWS and n_chunks == 1:
                # Single chunk, short pattern → break at last real row
                last_real = rows - 1
                if last_real < PATTERN_ROWS - 1:
                    pad_row = chunk_grid[0][last_real]
                    if pad_row.effect == 0:
                        pad_row.effect     = EFF_C
                        pad_row.effect_arg = 0

            idx = len(chunks)
            chunks.append(chunk_grid)
            pat_chunks.append(idx)

        chunk_map.append(pat_chunks)
    return chunks, chunk_map


def _remap_bc_effects(chunks: list, chunk_map: list,
                      order_list: list, it_ord_to_taud_cue: dict,
                      num_channels: int) -> None:
    """Rewrite B/C effects using remapped order indices.

    B effects in all chunks are rewritten to point to the first chunk
    of the target IT order.  C effects in non-final chunks of a split
    pattern get a co-row B to skip remaining chunks.
    """
    # For each chunk, record which (it_pat, chunk_k, n_chunks) it came from.
    # We build this from chunk_map.
    chunk_info = {}   # chunk_idx → (it_pat_idx, k, n_chunks)
    for pi, pat_chunks in enumerate(chunk_map):
        n = len(pat_chunks)
        for k, ci in enumerate(pat_chunks):
            chunk_info[ci] = (pi, k, n)

    for ci, chunk_grid in enumerate(chunks):
        pi, k, n = chunk_info.get(ci, (0, 0, 1))

        for ch in range(num_channels):
            if ch >= len(chunk_grid): continue
            for row in chunk_grid[ch]:
                if row.effect == EFF_B:
                    it_tgt = row.effect_arg
                    taud_cue = it_ord_to_taud_cue.get(it_tgt, it_tgt)
                    row.effect_arg = taud_cue & 0xFF
                elif row.effect == EFF_C and k < n - 1:
                    # C in non-final chunk: need B to skip remaining chunks
                    # Find the cue index immediately after all chunks of this pat
                    # (the cue right after the last chunk of pi in the order list)
                    # We store the B in aux_effect; the Taud builder handles it.
                    skip_cue = _find_post_pat_cue(pi, order_list, chunk_map,
                                                  it_ord_to_taud_cue)
                    if skip_cue is not None:
                        row.aux_effect = (EFF_B, skip_cue & 0xFF)

def _find_post_pat_cue(pi: int, order_list: list, chunk_map: list,
                       it_ord_to_taud_cue: dict):
    """Return the Taud cue index that follows ALL chunks of pattern pi in the order list."""
    for taud_cue, it_ord in it_ord_to_taud_cue.items():
        # Find first Taud cue after the last chunk of pi
        pass
    # Simpler: walk the Taud cue list (we'll compute it in assemble_taud)
    # Return None for now — assemble_taud will do a second pass.
    return None


# ── Sample / instrument bin (same as s3m2taud) ────────────────────────────────

def build_sample_inst_bin_it(samples_or_proxy: list,
                              instr_data_by_slot: dict = None) -> tuple:
    """samples_or_proxy: list of ITSample | None, indexed 1-based (index 0 unused).

    instr_data_by_slot: optional dict mapping taud_slot → dict with keys:
        vol_env, vol_sus, pan_env, pan_sus, pf_env, pf_sus, pf_is_filter,
        inst_gv, fadeout, vib_speed, vib_depth, vib_sweep, vib_rate, vib_wave,
        default_pan, pps, ppc_taud, pan_swing, vol_swing, ifc, ifr,
        sample_detune, nna, dct, dca.
    All optional; missing keys default to neutral values.

    Returns (bin_bytes[SAMPLEINST_SIZE], offsets_dict).
    """
    pcm_list = [(i, s) for i, s in enumerate(samples_or_proxy)
                if s is not None and s.sample_data]

    total = sum(len(s.sample_data) for _, s in pcm_list)
    ratio = 1.0
    if total > SAMPLEBIN_SIZE:
        ratio = SAMPLEBIN_SIZE / total
        vprint(f"  info: sample bin overflow ({total} bytes); resampling all by {ratio:.4f}")
        for _, s in pcm_list:
            new_data    = resample_linear(s.sample_data, ratio)
            s.sample_data  = new_data
            s.length       = len(new_data)
            s.loop_beg     = max(0, int(s.loop_beg * ratio))
            s.loop_end     = max(0, min(int(s.loop_end * ratio), s.length))
            s.sus_beg      = max(0, int(s.sus_beg  * ratio))
            s.sus_end      = max(0, min(int(s.sus_end  * ratio), s.length))
            s.c5_speed     = max(1, int(s.c5_speed * ratio))

    sample_bin = bytearray(SAMPLEBIN_SIZE)
    offsets    = {}
    pos        = 0
    for idx, s in pcm_list:
        n = min(len(s.sample_data), SAMPLEBIN_SIZE - pos)
        if n <= 0:
            vprint(f"  warning: sample bin full, dropping '{s.name}'")
            offsets[idx] = 0; s.length = 0; continue
        sample_bin[pos:pos+n] = s.sample_data[:n]
        offsets[idx] = pos
        if n < len(s.sample_data):
            vprint(f"  warning: '{s.name}' truncated {len(s.sample_data)} → {n}")
            s.length = n
            s.loop_end = min(s.loop_end, n)
            s.sus_end  = min(s.sus_end,  n)
        pos += n

    # 192-byte instrument layout (terranmon.txt:1997-2070).
    USE_ENV_BIT = 0x0020   # b — set whenever the engine should evaluate the envelope

    def _write_env(buf: bytearray, base: int, env_pts):
        """Write 25 (value, minifloat) pairs starting at `buf[base]`. Pads
        with the previous value (or 0/0x80) and offset=0 if shorter than 25."""
        for k in range(25):
            if env_pts and k < len(env_pts):
                val, mf = env_pts[k]
            else:
                val = (env_pts[-1][0] if env_pts else 0)
                mf  = 0
            buf[base + k*2]     = val & 0xFF
            buf[base + k*2 + 1] = mf  & 0xFF

    inst_bin = bytearray(INSTBIN_SIZE)
    for i, s in enumerate(samples_or_proxy):
        taud_idx = i  # samples_or_proxy is 0-based here; slot 0 unused
        if i == 0 or i >= 256 or s is None:
            continue
        ptr      = offsets.get(i, 0) & 0xFFFFFFFF
        s_len    = min(s.length, 65535)
        c2spd    = min(s.c5_speed, 65535)
        # Sustain loop wins over the regular loop because Taud carries one loop
        # region. After key-off the engine drops the loop entirely (terranmon.txt:2007).
        if s.flags & IT_SMP_SUS_LOOP:
            ls = min(s.sus_beg, 65535)
            le = min(s.sus_end, 65535)
            sustain_bit = 0x4
            pingpong_active = bool(s.flags & IT_SMP_PINGPONG_SUS)
            has_active_loop = True
        elif s.has_loop:
            ls = min(s.loop_beg, 65535)
            le = min(s.loop_end, 65535)
            sustain_bit = 0x0
            pingpong_active = bool(s.flags & IT_SMP_PINGPONG)
            has_active_loop = True
        else:
            ls = min(s.loop_beg, 65535)
            le = min(s.loop_end, 65535)
            sustain_bit = 0x0
            pingpong_active = False
            has_active_loop = False
        if has_active_loop and pingpong_active:
            loop_mode = 2   # backandforth
        elif has_active_loop:
            loop_mode = 1   # forward loop
        else:
            loop_mode = 0   # no loop
        flags_byte = (loop_mode & 0x3) | sustain_bit

        base = taud_idx * 192
        struct.pack_into('<I', inst_bin, base + 0,  ptr)
        struct.pack_into('<H', inst_bin, base + 4,  s_len)
        struct.pack_into('<H', inst_bin, base + 6,  c2spd)
        struct.pack_into('<H', inst_bin, base + 8,  0) # play start. IT samples always start playing from zero
        struct.pack_into('<H', inst_bin, base + 10, ls)
        struct.pack_into('<H', inst_bin, base + 12, le)
        inst_bin[base + 14] = flags_byte

        idata = (instr_data_by_slot or {}).get(taud_idx) or {}
        vol_env = idata.get('vol_env')
        pan_env = idata.get('pan_env')
        pf_env  = idata.get('pf_env')
        vol_sus = idata.get('vol_sus', USE_ENV_BIT)
        pan_sus = idata.get('pan_sus', 0)
        pf_sus  = idata.get('pf_sus',  0)
        # Sample-mode default IGV: fold sample default vol (Sv) and sample GV
        # into Taud's IGV. Instrument-mode supplies inst_gv pre-folded.
        if 'inst_gv' in idata:
            inst_gv = idata['inst_gv']
        else:
            smp_vol_default = min(getattr(s, 'vol', 64), 64)
            smp_gv_default  = min(getattr(s, 'gv', 64), 64)
            inst_gv = min(255, round(smp_vol_default * smp_gv_default * 255 / (64 * 64)))
        # IT fadeout (file-stored 0..2048; ITTECH practical max ≈ 1024) maps verbatim to
        # the Taud 12-bit fadeStep. The player picks divisor 1024 in IT mode (vs 65536
        # in FT2 mode) so that one fadeStep unit per tick matches Schism's
        # `chan->fadeout_volume -= (stored<<5)<<1` semantics (sndmix.c:331-339,
        # effects.c:1261). Clamp defensively to 4095.
        fadeout = min(0xFFF, idata.get('fadeout', 0) & 0xFFFF)

        struct.pack_into('<H', inst_bin, base + 15, vol_sus & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 17, pan_sus & 0xFFFF)
        struct.pack_into('<H', inst_bin, base + 19, pf_sus  & 0xFFFF)

        if vol_env:
            _write_env(inst_bin, base + 21,  vol_env)
        else:
            # Single-point envelope held at full-scale; the per-sample level is
            # carried by IGV (byte 171), so the envelope must be a unit multiplier.
            inst_bin[base + 21] = 63
            inst_bin[base + 22] = 0
            # Force engine to use this single point.
            struct.pack_into('<H', inst_bin, base + 15, USE_ENV_BIT)

        if pan_env:
            _write_env(inst_bin, base + 71, pan_env)
        else:
            for k in range(25):
                inst_bin[base + 71 + k*2]     = 0x80
                inst_bin[base + 71 + k*2 + 1] = 0x00

        if pf_env:
            _write_env(inst_bin, base + 121, pf_env)
        else:
            for k in range(25):
                inst_bin[base + 121 + k*2]     = 0x80
                inst_bin[base + 121 + k*2 + 1] = 0x00

        inst_bin[base + 171] = inst_gv & 0xFF
        inst_bin[base + 172] = fadeout & 0xFF                                # low 8 bits
        # Byte 173: low nibble = fadeout high bits (0b 0000 ffff).
        inst_bin[base + 173] = (fadeout >> 8) & 0x0F
        inst_bin[base + 174] = idata.get('vol_swing',   0) & 0xFF
        inst_bin[base + 175] = idata.get('vib_speed',   0) & 0xFF
        inst_bin[base + 176] = idata.get('vib_sweep',   0) & 0xFF
        inst_bin[base + 177] = idata.get('default_pan', 0x80) & 0xFF
        struct.pack_into('<H', inst_bin, base + 178,
                         idata.get('ppc_taud', 0x5000) & 0xFFFF)
        # PPS is signed (-128..+127); struct 'b' handles the conversion.
        struct.pack_into('b', inst_bin, base + 180,
                         max(-128, min(127, idata.get('pps', 0))))
        inst_bin[base + 181] = idata.get('pan_swing', 0) & 0xFF
        inst_bin[base + 182] = idata.get('ifc',     255) & 0xFF
        inst_bin[base + 183] = idata.get('ifr',     255) & 0xFF
        # Bytes 184-185: sample detune (4096-TET, signed stored as u16).
        struct.pack_into('<H', inst_bin, base + 184,
                         idata.get('sample_detune', 0) & 0xFFFF)
        # Byte 186: instrument flag — 0b 000 www nn
        #     nn = NNA (Taud encoding: 00=note off, 01=cut, 10=continue, 11=fade)
        #     www = vibrato waveform (0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up FT2)
        nna = idata.get('nna', 0) & 0x03
        vib_wave = idata.get('vib_wave', 0) & 0x07
        inst_bin[base + 186] = (vib_wave << 2) | nna
        # Byte 187: vibrato depth (0..255 full range).
        inst_bin[base + 187] = idata.get('vib_depth', 0) & 0xFF
        # Byte 188: vibrato rate (0..255 full range, IT samplewise Vir).
        inst_bin[base + 188] = idata.get('vib_rate', 0) & 0xFF
        # Byte 189: duplicate-check / action (IT-only — bits 0-1 = DCT, bits 2-3 = DCA).
        #   DCT: 0=off, 1=note, 2=sample, 3=instrument.
        #   DCA: 0=note cut, 1=note off, 2=note fade.
        dct = idata.get('dct', 0) & 0x03
        dca = idata.get('dca', 0) & 0x03
        inst_bin[base + 189] = (dca << 2) | dct
        # Bytes 190-191: reserved (already zeroed).

        vprint(f"  instrument[{taud_idx}] '{s.name}' ptr:{ptr} c5spd:{s.c5_speed}")

    return bytes(sample_bin) + bytes(inst_bin), offsets


# ── Pattern builder ───────────────────────────────────────────────────────────

def _it_default_pan(raw_pan: int) -> int:
    """Convert raw IT channel-pan byte to Taud 0..63."""
    if raw_pan == 100:   # surround → centre
        return 31
    p = raw_pan & 0x7F
    return min(0x3F, round(p * 63 / 64))

def build_pattern_it(chunk_grid: list, ch_idx: int, default_pan: int,
                     inst_vols: dict, amiga_mode: bool = False) -> bytes:
    """Build a 512-byte Taud pattern for one IT channel from a 64-row chunk grid."""
    out = bytearray(PATTERN_BYTES)
    rows = chunk_grid[ch_idx] if ch_idx < len(chunk_grid) else [ITRow()] * PATTERN_ROWS
    last_inst = 0
    last_note_it = -1

    for r, cell in enumerate(rows[:PATTERN_ROWS]):
        # ── Resolve vol-col into overrides ──────────────────────────────────
        vs, vv, pan_from_vc, aux_eff = decode_volcol(cell.volcol)

        # If vol-col provides an aux effect and cell has no main effect, use it
        if aux_eff is not None and cell.effect == 0:
            cell.effect, cell.effect_arg = aux_eff
            aux_eff = None
        elif aux_eff is not None:
            vprint(f"    ch{ch_idx} row{r}: dropped vol-col aux effect "
                   f"(main effect slot occupied)")
            aux_eff = None

        # If vol-col has a pan override
        if pan_from_vc is not None:
            cell.pan_set = pan_from_vc

        # Encode main effect
        op, arg16, vol_override, pan_override = encode_effect_it(
            cell.effect, cell.effect_arg, ch_idx, r, amiga_mode=amiga_mode)

        # ── Note ────────────────────────────────────────────────────────────
        note_taud = NOTE_NOP
        if cell.note >= 0:
            note_taud = encode_note_it(cell.note)

        if cell.inst > 0:
            last_inst = cell.inst

        note_triggers = (0 <= (cell.note if cell.note >= 0 else -1) <= 119)

        # ── Volume column ────────────────────────────────────────────────────
        # Priority: explicit cell vol (vol-col 0-64) > vol-col slide > main-
        # effect vol override > nop. The per-instrument default volume is
        # baked into IGV (byte 171), so the engine resolves note-trigger
        # default volume itself; the converter no longer emits SEL_SET=Sv.
        if cell.volcol >= 0 and cell.volcol <= VC_VOL_HI:
            vol_sel, vol_value = SEL_SET, min(cell.volcol, 0x3F)
        elif vs != SEL_FINE or vv != 0:
            vol_sel, vol_value = vs, vv
        elif vol_override is not None:
            vol_sel, vol_value = vol_override
        else:
            vol_sel, vol_value = SEL_FINE, 0

        if cell.note is not None and 0 <= (cell.note if cell.note >= 0 else -1) <= 119:
            last_note_it = cell.note

        # ── Pan column ───────────────────────────────────────────────────────
        if cell.pan_set is not None:
            pan_sel, pan_value = SEL_SET, cell.pan_set
        elif pan_override is not None:
            pan_sel, pan_value = pan_override
        elif r == 0:
            pan_sel, pan_value = SEL_SET, default_pan & 0x3F
        else:
            pan_sel, pan_value = SEL_FINE, 0

        # Handle aux_effect (B) stored on a C cell for chunk-skip
        if cell.aux_effect is not None:
            aux_cmd, aux_arg = cell.aux_effect
            if aux_cmd == EFF_B and op == TOP_C:
                # Encode as B effect; C row break handled by engine's simultaneous B+C
                op   = TOP_C
                # We need to emit both; store the B's target in arg16 high byte
                # Taud simultaneous B+C: B sets order, C sets row. Engine handles.
                # Encoding: keep op=TOP_C (pattern break), store B target in
                # a separate "B command on another channel". We can't encode two
                # effects in one cell, so instead just emit the B effect here
                # and let the order index point past the remaining chunks.
                # This is a best-effort; the engine should honour the lowest-channel B.
                op    = TOP_B
                arg16 = aux_arg & 0xFF

        vol_byte = (vol_value & 0x3F) | ((vol_sel & 0x3) << 6)
        pan_byte = (pan_value & 0x3F) | ((pan_sel & 0x3) << 6)

        taud_inst = last_inst & 0xFF if (note_triggers or cell.inst > 0) else 0

        base = r * 8
        struct.pack_into('<H', out, base + 0, note_taud)
        out[base + 2] = taud_inst
        out[base + 3] = vol_byte
        out[base + 4] = pan_byte
        out[base + 5] = op & 0xFF
        struct.pack_into('<H', out, base + 6, arg16 & 0xFFFF)

    return bytes(out)


# ── Main assembly ─────────────────────────────────────────────────────────────

def relocate_late_note_delays(patterns_rows: list, order_list: list,
                              num_channels: int, initial_speed: int) -> None:
    """Move SDx-delayed notes to the next row when x ≥ tick speed.

    IT triggers a Note Delay during the current row; if x reaches the tick
    speed, the trigger never lands. When the next row in the same channel is
    empty, relocate the note (with delay = x − speed) so it actually plays.
    """
    visited = set()
    for order in order_list:
        if order >= IT_ORD_END:
            break
        if order >= len(patterns_rows) or order in visited:
            continue
        visited.add(order)
        grid, rows = patterns_rows[order]
        speed = initial_speed
        for r in range(rows):
            for ch in range(min(num_channels, len(grid))):
                cell = grid[ch][r]
                if cell.effect == EFF_A and cell.effect_arg > 0:
                    speed = cell.effect_arg
                    break
            if r + 1 >= rows or speed <= 0:
                continue
            for ch in range(min(num_channels, len(grid))):
                cell = grid[ch][r]
                if cell.effect != EFF_S or cell.note < 0:
                    continue
                if ((cell.effect_arg >> 4) & 0xF) != 0xD:
                    continue
                x = cell.effect_arg & 0xF
                if x < speed:
                    continue
                nxt = grid[ch][r + 1]
                if (nxt.note >= 0 or nxt.inst or nxt.effect or nxt.effect_arg
                        or nxt.vol != -1 or nxt.volcol != -1
                        or nxt.pan_set is not None or nxt.aux_effect is not None):
                    continue
                new_delay = x - speed
                nxt.note       = cell.note
                nxt.inst       = cell.inst
                nxt.vol        = cell.vol
                nxt.volcol     = cell.volcol
                nxt.pan_set    = cell.pan_set
                nxt.aux_effect = cell.aux_effect
                if new_delay > 0:
                    nxt.effect     = EFF_S
                    nxt.effect_arg = 0xD0 | (new_delay & 0xF)
                cell.note       = -1
                cell.inst       = 0
                cell.vol        = -1
                cell.volcol     = -1
                cell.pan_set    = None
                cell.aux_effect = None
                cell.effect     = 0
                cell.effect_arg = 0
                vprint(f"  fix: pat{order} ch{ch} row{r}: SD{x:X} ≥ speed{speed}, "
                       f"moved note to row{r+1}"
                       + (f" with SD{new_delay:X}" if new_delay > 0 else ""))


def find_initial_bpm_speed(patterns_rows: list, order_list: list,
                            default_speed: int, default_tempo: int) -> tuple:
    speed = default_speed or 6
    tempo = default_tempo or 125
    for order in order_list:
        if order >= IT_ORD_END: break
        if order >= len(patterns_rows): continue
        grid, _rows = patterns_rows[order]
        for ch_rows in grid:
            if not ch_rows: continue
            cell = ch_rows[0]
            if cell.effect == EFF_A and cell.effect_arg > 0:
                speed = cell.effect_arg
            if cell.effect == EFF_T and cell.effect_arg > 0:
                tempo = cell.effect_arg
        break
    return speed, tempo

def _active_channels(h: ITHeader, patterns_rows: list) -> list:
    """Return up to 20 non-muted, in-use channel indices."""
    # Muted = bit 7 of chnl_pan set, or == 0xC0
    muted = set()
    for i, p in enumerate(h.chnl_pan):
        if p & 0x80 or p == 0xC0:
            muted.add(i)

    # In-use = any non-empty cell appears on this channel
    in_use = set()
    for grid, rows in patterns_rows:
        for ch in range(64):
            if ch >= len(grid): continue
            for cell in grid[ch]:
                if cell.note >= 0 or cell.inst > 0 or cell.effect != 0:
                    in_use.add(ch)
                    break

    active = [i for i in range(64) if i in in_use and i not in muted]
    if len(active) > NUM_VOICES:
        vprint(f"  warning: {len(active)} active channels; capping at {NUM_VOICES}")
        active = active[:NUM_VOICES]
    return active

def assemble_taud(h: ITHeader, samples: list, instruments: list,
                  patterns_rows: list, decompress: bool) -> bytes:
    # ── Resolve IT recalls ───────────────────────────────────────────────────
    vprint("  resolving IT recalls…")
    resolve_it_recalls(patterns_rows, h.order_list, 64, h.link_gef,
                       old_effects=h.old_effects)

    init_speed, _ = find_initial_bpm_speed(patterns_rows, h.order_list,
                                           h.initial_speed, h.initial_tempo)
    relocate_late_note_delays(patterns_rows, h.order_list, 64, init_speed)

    # ── Check SBx chunk crossing (warn only) ─────────────────────────────────
    for pi, (grid, rows) in enumerate(patterns_rows):
        if rows <= PATTERN_ROWS: continue
        n_chunks = (rows + PATTERN_ROWS - 1) // PATTERN_ROWS
        for ch in range(64):
            if ch >= len(grid): continue
            loop_start_chunk = None
            for r, cell in enumerate(grid[ch]):
                if cell.effect == EFF_S:
                    sub = (cell.effect_arg >> 4) & 0xF
                    val = cell.effect_arg & 0xF
                    k = r // PATTERN_ROWS
                    if sub == 0xB and val == 0:
                        loop_start_chunk = k
                    elif sub == 0xB and val > 0:
                        if loop_start_chunk is not None and k != loop_start_chunk:
                            vprint(f"  warning: pattern {pi} ch{ch}: SBx crosses "
                                   f"chunk boundary (loops may misbehave)")
                            break

    # ── Split patterns into 64-row chunks ────────────────────────────────────
    vprint("  splitting patterns…")
    chunks, chunk_map = split_patterns(patterns_rows)

    # ── Choose active channels ───────────────────────────────────────────────
    active_channels = _active_channels(h, patterns_rows)
    C = len(active_channels)
    if C == 0:
        sys.exit("error: no active channels found")

    # ── Build the ordered list of (taud_chunk_idx, voice_idx) triples ────────
    # Expand order list: each IT order → sequence of chunk indices for that pattern
    taud_cue_list = []   # list of chunk_idx (source patterns, already chunked)
    it_ord_to_taud_cue = {}   # first taud cue for IT order i

    for oi, order in enumerate(h.order_list):
        if order == IT_ORD_END:
            break
        if order == IT_ORD_SKIP:
            continue
        if order >= len(chunk_map):
            continue
        it_ord_to_taud_cue.setdefault(oi, len(taud_cue_list))
        for ci in chunk_map[order]:
            taud_cue_list.append(ci)

    # ── Remap B effects ──────────────────────────────────────────────────────
    _remap_bc_effects(chunks, chunk_map, h.order_list, it_ord_to_taud_cue,
                      len(active_channels))

    # ── Build sample proxy list (0-indexed, slot 0 unused) ──────────────────
    # When use_instruments: map Taud instrument slots to samples via canonical_sample.
    # Pattern cells carry IT instrument numbers; for use_instruments mode, those
    # are instrument indices; we remap to samples below.
    # Taud only knows "instrument" slots (1-based, 8-bit). We lay samples in order.
    if h.use_instruments:
        # Build a proxy sample list where Taud inst slot = IT inst index,
        # resolved to the canonical sample. Slot 0 unused.
        proxy = [None] * (max(len(instruments), 256) + 1)
        inst_vols = {}
        instr_data_by_slot = {}
        for ii, inst in enumerate(instruments):
            taud_slot = ii + 1
            if taud_slot >= 256: break
            if inst is None: continue
            si = inst.canonical_sample - 1   # 0-based sample index
            if si < 0 or si >= len(samples) or samples[si] is None:
                continue
            src_smp = samples[si]
            proxy[taud_slot] = src_smp
            # IT cell-trigger initial volume comes from the sample's default
            # volume (Sv, 0..64). It is folded into the Taud instrument's IGV
            # (byte 171) along with IT inst.gv (0..128) and sample gv (0..64),
            # so the engine applies all three as a single multiplier on every
            # fresh trigger. inst_vols is retained only for legacy callers.
            smp_default_vol = min(getattr(src_smp, 'vol', 64), 64)
            inst_vols[taud_slot] = min(smp_default_vol, 0x3F)

            # IT inst.gv (0..128) * sample.gv (0..64) * sample.vol (0..64)
            # collapse into Taud's single instrumentwise IGV (0..255).
            smp_gv = min(getattr(src_smp, 'gv', 64), 64)
            inst_gv_255 = min(255, round(inst.gv * smp_gv * smp_default_vol * 255
                                         / (128 * 64 * 64)))

            # IT pitch-pan centre: note number 0..119 (C-5 = 60). The Taud
            # representation is the absolute 4096-TET note value used in patterns
            # (anchored to TAUD_C4 at IT note 60).
            ppc_taud = TAUD_C4 + (max(0, min(119, inst.ppc)) - 60) * 4096 // 12

            # IT default pan: instrumentwise (IMPI+0x19) takes precedence when
            # its "use" bit is set; otherwise samplewise (IMPS+0x2F) wins when
            # its "use" bit is set; otherwise centre (0x80). Both fields encode
            # 0..64 → rescale to Taud's 0..255 range.
            smp_dfp_raw = getattr(src_smp, 'dfp', 0)
            if inst.dfp is not None:
                default_pan = min(255, max(0, round(inst.dfp * 255 / 64)))
            elif smp_dfp_raw & 0x80:
                default_pan = min(255, max(0, round((smp_dfp_raw & 0x7F) * 255 / 64)))
            else:
                default_pan = 0x80

            # Auto-vibrato lives on the canonical sample (not the IT instrument).
            # IT samplewise auto-vibrato: Vis (speed 0..64), Vid (depth 0..64),
            # Vir (rate 0..255 — IT-style ramp-in), Vit (waveform 0..3).
            # Taud byte 175 (Vibrato Speed) follows FT2 0..255 scale: rescale Vis.
            # Taud byte 187 (Vibrato Depth) is full 0..255: rescale Vid 0..64 → 0..255.
            # Taud byte 188 (Vibrato Rate) is IT Vir verbatim.
            # Taud byte 176 (Vibrato Sweep) is FT2-only — leave 0 for IT.
            vib_speed_taud = min(255, round(src_smp.av_speed * 255 / 64))
            vib_depth_taud = min(255, round(src_smp.av_depth * 255 / 64))
            # IT NNA (0=cut, 1=continue, 2=note off, 3=note fade) →
            # Taud NNA  (00=note off, 01=cut, 10=continue, 11=fade).
            it_to_taud_nna = (0b01, 0b10, 0b00, 0b11)
            nna_taud = it_to_taud_nna[inst.nna & 0x03]

            instr_data_by_slot[taud_slot] = {
                'vol_env': inst.vol_envelope,
                'vol_sus': inst.vol_env_sustain,
                'pan_env': inst.pan_envelope,
                'pan_sus': inst.pan_env_sustain,
                'pf_env':  inst.pf_envelope,
                'pf_sus':  inst.pf_env_sustain,
                'inst_gv': inst_gv_255,
                'fadeout': inst.fadeout,
                'vib_speed':  vib_speed_taud,
                'vib_depth':  vib_depth_taud,
                'vib_sweep':  0,                       # FT2-only; IT uses vib_rate
                'vib_rate':   src_smp.av_sweep & 0xFF, # IT Vir (samplewise sweep)
                'vib_wave':   src_smp.av_wave & 0x07,  # IT vib type (0..3)
                'default_pan': default_pan,
                'pps':        inst.pps,
                'ppc_taud':   ppc_taud & 0xFFFF,
                'pan_swing':  min(255, round(inst.rp * 255 / 64)) if inst.rp else 0,
                'vol_swing':  min(255, round(inst.rv * 255 / 100)) if inst.rv else 0,
                'ifc':        inst.ifc,
                'ifr':        inst.ifr,
                'sample_detune': 0,                    # IT samples have no finetune
                'nna':        nna_taud,
                'dct':        inst.dct,
                'dca':        inst.dca,
            }
        sampleinst_raw, _ = build_sample_inst_bin_it(proxy, instr_data_by_slot)
    else:
        # Samples referenced directly; proxy is samples list (0-based, slot 0 unused)
        proxy = [None] + list(samples)
        inst_vols = {
            i+1: min(s.vol, 0x3F)
            for i, s in enumerate(samples)
            if s is not None
        }
        sampleinst_raw, _ = build_sample_inst_bin_it(proxy)

    assert len(sampleinst_raw) == SAMPLEINST_SIZE

    compressed   = gzip.compress(sampleinst_raw, compresslevel=9, mtime=0)
    comp_size    = len(compressed)
    vprint(f"  sample+inst bin: {SAMPLEINST_SIZE} → {comp_size} bytes (gzip)")

    # ── BPM / speed ──────────────────────────────────────────────────────────
    speed, tempo = find_initial_bpm_speed(patterns_rows, h.order_list,
                                          h.initial_speed, h.initial_tempo)
    tempo     = max(24, min(280, tempo))
    bpm_stored = (tempo - 24) & 0xFF
    vprint(f"  initial speed={speed}, tempo={tempo} BPM")

    # ── Pattern bin ──────────────────────────────────────────────────────────
    vprint("  building pattern bin…")
    default_pans = [_it_default_pan(h.chnl_pan[ch]) for ch in active_channels]
    total_taud_pats = len(taud_cue_list) * C
    if total_taud_pats > NUM_PATTERNS_MAX:
        sys.exit(
            f"error: {len(taud_cue_list)} cues × {C} channels = "
            f"{total_taud_pats} > {NUM_PATTERNS_MAX} Taud pattern limit."
        )

    pat_bin = bytearray()
    for ci in taud_cue_list:
        cg = chunks[ci]
        for vi, ch in enumerate(active_channels):
            pat_bin += build_pattern_it(cg, ch, default_pans[vi], inst_vols,
                                          amiga_mode=not h.linear_slides)

    orig_count   = len(taud_cue_list) * C
    pat_bin, pat_remap, num_taud_pats = deduplicate_patterns(bytes(pat_bin), orig_count)
    vprint(f"  patterns: {orig_count} → {num_taud_pats} unique "
           f"({orig_count - num_taud_pats} deduplicated)")

    # ── Cue sheet ────────────────────────────────────────────────────────────
    vprint("  building cue sheet…")
    song_offset = TAUD_HEADER_SIZE + comp_size + TAUD_SONG_ENTRY
    sheet       = bytearray(NUM_CUES * CUE_SIZE)
    for c in range(NUM_CUES):
        sheet[c*CUE_SIZE:c*CUE_SIZE+CUE_SIZE] = encode_cue([], 0)

    last_active = -1
    for cue_idx, ci in enumerate(taud_cue_list):
        if cue_idx >= NUM_CUES: break
        base_pat = cue_idx * C
        pats = [pat_remap[base_pat + vi] for vi in range(C)]
        sheet[cue_idx*CUE_SIZE:(cue_idx+1)*CUE_SIZE] = encode_cue(pats, 0)
        last_active = cue_idx

    if last_active >= 0:
        sheet[last_active * CUE_SIZE + 30] = 0x01
    else:
        sheet[30] = 0x01

    # ── Header ───────────────────────────────────────────────────────────────
    sig    = (SIGNATURE + b' ' * 14)[:14]
    header = (
        TAUD_MAGIC +
        bytes([TAUD_VERSION, 1]) +
        struct.pack('<I', comp_size) +
        b'\x00\x00\x00\x00' +
        sig
    )
    assert len(header) == TAUD_HEADER_SIZE

    # Compress pattern bin and cue sheet (per Taud spec)
    pat_comp = gzip.compress(bytes(pat_bin), compresslevel=9, mtime=0)
    cue_comp = gzip.compress(bytes(sheet),   compresslevel=9, mtime=0)
    vprint(f"  pattern bin: {len(pat_bin)} → {len(pat_comp)} bytes (gzip)")
    vprint(f"  cue sheet:   {len(sheet)} → {len(cue_comp)} bytes (gzip)")

    # flags byte: bit 1 (f) = Amiga pitch-slide mode (IT linear_slides flag inverted)
    # bit 2 (m) cleared: IT fadeout-zero policy — stored fadeout=0 means "no fadeout".
    flags_byte = 0x00 if h.linear_slides else 0x02
    # IT global/mix volumes are 0..128; rescale to Taud's 0..255 (clamped).
    global_vol_taud = min(0xFF, round(h.global_vol * 255 / 128))
    mixing_vol_taud = min(0xFF, round(h.mix_vol    * 255 / 128))
    song_table = encode_song_entry(
        song_offset=song_offset,
        num_voices=C,
        num_patterns=num_taud_pats,
        bpm_stored=bpm_stored,
        tick_rate=speed,
        base_note=0xA000,   # C9
        base_freq=8363.0,
        flags_byte=flags_byte,
        pat_bin_comp_size=len(pat_comp),
        cue_sheet_comp_size=len(cue_comp),
        global_vol=global_vol_taud,
        mixing_vol=mixing_vol_taud,
    )
    assert len(song_table) == TAUD_SONG_ENTRY

    return header + compressed + song_table + pat_comp + cue_comp


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',  help='Input .it file')
    ap.add_argument('output', help='Output .taud file')
    ap.add_argument('-v', '--verbose', action='store_true')
    ap.add_argument('--no-decompress', action='store_true',
                    help='Treat compressed IT samples as silent (debug)')
    args = ap.parse_args()
    set_verbose(args.verbose)

    with open(args.input, 'rb') as f:
        data = f.read()

    vprint(f"parsing '{args.input}' ({len(data)} bytes)…")
    h = parse_it_header(data)
    vprint(f"  title: '{h.title}'")
    vprint(f"  orders={h.ord_count} insts={h.ins_count} "
           f"samples={h.smp_count} patterns={h.pat_count}")
    vprint(f"  flags: linear={h.linear_slides} use_inst={h.use_instruments} "
           f"link_gef={h.link_gef}")

    samples     = parse_samples(data, h, decompress=not args.no_decompress)
    instruments = parse_instruments(data, h) if h.use_instruments else []
    patterns_rows = parse_patterns(data, h)

    taud = assemble_taud(h, samples, instruments, patterns_rows,
                         decompress=not args.no_decompress)

    with open(args.output, 'wb') as f:
        f.write(taud)

    print(f"wrote {len(taud)} bytes to '{args.output}'")
    if args.verbose:
        print(f"  magic ok: {taud[:8].hex()}", file=sys.stderr)
        sig_off = TAUD_HEADER_SIZE - 14
        print(f"  signature: {taud[sig_off:sig_off+14]}", file=sys.stderr)

if __name__ == '__main__':
    main()
