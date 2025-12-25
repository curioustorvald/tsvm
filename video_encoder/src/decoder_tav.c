/**
 * TAV Decoder CLI - Reference Implementation using libtavdec and libtaddec
 *
 * Complete reference decoder with all features:
 * - Full command-line argument support
 * - TAV file format parsing (header + packets)
 * - Video decoding via libtavdec (I-frames, GOPs)
 * - Audio decoding via libtaddec (TAD32 to PCMu8)
 * - FFmpeg integration for output (FFV1/rawvideo + audio muxing)
 * - Progress reporting and statistics
 *
 * This is the official CLI implementation using libtavdec/libtaddec libraries.
 * Reduced from ~3,500 lines monolithic to ~1,000 lines while preserving all features.
 *
 * Created by CuriousTorvald and Claude on 2025-12-07.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <getopt.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>
#include <signal.h>
#include <pthread.h>
#include <limits.h>

#include "tav_video_decoder.h"
#include "decoder_tad.h"

// =============================================================================
// Constants
// =============================================================================

#define DECODER_VENDOR_STRING "Decoder-TAV 20251207 (libtavdec)"
#define TAV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x56"  // "\x1FTSVMTAV"
#define TAP_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x50"  // "\x1FTSVMTAP" (still picture)
#define MAX_PATH 4096

// TAV packet types
#define TAV_PACKET_IFRAME          0x10
#define TAV_PACKET_PFRAME          0x11
#define TAV_PACKET_GOP_UNIFIED     0x12
#define TAV_PACKET_AUDIO_MP2       0x20
#define TAV_PACKET_AUDIO_PCM8      0x21
#define TAV_PACKET_AUDIO_TAD       0x24
#define TAV_PACKET_SUBTITLE        0x30
#define TAV_PACKET_SUBTITLE_TC     0x31
#define TAV_PACKET_AUDIO_TRACK     0x40
#define TAV_PACKET_EXTENDED_HDR    0xEF
#define TAV_PACKET_SCREEN_MASK     0xF2
#define TAV_PACKET_GOP_SYNC        0xFC
#define TAV_PACKET_TIMECODE        0xFD
#define TAV_PACKET_SYNC_NTSC       0xFE
#define TAV_PACKET_SYNC            0xFF

// Threading constants
#define MAX_DECODE_THREADS 16
#define DECODE_SLOT_PENDING     0
#define DECODE_SLOT_PROCESSING  1
#define DECODE_SLOT_DONE        2

// =============================================================================
// GOP Decode Job Structure (for multithreading)
// =============================================================================

typedef struct {
    int job_id;
    volatile int status;  // DECODE_SLOT_*

    // Input (compressed data read from file)
    uint8_t *compressed_data;
    uint32_t compressed_size;
    int gop_size;

    // Output (decoded frames)
    uint8_t **frames;
    int frames_allocated;
    int decode_result;

} gop_decode_job_t;

// =============================================================================
// Audio Decode Job Structure (for multithreading)
// =============================================================================

typedef struct {
    long file_offset;          // File position for reading
    uint32_t payload_size;     // Size of compressed audio data
    uint16_t sample_count;     // Expected sample count
    uint8_t packet_type;       // TAD_PACKET_AUDIO_TAD or TAD_PACKET_AUDIO_PCM8

    // Output (decoded PCM data)
    uint8_t *decoded_pcm;      // Stereo PCMu8 output
    size_t decoded_samples;    // Actual samples decoded
    volatile int status;       // DECODE_SLOT_*
} audio_decode_job_t;

// =============================================================================
// TAV Header Structure (32 bytes)
// =============================================================================

typedef struct {
    uint8_t magic[8];
    uint8_t version;
    uint16_t width;
    uint16_t height;
    uint8_t fps;
    uint32_t total_frames;
    uint8_t wavelet_filter;
    uint8_t decomp_levels;
    uint8_t quantiser_y;
    uint8_t quantiser_co;
    uint8_t quantiser_cg;
    uint8_t extra_flags;
    uint8_t video_flags;
    uint8_t encoder_quality;
    uint8_t channel_layout;
    uint8_t entropy_coder;
    uint8_t encoder_preset;
    uint8_t reserved;
    uint8_t device_orientation;
    uint8_t file_role;
} __attribute__((packed)) tav_header_t;

// =============================================================================
// Decoder Context
// =============================================================================

typedef struct {
    // Input/output
    char *input_file;
    char *output_file;
    FILE *input_fp;

    // TAV header info
    tav_header_t header;
    int perceptual_mode;
    int interlaced;        // 1 if video is interlaced (from video_flags bit 0)
    int decode_height;     // Actual decode height (half of header.height when interlaced)

    // Video decoder context
    tav_video_context_t *video_ctx;

    // FFmpeg integration
    pid_t ffmpeg_pid;
    FILE *video_pipe;
    char *audio_temp_file;
    FILE *audio_temp_fp;

    // Frame buffers
    uint8_t **gop_frames;
    int gop_frames_allocated;

    // Statistics
    uint64_t frames_decoded;
    uint64_t gops_decoded;
    uint64_t audio_samples_decoded;
    uint64_t bytes_read;
    time_t start_time;

    // Options
    int verbose;
    int decode_limit;       // Max frames to decode (0=all)
    int output_raw;         // Output raw video instead of FFV1
    int no_audio;           // Skip audio decoding
    int dump_packets;       // Debug: dump packet info

    // Still image (TAP) mode
    int is_still_image;     // 1 if input is a still picture (TAP format)
    int output_tga;         // 1 for TGA output, 0 for PNG (default)

    // Extended framerate support (XFPS)
    int fps_num;            // Framerate numerator (from header or XFPS extended header)
    int fps_den;            // Framerate denominator (1 for standard, 1001 for NTSC, or from XFPS)

    // Threading support (video decoding)
    int num_threads;
    int num_slots;
    gop_decode_job_t *slots;
    tav_video_context_t **worker_video_ctx;  // Per-thread decoder contexts
    pthread_t *worker_threads;
    pthread_mutex_t mutex;
    pthread_cond_t cond_job_available;
    pthread_cond_t cond_slot_free;
    volatile int threads_should_exit;
    volatile int next_write_slot;      // Next slot to write to FFmpeg
    volatile int next_read_slot;       // Next slot for reading from file
    volatile int jobs_submitted;
    volatile int jobs_completed;

    // Audio decoding (pass 1 multithreading)
    audio_decode_job_t *audio_jobs;
    int audio_job_count;
    int audio_job_capacity;
    pthread_t *audio_worker_threads;
    int num_audio_threads;
    pthread_mutex_t audio_mutex;
    pthread_cond_t audio_cond_job_available;
    volatile int audio_threads_should_exit;
    volatile int next_audio_job;       // Next job for worker threads to process
    volatile int next_audio_write;     // Next job to write to temp file

} decoder_context_t;

// =============================================================================
// TAV Header Parsing
// =============================================================================

static int read_tav_header(decoder_context_t *ctx) {
    // Read raw header bytes
    uint8_t header_bytes[32];
    if (fread(header_bytes, 1, 32, ctx->input_fp) != 32) {
        fprintf(stderr, "Error: Failed to read TAV header\n");
        return -1;
    }

    // Verify magic (accept both TAV and TAP)
    if (memcmp(header_bytes, TAV_MAGIC, 8) == 0) {
        ctx->is_still_image = 0;
    } else if (memcmp(header_bytes, TAP_MAGIC, 8) == 0) {
        ctx->is_still_image = 1;
    } else {
        fprintf(stderr, "Error: Invalid TAV/TAP magic (not a TAV/TAP file)\n");
        return -1;
    }

    // Parse header fields manually (avoid packing issues)
    memcpy(ctx->header.magic, header_bytes, 8);
    ctx->header.version = header_bytes[8];
    ctx->header.width = header_bytes[9] | (header_bytes[10] << 8);
    ctx->header.height = header_bytes[11] | (header_bytes[12] << 8);
    ctx->header.fps = header_bytes[13];
    ctx->header.total_frames = header_bytes[14] | (header_bytes[15] << 8) |
                               (header_bytes[16] << 16) | (header_bytes[17] << 24);
    ctx->header.wavelet_filter = header_bytes[18];
    ctx->header.decomp_levels = header_bytes[19];
    ctx->header.quantiser_y = header_bytes[20];
    ctx->header.quantiser_co = header_bytes[21];
    ctx->header.quantiser_cg = header_bytes[22];
    ctx->header.extra_flags = header_bytes[23];
    ctx->header.video_flags = header_bytes[24];
    ctx->header.encoder_quality = header_bytes[25];
    ctx->header.channel_layout = header_bytes[26];
    ctx->header.entropy_coder = header_bytes[27];
    ctx->header.encoder_preset = header_bytes[28];
    ctx->header.reserved = header_bytes[29];
    ctx->header.device_orientation = header_bytes[30];
    ctx->header.file_role = header_bytes[31];

    ctx->bytes_read += 32;

    // Determine perceptual mode from version
    // Versions 5, 6, 13, 14 = perceptual; 3, 4, 11, 12 = uniform
    int base_version = ctx->header.version & 0x07;  // Remove temporal wavelet flag
    ctx->perceptual_mode = (base_version == 5 || base_version == 6);

    // Detect interlaced mode from video_flags bit 0
    ctx->interlaced = (ctx->header.video_flags & 0x01) ? 1 : 0;

    // Calculate decode height: half of header height for interlaced video
    // The header stores the full display height, but encoded frames are half-height
    if (ctx->interlaced) {
        ctx->decode_height = ctx->header.height / 2;
    } else {
        ctx->decode_height = ctx->header.height;
    }

    // Initialize fps_num and fps_den from header
    // If header.fps == 0xFF, the actual framerate is in the XFPS extended header entry
    // If header.fps == 0x00, this is a still image
    // Otherwise, fps_num = header.fps and fps_den is 1 (or 1001 for NTSC if video_flags bit 1 is set)
    if (ctx->header.fps == 0xFF) {
        // Will be set from XFPS extended header
        ctx->fps_num = 0;
        ctx->fps_den = 1;
    } else if (ctx->header.fps == 0x00) {
        // Still image
        ctx->fps_num = 0;
        ctx->fps_den = 1;
    } else {
        ctx->fps_num = ctx->header.fps;
        ctx->fps_den = (ctx->header.video_flags & 0x02) ? 1001 : 1;
    }

    if (ctx->verbose) {
        printf("=== %s Header ===\n", ctx->is_still_image ? "TAP" : "TAV");
        printf("  Format: %s\n", ctx->is_still_image ? "Still Picture" : "Video");
        printf("  Version: %d\n", ctx->header.version);
        printf("  Resolution: %dx%d\n", ctx->header.width, ctx->header.height);
        if (ctx->interlaced) {
            printf("  Interlaced: yes (decode height: %d)\n", ctx->decode_height);
        }
        if (!ctx->is_still_image) {
            if (ctx->header.fps == 0xFF) {
                printf("  FPS: (extended - see XFPS)\n");
            } else {
                printf("  FPS: %d\n", ctx->header.fps);
            }
            printf("  Total frames: %u\n", ctx->header.total_frames);
        }
        printf("  Wavelet filter: %d\n", ctx->header.wavelet_filter);
        printf("  Decomp levels: %d\n", ctx->header.decomp_levels);
        printf("  Quantisers: Y=%d, Co=%d, Cg=%d\n",
               ctx->header.quantiser_y, ctx->header.quantiser_co, ctx->header.quantiser_cg);
        printf("  Perceptual mode: %s\n", ctx->perceptual_mode ? "yes" : "no");
        printf("  Entropy coder: %s\n", ctx->header.entropy_coder ? "EZBC" : "Twobitmap");
        printf("  Encoder preset: 0x%02X\n", ctx->header.encoder_preset);
        if (!ctx->is_still_image) {
            printf("  Has audio: %s\n", (ctx->header.extra_flags & 0x01) ? "yes" : "no");
        }
        printf("==================\n\n");
    }

    return 0;
}

/**
 * Scan for XFPS extended header entry if header.fps == 0xFF.
 * Must be called after read_tav_header() while file position is at start of packets.
 * Will restore file position after scanning.
 */
