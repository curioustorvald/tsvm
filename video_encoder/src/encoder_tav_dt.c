/**
 * TAV-DT Encoder - Digital Tape Format Encoder
 *
 * Encodes video to TAV-DT format with forward error correction.
 *
 * TAV-DT is a packetised streaming format designed for digital tape/broadcast:
 * - Fixed dimensions: 720x480 (NTSC) or 720x576 (PAL)
 * - 16-frame GOPs with 9/7 spatial wavelet, Haar temporal
 * - Mandatory TAD audio
 * - LDPC rate 1/2 for headers, Reed-Solomon (255,223) for payloads
 *
 * Packet structure (revised 2025-12-11):
 * - Main header: 28 bytes -> 56 bytes LDPC encoded
 *   (sync + fps + flags + reserved + size + crc + timecode + offset_to_video)
 * - TAD subpacket: header (10->20 bytes LDPC) + RS-encoded payload
 * - TAV subpacket: header (8->16 bytes LDPC) + RS-encoded payload
 * - No packet type bytes - always audio then video
 *
 * Created by CuriousTorvald and Claude on 2025-12-09.
 * Revised 2025-12-11 for updated TAV-DT specification.
 */

#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <getopt.h>
#include <unistd.h>
#include <sys/wait.h>
#include <time.h>
#include <math.h>

#include "tav_encoder_lib.h"
#include "encoder_tad.h"
#include "reed_solomon.h"
#include "ldpc.h"

// =============================================================================
// Constants
// =============================================================================

// TAV-DT sync patterns (big endian)
#define TAV_DT_SYNC_NTSC  0xE3537A1F
#define TAV_DT_SYNC_PAL   0xD193A745

// TAV-DT dimensions
#define DT_WIDTH          720
#define DT_HEIGHT_NTSC    480
#define DT_HEIGHT_PAL     576

// Fixed parameters
#define DT_GOP_SIZE        16
#define DT_SPATIAL_LEVELS  4
#define DT_TEMPORAL_LEVELS 2

// Header sizes (before LDPC encoding)
#define DT_MAIN_HEADER_SIZE   28   // sync(4) + fps(1) + flags(1) + reserved(2) + size(4) + crc(4) + timecode(8) + offset(4)
#define DT_TAD_HEADER_SIZE    10   // sample_count(2) + quant_bits(1) + compressed_size(4) + rs_block_count(3)
#define DT_TAV_HEADER_SIZE    8    // gop_size(1) + compressed_size(4) + rs_block_count(3)

// Quality level to quantiser mapping
static const int QUALITY_Y[]  = {79, 47, 23, 11, 5, 2};
static const int QUALITY_CO[] = {123, 108, 91, 76, 59, 29};
static const int QUALITY_CG[] = {148, 133, 113, 99, 76, 39};

// Audio samples per GOP (32kHz / framerate * gop_size)
#define AUDIO_SAMPLE_RATE 32000

// =============================================================================
// CRC-32
// =============================================================================

static uint32_t crc32_table[256];
static int crc32_initialized = 0;

static void init_crc32_table(void) {
    if (crc32_initialized) return;
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t crc = i;
        for (int j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
        }
        crc32_table[i] = crc;
    }
    crc32_initialized = 1;
}

static uint32_t calculate_crc32(const uint8_t *data, size_t length) {
    init_crc32_table();
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < length; i++) {
        crc = (crc >> 8) ^ crc32_table[(crc ^ data[i]) & 0xFF];
    }
    return crc ^ 0xFFFFFFFF;
}

// =============================================================================
// Encoder Context
// =============================================================================

typedef struct {
    // Input/output
    char *input_file;
    char *output_file;
    FILE *output_fp;

    // Video encoder context
    tav_encoder_context_t *video_ctx;

    // Video parameters
    int width;
    int height;
    int fps_num;
    int fps_den;
    int is_interlaced;
    int is_pal;
    int quality_index;

    // Frame buffers
    uint8_t **gop_frames;
    int gop_frame_count;

    // Audio buffer
    float *audio_buffer;
    size_t audio_buffer_samples;
    size_t audio_buffer_capacity;

    // Timecode
    uint64_t current_timecode_ns;
    int frame_number;

    // Statistics
    uint64_t packets_written;
    uint64_t bytes_written;
    uint64_t frames_encoded;

    // Options
    int verbose;
    int encode_limit;
} dt_encoder_t;

