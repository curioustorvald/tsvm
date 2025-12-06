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

#include "tav_video_decoder.h"
#include "decoder_tad.h"

// =============================================================================
// Constants
// =============================================================================

#define DECODER_VENDOR_STRING "Decoder-TAV 20251207 (libtavdec)"
#define TAV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x56"  // "\x1FTSVMTAV"
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

    // Verify magic
    if (memcmp(header_bytes, TAV_MAGIC, 8) != 0) {
        fprintf(stderr, "Error: Invalid TAV magic (not a TAV file)\n");
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

    if (ctx->verbose) {
        printf("=== TAV Header ===\n");
        printf("  Version: %d\n", ctx->header.version);
        printf("  Resolution: %dx%d\n", ctx->header.width, ctx->header.height);
        printf("  FPS: %d\n", ctx->header.fps);
        printf("  Total frames: %u\n", ctx->header.total_frames);
        printf("  Wavelet filter: %d\n", ctx->header.wavelet_filter);
        printf("  Decomp levels: %d\n", ctx->header.decomp_levels);
        printf("  Quantisers: Y=%d, Co=%d, Cg=%d\n",
               ctx->header.quantiser_y, ctx->header.quantiser_co, ctx->header.quantiser_cg);
        printf("  Perceptual mode: %s\n", ctx->perceptual_mode ? "yes" : "no");
        printf("  Entropy coder: %s\n", ctx->header.entropy_coder ? "EZBC" : "Twobitmap");
        printf("  Encoder preset: 0x%02X\n", ctx->header.encoder_preset);
        printf("  Has audio: %s\n", (ctx->header.extra_flags & 0x01) ? "yes" : "no");
        printf("==================\n\n");
    }

    return 0;
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

        char video_size[32];
        char framerate[16];
        snprintf(video_size, sizeof(video_size), "%dx%d", ctx->header.width, ctx->header.height);
        snprintf(framerate, sizeof(framerate), "%d", ctx->header.fps);

        // Redirect video pipe to fd 3
        dup2(video_pipe_fd[0], 3);
        close(video_pipe_fd[0]);

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
// Main Decoding Loop
// =============================================================================

static int decode_video(decoder_context_t *ctx) {
    printf("Decoding...\n");
    ctx->start_time = time(NULL);

    // Two-pass approach for proper audio/video muxing:
    // Pass 1: Extract all audio to temp file
    // Pass 2: Spawn FFmpeg with complete audio, decode video

    long data_start = ftell(ctx->input_fp);

    // Pass 1: Audio extraction
    if (!ctx->no_audio) {
        printf("Pass 1: Extracting audio...\n");
        while (process_packet(ctx) == 0) {
            // Check decode limit
            if (ctx->decode_limit > 0 && ctx->frames_decoded >= (uint64_t)ctx->decode_limit) {
                break;
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

    // Pass 2: Video decoding
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

static void print_usage(const char *program) {
    printf("TAV Decoder - TSVM Advanced Video Codec (Reference Implementation)\n");
    printf("\nUsage: %s -i input.tav [-o output.mkv] [options]\n\n", program);
    printf("Required:\n");
    printf("  -i, --input FILE         Input TAV file\n");
    printf("\nOptional:\n");
    printf("  -o, --output FILE        Output video file (default: input with .mkv extension)\n");
    printf("  --raw                    Output raw video (no FFV1 compression)\n");
    printf("  --no-audio               Skip audio decoding\n");
    printf("  --decode-limit N         Decode only first N frames\n");
    printf("  --dump-packets           Debug: print packet info\n");
    printf("  -v, --verbose            Verbose output\n");
    printf("  --help                   Show this help\n");
    printf("\nExamples:\n");
    printf("  %s -i video.tav                      # Output: video.mkv\n", program);
    printf("  %s -i video.tav -o custom.mkv\n", program);
    printf("  %s -i video.tav --verbose --decode-limit 100\n", program);
}

int main(int argc, char *argv[]) {
    printf("TAV Decoder - %s\n", DECODER_VENDOR_STRING);
    printf("Using libtavdec + libtaddec\n\n");

    decoder_context_t ctx = {0};

    // Command-line options
    static struct option long_options[] = {
        {"input",        required_argument, 0, 'i'},
        {"output",       required_argument, 0, 'o'},
        {"verbose",      no_argument,       0, 'v'},
        {"raw",          no_argument,       0, 1001},
        {"no-audio",     no_argument,       0, 1002},
        {"decode-limit", required_argument, 0, 1003},
        {"dump-packets", no_argument,       0, 1004},
        {"help",         no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int c, option_index = 0;
    while ((c = getopt_long(argc, argv, "i:o:vh", long_options, &option_index)) != -1) {
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
            case 'h':
            case '?':
            default:
                print_usage(argv[0]);
                return (c == 'h') ? 0 : 1;
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
        .temporal_wavelet = 0,  // Haar
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
    printf("Resolution: %dx%d @ %d fps\n", ctx.header.width, ctx.header.height, ctx.header.fps);
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

    printf("\n=== Decoding Complete ===\n");
    printf("  Frames decoded: %lu\n", ctx.frames_decoded);
    printf("  GOPs decoded: %lu\n", ctx.gops_decoded);
    printf("  Audio samples: %lu\n", ctx.audio_samples_decoded);
    printf("  Bytes read: %lu\n", ctx.bytes_read);
    printf("  Decoding speed: %.1f fps\n", avg_fps);
    printf("  Time taken: %ld seconds\n", total_time);
    printf("=========================\n");

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
