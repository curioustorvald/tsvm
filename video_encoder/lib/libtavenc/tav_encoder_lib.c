/**
 * TAV Encoder Library - Main Implementation
 *
 * High-level API for encoding video using TAV codec with GOP-based
 * multi-threaded encoding.
 *
 * Based on encoder_tav.c - extracted into library form.
 */

#include "tav_encoder_lib.h"
#include "tav_encoder_color.h"
#include "tav_encoder_dwt.h"
#include "tav_encoder_quantize.h"
#include "tav_encoder_ezbc.h"
#include "tav_encoder_utils.h"
#include "encoder_tad.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <threads.h>
#include <time.h>
#include <zstd.h>

// =============================================================================
// Internal Constants
// =============================================================================

#define ENCODER_VERSION "TAV Encoder Library v1.0"
#define MAX_ERROR_MESSAGE 256

// GOP status values
#define GOP_STATUS_EMPTY      0
#define GOP_STATUS_FILLING    1
#define GOP_STATUS_READY      2
#define GOP_STATUS_ENCODING   3
#define GOP_STATUS_COMPLETE   4

// Quality to quantizer mapping (indices into QLUT)
static const int QLUT[] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096};

static const int QUALITY_Y[] = {79, 47, 23, 11, 5, 2};   // Quality levels 0-5
static const int QUALITY_CO[] = {123, 108, 91, 76, 59, 29};
static const int QUALITY_CG[] = {148, 133, 113, 99, 76, 39};
static const float DEAD_ZONE_THRESHOLD[] = {1.5f, 1.5f, 1.2f, 1.1f, 0.8f, 0.6f, 0.0f};

// Channel layout definitions (from TAV specification)
#define CHANNEL_LAYOUT_YCOCG     0
#define CHANNEL_LAYOUT_YCOCG_A   1
#define CHANNEL_LAYOUT_Y_ONLY    2
#define CHANNEL_LAYOUT_Y_A       3
#define CHANNEL_LAYOUT_COCG      4
#define CHANNEL_LAYOUT_COCG_A    5

// Channel layout configuration
typedef struct {
    int layout_id;
    int num_channels;
    const char *channels[4];
    int has_y, has_co, has_cg, has_alpha;
} channel_layout_config_t;

static const channel_layout_config_t channel_layouts[] = {
    {CHANNEL_LAYOUT_YCOCG,   3, {"Y",  "Co", "Cg", NULL}, 1, 1, 1, 0},  // 0: Y-Co-Cg
    {CHANNEL_LAYOUT_YCOCG_A, 4, {"Y",  "Co", "Cg", "A"}, 1, 1, 1, 1},   // 1: Y-Co-Cg-A
    {CHANNEL_LAYOUT_Y_ONLY,  1, {"Y",  NULL, NULL, NULL}, 1, 0, 0, 0},  // 2: Y only
    {CHANNEL_LAYOUT_Y_A,     2, {"Y",  NULL, NULL, "A"}, 1, 0, 0, 1},   // 3: Y-A
    {CHANNEL_LAYOUT_COCG,    2, {NULL, "Co", "Cg", NULL}, 0, 1, 1, 0},  // 4: Co-Cg
    {CHANNEL_LAYOUT_COCG_A,  3, {NULL, "Co", "Cg", "A"}, 0, 1, 1, 1}    // 5: Co-Cg-A
};

// Coefficient preprocessing modes
typedef enum {
    PREPROCESS_TWOBITMAP = 0,  // Twobit-plane significance map (default, best compression)
    PREPROCESS_EZBC = 1,       // EZBC embedded zero block coding
    PREPROCESS_RAW = 2         // No preprocessing - raw coefficients
} preprocess_mode_t;

// =============================================================================
// Internal Structures
// =============================================================================

// Compatibility structure for extracted modules
// The quantization and DWT modules expect a tav_encoder_t structure
// with certain fields. This minimal structure provides those fields.
struct tav_encoder_s {
    int quality_level;           // For perceptual quantization
    int *widths;                 // Subband widths array (per decomposition level)
    int *heights;                // Subband heights array (per decomposition level)
    int decomp_levels;           // Number of spatial DWT decomposition levels
    float dead_zone_threshold;   // Dead-zone quantization threshold
    int encoder_preset;          // Preset flags (sports mode, etc.)
    int temporal_decomp_levels;  // Temporal DWT levels
    int verbose;                 // Verbose output flag
    int frame_count;             // Current frame number for encoding
    float adjusted_quantiser_y_float;  // For bitrate control (if needed)
    float dither_accumulator;    // Dither accumulator for bitrate mode
    int width;                   // Frame width
    int height;                  // Frame height
    int perceptual_tuning;       // 1 = perceptual quantization, 0 = uniform
};

// GOP slot for circular buffering
typedef struct gop_slot {
    // Status
    volatile int status;          // GOP_STATUS_* values
    int gop_index;                // Sequential GOP number

    // Input data
    uint8_t **rgb_frames;         // [frame][width*height*3] RGB data
    int num_frames;               // Number of frames in this GOP
    int *frame_numbers;           // Original frame indices (for timecodes)
    int width, height;            // Frame dimensions

    // Audio data
    float *pcm_samples;           // Stereo PCM32f samples (L,R,L,R,...)
    size_t num_audio_samples;     // Samples per channel

    // Output data (filled by worker thread)
    tav_encoder_packet_t *packets;     // Array of output packets
    int num_packets;                   // Number of packets in this GOP

    // Error handling
    int encoding_failed;
    char error_message[MAX_ERROR_MESSAGE];

    // Synchronization
    mtx_t mutex;
    cnd_t status_changed;
} gop_slot_t;

// Thread-local worker context
typedef struct thread_worker_context {
    int thread_id;
    struct thread_pool *pool;

    // Thread-local work buffers (reused across GOPs)
    float **work_y_frames;        // [max_gop_size][max_pixels]
    float **work_co_frames;
    float **work_cg_frames;
    int16_t **quantised_y;
    int16_t **quantised_co;
    int16_t **quantised_cg;
    uint8_t *compression_buffer;
    size_t compression_buffer_size;
    ZSTD_CCtx *zstd_ctx;

    // Buffer sizing
    int max_gop_frames;
    size_t max_frame_pixels;
} thread_worker_context_t;

// Thread pool structure
typedef struct thread_pool {
    int num_threads;
    thrd_t *worker_threads;

    // Circular buffer of GOP slots
    gop_slot_t *slots;
    int num_slots;                // 2 * num_threads
    int slot_capacity;            // Max frames per GOP

    // Producer state (frame submission)
    int next_slot_to_fill;
    int total_gops_produced;
    int producer_finished;        // 1 when no more frames

    // Job queue for workers
    int *job_queue;
    int job_queue_head;
    int job_queue_tail;
    int job_queue_size;
    int job_queue_capacity;
    mtx_t job_queue_mutex;
    cnd_t job_available;
    cnd_t slot_available;

    // Shutdown signal
    int shutdown;

    // Shared encoder context (read-only)
    struct tav_encoder_context *shared_ctx;
} thread_pool_t;

// Main encoder context (opaque to API users)
struct tav_encoder_context {
    // Configuration (from params)
    int width, height;
    int fps_num, fps_den;
    int wavelet_type;
    int temporal_wavelet;
    int decomp_levels;
    int temporal_levels;
    int channel_layout;
    int perceptual_tuning;
    int enable_temporal_dwt;
    int gop_size;
    int enable_two_pass;
    int quality_level, quality_y, quality_co, quality_cg;
    int dead_zone_threshold;
    int entropy_coder;
    int zstd_level;
    int num_threads;
    int encoder_preset;
    int verbose;
    int monoblock;

