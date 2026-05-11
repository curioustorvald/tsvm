# Taud Tracker Effect Command Reference

Taud is a tracker-style music format derived from ScreamTracker 3's pattern command set, extended to 16-bit effect arguments and a 4096-tone equal-temperament pitch grid. This document defines every effect command a Taud engine must implement. Each command entry has three parts: a plain explanation for composers, compatibility notes for converting patterns from ScreamTracker 3 (ST3), ImpulseTracker (IT) or ProTracker (PT), and implementation details for engine writers.

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

`note_vol` and `channel_vol` are **two independent multiplicative axes** mirroring IT's `chan->volume` and `chan->global_volume`:

- **`note_vol`** is the per-note axis. It is reset on every note re-trigger to the instrument's Default Note Volume (instrument-record byte 196). It is the target of the volume column (selectors 0 / 1 / 2 / 3), the D / K / L volume slides, and the Q retrigger volume modifier. It survives across rows until the next re-trigger.
- **`channel_vol`** is the per-channel axis. It is **not** reset by note re-triggers — once set, it persists through any number of fresh notes on that channel. It is the target of M (set) and N (slide) only.

The engine carries a third per-tick value, `row_vol`, which is the mixer-facing volume for the current tick. At every row boundary `row_vol` rebases to `note_vol`; per-tick modulators (tremolo R, tremor I) write `row_vol` only, so their effect dies cleanly at row end. Per-note slides (D, K, L, vol-col) write **both** `note_vol` and `row_vol` so the per-note baseline carries forward.

Because the two axes are independent, an `M $4000` (set channel volume to full) issued after a `0.$02` (vol-col SET = 2) leaves the per-note volume untouched at 2 — the channel keeps playing quietly. Conversely, an `N` slide can fade out a channel's overall level while a vol-col SET on a fresh trigger sets the per-note baseline at full.

## 4. Rows, ticks, patterns, cues

A pattern is a rectangular grid of rows and channels; each cell holds one note event. Playback divides each row into `speed` ticks (effect A); tempo (effect T) sets the duration of one tick. At 125 BPM and speed 6, one row takes 120 ms and one tick 20 ms. Songs play patterns in a cue sequence; effects B and C navigate this sequence.

## 5. Default parameters at song start

