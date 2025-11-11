# TAD - TSVM Advanced Audio Codec

A perceptually-optimised wavelet-based audio codec designed for resource-constrained systems, featuring CDF 9/7 wavelets, EZBC sparse coding, and sophisticated perceptual quantisation.

## Overview

TAD (TSVM Advanced Audio) is a modern audio codec built on discrete wavelet transform (DWT) using Cohen-Daubechies-Feauveau (CDF) 9/7 biorthogonal wavelets. It combines perceptual quantisation, advanced entropy coding, and careful optimisation for resource-constrained systems.

### Key Advantages

- **Perceptual optimisation**: HVS-aware quantisation preserves audio quality where it matters
- **Efficient sparse coding**: EZBC encoding exploits coefficient sparsity (86.9% zeros in typical content)
- **Variable chunk sizes**: Supports any chunk size ≥1024 samples, including non-power-of-2
- **Stereo decorrelation**: Mid/Side encoding exploits stereo correlation for better compression
- **Hardware-friendly**: Designed for efficient decoding on resource-constrained platforms

## Features

### Compression Technology

- **CDF 9/7 Biorthogonal Wavelets**
  - 9-level fixed decomposition for all chunk sizes
  - Lifting scheme implementation for efficient computation
  - Optimal frequency discrimination for audio signals

- **Pre-processing**
  - First-order IIR pre-emphasis filter (α=0.5) shifts quantisation noise to lower frequencies, where they are less objectionable to listeners
  - Gamma compression (γ=0.5) for dynamic range compression before quantisation
  - Mid/Side stereo transformation exploits stereo correlation
  - Lambda companding (λ=6.0) with Laplacian CDF mapping for full bit utilisation

- **Perceptual Quantisation**
  - Channel-specific (Mid/Side) frequency-dependent weights
  - Subband-aware quantisation preserves perceptually important frequencies

- **EZBC Encoding**
  - Binary tree embedded zero block coding
  - Exploits coefficient sparsity (86.9% Mid, 97.8% Side typical)
  - Progressive refinement structure
  - Spatial clustering of non-zero coefficients

- **Entropy Coding**
  - Zstandard compression (level 7) on concatenated EZBC bitstreams
  - Cross-channel compression optimisation
  - Optional Zstd bypass for debugging

### Audio Format

- **Sample Rate**: 32 KHz (TSVM audio hardware native format)
- **Channels**: Stereo (L/R input, Mid/Side internal representation)
- **Chunk Sizes**: Variable, any size ≥1024 samples (including non-power-of-2)
- **Bit Depth**: 32-bit float internal, 8-bit unsigned PCM output with noise-shaped dithering
- **Bandwidth**: Full 0-16 KHz frequency range preserved

### Quality Levels

Six quality levels (0-5) provide a wide range of compression/quality trade-offs:
- **Level 0**: Lowest quality, smallest file size
- **Level 3**: Default, balanced quality/compression (2.51:1 vs PCMu8)
- **Level 5**: Highest quality, largest file size

Quality levels are designed to be synchronised with TAV video codec for unified encoding.

## Building

### Prerequisites

- C compiler (GCC/Clang)
- Zstandard library (libzstd)
- Math library (libm)

### Compilation

```bash
# Build TAD encoder/decoder
make tad

# Build all tools
make all

# Clean build artifacts
make clean
```

### Build Targets

- `encoder_tad` - Standalone audio encoder with FFmpeg calls
- `decoder_tad` - Standalone audio decoder

## Usage

### Basic Encoding

Encoding requires FFmpeg executable installed in your system.

```bash
# Default encoding (quality level 3)
./encoder_tad -i input.mp3 -o output.tad

# Specify quality level (0-5)
./encoder_tad -i input.m4a -o output.tad -q 0    # Lowest quality
./encoder_tad -i input.ogg -o output.tad -q 5    # Highest quality

# Disable Zstd compression (for debugging)
./encoder_tad -i input.opus -o output.tad --no-zstd

# Verbose output with statistics
./encoder_tad -i input.flac -o output.tad -v
```

### Decoding

