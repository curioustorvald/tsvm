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

#ifndef PI
#define PI 3.14159265358979323846f
#endif

// TSVM Advanced Video (TAV) format constants
#define TAV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x56"  // "\x1FTSVM TAV"
// TAV version - dynamic based on colour space mode
// Version 1: YCoCg-R (default) 
// Version 2: ICtCp (--ictcp flag)

// Tile encoding modes (280x224 tiles)
#define TAV_MODE_SKIP      0x00  // Skip tile (copy from reference)
#define TAV_MODE_INTRA     0x01  // Intra DWT coding (I-frame tiles)
#define TAV_MODE_DELTA     0x02  // Coefficient delta encoding (efficient P-frames)

// Video packet types
#define TAV_PACKET_IFRAME      0x10  // Intra frame (keyframe)
#define TAV_PACKET_PFRAME      0x11  // Predicted frame  
#define TAV_PACKET_AUDIO_MP2   0x20  // MP2 audio
#define TAV_PACKET_SUBTITLE    0x30  // Subtitle packet
#define TAV_PACKET_SYNC        0xFF  // Sync packet

// DWT settings
#define TILE_SIZE_X 280  // 280x224 tiles - better compression efficiency  
#define TILE_SIZE_Y 224  // Optimized for TSVM 560x448 (2×2 tiles exactly)
#define MAX_DECOMP_LEVELS 6  // Can go deeper: 280→140→70→35→17→8→4, 224→112→56→28→14→7→3

// Simulated overlapping tiles settings for seamless DWT processing
#define DWT_FILTER_HALF_SUPPORT 4  // For 9/7 filter (filter lengths 9,7 → L=4)
#define TILE_MARGIN_LEVELS 3       // Use margin for 3 levels: 4 * (2^3) = 4 * 8 = 32px
#define TILE_MARGIN (DWT_FILTER_HALF_SUPPORT * (1 << TILE_MARGIN_LEVELS))  // 4 * 8 = 32px
#define PADDED_TILE_SIZE_X (TILE_SIZE_X + 2 * TILE_MARGIN)  // 280 + 64 = 344px
#define PADDED_TILE_SIZE_Y (TILE_SIZE_Y + 2 * TILE_MARGIN)  // 224 + 64 = 288px

// Wavelet filter types
#define WAVELET_5_3_REVERSIBLE 0  // Lossless capable
#define WAVELET_9_7_IRREVERSIBLE 1  // Higher compression

// Default settings
#define DEFAULT_WIDTH 560
#define DEFAULT_HEIGHT 448
#define DEFAULT_FPS 30
#define DEFAULT_QUALITY 2
int KEYFRAME_INTERVAL = 60;

// Audio/subtitle constants (reused from TEV)
#define MP2_DEFAULT_PACKET_SIZE 1152
#define MAX_SUBTITLE_LENGTH 2048

// Subtitle structure
typedef struct subtitle_entry {
    int start_frame;
    int end_frame;
    char *text;
    struct subtitle_entry *next;
} subtitle_entry_t;

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

// Quality level to quantisation mapping for different channels
static const int QUALITY_Y[] = {60, 42, 25, 12, 6, 2};
static const int QUALITY_CO[] = {120, 90, 60, 30, 15, 3};
static const int QUALITY_CG[] = {240, 180, 120, 60, 30, 5};

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
    int quantiser_y, quantiser_co, quantiser_cg;
    int wavelet_filter;
    int decomp_levels;
    int bitrate_mode;
    int target_bitrate;
    
    // Flags
//    int progressive; // no interlaced mode for TAV
    int lossless;
    int enable_rcf;
    int enable_progressive_transmission;
    int enable_roi;
    int verbose;
    int test_mode;
    int ictcp_mode;       // 0 = YCoCg-R (default), 1 = ICtCp colour space
    int intra_only;       // Force all tiles to use INTRA mode (disable delta encoding)
    
    // Frame buffers
    uint8_t *current_frame_rgb;
    uint8_t *previous_frame_rgb;
    float *current_frame_y, *current_frame_co, *current_frame_cg;
    float *previous_frame_y, *previous_frame_co, *previous_frame_cg;
    
    // Tile processing
    int tiles_x, tiles_y;
    dwt_tile_t *tiles;

    // Audio processing (expanded from TEV)
    size_t audio_remaining;
    uint8_t *mp2_buffer;
    size_t mp2_buffer_size;
    int mp2_packet_size;
    int mp2_rate_index;
    int target_audio_buffer_size;
    double audio_frames_in_buffer;
    
    // Subtitle processing  
    subtitle_entry_t *subtitles;
    subtitle_entry_t *current_subtitle;
    int subtitle_visible;
    
    // Compression
    ZSTD_CCtx *zstd_ctx;
    void *compressed_buffer;
    size_t compressed_buffer_size;
    
    // OPTIMIZATION: Pre-allocated buffers to avoid malloc/free per tile
    int16_t *reusable_quantised_y;
    int16_t *reusable_quantised_co;
    int16_t *reusable_quantised_cg;
    
    // Coefficient delta storage for P-frames (previous frame's coefficients)
    float *previous_coeffs_y;   // Previous frame Y coefficients for all tiles
    float *previous_coeffs_co;  // Previous frame Co coefficients for all tiles 
    float *previous_coeffs_cg;  // Previous frame Cg coefficients for all tiles
    int previous_coeffs_allocated; // Flag to track allocation
    
    // Statistics
    size_t total_compressed_size;
    size_t total_uncompressed_size;

    // Progress tracking
    struct timeval start_time;

} tav_encoder_t;

// Wavelet filter constants removed - using lifting scheme implementation instead

// Function prototypes
static void show_usage(const char *program_name);
static tav_encoder_t* create_encoder(void);
static void cleanup_encoder(tav_encoder_t *enc);
static int initialize_encoder(tav_encoder_t *enc);
static void rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height);

// Audio and subtitle processing prototypes (from TEV)
static int start_audio_conversion(tav_encoder_t *enc);
static int get_mp2_packet_size(uint8_t *header);
static int mp2_packet_size_to_rate_index(int packet_size, int is_mono);
static int process_audio(tav_encoder_t *enc, int frame_num, FILE *output);
static subtitle_entry_t* parse_subtitle_file(const char *filename, int fps);
static subtitle_entry_t* parse_srt_file(const char *filename, int fps);
static subtitle_entry_t* parse_smi_file(const char *filename, int fps);
static int srt_time_to_frame(const char *time_str, int fps);
static int sami_ms_to_frame(int milliseconds, int fps);
static void free_subtitle_list(subtitle_entry_t *list);
static int write_subtitle_packet(FILE *output, uint32_t index, uint8_t opcode, const char *text);
static int process_subtitles(tav_encoder_t *enc, int frame_num, FILE *output);

