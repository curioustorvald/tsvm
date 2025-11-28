/*
encoder_tav_text.c
Text-based video encoder for TSVM using custom font ROMs

Outputs Videotex files with custom header and packet type 0x3F (text mode)

File structure:
  - Videotex header (32 bytes): magic "\x1FTSVM-VT", version, grid dims, fps, total_frames
  - Extended header packet (0xEF): BGNT, ENDT, CDAT, VNDR, FMPG
  - Font ROM packets (0x30): lowrom and highrom (1920 bytes each)
  - Per-frame sequence: [audio 0x20], [timecode 0xFD], [videotex 0x3F], [sync 0xFF]

Videotex packet structure (0x3F): Zstd([rows][cols][fg-array][bg-array][char-array])
  - rows: uint8 (32)
  - cols: uint8 (80)
  - fg-array: rows*cols bytes (foreground colors, 0xF0=black, 0xFE=white)
  - bg-array: rows*cols bytes (background colors, 0xF0=black, 0xFE=white)
  - char-array: rows*cols bytes (glyph indices 0-255)

Total uncompressed size: 2 + (80*32*3) = 7682 bytes
Separated arrays compress much better (fg/bg are just 0xF0/0xFE runs)
Video size: 80×32 characters (560×448 pixels with 7×14 font)
Audio: MP2 encoding at 96 kbps, 32 KHz stereo (packet 0x20)
Each text frame is treated as an I-frame with sync packet

Usage:
  gcc -Ofast -std=c11 -Wall encoder_tav_text.c -o encoder_tav_text -lm -lzstd
  ./encoder_tav_text -i video.mp4 -f font.chr -o output.mv3
*/

#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include <unistd.h>
#include <time.h>
#include <sys/time.h>

#define ENCODER_VENDOR_STRING "Encoder-TAV-Text 20251121 (videotex)"

#define CHAR_W 7
#define CHAR_H 14
#define GRID_W 80
#define GRID_H 32
#define PIXEL_W (GRID_W * CHAR_W)  // 560
#define PIXEL_H (GRID_H * CHAR_H)  // 448
#define PATCH_SZ (CHAR_W * CHAR_H)
#define SAMPLE_RATE 32000
#define MP2_DEFAULT_PACKET_SIZE 1152

// TAV packet types
#define PACKET_TIMECODE 0xFD
#define PACKET_SYNC 0xFF
#define PACKET_AUDIO_MP2 0x20
#define PACKET_SSF 0x30
#define PACKET_TEXT 0x3F
#define PACKET_EXTENDED_HDR 0xEF

// SSF opcodes for font ROM
#define SSF_OPCODE_LOWROM 0x80
#define SSF_OPCODE_HIGHROM 0x81

// Font ROM size constants
#define FONTROM_PADDED_SIZE 1920
#define GLYPHS_PER_ROM 128

// Color mapping (4-bit RGB to TSVM palette)
#define COLOR_BLACK 0xF0
#define COLOR_WHITE 0xFE

// Generate random filename for temporary audio file
static void generate_random_filename(char *filename) {
    srand(time(NULL));

    const char charset[] = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const int charset_size = sizeof(charset) - 1;

    // Start with the prefix
    strcpy(filename, "/tmp/");

    // Generate 32 random characters
    for (int i = 0; i < 32; i++) {
        filename[5 + i] = charset[rand() % charset_size];
    }

    // Add the .mp2 extension
    strcpy(filename + 37, ".mp2");
    filename[41] = '\0';  // Null terminate
}

char TEMP_AUDIO_FILE[42];

// Global flag to disable inverted character matching
int g_no_invert_char = 0;

typedef struct {
    uint8_t *data;     // Binary glyph data (PATCH_SZ bytes per glyph)
    int count;         // Number of glyphs
} FontROM;

// Get FFmpeg version string
char *get_ffmpeg_version(void) {
    FILE *pipe = popen("ffmpeg -version 2>&1 | head -1", "r");
    if (!pipe) return NULL;

    char *version = malloc(256);
    if (!version) {
        pclose(pipe);
        return NULL;
    }

    if (fgets(version, 256, pipe)) {
        // Remove trailing newline
        size_t len = strlen(version);
        if (len > 0 && version[len - 1] == '\n') {
            version[len - 1] = '\0';
        }
        pclose(pipe);
        return version;
    }

    free(version);
    pclose(pipe);
    return NULL;
}

