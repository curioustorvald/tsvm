// Created by CuriousTorvald and Claude on 2025-12-02.
// TAV-DT (Digital Tape) Decoder - Headerless streaming format decoder
// Decodes TAV-DT packets to video (FFV1/rawvideo) and audio (PCMu8)

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include <signal.h>
#include <getopt.h>
#include "decoder_tad.h"         // Shared TAD decoder library
#include "tav_video_decoder.h"   // Shared TAV video decoder library

#define DECODER_VENDOR_STRING "Decoder-TAV-DT 20251202"

// TAV-DT sync patterns (big endian)
#define TAV_DT_SYNC_NTSC  0xE3537A1F  // 720x480
#define TAV_DT_SYNC_PAL   0xD193A745  // 720x576

// Standard TAV quality arrays (0-5, must match encoder)
static const int QUALITY_Y[] = {79, 47, 23, 11, 5, 2, 0};
static const int QUALITY_CO[] = {123, 108, 91, 76, 59, 29, 3};
static const int QUALITY_CG[] = {148, 133, 113, 99, 76, 39, 5};

// TAV-DT packet types (reused from TAV)
#define TAV_PACKET_IFRAME          0x10
#define TAV_PACKET_GOP_UNIFIED     0x12
#define TAV_PACKET_AUDIO_TAD       0x24

// CRC-32 table and functions
static uint32_t crc32_table[256];
static int crc32_table_initialized = 0;

static void init_crc32_table(void) {
    if (crc32_table_initialized) return;
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
    crc32_table_initialized = 1;
}

static uint32_t calculate_crc32(const uint8_t *data, size_t length) {
    init_crc32_table();
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < length; i++) {
        crc = (crc >> 8) ^ crc32_table[(crc ^ data[i]) & 0xFF];
    }
    return crc ^ 0xFFFFFFFF;
}

// DT packet header structure (16 bytes)
typedef struct {
    uint32_t sync_pattern;   // 0xE3537A1F (NTSC) or 0xD193A745 (PAL)
    uint8_t framerate;
    uint8_t flags;           // bit 0=interlaced, bit 1=NTSC framerate, bits 4-7=quality index
    uint16_t reserved;
    uint32_t packet_size;    // Size of data after header
    uint32_t crc32;          // CRC-32 of first 12 bytes
} dt_packet_header_t;

// Decoder state
typedef struct {
    FILE *input_fp;
    FILE *output_video_fp;   // For packet dump mode
    FILE *output_audio_fp;

    // FFmpeg integration
    pid_t ffmpeg_pid;
    FILE *video_pipe;        // Pipe to FFmpeg for RGB24 frames
    char *audio_temp_file;   // Temporary file for PCMu8 audio

    // Video parameters (derived from sync pattern and quality index)
    int width;
    int height;
    int framerate;
    int is_interlaced;
    int is_ntsc_framerate;
    int quality_index;

    // Video decoding context (uses shared library)
    tav_video_context_t *video_ctx;

    // Statistics
    uint64_t packets_processed;
    uint64_t frames_decoded;
    uint64_t bytes_read;
    uint64_t crc_errors;
    uint64_t sync_losses;

    // Options
    int verbose;
    int ffmpeg_output;  // If 1, output to FFmpeg (FFV1/MKV), if 0, dump packets
} dt_decoder_t;