static void scan_for_xfps(decoder_context_t *ctx) {
    if (ctx->header.fps != 0xFF) {
        // No need to scan for XFPS
        return;
    }

    long start_pos = ftell(ctx->input_fp);

    // Scan packets looking for extended header
    while (!feof(ctx->input_fp)) {
        uint8_t packet_type;
        if (fread(&packet_type, 1, 1, ctx->input_fp) != 1) break;

        if (packet_type == TAV_PACKET_EXTENDED_HDR) {
            // Parse extended header looking for XFPS
            uint16_t num_pairs;
            if (fread(&num_pairs, 2, 1, ctx->input_fp) != 1) break;

            for (int i = 0; i < num_pairs; i++) {
                char key[5] = {0};
                uint8_t value_type;

                if (fread(key, 1, 4, ctx->input_fp) != 4) break;
                if (fread(&value_type, 1, 1, ctx->input_fp) != 1) break;

                if (value_type == 0x10) {  // Bytes type
                    uint16_t length;
                    if (fread(&length, 2, 1, ctx->input_fp) != 1) break;

                    if (strncmp(key, "XFPS", 4) == 0 && length < 32) {
                        // Found XFPS - parse it
                        char xfps_str[32] = {0};
                        if (fread(xfps_str, 1, length, ctx->input_fp) != length) break;
                        xfps_str[length] = '\0';

                        int num, den;
                        if (sscanf(xfps_str, "%d/%d", &num, &den) == 2) {
                            ctx->fps_num = num;
                            ctx->fps_den = den;
                            if (ctx->verbose) {
                                printf("  XFPS: %d/%d (%.3f fps)\n", num, den, (double)num / den);
                            }
                        }
                        // Found XFPS, done scanning
                        goto done;
                    } else {
                        // Skip this value
                        fseek(ctx->input_fp, length, SEEK_CUR);
                    }
                } else if (value_type == 0x04) {  // Int64
                    fseek(ctx->input_fp, 8, SEEK_CUR);
                } else if (value_type <= 0x04) {  // Other int types
                    int sizes[] = {2, 3, 4, 6, 8};
                    fseek(ctx->input_fp, sizes[value_type], SEEK_CUR);
                }
            }
            // Extended header parsed, done scanning (XFPS not found)
            break;
        } else if (packet_type == TAV_PACKET_TIMECODE) {
            fseek(ctx->input_fp, 8, SEEK_CUR);
        } else if (packet_type == TAV_PACKET_SYNC || packet_type == TAV_PACKET_SYNC_NTSC) {
            // No payload
        } else {
            // Reached a non-metadata packet, stop scanning
            break;
        }
    }

done:
    // Restore file position
    fseek(ctx->input_fp, start_pos, SEEK_SET);
}

// =============================================================================
// FFmpeg Integration
// =============================================================================

static int spawn_ffmpeg(decoder_context_t *ctx) {
    int video_pipe_fd[2];

    // Create pipe for video data
    if (pipe(video_pipe_fd) < 0) {
        fprintf(stderr, "Error: Failed to create video pipe\n");
        return -1;
    }

    ctx->ffmpeg_pid = fork();

    if (ctx->ffmpeg_pid < 0) {
        fprintf(stderr, "Error: Failed to fork FFmpeg process\n");
        close(video_pipe_fd[0]);
        close(video_pipe_fd[1]);
        return -1;
    }

    if (ctx->ffmpeg_pid == 0) {
        // Child process - execute FFmpeg
        close(video_pipe_fd[1]);  // Close write end

        // For interlaced video: input is half-height fields, output is full-height interlaced
        // For progressive video: input and output are both full-height
        char video_size[32];
        char framerate[32];
        snprintf(video_size, sizeof(video_size), "%dx%d", ctx->header.width, ctx->decode_height);
        // Use fps_num/fps_den for extended framerates (XFPS)
        if (ctx->fps_den == 1) {
            snprintf(framerate, sizeof(framerate), "%d", ctx->fps_num);
        } else {
            snprintf(framerate, sizeof(framerate), "%d/%d", ctx->fps_num, ctx->fps_den);
        }

        // Redirect video pipe to fd 3
        dup2(video_pipe_fd[0], 3);
        close(video_pipe_fd[0]);

        if (ctx->interlaced) {
            // Interlaced mode: merge separate fields into interlaced frames
            // setfield=tff marks each frame as top-field, weave combines consecutive fields
            // into full-height interlaced frames at half framerate
            if (ctx->output_raw) {
                // Raw video output (no compression)
                execl("/usr/bin/ffmpeg", "ffmpeg",
                      "-f", "rawvideo",
                      "-pixel_format", "rgb24",
                      "-video_size", video_size,
                      "-framerate", framerate,
                      "-i", "pipe:3",
                      "-f", "u8",
                      "-ar", "32000",
                      "-ac", "2",
                      "-i", ctx->audio_temp_file,
                      "-vf", "setfield=tff,weave",
                      "-field_order", "tt",
                      "-c:v", "rawvideo",
                      "-pixel_format", "rgb24",
                      "-c:a", "pcm_u8",
                      "-f", "matroska",
                      ctx->output_file,
                      "-y",
                      "-v", "warning",
                      (char*)NULL);
            } else {
                // FFV1 output (lossless compression) with interlaced flag
                execl("/usr/bin/ffmpeg", "ffmpeg",
                      "-f", "rawvideo",
                      "-pixel_format", "rgb24",
                      "-video_size", video_size,
                      "-framerate", framerate,
                      "-i", "pipe:3",
                      "-f", "u8",
                      "-ar", "32000",
                      "-ac", "2",
                      "-i", ctx->audio_temp_file,
                      "-vf", "setfield=tff,weave",
                      "-field_order", "tt",
                      "-color_range", "2",
                      "-c:v", "ffv1",
                      "-level", "3",
                      "-coder", "1",
                      "-context", "1",
                      "-g", "1",
                      "-slices", "24",
                      "-slicecrc", "1",
                      "-pixel_format", "rgb24",
                      "-color_range", "2",
                      "-c:a", "pcm_u8",
                      "-f", "matroska",
                      ctx->output_file,
                      "-y",
                      "-v", "warning",
                      (char*)NULL);
            }
        } else {
            // Progressive mode - simple passthrough
            if (ctx->output_raw) {
                // Raw video output (no compression)
                execl("/usr/bin/ffmpeg", "ffmpeg",
                      "-f", "rawvideo",
                      "-pixel_format", "rgb24",
                      "-video_size", video_size,
                      "-framerate", framerate,
                      "-i", "pipe:3",
                      "-f", "u8",
                      "-ar", "32000",
                      "-ac", "2",
                      "-i", ctx->audio_temp_file,
                      "-c:v", "rawvideo",
                      "-pixel_format", "rgb24",
                      "-c:a", "pcm_u8",
                      "-f", "matroska",
                      ctx->output_file,
                      "-y",
                      "-v", "warning",
                      (char*)NULL);
            } else {
                // FFV1 output (lossless compression)
                execl("/usr/bin/ffmpeg", "ffmpeg",
                      "-f", "rawvideo",
                      "-pixel_format", "rgb24",
                      "-video_size", video_size,
                      "-framerate", framerate,
                      "-i", "pipe:3",
                      "-f", "u8",
                      "-ar", "32000",
                      "-ac", "2",
                      "-i", ctx->audio_temp_file,
                      "-color_range", "2",
                      "-c:v", "ffv1",
                      "-level", "3",
                      "-coder", "1",
                      "-context", "1",
                      "-g", "1",
                      "-slices", "24",
                      "-slicecrc", "1",
                      "-pixel_format", "rgb24",
                      "-color_range", "2",
                      "-c:a", "pcm_u8",
                      "-f", "matroska",
                      ctx->output_file,
                      "-y",
                      "-v", "warning",
                      (char*)NULL);
            }
        }

        fprintf(stderr, "Error: Failed to execute FFmpeg\n");
        exit(1);
    }

    // Parent process
    close(video_pipe_fd[0]);  // Close read end

    ctx->video_pipe = fdopen(video_pipe_fd[1], "wb");
    if (!ctx->video_pipe) {
        fprintf(stderr, "Error: Failed to open video pipe for writing\n");
        kill(ctx->ffmpeg_pid, SIGTERM);
        return -1;
    }

    return 0;
}

// =============================================================================
// Multithreading Support
// =============================================================================

