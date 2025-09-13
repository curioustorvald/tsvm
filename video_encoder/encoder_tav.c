// Created by Claude on 2025-09-13.
// TAV (TSVM Advanced Video) Encoder - DWT-based compression with full resolution YCoCg-R
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

// Float16 conversion functions (same as TEV)
static inline uint16_t float_to_float16(float fval) {
    uint32_t fbits = *(uint32_t*)&fval;
    uint16_t sign = (fbits >> 16) & 0x8000;
    uint32_t val = (fbits & 0x7fffffff) + 0x1000;

    if (val >= 0x47800000) {
        if ((fbits & 0x7fffffff) >= 0x47800000) {
            if (val < 0x7f800000)
                return sign | 0x7c00;
            return sign | 0x7c00 | ((fbits & 0x007fffff) >> 13);
        }
        return sign | 0x7bff;
    }
    if (val >= 0x38800000)
        return sign | ((val - 0x38000000) >> 13);
    if (val < 0x33000000)
        return sign;
    val = (fbits & 0x7fffffff) >> 23;

    return sign | (((fbits & 0x7fffff) | 0x800000) +
                   (0x800000 >> (val - 102))
                  ) >> (126 - val);
}

static inline float float16_to_float(uint16_t hbits) {
    uint32_t mant = hbits & 0x03ff;
    uint32_t exp = hbits & 0x7c00;
    
    if (exp == 0x7c00)
        exp = 0x3fc00;
    else if (exp != 0) {
        exp += 0x1c000;
        if (mant == 0 && exp > 0x1c400) {
            uint32_t fbits = ((hbits & 0x8000) << 16) | (exp << 13) | 0x3ff;
            return *(float*)&fbits;
        }
    }
    else if (mant != 0) {
        exp = 0x1c400;
        do {
            mant <<= 1;
            exp -= 0x400;
        } while ((mant & 0x400) == 0);
        mant &= 0x3ff;
    }
    
    uint32_t fbits = ((hbits & 0x8000) << 16) | ((exp | mant) << 13);
    return *(float*)&fbits;
}

// TSVM Advanced Video (TAV) format constants
#define TAV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x56"  // "\x1FTSVM TAV"
#define TAV_VERSION 1  // Initial DWT implementation

// Tile encoding modes (64x64 tiles)
#define TAV_MODE_SKIP      0x00  // Skip tile (copy from reference)
#define TAV_MODE_INTRA     0x01  // Intra DWT coding (I-frame tiles)
#define TAV_MODE_INTER     0x02  // Inter DWT coding with motion compensation
#define TAV_MODE_MOTION    0x03  // Motion vector only (good prediction)

// Video packet types
#define TAV_PACKET_IFRAME      0x10  // Intra frame (keyframe)
#define TAV_PACKET_PFRAME      0x11  // Predicted frame  
#define TAV_PACKET_AUDIO_MP2   0x20  // MP2 audio
#define TAV_PACKET_SUBTITLE    0x30  // Subtitle packet
#define TAV_PACKET_SYNC        0xFF  // Sync packet

// DWT settings
#define TILE_SIZE 64
#define MAX_DECOMP_LEVELS 4
#define DEFAULT_DECOMP_LEVELS 3

// Wavelet filter types
#define WAVELET_5_3_REVERSIBLE 0  // Lossless capable
#define WAVELET_9_7_IRREVERSIBLE 1  // Higher compression

// Default settings
#define DEFAULT_WIDTH 560
#define DEFAULT_HEIGHT 448
#define DEFAULT_FPS 30
#define DEFAULT_QUALITY 2

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


// Utility macros
static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}
static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

// MP2 audio rate table (same as TEV)
static const int MP2_RATE_TABLE[] = {128, 160, 224, 320, 384, 384};

// Quality level to quantization mapping for different channels
static const int QUALITY_Y[] = {90, 70, 50, 30, 15, 5};      // Luma (fine)
static const int QUALITY_CO[] = {80, 60, 40, 20, 10, 3};     // Chroma Co (aggressive)
static const int QUALITY_CG[] = {70, 50, 30, 15, 8, 2};      // Chroma Cg (very aggressive)

// DWT coefficient structure for each subband
typedef struct {
    int16_t *coeffs;
    int width, height;
    int size;
} dwt_subband_t;

// DWT tile structure
typedef struct {
    dwt_subband_t *ll, *lh, *hl, *hh;  // Subbands for each level
    int decomp_levels;
    int tile_x, tile_y;
} dwt_tile_t;

// Motion vector structure
typedef struct {
    int16_t mv_x, mv_y;  // 1/4 pixel precision
    float rate_control_factor;
} motion_vector_t;

