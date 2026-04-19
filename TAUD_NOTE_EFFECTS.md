# Taud Tracker Effect Command Reference

Taud is a tracker-style music format derived from ScreamTracker 3's pattern command set, extended to 16-bit effect arguments and a 4096-tone equal-temperament pitch grid. This document defines every effect command a Taud engine must implement. Each command entry has three parts: a plain explanation for composers, compatibility notes for converting patterns from ScreamTracker 3 (ST3) or ProTracker (PT), and implementation details for engine writers.

---

## 1. Sound device

- **Bit depth:** 8-bit unsigned throughout, including the final mixdown.
- **Sample rate:** fixed at 32000 Hz.
- **Output channels:** strictly stereo; the mix bus always produces a two-channel frame even for mono-source samples.

Internal accumulators may widen to 16 or 32 bits during mixing and effect computation, but stored samples and final output are 8-bit.

## 2. Pitch system — 4096-TET

One octave spans **4096 pitch units** ($1000 exactly). A 12-TET semitone therefore equals **4096 ÷ 12 ≈ 341.333 units** (≈ $0155.55), which is not an integer; this irrationality is a deliberate consequence of choosing a microtonal native grid. Implementations store channel pitch as a signed integer in Taud units, and convert to playback rate using

```
playback_rate = reference_rate × 2 ^ (pitch_units / 4096)
```

Commonly used intervals in Taud units are listed below; all are rounded to the nearest integer.

| Interval | Units (exact) | Hex (rounded) |
|---|---|---|
| Octave | 4096 | $1000 |
| Perfect fifth (7 ST) | 2389.33 | $0955 |
| Tritone (6 ST) | 2048 | $0800 |
| Major third (4 ST) | 1365.33 | $0555 |
| Minor third (3 ST) | 1024 | $0400 |
| 1 semitone | 341.33 | $0155 |
| 1/8 semitone (1 finetune) | 42.67 | $002B |
| 1/16 semitone | 21.33 | $0015 |
| 1/64 semitone | 5.33 | $0005 |
| 1 cent (1/100 semitone) | 3.41 | $0003 |

## 3. Volume system

Per-note and per-channel volume runs from **$00 (silent) to $3F (full)**, a 6-bit range narrower than ST3's 0..$40. Global volume (effect V) runs 0..$FF; this wider range lets the mix bus scale the summed channel output without disturbing individual note volumes. The per-frame mix chain per channel is

```
mix = sample × note_vol × channel_vol × global_vol >> normalisation_shift
```

with saturation applied before the 8-bit stereo output.

## 4. Rows, ticks, patterns, orders

A pattern is a rectangular grid of rows and channels; each cell holds one note event. Playback divides each row into `speed` ticks (effect A); tempo (effect T) sets the duration of one tick. At 125 BPM and speed 6, one row takes 120 ms and one tick 20 ms. Songs play patterns in an order sequence; effects B and C navigate this sequence.

## 5. Default parameters at song start

| Parameter | Value |
|---|---|
| Speed | $06 (6 ticks/row) |
| Tempo byte | $65 (125 BPM; see effect T for the $18 offset) |
| Global volume | $80 (mid-scale) |
| Channel volume | $3F (full) |
| Pan (all channels) | $80 (centre) |
| Order index | $0000 |

## 6. Effect memory groups

Most effects recall their last non-zero argument when re-issued with $0000. Unlike ST3, which shares one memory slot across most effects, Taud groups memories into four cohorts plus private slots:

- **E and F share one slot** (pitch slide down and up). Issuing E $0000 recalls the last E-or-F argument and re-applies it as a down-slide; F $0000 does the same as an up-slide.
- **G has its own slot** (tone portamento).
- **H and U share one slot** (vibrato speed and depth are jointly recalled; the last-written values persist across both commands).
- **R has its own slot** (tremolo).

Every other memory-carrying effect (D, I, J, K, L, O, Q, and others) has a private slot.

## 7. Opcode and argument format