// Worker thread function - decodes GOPs in parallel
static void *decoder_worker_thread(void *arg) {
    decoder_context_t *ctx = (decoder_context_t *)arg;

    // Get thread index by finding our thread ID in the array
    int thread_idx = -1;
    pthread_t self = pthread_self();
    for (int i = 0; i < ctx->num_threads; i++) {
        if (pthread_equal(ctx->worker_threads[i], self)) {
            thread_idx = i;
            break;
        }
    }
    if (thread_idx < 0) thread_idx = 0;  // Fallback

    tav_video_context_t *my_video_ctx = ctx->worker_video_ctx[thread_idx];

    while (1) {
        pthread_mutex_lock(&ctx->mutex);

        // Find a pending slot to work on
        int slot_idx = -1;
        while (slot_idx < 0 && !ctx->threads_should_exit) {
            for (int i = 0; i < ctx->num_slots; i++) {
                if (ctx->slots[i].status == DECODE_SLOT_PENDING &&
                    ctx->slots[i].compressed_data != NULL) {
                    slot_idx = i;
                    ctx->slots[i].status = DECODE_SLOT_PROCESSING;
                    break;
                }
            }
            if (slot_idx < 0 && !ctx->threads_should_exit) {
                pthread_cond_wait(&ctx->cond_job_available, &ctx->mutex);
            }
        }

        if (ctx->threads_should_exit && slot_idx < 0) {
            pthread_mutex_unlock(&ctx->mutex);
            break;
        }

        pthread_mutex_unlock(&ctx->mutex);

        if (slot_idx < 0) continue;

        gop_decode_job_t *job = &ctx->slots[slot_idx];

        // Decode GOP using our thread's decoder context
        job->decode_result = tav_video_decode_gop(
            my_video_ctx,
            job->compressed_data,
            job->compressed_size,
            job->gop_size,
            job->frames
        );

        // Free compressed data after decoding
        free(job->compressed_data);
        job->compressed_data = NULL;

        // Mark as done
        pthread_mutex_lock(&ctx->mutex);
        job->status = DECODE_SLOT_DONE;
        ctx->jobs_completed++;
        pthread_cond_broadcast(&ctx->cond_slot_free);
        pthread_mutex_unlock(&ctx->mutex);
    }

    return NULL;
}

static int init_decoder_threads(decoder_context_t *ctx) {
    if (ctx->num_threads <= 0) {
        return 0;  // Single-threaded mode
    }

    // Limit threads
    if (ctx->num_threads > MAX_DECODE_THREADS) {
        ctx->num_threads = MAX_DECODE_THREADS;
    }

    // Number of slots = threads + 2 for pipelining
    ctx->num_slots = ctx->num_threads + 2;

    // Allocate slots
    ctx->slots = calloc(ctx->num_slots, sizeof(gop_decode_job_t));
    if (!ctx->slots) {
        fprintf(stderr, "Error: Failed to allocate decode slots\n");
        return -1;
    }

    // Pre-allocate frame buffers for each slot (assuming max GOP size of 32)
    // Use decode_height for interlaced video (half of header height)
    size_t frame_size = ctx->header.width * ctx->decode_height * 3;
    int max_gop_size = 32;

    for (int i = 0; i < ctx->num_slots; i++) {
        ctx->slots[i].job_id = -1;
        ctx->slots[i].status = DECODE_SLOT_DONE;  // Available
        ctx->slots[i].frames = malloc(max_gop_size * sizeof(uint8_t*));
        if (!ctx->slots[i].frames) {
            fprintf(stderr, "Error: Failed to allocate frame pointers for slot %d\n", i);
            return -1;
        }
        for (int j = 0; j < max_gop_size; j++) {
            ctx->slots[i].frames[j] = malloc(frame_size);
            if (!ctx->slots[i].frames[j]) {
                fprintf(stderr, "Error: Failed to allocate frame buffer for slot %d frame %d\n", i, j);
                return -1;
            }
        }
        ctx->slots[i].frames_allocated = max_gop_size;
    }

    // Create per-thread video decoder contexts
    ctx->worker_video_ctx = malloc(ctx->num_threads * sizeof(tav_video_context_t*));
    if (!ctx->worker_video_ctx) {
        fprintf(stderr, "Error: Failed to allocate worker video contexts\n");
        return -1;
    }

    tav_video_params_t video_params = {
        .width = ctx->header.width,
        .height = ctx->decode_height,  // Use decode_height for interlaced video
        .decomp_levels = ctx->header.decomp_levels,
        .temporal_levels = 2,
        .wavelet_filter = ctx->header.wavelet_filter,
        .temporal_wavelet = 255,
        .entropy_coder = ctx->header.entropy_coder,
        .channel_layout = ctx->header.channel_layout,
        .perceptual_tuning = ctx->perceptual_mode,
        .quantiser_y = ctx->header.quantiser_y,
        .quantiser_co = ctx->header.quantiser_co,
        .quantiser_cg = ctx->header.quantiser_cg,
        .encoder_preset = ctx->header.encoder_preset,
        .monoblock = 1
    };

    for (int i = 0; i < ctx->num_threads; i++) {
        ctx->worker_video_ctx[i] = tav_video_create(&video_params);
        if (!ctx->worker_video_ctx[i]) {
            fprintf(stderr, "Error: Failed to create video context for thread %d\n", i);
            return -1;
        }
    }

    // Initialize synchronization primitives
    pthread_mutex_init(&ctx->mutex, NULL);
    pthread_cond_init(&ctx->cond_job_available, NULL);
    pthread_cond_init(&ctx->cond_slot_free, NULL);
    ctx->threads_should_exit = 0;
    ctx->next_write_slot = 0;
    ctx->next_read_slot = 0;
    ctx->jobs_submitted = 0;
    ctx->jobs_completed = 0;

    // Create worker threads
    ctx->worker_threads = malloc(ctx->num_threads * sizeof(pthread_t));
    if (!ctx->worker_threads) {
        fprintf(stderr, "Error: Failed to allocate worker threads\n");
        return -1;
    }

    for (int i = 0; i < ctx->num_threads; i++) {
        if (pthread_create(&ctx->worker_threads[i], NULL, decoder_worker_thread, ctx) != 0) {
            fprintf(stderr, "Error: Failed to create worker thread %d\n", i);
            return -1;
        }
    }

    if (ctx->verbose) {
        printf("Initialized %d decoder worker threads with %d slots\n",
               ctx->num_threads, ctx->num_slots);
    }

    return 0;
}

static void cleanup_decoder_threads(decoder_context_t *ctx) {
    if (ctx->num_threads <= 0) return;

    // Signal threads to exit
    pthread_mutex_lock(&ctx->mutex);
    ctx->threads_should_exit = 1;
    pthread_cond_broadcast(&ctx->cond_job_available);
    pthread_mutex_unlock(&ctx->mutex);

    // Wait for threads to finish
    for (int i = 0; i < ctx->num_threads; i++) {
        pthread_join(ctx->worker_threads[i], NULL);
    }
    free(ctx->worker_threads);
    ctx->worker_threads = NULL;

    // Free per-thread video contexts
    for (int i = 0; i < ctx->num_threads; i++) {
        tav_video_free(ctx->worker_video_ctx[i]);
    }
    free(ctx->worker_video_ctx);
    ctx->worker_video_ctx = NULL;

    // Free slots
    for (int i = 0; i < ctx->num_slots; i++) {
        if (ctx->slots[i].frames) {
            for (int j = 0; j < ctx->slots[i].frames_allocated; j++) {
                free(ctx->slots[i].frames[j]);
            }
            free(ctx->slots[i].frames);
        }
        if (ctx->slots[i].compressed_data) {
            free(ctx->slots[i].compressed_data);
        }
    }
    free(ctx->slots);
    ctx->slots = NULL;

    // Destroy sync primitives
    pthread_mutex_destroy(&ctx->mutex);
    pthread_cond_destroy(&ctx->cond_job_available);
    pthread_cond_destroy(&ctx->cond_slot_free);
}

// =============================================================================
// Frame Buffer Management
// =============================================================================

static int allocate_gop_frames(decoder_context_t *ctx, int gop_size) {
    if (ctx->gop_frames_allocated >= gop_size) {
        return 0;  // Already have enough
    }

    // Free existing if any
    if (ctx->gop_frames) {
        for (int i = 0; i < ctx->gop_frames_allocated; i++) {
            free(ctx->gop_frames[i]);
        }
        free(ctx->gop_frames);
    }

    // Allocate new
    ctx->gop_frames = malloc(gop_size * sizeof(uint8_t*));
    if (!ctx->gop_frames) {
        return -1;
    }

    size_t frame_size = ctx->header.width * ctx->header.height * 3;
    for (int i = 0; i < gop_size; i++) {
        ctx->gop_frames[i] = malloc(frame_size);
        if (!ctx->gop_frames[i]) {
            // Cleanup on failure
            for (int j = 0; j < i; j++) {
                free(ctx->gop_frames[j]);
            }
            free(ctx->gop_frames);
            ctx->gop_frames = NULL;
            return -1;
        }
    }

    ctx->gop_frames_allocated = gop_size;
    return 0;
}

// =============================================================================
// Still Image Output (TAP format)
// =============================================================================

/**
 * Write RGB24 frame to TGA file.
 * TGA format: uncompressed true-color image (type 2).
 */
static int write_tga_file(const char *filename, const uint8_t *rgb_data,
                          int width, int height) {
    FILE *fp = fopen(filename, "wb");
    if (!fp) {
        fprintf(stderr, "Error: Cannot create TGA file: %s\n", filename);
        return -1;
    }

    // TGA header (18 bytes)
    uint8_t header[18] = {0};
    header[2] = 2;  // Uncompressed true-color
    header[12] = width & 0xFF;
    header[13] = (width >> 8) & 0xFF;
    header[14] = height & 0xFF;
    header[15] = (height >> 8) & 0xFF;
    header[16] = 24;  // Bits per pixel
    header[17] = 0x20;  // Top-left origin

    fwrite(header, 1, 18, fp);

    // Write pixel data (convert RGB to BGR, flip vertically)
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            int src_idx = (y * width + x) * 3;
            uint8_t bgr[3] = {
                rgb_data[src_idx + 2],  // B
                rgb_data[src_idx + 1],  // G
                rgb_data[src_idx + 0]   // R
            };
            fwrite(bgr, 1, 3, fp);
        }
    }

    fclose(fp);
    return 0;
}

/**
 * Write RGB24 frame to PNG file using FFmpeg.
 */