// Detect video FPS using ffprobe
float detect_fps(const char *video_path) {
    char cmd[1024];
    snprintf(cmd, sizeof(cmd),
             "ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate "
             "-of default=noprint_wrappers=1:nokey=1 \"%s\" 2>/dev/null",
             video_path);

    FILE *pipe = popen(cmd, "r");
    if (!pipe) return 30.0f; // fallback

    char fps_str[64] = {0};
    if (fgets(fps_str, sizeof(fps_str), pipe)) {
        // Parse fraction like "30/1" or "24000/1001"
        int num = 0, den = 1;
        if (sscanf(fps_str, "%d/%d", &num, &den) == 2 && den > 0) {
            pclose(pipe);
            return (float)num / (float)den;
        }
    }
    pclose(pipe);
    return 30.0f; // fallback
}

// Load font ROM (14 bytes per glyph, no header)
FontROM *load_font_rom(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (size % 14 != 0) {
        fprintf(stderr, "Warning: ROM size not divisible by 14 (got %ld bytes)\n", size);
    }

    int glyph_count = size / 14;
    FontROM *rom = malloc(sizeof(FontROM));
    rom->count = glyph_count;
    rom->data = malloc(glyph_count * PATCH_SZ);

    // Read and unpack glyphs
    for (int g = 0; g < glyph_count; g++) {
        uint8_t row_bytes[14];
        if (fread(row_bytes, 14, 1, f) != 1) {
            free(rom->data);
            free(rom);
            fclose(f);
            return NULL;
        }

        // Unpack bits to binary pixels
        for (int row = 0; row < CHAR_H; row++) {
            for (int col = 0; col < CHAR_W; col++) {
                // Bit 6 = leftmost, bit 0 = rightmost
                int bit = (row_bytes[row] >> (6 - col)) & 1;
                rom->data[g * PATCH_SZ + row * CHAR_W + col] = bit;
            }
        }
    }

    fclose(f);
    fprintf(stderr, "Loaded font ROM: %d glyphs\n", glyph_count);
    return rom;
}

// Find best matching glyph for a grayscale patch
int find_best_glyph(const uint8_t *patch, const FontROM *rom, uint8_t *out_bg, uint8_t *out_fg) {
    // Try both normal and inverted matching (unless --no-invert-char is set)
    int best_glyph = 0;
    float best_error = INFINITY;
    uint8_t best_bg = COLOR_BLACK, best_fg = COLOR_WHITE;

    for (int g = 0; g < rom->count; g++) {
        const uint8_t *glyph = &rom->data[g * PATCH_SZ];

        // Try normal: glyph 1 = fg, glyph 0 = bg
        float err_normal = 0;
        for (int i = 0; i < PATCH_SZ; i++) {
            int expected = glyph[i] ? 255 : 0;
            int diff = patch[i] - expected;
            err_normal += diff * diff;
        }

        if (err_normal < best_error) {
            best_error = err_normal;
            best_glyph = g;
            best_bg = COLOR_BLACK;
            best_fg = COLOR_WHITE;
        }

        // Try inverted: glyph 0 = fg, glyph 1 = bg (skip if --no-invert-char)
        if (!g_no_invert_char) {
            float err_inverted = 0;
            for (int i = 0; i < PATCH_SZ; i++) {
                int expected = glyph[i] ? 0 : 255;
                int diff = patch[i] - expected;
                err_inverted += diff * diff;
            }

            if (err_inverted < best_error) {
                best_error = err_inverted;
                best_glyph = g;
                best_bg = COLOR_WHITE;
                best_fg = COLOR_BLACK;
            }
        }
    }

    *out_bg = best_bg;
    *out_fg = best_fg;
    return best_glyph;
}

// Convert frame to text mode
void frame_to_text(const uint8_t *pixels, const FontROM *rom,
                   uint8_t *bg_col, uint8_t *fg_col, uint8_t *chars) {
    uint8_t patch[PATCH_SZ];

    for (int gr = 0; gr < GRID_H; gr++) {
        for (int gc = 0; gc < GRID_W; gc++) {
            int idx = gr * GRID_W + gc;

            // Extract patch
            for (int y = 0; y < CHAR_H; y++) {
                for (int x = 0; x < CHAR_W; x++) {
                    int px = gc * CHAR_W + x;
                    int py = gr * CHAR_H + y;
                    patch[y * CHAR_W + x] = pixels[py * PIXEL_W + px];
                }
            }

            // Find best match
            chars[idx] = find_best_glyph(patch, rom, &bg_col[idx], &fg_col[idx]);
        }
    }
}

