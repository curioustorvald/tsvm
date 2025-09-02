// Created by Claude on 2025-08-18.
// TEV (TSVM Enhanced Video) Encoder - YCoCg-R 4:2:0 16x16 Block Version
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include <unistd.h>
#include <sys/wait.h>
#include <getopt.h>
#include <ctype.h>
#include <sys/time.h>
#include <time.h>

// TSVM Enhanced Video (TEV) format constants
#define TEV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x45\x56"  // "\x1FTSVM TEV"
#define TEV_VERSION 2  // Updated for YCoCg-R 4:2:0
// version 1: 8x8 RGB
// version 2: 16x16 Y, 8x8 Co/Cg, asymetric quantisation, optional quantiser multiplier for rate control multiplier (1.0 when unused) {current winner}
// version 3: version 2 + internal 6-bit processing (discarded due to higher noise floor)

// Block encoding modes (16x16 blocks)
#define TEV_MODE_SKIP      0x00  // Skip block (copy from reference)
#define TEV_MODE_INTRA     0x01  // Intra DCT coding (I-frame blocks)
#define TEV_MODE_INTER     0x02  // Inter DCT coding with motion compensation
#define TEV_MODE_MOTION    0x03  // Motion vector only (good prediction)

// Video packet types
#define TEV_PACKET_IFRAME      0x10  // Intra frame (keyframe)
#define TEV_PACKET_PFRAME      0x11  // Predicted frame  
#define TEV_PACKET_AUDIO_MP2   0x20  // MP2 audio
#define TEV_PACKET_SUBTITLE    0x30  // Subtitle packet
#define TEV_PACKET_SYNC        0xFF  // Sync packet

// Utility macros
static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}
static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}
// Which preset should I be using?
// from dataset of three videos with Q0..Q95: (real life video, low res pixel art, high res pixel art)
// 56  96 128 192 256  Claude Opus 4.1 (with data analysis)
// 64  96 128 192 256  ChatGPT-5 (without data analysis)
static const int MP2_RATE_TABLE[] = {128, 160, 224, 320, 384};
// Which preset should I be using?
// from dataset of three videos with Q0..Q95: (real life video, low res pixel art, high res pixel art)
//  5  25  50  75  90  Claude Opus 4.1 (with data analysis)
// 10  25  45  65  85  ChatGPT-5 (without data analysis)
// 10  30  50  70  90  ChatGPT-5 (with data analysis)
static const int QUALITY_Y[] =  {5, 18, 42, 63, 80};
static const int QUALITY_CO[] = {5, 18, 42, 63, 80};

// Encoding parameters
#define MAX_MOTION_SEARCH 16
int KEYFRAME_INTERVAL = 60;
#define BLOCK_SIZE 16  // 16x16 blocks now
#define BLOCK_SIZE_SQR 256
#define BLOCK_SIZE_SQRF 256.f
#define HALF_BLOCK_SIZE 8
#define HALF_BLOCK_SIZE_SQR 64

#define ZSTD_COMPRESSON_LEVEL 15

static float jpeg_quality_to_mult(int q) {
    return ((q < 50) ? 5000.f / q : 200.f - 2*q) / 100.f;
}

// Quality settings for quantisation (Y channel) - 16x16 tables
static const uint32_t QUANT_TABLE_Y[BLOCK_SIZE_SQR] =
    // Quality 50
    {16, 14, 12, 11, 11, 13, 16, 20, 24, 30, 39, 48, 54, 61, 67, 73,
     14, 13, 12, 12, 12, 15, 18, 21, 25, 33, 46, 57, 61, 65, 67, 70,
     13, 12, 12, 13, 14, 17, 19, 23, 27, 36, 53, 66, 68, 69, 68, 67,
     13, 13, 13, 14, 15, 18, 22, 26, 32, 41, 56, 67, 71, 74, 70, 67,
     14, 14, 14, 15, 17, 20, 24, 30, 38, 47, 58, 68, 74, 79, 73, 67,
     15, 15, 15, 17, 19, 22, 27, 34, 44, 55, 68, 79, 83, 85, 78, 70,
     15, 16, 17, 20, 22, 26, 30, 38, 49, 63, 81, 94, 93, 91, 83, 74,
     16, 18, 20, 24, 28, 33, 38, 47, 57, 73, 93, 108, 105, 101, 91, 81,
     19, 21, 23, 29, 35, 43, 52, 60, 68, 83, 105, 121, 118, 115, 102, 89,
     21, 24, 27, 35, 43, 53, 62, 70, 78, 91, 113, 128, 127, 125, 112, 99,
     25, 30, 34, 43, 53, 61, 68, 76, 85, 97, 114, 127, 130, 132, 120, 108,
     31, 38, 44, 54, 64, 71, 76, 84, 94, 105, 118, 129, 135, 138, 127, 116,
     45, 52, 60, 69, 78, 84, 90, 97, 107, 118, 130, 139, 142, 143, 133, 122,
     59, 68, 76, 84, 91, 97, 102, 110, 120, 129, 139, 147, 147, 146, 137, 127,
     73, 82, 92, 98, 103, 107, 110, 117, 126, 132, 134, 136, 138, 138, 133, 127,
     86, 98, 109, 112, 114, 116, 118, 124, 133, 135, 129, 125, 128, 130, 128, 127};

// Quality settings for quantisation (X channel - 8x8)
static const uint32_t QUANT_TABLE_C[HALF_BLOCK_SIZE_SQR] =
    {17, 18, 24, 47, 99, 99, 99, 99,
     18, 21, 26, 66, 99, 99, 99, 99,
     24, 26, 56, 99, 99, 99, 99, 99,
     47, 66, 99, 99, 99, 99, 99, 99,
     99, 99, 99, 99, 99, 99, 99, 99,
     99, 99, 99, 99, 99, 99, 99, 99,
     99, 99, 99, 99, 99, 99, 99, 99,
     99, 99, 99, 99, 99, 99, 99, 99};


// Audio constants (reuse MP2 from existing system)
#define MP2_SAMPLE_RATE 32000
#define MP2_DEFAULT_PACKET_SIZE 0x240

// Default values
#define DEFAULT_WIDTH 560
#define DEFAULT_HEIGHT 448

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

char TEMP_AUDIO_FILE[42];// "/tmp/tev_temp_audio.mp2"

typedef struct __attribute__((packed)) {
    uint8_t mode;           // Block encoding mode
    int16_t mv_x, mv_y;     // Motion vector (1/4 pixel precision)
    float rate_control_factor; // Rate control factor (4 bytes, little-endian)
    uint16_t cbp;           // Coded block pattern (which channels have non-zero coeffs)
    int16_t y_coeffs[BLOCK_SIZE_SQR];  // quantised Y DCT coefficients (16x16)
    int16_t co_coeffs[HALF_BLOCK_SIZE_SQR];  // quantised Co DCT coefficients (8x8)
    int16_t cg_coeffs[HALF_BLOCK_SIZE_SQR];  // quantised Cg DCT coefficients (8x8)
} tev_block_t;

// Subtitle entry structure
typedef struct subtitle_entry {
    int start_frame;
    int end_frame;
    char *text;
    struct subtitle_entry *next;
} subtitle_entry_t;

typedef struct {
    char *input_file;
    char *output_file;
    char *subtitle_file;  // SubRip (.srt) file path
    int width;
    int height;
    int fps;
    int output_fps;  // User-specified output FPS (for frame rate conversion)
    int total_frames;
    double duration;
    int has_audio;
    int has_subtitles;
    int output_to_stdout;
    int progressive_mode;  // 0 = interlaced (default), 1 = progressive
    int qualityIndex; // -q option
    int qualityY;
    int qualityCo;
    int qualityCg;
    int verbose;

    // Bitrate control
    int target_bitrate_kbps;  // Target bitrate in kbps (0 = quality mode)
    int bitrate_mode;         // 0 = quality, 1 = bitrate, 2 = hybrid
    float rate_control_factor; // Dynamic adjustment factor

    // Frame buffers (8-bit RGB format for encoding)
    uint8_t *current_rgb, *previous_rgb, *reference_rgb;
    uint8_t *previous_even_field;  // Previous even field buffer for interlaced scene change detection

    // YCoCg workspace
    float *y_workspace, *co_workspace, *cg_workspace;
    float *dct_workspace;       // DCT coefficients
    tev_block_t *block_data;    // Encoded block data
    uint8_t *compressed_buffer; // Zstd output

    // Audio handling
    FILE *mp2_file;
    int mp2_packet_size;
    int mp2_rate_index;
    size_t audio_remaining;
    uint8_t *mp2_buffer;
    double audio_frames_in_buffer;
    int target_audio_buffer_size;

    // Compression context
    ZSTD_CCtx *zstd_context;

    // FFmpeg processes
    FILE *ffmpeg_video_pipe;

    // Progress tracking
    struct timeval start_time;
    size_t total_output_bytes;

    // Statistics
    int blocks_skip, blocks_intra, blocks_inter, blocks_motion;

    // Rate control statistics
    size_t frame_bits_accumulator;
    size_t target_bits_per_frame;
    float complexity_history[60];  // Rolling window for complexity
    int complexity_history_index;
    float average_complexity;

    // Subtitle handling
    subtitle_entry_t *subtitle_list;
    subtitle_entry_t *current_subtitle;
} tev_encoder_t;

// RGB to YCoCg-R transform (per YCoCg-R specification with truncated division)
static void rgb_to_ycocgr(uint8_t r, uint8_t g, uint8_t b, int *y, int *co, int *cg) {
    *co = (int)r - (int)b;
    int tmp = (int)b + ((*co) / 2);
    *cg = (int)g - tmp;
    *y = tmp + ((*cg) / 2);

    // Clamp to valid ranges (YCoCg-R should be roughly -256 to +255)
    *y = CLAMP(*y, 0, 255);
    *co = CLAMP(*co, -256, 255);
    *cg = CLAMP(*cg, -256, 255);
}

// YCoCg-R to RGB transform (for verification - per YCoCg-R specification)
static void ycocgr_to_rgb(int y, int co, int cg, uint8_t *r, uint8_t *g, uint8_t *b) {
    int tmp = y - (cg / 2);
    *g = cg + tmp;
    *b = tmp - (co / 2);
    *r = *b + co;

    // Clamp values
    *r = CLAMP(*r, 0, 255);
    *g = CLAMP(*g, 0, 255);
    *b = CLAMP(*b, 0, 255);
}

// Pre-calculated cosine tables
static float dct_table_16[16][16]; // For 16x16 DCT
static float dct_table_8[8][8];    // For 8x8 DCT
static int tables_initialized = 0;

// Initialize the pre-calculated tables
static void init_dct_tables(void) {
    if (tables_initialized) return;

    // Pre-calculate cosine values for 16x16 DCT
    for (int u = 0; u < 16; u++) {
        for (int x = 0; x < 16; x++) {
            dct_table_16[u][x] = cosf((2.0f * x + 1.0f) * u * M_PI / 32.0f);
        }
    }

    // Pre-calculate cosine values for 8x8 DCT
    for (int u = 0; u < 8; u++) {
        for (int x = 0; x < 8; x++) {
            dct_table_8[u][x] = cosf((2.0f * x + 1.0f) * u * M_PI / 16.0f);
        }
    }

    tables_initialized = 1;
}

// 16x16 2D DCT
// Fast separable 16x16 DCT - 8x performance improvement
static float temp_dct_16[BLOCK_SIZE_SQR]; // Reusable temporary buffer