static int write_png_file(const char *filename, const uint8_t *rgb_data,
                          int width, int height) {
    char cmd[MAX_PATH * 2];
    snprintf(cmd, sizeof(cmd),
             "ffmpeg -hide_banner -v quiet -f rawvideo -pix_fmt rgb24 "
             "-s %dx%d -i pipe:0 -y \"%s\"",
             width, height, filename);

    FILE *fp = popen(cmd, "w");
    if (!fp) {
        fprintf(stderr, "Error: Cannot start FFmpeg for PNG output\n");
        return -1;
    }

    size_t frame_size = width * height * 3;
    if (fwrite(rgb_data, 1, frame_size, fp) != frame_size) {
        fprintf(stderr, "Error: Failed to write frame data to FFmpeg\n");
        pclose(fp);
        return -1;
    }

    int result = pclose(fp);
    if (result != 0) {
        fprintf(stderr, "Error: FFmpeg failed to write PNG file\n");
        return -1;
    }

    return 0;
}

/**
 * Write decoded still image to file (PNG or TGA).
 */
static int write_still_image(decoder_context_t *ctx, const uint8_t *rgb_data) {
    int width = ctx->header.width;
    int height = ctx->decode_height;

    if (ctx->output_tga) {
        return write_tga_file(ctx->output_file, rgb_data, width, height);
    } else {
        return write_png_file(ctx->output_file, rgb_data, width, height);
    }
}

// =============================================================================
// Packet Processing
// =============================================================================

static int process_gop_packet(decoder_context_t *ctx) {
    // Read GOP size (1 byte)
    uint8_t gop_size;
    if (fread(&gop_size, 1, 1, ctx->input_fp) != 1) {
        fprintf(stderr, "Error: Failed to read GOP size\n");
        return -1;
    }
    ctx->bytes_read++;

    // Read compressed size (4 bytes)
    uint32_t compressed_size;
    if (fread(&compressed_size, 4, 1, ctx->input_fp) != 1) {
        fprintf(stderr, "Error: Failed to read GOP compressed size\n");
        return -1;
    }
    ctx->bytes_read += 4;

    if (ctx->dump_packets) {
        printf("  GOP: %d frames, %u bytes compressed\n", gop_size, compressed_size);
    }

    // Allocate frame buffers
    if (allocate_gop_frames(ctx, gop_size) < 0) {
        fprintf(stderr, "Error: Failed to allocate GOP frame buffers\n");
        return -1;
    }

    // Read compressed data
    uint8_t *compressed_data = malloc(compressed_size);
    if (!compressed_data) {
        fprintf(stderr, "Error: Failed to allocate compressed data buffer\n");
        return -1;
    }

    if (fread(compressed_data, 1, compressed_size, ctx->input_fp) != compressed_size) {
        fprintf(stderr, "Error: Failed to read GOP compressed data\n");
        free(compressed_data);
        return -1;
    }
    ctx->bytes_read += compressed_size;

    // Decode GOP using library
    int result = tav_video_decode_gop(ctx->video_ctx, compressed_data, compressed_size,
                                       gop_size, ctx->gop_frames);
    free(compressed_data);

    if (result < 0) {
        fprintf(stderr, "Error: GOP decode failed: %s\n", tav_video_get_error(ctx->video_ctx));
        return -1;
    }

    // Write frames to FFmpeg
    size_t frame_size = ctx->header.width * ctx->header.height * 3;
    for (int i = 0; i < gop_size; i++) {
        if (ctx->video_pipe) {
            fwrite(ctx->gop_frames[i], 1, frame_size, ctx->video_pipe);
        }
        ctx->frames_decoded++;

        // Check decode limit
        if (ctx->decode_limit > 0 && ctx->frames_decoded >= (uint64_t)ctx->decode_limit) {
            break;
        }
    }

    ctx->gops_decoded++;
    return 0;
}

static int process_iframe_packet(decoder_context_t *ctx) {
    // Read compressed size (4 bytes)
    uint32_t compressed_size;
    if (fread(&compressed_size, 4, 1, ctx->input_fp) != 1) {
        fprintf(stderr, "Error: Failed to read I-frame compressed size\n");
        return -1;
    }
    ctx->bytes_read += 4;

    if (ctx->dump_packets) {
        printf("  I-frame: %u bytes compressed\n", compressed_size);
    }

    // Allocate frame buffer
    if (allocate_gop_frames(ctx, 1) < 0) {
        fprintf(stderr, "Error: Failed to allocate I-frame buffer\n");
        return -1;
    }

    // Read compressed data
    uint8_t *compressed_data = malloc(compressed_size);
    if (!compressed_data) {
        fprintf(stderr, "Error: Failed to allocate compressed data buffer\n");
        return -1;
    }

    if (fread(compressed_data, 1, compressed_size, ctx->input_fp) != compressed_size) {
        fprintf(stderr, "Error: Failed to read I-frame compressed data\n");
        free(compressed_data);
        return -1;
    }
    ctx->bytes_read += compressed_size;

    // Decode I-frame using library
    if (ctx->dump_packets) {
        printf("  Calling tav_video_decode_iframe(%p, %p, %u, %p)\n",
               (void*)ctx->video_ctx, (void*)compressed_data, compressed_size, (void*)ctx->gop_frames[0]);
    }

    int result = tav_video_decode_iframe(ctx->video_ctx, compressed_data, compressed_size,
                                          ctx->gop_frames[0]);
    free(compressed_data);

    if (result < 0) {
        fprintf(stderr, "Error: I-frame decode failed: %s\n", tav_video_get_error(ctx->video_ctx));
        return -1;
    }

    if (ctx->dump_packets) {
        printf("  I-frame decoded successfully\n");
    }

    // Write frame to FFmpeg
    if (ctx->video_pipe) {
        size_t frame_size = ctx->header.width * ctx->header.height * 3;
        fwrite(ctx->gop_frames[0], 1, frame_size, ctx->video_pipe);
    }

    ctx->frames_decoded++;
    return 0;
}

static int process_audio_tad_packet(decoder_context_t *ctx) {
    // TAD packet format:
    // [sample_count(2)][payload_size+7(4)][sample_count(2)][quant_index(1)][compressed_size(4)][compressed_data]

    // Read outer header
    uint16_t sample_count;
    uint32_t payload_size_plus_7;

    if (fread(&sample_count, 2, 1, ctx->input_fp) != 1) return -1;
    if (fread(&payload_size_plus_7, 4, 1, ctx->input_fp) != 1) return -1;
    ctx->bytes_read += 6;

    if (ctx->dump_packets) {
        printf("  TAD audio: %u samples, %u bytes payload\n", sample_count, payload_size_plus_7);
    }

    if (ctx->no_audio) {
        // Skip audio data
        fseek(ctx->input_fp, payload_size_plus_7, SEEK_CUR);
        ctx->bytes_read += payload_size_plus_7;
        return 0;
    }

    // Read TAD chunk data (includes inner header)
    uint8_t *tad_data = malloc(payload_size_plus_7);
    if (!tad_data) return -1;

    if (fread(tad_data, 1, payload_size_plus_7, ctx->input_fp) != payload_size_plus_7) {
        free(tad_data);
        return -1;
    }
    ctx->bytes_read += payload_size_plus_7;

    // Allocate output buffer (stereo PCMu8)
    uint8_t *pcm_output = malloc(sample_count * 2);
    if (!pcm_output) {
        free(tad_data);
        return -1;
    }

    // Decode TAD using library
    size_t bytes_consumed = 0;
    size_t samples_decoded = 0;

    int result = tad32_decode_chunk(tad_data, payload_size_plus_7,
                                    pcm_output, &bytes_consumed, &samples_decoded);
    free(tad_data);

    if (result == 0 && samples_decoded > 0) {
        // Write PCMu8 to audio temp file
        if (ctx->audio_temp_fp) {
            fwrite(pcm_output, 1, samples_decoded * 2, ctx->audio_temp_fp);
        }
        ctx->audio_samples_decoded += samples_decoded;
    }

    free(pcm_output);
    return 0;
}

static int process_audio_pcm8_packet(decoder_context_t *ctx) {
    // PCM8 packet format: [size(4)][pcm_data]
    uint32_t pcm_size;
    if (fread(&pcm_size, 4, 1, ctx->input_fp) != 1) return -1;
    ctx->bytes_read += 4;

    if (ctx->dump_packets) {
        printf("  PCM8 audio: %u bytes\n", pcm_size);
    }

    if (ctx->no_audio) {
        fseek(ctx->input_fp, pcm_size, SEEK_CUR);
        ctx->bytes_read += pcm_size;
        return 0;
    }

    // Read and write PCM data directly
    uint8_t *pcm_data = malloc(pcm_size);
    if (!pcm_data) return -1;

    if (fread(pcm_data, 1, pcm_size, ctx->input_fp) != pcm_size) {
        free(pcm_data);
        return -1;
    }
    ctx->bytes_read += pcm_size;

    if (ctx->audio_temp_fp) {
        fwrite(pcm_data, 1, pcm_size, ctx->audio_temp_fp);
    }

    ctx->audio_samples_decoded += pcm_size / 2;  // Stereo
    free(pcm_data);
    return 0;
}

static int skip_packet_with_size(decoder_context_t *ctx, const char *name) {
    uint32_t size;
    if (fread(&size, 4, 1, ctx->input_fp) != 1) return -1;
    ctx->bytes_read += 4;

    if (ctx->dump_packets) {
        printf("  %s: %u bytes (skipped)\n", name, size);
    }

    fseek(ctx->input_fp, size, SEEK_CUR);
    ctx->bytes_read += size;
    return 0;
}