// Get current time in nanoseconds since UNIX epoch
uint64_t get_current_time_ns(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint64_t)tv.tv_sec * 1000000000ULL + (uint64_t)tv.tv_usec * 1000ULL;
}

// Parse MP2 packet header to get accurate packet size
int get_mp2_packet_size(uint8_t *header) {
    int bitrate_index = (header[2] >> 4) & 0x0F;
    int bitrates[] = {0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384};
    if (bitrate_index >= 15) return MP2_DEFAULT_PACKET_SIZE;

    int bitrate = bitrates[bitrate_index];
    if (bitrate == 0) return MP2_DEFAULT_PACKET_SIZE;

    int sampling_freq_index = (header[2] >> 2) & 0x03;
    int sampling_freqs[] = {44100, 48000, 32000, 0};
    int sampling_freq = sampling_freqs[sampling_freq_index];
    if (sampling_freq == 0) return MP2_DEFAULT_PACKET_SIZE;

    int padding = (header[2] >> 1) & 0x01;
    return (144 * bitrate * 1000) / sampling_freq + padding;
}

// Write Videotex header (32 bytes, similar to TAV but simpler)
void write_videotex_header(FILE *f, uint8_t fps, uint32_t total_frames) {
    fwrite("\x1FTSVMTAV", 8, 1, f);

    // Version: 1 (uint8)
    fputc(1, f);

    // Grid dimensions (uint8 each)
    uint16_t width = GRID_W;
    uint16_t height = GRID_H;
    fwrite(&width, sizeof(uint16_t), 1, f);  // cols = 80
    fwrite(&height, sizeof(uint16_t), 1, f);  // rows = 32

    // FPS (uint8)
    fputc(fps, f);

    // Total frames (uint32, little-endian)
    fwrite(&total_frames, sizeof(uint32_t), 1, f);

    fputc(0, f); // wavelet filter type
    fputc(0, f); // decomposition levels
    fputc(0, f); // quantiser Y
    fputc(0, f); // quantiser Co
    fputc(0, f); // quantiser Cg

    // Feature Flags
    fputc(0x03, f);  // bit 0 = has audio; bit 1 = has subtitle (Videotex is classified as subtitles)

    // Video Flags
    fputc(0x80, f); // bit 7 = has no video (Videotex is classified as subtitles)


    fputc(0, f); // encoder quality level
    fputc(0x02, f); // channel layout: Y only
    fputc(0, f); // entropy coder

    fputc(0, f); // reserved
    fputc(0, f); // reserved

    fputc(0, f); // device orientation: no rotation
    fputc(0, f); // file role: generic
}

// Write extended header packet with metadata
// Returns the file offset where ENDT value is written (for later update)
long write_extended_header(FILE *f, uint64_t creation_time_ns, const char *ffmpeg_version) {
    fputc(PACKET_EXTENDED_HDR, f);

    // Helper macros for key-value pairs
    #define WRITE_KV_UINT64(key_str, value) do { \
        fwrite(key_str, 1, 4, f); \
        uint8_t value_type = 0x04; /* Uint64 */ \
        fwrite(&value_type, 1, 1, f); \
        uint64_t val = (value); \
        fwrite(&val, sizeof(uint64_t), 1, f); \
    } while(0)

    #define WRITE_KV_BYTES(key_str, data, len) do { \
        fwrite(key_str, 1, 4, f); \
        uint8_t value_type = 0x10; /* Bytes */ \
        fwrite(&value_type, 1, 1, f); \
        uint16_t length = (len); \
        fwrite(&length, sizeof(uint16_t), 1, f); \
        fwrite((data), 1, (len), f); \
    } while(0)

    // Count key-value pairs (BGNT, ENDT, CDAT, VNDR, FMPG)
    uint16_t num_pairs = ffmpeg_version ? 5 : 4;  // FMPG is optional
    fwrite(&num_pairs, sizeof(uint16_t), 1, f);

    // BGNT: Video begin time (0 for frame 0)
    WRITE_KV_UINT64("BGNT", 0ULL);

    // ENDT: Video end time (placeholder, will be updated at end)
    long endt_offset = ftell(f);
    WRITE_KV_UINT64("ENDT", 0ULL);

    // CDAT: Creation time in nanoseconds since UNIX epoch
    WRITE_KV_UINT64("CDAT", creation_time_ns);

    // VNDR: Encoder name and version
    const char *vendor_str = ENCODER_VENDOR_STRING;
    WRITE_KV_BYTES("VNDR", vendor_str, strlen(vendor_str));

    // FMPG: FFmpeg version (if available)
    if (ffmpeg_version) {
        WRITE_KV_BYTES("FMPG", ffmpeg_version, strlen(ffmpeg_version));
    }

    #undef WRITE_KV_UINT64
    #undef WRITE_KV_BYTES

    // Return offset of ENDT value (skip key, type byte)
    return endt_offset + 4 + 1;  // 4 bytes for "ENDT", 1 byte for type
}

