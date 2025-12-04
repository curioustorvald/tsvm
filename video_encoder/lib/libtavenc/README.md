# libtavenc - TAV Video Encoder Library

**libtavenc** is a high-performance video encoding library implementing the TSVM Advanced Video (TAV) codec. It provides a clean C API for encoding RGB24 video frames using discrete wavelet transform (DWT) with perceptual quantization and GOP-based temporal compression.

## Features

- **Multiple Wavelet Types**: CDF 5/3, CDF 9/7, CDF 13/7, DD-4, Haar
- **3D DWT GOP Encoding**: Temporal + spatial wavelet compression
- **Perceptual Quantization**: HVS-optimized coefficient scaling
- **EZBC Entropy Coding**: Efficient coefficient compression with Zstd
- **Multi-threading**: Internal thread pool for optimal performance
- **Color Spaces**: YCoCg-R (default) and ICtCp (for HDR)
- **Quality Levels**: 0-5 (0=lowest/smallest, 5=highest/largest)

## Building

```bash
# Build static library
make lib/libtavenc.a

# Build with encoder CLI
make encoder_tav

# Install library and headers
make install-libs PREFIX=/usr/local
```

## Quick Start

### Basic Encoding

```c
#include "tav_encoder_lib.h"
#include <stdio.h>

int main() {
    // Initialize encoder parameters
    tav_encoder_params_t params;
    tav_encoder_params_init(&params, 1920, 1080);

    // Configure encoding options
    params.fps_num = 60;
    params.fps_den = 1;
    params.wavelet_type = 1;        // CDF 9/7 (default)
    params.quality_y = 3;            // Quality level 3
    params.quality_co = 3;
    params.quality_cg = 3;
    params.enable_temporal_dwt = 1;  // Enable 3D GOP encoding
    params.gop_size = 0;             // Auto-calculate (typically 16-24)
    params.num_threads = 4;          // 4 worker threads

    // Create encoder context
    tav_encoder_context_t *ctx = tav_encoder_create(&params);
    if (!ctx) {
        fprintf(stderr, "Failed to create encoder\n");
        return -1;
    }

    // Get actual parameters (with auto-calculated values)
    tav_encoder_get_params(ctx, &params);
    printf("GOP size: %d frames\n", params.gop_size);

    // Encode frames
    uint8_t *rgb_frame = /* ... load RGB24 frame ... */;
    tav_encoder_packet_t *packet;

    for (int i = 0; i < num_frames; i++) {
        int result = tav_encoder_encode_frame(ctx, rgb_frame, i, &packet);

        if (result == 1) {
            // Packet ready (GOP completed)
            fwrite(packet->data, 1, packet->size, outfile);
            tav_encoder_free_packet(packet);
        }
        else if (result == 0) {
            // Frame buffered, waiting for GOP to fill
        }
        else {
            // Error
            fprintf(stderr, "Encoding error: %s\n", tav_encoder_get_error(ctx));
            break;
        }
    }

    // Flush remaining frames
    while (tav_encoder_flush(ctx, &packet) == 1) {
        fwrite(packet->data, 1, packet->size, outfile);
        tav_encoder_free_packet(packet);
    }

    // Cleanup
    tav_encoder_free(ctx);
    return 0;
}
```

### Stateless GOP Encoding (Multi-threaded)

The library provides `tav_encoder_encode_gop()` for stateless GOP encoding, perfect for multi-threaded applications:

```c
#include "tav_encoder_lib.h"
#include <pthread.h>

typedef struct {
    tav_encoder_params_t params;
    uint8_t **rgb_frames;
    int num_frames;
    int *frame_numbers;
    tav_encoder_packet_t *output_packet;
} gop_encode_job_t;

void *encode_gop_thread(void *arg) {
    gop_encode_job_t *job = (gop_encode_job_t *)arg;

    // Create thread-local encoder context
    tav_encoder_context_t *ctx = tav_encoder_create(&job->params);
    if (!ctx) {
        return NULL;
    }

    // Encode entire GOP at once (stateless, thread-safe)
    tav_encoder_encode_gop(ctx,
                           (const uint8_t **)job->rgb_frames,
                           job->num_frames,
                           job->frame_numbers,
                           &job->output_packet);

    tav_encoder_free(ctx);
    return NULL;
}

int main() {
    // Setup parameters
    tav_encoder_params_t params;
    tav_encoder_params_init(&params, 1920, 1080);
    params.enable_temporal_dwt = 1;
    params.gop_size = 24;

    // Create worker threads
    pthread_t threads[4];
    gop_encode_job_t jobs[4];

    for (int i = 0; i < 4; i++) {
        jobs[i].params = params;
        jobs[i].rgb_frames = /* ... load GOP frames ... */;
        jobs[i].num_frames = 24;
        jobs[i].frame_numbers = /* ... frame indices ... */;

        pthread_create(&threads[i], NULL, encode_gop_thread, &jobs[i]);
    }

    // Wait for completion
    for (int i = 0; i < 4; i++) {
        pthread_join(threads[i], NULL);

        // Write output packet
        if (jobs[i].output_packet) {
            fwrite(jobs[i].output_packet->data, 1,
                   jobs[i].output_packet->size, outfile);
            tav_encoder_free_packet(jobs[i].output_packet);
        }
    }

    return 0;
}
```

## API Reference

### Context Management

#### `tav_encoder_create()`
Creates encoder context with specified parameters. Allocates internal buffers and initializes thread pool if multi-threading enabled.

**Returns**: Encoder context or NULL on failure

#### `tav_encoder_free()`
Frees encoder context and all resources. Any unflushed GOP frames are lost.

#### `tav_encoder_get_error()`
Returns last error message string.

#### `tav_encoder_get_params()`
Gets encoder parameters with calculated values (e.g., auto-calculated GOP size, decomposition levels).

### Frame Encoding

#### `tav_encoder_encode_frame()`
Encodes single RGB24 frame. Frames are buffered until GOP is full.

**Parameters**:
- `rgb_frame`: RGB24 planar format `[R...][G...][B...]`, width×height×3 bytes
- `frame_pts`: Presentation timestamp (frame number or time)
- `packet`: Output packet pointer (NULL if GOP not ready)

**Returns**:
- `1`: Packet ready (GOP completed)
- `0`: Frame buffered, waiting for more frames
- `-1`: Error

#### `tav_encoder_flush()`
Flushes remaining buffered frames and encodes final GOP. Call at end of stream.

**Returns**:
- `1`: Packet ready
- `0`: No more packets
- `-1`: Error

#### `tav_encoder_encode_gop()`
Stateless GOP encoding. Thread-safe with separate contexts.

**Parameters**:
- `rgb_frames`: Array of RGB24 frames `[frame][width×height×3]`
- `num_frames`: Number of frames in GOP (1-24)
- `frame_numbers`: Frame indices for timecodes (can be NULL)
- `packet`: Output packet pointer

**Returns**: `1` on success, `-1` on error

### Packet Management

#### `tav_encoder_free_packet()`
Frees packet returned by encoding functions.

## Encoder Parameters

### Video Dimensions
- `width`, `height`: Frame dimensions (must be even)
- `fps_num`, `fps_den`: Framerate (e.g., 60/1 for 60fps)

### Wavelet Configuration
- `wavelet_type`: Spatial wavelet
  - `0`: CDF 5/3 (reversible, lossless-capable)
  - `1`: CDF 9/7 (default, best compression)
  - `2`: CDF 13/7 (experimental)
  - `16`: DD-4 (four-point interpolating)
  - `255`: Haar (demonstration)
- `temporal_wavelet`: Temporal wavelet for 3D DWT
  - `0`: Haar (default for sports/high motion)
  - `1`: CDF 5/3 (smooth motion)
- `decomp_levels`: Spatial DWT levels (0=auto, typically 6)
- `temporal_levels`: Temporal DWT levels (0=auto, typically 2 for 8-frame GOPs)

