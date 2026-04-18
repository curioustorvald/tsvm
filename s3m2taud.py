#!/usr/bin/env python3
"""s3m2taud.py — Convert Scream Tracker 3 (.s3m) to TSVM Taud (.taud)

Usage:
    python3 s3m2taud.py input.s3m output.taud [-v]

Limits:
    - Up to 15 S3M channels (excess disabled; hard error if pattern count
      × channel count > 256).
    - Sample bin is 770048 bytes; if all samples together exceed this, every
      sample is globally resampled down (with c2spd adjusted) so pitch is
      preserved.
    - AdLib instruments are skipped.
    - Effects mapped: D (vol-slide), E/F (pitch slide, rough approx),
      SC (note-cut), A (initial speed), T (initial BPM). Others dropped.

Pitch-slide approximation:
    Amiga-period mode: taud_arg ≈ s3m_arg * 2  (mid-register heuristic)
    Linear-slide mode: taud_arg = s3m_arg * 4   (exact)
"""

import argparse
import gzip
import math
import struct
import sys

VERBOSE = False

def vprint(*a, **kw):
    if VERBOSE:
        print(*a, **kw, file=sys.stderr)


# ── S3M constants ────────────────────────────────────────────────────────────

S3M_MAGIC        = b"SCRM"
S3M_TYPE_PCM     = 1
S3M_NOTE_EMPTY   = 0xFF
S3M_NOTE_OFF     = 0xFE
S3M_ORDER_SKIP   = 0xFE
S3M_ORDER_END    = 0xFF

# S3M effect letters (1-based: 1='A', 2='B', …)
EFF_A = 1   # set speed
EFF_B = 2   # jump to order
EFF_C = 3   # pattern break
EFF_D = 4   # volume slide
EFF_E = 5   # porta down
EFF_F = 6   # porta up
EFF_G = 7   # tone porta
EFF_H = 8   # vibrato
EFF_I = 9   # tremor
EFF_J = 10  # arpeggio
EFF_K = 11  # vibrato+volslide
EFF_L = 12  # porta+volslide
EFF_M = 13  # channel vol
EFF_N = 14  # chan vol slide
EFF_O = 15  # sample offset
EFF_P = 16  # pan slide
EFF_Q = 17  # retrigger
EFF_R = 18  # tremolo
EFF_S = 19  # special (sub-cmds)
EFF_T = 20  # set BPM
EFF_U = 21  # fine vibrato
EFF_V = 22  # global vol
EFF_W = 23  # global vol slide
EFF_X = 24  # set pan
EFF_Y = 25  # panbrello
EFF_Z = 26  # sync


# ── Taud constants ───────────────────────────────────────────────────────────

TAUD_MAGIC       = bytes([0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64])
TAUD_VERSION     = 1
TAUD_HEADER_SIZE = 32    # magic(8)+ver(1)+numSongs(1)+compSize(4)+rsvd(2)+sig(16)
TAUD_SONG_ENTRY  = 16   # offset(4)+voices(1)+pats_lo(1)+pats_hi(1)+bpm(1)+tick(1)+pad(7)
SAMPLEBIN_SIZE   = 770048
INSTBIN_SIZE     = 16384   # 256 instruments × 64 bytes
SAMPLEINST_SIZE  = SAMPLEBIN_SIZE + INSTBIN_SIZE  # 786432
PATTERN_ROWS     = 64
PATTERN_BYTES    = PATTERN_ROWS * 8   # 512
NUM_PATTERNS_MAX = 4095
NUM_CUES         = 1024
CUE_SIZE         = 32   # packed 12-bit×20 voices + instruction + pad
NUM_VOICES       = 20
SIGNATURE        = b"s3m2taud/TSVM   "    # 16 bytes

# Taud note constants
NOTE_NOP    = 0xFFFF
NOTE_KEYOFF = 0x0000
NOTE_CUT    = 0xFFFE
TAUD_C3     = 0x4000


# ── S3M parser ───────────────────────────────────────────────────────────────