// TAV encoder structure
typedef struct {
    // Input/output files
    char *input_file;
    char *output_file;
    char *subtitle_file;
    FILE *output_fp;
    FILE *mp2_file;
    FILE *ffmpeg_video_pipe;
    
    // Video parameters
    int width, height;
    int fps;
    int total_frames;
    int frame_count;
    
    // Encoding parameters
    int quality_level;
    int quantizer_y, quantizer_co, quantizer_cg;
    int wavelet_filter;
    int decomp_levels;
    int bitrate_mode;
    int target_bitrate;
    
    // Flags
    int progressive;
    int lossless;
    int enable_rcf;
    int enable_progressive_transmission;
    int enable_roi;
    int verbose;
    int test_mode;
    
    // Frame buffers
    uint8_t *current_frame_rgb;
    uint8_t *previous_frame_rgb;
    float *current_frame_y, *current_frame_co, *current_frame_cg;
    float *previous_frame_y, *previous_frame_co, *previous_frame_cg;
    
    // Tile processing
    int tiles_x, tiles_y;
    dwt_tile_t *tiles;
    motion_vector_t *motion_vectors;
    
    // Compression
    ZSTD_CCtx *zstd_ctx;
    void *compressed_buffer;
    size_t compressed_buffer_size;
    
    // Statistics
    size_t total_compressed_size;
    size_t total_uncompressed_size;
    
} tav_encoder_t;

// 5/3 Wavelet filter coefficients (reversible)
static const float WAVELET_5_3_LP[] = {0.5f, 1.0f, 0.5f};
static const float WAVELET_5_3_HP[] = {-0.125f, -0.25f, 0.75f, -0.25f, -0.125f};

// 9/7 Wavelet filter coefficients (irreversible - Daubechies)
static const float WAVELET_9_7_LP[] = {
    0.037828455507f, -0.023849465020f, -0.110624404418f, 0.377402855613f,
    0.852698679009f, 0.377402855613f, -0.110624404418f, -0.023849465020f, 0.037828455507f
};
static const float WAVELET_9_7_HP[] = {
    0.064538882629f, -0.040689417609f, -0.418092273222f, 0.788485616406f,
    -0.418092273222f, -0.040689417609f, 0.064538882629f
};

// Function prototypes
static void show_usage(const char *program_name);
static tav_encoder_t* create_encoder(void);
static void cleanup_encoder(tav_encoder_t *enc);
static int initialize_encoder(tav_encoder_t *enc);
static int encode_frame(tav_encoder_t *enc, int frame_num, int is_keyframe);
static void rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height);
static void dwt_2d_forward(float *tile_data, int levels, int filter_type);
static void dwt_2d_inverse(dwt_tile_t *tile, float *output, int filter_type);
static void quantize_subbands(dwt_tile_t *tile, int q_y, int q_co, int q_cg, float rcf);
static int estimate_motion_64x64(const float *current, const float *reference, 
                                 int width, int height, int tile_x, int tile_y, 
                                 motion_vector_t *mv);
static size_t compress_tile_data(tav_encoder_t *enc, const dwt_tile_t *tiles, 
                                 const motion_vector_t *mvs, int num_tiles,
                                 uint8_t packet_type);

