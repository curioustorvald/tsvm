#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <zlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <getopt.h>
#include <sys/time.h>

// TVDOS Movie format constants
#define TVDOS_MAGIC "\x1F\x54\x53\x56\x4D\x4D\x4F\x56"  // "\x1FTSVM MOV"
#define IPF_BLOCK_SIZE 12

// iPF1-delta opcodes
#define SKIP_OP  0x00
#define PATCH_OP 0x01
#define REPEAT_OP 0x02
#define END_OP   0xFF

// Video packet types
#define IPF1_PACKET_TYPE 0x04, 0x00      // iPF Type 1 (4 + 0)
#define IPF1_DELTA_PACKET_TYPE 0x04, 0x02 // iPF Type 1 delta
#define SYNC_PACKET_TYPE 0xFF, 0xFF      // Sync packet

// Audio constants
#define MP2_SAMPLE_RATE 32000
#define MP2_DEFAULT_PACKET_SIZE 0x240
#define MP2_PACKET_TYPE_BASE 0x11

// Default values
#define DEFAULT_WIDTH 560
#define DEFAULT_HEIGHT 448
#define TEMP_AUDIO_FILE "/tmp/tvdos_temp_audio.mp2"

typedef struct {
    char *input_file;
    char *output_file;
    int width;
    int height;
    int fps;
    int total_frames;
    double duration;
    int has_audio;
    int output_to_stdout;
    
    // Internal buffers
    uint8_t *previous_ipf_frame;
    uint8_t *current_ipf_frame;
    uint8_t *delta_buffer;
    uint8_t *rgb_buffer;
    uint8_t *compressed_buffer;
    uint8_t *mp2_buffer;
    size_t frame_buffer_size;
    
    // Audio handling
    FILE *mp2_file;
    int mp2_packet_size;
    int mp2_rate_index;
    size_t audio_remaining;
    int audio_frames_in_buffer;
    int target_audio_buffer_size;
    
    // FFmpeg processes
    FILE *ffmpeg_video_pipe;
    FILE *ffmpeg_audio_pipe;
    
    // Progress tracking
    struct timeval start_time;
    struct timeval last_progress_time;
    size_t total_output_bytes;
    
    // Dithering mode
    int dither_mode;
} encoder_config_t;

// CORRECTED YCoCg conversion matching Kotlin implementation
typedef struct {
    float y, co, cg;
} ycocg_t;

static ycocg_t rgb_to_ycocg_correct(uint8_t r, uint8_t g, uint8_t b, float ditherThreshold) {
    ycocg_t result;
    float rf = floor((ditherThreshold / 15.0 + r / 255.0) * 15.0) / 15.0;
    float gf = floor((ditherThreshold / 15.0 + g / 255.0) * 15.0) / 15.0;
    float bf = floor((ditherThreshold / 15.0 + b / 255.0) * 15.0) / 15.0;

    // CORRECTED: Match Kotlin implementation exactly
    float co = rf - bf;           // co = r - b    [-1..1]
    float tmp = bf + co / 2.0f;   // tmp = b + co/2
    float cg = gf - tmp;          // cg = g - tmp  [-1..1]
    float y = tmp + cg / 2.0f;    // y = tmp + cg/2 [0..1]
    
    result.y = y;
    result.co = co;
    result.cg = cg;
    
    return result;
}

static int quantise_4bit_y(float value) {
    // Y quantisation: round(y * 15)
    return (int)round(fmaxf(0.0f, fminf(15.0f, value * 15.0f)));
}

static int chroma_to_four_bits(float f) {
    // CORRECTED: Match Kotlin chromaToFourBits function exactly
    // return (round(f * 8) + 7).coerceIn(0..15)
    int result = (int)round(f * 8.0f) + 7;
    return fmaxf(0, fminf(15, result));
}

// Parse resolution string like "1024x768"
static int parse_resolution(const char *res_str, int *width, int *height) {
    if (!res_str) return 0;
    return sscanf(res_str, "%dx%d", width, height) == 2;
}

// Execute command and capture output
static char *execute_command(const char *command) {
    FILE *pipe = popen(command, "r");
    if (!pipe) return NULL;
    
    char *result = malloc(4096);
    size_t len = fread(result, 1, 4095, pipe);
    result[len] = '\0';
    
    pclose(pipe);
    return result;
}