// =============================================================================
// Utility Functions
// =============================================================================

static void print_usage(const char *program) {
    printf("TAV-DT Encoder - Digital Tape Format with FEC\n");
    printf("\nUsage: %s -i input.mp4 -o output.tavdt [options]\n\n", program);
    printf("Required:\n");
    printf("  -i, --input FILE     Input video file (via FFmpeg)\n");
    printf("  -o, --output FILE    Output TAV-DT file\n");
    printf("\nOptions:\n");
    printf("  -q, --quality N      Quality level 0-5 (default: 3)\n");
    printf("  --ntsc               Force NTSC format (720x480, default)\n");
    printf("  --pal                Force PAL format (720x576)\n");
    printf("  --interlaced         Interlaced output\n");
    printf("  --encode-limit N     Encode only N frames (for testing)\n");
    printf("  -v, --verbose        Verbose output\n");
    printf("  -h, --help           Show this help\n");
}

// =============================================================================
// RS Block Encoding
// =============================================================================

static size_t encode_rs_blocks(const uint8_t *data, size_t data_len, uint8_t *output) {
    size_t output_len = 0;
    size_t remaining = data_len;
    const uint8_t *src = data;
    uint8_t *dst = output;

    while (remaining > 0) {
        size_t block_data = (remaining > RS_DATA_SIZE) ? RS_DATA_SIZE : remaining;
        size_t encoded_len = rs_encode(src, block_data, dst);

        // Pad to full block size for consistent block boundaries
        if (encoded_len < RS_BLOCK_SIZE) {
            memset(dst + encoded_len, 0, RS_BLOCK_SIZE - encoded_len);
        }

        src += block_data;
        dst += RS_BLOCK_SIZE;
        output_len += RS_BLOCK_SIZE;
        remaining -= block_data;
    }

    return output_len;
}

// =============================================================================
// Packet Writing
// =============================================================================