class S3MHeader:
    __slots__ = ('title','order_count','inst_count','pat_count',
                 'flags','cwt_v','sample_type','global_vol',
                 'initial_speed','initial_tempo','master_vol',
                 'linear_slides','default_pan_flag',
                 'channel_settings','pan_values','order_list',
                 'inst_ptrs','pat_ptrs')

def parse_s3m(data: bytes) -> S3MHeader:
    if len(data) < 0x60:
        sys.exit("error: file too short to be S3M")
    if data[0x2C:0x30] != S3M_MAGIC:
        sys.exit("error: not an S3M file (bad magic at 0x2C)")

    h = S3MHeader()
    h.title          = data[0x00:0x1C].rstrip(b'\x00').decode('latin-1', errors='replace')
    h.order_count    = struct.unpack_from('<H', data, 0x20)[0]
    h.inst_count     = struct.unpack_from('<H', data, 0x22)[0]
    h.pat_count      = struct.unpack_from('<H', data, 0x24)[0]
    h.flags          = struct.unpack_from('<H', data, 0x26)[0]
    h.cwt_v          = struct.unpack_from('<H', data, 0x28)[0]
    h.sample_type    = data[0x2B]          # 1=signed, 2=unsigned
    h.global_vol     = data[0x30]
    h.initial_speed  = data[0x31]          # ticks per row
    h.initial_tempo  = data[0x32]          # BPM
    h.master_vol     = data[0x33]
    h.linear_slides  = bool(h.flags & 0x40)  # flag bit 6 → linear freq slides
    h.default_pan_flag = data[0x35]        # 0xFC → use pan values

    # Channel settings: bytes 0x40..0x5F; bit 7 = disabled
    h.channel_settings = list(data[0x40:0x60])

    # Order list
    off = 0x60
    h.order_list = list(data[off:off + h.order_count])

    # Instrument parapointers (×16 = file offset)
    off2 = off + h.order_count
    h.inst_ptrs = [struct.unpack_from('<H', data, off2 + i*2)[0] * 16
                   for i in range(h.inst_count)]

    # Pattern parapointers
    off3 = off2 + h.inst_count * 2
    h.pat_ptrs  = [struct.unpack_from('<H', data, off3 + i*2)[0] * 16
                   for i in range(h.pat_count)]

    # Default pan values (if present)
    pan_off = off3 + h.pat_count * 2
    h.pan_values = []
    if h.default_pan_flag == 0xFC and pan_off + h.inst_count <= len(data):
        for i in range(h.inst_count):
            h.pan_values.append(data[pan_off + i])
    # per-channel pan is in channel settings nibbles (separate from above)

    return h


class S3MInstrument:
    __slots__ = ('itype','filename','memseg','length','loop_begin','loop_end',
                 'volume','flags','c2spd','name','sample_data','signed')

def parse_instruments(data: bytes, h: S3MHeader) -> list:
    insts = []
    for ptr in h.inst_ptrs:
        if ptr + 0x50 > len(data):
            vprint(f"  warning: instrument pointer {ptr:#x} out of range, skipping")
            insts.append(None)
            continue
        inst = S3MInstrument()
        inst.itype    = data[ptr]
        inst.filename = data[ptr+1:ptr+13].rstrip(b'\x00').decode('latin-1', errors='replace')
        # memseg: 3 bytes at offsets 0x0D,0x0E,0x0F — high byte first (quirk)
        memseg_hi  = data[ptr + 0x0D]
        memseg_lo  = struct.unpack_from('<H', data, ptr + 0x0E)[0]
        inst.memseg   = (memseg_hi << 16) | memseg_lo
        inst.length   = struct.unpack_from('<I', data, ptr + 0x10)[0]
        inst.loop_begin = struct.unpack_from('<I', data, ptr + 0x14)[0]
        inst.loop_end   = struct.unpack_from('<I', data, ptr + 0x18)[0]
        inst.volume   = data[ptr + 0x1C]
        inst.flags    = data[ptr + 0x1F]     # bit0=loop, bit1=stereo, bit2=16bit
        inst.c2spd    = struct.unpack_from('<I', data, ptr + 0x20)[0] or 8363
        inst.name     = data[ptr + 0x30:ptr + 0x4C].rstrip(b'\x00').decode('latin-1', errors='replace')
        inst.signed   = (h.sample_type == 1)
        inst.sample_data = b''

        if inst.itype == S3M_TYPE_PCM:
            sample_off = inst.memseg * 16
            sample_len = inst.length
            is_16bit  = bool(inst.flags & 4)
            is_stereo = bool(inst.flags & 2)
            if sample_off + sample_len > len(data):
                vprint(f"  warning: sample '{inst.name}' data out of range, zeroing")
                inst.sample_data = bytes(min(sample_len, 256))
            else:
                raw = data[sample_off:sample_off + sample_len]
                inst.sample_data = _normalise_sample(raw, inst.signed, is_16bit, is_stereo, inst.name)
                inst.length      = len(inst.sample_data)
                inst.loop_begin  = min(inst.loop_begin, inst.length)
                inst.loop_end    = min(inst.loop_end,   inst.length)
        insts.append(inst)
    return insts


