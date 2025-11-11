# TAV - TSVM Advanced Video Codec

A perceptually-optimised wavelet-based video codec designed for resource-constrained systems, featuring multiple wavelet types, temporal 3D DWT, and sophisticated compression techniques.

## Overview

TAV (TSVM Advanced Video) is a modern video codec built on discrete wavelet transformation (DWT). It combines cutting-edge compression techniques with careful optimisation for resource-constrained systems.

### Key Advantages

- **No blocking artefacts**: Large-tile DWT encoding with padding eliminates DCT block boundaries
- **Perceptual optimisation**: HVS-aware quantisation preserves visual quality where it matters
- **Temporal coherence**: 3D DWT with GOP encoding exploits inter-frame similarity
- **Efficient sparse coding**: EZBC encoding exploits coefficient sparsity for 16-18% additional compression
- **Hardware-friendly**: Designed for efficient decoding on resource-constrained platforms

## Features

### Compression Technology

- **Wavelet Types**
  - **5/3 Reversible** (JPEG 2000 standard): Lossless-capable, good for archival
  - **9/7 Irreversible** (default): Best overall compression, CDF 9/7 variant

- **Spatial Encoding**
  - Large-tile encoding with padding, with optional single-tile mode (no blocking artefacts)
  - 6-level DWT decomposition for deep frequency analysis
  - Perceptual quantisation with HVS-optimised coefficient scaling
  - YCoCg-R colour space with anisotropic chroma quantisation

- **Temporal Encoding** (3D DWT Mode)
  - Group-of-pictures (GOP) encoding with adaptive size (typically 20 frames)
  - Unified EZBC encoding across temporal dimension
  - Adaptive GOP boundaries with scene change detection

- **EZBC Encoding**
  - Binary tree embedded zero block coding exploits coefficient sparsity
  - Progressive refinement structure with bitplane encoding
  - Concatenated channel layout for cross-channel compression optimisation
  - Typical sparsity: 86.9% (Y), 97.8% (Co), 99.5% (Cg)
  - 16-18% compression improvement over naive coefficient encoding
  
### Audio Integration

TAV seamlessly integrates with the TAD (TSVM Advanced Audio) codec for synchronised audio/video encoding:
- Variable chunk sizes match video GOP boundaries
- Embedded TAD packets (type 0x24) with Zstd compression
- Unified container format

## Building

### Prerequisites

- C compiler (GCC/Clang)
- Zstandard library
- OpenCV 4 library (only used by experimental motion estimation feature)

### Compilation

```bash
# Build TAV encoder/decoder
make tav

# Build all tools including TAD audio codec
make all

# Clean build artefacts
make clean
```

### Build Targets

- `encoder_tav` - Main video encoder
- `decoder_tav` - Standalone video decoder
- `tav_inspector` - Packet analysis and debugging tool

## Usage

### Basic Encoding

Encoding requires FFmpeg executable installed in your system.

```bash
# Default encoding (CDF 9/7 wavelet, quality level 3)
./encoder_tav -i input.mp4 -o output.tav

# Quality levels (0-5)
./encoder_tav -i input.avi -q 0 -o output.tav    # Lowest quality, smallest file
./encoder_tav -i input.mkv -q 5 -o output.tav    # Highest quality, largest file
```

### Intra-only Encoding

```bash
# Enable Intra-only encoding
./encoder_tav -i input.mp4 --intra-only -o output.tav
```

### Decoding and Inspection

```bash
# Decode TAV to raw video
./decoder_tav -i input.tav -o output.mkv

# Inspect packet structure (debugging)
./tav_inspector input.tav -v
```

### Frame Limiting

```bash
# Encode only first N frames (useful for testing)
./encoder_tav -i input.mp4 -o output.tav --encode-limit 100
```

## Technical Architecture

### Encoder Pipeline

1. **Input Processing**
   - FFmpeg demuxing and frame extraction
   - RGB to YCoCg-R colour space conversion
   - Resolution validation and padding

2. **DWT Transform**
   - Spatial: 6-level decomposition per frame
   - Temporal: 1D DWT across GOP frames (3D DWT mode)
   - Lifting scheme implementation for all wavelets

3. **Perceptual Quantisation**
   - HVS-based subband weights
   - Anisotropic chroma quantisation (YCoCg-R specific)
   - Quality-dependent quantisation matrices

