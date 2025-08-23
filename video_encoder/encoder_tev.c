// Created by Claude on 2025-08-18.
// TEV (TSVM Enhanced Video) Encoder - YCoCg-R 4:2:0 16x16 Block Version
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include <zlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <getopt.h>
#include <sys/time.h>

// TSVM Enhanced Video (TEV) format constants
#define TEV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x45\x56"  // "\x1FTSVM TEV"
#define TEV_VERSION 2  // Updated for YCoCg-R 4:2:0

// Block encoding modes (16x16 blocks)
#define TEV_MODE_SKIP      0x00  // Skip block (copy from reference)
#define TEV_MODE_INTRA     0x01  // Intra DCT coding (I-frame blocks)
#define TEV_MODE_INTER     0x02  // Inter DCT coding with motion compensation
#define TEV_MODE_MOTION    0x03  // Motion vector only (good prediction)

// Video packet types
#define TEV_PACKET_IFRAME      0x10  // Intra frame (keyframe)
#define TEV_PACKET_PFRAME      0x11  // Predicted frame  
#define TEV_PACKET_AUDIO_MP2   0x20  // MP2 audio
#define TEV_PACKET_SYNC        0xFF  // Sync packet

// Utility macros
static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}

static const int QUANT_MULT_Y[8] = {40, 20, 10, 8, 6, 5, 4, 1};
static const int QUANT_MULT_CO[8] = {40, 20, 10, 8, 6, 5, 4, 1};
static const int QUANT_MULT_CG[8] = {80, 40, 20, 16, 12, 10, 8, 2};

// Quality settings for quantization (Y channel) - 16x16 tables
static const uint32_t QUANT_TABLE_Y[256] =
    // Quality 7 (highest)
    {2, 1, 1, 2, 3, 5, 6, 7, 6, 7, 8, 9, 10, 11, 12, 13,
     1, 1, 1, 2, 3, 6, 7, 9, 7, 9, 10, 11, 12, 13, 14, 15,
     1, 1, 2, 3, 5, 6, 7, 9, 7, 9, 10, 11, 12, 13, 14, 15,
     1, 2, 3, 4, 6, 7, 9, 10, 9, 10, 11, 12, 13, 14, 15, 16,
     2, 3, 5, 6, 7, 9, 10, 11, 10, 11, 12, 13, 14, 15, 16, 17,
     3, 4, 6, 7, 9, 10, 11, 12, 11, 12, 13, 14, 15, 16, 17, 18,
     6, 6, 7, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 18, 19,
     6, 7, 9, 10, 11, 12, 13, 14, 13, 14, 15, 16, 17, 18, 19, 20,
     6, 7, 9, 10, 11, 12, 13, 14, 13, 14, 15, 16, 17, 18, 19, 20,
     7, 9, 10, 11, 12, 13, 14, 15, 14, 15, 16, 17, 18, 19, 20, 21,
     9, 10, 11, 12, 13, 14, 15, 16, 15, 16, 17, 18, 19, 20, 21, 22,
     10, 11, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 22, 23,
     11, 12, 13, 14, 15, 16, 17, 18, 17, 18, 19, 20, 21, 22, 23, 24,
     12, 13, 14, 15, 16, 17, 18, 19, 18, 19, 20, 21, 22, 23, 24, 25,
     13, 14, 15, 16, 17, 18, 19, 20, 19, 20, 21, 22, 23, 24, 25, 26,
     14, 15, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 26, 27};

// Quality settings for quantization (Co channel - 8x8)
static const uint32_t QUANT_TABLE_C[64] =
    {2, 3, 4, 6, 8, 12, 16, 20,
     3, 4, 6, 8, 12, 16, 20, 24,
     4, 6, 8, 12, 16, 20, 24, 28,
     6, 8, 12, 16, 20, 24, 28, 32,
     8, 12, 16, 20, 24, 28, 32, 36,
     12, 16, 20, 24, 28, 32, 36, 40,
     16, 20, 24, 28, 32, 36, 40, 44,
     20, 24, 28, 32, 36, 40, 44, 48};


// Audio constants (reuse MP2 from existing system)
#define MP2_SAMPLE_RATE 32000
#define MP2_DEFAULT_PACKET_SIZE 0x240

// Encoding parameters
#define MAX_MOTION_SEARCH 8
int KEYFRAME_INTERVAL = 60;
#define BLOCK_SIZE 16  // 16x16 blocks now