// Write font ROM packet (SSF packet type 0x30)
void write_fontrom_packet(FILE *f, const uint8_t *rom_data, size_t data_size, uint8_t opcode) {
    // Prepare padded ROM data (pad to FONTROM_PADDED_SIZE with zeros)
    uint8_t *padded_data = calloc(1, FONTROM_PADDED_SIZE);
    memcpy(padded_data, rom_data, data_size);

    // Packet structure:
    // [type:0x30][size:uint32][index:uint24][opcode:uint8][length:uint16][data][terminator:0x00]
    uint32_t packet_size = 3 + 1 + 2 + FONTROM_PADDED_SIZE + 1;

    // Write packet type and size
    fputc(PACKET_SSF, f);
    fwrite(&packet_size, sizeof(uint32_t), 1, f);

    // Write SSF payload
    // Index (3 bytes, always 0 for font ROM)
    fputc(0, f);
    fputc(0, f);
    fputc(0, f);

    // Opcode (0x80=lowrom, 0x81=highrom)
    fputc(opcode, f);

    // Payload length (uint16, little-endian)
    uint16_t payload_len = FONTROM_PADDED_SIZE;
    fwrite(&payload_len, sizeof(uint16_t), 1, f);

    // Font data (padded to 1920 bytes)
    fwrite(padded_data, 1, FONTROM_PADDED_SIZE, f);

    // Terminator
    fputc(0x00, f);

    free(padded_data);

    fprintf(stderr, "Font ROM uploaded: %zu bytes (padded to %d), opcode 0x%02X\n",
            data_size, FONTROM_PADDED_SIZE, opcode);
}

// Write timecode packet (nanoseconds)
void write_timecode(FILE *f, uint64_t timecode_ns) {
    fputc(PACKET_TIMECODE, f);
    fwrite(&timecode_ns, sizeof(uint64_t), 1, f);
}

// Write sync packet
void write_sync(FILE *f) {
    fputc(PACKET_SYNC, f);
}

// Write MP2 audio packet
void write_audio_mp2(FILE *f, const uint8_t *data, uint32_t size) {
    fputc(PACKET_AUDIO_MP2, f);
    fwrite(&size, sizeof(uint32_t), 1, f);
    fwrite(data, 1, size, f);
}

// Write text packet with separated arrays (better compression)
void write_text_packet(FILE *f, const uint8_t *bg_col, const uint8_t *fg_col,
                       const uint8_t *chars, int rows, int cols) {
    int grid_size = rows * cols;

    // Prepare uncompressed data: [rows][cols][fg-array][bg-array][char-array]
    // Separated arrays compress much better (fg/bg are just 0xF0/0xFE runs)
    size_t uncompressed_size = 2 + grid_size * 3;
    uint8_t *uncompressed = malloc(uncompressed_size);

    uncompressed[0] = rows;
    uncompressed[1] = cols;

    // Copy arrays in order: foreground, background, characters
    memcpy(&uncompressed[2], fg_col, grid_size);                    // Foreground first
    memcpy(&uncompressed[2 + grid_size], bg_col, grid_size);        // Background second
    memcpy(&uncompressed[2 + grid_size * 2], chars, grid_size);     // Characters third

    // Compress with Zstd
    size_t max_compressed = ZSTD_compressBound(uncompressed_size);
    uint8_t *compressed = malloc(max_compressed);
    size_t compressed_size = ZSTD_compress(compressed, max_compressed,
                                           uncompressed, uncompressed_size, 3);

    if (ZSTD_isError(compressed_size)) {
        fprintf(stderr, "Zstd compression error\n");
        exit(1);
    }

    // Write packet: [type][size][data]
    fputc(PACKET_TEXT, f);
    uint32_t size32 = compressed_size;
    fwrite(&size32, 4, 1, f);
    fwrite(compressed, compressed_size, 1, f);

    free(compressed);
    free(uncompressed);
}

