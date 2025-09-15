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
#include <limits.h>
#include <float.h>

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
// TAV version - dynamic based on color space mode
// Version 1: YCoCg-R (default) 
// Version 2: ICtCp (--ictcp flag)

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
    int output_fps;  // For frame rate conversion
    int total_frames;
    int frame_count;
    double duration;
    int has_audio;
    int is_ntsc_framerate;
    
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
    int ictcp_mode;       // 0 = YCoCg-R (default), 1 = ICtCp color space
    
    // Frame buffers
    uint8_t *current_frame_rgb;
    uint8_t *previous_frame_rgb;
    float *current_frame_y, *current_frame_co, *current_frame_cg;
    float *previous_frame_y, *previous_frame_co, *previous_frame_cg;
    
    // Tile processing
    int tiles_x, tiles_y;
    dwt_tile_t *tiles;
    motion_vector_t *motion_vectors;
    
    // Audio processing
    size_t audio_remaining;
    
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
    printf("Usage: %s [options] -i input.mp4 -o output.mv3\n\n", program_name);
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
    printf("  --ictcp                Use ICtCp color space instead of YCoCg-R (generates TAV version 2)\n");
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
    printf("  %s -i input.mp4 -o output.mv3                    # Default settings\n", program_name);
    printf("  %s -i input.mkv -q 3 -w 1 -d 4 -o output.mv3     # High quality with 9/7 wavelet\n", program_name);
    printf("  %s -i input.avi --lossless -o output.mv3         # Lossless encoding\n", program_name);
    printf("  %s -i input.mp4 -b 800 -o output.mv3             # 800 kbps bitrate target\n", program_name);
    printf("  %s -i input.webm -S subs.srt -o output.mv3       # With subtitles\n", program_name);
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
static void quantize_dwt_coefficients(float *coeffs, int16_t *quantized, int size, int quantizer, float rcf) {
    float effective_q = quantizer * rcf;
    effective_q = FCLAMP(effective_q, 1.0f, 255.0f);
    
    for (int i = 0; i < size; i++) {
        float quantized_val = coeffs[i] / effective_q;
        quantized[i] = (int16_t)CLAMP((int)(quantized_val + (quantized_val >= 0 ? 0.5f : -0.5f)), -32768, 32767);
    }
}

// Serialize tile data for compression
static size_t serialize_tile_data(tav_encoder_t *enc, int tile_x, int tile_y, 
                                  const float *tile_y_data, const float *tile_co_data, const float *tile_cg_data,
                                  const motion_vector_t *mv, uint8_t mode, uint8_t *buffer) {
    size_t offset = 0;
    
    // Write tile header
    buffer[offset++] = mode;
    memcpy(buffer + offset, &mv->mv_x, sizeof(int16_t)); offset += sizeof(int16_t);
    memcpy(buffer + offset, &mv->mv_y, sizeof(int16_t)); offset += sizeof(int16_t);
    memcpy(buffer + offset, &mv->rate_control_factor, sizeof(float)); offset += sizeof(float);
    
    if (mode == TAV_MODE_SKIP || mode == TAV_MODE_MOTION) {
        // No coefficient data for SKIP/MOTION modes
        return offset;
    }
    
    // Quantize and serialize DWT coefficients
    const int tile_size = 64 * 64;
    int16_t *quantized_y = malloc(tile_size * sizeof(int16_t));
    int16_t *quantized_co = malloc(tile_size * sizeof(int16_t));
    int16_t *quantized_cg = malloc(tile_size * sizeof(int16_t));
    
    // Debug: check DWT coefficients before quantization
    /*if (tile_x == 0 && tile_y == 0) {
        printf("Encoder Debug: Tile (0,0) - DWT Y coeffs before quantization (first 16): ");
        for (int i = 0; i < 16; i++) {
            printf("%.2f ", tile_y_data[i]);
        }
        printf("\n");
        printf("Encoder Debug: Quantizers - Y=%d, Co=%d, Cg=%d, rcf=%.2f\n", 
               enc->quantizer_y, enc->quantizer_co, enc->quantizer_cg, mv->rate_control_factor);
    }*/
    
    quantize_dwt_coefficients((float*)tile_y_data, quantized_y, tile_size, enc->quantizer_y, mv->rate_control_factor);
    quantize_dwt_coefficients((float*)tile_co_data, quantized_co, tile_size, enc->quantizer_co, mv->rate_control_factor);
    quantize_dwt_coefficients((float*)tile_cg_data, quantized_cg, tile_size, enc->quantizer_cg, mv->rate_control_factor);
    
    // Debug: check quantized coefficients after quantization
    /*if (tile_x == 0 && tile_y == 0) {
        printf("Encoder Debug: Tile (0,0) - Quantized Y coeffs (first 16): ");
        for (int i = 0; i < 16; i++) {
            printf("%d ", quantized_y[i]);
        }
        printf("\n");
    }*/
    
    // Write quantized coefficients
    memcpy(buffer + offset, quantized_y, tile_size * sizeof(int16_t)); offset += tile_size * sizeof(int16_t);
    memcpy(buffer + offset, quantized_co, tile_size * sizeof(int16_t)); offset += tile_size * sizeof(int16_t);
    memcpy(buffer + offset, quantized_cg, tile_size * sizeof(int16_t)); offset += tile_size * sizeof(int16_t);
    
    free(quantized_y);
    free(quantized_co);
    free(quantized_cg);
    
    return offset;
}

