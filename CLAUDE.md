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
- TVDOS filesystem uses custom format with specialized drivers

## Videotron2K

The Videotron2K is a specialized video display controller with:
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
  - YCoCg-R 4:2:0 Chroma subsampling (more aggressive quantization on Cg channel)
  - Full 8-Bit RGB colour for increased visual fidelity, rendered down to TSVM-compliant 4-Bit RGB with dithering upon playback
- **Usage Examples**:
  ```bash
  # Quality mode
  ./encoder_tev -i input.mp4 -q 2 -o output.tev

  # Playback
  playtev output.tev
  ```
- **Format documentation**: `terranmon.txt` (search for "TSVM Enhanced Video (TEV) Format")
- **Version**: 2.1 (includes rate control factor in all video packets)

#### TAV Format (TSVM Advanced Video)
- **Successor to TEV**: DWT-based video codec using wavelet transforms instead of DCT
- **C Encoder**: `video_encoder/encoder_tav.c` - Multi-wavelet encoder with perceptual quantization
  - How to build: `make tav`
  - **Wavelet Support**: Multiple wavelet types for different compression characteristics
- **JS Decoder**: `assets/disk0/tvdos/bin/playtav.js` - Native decoder for TAV format playback
- **Hardware accelerated decoding**: Extended GraphicsJSR223Delegate.kt with TAV functions
- **Features**:
  - **Multiple Wavelet Types**: 5/3 reversible, 9/7 irreversible, CDF 13/7, DD-4, Haar
  - **Single-tile encoding**: One large DWT tile for optimal quality (no blocking artifacts)
  - **Perceptual quantization**: HVS-optimized coefficient scaling
  - **YCoCg-R color space**: Efficient chroma representation with "simulated" subsampling using anisotropic quantization (search for "ANISOTROPY_MULT_CHROMA" on the encoder)
  - **6-level DWT decomposition**: Deep frequency analysis for better compression (deeper levels possible but 6 is the maximum for the default TSVM size)
  - **Significance Map Compression**: Improved coefficient storage format exploiting sparsity for 16-18% additional compression (2025-09-29 update)
  - **Concatenated Maps Layout**: Cross-channel compression optimization for additional 1.6% improvement (2025-09-29 enhanced)
- **Usage Examples**:
  ```bash
  # Different wavelets
  ./encoder_tav -i input.mp4 -w 0 -q 2 -o output.tav    # 5/3 reversible (lossless capable)
  ./encoder_tav -i input.mp4 -w 1 -q 2 -o output.tav    # 9/7 irreversible (default, best compression)
  ./encoder_tav -i input.mp4 -w 2 -q 2 -o output.tav    # CDF 13/7 (experimental)
  ./encoder_tav -i input.mp4 -w 16 -q 2 -o output.tav   # DD-4 (four-point interpolating)
  ./encoder_tav -i input.mp4 -w 255 -q 2 -o output.tav  # Haar (demonstration)

  # Quality levels (0-5)
  ./encoder_tav -i input.mp4 -q 0 -o output.tav         # Lowest quality, smallest file
  ./encoder_tav -i input.mp4 -q 5 -o output.tav         # Highest quality, largest file

  # Playback
  playtav output.tav
  ```

**CRITICAL IMPLEMENTATION NOTES**:

**Wavelet Coefficient Layout**:
- TAV uses **linear subband layout** in memory: `[LL, LH, HL, HH, LH, HL, HH, ...]` for each decomposition level
- **Forward transform must output**: `temp[0...half-1] = low-pass`, `temp[half...length-1] = high-pass`
- **Inverse transform must expect**: Same linear layout and exactly reverse forward operations
- **Common mistake**: Assuming interleaved or 2D spatial layout leads to grid/checkerboard artifacts

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
- **0**: 5/3 reversible (lossless when unquantized, JPEG 2000 standard)
- **1**: 9/7 irreversible (best compression, CDF 9/7 variant, default choice)
- **2**: CDF 13/7 (experimental, simplified implementation)
- **16**: DD-4 (four-point interpolating Deslauriers-Dubuc, for still images)
- **255**: Haar (demonstration only, simplest possible wavelet)

- **Format documentation**: `terranmon.txt` (search for "TSVM Advanced Video (TAV) Format")
- **Version**: Current (perceptual quantization, multi-wavelet support, significance map compression)

#### TAV Significance Map Compression (Technical Details)

The significance map compression technique implemented on 2025-09-29 provides substantial compression improvements by exploiting the sparsity of quantized DWT coefficients:

**Implementation Files**:
- **C Encoder**: `video_encoder/encoder_tav.c` - `preprocess_coefficients()` function (lines 960-991)
- **C Decoder**: `video_encoder/decoder_tav.c` - `postprocess_coefficients()` function (lines 29-48)
- **Kotlin Decoder**: `GraphicsJSR223Delegate.kt` - `postprocessCoefficients()` function for TSVM runtime

**Technical Approach**:
```
Original: [coeff_array] → [concatenated_significance_maps + nonzero_values]

Concatenated Maps Layout:
[Y_map][Co_map][Cg_map][Y_vals][Co_vals][Cg_vals] (channel layout 0)
[Y_map][Co_map][Cg_map][A_map][Y_vals][Co_vals][Cg_vals][A_vals] (channel layout 1)
[Y_map][Y_vals] (channel layout 2)
[Y_map][A_map][Y_vals][A_vals] (channel layout 3)
[Co_map][Cg_map][Co_vals][Cg_vals] (channel layout 4)
[Co_map][Cg_map][A_map][Co_vals][Cg_vals][A_vals] (channel layout 5)

(replace Y->I, Co->Ct, Cg->Cp for ICtCp colour space)

- Significance map: 1 bit per coefficient (0=zero, 1=non-zero)
- Value arrays: Only non-zero coefficients in sequence per channel
- Cross-channel optimization: Zstd finds patterns across similar significance maps
- Result: 16-18% compression improvement + 1.6% additional from concatenation
```

**Performance**:
- **Sparsity exploitation**: Tested on quantized DWT coefficients with 86.9% sparsity (Y), 97.8% (Co), 99.5% (Cg)
- **Compression improvement**: 16.4% from significance maps + 1.6% from concatenated layout
- **Real-world impact**: 559 bytes saved per frame (5.59 MB per 10k frames)
- **Cross-channel benefit**: Concatenated maps allow Zstd to exploit similarity between significance patterns
