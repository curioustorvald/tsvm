// TAV Packet Inspector - Comprehensive packet analysis tool for TAV files
// to compile: gcc -o tav_inspector tav_inspector.c lib/libfec.a -lzstd -lm
// Created by CuriousTorvald and Claude on 2025-10-14
// Updated 2025-12-02: Added TAV-DT (Digital Tape) format support
// Updated 2025-12-17: Updated for revised TAV-DT spec (sync outside LDPC, LDPC 1/2 headers)
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <getopt.h>
#include <zstd.h>
#include "lib/libfec/ldpc.h"

// TAV-DT sync patterns (big endian)
#define TAV_DT_SYNC_NTSC  0xE3537A1F  // 720x480
#define TAV_DT_SYNC_PAL   0xD193A745  // 720x576
#define TAV_DT_SYNC_TAV   0xA3F7C91E  // TAV subpacket sync

// TAV-DT header sizes (revised spec 2025-12-11)
// Sync patterns are written separately (NOT LDPC-coded)
#define DT_MAIN_HEADER_RAW    28   // fps(1) + flags(1) + reserved(2) + size(4) + timecode(8) + offset(4) + reserved(4) + crc(4)
#define DT_MAIN_HEADER_LDPC   56   // After LDPC 1/2 encoding
#define DT_TAD_HEADER_RAW     14   // sample_count(2) + quant_bits(1) + compressed_size(4) + rs_block_count(3) + crc(4)
#define DT_TAD_HEADER_LDPC    28   // After LDPC 1/2 encoding
#define DT_TAV_HEADER_RAW     14   // gop_size(1) + reserved(2) + compressed_size(4) + rs_block_count(3) + crc(4)
#define DT_TAV_HEADER_LDPC    28   // After LDPC 1/2 encoding

// RS(255,223) parameters
#define RS_DATA_LEN   223
#define RS_PARITY_LEN 32

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
#define TAV_PACKET_AUDIO_TAD      0x24
#define TAV_PACKET_SUBTITLE       0x30  // Legacy SSF (frame-locked), also used for Font ROM upload
#define TAV_PACKET_SUBTITLE_TC    0x31  // SSF-TC (timecode-based)
#define TAV_PACKET_VIDEOTEX       0x3F  // Videotex (text-mode video)
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
#define TAV_PACKET_SCREEN_MASK    0xF2
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
    int audio_mp2_count;
    int audio_pcm8_count;
    int audio_tad_count;
    int audio_track_count;
    int subtitle_count;
    int videotex_count;
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
    uint64_t audio_mp2_bytes;
    uint64_t audio_pcm8_bytes;
    uint64_t audio_tad_bytes;
    uint64_t audio_track_bytes;
    uint64_t videotex_bytes;
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

// Helper to read data from either file or DT payload buffer
static size_t read_packet_data(void *dest, size_t size, size_t count, FILE *fp,
                               uint8_t *payload, uint32_t payload_size, uint32_t *offset) {
    if (payload) {
        // DT mode: read from payload buffer
        size_t bytes_to_read = size * count;
        if (*offset + bytes_to_read > payload_size) {
            return 0;  // Not enough data
        }
        memcpy(dest, payload + *offset, bytes_to_read);
        *offset += bytes_to_read;
        return count;
    } else {
        // TAV mode: read from file
        return fread(dest, size, count, fp);
    }
}

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
        case TAV_PACKET_AUDIO_TAD: return "AUDIO TAD (zstd)";
        case TAV_PACKET_SUBTITLE: return "SUBTITLE (SSF frame-locked)";
        case TAV_PACKET_SUBTITLE_TC: return "SUBTITLE (SSF-TC timecoded)";
        case TAV_PACKET_VIDEOTEX: return "VIDEOTEX (text-mode video)";
        case TAV_PACKET_AUDIO_TRACK: return "AUDIO TRACK (Separate MP2)";
        case TAV_PACKET_EXIF: return "METADATA (EXIF)";
        case TAV_PACKET_ID3V1: return "METADATA (ID3v1)";
        case TAV_PACKET_ID3V2: return "METADATA (ID3v2)";
        case TAV_PACKET_VORBIS_COMMENT: return "METADATA (Vorbis)";
        case TAV_PACKET_CD_TEXT: return "METADATA (CD-Text)";
        case TAV_PACKET_EXTENDED_HDR: return "EXTENDED HEADER";
        case TAV_PACKET_LOOP_START: return "LOOP START";
        case TAV_PACKET_LOOP_END: return "LOOP END";
        case TAV_PACKET_SCREEN_MASK: return "SCREEN MASK";
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
    if (opts->show_audio && (type == TAV_PACKET_AUDIO_MP2 || type == TAV_PACKET_AUDIO_PCM8 ||
        type == TAV_PACKET_AUDIO_TAD || type == TAV_PACKET_AUDIO_TRACK)) return 1;
    if (opts->show_subtitles && (type == TAV_PACKET_SUBTITLE || type == TAV_PACKET_SUBTITLE_TC)) return 1;
    if (opts->show_timecode && type == TAV_PACKET_TIMECODE) return 1;
    if (opts->show_metadata && (type >= 0xE0 && type <= 0xE4)) return 1;
    if (opts->show_sync && (type == TAV_PACKET_SYNC || type == TAV_PACKET_SYNC_NTSC)) return 1;
    if (opts->show_extended && type == TAV_PACKET_EXTENDED_HDR) return 1;

    return 0;
}