static int process_packet(decoder_context_t *ctx) {
    uint8_t packet_type;

    if (fread(&packet_type, 1, 1, ctx->input_fp) != 1) {
        return -1;  // EOF
    }
    ctx->bytes_read++;

    if (ctx->dump_packets) {
        printf("Packet 0x%02X at offset %lu\n", packet_type, ctx->bytes_read - 1);
    }

    switch (packet_type) {
        case TAV_PACKET_GOP_UNIFIED:
            return process_gop_packet(ctx);

        case TAV_PACKET_IFRAME:
            return process_iframe_packet(ctx);

        case TAV_PACKET_PFRAME:
            // P-frame not commonly used in TAV, skip for now
            return skip_packet_with_size(ctx, "P-frame");

        case TAV_PACKET_AUDIO_TAD:
            return process_audio_tad_packet(ctx);

        case TAV_PACKET_AUDIO_PCM8:
            return process_audio_pcm8_packet(ctx);

        case TAV_PACKET_AUDIO_MP2:
        case TAV_PACKET_AUDIO_TRACK:
            return skip_packet_with_size(ctx, "Audio track");

        case TAV_PACKET_SUBTITLE:
        case TAV_PACKET_SUBTITLE_TC:
            return skip_packet_with_size(ctx, "Subtitle");

        case TAV_PACKET_EXTENDED_HDR: {
            // Extended header format: [num_pairs(2)][key-value pairs...]
            // Each KV pair: [key(4)][type(1)][value...]
            uint16_t num_pairs;
            if (fread(&num_pairs, 2, 1, ctx->input_fp) != 1) return -1;
            ctx->bytes_read += 2;

            if (ctx->dump_packets) {
                printf("  Extended header: %u key-value pairs\n", num_pairs);
            }

            // Skip key-value pairs
            for (int i = 0; i < num_pairs; i++) {
                uint8_t kv_header[5];  // key(4) + type(1)
                if (fread(kv_header, 1, 5, ctx->input_fp) != 5) return 0;
                ctx->bytes_read += 5;

                uint8_t value_type = kv_header[4];
                if (value_type == 0x04) {  // Int64
                    uint64_t value;
                    if (fread(&value, 8, 1, ctx->input_fp) != 1) return 0;
                    ctx->bytes_read += 8;
                } else if (value_type == 0x10) {  // Bytes
                    uint16_t length;
                    if (fread(&length, 2, 1, ctx->input_fp) != 1) return 0;
                    ctx->bytes_read += 2;
                    fseek(ctx->input_fp, length, SEEK_CUR);
                    ctx->bytes_read += length;
                } else if (value_type <= 0x04) {  // Int types
                    int sizes[] = {2, 3, 4, 6, 8};  // Int16, Int24, Int32, Int48, Int64
                    fseek(ctx->input_fp, sizes[value_type], SEEK_CUR);
                    ctx->bytes_read += sizes[value_type];
                }
            }
            return 0;
        }

        case TAV_PACKET_SCREEN_MASK: {
            // Screen mask: 4 bytes (top, bottom, left, right)
            uint8_t mask[4];
            if (fread(mask, 1, 4, ctx->input_fp) != 4) return -1;
            ctx->bytes_read += 4;
            if (ctx->dump_packets) {
                printf("  Screen mask: T=%d B=%d L=%d R=%d\n", mask[0], mask[1], mask[2], mask[3]);
            }
            return 0;
        }

        case TAV_PACKET_GOP_SYNC: {
            // GOP sync: 1 byte (frame count)
            uint8_t frame_count;
            if (fread(&frame_count, 1, 1, ctx->input_fp) != 1) return -1;
            ctx->bytes_read++;
            if (ctx->dump_packets) {
                printf("  GOP sync: %d frames\n", frame_count);
            }
            return 0;
        }

        case TAV_PACKET_TIMECODE: {
            // Timecode: 8 bytes (nanoseconds)
            uint64_t timecode_ns;
            if (fread(&timecode_ns, 8, 1, ctx->input_fp) != 1) return -1;
            ctx->bytes_read += 8;
            if (ctx->dump_packets) {
                printf("  Timecode: %.3f sec\n", timecode_ns / 1000000000.0);
            }
            return 0;
        }

        case TAV_PACKET_SYNC_NTSC:
        case TAV_PACKET_SYNC:
            // Sync packets: no payload
            if (ctx->dump_packets) {
                printf("  Sync packet\n");
            }
            return 0;

        default:
            if (ctx->verbose) {
                fprintf(stderr, "Warning: Unknown packet type 0x%02X, attempting to skip\n", packet_type);
            }
            // Try to skip by reading size
            uint32_t size;
            if (fread(&size, 4, 1, ctx->input_fp) != 1) return 0;  // May be EOF
            ctx->bytes_read += 4;
            if (size < 1000000) {  // Sanity check
                fseek(ctx->input_fp, size, SEEK_CUR);
                ctx->bytes_read += size;
            }
            return 0;
    }
}

// =============================================================================
// Multithreaded Video Decoding (Pass 2)
// =============================================================================

// Read a single GOP packet without decoding - for multithreaded submission
static int read_gop_packet_mt(decoder_context_t *ctx, int slot_idx) {
    gop_decode_job_t *job = &ctx->slots[slot_idx];

    // Read GOP size (1 byte)
    uint8_t gop_size;
    if (fread(&gop_size, 1, 1, ctx->input_fp) != 1) {
        return -1;
    }
    ctx->bytes_read++;

    // Read compressed size (4 bytes)
    uint32_t compressed_size;
    if (fread(&compressed_size, 4, 1, ctx->input_fp) != 1) {
        return -1;
    }
    ctx->bytes_read += 4;

    // Read compressed data
    uint8_t *compressed_data = malloc(compressed_size);
    if (!compressed_data) {
        fprintf(stderr, "Error: Failed to allocate compressed data buffer\n");
        return -1;
    }

    if (fread(compressed_data, 1, compressed_size, ctx->input_fp) != compressed_size) {
        free(compressed_data);
        return -1;
    }
    ctx->bytes_read += compressed_size;

    // Fill job
    job->compressed_data = compressed_data;
    job->compressed_size = compressed_size;
    job->gop_size = gop_size;
    job->decode_result = 0;

    return gop_size;
}

// Multithreaded pass 2 decoding loop
static int decode_video_pass2_mt(decoder_context_t *ctx) {
    size_t frame_size = ctx->header.width * ctx->header.height * 3;
    int done = 0;
    int job_counter = 0;

    while (!done) {
        // Try to submit new jobs to any free slots
        pthread_mutex_lock(&ctx->mutex);

        // Find a free slot
        int free_slot = -1;
        for (int i = 0; i < ctx->num_slots; i++) {
            if (ctx->slots[i].status == DECODE_SLOT_DONE &&
                ctx->slots[i].compressed_data == NULL) {
                free_slot = i;
                break;
            }
        }

        pthread_mutex_unlock(&ctx->mutex);

        if (free_slot >= 0) {
            // Read next packet
            uint8_t packet_type;
            if (fread(&packet_type, 1, 1, ctx->input_fp) != 1) {
                // EOF
                done = 1;
            } else {
                ctx->bytes_read++;

                if (packet_type == TAV_PACKET_GOP_UNIFIED) {
                    // Read GOP and submit to slot
                    int gop_size = read_gop_packet_mt(ctx, free_slot);
                    if (gop_size > 0) {
                        pthread_mutex_lock(&ctx->mutex);
                        ctx->slots[free_slot].job_id = job_counter++;
                        ctx->slots[free_slot].status = DECODE_SLOT_PENDING;
                        ctx->jobs_submitted++;
                        pthread_cond_broadcast(&ctx->cond_job_available);
                        pthread_mutex_unlock(&ctx->mutex);
                    } else {
                        done = 1;
                    }
                } else if (packet_type == TAV_PACKET_IFRAME) {
                    // For I-frames, decode synchronously (they're rare)
                    process_iframe_packet(ctx);
                } else {
                    // Skip other packets (audio already extracted in Pass 1)
                    switch (packet_type) {
                        case TAV_PACKET_AUDIO_TAD: {
                            // TAD format: [sample_count(2)][payload_size+7(4)][data...]
                            uint16_t sample_count;
                            uint32_t payload_size;
                            if (fread(&sample_count, 2, 1, ctx->input_fp) != 1) { done = 1; break; }
                            if (fread(&payload_size, 4, 1, ctx->input_fp) != 1) { done = 1; break; }
                            ctx->bytes_read += 6;
                            fseek(ctx->input_fp, payload_size, SEEK_CUR);
                            ctx->bytes_read += payload_size;
                            break;
                        }
                        case TAV_PACKET_AUDIO_PCM8:
                        case TAV_PACKET_AUDIO_MP2:
                        case TAV_PACKET_AUDIO_TRACK:
                        case TAV_PACKET_SUBTITLE:
                        case TAV_PACKET_SUBTITLE_TC:
                        case TAV_PACKET_PFRAME: {
                            uint32_t size;
                            if (fread(&size, 4, 1, ctx->input_fp) != 1) { done = 1; break; }
                            ctx->bytes_read += 4;
                            fseek(ctx->input_fp, size, SEEK_CUR);
                            ctx->bytes_read += size;
                            break;
                        }
                        case TAV_PACKET_SCREEN_MASK:
                            fseek(ctx->input_fp, 4, SEEK_CUR);
                            ctx->bytes_read += 4;
                            break;
                        case TAV_PACKET_GOP_SYNC:
                            fseek(ctx->input_fp, 1, SEEK_CUR);
                            ctx->bytes_read += 1;
                            break;
                        case TAV_PACKET_TIMECODE:
                            fseek(ctx->input_fp, 8, SEEK_CUR);
                            ctx->bytes_read += 8;
                            break;
                        case TAV_PACKET_EXTENDED_HDR: {
                            // Skip extended header
                            uint16_t num_pairs;
                            if (fread(&num_pairs, 2, 1, ctx->input_fp) != 1) { done = 1; break; }
                            ctx->bytes_read += 2;
                            for (int i = 0; i < num_pairs; i++) {
                                uint8_t kv_header[5];
                                if (fread(kv_header, 1, 5, ctx->input_fp) != 5) break;
                                ctx->bytes_read += 5;
                                uint8_t value_type = kv_header[4];
                                if (value_type == 0x04) {
                                    fseek(ctx->input_fp, 8, SEEK_CUR);
                                    ctx->bytes_read += 8;
                                } else if (value_type == 0x10) {
                                    uint16_t length;
                                    if (fread(&length, 2, 1, ctx->input_fp) != 1) break;
                                    ctx->bytes_read += 2;
                                    fseek(ctx->input_fp, length, SEEK_CUR);
                                    ctx->bytes_read += length;
                                } else if (value_type <= 0x04) {
                                    int sizes[] = {2, 3, 4, 6, 8};
                                    fseek(ctx->input_fp, sizes[value_type], SEEK_CUR);
                                    ctx->bytes_read += sizes[value_type];
                                }
                            }
                            break;
                        }
                        case TAV_PACKET_SYNC_NTSC:
                        case TAV_PACKET_SYNC:
                            // No payload
                            break;
                        default:
                            // Unknown packet, try to skip
                            {
                                uint32_t size;
                                if (fread(&size, 4, 1, ctx->input_fp) == 1 && size < 1000000) {
                                    fseek(ctx->input_fp, size, SEEK_CUR);
                                    ctx->bytes_read += 4 + size;
                                }
                            }
                            break;
                    }
                }
            }
        }

        // Write completed jobs in order
        pthread_mutex_lock(&ctx->mutex);
        while (1) {
            // Find the next job to write (by job_id order)
            int write_slot = -1;
            int min_job_id = INT32_MAX;
            for (int i = 0; i < ctx->num_slots; i++) {
                if (ctx->slots[i].status == DECODE_SLOT_DONE &&
                    ctx->slots[i].job_id >= 0 &&
                    ctx->slots[i].job_id < min_job_id) {
                    // Check if this is the next expected job
                    if (ctx->slots[i].job_id == ctx->next_write_slot) {
                        write_slot = i;
                        break;
                    }
                    min_job_id = ctx->slots[i].job_id;
                }
            }

            if (write_slot < 0) {
                // No jobs ready in order, wait if there are pending jobs
                if (!done && ctx->jobs_submitted > ctx->next_write_slot) {
                    // Wait for job to complete
                    pthread_cond_wait(&ctx->cond_slot_free, &ctx->mutex);
                    continue;
                }
                break;
            }

            pthread_mutex_unlock(&ctx->mutex);

            // Write frames to FFmpeg
            gop_decode_job_t *job = &ctx->slots[write_slot];
            if (job->decode_result >= 0) {
                for (int i = 0; i < job->gop_size; i++) {
                    if (ctx->video_pipe) {
                        fwrite(job->frames[i], 1, frame_size, ctx->video_pipe);
                    }
                    ctx->frames_decoded++;

                    if (ctx->decode_limit > 0 && ctx->frames_decoded >= (uint64_t)ctx->decode_limit) {
                        done = 1;
                        break;
                    }
                }
                ctx->gops_decoded++;
            }

            // Mark slot as free
            pthread_mutex_lock(&ctx->mutex);
            job->job_id = -1;
            ctx->next_write_slot++;
            pthread_mutex_unlock(&ctx->mutex);

            // Progress
            time_t elapsed = time(NULL) - ctx->start_time;
            double fps = elapsed > 0 ? (double)ctx->frames_decoded / elapsed : 0.0;
            printf("\rFrames: %lu | GOPs: %lu | %.1f fps",
                   ctx->frames_decoded, ctx->gops_decoded, fps);
            fflush(stdout);

            pthread_mutex_lock(&ctx->mutex);
        }
        pthread_mutex_unlock(&ctx->mutex);

        // Check decode limit
        if (ctx->decode_limit > 0 && ctx->frames_decoded >= (uint64_t)ctx->decode_limit) {
            done = 1;
        }
    }

    // Wait for remaining jobs to complete
    pthread_mutex_lock(&ctx->mutex);
    while (ctx->jobs_completed < ctx->jobs_submitted) {
        pthread_cond_wait(&ctx->cond_slot_free, &ctx->mutex);
    }

    // Write any remaining completed jobs
    while (1) {
        int write_slot = -1;
        for (int i = 0; i < ctx->num_slots; i++) {
            if (ctx->slots[i].status == DECODE_SLOT_DONE &&
                ctx->slots[i].job_id == ctx->next_write_slot) {
                write_slot = i;
                break;
            }
        }

        if (write_slot < 0) break;

        pthread_mutex_unlock(&ctx->mutex);

        gop_decode_job_t *job = &ctx->slots[write_slot];
        if (job->decode_result >= 0) {
            for (int i = 0; i < job->gop_size; i++) {
                if (ctx->video_pipe) {
                    fwrite(job->frames[i], 1, frame_size, ctx->video_pipe);
                }
                ctx->frames_decoded++;
            }
            ctx->gops_decoded++;
        }

        pthread_mutex_lock(&ctx->mutex);
        job->job_id = -1;
        ctx->next_write_slot++;

        time_t elapsed = time(NULL) - ctx->start_time;
        double fps = elapsed > 0 ? (double)ctx->frames_decoded / elapsed : 0.0;
        printf("\rFrames: %lu | GOPs: %lu | %.1f fps",
               ctx->frames_decoded, ctx->gops_decoded, fps);
        fflush(stdout);
    }
    pthread_mutex_unlock(&ctx->mutex);

    printf("\n");
    return 0;
}