    // Derived quantizer values (QLUT indices)
    int quantiser_y, quantiser_co, quantiser_cg;

    // Compatibility encoder for modules (quantization, DWT)
    tav_encoder_t *compat_enc;

    // Thread pool (NULL if single-threaded)
    thread_pool_t *pool;

    // Single-threaded GOP buffer
    uint8_t **gop_rgb_frames;     // [frame][pixel*3]
    int gop_frame_count;
    int64_t *gop_frame_pts;       // Presentation timestamps

    // TAD audio quality mapping
    int tad_max_index;

    // Error handling
    char error_message[MAX_ERROR_MESSAGE];

    // Statistics
    int64_t frames_encoded;
    int64_t gops_encoded;
    size_t total_bytes;
    size_t video_bytes;
    size_t audio_bytes;
    time_t start_time;
};

// =============================================================================
// Forward Declarations
// =============================================================================

static int encode_gop_intra_only(tav_encoder_context_t *ctx, gop_slot_t *slot);
static int encode_gop_unified(tav_encoder_context_t *ctx, gop_slot_t *slot);
static int worker_thread_main(void *arg);
static void free_gop_slot(gop_slot_t *slot);

static tav_encoder_t *create_compat_encoder(tav_encoder_context_t *ctx);
static void free_compat_encoder(tav_encoder_t *enc);

static size_t preprocess_coefficients_ezbc(int16_t *coeffs_y, int16_t *coeffs_co, int16_t *coeffs_cg, int16_t *coeffs_alpha,
                                           int coeff_count, int width, int height, int channel_layout,
                                           uint8_t *output_buffer);
static size_t preprocess_gop_unified(preprocess_mode_t preprocess_mode, int16_t **quant_y, int16_t **quant_co, int16_t **quant_cg,
                                     int num_frames, int num_pixels, int width, int height, int channel_layout,
                                     uint8_t *output_buffer);
static void rgb_to_colour_space_frame(tav_encoder_context_t *ctx, const uint8_t *rgb,
                                     float *c1, float *c2, float *c3,
                                     int width, int height);

// =============================================================================
// Parameter Initialization
// =============================================================================

void tav_encoder_params_init(tav_encoder_params_t *params, int width, int height) {
    memset(params, 0, sizeof(tav_encoder_params_t));

    // Video dimensions
    params->width = width;
    params->height = height;
    params->fps_num = 60;
    params->fps_den = 1;

    // Wavelet defaults
    params->wavelet_type = 1;          // CDF 9/7 (best compression)
    params->temporal_wavelet = 255;    // Always Haar
    params->decomp_levels = 0;         // Auto-calculate
    params->temporal_levels = 2;       // Always 2

    // Color space
    params->channel_layout = 0;        // YCoCg-R
    params->perceptual_tuning = 1;     // Enable HVS model

    // GOP settings
    params->enable_temporal_dwt = 1;   // Enable 3D DWT GOP encoding
    params->gop_size = 0;              // Auto (8 for 60fps, 16 for 30fps)
    params->enable_two_pass = 1;       // Enable scene change detection

    // Quality defaults (level 3 = balanced)
    params->quality_level = 3;
    params->quality_y = QUALITY_Y[3];    // 11 - quantiser index
    params->quality_co = QUALITY_CO[3];  // 76 - quantiser index
    params->quality_cg = QUALITY_CG[3];  // 99 - quantiser index
    params->dead_zone_threshold = DEAD_ZONE_THRESHOLD[3];  // 1.1 for Q3

    // Compression
    params->entropy_coder = 1;         // EZBC as default
    params->zstd_level = 7;            // Balanced compression/speed

    // Threading
    params->num_threads = 0;           // Single-threaded (multi-threading not yet implemented)

    // Encoder presets
    params->encoder_preset = 0;        // None

    // Advanced
    params->verbose = 0;
    params->monoblock = 1;             // Single tile (always 1 for current implementation)
}

// =============================================================================
// Encoder Creation
// =============================================================================

