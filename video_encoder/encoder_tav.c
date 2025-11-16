// Created by CuriousTorvald and Claude on 2025-09-13.
// TAV (TSVM Advanced Video) Encoder - DWT-based compression with full resolution YCoCg-R
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include <unistd.h>
#include <sys/wait.h>
#include <getopt.h>
#include "encoder_tad.h"  // TAD audio encoder
#include <ctype.h>
#include <sys/time.h>
#include <time.h>
#include <limits.h>
#include <float.h>

#define ENCODER_VENDOR_STRING "Encoder-TAV 20251115 (3d-dwt,tad,ssf-tc)"

// TSVM Advanced Video (TAV) format constants
#define TAV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x56"  // "\x1FTSVM TAV"
// TAV version - dynamic based on colour space and perceptual tuning
// Version 8: ICtCp multi-tile with perceptual quantisation (--ictcp flag)
// Version 7: YCoCg-R multi-tile with perceptual quantisation (default if width > 640 or height > 540)
// Version 6: ICtCp monoblock with perceptual quantisation (--ictcp flag)
// Version 5: YCoCg-R monoblock with perceptual quantisation (default if width <= 640 and height <= 540)
// Version 4: ICtCp monoblock uniform (--ictcp --no-perceptual-tuning)
// Version 3: YCoCg-R monoblock uniform (--no-perceptual-tuning)
// Version 2: ICtCp multi-tile uniform (--ictcp --no-perceptual-tuning)
// Version 1: YCoCg-R multi-tile uniform (--no-perceptual-tuning)

// === PRODUCTION TOGGLE ===
// Fine-grained optical flow: Compute flow at residual_coding_min_block_size (4×4) then merge similar MVs
// vs coarse flow: Compute flow at residual_coding_max_block_size (64×64) then split based on residual variance
// Set to 1 for fine-grained (bottom-up merge) - RECOMMENDED DEFAULT (17.3% better compression)
// Set to 0 for coarse (top-down split) - NOT RECOMMENDED (6.3% worse than I-frame baseline)
#define FINE_GRAINED_OPTICAL_FLOW 1

// Tile encoding modes
#define TAV_MODE_SKIP      0x00  // Skip tile (copy from reference)
#define TAV_MODE_INTRA     0x01  // Intra DWT coding (I-frame tiles)
#define TAV_MODE_DELTA     0x02  // Coefficient delta encoding (efficient P-frames)

// Video packet types
#define TAV_PACKET_IFRAME          0x10  // Intra frame (keyframe)
#define TAV_PACKET_PFRAME          0x11  // Predicted frame (legacy, unused)
#define TAV_PACKET_GOP_UNIFIED     0x12  // Unified 3D DWT GOP (all frames in single block, translation-based)
#define TAV_PACKET_GOP_UNIFIED_MOTION 0x13  // Unified 3D DWT GOP with motion-compensated lifting
#define TAV_PACKET_PFRAME_RESIDUAL 0x14  // P-frame with MPEG-style residual coding (block motion compensation)
#define TAV_PACKET_BFRAME_RESIDUAL 0x15  // B-frame with MPEG-style residual coding (bidirectional prediction)
#define TAV_PACKET_PFRAME_ADAPTIVE 0x16  // P-frame with adaptive quad-tree block partitioning
#define TAV_PACKET_BFRAME_ADAPTIVE 0x17  // B-frame with adaptive quad-tree block partitioning (bidirectional prediction)
#define TAV_PACKET_AUDIO_MP2       0x20  // MP2 audio
#define TAV_PACKET_AUDIO_PCM8      0x21  // 8-bit PCM audio (zstd compressed)
#define TAV_PACKET_AUDIO_TAD       0x24  // TAD audio (DWT-based perceptual codec)
#define TAV_PACKET_SUBTITLE_TC     0x31  // Subtitle packet with timecode (SSF-TC format)
#define TAV_PACKET_AUDIO_TRACK     0x40  // Separate audio track (full MP2 file)
#define TAV_PACKET_EXTENDED_HDR    0xEF  // Extended header packet
#define TAV_PACKET_SCREEN_MASK     0xF2  // Screen masking packet (letterbox/pillarbox)
#define TAV_PACKET_GOP_SYNC        0xFC  // GOP sync packet (N frames decoded)
#define TAV_PACKET_TIMECODE        0xFD  // Timecode packet
#define TAV_PACKET_SYNC_NTSC       0xFE  // NTSC Sync packet
#define TAV_PACKET_SYNC            0xFF  // Sync packet

// TAD (Terrarum Advanced Audio) settings
// TAD32 constants (updated to match Float32 version)
#define TAD32_MIN_CHUNK_SIZE 1024       // Minimum: 1024 samples
#define TAD32_QUALITY_MIN 0
#define TAD32_QUALITY_MAX 5

// DWT settings
#define TILE_SIZE_X 640
#define TILE_SIZE_Y 540

// Simulated overlapping tiles settings for seamless DWT processing
#define DWT_FILTER_HALF_SUPPORT 4  // For 9/7 filter (filter lengths 9,7 → L=4)
#define TILE_MARGIN_LEVELS 3       // Use margin for 3 levels: 4 * (2^3) = 4 * 8 = 32px
#define TILE_MARGIN (DWT_FILTER_HALF_SUPPORT * (1 << TILE_MARGIN_LEVELS))  // 4 * 8 = 32px
#define PADDED_TILE_SIZE_X (TILE_SIZE_X + 2 * TILE_MARGIN)
#define PADDED_TILE_SIZE_Y (TILE_SIZE_Y + 2 * TILE_MARGIN)

// Wavelet filter types
#define WAVELET_5_3_REVERSIBLE 0  // Lossless capable
#define WAVELET_9_7_IRREVERSIBLE 1  // Higher compression
#define WAVELET_BIORTHOGONAL_13_7 2  // Biorthogonal 13/7 wavelet
#define WAVELET_DD4 16  // Four-point interpolating Deslauriers-Dubuc (DD-4)
#define WAVELET_HAAR 255  // Haar wavelet (simplest wavelet transform)

// Channel layout definitions (bit-field design)
// Bit 0: has alpha, Bit 1: has chroma (inverted), Bit 2: has luma (inverted)
#define CHANNEL_LAYOUT_YCOCG     0  // Y-Co-Cg/I-Ct-Cp (000: no alpha, has chroma, has luma)
#define CHANNEL_LAYOUT_YCOCG_A   1  // Y-Co-Cg-A/I-Ct-Cp-A (001: has alpha, has chroma, has luma)
#define CHANNEL_LAYOUT_Y_ONLY    2  // Y/I only (010: no alpha, no chroma, has luma)
#define CHANNEL_LAYOUT_Y_A       3  // Y-A/I-A (011: has alpha, no chroma, has luma)
#define CHANNEL_LAYOUT_COCG      4  // Co-Cg/Ct-Cp (100: no alpha, has chroma, no luma)
#define CHANNEL_LAYOUT_COCG_A    5  // Co-Cg-A/Ct-Cp-A (101: has alpha, has chroma, no luma)

// Channel layout configuration structure
typedef struct {
    int layout_id;
    int num_channels;
    const char* channels[4];  // channel names for display
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

// Helper function to check if alpha channel is needed for given channel layout
static int needs_alpha_channel(int channel_layout) {
    if (channel_layout < 0 || channel_layout >= 6) return 0;
    return channel_layouts[channel_layout].has_alpha;
}

// Coefficient preprocessing modes
typedef enum {
    PREPROCESS_TWOBITMAP = 0,  // Twobit-plane significance map (default, best compression)
    PREPROCESS_EZBC = 1,       // EZBC embedded zero block coding
    PREPROCESS_RAW = 2         // No preprocessing - raw coefficients
} preprocess_mode_t;

// Default settings
#define DEFAULT_WIDTH 560
#define DEFAULT_HEIGHT 448
#define DEFAULT_FPS 30
#define DEFAULT_QUALITY 3
#define DEFAULT_ZSTD_LEVEL 15
#define DEFAULT_PCM_ZSTD_LEVEL 3
#define TEMPORAL_GOP_SIZE 24
#define TEMPORAL_GOP_SIZE_MIN 10 // Minimum GOP size to avoid decoder hiccups
#define TEMPORAL_DECOMP_LEVEL 2  // 3 levels make too much afterimages and nonmoving pixels

// Single-pass scene change detection constants
#define SCENE_CHANGE_THRESHOLD_SOFT 0.72
#define SCENE_CHANGE_THRESHOLD_HARD 0.90
#define MOTION_THRESHOLD 24.0f // Flush if motion exceeds 24 pixels in any direction

// Two-pass scene change detection constants
#define ANALYSIS_SUBSAMPLE_FACTOR 4  // Subsample to 1/4 resolution for speed
#define ANALYSIS_DWT_LEVELS 3        // 3-level Haar DWT for analysis
#define ANALYSIS_MOVING_WINDOW 30    // Moving average window (30 frames = ~1 second)
#define ANALYSIS_STDDEV_MULTIPLIER 2.0  // Standard deviation multiplier for adaptive threshold (balanced sensitivity)
#define ANALYSIS_LL_DIFF_MIN_THRESHOLD 2.0  // Minimum absolute threshold for LL_diff (avoid false positives)
#define ANALYSIS_HB_RATIO_THRESHOLD 0.70  // Highband energy ratio threshold (balanced for scene cuts)
#define ANALYSIS_HB_ENERGY_MULTIPLIER 2.5  // Energy spike multiplier (2.5× mean to trigger)
#define ANALYSIS_FADE_THRESHOLD 50.0  // Brightness change threshold over 5 frames
#define ANALYSIS_GOP_MIN_SIZE 10      // Minimum GOP size for two-pass mode. Keep it same as default settings.
#define ANALYSIS_GOP_MAX_SIZE 24     // Maximum GOP size for two-pass mode. Keep it same as default settings.

// Audio/subtitle constants (reused from TEV)
#define TSVM_AUDIO_SAMPLE_RATE 32000
#define MP2_DEFAULT_PACKET_SIZE 1152
#define PACKET_AUDIO_TIME ((double)MP2_DEFAULT_PACKET_SIZE / TSVM_AUDIO_SAMPLE_RATE)
#define MAX_SUBTITLE_LENGTH 2048

int debugDumpMade = 0;
int debugDumpFrameTarget = -1;  // -1 means disabled

// Subtitle structure
typedef struct subtitle_entry {
    int start_frame;
    int end_frame;
    uint64_t start_time_ns;  // Direct timestamp in nanoseconds (for SSF-TC)
    uint64_t end_time_ns;    // Direct timestamp in nanoseconds (for SSF-TC)
    char *text;
    struct subtitle_entry *next;
} subtitle_entry_t;

// Frame analysis metrics for two-pass scene change detection
typedef struct frame_analysis {
    int frame_number;

    // Wavelet-based metrics (3-level Haar on subsampled frame)
    double ll_diff;              // L1 distance between consecutive LL bands
    double ll_mean;              // Mean brightness (LL band average)
    double ll_variance;          // Contrast estimate (LL band variance)

    double highband_energy;      // Sum of absolute values in LH/HL/HH bands
    double total_energy;         // Total energy (all bands)
    double highband_ratio;       // highband_energy / total_energy

    // Per-band entropies (Shannon entropy of coefficient magnitudes)
    double entropy_ll;
    double entropy_lh[ANALYSIS_DWT_LEVELS];
    double entropy_hl[ANALYSIS_DWT_LEVELS];
    double entropy_hh[ANALYSIS_DWT_LEVELS];

    // Texture change indicators
    double zero_crossing_rate;   // Zero crossing rate in highbands

    // Detection results
    int is_scene_change;         // Final scene change flag
    double scene_change_score;   // Composite score for debugging

    // Letterbox/pillarbox detection
    uint16_t letterbox_top;
    uint16_t letterbox_right;
    uint16_t letterbox_bottom;
    uint16_t letterbox_left;
    int has_letterbox;           // 1 if any masking detected
} frame_analysis_t;

// GOP boundary list for two-pass encoding
typedef struct gop_boundary {
    int start_frame;
    int end_frame;
    int num_frames;
    struct gop_boundary *next;
} gop_boundary_t;

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
char TEMP_PCM_FILE[42];

// Utility macros
static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}
static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

// ===========================
// Adaptive Block Partitioning
// ===========================

// Quad-tree node for adaptive block partitioning
typedef struct quad_tree_node {
    int x, y;                    // Top-left corner of block
    int size;                    // Block size (64, 32, 16, 8, or 4)
    int is_split;                // 1 if block is split into 4 children, 0 if leaf
    int is_skip;                 // 1 if skip block (for leaf nodes only)

    // Motion vectors for P-frames (single direction)
    int16_t mv_x, mv_y;          // Motion vector in 1/4-pixel units (for leaf nodes)

    // Motion vectors for B-frames (bidirectional)
    int16_t fwd_mv_x, fwd_mv_y;  // Forward motion vector (previous reference)
    int16_t bwd_mv_x, bwd_mv_y;  // Backward motion vector (next reference)
    struct quad_tree_node *children[4];  // NW, NE, SW, SE children (NULL if leaf)
} quad_tree_node_t;

// ====================================================================================
// EZBC (Embedded Zero Block Coding) Structures and Functions
// ====================================================================================

// Bitstream writer for EZBC
typedef struct {
    uint8_t *data;
    size_t capacity;
    size_t byte_pos;
    uint8_t bit_pos;  // 0-7, current bit position in current byte
} bitstream_t;

// Block structure for EZBC quadtree
typedef struct {
    int x, y;           // Top-left position in 2D coefficient array
    int width, height;  // Block dimensions
} ezbc_block_t;

// Queue for EZBC block processing
typedef struct {
    ezbc_block_t *blocks;
    size_t count;
    size_t capacity;
} block_queue_t;

// Track coefficient state for refinement
typedef struct {
    bool significant;     // Has been marked significant
    int first_bitplane;   // Bitplane where it became significant
} coeff_state_t;

// Bitstream operations
static void bitstream_init(bitstream_t *bs, size_t initial_capacity) {
    bs->capacity = initial_capacity;
    bs->data = calloc(1, initial_capacity);
    bs->byte_pos = 0;
    bs->bit_pos = 0;
}

static void bitstream_write_bit(bitstream_t *bs, int bit) {
    // Grow if needed
    if (bs->byte_pos >= bs->capacity) {
        bs->capacity *= 2;
        bs->data = realloc(bs->data, bs->capacity);
        // Clear new memory
        memset(bs->data + bs->byte_pos, 0, bs->capacity - bs->byte_pos);
    }

    if (bit) {
        bs->data[bs->byte_pos] |= (1 << bs->bit_pos);
    }

    bs->bit_pos++;
    if (bs->bit_pos == 8) {
        bs->bit_pos = 0;
        bs->byte_pos++;
    }
}

static void bitstream_write_bits(bitstream_t *bs, uint32_t value, int num_bits) {
    for (int i = 0; i < num_bits; i++) {
        bitstream_write_bit(bs, (value >> i) & 1);
    }
}

static size_t bitstream_size(bitstream_t *bs) {
    return bs->byte_pos + (bs->bit_pos > 0 ? 1 : 0);
}

static void bitstream_free(bitstream_t *bs) {
    free(bs->data);
}

// Block queue operations
static void queue_init(block_queue_t *q) {
    q->capacity = 1024;
    q->blocks = malloc(q->capacity * sizeof(ezbc_block_t));
    q->count = 0;
}

static void queue_push(block_queue_t *q, ezbc_block_t block) {
    if (q->count >= q->capacity) {
        q->capacity *= 2;
        q->blocks = realloc(q->blocks, q->capacity * sizeof(ezbc_block_t));
    }
    q->blocks[q->count++] = block;
}

static void queue_free(block_queue_t *q) {
    free(q->blocks);
}

// Check if all coefficients in block have |coeff| < threshold
static bool is_zero_block_ezbc(int16_t *coeffs, int width, int height,
                                const ezbc_block_t *block, int threshold) {
    for (int y = block->y; y < block->y + block->height && y < height; y++) {
        for (int x = block->x; x < block->x + block->width && x < width; x++) {
            int idx = y * width + x;
            if (abs(coeffs[idx]) >= threshold) {
                return false;
            }
        }
    }
    return true;
}

// Find maximum absolute coefficient value for determining MSB
static int find_max_abs_ezbc(int16_t *coeffs, size_t count) {
    int max_abs = 0;
    for (size_t i = 0; i < count; i++) {
        int abs_val = abs(coeffs[i]);
        if (abs_val > max_abs) {
            max_abs = abs_val;
        }
    }
    return max_abs;
}

// Get MSB position (bitplane number)
// Returns floor(log2(value)), i.e., the position of the highest set bit
static int get_msb_bitplane(int value) {
    if (value == 0) return 0;
    int bitplane = 0;
    while (value > 1) {
        value >>= 1;
        bitplane++;
    }
    return bitplane;
}

// Forward declarations for recursive EZBC
typedef struct {
    bitstream_t *bs;
    int16_t *coeffs;
    coeff_state_t *states;
    int width;
    int height;
    int bitplane;
    int threshold;
    block_queue_t *next_insignificant;
    block_queue_t *next_significant;
    int *sign_count;
} ezbc_context_t;

// Recursively process a significant block - subdivide until 1x1
static void process_significant_block_recursive(ezbc_context_t *ctx, ezbc_block_t block) {
    // If 1x1 block: emit sign bit and add to significant queue
    if (block.width == 1 && block.height == 1) {
        int idx = block.y * ctx->width + block.x;
        bitstream_write_bit(ctx->bs, ctx->coeffs[idx] < 0 ? 1 : 0);
        (*ctx->sign_count)++;
        ctx->states[idx].significant = true;
        ctx->states[idx].first_bitplane = ctx->bitplane;
        queue_push(ctx->next_significant, block);
        return;
    }

    // Block is > 1x1: subdivide into children and recursively process each
    int mid_x = block.width / 2;
    int mid_y = block.height / 2;
    if (mid_x == 0) mid_x = 1;
    if (mid_y == 0) mid_y = 1;

    // Process top-left child
    ezbc_block_t tl = {block.x, block.y, mid_x, mid_y};
    if (!is_zero_block_ezbc(ctx->coeffs, ctx->width, ctx->height, &tl, ctx->threshold)) {
        bitstream_write_bit(ctx->bs, 1);  // Significant
        process_significant_block_recursive(ctx, tl);
    } else {
        bitstream_write_bit(ctx->bs, 0);  // Insignificant
        queue_push(ctx->next_insignificant, tl);
    }

    // Process top-right child (if exists)
    if (block.width > mid_x) {
        ezbc_block_t tr = {block.x + mid_x, block.y, block.width - mid_x, mid_y};
        if (!is_zero_block_ezbc(ctx->coeffs, ctx->width, ctx->height, &tr, ctx->threshold)) {
            bitstream_write_bit(ctx->bs, 1);
            process_significant_block_recursive(ctx, tr);
        } else {
            bitstream_write_bit(ctx->bs, 0);
            queue_push(ctx->next_insignificant, tr);
        }
    }

    // Process bottom-left child (if exists)
    if (block.height > mid_y) {
        ezbc_block_t bl = {block.x, block.y + mid_y, mid_x, block.height - mid_y};
        if (!is_zero_block_ezbc(ctx->coeffs, ctx->width, ctx->height, &bl, ctx->threshold)) {
            bitstream_write_bit(ctx->bs, 1);
            process_significant_block_recursive(ctx, bl);
        } else {
            bitstream_write_bit(ctx->bs, 0);
            queue_push(ctx->next_insignificant, bl);
        }
    }

    // Process bottom-right child (if exists)
    if (block.width > mid_x && block.height > mid_y) {
        ezbc_block_t br = {block.x + mid_x, block.y + mid_y, block.width - mid_x, block.height - mid_y};
        if (!is_zero_block_ezbc(ctx->coeffs, ctx->width, ctx->height, &br, ctx->threshold)) {
            bitstream_write_bit(ctx->bs, 1);
            process_significant_block_recursive(ctx, br);
        } else {
            bitstream_write_bit(ctx->bs, 0);
            queue_push(ctx->next_insignificant, br);
        }
    }
}

// EZBC encoding for a single channel (Fixed version from significance_map_granularity_test.c)
// Uses two separate queues for insignificant blocks and significant 1x1 blocks
// Returns encoded size and allocates output buffer
static size_t encode_channel_ezbc(int16_t *coeffs, size_t count, int width, int height,
                                   uint8_t **output) {
    bitstream_t bs;
    bitstream_init(&bs, count / 4);  // Initial guess

    // Track coefficient significance
    coeff_state_t *states = calloc(count, sizeof(coeff_state_t));

    // Find maximum value to determine MSB bitplane
    int max_abs = find_max_abs_ezbc(coeffs, count);
    int msb_bitplane = get_msb_bitplane(max_abs);

    // Write header: MSB bitplane and dimensions
    bitstream_write_bits(&bs, msb_bitplane, 8);
    bitstream_write_bits(&bs, width, 16);
    bitstream_write_bits(&bs, height, 16);

    if (0) {
        fprintf(stderr, "[EZBC-ENC] Encoding: max_abs=%d, msb_bitplane=%d, dims=%dx%d, count=%zu\n",
                max_abs, msb_bitplane, width, height, count);
        fprintf(stderr, "[EZBC-ENC] Header bytes: MSB=0x%02X, W=%d (0x%04X), H=%d (0x%04X)\n",
                msb_bitplane, width, width, height, height);
        fprintf(stderr, "[EZBC-ENC] First 9 bytes of bitstream: %02X %02X %02X %02X %02X %02X %02X %02X %02X\n",
                bs.data[0], bs.data[1], bs.data[2], bs.data[3], bs.data[4],
                bs.data[5], bs.data[6], bs.data[7], bs.data[8]);
    }

    // Initialise two queues: insignificant blocks and significant 1x1 blocks
    block_queue_t insignificant_queue, next_insignificant;
    block_queue_t significant_queue, next_significant;

    queue_init(&insignificant_queue);
    queue_init(&next_insignificant);
    queue_init(&significant_queue);
    queue_init(&next_significant);

    // Start with root block as insignificant
    ezbc_block_t root = {0, 0, width, height};
    queue_push(&insignificant_queue, root);

    // Process bitplanes from MSB to LSB
    int bitplanes_processed = 0;
    int total_flags_written = 0;
    int total_ones_written = 0;
    int total_sign_bits_written = 0;
    int total_refinement_bits_written = 0;
    for (int bitplane = msb_bitplane; bitplane >= 0; bitplane--) {
        int threshold = 1 << bitplane;
        bitplanes_processed++;

        size_t insignif_before = insignificant_queue.count;
        size_t signif_before = significant_queue.count;

        int flags_this_bitplane = 0;
        int ones_this_bitplane = 0;
        int sign_bits_this_bitplane = 0;
        int refinement_bits_this_bitplane = 0;

        // Process insignificant blocks - check if they become significant
        for (size_t i = 0; i < insignificant_queue.count; i++) {
            ezbc_block_t block = insignificant_queue.blocks[i];

            // Check if this block has any coefficient >= threshold
            if (is_zero_block_ezbc(coeffs, width, height, &block, threshold)) {
                // Still insignificant: emit 0
                bitstream_write_bit(&bs, 0);
                flags_this_bitplane++;
                // Keep in insignificant queue for next bitplane
                queue_push(&next_insignificant, block);
            } else {
                // Became significant: emit 1
                bitstream_write_bit(&bs, 1);
                flags_this_bitplane++;
                ones_this_bitplane++;
                total_ones_written++;

                // Use recursive subdivision to process this block and all children
                ezbc_context_t ctx = {
                    .bs = &bs,
                    .coeffs = coeffs,
                    .states = states,
                    .width = width,
                    .height = height,
                    .bitplane = bitplane,
                    .threshold = threshold,
                    .next_insignificant = &next_insignificant,
                    .next_significant = &next_significant,
                    .sign_count = &sign_bits_this_bitplane
                };
                process_significant_block_recursive(&ctx, block);
            }
        }

        // Process significant 1x1 blocks - emit refinement bits
        for (size_t i = 0; i < significant_queue.count; i++) {
            ezbc_block_t block = significant_queue.blocks[i];
            int idx = block.y * width + block.x;
            int abs_val = abs(coeffs[idx]);

            // Emit refinement bit at current bitplane
            int bit = (abs_val >> bitplane) & 1;
            bitstream_write_bit(&bs, bit);
            refinement_bits_this_bitplane++;
            total_refinement_bits_written++;

            // Keep in significant queue for next bitplane
            queue_push(&next_significant, block);
        }

        // Swap queues for next bitplane
        queue_free(&insignificant_queue);
        queue_free(&significant_queue);
        insignificant_queue = next_insignificant;
        significant_queue = next_significant;
        queue_init(&next_insignificant);
        queue_init(&next_significant);

        total_flags_written += flags_this_bitplane;
        total_sign_bits_written += sign_bits_this_bitplane;
        total_refinement_bits_written += refinement_bits_this_bitplane;

        if (0 && (bitplane == msb_bitplane || bitplane == 0 || bitplane % 3 == 0)) {
            fprintf(stderr, "[EZBC-BP] Bitplane %2d: threshold=%4d, flags=%d (ones=%d), sign=%d, refine=%d, insignif=%zu->%zu, signif=%zu->%zu\n",
                    bitplane, threshold, flags_this_bitplane, ones_this_bitplane,
                    sign_bits_this_bitplane, refinement_bits_this_bitplane,
                    insignif_before, insignificant_queue.count,
                    signif_before, significant_queue.count);
        }
    }

    if (0) {
        fprintf(stderr, "[EZBC-ENC] Processed %d bitplanes, wrote %d flags (%d ones), %d sign bits, %d refinement bits\n",
                bitplanes_processed, total_flags_written, total_ones_written,
                total_sign_bits_written, total_refinement_bits_written);
    }

    queue_free(&insignificant_queue);
    queue_free(&significant_queue);
    free(states);

    size_t final_size = bitstream_size(&bs);
    *output = bs.data;

    if (0) {
        fprintf(stderr, "[EZBC-ENC] Completed: final_size=%zu bytes (%.1f bits/coeff)\n",
                final_size, (final_size * 8.0) / count);
    }

    return final_size;
}

// ====================================================================================
// End of EZBC Implementation
// ====================================================================================

// Partitioning decision based on residual variance
static float compute_block_variance(const float *residual, int width, int x, int y, int block_size) {
    double sum = 0.0;
    double sum_sq = 0.0;
    int count = 0;

    for (int by = 0; by < block_size; by++) {
        for (int bx = 0; bx < block_size; bx++) {
            int px = x + bx;
            int py = y + by;
            if (px >= width) continue;  // Safety check

            float val = residual[py * width + px];
            sum += val;
            sum_sq += val * val;
            count++;
        }
    }

    if (count == 0) return 0.0f;

    double mean = sum / count;
    double variance = (sum_sq / count) - (mean * mean);
    return (float)variance;
}

// Refine motion vector for a specific block using hierarchical search
// parent_mv is in 1/4-pixel units, search_range is in pixels
static void refine_motion_vector(
    const float *current_y,
    const float *reference_y,
    int width, int height,
    int block_x, int block_y, int block_size,
    int16_t parent_mv_x, int16_t parent_mv_y,
    int search_range,
    int16_t *out_mv_x, int16_t *out_mv_y
) {
    // Convert parent MV from 1/4-pixel to full-pixel for integer search
    int parent_pixel_x = parent_mv_x / 4;
    int parent_pixel_y = parent_mv_y / 4;

    float best_sad = 1e30f;
    int best_dx = 0;
    int best_dy = 0;

    // Integer-pixel search around parent motion vector
    for (int dy = -search_range; dy <= search_range; dy++) {
        for (int dx = -search_range; dx <= search_range; dx++) {
            int ref_x = parent_pixel_x + dx;
            int ref_y = parent_pixel_y + dy;

            // Compute SAD for this motion vector
            float sad = 0.0f;
            int valid_pixels = 0;

            for (int by = 0; by < block_size; by++) {
                for (int bx = 0; bx < block_size; bx++) {
                    int cur_px = block_x + bx;
                    int cur_py = block_y + by;
                    int ref_px = cur_px + ref_x;
                    int ref_py = cur_py + ref_y;

                    // Bounds check
                    if (cur_px >= width || cur_py >= height) continue;
                    if (ref_px < 0 || ref_px >= width || ref_py < 0 || ref_py >= height) continue;

                    float cur_val = current_y[cur_py * width + cur_px];
                    float ref_val = reference_y[ref_py * width + ref_px];
                    sad += fabsf(cur_val - ref_val);
                    valid_pixels++;
                }
            }

            if (valid_pixels > 0) {
                sad /= valid_pixels;  // Normalise by valid pixels
            }

            if (sad < best_sad) {
                best_sad = sad;
                best_dx = dx;
                best_dy = dy;
            }
        }
    }

    // Sub-pixel refinement (1/4-pixel precision)
    // Search ±1 pixel around best integer position in 1/4-pixel steps
    int best_pixel_x = parent_pixel_x + best_dx;
    int best_pixel_y = parent_pixel_y + best_dy;

    best_sad = 1e30f;
    int best_subpel_x = 0;
    int best_subpel_y = 0;

    for (int sub_dy = -4; sub_dy <= 4; sub_dy++) {
        for (int sub_dx = -4; sub_dx <= 4; sub_dx++) {
            float mv_x_pixels = best_pixel_x + sub_dx / 4.0f;
            float mv_y_pixels = best_pixel_y + sub_dy / 4.0f;

            // Compute SAD with bilinear interpolation
            float sad = 0.0f;
            int valid_pixels = 0;

            for (int by = 0; by < block_size; by++) {
                for (int bx = 0; bx < block_size; bx++) {
                    int cur_px = block_x + bx;
                    int cur_py = block_y + by;
                    float ref_px_f = cur_px + mv_x_pixels;
                    float ref_py_f = cur_py + mv_y_pixels;

                    int ref_px = (int)ref_px_f;
                    int ref_py = (int)ref_py_f;
                    float fx = ref_px_f - ref_px;
                    float fy = ref_py_f - ref_py;

                    // Bounds check
                    if (cur_px >= width || cur_py >= height) continue;
                    if (ref_px < 0 || ref_px + 1 >= width || ref_py < 0 || ref_py + 1 >= height) continue;

                    // Bilinear interpolation
                    float v00 = reference_y[ref_py * width + ref_px];
                    float v10 = reference_y[ref_py * width + (ref_px + 1)];
                    float v01 = reference_y[(ref_py + 1) * width + ref_px];
                    float v11 = reference_y[(ref_py + 1) * width + (ref_px + 1)];

                    float v0 = v00 * (1.0f - fx) + v10 * fx;
                    float v1 = v01 * (1.0f - fx) + v11 * fx;
                    float ref_val = v0 * (1.0f - fy) + v1 * fy;

                    float cur_val = current_y[cur_py * width + cur_px];
                    sad += fabsf(cur_val - ref_val);
                    valid_pixels++;
                }
            }

            if (valid_pixels > 0) {
                sad /= valid_pixels;
            }

            if (sad < best_sad) {
                best_sad = sad;
                best_subpel_x = sub_dx;
                best_subpel_y = sub_dy;
            }
        }
    }

    // Output refined motion vector in 1/4-pixel units
    *out_mv_x = (best_pixel_x * 4) + best_subpel_x;
    *out_mv_y = (best_pixel_y * 4) + best_subpel_y;
}

// Build quad-tree bottom-up from fine-grained motion vectors (4×4)
// Merges blocks with similar MVs into larger blocks
static quad_tree_node_t* build_quad_tree_bottom_up(
    const int16_t *fine_mv_x,
    const int16_t *fine_mv_y,
    const float *residual_y,
    const float *residual_co,
    const float *residual_cg,
    int width, int height,
    int x, int y, int size,
    int min_size, int max_size,
    int fine_blocks_x
) {
    quad_tree_node_t *node = (quad_tree_node_t*)malloc(sizeof(quad_tree_node_t));
    node->x = x;
    node->y = y;
    node->size = size;
    node->is_split = 0;
    node->is_skip = 0;
    for (int i = 0; i < 4; i++) node->children[i] = NULL;

    // Base case: at minimum size, create leaf with MV from fine grid
    if (size == min_size) {
        int block_x = x / min_size;
        int block_y = y / min_size;
        int idx = block_y * fine_blocks_x + block_x;

        node->mv_x = fine_mv_x[idx];
        node->mv_y = fine_mv_y[idx];

        // Check if skip block (small motion + low energy)
        float mv_mag = sqrtf((node->mv_x * node->mv_x + node->mv_y * node->mv_y) / 16.0f);
        float energy = 0.0f;
        for (int by = 0; by < min_size && y + by < height; by++) {
            for (int bx = 0; bx < min_size && x + bx < width; bx++) {
                int px = x + bx;
                int py = y + by;
                if (px >= width || py >= height) continue;
                float r_y = residual_y[py * width + px];
                float r_co = residual_co[py * width + px];
                float r_cg = residual_cg[py * width + px];
                energy += r_y * r_y + r_co * r_co + r_cg * r_cg;
            }
        }
        node->is_skip = (mv_mag < 0.5f && energy < 50.0f);

        return node;
    }

    // Don't merge beyond max size
    if (size >= max_size) {
        // At max size, compute average MV from fine grid
        int blocks_in_region = size / min_size;
        int total_blocks = blocks_in_region * blocks_in_region;
        int32_t sum_mv_x = 0, sum_mv_y = 0;

        for (int by = 0; by < blocks_in_region; by++) {
            for (int bx = 0; bx < blocks_in_region; bx++) {
                int block_x = (x / min_size) + bx;
                int block_y = (y / min_size) + by;
                int idx = block_y * fine_blocks_x + block_x;
                sum_mv_x += fine_mv_x[idx];
                sum_mv_y += fine_mv_y[idx];
            }
        }

        node->mv_x = sum_mv_x / total_blocks;
        node->mv_y = sum_mv_y / total_blocks;
        return node;
    }

    // Recursive case: try to build children at half size
    int child_size = size / 2;
    quad_tree_node_t *children[4];

    children[0] = build_quad_tree_bottom_up(fine_mv_x, fine_mv_y, residual_y, residual_co, residual_cg,
                                            width, height, x, y, child_size, min_size, max_size, fine_blocks_x);
    children[1] = build_quad_tree_bottom_up(fine_mv_x, fine_mv_y, residual_y, residual_co, residual_cg,
                                            width, height, x + child_size, y, child_size, min_size, max_size, fine_blocks_x);
    children[2] = build_quad_tree_bottom_up(fine_mv_x, fine_mv_y, residual_y, residual_co, residual_cg,
                                            width, height, x, y + child_size, child_size, min_size, max_size, fine_blocks_x);
    children[3] = build_quad_tree_bottom_up(fine_mv_x, fine_mv_y, residual_y, residual_co, residual_cg,
                                            width, height, x + child_size, y + child_size, child_size, min_size, max_size, fine_blocks_x);

    // Check if all children can be merged (similar MVs and all are leaves)
    int can_merge = 1;

    // All children must be leaves (not already split)
    for (int i = 0; i < 4; i++) {
        if (children[i]->is_split) {
            can_merge = 0;
            break;
        }
    }

    if (can_merge) {
        // Check MV similarity: max difference threshold (in 1/4-pixel units)
        // Threshold: 4 = 1 pixel, 8 = 2 pixels, etc.
        int mv_threshold = 8;  // 2 pixels

        int16_t min_mv_x = children[0]->mv_x, max_mv_x = children[0]->mv_x;
        int16_t min_mv_y = children[0]->mv_y, max_mv_y = children[0]->mv_y;

        for (int i = 1; i < 4; i++) {
            if (children[i]->mv_x < min_mv_x) min_mv_x = children[i]->mv_x;
            if (children[i]->mv_x > max_mv_x) max_mv_x = children[i]->mv_x;
            if (children[i]->mv_y < min_mv_y) min_mv_y = children[i]->mv_y;
            if (children[i]->mv_y > max_mv_y) max_mv_y = children[i]->mv_y;
        }

        int mv_range_x = max_mv_x - min_mv_x;
        int mv_range_y = max_mv_y - min_mv_y;

        if (mv_range_x > mv_threshold || mv_range_y > mv_threshold) {
            can_merge = 0;
        }
    }

    if (can_merge) {
        // Merge: average the MVs from children
        int32_t sum_mv_x = 0, sum_mv_y = 0;
        for (int i = 0; i < 4; i++) {
            sum_mv_x += children[i]->mv_x;
            sum_mv_y += children[i]->mv_y;
        }
        node->mv_x = sum_mv_x / 4;
        node->mv_y = sum_mv_y / 4;

        // Free children since we're merging
        for (int i = 0; i < 4; i++) {
            free(children[i]);
        }

        return node;  // Merged leaf node
    } else {
        // Can't merge: keep as split node
        node->is_split = 1;
        for (int i = 0; i < 4; i++) {
            node->children[i] = children[i];
        }

        // Compute average MV for this internal node (for reference)
        int32_t sum_mv_x = 0, sum_mv_y = 0;
        for (int i = 0; i < 4; i++) {
            sum_mv_x += children[i]->mv_x;
            sum_mv_y += children[i]->mv_y;
        }
        node->mv_x = sum_mv_x / 4;
        node->mv_y = sum_mv_y / 4;

        return node;
    }
}

// Build quad-tree bottom-up from fine-grained bidirectional motion vectors (for B-frames)
// Merges blocks with similar forward AND backward MVs into larger blocks
static quad_tree_node_t* build_quad_tree_bottom_up_bidirectional(
    const int16_t *fine_fwd_mv_x,
    const int16_t *fine_fwd_mv_y,
    const int16_t *fine_bwd_mv_x,
    const int16_t *fine_bwd_mv_y,
    const float *residual_y,
    const float *residual_co,
    const float *residual_cg,
    int width, int height,
    int x, int y, int size,
    int min_size, int max_size,
    int fine_blocks_x
) {
    quad_tree_node_t *node = (quad_tree_node_t*)malloc(sizeof(quad_tree_node_t));
    node->x = x;
    node->y = y;
    node->size = size;
    node->is_split = 0;
    node->is_skip = 0;
    for (int i = 0; i < 4; i++) node->children[i] = NULL;

    // Base case: at minimum size, create leaf with MVs from fine grid
    if (size == min_size) {
        int block_x = x / min_size;
        int block_y = y / min_size;
        int idx = block_y * fine_blocks_x + block_x;

        // Store both forward and backward MVs
        node->fwd_mv_x = fine_fwd_mv_x[idx];
        node->fwd_mv_y = fine_fwd_mv_y[idx];
        node->bwd_mv_x = fine_bwd_mv_x[idx];
        node->bwd_mv_y = fine_bwd_mv_y[idx];

        // Check if skip block (small motion in BOTH directions + low energy)
        float fwd_mv_mag = sqrtf((node->fwd_mv_x * node->fwd_mv_x + node->fwd_mv_y * node->fwd_mv_y) / 16.0f);
        float bwd_mv_mag = sqrtf((node->bwd_mv_x * node->bwd_mv_x + node->bwd_mv_y * node->bwd_mv_y) / 16.0f);
        float energy = 0.0f;
        for (int by = 0; by < min_size && y + by < height; by++) {
            for (int bx = 0; bx < min_size && x + bx < width; bx++) {
                int px = x + bx;
                int py = y + by;
                if (px >= width || py >= height) continue;
                float r_y = residual_y[py * width + px];
                float r_co = residual_co[py * width + px];
                float r_cg = residual_cg[py * width + px];
                energy += r_y * r_y + r_co * r_co + r_cg * r_cg;
            }
        }
        // More aggressive skip detection for B-frames (dual predictions are more accurate)
        node->is_skip = (fwd_mv_mag < 0.5f && bwd_mv_mag < 0.5f && energy < 40.0f);

        return node;
    }

    // Don't merge beyond max size
    if (size >= max_size) {
        // At max size, compute average MVs from fine grid
        int blocks_in_region = size / min_size;
        int total_blocks = blocks_in_region * blocks_in_region;
        int32_t sum_fwd_mv_x = 0, sum_fwd_mv_y = 0;
        int32_t sum_bwd_mv_x = 0, sum_bwd_mv_y = 0;

        for (int by = 0; by < blocks_in_region; by++) {
            for (int bx = 0; bx < blocks_in_region; bx++) {
                int block_x = (x / min_size) + bx;
                int block_y = (y / min_size) + by;
                int idx = block_y * fine_blocks_x + block_x;
                sum_fwd_mv_x += fine_fwd_mv_x[idx];
                sum_fwd_mv_y += fine_fwd_mv_y[idx];
                sum_bwd_mv_x += fine_bwd_mv_x[idx];
                sum_bwd_mv_y += fine_bwd_mv_y[idx];
            }
        }

        node->fwd_mv_x = sum_fwd_mv_x / total_blocks;
        node->fwd_mv_y = sum_fwd_mv_y / total_blocks;
        node->bwd_mv_x = sum_bwd_mv_x / total_blocks;
        node->bwd_mv_y = sum_bwd_mv_y / total_blocks;
        return node;
    }

    // Recursive case: try to build children at half size
    int child_size = size / 2;
    quad_tree_node_t *children[4];

    children[0] = build_quad_tree_bottom_up_bidirectional(
        fine_fwd_mv_x, fine_fwd_mv_y, fine_bwd_mv_x, fine_bwd_mv_y,
        residual_y, residual_co, residual_cg,
        width, height, x, y, child_size, min_size, max_size, fine_blocks_x);
    children[1] = build_quad_tree_bottom_up_bidirectional(
        fine_fwd_mv_x, fine_fwd_mv_y, fine_bwd_mv_x, fine_bwd_mv_y,
        residual_y, residual_co, residual_cg,
        width, height, x + child_size, y, child_size, min_size, max_size, fine_blocks_x);
    children[2] = build_quad_tree_bottom_up_bidirectional(
        fine_fwd_mv_x, fine_fwd_mv_y, fine_bwd_mv_x, fine_bwd_mv_y,
        residual_y, residual_co, residual_cg,
        width, height, x, y + child_size, child_size, min_size, max_size, fine_blocks_x);
    children[3] = build_quad_tree_bottom_up_bidirectional(
        fine_fwd_mv_x, fine_fwd_mv_y, fine_bwd_mv_x, fine_bwd_mv_y,
        residual_y, residual_co, residual_cg,
        width, height, x + child_size, y + child_size, child_size, min_size, max_size, fine_blocks_x);

    // Check if all children can be merged (similar MVs in BOTH directions and all are leaves)
    int can_merge = 1;

    // All children must be leaves (not already split)
    for (int i = 0; i < 4; i++) {
        if (children[i]->is_split) {
            can_merge = 0;
            break;
        }
    }

    if (can_merge) {
        // Check MV similarity for BOTH forward and backward vectors
        // Threshold: 4 = 1 pixel, 8 = 2 pixels, etc.
        int mv_threshold = 8;  // 2 pixels

        // Check forward MV similarity
        int16_t min_fwd_mv_x = children[0]->fwd_mv_x, max_fwd_mv_x = children[0]->fwd_mv_x;
        int16_t min_fwd_mv_y = children[0]->fwd_mv_y, max_fwd_mv_y = children[0]->fwd_mv_y;

        for (int i = 1; i < 4; i++) {
            if (children[i]->fwd_mv_x < min_fwd_mv_x) min_fwd_mv_x = children[i]->fwd_mv_x;
            if (children[i]->fwd_mv_x > max_fwd_mv_x) max_fwd_mv_x = children[i]->fwd_mv_x;
            if (children[i]->fwd_mv_y < min_fwd_mv_y) min_fwd_mv_y = children[i]->fwd_mv_y;
            if (children[i]->fwd_mv_y > max_fwd_mv_y) max_fwd_mv_y = children[i]->fwd_mv_y;
        }

        int fwd_mv_range_x = max_fwd_mv_x - min_fwd_mv_x;
        int fwd_mv_range_y = max_fwd_mv_y - min_fwd_mv_y;

        if (fwd_mv_range_x > mv_threshold || fwd_mv_range_y > mv_threshold) {
            can_merge = 0;
        }

        // Check backward MV similarity (only if forward MVs are similar)
        if (can_merge) {
            int16_t min_bwd_mv_x = children[0]->bwd_mv_x, max_bwd_mv_x = children[0]->bwd_mv_x;
            int16_t min_bwd_mv_y = children[0]->bwd_mv_y, max_bwd_mv_y = children[0]->bwd_mv_y;

            for (int i = 1; i < 4; i++) {
                if (children[i]->bwd_mv_x < min_bwd_mv_x) min_bwd_mv_x = children[i]->bwd_mv_x;
                if (children[i]->bwd_mv_x > max_bwd_mv_x) max_bwd_mv_x = children[i]->bwd_mv_x;
                if (children[i]->bwd_mv_y < min_bwd_mv_y) min_bwd_mv_y = children[i]->bwd_mv_y;
                if (children[i]->bwd_mv_y > max_bwd_mv_y) max_bwd_mv_y = children[i]->bwd_mv_y;
            }

            int bwd_mv_range_x = max_bwd_mv_x - min_bwd_mv_x;
            int bwd_mv_range_y = max_bwd_mv_y - min_bwd_mv_y;

            if (bwd_mv_range_x > mv_threshold || bwd_mv_range_y > mv_threshold) {
                can_merge = 0;
            }
        }
    }

    if (can_merge) {
        // Merge: average the MVs from children for both directions
        int32_t sum_fwd_mv_x = 0, sum_fwd_mv_y = 0;
        int32_t sum_bwd_mv_x = 0, sum_bwd_mv_y = 0;
        for (int i = 0; i < 4; i++) {
            sum_fwd_mv_x += children[i]->fwd_mv_x;
            sum_fwd_mv_y += children[i]->fwd_mv_y;
            sum_bwd_mv_x += children[i]->bwd_mv_x;
            sum_bwd_mv_y += children[i]->bwd_mv_y;
        }
        node->fwd_mv_x = sum_fwd_mv_x / 4;
        node->fwd_mv_y = sum_fwd_mv_y / 4;
        node->bwd_mv_x = sum_bwd_mv_x / 4;
        node->bwd_mv_y = sum_bwd_mv_y / 4;

        // Free children since we're merging
        for (int i = 0; i < 4; i++) {
            free(children[i]);
        }

        return node;  // Merged leaf node
    } else {
        // Can't merge: keep as split node
        node->is_split = 1;
        for (int i = 0; i < 4; i++) {
            node->children[i] = children[i];
        }

        // Compute average MVs for this internal node (for reference)
        int32_t sum_fwd_mv_x = 0, sum_fwd_mv_y = 0;
        int32_t sum_bwd_mv_x = 0, sum_bwd_mv_y = 0;
        for (int i = 0; i < 4; i++) {
            sum_fwd_mv_x += children[i]->fwd_mv_x;
            sum_fwd_mv_y += children[i]->fwd_mv_y;
            sum_bwd_mv_x += children[i]->bwd_mv_x;
            sum_bwd_mv_y += children[i]->bwd_mv_y;
        }
        node->fwd_mv_x = sum_fwd_mv_x / 4;
        node->fwd_mv_y = sum_fwd_mv_y / 4;
        node->bwd_mv_x = sum_bwd_mv_x / 4;
        node->bwd_mv_y = sum_bwd_mv_y / 4;

        return node;
    }
}

// Build quad-tree recursively with per-block motion refinement (top-down split)
static quad_tree_node_t* build_quad_tree(
    const float *current_y,
    const float *reference_y,
    const float *residual_y,
    const float *residual_co,
    const float *residual_cg,
    int width, int height,
    int x, int y, int size,
    int min_size,
    int16_t mv_x, int16_t mv_y,
    int is_skip,
    int enable_refinement
) {
    quad_tree_node_t *node = (quad_tree_node_t*)malloc(sizeof(quad_tree_node_t));
    node->x = x;
    node->y = y;
    node->size = size;
    node->mv_x = mv_x;
    node->mv_y = mv_y;
    node->is_skip = is_skip;
    node->is_split = 0;
    for (int i = 0; i < 4; i++) node->children[i] = NULL;

    // Don't split if we've reached minimum size or block is skip
    if (size <= min_size || is_skip) {
        return node;
    }

    // Don't split if block extends beyond frame boundaries
    if (x + size > width || y + size > height) {
        return node;
    }

    // Compute variance for each channel
    float var_y = compute_block_variance(residual_y, width, x, y, size);
    float var_co = compute_block_variance(residual_co, width, x, y, size);
    float var_cg = compute_block_variance(residual_cg, width, x, y, size);

    // Combined variance with channel weighting (Y weighted more)
    float combined_variance = var_y + 0.5f * var_co + 0.5f * var_cg;

    // Split threshold: higher variance = more detail = split to smaller blocks
    // Threshold scales with block size (larger blocks need higher variance to avoid split)
    float split_threshold = 100.0f * (size / 16.0f);

    if (combined_variance > split_threshold) {
        // Split into 4 children
        node->is_split = 1;
        int child_size = size / 2;

        // Refine motion vectors for each child block if enabled
        int16_t child_mvs_x[4], child_mvs_y[4];

        if (enable_refinement) {
            // Search range decreases with block size (8 pixels for 32x32, 4 for 16x16, 2 for 8x8)
            int search_range = (child_size >= 32) ? 8 : ((child_size >= 16) ? 4 : 2);

            // Refine MV for each child: NW, NE, SW, SE
            refine_motion_vector(current_y, reference_y, width, height,
                                x, y, child_size,
                                mv_x, mv_y, search_range,
                                &child_mvs_x[0], &child_mvs_y[0]);

            refine_motion_vector(current_y, reference_y, width, height,
                                x + child_size, y, child_size,
                                mv_x, mv_y, search_range,
                                &child_mvs_x[1], &child_mvs_y[1]);

            refine_motion_vector(current_y, reference_y, width, height,
                                x, y + child_size, child_size,
                                mv_x, mv_y, search_range,
                                &child_mvs_x[2], &child_mvs_y[2]);

            refine_motion_vector(current_y, reference_y, width, height,
                                x + child_size, y + child_size, child_size,
                                mv_x, mv_y, search_range,
                                &child_mvs_x[3], &child_mvs_y[3]);
        } else {
            // No refinement - use parent MV for all children
            for (int i = 0; i < 4; i++) {
                child_mvs_x[i] = mv_x;
                child_mvs_y[i] = mv_y;
            }
        }

        // NW, NE, SW, SE - recurse with refined motion vectors
        node->children[0] = build_quad_tree(current_y, reference_y, residual_y, residual_co, residual_cg,
                                           width, height, x, y, child_size, min_size,
                                           child_mvs_x[0], child_mvs_y[0], 0, enable_refinement);
        node->children[1] = build_quad_tree(current_y, reference_y, residual_y, residual_co, residual_cg,
                                           width, height, x + child_size, y, child_size, min_size,
                                           child_mvs_x[1], child_mvs_y[1], 0, enable_refinement);
        node->children[2] = build_quad_tree(current_y, reference_y, residual_y, residual_co, residual_cg,
                                           width, height, x, y + child_size, child_size, min_size,
                                           child_mvs_x[2], child_mvs_y[2], 0, enable_refinement);
        node->children[3] = build_quad_tree(current_y, reference_y, residual_y, residual_co, residual_cg,
                                           width, height, x + child_size, y + child_size, child_size, min_size,
                                           child_mvs_x[3], child_mvs_y[3], 0, enable_refinement);
    }

    return node;
}

// Free quad-tree memory
static void free_quad_tree(quad_tree_node_t *node) {
    if (!node) return;

    if (node->is_split) {
        for (int i = 0; i < 4; i++) {
            free_quad_tree(node->children[i]);
        }
    }

    free(node);
}

// Count total nodes in quad-tree (for serialisation buffer sizing)
static int count_quad_tree_nodes(quad_tree_node_t *node) {
    if (!node) return 0;

    int count = 1;
    if (node->is_split) {
        for (int i = 0; i < 4; i++) {
            count += count_quad_tree_nodes(node->children[i]);
        }
    }
    return count;
}

// Recompute residuals using refined motion vectors from quad-tree leaves
static void recompute_residuals_from_tree(
    quad_tree_node_t *node,
    const float *current_y, const float *current_co, const float *current_cg,
    const float *reference_y, const float *reference_co, const float *reference_cg,
    float *residual_y, float *residual_co, float *residual_cg,
    int width, int height
) {
    if (!node) return;

    if (!node->is_split) {
        // Leaf node - compute residual for this block using its motion vector
        int mv_x_pixels = node->mv_x / 4;  // Convert 1/4-pixel to pixels
        int mv_y_pixels = node->mv_y / 4;
        float mv_x_frac = (node->mv_x % 4) / 4.0f;  // Fractional part
        float mv_y_frac = (node->mv_y % 4) / 4.0f;

        for (int by = 0; by < node->size; by++) {
            for (int bx = 0; bx < node->size; bx++) {
                int cur_x = node->x + bx;
                int cur_y = node->y + by;

                if (cur_x >= width || cur_y >= height) continue;

                int cur_idx = cur_y * width + cur_x;

                // Compute reference position with sub-pixel precision
                float ref_x_f = cur_x + mv_x_pixels + mv_x_frac;
                float ref_y_f = cur_y + mv_y_pixels + mv_y_frac;

                int ref_x = (int)ref_x_f;
                int ref_y = (int)ref_y_f;
                float fx = ref_x_f - ref_x;
                float fy = ref_y_f - ref_y;

                // Bounds check
                if (ref_x < 0 || ref_x + 1 >= width || ref_y < 0 || ref_y + 1 >= height) {
                    // Out of bounds - use zero residual (copy from reference won't work)
                    residual_y[cur_idx] = current_y[cur_idx];
                    residual_co[cur_idx] = current_co[cur_idx];
                    residual_cg[cur_idx] = current_cg[cur_idx];
                    continue;
                }

                // Bilinear interpolation for each channel
                // Y channel
                float v00_y = reference_y[ref_y * width + ref_x];
                float v10_y = reference_y[ref_y * width + (ref_x + 1)];
                float v01_y = reference_y[(ref_y + 1) * width + ref_x];
                float v11_y = reference_y[(ref_y + 1) * width + (ref_x + 1)];
                float pred_y = (v00_y * (1-fx) + v10_y * fx) * (1-fy) +
                               (v01_y * (1-fx) + v11_y * fx) * fy;

                // Co channel
                float v00_co = reference_co[ref_y * width + ref_x];
                float v10_co = reference_co[ref_y * width + (ref_x + 1)];
                float v01_co = reference_co[(ref_y + 1) * width + ref_x];
                float v11_co = reference_co[(ref_y + 1) * width + (ref_x + 1)];
                float pred_co = (v00_co * (1-fx) + v10_co * fx) * (1-fy) +
                                (v01_co * (1-fx) + v11_co * fx) * fy;

                // Cg channel
                float v00_cg = reference_cg[ref_y * width + ref_x];
                float v10_cg = reference_cg[ref_y * width + (ref_x + 1)];
                float v01_cg = reference_cg[(ref_y + 1) * width + ref_x];
                float v11_cg = reference_cg[(ref_y + 1) * width + (ref_x + 1)];
                float pred_cg = (v00_cg * (1-fx) + v10_cg * fx) * (1-fy) +
                                (v01_cg * (1-fx) + v11_cg * fx) * fy;

                // Compute residual
                residual_y[cur_idx] = current_y[cur_idx] - pred_y;
                residual_co[cur_idx] = current_co[cur_idx] - pred_co;
                residual_cg[cur_idx] = current_cg[cur_idx] - pred_cg;
            }
        }
    } else {
        // Internal node - recurse to children
        for (int i = 0; i < 4; i++) {
            recompute_residuals_from_tree(node->children[i],
                                         current_y, current_co, current_cg,
                                         reference_y, reference_co, reference_cg,
                                         residual_y, residual_co, residual_cg,
                                         width, height);
        }
    }
}

// Forward declarations
static void fill_mv_map_recursive(quad_tree_node_t *node, int residual_coding_min_block_size,
                                  int blocks_x, int16_t *mv_map_x, int16_t *mv_map_y);
static int16_t median3(int16_t a, int16_t b, int16_t c);

// Build spatial MV map from quad-tree forest for prediction
// Returns a 2D array indexed by [block_y * blocks_x + block_x]
// Each entry contains the MV for that block (at residual_coding_min_block_size granularity)
static void build_mv_map_from_forest(
    quad_tree_node_t **forest,
    int num_trees_x, int num_trees_y,
    int residual_coding_max_block_size, int residual_coding_min_block_size,
    int width, int height,
    int16_t *mv_map_x, int16_t *mv_map_y
) {
    int blocks_x = (width + residual_coding_min_block_size - 1) / residual_coding_min_block_size;

    // Initialise map with zeros
    int total_blocks = blocks_x * ((height + residual_coding_min_block_size - 1) / residual_coding_min_block_size);
    memset(mv_map_x, 0, total_blocks * sizeof(int16_t));
    memset(mv_map_y, 0, total_blocks * sizeof(int16_t));

    // Fill map from quad-tree leaves
    for (int ty = 0; ty < num_trees_y; ty++) {
        for (int tx = 0; tx < num_trees_x; tx++) {
            int tree_idx = ty * num_trees_x + tx;
            fill_mv_map_recursive(forest[tree_idx], residual_coding_min_block_size, blocks_x, mv_map_x, mv_map_y);
        }
    }
}

// Recursive helper to fill MV map from quad-tree
static void fill_mv_map_recursive(
    quad_tree_node_t *node,
    int residual_coding_min_block_size,
    int blocks_x,
    int16_t *mv_map_x,
    int16_t *mv_map_y
) {
    if (!node) return;

    if (!node->is_split) {
        // Leaf node - fill all min-sized blocks within this region
        int block_x_start = node->x / residual_coding_min_block_size;
        int block_y_start = node->y / residual_coding_min_block_size;
        int block_x_end = (node->x + node->size) / residual_coding_min_block_size;
        int block_y_end = (node->y + node->size) / residual_coding_min_block_size;

        for (int by = block_y_start; by < block_y_end; by++) {
            for (int bx = block_x_start; bx < block_x_end; bx++) {
                int idx = by * blocks_x + bx;
                mv_map_x[idx] = node->mv_x;
                mv_map_y[idx] = node->mv_y;
            }
        }
    } else {
        // Internal node - recurse to children
        for (int i = 0; i < 4; i++) {
            fill_mv_map_recursive(node->children[i], residual_coding_min_block_size, blocks_x, mv_map_x, mv_map_y);
        }
    }
}

// Apply spatial MV prediction to leaf nodes using median predictor
// Modifies MVs in-place to be differentials
static void apply_spatial_mv_prediction_to_tree(
    quad_tree_node_t *node,
    int residual_coding_min_block_size,
    int blocks_x,
    const int16_t *mv_map_x,
    const int16_t *mv_map_y
) {
    if (!node) return;

    if (!node->is_split) {
        // Leaf node - apply median prediction
        int block_x = node->x / residual_coding_min_block_size;
        int block_y = node->y / residual_coding_min_block_size;
        int idx = block_y * blocks_x + block_x;

        // Get neighbors: left, top, top-right
        int16_t left_x = 0, left_y = 0;
        int16_t top_x = 0, top_y = 0;
        int16_t top_right_x = 0, top_right_y = 0;

        if (block_x > 0) {
            // Left neighbor
            int left_idx = idx - 1;
            left_x = mv_map_x[left_idx];
            left_y = mv_map_y[left_idx];
        }

        if (block_y > 0) {
            // Top neighbor
            int top_idx = idx - blocks_x;
            top_x = mv_map_x[top_idx];
            top_y = mv_map_y[top_idx];

            // Top-right neighbor
            if (block_x + 1 < blocks_x) {
                int top_right_idx = top_idx + 1;
                top_right_x = mv_map_x[top_right_idx];
                top_right_y = mv_map_y[top_right_idx];
            }
        }

        // Median prediction (H.264 style)
        int16_t pred_x = median3(left_x, top_x, top_right_x);
        int16_t pred_y = median3(left_y, top_y, top_right_y);

        // Convert to differential
        int16_t orig_mv_x = node->mv_x;
        int16_t orig_mv_y = node->mv_y;
        node->mv_x = orig_mv_x - pred_x;
        node->mv_y = orig_mv_y - pred_y;

    } else {
        // Internal node - recurse to children
        for (int i = 0; i < 4; i++) {
            apply_spatial_mv_prediction_to_tree(node->children[i], residual_coding_min_block_size, blocks_x, mv_map_x, mv_map_y);
        }
    }
}

// Serialise quad-tree to compact binary format
// Format: [split_flags_bitstream][leaf_mv_data]
//   - split_flags: 1 bit per node (breadth-first), 1=split, 0=leaf
//   - leaf_mv_data: For each leaf in order: [skip_flag:1bit][mvd_x:15bits][mvd_y:16bits]
//   Note: MVs are now DIFFERENTIAL (predicted from spatial neighbors)
static size_t serialise_quad_tree(quad_tree_node_t *root, uint8_t *buffer, size_t buffer_size) {
    if (!root) return 0;

    // First pass: Count nodes and leaves
    int total_nodes = count_quad_tree_nodes(root);
    int split_bytes = (total_nodes + 7) / 8;  // Bits for split flags

    // Create temporary arrays for breadth-first traversal
    quad_tree_node_t **queue = (quad_tree_node_t**)malloc(total_nodes * sizeof(quad_tree_node_t*));
    int queue_start = 0, queue_end = 0;

    // Initialise split flags buffer
    uint8_t *split_flags = (uint8_t*)calloc(split_bytes, 1);
    int split_bit_pos = 0;

    // Start serialisation
    queue[queue_end++] = root;
    size_t write_pos = split_bytes;  // Leave space for split flags

    while (queue_start < queue_end) {
        quad_tree_node_t *node = queue[queue_start++];

        // Write split flag
        if (node->is_split) {
            split_flags[split_bit_pos / 8] |= (1 << (split_bit_pos % 8));

            // Add children to queue
            for (int i = 0; i < 4; i++) {
                if (node->children[i]) {
                    queue[queue_end++] = node->children[i];
                }
            }
        } else {
            // Leaf node - will write MV data later
        }

        split_bit_pos++;
    }

    // Second pass: Write leaf node motion vectors
    queue_start = 0;
    queue_end = 0;
    queue[queue_end++] = root;

    while (queue_start < queue_end) {
        quad_tree_node_t *node = queue[queue_start++];

        if (!node->is_split) {
            // Leaf node - write skip flag + motion vectors
            if (write_pos + 5 > buffer_size) {
                fprintf(stderr, "ERROR: Quad-tree serialisation buffer overflow\n");
                free(queue);
                free(split_flags);
                return 0;
            }

            // Pack: [skip:1bit][mv_x:15bits][mv_y:16bits] = 32 bits = 4 bytes
            uint32_t packed = 0;
            if (node->is_skip) {
                packed |= (1U << 31);  // Set skip bit
            }
            packed |= ((uint32_t)(node->mv_x & 0x7FFF) << 16);  // 15 bits for mv_x
            packed |= ((uint32_t)(node->mv_y & 0xFFFF));        // 16 bits for mv_y

            buffer[write_pos++] = (packed >> 24) & 0xFF;
            buffer[write_pos++] = (packed >> 16) & 0xFF;
            buffer[write_pos++] = (packed >> 8) & 0xFF;
            buffer[write_pos++] = packed & 0xFF;
        } else {
            // Add children to queue
            for (int i = 0; i < 4; i++) {
                if (node->children[i]) {
                    queue[queue_end++] = node->children[i];
                }
            }
        }
    }

    // Copy split flags to beginning of buffer
    memcpy(buffer, split_flags, split_bytes);

    free(queue);
    free(split_flags);

    return write_pos;
}

// Serialise quad-tree with bidirectional motion vectors for B-frames (64-bit leaf nodes)
// Format: [split_flags] [leaf_data: skip(1) + fwd_mv_x(15) + fwd_mv_y(16) + bwd_mv_x(16) + bwd_mv_y(16) = 64 bits]
static size_t serialise_quad_tree_bidirectional(quad_tree_node_t *root, uint8_t *buffer, size_t buffer_size) {
    if (!root) return 0;

    // First pass: Count nodes and leaves
    int total_nodes = count_quad_tree_nodes(root);
    int split_bytes = (total_nodes + 7) / 8;  // Bits for split flags

    // Create temporary arrays for breadth-first traversal
    quad_tree_node_t **queue = (quad_tree_node_t**)malloc(total_nodes * sizeof(quad_tree_node_t*));
    int queue_start = 0, queue_end = 0;

    // Initialise split flags buffer
    uint8_t *split_flags = (uint8_t*)calloc(split_bytes, 1);
    int split_bit_pos = 0;

    // Start serialisation
    queue[queue_end++] = root;
    size_t write_pos = split_bytes;  // Leave space for split flags

    while (queue_start < queue_end) {
        quad_tree_node_t *node = queue[queue_start++];

        // Write split flag
        if (node->is_split) {
            split_flags[split_bit_pos / 8] |= (1 << (split_bit_pos % 8));

            // Add children to queue
            for (int i = 0; i < 4; i++) {
                if (node->children[i]) {
                    queue[queue_end++] = node->children[i];
                }
            }
        } else {
            // Leaf node - will write dual MV data later
        }

        split_bit_pos++;
    }

    // Second pass: Write leaf node motion vectors (forward + backward)
    queue_start = 0;
    queue_end = 0;
    queue[queue_end++] = root;

    while (queue_start < queue_end) {
        quad_tree_node_t *node = queue[queue_start++];

        if (!node->is_split) {
            // Leaf node - write skip flag + dual motion vectors
            if (write_pos + 8 > buffer_size) {
                fprintf(stderr, "ERROR: Bidirectional quad-tree serialisation buffer overflow\n");
                free(queue);
                free(split_flags);
                return 0;
            }

            // Pack 64 bits: [skip:1][fwd_mv_x:15][fwd_mv_y:16][bwd_mv_x:16][bwd_mv_y:16]
            // Split into two 32-bit chunks for easier handling

            // First 32 bits: [skip:1][fwd_mv_x:15][fwd_mv_y:16]
            uint32_t packed_fwd = 0;
            if (node->is_skip) {
                packed_fwd |= (1U << 31);  // Set skip bit
            }
            packed_fwd |= ((uint32_t)(node->fwd_mv_x & 0x7FFF) << 16);  // 15 bits for fwd_mv_x
            packed_fwd |= ((uint32_t)(node->fwd_mv_y & 0xFFFF));        // 16 bits for fwd_mv_y

            // Second 32 bits: [bwd_mv_x:16][bwd_mv_y:16]
            uint32_t packed_bwd = 0;
            packed_bwd |= ((uint32_t)(node->bwd_mv_x & 0xFFFF) << 16);  // 16 bits for bwd_mv_x
            packed_bwd |= ((uint32_t)(node->bwd_mv_y & 0xFFFF));        // 16 bits for bwd_mv_y

            // Write first 32 bits (forward MV + skip)
            buffer[write_pos++] = (packed_fwd >> 24) & 0xFF;
            buffer[write_pos++] = (packed_fwd >> 16) & 0xFF;
            buffer[write_pos++] = (packed_fwd >> 8) & 0xFF;
            buffer[write_pos++] = packed_fwd & 0xFF;

            // Write second 32 bits (backward MV)
            buffer[write_pos++] = (packed_bwd >> 24) & 0xFF;
            buffer[write_pos++] = (packed_bwd >> 16) & 0xFF;
            buffer[write_pos++] = (packed_bwd >> 8) & 0xFF;
            buffer[write_pos++] = packed_bwd & 0xFF;
        } else {
            // Add children to queue
            for (int i = 0; i < 4; i++) {
                if (node->children[i]) {
                    queue[queue_end++] = node->children[i];
                }
            }
        }
    }

    // Copy split flags to beginning of buffer
    memcpy(buffer, split_flags, split_bytes);

    free(queue);
    free(split_flags);

    return write_pos;
}

// MP2 audio rate table (same as TEV)
static const int MP2_RATE_TABLE[] = {96, 128, 160, 224, 320, 384, 384};

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

static const int QLUT[] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096};

// Quality level to quantisation mapping for different channels
// the values are indices to the QLUT
static const int QUALITY_Y[] = {79, 47, 23, 11, 5, 2, 0}; // 96, 48, 24, 12, 6, 3, 1
static const int QUALITY_CO[] = {123, 108, 91, 76, 59, 29, 3}; // 240, 180, 120, 90, 60, 30, 4
static const int QUALITY_CG[] = {148, 133, 113, 99, 76, 39, 5}; // 424, 304, 200, 144, 90, 40, 6
static const int QUALITY_ALPHA[] = {79, 47, 23, 11, 5, 2, 0}; // 96, 48, 24, 12, 6, 3, 1

// Dead-zone quantisation thresholds per quality level
// Higher values = more aggressive (more coefficients set to zero)
static const float DEAD_ZONE_THRESHOLD[] = {1.5f, 1.5f, 1.2f, 1.1f, 0.8f, 0.6f, 0.0f};

// Dead-zone scaling factors for different subband levels
#define DEAD_ZONE_FINEST_SCALE 1.0f      // Full dead-zone for finest level (level 6)
#define DEAD_ZONE_FINE_SCALE 0.5f        // Reduced dead-zone for second-finest level (level 5)
// Coarser levels (0-4) use 0.0f (no dead-zone) to preserve structural information

// psychovisual tuning parameters
static const float ANISOTROPY_MULT[] = {5.1f, 3.8f, 2.7f, 2.0f, 1.5f, 1.2f, 1.0f};
static const float ANISOTROPY_BIAS[] = {0.4f, 0.3f, 0.2f, 0.1f, 0.0f, 0.0f, 0.0f};

static const float ANISOTROPY_MULT_CHROMA[] = {7.0f, 6.0f, 5.0f, 4.0f, 3.0f, 2.0f, 1.0f};
static const float ANISOTROPY_BIAS_CHROMA[] = {1.0f, 0.8f, 0.6f, 0.4f, 0.2f, 0.0f, 0.0f};

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
typedef struct tav_encoder_s {
    // Input/output files
    char *input_file;
    char *output_file;
    char *subtitle_file;
    char *fontrom_lo_file;
    char *fontrom_hi_file;
    FILE *output_fp;
    FILE *mp2_file;
    FILE *ffmpeg_video_pipe;
    FILE *pcm_file;  // Float32LE audio file for PCM8/TAD32 mode

    // Video parameters
    int width, height;
    int *widths;
    int *heights;
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
    float dead_zone_threshold;  // Dead-zone quantisation threshold (0 = disabled)
    int bitrate_mode;
    int target_bitrate;

    // Bitrate control (PID controller)
    size_t *video_rate_bin;      // Rolling window of compressed sizes
    int video_rate_bin_size;     // Current number of entries in bin
    int video_rate_bin_capacity; // Maximum capacity (fps)
    float pid_integral;          // PID integral term
    float pid_prev_error;        // PID previous error for derivative
    float pid_filtered_derivative; // Low-pass filtered derivative for smoothing
    float adjusted_quantiser_y_float; // Float precision qY for smooth control
    size_t prev_frame_size;      // Previous frame compressed size for scene change detection
    int scene_change_cooldown;   // Frames to wait after scene change before responding
    float dither_accumulator;    // Accumulated dithering error for error diffusion
    
    // Flags
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
    preprocess_mode_t preprocess_mode;  // Coefficient preprocessing mode (TWOBITMAP=default, EZBC, RAW)
    int channel_layout;   // Channel layout: 0=Y-Co-Cg, 1=Y-only, 2=Y-Co-Cg-A, 3=Y-A, 4=Co-Cg
    int progressive_mode;  // 0 = interlaced (default), 1 = progressive
    int use_delta_encoding;
    int delta_haar_levels; // Number of Haar DWT levels to apply to delta coefficients (0 = disabled)
    int separate_audio_track; // 1 = write entire MP2 file as packet 0x40 after header, 0 = interleave audio (default)
    int pcm8_audio; // 1 = use 8-bit PCM audio (packet 0x21), 0 = use MP2 (default)
    int tad_audio; // 1 = use TAD audio (packet 0x24), 0 = use MP2/PCM8 (default, quality follows quality_level)
    int enable_letterbox_detect; // 1 = detect and emit letterbox/pillarbox packets (default), 0 = disable

    // Frame buffers - ping-pong implementation
    uint8_t *frame_rgb[2];      // [0] and [1] alternate between current and previous
    int frame_buffer_index;     // 0 or 1, indicates which set is "current"
    float *current_frame_y, *current_frame_co, *current_frame_cg, *current_frame_alpha;

    // Convenience pointers (updated each frame to point to current ping-pong buffers)
    uint8_t *current_frame_rgb;
    uint8_t *previous_frame_rgb;

    // DWT coefficient buffers (pre-computed for SKIP detection and encoding)
    float *current_dwt_y, *current_dwt_co, *current_dwt_cg;

    // GOP (Group of Pictures) buffer for temporal 3D DWT
    int enable_temporal_dwt;    // Flag to enable temporal DWT (default: 0 for backward compatibility)
    int temporal_gop_capacity;            // Maximum GOP size (typically 16)
    int temporal_gop_frame_count;         // Current number of frames accumulated in GOP
    uint8_t **temporal_gop_rgb_frames;    // [frame][pixel*3] - RGB data for each GOP frame
    float **temporal_gop_y_frames;        // [frame][pixel] - Y channel for each GOP frame
    float **temporal_gop_co_frames;       // [frame][pixel] - Co channel for each GOP frame
    float **temporal_gop_cg_frames;       // [frame][pixel] - Cg channel for each GOP frame
    int temporal_decomp_levels;  // Number of temporal DWT levels (default: 2)

    // MC-EZBC block-based motion compensation for temporal 3D DWT (0x13 packets)
    int temporal_enable_mcezbc;           // Flag to enable MC-EZBC block compensation (default: 0, uses translation if temporal_dwt enabled)
    int temporal_block_size;              // Block size for motion compensation (default: 16)
    int temporal_num_blocks_x;            // Number of blocks horizontally
    int temporal_num_blocks_y;            // Number of blocks vertically

    // Motion vectors for MC-EZBC lifting (forward and backward for bidirectional prediction)
    int16_t **temporal_gop_mvs_fwd_x;     // [frame][num_blocks] - Forward MVs X in 1/4-pixel units (F[t-1] → F[t])
    int16_t **temporal_gop_mvs_fwd_y;     // [frame][num_blocks] - Forward MVs Y in 1/4-pixel units
    int16_t **temporal_gop_mvs_bwd_x;     // [frame][num_blocks] - Backward MVs X in 1/4-pixel units (F[t+1] → F[t])
    int16_t **temporal_gop_mvs_bwd_y;     // [frame][num_blocks] - Backward MVs Y in 1/4-pixel units

    // MPEG-style residual coding (0x14/0x15 packets) - replaces temporal DWT
    int enable_residual_coding;  // Flag to enable MPEG-style residual coding (I/P/B frames)
    int residual_coding_block_size;              // Block size for motion estimation (default: 16)
    int residual_coding_search_range;            // Motion search range in pixels (default: 16)

    // Reference frame storage for motion compensation (I and P frames)
    float *residual_coding_reference_frame_y;    // Reference frame Y channel (previous I or P frame)
    float *residual_coding_reference_frame_co;   // Reference frame Co channel
    float *residual_coding_reference_frame_cg;   // Reference frame Cg channel
    int residual_coding_reference_frame_allocated; // Flag to track allocation

    // Next reference frame storage for B-frame backward prediction
    float *next_residual_coding_reference_frame_y;    // Next reference frame Y (future P frame for B-frames)
    float *next_residual_coding_reference_frame_co;   // Next reference frame Co
    float *next_residual_coding_reference_frame_cg;   // Next reference frame Cg
    int next_residual_coding_reference_frame_allocated; // Flag to track allocation

    // B-frame GOP configuration
    int residual_coding_enable_bframes;          // Enable B-frames (0=disabled, 1=enabled)
    int residual_coding_bframe_count;            // Number of B-frames between reference frames (M parameter, default: 2)
    int residual_coding_gop_size;                // GOP size (distance between I-frames, default: 24)
    int residual_coding_frames_since_last_iframe; // Counter for GOP management

    // Frame buffering for B-frame lookahead
    int residual_coding_lookahead_buffer_capacity; // Maximum frames to buffer (M+1)
    int residual_coding_lookahead_buffer_count;    // Current number of frames in buffer
    float **residual_coding_lookahead_buffer_y;    // [frame][pixel] - Y channel buffered frames
    float **residual_coding_lookahead_buffer_co;   // [frame][pixel] - Co channel buffered frames
    float **residual_coding_lookahead_buffer_cg;   // [frame][pixel] - Cg channel buffered frames
    int *residual_coding_lookahead_buffer_display_index; // [frame] - Display order index for each buffered frame

    // Block motion vectors for P/B frames (fixed-size blocks - legacy)
    int residual_coding_num_blocks_x;            // Number of blocks horizontally
    int residual_coding_num_blocks_y;            // Number of blocks vertically
    int16_t *residual_coding_motion_vectors_x;   // Motion vectors X in 1/4-pixel units [residual_coding_num_blocks_x * residual_coding_num_blocks_y]
    int16_t *residual_coding_motion_vectors_y;   // Motion vectors Y in 1/4-pixel units
    uint8_t *residual_coding_skip_blocks;        // Skip block flags [residual_coding_num_blocks_x * residual_coding_num_blocks_y]: 1=skip, 0=coded

    // Adaptive block partitioning (quad-tree)
    int residual_coding_enable_adaptive_blocks;  // Enable adaptive block sizing
    int residual_coding_max_block_size;          // Maximum block size (64, 32, 16)
    int residual_coding_min_block_size;          // Minimum block size (4, 8, 16)
    void *residual_coding_block_tree_root;       // Root of quad-tree structure (opaque pointer)

    // Prediction and residual buffers
    float *residual_coding_predicted_frame_y;    // Motion-compensated prediction Y
    float *residual_coding_predicted_frame_co;   // Motion-compensated prediction Co
    float *residual_coding_predicted_frame_cg;   // Motion-compensated prediction Cg
    float *residual_coding_residual_frame_y;     // Residual = current - predicted (Y)
    float *residual_coding_residual_frame_co;    // Residual = current - predicted (Co)
    float *residual_coding_residual_frame_cg;    // Residual = current - predicted (Cg)

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

    // PCM8 audio processing
    int samples_per_frame;  // Number of stereo samples per video frame
    float *pcm32_buffer;  // Buffer for reading Float32LE data
    uint8_t *pcm8_buffer;   // Buffer for converted PCM8 data
    float dither_error[2][2]; // 2nd-order noise shaping error: [channel][history]
    
    // Subtitle processing  
    subtitle_entry_t *subtitles;
    subtitle_entry_t *current_subtitle;
    int subtitle_visible;
    
    // Compression
    ZSTD_CCtx *zstd_ctx;
    void *compressed_buffer;
    size_t compressed_buffer_size;
    int zstd_level;  // Zstd compression level (default: 15)
    
    // OPTIMISATION: Pre-allocated buffers to avoid malloc/free per tile
    int16_t *reusable_quantised_y;
    int16_t *reusable_quantised_co;
    int16_t *reusable_quantised_cg;
    int16_t *reusable_quantised_alpha;

    // Coefficient delta storage for P-frames (previous frame's coefficients)
    float *previous_coeffs_y;      // Previous frame Y coefficients for all tiles
    float *previous_coeffs_co;     // Previous frame Co coefficients for all tiles
    float *previous_coeffs_cg;     // Previous frame Cg coefficients for all tiles
    float *previous_coeffs_alpha;  // Previous frame Alpha coefficients for all tiles
    int previous_coeffs_allocated; // Flag to track allocation

    // Frame type tracking for SKIP mode
    uint8_t last_frame_packet_type;  // Last emitted packet type (TAV_PACKET_IFRAME or TAV_PACKET_PFRAME)
    int is_still_frame_cached;       // Cached result from detect_still_frame() for current frame
    int used_skip_mode_last_frame;   // Set to 1 when SKIP mode was used (suppresses next keyframe timer)

    // Statistics
    size_t total_compressed_size;
    size_t total_uncompressed_size;

    // Progress tracking
    struct timeval start_time;
    int encode_limit;  // Maximum number of frames to encode (0 = no limit)

    // Extended header support
    char *ffmpeg_version;  // FFmpeg version string
    uint64_t creation_time_us;  // Creation time in nanoseconds since UNIX epoch
    long extended_header_offset;  // File offset of extended header for ENDT update

    // Two-pass scene change detection
    int two_pass_mode;                    // Enable two-pass encoding (0=disabled, 1=enabled)
    frame_analysis_t *frame_analyses;     // Array of frame analysis metrics (first pass)
    int frame_analyses_capacity;          // Allocated capacity
    int frame_analyses_count;             // Current number of analysed frames
    gop_boundary_t *gop_boundaries;       // Linked list of GOP boundaries (computed in first pass)
    gop_boundary_t *current_gop_boundary; // Current GOP being encoded (second pass)
    int two_pass_current_frame;           // Current frame number in second pass
    char *two_pass_analysis_file;         // Temporary file for storing analysis data (NULL = in-memory)

} tav_encoder_t;

// Calculate maximum decomposition levels for a given frame size
static int calculate_max_decomp_levels(tav_encoder_t *enc, int width, int height) {
    int levels = 0;
    int min_size = (!enc->monoblock) ? TILE_SIZE_Y : (width < height ? width : height);

    // Keep halving until we reach a minimum size (at least 4 pixels)
    while (min_size >= 8) {  // Need at least 8 pixels to safely halve to 4
        min_size /= 2;
        levels++;
    }

    // Cap at a reasonable maximum to avoid going too deep
    return levels > 10 ? 10 : levels;
}

// Bitrate control functions
static void update_video_rate_bin(tav_encoder_t *enc, size_t compressed_size) {
    if (!enc->bitrate_mode) return;

    if (enc->video_rate_bin_size < enc->video_rate_bin_capacity) {
        enc->video_rate_bin[enc->video_rate_bin_size++] = compressed_size;
    } else {
        // Shift old entries out
        memmove(enc->video_rate_bin, enc->video_rate_bin + 1,
                (enc->video_rate_bin_capacity - 1) * sizeof(size_t));
        enc->video_rate_bin[enc->video_rate_bin_capacity - 1] = compressed_size;
    }
}

static float get_video_rate_kbps(tav_encoder_t *enc) {
    if (!enc->bitrate_mode || enc->video_rate_bin_size == 0) return 0.0f;

    size_t base_rate = 0;
    for (int i = 0; i < enc->video_rate_bin_size; i++) {
        base_rate += enc->video_rate_bin[i];
    }

    float mult = (float)enc->output_fps / enc->video_rate_bin_size;
    return (base_rate * mult / 1024.0f) * 8.0f; // Convert to kbps
}

// PID controller parameters - heavily damped to prevent oscillation
#define PID_KP 0.08f    // Proportional gain - extremely conservative
#define PID_KI 0.002f   // Integral gain - very slow to prevent windup
#define PID_KD 0.4f     // Derivative gain - moderate damping
#define MAX_QY_CHANGE 0.5f // Maximum quantiser change per frame - extremely conservative
#define DERIVATIVE_FILTER 0.85f // Very heavy low-pass filter for derivative
#define INTEGRAL_DEADBAND 0.05f // Don't accumulate integral within ±5% of target
#define INTEGRAL_CLAMP 500.0f   // Clamp integral term to prevent windup

static void adjust_quantiser_for_bitrate(tav_encoder_t *enc) {
    if (!enc->bitrate_mode) {
        // Not in bitrate mode, use base quantiser
        enc->adjusted_quantiser_y_float = (float)enc->quantiser_y;
        return;
    }

    // Need at least a few frames to measure bitrate
    if (enc->video_rate_bin_size < (enc->video_rate_bin_capacity / 2)) {
        // Not enough data yet, use base quantiser
        enc->adjusted_quantiser_y_float = (float)enc->quantiser_y;
        return;
    }

    float current_bitrate = get_video_rate_kbps(enc);
    float target_bitrate = (float)enc->target_bitrate;

    // Calculate error (positive = over target, negative = under target)
    float error = current_bitrate - target_bitrate;

    // Calculate error percentage for adaptive scaling
    float error_percent = fabsf(error) / target_bitrate;

    // Detect scene changes by looking at sudden bitrate jumps
    // Scene changes cause temporary spikes that shouldn't trigger aggressive corrections
    float derivative_abs = fabsf(error - enc->pid_prev_error);
    float derivative_threshold = target_bitrate * 0.4f; // 40% jump = scene change

    if (derivative_abs > derivative_threshold && enc->scene_change_cooldown == 0) {
        // Scene change detected - start cooldown
        enc->scene_change_cooldown = 5; // Wait 5 frames before responding aggressively
    }

    // Reduce responsiveness during scene change cooldown
    float response_factor = (enc->scene_change_cooldown > 0) ? 0.3f : 1.0f;
    if (enc->scene_change_cooldown > 0) {
        enc->scene_change_cooldown--;
    }

    // PID calculations with scene change damping
    float proportional = error * response_factor;

    // Conditional integration: only accumulate when error is outside deadband
    // This prevents windup when close to target
    // Also don't accumulate during scene change cooldown to prevent overreaction
    if (error_percent > INTEGRAL_DEADBAND && enc->scene_change_cooldown == 0) {
        enc->pid_integral += error;
    } else {
        // Aggressively decay integral when within deadband or during scene changes
        // This prevents integral windup that causes qY drift
        enc->pid_integral *= 0.90f;
    }

    // Clamp integral immediately to prevent windup
    enc->pid_integral = FCLAMP(enc->pid_integral, -INTEGRAL_CLAMP, INTEGRAL_CLAMP);

    float derivative = error - enc->pid_prev_error;
    enc->pid_prev_error = error;

    // Apply low-pass filter to derivative to reduce noise from scene changes
    // This smooths out sudden spikes and prevents oscillation
    enc->pid_filtered_derivative = (DERIVATIVE_FILTER * enc->pid_filtered_derivative) +
                                    ((1.0f - DERIVATIVE_FILTER) * derivative);

    // Calculate adjustment using filtered derivative for smoother response
    float pid_output = (PID_KP * proportional) + (PID_KI * enc->pid_integral) +
                       (PID_KD * enc->pid_filtered_derivative);

    // Adaptive scaling based on error magnitude and current quantiser position
    // At low quantisers (0-10), QLUT is exponential and small changes cause huge bitrate swings
    float scale_factor = 100.0f; // Base: ~100 kbps error = 1 quantiser step
    float max_change = MAX_QY_CHANGE;

    if (enc->adjusted_quantiser_y_float < 5.0f) {
        // Extreme lossless (qY 0-4) - be very conservative but still responsive
        // At qY=0, QLUT[0]=1, which is essentially lossless and bitrate is huge
        // Use fixed scale factor to ensure controller can actually respond
        scale_factor = 200.0f; // ~200 kbps error = 1 step
        max_change = 0.3f;
    } else if (enc->adjusted_quantiser_y_float < 15.0f) {
        // Very near lossless (qY 5-14) - very conservative
        scale_factor = 400.0f; // ~400 kbps error = 1 step
        max_change = 0.4f;
    } else if (enc->adjusted_quantiser_y_float < 30.0f) {
        // Near lossless range (qY 15-29) - be conservative
        scale_factor = 200.0f; // ~200 kbps error = 1 step
        max_change = 0.5f;
    } else if (error_percent > 0.5f) {
        // Large error - be slightly more aggressive
        scale_factor = 150.0f;
        max_change = 0.6f;
    }

    // Calculate float adjustment (no integer quantisation yet)
    float adjustment_float = pid_output / scale_factor;

    // Limit maximum change per frame to prevent wild swings (adaptive limit)
    adjustment_float = FCLAMP(adjustment_float, -max_change, max_change);

    // Apply logarithmic scaling to adjustment based on current qY
    // At low qY (0-10), QLUT is exponential so we need much smaller steps
    // At high qY (40+), bitrate changes are small so we can take larger steps
    // This makes it "hard to reach towards 1, easy to reach towards large value"
    float log_scale = 1.0f;
    float current_qy = enc->adjusted_quantiser_y_float;

    // Only apply log scaling when moving deeper into low qY region
    // If we're at low qY and want to move up (increase qY), use faster response
    int wants_to_increase = (adjustment_float > 0);

    if (current_qy < 10 && !wants_to_increase) {
        // Moving down into very near lossless - be very careful
        log_scale = 0.15f + (current_qy / 10.0f) * 0.35f; // 0.15 at qY=0, 0.5 at qY=10
    } else if (current_qy < 10 && wants_to_increase) {
        // Escaping from very low qY - allow faster movement
        log_scale = 0.8f; // Much faster escape from qY < 10
    } else if (current_qy < 20) {
        // Near lossless - small adjustments
        log_scale = 0.5f + ((current_qy - 10) / 10.0f) * 0.3f; // 0.5 at qY=10, 0.8 at qY=20
    } else if (current_qy < 40) {
        // Moderate quality - normal adjustments
        log_scale = 0.8f + ((current_qy - 20) / 20.0f) * 0.2f; // 0.8 at qY=20, 1.0 at qY=40
    }
    // else: qY >= 40, use full scale (1.0)

    adjustment_float *= log_scale;

    // Update float quantiser value (no integer quantisation, keeps full precision)
    float new_quantiser_y_float = enc->adjusted_quantiser_y_float + adjustment_float;

    // Avoid extremely low qY values where QLUT is exponential and causes wild swings
    // For 5000 kbps target, qY < 3 is usually too low and causes oscillation
    float min_qy = (target_bitrate >= 8000) ? 0.0f : (target_bitrate >= 4000) ? 3.0f : 5.0f;
    new_quantiser_y_float = FCLAMP(new_quantiser_y_float, min_qy, 254.0f); // Max index is 254

    enc->adjusted_quantiser_y_float = new_quantiser_y_float;

    if (enc->verbose) {
        printf("Bitrate control: %.1f kbps (target: %.1f kbps) -> qY %.2f->%.2f (adj: %.3f, err: %.1f%%)\n",
               current_bitrate, target_bitrate, current_qy, new_quantiser_y_float, adjustment_float, error_percent * 100);
    }
}

// Convert float qY to integer with error diffusion dithering
// This prevents the controller from getting stuck at integer boundaries
static int quantiser_float_to_int_dithered(tav_encoder_t *enc) {
    float qy_float = enc->adjusted_quantiser_y_float;

    // Add accumulated dithering error
    float qy_with_error = qy_float + enc->dither_accumulator;

    // Round to nearest integer
    int qy_int = (int)(qy_with_error + 0.5f);

    // Calculate quantisation error and accumulate for next frame
    // This is Floyd-Steinberg style error diffusion
    float quantisation_error = qy_with_error - (float)qy_int;
    enc->dither_accumulator = quantisation_error * 0.5f; // Diffuse 50% of error to next frame

    // Clamp to valid range
    qy_int = CLAMP(qy_int, 0, 254);

    return qy_int;
}

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

// encoder stats
static size_t count_intra = 0;
static size_t count_delta = 0;
static size_t count_skip = 0;
static size_t count_gop = 0;  // Frames encoded in GOP blocks (3D-DWT mode)

// Function prototypes
static void show_usage(const char *program_name);
static tav_encoder_t* create_encoder(void);
static void cleanup_encoder(tav_encoder_t *enc);
static int initialise_encoder(tav_encoder_t *enc);

// OpenCV optical flow (external C++ function)
extern void estimate_optical_flow_motion(
    const float *current_y, const float *reference_y,
    int width, int height, int block_size,
    int16_t *mvs_x, int16_t *mvs_y
);

// MC-EZBC block-based motion compensation (external C++ functions)
extern void warp_block_motion(
    const float *src, int width, int height,
    const int16_t *mvs_x, const int16_t *mvs_y,
    int block_size, float *dst
);

extern void warp_bidirectional(
    const float *f0, const float *f1,
    int width, int height,
    const int16_t *mvs_fwd_x, const int16_t *mvs_fwd_y,
    const int16_t *mvs_bwd_x, const int16_t *mvs_bwd_y,
    int block_size, float *prediction
);

// Helper functions for motion compensation
static void apply_translation(const float *src, int width, int height, float dx, float dy, float *dst);

static int get_subband_level_2d(int x, int y, int width, int height, int decomp_levels);
static int get_subband_type_2d(int x, int y, int width, int height, int decomp_levels);
static int get_subband_level(int linear_idx, int width, int height, int decomp_levels);
static int get_subband_type(int linear_idx, int width, int height, int decomp_levels);
static void rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height);
static int calculate_max_decomp_levels(tav_encoder_t *enc, int width, int height);

// Audio and subtitle processing prototypes (from TEV)
static int start_audio_conversion(tav_encoder_t *enc);
static int get_mp2_packet_size(uint8_t *header);
static int mp2_packet_size_to_rate_index(int packet_size, int is_mono);
static long write_extended_header(tav_encoder_t *enc);
static void write_timecode_packet(FILE *output, int frame_num, int fps, int is_ntsc_framerate);
static int process_audio(tav_encoder_t *enc, int frame_num, FILE *output);
static int process_audio_for_gop(tav_encoder_t *enc, int *frame_numbers, int num_frames, FILE *output);
static subtitle_entry_t* parse_subtitle_file(const char *filename, int fps);
static subtitle_entry_t* parse_srt_file(const char *filename, int fps);
static subtitle_entry_t* parse_smi_file(const char *filename, int fps);
static int srt_time_to_frame(const char *time_str, int fps);
static int sami_ms_to_frame(int milliseconds, int fps);
static void free_subtitle_list(subtitle_entry_t *list);
static int write_subtitle_packet(FILE *output, uint32_t index, uint8_t opcode, const char *text);
static int process_subtitles(tav_encoder_t *enc, int frame_num, FILE *output);

// Temporal 3D DWT prototypes
static void dwt_3d_forward(tav_encoder_t *enc, float **gop_data, int width, int height, int num_frames,
                          int spatial_levels, int temporal_levels, int spatial_filter);
static void dwt_3d_forward_mc(tav_encoder_t *enc, float **gop_y, float **gop_co, float **gop_cg,
                              int num_frames, int spatial_levels, int temporal_levels, int spatial_filter);
static size_t gop_flush(tav_encoder_t *enc, FILE *output, int base_quantiser,
                       int *frame_numbers, int actual_gop_size);
static size_t gop_process_and_flush(tav_encoder_t *enc, FILE *output, int base_quantiser,
                                   int *frame_numbers, int force_flush);
static int detect_scene_change_between_frames(const uint8_t *frame1_rgb, const uint8_t *frame2_rgb,
                                               int width, int height,
                                               double *out_avg_diff, double *out_changed_ratio);
static size_t serialise_tile_data(tav_encoder_t *enc, int tile_x, int tile_y,
                                  const float *tile_y_data, const float *tile_co_data, const float *tile_cg_data,
                                  uint8_t mode, uint8_t *buffer);
static void dwt_2d_forward_flexible(tav_encoder_t *enc, float *tile_data, int width, int height, int levels, int filter_type);
static void dwt_2d_haar_inverse_flexible(tav_encoder_t *enc, float *tile_data, int width, int height, int levels);
static void quantise_dwt_coefficients_perceptual_per_coeff(tav_encoder_t *enc,
                                                           float *coeffs, int16_t *quantised, int size,
                                                           int base_quantiser, int width, int height,
                                                           int decomp_levels, int is_chroma, int frame_count);
static void quantise_dwt_coefficients_perceptual_per_coeff_no_normalisation(tav_encoder_t *enc,
                                                           float *coeffs, int16_t *quantised, int size,
                                                           int base_quantiser, int width, int height,
                                                           int decomp_levels, int is_chroma, int frame_count);
static size_t preprocess_coefficients_variable_layout(preprocess_mode_t preprocess_mode, int width, int height,
                                                       int16_t *coeffs_y, int16_t *coeffs_co, int16_t *coeffs_cg, int16_t *coeffs_alpha,
                                                       int coeff_count, int channel_layout, uint8_t *output_buffer);
static size_t preprocess_gop_unified(preprocess_mode_t preprocess_mode, int16_t **quant_y, int16_t **quant_co, int16_t **quant_cg,
                                     int num_frames, int num_pixels, int width, int height, int channel_layout,
                                     uint8_t *output_buffer);

// Show usage information
static void show_usage(const char *program_name) {
    int qtsize = sizeof(MP2_RATE_TABLE) / sizeof(int);

    printf("TAV DWT-based Video Encoder\n");
    printf("Usage: %s [options] -i input.mp4 -o output.mv3\n\n", program_name);
    printf("Options:\n");
    printf("  -i, --input FILE        Input video file\n");
    printf("  -o, --output FILE       Output video file (use '-' for stdout)\n");
    printf("  -s, --size WxH          Video size (default: %dx%d)\n", DEFAULT_WIDTH, DEFAULT_HEIGHT);
    printf("  -f, --fps N             Output frames per second (enables frame rate conversion)\n");
    printf("  -q, --quality N         Quality level 0-5 (default: 3)\n");
    printf("  -Q, --quantiser Y,Co,Cg Quantiser levels 0-255 for each channel (0: lossless, 255: potato)\n");
    printf("  -b, --bitrate N         Target bitrate in kbps (enables bitrate control mode)\n");
    printf("  -c, --channel-layout N  Channel layout: 0=Y-Co-Cg, 1=Y-Co-Cg-A, 2=Y-only, 3=Y-A, 4=Co-Cg, 5=Co-Cg-A (default: 0)\n");
    printf("  -a, --arate N           MP2 audio bitrate in kbps (overrides quality-based audio rate)\n");
    printf("                          Valid values: 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384\n");
//    printf("  --separate-audio-track  Write entire audio track as single packet instead of interleaved\n");
    printf("  --pcm8-audio            Use 8-bit PCM audio instead of MP2 (TSVM native audio format)\n");
    printf("  --tad-audio             Use TAD (DWT-based perceptual) audio codec\n");
    printf("  -S, --subtitles FILE    SubRip (.srt) or SAMI (.smi) subtitle file\n");
    printf("  --fontrom-lo FILE       Low font ROM file for internationalised subtitles\n");
    printf("  --fontrom-hi FILE       High font ROM file for internationalised subtitles\n");
    printf("  -v, --verbose           Verbose output\n");
    printf("  -t, --test              Test mode: generate solid colour frames\n");
    printf("  --lossless              Lossless mode (-q %d -Q1,1,1 -w 0 --intra-only --no-perceptual-tuning --no-dead-zone --arate 384)\n", qtsize);
    printf("  --intra-only            Disable delta and skip encoding\n");
    printf("  --enable-delta          Enable delta encoding\n");
    printf("  --delta-haar N          Apply N-level Haar DWT to delta coefficients (1-6, auto-enables delta)\n");
    printf("  --3d-dwt                Enable temporal 3D DWT (GOP-based encoding with temporal transform; the default encoding mode)\n");
    printf("  --single-pass           Disable two-pass encoding with wavelet-based scene change detection (optimal GOP boundaries)\n");
//    printf("  --mc-ezbc               Enable MC-EZBC block-based motion compensation (requires --temporal-dwt, implies --ezbc)\n");
    printf("  --ezbc                  Enable EZBC (Embedded Zero Block Coding) entropy coding. May help reducing file size on high-quality videos\n");
    printf("  --raw-coeffs            Use raw coefficients (no coefficient preprocessing, for testing)\n");
    printf("  --ictcp                 Use ICtCp colour space instead of YCoCg-R (use when source is in BT.2100)\n");
    printf("  --no-perceptual-tuning  Disable perceptual quantisation\n");
    printf("  --no-dead-zone          Disable dead-zone quantisation (for comparison/testing)\n");
    printf("  --encode-limit N        Encode only first N frames (useful for testing/analysis)\n");
    printf("  --dump-frame N          Dump quantised coefficients for frame N (creates .bin files)\n");
    printf("  --wavelet N             Wavelet filter: 0=LGT 5/3, 1=CDF 9/7, 2=CDF 13/7, 16=DD-4, 255=Haar (default: 1)\n");
    printf("  --zstd-level N          Zstd compression level 1-22 (default: %d, higher = better compression but slower)\n", DEFAULT_ZSTD_LEVEL);
    printf("  --help                  Show this help\n\n");

    printf("Audio Rate by Quality:\n  ");
    for (int i = 0; i < qtsize; i++) {
        printf("%d: %d kbps\t", i, MP2_RATE_TABLE[i]);
    }
    printf("\n\nQuantiser Value by Quality:\n");
    printf("   Y - ");
    for (int i = 0; i < qtsize; i++) {
        printf("%d: Q %d%s(→%d) \t", i, QUALITY_Y[i], QUALITY_Y[i] < 10 ? "  " : QUALITY_Y[i] < 100 ? " " : "", QLUT[QUALITY_Y[i]]);
    }
    printf("\n  Co - ");
    for (int i = 0; i < qtsize; i++) {
        printf("%d: Q %d%s(→%d) \t", i, QUALITY_CO[i], QUALITY_CO[i] < 10 ? "  " : QUALITY_CO[i] < 100 ? " " : "", QLUT[QUALITY_CO[i]]);
    }
    printf("\n  Cg - ");
    for (int i = 0; i < qtsize; i++) {
        printf("%d: Q %d%s(→%d) \t", i, QUALITY_CG[i], QUALITY_CG[i] < 10 ? "  " : QUALITY_CG[i] < 100 ? " " : "", QLUT[QUALITY_CG[i]]);
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

    printf("\nExamples:\n");
    printf("  %s -i input.mp4 -o output.mv3               # Default settings\n", program_name);
    printf("  %s -i input.mkv -q 4 -o output.mv3          # At maximum quality\n", program_name);
    printf("  %s -i input.avi --lossless -o output.mv3    # Lossless encoding\n", program_name);
    printf("  %s -i input.mp4 -b 6000 -o output.mv3       # 6000 kbps bitrate target\n", program_name);
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
    enc->decomp_levels = 6;
    enc->quantiser_y = QUALITY_Y[DEFAULT_QUALITY];
    enc->quantiser_co = QUALITY_CO[DEFAULT_QUALITY];
    enc->quantiser_cg = QUALITY_CG[DEFAULT_QUALITY];
    enc->dead_zone_threshold = DEAD_ZONE_THRESHOLD[DEFAULT_QUALITY];
    enc->intra_only = 0;
    enc->monoblock = 1;  // Default to monoblock mode
    enc->perceptual_tuning = 1;  // Default to perceptual quantisation (versions 5/6)
    enc->preprocess_mode = PREPROCESS_EZBC;  //
    enc->channel_layout = CHANNEL_LAYOUT_YCOCG;  // Default to Y-Co-Cg
    enc->audio_bitrate = 0;  // 0 = use quality table
    enc->encode_limit = 0;  // Default: no frame limit
    enc->zstd_level = DEFAULT_ZSTD_LEVEL;  // Default Zstd compression level
    enc->progressive_mode = 1;  // Default to progressive mode
    enc->use_delta_encoding = 0;
    enc->delta_haar_levels = TEMPORAL_DECOMP_LEVEL;
    enc->separate_audio_track = 0;  // Default: interleave audio packets
    enc->pcm8_audio = 0;  // Default: use MP2 audio
    enc->tad_audio = 0;  // Default: use MP2 audio (TAD quality follows quality_level)
    enc->enable_letterbox_detect = 1;  // Default: enable letterbox/pillarbox detection

    // GOP / temporal DWT settings
    enc->enable_temporal_dwt = 1;  // Mutually exclusive with use_delta_encoding
    enc->temporal_gop_capacity = TEMPORAL_GOP_SIZE;  // 24 frames
    enc->temporal_gop_frame_count = 0;
    enc->temporal_decomp_levels = TEMPORAL_DECOMP_LEVEL;  // 3 levels of temporal DWT (24 -> 12 -> 6 -> 3 temporal subbands)
    enc->temporal_gop_rgb_frames = NULL;
    enc->temporal_gop_y_frames = NULL;
    enc->temporal_gop_co_frames = NULL;
    enc->temporal_gop_cg_frames = NULL;

    // MC-EZBC block-based motion compensation settings (for 0x13 packets)
    enc->temporal_enable_mcezbc = 0;  // Default: disabled (use translation-based 0x12)
    enc->temporal_block_size = 16;    // 16×16 blocks (standard for MC-EZBC)
    enc->temporal_num_blocks_x = 0;   // Will be calculated based on frame dimensions
    enc->temporal_num_blocks_y = 0;
    enc->temporal_gop_mvs_fwd_x = NULL;
    enc->temporal_gop_mvs_fwd_y = NULL;
    enc->temporal_gop_mvs_bwd_x = NULL;
    enc->temporal_gop_mvs_bwd_y = NULL;

    // MPEG-style residual coding settings (for 0x14/0x15 packets)
    enc->enable_residual_coding = 0;  // Default: disabled (use temporal DWT)
    enc->residual_coding_block_size = 16;  // 16×16 blocks (standard MPEG size)
    enc->residual_coding_search_range = 16;  // ±16 pixel search range

    // Adaptive block partitioning (for 0x16 packets)
    enc->residual_coding_enable_adaptive_blocks = 0;  // Default: disabled (use fixed 16×16 blocks)
    enc->residual_coding_max_block_size = 64;  // Maximum block size
    enc->residual_coding_min_block_size = 4;   // Minimum block size
    enc->residual_coding_block_tree_root = NULL;

    // Initialise residual coding buffers (allocated in initialise_encoder)
    enc->residual_coding_reference_frame_y = NULL;
    enc->residual_coding_reference_frame_co = NULL;
    enc->residual_coding_reference_frame_cg = NULL;
    enc->residual_coding_reference_frame_allocated = 0;
    enc->residual_coding_num_blocks_x = 0;
    enc->residual_coding_num_blocks_y = 0;
    enc->residual_coding_motion_vectors_x = NULL;
    enc->residual_coding_motion_vectors_y = NULL;
    enc->residual_coding_predicted_frame_y = NULL;
    enc->residual_coding_predicted_frame_co = NULL;
    enc->residual_coding_predicted_frame_cg = NULL;
    enc->residual_coding_residual_frame_y = NULL;
    enc->residual_coding_residual_frame_co = NULL;
    enc->residual_coding_residual_frame_cg = NULL;

    // B-frame settings (for 0x17 packets)
    enc->residual_coding_enable_bframes = 0;  // Default: disabled (I/P frames only)
    enc->residual_coding_bframe_count = 2;    // Default: 2 B-frames between references (M=2)
    enc->residual_coding_gop_size = 24;       // Default: GOP size = 24 frames (1 second @ 24fps)
    enc->residual_coding_frames_since_last_iframe = 0;

    // B-frame next reference frame storage (allocated when first needed)
    enc->next_residual_coding_reference_frame_y = NULL;
    enc->next_residual_coding_reference_frame_co = NULL;
    enc->next_residual_coding_reference_frame_cg = NULL;
    enc->next_residual_coding_reference_frame_allocated = 0;

    // B-frame lookahead buffer (allocated when first needed)
    enc->residual_coding_lookahead_buffer_capacity = 0;
    enc->residual_coding_lookahead_buffer_count = 0;
    enc->residual_coding_lookahead_buffer_y = NULL;
    enc->residual_coding_lookahead_buffer_co = NULL;
    enc->residual_coding_lookahead_buffer_cg = NULL;
    enc->residual_coding_lookahead_buffer_display_index = NULL;

    // Two-pass mode initialisation
    enc->two_pass_mode = 1; // enable by default
    enc->frame_analyses = NULL;
    enc->frame_analyses_capacity = 0;
    enc->frame_analyses_count = 0;
    enc->gop_boundaries = NULL;
    enc->current_gop_boundary = NULL;
    enc->two_pass_current_frame = 0;
    enc->two_pass_analysis_file = NULL;

    return enc;
}

// Initialise encoder resources
static int initialise_encoder(tav_encoder_t *enc) {
    if (!enc) return -1;

    // Automatic decomposition levels for monoblock mode
    enc->decomp_levels = calculate_max_decomp_levels(enc, enc->width, enc->height);

    // Calculate tile dimensions
    if (enc->monoblock) {
        // Monoblock mode: single tile covering entire frame
        enc->tiles_x = 1;
        enc->tiles_y = 1;
    } else {
        // Standard mode: multiple tiles
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
    enc->current_frame_alpha = malloc(frame_size * sizeof(float));

    // Allocate DWT coefficient buffers for SKIP detection
    enc->current_dwt_y = malloc(frame_size * sizeof(float));
    enc->current_dwt_co = malloc(frame_size * sizeof(float));
    enc->current_dwt_cg = malloc(frame_size * sizeof(float));

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
    enc->reusable_quantised_alpha = malloc(coeff_count_per_tile * sizeof(int16_t));

    // Allocate coefficient delta storage for P-frames (per-tile coefficient storage)
    size_t total_coeff_size = num_tiles * coeff_count_per_tile * sizeof(float);
    enc->previous_coeffs_y = malloc(total_coeff_size);
    enc->previous_coeffs_co = malloc(total_coeff_size);
    enc->previous_coeffs_cg = malloc(total_coeff_size);
    enc->previous_coeffs_alpha = malloc(total_coeff_size);
    enc->previous_coeffs_allocated = 0; // Will be set to 1 after first I-frame

    // Initialise bitrate control if in bitrate mode
    if (enc->bitrate_mode) {
        enc->video_rate_bin_capacity = enc->output_fps > 0 ? enc->output_fps : enc->fps;
        enc->video_rate_bin = calloc(enc->video_rate_bin_capacity, sizeof(size_t));
        enc->video_rate_bin_size = 0;
        enc->pid_integral = 0.0f;
        enc->pid_prev_error = 0.0f;
        enc->adjusted_quantiser_y_float = (float)enc->quantiser_y; // Start with base quantiser
        enc->dither_accumulator = 0.0f;

        if (!enc->video_rate_bin) {
            return -1;
        }

        printf("Bitrate control enabled: target = %d kbps, initial quality = %d\n",
               enc->target_bitrate, enc->quality_level);
    }

    // Allocate MPEG-style residual coding buffers if enabled
    if (enc->enable_residual_coding) {
        // Calculate number of blocks
        enc->residual_coding_num_blocks_x = (enc->width + enc->residual_coding_block_size - 1) / enc->residual_coding_block_size;
        enc->residual_coding_num_blocks_y = (enc->height + enc->residual_coding_block_size - 1) / enc->residual_coding_block_size;
        int total_blocks = enc->residual_coding_num_blocks_x * enc->residual_coding_num_blocks_y;

        // Allocate reference frame storage
        enc->residual_coding_reference_frame_y = malloc(frame_size * sizeof(float));
        enc->residual_coding_reference_frame_co = malloc(frame_size * sizeof(float));
        enc->residual_coding_reference_frame_cg = malloc(frame_size * sizeof(float));
        enc->residual_coding_reference_frame_allocated = 0;  // Will be set to 1 after first I-frame

        // Allocate motion vector storage
        enc->residual_coding_motion_vectors_x = malloc(total_blocks * sizeof(int16_t));
        enc->residual_coding_motion_vectors_y = malloc(total_blocks * sizeof(int16_t));
        enc->residual_coding_skip_blocks = malloc(total_blocks * sizeof(uint8_t));

        // Allocate prediction buffers
        enc->residual_coding_predicted_frame_y = malloc(frame_size * sizeof(float));
        enc->residual_coding_predicted_frame_co = malloc(frame_size * sizeof(float));
        enc->residual_coding_predicted_frame_cg = malloc(frame_size * sizeof(float));

        // Allocate residual buffers
        enc->residual_coding_residual_frame_y = malloc(frame_size * sizeof(float));
        enc->residual_coding_residual_frame_co = malloc(frame_size * sizeof(float));
        enc->residual_coding_residual_frame_cg = malloc(frame_size * sizeof(float));

        if (!enc->residual_coding_reference_frame_y || !enc->residual_coding_reference_frame_co || !enc->residual_coding_reference_frame_cg ||
            !enc->residual_coding_motion_vectors_x || !enc->residual_coding_motion_vectors_y || !enc->residual_coding_skip_blocks ||
            !enc->residual_coding_predicted_frame_y || !enc->residual_coding_predicted_frame_co || !enc->residual_coding_predicted_frame_cg ||
            !enc->residual_coding_residual_frame_y || !enc->residual_coding_residual_frame_co || !enc->residual_coding_residual_frame_cg) {
            fprintf(stderr, "Error: Failed to allocate residual coding buffers\n");
            return -1;
        }

        printf("MPEG-style residual coding: %dx%d blocks (block_size=%d, search_range=%d)\n",
               enc->residual_coding_num_blocks_x, enc->residual_coding_num_blocks_y, enc->residual_coding_block_size, enc->residual_coding_search_range);
    }

    // Allocate GOP buffers if temporal DWT is enabled
    if (enc->enable_temporal_dwt) {
        size_t frame_rgb_size = frame_size * 3;  // RGB
        size_t frame_channel_size = frame_size * sizeof(float);

        // Allocate frame arrays
        enc->temporal_gop_rgb_frames = malloc(enc->temporal_gop_capacity * sizeof(uint8_t*));
        enc->temporal_gop_y_frames = malloc(enc->temporal_gop_capacity * sizeof(float*));
        enc->temporal_gop_co_frames = malloc(enc->temporal_gop_capacity * sizeof(float*));
        enc->temporal_gop_cg_frames = malloc(enc->temporal_gop_capacity * sizeof(float*));

        if (!enc->temporal_gop_rgb_frames || !enc->temporal_gop_y_frames ||
            !enc->temporal_gop_co_frames || !enc->temporal_gop_cg_frames) {
            return -1;
        }

        // Allocate individual frame buffers
        for (int i = 0; i < enc->temporal_gop_capacity; i++) {
            enc->temporal_gop_rgb_frames[i] = malloc(frame_rgb_size);
            enc->temporal_gop_y_frames[i] = malloc(frame_channel_size);
            enc->temporal_gop_co_frames[i] = malloc(frame_channel_size);
            enc->temporal_gop_cg_frames[i] = malloc(frame_channel_size);

            if (!enc->temporal_gop_rgb_frames[i] || !enc->temporal_gop_y_frames[i] ||
                !enc->temporal_gop_co_frames[i] || !enc->temporal_gop_cg_frames[i]) {
                // Cleanup on allocation failure
                for (int j = 0; j <= i; j++) {
                    free(enc->temporal_gop_rgb_frames[j]);
                    free(enc->temporal_gop_y_frames[j]);
                    free(enc->temporal_gop_co_frames[j]);
                    free(enc->temporal_gop_cg_frames[j]);
                }
                free(enc->temporal_gop_rgb_frames);
                free(enc->temporal_gop_y_frames);
                free(enc->temporal_gop_co_frames);
                free(enc->temporal_gop_cg_frames);
                return -1;
            }
        }

        // Calculate block dimensions if MC-EZBC is enabled
        if (enc->temporal_enable_mcezbc) {
            // Calculate block grid for MC-EZBC
            // Block size: 16×16 (standard for MC-EZBC and MPEG-style codecs)
            // For 560×448: 35×28 blocks (980 blocks), for 1920×1080: 120×68 blocks (8160 blocks)
            enc->temporal_num_blocks_x = (enc->width + enc->temporal_block_size - 1) / enc->temporal_block_size;
            enc->temporal_num_blocks_y = (enc->height + enc->temporal_block_size - 1) / enc->temporal_block_size;

            int num_blocks = enc->temporal_num_blocks_x * enc->temporal_num_blocks_y;

            // Allocate motion vector arrays for each GOP frame
            enc->temporal_gop_mvs_fwd_x = malloc(enc->temporal_gop_capacity * sizeof(int16_t*));
            enc->temporal_gop_mvs_fwd_y = malloc(enc->temporal_gop_capacity * sizeof(int16_t*));
            enc->temporal_gop_mvs_bwd_x = malloc(enc->temporal_gop_capacity * sizeof(int16_t*));
            enc->temporal_gop_mvs_bwd_y = malloc(enc->temporal_gop_capacity * sizeof(int16_t*));

            if (!enc->temporal_gop_mvs_fwd_x || !enc->temporal_gop_mvs_fwd_y ||
                !enc->temporal_gop_mvs_bwd_x || !enc->temporal_gop_mvs_bwd_y) {
                fprintf(stderr, "Failed to allocate GOP motion vector arrays\n");
                return -1;
            }

            // Allocate individual motion vector buffers
            for (int i = 0; i < enc->temporal_gop_capacity; i++) {
                enc->temporal_gop_mvs_fwd_x[i] = malloc(num_blocks * sizeof(int16_t));
                enc->temporal_gop_mvs_fwd_y[i] = malloc(num_blocks * sizeof(int16_t));
                enc->temporal_gop_mvs_bwd_x[i] = malloc(num_blocks * sizeof(int16_t));
                enc->temporal_gop_mvs_bwd_y[i] = malloc(num_blocks * sizeof(int16_t));

                if (!enc->temporal_gop_mvs_fwd_x[i] || !enc->temporal_gop_mvs_fwd_y[i] ||
                    !enc->temporal_gop_mvs_bwd_x[i] || !enc->temporal_gop_mvs_bwd_y[i]) {
                    fprintf(stderr, "Failed to allocate GOP motion vector buffers\n");
                    return -1;
                }

                // Initialise to zero
                memset(enc->temporal_gop_mvs_fwd_x[i], 0, num_blocks * sizeof(int16_t));
                memset(enc->temporal_gop_mvs_fwd_y[i], 0, num_blocks * sizeof(int16_t));
                memset(enc->temporal_gop_mvs_bwd_x[i], 0, num_blocks * sizeof(int16_t));
                memset(enc->temporal_gop_mvs_bwd_y[i], 0, num_blocks * sizeof(int16_t));
            }

            if (enc->verbose) {
                printf("MC-EZBC enabled: %dx%d blocks (%d total), block size=%dx%d\n",
                       enc->temporal_num_blocks_x, enc->temporal_num_blocks_y, num_blocks,
                       enc->temporal_block_size, enc->temporal_block_size);
            }
        }

        if (enc->verbose) {
            printf("Temporal DWT enabled: GOP size=%d, temporal levels=%d\n",
                   enc->temporal_gop_capacity, enc->temporal_decomp_levels);
        }
    }

    if (!enc->frame_rgb[0] || !enc->frame_rgb[1] ||
        !enc->current_frame_y || !enc->current_frame_co || !enc->current_frame_cg || !enc->current_frame_alpha ||
        !enc->tiles || !enc->zstd_ctx || !enc->compressed_buffer ||
        !enc->reusable_quantised_y || !enc->reusable_quantised_co || !enc->reusable_quantised_cg || !enc->reusable_quantised_alpha ||
        !enc->previous_coeffs_y || !enc->previous_coeffs_co || !enc->previous_coeffs_cg || !enc->previous_coeffs_alpha) {
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

// 1D DWT using lifting scheme for 9/7 integer-reversible filter
static void dwt_97_iint_forward_1d(float *data, int length) {
    if (length < 2) return;
    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    for (int i = 0; i < half; ++i) temp[i] = data[2*i];
    for (int i = 0; i < length/2; ++i) temp[half + i] = data[2*i + 1];

    const int SHIFT = 16;
    const int64_t ROUND = 1LL << (SHIFT - 1);
    const int64_t A = -103949; // α
    const int64_t B = -3472;   // β
    const int64_t G = 57862;   // γ
    const int64_t D = 29066;   // δ
    const int64_t K_FP  = 80542; // ≈ 1.230174105 * 2^16
    const int64_t Ki_FP = 53283; // ≈ (1/1.230174105) * 2^16

    #define RN(x) (((x)>=0)?(((x)+ROUND)>>SHIFT):(-((-(x)+ROUND)>>SHIFT)))

    // Predict α
    for (int i = 0; i < length/2; ++i) {
        int s = temp[i];
        int sn = (i+1<half)? temp[i+1] : s;
        temp[half+i] += RN(A * (int64_t)(s + sn));
    }

    // Update β
    for (int i = 0; i < half; ++i) {
        int d = (half+i<length)? temp[half+i]:0;
        int dp = (i>0 && half+i-1<length)? temp[half+i-1]:d;
        temp[i] += RN(B * (int64_t)(dp + d));
    }

    // Predict γ
    for (int i = 0; i < length/2; ++i) {
        int s = temp[i];
        int sn = (i+1<half)? temp[i+1]:s;
        temp[half+i] += RN(G * (int64_t)(s + sn));
    }

    // Update δ
    for (int i = 0; i < half; ++i) {
        int d = (half+i<length)? temp[half+i]:0;
        int dp = (i>0 && half+i-1<length)? temp[half+i-1]:d;
        temp[i] += RN(D * (int64_t)(dp + d));
    }

    // Scaling step (integer reversible)
    for (int i = 0; i < half; ++i) {
        temp[i] = (((int64_t)temp[i] * K_FP  + ROUND) >> SHIFT); // s * K
    }
    for (int i = 0; i < length/2; ++i) {
        if (half + i < length) {
            temp[half + i] = (((int64_t)temp[half + i] * Ki_FP + ROUND) >> SHIFT); // d / K
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
    #undef RN
}


// Four-point interpolating Deslauriers-Dubuc (DD-4) wavelet forward 1D transform
// Uses four-sample prediction kernel: w[-1]=-1/16, w[0]=9/16, w[1]=9/16, w[2]=-1/16
static void dwt_dd4_forward_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Split into even/odd samples
    for (int i = 0; i < half; i++) {
        temp[i] = data[2 * i];           // Even (low)
    }
    for (int i = 0; i < length / 2; i++) {
        temp[half + i] = data[2 * i + 1]; // Odd (high)
    }

    // DD-4 forward prediction step with four-point kernel
    // Predict odd samples using four neighboring even samples
    // Prediction: P(x) = (-1/16)*s[i-1] + (9/16)*s[i] + (9/16)*s[i+1] + (-1/16)*s[i+2]
    for (int i = 0; i < length / 2; i++) {
        // Get four neighboring even samples with symmetric boundary extension
        float s_m1, s_0, s_1, s_2;

        // s[i-1]
        if (i > 0) s_m1 = temp[i - 1];
        else s_m1 = temp[0]; // Mirror boundary

        // s[i]
        s_0 = temp[i];

        // s[i+1]
        if (i + 1 < half) s_1 = temp[i + 1];
        else s_1 = temp[half - 1]; // Mirror boundary

        // s[i+2]
        if (i + 2 < half) s_2 = temp[i + 2];
        else if (half > 1) s_2 = temp[half - 2]; // Mirror boundary
        else s_2 = temp[half - 1];

        // Apply four-point prediction kernel
        float prediction = (-1.0f/16.0f) * s_m1 + (9.0f/16.0f) * s_0 +
                          (9.0f/16.0f) * s_1 + (-1.0f/16.0f) * s_2;

        temp[half + i] -= prediction;
    }

    // DD-4 update step - use simple averaging of adjacent high-pass coefficients
    // s[i] += 0.25 * (d[i-1] + d[i])
    for (int i = 0; i < half; i++) {
        float d_curr = (i < length / 2) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && i - 1 < length / 2) ? temp[half + i - 1] : 0.0f;
        temp[i] += 0.25f * (d_prev + d_curr);
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// Biorthogonal 13/7 wavelet forward 1D transform
// Analysis filters: Low-pass (13 taps), High-pass (7 taps)
// Using lifting scheme with predict and update steps (same structure as 5/3)
static void dwt_bior137_forward_1d(float *data, int length) {
    if (length < 2) return;

    const float K = 1.230174105f;


    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Step 1: Predict step (high-pass) - exactly like 5/3 structure
    for (int i = 0; i < half; i++) {
        int idx = 2 * i + 1;
        if (idx < length) {
            float prediction = 0.0f;

            // Simple 2-tap prediction for now (will expand to 7-tap later)
            float left = data[2 * i];
            float right = (2 * i + 2 < length) ? data[2 * i + 2] : data[2 * i];
            prediction = 0.5f * (left + right);

            temp[half + i] = data[idx] - prediction;
        }
    }

    // Step 2: Update step (low-pass) - exactly like 5/3 structure
    for (int i = 0; i < half; i++) {
        float update = 0.25f * ((i > 0 ? temp[half + i - 1] : 0) +
                               (i < half - 1 ? temp[half + i] : 0));
        temp[i] = data[2 * i] + update;
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

// Haar wavelet forward 1D transform
// The simplest wavelet: averages and differences
static void dwt_haar_forward_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Haar transform: compute averages (low-pass) and differences (high-pass)
    for (int i = 0; i < half; i++) {
        if (2 * i + 1 < length) {
            // Average of adjacent pairs (low-pass)
            temp[i] = (data[2 * i] + data[2 * i + 1]) / 2.0f;
            // Difference of adjacent pairs (high-pass)
            temp[half + i] = (data[2 * i] - data[2 * i + 1]) / 2.0f;
        } else {
            // Handle odd length: last sample goes to low-pass
            temp[i] = data[2 * i];
            if (half + i < length) {
                temp[half + i] = 0.0f;
            }
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// Haar wavelet inverse 1D transform
// Reconstructs from averages (low-pass) and differences (high-pass)
static void dwt_haar_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Inverse Haar transform: reconstruct from averages and differences
    for (int i = 0; i < half; i++) {
        if (2 * i + 1 < length) {
            // Reconstruct adjacent pairs from average and difference
            temp[2 * i] = data[i] + data[half + i];      // average + difference
            temp[2 * i + 1] = data[i] - data[half + i];  // average - difference
        } else {
            // Handle odd length: last sample is just the low-pass value
            temp[2 * i] = data[i];
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// 1D DWT inverse using lifting scheme for 5/3 reversible filter
static void dwt_53_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Copy low-pass and high-pass subbands to temp
    memcpy(temp, data, length * sizeof(float));

    // Undo update step (low-pass)
    for (int i = 0; i < half; i++) {
        float update = 0.25f * ((i > 0 ? temp[half + i - 1] : 0) +
                               (i < half - 1 ? temp[half + i] : 0));
        temp[i] -= update;
    }

    // Undo predict step (high-pass) and interleave samples
    for (int i = 0; i < half; i++) {
        data[2 * i] = temp[i];  // Even samples (low-pass)
        int idx = 2 * i + 1;
        if (idx < length) {
            float pred = 0.5f * (temp[i] + (i < half - 1 ? temp[i + 1] : temp[i]));
            data[idx] = temp[half + i] + pred;  // Odd samples (high-pass)
        }
    }

    free(temp);
}


// Note: build_mesh_from_flow, smooth_mesh_laplacian, warp_frame_with_mesh,
// and estimate_motion_optical_flow are implemented in encoder_tav_opencv.cpp

// =============================================================================
// Temporal Subband Quantisation
// =============================================================================

// Determine which temporal decomposition level a frame belongs to after 3D DWT
// With 3 decomposition levels on 24 frames:
// - Level 0 (tLLL): frames 0-2 (3 frames, coarsest low-pass)
// - Level 1 (tLLH): frames 3-5 (3 frames, high-pass from 3rd decomposition)
// - Level 2 (tLH): frames 6-11 (6 frames, high-pass from 2nd decomposition)
// - Level 3 (tH): frames 12-23 (12 frames, high-pass from 1st decomposition)
static int get_temporal_subband_level(int frame_idx, int num_frames, int temporal_levels) {
    // After temporal DWT with N levels, frames are organised as:
    // Frames 0...num_frames/(2^N) = tL...L (N low-passes, coarsest)
    // Remaining frames are temporal high-pass subbands at various levels

    // Check each level boundary from coarsest to finest
    for (int level = 0; level < temporal_levels; level++) {
        int frames_at_this_level = num_frames >> (temporal_levels - level);
        if (frame_idx < frames_at_this_level) {
            return level;
        }
    }

    // Finest level (first decomposition's high-pass)
    return temporal_levels;
}

// Quantise 3D DWT coefficients with SEPARABLE temporal-spatial quantisation
//
// IMPORTANT: This implements a separable quantisation approach (temporal × spatial)
// After dwt_3d_forward(), the GOP coefficients have this structure:
//   - Temporal DWT applied first (24 frames → 3 levels)
//     → Results in temporal subbands: tLLL (frames 0-2), tLLH (3-5), tLH (6-11), tH (12-23)
//   - Then spatial DWT applied to each temporal subband
//     → Each frame now contains 2D spatial coefficients (LL, LH, HL, HH subbands)
//
// Quantisation strategy:
//   1. Compute temporal base quantiser: tH_base(level) = Qbase_t * 2^(beta*level)
//      - tLL (level 0): coarsest temporal, most important → smallest quantiser
//      - tHH (level 2): finest temporal, less important → largest quantiser
//   2. Apply spatial perceptual weighting to tH_base (LL: 1.0x, LH/HL: 1.5-2.0x, HH: 2.0-3.0x)
//   3. Final quantiser: Q_effective = tH_base × spatial_weight
//
// This separable approach is efficient and what most 3D wavelet codecs use.
static void quantise_3d_dwt_coefficients(tav_encoder_t *enc,
                                        float **gop_coeffs,  // [frame][pixel] - frame = temporal subband
                                        int16_t **quantised,  // [frame][pixel] - output quantised coefficients
                                        int num_frames,
                                        int spatial_size,
                                        int base_quantiser,
                                        int is_chroma) {
    const float BETA = 0.6f;  // Temporal scaling exponent (aggressive for temporal high-pass)
    const float KAPPA = 1.14f;

    // Process each temporal subband independently (separable approach)
    for (int t = 0; t < num_frames; t++) {
        // Step 1: Determine temporal subband level
        // After 2-level temporal DWT on 16 frames:
        //   - Frames 0-3: tLL (level 0) - temporal low-pass, most important
        //   - Frames 4-7, 8-11, 12-15: tLH, tHL, tHH (levels 1-2) - temporal high-pass
        int temporal_level = get_temporal_subband_level(t, num_frames, enc->temporal_decomp_levels);

        // Step 2: Compute temporal base quantiser using exponential scaling
        // Formula: tH_base = Qbase_t * 1.0 * 2^(2.0 * level)
        // Example with Qbase_t=16:
        //   - Level 0 (tLL): 16 * 1.0 * 2^0 = 16 (same as intra-only)
        //   - Level 1 (tH):  16 * 1.0 * 2^2.0 = 64 (4× base, aggressive)
        //   - Level 2 (tHH): 16 * 1.0 * 2^4.0 = 256 → clamped to 255 (very aggressive)
        float temporal_scale = powf(2.0f, BETA * powf(temporal_level, KAPPA));
        float temporal_quantiser = base_quantiser * temporal_scale;

        // Convert to integer for quantisation
        int temporal_base_quantiser = (int)roundf(temporal_quantiser);
        temporal_base_quantiser = CLAMP(temporal_base_quantiser, 1, 255);

        // Step 3: Apply spatial quantisation within this temporal subband
        // The existing function applies spatial perceptual weighting:
        //   Q_effective = tH_base × spatial_weight
        // Where spatial_weight depends on spatial frequency (LL, LH, HL, HH subbands)
        // This reuses all existing perceptual weighting and dead-zone logic
        //
        // CRITICAL: Use no_normalisation variant when EZBC is enabled
        // - EZBC mode: coefficients must be denormalised (quantise + multiply back)
        // - Twobit-map/raw mode: coefficients stay normalised (quantise only)
        if (enc->preprocess_mode == PREPROCESS_EZBC) {
            quantise_dwt_coefficients_perceptual_per_coeff_no_normalisation(
                enc,
                gop_coeffs[t],           // Input: spatial coefficients for this temporal subband
                quantised[t],            // Output: quantised spatial coefficients (denormalised for EZBC)
                spatial_size,            // Number of spatial coefficients
                temporal_base_quantiser, // Temporally-scaled base quantiser (tH_base)
                enc->width,              // Frame width
                enc->height,             // Frame height
                enc->decomp_levels,      // Spatial decomposition levels (typically 6)
                is_chroma,               // Is chroma channel (gets additional quantisation)
                enc->frame_count + t     // Frame number (for any frame-dependent logic)
            );
        } else {
            quantise_dwt_coefficients_perceptual_per_coeff(
                enc,
                gop_coeffs[t],           // Input: spatial coefficients for this temporal subband
                quantised[t],            // Output: quantised spatial coefficients (normalised for twobit-map)
                spatial_size,            // Number of spatial coefficients
                temporal_base_quantiser, // Temporally-scaled base quantiser (tH_base)
                enc->width,              // Frame width
                enc->height,             // Frame height
                enc->decomp_levels,      // Spatial decomposition levels (typically 6)
                is_chroma,               // Is chroma channel (gets additional quantisation)
                enc->frame_count + t     // Frame number (for any frame-dependent logic)
            );
        }

        if (enc->verbose && (t == 0 || t == num_frames - 1)) {
            printf("  Temporal subband %d: level=%d, tH_base=%d\n",
                   t, temporal_level, temporal_base_quantiser);
        }
    }
}

// =============================================================================
// Block MV Differential Encoding for MC-EZBC
// =============================================================================

// Encode block motion vectors with temporal and spatial prediction
// Returns the number of bytes written to output buffer
// Format:
//   1. Block grid dimensions (1 byte each: blocks_x, blocks_y)
//   2. Forward MVs for all blocks (temporal + spatial differential encoding)
// Note: Backward MVs are computed as negation of forward MVs, so not stored separately
static size_t encode_block_mvs_differential(
    int16_t **mvs_x, int16_t **mvs_y,
    int gop_size, int num_blocks_x, int num_blocks_y,
    uint8_t *output_buffer, size_t buffer_capacity
) {
    int num_blocks = num_blocks_x * num_blocks_y;
    size_t bytes_written = 0;

    // Write block grid dimensions (1 byte each)
    if (bytes_written + 2 > buffer_capacity) return 0;
    uint8_t blocks_x_8 = (uint8_t)num_blocks_x;
    uint8_t blocks_y_8 = (uint8_t)num_blocks_y;
    output_buffer[bytes_written++] = blocks_x_8;
    output_buffer[bytes_written++] = blocks_y_8;

    // Encode forward MVs for all blocks with temporal + spatial prediction
    for (int t = 0; t < gop_size; t++) {
        for (int i = 0; i < num_blocks; i++) {
            int16_t dx = mvs_x[t][i];
            int16_t dy = mvs_y[t][i];

            // Temporal prediction (from previous frame)
            if (t > 0) {
                dx -= mvs_x[t - 1][i];
                dy -= mvs_y[t - 1][i];
            }

            // Spatial prediction (from left block)
            if (i > 0 && (i % num_blocks_x) != 0) {
                int16_t left_dx = mvs_x[t][i - 1];
                int16_t left_dy = mvs_y[t][i - 1];
                if (t > 0) {
                    left_dx -= mvs_x[t - 1][i - 1];
                    left_dy -= mvs_y[t - 1][i - 1];
                }
                dx -= left_dx;
                dy -= left_dy;
            }

            // Write differentially encoded MVs
            if (bytes_written + 4 > buffer_capacity) return 0;
            memcpy(output_buffer + bytes_written, &dx, sizeof(int16_t));
            bytes_written += sizeof(int16_t);
            memcpy(output_buffer + bytes_written, &dy, sizeof(int16_t));
            bytes_written += sizeof(int16_t);
        }
    }

    return bytes_written;
}

// =============================================================================
// MPEG-Style Motion Estimation and Residual Coding
// =============================================================================

// Bilinear interpolation for sub-pixel motion compensation
// x, y are in pixel coordinates (not 1/4-pixel units)
static float interpolate_subpixel(const float *frame, int width, int height, float x, float y) {
    // Clamp input coordinates to valid range
    if (x < 0.0f) x = 0.0f;
    if (y < 0.0f) y = 0.0f;
    if (x >= width - 1) x = width - 1.001f;  // Leave tiny margin for float precision
    if (y >= height - 1) y = height - 1.001f;

    int x0 = (int)x;
    int y0 = (int)y;
    int x1 = x0 + 1;
    int y1 = y0 + 1;

    // Double-check bounds (should be safe after clamping above)
    if (x1 >= width) x1 = width - 1;
    if (y1 >= height) y1 = height - 1;

    float fx = x - (float)x0;
    float fy = y - (float)y0;

    // Bilinear interpolation
    float p00 = frame[y0 * width + x0];
    float p10 = frame[y0 * width + x1];
    float p01 = frame[y1 * width + x0];
    float p11 = frame[y1 * width + x1];

    float p0 = p00 * (1.0f - fx) + p10 * fx;
    float p1 = p01 * (1.0f - fx) + p11 * fx;

    return p0 * (1.0f - fy) + p1 * fy;
}

// Helper function: compute median of three values (for MV prediction)
static int16_t median3(int16_t a, int16_t b, int16_t c) {
    if (a > b) {
        if (b > c) return b;
        else if (a > c) return c;
        else return a;
    } else {
        if (a > c) return a;
        else if (b > c) return c;
        else return b;
    }
}

// Perform motion estimation for entire frame using dense optical flow
// Fills residual_coding_motion_vectors_x and residual_coding_motion_vectors_y arrays
// Uses OpenCV Farneback optical flow for spatially coherent motion estimation
static void estimate_motion(tav_encoder_t *enc) {
    // Use dense optical flow from OpenCV (C++ function)
    // This computes flow at every pixel then samples at block centers
    // Much more spatially coherent than independent block matching
    estimate_optical_flow_motion(
        enc->current_frame_y,
        enc->residual_coding_reference_frame_y,
        enc->width, enc->height,
        enc->residual_coding_block_size,
        enc->residual_coding_motion_vectors_x,
        enc->residual_coding_motion_vectors_y
    );
}

// Bidirectional motion estimation for B-frames
// Computes both forward MVs (to previous ref) and backward MVs (to next ref)
static void estimate_motion_bidirectional(tav_encoder_t *enc,
                                          int16_t *fwd_mv_x, int16_t *fwd_mv_y,
                                          int16_t *bwd_mv_x, int16_t *bwd_mv_y) {
    // Forward motion: current → previous reference (I or P frame)
    estimate_optical_flow_motion(
        enc->current_frame_y,
        enc->residual_coding_reference_frame_y,  // Previous reference
        enc->width, enc->height,
        enc->residual_coding_block_size,
        fwd_mv_x,
        fwd_mv_y
    );

    // Backward motion: current → next reference (P frame)
    estimate_optical_flow_motion(
        enc->current_frame_y,
        enc->next_residual_coding_reference_frame_y,  // Next reference (future P-frame)
        enc->width, enc->height,
        enc->residual_coding_block_size,
        bwd_mv_x,
        bwd_mv_y
    );
}

// Apply motion compensation to a single block (for bidirectional prediction)
// Copies pixels from reference frame to predicted frame using motion vector
static void apply_motion_compensation_to_block(
    const float *reference_y, const float *reference_co, const float *reference_cg,
    float *predicted_y, float *predicted_co, float *predicted_cg,
    int width, int height, int block_size,
    int block_x, int block_y,
    int16_t mv_x, int16_t mv_y) {

    // Convert motion vector from 1/4-pixel units to float pixels
    float dx = mv_x / 4.0f;
    float dy = mv_y / 4.0f;

    // Apply motion compensation to each pixel in the block
    for (int y = 0; y < block_size; y++) {
        for (int x = 0; x < block_size; x++) {
            int curr_x = block_x * block_size + x;
            int curr_y = block_y * block_size + y;

            // Boundary check
            if (curr_x >= width || curr_y >= height) continue;

            // Reference position with motion vector
            float ref_x = curr_x + dx;
            float ref_y = curr_y + dy;

            // Get predicted values with sub-pixel interpolation
            int pixel_idx = curr_y * width + curr_x;
            predicted_y[pixel_idx] = interpolate_subpixel(reference_y, width, height, ref_x, ref_y);
            predicted_co[pixel_idx] = interpolate_subpixel(reference_co, width, height, ref_x, ref_y);
            predicted_cg[pixel_idx] = interpolate_subpixel(reference_cg, width, height, ref_x, ref_y);
        }
    }
}

// Generate bidirectional prediction by combining forward and backward predictions
// Uses 50/50 weighting (can be enhanced with adaptive weighting later)
// For B-frames: predicted = (forward_prediction + backward_prediction) / 2
static void generate_bidirectional_prediction(
    tav_encoder_t *enc,
    const int16_t *fwd_mv_x, const int16_t *fwd_mv_y,
    const int16_t *bwd_mv_x, const int16_t *bwd_mv_y,
    float *predicted_y, float *predicted_co, float *predicted_cg) {

    int width = enc->width;
    int height = enc->height;
    int residual_coding_num_blocks_x = width / enc->residual_coding_block_size;
    int residual_coding_num_blocks_y = height / enc->residual_coding_block_size;

    // Allocate temporary buffers for forward and backward predictions
    float *fwd_pred_y = malloc(width * height * sizeof(float));
    float *fwd_pred_co = malloc(width * height * sizeof(float));
    float *fwd_pred_cg = malloc(width * height * sizeof(float));
    float *bwd_pred_y = malloc(width * height * sizeof(float));
    float *bwd_pred_co = malloc(width * height * sizeof(float));
    float *bwd_pred_cg = malloc(width * height * sizeof(float));

    if (!fwd_pred_y || !fwd_pred_co || !fwd_pred_cg ||
        !bwd_pred_y || !bwd_pred_co || !bwd_pred_cg) {
        fprintf(stderr, "Error: Failed to allocate memory for bidirectional prediction\n");
        free(fwd_pred_y); free(fwd_pred_co); free(fwd_pred_cg);
        free(bwd_pred_y); free(bwd_pred_co); free(bwd_pred_cg);
        return;
    }

    // Generate forward prediction: motion-compensated from previous reference
    for (int by = 0; by < residual_coding_num_blocks_y; by++) {
        for (int bx = 0; bx < residual_coding_num_blocks_x; bx++) {
            int block_idx = by * residual_coding_num_blocks_x + bx;
            int16_t mv_x = fwd_mv_x[block_idx];
            int16_t mv_y = fwd_mv_y[block_idx];

            // Apply motion compensation to this block using previous reference
            apply_motion_compensation_to_block(
                enc->residual_coding_reference_frame_y, enc->residual_coding_reference_frame_co, enc->residual_coding_reference_frame_cg,
                fwd_pred_y, fwd_pred_co, fwd_pred_cg,
                width, height, enc->residual_coding_block_size,
                bx, by, mv_x, mv_y
            );
        }
    }

    // Generate backward prediction: motion-compensated from next reference
    for (int by = 0; by < residual_coding_num_blocks_y; by++) {
        for (int bx = 0; bx < residual_coding_num_blocks_x; bx++) {
            int block_idx = by * residual_coding_num_blocks_x + bx;
            int16_t mv_x = bwd_mv_x[block_idx];
            int16_t mv_y = bwd_mv_y[block_idx];

            // Apply motion compensation to this block using next reference
            apply_motion_compensation_to_block(
                enc->next_residual_coding_reference_frame_y, enc->next_residual_coding_reference_frame_co, enc->next_residual_coding_reference_frame_cg,
                bwd_pred_y, bwd_pred_co, bwd_pred_cg,
                width, height, enc->residual_coding_block_size,
                bx, by, mv_x, mv_y
            );
        }
    }

    // Combine predictions with 50/50 weighting
    for (int i = 0; i < width * height; i++) {
        predicted_y[i] = (fwd_pred_y[i] + bwd_pred_y[i]) / 2.0f;
        predicted_co[i] = (fwd_pred_co[i] + bwd_pred_co[i]) / 2.0f;
        predicted_cg[i] = (fwd_pred_cg[i] + bwd_pred_cg[i]) / 2.0f;
    }

    // Free temporary buffers
    free(fwd_pred_y); free(fwd_pred_co); free(fwd_pred_cg);
    free(bwd_pred_y); free(bwd_pred_co); free(bwd_pred_cg);
}

// Spatial motion vector prediction with differential coding
// Predicts each block's MV from neighbors (left, top, top-right) using median
// Converts absolute MVs to differential MVs for better compression
// This enforces spatial coherence and is standard MPEG practice
static void apply_mv_prediction(int16_t *mvs_x, int16_t *mvs_y,
                                int residual_coding_num_blocks_x, int residual_coding_num_blocks_y) {
    // We'll store the original MVs temporarily
    int total_blocks = residual_coding_num_blocks_x * residual_coding_num_blocks_y;
    int16_t *orig_mvs_x = malloc(total_blocks * sizeof(int16_t));
    int16_t *orig_mvs_y = malloc(total_blocks * sizeof(int16_t));

    if (!orig_mvs_x || !orig_mvs_y) {
        fprintf(stderr, "Error: Failed to allocate memory for MV prediction\n");
        free(orig_mvs_x);
        free(orig_mvs_y);
        return;
    }

    // Copy original MVs
    memcpy(orig_mvs_x, mvs_x, total_blocks * sizeof(int16_t));
    memcpy(orig_mvs_y, mvs_y, total_blocks * sizeof(int16_t));

    // Process each block in raster scan order
    for (int by = 0; by < residual_coding_num_blocks_y; by++) {
        for (int bx = 0; bx < residual_coding_num_blocks_x; bx++) {
            int block_idx = by * residual_coding_num_blocks_x + bx;

            // Get original MV for this block
            int16_t mv_x = orig_mvs_x[block_idx];
            int16_t mv_y = orig_mvs_y[block_idx];

            // Predict MV from spatial neighbors using median
            int16_t pred_x = 0, pred_y = 0;

            // Get neighbor indices (if they exist)
            int has_left = (bx > 0);
            int has_top = (by > 0);
            int has_top_right = (bx < residual_coding_num_blocks_x - 1 && by > 0);

            int left_idx = by * residual_coding_num_blocks_x + (bx - 1);
            int top_idx = (by - 1) * residual_coding_num_blocks_x + bx;
            int top_right_idx = (by - 1) * residual_coding_num_blocks_x + (bx + 1);

            // Standard MPEG median prediction
            if (has_left && has_top && has_top_right) {
                // All three neighbors available: use median
                pred_x = median3(orig_mvs_x[left_idx],
                               orig_mvs_x[top_idx],
                               orig_mvs_x[top_right_idx]);
                pred_y = median3(orig_mvs_y[left_idx],
                               orig_mvs_y[top_idx],
                               orig_mvs_y[top_right_idx]);
            } else if (has_left && has_top) {
                // Left and top available: use average
                pred_x = (orig_mvs_x[left_idx] + orig_mvs_x[top_idx]) / 2;
                pred_y = (orig_mvs_y[left_idx] + orig_mvs_y[top_idx]) / 2;
            } else if (has_left) {
                // Only left available
                pred_x = orig_mvs_x[left_idx];
                pred_y = orig_mvs_y[left_idx];
            } else if (has_top) {
                // Only top available
                pred_x = orig_mvs_x[top_idx];
                pred_y = orig_mvs_y[top_idx];
            }
            // else: no neighbors, prediction remains (0, 0)

            // Store differential MV = actual - predicted
            mvs_x[block_idx] = mv_x - pred_x;
            mvs_y[block_idx] = mv_y - pred_y;
        }
    }

    free(orig_mvs_x);
    free(orig_mvs_y);
}

// Generate motion-compensated prediction for a single channel
// Uses motion vectors to copy blocks from reference frame with sub-pixel accuracy
static void generate_prediction_channel(const float *reference, float *predicted,
                                       const int16_t *mvs_x, const int16_t *mvs_y,
                                       int width, int height,
                                       int residual_coding_num_blocks_x, int residual_coding_num_blocks_y,
                                       int block_size) {
    for (int by = 0; by < residual_coding_num_blocks_y; by++) {
        for (int bx = 0; bx < residual_coding_num_blocks_x; bx++) {
            int block_idx = by * residual_coding_num_blocks_x + bx;
            int16_t mv_x = mvs_x[block_idx];  // In 1/4-pixel units
            int16_t mv_y = mvs_y[block_idx];  // In 1/4-pixel units

            // Convert to float pixels
            float dx = mv_x / 4.0f;
            float dy = mv_y / 4.0f;

            // Block coordinates
            int block_start_x = bx * block_size;
            int block_start_y = by * block_size;

            // Copy block with motion compensation
            for (int y = 0; y < block_size; y++) {
                for (int x = 0; x < block_size; x++) {
                    int curr_x = block_start_x + x;
                    int curr_y = block_start_y + y;

                    // Skip if outside frame boundary
                    if (curr_x >= width || curr_y >= height) continue;

                    // Reference position with motion vector
                    float ref_x = curr_x + dx;
                    float ref_y = curr_y + dy;

                    // Get predicted value with sub-pixel interpolation
                    float pred_val = interpolate_subpixel(reference, width, height, ref_x, ref_y);

                    predicted[curr_y * width + curr_x] = pred_val;
                }
            }
        }
    }
}

// Generate motion-compensated prediction for all channels
static void generate_prediction(tav_encoder_t *enc) {
    generate_prediction_channel(enc->residual_coding_reference_frame_y, enc->residual_coding_predicted_frame_y,
                               enc->residual_coding_motion_vectors_x, enc->residual_coding_motion_vectors_y,
                               enc->width, enc->height,
                               enc->residual_coding_num_blocks_x, enc->residual_coding_num_blocks_y,
                               enc->residual_coding_block_size);

    generate_prediction_channel(enc->residual_coding_reference_frame_co, enc->residual_coding_predicted_frame_co,
                               enc->residual_coding_motion_vectors_x, enc->residual_coding_motion_vectors_y,
                               enc->width, enc->height,
                               enc->residual_coding_num_blocks_x, enc->residual_coding_num_blocks_y,
                               enc->residual_coding_block_size);

    generate_prediction_channel(enc->residual_coding_reference_frame_cg, enc->residual_coding_predicted_frame_cg,
                               enc->residual_coding_motion_vectors_x, enc->residual_coding_motion_vectors_y,
                               enc->width, enc->height,
                               enc->residual_coding_num_blocks_x, enc->residual_coding_num_blocks_y,
                               enc->residual_coding_block_size);
}

// Compute residual = current - predicted for all channels
static void compute_residual(tav_encoder_t *enc) {
    size_t frame_size = enc->width * enc->height;

    for (size_t i = 0; i < frame_size; i++) {
        enc->residual_coding_residual_frame_y[i] = enc->current_frame_y[i] - enc->residual_coding_predicted_frame_y[i];
        enc->residual_coding_residual_frame_co[i] = enc->current_frame_co[i] - enc->residual_coding_predicted_frame_co[i];
        enc->residual_coding_residual_frame_cg[i] = enc->current_frame_cg[i] - enc->residual_coding_predicted_frame_cg[i];
    }
}

// Detect skip blocks (small motion + low residual energy)
// Skip blocks don't encode residuals, saving bits in static regions
static int detect_residual_coding_skip_blocks(tav_encoder_t *enc) {
    int skip_count = 0;

    // Thresholds (tunable parameters)
    const float MV_THRESHOLD = 2.0f;        // 0.5 pixels in 1/4-pixel units
    const float ENERGY_THRESHOLD = 50.0f;   // Sum of squared residuals per block

    for (int by = 0; by < enc->residual_coding_num_blocks_y; by++) {
        for (int bx = 0; bx < enc->residual_coding_num_blocks_x; bx++) {
            int block_idx = by * enc->residual_coding_num_blocks_x + bx;

            // Check motion vector magnitude
            int16_t mv_x = enc->residual_coding_motion_vectors_x[block_idx];
            int16_t mv_y = enc->residual_coding_motion_vectors_y[block_idx];
            float mv_mag = sqrtf((mv_x * mv_x + mv_y * mv_y) / 16.0f);  // Convert from 1/4-pixel units

            // Check residual energy for this block
            float energy = 0.0f;
            int block_start_x = bx * enc->residual_coding_block_size;
            int block_start_y = by * enc->residual_coding_block_size;

            for (int y = 0; y < enc->residual_coding_block_size; y++) {
                for (int x = 0; x < enc->residual_coding_block_size; x++) {
                    int px = block_start_x + x;
                    int py = block_start_y + y;

                    if (px >= enc->width || py >= enc->height) continue;

                    int idx = py * enc->width + px;
                    float res_y = enc->residual_coding_residual_frame_y[idx];
                    float res_co = enc->residual_coding_residual_frame_co[idx];
                    float res_cg = enc->residual_coding_residual_frame_cg[idx];

                    energy += res_y * res_y + res_co * res_co + res_cg * res_cg;
                }
            }

            // Mark as skip if both conditions met
            if (mv_mag < MV_THRESHOLD && energy < ENERGY_THRESHOLD) {
                enc->residual_coding_skip_blocks[block_idx] = 1;
                skip_count++;

                // Zero out residuals for this block (won't be encoded after DWT)
                for (int y = 0; y < enc->residual_coding_block_size; y++) {
                    for (int x = 0; x < enc->residual_coding_block_size; x++) {
                        int px = block_start_x + x;
                        int py = block_start_y + y;

                        if (px >= enc->width || py >= enc->height) continue;

                        int idx = py * enc->width + px;
                        enc->residual_coding_residual_frame_y[idx] = 0.0f;
                        enc->residual_coding_residual_frame_co[idx] = 0.0f;
                        enc->residual_coding_residual_frame_cg[idx] = 0.0f;
                    }
                }
            } else {
                enc->residual_coding_skip_blocks[block_idx] = 0;
            }
        }
    }

    return skip_count;
}

// Update reference frame (store current frame for next P-frame)
static void update_reference_frame(tav_encoder_t *enc) {
    size_t frame_size = enc->width * enc->height;

    memcpy(enc->residual_coding_reference_frame_y, enc->current_frame_y, frame_size * sizeof(float));
    memcpy(enc->residual_coding_reference_frame_co, enc->current_frame_co, frame_size * sizeof(float));
    memcpy(enc->residual_coding_reference_frame_cg, enc->current_frame_cg, frame_size * sizeof(float));

    enc->residual_coding_reference_frame_allocated = 1;
}

// ===========================
// B-Frame Buffering Functions
// ===========================

// Allocate lookahead buffer for B-frame encoding
// Buffer size = M+1 (M B-frames + 1 next reference frame)
static int allocate_lookahead_buffer(tav_encoder_t *enc) {
    if (!enc->residual_coding_enable_bframes || enc->residual_coding_bframe_count == 0) {
        return 0;  // B-frames disabled, no buffer needed
    }

    // Capacity = M B-frames + 1 reference frame
    enc->residual_coding_lookahead_buffer_capacity = enc->residual_coding_bframe_count + 1;
    size_t frame_size = enc->width * enc->height;

    // Allocate buffer arrays
    enc->residual_coding_lookahead_buffer_y = calloc(enc->residual_coding_lookahead_buffer_capacity, sizeof(float*));
    enc->residual_coding_lookahead_buffer_co = calloc(enc->residual_coding_lookahead_buffer_capacity, sizeof(float*));
    enc->residual_coding_lookahead_buffer_cg = calloc(enc->residual_coding_lookahead_buffer_capacity, sizeof(float*));
    enc->residual_coding_lookahead_buffer_display_index = calloc(enc->residual_coding_lookahead_buffer_capacity, sizeof(int));

    if (!enc->residual_coding_lookahead_buffer_y || !enc->residual_coding_lookahead_buffer_co ||
        !enc->residual_coding_lookahead_buffer_cg || !enc->residual_coding_lookahead_buffer_display_index) {
        fprintf(stderr, "Error: Failed to allocate lookahead buffer arrays\n");
        return -1;
    }

    // Allocate individual frame buffers
    for (int i = 0; i < enc->residual_coding_lookahead_buffer_capacity; i++) {
        enc->residual_coding_lookahead_buffer_y[i] = malloc(frame_size * sizeof(float));
        enc->residual_coding_lookahead_buffer_co[i] = malloc(frame_size * sizeof(float));
        enc->residual_coding_lookahead_buffer_cg[i] = malloc(frame_size * sizeof(float));

        if (!enc->residual_coding_lookahead_buffer_y[i] || !enc->residual_coding_lookahead_buffer_co[i] ||
            !enc->residual_coding_lookahead_buffer_cg[i]) {
            fprintf(stderr, "Error: Failed to allocate lookahead buffer frame %d\n", i);
            return -1;
        }
    }

    enc->residual_coding_lookahead_buffer_count = 0;
    return 0;
}

// Add current frame to lookahead buffer
// Returns 0 if buffer not full yet, 1 if buffer is now full and ready to encode
static int add_frame_to_buffer(tav_encoder_t *enc, int display_index) {
    if (!enc->residual_coding_enable_bframes || enc->residual_coding_lookahead_buffer_capacity == 0) {
        return 1;  // No buffering, encode immediately
    }

    if (enc->residual_coding_lookahead_buffer_count >= enc->residual_coding_lookahead_buffer_capacity) {
        fprintf(stderr, "Error: Lookahead buffer overflow\n");
        return -1;
    }

    // Copy current frame to buffer
    size_t frame_size = enc->width * enc->height;
    int buf_idx = enc->residual_coding_lookahead_buffer_count;

    memcpy(enc->residual_coding_lookahead_buffer_y[buf_idx], enc->current_frame_y, frame_size * sizeof(float));
    memcpy(enc->residual_coding_lookahead_buffer_co[buf_idx], enc->current_frame_co, frame_size * sizeof(float));
    memcpy(enc->residual_coding_lookahead_buffer_cg[buf_idx], enc->current_frame_cg, frame_size * sizeof(float));
    enc->residual_coding_lookahead_buffer_display_index[buf_idx] = display_index;

    enc->residual_coding_lookahead_buffer_count++;

    // Return 1 if buffer is full (ready to start encoding)
    return (enc->residual_coding_lookahead_buffer_count >= enc->residual_coding_lookahead_buffer_capacity) ? 1 : 0;
}

// Get frame from buffer by buffer index (not display index)
// Loads the frame into enc->current_frame_* buffers
static void load_frame_from_buffer(tav_encoder_t *enc, int buffer_index) {
    if (buffer_index < 0 || buffer_index >= enc->residual_coding_lookahead_buffer_count) {
        fprintf(stderr, "Error: Invalid buffer index %d (count=%d)\n",
                buffer_index, enc->residual_coding_lookahead_buffer_count);
        return;
    }

    size_t frame_size = enc->width * enc->height;
    memcpy(enc->current_frame_y, enc->residual_coding_lookahead_buffer_y[buffer_index], frame_size * sizeof(float));
    memcpy(enc->current_frame_co, enc->residual_coding_lookahead_buffer_co[buffer_index], frame_size * sizeof(float));
    memcpy(enc->current_frame_cg, enc->residual_coding_lookahead_buffer_cg[buffer_index], frame_size * sizeof(float));
}

// Shift buffer contents (remove first frame, shift others down)
// Used after encoding a group of frames to make room for new frames
static void shift_buffer(tav_encoder_t *enc, int num_frames_to_remove) {
    if (num_frames_to_remove <= 0 || num_frames_to_remove > enc->residual_coding_lookahead_buffer_count) {
        return;
    }

    size_t frame_size = enc->width * enc->height;

    // Shift frames down
    for (int i = num_frames_to_remove; i < enc->residual_coding_lookahead_buffer_count; i++) {
        int src_idx = i;
        int dst_idx = i - num_frames_to_remove;

        memcpy(enc->residual_coding_lookahead_buffer_y[dst_idx], enc->residual_coding_lookahead_buffer_y[src_idx], frame_size * sizeof(float));
        memcpy(enc->residual_coding_lookahead_buffer_co[dst_idx], enc->residual_coding_lookahead_buffer_co[src_idx], frame_size * sizeof(float));
        memcpy(enc->residual_coding_lookahead_buffer_cg[dst_idx], enc->residual_coding_lookahead_buffer_cg[src_idx], frame_size * sizeof(float));
        enc->residual_coding_lookahead_buffer_display_index[dst_idx] = enc->residual_coding_lookahead_buffer_display_index[src_idx];
    }

    enc->residual_coding_lookahead_buffer_count -= num_frames_to_remove;
}

// ===========================
// P-Frame and B-Frame Encoding
// ===========================

// Encode and write P-frame with MPEG-style residual coding (packet type 0x14)
// Returns total packet size (including header and compressed data)
static size_t encode_pframe_residual(tav_encoder_t *enc, int qY) {

    // Step 1: Motion estimation
    estimate_motion(enc);

    // Step 2: Generate motion-compensated prediction
    generate_prediction(enc);

    // Step 3: Compute residual
    compute_residual(enc);

    // Step 3.5: Detect skip blocks (small motion + low energy)
    // Zeros out residuals for skip blocks to save bits
    int skip_count = detect_residual_coding_skip_blocks(enc);

    // Optional: Print skip statistics every N frames
    if (enc->verbose && enc->frame_count % 30 == 0) {
        int total_blocks = enc->residual_coding_num_blocks_x * enc->residual_coding_num_blocks_y;
        fprintf(stderr, "Frame %d: %d/%d blocks skipped (%.1f%%)\n",
                enc->frame_count, skip_count, total_blocks,
                100.0f * skip_count / total_blocks);
    }

    // Step 4: Apply DWT to residual (monoblock mode only for now)
    if (!enc->monoblock) {
        fprintf(stderr, "Error: Residual coding currently requires monoblock mode\n");
        return 0;
    }

    size_t frame_size = enc->width * enc->height;

    // Create temporary buffers for DWT-transformed residuals
    float *residual_y_dwt = malloc(frame_size * sizeof(float));
    float *residual_co_dwt = malloc(frame_size * sizeof(float));
    float *residual_cg_dwt = malloc(frame_size * sizeof(float));

    memcpy(residual_y_dwt, enc->residual_coding_residual_frame_y, frame_size * sizeof(float));
    memcpy(residual_co_dwt, enc->residual_coding_residual_frame_co, frame_size * sizeof(float));
    memcpy(residual_cg_dwt, enc->residual_coding_residual_frame_cg, frame_size * sizeof(float));

    // Apply 2D DWT to residuals
    dwt_2d_forward_flexible(enc, residual_y_dwt, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
    dwt_2d_forward_flexible(enc, residual_co_dwt, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
    dwt_2d_forward_flexible(enc, residual_cg_dwt, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);

    // Step 5: Quantise residual coefficients (skip for EZBC - it handles quantisation implicitly)
    int16_t *quantised_y = enc->reusable_quantised_y;
    int16_t *quantised_co = enc->reusable_quantised_co;
    int16_t *quantised_cg = enc->reusable_quantised_cg;

    if (enc->preprocess_mode == PREPROCESS_EZBC) {
        // EZBC mode: Quantise with perceptual weighting but no normalisation (division by quantiser)
        // EZBC will compress by encoding only significant bitplanes
//        fprintf(stderr, "[EZBC-QUANT-PFRAME] Using perceptual quantisation without normalisation\n");
        quantise_dwt_coefficients_perceptual_per_coeff_no_normalisation(enc, residual_y_dwt, quantised_y, frame_size,
                                                      qY, enc->width, enc->height,
                                                      enc->decomp_levels, 0, 0);
        quantise_dwt_coefficients_perceptual_per_coeff_no_normalisation(enc, residual_co_dwt, quantised_co, frame_size,
                                                      enc->quantiser_co, enc->width, enc->height,
                                                      enc->decomp_levels, 1, 0);
        quantise_dwt_coefficients_perceptual_per_coeff_no_normalisation(enc, residual_cg_dwt, quantised_cg, frame_size,
                                                      enc->quantiser_cg, enc->width, enc->height,
                                                      enc->decomp_levels, 1, 0);

        // Print max abs for debug
        int max_y = 0, max_co = 0, max_cg = 0;
        for (int i = 0; i < frame_size; i++) {
            if (abs(quantised_y[i]) > max_y) max_y = abs(quantised_y[i]);
            if (abs(quantised_co[i]) > max_co) max_co = abs(quantised_co[i]);
            if (abs(quantised_cg[i]) > max_cg) max_cg = abs(quantised_cg[i]);
        }
//        fprintf(stderr, "[EZBC-QUANT-PFRAME] Quantised coeff max: Y=%d, Co=%d, Cg=%d\n", max_y, max_co, max_cg);
    } else {
        // Twobit-map mode: Use traditional quantisation
        quantise_dwt_coefficients_perceptual_per_coeff(enc, residual_y_dwt, quantised_y, frame_size,
                                                      qY, enc->width, enc->height,
                                                      enc->decomp_levels, 0, 0);
        quantise_dwt_coefficients_perceptual_per_coeff(enc, residual_co_dwt, quantised_co, frame_size,
                                                      enc->quantiser_co, enc->width, enc->height,
                                                      enc->decomp_levels, 1, 0);
        quantise_dwt_coefficients_perceptual_per_coeff(enc, residual_cg_dwt, quantised_cg, frame_size,
                                                      enc->quantiser_cg, enc->width, enc->height,
                                                      enc->decomp_levels, 1, 0);
    }

    // Step 6: Preprocess coefficients (significance map compression)
    int total_coeffs = frame_size * 3;  // Y + Co + Cg
    uint8_t *preprocessed = malloc(total_coeffs * sizeof(int16_t) + 1024);  // Extra space for map
    size_t preprocessed_size = preprocess_coefficients_variable_layout(enc->preprocess_mode, enc->width, enc->height,
                                                                       quantised_y, quantised_co, quantised_cg,
                                                                       NULL, frame_size, enc->channel_layout,
                                                                       preprocessed);

    // Step 7: Compress preprocessed coefficients with Zstd
    size_t compressed_bound = ZSTD_compressBound(preprocessed_size);
    uint8_t *compressed_coeffs = malloc(compressed_bound);
    size_t compressed_size = ZSTD_compressCCtx(enc->zstd_ctx, compressed_coeffs, compressed_bound,
                                               preprocessed, preprocessed_size, enc->zstd_level);

    if (ZSTD_isError(compressed_size)) {
        fprintf(stderr, "Error: Zstd compression failed for P-frame residual\n");
        free(residual_y_dwt);
        free(residual_co_dwt);
        free(residual_cg_dwt);
        free(preprocessed);
        free(compressed_coeffs);
        return 0;
    }

    // Step 7.5: Apply spatial MV prediction to convert to differential MVs
    // This must be done AFTER prediction but BEFORE writing to file
    // Improves compression and enforces spatial coherence
    apply_mv_prediction(enc->residual_coding_motion_vectors_x, enc->residual_coding_motion_vectors_y,
                       enc->residual_coding_num_blocks_x, enc->residual_coding_num_blocks_y);

    // Step 8: Write P-frame packet
    // Packet format: [type=0x14][num_blocks:uint16][mvs_x][mvs_y][compressed_size:uint32][compressed_data]
    // Note: MVs are now differential (predicted from neighbors)

    uint8_t packet_type = TAV_PACKET_PFRAME_RESIDUAL;
    int total_blocks = enc->residual_coding_num_blocks_x * enc->residual_coding_num_blocks_y;
    uint16_t num_blocks = (uint16_t)total_blocks;
    uint32_t compressed_size_u32 = (uint32_t)compressed_size;

    // Write packet header
    fwrite(&packet_type, 1, 1, enc->output_fp);
    fwrite(&num_blocks, sizeof(uint16_t), 1, enc->output_fp);

    // Write motion vectors
    fwrite(enc->residual_coding_motion_vectors_x, sizeof(int16_t), total_blocks, enc->output_fp);
    fwrite(enc->residual_coding_motion_vectors_y, sizeof(int16_t), total_blocks, enc->output_fp);

    // Write compressed size and data
    fwrite(&compressed_size_u32, sizeof(uint32_t), 1, enc->output_fp);
    fwrite(compressed_coeffs, 1, compressed_size, enc->output_fp);

    // Calculate total packet size
    size_t packet_size = 1 + sizeof(uint16_t) + (total_blocks * 2 * sizeof(int16_t)) +
                        sizeof(uint32_t) + compressed_size;

    // Cleanup
    free(residual_y_dwt);
    free(residual_co_dwt);
    free(residual_cg_dwt);
    free(preprocessed);
    free(compressed_coeffs);

    if (enc->verbose) {
        printf("  P-frame: %d blocks, %d MVs, residual: %zu → %zu bytes (%.1f%%)\n",
               total_blocks, total_blocks * 2, preprocessed_size, compressed_size,
               (compressed_size * 100.0f) / preprocessed_size);
    }

    return packet_size;
}

// Encode and write P-frame with adaptive quad-tree blocks (packet type 0x16)
// Returns total packet size (including header and compressed data)
static size_t encode_pframe_adaptive(tav_encoder_t *enc, int qY) {

    int saved_block_size = enc->residual_coding_block_size;

    // Save original MV arrays
    int16_t *orig_mv_x = enc->residual_coding_motion_vectors_x;
    int16_t *orig_mv_y = enc->residual_coding_motion_vectors_y;
    int orig_blocks_x = enc->residual_coding_num_blocks_x;
    int orig_blocks_y = enc->residual_coding_num_blocks_y;

    int16_t *fine_mv_x = NULL;
    int16_t *fine_mv_y = NULL;
    int fine_blocks_x = 0;
    int fine_blocks_y = 0;

#if FINE_GRAINED_OPTICAL_FLOW
    // === BOTTOM-UP APPROACH: Fine-grained optical flow + merging ===
    // Step 1: Motion estimation at min block size (4×4)
    enc->residual_coding_block_size = enc->residual_coding_min_block_size;
    fine_blocks_x = (enc->width + enc->residual_coding_min_block_size - 1) / enc->residual_coding_min_block_size;
    fine_blocks_y = (enc->height + enc->residual_coding_min_block_size - 1) / enc->residual_coding_min_block_size;
    int fine_total_blocks = fine_blocks_x * fine_blocks_y;

    fine_mv_x = malloc(fine_total_blocks * sizeof(int16_t));
    fine_mv_y = malloc(fine_total_blocks * sizeof(int16_t));

    enc->residual_coding_motion_vectors_x = fine_mv_x;
    enc->residual_coding_motion_vectors_y = fine_mv_y;
    enc->residual_coding_num_blocks_x = fine_blocks_x;
    enc->residual_coding_num_blocks_y = fine_blocks_y;

    estimate_motion(enc);

    // Step 2-3: Generate prediction and compute residual using fine-grained MVs
    generate_prediction(enc);
    compute_residual(enc);

#else
    // === TOP-DOWN APPROACH: Coarse optical flow + variance-based splitting ===
    // Step 1: Motion estimation at max block size (64×64)
    enc->residual_coding_block_size = enc->residual_coding_max_block_size;
    int max_blocks_x = (enc->width + enc->residual_coding_max_block_size - 1) / enc->residual_coding_max_block_size;
    int max_blocks_y = (enc->height + enc->residual_coding_max_block_size - 1) / enc->residual_coding_max_block_size;
    int max_total_blocks = max_blocks_x * max_blocks_y;

    int16_t *temp_mv_x = malloc(max_total_blocks * sizeof(int16_t));
    int16_t *temp_mv_y = malloc(max_total_blocks * sizeof(int16_t));

    enc->residual_coding_motion_vectors_x = temp_mv_x;
    enc->residual_coding_motion_vectors_y = temp_mv_y;
    enc->residual_coding_num_blocks_x = max_blocks_x;
    enc->residual_coding_num_blocks_y = max_blocks_y;

    estimate_motion(enc);

    // Step 2-3: Generate prediction and compute residual using coarse MVs
    generate_prediction(enc);
    compute_residual(enc);
#endif

    // Step 4: Build quad-tree forest
    int num_tree_cols = (enc->width + enc->residual_coding_max_block_size - 1) / enc->residual_coding_max_block_size;
    int num_tree_rows = (enc->height + enc->residual_coding_max_block_size - 1) / enc->residual_coding_max_block_size;
    int total_trees = num_tree_cols * num_tree_rows;

    quad_tree_node_t **tree_forest = malloc(total_trees * sizeof(quad_tree_node_t*));

    for (int ty = 0; ty < num_tree_rows; ty++) {
        for (int tx = 0; tx < num_tree_cols; tx++) {
            int tree_idx = ty * num_tree_cols + tx;
            int x = tx * enc->residual_coding_max_block_size;
            int y = ty * enc->residual_coding_max_block_size;

#if FINE_GRAINED_OPTICAL_FLOW
            // Bottom-up: Build tree by merging fine-grained blocks
            tree_forest[tree_idx] = build_quad_tree_bottom_up(
                fine_mv_x, fine_mv_y,
                enc->residual_coding_residual_frame_y,
                enc->residual_coding_residual_frame_co,
                enc->residual_coding_residual_frame_cg,
                enc->width, enc->height,
                x, y, enc->residual_coding_max_block_size,
                enc->residual_coding_min_block_size, enc->residual_coding_max_block_size,
                fine_blocks_x
            );
#else
            // Top-down: Build tree by splitting coarse blocks based on variance
            int16_t mv_x = enc->residual_coding_motion_vectors_x[tree_idx];
            int16_t mv_y = enc->residual_coding_motion_vectors_y[tree_idx];

            // Detect if this is a skip block
            float mv_mag = sqrtf((mv_x * mv_x + mv_y * mv_y) / 16.0f);
            float energy = 0.0f;
            for (int by = 0; by < enc->residual_coding_max_block_size && y + by < enc->height; by++) {
                for (int bx = 0; bx < enc->residual_coding_max_block_size && x + bx < enc->width; bx++) {
                    int px = x + bx;
                    int py = y + by;
                    float r_y = enc->residual_coding_residual_frame_y[py * enc->width + px];
                    float r_co = enc->residual_coding_residual_frame_co[py * enc->width + px];
                    float r_cg = enc->residual_coding_residual_frame_cg[py * enc->width + px];
                    energy += r_y * r_y + r_co * r_co + r_cg * r_cg;
                }
            }
            int is_skip = (mv_mag < 0.5f && energy < 50.0f * enc->residual_coding_max_block_size * enc->residual_coding_max_block_size / (16 * 16));

            tree_forest[tree_idx] = build_quad_tree(
                enc->current_frame_y,
                enc->residual_coding_reference_frame_y,
                enc->residual_coding_residual_frame_y,
                enc->residual_coding_residual_frame_co,
                enc->residual_coding_residual_frame_cg,
                enc->width, enc->height,
                x, y, enc->residual_coding_max_block_size,
                enc->residual_coding_min_block_size,
                mv_x, mv_y,
                is_skip,
                0  // Disable per-block motion refinement
            );
#endif
        }
    }

    // Step 4.5: Recompute residuals using refined motion vectors from quad-tree
    // This gives us better residuals that compress more efficiently
    for (int i = 0; i < total_trees; i++) {
        recompute_residuals_from_tree(tree_forest[i],
                                     enc->current_frame_y, enc->current_frame_co, enc->current_frame_cg,
                                     enc->residual_coding_reference_frame_y, enc->residual_coding_reference_frame_co, enc->residual_coding_reference_frame_cg,
                                     enc->residual_coding_residual_frame_y, enc->residual_coding_residual_frame_co, enc->residual_coding_residual_frame_cg,
                                     enc->width, enc->height);
    }

    // Step 4.75: Spatial MV prediction (DISABLED - degrades compression)
    // Differential MV coding doesn't help because:
    // 1. Too little MV data for Zstd to exploit patterns (only 63 trees/frame)
    // 2. Optical flow produces smooth absolute MVs that compress well already
    // 3. Differential prediction can introduce noise if neighbors aren't perfect predictors
    // Leaving code in place for future experimentation with entropy coding
    #if 0
    int mv_blocks_x = (enc->width + enc->residual_coding_min_block_size - 1) / enc->residual_coding_min_block_size;
    int mv_blocks_y = (enc->height + enc->residual_coding_min_block_size - 1) / enc->residual_coding_min_block_size;
    int16_t *mv_map_x = malloc(mv_blocks_x * mv_blocks_y * sizeof(int16_t));
    int16_t *mv_map_y = malloc(mv_blocks_x * mv_blocks_y * sizeof(int16_t));

    build_mv_map_from_forest(tree_forest, num_tree_cols, num_tree_rows,
                             enc->residual_coding_max_block_size, enc->residual_coding_min_block_size,
                             enc->width, enc->height,
                             mv_map_x, mv_map_y);

    for (int i = 0; i < total_trees; i++) {
        apply_spatial_mv_prediction_to_tree(tree_forest[i], enc->residual_coding_min_block_size, mv_blocks_x, mv_map_x, mv_map_y);
    }

    free(mv_map_x);
    free(mv_map_y);
    #endif

    // Step 5: Serialise all quad-trees (now with differential MVs)
    // Estimate buffer size: worst case is all leaf nodes at min size
    size_t max_serialised_size = total_trees * 10000;  // Conservative estimate
    uint8_t *serialised_trees = malloc(max_serialised_size);
    size_t total_serialised = 0;

    for (int i = 0; i < total_trees; i++) {
        size_t tree_size = serialise_quad_tree(tree_forest[i], serialised_trees + total_serialised,
                                               max_serialised_size - total_serialised);
        if (tree_size == 0) {
            fprintf(stderr, "Error: Failed to serialise quad-tree %d\n", i);
            // Cleanup and return error
            for (int j = 0; j < total_trees; j++) {
                free_quad_tree(tree_forest[j]);
            }
            free(tree_forest);
#if FINE_GRAINED_OPTICAL_FLOW
            free(fine_mv_x);
            free(fine_mv_y);
#else
            free(temp_mv_x);
            free(temp_mv_y);
#endif
            free(serialised_trees);
            enc->residual_coding_block_size = saved_block_size;
            enc->residual_coding_motion_vectors_x = orig_mv_x;
            enc->residual_coding_motion_vectors_y = orig_mv_y;
            enc->residual_coding_num_blocks_x = orig_blocks_x;
            enc->residual_coding_num_blocks_y = orig_blocks_y;
            return 0;
        }
        total_serialised += tree_size;
    }

    // Step 6: Apply DWT to residual (same as fixed blocks)
    size_t frame_size = enc->width * enc->height;

    float *residual_y_dwt = malloc(frame_size * sizeof(float));
    float *residual_co_dwt = malloc(frame_size * sizeof(float));
    float *residual_cg_dwt = malloc(frame_size * sizeof(float));

    memcpy(residual_y_dwt, enc->residual_coding_residual_frame_y, frame_size * sizeof(float));
    memcpy(residual_co_dwt, enc->residual_coding_residual_frame_co, frame_size * sizeof(float));
    memcpy(residual_cg_dwt, enc->residual_coding_residual_frame_cg, frame_size * sizeof(float));

    dwt_2d_forward_flexible(enc, residual_y_dwt, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
    dwt_2d_forward_flexible(enc, residual_co_dwt, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
    dwt_2d_forward_flexible(enc, residual_cg_dwt, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);

    // Step 7: Quantise residual coefficients
    int16_t *quantised_y = enc->reusable_quantised_y;
    int16_t *quantised_co = enc->reusable_quantised_co;
    int16_t *quantised_cg = enc->reusable_quantised_cg;

    quantise_dwt_coefficients_perceptual_per_coeff(enc, residual_y_dwt, quantised_y, frame_size,
                                                  qY, enc->width, enc->height,
                                                  enc->decomp_levels, 0, 0);
    quantise_dwt_coefficients_perceptual_per_coeff(enc, residual_co_dwt, quantised_co, frame_size,
                                                  enc->quantiser_co, enc->width, enc->height,
                                                  enc->decomp_levels, 1, 0);
    quantise_dwt_coefficients_perceptual_per_coeff(enc, residual_cg_dwt, quantised_cg, frame_size,
                                                  enc->quantiser_cg, enc->width, enc->height,
                                                  enc->decomp_levels, 1, 0);

    // Step 8: Preprocess coefficients
    int total_coeffs = frame_size * 3;
    uint8_t *preprocessed = malloc(total_coeffs * sizeof(int16_t) + 1024);
    size_t preprocessed_size = preprocess_coefficients_variable_layout(enc->preprocess_mode, enc->width, enc->height,
                                                                       quantised_y, quantised_co, quantised_cg,
                                                                       NULL, frame_size, enc->channel_layout,
                                                                       preprocessed);

    // Step 9: Compress preprocessed coefficients
    size_t compressed_bound = ZSTD_compressBound(preprocessed_size);
    uint8_t *compressed_coeffs = malloc(compressed_bound);
    size_t compressed_size = ZSTD_compressCCtx(enc->zstd_ctx, compressed_coeffs, compressed_bound,
                                               preprocessed, preprocessed_size, enc->zstd_level);

    if (ZSTD_isError(compressed_size)) {
        fprintf(stderr, "Error: Zstd compression failed for adaptive P-frame\n");
        // Cleanup
        for (int i = 0; i < total_trees; i++) {
            free_quad_tree(tree_forest[i]);
        }
        free(tree_forest);
#if FINE_GRAINED_OPTICAL_FLOW
        free(fine_mv_x);
        free(fine_mv_y);
#else
        free(temp_mv_x);
        free(temp_mv_y);
#endif
        free(serialised_trees);
        free(residual_y_dwt);
        free(residual_co_dwt);
        free(residual_cg_dwt);
        free(preprocessed);
        free(compressed_coeffs);
        enc->residual_coding_block_size = saved_block_size;
        enc->residual_coding_motion_vectors_x = orig_mv_x;
        enc->residual_coding_motion_vectors_y = orig_mv_y;
        enc->residual_coding_num_blocks_x = orig_blocks_x;
        enc->residual_coding_num_blocks_y = orig_blocks_y;
        return 0;
    }

    // Step 10: Write P-frame adaptive packet
    // Packet format: [type=0x16][num_trees:uint16][tree_data_size:uint32][tree_data][compressed_size:uint32][compressed_data]

    uint8_t packet_type = TAV_PACKET_PFRAME_ADAPTIVE;
    uint16_t num_trees_u16 = (uint16_t)total_trees;
    uint32_t tree_data_size = (uint32_t)total_serialised;
    uint32_t compressed_size_u32 = (uint32_t)compressed_size;

    fwrite(&packet_type, 1, 1, enc->output_fp);
    fwrite(&num_trees_u16, sizeof(uint16_t), 1, enc->output_fp);
    fwrite(&tree_data_size, sizeof(uint32_t), 1, enc->output_fp);
    fwrite(serialised_trees, 1, total_serialised, enc->output_fp);
    fwrite(&compressed_size_u32, sizeof(uint32_t), 1, enc->output_fp);
    fwrite(compressed_coeffs, 1, compressed_size, enc->output_fp);

    size_t packet_size = 1 + sizeof(uint16_t) + sizeof(uint32_t) + total_serialised +
                        sizeof(uint32_t) + compressed_size;

    // Cleanup
    for (int i = 0; i < total_trees; i++) {
        free_quad_tree(tree_forest[i]);
    }
    free(tree_forest);
#if FINE_GRAINED_OPTICAL_FLOW
    free(fine_mv_x);
    free(fine_mv_y);
#else
    free(temp_mv_x);
    free(temp_mv_y);
#endif
    free(serialised_trees);
    free(residual_y_dwt);
    free(residual_co_dwt);
    free(residual_cg_dwt);
    free(preprocessed);
    free(compressed_coeffs);

    // Restore original state
    enc->residual_coding_block_size = saved_block_size;
    enc->residual_coding_motion_vectors_x = orig_mv_x;
    enc->residual_coding_motion_vectors_y = orig_mv_y;
    enc->residual_coding_num_blocks_x = orig_blocks_x;
    enc->residual_coding_num_blocks_y = orig_blocks_y;

    if (enc->verbose) {
        printf("  P-frame (adaptive): %d trees, tree_data: %zu bytes, residual: %zu → %zu bytes (%.1f%%)\n",
               total_trees, total_serialised, preprocessed_size, compressed_size,
               (compressed_size * 100.0f) / preprocessed_size);
    }

    return packet_size;
}

// Encode B-frame with adaptive quad-tree block partitioning and bidirectional prediction
// Uses fine-grained optical flow (4×4) for both forward and backward MVs, then merges into quad-tree
static size_t encode_bframe_adaptive(tav_encoder_t *enc, int qY) {

    int saved_block_size = enc->residual_coding_block_size;

    // Step 1: Bidirectional motion estimation at min block size (4×4)
    enc->residual_coding_block_size = enc->residual_coding_min_block_size;
    int fine_blocks_x = (enc->width + enc->residual_coding_min_block_size - 1) / enc->residual_coding_min_block_size;
    int fine_blocks_y = (enc->height + enc->residual_coding_min_block_size - 1) / enc->residual_coding_min_block_size;
    int fine_total_blocks = fine_blocks_x * fine_blocks_y;

    int16_t *fine_fwd_mv_x = malloc(fine_total_blocks * sizeof(int16_t));
    int16_t *fine_fwd_mv_y = malloc(fine_total_blocks * sizeof(int16_t));
    int16_t *fine_bwd_mv_x = malloc(fine_total_blocks * sizeof(int16_t));
    int16_t *fine_bwd_mv_y = malloc(fine_total_blocks * sizeof(int16_t));

    if (!fine_fwd_mv_x || !fine_fwd_mv_y || !fine_bwd_mv_x || !fine_bwd_mv_y) {
        fprintf(stderr, "Error: Failed to allocate memory for B-frame motion vectors\n");
        free(fine_fwd_mv_x); free(fine_fwd_mv_y);
        free(fine_bwd_mv_x); free(fine_bwd_mv_y);
        enc->residual_coding_block_size = saved_block_size;
        return 0;
    }

    // Compute bidirectional motion vectors (fine-grained)
    estimate_motion_bidirectional(enc, fine_fwd_mv_x, fine_fwd_mv_y, fine_bwd_mv_x, fine_bwd_mv_y);

    // Step 2: Generate bidirectional prediction (weighted 50/50)
    float *predicted_y = malloc(enc->width * enc->height * sizeof(float));
    float *predicted_co = malloc(enc->width * enc->height * sizeof(float));
    float *predicted_cg = malloc(enc->width * enc->height * sizeof(float));

    if (!predicted_y || !predicted_co || !predicted_cg) {
        fprintf(stderr, "Error: Failed to allocate memory for B-frame prediction\n");
        free(fine_fwd_mv_x); free(fine_fwd_mv_y);
        free(fine_bwd_mv_x); free(fine_bwd_mv_y);
        free(predicted_y); free(predicted_co); free(predicted_cg);
        enc->residual_coding_block_size = saved_block_size;
        return 0;
    }

    generate_bidirectional_prediction(enc, fine_fwd_mv_x, fine_fwd_mv_y, fine_bwd_mv_x, fine_bwd_mv_y,
                                     predicted_y, predicted_co, predicted_cg);

    // Step 3: Compute residual = current - bidirectional_prediction
    size_t frame_size = enc->width * enc->height;
    for (size_t i = 0; i < frame_size; i++) {
        enc->residual_coding_residual_frame_y[i] = enc->current_frame_y[i] - predicted_y[i];
        enc->residual_coding_residual_frame_co[i] = enc->current_frame_co[i] - predicted_co[i];
        enc->residual_coding_residual_frame_cg[i] = enc->current_frame_cg[i] - predicted_cg[i];
    }

    free(predicted_y);
    free(predicted_co);
    free(predicted_cg);

    // Step 4: Build quad-tree forest with bidirectional MVs (bottom-up merging)
    int num_tree_cols = (enc->width + enc->residual_coding_max_block_size - 1) / enc->residual_coding_max_block_size;
    int num_tree_rows = (enc->height + enc->residual_coding_max_block_size - 1) / enc->residual_coding_max_block_size;
    int total_trees = num_tree_cols * num_tree_rows;

    quad_tree_node_t **tree_forest = malloc(total_trees * sizeof(quad_tree_node_t*));

    for (int ty = 0; ty < num_tree_rows; ty++) {
        for (int tx = 0; tx < num_tree_cols; tx++) {
            int tree_idx = ty * num_tree_cols + tx;
            int x = tx * enc->residual_coding_max_block_size;
            int y = ty * enc->residual_coding_max_block_size;

            // Build bidirectional quad-tree by merging fine-grained blocks
            tree_forest[tree_idx] = build_quad_tree_bottom_up_bidirectional(
                fine_fwd_mv_x, fine_fwd_mv_y, fine_bwd_mv_x, fine_bwd_mv_y,
                enc->residual_coding_residual_frame_y,
                enc->residual_coding_residual_frame_co,
                enc->residual_coding_residual_frame_cg,
                enc->width, enc->height,
                x, y, enc->residual_coding_max_block_size,
                enc->residual_coding_min_block_size, enc->residual_coding_max_block_size,
                fine_blocks_x
            );
        }
    }

    // Note: For B-frames, we don't recompute residuals because dual predictions are already optimal

    // Step 5: Serialise all quad-trees with 64-bit leaf nodes
    size_t max_serialised_size = total_trees * 20000;  // Conservative (2× P-frame size due to dual MVs)
    uint8_t *serialised_trees = malloc(max_serialised_size);
    size_t total_serialised = 0;

    for (int i = 0; i < total_trees; i++) {
        size_t tree_size = serialise_quad_tree_bidirectional(tree_forest[i], serialised_trees + total_serialised,
                                                             max_serialised_size - total_serialised);
        if (tree_size == 0) {
            fprintf(stderr, "Error: Failed to serialise bidirectional quad-tree %d\n", i);
            // Cleanup and return error
            for (int j = 0; j < total_trees; j++) {
                free_quad_tree(tree_forest[j]);
            }
            free(tree_forest);
            free(fine_fwd_mv_x); free(fine_fwd_mv_y);
            free(fine_bwd_mv_x); free(fine_bwd_mv_y);
            free(serialised_trees);
            enc->residual_coding_block_size = saved_block_size;
            return 0;
        }
        total_serialised += tree_size;
    }

    // Step 6: Apply DWT to residual
    float *residual_y_dwt = malloc(frame_size * sizeof(float));
    float *residual_co_dwt = malloc(frame_size * sizeof(float));
    float *residual_cg_dwt = malloc(frame_size * sizeof(float));

    memcpy(residual_y_dwt, enc->residual_coding_residual_frame_y, frame_size * sizeof(float));
    memcpy(residual_co_dwt, enc->residual_coding_residual_frame_co, frame_size * sizeof(float));
    memcpy(residual_cg_dwt, enc->residual_coding_residual_frame_cg, frame_size * sizeof(float));

    dwt_2d_forward_flexible(enc, residual_y_dwt, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
    dwt_2d_forward_flexible(enc, residual_co_dwt, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
    dwt_2d_forward_flexible(enc, residual_cg_dwt, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);

    // Step 7: Quantise residual coefficients
    int16_t *quantised_y = enc->reusable_quantised_y;
    int16_t *quantised_co = enc->reusable_quantised_co;
    int16_t *quantised_cg = enc->reusable_quantised_cg;

    quantise_dwt_coefficients_perceptual_per_coeff(enc, residual_y_dwt, quantised_y, frame_size,
                                                  qY, enc->width, enc->height,
                                                  enc->decomp_levels, 0, 0);
    quantise_dwt_coefficients_perceptual_per_coeff(enc, residual_co_dwt, quantised_co, frame_size,
                                                  enc->quantiser_co, enc->width, enc->height,
                                                  enc->decomp_levels, 1, 0);
    quantise_dwt_coefficients_perceptual_per_coeff(enc, residual_cg_dwt, quantised_cg, frame_size,
                                                  enc->quantiser_cg, enc->width, enc->height,
                                                  enc->decomp_levels, 1, 0);

    // Step 8: Preprocess coefficients
    int total_coeffs = frame_size * 3;
    uint8_t *preprocessed = malloc(total_coeffs * sizeof(int16_t) + 1024);
    size_t preprocessed_size = preprocess_coefficients_variable_layout(enc->preprocess_mode, enc->width, enc->height,
                                                                       quantised_y, quantised_co, quantised_cg,
                                                                       NULL, frame_size, enc->channel_layout,
                                                                       preprocessed);

    // Step 9: Compress preprocessed coefficients
    size_t compressed_bound = ZSTD_compressBound(preprocessed_size);
    uint8_t *compressed_coeffs = malloc(compressed_bound);
    size_t compressed_size = ZSTD_compressCCtx(enc->zstd_ctx, compressed_coeffs, compressed_bound,
                                               preprocessed, preprocessed_size, enc->zstd_level);

    if (ZSTD_isError(compressed_size)) {
        fprintf(stderr, "Error: Zstd compression failed for B-frame\n");
        // Cleanup
        for (int i = 0; i < total_trees; i++) {
            free_quad_tree(tree_forest[i]);
        }
        free(tree_forest);
        free(fine_fwd_mv_x); free(fine_fwd_mv_y);
        free(fine_bwd_mv_x); free(fine_bwd_mv_y);
        free(serialised_trees);
        free(residual_y_dwt);
        free(residual_co_dwt);
        free(residual_cg_dwt);
        free(preprocessed);
        free(compressed_coeffs);
        enc->residual_coding_block_size = saved_block_size;
        return 0;
    }

    // Step 10: Write B-frame adaptive packet (0x17)
    // Packet format: [type=0x17][num_trees:uint16][tree_data_size:uint32][tree_data][compressed_size:uint32][compressed_data]

    uint8_t packet_type = TAV_PACKET_BFRAME_ADAPTIVE;
    uint16_t num_trees_u16 = (uint16_t)total_trees;
    uint32_t tree_data_size = (uint32_t)total_serialised;
    uint32_t compressed_size_u32 = (uint32_t)compressed_size;

    fwrite(&packet_type, 1, 1, enc->output_fp);
    fwrite(&num_trees_u16, sizeof(uint16_t), 1, enc->output_fp);
    fwrite(&tree_data_size, sizeof(uint32_t), 1, enc->output_fp);
    fwrite(serialised_trees, 1, total_serialised, enc->output_fp);
    fwrite(&compressed_size_u32, sizeof(uint32_t), 1, enc->output_fp);
    fwrite(compressed_coeffs, 1, compressed_size, enc->output_fp);

    size_t packet_size = 1 + sizeof(uint16_t) + sizeof(uint32_t) + total_serialised +
                        sizeof(uint32_t) + compressed_size;

    // Cleanup
    for (int i = 0; i < total_trees; i++) {
        free_quad_tree(tree_forest[i]);
    }
    free(tree_forest);
    free(fine_fwd_mv_x); free(fine_fwd_mv_y);
    free(fine_bwd_mv_x); free(fine_bwd_mv_y);
    free(serialised_trees);
    free(residual_y_dwt);
    free(residual_co_dwt);
    free(residual_cg_dwt);
    free(preprocessed);
    free(compressed_coeffs);

    // Restore original state
    enc->residual_coding_block_size = saved_block_size;

    if (enc->verbose) {
        printf("  B-frame (adaptive): %d trees, tree_data: %zu bytes, residual: %zu → %zu bytes (%.1f%%)\n",
               total_trees, total_serialised, preprocessed_size, compressed_size,
               (compressed_size * 100.0f) / preprocessed_size);
    }

    return packet_size;
}

// =============================================================================
// GOP Management Functions
// =============================================================================

// Add frame to GOP buffer
// Returns 0 on success, -1 on error
static int temporal_gop_add_frame(tav_encoder_t *enc, const uint8_t *frame_rgb,
                         const float *frame_y, const float *frame_co, const float *frame_cg) {
    if (!enc->enable_temporal_dwt || enc->temporal_gop_frame_count >= enc->temporal_gop_capacity) {
        return -1;
    }

    int frame_idx = enc->temporal_gop_frame_count;
    size_t frame_rgb_size = enc->width * enc->height * 3;
    size_t frame_channel_size = enc->width * enc->height * sizeof(float);

    // Copy frame data to GOP buffers
    memcpy(enc->temporal_gop_rgb_frames[frame_idx], frame_rgb, frame_rgb_size);
    memcpy(enc->temporal_gop_y_frames[frame_idx], frame_y, frame_channel_size);
    memcpy(enc->temporal_gop_co_frames[frame_idx], frame_co, frame_channel_size);
    memcpy(enc->temporal_gop_cg_frames[frame_idx], frame_cg, frame_channel_size);

    // Compute block-based motion estimation if MC-EZBC is enabled
    if (enc->temporal_enable_mcezbc && frame_idx > 0) {
        // Compute forward motion vectors (F[i-1] → F[i]) using optical flow
        // This uses the proven estimate_optical_flow_motion function from encoder_tav_opencv.cpp
        estimate_optical_flow_motion(
            enc->temporal_gop_y_frames[frame_idx],       // Current frame Y channel
            enc->temporal_gop_y_frames[frame_idx - 1],   // Reference frame Y channel
            enc->width, enc->height,
            enc->temporal_block_size,
            enc->temporal_gop_mvs_fwd_x[frame_idx],      // Output: forward MVs X (1/4-pixel units)
            enc->temporal_gop_mvs_fwd_y[frame_idx]       // Output: forward MVs Y (1/4-pixel units)
        );

        // Compute backward motion vectors (F[i] → F[i-1]) by inverting forward MVs
        // MC-EZBC uses bidirectional prediction for better temporal decorrelation
        int num_blocks = enc->temporal_num_blocks_x * enc->temporal_num_blocks_y;
        for (int i = 0; i < num_blocks; i++) {
            enc->temporal_gop_mvs_bwd_x[frame_idx][i] = -enc->temporal_gop_mvs_fwd_x[frame_idx][i];
            enc->temporal_gop_mvs_bwd_y[frame_idx][i] = -enc->temporal_gop_mvs_fwd_y[frame_idx][i];
        }

        if (enc->verbose && (frame_idx < 3 || frame_idx == enc->temporal_gop_capacity - 1)) {
            // Compute average motion vector magnitude for verbose output
            float avg_mvx = 0.0f, avg_mvy = 0.0f;
            for (int i = 0; i < num_blocks; i++) {
                avg_mvx += fabsf(enc->temporal_gop_mvs_fwd_x[frame_idx][i] / 4.0f);
                avg_mvy += fabsf(enc->temporal_gop_mvs_fwd_y[frame_idx][i] / 4.0f);
            }
            avg_mvx /= num_blocks;
            avg_mvy /= num_blocks;
            printf("  GOP frame %d: motion avg=(%.2f,%.2f)px, blocks=%dx%d\n",
                   frame_idx, avg_mvx, avg_mvy,
                   enc->temporal_num_blocks_x, enc->temporal_num_blocks_y);
        }
    } else if (frame_idx == 0) {
        // First frame has no motion (reference frame)
        if (enc->temporal_enable_mcezbc) {
            int num_blocks = enc->temporal_num_blocks_x * enc->temporal_num_blocks_y;
            memset(enc->temporal_gop_mvs_fwd_x[0], 0, num_blocks * sizeof(int16_t));
            memset(enc->temporal_gop_mvs_fwd_y[0], 0, num_blocks * sizeof(int16_t));
            memset(enc->temporal_gop_mvs_bwd_x[0], 0, num_blocks * sizeof(int16_t));
            memset(enc->temporal_gop_mvs_bwd_y[0], 0, num_blocks * sizeof(int16_t));
        }
    }

    enc->temporal_gop_frame_count++;
    return 0;
}

// Check if GOP is full
static int gop_is_full(const tav_encoder_t *enc) {
    return enc->enable_temporal_dwt && (enc->temporal_gop_frame_count >= enc->temporal_gop_capacity);
}

// Reset GOP buffer
static void gop_reset(tav_encoder_t *enc) {
    enc->temporal_gop_frame_count = 0;
}

// Check if GOP should be flushed based on pre-computed boundaries (two-pass mode)
static int gop_should_flush_twopass(tav_encoder_t *enc, int current_frame_number) {
    if (!enc->two_pass_mode || !enc->current_gop_boundary) {
        return 0;
    }

    // Check if we've reached the end of the current GOP
    if (current_frame_number >= enc->current_gop_boundary->end_frame) {
        if (enc->verbose) {
            printf("  Two-pass: GOP boundary reached (frame %d, end=%d)\n",
                   current_frame_number, enc->current_gop_boundary->end_frame);
        }
        return 1;
    }

    return 0;
}

// Flush GOP: apply 3D DWT, quantise, serialise, and write to output
// Returns number of bytes written, or 0 on error
// This function processes the entire GOP and writes all frames with temporal 3D DWT
static size_t gop_flush(tav_encoder_t *enc, FILE *output, int base_quantiser,
                       int *frame_numbers, int actual_gop_size) {
    if (actual_gop_size <= 0 || actual_gop_size > enc->temporal_gop_capacity) {
        fprintf(stderr, "Error: Invalid GOP size: %d\n", actual_gop_size);
        return 0;
    }

    // Allocate working buffers for each channel
    int num_pixels = enc->width * enc->height;  // Will be updated if frames are cropped
    float **gop_y_coeffs = malloc(actual_gop_size * sizeof(float*));
    float **gop_co_coeffs = malloc(actual_gop_size * sizeof(float*));
    float **gop_cg_coeffs = malloc(actual_gop_size * sizeof(float*));

    for (int i = 0; i < actual_gop_size; i++) {
        gop_y_coeffs[i] = malloc(num_pixels * sizeof(float));
        gop_co_coeffs[i] = malloc(num_pixels * sizeof(float));
        gop_cg_coeffs[i] = malloc(num_pixels * sizeof(float));

        // Copy GOP frame data to working buffers
        memcpy(gop_y_coeffs[i], enc->temporal_gop_y_frames[i], num_pixels * sizeof(float));
        memcpy(gop_co_coeffs[i], enc->temporal_gop_co_frames[i], num_pixels * sizeof(float));
        memcpy(gop_cg_coeffs[i], enc->temporal_gop_cg_frames[i], num_pixels * sizeof(float));
    }

    // Step 0.6: Motion compensation note
    // For MC-EZBC: MC-lifting integrates motion compensation directly into the lifting steps
    // For translation: still use pre-alignment (old method for backwards compatibility)
    if (enc->temporal_enable_mcezbc)  {
        // MC-EZBC block-based motion compensation uses MC-lifting (integrated into temporal DWT)
        if (enc->verbose) {
            printf("Using motion-compensated lifting (MC-EZBC) (%dx%d blocks)\n",
                   enc->temporal_num_blocks_x, enc->temporal_num_blocks_y);
        }
    }

    // Step 1: For single-frame GOP, skip temporal DWT and use traditional I-frame path
    if (actual_gop_size == 1) {
        // Apply only 2D spatial DWT (no temporal transform for single frame)
        // Use cropped dimensions (will be full size if no motion)
        dwt_2d_forward_flexible(enc, gop_y_coeffs[0], enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
        dwt_2d_forward_flexible(enc, gop_co_coeffs[0], enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
        dwt_2d_forward_flexible(enc, gop_cg_coeffs[0], enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
    } else {
        // Multi-frame GOP: Apply 3D DWT (temporal + spatial) to each channel
        // Note: This modifies gop_*_coeffs in-place
        // Use cropped dimensions to encode only the valid region

        if (enc->temporal_enable_mcezbc) {
            // Use MC-EZBC lifting: motion compensation integrated into lifting steps
            dwt_3d_forward_mc(enc, gop_y_coeffs, gop_co_coeffs, gop_cg_coeffs,
                             actual_gop_size, enc->decomp_levels,
                             enc->temporal_decomp_levels, enc->wavelet_filter);
        } else {
            // Use traditional 3D DWT with pre-aligned frames (translation-only)
            dwt_3d_forward(enc, gop_y_coeffs, enc->width, enc->height, actual_gop_size,
                          enc->decomp_levels, enc->temporal_decomp_levels, enc->wavelet_filter);
            dwt_3d_forward(enc, gop_co_coeffs, enc->width, enc->height, actual_gop_size,
                          enc->decomp_levels, enc->temporal_decomp_levels, enc->wavelet_filter);
            dwt_3d_forward(enc, gop_cg_coeffs, enc->width, enc->height, actual_gop_size,
                          enc->decomp_levels, enc->temporal_decomp_levels, enc->wavelet_filter);
        }
    }

    // Step 2: Allocate quantised coefficient buffers
    int16_t **quant_y = malloc(actual_gop_size * sizeof(int16_t*));
    int16_t **quant_co = malloc(actual_gop_size * sizeof(int16_t*));
    int16_t **quant_cg = malloc(actual_gop_size * sizeof(int16_t*));

    for (int i = 0; i < actual_gop_size; i++) {
        quant_y[i] = malloc(num_pixels * sizeof(int16_t));
        quant_co[i] = malloc(num_pixels * sizeof(int16_t));
        quant_cg[i] = malloc(num_pixels * sizeof(int16_t));
    }

    // Step 3: Quantise 3D DWT coefficients with temporal-spatial quantisation
    // Use channel-specific quantisers from encoder settings
    int qY = base_quantiser;  // Y quantiser passed as parameter
    int qCo = QLUT[enc->quantiser_co];  // Co quantiser from encoder
    int qCg = QLUT[enc->quantiser_cg];  // Cg quantiser from encoder

    quantise_3d_dwt_coefficients(enc, gop_y_coeffs, quant_y, actual_gop_size,
                                 num_pixels, qY, 0);  // Luma
    quantise_3d_dwt_coefficients(enc, gop_co_coeffs, quant_co, actual_gop_size,
                                 num_pixels, qCo, 1);  // Chroma Co
    quantise_3d_dwt_coefficients(enc, gop_cg_coeffs, quant_cg, actual_gop_size,
                                 num_pixels, qCg, 1);  // Chroma Cg

    // Debug: print LL coefficients for frames 0 and 1 (first 10 pixels)
    /*if (enc->quality_level == 5 && enc->verbose) {
        int ll_width = enc->width >> enc->decomp_levels;
        int ll_height = enc->height >> enc->decomp_levels;
        printf("DEBUG Q5: LL coefficients for first 10 pixels:\n");
        for (int f = 0; f < (actual_gop_size < 2 ? actual_gop_size : 2); f++) {
            printf("  Frame %d: ", f);
            for (int i = 0; i < 10 && i < ll_width * ll_height; i++) {
                printf("%d ", quant_y[f][i]);
            }
            printf("\n");
        }
    }*/

    // Step 4: Preprocessing and compression
    size_t total_bytes_written = 0;

    // Write timecode packet for first frame in GOP
    write_timecode_packet(output, frame_numbers[0], enc->output_fps, enc->is_ntsc_framerate);

    // Process audio for this GOP (all frames at once)
    process_audio_for_gop(enc, frame_numbers, actual_gop_size, output);

    // Single-frame GOP fallback: use traditional I-frame encoding with serialise_tile_data
    if (actual_gop_size == 1) {
        // Write I-frame packet header (no motion vectors, no GOP overhead)
        uint8_t packet_type = TAV_PACKET_IFRAME;
        fwrite(&packet_type, 1, 1, output);
        total_bytes_written += 1;

        // Allocate buffer for uncompressed tile data
        // Use same format as compress_and_write_frame: serialise_tile_data
        const size_t max_tile_size = 4 + (num_pixels * 3 * sizeof(int16_t));
        uint8_t *uncompressed_buffer = malloc(max_tile_size);

        // Use serialise_tile_data with DWT-transformed float coefficients (before quantisation)
        // This matches the traditional I-frame path in compress_and_write_frame
        size_t tile_size = serialise_tile_data(enc, 0, 0,
                                               gop_y_coeffs[0], gop_co_coeffs[0], gop_cg_coeffs[0],
                                               TAV_MODE_INTRA, uncompressed_buffer);

        size_t preprocessed_size = tile_size;
        uint8_t *preprocessed_buffer = uncompressed_buffer;

        // Compress with Zstd
        size_t max_compressed_size = ZSTD_compressBound(preprocessed_size);
        uint8_t *compressed_buffer = malloc(max_compressed_size);
        size_t compressed_size = ZSTD_compress(compressed_buffer, max_compressed_size,
                                               preprocessed_buffer, preprocessed_size,
                                               enc->zstd_level);

        if (ZSTD_isError(compressed_size)) {
            fprintf(stderr, "Error: Zstd compression failed for single-frame GOP\n");
            free(preprocessed_buffer);
            free(compressed_buffer);
            // Free all allocated buffers
            for (int i = 0; i < actual_gop_size; i++) {
                free(gop_y_coeffs[i]);
                free(gop_co_coeffs[i]);
                free(gop_cg_coeffs[i]);
                free(quant_y[i]);
                free(quant_co[i]);
                free(quant_cg[i]);
            }
            free(gop_y_coeffs);
            free(gop_co_coeffs);
            free(gop_cg_coeffs);
            free(quant_y);
            free(quant_co);
            free(quant_cg);
            return 0;
        }

        // Write compressed size (4 bytes) and compressed data
        uint32_t compressed_size_32 = (uint32_t)compressed_size;
        fwrite(&compressed_size_32, sizeof(uint32_t), 1, output);
        fwrite(compressed_buffer, 1, compressed_size, output);
        total_bytes_written += sizeof(uint32_t) + compressed_size;

        // Cleanup
        free(preprocessed_buffer);
        free(compressed_buffer);

        // Write SYNC packet after single-frame GOP I-frame
        uint8_t sync_packet = TAV_PACKET_SYNC;
        fwrite(&sync_packet, 1, 1, output);
        total_bytes_written += 1;

        if (enc->verbose) {
            printf("Frame %d (single-frame GOP as I-frame): %zu bytes\n",
                   frame_numbers[0], compressed_size);
        }
    }
    else {
        // Multi-frame GOP: use unified 3D DWT encoding
        // Choose packet type based on motion compensation method
        uint8_t packet_type = enc->temporal_enable_mcezbc ? TAV_PACKET_GOP_UNIFIED_MOTION : TAV_PACKET_GOP_UNIFIED;
        fwrite(&packet_type, 1, 1, output);
        total_bytes_written += 1;

        // Write GOP size (1 byte)
        uint8_t gop_size_byte = (uint8_t)actual_gop_size;
        fwrite(&gop_size_byte, 1, 1, output);
        total_bytes_written += 1;

        if (enc->temporal_enable_mcezbc) {
            // Packet 0x13: MC-EZBC block-based motion compensation
            // Encode block motion vectors and compress with Zstd
            // Max size: block dimensions (2) + MVs (4 bytes per block × 2 directions)
            int num_blocks = enc->temporal_num_blocks_x * enc->temporal_num_blocks_y;
            size_t max_mv_size = 2 + (actual_gop_size * num_blocks * 4 * 2);  // fwd + bwd MVs
            uint8_t *mv_buffer = malloc(max_mv_size);

            size_t mv_size = encode_block_mvs_differential(
                enc->temporal_gop_mvs_fwd_x, enc->temporal_gop_mvs_fwd_y,
                actual_gop_size, enc->temporal_num_blocks_x, enc->temporal_num_blocks_y,
                mv_buffer, max_mv_size
            );

            if (mv_size == 0) {
                fprintf(stderr, "Error: Failed to encode block motion vectors\n");
                free(mv_buffer);
                // Free all allocated buffers
                for (int i = 0; i < actual_gop_size; i++) {
                    free(gop_y_coeffs[i]);
                    free(gop_co_coeffs[i]);
                    free(gop_cg_coeffs[i]);
                    free(quant_y[i]);
                    free(quant_co[i]);
                    free(quant_cg[i]);
                }
                free(gop_y_coeffs);
                free(gop_co_coeffs);
                free(gop_cg_coeffs);
                free(quant_y);
                free(quant_co);
                free(quant_cg);
                return 0;
            }

            // Compress MV data with Zstd
            size_t max_compressed_mv = ZSTD_compressBound(mv_size);
            uint8_t *compressed_mv = malloc(max_compressed_mv);
            size_t compressed_mv_size = ZSTD_compress(
                compressed_mv, max_compressed_mv,
                mv_buffer, mv_size,
                enc->zstd_level
            );

            if (ZSTD_isError(compressed_mv_size)) {
                fprintf(stderr, "Error: Zstd compression failed for motion vector data\n");
                free(mv_buffer);
                free(compressed_mv);
                // Free all allocated buffers
                for (int i = 0; i < actual_gop_size; i++) {
                    free(gop_y_coeffs[i]);
                    free(gop_co_coeffs[i]);
                    free(gop_cg_coeffs[i]);
                    free(quant_y[i]);
                    free(quant_co[i]);
                    free(quant_cg[i]);
                }
                free(gop_y_coeffs);
                free(gop_co_coeffs);
                free(gop_cg_coeffs);
                free(quant_y);
                free(quant_co);
                free(quant_cg);
                return 0;
            }

            // Write compressed MV size and data
            uint32_t compressed_mv_size_32 = (uint32_t)compressed_mv_size;
            fwrite(&compressed_mv_size_32, sizeof(uint32_t), 1, output);
            fwrite(compressed_mv, 1, compressed_mv_size, output);
            total_bytes_written += sizeof(uint32_t) + compressed_mv_size;

            if (enc->verbose) {
                printf("Motion vectors: %zu bytes raw, %zu bytes compressed (%.1f%% compression)\n",
                       mv_size, compressed_mv_size,
                       100.0 * compressed_mv_size / mv_size);
            }

            free(mv_buffer);
            free(compressed_mv);
        }

        // Preprocess ALL frames with unified significance map
        // Allocate buffer: maps (2 bits per coeff per frame) + values (int16 per non-zero/±1 coeff)
        size_t max_preprocessed_size = (num_pixels * actual_gop_size * 3 * 2 + 7) / 8 +
                                        (num_pixels * actual_gop_size * 3 * sizeof(int16_t));
        uint8_t *preprocessed_buffer = malloc(max_preprocessed_size);

        size_t preprocessed_size = preprocess_gop_unified(
            enc->preprocess_mode, quant_y, quant_co, quant_cg,
            actual_gop_size, num_pixels, enc->width, enc->height, enc->channel_layout,
            preprocessed_buffer);

        // Compress entire GOP with Zstd (single compression for all frames)
        size_t max_compressed_size = ZSTD_compressBound(preprocessed_size);
        uint8_t *compressed_buffer = malloc(max_compressed_size);
        size_t compressed_size = ZSTD_compress(compressed_buffer, max_compressed_size,
                                               preprocessed_buffer, preprocessed_size,
                                               enc->zstd_level);

        if (ZSTD_isError(compressed_size)) {
            fprintf(stderr, "Error: Zstd compression failed for unified GOP\n");
            free(preprocessed_buffer);
            free(compressed_buffer);
            // Free all allocated buffers and return 0
            for (int i = 0; i < actual_gop_size; i++) {
                free(gop_y_coeffs[i]);
                free(gop_co_coeffs[i]);
                free(gop_cg_coeffs[i]);
                free(quant_y[i]);
                free(quant_co[i]);
                free(quant_cg[i]);
            }
            free(gop_y_coeffs);
            free(gop_co_coeffs);
            free(gop_cg_coeffs);
            free(quant_y);
            free(quant_co);
            free(quant_cg);
            return 0;
        }

        // Write compressed size (4 bytes) and compressed data
        uint32_t compressed_size_32 = (uint32_t)compressed_size;
        fwrite(&compressed_size_32, sizeof(uint32_t), 1, output);
        fwrite(compressed_buffer, 1, compressed_size, output);
        total_bytes_written += sizeof(uint32_t) + compressed_size;

        // Cleanup buffers
        free(preprocessed_buffer);
        free(compressed_buffer);

        // Write GOP_SYNC packet to indicate N frames were decoded from this GOP block
        uint8_t sync_packet_type = TAV_PACKET_GOP_SYNC;
        uint8_t sync_frame_count = (uint8_t)actual_gop_size;
        fwrite(&sync_packet_type, 1, 1, output);
        fwrite(&sync_frame_count, 1, 1, output);
        total_bytes_written += 2;

    }  // End of if/else for single-frame vs multi-frame GOP

    // Tally frame statistics
    if (actual_gop_size == 1) {
        // Single frame encoded as INTRA
        count_intra++;
    } else {
        // Multiple frames encoded in GOP block - count individual frames
        count_gop += actual_gop_size;
    }

    // Cleanup GOP buffers
    for (int i = 0; i < actual_gop_size; i++) {
        free(gop_y_coeffs[i]);
        free(gop_co_coeffs[i]);
        free(gop_cg_coeffs[i]);
        free(quant_y[i]);
        free(quant_co[i]);
        free(quant_cg[i]);
    }
    free(gop_y_coeffs);
    free(gop_co_coeffs);
    free(gop_cg_coeffs);
    free(quant_y);
    free(quant_co);
    free(quant_cg);

    return total_bytes_written;
}

// Process GOP with scene change detection and flush
// Returns number of bytes written, or 0 on error
// This wrapper function handles GOP trimming when scene changes are detected
static size_t gop_process_and_flush(tav_encoder_t *enc, FILE *output, int base_quantiser,
                                   int *frame_numbers, int force_flush) {
    if (enc->temporal_gop_frame_count == 0) {
        return 0;  // Nothing to flush
    }

    int actual_gop_size = enc->temporal_gop_frame_count;
    int scene_change_frame = -1;

    // Check for scene changes within the GOP (skip in two-pass mode - boundaries are pre-computed)
    if (!force_flush && !enc->two_pass_mode) {
        for (int i = 1; i < enc->temporal_gop_frame_count; i++) {
            // Compare consecutive frames using unified scene change detection
            double avg_diff, changed_ratio;
            int is_scene_change = detect_scene_change_between_frames(
                enc->temporal_gop_rgb_frames[i - 1],
                enc->temporal_gop_rgb_frames[i],
                enc->width,
                enc->height,
                &avg_diff,
                &changed_ratio
            );

            if (is_scene_change) {
                scene_change_frame = i;
                if (enc->verbose) {
                    printf("Scene change detected within GOP at frame %d (avg_diff=%.2f, change_ratio=%.4f)\n",
                           frame_numbers[i], avg_diff, changed_ratio);
                }
                break;
            }
        }
    }

    // Trim GOP if scene change detected
    if (scene_change_frame > 0) {
        actual_gop_size = scene_change_frame;

        // If trimmed GOP would be too small, encode as separate I-frames instead
        if (actual_gop_size < TEMPORAL_GOP_SIZE_MIN) {
            if (enc->verbose) {
                printf("Scene change at frame %d would create GOP of %d frames (< %d), encoding as I-frames instead\n",
                       frame_numbers[scene_change_frame], actual_gop_size, TEMPORAL_GOP_SIZE_MIN);
            }

            // Encode each frame before scene change as separate I-frame
            size_t total_bytes = 0;
            int original_gop_frame_count = enc->temporal_gop_frame_count;

            for (int i = 0; i < actual_gop_size; i++) {
                // Temporarily set up single-frame GOP
                uint8_t *saved_rgb_frame0 = enc->temporal_gop_rgb_frames[0];
                float *saved_y_frame0 = enc->temporal_gop_y_frames[0];
                float *saved_co_frame0 = enc->temporal_gop_co_frames[0];
                float *saved_cg_frame0 = enc->temporal_gop_cg_frames[0];

                // Set up single-frame GOP by moving frame i to position 0
                enc->temporal_gop_rgb_frames[0] = enc->temporal_gop_rgb_frames[i];
                enc->temporal_gop_y_frames[0] = enc->temporal_gop_y_frames[i];
                enc->temporal_gop_co_frames[0] = enc->temporal_gop_co_frames[i];
                enc->temporal_gop_cg_frames[0] = enc->temporal_gop_cg_frames[i];
                enc->temporal_gop_frame_count = 1;

                // Encode as I-frame
                size_t bytes = gop_flush(enc, output, base_quantiser, &frame_numbers[i], 1);
                if (bytes == 0) {
                    fprintf(stderr, "Error: Failed to encode I-frame during GOP trimming\n");
                    enc->temporal_gop_frame_count = original_gop_frame_count;
                    return 0;
                }
                total_bytes += bytes;

                // Restore position 0 (but keep frame i in place for the shift operation below)
                enc->temporal_gop_rgb_frames[0] = saved_rgb_frame0;
                enc->temporal_gop_y_frames[0] = saved_y_frame0;
                enc->temporal_gop_co_frames[0] = saved_co_frame0;
                enc->temporal_gop_cg_frames[0] = saved_cg_frame0;
            }

            // Restore original frame count
            enc->temporal_gop_frame_count = original_gop_frame_count;

            // Shift remaining frames (after scene change) to start of buffer
            int remaining_frames = original_gop_frame_count - scene_change_frame;
            for (int i = 0; i < remaining_frames; i++) {
                int src = scene_change_frame + i;
                // Swap pointers
                uint8_t *temp_rgb = enc->temporal_gop_rgb_frames[i];
                float *temp_y = enc->temporal_gop_y_frames[i];
                float *temp_co = enc->temporal_gop_co_frames[i];
                float *temp_cg = enc->temporal_gop_cg_frames[i];

                enc->temporal_gop_rgb_frames[i] = enc->temporal_gop_rgb_frames[src];
                enc->temporal_gop_y_frames[i] = enc->temporal_gop_y_frames[src];
                enc->temporal_gop_co_frames[i] = enc->temporal_gop_co_frames[src];
                enc->temporal_gop_cg_frames[i] = enc->temporal_gop_cg_frames[src];

                enc->temporal_gop_rgb_frames[src] = temp_rgb;
                enc->temporal_gop_y_frames[src] = temp_y;
                enc->temporal_gop_co_frames[src] = temp_co;
                enc->temporal_gop_cg_frames[src] = temp_cg;
            }
            enc->temporal_gop_frame_count = remaining_frames;

            return total_bytes;

        } else {
            // GOP large enough after trimming - proceed normally
            if (enc->verbose) {
                printf("Trimming GOP from %d to %d frames due to scene change\n",
                       enc->temporal_gop_frame_count, actual_gop_size);
            }
        }
    }

    // Flush the GOP (or trimmed portion)
    size_t bytes_written = gop_flush(enc, output, base_quantiser, frame_numbers, actual_gop_size);

    // If GOP was trimmed, shift remaining frames to start of buffer
    if (scene_change_frame > 0 && scene_change_frame < enc->temporal_gop_frame_count) {
        int remaining_frames = enc->temporal_gop_frame_count - scene_change_frame;
        for (int i = 0; i < remaining_frames; i++) {
            int src = scene_change_frame + i;
            // Swap pointers instead of copying data
            uint8_t *temp_rgb = enc->temporal_gop_rgb_frames[i];
            float *temp_y = enc->temporal_gop_y_frames[i];
            float *temp_co = enc->temporal_gop_co_frames[i];
            float *temp_cg = enc->temporal_gop_cg_frames[i];

            enc->temporal_gop_rgb_frames[i] = enc->temporal_gop_rgb_frames[src];
            enc->temporal_gop_y_frames[i] = enc->temporal_gop_y_frames[src];
            enc->temporal_gop_co_frames[i] = enc->temporal_gop_co_frames[src];
            enc->temporal_gop_cg_frames[i] = enc->temporal_gop_cg_frames[src];

            enc->temporal_gop_rgb_frames[src] = temp_rgb;
            enc->temporal_gop_y_frames[src] = temp_y;
            enc->temporal_gop_co_frames[src] = temp_co;
            enc->temporal_gop_cg_frames[src] = temp_cg;
        }
        enc->temporal_gop_frame_count = remaining_frames;
    } else {
        // Full GOP flushed, reset
        gop_reset(enc);
    }

    return bytes_written;
}

// =============================================================================
// Temporal DWT Functions
// =============================================================================

// Simple translation-based frame alignment (legacy, non-MC-EZBC path)
// Shifts entire frame by (dx, dy) pixels with bilinear interpolation
static void apply_translation(
    const float *src, int width, int height,
    float dx, float dy,
    float *dst
) {
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            // Source position (backward warping)
            float src_x = x - dx;
            float src_y = y - dy;

            // Clamp to valid range
            if (src_x < 0.0f) src_x = 0.0f;
            if (src_x >= width - 1) src_x = width - 1.001f;
            if (src_y < 0.0f) src_y = 0.0f;
            if (src_y >= height - 1) src_y = height - 1.001f;

            // Bilinear interpolation
            int x0 = (int)src_x;
            int y0 = (int)src_y;
            int x1 = x0 + 1;
            int y1 = y0 + 1;

            float fx = src_x - x0;
            float fy = src_y - y0;

            float val00 = src[y0 * width + x0];
            float val10 = src[y0 * width + x1];
            float val01 = src[y1 * width + x0];
            float val11 = src[y1 * width + x1];

            float val_top = (1.0f - fx) * val00 + fx * val10;
            float val_bot = (1.0f - fx) * val01 + fx * val11;
            float val = (1.0f - fy) * val_top + fy * val_bot;

            dst[y * width + x] = val;
        }
    }
}

// MC-EZBC Motion-Compensated Lifting (Proper Implementation)
// Implements the predict-update lifting scheme from MC-EZBC paper
// Based on MC-EZBC.md documentation
//
// MC-EZBC Lifting Steps:
//   Predict: H[i] = F_odd[i] - 0.5 * (warp(F_even[i], MV_fw) + warp(F_even[i+1], MV_bw))
//   Update:  L[i] = F_even[i] + 0.25 * (warp(H[i-1], MV_bw) + warp(H[i], MV_fw))
//
// This produces:
//   L (lowband): temporal low-pass with motion-compensated update
//   H (highband): temporal high-pass residual after bidirectional prediction
//
// Benefits over mesh warping:
//   - Standard block-based approach (proven in JPEG 2000, H.264)
//   - Perfect invertibility
//   - Lower computational cost
//   - Smaller motion vector overhead
static void mc_lifting_forward_pair(
    tav_encoder_t *enc,
    float **f0_y, float **f0_co, float **f0_cg,  // F_even (frame at even index)
    float **f1_y, float **f1_co, float **f1_cg,  // F_odd (frame at odd index)
    int f0_idx, int f1_idx,                       // Frame indices for MV lookup
    float **out_l_y, float **out_l_co, float **out_l_cg,  // Lowband output
    float **out_h_y, float **out_h_co, float **out_h_cg   // Highband output
) {
    int width = enc->width;
    int height = enc->height;
    int num_pixels = width * height;

    // Get motion vectors for this frame pair
    int16_t *mvs_fwd_x = enc->temporal_gop_mvs_fwd_x[f1_idx];  // F0 → F1
    int16_t *mvs_fwd_y = enc->temporal_gop_mvs_fwd_y[f1_idx];
    int16_t *mvs_bwd_x = enc->temporal_gop_mvs_bwd_x[f1_idx];  // F1 → F0
    int16_t *mvs_bwd_y = enc->temporal_gop_mvs_bwd_y[f1_idx];

    // Allocate temporary buffers for predictions
    float *pred_y = malloc(num_pixels * sizeof(float));
    float *pred_co = malloc(num_pixels * sizeof(float));
    float *pred_cg = malloc(num_pixels * sizeof(float));

    if (!pred_y || !pred_co || !pred_cg) {
        fprintf(stderr, "Error: Failed to allocate MC-EZBC lifting buffers\n");
        free(pred_y);
        free(pred_co);
        free(pred_cg);
        return;
    }

    // ===== MC-EZBC PREDICT STEP =====
    // H = F_odd - 0.5 * (warp(F_even, MV_fw) + warp(F_even, MV_bw))
    // Use bidirectional prediction for better temporal decorrelation
    warp_bidirectional(*f0_y, *f1_y, width, height,
                       mvs_fwd_x, mvs_fwd_y, mvs_bwd_x, mvs_bwd_y,
                       enc->temporal_block_size, pred_y);
    warp_bidirectional(*f0_co, *f1_co, width, height,
                       mvs_fwd_x, mvs_fwd_y, mvs_bwd_x, mvs_bwd_y,
                       enc->temporal_block_size, pred_co);
    warp_bidirectional(*f0_cg, *f1_cg, width, height,
                       mvs_fwd_x, mvs_fwd_y, mvs_bwd_x, mvs_bwd_y,
                       enc->temporal_block_size, pred_cg);

    // Compute high-pass (temporal residual)
    for (int i = 0; i < num_pixels; i++) {
        (*out_h_y)[i] = (*f1_y)[i] - pred_y[i];
        (*out_h_co)[i] = (*f1_co)[i] - pred_co[i];
        (*out_h_cg)[i] = (*f1_cg)[i] - pred_cg[i];
    }

    // ===== MC-EZBC UPDATE STEP =====
    // L = F_even + 0.25 * warp(H, MV_bw)
    // (Note: In full implementation, this would use both H[i-1] and H[i],
    // but for single-level decomposition, we only have current H)
    float *update_y = malloc(num_pixels * sizeof(float));
    float *update_co = malloc(num_pixels * sizeof(float));
    float *update_cg = malloc(num_pixels * sizeof(float));

    if (!update_y || !update_co || !update_cg) {
        fprintf(stderr, "Error: Failed to allocate MC-EZBC update buffers\n");
        free(pred_y);
        free(pred_co);
        free(pred_cg);
        free(update_y);
        free(update_co);
        free(update_cg);
        return;
    }

    // Warp H (high-pass) back to F_even using backward MVs
    warp_block_motion(*out_h_y, width, height, mvs_bwd_x, mvs_bwd_y,
                      enc->temporal_block_size, update_y);
    warp_block_motion(*out_h_co, width, height, mvs_bwd_x, mvs_bwd_y,
                      enc->temporal_block_size, update_co);
    warp_block_motion(*out_h_cg, width, height, mvs_bwd_x, mvs_bwd_y,
                      enc->temporal_block_size, update_cg);

    // Compute low-pass (temporal approximation)
    for (int i = 0; i < num_pixels; i++) {
        (*out_l_y)[i] = (*f0_y)[i] + 0.25f * update_y[i];
        (*out_l_co)[i] = (*f0_co)[i] + 0.25f * update_co[i];
        (*out_l_cg)[i] = (*f0_cg)[i] + 0.25f * update_cg[i];
    }

    // Cleanup
    free(pred_y);
    free(pred_co);
    free(pred_cg);
    free(update_y);
    free(update_co);
    free(update_cg);
}

// Apply 3D DWT with motion-compensated lifting (MC-lifting)
// Integrates motion compensation directly into wavelet lifting steps
// This replaces separate warping + DWT for better invertibility and compression
static void dwt_3d_forward_mc(
    tav_encoder_t *enc,
    float **gop_y, float **gop_co, float **gop_cg,
    int num_frames, int spatial_levels, int temporal_levels, int spatial_filter
) {
    if (num_frames < 2) return;

    int width = enc->width;
    int height = enc->height;
    int num_pixels = width * height;

    // Allocate temporary buffers for L and H bands
    float **temp_l_y = malloc(num_frames * sizeof(float*));
    float **temp_l_co = malloc(num_frames * sizeof(float*));
    float **temp_l_cg = malloc(num_frames * sizeof(float*));
    float **temp_h_y = malloc(num_frames * sizeof(float*));
    float **temp_h_co = malloc(num_frames * sizeof(float*));
    float **temp_h_cg = malloc(num_frames * sizeof(float*));

    for (int i = 0; i < num_frames; i++) {
        temp_l_y[i] = malloc(num_pixels * sizeof(float));
        temp_l_co[i] = malloc(num_pixels * sizeof(float));
        temp_l_cg[i] = malloc(num_pixels * sizeof(float));
        temp_h_y[i] = malloc(num_pixels * sizeof(float));
        temp_h_co[i] = malloc(num_pixels * sizeof(float));
        temp_h_cg[i] = malloc(num_pixels * sizeof(float));
    }

    // Step 1: Apply MC-lifting temporal transform
    // Process frame pairs at each decomposition level
    for (int level = 0; level < temporal_levels; level++) {
        int level_frames = num_frames >> level;
        if (level_frames < 2) break;

        // Apply MC-lifting to each frame pair
        for (int i = 0; i < level_frames; i += 2) {
            int f0_idx = i;
            int f1_idx = i + 1;

            if (f1_idx >= level_frames) break;

            // Apply MC-EZBC lifting: (L, H) = mc_lift_ezbc(F0, F1, MVs)
            // Motion vectors are stored per frame and looked up by frame index
            mc_lifting_forward_pair(
                enc,
                &gop_y[f0_idx], &gop_co[f0_idx], &gop_cg[f0_idx],  // F_even
                &gop_y[f1_idx], &gop_co[f1_idx], &gop_cg[f1_idx],  // F_odd
                f0_idx, f1_idx,                                     // Frame indices for MV lookup
                &temp_l_y[i/2], &temp_l_co[i/2], &temp_l_cg[i/2],  // L output
                &temp_h_y[level_frames/2 + i/2], &temp_h_co[level_frames/2 + i/2], &temp_h_cg[level_frames/2 + i/2]  // H output
            );
        }

        // Copy L and H bands back to gop buffers for next level
        int half = level_frames / 2;
        for (int i = 0; i < half; i++) {
            memcpy(gop_y[i], temp_l_y[i], num_pixels * sizeof(float));
            memcpy(gop_co[i], temp_l_co[i], num_pixels * sizeof(float));
            memcpy(gop_cg[i], temp_l_cg[i], num_pixels * sizeof(float));
        }
        for (int i = 0; i < half; i++) {
            memcpy(gop_y[half + i], temp_h_y[half + i], num_pixels * sizeof(float));
            memcpy(gop_co[half + i], temp_h_co[half + i], num_pixels * sizeof(float));
            memcpy(gop_cg[half + i], temp_h_cg[half + i], num_pixels * sizeof(float));
        }
    }

    // Step 2: Apply 2D spatial DWT to each temporal subband
    for (int t = 0; t < num_frames; t++) {
        dwt_2d_forward_flexible(enc, gop_y[t], width, height, spatial_levels, spatial_filter);
        dwt_2d_forward_flexible(enc, gop_co[t], width, height, spatial_levels, spatial_filter);
        dwt_2d_forward_flexible(enc, gop_cg[t], width, height, spatial_levels, spatial_filter);
    }

    // Cleanup
    for (int i = 0; i < num_frames; i++) {
        free(temp_l_y[i]);
        free(temp_l_co[i]);
        free(temp_l_cg[i]);
        free(temp_h_y[i]);
        free(temp_h_co[i]);
        free(temp_h_cg[i]);
    }
    free(temp_l_y);
    free(temp_l_co);
    free(temp_l_cg);
    free(temp_h_y);
    free(temp_h_co);
    free(temp_h_cg);
}

// Apply 3D DWT: temporal DWT across frames, then spatial DWT on each temporal subband
// gop_data[frame][y * width + x] - GOP buffer organised as frame-major
// Modifies gop_data in-place
// NOTE: This is the OLD version without MC-lifting (kept for non-mesh mode)
static void dwt_3d_forward(tav_encoder_t *enc, float **gop_data, int width, int height, int num_frames,
                          int spatial_levels, int temporal_levels, int spatial_filter) {
    if (num_frames < 2 || width < 2 || height < 2) return;

    int num_pixels = width * height;
    float *temporal_line = malloc(num_frames * sizeof(float));

    // Pre-calculate all intermediate lengths for temporal DWT (same fix as TAD)
    // This ensures correct reconstruction for non-power-of-2 GOP sizes
    int *temporal_lengths = malloc((temporal_levels + 1) * sizeof(int));
    temporal_lengths[0] = num_frames;
    for (int i = 1; i <= temporal_levels; i++) {
        temporal_lengths[i] = (temporal_lengths[i - 1] + 1) / 2;
    }

    // Step 1: Apply temporal DWT to each spatial location across all GOP frames
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            int pixel_idx = y * width + x;

            // Extract temporal signal for this spatial location
            for (int t = 0; t < num_frames; t++) {
                temporal_line[t] = gop_data[t][pixel_idx];
            }

            // Apply temporal DWT with multiple levels using pre-calculated lengths
            for (int level = 0; level < temporal_levels; level++) {
                int level_frames = temporal_lengths[level];
                if (level_frames >= 2) {
                    dwt_haar_forward_1d(temporal_line, level_frames);  // Haar better for imperfect alignment
                }
            }

            // Write back temporal coefficients
            for (int t = 0; t < num_frames; t++) {
                gop_data[t][pixel_idx] = temporal_line[t];
            }
        }
    }

    free(temporal_lengths);
    free(temporal_line);

    // Step 2: Apply 2D spatial DWT to each temporal subband (each frame after temporal DWT)
    for (int t = 0; t < num_frames; t++) {
        // Apply spatial DWT using the appropriate flexible function
        dwt_2d_forward_flexible(enc, gop_data[t], width, height, spatial_levels, spatial_filter);
    }
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
            // OPTIMISATION: Bulk copy core region in one operation
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

// ==============================================================================
// Grain Synthesis Functions
// ==============================================================================

// Forward declaration for perceptual weight function
static float get_perceptual_weight(tav_encoder_t *enc, int level0, int subband_type, int is_chroma, int max_levels);

// 2D DWT forward transform for rectangular padded tile (344x288)
static void dwt_2d_forward_padded(float *tile_data, int levels, int filter_type) {
    const int width = PADDED_TILE_SIZE_X;   // 344
    const int height = PADDED_TILE_SIZE_Y;  // 288
    const int max_size = (width > height) ? width : height;
    float *temp_row = malloc(max_size * sizeof(float));
    float *temp_col = malloc(max_size * sizeof(float));

    int *widths = malloc((levels + 1) * sizeof(int));
    int *heights = malloc((levels + 1) * sizeof(int));
    widths[0] = width;
    heights[0] = height;
    for (int i = 1; i <= levels; i++) {
        widths[i] = (widths[i - 1] + 1) / 2;
        heights[i] = (heights[i - 1] + 1) / 2;
    }

    for (int level = 0; level < levels; level++) {
        int current_width = widths[level];
        int current_height = heights[level];
        if (current_width < 1 || current_height < 1) break;

        // Row transform (horizontal)
        for (int y = 0; y < current_height; y++) {
            for (int x = 0; x < current_width; x++) {
                temp_row[x] = tile_data[y * width + x];
            }

            if (filter_type == WAVELET_5_3_REVERSIBLE) {
                dwt_53_forward_1d(temp_row, current_width);
            } else if (filter_type == WAVELET_9_7_IRREVERSIBLE) {
                dwt_97_forward_1d(temp_row, current_width);
            } else if (filter_type == WAVELET_BIORTHOGONAL_13_7) {
                dwt_bior137_forward_1d(temp_row, current_width);
            } else if (filter_type == WAVELET_DD4) {
                dwt_dd4_forward_1d(temp_row, current_width);
            } else if (filter_type == WAVELET_HAAR) {
                dwt_haar_forward_1d(temp_row, current_width);
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
            } else if (filter_type == WAVELET_9_7_IRREVERSIBLE) {
                dwt_97_forward_1d(temp_col, current_height);
            } else if (filter_type == WAVELET_BIORTHOGONAL_13_7) {
                dwt_bior137_forward_1d(temp_col, current_height);
            } else if (filter_type == WAVELET_DD4) {
                dwt_dd4_forward_1d(temp_col, current_height);
            } else if (filter_type == WAVELET_HAAR) {
                dwt_haar_forward_1d(temp_col, current_height);
            }

            for (int y = 0; y < current_height; y++) {
                tile_data[y * width + x] = temp_col[y];
            }
        }
    }

    free(widths);
    free(heights);
    free(temp_row);
    free(temp_col);
}

// 2D DWT forward transform for arbitrary dimensions
static void dwt_2d_forward_flexible(tav_encoder_t *enc, float *tile_data, int width, int height, int levels, int filter_type) {
    const int max_size = (width > height) ? width : height;
    float *temp_row = malloc(max_size * sizeof(float));
    float *temp_col = malloc(max_size * sizeof(float));

    for (int level = 0; level < levels; level++) {
        int current_width = enc->widths[level];
        int current_height = enc->heights[level];
        if (current_width < 1 || current_height < 1) break;

        // Row transform (horizontal)
        for (int y = 0; y < current_height; y++) {
            for (int x = 0; x < current_width; x++) {
                temp_row[x] = tile_data[y * width + x];
            }

            if (filter_type == WAVELET_5_3_REVERSIBLE) {
                dwt_53_forward_1d(temp_row, current_width);
            } else if (filter_type == WAVELET_9_7_IRREVERSIBLE) {
                dwt_97_forward_1d(temp_row, current_width);
            } else if (filter_type == WAVELET_BIORTHOGONAL_13_7) {
                dwt_bior137_forward_1d(temp_row, current_width);
            } else if (filter_type == WAVELET_DD4) {
                dwt_dd4_forward_1d(temp_row, current_width);
            } else if (filter_type == WAVELET_HAAR) {
                dwt_haar_forward_1d(temp_row, current_width);
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
            } else if (filter_type == WAVELET_9_7_IRREVERSIBLE) {
                dwt_97_forward_1d(temp_col, current_height);
            } else if (filter_type == WAVELET_BIORTHOGONAL_13_7) {
                dwt_bior137_forward_1d(temp_col, current_height);
            } else if (filter_type == WAVELET_DD4) {
                dwt_dd4_forward_1d(temp_col, current_height);
            } else if (filter_type == WAVELET_HAAR) {
                dwt_haar_forward_1d(temp_col, current_height);
            }

            for (int y = 0; y < current_height; y++) {
                tile_data[y * width + x] = temp_col[y];
            }
        }
    }

    free(temp_row);
    free(temp_col);
}

// 2D Haar wavelet inverse transform for arbitrary dimensions
// Used for delta coefficient reconstruction (inverse must be done in reverse order of levels)
static void dwt_2d_haar_inverse_flexible(tav_encoder_t *enc, float *tile_data, int width, int height, int levels) {
    const int max_size = (width > height) ? width : height;
    float *temp_row = malloc(max_size * sizeof(float));
    float *temp_col = malloc(max_size * sizeof(float));

    // Apply inverse transform in reverse order of levels
    for (int level = levels - 1; level >= 0; level--) {
        int current_width = enc->widths[level];
        int current_height = enc->heights[level];
        if (current_width < 1 || current_height < 1) continue;

        // Column inverse transform (vertical) - done first to reverse forward order
        for (int x = 0; x < current_width; x++) {
            for (int y = 0; y < current_height; y++) {
                temp_col[y] = tile_data[y * width + x];
            }

            dwt_haar_inverse_1d(temp_col, current_height);

            for (int y = 0; y < current_height; y++) {
                tile_data[y * width + x] = temp_col[y];
            }
        }

        // Row inverse transform (horizontal) - done second to reverse forward order
        for (int y = 0; y < current_height; y++) {
            for (int x = 0; x < current_width; x++) {
                temp_row[x] = tile_data[y * width + x];
            }

            dwt_haar_inverse_1d(temp_row, current_width);

            for (int x = 0; x < current_width; x++) {
                tile_data[y * width + x] = temp_row[x];
            }
        }
    }

    free(temp_row);
    free(temp_col);
}

// Significance Map v2.1 (twobit-map): 2 bits per coefficient
// 00=zero, 01=+1, 10=-1, 11=other (stored as int16)
static size_t preprocess_coefficients_twobitmap(int16_t *coeffs_y, int16_t *coeffs_co, int16_t *coeffs_cg, int16_t *coeffs_alpha,
                                                int coeff_count, int channel_layout, uint8_t *output_buffer) {
    const channel_layout_config_t *config = &channel_layouts[channel_layout];
    int map_bytes = (coeff_count * 2 + 7) / 8;  // 2 bits per coefficient
    int total_maps = config->num_channels;

    // Count "other" values (not 0, +1, or -1) per active channel
    int other_counts[4] = {0}; // Y, Co, Cg, Alpha
    for (int i = 0; i < coeff_count; i++) {
        if (config->has_y && coeffs_y) {
            int16_t val = coeffs_y[i];
            if (val != 0 && val != 1 && val != -1) other_counts[0]++;
        }
        if (config->has_co && coeffs_co) {
            int16_t val = coeffs_co[i];
            if (val != 0 && val != 1 && val != -1) other_counts[1]++;
        }
        if (config->has_cg && coeffs_cg) {
            int16_t val = coeffs_cg[i];
            if (val != 0 && val != 1 && val != -1) other_counts[2]++;
        }
        if (config->has_alpha && coeffs_alpha) {
            int16_t val = coeffs_alpha[i];
            if (val != 0 && val != 1 && val != -1) other_counts[3]++;
        }
    }

    // Layout maps in order based on channel layout
    uint8_t *maps[4];
    int map_idx = 0;
    if (config->has_y) maps[0] = output_buffer + map_bytes * map_idx++;
    if (config->has_co) maps[1] = output_buffer + map_bytes * map_idx++;
    if (config->has_cg) maps[2] = output_buffer + map_bytes * map_idx++;
    if (config->has_alpha) maps[3] = output_buffer + map_bytes * map_idx++;

    // Calculate value array positions (only for "other" values)
    int16_t *values[4];
    int16_t *value_start = (int16_t *)(output_buffer + map_bytes * total_maps);
    int value_offset = 0;
    if (config->has_y) { values[0] = value_start + value_offset; value_offset += other_counts[0]; }
    if (config->has_co) { values[1] = value_start + value_offset; value_offset += other_counts[1]; }
    if (config->has_cg) { values[2] = value_start + value_offset; value_offset += other_counts[2]; }
    if (config->has_alpha) { values[3] = value_start + value_offset; value_offset += other_counts[3]; }

    // Clear significance maps
    memset(output_buffer, 0, map_bytes * total_maps);

    // Fill twobit-maps and extract "other" values
    int value_indices[4] = {0};
    int16_t *channel_coeffs[4] = {coeffs_y, coeffs_co, coeffs_cg, coeffs_alpha};
    int channel_active[4] = {config->has_y, config->has_co, config->has_cg, config->has_alpha};

    for (int i = 0; i < coeff_count; i++) {
        for (int ch = 0; ch < 4; ch++) {
            if (!channel_active[ch] || !channel_coeffs[ch]) continue;

            int16_t val = channel_coeffs[ch][i];
            uint8_t code;

            if (val == 0) {
                code = 0;  // 00
            } else if (val == 1) {
                code = 1;  // 01
            } else if (val == -1) {
                code = 2;  // 10
            } else {
                code = 3;  // 11
                values[ch][value_indices[ch]++] = val;
            }

            // Store 2-bit code (interleaved)
            size_t bit_pos = i * 2;
            size_t byte_idx = bit_pos / 8;
            size_t bit_offset = bit_pos % 8;

            maps[ch][byte_idx] |= (code << bit_offset);

            // Handle byte boundary crossing
            if (bit_offset == 7 && byte_idx + 1 < map_bytes) {
                maps[ch][byte_idx + 1] |= (code >> 1);
            }
        }
    }

    // Return total size: maps + all "other" values
    int total_others = other_counts[0] + other_counts[1] + other_counts[2] + other_counts[3];
    return map_bytes * total_maps + total_others * sizeof(int16_t);
}

// Raw preprocessing: no encoding, just copy raw coefficients
static size_t preprocess_coefficients_raw(int16_t *coeffs_y, int16_t *coeffs_co, int16_t *coeffs_cg, int16_t *coeffs_alpha,
                                           int coeff_count, int channel_layout, uint8_t *output_buffer) {
    const channel_layout_config_t *config = &channel_layouts[channel_layout];
    size_t offset = 0;

    // Copy each active channel's coefficients directly to output buffer
    if (config->has_y && coeffs_y) {
        memcpy(output_buffer + offset, coeffs_y, coeff_count * sizeof(int16_t));
        offset += coeff_count * sizeof(int16_t);
    }
    if (config->has_co && coeffs_co) {
        memcpy(output_buffer + offset, coeffs_co, coeff_count * sizeof(int16_t));
        offset += coeff_count * sizeof(int16_t);
    }
    if (config->has_cg && coeffs_cg) {
        memcpy(output_buffer + offset, coeffs_cg, coeff_count * sizeof(int16_t));
        offset += coeff_count * sizeof(int16_t);
    }
    if (config->has_alpha && coeffs_alpha) {
        memcpy(output_buffer + offset, coeffs_alpha, coeff_count * sizeof(int16_t));
        offset += coeff_count * sizeof(int16_t);
    }

    return offset;
}

// EZBC preprocessing: encode each channel with embedded zero block coding
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

        // Encode this channel with EZBC
        uint8_t *ezbc_data = NULL;
        size_t ezbc_size = encode_channel_ezbc(channel_coeffs[ch], coeff_count, width, height, &ezbc_data);

        // Write size header (uint32_t) for this channel
        *((uint32_t*)write_ptr) = (uint32_t)ezbc_size;
        write_ptr += sizeof(uint32_t);
        total_size += sizeof(uint32_t);

        // Copy EZBC-encoded data
        memcpy(write_ptr, ezbc_data, ezbc_size);
        write_ptr += ezbc_size;
        total_size += ezbc_size;

        // Free EZBC buffer
        free(ezbc_data);
    }

    return total_size;
}

// Wrapper: select preprocessing mode based on encoder settings
static size_t preprocess_coefficients_variable_layout(preprocess_mode_t preprocess_mode, int width, int height,
                                                       int16_t *coeffs_y, int16_t *coeffs_co, int16_t *coeffs_cg, int16_t *coeffs_alpha,
                                                       int coeff_count, int channel_layout, uint8_t *output_buffer) {
    switch (preprocess_mode) {
        case PREPROCESS_EZBC:
            return preprocess_coefficients_ezbc(coeffs_y, coeffs_co, coeffs_cg, coeffs_alpha,
                                                 coeff_count, width, height, channel_layout, output_buffer);
        case PREPROCESS_RAW:
            return preprocess_coefficients_raw(coeffs_y, coeffs_co, coeffs_cg, coeffs_alpha,
                                                coeff_count, channel_layout, output_buffer);
        case PREPROCESS_TWOBITMAP:
        default:
            return preprocess_coefficients_twobitmap(coeffs_y, coeffs_co, coeffs_cg, coeffs_alpha,
                                                     coeff_count, channel_layout, output_buffer);
    }
}

// Unified GOP preprocessing: single significance map for all frames and channels
// Layout (twobit-map): [All_Y_maps][All_Co_maps][All_Cg_maps][All_Y_values][All_Co_values][All_Cg_values]
// Layout (EZBC): [frame0_size(4)][frame0_ezbc][frame1_size(4)][frame1_ezbc]...
// Layout (raw): [All_Y_coeffs][All_Co_coeffs][All_Cg_coeffs]
// This enables optimal cross-frame compression in the temporal dimension
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
    const int total_coeffs = num_pixels * num_frames;

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
                if (bit_offset == 7 && byte_idx + 1 < map_bytes_per_frame) {
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
                if (bit_offset == 7 && byte_idx + 1 < map_bytes_per_frame) {
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
                if (bit_offset == 7 && byte_idx + 1 < map_bytes_per_frame) {
                    cg_map[byte_idx + 1] |= (code >> 1);
                }
            }
        }
    }

    // Return total size
    return (size_t)(write_ptr - output_buffer);
}

// Quantisation for DWT subbands with rate control
static void quantise_dwt_coefficients(float *coeffs, int16_t *quantised, int size, int quantiser, float dead_zone_threshold, int width, int height, int decomp_levels, int is_chroma) {
    float effective_q = quantiser;
    effective_q = FCLAMP(effective_q, 1.0f, 4096.0f);

    for (int i = 0; i < size; i++) {
        float quantised_val = coeffs[i] / effective_q;

        // Apply dead-zone quantisation ONLY to luma channel and specific subbands
        // Chroma channels skip dead-zone (already heavily quantised, avoid colour banding)
        // Pattern: HH1 (full), LH1/HL1/HH2 (half), LH2/HL2 (none), others (none)
        // Note: Level 1 is finest (280x224), Level 6 is coarsest (8x7)
        if (dead_zone_threshold > 0.0f && !is_chroma) {
            int level = get_subband_level(i, width, height, decomp_levels);
            int subband_type = get_subband_type(i, width, height, decomp_levels);
            float level_threshold = 0.0f;

            if (level == 1) {
                // Finest level (level 1: 280x224)
                if (subband_type == 3) {
                    // HH1: full dead-zone
                    level_threshold = dead_zone_threshold * DEAD_ZONE_FINEST_SCALE;
                } else if (subband_type == 1 || subband_type == 2) {
                    // LH1, HL1: half dead-zone
                    level_threshold = dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
            } else if (level == 2) {
                // Second-finest level (level 2: 140x112)
                if (subband_type == 3) {
                    // HH2: half dead-zone
                    level_threshold = dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
                // LH2, HL2: no dead-zone
            }
            // Coarser levels (3-6): no dead-zone to preserve structural information

            if (fabsf(quantised_val) <= level_threshold) {
                quantised_val = 0.0f;
            }
        }

        quantised[i] = (int16_t)CLAMP((int)(quantised_val + (quantised_val >= 0 ? 0.5f : -0.5f)), -32768, 32767);
    }
}

// https://www.desmos.com/calculator/mjlpwqm8ge
static float perceptual_model3_LH(int quality, float level) {
    float H4 = 1.2f;
    float K = 2.f; // using fixed value for fixed curve; quantiser will scale it up anyway
    float K12 = K * 12.f;
    float x = level;

    float Lx = H4 - ((K + 1.f) / 15.f) * (x - 4.f);
    float C3 = -1.f / 45.f * (K12 + 92);
    float G3x = (-x / 180.f) * (K12 + 5*x*x - 60*x + 252) - C3 + H4;

    return (level >= 4) ? Lx : G3x;
}

static float perceptual_model3_HL(int quality, float LH) {
    return fmaf(LH, ANISOTROPY_MULT[quality], ANISOTROPY_BIAS[quality]);
}

static float lerp(float x, float y, float a) {
    return x * (1.f - a) + y * a;
}

static float perceptual_model3_HH(float LH, float HL, float level) {
    float Kx = fmaf((sqrtf(level) - 1.f), 0.5f, 0.5f);
    return lerp(LH, HL, Kx);
}


/*static float perceptual_model3_HH(float LH, float HL, float level) {
    return (HL / LH) * 1.44f;
}*/

static float perceptual_model3_LL(int quality, float level) {
    float n = perceptual_model3_LH(quality, level);
    float m = perceptual_model3_LH(quality, level - 1) / n;

    return n / m;
}

static float perceptual_model3_chroma_basecurve(int quality, float level) {
    return 1.0f - (1.0f / (0.5f * quality * quality + 1.0f)) * (level - 4.0f); // just a line that passes (4,1)
}

#define FOUR_PIXEL_DETAILER 0.88f
#define TWO_PIXEL_DETAILER  0.92f

// level is one-based index
static float get_perceptual_weight(tav_encoder_t *enc, int level0, int subband_type, int is_chroma, int max_levels) {
    // Psychovisual model based on DWT coefficient statistics and Human Visual System sensitivity

    float level = 1.0f + ((level0 - 1.0f) / (max_levels - 1.0f)) * 5.0f;

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
            return HL * (2.2f >= level && level >= 1.8f ? TWO_PIXEL_DETAILER : 3.2f >= level && level >= 2.8f ? FOUR_PIXEL_DETAILER : 1.0f);

        // HH subband - diagonal details
        else return perceptual_model3_HH(LH, HL, level) * (2.2f >= level && level >= 1.8f ? TWO_PIXEL_DETAILER : 3.2f >= level && level >= 2.8f ? FOUR_PIXEL_DETAILER : 1.0f);
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


// Get decomposition level and subband type for coefficient at 2D spatial position
// Coefficients are stored in 2D spatial (quad-tree) layout, not linear subband layout
// Returns: level (1=finest to decomp_levels=coarsest, 0 for LL)
static int get_subband_level_2d(int x, int y, int width, int height, int decomp_levels) {
    // Recursively determine which level this coefficient belongs to
    // by checking which quadrant it's in at each level

    for (int level = 1; level <= decomp_levels; level++) {
        int half_w = width >> 1;
        int half_h = height >> 1;

        // Check if in top-left quadrant (LL - contains finer levels)
        if (x < half_w && y < half_h) {
            // Continue to finer level
            width = half_w;
            height = half_h;
            continue;
        }

        // In one of the detail bands (LH, HL, HH) at this level
        return level;
    }

    // Reached LL subband at coarsest level
    return 0;
}

// Get subband type for coefficient at 2D spatial position
// Returns: 0=LL, 1=LH, 2=HL, 3=HH
static int get_subband_type_2d(int x, int y, int width, int height, int decomp_levels) {
    // Recursively determine which subband this coefficient belongs to

    for (int level = 1; level <= decomp_levels; level++) {
        int half_w = width >> 1;
        int half_h = height >> 1;

        // Check if in top-left quadrant (LL - contains finer levels)
        if (x < half_w && y < half_h) {
            // Continue to finer level
            width = half_w;
            height = half_h;
            continue;
        }

        // Determine which detail band at this level
        if (x >= half_w && y < half_h) {
            return 1; // LH (top-right)
        } else if (x < half_w && y >= half_h) {
            return 2; // HL (bottom-left)
        } else {
            return 3; // HH (bottom-right)
        }
    }

    // Reached LL subband at coarsest level
    return 0;
}

// Legacy functions kept for compatibility - convert linear index to 2D coords
static int get_subband_level(int linear_idx, int width, int height, int decomp_levels) {
    int x = linear_idx % width;
    int y = linear_idx / width;
    return get_subband_level_2d(x, y, width, height, decomp_levels);
}

static int get_subband_type(int linear_idx, int width, int height, int decomp_levels) {
    int x = linear_idx % width;
    int y = linear_idx / width;
    return get_subband_type_2d(x, y, width, height, decomp_levels);
}

static float get_perceptual_weight_for_position(tav_encoder_t *enc, int linear_idx, int width, int height, int decomp_levels, int is_chroma) {
    // Map linear coefficient index to DWT subband using same layout as decoder
    int offset = 0;

    // First: LL subband at maximum decomposition level
    int ll_width = enc->widths[decomp_levels];
    int ll_height = enc->heights[decomp_levels];
    int ll_size = ll_width * ll_height;

    if (linear_idx < offset + ll_size) {
        // LL subband at maximum level - use get_perceptual_weight for consistency
        return get_perceptual_weight(enc, decomp_levels, 0, is_chroma, decomp_levels);
    }
    offset += ll_size;

    // Then: LH, HL, HH subbands for each level from max down to 1
    for (int level = decomp_levels; level >= 1; level--) {
        int level_width = enc->widths[decomp_levels - level + 1];
        int level_height = enc->heights[decomp_levels - level + 1];
        const int subband_size = level_width * level_height;

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

// Apply perceptual quantisation per-coefficient (same loop as uniform but with spatial weights)
static void quantise_dwt_coefficients_perceptual_per_coeff(tav_encoder_t *enc,
                                                          float *coeffs, int16_t *quantised, int size,
                                                          int base_quantiser, int width, int height,
                                                          int decomp_levels, int is_chroma, int frame_count) {
    // EXACTLY the same approach as uniform quantisation but apply weight per coefficient
    float effective_base_q = base_quantiser;
    effective_base_q = FCLAMP(effective_base_q, 1.0f, 4096.0f);

    for (int i = 0; i < size; i++) {
        // Apply perceptual weight based on coefficient's position in DWT layout
        float weight = get_perceptual_weight_for_position(enc, i, width, height, decomp_levels, is_chroma);
        float effective_q = effective_base_q * weight;
        float quantised_val = coeffs[i] / effective_q;

        // Apply dead-zone quantisation ONLY to luma channel and specific subbands
        // Chroma channels skip dead-zone (already heavily quantised, avoid colour banding)
        // Pattern: HH1 (full), LH1/HL1/HH2 (half), LH2/HL2 (none), others (none)
        // Note: Level 1 is finest (280x224), Level 6 is coarsest (8x7)
        if (enc->dead_zone_threshold > 0.0f && !is_chroma) {
            int level = get_subband_level(i, width, height, decomp_levels);
            int subband_type = get_subband_type(i, width, height, decomp_levels);
            float level_threshold = 0.0f;

            if (level == 1) {
                // Finest level (level 1: 280x224)
                if (subband_type == 3) {
                    // HH1: full dead-zone
                    level_threshold = enc->dead_zone_threshold * DEAD_ZONE_FINEST_SCALE;
                } else if (subband_type == 1 || subband_type == 2) {
                    // LH1, HL1: half dead-zone
                    level_threshold = enc->dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
            } else if (level == 2) {
                // Second-finest level (level 2: 140x112)
                if (subband_type == 3) {
                    // HH2: half dead-zone
                    level_threshold = enc->dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
                // LH2, HL2: no dead-zone
            }
            // Coarser levels (3-6): no dead-zone to preserve structural information

            if (fabsf(quantised_val) <= level_threshold) {
                quantised_val = 0.0f;
            }
        }

        quantised[i] = (int16_t)CLAMP((int)(quantised_val + (quantised_val >= 0 ? 0.5f : -0.5f)), -32768, 32767);
    }
}

// Quantisation for EZBC mode: quantises to discrete levels but doesn't normalise (shrink) values
// This reduces coefficient precision while preserving magnitude for EZBC's bitplane encoding
static void quantise_dwt_coefficients_perceptual_per_coeff_no_normalisation(tav_encoder_t *enc,
                                                          float *coeffs, int16_t *quantised, int size,
                                                          int base_quantiser, int width, int height,
                                                          int decomp_levels, int is_chroma, int frame_count) {
    (void)frame_count;  // Unused parameter

    float effective_base_q = base_quantiser;
    effective_base_q = FCLAMP(effective_base_q, 1.0f, 4096.0f);

    for (int i = 0; i < size; i++) {
        // Apply perceptual weight based on coefficient's position in DWT layout
        float weight = get_perceptual_weight_for_position(enc, i, width, height, decomp_levels, is_chroma);
        float effective_q = effective_base_q * weight;

        // Step 1: Quantise - divide by quantiser to get normalised value
        float quantised_val = coeffs[i] / effective_q;

        // Step 2: Apply dead-zone quantisation to normalised value
        if (enc->dead_zone_threshold > 0.0f && !is_chroma) {
            int level = get_subband_level(i, width, height, decomp_levels);
            int subband_type = get_subband_type(i, width, height, decomp_levels);
            float level_threshold = 0.0f;

            if (level == 1) {
                // Finest level (level 1: 280x224)
                if (subband_type == 3) {
                    // HH1: full dead-zone
                    level_threshold = enc->dead_zone_threshold * DEAD_ZONE_FINEST_SCALE;
                } else if (subband_type == 1 || subband_type == 2) {
                    // LH1, HL1: half dead-zone
                    level_threshold = enc->dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
            } else if (level == 2) {
                // Second-finest level (level 2: 140x112)
                if (subband_type == 3) {
                    // HH2: half dead-zone
                    level_threshold = enc->dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
                // LH2, HL2: no dead-zone
            }
            // Coarser levels (3-6): no dead-zone to preserve structural information

            if (fabsf(quantised_val) <= level_threshold) {
                quantised_val = 0.0f;
            }
        }

        // Step 3: Round to discrete quantisation levels
        quantised_val = roundf(quantised_val); // file size explodes without rounding

        // FIX: Store normalised values (not denormalised) to avoid int16_t overflow
        // EZBC bitplane encoding works fine with normalised coefficients
        // Denormalisation was causing bright pixels to clip at 32767
        quantised[i] = (int16_t)CLAMP((int)quantised_val, -32768, 32767);

        // Debug: Print LL subband coefficients (9×7 at top-left for 560×448)
        /*static int debug_once = 1;
        if (debug_once && i < 63 && width == 560 && !is_chroma) {
            int x = i % width;
            int y = i / width;
            if (x < 9 && y < 7) {
                fprintf(stderr, "[EZBC-QUANT-DEBUG] LL coeff[%d,%d] (idx=%d): coeff=%.1f, weight=%.3f, effective_q=%.1f, quantised_val=%.1f, stored=%d\n",
                        x, y, i, coeffs[i], weight, effective_q, quantised_val, quantised[i]);
                if (i == 62) debug_once = 0;
            }
        }*/
    }
}

// Serialise tile data for compression
static size_t serialise_tile_data(tav_encoder_t *enc, int tile_x, int tile_y,
                                  const float *tile_y_data, const float *tile_co_data, const float *tile_cg_data,
                                  uint8_t mode, uint8_t *buffer) {
    size_t offset = 0;

    // Write tile header with Haar level encoded in upper nibble for DELTA mode
    // Mode encoding: base_mode | ((haar_level - 1) << 4)
    // - level 1: 0x02, level 2: 0x12, level 3: 0x22
    uint8_t encoded_mode = mode;
    if (mode == TAV_MODE_DELTA && enc->delta_haar_levels >= 1) {
        encoded_mode = mode | ((enc->delta_haar_levels - 1) << 4);
    }
    buffer[offset++] = encoded_mode;

    // Use adjusted quantiser from bitrate control, or base quantiser if not in bitrate mode
    int qY_override = enc->bitrate_mode ? quantiser_float_to_int_dithered(enc) : enc->quantiser_y;

    buffer[offset++] = (!enc->bitrate_mode) ? 0 : qY_override + 1; // qY override; must be stored with bias of 1
    buffer[offset++] = 0; // qCo override, currently unused
    buffer[offset++] = 0; // qCg override, currently unused

    int this_frame_qY =  QLUT[qY_override];
    int this_frame_qCo = QLUT[enc->quantiser_co];
    int this_frame_qCg = QLUT[enc->quantiser_cg];

    if (mode == TAV_MODE_SKIP) {
        // No coefficient data for SKIP/MOTION modes
        return offset;
    }

    // Quantise and serialise DWT coefficients
    const int tile_size = enc->monoblock ?
        (enc->width * enc->height) :  // Monoblock mode: full frame
        (PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y);  // Standard mode: padded tiles
    // OPTIMISATION: Use pre-allocated buffers instead of malloc/free per tile
    int16_t *quantised_y = enc->reusable_quantised_y;
    int16_t *quantised_co = enc->reusable_quantised_co;
    int16_t *quantised_cg = enc->reusable_quantised_cg;
    int16_t *quantised_alpha = enc->reusable_quantised_alpha;

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
        if (enc->preprocess_mode == PREPROCESS_EZBC) {
            // EZBC mode: Quantise with perceptual weighting but no normalisation (division by quantiser)
//            fprintf(stderr, "[EZBC-QUANT-INTRA] Using perceptual quantisation without normalisation\n");
            quantise_dwt_coefficients_perceptual_per_coeff_no_normalisation(enc, (float*)tile_y_data, quantised_y, tile_size, this_frame_qY, enc->width, enc->height, enc->decomp_levels, 0, enc->frame_count);
            quantise_dwt_coefficients_perceptual_per_coeff_no_normalisation(enc, (float*)tile_co_data, quantised_co, tile_size, this_frame_qCo, enc->width, enc->height, enc->decomp_levels, 1, enc->frame_count);
            quantise_dwt_coefficients_perceptual_per_coeff_no_normalisation(enc, (float*)tile_cg_data, quantised_cg, tile_size, this_frame_qCg, enc->width, enc->height, enc->decomp_levels, 1, enc->frame_count);

            // Print max abs for debug
            int max_y = 0, max_co = 0, max_cg = 0;
            for (int i = 0; i < tile_size; i++) {
                if (abs(quantised_y[i]) > max_y) max_y = abs(quantised_y[i]);
                if (abs(quantised_co[i]) > max_co) max_co = abs(quantised_co[i]);
                if (abs(quantised_cg[i]) > max_cg) max_cg = abs(quantised_cg[i]);
            }
//            fprintf(stderr, "[EZBC-QUANT-INTRA] Quantised coeff max: Y=%d, Co=%d, Cg=%d\n", max_y, max_co, max_cg);
        } else if (enc->perceptual_tuning) {
            // Perceptual quantisation: EXACTLY like uniform but with per-coefficient weights
            quantise_dwt_coefficients_perceptual_per_coeff(enc, (float*)tile_y_data, quantised_y, tile_size, this_frame_qY, enc->width, enc->height, enc->decomp_levels, 0, enc->frame_count);
            quantise_dwt_coefficients_perceptual_per_coeff(enc, (float*)tile_co_data, quantised_co, tile_size, this_frame_qCo, enc->width, enc->height, enc->decomp_levels, 1, enc->frame_count);
            quantise_dwt_coefficients_perceptual_per_coeff(enc, (float*)tile_cg_data, quantised_cg, tile_size, this_frame_qCg, enc->width, enc->height, enc->decomp_levels, 1, enc->frame_count);
        } else {
            // Legacy uniform quantisation
            quantise_dwt_coefficients((float*)tile_y_data, quantised_y, tile_size, this_frame_qY, enc->dead_zone_threshold, enc->width, enc->height, enc->decomp_levels, 0);
            quantise_dwt_coefficients((float*)tile_co_data, quantised_co, tile_size, this_frame_qCo, enc->dead_zone_threshold, enc->width, enc->height, enc->decomp_levels, 1);
            quantise_dwt_coefficients((float*)tile_cg_data, quantised_cg, tile_size, this_frame_qCg, enc->dead_zone_threshold, enc->width, enc->height, enc->decomp_levels, 1);
        }

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

        // Apply Haar DWT to deltas if enabled (improves compression of sparse deltas)
        if (enc->delta_haar_levels > 0) {
            int tile_width, tile_height;
            if (enc->monoblock) {
                tile_width = enc->width;
                tile_height = enc->height;
            } else {
                tile_width = PADDED_TILE_SIZE_X;
                tile_height = PADDED_TILE_SIZE_Y;
            }
            dwt_2d_forward_flexible(enc, delta_y, tile_width, tile_height, enc->delta_haar_levels, WAVELET_HAAR);
            dwt_2d_forward_flexible(enc, delta_co, tile_width, tile_height, enc->delta_haar_levels, WAVELET_HAAR);
            dwt_2d_forward_flexible(enc, delta_cg, tile_width, tile_height, enc->delta_haar_levels, WAVELET_HAAR);
        }

        // Quantise the deltas with uniform quantisation (perceptual tuning is for original coefficients, not deltas)
        quantise_dwt_coefficients(delta_y, quantised_y, tile_size, this_frame_qY, enc->dead_zone_threshold, enc->width, enc->height, enc->decomp_levels, 0);
        quantise_dwt_coefficients(delta_co, quantised_co, tile_size, this_frame_qCo, enc->dead_zone_threshold, enc->width, enc->height, enc->decomp_levels, 1);
        quantise_dwt_coefficients(delta_cg, quantised_cg, tile_size, this_frame_qCg, enc->dead_zone_threshold, enc->width, enc->height, enc->decomp_levels, 1);

        // Reconstruct coefficients like decoder will (previous + uniform_dequantised_delta)
        for (int i = 0; i < tile_size; i++) {
            float dequant_delta_y = (float)quantised_y[i] * this_frame_qY;
            float dequant_delta_co = (float)quantised_co[i] * this_frame_qCo;
            float dequant_delta_cg = (float)quantised_cg[i] * this_frame_qCg;

            delta_y[i] = dequant_delta_y;
            delta_co[i] = dequant_delta_co;
            delta_cg[i] = dequant_delta_cg;
        }

        // Apply inverse Haar DWT to reconstructed deltas if enabled
        if (enc->delta_haar_levels > 0) {
            int tile_width, tile_height;
            if (enc->monoblock) {
                tile_width = enc->width;
                tile_height = enc->height;
            } else {
                tile_width = PADDED_TILE_SIZE_X;
                tile_height = PADDED_TILE_SIZE_Y;
            }
            dwt_2d_haar_inverse_flexible(enc, delta_y, tile_width, tile_height, enc->delta_haar_levels);
            dwt_2d_haar_inverse_flexible(enc, delta_co, tile_width, tile_height, enc->delta_haar_levels);
            dwt_2d_haar_inverse_flexible(enc, delta_cg, tile_width, tile_height, enc->delta_haar_levels);
        }

        // Add reconstructed deltas to previous coefficients
        for (int i = 0; i < tile_size; i++) {
            prev_y[i] = prev_y[i] + delta_y[i];
            prev_co[i] = prev_co[i] + delta_co[i];
            prev_cg[i] = prev_cg[i] + delta_cg[i];
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

    // Preprocess and write quantised coefficients using variable channel layout concatenated significance maps
    size_t total_compressed_size = preprocess_coefficients_variable_layout(enc->preprocess_mode, enc->width, enc->height,
                                                                           quantised_y, quantised_co, quantised_cg, NULL,
                                                                           tile_size, enc->channel_layout, buffer + offset);
    offset += total_compressed_size;

    // DEBUG: Dump raw DWT coefficients for specified frame when it's an intra-frame
    if (!debugDumpMade && debugDumpFrameTarget >= 0 &&
        enc->frame_count >= debugDumpFrameTarget - 1 && enc->frame_count <= debugDumpFrameTarget + 2 &&
        (mode == TAV_MODE_INTRA)) {

        char filename[256];
        size_t data_size = tile_size * sizeof(int16_t);

        // Dump Y channel coefficients
        snprintf(filename, sizeof(filename), "frame_%03d.tavframe.y.bin", enc->frame_count);
        FILE *debug_fp = fopen(filename, "wb");
        if (debug_fp) {
            fwrite(quantised_y, 1, data_size, debug_fp);
            fclose(debug_fp);
            printf("DEBUG: Dumped Y coefficients to %s (%zu bytes)\n", filename, data_size);
        }

        // Dump Co channel coefficients
        snprintf(filename, sizeof(filename), "frame_%03d.tavframe.co.bin", enc->frame_count);
        debug_fp = fopen(filename, "wb");
        if (debug_fp) {
            fwrite(quantised_co, 1, data_size, debug_fp);
            fclose(debug_fp);
            printf("DEBUG: Dumped Co coefficients to %s (%zu bytes)\n", filename, data_size);
        }

        // Dump Cg channel coefficients
        snprintf(filename, sizeof(filename), "frame_%03d.tavframe.cg.bin", enc->frame_count);
        debug_fp = fopen(filename, "wb");
        if (debug_fp) {
            fwrite(quantised_cg, 1, data_size, debug_fp);
            fclose(debug_fp);
            printf("DEBUG: Dumped Cg coefficients to %s (%zu bytes)\n", filename, data_size);
        }

        printf("DEBUG: Frame %d - Dumped all %zu coefficient bytes per channel (total: %zu bytes)\n",
               enc->frame_count, data_size, data_size * 3);

        debugDumpMade = 1;
    }


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

    // Use cached still frame detection result (set in main loop)
    int is_still_frame = enc->is_still_frame_cached;

    // Serialise all tiles
    for (int tile_y = 0; tile_y < enc->tiles_y; tile_y++) {
        for (int tile_x = 0; tile_x < enc->tiles_x; tile_x++) {

            // Determine tile mode based on frame type, coefficient availability, and intra_only flag
            uint8_t mode;
            int is_keyframe = (packet_type == TAV_PACKET_IFRAME);

            // SKIP mode condition matches main loop logic: still frame during SKIP run
            int can_use_skip = is_still_frame && enc->previous_coeffs_allocated;

            if (is_keyframe || !enc->previous_coeffs_allocated) {
                mode = TAV_MODE_INTRA;  // I-frames, first frames, or intra-only mode always use INTRA
                count_intra++;
            } else if (can_use_skip) {
                mode = TAV_MODE_SKIP;   // Still frames in SKIP run use SKIP mode
                count_skip++;
                if (enc->verbose && tile_x == 0 && tile_y == 0) {
                    printf("  → Using SKIP mode (copying from reference I-frame)\n");
                }
            } else if (enc->use_delta_encoding) {
                mode = TAV_MODE_DELTA;  // P-frames use coefficient delta encoding
                count_delta++;
            } else {
                // Delta encoding disabled: use INTRA mode (packet_type is already I-frame from main loop)
                mode = TAV_MODE_INTRA;
                count_intra++;
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

            // Skip processing for SKIP mode - decoder will copy from reference
            if (mode != TAV_MODE_SKIP) {
                if (enc->monoblock) {
                    // Extract entire frame (no padding)
                    memcpy(tile_y_data, enc->current_frame_y, tile_data_size * sizeof(float));
                    memcpy(tile_co_data, enc->current_frame_co, tile_data_size * sizeof(float));
                    memcpy(tile_cg_data, enc->current_frame_cg, tile_data_size * sizeof(float));
                } else {
                    // Extract padded tiles using context from neighbours
                    extract_padded_tile(enc, tile_x, tile_y, tile_y_data, tile_co_data, tile_cg_data);
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

            // Apply DWT transform to each channel (skip for SKIP mode)
            if (mode != TAV_MODE_SKIP) {
                if (enc->monoblock) {
                    // Monoblock mode: transform entire frame
                    dwt_2d_forward_flexible(enc, tile_y_data, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
                    dwt_2d_forward_flexible(enc, tile_co_data, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
                    dwt_2d_forward_flexible(enc, tile_cg_data, enc->width, enc->height, enc->decomp_levels, enc->wavelet_filter);
                } else {
                    // Standard mode: transform padded tiles (344x288)
                    dwt_2d_forward_padded(tile_y_data, enc->decomp_levels, enc->wavelet_filter);
                    dwt_2d_forward_padded(tile_co_data, enc->decomp_levels, enc->wavelet_filter);
                    dwt_2d_forward_padded(tile_cg_data, enc->decomp_levels, enc->wavelet_filter);
                }
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
                                           uncompressed_buffer, uncompressed_offset, enc->zstd_level);

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

    // Track last frame type for SKIP mode eligibility
    enc->last_frame_packet_type = packet_type;

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

// RGBA to colour space conversion for full frames with alpha channel
static void rgba_to_colour_space_frame(tav_encoder_t *enc, const uint8_t *rgba,
                                     float *c1, float *c2, float *c3, float *alpha,
                                     int width, int height) {
    const int total_pixels = width * height;

    if (enc->ictcp_mode) {
        // ICtCp mode with alpha
        for (int i = 0; i < total_pixels; i++) {
            double I, Ct, Cp;
            srgb8_to_ictcp_hlg(rgba[i*4], rgba[i*4+1], rgba[i*4+2], &I, &Ct, &Cp);
            c1[i] = (float)I;
            c2[i] = (float)Ct;
            c3[i] = (float)Cp;
            alpha[i] = (float)rgba[i*4+3] / 255.0f; // Normalise alpha to [0,1]
        }
    } else {
        // YCoCg mode with alpha - extract RGB first, then convert
        uint8_t *temp_rgb = malloc(total_pixels * 3);
        for (int i = 0; i < total_pixels; i++) {
            temp_rgb[i*3] = rgba[i*4];     // R
            temp_rgb[i*3+1] = rgba[i*4+1]; // G
            temp_rgb[i*3+2] = rgba[i*4+2]; // B
            alpha[i] = (float)rgba[i*4+3] / 255.0f; // Normalise alpha to [0,1]
        }
        rgb_to_ycocg(temp_rgb, c1, c2, c3, width, height);
        free(temp_rgb);
    }
}
// Write font ROM upload packet (SSF format)
static int write_fontrom_packet(FILE *fp, const char *filename, uint8_t opcode) {
    if (!filename || !fp) return 0;

    FILE *rom_file = fopen(filename, "rb");
    if (!rom_file) {
        fprintf(stderr, "Warning: Could not open font ROM file: %s\n", filename);
        return -1;
    }

    // Get file size
    fseek(rom_file, 0, SEEK_END);
    long file_size = ftell(rom_file);
    fseek(rom_file, 0, SEEK_SET);

    if (file_size > 1920) {
        fprintf(stderr, "Warning: Font ROM file too large (max 1920 bytes): %s\n", filename);
        fclose(rom_file);
        return -1;
    }

    // Read font data
    uint8_t *font_data = malloc(file_size);
    if (!font_data) {
        fprintf(stderr, "Error: Could not allocate memory for font ROM\n");
        fclose(rom_file);
        return -1;
    }

    size_t bytes_read = fread(font_data, 1, file_size, rom_file);
    fclose(rom_file);

    if (bytes_read != file_size) {
        fprintf(stderr, "Warning: Could not read entire font ROM file: %s\n", filename);
        free(font_data);
        return -1;
    }

    // Write SSF packet
    // Packet type: 0x30 (subtitle/SSF)
    fputc(0x30, fp);

    // Calculate packet size: 3 (index) + 1 (opcode) + 2 (length) + file_size + 1 (terminator)
    uint32_t packet_size = 3 + 1 + 2 + file_size + 1;

    // Write packet size (uint32, little-endian)
    fputc(packet_size & 0xFF, fp);
    fputc((packet_size >> 8) & 0xFF, fp);
    fputc((packet_size >> 16) & 0xFF, fp);
    fputc((packet_size >> 24) & 0xFF, fp);

    // SSF payload:
    // uint24 index (3 bytes) - use 0 for font ROM uploads
    fputc(0, fp);
    fputc(0, fp);
    fputc(0, fp);

    // uint8 opcode (0x80 = low font ROM, 0x81 = high font ROM)
    fputc(opcode, fp);

    // uint16 payload length (little-endian)
    uint16_t payload_len = (uint16_t)file_size;
    fputc(payload_len & 0xFF, fp);
    fputc((payload_len >> 8) & 0xFF, fp);

    // Font data
    fwrite(font_data, 1, file_size, fp);

    // Terminator
    fputc(0x00, fp);

    free(font_data);

    printf("Font ROM uploaded: %s (%ld bytes, opcode 0x%02X)\n", filename, file_size, opcode);
    return 0;
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
        if (enc->perceptual_tuning) {
            version = enc->ictcp_mode ? 8 : 7;
        } else {
            version = enc->ictcp_mode ? 2 : 1;
        }
    }
    fputc(version, enc->output_fp);

    // Video parameters
    // For interlaced: enc->height is already halved internally, so double it back for display height
    uint16_t height = enc->progressive_mode ? enc->height : enc->height * 2;
    fwrite(&enc->width, sizeof(uint16_t), 1, enc->output_fp);
    fwrite(&height, sizeof(uint16_t), 1, enc->output_fp);
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
    if (!enc->progressive_mode) video_flags |= 0x01;  // Interlaced
    if (enc->is_ntsc_framerate) video_flags |= 0x02;  // NTSC
    if (enc->lossless) video_flags |= 0x04;  // Lossless
    fputc(video_flags, enc->output_fp);

    fputc(enc->quality_level+1, enc->output_fp);
    fputc(enc->channel_layout, enc->output_fp);

    // Entropy Coder (0 = Twobit-map, 1 = EZBC, 2 = Raw)
    fputc(enc->preprocess_mode, enc->output_fp);

    // Reserved bytes (2 bytes)
    fputc(0, enc->output_fp);
    fputc(0, enc->output_fp);

    // Device Orientation (default: 0 = no rotation)
    fputc(0, enc->output_fp);

    // File Role (0 = generic)
    fputc(0, enc->output_fp);

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

// Get FFmpeg version string (first line before copyright)
static char* get_ffmpeg_version(void) {
    char *output = execute_command("ffmpeg -version 2>&1 | head -1");
    if (!output) return NULL;

    // Trim trailing newline
    size_t len = strlen(output);
    while (len > 0 && (output[len-1] == '\n' || output[len-1] == '\r')) {
        output[len-1] = '\0';
        len--;
    }

    return output;  // Caller must free
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
    if (config->progressive_mode) {
        fprintf(stderr, "  Resolution: %dx%d\n", config->width, config->height);
    } else {
        fprintf(stderr, "  Resolution: %dx%d (interlaced)\n", config->width, config->height);
    }
    return 1;
}

// Start FFmpeg process for video conversion with frame rate support
static int start_video_conversion(tav_encoder_t *enc) {
    char command[2048];

    // Build FFmpeg command with potential frame rate conversion and interlacing support
    if (enc->progressive_mode) {
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
    // Let FFmpeg handle the interlacing
    } else {
        if (enc->output_fps > 0 && enc->output_fps != enc->fps) {
            // Frame rate conversion requested
            // filtergraph path:
            // 1. FPS conversion
            // 2. scale and crop to requested size
            // 3. tinterlace weave-overwrites even and odd fields together to produce intermediate video at half framerate, full height (we're losing half the information here -- and that's on purpose)
            // 4. separatefields separates weave-overwritten frame as two consecutive frames, at half height. Since the frame rate is halved in Step 3. and being doubled here, the final framerate is identical to given framerate
            enc->is_ntsc_framerate = 0;
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
        fprintf(stderr, "Failed to start FFmpeg video conversion\n");
        return 0;
    }

    return 1;
}

// Start audio conversion
static int start_audio_conversion(tav_encoder_t *enc) {
    if (!enc->has_audio) return 1;

    char command[2048];

    if (enc->pcm8_audio || enc->tad_audio) {
        // Extract Float32LE for PCM8/TAD32 mode
        if (enc->pcm8_audio) {
            printf("  Audio format: Float32LE 32kHz stereo (will be converted to 8-bit PCM)\n");
        } else {
            printf("  Audio format: Float32LE 32kHz stereo (will be encoded with TAD32 codec)\n");
        }
        snprintf(command, sizeof(command),
            "ffmpeg -v quiet -i \"%s\" -f f32le -acodec pcm_f32le -ar %d -ac 2 -af \"aresample=resampler=soxr:precision=28:cutoff=0.99:dither_scale=0,highpass=f=16\" -y \"%s\" 2>/dev/null",
            enc->input_file, TSVM_AUDIO_SAMPLE_RATE, TEMP_PCM_FILE);

        int result = system(command);
        if (result == 0) {
            enc->pcm_file = fopen(TEMP_PCM_FILE, "rb");
            if (enc->pcm_file) {
                fseek(enc->pcm_file, 0, SEEK_END);
                enc->audio_remaining = ftell(enc->pcm_file);
                fseek(enc->pcm_file, 0, SEEK_SET);

                // Calculate samples per frame: ceil(sample_rate / fps)
                enc->samples_per_frame = (TSVM_AUDIO_SAMPLE_RATE + enc->output_fps - 1) / enc->output_fps;

                // Initialise 2nd-order noise shaping error history
                enc->dither_error[0][0] = 0.0f;
                enc->dither_error[0][1] = 0.0f;
                enc->dither_error[1][0] = 0.0f;
                enc->dither_error[1][1] = 0.0f;

                if (enc->verbose) {
                    printf("  PCM8: %d samples per frame\n", enc->samples_per_frame);
                }
            }
            return 1;
        }
        return 0;
    } else {
        // Extract MP2 for normal mode
        int bitrate;
        if (enc->audio_bitrate > 0) {
            bitrate = enc->audio_bitrate;
        } else {
            bitrate = enc->lossless ? 384 : MP2_RATE_TABLE[enc->quality_level];
        }
        printf("  Audio format: MP2 %dkbps (via libtwolame)\n", bitrate);
        snprintf(command, sizeof(command),
            "ffmpeg -v quiet -i \"%s\" -acodec libtwolame -psymodel 4 -b:a %dk -ar %d -ac 2 -y \"%s\" 2>/dev/null",
            enc->input_file, bitrate, TSVM_AUDIO_SAMPLE_RATE, TEMP_AUDIO_FILE);

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

// Convert SRT time format directly to nanoseconds (for SSF-TC timecode)
static uint64_t srt_time_to_ns(const char *time_str) {
    int hours, minutes, seconds, milliseconds;
    if (sscanf(time_str, "%d:%d:%d,%d", &hours, &minutes, &seconds, &milliseconds) != 4) {
        return 0;
    }

    // Calculate total time in nanoseconds
    uint64_t total_ns = 0;
    total_ns += (uint64_t)hours * 3600ULL * 1000000000ULL;      // hours to nanoseconds
    total_ns += (uint64_t)minutes * 60ULL * 1000000000ULL;      // minutes to nanoseconds
    total_ns += (uint64_t)seconds * 1000000000ULL;              // seconds to nanoseconds
    total_ns += (uint64_t)milliseconds * 1000000ULL;            // milliseconds to nanoseconds

    return total_ns;
}

// Convert SAMI milliseconds to frame number
static int sami_ms_to_frame(int milliseconds, int fps) {
    double seconds = milliseconds / 1000.0;
    return (int)(seconds * fps + 0.5);  // Round to nearest frame
}

// Convert SAMI milliseconds to nanoseconds (for SSF-TC timecode)
static uint64_t sami_ms_to_ns(int milliseconds) {
    return (uint64_t)milliseconds * 1000000ULL;
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
                current_entry->start_time_ns = srt_time_to_ns(start_time);
                current_entry->end_time_ns = srt_time_to_ns(end_time);

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
                        entry->start_time_ns = sami_ms_to_ns(start_ms);
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
                                        entry->end_time_ns = sami_ms_to_ns(next_ms);
                                    } else {
                                        entry->end_frame = entry->start_frame + fps * 3;  // 3 second default
                                        entry->end_time_ns = entry->start_time_ns + 3000000000ULL;  // 3 seconds in ns
                                    }
                                }
                            }
                        } else {
                            entry->end_frame = entry->start_frame + fps * 3;  // 3 second default
                            entry->end_time_ns = entry->start_time_ns + 3000000000ULL;  // 3 seconds in ns
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
// Write SSF-TC subtitle packet to output
static int write_subtitle_packet_tc(FILE *output, uint32_t index, uint8_t opcode, const char *text, uint64_t timecode_ns) {
    // Calculate packet size: index (3 bytes) + timecode (8 bytes) + opcode (1 byte) + text + null terminator
    size_t text_len = text ? strlen(text) : 0;
    size_t packet_size = 3 + 8 + 1 + text_len + 1;

    // Write packet type and size
    uint8_t packet_type = TAV_PACKET_SUBTITLE_TC;
    fwrite(&packet_type, 1, 1, output);
    uint32_t size32 = (uint32_t)packet_size;
    fwrite(&size32, 4, 1, output);

    // Write subtitle index (24-bit, little-endian)
    uint8_t index_bytes[3] = {
        (uint8_t)(index & 0xFF),
        (uint8_t)((index >> 8) & 0xFF),
        (uint8_t)((index >> 16) & 0xFF)
    };
    fwrite(index_bytes, 3, 1, output);

    // Write timecode (64-bit, little-endian)
    uint8_t timecode_bytes[8];
    for (int i = 0; i < 8; i++) {
        timecode_bytes[i] = (timecode_ns >> (i * 8)) & 0xFF;
    }
    fwrite(timecode_bytes, 8, 1, output);

    // Write opcode
    fwrite(&opcode, 1, 1, output);

    // Write text if present
    if (text && text_len > 0) {
        fwrite(text, 1, text_len, output);
    }

    // Write null terminator
    uint8_t null_terminator = 0;
    fwrite(&null_terminator, 1, 1, output);

    return 1 + 4 + packet_size;  // Total bytes written
}

// Write timecode packet for current frame
// Timecode is the time since stream start in nanoseconds
static void write_timecode_packet(FILE *output, int frame_num, int fps, int is_ntsc_framerate) {
    uint8_t packet_type = TAV_PACKET_TIMECODE;
    fwrite(&packet_type, 1, 1, output);

    // Calculate timecode in nanoseconds
    // For NTSC framerates (X000/1001): time = frame_num * 1001 * 1000000000 / (fps * 1000)
    // For other framerates: time = frame_num * 1000000000 / fps
    uint64_t timecode_ns;
    if (is_ntsc_framerate) {
        // NTSC framerates use denominator 1001 (e.g., 24000/1001, 30000/1001, 60000/1001)
        // To avoid floating point: time_ns = frame_num * 1001 * 1e9 / (fps * 1000)
        // This works for 24fps NTSC (23.976), 30fps NTSC (29.97), 60fps NTSC (59.94), etc.
        timecode_ns = ((uint64_t)frame_num * 1001ULL * 1000000000ULL) / ((uint64_t)fps * 1000ULL);
    } else {
        // Standard framerate
        timecode_ns = ((uint64_t)frame_num * 1000000000ULL) / (uint64_t)fps;
    }

    // Write timecode as little-endian uint64
    fwrite(&timecode_ns, sizeof(uint64_t), 1, output);
}

// Write screen masking packet (letterbox/pillarbox detection)
// Packet structure: type(1) + frame_num(4) + top(2) + right(2) + bottom(2) + left(2) = 13 bytes
static void write_screen_mask_packet(FILE *output, uint32_t frame_num,
                                      uint16_t top, uint16_t right,
                                      uint16_t bottom, uint16_t left) {
    uint8_t packet_type = TAV_PACKET_SCREEN_MASK;
    fwrite(&packet_type, 1, 1, output);
    fwrite(&frame_num, sizeof(uint32_t), 1, output);
    fwrite(&top, sizeof(uint16_t), 1, output);
    fwrite(&right, sizeof(uint16_t), 1, output);
    fwrite(&bottom, sizeof(uint16_t), 1, output);
    fwrite(&left, sizeof(uint16_t), 1, output);
}

// Calculate Sobel gradient magnitude for a pixel (edge detection)
static float calculate_sobel_magnitude(const uint8_t *frame_rgb, int width, int height,
                                         int x, int y) {
    // Sobel kernels for X and Y gradients
    // Gx = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]]
    // Gy = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]]

    // Handle boundary conditions with symmetric extension
    int x_prev = (x > 0) ? (x - 1) : 0;
    int x_next = (x < width - 1) ? (x + 1) : (width - 1);
    int y_prev = (y > 0) ? (y - 1) : 0;
    int y_next = (y < height - 1) ? (y + 1) : (height - 1);

    // Sample 3x3 neighborhood (using luma only for efficiency)
    float pixels[3][3];
    for (int dy = 0; dy < 3; dy++) {
        for (int dx = 0; dx < 3; dx++) {
            int sample_y = (dy == 0) ? y_prev : ((dy == 1) ? y : y_next);
            int sample_x = (dx == 0) ? x_prev : ((dx == 1) ? x : x_next);
            int offset = (sample_y * width + sample_x) * 3;

            // Convert to luma (simple approximation: Y = 0.299R + 0.587G + 0.114B)
            pixels[dy][dx] = (0.299f * frame_rgb[offset] +
                              0.587f * frame_rgb[offset + 1] +
                              0.114f * frame_rgb[offset + 2]);
        }
    }

    // Apply Sobel operators
    float gx = -pixels[0][0] + pixels[0][2] +
               -2*pixels[1][0] + 2*pixels[1][2] +
               -pixels[2][0] + pixels[2][2];

    float gy = -pixels[0][0] - 2*pixels[0][1] - pixels[0][2] +
                pixels[2][0] + 2*pixels[2][1] + pixels[2][2];

    // Calculate magnitude: sqrt(gx^2 + gy^2)
    return sqrtf(gx * gx + gy * gy);
}

// Apply symmetric cropping and suppress simultaneous letterbox+pillarbox
// ALWAYS makes left=right and top=bottom (perfect symmetry)
// When BOTH letterbox and pillarbox are detected simultaneously, suppress one based on current state
// Allows letterbox→pillarbox or pillarbox→letterbox transitions
static void apply_symmetric_cropping(uint16_t *top, uint16_t *right,
                                       uint16_t *bottom, uint16_t *left,
                                       int width, int height,
                                       uint16_t current_top, uint16_t current_bottom,
                                       uint16_t current_left, uint16_t current_right) {
    const int MIN_BAR_SIZE_LETTER = (int)(0.04f * height);  // Minimum bar size to consider (ignore <16 pixel bars)
    const int MIN_BAR_SIZE_PILLAR = (int)(0.04f * width);  // Minimum bar size to consider (ignore <16 pixel bars)
    const int SIGNIFICANT_THRESHOLD_LETTER = (int)(0.08f * height);  // Bar must be 32+ pixels to be considered significant
    const int SIGNIFICANT_THRESHOLD_PILLAR = (int)(0.08f * width);  // Bar must be 32+ pixels to be considered significant

    // Filter out small bars (noise/detection errors)
    if (*top < MIN_BAR_SIZE_LETTER) *top = 0;
    if (*bottom < MIN_BAR_SIZE_LETTER) *bottom = 0;
    if (*left < MIN_BAR_SIZE_PILLAR) *left = 0;
    if (*right < MIN_BAR_SIZE_PILLAR) *right = 0;

    // ALWAYS make letterbox (top/bottom) perfectly symmetric
    if (*top > 0 || *bottom > 0) {
        // Use minimum value to avoid over-cropping
        uint16_t symmetric_value = (*top < *bottom) ? *top : *bottom;
        *top = symmetric_value+1;
        *bottom = symmetric_value+1;
    }

    // ALWAYS make pillarbox (left/right) perfectly symmetric
    if (*left > 0 || *right > 0) {
        // Use minimum value to avoid over-cropping
        uint16_t symmetric_value = (*left < *right) ? *left : *right;
        *left = symmetric_value+1;
        *right = symmetric_value+1;
    }

    // Check if BOTH letterbox and pillarbox are detected simultaneously
    int new_has_letterbox = (*top >= SIGNIFICANT_THRESHOLD_LETTER || *bottom >= SIGNIFICANT_THRESHOLD_LETTER);
    int new_has_pillarbox = (*left >= SIGNIFICANT_THRESHOLD_PILLAR || *right >= SIGNIFICANT_THRESHOLD_PILLAR);
    int current_has_letterbox = (current_top >= SIGNIFICANT_THRESHOLD_LETTER || current_bottom >= SIGNIFICANT_THRESHOLD_LETTER);
    int current_has_pillarbox = (current_left >= SIGNIFICANT_THRESHOLD_PILLAR || current_right >= SIGNIFICANT_THRESHOLD_PILLAR);

    // Only suppress when BOTH are detected AND one is much smaller (likely false positive)
    // Completely suppress windowboxing
    if (new_has_letterbox && new_has_pillarbox) {
        int letterbox_size = *top + *bottom;
        int pillarbox_size = *left + *right;

        // to allow windowboxing:
        // Only suppress if one is less than 25% of total masking
        // This allows legitimate windowboxing while filtering false positives
        float letterbox_ratio_geom = (float)letterbox_size / height;
        float pillarbox_ratio_geom = (float)pillarbox_size / width;
        float ratio_sum = letterbox_ratio_geom + pillarbox_ratio_geom;
        float letterbox_ratio = letterbox_ratio_geom / ratio_sum;
        float pillarbox_ratio = pillarbox_ratio_geom / ratio_sum;

        if (letterbox_ratio < 0.25f) {
            *top = 0;
            *bottom = 0;
        } else if (pillarbox_ratio < 0.25f)
            *left = 0;
            *right = 0;
        }
        // Otherwise keep both (legitimate windowboxing)
    }
}

// Detect letterbox/pillarbox bars in the current frame
// Returns 1 if masking detected, 0 otherwise
// Sets top, right, bottom, left to the size of detected bars in pixels
static int detect_letterbox_pillarbox(tav_encoder_t *enc,
                                       uint16_t *top, uint16_t *right,
                                       uint16_t *bottom, uint16_t *left) {
    if (!enc->current_frame_rgb) return 0;

    const int width = enc->width;
    const int height = enc->height;
    const int SAMPLE_RATE_HORZ = 4;  // Sample every 4th pixel for performance
    const int SAMPLE_RATE_VERT = 4;  // Sample every 4th pixel for performance
    const float Y_THRESHOLD = 2.0f;  // Y < 2 for dark pixels
    const float CHROMA_THRESHOLD = 1.0f;  // Co/Cg close to 0 (in ±255 scale)
    const float EDGE_ACTIVITY_THRESHOLD = 1.0f;  // Mean Sobel magnitude < 1.0
    const float ROW_COL_BLACK_RATIO = 0.999f;  // 99.9% of sampled pixels must be black

    *top = 0;
    *bottom = 0;
    *left = 0;
    *right = 0;

    // Detect top letterbox
    for (int y = 0; y < height / 4; y++) {
        int black_pixel_count = 0;
        float total_edge_activity = 0.0f;
        int sampled_pixels = 0;

        for (int x = 0; x < width; x += SAMPLE_RATE_HORZ) {
            int idx = y * width + x;

            // Use pre-converted YCoCg values (optimization: avoid RGB→YCoCg conversion in loop)
            float yval = enc->current_frame_y[idx];
             float co = enc->current_frame_co[idx];
             float cg = enc->current_frame_cg[idx];

            // Check if pixel is dark and neutral (letterbox bar)
            if (yval < Y_THRESHOLD &&
                fabs(co) < CHROMA_THRESHOLD &&
                fabs(cg) < CHROMA_THRESHOLD) {
                black_pixel_count++;
            }

            // Calculate edge activity
            total_edge_activity += calculate_sobel_magnitude(enc->current_frame_rgb,
                                                             width, height, x, y);
            sampled_pixels++;
        }

        float black_ratio = (float)black_pixel_count / sampled_pixels;
        float mean_edge_activity = total_edge_activity / sampled_pixels;

        // Row is part of letterbox if mostly black AND low edge activity
        if (black_ratio > ROW_COL_BLACK_RATIO &&
            mean_edge_activity < EDGE_ACTIVITY_THRESHOLD) {
            *top = y + 1;
        } else {
            break;  // Found content
        }
    }

    // Detect bottom letterbox
    for (int y = height - 1; y >= height * 3 / 4; y--) {
        int black_pixel_count = 0;
        float total_edge_activity = 0.0f;
        int sampled_pixels = 0;

        for (int x = 0; x < width; x += SAMPLE_RATE_HORZ) {
            int idx = y * width + x;

            // Use pre-converted YCoCg values (optimization)
            float yval = enc->current_frame_y[idx];
             float co = enc->current_frame_co[idx];
             float cg = enc->current_frame_cg[idx];

            if (yval < Y_THRESHOLD &&
                fabs(co) < CHROMA_THRESHOLD &&
                fabs(cg) < CHROMA_THRESHOLD) {
                black_pixel_count++;
            }

            total_edge_activity += calculate_sobel_magnitude(enc->current_frame_rgb,
                                                             width, height, x, y);
            sampled_pixels++;
        }

        float black_ratio = (float)black_pixel_count / sampled_pixels;
        float mean_edge_activity = total_edge_activity / sampled_pixels;

        if (black_ratio > ROW_COL_BLACK_RATIO &&
            mean_edge_activity < EDGE_ACTIVITY_THRESHOLD) {
            *bottom = height - y;
        } else {
            break;
        }
    }

    // Detect left pillarbox
    for (int x = 0; x < width / 4; x++) {
        int black_pixel_count = 0;
        float total_edge_activity = 0.0f;
        int sampled_pixels = 0;

        for (int y = 0; y < height; y += SAMPLE_RATE_VERT) {
            int idx = y * width + x;

            // Use pre-converted YCoCg values (optimization)
            float yval = enc->current_frame_y[idx];
             float co = enc->current_frame_co[idx];
             float cg = enc->current_frame_cg[idx];

            if (yval < Y_THRESHOLD &&
                fabs(co) < CHROMA_THRESHOLD &&
                fabs(cg) < CHROMA_THRESHOLD) {
                black_pixel_count++;
            }

            total_edge_activity += calculate_sobel_magnitude(enc->current_frame_rgb,
                                                             width, height, x, y);
            sampled_pixels++;
        }

        float black_ratio = (float)black_pixel_count / sampled_pixels;
        float mean_edge_activity = total_edge_activity / sampled_pixels;

        if (black_ratio > ROW_COL_BLACK_RATIO &&
            mean_edge_activity < EDGE_ACTIVITY_THRESHOLD) {
            *left = x + 1;
        } else {
            break;
        }
    }

    // Detect right pillarbox
    for (int x = width - 1; x >= width * 3 / 4; x--) {
        int black_pixel_count = 0;
        float total_edge_activity = 0.0f;
        int sampled_pixels = 0;

        for (int y = 0; y < height; y += SAMPLE_RATE_VERT) {
            int idx = y * width + x;

            // Use pre-converted YCoCg values (optimization)
            float yval = enc->current_frame_y[idx];
             float co = enc->current_frame_co[idx];
             float cg = enc->current_frame_cg[idx];

            if (yval < Y_THRESHOLD &&
                fabs(co) < CHROMA_THRESHOLD &&
                fabs(cg) < CHROMA_THRESHOLD) {
                black_pixel_count++;
            }

            total_edge_activity += calculate_sobel_magnitude(enc->current_frame_rgb,
                                                             width, height, x, y);
            sampled_pixels++;
        }

        float black_ratio = (float)black_pixel_count / sampled_pixels;
        float mean_edge_activity = total_edge_activity / sampled_pixels;

        if (black_ratio > ROW_COL_BLACK_RATIO &&
            mean_edge_activity < EDGE_ACTIVITY_THRESHOLD) {
            *right = width - x;
        } else {
            break;
        }
    }

    // Apply symmetric cropping preference and minimum bar size filtering
    // Note: During detection phase, no current state available (use 0,0,0,0)
    apply_symmetric_cropping(top, right, bottom, left, width, height, 0, 0, 0, 0);

    // Return 1 if any masking was detected
    return (*top > 0 || *bottom > 0 || *left > 0 || *right > 0);
}

// Refine geometry change detection - find exact frame where change occurred
// Uses linear scan to find first frame with new geometry
static int refine_geometry_change(tav_encoder_t *enc, int start_frame, int end_frame,
                                 uint16_t old_top, uint16_t old_right,
                                 uint16_t old_bottom, uint16_t old_left) {
    #define GEOMETRY_TOLERANCE 4  // ±4 pixels tolerance

    // Linear scan from start to find first frame with new geometry
    for (int i = start_frame; i <= end_frame && i < enc->frame_analyses_count; i++) {
        frame_analysis_t *m = &enc->frame_analyses[i];

        // Check if this frame has different geometry (beyond tolerance)
        if (abs((int)m->letterbox_top - (int)old_top) > GEOMETRY_TOLERANCE ||
            abs((int)m->letterbox_right - (int)old_right) > GEOMETRY_TOLERANCE ||
            abs((int)m->letterbox_bottom - (int)old_bottom) > GEOMETRY_TOLERANCE ||
            abs((int)m->letterbox_left - (int)old_left) > GEOMETRY_TOLERANCE) {
            return i;  // Found the change point
        }
    }

    return end_frame;  // No change found, use end frame

    #undef GEOMETRY_TOLERANCE
}

// Write all screen masking packets before first frame (similar to SSF-TC subtitles)
// Uses two-stage approach: coarse detection (8-frame stride) + frame-exact refinement
static void write_all_screen_mask_packets(tav_encoder_t *enc, FILE *output) {
    if (!enc->enable_letterbox_detect || !enc->two_pass_mode) {
        return;  // Letterbox detection requires two-pass mode
    }

    if (!enc->frame_analyses || enc->frame_analyses_count == 0) {
        return;  // No analysis data
    }

#define COARSE_STRIDE 16      // Sample every 8 frames for coarse detection
#define CHANGE_THRESHOLD 16  // Require 16+ pixel change to consider geometry change
#define SKIP_INITIAL_FRAMES 60  // Skip first N frames (often black/fade-in)

    // Track current geometry
    uint16_t current_top = 0, current_right = 0, current_bottom = 0, current_left = 0;
    int packets_written = 0;
    int last_checked_frame = SKIP_INITIAL_FRAMES;

    // Stage 1: Coarse scan every COARSE_STRIDE frames to detect geometry changes
    for (int i = SKIP_INITIAL_FRAMES; i < enc->frame_analyses_count; i += COARSE_STRIDE) {
        frame_analysis_t *metrics = &enc->frame_analyses[i];

        // Check if geometry changed significantly
        int is_first = (packets_written == 0);
        int is_significant_change =
            abs((int)metrics->letterbox_top - (int)current_top) >= CHANGE_THRESHOLD ||
            abs((int)metrics->letterbox_right - (int)current_right) >= CHANGE_THRESHOLD ||
            abs((int)metrics->letterbox_bottom - (int)current_bottom) >= CHANGE_THRESHOLD ||
            abs((int)metrics->letterbox_left - (int)current_left) >= CHANGE_THRESHOLD;

        if (is_first || is_significant_change) {
            // Stage 2: Refine - find exact frame where change occurred
            int change_frame;
            if (is_first) {
                change_frame = 0;  // First packet always at frame 0
            } else {
                // Search backwards from i to last_checked_frame to find exact change point
                change_frame = refine_geometry_change(enc, last_checked_frame, i,
                                                     current_top, current_right,
                                                     current_bottom, current_left);
            }

            // Get geometry from the change frame
            frame_analysis_t *change_metrics = &enc->frame_analyses[change_frame];

            // Apply symmetric cropping to final geometry (with current state for context)
            uint16_t final_top = change_metrics->letterbox_top;
            uint16_t final_right = change_metrics->letterbox_right;
            uint16_t final_bottom = change_metrics->letterbox_bottom;
            uint16_t final_left = change_metrics->letterbox_left;
            apply_symmetric_cropping(&final_top, &final_right, &final_bottom, &final_left,
                                    enc->width, enc->height,
                                    current_top, current_bottom, current_left, current_right);

            // Emit packet
            write_screen_mask_packet(output, change_frame,
                                    final_top, final_right, final_bottom, final_left);

            // Update current geometry
            current_top = final_top;
            current_right = final_right;
            current_bottom = final_bottom;
            current_left = final_left;
            packets_written++;

            if (enc->verbose) {
                printf("  Frame %d: Screen mask t=%u r=%u b=%u l=%u (frame-exact detection)\n",
                       change_frame, final_top, final_right, final_bottom, final_left);
            }
        }

        last_checked_frame = i;
    }

    if (packets_written > 0) {
        printf("Wrote %d screen masking packet(s) (frame-exact detection)\n", packets_written);
    }

#undef COARSE_STRIDE
#undef CHANGE_THRESHOLD
#undef SKIP_INITIAL_FRAMES
}

// Write extended header packet with metadata
// Returns the file offset where ENDT value is written (for later update)
static long write_extended_header(tav_encoder_t *enc) {
    uint8_t packet_type = TAV_PACKET_EXTENDED_HDR;
    fwrite(&packet_type, 1, 1, enc->output_fp);

    // Count key-value pairs (BGNT, ENDT, CDAT, VNDR, FMPG)
    uint16_t num_pairs = enc->ffmpeg_version ? 5 : 4;  // FMPG is optional
    fwrite(&num_pairs, sizeof(uint16_t), 1, enc->output_fp);

    // Helper macro to write key-value pairs
    #define WRITE_KV_UINT64(key_str, value) do { \
        fwrite(key_str, 1, 4, enc->output_fp); \
        uint8_t value_type = 0x04; /* Uint64 */ \
        fwrite(&value_type, 1, 1, enc->output_fp); \
        uint64_t val = (value); \
        fwrite(&val, sizeof(uint64_t), 1, enc->output_fp); \
    } while(0)

    #define WRITE_KV_BYTES(key_str, data, len) do { \
        fwrite(key_str, 1, 4, enc->output_fp); \
        uint8_t value_type = 0x10; /* Bytes */ \
        fwrite(&value_type, 1, 1, enc->output_fp); \
        uint16_t length = (len); \
        fwrite(&length, sizeof(uint16_t), 1, enc->output_fp); \
        fwrite((data), 1, (len), enc->output_fp); \
    } while(0)

    // BGNT: Video begin time (0 for frame 0)
    WRITE_KV_UINT64("BGNT", 0ULL);

    // ENDT: Video end time (placeholder, will be updated at end)
    long endt_offset = ftell(enc->output_fp);
    WRITE_KV_UINT64("ENDT", 0ULL);

    // CDAT: Creation time in nanoseconds since UNIX epoch
    WRITE_KV_UINT64("CDAT", enc->creation_time_us);

    // VNDR: Encoder name and version
    const char *vendor_str = ENCODER_VENDOR_STRING;
    WRITE_KV_BYTES("VNDR", vendor_str, strlen(vendor_str));

    // FMPG: FFmpeg version (if available)
    if (enc->ffmpeg_version) {
        WRITE_KV_BYTES("FMPG", enc->ffmpeg_version, strlen(enc->ffmpeg_version));
    }

    #undef WRITE_KV_UINT64
    #undef WRITE_KV_BYTES

    // Return offset of ENDT value (skip key, type byte)
    return endt_offset + 4 + 1;  // 4 bytes for "ENDT", 1 byte for type
}

// Uniform random in [0, 1) for TPDF dithering
static inline float frand01(void) {
    return (float)rand() / ((float)RAND_MAX + 1.0f);
}

// TPDF (Triangular Probability Density Function) noise in [-1, +1)
static inline float tpdf1(void) {
    return (frand01() - frand01());
}

// Convert Float32LE to unsigned 8-bit PCM with 2nd-order noise-shaped dithering
// Matches decoder_tad.c dithering algorithm for optimal quality
static void convert_pcm32_to_pcm8_dithered(tav_encoder_t *enc, const float *pcm32, uint8_t *pcm8, int num_samples) {
    const float b1 = 1.5f;   // 1st feedback coefficient
    const float b2 = -0.75f; // 2nd feedback coefficient
    const float scale = 127.5f;
    const float bias = 128.0f;

    for (int i = 0; i < num_samples; i++) {
        for (int ch = 0; ch < 2; ch++) {  // Stereo: L and R
            int idx = i * 2 + ch;

            // Input float in range [-1.0, 1.0]
            float sample = pcm32[idx];

            // Clamp to valid range
            if (sample < -1.0f) sample = -1.0f;
            if (sample > 1.0f) sample = 1.0f;

            // Apply 2nd-order noise shaping feedback
            float feedback = b1 * enc->dither_error[ch][0] + b2 * enc->dither_error[ch][1];

            // Add TPDF dither (±0.5 LSB)
            float dither = 0.5f * tpdf1();

            // Shaped signal
            float shaped = sample + feedback + dither / scale;

            // Clamp shaped signal
            if (shaped < -1.0f) shaped = -1.0f;
            if (shaped > 1.0f) shaped = 1.0f;

            // Quantise to signed 8-bit range [-128, 127]
            int q = (int)lrintf(shaped * scale);
            if (q < -128) q = -128;
            else if (q > 127) q = 127;

            // Convert to unsigned 8-bit [0, 255]
            pcm8[idx] = (uint8_t)(q + (int)bias);

            // Calculate quantisation error for feedback
            float qerr = shaped - (float)q / scale;

            // Update error history (shift and store)
            enc->dither_error[ch][1] = enc->dither_error[ch][0];
            enc->dither_error[ch][0] = qerr;
        }
    }
}

// Write separate audio track packet (0x40) - entire MP2 file in one packet
static int write_separate_audio_track(tav_encoder_t *enc, FILE *output) {
    if (!enc->has_audio || !enc->mp2_file) {
        return 0;  // No audio to write
    }

    // Get file size
    fseek(enc->mp2_file, 0, SEEK_END);
    size_t mp2_size = ftell(enc->mp2_file);
    fseek(enc->mp2_file, 0, SEEK_SET);

    if (mp2_size == 0) {
        fprintf(stderr, "Warning: MP2 file is empty\n");
        return 0;
    }

    // Allocate buffer for entire MP2 file
    uint8_t *mp2_buffer = malloc(mp2_size);
    if (!mp2_buffer) {
        fprintf(stderr, "Error: Failed to allocate buffer for separate audio track (%zu bytes)\n", mp2_size);
        return 0;
    }

    // Read entire MP2 file
    size_t bytes_read = fread(mp2_buffer, 1, mp2_size, enc->mp2_file);
    if (bytes_read != mp2_size) {
        fprintf(stderr, "Error: Failed to read MP2 file (expected %zu bytes, got %zu)\n", mp2_size, bytes_read);
        free(mp2_buffer);
        return 0;
    }

    // Write packet type 0x40
    uint8_t packet_type = TAV_PACKET_AUDIO_TRACK;
    fwrite(&packet_type, 1, 1, output);

    // Write payload size (uint32)
    uint32_t payload_size = (uint32_t)mp2_size;
    fwrite(&payload_size, sizeof(uint32_t), 1, output);

    // Write MP2 data
    fwrite(mp2_buffer, 1, mp2_size, output);

    // Cleanup
    free(mp2_buffer);

    if (enc->verbose) {
        printf("Separate audio track written: %zu bytes (packet 0x40)\n", mp2_size);
    }

    return 1;
}

// Write TAD audio packet (0x24) with specified sample count
// Uses linked TAD32 encoder (encoder_tad.c) - Float32 version
static int write_tad_packet_samples(tav_encoder_t *enc, FILE *output, int samples_to_read) {
    if (!enc->pcm_file || enc->audio_remaining <= 0 || samples_to_read <= 0) {
        return 0;
    }

    // Check if we have enough audio for a minimum chunk
    // Don't encode if less than minimum - avoids encoding mostly padding/zeros
    size_t min_bytes_needed = TAD32_MIN_CHUNK_SIZE * 2 * sizeof(float);
    if (enc->audio_remaining < min_bytes_needed) {
        enc->audio_remaining = 0;  // Mark audio as exhausted
        return 0;
    }

    size_t bytes_to_read = samples_to_read * 2 * sizeof(float);  // Stereo Float32LE

    // Don't read more than what's available
    if (bytes_to_read > enc->audio_remaining) {
        bytes_to_read = enc->audio_remaining;
        samples_to_read = bytes_to_read / (2 * sizeof(float));
    }

    if (samples_to_read < TAD32_MIN_CHUNK_SIZE) {
        // Pad to minimum size
        samples_to_read = TAD32_MIN_CHUNK_SIZE;
    }

    // Allocate Float32 input buffer
    float *pcm32_buffer = malloc(samples_to_read * 2 * sizeof(float));

    // Read Float32LE data
    size_t bytes_read = fread(pcm32_buffer, 1, bytes_to_read, enc->pcm_file);
    if (bytes_read == 0) {
        free(pcm32_buffer);
        return 0;
    }

    int samples_read = bytes_read / (2 * sizeof(float));

    // Zero-pad if needed
    if (samples_read < samples_to_read) {
        memset(&pcm32_buffer[samples_read * 2], 0,
               (samples_to_read - samples_read) * 2 * sizeof(float));
    }

    // Encode with TAD32 encoder (linked from encoder_tad.o)
    // Input is already Float32LE in range [-1.0, 1.0] from FFmpeg
    int tad_quality = enc->quality_level;  // Use video quality level for audio
    if (tad_quality > TAD32_QUALITY_MAX) tad_quality = TAD32_QUALITY_MAX;
    if (tad_quality < TAD32_QUALITY_MIN) tad_quality = TAD32_QUALITY_MIN;

    // Convert quality (0-5) to max_index for quantisation
    int max_index = tad32_quality_to_max_index(tad_quality);
    float quantiser_scale = 1.0f;  // Baseline quantiser scaling

    // Allocate output buffer (generous size for TAD chunk)
    size_t max_output_size = samples_to_read * 4 * sizeof(int16_t) + 1024;
    uint8_t *tad_output = malloc(max_output_size);

    size_t tad_encoded_size = tad32_encode_chunk(pcm32_buffer, samples_to_read, max_index, quantiser_scale, tad_output);

    if (tad_encoded_size == 0) {
        fprintf(stderr, "Error: TAD32 encoding failed\n");
        free(pcm32_buffer);
        free(tad_output);
        return 0;
    }

    // Parse TAD chunk format: [sample_count][quantisation index][payload_size][payload]
    uint8_t *read_ptr = tad_output;
    uint16_t sample_count = *((uint16_t*)read_ptr);
    read_ptr += sizeof(uint16_t);
    uint8_t quant_size = *((uint8_t*)read_ptr);
    read_ptr += sizeof(uint8_t);
    uint32_t tad_payload_size = *((uint32_t*)read_ptr);
    read_ptr += sizeof(uint32_t);
    uint8_t *tad_payload = read_ptr;

    // Write TAV packet 0x24: [0x24][payload_size+2][sample_count][compressed_size][compressed_data]
    uint8_t packet_type = TAV_PACKET_AUDIO_TAD;
    fwrite(&packet_type, 1, 1, output);

    uint32_t tav_payload_size = (uint32_t)tad_payload_size;
    uint32_t tav_payload_size_plus_6 = (uint32_t)tad_payload_size + 7;
    fwrite(&sample_count, sizeof(uint16_t), 1, output);
    fwrite(&tav_payload_size_plus_6, sizeof(uint32_t), 1, output);
    fwrite(&sample_count, sizeof(uint16_t), 1, output);
    fwrite(&quant_size, sizeof(uint8_t), 1, output);
    fwrite(&tav_payload_size, sizeof(uint32_t), 1, output);
    fwrite(tad_payload, 1, tad_payload_size, output);

    // Update audio remaining
    enc->audio_remaining -= bytes_read;

    if (enc->verbose) {
        printf("TAD32 packet: %d samples, %u bytes compressed (Q%d)\n",
               sample_count, tad_payload_size, quant_size);
    }

    // Cleanup
    free(pcm32_buffer);
    free(tad_output);

    return 1;
}

// Write PCM8 audio packet (0x21) with specified sample count
static int write_pcm8_packet_samples(tav_encoder_t *enc, FILE *output, int samples_to_read) {
    if (!enc->pcm_file || enc->audio_remaining <= 0 || samples_to_read <= 0) {
        return 0;
    }
    size_t bytes_to_read = samples_to_read * 2 * sizeof(float);  // Stereo Float32LE

    // Don't read more than what's available
    if (bytes_to_read > enc->audio_remaining) {
        bytes_to_read = enc->audio_remaining;
        samples_to_read = bytes_to_read / (2 * sizeof(float));
    }

    if (samples_to_read == 0) {
        return 0;
    }

    // Allocate buffers if needed (size for max samples: 32768)
    int max_samples = 32768;  // Maximum samples per packet
    if (!enc->pcm32_buffer) {
        enc->pcm32_buffer = malloc(max_samples * 2 * sizeof(float));
    }
    if (!enc->pcm8_buffer) {
        enc->pcm8_buffer = malloc(max_samples * 2);
    }

    // Read Float32LE data
    size_t bytes_read = fread(enc->pcm32_buffer, 1, bytes_to_read, enc->pcm_file);
    if (bytes_read == 0) {
        return 0;
    }

    int samples_read = bytes_read / (2 * sizeof(float));

    // Convert to PCM8 with dithering
    convert_pcm32_to_pcm8_dithered(enc, enc->pcm32_buffer, enc->pcm8_buffer, samples_read);

    // Compress with zstd
    size_t pcm8_size = samples_read * 2;  // Stereo
    size_t max_compressed_size = ZSTD_compressBound(pcm8_size);
    uint8_t *compressed_buffer = malloc(max_compressed_size);

    size_t compressed_size = ZSTD_compress(compressed_buffer, max_compressed_size,
                                           enc->pcm8_buffer, pcm8_size,
                                           (DEFAULT_PCM_ZSTD_LEVEL > enc->zstd_level) ? DEFAULT_PCM_ZSTD_LEVEL : enc->zstd_level);

    if (ZSTD_isError(compressed_size)) {
        fprintf(stderr, "Error: Zstd compression failed for PCM8 audio\n");
        free(compressed_buffer);
        return 0;
    }

    // Write packet: [0x21][uint32 compressed_size][compressed_data]
    uint8_t packet_type = TAV_PACKET_AUDIO_PCM8;
    fwrite(&packet_type, 1, 1, output);

    uint32_t compressed_size_32 = (uint32_t)compressed_size;
    fwrite(&compressed_size_32, sizeof(uint32_t), 1, output);

    fwrite(compressed_buffer, 1, compressed_size, output);

    // Cleanup
    free(compressed_buffer);

    // Update audio remaining
    enc->audio_remaining -= bytes_read;

    if (enc->verbose) {
        printf("PCM8 packet: %d samples, %zu bytes raw, %zu bytes compressed\n",
               samples_read, pcm8_size, compressed_size);

        // Debug: Show first few samples
        if (samples_read > 0) {
            printf("  First samples (Float32→PCM8): ");
            for (int i = 0; i < 4 && i < samples_read; i++) {
                printf("[%.3f,%.3f]→[%d,%d] ",
                    enc->pcm32_buffer[i*2], enc->pcm32_buffer[i*2+1],
                    enc->pcm8_buffer[i*2], enc->pcm8_buffer[i*2+1]);
            }
            printf("\n");
        }
    }

    return 1;
}

// Write PCM8 audio packet (0x21) for one frame's worth of audio
static int write_pcm8_packet(tav_encoder_t *enc, FILE *output) {
    return write_pcm8_packet_samples(enc, output, enc->samples_per_frame);
}

// Process audio for current frame (copied and adapted from TEV)
static int process_audio(tav_encoder_t *enc, int frame_num, FILE *output) {
    // Skip if separate audio track mode is enabled
    if (enc->separate_audio_track) {
        return 1;
    }

    // Handle TAD mode
    if (enc->tad_audio) {
        if (!enc->has_audio || !enc->pcm_file) {
            return 1;
        }
        // Write one TAD packet per frame
        return write_tad_packet_samples(enc, output, enc->samples_per_frame);
    }

    // Handle PCM8 mode
    if (enc->pcm8_audio) {
        if (!enc->has_audio || !enc->pcm_file) {
            return 1;
        }
        // Write one PCM8 packet per frame
        return write_pcm8_packet(enc, output);
    }

    // Handle MP2 mode
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

    // Estimate how many packets we consume per video frame
    double packets_per_frame = frame_audio_time / PACKET_AUDIO_TIME;

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
        double target_level = fmax(packets_per_frame, (double)enc->target_audio_buffer_size);
//        if (enc->audio_frames_in_buffer < target_level) {
            double deficit = target_level - enc->audio_frames_in_buffer;
            // Insert packets to cover the deficit, but at least maintain minimum flow
            packets_to_insert = (int)ceil(deficit);

            if (enc->verbose) {
                printf("Frame %d: Buffer low (%.2f->%.2f), deficit %.2f, inserting %d packets\n",
                       frame_num, old_buffer, enc->audio_frames_in_buffer, deficit, packets_to_insert);
            }
//        } else if (enc->verbose && old_buffer != enc->audio_frames_in_buffer) {
//            printf("Frame %d: Buffer sufficient (%.2f->%.2f), no packets\n",
//                   frame_num, old_buffer, enc->audio_frames_in_buffer);
//        }
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

// Process audio for a GOP (multiple frames at once)
// Accumulates deficit for N frames and emits all necessary audio packets
static int process_audio_for_gop(tav_encoder_t *enc, int *frame_numbers, int num_frames, FILE *output) {
    // Skip if separate audio track mode is enabled
    if (enc->separate_audio_track) {
        return 1;
    }

    // Handle TAD mode: variable chunk size support
    if (enc->tad_audio) {
        if (!enc->has_audio || !enc->pcm_file || num_frames == 0) {
            return 1;
        }

        // Calculate total samples for this GOP
        int total_samples = num_frames * enc->samples_per_frame;

        // TAD supports variable chunk sizes (non-power-of-2)
        // We can write the entire GOP in one packet (up to 32768+ samples)
        if (enc->verbose) {
            printf("TAD GOP: %d frames, %d total samples\n", num_frames, total_samples);
        }

        // Write one TAD packet for the entire GOP
        if (!write_tad_packet_samples(enc, output, total_samples)) {
            // No more audio data
        }

        return 1;
    }

    // Handle PCM8 mode: emit mega packet(s) evenly divided if exceeding 32768 samples
    if (enc->pcm8_audio) {
        if (!enc->has_audio || !enc->pcm_file || num_frames == 0) {
            return 1;
        }

        // Calculate total samples for this GOP
        int total_samples = num_frames * enc->samples_per_frame;
        int max_samples_per_packet = 32768;  // Architectural limit

        // Calculate how many packets we need
        int num_packets = (total_samples + max_samples_per_packet - 1) / max_samples_per_packet;

        // Divide samples evenly across packets
        int samples_per_packet = total_samples / num_packets;
        int remainder = total_samples % num_packets;

        if (enc->verbose) {
            printf("PCM8 GOP: %d frames, %d total samples, %d packets (%d samples/packet)\n",
                   num_frames, total_samples, num_packets, samples_per_packet);
        }

        // Emit evenly-divided packets
        for (int i = 0; i < num_packets; i++) {
            // Distribute remainder across first packets
            int samples_this_packet = samples_per_packet + (i < remainder ? 1 : 0);
            if (!write_pcm8_packet_samples(enc, output, samples_this_packet)) {
                break;  // No more audio data
            }
        }

        return 1;
    }

    // Handle MP2 mode
    if (!enc->has_audio || !enc->mp2_file || enc->audio_remaining <= 0 || num_frames == 0) {
        return 1;
    }

    // Handle first frame initialisation (same as process_audio)
    int first_frame_in_gop = frame_numbers[0];
    if (first_frame_in_gop == 0) {
        uint8_t header[4];
        if (fread(header, 1, 4, enc->mp2_file) != 4) return 1;
        fseek(enc->mp2_file, 0, SEEK_SET);
        enc->mp2_packet_size = get_mp2_packet_size(header);
        int is_mono = (header[3] >> 6) == 3;
        enc->mp2_rate_index = mp2_packet_size_to_rate_index(enc->mp2_packet_size, is_mono);
        enc->target_audio_buffer_size = 4; // 4 audio packets in buffer (does nothing for GOP)
        enc->audio_frames_in_buffer = 0.0;
    }

    // Calculate audio packet consumption per video frame
    double frame_audio_time = 1.0 / enc->output_fps;
    double packets_per_frame = frame_audio_time / PACKET_AUDIO_TIME;

    // Allocate MP2 buffer if needed
    if (!enc->mp2_buffer) {
        enc->mp2_buffer_size = enc->mp2_packet_size * 2;
        enc->mp2_buffer = malloc(enc->mp2_buffer_size);
        if (!enc->mp2_buffer) {
            fprintf(stderr, "Failed to allocate audio buffer\n");
            return 1;
        }
    }

    // Calculate total deficit for all frames in the GOP
    int total_packets_to_insert = 0;

    // Simulate buffer consumption for all N frames in the GOP
    double old_buffer = enc->audio_frames_in_buffer;
    enc->audio_frames_in_buffer -= (packets_per_frame * num_frames);

    // Calculate deficit to restore buffer to target level
//    double target_level = fmax(packets_per_frame, (double)enc->target_audio_buffer_size);
//    if (enc->audio_frames_in_buffer < target_level) {
        double deficit = packets_per_frame * num_frames;
        total_packets_to_insert = CLAMP((int)round(deficit), enc->target_audio_buffer_size, 9999);

        if (enc->verbose) {
            printf("GOP (%d frames, starting at %d): Buffer low (%.2f->%.2f), deficit %.2f, inserting %d packets\n",
                   num_frames, first_frame_in_gop, old_buffer, enc->audio_frames_in_buffer, deficit, total_packets_to_insert);
        }
//    } else if (enc->verbose) {
//        printf("GOP (%d frames, starting at %d): Buffer sufficient (%.2f->%.2f), no packets\n",
//               num_frames, first_frame_in_gop, old_buffer, enc->audio_frames_in_buffer);
//    }

    // Emit all audio packets for this GOP
    for (int q = 0; q < total_packets_to_insert; q++) {
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

        if (first_frame_in_gop == 0) {
            enc->audio_frames_in_buffer = enc->target_audio_buffer_size / 2;
        }

        if (enc->verbose) {
            printf("Audio packet %d: %zu bytes (buffer: %.2f packets)\n",
                   q, bytes_read, enc->audio_frames_in_buffer);
        }
    }

    return 1;
}

// Write all subtitles upfront in SSF-TC format (called before first frame)
static int write_all_subtitles_tc(tav_encoder_t *enc, FILE *output) {
    if (!enc->subtitles) return 0;

    int bytes_written = 0;
    int subtitle_count = 0;

    // Iterate through all subtitles and write them with timecodes
    subtitle_entry_t *sub = enc->subtitles;
    while (sub) {
        // Use direct nanosecond timestamps from SRT file (no frame conversion needed)
        uint64_t show_timecode = sub->start_time_ns;
        uint64_t hide_timecode = sub->end_time_ns;

        // Write show subtitle event
        bytes_written += write_subtitle_packet_tc(output, 0, 0x01, sub->text, show_timecode);

        // Write hide subtitle event
        bytes_written += write_subtitle_packet_tc(output, 0, 0x02, NULL, hide_timecode);

        subtitle_count++;
        if (enc->verbose) {
            printf("SSF-TC: Subtitle %d: show at %.3fs, hide at %.3fs: %.50s%s\n",
                   subtitle_count,
                   show_timecode / 1000000000.0,
                   hide_timecode / 1000000000.0,
                   sub->text, strlen(sub->text) > 50 ? "..." : "");
        }

        sub = sub->next;
    }

    if (enc->verbose && subtitle_count > 0) {
        printf("Wrote %d SSF-TC subtitle events (%d bytes)\n", subtitle_count * 2, bytes_written);
    }

    return bytes_written;
}

// Detect scene changes by analysing frame differences
// Unified scene change detection comparing two RGB frames
// Returns 1 if scene change detected, 0 otherwise
// Also outputs avg_diff and changed_ratio through pointers if non-NULL
static int detect_scene_change_between_frames(
    const uint8_t *frame1_rgb,
    const uint8_t *frame2_rgb,
    int width,
    int height,
    double *out_avg_diff,
    double *out_changed_ratio
) {
    if (!frame1_rgb || !frame2_rgb) {
        return 0; // No frames to compare
    }

    long long total_diff = 0;
    int changed_pixels = 0;

    // Sample every 4th pixel for performance (still gives good detection)
    for (int y = 0; y < height; y += 2) {
        for (int x = 0; x < width; x += 2) {
            int offset = (y * width + x) * 3;

            // Calculate colour difference
            int r_diff = abs(frame2_rgb[offset] - frame1_rgb[offset]);
            int g_diff = abs(frame2_rgb[offset + 1] - frame1_rgb[offset + 1]);
            int b_diff = abs(frame2_rgb[offset + 2] - frame1_rgb[offset + 2]);

            int pixel_diff = r_diff + g_diff + b_diff;
            total_diff += pixel_diff;

            // Count significantly changed pixels (threshold of 30 per channel average)
            if (pixel_diff > 90) {
                changed_pixels++;
            }
        }
    }

    // Calculate metrics for scene change detection
    int sampled_pixels = (height / 2) * (width / 2);
    double avg_diff = (double)total_diff / sampled_pixels;
    double changed_ratio = (double)changed_pixels / sampled_pixels;

    // Output metrics if requested
    if (out_avg_diff) *out_avg_diff = avg_diff;
    if (out_changed_ratio) *out_changed_ratio = changed_ratio;

    return changed_ratio > SCENE_CHANGE_THRESHOLD_SOFT;
}

// Wrapper for normal mode: compare current frame with previous frame
static int detect_scene_change(tav_encoder_t *enc, double *out_changed_ratio) {
    if (!enc->current_frame_rgb || enc->intra_only) {
        if (out_changed_ratio) *out_changed_ratio = 0.0;
        return 0; // No current frame to compare
    }

    double avg_diff, changed_ratio;
    int is_scene_change = detect_scene_change_between_frames(
        enc->previous_frame_rgb,
        enc->current_frame_rgb,
        enc->width,
        enc->height,
        &avg_diff,
        &changed_ratio
    );

    if (out_changed_ratio) *out_changed_ratio = changed_ratio;

    if (is_scene_change) {
        printf("Scene change detection: avg_diff=%.2f\tchanged_ratio=%.4f\n", avg_diff, changed_ratio);
    }

    return is_scene_change;
}

// =============================================================================
// Two-Pass Scene Change Detection - Wavelet-based Analysis
// =============================================================================

// Fast subsampled 2D Haar DWT for analysis (works in-place)
// Performs N-level 2D Haar transform on subsampled grayscale data
static void analysis_haar_2d_forward(float *data, int width, int height, int levels) {
    float *temp = malloc((width > height ? width : height) * sizeof(float));

    // generate division series
    int widths[levels + 1]; widths[0] = width;
    int heights[levels + 1]; heights[0] = height;

    for (int i = 1; i < levels + 1; i++) {
        widths[i] = (int)roundf(widths[i - 1] / 2.0f);
        heights[i] = (int)roundf(heights[i - 1] / 2.0f);
    }

    for (int level = 0; level < levels; level++) {
        int current_width = widths[level];
        int current_height = heights[level];

        if (current_width < 2 || current_height < 2) break;

        // Horizontal pass
        for (int y = 0; y < current_height; y++) {
            for (int x = 0; x < current_width; x++) {
                temp[x] = data[y * width + x];
            }
            dwt_haar_forward_1d(temp, current_width);
            for (int x = 0; x < current_width; x++) {
                data[y * width + x] = temp[x];
            }
        }

        // Vertical pass
        for (int x = 0; x < current_width; x++) {
            for (int y = 0; y < current_height; y++) {
                temp[y] = data[y * width + x];
            }
            dwt_haar_forward_1d(temp, current_height);
            for (int y = 0; y < current_height; y++) {
                data[y * width + x] = temp[y];
            }
        }
    }

    free(temp);
}

// Subsample RGB frame to grayscale for analysis (1/N resolution)
// Returns newly allocated buffer
static float* subsample_frame_to_gray(const uint8_t *rgb_frame, int width, int height, int factor) {
    int sub_width = width / factor;
    int sub_height = height / factor;
    float *gray = malloc(sub_width * sub_height * sizeof(float));

    for (int y = 0; y < sub_height; y++) {
        for (int x = 0; x < sub_width; x++) {
            // Sample center pixel of each block
            int src_x = x * factor + factor / 2;
            int src_y = y * factor + factor / 2;
            int src_idx = (src_y * width + src_x) * 3;

            // Convert to grayscale using standard weights
            float r = rgb_frame[src_idx + 0];
            float g = rgb_frame[src_idx + 1];
            float b = rgb_frame[src_idx + 2];
            gray[y * sub_width + x] = 0.299f * r + 0.587f * g + 0.114f * b;
        }
    }

    return gray;
}

// Calculate Shannon entropy of coefficient magnitudes
static double calculate_shannon_entropy(const float *coeffs, int count) {
    if (count == 0) return 0.0;

    // Build histogram of coefficient magnitudes (use 256 bins)
    #define HIST_BINS 256
    int histogram[HIST_BINS] = {0};

    // Find min/max for normalisation
    float min_val = FLT_MAX, max_val = -FLT_MAX;
    for (int i = 0; i < count; i++) {
        float abs_val = fabsf(coeffs[i]);
        if (abs_val < min_val) min_val = abs_val;
        if (abs_val > max_val) max_val = abs_val;
    }

    // Avoid division by zero
    float range = max_val - min_val;
    if (range < 1e-6) return 0.0;

    // Build histogram
    for (int i = 0; i < count; i++) {
        float abs_val = fabsf(coeffs[i]);
        int bin = (int)((abs_val - min_val) / range * (HIST_BINS - 1));
        bin = bin < 0 ? 0 : (bin >= HIST_BINS ? HIST_BINS - 1 : bin);
        histogram[bin]++;
    }

    // Calculate entropy: H = -sum(p_i * log2(p_i))
    double entropy = 0.0;
    for (int i = 0; i < HIST_BINS; i++) {
        if (histogram[i] > 0) {
            double p = (double)histogram[i] / count;
            entropy -= p * log2(p);
        }
    }

    return entropy;
    #undef HIST_BINS
}

// Extract subband from DWT coefficients (helper for entropy calculation)
static void extract_subband(const float *dwt_data, int width, int height, int level,
                           int band, float *output, int *out_count) {
    // band: 0=LL, 1=LH, 2=HL, 3=HH
    // For level L, subbands are in top-left quadrant of size (width>>L, height>>L)

    // generate division series
    int widths[10]; widths[0] = width;
    int heights[10]; heights[0] = height;

    for (int i = 1; i < 10; i++) {
        widths[i] = (int)roundf(widths[i - 1] / 2.0f);
        heights[i] = (int)roundf(heights[i - 1] / 2.0f);
    }

    int level_width = widths[level];
    int level_height = heights[level];
    int half_width = level_width / 2;
    int half_height = level_height / 2;

    if (half_width < 1 || half_height < 1) {
        *out_count = 0;
        return;
    }

    int count = 0;
    int offset_x = (band & 1) ? half_width : 0;   // LH, HH have x offset
    int offset_y = (band & 2) ? half_height : 0;  // HL, HH have y offset

    for (int y = 0; y < half_height; y++) {
        for (int x = 0; x < half_width; x++) {
            int src_x = offset_x + x;
            int src_y = offset_y + y;
            output[count++] = dwt_data[src_y * width + src_x];
        }
    }

    *out_count = count;
}

// Compute comprehensive frame analysis metrics
static void compute_frame_metrics(tav_encoder_t *enc, const float *dwt_current, const float *dwt_previous,
                                  int width, int height, int levels,
                                  frame_analysis_t *metrics) {
    int num_pixels = width * height;

    // generate division series
    int widths[levels + 1]; widths[0] = width;
    int heights[levels + 1]; heights[0] = height;

    for (int i = 1; i < levels + 1; i++) {
        widths[i] = (int)roundf(widths[i - 1] / 2.0f);
        heights[i] = (int)roundf(heights[i - 1] / 2.0f);
    }

    // Initialise metrics
    memset(metrics, 0, sizeof(frame_analysis_t));

    // Extract LL band (approximation coefficients)
    int ll_width = widths[levels];
    int ll_height = heights[levels];
    int ll_count = ll_width * ll_height;

    if (ll_count <= 0) return;

    // Metric 1: LL band statistics (mean, variance)
    double ll_sum = 0.0, ll_sum_sq = 0.0;
    for (int i = 0; i < ll_count; i++) {
        float val = dwt_current[i];
        ll_sum += val;
        ll_sum_sq += val * val;
    }
    metrics->ll_mean = ll_sum / ll_count;
    double ll_var = (ll_sum_sq / ll_count) - (metrics->ll_mean * metrics->ll_mean);
    metrics->ll_variance = ll_var > 0 ? ll_var : 0;

    // Metric 2: LL_diff (L1 distance between consecutive frames)
    if (dwt_previous) {
        double diff_sum = 0.0;
        for (int i = 0; i < ll_count; i++) {
            diff_sum += fabs(dwt_current[i] - dwt_previous[i]);
        }
        metrics->ll_diff = diff_sum / ll_count;
    }

    // Metric 3: Highband energy and ratio
    double total_energy = 0.0, highband_energy = 0.0;
    for (int i = 0; i < num_pixels; i++) {
        float abs_val = fabsf(dwt_current[i]);
        total_energy += abs_val;
        if (i >= ll_count) {  // All coefficients except LL band
            highband_energy += abs_val;
        }
    }
    metrics->total_energy = total_energy;
    metrics->highband_energy = highband_energy;
    metrics->highband_ratio = total_energy > 0 ? (highband_energy / total_energy) : 0;

    // Metric 4: Per-band entropies
    float *subband_buffer = malloc(num_pixels * sizeof(float));
    int subband_count;

    // LL band entropy
    extract_subband(dwt_current, width, height, levels, 0, subband_buffer, &subband_count);
    metrics->entropy_ll = calculate_shannon_entropy(subband_buffer, subband_count);

    // High-frequency bands entropy (LH, HL, HH for each level)
    for (int level = 0; level < levels && level < ANALYSIS_DWT_LEVELS; level++) {
        // LH band
        extract_subband(dwt_current, width, height, level, 1, subband_buffer, &subband_count);
        metrics->entropy_lh[level] = calculate_shannon_entropy(subband_buffer, subband_count);

        // HL band
        extract_subband(dwt_current, width, height, level, 2, subband_buffer, &subband_count);
        metrics->entropy_hl[level] = calculate_shannon_entropy(subband_buffer, subband_count);

        // HH band
        extract_subband(dwt_current, width, height, level, 3, subband_buffer, &subband_count);
        metrics->entropy_hh[level] = calculate_shannon_entropy(subband_buffer, subband_count);
    }

    // Metric 5: Zero crossing rate in highbands (texture change indicator)
    int zero_crossings = 0;
    int highband_coeffs = num_pixels - ll_count;
    if (highband_coeffs > 1) {
        for (int i = ll_count; i < num_pixels - 1; i++) {
            if ((dwt_current[i] > 0 && dwt_current[i + 1] < 0) ||
                (dwt_current[i] < 0 && dwt_current[i + 1] > 0)) {
                zero_crossings++;
            }
        }
        metrics->zero_crossing_rate = (double)zero_crossings / highband_coeffs;
    }

    free(subband_buffer);
}

// Hybrid scene change detector with adaptive thresholds
// Returns 1 if scene change detected, 0 otherwise
static int detect_scene_change_wavelet(int frame_number,
                                      const frame_analysis_t *metrics_history,
                                      int history_count,
                                      const frame_analysis_t *current_metrics,
                                      int verbose) {
    if (history_count < 2) return 0;  // Need history for adaptive thresholds

    // Calculate moving statistics for LL_diff (mean and stddev)
    int window_size = history_count < ANALYSIS_MOVING_WINDOW ? history_count : ANALYSIS_MOVING_WINDOW;
    int start_idx = history_count - window_size;

    double ll_diff_sum = 0.0, ll_diff_sum_sq = 0.0;
    for (int i = start_idx; i < history_count; i++) {
        double val = metrics_history[i].ll_diff;
        ll_diff_sum += val;
        ll_diff_sum_sq += val * val;
    }

    double ll_diff_mean = ll_diff_sum / window_size;
    double ll_diff_variance = (ll_diff_sum_sq / window_size) - (ll_diff_mean * ll_diff_mean);
    double ll_diff_stddev = ll_diff_variance > 0 ? sqrt(ll_diff_variance) : 0;

    // Adaptive threshold: mean + k*stddev (with minimum absolute threshold)
    double ll_diff_threshold = ll_diff_mean + ANALYSIS_STDDEV_MULTIPLIER * ll_diff_stddev;
    if (ll_diff_threshold < ANALYSIS_LL_DIFF_MIN_THRESHOLD) {
        ll_diff_threshold = ANALYSIS_LL_DIFF_MIN_THRESHOLD;
    }

    // Detection rule 1: Hard cut or fast fade (LL_diff spike)
    // Improvement: Normalise LL_diff by LL_mean to handle exposure/lighting changes
    double normalised_ll_diff = current_metrics->ll_mean > 1.0 ?
        current_metrics->ll_diff / current_metrics->ll_mean : current_metrics->ll_diff;
    double normalised_threshold = current_metrics->ll_mean > 1.0 ?
        ll_diff_threshold / current_metrics->ll_mean : ll_diff_threshold;

    if (normalised_ll_diff > normalised_threshold) {
        if (verbose) {
            printf("  Scene change detected frame %d: Normalised LL_diff=%.4f > threshold=%.4f (raw: %.2f > %.2f)\n",
                   frame_number + 1, normalised_ll_diff, normalised_threshold,
                   current_metrics->ll_diff, ll_diff_threshold);
        }
        return 1;
    }

    // Detection rule 2: Structural change (high-frequency energy spike)
    // Improvement: Require temporal persistence only for borderline detections
    double hb_ratio_threshold = ANALYSIS_HB_RATIO_THRESHOLD;

    // Calculate average highband energy from history (normalised by total energy for RMS-like measure)
    double hb_energy_sum = 0.0;
    for (int i = start_idx; i < history_count; i++) {
        hb_energy_sum += metrics_history[i].highband_energy;
    }
    double hb_energy_mean = hb_energy_sum / window_size;
    double hb_energy_threshold = hb_energy_mean * ANALYSIS_HB_ENERGY_MULTIPLIER;

    // Check if highband spike is detected
    if (current_metrics->highband_ratio > hb_ratio_threshold &&
        current_metrics->highband_energy > hb_energy_threshold) {

        // Calculate confidence: how much does it exceed threshold?
        double ratio_confidence = current_metrics->highband_ratio / hb_ratio_threshold;
        double energy_confidence = current_metrics->highband_energy / hb_energy_threshold;
        double min_confidence = ratio_confidence < energy_confidence ? ratio_confidence : energy_confidence;

        // High confidence (>1.3x threshold): Skip persistence check (likely hard cut)
        if (min_confidence > 1.3) {
            if (verbose) {
                printf("  Scene change detected frame %d: HB_ratio=%.3f > %.3f AND HB_energy=%.1f > %.1f (high confidence: %.2fx)\n",
                       frame_number + 1, current_metrics->highband_ratio, hb_ratio_threshold,
                       current_metrics->highband_energy, hb_energy_threshold, min_confidence);
            }
            return 1;
        }

        // Borderline detection: Check persistence to avoid single-frame flashes
        if (history_count >= 1) {
            const frame_analysis_t *prev_metrics = &metrics_history[history_count - 1];
            if (prev_metrics->highband_ratio > hb_ratio_threshold * 0.6 ||  // Relaxed to 60%
                prev_metrics->highband_energy > hb_energy_threshold * 0.6) {
                if (verbose) {
                    printf("  Scene change detected frame %d: HB_ratio=%.3f > %.3f AND HB_energy=%.1f > %.1f (persistent)\n",
                           frame_number + 1, current_metrics->highband_ratio, hb_ratio_threshold,
                           current_metrics->highband_energy, hb_energy_threshold);
                }
                return 1;
            }
        }
    }

    // Detection rule 3: Gradual transition (slow LL_mean change over several frames)
    // Check if LL_mean changed significantly over last 5 frames
    if (history_count >= 5) {
        double ll_mean_5_frames_ago = metrics_history[history_count - 5].ll_mean;
        double ll_mean_change = fabs(current_metrics->ll_mean - ll_mean_5_frames_ago);

        if (ll_mean_change > ANALYSIS_FADE_THRESHOLD) {
            if (verbose) {
                printf("  Scene change detected frame %d: Gradual fade - LL_mean change=%.2f over 5 frames (threshold=%.1f)\n",
                       frame_number + 1, ll_mean_change, ANALYSIS_FADE_THRESHOLD);
            }
            return 1;
        }
    }

    return 0;  // No scene change detected
}

// Split a scene into evenly-sized GOPs
// Returns linked list of GOP boundaries for the scene
static gop_boundary_t* split_scene_into_gops(int scene_start, int scene_end,
                                             int min_gop_size, int max_gop_size,
                                             gop_boundary_t **tail_ptr, int verbose) {
    int scene_length = scene_end - scene_start + 1;

    if (scene_length < min_gop_size) {
        // Scene too short, make it a single GOP
        gop_boundary_t *boundary = malloc(sizeof(gop_boundary_t));
        boundary->start_frame = scene_start;
        boundary->end_frame = scene_end;
        boundary->num_frames = scene_length;
        boundary->next = NULL;
        *tail_ptr = boundary;
        return boundary;
    }

    // Calculate optimal number of GOPs for this scene
    int num_gops = (scene_length + max_gop_size - 1) / max_gop_size;  // ceil(scene_length / max_gop_size)

    // Make sure each GOP is at least min_gop_size
    if (scene_length / num_gops < min_gop_size) {
        num_gops = scene_length / min_gop_size;
    }

    if (num_gops < 1) num_gops = 1;

    // Calculate base GOP size and remainder for even distribution
    int base_gop_size = scene_length / num_gops;
    int remainder = scene_length % num_gops;

    gop_boundary_t *head = NULL;
    gop_boundary_t *tail = NULL;
    int current_frame = scene_start;

    for (int i = 0; i < num_gops; i++) {
        // Distribute remainder frames evenly across GOPs
        int gop_size = base_gop_size + (i < remainder ? 1 : 0);

        gop_boundary_t *boundary = malloc(sizeof(gop_boundary_t));
        boundary->start_frame = current_frame;
        boundary->end_frame = current_frame + gop_size - 1;
        boundary->num_frames = gop_size;
        boundary->next = NULL;

        if (tail) {
            tail->next = boundary;
            tail = boundary;
        } else {
            head = tail = boundary;
        }

        if (verbose) {
            printf("  GOP %d: frames %d-%d (length %d)\n",
                   i + 1, boundary->start_frame, boundary->end_frame, boundary->num_frames);
        }

        current_frame += gop_size;
    }

    *tail_ptr = tail;
    return head;
}

// Build GOP boundaries from frame analysis data
// First detects scene boundaries, then splits each scene into evenly-sized GOPs
static gop_boundary_t* build_gop_boundaries(const frame_analysis_t *analyses, int num_frames,
                                           int min_gop_size, int max_gop_size, int verbose) {
    if (num_frames < min_gop_size) return NULL;

    // Step 1: Detect scene boundaries (actual hard cuts only)
    int *scene_boundaries = malloc((num_frames + 1) * sizeof(int));
    int num_scenes = 0;
    scene_boundaries[num_scenes++] = 0;  // First scene starts at frame 0

    for (int i = 1; i < num_frames; i++) {
        if (analyses[i].is_scene_change) {
            scene_boundaries[num_scenes++] = i;
            if (verbose) {
                printf("Scene boundary candidate at frame %d\n", i);
            }
        }
    }
    scene_boundaries[num_scenes++] = num_frames;  // End of last scene

    // Step 1.5: Merge tiny scenes (< min_gop_size) with adjacent scenes
    // This prevents false positives from creating 1-frame GOPs
    int *merged_boundaries = malloc((num_scenes + 1) * sizeof(int));
    int num_merged = 0;
    merged_boundaries[num_merged++] = scene_boundaries[0];  // Always keep first boundary

    for (int s = 1; s < num_scenes; s++) {
        int scene_length = scene_boundaries[s] - scene_boundaries[s - 1];

        // If this scene is too short, skip this boundary (merge with next scene)
        if (scene_length >= min_gop_size || s == num_scenes - 1) {
            merged_boundaries[num_merged++] = scene_boundaries[s];
        } else if (verbose) {
            printf("  Merging tiny scene at frame %d (length %d)\n",
                   scene_boundaries[s - 1], scene_length);
        }
    }

    // Replace original boundaries with merged ones
    free(scene_boundaries);
    scene_boundaries = merged_boundaries;
    num_scenes = num_merged;

    if (verbose) {
        printf("After merging: %d scenes\n", num_scenes - 1);
    }

    // Step 2: Split each scene into evenly-sized GOPs
    gop_boundary_t *head = NULL;
    gop_boundary_t *tail = NULL;

    for (int s = 0; s < num_scenes - 1; s++) {
        int scene_start = scene_boundaries[s];
        int scene_end = scene_boundaries[s + 1] - 1;
        int scene_length = scene_end - scene_start + 1;

        if (verbose) {
            printf("Scene %d: frames %d-%d (length %d)\n",
                   s + 1, scene_start, scene_end, scene_length);
        }

        // Split scene into evenly-sized GOPs
        gop_boundary_t *scene_tail = NULL;
        gop_boundary_t *scene_gops = split_scene_into_gops(scene_start, scene_end,
                                                           min_gop_size, max_gop_size,
                                                           &scene_tail, verbose);

        // Link to main GOP list
        if (head == NULL) {
            head = scene_gops;
            tail = scene_tail;
        } else {
            tail->next = scene_gops;
            tail = scene_tail;
        }
    }

    free(scene_boundaries);
    return head;
}

// Free GOP boundary list
static void free_gop_boundaries(gop_boundary_t *head) {
    while (head) {
        gop_boundary_t *next = head->next;
        free(head);
        head = next;
    }
}

// First pass: Analyse all frames and build GOP boundaries
// Returns 0 on success, -1 on error
static int two_pass_first_pass(tav_encoder_t *enc, const char *input_file) {
    printf("=== Two-Pass Encoding: First Pass (Scene Analysis) ===\n");

    // Allocate analysis array (estimate: 10000 frames max for in-memory storage)
    enc->frame_analyses_capacity = 10000;
    enc->frame_analyses = malloc(enc->frame_analyses_capacity * sizeof(frame_analysis_t));
    enc->frame_analyses_count = 0;

    if (!enc->frame_analyses) {
        fprintf(stderr, "Error: Failed to allocate frame analysis buffer\n");
        return -1;
    }

    // Calculate subsampled dimensions
    int sub_width = enc->width / ANALYSIS_SUBSAMPLE_FACTOR;
    int sub_height = enc->height / ANALYSIS_SUBSAMPLE_FACTOR;

    // Open FFmpeg pipe for first pass using SAME filters as second pass
    // This ensures frame counts match between passes
    char ffmpeg_cmd[4096];
    if (enc->progressive_mode) {
        // Progressive: scale and crop only
        snprintf(ffmpeg_cmd, sizeof(ffmpeg_cmd),
                 "ffmpeg -loglevel error -i \"%s\" -f rawvideo -pix_fmt rgb24 "
                 "-vf \"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d\" -",
                 input_file, enc->width, enc->height, enc->width, enc->height);
    } else {
        // Interlaced: scale, crop, and separate fields (doubles frame count!)
        snprintf(ffmpeg_cmd, sizeof(ffmpeg_cmd),
                 "ffmpeg -loglevel error -i \"%s\" -f rawvideo -pix_fmt rgb24 "
                 "-vf \"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,tinterlace=interleave_top:cvlpf,separatefields\" -",
                 input_file, enc->width, enc->height * 2, enc->width, enc->height * 2);
    }

    FILE *ffmpeg_pipe = popen(ffmpeg_cmd, "r");
    if (!ffmpeg_pipe) {
        fprintf(stderr, "Error: Failed to open FFmpeg pipe for first pass\n");
        free(enc->frame_analyses);
        return -1;
    }

    size_t frame_rgb_size = enc->width * enc->height * 3;
    uint8_t *frame_rgb = malloc(frame_rgb_size);
    float *prev_dwt = NULL;

    int frame_num = 0;
    size_t bytes_read;
    while ((bytes_read = fread(frame_rgb, 1, frame_rgb_size, ffmpeg_pipe)) == frame_rgb_size) {
        // Honor encode limit BEFORE processing
        if (enc->encode_limit > 0 && frame_num >= enc->encode_limit) {
            break;
        }

        // Subsample to grayscale
        float *gray = subsample_frame_to_gray(frame_rgb, enc->width, enc->height, ANALYSIS_SUBSAMPLE_FACTOR);

        // Apply 3-level Haar DWT

        analysis_haar_2d_forward(gray, sub_width, sub_height, ANALYSIS_DWT_LEVELS);

        // Compute metrics

        frame_analysis_t metrics;
        compute_frame_metrics(enc, gray, prev_dwt, sub_width, sub_height, ANALYSIS_DWT_LEVELS, &metrics);

        // Set frame number AFTER compute_frame_metrics (which does memset)
        metrics.frame_number = frame_num;

        // Detect scene change using hybrid detector
        if (frame_num > 0) {
            metrics.is_scene_change = detect_scene_change_wavelet(
                frame_num,
                enc->frame_analyses,
                enc->frame_analyses_count,
                &metrics,
                enc->verbose
            );
        } else {
            metrics.is_scene_change = 0;  // First frame is always start of first GOP
        }

        // Detect letterbox/pillarbox if enabled
        if (enc->enable_letterbox_detect) {
            // Set current_frame_rgb temporarily for detection
            uint8_t *saved_current = enc->current_frame_rgb;
            enc->current_frame_rgb = frame_rgb;

            metrics.has_letterbox = detect_letterbox_pillarbox(
                enc,
                &metrics.letterbox_top,
                &metrics.letterbox_right,
                &metrics.letterbox_bottom,
                &metrics.letterbox_left
            );

            enc->current_frame_rgb = saved_current;
        } else {
            metrics.has_letterbox = 0;
            metrics.letterbox_top = 0;
            metrics.letterbox_right = 0;
            metrics.letterbox_bottom = 0;
            metrics.letterbox_left = 0;
        }

        // Store analysis
        if (enc->frame_analyses_count >= enc->frame_analyses_capacity) {
            // Expand array
            enc->frame_analyses_capacity *= 2;
            enc->frame_analyses = realloc(enc->frame_analyses,
                                         enc->frame_analyses_capacity * sizeof(frame_analysis_t));
            if (!enc->frame_analyses) {
                fprintf(stderr, "Error: Failed to reallocate analysis buffer\n");
                free(gray);
                if (prev_dwt) free(prev_dwt);
                free(frame_rgb);
                pclose(ffmpeg_pipe);
                return -1;
            }
        }

        enc->frame_analyses[enc->frame_analyses_count++] = metrics;

        // Update previous DWT
        if (prev_dwt) free(prev_dwt);
        prev_dwt = gray;

        frame_num++;

        if (frame_num % 100 == 0) {
            printf("  Analysed %d frames...\r", frame_num);
            fflush(stdout);
        }
    }

    printf("\n  Analysed %d frames total\n", frame_num);

    free(frame_rgb);
    if (prev_dwt) free(prev_dwt);
    pclose(ffmpeg_pipe);

    // Build GOP boundaries
    printf("  Building GOP boundaries...\n");
    enc->gop_boundaries = build_gop_boundaries(
        enc->frame_analyses,
        enc->frame_analyses_count,
        ANALYSIS_GOP_MIN_SIZE,
        ANALYSIS_GOP_MAX_SIZE,
        enc->verbose
    );

    // Count and print GOP statistics
    int num_gops = 0;
    int total_gop_frames = 0;
    int min_gop = INT_MAX, max_gop = 0;
    gop_boundary_t *gop = enc->gop_boundaries;
    while (gop) {
        num_gops++;
        total_gop_frames += gop->num_frames;
        if (gop->num_frames < min_gop) min_gop = gop->num_frames;
        if (gop->num_frames > max_gop) max_gop = gop->num_frames;
        gop = gop->next;
    }

    printf("  GOP Statistics:\n");
    printf("    Total GOPs: %d\n", num_gops);
    printf("    Average GOP size: %.1f frames\n", (double)total_gop_frames / num_gops);
    printf("    Min GOP size: %d frames\n", min_gop);
    printf("    Max GOP size: %d frames\n", max_gop);

    printf("=== First Pass Complete ===\n\n");

    return 0;
}

// Detect still frames by comparing quantised DWT coefficients
// Returns 1 if frame is still (suitable for SKIP mode), 0 otherwise
static int detect_still_frame(tav_encoder_t *enc) {
    if (!enc->current_frame_rgb || !enc->previous_frame_rgb || enc->intra_only) {
        return 0; // No frame to compare or intra-only mode
    }

    long long total_diff = 0;
    int changed_pixels = 0;

    // Sample every 4th pixel for performance (same as scene change detection)
    for (int y = 0; y < enc->height; y += 2) {
        for (int x = 0; x < enc->width; x += 2) {
            int offset = (y * enc->width + x) * 3;

            // Calculate colour difference
            int r_diff = abs(enc->current_frame_rgb[offset] - enc->previous_frame_rgb[offset]);
            int g_diff = abs(enc->current_frame_rgb[offset + 1] - enc->previous_frame_rgb[offset + 1]);
            int b_diff = abs(enc->current_frame_rgb[offset + 2] - enc->previous_frame_rgb[offset + 2]);

            int pixel_diff = r_diff + g_diff + b_diff;
            total_diff += pixel_diff;

            // Count changed pixels with very low threshold (2 per channel average = 6 total)
            if (pixel_diff > 6) {
                changed_pixels++;
            }
        }
    }

    // Calculate metrics
    int sampled_pixels = (enc->height / 2) * (enc->width / 2);

    if (enc->verbose) {
        printf("Still frame detection: %d/%d pixels changed\n", changed_pixels, sampled_pixels);
    }

    return (changed_pixels == 0);
}

// Main function
int main(int argc, char *argv[]) {
    generate_random_filename(TEMP_AUDIO_FILE);
    generate_random_filename(TEMP_PCM_FILE);
    // Change extension to .pcm
    strcpy(TEMP_PCM_FILE + 37, ".pcm");

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
        {"dimension", required_argument, 0, 's'},
        {"fps", required_argument, 0, 'f'},
        {"quality", required_argument, 0, 'q'},
        {"quantiser", required_argument, 0, 'Q'},
        {"wavelet", required_argument, 0, 1010},
        {"channel-layout", required_argument, 0, 'c'},
        {"bitrate", required_argument, 0, 'b'},
        {"arate", required_argument, 0, 'a'},
        {"subtitle", required_argument, 0, 'S'},
        {"subtitles", required_argument, 0, 'S'},
        {"verbose", no_argument, 0, 'v'},
        {"test", no_argument, 0, 't'},
        {"lossless", no_argument, 0, 1000},
        {"intra-only", no_argument, 0, 1006},
        {"intraonly", no_argument, 0, 1006},
        {"ictcp", no_argument, 0, 1005},
        {"no-perceptual-tuning", no_argument, 0, 1007},
        {"no-dead-zone", no_argument, 0, 1013},
        {"no-deadzone", no_argument, 0, 1013},
        {"encode-limit", required_argument, 0, 1008},
        {"dump-frame", required_argument, 0, 1009},
        {"fontrom-lo", required_argument, 0, 1011},
        {"fontrom-low", required_argument, 0, 1011},
        {"fontrom-hi", required_argument, 0, 1012},
        {"fontrom-high", required_argument, 0, 1012},
        {"zstd-level", required_argument, 0, 1014},
        {"interlace", no_argument, 0, 1015},
        {"interlaced", no_argument, 0, 1015},
        {"enable-delta", no_argument, 0, 1017},
        {"delta-haar", required_argument, 0, 1018},
        {"temporal-dwt", no_argument, 0, 1019},
        {"temporal-3d", no_argument, 0, 1019},
        {"dwt-3d", no_argument, 0, 1019},
        {"3d-dwt", no_argument, 0, 1019},
        {"mc-ezbc", no_argument, 0, 1020},
        {"residual-coding", no_argument, 0, 1021},
        {"adaptive-blocks", no_argument, 0, 1022},
        {"bframes", required_argument, 0, 1023},
        {"gop-size", required_argument, 0, 1024},
        {"sigmap", no_argument, 0, 1025},
        {"separate-audio-track", no_argument, 0, 1026},
        {"pcm8-audio", no_argument, 0, 1027},
        {"pcm-audio", no_argument, 0, 1027},
        {"native-audio", no_argument, 0, 1027},
        {"native-audio-format", no_argument, 0, 1027},
        {"tad-audio", no_argument, 0, 1028},
        {"raw-coeffs", no_argument, 0, 1029},
        {"single-pass", no_argument, 0, 1050},  // disable two-pass encoding with wavelet-based scene detection
        {"no-letterbox-detect", no_argument, 0, 1051},  // disable letterbox/pillarbox detection
        {"help", no_argument, 0, '?'},
        {0, 0, 0, 0}
    };

    int c, option_index = 0;
    while ((c = getopt_long(argc, argv, "i:o:s:f:q:Q:a:c:d:b:S:vt?", long_options, &option_index)) != -1) {
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
                enc->quality_level = CLAMP(atoi(optarg), 0, 6);
                enc->quantiser_y = QUALITY_Y[enc->quality_level];
                enc->quantiser_co = QUALITY_CO[enc->quality_level];
                enc->quantiser_cg = QUALITY_CG[enc->quality_level];
                enc->dead_zone_threshold = DEAD_ZONE_THRESHOLD[enc->quality_level];
                break;
            case 'Q':
                // Parse quantiser values Y,Co,Cg
                if (sscanf(optarg, "%d,%d,%d", &enc->quantiser_y, &enc->quantiser_co, &enc->quantiser_cg) != 3) {
                    fprintf(stderr, "Error: Invalid quantiser format. Use Y,Co,Cg (e.g., 5,3,2)\n");
                    cleanup_encoder(enc);
                    return 1;
                }
                enc->quantiser_y = CLAMP(enc->quantiser_y, 0, 255);
                enc->quantiser_co = CLAMP(enc->quantiser_co, 0, 255);
                enc->quantiser_cg = CLAMP(enc->quantiser_cg, 0, 255);
                break;
            case 1010: // --wavelet
                enc->wavelet_filter = CLAMP(atoi(optarg), 0, 255);
                break;
            case 'b': {
                int bitrate = atoi(optarg);
                if (bitrate <= 0) {
                    fprintf(stderr, "Error: Invalid target bitrate: %d\n", bitrate);
                    cleanup_encoder(enc);
                    return 1;
                }
                enc->bitrate_mode = 1;
                enc->target_bitrate = bitrate;

                // Choose initial q-index based on target bitrate
                if (bitrate >= 64000) {
                    enc->quality_level = 6;
                } else if (bitrate >= 32000) {
                    enc->quality_level = 5;
                } else if (bitrate >= 16000) {
                    enc->quality_level = 4;
                } else if (bitrate >= 8000) {
                    enc->quality_level = 3;
                } else if (bitrate >= 4000) {
                    enc->quality_level = 2;
                } else if (bitrate >= 2000) {
                    enc->quality_level = 1;
                } else {
                    enc->quality_level = 0;
                }
                enc->quantiser_y = QUALITY_Y[enc->quality_level];
                enc->quantiser_co = QUALITY_CO[enc->quality_level];
                enc->quantiser_cg = QUALITY_CG[enc->quality_level];
                enc->dead_zone_threshold = DEAD_ZONE_THRESHOLD[enc->quality_level];
                break;
            }
            case 'c': {
                int layout = atoi(optarg);
                if (layout < 0 || layout > 5) {
                    fprintf(stderr, "Error: Invalid channel layout %d. Valid range: 0-5\n", layout);
                    cleanup_encoder(enc);
                    return 1;
                }
                enc->channel_layout = layout;
                if (enc->verbose) {
                    printf("Channel layout set to %d (%s)\n", enc->channel_layout,
                           channel_layouts[enc->channel_layout].channels[0] ?
                           channel_layouts[enc->channel_layout].channels[0] : "unknown");
                }
                break;
            }
            case 'f':
                enc->output_fps = atoi(optarg);
                if (enc->output_fps <= 0) {
                    fprintf(stderr, "Invalid FPS: %d\n", enc->output_fps);
                    cleanup_encoder(enc);
                    return 1;
                }
                break;
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
                enc->enable_temporal_dwt = 0;
                break;
            case 1007: // --no-perceptual-tuning
                enc->perceptual_tuning = 0;
                break;
            case 1013: // --no-dead-zone
                enc->dead_zone_threshold = 0.0f;
                break;
            case 1008: // --encode-limit
                enc->encode_limit = atoi(optarg);
                if (enc->encode_limit < 0) {
                    fprintf(stderr, "Error: Invalid encode limit: %d\n", enc->encode_limit);
                    cleanup_encoder(enc);
                    return 1;
                }
                break;
            case 1009: // --dump-frame
                debugDumpFrameTarget = atoi(optarg);
                break;
            case 1011: // --fontrom-lo
                enc->fontrom_lo_file = strdup(optarg);
                break;
            case 1012: // --fontrom-hi
                enc->fontrom_hi_file = strdup(optarg);
                break;
            case 1014: // --zstd-level
                enc->zstd_level = atoi(optarg);
                if (enc->zstd_level < 1 || enc->zstd_level > 22) {
                    fprintf(stderr, "Error: Zstd compression level must be between 1 and 22 (got %d)\n", enc->zstd_level);
                    cleanup_encoder(enc);
                    return 1;
                }
                break;
            case 1015: // --interlaced
                enc->progressive_mode = 0;
                break;
            case 1017: // --enable-delta
                enc->use_delta_encoding = 1;
                enc->enable_temporal_dwt = 0;
                break;
            case 1018: // --delta-haar
                enc->delta_haar_levels = CLAMP(atoi(optarg), 0, 6);
                if (enc->delta_haar_levels > 0) {
                    enc->use_delta_encoding = 1;  // Auto-enable delta encoding
                }
                break;
            case 1019: // --temporal-dwt / --temporal-3d
                enc->use_delta_encoding = 0; // two modes are mutually exclusive
                enc->enable_temporal_dwt = 1;
                printf("Temporal 3D DWT encoding enabled (GOP size: %d frames)\n", TEMPORAL_GOP_SIZE);
                break;
            case 1020: // --mc-ezbc
                enc->temporal_enable_mcezbc = 1;
                enc->preprocess_mode = PREPROCESS_EZBC;
                printf("MC-EZBC block-based motion compensation enabled (requires --temporal-dwt)\n");
                break;
            case 1021: // --residual-coding
                enc->use_delta_encoding = 0; // Mutually exclusive with delta encoding
                enc->enable_temporal_dwt = 0; // Mutually exclusive with temporal DWT
                enc->enable_residual_coding = 1;
                enc->monoblock = 1;  // Force monoblock mode (required for residual coding)
                printf("MPEG-style residual coding enabled (I/P frames, block-matching)\n");
                break;
            case 1022: // --adaptive-blocks
                enc->residual_coding_enable_adaptive_blocks = 1;
                printf("Adaptive quad-tree block partitioning enabled (block sizes: %d-%d, requires --residual-coding)\n",
                       enc->residual_coding_min_block_size, enc->residual_coding_max_block_size);
                break;
            case 1023: // --bframes
                enc->residual_coding_bframe_count = atoi(optarg);
                if (enc->residual_coding_bframe_count < 0 || enc->residual_coding_bframe_count > 4) {
                    fprintf(stderr, "Error: B-frame count must be 0-4 (got %d)\n", enc->residual_coding_bframe_count);
                    cleanup_encoder(enc);
                    return 1;
                }
                enc->residual_coding_enable_bframes = (enc->residual_coding_bframe_count > 0) ? 1 : 0;
                if (enc->residual_coding_enable_bframes) {
                    printf("B-frames enabled: M=%d (pattern: I", enc->residual_coding_bframe_count);
                    for (int i = 0; i < enc->residual_coding_bframe_count; i++) printf("B");
                    printf("P...)\n");
                }
                break;
            case 1024: // --gop-size
                enc->residual_coding_gop_size = atoi(optarg);
                if (enc->residual_coding_gop_size < 1 || enc->residual_coding_gop_size > 250) {
                    fprintf(stderr, "Error: GOP size must be 1-250 (got %d)\n", enc->residual_coding_gop_size);
                    cleanup_encoder(enc);
                    return 1;
                }
                printf("GOP size set to %d frames\n", enc->residual_coding_gop_size);
                break;
            case 1025: // --sigmap
                enc->preprocess_mode = PREPROCESS_TWOBITMAP;
                break;
            case 1026: // --separate-audio-track
                enc->separate_audio_track = 1;
                printf("Separate audio track mode enabled (packet 0x40)\n");
                break;
            case 1027: // --pcm8-audio
                enc->pcm8_audio = 1;
                enc->tad_audio = 0;
                printf("8-bit PCM audio mode enabled (packet 0x21)\n");
                break;
            case 1028: // --tad-audio
                enc->tad_audio = 1;
                enc->pcm8_audio = 0;
                printf("TAD audio mode enabled (packet 0x24, quality follows -q)\n");
                break;
            case 1029: // --raw-coeffs
                enc->preprocess_mode = PREPROCESS_RAW;
                printf("Raw coefficient mode enabled (no significance map preprocessing)\n");
                break;
            case 1050: // --single-pass
                enc->two_pass_mode = 0;
                printf("Two-pass wavelet-based scene change detection disabled\n");
                break;
            case 1051: // --no-letterbox-detect
                enc->enable_letterbox_detect = 0;
                printf("Letterbox/pillarbox detection disabled\n");
                break;
            case 'a':
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

    // generate division series
    enc->widths = malloc((enc->decomp_levels + 2) * sizeof(int));
    enc->heights = malloc((enc->decomp_levels + 2) * sizeof(int));
    enc->widths[0] = enc->width;
    enc->heights[0] = enc->height;
    for (int i = 1; i <= enc->decomp_levels; i++) {
        enc->widths[i] = (enc->widths[i - 1] + 1) / 2;
        enc->heights[i] = (enc->heights[i - 1] + 1) / 2;
    }

    // adjust encoding parameters for ICtCp
    if (enc->ictcp_mode) {
        enc->quantiser_cg = enc->quantiser_co;
    }

    // Halve internal height for interlaced mode (FFmpeg will output half-height fields)
    if (!enc->progressive_mode) {
        enc->height = enc->height / 2;
        if (enc->verbose) {
            printf("Interlaced mode: internal height adjusted to %d\n", enc->height);
        }
        enc->intra_only = 1;
    }

    // disable perceptual tuning if wavelet filter is not CDF 9/7
    if (enc->wavelet_filter != WAVELET_9_7_IRREVERSIBLE) {
        enc->perceptual_tuning = 0;
    }

    // disable monoblock mode if either width or height exceeds tie size
    if (enc->width > TILE_SIZE_X || enc->height > TILE_SIZE_Y) {
        enc->monoblock = 0;
    }

    if (enc->lossless) {
        enc->quality_level = sizeof(MP2_RATE_TABLE) / sizeof(int); // use maximum quality table to disable anisotropy
        enc->perceptual_tuning = 0;
        enc->quantiser_y = 0; // will be resolved to 1
        enc->quantiser_co = 0; // ditto
        enc->quantiser_cg = 0; // do.
        enc->intra_only = 1;
        enc->dead_zone_threshold = 0.0f;
        enc->audio_bitrate = 384;
    }

    // if user made `-q 6 -Q0,0,0 -w 0 --intra-only --no-perceptual-tuning --arate 384` manually, mark the video as lossless
    int qtsize = sizeof(MP2_RATE_TABLE) / sizeof(int);
    if (enc->quality_level == qtsize && enc->quantiser_y == 0 && enc->quantiser_co == 0 && enc->quantiser_cg == 0 &&
        enc->perceptual_tuning == 0 && enc->intra_only == 1 && enc->dead_zone_threshold == 0.0f && enc->audio_bitrate == 384
    ) {
        enc->lossless = 1;
    }

    // if temporal-dwt is used, and user did not select suitable audio codec, force PCMu8 (or TAD when it's production-ready)
    if (enc->enable_temporal_dwt && !enc->pcm8_audio && !enc->tad_audio) {
        enc->tad_audio = 1;
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
    printf("Wavelet: %s\n",
           enc->wavelet_filter == WAVELET_5_3_REVERSIBLE ? "CDF 5/3" :
           enc->wavelet_filter == WAVELET_9_7_IRREVERSIBLE ? "CDF 9/7" :
           enc->wavelet_filter == WAVELET_BIORTHOGONAL_13_7 ? "CDF 13/7" :
           enc->wavelet_filter == WAVELET_DD4 ? "DD 4-tap" :
           enc->wavelet_filter == WAVELET_HAAR ? "Haar" : "unknown");
    printf("Decomposition levels: %d\n", enc->decomp_levels);
    printf("Colour space: %s\n", enc->ictcp_mode ? "ICtCp" : "YCoCg-R");
    printf("Quantisation: %s\n", enc->perceptual_tuning ? "Perceptual (HVS-optimised)" : "Uniform");
    if (enc->ictcp_mode) {
        printf("Base quantiser: I=%d, Ct=%d, Cp=%d\n", QLUT[enc->quantiser_y], QLUT[enc->quantiser_co], QLUT[enc->quantiser_cg]);
    } else {
        printf("Base quantiser: Y=%d, Co=%d, Cg=%d\n", QLUT[enc->quantiser_y], QLUT[enc->quantiser_co], QLUT[enc->quantiser_cg]);
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

    // Capture FFmpeg version and creation time for extended header
    enc->ffmpeg_version = get_ffmpeg_version();
    struct timeval tv;
    gettimeofday(&tv, NULL);
    enc->creation_time_us = (uint64_t)tv.tv_sec * 1000000ULL + (uint64_t)tv.tv_usec * 1ULL;

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

    // Write extended header packet (before first timecode)
    gettimeofday(&enc->start_time, NULL);
    enc->extended_header_offset = write_extended_header(enc);

    // Write separate audio track if enabled (packet 0x40)
    if (enc->separate_audio_track) {
        write_separate_audio_track(enc, enc->output_fp);
    }

    // Write font ROM packets if provided
    if (enc->fontrom_lo_file) {
        if (write_fontrom_packet(enc->output_fp, enc->fontrom_lo_file, 0x80) != 0) {
            fprintf(stderr, "Warning: Failed to write low font ROM, continuing without it\n");
        }
    }
    if (enc->fontrom_hi_file) {
        if (write_fontrom_packet(enc->output_fp, enc->fontrom_hi_file, 0x81) != 0) {
            fprintf(stderr, "Warning: Failed to write high font ROM, continuing without it\n");
        }
    }

    // Write all subtitles upfront in SSF-TC format (before first frame)
    if (enc->subtitles) {
        write_all_subtitles_tc(enc, enc->output_fp);
    }

    // Write all screen masking packets upfront (before first frame)
    // This must be done AFTER first pass analysis completes, so we'll defer it
    // to after the two-pass analysis block below

    if (enc->output_fps != enc->fps) {
        printf("Frame rate conversion enabled: %d fps output\n", enc->output_fps);
    }

    // Two-pass mode: Run first pass for scene analysis
    if (enc->two_pass_mode) {
        if (two_pass_first_pass(enc, enc->input_file) != 0) {
            fprintf(stderr, "Error: First pass failed\n");
            cleanup_encoder(enc);
            return 1;
        }

        // Initialise GOP boundary iterator for second pass
        enc->current_gop_boundary = enc->gop_boundaries;
        enc->two_pass_current_frame = 0;

        // Adjust GOP capacity to match maximum computed GOP size
        enc->temporal_gop_capacity = ANALYSIS_GOP_MAX_SIZE;

        // Re-allocate GOP buffers with new capacity
        enc->temporal_gop_rgb_frames = realloc(enc->temporal_gop_rgb_frames,
                                              enc->temporal_gop_capacity * sizeof(uint8_t*));
        enc->temporal_gop_y_frames = realloc(enc->temporal_gop_y_frames,
                                            enc->temporal_gop_capacity * sizeof(float*));
        enc->temporal_gop_co_frames = realloc(enc->temporal_gop_co_frames,
                                             enc->temporal_gop_capacity * sizeof(float*));
        enc->temporal_gop_cg_frames = realloc(enc->temporal_gop_cg_frames,
                                             enc->temporal_gop_capacity * sizeof(float*));

        // Allocate new frame buffers for expanded capacity
        int frame_size = enc->width * enc->height;
        for (int i = TEMPORAL_GOP_SIZE; i < ANALYSIS_GOP_MAX_SIZE; i++) {
            enc->temporal_gop_rgb_frames[i] = malloc(frame_size * 3);
            enc->temporal_gop_y_frames[i] = malloc(frame_size * sizeof(float));
            enc->temporal_gop_co_frames[i] = malloc(frame_size * sizeof(float));
            enc->temporal_gop_cg_frames[i] = malloc(frame_size * sizeof(float));
        }

        if (enc->verbose) {
            printf("  Adjusted GOP capacity from %d to %d frames\n",
                   TEMPORAL_GOP_SIZE, ANALYSIS_GOP_MAX_SIZE);
        }

        // Write all screen masking packets NOW (after first pass analysis)
        write_all_screen_mask_packets(enc, enc->output_fp);

        printf("\n=== Two-Pass Encoding: Second Pass (Encoding) ===\n");
    }

    printf("Starting encoding...\n");

    // Main encoding loop - process frames until EOF or frame limit
    int frame_count = 0;
    int true_frame_count = 0;
    int continue_encoding = 1;

    // Write timecode packet for frame 0 (before the first frame group)
    write_timecode_packet(enc->output_fp, 0, enc->output_fps, enc->is_ntsc_framerate);

    while (continue_encoding) {
        // Check encode limit if specified
        if (enc->encode_limit > 0 && frame_count >= enc->encode_limit) {
            printf("Reached encode limit of %d frames, finalising...\n", enc->encode_limit);
            continue_encoding = 0;
            break;
        }

        // Write timecode packet for frames 1+ (right after sync packet from previous frame)
        // Skip timecode emission in temporal DWT mode (GOP handles its own timecodes)
        if (frame_count > 0 && !enc->enable_temporal_dwt) {
            write_timecode_packet(enc->output_fp, frame_count, enc->output_fps, enc->is_ntsc_framerate);
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
        double scene_change_ratio = 0.0;
        int is_scene_change = 0;

        // Only detect scene changes in non-two-pass mode (two-pass uses pre-computed GOP boundaries)
        if (!enc->two_pass_mode) {
            is_scene_change = detect_scene_change(enc, &scene_change_ratio);
        }

        int is_time_keyframe = (frame_count % TEMPORAL_GOP_SIZE) == 0;

        // Check if we can use SKIP mode (DWT coefficient-based detection)
        int is_still = detect_still_frame(enc);
        enc->is_still_frame_cached = is_still;  // Cache for use in compress_and_write_frame

        // SKIP mode can be used if frame is still (detect_still_frame_dwt already checks against I-frame)
        // SKIP runs can continue as long as frames remain identical to the reference I-frame
        int in_skip_run = enc->used_skip_mode_last_frame;
        int can_use_skip = is_still && enc->previous_coeffs_allocated;

        // During a SKIP run, suppress keyframe timer unless content changes enough to un-skip
        // Un-skip threshold is the negation of SKIP threshold: content must change to break the run
        int suppress_keyframe_timer = in_skip_run && is_still;

        // Keyframe decision: intra-only mode, time-based (unless suppressed by SKIP run), scene change,
        // or when both delta encoding and residual coding are disabled and skip mode cannot be used (pure INTRA frames)
        int is_keyframe = enc->intra_only ||
                         (is_time_keyframe && !suppress_keyframe_timer) ||
                         is_scene_change ||
                         (!enc->use_delta_encoding && !enc->enable_residual_coding && !can_use_skip);

        // Track if we'll use SKIP mode this frame (continues the SKIP run)
        enc->used_skip_mode_last_frame = can_use_skip && !is_keyframe;

        // Verbose output for keyframe decisions
        /*if (enc->verbose && is_keyframe) {
            if (is_scene_change && !is_time_keyframe) {
                printf("Frame %d: Scene change detected, inserting keyframe\n", frame_count);
            } else if (is_time_keyframe) {
                printf("Frame %d: Time-based keyframe (interval: %d)\n", frame_count, TEMPORAL_GOP_SIZE);
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

        // Choose encoding path based on configuration
        size_t packet_size = 0;

        // For GOP encoding, audio/subtitles are handled in gop_flush() for all GOP frames
        // For traditional encoding, process audio/subtitles for this single frame
        if (!enc->enable_temporal_dwt) {
            // Process audio for this frame
            process_audio(enc, true_frame_count, enc->output_fp);

            // Note: Subtitles are now written upfront in SSF-TC format (see write_all_subtitles_tc)
            // process_subtitles() is no longer called here
        }

        if (enc->enable_temporal_dwt) {
            // GOP-based temporal 3D DWT encoding path

            // Two-tier scene change handling:
            // - Hard scene change (ratio >= 0.7): Force I-frames for current GOP, then flush
            // - Soft scene change (0.5 <= ratio < 0.7): Only flush if GOP >= 10 frames (enforce minimum GOP size)
            // - No scene change (ratio < 0.5): Don't flush

            int should_flush_scene_change = 0;
            int force_iframes_for_scene_change = 0;

            // Only use old scene change detection in non-two-pass mode
            // Two-pass mode uses pre-computed GOP boundaries instead
            if (!enc->two_pass_mode) {
                if (is_scene_change && enc->temporal_gop_frame_count > 0) {

                    if (scene_change_ratio >= SCENE_CHANGE_THRESHOLD_HARD) {
                        // Hard scene change: Force current GOP to be I-frames, then flush immediately
                        should_flush_scene_change = 1;
                        force_iframes_for_scene_change = 1;
                        if (enc->verbose) {
                            printf("Hard scene change (ratio=%.4f) at frame %d, forcing I-frames and flushing GOP...\n",
                                   scene_change_ratio, frame_count);
                        }
                    } else if (enc->temporal_gop_frame_count >= TEMPORAL_GOP_SIZE_MIN) {
                        // Soft scene change with sufficient GOP size: Flush normally
                        should_flush_scene_change = 1;
                        if (enc->verbose) {
                            printf("Soft scene change (ratio=%.4f) at frame %d with GOP size %d >= %d, flushing GOP...\n",
                                   scene_change_ratio, frame_count, enc->temporal_gop_frame_count, TEMPORAL_GOP_SIZE_MIN);
                        }
                    } else {
                        // Soft scene change with small GOP: Ignore to enforce minimum GOP size
                        if (enc->verbose) {
                            printf("Soft scene change (ratio=%.4f) at frame %d ignored (GOP size %d < %d)\n",
                                   scene_change_ratio, frame_count, enc->temporal_gop_frame_count, TEMPORAL_GOP_SIZE_MIN);
                        }
                    }
                }
            }

            if (should_flush_scene_change) {
                // Get quantiser
                int qY = enc->bitrate_mode ? quantiser_float_to_int_dithered(enc) : enc->quantiser_y;

                if (force_iframes_for_scene_change) {
                    // Hard scene change: Encode each frame in GOP as separate I-frame (GOP size = 1)
                    // This ensures clean cut at major scene transitions
                    size_t total_bytes = 0;
                    int original_gop_frame_count = enc->temporal_gop_frame_count;

                    for (int i = 0; i < original_gop_frame_count; i++) {
                        // Temporarily set up GOP to contain only this single frame
                        // Save position 0 pointers
                        uint8_t *saved_rgb_frame0 = enc->temporal_gop_rgb_frames[0];
                        float *saved_y_frame0 = enc->temporal_gop_y_frames[0];
                        float *saved_co_frame0 = enc->temporal_gop_co_frames[0];
                        float *saved_cg_frame0 = enc->temporal_gop_cg_frames[0];

                        // Set up single-frame GOP by moving frame i to position 0
                        enc->temporal_gop_rgb_frames[0] = enc->temporal_gop_rgb_frames[i];
                        enc->temporal_gop_y_frames[0] = enc->temporal_gop_y_frames[i];
                        enc->temporal_gop_co_frames[0] = enc->temporal_gop_co_frames[i];
                        enc->temporal_gop_cg_frames[0] = enc->temporal_gop_cg_frames[i];
                        enc->temporal_gop_frame_count = 1;

                        // Encode single frame as I-frame (GOP size 1)
                        int frame_num = frame_count - original_gop_frame_count + i;
                        size_t bytes = gop_flush(enc, enc->output_fp, QLUT[qY], &frame_num, 1);

                        if (bytes == 0) {
                            fprintf(stderr, "Error: Failed to encode I-frame %d during hard scene change\n", frame_num);
                            enc->temporal_gop_frame_count = original_gop_frame_count;
                            break;
                        }
                        total_bytes += bytes;

                        // Restore position 0 pointers
                        enc->temporal_gop_rgb_frames[0] = saved_rgb_frame0;
                        enc->temporal_gop_y_frames[0] = saved_y_frame0;
                        enc->temporal_gop_co_frames[0] = saved_co_frame0;
                        enc->temporal_gop_cg_frames[0] = saved_cg_frame0;
                    }

                    // Restore original frame count
                    enc->temporal_gop_frame_count = original_gop_frame_count;
                    packet_size = total_bytes;

                } else {
                    // Soft scene change: Flush GOP normally as temporal GOP
                    int *gop_frame_numbers = malloc(enc->temporal_gop_frame_count * sizeof(int));
                    for (int i = 0; i < enc->temporal_gop_frame_count; i++) {
                        gop_frame_numbers[i] = frame_count - enc->temporal_gop_frame_count + i;
                    }

                    packet_size = gop_process_and_flush(enc, enc->output_fp, QLUT[qY],
                                                       gop_frame_numbers, 1);
                    free(gop_frame_numbers);
                }

                if (packet_size == 0) {
                    fprintf(stderr, "Error: Failed to flush GOP before scene change at frame %d\n", frame_count);
                    break;
                }

                // Update total compressed size with GOP packet
                enc->total_compressed_size += packet_size;

                gop_reset(enc);

                // Two-pass mode: advance to next GOP boundary
                if (enc->two_pass_mode && enc->current_gop_boundary) {
                    enc->current_gop_boundary = enc->current_gop_boundary->next;
                    if (enc->verbose && enc->current_gop_boundary) {
                        printf("  Advanced to next GOP: frames %d-%d (length %d)\n",
                               enc->current_gop_boundary->start_frame,
                               enc->current_gop_boundary->end_frame,
                               enc->current_gop_boundary->num_frames);
                    }
                }
            }

            // Now add current frame to GOP (will be first frame of new GOP if scene change)
            int add_result = temporal_gop_add_frame(enc, enc->current_frame_rgb,
                                          enc->current_frame_y, enc->current_frame_co, enc->current_frame_cg);

            if (add_result != 0) {
                fprintf(stderr, "Error: Failed to add frame %d to GOP buffer\n", frame_count);
                break;
            }

            // Check if GOP should be flushed (after adding frame)
            int should_flush = 0;
            int force_flush = 0;

            // Two-pass mode: use pre-computed GOP boundaries
            if (enc->two_pass_mode) {
                if (gop_should_flush_twopass(enc, frame_count)) {
                    should_flush = 1;
                    force_flush = 1;  // Force flush at pre-computed boundaries
                }
            }
            // Normal mode: use motion-based detection
            else {
                // Flush if GOP is full
                if (gop_is_full(enc)) {
                    should_flush = 1;
                    if (enc->verbose) {
                        printf("GOP buffer full (%d frames), flushing...\n", enc->temporal_gop_frame_count);
                    }
                }
            }
            // Note: Scene change flush is now handled BEFORE adding frame (above)

            // Flush GOP if needed (for reasons other than scene change)
            if (should_flush) {
                // Build frame number array for this GOP
                int *gop_frame_numbers = malloc(enc->temporal_gop_frame_count * sizeof(int));
                for (int i = 0; i < enc->temporal_gop_frame_count; i++) {
                    gop_frame_numbers[i] = frame_count - enc->temporal_gop_frame_count + 1 + i;
                }

                // Get quantiser (use adjusted quantiser from bitrate control if applicable)
                int qY = enc->bitrate_mode ? quantiser_float_to_int_dithered(enc) : enc->quantiser_y;

                // Process and flush GOP with scene change detection
                packet_size = gop_process_and_flush(enc, enc->output_fp, QLUT[qY],
                                                   gop_frame_numbers, force_flush);

                free(gop_frame_numbers);

                if (packet_size == 0) {
                    fprintf(stderr, "Error: Failed to flush GOP at frame %d\n", frame_count);
                    break;
                }

                // Update total compressed size with GOP packet
                enc->total_compressed_size += packet_size;

                gop_reset(enc);

                // Two-pass mode: advance to next GOP boundary
                if (enc->two_pass_mode && enc->current_gop_boundary) {
                    enc->current_gop_boundary = enc->current_gop_boundary->next;
                    if (enc->verbose && enc->current_gop_boundary) {
                        printf("  Advanced to next GOP: frames %d-%d (length %d)\n",
                               enc->current_gop_boundary->start_frame,
                               enc->current_gop_boundary->end_frame,
                               enc->current_gop_boundary->num_frames);
                    }
                }
            } else if (packet_size == 0) {
                // Frame added to GOP buffer but not flushed yet
                // Skip normal packet processing (no packet written yet)
                // Note: packet_size might already be > 0 from scene change flush above
                packet_size = 0;
            }
        }
        else if (enc->enable_residual_coding) {
            // MPEG-style residual coding path (I/P/B frames with motion compensation)
            // Get quantiser (use adjusted quantiser from bitrate control if applicable)
            int qY = enc->bitrate_mode ? quantiser_float_to_int_dithered(enc) : enc->quantiser_y;

            if (enc->residual_coding_enable_bframes && enc->residual_coding_bframe_count > 0) {
                // ========== B-FRAME GOP REORDERING MODE ==========
                // Pattern: I B B P B B P ... (display order)
                // Encoding: I P B B P B B ... (encode references first, then B-frames)

                // Allocate lookahead buffer on first use
                if (!enc->residual_coding_lookahead_buffer_y) {
                    allocate_lookahead_buffer(enc);
                }

                // Add current frame to buffer
                int buffer_full = add_frame_to_buffer(enc, frame_count);

                // Scene change or keyframe forces flush and I-frame
                if (is_keyframe || is_scene_change) {
                    // Flush buffered B-frames if any (encode as P-frames due to missing reference)
                    while (enc->residual_coding_lookahead_buffer_count > 1) {
                        // Load oldest buffered frame
                        load_frame_from_buffer(enc, 0);

                        // Encode as P-frame (no forward ref for B-frame after scene change)
                        if (enc->residual_coding_enable_adaptive_blocks) {
                            size_t p_size = encode_pframe_adaptive(enc, qY);
                            if (p_size > 0) {
                                update_reference_frame(enc);
                                if (enc->verbose) {
                                    printf("  P-frame (buffered, pre-keyframe): %zu bytes\n", p_size);
                                }
                            }
                        } else {
                            size_t p_size = encode_pframe_residual(enc, qY);
                            if (p_size > 0) {
                                update_reference_frame(enc);
                            }
                        }

                        // Write sync
                        uint8_t sync = TAV_PACKET_SYNC;
                        fwrite(&sync, 1, 1, enc->output_fp);

                        shift_buffer(enc, 1);  // Remove the encoded frame
                    }

                    // Now encode current frame as I-frame
                    load_frame_from_buffer(enc, 0);
                    uint8_t packet_type = TAV_PACKET_IFRAME;
                    packet_size = compress_and_write_frame(enc, packet_type);

                    if (packet_size > 0) {
                        update_reference_frame(enc);
                        if (enc->verbose) {
                            printf("  I-frame: %zu bytes (GOP reset)\n", packet_size);
                        }
                    }

                    // Clear buffer
                    enc->residual_coding_lookahead_buffer_count = 0;
                    enc->residual_coding_frames_since_last_iframe = 0;

                } else if (buffer_full || !continue_encoding) {
                    // Buffer is full (M+1 frames) or end of stream - encode a mini-GOP

                    // Load the FUTURE reference frame (position M, which is the last in buffer)
                    int future_ref_idx = enc->residual_coding_bframe_count;  // M B-frames means ref at position M
                    load_frame_from_buffer(enc, future_ref_idx);

                    // Encode as P-frame and store as next_reference
                    if (enc->residual_coding_enable_adaptive_blocks) {
                        packet_size = encode_pframe_adaptive(enc, qY);
                    } else {
                        packet_size = encode_pframe_residual(enc, qY);
                    }

                    if (packet_size > 0) {
                        // Store current frame as next_reference for B-frames
                        if (!enc->next_residual_coding_reference_frame_allocated) {
                            size_t frame_size = enc->width * enc->height;
                            enc->next_residual_coding_reference_frame_y = malloc(frame_size * sizeof(float));
                            enc->next_residual_coding_reference_frame_co = malloc(frame_size * sizeof(float));
                            enc->next_residual_coding_reference_frame_cg = malloc(frame_size * sizeof(float));
                            enc->next_residual_coding_reference_frame_allocated = 1;
                        }
                        memcpy(enc->next_residual_coding_reference_frame_y, enc->current_frame_y, enc->width * enc->height * sizeof(float));
                        memcpy(enc->next_residual_coding_reference_frame_co, enc->current_frame_co, enc->width * enc->height * sizeof(float));
                        memcpy(enc->next_residual_coding_reference_frame_cg, enc->current_frame_cg, enc->width * enc->height * sizeof(float));

                        if (enc->verbose) {
                            printf("  P-frame (future ref): %zu bytes\n", packet_size);
                        }

                        // Write sync after P-frame
                        uint8_t sync = TAV_PACKET_SYNC;
                        fwrite(&sync, 1, 1, enc->output_fp);
                    }

                    // Now encode all B-frames between previous and next reference
                    for (int b = 0; b < enc->residual_coding_bframe_count && b < enc->residual_coding_lookahead_buffer_count - 1; b++) {
                        load_frame_from_buffer(enc, b);

                        // Encode as B-frame using bidirectional prediction
                        if (enc->residual_coding_enable_adaptive_blocks) {
                            size_t b_size = encode_bframe_adaptive(enc, qY);
                            if (b_size > 0 && enc->verbose) {
                                printf("  B-frame %d: %zu bytes\n", b, b_size);
                            }
                        } else {
                            // Fallback: encode as P-frame if fixed blocks
                            size_t b_size = encode_pframe_residual(enc, qY);
                            if (b_size > 0 && enc->verbose) {
                                printf("  B→P-frame %d: %zu bytes (fallback)\n", b, b_size);
                            }
                        }

                        // Write sync after each B-frame
                        uint8_t sync = TAV_PACKET_SYNC;
                        fwrite(&sync, 1, 1, enc->output_fp);
                    }

                    // Update reference: next_reference becomes current reference for next mini-GOP
                    memcpy(enc->residual_coding_reference_frame_y, enc->next_residual_coding_reference_frame_y, enc->width * enc->height * sizeof(float));
                    memcpy(enc->residual_coding_reference_frame_co, enc->next_residual_coding_reference_frame_co, enc->width * enc->height * sizeof(float));
                    memcpy(enc->residual_coding_reference_frame_cg, enc->next_residual_coding_reference_frame_cg, enc->width * enc->height * sizeof(float));
                    enc->residual_coding_reference_frame_allocated = 1;

                    // Shift buffer to remove encoded frames (P-frame + B-frames)
                    shift_buffer(enc, enc->residual_coding_bframe_count + 1);

                    packet_size = 1;  // Signal success (multiple packets written)
                } else {
                    // Buffer not full yet, continue reading frames
                    packet_size = 0;  // No packet written yet
                }

            } else {
                // ========== TRADITIONAL I/P MODE (NO B-FRAMES) ==========
                if (is_keyframe || !enc->residual_coding_reference_frame_allocated) {
                    // I-frame: encode normally and update reference
                    uint8_t packet_type = TAV_PACKET_IFRAME;
                    packet_size = compress_and_write_frame(enc, packet_type);

                    if (packet_size > 0) {
                        // Update reference frame for next P-frame
                        update_reference_frame(enc);

                        if (enc->verbose) {
                            printf("  I-frame: %zu bytes (reference updated)\n", packet_size);
                        }
                    }
                } else {
                    // P-frame: encode residual with motion compensation
                    if (enc->residual_coding_enable_adaptive_blocks) {
                        packet_size = encode_pframe_adaptive(enc, qY);
                    } else {
                        packet_size = encode_pframe_residual(enc, qY);
                    }

                    if (packet_size > 0) {
                        // Update reference frame for next P-frame
                        update_reference_frame(enc);
                    }
                }
            }
        }
        else {
            // Traditional 2D DWT encoding path (no temporal transform, no motion compensation)
            uint8_t packet_type = is_keyframe ? TAV_PACKET_IFRAME : TAV_PACKET_PFRAME;
            packet_size = compress_and_write_frame(enc, packet_type);
        }

        if (packet_size == 0 && !enc->enable_temporal_dwt && !(enc->residual_coding_enable_bframes && enc->residual_coding_bframe_count > 0)) {
            // Traditional 2D path: packet_size == 0 means encoding failed
            // B-frame mode: packet_size == 0 is normal when buffering frames
            fprintf(stderr, "Error: Failed to compress frame %d\n", frame_count);
            break;
        }

        // Process audio/subtitles and sync packets only when frames were actually written
        if (packet_size > 0) {
            // Update bitrate tracking with compressed video packet size
            if (enc->bitrate_mode) {
                // For GOP-based encoding, packet_size covers multiple frames
                // For traditional encoding, packet_size includes packet header (5 bytes)
                size_t video_data_size = packet_size;
                update_video_rate_bin(enc, video_data_size);
                adjust_quantiser_for_bitrate(enc);
            }

            // Write a sync packet only after a video is been coded
            // For GOP encoding, GOP_SYNC packet already serves as sync - don't emit extra SYNC
            // For B-frame mode, sync packets are already written in the encoding loop
            if (!enc->enable_temporal_dwt && !(enc->residual_coding_enable_bframes && enc->residual_coding_bframe_count > 0)) {
                uint8_t sync_packet = TAV_PACKET_SYNC;
                fwrite(&sync_packet, 1, 1, enc->output_fp);
            }

            // NTSC frame duplication: emit extra sync packet for every 1000n+500 frames
            // Skip when temporal DWT is enabled (audio handled in GOP flush)
            if (!enc->enable_temporal_dwt && enc->is_ntsc_framerate && (frame_count % 1000 == 500)) {
                true_frame_count++;
                // Process audio for the duplicated frame to maintain sync
                process_audio(enc, true_frame_count, enc->output_fp);
                // Note: Subtitles are now written upfront in SSF-TC format (see write_all_subtitles_tc)

                uint8_t sync_packet_ntsc = TAV_PACKET_SYNC_NTSC;
                fwrite(&sync_packet_ntsc, 1, 1, enc->output_fp);
                printf("Frame %d: NTSC duplication - extra sync packet emitted with audio/subtitle sync\n", frame_count);
            }
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

            int display_qY = enc->bitrate_mode ? quantiser_float_to_int_dithered(enc) : enc->quantiser_y;
            printf("Encoded frame %d (%s, %.1f fps, qY=%d)\n", frame_count,
                   is_keyframe ? "I-frame" : "P-frame", fps, QLUT[display_qY]);
        }
    }

    // Flush any remaining GOP frames (temporal 3D DWT mode only)
    if (enc->enable_temporal_dwt && enc->temporal_gop_frame_count > 0) {
        printf("Flushing remaining %d frames from GOP buffer...\n", enc->temporal_gop_frame_count);

        // Build frame number array for remaining GOP
        int *gop_frame_numbers = malloc(enc->temporal_gop_frame_count * sizeof(int));
        for (int i = 0; i < enc->temporal_gop_frame_count; i++) {
            gop_frame_numbers[i] = frame_count - enc->temporal_gop_frame_count + 1 + i;
        }

        // Get quantiser (use adjusted quantiser from bitrate control if applicable)
        int qY = enc->bitrate_mode ? quantiser_float_to_int_dithered(enc) : enc->quantiser_y;

        // Flush remaining GOP with force_flush=1 to process all frames
        size_t final_packet_size = gop_process_and_flush(enc, enc->output_fp, QLUT[qY],
                                                         gop_frame_numbers, 1);

        free(gop_frame_numbers);

        if (final_packet_size == 0) {
            fprintf(stderr, "Warning: Failed to flush final GOP frames\n");
        } else {
            // Update total compressed size with final GOP packet
            enc->total_compressed_size += final_packet_size;
            // GOP_SYNC packet already written by gop_process_and_flush - no additional SYNC needed
            printf("Final GOP flushed successfully (%zu bytes)\n", final_packet_size);
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

        // Update ENDT in extended header (calculate end time for last frame)
        uint64_t endt_ns;
        if (enc->is_ntsc_framerate) {
            // NTSC framerates use denominator 1001 (e.g., 24000/1001, 30000/1001, 60000/1001)
            endt_ns = ((uint64_t)(frame_count - 1) * 1001ULL * 1000000000ULL) / ((uint64_t)enc->output_fps * 1000ULL);
        } else {
            endt_ns = ((uint64_t)(frame_count - 1) * 1000000000ULL) / (uint64_t)enc->output_fps;
        }
        fseek(enc->output_fp, enc->extended_header_offset, SEEK_SET);
        fwrite(&endt_ns, sizeof(uint64_t), 1, enc->output_fp);
        fseek(enc->output_fp, current_pos, SEEK_SET);  // Restore position
        if (enc->verbose) {
            printf("Updated ENDT in extended header: %llu ns\n", (unsigned long long)endt_ns);
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

    // Get actual output size from file position (includes all data: headers, video, audio, sync packets, etc.)
    size_t actual_output_size = 0;
    if (enc->output_fp != stdout) {
        actual_output_size = ftell(enc->output_fp);
    } else {
        // For stdout, use tracked size (may be incomplete but better than nothing)
        actual_output_size = enc->total_compressed_size;
    }
    printf("  Output size: %zu bytes\n", actual_output_size);
    printf("  Encoding time: %.2fs (%.1f fps)\n", total_time, frame_count / total_time);
    printf("  Frame statistics: INTRA=%lu, DELTA=%lu, SKIP=%lu, GOP=%lu\n", count_intra, count_delta, count_skip, count_gop);


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
    if (enc->pcm_file) {
        fclose(enc->pcm_file);
        unlink(TEMP_PCM_FILE);
    }
    if (enc->output_fp) {
        fclose(enc->output_fp);
    }

    // Free PCM8 buffers
    free(enc->pcm32_buffer);
    free(enc->pcm8_buffer);

    free(enc->input_file);
    free(enc->output_file);
    free(enc->subtitle_file);
    free(enc->fontrom_lo_file);
    free(enc->fontrom_hi_file);
    free(enc->ffmpeg_version);
    free(enc->frame_rgb[0]);
    free(enc->frame_rgb[1]);
    free(enc->current_frame_y);
    free(enc->current_frame_co);
    free(enc->current_frame_cg);
    free(enc->current_frame_alpha);
    free(enc->tiles);
    free(enc->compressed_buffer);
    free(enc->mp2_buffer);
    free(enc->widths);
    free(enc->heights);

    // OPTIMISATION: Free reusable quantisation buffers
    free(enc->reusable_quantised_y);
    free(enc->reusable_quantised_co);
    free(enc->reusable_quantised_cg);
    free(enc->reusable_quantised_alpha);

    // Free coefficient delta storage
    free(enc->previous_coeffs_y);
    free(enc->previous_coeffs_co);
    free(enc->previous_coeffs_cg);
    free(enc->previous_coeffs_alpha);

    // Free bitrate control structures
    free(enc->video_rate_bin);

    // Free GOP buffers
    if (enc->temporal_gop_rgb_frames) {
        for (int i = 0; i < enc->temporal_gop_capacity; i++) {
            free(enc->temporal_gop_rgb_frames[i]);
        }
        free(enc->temporal_gop_rgb_frames);
    }
    if (enc->temporal_gop_y_frames) {
        for (int i = 0; i < enc->temporal_gop_capacity; i++) {
            free(enc->temporal_gop_y_frames[i]);
        }
        free(enc->temporal_gop_y_frames);
    }
    if (enc->temporal_gop_co_frames) {
        for (int i = 0; i < enc->temporal_gop_capacity; i++) {
            free(enc->temporal_gop_co_frames[i]);
        }
        free(enc->temporal_gop_co_frames);
    }
    if (enc->temporal_gop_cg_frames) {
        for (int i = 0; i < enc->temporal_gop_capacity; i++) {
            free(enc->temporal_gop_cg_frames[i]);
        }
        free(enc->temporal_gop_cg_frames);
    }

    // Free MPEG-style residual coding buffers
    free(enc->residual_coding_reference_frame_y);
    free(enc->residual_coding_reference_frame_co);
    free(enc->residual_coding_reference_frame_cg);
    free(enc->residual_coding_motion_vectors_x);
    free(enc->residual_coding_motion_vectors_y);
    free(enc->residual_coding_skip_blocks);
    free(enc->residual_coding_predicted_frame_y);
    free(enc->residual_coding_predicted_frame_co);
    free(enc->residual_coding_predicted_frame_cg);
    free(enc->residual_coding_residual_frame_y);
    free(enc->residual_coding_residual_frame_co);
    free(enc->residual_coding_residual_frame_cg);

    // Free subtitle list
    if (enc->subtitles) {
        free_subtitle_list(enc->subtitles);
    }

    // Free two-pass data structures
    if (enc->frame_analyses) {
        free(enc->frame_analyses);
    }
    if (enc->gop_boundaries) {
        free_gop_boundaries(enc->gop_boundaries);
    }

    if (enc->zstd_ctx) {
        ZSTD_freeCCtx(enc->zstd_ctx);
    }

    free(enc);
}