### Color Space
- `channel_layout`:
  - `0`: YCoCg-R (default, efficient chroma)
  - `1`: ICtCp (for HDR/BT.2100 sources)
- `perceptual_tuning`: 1=enable HVS perceptual quantization (default), 0=uniform

### GOP Configuration
- `enable_temporal_dwt`: 1=enable 3D DWT GOP encoding (default), 0=intra-only I-frames
- `gop_size`: Frames per GOP (8, 16, or 24; 0=auto based on framerate)
- `enable_two_pass`: 1=enable two-pass with scene change detection (default), 0=single-pass

### Quality Control
- `quality_y`: Luma quality (0-5, default: 3)
- `quality_co`: Orange chrominance quality (0-5, default: 3)
- `quality_cg`: Green chrominance quality (0-5, default: 3)
- `dead_zone_threshold`: Dead-zone quantization (0=disabled, 1-10 typical)

### Entropy Coding
- `entropy_coder`:
  - `0`: Twobitmap (default, fast)
  - `1`: EZBC (better compression for high-quality)
- `zstd_level`: Zstd compression level (3-22, default: 7)

### Multi-threading
- `num_threads`: Worker threads
  - `0`: Single-threaded (default for CLI)
  - `-1`: Auto-detect CPU cores
  - `1-16`: Explicit thread count

### Encoder Presets
- `encoder_preset`: Preset flags
  - `0x01`: Sports mode (finer temporal quantization)
  - `0x02`: Anime mode (disable grain)

## TAV Packet Types

Output packets have type field indicating content:

- `0x10`: I-frame (intra-only, single frame)
- `0x11`: P-frame (delta from previous)
- `0x12`: GOP unified (3D DWT, multiple frames)
- `0x24`: TAD audio (DWT-based audio codec)
- `0xF0`: Loop point start
- `0xFC`: GOP sync (frame count marker)
- `0xFD`: Timecode metadata

## Performance Notes

### Threading Model
- Library manages internal thread pool when `num_threads > 0`
- GOP encoding is parallelized across worker threads
- For CLI tools: use `num_threads=0` (single-threaded) to avoid double-threading with external parallelism
- For library integration: use `num_threads=-1` or explicit count for optimal performance

### Memory Usage
- Each encoder context allocates:
  - GOP buffer: `gop_size × width × height × 3` bytes (RGB frames)
  - DWT coefficients: `~width × height × 12` bytes per channel
  - Thread pool: `num_threads × (GOP buffer + workspace)`
- Typical 1920×1080 encoder with GOP=24: ~180 MB per context

### Encoding Speed
- Single-threaded: 10-15 fps (1920×1080 on modern CPU)
- Multi-threaded (4 threads): 30-40 fps
- GOP size affects latency: larger GOP = higher latency, better compression

## Integration with TAD Audio

TAV files typically include TAD-compressed audio. Link with both libraries:

```c
#include "tav_encoder_lib.h"
#include "encoder_tad.h"

// Encode video frame
tav_encoder_encode_frame(video_ctx, rgb_frame, pts, &video_packet);

// Encode audio chunk (32kHz stereo, float samples)
tad32_encode_chunk(audio_ctx, pcm_samples, num_samples, &audio_data, &audio_size);

// Mux both into TAV file (interleave by frame PTS)
```

## Error Handling

All functions return error codes and set error message accessible via `tav_encoder_get_error()`:

```c
if (tav_encoder_encode_frame(ctx, frame, pts, &packet) < 0) {
    fprintf(stderr, "Encoding failed: %s\n", tav_encoder_get_error(ctx));
    // Handle error
}
```

## Limitations

- Maximum resolution: 8192×8192
- GOP size: 1-48 frames
- Single-tile encoding only (no spatial tiling)
- Requires even width and height

## License

Part of the TSVM project.

## See Also

- `include/tav_encoder_lib.h` - Complete API documentation
- `src/encoder_tav.c` - CLI reference implementation
- `lib/libtadenc/` - TAD audio encoder library