void print_subtitle_packet(FILE *fp, uint32_t size, int is_timecoded, int verbose) {
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

    // Read timecode if SSF-TC (0x31)
    uint64_t timecode_ns = 0;
    int header_size = 4;  // 3 bytes index + 1 byte opcode
    if (is_timecoded) {
        uint8_t timecode_bytes[8];
        if (fread(timecode_bytes, 1, 8, fp) != 8) return;
        for (int i = 0; i < 8; i++) {
            timecode_ns |= ((uint64_t)timecode_bytes[i]) << (i * 8);
        }
        header_size += 8;  // Add 8 bytes for timecode
    }

    uint8_t opcode;
    if (fread(&opcode, 1, 1, fp) != 1) return;

    printf(" [Index=%u", index);
    if (is_timecoded) {
        printf(", Time=%.3fs", timecode_ns / 1000000000.0);
    }
    printf(", Opcode=0x%02X", opcode);

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
    int remaining = size - header_size;  // Already read index + timecode (if any) + opcode
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
                    time_t time_sec = value / 1000000ULL; // microseconds
                    struct tm *time_info = gmtime(&time_sec);
                    if (time_info) {
                        char time_str[64];
                        strftime(time_str, sizeof(time_str), "%a %b %d %H:%M:%S %Y UTC", time_info);
                        printf("%s", time_str);
                    }
                } else {
                    printf("%.6f seconds", value / 1000000000.0); // nanoseconds
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

                // Special handling for XFPS: show parsed framerate
                if (strncmp(key, "XFPS", 4) == 0) {
                    int num, den;
                    if (sscanf(data, "%d/%d", &num, &den) == 2) {
                        printf("%d/%d (%.3f fps)", num, den, (double)num / den);
                    } else {
                        printf("\"%s\"", data);
                    }
                } else {
                    printf("\"%s\"", data);
                }
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

    // Parse and display header
    if (!opts.summary_only) {
        printf("TAV Packet Inspector\n");
        printf("File: %s\n", filename);
        printf("==================================================\n\n");
    }

    // Detect format: TAV (with magic) or TAV-DT (with sync pattern)
    uint8_t header[32];
    int is_dt_format = 0;
    uint16_t dt_width = 0, dt_height = 0;
    uint8_t dt_framerate = 0;
    uint8_t dt_quality = 0;
    int dt_is_interlaced = 0;
    int dt_is_ntsc_framerate = 0;

    // Read first 4 bytes to check format
    uint8_t format_check[4];
    if (fread(format_check, 1, 4, fp) != 4) {
        fprintf(stderr, "Error: Failed to read file header\n");
        fclose(fp);
        return 1;
    }

    // Check if it's a TAV-DT sync pattern
    uint32_t sync = (format_check[0] << 24) | (format_check[1] << 16) |
                    (format_check[2] << 8) | format_check[3];

    if (sync == TAV_DT_SYNC_NTSC || sync == TAV_DT_SYNC_PAL) {
        // TAV-DT format detected (revised spec 2025-12-11)
        // Structure: sync(4) + LDPC_header(56) + TAD_LDPC_header(28) + TAD_RS_payload + TAV_sync(4) + TAV_LDPC_header(28) + TAV_RS_payload
        is_dt_format = 1;
        dt_width = 720;
        dt_height = (sync == TAV_DT_SYNC_NTSC) ? 480 : 576;

        // Initialize LDPC decoder
        ldpc_init();

        // Read LDPC-coded main header (56 bytes)
        uint8_t ldpc_header[DT_MAIN_HEADER_LDPC];
        if (fread(ldpc_header, 1, DT_MAIN_HEADER_LDPC, fp) != DT_MAIN_HEADER_LDPC) {
            fprintf(stderr, "Error: Failed to read TAV-DT LDPC header\n");
            fclose(fp);
            return 1;
        }

        // Decode LDPC to get raw header (28 bytes)
        uint8_t raw_header[DT_MAIN_HEADER_RAW];
        int ldpc_result = ldpc_decode(ldpc_header, DT_MAIN_HEADER_LDPC, raw_header);

        // Parse raw header fields:
        // fps(1) + flags(1) + reserved(2) + size(4) + timecode(8) + offset(4) + reserved(4) + crc(4)
        dt_framerate = raw_header[0];
        uint8_t flags = raw_header[1];
        dt_is_interlaced = flags & 0x01;
        dt_is_ntsc_framerate = flags & 0x02;
        dt_quality = (flags >> 4) & 0x0F;

        uint32_t packet_size = raw_header[4] | (raw_header[5] << 8) |
                               (raw_header[6] << 16) | (raw_header[7] << 24);
        uint64_t timecode_ns = 0;
        for (int i = 0; i < 8; i++) {
            timecode_ns |= ((uint64_t)raw_header[8 + i]) << (i * 8);
        }
        uint32_t offset_to_video = raw_header[16] | (raw_header[17] << 8) |
                                   (raw_header[18] << 16) | (raw_header[19] << 24);
        uint32_t header_crc = raw_header[24] | (raw_header[25] << 8) |
                              (raw_header[26] << 16) | (raw_header[27] << 24);

        // Rewind to start of first packet so the loop can process it
        fseek(fp, -(4 + DT_MAIN_HEADER_LDPC), SEEK_CUR);

        if (!opts.summary_only) {
            printf("TAV-DT Header (Digital Tape Streaming Format, revised 2025-12-11):\n");
            printf("  Format:           %s %s\n",
                   (sync == TAV_DT_SYNC_NTSC) ? "NTSC" : "PAL",
                   dt_is_interlaced ? "interlaced" : "progressive");
            printf("  Resolution:       %dx%d\n", dt_width, dt_height);
            printf("  Frame rate:       %d fps", dt_framerate);
            if (dt_is_ntsc_framerate) printf(" (NTSC)");
            printf("\n");
            printf("  Quality index:    %d (0-5)\n", dt_quality);
            printf("  LDPC decode:      %s\n", ldpc_result == 0 ? "OK" : "FAILED (using best-effort)");
            printf("  Header CRC:       0x%08X\n", header_crc);
            printf("  First packet:     %u bytes, timecode=%.3fs, video_offset=%u\n",
                   packet_size, timecode_ns / 1000000000.0, offset_to_video);
            printf("  Packet structure:\n");
            printf("    Main sync:      4 bytes (not LDPC)\n");
            printf("    Main header:    %d bytes LDPC (%d bytes raw)\n", DT_MAIN_HEADER_LDPC, DT_MAIN_HEADER_RAW);
            printf("    TAD header:     %d bytes LDPC (%d bytes raw)\n", DT_TAD_HEADER_LDPC, DT_TAD_HEADER_RAW);
            printf("    TAD payload:    RS(255,223) coded\n");
            printf("    TAV sync:       4 bytes (not LDPC)\n");
            printf("    TAV header:     %d bytes LDPC (%d bytes raw)\n", DT_TAV_HEADER_LDPC, DT_TAV_HEADER_RAW);
            printf("    TAV payload:    RS(255,223) coded\n");
            printf("  Wavelet:          1 (CDF 9/7, fixed for DT)\n");
            printf("  Decomp levels:    4 spatial + 2 temporal (fixed for DT)\n");
            printf("  Entropy coder:    EZBC (fixed for DT)\n");
            printf("  Channel layout:   YCoCg-R (fixed for DT)\n");
            printf("\n");
        }
    } else {
        // Regular TAV format - rewind and read full header
        rewind(fp);
        if (fread(header, 1, 32, fp) != 32) {
            fprintf(stderr, "Error: Failed to read TAV header\n");
            fclose(fp);
            return 1;
        }

        // Verify magic number
        const char *magic = "\x1F\x54\x53\x56\x4D\x54\x41\x56";  // "\x1FTSVM TAV"
        if (memcmp(header, magic, 8) != 0) {
            fprintf(stderr, "Error: Invalid TAV magic number\n");
            fclose(fp);
            return 1;
        }
    }

    if (!opts.summary_only && !is_dt_format) {
        // Parse header fields (TAV format only)
        uint8_t version = header[8];
        uint8_t base_version = (version > 8) ? (version - 8) : version;
        uint8_t temporal_motion_coder = (version > 8) ? 1 : 0;
        uint16_t width = *((uint16_t*)&header[9]);
        uint16_t height = *((uint16_t*)&header[11]);
        uint8_t fps = header[13];
        uint32_t total_frames = *((uint32_t*)&header[14]);
        uint8_t wavelet = header[18];
        uint8_t decomp_levels = header[19];
        uint8_t quant_y = header[20];
        uint8_t quant_co = header[21];
        uint8_t quant_cg = header[22];
        uint8_t extra_flags = header[23];
        uint8_t video_flags = header[24];
        uint8_t quality = header[25];
        uint8_t channel_layout = header[26];
        uint8_t entropy_coder = header[27];
        uint8_t encoder_preset = header[28];

static const int QLUT[] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096};
static const char* CLAYOUT[] = {"Luma-Chroma", "Luma-Chroma-Alpha", "Luma", "Luma-Alpha", "Chroma", "Chroma-Alpha"};

        int is_monoblock = (3 <= base_version && base_version <= 6);
        int is_perceptual = (5 <= base_version && base_version <= 8);

static const char* VERDESC[] = {"null", "YCoCg tiled, uniform", "ICtCp tiled, uniform", "YCoCg monoblock, uniform", "ICtCp monoblock, uniform", "YCoCg monoblock, perceptual", "ICtCp monoblock, perceptual", "YCoCg tiled, perceptual", "ICtCp tiled, perceptual"};
static const char* TEMPORAL_WAVELET[] = {"Haar", "CDF 5/3"};

        printf("TAV Header:\n");
        printf("  Version:          %d (base: %d - %s, temporal: %s)\n",
               version, base_version, VERDESC[base_version], TEMPORAL_WAVELET[temporal_motion_coder]);
        printf("  Resolution:       %dx%d\n", width, height);
        if (fps == 0xFF) {
            printf("  Frame rate:       (extended - see XFPS in extended header)\n");
        } else if (fps == 0) {
            printf("  Frame rate:       (still image)\n");
        } else {
            printf("  Frame rate:       %d fps", fps);
            if (video_flags & 0x02) printf(" (NTSC)");
            printf("\n");
        }
        printf("  Total frames:     %u\n", total_frames);
        printf("  Wavelet:          %d", wavelet);
        const char *wavelet_names[] = {"LGT 5/3", "CDF 9/7", "CDF 13/7", "Reserved", "Reserved",
                                       "Reserved", "Reserved", "Reserved", "Reserved",
                                       "Reserved", "Reserved", "Reserved", "Reserved",
                                       "Reserved", "Reserved", "Reserved", "DD-4"};
        if (wavelet < 17) printf(" (%s)", wavelet_names[wavelet == 16 ? 16 : (wavelet > 16 ? wavelet : wavelet)]);
        if (wavelet == 255) printf(" (Haar)");
        printf("\n");
        printf("  Decomp levels:    %d\n", decomp_levels);
        printf("  Quantisers:       Y=%d, Co=%d, Cg=%d (Index=%d,%d,%d)\n", QLUT[quant_y], QLUT[quant_co], QLUT[quant_cg], quant_y, quant_co, quant_cg);
        if (quality > 0)
            printf("  Quality:          %d\n", quality - 1);
        else
            printf("  Quality:          n/a\n");
        printf("  Channel layout:   %s\n", CLAYOUT[channel_layout]);
        printf("  Entropy coder:    %s\n", entropy_coder == 0 ? "Twobit-map" : "EZBC");
        printf("  Encoder preset:   ");
        if (encoder_preset == 0) {
            printf("Default\n");
        } else {
            int first = 1;
            if (encoder_preset & 0x01) {
                printf("%sSports", first ? "" : ", ");
                first = 0;
            }
            if (encoder_preset & 0x02) {
                printf("%sAnime", first ? "" : ", ");
                first = 0;
            }
            printf("\n");
        }
        printf("  Flags:\n");
        printf("    Has audio:      %s\n", (extra_flags & 0x01) ? "Yes" : "No");
        printf("    Has subtitles:  %s\n", (extra_flags & 0x02) ? "Yes" : "No");
        printf("    Progressive:    %s\n", (video_flags & 0x01) ? "No (interlaced)" : "Yes");
        printf("    Lossless:       %s\n", (video_flags & 0x04) ? "Yes" : "No");
        if (extra_flags & 0x04) printf("    Progressive TX: Enabled\n");
        if (extra_flags & 0x08) printf("    ROI encoding:   Enabled\n");
        printf("\nPackets:\n");
        printf("==================================================\n");
    }

    packet_stats_t stats = {0};
    int packet_num = 0;

    while (!feof(fp)) {
        long packet_offset = ftell(fp);
        uint8_t packet_type;
        uint8_t *packet_payload = NULL;
        uint32_t payload_size = 0;
        uint32_t payload_offset = 1;  // Start at 1 to skip packet type byte in DT mode

        if (is_dt_format) {
            // TAV-DT (revised spec 2025-12-11):
            // Structure: sync(4) + LDPC_main_header(56) + LDPC_tad_header(28) + TAD_RS_payload + TAV_sync(4) + LDPC_tav_header(28) + TAV_RS_payload

            // Read main sync (4 bytes)
            uint8_t sync_bytes[4];
            if (fread(sync_bytes, 1, 4, fp) != 4) break;

            uint32_t sync_check = (sync_bytes[0] << 24) | (sync_bytes[1] << 16) |
                                  (sync_bytes[2] << 8) | sync_bytes[3];

            // Verify sync pattern
            if (sync_check != TAV_DT_SYNC_NTSC && sync_check != TAV_DT_SYNC_PAL) {
                if (!opts.summary_only) {
                    fprintf(stderr, "Warning: Invalid sync pattern 0x%08X at offset 0x%lX\n",
                           sync_check, packet_offset);
                }
                break;
            }

            // Read and decode main LDPC header (56 bytes -> 28 bytes raw)
            uint8_t ldpc_main[DT_MAIN_HEADER_LDPC];
            if (fread(ldpc_main, 1, DT_MAIN_HEADER_LDPC, fp) != DT_MAIN_HEADER_LDPC) break;

            uint8_t raw_main[DT_MAIN_HEADER_RAW];
            int main_ldpc_ok = (ldpc_decode(ldpc_main, DT_MAIN_HEADER_LDPC, raw_main) == 0);

            // Parse main header: fps(1) + flags(1) + reserved(2) + size(4) + timecode(8) + offset(4) + reserved(4) + crc(4)
            uint32_t packet_size_total = raw_main[4] | (raw_main[5] << 8) |
                                         (raw_main[6] << 16) | (raw_main[7] << 24);
            uint64_t timecode_ns = 0;
            for (int i = 0; i < 8; i++) {
                timecode_ns |= ((uint64_t)raw_main[8 + i]) << (i * 8);
            }
            uint32_t offset_to_video = raw_main[16] | (raw_main[17] << 8) |
                                       (raw_main[18] << 16) | (raw_main[19] << 24);

            // Read and decode TAD LDPC header (28 bytes -> 14 bytes raw)
            uint8_t ldpc_tad[DT_TAD_HEADER_LDPC];
            if (fread(ldpc_tad, 1, DT_TAD_HEADER_LDPC, fp) != DT_TAD_HEADER_LDPC) break;

            uint8_t raw_tad[DT_TAD_HEADER_RAW];
            int tad_ldpc_ok = (ldpc_decode(ldpc_tad, DT_TAD_HEADER_LDPC, raw_tad) == 0);

            // Parse TAD header: sample_count(2) + quant_bits(1) + compressed_size(4) + rs_block_count(3) + crc(4)
            uint16_t tad_sample_count = raw_tad[0] | (raw_tad[1] << 8);
            uint8_t tad_quant_bits = raw_tad[2];
            uint32_t tad_compressed_size = raw_tad[3] | (raw_tad[4] << 8) |
                                           (raw_tad[5] << 16) | (raw_tad[6] << 24);
            uint32_t tad_rs_blocks = raw_tad[7] | (raw_tad[8] << 8) | (raw_tad[9] << 16);

            // Calculate TAD RS payload size
            uint32_t tad_rs_size = tad_rs_blocks * 255;

            // Skip TAD RS payload
            fseek(fp, tad_rs_size, SEEK_CUR);

            // Read TAV sync (4 bytes)
            uint8_t tav_sync_bytes[4];
            if (fread(tav_sync_bytes, 1, 4, fp) != 4) break;

            uint32_t tav_sync_check = (tav_sync_bytes[0] << 24) | (tav_sync_bytes[1] << 16) |
                                      (tav_sync_bytes[2] << 8) | tav_sync_bytes[3];

            int tav_sync_ok = (tav_sync_check == TAV_DT_SYNC_TAV);

            // Read and decode TAV LDPC header (28 bytes -> 14 bytes raw)
            uint8_t ldpc_tav[DT_TAV_HEADER_LDPC];
            if (fread(ldpc_tav, 1, DT_TAV_HEADER_LDPC, fp) != DT_TAV_HEADER_LDPC) break;

            uint8_t raw_tav[DT_TAV_HEADER_RAW];
            int tav_ldpc_ok = (ldpc_decode(ldpc_tav, DT_TAV_HEADER_LDPC, raw_tav) == 0);

            // Parse TAV header: gop_size(1) + reserved(2) + compressed_size(4) + rs_block_count(3) + crc(4)
            uint8_t tav_gop_size = raw_tav[0];
            uint32_t tav_compressed_size = raw_tav[3] | (raw_tav[4] << 8) |
                                           (raw_tav[5] << 16) | (raw_tav[6] << 24);
            uint32_t tav_rs_blocks = raw_tav[7] | (raw_tav[8] << 8) | (raw_tav[9] << 16);

            // Calculate TAV RS payload size
            uint32_t tav_rs_size = tav_rs_blocks * 255;

            // Skip TAV RS payload
            fseek(fp, tav_rs_size, SEEK_CUR);

            // For display, create a synthetic payload with the TAV inner packet
            // The inspector will show this as a GOP packet
            payload_size = tav_compressed_size + 16;  // Approximate
            packet_payload = NULL;  // Don't read actual payload for now

            // Set packet type to GOP unified
            packet_type = TAV_PACKET_GOP_UNIFIED;

            // Display DT packet info
            if (!opts.summary_only && should_display_packet(packet_type, &opts)) {
                printf("Packet %d (offset 0x%lX): TAV-DT Packet\n", packet_num, packet_offset);
                printf("  Main header:  LDPC %s, timecode=%.3fs, size=%u\n",
                       main_ldpc_ok ? "OK" : "ERR", timecode_ns / 1000000000.0, packet_size_total);
                printf("  TAD subpkt:   LDPC %s, samples=%u, Q=%u, RS blocks=%u (%u bytes)\n",
                       tad_ldpc_ok ? "OK" : "ERR", tad_sample_count, tad_quant_bits, tad_rs_blocks, tad_rs_size);
                printf("  TAV subpkt:   sync %s, LDPC %s, GOP=%u, RS blocks=%u (%u bytes)\n",
                       tav_sync_ok ? "OK" : "ERR", tav_ldpc_ok ? "OK" : "ERR",
                       tav_gop_size, tav_rs_blocks, tav_rs_size);
            }

            // Update stats
            stats.gop_unified_count++;
            stats.total_gop_frames += tav_gop_size;
            stats.audio_tad_count++;
            stats.audio_tad_bytes += tad_compressed_size;
            stats.total_audio_bytes += tad_compressed_size;
            stats.total_video_bytes += tav_compressed_size;

            packet_num++;
            continue;  // Skip the normal packet processing
        } else {
            // Regular TAV: Read packet type directly
            if (fread(&packet_type, 1, 1, fp) != 1) break;
        }

        int display = should_display_packet(packet_type, &opts);

        if (!opts.summary_only && display) {
            printf("Packet %d (offset 0x%lX): Type 0x%02X (%s)",
                   packet_num, packet_offset, packet_type, get_packet_type_name(packet_type));
            if (is_dt_format) {
                printf(" [DT payload: %u bytes]", payload_size);
            }
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
                if (read_packet_data(&timecode_ns, sizeof(uint64_t), 1, fp, packet_payload, payload_size, &payload_offset) != 1) break;

                if (!opts.summary_only && display) {
                    double timecode_sec = timecode_ns / 1000000000.0;
                    printf(" - %.6f seconds (Frame %d)", timecode_sec, current_frame);
                }
                break;
            }

            case TAV_PACKET_GOP_UNIFIED: case TAV_PACKET_GOP_UNIFIED_MOTION: {
                // Unified GOP packet: [gop_size][motion_vectors...][compressed_size][data]
                uint8_t gop_size;
                if (read_packet_data(&gop_size, 1, 1, fp, packet_payload, payload_size, &payload_offset) != 1) break;

                // Read motion vectors
                uint32_t size0 = 0;
                if (packet_type == TAV_PACKET_GOP_UNIFIED_MOTION) {
                    if (read_packet_data(&size0, sizeof(uint32_t), 1, fp, packet_payload, payload_size, &payload_offset) != 1) { break; }
                    stats.total_video_bytes += size0;
                    stats.gop_unified_motion_count++;
                    if (!packet_payload) fseek(fp, size0, SEEK_CUR);
                    else payload_offset += size0;
                }

                // Read compressed data size
                uint32_t size1;
                if (read_packet_data(&size1, sizeof(uint32_t), 1, fp, packet_payload, payload_size, &payload_offset) != 1) { break; }
                stats.total_video_bytes += size1;
                if (!packet_payload) fseek(fp, size1, SEEK_CUR);
                // else: data is already in payload buffer, skip ahead
                else payload_offset += size1;


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
                if (read_packet_data(&frame_count, 1, 1, fp, packet_payload, payload_size, &payload_offset) != 1) break;

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
                stats.audio_mp2_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;
                stats.total_audio_bytes += size;
                stats.audio_mp2_bytes += size;

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes", size);
                }
                fseek(fp, size, SEEK_CUR);
                break;
            }

            case TAV_PACKET_AUDIO_PCM8: {
                stats.audio_count++;
                stats.audio_pcm8_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;
                stats.total_audio_bytes += size;
                stats.audio_pcm8_bytes += size;

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes (zstd compressed)", size);
                }
                fseek(fp, size, SEEK_CUR);
                break;
            }

            case TAV_PACKET_AUDIO_TAD: {
                stats.audio_count++;
                stats.audio_tad_count++;

                // Read sample count
                uint16_t sample_count0;
                if (read_packet_data(&sample_count0, sizeof(uint16_t), 1, fp, packet_payload, payload_size, &payload_offset) != 1) break;

                // Read payload_size + 7
                uint32_t payload_size_plus_7;
                if (read_packet_data(&payload_size_plus_7, sizeof(uint32_t), 1, fp, packet_payload, payload_size, &payload_offset) != 1) break;

                // Read sample count
                uint16_t sample_count;
                if (read_packet_data(&sample_count, sizeof(uint16_t), 1, fp, packet_payload, payload_size, &payload_offset) != 1) break;

                // Read quantiser index
                uint8_t quantiser;
                if (read_packet_data(&quantiser, sizeof(uint8_t), 1, fp, packet_payload, payload_size, &payload_offset) != 1) break;

                // Read compressed size
                uint32_t compressed_size;
                if (read_packet_data(&compressed_size, sizeof(uint32_t), 1, fp, packet_payload, payload_size, &payload_offset) != 1) break;

                stats.total_audio_bytes += compressed_size;
                stats.audio_tad_bytes += compressed_size;

                if (!opts.summary_only && display) {
                    printf(" - samples=%u, size=%u bytes, quantiser=%u steps (index %u)",
                           sample_count, compressed_size, quantiser * 2 + 1, quantiser);
                }

                // Skip compressed data
                if (!packet_payload) fseek(fp, compressed_size, SEEK_CUR);
                else payload_offset += compressed_size;
                break;
            }

            case TAV_PACKET_AUDIO_TRACK: {
                stats.audio_count++;
                stats.audio_track_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;
                stats.total_audio_bytes += size;
                stats.audio_track_bytes += size;

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes (separate track)", size);
                }
                fseek(fp, size, SEEK_CUR);
                break;
            }

            case TAV_PACKET_SUBTITLE:
            case TAV_PACKET_SUBTITLE_TC: {
                stats.subtitle_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;

                if (!opts.summary_only && display) {
                    printf(" - size=%u bytes", size);
                    print_subtitle_packet(fp, size, packet_type == TAV_PACKET_SUBTITLE_TC, opts.verbose);
                } else {
                    fseek(fp, size, SEEK_CUR);
                }
                break;
            }

            case TAV_PACKET_VIDEOTEX: {
                stats.videotex_count++;
                uint32_t size;
                if (fread(&size, sizeof(uint32_t), 1, fp) != 1) break;
                stats.videotex_bytes += size;

                if (!opts.summary_only && display) {
                    // Read compressed data
                    uint8_t *compressed_data = malloc(size);
                    if (compressed_data && fread(compressed_data, 1, size, fp) == size) {
                        // Allocate decompression buffer (max 2 + 80*32*3 = 7682 bytes)
                        size_t const decompress_size = 8192;
                        uint8_t *decompressed_data = malloc(decompress_size);
                        if (decompressed_data) {
                            size_t actual_size = ZSTD_decompress(decompressed_data, decompress_size,
                                                                compressed_data, size);
                            if (!ZSTD_isError(actual_size) && actual_size >= 2) {
                                uint8_t rows = decompressed_data[0];
                                uint8_t cols = decompressed_data[1];
                                printf(" - size=%u bytes (decompressed: %zu bytes, grid: %ux%u, ratio: %.2f:1)",
                                       size, actual_size, cols, rows, (double)actual_size / size);
                            } else {
                                printf(" - size=%u bytes (decompression failed)", size);
                            }
                            free(decompressed_data);
                        } else {
                            printf(" - size=%u bytes", size);
                        }
                        free(compressed_data);
                    } else {
                        printf(" - size=%u bytes", size);
                        fseek(fp, size, SEEK_CUR);
                    }
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

            case TAV_PACKET_SCREEN_MASK:
                uint32_t frame_number;
                if (fread(&frame_number, sizeof(uint32_t), 1, fp) != 1) break;
                uint16_t top;
                if (fread(&top, sizeof(uint16_t), 1, fp) != 1) break;
                uint16_t right;
                if (fread(&right, sizeof(uint16_t), 1, fp) != 1) break;
                uint16_t bottom;
                if (fread(&bottom, sizeof(uint16_t), 1, fp) != 1) break;
                uint16_t left;
                if (fread(&left, sizeof(uint16_t), 1, fp) != 1) break;

                if (!opts.summary_only && display) {
                    printf(" - Frame=%u [top=%u, right=%u, bottom=%u, left=%u]", frame_number, top, right, bottom, left);
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

        // Free DT packet payload if allocated
        if (packet_payload) {
            free(packet_payload);
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
    printf("  Total packets:      %d\n", stats.audio_count);
    if (stats.audio_mp2_count > 0) {
        printf("    MP2:              %d packets, %llu bytes (%.2f MB)\n",
               stats.audio_mp2_count,
               (unsigned long long)stats.audio_mp2_bytes,
               stats.audio_mp2_bytes / 1024.0 / 1024.0);
    }
    if (stats.audio_pcm8_count > 0) {
        printf("    PCM8 (zstd):      %d packets, %llu bytes (%.2f MB)\n",
               stats.audio_pcm8_count,
               (unsigned long long)stats.audio_pcm8_bytes,
               stats.audio_pcm8_bytes / 1024.0 / 1024.0);
    }
    if (stats.audio_tad_count > 0) {
        printf("    TAD32 (zstd):     %d packets, %llu bytes (%.2f MB)\n",
               stats.audio_tad_count,
               (unsigned long long)stats.audio_tad_bytes,
               stats.audio_tad_bytes / 1024.0 / 1024.0);
    }
    if (stats.audio_track_count > 0) {
        printf("    Separate track:   %d packets, %llu bytes (%.2f MB)\n",
               stats.audio_track_count,
               (unsigned long long)stats.audio_track_bytes,
               stats.audio_track_bytes / 1024.0 / 1024.0);
    }
    printf("  Total audio bytes:  %llu (%.2f MB)\n",
           (unsigned long long)stats.total_audio_bytes,
           stats.total_audio_bytes / 1024.0 / 1024.0);
    printf("\nOther:\n");
    printf("  Timecodes:          %d\n", stats.timecode_count);
    printf("  Subtitles:          %d\n", stats.subtitle_count);
    if (stats.videotex_count > 0) {
        printf("  Videotex frames:    %d (%llu bytes, %.2f MB)\n",
               stats.videotex_count,
               (unsigned long long)stats.videotex_bytes,
               stats.videotex_bytes / 1024.0 / 1024.0);
    }
    printf("  Extended headers:   %d\n", stats.extended_header_count);
    printf("  Metadata packets:   %d\n", stats.metadata_count);
    printf("  Loop points:        %d\n", stats.loop_point_count);
    printf("  Sync packets:       %d\n", stats.sync_count);
    printf("  NTSC sync packets:  %d\n", stats.sync_ntsc_count);
    printf("  Unknown packets:    %d\n", stats.unknown_count);

    return 0;
}
