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

1. Download JDK 17 runtimes to `~/Documents/openjdk/*` with specific naming:
   - `jdk-17.0.1-x86` (Linux AMD64)
   - `jdk-17.0.1-arm` (Linux Aarch64) 
   - `jdk-17.0.1-windows` (Windows AMD64)
   - `jdk-17.0.1.jdk-arm` (macOS Apple Silicon)
   - `jdk-17.0.1.jdk-x86` (macOS Intel)

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