// Show usage information
static void show_usage(const char *program_name) {
    printf("TAV DWT-based Video Encoder\n");
    printf("Usage: %s [options] -i input.mp4 -o output.mv3\n\n", program_name);
    printf("Options:\n");
    printf("  -i, --input FILE        Input video file\n");
    printf("  -o, --output FILE       Output video file (use '-' for stdout)\n");
    printf("  -s, --size WxH          Video size (default: %dx%d)\n", DEFAULT_WIDTH, DEFAULT_HEIGHT);
    printf("  -f, --fps N             Output frames per second (enables frame rate conversion)\n");
    printf("  -q, --quality N         Quality level 0-5 (default: 2)\n");
    printf("  -Q, --quantiser Y,Co,Cg Quantiser levels 0-100 for each channel\n");
//    printf("  -w, --wavelet N         Wavelet filter: 0=5/3 reversible, 1=9/7 irreversible (default: 1)\n");
//    printf("  -b, --bitrate N         Target bitrate in kbps (enables bitrate control mode)\n");
    printf("  -S, --subtitles FILE    SubRip (.srt) or SAMI (.smi) subtitle file\n");
    printf("  -v, --verbose           Verbose output\n");
    printf("  -t, --test              Test mode: generate solid colour frames\n");
    printf("  --lossless              Lossless mode: use 5/3 reversible wavelet\n");
    printf("  --delta-code            Enable delta encoding (improved compression but noisy picture)\n");
    printf("  --ictcp                 Use ICtCp colour space instead of YCoCg-R (use when source is in BT.2100)\n");
    printf("  --help                  Show this help\n\n");
    
    printf("Audio Rate by Quality:\n  ");
    for (int i = 0; i < sizeof(MP2_RATE_TABLE) / sizeof(int); i++) {
        printf("%d: %d kbps\t", i, MP2_RATE_TABLE[i]);
    }
    printf("\n\nQuantiser Value by Quality:\n");
    printf("  Y (Luma):    ");
    for (int i = 0; i < 6; i++) {
        printf("%d: Q %d  \t", i, QUALITY_Y[i]);
    }
    printf("\n  Co (Chroma): ");
    for (int i = 0; i < 6; i++) {
        printf("%d: Q %d  \t", i, QUALITY_CO[i]);
    }
    printf("\n  Cg (Chroma): ");
    for (int i = 0; i < 6; i++) {
        printf("%d: Q %d  \t", i, QUALITY_CG[i]);
    }
    
    printf("\n\nFeatures:\n");
    printf("  - 280x224 DWT tiles with multi-resolution encoding\n");
    printf("  - Full resolution YCoCg-R/ICtCp colour space\n");
    printf("  - Lossless and lossy compression modes\n");
    
    printf("\nExamples:\n");
    printf("  %s -i input.mp4 -o output.mv3               # Default settings\n", program_name);
    printf("  %s -i input.mkv -q 4 -w 1 -o output.mv3     # Maximum quality with 9/7 wavelet\n", program_name);
    printf("  %s -i input.avi --lossless -o output.mv3    # Lossless encoding\n", program_name);
//    printf("  %s -i input.mp4 -b 800 -o output.mv3        # 800 kbps bitrate target\n", program_name);
    printf("  %s -i input.webm -S subs.srt -o output.mv3  # With subtitles\n", program_name);
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
    enc->decomp_levels = MAX_DECOMP_LEVELS;
    enc->quantiser_y = QUALITY_Y[DEFAULT_QUALITY];
    enc->quantiser_co = QUALITY_CO[DEFAULT_QUALITY];
    enc->quantiser_cg = QUALITY_CG[DEFAULT_QUALITY];
    enc->intra_only = 1;

    return enc;
}