// Read DT packet header and verify
static int read_dt_header(dt_decoder_t *dec, dt_packet_header_t *header) {
    uint8_t header_bytes[16];

    // Read 16-byte header
    size_t bytes_read = fread(header_bytes, 1, 16, dec->input_fp);
    if (bytes_read < 16) {
        if (bytes_read > 0) {
            fprintf(stderr, "Warning: Incomplete header at end of file (%zu bytes)\n", bytes_read);
        }
        return -1;  // EOF or incomplete
    }

    dec->bytes_read += 16;

    // Parse header fields
    header->sync_pattern = (header_bytes[0] << 24) | (header_bytes[1] << 16) |
                          (header_bytes[2] << 8) | header_bytes[3];
    header->framerate = header_bytes[4];
    header->flags = header_bytes[5];
    header->reserved = header_bytes[6] | (header_bytes[7] << 8);
    header->packet_size = header_bytes[8] | (header_bytes[9] << 8) |
                         (header_bytes[10] << 16) | (header_bytes[11] << 24);
    header->crc32 = header_bytes[12] | (header_bytes[13] << 8) |
                   (header_bytes[14] << 16) | (header_bytes[15] << 24);

    // Verify sync pattern
    if (header->sync_pattern != TAV_DT_SYNC_NTSC && header->sync_pattern != TAV_DT_SYNC_PAL) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: Invalid sync pattern 0x%08X at offset %lu\n",
                   header->sync_pattern, dec->bytes_read - 16);
        }
        dec->sync_losses++;
        return -2;  // Invalid sync
    }

    // Calculate and verify CRC-32 of first 12 bytes
    uint32_t calculated_crc = calculate_crc32(header_bytes, 12);
    if (calculated_crc != header->crc32) {
        fprintf(stderr, "Warning: CRC mismatch at offset %lu (expected 0x%08X, got 0x%08X)\n",
               dec->bytes_read - 16, header->crc32, calculated_crc);
        dec->crc_errors++;
        // Continue anyway - data might still be usable
    }

    // Update decoder state from header (first packet only)
    if (dec->packets_processed == 0) {
        dec->width = (header->sync_pattern == TAV_DT_SYNC_NTSC) ? 720 : 720;
        dec->height = (header->sync_pattern == TAV_DT_SYNC_NTSC) ? 480 : 576;
        dec->framerate = header->framerate;
        dec->is_interlaced = header->flags & 0x01;
        dec->is_ntsc_framerate = header->flags & 0x02;
        dec->quality_index = (header->flags >> 4) & 0x0F;

        if (dec->verbose) {
            printf("=== TAV-DT Stream Info ===\n");
            printf("  Format: %s %s\n",
                   (header->sync_pattern == TAV_DT_SYNC_NTSC) ? "NTSC" : "PAL",
                   dec->is_interlaced ? "interlaced" : "progressive");
            printf("  Resolution: %dx%d\n", dec->width, dec->height);
            printf("  Framerate: %d fps%s\n", dec->framerate,
                   dec->is_ntsc_framerate ? " (NTSC)" : "");
            printf("  Quality index: %d\n", dec->quality_index);
            printf("==========================\n\n");
        }
    }

    return 0;
}

// Search for next sync pattern (for recovery from errors)
static int find_next_sync(dt_decoder_t *dec) {
    uint8_t sync_bytes[4] = {0};
    uint8_t byte;

    // NTSC and PAL sync patterns as byte arrays (big endian)
    const uint8_t ntsc_sync[4] = {0xE3, 0x53, 0x7A, 0x1F};
    const uint8_t pal_sync[4] = {0xD1, 0x93, 0xA7, 0x45};

    // Read first 4 bytes to initialize window
    for (int i = 0; i < 4; i++) {
        if (fread(&byte, 1, 1, dec->input_fp) != 1) {
            return -1;  // EOF
        }
        dec->bytes_read++;
        sync_bytes[i] = byte;
    }

    // Check if we already have a sync pattern at current position
    if (memcmp(sync_bytes, ntsc_sync, 4) == 0 || memcmp(sync_bytes, pal_sync, 4) == 0) {
        // Rewind to start of sync pattern
        fseek(dec->input_fp, -4, SEEK_CUR);
        dec->bytes_read -= 4;
        if (dec->verbose) {
            printf("Found sync at offset %lu\n", dec->bytes_read);
        }
        return 0;
    }

    // Sliding window search
    while (fread(&byte, 1, 1, dec->input_fp) == 1) {
        dec->bytes_read++;

        // Shift window
        sync_bytes[0] = sync_bytes[1];
        sync_bytes[1] = sync_bytes[2];
        sync_bytes[2] = sync_bytes[3];
        sync_bytes[3] = byte;

        // Check NTSC sync
        if (memcmp(sync_bytes, ntsc_sync, 4) == 0) {
            // Rewind to start of sync pattern
            fseek(dec->input_fp, -4, SEEK_CUR);
            dec->bytes_read -= 4;
            if (dec->verbose) {
                printf("Found NTSC sync at offset %lu\n", dec->bytes_read);
            }
            return 0;
        }

        // Check PAL sync
        if (memcmp(sync_bytes, pal_sync, 4) == 0) {
            // Rewind to start of sync pattern
            fseek(dec->input_fp, -4, SEEK_CUR);
            dec->bytes_read -= 4;
            if (dec->verbose) {
                printf("Found PAL sync at offset %lu\n", dec->bytes_read);
            }
            return 0;
        }
    }

    return -1;  // EOF without finding sync
}