tav_encoder_context_t *tav_encoder_create(const tav_encoder_params_t *params) {
    if (!params) {
        return NULL;
    }

    // Validate parameters
    if (params->width <= 0 || params->height <= 0) {
        fprintf(stderr, "ERROR: Invalid dimensions %dx%d\n", params->width, params->height);
        return NULL;
    }

    if (params->width % 2 != 0 || params->height % 2 != 0) {
        fprintf(stderr, "ERROR: Dimensions must be even (got %dx%d)\n", params->width, params->height);
        return NULL;
    }

    // Allocate context
    tav_encoder_context_t *ctx = calloc(1, sizeof(tav_encoder_context_t));
    if (!ctx) {
        fprintf(stderr, "ERROR: Failed to allocate encoder context\n");
        return NULL;
    }

    // Copy configuration
    ctx->width = params->width;
    ctx->height = params->height;
    ctx->fps_num = params->fps_num;
    ctx->fps_den = params->fps_den;
    ctx->wavelet_type = params->wavelet_type;
    ctx->temporal_wavelet = params->temporal_wavelet;
    ctx->decomp_levels = params->decomp_levels;
    ctx->temporal_levels = params->temporal_levels;
    ctx->channel_layout = params->channel_layout;
    ctx->perceptual_tuning = params->perceptual_tuning;
    ctx->enable_temporal_dwt = params->enable_temporal_dwt;
    ctx->gop_size = params->gop_size;
    ctx->enable_two_pass = params->enable_two_pass;
    ctx->quality_level = params->quality_level;  // CRITICAL: Was missing, caused quality_level=0
    ctx->quality_y = params->quality_y;
    ctx->quality_co = params->quality_co;
    ctx->quality_cg = params->quality_cg;
    ctx->dead_zone_threshold = params->dead_zone_threshold;
    ctx->entropy_coder = params->entropy_coder;
    ctx->zstd_level = params->zstd_level;
    ctx->num_threads = params->num_threads;
    ctx->encoder_preset = params->encoder_preset;
    ctx->verbose = params->verbose;
    ctx->monoblock = params->monoblock;

    // quality_y/co/cg already contain quantiser indices (0-255)
    // Clamp to valid range
    if (ctx->quality_y < 0) ctx->quality_y = 0;
    if (ctx->quality_y > 255) ctx->quality_y = 255;
    if (ctx->quality_co < 0) ctx->quality_co = 0;
    if (ctx->quality_co > 255) ctx->quality_co = 255;
    if (ctx->quality_cg < 0) ctx->quality_cg = 0;
    if (ctx->quality_cg > 255) ctx->quality_cg = 255;

    // Copy quantiser indices for encoding
    ctx->quantiser_y = ctx->quality_y;
    ctx->quantiser_co = ctx->quality_co;
    ctx->quantiser_cg = ctx->quality_cg;

    // Force EZBC entropy coder (Twobitmap is deprecated)
    ctx->entropy_coder = 1;
    // Force Haar temporal
    ctx->temporal_wavelet = 255;
    // Force temporal level 2
    ctx->temporal_levels = 2;

    // Calculate decomp levels if auto (0)
    if (ctx->decomp_levels == 0) {
        int levels = 0;
        int min_dim = (ctx->width < ctx->height) ? ctx->width : ctx->height;
        // Keep halving until we reach minimum size
        while (min_dim >= 32) {
            min_dim /= 2;
            levels++;
        }
        // Cap at 6 levels maximum
        ctx->decomp_levels = (levels > 6) ? 6 : levels;
    }

    // Calculate GOP size if auto (0)
    if (ctx->gop_size == 0) {
        int fps = ctx->fps_num / ctx->fps_den;
        if (fps >= 50) {
            ctx->gop_size = 8;   // High frame rate: smaller GOPs
        } else if (fps >= 25) {
            ctx->gop_size = 16;  // Medium frame rate
        } else {
            ctx->gop_size = 24;  // Low frame rate: larger GOPs
        }
    }

    // Auto-select temporal wavelet if still at default (255=Haar) and temporal DWT enabled
    // Logic from old encoder: use Haar for large videos, CDF 5/3 for small/low-quality videos
    if (ctx->enable_temporal_dwt && ctx->temporal_wavelet == 255) {
        int num_pixels = ctx->width * ctx->height;
        int use_pure_haar = 0;

        // Smart preset based on resolution and quality
        // For large videos with reasonable quality, use Haar (better compression)
        // For smaller videos or low quality, use CDF 5/3 (better detail preservation)
        if ((num_pixels >= 820000 && ctx->quantiser_y <= 29) ||
            (num_pixels >= 500000 && ctx->quantiser_y <= 14) ||
            (num_pixels >= 340000 && ctx->quantiser_y <= 7) ||
            (num_pixels >= 260000 && ctx->quantiser_y <= 3)) {
            use_pure_haar = 1;
        }

        if (use_pure_haar) {
            ctx->temporal_wavelet = 255;  // Keep Haar
            if (ctx->verbose) {
                printf("Auto-selected Haar temporal wavelet (resolution: %dx%d = %d pixels, quantiser_y = %d)\n",
                       ctx->width, ctx->height, num_pixels, ctx->quantiser_y);
            }
        } else {
            ctx->temporal_wavelet = 255;  // Keep Haar
            ctx->encoder_preset |= 1; // Enable Sports mode
            if (ctx->verbose) {
                printf("Auto-selected Haar temporal wavelet with sports mode (resolution: %dx%d = %d pixels, quantiser_y = %d)\n",
                       ctx->width, ctx->height, num_pixels, ctx->quantiser_y);
            }
        }
    }

    // Determine thread count
    if (ctx->num_threads < 0) {
        // Auto-detect: use system thread count
        ctx->num_threads = 4;  // Conservative default (TODO: detect actual CPU count)
    } else if (ctx->num_threads == 0) {
        ctx->num_threads = 0;  // Single-threaded
    }

    // Allocate single-threaded GOP buffer if not using threading
    if (ctx->num_threads == 0) {
        ctx->gop_rgb_frames = calloc(ctx->gop_size, sizeof(uint8_t *));
        ctx->gop_frame_pts = calloc(ctx->gop_size, sizeof(int64_t));
        if (!ctx->gop_rgb_frames || !ctx->gop_frame_pts) {
            snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
                     "Failed to allocate GOP buffers");
            tav_encoder_free(ctx);
            return NULL;
        }

        size_t frame_size = ctx->width * ctx->height * 3;
        for (int i = 0; i < ctx->gop_size; i++) {
            ctx->gop_rgb_frames[i] = malloc(frame_size);
            if (!ctx->gop_rgb_frames[i]) {
                snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
                         "Failed to allocate GOP frame buffer %d", i);
                tav_encoder_free(ctx);
                return NULL;
            }
        }
    }

    // Set TAD audio quality mapping (from quality_y)
    ctx->tad_max_index = tad32_quality_to_max_index(ctx->quality_y);

    // Initialize statistics
    ctx->start_time = time(NULL);

    // Create compatibility encoder for extracted modules
    ctx->compat_enc = create_compat_encoder(ctx);
    if (!ctx->compat_enc) {
        snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
                 "Failed to create compatibility encoder");
        tav_encoder_free(ctx);
        return NULL;
    }

    // TODO: Initialize thread pool if multi-threaded
    // (Thread pool implementation deferred - requires extracting worker logic)

    if (ctx->verbose) {
        printf("%s created:\n", ENCODER_VERSION);
        printf("  Resolution: %dx%d @ %d/%d fps\n",
               ctx->width, ctx->height, ctx->fps_num, ctx->fps_den);
        printf("  GOP size: %d frames\n", ctx->gop_size);
        printf("  Wavelet: %d (spatial), %d (temporal)\n",
               ctx->wavelet_type, ctx->temporal_wavelet);
        printf("  DWT levels: %d (spatial), %d (temporal)\n",
               ctx->decomp_levels, ctx->temporal_levels);
        printf("  Quality: Y=%d, Co=%d, Cg=%d\n",
               ctx->quality_y, ctx->quality_co, ctx->quality_cg);
        printf("  Threads: %d\n", ctx->num_threads);
    }

    return ctx;
}

// =============================================================================
// Encoder Cleanup
// =============================================================================

void tav_encoder_free(tav_encoder_context_t *ctx) {
    if (!ctx) return;

    // Free single-threaded GOP buffers
    if (ctx->gop_rgb_frames) {
        for (int i = 0; i < ctx->gop_size; i++) {
            free(ctx->gop_rgb_frames[i]);
        }
        free(ctx->gop_rgb_frames);
    }
    free(ctx->gop_frame_pts);

    // Free compatibility encoder
    free_compat_encoder(ctx->compat_enc);

    // TODO: Shutdown thread pool if exists

    free(ctx);
}

// =============================================================================
// Error Handling
// =============================================================================

const char *tav_encoder_get_error(tav_encoder_context_t *ctx) {
    if (!ctx) return "Invalid encoder context";
    return ctx->error_message[0] ? ctx->error_message : NULL;
}

void tav_encoder_get_params(tav_encoder_context_t *ctx, tav_encoder_params_t *params) {
    if (!ctx || !params) return;

    params->width = ctx->width;
    params->height = ctx->height;
    params->fps_num = ctx->fps_num;
    params->fps_den = ctx->fps_den;
    params->wavelet_type = ctx->wavelet_type;
    params->temporal_wavelet = ctx->temporal_wavelet;
    params->decomp_levels = ctx->decomp_levels;           // Calculated value
    params->temporal_levels = ctx->temporal_levels;       // Calculated value
    params->channel_layout = ctx->channel_layout;
    params->perceptual_tuning = ctx->perceptual_tuning;
    params->enable_temporal_dwt = ctx->enable_temporal_dwt;
    params->gop_size = ctx->gop_size;                     // Calculated value
    params->enable_two_pass = ctx->enable_two_pass;
    params->quality_y = ctx->quality_y;
    params->quality_co = ctx->quality_co;
    params->quality_cg = ctx->quality_cg;
    params->dead_zone_threshold = ctx->dead_zone_threshold;
    params->entropy_coder = ctx->entropy_coder;           // Forced to 1 (EZBC)
    params->zstd_level = ctx->zstd_level;
    params->num_threads = ctx->num_threads;
    params->encoder_preset = ctx->encoder_preset;
    params->verbose = ctx->verbose;
    params->monoblock = ctx->monoblock;
}

int tav_encoder_validate_context(tav_encoder_context_t *ctx) {
    if (!ctx) return 0;

    // Basic sanity checks
    if (ctx->width < 16 || ctx->width > 8192) return 0;
    if (ctx->height < 16 || ctx->height > 8192) return 0;
    if (ctx->gop_size < 1 || ctx->gop_size > 48) return 0;

    return 1;
}

// =============================================================================
// Statistics
// =============================================================================

