"""taud_common.py — Shared constants and helpers for *2taud converters.

Imported by s3m2taud.py, it2taud.py, and mod2taud.py. Holds the Taud
container constants, the effect-letter index table, and the small set
of helpers (sample resampler, vol/pan column packer, cue encoder,
pattern deduper, sample normaliser) that all three converters used to
duplicate verbatim.
"""

import struct
import sys


# ── Verbose logging (shared across converters via set_verbose) ───────────────

VERBOSE = False

def set_verbose(b: bool) -> None:
    global VERBOSE
    VERBOSE = bool(b)

def vprint(*a, **kw) -> None:
    if VERBOSE:
        print(*a, **kw, file=sys.stderr)


# ── Taud container constants ─────────────────────────────────────────────────

TAUD_MAGIC       = bytes([0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64])
TAUD_VERSION     = 1
TAUD_HEADER_SIZE = 32       # magic(8)+ver(1)+numSongs(1)+compSize(4)+projOff(4)+sig(14)
TAUD_SONG_ENTRY  = 32       # full spec entry (see encode_song_entry)
SAMPLEBIN_SIZE   = 737280
INSTBIN_SIZE     = 49152    # 256 instruments × 192 bytes
SAMPLEINST_SIZE  = SAMPLEBIN_SIZE + INSTBIN_SIZE
PATTERN_ROWS     = 64
PATTERN_BYTES    = PATTERN_ROWS * 8     # 512
NUM_PATTERNS_MAX = 4095
NUM_CUES         = 1024
CUE_SIZE         = 32
NUM_VOICES       = 20

# Note word sentinels
NOTE_NOP    = 0xFFFF
NOTE_KEYOFF = 0x0000
NOTE_CUT    = 0xFFFE
TAUD_C4     = 0x5000   # The audio engine's Middle C

# Taud effect opcodes (base-36: 0..9 → 0x00..0x09, A..Z → 0x0A..0x23)
TOP_NONE = 0x00
TOP_A    = 0x0A
TOP_B    = 0x0B
TOP_C    = 0x0C
TOP_D    = 0x0D
TOP_E    = 0x0E
TOP_F    = 0x0F
TOP_G    = 0x10
TOP_H    = 0x11
TOP_I    = 0x12
TOP_J    = 0x13
TOP_K    = 0x14
TOP_L    = 0x15
TOP_O    = 0x18
TOP_Q    = 0x1A
TOP_R    = 0x1B
TOP_S    = 0x1C
TOP_T    = 0x1D
TOP_U    = 0x1E
TOP_V    = 0x1F
TOP_W    = 0x20
TOP_Y    = 0x22

# Volume / pan column selectors (2-bit field at top of vol/pan byte)
SEL_SET  = 0     # 6-bit value: set vol / pan
SEL_UP   = 1     # 6-bit per-tick slide up / right
SEL_DOWN = 2     # 6-bit per-tick slide down / left
SEL_FINE = 3     # 1-bit dir + 5-bit magnitude, fired on tick 0

# 12-TET semitone → Taud J-arpeggio byte (high byte of pitch delta).
# byte = round(semitone * 4096 / 12 / 256) = round(semitone * 4 / 3).
J_SEMI_TABLE = [0x00, 0x01, 0x03, 0x04, 0x05, 0x07, 0x08, 0x09,
                0x0B, 0x0C, 0x0D, 0x0F, 0x10, 0x11, 0x13, 0x14]

# Effect-letter indices (1-based; A=1..Z=26). Shared by s3m2taud and it2taud.
EFF_A = 1;  EFF_B = 2;  EFF_C = 3;  EFF_D = 4;  EFF_E = 5
EFF_F = 6;  EFF_G = 7;  EFF_H = 8;  EFF_I = 9;  EFF_J = 10
EFF_K = 11; EFF_L = 12; EFF_M = 13; EFF_N = 14; EFF_O = 15
EFF_P = 16; EFF_Q = 17; EFF_R = 18; EFF_S = 19; EFF_T = 20
EFF_U = 21; EFF_V = 22; EFF_W = 23; EFF_X = 24; EFF_Y = 25
EFF_Z = 26


# ── Helpers ──────────────────────────────────────────────────────────────────

def d_arg_to_col(arg: int):
    """Convert a two-nibble D-style vol/pan slide arg into a column override.

    Returns (selector, value) or None for no-op. Volume column treats
    selector 1 as up / 2 as down; pan column reuses 1 = right, 2 = left.
    Both-nibbles-non-zero (and neither $F) is ambiguous; ST3/PT/IT all
    prefer up.
    """
    if arg == 0:
        return None
    hi = (arg >> 4) & 0xF
    lo = arg & 0xF
    if hi == 0xF and lo > 0:
        return (SEL_FINE, lo & 0x1F)              # fine slide down (dir bit 0)
    if lo == 0xF and hi > 0:
        return (SEL_FINE, (hi & 0x1F) | 0x20)     # fine slide up (dir bit 1)
    if hi > 0 and lo == 0:
        return (SEL_UP, hi)
    if lo > 0 and hi == 0:
        return (SEL_DOWN, lo)
    return (SEL_UP, hi)