// Initialize encoder resources
static int initialize_encoder(tav_encoder_t *enc) {
    if (!enc) return -1;
    
    // Calculate tile dimensions
    enc->tiles_x = (enc->width + TILE_SIZE_X - 1) / TILE_SIZE_X;
    enc->tiles_y = (enc->height + TILE_SIZE_Y - 1) / TILE_SIZE_Y;
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

    // Initialize ZSTD compression
    enc->zstd_ctx = ZSTD_createCCtx();
    enc->compressed_buffer_size = ZSTD_compressBound(1024 * 1024); // 1MB max
    enc->compressed_buffer = malloc(enc->compressed_buffer_size);
    
    // OPTIMIZATION: Allocate reusable quantisation buffers for padded tiles (344x288)
    const int padded_coeff_count = PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y;
    enc->reusable_quantised_y = malloc(padded_coeff_count * sizeof(int16_t));
    enc->reusable_quantised_co = malloc(padded_coeff_count * sizeof(int16_t));
    enc->reusable_quantised_cg = malloc(padded_coeff_count * sizeof(int16_t));
    
    // Allocate coefficient delta storage for P-frames (per-tile coefficient storage)
    size_t total_coeff_size = num_tiles * padded_coeff_count * sizeof(float);
    enc->previous_coeffs_y = malloc(total_coeff_size);
    enc->previous_coeffs_co = malloc(total_coeff_size);
    enc->previous_coeffs_cg = malloc(total_coeff_size);
    enc->previous_coeffs_allocated = 0; // Will be set to 1 after first I-frame
    
    if (!enc->current_frame_rgb || !enc->previous_frame_rgb || 
        !enc->current_frame_y || !enc->current_frame_co || !enc->current_frame_cg ||
        !enc->previous_frame_y || !enc->previous_frame_co || !enc->previous_frame_cg ||
        !enc->tiles || !enc->zstd_ctx || !enc->compressed_buffer ||
        !enc->reusable_quantised_y || !enc->reusable_quantised_co || !enc->reusable_quantised_cg ||
        !enc->previous_coeffs_y || !enc->previous_coeffs_co || !enc->previous_coeffs_cg) {
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
    int half = (length + 1) / 2;  // Handle odd lengths properly
    
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


// 1D DWT using lifting scheme for 9/7 irreversible filter
static void dwt_97_forward_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;  // Handle odd lengths properly

    // Split into even/odd samples
    for (int i = 0; i < half; i++) {
        temp[i] = data[2 * i];           // Even (low)
    }
    for (int i = 0; i < length / 2; i++) {
        temp[half + i] = data[2 * i + 1]; // Odd (high)
    }

    // JPEG2000 9/7 forward lifting steps (corrected to match decoder)
    const float alpha = -1.586134342f;
    const float beta = -0.052980118f;
    const float gamma = 0.882911076f;
    const float delta = 0.443506852f;
    const float K = 1.230174105f;

    // Step 1: Predict α - d[i] += α * (s[i] + s[i+1])
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] += alpha * (s_curr + s_next);
        }
    }

    // Step 2: Update β - s[i] += β * (d[i-1] + d[i])
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] += beta * (d_prev + d_curr);
    }

    // Step 3: Predict γ - d[i] += γ * (s[i] + s[i+1])
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] += gamma * (s_curr + s_next);
        }
    }

    // Step 4: Update δ - s[i] += δ * (d[i-1] + d[i])
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] += delta * (d_prev + d_curr);
    }

    // Step 5: Scaling - s[i] *= K, d[i] /= K
    for (int i = 0; i < half; i++) {
        temp[i] *= K;  // Low-pass coefficients
    }
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            temp[half + i] /= K;  // High-pass coefficients
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// Extract padded tile with margins for seamless DWT processing (correct implementation)
static void extract_padded_tile(tav_encoder_t *enc, int tile_x, int tile_y, 
                               float *padded_y, float *padded_co, float *padded_cg) {
    const int core_start_x = tile_x * TILE_SIZE_X;
    const int core_start_y = tile_y * TILE_SIZE_Y;
    
    // OPTIMIZATION: Process row by row with bulk copying for core region
    for (int py = 0; py < PADDED_TILE_SIZE_Y; py++) {
        // Map padded row to source image row
        int src_y = core_start_y + py - TILE_MARGIN;
        
        // Handle vertical boundary conditions with mirroring
        if (src_y < 0) src_y = -src_y;
        else if (src_y >= enc->height) src_y = enc->height - 1 - (src_y - enc->height);
        src_y = CLAMP(src_y, 0, enc->height - 1);
        
        // Calculate source and destination row offsets
        const int padded_row_offset = py * PADDED_TILE_SIZE_X;
        const int src_row_offset = src_y * enc->width;
        
        // Check if we can do bulk copying for the core region
        int core_start_px = TILE_MARGIN;
        int core_end_px = TILE_MARGIN + TILE_SIZE_X;
        
        // Check if core region is entirely within frame bounds
        int core_src_start_x = core_start_x;
        int core_src_end_x = core_start_x + TILE_SIZE_X;
        
        if (core_src_start_x >= 0 && core_src_end_x <= enc->width) {
            // OPTIMIZATION: Bulk copy core region (280 pixels) in one operation
            const int src_core_offset = src_row_offset + core_src_start_x;
            
            memcpy(&padded_y[padded_row_offset + core_start_px], 
                   &enc->current_frame_y[src_core_offset], 
                   TILE_SIZE_X * sizeof(float));
            memcpy(&padded_co[padded_row_offset + core_start_px], 
                   &enc->current_frame_co[src_core_offset], 
                   TILE_SIZE_X * sizeof(float));
            memcpy(&padded_cg[padded_row_offset + core_start_px], 
                   &enc->current_frame_cg[src_core_offset], 
                   TILE_SIZE_X * sizeof(float));
            
            // Handle margin pixels individually (left and right margins)
            for (int px = 0; px < core_start_px; px++) {
                int src_x = core_start_x + px - TILE_MARGIN;
                if (src_x < 0) src_x = -src_x;
                src_x = CLAMP(src_x, 0, enc->width - 1);
                
                int src_idx = src_row_offset + src_x;
                int padded_idx = padded_row_offset + px;
                
                padded_y[padded_idx] = enc->current_frame_y[src_idx];
                padded_co[padded_idx] = enc->current_frame_co[src_idx];
                padded_cg[padded_idx] = enc->current_frame_cg[src_idx];
            }
            
            for (int px = core_end_px; px < PADDED_TILE_SIZE_X; px++) {
                int src_x = core_start_x + px - TILE_MARGIN;
                if (src_x >= enc->width) src_x = enc->width - 1 - (src_x - enc->width);
                src_x = CLAMP(src_x, 0, enc->width - 1);
                
                int src_idx = src_row_offset + src_x;
                int padded_idx = padded_row_offset + px;
                
                padded_y[padded_idx] = enc->current_frame_y[src_idx];
                padded_co[padded_idx] = enc->current_frame_co[src_idx];
                padded_cg[padded_idx] = enc->current_frame_cg[src_idx];
            }
        } else {
            // Fallback: process entire row pixel by pixel (for edge tiles)
            for (int px = 0; px < PADDED_TILE_SIZE_X; px++) {
                int src_x = core_start_x + px - TILE_MARGIN;
                
                // Handle horizontal boundary conditions with mirroring
                if (src_x < 0) src_x = -src_x;
                else if (src_x >= enc->width) src_x = enc->width - 1 - (src_x - enc->width);
                src_x = CLAMP(src_x, 0, enc->width - 1);
                
                int src_idx = src_row_offset + src_x;
                int padded_idx = padded_row_offset + px;
                
                padded_y[padded_idx] = enc->current_frame_y[src_idx];
                padded_co[padded_idx] = enc->current_frame_co[src_idx];
                padded_cg[padded_idx] = enc->current_frame_cg[src_idx];
            }
        }
    }
}


// 2D DWT forward transform for rectangular padded tile (344x288)
static void dwt_2d_forward_padded(float *tile_data, int levels, int filter_type) {
    const int width = PADDED_TILE_SIZE_X;   // 344
    const int height = PADDED_TILE_SIZE_Y;  // 288
    const int max_size = (width > height) ? width : height;
    float *temp_row = malloc(max_size * sizeof(float));
    float *temp_col = malloc(max_size * sizeof(float));
    
    for (int level = 0; level < levels; level++) {
        int current_width = width >> level;
        int current_height = height >> level;
        if (current_width < 1 || current_height < 1) break;
        
        // Row transform (horizontal)
        for (int y = 0; y < current_height; y++) {
            for (int x = 0; x < current_width; x++) {
                temp_row[x] = tile_data[y * width + x];
            }
            
            if (filter_type == WAVELET_5_3_REVERSIBLE) {
                dwt_53_forward_1d(temp_row, current_width);
            } else {
                dwt_97_forward_1d(temp_row, current_width);
            }
            
            for (int x = 0; x < current_width; x++) {
                tile_data[y * width + x] = temp_row[x];
            }
        }
        
        // Column transform (vertical)
        for (int x = 0; x < current_width; x++) {
            for (int y = 0; y < current_height; y++) {
                temp_col[y] = tile_data[y * width + x];
            }
            
            if (filter_type == WAVELET_5_3_REVERSIBLE) {
                dwt_53_forward_1d(temp_col, current_height);
            } else {
                dwt_97_forward_1d(temp_col, current_height);
            }
            
            for (int y = 0; y < current_height; y++) {
                tile_data[y * width + x] = temp_col[y];
            }
        }
    }
    
    free(temp_row);
    free(temp_col);
}