def _normalise_sample(raw: bytes, signed: bool, is_16bit: bool, is_stereo: bool, name: str) -> bytes:
    """Return unsigned 8-bit mono sample bytes."""
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
                v = ((raw_s ^ 0x80) & 0xFF)   # signed→unsigned
            else:
                v = raw_s
        out.append(v & 0xFF)
        i += stride
    if is_16bit or is_stereo:
        vprint(f"  info: '{name}' converted to unsigned 8-bit mono ({len(out)} samples)")
    return bytes(out)


# ── S3M pattern parser ───────────────────────────────────────────────────────

class S3MRow:
    """One cell in a pattern grid."""
    __slots__ = ('note','inst','vol','effect','effect_arg')
    def __init__(self):
        self.note       = S3M_NOTE_EMPTY   # 0xFF=empty, 0xFE=off, else (oct<<4|pitch)
        self.inst       = 0
        self.vol        = -1               # -1 = not set (use instrument default)
        self.effect     = 0               # 1-based letter index (0=none)
        self.effect_arg = 0

def parse_patterns(data: bytes, h: S3MHeader) -> list:
    """Returns list[pat_idx] of list[channel][row] → S3MRow."""
    patterns = []
    for pi, ptr in enumerate(h.pat_ptrs):
        # 32 channels × 64 rows
        grid = [[S3MRow() for _ in range(PATTERN_ROWS)] for _ in range(32)]
        if ptr == 0 or ptr + 2 > len(data):
            patterns.append(grid)
            continue
        pat_len = struct.unpack_from('<H', data, ptr)[0]
        end     = min(ptr + 2 + pat_len, len(data))
        pos     = ptr + 2
        row     = 0
        while row < PATTERN_ROWS and pos < end:
            b = data[pos]; pos += 1
            if b == 0:
                row += 1
                continue
            ch    = b & 0x1F
            has_n = bool(b & 0x20)
            has_v = bool(b & 0x40)
            has_e = bool(b & 0x80)
            cell  = grid[ch][row] if ch < 32 else S3MRow()
            if has_n:
                if pos + 1 >= end: break
                cell.note = data[pos]; pos += 1
                cell.inst = data[pos]; pos += 1
            if has_v:
                if pos >= end: break
                cell.vol = data[pos]; pos += 1
            if has_e:
                if pos + 1 >= end: break
                cell.effect     = data[pos];     pos += 1
                cell.effect_arg = data[pos];     pos += 1
        patterns.append(grid)
    return patterns


# ── Note / effect encoding ───────────────────────────────────────────────────

def encode_note(s3m_note: int) -> int:
    if s3m_note == S3M_NOTE_EMPTY:
        return NOTE_NOP
    if s3m_note == S3M_NOTE_OFF:
        return NOTE_KEYOFF
    octave = (s3m_note >> 4) & 0xF
    pitch  = s3m_note & 0xF
    if pitch > 11:
        return NOTE_NOP
    semitones = (octave - 4) * 12 + pitch
    val = round(TAUD_C3 + semitones * 4096 / 12)
    return max(1, min(0xFFFD, val))


