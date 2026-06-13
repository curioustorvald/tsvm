"""taud_common.py — Shared constants and helpers for *2taud converters.

Imported by s3m2taud.py, it2taud.py, and mod2taud.py. Holds the Taud
container constants, the effect-letter index table, and the small set
of helpers (sample resampler, vol/pan column packer, cue encoder,
pattern deduper, sample normaliser) that all three converters used to
duplicate verbatim.
"""

import gzip as _gzip
import struct
import sys

try:
    import zstandard as _zstd
    _ZSTD_CCTX = _zstd.ZstdCompressor(level=22)
except ImportError:
    _ZSTD_CCTX = None


# ── Verbose logging (shared across converters via set_verbose) ───────────────

VERBOSE = False

def set_verbose(b: bool) -> None:
    global VERBOSE
    VERBOSE = bool(b)

def vprint(*a, **kw) -> None:
    if VERBOSE:
        print(*a, **kw, file=sys.stderr)


# ── Compression (gzip vs zstd; whichever is smaller) ─────────────────────────
#
# The Taud loader sniffs the 4-byte magic of every compressed slot and routes
# to GZIPInputStream or ZstdInputStream accordingly (CompressorDelegate.kt:148-149),
# so each blob can independently pick whichever codec compresses it smaller.

def best_compress(payload: bytes) -> tuple:
    """Return (compressed_bytes, method) for the smaller of gzip/zstd output.

    Method is "gzip" or "zstd". Falls back to gzip when the `zstandard`
    package is not installed.
    """
    gz = _gzip.compress(payload, compresslevel=9, mtime=0)
    if _ZSTD_CCTX is None:
        return gz, "gzip"
    zs = _ZSTD_CCTX.compress(payload)
    if len(zs) < len(gz):
        return zs, "zstd"
    return gz, "gzip"


def compress_blob(payload: bytes, label: str) -> bytes:
    """Compress `payload` with whichever of gzip/zstd is smaller; vprint stats; return bytes.

    `label` is the human-readable name in the verbose log line, e.g. "sample+inst bin".
    """
    out, method = best_compress(payload)
    vprint(f"  {label}: {len(payload)} → {len(out)} bytes ({method})")
    return out


# ── Taud container constants ─────────────────────────────────────────────────

TAUD_MAGIC       = bytes([0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64])
# Bumped 2026-05-07: envelope offset minifloat rebiased (smallest step 1/256 s,
# max 15.75 s; previously 1/32 s, max 126 s). v1 .taud envelopes will play with
# the wrong tempo on a v2 engine — re-convert from source.
TAUD_VERSION     = 1
TAUD_HEADER_SIZE = 32       # magic(8)+ver(1)+numSongs(1)+compSize(4)+projOff(4)+sig(14)
TAUD_SONG_ENTRY  = 32       # full spec entry (see encode_song_entry)
INST_RECORD_SIZE = 256      # widened 2026-05-06 (was 192). 256 inst × 256 = 64K.
# Sample+instrument image (terranmon.txt:1985-1997, 2533-2564 — updated 2026-05-08).
# Sample pool is now 8 MB, banked through MMIO 46 in 16 × 512 K windows.
# Converters write the pool bank-major (bank 0's 512 K first, then bank 1's, ...);
# the runtime decompresses the whole blob straight into native peripheral storage,
# so converters just lay out an 8 MB linear array as if banking didn't exist.
SAMPLE_BANK_SIZE = 524288               # 512 K per bank
SAMPLE_BANK_COUNT = 16                  # 16 banks × 512 K = 8 MB
SAMPLEBIN_SIZE   = SAMPLE_BANK_SIZE * SAMPLE_BANK_COUNT   # 8 MB
INSTBIN_SIZE     = INST_RECORD_SIZE * 256   # 65536 = 64K
SAMPLEINST_SIZE  = SAMPLEBIN_SIZE + INSTBIN_SIZE          # 8454144 = 8256 kB
PATTERN_ROWS     = 64
PATTERN_BYTES    = PATTERN_ROWS * 8     # 512
NUM_PATTERNS_MAX = 4095
NUM_CUES         = 1024
CUE_SIZE         = 32
NUM_VOICES       = 20

# Per-sample length cap. Taud instrument records carry the sample length as
# a u16 (terranmon.txt:2001+ — bytes 4..5), so any single sample must fit in
# 65535 bytes. Converters resample over-long samples individually after the
# global pool-overflow pass and rescale the affected channel's TOP_O args.
SAMPLE_LEN_LIMIT = 65535