// Spawn FFmpeg process for video/audio muxing
static int spawn_ffmpeg(dt_decoder_t *dec, const char *output_file) {
    int video_pipe_fd[2];

    // Create pipe for video data
    if (pipe(video_pipe_fd) < 0) {
        fprintf(stderr, "Error: Failed to create video pipe\n");
        return -1;
    }

    // Fork FFmpeg process
    dec->ffmpeg_pid = fork();

    if (dec->ffmpeg_pid < 0) {
        fprintf(stderr, "Error: Failed to fork FFmpeg process\n");
        close(video_pipe_fd[0]);
        close(video_pipe_fd[1]);
        return -1;
    }

    if (dec->ffmpeg_pid == 0) {
        // Child process - execute FFmpeg
        close(video_pipe_fd[1]);  // Close write end

        char video_size[32];
        char framerate[16];
        snprintf(video_size, sizeof(video_size), "%dx%d", dec->width, dec->height);
        snprintf(framerate, sizeof(framerate), "%d", dec->framerate);

        // Redirect video pipe to fd 3
        dup2(video_pipe_fd[0], 3);
        close(video_pipe_fd[0]);

        execl("/usr/bin/ffmpeg", "ffmpeg",
              "-f", "rawvideo",
              "-pixel_format", "rgb24",
              "-video_size", video_size,
              "-framerate", framerate,
              "-i", "pipe:3",              // Video from fd 3
              "-f", "u8",                  // Raw unsigned 8-bit PCM
              "-ar", "32000",              // 32 KHz sample rate
              "-ac", "2",                  // Stereo
              "-i", dec->audio_temp_file,  // Audio from temp file
              "-color_range", "2",
              "-c:v", "ffv1",              // FFV1 codec
              "-level", "3",               // FFV1 level 3
              "-coder", "1",               // Range coder
              "-context", "1",             // Large context
              "-g", "1",                   // GOP size 1 (all I-frames)
              "-slices", "24",             // 24 slices for threading
              "-slicecrc", "1",            // CRC per slice
              "-pixel_format", "rgb24",
              "-color_range", "2",
              "-c:a", "pcm_u8",            // Audio codec (PCM unsigned 8-bit)
              "-f", "matroska",            // MKV container
              output_file,
              "-y",                        // Overwrite output
              "-v", "warning",             // Minimal logging
              (char*)NULL);

        fprintf(stderr, "Error: Failed to execute FFmpeg\n");
        exit(1);
    } else {
        // Parent process
        close(video_pipe_fd[0]);  // Close read end

        dec->video_pipe = fdopen(video_pipe_fd[1], "wb");
        if (!dec->video_pipe) {
            fprintf(stderr, "Error: Failed to open video pipe for writing\n");
            kill(dec->ffmpeg_pid, SIGTERM);
            return -1;
        }
    }

    return 0;
}