def encode_effect(cmd: int, arg: int, linear: bool) -> tuple:
    """Return (taud_op, taud_arg16) or (0, 0) for no-op."""
    if cmd == EFF_D:
        # Volume slide: same nibble layout
        return (0x0A, arg & 0xFF)
    if cmd == EFF_E:
        # Porta down
        if linear:
            targ = min(arg * 4, 0xFFFF)
        else:
            targ = min(arg * 2, 0xFFFF)
        return (0x02, targ)
    if cmd == EFF_F:
        # Porta up
        if linear:
            targ = min(arg * 4, 0xFFFF)
        else:
            targ = min(arg * 2, 0xFFFF)
        return (0x01, targ)
    if cmd == EFF_S:
        sub = (arg >> 4) & 0xF
        val = arg & 0xF
        if sub == 0xC:   # SC - note cut
            return (0xEC, val)
    return (0x00, 0x0000)


# ── Taud builders ────────────────────────────────────────────────────────────

def _resample_linear(data: bytes, ratio: float) -> bytes:
    """Resample bytes by ratio (< 1 = downsample) using linear interpolation."""
    if not data:
        return data
    n_out = max(1, int(len(data) * ratio))
    out   = bytearray(n_out)
    for i in range(n_out):
        src = i / ratio
        i0  = int(src)
        frac = src - i0
        i1   = min(i0 + 1, len(data) - 1)
        v    = data[i0] * (1.0 - frac) + data[i1] * frac
        out[i] = int(v + 0.5) & 0xFF
    return bytes(out)


def build_sample_inst_bin(instruments: list) -> tuple:
    """
    Returns (bin_bytes[786432], offsets_list, updated_insts).
    Resamples globally if total exceeds SAMPLEBIN_SIZE.
    """
    pcm_insts = [(i, inst) for i, inst in enumerate(instruments)
                 if inst is not None and inst.itype == S3M_TYPE_PCM and inst.sample_data]

    total = sum(len(inst.sample_data) for _, inst in pcm_insts)
    ratio = 1.0
    if total > SAMPLEBIN_SIZE:
        ratio = SAMPLEBIN_SIZE / total
        vprint(f"  info: sample bin overflow ({total} bytes); resampling all by {ratio:.4f}")
        for _, inst in pcm_insts:
            new_data = _resample_linear(inst.sample_data, ratio)
            old_len  = len(inst.sample_data)
            inst.sample_data  = new_data
            inst.length       = len(new_data)
            inst.loop_begin   = max(0, int(inst.loop_begin * ratio))
            inst.loop_end     = max(0, min(int(inst.loop_end * ratio), inst.length))
            inst.c2spd        = max(1, int(inst.c2spd * ratio))

    sample_bin = bytearray(SAMPLEBIN_SIZE)
    offsets    = {}
    pos        = 0
    for idx, inst in pcm_insts:
        n = min(len(inst.sample_data), SAMPLEBIN_SIZE - pos)
        if n <= 0:
            vprint(f"  warning: sample bin full, dropping '{inst.name}'")
            offsets[idx] = 0
            inst.length  = 0
            continue
        sample_bin[pos:pos+n] = inst.sample_data[:n]
        offsets[idx] = pos
        if n < len(inst.sample_data):
            vprint(f"  warning: '{inst.name}' truncated from {len(inst.sample_data)} to {n}")
            inst.length = n
            inst.loop_end = min(inst.loop_end, n)
        pos += n

    # Build instrument bin (256 × 64 bytes)
    inst_bin = bytearray(INSTBIN_SIZE)
    for i, inst in enumerate(instruments):
        if i >= 256:
            break
        if inst is None or inst.itype != S3M_TYPE_PCM:
            continue
        ptr      = offsets.get(i, 0)
        ptr_lo   = ptr & 0xFFFF
        ptr_hi   = (ptr >> 16)
        s_len    = min(inst.length, 65535)
        c2spd    = min(inst.c2spd, 65535)
        ps       = 0
        ls       = min(inst.loop_begin, 65535)
        le       = min(inst.loop_end,   65535)
        loop_mode = 1 if (inst.flags & 1) else 0
        flags_byte = (ptr_hi << 4) | (loop_mode & 0x3)  # hhhh 00pp

        base = i * 64
        struct.pack_into('<H', inst_bin, base + 0,  ptr_lo)
        struct.pack_into('<H', inst_bin, base + 2,  s_len)
        struct.pack_into('<H', inst_bin, base + 4,  c2spd)
        struct.pack_into('<H', inst_bin, base + 6,  ps)
        struct.pack_into('<H', inst_bin, base + 8,  ls)
        struct.pack_into('<H', inst_bin, base + 10, le)
        inst_bin[base + 12] = flags_byte
        # Volume envelope: hold at instrument volume (vol*4 clamped to 255)
        env_vol = min(inst.volume * 4, 255)
        inst_bin[base + 16] = env_vol   # volume
        inst_bin[base + 17] = 0         # offset minifloat = 0 → hold


        vprint(f"  instrument '{inst.name}' ptr: '{ptr}', sampling rate: '{inst.c2spd}'")
        if inst.c2spd > 65535:
            vprint(f"  warning: sampling rate of '{inst.name}' exceeds 65535 (got '{inst.c2spd}')")

    return bytes(sample_bin) + bytes(inst_bin), offsets