// Show usage information
static void show_usage(const char *program_name) {
    printf("TAV DWT-based Video Encoder\n");
    printf("Usage: %s [options] -i input.mp4 -o output.tav\n\n", program_name);
    printf("Options:\n");
    printf("  -i, --input FILE       Input video file\n");
    printf("  -o, --output FILE      Output video file (use '-' for stdout)\n");
    printf("  -s, --size WxH         Video size (default: %dx%d)\n", DEFAULT_WIDTH, DEFAULT_HEIGHT);
    printf("  -f, --fps N            Output frames per second (enables frame rate conversion)\n");
    printf("  -q, --quality N        Quality level 0-5 (default: 2)\n");
    printf("  -Q, --quantizer Y,Co,Cg Quantizer levels 0-100 for each channel\n");
    printf("  -w, --wavelet N        Wavelet filter: 0=5/3 reversible, 1=9/7 irreversible (default: 1)\n");
    printf("  -d, --decomp N         Decomposition levels 1-4 (default: 3)\n");
    printf("  -b, --bitrate N        Target bitrate in kbps (enables bitrate control mode)\n");
    printf("  -p, --progressive      Use progressive scan (default: interlaced)\n");
    printf("  -S, --subtitles FILE   SubRip (.srt) or SAMI (.smi) subtitle file\n");
    printf("  -v, --verbose          Verbose output\n");
    printf("  -t, --test             Test mode: generate solid colour frames\n");
    printf("  --lossless             Lossless mode: use 5/3 reversible wavelet\n");
    printf("  --enable-rcf           Enable per-tile rate control (experimental)\n");
    printf("  --enable-progressive   Enable progressive transmission\n");
    printf("  --enable-roi           Enable region-of-interest coding\n");
    printf("  --help                 Show this help\n\n");
    
    printf("Audio Rate by Quality:\n  ");
    for (int i = 0; i < sizeof(MP2_RATE_TABLE) / sizeof(int); i++) {
        printf("%d: %d kbps\t", i, MP2_RATE_TABLE[i]);
    }
    printf("\n\nQuantizer Value by Quality:\n");
    printf("  Y (Luma):  ");
    for (int i = 0; i < 6; i++) {
        printf("%d: Q%d  ", i, QUALITY_Y[i]);
    }
    printf("\n  Co (Chroma): ");
    for (int i = 0; i < 6; i++) {
        printf("%d: Q%d  ", i, QUALITY_CO[i]);
    }
    printf("\n  Cg (Chroma): ");
    for (int i = 0; i < 6; i++) {
        printf("%d: Q%d  ", i, QUALITY_CG[i]);
    }
    
    printf("\n\nFeatures:\n");
    printf("  - 64x64 DWT tiles with multi-resolution encoding\n");
    printf("  - Full resolution YCoCg-R color space\n");
    printf("  - Progressive transmission and ROI coding\n");
    printf("  - Motion compensation with ±16 pixel search range\n");
    printf("  - Lossless and lossy compression modes\n");
    
    printf("\nExamples:\n");
    printf("  %s -i input.mp4 -o output.tav                    # Default settings\n", program_name);
    printf("  %s -i input.mkv -q 3 -w 1 -d 4 -o output.tav     # High quality with 9/7 wavelet\n", program_name);
    printf("  %s -i input.avi --lossless -o output.tav         # Lossless encoding\n", program_name);
    printf("  %s -i input.mp4 -b 800 -o output.tav             # 800 kbps bitrate target\n", program_name);
    printf("  %s -i input.webm -S subs.srt -o output.tav       # With subtitles\n", program_name);
}

// Create encoder instance
static tav_encoder_t* create_encoder(void) {
    tav_encoder_t *enc = calloc(1, sizeof(tav_encoder_t));
    if (!enc) return NULL;
    
    // Set defaults
    enc->width = DEFAULT_WIDTH;
    enc->height = DEFAULT_HEIGHT; 
    enc->fps = DEFAULT_FPS;
    enc->quality_level = DEFAULT_QUALITY;
    enc->wavelet_filter = WAVELET_9_7_IRREVERSIBLE;
    enc->decomp_levels = DEFAULT_DECOMP_LEVELS;
    enc->quantizer_y = QUALITY_Y[DEFAULT_QUALITY];
    enc->quantizer_co = QUALITY_CO[DEFAULT_QUALITY];
    enc->quantizer_cg = QUALITY_CG[DEFAULT_QUALITY];
    
    return enc;
}

// Initialize encoder resources
static int initialize_encoder(tav_encoder_t *enc) {
    if (!enc) return -1;
    
    // Calculate tile dimensions
    enc->tiles_x = (enc->width + TILE_SIZE - 1) / TILE_SIZE;
    enc->tiles_y = (enc->height + TILE_SIZE - 1) / TILE_SIZE;
    int num_tiles = enc->tiles_x * enc->tiles_y;
    
    // Allocate frame buffers
    size_t frame_size = enc->width * enc->height;
    enc->current_frame_rgb = malloc(frame_size * 3);
    enc->previous_frame_rgb = malloc(frame_size * 3);
    enc->current_frame_y = malloc(frame_size * sizeof(float));
    enc->current_frame_co = malloc(frame_size * sizeof(float));
    enc->current_frame_cg = malloc(frame_size * sizeof(float));
    enc->previous_frame_y = malloc(frame_size * sizeof(float));
    enc->previous_frame_co = malloc(frame_size * sizeof(float));
    enc->previous_frame_cg = malloc(frame_size * sizeof(float));
    
    // Allocate tile structures
    enc->tiles = malloc(num_tiles * sizeof(dwt_tile_t));
    enc->motion_vectors = malloc(num_tiles * sizeof(motion_vector_t));
    
    // Initialize ZSTD compression
    enc->zstd_ctx = ZSTD_createCCtx();
    enc->compressed_buffer_size = ZSTD_compressBound(1024 * 1024); // 1MB max
    enc->compressed_buffer = malloc(enc->compressed_buffer_size);
    
    if (!enc->current_frame_rgb || !enc->previous_frame_rgb || 
        !enc->current_frame_y || !enc->current_frame_co || !enc->current_frame_cg ||
        !enc->previous_frame_y || !enc->previous_frame_co || !enc->previous_frame_cg ||
        !enc->tiles || !enc->motion_vectors || !enc->zstd_ctx || !enc->compressed_buffer) {
        return -1;
    }
    
    return 0;
}