// =============================================================================
// Multithreaded Audio Extraction (Pass 1)
// =============================================================================

// Audio worker thread - decodes audio packets in parallel
static void *audio_worker_thread(void *arg) {
    decoder_context_t *ctx = (decoder_context_t*)arg;
    FILE *input_fp = fopen(ctx->input_file, "rb");
    if (!input_fp) {
        return NULL;
    }

    while (1) {
        pthread_mutex_lock(&ctx->audio_mutex);

        // Wait for job or exit signal
        while (ctx->next_audio_job >= ctx->audio_job_count && !ctx->audio_threads_should_exit) {
            pthread_cond_wait(&ctx->audio_cond_job_available, &ctx->audio_mutex);
        }

        if (ctx->audio_threads_should_exit) {
            pthread_mutex_unlock(&ctx->audio_mutex);
            break;
        }

        // Get next job
        int job_idx = ctx->next_audio_job++;
        pthread_mutex_unlock(&ctx->audio_mutex);

        if (job_idx >= ctx->audio_job_count) break;

        audio_decode_job_t *job = &ctx->audio_jobs[job_idx];
        job->status = DECODE_SLOT_PROCESSING;

        // Seek to packet location
        fseek(input_fp, job->file_offset, SEEK_SET);

        if (job->packet_type == TAV_PACKET_AUDIO_TAD) {
            // Read TAD packet data
            uint8_t *tad_data = malloc(job->payload_size);
            if (tad_data && fread(tad_data, 1, job->payload_size, input_fp) == job->payload_size) {
                // Allocate output buffer
                job->decoded_pcm = malloc(job->sample_count * 2);
                if (job->decoded_pcm) {
                    size_t bytes_consumed = 0;
                    int result = tad32_decode_chunk(tad_data, job->payload_size,
                                                    job->decoded_pcm, &bytes_consumed,
                                                    &job->decoded_samples);
                    if (result != 0) {
                        free(job->decoded_pcm);
                        job->decoded_pcm = NULL;
                        job->decoded_samples = 0;
                    }
                }
                free(tad_data);
            }
        } else if (job->packet_type == TAV_PACKET_AUDIO_PCM8) {
            // Read PCM8 data directly
            job->decoded_pcm = malloc(job->payload_size);
            if (job->decoded_pcm && fread(job->decoded_pcm, 1, job->payload_size, input_fp) == job->payload_size) {
                job->decoded_samples = job->payload_size / 2;  // Stereo
            } else {
                free(job->decoded_pcm);
                job->decoded_pcm = NULL;
                job->decoded_samples = 0;
            }
        }

        job->status = DECODE_SLOT_DONE;
    }

    fclose(input_fp);
    return NULL;
}

// Scan file and collect all audio packet metadata
static int collect_audio_packets(decoder_context_t *ctx) {
    long current_pos = ftell(ctx->input_fp);

    ctx->audio_job_capacity = 1024;
    ctx->audio_jobs = malloc(ctx->audio_job_capacity * sizeof(audio_decode_job_t));
    if (!ctx->audio_jobs) return -1;
    ctx->audio_job_count = 0;

    // Scan through file
    while (1) {
        long packet_pos = ftell(ctx->input_fp);
        uint8_t packet_type;

        if (fread(&packet_type, 1, 1, ctx->input_fp) != 1) break;

        if (packet_type == TAV_PACKET_AUDIO_TAD) {
            // TAD packet: [sample_count(2)][payload_size+7(4)][payload...]
            uint16_t sample_count;
            uint32_t payload_size_plus_7;

            if (fread(&sample_count, 2, 1, ctx->input_fp) != 1) break;
            if (fread(&payload_size_plus_7, 4, 1, ctx->input_fp) != 1) break;

            // Grow array if needed
            if (ctx->audio_job_count >= ctx->audio_job_capacity) {
                ctx->audio_job_capacity *= 2;
                ctx->audio_jobs = realloc(ctx->audio_jobs,
                    ctx->audio_job_capacity * sizeof(audio_decode_job_t));
                if (!ctx->audio_jobs) return -1;
            }

            // Add job
            audio_decode_job_t *job = &ctx->audio_jobs[ctx->audio_job_count++];
            job->file_offset = ftell(ctx->input_fp);
            job->payload_size = payload_size_plus_7;
            job->sample_count = sample_count;
            job->packet_type = TAV_PACKET_AUDIO_TAD;
            job->decoded_pcm = NULL;
            job->decoded_samples = 0;
            job->status = DECODE_SLOT_PENDING;

            fseek(ctx->input_fp, payload_size_plus_7, SEEK_CUR);

        } else if (packet_type == TAV_PACKET_AUDIO_PCM8) {
            // PCM8 packet: [size(4)][pcm_data]
            uint32_t pcm_size;
            if (fread(&pcm_size, 4, 1, ctx->input_fp) != 1) break;

            // Grow array if needed
            if (ctx->audio_job_count >= ctx->audio_job_capacity) {
                ctx->audio_job_capacity *= 2;
                ctx->audio_jobs = realloc(ctx->audio_jobs,
                    ctx->audio_job_capacity * sizeof(audio_decode_job_t));
                if (!ctx->audio_jobs) return -1;
            }

            // Add job
            audio_decode_job_t *job = &ctx->audio_jobs[ctx->audio_job_count++];
            job->file_offset = ftell(ctx->input_fp);
            job->payload_size = pcm_size;
            job->sample_count = pcm_size / 2;
            job->packet_type = TAV_PACKET_AUDIO_PCM8;
            job->decoded_pcm = NULL;
            job->decoded_samples = 0;
            job->status = DECODE_SLOT_PENDING;

            fseek(ctx->input_fp, pcm_size, SEEK_CUR);

        } else {
            // Skip other packet types
            if (packet_type == TAV_PACKET_GOP_UNIFIED) {
                uint8_t gop_size;
                uint32_t compressed_size;
                if (fread(&gop_size, 1, 1, ctx->input_fp) != 1) break;
                if (fread(&compressed_size, 4, 1, ctx->input_fp) != 1) break;
                fseek(ctx->input_fp, compressed_size, SEEK_CUR);
            } else if (packet_type == TAV_PACKET_IFRAME) {
                uint32_t compressed_size;
                if (fread(&compressed_size, 4, 1, ctx->input_fp) != 1) break;
                fseek(ctx->input_fp, compressed_size, SEEK_CUR);
            } else if (packet_type == TAV_PACKET_EXTENDED_HDR) {
                uint16_t num_pairs;
                if (fread(&num_pairs, 2, 1, ctx->input_fp) != 1) break;
                for (int i = 0; i < num_pairs; i++) {
                    uint8_t kv_header[5];
                    if (fread(kv_header, 1, 5, ctx->input_fp) != 5) break;
                    uint8_t value_type = kv_header[4];
                    if (value_type == 0x04) {
                        fseek(ctx->input_fp, 8, SEEK_CUR);
                    } else if (value_type == 0x10) {
                        uint16_t length;
                        if (fread(&length, 2, 1, ctx->input_fp) != 1) break;
                        fseek(ctx->input_fp, length, SEEK_CUR);
                    } else if (value_type <= 0x04) {
                        int sizes[] = {2, 3, 4, 6, 8};
                        fseek(ctx->input_fp, sizes[value_type], SEEK_CUR);
                    }
                }
            } else if (packet_type == TAV_PACKET_SCREEN_MASK) {
                fseek(ctx->input_fp, 4, SEEK_CUR);
            } else if (packet_type == TAV_PACKET_GOP_SYNC) {
                fseek(ctx->input_fp, 1, SEEK_CUR);
            } else if (packet_type == TAV_PACKET_TIMECODE) {
                fseek(ctx->input_fp, 8, SEEK_CUR);
            } else if (packet_type == TAV_PACKET_SYNC_NTSC ||
                       packet_type == TAV_PACKET_SYNC) {
                // No payload
            } else {
                // Unknown packet - try to skip by reading size
                uint32_t size;
                if (fread(&size, 4, 1, ctx->input_fp) != 1) break;
                if (size < 1000000) {
                    fseek(ctx->input_fp, size, SEEK_CUR);
                } else {
                    break;  // Likely corrupt
                }
            }
        }
    }

    // Restore file position
    fseek(ctx->input_fp, current_pos, SEEK_SET);
    return 0;
}