def _default_channel_pan(ch_setting: int) -> int:
    """Return Taud pan 0..63 from S3M channel-setting byte."""
    # Bits 4-7 of channel setting are ignored; left/right from bit 3
    # Actually the channel type (0-7 left, 8-15 right) encodes stereo side
    ch_type = ch_setting & 0x7F
    if 0 <= ch_type <= 7:
        return 16   # left
    elif 8 <= ch_type <= 15:
        return 47   # right
    return 31   # centre


def build_pattern(s3m_grid: list, ch_idx: int, default_pan: int,
                  linear_slides: bool) -> bytes:
    """Build a 512-byte Taud pattern for one S3M channel."""
    out = bytearray(PATTERN_BYTES)
    rows = s3m_grid[ch_idx] if ch_idx < len(s3m_grid) else [S3MRow()] * PATTERN_ROWS
    for r, row in enumerate(rows[:PATTERN_ROWS]):
        note   = encode_note(row.note)
        inst   = max(0, row.inst - 1)   # S3M 1-based → Taud 0-based
        vol    = min(row.vol, 63) if row.vol >= 0 else 63
        pan    = default_pan
        op, arg = encode_effect(row.effect, row.effect_arg, linear_slides)
        if row.effect != 0 and op == 0:
            eff_name = chr(ord('A') + row.effect - 1) if 1 <= row.effect <= 26 else '?'
            vprint(f"    dropped effect {eff_name}{row.effect_arg:02X} at ch{ch_idx} row{r}")
        base = r * 8
        struct.pack_into('<H', out, base + 0, note)
        out[base + 2] = inst & 0xFF
        out[base + 3] = vol & 0x3F
        out[base + 4] = pan & 0x3F
        out[base + 5] = op & 0xFF
        struct.pack_into('<H', out, base + 6, arg & 0xFFFF)
    return bytes(out)


def deduplicate_patterns(pat_bin: bytes, num_pats: int) -> tuple:
    """
    Consolidate identical 512-byte Taud patterns into a single copy.
    Returns (deduped_bin, remap, num_unique) where remap[original_idx] = canonical_idx.
    """
    seen = {}       # pattern_bytes -> canonical_index
    remap = {}      # original_index -> canonical_index
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