| Parameter | Value |
|---|---|
| Speed | $06 (6 ticks/row) |
| Tempo byte | $64 (125 BPM; see effect T for the $19 offset) |
| Global volume | $80 (mid-scale) |
| Channel volume | $3F (full) |
| Note volume | $3F (full; reseeded from instrument's Default Note Volume on every re-trigger) |
| Pan (all channels) | $80 (centre) |
| cue index | $0000 |

## 6. Effect memory groups

Most effects recall their last non-zero argument when re-issued with $0000. Unlike ST3, which shares one memory slot across most effects, Taud groups memories into four cohorts plus private slots:

- **E and F share one slot** (pitch slide down and up). Issuing E $0000 recalls the last E-or-F argument and re-applies it as a down-slide; F $0000 does the same as an up-slide.
- **G has its own slot** (tone portamento).
- **H and U share one slot** (vibrato speed and depth are jointly recalled; the last-written values persist across both commands).
- **R has its own slot** (tremolo).

Every other memory-carrying effect (D, I, J, K, L, N, O, P, Q, and others) has a private slot.

**Effects without recall (literal zero).** A few effects do *not* recall on $0000 — the argument is taken at face value. **M** (set channel volume), **V** (set global volume), and the volume- / panning-column SET selectors all behave this way: writing `M $0000` or `V $0000` is a literal "set to silence", not a memory recall. Converters lifting from source trackers that *do* share memory (notably ST3, where the `$00` argument may cohabit with D/E/F/etc.'s shared slot) MUST eagerly resolve the recall to an explicit value before emitting, since the Taud engine takes M / V arguments verbatim.

## 7. Opcode and argument format

Opcodes are single base-36 digits (0-9, then A-Z); arguments are 16-bit hexadecimal values prefixed with `$`. A cell is notated `OPCODE $HHLL` where HH is the high byte and LL is the low byte. Where an effect partitions its argument into sub-fields (for instance, H's speed and depth), the split is spelled out in the command description.

---

# The effects

## A $xx00 — Set tick speed to $xx

**Plain.** Sets how many ticks each row contains. Lower values make rows shorter and per-tick effects (slides, vibrato) develop faster; higher values stretch the row and give effects more iterations.

**Compatibility.** ST3 `Axx` maps one-to-one: Taud `A $xx00`. ST3 `A00` is a no-op; Taud `A $0000` is likewise ignored. ProTracker `Fxx` with `xx < $20` maps to Taud `A $xx00`; `Fxx` with `xx ≥ $20` maps to T instead (see T).

**Implementation.** If the high byte is non-zero, write it to `ticks_per_row`; the low byte is reserved and must be zero. The change takes effect from the row on which the A command appears. There is no memory for A.

---

## B $xxyy — Jump to cue $xxyy

**Plain.** Finishes the current row, then continues playback at row 0 of the pattern at cue position $xxyy. Use this to create song-level jumps, loops, or branching structures.

**Compatibility.** ST3 `Bxx` jumps to an 8-bit cue and maps to Taud `B $00xx`. The extended 16-bit range means Taud songs may have up to $10000 cue entries.

**Implementation.** On the last tick of the current row, set the next cue index to the argument and the next row to 0. If the argument exceeds the song length, wrap to the song's defined restart position (cue $0000 by default). Jumps are detected by a visited `(cue, row)` set so that pathological loops do not prevent song-length computation, though they do not interrupt actual playback. There is no memory for B.

**Simultaneous B and C on the same row.** If a B command appears in the same row as a C command (on any channel), both fire: B chooses the cue, C chooses the row within that cue. If the two commands appear on different channels, channel priority is **ascending channel index** — the lowest-numbered channel carrying either effect wins its parameter. If both appear on the same channel row (only possible if one is a volume-column equivalent), the effect column takes precedence.

---

## C $xxyy — Break pattern to row $xxyy

**Plain.** Finishes the current row, then skips ahead to row $xxyy of the **next** pattern in the cue sequence.

**Compatibility.** ST3 stores `Cxx` as **BCD** (so on-disk `$10` means decimal row 10); Taud stores the argument as plain binary. When converting from ST3, decode with `row = (byte >> 4) × 10 + (byte & $0F)`. Valid ST3 source bytes are those representing decimal 0..63; out-of-range BCD bytes should clamp to row 0 on import. When exporting back to ST3, encode with `byte = ((row / 10) << 4) | (row % 10)`, clamped at row 63.

**Implementation.** On the last tick of the current row, advance the cue index by 1 (or honour a co-occurring B), then set the next row to the argument. If the argument exceeds the destination pattern's row count, start the destination pattern at row 0. There is no memory for C.

---

## D $xy00 — Volume slide (multiple forms)

D's 16-bit argument encodes four mutually exclusive modes using the top nibble and the following byte. **All forms operate on `note_vol`** (the per-note axis described in §3, analog of IT `chan->volume`) and clip to $00..$3F after each step. The slid value persists into following rows until the next re-trigger; `channel_vol` is **not** touched by D — for the per-channel axis, use N.

### D $0y00 — Volume slide down by $y per non-first tick

**Plain.** Each tick after tick 0, `note_vol` decreases by $y. A D $0400 at speed 8 reduces volume by $1C over the row.

**Compatibility.** ST3 `Dx0` (volume slide down) maps to Taud `D $0x00`. The ST3 volume cap was $40; Taud's is $3F — a very high-volume sample reaching $40 in ST3 will snap to $3F in Taud.

**Implementation.** On ticks > 0, subtract the low nibble of the high byte from `note_vol`; clamp at $00; mirror `row_vol = note_vol`. Memory is private to D and is keyed on the full original byte (so D $0000 recalls whatever form last ran).

### D $x000 — Volume slide up by $x per non-first tick

**Plain.** Each tick after tick 0, `note_vol` increases by $x. Capped at $3F.

**Compatibility.** ST3 `D0y` (volume slide up) maps to Taud `D $y000`.

**Implementation.** On ticks > 0, add the high nibble of the high byte to `note_vol`; clamp at $3F; mirror `row_vol = note_vol`.

### D $Fy00 — Fine volume slide down by $y on tick 0

**Plain.** Applies a one-shot `note_vol` reduction of $y on tick 0 only. Independent of speed. A D $FF00 behaves as a fine slide up by $F (so a request for "down by F" is reinterpreted; see below).

**Compatibility.** ST3 `DFy` maps directly. The $FF edge case is preserved: ST3 treats `DFF` as fine slide up by $F rather than fine slide down by $F, and Taud follows suit.

**Implementation.** On tick 0 only, subtract the low nibble of the high byte from `note_vol`; mirror `row_vol = note_vol`. If the low nibble is $0, treat as fine-slide-up by $F. If the high byte is $FF, treat as fine-slide-up by $F.

### D $xF00 — Fine volume slide up by $x on tick 0

**Plain.** One-shot `note_vol` increase of $x on tick 0 only.

**Compatibility.** ST3 `DxF` maps directly. Volume cap is $3F, lower than ST3's $40.

**Implementation.** On tick 0 only, add the high nibble to `note_vol`; clamp at $3F; mirror `row_vol = note_vol`.

---

## E $xxxx — Pitch slide down by $xxxx

**Plain.** Lowers the channel's pitch by the argument per tick. The coarse argument has **three distinct interpretations** chosen by the song-table `ff` field (effect `1`, bits 1-2):

- **Linear mode** (`ff = 0`, default): the argument is a value in the 4096-TET pitch grid, subtracted directly from the stored pitch. `E $0155` ≈ one semitone per tick.
- **Amiga (cycle-based) mode** (`ff = 1`): the argument is a **raw ProTracker/ST3 period unit count** — the same byte the original tracker stored on disk, *unscaled*. The engine converts the channel's stored 4096-TET pitch back to an Amiga period, subtracts the argument from that period directly, then converts the result back to 4096-TET. `E $0001` therefore corresponds to PT `201` and produces the characteristic non-linear pitch drift of ProTracker-style slides (lower pitches drift more slowly in semitone terms than higher pitches).
- **Linear-frequency mode** (`ff = 2`): the argument is **Hz/tick** at A4 = 440 Hz / C4 ≈ 261.6256 Hz reference. The engine converts the stored pitch to audible frequency, subtracts the argument from that frequency, then converts the result back to 4096-TET. `E $0010` is the verbatim Monotone `210` (drop 16 Hz/tick); the slide produces a constant *frequency* delta per tick, so the perceived semitone drop is larger at low pitches and smaller at high pitches — exactly Monotone's tracker semantics.

Because Amiga period units (and Monotone Hz/tick) fit in a single byte (PT/ST3 max value $FF, MONOTONE max $3F), the coarse range never approaches the $F000 fine-slide marker, so the same argument-format selector still distinguishes coarse from fine across all three modes. **Fine slides (`E $Fxxx`) follow the same mode-selection rule as coarse**: linear mode reads the low 12 bits as 4096-TET units, Amiga mode reads them as raw tracker period units, and linear-frequency mode reads them as Hz. A coarse slide uses the full value range; a fine slide applies only once per row.

Coarse and fine modes are distinguished by the high nibble of the argument:

- `E $0001..$EFFF` — coarse slide: subtracts the full argument from pitch each tick after tick 0. A slide of $0155 drops pitch by one semitone per tick.
- `E $F000..$FFFF` — fine slide: on tick 0 only, subtracts `arg & $0FFF` from pitch.
- `E $0000` — recalls the last E-or-F argument and applies it as a down-slide, preserving the original form (coarse or fine).

**Compatibility.** ST3 pitch slides operate on Amiga periods or linear slide units; Taud's storage depends on the song-table mode flag:

- **Linear-source ST3 song** (`linear_slides` set in S3M flags → Taud `ff = 0`):
  - ST3 `Exx` coarse (where `xx < $E0`) → Taud `E round($00xx × 64/3)` (1 ST3 coarse unit = 1/16 semitone = 64/3 ≈ 21.33 Taud units, rounded).
  - ST3 `EFx` fine → Taud `E $F0 round(x × 16/3)` (1 ST3 fine unit = 1/64 semitone = 16/3 ≈ 5.33 Taud units, applied once per row).
  - ST3 `EEx` extra-fine → Taud `E $F0 round(x × 16/3)` (same unit as fine, applied once per row).

- **Amiga-source ST3/PT song** (`linear_slides` clear → Taud `ff = 1`):
  - ST3 `Exx` coarse / PT `2xx` → Taud `E $00xx` **verbatim**, with no `× 64/3` scaling. The engine reads the stored byte as Amiga period units and applies it in period space, recovering the original tracker's exact period-step count.
  - ST3 `EFx` fine / `EEx` extra-fine / PT `E2x` → Taud `E $F00x` **verbatim** (raw period-unit nibble in the low 4 bits), with no `× 16/3` scaling. The engine performs the once-per-row fine slide in Amiga period space, mirroring the coarse arithmetic.

- **MONOTONE source** (Taud `ff = 2`):
  - MONOTONE `2xx` → Taud `E $00xx` **verbatim** (Hz/tick). The engine converts the stored pitch to frequency, subtracts the argument, and converts back. MONOTONE has no fine-slide form; converters never emit `E $Fxxx` for ff=2 sources.

The mode flag therefore controls **two** decoder behaviours simultaneously: (a) which numeric scale the converter should have used when emitting coarse arguments, and (b) which arithmetic the engine performs on those arguments per tick. Converters MUST set bits 0-1 (`ff`) of the song-table flags byte to match the units they emit, and MUST NOT mix scales within one Taud song.

Because E and F share memory in Taud (narrower than ST3's broad shared memory), an ST3 song that used `E00` or `F00` to recall a D, G, or Q argument will break on import; the converter must eagerly resolve ST3 recalls into explicit Taud arguments rather than relying on memory.

**Implementation.** Per-tick processing:

```
on row start:
    raw = arg
    if raw == 0: raw = memory_EF
    else: memory_EF = raw
    if (raw & $F000) == $F000:          # fine, applied once on tick 0
        mag = raw & $0FFF
        if   tone_mode == 1:            # Amiga: mag is raw period units; pitch down ⇒ +period
            pitch = amiga_slide_down(pitch, mag)
        elif tone_mode == 2:            # linear-freq: mag is Hz/tick; pitch down ⇒ −freq
            pitch = linear_freq_slide(pitch, −mag)
        else:                            # linear: mag is 4096-TET units
            pitch -= mag
        mode_this_row = FINE
    else:                                # coarse
        slide_amount_this_row = raw
        mode_this_row = COARSE

on tick > 0:
    if mode_this_row == COARSE:
        if   tone_mode == 1:
            # slide_amount_this_row is a raw tracker period-unit count (no × 64/3 scaling).
            # period = AMIGA_BASE_PERIOD × 2^(−(pitch − C4) / 4096)
            # period_new = period + slide_amount_this_row     # E subtracts pitch ⇒ adds period
            # pitch = C4 + 4096 × log2(AMIGA_BASE_PERIOD / period_new)
            pitch = amiga_slide_down(pitch, slide_amount_this_row)
        elif tone_mode == 2:
            # slide_amount_this_row is Hz/tick (verbatim from MONOTONE 2xx).
            # freq = LINEAR_FREQ_C4_HZ × 2^((pitch − C4) / 4096)
            # freq_new = max(freq − slide_amount_this_row, 1)
            # pitch = C4 + 4096 × log2(freq_new / LINEAR_FREQ_C4_HZ)
            pitch = linear_freq_slide(pitch, −slide_amount_this_row)
        else:
            pitch -= slide_amount_this_row
```

Glissando control (S $1x) snaps the output pitch to the nearest semitone after every slide application; see S $1x.

---

## F $xxxx — Pitch slide up by $xxxx

**Plain.** Raises the channel's pitch by the argument per tick, with the same mode-selection scheme as E. Coarse, fine, memory behaviour, and Amiga / linear-freq mode handling are identical in form but inverted in direction. The same triple-interpretation rule applies to **both** coarse and fine arguments: 4096-TET units in linear mode, raw tracker period units in Amiga mode, Hz/tick in linear-frequency mode.

**Compatibility.** Same as E. In linear-source songs, ST3 `Fxx` coarse converts using `round(x × 64/3)` and `FFx`/`FEx` fine/extra-fine use `round(x × 16/3)`. In Amiga-source songs (PT or S3M with `linear_slides` clear), both forms are stored verbatim: `Fxx` coarse → `F $00xx`, and `FFx`/`FEx` fine/extra-fine / PT `E1x` → `F $F00x`. In MONOTONE-source songs (ff=2), `1xx` → `F $00xx` verbatim (Hz/tick); MONOTONE has no fine-slide form. F and E share one memory slot in Taud. Slide-mode behaviour is controlled by the same `ff` field as E; under any non-linear mode, both coarse (per-tick) and fine (tick-0 only) F slides are applied in the corresponding mode's space.

**Implementation.** As for E, but add instead of subtract. No upper pitch cap is defined by the effect itself, but the sample-rate conversion at the mixer will saturate well before arithmetic overflow at reasonable playing ranges.

---

## G $xxxx — Tone portamento with speed $xxxx

**Plain.** Slides the channel's current pitch toward the note specified in the same row, at $xxxx units per tick (after tick 0), stopping when the target is reached. A row with G and a note does **not** re-trigger the sample — the note's pitch becomes the portamento target and the already-sounding sample continues at its current pitch.

The unit of `$xxxx` depends on the song-table tone mode (effect `1`, bits 0-1):

- `ff = 0` (linear) and `ff = 1` (Amiga): 4096-TET pitch units per tick. Amiga sources should be converted to linear units on G, since the original PT G slide already operated semi-linearly within a small range and the shared-memory pitfall of E/F does not apply here.
- `ff = 2` (linear-frequency): Hz/tick. The engine walks the channel's *frequency* toward the target note's frequency by `±$xxxx` Hz each non-first tick. This is MONOTONE's `3xx` behaviour verbatim (MTSRC/MT_PLAY.PAS:620-630).

**Compatibility.** ST3 `Gxx` uses an 8-bit value in period-table units; convert to Taud using the same `round(× 64/3)` scale as E/F coarse (1/16 semitone per ST3 slide unit). ST3 linear mode is the expected import source; Amiga-mode G sources should be treated as linear. MONOTONE `3xx` → Taud `G $00xx` verbatim under ff=2. G has its **own** memory slot in both ST3 and Taud, so conversion is straightforward and does not suffer the shared-memory problem of E/F.

**Implementation.**

```
on row parse:
    if row has note and G effect:
        target_pitch = pitch_for(note)
        # do NOT re-trigger sample
    if arg != 0:
        memory_G = arg
    speed_this_row = memory_G

on tick > 0 (linear / Amiga modes):
    if target_pitch set:
        delta = sign(target_pitch - pitch) × speed_this_row
        pitch += delta
        if sign crossed target: pitch = target_pitch; target_pitch = None

on tick > 0 (linear-frequency mode):
    if target_pitch set:
        target_freq = LINEAR_FREQ_C4_HZ × 2^((target_pitch − C4) / 4096)
        cur_freq    = cached freq (or recomputed from pitch on first use)
        cur_freq   += sign(target_freq − cur_freq) × speed_this_row
        if sign crossed target_freq: cur_freq = target_freq; target_pitch = None
        pitch = C4 + 4096 × log2(cur_freq / LINEAR_FREQ_C4_HZ)
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
        play at the unmodulated row_vol (no gating)
        tick_in_phase += 1
        if tick_in_phase >= on_time: phase = OFF; tick_in_phase = 0
    else:
        row_vol = 0          # transient gate; note_vol / channel_vol are preserved
        tick_in_phase += 1
        if tick_in_phase >= off_time: phase = ON; tick_in_phase = 0
```

The OFF-phase gate writes `row_vol` only; `note_vol` and `channel_vol` are untouched, so the per-row rebase (`row_vol = note_vol` at row start) restores the audible level cleanly when tremor stops.

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

**Plain.** Continues the previously started vibrato (H or U) without retriggering it, while applying a volume slide of `$xy` per non-first tick. Fine volume slides are not available in this form. The K command is implemented sorely for tracker compatibility — new compositions should prefer an explicit `H $0000` (vibrato recall) plus a volume-column slide (`1.$xy` / `2.$xy`), which carries the same semantics with one less hidden dependency.

**Compatibility.** ST3 / IT `Kxy` map directly to Taud `K $xy00`: the source's `xy` argument byte goes verbatim into the high byte of the Taud argument. ProTracker / FT2 / XM `6xy` map identically. Source-tracker memory cohorts that share K's argument with D (notably the ST3 single-slot shared memory and IT's D/K/L vol-slide cohort) MUST be resolved eagerly by the converter — emit explicit arguments rather than relying on cohort sharing, since Taud's K has its own private slot.

**Implementation.** On row parse:

```
on row parse (K):
    raw = (arg >> 8) & 0xFF                 # the xy nibble pair lives in the high byte
    if raw == 0: raw = memory_K
    else: memory_K = raw
    voice.vibratoActive = true              # H/U speed and depth come from memory_HU
    hi_nib = (raw >> 4) & 0xF
    lo_nib = raw & 0xF
    # Slide direction: high nibble = up, low nibble = down. Both non-zero ⇒ down wins (ST3 quirk).
    if hi_nib != 0 and lo_nib == 0:
        slide_per_tick = +hi_nib
    elif lo_nib != 0:
        slide_per_tick = -lo_nib
    else:
        slide_per_tick = 0

on every tick (including tick 0):
    apply vibrato update with memory_HU.speed / memory_HU.depth (see §H)

on tick > 0:
    note_vol = clamp(note_vol + slide_per_tick, 0, $3F)
    row_vol  = note_vol
```

The slide writes the per-note axis (same as D); `channel_vol` is untouched. K has its own memory slot (private). The slide always uses the per-tick form — `K $FF00` does **not** trigger a fine slide; the argument's `$F` nibbles are interpreted as `$F`-magnitude per-tick slides (down wins), matching ST3's K and IT's K semantics.

---

## L $xy00 — Dual: tone portamento continuation and volume slide $xy

**Plain.** Continues the previously started tone portamento (G) without retriggering, while applying a volume slide of `$xy` per non-first tick. Fine volume slides are not available here. Like K, L is implemented sorely for tracker compatibility — new compositions should prefer an explicit `G $0000` plus a volume-column slide.

**Compatibility.** ST3 / IT `Lxy` map directly to Taud `L $xy00`. ProTracker / FT2 / XM `5xy` map identically. As with K, source cohort recalls (ST3 shared memory; IT D/K/L vol-slide cohort) MUST be resolved eagerly by the converter; Taud's L has its own private slot.

**Implementation.** Identical machinery to K with `G` swapped for the LFO update:

```
on row parse (L):
    raw = (arg >> 8) & 0xFF
    if raw == 0: raw = memory_L
    else: memory_L = raw
    # Tone portamento target is set by the row's note (see §G); G's stored speed (memory_G) drives the slide.
    hi_nib = (raw >> 4) & 0xF
    lo_nib = raw & 0xF
    if hi_nib != 0 and lo_nib == 0:
        slide_per_tick = +hi_nib
    elif lo_nib != 0:
        slide_per_tick = -lo_nib
    else:
        slide_per_tick = 0

on tick > 0:
    apply tone-portamento step using memory_G.speed (see §G)
    note_vol = clamp(note_vol + slide_per_tick, 0, $3F)
    row_vol  = note_vol
```

The slide writes the per-note axis (same as D); `channel_vol` is untouched. L has its own memory slot (private), separate from K's and from D's.

---

## M $xx00 — Set channel volume to $xx

**Plain.** Sets the per-channel volume axis (`channel_vol`, see §3) to `$xx`, in the same 6-bit `$00..$3F` range as a note's default volume. M is the analog of IT's `Mxx`, which writes `chan->global_volume` — it does **not** disturb the per-note volume (`note_vol`) set by the volume column or seeded from the instrument default. A vol-col SET of $02 on a note row followed by an `M $4000` on the next row therefore plays the channel at `2/63 × $3F/63 ≈ 3%` of full, *not* at full — exactly as IT would.

**Compatibility.** IT `Mxx` maps directly: the source byte is taken **verbatim** with a clamp to `$3F` (IT's $40 cap snaps down by one). ST3 has no native M; OpenMPT/Schism's S3M-with-IT-extensions does, and the same verbatim-with-clamp rule applies on import. M has **no memory** — `M $0000` is a literal "set channel volume to silence", not a recall. Source-tracker shared-memory recalls (e.g., ST3's single-slot shared memory) MUST be eagerly resolved by the converter before emit.

**Implementation.**

```
on row parse (M):
    new_vol = (arg >> 8) & 0xFF
    if new_vol > 0x3F: new_vol = 0x3F
    channel_vol = new_vol
    # note_vol and row_vol are NOT touched. The mixer multiplies channel_vol
    # into the per-voice gain via the volume-ramp target, so the change is
    # heard from this tick onwards without nuking the per-note volume.
```

The change takes effect on tick 0 of the row (the next mixer ramp window picks it up). There is no slide form; for that, use N. The low byte of M's argument is reserved.

---

## N $xy00 — Channel volume slide

**Plain.** Slides the per-channel volume axis (`channel_vol`, see §3 and §M) by `$xy` per non-first tick (or once on tick 0 for fine forms). Encoding is identical to D (see §D), but the slide acts on `channel_vol` — independent of `note_vol`, so vol-col SET / D-slide state on the per-note axis survives across an N. The change persists into following rows that don't reissue N. Range and clipping match D: `$00..$3F`.

**Compatibility.** IT `Nxy` maps directly to Taud `N $xy00` (high byte = source argument byte, verbatim). ST3 has no native N. N's encoding sub-forms mirror D exactly:

- `N $0y00` — coarse slide down by `$y` per non-first tick.
- `N $x000` — coarse slide up by `$x` per non-first tick.
- `N $Fy00` — fine slide down by `$y` on tick 0 only (with the same `$FF` "fine up by $F" quirk as D).
- `N $xF00` — fine slide up by `$x` on tick 0 only.

**Memory.** N has its own private slot, separate from D's. `N $0000` recalls the last N argument and re-applies it in its original sub-form (coarse vs fine, up vs down).

**Implementation.** Identical to D, with `channel_vol` substituted for `note_vol`. After every step the result is clamped to `$00..$3F`. `note_vol` and `row_vol` are **not** touched — the mixer multiplies `channel_vol` into the per-voice gain via the volume-ramp target, so the change is heard within the row without disturbing the per-note baseline:

```
on row parse (N):
    raw = (arg >> 8) & 0xFF
    if raw == 0: raw = memory_N
    else: memory_N = raw
    decode raw exactly as D does (FF / F0 / Fy / xF / 0y / x0 → fine-up-F / coarse / fine forms)
    schedule per-tick (or apply once) on channel_vol — never touch note_vol / row_vol
```

---

## P $xy00 — Channel panning slide

**Plain.** Slides the channel's persistent pan by `$xy` per non-first tick (or once on tick 0 for fine forms). Encoding is layered on D's structural skeleton, but the *direction* of each nibble follows the IT panning convention: the low nibble of the high byte slides **right**, the high nibble of the high byte slides **left**. Pan ranges over the full 8-bit space (`$00`..`$FF`, $80 centre); P writes the persistent `channel_pan` so the change persists across rows.

**Compatibility.** IT `Pxy` maps directly to Taud `P $xy00` (high byte = source argument byte, verbatim). ST3 has no native P. The four sub-forms are:

- `P $0y00` — slide right by `$y` per non-first tick.
- `P $x000` — slide left by `$x` per non-first tick.
- `P $Fy00` — fine slide right by `$y` on tick 0 only.
- `P $xF00` — fine slide left by `$x` on tick 0 only.

The `$FF` corner case (`P $FF00`) follows the D / N quirk: it is interpreted as "fine slide left by `$F`" (the high-nibble form wins when both nibbles are `$F`).

**Memory.** P has its own private slot, separate from D / N. `P $0000` recalls the last P argument and re-applies it in its original sub-form.

**Implementation.**

```
on row parse (P):
    raw = (arg >> 8) & 0xFF
    if raw == 0: raw = memory_P
    else: memory_P = raw
    hi_nib = (raw >> 4) & 0xF
    lo_nib = raw & 0xF
    if raw == 0xFF or (hi_nib == 0xF and lo_nib == 0): apply fine-left-by-F on tick 0
    elif hi_nib == 0xF and lo_nib != 0:                apply fine-right-by-lo_nib on tick 0
    elif lo_nib == 0xF and hi_nib != 0:                apply fine-left-by-hi_nib on tick 0
    elif hi_nib == 0 and lo_nib != 0:                  per-tick: channel_pan += lo_nib (right)
    elif lo_nib == 0 and hi_nib != 0:                  per-tick: channel_pan -= hi_nib (left)

on every per-tick or fine step:
    channel_pan = clamp(channel_pan ± step, 0, 0xFF)
    row_pan     = channel_pan >> 2     # 6-bit pan value used by the mixer
```

The mixer reads `channel_pan` (8-bit) directly through the same path as `S $80xx`. P slides interact additively with panbrello (Y) and the panning column's slide selectors, but P has the highest precedence on `channel_pan` because it writes the persistent value rather than a per-row delta.

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

**Implementation.** A per-channel tick counter advances every tick, including tick 0. When it reaches `$y`, the sample retriggers (keeping current pitch), the counter resets to 0, and the volume modifier `$x` applies to `note_vol` (the per-note axis — IT's `chan->volume`). `channel_vol` is untouched. The counter resets only when a row has **no** Q command; successive Q rows share and advance the counter.

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
    row_vol = clamp(note_vol + vol_delta, 0, $3F)        # modulate around the per-note axis
    lfo_pos = (lfo_pos + memory_R.speed × 4) & $FF
```

The LFO bias is added to `note_vol` (per-note axis, mirroring IT's tremolo on `chan->volume`) and the result lands in `row_vol`, never written back into `note_vol` itself — so the row-end rebase reseats `row_vol` cleanly and tremolo dies on the next row without leaving residue. `channel_vol` is unaffected.

Peak at maximum settings: $7F × $FF >> 9 = $3F — the full volume range. Retrigger behaviour tracks the S $4x waveform nibble bit 2: cleared means retrigger on new note, set means preserve LFO position.

---

## T $xxyy — Tempo set or tempo slide

Taud splits T by which byte carries the value:

### T $xx00 (high byte non-zero) — Set tempo

**Plain.** Sets the Taud tempo byte to `$xx`. The resulting BPM is `$xx + $19`: Taud byte $00 → 25 BPM, $64 → 125 BPM (default), $FF → 280 BPM.

**Compatibility.** ST3 `Txx` (where `xx ∈ $20..$FF`) stores BPM directly; convert with `taud_byte = xx − $18`. Taud byte $07 corresponds to ST3's minimum BPM of 32; Taud bytes below $07 are inexpressible in ST3 and should round up to $07 (BPM 32) when exporting. OpenMPT's extended tempo slides (`T $0x` down, `T $1x` up) in S3M files map to Taud T $00xx — see below.

ProTracker `Fxx` with `xx ≥ $20` maps to Taud `T $(xx − $19)00`; `Fxx` with `xx < $20` maps to A (speed) instead.

**Implementation.** If the high byte is non-zero, set `tempo_byte = arg >> 8`; derive `BPM = tempo_byte + $19`; compute tick duration as `samples_per_tick = 32000 × 5 / (BPM × 2) = 80000 / BPM` (integer truncated) at the fixed 32000 Hz output rate. Example: BPM 125 → 640 samples per tick; BPM 24 → 3200 samples per tick; BPM 280 → 286 samples per tick. There is no memory for set-tempo.

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

**Compatibility.** ST3's global volume is 0..$40; convert with `taud_v = st3_v × 4`, clamped at $FF. On export, `st3_v = taud_v >> 2`, clamped at $40. IT's global volume is 0..$80; convert with `taud_v = it_v × 2`, clamped at $FF. On IT, the very first `V 00` command must be resolved as the song's initial global volume.

**Implementation.** Write the high byte to `global_volume` on the row the command appears. The low byte is reserved. ST3's `kST3NoMutedChannels` rule applies: V on a muted channel is ignored by ST3; for strict-compatible playback Taud follows suit, but new Taud compositions should avoid muting channels that carry global effects.

---

## W $xy00 — Global volume slide

**Plain.** Similar to `D $xy00`, but applies to the global volume.

**Compatibility.** IT `Wxy` maps directly.

**Implementation.** See effect D, apply to the global volume instead.

---

## X $xx00 — Fine Set Panning

**Plain.** **Unimplemented**. On IT, sets the panning position of the current channel, $00 being full-left and $FF being full-right.

**Compatibility.** Convert to `S $80xx`.

**Implementation.** Not applicable.

---

## Y $xxyy — Panbrello (panning vibrato) with speed $xx and depth $yy

**Plain.** Modulates panning with an LFO, symmetrically with H's pitch modulation. `$xx` is LFO speed, `$yy` depth; the waveform is selected by S $5x.

**Compatibility.** IT `Yxy` uses nibbles; convert by nibble-repeat. IT's panning cap is $40; Taud's is $3F — very deep vibrato that would have briefly clipped at $40 in IT may clip slightly earlier in Taud. Y has its own memory slot.

**Implementation.** Identical machinery to H with a larger shift to fit the narrower volume range:

```
on row parse (Y):
    if (arg >> 8)  != 0: memory_Y.speed = arg >> 8
    if (arg & $FF) != 0: memory_Y.depth = arg & $FF

on every tick (including tick 0):
    sine = ModSinusTable[(lfo_pos >> 2) & $3F]
    vol_delta = (sine × memory_Y.depth) >> 9
    applied_vol = clamp(base_vol + vol_delta, 0, $3F)
    lfo_pos = (lfo_pos + memory_Y.speed × 4) & $FF
```

Peak at maximum settings: $7F × $FF >> 9 = $3F — the full panning range. Retrigger behaviour tracks the S $5x waveform nibble bit 2: cleared means retrigger on new note, set means preserve LFO position.

---

## 8 $xyzz — Bitcrusher

**Plain.** Applies a bitcrusher to the current voice. The crusher has two independent stages — a sample-rate reducer (`zz`, sample-and-hold) and a bit-depth quantiser (`y`) — and shares its clipping mode (`x`) with effect 9 (Overdrive). The two stages are orthogonal: enabling either is sufficient to engage the effect, and either can be active alone.

- **x — clipping mode** (shared with effect 9): `0` clamp (hard limit at ±1.0), `1` fold (ping-pong around ±1.0; values outside the range mirror back symmetrically), `2` wrap (saw-tooth wrap mod 2; ±1 are fixed points so no DC step at the boundary). Values 3..F are reserved and treated as clamp.
- **y — bit depth**, range $1..$F. `0` disables the quantiser stage. `1` reduces the voice to a 1-bit (sign-only) signal. `8..F` are accepted but produce no audible quantisation, since TSVM's mix bus is already 8-bit; they are reserved for future hardware revisions.
- **zz — sample skip**, range $00..$FF. `0` disables skip; non-zero N holds the post-quantiser output for N additional output samples (i.e. emit one fresh sample every N+1). The held value is the bitcrusher's *output*, so the sample-and-hold is downstream of the quantiser and the shared clipper.
- `8 $0000` disables both stages and resets the shared clipping mode to clamp.
- `8 $x000` updates only the shared clipping mode and leaves the active depth/skip undisturbed — useful for switching between clamp/fold/wrap mid-pattern without retyping the whole argument. The same form on effect 9 has identical semantics.

**Compatibility.** Unique to Taud — no ST3/IT/PT equivalent. The effect has no memory: every cell that names effect 8 must spell out its full argument (apart from the `$x000` shorthand described above). `8 $1100` ⇒ 1-bit, no skip, fold-clipped — a useful sanity check pattern.

**Implementation.** Per-voice state: `bitcrusherDepth` (0..15; 0 = quantiser off), `bitcrusherSkip` (0..255), `bitcrusherCounter` (mod skip+1), `bitcrusherHeld` (last emitted sample), and `clipMode` (0..2, shared with effect 9). On row parse:

```
on row parse (8 $xyzz):
    voice.clipMode = x & 3
    if arg == $0000:
        voice.bitcrusherDepth = 0
        voice.bitcrusherSkip = 0
        voice.bitcrusherCounter = 0
    else if y == 0 and zz == 0:
        # x000 — clip-mode-only update; preserve depth/skip/counter
        pass
    else:
        voice.bitcrusherDepth = y
        voice.bitcrusherSkip   = zz
        voice.bitcrusherCounter = 0
```

On every output sample, after `applyVoiceFilter` and *after* the overdrive stage of effect 9:

```
on output sample (per voice):
    if voice.bitcrusherCounter == 0:
        s' = sample          # post-overdrive input
        if 1 ≤ voice.bitcrusherDepth ≤ 7:
            s' = clip(s', voice.clipMode)         # ensure in-range before quantising
            levels = (1 << voice.bitcrusherDepth) - 1
            q = round((s' + 1) × 0.5 × levels)    # nearest integer; clamp to [0, levels]
            s' = (q / levels) × 2 - 1
        voice.bitcrusherHeld = s'
        out = s'
    else:
        out = voice.bitcrusherHeld
    if voice.bitcrusherSkip > 0:
        voice.bitcrusherCounter = (voice.bitcrusherCounter + 1) mod (voice.bitcrusherSkip + 1)
```

The clipper is shared between effects 8 and 9 and is implemented as a single helper:

```
clip(x, mode):
    if mode == 1:                        # fold (triangle)
        while x > +1: x = 2 - x
        while x < -1: x = -2 - x
        return x
    if mode == 2:                        # wrap (saw, period 2)
        v = ((x + 1) mod 2 + 2) mod 2
        return v - 1
    return clamp(x, -1, +1)              # mode 0 (and reserved values)
```

The voice-FX state is preserved verbatim by the NNA-ghost copier, so the post-NNA tail of a note keeps the same timbre as the foreground voice that spawned it.

---

## 9 $x0zz — Overdrive

**Plain.** Amplifies the voice's post-filter signal and routes it through the shared clipper. With `x = 0` (clamp) the effect is a hard-knee soft-clipping distortion; with `x = 1` (fold) it becomes a wave-folder; with `x = 2` (wrap) it produces aggressive aliased fuzz with sawtooth-style discontinuities at the rails. Volume is *not* re-normalised after clipping — `9 $00FF` clamp-clipped plays at roughly the same loudness as the dry voice once everything saturates. The middle nibble is reserved and must be zero.

- **x — clipping mode** (shared with effect 8): `0` clamp, `1` fold, `2` wrap (see effect 8 for the precise transfer functions). Values 3..F are reserved and treated as clamp.
- **zz — amplification index**, range $00..$FF. The applied gain is `(16 + zz) / 16`, so `$00` is 1.0× (effect inactive), `$10` is 2.0× (+6 dBFS), `$F0` is 16.0× (+24 dBFS), and `$FF` is 16.9375× (≈ +24.55 dBFS).
- `9 $0000` resets the overdrive (gain returns to unity, the stage stops processing) **and** resets the shared clipping mode to clamp.
- `9 $x000` updates only the shared clipping mode and leaves the active amplification undisturbed — symmetric with `8 $x000`.

**Compatibility.** Unique to Taud — no ST3/IT/PT equivalent. The effect has no memory.

**Implementation.** Per-voice state: `overdriveAmp` (0..255; 0 = effect off) and `clipMode` (shared with effect 8). On row parse:

```
on row parse (9 $x0zz):
    voice.clipMode = x & 3
    if arg == $0000:
        voice.overdriveAmp = 0
    else if zz == 0:
        # x000 — clip-mode-only update; preserve amp
        pass
    else:
        voice.overdriveAmp = zz
```

On every output sample, after `applyVoiceFilter` and *before* the bitcrusher stage of effect 8:

```
on output sample (per voice):
    if voice.overdriveAmp > 0:
        sample = sample × (16 + voice.overdriveAmp) / 16
        sample = clip(sample, voice.clipMode)
```

When both effects 8 and 9 are active on the same voice the chain is **filter → overdrive (×gain → clip) → bitcrusher (bit-depth quantise → sample-skip hold)**. Because the clipper is shared, changing `clipMode` from either effect propagates to the other on the next sample — there is one mode per voice, not one per stage.

---

# The S subcommand family

S is a multiplexing opcode; the **high nibble of the high byte** selects the sub-effect, and the remainder is the sub-argument.

# S $0x00 — Amiga LPF/LED Switch

**Plain.** `$0100` turns filter off; `$0000` turns it on. The parameter of the filter is somewhat dependent on the current interpolation mode: follows Amiga 1200 LPF on 1200 mode, Amiga 500 LPF on 500 mode. For other interpolation modes, this command is no-op. (see § Effects That Modifies Global Behaviour)

**Compatibility.** ST3/IT `S00`/`S01` and PT `E00`/`E01` maps directly. To actually hear the effect, the interpolation mode must be set to one of the two Amiga modes.

**Implementation.** Per-playhead boolean `ledFilterOn` (default off). Writes from row are gated on `interpolationMode ∈ {Amiga 500, Amiga 1200}`; in linear / no-interp / default modes the filter chain is bypassed entirely so the toggle is a silent no-op. The post-mix LPF chain runs on the stereo bus (left/right state per playhead) before dithering: in Amiga 500 mode a 1-pole RC LPF (R = 360 Ω, C = 0.1 µF, fc ≈ 4421 Hz) is always applied; in Amiga 1200 mode that LPF is bypassed (cutoff ~34 kHz, well above 32 kHz Nyquist — matches `pt2_paula.c`). When the LED toggle is on, an additional 2-pole Sallen-Key LPF (R1=R2=10 kΩ, C1=6800 pF, C2=3900 pF, fc ≈ 3091 Hz, Q ≈ 0.660) is run after the mode LPF. Coefficients precomputed once at SAMPLING_RATE; recurrence follows musicdsp.org #38 with `pt2_rcfilters.c` parameter mapping.


## S $1x00 — PT/ST3/IT Glissando control

**Plain.** `$1000` turns glissando off; `$1100` turns it on. When on, tone portamento (G) output is quantised to the nearest semitone ($0155 approximation) before being sent to the mixer. The internal G pitch counter still advances smoothly; only the audible pitch steps. **This command is implemented sorely for ST3/IT compatibility** and therefore only works in 12-TET context.

**Compatibility.** ST3/IT `S10`/`S11` and PT `E30`/`E31` maps directly. In Taud, "nearest semitone" uses the best integer approximation: round `pitch / $155` to the nearest integer, multiply by $155; equivalently, `snapped = (pitch + $AB) / $155 × $155`. Because $155 is an approximation of 4096/12, accumulated rounding across many octaves will drift by up to a few cents; this is documented behaviour and intentional given the microtonal grid.

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

**Compatibility.** ST3 `S3x` and ProTracker `E4x` maps directly.

**Implementation.** Store `vibrato_waveform = $x & $3` and `vibrato_retrigger = (($x & $4) == 0)` for the channel. The ramp-down shape is `$7F − ((pos & $3F) << 2)` across one logical cycle; the square shape is `sign(sine(pos)) × $7F`; random draws a fresh `rand() & $FF − $80` every tick. On a new note, if `vibrato_retrigger` is true, reset `lfo_pos = 0`.

---

## S $4x00 — Tremolo LFO waveform

**Plain.** Selects the shape of the tremolo (R) oscillator; value encoding is identical to S $3x.

**Compatibility.** ST3 `S4x` and ProTracker `E7x` maps directly.

**Implementation.** As for S $3x, but applied to R's separate state (`tremolo_waveform`, `tremolo_retrigger`, and tremolo `lfo_pos`).

---

## S $5x00 — Panbrello LFO waveform

**Plain.** Selects the shape of the panbrello (Y) oscillator; value encoding is identical to S $3x.

**Compatibility.** IT `S5x` maps directly.

**Implementation.** As for S $3x, but applied to Y's separate state (`panbrello_waveform`, `panbrello_retrigger`, and panbrello `lfo_pos`).

---

## S $6x00 — Fine pattern delay

**Plain.** Extends the current row by $x ticks. If multiple S6x commands are on the same row, the sum of their parameters is used.

**Compatibility.** IT `S6x` maps directly.

**Implementation.** Maintain a per-row accumulator `fine_delay_extra` on the tracker state, initialised to 0 at the start of every row parse (including pattern-delay repetitions caused by S $Ex). Each S $6x command encountered during the row scan adds `$x` to `fine_delay_extra`. The row then runs for `speed + fine_delay_extra` ticks instead of the usual `speed` ticks before advancing to the next row.

```
on row parse (S $6x):
    fine_delay_extra += x       # sum across all channels

row ends when:
    tick_in_row >= ticks_per_row + fine_delay_extra
```

S $6x and S $Ex are orthogonal: when S $Ex is active the current row repeats `$x` additional times, and each repetition is itself extended by `fine_delay_extra` (re-accumulated from the same row's S $6x commands). There is no memory for S $6x; `$x == 0` is a no-op.

---

## S $7x00 — Note/Instrument actions

**Plain.** Performs following action to the note.

| $x | Operation | Description |
|---|---|---|
| $0 | Past Note Cut | Cuts all notes playing as a result of New Note Actions on the current channel |
| $1 | Past Note Off | Sends a Note Off to all notes playing as a result of New Note Actions on the current channel |
| $2 | Past Note Fade | Fades out all notes playing as a result of New Note Actions on the current channel |
| $3 | NNA Note Cut | Sets the currently active note's New Note Action to Note Cut |
| $4 | NNA Note Continue | Sets the currently active note's New Note Action to Continue |
| $5 | NNA Note Off | Sets the currently active note's New Note Action to Note Off |
| $6 | NNA Note Fade | Sets the currently active note's New Note Action to Note Fade |
| $7 | Volume Envelope Off | Disables the currently active note's volume envelope |
| $8 | Volume Envelope On | Enables the currently active note's volume envelope |
| $9 | Panning Envelope Off | Disables the currently active note's panning envelope |
| $A | Panning Envelope On | Enables the currently active note's panning envelope |
| $B | Pitch Envelope Off | Disables the currently active note's pitch or filter envelope |
| $C | Pitch Envelope On | Enables the currently active note's pitch envelope  |

**Compatibility.** IT `S7x` maps directly.

**Implementation.** Engines maintain a *mixer-private* background-voice pool per playhead, separate from the addressable foreground voices. When a fresh note retriggers a still-active foreground voice, the engine reads the effective NNA — the per-voice override set by `S $73..$76` if present, otherwise the instrument's default NNA (instrument record byte 186, low two bits) — and acts on the displaced voice as follows:

- **Note Cut (1):** discard the foreground state in place; no ghost is created.
- **Note Off (0):** clone the foreground voice into the background pool and set its key-off flag, releasing any sustain loop. The clone's volume envelope plays out and fadeout decays from full.
- **Continue (2):** clone the foreground voice into the background pool unchanged; envelopes and sample position continue from where they were.
- **Note Fade (3):** clone the foreground voice into the background pool and immediately begin fadeout decay without releasing sustain. The volume envelope keeps looping its sustain region while fadeoutVolume drains to zero.

Note Fade and Note Off are distinct: Note Fade does **not** set key-off, so the volume envelope's sustain loop continues to cycle; Note Off does set key-off, breaking sustain. Both share the same fadeout slope (`volumeFadeoutLow + (fadeoutHigh & 0x0F << 8)` units per tick out of 1024).

The background pool is reaped when a ghost's `fadeoutVolume` drops to zero or its sample finishes (non-looping). Pool size is implementation-defined; the reference engine caps it at 64 ghosts per playhead and evicts the oldest on overflow. Background voices receive only passive per-tick maintenance (envelope advance, fadeout decay, auto-vibrato, filter coefficient refresh) — no row-driven effects (vibrato/tremolo/arpeggio/Q-retrigger/cut/delay) ever target them, since they are not addressable from the pattern.

`S $70..$72` (Past Note Cut/Off/Fade) operate on every ghost whose `sourceChannel` matches the issuing channel: $70 drops them outright, $71 sets key-off on each, $72 begins fadeout on each.

`S $73..$76` write the per-voice NNA override on the **currently active foreground voice** so that *its* next NNA event uses the overridden action. The override is cleared on every fresh trigger.

`S $77..$7C` toggle the volume / panning / pitch-or-filter envelope on the currently active voice. While disabled, the envelope is frozen (no advancement) and the mixer treats its contribution as unity (envVolume / envPan / envPfValue all replaced by the neutral 1.0 / 0.5 / 0.5).

---

## S $80xx — Set channel pan position

**Plain.** Sets the channel pan to `$xx`, with $00 being full left and $FF being full right. $80 is centre. When this command and panning column's Set Pan are both present, this command takes precedence.

**Compatibility.** IT `Xxx` maps directly. ST3 `S8x` uses a 4-bit value. Convert by nibble-repeat: ST3 `S83` → Taud `S $8033`. Panning column command `0.$xx` has the same semantics and is the preferred form when a pan column is available in the pattern. ProTracker `8xx` (fine pan) and `E8x` (coarse pan) both map into Taud's 8-bit pan — the ProTracker 8-bit form maps directly; the 4-bit form nibble-repeats.

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

**Compatibility.** ST3 `SDx` maps directly. ProTracker `EDx` also maps directly. `SD0` plays the note normally on tick 0. If `$x ≥ speed`, the note never plays on this row and does not carry over to the next row. Some trackers allow playback of "malformed" note delays (`$x` greater than current tick speed). Taud discards those notes. If such note events have been encountered during conversion, they must be corrected on the converter.

**Implementation.** On row parse, defer the note-trigger event (including sample selection, volume, offset, and any volume-column effect) until tick `$x`. On tick `$x`, execute the deferred trigger. When combined with pattern delay (S $Ex00), the deferred trigger re-fires at the start of each row repetition — matching ST3's `kRowDelayWithNoteDelay` behaviour. If `$x` is greater than current tick speed, the note must be discarded (see compatibility notes above)

---

## S $Ex00 — Pattern delay for $x row-repeats

**Plain.** Repeats the current row `$x` additional times (so `$x = 0` means no repeat and the row plays once; `$x = 3` means the row plays four times total). Notes do not retrigger across repetitions, but per-tick effects re-run and tick-0 events (fine slides, delayed notes) re-fire on each repetition.

**Compatibility.** ST3 `SEx` maps directly. ProTracker `EEx` also maps directly. Simultaneous SEx on multiple channels: ST3 uses the first SEx in **pan order** (L1..L8 then R1..R8); **Taud uses the first SEx in ascending channel-index order** for predictability. Converters that encounter ST3 songs relying on the pan-order rule should emit a warning.

Q retrigger counters do **not** reset between SEx repetitions.

**Implementation.** Row duration becomes `speed × (1 + arg_x)` ticks. Treat each repetition as a fresh row for tick-0 purposes (so fine slides, delayed notes, and the like re-trigger), but do not reset arpeggio, vibrato, or tremolo LFO positions, and do not decrement SBx's loop counter more than once across the whole delay block.

---

## S $Fxxx — Funk repeat with speed $xxx (non-destructive)

**Plain.** Produces a hiss-like progressive inversion of the sample loop, toggling individual bytes over time for a gritty textural effect. Setting `$x = 0` turns the effect off; higher `$x` advances the inversion faster.

**Compatibility.** ProTracker `EFx` is destructive — it XORs bytes directly in the sample data, permanently corrupting the sample. **Taud's implementation is non-destructive**: the XOR is applied at playback time through a per-instrument bit-mask, leaving source samples pristine. ST3 does not implement SFx at all and will parse Taud's S $Fx00 as a no-op; converters targeting ST3 should drop the effect. ProTracker `EFx` imports as Taud `S $Fyyy`, where `yyy = funk_table[x]`.

**Implementation.** Each instrument carries a `funk_mask` bit array, one bit per byte of the loop region, all zero at song start. A per-channel counter `funk_accumulator` and a per-channel `funk_write_pos` track progress.

```
funk_table[16] = { 0, 5, 6, 7, 8, $A, $B, $D, $10, $13, $16, $1A, $20, $2B, $40, $80 }

on every tick (when S $Fxxxx is active with x != 0):
    funk_accumulator += funk_length
    if funk_accumulator >= $80:                       # hard reset, drops residual
        funk_accumulator = 0
        funk_write_pos = (funk_write_pos + 1) mod loop_length    # pre-increment
        funk_mask[funk_write_pos] = funk_mask[funk_write_pos] XOR 1

on sample byte read during loop playback:
    raw_byte = sample_data[offset_in_loop]
    if funk_mask[offset_in_loop] == 1:
        output_byte = raw_byte XOR $FF
    else:
        output_byte = raw_byte
```

`S $F000` clears `funk_accumulator` but leaves `funk_mask` intact (the accumulated inversion pattern persists). **On every fresh note trigger**, `funk_write_pos` resets to 0 (matching PT2's `n_wavestart = n_loopstart`); `funk_accumulator` and `funk_speed` persist across notes. The `funk_mask` itself is **only cleared on cue-start reset** (i.e. song-start / stop-and-replay) — within a single playback session it accumulates as PT2's destructive in-place edits would, but a clean replay always reproduces the same audio without needing to reload the song from disk.

---

# Volume column effects

Each cell carries a 6-bit value field plus a 2-bit selector field for the volume column. **All four selectors target `note_vol`** — the per-note volume axis (§3, analog of IT's `chan->volume`). The per-channel axis (`channel_vol`) is reachable only via the M / N effects in the main effect column. The four selectors are:

- **`0.$xx` — Set note_vol** to `$xx` (6-bit, $00..$3F). Equivalent in effect to seeding the note with a different default volume; persists across rows until the next re-trigger.
- **`1.$xx` — note_vol slide up** by `$xx` per non-first tick (4-bit). Clamps at $3F. The slid value persists into following rows.
- **`2.$xx` — note_vol slide down** by `$xx` per non-first tick (4-bit). Clamps at $00. The slid value persists into following rows.
- **`3.$Sx` — Fine note_vol slide** on tick 0 only. The high bit `$S` of the value selects direction (0 = down, 1 = up); the low 4 bits `$x` ($0..$F) are the magnitude. Equivalent in scale to `D $xF00` / `D $Fy00` but with a 5-bit cap. Fires once per row regardless of speed.

Volume-column effects do not consume the main effect slot; a cell can carry both (for instance, a tone portamento in the effect slot and a volume slide in the volume column). Because the volume column writes the per-note axis, an `M $xx00` on the same or following row sets the per-channel axis independently — the two multiply at the mixer (see §3 / §M).

When the converter folds an ST3 K, L, M, or N effect into the volume column, the slide-up / slide-down nibbles map to selectors 1 / 2 (clamped to 6 bits — values above $3F clip). Note that *converted* M and N still target `note_vol` here (vol-col semantics) — to preserve the original per-channel intent, emit them in the main effect column instead.

NOTE: **`3.00` — is No-op**

---

# Panning column effects

The panning column uses the same 6-bit value + 2-bit selector layout:

- **`0.$xx` — Set pan** (6-bit, $00..$3F mapped onto the channel's 8-bit pan space; $01 = full left, $1F = centre-left, $20 = centre-right, $3F = full right). For 8-bit precision use `S $80xx` instead.
- **`1.$xx` — Pan slide right** by `$xx` per non-first tick (4-bit).
- **`2.$xx` — Pan slide left** by `$xx` per non-first tick (4-bit).
- **`3.$Sx` — Fine pan slide** on tick 0 only, same direction-bit encoding as the volume column's selector 3.

NOTE: **`3.00` — is No-op**. When Set Pan and S $80xx are both present, S-command takes precedence.

---

# Effects That Modifies Global Behaviour

Effects in this section modifies the behaviour of the mixer. Primary intention of the commands is to provide switches for legacy tracker and modern DAW behaviours.

## 1 $xx00 — Global behaviour flags

**Plain.** Sets mixer-wide behaviour flags. Available flags are:

    0b 000 rrr ff

- ff = 0: Linear tone mode. Pitch shift will behave like MIDI/ImpulseTracker/ScreamTracker linear mode. **Coarse and fine E/F arguments are stored as 4096-TET pitch units** and subtracted/added directly from the stored pitch.
- ff = 1: Amiga (cycle-based) tone mode. Pitch shift will behave like ProTracker/ScreamTracker default mode. **Coarse and fine E/F arguments are stored as raw tracker period units** (the unscaled byte/nibble from the source PT/S3M/IT file) and applied in Amiga period space. Tone portamento (G) remains linear regardless of mode.
- ff = 2: Linear-frequency tone mode (MONOTONE compat). **E, F, and G arguments are stored as Hz/tick** (a signed change in audible frequency per song tick), and the engine converts the channel's stored 4096-TET pitch back to a frequency, adds/subtracts the argument, then converts back to 4096-TET. Reference is fixed at 12-TET A4 = 440 Hz / C4 ≈ 261.6256 Hz, which matches MONOTONE's MT_PLAY.PAS `notesHz` table (A0 = 27.5 Hz, equal-temperament). Unlike Amiga mode, *all three* slide effects use the new arithmetic — Monotone's `1xx`, `2xx`, and `3xx` are all in Hz/tick (see MTSRC/MT_PLAY.PAS:606-630).

- rrr = 0: Yes interpolation. Actual interpolation algorithm is implementation-dependent, but recommended to use either Fast Sinc or Linear.
- rrr = 1: No interpolation.
- rrr = 2: Amiga 500 interpolation.
- rrr = 3: Amiga 1200 interpolation.
- rrr = 4: SNES 4-tap Gaussian
- rrr = 5: Preserve delta modulation (linear intp.)

### Volume Fadeout

Taud's volume fadeout is a single linear decay applied per song tick after key-off (or NNA Note-Fade). It is **the only retirement mechanism** for sustained voices when the volume envelope holds non-zero or has no terminating zero node — without a non-zero stored fadeout, such voices play forever.

The 12-bit stored fadeout lives at instrument-record bytes 172 (low 8 bits) and 173 (low nibble = high 4 bits; high nibble reserved). Range 0..4095. The engine maintains a per-voice `fadeoutVolume ∈ [0, 1]` initialised to 1.0 on note-on, and once per song tick while the voice is keyed off:

```
fadeoutVolume -= storedFadeout / 1024.0
clamp fadeoutVolume to [0, 1]
if fadeoutVolume == 0: voice deactivates
```

Boundary semantics:

| `storedFadeout` | Behaviour |
| --- | --- |
| `0` | No fade. Voice plays at envelope-driven volume indefinitely. |
| `1..1023` | Graduated fade — completes in `1024 / storedFadeout` ticks. |
| `1024` | Exact 1-tick cut. The canonical "kill on key-off" value. |
| `1025..4095` | Also a 1-tick cut (clamped at 0). Headroom for converter robustness. |

There is no separate "use fadeout" flag — both extremes share the same field, exactly as in the IT and XM file formats.

**Tick-rate worked example** (default 50 Hz, BPM 125, speed 6):

- `storedFadeout = 1` → fade ≈ 20.5 s
- `storedFadeout = 32` → fade ≈ 640 ms
- `storedFadeout = 1024` → ~20 ms (one tick)

**Converter unit conversion.** Source trackers each expose fadeout in their own unit; converters scale the source value into Taud's 0..4095 field.

- **IT** (`it2taud.py`): IT files store fadeout as a 16-bit field at instrument-record offset `0x14`, range 0..1024 per ITTECH (some loaders accept up to 2048). Schism's per-tick decrement is `stored / 1024` — identical to Taud's unit. **Pass-through with clamp:**
  ```python
  taud_fadeout = min(it_fadeout & 0xFFFF, 0x0FFF)
  ```
- **FT2 / XM** (`xm2taud.py`): XM files store fadeout as a 16-bit field. Spec range 0..0xFFF; MilkyTracker writes up to 32767 to encode the "cut" UI slider position (`SectionInstruments.cpp:499-500`). FT2's per-tick decrement is `stored / 32768` — to match Taud's `stored / 1024` rate, **divide source by 32 (round-to-nearest):**
  ```python
  taud_fadeout = min((xm_fadeout + 16) // 32, 0x0FFF)
  ```
  XM stored 1..15 round to Taud 0; the originals were >11 min at 50 Hz — effectively no-fade anyway. Stored 32 → Taud 1 (~20 s). Stored 32767 (Milky cut sentinel) → Taud 1024 (1-tick cut).
- **MOD / S3M / MON**: source has no instrument-level fadeout. Converter writes Taud `0`. Notes retire on sample-end or pattern note-cut.

**Implementation.**
- Panning (equal-energy):
  - L_gain = cos(πx / 512.0)
  - R_gain = sin(πx / 512.0)
- Amiga tone (both coarse and fine E/F pitch slides). The `slideArg` is a **raw tracker period-unit count** (no scaling), with sign matching linear mode (negative for E, positive for F). Coarse slides apply on every non-first tick; fine slides apply once on tick 0 — the per-step arithmetic is identical:
  - AMIGA_BASE_PERIOD = 428.0  (period at the Taud reference pitch C4 for a standard 8363 Hz instrument, NTSC clock — identical to PT "C-2" period 428)
  - period = AMIGA_BASE_PERIOD × 2^(−(noteVal − C4) / 4096)
  - period_new = period − slideArg                     (E subtracts pitch ⇒ adds period; F adds pitch ⇒ subtracts period)
  - noteVal_new = C4 + 4096 × log2(AMIGA_BASE_PERIOD / period_new)
- Linear-frequency tone (E / F / G in Hz/tick). The `slideArg` is a **signed Hz delta per tick** at the audible reference 12-TET A4 = 440 Hz / C4 ≈ 261.6256 Hz, identical to the value MONOTONE stores in its 1xx/2xx/3xx commands. Sign convention matches linear/Amiga modes (negative for E, positive for F):
  - LINEAR_FREQ_C4_HZ = 261.625565...  (12-TET, so A4 = 440 Hz exactly)
  - freq = LINEAR_FREQ_C4_HZ × 2^((noteVal − C4) / 4096)
  - freq_new = max(freq + slideArg, 1.0)
  - noteVal_new = C4 + 4096 × log2(freq_new / LINEAR_FREQ_C4_HZ)
  - For tone portamento (G), `tonePortaSpeed` is also in Hz/tick: each tick walks `freq` toward `noteValToFreq(target)` by `±tonePortaSpeed` until the target frequency is reached.
  - Like Amiga mode, the per-voice intermediate frequency is cached across ticks (no round-trip rounding) and reseeded on note trigger, S$2x finetune, fine slides, and the start of a fresh multi-tick coarse slide.

**Initialisation from the song table.** The same flags byte is stored in the song-table entry (see file format §Song Table). A Taud player should write this byte to MMIO playhead register 7 before starting playback; the mixer then applies it as the initial state on every reset, and subsequent in-pattern `1` effects may override it.

---

# ProTracker to Taud conversion table

This table maps each PT effect to its Taud equivalent. Arguments follow PT's two-nibble form and expand to Taud's 16-bit form as shown.

| PT effect | Taud effect | Notes |
|---------|---------|-------|
| `0 $xy` | `J $xxyy` | Arpeggio; nibble-repeat each byte. See the 12-TET → Taud table above for conversion losses |
| `1 $xx` | `F $00xx` (Amiga mode, `f` set) | Portamento up; raw PT period units, applied in period space |
| `2 $xx` | `E $00xx` (Amiga mode, `f` set) | Portamento down; raw PT period units, applied in period space |
| `3 $xx` | `G round($0xxx × 64/3)` | Portamento to note; G is always linear (4096-TET units) regardless of mode |
| `4 $xy` | `H $xxyy` | Vibrato; nibble-repeat each byte. |
| `5 $xy` | `L $xy00` | Combined portamento + volume slide; argument byte verbatim (PT `500` recall is resolved to the previous 5xy by the converter, then emitted as L $xy00) |
| `6 $xy` | `K $xy00` | Combined vibrato + volume slide; argument byte verbatim (PT `600` recall is resolved to the previous 6xy by the converter, then emitted as K $xy00) |
| `7 $xy` | `R $xxyy` | Tremolo; nibble-repeat |
| `8 $xx` | `S $80xx` or panning column `0.$xx` | Fine pan |
| `9 $xx` | `O $xx00` | Sample offset |
| `A $xy` | Volume column `1.$xy` | Volume slide |
| `B $xx` | `B $00xx` | Position jump |
| `C $xx` | Volume column `0.$xx` | Set volume |
| `D $xx` | `C $00xx` (after BCD decode) | Pattern break |
| `E $0x` | `S $0x00` | Set low-pass filter |
| `E $1x` | `F $F00x` (Amiga mode, `f` set) | Fine pitch slide up; raw PT period units, applied in period space at tick 0 |
| `E $2x` | `E $F00x` (Amiga mode, `f` set) | Fine pitch slide down; raw PT period units, applied in period space at tick 0 |
| `E $3x` | `S $1x00` | Glissando control |
| `E $4x` | `S $3x00` | Vibrato waveform |
| `E $5x` | `S $2x00` | Set fine-tune |
| `E $6x` | `S $Bx00` | Pattern loop |
| `E $7x` | `S $4x00` | Tremolo waveform |
| `E $8x` | `S $80xx` or panning column `0.$xx` | Coarse pan (nibble-repeat) |
| `E $9x` | `Q $0x00` | Retrigger |
| `E $Ax` | Volume column `3.$1x` | Fine volume slide up |
| `E $Bx` | Volume column `3.$0x` | Fine volume slide down |
| `E $Cx` | `S $Cx00` | Note cut |
| `E $Dx` | `S $Dx00` | Note delay |
| `E $Ex` | `S $Ex00` | Pattern delay |
| `E $Fx` | `S $Fyyy` | Funk repeat, where `yyy = funk_table[x]` |
| `F $xx` (xx < $20) | `A $xx00` | Set speed |
| `F $xx` (xx ≥ $20) | `T $(xx−$18)00` | Set tempo |

---

# ScreamTracker 3 conversion notes

These quirks of ST3 are worth preserving or flagging when importing S3M files into Taud:

**Shared memory across effects.** In ST3, a single memory slot backs D, E, F, I, J, K, L, Q, R, and S. A `$00` argument on any of these recalls whichever effect last wrote a non-zero argument. Taud narrows this to four cohorts (EF / G / HU / R) plus private slots. The converter must **eagerly resolve ST3 recalls** — walking the pattern in playback order, tracking the shared memory value, and emitting explicit Taud arguments wherever an ST3 recall crosses a cohort boundary. Otherwise a Taud player will either recall the wrong value or recall $0000.

**M / N / P (channel volume and panning).** S3M files produced by IT-aware tools embed M (set channel volume), N (channel volume slide), and P (channel panning slide) using the IT semantics described in §M / §N / §P. These are emitted verbatim into Taud (with M's argument byte clamped to $3F). N and P each have private memory; M is literal-zero. ST3 itself never wrote M / N / P, so legacy S3M files contain none.

**Cxx BCD encoding.** ST3 stores pattern-break row numbers as BCD on disk (`$10` means decimal 10). Taud uses binary. Decode on import; encode on export. Out-of-range BCD bytes (decimal 64 or higher) clamp to row 0.

**Tempo range.** ST3 accepts tempos $20..$FF (BPM 32..255); Taud accepts bytes $00..$FF (BPM 25..280). Imported ST3 tempos must be shifted down by $19; Taud tempos below $07 and above $E6 cannot be represented in ST3 and should clamp on export.

**SBx + SEx interaction.** ST3 miscounts loop iterations when pattern delay is active inside a pattern loop; Taud fixes this. Songs that depended on the bug for their intended playback will loop fewer times in Taud. Flag such songs on import.

**Simultaneous SEx priority.** ST3 uses pan order (L1..L8, R1..R8); Taud uses ascending channel-index order. Rare; flag on import if multiple channels carry SEx in the same row.

**Muted channels.** ST3 skips all effect processing on muted channels (no volume change, no tempo change, no jumps); Taud follows this rule for strict compatibility but recommends that new compositions avoid muting channels that carry global effects.

**Volume cap.** ST3's volume caps at $40; Taud's at $3F. Notes that reached $40 in ST3 (a rare edge) will play marginally quieter in Taud.

**Global volume scale.** ST3's 0..$40 maps to Taud's 0..$FF with a ×4 scale on import, truncated ÷4 on export.

**Linear pitch slides.** ST3's slide arithmetic is period-based (Amiga) or linear-table-indexed; Taud carries both interpretations and selects between them via the song-table `f` flag. Conversion rules:

- **ST3 linear mode** (`linear_slides` set in S3M flags): coarse forms (Exx/Fxx) use `round(× 64/3)` (1/16 semitone per ST3 unit); fine/extra-fine (EFx/EEx/FFx/FEx) use `round(× 16/3)` (1/64 semitone per ST3 unit). Taud `f` flag is **clear**; the engine subtracts the stored 4096-TET argument directly from the channel pitch.
- **ST3 Amiga mode** (`linear_slides` clear): both coarse (Exx/Fxx) and fine/extra-fine (EFx/EEx/FFx/FEx) are stored **verbatim** as raw ST3 period units — coarse as `E/F $00xx`, fine as `E/F $F00x` — with no scaling. Taud `f` flag is **set**; the engine applies both forms in Amiga period space at playback, exactly recovering the source's period-step count and the non-linear pitch character.
- G (tone portamento) is always converted with `round(× 64/3)` and treated as linear, regardless of mode.

**Default tempo byte.** Taud's default $64 equals 125 BPM under the $19 offset; this is not the same as ST3's `$7D` default, which maps to Taud `$64` after subtracting $19. Converters must remap on both import and export.

---

End of reference.