static void dct_16x16_fast(float *input, float *output) {
    init_dct_tables(); // Ensure tables are initialized

    // First pass: Process rows (16 1D DCTs)
    for (int row = 0; row < 16; row++) {
        for (int u = 0; u < 16; u++) {
            float sum = 0.0f;
            float cu = (u == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;

            for (int x = 0; x < 16; x++) {
                sum += input[row * 16 + x] * dct_table_16[u][x];
            }

            temp_dct_16[row * 16 + u] = 0.5f * cu * sum;
        }
    }

    // Second pass: Process columns (16 1D DCTs)
    for (int col = 0; col < 16; col++) {
        for (int v = 0; v < 16; v++) {
            float sum = 0.0f;
            float cv = (v == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;

            for (int y = 0; y < 16; y++) {
                sum += temp_dct_16[y * 16 + col] * dct_table_16[v][y];
            }

            output[v * 16 + col] = 0.5f * cv * sum;
        }
    }
}

// Fast separable 8x8 DCT - 4x performance improvement
static float temp_dct_8[HALF_BLOCK_SIZE_SQR]; // Reusable temporary buffer

static void dct_8x8_fast(float *input, float *output) {
    init_dct_tables(); // Ensure tables are initialized

    // First pass: Process rows (8 1D DCTs)
    for (int row = 0; row < 8; row++) {
        for (int u = 0; u < 8; u++) {
            float sum = 0.0f;
            float cu = (u == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;

            for (int x = 0; x < 8; x++) {
                sum += input[row * 8 + x] * dct_table_8[u][x];
            }

            temp_dct_8[row * 8 + u] = 0.5f * cu * sum;
        }
    }

    // Second pass: Process columns (8 1D DCTs)
    for (int col = 0; col < 8; col++) {
        for (int v = 0; v < 8; v++) {
            float sum = 0.0f;
            float cv = (v == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;

            for (int y = 0; y < 8; y++) {
                sum += temp_dct_8[y * 8 + col] * dct_table_8[v][y];
            }

            output[v * 8 + col] = 0.5f * cv * sum;
        }
    }
}

// quantise DCT coefficient using quality table with rate control
static int16_t quantise_coeff(float coeff, float quant, int is_dc, int is_chroma) {
    if (is_dc) {
        if (is_chroma) {
            // Chroma DC: range -256 to +255, use lossless quantisation for testing
            return (int16_t)roundf(coeff);
        } else {
            // Luma DC: range -128 to +127, use lossless quantisation for testing
            return (int16_t)roundf(coeff);
        }
    } else {
        // AC coefficients use quality table (rate control factor applied to quant table before calling)
        float safe_quant = fmaxf(quant, 1.0f); // Prevent division by zero
        return (int16_t)roundf(coeff / safe_quant);
    }
}

// Extract 16x16 block from RGB frame and convert to YCoCg-R
static void extract_ycocgr_block(uint8_t *rgb_frame, int width, int height,
                                int block_x, int block_y,
                                float *y_block, float *co_block, float *cg_block) {
    int start_x = block_x * BLOCK_SIZE;
    int start_y = block_y * BLOCK_SIZE;

    // Extract 16x16 Y block
    for (int py = 0; py < BLOCK_SIZE; py++) {
        for (int px = 0; px < BLOCK_SIZE; px++) {
            int x = start_x + px;
            int y = start_y + py;

            if (x < width && y < height) {
                int offset = (y * width + x) * 3;
                uint8_t r = rgb_frame[offset];
                uint8_t g = rgb_frame[offset + 1];
                uint8_t b = rgb_frame[offset + 2];

                int y_val, co_val, cg_val;
                rgb_to_ycocgr(r, g, b, &y_val, &co_val, &cg_val);

                y_block[py * BLOCK_SIZE + px] = (float)y_val - 128.0f;  // Center around 0
            }
        }
    }

    // Extract 8x8 chroma blocks with 4:2:0 subsampling (average 2x2 pixels)
    for (int py = 0; py < HALF_BLOCK_SIZE; py++) {
        for (int px = 0; px < HALF_BLOCK_SIZE; px++) {
            int co_sum = 0, cg_sum = 0, count = 0;

            // Average 2x2 block of pixels
            for (int dy = 0; dy < 2; dy++) {
                for (int dx = 0; dx < 2; dx++) {
                    int x = start_x + px * 2 + dx;
                    int y = start_y + py * 2 + dy;

                    if (x < width && y < height) {
                        int offset = (y * width + x) * 3;
                        uint8_t r = rgb_frame[offset];
                        uint8_t g = rgb_frame[offset + 1];
                        uint8_t b = rgb_frame[offset + 2];

                        int y_val, co_val, cg_val;
                        rgb_to_ycocgr(r, g, b, &y_val, &co_val, &cg_val);

                        co_sum += co_val;
                        cg_sum += cg_val;
                        count++;
                    }
                }
            }

            if (count > 0) {
                // Center chroma around 0 for DCT (Co/Cg range is -255 to +255, so don't add offset)
                co_block[py * HALF_BLOCK_SIZE + px] = (float)(co_sum / count);
                cg_block[py * HALF_BLOCK_SIZE + px] = (float)(cg_sum / count);
            }
        }
    }
}

// Calculate block complexity based on spatial activity
static float calculate_block_complexity(const float *y_block) {
    float complexity = 0.0f;
    
    // Method 1: Sum of absolute differences with neighbors (spatial activity)
    for (int y = 0; y < BLOCK_SIZE; y++) {
        for (int x = 0; x < BLOCK_SIZE; x++) {
            float pixel = y_block[y * BLOCK_SIZE + x];
            
            // Compare with right neighbor
            if (x < BLOCK_SIZE - 1) {
                complexity += fabsf(pixel - y_block[y * BLOCK_SIZE + (x + 1)]);
            }
            
            // Compare with bottom neighbor
            if (y < BLOCK_SIZE - 1) {
                complexity += fabsf(pixel - y_block[(y + 1) * BLOCK_SIZE + x]);
            }
        }
    }
    
    // Method 2: Add variance contribution
    float mean = 0.0f;
    for (int i = 0; i < BLOCK_SIZE_SQR; i++) {
        mean += y_block[i];
    }
    mean /= BLOCK_SIZE_SQRF;
    
    float variance = 0.0f;
    for (int i = 0; i < BLOCK_SIZE_SQR; i++) {
        float diff = y_block[i] - mean;
        variance += diff * diff;
    }
    variance /= BLOCK_SIZE_SQRF;
    
    // Combine spatial activity and variance
    return complexity + sqrtf(variance) * 10.0f;
}

// Map complexity to rate control factor (pure per-block, no global factor)
static float complexity_to_rate_factor(float complexity) {
    const float P = 10.f;
    const float e = -0.5f;
    float factor = P * powf(FCLAMP(complexity, 1.f, 16777216.f), e);
    return FCLAMP(factor, 1.f / 2.f, 2.f); // the "auto quality" thing can be excessively permissive
}

// Simple motion estimation (full search) for 16x16 blocks
static void estimate_motion(tev_encoder_t *enc, int block_x, int block_y,
                           int16_t *best_mv_x, int16_t *best_mv_y) {
    int best_sad = INT_MAX;
    *best_mv_x = 0;
    *best_mv_y = 0;

    int start_x = block_x * BLOCK_SIZE;
    int start_y = block_y * BLOCK_SIZE;

    // Diamond search pattern (much faster than full search)
    static const int diamond_x[] = {0, -1, 1, 0, 0, -2, 2, 0, 0};
    static const int diamond_y[] = {0, 0, 0, -1, 1, 0, 0, -2, 2};

    int center_x = 0, center_y = 0;
    int step_size = 4;  // Start with larger steps

    while (step_size >= 1) {
        int improved = 0;

        for (int i = 0; i < 9; i++) {
            int mv_x = center_x + diamond_x[i] * step_size;
            int mv_y = center_y + diamond_y[i] * step_size;

            // Check bounds
            if (mv_x < -MAX_MOTION_SEARCH || mv_x > MAX_MOTION_SEARCH ||
                mv_y < -MAX_MOTION_SEARCH || mv_y > MAX_MOTION_SEARCH) {
                continue;
            }

            int ref_x = start_x - mv_x;
            int ref_y = start_y - mv_y;

            if (ref_x < 0 || ref_y < 0 ||
                ref_x + BLOCK_SIZE > enc->width || ref_y + BLOCK_SIZE > enc->height) {
                continue;
            }

            // Fast SAD using integer luma approximation
            int sad = 0;
            for (int dy = 0; dy < BLOCK_SIZE; dy += 2) {  // Sample every 2nd row for speed
                uint8_t *cur_row = &enc->current_rgb[((start_y + dy) * enc->width + start_x) * 3];
                uint8_t *ref_row = &enc->previous_rgb[((ref_y + dy) * enc->width + ref_x) * 3];

                for (int dx = 0; dx < BLOCK_SIZE; dx += 2) {  // Sample every 2nd pixel
                    // Fast luma approximation: (R + 2*G + B) >> 2
                    int cur_luma = (cur_row[dx*3] + (cur_row[dx*3+1] << 1) + cur_row[dx*3+2]) >> 2;
                    int ref_luma = (ref_row[dx*3] + (ref_row[dx*3+1] << 1) + ref_row[dx*3+2]) >> 2;
                    sad += abs(cur_luma - ref_luma);
                }
            }

            if (sad < best_sad) {
                best_sad = sad;
                *best_mv_x = mv_x;
                *best_mv_y = mv_y;
                center_x = mv_x;
                center_y = mv_y;
                improved = 1;
            }
        }

        if (!improved) {
            step_size >>= 1;  // Reduce step size
        }
    }
}

// Convert RGB block to YCoCg-R with 4:2:0 chroma subsampling
static void convert_rgb_to_ycocgr_block(const uint8_t *rgb_block,
                                       uint8_t *y_block, int8_t *co_block, int8_t *cg_block) {
    // Convert 16x16 RGB to Y (full resolution)
    for (int py = 0; py < BLOCK_SIZE; py++) {
        for (int px = 0; px < BLOCK_SIZE; px++) {
            int rgb_idx = (py * BLOCK_SIZE + px) * 3;
            int r = rgb_block[rgb_idx];
            int g = rgb_block[rgb_idx + 1];
            int b = rgb_block[rgb_idx + 2];

            // YCoCg-R transform (per specification with truncated division)
            int y = (r + 2*g + b) / 4;

            y_block[py * 16 + px] = CLAMP(y, 0, 255);
        }
    }

    // Convert to Co and Cg with 4:2:0 subsampling (8x8)
    for (int cy = 0; cy < HALF_BLOCK_SIZE; cy++) {
        for (int cx = 0; cx < HALF_BLOCK_SIZE; cx++) {
            // Sample 2x2 block from RGB and average for chroma
            int sum_co = 0, sum_cg = 0;

            for (int dy = 0; dy < 2; dy++) {
                for (int dx = 0; dx < 2; dx++) {
                    int py = cy * 2 + dy;
                    int px = cx * 2 + dx;
                    int rgb_idx = (py * 16 + px) * 3;

                    int r = rgb_block[rgb_idx];
                    int g = rgb_block[rgb_idx + 1];
                    int b = rgb_block[rgb_idx + 2];

                    int co = r - b;
                    int tmp = b + (co / 2);
                    int cg = g - tmp;

                    sum_co += co;
                    sum_cg += cg;
                }
            }

            // Average and store subsampled chroma
            co_block[cy * HALF_BLOCK_SIZE + cx] = CLAMP(sum_co / 4, -256, 255);
            cg_block[cy * HALF_BLOCK_SIZE + cx] = CLAMP(sum_cg / 4, -256, 255);
        }
    }
}

// Extract motion-compensated YCoCg-R block from reference frame
static void extract_motion_compensated_block(const uint8_t *rgb_data, int width, int height,
                                           int block_x, int block_y, int mv_x, int mv_y,
                                           uint8_t *y_block, int8_t *co_block, int8_t *cg_block) {
    // Extract 16x16 RGB block with motion compensation
    uint8_t rgb_block[BLOCK_SIZE * BLOCK_SIZE * 3];

    for (int dy = 0; dy < BLOCK_SIZE; dy++) {
        for (int dx = 0; dx < BLOCK_SIZE; dx++) {
            int cur_x = block_x + dx;
            int cur_y = block_y + dy;
            int ref_x = cur_x + mv_x;  // Revert to original motion compensation
            int ref_y = cur_y + mv_y;

            int rgb_idx = (dy * BLOCK_SIZE + dx) * 3;

            if (ref_x >= 0 && ref_y >= 0 && ref_x < width && ref_y < height) {
                // Copy RGB from reference position
                int ref_offset = (ref_y * width + ref_x) * 3;
                rgb_block[rgb_idx] = rgb_data[ref_offset];         // R
                rgb_block[rgb_idx + 1] = rgb_data[ref_offset + 1]; // G
                rgb_block[rgb_idx + 2] = rgb_data[ref_offset + 2]; // B
            } else {
                // Out of bounds - use black
                rgb_block[rgb_idx] = 0;     // R
                rgb_block[rgb_idx + 1] = 0; // G
                rgb_block[rgb_idx + 2] = 0; // B
            }
        }
    }

    // Convert RGB block to YCoCg-R
    convert_rgb_to_ycocgr_block(rgb_block, y_block, co_block, cg_block);
}

// Compute motion-compensated residual for INTER mode
static void compute_motion_residual(tev_encoder_t *enc, int block_x, int block_y, int mv_x, int mv_y) {
    int start_x = block_x * BLOCK_SIZE;
    int start_y = block_y * BLOCK_SIZE;

    // Extract motion-compensated reference block from previous frame
    uint8_t ref_y[BLOCK_SIZE_SQR];
    int8_t ref_co[HALF_BLOCK_SIZE_SQR], ref_cg[HALF_BLOCK_SIZE_SQR];
    extract_motion_compensated_block(enc->previous_rgb, enc->width, enc->height,
                                   start_x, start_y, mv_x, mv_y,
                                   ref_y, ref_co, ref_cg);

    // Compute residuals: current - motion_compensated_reference
    // Current is already centered (-128 to +127), reference is 0-255, so subtract and center reference
    for (int i = 0; i < BLOCK_SIZE_SQR; i++) {
        float ref_y_centered = (float)ref_y[i] - 128.0f;  // Center reference to match current
        enc->y_workspace[i] = enc->y_workspace[i] - ref_y_centered;
    }

    // Chroma residuals (already centered in both current and reference)
    for (int i = 0; i < HALF_BLOCK_SIZE_SQR; i++) {
        enc->co_workspace[i] = enc->co_workspace[i] - (float)ref_co[i];
        enc->cg_workspace[i] = enc->cg_workspace[i] - (float)ref_cg[i];
    }
}

// Calculate block complexity for rate control


// Encode a 16x16 block
static void encode_block(tev_encoder_t *enc, int block_x, int block_y, int is_keyframe) {
    tev_block_t *block = &enc->block_data[block_y * ((enc->width + 15) / 16) + block_x];

    // Extract YCoCg-R block
    extract_ycocgr_block(enc->current_rgb, enc->width, enc->height,
                        block_x, block_y,
                        enc->y_workspace, enc->co_workspace, enc->cg_workspace);

    if (is_keyframe) {
        // Intra coding for keyframes
        block->mode = TEV_MODE_INTRA;
        block->mv_x = block->mv_y = 0;
        block->rate_control_factor = enc->rate_control_factor;
        enc->blocks_intra++;
    } else {
        // Implement proper mode decision for P-frames
        int start_x = block_x * BLOCK_SIZE;
        int start_y = block_y * BLOCK_SIZE;

        // Calculate SAD for skip mode (no motion compensation)
        int skip_sad = 0;
        int skip_color_diff = 0;
        for (int dy = 0; dy < BLOCK_SIZE; dy++) {
            for (int dx = 0; dx < BLOCK_SIZE; dx++) {
                int x = start_x + dx;
                int y = start_y + dy;
                if (x < enc->width && y < enc->height) {
                    int cur_offset = (y * enc->width + x) * 3;

                    // Compare current with previous frame (using YCoCg-R Luma calculation)
                    int cur_luma = (enc->current_rgb[cur_offset] +
                                   2 * enc->current_rgb[cur_offset + 1] +
                                   enc->current_rgb[cur_offset + 2]) / 4;
                    int prev_luma = (enc->previous_rgb[cur_offset] +
                                    2 * enc->previous_rgb[cur_offset + 1] +
                                    enc->previous_rgb[cur_offset + 2]) / 4;

                    skip_sad += abs(cur_luma - prev_luma);
                    
                    // Also check for color differences to prevent SKIP on color changes
                    int cur_r = enc->current_rgb[cur_offset];
                    int cur_g = enc->current_rgb[cur_offset + 1];
                    int cur_b = enc->current_rgb[cur_offset + 2];
                    int prev_r = enc->previous_rgb[cur_offset];
                    int prev_g = enc->previous_rgb[cur_offset + 1];
                    int prev_b = enc->previous_rgb[cur_offset + 2];
                    
                    skip_color_diff += abs(cur_r - prev_r) + abs(cur_g - prev_g) + abs(cur_b - prev_b);
                }
            }
        }

        // Try motion estimation
        estimate_motion(enc, block_x, block_y, &block->mv_x, &block->mv_y);

        // Calculate motion compensation SAD
        int motion_sad = INT_MAX;
        if (abs(block->mv_x) > 0 || abs(block->mv_y) > 0) {
            motion_sad = 0;
            for (int dy = 0; dy < BLOCK_SIZE; dy++) {
                for (int dx = 0; dx < BLOCK_SIZE; dx++) {
                    int cur_x = start_x + dx;
                    int cur_y = start_y + dy;
                    int ref_x = cur_x + block->mv_x;
                    int ref_y = cur_y + block->mv_y;

                    if (cur_x < enc->width && cur_y < enc->height &&
                        ref_x >= 0 && ref_y >= 0 &&
                        ref_x < enc->width && ref_y < enc->height) {

                        int cur_offset = (cur_y * enc->width + cur_x) * 3;
                        int ref_offset = (ref_y * enc->width + ref_x) * 3;

                        // use YCoCg-R Luma calculation
                        int cur_luma = (enc->current_rgb[cur_offset] +
                                       2 * enc->current_rgb[cur_offset + 1] +
                                       enc->current_rgb[cur_offset + 2]) / 4;
                        int ref_luma = (enc->previous_rgb[ref_offset] +
                                       2 * enc->previous_rgb[ref_offset + 1] +
                                       enc->previous_rgb[ref_offset + 2]) / 4;

                        motion_sad += abs(cur_luma - ref_luma);
                    } else {
                        motion_sad += 128; // Penalty for out-of-bounds
                    }
                }
            }
        }

        // Mode decision with strict thresholds for quality
        // Require both low luma difference AND low color difference for SKIP
        if (skip_sad <= 64 && skip_color_diff <= 192) {
            // Very small difference - skip block (copy from previous frame)
            block->mode = TEV_MODE_SKIP;
            block->mv_x = 0;
            block->mv_y = 0;
            // Even skip blocks benefit from complexity analysis for consistency
            float block_complexity = calculate_block_complexity(enc->y_workspace);
            block->rate_control_factor = complexity_to_rate_factor(block_complexity);
            block->cbp = 0x00;  // No coefficients present
            // Zero out DCT coefficients for consistent format
            memset(block->y_coeffs, 0, sizeof(block->y_coeffs));
            memset(block->co_coeffs, 0, sizeof(block->co_coeffs));
            memset(block->cg_coeffs, 0, sizeof(block->cg_coeffs));
            enc->blocks_skip++;
            return; // Skip DCT encoding entirely
        } else if (motion_sad < skip_sad && motion_sad <= 1024 &&
                   (abs(block->mv_x) > 0 || abs(block->mv_y) > 0)) {
            // Good motion prediction - use motion-only mode
            block->mode = TEV_MODE_MOTION;
            // Analyze complexity for motion blocks too
            float block_complexity = calculate_block_complexity(enc->y_workspace);
            block->rate_control_factor = complexity_to_rate_factor(block_complexity);
            block->cbp = 0x00;  // No coefficients present
            // Zero out DCT coefficients for consistent format
            memset(block->y_coeffs, 0, sizeof(block->y_coeffs));
            memset(block->co_coeffs, 0, sizeof(block->co_coeffs));
            memset(block->cg_coeffs, 0, sizeof(block->cg_coeffs));
            enc->blocks_motion++;
            return; // Skip DCT encoding, just store motion vector
        // disabling INTER mode: residual DCT is crapping out no matter what I do
        } /*else if (motion_sad < skip_sad && (abs(block->mv_x) > 0 || abs(block->mv_y) > 0)) {
            // Motion compensation with threshold
            if (motion_sad <= 1024) {
                block->mode = TEV_MODE_MOTION;
                block->rate_control_factor = enc->rate_control_factor;
                block->cbp = 0x00;  // No coefficients present
                memset(block->y_coeffs, 0, sizeof(block->y_coeffs));
                memset(block->co_coeffs, 0, sizeof(block->co_coeffs));
                memset(block->cg_coeffs, 0, sizeof(block->cg_coeffs));
                enc->blocks_motion++;
                return; // Skip DCT encoding, just store motion vector
            }

            // Use INTER mode with motion vector and residuals
            if (abs(block->mv_x) < BLOCK_SIZE && abs(block->mv_y) < BLOCK_SIZE) {
                block->mode = TEV_MODE_INTER;
                enc->blocks_inter++;
            } else {
                // Motion vector too large, fall back to INTRA
                block->mode = TEV_MODE_INTRA;
                block->mv_x = 0;
                block->mv_y = 0;
                enc->blocks_intra++;
            }
        }*/ else {
            // No good motion prediction - use intra mode
            block->mode = TEV_MODE_INTRA;
            block->mv_x = 0;
            block->mv_y = 0;
            enc->blocks_intra++;
        }
    }

    // Calculate block complexity BEFORE DCT transform for adaptive rate control
    float block_complexity = calculate_block_complexity(enc->y_workspace);
    block->rate_control_factor = complexity_to_rate_factor(block_complexity);

    // Apply fast DCT transform
    dct_16x16_fast(enc->y_workspace, enc->dct_workspace);

    // quantise Y coefficients (luma) using per-block rate control
    const uint32_t *y_quant = QUANT_TABLE_Y;
    const float qmult_y = jpeg_quality_to_mult(enc->qualityY);
    for (int i = 0; i < BLOCK_SIZE_SQR; i++) {
        // Apply rate control factor to quantization table (like decoder does)
        float effective_quant = y_quant[i] * qmult_y * block->rate_control_factor;
        block->y_coeffs[i] = quantise_coeff(enc->dct_workspace[i], FCLAMP(effective_quant, 1.f, 255.f), i == 0, 0);
    }

    // Apply fast DCT transform to chroma
    dct_8x8_fast(enc->co_workspace, enc->dct_workspace);

    // quantise Co coefficients (chroma - orange-blue) using per-block rate control
    const uint32_t *co_quant = QUANT_TABLE_C;
    const float qmult_co = jpeg_quality_to_mult(enc->qualityCo);
    for (int i = 0; i < HALF_BLOCK_SIZE_SQR; i++) {
        // Apply rate control factor to quantization table (like decoder does)
        float effective_quant = co_quant[i] * qmult_co * block->rate_control_factor;
        block->co_coeffs[i] = quantise_coeff(enc->dct_workspace[i], FCLAMP(effective_quant, 1.f, 255.f), i == 0, 1);
    }

    // Apply fast DCT transform to Cg
    dct_8x8_fast(enc->cg_workspace, enc->dct_workspace);

    // quantise Cg coefficients (chroma - green-magenta, qmult_cg is more aggressive like NTSC Q) using per-block rate control
    const uint32_t *cg_quant = QUANT_TABLE_C;
    const float qmult_cg = jpeg_quality_to_mult(enc->qualityCg);
    for (int i = 0; i < HALF_BLOCK_SIZE_SQR; i++) {
        // Apply rate control factor to quantization table (like decoder does)
        float effective_quant = cg_quant[i] * qmult_cg * block->rate_control_factor;
        block->cg_coeffs[i] = quantise_coeff(enc->dct_workspace[i], FCLAMP(effective_quant, 1.f, 255.f), i == 0, 1);
    }

    // Set CBP (simplified - always encode all channels)
    block->cbp = 0x07;  // Y, Co, Cg all present
}

// Convert SubRip time format (HH:MM:SS,mmm) to frame number
static int srt_time_to_frame(const char *time_str, int fps) {
    int hours, minutes, seconds, milliseconds;
    if (sscanf(time_str, "%d:%d:%d,%d", &hours, &minutes, &seconds, &milliseconds) != 4) {
        return -1;
    }
    
    double total_seconds = hours * 3600.0 + minutes * 60.0 + seconds + milliseconds / 1000.0;
    return (int)(total_seconds * fps + 0.5);  // Round to nearest frame
}

// Convert SAMI milliseconds to frame number
static int sami_ms_to_frame(int milliseconds, int fps) {
    double seconds = milliseconds / 1000.0;
    return (int)(seconds * fps + 0.5);  // Round to nearest frame
}

// Parse SubRip subtitle file
static subtitle_entry_t* parse_srt_file(const char *filename, int fps) {
    FILE *file = fopen(filename, "r");
    if (!file) {
        fprintf(stderr, "Failed to open subtitle file: %s\n", filename);
        return NULL;
    }
    
    subtitle_entry_t *head = NULL;
    subtitle_entry_t *tail = NULL;
    char line[1024];
    int state = 0;  // 0=index, 1=time, 2=text, 3=blank
    
    subtitle_entry_t *current_entry = NULL;
    char *text_buffer = NULL;
    size_t text_buffer_size = 0;
    
    while (fgets(line, sizeof(line), file)) {
        // Remove trailing newline
        size_t len = strlen(line);
        if (len > 0 && line[len-1] == '\n') {
            line[len-1] = '\0';
            len--;
        }
        if (len > 0 && line[len-1] == '\r') {
            line[len-1] = '\0';
            len--;
        }
        
        if (state == 0) {  // Expecting subtitle index
            if (strlen(line) == 0) continue;  // Skip empty lines
            // Create new subtitle entry
            current_entry = calloc(1, sizeof(subtitle_entry_t));
            if (!current_entry) break;
            state = 1;
        } else if (state == 1) {  // Expecting time range
            char start_time[32], end_time[32];
            if (sscanf(line, "%31s --> %31s", start_time, end_time) == 2) {
                current_entry->start_frame = srt_time_to_frame(start_time, fps);
                current_entry->end_frame = srt_time_to_frame(end_time, fps);
                
                if (current_entry->start_frame < 0 || current_entry->end_frame < 0) {
                    free(current_entry);
                    current_entry = NULL;
                    state = 3;  // Skip to next blank line
                    continue;
                }
                
                // Initialize text buffer
                text_buffer_size = 256;
                text_buffer = malloc(text_buffer_size);
                if (!text_buffer) {
                    free(current_entry);
                    current_entry = NULL;
                    fprintf(stderr, "Memory allocation failed while parsing subtitles\n");
                    break;
                }
                text_buffer[0] = '\0';
                state = 2;
            } else {
                free(current_entry);
                current_entry = NULL;
                state = 3;  // Skip malformed entry
            }
        } else if (state == 2) {  // Collecting subtitle text
            if (strlen(line) == 0) {
                // End of subtitle text
                current_entry->text = strdup(text_buffer);
                free(text_buffer);
                text_buffer = NULL;
                
                // Add to list
                if (!head) {
                    head = current_entry;
                    tail = current_entry;
                } else {
                    tail->next = current_entry;
                    tail = current_entry;
                }
                current_entry = NULL;
                state = 0;
            } else {
                // Append text line
                size_t current_len = strlen(text_buffer);
                size_t line_len = strlen(line);
                size_t needed = current_len + line_len + 2;  // +2 for newline and null
                
                if (needed > text_buffer_size) {
                    text_buffer_size = needed + 256;
                    char *new_buffer = realloc(text_buffer, text_buffer_size);
                    if (!new_buffer) {
                        free(text_buffer);
                        free(current_entry);
                        current_entry = NULL;
                        fprintf(stderr, "Memory allocation failed while parsing subtitles\n");
                        break;
                    }
                    text_buffer = new_buffer;
                }
                
                if (current_len > 0) {
                    strcat(text_buffer, "\n");
                }
                strcat(text_buffer, line);
            }
        } else if (state == 3) {  // Skip to next blank line
            if (strlen(line) == 0) {
                state = 0;
            }
        }
    }
    
    // Handle final subtitle if file doesn't end with blank line
    if (current_entry && text_buffer) {
        current_entry->text = strdup(text_buffer);
        free(text_buffer);
        
        if (!head) {
            head = current_entry;
        } else {
            tail->next = current_entry;
        }
    }
    
    fclose(file);
    return head;
}

// Strip HTML tags from text but preserve <b> and <i> formatting tags
static char* strip_html_tags(const char *html) {
    if (!html) return NULL;
    
    size_t len = strlen(html);
    char *result = malloc(len + 1);
    if (!result) return NULL;
    
    int in_tag = 0;
    int out_pos = 0;
    int i = 0;
    
    while (i < len) {
        if (html[i] == '<') {
            // Check if this is a formatting tag we want to preserve
            int preserve_tag = 0;
            
            // Check for <b>, </b>, <i>, </i> tags
            if (i + 1 < len) {
                if ((i + 2 < len && strncasecmp(&html[i], "<b>", 3) == 0) ||
                    (i + 3 < len && strncasecmp(&html[i], "</b>", 4) == 0) ||
                    (i + 2 < len && strncasecmp(&html[i], "<i>", 3) == 0) ||
                    (i + 3 < len && strncasecmp(&html[i], "</i>", 4) == 0)) {
                    preserve_tag = 1;
                }
            }
            
            if (preserve_tag) {
                // Copy the entire tag
                while (i < len && html[i] != '>') {
                    result[out_pos++] = html[i++];
                }
                if (i < len) {
                    result[out_pos++] = html[i++]; // Copy the '>'
                }
            } else {
                // Skip non-formatting tags
                in_tag = 1;
                i++;
            }
        } else if (html[i] == '>') {
            in_tag = 0;
            i++;
        } else if (!in_tag) {
            result[out_pos++] = html[i++];
        } else {
            i++;
        }
    }
    
    result[out_pos] = '\0';
    return result;
}

// Parse SAMI subtitle file
static subtitle_entry_t* parse_smi_file(const char *filename, int fps) {
    FILE *file = fopen(filename, "r");
    if (!file) {
        fprintf(stderr, "Failed to open subtitle file: %s\n", filename);
        return NULL;
    }
    
    subtitle_entry_t *head = NULL;
    subtitle_entry_t *tail = NULL;
    char line[2048];
    char *content = NULL;
    size_t content_size = 0;
    size_t content_pos = 0;
    
    // Read entire file into memory for easier parsing
    while (fgets(line, sizeof(line), file)) {
        size_t line_len = strlen(line);
        
        // Expand content buffer if needed
        if (content_pos + line_len + 1 > content_size) {
            content_size = content_size ? content_size * 2 : 8192;
            char *new_content = realloc(content, content_size);
            if (!new_content) {
                free(content);
                fclose(file);
                fprintf(stderr, "Memory allocation failed while parsing SAMI file\n");
                return NULL;
            }
            content = new_content;
        }
        
        strcpy(content + content_pos, line);
        content_pos += line_len;
    }
    fclose(file);
    
    if (!content) return NULL;
    
    // Convert to lowercase for case-insensitive parsing
    char *content_lower = malloc(strlen(content) + 1);
    if (!content_lower) {
        free(content);
        return NULL;
    }
    
    for (int i = 0; content[i]; i++) {
        content_lower[i] = tolower(content[i]);
    }
    content_lower[strlen(content)] = '\0';
    
    // Find BODY section
    char *body_start = strstr(content_lower, "<body");
    if (!body_start) {
        fprintf(stderr, "No BODY section found in SAMI file\n");
        free(content);
        free(content_lower);
        return NULL;
    }
    
    // Skip to actual body content
    body_start = strchr(body_start, '>');
    if (!body_start) {
        free(content);
        free(content_lower);
        return NULL;
    }
    body_start++;
    
    // Calculate offset in original content
    size_t body_offset = body_start - content_lower;
    char *body_content = content + body_offset;
    
    // Parse SYNC tags
    char *pos = content_lower + body_offset;
    char *original_pos = body_content;
    
    while ((pos = strstr(pos, "<sync")) != NULL) {
        // Find start time
        char *start_attr = strstr(pos, "start");
        if (!start_attr || start_attr > strstr(pos, ">")) {
            pos++;
            continue;
        }
        
        // Parse start time
        start_attr = strchr(start_attr, '=');
        if (!start_attr) {
            pos++;
            continue;
        }
        start_attr++;
        
        // Skip whitespace and quotes
        while (*start_attr && (*start_attr == ' ' || *start_attr == '"' || *start_attr == '\'')) {
            start_attr++;
        }
        
        int start_ms = atoi(start_attr);
        if (start_ms < 0) {
            pos++;
            continue;
        }
        
        // Find end of sync tag
        char *sync_end = strchr(pos, '>');
        if (!sync_end) {
            pos++;
            continue;
        }
        sync_end++;
        
        // Find next sync tag or end of body
        char *next_sync = strstr(sync_end, "<sync");
        char *body_end = strstr(sync_end, "</body>");
        char *text_end = next_sync;
        
        if (body_end && (!next_sync || body_end < next_sync)) {
            text_end = body_end;
        }
        
        if (!text_end) {
            // Use end of content
            text_end = content_lower + strlen(content_lower);
        }
        
        // Extract subtitle text
        size_t text_len = text_end - sync_end;
        if (text_len > 0) {
            // Get text from original content (not lowercase version)
            size_t sync_offset = sync_end - content_lower;
            char *subtitle_text = malloc(text_len + 1);
            if (!subtitle_text) break;
            
            strncpy(subtitle_text, content + sync_offset, text_len);
            subtitle_text[text_len] = '\0';
            
            // Strip HTML tags and clean up text
            char *clean_text = strip_html_tags(subtitle_text);
            free(subtitle_text);
            
            if (clean_text && strlen(clean_text) > 0) {
                // Remove leading/trailing whitespace
                char *start = clean_text;
                while (*start && (*start == ' ' || *start == '\t' || *start == '\n' || *start == '\r')) {
                    start++;
                }
                
                char *end = start + strlen(start) - 1;
                while (end > start && (*end == ' ' || *end == '\t' || *end == '\n' || *end == '\r')) {
                    *end = '\0';
                    end--;
                }
                
                if (strlen(start) > 0) {
                    // Create subtitle entry
                    subtitle_entry_t *entry = calloc(1, sizeof(subtitle_entry_t));
                    if (entry) {
                        entry->start_frame = sami_ms_to_frame(start_ms, fps);
                        entry->text = strdup(start);
                        
                        // Set end frame to next subtitle start or a default duration
                        if (next_sync) {
                            // Parse next sync start time
                            char *next_start = strstr(next_sync, "start");
                            if (next_start) {
                                next_start = strchr(next_start, '=');
                                if (next_start) {
                                    next_start++;
                                    while (*next_start && (*next_start == ' ' || *next_start == '"' || *next_start == '\'')) {
                                        next_start++;
                                    }
                                    int next_ms = atoi(next_start);
                                    if (next_ms > start_ms) {
                                        entry->end_frame = sami_ms_to_frame(next_ms, fps);
                                    } else {
                                        entry->end_frame = entry->start_frame + fps * 3;  // 3 second default
                                    }
                                }
                            }
                        } else {
                            entry->end_frame = entry->start_frame + fps * 3;  // 3 second default
                        }
                        
                        // Add to list
                        if (!head) {
                            head = entry;
                            tail = entry;
                        } else {
                            tail->next = entry;
                            tail = entry;
                        }
                    }
                }
            }
            
            free(clean_text);
        }
        
        pos = sync_end;
    }
    
    free(content);
    free(content_lower);
    return head;
}

// Detect subtitle file format based on extension and content
static int detect_subtitle_format(const char *filename) {
    // Check file extension first
    const char *ext = strrchr(filename, '.');
    if (ext) {
        ext++; // Skip the dot
        if (strcasecmp(ext, "smi") == 0 || strcasecmp(ext, "sami") == 0) {
            return 1; // SAMI format
        }
        if (strcasecmp(ext, "srt") == 0) {
            return 0; // SubRip format
        }
    }
    
    // If extension is unclear, try to detect from content
    FILE *file = fopen(filename, "r");
    if (!file) return 0; // Default to SRT
    
    char line[1024];
    int has_sami_tags = 0;
    int has_srt_format = 0;
    int lines_checked = 0;
    
    while (fgets(line, sizeof(line), file) && lines_checked < 20) {
        // Convert to lowercase for checking
        char *lower_line = malloc(strlen(line) + 1);
        if (lower_line) {
            for (int i = 0; line[i]; i++) {
                lower_line[i] = tolower(line[i]);
            }
            lower_line[strlen(line)] = '\0';
            
            // Check for SAMI indicators
            if (strstr(lower_line, "<sami>") || strstr(lower_line, "<sync") || 
                strstr(lower_line, "<body>") || strstr(lower_line, "start=")) {
                has_sami_tags = 1;
                free(lower_line);
                break;
            }
            
            // Check for SRT indicators (time format)
            if (strstr(lower_line, "-->")) {
                has_srt_format = 1;
            }
            
            free(lower_line);
        }
        lines_checked++;
    }
    
    fclose(file);
    
    // Return format based on detection
    if (has_sami_tags) return 1; // SAMI
    return 0; // Default to SRT
}

// Parse subtitle file (auto-detect format)
static subtitle_entry_t* parse_subtitle_file(const char *filename, int fps) {
    int format = detect_subtitle_format(filename);
    
    if (format == 1) {
        return parse_smi_file(filename, fps);
    } else {
        return parse_srt_file(filename, fps);
    }
}

// Free subtitle list
static void free_subtitle_list(subtitle_entry_t *list) {
    while (list) {
        subtitle_entry_t *next = list->next;
        free(list->text);
        free(list);
        list = next;
    }
}

// Write subtitle packet to output
static int write_subtitle_packet(FILE *output, uint32_t index, uint8_t opcode, const char *text) {
    // Calculate packet size
    size_t text_len = text ? strlen(text) : 0;
    size_t packet_size = 3 + 1 + text_len + 1;  // index (3 bytes) + opcode + text + null terminator
    
    // Write packet type and size
    uint8_t packet_type = TEV_PACKET_SUBTITLE;
    fwrite(&packet_type, 1, 1, output);
    fwrite(&packet_size, 4, 1, output);
    
    // Write subtitle packet data
    uint8_t index_bytes[3];
    index_bytes[0] = index & 0xFF;
    index_bytes[1] = (index >> 8) & 0xFF;
    index_bytes[2] = (index >> 16) & 0xFF;
    fwrite(index_bytes, 1, 3, output);
    
    fwrite(&opcode, 1, 1, output);
    
    if (text && text_len > 0) {
        fwrite(text, 1, text_len, output);
    }
    
    // Write null terminator
    uint8_t null_term = 0x00;
    fwrite(&null_term, 1, 1, output);
    
    return packet_size + 5;  // packet_size + packet_type + size field
}

// Process subtitles for the current frame
static int process_subtitles(tev_encoder_t *enc, int frame_num, FILE *output) {
    if (!enc->has_subtitles) return 0;

    int bytes_written = 0;
    
    // Check if any subtitles need to be shown at this frame
    subtitle_entry_t *sub = enc->current_subtitle;
    while (sub && sub->start_frame <= frame_num) {
        if (sub->start_frame == frame_num) {
            // Show subtitle
            bytes_written += write_subtitle_packet(output, 0, 0x01, sub->text);
            if (enc->verbose) {
                printf("Frame %d: Showing subtitle: %.50s%s\n", 
                       frame_num, sub->text, strlen(sub->text) > 50 ? "..." : "");
            }
        }
        
        if (sub->end_frame == frame_num) {
            // Hide subtitle
            bytes_written += write_subtitle_packet(output, 0, 0x02, NULL);
            if (enc->verbose) {
                printf("Frame %d: Hiding subtitle\n", frame_num);
            }
        }
        
        // Move to next subtitle if we're past the end of current one
        if (sub->end_frame <= frame_num) {
            enc->current_subtitle = sub->next;
        }
        
        sub = sub->next;
    }
    
    return bytes_written;
}

// Initialize encoder
static tev_encoder_t* init_encoder(void) {
    tev_encoder_t *enc = calloc(1, sizeof(tev_encoder_t));
    if (!enc) return NULL;

    // set defaults
    enc->qualityIndex = 2; // Default quality
    enc->qualityY = QUALITY_Y[enc->qualityIndex];
    enc->qualityCo = QUALITY_CO[enc->qualityIndex];
    enc->qualityCg = enc->qualityCo / 2;
    enc->mp2_packet_size = 0; // Will be detected from MP2 header
    enc->mp2_rate_index = 0;
    enc->audio_frames_in_buffer = 0;
    enc->target_audio_buffer_size = 4;
    enc->width = DEFAULT_WIDTH;
    enc->height = DEFAULT_HEIGHT;
    enc->fps = 0;  // Will be detected from input
    enc->output_fps = 0;  // No frame rate conversion by default
    enc->verbose = 0;
    enc->subtitle_file = NULL;
    enc->has_subtitles = 0;
    enc->subtitle_list = NULL;
    enc->current_subtitle = NULL;

    // Rate control defaults
    enc->target_bitrate_kbps = 0;    // 0 = quality mode
    enc->bitrate_mode = 0;           // Quality mode by default
    // No global rate control factor needed - per-block complexity-based control only
    enc->frame_bits_accumulator = 0;
    enc->target_bits_per_frame = 0;
    enc->complexity_history_index = 0;
    enc->average_complexity = 0.0f;
    memset(enc->complexity_history, 0, sizeof(enc->complexity_history));

    init_dct_tables();

    return enc;
}

// Allocate encoder buffers
static int alloc_encoder_buffers(tev_encoder_t *enc) {
    // In interlaced mode, FFmpeg separatefields outputs field frames at half height
    // In progressive mode, we work with full height frames  
    int encoding_pixels = enc->width * enc->height;
    
    int blocks_x = (enc->width + 15) / 16;
    int blocks_y = (enc->height + 15) / 16;
    int total_blocks = blocks_x * blocks_y;

    // Allocate buffers for encoding (FFmpeg provides frames at the correct resolution)
    enc->current_rgb = malloc(encoding_pixels * 3);   // Current frame buffer from FFmpeg
    enc->previous_rgb = malloc(encoding_pixels * 3);  // Previous frame buffer for motion estimation  
    enc->reference_rgb = malloc(encoding_pixels * 3); // Reference frame buffer
    enc->previous_even_field = malloc(encoding_pixels * 3);  // Previous even field for interlaced scene change

    enc->y_workspace = malloc(16 * 16 * sizeof(float));
    enc->co_workspace = malloc(8 * 8 * sizeof(float));
    enc->cg_workspace = malloc(8 * 8 * sizeof(float));
    enc->dct_workspace = malloc(16 * 16 * sizeof(float));

    enc->block_data = malloc(total_blocks * sizeof(tev_block_t));
    enc->compressed_buffer = malloc(total_blocks * sizeof(tev_block_t) * 2);
    enc->mp2_buffer = malloc(MP2_DEFAULT_PACKET_SIZE);

    if (!enc->current_rgb || !enc->previous_rgb || !enc->reference_rgb ||
        !enc->previous_even_field ||
        !enc->y_workspace || !enc->co_workspace || !enc->cg_workspace ||
        !enc->dct_workspace || !enc->block_data ||
        !enc->compressed_buffer || !enc->mp2_buffer) {
        return -1;
    }

    // Initialize Zstd compression context
    enc->zstd_context = ZSTD_createCCtx();
    if (!enc->zstd_context) {
        fprintf(stderr, "Failed to initialize Zstd compression\n");
        return 0;
    }
    
    // Set reasonable compression level and memory limits
    ZSTD_CCtx_setParameter(enc->zstd_context, ZSTD_c_compressionLevel, ZSTD_COMPRESSON_LEVEL);
    ZSTD_CCtx_setParameter(enc->zstd_context, ZSTD_c_windowLog, 24); // 16MB window (should be plenty to hold an entire frame; interframe compression is unavailable)
    ZSTD_CCtx_setParameter(enc->zstd_context, ZSTD_c_hashLog, 16);

    // Initialize previous frame to black
    memset(enc->previous_rgb, 0, encoding_pixels * 3);
    memset(enc->previous_even_field, 0, encoding_pixels * 3);

    return 1;
}

// Free encoder resources
static void free_encoder(tev_encoder_t *enc) {
    if (!enc) return;

    if (enc->zstd_context) {
        ZSTD_freeCCtx(enc->zstd_context);
        enc->zstd_context = NULL;
    }

    if (enc->current_rgb) { free(enc->current_rgb); enc->current_rgb = NULL; }
    if (enc->previous_rgb) { free(enc->previous_rgb); enc->previous_rgb = NULL; }
    if (enc->reference_rgb) { free(enc->reference_rgb); enc->reference_rgb = NULL; }
    if (enc->previous_even_field) { free(enc->previous_even_field); enc->previous_even_field = NULL; }
    if (enc->y_workspace) { free(enc->y_workspace); enc->y_workspace = NULL; }
    if (enc->co_workspace) { free(enc->co_workspace); enc->co_workspace = NULL; }
    if (enc->cg_workspace) { free(enc->cg_workspace); enc->cg_workspace = NULL; }
    if (enc->dct_workspace) { free(enc->dct_workspace); enc->dct_workspace = NULL; }
    if (enc->block_data) { free(enc->block_data); enc->block_data = NULL; }
    if (enc->compressed_buffer) { free(enc->compressed_buffer); enc->compressed_buffer = NULL; }
    if (enc->mp2_buffer) { free(enc->mp2_buffer); enc->mp2_buffer = NULL; }
    free(enc);
}

// Write TEV header

static int write_tev_header(FILE *output, tev_encoder_t *enc) {
    // Magic + version
    fwrite(TEV_MAGIC, 1, 8, output);
    uint8_t version = TEV_VERSION;
    fwrite(&version, 1, 1, output);

    // Video parameters
    uint16_t width = enc->width;
    uint16_t height = enc->progressive_mode ? enc->height : enc->height * 2;
    uint8_t fps = enc->fps;
    uint32_t total_frames = enc->total_frames;
    uint8_t qualityY = enc->qualityY;
    uint8_t qualityCo = enc->qualityCo;
    uint8_t qualityCg = enc->qualityCg;
    uint8_t flags = (enc->has_audio) | (enc->has_subtitles << 1);
    uint8_t video_flags = enc->progressive_mode ? 0 : 1; // bit 0 = is_interlaced (inverted from progressive)
    uint8_t reserved = 0;

    fwrite(&width, 2, 1, output);
    fwrite(&height, 2, 1, output);
    fwrite(&fps, 1, 1, output);
    fwrite(&total_frames, 4, 1, output);
    fwrite(&qualityY, 1, 1, output);
    fwrite(&qualityCo, 1, 1, output);
    fwrite(&qualityCg, 1, 1, output);
    fwrite(&flags, 1, 1, output);
    fwrite(&video_flags, 1, 1, output);
    fwrite(&reserved, 1, 1, output);

    return 0;
}

// Detect scene changes by analyzing frame differences
static int detect_scene_change(tev_encoder_t *enc, int field_parity) {
    if (!enc->current_rgb) {
        return 0; // No current frame to compare
    }
    
    // In interlaced mode, use previous even field for comparison
    uint8_t *comparison_buffer = enc->previous_rgb;
    if (!enc->progressive_mode && field_parity == 0) {
        // Interlaced even field: compare to previous even field
        if (!enc->previous_even_field) {
            return 0; // No previous even field to compare
        }
        comparison_buffer = enc->previous_even_field;
    } else {
        // Progressive mode: use regular previous_rgb
        if (!enc->previous_rgb) {
            return 0; // No previous frame to compare
        }
        comparison_buffer = enc->previous_rgb;
    }
    
    long long total_diff = 0;
    int changed_pixels = 0;

    // Sample every 4th pixel for performance (still gives good detection)
    for (int y = 0; y < enc->height; y += 2) {
        for (int x = 0; x < enc->width; x += 2) {
            int offset = (y * enc->width + x) * 3;
            
            // Calculate color difference
            int r_diff = abs(enc->current_rgb[offset] - comparison_buffer[offset]);
            int g_diff = abs(enc->current_rgb[offset + 1] - comparison_buffer[offset + 1]);
            int b_diff = abs(enc->current_rgb[offset + 2] - comparison_buffer[offset + 2]);
            
            int pixel_diff = r_diff + g_diff + b_diff;
            total_diff += pixel_diff;
            
            // Count significantly changed pixels (threshold of 30 per channel average)
            if (pixel_diff > 90) {
                changed_pixels++;
            }
        }
    }
    
    // Calculate metrics for scene change detection
    int sampled_pixels = (enc->height / 2) * (enc->width / 2);
    double avg_diff = (double)total_diff / sampled_pixels;
    double changed_ratio = (double)changed_pixels / sampled_pixels;

    if (enc->verbose) {
        printf("Scene change detection: avg_diff=%.2f\tchanged_ratio=%.4f\n", avg_diff, changed_ratio);
    }

    // Scene change thresholds - adjust for interlaced mode
    // Interlaced fields have more natural differences due to temporal field separation
    double threshold = 0.30;
    
    return changed_ratio > threshold;
}

// Encode and write a frame
static int encode_frame(tev_encoder_t *enc, FILE *output, int frame_num, int field_parity) {
    // In interlaced mode, only do scene change detection for even fields (field_parity = 0)
    // to avoid false scene changes between fields of the same frame
    int is_scene_change = 0;
    if (enc->progressive_mode || field_parity == 0) {
        is_scene_change = detect_scene_change(enc, field_parity);
    }
    int is_time_keyframe = (frame_num % KEYFRAME_INTERVAL) == 0;
    int is_keyframe = is_time_keyframe || is_scene_change;
    
    // Verbose output for keyframe decisions
    if (enc->verbose && is_keyframe) {
        if (is_scene_change && !is_time_keyframe) {
            printf("Frame %d: Scene change detected, inserting keyframe\n", frame_num);
        } else if (is_time_keyframe) {
            printf("Frame %d: Time-based keyframe (interval: %d)\n", frame_num, KEYFRAME_INTERVAL);
        }
    }
    int blocks_x = (enc->width + 15) / 16;
    int blocks_y = (enc->height + 15) / 16;

    // Track frame complexity for rate control
    float frame_complexity = 0.0f;
    size_t frame_start_bits = enc->total_output_bytes * 8;

    // Encode all blocks
    for (int by = 0; by < blocks_y; by++) {
        for (int bx = 0; bx < blocks_x; bx++) {
            encode_block(enc, bx, by, is_keyframe);

            // Calculate complexity for rate control (if enabled)
            if (enc->bitrate_mode > 0) {
                tev_block_t *block = &enc->block_data[by * blocks_x + bx];
                if (block->mode == TEV_MODE_INTRA || block->mode == TEV_MODE_INTER) {
                    // Sum absolute values of quantised coefficients as complexity metric
                    for (int i = 1; i < BLOCK_SIZE_SQR; i++) frame_complexity += abs(block->y_coeffs[i]);
                    for (int i = 1; i < HALF_BLOCK_SIZE_SQR; i++) frame_complexity += abs(block->co_coeffs[i]);
                    for (int i = 1; i < HALF_BLOCK_SIZE_SQR; i++) frame_complexity += abs(block->cg_coeffs[i]);
                }
            }
        }
    }

    // Compress block data using Zstd (compatible with TSVM decoder)
    size_t block_data_size = blocks_x * blocks_y * sizeof(tev_block_t);

    // Compress using Zstd with controlled memory usage
    size_t compressed_size = ZSTD_compressCCtx(enc->zstd_context,
                                             enc->compressed_buffer, block_data_size * 2,
                                             enc->block_data, block_data_size,
                                             ZSTD_COMPRESSON_LEVEL);
    
    if (ZSTD_isError(compressed_size)) {
        fprintf(stderr, "Zstd compression failed: %s\n", ZSTD_getErrorName(compressed_size));
        return 0;
    }

    // Write frame packet header (rate control factor now per-block)
    uint8_t packet_type = is_keyframe ? TEV_PACKET_IFRAME : TEV_PACKET_PFRAME;
    uint32_t payload_size = compressed_size; // Rate control factor now per-block, not per-packet

    fwrite(&packet_type, 1, 1, output);
    fwrite(&payload_size, 4, 1, output);
    fwrite(enc->compressed_buffer, 1, compressed_size, output);

    if (enc->verbose) {
        printf("perBlockComplexityBasedRateControl=enabled\n");
    }

    enc->total_output_bytes += 5 + compressed_size; // packet + size + data (rate_factor now per-block)

    // No global rate control needed - per-block complexity-based control only

    // Swap frame buffers for next frame
    if (!enc->progressive_mode && field_parity == 0) {
        // Interlaced even field: save to previous_even_field for scene change detection
        size_t field_size = enc->width * enc->height * 3;
        memcpy(enc->previous_even_field, enc->current_rgb, field_size);
    }
    
    // Normal buffer swap for motion estimation
    uint8_t *temp_rgb = enc->previous_rgb;
    enc->previous_rgb = enc->current_rgb;
    enc->current_rgb = temp_rgb;

    return 1;
}

// Execute command and capture output
static char *execute_command(const char *command) {
    FILE *pipe = popen(command, "r");
    if (!pipe) return NULL;

    char *result = malloc(4096);
    if (!result) {
        pclose(pipe);
        return NULL;
    }
    
    size_t len = fread(result, 1, 4095, pipe);
    result[len] = '\0';

    pclose(pipe);
    return result;
}

// Get video metadata using ffprobe
static int get_video_metadata(tev_encoder_t *config) {
    char command[1024];
    char *output;

    // Get all metadata in a single ffprobe call
    snprintf(command, sizeof(command),
        "ffprobe -v quiet -count_frames "
        "-show_entries stream=nb_read_frames,r_frame_rate:format=duration "
        "-select_streams v:0 -of csv=p=0 \"%s\" 2>/dev/null; "
        "ffprobe -v quiet -select_streams a:0 -show_entries stream=index -of csv=p=0 \"%s\" 2>/dev/null",
        config->input_file, config->input_file);

    output = execute_command(command);
    if (!output) {
        fprintf(stderr, "Failed to get video metadata\n");
        return 0;
    }

    // Parse the combined output
    char *line = strtok(output, "\n");
    int line_num = 0;

    while (line && line_num < 2) {
        switch (line_num) {
            case 0: // Line format: "framerate,framecount" (e.g., "24000/1001,4423")
                {
                    char *comma = strchr(line, ',');
                    if (comma) {
                        *comma = '\0'; // Split at comma
                        // Parse frame rate (first part)
                        int num, den;
                        if (sscanf(line, "%d/%d", &num, &den) == 2) {
                            config->fps = (den > 0) ? (int)round((float)num/(float)den) : 30;
                        } else {
                            config->fps = (int)round(atof(line));
                        }
                        // Parse frame count (second part)
                        config->total_frames = atoi(comma + 1);
                    }
                }
                break;
            case 1: // duration in seconds
                config->duration = atof(line);
                break;
        }
        line = strtok(NULL, "\n");
        line_num++;
    }

    // Check for audio stream (will be on line 3 if present)
    config->has_audio = (line && strlen(line) > 0 && atoi(line) >= 0);

    free(output);

    // Validate frame count using duration if needed
    if (config->total_frames <= 0 && config->duration > 0) {
        config->total_frames = (int)(config->duration * config->fps);
    }

    fprintf(stderr, "Video metadata:\n");
    fprintf(stderr, "  Frames: %d\n", config->total_frames);
    fprintf(stderr, "  FPS: %d\n", config->fps);
    fprintf(stderr, "  Duration: %.2fs\n", config->duration);
    fprintf(stderr, "  Audio: %s\n", config->has_audio ? "Yes" : "No");
    fprintf(stderr, "  Resolution: %dx%d (%s)\n", config->width, config->height, 
            config->progressive_mode ? "progressive" : "interlaced");

    return (config->total_frames > 0 && config->fps > 0);
}

// Start FFmpeg process for video conversion with frame rate support
static int start_video_conversion(tev_encoder_t *enc) {
    char command[2048];

    // Build FFmpeg command with potential frame rate conversion
    if (enc->progressive_mode) {
        if (enc->output_fps > 0 && enc->output_fps != enc->fps) {
            // Frame rate conversion requested
            snprintf(command, sizeof(command),
                "ffmpeg -v error -i \"%s\" -f rawvideo -pix_fmt rgb24 "
                "-vf \"fps=%d,scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d\" "
                "-y - 2>&1",
                enc->input_file, enc->output_fps, enc->width, enc->height, enc->width, enc->height);
        } else {
            // No frame rate conversion
            snprintf(command, sizeof(command),
                "ffmpeg -v error -i \"%s\" -f rawvideo -pix_fmt rgb24 "
                "-vf \"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d\" "
                "-y -",
                enc->input_file, enc->width, enc->height, enc->width, enc->height);
        }
    // let FFmpeg handle the interlacing
    } else {
        if (enc->output_fps > 0 && enc->output_fps != enc->fps) {
            // Frame rate conversion requested
            // filtergraph path:
            // 1. FPS conversion
            // 2. scale and crop to requested size
            // 3. tinterlace weave-overwrites even and odd fields together to produce intermediate video at half framerate, full height (we're losing half the information here -- and that's on purpose)
            // 4. separatefields separates weave-overwritten frame as two consecutive frames, at half height. Since the frame rate is halved in Step 3. and being doubled here, the final framerate is identical to given framerate
            snprintf(command, sizeof(command),
                "ffmpeg -v error -i \"%s\" -f rawvideo -pix_fmt rgb24 "
                "-vf \"fps=%d,scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,tinterlace=interleave_top:cvlpf,separatefields\" "
                "-y - 2>&1",
                enc->input_file, enc->output_fps, enc->width, enc->height * 2, enc->width, enc->height * 2);
        } else {
            // No frame rate conversion
            // filtergraph path:
            // 1. scale and crop to requested size
            // 2. tinterlace weave-overwrites even and odd fields together to produce intermediate video at half framerate, full height (we're losing half the information here -- and that's on purpose)
            // 3. separatefields separates weave-overwritten frame as two consecutive frames, at half height. Since the frame rate is halved in Step 2. and being doubled here, the final framerate is identical to the original framerate
            snprintf(command, sizeof(command),
                "ffmpeg -v error -i \"%s\" -f rawvideo -pix_fmt rgb24 "
                "-vf \"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,tinterlace=interleave_top:cvlpf,separatefields\" "
                "-y -",
                enc->input_file, enc->width, enc->height * 2, enc->width, enc->height * 2);
        }
    }

    if (enc->verbose) {
        printf("FFmpeg command: %s\n", command);
    }

    enc->ffmpeg_video_pipe = popen(command, "r");
    if (!enc->ffmpeg_video_pipe) {
        fprintf(stderr, "Failed to start FFmpeg process\n");
        return 0;
    }

    return 1;
}

// Start audio conversion
static int start_audio_conversion(tev_encoder_t *enc) {
    if (!enc->has_audio) return 1;

    char command[2048];
    snprintf(command, sizeof(command),
        "ffmpeg -v quiet -i \"%s\" -acodec libtwolame -psymodel 4 -b:a %dk -ar %d -ac 2 -y \"%s\" 2>/dev/null",
        enc->input_file, MP2_RATE_TABLE[enc->qualityIndex], MP2_SAMPLE_RATE, TEMP_AUDIO_FILE);

    int result = system(command);
    if (result == 0) {
        enc->mp2_file = fopen(TEMP_AUDIO_FILE, "rb");
        if (enc->mp2_file) {
            fseek(enc->mp2_file, 0, SEEK_END);
            enc->audio_remaining = ftell(enc->mp2_file);
            fseek(enc->mp2_file, 0, SEEK_SET);
        }
    }

    return (result == 0);
}

// Get MP2 packet size and rate index from header
static int get_mp2_packet_size(uint8_t *header) {
    int bitrate_index = (header[2] >> 4) & 0x0F;
    int bitrates[] = {0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384};
    if (bitrate_index >= 15) return MP2_DEFAULT_PACKET_SIZE;

    int bitrate = bitrates[bitrate_index];
    int padding_bit = (header[2] >> 1) & 0x01;
    if (bitrate <= 0) return MP2_DEFAULT_PACKET_SIZE;

    int frame_size = (144 * bitrate * 1000) / MP2_SAMPLE_RATE + padding_bit;
    return frame_size;
}

static int mp2_packet_size_to_rate_index(int packet_size, int is_mono) {
    // Map packet sizes to rate indices for TEV format
    const int mp2_frame_sizes[] = {144,216,252,288,360,432,504,576,720,864,1008,1152,1440,1728};
    for (int i = 0; i < 14; i++) {
        if (packet_size <= mp2_frame_sizes[i]) {
            return i;
        }
    }
    return 13; // Default to highest rate
}

// Process audio for current frame
static int process_audio(tev_encoder_t *enc, int frame_num, FILE *output) {
    if (!enc->has_audio || !enc->mp2_file || enc->audio_remaining <= 0) {
        return 1;
    }

    // Initialize packet size on first frame
    if (enc->mp2_packet_size == 0) {
        uint8_t header[4];
        if (fread(header, 1, 4, enc->mp2_file) != 4) return 1;
        fseek(enc->mp2_file, 0, SEEK_SET);

        enc->mp2_packet_size = get_mp2_packet_size(header);
        int is_mono = (header[3] >> 6) == 3;
        enc->mp2_rate_index = mp2_packet_size_to_rate_index(enc->mp2_packet_size, is_mono);
        enc->target_audio_buffer_size = 4; // 4 audio packets in buffer
    }

    // Calculate how much audio time each frame represents (in seconds)
    double frame_audio_time = 1.0 / enc->fps;

    // Calculate how much audio time each MP2 packet represents
    // MP2 frame contains 1152 samples at 32kHz = 0.036 seconds
    double packet_audio_time = 1152.0 / MP2_SAMPLE_RATE;

    // Estimate how many packets we consume per video frame
    double packets_per_frame = frame_audio_time / packet_audio_time;

    // Audio buffering strategy: maintain target buffer level
    int packets_to_insert = 0;
    if (frame_num == 0) {
        // Prime buffer to target level initially
        packets_to_insert = enc->target_audio_buffer_size;
        enc->audio_frames_in_buffer = 0; // count starts from 0
        if (enc->verbose) {
            printf("Frame %d: Priming audio buffer with %d packets\n", frame_num, packets_to_insert);
        }
    } else {
        // Simulate buffer consumption (fractional consumption per frame)
        double old_buffer = enc->audio_frames_in_buffer;
        enc->audio_frames_in_buffer -= packets_per_frame;

        // Calculate how many packets we need to maintain target buffer level
        // Only insert when buffer drops below target, and only insert enough to restore target
        double target_level = (double)enc->target_audio_buffer_size;
        if (enc->audio_frames_in_buffer < target_level) {
            double deficit = target_level - enc->audio_frames_in_buffer;
            // Insert packets to cover the deficit, but at least maintain minimum flow
            packets_to_insert = (int)ceil(deficit);
            // Cap at reasonable maximum to prevent excessive insertion
            if (packets_to_insert > enc->target_audio_buffer_size) {
                packets_to_insert = enc->target_audio_buffer_size;
            }
            
            if (enc->verbose) {
                printf("Frame %d: Buffer low (%.2f->%.2f), deficit %.2f, inserting %d packets\n", 
                       frame_num, old_buffer, enc->audio_frames_in_buffer, deficit, packets_to_insert);
            }
        } else if (enc->verbose && old_buffer != enc->audio_frames_in_buffer) {
            printf("Frame %d: Buffer sufficient (%.2f->%.2f), no packets\n", 
                   frame_num, old_buffer, enc->audio_frames_in_buffer);
        }
    }

    // Insert the calculated number of audio packets
    for (int q = 0; q < packets_to_insert; q++) {
        size_t bytes_to_read = enc->mp2_packet_size;
        if (bytes_to_read > enc->audio_remaining) {
            bytes_to_read = enc->audio_remaining;
        }

        size_t bytes_read = fread(enc->mp2_buffer, 1, bytes_to_read, enc->mp2_file);
        if (bytes_read == 0) break;

        // Write TEV MP2 audio packet
        uint8_t audio_packet_type = TEV_PACKET_AUDIO_MP2;
        uint32_t audio_len = (uint32_t)bytes_read;
        fwrite(&audio_packet_type, 1, 1, output);
        fwrite(&audio_len, 4, 1, output);
        fwrite(enc->mp2_buffer, 1, bytes_read, output);

        // Track audio bytes written
        enc->total_output_bytes += 1 + 4 + bytes_read;
        enc->audio_remaining -= bytes_read;
        enc->audio_frames_in_buffer++;

        if (frame_num == 0) {
            enc->audio_frames_in_buffer = enc->target_audio_buffer_size / 2; // trick the buffer simulator so that it doesn't count the frame 0 priming
        }

        if (enc->verbose) {
            printf("Audio packet %d: %zu bytes (buffer: %.2f packets)\n", 
                   q, bytes_read, enc->audio_frames_in_buffer);
        }
    }

    return 1;
}

// Show usage information
static void show_usage(const char *program_name) {
    printf("TEV YCoCg-R 4:2:0 Video Encoder with Bitrate Control\n");
    printf("Usage: %s [options] -i input.mp4 -o output.mv2\n\n", program_name);
    printf("Options:\n");
    printf("  -i, --input FILE     Input video file\n");
    printf("  -o, --output FILE    Output video file (use '-' for stdout)\n");
    printf("  -s, --subtitles FILE SubRip (.srt) or SAMI (.smi) subtitle file\n");
    printf("  -w, --width N        Video width (default: %d)\n", DEFAULT_WIDTH);
    printf("  -h, --height N       Video height (default: %d)\n", DEFAULT_HEIGHT);
    printf("  -f, --fps N          Output frames per second (enables frame rate conversion)\n");
    printf("  -q, --quality N      Quality level 0-4 (default: 2, only decides audio rate in bitrate mode and quantiser mode)\n");
    printf("  -Q, --quantiser N    Quantiser level 0-100 (100: lossless, 0: potato)\n");
//    printf("  -b, --bitrate N      Target bitrate in kbps (enables bitrate control mode; DON'T USE - NOT WORKING AS INTENDED)\n");
    printf("  -p, --progressive    Use progressive scan (default: interlaced)\n");
    printf("  -v, --verbose        Verbose output\n");
    printf("  -t, --test           Test mode: generate solid colour frames\n");
    printf("  --help               Show this help\n\n");
//    printf("Rate Control Modes:\n");
//    printf("  Quality mode (default): Fixed quantisation based on -q parameter\n");
//    printf("  Bitrate mode (-b N):    Dynamic quantisation targeting N kbps average\n\n");
    printf("Audio Rate by Quality:\n");
    printf("  ");
    for (int i = 0; i < sizeof(MP2_RATE_TABLE) / sizeof(int); i++) {
        printf("%d: %d kbps\t", i, MP2_RATE_TABLE[i]);
    }
    printf("\nQuantiser Value by Quality:\n");
    printf("  ");
    for (int i = 0; i < sizeof(QUALITY_Y) / sizeof(int); i++) {
        printf("%d: -Q %d  \t", i, QUALITY_Y[i]);
    }
    printf("\n\n");
    printf("Features:\n");
    printf("  - YCoCg-R 4:2:0 chroma subsampling for 50%% compression improvement\n");
    printf("  - 16x16 Y blocks with 8x8 chroma for optimal DCT efficiency\n");
    printf("  - Frame rate conversion with FFmpeg temporal filtering\n");
    printf("  - Adaptive quality control with complexity-based adjustment\n");
    printf("Examples:\n");
    printf("  %s -i input.mp4 -o output.mv2                 # Use default setting (q=2)\n", program_name);
    printf("  %s -i input.avi -f 15 -q 3 -o output.mv2      # 15fps @ q=3\n", program_name);
    printf("  %s -i input.mp4 -s input.srt -o output.mv2    # With SubRip subtitles\n", program_name);
    printf("  %s -i input.mp4 -s input.smi -o output.mv2    # With SAMI subtitles\n", program_name);
//    printf("  %s -i input.mp4 -b 800 -o output.mv2          # 800 kbps bitrate target\n", program_name);
//    printf("  %s -i input.avi -f 15 -b 500 -o output.mv2    # 15fps @ 500 kbps\n", program_name);
//    printf("  %s --test -b 1000 -o test.mv2                 # Test with 1000 kbps target\n", program_name);
}


// Cleanup encoder resources
static void cleanup_encoder(tev_encoder_t *enc) {
    if (!enc) return;

    if (enc->ffmpeg_video_pipe) { 
        pclose(enc->ffmpeg_video_pipe); 
        enc->ffmpeg_video_pipe = NULL;
    }
    if (enc->mp2_file) {
        fclose(enc->mp2_file);
        enc->mp2_file = NULL;
        unlink(TEMP_AUDIO_FILE); // Remove temporary audio file
    }

    if (enc->input_file) { free(enc->input_file); enc->input_file = NULL; }
    if (enc->output_file) { free(enc->output_file); enc->output_file = NULL; }
    if (enc->subtitle_file) { free(enc->subtitle_file); enc->subtitle_file = NULL; }
    free_subtitle_list(enc->subtitle_list);

    free_encoder(enc);
}

int sync_packet_count = 0;

// Main function
int main(int argc, char *argv[]) {
    generate_random_filename(TEMP_AUDIO_FILE);

    printf("Initialising encoder...\n");
    tev_encoder_t *enc = init_encoder();
    if (!enc) {
        fprintf(stderr, "Failed to initialise encoder\n");
        return 1;
    }

    int test_mode = 0;

    static struct option long_options[] = {
        {"input", required_argument, 0, 'i'},
        {"output", required_argument, 0, 'o'},
        {"subtitles", required_argument, 0, 's'},
        {"width", required_argument, 0, 'w'},
        {"height", required_argument, 0, 'h'},
        {"fps", required_argument, 0, 'f'},
        {"quality", required_argument, 0, 'q'},
        {"quantiser", required_argument, 0, 'Q'},
        {"quantizer", required_argument, 0, 'Q'},
        {"bitrate", required_argument, 0, 'b'},
        {"progressive", no_argument, 0, 'p'},
        {"verbose", no_argument, 0, 'v'},
        {"test", no_argument, 0, 't'},
        {"help", no_argument, 0, '?'},
        {0, 0, 0, 0}
    };

    int option_index = 0;
    int c;

    while ((c = getopt_long(argc, argv, "i:o:s:w:h:f:q:b:Q:pvt", long_options, &option_index)) != -1) {
        switch (c) {
            case 'i':
                enc->input_file = strdup(optarg);
                break;
            case 'o':
                enc->output_file = strdup(optarg);
                enc->output_to_stdout = (strcmp(optarg, "-") == 0);
                break;
            case 's':
                enc->subtitle_file = strdup(optarg);
                break;
            case 'w':
                enc->width = atoi(optarg);
                break;
            case 'h':
                enc->height = atoi(optarg);
                break;
            case 'f':
                enc->output_fps = atoi(optarg);
                if (enc->output_fps <= 0) {
                    fprintf(stderr, "Invalid FPS: %d\n", enc->output_fps);
                    cleanup_encoder(enc);
                    return 1;
                }
                break;
            case 'q':
                enc->qualityIndex = CLAMP(atoi(optarg), 0, 4);
                enc->qualityY = QUALITY_Y[enc->qualityIndex];
                enc->qualityCo = QUALITY_CO[enc->qualityIndex];
                enc->qualityCg = enc->qualityCo / 2;
                break;
            case 'b':
                enc->target_bitrate_kbps = atoi(optarg);
                if (enc->target_bitrate_kbps > 0) {
                    enc->bitrate_mode = 1; // Enable bitrate control
                }
                break;
            case 'p':
                enc->progressive_mode = 1;
                break;
            case 'v':
                enc->verbose = 1;
                break;
            case 't':
                test_mode = 1;
                break;
            case 0:
                if (strcmp(long_options[option_index].name, "help") == 0) {
                    show_usage(argv[0]);
                    cleanup_encoder(enc);
                    return 0;
                }
                break;
            case 'Q':
                enc->qualityY = CLAMP(atoi(optarg), 0, 100);
                enc->qualityCo = enc->qualityY;
                enc->qualityCg = enc->qualityCo / 2;
                break;
            default:
                show_usage(argv[0]);
                cleanup_encoder(enc);
                return 1;
        }
    }

    // halve the internal representation of frame height
    if (!enc->progressive_mode) {
        enc->height /= 2;
    }

    if (!test_mode && (!enc->input_file || !enc->output_file)) {
        fprintf(stderr, "Input and output files are required (unless using --test mode)\n");
        show_usage(argv[0]);
        cleanup_encoder(enc);
        return 1;
    }

    if (!enc->output_file) {
        fprintf(stderr, "Output file is required\n");
        show_usage(argv[0]);
        cleanup_encoder(enc);
        return 1;
    }

    // Handle test mode or real video
    if (test_mode) {
        // Test mode: generate solid colour frames
        enc->fps = 1;
        enc->total_frames = 15;
        enc->has_audio = 0;
        printf("Test mode: Generating 15 solid colour frames\n");
    } else {
        // Get video metadata and start FFmpeg processes
        printf("Retrieving video metadata...\n");
        if (!get_video_metadata(enc)) {
            fprintf(stderr, "Failed to get video metadata\n");
            cleanup_encoder(enc);
            return 1;
        }
    }

    // Load subtitle file if specified
    printf("Loading subtitles...\n");
    if (enc->subtitle_file) {
        int format = detect_subtitle_format(enc->subtitle_file);
        const char *format_name = (format == 1) ? "SAMI" : "SubRip";
        
        enc->subtitle_list = parse_subtitle_file(enc->subtitle_file, enc->fps);
        if (enc->subtitle_list) {
            enc->has_subtitles = 1;
            enc->current_subtitle = enc->subtitle_list;
            if (enc->verbose) {
                printf("Loaded %s subtitles from: %s\n", format_name, enc->subtitle_file);
            }
        } else {
            fprintf(stderr, "Failed to parse %s subtitle file: %s\n", format_name, enc->subtitle_file);
            // Continue without subtitles
        }
    }

    // Allocate buffers
    if (!alloc_encoder_buffers(enc)) {
        fprintf(stderr, "Failed to allocate encoder buffers\n");
        cleanup_encoder(enc);
        return 1;
    }

    // Start FFmpeg processes (only for real video mode)
    if (!test_mode) {
        // Start FFmpeg video conversion
        if (!start_video_conversion(enc)) {
            fprintf(stderr, "Failed to start video conversion\n");
            cleanup_encoder(enc);
            return 1;
        }

        // Start audio conversion (if audio present)
        if (!start_audio_conversion(enc)) {
            fprintf(stderr, "Warning: Audio conversion failed\n");
            enc->has_audio = 0;
        }
    }

    // Open output
    FILE *output = enc->output_to_stdout ? stdout : fopen(enc->output_file, "wb");
    if (!output) {
        perror("Failed to open output file");
        cleanup_encoder(enc);
        return 1;
    }

    // Write TEV header
    write_tev_header(output, enc);
    gettimeofday(&enc->start_time, NULL);

    printf("Encoding video with YCoCg-R 4:2:0 format...\n");
    if (enc->output_fps > 0) {
        printf("Frame rate conversion enabled: %d fps output\n", enc->output_fps);
    }
    if (enc->bitrate_mode > 0) {
        printf("Bitrate control enabled: targeting %d kbps\n", enc->target_bitrate_kbps);
    } else {
        printf("Quality mode: q=%d\n", enc->qualityIndex);
        printf("Quantiser levels: %d, %d, %d\n", enc->qualityY, enc->qualityCo, enc->qualityCg);
    }

    // Process frames
    int frame_count = 0;
    while (frame_count < enc->total_frames) {
        if (test_mode) {
            // Generate test frame with solid colours
            size_t rgb_size = enc->width * enc->height * 3;
            uint8_t test_r = 0, test_g = 0, test_b = 0;
            const char* colour_name = "unknown";

            switch (frame_count) {
                case 0: test_r = 0; test_g = 0; test_b = 0; colour_name = "black"; break;
                case 1: test_r = 127; test_g = 127; test_b = 127; colour_name = "grey"; break;
                case 2: test_r = 255; test_g = 255; test_b = 255; colour_name = "white"; break;
                case 3: test_r = 127; test_g = 0; test_b = 0; colour_name = "half red"; break;
                case 4: test_r = 127; test_g = 127; test_b = 0; colour_name = "half yellow"; break;
                case 5: test_r = 0; test_g = 127; test_b = 0; colour_name = "half green"; break;
                case 6: test_r = 0; test_g = 127; test_b = 127; colour_name = "half cyan"; break;
                case 7: test_r = 0; test_g = 0; test_b = 127; colour_name = "half blue"; break;
                case 8: test_r = 127; test_g = 0; test_b = 127; colour_name = "half magenta"; break;
                case 9: test_r = 255; test_g = 0; test_b = 0; colour_name = "red"; break;
                case 10: test_r = 255; test_g = 255; test_b = 0; colour_name = "yellow"; break;
                case 11: test_r = 0; test_g = 255; test_b = 0; colour_name = "green"; break;
                case 12: test_r = 0; test_g = 255; test_b = 255; colour_name = "cyan"; break;
                case 13: test_r = 0; test_g = 0; test_b = 255; colour_name = "blue"; break;
                case 14: test_r = 255; test_g = 0; test_b = 255; colour_name = "magenta"; break;
            }

            // Fill entire frame with solid colour
            for (size_t i = 0; i < rgb_size; i += 3) {
                enc->current_rgb[i] = test_r;
                enc->current_rgb[i + 1] = test_g;
                enc->current_rgb[i + 2] = test_b;
            }

            printf("Frame %d: %s (%d,%d,%d)\n", frame_count, colour_name, test_r, test_g, test_b);
            
            // Test YCoCg-R conversion
            int y_test, co_test, cg_test;
            rgb_to_ycocgr(test_r, test_g, test_b, &y_test, &co_test, &cg_test);
            printf("  YCoCg-R: Y=%d Co=%d Cg=%d\n", y_test, co_test, cg_test);
            
            // Test reverse conversion
            uint8_t r_rev, g_rev, b_rev;
            ycocgr_to_rgb(y_test, co_test, cg_test, &r_rev, &g_rev, &b_rev);
            printf("  Reverse: R=%d G=%d B=%d\n", r_rev, g_rev, b_rev);
            
        } else {
            // Read RGB data directly from FFmpeg pipe
            // height-halving is already done on the encoder initialisation
            int frame_height = enc->height;
            size_t rgb_size = enc->width * frame_height * 3;
            size_t bytes_read = fread(enc->current_rgb, 1, rgb_size, enc->ffmpeg_video_pipe);
            
            if (bytes_read != rgb_size) {
                if (enc->verbose) {
                    printf("Frame %d: Expected %zu bytes, got %zu bytes\n", frame_count, rgb_size, bytes_read);
                    if (feof(enc->ffmpeg_video_pipe)) {
                        printf("FFmpeg pipe reached end of file\n");
                    }
                    if (ferror(enc->ffmpeg_video_pipe)) {
                        printf("FFmpeg pipe error occurred\n");
                    }
                }
                break; // End of video or error
            }
            
            // In interlaced mode, FFmpeg separatefields filter already provides field-separated frames
            // Each frame from FFmpeg is now a single field at half height
            // Frame parity: even frames (0,2,4...) = bottom fields, odd frames (1,3,5...) = top fields
        }

        // Process audio for this frame
        process_audio(enc, frame_count, output);

        // Process subtitles for this frame
        process_subtitles(enc, frame_count, output);

        // Encode frame
        // Pass field parity for interlaced mode, -1 for progressive mode
        int frame_field_parity = enc->progressive_mode ? -1 : (frame_count % 2);
        if (!encode_frame(enc, output, frame_count, frame_field_parity)) {
            fprintf(stderr, "Failed to encode frame %d\n", frame_count);
            break;
        }
        else {
            // Write a sync packet only after a video is been coded
            uint8_t sync_packet = TEV_PACKET_SYNC;
            fwrite(&sync_packet, 1, 1, output);
            sync_packet_count++;
        }



        frame_count++;
        if (enc->verbose || frame_count % 30 == 0) {
            struct timeval now;
            gettimeofday(&now, NULL);
            double elapsed = (now.tv_sec - enc->start_time.tv_sec) + 
                           (now.tv_usec - enc->start_time.tv_usec) / 1000000.0;
            double fps = frame_count / elapsed;
            printf("Encoded frame %d/%d (%.1f fps)\n", frame_count, enc->total_frames, fps);
        }
    }
    
    // Write final sync packet
    uint8_t sync_packet = TEV_PACKET_SYNC;
    fwrite(&sync_packet, 1, 1, output);
    sync_packet_count++;

    if (!enc->output_to_stdout) {
        fclose(output);
    }
    
    // Final statistics
    struct timeval end_time;
    gettimeofday(&end_time, NULL);
    double total_time = (end_time.tv_sec - enc->start_time.tv_sec) + 
                       (end_time.tv_usec - enc->start_time.tv_usec) / 1000000.0;
    
    printf("\nEncoding complete!\n");
    printf("  Frames encoded: %d\n", frame_count);
    printf("  - sync packets: %d\n", sync_packet_count);
    printf("  Framerate: %d\n", enc->fps);
    printf("  Output size: %zu bytes\n", enc->total_output_bytes);
    
    // Calculate achieved bitrate
    double achieved_bitrate_kbps = (enc->total_output_bytes * 8.0) / 1000.0 / total_time;
    printf("  Achieved bitrate: %.1f kbps", achieved_bitrate_kbps);
    if (enc->bitrate_mode > 0) {
        printf(" (target: %d kbps, %.1f%%)", enc->target_bitrate_kbps, 
               (achieved_bitrate_kbps / enc->target_bitrate_kbps) * 100.0);
    }
    printf("\n");
    
    printf("  Encoding time: %.2fs (%.1f fps)\n", total_time, frame_count / total_time);
    printf("  Block statistics: INTRA=%d, INTER=%d, MOTION=%d, SKIP=%d\n",
           enc->blocks_intra, enc->blocks_inter, enc->blocks_motion, enc->blocks_skip);
    
    if (enc->bitrate_mode > 0) {
        printf("  Per-block complexity-based rate control: enabled\n");
    }
    
    cleanup_encoder(enc);
    return 0;
}