# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**tsvm** is a virtual machine that mimics 8-bit era computer architecture and runs programs written in JavaScript. The project includes:
- The virtual machine core
- Reference BIOS implementation
- TVDOS (operating system)
- Videotron2K video display controller emulator
- TerranBASIC integration
- Multiple platform build system

## Documentations

Documentation for TSVM and TVDOS are available on `./doc/*.tex` as machine-readable format.

Documentatino for TSVM architecture is available on `terranmon.txt`

## Reference Materials

Third-party source-code references that inform TSVM implementations live in
`reference_materials/<topic>/`. Each topic folder has a `README.md` that
summarises the takeaway and points back into the verbatim source files.
**Consult these before reimplementing tracker / codec / DSP behaviour from
memory** — TSVM aims to match the audible behaviour of the originals.

Current topics:

- `reference_materials/tracker_filter/` — Impulse Tracker / OpenMPT / Schism
  Tracker resonant low-pass filter source. Defines the cutoff formula, the
  resonance damping curve, and the **IIR-only 2-pole topology** (NOT a
  biquad — no feedforward x[n−1] / x[n−2] terms) that `AudioAdapter.kt` uses
  for Taud playback.
- `reference_materials/ft2-clone` — Modernised clone for the original FastTracker 2
- `reference_materials/impulse-tracker` — The original source code for ImpulseTracker
- `reference_materials/MilkyTracker` — FastTracker 2 compatible tracker
- `reference_materials/schismtracker` — Open-source re-implementation of ImpulseTracker
- `reference_materials/pt2-clone` — Open-source re-implementation of ProTracker 2
- `reference_materials/doom/` — id Software's GPL source release of DOOM
  (linuxdoom-1.10). Reference for the TSVM DOOM port in
  `assets/disk0/home/doom/`; demo-sync-critical tables, fixed-point maths and
  playsim call order must be translated from this source, never from memory.
- `reference_materials/soundfont/` — SoundFont 2.04 spec (PDF + `pdftotext`
  rendering for citations) for `midi2taud.py`. The `README.md` digests SF2
  *layering* semantics (all matching preset+instrument zones sound at once —
  no "first wins"), a generator/modulator census of the three production banks
  (SGM, Timbres of Heaven, Evanescence2), the spec-vs-files layering table, and
  what implementing layering in Taud needs (no new per-layer params — Ixmp
  already carries them; only multi-fire engine semantics + a layer cap of 4–5).
  Probes: `devtests/sf2_layer_probe.py`, `devtests/sf2_gen_census.py`.
- `reference_materials/fluidsynth/` — verbatim FluidSynth source, the reference
  SoundFont 2 synthesiser. The audible ground truth for Taud's **SF2 filter
  mode**: the SF2 voice low-pass is an **RBJ biquad** (cutoff in absolute cents
  via `fluid_ct2hz`, Q from cB with FluidSynth's −3.01 dB Butterworth offset,
  `1/√Q` passband gain-norm), NOT the IT all-pole filter. The `README.md`
  digests the cutoff/Q/coefficient maths with file:line citations; ported into
  `AudioAdapter.kt` `refreshVoiceFilter`/`applyVoiceFilter` (`filterSfMode`
  branch) to fix the muffling vs. the old overdamped all-pole port. Upstream's
  own README is preserved as `README.upstream.md`.

When fetching new references, copy the relevant upstream files verbatim into
a topic folder, write a `README.md` summarising the relevant maths /
algorithms with file:line citations, and add an entry here.

## Architecture

### Core Components