# Note word sentinels
NOTE_NOP    = 0x0000
NOTE_KEYOFF = 0x0001
NOTE_CUT    = 0x0002
TAUD_C4     = 0x5000   # The audio engine's Middle C

# Cue sheet instruction byte (cue offset 30; offset 31 = arg byte for 2-byte forms).
# Per terranmon.txt §"Cue Sheet":
#   00000010 00xxxxxx (LEN)  pattern length: rows = (xxxxxx) + 1, range 1..64
#   00000001          (HALT) end of song
#   00000000          (NOP)  default 64-row cue
#   1000xxxx yyyyyyyy (BAK)  go back 12-bit arg
#   1001xxxx yyyyyyyy (FWD)  skip forward 12-bit arg
#   1111xxxx yyyyyyyy (JMP)  go to absolute pattern
CUE_INST_NOP  = 0x00
CUE_INST_HALT = 0x01
CUE_INST_LEN  = 0x02

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
TOP_M    = 0x16
TOP_N    = 0x17
TOP_O    = 0x18
TOP_P    = 0x19
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


# ── Envelope offset minifloat ────────────────────────────────────────────────
#
# Mirror of tsvm_core/.../ThreeFiveMinifloat.kt — used by every *2taud
# converter that emits envelope nodes. 3.5 unsigned minifloat (3-bit exponent
# + 5-bit mantissa) rebiased so the smallest non-zero step is 1/256 s ≈ 3.91
# ms and the maximum is 15.75 s. The previous bias (1/32-step, max 126 s)
# under-resolved single-tick deltas at typical tracker BPMs. Every value here
# is the original LUT divided by 8.

MINUFLOAT_LUT = (
    0.0, 0.00390625, 0.0078125, 0.01171875, 0.015625, 0.01953125, 0.0234375, 0.02734375,
    0.03125, 0.03515625, 0.0390625, 0.04296875, 0.046875, 0.05078125, 0.0546875, 0.05859375,
    0.0625, 0.06640625, 0.0703125, 0.07421875, 0.078125, 0.08203125, 0.0859375, 0.08984375,
    0.09375, 0.09765625, 0.1015625, 0.10546875, 0.109375, 0.11328125, 0.1171875, 0.12109375,
    0.125, 0.12890625, 0.1328125, 0.13671875, 0.140625, 0.14453125, 0.1484375, 0.15234375,
    0.15625, 0.16015625, 0.1640625, 0.16796875, 0.171875, 0.17578125, 0.1796875, 0.18359375,
    0.1875, 0.19140625, 0.1953125, 0.19921875, 0.203125, 0.20703125, 0.2109375, 0.21484375,
    0.21875, 0.22265625, 0.2265625, 0.23046875, 0.234375, 0.23828125, 0.2421875, 0.24609375,
    0.25, 0.2578125, 0.265625, 0.2734375, 0.28125, 0.2890625, 0.296875, 0.3046875,
    0.3125, 0.3203125, 0.328125, 0.3359375, 0.34375, 0.3515625, 0.359375, 0.3671875,
    0.375, 0.3828125, 0.390625, 0.3984375, 0.40625, 0.4140625, 0.421875, 0.4296875,
    0.4375, 0.4453125, 0.453125, 0.4609375, 0.46875, 0.4765625, 0.484375, 0.4921875,
    0.5, 0.515625, 0.53125, 0.546875, 0.5625, 0.578125, 0.59375, 0.609375,
    0.625, 0.640625, 0.65625, 0.671875, 0.6875, 0.703125, 0.71875, 0.734375,
    0.75, 0.765625, 0.78125, 0.796875, 0.8125, 0.828125, 0.84375, 0.859375,
    0.875, 0.890625, 0.90625, 0.921875, 0.9375, 0.953125, 0.96875, 0.984375,
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
)


def nearest_minifloat(sec: float) -> int:
    """Return the ThreeFiveMiniUfloat index (0..255) for the LUT entry nearest to `sec`."""
    if sec <= 0.0:
        return 0
    if sec >= MINUFLOAT_LUT[-1]:
        return 255
    lo, hi = 0, len(MINUFLOAT_LUT) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if MINUFLOAT_LUT[mid] < sec:
            lo = mid + 1
        else:
            hi = mid
    if lo > 0 and abs(MINUFLOAT_LUT[lo - 1] - sec) < abs(MINUFLOAT_LUT[lo] - sec):
        return lo - 1
    return lo


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


