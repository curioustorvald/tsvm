// TAV Packet Inspector - Comprehensive packet analysis tool for TAV files
// to compile: gcc -o tav_inspector tav_inspector.c -lzstd -lm
// Created by CuriousTorvald and Claude on 2025-10-14
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <getopt.h>
#include <zstd.h>

// Frame mode constants (from TAV spec)
#define FRAME_MODE_SKIP  0x00
#define FRAME_MODE_INTRA 0x01
#define FRAME_MODE_DELTA 0x02

// Packet type constants
#define TAV_PACKET_IFRAME         0x10
#define TAV_PACKET_PFRAME         0x11
#define TAV_PACKET_GOP_UNIFIED    0x12  // Unified 3D DWT GOP (all frames in single block)
#define TAV_PACKET_GOP_UNIFIED_MOTION    0x13
#define TAV_PACKET_PFRAME_RESIDUAL 0x14  // P-frame with MPEG-style residual coding (block motion compensation)
#define TAV_PACKET_BFRAME_RESIDUAL 0x15  // B-frame with MPEG-style residual coding (bidirectional prediction)
#define TAV_PACKET_PFRAME_ADAPTIVE 0x16  // P-frame with adaptive quad-tree block partitioning
#define TAV_PACKET_BFRAME_ADAPTIVE 0x17  // B-frame with adaptive quad-tree block partitioning (bidirectional prediction)
#define TAV_PACKET_AUDIO_MP2      0x20
#define TAV_PACKET_AUDIO_PCM8     0x21
#define TAV_PACKET_SUBTITLE       0x30
#define TAV_PACKET_SUBTITLE_KAR   0x31
#define TAV_PACKET_AUDIO_TRACK    0x40
#define TAV_PACKET_VIDEO_CH2_I    0x70
#define TAV_PACKET_VIDEO_CH2_P    0x71
#define TAV_PACKET_VIDEO_CH3_I    0x72
#define TAV_PACKET_VIDEO_CH3_P    0x73
#define TAV_PACKET_VIDEO_CH4_I    0x74
#define TAV_PACKET_VIDEO_CH4_P    0x75
#define TAV_PACKET_VIDEO_CH5_I    0x76
#define TAV_PACKET_VIDEO_CH5_P    0x77
#define TAV_PACKET_VIDEO_CH6_I    0x78
#define TAV_PACKET_VIDEO_CH6_P    0x79
#define TAV_PACKET_VIDEO_CH7_I    0x7A
#define TAV_PACKET_VIDEO_CH7_P    0x7B
#define TAV_PACKET_VIDEO_CH8_I    0x7C
#define TAV_PACKET_VIDEO_CH8_P    0x7D
#define TAV_PACKET_VIDEO_CH9_I    0x7E
#define TAV_PACKET_VIDEO_CH9_P    0x7F
#define TAV_PACKET_EXIF           0xE0
#define TAV_PACKET_ID3V1          0xE1
#define TAV_PACKET_ID3V2          0xE2
#define TAV_PACKET_VORBIS_COMMENT 0xE3
#define TAV_PACKET_CD_TEXT        0xE4
#define TAV_PACKET_EXTENDED_HDR   0xEF
#define TAV_PACKET_LOOP_START     0xF0
#define TAV_PACKET_LOOP_END       0xF1
#define TAV_PACKET_GOP_SYNC       0xFC  // GOP sync packet (N frames decoded)
#define TAV_PACKET_TIMECODE       0xFD
#define TAV_PACKET_SYNC_NTSC      0xFE
#define TAV_PACKET_SYNC           0xFF
#define TAV_PACKET_NOOP           0x00

// Statistics structure
typedef struct {
    int iframe_count;
    int pframe_count;
    int pframe_intra_count;
    int pframe_delta_count;
    int pframe_skip_count;
    int gop_unified_count;
    int gop_unified_motion_count;
    int gop_sync_count;
    int total_gop_frames;
    int audio_count;
    int subtitle_count;
    int timecode_count;
    int sync_count;
    int sync_ntsc_count;
    int extended_header_count;
    int metadata_count;
    int loop_point_count;
    int mux_video_count;
    int unknown_count;
    uint64_t total_video_bytes;
    uint64_t total_audio_bytes;
} packet_stats_t;