// Process single DT packet
static int process_dt_packet(dt_decoder_t *dec) {
    dt_packet_header_t header;

    // Read and verify header
    int result = read_dt_header(dec, &header);
    if (result == -1) {
        return -1;  // EOF
    } else if (result == -2) {
        // Invalid sync - try to recover (sync search always enabled)
        if (find_next_sync(dec) == 0) {
            // Found sync, try again
            return process_dt_packet(dec);
        }
        return -2;  // Unrecoverable sync loss
    }

    // Allocate buffer for packet data
    uint8_t *packet_data = malloc(header.packet_size);
    if (!packet_data) {
        fprintf(stderr, "Error: Failed to allocate %u bytes for packet data\n", header.packet_size);
        return -3;
    }

    // Read packet data
    size_t bytes_read = fread(packet_data, 1, header.packet_size, dec->input_fp);
    if (bytes_read < header.packet_size) {
        fprintf(stderr, "Error: Incomplete packet data (%zu/%u bytes)\n", bytes_read, header.packet_size);
        free(packet_data);
        return -4;
    }

    dec->bytes_read += bytes_read;

    // Parse packet contents:
    // 1. Timecode (8 bytes, no header)
    // 2. TAD audio packet(s) (full packet with 0x24 header)
    // 3. TAV video packet (full packet with 0x10 or 0x12 header)

    size_t offset = 0;

    // 1. Read timecode (8 bytes)
    if (offset + 8 > header.packet_size) {
        fprintf(stderr, "Error: Packet too small for timecode\n");
        free(packet_data);
        return -5;
    }

    uint64_t timecode_ns = 0;
    for (int i = 0; i < 8; i++) {
        timecode_ns |= ((uint64_t)packet_data[offset + i]) << (i * 8);
    }
    offset += 8;

    if (dec->verbose && dec->packets_processed % 100 == 0) {
        double timecode_sec = timecode_ns / 1000000000.0;
        printf("Packet %lu: timecode=%.3fs, size=%u bytes\n",
               dec->packets_processed, timecode_sec, header.packet_size);
    }

    // 2. Process TAD audio packet(s)
    while (offset < header.packet_size && packet_data[offset] == TAV_PACKET_AUDIO_TAD) {
        offset++;  // Skip packet type byte (0x24)

        // Parse TAD packet format: [sample_count(2)][payload_size+7(4)][sample_count(2)][quant_index(1)][compressed_size(4)][compressed_data]
        if (offset + 6 > header.packet_size) break;

        uint16_t sample_count = packet_data[offset] | (packet_data[offset+1] << 8);
        offset += 2;

        uint32_t payload_size_plus_7 = packet_data[offset] | (packet_data[offset+1] << 8) |
                                       (packet_data[offset+2] << 16) | (packet_data[offset+3] << 24);
        offset += 4;

        // Total TAD packet content size (everything after the payload_size_plus_7 field)
        uint32_t tad_content_size = payload_size_plus_7;

        // TAD packet data (sample_count repeat + quant_index + compressed_size + compressed_data)
        if (offset + tad_content_size > header.packet_size) {
            fprintf(stderr, "Warning: TAD packet extends beyond DT packet boundary (offset=%zu, content=%u, packet_size=%u)\n",
                    offset, tad_content_size, header.packet_size);
            break;
        }

        // The TAD decoder expects: [sample_count(2)][quant_index(1)][compressed_size(4)][compressed_data]
        // This is exactly what we have starting at the current offset (the repeated sample_count field)

        // Peek at the TAD packet structure for verbose output
        uint16_t sample_count_repeat = packet_data[offset] | (packet_data[offset+1] << 8);
        uint8_t quant_index = packet_data[offset + 2];
        uint32_t compressed_size = packet_data[offset+3] | (packet_data[offset+4] << 8) |
                                   (packet_data[offset+5] << 16) | (packet_data[offset+6] << 24);

        if (dec->verbose) {
            printf("  TAD: samples=%u, quant=%u, compressed=%u bytes\n",
                   sample_count, quant_index, compressed_size);
        }

        // Decode TAD audio using shared decoder
        // Allocate output buffer (max chunk size * 2 channels)
        uint8_t *pcm_output = malloc(65536 * 2);  // Max chunk size for TAD
        if (!pcm_output) {
            fprintf(stderr, "Error: Failed to allocate audio decode buffer\n");
            offset += tad_content_size;
            continue;
        }

        size_t bytes_consumed = 0;
        size_t samples_decoded = 0;

        // Pass the TAD data starting from repeated sample_count
        // The decoder expects: [sample_count(2)][quant(1)][payload_size(4)][compressed_data]
        int decode_result = tad32_decode_chunk(packet_data + offset, tad_content_size,
                                              pcm_output, &bytes_consumed, &samples_decoded);
        if (decode_result == 0) {
            // Write PCMu8 to output (samples * 2 channels)
            if (dec->output_audio_fp) {
                fwrite(pcm_output, 1, samples_decoded * 2, dec->output_audio_fp);
            }
        } else {
            fprintf(stderr, "Warning: TAD decode failed at offset %zu\n", offset);
        }

        free(pcm_output);

        offset += tad_content_size;
    }

    // 3. Process TAV video packet
    if (offset < header.packet_size) {
        uint8_t packet_type = packet_data[offset];
        offset++;  // Skip packet type byte

        if (packet_type == TAV_PACKET_GOP_UNIFIED) {
            // Read GOP_UNIFIED packet structure: [gop_size(1)][compressed_size(4)][compressed_data]
            if (offset + 5 > header.packet_size) {
                fprintf(stderr, "Warning: Incomplete GOP packet header\n");
                free(packet_data);
                return 0;
            }

            uint8_t gop_size = packet_data[offset];
            offset++;

            uint32_t compressed_size = packet_data[offset] | (packet_data[offset+1] << 8) |
                                      (packet_data[offset+2] << 16) | (packet_data[offset+3] << 24);
            offset += 4;

            if (dec->verbose) {
                printf("  Video packet: GOP_UNIFIED, %u frames, %u bytes compressed\n",
                       gop_size, compressed_size);
            }

            if (offset + compressed_size > header.packet_size) {
                fprintf(stderr, "Warning: GOP data extends beyond packet boundary\n");
                free(packet_data);
                return 0;
            }

            // Allocate frame buffers for GOP
            uint8_t **rgb_frames = malloc(gop_size * sizeof(uint8_t*));
            for (int i = 0; i < gop_size; i++) {
                rgb_frames[i] = malloc(dec->width * dec->height * 3);
            }

            // Decode GOP using shared library
            int decode_result = tav_video_decode_gop(dec->video_ctx,
                                                     packet_data + offset, compressed_size,
                                                     gop_size, rgb_frames);

            if (decode_result == 0) {
                // Write frames to FFmpeg or dump file
                for (int i = 0; i < gop_size; i++) {
                    if (dec->video_pipe) {
                        // Write RGB24 frame to FFmpeg
                        fwrite(rgb_frames[i], 1, dec->width * dec->height * 3, dec->video_pipe);
                    } else if (dec->output_video_fp) {
                        // Packet dump mode - write raw packet
                        if (i == 0) {  // Only write packet once
                            fwrite(&packet_type, 1, 1, dec->output_video_fp);
                            fwrite(&gop_size, 1, 1, dec->output_video_fp);
                            fwrite(&compressed_size, 4, 1, dec->output_video_fp);
                            fwrite(packet_data + offset, 1, compressed_size, dec->output_video_fp);
                        }
                    }
                }
                dec->frames_decoded += gop_size;
            } else {
                fprintf(stderr, "Warning: GOP decode failed: %s\n",
                       tav_video_get_error(dec->video_ctx));
            }

            // Free frame buffers
            for (int i = 0; i < gop_size; i++) {
                free(rgb_frames[i]);
            }
            free(rgb_frames);

        } else if (packet_type == TAV_PACKET_IFRAME) {
            // I-frame packet - for packet dump mode
            if (dec->output_video_fp) {
                fwrite(&packet_type, 1, 1, dec->output_video_fp);
                fwrite(packet_data + offset, 1, header.packet_size - offset, dec->output_video_fp);
            }
            dec->frames_decoded++;
        }
    }

    free(packet_data);
    dec->packets_processed++;

    return 0;
}