void tav_encoder_get_stats(tav_encoder_context_t *ctx, tav_encoder_stats_t *stats) {
    if (!ctx || !stats) return;

    memset(stats, 0, sizeof(tav_encoder_stats_t));

    stats->frames_encoded = ctx->frames_encoded;
    stats->gops_encoded = ctx->gops_encoded;
    stats->total_bytes = ctx->total_bytes;
    stats->video_bytes = ctx->video_bytes;
    stats->audio_bytes = ctx->audio_bytes;

    // Calculate average bitrate
    time_t elapsed = time(NULL) - ctx->start_time;
    if (elapsed > 0) {
        double seconds = (double)ctx->frames_encoded / ((double)ctx->fps_num / ctx->fps_den);
        if (seconds > 0) {
            stats->avg_bitrate_kbps = (ctx->total_bytes * 8.0) / (seconds * 1000.0);
        }
    }

    // Calculate encoding speed
    if (elapsed > 0) {
        stats->encoding_fps = (double)ctx->frames_encoded / elapsed;
    }
}

// =============================================================================
// Frame Encoding (Single-threaded implementation for now)
// =============================================================================

int tav_encoder_encode_frame(tav_encoder_context_t *ctx,
                              const uint8_t *rgb_frame,
                              int64_t frame_pts,
                              tav_encoder_packet_t **packet) {
    if (!ctx || !rgb_frame || !packet) {
        if (ctx) {
            snprintf(ctx->error_message, MAX_ERROR_MESSAGE, "Invalid parameters");
        }
        return -1;
    }

    *packet = NULL;  // No packet until GOP is complete

    // Single-threaded implementation: buffer frames until GOP full
    if (ctx->num_threads == 0) {
        // Copy RGB frame to GOP buffer
        size_t frame_size = ctx->width * ctx->height * 3;
        memcpy(ctx->gop_rgb_frames[ctx->gop_frame_count], rgb_frame, frame_size);
        ctx->gop_frame_pts[ctx->gop_frame_count] = frame_pts;
        ctx->gop_frame_count++;

        // Check if GOP is full
        if (ctx->gop_frame_count >= ctx->gop_size) {
            // Create temporary GOP slot
            gop_slot_t slot = {0};
            slot.rgb_frames = ctx->gop_rgb_frames;
            slot.num_frames = ctx->gop_frame_count;
            slot.frame_numbers = tav_calloc(ctx->gop_frame_count, sizeof(int));
            for (int i = 0; i < ctx->gop_frame_count; i++) {
                slot.frame_numbers[i] = (int)(ctx->frames_encoded + i);
            }
            slot.width = ctx->width;
            slot.height = ctx->height;

            // Encode GOP
            int result;
            if (ctx->enable_temporal_dwt && ctx->gop_size > 1) {
                result = encode_gop_unified(ctx, &slot);
            } else {
                result = encode_gop_intra_only(ctx, &slot);
            }

            free(slot.frame_numbers);

            if (result < 0) {
                // Error message already set by encoding function
                return -1;
            }

            // Extract packets from slot
            if (slot.num_packets > 0) {
                *packet = &slot.packets[0];
            }

            // Update statistics
            ctx->frames_encoded += ctx->gop_frame_count;
            ctx->gops_encoded++;
            ctx->video_bytes += slot.packets[0].size;
            ctx->total_bytes += slot.packets[0].size;

            // Reset GOP buffer
            ctx->gop_frame_count = 0;

            return 1;  // Packet ready
        }

        return 0;  // Buffering, no packet yet
    }

    // Multi-threaded implementation
    // TODO: Submit frame to thread pool
    snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
             "Multi-threaded encoding not yet implemented");
    return -1;
}

// =============================================================================
// Flush Encoder
// =============================================================================

int tav_encoder_flush(tav_encoder_context_t *ctx,
                      tav_encoder_packet_t **packet) {
    if (!ctx || !packet) {
        if (ctx) {
            snprintf(ctx->error_message, MAX_ERROR_MESSAGE, "Invalid parameters");
        }
        return -1;
    }

    *packet = NULL;

    // Encode any remaining frames in GOP buffer
    if (ctx->num_threads == 0 && ctx->gop_frame_count > 0) {
        // Create temporary GOP slot for partial GOP
        gop_slot_t slot = {0};
        slot.rgb_frames = ctx->gop_rgb_frames;
        slot.num_frames = ctx->gop_frame_count;
        slot.frame_numbers = tav_calloc(ctx->gop_frame_count, sizeof(int));
        for (int i = 0; i < ctx->gop_frame_count; i++) {
            slot.frame_numbers[i] = (int)(ctx->frames_encoded + i);
        }
        slot.width = ctx->width;
        slot.height = ctx->height;

        int result;

        // For partial GOPs: use unified mode if temporal DWT enabled and >1 frame,
        // otherwise encode as I-frames one at a time
        if (ctx->enable_temporal_dwt && ctx->gop_frame_count > 1) {
            result = encode_gop_unified(ctx, &slot);
        } else if (ctx->gop_frame_count == 1) {
            result = encode_gop_intra_only(ctx, &slot);
        } else {
            // Encode each frame separately as I-frame
            // TODO: This is inefficient - should encode them in a batch
            // For now, just encode the first frame
            gop_slot_t single_slot = {0};
            single_slot.rgb_frames = malloc(sizeof(uint8_t*));
            single_slot.rgb_frames[0] = ctx->gop_rgb_frames[0];
            single_slot.num_frames = 1;
            single_slot.frame_numbers = malloc(sizeof(int));
            single_slot.frame_numbers[0] = (int)ctx->frames_encoded;
            single_slot.width = ctx->width;
            single_slot.height = ctx->height;

            result = encode_gop_intra_only(ctx, &single_slot);

            if (result == 0 && single_slot.num_packets > 0) {
                // Copy packet pointer
                slot.packets = single_slot.packets;
                slot.num_packets = single_slot.num_packets;

                // Don't free single_slot.packets - we transferred ownership
            }

            free(single_slot.rgb_frames);
            free(single_slot.frame_numbers);

            // Mark only 1 frame as encoded (we'll call flush again for others)
            ctx->gop_frame_count--;
            // Shift remaining frames down
            for (int i = 0; i < ctx->gop_frame_count; i++) {
                ctx->gop_rgb_frames[i] = ctx->gop_rgb_frames[i+1];
            }
        }

        free(slot.frame_numbers);

        if (result < 0) {
            // Error message already set by encoding function
            return -1;
        }

        // Extract packets from slot
        if (slot.num_packets > 0) {
            *packet = slot.packets;  // Transfer ownership to caller
        }

        // Update statistics (only for frames actually encoded)
        int frames_in_packet = (ctx->enable_temporal_dwt || ctx->gop_frame_count == 1)
                              ? slot.num_frames : 1;
        ctx->frames_encoded += frames_in_packet;
        ctx->gops_encoded++;
        if (slot.num_packets > 0) {
            ctx->video_bytes += slot.packets[0].size;
            ctx->total_bytes += slot.packets[0].size;
        }

        // Reset GOP buffer if we encoded everything
        if (!ctx->enable_temporal_dwt && ctx->gop_frame_count > 0) {
            // Still have frames to encode - return 1 to continue flushing
            return 1;
        }

        ctx->gop_frame_count = 0;

        return 1;  // Packet ready
    }

    // Multi-threaded: wait for all pending GOPs to complete
    if (ctx->num_threads > 0) {
        // TODO: Flush thread pool
        snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
                 "Multi-threaded flush not yet implemented");
        return -1;
    }

    return 0;  // No more packets
}