// Extract audio using multiple threads
static int extract_audio_mt(decoder_context_t *ctx) {
    // Collect all audio packet metadata
    if (collect_audio_packets(ctx) < 0) {
        fprintf(stderr, "Error: Failed to collect audio packets\n");
        return -1;
    }

    if (ctx->audio_job_count == 0) {
        // No audio packets found
        return 0;
    }

    if (ctx->verbose) {
        printf("  Found %d audio packets\n", ctx->audio_job_count);
    }

    // Initialize audio threading
    ctx->num_audio_threads = ctx->num_threads > 0 ? ctx->num_threads : 1;
    ctx->next_audio_job = 0;
    ctx->next_audio_write = 0;
    ctx->audio_threads_should_exit = 0;

    pthread_mutex_init(&ctx->audio_mutex, NULL);
    pthread_cond_init(&ctx->audio_cond_job_available, NULL);

    // Create worker threads
    ctx->audio_worker_threads = malloc(ctx->num_audio_threads * sizeof(pthread_t));
    if (!ctx->audio_worker_threads) return -1;

    for (int i = 0; i < ctx->num_audio_threads; i++) {
        if (pthread_create(&ctx->audio_worker_threads[i], NULL,
                          audio_worker_thread, ctx) != 0) {
            fprintf(stderr, "Error: Failed to create audio worker thread %d\n", i);
            return -1;
        }
    }

    // Signal all jobs available
    pthread_mutex_lock(&ctx->audio_mutex);
    pthread_cond_broadcast(&ctx->audio_cond_job_available);
    pthread_mutex_unlock(&ctx->audio_mutex);

    // Write decoded audio in order
    for (int i = 0; i < ctx->audio_job_count; i++) {
        audio_decode_job_t *job = &ctx->audio_jobs[i];

        // Wait for this job to complete
        while (job->status != DECODE_SLOT_DONE) {
            usleep(100);
        }

        // Write to temp file
        if (job->decoded_pcm && job->decoded_samples > 0 && ctx->audio_temp_fp) {
            fwrite(job->decoded_pcm, 1, job->decoded_samples * 2, ctx->audio_temp_fp);
            ctx->audio_samples_decoded += job->decoded_samples;
        }
    }

    // Signal threads to exit
    pthread_mutex_lock(&ctx->audio_mutex);
    ctx->audio_threads_should_exit = 1;
    pthread_cond_broadcast(&ctx->audio_cond_job_available);
    pthread_mutex_unlock(&ctx->audio_mutex);

    // Wait for threads to finish
    for (int i = 0; i < ctx->num_audio_threads; i++) {
        pthread_join(ctx->audio_worker_threads[i], NULL);
    }

    // Cleanup
    for (int i = 0; i < ctx->audio_job_count; i++) {
        if (ctx->audio_jobs[i].decoded_pcm) {
            free(ctx->audio_jobs[i].decoded_pcm);
        }
    }
    free(ctx->audio_jobs);
    free(ctx->audio_worker_threads);

    pthread_mutex_destroy(&ctx->audio_mutex);
    pthread_cond_destroy(&ctx->audio_cond_job_available);

    return 0;
}

// =============================================================================
// Main Decoding Loop
// =============================================================================

static int decode_video(decoder_context_t *ctx) {
    printf("Decoding...\n");
    ctx->start_time = time(NULL);

    // Special path for still images (TAP format) - output directly to PNG/TGA
    if (ctx->is_still_image) {
        printf("Decoding still picture...\n");

        // Allocate frame buffer for single frame
        if (allocate_gop_frames(ctx, 1) < 0) {
            fprintf(stderr, "Error: Failed to allocate frame buffer\n");
            return -1;
        }

        // Process packets until we get the first frame
        int found_frame = 0;
        while (!found_frame && process_packet(ctx) == 0) {
            if (ctx->frames_decoded > 0) {
                found_frame = 1;
            }
        }

        if (!found_frame || ctx->frames_decoded == 0) {
            fprintf(stderr, "Error: No video frame found in TAP file\n");
            return -1;
        }

        // Write the decoded frame to output file
        printf("Writing %s...\n", ctx->output_tga ? "TGA" : "PNG");
        if (write_still_image(ctx, ctx->gop_frames[0]) < 0) {
            fprintf(stderr, "Error: Failed to write output image\n");
            return -1;
        }

        printf("Successfully decoded still picture\n");
        return 0;
    }

    // Two-pass approach for proper audio/video muxing:
    // Pass 1: Extract all audio to temp file
    // Pass 2: Spawn FFmpeg with complete audio, decode video

    long data_start = ftell(ctx->input_fp);

    // Pass 1: Audio extraction
    if (!ctx->no_audio) {
        printf("Pass 1: Extracting audio");
        if (ctx->num_threads > 0) {
            printf(" (%d threads)...\n", ctx->num_threads);
            if (extract_audio_mt(ctx) < 0) {
                fprintf(stderr, "Error: Multithreaded audio extraction failed\n");
                return -1;
            }
        } else {
            printf("...\n");
            // Fallback to single-threaded
            while (process_packet(ctx) == 0) {
                // Check decode limit
                if (ctx->decode_limit > 0 && ctx->frames_decoded >= (uint64_t)ctx->decode_limit) {
                    break;
                }
            }
        }

        // Close and flush audio file
        if (ctx->audio_temp_fp) {
            fclose(ctx->audio_temp_fp);
            ctx->audio_temp_fp = NULL;
        }

        printf("  Audio samples: %lu\n", ctx->audio_samples_decoded);
    }

    // Reset for pass 2
    fseek(ctx->input_fp, data_start, SEEK_SET);
    ctx->frames_decoded = 0;
    ctx->gops_decoded = 0;
    ctx->bytes_read = 32;  // Header already read

    // Spawn FFmpeg with complete audio
    printf("Pass 2: Decoding video and muxing...\n");
    if (spawn_ffmpeg(ctx) < 0) {
        return -1;
    }

    // Initialize decoder threads if multithreaded mode
    if (ctx->num_threads > 0) {
        if (init_decoder_threads(ctx) < 0) {
            fprintf(stderr, "Error: Failed to initialize decoder threads\n");
            return -1;
        }
        printf("  Using %d decoder threads\n", ctx->num_threads);
    }

    // Pass 2: Video decoding
    if (ctx->num_threads > 0) {
        // Multithreaded decode
        int result = decode_video_pass2_mt(ctx);
        cleanup_decoder_threads(ctx);
        return result;
    } else {
        // Single-threaded decode
        uint64_t last_reported = 0;
        while (process_packet(ctx) == 0) {
            // Progress reporting - show when frames were decoded
            if (ctx->frames_decoded != last_reported) {
                time_t elapsed = time(NULL) - ctx->start_time;
                double fps = elapsed > 0 ? (double)ctx->frames_decoded / elapsed : 0.0;
                printf("\rFrames: %lu | GOPs: %lu | %.1f fps",
                       ctx->frames_decoded, ctx->gops_decoded, fps);
                fflush(stdout);
                last_reported = ctx->frames_decoded;
            }

            // Check decode limit
            if (ctx->decode_limit > 0 && ctx->frames_decoded >= (uint64_t)ctx->decode_limit) {
                break;
            }
        }

        printf("\n");
        return 0;
    }
}

// =============================================================================
// Usage and Main
// =============================================================================

// Generate output filename by replacing extension with .mkv
static char *generate_output_filename(const char *input_file) {
    size_t len = strlen(input_file);
    char *output = malloc(len + 5);  // Worst case: add ".mkv" + null
    if (!output) return NULL;

    strcpy(output, input_file);

    // Find last dot in filename (not in path)
    char *last_dot = strrchr(output, '.');
    char *last_slash = strrchr(output, '/');

    // Only replace if dot is after last slash (i.e., in filename, not path)
    if (last_dot && (!last_slash || last_dot > last_slash)) {
        strcpy(last_dot, ".mkv");
    } else {
        // No extension found, append .mkv
        strcat(output, ".mkv");
    }

    return output;
}