// Display options
typedef struct {
    int show_all;
    int show_video;
    int show_audio;
    int show_subtitles;
    int show_timecode;
    int show_metadata;
    int show_sync;
    int show_extended;
    int verbose;
    int summary_only;
} display_options_t;

const char* get_packet_type_name(uint8_t type) {
    switch (type) {
        case TAV_PACKET_IFRAME: return "I-FRAME";
        case TAV_PACKET_PFRAME: return "P-FRAME";
        case TAV_PACKET_GOP_UNIFIED: return "GOP (3D DWT Unified)";
        case TAV_PACKET_GOP_UNIFIED_MOTION: return "GOP (3D DWT Unified with Motion Data)";
        case TAV_PACKET_PFRAME_RESIDUAL: return "P-FRAME (residual)";
        case TAV_PACKET_BFRAME_RESIDUAL: return "B-FRAME (residual)";
        case TAV_PACKET_PFRAME_ADAPTIVE: return "P-FRAME (quadtree)";
        case TAV_PACKET_BFRAME_ADAPTIVE: return "B-FRAME (quadtree)";
        case TAV_PACKET_AUDIO_MP2: return "AUDIO MP2";
        case TAV_PACKET_AUDIO_PCM8: return "AUDIO PCM8 (zstd)";
        case TAV_PACKET_SUBTITLE: return "SUBTITLE (Simple)";
        case TAV_PACKET_SUBTITLE_KAR: return "SUBTITLE (Karaoke)";
        case TAV_PACKET_AUDIO_TRACK: return "AUDIO TRACK (Separate MP2)";
        case TAV_PACKET_EXIF: return "METADATA (EXIF)";
        case TAV_PACKET_ID3V1: return "METADATA (ID3v1)";
        case TAV_PACKET_ID3V2: return "METADATA (ID3v2)";
        case TAV_PACKET_VORBIS_COMMENT: return "METADATA (Vorbis)";
        case TAV_PACKET_CD_TEXT: return "METADATA (CD-Text)";
        case TAV_PACKET_EXTENDED_HDR: return "EXTENDED HEADER";
        case TAV_PACKET_LOOP_START: return "LOOP START";
        case TAV_PACKET_LOOP_END: return "LOOP END";
        case TAV_PACKET_GOP_SYNC: return "GOP SYNC";
        case TAV_PACKET_TIMECODE: return "TIMECODE";
        case TAV_PACKET_SYNC_NTSC: return "SYNC (NTSC)";
        case TAV_PACKET_SYNC: return "SYNC";
        case TAV_PACKET_NOOP: return "NO-OP";
        default:
            if (type >= 0x70 && type <= 0x7F) {
                return "MUX VIDEO";
            }
            return "UNKNOWN";
    }
}

int should_display_packet(uint8_t type, display_options_t *opts) {
    if (opts->show_all) return 1;

    if (opts->show_video && (type == TAV_PACKET_IFRAME || type == TAV_PACKET_PFRAME ||
        type == TAV_PACKET_GOP_UNIFIED || type == TAV_PACKET_GOP_SYNC ||
        (type >= 0x70 && type <= 0x7F))) return 1;
    if (opts->show_audio && type == TAV_PACKET_AUDIO_MP2) return 1;
    if (opts->show_subtitles && (type == TAV_PACKET_SUBTITLE || type == TAV_PACKET_SUBTITLE_KAR)) return 1;
    if (opts->show_timecode && type == TAV_PACKET_TIMECODE) return 1;
    if (opts->show_metadata && (type >= 0xE0 && type <= 0xE4)) return 1;
    if (opts->show_sync && (type == TAV_PACKET_SYNC || type == TAV_PACKET_SYNC_NTSC)) return 1;
    if (opts->show_extended && type == TAV_PACKET_EXTENDED_HDR) return 1;

    return 0;
}