def rescale_offset_effects(pat_bin: bytes, ratio: float) -> bytes:
    """Scale TOP_O sample-offset args in raw pattern bytes by `ratio`.

    Each row is 8 bytes; byte 5 is the effect opcode, bytes 6-7 are the
    little-endian 16-bit arg (= byte offset into the sample). When the
    sample bin overflows and every sample is downsampled globally, the
    offset commands must shrink the same amount or O-jumps land past
    the new end of sample.
    """
    if ratio == 1.0 or not pat_bin:
        return pat_bin
    out = bytearray(pat_bin)
    for i in range(0, len(out) - 7, 8):
        if out[i + 5] == TOP_O:
            arg = out[i + 6] | (out[i + 7] << 8)
            arg = max(0, min(0xFFFF, int(arg * ratio + 0.5)))
            out[i + 6] = arg & 0xFF
            out[i + 7] = (arg >> 8) & 0xFF
    return bytes(out)


def rescale_offset_effects_per_slot(pat_bin: bytes,
                                     num_cues: int,
                                     num_channels: int,
                                     slot_ratios: dict) -> bytes:
    """Scale TOP_O args using a per-slot ratio map.

    `pat_bin` is laid out as `num_cues × num_channels` consecutive
    PATTERN_BYTES (=512) blocks, channel-minor within each cue. For each
    channel, walk the rows in cue order and track the most recently
    written slot byte (row offset 2). When a TOP_O effect appears, scale
    its arg by `slot_ratios[active_slot]`, falling back to ratio 1.0 if
    the slot is unknown (e.g. row hits an O before any inst byte has
    selected a sample for the channel).
    """
    if not pat_bin or not slot_ratios:
        return pat_bin
    if all(r == 1.0 for r in slot_ratios.values()):
        return pat_bin
    out = bytearray(pat_bin)
    active = [0] * num_channels
    for cue in range(num_cues):
        for ch in range(num_channels):
            block = (cue * num_channels + ch) * PATTERN_BYTES
            for row in range(PATTERN_ROWS):
                rb = block + row * 8
                inst = out[rb + 2]
                if inst != 0:
                    active[ch] = inst
                if out[rb + 5] == TOP_O:
                    ratio = slot_ratios.get(active[ch], 1.0)
                    if ratio != 1.0:
                        arg = out[rb + 6] | (out[rb + 7] << 8)
                        arg = max(0, min(0xFFFF, int(arg * ratio + 0.5)))
                        out[rb + 6] = arg & 0xFF
                        out[rb + 7] = (arg >> 8) & 0xFF
    return bytes(out)


def encode_cue(patterns12: list, instruction) -> bytearray:
    """Encode a 32-byte cue entry for up to 20 voices with 12-bit pattern numbers.

    `instruction` is either an int (legacy single-byte value placed at byte 30,
    byte 31 = 0) or a 2-tuple `(byte30, byte31)` for two-byte forms such as
    LEN (CUE_INST_LEN with row count - 1).
    """
    pats = list(patterns12) + [0xFFF] * NUM_VOICES
    pats = pats[:NUM_VOICES]
    entry = bytearray(CUE_SIZE)
    for i in range(10):      # 10 bytes: 2 voices per byte
        v0, v1 = pats[i*2], pats[i*2+1]
        entry[i]      = ((v0 & 0xF) << 4) | (v1 & 0xF)               # low nybbles
        entry[10 + i] = (((v0 >> 4) & 0xF) << 4) | ((v1 >> 4) & 0xF) # mid nybbles
        entry[20 + i] = (((v0 >> 8) & 0xF) << 4) | ((v1 >> 8) & 0xF) # high nybbles
    if isinstance(instruction, tuple):
        b30, b31 = instruction
        entry[30] = b30 & 0xFF
        entry[31] = b31 & 0xFF
    else:
        entry[30] = instruction & 0xFF
    return entry


def cue_instruction_len(rows: int) -> tuple:
    """Build the 2-byte LEN cue instruction for `rows` (1..64).

    Returns (byte30, byte31) where byte30 = 0x02 and byte31 = (rows - 1) & 0x3F.
    """
    if not 1 <= rows <= 64:
        raise ValueError(f"LEN row count must be 1..64, got {rows}")
    return (CUE_INST_LEN, (rows - 1) & 0x3F)


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