// Get video metadata using ffprobe
static int get_video_metadata(encoder_config_t *config) {
    char command[1024];
    char *output;
    
    // Get frame count
    snprintf(command, sizeof(command), 
        "ffprobe -v quiet -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 \"%s\"", 
        config->input_file);
    output = execute_command(command);
    if (!output) {
        fprintf(stderr, "Failed to get frame count\n");
        return 0;
    }
    config->total_frames = atoi(output);
    free(output);
    
    // Get frame rate
    snprintf(command, sizeof(command),
        "ffprobe -v quiet -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 \"%s\"",
        config->input_file);
    output = execute_command(command);
    if (!output) {
        fprintf(stderr, "Failed to get frame rate\n");
        return 0;
    }
    
    // Parse framerate (could be "30/1" or "29.97")
    int num, den;
    if (sscanf(output, "%d/%d", &num, &den) == 2) {
        config->fps = (den > 0) ? (num / den) : 30;
    } else {
        config->fps = (int)round(atof(output));
    }
    free(output);
    
    // Get duration
    snprintf(command, sizeof(command),
        "ffprobe -v quiet -show_entries format=duration -of csv=p=0 \"%s\"",
        config->input_file);
    output = execute_command(command);
    if (output) {
        config->duration = atof(output);
        free(output);
    }
    
    // Check if has audio
    snprintf(command, sizeof(command),
        "ffprobe -v quiet -select_streams a:0 -show_entries stream=index -of csv=p=0 \"%s\"",
        config->input_file);
    output = execute_command(command);
    config->has_audio = (output && strlen(output) > 0 && atoi(output) >= 0);
    if (output) free(output);
    
    // Validate frame count using duration if needed
    if (config->total_frames <= 0 && config->duration > 0) {
        config->total_frames = (int)(config->duration * config->fps);
    }
    
    fprintf(stderr, "Video metadata:\n");
    fprintf(stderr, "  Frames: %d\n", config->total_frames);
    fprintf(stderr, "  FPS: %d\n", config->fps);
    fprintf(stderr, "  Duration: %.2fs\n", config->duration);
    fprintf(stderr, "  Audio: %s\n", config->has_audio ? "Yes" : "No");
    fprintf(stderr, "  Resolution: %dx%d\n", config->width, config->height);
    
    return (config->total_frames > 0 && config->fps > 0);
}

// Start FFmpeg process for video conversion
static int start_video_conversion(encoder_config_t *config) {
    char command[2048];
    snprintf(command, sizeof(command),
        "ffmpeg -i \"%s\" -f rawvideo -pix_fmt rgb24 -vf scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d -y - 2>/dev/null",
        config->input_file, config->width, config->height, config->width, config->height);
    
    config->ffmpeg_video_pipe = popen(command, "r");
    return (config->ffmpeg_video_pipe != NULL);
}

// Start FFmpeg process for audio conversion
static int start_audio_conversion(encoder_config_t *config) {
    if (!config->has_audio) return 1;
    
    char command[2048];
    snprintf(command, sizeof(command),
        "ffmpeg -i \"%s\" -acodec libtwolame -psymodel 4 -b:a 192k -ar %d -ac 2 -y \"%s\" 2>/dev/null",
        config->input_file, MP2_SAMPLE_RATE, TEMP_AUDIO_FILE);
    
    int result = system(command);
    if (result == 0) {
        config->mp2_file = fopen(TEMP_AUDIO_FILE, "rb");
        if (config->mp2_file) {
            fseek(config->mp2_file, 0, SEEK_END);
            config->audio_remaining = ftell(config->mp2_file);
            fseek(config->mp2_file, 0, SEEK_SET);
            return 1;
        }
    }
    
    fprintf(stderr, "Warning: Failed to convert audio, proceeding without audio\n");
    config->has_audio = 0;
    return 1;
}

// Write variable-length integer
static void write_varint(uint8_t **ptr, uint32_t value) {
    while (value >= 0x80) {
        **ptr = (uint8_t)((value & 0x7F) | 0x80);
        (*ptr)++;
        value >>= 7;
    }
    **ptr = (uint8_t)(value & 0x7F);
    (*ptr)++;
}

// Get MP2 packet size and rate index
static int get_mp2_packet_size(uint8_t *header) {
    int bitrate_index = (header[2] >> 4) & 0xF;
    int padding_bit = (header[2] >> 1) & 0x1;
    
    int bitrates[] = {0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1};
    int bitrate = bitrates[bitrate_index];
    
    if (bitrate <= 0) return MP2_DEFAULT_PACKET_SIZE;
    
    int frame_size = (144 * bitrate * 1000) / MP2_SAMPLE_RATE + padding_bit;
    return frame_size;
}

static int mp2_packet_size_to_rate_index(int packet_size, int is_mono) {
    int rate_index;
    switch (packet_size) {
        case 144:  rate_index = 0; break;
        case 216:  rate_index = 2; break;
        case 252:  rate_index = 4; break;
        case 288:  rate_index = 6; break;
        case 360:  rate_index = 8; break;
        case 432:  rate_index = 10; break;
        case 504:  rate_index = 12; break;
        case 576:  rate_index = 14; break;
        case 720:  rate_index = 16; break;
        case 864:  rate_index = 18; break;
        case 1008: rate_index = 20; break;
        case 1152: rate_index = 22; break;
        case 1440: rate_index = 24; break;
        case 1728: rate_index = 26; break;
        default: rate_index = 14; break;
    }
    return rate_index + (is_mono ? 1 : 0);
}