void print_subtitle_packet(FILE *fp, uint32_t size, int is_karaoke, int verbose) {
    if (!verbose) {
        fseek(fp, size, SEEK_CUR);
        return;
    }

    // Read 24-bit index
    uint32_t index = 0;
    for (int i = 0; i < 3; i++) {
        uint8_t byte;
        if (fread(&byte, 1, 1, fp) != 1) return;
        index |= (byte << (i * 8));
    }

    uint8_t opcode;
    if (fread(&opcode, 1, 1, fp) != 1) return;

    printf(" [Index=%u, Opcode=0x%02X", index, opcode);

    switch (opcode) {
        case 0x01: printf(" (SHOW)"); break;
        case 0x02: printf(" (HIDE)"); break;
        case 0x03: printf(" (MOVE)"); break;
        case 0x80: printf(" (UPLOAD LOW FONT)"); break;
        case 0x81: printf(" (UPLOAD HIGH FONT)"); break;
        default:
            if (opcode >= 0x10 && opcode <= 0x2F) printf(" (SHOW LANG)");
            else if (opcode >= 0x30 && opcode <= 0x41) printf(" (REVEAL)");
            break;
    }
    printf("]");

    // Read and display text content for SHOW commands
    int remaining = size - 4;  // Already read 3 (index) + 1 (opcode)
    if ((opcode == 0x01 || (opcode >= 0x10 && opcode <= 0x2F) || (opcode >= 0x30 && opcode <= 0x41)) && remaining > 0) {
        char *text = malloc(remaining + 1);
        if (text && fread(text, 1, remaining, fp) == remaining) {
            text[remaining] = '\0';

            // Truncate long text for display
            /*if (remaining > 60) {
                text[57] = '.';
                text[58] = '.';
                text[59] = '.';
                text[60] = '\0';
            }*/

            // Clean up newlines and control characters for display
            for (int i = 0; text[i]; i++) {
                if (text[i] == '\n' || text[i] == '\r' || text[i] == '\t') {
                    text[i] = ' ';
                }
            }

            printf(" Text: \"%s\"", text);
            free(text);
        } else {
            free(text);
            fseek(fp, remaining, SEEK_CUR);
        }
    } else {
        // Skip remaining payload for other opcodes
        fseek(fp, remaining, SEEK_CUR);
    }
}

void print_extended_header(FILE *fp, int verbose) {
    uint16_t num_pairs;
    if (fread(&num_pairs, sizeof(uint16_t), 1, fp) != 1) {
        printf("ERROR: Failed to read KV pair count\n");
        return;
    }

    printf(" - %u key-value pairs", num_pairs);
    if (verbose) {
        printf(":\n");
    }

    for (int i = 0; i < num_pairs; i++) {
        char key[5] = {0};
        uint8_t value_type;

        if (fread(key, 1, 4, fp) != 4 || fread(&value_type, 1, 1, fp) != 1) {
            if (verbose) printf("    ERROR: Failed to read KV pair %d\n", i);
            break;
        }

        if (verbose) {
            const char *value_type_str = "Unknown";
            switch (value_type) {
                case 0x00: value_type_str = "Int16"; break;
                case 0x01: value_type_str = "Int24"; break;
                case 0x02: value_type_str = "Int32"; break;
                case 0x03: value_type_str = "Int48"; break;
                case 0x04: value_type_str = "Int64"; break;
                case 0x10: value_type_str = "Bytes"; break;
            }

            printf("    %.4s (type: %s (0x%02X)): ", key, value_type_str, value_type);
        }


        if (value_type == 0x04) {  // Uint64
            uint64_t value;
            if (fread(&value, sizeof(uint64_t), 1, fp) != 1) {
                if (verbose) printf("ERROR reading value\n");
                break;
            }

            if (verbose) {
                if (strcmp(key, "CDAT") == 0) {
                    time_t time_sec = value / 1000000000ULL;
                    struct tm *time_info = gmtime(&time_sec);
                    if (time_info) {
                        char time_str[64];
                        strftime(time_str, sizeof(time_str), "%a %b %d %H:%M:%S %Y UTC", time_info);
                        printf("%s", time_str);
                    }
                } else {
                    printf("%.6f seconds", value / 1000000000.0);
                }
            }
        } else if (value_type == 0x10) {  // Bytes
            uint16_t length;
            if (fread(&length, sizeof(uint16_t), 1, fp) != 1) {
                if (verbose) printf("ERROR reading length\n");
                break;
            }

            char *data = malloc(length + 1);
            if (fread(data, 1, length, fp) != length) {
                if (verbose) printf("ERROR reading data\n");
                free(data);
                break;
            }

            if (verbose) {
                data[length] = '\0';

                // Truncate long strings
                /*if (length > 60) {
                    data[57] = '.';
                    data[58] = '.';
                    data[59] = '.';
                    data[60] = '\0';
                }*/
                printf("\"%s\"", data);
            }
            free(data);
        } else {
            if (verbose) printf("Unknown type");
        }

        if (verbose && i < num_pairs - 1) {
            printf("\n");
        }
    }
}