void tav_encoder_free_packet(tav_encoder_packet_t *packet) {
    if (!packet) return;

    if (packet->data) {
        free(packet->data);
    }
    free(packet);
}

// =============================================================================
// GOP-Level Encoding (Thread-Safe)
// =============================================================================

int tav_encoder_encode_gop(tav_encoder_context_t *ctx,
                            const uint8_t **rgb_frames,
                            int num_frames,
                            const int *frame_numbers,
                            tav_encoder_packet_t **packet) {
    if (!ctx || !rgb_frames || !packet) {
        if (ctx) {
            snprintf(ctx->error_message, MAX_ERROR_MESSAGE, "Invalid parameters");
        }
        return -1;
    }

    if (num_frames < 1 || num_frames > 24) {
        snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
                 "Invalid GOP size: %d (must be 1-24)", num_frames);
        return -1;
    }

    *packet = NULL;

    // Create temporary GOP slot
    gop_slot_t slot = {0};

    // Allocate array of frame pointers (casting away const for internal use)
    slot.rgb_frames = tav_malloc(num_frames * sizeof(uint8_t*));
    for (int i = 0; i < num_frames; i++) {
        slot.rgb_frames[i] = (uint8_t*)rgb_frames[i];  // Cast away const
    }

    slot.num_frames = num_frames;
    slot.width = ctx->width;
    slot.height = ctx->height;

    // Copy or generate frame numbers
    slot.frame_numbers = tav_calloc(num_frames, sizeof(int));
    if (frame_numbers) {
        memcpy(slot.frame_numbers, frame_numbers, num_frames * sizeof(int));
    } else {
        // Generate sequential frame numbers if not provided
        for (int i = 0; i < num_frames; i++) {
            slot.frame_numbers[i] = i;
        }
    }

    // Encode GOP
    int result;
    if (ctx->enable_temporal_dwt && num_frames > 1) {
        result = encode_gop_unified(ctx, &slot);
    } else {
        result = encode_gop_intra_only(ctx, &slot);
    }

    // Cleanup temporary allocations
    free(slot.rgb_frames);
    free(slot.frame_numbers);

    if (result < 0) {
        // Error message already set by encoding function
        return -1;
    }

    // Extract packet from slot
    if (slot.num_packets > 0) {
        *packet = &slot.packets[0];
    } else {
        snprintf(ctx->error_message, MAX_ERROR_MESSAGE, "Encoding produced no packets");
        return -1;
    }

    // NOTE: Statistics NOT updated here - caller manages that
    // This function is stateless for multithreading

    return 1;  // Packet ready
}

// =============================================================================
// Audio Encoding
// =============================================================================

int tav_encoder_encode_audio(tav_encoder_context_t *ctx,
                              const float *pcm_samples,
                              size_t num_samples,
                              tav_encoder_packet_t **packet) {
    if (!ctx || !pcm_samples || !packet) {
        if (ctx) {
            snprintf(ctx->error_message, MAX_ERROR_MESSAGE, "Invalid parameters");
        }
        return -1;
    }

    *packet = NULL;

    // Validate chunk size
    if (num_samples < TAD32_MIN_CHUNK_SIZE) {
        snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
                 "Audio chunk too small (%zu < %d)", num_samples, TAD32_MIN_CHUNK_SIZE);
        return -1;
    }

    // Allocate output buffer (conservative estimate: 4 bytes per sample)
    size_t output_capacity = num_samples * 4 + 1024;
    uint8_t *tad_data = malloc(output_capacity);
    if (!tad_data) {
        snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
                 "Failed to allocate TAD output buffer");
        return -1;
    }

    // Encode audio with TAD encoder
    size_t tad_size = tad32_encode_chunk(pcm_samples, num_samples,
                                         ctx->tad_max_index, 1.0f, tad_data);
    if (tad_size == 0) {
        free(tad_data);
        snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
                 "TAD audio encoding failed");
        return -1;
    }

    // Create packet
    tav_encoder_packet_t *pkt = calloc(1, sizeof(tav_encoder_packet_t));
    if (!pkt) {
        free(tad_data);
        snprintf(ctx->error_message, MAX_ERROR_MESSAGE,
                 "Failed to allocate packet");
        return -1;
    }

    pkt->data = tad_data;
    pkt->size = tad_size;
    pkt->packet_type = TAV_PACKET_AUDIO_TAD;
    pkt->frame_number = -1;  // Audio doesn't have frame number
    pkt->is_video = 0;

    *packet = pkt;

    ctx->audio_bytes += tad_size;
    ctx->total_bytes += tad_size;

    return 1;  // Packet ready
}

// =============================================================================
// Compatibility Encoder Helpers
// =============================================================================

/**
 * Create compatibility encoder structure for extracted modules.
 * Calculates subband widths/heights arrays needed by quantization module.
 */
static tav_encoder_t *create_compat_encoder(tav_encoder_context_t *ctx) {
    tav_encoder_t *enc = calloc(1, sizeof(tav_encoder_t));
    if (!enc) return NULL;

    // Copy basic fields
    enc->quality_level = ctx->quality_level;
    enc->dead_zone_threshold = ctx->dead_zone_threshold;
    enc->encoder_preset = ctx->encoder_preset;
    enc->temporal_decomp_levels = ctx->temporal_levels;
    enc->verbose = ctx->verbose;
    enc->perceptual_tuning = ctx->perceptual_tuning;

    // Copy frame dimensions (needed by quantisation functions)
    enc->width = ctx->width;
    enc->height = ctx->height;
    enc->decomp_levels = ctx->decomp_levels;
    enc->frame_count = 0;  // Will be updated during encoding

    // Calculate subband widths and heights arrays
    // These are needed by the perceptual quantization module
    int max_levels = ctx->decomp_levels + 1;
    enc->widths = calloc(max_levels, sizeof(int));
    enc->heights = calloc(max_levels, sizeof(int));

    if (!enc->widths || !enc->heights) {
        free(enc->widths);
        free(enc->heights);
        free(enc);
        return NULL;
    }

    // Level 0 is full resolution
    int w = ctx->width;
    int h = ctx->height;

    for (int level = 0; level < max_levels; level++) {
        enc->widths[level] = w;
        enc->heights[level] = h;
        w = (w + 1) / 2;  // Next level is half resolution (rounded up)
        h = (h + 1) / 2;
    }

    return enc;
}

/**
 * Free compatibility encoder structure.
 */
static void free_compat_encoder(tav_encoder_t *enc) {
    if (!enc) return;
    free(enc->widths);
    free(enc->heights);
    free(enc);
}

// =============================================================================
// GOP Encoding Implementation
// =============================================================================

/**
 * Convert RGB frame to color space (YCoCg-R or ICtCp).
 * Helper function for GOP encoding.
 */
static void rgb_to_colour_space_frame(tav_encoder_context_t *ctx, const uint8_t *rgb,
                                     float *c1, float *c2, float *c3,
                                     int width, int height) {
    int num_pixels = width * height;

    if (ctx->channel_layout == 1) {  // ICtCp mode
        // Use color module function for ICtCp conversion
        for (int i = 0; i < num_pixels; i++) {
            double I, Ct, Cp;
            tav_srgb8_to_ictcp_hlg(rgb[i*3], rgb[i*3+1], rgb[i*3+2], &I, &Ct, &Cp);
            c1[i] = (float)I;
            c2[i] = (float)Ct;
            c3[i] = (float)Cp;
        }
    } else {  // YCoCg-R mode (default)
        tav_rgb_to_ycocg(rgb, c1, c2, c3, width, height);
    }
}