# ── Subsong detection (multi-song .taud emission) ────────────────────────────
#
# Modules and trackers don't natively carry a subsong table; subsongs emerge
# from the order-list flow graph. OpenMPT-style: take the lowest unvisited
# non-terminator order as the next subsong entry, do forward reachability via
# fall-through (oi→oi+1) plus pattern-Bxx targets, mark all reached orders
# visited, repeat until no entries remain.
#
# Fall-through is treated as dead when the pattern at oi has a Bxx on its
# absolute last row — the convention every tracker uses for "song ends here,
# loop back" — which lets non-looping subsongs separated by Bxx-terminated
# predecessors be detected even without an explicit 0xFF marker.
#
# WHEN.s3m → 4 subsongs (0xFF separators); Insaniq2.it → 8 subsongs (Bxx-row-63
# terminators, no 0xFF separators). Single-song files collapse to 1 subsong.

def detect_subsongs(orders, pattern_bxx_fn, *,
                    terminators=(0xFF,), skip_marker=0xFE):
    """Detect subsongs by repeated forward reachability.

    Args:
        orders: list of raw order bytes from the source file. Each element is
            either a pattern index (0..n-1), a skip value (transparently
            skipped), or a terminator value (ends a path).
        pattern_bxx_fn: callable(pattern_idx) → (set_of_bxx_target_order_indices,
            kills_fallthrough). `kills_fallthrough` is True when the pattern's
            last row carries a Bxx (unconditional terminator); when False,
            fall-through to oi+1 is kept as a graph edge.
        terminators: int, or iterable of ints. Order values that end a path
            (default 0xFF). Pass an empty iterable for formats without a
            terminator marker (XM).
        skip_marker: int, or iterable of ints. Order values that are
            transparently passed during traversal (default 0xFE). XM passes
            `range(pattern_count, 256)` to skip out-of-range pattern refs.

    Returns:
        List of subsongs in entry-order. Each subsong is a dict:
            'entry': original order-list position of the entry (int)
            'positions': list of original order-list positions belonging to this
                subsong, in cue-sheet order (entry first, then ascending index
                wrap-around). Each position's pattern index = orders[pos].
        For a single-song file the result has one element whose 'positions'
        covers the whole order list (minus terminators/skips). For files where
        every order is a terminator/skip, the result is empty.
    """
    n = len(orders)
    term = {terminators} if isinstance(terminators, int) else set(terminators)
    skips = ({skip_marker} if isinstance(skip_marker, int)
             else set(skip_marker))

    def _is_traversable(pos: int) -> bool:
        if pos < 0 or pos >= n:
            return False
        v = orders[pos]
        return v not in term and v not in skips

    visited = set()
    songs = []

    while True:
        # Lowest unvisited traversable position = next subsong entry.
        entry = next((i for i in range(n)
                      if i not in visited and _is_traversable(i)), None)
        if entry is None:
            break

        # Reachability claims orders for this subsong, stopping at orders
        # already owned by a previous subsong.
        owned = set()
        stack = [entry]
        while stack:
            oi = stack.pop()
            if oi in owned or oi in visited:
                continue
            if oi < 0 or oi >= n:
                continue
            v = orders[oi]
            if v in term:
                continue
            if v in skips:
                if oi + 1 < n:
                    stack.append(oi + 1)
                continue
            owned.add(oi)
            tgts, kills = pattern_bxx_fn(v)
            for t in tgts:
                if 0 <= t < n:
                    stack.append(t)
            if not kills and oi + 1 < n:
                stack.append(oi + 1)

        if not owned:
            # Avoid infinite loop on a degenerate entry (shouldn't happen
            # since _is_traversable already filtered terminators / skips).
            visited.add(entry)
            continue
        visited |= owned

        # Cue-sheet order: ascending index, rotated so entry comes first.
        # The natural order-list traversal is sequential, so increasing index
        # matches the play sequence when fall-through is alive; rotation
        # ensures cue 0 is the entry order.
        sorted_owned = sorted(owned)
        rot = sorted_owned.index(entry)
        positions = sorted_owned[rot:] + sorted_owned[:rot]

        songs.append({'entry': entry, 'positions': positions})

    return songs


# ── Project Data section (terranmon.txt:2601+) ───────────────────────────────

PROJECT_DATA_MAGIC = bytes([0x1E, 0x54, 0x61, 0x75, 0x64, 0x50, 0x72, 0x4A])  # \x1ETaudPrJ
PROJECT_DATA_HEADER_SIZE = 16   # 8-byte magic + 8 reserved