// Quantisation for DWT subbands with rate control
static void quantise_dwt_coefficients(float *coeffs, int16_t *quantised, int size, int quantiser) {
    float effective_q = quantiser;
    effective_q = FCLAMP(effective_q, 1.0f, 255.0f);
    
    for (int i = 0; i < size; i++) {
        float quantised_val = coeffs[i] / effective_q;
        quantised[i] = (int16_t)CLAMP((int)(quantised_val + (quantised_val >= 0 ? 0.5f : -0.5f)), -32768, 32767);
    }
}

// Serialize tile data for compression
static size_t serialize_tile_data(tav_encoder_t *enc, int tile_x, int tile_y, 
                                  const float *tile_y_data, const float *tile_co_data, const float *tile_cg_data,
                                  uint8_t mode, uint8_t *buffer) {
    size_t offset = 0;
    
    // Write tile header
    buffer[offset++] = mode;

    // TODO calculate frame complexity and create quantiser overrides
    buffer[offset++] = 0; // qY  override
    buffer[offset++] = 0; // qCo override
    buffer[offset++] = 0; // qCg override

    if (mode == TAV_MODE_SKIP) {
        // No coefficient data for SKIP/MOTION modes
        return offset;
    }
    
    // Quantise and serialize DWT coefficients (full padded tile: 344x288)
    const int tile_size = PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y;
    // OPTIMIZATION: Use pre-allocated buffers instead of malloc/free per tile
    int16_t *quantised_y = enc->reusable_quantised_y;
    int16_t *quantised_co = enc->reusable_quantised_co;
    int16_t *quantised_cg = enc->reusable_quantised_cg;
    
    // Debug: check DWT coefficients before quantisation
    /*if (tile_x == 0 && tile_y == 0) {
        printf("Encoder Debug: Tile (0,0) - DWT Y coeffs before quantisation (first 16): ");
        for (int i = 0; i < 16; i++) {
            printf("%.2f ", tile_y_data[i]);
        }
        printf("\n");
        printf("Encoder Debug: Quantisers - Y=%d, Co=%d, Cg=%d, rcf=%.2f\n", 
               enc->quantiser_y, enc->quantiser_co, enc->quantiser_cg);
    }*/
    
    if (mode == TAV_MODE_INTRA) {
        // INTRA mode: quantise coefficients directly and store for future reference
        quantise_dwt_coefficients((float*)tile_y_data, quantised_y, tile_size, enc->quantiser_y);
        quantise_dwt_coefficients((float*)tile_co_data, quantised_co, tile_size, enc->quantiser_co);
        quantise_dwt_coefficients((float*)tile_cg_data, quantised_cg, tile_size, enc->quantiser_cg);
        
        // Store current coefficients for future delta reference
        int tile_idx = tile_y * enc->tiles_x + tile_x;
        float *prev_y = enc->previous_coeffs_y + (tile_idx * tile_size);
        float *prev_co = enc->previous_coeffs_co + (tile_idx * tile_size);
        float *prev_cg = enc->previous_coeffs_cg + (tile_idx * tile_size);
        memcpy(prev_y, tile_y_data, tile_size * sizeof(float));
        memcpy(prev_co, tile_co_data, tile_size * sizeof(float));
        memcpy(prev_cg, tile_cg_data, tile_size * sizeof(float));
        
    } else if (mode == TAV_MODE_DELTA) {
        // DELTA mode: compute coefficient deltas and quantise them
        int tile_idx = tile_y * enc->tiles_x + tile_x;
        float *prev_y = enc->previous_coeffs_y + (tile_idx * tile_size);
        float *prev_co = enc->previous_coeffs_co + (tile_idx * tile_size);
        float *prev_cg = enc->previous_coeffs_cg + (tile_idx * tile_size);
        
        // Compute deltas: delta = current - previous
        float *delta_y = malloc(tile_size * sizeof(float));
        float *delta_co = malloc(tile_size * sizeof(float));
        float *delta_cg = malloc(tile_size * sizeof(float));
        
        for (int i = 0; i < tile_size; i++) {
            delta_y[i] = tile_y_data[i] - prev_y[i];
            delta_co[i] = tile_co_data[i] - prev_co[i];
            delta_cg[i] = tile_cg_data[i] - prev_cg[i];
        }
        
        // Quantise the deltas
        quantise_dwt_coefficients(delta_y, quantised_y, tile_size, enc->quantiser_y);
        quantise_dwt_coefficients(delta_co, quantised_co, tile_size, enc->quantiser_co);
        quantise_dwt_coefficients(delta_cg, quantised_cg, tile_size, enc->quantiser_cg);
        
        // Reconstruct coefficients like decoder will (previous + dequantised_delta)
        for (int i = 0; i < tile_size; i++) {
            float dequant_delta_y = (float)quantised_y[i] * enc->quantiser_y;
            float dequant_delta_co = (float)quantised_co[i] * enc->quantiser_co;
            float dequant_delta_cg = (float)quantised_cg[i] * enc->quantiser_cg;
            
            prev_y[i] = prev_y[i] + dequant_delta_y;
            prev_co[i] = prev_co[i] + dequant_delta_co;
            prev_cg[i] = prev_cg[i] + dequant_delta_cg;
        }
        
        free(delta_y);
        free(delta_co);
        free(delta_cg);
    }
    
    // Debug: check quantised coefficients after quantisation
    /*if (tile_x == 0 && tile_y == 0) {
        printf("Encoder Debug: Tile (0,0) - Quantised Y coeffs (first 16): ");
        for (int i = 0; i < 16; i++) {
            printf("%d ", quantised_y[i]);
        }
        printf("\n");
    }*/
    
    // Write quantised coefficients
    memcpy(buffer + offset, quantised_y, tile_size * sizeof(int16_t)); offset += tile_size * sizeof(int16_t);
    memcpy(buffer + offset, quantised_co, tile_size * sizeof(int16_t)); offset += tile_size * sizeof(int16_t);
    memcpy(buffer + offset, quantised_cg, tile_size * sizeof(int16_t)); offset += tile_size * sizeof(int16_t);
    
    // OPTIMIZATION: No need to free - using pre-allocated reusable buffers
    
    return offset;
}