/**
 * Preprocess coefficients using EZBC encoding (single frame).
 * Based on encoder_tav.c:preprocess_coefficients_ezbc().
 * NOTE: EZBC encoder allocates its own output buffer, which we copy to output_buffer.
 */
static size_t preprocess_coefficients_ezbc(int16_t *coeffs_y, int16_t *coeffs_co, int16_t *coeffs_cg, int16_t *coeffs_alpha,
                                           int coeff_count, int width, int height, int channel_layout,
                                           uint8_t *output_buffer) {
    const channel_layout_config_t *config = &channel_layouts[channel_layout];
    size_t total_size = 0;
    uint8_t *write_ptr = output_buffer;

    // Encode each active channel separately with EZBC
    int16_t *channel_coeffs[4] = {coeffs_y, coeffs_co, coeffs_cg, coeffs_alpha};
    int channel_active[4] = {config->has_y, config->has_co, config->has_cg, config->has_alpha};

    for (int ch = 0; ch < 4; ch++) {
        if (!channel_active[ch] || !channel_coeffs[ch]) continue;

        // EZBC encoder allocates output buffer
        uint8_t *ezbc_output = NULL;
        size_t encoded_size = tav_encode_channel_ezbc(
            channel_coeffs[ch], coeff_count, width, height,
            &ezbc_output  // Double pointer - EZBC allocates memory
        );

        if (encoded_size == 0 || !ezbc_output) {
            continue;  // Skip channel if encoding failed
        }

        // Write channel size header (4 bytes)
        *((uint32_t*)write_ptr) = (uint32_t)encoded_size;
        write_ptr += sizeof(uint32_t);

        // Copy EZBC output to our buffer
        memcpy(write_ptr, ezbc_output, encoded_size);
        write_ptr += encoded_size;
        total_size += sizeof(uint32_t) + encoded_size;

        // Free EZBC-allocated buffer
        free(ezbc_output);
    }

    return total_size;
}

/**
 * Unified GOP preprocessing function.
 * Handles twobitmap, EZBC, and raw coefficient modes.
 * Based on encoder_tav.c:preprocess_gop_unified().
 */
static size_t preprocess_gop_unified(preprocess_mode_t preprocess_mode, int16_t **quant_y, int16_t **quant_co, int16_t **quant_cg,
                                     int num_frames, int num_pixels, int width, int height, int channel_layout,
                                     uint8_t *output_buffer) {
    const channel_layout_config_t *config = &channel_layouts[channel_layout];

    // Raw mode: just concatenate all coefficients
    if (preprocess_mode == PREPROCESS_RAW) {
        size_t offset = 0;

        // Copy all Y frames
        if (config->has_y && quant_y) {
            for (int frame = 0; frame < num_frames; frame++) {
                if (quant_y[frame]) {
                    memcpy(output_buffer + offset, quant_y[frame], num_pixels * sizeof(int16_t));
                    offset += num_pixels * sizeof(int16_t);
                }
            }
        }

        // Copy all Co frames
        if (config->has_co && quant_co) {
            for (int frame = 0; frame < num_frames; frame++) {
                if (quant_co[frame]) {
                    memcpy(output_buffer + offset, quant_co[frame], num_pixels * sizeof(int16_t));
                    offset += num_pixels * sizeof(int16_t);
                }
            }
        }

        // Copy all Cg frames
        if (config->has_cg && quant_cg) {
            for (int frame = 0; frame < num_frames; frame++) {
                if (quant_cg[frame]) {
                    memcpy(output_buffer + offset, quant_cg[frame], num_pixels * sizeof(int16_t));
                    offset += num_pixels * sizeof(int16_t);
                }
            }
        }

        return offset;
    }

    // EZBC mode: encode each frame separately with EZBC
    if (preprocess_mode == PREPROCESS_EZBC) {
        size_t total_size = 0;
        uint8_t *write_ptr = output_buffer;

        for (int frame = 0; frame < num_frames; frame++) {
            // Encode this frame with EZBC
            size_t frame_size = preprocess_coefficients_ezbc(
                quant_y ? quant_y[frame] : NULL,
                quant_co ? quant_co[frame] : NULL,
                quant_cg ? quant_cg[frame] : NULL,
                NULL,  // No alpha in GOP mode
                num_pixels, width, height, channel_layout,
                write_ptr + sizeof(uint32_t)  // Leave space for size header
            );

            // Write frame size header
            *((uint32_t*)write_ptr) = (uint32_t)frame_size;
            write_ptr += sizeof(uint32_t) + frame_size;
            total_size += sizeof(uint32_t) + frame_size;
        }

        return total_size;
    }

    // Twobit-map mode: original unified GOP preprocessing
    const int map_bytes_per_frame = (num_pixels * 2 + 7) / 8;  // 2 bits per coefficient

    // Count "other" values (not 0, +1, or -1) for each channel across ALL frames
    int other_count_y = 0, other_count_co = 0, other_count_cg = 0;

    for (int frame = 0; frame < num_frames; frame++) {
        if (config->has_y && quant_y && quant_y[frame]) {
            for (int i = 0; i < num_pixels; i++) {
                int16_t val = quant_y[frame][i];
                if (val != 0 && val != 1 && val != -1) other_count_y++;
            }
        }
        if (config->has_co && quant_co && quant_co[frame]) {
            for (int i = 0; i < num_pixels; i++) {
                int16_t val = quant_co[frame][i];
                if (val != 0 && val != 1 && val != -1) other_count_co++;
            }
        }
        if (config->has_cg && quant_cg && quant_cg[frame]) {
            for (int i = 0; i < num_pixels; i++) {
                int16_t val = quant_cg[frame][i];
                if (val != 0 && val != 1 && val != -1) other_count_cg++;
            }
        }
    }

    // Calculate buffer layout
    uint8_t *write_ptr = output_buffer;

    // Significance maps: grouped by channel (all Y frames, then all Co frames, then all Cg frames)
    uint8_t *y_maps_start = write_ptr;
    if (config->has_y) write_ptr += map_bytes_per_frame * num_frames;

    uint8_t *co_maps_start = write_ptr;
    if (config->has_co) write_ptr += map_bytes_per_frame * num_frames;

    uint8_t *cg_maps_start = write_ptr;
    if (config->has_cg) write_ptr += map_bytes_per_frame * num_frames;

    // Value arrays: grouped by channel
    int16_t *y_values = (int16_t *)write_ptr;
    if (config->has_y) write_ptr += other_count_y * sizeof(int16_t);

    int16_t *co_values = (int16_t *)write_ptr;
    if (config->has_co) write_ptr += other_count_co * sizeof(int16_t);

    int16_t *cg_values = (int16_t *)write_ptr;
    if (config->has_cg) write_ptr += other_count_cg * sizeof(int16_t);

    // Clear all map bytes
    size_t total_map_bytes = 0;
    if (config->has_y) total_map_bytes += map_bytes_per_frame * num_frames;
    if (config->has_co) total_map_bytes += map_bytes_per_frame * num_frames;
    if (config->has_cg) total_map_bytes += map_bytes_per_frame * num_frames;
    memset(output_buffer, 0, total_map_bytes);

    // Process each frame and fill maps/values
    int y_value_idx = 0, co_value_idx = 0, cg_value_idx = 0;

    for (int frame = 0; frame < num_frames; frame++) {
        uint8_t *y_map = y_maps_start + frame * map_bytes_per_frame;
        uint8_t *co_map = co_maps_start + frame * map_bytes_per_frame;
        uint8_t *cg_map = cg_maps_start + frame * map_bytes_per_frame;

        for (int i = 0; i < num_pixels; i++) {
            size_t bit_pos = i * 2;
            size_t byte_idx = bit_pos / 8;
            size_t bit_offset = bit_pos % 8;

            // Process Y channel
            if (config->has_y && quant_y && quant_y[frame]) {
                int16_t val = quant_y[frame][i];
                uint8_t code;

                if (val == 0) code = 0;       // 00
                else if (val == 1) code = 1;  // 01
                else if (val == -1) code = 2; // 10
                else {
                    code = 3;  // 11
                    y_values[y_value_idx++] = val;
                }

                y_map[byte_idx] |= (code << bit_offset);
                if (bit_offset == 7 && byte_idx + 1 < (size_t)map_bytes_per_frame) {
                    y_map[byte_idx + 1] |= (code >> 1);
                }
            }

            // Process Co channel
            if (config->has_co && quant_co && quant_co[frame]) {
                int16_t val = quant_co[frame][i];
                uint8_t code;

                if (val == 0) code = 0;
                else if (val == 1) code = 1;
                else if (val == -1) code = 2;
                else {
                    code = 3;
                    co_values[co_value_idx++] = val;
                }

                co_map[byte_idx] |= (code << bit_offset);
                if (bit_offset == 7 && byte_idx + 1 < (size_t)map_bytes_per_frame) {
                    co_map[byte_idx + 1] |= (code >> 1);
                }
            }

            // Process Cg channel
            if (config->has_cg && quant_cg && quant_cg[frame]) {
                int16_t val = quant_cg[frame][i];
                uint8_t code;

                if (val == 0) code = 0;
                else if (val == 1) code = 1;
                else if (val == -1) code = 2;
                else {
                    code = 3;
                    cg_values[cg_value_idx++] = val;
                }

                cg_map[byte_idx] |= (code << bit_offset);
                if (bit_offset == 7 && byte_idx + 1 < (size_t)map_bytes_per_frame) {
                    cg_map[byte_idx + 1] |= (code >> 1);
                }
            }
        }
    }

    // Return total size
    return (size_t)(write_ptr - output_buffer);
}