def _encode_cue(patterns12: list, instruction: int) -> bytearray:
    """Encode a 32-byte cue entry for up to 20 voices with 12-bit pattern numbers."""
    # patterns12: list of up to NUM_VOICES 12-bit values (0xFFF = disabled)
    pats = list(patterns12) + [0xFFF] * NUM_VOICES
    pats = pats[:NUM_VOICES]
    entry = bytearray(CUE_SIZE)
    for i in range(10):      # 10 bytes: 2 voices per byte
        v0, v1 = pats[i*2], pats[i*2+1]
        entry[i]      = ((v0 & 0xF) << 4) | (v1 & 0xF)        # low nybbles
        entry[10 + i] = (((v0 >> 4) & 0xF) << 4) | ((v1 >> 4) & 0xF)  # mid nybbles
        entry[20 + i] = (((v0 >> 8) & 0xF) << 4) | ((v1 >> 8) & 0xF)  # high nybbles
    entry[30] = instruction & 0xFF
    return entry


def build_cue_sheet(order_list: list, num_pats_s3m: int, num_channels: int,
                    pat_remap: dict = None) -> bytes:
    """Build the 1024×32-byte cue sheet with 12-bit packed pattern numbers."""
    sheet = bytearray(NUM_CUES * CUE_SIZE)
    # Fill entire sheet with the "all disabled" cue (patterns=0xFFF, instr=0)
    for c in range(NUM_CUES):
        sheet[c*CUE_SIZE : c*CUE_SIZE+CUE_SIZE] = _encode_cue([], 0)

    cue_idx = 0
    for order in order_list:
        if order == S3M_ORDER_END or cue_idx >= NUM_CUES:
            break
        if order == S3M_ORDER_SKIP:
            cue_idx += 1
            continue
        orig = [order * num_channels + v for v in range(num_channels)]
        pats = [pat_remap[p] if pat_remap else p for p in orig]
        sheet[cue_idx*CUE_SIZE : cue_idx*CUE_SIZE+CUE_SIZE] = _encode_cue(pats, 0)
        cue_idx += 1

    # Halt at end
    if cue_idx < NUM_CUES:
        sheet[cue_idx*CUE_SIZE : cue_idx*CUE_SIZE+CUE_SIZE] = _encode_cue([], 0x01)

    return bytes(sheet)


def find_initial_bpm_speed(patterns: list, order_list: list,
                           default_speed: int, default_tempo: int) -> tuple:
    """Scan first pattern in order for Axx/Txx in row 0 of any channel."""
    speed = default_speed or 6
    tempo = default_tempo or 125
    for order in order_list:
        if order >= S3M_ORDER_END:
            break
        if order >= len(patterns):
            continue
        grid = patterns[order]
        for ch_rows in grid:
            row = ch_rows[0]
            if row.effect == EFF_A and row.effect_arg > 0:
                speed = row.effect_arg
            if row.effect == EFF_T and row.effect_arg > 0:
                tempo = row.effect_arg
        break
    return speed, tempo