4. **EZBC Encoding**
   - Binary tree embedded zero block coding per channel
   - Progressive refinement by bitplanes
   - Concatenated bitstream layout: `[Y_bitstream][Co_bitstream][Cg_bitstream]`
   - Cross-channel compression optimisation
   
5. **Entropy Coding**
   - Zstandard compression (level 7) on concatenated EZBC bitstreams
   - Cross-channel compression opportunities
   - Adaptive compression based on GOP structure

### Decoder Pipeline

1. **Container Parsing**
   - Packet type identification (0x00-0xFF)
   - Timecode synchronisation
   - GOP boundary detection

2. **Entropy Decoding**
   - Zstd decompression of concatenated bitstreams
   - EZBC binary tree decoding per channel
   - Progressive coefficient reconstruction

3. **Inverse Quantisation**
   - Perceptual weight application
   - Subband-specific scaling
   - Coefficient reconstruction from sparse representation

4. **Inverse DWT**
   - Temporal: 1D inverse DWT across frames (3D DWT mode)
   - Spatial: 6-level inverse wavelet reconstruction

5. **Output Conversion**
   - YCoCg-R to RGB colour space
   - Clamping and dithering
   - Frame buffering for display

### Wavelet Implementation

All wavelets follow a **lifting scheme** pattern with symmetric boundary extension:

```c
// Forward Transform: Predict → Update
temp[half + i] = data[odd] - predict(data[even]);  // High-pass
temp[i] = data[even] + update(temp[half]);         // Low-pass

// Inverse Transform: Undo Update → Undo Predict (reversed order)
data[even] = temp[i] - update(temp[half]);         // Undo low-pass
data[odd] = temp[half + i] + predict(data[even]);  // Undo high-pass
```

**Critical**: Forward and inverse transforms must use identical coefficient indexing and exactly reverse operations to avoid grid artefacts.

### Coefficient Layout

TAV uses **2D Spatial Layout** in memory for each decomposition level:

```
[LL] [LH] [HL] [HH] [LH] [HL] [HH] ...
 └── Level 0 ──┘ └─── Level 1 ───┘
```

- `LL`: Low-pass (approximation) - progressively smaller with each level
- `LH`, `HL`, `HH`: High-pass subbands (horizontal, vertical, diagonal detail)

## Performance Characteristics

### Compression Efficiency

- **Sparsity Exploitation**: Typical quantised coefficient sparsity
  - Y channel: 86.9% zeros
  - Co channel: 97.8% zeros
  - Cg channel: 99.5% zeros

- **EZBC Benefits**: 16-18% compression improvement over naive coefficient encoding through sparsity exploitation

- **Temporal Coherence**: Additional 15-25% improvement with 3D DWT (content-dependent)

### Computational Complexity

- **Encoding**: O(n log n) per frame for spatial DWT
- **Decoding**: O(n log n) per frame, optimised lifting scheme implementation
- **Memory**: Single-tile encoding requires O(w × h) working memory

### Quality Characteristics

- **No blocking artefacts**: Wavelet-based encoding is inherently smooth
- **Perceptual optimisation**: Better subjective quality than bitrate-equivalent DCT codecs
- **Scalability**: 6 quality levels (0-5) provide wide range of bitrate/quality trade-offs
- **Temporal stability**: 3D DWT mode reduces flickering and temporal artefacts

## Format Specification

For complete packet structure and bitstream format details, refer to `format documentation.txt`.

### Key Packet Types

- `0x00`: Metadata and initialisation
- `0x01`: I-frame (intra-coded frame)
- `0x12`: GOP unified packet (3D DWT mode)
- `0x24`: Embedded TAD audio
- `0xFC`: GOP synchronisation
- `0xFD`: Timecode

## Debugging Tools

### TAV Inspector

Analyse TAV packet structure and decode individual frames:

```bash
# Verbose packet analysis
./tav_inspector input.tav -v

# Extract specific frame ranges
./tav_inspector input.tav --frame-range 100-200
```

## Related Projects

- **TAD** (TSVM Advanced Audio): Perceptual audio codec using CDF 9/7 wavelets
- **TSVM**: Target virtual machine platform for TAV playback

## Licence

MIT.