/**
 * Encode single-frame I-frame (intra-only mode).
 * Uses 2D DWT on individual frame.
 */
static int encode_gop_intra_only(tav_encoder_context_t *ctx, gop_slot_t *slot) {
    const int width = slot->width;
    const int height = slot->height;
    const int num_pixels = width * height;
    const int num_frames = slot->num_frames;

    if (num_frames != 1) {
        snprintf(slot->error_message, MAX_ERROR_MESSAGE,
                 "encode_gop_intra_only called with %d frames (expected 1)", num_frames);
        return -1;
    }

    // Allocate work buffers for single frame
    float *work_y = tav_calloc(num_pixels, sizeof(float));
    float *work_co = tav_calloc(num_pixels, sizeof(float));
    float *work_cg = tav_calloc(num_pixels, sizeof(float));
    int16_t *quant_y = tav_calloc(num_pixels, sizeof(int16_t));
    int16_t *quant_co = tav_calloc(num_pixels, sizeof(int16_t));
    int16_t *quant_cg = tav_calloc(num_pixels, sizeof(int16_t));

    // Step 1: RGB to YCoCg-R (or ICtCp)
    rgb_to_colour_space_frame(ctx, slot->rgb_frames[0], work_y, work_co, work_cg, width, height);

    // Step 2: Apply 2D DWT
    tav_dwt_2d_forward(work_y, width, height, ctx->decomp_levels, ctx->wavelet_type);
    tav_dwt_2d_forward(work_co, width, height, ctx->decomp_levels, ctx->wavelet_type);
    tav_dwt_2d_forward(work_cg, width, height, ctx->decomp_levels, ctx->wavelet_type);

    // Step 3: Quantize coefficients
    // ctx->quantiser_y/co/cg contain QLUT indices, lookup actual quantiser values
    int base_quantiser_y = QLUT[ctx->quantiser_y];
    int base_quantiser_co = QLUT[ctx->quantiser_co];
    int base_quantiser_cg = QLUT[ctx->quantiser_cg];

    if (ctx->perceptual_tuning) {
        tav_quantise_perceptual(ctx->compat_enc, work_y, quant_y, num_pixels,
                               base_quantiser_y, (float)ctx->dead_zone_threshold, width, height, ctx->decomp_levels, 0, 0);
        tav_quantise_perceptual(ctx->compat_enc, work_co, quant_co, num_pixels,
                               base_quantiser_co, (float)ctx->dead_zone_threshold, width, height, ctx->decomp_levels, 1, 0);
        tav_quantise_perceptual(ctx->compat_enc, work_cg, quant_cg, num_pixels,
                               base_quantiser_cg, (float)ctx->dead_zone_threshold, width, height, ctx->decomp_levels, 1, 0);
    } else {
        tav_quantise_uniform(work_y, quant_y, num_pixels, base_quantiser_y,
                            (float)ctx->dead_zone_threshold, width, height,
                            ctx->decomp_levels, 0);
        tav_quantise_uniform(work_co, quant_co, num_pixels, base_quantiser_co,
                            (float)ctx->dead_zone_threshold, width, height,
                            ctx->decomp_levels, 1);
        tav_quantise_uniform(work_cg, quant_cg, num_pixels, base_quantiser_cg,
                            (float)ctx->dead_zone_threshold, width, height,
                            ctx->decomp_levels, 1);
    }

    // Step 4: Preprocess coefficients
    size_t preprocess_capacity = num_pixels * 3 * sizeof(int16_t) + 65536;  // Conservative
    uint8_t *preprocess_buffer = tav_malloc(preprocess_capacity);

    // Use EZBC preprocessing (Twobitmap is deprecated)
    size_t preprocessed_size = preprocess_coefficients_ezbc(
        quant_y, quant_co, quant_cg, NULL,
        num_pixels, width, height, ctx->channel_layout,
        preprocess_buffer
    );

    // Step 5: Zstd compress
    size_t compressed_bound = ZSTD_compressBound(preprocessed_size);
    uint8_t *compression_buffer = tav_malloc(compressed_bound);

    size_t compressed_size = ZSTD_compress(
        compression_buffer, compressed_bound,
        preprocess_buffer, preprocessed_size,
        ctx->zstd_level
    );

    if (ZSTD_isError(compressed_size)) {
        free(work_y); free(work_co); free(work_cg);
        free(quant_y); free(quant_co); free(quant_cg);
        free(preprocess_buffer);
        free(compression_buffer);
        snprintf(slot->error_message, MAX_ERROR_MESSAGE,
                 "Zstd compression failed: %s", ZSTD_getErrorName(compressed_size));
        return -1;
    }

    // Step 6: Format I-frame packet
    // Packet format: [type(1)][size(4)][data(N)]
    size_t packet_size = 1 + 4 + compressed_size;
    tav_encoder_packet_t *pkt = calloc(1, sizeof(tav_encoder_packet_t));
    pkt->data = malloc(packet_size);
    pkt->size = packet_size;
    pkt->packet_type = TAV_PACKET_IFRAME;
    pkt->frame_number = slot->frame_numbers[0];
    pkt->is_video = 1;

    uint8_t *write_ptr = pkt->data;
    *write_ptr++ = TAV_PACKET_IFRAME;
    uint32_t size_field = (uint32_t)compressed_size;
    memcpy(write_ptr, &size_field, 4);
    write_ptr += 4;
    memcpy(write_ptr, compression_buffer, compressed_size);

    // Store packet in slot
    slot->packets = pkt;
    slot->num_packets = 1;

    // Cleanup
    free(work_y); free(work_co); free(work_cg);
    free(quant_y); free(quant_co); free(quant_cg);
    free(preprocess_buffer);
    free(compression_buffer);

    return 0;  // Success
}