// Frame info structure
typedef struct {
    int mode;              // 0=SKIP, 1=INTRA, 2=DELTA, -1=error
    uint8_t quantiser;     // Quantiser override (0xFF = default)
} frame_info_t;

// Read frame mode and quantiser from compressed frame data
// Works for both I-frames and P-frames
frame_info_t get_frame_info(FILE *fp, uint32_t compressed_size) {
    frame_info_t info = {-1, 0xFF};

    // Read compressed data
    uint8_t *compressed_data = malloc(compressed_size);
    if (!compressed_data) {
        fseek(fp, compressed_size, SEEK_CUR);
        return info;
    }

    if (fread(compressed_data, 1, compressed_size, fp) != compressed_size) {
        free(compressed_data);
        return info;
    }

    // Allocate buffer for decompression
    // TAV frames are at most ~1.5MB decompressed, use 2MB to be safe
    size_t const decompress_size = 2 * 1024 * 1024;  // 2MB
    uint8_t *decompressed_data = malloc(decompress_size);
    if (!decompressed_data) {
        free(compressed_data);
        return info;
    }

    // Decompress
    size_t actual_size = ZSTD_decompress(decompressed_data, decompress_size, compressed_data, compressed_size);
    free(compressed_data);

    if (ZSTD_isError(actual_size) || actual_size < 2) {
        free(decompressed_data);
        return info;
    }

    // Read mode byte (first byte of decompressed data)
    info.mode = decompressed_data[0];

    // Read quantiser override (second byte) if mode is not SKIP
    if (info.mode != FRAME_MODE_SKIP && actual_size >= 2) {
        info.quantiser = decompressed_data[1];
    }

    free(decompressed_data);
    return info;
}

void print_help(const char *program_name) {
    printf("TAV Packet Inspector - Comprehensive packet analysis tool\n");
    printf("Usage: %s [options] <tav_file>\n\n", program_name);
    printf("Options:\n");
    printf("  -a, --all          Show all packets (default)\n");
    printf("  -v, --video        Show video packets only\n");
    printf("  -u, --audio        Show audio packets only\n");
    printf("  -s, --subtitles    Show subtitle packets only\n");
    printf("  -t, --timecode     Show timecode packets only\n");
    printf("  -m, --metadata     Show metadata packets only\n");
    printf("  -x, --extended     Show extended header only\n");
    printf("  -S, --sync         Show sync packets\n");
    printf("  --summary          Show summary statistics only\n");
    printf("  -h, --help         Show this help\n\n");
    printf("Examples:\n");
    printf("  %s video.mv3                    # Show all packets\n", program_name);
    printf("  %s -v video.mv3                 # Show video packets only\n", program_name);
    printf("  %s -V video.mv3                 # Verbose output\n", program_name);
    printf("  %s --summary video.mv3          # Statistics only\n", program_name);
}

