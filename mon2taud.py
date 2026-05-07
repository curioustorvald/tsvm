#!/usr/bin/env python3
"""mon2taud.py — Convert Monotone (.MON) tracker modules to TSVM Taud (.taud)

Usage:
    python3 mon2taud.py input.MON output.taud [-v]

Monotone is Calvin "Trixter" French's tracker for the PC speaker / Tandy /
TI-99 SN76489. It has no user-defined instruments (the only instrument is
the beeper), 1..12 voices, 64 rows per pattern, ProTracker-flavoured 2-byte
cells and a reduced 8-effect set: 0,1,2,3,4,B,D,F.

This converter:
    - synthesises a single 32-byte squarewave instrument (instrument #1)
    - splits each Monotone pattern (64 × N voices) into N Taud patterns
    - converts notes (A0=27.5 Hz chromatic) to Taud 4096-TET centred on C4
    - maps the 8 Monotone effects to their closest Taud equivalents
    - emits Hz/tick slides (1xx/2xx/3xx) verbatim and turns on Taud's
      linear-frequency tone mode (Effect 1 ff=2) so the engine interprets
      E/F/G arguments as Hz at A4=440 Hz reference — no scaling drift

Limits: numVoices ≤ 20, numPatterns × numVoices ≤ 4095.
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
    TOP_NONE, TOP_A, TOP_B, TOP_C, TOP_E, TOP_F, TOP_G, TOP_H, TOP_J,
    SEL_SET, SEL_FINE,
    J_SEMI_TABLE,
    encode_cue, deduplicate_patterns, encode_song_entry,
)


# ── Monotone constants ───────────────────────────────────────────────────────

MON_MAGIC_PREFIX  = b'\x08MONOTONE'        # only the first 9 bytes are stable
MON_HEADER_SIZE   = 0x15F                  # 92 magic + 3 meta + 256 order list
MON_PATTERN_ROWS  = 64
MON_CELL_BYTES    = 2

# Effect-code (3-bit) → ProTracker-style letter, following the format-doc table.
MON_EFFECT_LETTERS = ['0', '1', '2', '3', '4', 'B', 'D', 'F']

# Note value 1 = A0; C4 sits at value 40 (A0 + 39 semitones).
MON_NOTE_C4 = 40

# Global behaviour flags byte (Taud Effect 1 / song-table byte 15):
#   bit 0   (p)  : pan law              — leave 0 (linear) for tracker accuracy
#   bits 1-2 (ff): tone mode             — 2 = linear-frequency (Hz/tick)
# Selecting ff=2 makes the engine interpret 1xx/2xx/3xx slide arguments in
# audible Hz at the A4=440 Hz reference, matching Monotone's MT_PLAY.PAS
# `Frequency:=Frequency±parm1` arithmetic (see MTSRC/MT_PLAY.PAS:606-630).
GLOBAL_FLAGS_LINEAR_FREQ = 0b100


# ── Taud container ───────────────────────────────────────────────────────────

SIGNATURE = b"mon2taud/TSVM "    # 14 bytes


# ── Monotone parser ──────────────────────────────────────────────────────────

class MonRow:
    __slots__ = ('note', 'effect', 'effect_arg')
    def __init__(self):
        self.note       = 0      # 0 = empty, 0x7F = note off, else 1..126
        self.effect     = 0      # 0..7 (raw 3-bit code)
        self.effect_arg = 0      # 0..63 (6-bit data)


def parse_mon(data: bytes):
    if len(data) < MON_HEADER_SIZE:
        sys.exit(f"error: file too short ({len(data)} bytes); "
                 f"need at least {MON_HEADER_SIZE} for the header")

    if data[:9] != MON_MAGIC_PREFIX:
        sys.exit(f"error: bad magic; expected '\\x08MONOTONE', got {data[:9]!r}")

    song_len   = data[0x5C]
    num_voices = data[0x5D]
    if num_voices < 1 or num_voices > 12:
        sys.exit(f"error: invalid voice count {num_voices} (expected 1..12)")

    order_raw = data[0x5F:0x15F]
    # Effective order list: take first song_len entries and drop 0xFF skip-slots
    # (matches mtreader.lua and MT_PLAY.PAS' "ignore 0xFF" semantics).
    order_list = [b for b in order_raw[:song_len] if b != 0xFF]
    if not order_list:
        sys.exit("error: order list is empty after filtering 0xFF skip slots")

    n_patterns = max(order_list) + 1
    pattern_size = MON_PATTERN_ROWS * num_voices * MON_CELL_BYTES
    expected = MON_HEADER_SIZE + n_patterns * pattern_size
    if len(data) < expected:
        sys.exit(f"error: file truncated; expected {expected} bytes for "
                 f"{n_patterns} patterns × {num_voices} voices, got {len(data)}")

    # patterns[pi][voice][row] -> MonRow
    patterns = []
    for pi in range(n_patterns):
        base = MON_HEADER_SIZE + pi * pattern_size
        grid = [[MonRow() for _ in range(MON_PATTERN_ROWS)] for _ in range(num_voices)]
        for r in range(MON_PATTERN_ROWS):
            row_off = base + r * num_voices * MON_CELL_BYTES
            for v in range(num_voices):
                cell_off = row_off + v * MON_CELL_BYTES
                # Little-endian 16-bit cell.
                word = data[cell_off] | (data[cell_off + 1] << 8)
                cell = grid[v][r]
                cell.note       = (word >> 9) & 0x7F
                cell.effect     = (word >> 6) & 0x07
                cell.effect_arg = word & 0x3F
        patterns.append(grid)

    return {
        'song_len':   song_len,
        'num_voices': num_voices,
        'order_list': order_list,
        'n_patterns': n_patterns,
        'patterns':   patterns,
    }


# ── Note conversion (Monotone → Taud 4096-TET) ───────────────────────────────

def mon_note_to_taud(mon_note: int) -> int:
    if mon_note == 0:
        return NOTE_NOP
    if mon_note == 0x7F:
        return NOTE_CUT
    val = TAUD_C4 + round((mon_note - MON_NOTE_C4) * 4096.0 / 12.0)
    return max(1, min(0xFFFD, val))


# ── Effect mapping (Monotone 3-bit code + 6-bit data → Taud) ─────────────────

def encode_effect(eff_code: int, data: int) -> tuple:
    """Return (taud_op, taud_arg16)."""
    letter = MON_EFFECT_LETTERS[eff_code & 7]

    if letter == '0':
        if data == 0:
            return (TOP_NONE, 0)
        x = (data >> 3) & 0x7
        y = data & 0x7
        return (TOP_J, (J_SEMI_TABLE[x] << 8) | J_SEMI_TABLE[y])

    if letter == '1':                                # slide up Hz/tick → Taud F (Hz/tick under ff=2)
        return (TOP_F, data & 0xFFFF)

    if letter == '2':                                # slide down Hz/tick → Taud E (Hz/tick under ff=2)
        return (TOP_E, data & 0xFFFF)

    if letter == '3':                                # tone porta Hz/tick → Taud G (Hz/tick under ff=2)
        return (TOP_G, data & 0xFFFF)

    if letter == '4':                                # vibrato xy → Taud H
        x = (data >> 3) & 0x7        # speed (3 bits)
        y = data & 0x7               # depth (3 bits)
        # Scale 3-bit nibble (0..7) to 8-bit byte (0..252) via × 0x24 (= 36).
        return (TOP_H, ((x * 0x24) << 8) | (y * 0x24))

    if letter == 'B':                                # position jump → Taud B
        return (TOP_B, data & 0xFF)

    if letter == 'D':                                # pattern break → Taud C
        return (TOP_C, data & 0xFF)

    if letter == 'F':                                # set speed → Taud A
        if data == 0:                                # invalid in Monotone
            return (TOP_NONE, 0)
        return (TOP_A, (data & 0xFF) << 8)

    return (TOP_NONE, 0)


# ── Squarewave instrument synthesis ──────────────────────────────────────────

# 32-byte single-cycle 50%-duty square; played at 8372 Hz at C4 → 261.6 Hz tone.
SQUARE_SAMPLE = bytes([0xFF] * 16 + [0x00] * 16)
SQUARE_C2SPD  = 8372

def build_sample_inst_bin() -> bytes:
    """Emit the full 786432-byte sample+instrument bin.

    Instrument 1 carries the synthesised square wave; all other slots stay
    zero. Sample bin starts with the 32-byte square at offset 0; rest is
    silence padding.
    """
    sample_bin = bytearray(SAMPLEBIN_SIZE)
    sample_bin[0:len(SQUARE_SAMPLE)] = SQUARE_SAMPLE

    inst_bin = bytearray(INSTBIN_SIZE)
    base = 1 * 256       # instrument #1 (slot 0 always blank)
    struct.pack_into('<I', inst_bin, base + 0,  0)                       # sample ptr
    struct.pack_into('<H', inst_bin, base + 4,  len(SQUARE_SAMPLE))      # length
    struct.pack_into('<H', inst_bin, base + 6,  SQUARE_C2SPD)            # rate at C4
    struct.pack_into('<H', inst_bin, base + 8,  0)                       # play start
    struct.pack_into('<H', inst_bin, base + 10, 0)                       # loop start
    struct.pack_into('<H', inst_bin, base + 12, len(SQUARE_SAMPLE))      # loop end
    inst_bin[base + 14] = 0x01                                           # forward loop
    struct.pack_into('<H', inst_bin, base + 15, 0x2020)                  # vol-env: P (bit 13) | b (bit 5)
    struct.pack_into('<H', inst_bin, base + 17, 0)                       # pan-env flags (P=0 → mixer skips)
    struct.pack_into('<H', inst_bin, base + 19, 0)                       # pitch-env flags (P=0 → mixer skips)
    inst_bin[base + 21] = 63                                             # vol env pt 0 = full
    inst_bin[base + 22] = 0
    inst_bin[base + 171] = 0xA0                                          # IGV
    inst_bin[base + 177] = 0x80                                          # default pan = centre
    inst_bin[base + 182] = 0xFF                                          # filter cutoff off
    inst_bin[base + 183] = 0xFF                                          # filter resonance off
    inst_bin[base + 186] = 0x01                                          # NNA: cut

    return bytes(sample_bin) + bytes(inst_bin)


# ── Pattern build ────────────────────────────────────────────────────────────

def build_taud_pattern(grid: list, voice: int) -> bytes:
    """Build one 512-byte Taud pattern from one Monotone voice's 64 rows."""
    out = bytearray(PATTERN_BYTES)
    rows = grid[voice]
    for r, row in enumerate(rows):
        note_taud = mon_note_to_taud(row.note)
        # Trigger instrument #1 only when an actual note (1..0x7E) starts.
        triggers = (1 <= row.note <= 0x7E)

        op, arg = encode_effect(row.effect, row.effect_arg)

        # Volume column: Monotone has none → permanent no-op (FINE 0).
        vol_byte = (SEL_FINE << 6) | 0
        # Pan column: SET centre on row 0, no-op afterwards.
        if r == 0:
            pan_byte = (SEL_SET << 6) | 32
        else:
            pan_byte = (SEL_FINE << 6) | 0

        base = r * 8
        struct.pack_into('<H', out, base + 0, note_taud)
        out[base + 2] = 1 if triggers else 0
        out[base + 3] = vol_byte
        out[base + 4] = pan_byte
        out[base + 5] = op & 0xFF
        struct.pack_into('<H', out, base + 6, arg & 0xFFFF)

    return bytes(out)


