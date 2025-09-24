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
// TAV version - dynamic based on colour space and perceptual tuning
// Version 5: YCoCg-R monoblock with perceptual quantisation (default)
// Version 6: ICtCp monoblock with perceptual quantisation (--ictcp flag)
// Legacy versions (uniform quantisation):
// Version 3: YCoCg-R monoblock uniform (--no-perceptual-tuning)
// Version 4: ICtCp monoblock uniform (--ictcp --no-perceptual-tuning)
// Version 1: YCoCg-R 4-tile (legacy, code preserved but not accessible)
// Version 2: ICtCp 4-tile (legacy, code preserved but not accessible)

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
#define TILE_SIZE_Y 224  // Optimised for TSVM 560x448 (2×2 tiles exactly)
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
int KEYFRAME_INTERVAL = 7; // refresh often because deltas in DWT are more visible than DCT
#define ZSTD_COMPRESSON_LEVEL 15

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

// Calculate maximum decomposition levels for a given frame size
static int calculate_max_decomp_levels(int width, int height) {
    int levels = 0;
    int min_size = width < height ? width : height;

    // Keep halving until we reach a minimum size (at least 4 pixels)
    while (min_size >= 8) {  // Need at least 8 pixels to safely halve to 4
        min_size /= 2;
        levels++;
    }

    // Cap at a reasonable maximum to avoid going too deep
    return levels > 10 ? 10 : levels;
}

// MP2 audio rate table (same as TEV)
static const int MP2_RATE_TABLE[] = {128, 160, 224, 320, 384, 384};

// Valid MP2 bitrates as per MPEG-1 Layer II specification
static const int MP2_VALID_BITRATES[] = {32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384};

// Validate and return closest valid MP2 bitrate, or 0 if invalid
static int validate_mp2_bitrate(int bitrate) {
    for (int i = 0; i < sizeof(MP2_VALID_BITRATES) / sizeof(int); i++) {
        if (MP2_VALID_BITRATES[i] == bitrate) {
            return bitrate;  // Exact match
        }
    }
    return 0;  // Invalid bitrate
}

// Quality level to quantisation mapping for different channels
static const int QUALITY_Y[] = {60, 42, 25, 12, 6, 2};
static const int QUALITY_CO[] = {120, 90, 60, 30, 15, 3};
static const int QUALITY_CG[] = {240, 180, 120, 60, 30, 5};
//static const int QUALITY_Y[] =  { 25, 12,  6,   3,  2, 1};
//static const int QUALITY_CO[] =  {60, 30, 15,  7,  5, 2};
//static const int QUALITY_CG[] = {120, 60, 30, 15, 10, 4};

// psychovisual tuning parameters
static const float ANISOTROPY_MULT[] = {1.8f, 1.6f, 1.4f, 1.2f, 1.0f, 1.0f};
static const float ANISOTROPY_BIAS[] = {0.2f, 0.1f, 0.0f, 0.0f, 0.0f, 0.0f};

static const float ANISOTROPY_MULT_CHROMA[] = {6.6f, 5.5f, 4.4f, 3.3f, 2.2f, 1.1f};
static const float ANISOTROPY_BIAS_CHROMA[] = {1.0f, 0.8f, 0.6f, 0.4f, 0.2f, 0.0f};

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

// DWT subband information for perceptual quantisation
typedef struct {
    int level;              // Decomposition level (1 to enc->decomp_levels)
    int subband_type;       // 0=LL, 1=LH, 2=HL, 3=HH
    int coeff_start;        // Starting index in linear coefficient array
    int coeff_count;        // Number of coefficients in this subband
    float perceptual_weight; // Quantisation multiplier for this subband
} dwt_subband_info_t;

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
    int monoblock;        // Single DWT tile mode (encode entire frame as one tile)
    int perceptual_tuning; // 1 = perceptual quantisation (default), 0 = uniform quantisation
    
    // Frame buffers - ping-pong implementation
    uint8_t *frame_rgb[2];      // [0] and [1] alternate between current and previous
    int frame_buffer_index;     // 0 or 1, indicates which set is "current"
    float *current_frame_y, *current_frame_co, *current_frame_cg;

    // Convenience pointers (updated each frame to point to current ping-pong buffers)
    uint8_t *current_frame_rgb;
    uint8_t *previous_frame_rgb;

    // Tile processing
    int tiles_x, tiles_y;
    dwt_tile_t *tiles;

    // Audio processing (expanded from TEV)
    size_t audio_remaining;
    uint8_t *mp2_buffer;
    size_t mp2_buffer_size;
    int mp2_packet_size;
    int mp2_rate_index;
    int audio_bitrate;  // Custom audio bitrate (0 = use quality table)
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
    
    // OPTIMISATION: Pre-allocated buffers to avoid malloc/free per tile
    int16_t *reusable_quantised_y;
    int16_t *reusable_quantised_co;
    int16_t *reusable_quantised_cg;
    
    // Multi-frame coefficient storage for better temporal prediction
    float *previous_coeffs_y[3];   // Previous 3 frames Y coefficients for all tiles
    float *previous_coeffs_co[3];  // Previous 3 frames Co coefficients for all tiles
    float *previous_coeffs_cg[3];  // Previous 3 frames Cg coefficients for all tiles
    int previous_coeffs_allocated; // Flag to track allocation
    int reference_frame_count;     // Number of available reference frames (0-3)
    int last_frame_was_intra;      // 1 if previous frame was INTRA, 0 if DELTA
    
    // Statistics
    size_t total_compressed_size;
    size_t total_uncompressed_size;

    // Progress tracking
    struct timeval start_time;
    int encode_limit;  // Maximum number of frames to encode (0 = no limit)

} tav_encoder_t;

// Wavelet filter constants removed - using lifting scheme implementation instead

// Swap ping-pong frame buffers (eliminates need for memcpy)
static void swap_frame_buffers(tav_encoder_t *enc) {
    // Flip the buffer index
    enc->frame_buffer_index = 1 - enc->frame_buffer_index;

    // Update convenience pointers to point to the new current/previous buffers
    enc->current_frame_rgb = enc->frame_rgb[enc->frame_buffer_index];
    enc->previous_frame_rgb = enc->frame_rgb[1 - enc->frame_buffer_index];
}

// Parse resolution string like "1024x768" with keyword recognition
static int parse_resolution(const char *res_str, int *width, int *height) {
    if (!res_str) return 0;
    if (strcmp(res_str, "cif") == 0 || strcmp(res_str, "CIF") == 0) {
        *width = 352;
        *height = 288;
        return 1;
    }
    if (strcmp(res_str, "qcif") == 0 || strcmp(res_str, "QCIF") == 0) {
        *width = 176;
        *height = 144;
        return 1;
    }
    if (strcmp(res_str, "half") == 0 || strcmp(res_str, "HALF") == 0) {
        *width = DEFAULT_WIDTH >> 1;
        *height = DEFAULT_HEIGHT >> 1;
        return 1;
    }
    if (strcmp(res_str, "default") == 0 || strcmp(res_str, "DEFAULT") == 0) {
        *width = DEFAULT_WIDTH;
        *height = DEFAULT_HEIGHT;
        return 1;
    }
    return sscanf(res_str, "%dx%d", width, height) == 2;
}

// Function prototypes
static void show_usage(const char *program_name);
static tav_encoder_t* create_encoder(void);
static void cleanup_encoder(tav_encoder_t *enc);
static int initialise_encoder(tav_encoder_t *enc);
static void rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height);
static int calculate_max_decomp_levels(int width, int height);

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
    printf("  -Q, --quantiser Y,Co,Cg Quantiser levels 1-255 for each channel (1: lossless, 255: potato)\n");