/**
 * Encode multi-frame GOP using 3D DWT (unified mode).
 * Uses temporal + spatial DWT for optimal compression.
 */
static int encode_gop_unified(tav_encoder_context_t *ctx, gop_slot_t *slot) {
    const int width = slot->width;
    const int height = slot->height;
    const int num_pixels = width * height;
    const int num_frames = slot->num_frames;

    // Allocate work buffers for all frames
    float **work_y = tav_calloc(num_frames, sizeof(float*));
    float **work_co = tav_calloc(num_frames, sizeof(float*));
    float **work_cg = tav_calloc(num_frames, sizeof(float*));
    int16_t **quant_y = tav_calloc(num_frames, sizeof(int16_t*));
    int16_t **quant_co = tav_calloc(num_frames, sizeof(int16_t*));
    int16_t **quant_cg = tav_calloc(num_frames, sizeof(int16_t*));

    for (int i = 0; i < num_frames; i++) {
        work_y[i] = tav_calloc(num_pixels, sizeof(float));
        work_co[i] = tav_calloc(num_pixels, sizeof(float));
        work_cg[i] = tav_calloc(num_pixels, sizeof(float));
        quant_y[i] = tav_calloc(num_pixels, sizeof(int16_t));
        quant_co[i] = tav_calloc(num_pixels, sizeof(int16_t));
        quant_cg[i] = tav_calloc(num_pixels, sizeof(int16_t));
    }

    // Step 1: RGB to YCoCg-R for all frames
    for (int frame = 0; frame < num_frames; frame++) {
        rgb_to_colour_space_frame(ctx, slot->rgb_frames[frame],
                                  work_y[frame], work_co[frame], work_cg[frame],
                                  width, height);
    }

    // Step 2: Apply 3D DWT (temporal + spatial)
    tav_dwt_3d_forward(work_y, width, height, num_frames,
                      ctx->decomp_levels, ctx->temporal_levels,
                      ctx->wavelet_type, ctx->temporal_wavelet);
    tav_dwt_3d_forward(work_co, width, height, num_frames,
                      ctx->decomp_levels, ctx->temporal_levels,
                      ctx->wavelet_type, ctx->temporal_wavelet);
    tav_dwt_3d_forward(work_cg, width, height, num_frames,
                      ctx->decomp_levels, ctx->temporal_levels,
                      ctx->wavelet_type, ctx->temporal_wavelet);

    // Step 3: Quantize 3D coefficients
    // ctx->quantiser_y/co/cg contain QLUT indices, lookup actual quantiser values
    int base_quantiser_y = QLUT[ctx->quantiser_y];
    int base_quantiser_co = QLUT[ctx->quantiser_co];
    int base_quantiser_cg = QLUT[ctx->quantiser_cg];

    // CRITICAL: Force perceptual quantization for GOPs to match old encoder behavior
    // The old encoder's quantise_dwt_coefficients_perceptual_per_coeff() does NOT check
    // perceptual_tuning flag - it always applies perceptual weights for GOP encoding.
    // The --no-perceptual-tuning flag only affects I-frame encoding in the old encoder.
    int saved_perceptual = ctx->compat_enc->perceptual_tuning;
    ctx->compat_enc->perceptual_tuning = 1;  // Force perceptual for GOP encoding

    if (ctx->verbose) {
        fprintf(stderr, "[DEBUG] GOP quantization: decomp_levels=%d, base_q_y=%d, perceptual=%d (forced on for GOP), preset=0x%02x\n",
                ctx->compat_enc->decomp_levels, base_quantiser_y, ctx->compat_enc->perceptual_tuning, ctx->compat_enc->encoder_preset);
    }

    tav_quantise_3d_dwt(ctx->compat_enc, work_y, quant_y, num_frames, num_pixels,
                       base_quantiser_y, 0);
    tav_quantise_3d_dwt(ctx->compat_enc, work_co, quant_co, num_frames, num_pixels,
                       base_quantiser_co, 1);
    tav_quantise_3d_dwt(ctx->compat_enc, work_cg, quant_cg, num_frames, num_pixels,
                       base_quantiser_cg, 1);

    ctx->compat_enc->perceptual_tuning = saved_perceptual;  // Restore for I-frames

    // Step 4: Unified GOP preprocessing (EZBC only)
    size_t preprocess_capacity = num_pixels * num_frames * 3 * sizeof(int16_t) + 65536;
    uint8_t *preprocess_buffer = tav_malloc(preprocess_capacity);

    size_t preprocessed_size = preprocess_gop_unified(
        PREPROCESS_EZBC, quant_y, quant_co, quant_cg,
        num_frames, num_pixels, width, height, ctx->channel_layout,
        preprocess_buffer
    );

    // Step 5: Zstd compress
    size_t compressed_bound = ZSTD_compressBound(preprocessed_size);
    uint8_t *compression_buffer = tav_malloc(compressed_bound);

    size_t compressed_size = ZSTD_compress(
        compression_buffer, compressed_bound,
        preprocess_buffer, preprocessed_size,
        ctx->zstd_level
    );

    if (ZSTD_isError(compressed_size)) {
        // Cleanup and return error
        for (int i = 0; i < num_frames; i++) {
            free(work_y[i]); free(work_co[i]); free(work_cg[i]);
            free(quant_y[i]); free(quant_co[i]); free(quant_cg[i]);
        }
        free(work_y); free(work_co); free(work_cg);
        free(quant_y); free(quant_co); free(quant_cg);
        free(preprocess_buffer);
        free(compression_buffer);
        snprintf(slot->error_message, MAX_ERROR_MESSAGE,
                 "Zstd compression failed: %s", ZSTD_getErrorName(compressed_size));
        return -1;
    }

    // Step 6: Format GOP unified packet
    // Packet format: [type(1)][gop_size(1)][size(4)][data(N)]
    size_t packet_size = 1 + 1 + 4 + compressed_size;
    tav_encoder_packet_t *pkt = calloc(1, sizeof(tav_encoder_packet_t));
    pkt->data = malloc(packet_size);
    pkt->size = packet_size;
    pkt->packet_type = TAV_PACKET_GOP_UNIFIED;
    pkt->frame_number = slot->frame_numbers[0];  // First frame in GOP
    pkt->is_video = 1;

    uint8_t *write_ptr = pkt->data;
    *write_ptr++ = TAV_PACKET_GOP_UNIFIED;
    *write_ptr++ = (uint8_t)num_frames;
    uint32_t size_field = (uint32_t)compressed_size;
    memcpy(write_ptr, &size_field, 4);
    write_ptr += 4;
    memcpy(write_ptr, compression_buffer, compressed_size);

    // Store packet in slot
    slot->packets = pkt;
    slot->num_packets = 1;

    // Cleanup
    for (int i = 0; i < num_frames; i++) {
        free(work_y[i]); free(work_co[i]); free(work_cg[i]);
        free(quant_y[i]); free(quant_co[i]); free(quant_cg[i]);
    }
    free(work_y); free(work_co); free(work_cg);
    free(quant_y); free(quant_co); free(quant_cg);
    free(preprocess_buffer);
    free(compression_buffer);

    return 0;  // Success
}