static void show_usage(const char *prog_name) {
    printf("Usage: %s [options] -i input.tav -o output.mkv\n\n", prog_name);
    printf("TAV-DT Decoder - Headerless streaming format decoder\n\n");
    printf("Options:\n");
    printf("  -i, --input FILE         Input TAV-DT file (required)\n");
    printf("  -o, --output FILE        Output MKV file (default: input with .mkv extension)\n");
    printf("  -v, --verbose            Verbose output\n");
    printf("  -h, --help               Show this help\n\n");
    printf("Notes:\n");
    printf("  - Audio is decoded to temporary file in /tmp/\n");
    printf("  - Sync pattern searching is always enabled\n\n");
    printf("Example:\n");
    printf("  %s -i stream.tavdt              # Creates stream.mkv\n", prog_name);
    printf("  %s -i stream.tavdt -o out.mkv   # Creates out.mkv\n\n", prog_name);
}

int main(int argc, char *argv[]) {
    dt_decoder_t decoder = {0};
    char *input_file = NULL;
    char *output_file = NULL;

    // Parse command line options
    static struct option long_options[] = {
        {"input",       required_argument, 0, 'i'},
        {"output",      required_argument, 0, 'o'},
        {"verbose",     no_argument,       0, 'v'},
        {"help",        no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "i:o:vh", long_options, NULL)) != -1) {
        switch (opt) {
            case 'i':
                input_file = optarg;
                break;
            case 'o':
                output_file = optarg;
                break;
            case 'v':
                decoder.verbose = 1;
                break;
            case 'h':
                show_usage(argv[0]);
                return 0;
            default:
                show_usage(argv[0]);
                return 1;
        }
    }

    if (!input_file) {
        fprintf(stderr, "Error: Input file must be specified\n");
        show_usage(argv[0]);
        return 1;
    }

    // Generate output filename if not provided
    if (!output_file) {
        size_t input_len = strlen(input_file);
        output_file = malloc(input_len + 32);  // Extra space for extension

        // Find the last directory separator
        const char *basename_start = strrchr(input_file, '/');
        if (!basename_start) basename_start = strrchr(input_file, '\\');
        basename_start = basename_start ? basename_start + 1 : input_file;

        // Copy directory part
        size_t dir_len = basename_start - input_file;
        strncpy(output_file, input_file, dir_len);

        // Find the extension
        const char *ext = strrchr(basename_start, '.');
        if (ext && (strcmp(ext, ".tavdt") == 0 || strcmp(ext, ".tav") == 0 || strcmp(ext, ".dt") == 0)) {
            // Copy basename without extension
            size_t name_len = ext - basename_start;
            strncpy(output_file + dir_len, basename_start, name_len);
            output_file[dir_len + name_len] = '\0';
        } else {
            // No recognized extension, copy entire basename
            strcpy(output_file + dir_len, basename_start);
        }

        // Append .mkv extension
        strcat(output_file, ".mkv");

        if (decoder.verbose) {
            printf("Auto-generated output path: %s\n", output_file);
        }
    }

    // Open input file
    decoder.input_fp = fopen(input_file, "rb");
    if (!decoder.input_fp) {
        fprintf(stderr, "Error: Cannot open input file: %s\n", input_file);
        return 1;
    }

    // Determine output mode based on file extension
    int output_is_mkv = (strstr(output_file, ".mkv") != NULL || strstr(output_file, ".MKV") != NULL);
    decoder.ffmpeg_output = output_is_mkv;

    // Create temporary audio file in /tmp/ (using process ID for uniqueness)
    char temp_audio_file[256];
    snprintf(temp_audio_file, sizeof(temp_audio_file), "/tmp/tav_dt_audio_%d.pcm", getpid());
    decoder.audio_temp_file = strdup(temp_audio_file);

    // Open audio output file
    decoder.output_audio_fp = fopen(decoder.audio_temp_file, "wb");
    if (!decoder.output_audio_fp) {
        fprintf(stderr, "Error: Cannot open temporary audio file: %s\n", decoder.audio_temp_file);
        fclose(decoder.input_fp);
        return 1;
    }

    // In packet dump mode, open video packet file
    char video_packets_file[256];
    if (!decoder.ffmpeg_output) {
        snprintf(video_packets_file, sizeof(video_packets_file), "%s.packets", output_file);
        decoder.output_video_fp = fopen(video_packets_file, "wb");
    }

    printf("TAV-DT Decoder - %s\n", DECODER_VENDOR_STRING);
    printf("Input: %s\n", input_file);
    if (decoder.ffmpeg_output) {
        printf("Output: %s (FFV1/MKV)\n", output_file);
    } else {
        printf("Output video: %s (packet dump)\n", video_packets_file);
    }
    printf("\n");

    // Find first sync pattern (works even when sync is at offset 0)
    if (decoder.verbose) {
        printf("Searching for first sync pattern...\n");
    }
    if (find_next_sync(&decoder) != 0) {
        fprintf(stderr, "Error: No sync pattern found in file\n");
        fclose(decoder.input_fp);
        fclose(decoder.output_audio_fp);
        if (decoder.output_video_fp) fclose(decoder.output_video_fp);
        return 1;
    }

    // Read first DT packet header to get video parameters (without processing content)
    dt_packet_header_t first_header;
    if (read_dt_header(&decoder, &first_header) != 0) {
        fprintf(stderr, "Error: Failed to read first packet header\n");
        fclose(decoder.input_fp);
        fclose(decoder.output_audio_fp);
        if (decoder.output_video_fp) fclose(decoder.output_video_fp);
        return 1;
    }

    // Rewind to start of header so process_dt_packet() can read it again
    fseek(decoder.input_fp, -16, SEEK_CUR);

    // Validate quality index (0-5)
    if (decoder.quality_index > 5) {
        fprintf(stderr, "Warning: Quality index %d out of range (0-5), clamping to 5\n", decoder.quality_index);
        decoder.quality_index = 5;
    }

    // Map quality index to actual quantiser values using standard TAV arrays
    uint16_t quant_y = QUALITY_Y[decoder.quality_index];
    uint16_t quant_co = QUALITY_CO[decoder.quality_index];
    uint16_t quant_cg = QUALITY_CG[decoder.quality_index];

    // Initialize video decoder with TAV-DT fixed parameters
    tav_video_params_t video_params = {
        .width = decoder.width,
        .height = decoder.height,
        .decomp_levels = 4,           // TAV-DT fixed: 4 spatial levels
        .temporal_levels = 2,         // TAV-DT fixed: 2 temporal levels
        .wavelet_filter = 1,          // TAV-DT fixed: CDF 9/7
        .temporal_wavelet = 0,        // TAV-DT fixed: Haar
        .entropy_coder = 1,           // TAV-DT fixed: EZBC
        .channel_layout = 0,          // TAV-DT fixed: YCoCg-R
        .perceptual_tuning = 1,       // TAV-DT fixed: Perceptual
        .quantiser_y = (uint8_t)quant_y,     // From DT quality map
        .quantiser_co = (uint8_t)quant_co,
        .quantiser_cg = (uint8_t)quant_cg,
        .encoder_preset = 1,          // Sports mode
        .monoblock = 1               // TAV-DT fixed: Single tile
    };

    decoder.video_ctx = tav_video_create(&video_params);
    if (!decoder.video_ctx) {
        fprintf(stderr, "Error: Failed to create video decoder context\n");
        fclose(decoder.input_fp);
        fclose(decoder.output_audio_fp);
        if (decoder.output_video_fp) fclose(decoder.output_video_fp);
        return 1;
    }

    tav_video_set_verbose(decoder.video_ctx, decoder.verbose);

    int result;

    // In MKV mode, use two-pass approach:
    // Pass 1: Extract all audio (video_pipe is NULL)
    // Pass 2: Spawn FFmpeg and decode all video (audio file is complete)
    if (decoder.ffmpeg_output) {
        // Save starting position
        long start_pos = ftell(decoder.input_fp);

        // Pass 1: Process all packets for audio only
        printf("\n=== Pass 1: Extracting audio ===\n");
        while ((result = process_dt_packet(&decoder)) == 0) {
            // Continue processing (only audio is written)
        }

        // Close and flush audio file
        fclose(decoder.output_audio_fp);
        decoder.output_audio_fp = NULL;

        // Spawn FFmpeg with complete audio file
        if (spawn_ffmpeg(&decoder, output_file) != 0) {
            fprintf(stderr, "Error: Failed to spawn FFmpeg process\n");
            tav_video_free(decoder.video_ctx);
            fclose(decoder.input_fp);
            return 1;
        }

        // Pass 2: Rewind and process all packets for video
        printf("\n=== Pass 2: Decoding video ===\n");
        fseek(decoder.input_fp, start_pos, SEEK_SET);
        decoder.packets_processed = 0;  // Reset statistics
        decoder.frames_decoded = 0;
        decoder.bytes_read = 0;

        while ((result = process_dt_packet(&decoder)) == 0) {
            // Continue processing (only video is written)
        }
    } else {
        // Dump mode: Single pass for both audio and video
        while ((result = process_dt_packet(&decoder)) == 0) {
            // Continue processing
        }
    }

    // Cleanup
    if (decoder.video_pipe) {
        fclose(decoder.video_pipe);
        waitpid(decoder.ffmpeg_pid, NULL, 0);
    }

    if (decoder.video_ctx) {
        tav_video_free(decoder.video_ctx);
    }

    fclose(decoder.input_fp);
    if (decoder.output_audio_fp) fclose(decoder.output_audio_fp);
    if (decoder.output_video_fp) fclose(decoder.output_video_fp);

    // Clean up temporary audio file
    if (decoder.audio_temp_file) {
        unlink(decoder.audio_temp_file);
        free(decoder.audio_temp_file);
    }

    // Print statistics
    printf("\n=== Decoding Complete ===\n");
    printf("  Packets processed: %lu\n", decoder.packets_processed);
    printf("  Frames decoded: %lu (estimate)\n", decoder.frames_decoded);
    printf("  Bytes read: %lu\n", decoder.bytes_read);
    printf("  CRC errors: %lu\n", decoder.crc_errors);
    printf("  Sync losses: %lu\n", decoder.sync_losses);
    printf("=========================\n");

    return 0;
}