//    printf("  -w, --wavelet N         Wavelet filter: 0=5/3 reversible, 1=9/7 irreversible (default: 1)\n");
//    printf("  -b, --bitrate N         Target bitrate in kbps (enables bitrate control mode)\n");
    printf("  --arate N               MP2 audio bitrate in kbps (overrides quality-based audio rate)\n");
    printf("                          Valid values: 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384\n");
    printf("  -S, --subtitles FILE    SubRip (.srt) or SAMI (.smi) subtitle file\n");
    printf("  -v, --verbose           Verbose output\n");
    printf("  -t, --test              Test mode: generate solid colour frames\n");
    printf("  --lossless              Lossless mode: use 5/3 reversible wavelet\n");
    printf("  --intra-only            Disable delta encoding (less noisy picture at the cost of larger file)\n");
    printf("  --ictcp                 Use ICtCp colour space instead of YCoCg-R (use when source is in BT.2100)\n");
    printf("  --no-perceptual-tuning  Disable perceptual quantisation\n");
    printf("  --encode-limit N        Encode only first N frames (useful for testing/analysis)\n");
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
    printf("\n\nVideo Size Keywords:");
    printf("\n  -s cif: equal to 352x288");
    printf("\n  -s qcif: equal to 176x144");
    printf("\n  -s half: equal to %dx%d", DEFAULT_WIDTH >> 1, DEFAULT_HEIGHT >> 1);
    printf("\n  -s default: equal to %dx%d", DEFAULT_WIDTH, DEFAULT_HEIGHT);
    printf("\n\n");
    printf("Features:\n");
    printf("  - Single DWT tile (monoblock) encoding for optimal quality\n");
    printf("  - Perceptual quantisation optimised for human visual system (default)\n");
    printf("  - Full resolution YCoCg-R/ICtCp colour space\n");
    printf("  - Lossless and lossy compression modes\n");
    printf("  - Versions 5/6: Perceptual quantisation, Versions 3/4: Uniform quantisation\n");
    
    printf("\nExamples:\n");
    printf("  %s -i input.mp4 -o output.mv3               # Default settings\n", program_name);
    printf("  %s -i input.mkv -q 4 -o output.mv3          # At maximum quality\n", program_name);
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
    enc->intra_only = 0;
    enc->monoblock = 1;  // Default to monoblock mode
    enc->perceptual_tuning = 1;  // Default to perceptual quantisation (versions 5/6)
    enc->audio_bitrate = 0;  // 0 = use quality table
    enc->encode_limit = 0;  // Default: no frame limit

    return enc;
}