// Default values
#define DEFAULT_WIDTH 560
#define DEFAULT_HEIGHT 448
#define TEMP_AUDIO_FILE "/tmp/tev_temp_audio.mp2"

typedef struct __attribute__((packed)) {
    uint8_t mode;           // Block encoding mode
    int16_t mv_x, mv_y;     // Motion vector (1/4 pixel precision)
    uint16_t cbp;           // Coded block pattern (which channels have non-zero coeffs)
    int16_t y_coeffs[256];  // Quantized Y DCT coefficients (16x16)
    int16_t co_coeffs[64];  // Quantized Co DCT coefficients (8x8)
    int16_t cg_coeffs[64];  // Quantized Cg DCT coefficients (8x8)
} tev_block_t;

typedef struct {
    char *input_file;
    char *output_file;
    int width;
    int height;
    int fps;
    int output_fps;  // User-specified output FPS (for frame rate conversion)
    int total_frames;
    double duration;
    int has_audio;
    int output_to_stdout;
    int quality;  // 0-7, higher = better quality
    int verbose;
    
    // Frame buffers (8-bit RGB format for encoding)
    uint8_t *current_rgb, *previous_rgb, *reference_rgb;
    
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
    int audio_frames_in_buffer;
    int target_audio_buffer_size;
    
    // Compression context
    z_stream gzip_stream;
    
    // FFmpeg processes
    FILE *ffmpeg_video_pipe;
    
    // Progress tracking
    struct timeval start_time;
    size_t total_output_bytes;
    
    // Statistics
    int blocks_skip, blocks_intra, blocks_inter, blocks_motion;
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
static float temp_dct_16[256]; // Reusable temporary buffer

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

// Legacy O(n^4) version for reference/fallback
static void dct_16x16(float *input, float *output) {
    init_dct_tables(); // Ensure tables are initialized

    for (int u = 0; u < 16; u++) {
        for (int v = 0; v < 16; v++) {
            float sum = 0.0f;
            float cu = (u == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;
            float cv = (v == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;

            for (int x = 0; x < 16; x++) {
                for (int y = 0; y < 16; y++) {
                    sum += input[y * 16 + x] *
                           dct_table_16[u][x] *
                           dct_table_16[v][y];
                }
            }

            output[u * 16 + v] = 0.25f * cu * cv * sum;
        }
    }
}

// Fast separable 8x8 DCT - 4x performance improvement  
static float temp_dct_8[64]; // Reusable temporary buffer

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

// Legacy 8x8 2D DCT (for chroma) - O(n^4) version
static void dct_8x8(float *input, float *output) {
    init_dct_tables(); // Ensure tables are initialized

    for (int u = 0; u < 8; u++) {
        for (int v = 0; v < 8; v++) {
            float sum = 0.0f;
            float cu = (u == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;
            float cv = (v == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;

            for (int x = 0; x < 8; x++) {
                for (int y = 0; y < 8; y++) {
                    sum += input[y * 8 + x] *
                           dct_table_8[u][x] *
                           dct_table_8[v][y];
                }
            }

            output[u * 8 + v] = 0.25f * cu * cv * sum;
        }
    }
}

// Quantize DCT coefficient using quality table
static int16_t quantize_coeff(float coeff, uint8_t quant, int is_dc, int is_chroma) {
    if (is_dc) {
        if (is_chroma) {
            // Chroma DC: range -256 to +255, use lossless quantization for testing
            return (int16_t)roundf(coeff);
        } else {
            // Luma DC: range -128 to +127, use lossless quantization for testing
            return (int16_t)roundf(coeff);
        }
    } else {
        // AC coefficients use quality table
        return (int16_t)roundf(coeff / quant);
    }
}

// Extract 16x16 block from RGB frame and convert to YCoCg-R
static void extract_ycocgr_block(uint8_t *rgb_frame, int width, int height,
                                int block_x, int block_y,
                                float *y_block, float *co_block, float *cg_block) {
    int start_x = block_x * 16;
    int start_y = block_y * 16;
    
    // Extract 16x16 Y block
    for (int py = 0; py < 16; py++) {
        for (int px = 0; px < 16; px++) {
            int x = start_x + px;
            int y = start_y + py;
            
            if (x < width && y < height) {
                int offset = (y * width + x) * 3;
                uint8_t r = rgb_frame[offset];
                uint8_t g = rgb_frame[offset + 1];
                uint8_t b = rgb_frame[offset + 2];
                
                int y_val, co_val, cg_val;
                rgb_to_ycocgr(r, g, b, &y_val, &co_val, &cg_val);
                
                y_block[py * 16 + px] = (float)y_val - 128.0f;  // Center around 0
            }
        }
    }
    
    // Extract 8x8 chroma blocks with 4:2:0 subsampling (average 2x2 pixels)
    for (int py = 0; py < 8; py++) {
        for (int px = 0; px < 8; px++) {
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
                co_block[py * 8 + px] = (float)(co_sum / count);
                cg_block[py * 8 + px] = (float)(cg_sum / count);
            }
        }
    }
}

// Simple motion estimation (full search) for 16x16 blocks
static void estimate_motion(tev_encoder_t *enc, int block_x, int block_y, 
                           int16_t *best_mv_x, int16_t *best_mv_y) {
    int best_sad = INT_MAX;
    *best_mv_x = 0;
    *best_mv_y = 0;
    
    int start_x = block_x * 16;
    int start_y = block_y * 16;
    
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
                ref_x + 16 > enc->width || ref_y + 16 > enc->height) {
                continue;
            }

            // Fast SAD using integer luma approximation
            int sad = 0;
            for (int dy = 0; dy < 16; dy += 2) {  // Sample every 2nd row for speed
                uint8_t *cur_row = &enc->current_rgb[((start_y + dy) * enc->width + start_x) * 3];
                uint8_t *ref_row = &enc->previous_rgb[((ref_y + dy) * enc->width + ref_x) * 3];

                for (int dx = 0; dx < 16; dx += 2) {  // Sample every 2nd pixel
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
    for (int py = 0; py < 16; py++) {
        for (int px = 0; px < 16; px++) {
            int rgb_idx = (py * 16 + px) * 3;
            int r = rgb_block[rgb_idx];
            int g = rgb_block[rgb_idx + 1];
            int b = rgb_block[rgb_idx + 2];
            
            // YCoCg-R transform (per specification with truncated division)
            int y = (r + 2*g + b) / 4;
            
            y_block[py * 16 + px] = CLAMP(y, 0, 255);
        }
    }
    
    // Convert to Co and Cg with 4:2:0 subsampling (8x8)
    for (int cy = 0; cy < 8; cy++) {
        for (int cx = 0; cx < 8; cx++) {
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
            co_block[cy * 8 + cx] = CLAMP(sum_co / 4, -256, 255);
            cg_block[cy * 8 + cx] = CLAMP(sum_cg / 4, -256, 255);
        }
    }
}

// Extract motion-compensated YCoCg-R block from reference frame
static void extract_motion_compensated_block(const uint8_t *rgb_data, int width, int height,
                                           int block_x, int block_y, int mv_x, int mv_y,
                                           uint8_t *y_block, int8_t *co_block, int8_t *cg_block) {
    // Extract 16x16 RGB block with motion compensation
    uint8_t rgb_block[16 * 16 * 3];
    
    for (int dy = 0; dy < 16; dy++) {
        for (int dx = 0; dx < 16; dx++) {
            int cur_x = block_x + dx;
            int cur_y = block_y + dy;
            int ref_x = cur_x + mv_x;  // Revert to original motion compensation
            int ref_y = cur_y + mv_y;
            
            int rgb_idx = (dy * 16 + dx) * 3;
            
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
    int start_x = block_x * 16;
    int start_y = block_y * 16;
    
    // Extract motion-compensated reference block from previous frame
    uint8_t ref_y[256];
    int8_t ref_co[64], ref_cg[64];
    extract_motion_compensated_block(enc->previous_rgb, enc->width, enc->height,
                                   start_x, start_y, mv_x, mv_y, 
                                   ref_y, ref_co, ref_cg);
    
    // Compute residuals: current - motion_compensated_reference
    // Current is already centered (-128 to +127), reference is 0-255, so subtract and center reference
    for (int i = 0; i < 256; i++) {
        float ref_y_centered = (float)ref_y[i] - 128.0f;  // Center reference to match current
        enc->y_workspace[i] = enc->y_workspace[i] - ref_y_centered;
    }
    
    // Chroma residuals (already centered in both current and reference)
    for (int i = 0; i < 64; i++) {
        enc->co_workspace[i] = enc->co_workspace[i] - (float)ref_co[i];
        enc->cg_workspace[i] = enc->cg_workspace[i] - (float)ref_cg[i];
    }
}

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
        enc->blocks_intra++;
    } else {
        // Implement proper mode decision for P-frames
        int start_x = block_x * 16;
        int start_y = block_y * 16;
        
        // Calculate SAD for skip mode (no motion compensation)
        int skip_sad = 0;
        for (int dy = 0; dy < 16; dy++) {
            for (int dx = 0; dx < 16; dx++) {
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
                }
            }
        }
        
        // Try motion estimation
        estimate_motion(enc, block_x, block_y, &block->mv_x, &block->mv_y);
        
        // Calculate motion compensation SAD
        int motion_sad = INT_MAX;
        if (abs(block->mv_x) > 0 || abs(block->mv_y) > 0) {
            motion_sad = 0;
            for (int dy = 0; dy < 16; dy++) {
                for (int dx = 0; dx < 16; dx++) {
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
        if (skip_sad <= 64) {
            // Very small difference - skip block (copy from previous frame)
            block->mode = TEV_MODE_SKIP;
            block->mv_x = 0;
            block->mv_y = 0;
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
            block->cbp = 0x00;  // No coefficients present
            // Zero out DCT coefficients for consistent format  
            memset(block->y_coeffs, 0, sizeof(block->y_coeffs));
            memset(block->co_coeffs, 0, sizeof(block->co_coeffs));
            memset(block->cg_coeffs, 0, sizeof(block->cg_coeffs));
            enc->blocks_motion++;
            return; // Skip DCT encoding, just store motion vector
        // disabling INTER mode: residual DCT is crapping out no matter what I do
        /*} else if (motion_sad < skip_sad && (abs(block->mv_x) > 0 || abs(block->mv_y) > 0)) {
            // Motion compensation with threshold
            if (motion_sad <= 1024) {
                block->mode = TEV_MODE_MOTION;
                block->cbp = 0x00;  // No coefficients present
                memset(block->y_coeffs, 0, sizeof(block->y_coeffs));
                memset(block->co_coeffs, 0, sizeof(block->co_coeffs));
                memset(block->cg_coeffs, 0, sizeof(block->cg_coeffs));
                enc->blocks_motion++;
                return; // Skip DCT encoding, just store motion vector
            }
            
            // Use INTER mode with motion vector and residuals
            if (abs(block->mv_x) <= 24 && abs(block->mv_y) <= 24) {
                block->mode = TEV_MODE_INTER;
                enc->blocks_inter++;
            } else {
                // Motion vector too large, fall back to INTRA
                block->mode = TEV_MODE_INTRA;
                block->mv_x = 0;
                block->mv_y = 0;
                enc->blocks_intra++;
                return;
            }*/
        } else {
            // No good motion prediction - use intra mode
            block->mode = TEV_MODE_INTRA;
            block->mv_x = 0;
            block->mv_y = 0;
            enc->blocks_intra++;
        }
    }
    
    // Apply fast DCT transform
    dct_16x16_fast(enc->y_workspace, enc->dct_workspace);
    
    // Quantize Y coefficients (luma)
    const uint32_t *y_quant = QUANT_TABLE_Y;
    const uint32_t qmult_y = QUANT_MULT_Y[enc->quality];
    for (int i = 0; i < 256; i++) {
        block->y_coeffs[i] = quantize_coeff(enc->dct_workspace[i], y_quant[i] * qmult_y, i == 0, 0);
    }
    
    // Apply fast DCT transform to chroma
    dct_8x8_fast(enc->co_workspace, enc->dct_workspace);
    
    // Quantize Co coefficients (chroma - orange-blue)
    const uint32_t *co_quant = QUANT_TABLE_C;
    const uint32_t qmult_co = QUANT_MULT_CO[enc->quality];
    for (int i = 0; i < 64; i++) {
        block->co_coeffs[i] = quantize_coeff(enc->dct_workspace[i], co_quant[i] * qmult_co, i == 0, 1);
    }
    
    // Apply fast DCT transform to Cg
    dct_8x8_fast(enc->cg_workspace, enc->dct_workspace);
    
    // Quantize Cg coefficients (chroma - green-magenta, qmult_cg is more aggressive like NTSC Q)
    const uint32_t *cg_quant = QUANT_TABLE_C;
    const uint32_t qmult_cg = QUANT_MULT_CG[enc->quality];
    for (int i = 0; i < 64; i++) {
        block->cg_coeffs[i] = quantize_coeff(enc->dct_workspace[i], cg_quant[i] * qmult_cg, i == 0, 1);
    }
    
    // Set CBP (simplified - always encode all channels)
    block->cbp = 0x07;  // Y, Co, Cg all present
}

// Initialize encoder
static tev_encoder_t* init_encoder(void) {
    tev_encoder_t *enc = calloc(1, sizeof(tev_encoder_t));
    if (!enc) return NULL;
    
    enc->quality = 4;  // Default quality
    enc->mp2_packet_size = 0; // Will be detected from MP2 header
    enc->mp2_rate_index = 0;
    enc->audio_frames_in_buffer = 0;
    enc->target_audio_buffer_size = 4;

    init_dct_tables();

    return enc;
}

// Allocate encoder buffers
static int alloc_encoder_buffers(tev_encoder_t *enc) {
    int pixels = enc->width * enc->height;
    int blocks_x = (enc->width + 15) / 16;
    int blocks_y = (enc->height + 15) / 16;
    int total_blocks = blocks_x * blocks_y;
    
    enc->current_rgb = malloc(pixels * 3);
    enc->previous_rgb = malloc(pixels * 3);
    enc->reference_rgb = malloc(pixels * 3);
    
    enc->y_workspace = malloc(16 * 16 * sizeof(float));
    enc->co_workspace = malloc(8 * 8 * sizeof(float));
    enc->cg_workspace = malloc(8 * 8 * sizeof(float));
    enc->dct_workspace = malloc(16 * 16 * sizeof(float));
    
    enc->block_data = malloc(total_blocks * sizeof(tev_block_t));
    enc->compressed_buffer = malloc(total_blocks * sizeof(tev_block_t) * 2);
    enc->mp2_buffer = malloc(MP2_DEFAULT_PACKET_SIZE);
    
    if (!enc->current_rgb || !enc->previous_rgb || !enc->reference_rgb ||
        !enc->y_workspace || !enc->co_workspace || !enc->cg_workspace ||
        !enc->dct_workspace || !enc->block_data || 
        !enc->compressed_buffer || !enc->mp2_buffer) {
        return -1;
    }
    
    // Initialize gzip compression stream
    enc->gzip_stream.zalloc = Z_NULL;
    enc->gzip_stream.zfree = Z_NULL;
    enc->gzip_stream.opaque = Z_NULL;
    
    int gzip_init_result = deflateInit2(&enc->gzip_stream, Z_DEFAULT_COMPRESSION, 
                                       Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY); // 15+16 for gzip format
    
    if (gzip_init_result != Z_OK) {
        fprintf(stderr, "Failed to initialize gzip compression\n");
        return 0;
    }
    
    // Initialize previous frame to black
    memset(enc->previous_rgb, 0, pixels * 3);
    
    return 1;
}

// Free encoder resources
static void free_encoder(tev_encoder_t *enc) {
    if (!enc) return;
    
    deflateEnd(&enc->gzip_stream);
    
    free(enc->current_rgb);
    free(enc->previous_rgb);
    free(enc->reference_rgb);
    free(enc->y_workspace);
    free(enc->co_workspace);
    free(enc->cg_workspace);
    free(enc->dct_workspace);
    free(enc->block_data);
    free(enc->compressed_buffer);
    free(enc->mp2_buffer);
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
    uint16_t height = enc->height;
    uint8_t fps = enc->fps;
    uint32_t total_frames = enc->total_frames;
    uint8_t quality = enc->quality;
    uint8_t has_audio = enc->has_audio;
    
    fwrite(&width, 2, 1, output);
    fwrite(&height, 2, 1, output);
    fwrite(&fps, 1, 1, output);
    fwrite(&total_frames, 4, 1, output);
    fwrite(&quality, 1, 1, output);
    fwrite(&has_audio, 1, 1, output);
    
    return 0;
}

// Encode and write a frame
static int encode_frame(tev_encoder_t *enc, FILE *output, int frame_num) {
    int is_keyframe = (frame_num % KEYFRAME_INTERVAL) == 0;
    int blocks_x = (enc->width + 15) / 16;
    int blocks_y = (enc->height + 15) / 16;
    
    // Encode all blocks
    for (int by = 0; by < blocks_y; by++) {
        for (int bx = 0; bx < blocks_x; bx++) {
            encode_block(enc, bx, by, is_keyframe);
        }
    }
    
    // Compress block data using gzip (compatible with TSVM decoder)
    size_t block_data_size = blocks_x * blocks_y * sizeof(tev_block_t);
    
    // Initialize fresh gzip stream for each frame (since Z_FINISH terminates the stream)
    z_stream frame_stream;
    frame_stream.zalloc = Z_NULL;
    frame_stream.zfree = Z_NULL;
    frame_stream.opaque = Z_NULL;
    
    int init_result = deflateInit2(&frame_stream, Z_DEFAULT_COMPRESSION, 
                                   Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY); // 15+16 for gzip format
    
    if (init_result != Z_OK) {
        fprintf(stderr, "Failed to initialize gzip compression for frame\n");
        return 0;
    }
    
    // Set up compression stream
    frame_stream.next_in = (Bytef*)enc->block_data;
    frame_stream.avail_in = block_data_size;
    frame_stream.next_out = (Bytef*)enc->compressed_buffer;
    frame_stream.avail_out = block_data_size * 2;
    
    int result = deflate(&frame_stream, Z_FINISH);
    if (result != Z_STREAM_END) {
        fprintf(stderr, "Gzip compression failed: %d\n", result);
        deflateEnd(&frame_stream);
        return 0;
    }
    
    size_t compressed_size = frame_stream.total_out;
    
    // Clean up frame stream
    deflateEnd(&frame_stream);
    
    // Write frame packet header
    uint8_t packet_type = is_keyframe ? TEV_PACKET_IFRAME : TEV_PACKET_PFRAME;
    uint32_t payload_size = compressed_size;
    
    fwrite(&packet_type, 1, 1, output);
    fwrite(&payload_size, 4, 1, output);
    fwrite(enc->compressed_buffer, 1, compressed_size, output);
    
    enc->total_output_bytes += 5 + compressed_size;

    // Swap frame buffers for next frame
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
    size_t len = fread(result, 1, 4095, pipe);
    result[len] = '\0';
    
    pclose(pipe);
    return result;
}

// Get video metadata using ffprobe
static int get_video_metadata(tev_encoder_t *enc) {
    char command[1024];
    char *output;
    
    // Get frame count
    snprintf(command, sizeof(command), 
        "ffprobe -v quiet -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 \"%s\"", 
        enc->input_file);
    output = execute_command(command);
    if (!output) {
        fprintf(stderr, "Failed to get frame count\n");
        return 0;
    }
    enc->total_frames = atoi(output);
    free(output);
    
    // Get original frame rate (will be converted if user specified different FPS)
    snprintf(command, sizeof(command),
        "ffprobe -v quiet -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 \"%s\"",
        enc->input_file);
    output = execute_command(command);
    if (!output) {
        fprintf(stderr, "Failed to get frame rate\n");
        return 0;
    }
    
    int num, den;
    if (sscanf(output, "%d/%d", &num, &den) == 2) {
        enc->fps = (den > 0) ? (int)round((float)num/(float)den) : 30;
    } else {
        enc->fps = (int)round(atof(output));
    }
    free(output);
    
    // If user specified output FPS, calculate new total frames for conversion
    if (enc->output_fps > 0 && enc->output_fps != enc->fps) {
        // Calculate duration and new frame count
        snprintf(command, sizeof(command),
            "ffprobe -v quiet -show_entries format=duration -of csv=p=0 \"%s\"",
            enc->input_file);
        output = execute_command(command);
        if (output) {
            enc->duration = atof(output);
            free(output);
            // Update total frames for new frame rate
            enc->total_frames = (int)(enc->duration * enc->output_fps);
            if (enc->verbose) {
                printf("Frame rate conversion: %d fps -> %d fps\n", enc->fps, enc->output_fps);
                printf("Original frames: %d, Output frames: %d\n", 
                       (int)(enc->duration * enc->fps), enc->total_frames);
            }
            enc->fps = enc->output_fps;  // Use output FPS for encoding
        }
    }

    // set keyframe interval
    KEYFRAME_INTERVAL = 2 * enc->fps;
    
    // Check for audio stream
    snprintf(command, sizeof(command),
        "ffprobe -v quiet -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 \"%s\" 2>/dev/null",
        enc->input_file);
    output = execute_command(command);
    enc->has_audio = (output && strstr(output, "audio"));
    if (output) free(output);
    
    if (enc->verbose) {
        fprintf(stderr, "Video metadata:\n");
        fprintf(stderr, "  Frames: %d\n", enc->total_frames);
        fprintf(stderr, "  FPS: %d\n", enc->fps);
        fprintf(stderr, "  Audio: %s\n", enc->has_audio ? "Yes" : "No");
        fprintf(stderr, "  Resolution: %dx%d\n", enc->width, enc->height);
    }
    
    return (enc->total_frames > 0 && enc->fps > 0);
}

// Start FFmpeg process for video conversion with frame rate support
static int start_video_conversion(tev_encoder_t *enc) {
    char command[2048];
    
    // Build FFmpeg command with potential frame rate conversion
    if (enc->output_fps > 0 && enc->output_fps != enc->fps) {
        // Frame rate conversion requested
        snprintf(command, sizeof(command),
            "ffmpeg -v quiet -i \"%s\" -f rawvideo -pix_fmt rgb24 "
            "-vf \"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,fps=%d\" "
            "-y - 2>&1",
            enc->input_file, enc->width, enc->height, enc->width, enc->height, enc->output_fps);
    } else {
        // No frame rate conversion
        snprintf(command, sizeof(command),
            "ffmpeg -v quiet -i \"%s\" -f rawvideo -pix_fmt rgb24 "
            "-vf \"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d\" "
            "-y -",
            enc->input_file, enc->width, enc->height, enc->width, enc->height);
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
        "ffmpeg -v quiet -i \"%s\" -acodec libtwolame -psymodel 4 -b:a 192k -ar %d -ac 2 -y \"%s\" 2>/dev/null",
        enc->input_file, MP2_SAMPLE_RATE, TEMP_AUDIO_FILE);
    
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
    
    // Only insert audio when buffer would go below 2 frames
    // Initialize with 2 packets on first frame to prime the buffer
    int packets_to_insert = 0;
    if (frame_num == 0) {
        packets_to_insert = 2;
        enc->audio_frames_in_buffer = 2;
    } else {
        // Simulate buffer consumption (packets consumed per frame)
        enc->audio_frames_in_buffer -= (int)ceil(packets_per_frame);
        
        // Only insert packets when buffer gets low (≤ 2 frames)
        if (enc->audio_frames_in_buffer <= 2) {
            packets_to_insert = enc->target_audio_buffer_size - enc->audio_frames_in_buffer;
            packets_to_insert = (packets_to_insert > 0) ? packets_to_insert : 1;
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
        
        if (enc->verbose) {
            printf("Audio packet %d: %zu bytes\n", q, bytes_read);
        }
    }
    
    return 1;
}

// Show usage information
static void show_usage(const char *program_name) {
    printf("TEV YCoCg-R 4:2:0 Video Encoder\n");
    printf("Usage: %s [options] -i input.mp4 -o output.tev\n\n", program_name);
    printf("Options:\n");
    printf("  -i, --input FILE     Input video file\n");
    printf("  -o, --output FILE    Output TEV file (use '-' for stdout)\n");
    printf("  -w, --width N        Video width (default: %d)\n", DEFAULT_WIDTH);
    printf("  -h, --height N       Video height (default: %d)\n", DEFAULT_HEIGHT);
    printf("  -f, --fps N          Output frames per second (enables frame rate conversion)\n");
    printf("  -q, --quality N      Quality level 0-7 (default: 4)\n");
    printf("  -v, --verbose        Verbose output\n");
    printf("  -t, --test           Test mode: generate solid color frames\n");
    printf("  --help               Show this help\n\n");
    printf("Features:\n");
    printf("  - YCoCg-R 4:2:0 chroma subsampling for 50%% compression improvement\n");
    printf("  - 16x16 Y blocks with 8x8 chroma for optimal DCT efficiency\n");
    printf("  - Frame rate conversion with FFmpeg temporal filtering\n");
    printf("  - Hardware-accelerated decoding functions\n\n");
    printf("Examples:\n");
    printf("  %s -i input.mp4 -o output.tev\n", program_name);
    printf("  %s -i input.avi -f 15 -q 7 -o output.tev  # Convert 25fps to 15fps\n", program_name);
    printf("  %s --test -o test.tev  # Generate solid color test frames\n", program_name);
}


// Cleanup encoder resources
static void cleanup_encoder(tev_encoder_t *enc) {
    if (!enc) return;
    
    if (enc->ffmpeg_video_pipe) pclose(enc->ffmpeg_video_pipe);
    if (enc->mp2_file) {
        fclose(enc->mp2_file);
        unlink(TEMP_AUDIO_FILE); // Remove temporary audio file
    }
    
    free_encoder(enc);
}

int sync_packet_count = 0;

// Main function
int main(int argc, char *argv[]) {
    tev_encoder_t *enc = init_encoder();
    if (!enc) {
        fprintf(stderr, "Failed to initialize encoder\n");
        return 1;
    }
    
    // Set defaults
    enc->width = DEFAULT_WIDTH;
    enc->height = DEFAULT_HEIGHT;
    enc->fps = 0;  // Will be detected from input
    enc->output_fps = 0;  // No frame rate conversion by default
    enc->quality = 4;
    enc->verbose = 0;
    int test_mode = 0;
    
    static struct option long_options[] = {
        {"input", required_argument, 0, 'i'},
        {"output", required_argument, 0, 'o'},
        {"width", required_argument, 0, 'w'},
        {"height", required_argument, 0, 'h'},
        {"fps", required_argument, 0, 'f'},
        {"quality", required_argument, 0, 'q'},
        {"verbose", no_argument, 0, 'v'},
        {"test", no_argument, 0, 't'},
        {"help", no_argument, 0, 0},
        {0, 0, 0, 0}
    };
    
    int option_index = 0;
    int c;
    
    while ((c = getopt_long(argc, argv, "i:o:w:h:f:q:vt", long_options, &option_index)) != -1) {
        switch (c) {
            case 'i':
                enc->input_file = strdup(optarg);
                break;
            case 'o':
                enc->output_file = strdup(optarg);
                enc->output_to_stdout = (strcmp(optarg, "-") == 0);
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
                enc->quality = atoi(optarg);
                if (enc->quality < 0) enc->quality = 0;
                if (enc->quality > 7) enc->quality = 7;
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
            default:
                show_usage(argv[0]);
                cleanup_encoder(enc);
                return 1;
        }
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
        // Test mode: generate solid color frames
        enc->fps = 1;
        enc->total_frames = 15;
        enc->has_audio = 0;
        printf("Test mode: Generating 15 solid color frames\n");
    } else {
        // Get video metadata and start FFmpeg processes
        if (!get_video_metadata(enc)) {
            fprintf(stderr, "Failed to get video metadata\n");
            cleanup_encoder(enc);
            return 1;
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
    
    // Process frames
    int frame_count = 0;
    while (frame_count < enc->total_frames) {
        if (test_mode) {
            // Generate test frame with solid colors
            size_t rgb_size = enc->width * enc->height * 3;
            uint8_t test_r = 0, test_g = 0, test_b = 0;
            const char* color_name = "unknown";
            
            switch (frame_count) {
                case 0: test_r = 0; test_g = 0; test_b = 0; color_name = "black"; break;
                case 1: test_r = 127; test_g = 127; test_b = 127; color_name = "grey"; break;
                case 2: test_r = 255; test_g = 255; test_b = 255; color_name = "white"; break;
                case 3: test_r = 127; test_g = 0; test_b = 0; color_name = "half red"; break;
                case 4: test_r = 127; test_g = 127; test_b = 0; color_name = "half yellow"; break;
                case 5: test_r = 0; test_g = 127; test_b = 0; color_name = "half green"; break;
                case 6: test_r = 0; test_g = 127; test_b = 127; color_name = "half cyan"; break;
                case 7: test_r = 0; test_g = 0; test_b = 127; color_name = "half blue"; break;
                case 8: test_r = 127; test_g = 0; test_b = 127; color_name = "half magenta"; break;
                case 9: test_r = 255; test_g = 0; test_b = 0; color_name = "red"; break;
                case 10: test_r = 255; test_g = 255; test_b = 0; color_name = "yellow"; break;
                case 11: test_r = 0; test_g = 255; test_b = 0; color_name = "green"; break;
                case 12: test_r = 0; test_g = 255; test_b = 255; color_name = "cyan"; break;
                case 13: test_r = 0; test_g = 0; test_b = 255; color_name = "blue"; break;
                case 14: test_r = 255; test_g = 0; test_b = 255; color_name = "magenta"; break;
            }
            
            // Fill entire frame with solid color
            for (size_t i = 0; i < rgb_size; i += 3) {
                enc->current_rgb[i] = test_r;
                enc->current_rgb[i + 1] = test_g;
                enc->current_rgb[i + 2] = test_b;
            }
            
            printf("Frame %d: %s (%d,%d,%d)\n", frame_count, color_name, test_r, test_g, test_b);
            
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
            size_t rgb_size = enc->width * enc->height * 3;
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
        }

        // Process audio for this frame
        process_audio(enc, frame_count, output);

        // Encode frame
        if (!encode_frame(enc, output, frame_count)) {
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
    printf("  Encoding time: %.2fs (%.1f fps)\n", total_time, frame_count / total_time);
    printf("  Block statistics: INTRA=%d, INTER=%d, MOTION=%d, SKIP=%d\n",
           enc->blocks_intra, enc->blocks_inter, enc->blocks_motion, enc->blocks_skip);
    
    cleanup_encoder(enc);
    return 0;
}