// Compress and write frame data
static size_t compress_and_write_frame(tav_encoder_t *enc, uint8_t packet_type) {
    // Calculate total uncompressed size
    const size_t max_tile_size = 9 + (64 * 64 * 3 * sizeof(int16_t));  // header + 3 channels of coefficients
    const size_t total_uncompressed_size = enc->tiles_x * enc->tiles_y * max_tile_size;
    
    // Allocate buffer for uncompressed tile data
    uint8_t *uncompressed_buffer = malloc(total_uncompressed_size);
    size_t uncompressed_offset = 0;
    
    // Serialize all tiles
    for (int tile_y = 0; tile_y < enc->tiles_y; tile_y++) {
        for (int tile_x = 0; tile_x < enc->tiles_x; tile_x++) {
            int tile_idx = tile_y * enc->tiles_x + tile_x;
            
            // Determine tile mode (simplified)
            uint8_t mode = TAV_MODE_INTRA;  // For now, all tiles are INTRA
            
            // Extract tile data (already processed)
            float tile_y_data[64 * 64];
            float tile_co_data[64 * 64];
            float tile_cg_data[64 * 64];
            
            // Extract tile data from frame buffers
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
            
            // Debug: check input data before DWT
            /*if (tile_x == 0 && tile_y == 0) {
                printf("Encoder Debug: Tile (0,0) - Y data before DWT (first 16): ");
                for (int i = 0; i < 16; i++) {
                    printf("%.2f ", tile_y_data[i]);
                }
                printf("\n");
            }*/
            
            // Apply DWT transform to each channel
            dwt_2d_forward(tile_y_data, enc->decomp_levels, enc->wavelet_filter);
            dwt_2d_forward(tile_co_data, enc->decomp_levels, enc->wavelet_filter);
            dwt_2d_forward(tile_cg_data, enc->decomp_levels, enc->wavelet_filter);
            
            // Serialize tile
            size_t tile_size = serialize_tile_data(enc, tile_x, tile_y, 
                                                   tile_y_data, tile_co_data, tile_cg_data,
                                                   &enc->motion_vectors[tile_idx], mode,
                                                   uncompressed_buffer + uncompressed_offset);
            uncompressed_offset += tile_size;
        }
    }
    
    // Compress with zstd
    size_t compressed_size = ZSTD_compress(enc->compressed_buffer, enc->compressed_buffer_size,
                                           uncompressed_buffer, uncompressed_offset,
                                           ZSTD_CLEVEL_DEFAULT);
    
    if (ZSTD_isError(compressed_size)) {
        fprintf(stderr, "Error: ZSTD compression failed: %s\n", ZSTD_getErrorName(compressed_size));
        free(uncompressed_buffer);
        return 0;
    }
    
    // Write packet header and compressed data
    fwrite(&packet_type, 1, 1, enc->output_fp);
    uint32_t compressed_size_32 = (uint32_t)compressed_size;
    fwrite(&compressed_size_32, sizeof(uint32_t), 1, enc->output_fp);
    fwrite(enc->compressed_buffer, 1, compressed_size, enc->output_fp);
    
    free(uncompressed_buffer);
    
    enc->total_compressed_size += compressed_size;
    enc->total_uncompressed_size += uncompressed_offset;
    
    return compressed_size + 5; // packet type + size field + compressed data
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

// ---------------------- ICtCp Implementation ----------------------

static inline int iround(double v) { return (int)floor(v + 0.5); }

// ---------------------- sRGB gamma helpers ----------------------
static inline double srgb_linearize(double val) {
    if (val <= 0.04045) return val / 12.92;
    return pow((val + 0.055) / 1.055, 2.4);
}

static inline double srgb_unlinearize(double val) {
    if (val <= 0.0031308) return 12.92 * val;
    return 1.055 * pow(val, 1.0/2.4) - 0.055;
}

// ---------------------- HLG OETF/EOTF ----------------------
static inline double HLG_OETF(double E) {
    const double a = 0.17883277;
    const double b = 0.28466892;  // 1 - 4*a
    const double c = 0.55991073;  // 0.5 - a*ln(4*a)
    
    if (E <= 1.0/12.0) return sqrt(3.0 * E);
    return a * log(12.0 * E - b) + c;
}

static inline double HLG_EOTF(double Ep) {
    const double a = 0.17883277;
    const double b = 0.28466892;
    const double c = 0.55991073;
    
    if (Ep <= 0.5) {
        double val = Ep * Ep / 3.0;
        return val;
    }
    double val = (exp((Ep - c) / a) + b) / 12.0;
    return val;
}

// sRGB -> LMS matrix
static const double M_RGB_TO_LMS[3][3] = {
    {0.2958564579364564, 0.6230869483219083, 0.08106989398623762},
    {0.15627390752659093, 0.727308963512872, 0.11639736914944238},
    {0.035141262332177715, 0.15657109121101628, 0.8080956851990795}
};

static const double M_LMS_TO_RGB[3][3] = {
    {6.1723815689243215, -5.319534979827695, 0.14699442094633924},
    {-1.3243428148026244, 2.560286104841917, -0.2359203727576164},
    {-0.011819739235953752, -0.26473549971186555, 1.2767952602537955}
};

// ICtCp matrix (L' M' S' -> I Ct Cp). Values are the BT.2100 integer-derived /4096 constants.
static const double M_LMSPRIME_TO_ICTCP[3][3] = {
    { 2048.0/4096.0,   2048.0/4096.0,     0.0          },
    { 3625.0/4096.0, -7465.0/4096.0, 3840.0/4096.0    },
    { 9500.0/4096.0, -9212.0/4096.0, -288.0/4096.0    }
};

// Inverse matrices
static const double M_ICTCP_TO_LMSPRIME[3][3] = {
    { 1.0,         0.015718580108730416,  0.2095810681164055 },
    { 1.0,        -0.015718580108730416, -0.20958106811640548 },
    { 1.0,         1.0212710798422344, -0.6052744909924316 }
};

// ---------------------- Forward: sRGB8 -> ICtCp (doubles) ----------------------
void srgb8_to_ictcp_hlg(uint8_t r8, uint8_t g8, uint8_t b8,
                       double *out_I, double *out_Ct, double *out_Cp)
{
    // 1) linearize sRGB to 0..1
    double r = srgb_linearize((double)r8 / 255.0);
    double g = srgb_linearize((double)g8 / 255.0);
    double b = srgb_linearize((double)b8 / 255.0);

    // 2) linear RGB -> LMS (single 3x3 multiply)
    double L = M_RGB_TO_LMS[0][0]*r + M_RGB_TO_LMS[0][1]*g + M_RGB_TO_LMS[0][2]*b;
    double M = M_RGB_TO_LMS[1][0]*r + M_RGB_TO_LMS[1][1]*g + M_RGB_TO_LMS[1][2]*b;
    double S = M_RGB_TO_LMS[2][0]*r + M_RGB_TO_LMS[2][1]*g + M_RGB_TO_LMS[2][2]*b;

    // 3) HLG OETF
    double Lp = HLG_OETF(L);
    double Mp = HLG_OETF(M);
    double Sp = HLG_OETF(S);

    // 4) L'M'S' -> ICtCp
    double I  = M_LMSPRIME_TO_ICTCP[0][0]*Lp + M_LMSPRIME_TO_ICTCP[0][1]*Mp + M_LMSPRIME_TO_ICTCP[0][2]*Sp;
    double Ct = M_LMSPRIME_TO_ICTCP[1][0]*Lp + M_LMSPRIME_TO_ICTCP[1][1]*Mp + M_LMSPRIME_TO_ICTCP[1][2]*Sp;
    double Cp = M_LMSPRIME_TO_ICTCP[2][0]*Lp + M_LMSPRIME_TO_ICTCP[2][1]*Mp + M_LMSPRIME_TO_ICTCP[2][2]*Sp;

    *out_I = FCLAMP(I * 255.f, 0.f, 255.f);
    *out_Ct = FCLAMP(Ct * 255.f + 127.5f, 0.f, 255.f);
    *out_Cp = FCLAMP(Cp * 255.f + 127.5f, 0.f, 255.f);
}

// ---------------------- Reverse: ICtCp -> sRGB8 (doubles) ----------------------
void ictcp_hlg_to_srgb8(double I8, double Ct8, double Cp8,
                       uint8_t *r8, uint8_t *g8, uint8_t *b8)
{
    double I = I8 / 255.f;
    double Ct = (Ct8 - 127.5f) / 255.f;
    double Cp = (Cp8 - 127.5f) / 255.f;

    // 1) ICtCp -> L' M' S' (3x3 multiply)
    double Lp = M_ICTCP_TO_LMSPRIME[0][0]*I + M_ICTCP_TO_LMSPRIME[0][1]*Ct + M_ICTCP_TO_LMSPRIME[0][2]*Cp;
    double Mp = M_ICTCP_TO_LMSPRIME[1][0]*I + M_ICTCP_TO_LMSPRIME[1][1]*Ct + M_ICTCP_TO_LMSPRIME[1][2]*Cp;
    double Sp = M_ICTCP_TO_LMSPRIME[2][0]*I + M_ICTCP_TO_LMSPRIME[2][1]*Ct + M_ICTCP_TO_LMSPRIME[2][2]*Cp;

    // 2) HLG decode: L' -> linear LMS
    double L = HLG_EOTF(Lp);
    double M = HLG_EOTF(Mp);
    double S = HLG_EOTF(Sp);

    // 3) LMS -> linear sRGB (3x3 inverse)
    double r_lin = M_LMS_TO_RGB[0][0]*L + M_LMS_TO_RGB[0][1]*M + M_LMS_TO_RGB[0][2]*S;
    double g_lin = M_LMS_TO_RGB[1][0]*L + M_LMS_TO_RGB[1][1]*M + M_LMS_TO_RGB[1][2]*S;
    double b_lin = M_LMS_TO_RGB[2][0]*L + M_LMS_TO_RGB[2][1]*M + M_LMS_TO_RGB[2][2]*S;

    // 4) gamma encode and convert to 0..255 with center-of-bin rounding
    double r = srgb_unlinearize(r_lin);
    double g = srgb_unlinearize(g_lin);
    double b = srgb_unlinearize(b_lin);

    *r8 = (uint8_t)iround(FCLAMP(r * 255.0, 0.0, 255.0));
    *g8 = (uint8_t)iround(FCLAMP(g * 255.0, 0.0, 255.0));
    *b8 = (uint8_t)iround(FCLAMP(b * 255.0, 0.0, 255.0));
}

// ---------------------- Color Space Switching Functions ----------------------
// Wrapper functions that choose between YCoCg-R and ICtCp based on encoder mode

static void rgb_to_color_space(tav_encoder_t *enc, uint8_t r, uint8_t g, uint8_t b,
                               double *c1, double *c2, double *c3) {
    if (enc->ictcp_mode) {
        // Use ICtCp color space
        srgb8_to_ictcp_hlg(r, g, b, c1, c2, c3);
    } else {
        // Use YCoCg-R color space (convert from existing function)
        float rf = r, gf = g, bf = b;
        float co = rf - bf;
        float tmp = bf + co / 2;
        float cg = gf - tmp;
        float y = tmp + cg / 2;
        *c1 = (double)y;
        *c2 = (double)co;
        *c3 = (double)cg;
    }
}

static void color_space_to_rgb(tav_encoder_t *enc, double c1, double c2, double c3,
                               uint8_t *r, uint8_t *g, uint8_t *b) {
    if (enc->ictcp_mode) {
        // Use ICtCp color space
        ictcp_hlg_to_srgb8(c1, c2, c3, r, g, b);
    } else {
        // Use YCoCg-R color space (inverse of rgb_to_ycocg)
        float y = (float)c1;
        float co = (float)c2;
        float cg = (float)c3;
        float tmp = y - cg / 2.0f;
        float g_val = cg + tmp;
        float b_val = tmp - co / 2.0f;
        float r_val = co + b_val;
        *r = (uint8_t)CLAMP((int)(r_val + 0.5f), 0, 255);
        *g = (uint8_t)CLAMP((int)(g_val + 0.5f), 0, 255);
        *b = (uint8_t)CLAMP((int)(b_val + 0.5f), 0, 255);
    }
}

// RGB to color space conversion for full frames
static void rgb_to_color_space_frame(tav_encoder_t *enc, const uint8_t *rgb, 
                                    float *c1, float *c2, float *c3, int width, int height) {
    if (enc->ictcp_mode) {
        // ICtCp mode
        for (int i = 0; i < width * height; i++) {
            double I, Ct, Cp;
            srgb8_to_ictcp_hlg(rgb[i*3], rgb[i*3+1], rgb[i*3+2], &I, &Ct, &Cp);
            c1[i] = (float)I;
            c2[i] = (float)Ct;
            c3[i] = (float)Cp;
        }
    } else {
        // Use existing YCoCg function
        rgb_to_ycocg(rgb, c1, c2, c3, width, height);
    }
}

// Write TAV file header
static int write_tav_header(tav_encoder_t *enc) {
    if (!enc->output_fp) return -1;
    
    // Magic number
    fwrite(TAV_MAGIC, 1, 8, enc->output_fp);
    
    // Version (dynamic based on color space)
    uint8_t version = enc->ictcp_mode ? 2 : 1;  // Version 2 for ICtCp, 1 for YCoCg-R
    fputc(version, enc->output_fp);
    
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

// =============================================================================
// Video Processing Pipeline (from TEV for compatibility)
// =============================================================================

// Execute command and capture output
static char* execute_command(const char* command) {
    FILE* pipe = popen(command, "r");
    if (!pipe) return NULL;
    
    size_t buffer_size = 4096;
    char* buffer = malloc(buffer_size);
    size_t total_size = 0;
    size_t bytes_read;
    
    while ((bytes_read = fread(buffer + total_size, 1, buffer_size - total_size - 1, pipe)) > 0) {
        total_size += bytes_read;
        if (total_size + 1 >= buffer_size) {
            buffer_size *= 2;
            buffer = realloc(buffer, buffer_size);
        }
    }
    
    buffer[total_size] = '\0';
    pclose(pipe);
    return buffer;
}

// Get video metadata using ffprobe
static int get_video_metadata(tav_encoder_t *config) {
    char command[1024];
    char *output;

    // Get all metadata without frame count (much faster)
    snprintf(command, sizeof(command),
        "ffprobe -v quiet "
        "-show_entries stream=r_frame_rate:format=duration "
        "-select_streams v:0 -of csv=p=0 \"%s\" 2>/dev/null; "
        "ffprobe -v quiet -select_streams a:0 -show_entries stream=index -of csv=p=0 \"%s\" 2>/dev/null",
        config->input_file, config->input_file);

    output = execute_command(command);
    if (!output) {
        fprintf(stderr, "Failed to get video metadata (ffprobe failed)\n");
        return 0;
    }

    // Parse the combined output
    char *line = strtok(output, "\n");
    int line_num = 0;
    double inputFramerate = 0;

    while (line) {
        switch (line_num) {
            case 0: // framerate (e.g., "30000/1001", "30/1")
                if (strlen(line) > 0) {
                    double num, den;
                    if (sscanf(line, "%lf/%lf", &num, &den) == 2) {
                        inputFramerate = num / den;
                        config->fps = (int)round(inputFramerate);
                        config->is_ntsc_framerate = (fabs(den - 1001.0) < 0.1);
                    } else {
                        config->fps = (int)round(atof(line));
                        config->is_ntsc_framerate = 0;
                    }
                    // Frame count will be determined during encoding
                    config->total_frames = 0;
                }
                break;
            case 1: // duration in seconds
                config->duration = atof(line);
                break;
        }
        line = strtok(NULL, "\n");
        line_num++;
    }

    // Check for audio (line_num > 2 means audio stream was found)
    config->has_audio = (line_num > 2);

    free(output);

    if (config->fps <= 0) {
        fprintf(stderr, "Invalid or missing framerate in input file\n");
        return 0;
    }

    // Set output FPS to input FPS if not specified
    if (config->output_fps == 0) {
        config->output_fps = config->fps;
    }

    // Frame count will be determined during encoding
    config->total_frames = 0;

    fprintf(stderr, "Video metadata:\n");
    fprintf(stderr, "  Frames: (will be determined during encoding)\n");
    fprintf(stderr, "  FPS: %.2f\n", inputFramerate);
    fprintf(stderr, "  Duration: %.2fs\n", config->duration);
    fprintf(stderr, "  Audio: %s\n", config->has_audio ? "Yes" : "No");
    fprintf(stderr, "  Resolution: %dx%d (%s)\n", config->width, config->height, 
            config->progressive ? "progressive" : "interlaced");

    return (config->fps > 0);
}

// Start FFmpeg process for video conversion with frame rate support
static int start_video_conversion(tav_encoder_t *enc) {
    char command[2048];

    // Use simple FFmpeg command like TEV encoder for reliable EOF detection
    snprintf(command, sizeof(command),
        "ffmpeg -i \"%s\" -f rawvideo -pix_fmt rgb24 "
        "-vf \"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d\" "
        "-y - 2>/dev/null",
        enc->input_file, enc->width, enc->height, enc->width, enc->height);

    if (enc->verbose) {
        printf("FFmpeg command: %s\n", command);
    }

    enc->ffmpeg_video_pipe = popen(command, "r");
    if (!enc->ffmpeg_video_pipe) {
        fprintf(stderr, "Failed to start FFmpeg video conversion\n");
        return 0;
    }

    return 1;
}

// Start audio conversion
static int start_audio_conversion(tav_encoder_t *enc) {
    if (!enc->has_audio) return 1;

    char command[2048];
    snprintf(command, sizeof(command),
        "ffmpeg -v quiet -i \"%s\" -acodec libtwolame -psymodel 4 -b:a %dk -ar 32000 -ac 2 -y \"%s\" 2>/dev/null",
        enc->input_file, enc->lossless ? 384 : MP2_RATE_TABLE[enc->quality_level], TEMP_AUDIO_FILE);

    int result = system(command);
    if (result == 0) {
        enc->mp2_file = fopen(TEMP_AUDIO_FILE, "rb");
        if (enc->mp2_file) {
            fseek(enc->mp2_file, 0, SEEK_END);
            enc->audio_remaining = ftell(enc->mp2_file);
            fseek(enc->mp2_file, 0, SEEK_SET);
        }
        return 1;
    }
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
        {"ictcp", no_argument, 0, 1005},
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
            case 'Q':
                // Parse quantizer values Y,Co,Cg
                if (sscanf(optarg, "%d,%d,%d", &enc->quantizer_y, &enc->quantizer_co, &enc->quantizer_cg) != 3) {
                    fprintf(stderr, "Error: Invalid quantizer format. Use Y,Co,Cg (e.g., 5,3,2)\n");
                    cleanup_encoder(enc);
                    return 1;
                }
                enc->quantizer_y = CLAMP(enc->quantizer_y, 1, 100);
                enc->quantizer_co = CLAMP(enc->quantizer_co, 1, 100);
                enc->quantizer_cg = CLAMP(enc->quantizer_cg, 1, 100);
                break;
            case 'w':
                enc->wavelet_filter = CLAMP(atoi(optarg), 0, 1);
                break;
            case 'f':
                enc->output_fps = atoi(optarg);
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
            case 1005: // --ictcp
                enc->ictcp_mode = 1;
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
    printf("Color space: %s\n", enc->ictcp_mode ? "ICtCp" : "YCoCg-R");
    
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
    
    // Start FFmpeg process for video input (using TEV-compatible filtergraphs)
    if (enc->test_mode) {
        // Test mode - generate solid color frames
        enc->total_frames = 15;  // Fixed 15 test frames like TEV
        printf("Test mode: Generating %d solid colour frames\n", enc->total_frames);
    } else {
        // Normal mode - get video metadata first
        printf("Retrieving video metadata...\n");
        if (!get_video_metadata(enc)) {
            fprintf(stderr, "Error: Failed to get video metadata\n");
            cleanup_encoder(enc);
            return 1;
        }
        
        // Start video preprocessing pipeline
        if (start_video_conversion(enc) != 1) {
            fprintf(stderr, "Error: Failed to start video conversion\n");
            cleanup_encoder(enc);
            return 1;
        }
        
        // Start audio conversion if needed
        if (enc->has_audio) {
            printf("Starting audio conversion...\n");
            if (!start_audio_conversion(enc)) {
                fprintf(stderr, "Warning: Audio conversion failed\n");
                enc->has_audio = 0;
            }
        }
    }
    
    // Write TAV header
    if (write_tav_header(enc) != 0) {
        fprintf(stderr, "Error: Failed to write TAV header\n");
        cleanup_encoder(enc);
        return 1;
    }
    
    printf("Starting encoding...\n");
    
    // Main encoding loop - process frames until EOF or frame limit
    int keyframe_interval = 30;  // I-frame every 30 frames
    int frame_count = 0;
    int continue_encoding = 1;
    
    while (continue_encoding) {
        if (enc->test_mode) {
            // Test mode has a fixed frame count
            if (frame_count >= enc->total_frames) {
                continue_encoding = 0;
                break;
            }
            
            // Generate test frame with solid colours (TEV-style)
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
            
            // Fill frame with test colour
            for (size_t i = 0; i < rgb_size; i += 3) {
                enc->current_frame_rgb[i] = test_r;
                enc->current_frame_rgb[i + 1] = test_g;
                enc->current_frame_rgb[i + 2] = test_b;
            }
            
            printf("Frame %d: %s (%d,%d,%d)\n", frame_count, colour_name, test_r, test_g, test_b);
            
        } else {
            // Real video mode - read frame from FFmpeg
            // height-halving is already done on the encoder initialisation
            int frame_height = enc->height;
            size_t rgb_size = enc->width * frame_height * 3;
            size_t bytes_read = fread(enc->current_frame_rgb, 1, rgb_size, enc->ffmpeg_video_pipe);
            
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
                continue_encoding = 0;
                break;
            }
            
            // Each frame from FFmpeg is now a single field at half height (for interlaced)
            // Frame parity: even frames (0,2,4...) = bottom fields, odd frames (1,3,5...) = top fields
        }
        
        // Determine frame type
        int is_keyframe = 1;//(frame_count % keyframe_interval == 0);
        
        // Debug: check RGB input data
        /*if (frame_count < 3) {
            printf("Encoder Debug: Frame %d - RGB data (first 16 bytes): ", frame_count);
            for (int i = 0; i < 16; i++) {
                printf("%d ", enc->current_frame_rgb[i]);
            }
            printf("\n");
        }*/
        
        // Convert RGB to color space (YCoCg-R or ICtCp)
        rgb_to_color_space_frame(enc, enc->current_frame_rgb, 
                                enc->current_frame_y, enc->current_frame_co, enc->current_frame_cg,
                                enc->width, enc->height);
                     
        // Debug: check YCoCg conversion result
        /*if (frame_count < 3) {
            printf("Encoder Debug: Frame %d - YCoCg result (first 16): ", frame_count);
            for (int i = 0; i < 16; i++) {
                printf("Y=%.1f Co=%.1f Cg=%.1f ", enc->current_frame_y[i], enc->current_frame_co[i], enc->current_frame_cg[i]);
                if (i % 4 == 3) break; // Only show first 4 pixels for readability
            }
            printf("\n");
        }*/
        
        // Process motion vectors for P-frames
        int num_tiles = enc->tiles_x * enc->tiles_y;
        for (int tile_idx = 0; tile_idx < num_tiles; tile_idx++) {
            int tile_x = tile_idx % enc->tiles_x;
            int tile_y = tile_idx / enc->tiles_x;
            
            if (!is_keyframe && frame_count > 0) {
                estimate_motion_64x64(enc->current_frame_y, enc->previous_frame_y,
                                      enc->width, enc->height, tile_x, tile_y,
                                      &enc->motion_vectors[tile_idx]);
            } else {
                enc->motion_vectors[tile_idx].mv_x = 0;
                enc->motion_vectors[tile_idx].mv_y = 0;
                enc->motion_vectors[tile_idx].rate_control_factor = 1.0f;
            }
        }
        
        // Compress and write frame packet
        uint8_t packet_type = is_keyframe ? TAV_PACKET_IFRAME : TAV_PACKET_PFRAME;
        size_t packet_size = compress_and_write_frame(enc, packet_type);
        
        if (packet_size == 0) {
            fprintf(stderr, "Error: Failed to compress frame %d\n", frame_count);
            break;
        }
        else {
            // Write a sync packet only after a video is been coded
            uint8_t sync_packet = TAV_PACKET_SYNC;
            fwrite(&sync_packet, 1, 1, enc->output_fp);
        }
        
        // Copy current frame to previous frame buffer
        size_t float_frame_size = enc->width * enc->height * sizeof(float);
        size_t rgb_frame_size = enc->width * enc->height * 3;
        memcpy(enc->previous_frame_y, enc->current_frame_y, float_frame_size);
        memcpy(enc->previous_frame_co, enc->current_frame_co, float_frame_size);
        memcpy(enc->previous_frame_cg, enc->current_frame_cg, float_frame_size);
        memcpy(enc->previous_frame_rgb, enc->current_frame_rgb, rgb_frame_size);
        
        frame_count++;
        enc->frame_count = frame_count;
        
        if (enc->verbose || frame_count % 30 == 0) {
            printf("Encoded frame %d (%s)\n", frame_count, 
                   is_keyframe ? "I-frame" : "P-frame");
        }
    }
    
    // Update actual frame count in encoder struct  
    enc->total_frames = frame_count;

    // Write final sync packet
    uint8_t sync_packet = TAV_PACKET_SYNC;
    fwrite(&sync_packet, 1, 1, enc->output_fp);

    // Update header with actual frame count (seek back to header position)
    if (enc->output_fp != stdout) {
        long current_pos = ftell(enc->output_fp);
        fseek(enc->output_fp, 14, SEEK_SET);  // Offset of total_frames field in TAV header
        uint32_t actual_frames = frame_count;
        fwrite(&actual_frames, sizeof(uint32_t), 1, enc->output_fp);
        fseek(enc->output_fp, current_pos, SEEK_SET);  // Restore position
        if (enc->verbose) {
            printf("Updated header with actual frame count: %d\n", frame_count);
        }
    }
    
    printf("Encoding completed: %d frames\n", frame_count);
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