/**
 * TAV Encoder Library - Public API
 *
 * High-level interface for encoding video using the TSVM Advanced Video (TAV) codec.
 * Supports GOP-based encoding with internal multi-threading for optimal performance.
 *
 * Created by CuriousTorvald and Claude on 2025-12-03.
 */

#ifndef TAV_ENCODER_LIB_H
#define TAV_ENCODER_LIB_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// =============================================================================
// Opaque Encoder Context
// =============================================================================

/**
 * TAV encoder context - opaque to users.
 * Created with tav_encoder_create(), freed with tav_encoder_free().
 */
typedef struct tav_encoder_context tav_encoder_context_t;

// =============================================================================
// Configuration Structures
// =============================================================================

/**
 * Video encoding parameters.
 */
typedef struct {
    // === Video Dimensions ===
    int width;                    // Frame width (must be even)
    int height;                   // Frame height (must be even)
    int fps_num;                  // Framerate numerator (e.g., 60 for 60fps)
    int fps_den;                  // Framerate denominator (e.g., 1 for 60/1)

    // === Wavelet Configuration ===
    int wavelet_type;             // Spatial wavelet: 0=CDF 5/3, 1=CDF 9/7 (default), 2=CDF 13/7, 16=DD-4, 255=Haar
    int temporal_wavelet;         // Temporal wavelet: 0=Haar, 1=CDF 5/3 (default for smooth motion)
    int decomp_levels;            // Spatial DWT levels (0=auto, typically 6)
    int temporal_levels;          // Temporal DWT levels (0=auto, typically 2 for 8-frame GOPs)

    // === Color Space ===
    int channel_layout;           // 0=YCoCg-R (default), 1=ICtCp (for HDR/BT.2100 sources)
    int perceptual_tuning;        // 1=enable HVS perceptual quantization (default), 0=uniform

    // === GOP Configuration ===
    int enable_temporal_dwt;      // 1=enable 3D DWT GOP encoding (default), 0=intra-only I-frames
    int gop_size;                 // Frames per GOP (8, 16, or 24; 0=auto based on framerate)
    int enable_two_pass;          // 1=enable two-pass with scene change detection (default), 0=single-pass

    // === Quality Control ===
    int quality_level;
    int quality_y;                // Luma quality (0-5, default: 3)
    int quality_co;               // Orange chrominance quality (0-5, default: 3)
    int quality_cg;               // Green chrominance quality (0-5, default: 3)
    int dead_zone_threshold;      // Dead-zone quantization threshold (0=disabled, 1-10 typical)

    // === Entropy Coding ===
    int entropy_coder;            // 0=Twobitmap (default), 1=EZBC (better for high-quality)
    int zstd_level;               // Zstd compression level (3-22, default: 7)

    // === Multi-threading ===
    int num_threads;              // Worker threads (0=single-threaded, -1=auto, 1-16=explicit)

    // === Encoder Presets ===
    int encoder_preset;           // Preset flags: 0x01=sports (finer temporal quant), 0x02=anime (disable grain)

    // === Advanced Options ===
    int verbose;                  // 1=enable debug output, 0=quiet (default)
    int monoblock;                // 1=single tile encoding (always 1 for current implementation)

} tav_encoder_params_t;

/**
 * Initialize encoder parameters with default values.
 *
 * @param params  Parameter structure to initialize
 * @param width   Frame width
 * @param height  Frame height
 */
void tav_encoder_params_init(tav_encoder_params_t *params, int width, int height);

/**
 * Encoder output packet.
 * Contains encoded video or audio data.
 */
typedef struct {
    uint8_t *data;                // Packet data (owned by encoder, valid until next encode/flush)
    size_t size;                  // Packet size in bytes
    uint8_t packet_type;          // TAV packet type (0x10=I-frame, 0x12=GOP, 0x24=audio, etc.)
    int frame_number;             // Frame number (for video packets)
    int is_video;                 // 1=video packet, 0=audio packet
} tav_encoder_packet_t;

// =============================================================================
// Encoder Lifecycle
// =============================================================================

/**
 * Create TAV encoder context.
 *
 * Allocates internal buffers, initializes thread pool (if multi-threading enabled),
 * and prepares encoder for frame submission.
 *
 * @param params  Encoder parameters (copied internally)
 * @return        Encoder context, or NULL on failure
 */
tav_encoder_context_t *tav_encoder_create(const tav_encoder_params_t *params);

/**
 * Free TAV encoder context.
 *
 * Shuts down thread pool, frees all buffers and resources.
 * Any unflushed frames in the GOP buffer will be lost.
 *
 * @param ctx  Encoder context
 */
void tav_encoder_free(tav_encoder_context_t *ctx);

/**
 * Get last error message.
 *
 * @param ctx  Encoder context
 * @return     Error message string (valid until next encode operation)
 */
const char *tav_encoder_get_error(tav_encoder_context_t *ctx);

/**
 * Get encoder parameters (with calculated values).
 * After context creation, params will contain actual values used
 * (e.g., auto-calculated decomp_levels, gop_size).
 *
 * @param ctx     Encoder context
 * @param params  Output parameters structure
 */
void tav_encoder_get_params(tav_encoder_context_t *ctx, tav_encoder_params_t *params);

/**
 * DEBUG: Validate encoder context integrity
 * Returns 1 if context appears valid, 0 otherwise
 */
int tav_encoder_validate_context(tav_encoder_context_t *ctx);

// =============================================================================
// Video Encoding
// =============================================================================