def _name_table_blob(names) -> bytes:
    """Encode a list of names (slot-indexed; slot 0 is left empty in source) as
    0x1E-separated UTF-8 bytes. Trailing empty slots are trimmed to save space.
    Returns b'' when every name is empty.
    """
    if not names:
        return b''
    end = len(names)
    while end > 0 and not names[end - 1]:
        end -= 1
    if end == 0:
        return b''
    return b'\x1E'.join((n or '').encode('utf-8', 'replace') for n in names[:end])


# ── Ixmp encoder (terranmon.txt §Project Data → Ixmp) ───────────────────────

# Per-patch byte layout. Field offsets / version flags must match
# AudioJSR223Delegate.uploadInstrumentPatches (Kotlin parser) and terranmon.txt
# "Ixmp. Instrument extra samples". Patches are VARIABLE LENGTH since 2026-06-13:
# a version byte (feature bit-flags) + 30 common bytes + optional blocks. A
# version byte with only the 'i' bit set yields the legacy 31-byte record.
IXMP_COMMON_SIZE    = 31     # version byte + 30 common bytes (legacy record size)
IXMP_PAN_NO_OVERRIDE = 0xFF
IXMP_DNV_NO_OVERRIDE = 0
IXMP_VIBWAVE_NO_OVERRIDE = 0xFF

# Version byte feature bits (terranmon.txt 0b x00Pfpvi).
IXMP_VER_I = 0x01            # always set (version 1)
IXMP_VER_V = 0x02            # has volume envelope block
IXMP_VER_P = 0x04            # has panning envelope block
IXMP_VER_F = 0x08            # has filter envelope block
IXMP_VER_PITCH = 0x10        # has pitch envelope block ('P')
IXMP_VER_X = 0x80            # has extra-base-info block


# "Perceptually Significant Octet to Decibel Table" → linear gain (octet → amplitude).
# The canonical perceptual loudness curve shared by the engine (AudioAdapter.META_MIX_GAIN),
# the Metainstrument layer mix volume, and the base/patch initialAttenuation octet.
# Octet 0 = silence, 159 = unity (0 dB), 255 = +24 dB.
META_GAIN = (
    0.0, 5e-05, 5.6e-05, 6.3e-05, 7.1e-05, 7.9e-05, 8.9e-05, 0.0001,
    0.000112, 0.000126, 0.000141, 0.000158, 0.000178, 0.0002, 0.000224, 0.000251,
    0.000282, 0.000316, 0.000355, 0.000398, 0.000447, 0.000501, 0.000562, 0.000631,
    0.000708, 0.000794, 0.000891, 0.001, 0.001122, 0.001259, 0.001413, 0.001585,
    0.001778, 0.001995, 0.002239, 0.002512, 0.002818, 0.003162, 0.003548, 0.003981,
    0.004467, 0.005012, 0.005623, 0.00631, 0.007079, 0.007943, 0.008913, 0.01,
    0.01122, 0.012589, 0.014125, 0.015849, 0.017783, 0.019953, 0.022387, 0.025119,
    0.028184, 0.031623, 0.035481, 0.039811, 0.044668, 0.050119, 0.056234, 0.063096,
    0.066834, 0.070795, 0.074989, 0.079433, 0.08414, 0.089125, 0.094406, 0.1,
    0.105925, 0.112202, 0.11885, 0.125893, 0.133352, 0.141254, 0.149624, 0.158489,
    0.16788, 0.177828, 0.188365, 0.199526, 0.211349, 0.223872, 0.237137, 0.251189,
    0.258523, 0.266073, 0.273842, 0.281838, 0.290068, 0.298538, 0.307256, 0.316228,
    0.325462, 0.334965, 0.344747, 0.354813, 0.365174, 0.375837, 0.386812, 0.398107,
    0.409732, 0.421697, 0.43401, 0.446684, 0.459727, 0.473151, 0.486968, 0.501187,
    0.508452, 0.515822, 0.523299, 0.530884, 0.53858, 0.546387, 0.554307, 0.562341,
    0.570493, 0.578762, 0.587151, 0.595662, 0.604296, 0.613056, 0.621942, 0.630957,
    0.640103, 0.649382, 0.658795, 0.668344, 0.678032, 0.68786, 0.697831, 0.707946,
    0.718208, 0.728618, 0.73918, 0.749894, 0.760764, 0.771792, 0.782979, 0.794328,
    0.805842, 0.817523, 0.829373, 0.841395, 0.853591, 0.865964, 0.878517, 0.891251,
    0.90417, 0.917276, 0.930572, 0.944061, 0.957745, 0.971628, 0.985712, 1.0,
    1.014495, 1.029201, 1.044119, 1.059254, 1.074608, 1.090184, 1.105987, 1.122018,
    1.138282, 1.154782, 1.171521, 1.188502, 1.20573, 1.223207, 1.240938, 1.258925,
    1.277174, 1.295687, 1.314468, 1.333521, 1.352851, 1.372461, 1.392355, 1.412538,
    1.433013, 1.453784, 1.474857, 1.496236, 1.517924, 1.539927, 1.562248, 1.584893,
    1.607867, 1.631173, 1.654817, 1.678804, 1.703139, 1.727826, 1.752871, 1.778279,
    1.804056, 1.830206, 1.856735, 1.883649, 1.910953, 1.938653, 1.966754, 1.995262,
    2.053525, 2.113489, 2.175204, 2.238721, 2.304093, 2.371374, 2.440619, 2.511886,
    2.585235, 2.660725, 2.73842, 2.818383, 2.900681, 2.985383, 3.072557, 3.162278,
    3.254618, 3.349654, 3.447466, 3.548134, 3.651741, 3.758374, 3.868121, 3.981072,
    4.216965, 4.466836, 4.731513, 5.011872, 5.308844, 5.623413, 5.956621, 6.309573,
    6.683439, 7.079458, 7.498942, 7.943282, 8.413951, 8.912509, 9.440609, 10.0,
    10.592537, 11.220185, 11.885022, 12.589254, 13.335214, 14.125375, 14.962357, 15.848932,
)