// =============================================================================
// DWT Implementation - 5/3 Reversible and 9/7 Irreversible Filters
// =============================================================================

// 1D DWT using lifting scheme for 5/3 reversible filter
static void dwt_53_forward_1d(float *data, int length) {
    if (length < 2) return;
    
    float *temp = malloc(length * sizeof(float));
    int half = length / 2;
    
    // Predict step (high-pass)
    for (int i = 0; i < half; i++) {
        int idx = 2 * i + 1;
        if (idx < length) {
            float pred = 0.5f * (data[2 * i] + (2 * i + 2 < length ? data[2 * i + 2] : data[2 * i]));
            temp[half + i] = data[idx] - pred;
        }
    }
    
    // Update step (low-pass)
    for (int i = 0; i < half; i++) {
        float update = 0.25f * ((i > 0 ? temp[half + i - 1] : 0) + 
                               (i < half - 1 ? temp[half + i] : 0));
        temp[i] = data[2 * i] + update;
    }
    
    // Copy back
    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

static void dwt_53_inverse_1d(float *data, int length) {
    if (length < 2) return;
    
    float *temp = malloc(length * sizeof(float));
    int half = length / 2;
    
    // Inverse update step
    for (int i = 0; i < half; i++) {
        float update = 0.25f * ((i > 0 ? data[half + i - 1] : 0) + 
                               (i < half - 1 ? data[half + i] : 0));
        temp[2 * i] = data[i] - update;
    }
    
    // Inverse predict step  
    for (int i = 0; i < half; i++) {
        int idx = 2 * i + 1;
        if (idx < length) {
            float pred = 0.5f * (temp[2 * i] + (2 * i + 2 < length ? temp[2 * i + 2] : temp[2 * i]));
            temp[idx] = data[half + i] + pred;
        }
    }
    
    // Copy back
    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// 1D DWT using lifting scheme for 9/7 irreversible filter
static void dwt_97_forward_1d(float *data, int length) {
    if (length < 2) return;
    
    float *temp = malloc(length * sizeof(float));
    int half = length / 2;
    
    // Split into even/odd samples
    for (int i = 0; i < half; i++) {
        temp[i] = data[2 * i];           // Even (low)
        if (2 * i + 1 < length) {
            temp[half + i] = data[2 * i + 1]; // Odd (high)
        }
    }
    
    // Apply 9/7 lifting steps
    const float alpha = -1.586134342f;
    const float beta = -0.052980118f;
    const float gamma = 0.882911076f;
    const float delta = 0.443506852f;
    const float K = 1.230174105f;
    
    // First lifting step
    for (int i = 0; i < half; i++) {
        float left = (i > 0) ? temp[i - 1] : temp[i];
        float right = (i < half - 1) ? temp[i + 1] : temp[i];
        temp[half + i] += alpha * (left + right);
    }
    
    // Second lifting step
    for (int i = 0; i < half; i++) {
        float left = (i > 0) ? temp[half + i - 1] : temp[half + i];
        float right = (i < half - 1) ? temp[half + i + 1] : temp[half + i];
        temp[i] += beta * (left + right);
    }
    
    // Third lifting step
    for (int i = 0; i < half; i++) {
        float left = (i > 0) ? temp[i - 1] : temp[i];
        float right = (i < half - 1) ? temp[i + 1] : temp[i];
        temp[half + i] += gamma * (left + right);
    }
    
    // Fourth lifting step
    for (int i = 0; i < half; i++) {
        float left = (i > 0) ? temp[half + i - 1] : temp[half + i];
        float right = (i < half - 1) ? temp[half + i + 1] : temp[half + i];
        temp[i] += delta * (left + right);
    }
    
    // Scaling
    for (int i = 0; i < half; i++) {
        temp[i] *= K;
        temp[half + i] /= K;
    }
    
    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// 2D DWT forward transform for 64x64 tile
static void dwt_2d_forward(float *tile_data, int levels, int filter_type) {
    const int size = 64;
    float *temp_row = malloc(size * sizeof(float));
    float *temp_col = malloc(size * sizeof(float));
    
    for (int level = 0; level < levels; level++) {
        int current_size = size >> level;
        if (current_size < 2) break;
        
        // Row transform
        for (int y = 0; y < current_size; y++) {
            for (int x = 0; x < current_size; x++) {
                temp_row[x] = tile_data[y * size + x];
            }
            
            if (filter_type == WAVELET_5_3_REVERSIBLE) {
                dwt_53_forward_1d(temp_row, current_size);
            } else {
                dwt_97_forward_1d(temp_row, current_size);
            }
            
            for (int x = 0; x < current_size; x++) {
                tile_data[y * size + x] = temp_row[x];
            }
        }
        
        // Column transform
        for (int x = 0; x < current_size; x++) {
            for (int y = 0; y < current_size; y++) {
                temp_col[y] = tile_data[y * size + x];
            }
            
            if (filter_type == WAVELET_5_3_REVERSIBLE) {
                dwt_53_forward_1d(temp_col, current_size);
            } else {
                dwt_97_forward_1d(temp_col, current_size);
            }
            
            for (int y = 0; y < current_size; y++) {
                tile_data[y * size + x] = temp_col[y];
            }
        }
    }
    
    free(temp_row);
    free(temp_col);
}

// Quantization for DWT subbands with rate control
static void quantize_dwt_tile(dwt_tile_t *tile, int q_y, int q_co, int q_cg, float rcf) {
    // Apply rate control factor to quantizers
    int effective_q_y = (int)(q_y * rcf);
    int effective_q_co = (int)(q_co * rcf);  
    int effective_q_cg = (int)(q_cg * rcf);
    
    // Clamp quantizers to valid range
    effective_q_y = CLAMP(effective_q_y, 1, 255);
    effective_q_co = CLAMP(effective_q_co, 1, 255);
    effective_q_cg = CLAMP(effective_q_cg, 1, 255);
    
    // TODO: Apply quantization to each subband based on frequency and channel
    // Different quantization strategies for LL, LH, HL, HH subbands
    // More aggressive quantization for higher frequency subbands
}

// Motion estimation for 64x64 tiles using SAD
static int estimate_motion_64x64(const float *current, const float *reference, 
                                 int width, int height, int tile_x, int tile_y, 
                                 motion_vector_t *mv) {
    const int tile_size = 64;
    const int search_range = 16;  // ±16 pixels
    const int start_x = tile_x * tile_size;
    const int start_y = tile_y * tile_size;
    
    int best_mv_x = 0, best_mv_y = 0;
    int min_sad = INT_MAX;
    
    // Search within ±16 pixel range
    for (int dy = -search_range; dy <= search_range; dy++) {
        for (int dx = -search_range; dx <= search_range; dx++) {
            int ref_x = start_x + dx;
            int ref_y = start_y + dy;
            
            // Check bounds
            if (ref_x < 0 || ref_y < 0 || 
                ref_x + tile_size > width || ref_y + tile_size > height) {
                continue;
            }
            
            // Calculate SAD
            int sad = 0;
            for (int y = 0; y < tile_size; y++) {
                for (int x = 0; x < tile_size; x++) {
                    int curr_idx = (start_y + y) * width + (start_x + x);
                    int ref_idx = (ref_y + y) * width + (ref_x + x);
                    
                    if (curr_idx >= 0 && curr_idx < width * height &&
                        ref_idx >= 0 && ref_idx < width * height) {
                        int diff = (int)(current[curr_idx] - reference[ref_idx]);
                        sad += abs(diff);
                    }
                }
            }
            
            if (sad < min_sad) {
                min_sad = sad;
                best_mv_x = dx * 4;  // Convert to 1/4 pixel precision
                best_mv_y = dy * 4;
            }
        }
    }
    
    mv->mv_x = best_mv_x;
    mv->mv_y = best_mv_y;
    mv->rate_control_factor = 1.0f;  // TODO: Calculate based on complexity
    
    return min_sad;
}

// RGB to YCoCg color space conversion
static void rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height) {
    for (int i = 0; i < width * height; i++) {
        float r = rgb[i * 3 + 0];
        float g = rgb[i * 3 + 1]; 
        float b = rgb[i * 3 + 2];
        
        // YCoCg-R transform
        co[i] = r - b;
        float tmp = b + co[i] / 2;
        cg[i] = g - tmp;
        y[i] = tmp + cg[i] / 2;
    }
}

// Write TAV file header
static int write_tav_header(tav_encoder_t *enc) {
    if (!enc->output_fp) return -1;
    
    // Magic number
    fwrite(TAV_MAGIC, 1, 8, enc->output_fp);
    
    // Version
    fputc(TAV_VERSION, enc->output_fp);
    
    // Video parameters
    fwrite(&enc->width, sizeof(uint16_t), 1, enc->output_fp);
    fwrite(&enc->height, sizeof(uint16_t), 1, enc->output_fp);
    fputc(enc->fps, enc->output_fp);
    fwrite(&enc->total_frames, sizeof(uint32_t), 1, enc->output_fp);
    
    // Encoder parameters
    fputc(enc->wavelet_filter, enc->output_fp);
    fputc(enc->decomp_levels, enc->output_fp);
    fputc(enc->quantizer_y, enc->output_fp);
    fputc(enc->quantizer_co, enc->output_fp);
    fputc(enc->quantizer_cg, enc->output_fp);
    
    // Feature flags
    uint8_t extra_flags = 0;
    if (1) extra_flags |= 0x01;  // Has audio (placeholder)
    if (enc->subtitle_file) extra_flags |= 0x02;  // Has subtitles
    if (enc->enable_progressive_transmission) extra_flags |= 0x04;
    if (enc->enable_roi) extra_flags |= 0x08;
    fputc(extra_flags, enc->output_fp);
    
    uint8_t video_flags = 0;
    if (!enc->progressive) video_flags |= 0x01;  // Interlaced
    if (enc->fps == 29 || enc->fps == 30) video_flags |= 0x02;  // NTSC
    if (enc->lossless) video_flags |= 0x04;  // Lossless
    if (enc->decomp_levels > 1) video_flags |= 0x08;  // Multi-resolution
    fputc(video_flags, enc->output_fp);
    
    // Reserved bytes (7 bytes)
    for (int i = 0; i < 7; i++) {
        fputc(0, enc->output_fp);
    }
    
    return 0;
}

// Encode a single frame
static int encode_frame(tav_encoder_t *enc, int frame_num, int is_keyframe) {
    // TODO: Read frame data from FFmpeg pipe
    // TODO: Convert RGB to YCoCg
    // TODO: Process tiles with DWT
    // TODO: Apply motion estimation for P-frames
    // TODO: Quantize and compress tile data
    // TODO: Write packet to output file
    
    printf("Encoding frame %d/%d (%s)\n", frame_num + 1, enc->total_frames, 
           is_keyframe ? "I-frame" : "P-frame");
    
    return 0;
}

// Main function
int main(int argc, char *argv[]) {
    generate_random_filename(TEMP_AUDIO_FILE);

    printf("Initialising encoder...\n");
    tav_encoder_t *enc = create_encoder();
    if (!enc) {
        fprintf(stderr, "Error: Failed to create encoder\n");
        return 1;
    }
    
    // Command line option parsing (similar to TEV encoder)
    static struct option long_options[] = {
        {"input", required_argument, 0, 'i'},
        {"output", required_argument, 0, 'o'},
        {"size", required_argument, 0, 's'},
        {"fps", required_argument, 0, 'f'},
        {"quality", required_argument, 0, 'q'},
        {"quantizer", required_argument, 0, 'Q'},
        {"quantiser", required_argument, 0, 'Q'},
        {"wavelet", required_argument, 0, 'w'},
        {"decomp", required_argument, 0, 'd'},
        {"bitrate", required_argument, 0, 'b'},
        {"progressive", no_argument, 0, 'p'},
        {"subtitles", required_argument, 0, 'S'},
        {"verbose", no_argument, 0, 'v'},
        {"test", no_argument, 0, 't'},
        {"lossless", no_argument, 0, 1000},
        {"enable-rcf", no_argument, 0, 1001},
        {"enable-progressive", no_argument, 0, 1002},
        {"enable-roi", no_argument, 0, 1003},
        {"help", no_argument, 0, 1004},
        {0, 0, 0, 0}
    };
    
    int c, option_index = 0;
    while ((c = getopt_long(argc, argv, "i:o:s:f:q:Q:w:d:b:pS:vt", long_options, &option_index)) != -1) {
        switch (c) {
            case 'i':
                enc->input_file = strdup(optarg);
                break;
            case 'o':
                enc->output_file = strdup(optarg);
                break;
            case 'q':
                enc->quality_level = CLAMP(atoi(optarg), 0, 5);
                enc->quantizer_y = QUALITY_Y[enc->quality_level];
                enc->quantizer_co = QUALITY_CO[enc->quality_level];
                enc->quantizer_cg = QUALITY_CG[enc->quality_level];
                break;
            case 'w':
                enc->wavelet_filter = CLAMP(atoi(optarg), 0, 1);
                break;
            case 'd':
                enc->decomp_levels = CLAMP(atoi(optarg), 1, MAX_DECOMP_LEVELS);
                break;
            case 'p':
                enc->progressive = 1;
                break;
            case 'v':
                enc->verbose = 1;
                break;
            case 't':
                enc->test_mode = 1;
                break;
            case 1000: // --lossless
                enc->lossless = 1;
                enc->wavelet_filter = WAVELET_5_3_REVERSIBLE;
                break;
            case 1001: // --enable-rcf
                enc->enable_rcf = 1;
                break;
            case 1004: // --help
                show_usage(argv[0]);
                cleanup_encoder(enc);
                return 0;
            default:
                show_usage(argv[0]);
                cleanup_encoder(enc);
                return 1;
        }
    }
    
    if ((!enc->input_file && !enc->test_mode) || !enc->output_file) {
        fprintf(stderr, "Error: Input and output files must be specified\n");
        show_usage(argv[0]);
        cleanup_encoder(enc);
        return 1;
    }
    
    if (initialize_encoder(enc) != 0) {
        fprintf(stderr, "Error: Failed to initialize encoder\n");
        cleanup_encoder(enc);
        return 1;
    }
    
    printf("TAV Encoder - DWT-based video compression\n");
    printf("Input: %s\n", enc->input_file);
    printf("Output: %s\n", enc->output_file);
    printf("Resolution: %dx%d\n", enc->width, enc->height);
    printf("Wavelet: %s\n", enc->wavelet_filter ? "9/7 irreversible" : "5/3 reversible");
    printf("Decomposition levels: %d\n", enc->decomp_levels);
    printf("Quality: Y=%d, Co=%d, Cg=%d\n", enc->quantizer_y, enc->quantizer_co, enc->quantizer_cg);
    
    // Open output file
    if (strcmp(enc->output_file, "-") == 0) {
        enc->output_fp = stdout;
    } else {
        enc->output_fp = fopen(enc->output_file, "wb");
        if (!enc->output_fp) {
            fprintf(stderr, "Error: Cannot open output file %s\n", enc->output_file);
            cleanup_encoder(enc);
            return 1;
        }
    }
    
    // Start FFmpeg process for video input
    char ffmpeg_cmd[1024];
    if (enc->test_mode) {
        // Test mode - generate solid color frames
        snprintf(ffmpeg_cmd, sizeof(ffmpeg_cmd),
            "ffmpeg -f lavfi -i color=gray:size=%dx%d:duration=5:rate=%d "
            "-f rawvideo -pix_fmt rgb24 -",
            enc->width, enc->height, enc->fps);
        enc->total_frames = enc->fps * 5;  // 5 seconds of test video
    } else {
        // Normal mode - read from input file
        snprintf(ffmpeg_cmd, sizeof(ffmpeg_cmd),
            "ffmpeg -i \"%s\" -f rawvideo -pix_fmt rgb24 "
            "-s %dx%d -r %d -",
            enc->input_file, enc->width, enc->height, enc->fps);
        
        // Get total frame count (simplified)
        enc->total_frames = 300; // Placeholder - should be calculated from input
    }
    
    if (enc->verbose) {
        printf("FFmpeg command: %s\n", ffmpeg_cmd);
    }
    
    enc->ffmpeg_video_pipe = popen(ffmpeg_cmd, "r");
    if (!enc->ffmpeg_video_pipe) {
        fprintf(stderr, "Error: Failed to start FFmpeg process\n");
        cleanup_encoder(enc);
        return 1;
    }
    
    // Write TAV header
    if (write_tav_header(enc) != 0) {
        fprintf(stderr, "Error: Failed to write TAV header\n");
        cleanup_encoder(enc);
        return 1;
    }
    
    printf("Starting encoding...\n");
    
    // Main encoding loop
    int keyframe_interval = 30;  // I-frame every 30 frames
    size_t frame_size = enc->width * enc->height * 3;  // RGB24
    
    for (int frame = 0; frame < enc->total_frames; frame++) {
        // Read frame from FFmpeg
        size_t bytes_read = fread(enc->current_frame_rgb, 1, frame_size, enc->ffmpeg_video_pipe);
        if (bytes_read != frame_size) {
            if (feof(enc->ffmpeg_video_pipe)) {
                printf("End of input reached at frame %d\n", frame);
                break;
            } else {
                fprintf(stderr, "Error reading frame %d\n", frame);
                break;
            }
        }
        
        // Determine frame type
        int is_keyframe = (frame % keyframe_interval == 0);
        
        // Convert RGB to YCoCg
        rgb_to_ycocg(enc->current_frame_rgb, 
                     enc->current_frame_y, enc->current_frame_co, enc->current_frame_cg,
                     enc->width, enc->height);
        
        // Process tiles
        int num_tiles = enc->tiles_x * enc->tiles_y;
        for (int tile_idx = 0; tile_idx < num_tiles; tile_idx++) {
            int tile_x = tile_idx % enc->tiles_x;
            int tile_y = tile_idx / enc->tiles_x;
            
            // Extract 64x64 tile data
            float tile_y_data[64 * 64];
            float tile_co_data[64 * 64];
            float tile_cg_data[64 * 64];
            
            for (int y = 0; y < 64; y++) {
                for (int x = 0; x < 64; x++) {
                    int src_x = tile_x * 64 + x;
                    int src_y = tile_y * 64 + y;
                    int src_idx = src_y * enc->width + src_x;
                    int tile_idx_local = y * 64 + x;
                    
                    if (src_x < enc->width && src_y < enc->height) {
                        tile_y_data[tile_idx_local] = enc->current_frame_y[src_idx];
                        tile_co_data[tile_idx_local] = enc->current_frame_co[src_idx];
                        tile_cg_data[tile_idx_local] = enc->current_frame_cg[src_idx];
                    } else {
                        // Pad with zeros if tile extends beyond frame
                        tile_y_data[tile_idx_local] = 0.0f;
                        tile_co_data[tile_idx_local] = 0.0f;
                        tile_cg_data[tile_idx_local] = 0.0f;
                    }
                }
            }
            
            // Apply DWT transform
            dwt_2d_forward(tile_y_data, enc->decomp_levels, enc->wavelet_filter);
            dwt_2d_forward(tile_co_data, enc->decomp_levels, enc->wavelet_filter);
            dwt_2d_forward(tile_cg_data, enc->decomp_levels, enc->wavelet_filter);
            
            // Motion estimation for P-frames
            if (!is_keyframe && frame > 0) {
                estimate_motion_64x64(enc->current_frame_y, enc->previous_frame_y,
                                      enc->width, enc->height, tile_x, tile_y,
                                      &enc->motion_vectors[tile_idx]);
            } else {
                enc->motion_vectors[tile_idx].mv_x = 0;
                enc->motion_vectors[tile_idx].mv_y = 0;
                enc->motion_vectors[tile_idx].rate_control_factor = 1.0f;
            }
        }
        
        // Write frame packet
        uint8_t packet_type = is_keyframe ? TAV_PACKET_IFRAME : TAV_PACKET_PFRAME;
        
        // Placeholder: write minimal packet structure
        fwrite(&packet_type, 1, 1, enc->output_fp);
        uint32_t compressed_size = 1024;  // Placeholder
        fwrite(&compressed_size, sizeof(uint32_t), 1, enc->output_fp);
        
        // Write dummy compressed data
        uint8_t dummy_data[1024] = {0};
        fwrite(dummy_data, 1, compressed_size, enc->output_fp);
        
        // Copy current frame to previous frame buffer
        memcpy(enc->previous_frame_y, enc->current_frame_y, enc->width * enc->height * sizeof(float));
        memcpy(enc->previous_frame_co, enc->current_frame_co, enc->width * enc->height * sizeof(float));
        memcpy(enc->previous_frame_cg, enc->current_frame_cg, enc->width * enc->height * sizeof(float));
        memcpy(enc->previous_frame_rgb, enc->current_frame_rgb, frame_size);
        
        enc->frame_count++;
        
        if (enc->verbose || frame % 30 == 0) {
            printf("Encoded frame %d/%d (%s)\n", frame + 1, enc->total_frames, 
                   is_keyframe ? "I-frame" : "P-frame");
        }
    }
    
    printf("Encoding completed: %d frames\n", enc->frame_count);
    printf("Output file: %s\n", enc->output_file);
    
    cleanup_encoder(enc);
    return 0;
}

// Cleanup encoder resources
static void cleanup_encoder(tav_encoder_t *enc) {
    if (!enc) return;
    
    if (enc->ffmpeg_video_pipe) {
        pclose(enc->ffmpeg_video_pipe);
    }
    if (enc->mp2_file) {
        fclose(enc->mp2_file);
        unlink(TEMP_AUDIO_FILE);
    }
    if (enc->output_fp) {
        fclose(enc->output_fp);
    }
    
    free(enc->input_file);
    free(enc->output_file);
    free(enc->subtitle_file);
    free(enc->current_frame_rgb);
    free(enc->previous_frame_rgb);
    free(enc->current_frame_y);
    free(enc->current_frame_co);
    free(enc->current_frame_cg);
    free(enc->previous_frame_y);
    free(enc->previous_frame_co);
    free(enc->previous_frame_cg);
    free(enc->tiles);
    free(enc->motion_vectors);
    free(enc->compressed_buffer);
    
    if (enc->zstd_ctx) {
        ZSTD_freeCCtx(enc->zstd_ctx);
    }
    
    free(enc);
}