static int write_packet(dt_encoder_t *enc, uint64_t timecode_ns,
                        const uint8_t *tad_data, size_t tad_size,
                        const uint8_t *tav_data, size_t tav_size,
                        int gop_size, uint16_t audio_samples, uint8_t audio_quant_bits) {

    // Calculate RS block counts
    uint32_t tad_rs_blocks = (tad_size + RS_DATA_SIZE - 1) / RS_DATA_SIZE;
    uint32_t tav_rs_blocks = (tav_size + RS_DATA_SIZE - 1) / RS_DATA_SIZE;

    // Calculate sizes
    size_t tad_rs_size = tad_rs_blocks * RS_BLOCK_SIZE;
    size_t tav_rs_size = tav_rs_blocks * RS_BLOCK_SIZE;

    size_t tad_subpacket_size = DT_TAD_HEADER_SIZE * 2 + tad_rs_size;  // LDPC header + RS payload
    size_t tav_subpacket_size = DT_TAV_HEADER_SIZE * 2 + tav_rs_size;  // LDPC header + RS payload

    uint32_t offset_to_video = tad_subpacket_size;
    uint32_t packet_size = tad_subpacket_size + tav_subpacket_size;

    // Build main header (28 bytes)
    uint8_t header[DT_MAIN_HEADER_SIZE];
    // Write sync pattern in big-endian (network byte order)
    uint32_t sync = enc->is_pal ? TAV_DT_SYNC_PAL : TAV_DT_SYNC_NTSC;
    header[0] = (sync >> 24) & 0xFF;
    header[1] = (sync >> 16) & 0xFF;
    header[2] = (sync >> 8) & 0xFF;
    header[3] = sync & 0xFF;

    // FPS byte: encode framerate
    uint8_t fps_byte;
    if (enc->fps_den == 1) fps_byte = enc->fps_num;
    else if (enc->fps_den == 1001) fps_byte = enc->fps_num / 1000;
    else fps_byte = enc->fps_num / enc->fps_den;
    header[4] = fps_byte;

    // Flags byte
    uint8_t flags = 0;
    flags |= (enc->is_interlaced ? 0x01 : 0x00);
    flags |= (enc->fps_den == 1001 ? 0x02 : 0x00);
    flags |= (enc->quality_index & 0x0F) << 4;
    header[5] = flags;

    // Reserved (2 bytes)
    header[6] = 0;
    header[7] = 0;

    // Packet size (4 bytes)
    memcpy(header + 8, &packet_size, 4);

    // CRC placeholder (will be calculated over header bytes 0-11)
    uint32_t crc = calculate_crc32(header, 12);
    memcpy(header + 12, &crc, 4);

    // Timecode (8 bytes)
    memcpy(header + 16, &timecode_ns, 8);

    // Offset to video (4 bytes)
    memcpy(header + 24, &offset_to_video, 4);

    // LDPC encode main header
    uint8_t ldpc_header[DT_MAIN_HEADER_SIZE * 2];
    ldpc_encode(header, DT_MAIN_HEADER_SIZE, ldpc_header);

    // Build TAD subpacket header (10 bytes)
    uint8_t tad_header[DT_TAD_HEADER_SIZE];
    memcpy(tad_header + 0, &audio_samples, 2);
    tad_header[2] = audio_quant_bits;
    uint32_t tad_compressed_size = tad_size;
    memcpy(tad_header + 3, &tad_compressed_size, 4);
    // RS block count as uint24
    tad_header[7] = tad_rs_blocks & 0xFF;
    tad_header[8] = (tad_rs_blocks >> 8) & 0xFF;
    tad_header[9] = (tad_rs_blocks >> 16) & 0xFF;

    uint8_t ldpc_tad_header[DT_TAD_HEADER_SIZE * 2];
    ldpc_encode(tad_header, DT_TAD_HEADER_SIZE, ldpc_tad_header);

    // Build TAV subpacket header (8 bytes)
    uint8_t tav_header[DT_TAV_HEADER_SIZE];
    tav_header[0] = gop_size;
    uint32_t tav_compressed_size = tav_size;
    memcpy(tav_header + 1, &tav_compressed_size, 4);
    // RS block count as uint24
    tav_header[5] = tav_rs_blocks & 0xFF;
    tav_header[6] = (tav_rs_blocks >> 8) & 0xFF;
    tav_header[7] = (tav_rs_blocks >> 16) & 0xFF;

    uint8_t ldpc_tav_header[DT_TAV_HEADER_SIZE * 2];
    ldpc_encode(tav_header, DT_TAV_HEADER_SIZE, ldpc_tav_header);

    // RS encode payloads
    uint8_t *tad_rs_data = malloc(tad_rs_size);
    uint8_t *tav_rs_data = malloc(tav_rs_size);

    encode_rs_blocks(tad_data, tad_size, tad_rs_data);
    encode_rs_blocks(tav_data, tav_size, tav_rs_data);

    // Write everything
    fwrite(ldpc_header, 1, DT_MAIN_HEADER_SIZE * 2, enc->output_fp);
    fwrite(ldpc_tad_header, 1, DT_TAD_HEADER_SIZE * 2, enc->output_fp);
    fwrite(tad_rs_data, 1, tad_rs_size, enc->output_fp);
    fwrite(ldpc_tav_header, 1, DT_TAV_HEADER_SIZE * 2, enc->output_fp);
    fwrite(tav_rs_data, 1, tav_rs_size, enc->output_fp);

    size_t total_written = DT_MAIN_HEADER_SIZE * 2 + tad_subpacket_size + tav_subpacket_size;

    if (enc->verbose) {
        printf("GOP %lu: %d frames, header=%zu tad=%zu tav=%zu total=%zu bytes\n",
               enc->packets_written + 1, gop_size,
               (size_t)(DT_MAIN_HEADER_SIZE * 2), tad_subpacket_size, tav_subpacket_size, total_written);
    }

    free(tad_rs_data);
    free(tav_rs_data);

    enc->packets_written++;
    enc->bytes_written += total_written;

    return 0;
}

// =============================================================================
// FFmpeg Integration
// =============================================================================