// Gzip compress function (instead of zlib)
static size_t gzip_compress(uint8_t *src, size_t src_len, uint8_t *dst, size_t dst_max) {
    z_stream stream = {0};
    stream.next_in = src;
    stream.avail_in = src_len;
    stream.next_out = dst;
    stream.avail_out = dst_max;
    
    // Use deflateInit2 with gzip format
    if (deflateInit2(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
        return 0;
    }
    
    if (deflate(&stream, Z_FINISH) != Z_STREAM_END) {
        deflateEnd(&stream);
        return 0;
    }
    
    size_t compressed_size = stream.total_out;
    deflateEnd(&stream);
    return compressed_size;
}

// Bayer dithering kernels (4 patterns, each 4x4)
static const float bayerKernels[4][16] = {
    { // Pattern 0
        (0.0f + 0.5f) / 16.0f, (8.0f + 0.5f) / 16.0f, (2.0f + 0.5f) / 16.0f, (10.0f + 0.5f) / 16.0f,
        (12.0f + 0.5f) / 16.0f, (4.0f + 0.5f) / 16.0f, (14.0f + 0.5f) / 16.0f, (6.0f + 0.5f) / 16.0f,
        (3.0f + 0.5f) / 16.0f, (11.0f + 0.5f) / 16.0f, (1.0f + 0.5f) / 16.0f, (9.0f + 0.5f) / 16.0f,
        (15.0f + 0.5f) / 16.0f, (7.0f + 0.5f) / 16.0f, (13.0f + 0.5f) / 16.0f, (5.0f + 0.5f) / 16.0f
    },
    { // Pattern 1
        (8.0f + 0.5f) / 16.0f, (2.0f + 0.5f) / 16.0f, (10.0f + 0.5f) / 16.0f, (0.0f + 0.5f) / 16.0f,
        (4.0f + 0.5f) / 16.0f, (14.0f + 0.5f) / 16.0f, (6.0f + 0.5f) / 16.0f, (12.0f + 0.5f) / 16.0f,
        (11.0f + 0.5f) / 16.0f, (1.0f + 0.5f) / 16.0f, (9.0f + 0.5f) / 16.0f, (3.0f + 0.5f) / 16.0f,
        (7.0f + 0.5f) / 16.0f, (13.0f + 0.5f) / 16.0f, (5.0f + 0.5f) / 16.0f, (15.0f + 0.5f) / 16.0f
    },
    { // Pattern 2
        (7.0f + 0.5f) / 16.0f, (13.0f + 0.5f) / 16.0f, (5.0f + 0.5f) / 16.0f, (15.0f + 0.5f) / 16.0f,
        (8.0f + 0.5f) / 16.0f, (2.0f + 0.5f) / 16.0f, (10.0f + 0.5f) / 16.0f, (0.0f + 0.5f) / 16.0f,
        (4.0f + 0.5f) / 16.0f, (14.0f + 0.5f) / 16.0f, (6.0f + 0.5f) / 16.0f, (12.0f + 0.5f) / 16.0f,
        (11.0f + 0.5f) / 16.0f, (1.0f + 0.5f) / 16.0f, (9.0f + 0.5f) / 16.0f, (3.0f + 0.5f) / 16.0f
    },
    { // Pattern 3
        (15.0f + 0.5f) / 16.0f, (7.0f + 0.5f) / 16.0f, (13.0f + 0.5f) / 16.0f, (5.0f + 0.5f) / 16.0f,
        (0.0f + 0.5f) / 16.0f, (8.0f + 0.5f) / 16.0f, (2.0f + 0.5f) / 16.0f, (10.0f + 0.5f) / 16.0f,
        (12.0f + 0.5f) / 16.0f, (4.0f + 0.5f) / 16.0f, (14.0f + 0.5f) / 16.0f, (6.0f + 0.5f) / 16.0f,
        (3.0f + 0.5f) / 16.0f, (11.0f + 0.5f) / 16.0f, (1.0f + 0.5f) / 16.0f, (9.0f + 0.5f) / 16.0f
    }
};

// CORRECTED: Encode a 4x4 block to iPF1 format matching Kotlin implementation
static void encode_ipf1_block_correct(uint8_t *rgb_data, int width, int height, int block_x, int block_y,
                                     int channels, int pattern, uint8_t *output) {
    ycocg_t pixels[16];
    int y_values[16];
    float co_values[16];  // Keep full precision for subsampling
    float cg_values[16];  // Keep full precision for subsampling
    
    // Convert 4x4 block to YCoCg using corrected transform
    for (int py = 0; py < 4; py++) {
        for (int px = 0; px < 4; px++) {
            int src_x = block_x * 4 + px;
            int src_y = block_y * 4 + py;
            float t = (pattern < 0) ? 0.0f : bayerKernels[pattern % 4][4 * (py % 4) + (px % 4)];
            int idx = py * 4 + px;
            
            if (src_x < width && src_y < height) {
                int pixel_offset = (src_y * width + src_x) * channels;
                uint8_t r = rgb_data[pixel_offset];
                uint8_t g = rgb_data[pixel_offset + 1];
                uint8_t b = rgb_data[pixel_offset + 2];
                pixels[idx] = rgb_to_ycocg_correct(r, g, b, t);
            } else {
                pixels[idx] = (ycocg_t){0.0f, 0.0f, 0.0f};
            }
            
            y_values[idx] = quantise_4bit_y(pixels[idx].y);
            co_values[idx] = pixels[idx].co;
            cg_values[idx] = pixels[idx].cg;
        }
    }
    
    // CORRECTED: Chroma subsampling (4:2:0 for iPF1) with correct averaging
    int cos1 = chroma_to_four_bits((co_values[0] + co_values[1] + co_values[4] + co_values[5]) / 4.0f);
    int cos2 = chroma_to_four_bits((co_values[2] + co_values[3] + co_values[6] + co_values[7]) / 4.0f);
    int cos3 = chroma_to_four_bits((co_values[8] + co_values[9] + co_values[12] + co_values[13]) / 4.0f);
    int cos4 = chroma_to_four_bits((co_values[10] + co_values[11] + co_values[14] + co_values[15]) / 4.0f);
    
    int cgs1 = chroma_to_four_bits((cg_values[0] + cg_values[1] + cg_values[4] + cg_values[5]) / 4.0f);
    int cgs2 = chroma_to_four_bits((cg_values[2] + cg_values[3] + cg_values[6] + cg_values[7]) / 4.0f);
    int cgs3 = chroma_to_four_bits((cg_values[8] + cg_values[9] + cg_values[12] + cg_values[13]) / 4.0f);
    int cgs4 = chroma_to_four_bits((cg_values[10] + cg_values[11] + cg_values[14] + cg_values[15]) / 4.0f);
    
    // CORRECTED: Pack into iPF1 format matching Kotlin exactly
    // Co values (2 bytes): cos2|cos1, cos4|cos3
    output[0] = ((cos2 << 4) | cos1);
    output[1] = ((cos4 << 4) | cos3);
    
    // Cg values (2 bytes): cgs2|cgs1, cgs4|cgs3
    output[2] = ((cgs2 << 4) | cgs1);
    output[3] = ((cgs4 << 4) | cgs3);
    
    // CORRECTED: Y values (8 bytes) with correct ordering from Kotlin
    output[4] = ((y_values[1] << 4) | y_values[0]);   // Y1|Y0
    output[5] = ((y_values[5] << 4) | y_values[4]);   // Y5|Y4  
    output[6] = ((y_values[3] << 4) | y_values[2]);   // Y3|Y2
    output[7] = ((y_values[7] << 4) | y_values[6]);   // Y7|Y6
    output[8] = ((y_values[9] << 4) | y_values[8]);   // Y9|Y8
    output[9] = ((y_values[13] << 4) | y_values[12]); // Y13|Y12
    output[10] = ((y_values[11] << 4) | y_values[10]); // Y11|Y10
    output[11] = ((y_values[15] << 4) | y_values[14]); // Y15|Y14
}

// Helper function for contrast weighting
static double contrast_weight(int v1, int v2, int delta, int weight) {
    double avg = (v1 + v2) / 2.0;
    double contrast = (avg < 4 || avg > 11) ? 1.5 : 1.0;
    return delta * weight * contrast;
}

// Check if two iPF1 blocks are significantly different
static int is_significantly_different(uint8_t *block_a, uint8_t *block_b) {
    double score = 0.0;
    
    // Co values (bytes 0-1)
    uint16_t co_a = block_a[0] | (block_a[1] << 8);
    uint16_t co_b = block_b[0] | (block_b[1] << 8);
    for (int i = 0; i < 4; i++) {
        int va = (co_a >> (i * 4)) & 0xF;
        int vb = (co_b >> (i * 4)) & 0xF;
        int delta = abs(va - vb);
        score += contrast_weight(va, vb, delta, 3);
    }
    
    // Cg values (bytes 2-3)
    uint16_t cg_a = block_a[2] | (block_a[3] << 8);
    uint16_t cg_b = block_b[2] | (block_b[3] << 8);
    for (int i = 0; i < 4; i++) {
        int va = (cg_a >> (i * 4)) & 0xF;
        int vb = (cg_b >> (i * 4)) & 0xF;
        int delta = abs(va - vb);
        score += contrast_weight(va, vb, delta, 3);
    }
    
    // Y values (bytes 4-11)
    for (int i = 4; i < 12; i++) {
        int byte_a = block_a[i] & 0xFF;
        int byte_b = block_b[i] & 0xFF;
        
        int y_a_high = (byte_a >> 4) & 0xF;
        int y_a_low = byte_a & 0xF;
        int y_b_high = (byte_b >> 4) & 0xF;
        int y_b_low = byte_b & 0xF;
        
        int delta_high = abs(y_a_high - y_b_high);
        int delta_low = abs(y_a_low - y_b_low);
        
        score += contrast_weight(y_a_high, y_b_high, delta_high, 2);
        score += contrast_weight(y_a_low, y_b_low, delta_low, 2);
    }
    
    return score > 4.0;
}

// Encode iPF1 frame to buffer
static void encode_ipf1_frame(uint8_t *rgb_data, int width, int height, int channels, int pattern,
                             uint8_t *ipf_buffer) {
    int blocks_per_row = (width + 3) / 4;
    int blocks_per_col = (height + 3) / 4;
    
    for (int block_y = 0; block_y < blocks_per_col; block_y++) {
        for (int block_x = 0; block_x < blocks_per_row; block_x++) {
            int block_index = block_y * blocks_per_row + block_x;
            uint8_t *output_block = ipf_buffer + block_index * IPF_BLOCK_SIZE;
            encode_ipf1_block_correct(rgb_data, width, height, block_x, block_y, channels, pattern, output_block);
        }
    }
}

// Create iPF1-delta encoded frame
static size_t encode_ipf1_delta(uint8_t *previous_frame, uint8_t *current_frame, 
                               int width, int height, uint8_t *delta_buffer) {
    int blocks_per_row = (width + 3) / 4;
    int blocks_per_col = (height + 3) / 4;
    int total_blocks = blocks_per_row * blocks_per_col;
    
    uint8_t *output_ptr = delta_buffer;
    int skip_count = 0;
    uint8_t *patch_blocks = malloc(total_blocks * IPF_BLOCK_SIZE);
    int patch_count = 0;
    
    for (int block_index = 0; block_index < total_blocks; block_index++) {
        uint8_t *prev_block = previous_frame + block_index * IPF_BLOCK_SIZE;
        uint8_t *curr_block = current_frame + block_index * IPF_BLOCK_SIZE;
        
        if (is_significantly_different(prev_block, curr_block)) {
            if (skip_count > 0) {
                *output_ptr++ = SKIP_OP;
                write_varint(&output_ptr, skip_count);
                skip_count = 0;
            }
            
            memcpy(patch_blocks + patch_count * IPF_BLOCK_SIZE, curr_block, IPF_BLOCK_SIZE);
            patch_count++;
        } else {
            if (patch_count > 0) {
                *output_ptr++ = PATCH_OP;
                write_varint(&output_ptr, patch_count);
                memcpy(output_ptr, patch_blocks, patch_count * IPF_BLOCK_SIZE);
                output_ptr += patch_count * IPF_BLOCK_SIZE;
                patch_count = 0;
            }
            skip_count++;
        }
    }
    
    if (patch_count > 0) {
        *output_ptr++ = PATCH_OP;
        write_varint(&output_ptr, patch_count);
        memcpy(output_ptr, patch_blocks, patch_count * IPF_BLOCK_SIZE);
        output_ptr += patch_count * IPF_BLOCK_SIZE;
    }
    
    *output_ptr++ = END_OP;
    
    free(patch_blocks);
    return output_ptr - delta_buffer;
}

// Get current time in seconds
static double get_current_time_sec(struct timeval *tv) {
    gettimeofday(tv, NULL);
    return tv->tv_sec + tv->tv_usec / 1000000.0;
}

// Display progress information similar to FFmpeg
static void display_progress(encoder_config_t *config, int frame_num) {
    struct timeval current_time;
    double current_sec = get_current_time_sec(&current_time);
    
    // Only update progress once per second
    double last_progress_sec = config->last_progress_time.tv_sec + config->last_progress_time.tv_usec / 1000000.0;
    if (current_sec - last_progress_sec < 1.0) {
        return;
    }
    
    config->last_progress_time = current_time;
    
    // Calculate timing
    double start_sec = config->start_time.tv_sec + config->start_time.tv_usec / 1000000.0;
    double elapsed_sec = current_sec - start_sec;
    double current_video_time = (double)frame_num / config->fps;
    double fps = frame_num / elapsed_sec;
    double speed = (elapsed_sec > 0) ? current_video_time / elapsed_sec : 0.0;
    double bitrate = (elapsed_sec > 0) ? (config->total_output_bytes * 8.0 / 1024.0) / elapsed_sec : 0.0;
    
    // Format output size in human readable format
    char size_str[32];
    if (config->total_output_bytes >= 1024 * 1024) {
        snprintf(size_str, sizeof(size_str), "%.1fMB", config->total_output_bytes / (1024.0 * 1024.0));
    } else if (config->total_output_bytes >= 1024) {
        snprintf(size_str, sizeof(size_str), "%.1fkB", config->total_output_bytes / 1024.0);
    } else {
        snprintf(size_str, sizeof(size_str), "%zuB", config->total_output_bytes);
    }
    
    // Format current time as HH:MM:SS.xx
    int hours = (int)(current_video_time / 3600);
    int minutes = (int)((current_video_time - hours * 3600) / 60);
    double seconds = current_video_time - hours * 3600 - minutes * 60;
    
    // Print progress line (overwrite previous line)
    fprintf(stderr, "\rframe=%d fps=%.1f size=%s time=%02d:%02d:%05.2f bitrate=%.1fkbits/s speed=%4.2fx", 
            frame_num, fps, size_str, hours, minutes, seconds, bitrate, speed);
    fflush(stderr);
}

// Process audio for current frame
static int process_audio(encoder_config_t *config, int frame_num, FILE *output) {
    if (!config->has_audio || !config->mp2_file || config->audio_remaining <= 0) {
        return 1;
    }
    
    // Initialise packet size on first frame
    if (config->mp2_packet_size == 0) {
        uint8_t header[4];
        if (fread(header, 1, 4, config->mp2_file) != 4) return 1;
        fseek(config->mp2_file, 0, SEEK_SET);
        
        config->mp2_packet_size = get_mp2_packet_size(header);
        int is_mono = (header[3] >> 6) == 3;
        config->mp2_rate_index = mp2_packet_size_to_rate_index(config->mp2_packet_size, is_mono);
    }
    
    // Calculate how much audio time each frame represents (in seconds)
    double frame_audio_time = 1.0 / config->fps;
    
    // Calculate how much audio time each MP2 packet represents
    // MP2 frame contains 1152 samples at 32kHz = 0.036 seconds
    double packet_audio_time = 1152.0 / MP2_SAMPLE_RATE;
    
    // Estimate how many packets we consume per video frame
    double packets_per_frame = frame_audio_time / packet_audio_time;
    
    // Only insert audio when buffer would go below 2 frames
    // Initialise with 2 packets on first frame to prime the buffer
    int packets_to_insert = 0;
    if (frame_num == 1) {
        packets_to_insert = 2;
        config->audio_frames_in_buffer = 2;
    } else {
        // Simulate buffer consumption (packets consumed per frame)
        config->audio_frames_in_buffer -= (int)ceil(packets_per_frame);
        
        // Only insert packets when buffer gets low (≤ 2 frames)
        if (config->audio_frames_in_buffer <= 2) {
            packets_to_insert = config->target_audio_buffer_size - config->audio_frames_in_buffer;
            packets_to_insert = (packets_to_insert > 0) ? packets_to_insert : 1;
        }
    }
    
    // Insert the calculated number of audio packets
    for (int q = 0; q < packets_to_insert; q++) {
        size_t bytes_to_read = config->mp2_packet_size;
        if (bytes_to_read > config->audio_remaining) {
            bytes_to_read = config->audio_remaining;
        }
        
        size_t bytes_read = fread(config->mp2_buffer, 1, bytes_to_read, config->mp2_file);
        if (bytes_read == 0) break;
        
        uint8_t audio_packet_type[2] = {config->mp2_rate_index, MP2_PACKET_TYPE_BASE};
        fwrite(audio_packet_type, 1, 2, output);
        fwrite(config->mp2_buffer, 1, bytes_read, output);
        
        // Track audio bytes written
        config->total_output_bytes += 2 + bytes_read;
        config->audio_remaining -= bytes_read;
        config->audio_frames_in_buffer++;
    }
    
    return 1;
}

// Write TVDOS header
static void write_tvdos_header(encoder_config_t *config, FILE *output) {
    fwrite(TVDOS_MAGIC, 1, 8, output);
    fwrite(&config->width, 2, 1, output);
    fwrite(&config->height, 2, 1, output);
    fwrite(&config->fps, 2, 1, output);
    fwrite(&config->total_frames, 4, 1, output);
    
    uint16_t unused = 0x00FF;
    fwrite(&unused, 2, 1, output);
    
    int audio_sample_size = 2 * (((MP2_SAMPLE_RATE / config->fps) + 1));
    int audio_queue_size = config->has_audio ? 
        (int)ceil(audio_sample_size / 2304.0) + 1 : 0;
        
    uint16_t audio_queue_info = config->has_audio ? 
        (MP2_DEFAULT_PACKET_SIZE >> 2) | (audio_queue_size << 12) : 0x0000;
    fwrite(&audio_queue_info, 2, 1, output);
    
    // Store target buffer size for audio timing
    config->target_audio_buffer_size = audio_queue_size;
    
    uint8_t reserved[10] = {0};
    fwrite(reserved, 1, 10, output);
}

// Initialise encoder configuration
static encoder_config_t *init_encoder_config() {
    encoder_config_t *config = calloc(1, sizeof(encoder_config_t));
    if (!config) return NULL;
    
    config->width = DEFAULT_WIDTH;
    config->height = DEFAULT_HEIGHT;
    
    return config;
}

// Allocate encoder buffers
static int allocate_buffers(encoder_config_t *config) {
    config->frame_buffer_size = ((config->width + 3) / 4) * ((config->height + 3) / 4) * IPF_BLOCK_SIZE;
    
    config->rgb_buffer = malloc(config->width * config->height * 3);
    config->previous_ipf_frame = malloc(config->frame_buffer_size);
    config->current_ipf_frame = malloc(config->frame_buffer_size);
    config->delta_buffer = malloc(config->frame_buffer_size * 2);
    config->compressed_buffer = malloc(config->frame_buffer_size * 2);
    config->mp2_buffer = malloc(2048);
    
    return (config->rgb_buffer && config->previous_ipf_frame && 
            config->current_ipf_frame && config->delta_buffer && 
            config->compressed_buffer && config->mp2_buffer);
}

// Process one frame - CORRECTED ORDER: Audio -> Video -> Sync
static int process_frame(encoder_config_t *config, int frame_num, int is_keyframe, FILE *output) {
    // Read RGB data from FFmpeg pipe first
    size_t rgb_size = config->width * config->height * 3;
    if (fread(config->rgb_buffer, 1, rgb_size, config->ffmpeg_video_pipe) != rgb_size) {
        if (feof(config->ffmpeg_video_pipe)) return 0;
        return -1;
    }
    
    // Step 1: Process audio FIRST (matches working file pattern)
    if (!process_audio(config, frame_num, output)) {
        return -1;
    }
    
    // Step 2: Encode and write video
    int pattern;
    switch (config->dither_mode) {
        case 0: pattern = -1; break;  // No dithering
        case 1: pattern = 0; break;   // Static pattern
        case 2: pattern = frame_num % 4; break;  // Dynamic pattern
        default: pattern = 0; break;  // Fallback to static
    }
    encode_ipf1_frame(config->rgb_buffer, config->width, config->height, 3, pattern,
                     config->current_ipf_frame);
    
    // Determine if we should use delta encoding
    int use_delta = 0;
    size_t data_size = config->frame_buffer_size;
    uint8_t *frame_data = config->current_ipf_frame;
    
    if (frame_num > 1 && !is_keyframe) {
        size_t delta_size = encode_ipf1_delta(config->previous_ipf_frame, 
                                            config->current_ipf_frame,
                                            config->width, config->height,
                                            config->delta_buffer);
        
        if (delta_size < config->frame_buffer_size * 0.576) {
            use_delta = 1;
            data_size = delta_size;
            frame_data = config->delta_buffer;
        }
    }
    
    // Compress the frame data using gzip
    size_t compressed_size = gzip_compress(frame_data, data_size, 
                                          config->compressed_buffer, 
                                          config->frame_buffer_size * 2);
    if (compressed_size == 0) {
        fprintf(stderr, "Gzip compression failed\n");
        return -1;
    }
    
    // Write video packet
    if (use_delta) {
        uint8_t packet_type[2] = {IPF1_DELTA_PACKET_TYPE};
        fwrite(packet_type, 1, 2, output);
    } else {
        uint8_t packet_type[2] = {IPF1_PACKET_TYPE};
        fwrite(packet_type, 1, 2, output);
    }
    
    uint32_t size_le = compressed_size;
    fwrite(&size_le, 4, 1, output);
    fwrite(config->compressed_buffer, 1, compressed_size, output);
    
    // Step 3: Write sync packet AFTER video (matches working file pattern)
    uint8_t sync[2] = {SYNC_PACKET_TYPE};
    fwrite(sync, 1, 2, output);
    
    // Track video bytes written (packet type + size + compressed data + sync)
    config->total_output_bytes += 2 + 4 + compressed_size + 2;
    
    // Swap frame buffers
    uint8_t *temp = config->previous_ipf_frame;
    config->previous_ipf_frame = config->current_ipf_frame;
    config->current_ipf_frame = temp;
    
    // Display progress
    display_progress(config, frame_num);
    
    return 1;
}

// Cleanup function
static void cleanup_config(encoder_config_t *config) {
    if (!config) return;
    
    if (config->ffmpeg_video_pipe) pclose(config->ffmpeg_video_pipe);
    if (config->mp2_file) fclose(config->mp2_file);
    
    free(config->input_file);
    free(config->output_file);
    free(config->rgb_buffer);
    free(config->previous_ipf_frame);
    free(config->current_ipf_frame);
    free(config->delta_buffer);
    free(config->compressed_buffer);
    free(config->mp2_buffer);
    
    // Remove temporary audio file
    unlink(TEMP_AUDIO_FILE);
    
    free(config);
}

// Print usage information
static void print_usage(const char *program_name) {
    printf("TVDOS Movie Encoder\n\n");
    printf("Usage: %s [options] input_video\n\n", program_name);
    printf("Options:\n");
    printf("  -o, --output FILE    Output TVDOS movie file (default: stdout)\n");
    printf("  -s, --size WxH       Video resolution (default: 560x448)\n");
    printf("  -d, --dither MODE    Dithering mode (default: 1)\n");
    printf("                         0: No dithering\n");
    printf("                         1: Static pattern\n");
    printf("                         2: Dynamic pattern (better quality, larger files)\n");
    printf("  -h, --help           Show this help message\n\n");
    printf("Examples:\n");
    printf("  %s input.mp4 -o output.mov\n", program_name);
    printf("  %s input.avi -s 1024x768 -o output.mov\n", program_name);
    printf("  yt-dlp -o - \"https://youtube.com/watch?v=VIDEO_ID\" | ffmpeg -i pipe:0 -c copy temp.mp4 && %s temp.mp4 -o youtube_video.mov && rm temp.mp4\n", program_name);
}

int main(int argc, char *argv[]) {
    encoder_config_t *config = init_encoder_config();
    if (!config) {
        fprintf(stderr, "Failed to initialise encoder\n");
        return 1;
    }
    
    config->output_to_stdout = 1; // Default to stdout
    config->dither_mode = 1; // Default to static dithering
    
    // Parse command line arguments
    static struct option long_options[] = {
        {"output", required_argument, 0, 'o'},
        {"size", required_argument, 0, 's'},
        {"dither", required_argument, 0, 'd'},
        {"help", no_argument, 0, 'h'},
        {0, 0, 0, 0}
    };
    
    int c;
    while ((c = getopt_long(argc, argv, "o:s:d:h", long_options, NULL)) != -1) {
        switch (c) {
            case 'o':
                config->output_file = strdup(optarg);
                config->output_to_stdout = 0;
                break;
            case 's':
                if (!parse_resolution(optarg, &config->width, &config->height)) {
                    fprintf(stderr, "Invalid resolution format: %s\n", optarg);
                    cleanup_config(config);
                    return 1;
                }
                break;
            case 'd':
                config->dither_mode = atoi(optarg);
                if (config->dither_mode < 0 || config->dither_mode > 2) {
                    fprintf(stderr, "Invalid dither mode: %s (must be 0, 1, or 2)\n", optarg);
                    cleanup_config(config);
                    return 1;
                }
                break;
            case 'h':
                print_usage(argv[0]);
                cleanup_config(config);
                return 0;
            default:
                print_usage(argv[0]);
                cleanup_config(config);
                return 1;
        }
    }
    
    if (optind >= argc) {
        fprintf(stderr, "Error: Input video file required\n\n");
        print_usage(argv[0]);
        cleanup_config(config);
        return 1;
    }
    
    config->input_file = strdup(argv[optind]);
    
    // Get video metadata
    if (!get_video_metadata(config)) {
        fprintf(stderr, "Failed to analyze video metadata\n");
        cleanup_config(config);
        return 1;
    }
    
    // Allocate buffers
    if (!allocate_buffers(config)) {
        fprintf(stderr, "Failed to allocate memory buffers\n");
        cleanup_config(config);
        return 1;
    }
    
    // Start video conversion
    if (!start_video_conversion(config)) {
        fprintf(stderr, "Failed to start video conversion\n");
        cleanup_config(config);
        return 1;
    }
    
    // Start audio conversion
    if (!start_audio_conversion(config)) {
        fprintf(stderr, "Failed to start audio conversion\n");
        cleanup_config(config);
        return 1;
    }
    
    // Open output
    FILE *output = config->output_to_stdout ? stdout : fopen(config->output_file, "wb");
    if (!output) {
        fprintf(stderr, "Failed to open output file\n");
        cleanup_config(config);
        return 1;
    }
    
    // Write TVDOS header
    write_tvdos_header(config, output);
    
    // Initialise progress tracking
    gettimeofday(&config->start_time, NULL);
    config->last_progress_time = config->start_time;
    config->total_output_bytes = 8 + 2 + 2 + 2 + 4 + 2 + 2 + 10; // TVDOS header size
    
    // Process frames with correct order: Audio -> Video -> Sync
    for (int frame = 1; frame <= config->total_frames; frame++) {
        int is_keyframe = (frame == 1) || (frame % 30 == 0);
        
        int result = process_frame(config, frame, is_keyframe, output);
        if (result <= 0) {
            if (result == 0) {
                fprintf(stderr, "End of video at frame %d\n", frame);
            }
            break;
        }
    }
    
    // Final progress update and newline
    fprintf(stderr, "\n");
    
    if (!config->output_to_stdout) {
        fclose(output);
        fprintf(stderr, "Encoding complete: %s\n", config->output_file);
    }
    
    cleanup_config(config);
    return 0;
}