def build_cue_sheet(order_list: list, num_voices: int, pat_remap: dict) -> bytes:
    """One cue per order-list entry; last cue carries the halt instruction."""
    sheet = bytearray(NUM_CUES * CUE_SIZE)
    for c in range(NUM_CUES):
        sheet[c*CUE_SIZE : (c+1)*CUE_SIZE] = encode_cue([], 0)

    cue_idx = 0
    last_active = -1
    for order in order_list:
        if cue_idx >= NUM_CUES:
            break
        orig_pats = [order * num_voices + v for v in range(num_voices)]
        mapped    = [pat_remap[p] for p in orig_pats]
        sheet[cue_idx*CUE_SIZE : (cue_idx+1)*CUE_SIZE] = encode_cue(mapped, 0)
        last_active = cue_idx
        cue_idx += 1

    if last_active >= 0:
        sheet[last_active * CUE_SIZE + 30] = 0x01

    return bytes(sheet)


# ── Initial speed scan ───────────────────────────────────────────────────────

def find_initial_speed(patterns: list, order_list: list, num_voices: int) -> int:
    """Pick up an Fxx in the first ordered pattern's row 0 if present.

    Default tempo per MT_PLAY.PAS:238-239 is `max(numTracks, 4)`.
    """
    default_speed = max(num_voices, 4)
    if not order_list:
        return default_speed
    first = order_list[0]
    if first >= len(patterns):
        return default_speed
    grid = patterns[first]
    for v in range(num_voices):
        row = grid[v][0]
        if row.effect == 7 and 0 < row.effect_arg < 0x40:    # Fxx (idx 7)
            return row.effect_arg
    return default_speed