def assemble_taud(h: S3MHeader, instruments: list, patterns: list) -> bytes:
    # Determine active channels (bit7 clear = enabled)
    active_channels = [i for i, cs in enumerate(h.channel_settings)
                       if i < 32 and not (cs & 0x80)][:NUM_VOICES]
    C = len(active_channels)
    P = len(patterns)

    if P * C > NUM_PATTERNS_MAX:
        sys.exit(
            f"error: {P} S3M patterns × {C} channels = {P*C} > {NUM_PATTERNS_MAX} Taud pattern limit.\n"
            f"  Reduce the S3M to ≤ {NUM_PATTERNS_MAX // max(C,1)} patterns, or mute "
            f"channels to bring active count below {NUM_PATTERNS_MAX // max(P,1) + 1}."
        )

    vprint(f"  channels: {C}, s3m patterns: {P}, taud patterns: {P*C}")

    # Build sample+instrument bin
    vprint("  building sample/instrument bin…")
    sampleinst_raw, _offsets = build_sample_inst_bin(instruments)
    assert len(sampleinst_raw) == SAMPLEINST_SIZE

    # Compress
    compressed = gzip.compress(sampleinst_raw, compresslevel=9, mtime=0)
    comp_size  = len(compressed)
    vprint(f"  sample+inst bin: {SAMPLEINST_SIZE} → {comp_size} bytes (gzip)")

    # Initial BPM / speed
    speed, tempo = find_initial_bpm_speed(patterns, h.order_list,
                                          h.initial_speed, h.initial_tempo)
    tempo = max(24, min(280, tempo))
    bpm_stored = (tempo - 24) & 0xFF
    vprint(f"  initial speed={speed}, tempo(BPM)={tempo}")

    # Song offset = header(32) + compressed + song_table(8)
    song_offset = TAUD_HEADER_SIZE + comp_size + TAUD_SONG_ENTRY
    num_taud_pats = P * C

    # Header (32 bytes): magic(8)+ver(1)+numSongs(1)+compSize(4)+rsvd(2)+sig(16)
    sig = (SIGNATURE + b' ' * 16)[:16]
    header = (
        TAUD_MAGIC +
        bytes([TAUD_VERSION, 1]) +
        struct.pack('<I', comp_size) +
        b'\x00\x00' +
        sig
    )
    assert len(header) == TAUD_HEADER_SIZE

    # Pattern bin: for each s3m pattern, for each active channel, 512 bytes
    vprint("  building pattern bin…")
    default_pans = [_default_channel_pan(h.channel_settings[ch]) for ch in active_channels]
    pat_bin = bytearray()
    for pi in range(P):
        grid = patterns[pi]
        for vi, ch in enumerate(active_channels):
            pat_bin += build_pattern(grid, ch, default_pans[vi], h.linear_slides)
    assert len(pat_bin) == num_taud_pats * PATTERN_BYTES

    # Deduplicate identical patterns
    vprint("  deduplicating patterns…")
    orig_count = num_taud_pats
    pat_bin, pat_remap, num_taud_pats = deduplicate_patterns(bytes(pat_bin), orig_count)
    vprint(f"  patterns: {orig_count} → {num_taud_pats} unique ({orig_count - num_taud_pats} deduplicated)")

    # Song table row (16 bytes): offset(4)+voices(1)+patsLo(1)+patsHi(1)+bpm(1)+tick(1)+pad(7)
    # Built after dedup so num_taud_pats reflects the unique count.
    num_taud_pats_lo = num_taud_pats & 0xFF
    num_taud_pats_hi = (num_taud_pats >> 8) & 0xFF
    song_table = struct.pack('<IBBBBB',
        song_offset,
        C,
        num_taud_pats_lo,
        num_taud_pats_hi,
        bpm_stored,
        speed,
    ) + b'\x00' * 7
    assert len(song_table) == TAUD_SONG_ENTRY

    # Cue sheet (using remapped pattern indices)
    vprint("  building cue sheet…")
    cue_sheet = build_cue_sheet(h.order_list, P, C, pat_remap)
    assert len(cue_sheet) == NUM_CUES * CUE_SIZE

    return header + compressed + song_table + bytes(pat_bin) + cue_sheet


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    global VERBOSE
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',  help='Input .s3m file')
    ap.add_argument('output', help='Output .taud file')
    ap.add_argument('-v', '--verbose', action='store_true',
                    help='Print conversion details to stderr')
    args = ap.parse_args()

    VERBOSE = args.verbose

    with open(args.input, 'rb') as f:
        data = f.read()

    vprint(f"parsing '{args.input}' ({len(data)} bytes)…")
    h = parse_s3m(data)
    vprint(f"  title: '{h.title}'")
    vprint(f"  orders={h.order_count}, instruments={h.inst_count}, patterns={h.pat_count}")

    instruments = parse_instruments(data, h)
    patterns    = parse_patterns(data, h)

    taud = assemble_taud(h, instruments, patterns)

    with open(args.output, 'wb') as f:
        f.write(taud)

    print(f"wrote {len(taud)} bytes to '{args.output}'")
    if VERBOSE:
        print(f"  magic ok: {taud[:8].hex()}", file=sys.stderr)


if __name__ == '__main__':
    main()