/**
 * Get number of available CPU cores.
 * Returns the number of online processors, or 1 on error.
 */
static int get_available_cpus(void) {
#ifdef _SC_NPROCESSORS_ONLN
    long nproc = sysconf(_SC_NPROCESSORS_ONLN);
    if (nproc > 0) {
        return (int)nproc;
    }
#endif
    return 1;  // Fallback to single core
}

/**
 * Get default thread count (cap at 8)
 */
static int get_default_thread_count(void) {
    int available = get_available_cpus();
    return available < 8 ? available : 8;
}

static void print_usage(const char *program) {
    printf("TAV/TAP Decoder - TSVM Advanced Video/Picture Codec (Reference Implementation)\n");
    printf("\nUsage: %s -i input.tav [-o output.mkv] [options]\n\n", program);
    printf("Required:\n");
    printf("  -i, --input FILE         Input TAV (video) or TAP (still image) file\n");
    printf("\nOptional:\n");
    printf("  -o, --output FILE        Output file (default: input with .mkv/.png extension)\n");
    printf("  --raw                    Output raw video (no FFV1 compression)\n");
    printf("  --no-audio               Skip audio decoding\n");
    printf("  --decode-limit N         Decode only first N frames\n");
    printf("  --dump-packets           Debug: print packet info\n");
    printf("  -t, --threads N          Number of decoder threads (0=single-threaded, default)\n");
    printf("  -v, --verbose            Verbose output\n");
    printf("  --help                   Show this help\n");
    printf("\nStill Image (TAP) Options:\n");
    printf("  --tga                    Output TGA format instead of PNG (for TAP files)\n");
    printf("\nExamples:\n");
    printf("  %s -i video.tav                      # Output: video.mkv\n", program);
    printf("  %s -i video.tav -o custom.mkv\n", program);
    printf("  %s -i video.tav --verbose --decode-limit 100\n", program);
    printf("  %s -i image.tap                      # Output: image.png\n", program);
    printf("  %s -i image.tap --tga -o out.tga     # Output: out.tga\n", program);
}

int main(int argc, char *argv[]) {
    printf("TAV Decoder - %s\n", DECODER_VENDOR_STRING);
    printf("Using libtavdec + libtaddec\n\n");

    decoder_context_t ctx = {0};

    // Initialize threading
    ctx.num_threads = get_default_thread_count();

    // Command-line options
    static struct option long_options[] = {
        {"input",        required_argument, 0, 'i'},
        {"output",       required_argument, 0, 'o'},
        {"verbose",      no_argument,       0, 'v'},
        {"threads",      required_argument, 0, 't'},
        {"raw",          no_argument,       0, 1001},
        {"no-audio",     no_argument,       0, 1002},
        {"decode-limit", required_argument, 0, 1003},
        {"dump-packets", no_argument,       0, 1004},
        {"tga",          no_argument,       0, 1005},
        {"help",         no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int c, option_index = 0;
    while ((c = getopt_long(argc, argv, "i:o:t:vh", long_options, &option_index)) != -1) {
        switch (c) {
            case 'i':
                ctx.input_file = strdup(optarg);
                break;
            case 'o':
                ctx.output_file = strdup(optarg);
                break;
            case 'v':
                ctx.verbose = 1;
                break;
            case 't': {  // --threads
                int threads = atoi(optarg);
                if (threads < 0) {
                    fprintf(stderr, "Error: Thread count must be positive\n");
                    return 1;
                }
                // Both 0 and 1 mean single-threaded (use value 0 internally)
                ctx.num_threads = (threads <= 1) ? 0 : threads;
                break;
            }
            case 1001:
                ctx.output_raw = 1;
                break;
            case 1002:
                ctx.no_audio = 1;
                break;
            case 1003:
                ctx.decode_limit = atoi(optarg);
                break;
            case 1004:
                ctx.dump_packets = 1;
                break;
            case 1005:  // --tga
                ctx.output_tga = 1;
                break;
            case 'h':
            case '?':
            default:
                print_usage(argv[0]);
                return (c == 'h' || c == '?') ? 0 : 1;
        }
    }

    // Validate arguments
    if (!ctx.input_file) {
        fprintf(stderr, "Error: Input file is required\n\n");
        print_usage(argv[0]);
        return 1;
    }

    // Generate output filename if not provided
    if (!ctx.output_file) {
        ctx.output_file = generate_output_filename(ctx.input_file);
        if (!ctx.output_file) {
            fprintf(stderr, "Error: Failed to generate output filename\n");
            return 1;
        }
    }

    // Open input file
    ctx.input_fp = fopen(ctx.input_file, "rb");
    if (!ctx.input_fp) {
        fprintf(stderr, "Error: Cannot open input file: %s\n", ctx.input_file);
        return 1;
    }

    // Read and parse header
    if (read_tav_header(&ctx) < 0) {
        fclose(ctx.input_fp);
        return 1;
    }

    // Scan for XFPS if header.fps == 0xFF
    scan_for_xfps(&ctx);

    // Handle still image (TAP) mode
    if (ctx.is_still_image) {
        printf("Detected still picture (TAP format)\n");

        // Force single-threaded mode (override user option)
        if (ctx.num_threads > 0) {
            printf("  Disabling multithreading for still image\n");
            ctx.num_threads = 0;
        }

        // Disable audio for still images
        ctx.no_audio = 1;

        // Bypass grain synthesis (set anime preset bit)
        // Bit 1 of encoder_preset disables grain synthesis
        ctx.header.encoder_preset |= 0x02;

        // Set decode limit to 1 frame
        ctx.decode_limit = 1;

        // Update output filename to use .png or .tga if it ends with .mkv (auto-generated)
        if (ctx.output_file) {
            char *last_dot = strrchr(ctx.output_file, '.');
            if (last_dot && strcmp(last_dot, ".mkv") == 0) {
                const char *new_ext = ctx.output_tga ? ".tga" : ".png";
                strcpy(last_dot, new_ext);
            }
        }

        printf("  Output format: %s\n", ctx.output_tga ? "TGA" : "PNG");
    }

    // Create audio temp file
    char temp_audio_file[256];
    snprintf(temp_audio_file, sizeof(temp_audio_file), "/tmp/tav_dec_audio_%d.pcm", getpid());
    ctx.audio_temp_file = strdup(temp_audio_file);

    if (!ctx.no_audio) {
        ctx.audio_temp_fp = fopen(ctx.audio_temp_file, "wb");
        if (!ctx.audio_temp_fp) {
            fprintf(stderr, "Error: Cannot create audio temp file: %s\n", ctx.audio_temp_file);
            fclose(ctx.input_fp);
            return 1;
        }
    }

    // Initialize video decoder
    tav_video_params_t video_params = {
        .width = ctx.header.width,
        .height = ctx.header.height,
        .decomp_levels = ctx.header.decomp_levels,
        .temporal_levels = 2,  // Default
        .wavelet_filter = ctx.header.wavelet_filter,
        .temporal_wavelet = 255,  // Haar
        .entropy_coder = ctx.header.entropy_coder,
        .channel_layout = ctx.header.channel_layout,
        .perceptual_tuning = ctx.perceptual_mode,
        .quantiser_y = ctx.header.quantiser_y,
        .quantiser_co = ctx.header.quantiser_co,
        .quantiser_cg = ctx.header.quantiser_cg,
        .encoder_preset = ctx.header.encoder_preset,
        .monoblock = 1
    };

    ctx.video_ctx = tav_video_create(&video_params);
    if (!ctx.video_ctx) {
        fprintf(stderr, "Error: Failed to create video decoder context\n");
        fclose(ctx.input_fp);
        if (ctx.audio_temp_fp) fclose(ctx.audio_temp_fp);
        return 1;
    }

    tav_video_set_verbose(ctx.video_ctx, ctx.verbose);

    printf("Input: %s\n", ctx.input_file);
    printf("Output: %s\n", ctx.output_file);
    if (ctx.is_still_image) {
        printf("Resolution: %dx%d (still picture)\n", ctx.header.width, ctx.header.height);
    } else {
        printf("Resolution: %dx%d @ %d fps\n", ctx.header.width, ctx.header.height, ctx.header.fps);
    }
    printf("\n");

    // Decode
    int result = decode_video(&ctx);

    // Cleanup FFmpeg
    if (ctx.video_pipe) {
        fclose(ctx.video_pipe);
        waitpid(ctx.ffmpeg_pid, NULL, 0);
    }

    // Cleanup
    if (ctx.video_ctx) {
        tav_video_free(ctx.video_ctx);
    }

    if (ctx.gop_frames) {
        for (int i = 0; i < ctx.gop_frames_allocated; i++) {
            free(ctx.gop_frames[i]);
        }
        free(ctx.gop_frames);
    }

    fclose(ctx.input_fp);

    // Remove temp audio file
    if (ctx.audio_temp_file) {
        unlink(ctx.audio_temp_file);
        free(ctx.audio_temp_file);
    }

    // Statistics
    time_t total_time = time(NULL) - ctx.start_time;
    double avg_fps = total_time > 0 ? (double)ctx.frames_decoded / total_time : 0.0;

    if (ctx.is_still_image) {
        printf("\n=== Decoding Complete ===\n");
        printf("  Still picture decoded successfully\n");
        printf("  Bytes read: %lu\n", ctx.bytes_read);
        printf("  Time taken: %ld seconds\n", total_time);
        printf("=========================\n");
    } else {
        printf("\n=== Decoding Complete ===\n");
        printf("  Frames decoded: %lu\n", ctx.frames_decoded);
        printf("  GOPs decoded: %lu\n", ctx.gops_decoded);
        printf("  Audio samples: %lu\n", ctx.audio_samples_decoded);
        printf("  Bytes read: %lu\n", ctx.bytes_read);
        printf("  Decoding speed: %.1f fps\n", avg_fps);
        printf("  Time taken: %ld seconds\n", total_time);
        printf("=========================\n");
    }

    if (result < 0) {
        fprintf(stderr, "Decoding failed\n");
        free(ctx.input_file);
        free(ctx.output_file);
        return 1;
    }

    printf("\nOutput written to: %s\n", ctx.output_file);

    free(ctx.input_file);
    free(ctx.output_file);

    return 0;
}