static FILE *spawn_ffmpeg_video(dt_encoder_t *enc, pid_t *pid) {
    int pipefd[2];
    if (pipe(pipefd) < 0) {
        fprintf(stderr, "Error: Failed to create pipe\n");
        return NULL;
    }

    *pid = fork();
    if (*pid < 0) {
        fprintf(stderr, "Error: Failed to fork\n");
        close(pipefd[0]);
        close(pipefd[1]);
        return NULL;
    }

    if (*pid == 0) {
        // Child process
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        close(pipefd[1]);

        char video_size[32];
        snprintf(video_size, sizeof(video_size), "%dx%d", enc->width, enc->height);

        // Use same filtergraph as reference TAV encoder
        char vf[256];
        snprintf(vf, sizeof(vf),
                 "scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d%s",
                 enc->width, enc->height, enc->width, enc->height,
                 enc->is_interlaced ? ",setfield=tff" : "");

        execlp("ffmpeg", "ffmpeg",
               "-hide_banner",
               "-i", enc->input_file,
               "-vf", vf,
               "-pix_fmt", "rgb24",
               "-f", "rawvideo",
               "-an",
               "-v", "warning",
               "-",
               (char*)NULL);

        fprintf(stderr, "Error: Failed to execute FFmpeg\n");
        exit(1);
    }

    close(pipefd[1]);
    return fdopen(pipefd[0], "rb");
}

static FILE *spawn_ffmpeg_audio(dt_encoder_t *enc, pid_t *pid) {
    int pipefd[2];
    if (pipe(pipefd) < 0) {
        fprintf(stderr, "Error: Failed to create pipe\n");
        return NULL;
    }

    *pid = fork();
    if (*pid < 0) {
        fprintf(stderr, "Error: Failed to fork\n");
        close(pipefd[0]);
        close(pipefd[1]);
        return NULL;
    }

    if (*pid == 0) {
        // Child process
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        close(pipefd[1]);

        execlp("ffmpeg", "ffmpeg",
               "-i", enc->input_file,
               "-f", "f32le",
               "-acodec", "pcm_f32le",
               "-ar", "32000",
               "-ac", "2",
               "-vn",
               "-v", "warning",
               "-",
               (char*)NULL);

        fprintf(stderr, "Error: Failed to execute FFmpeg\n");
        exit(1);
    }

    close(pipefd[1]);
    return fdopen(pipefd[0], "rb");
}

// =============================================================================
// Main Encoding Loop
// =============================================================================