int main(int argc, char **argv) {
    if (argc < 7) {
        fprintf(stderr, "Usage: %s -i <video> -f <font.chr> -o <output.tav> [--no-invert-char]\n", argv[0]);
        return 1;
    }

    const char *input_video = NULL;
    const char *font_path = NULL;
    const char *output_path = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-i") == 0 && i+1 < argc) input_video = argv[++i];
        else if (strcmp(argv[i], "-f") == 0 && i+1 < argc) font_path = argv[++i];
        else if (strcmp(argv[i], "-o") == 0 && i+1 < argc) output_path = argv[++i];
        else if (strcmp(argv[i], "--no-invert-char") == 0) g_no_invert_char = 1;
    }

    if (!input_video || !font_path || !output_path) {
        fprintf(stderr, "Missing required arguments\n");
        return 1;
    }

    if (g_no_invert_char) {
        fprintf(stderr, "Inverted character matching disabled\n");
    }

    // Generate random temp filename for audio
    generate_random_filename(TEMP_AUDIO_FILE);

    // Capture creation time and FFmpeg version for extended header
    uint64_t creation_time_ns = get_current_time_ns();
    char *ffmpeg_version = get_ffmpeg_version();

    // Detect video FPS
    float fps_float = detect_fps(input_video);
    uint8_t fps = (uint8_t)(fps_float + 0.5f); // Round to nearest integer
    fprintf(stderr, "Detected FPS: %.2f (using %d in TAV header)\n", fps_float, fps);

    // Load font ROM
    FontROM *rom = load_font_rom(font_path);
    if (!rom) {
        fprintf(stderr, "Failed to load font ROM: %s\n", font_path);
        return 1;
    }

    // Open FFmpeg pipe for grayscale frames at 560×448
    char ffmpeg_cmd[1024];
    snprintf(ffmpeg_cmd, sizeof(ffmpeg_cmd),
             "ffmpeg -i \"%s\" -vf \"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d\" "
             "-f rawvideo -pix_fmt gray - 2>/dev/null",
             input_video, PIXEL_W, PIXEL_H, PIXEL_W, PIXEL_H);

    fprintf(stderr, "Opening video stream...\n");
    FILE *video_pipe = popen(ffmpeg_cmd, "r");
    if (!video_pipe) {
        fprintf(stderr, "Failed to open FFmpeg pipe\n");
        return 1;
    }

    // Extract MP2 audio to temporary file using libtwolame
    fprintf(stderr, "Extracting MP2 audio...\n");
    char audio_cmd[1024];
    snprintf(audio_cmd, sizeof(audio_cmd),
             "ffmpeg -v quiet -i \"%s\" -acodec libtwolame -psymodel 4 -b:a 224k -ar %d -ac 2 -y \"%s\" 2>/dev/null",
             input_video, SAMPLE_RATE, TEMP_AUDIO_FILE);

    int audio_result = system(audio_cmd);
    if (audio_result != 0) {
        fprintf(stderr, "Warning: Audio extraction failed, continuing without audio\n");
    }

    // Open MP2 file for reading
    FILE *mp2_file = NULL;
    long audio_remaining = 0;
    if (audio_result == 0) {
        mp2_file = fopen(TEMP_AUDIO_FILE, "rb");
        if (mp2_file) {
            fseek(mp2_file, 0, SEEK_END);
            audio_remaining = ftell(mp2_file);
            fseek(mp2_file, 0, SEEK_SET);
            fprintf(stderr, "Audio ready: %ld bytes\n", audio_remaining);
        }
    }

    // Open output file
    FILE *out = fopen(output_path, "wb");
    if (!out) {
        fprintf(stderr, "Failed to open output file\n");
        pclose(video_pipe);
        if (mp2_file) fclose(mp2_file);
        return 1;
    }

    // Write Videotex header with placeholder total_frames (will update at end)
    long header_offset = ftell(out);
    write_videotex_header(out, fps, 0);

    // Write extended header packet (before first timecode)
    long endt_offset = write_extended_header(out, creation_time_ns, ffmpeg_version);

    // Upload font ROM to TSVM (split into lowrom and highrom)
    fprintf(stderr, "Uploading font ROM to TSVM...\n");
    FILE *rom_file = fopen(font_path, "rb");
    if (rom_file) {
        fseek(rom_file, 0, SEEK_END);
        long rom_size = ftell(rom_file);
        fseek(rom_file, 0, SEEK_SET);

        uint8_t *raw_rom = malloc(rom_size);
        if (raw_rom && fread(raw_rom, 1, rom_size, rom_file) == rom_size) {
            // Split into lowrom and highrom
            size_t bytes_per_half = (GLYPHS_PER_ROM * 14); // 128 glyphs × 14 bytes = 1792

            // Write lowrom (first 128 glyphs)
            if (rom_size >= bytes_per_half) {
                write_fontrom_packet(out, raw_rom, bytes_per_half, SSF_OPCODE_LOWROM);
            }

            // Write highrom (second 128 glyphs)
            if (rom_size >= bytes_per_half * 2) {
                write_fontrom_packet(out, raw_rom + bytes_per_half, bytes_per_half, SSF_OPCODE_HIGHROM);
            } else if (rom_size > bytes_per_half) {
                // Partial highrom
                write_fontrom_packet(out, raw_rom + bytes_per_half, rom_size - bytes_per_half, SSF_OPCODE_HIGHROM);
            }

            free(raw_rom);
        }
        fclose(rom_file);
    }

    // Allocate buffers
    size_t frame_size = PIXEL_W * PIXEL_H;
    uint8_t *gray_pixels = malloc(frame_size);
    uint8_t *bg_col = malloc(GRID_W * GRID_H);
    uint8_t *fg_col = malloc(GRID_W * GRID_H);
    uint8_t *chars = malloc(GRID_W * GRID_H);

    // Audio buffer for MP2 packets
    #define MP2_BUFFER_SIZE 2048
    uint8_t *audio_buffer = malloc(MP2_BUFFER_SIZE);

    uint32_t frame_num = 0;
    uint64_t total_audio_bytes = 0;

    // Audio timing calculation
    double frame_audio_time = 1.0 / fps_float;  // Time per video frame
    double packet_audio_time = (double)MP2_DEFAULT_PACKET_SIZE / SAMPLE_RATE;  // Time per audio packet
    double packets_per_frame = frame_audio_time / packet_audio_time;
    double audio_frames_in_buffer = 0.0;  // Simulated audio buffer level

    fprintf(stderr, "Encoding text-mode video (%dx%d chars, %dx%d pixels)...\n",
            GRID_W, GRID_H, PIXEL_W, PIXEL_H);

    // Track encoding start time
    struct timeval start_time, now;
    gettimeofday(&start_time, NULL);

    // Read and process frames
    while (fread(gray_pixels, 1, frame_size, video_pipe) == frame_size) {
        // Calculate timecode in nanoseconds
        uint64_t timecode_ns = (uint64_t)(frame_num * 1000000000.0 / fps_float);

        // Write audio packets for this frame (based on timing)
        if (mp2_file && audio_remaining > 0) {
            // Simulate buffer consumption
            audio_frames_in_buffer -= packets_per_frame;

            // Calculate how many packets we need to maintain buffer
            double target_level = fmax(packets_per_frame, 2.0);
            int packets_to_insert = 0;

            if (audio_frames_in_buffer < target_level) {
                double deficit = target_level - audio_frames_in_buffer;
                packets_to_insert = (int)ceil(deficit);
            }

            // Insert the calculated number of audio packets
            for (int q = 0; q < packets_to_insert; q++) {
                // Peek at header to get actual packet size
                long pos = ftell(mp2_file);
                uint8_t header[4];
                if (fread(header, 1, 4, mp2_file) != 4) break;
                fseek(mp2_file, pos, SEEK_SET);  // Rewind to re-read with full packet

                int actual_packet_size = get_mp2_packet_size(header);
                size_t bytes_to_read = actual_packet_size;

                // Clamp to remaining audio
                if (bytes_to_read > audio_remaining) {
                    bytes_to_read = audio_remaining;
                }

                // Sanity check
                if (bytes_to_read > MP2_BUFFER_SIZE) {
                    fprintf(stderr, "ERROR: MP2 packet size %zu exceeds buffer\n", bytes_to_read);
                    break;
                }

                // Read full packet
                size_t bytes_read = fread(audio_buffer, 1, bytes_to_read, mp2_file);
                if (bytes_read == 0) break;

                // Write MP2 audio packet
                write_audio_mp2(out, audio_buffer, bytes_read);

                // Track audio
                audio_remaining -= bytes_read;
                audio_frames_in_buffer++;
                total_audio_bytes += bytes_read;
            }
        }

        // Write timecode
        write_timecode(out, timecode_ns);

        // Convert to text mode
        frame_to_text(gray_pixels, rom, bg_col, fg_col, chars);

        // Write text packet (treated as I-frame)
        write_text_packet(out, bg_col, fg_col, chars, GRID_H, GRID_W);

        // Write sync packet after each frame
        write_sync(out);

        frame_num++;
        if (frame_num % 30 == 0) {
            // Calculate encoding speed
            gettimeofday(&now, NULL);
            double elapsed = (now.tv_sec - start_time.tv_sec) +
                           (now.tv_usec - start_time.tv_usec) / 1000000.0;
            double encoding_fps = frame_num / elapsed;

            fprintf(stderr, "\rEncoded %u frames (%.1f fps)", frame_num, encoding_fps);
            fflush(stderr);
        }
    }

    // Write any remaining audio
    if (mp2_file && audio_remaining > 0) {
        while (audio_remaining > 0) {
            // Peek at header to get actual packet size
            long pos = ftell(mp2_file);
            uint8_t header[4];
            if (fread(header, 1, 4, mp2_file) != 4) break;
            fseek(mp2_file, pos, SEEK_SET);

            int actual_packet_size = get_mp2_packet_size(header);
            size_t bytes_to_read = (actual_packet_size < audio_remaining) ? actual_packet_size : audio_remaining;

            if (bytes_to_read > MP2_BUFFER_SIZE) break;

            size_t bytes_read = fread(audio_buffer, 1, bytes_to_read, mp2_file);
            if (bytes_read == 0) break;

            write_audio_mp2(out, audio_buffer, bytes_read);
            audio_remaining -= bytes_read;
            total_audio_bytes += bytes_read;
        }
    }

    // Final timing
    gettimeofday(&now, NULL);
    double total_time = (now.tv_sec - start_time.tv_sec) +
                       (now.tv_usec - start_time.tv_usec) / 1000000.0;
    double final_fps = frame_num / total_time;

    fprintf(stderr, "\nDone! Encoded %u frames in %.2fs (%.1f fps)\n",
            frame_num, total_time, final_fps);
    fprintf(stderr, "Audio: %llu bytes (%.2f MB)\n",
            (unsigned long long)total_audio_bytes,
            total_audio_bytes / 1024.0 / 1024.0);

    // Update total_frames in header
    if (frame_num > 0) {
        fseek(out, header_offset + 14, SEEK_SET);  // Offset to total_frames field
        fwrite(&frame_num, sizeof(uint32_t), 1, out);
        fprintf(stderr, "Updated total_frames in header: %u\n", frame_num);
    }

    // Update ENDT in extended header (calculate end time for last frame)
    if (frame_num > 0) {
        // Calculate duration: (frame_num - 1) frames * (1/fps) seconds in nanoseconds
        uint64_t duration_ns = (uint64_t)((frame_num - 1) * 1000000000.0 / fps_float);
        uint64_t endt_ns = duration_ns;

        fseek(out, endt_offset, SEEK_SET);
        fwrite(&endt_ns, sizeof(uint64_t), 1, out);
        fprintf(stderr, "Updated ENDT in extended header: %llu ns (%.3f seconds)\n",
                (unsigned long long)endt_ns, endt_ns / 1000000000.0);
    }

    // Cleanup
    pclose(video_pipe);
    if (mp2_file) {
        fclose(mp2_file);
        unlink(TEMP_AUDIO_FILE);  // Remove temporary audio file
    }
    fclose(out);
    free(gray_pixels);
    free(bg_col);
    free(fg_col);
    free(chars);
    free(audio_buffer);
    free(rom->data);
    free(rom);
    if (ffmpeg_version) free(ffmpeg_version);

    return 0;
}