# ── Top-level assembly ───────────────────────────────────────────────────────

def assemble_taud(mon: dict) -> bytes:
    num_voices = mon['num_voices']
    patterns   = mon['patterns']
    order_list = mon['order_list']
    n_patterns = mon['n_patterns']

    if num_voices > NUM_VOICES:
        vprint(f"  warning: {num_voices} voices > {NUM_VOICES}; truncating")
        num_voices = NUM_VOICES

    if n_patterns * num_voices > NUM_PATTERNS_MAX:
        sys.exit(
            f"error: {n_patterns} patterns × {num_voices} voices = "
            f"{n_patterns*num_voices} > {NUM_PATTERNS_MAX} Taud limit"
        )

    vprint(f"  voices: {num_voices}, mon patterns: {n_patterns}, "
           f"taud patterns: {n_patterns * num_voices}")

    speed = find_initial_speed(patterns, order_list, num_voices)
    vprint(f"  initial speed (ticks/row): {speed}")

    vprint("  building sample/instrument bin…")
    sampleinst_raw = build_sample_inst_bin()
    assert len(sampleinst_raw) == SAMPLEINST_SIZE
    compressed = gzip.compress(sampleinst_raw, compresslevel=9, mtime=0)
    comp_size  = len(compressed)
    vprint(f"  sample+inst bin: {SAMPLEINST_SIZE} → {comp_size} bytes (gzip)")

    vprint("  building pattern bin…")
    pat_bin = bytearray()
    for pi in range(n_patterns):
        grid = patterns[pi]
        for v in range(num_voices):
            pat_bin += build_taud_pattern(grid, v)
    assert len(pat_bin) == n_patterns * num_voices * PATTERN_BYTES

    vprint("  deduplicating patterns…")
    orig_count = n_patterns * num_voices
    pat_bin, pat_remap, num_taud_pats = deduplicate_patterns(bytes(pat_bin), orig_count)
    vprint(f"  patterns: {orig_count} → {num_taud_pats} unique "
           f"({orig_count - num_taud_pats} deduplicated)")

    vprint("  building cue sheet…")
    cue_sheet = build_cue_sheet(order_list, num_voices, pat_remap)
    assert len(cue_sheet) == NUM_CUES * CUE_SIZE

    pat_comp = gzip.compress(bytes(pat_bin),  compresslevel=9, mtime=0)
    cue_comp = gzip.compress(bytes(cue_sheet), compresslevel=9, mtime=0)
    vprint(f"  pattern bin: {len(pat_bin)} → {len(pat_comp)} bytes (gzip)")
    vprint(f"  cue sheet:   {len(cue_sheet)} → {len(cue_comp)} bytes (gzip)")

    # Header: magic, version, num_songs=1, comp_size of sample+inst, projOff=0, sig.
    sig = (SIGNATURE + b' ' * 14)[:14]
    header = (
        TAUD_MAGIC
        + bytes([TAUD_VERSION, 1])
        + struct.pack('<I', comp_size)
        + b'\x00\x00\x00\x00'
        + sig
    )
    assert len(header) == TAUD_HEADER_SIZE

    song_offset = TAUD_HEADER_SIZE + comp_size + TAUD_SONG_ENTRY

    # BPM 150 + ticks=mon_speed → row rate = 60/mon_speed (matches Monotone).
    bpm_stored = 150 - 24
    # Linear-frequency tone mode (ff=2) so 1xx/2xx/3xx Hz/tick semantics survive verbatim;
    # pan law stays 0 (linear), bit 2 stays 0 (reserved). Monotone has no instrument-level
    # fadeout, so every Taud instrument carries fadeout=0 ("no fade") — notes retire on
    # sample-end or pattern note-cut instead.
    flags_byte = GLOBAL_FLAGS_LINEAR_FREQ

    song_table = encode_song_entry(
        song_offset       = song_offset,
        num_voices        = num_voices,
        num_patterns      = num_taud_pats,
        bpm_stored        = bpm_stored,
        tick_rate         = speed,
        base_note         = 0xA000,
        base_freq         = SQUARE_C2SPD,
        flags_byte        = flags_byte,
        pat_bin_comp_size = len(pat_comp),
        cue_sheet_comp_size = len(cue_comp),
        global_vol        = 0xFF,
        mixing_vol        = round(180 / num_voices),
    )
    assert len(song_table) == TAUD_SONG_ENTRY

    return header + compressed + song_table + pat_comp + cue_comp


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',  help='Input .MON file')
    ap.add_argument('output', help='Output .taud file')
    ap.add_argument('-v', '--verbose', action='store_true',
                    help='Print conversion details to stderr')
    args = ap.parse_args()

    set_verbose(args.verbose)

    with open(args.input, 'rb') as f:
        data = f.read()

    vprint(f"parsing '{args.input}' ({len(data)} bytes)…")
    mon = parse_mon(data)
    vprint(f"  songLen={mon['song_len']}, voices={mon['num_voices']}, "
           f"patterns={mon['n_patterns']}, orders={len(mon['order_list'])}")

    taud = assemble_taud(mon)

    with open(args.output, 'wb') as f:
        f.write(taud)

    print(f"wrote {len(taud)} bytes to '{args.output}'")
    if args.verbose:
        print(f"  magic ok: {taud[:8].hex()}", file=sys.stderr)


if __name__ == '__main__':
    main()