static int run_encoder(dt_encoder_t *enc) {
    // Open output file
    enc->output_fp = fopen(enc->output_file, "wb");
    if (!enc->output_fp) {
        fprintf(stderr, "Error: Cannot create output file: %s\n", enc->output_file);
        return -1;
    }

    // Set up video encoder
    tav_encoder_params_t params;
    tav_encoder_params_init(&params, enc->width, enc->height);
    params.fps_num = enc->fps_num;
    params.fps_den = enc->fps_den;
    params.wavelet_type = 1;           // CDF 9/7
    params.temporal_wavelet = 255;     // Haar
    params.decomp_levels = DT_SPATIAL_LEVELS;
    params.temporal_levels = DT_TEMPORAL_LEVELS;
    params.enable_temporal_dwt = 1;
    params.gop_size = DT_GOP_SIZE;
    params.quality_level = enc->quality_index;
    params.quantiser_y = QUALITY_Y[enc->quality_index];
    params.quantiser_co = QUALITY_CO[enc->quality_index];
    params.quantiser_cg = QUALITY_CG[enc->quality_index];
    params.entropy_coder = 1;          // EZBC
    params.encoder_preset = 0x01;      // Sports mode
    params.monoblock = 1;              // Force monoblock
    params.verbose = enc->verbose;

    enc->video_ctx = tav_encoder_create(&params);
    if (!enc->video_ctx) {
        fprintf(stderr, "Error: Cannot create video encoder\n");
        fclose(enc->output_fp);
        return -1;
    }

    printf("Forced Monoblock mode (--monoblock)\n");

    // Get actual parameters (may have been adjusted)
    tav_encoder_get_params(enc->video_ctx, &params);

    if (enc->verbose) {
        printf("Auto-selected Haar temporal wavelet with sports mode (resolution: %dx%d = %d pixels, quantiser_y = %d)\n",
               enc->width, enc->height, enc->width * enc->height, params.quantiser_y);
    }

    // Spawn FFmpeg for video
    pid_t video_pid;
    FILE *video_pipe = spawn_ffmpeg_video(enc, &video_pid);
    if (!video_pipe) {
        tav_encoder_free(enc->video_ctx);
        fclose(enc->output_fp);
        return -1;
    }

    // Spawn FFmpeg for audio
    pid_t audio_pid;
    FILE *audio_pipe = spawn_ffmpeg_audio(enc, &audio_pid);
    if (!audio_pipe) {
        fclose(video_pipe);
        waitpid(video_pid, NULL, 0);
        tav_encoder_free(enc->video_ctx);
        fclose(enc->output_fp);
        return -1;
    }

    // Allocate frame buffers
    size_t frame_size = enc->width * enc->height * 3;
    enc->gop_frames = malloc(DT_GOP_SIZE * sizeof(uint8_t *));
    for (int i = 0; i < DT_GOP_SIZE; i++) {
        enc->gop_frames[i] = malloc(frame_size);
    }

    // Audio buffer (enough for one GOP worth of audio)
    double gop_duration = (double)DT_GOP_SIZE * enc->fps_den / enc->fps_num;
    size_t audio_samples_per_gop = (size_t)(AUDIO_SAMPLE_RATE * gop_duration) + 1024;
    enc->audio_buffer = malloc(audio_samples_per_gop * 2 * sizeof(float));
    enc->audio_buffer_capacity = audio_samples_per_gop;
    enc->audio_buffer_samples = 0;

    // TAD output buffer
    size_t tad_buffer_size = audio_samples_per_gop * 2;  // Conservative estimate
    uint8_t *tad_output = malloc(tad_buffer_size);

    // Encoding loop
    enc->frame_number = 0;
    enc->gop_frame_count = 0;
    enc->current_timecode_ns = 0;

    clock_t start_time = clock();

    while (1) {
        // Check encode limit
        if (enc->encode_limit > 0 && enc->frame_number >= enc->encode_limit) {
            break;
        }

        // Read video frame
        size_t bytes_read = fread(enc->gop_frames[enc->gop_frame_count], 1, frame_size, video_pipe);
        if (bytes_read < frame_size) {
            if (enc->verbose) {
                fprintf(stderr, "Video read incomplete: got %zu/%zu bytes, frame %d, eof=%d, error=%d\n",
                        bytes_read, frame_size, enc->frame_number, feof(video_pipe), ferror(video_pipe));
                fprintf(stderr, "Audio buffer status: %zu/%zu samples\n",
                        enc->audio_buffer_samples, enc->audio_buffer_capacity);
                // Try to read more audio to see if pipe is blocked
                float test_audio[16];
                size_t test_read = fread(test_audio, sizeof(float), 16, audio_pipe);
                fprintf(stderr, "Test audio read: %zu floats, eof=%d, error=%d\n",
                        test_read, feof(audio_pipe), ferror(audio_pipe));
            }
            break;  // End of video
        }

        enc->gop_frame_count++;
        enc->frame_number++;

        // Read corresponding audio
        double frame_duration = (double)enc->fps_den / enc->fps_num;
        size_t audio_samples_per_frame = (size_t)(AUDIO_SAMPLE_RATE * frame_duration);
        size_t audio_bytes = audio_samples_per_frame * 2 * sizeof(float);

        // Always read audio to prevent pipe from filling up and blocking FFmpeg
        // Expand buffer if needed
        if (enc->audio_buffer_samples + audio_samples_per_frame > enc->audio_buffer_capacity) {
            size_t new_capacity = enc->audio_buffer_capacity * 2;
            float *new_buffer = realloc(enc->audio_buffer, new_capacity * 2 * sizeof(float));
            if (new_buffer) {
                enc->audio_buffer = new_buffer;
                enc->audio_buffer_capacity = new_capacity;
            }
        }

        size_t audio_read = fread(enc->audio_buffer + enc->audio_buffer_samples * 2,
                                  1, audio_bytes, audio_pipe);
        enc->audio_buffer_samples += audio_read / (2 * sizeof(float));

        // Encode GOP when full
        if (enc->gop_frame_count >= DT_GOP_SIZE) {
            // Encode video GOP
            tav_encoder_packet_t *video_packet = NULL;
            int frame_numbers[DT_GOP_SIZE];
            for (int i = 0; i < DT_GOP_SIZE; i++) {
                frame_numbers[i] = enc->frame_number - DT_GOP_SIZE + i;
            }

            int result = tav_encoder_encode_gop(enc->video_ctx,
                                                 (const uint8_t **)enc->gop_frames,
                                                 DT_GOP_SIZE, frame_numbers, &video_packet);

            if (result < 0 || !video_packet) {
                fprintf(stderr, "Error: Video encoding failed\n");
                break;
            }

            // Encode audio
            int max_index = tad32_quality_to_max_index(enc->quality_index);
            size_t tad_size = tad32_encode_chunk(enc->audio_buffer, enc->audio_buffer_samples,
                                                  max_index, 1.0f, tad_output);

            // Write packet
            write_packet(enc, enc->current_timecode_ns,
                         tad_output, tad_size,
                         video_packet->data, video_packet->size,
                         DT_GOP_SIZE, (uint16_t)enc->audio_buffer_samples, max_index);

            // Update timecode
            enc->current_timecode_ns += (uint64_t)(gop_duration * 1e9);
            enc->frames_encoded += DT_GOP_SIZE;

            // Reset buffers
            enc->gop_frame_count = 0;
            enc->audio_buffer_samples = 0;

            tav_encoder_free_packet(video_packet);

            // Display progress (similar to reference TAV encoder)
            clock_t now = clock();
            double elapsed = (double)(now - start_time) / CLOCKS_PER_SEC;
            double fps = elapsed > 0 ? (double)enc->frame_number / elapsed : 0.0;

            // Calculate bitrate: output_size_bits / duration_seconds / 1000
            double duration = (double)enc->frame_number * enc->fps_den / enc->fps_num;
            double bitrate = duration > 0 ? (ftell(enc->output_fp) * 8.0) / duration / 1000.0 : 0.0;

            long gop_count = enc->frame_number / DT_GOP_SIZE;
            size_t total_kb = ftell(enc->output_fp) / 1024;

            printf("\rFrame %d | GOPs: %ld | %.1f fps | %.1f kbps | %zu KB    ",
                   enc->frame_number, gop_count, fps, bitrate, total_kb);
            fflush(stdout);
        }
    }

    // Handle partial final GOP
    if (enc->gop_frame_count > 0) {
        tav_encoder_packet_t *video_packet = NULL;
        int *frame_numbers = malloc(enc->gop_frame_count * sizeof(int));
        for (int i = 0; i < enc->gop_frame_count; i++) {
            frame_numbers[i] = enc->frame_number - enc->gop_frame_count + i;
        }

        int result = tav_encoder_encode_gop(enc->video_ctx,
                                             (const uint8_t **)enc->gop_frames,
                                             enc->gop_frame_count, frame_numbers, &video_packet);

        if (result >= 0 && video_packet) {
            int max_index = tad32_quality_to_max_index(enc->quality_index);
            size_t tad_size = tad32_encode_chunk(enc->audio_buffer, enc->audio_buffer_samples,
                                                  max_index, 1.0f, tad_output);

            write_packet(enc, enc->current_timecode_ns,
                         tad_output, tad_size,
                         video_packet->data, video_packet->size,
                         enc->gop_frame_count, (uint16_t)enc->audio_buffer_samples, max_index);

            enc->frames_encoded += enc->gop_frame_count;
            tav_encoder_free_packet(video_packet);
        }

        free(frame_numbers);
    }

    clock_t end_time = clock();
    double elapsed = (double)(end_time - start_time) / CLOCKS_PER_SEC;

    // Print statistics
    printf("\nEncoding complete:\n");
    printf("  Frames: %lu\n", enc->frames_encoded);
    printf("  GOPs: %lu\n", enc->packets_written);
    printf("  Output size: %lu bytes (%.2f MB)\n", enc->bytes_written, enc->bytes_written / 1048576.0);
    printf("  Encoding speed: %.1f fps\n", enc->frames_encoded / elapsed);
    printf("  Bitrate: %.1f kbps\n",
           enc->bytes_written * 8.0 / (enc->frames_encoded * enc->fps_den / enc->fps_num) / 1000.0);

    // Cleanup
    free(tad_output);
    free(enc->audio_buffer);
    for (int i = 0; i < DT_GOP_SIZE; i++) {
        free(enc->gop_frames[i]);
    }
    free(enc->gop_frames);

    fclose(video_pipe);
    fclose(audio_pipe);
    waitpid(video_pid, NULL, 0);
    waitpid(audio_pid, NULL, 0);

    tav_encoder_free(enc->video_ctx);
    fclose(enc->output_fp);

    return 0;
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char **argv) {
    dt_encoder_t enc;
    memset(&enc, 0, sizeof(enc));

    // Defaults
    enc.width = DT_WIDTH;
    enc.height = DT_HEIGHT_NTSC;
    enc.fps_num = 24;
    enc.fps_den = 1;
    enc.quality_index = 3;
    enc.is_pal = 0;
    enc.is_interlaced = 0;

    // Initialize FEC libraries
    rs_init();
    ldpc_init();

    static struct option long_options[] = {
        {"input",        required_argument, 0, 'i'},
        {"output",       required_argument, 0, 'o'},
        {"quality",      required_argument, 0, 'q'},
        {"ntsc",         no_argument,       0, 'N'},
        {"pal",          no_argument,       0, 'P'},
        {"interlaced",   no_argument,       0, 'I'},
        {"encode-limit", required_argument, 0, 'L'},
        {"verbose",      no_argument,       0, 'v'},
        {"help",         no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "i:o:q:vhNPI", long_options, NULL)) != -1) {
        switch (opt) {
            case 'i':
                enc.input_file = optarg;
                break;
            case 'o':
                enc.output_file = optarg;
                break;
            case 'q':
                enc.quality_index = atoi(optarg);
                if (enc.quality_index < 0) enc.quality_index = 0;
                if (enc.quality_index > 5) enc.quality_index = 5;
                break;
            case 'N':
                enc.is_pal = 0;
                enc.height = DT_HEIGHT_NTSC;
                break;
            case 'P':
                enc.is_pal = 1;
                enc.height = DT_HEIGHT_PAL;
                break;
            case 'I':
                enc.is_interlaced = 1;
                break;
            case 'L':
                enc.encode_limit = atoi(optarg);
                break;
            case 'v':
                enc.verbose = 1;
                break;
            case 'h':
                print_usage(argv[0]);
                return 0;
            default:
                print_usage(argv[0]);
                return 1;
        }
    }

    if (!enc.input_file || !enc.output_file) {
        fprintf(stderr, "Error: Input and output files are required\n");
        print_usage(argv[0]);
        return 1;
    }

    // Probe input file for framerate
    char probe_cmd[4096];
    snprintf(probe_cmd, sizeof(probe_cmd),
             "ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nw=1:nk=1 '%s'",
             enc.input_file);

    FILE *probe = popen(probe_cmd, "r");
    if (probe) {
        char line[256];
        if (fgets(line, sizeof(line), probe)) {
            if (sscanf(line, "%d/%d", &enc.fps_num, &enc.fps_den) != 2) {
                enc.fps_num = 24;
                enc.fps_den = 1;
            }
        }
        pclose(probe);
    }

    printf("\nTAV-DT Encoder (Revised Spec 2025-12-11)\n");
    printf("  Format: %s %s\n", enc.is_pal ? "PAL" : "NTSC",
           enc.is_interlaced ? "interlaced" : "progressive");
    printf("  Resolution: %dx%d (internal: %dx%d)\n", enc.width, enc.height,
           enc.width, enc.is_interlaced ? enc.height / 2 : enc.height);
    printf("  Framerate: %d/%d\n", enc.fps_num, enc.fps_den);
    printf("  Quality: %d\n", enc.quality_index);
    printf("  GOP size: %d\n", DT_GOP_SIZE);
    printf("  Header sizes: main=%dB tad=%dB tav=%dB (after LDPC)\n",
           DT_MAIN_HEADER_SIZE * 2, DT_TAD_HEADER_SIZE * 2, DT_TAV_HEADER_SIZE * 2);

    return run_encoder(&enc);
}