def atten_cb_to_octet(atten_cb: float) -> int:
    """SF2 initialAttenuation (centibels, ≥0) → nearest [META_GAIN] octet (159 = 0 dB /
    unity). Returns 159 for ~0 attenuation and never 0 — octet 0 is the engine's "unset"
    sentinel (treated as unity), so emitting it for a real value would silence the voice."""
    if atten_cb <= 0:
        return 159
    g = 10.0 ** (-atten_cb / 200.0)
    return min(range(1, 160), key=lambda o: abs(META_GAIN[o] - g))


def _encode_env_block(env: dict) -> bytes:
    """One v/p/f/P envelope block: LOOP word + SUSTAIN word + 25 (value, minifloat)
    node pairs = 54 bytes. `env` keys: 'loop' (u16), 'sustain' (u16), 'nodes'
    (list of (value 0..255, minifloat_index 0..255); padded/truncated to 25)."""
    out = bytearray(struct.pack('<HH', int(env.get('loop', 0)) & 0xFFFF,
                                int(env.get('sustain', 0)) & 0xFFFF))
    nodes = list(env.get('nodes', []))
    while len(nodes) < 25:
        nodes.append((nodes[-1][0] if nodes else 0, 0))
    for val, mf in nodes[:25]:
        out.append(int(val) & 0xFF)
        out.append(int(mf) & 0xFF)
    return bytes(out)