def resample_linear(data: bytes, ratio: float) -> bytes:
    """Resample bytes by ratio (< 1 = downsample) using linear interpolation."""
    if not data:
        return data
    n_out = max(1, int(len(data) * ratio))
    out   = bytearray(n_out)
    for i in range(n_out):
        src  = i / ratio
        i0   = int(src)
        frac = src - i0
        i1   = min(i0 + 1, len(data) - 1)
        v    = data[i0] * (1.0 - frac) + data[i1] * frac
        out[i] = int(v + 0.5) & 0xFF
    return bytes(out)


def encode_cue(patterns12: list, instruction: int) -> bytearray:
    """Encode a 32-byte cue entry for up to 20 voices with 12-bit pattern numbers."""
    pats = list(patterns12) + [0xFFF] * NUM_VOICES
    pats = pats[:NUM_VOICES]
    entry = bytearray(CUE_SIZE)
    for i in range(10):      # 10 bytes: 2 voices per byte
        v0, v1 = pats[i*2], pats[i*2+1]
        entry[i]      = ((v0 & 0xF) << 4) | (v1 & 0xF)               # low nybbles
        entry[10 + i] = (((v0 >> 4) & 0xF) << 4) | ((v1 >> 4) & 0xF) # mid nybbles
        entry[20 + i] = (((v0 >> 8) & 0xF) << 4) | ((v1 >> 8) & 0xF) # high nybbles
    entry[30] = instruction & 0xFF
    return entry


def deduplicate_patterns(pat_bin: bytes, num_pats: int) -> tuple:
    """Consolidate identical 512-byte Taud patterns into a single copy.

    Returns (deduped_bin, remap, num_unique) where remap[original_idx] =
    canonical_idx.
    """
    seen = {}
    remap = {}
    canonical = []
    for i in range(num_pats):
        pat = pat_bin[i * PATTERN_BYTES : (i + 1) * PATTERN_BYTES]
        if pat in seen:
            remap[i] = seen[pat]
        else:
            ci = len(canonical)
            seen[pat] = ci
            remap[i] = ci
            canonical.append(pat)
    return b''.join(canonical), remap, len(canonical)


def encode_song_entry(song_offset: int, num_voices: int, num_patterns: int,
                      bpm_stored: int, tick_rate: int,
                      base_note: int, base_freq: float, flags_byte: int,
                      pat_bin_comp_size: int, cue_sheet_comp_size: int,
                      global_vol: int = 0x80, mixing_vol: int = 0x80) -> bytes:
    """Pack a 32-byte Taud song table entry.

    Layout:
        u32 song_offset, u8 num_voices, u16 num_patterns,
        u8 bpm_stored, u8 tick_rate,
        u16 base_note, f32 base_freq,
        u8 flags, u8 global_vol, u8 mixing_vol,
        u32 pat_bin_comp_size, u32 cue_sheet_comp_size,
        byte[6] reserved.
    """
    entry = struct.pack('<IBHBBHfBBBII',
        song_offset,
        num_voices & 0xFF,
        num_patterns & 0xFFFF,
        bpm_stored & 0xFF,
        tick_rate & 0xFF,
        base_note & 0xFFFF,
        float(base_freq),
        flags_byte & 0xFF,
        global_vol & 0xFF,
        mixing_vol & 0xFF,
        pat_bin_comp_size & 0xFFFFFFFF,
        cue_sheet_comp_size & 0xFFFFFFFF,
    ) + b'\x00' * 6
    assert len(entry) == TAUD_SONG_ENTRY
    return entry


def normalise_sample(raw: bytes, signed: bool, is_16bit: bool,
                     is_stereo: bool, name: str) -> bytes:
    """Return unsigned 8-bit mono sample bytes, downmixing/depthing as needed."""
    out = []
    stride = (2 if is_16bit else 1) * (2 if is_stereo else 1)
    i = 0
    while i + stride <= len(raw):
        if is_16bit:
            if is_stereo:
                l16 = struct.unpack_from('<h', raw, i)[0]
                r16 = struct.unpack_from('<h', raw, i+2)[0]
                s = (l16 + r16) >> 1
            else:
                s = struct.unpack_from('<h', raw, i)[0]
            v = (s >> 8) + 128
        else:
            if is_stereo:
                l8 = raw[i]; r8 = raw[i+1]
                raw_s = (l8 + r8) // 2
            else:
                raw_s = raw[i]
            if signed:
                v = (raw_s ^ 0x80) & 0xFF
            else:
                v = raw_s
        out.append(v & 0xFF)
        i += stride
    if is_16bit or is_stereo:
        vprint(f"  info: '{name}' converted to unsigned 8-bit mono ({len(out)} samples)")
    return bytes(out)