int main(int argc, char *argv[]) {
    display_options_t opts = {0};
    opts.show_all = 1;  // Default: show all

    // Track absolute frame number
    int current_frame = 0;

    static struct option long_options[] = {
        {"all", no_argument, 0, 'a'},
        {"video", no_argument, 0, 'v'},
        {"audio", no_argument, 0, 'u'},
        {"subtitles", no_argument, 0, 's'},
        {"timecode", no_argument, 0, 't'},
        {"metadata", no_argument, 0, 'm'},
        {"extended", no_argument, 0, 'x'},
        {"sync", no_argument, 0, 'S'},
        {"summary", no_argument, 0, 1000},
        {"help", no_argument, 0, 'h'},
        {0, 0, 0, 0}
    };

    int c;
    while ((c = getopt_long(argc, argv, "avustmxSVh", long_options, NULL)) != -1) {
        switch (c) {
            case 'a': opts.show_all = 1; break;
            case 'v': opts.show_video = 1; opts.show_all = 0; break;
            case 'u': opts.show_audio = 1; opts.show_all = 0; break;
            case 's': opts.show_subtitles = 1; opts.show_all = 0; break;
            case 't': opts.show_timecode = 1; opts.show_all = 0; break;
            case 'm': opts.show_metadata = 1; opts.show_all = 0; break;
            case 'x': opts.show_extended = 1; opts.show_all = 0; break;
            case 'S': opts.show_sync = 1; opts.show_all = 0; break;
            case 1000: opts.summary_only = 1; break;
            case 'h':
                print_help(argv[0]);
                return 0;
            default:
                print_help(argv[0]);
                return 1;
        }
    }

    opts.verbose = 1;

    if (optind >= argc) {
        fprintf(stderr, "Error: No input file specified\n\n");
        print_help(argv[0]);
        return 1;
    }

    const char *filename = argv[optind];
    FILE *fp = fopen(filename, "rb");
    if (!fp) {
        fprintf(stderr, "Error: Cannot open file %s\n", filename);
        return 1;
    }

    // Skip header (32 bytes)
    fseek(fp, 32, SEEK_SET);

    if (!opts.summary_only) {
        printf("TAV Packet Inspector\n");
        printf("File: %s\n", filename);
        printf("==================================================\n\n");
    }

    packet_stats_t stats = {0};
    int packet_num = 0;

    while (!feof(fp)) {
        long packet_offset = ftell(fp);
        uint8_t packet_type;
        if (fread(&packet_type, 1, 1, fp) != 1) break;

        int display = should_display_packet(packet_type, &opts);

        if (!opts.summary_only && display) {
            printf("Packet %d (offset 0x%lX): Type 0x%02X (%s)",
                   packet_num, packet_offset, packet_type, get_packet_type_name(packet_type));
        }

        switch (packet_type) {
            case TAV_PACKET_EXTENDED_HDR: {
                stats.extended_header_count++;
                if (!opts.summary_only && display) {
                    print_extended_header(fp, opts.verbose);
                } else {
                    // Skip extended header
                    uint16_t num_pairs;
                    fread(&num_pairs, sizeof(uint16_t), 1, fp);
                    for (int i = 0; i < num_pairs; i++) {
                        fseek(fp, 5, SEEK_CUR);  // key + type
                        uint8_t type;
                        fseek(fp, -1, SEEK_CUR);
                        fread(&type, 1, 1, fp);
                        if (type == 0x04) fseek(fp, 8, SEEK_CUR);
                        else if (type == 0x10) {
                            uint16_t len;
                            fread(&len, 2, 1, fp);
                            fseek(fp, len, SEEK_CUR);
                        }
                    }
                }
                break;
            }

            case TAV_PACKET_TIMECODE: {
                stats.timecode_count++;
                uint64_t timecode_ns;
                if (fread(&timecode_ns, sizeof(uint64_t), 1, fp) != 1) break;

                if (!opts.summary_only && display) {
                    double timecode_sec = timecode_ns / 1000000000.0;
                    printf(" - %.6f seconds (Frame %d)", timecode_sec, current_frame);
                }
                break;
            }

            case TAV_PACKET_GOP_UNIFIED: case TAV_PACKET_GOP_UNIFIED_MOTION: {
                // Unified GOP packet: [gop_size][motion_vectors...][compressed_size][data]
                uint8_t gop_size;
                if (fread(&gop_size, 1, 1, fp) != 1) break;

                // Read motion vectors
                uint32_t size0 = 0;
                if (packet_type == TAV_PACKET_GOP_UNIFIED_MOTION) {
                    if (fread(&size0, sizeof(uint32_t), 1, fp) != 1) { break; }
                    stats.total_video_bytes += size0;
                    stats.gop_unified_motion_count++;
                    fseek(fp, size0, SEEK_CUR);
                }

                // Read compressed data size
                uint32_t size1;
                if (fread(&size1, sizeof(uint32_t), 1, fp) != 1) { break; }
                stats.total_video_bytes += size1;
                fseek(fp, size1, SEEK_CUR);


                stats.total_gop_frames += gop_size;
                if (packet_type == TAV_PACKET_GOP_UNIFIED) {
                    stats.gop_unified_count++;
                }

                if (!opts.summary_only && display) {
                    printf(" - GOP size=%u, data size=%u bytes (%.2f bytes/frame)",
                           gop_size, (size0 + size1), (double)(size0 + size1) / gop_size);
                }

                break;
            }

            case TAV_PACKET_GOP_SYNC: {
                // GOP sync packet: [frame_count]
                uint8_t frame_count;
                if (fread(&frame_count, 1, 1, fp) != 1) break;

                stats.gop_sync_count++;
                current_frame += frame_count;  // Advance frame counter

                if (!opts.summary_only && display) {
                    printf(" - %u frames decoded from GOP block", frame_count);
                }
                break;
            }

            case TAV_PACKET_IFRAME:
            case TAV_PACKET_PFRAME:
            case TAV_PACKET_VIDEO_CH2_I:
            case TAV_PACKET_VIDEO_CH2_P:
            case TAV_PACKET_VIDEO_CH3_I:
            case TAV_PACKET_VIDEO_CH3_P:
            case TAV_PACKET_VIDEO_CH4_I:
            case TAV_PACKET_VIDEO_CH4_P:
            case TAV_PACKET_VIDEO_CH5_I:
            case TAV_PACKET_VIDEO_CH5_P:
            case TAV_PACKET_VIDEO_CH6_I:
            case TAV_PACKET_VIDEO_CH6_P:
            case TAV_PACKET_VIDEO_CH7_I:
            case TAV_PACKET_VIDEO_CH7_P:
            case TAV_PACKET_VIDEO_CH8_I:
            case TAV_PACKET_VIDEO_CH8_P:
            case TAV_PACKET_VIDEO_CH9_I:
            case TAV_PACKET_VIDEO_CH9_P: {
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;
                stats.total_video_bytes += size;

                // Get frame info (mode and quantiser) for both I-frames and P-frames
                frame_info_t frame_info = get_frame_info(fp, size);

                if (packet_type == TAV_PACKET_PFRAME ||
                    (packet_type >= 0x71 && packet_type <= 0x7F && (packet_type & 1))) {
                    // This is a P-frame (main or multiplexed)
                    if (packet_type == TAV_PACKET_PFRAME) {
                        stats.pframe_count++;
                        if (frame_info.mode == FRAME_MODE_INTRA) stats.pframe_intra_count++;
                        else if (frame_info.mode == FRAME_MODE_DELTA) stats.pframe_delta_count++;
                        else if (frame_info.mode == FRAME_MODE_SKIP) stats.pframe_skip_count++;
                        current_frame++;  // Increment for P-frame
                    } else {
                        stats.mux_video_count++;
                    }
                } else {
                    // I-frame
                    if (packet_type == TAV_PACKET_IFRAME) {
                        stats.iframe_count++;
                        current_frame++;  // Increment for I-frame
                    } else {
                        stats.mux_video_count++;
                    }
                }

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes", size);

                    // Show frame mode (for both I-frames and P-frames)
                    if (frame_info.mode >= 0) {
                        if (frame_info.mode == FRAME_MODE_SKIP) printf(" [SKIP]");
                        else if (frame_info.mode == FRAME_MODE_DELTA) printf(" [DELTA]");
                        else if (frame_info.mode == FRAME_MODE_INTRA) printf(" [INTRA]");

                        // Show quantiser override if not default
                        if (frame_info.mode != FRAME_MODE_SKIP) {
                            if (frame_info.quantiser != 0xFF) {
                                printf(" [Q=%u]", frame_info.quantiser);
                            }
                        }
                    }

                    if (packet_type >= 0x70 && packet_type <= 0x7F) {
                        int channel = ((packet_type - 0x70) / 2) + 2;
                        printf(" (Channel %d)", channel);
                    }
                }
                break;
            }

            case TAV_PACKET_AUDIO_MP2: {
                stats.audio_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;
                stats.total_audio_bytes += size;

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes", size);
                }
                fseek(fp, size, SEEK_CUR);
                break;
            }

            case TAV_PACKET_AUDIO_PCM8: {
                stats.audio_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;
                stats.total_audio_bytes += size;

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes (zstd compressed)", size);
                }
                fseek(fp, size, SEEK_CUR);
                break;
            }

            case TAV_PACKET_AUDIO_TRACK: {
                stats.audio_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;
                stats.total_audio_bytes += size;

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes (separate track)", size);
                }
                fseek(fp, size, SEEK_CUR);
                break;
            }

            case TAV_PACKET_SUBTITLE:
            case TAV_PACKET_SUBTITLE_KAR: {
                stats.subtitle_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes", size);
                    print_subtitle_packet(fp, size, packet_type == TAV_PACKET_SUBTITLE_KAR, opts.verbose);
                } else {
                    fseek(fp, size, SEEK_CUR);
                }
                break;
            }

            case TAV_PACKET_EXIF:
            case TAV_PACKET_ID3V1:
            case TAV_PACKET_ID3V2:
            case TAV_PACKET_VORBIS_COMMENT:
            case TAV_PACKET_CD_TEXT: {
                stats.metadata_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes", size);
                }
                fseek(fp, size, SEEK_CUR);
                break;
            }

            case TAV_PACKET_LOOP_START:
            case TAV_PACKET_LOOP_END:
                stats.loop_point_count++;
                if (!opts.summary_only && display) {
                    printf(" (no payload)");
                }
                break;

            case TAV_PACKET_SYNC:
                stats.sync_count++;
                break;

            case TAV_PACKET_SYNC_NTSC:
                stats.sync_ntsc_count++;
                break;

            case TAV_PACKET_NOOP:
                // Silent no-op
                break;

            default:
                stats.unknown_count++;
                if (!opts.summary_only && display) {
                    printf(" (UNKNOWN)");
                }
                break;
        }

        if (!opts.summary_only && display) {
            printf("\n");
        }

        packet_num++;
    }

    fclose(fp);

    // Print summary
    printf("\n==================================================\n");
    printf("Summary Statistics:\n");
    printf("==================================================\n");
    printf("Total packets:        %d\n", packet_num);
    printf("\nVideo:\n");
    printf("  I-frames:           %d\n", stats.iframe_count);
    printf("  P-frames:           %d", stats.pframe_count);
    if (stats.pframe_count > 0) {
        printf(" (INTRA: %d, DELTA: %d, SKIP: %d",
               stats.pframe_intra_count, stats.pframe_delta_count, stats.pframe_skip_count);
        int known_modes = stats.pframe_intra_count + stats.pframe_delta_count + stats.pframe_skip_count;
        if (known_modes < stats.pframe_count) {
            printf(", Unknown: %d", stats.pframe_count - known_modes);
        }
        printf(")");
    }
    printf("\n");
    if (stats.gop_unified_count + stats.gop_unified_motion_count > 0) {
        printf("  3D GOP packets:     %d (total frames: %d, avg %.1f frames/GOP)\n",
               (stats.gop_unified_count + stats.gop_unified_motion_count), stats.total_gop_frames,
               (double)stats.total_gop_frames / (stats.gop_unified_count + stats.gop_unified_motion_count));
        printf("  GOP sync packets:   %d\n", stats.gop_sync_count);
    }
    printf("  Mux video:          %d\n", stats.mux_video_count);
    printf("  Total video bytes:  %llu (%.2f MB)\n",
           (unsigned long long)stats.total_video_bytes,
           stats.total_video_bytes / 1024.0 / 1024.0);
    printf("\nAudio:\n");
    printf("  MP2 packets:        %d\n", stats.audio_count);
    printf("  Total audio bytes:  %llu (%.2f MB)\n",
           (unsigned long long)stats.total_audio_bytes,
           stats.total_audio_bytes / 1024.0 / 1024.0);
    printf("\nOther:\n");
    printf("  Timecodes:          %d\n", stats.timecode_count);
    printf("  Subtitles:          %d\n", stats.subtitle_count);
    printf("  Extended headers:   %d\n", stats.extended_header_count);
    printf("  Metadata packets:   %d\n", stats.metadata_count);
    printf("  Loop points:        %d\n", stats.loop_point_count);
    printf("  Sync packets:       %d\n", stats.sync_count);
    printf("  NTSC sync packets:  %d\n", stats.sync_ntsc_count);
    printf("  Unknown packets:    %d\n", stats.unknown_count);

    return 0;
}