def encode_ixmp_patch(p: dict) -> bytes:
    """Encode one variable-length patch.

    Common keys (numeric; defaults applied for missing optionals):
        pitch_start, pitch_end        : Taud 4096-TET noteVal (Uint16)
        volume_start, volume_end      : 0..63 (Uint8)
        sample_ptr                    : Uint32 (sample bin offset)
        sample_length                 : Uint16
        play_start, loop_start, loop_end : Uint16
        sampling_rate                 : Uint16 (same encoding as base inst byte 6-7)
        sample_detune                 : Int16, signed 4096-TET (default 0)
        loop_mode                     : Uint8 (default 0)
        default_pan                   : Uint8, 0xFF = no override (default 0xFF)
        default_note_volume           : Uint8 IT-scaled (0 = no override, default 0)
        vibrato_speed/sweep/depth/rate: Uint8 (default 0)
        vibrato_waveform              : Uint8 (0..7 or 0xFF for no override, default 0xFF)

    Optional blocks (presence sets the version flag; appended in spec order x,v,p,f,P):
        extra      : dict {fadeout (u16), default_cutoff (u16), default_resonance (u16),
                           initial_attenuation (u8 dB-table octet),
                           filter_sf_mode (bool — flag1 bit 0; SoundFont filter params)}
                     → 'x' block (15 bytes)
        vol_env    : env-block dict → 'v' block (54 bytes)
        pan_env    : env-block dict → 'p' block
        filter_env : env-block dict → 'f' block
        pitch_env  : env-block dict → 'P' block
    """
    pitch_start = max(0, min(0xFFFF, int(p['pitch_start'])))
    pitch_end   = max(0, min(0xFFFF, int(p['pitch_end'])))
    vol_start   = max(0, min(63,     int(p.get('volume_start', 0))))
    vol_end     = max(0, min(63,     int(p.get('volume_end', 63))))
    sample_ptr  = int(p['sample_ptr']) & 0xFFFFFFFF
    sample_len  = max(0, min(0xFFFF, int(p['sample_length'])))
    play_start  = max(0, min(0xFFFF, int(p.get('play_start', 0))))
    loop_start  = max(0, min(0xFFFF, int(p.get('loop_start', 0))))
    loop_end    = max(0, min(0xFFFF, int(p.get('loop_end',   0))))
    rate        = max(0, min(0xFFFF, int(p.get('sampling_rate', 0))))
    detune      = max(-0x8000, min(0x7FFF, int(p.get('sample_detune', 0))))

    extra  = p.get('extra')
    vol_e  = p.get('vol_env')
    pan_e  = p.get('pan_env')
    filt_e = p.get('filter_env')
    pit_e  = p.get('pitch_env')

    ver = IXMP_VER_I
    if extra  is not None: ver |= IXMP_VER_X
    if vol_e  is not None: ver |= IXMP_VER_V
    if pan_e  is not None: ver |= IXMP_VER_P
    if filt_e is not None: ver |= IXMP_VER_F
    if pit_e  is not None: ver |= IXMP_VER_PITCH

    common = struct.pack(
        '<BHHBBIHHHHHhBBBBBBBB',
        ver,                                     # patch version / feature flags
        pitch_start, pitch_end,
        vol_start,   vol_end,
        sample_ptr,
        sample_len,
        play_start, loop_start, loop_end,
        rate,
        detune,
        int(p.get('loop_mode', 0))            & 0x07,
        int(p.get('default_pan', IXMP_PAN_NO_OVERRIDE))     & 0xFF,
        int(p.get('default_note_volume', IXMP_DNV_NO_OVERRIDE)) & 0xFF,
        int(p.get('vibrato_speed', 0))        & 0xFF,
        int(p.get('vibrato_sweep', 0))        & 0xFF,
        int(p.get('vibrato_depth', 0))        & 0xFF,
        int(p.get('vibrato_rate',  0))        & 0xFF,
        int(p.get('vibrato_waveform', IXMP_VIBWAVE_NO_OVERRIDE)) & 0xFF,
    )
    out = bytearray(common)
    if extra is not None:                        # 'x' block (15 bytes), spec order
        # flags1 bit 0 (m): 0 = IT filter params, 1 = SoundFont (Fc cents / Q centibels).
        flags1 = 0x01 if extra.get('filter_sf_mode') else 0x00
        out += struct.pack('<I', flags1)         # Bit32 extra-feature-flags 1..32
        out += struct.pack('<I', 0)              # Bit32 extra-feature-flags 33..64 (reserved)
        out += struct.pack('<H', int(extra.get('fadeout', 0)) & 0xFFFF)
        out += struct.pack('<H', int(extra.get('default_cutoff', 0xFFFF)) & 0xFFFF)
        out += struct.pack('<H', int(extra.get('default_resonance', 0xFFFF)) & 0xFFFF)
        # per-patch initialAttenuation as a dB-table octet (159 = unity); 0 = unset sentinel.
        out.append(int(extra.get('initial_attenuation', 0)) & 0xFF)
    if vol_e  is not None: out += _encode_env_block(vol_e)
    if pan_e  is not None: out += _encode_env_block(pan_e)
    if filt_e is not None: out += _encode_env_block(filt_e)
    if pit_e  is not None: out += _encode_env_block(pit_e)
    return bytes(out)


def encode_ixmp_payload(patches_by_inst: dict) -> bytes:
    """Encode a dict {instrument_id: [patch_dict, ...]} as one Ixmp section payload
    (the body that follows the FourCC + length header). Instruments are written in
    ascending id order. Overlapping pitch+volume rectangles within one instrument
    are INVALID per spec and the caller is responsible for keeping them disjoint."""
    if not patches_by_inst:
        return b''
    out = bytearray()
    for inst_id in sorted(patches_by_inst):
        patches = patches_by_inst[inst_id]
        if not patches:
            continue
        out.append(int(inst_id) & 0xFF)
        cnt = len(patches)
        out += bytes([cnt & 0xFF, (cnt >> 8) & 0xFF, (cnt >> 16) & 0xFF])  # Uint24 LE
        for patch in patches:
            out += encode_ixmp_patch(patch)
    return bytes(out)