/**
 * Encode a single RGB24 frame.
 *
 * Frames are buffered internally until a GOP is full, then encoded and returned.
 * For GOP encoding: returns NULL until GOP is complete.
 * For intra-only: returns packet immediately.
 *
 * Thread-safety: NOT thread-safe. Caller must serialize calls to encode_frame().
 *
 * @param ctx           Encoder context
 * @param rgb_frame     RGB24 frame data (planar: [R...][G...][B...]), width×height×3 bytes
 * @param frame_pts     Presentation timestamp (frame number or time)
 * @param packet        Output packet pointer (NULL if GOP not yet complete)
 * @return              1 if packet ready, 0 if buffering for GOP, -1 on error
 */
int tav_encoder_encode_frame(tav_encoder_context_t *ctx,
                              const uint8_t *rgb_frame,
                              int64_t frame_pts,
                              tav_encoder_packet_t **packet);

/**
 * Flush encoder and encode any remaining buffered frames.
 *
 * Call at end of encoding to output final GOP (even if not full).
 * Returns packets one at a time through repeated calls.
 *
 * @param ctx     Encoder context
 * @param packet  Output packet pointer (NULL when no more packets)
 * @return        1 if packet ready, 0 if no more packets, -1 on error
 */
int tav_encoder_flush(tav_encoder_context_t *ctx,
                      tav_encoder_packet_t **packet);

/**
 * Encode a complete GOP (Group of Pictures) directly.
 *
 * This function is STATELESS and THREAD-SAFE with separate contexts.
 * Perfect for multithreaded encoding from CLI:
 * - Each thread creates its own encoder context
 * - Each thread calls encode_gop() with a batch of frames
 * - No shared state, no locking needed
 *
 * Example multithreaded usage:
 * ```c
 * // Worker thread function
 * void* worker(void* arg) {
 *     work_item_t* item = (work_item_t*)arg;
 *
 *     // Create thread-local encoder context
 *     tav_encoder_context_t* ctx = tav_encoder_create(&shared_params);
 *
 *     // Encode this GOP
 *     tav_encoder_packet_t* packet;
 *     tav_encoder_encode_gop(ctx, item->frames, item->num_frames,
 *                            item->frame_numbers, &packet);
 *
 *     // Store packet in output queue
 *     queue_push(output_queue, packet);
 *
 *     tav_encoder_free(ctx);
 *     return NULL;
 * }
 * ```
 *
 * @param ctx            Encoder context (one per thread)
 * @param rgb_frames     Array of RGB24 frames [frame][width*height*3]
 * @param num_frames     Number of frames in GOP (1-24)
 * @param frame_numbers  Frame indices for timecodes (can be NULL)
 * @param packet         Output packet pointer
 * @return               1 if packet ready, -1 on error
 */
int tav_encoder_encode_gop(tav_encoder_context_t *ctx,
                            const uint8_t **rgb_frames,
                            int num_frames,
                            const int *frame_numbers,
                            tav_encoder_packet_t **packet);

/**
 * Free a packet returned by encode_frame(), flush(), or encode_gop().
 *
 * @param packet  Packet to free (can be NULL)
 */
void tav_encoder_free_packet(tav_encoder_packet_t *packet);

// =============================================================================
// Audio Encoding (Optional)
// =============================================================================

/**
 * Encode audio samples (TAD codec).
 *
 * Audio is encoded synchronously and returned immediately.
 * For TAV muxing: interleave audio packets with video packets by frame PTS.
 *
 * @param ctx              Encoder context
 * @param pcm_samples      PCM32f stereo samples (interleaved: L,R,L,R,...), num_samples×2 floats
 * @param num_samples      Number of samples per channel
 * @param packet           Output packet pointer
 * @return                 1 if packet ready, -1 on error
 */
int tav_encoder_encode_audio(tav_encoder_context_t *ctx,
                              const float *pcm_samples,
                              size_t num_samples,
                              tav_encoder_packet_t **packet);

// =============================================================================
// Statistics and Info
// =============================================================================

/**
 * Get encoding statistics.
 */
typedef struct {
    int64_t frames_encoded;       // Total frames encoded
    int64_t gops_encoded;         // Total GOPs encoded
    size_t total_bytes;           // Total bytes output (video + audio)
    size_t video_bytes;           // Video bytes
    size_t audio_bytes;           // Audio bytes
    double avg_bitrate_kbps;      // Average bitrate (kbps)
    double encoding_fps;          // Encoding speed (frames/sec)
} tav_encoder_stats_t;

/**
 * Get encoding statistics.
 *
 * @param ctx    Encoder context
 * @param stats  Output statistics structure
 */
void tav_encoder_get_stats(tav_encoder_context_t *ctx, tav_encoder_stats_t *stats);

// =============================================================================
// TAV Packet Types (for reference)
// =============================================================================

#define TAV_PACKET_IFRAME        0x10  // I-frame (intra-only, single frame)
#define TAV_PACKET_PFRAME        0x11  // P-frame (delta from previous)
#define TAV_PACKET_GOP_UNIFIED   0x12  // GOP unified (3D DWT, multiple frames)
#define TAV_PACKET_AUDIO_TAD     0x24  // TAD audio (DWT-based perceptual codec)
#define TAV_PACKET_AUDIO_PCM8    0x20  // PCM8 audio (legacy)
#define TAV_PACKET_LOOP_START    0xF0  // Loop point start (no payload)
#define TAV_PACKET_GOP_SYNC      0xFC  // GOP sync (frame count marker)
#define TAV_PACKET_TIMECODE      0xFD  // Timecode metadata

#ifdef __cplusplus
}
#endif

#endif // TAV_ENCODER_LIB_H