Opcodes are single base-36 digits (0-9, then A-Z); arguments are 16-bit hexadecimal values prefixed with `$`. A cell is notated `OPCODE $HHLL` where HH is the high byte and LL is the low byte. Where an effect partitions its argument into sub-fields (for instance, H's speed and depth), the split is spelled out in the command description.

---

# The effects

## A $xx00 — Set tick speed to $xx

**Plain.** Sets how many ticks each row contains. Lower values make rows shorter and per-tick effects (slides, vibrato) develop faster; higher values stretch the row and give effects more iterations.

**Compatibility.** ST3 `Axx` maps one-to-one: Taud `A $xx00`. ST3 `A00` is a no-op; Taud `A $0000` is likewise ignored. ProTracker `Fxx` with `xx < $20` maps to Taud `A $xx00`; `Fxx` with `xx ≥ $20` maps to T instead (see T).

**Implementation.** If the high byte is non-zero, write it to `ticks_per_row`; the low byte is reserved and must be zero. The change takes effect from the row on which the A command appears. There is no memory for A.

---

## B $xxyy — Jump to order $xxyy

**Plain.** Finishes the current row, then continues playback at row 0 of the pattern at order position $xxyy. Use this to create song-level jumps, loops, or branching structures.

**Compatibility.** ST3 `Bxx` jumps to an 8-bit order and maps to Taud `B $00xx`. The extended 16-bit range means Taud songs may have up to $10000 order entries.

**Implementation.** On the last tick of the current row, set the next order index to the argument and the next row to 0. If the argument exceeds the song length, wrap to the song's defined restart position (order $0000 by default). Jumps are detected by a visited `(order, row)` set so that pathological loops do not prevent song-length computation, though they do not interrupt actual playback. There is no memory for B.

**Simultaneous B and C on the same row.** If a B command appears in the same row as a C command (on any channel), both fire: B chooses the order, C chooses the row within that order. If the two commands appear on different channels, channel priority is **ascending channel index** — the lowest-numbered channel carrying either effect wins its parameter. If both appear on the same channel row (only possible if one is a volume-column equivalent), the effect column takes precedence.

---

## C $xxyy — Break pattern to row $xxyy

**Plain.** Finishes the current row, then skips ahead to row $xxyy of the **next** pattern in the order sequence.

**Compatibility.** ST3 stores `Cxx` as **BCD** (so on-disk `$10` means decimal row 10); Taud stores the argument as plain binary. When converting from ST3, decode with `row = (byte >> 4) × 10 + (byte & $0F)`. Valid ST3 source bytes are those representing decimal 0..63; out-of-range BCD bytes should clamp to row 0 on import. When exporting back to ST3, encode with `byte = ((row / 10) << 4) | (row % 10)`, clamped at row 63.

**Implementation.** On the last tick of the current row, advance the order index by 1 (or honour a co-occurring B), then set the next row to the argument. If the argument exceeds the destination pattern's row count, start the destination pattern at row 0. There is no memory for C.

---

## D — Volume slide (multiple forms)

D's 16-bit argument encodes four mutually exclusive modes using the top nibble and the following byte. All forms operate on the channel's current volume and clip to $00..$3F after each step.

### D $0y00 — Volume slide down by $y per non-first tick

**Plain.** Each tick after tick 0, volume decreases by $y. A D $0400 at speed 8 reduces volume by $1C over the row.

**Compatibility.** ST3 `Dx0` (volume slide down) maps to Taud `D $0x00`. The ST3 volume cap was $40; Taud's is $3F — a very high-volume sample reaching $40 in ST3 will snap to $3F in Taud.

**Implementation.** On ticks > 0, subtract the low nibble of the high byte from `channel_volume`; clamp at $00. Memory is private to D and is keyed on the full original byte (so D $0000 recalls whatever form last ran).

### D $x000 — Volume slide up by $x per non-first tick

**Plain.** Each tick after tick 0, volume increases by $x. Capped at $3F.

**Compatibility.** ST3 `D0y` (volume slide up) maps to Taud `D $y000`.

**Implementation.** On ticks > 0, add the high nibble of the high byte to `channel_volume`; clamp at $3F.

### D $Fy00 — Fine volume slide down by $y on tick 0

**Plain.** Applies a one-shot volume reduction of $y on tick 0 only. Independent of speed. A D $FF00 behaves as a fine slide up by $F (so a request for "down by F" is reinterpreted; see below).

**Compatibility.** ST3 `DFy` maps directly. The $FF edge case is preserved: ST3 treats `DFF` as fine slide up by $F rather than fine slide down by $F, and Taud follows suit.

**Implementation.** On tick 0 only, subtract the low nibble of the high byte from `channel_volume`. If the low nibble is $0, treat as fine-slide-up by $F. If the high byte is $FF, treat as fine-slide-up by $F.

### D $xF00 — Fine volume slide up by $x on tick 0

**Plain.** One-shot volume increase of $x on tick 0 only.

**Compatibility.** ST3 `DxF` maps directly. Volume cap is $3F, lower than ST3's $40.

**Implementation.** On tick 0 only, add the high nibble to `channel_volume`; clamp at $3F.

---

## E $xxxx — Pitch slide down by $xxxx (linear)

**Plain.** Lowers the channel's pitch by the argument per tick. Taud's pitch slides are **linear in the 4096-TET grid** — the slide value is subtracted directly from the stored pitch, without any period-table indirection. A coarse slide uses the full value range; a fine slide applies only once per row; an extra-fine slide is not provided (the 16-bit argument already gives microtonal precision below 1/64 semitone).

Coarse and fine modes are distinguished by the high nibble of the argument:

- `E $0001..$EFFF` — coarse slide: subtracts the full argument from pitch each tick after tick 0. A slide of $0155 drops pitch by one semitone per tick.
- `E $F000..$FFFF` — fine slide: on tick 0 only, subtracts `arg & $0FFF` from pitch.
- `E $0000` — recalls the last E-or-F argument and applies it as a down-slide, preserving the original form (coarse or fine).

**Compatibility.** This is **the single intentionally ST3-incompatible command in Taud**. ST3 pitch slides operate on Amiga periods or linear slide units; Taud operates directly on 4096-TET pitch units. Conversion from ST3 linear-mode slides uses 1 ST3 slide unit ≈ $0005 Taud units (1/64 semitone):

- ST3 `Exx` coarse (where `xx < $E0`) → Taud `E $00xx × $0015` (one ST3 coarse unit = 1/16 semitone ≈ $0015 Taud units).
- ST3 `EFx` fine → Taud `E $F0xx × $0015` with appropriate range packing.
- ST3 `EEx` extra-fine → Taud `E $F0xx × $0005` (one ST3 extra-fine unit = 1/64 semitone ≈ $0005 Taud units).

ST3 Amiga-mode slides do not have a clean conversion and should be treated as linear-mode equivalents during import.

Because E and F share memory in Taud (narrower than ST3's broad shared memory), an ST3 song that used `E00` or `F00` to recall a D, G, or Q argument will break on import; the converter must eagerly resolve ST3 recalls into explicit Taud arguments rather than relying on memory.

**Implementation.** Per-tick processing:

```
on row start:
    raw = arg
    if raw == 0: raw = memory_EF
    else: memory_EF = raw
    if (raw & $F000) == $F000:          # fine
        pitch -= (raw & $0FFF)
        mode_this_row = FINE
    else:                                # coarse
        slide_amount_this_row = raw
        mode_this_row = COARSE

on tick > 0:
    if mode_this_row == COARSE:
        pitch -= slide_amount_this_row
```

Glissando control (S $1x) snaps the output pitch to the nearest semitone after every slide application; see S $1x.

---

## F $xxxx — Pitch slide up by $xxxx (linear)

**Plain.** Raises the channel's pitch by the argument per tick, with the same mode-selection scheme as E. Coarse, fine, and memory behaviour are identical in form but inverted in direction.

**Compatibility.** Same as E. ST3 `Fxx` coarse, `FFx` fine, and `FEx` extra-fine convert with the same scaling factors ($0015 and $0005). F and E share one memory slot in Taud.

**Implementation.** As for E, but add instead of subtract. No upper pitch cap is defined by the effect itself, but the sample-rate conversion at the mixer will saturate well before arithmetic overflow at reasonable playing ranges.

---

## G $xxxx — Tone portamento with speed $xxxx

**Plain.** Slides the channel's current pitch toward the note specified in the same row, at $xxxx Taud units per tick (after tick 0), stopping when the target is reached. A row with G and a note does **not** re-trigger the sample — the note's pitch becomes the portamento target and the already-sounding sample continues at its current pitch.

**Compatibility.** ST3 `Gxx` uses an 8-bit value in period-table units; convert to Taud using the same $0015-per-unit scale as E/F coarse (1/16 semitone per ST3 slide unit). ST3 linear mode is the expected import source; Amiga-mode G sources should be treated as linear. G has its **own** memory slot in both ST3 and Taud, so conversion is straightforward and does not suffer the shared-memory problem of E/F.

**Implementation.**

```
on row parse:
    if row has note and G effect:
        target_pitch = period_for(note)
        # do NOT re-trigger sample
    if arg != 0:
        memory_G = arg
    speed_this_row = memory_G

on tick > 0:
    if target_pitch set:
        delta = sign(target_pitch - pitch) × speed_this_row
        pitch += delta
        if sign crossed target: pitch = target_pitch; target_pitch = None
```

Glissando (S $1x) snaps the output frequency to the nearest semitone ($0155 step approximation) after each advance without changing the internal pitch counter; it affects only what the mixer sees.

---

## H $xxyy — Vibrato with speed $xx and depth $yy

**Plain.** Modulates pitch with a low-frequency oscillator (LFO). `$xx` is the LFO speed (high byte), `$yy` is the depth (low byte). On H rows the LFO accumulator advances at `$xx × 4` per tick through a 256-entry lookup of the selected waveform (see S $3x). The current pitch offset is added to the channel's base pitch for the duration of each tick.

**Compatibility.** ST3 `Hxy` uses 4-bit nibbles for speed and depth; convert by nibble-repeating each into Taud's bytes: ST3 `H27` → Taud `H $2277`. This preserves the effective LFO rate and peak depth. H and U share memory in Taud (they did in ST3 too).

Unlike ProTracker, ST3 vibrato fires on tick 0 as well; Taud follows ST3.

**Implementation.** The reference sine table is OpenMPT's 64-entry 8-bit table, indexed `pos >> 2` through a 256-entry logical LFO (equivalently, a 256-sample 4×-oversampled sine peaking at ±$7F):

```
ModSinusTable[64] =
    00 0C 19 25 31 3C 47 51 5A 62 6A 70 75 7A 7D 7E
    7F 7E 7D 7A 75 70 6A 62 5A 51 47 3C 31 25 19 0C
    00 F4 E7 DB CF C4 B9 AF A6 9E 96 90 8B 86 83 82
    81 82 83 86 8B 90 96 9E A6 AF B9 C4 CF DB E7 F4
```

Per row/tick:

```
on row parse (H):
    if (arg >> 8)  != 0: memory_HU.speed = arg >> 8
    if (arg & $FF) != 0: memory_HU.depth = arg & $FF

on every tick (including tick 0):
    sine = ModSinusTable[(lfo_pos >> 2) & $3F]    # signed -$80..+$7F
    pitch_delta = (sine × memory_HU.depth) >> 6
    applied_pitch = base_pitch + pitch_delta
    lfo_pos = (lfo_pos + memory_HU.speed × 4) & $FF
```

At maximum speed and depth ($FFFF), peak `pitch_delta` is `$7F × $FF >> 6 ≈ $1FA` — about 1.5 semitones. On a fresh note, if the current LFO waveform retrigger bit is clear (S $3x with $x < $4), `lfo_pos` resets to 0. When the waveform is "random", a fresh random value is drawn every tick rather than read from the table.

---

## U $xxyy — Fine vibrato with speed $xx and depth $yy

**Plain.** Same LFO as H but four times finer in pitch — useful for subtle microtonal warbles.

**Compatibility.** ST3 `Uxy` uses nibbles; nibble-repeat each to convert. U shares memory with H.

**Implementation.** Identical to H except the shift is 8 instead of 6:

```
pitch_delta = (sine × memory_HU.depth) >> 8
```

Peak at maximum settings: $7F × $FF >> 8 ≈ $7E, about 0.4 semitone — exactly a quarter of H's peak.

---

## I $xxyy — Tremor with on-time $xx and off-time $yy

**Plain.** Rapidly gates the channel on and off. Volume plays normally for `$xx + 1` ticks, then mutes for `$yy + 1` ticks, repeating. Counters persist across rows and only reset on a fresh I row with a new argument.

**Compatibility.** ST3 `Ixy` uses nibbles (`$xy`) with the same semantics; convert by nibble-repeating each into Taud bytes: ST3 `I47` → Taud `I $4477`. The `+1` behaviour on both counters comes from ProTracker and is preserved throughout. Memory is private.

**Implementation.**

```
on row parse (I):
    if arg != 0: memory_I = arg
    on_time  = ((memory_I >> 8)  & $FF) + 1
    off_time = ( memory_I        & $FF) + 1

on every tick:
    if phase == ON:
        play at full channel volume
        tick_in_phase += 1
        if tick_in_phase >= on_time: phase = OFF; tick_in_phase = 0
    else:
        force output volume to 0 (base volume preserved for later effects)
        tick_in_phase += 1
        if tick_in_phase >= off_time: phase = ON; tick_in_phase = 0
```

A zero `$xx` or `$yy` input becomes 1 tick after the `+1`, never zero.

---

## J $xxyy — Microtonal arpeggio with offsets $xx00 and $yy00

**Plain.** Cycles the playing pitch through three values across consecutive ticks: the note, the note plus `$xx00` Taud units, and the note plus `$yy00` Taud units, repeating. At the default 50 Hz tick rate (speed 6, 125 BPM), this produces a classic chord-arpeggio effect; because Taud's grid is 4096-TET, the intervals can be microtonal.

The encoding places each 8-bit offset byte into the **high byte** of a 16-bit pitch delta, giving 256 discrete intervals per arp voice with a resolution of $0100 ≈ 0.75 semitone per step. This is coarser than E/F's 16-bit slides, but adequate for arpeggios and well-suited to non-12-TET intervals.

**Compatibility.** ST3 `Jxy` uses nibbles as 12-TET semitones; Taud uses bytes as $0100-scaled 4096-TET offsets. The conversion is therefore lossy — 12-TET intervals that are not multiples of 3 semitones incur ±25 cent rounding error. The table below gives the best Taud byte for each 12-TET semitone offset:

| Semitones | Taud byte | Taud units | Error (cents) |
|---|---|---|---|
| 0 | $00 | 0 | 0 |
| 1 | $01 | 256 | −25 |
| 2 | $03 | 768 | +25 |
| 3 | $04 | 1024 | 0 |
| 4 | $05 | 1280 | −25 |
| 5 | $07 | 1792 | +25 |
| 6 | $08 | 2048 | 0 |
| 7 | $09 | 2304 | −25 |
| 8 | $0B | 2816 | +25 |
| 9 | $0C | 3072 | 0 |
| 10 | $0D | 3328 | −25 |
| 11 | $0F | 3840 | +25 |
| 12 | $10 | 4096 | 0 |

For example, ST3 `J37` (minor chord) imports as Taud `J $0409`; ST3 `J47` (major chord) as Taud `J $0509`. Memory is private and stores the full 16-bit argument.

**Implementation.**

```
on row parse (J):
    if arg != 0: memory_J = arg
    off1 = (memory_J >> 8) & $FF    # high byte
    off2 =  memory_J       & $FF    # low byte

on every tick:
    selector = tick_within_row mod 3
    if selector == 0:   voice_pitch = base_pitch
    elif selector == 1: voice_pitch = base_pitch + (off1 << 8)
    elif selector == 2: voice_pitch = base_pitch + (off2 << 8)
```

The `tick_within_row mod 3` counter resets every row start (so every row begins at `base_pitch`). A subsequent E/F slide after a J row resumes from the last arpeggiated voice's pitch, not from `base_pitch` — this mirrors ST3's `kST3PortaAfterArpeggio` quirk and is deliberately preserved.

---

## K $xy00 — Dual: vibrato continuation and volume slide $xy

**Plain.** **Unimplemented**. On ST3, continues a previously started vibrato (H or U) without retriggering it, while applying a volume slide of `$xy` per non-first tick. Fine volume slides are not available in this form.

**Compatibility.** ST3 `Kxy` maps directly. Implementations must convert K to an explicit pair of commands: `H $0000` (continue with stored speed/depth) combined with volume-column command `1.$xy` (volume slide), and emit both.

**Implementation.** Execute the per-tick vibrato update as if an H command were active with argument $0000 (recall), then execute a D $0y00 or $x000 slide using the bytes of the K argument: high nibble as up-slide, low nibble as down-slide. If both nibbles are non-zero, down-slide takes precedence (matching ST3). K has no memory of its own; it uses H/U's stored speed and depth.

---

## L $xy00 — Dual: tone portamento continuation and volume slide $xy

**Plain.** **Unimplemented**. On ST3, continues a previously started tone portamento (G) without retriggering, while applying a volume slide of `$xy` per non-first tick. Fine volume slides are not available here.

**Compatibility.** ST3 `Lxy` maps directly. Like K, L must be equivalently implemented as `G $0000` plus a volume-column slide.

**Implementation.** Execute the per-tick G update (recalling G's stored speed), then the D slide as in K. L has no memory of its own.

---

## O $xxyy — Set sample offset to $xxyy

**Plain.** On the row where it appears, jumps the sample playhead to byte $xxyy of the sample data. If the sample is looped and the requested offset exceeds the loop end, the offset wraps around through the loop as if playback had reached that point naturally.

**Compatibility.** ST3 `Oxx` is 8-bit, addressing offset `xx × $100`. On import, copy the ST3 byte into Taud's high byte and zero the low byte: Taud `O $xx00`. ProTracker `9xx` maps identically. The Taud 16-bit form allows byte-precise seeking within samples larger than $100 bytes. Memory is private.

**Implementation.** On the row start, set the sample playhead to `arg` (in bytes, relative to the sample's start). Apply the loop-wrap calculation if the sample has loop points and `arg > loop_end`: `arg = loop_start + ((arg - loop_start) mod loop_length)`. The O command does not retrigger the sample; it only relocates the playhead for an already-triggered note.

---

## Q $xy00 — Retrigger note every $y ticks with volume modifier $x

**Plain.** Retriggers the currently playing sample at an interval of `$y` ticks, optionally modifying its volume on each retrigger according to `$x`. The retrigger interval runs across rows until a new Q with a different `$y` or no Q at all.

**Compatibility.** ST3 `Qxy` maps directly. The **`$y == 0` behaviour is preserved from ST3**: the entire effect is ignored (no retrigger, and memory is not updated). Memory is private.

ProTracker `E9x` is equivalent to Taud `Q $0x00` (retrigger only, no volume change).

**Implementation.** A per-channel tick counter advances every tick, including tick 0. When it reaches `$y`, the sample retriggers (keeping current pitch), the counter resets to 0, and the volume modifier `$x` applies. The counter resets only when a row has **no** Q command; successive Q rows share and advance the counter.

The volume modifier table, **computed with arithmetic (no LUT)**, is:

| $x | Action | $x | Action |
|---|---|---|---|
| 0 | no change | 8 | no change |
| 1 | vol − $01 | 9 | vol + $01 |
| 2 | vol − $02 | A | vol + $02 |
| 3 | vol − $04 | B | vol + $04 |
| 4 | vol − $08 | C | vol + $08 |
| 5 | vol − $10 | D | vol + $10 |
| 6 | vol × 2 / 3 | E | vol × 3 / 2 |
| 7 | vol × 1 / 2 | F | vol × 2 |

Multiplicative cases use integer arithmetic: `vol × 2 / 3` is `(vol × 2) / 3` (truncated); `vol × 3 / 2` is `(vol × 3) / 2`; `vol × 1 / 2` is `vol >> 1`; `vol × 2` is `vol << 1`. All results clip to $00..$3F after.

A note previously silenced by a cut (`^^^` or `SCx` earlier in the row) is not retriggered, matching ST3's `kST3RetrigAfterNoteCut` rule.

---

## R $xxyy — Tremolo with speed $xx and depth $yy

**Plain.** Modulates volume with an LFO, symmetrically with H's pitch modulation. `$xx` is LFO speed, `$yy` depth; the waveform is selected by S $4x.

**Compatibility.** ST3 `Rxy` uses nibbles; convert by nibble-repeat. ST3's volume cap is $40; Taud's is $3F — very deep tremolo that would have briefly clipped at $40 in ST3 may clip slightly earlier in Taud. R has its own memory slot (not shared with H/U).

**Implementation.** Identical machinery to H with a larger shift to fit the narrower volume range:

```
on row parse (R):
    if (arg >> 8)  != 0: memory_R.speed = arg >> 8
    if (arg & $FF) != 0: memory_R.depth = arg & $FF

on every tick (including tick 0):
    sine = ModSinusTable[(lfo_pos >> 2) & $3F]
    vol_delta = (sine × memory_R.depth) >> 9
    applied_vol = clamp(base_vol + vol_delta, 0, $3F)
    lfo_pos = (lfo_pos + memory_R.speed × 4) & $FF
```

Peak at maximum settings: $7F × $FF >> 9 = $3F — the full volume range. Retrigger behaviour tracks the S $4x waveform nibble bit 2: cleared means retrigger on new note, set means preserve LFO position.

---

## T $xxyy — Tempo set or tempo slide

Taud splits T by which byte carries the value:

### T $xx00 (high byte non-zero) — Set tempo

**Plain.** Sets the Taud tempo byte to `$xx`. The resulting BPM is `$xx + $18`: Taud byte $00 → 24 BPM, $65 → 125 BPM (default), $FF → 279 BPM.

**Compatibility.** ST3 `Txx` (where `xx ∈ $20..$FF`) stores BPM directly; convert with `taud_byte = xx − $18`. Taud byte $08 corresponds to ST3's minimum BPM of 32; Taud bytes below $08 are inexpressible in ST3 and should round up to $08 (BPM 32) when exporting. OpenMPT's extended tempo slides (`T $0x` down, `T $1x` up) in S3M files map to Taud T $00xx — see below.

ProTracker `Fxx` with `xx ≥ $20` maps to Taud `T $(xx − $18)00`; `Fxx` with `xx < $20` maps to A (speed) instead.

**Implementation.** If the high byte is non-zero, set `tempo_byte = arg >> 8`; derive `BPM = tempo_byte + $18`; compute tick duration as `samples_per_tick = 32000 × 5 / (BPM × 2) = 80000 / BPM` (integer truncated) at the fixed 32000 Hz output rate. Example: BPM 125 → 640 samples per tick; BPM 24 → 3333 samples per tick; BPM 279 → 286 samples per tick. There is no memory for set-tempo.

### T $00xy (high byte zero) — Tempo slide

**Plain.** Adjusts the tempo continuously during the row. `$00_0y` (low nibble under a zero high nibble within the low byte) slides BPM down by `$y` per non-first tick; `$00_1y` slides up. Out-of-range encodings ($00_20 through $00_FF) are reserved and behave as no-ops.

**Compatibility.** ST3 itself has only the set form; the slide forms originate in the OpenMPT/Schism extension of S3M. On export to strict ST3, slide forms are unrepresentable and should be approximated as an equivalent set-tempo on a later row.

**Implementation.**

```
on row parse (T with high byte == 0):
    low = arg & $FF
    if (low & $F0) == $00:
        slide_dir = DOWN
        slide_amount = low & $0F
    elif (low & $F0) == $10:
        slide_dir = UP
        slide_amount = low & $0F
    else:
        ignore row

on tick > 0 (if slide armed):
    if slide_dir == DOWN: tempo_byte = max($00, tempo_byte - slide_amount)
    else:                 tempo_byte = min($FF, tempo_byte + slide_amount)
    recompute samples_per_tick for next tick
```

A tempo slide's memory slot is separate from the set-tempo path and is private to T-slide.

---

## V $xx00 — Set global volume to $xx

**Plain.** Sets the global mix bus volume (0..$FF). $00 is silence; $FF is full. The default is $80.

**Compatibility.** ST3's global volume is 0..$40; convert with `taud_v = st3_v × 4`, clamped at $FF. On export, `st3_v = taud_v >> 2`, clamped at $40.

**Implementation.** Write the high byte to `global_volume` on the row the command appears. The low byte is reserved. ST3's `kST3NoMutedChannels` rule applies: V on a muted channel is ignored by ST3; for strict-compatible playback Taud follows suit, but new Taud compositions should avoid muting channels that carry global effects.

---

# The S subcommand family

S is a multiplexing opcode; the **high nibble of the high byte** selects the sub-effect, and the remainder is the sub-argument.

## S $1x00 — Glissando control

**Plain.** `$1000` turns glissando off; `$1100` turns it on. When on, tone portamento (G) output is quantised to the nearest semitone ($0155 approximation) before being sent to the mixer. The internal G pitch counter still advances smoothly; only the audible pitch steps. **This command is implemented sorely for ST3 compatibility.**

**Compatibility.** ST3 `S10`/`S11` maps directly. In Taud, "nearest semitone" uses the best integer approximation: round `pitch / $155` to the nearest integer, multiply by $155; equivalently, `snapped = (pitch + $AB) / $155 × $155`. Because $155 is an approximation of 4096/12, accumulated rounding across many octaves will drift by up to a few cents; this is documented behaviour and intentional given the microtonal grid.

**Implementation.** Maintain a per-channel boolean `glissando_on`. When G updates `pitch`, if `glissando_on` is set, compute `display_pitch = round(pitch × 12 / 4096) × 4096 / 12` (using integer division with rounding) and send `display_pitch` to the mixer; otherwise send `pitch` directly.

---

## S $2x00 — Set fine-tune

**Plain.** Overrides the current note's fine-tune by applying a fixed 4096-TET offset. The index `$x` selects one of sixteen predefined pitch offsets, following ScreamTracker 3's Hz-based fine-tune table but expressed directly in Taud units. This command is implemented for ST3 compatibility.

**Compatibility.** The index scheme matches ST3 exactly: `$8` is the baseline (no change), `$0..$7` are progressively flatter, `$9..$F` are progressively sharper. The Hz reference values come from the ST3 User's Manual and are reproduced here for auditability; the Taud offset is `log2(Hz / 8363) × 4096`, rounded to the nearest integer. **Format converters are advised to apply offset to the note value directly.**

| $x | Reference Hz | Taud offset |
|---|---|---|
| $0 | 7895 | −$0154 |
| $1 | 7941 | −$0132 |
| $2 | 7985 | −$0111 |
| $3 | 8046 | −$00E4 |
| $4 | 8107 | −$00B8 |
| $5 | 8169 | −$008B |
| $6 | 8232 | −$005D |
| $7 | 8280 | −$003B |
| $8 | 8363 | $0000 |
| $9 | 8413 | +$0023 |
| $A | 8463 | +$0046 |
| $B | 8529 | +$0074 |
| $C | 8581 | +$0098 |
| $D | 8651 | +$00C8 |
| $E | 8723 | +$00F9 |
| $F | 8757 | +$0110 |

ProTracker `E5x` maps to Taud `S $2x00` with the same index meaning.

**Implementation.** On the row, look up the offset from the table and add it to the channel's base pitch before any other per-tick effect processes. The offset persists until another S $2x command or a note-reset event.

---

## S $3x00 — Vibrato LFO waveform

**Plain.** Selects the shape of the vibrato (H and U) oscillator.

| $x | Waveform | Retrigger on new note? |
|---|---|---|
| $0 | Sine | Yes |
| $1 | Ramp down (sawtooth) | Yes |
| $2 | Square | Yes |
| $3 | Random | Yes |
| $4 | Sine | No |
| $5 | Ramp down | No |
| $6 | Square | No |
| $7 | Random | No |

**Compatibility.** ST3 `S3x` maps directly.

**Implementation.** Store `vibrato_waveform = $x & $3` and `vibrato_retrigger = (($x & $4) == 0)` for the channel. The ramp-down shape is `$7F − ((pos & $3F) << 2)` across one logical cycle; the square shape is `sign(sine(pos)) × $7F`; random draws a fresh `rand() & $FF − $80` every tick. On a new note, if `vibrato_retrigger` is true, reset `lfo_pos = 0`.

---

## S $4x00 — Tremolo LFO waveform

**Plain.** Selects the shape of the tremolo (R) oscillator; value encoding is identical to S $3x.

**Compatibility.** ST3 `S4x` maps directly. ProTracker `E7x` maps to Taud `S $4x00`.

**Implementation.** As for S $3x, but applied to R's separate state (`tremolo_waveform`, `tremolo_retrigger`, and tremolo `lfo_pos`).

---

## S $80xx — Set channel pan position

**Plain.** Sets the channel pan to `$xx`, with $00 being full left and $FF being full right. $80 is centre.

**Compatibility.** ST3 `S8x` uses a 4-bit value; convert by nibble-repeat: ST3 `S83` → Taud `S $8033`. Panning column command `0.$xx` has the same semantics and is the preferred form when a pan column is available in the pattern. ProTracker `8xx` (fine pan) and `E8x` (coarse pan) both map into Taud's 8-bit pan — the ProTracker 8-bit form maps directly; the 4-bit form nibble-repeats.

**Implementation.** Write `channel_pan = arg & $FF`. The pan value is applied at the mixer: `left_gain = (($FF − pan) × $100) >> 8`, `right_gain = (pan × $100) >> 8`, with both applied before the global volume stage.

---

## S $Bx00 — Pattern loop

**Plain.** Sets a loop point and loops within a pattern. `S $B000` marks the current row as the loop start (per channel, not per song); `S $Bx00` with $x > 0 returns playback to the saved row and plays the intervening range `$x` more times (so `$B200` plays the loop twice total beyond the initial pass).

**Compatibility.** ST3 `SBx` maps directly. ProTracker `E6x` maps to Taud `S $Bx00`.

ST3 has a long-documented bug where pattern delay (SEx) inside a pattern-loop range causes the loop counter to decrement multiple times per visit, producing unintended behaviour. **Taud fixes this bug.** On import, ST3 songs that relied on the bug will loop fewer times in Taud. Converters that want bit-exact ST3 playback should emit a warning when SBx and SEx appear in the same channel within a loop range, or optionally flatten loops by duplicating rows.

**Implementation.** State per channel: `loop_start_row` (defaulting to 0 at each pattern entry) and `loop_count` (defaulting to 0).

```
on row event (S $Bx00):
    x = (arg >> 8) & $0F
    if x == 0:
        loop_start_row = current_row
    else:
        if loop_count == 0:
            loop_count = x
            jump next_row -> loop_start_row
        else:
            loop_count -= 1
            if loop_count > 0:
                jump next_row -> loop_start_row
            # else loop_count hits 0 on its own; fall through to next row

on pattern change: loop_start_row = 0; loop_count = 0
```

The crucial bug fix relative to ST3: the loop-counter decrement happens **once per actual row playback**, not once per tick-0 invocation. When SBx shares a row with SEx (pattern delay), the pattern-delay machinery replays the row as a unit, but the SBx state machine treats the whole delay group as a single visit. Implement this by gating the SBx decrement on `pattern_delay_repetition == 0`.

---

## S $Cx00 — Note cut in $x ticks

**Plain.** Silences the note on tick `$x` of the current row by forcing the channel's output volume to 0. The sample continues running internally, so a later volume-change or retrigger event can resume audio.

**Compatibility.** ST3 `SCx` maps directly. ProTracker `ECx` also maps directly. ST3 ignores `SC0` (treats it as no cut at all); Taud preserves this.

**Implementation.** On tick `$x`, set `output_volume = 0` but leave `base_volume` unchanged. If `$x ≥ speed`, the cut never fires. If `$x == 0`, the command is ignored. Set the `note_was_cut` flag so a later Q retrigger on the same row is suppressed.

---

## S $Dx00 — Note delay for $x ticks

**Plain.** Delays the triggering of the note (and any co-row instrument, offset, and volume event) until tick `$x`. Until then, any currently playing note continues.

**Compatibility.** ST3 `SDx` maps directly. ProTracker `EDx` also maps directly. `SD0` plays the note normally on tick 0. If `$x ≥ speed`, the note never plays on this row and does not carry over to the next row.

**Implementation.** On row parse, defer the note-trigger event (including sample selection, volume, offset, and any volume-column effect) until tick `$x`. On tick `$x`, execute the deferred trigger. When combined with pattern delay (S $Ex00), the deferred trigger re-fires at the start of each row repetition — matching ST3's `kRowDelayWithNoteDelay` behaviour.

---

## S $Ex00 — Pattern delay for $x row-repeats

**Plain.** Repeats the current row `$x` additional times (so `$x = 0` means no repeat and the row plays once; `$x = 3` means the row plays four times total). Notes do not retrigger across repetitions, but per-tick effects re-run and tick-0 events (fine slides, delayed notes) re-fire on each repetition.

**Compatibility.** ST3 `SEx` maps directly. ProTracker `EEx` also maps directly. Simultaneous SEx on multiple channels: ST3 uses the first SEx in **pan order** (L1..L8 then R1..R8); **Taud uses the first SEx in ascending channel-index order** for predictability. Converters that encounter ST3 songs relying on the pan-order rule should emit a warning.

Q retrigger counters do **not** reset between SEx repetitions.

**Implementation.** Row duration becomes `speed × (1 + arg_x)` ticks. Treat each repetition as a fresh row for tick-0 purposes (so fine slides, delayed notes, and the like re-trigger), but do not reset arpeggio, vibrato, or tremolo LFO positions, and do not decrement SBx's loop counter more than once across the whole delay block.

---

## S $Fx00 — Funk repeat with speed $x (non-destructive)

**Plain.** Produces a hiss-like progressive inversion of the sample loop, toggling individual bytes over time for a gritty textural effect. Setting `$x = 0` turns the effect off; higher `$x` advances the inversion faster.

**Compatibility.** ProTracker `EFx` is destructive — it XORs bytes directly in the sample data, permanently corrupting the sample. **Taud's implementation is non-destructive**: the XOR is applied at playback time through a per-instrument bit-mask, leaving source samples pristine. ST3 does not implement SFx at all and will parse Taud's S $Fx00 as a no-op; converters targeting ST3 should drop the effect. ProTracker `EFx` imports directly as Taud `S $Fx00`.

**Implementation.** Each instrument carries a `funk_mask` bit array, one bit per byte of the loop region, all zero at song start. A per-channel counter `funk_accumulator` and a per-channel `funk_write_pos` track progress.

```
funk_table[16] = { 0, 5, 6, 7, 8, $A, $B, $D, $10, $13, $16, $1A, $20, $2B, $40, $80 }

on every tick (when S $Fx00 is active with x != 0):
    funk_accumulator += funk_table[x]
    while funk_accumulator >= $80:
        funk_accumulator -= $80
        bit = funk_mask[funk_write_pos]
        funk_mask[funk_write_pos] = bit XOR 1
        funk_write_pos = (funk_write_pos + 1) mod loop_length

on sample byte read during loop playback:
    raw_byte = sample_data[offset_in_loop]
    if funk_mask[offset_in_loop] == 1:
        output_byte = raw_byte XOR $FF
    else:
        output_byte = raw_byte
```

`S $F000` clears `funk_accumulator` but leaves `funk_mask` intact (so the accumulated inversion pattern persists until the instrument is reset). On a fresh note or instrument-change event, Taud optionally resets `funk_mask` to all zero; this is a per-implementation choice, but the recommended default is **reset on instrument-change, preserve on pure note retrigger**.

---

# Volume column effects

The volume column of each cell can carry a secondary effect, encoded as a one-digit selector followed by a two-hex-digit value (`N.$xx`). The two defined selectors are:

- **`0.$xx` — Set volume** to `$xx` (clipped to $3F). Equivalent to a note's default volume.
- **`1.$xy` — Volume slide** by `$xy`, with `$x` as up-slide amount and `$y` as down-slide amount, using the same encoding as D. Fine slides (`1.$Fx` and `1.$xF`) fire on tick 0 only; other values fire on ticks > 0.

Volume-column effects do not consume the main effect slot; a cell can carry both (for instance, a tone portamento in the effect slot and a volume slide in the volume column).

---

# Panning column effects

The optional panning column carries its own one-digit selectors:

- **`0.$xx` — Set pan** to `$xx` ($00 left, $FF right, $80 centre). Equivalent to S $80xx but without consuming the effect slot.
- **`1.$xy` — Pan slide** by `$xy`, with `$x` as left-slide amount and `$y` as right-slide amount, using the same encoding as D. There is no fine slide, as ST3 does not have panning slides.


Additional selectors are reserved for future expansion.

---

# ProTracker to Taud conversion table

This table maps each PT effect to its Taud equivalent. Arguments follow PT's two-nibble form and expand to Taud's 16-bit form as shown.

| PT effect | Taud effect | Notes |
|---|---|---|
| `0 $xy` | `J $xxyy` | Arpeggio; nibble-repeat each byte. See the 12-TET → Taud table above for conversion losses |
| `1 $xx` | `F $0xxx × $0015` | Portamento up; ST3 slide unit = 1/16 semitone |
| `2 $xx` | `E $0xxx × $0015` | Portamento down |
| `5 $xy` | `L $xy00` | Combined portamento + volume slide |
| `6 $xy` | `K $xy00` | Combined vibrato + volume slide |
| `7 $xy` | `R $xxyy` | Tremolo; nibble-repeat |
| `8 $xx` | `S $80xx` or panning column `0.$xx` | Fine pan |
| `9 $xx` | `O $xx00` | Sample offset |
| `A $xy` | Volume column `1.$xy` | Volume slide |
| `B $xx` | `B $00xx` | Position jump |
| `C $xx` | Volume column `0.$xx` | Set volume |
| `D $xx` | `C $00xx` (after BCD decode) | Pattern break |
| `E $3x` | `S $1x00` | Glissando control |
| `E $4x` | `S $3x00` | Vibrato waveform |
| `E $5x` | `S $2x00` | Set fine-tune |
| `E $6x` | `S $Bx00` | Pattern loop |
| `E $7x` | `S $4x00` | Tremolo waveform |
| `E $8x` | `S $80xx` or panning column `0.$xx` | Coarse pan (nibble-repeat) |
| `E $9x` | `Q $0x00` | Retrigger |
| `E $Cx` | `S $Cx00` | Note cut |
| `E $Dx` | `S $Dx00` | Note delay |
| `E $Ex` | `S $Ex00` | Pattern delay |
| `E $Fx` | `S $Fx00` | Funk repeat |
| `F $xx` (xx < $20) | `A $xx00` | Set speed |
| `F $xx` (xx ≥ $20) | `T $(xx−$18)00` | Set tempo |

---

# ScreamTracker 3 conversion notes

These quirks of ST3 are worth preserving or flagging when importing S3M files into Taud:

**Shared memory across effects.** In ST3, a single memory slot backs D, E, F, I, J, K, L, Q, R, and S. A `$00` argument on any of these recalls whichever effect last wrote a non-zero argument. Taud narrows this to four cohorts (EF / G / HU / R) plus private slots. The converter must **eagerly resolve ST3 recalls** — walking the pattern in playback order, tracking the shared memory value, and emitting explicit Taud arguments wherever an ST3 recall crosses a cohort boundary. Otherwise a Taud player will either recall the wrong value or recall $0000.

**Cxx BCD encoding.** ST3 stores pattern-break row numbers as BCD on disk (`$10` means decimal 10). Taud uses binary. Decode on import; encode on export. Out-of-range BCD bytes (decimal 64 or higher) clamp to row 0.

**Tempo range.** ST3 accepts tempos $20..$FF (BPM 32..255); Taud accepts bytes $00..$FF (BPM 24..279). Imported ST3 tempos must be shifted down by $18; Taud tempos below $08 and above $E7 cannot be represented in ST3 and should clamp on export.

**SBx + SEx interaction.** ST3 miscounts loop iterations when pattern delay is active inside a pattern loop; Taud fixes this. Songs that depended on the bug for their intended playback will loop fewer times in Taud. Flag such songs on import.

**Simultaneous SEx priority.** ST3 uses pan order (L1..L8, R1..R8); Taud uses ascending channel-index order. Rare; flag on import if multiple channels carry SEx in the same row.

**Muted channels.** ST3 skips all effect processing on muted channels (no volume change, no tempo change, no jumps); Taud follows this rule for strict compatibility but recommends that new compositions avoid muting channels that carry global effects.

**Volume cap.** ST3's volume caps at $40; Taud's at $3F. Notes that reached $40 in ST3 (a rare edge) will play marginally quieter in Taud.

**Global volume scale.** ST3's 0..$40 maps to Taud's 0..$FF with a ×4 scale on import, truncated ÷4 on export.

**Linear pitch slides.** ST3's slide arithmetic is period-based (Amiga) or linear-table-indexed; Taud's is purely linear in 4096-TET units. ST3 songs in linear mode convert cleanly via the $0015-per-unit coarse and $0005-per-unit extra-fine constants; Amiga-mode slides change character slightly because the non-linearity of period math is not replicated.

**Default tempo byte.** Taud's default $65 equals 125 BPM under the $18 offset; this is not the same as ST3's `$7D` default, which maps to Taud `$65` after subtracting $18. Converters must remap on both import and export.

---

End of reference.