def build_project_data(*, project_name: str = '',
                       author: str = '',
                       copyright_str: str = '',
                       sample_names=None,
                       instrument_names=None,
                       pattern_names=None,
                       song_metadata=None,
                       ixmp_patches=None) -> bytes:
    """Build the optional PROJECT DATA section payload.

    Returns the full block (8-byte magic + 8 reserved bytes + concatenated
    FourCC sections), or b'' when there's nothing to write so the caller can
    leave the header's projOff field at zero.

    `sample_names` / `instrument_names` / `pattern_names` are slot-indexed
    lists (entry 0 is typically empty since slot 0 is reserved); they are
    encoded as 0x1E-separated UTF-8 strings inside SNam / INam / pNam blocks.

    `song_metadata` is an optional list of dicts, one per song:
        { 'index': int (0..255),
          'notation': int = 0,
          'beat_pri': int = 4,
          'beat_sec': int = 16,
          'name': str = '',
          'composer': str = '',
          'copyright': str = '' }
    """
    sections = []

    def add(fourcc: bytes, payload: bytes) -> None:
        if not payload:
            return
        sections.append(fourcc + struct.pack('<I', len(payload)) + payload)

    if project_name:
        add(b'PNam', project_name.encode('utf-8', 'replace'))
    if author:
        add(b'PCom', author.encode('utf-8', 'replace'))
    if copyright_str:
        add(b'PCpr', copyright_str.encode('utf-8', 'replace'))

    add(b'INam', _name_table_blob(instrument_names))
    add(b'SNam', _name_table_blob(sample_names))
    add(b'pNam', _name_table_blob(pattern_names))

    if song_metadata:
        smet = bytearray()
        for entry in song_metadata:
            idx      = entry.get('index', 0) & 0xFF
            notation = entry.get('notation', 0) & 0xFFFF
            beat_pri = entry.get('beat_pri', 4) & 0xFF
            beat_sec = entry.get('beat_sec', 16) & 0xFF
            name_b = entry.get('name', '').encode('utf-8', 'replace') + b'\x00'
            comp_b = entry.get('composer', '').encode('utf-8', 'replace') + b'\x00'
            copr_b = entry.get('copyright', '').encode('utf-8', 'replace') + b'\x00'
            payload = (struct.pack('<HBB', notation, beat_pri, beat_sec)
                       + name_b + comp_b + copr_b)
            smet.append(idx)
            smet += struct.pack('<I', len(payload))
            smet += payload
        add(b'sMet', bytes(smet))

    if ixmp_patches:
        add(b'Ixmp', encode_ixmp_payload(ixmp_patches))

    if not sections:
        return b''

    return PROJECT_DATA_MAGIC + b'\x00' * 8 + b''.join(sections)


# ── Sample normalisation ─────────────────────────────────────────────────────

def normalise_sample(raw: bytes, signed: bool, is_16bit: bool,
                     is_stereo: bool, name: str) -> bytes:
    """Return unsigned 8-bit mono sample bytes, downmixing/depthing as needed.

    Stereo samples are stored as a split (non-interleaved) layout — the full
    left channel block followed by the full right channel block — matching the
    on-disk format used by IT, S3M, and XM (Schism's SF_SS).
    """
    out = []
    bps     = 2 if is_16bit else 1
    chans   = 2 if is_stereo else 1
    n_frames = len(raw) // (bps * chans)
    chan_bytes = n_frames * bps

    for i in range(n_frames):
        if is_16bit:
            if is_stereo:
                l16 = struct.unpack_from('<h', raw, i*2)[0]
                r16 = struct.unpack_from('<h', raw, chan_bytes + i*2)[0]
                s = (l16 + r16) >> 1
            else:
                s = struct.unpack_from('<h', raw, i*2)[0]
            v = (s >> 8) + 128
        else:
            if is_stereo:
                l8 = raw[i]
                r8 = raw[chan_bytes + i]
                if signed:
                    l_s = l8 - 256 if l8 >= 0x80 else l8
                    r_s = r8 - 256 if r8 >= 0x80 else r8
                    v = ((l_s + r_s) >> 1) + 128
                else:
                    v = (l8 + r8) >> 1
            else:
                raw_s = raw[i]
                if signed:
                    v = (raw_s ^ 0x80) & 0xFF
                else:
                    v = raw_s
        out.append(v & 0xFF)
    if is_16bit or is_stereo:
        vprint(f"  info: '{name}' converted to unsigned 8-bit mono ({len(out)} samples)")
    return bytes(out)