- **tsvm_core/**: Core virtual machine implementation in Kotlin
  - `VM.kt`: Main virtual machine class with memory management and peripheral slots
  - `peripheral/`: Hardware peripherals (graphics adapters, disk drives, TTY, audio, etc.)
  - `vdc/`: Videotron2K video display controller
  - Various delegates for JavaScript integration via GraalVM

- **tsvm_executable/**: Main emulator application
  - `VMGUI.kt`: LibGDX-based GUI implementation
  - `TsvmEmulator.java`: Main application entry point
  - Menu systems for configuration, audio, memory management

- **TerranBASICexecutable/**: TerranBASIC interpreter application
  - `TerranBASIC.java`: Entry point for BASIC interpreter
  - `VMGUI.kt`: GUI for BASIC environment

### Key Technologies

- **Kotlin/Java**: Primary implementation language
  - `kotlinc` exists at `/home/torvald/idea-IU-261.23567.138/plugins/Kotlin/kotlinc/bin/kotlinc`
- **LibGDX**: Graphics and windowing framework
- **GraalVM**: JavaScript execution engine for running programs in the VM
- **LWJGL**: Native library bindings
- **IntelliJ IDEA**: Development environment (*.iml module files)

### Virtual Hardware

The VM emulates various peripherals through the `peripheral/` package:
- Graphics adapters with different capabilities
- Disk drives (including TevdDiskDrive for custom disk format)
- TTY terminals and character LCD displays
- Audio devices and MP2 audio environment
- Network modems and serial interfaces
- Memory management units

## Build and Development

### Building Applications

Use the build scripts in `buildapp/`:
- `build_app_linux_x86.sh` - Linux x86_64 AppImage
- `build_app_linux_arm.sh` - Linux ARM64 AppImage  
- `build_app_mac_x86.sh` - macOS Intel
- `build_app_mac_arm.sh` - macOS Apple Silicon
- `build_app_windows_x86.sh` - Windows x86

### Prerequisites

1. Download JDK 21 runtimes to `~/Documents/openjdk/*` with specific naming:
   - `jdk-21.0.1-x86` (Linux AMD64)
   - `jdk-21.0.1-arm` (Linux Aarch64) 
   - `jdk-21.0.1-windows` (Windows AMD64)
   - `jdk-21.0.1.jdk-arm` (macOS Apple Silicon)
   - `jdk-21.0.1.jdk-x86` (macOS Intel)

2. Run `jlink` commands to create custom Java runtimes in `out/runtime-*` directories

### Development Commands

- **Build JAR**: Use IntelliJ IDEA build system to compile modules
- **Run Emulator**: Execute `TsvmEmulator.java` main method or use built JAR
- **Run TerranBASIC**: Execute `TerranBASIC.java` main method
- **Package Apps**: Run appropriate build script from `buildapp/` directory

### Assets and File System

- `assets/disk0/`: Virtual disk content including TVDOS system files
- `assets/bios/`: BIOS ROM files and implementations
- `My_BASIC_Programs/`: Example BASIC programs for testing
- TVDOS filesystem uses custom format with specialised drivers

### TSVM JavaScript Source Encoding

**Do not normalise `\uXXXX` or `\xXX` escapes in .js / .mjs files that run inside
TSVM.** TSVM's character set is not Unicode, and the JS string literal parser
behaves differently for raw bytes vs. escape sequences. Both forms appear in
existing code intentionally — leave each one as-is. When writing new content,
prefer raw UTF-8 characters in string literals (e.g. write the character `ù`
directly, rather than a `\uXXXX`-style escape) unless you are matching a
pattern already established in the surrounding code.

## Videotron2K

The Videotron2K is a specialised video display controller with:
- Assembly-like programming language
- 6 general registers (r1-r6) and special registers (tmr, frm, px, py, c1-c6)
- Scene-based programming model
- Drawing commands (plot, fillin, goto, fillscr)
- Conditional execution with postfixes (zr, nz, gt, ls, ge, le)

Programs are structured with SCENE blocks and executed with perform commands.

## Memory Management

- VM supports up to USER_SPACE_SIZE memory
- 64-byte malloc units with reserved blocks
- Peripheral slots (1-8 configurable)
- Memory-mapped I/O for peripheral access
- JavaScript programs run in sandboxed GraalVM context

### Peripheral Memory Addressing

Peripheral memories can be accessed using `vm.peek()` and `vm.poke()` functions, which takes absolute address.

- Peripherals take up negative number of the memory space, and their addressing is in backwards (e.g. Slot 1 starts at -1048577 and ends at -2097152)
- Peripherals take up two memory regions: MMIO area and Memory Space area; MMIO is accessed by PeriBase (and its children) using `mmio_read()` and `mmio_write()`, and the Memory Space is accessed using `peek()` and `poke()`.
  - Peripheral at slot *n* takes following addresses
    1. MMIO area (-131072×n)-1 to -131072×(n+1)
    2. Memory Space area -(1048576×n)-1 to (-1048576×(n+1))

## Testing

- Use example programs in `My_BASIC_Programs/` for BASIC testing
- JavaScript test programs available in `assets/disk0/`
- Videotron2K assembly examples in documentation

## Notes

- The 'gzip' namespace in TSVM's JS programs is a misnomer: the actual 'gzip' functions (defined in CompressorDelegate.kt) call Zstd functions.

## Taud Tracker Engine

The Taud playback engine lives in `tsvm_core/src/net/torvald/tsvm/peripheral/AudioAdapter.kt`.

### Critical Implementation Notes

**Re-bind the local `inst` after any mid-tick `triggerNote`.** `applyTrackerTick` binds `var inst = instruments[voice.instrumentId]` once at the top of the per-voice loop. When the note-delay (`S$Dx`) deferred trigger fires mid-tick, `triggerNote` swaps the voice's `instrumentId` — but the rest of that tick (playback-rate recompute at the `computePlaybackRate(inst, finalPitch)` line, `advanceEnvelope`, `advancePitchEnvelope`/`advanceFilterEnvelope`, `advanceAutoVibrato`, and the fadeout / filter-env reads of `inst.*`) keeps using the captured binding. The damage on a **never-triggered voice** (`instrumentId == 0` → stale `inst = instruments[0]`, whose `samplingRate == 0`) is that `playbackRate` is overwritten with `0.0`, freezing the sample at its start for the trigger tick — perceived as "the first delayed note on a fresh channel doesn't fire" (canonical: WHEN.taud cue 0 voice 13 pattern 0x0A row 16, inst `0x11` SD2 on a fresh play). On a warm voice the stale `inst` is a real instrument with non-zero rate, so the note sounds (at the wrong rate for one tick — a sub-perceptual glitch). Re-bind `inst = instruments[voice.instrumentId]` immediately after the note-delay fire block. Any future in-tick trigger paths (currently only S$Dx) must do the same.

**Per-patch envelopes go through the Voice's ACTIVE-envelope view, never `inst.*` directly.** Since 2026-06-13 an Ixmp patch can carry its own volume / pan / filter / pitch envelopes (+ fadeout / cutoff / resonance) — see terranmon.txt §Ixmp, variable-length patches. `applyActiveSample` → `resolveActiveEnvelopes(voice, inst, patch)` snapshots the effective envelope source onto `voice.active{Vol,Pan,Pitch,Filter}Env{,Loop,Sustain}`, `voice.has{Pitch,Filter}Env`, and `voice.active{FadeoutStep,DefaultCutoff,DefaultResonance}`. The base instrument exposes **two** pf-envelope slots — bytes 19.. (`pfEnv*`) and bytes 197..250 (`pf2Env*`, the mandatory complement) — routed into the pitch/filter roles by each slot's m-bit (LOOP-word bit 7). `advanceEnvelope` (vol+pan), `advancePitchEnvelope`, `advanceFilterEnvelope`, `applyKeyLift`, the per-tick pitch/filter/fadeout application (foreground AND background), and `triggerNote`'s envelope seeds must ALL read the `voice.active*` view, not `inst.*`. `copyVoice` (NNA ghost) must copy the whole active view so ghosts keep their patch's envelopes. There is no single `envPf*`/`envPfIsFilter` field any more — it was split into explicit `envPitch*`/`envFilter*` pairs. Headless coverage: `devtests/ixmp/PatchEnvTest` (per-patch env applied) + `IxmpFileTest /tmp/m_e1m1.taud`.

**The shared pitch/filter envelope walker (`advancePfRole`) must SKIP zero-duration nodes, not freeze on them.** A node whose `offset` rounds to 0 — sub-4 ms, since `ThreeFiveMinifloat`'s smallest non-zero step is ≈3.9 ms — represents an instant transition; the walk must advance to the next node. The old code `return`ed on `offset == 0.0` without advancing the index, stranding fast-attack envelopes at their first node. The audible damage: SF2 filter mod-envelopes (`midi2taud.py` `_filter_env_block_sf`) routinely have a ~1 ms attack that stores offset 0, so the filter never opened from its base cutoff to its sustain cutoff — Strings/Flute/Guitar (SGM base ~600 Hz, sustain ~6 kHz) and low-base sweep drums played permanently muffled at their floor. The skip loop stops at a sustain/loop boundary (`susEnd`, handled by the dispatch above) or `maxIdx`. This also affects pitch mod-envs and any IT/XM envelope with a zero-tick (vertical-jump) node, all now correct.

**The note-on / Q-retrigger SEED must also settle past leading zero-duration nodes (`seedPfRole`), not capture node 0.** The trigger code used to seed `envFilterValue`/`envPitchValue` at `activeFilterEnv[0]` and only let `advancePfRole` skip the zero node on the NEXT tick — a one-tick hold at the base node. Inaudible on a sustained note (the old "≈seed delay" caveat), but on a PERCUSSIVE instrument that one tick is the whole attack transient: GeneralUser-GS Slap Bass (PASSPORT.MID) has a 1 ms (offset-0) filter-mod attack opening base→peak then a 0.7 s decay to a mellow sustain — the slap should be BRIGHT then mellow, but the seed played the muddy base cutoff (~507 Hz) for tick 0 then "suddenly opened" to full brightness. `seedPfRole` runs the walker with `tickSec = 0` / `keyOff = false` at note-on (and on Q-retrigger) so the seed lands on the post-attack value (index settled past the dur-0 nodes); an env with a real (non-zero) attack is unchanged. The sample start-offset is a red herring (it was 0) — a quiet sample lead-in would only MASK the muddy tick, which is why it surfaced on slap bass. The vol/pan walker (`advanceEnvelope`) intentionally FREEZES on zero-offset nodes (IT terminator semantics) and is NOT seeded this way.

**SoundFont filter mode uses an RBJ biquad, NOT the IT all-pole filter.** `refreshVoiceFilter` has two topologies. The IT/tracker path (`else` branch) is the all-pole 2-pole resonant LPF from `reference_materials/tracker_filter/` (no feedforward zeros) — must stay byte-faithful for tracker playback, do not touch it. The **`filterSfMode` branch ports FluidSynth's voice filter** (`reference_materials/fluidsynth/`, see its `README.md`): cutoff = absolute cents → Hz via `8.176·2^(cents/1200)` clamped to `[5 Hz, 0.45·fs]`; Q from centibels with FluidSynth's **−3.01 dB offset** (so Q=0 cB ⇒ q_lin = 1/√2 Butterworth, no resonance hump); RBJ cookbook low-pass coefficients with the SF2 `1/√Q` passband gain-norm. `applyVoiceFilter` runs the biquad (Direct Form I: `y = b02·(x+x₂) + b1·x₁ − a1·y₁ − a2·y₂`) when `voice.filterIsBiquad`. The old code reused the all-pole filter for SF mode too; it is overdamped and rolled the passband off ~3 dB @ 8 kHz / ~5 dB @ 12 kHz vs FluidSynth → audible muffling on every filtered GM instrument. Per-voice biquad state (`filterBqB02/B1/A1/A2`, input history `filterX1/X2`) must be reset on trigger/retrigger and copied in `copyVoice` (NNA ghost) alongside the output history. The background-voice filter-env path must branch on `filterSfMode` too, else an SF-mode ghost's cents-domain cutoff gets clamped into the IT 0..254 byte range (≈9 Hz → silence).

### System Soundfont Location
Look for `/media/torvald/Warehouse/*.sf2` and `/media/torvald/Warehouse/*.SF2`

## TVDOS

### TVDOS Movie Formats

#### Legacy iPF Format
- Format documentation on `terranmon.txt` (search for "TSVM MOV file format" and "TSVM Interchangeable Picture Format (aka iPF Type 1/2)")
- Video Encoder implementation on `assets/disk0/tvdos/bin/encodemov.js` (iPF Format 1 and 2) and `assets/disk0/tvdos/bin/encodemov2.js` (iPF Format 1-delta)
  - Actual encoding/decoding code is in `GraphicsJSR223Delegate.kt`
- Audio uses standard MP2

#### TEV Format (TSVM Enhanced Video)
- **Modern video codec** optimized for TSVM hardware with 60-80% better compression than iPF
- **C Encoder**: `video_encoder/encoder_tev.c` - Hardware-accelerated encoder with motion compensation and DCT
  - How to build: `make clean && make`
  - **Rate Control**: Supports both quality mode (`-q 0-4`) and bitrate mode (`-b N` kbps)
- **JS Decoder**: `assets/disk0/tvdos/bin/playtev.js` - Native decoder for TEV format playback
  - How to build: `must be done manually by the user; the TSVM is not machine-interactable`
- **Hardware accelerated decoding**: Extended GraphicsJSR223Delegate.kt with TEV functions:
  - `tevDecode()` - The main decoding function (now accepts rate control factor)
  - `tevIdct8x8()` - Fast 8×8 DCT transforms
  - `tevMotionCopy8x8()` - Sub-pixel motion compensation
- **Features**:
  - 16×16 DCT blocks (vs 4×4 in iPF) for better compression
  - Motion compensation with ±8 pixel search range
  - YCoCg-R 4:2:0 Chroma subsampling (more aggressive quantisation on Cg channel)
  - Full 8-Bit RGB colour for increased visual fidelity, rendered down to TSVM-compliant 4-Bit RGB with dithering upon playback
- **Usage Examples**:
  ```bash
  # Quality mode
  ./encoder_tev -i input.mp4 -o output.tev -q 3

  # Playback
  playtev output.tev
  ```
- **Format documentation**: `terranmon.txt` (search for "TSVM Enhanced Video (TEV) Format")
- **Version**: 2.1 (includes rate control factor in all video packets)

#### TAV Format (TSVM Advanced Video)
- **Successor to TEV**: DWT-based video codec using wavelet transforms instead of DCT
- **C Encoder**: `video_encoder/encoder_tav.c` - Multi-wavelet encoder with perceptual quantisation
  - How to build: `make tav`
  - **Wavelet Support**: Multiple wavelet types for different compression characteristics
- **JS Decoder**: `assets/disk0/tvdos/bin/playtav.js` - Native decoder for TAV format playback
- **Hardware accelerated decoding**: Extended GraphicsJSR223Delegate.kt with TAV functions
- **Packet analyser**: `video_encoder/tav_inspector.c` - Debugging tool that parses TAV packets into human-readable form
- **Features**:
  - **Multiple Wavelet Types**: 5/3 reversible, 9/7 irreversible, CDF 13/7, DD-4, Haar
  - **Single-tile encoding**: One large DWT tile for optimal quality (no blocking artifacts)
  - **Perceptual quantisation**: HVS-optimized coefficient scaling
  - **YCoCg-R colour space**: Efficient chroma representation with "simulated" subsampling using anisotropic quantisation (search for "ANISOTROPY_MULT_CHROMA" on the encoder)
  - **6-level DWT decomposition**: Deep frequency analysis for better compression (deeper levels possible but 6 is the maximum for the default TSVM size)
  - **Significance Map Compression**: Improved coefficient storage format exploiting sparsity for 16-18% additional compression (2025-09-29 update)
  - **Concatenated Maps Layout**: Cross-channel compression optimisation for additional 1.6% improvement (2025-09-29 enhanced)
- **Usage Examples**:
  ```bash
  # Different wavelets
  ./encoder_tav -i input.mp4 -w 0 -o output.tav    # 5/3 reversible (lossless capable)
  ./encoder_tav -i input.mp4 -w 1 -o output.tav    # 9/7 irreversible (default, best compression)
  ./encoder_tav -i input.mp4 -w 2 -o output.tav    # CDF 13/7 (experimental)
  ./encoder_tav -i input.mp4 -w 16 -o output.tav   # DD-4 (four-point interpolating)
  ./encoder_tav -i input.mp4 -w 255 -o output.tav  # Haar (demonstration)

  # Quality levels (0-5)
  ./encoder_tav -i input.mp4 -q 0 -o output.tav         # Lowest quality, smallest file
  ./encoder_tav -i input.mp4 -q 5 -o output.tav         # Highest quality, largest file

  # Temporal 3D DWT (GOP-based encoding)
  ./encoder_tav -i input.mp4 --temporal-dwt -o output.tav

  # Playback
  playtav output.tav
  ```

**CRITICAL IMPLEMENTATION NOTES**:

**Wavelet Coefficient Layout**:
- TAV uses **2D Spatial Layout** in memory: `[LL, LH, HL, HH, LH, HL, HH, ...]` for each decomposition level
- **Forward transform must output**: `temp[0...half-1] = low-pass`, `temp[half...length-1] = high-pass`
- **Inverse transform must expect**: Same 2D spatial layout and exactly reverse forward operations
- **Common mistake**: Assuming linear layout leads to grid/checkerboard artifacts

**Wavelet Implementation Pattern**:
- All wavelets must follow the **exact same structure** as the working 5/3 implementation:
  ```c
  // Forward: 1. Predict step, 2. Update step
  temp[half + i] = data[odd_index] - prediction;  // High-pass
  temp[i] = data[even_index] + update;            // Low-pass

  // Inverse: Reverse order - 1. Undo update, 2. Undo predict
  temp[i] -= update;                              // Undo low-pass update
  temp[half + i] += prediction;                   // Undo high-pass predict
  ```
- **Boundary handling**: Use symmetric extension for filter taps beyond array bounds
- **Reconstruction**: Interleave even/odd samples: `data[2*i] = low[i], data[2*i+1] = high[i]`

**Debugging Grid Artifacts**:
- **Symptom**: Checkerboard or grid patterns in decoded video
- **Cause**: Mismatch between encoder/decoder coefficient layout or lifting step operations
- **Solution**: Ensure forward and inverse transforms use identical coefficient indexing and reverse operations exactly

**Supported Wavelets**:
- **0**: 5/3 reversible (lossless when unquantised, JPEG 2000 standard)
- **1**: 9/7 irreversible (best compression, CDF 9/7 variant, default choice)
- **2**: CDF 13/7 (experimental, simplified implementation)
- **16**: DD-4 (four-point interpolating Deslauriers-Dubuc, for still images)
- **255**: Haar (demonstration only, simplest possible wavelet)

- **Format documentation**: `terranmon.txt` (search for "TSVM Advanced Video (TAV) Format")
- **Version**: Current (perceptual quantisation, multi-wavelet support, EZBC compression)

#### TAV Temporal 3D DWT (GOP Unified Encoding)

Implemented on 2025-10-15 for improved temporal compression through group-of-pictures (GOP) encoding:

**Key Features**:
- **3D DWT**: Applies DWT in both spatial (2D) and temporal (1D) dimensions for optimal spacetime compression
- **Unified GOP Preprocessing**: Single EZBC tree for all frames and channels in a GOP (width×height×N_frames×3_channels)
- **GOP Size**: Typically 8 frames (configurable), with scene change detection for adaptive GOPs
- **Single-frame Fallback**: GOP size of 1 automatically uses traditional I-frame encoding

**Packet Format**:
- **0x12 (GOP_UNIFIED)**: `[gop_size][compressed_size][compressed_data]`
- **0xFC (GOP_SYNC)**: `[frame_count]` - Indicates N frames were decoded from GOP block
- **Timecode Emission**: One timecode packet per GOP (not per frame)

**Technical Implementation**:
```c
// Unified preprocessing structure (encoder_tav.c:2371-2509)
[All_Y_maps][All_Co_maps][All_Cg_maps][All_Y_values][All_Co_values][All_Cg_values]
// Where maps are grouped by channel across all GOP frames for optimal Zstd compression
```

**Usage**:
```bash
# Enable temporal 3D DWT
./encoder_tav -i input.mp4 --temporal-dwt -o output.tav

# Inspect GOP structure
./tav_inspector output.tav -v
```

**Compression Benefits**:
- **Temporal Coherence**: Exploits similarity across consecutive frames
- **Unified Compression**: Zstd compresses entire GOP as single block, finding patterns across time
- **Adaptive GOPs**: Scene change detection ensures optimal GOP boundaries

#### TAD Format (TSVM Advanced Audio)
- **Perceptual audio codec** for TSVM using CDF 9/7 biorthogonal wavelets
- **C Encoder**: `video_encoder/encoder_tad.c` - Core Encoder library; `video_encoder/encoder_tad_standalone.c` - Standalone encoder with FFmpeg integration
  - How to build: `make tad`
  - **Quality Levels**: 0-5 (0=lowest quality/smallest, 5=highest quality/largest; designed to be in sync with TAV encoder)
- **C Decoders**:
  - `video_encoder/decoder_tad.c` - Shared decoder library with `tad32_decode_chunk()` function
  - `video_encoder/decoder_tad.h` - Exports shared decoder API
  - `video_encoder/decoder_tav.c` - TAV decoder that uses shared TAD decoder for audio packets
  - **Shared Architecture** (Fixed 2025-11-10): Both standalone TAD and TAV decoders now use the same `tad32_decode_chunk()` implementation, eliminating code duplication and ensuring identical output
- **Kotlin Decoder**: `AudioAdapter.kt` - Hardware-accelerated TAD decoder for TSVM runtime
  - **Quantisation Fix** (2025-11-10): Fixed BASE_QUANTISER_WEIGHTS to use channel-specific 2D array (Mid/Side) instead of single 1D array, resolving severe audio distortion
- **Features**:
  - **32 KHz stereo**: TSVM audio hardware native format
  - **Variable chunk sizes**: Any size ≥1024 samples, including non-power-of-2 (e.g., 32016 for TAV 1-second GOPs)
  - **Pre-emphasis filter**: First-order IIR filter (α=0.5) shifts quantisation noise to lower frequencies
  - **Gamma compression**: Dynamic range compression (γ=0.5) before quantisation
  - **M/S stereo decorrelation**: Exploits stereo correlation for better compression
  - **9-level CDF 9/7 DWT**: Fixed 9 decomposition levels for all chunk sizes
  - **Perceptual quantisation**: Channel-specific (Mid/Side) frequency-dependent weights with lambda companding (λ=6.0)
  - **EZBC encoding**: Binary tree embedded zero block coding exploits coefficient sparsity (86.9% Mid, 97.8% Side)
  - **Zstd compression**: Level 7 on concatenated EZBC bitstreams for additional compression
  - **Non-power-of-2 support**: Fixed 2025-10-30 to handle arbitrary chunk sizes correctly
- **Usage Examples**:
  ```bash
  # Encode with default quality (Q3)
  encoder_tad -i input.mp4 -o output.tad

  # Encode with highest quality
  encoder_tad -i input.mp4 -o output.tad -q 5

  # Encode without Zstd compression
  encoder_tad -i input.mp4 -o output.tad --no-zstd

  # Verbose output with statistics
  encoder_tad -i input.mp4 -o output.tad -v

  # Decode back to PCM16
  decoder_tad -i input.tad -o output.pcm
  ```
- **Format documentation**: `terranmon.txt` (search for "TSVM Advanced Audio (TAD) Format")
- **Version**: 1.1 (EZBC encoding with non-power-of-2 support, updated 2025-10-30; decoder architecture and Kotlin quantisation weights fixed 2025-11-10; documentation updated 2025-11-10 to reflect pre-emphasis and EZBC)

**TAD Encoding Pipeline**:
1. **Pre-emphasis filter** (α=0.5) - Shifts quantisation noise toward lower frequencies
2. **Gamma compression** (γ=0.5) - Dynamic range compression
3. **M/S decorrelation** - Transforms L/R to Mid/Side
4. **9-level CDF 9/7 DWT** - Wavelet decomposition (fixed 9 levels)
5. **Perceptual quantisation** - Lambda companding (λ=6.0) with channel-specific weights
6. **EZBC encoding** - Binary tree embedded zero block coding per channel
7. **Zstd compression** (level 7) - Additional compression on concatenated EZBC bitstreams

**TAD Compression Performance**:
- **Target Compression**: 2:1 against PCMu8 baseline (4:1 against PCM16LE input)
- **Achieved Compression**: 2.51:1 against PCMu8 at quality level 3
- **Audio Quality**: Preserves full 0-16 KHz bandwidth
- **Coefficient Sparsity**: 86.9% zeros in Mid channel, 97.8% in Side channel (typical)
- **EZBC Benefits**: Exploits sparsity, progressive refinement, spatial clustering

**TAD Integration with TAV**:
TAD is designed as an includable API for TAV video encoder integration. The variable chunk size
support enables synchronized audio/video encoding where audio chunks can match video GOP boundaries.
TAV embeds TAD-compressed audio using packet type 0x24 with Zstd compression.

**TAD Hardware Acceleration**:
TSVM accelerates TAD decoding with AudioAdapter.kt (backend) and AudioJSR223Delegate.kt (API):
- Backend decoder in AudioAdapter.kt with non-power-of-2 chunk size support (fixed 2025-10-30)
- API functions in AudioJSR223Delegate.kt for JavaScript access
- Supports chunk sizes from 1024 to 32768+ samples (any size ≥1024)
- Fixed 9-level CDF 9/7 inverse DWT with correct length tracking for non-power-of-2 sizes

**Critical Implementation Note (Fixed 2025-10-30)**:
Multi-level inverse DWT must pre-calculate the exact sequence of lengths from forward transform:
```kotlin
val lengths = IntArray(levels + 1)
lengths[0] = chunk_size
for (i in 1..levels) {
    lengths[i] = (lengths[i - 1] + 1) / 2
}
// Apply inverse DWT using lengths[level] for each level
```
Using simple doubling (`length *= 2`) is incorrect for non-power-of-2 sizes and causes
mirrored subband artifacts.

**TAD Decoding Pipeline**:
1. **Zstd decompression** - Decompress concatenated EZBC bitstreams
2. **EZBC decoding** - Binary tree decoder reconstructs quantised int8 coefficients per channel
3. **Lambda decompanding** - Inverse Laplacian CDF mapping with channel-specific weights
4. **9-level inverse CDF 9/7 DWT** - Wavelet reconstruction with proper non-power-of-2 length tracking
5. **M/S to L/R conversion** - Transform Mid/Side back to Left/Right
6. **Gamma expansion** (γ⁻¹=2.0) - Restore dynamic range
7. **De-emphasis filter** (α=0.5) - Reverse pre-emphasis, remove frequency shaping
8. **PCM32f to PCM8** - Noise-shaped dithering for final 8-bit output

**Critical Quantisation Weights Note (Fixed 2025-11-10)**:
The TAD decoder MUST use channel-specific quantisation weights for Mid (channel 0) and Side (channel 1) channels. The Kotlin decoder (AudioAdapter.kt) originally used a single 1D weight array, which caused severe audio distortion. The correct implementation uses a 2D array:

```kotlin
// CORRECT (Fixed 2025-11-10)
private val BASE_QUANTISER_WEIGHTS = arrayOf(
    floatArrayOf( // Mid channel (0)
        4.0f, 2.0f, 1.8f, 1.6f, 1.4f, 1.2f, 1.0f, 1.0f, 1.3f, 2.0f
    ),
    floatArrayOf( // Side channel (1)
        6.0f, 5.0f, 2.6f, 2.4f, 1.8f, 1.3f, 1.0f, 1.0f, 1.6f, 3.2f
    )
)

// During dequantisation:
val weight = BASE_QUANTISER_WEIGHTS[channel][sideband] * quantiserScale
coeffs[i] = normalisedVal * TAD32_COEFF_SCALARS[sideband] * weight
```

The different weights for Mid and Side channels reflect the perceptual importance of different frequency bands in each channel. Using incorrect weights causes:
- DC frequency underamplification (using 1.0 instead of 4.0/6.0)
- Incorrect stereo imaging and extreme side channel distortion
- Severe frequency response errors that manifest as "clipping-like" distortion

## Virtual Consoles (vtmgr)

Linux-style virtual consoles for TVDOS: up to 6 independent shell sessions,
switched with **Alt-1..Alt-6** or the **`chvt N`** builtin, **Alt-0** to exit.
Implemented entirely in JS — **no tsvm_core changes**.

### Architecture

- **Dispatcher**: `assets/disk0/tvdos/VTMGR.SYS`. Launched directly by the
  `TVDOS.SYS` boot block (only when `!_TVDOS_IS_VT_PANE`); when it exits (Alt-0)
  the boot block runs `AUTOEXEC.BAT` as the bare fallback shell. Owns the
  physical keyboard and screen. Each VT runs in its own GraalVM context/thread
  via the existing `parallel.spawnNewContext` / `attachProgram` / `launch` API
  (see `VMJSR223Delegate.kt` `class Parallel`). VT 1 spawns at boot; VT 2-6 are
  lazy-spawned on first switch and re-spawned if their shell exits.
- **Concurrency model**: truly concurrent — switching works mid-command, not
  just at the prompt. Background panes keep running (no `Thread.suspend`; it is
  unusable on JDK 21). A cooperative gate inside the shimmed `con.getch` parks
  panes blocked on input; CPU-bound background panes are allowed to run.
- **Shared memory**: one `sys.malloc` region holds a control block (active VT,
  switch request, debounce, spawned-bits) plus, per VT, an input ring buffer and
  a 7682-byte text-plane buffer mirroring the GPU text-area layout
  (cursor 2 + fore 2560 + back 2560 + char 2560).
- **Compositor** (30 Hz): blits the active VT's text plane to the physical GPU
  text area via `sys.memcpy`, and pushes that VT's cursor-visibility into the GPU
  blink bit (MMIO attribute byte 6, addressed at `-1 - (131072*gpuSlot + 6)`).
- **Boot config split (`commandrc` + `AUTOEXEC.BAT`)**: environment setup and
  app-launch are split into two files so panes can replay one without the other.
  `\commandrc` holds the `set` commands (PATH/INCLPATH/HELPPATH/KEYBOARD) and is
  run by the `TVDOS.SYS` boot block in **every** context (boot and pane) — it has
  no `.BAT` extension, so the boot block runs it line-by-line (`set` mutates the
  shared `_TVDOS.variables`, so the effect persists). `\AUTOEXEC.BAT` is the
  **per-console launch** script (Korean IME `tvdos/i18n/korean`, then
  `command -fancy`); it is run once per console — by each pane's bootstrap, and
  by the boot block as the post-vtmgr fallback. No env snapshot/replay anymore;
  each pane gets PATH/KEYBOARD/etc. natively from `commandrc`, and Korean IME
  (a per-context `unicode.uniprint` handler) now registers in every pane.
- **Per-pane bootstrap**: each pane re-evals `TVDOS.SYS` (with `_TVDOS_IS_VT_PANE`
  set — which makes the boot block run `commandrc` but skip the vtmgr/AUTOEXEC
  launch — and a `_BIOS` stub captured live from the main context) then runs
  `command -c \AUTOEXEC.BAT`, all in ONE direct `eval` so the launcher shares
  scope with `_TVDOS`/`files`/`execApp`.

### Output/input shimming (in the pane bootstrap)

`con` and the global `print`/`println` family are plain JS, so the bootstrap
overrides them to read/write the per-VT shared-memory buffers instead of the
physical GPU. **`sys` and `graphics` are host objects and CANNOT be overridden
from JS** — this is the key constraint that shapes everything below.

- The shimmed `print` is a faithful JS port of the GPU's TTY interpreter
  (`GlassTty.acceptChar` + `GraphicsAdapter` handlers): control bytes, the
  `\x84<decimal>u` "emit char by code" escape (used by `con.prnch`), CSI cursor
  moves / erase / SGR colours, and the `?25` cursor-visibility private sequence.
  A swallow-only parser is NOT enough — TVDOS apps drive the screen through
  these `print` escapes.
- `con.move`/`con.getyx` are **1-based** (mirroring `graphics.setCursorYX`'s
  `cx-1` and `getCursorYX`'s `cx+1`); `con.addch` does NOT advance the cursor
  (matches `graphics.putSymbol`), while `con.prnch` DOES.
- `command.js`'s `shell.execute` reassigns the global print family to
  `shell.stdio.out.*`, which call `sys.print` (→ physical GPU). `shell.stdio.out`
  was made to delegate to a `globalThis.__VT_OUT` hook when present (set by the
  bootstrap); outside a VT the hook is absent and the path is byte-identical.

### Direct-VRAM apps need a VT-aware base (the `vaddr` pattern)

Apps that write the text area directly via `graphics.getGpuMemBase()` (rather
than `con.*`/`print`) bypass the shims and paint the physical screen, invading
whatever VT is visible. They must resolve text-area byte `m` through a
VT-aware base:

```js
// physical: backward  (byte m at gpuBase - m)   — getDev inverts to forward-native
// VT pane:  forward   (byte m at VT_TEXT_PLANE + m, the pane buffer the compositor blits)
const VT = (typeof globalThis.VT_TEXT_PLANE !== 'undefined')
const VRAM_BASE = VT ? globalThis.VT_TEXT_PLANE : (graphics.getGpuMemBase() - 253950)
const VRAM_SGN  = VT ? 1 : -1
function vaddr(m) { return VRAM_BASE + VRAM_SGN * m }
```

`sys.memcpy`/`sys.pokeBytes` copy forward in the resolved native memory, so this
works for both directions. The physical branch is identical to the original
arithmetic (no regression outside vtmgr). Applied so far in
`assets/disk0/tvdos/bin/taut.js` and `assets/disk0/hopper/include/aa.mjs`
(used by `bb.js`). Any future direct-VRAM app needs the same one-line `vaddr`.

### Fullscreen apps declare themselves (the `con.setFullscreen` pattern)

A **fullscreen app** paints the whole screen and polls the **raw key snapshot**
(`sys.poke(-40,1)` then `sys.peek(-41..-48)`) directly — e.g. the DOOM port's
`i_input.mjs`, or `playmov` — bypassing the pane input ring. Two problems arise
only under vtmgr: (1) the dispatcher keeps the cooked collector (`-39`) on and
drains typed chars into the *active* pane's ring every frame, so while a raw app
is the active pane every keystroke piles into a ring it never reads and floods
its parent shell the instant it exits (no bug outside vtmgr, where `-39` is off
while a raw app runs — `readKey` clears it); (2) a *backgrounded* raw app would
still read the physical snapshot, eating the foreground console's input.

This is now **first-class**: an app declares itself fullscreen in **one line** and
the right thing happens whether or not vtmgr is present. The API lives on the base
`con` (JS_INIT.js) so it is always defined — **no feature detection**:

- `con.setFullscreen(true)` on entry / `con.setFullscreen(false)` on exit.
  Bare metal: state-only no-op. Under vtmgr (pane override): grabs/releases the
  dispatcher's cooked-input feed via `CTRL+CTRL_RAW_GRAB_VT` (flush type-ahead on
  grab; the dispatcher keeps the ring empty while held). `con.getch` self-heals a
  grab leaked by a crashed app (a cooked reader isn't a grabber).
- `con.isActiveConsole()` — true on bare metal; under vtmgr, true only while this
  pane is the foreground VT. Raw apps that read MMIO directly (keys AND mouse)
  gate their reads on this so a backgrounded app reads nothing.
- `con.poll_keys()` is **auto-guarded**: it returns all-zeros unless
  `con.isActiveConsole()`, so an app that reads keys through `con.poll_keys()`
  (e.g. `playmov`, `playtaud`) needs no explicit active check — just the
  `setFullscreen` declaration.
- `input.withEvent()` (TVDOS.SYS, the shared key/mouse event API that reads the
  raw snapshot for `taut`/`zfm`/`edit`/…) is **also auto-guarded**: when
  `!con.isActiveConsole()` it zeros the key snapshot and pins the mouse, so a
  backgrounded `withEvent` app emits no events. Such apps therefore only need the
  `setFullscreen` declaration too.

The pane's `con.setFullscreen(true)` claims the grab **only while it is the
foreground VT**, so an app may re-assert it every frame (the simplest way to
re-establish the grab after launching a sub-program — `taut`/`zfm` do this at the
top of their event loop) without a backgrounded app clobbering the active
grabber's claim on the single `CTRL_RAW_GRAB_VT` byte. A single up-front claim
also survives backgrounding (nobody else clears it; the app re-claims on return).

`con.grabRawKeyboard()`/`con.releaseRawKeyboard()` remain as deprecated thin
aliases for `con.setFullscreen(true/false)`. Consumers:
- **DOOM** declares fullscreen in `i_video.mjs` `I_InitGraphics`/`I_ShutdownGraphics`
  (shutdown runs in `wadplayer.js`'s `finally`) and gates `i_input.mjs` `I_PollKeys`
  (keys + mouse, read via raw MMIO) on `con.isActiveConsole()`.
- **`playmov`**, **`playtaud`** declare fullscreen around their session and read
  keys through the auto-guarded `con.poll_keys()` (no explicit active check).
- **`taut`**, **`zfm`** re-assert `con.setFullscreen(true)` at the top of their
  `input.withEvent` loop (and release on teardown); the active check is automatic
  via `input.withEvent`.

Any future fullscreen app just calls `con.setFullscreen(true/false)`; if it reads
keys via `con.poll_keys()` or `input.withEvent()` the active guard is automatic,
and only an app that reads MMIO with bespoke code needs `con.isActiveConsole()`.

### Files

- New: `assets/disk0/tvdos/VTMGR.SYS` (dispatcher + per-pane bootstrap)
- `assets/disk0/tvdos/bin/command.js`: `chvt` builtin, `[N]` prompt prefix for
  VT 2-6, `shell.stdio.out` → `__VT_OUT` delegation
- `assets/disk0/tvdos/TVDOS.SYS`: boot block runs `\commandrc` (env) in every
  context, then — only when `!_TVDOS_IS_VT_PANE` — launches `tvdos/sbin/vtmgr`
  and, on its exit, `\AUTOEXEC.BAT` as the fallback shell
- `assets/disk0/commandrc`: env-only `set` commands (PATH/INCLPATH/HELPPATH/KEYBOARD)
- `assets/disk0/AUTOEXEC.BAT`: per-console launch (Korean IME + `command -fancy`)
- `assets/disk0/tvdos/bin/taut.js`, `assets/disk0/hopper/include/aa.mjs`:
  `vaddr` VT-aware direct-VRAM addressing
- `tsvm_core/src/net/torvald/tsvm/JS_INIT.js`: base (bare-metal) `con.setFullscreen`/
  `isFullscreen`/`isActiveConsole` + auto-guarded `con.poll_keys`; grab/release aliases
- `assets/disk0/tvdos/VTMGR.SYS`: `CTRL_RAW_GRAB_VT` flag + VT-aware overrides of
  `con.setFullscreen` (claim gated on being the foreground VT) / `isActiveConsole`
- `assets/disk0/tvdos/TVDOS.SYS`: `input.withEvent` auto-guard (zeros keys / pins
  mouse when `!con.isActiveConsole()`) — covers every `withEvent` app
- Consumers: `assets/disk0/home/doom/i_video.mjs` (`setFullscreen` in/out) +
  `i_input.mjs` (`isActiveConsole` guard for keys+mouse);
  `assets/disk0/tvdos/bin/playmov.js` + `bin/playtaud.js` (`setFullscreen` +
  auto-guarded `con.poll_keys`); `bin/taut.js` + `bin/zfm.js` (`setFullscreen`
  re-asserted at the top of their `input.withEvent` loop)

### Gotcha: injectIntChk vs. embedded source

`execApp`/`require` run a program's source through `injectIntChk` (TVDOS.SYS),
which sed-rewrites the **first** `while`/`for`/`do` of each kind to call a
per-exec `tvdosSIGTERM_<hash>()` SIGTERM check. When vtmgr embeds the pane
bootstrap as a string literal, one of those rewrites can land inside the literal
— and the pane context has no such symbol. vtmgr strips them from the bootstrap
string with `raw.replace(/tvdosSIGTERM_[A-Za-z0-9_]+\(\);?/g, '')`. Any future
code that builds executable source as a string literal must do the same.