```bash
# Decode to PCMu8
./decoder_tad -i input.tad -o output.pcm --raw-pcm

# Decode to WAV
./decoder_tad -i input.tad -o output.wav
```

### Input Formats

TAD encoder accepts any audio format supported by FFmpeg:
- Audio files: WAV, MP3, FLAC, OGG, AAC, etc.
- Video files with audio streams: MP4, MKV, AVI, etc.
- Raw PCM formats

Audio is automatically resampled to 32 KHz stereo if necessary.

## Technical Architecture

### Encoder Pipeline

1. **Input Processing**
   - FFmpeg demuxing and audio stream extraction
   - Resampling to 32 KHz stereo
   - Conversion to PCM32f

2. **Pre-emphasis Filter**
   - First-order IIR filter with α=0.5
   - Shifts quantisation noise toward lower frequencies
   - Improves perceptual quality

3. **Gamma Compression**
   - Dynamic range compression with γ=0.5
   - Applied independently to each sample
   - Reduces quantisation error for low-amplitude signals

4. **Stereo Decorrelation**
   - Left/Right to Mid/Side transformation
   - Mid = (L + R) / 2
   - Side = (L - R) / 2
   - Exploits stereo correlation for better compression

5. **9-Level CDF 9/7 DWT**
   - Fixed 9 decomposition levels for all chunk sizes
   - Forward lifting scheme implementation
   - Correct length tracking for non-power-of-2 sizes

6. **Perceptual Quantisation**
   - Channel-specific (Mid/Side) subband weights
   - Lambda companding with λ=6.0
   - Laplacian CDF mapping: `sign(x) * floor(λ * log(1 + |x|/λ))`
   - Quantised to int8 coefficients

7. **EZBC Encoding**
   - Binary tree structure per channel
   - Progressive refinement by bitplanes
   - Zero block coding exploits sparsity
   - Independent bitstreams for Mid and Side

8. **Zstd Compression**
   - Level 7 compression on concatenated `[Mid_bitstream][Side_bitstream]`
   - Cross-channel optimisation opportunities
   - Adaptive compression based on content

### Decoder Pipeline

1. **Container Parsing**
   - TAD packet identification (type 0x24)
   - Chunk size extraction
   - Compressed data boundaries

2. **Zstd Decompression**
   - Decompress concatenated bitstreams
   - Split into Mid and Side EZBC streams

3. **EZBC Decoding**
   - Binary tree decoder per channel
   - Reconstruct quantised int8 coefficients
   - Progressive refinement reconstruction

4. **Lambda Decompanding**
   - Inverse Laplacian CDF with channel-specific weights
   - Reconstruct float32 DWT coefficients
   - Apply subband-specific perceptual weights

5. **9-Level Inverse CDF 9/7 DWT**
   - Inverse lifting scheme implementation
   - Correct length tracking for non-power-of-2 chunk sizes
   - Pre-calculated length sequence from forward transform

6. **Mid/Side to Left/Right**
   - L = Mid + Side
   - R = Mid - Side
   - Reconstruct stereo channels

7. **Gamma Expansion**
   - Inverse gamma with γ⁻¹=2.0
   - Restore original dynamic range

8. **De-emphasis Filter**
   - Reverse pre-emphasis with α=0.5
   - Remove frequency shaping
   - Restore flat frequency response

9. **PCM32f to PCM8u Conversion**
   - Noise-shaped dithering for 8-bit output
   - Clamping to valid range
   - Final output format

### Wavelet Implementation

CDF 9/7 wavelet follows a **two-stage lifting scheme**:

```c
// Forward Transform: Predict → Update
// Predict step (generate high-pass)
temp[half + i] = data[odd] - α * (data[even_left] + data[even_right]);

// Update step (generate low-pass)
temp[i] = data[even] + β * (temp[half + i - 1] + temp[half + i]);

// Normalization (K factor)
temp[i] *= K;
temp[half + i] /= K;

// Inverse Transform: Denormalize → Undo Update → Undo Predict (reversed order)
temp[i] /= K;
temp[half + i] *= K;

temp[i] -= β * (temp[half + i - 1] + temp[half + i]);
data[odd] = temp[half + i] + α * (temp[i] + temp[i + 1]);
data[even] = temp[i];
```