// Compress and write frame data
static size_t compress_and_write_frame(tav_encoder_t *enc, uint8_t packet_type) {
    // Calculate total uncompressed size (for padded tile coefficients: 344x288)
    const size_t max_tile_size = 4 + (PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y * 3 * sizeof(int16_t));  // header + 3 channels of coefficients
    const size_t total_uncompressed_size = enc->tiles_x * enc->tiles_y * max_tile_size;
    
    // Allocate buffer for uncompressed tile data
    uint8_t *uncompressed_buffer = malloc(total_uncompressed_size);
    size_t uncompressed_offset = 0;
    
    // Serialize all tiles
    for (int tile_y = 0; tile_y < enc->tiles_y; tile_y++) {
        for (int tile_x = 0; tile_x < enc->tiles_x; tile_x++) {
            int tile_idx = tile_y * enc->tiles_x + tile_x;
            
            // Determine tile mode based on frame type, coefficient availability, and intra_only flag
            uint8_t mode;
            int is_keyframe = (packet_type == TAV_PACKET_IFRAME);
            if (is_keyframe || !enc->previous_coeffs_allocated) {
                mode = TAV_MODE_INTRA;  // I-frames, first frames, or intra-only mode always use INTRA
            } else {
                mode = TAV_MODE_DELTA;  // P-frames use coefficient delta encoding
            }
            
            // Extract padded tile data (344x288) with neighbour context for overlapping tiles
            float tile_y_data[PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y];
            float tile_co_data[PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y];
            float tile_cg_data[PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y];
            
            // Extract padded tiles using context from neighbours
            extract_padded_tile(enc, tile_x, tile_y, tile_y_data, tile_co_data, tile_cg_data);
            
            // Debug: check input data before DWT
            /*if (tile_x == 0 && tile_y == 0) {
                printf("Encoder Debug: Tile (0,0) - Y data before DWT (first 16): ");
                for (int i = 0; i < 16; i++) {
                    printf("%.2f ", tile_y_data[i]);
                }
                printf("\n");
            }*/
            
            // Apply DWT transform to each padded channel (176x176)
            dwt_2d_forward_padded(tile_y_data, enc->decomp_levels, enc->wavelet_filter);
            dwt_2d_forward_padded(tile_co_data, enc->decomp_levels, enc->wavelet_filter);
            dwt_2d_forward_padded(tile_cg_data, enc->decomp_levels, enc->wavelet_filter);
            
            // Serialize tile
            size_t tile_size = serialize_tile_data(enc, tile_x, tile_y, 
                                                   tile_y_data, tile_co_data, tile_cg_data,
                                                   mode, uncompressed_buffer + uncompressed_offset);
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
    
    // Mark coefficient storage as available after first I-frame
    if (packet_type == TAV_PACKET_IFRAME) {
        enc->previous_coeffs_allocated = 1;
    }
    
    return compressed_size + 5; // packet type + size field + compressed data
}

// RGB to YCoCg colour space conversion
static void rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height) {
    const int total_pixels = width * height;
    
    // OPTIMIZATION: Process 4 pixels at a time for better cache utilization
    int i = 0;
    const int simd_end = (total_pixels / 4) * 4;
    
    // Vectorized processing for groups of 4 pixels
    for (i = 0; i < simd_end; i += 4) {
        // Load 4 RGB triplets (12 bytes) at once
        const uint8_t *rgb_ptr = &rgb[i * 3];
        
        // Process 4 pixels simultaneously with loop unrolling
        for (int j = 0; j < 4; j++) {
            const int idx = i + j;
            const float r = rgb_ptr[j * 3 + 0];
            const float g = rgb_ptr[j * 3 + 1]; 
            const float b = rgb_ptr[j * 3 + 2];
            
            // YCoCg-R transform (optimised with fewer temporary variables)
            co[idx] = r - b;
            const float tmp = b + co[idx] * 0.5f;
            cg[idx] = g - tmp;
            y[idx] = tmp + cg[idx] * 0.5f;
        }
    }
    
    // Handle remaining pixels (1-3 pixels)
    for (; i < total_pixels; i++) {
        const float r = rgb[i * 3 + 0];
        const float g = rgb[i * 3 + 1]; 
        const float b = rgb[i * 3 + 2];
        
        co[i] = r - b;
        const float tmp = b + co[i] * 0.5f;
        cg[i] = g - tmp;
        y[i] = tmp + cg[i] * 0.5f;
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
/*static const double M_RGB_TO_LMS[3][3] = {
    {0.2958564579364564, 0.6230869483219083, 0.08106989398623762},
    {0.15627390752659093, 0.727308963512872, 0.11639736914944238},
    {0.035141262332177715, 0.15657109121101628, 0.8080956851990795}
};*/
// BT.2100 -> LMS matrix
static const double M_RGB_TO_LMS[3][3] = {
    {1688.0/4096,2146.0/4096, 262.0/4096},
    { 683.0/4096,2951.0/4096, 462.0/4096},
    {  99.0/4096, 309.0/4096,3688.0/4096}
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

// ---------------------- Colour Space Switching Functions ----------------------
// Wrapper functions that choose between YCoCg-R and ICtCp based on encoder mode

static void rgb_to_colour_space(tav_encoder_t *enc, uint8_t r, uint8_t g, uint8_t b,
                               double *c1, double *c2, double *c3) {
    if (enc->ictcp_mode) {
        // Use ICtCp colour space
        srgb8_to_ictcp_hlg(r, g, b, c1, c2, c3);
    } else {
        // Use YCoCg-R colour space (convert from existing function)
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

static void colour_space_to_rgb(tav_encoder_t *enc, double c1, double c2, double c3,
                               uint8_t *r, uint8_t *g, uint8_t *b) {
    if (enc->ictcp_mode) {
        // Use ICtCp colour space
        ictcp_hlg_to_srgb8(c1, c2, c3, r, g, b);
    } else {
        // Use YCoCg-R colour space (inverse of rgb_to_ycocg)
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

// RGB to colour space conversion for full frames
static void rgb_to_colour_space_frame(tav_encoder_t *enc, const uint8_t *rgb, 
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
    
    // Version (dynamic based on colour space)
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
    fputc(enc->quantiser_y, enc->output_fp);
    fputc(enc->quantiser_co, enc->output_fp);
    fputc(enc->quantiser_cg, enc->output_fp);
    
    // Feature flags
    uint8_t extra_flags = 0;
    if (enc->has_audio) extra_flags |= 0x01;  // Has audio (placeholder)
    if (enc->subtitle_file) extra_flags |= 0x02;  // Has subtitles
    if (enc->enable_progressive_transmission) extra_flags |= 0x04;
    if (enc->enable_roi) extra_flags |= 0x08;
    fputc(extra_flags, enc->output_fp);
    
    uint8_t video_flags = 0;
//    if (!enc->progressive) video_flags |= 0x01;  // Interlaced
    if (enc->is_ntsc_framerate) video_flags |= 0x02;  // NTSC
    if (enc->lossless) video_flags |= 0x04;  // Lossless
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
//    fprintf(stderr, "  Resolution: %dx%d (%s)\n", config->width, config->height,
//            config->progressive ? "progressive" : "interlaced");
    fprintf(stderr, "  Resolution: %dx%d\n", config->width, config->height);

    return 1;
}

// Start FFmpeg process for video conversion with frame rate support
static int start_video_conversion(tav_encoder_t *enc) {
    char command[2048];

    // Use simple FFmpeg command like TEV encoder for reliable EOF detection
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

// Get MP2 packet size from header (copied from TEV)
static int get_mp2_packet_size(uint8_t *header) {
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

// Convert MP2 packet size to rate index (copied from TEV)
static int mp2_packet_size_to_rate_index(int packet_size, int is_mono) {
    // Map packet size to rate index for MP2_RATE_TABLE
    if (packet_size <= 576) return is_mono ? 0 : 0;      // 128k
    else if (packet_size <= 720) return 1;               // 160k
    else if (packet_size <= 1008) return 2;              // 224k
    else if (packet_size <= 1440) return 3;              // 320k
    else return 4;                                        // 384k
}

// Convert SRT time format to frame number (copied from TEV)
static int srt_time_to_frame(const char *time_str, int fps) {
    int hours, minutes, seconds, milliseconds;
    if (sscanf(time_str, "%d:%d:%d,%d", &hours, &minutes, &seconds, &milliseconds) != 4) {
        return -1;
    }
    
    double total_seconds = hours * 3600.0 + minutes * 60.0 + seconds + milliseconds / 1000.0;
    return (int)(total_seconds * fps + 0.5);  // Round to nearest frame
}

// Convert SAMI milliseconds to frame number (copied from TEV)
static int sami_ms_to_frame(int milliseconds, int fps) {
    double seconds = milliseconds / 1000.0;
    return (int)(seconds * fps + 0.5);  // Round to nearest frame
}

// Parse SubRip subtitle file (copied from TEV)
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
                        fprintf(stderr, "Memory reallocation failed while parsing subtitles\n");
                        break;
                    }
                    text_buffer = new_buffer;
                }
                
                if (current_len > 0) {
                    strcat(text_buffer, "\\n");  // Use \n as newline marker in subtitle text
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
    if (current_entry && state == 2) {
        current_entry->text = strdup(text_buffer);
        if (!head) {
            head = current_entry;
        } else {
            tail->next = current_entry;
        }
        free(text_buffer);
    }
    
    fclose(file);
    return head;
}

// Parse SAMI subtitle file (simplified version from TEV)
static subtitle_entry_t* parse_smi_file(const char *filename, int fps) {
    FILE *file = fopen(filename, "r");
    if (!file) {
        fprintf(stderr, "Failed to open subtitle file: %s\n", filename);
        return NULL;
    }
    
    subtitle_entry_t *head = NULL;
    subtitle_entry_t *tail = NULL;
    char line[2048];
    
    while (fgets(line, sizeof(line), file)) {
        // Look for SYNC tags with Start= attribute
        char *sync_pos = strstr(line, "<SYNC");
        if (sync_pos) {
            char *start_pos = strstr(sync_pos, "Start=");
            if (start_pos) {
                int start_ms;
                if (sscanf(start_pos, "Start=%d", &start_ms) == 1) {
                    // Look for P tag with subtitle text
                    char *p_start = strstr(sync_pos, "<P");
                    if (p_start) {
                        char *text_start = strchr(p_start, '>');
                        if (text_start) {
                            text_start++;
                            char *text_end = strstr(text_start, "</P>");
                            if (text_end) {
                                size_t text_len = text_end - text_start;
                                if (text_len > 0 && text_len < MAX_SUBTITLE_LENGTH) {
                                    subtitle_entry_t *entry = calloc(1, sizeof(subtitle_entry_t));
                                    if (entry) {
                                        entry->start_frame = sami_ms_to_frame(start_ms, fps);
                                        entry->end_frame = entry->start_frame + fps * 3;  // Default 3 second duration
                                        entry->text = strndup(text_start, text_len);
                                        
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
                        }
                    }
                }
            }
        }
    }
    
    fclose(file);
    return head;
}

// Parse subtitle file based on extension (copied from TEV)
static subtitle_entry_t* parse_subtitle_file(const char *filename, int fps) {
    if (!filename) return NULL;
    
    size_t len = strlen(filename);
    if (len > 4 && strcasecmp(filename + len - 4, ".smi") == 0) {
        return parse_smi_file(filename, fps);
    } else {
        return parse_srt_file(filename, fps);
    }
}

// Free subtitle list (copied from TEV)
static void free_subtitle_list(subtitle_entry_t *list) {
    while (list) {
        subtitle_entry_t *next = list->next;
        free(list->text);
        free(list);
        list = next;
    }
}

// Write subtitle packet (copied from TEV)
static int write_subtitle_packet(FILE *output, uint32_t index, uint8_t opcode, const char *text) {
    // Calculate packet size
    size_t text_len = text ? strlen(text) : 0;
    size_t packet_size = 3 + 1 + text_len + 1;  // index (3 bytes) + opcode + text + null terminator
    
    // Write packet type and size
    uint8_t packet_type = TAV_PACKET_SUBTITLE;
    fwrite(&packet_type, 1, 1, output);
    uint32_t size32 = (uint32_t)packet_size;
    fwrite(&size32, 4, 1, output);
    
    // Write subtitle data
    uint8_t index_bytes[3] = {
        (uint8_t)(index & 0xFF),
        (uint8_t)((index >> 8) & 0xFF),
        (uint8_t)((index >> 16) & 0xFF)
    };
    fwrite(index_bytes, 3, 1, output);
    fwrite(&opcode, 1, 1, output);
    
    if (text && text_len > 0) {
        fwrite(text, 1, text_len, output);
    }
    
    uint8_t null_terminator = 0;
    fwrite(&null_terminator, 1, 1, output);
    
    return 1 + 4 + packet_size;  // Total bytes written
}

// Process audio for current frame (copied and adapted from TEV)
static int process_audio(tav_encoder_t *enc, int frame_num, FILE *output) {
    if (!enc->has_audio || !enc->mp2_file || enc->audio_remaining <= 0) {
        return 1;
    }

    // Initialize packet size on first frame
    if (frame_num == 0) {
        uint8_t header[4];
        if (fread(header, 1, 4, enc->mp2_file) != 4) return 1;
        fseek(enc->mp2_file, 0, SEEK_SET);
        enc->mp2_packet_size = get_mp2_packet_size(header);
        int is_mono = (header[3] >> 6) == 3;
        enc->mp2_rate_index = mp2_packet_size_to_rate_index(enc->mp2_packet_size, is_mono);
        enc->target_audio_buffer_size = 4; // 4 audio packets in buffer
        enc->audio_frames_in_buffer = 0.0;
    }

    // Calculate how much audio time each frame represents (in seconds)
    double frame_audio_time = 1.0 / enc->fps;

    // Calculate how much audio time each MP2 packet represents
    // MP2 frame contains 1152 samples at 32kHz = 0.036 seconds
    #define MP2_SAMPLE_RATE 32000
    double packet_audio_time = 1152.0 / MP2_SAMPLE_RATE;

    // Estimate how many packets we consume per video frame
    double packets_per_frame = frame_audio_time / packet_audio_time;

    // Allocate MP2 buffer if needed
    if (!enc->mp2_buffer) {
        enc->mp2_buffer_size = enc->mp2_packet_size * 2;  // Space for multiple packets
        enc->mp2_buffer = malloc(enc->mp2_buffer_size);
        if (!enc->mp2_buffer) {
            fprintf(stderr, "Failed to allocate audio buffer\n");
            return 1;
        }
    }

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

        // Write TAV MP2 audio packet
        uint8_t audio_packet_type = TAV_PACKET_AUDIO_MP2;
        uint32_t audio_len = (uint32_t)bytes_read;
        fwrite(&audio_packet_type, 1, 1, output);
        fwrite(&audio_len, 4, 1, output);
        fwrite(enc->mp2_buffer, 1, bytes_read, output);

        // Track audio bytes written
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

// Process subtitles for current frame (copied and adapted from TEV)
static int process_subtitles(tav_encoder_t *enc, int frame_num, FILE *output) {
    if (!enc->subtitles) {
        return 1;  // No subtitles to process
    }

    int bytes_written = 0;
    
    // Check if we need to show a new subtitle
    if (!enc->subtitle_visible) {
        subtitle_entry_t *sub = enc->current_subtitle;
        if (!sub) sub = enc->subtitles;  // Start from beginning if not set
        
        // Find next subtitle to show
        while (sub && sub->start_frame <= frame_num) {
            if (sub->end_frame > frame_num) {
                // This subtitle should be shown
                if (sub != enc->current_subtitle) {
                    enc->current_subtitle = sub;
                    enc->subtitle_visible = 1;
                    bytes_written += write_subtitle_packet(output, 0, 0x01, sub->text);
                    if (enc->verbose) {
                        printf("Frame %d: Showing subtitle: %.50s%s\n", 
                               frame_num, sub->text, strlen(sub->text) > 50 ? "..." : "");
                    }
                }
                break;
            }
            sub = sub->next;
        }
    }
    
    // Check if we need to hide current subtitle
    if (enc->subtitle_visible && enc->current_subtitle) {
        if (frame_num >= enc->current_subtitle->end_frame) {
            enc->subtitle_visible = 0;
            bytes_written += write_subtitle_packet(output, 0, 0x02, NULL);
            if (enc->verbose) {
                printf("Frame %d: Hiding subtitle\n", frame_num);
            }
        }
    }
    
    return bytes_written;
}

// Detect scene changes by analysing frame differences
static int detect_scene_change(tav_encoder_t *enc) {
    if (!enc->current_frame_rgb || enc->intra_only) {
        return 0; // No current frame to compare
    }

    uint8_t *comparison_buffer = enc->previous_frame_rgb;

    long long total_diff = 0;
    int changed_pixels = 0;

    // Sample every 4th pixel for performance (still gives good detection)
    for (int y = 0; y < enc->height; y += 2) {
        for (int x = 0; x < enc->width; x += 2) {
            int offset = (y * enc->width + x) * 3;

            // Calculate color difference
            int r_diff = abs(enc->current_frame_rgb[offset] - comparison_buffer[offset]);
            int g_diff = abs(enc->current_frame_rgb[offset + 1] - comparison_buffer[offset + 1]);
            int b_diff = abs(enc->current_frame_rgb[offset + 2] - comparison_buffer[offset + 2]);

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
        {"quantiser", required_argument, 0, 'Q'},
        {"quantizer", required_argument, 0, 'Q'},
//        {"wavelet", required_argument, 0, 'w'},
//        {"decomp", required_argument, 0, 'd'},
        {"bitrate", required_argument, 0, 'b'},
//        {"progressive", no_argument, 0, 'p'},
        {"subtitles", required_argument, 0, 'S'},
        {"verbose", no_argument, 0, 'v'},
        {"test", no_argument, 0, 't'},
        {"lossless", no_argument, 0, 1000},
//        {"enable-progressive", no_argument, 0, 1002},
//        {"enable-roi", no_argument, 0, 1003},
        {"delta-code", no_argument, 0, 1006},
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
                enc->quantiser_y = QUALITY_Y[enc->quality_level];
                enc->quantiser_co = QUALITY_CO[enc->quality_level];
                enc->quantiser_cg = QUALITY_CG[enc->quality_level];
                break;
            case 'Q':
                // Parse quantiser values Y,Co,Cg
                if (sscanf(optarg, "%d,%d,%d", &enc->quantiser_y, &enc->quantiser_co, &enc->quantiser_cg) != 3) {
                    fprintf(stderr, "Error: Invalid quantiser format. Use Y,Co,Cg (e.g., 5,3,2)\n");
                    cleanup_encoder(enc);
                    return 1;
                }
                enc->quantiser_y = CLAMP(enc->quantiser_y, 1, 255);
                enc->quantiser_co = CLAMP(enc->quantiser_co, 1, 255);
                enc->quantiser_cg = CLAMP(enc->quantiser_cg, 1, 255);
                break;
            /*case 'w':
                enc->wavelet_filter = CLAMP(atoi(optarg), 0, 1);
                break;*/
            case 'f':
                enc->output_fps = atoi(optarg);
                enc->is_ntsc_framerate = 0;
                if (enc->output_fps <= 0) {
                    fprintf(stderr, "Invalid FPS: %d\n", enc->output_fps);
                    cleanup_encoder(enc);
                    return 1;
                }
                break;
            /*case 'd':
                enc->decomp_levels = CLAMP(atoi(optarg), 1, MAX_DECOMP_LEVELS);
                break;*/
            case 'v':
                enc->verbose = 1;
                break;
            case 't':
                enc->test_mode = 1;
                break;
            case 'S':
                enc->subtitle_file = strdup(optarg);
                break;
            case 1000: // --lossless
                enc->lossless = 1;
                enc->wavelet_filter = WAVELET_5_3_REVERSIBLE;
                break;
            case 1005: // --ictcp
                enc->ictcp_mode = 1;
                break;
            case 1006: // --intra-only
                enc->intra_only = 0;
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

    // adjust encoding parameters for ICtCp
    if (enc->ictcp_mode) {
        enc->quantiser_cg = enc->quantiser_co;
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
    if (enc->ictcp_mode) {
        printf("Quantiser: I=%d, Ct=%d, Cp=%d\n", enc->quantiser_y, enc->quantiser_co, enc->quantiser_cg);
    } else {
        printf("Quantiser: Y=%d, Co=%d, Cg=%d\n", enc->quantiser_y, enc->quantiser_co, enc->quantiser_cg);
    }
    printf("Colour space: %s\n", enc->ictcp_mode ? "ICtCp" : "YCoCg-R");
    
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
        // Test mode - generate solid colour frames
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
    
    // Parse subtitles if provided
    if (enc->subtitle_file) {
        printf("Parsing subtitles: %s\n", enc->subtitle_file);
        enc->subtitles = parse_subtitle_file(enc->subtitle_file, enc->fps);
        if (!enc->subtitles) {
            fprintf(stderr, "Warning: Failed to parse subtitle file\n");
        } else {
            printf("Loaded subtitles successfully\n");
        }
    }
    
    // Write TAV header
    if (write_tav_header(enc) != 0) {
        fprintf(stderr, "Error: Failed to write TAV header\n");
        cleanup_encoder(enc);
        return 1;
    }

    gettimeofday(&enc->start_time, NULL);

    if (enc->output_fps != enc->fps) {
        printf("Frame rate conversion enabled: %d fps output\n", enc->output_fps);
    }
    
    printf("Starting encoding...\n");
    
    // Main encoding loop - process frames until EOF or frame limit
    int frame_count = 0;
    int continue_encoding = 1;

    int count_iframe = 0;
    int count_pframe = 0;
    
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
        int is_scene_change = detect_scene_change(enc);
        int is_time_keyframe = (frame_count % KEYFRAME_INTERVAL) == 0;
        int is_keyframe = enc->intra_only || is_time_keyframe || is_scene_change;

        // Verbose output for keyframe decisions
        /*if (enc->verbose && is_keyframe) {
            if (is_scene_change && !is_time_keyframe) {
                printf("Frame %d: Scene change detected, inserting keyframe\n", frame_count);
            } else if (is_time_keyframe) {
                printf("Frame %d: Time-based keyframe (interval: %d)\n", frame_count, KEYFRAME_INTERVAL);
            }
        }*/

        // Debug: check RGB input data
        /*if (frame_count < 3) {
            printf("Encoder Debug: Frame %d - RGB data (first 16 bytes): ", frame_count);
            for (int i = 0; i < 16; i++) {
                printf("%d ", enc->current_frame_rgb[i]);
            }
            printf("\n");
        }*/
        
        // Convert RGB to colour space (YCoCg-R or ICtCp)
        rgb_to_colour_space_frame(enc, enc->current_frame_rgb, 
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
        
        // Compress and write frame packet
        uint8_t packet_type = is_keyframe ? TAV_PACKET_IFRAME : TAV_PACKET_PFRAME;
        size_t packet_size = compress_and_write_frame(enc, packet_type);
        
        if (packet_size == 0) {
            fprintf(stderr, "Error: Failed to compress frame %d\n", frame_count);
            break;
        }
        else {
            // Process audio for this frame
            process_audio(enc, frame_count, enc->output_fp);
            
            // Process subtitles for this frame
            process_subtitles(enc, frame_count, enc->output_fp);
            
            // Write a sync packet only after a video is been coded
            uint8_t sync_packet = TAV_PACKET_SYNC;
            fwrite(&sync_packet, 1, 1, enc->output_fp);

            // NTSC frame duplication: emit extra sync packet for every 1000n+500 frames
            if (enc->is_ntsc_framerate && (frame_count % 1000 == 500)) {
                fwrite(&sync_packet, 1, 1, enc->output_fp);
                printf("Frame %d: NTSC duplication - extra sync packet emitted\n", frame_count);
            }

            if (is_keyframe)
                count_iframe++;
            else
                count_pframe++;
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
            struct timeval now;
            gettimeofday(&now, NULL);
            double elapsed = (now.tv_sec - enc->start_time.tv_sec) +
                           (now.tv_usec - enc->start_time.tv_usec) / 1000000.0;
            double fps = frame_count / elapsed;
            printf("Encoded frame %d (%s, %.1f fps)\n", frame_count,
                   is_keyframe ? "I-frame" : "P-frame", fps);
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

    // Final statistics
    struct timeval end_time;
    gettimeofday(&end_time, NULL);
    double total_time = (end_time.tv_sec - enc->start_time.tv_sec) +
                       (end_time.tv_usec - enc->start_time.tv_usec) / 1000000.0;

    printf("\nEncoding complete!\n");
    printf("  Frames encoded: %d\n", frame_count);
    printf("  Framerate: %d\n", enc->output_fps);
    printf("  Output size: %zu bytes\n", enc->total_compressed_size);
    printf("  Encoding time: %.2fs (%.1f fps)\n", total_time, frame_count / total_time);
    printf("  Frame statistics: I-Frame=%d, P-Frame=%d\n", count_iframe, count_pframe);

    
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
    free(enc->compressed_buffer);
    free(enc->mp2_buffer);
    
    // OPTIMIZATION: Free reusable quantisation buffers
    free(enc->reusable_quantised_y);
    free(enc->reusable_quantised_co);
    free(enc->reusable_quantised_cg);
    
    // Free coefficient delta storage
    free(enc->previous_coeffs_y);
    free(enc->previous_coeffs_co);
    free(enc->previous_coeffs_cg);
    
    // Free subtitle list
    if (enc->subtitles) {
        free_subtitle_list(enc->subtitles);
    }
    
    if (enc->zstd_ctx) {
        ZSTD_freeCCtx(enc->zstd_ctx);
    }
    
    free(enc);
}