// Initialise encoder resources
static int initialise_encoder(tav_encoder_t *enc) {
    if (!enc) return -1;

    // Automatic decomposition levels for monoblock mode
    if (enc->monoblock) {
        enc->decomp_levels = calculate_max_decomp_levels(enc->width, enc->height);
    }

    // Calculate tile dimensions
    if (enc->monoblock) {
        // Monoblock mode: single tile covering entire frame
        enc->tiles_x = 1;
        enc->tiles_y = 1;
    } else {
        // Standard mode: multiple 280x224 tiles
        enc->tiles_x = (enc->width + TILE_SIZE_X - 1) / TILE_SIZE_X;
        enc->tiles_y = (enc->height + TILE_SIZE_Y - 1) / TILE_SIZE_Y;
    }
    int num_tiles = enc->tiles_x * enc->tiles_y;
    
    // Allocate ping-pong frame buffers
    size_t frame_size = enc->width * enc->height;
    enc->frame_rgb[0] = malloc(frame_size * 3);
    enc->frame_rgb[1] = malloc(frame_size * 3);

    // Initialise ping-pong buffer index and convenience pointers
    enc->frame_buffer_index = 0;
    enc->current_frame_rgb = enc->frame_rgb[0];
    enc->previous_frame_rgb = enc->frame_rgb[1];
    enc->current_frame_y = malloc(frame_size * sizeof(float));
    enc->current_frame_co = malloc(frame_size * sizeof(float));
    enc->current_frame_cg = malloc(frame_size * sizeof(float));
    
    // Allocate tile structures
    enc->tiles = malloc(num_tiles * sizeof(dwt_tile_t));

    // Initialise ZSTD compression
    enc->zstd_ctx = ZSTD_createCCtx();

    // Calculate maximum possible frame size for ZSTD buffer
    const size_t max_frame_coeff_count = enc->monoblock ?
        (enc->width * enc->height) :
        (PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y);
    const size_t max_frame_size = num_tiles * (4 + max_frame_coeff_count * 3 * sizeof(int16_t));
    enc->compressed_buffer_size = ZSTD_compressBound(max_frame_size);
    enc->compressed_buffer = malloc(enc->compressed_buffer_size);
    
    // OPTIMISATION: Allocate reusable quantisation buffers
    int coeff_count_per_tile;
    if (enc->monoblock) {
        // Monoblock mode: entire frame
        coeff_count_per_tile = enc->width * enc->height;
    } else {
        // Standard mode: padded tiles (344x288)
        coeff_count_per_tile = PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y;
    }

    enc->reusable_quantised_y = malloc(coeff_count_per_tile * sizeof(int16_t));
    enc->reusable_quantised_co = malloc(coeff_count_per_tile * sizeof(int16_t));
    enc->reusable_quantised_cg = malloc(coeff_count_per_tile * sizeof(int16_t));

    // Allocate multi-frame coefficient storage for better temporal prediction
    size_t total_coeff_size = num_tiles * coeff_count_per_tile * sizeof(float);
    for (int ref = 0; ref < 3; ref++) {
        enc->previous_coeffs_y[ref] = malloc(total_coeff_size);
        enc->previous_coeffs_co[ref] = malloc(total_coeff_size);
        enc->previous_coeffs_cg[ref] = malloc(total_coeff_size);

        // Initialize to zero
        memset(enc->previous_coeffs_y[ref], 0, total_coeff_size);
        memset(enc->previous_coeffs_co[ref], 0, total_coeff_size);
        memset(enc->previous_coeffs_cg[ref], 0, total_coeff_size);
    }
    enc->previous_coeffs_allocated = 0; // Will be set to 1 after first I-frame
    enc->reference_frame_count = 0;
    enc->last_frame_was_intra = 1;     // First frame is always INTRA

    // Check allocations
    int allocation_success = 1;
    for (int ref = 0; ref < 3; ref++) {
        if (!enc->previous_coeffs_y[ref] || !enc->previous_coeffs_co[ref] || !enc->previous_coeffs_cg[ref]) {
            allocation_success = 0;
            break;
        }
    }

    if (!enc->frame_rgb[0] || !enc->frame_rgb[1] ||
        !enc->current_frame_y || !enc->current_frame_co || !enc->current_frame_cg ||
        !enc->tiles || !enc->zstd_ctx || !enc->compressed_buffer ||
        !enc->reusable_quantised_y || !enc->reusable_quantised_co || !enc->reusable_quantised_cg ||
        !allocation_success) {
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
    
    // OPTIMISATION: Process row by row with bulk copying for core region
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
            // OPTIMISATION: Bulk copy core region (280 pixels) in one operation
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

// 2D DWT forward transform for arbitrary dimensions
static void dwt_2d_forward_flexible(float *tile_data, int width, int height, int levels, int filter_type) {
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

// https://www.desmos.com/calculator/mjlpwqm8ge
// where Q=quality, x=level
static float perceptual_model3_LH(int quality, int level) {
    float H4 = 1.2f;
    float Lx = H4 - ((quality + 1.f) / 15.f) * (level - 4.f);
    float Ld = (quality + 1.f) / -15.f;
    float C = H4 - 4.f * Ld - ((-16.f*(quality - 5.f))/(15.f));
    float Gx = (Ld * level) - (((quality - 5.f)*(level - 8.f)*level)/(15.f)) + C;

    return (level >= 4) ? Lx : Gx;
}

static float perceptual_model3_HL(int quality, float LH) {
    return fmaf(LH, ANISOTROPY_MULT[quality], ANISOTROPY_BIAS[quality]);
}

static float perceptual_model3_HH(float LH, float HL) {
    return (HL / LH) * 1.44f;
}

static float perceptual_model3_LL(int quality, int level) {
    float n = perceptual_model3_LH(quality, level);
    float m = perceptual_model3_LH(quality, level - 1) / n;

    return n / m;
}

static float perceptual_model3_chroma_basecurve(int quality, int level) {
    return 1.0f - (1.0f / (0.5f * quality * quality + 1.0f)) * (level - 4.0f); // just a line that passes (4,1)
}

// Get perceptual weight for specific subband - Data-driven model based on coefficient variance analysis
static float get_perceptual_weight_model2(int level, int subband_type, int is_chroma, int max_levels) {
    // Psychovisual model based on DWT coefficient statistics and Human Visual System sensitivity
    // strategy: JPEG quantisation table + real-world statistics from the encoded videos
    if (!is_chroma) {
        // LUMA CHANNEL: Based on statistical analysis from real video content
        if (subband_type == 0) { // LL subband - contains most image energy, preserve carefully
            if (level >= 6) return 0.5f;  // LL6: High energy but can tolerate moderate quantisation (range up to 22K)
            if (level >= 5) return 0.7f;  // LL5: Good preservation
            return 0.9f;                   // Lower LL levels: Fine preservation
        } else if (subband_type == 1) { // LH subband - horizontal details (human eyes more sensitive)
            if (level >= 6) return 0.8f;  // LH6: Significant coefficients (max ~500), preserve well
            if (level >= 5) return 1.0f;  // LH5: Moderate coefficients (max ~600)
            if (level >= 4) return 1.2f;  // LH4: Small coefficients (max ~50)
            if (level >= 3) return 1.6f;  // LH3: Very small coefficients, can quantise more
            if (level >= 2) return 2.0f;  // LH2: Minimal impact
            return 2.5f;                   // LH1: Least important
        } else if (subband_type == 2) { // HL subband - vertical details (less sensitive due to HVS characteristics)
            if (level >= 6) return 1.0f;  // HL6: Can quantise more aggressively than LH6
            if (level >= 5) return 1.2f;  // HL5: Standard quantisation
            if (level >= 4) return 1.5f;  // HL4: Notable range but less critical
            if (level >= 3) return 2.0f;  // HL3: Can tolerate more quantisation
            if (level >= 2) return 2.5f;  // HL2: Less important
            return 3.5f;                   // HL1: Most aggressive for vertical details
        } else { // HH subband - diagonal details (least important for HVS)
            if (level >= 6) return 1.2f;  // HH6: Preserve some diagonal detail
            if (level >= 5) return 1.6f;  // HH5: Can quantise aggressively
            if (level >= 4) return 2.0f;  // HH4: Very aggressive
            if (level >= 3) return 2.8f;  // HH3: Minimal preservation
            if (level >= 2) return 3.5f;  // HH2: Maximum compression
            return 5.0f;                   // HH1: Most aggressive quantisation
        }
    } else {
        // CHROMA CHANNELS: Less critical for human perception, more aggressive quantisation
        // strategy: mimic 4:2:2 chroma subsampling
        if (subband_type == 0) { // LL chroma - still important but less than luma
            return 1.0f;
            if (level >= 6) return 0.8f;  // Chroma LL6: Less critical than luma LL
            if (level >= 5) return 0.9f;
            return 1.0f;
        } else if (subband_type == 1) { // LH chroma - horizontal chroma details
            return 1.8f;
            if (level >= 6) return 1.0f;
            if (level >= 5) return 1.2f;
            if (level >= 4) return 1.4f;
            if (level >= 3) return 1.6f;
            if (level >= 2) return 1.8f;
            return 2.0f;
        } else if (subband_type == 2) { // HL chroma - vertical chroma details (even less critical)
            return 1.3f;
            if (level >= 6) return 1.2f;
            if (level >= 5) return 1.4f;
            if (level >= 4) return 1.6f;
            if (level >= 3) return 1.8f;
            if (level >= 2) return 2.0f;
            return 2.2f;
        } else { // HH chroma - diagonal chroma details (most aggressive)
            return 2.5f;
            if (level >= 6) return 1.4f;
            if (level >= 5) return 1.6f;
            if (level >= 4) return 1.8f;
            if (level >= 3) return 2.1f;
            if (level >= 2) return 2.3f;
            return 2.5f;
        }
    }
}

#define FOUR_PIXEL_DETAILER 0.88f
#define TWO_PIXEL_DETAILER  0.92f

// level is one-based index
static float get_perceptual_weight(tav_encoder_t *enc, int level, int subband_type, int is_chroma, int max_levels) {
    // Psychovisual model based on DWT coefficient statistics and Human Visual System sensitivity
    // strategy: more horizontal detail
    if (!is_chroma) {
        // LL subband - contains most image energy, preserve carefully
        if (subband_type == 0)
            return perceptual_model3_LL(enc->quality_level, level);

        // LH subband - horizontal details (human eyes more sensitive)
        float LH = perceptual_model3_LH(enc->quality_level, level);
        if (subband_type == 1)
            return LH;

        // HL subband - vertical details
        float HL = perceptual_model3_HL(enc->quality_level, LH);
        if (subband_type == 2)
            return HL * (level == 2 ? TWO_PIXEL_DETAILER : level == 3 ? FOUR_PIXEL_DETAILER : 1.0f);

        // HH subband - diagonal details
        else return perceptual_model3_HH(LH, HL) * (level == 2 ? TWO_PIXEL_DETAILER : level == 3 ? FOUR_PIXEL_DETAILER : 1.0f);
    } else {
        // CHROMA CHANNELS: Less critical for human perception, more aggressive quantisation
        // strategy: more horizontal detail
        //// mimic 4:4:0 (you heard that right!) chroma subsampling (4:4:4 for higher q, 4:2:0 for lower q)
        //// because our eyes are apparently sensitive to horizontal chroma diff as well?

        float base = perceptual_model3_chroma_basecurve(enc->quality_level, level - 1);

        if (subband_type == 0) { // LL chroma - still important but less than luma
            return 1.0f;
        } else if (subband_type == 1) { // LH chroma - horizontal chroma details
            return FCLAMP(base, 1.0f, 100.0f);
        } else if (subband_type == 2) { // HL chroma - vertical chroma details (even less critical)
            return FCLAMP(base * ANISOTROPY_MULT_CHROMA[enc->quality_level], 1.0f, 100.0f);
        } else { // HH chroma - diagonal chroma details (most aggressive)
            return FCLAMP(base * ANISOTROPY_MULT_CHROMA[enc->quality_level] + ANISOTROPY_BIAS_CHROMA[enc->quality_level], 1.0f, 100.0f);
        }
    }
}

// Delta-specific perceptual weight model optimized for temporal coefficient differences
static float get_perceptual_weight_delta(tav_encoder_t *enc, int level, int subband_type, int is_chroma, int max_levels) {
    // Delta coefficients have different perceptual characteristics than full-picture coefficients:
    // 1. Motion edges are more perceptually critical than static edges
    // 2. Temporal masking allows more aggressive quantization in high-motion areas
    // 3. Smaller delta magnitudes make relative quantization errors more visible
    // 4. Frequency distribution is motion-dependent rather than spatial-dependent

    if (!is_chroma) {
        // LUMA DELTA CHANNEL: Emphasize motion coherence and edge preservation
        if (subband_type == 0) { // LL subband - DC motion changes, still important
            // DC motion changes - preserve somewhat but allow coarser quantization than full-picture
            return 2.0f; // Slightly coarser than full-picture
        }

        if (subband_type == 1) { // LH subband - horizontal motion edges
            // Motion boundaries benefit from temporal masking - allow coarser quantization
            return 0.9f; // More aggressive quantization for deltas
        }

        if (subband_type == 2) { // HL subband - vertical motion edges
            // Vertical motion boundaries - equal treatment with horizontal for deltas
            return 1.2f; // Same aggressiveness as horizontal
        }

        // HH subband - diagonal motion details

        // Diagonal motion deltas can be quantized most aggressively
        return 0.5f;

    } else {
        // CHROMA DELTA CHANNELS: More aggressive quantization allowed due to temporal masking
        // Motion chroma changes are less perceptually critical than static chroma

        float base = perceptual_model3_chroma_basecurve(enc->quality_level, level - 1);

        if (subband_type == 0) { // LL chroma deltas
            // Chroma DC motion changes - allow more aggressive quantization
            return 1.3f; // More aggressive than full-picture chroma
        } else if (subband_type == 1) { // LH chroma deltas
            // Horizontal chroma motion - temporal masking allows more quantization
            return FCLAMP(base * 1.4f, 1.2f, 120.0f);
        } else if (subband_type == 2) { // HL chroma deltas
            // Vertical chroma motion - most aggressive
            return FCLAMP(base * ANISOTROPY_MULT_CHROMA[enc->quality_level] * 1.6f, 1.4f, 140.0f);
        } else { // HH chroma deltas
            // Diagonal chroma motion - extremely aggressive quantization
            return FCLAMP(base * ANISOTROPY_MULT_CHROMA[enc->quality_level] * 1.8f + ANISOTROPY_BIAS_CHROMA[enc->quality_level], 1.6f, 160.0f);
        }
    }
}

// Safe spatial prediction using neighboring DWT coefficients (LL subband only)
static void apply_spatial_prediction_safe(float *coeffs, float *predicted_coeffs,
                                        int width, int height, int decomp_levels) {
    // Apply spatial prediction ONLY to LL subband to avoid addressing issues
    // This is much safer and still provides benefit for the most important coefficients

    int total_size = width * height;

    // Initialize with input temporal prediction values
    for (int i = 0; i < total_size; i++) {
        predicted_coeffs[i] = coeffs[i];
    }

    // Only process LL subband (DC component) with safe, simple neighbor averaging
    int ll_width = width >> decomp_levels;
    int ll_height = height >> decomp_levels;

    // Only process interior pixels to avoid boundary issues
    for (int y = 1; y < ll_height - 1; y++) {
        for (int x = 1; x < ll_width - 1; x++) {
            int idx = y * ll_width + x;

            // Get 4-connected neighbors from the input (not the output being modified)
            float left = coeffs[y * ll_width + (x-1)];
            float right = coeffs[y * ll_width + (x+1)];
            float top = coeffs[(y-1) * ll_width + x];
            float bottom = coeffs[(y+1) * ll_width + x];

            // Simple neighbor averaging for spatial prediction
            float spatial_pred = (left + right + top + bottom) * 0.25f;

            // Combine temporal and spatial predictions with conservative weight
            // 85% temporal, 15% spatial for safety
            predicted_coeffs[idx] = coeffs[idx] * 0.85f + spatial_pred * 0.15f;
        }
    }

    // Leave all detail subbands unchanged - only modify LL subband
    // This prevents any coefficient addressing corruption
}

// Spatial prediction using neighboring DWT coefficients within the same subband
static void apply_spatial_prediction(float *coeffs, float *predicted_coeffs,
                                   int width, int height, int decomp_levels) {
    // Apply spatial prediction within each DWT subband
    // This improves upon temporal prediction by using neighboring coefficients

    int total_size = width * height;

    // Initialize with temporal prediction values
    for (int i = 0; i < total_size; i++) {
        predicted_coeffs[i] = coeffs[i];
    }

    // Map each coefficient to its subband and apply spatial prediction
    int offset = 0;

    // Process LL subband (DC component) - use simple neighbor averaging
    int ll_width = width >> decomp_levels;
    int ll_height = height >> decomp_levels;
    int ll_size = ll_width * ll_height;

    // don't modify the LL subband
    offset += ll_size;

    // Process detail subbands (LH, HL, HH) from coarsest to finest
    for (int level = decomp_levels; level >= 1; level--) {
        int level_width = width >> (decomp_levels - level + 1);
        int level_height = height >> (decomp_levels - level + 1);
        int subband_size = level_width * level_height;

        // Process LH, HL, HH subbands for this level
        for (int subband = 0; subband < 3; subband++) {
            for (int y = 1; y < level_height - 1; y++) {
                for (int x = 1; x < level_width - 1; x++) {
                    int idx = y * level_width + x;

                    // Get neighboring coefficients in the same subband
                    float left = predicted_coeffs[offset + y * level_width + (x-1)];
                    float right = predicted_coeffs[offset + y * level_width + (x+1)];
                    float top = predicted_coeffs[offset + (y-1) * level_width + x];
                    float bottom = predicted_coeffs[offset + (y+1) * level_width + x];

                    // Directional prediction based on subband type
                    float spatial_pred;
                    if (subband == 0) { // LH (horizontal edges)
                        // Emphasize vertical neighbors for horizontal edge prediction
                        spatial_pred = (top + bottom) * 0.4f + (left + right) * 0.1f;
                    } else if (subband == 1) { // HL (vertical edges)
                        // Emphasize horizontal neighbors for vertical edge prediction
                        spatial_pred = (left + right) * 0.4f + (top + bottom) * 0.1f;
                    } else { // HH (diagonal edges)
                        // Equal weighting for diagonal prediction
                        spatial_pred = (left + right + top + bottom) * 0.25f;
                    }

                    // Combine temporal and spatial predictions with lighter spatial weight for high-frequency
                    float spatial_weight = 0.2f; // Less spatial influence in detail subbands
                    predicted_coeffs[offset + idx] = coeffs[offset + idx] * (1.0f - spatial_weight) + spatial_pred * spatial_weight;
                }
            }
            offset += subband_size;
        }
    }
}


// Determine perceptual weight for coefficient at linear position (matches actual DWT layout)
static float get_perceptual_weight_for_position(tav_encoder_t *enc, int linear_idx, int width, int height, int decomp_levels, int is_chroma) {
    // Map linear coefficient index to DWT subband using same layout as decoder
    int offset = 0;

    // First: LL subband at maximum decomposition level
    int ll_width = width >> decomp_levels;
    int ll_height = height >> decomp_levels;
    int ll_size = ll_width * ll_height;

    if (linear_idx < offset + ll_size) {
        // LL subband at maximum level - use get_perceptual_weight for consistency
        return get_perceptual_weight(enc, decomp_levels, 0, is_chroma, decomp_levels);
    }
    offset += ll_size;

    // Then: LH, HL, HH subbands for each level from max down to 1
    for (int level = decomp_levels; level >= 1; level--) {
        int level_width = width >> (decomp_levels - level + 1);
        int level_height = height >> (decomp_levels - level + 1);
        int subband_size = level_width * level_height;

        // LH subband (horizontal details)
        if (linear_idx < offset + subband_size) {
            return get_perceptual_weight(enc, level, 1, is_chroma, decomp_levels);
        }
        offset += subband_size;

        // HL subband (vertical details)
        if (linear_idx < offset + subband_size) {
            return get_perceptual_weight(enc, level, 2, is_chroma, decomp_levels);
        }
        offset += subband_size;

        // HH subband (diagonal details)
        if (linear_idx < offset + subband_size) {
            return get_perceptual_weight(enc, level, 3, is_chroma, decomp_levels);
        }
        offset += subband_size;
    }

    // Fallback for out-of-bounds indices
    return 1.0f;
}

// Determine delta-specific perceptual weight for coefficient at linear position
static float get_perceptual_weight_for_position_delta(tav_encoder_t *enc, int linear_idx, int width, int height, int decomp_levels, int is_chroma) {
    // Map linear coefficient index to DWT subband using same layout as decoder
    int offset = 0;

    // First: LL subband at maximum decomposition level
    int ll_width = width >> decomp_levels;
    int ll_height = height >> decomp_levels;
    int ll_size = ll_width * ll_height;

    if (linear_idx < offset + ll_size) {
        // LL subband at maximum level - use delta-specific perceptual weight
        return get_perceptual_weight_delta(enc, decomp_levels, 0, is_chroma, decomp_levels);
    }
    offset += ll_size;

    // Then: LH, HL, HH subbands for each level from max down to 1
    for (int level = decomp_levels; level >= 1; level--) {
        int level_width = width >> (decomp_levels - level + 1);
        int level_height = height >> (decomp_levels - level + 1);
        int subband_size = level_width * level_height;

        // LH subband (horizontal details)
        if (linear_idx < offset + subband_size) {
            return get_perceptual_weight_delta(enc, level, 1, is_chroma, decomp_levels);
        }
        offset += subband_size;

        // HL subband (vertical details)
        if (linear_idx < offset + subband_size) {
            return get_perceptual_weight_delta(enc, level, 2, is_chroma, decomp_levels);
        }
        offset += subband_size;

        // HH subband (diagonal details)
        if (linear_idx < offset + subband_size) {
            return get_perceptual_weight_delta(enc, level, 3, is_chroma, decomp_levels);
        }
        offset += subband_size;
    }

    // Fallback for out-of-bounds indices
    return 1.0f;
}

// Apply perceptual quantisation per-coefficient (same loop as uniform but with spatial weights)
static void quantise_dwt_coefficients_perceptual_per_coeff(tav_encoder_t *enc,
                                                          float *coeffs, int16_t *quantised, int size,
                                                          int base_quantiser, int width, int height,
                                                          int decomp_levels, int is_chroma, int frame_count) {
    // EXACTLY the same approach as uniform quantisation but apply weight per coefficient
    float effective_base_q = base_quantiser;
    effective_base_q = FCLAMP(effective_base_q, 1.0f, 255.0f);

    for (int i = 0; i < size; i++) {
        // Apply perceptual weight based on coefficient's position in DWT layout
        float weight = get_perceptual_weight_for_position(enc, i, width, height, decomp_levels, is_chroma);
        float effective_q = effective_base_q * weight;
        float quantised_val = coeffs[i] / effective_q;
        quantised[i] = (int16_t)CLAMP((int)(quantised_val + (quantised_val >= 0 ? 0.5f : -0.5f)), -32768, 32767);
    }
}

// Apply delta-specific perceptual quantisation for temporal coefficients
static void quantise_dwt_coefficients_perceptual_delta(tav_encoder_t *enc,
                                                      float *delta_coeffs, int16_t *quantised, int size,
                                                      int base_quantiser, int width, int height,
                                                      int decomp_levels, int is_chroma) {
    // Delta-specific perceptual quantization uses motion-optimized weights
    // Key differences from full-picture quantization:
    // 1. Finer quantization steps for deltas (smaller magnitudes)
    // 2. Motion-coherence emphasis over spatial-detail emphasis
    // 3. Enhanced temporal masking for chroma channels

    float effective_base_q = base_quantiser;
    effective_base_q = FCLAMP(effective_base_q, 1.0f, 255.0f);

    // Delta-specific base quantization adjustment
    // Deltas benefit from temporal masking - allow coarser quantization steps
    float delta_coarse_tune = 1.2f; // 20% coarser quantization for delta coefficients
    effective_base_q *= delta_coarse_tune;

    for (int i = 0; i < size; i++) {
        // Apply delta-specific perceptual weight based on coefficient's position in DWT layout
        float weight = get_perceptual_weight_for_position_delta(enc, i, width, height, decomp_levels, is_chroma);
        float effective_q = effective_base_q * weight;

        // Ensure minimum quantization step for very small deltas to prevent over-quantization
        effective_q = fmaxf(effective_q, 0.5f);

        float quantised_val = delta_coeffs[i] / effective_q;
        quantised[i] = (int16_t)CLAMP((int)(quantised_val + (quantised_val >= 0 ? 0.5f : -0.5f)), -32768, 32767);
    }
}



// Convert 2D spatial DWT layout to linear subband layout (for decoder compatibility)
static void convert_2d_to_linear_layout(const int16_t *spatial_2d, int16_t *linear_subbands,
                                       int width, int height, int decomp_levels) {
    int linear_offset = 0;

    // First: LL subband (top-left corner at finest decomposition level)
    int ll_width = width >> decomp_levels;
    int ll_height = height >> decomp_levels;
    for (int y = 0; y < ll_height; y++) {
        for (int x = 0; x < ll_width; x++) {
            int spatial_idx = y * width + x;
            linear_subbands[linear_offset++] = spatial_2d[spatial_idx];
        }
    }

    // Then: LH, HL, HH subbands for each level from max down to 1
    for (int level = decomp_levels; level >= 1; level--) {
        int level_width = width >> (decomp_levels - level + 1);
        int level_height = height >> (decomp_levels - level + 1);

        // LH subband (top-right quadrant)
        for (int y = 0; y < level_height; y++) {
            for (int x = level_width; x < level_width * 2; x++) {
                if (y < height && x < width) {
                    int spatial_idx = y * width + x;
                    linear_subbands[linear_offset++] = spatial_2d[spatial_idx];
                }
            }
        }

        // HL subband (bottom-left quadrant)
        for (int y = level_height; y < level_height * 2; y++) {
            for (int x = 0; x < level_width; x++) {
                if (y < height && x < width) {
                    int spatial_idx = y * width + x;
                    linear_subbands[linear_offset++] = spatial_2d[spatial_idx];
                }
            }
        }

        // HH subband (bottom-right quadrant)
        for (int y = level_height; y < level_height * 2; y++) {
            for (int x = level_width; x < level_width * 2; x++) {
                if (y < height && x < width) {
                    int spatial_idx = y * width + x;
                    linear_subbands[linear_offset++] = spatial_2d[spatial_idx];
                }
            }
        }
    }
}

// Serialise tile data for compression
static size_t serialise_tile_data(tav_encoder_t *enc, int tile_x, int tile_y, 
                                  const float *tile_y_data, const float *tile_co_data, const float *tile_cg_data,
                                  uint8_t mode, uint8_t *buffer) {
    size_t offset = 0;
    
    // Write tile header
    buffer[offset++] = mode;

    // TODO calculate frame complexity and create quantiser overrides
    buffer[offset++] = 0; // qY  override
    buffer[offset++] = 0; // qCo override
    buffer[offset++] = 0; // qCg override
    // technically, putting this in here would create three redundant copies of the same value, but it's much easier to code this way :v
    int this_frame_qY = enc->quantiser_y;
    int this_frame_qCo = enc->quantiser_co;
    int this_frame_qCg = enc->quantiser_cg;

    if (mode == TAV_MODE_SKIP) {
        // No coefficient data for SKIP/MOTION modes
        return offset;
    }
    
    // Quantise and serialise DWT coefficients
    const int tile_size = enc->monoblock ?
        (enc->width * enc->height) :  // Monoblock mode: full frame
        (PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y);  // Standard mode: padded tiles
    // OPTIMISATION: Use pre-allocated buffers instead of malloc/free per tile
    // this is the "output" buffer for this function
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
               this_frame_qY, this_frame_qCo, this_frame_qCg);
    }*/
    
    if (mode == TAV_MODE_INTRA) {
        // INTRA mode: quantise coefficients directly and store for future reference
        if (enc->perceptual_tuning) {
            // Perceptual quantisation: EXACTLY like uniform but with per-coefficient weights
            quantise_dwt_coefficients_perceptual_per_coeff(enc, (float*)tile_y_data, quantised_y, tile_size, this_frame_qY, enc->width, enc->height, enc->decomp_levels, 0, enc->frame_count);
            quantise_dwt_coefficients_perceptual_per_coeff(enc, (float*)tile_co_data, quantised_co, tile_size, this_frame_qCo, enc->width, enc->height, enc->decomp_levels, 1, enc->frame_count);
            quantise_dwt_coefficients_perceptual_per_coeff(enc, (float*)tile_cg_data, quantised_cg, tile_size, this_frame_qCg, enc->width, enc->height, enc->decomp_levels, 1, enc->frame_count);
        } else {
            // Legacy uniform quantisation
            quantise_dwt_coefficients((float*)tile_y_data, quantised_y, tile_size, this_frame_qY);
            quantise_dwt_coefficients((float*)tile_co_data, quantised_co, tile_size, this_frame_qCo);
            quantise_dwt_coefficients((float*)tile_cg_data, quantised_cg, tile_size, this_frame_qCg);
        }
        
        // Store current coefficients in multi-frame reference buffer
        // For INTRA frames, reset the sliding window and store in frame 0
        int tile_idx = tile_y * enc->tiles_x + tile_x;

        // Reset reference frame count for INTRA frames (scene change)
        enc->reference_frame_count = 1;
        enc->last_frame_was_intra = 1;

        // Store in frame 0
        float *curr_y = enc->previous_coeffs_y[0] + (tile_idx * tile_size);
        float *curr_co = enc->previous_coeffs_co[0] + (tile_idx * tile_size);
        float *curr_cg = enc->previous_coeffs_cg[0] + (tile_idx * tile_size);
        memcpy(curr_y, tile_y_data, tile_size * sizeof(float));
        memcpy(curr_co, tile_co_data, tile_size * sizeof(float));
        memcpy(curr_cg, tile_cg_data, tile_size * sizeof(float));
        
    }
    else if (mode == TAV_MODE_DELTA) {
        // DELTA mode with multi-frame temporal prediction
        int tile_idx = tile_y * enc->tiles_x + tile_x;
        // Use the most recent frame (frame 0) as the primary reference for delta calculation
        float *prev_y = enc->previous_coeffs_y[0] + (tile_idx * tile_size);
        float *prev_co = enc->previous_coeffs_co[0] + (tile_idx * tile_size);
        float *prev_cg = enc->previous_coeffs_cg[0] + (tile_idx * tile_size);

        // Allocate temporary buffers for error compensation
        float *delta_y = malloc(tile_size * sizeof(float));
        float *delta_co = malloc(tile_size * sizeof(float));
        float *delta_cg = malloc(tile_size * sizeof(float));
        float *compensated_delta_y = malloc(tile_size * sizeof(float));
        float *compensated_delta_co = malloc(tile_size * sizeof(float));
        float *compensated_delta_cg = malloc(tile_size * sizeof(float));

        // Step 1: Compute naive deltas
        for (int i = 0; i < tile_size; i++) {
            delta_y[i] = tile_y_data[i] - prev_y[i];
            delta_co[i] = tile_co_data[i] - prev_co[i];
            delta_cg[i] = tile_cg_data[i] - prev_cg[i];
        }

        // Step 2: Multi-frame temporal prediction with INTRA frame detection
        float *predicted_y = malloc(tile_size * sizeof(float));
        float *predicted_co = malloc(tile_size * sizeof(float));
        float *predicted_cg = malloc(tile_size * sizeof(float));

        if (enc->last_frame_was_intra || enc->reference_frame_count < 2) {
            // Scene change detected (previous frame was INTRA) or insufficient reference frames
            // Use simple single-frame prediction
            if (enc->verbose && tile_x == 0 && tile_y == 0) {
                printf("Frame %d: Scene change detected (previous frame was INTRA) - using single-frame prediction\n",
                       enc->frame_count);
            }

            for (int i = 0; i < tile_size; i++) {
                predicted_y[i] = prev_y[i];
                predicted_co[i] = prev_co[i];
                predicted_cg[i] = prev_cg[i];
            }
        } else {
            // Multi-frame weighted prediction
            // Weights: [0.6, 0.3, 0.1] for [most recent, 2nd most recent, 3rd most recent]
            float weights[3] = {0.6f, 0.3f, 0.1f};

            if (enc->verbose && tile_x == 0 && tile_y == 0) {
                printf("Frame %d: Multi-frame prediction using %d reference frames\n",
                       enc->frame_count, enc->reference_frame_count);
            }

            for (int i = 0; i < tile_size; i++) {
                predicted_y[i] = 0.0f;
                predicted_co[i] = 0.0f;
                predicted_cg[i] = 0.0f;

                // Weighted combination of up to 3 reference frames
                float total_weight = 0.0f;
                for (int ref = 0; ref < enc->reference_frame_count && ref < 3; ref++) {
                    float *ref_y = enc->previous_coeffs_y[ref] + (tile_idx * tile_size);
                    float *ref_co = enc->previous_coeffs_co[ref] + (tile_idx * tile_size);
                    float *ref_cg = enc->previous_coeffs_cg[ref] + (tile_idx * tile_size);

                    predicted_y[i] += ref_y[i] * weights[ref];
                    predicted_co[i] += ref_co[i] * weights[ref];
                    predicted_cg[i] += ref_cg[i] * weights[ref];
                    total_weight += weights[ref];
                }

                // Normalize by actual weight (in case we have fewer than 3 frames)
                if (total_weight > 0.0f) {
                    predicted_y[i] /= total_weight;
                    predicted_co[i] /= total_weight;
                    predicted_cg[i] /= total_weight;
                }
            }
        }

        // Apply spatial prediction on top of temporal prediction
        float *spatially_enhanced_y = malloc(tile_size * sizeof(float));
        float *spatially_enhanced_co = malloc(tile_size * sizeof(float));
        float *spatially_enhanced_cg = malloc(tile_size * sizeof(float));

        // Determine tile dimensions for spatial prediction
        int tile_width, tile_height;
        if (enc->monoblock) {
            tile_width = enc->width;
            tile_height = enc->height;
        } else {
            tile_width = PADDED_TILE_SIZE_X;
            tile_height = PADDED_TILE_SIZE_Y;
        }

        // Apply safe spatial prediction (LL subband only)
        apply_spatial_prediction_safe(predicted_y, spatially_enhanced_y, tile_width, tile_height, enc->decomp_levels);
        apply_spatial_prediction_safe(predicted_co, spatially_enhanced_co, tile_width, tile_height, enc->decomp_levels);
        apply_spatial_prediction_safe(predicted_cg, spatially_enhanced_cg, tile_width, tile_height, enc->decomp_levels);

        // Calculate improved deltas using temporal + spatial prediction
        for (int i = 0; i < tile_size; i++) {
            compensated_delta_y[i] = tile_y_data[i] - spatially_enhanced_y[i];
            compensated_delta_co[i] = tile_co_data[i] - spatially_enhanced_co[i];
            compensated_delta_cg[i] = tile_cg_data[i] - spatially_enhanced_cg[i];
        }

        // Free spatial prediction buffers
        free(spatially_enhanced_y);
        free(spatially_enhanced_co);
        free(spatially_enhanced_cg);

        free(predicted_y);
        free(predicted_co);
        free(predicted_cg);

        // Step 3: Quantize multi-frame predicted deltas
        quantise_dwt_coefficients(compensated_delta_y, quantised_y, tile_size, this_frame_qY);
        quantise_dwt_coefficients(compensated_delta_co, quantised_co, tile_size, this_frame_qCo);
        quantise_dwt_coefficients(compensated_delta_cg, quantised_cg, tile_size, this_frame_qCg);

        // Step 4: Update multi-frame reference coefficient sliding window
        // Shift the sliding window: [0, 1, 2] becomes [new, 0, 1] (2 is discarded)
        if (enc->reference_frame_count >= 2) {
            // Shift frame 1 -> frame 2, frame 0 -> frame 1
            float *temp_y = enc->previous_coeffs_y[2];
            float *temp_co = enc->previous_coeffs_co[2];
            float *temp_cg = enc->previous_coeffs_cg[2];

            enc->previous_coeffs_y[2] = enc->previous_coeffs_y[1];
            enc->previous_coeffs_co[2] = enc->previous_coeffs_co[1];
            enc->previous_coeffs_cg[2] = enc->previous_coeffs_cg[1];

            enc->previous_coeffs_y[1] = enc->previous_coeffs_y[0];
            enc->previous_coeffs_co[1] = enc->previous_coeffs_co[0];
            enc->previous_coeffs_cg[1] = enc->previous_coeffs_cg[0];

            // Reuse the old frame 2 buffer as new frame 0
            enc->previous_coeffs_y[0] = temp_y;
            enc->previous_coeffs_co[0] = temp_co;
            enc->previous_coeffs_cg[0] = temp_cg;
        }

        // Calculate and store the new reconstructed coefficients in frame 0
        float *new_y = enc->previous_coeffs_y[0] + (tile_idx * tile_size);
        float *new_co = enc->previous_coeffs_co[0] + (tile_idx * tile_size);
        float *new_cg = enc->previous_coeffs_cg[0] + (tile_idx * tile_size);

        for (int i = 0; i < tile_size; i++) {
            float dequant_delta_y = (float)quantised_y[i] * this_frame_qY;
            float dequant_delta_co = (float)quantised_co[i] * this_frame_qCo;
            float dequant_delta_cg = (float)quantised_cg[i] * this_frame_qCg;

            // Reconstruct current frame coefficients exactly as decoder will
            new_y[i] = prev_y[i] + dequant_delta_y;
            new_co[i] = prev_co[i] + dequant_delta_co;
            new_cg[i] = prev_cg[i] + dequant_delta_cg;
        }

        // Update reference frame count (up to 3 frames) and frame type
        if (enc->reference_frame_count < 3) {
            enc->reference_frame_count++;
        }
        enc->last_frame_was_intra = 0;

        free(delta_y);
        free(delta_co);
        free(delta_cg);
        free(compensated_delta_y);
        free(compensated_delta_co);
        free(compensated_delta_cg);
    }
    
    // Debug: check quantised coefficients after quantisation
    /*if (tile_x == 0 && tile_y == 0) {
        printf("Encoder Debug: Tile (0,0) - Quantised Y coeffs (first 16): ");
        for (int i = 0; i < 16; i++) {
            printf("%d ", quantised_y[i]);
        }
        printf("\n");
    }*/
    
    // Write quantised coefficients (both uniform and perceptual use same linear layout)
    memcpy(buffer + offset, quantised_y, tile_size * sizeof(int16_t)); offset += tile_size * sizeof(int16_t);
    memcpy(buffer + offset, quantised_co, tile_size * sizeof(int16_t)); offset += tile_size * sizeof(int16_t);
    memcpy(buffer + offset, quantised_cg, tile_size * sizeof(int16_t)); offset += tile_size * sizeof(int16_t);
    
    // OPTIMISATION: No need to free - using pre-allocated reusable buffers
    
    return offset;
}

// Compress and write frame data
static size_t compress_and_write_frame(tav_encoder_t *enc, uint8_t packet_type) {
    // Calculate total uncompressed size
    const size_t coeff_count = enc->monoblock ?
        (enc->width * enc->height) :
        (PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y);
    const size_t max_tile_size = 4 + (coeff_count * 3 * sizeof(int16_t));  // header + 3 channels of coefficients
    const size_t total_uncompressed_size = enc->tiles_x * enc->tiles_y * max_tile_size;
    
    // Allocate buffer for uncompressed tile data
    uint8_t *uncompressed_buffer = malloc(total_uncompressed_size);
    size_t uncompressed_offset = 0;
    
    // Serialise all tiles
    for (int tile_y = 0; tile_y < enc->tiles_y; tile_y++) {
        for (int tile_x = 0; tile_x < enc->tiles_x; tile_x++) {

            // Determine tile mode based on frame type, coefficient availability, and intra_only flag
            uint8_t mode;
            int is_keyframe = (packet_type == TAV_PACKET_IFRAME);
            if (is_keyframe || !enc->previous_coeffs_allocated) {
                mode = TAV_MODE_INTRA;  // I-frames, first frames, or intra-only mode always use INTRA
            } else {
                mode = TAV_MODE_DELTA;  // P-frames use coefficient delta encoding
            }
            
            // Determine tile data size and allocate buffers
            int tile_data_size;
            if (enc->monoblock) {
                // Monoblock mode: entire frame
                tile_data_size = enc->width * enc->height;
            } else {
                // Standard mode: padded tiles (344x288)
                tile_data_size = PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y;
            }

            float *tile_y_data = malloc(tile_data_size * sizeof(float));
            float *tile_co_data = malloc(tile_data_size * sizeof(float));
            float *tile_cg_data = malloc(tile_data_size * sizeof(float));

            if (enc->monoblock) {
                // Extract entire frame (no padding)
                memcpy(tile_y_data, enc->current_frame_y, tile_data_size * sizeof(float));
                memcpy(tile_co_data, enc->current_frame_co, tile_data_size * sizeof(float));
                memcpy(tile_cg_data, enc->current_frame_cg, tile_data_size * sizeof(float));
            } else {
                // Extract padded tiles using context from neighbours
                extract_padded_tile(enc, tile_x, tile_y, tile_y_data, tile_co_data, tile_cg_data);
            }
            
            // Debug: check input data before DWT
            /*if (tile_x == 0 && tile_y == 0) {
                printf("Encoder Debug: Tile (0,0) - Y data before DWT (first 16): ");
                for (int i = 0; i < 16; i++) {
                    printf("%.2f ", tile_y_data[i]);
                }
                printf("\n");
            }*/
            
            // Debug: Check Y data before DWT transform
            /*if (enc->frame_count == 120 && enc->verbose) {
                float max_y_before = 0.0f;
                int nonzero_before = 0;
                int total_pixels = enc->monoblock ? (enc->width * enc->height) : (PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y);
                for (int i = 0; i < total_pixels; i++) {
                    float abs_val = fabsf(tile_y_data[i]);
                    if (abs_val > max_y_before) max_y_before = abs_val;
                    if (abs_val > 0.1f) nonzero_before++;
                }
                printf("DEBUG: Y data before DWT: max=%.2f, nonzero=%d/%d\n", max_y_before, nonzero_before, total_pixels);
            }*/

            // Apply DWT transform to each channel
            if (enc->monoblock) {
                // Monoblock mode: transform entire frame
                dwt_2d_forward_flexible(tile_y_data, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
                dwt_2d_forward_flexible(tile_co_data, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
                dwt_2d_forward_flexible(tile_cg_data, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
            } else {
                // Standard mode: transform padded tiles (344x288)
                dwt_2d_forward_padded(tile_y_data, enc->decomp_levels, enc->wavelet_filter);
                dwt_2d_forward_padded(tile_co_data, enc->decomp_levels, enc->wavelet_filter);
                dwt_2d_forward_padded(tile_cg_data, enc->decomp_levels, enc->wavelet_filter);
            }

            // Debug: Check Y data after DWT transform for high-frequency content
            /*if (enc->frame_count == 120 && enc->verbose) {
                printf("DEBUG: Y data after DWT (some high-freq samples): ");
                int sample_indices[] = {47034, 47035, 47036, 47037, 47038}; // HH1 start + some samples
                for (int i = 0; i < 5; i++) {
                    printf("%.3f ", tile_y_data[sample_indices[i]]);
                }
                printf("\n");
            }*/
            
            // Serialise tile
            size_t tile_size = serialise_tile_data(enc, tile_x, tile_y,
                                                   tile_y_data, tile_co_data, tile_cg_data,
                                                   mode, uncompressed_buffer + uncompressed_offset);
            uncompressed_offset += tile_size;

            // Free allocated tile data
            free(tile_y_data);
            free(tile_co_data);
            free(tile_cg_data);
        }
    }
    
    // Compress with zstd
    size_t compressed_size = ZSTD_compress(enc->compressed_buffer, enc->compressed_buffer_size,
                                           uncompressed_buffer, uncompressed_offset, ZSTD_COMPRESSON_LEVEL);
    
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
    
    // OPTIMISATION: Process 4 pixels at a time for better cache utilisation
    int i = 0;
    const int simd_end = (total_pixels / 4) * 4;
    
    // Vectorised processing for groups of 4 pixels
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
static inline double srgb_linearise(double val) {
    if (val <= 0.04045) return val / 12.92;
    return pow((val + 0.055) / 1.055, 2.4);
}

static inline double srgb_unlinearise(double val) {
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
    // 1) linearise sRGB to 0..1
    double r = srgb_linearise((double)r8 / 255.0);
    double g = srgb_linearise((double)g8 / 255.0);
    double b = srgb_linearise((double)b8 / 255.0);

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
    double r = srgb_unlinearise(r_lin);
    double g = srgb_unlinearise(g_lin);
    double b = srgb_unlinearise(b_lin);

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
    
    // Version (dynamic based on colour space, monoblock mode, and perceptual tuning)
    uint8_t version;
    if (enc->monoblock) {
        if (enc->perceptual_tuning) {
            version = enc->ictcp_mode ? 6 : 5;  // Version 6 for ICtCp perceptual, 5 for YCoCg-R perceptual
        } else {
            version = enc->ictcp_mode ? 4 : 3;  // Version 4 for ICtCp uniform, 3 for YCoCg-R uniform
        }
    } else {
        version = enc->ictcp_mode ? 2 : 1;  // Legacy 4-tile versions
    }
    fputc(version, enc->output_fp);
    
    // Video parameters
    fwrite(&enc->width, sizeof(uint16_t), 1, enc->output_fp);
    fwrite(&enc->height, sizeof(uint16_t), 1, enc->output_fp);
    fputc(enc->output_fps, enc->output_fp);
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
    fprintf(stderr, "  FPS: %.2f input, %d output\n", inputFramerate, config->output_fps);
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
        enc->is_ntsc_framerate = 0;
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
    int bitrate;
    if (enc->audio_bitrate > 0) {
        bitrate = enc->audio_bitrate;
    } else {
        bitrate = enc->lossless ? 384 : MP2_RATE_TABLE[enc->quality_level];
    }
    snprintf(command, sizeof(command),
        "ffmpeg -v quiet -i \"%s\" -acodec libtwolame -psymodel 4 -b:a %dk -ar 32000 -ac 2 -y \"%s\" 2>/dev/null",
        enc->input_file, bitrate, TEMP_AUDIO_FILE);

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

                // Initialise text buffer
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

    //fclose(file); // why uncommenting it errors out with "Fatal error: glibc detected an invalid stdio handle"?
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
            return 2; // SubRip format
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
    if (has_srt_format) return 2; // SRT
    return 0; // Unknown
}

// Parse subtitle file (auto-detect format)
static subtitle_entry_t* parse_subtitle_file(const char *filename, int fps) {
    int format = detect_subtitle_format(filename);

    if (format == 1) return parse_smi_file(filename, fps);
    else if (format == 2) return parse_srt_file(filename, fps);
    else return NULL;
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

    // Initialise packet size on first frame
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
    double frame_audio_time = 1.0 / enc->output_fps;

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
        {"quantiser", required_argument, 0, 'Q'},
//        {"wavelet", required_argument, 0, 'w'},
        {"bitrate", required_argument, 0, 'b'},
        {"arate", required_argument, 0, 1400},
        {"subtitle", required_argument, 0, 'S'},
        {"subtitles", required_argument, 0, 'S'},
        {"verbose", no_argument, 0, 'v'},
        {"test", no_argument, 0, 't'},
        {"lossless", no_argument, 0, 1000},
        {"intra-only", no_argument, 0, 1006},
        {"ictcp", no_argument, 0, 1005},
        {"no-perceptual-tuning", no_argument, 0, 1007},
        {"encode-limit", required_argument, 0, 1008},
        {"help", no_argument, 0, '?'},
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
            case 's':
                if (!parse_resolution(optarg, &enc->width, &enc->height)) {
                    fprintf(stderr, "Invalid resolution format: %s\n", optarg);
                    cleanup_encoder(enc);
                    return 1;
                }
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
                enc->intra_only = 1;
                break;
            case 1007: // --no-perceptual-tuning
                enc->perceptual_tuning = 0;
                break;
            case 1008: // --encode-limit
                enc->encode_limit = atoi(optarg);
                if (enc->encode_limit < 0) {
                    fprintf(stderr, "Error: Invalid encode limit: %d\n", enc->encode_limit);
                    cleanup_encoder(enc);
                    return 1;
                }
                break;
            case 1400: // --arate
                {
                    int bitrate = atoi(optarg);
                    int valid_bitrate = validate_mp2_bitrate(bitrate);
                    if (valid_bitrate == 0) {
                        fprintf(stderr, "Error: Invalid MP2 bitrate %d. Valid values are: ", bitrate);
                        for (int i = 0; i < sizeof(MP2_VALID_BITRATES) / sizeof(int); i++) {
                            fprintf(stderr, "%d%s", MP2_VALID_BITRATES[i],
                                    (i < sizeof(MP2_VALID_BITRATES) / sizeof(int) - 1) ? ", " : "\n");
                        }
                        cleanup_encoder(enc);
                        return 1;
                    }
                    enc->audio_bitrate = valid_bitrate;
                }
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
    
    if (initialise_encoder(enc) != 0) {
        fprintf(stderr, "Error: Failed to initialise encoder\n");
        cleanup_encoder(enc);
        return 1;
    }
    
    printf("TAV Encoder - DWT-based video compression\n");
    printf("Input: %s\n", enc->input_file);
    printf("Output: %s\n", enc->output_file);
    printf("Resolution: %dx%d @ %dfps\n", enc->width, enc->height, enc->output_fps);
    printf("Wavelet: %s\n", enc->wavelet_filter ? "9/7 irreversible" : "5/3 reversible");
    printf("Decomposition levels: %d\n", enc->decomp_levels);
    printf("Colour space: %s\n", enc->ictcp_mode ? "ICtCp" : "YCoCg-R");
    printf("Quantisation: %s\n", enc->perceptual_tuning ? "Perceptual (HVS-optimised)" : "Uniform (legacy)");
    if (enc->ictcp_mode) {
        printf("Base quantiser: I=%d, Ct=%d, Cp=%d\n", enc->quantiser_y, enc->quantiser_co, enc->quantiser_cg);
    } else {
        printf("Base quantiser: Y=%d, Co=%d, Cg=%d\n", enc->quantiser_y, enc->quantiser_co, enc->quantiser_cg);
    }
    if (enc->perceptual_tuning) {
        printf("Perceptual tuning enabled\n");
    }

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
        enc->subtitles = parse_subtitle_file(enc->subtitle_file, enc->output_fps);
        if (NULL == enc->subtitles) {
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
    int true_frame_count = 0;
    int continue_encoding = 1;

    int count_iframe = 0;
    int count_pframe = 0;

    KEYFRAME_INTERVAL = enc->output_fps;// >> 2; // short interval makes ghosting less noticeable

    while (continue_encoding) {
        // Check encode limit if specified
        if (enc->encode_limit > 0 && frame_count >= enc->encode_limit) {
            printf("Reached encode limit of %d frames, finalising...\n", enc->encode_limit);
            continue_encoding = 0;
            break;
        }

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
            process_audio(enc, true_frame_count, enc->output_fp);
            
            // Process subtitles for this frame
            process_subtitles(enc, true_frame_count, enc->output_fp);
            
            // Write a sync packet only after a video is been coded
            uint8_t sync_packet = TAV_PACKET_SYNC;
            fwrite(&sync_packet, 1, 1, enc->output_fp);

            // NTSC frame duplication: emit extra sync packet for every 1000n+500 frames
            if (enc->is_ntsc_framerate && (frame_count % 1000 == 500)) {
                true_frame_count++;
                // Process audio and subtitles for the duplicated frame to maintain sync
                process_audio(enc, true_frame_count, enc->output_fp);
                process_subtitles(enc, true_frame_count, enc->output_fp);

                fwrite(&sync_packet, 1, 1, enc->output_fp);
                printf("Frame %d: NTSC duplication - extra sync packet emitted with audio/subtitle sync\n", frame_count);
            }

            if (is_keyframe)
                count_iframe++;
            else
                count_pframe++;
        }
        
        // Swap ping-pong buffers (eliminates memcpy operations)
        swap_frame_buffers(enc);
        
        frame_count++;
        true_frame_count++;
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
    free(enc->frame_rgb[0]);
    free(enc->frame_rgb[1]);
    free(enc->tiles);
    free(enc->compressed_buffer);
    free(enc->mp2_buffer);
    
    // OPTIMISATION: Free reusable quantisation buffers
    free(enc->reusable_quantised_y);
    free(enc->reusable_quantised_co);
    free(enc->reusable_quantised_cg);
    
    // Free coefficient delta storage
    // Free multi-frame coefficient buffers
    for (int ref = 0; ref < 3; ref++) {
        free(enc->previous_coeffs_y[ref]);
        free(enc->previous_coeffs_co[ref]);
        free(enc->previous_coeffs_cg[ref]);
    }
    
    // Free subtitle list
    if (enc->subtitles) {
        free_subtitle_list(enc->subtitles);
    }
    
    if (enc->zstd_ctx) {
        ZSTD_freeCCtx(enc->zstd_ctx);
    }
    
    free(enc);
}