**CDF 9/7 Coefficients**:
- α = -1.586134342
- β = -0.052980118
- γ = +0.882911075
- δ = +0.443506852
- K = 1.230174105

### Non-Power-of-2 Chunk Size Handling

Critical implementation detail for variable chunk sizes:

```c
// Pre-calculate exact length sequence from forward transform
int lengths[MAX_LEVELS + 1];
lengths[0] = chunk_size;
for (int i = 1; i <= levels; i++) {
    lengths[i] = (lengths[i - 1] + 1) / 2;
}

// Apply inverse DWT using lengths[level] for each level
// NEVER use simple doubling (length *= 2) - incorrect for non-power-of-2!
```

Incorrect length tracking causes mirrored subband artefacts in decoded audio.

### Perceptual Quantisation Weights

Channel-specific weights for Mid (channel 0) and Side (channel 1):

```c
// Base quantiser weights per subband (9 levels + approximation)
float BASE_QUANTISER_WEIGHTS[2][10] = {
    // Mid channel (0)
    {4.0f, 2.0f, 1.8f, 1.6f, 1.4f, 1.2f, 1.0f, 1.0f, 1.3f, 2.0f},

    // Side channel (1)
    {6.0f, 5.0f, 2.6f, 2.4f, 1.8f, 1.3f, 1.0f, 1.0f, 1.6f, 3.2f}
};

// During dequantisation:
float weight = BASE_QUANTISER_WEIGHTS[channel][subband] * quantiser_scale;
coeffs[i] = normalised_val * TAD32_COEFF_SCALARS[subband] * weight;
```

Different weights for Mid and Side channels reflect perceptual importance of frequency bands in each channel. DC frequency has highest weight (4.0 Mid, 6.0 Side) due to energy concentration.

## Performance Characteristics

### Compression Efficiency

- **Target Compression**: 2:1 against PCMu8 baseline (4:1 against PCM16LE input)
- **Achieved Compression**: 2.51:1 against PCMu8 at quality level 3
- **Audio Quality**: Preserves full 0-16 KHz bandwidth
- **Coefficient Sparsity**: 86.9% zeros in Mid channel, 97.8% in Side channel (typical)
- **EZBC Benefits**: Exploits sparsity, progressive refinement, spatial clustering

### Computational Complexity

- **Encoding**: O(n log n) per chunk for DWT, O(n) for EZBC encoding
- **Decoding**: O(n log n) per chunk for inverse DWT, O(n) for EZBC decoding
- **Memory**: O(n) working memory for chunk processing

### Quality Characteristics

- **Frequency Response**: Flat 0-16 KHz within perceptual limits
- **Dynamic Range**: Preserved through gamma compression/expansion
- **Stereo Imaging**: Maintained through Mid/Side decorrelation
- **Perceptual Quality**: Optimised for human auditory system characteristics

## Integration with TAV

TAD is designed as an includable API for TAV video encoder integration:

- **Variable Chunk Sizes**: Audio chunks can match video GOP boundaries (e.g., 32016 samples for 1-second TAV GOP)
- **Unified Quality Levels**: TAD quality 0-5 synchronised with TAV quality 0-5
- **Embedded Packets**: TAV embeds TAD-compressed audio using packet type 0x24
- **Shared Container**: Single .tav file contains both video and audio streams

### TAV Integration Example

```c
// TAD handles non-power-of-2 chunk size correctly
tad_encode_chunk(audio_buffer, audio_samples_per_gop, output_buffer, &output_size);

// TAV embeds TAD packet
tav_write_packet(TAV_PACKET_AUDIO, output_buffer, output_size);
```

## Format Specification

For complete packet structure and bitstream format details, refer to `format documentation.txt`.

### Key Packet Types

- `0x24`: TAD audio packet (used in standalone .tad files and embedded in .tav files)

## Related Projects

- **TAV** (TSVM Advanced Video): Wavelet-based video codec with integrated TAD audio
- **TSVM**: Target virtual machine platform for TAD playback

## Licence

MIT.
