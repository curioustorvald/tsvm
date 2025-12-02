// Created by CuriousTorvald and Claude on 2025-12-02.
// TAV Video Decoder Library - Shared decoding functions for TAV format
// Can be used by both regular TAV decoder and TAV-DT decoder

#include "tav_video_decoder.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <zstd.h>

//=============================================================================
// Internal Constants and Macros
//=============================================================================

#define CLAMP(x, min, max) ((x) < (min) ? (min) : ((x) > (max) ? (max) : (x)))

// Perceptual quantisation constants (match TSVM)
static const float ANISOTROPY_MULT[] = {2.0f, 1.8f, 1.6f, 1.4f, 1.2f, 1.0f};
static const float ANISOTROPY_BIAS[] = {0.4f, 0.2f, 0.1f, 0.0f, 0.0f, 0.0f};
static const float ANISOTROPY_MULT_CHROMA[] = {7.0f, 6.0f, 5.0f, 4.0f, 3.0f, 2.0f, 1.0f};
static const float ANISOTROPY_BIAS_CHROMA[] = {1.0f, 0.8f, 0.6f, 0.4f, 0.2f, 0.0f, 0.0f};
static const float FOUR_PIXEL_DETAILER = 0.88f;
static const float TWO_PIXEL_DETAILER = 0.92f;

// Quantisation Lookup Table (matches TSVM exactly)
static const int QLUT[] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096};

//=============================================================================
// Internal Structures
//=============================================================================

// DWT subband information
typedef struct {
    int level;              // Decomposition level (1 to decompLevels)
    int subband_type;       // 0=LL, 1=LH, 2=HL, 3=HH
    int coeff_start;        // Starting index in linear coefficient array
    int coeff_count;        // Number of coefficients in this subband
} dwt_subband_info_t;

// EZBC Block structure for quadtree
typedef struct {
    int x, y;
    int width, height;
} ezbc_block_t;

// EZBC bitstream reader state
typedef struct {
    const uint8_t *data;
    size_t size;
    size_t byte_pos;
    int bit_pos;
} ezbc_bitreader_t;

// EZBC block queues (simple dynamic arrays)
typedef struct {
    ezbc_block_t *blocks;
    int count;
    int capacity;
} ezbc_block_queue_t;

// Video decoder context (opaque to users)
struct tav_video_context {
    tav_video_params_t params;

    // Working buffers
    float *dwt_buffer_y;
    float *dwt_buffer_co;
    float *dwt_buffer_cg;
    float *reference_ycocg_y;   // For P-frame delta accumulation
    float *reference_ycocg_co;
    float *reference_ycocg_cg;

    // Error message buffer
    char error_msg[256];

    // Debug flag
    int verbose;
};

//=============================================================================
// DWT Subband Layout Calculation (matches TSVM)
//=============================================================================

static int calculate_subband_layout(int width, int height, int decomp_levels, dwt_subband_info_t *subbands) {
    int subband_count = 0;

    // generate division series
    int widths[decomp_levels + 1]; widths[0] = width;
    int heights[decomp_levels + 1]; heights[0] = height;

    for (int i = 1; i < decomp_levels + 1; i++) {
        widths[i] = (int)roundf(widths[i - 1] / 2.0f);
        heights[i] = (int)roundf(heights[i - 1] / 2.0f);
    }

    // LL subband at maximum decomposition level
    int ll_width = widths[decomp_levels];
    int ll_height = heights[decomp_levels];
    subbands[subband_count++] = (dwt_subband_info_t){decomp_levels, 0, 0, ll_width * ll_height};
    int coeff_offset = ll_width * ll_height;

    // LH, HL, HH subbands for each level from max down to 1
    for (int level = decomp_levels; level >= 1; level--) {
        int level_width = widths[decomp_levels - level + 1];
        int level_height = heights[decomp_levels - level + 1];
        const int subband_size = level_width * level_height;

        // LH subband
        subbands[subband_count++] = (dwt_subband_info_t){level, 1, coeff_offset, subband_size};
        coeff_offset += subband_size;

        // HL subband
        subbands[subband_count++] = (dwt_subband_info_t){level, 2, coeff_offset, subband_size};
        coeff_offset += subband_size;

        // HH subband
        subbands[subband_count++] = (dwt_subband_info_t){level, 3, coeff_offset, subband_size};
        coeff_offset += subband_size;
    }

    return subband_count;
}

//=============================================================================
// Perceptual Quantisation Model (matches TSVM exactly)
//=============================================================================

static int tav_derive_encoder_qindex(int q_index, int q_y_global) {
    if (q_index > 0) return q_index - 1;
    if (q_y_global >= 60) return 0;
    else if (q_y_global >= 42) return 1;
    else if (q_y_global >= 25) return 2;
    else if (q_y_global >= 12) return 3;
    else if (q_y_global >= 6) return 4;
    else if (q_y_global >= 2) return 5;
    else return 5;
}

static float perceptual_model3_LH(float level) {
    const float H4 = 1.2f;
    const float K = 2.0f;
    const float K12 = K * 12.0f;
    const float x = level;

    const float Lx = H4 - ((K + 1.0f) / 15.0f) * (x - 4.0f);
    const float C3 = -1.0f / 45.0f * (K12 + 92.0f);
    const float G3x = (-x / 180.0f) * (K12 + 5.0f * x * x - 60.0f * x + 252.0f) - C3 + H4;

    return (level >= 4.0f) ? Lx : G3x;
}

static float perceptual_model3_HL(int quality, float LH) {
    return LH * ANISOTROPY_MULT[quality] + ANISOTROPY_BIAS[quality];
}

static float lerp(float x, float y, float a) {
    return x * (1.0f - a) + y * a;
}

static float perceptual_model3_HH(float LH, float HL, float level) {
    const float Kx = (sqrtf(level) - 1.0f) * 0.5f + 0.5f;
    return lerp(LH, HL, Kx);
}

static float perceptual_model3_LL(float level) {
    const float n = perceptual_model3_LH(level);
    const float m = perceptual_model3_LH(level - 1.0f) / n;
    return n / m;
}

static float perceptual_model3_chroma_basecurve(int quality, float level) {
    return 1.0f - (1.0f / (0.5f * quality * quality + 1.0f)) * (level - 4.0f);
}

static float get_perceptual_weight(int q_index, int q_y_global, int level0, int subband_type,
                                  int is_chroma, int max_levels) {
    // Convert to perceptual level (1-6 scale)
    const float level = 1.0f + ((level0 - 1.0f) / (max_levels - 1.0f)) * 5.0f;
    const int quality_level = tav_derive_encoder_qindex(q_index, q_y_global);

    if (!is_chroma) {
        // LUMA CHANNEL
        if (subband_type == 0) {
            return perceptual_model3_LL(level);
        }

        const float LH = perceptual_model3_LH(level);
        if (subband_type == 1) {
            return LH;
        }

        const float HL = perceptual_model3_HL(quality_level, LH);
        if (subband_type == 2) {
            float detailer = 1.0f;
            if (level >= 1.8f && level <= 2.2f) detailer = TWO_PIXEL_DETAILER;
            else if (level >= 2.8f && level <= 3.2f) detailer = FOUR_PIXEL_DETAILER;
            return HL * detailer;
        } else {
            // HH subband
            float detailer = 1.0f;
            if (level >= 1.8f && level <= 2.2f) detailer = TWO_PIXEL_DETAILER;
            else if (level >= 2.8f && level <= 3.2f) detailer = FOUR_PIXEL_DETAILER;
            return perceptual_model3_HH(LH, HL, level) * detailer;
        }
    } else {
        // CHROMA CHANNELS
        const float base = perceptual_model3_chroma_basecurve(quality_level, level - 1);
        if (subband_type == 0) {
            return 1.0f;
        } else if (subband_type == 1) {
            return fmaxf(base, 1.0f);
        } else if (subband_type == 2) {
            return fmaxf(base * ANISOTROPY_MULT_CHROMA[quality_level], 1.0f);
        } else {
            return fmaxf(base * ANISOTROPY_MULT_CHROMA[quality_level] + ANISOTROPY_BIAS_CHROMA[quality_level], 1.0f);
        }
    }
}

static void dequantise_dwt_subbands_perceptual(int q_index, int q_y_global, const int16_t *quantised,
                                              float *dequantised, int width, int height, int decomp_levels,
                                              float base_quantiser, int is_chroma) {
    dwt_subband_info_t subbands[32]; // Max possible subbands
    const int subband_count = calculate_subband_layout(width, height, decomp_levels, subbands);

    const int coeff_count = width * height;
    memset(dequantised, 0, coeff_count * sizeof(float));

    // Apply perceptual weighting to each subband
    for (int s = 0; s < subband_count; s++) {
        const dwt_subband_info_t *subband = &subbands[s];
        const float weight = get_perceptual_weight(q_index, q_y_global, subband->level,
                                                  subband->subband_type, is_chroma, decomp_levels);
        const float effective_quantiser = base_quantiser * weight;

        // Apply linear dequantisation with perceptual weights
        for (int i = 0; i < subband->coeff_count; i++) {
            const int idx = subband->coeff_start + i;
            if (idx < coeff_count) {
                const float untruncated = quantised[idx] * effective_quantiser;
                dequantised[idx] = untruncated;
            }
        }
    }
}

//=============================================================================
// Grain Synthesis (matches TSVM exactly)
//=============================================================================

// Deterministic RNG for grain synthesis (matches encoder)
static inline uint32_t tav_grain_synthesis_rng(uint32_t frame, uint32_t band, uint32_t x, uint32_t y) {
    uint32_t key = frame * 0x9e3779b9u ^ band * 0x7f4a7c15u ^ (y << 16) ^ x;
    uint32_t hash = key;
    hash = hash ^ (hash >> 16);
    hash = hash * 0x7feb352du;
    hash = hash ^ (hash >> 15);
    hash = hash * 0x846ca68bu;
    hash = hash ^ (hash >> 16);
    return hash;
}

// Generate triangular noise from uint32 RNG (returns value in range [-1.0, 1.0])
static inline float tav_grain_triangular_noise(uint32_t rng_val) {
    float u1 = (rng_val & 0xFFFFu) / 65535.0f;
    float u2 = ((rng_val >> 16) & 0xFFFFu) / 65535.0f;
    return (u1 + u2) - 1.0f;
}

// Apply grain synthesis from DWT coefficients (decoder subtracts noise)
static void apply_grain_synthesis(float *coeffs, int width, int height,
                                 int decomp_levels, int frame_num, int q_y_global, uint8_t encoder_preset) {
    // Anime preset: completely disable grain synthesis
    if (encoder_preset & 0x02) {
        return;
    }

    dwt_subband_info_t subbands[32];
    const int subband_count = calculate_subband_layout(width, height, decomp_levels, subbands);

    // Noise amplitude (matches Kotlin)
    const float noise_amplitude = (q_y_global < 32 ? q_y_global : 32) * 0.4f;

    // Process each subband (skip LL band which is level 0)
    for (int s = 0; s < subband_count; s++) {
        const dwt_subband_info_t *subband = &subbands[s];
        if (subband->level == 0) continue;

        uint32_t band = subband->level + subband->subband_type * 31 + 16777619;

        for (int i = 0; i < subband->coeff_count; i++) {
            const int idx = subband->coeff_start + i;
            if (idx < width * height) {
                int y = idx / width;
                int x = idx % width;

                uint32_t rng_val = tav_grain_synthesis_rng(frame_num, band, x, y);
                float noise = tav_grain_triangular_noise(rng_val);

                coeffs[idx] -= noise * noise_amplitude;
            }
        }
    }
}

//=============================================================================
// Significance Map Postprocessing (2-bit map format)
//=============================================================================

// Helper: Extract 2-bit code from bit-packed array
static inline int get_twobit_code(const uint8_t *map_data, int map_bytes, int coeff_idx) {
    int bit_pos = coeff_idx * 2;
    int byte_idx = bit_pos / 8;
    int bit_offset = bit_pos % 8;

    uint8_t byte0 = map_data[byte_idx];
    int code = (byte0 >> bit_offset) & 0x03;

    // Handle byte boundary crossing
    if (bit_offset == 7 && byte_idx + 1 < map_bytes) {
        uint8_t byte1 = map_data[byte_idx + 1];
        code = ((byte0 >> 7) & 0x01) | ((byte1 << 1) & 0x02);
    }

    return code;
}

// Decoder: reconstruct coefficients from 2-bit map format (entropyCoder=0)
static void postprocess_coefficients_twobit(uint8_t *compressed_data, int coeff_count,
                                           int16_t *output_y, int16_t *output_co, int16_t *output_cg) {
    int map_bytes = (coeff_count * 2 + 7) / 8;

    uint8_t *y_map = compressed_data;
    uint8_t *co_map = compressed_data + map_bytes;
    uint8_t *cg_map = compressed_data + map_bytes * 2;

    // Count "other" values (code 11) for each channel
    int y_others = 0, co_others = 0, cg_others = 0;
    for (int i = 0; i < coeff_count; i++) {
        if (get_twobit_code(y_map, map_bytes, i) == 3) y_others++;
        if (get_twobit_code(co_map, map_bytes, i) == 3) co_others++;
        if (get_twobit_code(cg_map, map_bytes, i) == 3) cg_others++;
    }

    // Value array offsets (after all maps)
    uint8_t *value_ptr = compressed_data + map_bytes * 3;
    int16_t *y_values = (int16_t *)value_ptr;
    int16_t *co_values = (int16_t *)(value_ptr + y_others * 2);
    int16_t *cg_values = (int16_t *)(value_ptr + y_others * 2 + co_others * 2);

    // Reconstruct coefficients
    int y_value_idx = 0, co_value_idx = 0, cg_value_idx = 0;

    for (int i = 0; i < coeff_count; i++) {
        // Y channel
        int y_code = get_twobit_code(y_map, map_bytes, i);
        switch (y_code) {
            case 0: output_y[i] = 0; break;
            case 1: output_y[i] = 1; break;
            case 2: output_y[i] = -1; break;
            case 3: output_y[i] = y_values[y_value_idx++]; break;
        }

        // Co channel
        int co_code = get_twobit_code(co_map, map_bytes, i);
        switch (co_code) {
            case 0: output_co[i] = 0; break;
            case 1: output_co[i] = 1; break;
            case 2: output_co[i] = -1; break;
            case 3: output_co[i] = co_values[co_value_idx++]; break;
        }

        // Cg channel
        int cg_code = get_twobit_code(cg_map, map_bytes, i);
        switch (cg_code) {
            case 0: output_cg[i] = 0; break;
            case 1: output_cg[i] = 1; break;
            case 2: output_cg[i] = -1; break;
            case 3: output_cg[i] = cg_values[cg_value_idx++]; break;
        }
    }
}

//=============================================================================
// EZBC (Embedded Zero Block Coding) Decoder
//=============================================================================

// Read N bits from EZBC bitstream (LSB-first within each byte)
static int ezbc_read_bits(ezbc_bitreader_t *reader, int num_bits) {
    int result = 0;
    for (int i = 0; i < num_bits; i++) {
        if (reader->byte_pos >= reader->size) {
            return result;
        }

        const int bit = (reader->data[reader->byte_pos] >> reader->bit_pos) & 1;
        result |= (bit << i);

        reader->bit_pos++;
        if (reader->bit_pos == 8) {
            reader->bit_pos = 0;
            reader->byte_pos++;
        }
    }
    return result;
}

static void ezbc_queue_init(ezbc_block_queue_t *q) {
    q->capacity = 256;
    q->count = 0;
    q->blocks = malloc(q->capacity * sizeof(ezbc_block_t));
}

static void ezbc_queue_free(ezbc_block_queue_t *q) {
    free(q->blocks);
    q->blocks = NULL;
    q->count = 0;
}

static void ezbc_queue_add(ezbc_block_queue_t *q, ezbc_block_t block) {
    if (q->count >= q->capacity) {
        q->capacity *= 2;
        q->blocks = realloc(q->blocks, q->capacity * sizeof(ezbc_block_t));
    }
    q->blocks[q->count++] = block;
}

// Forward declaration
static int ezbc_process_significant_block_recursive(
    ezbc_bitreader_t *reader, ezbc_block_t block, int bitplane, int threshold,
    int16_t *output, int width, int8_t *significant, int *first_bitplane,
    ezbc_block_queue_t *next_significant, ezbc_block_queue_t *next_insignificant);

// EZBC recursive block decoder (matches Kotlin implementation)
static int ezbc_process_significant_block_recursive(
    ezbc_bitreader_t *reader, ezbc_block_t block, int bitplane, int threshold,
    int16_t *output, int width, int8_t *significant, int *first_bitplane,
    ezbc_block_queue_t *next_significant, ezbc_block_queue_t *next_insignificant) {

    int sign_bits_read = 0;

    // If 1x1 block: read sign bit and add to significant queue
    if (block.width == 1 && block.height == 1) {
        const int idx = block.y * width + block.x;
        const int sign_bit = ezbc_read_bits(reader, 1);
        sign_bits_read++;

        output[idx] = sign_bit ? -threshold : threshold;
        significant[idx] = 1;
        first_bitplane[idx] = bitplane;
        ezbc_queue_add(next_significant, block);
        return sign_bits_read;
    }

    // Block is > 1x1: subdivide and recursively process children
    int mid_x = block.width / 2;
    int mid_y = block.height / 2;
    if (mid_x == 0) mid_x = 1;
    if (mid_y == 0) mid_y = 1;

    // Top-left child
    ezbc_block_t tl = {block.x, block.y, mid_x, mid_y};
    const int tl_flag = ezbc_read_bits(reader, 1);
    if (tl_flag) {
        sign_bits_read += ezbc_process_significant_block_recursive(
            reader, tl, bitplane, threshold, output, width, significant, first_bitplane,
            next_significant, next_insignificant);
    } else {
        ezbc_queue_add(next_insignificant, tl);
    }

    // Top-right child (if exists)
    if (block.width > mid_x) {
        ezbc_block_t tr = {block.x + mid_x, block.y, block.width - mid_x, mid_y};
        const int tr_flag = ezbc_read_bits(reader, 1);
        if (tr_flag) {
            sign_bits_read += ezbc_process_significant_block_recursive(
                reader, tr, bitplane, threshold, output, width, significant, first_bitplane,
                next_significant, next_insignificant);
        } else {
            ezbc_queue_add(next_insignificant, tr);
        }
    }

    // Bottom-left child (if exists)
    if (block.height > mid_y) {
        ezbc_block_t bl = {block.x, block.y + mid_y, mid_x, block.height - mid_y};
        const int bl_flag = ezbc_read_bits(reader, 1);
        if (bl_flag) {
            sign_bits_read += ezbc_process_significant_block_recursive(
                reader, bl, bitplane, threshold, output, width, significant, first_bitplane,
                next_significant, next_insignificant);
        } else {
            ezbc_queue_add(next_insignificant, bl);
        }
    }

    // Bottom-right child (if exists)
    if (block.width > mid_x && block.height > mid_y) {
        ezbc_block_t br = {block.x + mid_x, block.y + mid_y, block.width - mid_x, block.height - mid_y};
        const int br_flag = ezbc_read_bits(reader, 1);
        if (br_flag) {
            sign_bits_read += ezbc_process_significant_block_recursive(
                reader, br, bitplane, threshold, output, width, significant, first_bitplane,
                next_significant, next_insignificant);
        } else {
            ezbc_queue_add(next_insignificant, br);
        }
    }

    return sign_bits_read;
}

// Decode a single channel with EZBC
static void decode_channel_ezbc(const uint8_t *ezbc_data, size_t offset, size_t size,
                               int16_t *output, int expected_count) {
    ezbc_bitreader_t reader = {ezbc_data, offset + size, offset, 0};

    // Read header: MSB bitplane (8 bits), width (16 bits), height (16 bits)
    const int msb_bitplane = ezbc_read_bits(&reader, 8);
    const int width = ezbc_read_bits(&reader, 16);
    const int height = ezbc_read_bits(&reader, 16);

    const int actual_count = width * height;
    if (actual_count > expected_count) {
        memset(output, 0, expected_count * sizeof(int16_t));
        return;
    }

    expected_count = actual_count;

    // Initialise output and state tracking
    memset(output, 0, expected_count * sizeof(int16_t));
    int8_t *significant = calloc(expected_count, sizeof(int8_t));
    int *first_bitplane = calloc(expected_count, sizeof(int));

    // Initialise queues
    ezbc_block_queue_t insignificant, next_insignificant, significant_queue, next_significant;
    ezbc_queue_init(&insignificant);
    ezbc_queue_init(&next_insignificant);
    ezbc_queue_init(&significant_queue);
    ezbc_queue_init(&next_significant);

    // Start with root block
    ezbc_block_t root = {0, 0, width, height};
    ezbc_queue_add(&insignificant, root);

    // Process bitplanes from MSB to LSB
    for (int bitplane = msb_bitplane; bitplane >= 0; bitplane--) {
        const int threshold = 1 << bitplane;

        // Process insignificant blocks
        for (int i = 0; i < insignificant.count; i++) {
            const int flag = ezbc_read_bits(&reader, 1);

            if (flag == 0) {
                ezbc_queue_add(&next_insignificant, insignificant.blocks[i]);
            } else {
                ezbc_process_significant_block_recursive(
                    &reader, insignificant.blocks[i], bitplane, threshold,
                    output, width, significant, first_bitplane,
                    &next_significant, &next_insignificant);
            }
        }

        // Process significant 1x1 blocks (refinement)
        for (int i = 0; i < significant_queue.count; i++) {
            ezbc_block_t block = significant_queue.blocks[i];
            const int idx = block.y * width + block.x;
            const int refine_bit = ezbc_read_bits(&reader, 1);

            if (refine_bit) {
                const int bit_value = 1 << bitplane;
                if (output[idx] < 0) {
                    output[idx] -= bit_value;
                } else {
                    output[idx] += bit_value;
                }
            }

            ezbc_queue_add(&next_significant, block);
        }

        // Swap queues
        ezbc_block_queue_t temp_insig = insignificant;
        insignificant = next_insignificant;
        next_insignificant = temp_insig;
        next_insignificant.count = 0;

        ezbc_block_queue_t temp_sig = significant_queue;
        significant_queue = next_significant;
        next_significant = temp_sig;
        next_significant.count = 0;
    }

    // Cleanup
    free(significant);
    free(first_bitplane);
    ezbc_queue_free(&insignificant);
    ezbc_queue_free(&next_insignificant);
    ezbc_queue_free(&significant_queue);
    ezbc_queue_free(&next_significant);
}

// Helper: peek at EZBC header to get dimensions without decoding
static int ezbc_peek_dimensions(const uint8_t *compressed_data, int channel_layout,
                                 int *out_width, int *out_height) {
    const int has_y = (channel_layout & 0x04) == 0;

    if (!has_y) {
        return -1;
    }

    const uint32_t size = ((uint32_t)compressed_data[0]) |
                         ((uint32_t)compressed_data[1] << 8) |
                         ((uint32_t)compressed_data[2] << 16) |
                         ((uint32_t)compressed_data[3] << 24);

    if (size < 6) {
        return -1;
    }

    const uint8_t *ezbc_data = compressed_data + 4;

    ezbc_bitreader_t reader;
    reader.data = ezbc_data;
    reader.size = size;
    reader.byte_pos = 0;
    reader.bit_pos = 0;

    ezbc_read_bits(&reader, 8);  // Skip MSB bitplane
    *out_width = ezbc_read_bits(&reader, 16);
    *out_height = ezbc_read_bits(&reader, 16);

    return 0;
}

// EZBC postprocessing for single frames
static void postprocess_coefficients_ezbc(uint8_t *compressed_data, int coeff_count,
                                          int16_t *output_y, int16_t *output_co, int16_t *output_cg,
                                          int channel_layout) {
    const int has_y = (channel_layout & 0x04) == 0;
    const int has_co = (channel_layout & 0x02) == 0;
    const int has_cg = (channel_layout & 0x02) == 0;

    int offset = 0;

    // Decode Y channel
    if (has_y && output_y) {
        const uint32_t size = ((uint32_t)compressed_data[offset + 0]) |
                             ((uint32_t)compressed_data[offset + 1] << 8) |
                             ((uint32_t)compressed_data[offset + 2] << 16) |
                             ((uint32_t)compressed_data[offset + 3] << 24);
        offset += 4;
        decode_channel_ezbc(compressed_data, offset, size, output_y, coeff_count);
        offset += size;
    }

    // Decode Co channel
    if (has_co && output_co) {
        const uint32_t size = ((uint32_t)compressed_data[offset + 0]) |
                             ((uint32_t)compressed_data[offset + 1] << 8) |
                             ((uint32_t)compressed_data[offset + 2] << 16) |
                             ((uint32_t)compressed_data[offset + 3] << 24);
        offset += 4;
        decode_channel_ezbc(compressed_data, offset, size, output_co, coeff_count);
        offset += size;
    }

    // Decode Cg channel
    if (has_cg && output_cg) {
        const uint32_t size = ((uint32_t)compressed_data[offset + 0]) |
                             ((uint32_t)compressed_data[offset + 1] << 8) |
                             ((uint32_t)compressed_data[offset + 2] << 16) |
                             ((uint32_t)compressed_data[offset + 3] << 24);
        offset += 4;
        decode_channel_ezbc(compressed_data, offset, size, output_cg, coeff_count);
        offset += size;
    }
}

//=============================================================================
// DWT Inverse Transforms (matches TSVM)
//=============================================================================

// 9/7 inverse DWT (from TSVM Kotlin code)
static void dwt_97_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Split into low and high frequency components
    for (int i = 0; i < half; i++) {
        temp[i] = data[i];
    }
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            temp[half + i] = data[half + i];
        }
    }

    // 9/7 inverse lifting coefficients
    const float alpha = -1.586134342f;
    const float beta = -0.052980118f;
    const float gamma = 0.882911076f;
    const float delta = 0.443506852f;
    const float K = 1.230174105f;

    // Step 1: Undo scaling
    for (int i = 0; i < half; i++) {
        temp[i] /= K;
    }
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            temp[half + i] *= K;
        }
    }

    // Step 2: Undo δ update
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] -= delta * (d_curr + d_prev);
    }

    // Step 3: Undo γ predict
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] -= gamma * (s_curr + s_next);
        }
    }

    // Step 4: Undo β update
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] -= beta * (d_curr + d_prev);
    }

    // Step 5: Undo α predict
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] -= alpha * (s_curr + s_next);
        }
    }

    // Reconstruction - interleave low and high pass
    for (int i = 0; i < length; i++) {
        if (i % 2 == 0) {
            data[i] = temp[i / 2];
        } else {
            int idx = i / 2;
            if (half + idx < length) {
                data[i] = temp[half + idx];
            } else {
                data[i] = 0.0f;
            }
        }
    }

    free(temp);
}

// 5/3 inverse DWT using lifting scheme
static void dwt_53_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    memcpy(temp, data, length * sizeof(float));

    // Undo update step
    for (int i = 0; i < half; i++) {
        float update = 0.25f * ((i > 0 ? temp[half + i - 1] : 0) +
                               (i < half - 1 ? temp[half + i] : 0));
        temp[i] -= update;
    }

    // Undo predict step and interleave
    for (int i = 0; i < half; i++) {
        data[2 * i] = temp[i];
        int idx = 2 * i + 1;
        if (idx < length) {
            float pred = 0.5f * (temp[i] + (i < half - 1 ? temp[i + 1] : temp[i]));
            data[idx] = temp[half + i] + pred;
        }
    }

    free(temp);
}

// CDF 13/7 inverse DWT
static void dwt_cdf137_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(sizeof(float) * length);
    int half = (length + 1) / 2;

    int nE = half;
    int nO = length / 2;

    float *even = temp;
    float *odd  = temp + nE;

    // Load L and H
    for (int i = 0; i < nE; i++) {
        even[i] = data[i];
    }
    for (int i = 0; i < nO; i++) {
        odd[i] = data[half + i];
    }

    // Inverse update
    for (int i = 0; i < nE; i++) {
        float d = (i < nO) ? odd[i] : 0.0f;
        even[i] = even[i] - 0.25f * d;
    }

    // Inverse predict
    for (int i = 0; i < nO; i++) {
        odd[i] = odd[i] + 0.5f * even[i];
    }

    // Interleave
    for (int i = 0; i < nO; i++) {
        data[2 * i]     = even[i];
        data[2 * i + 1] = odd[i];
    }
    if (nE > nO) {
        data[2 * nO] = even[nO];
    }

    free(temp);
}

// DD-4 inverse DWT
static void dwt_dd4_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    memcpy(temp, data, length * sizeof(float));

    // DD-4 inverse lifting
    for (int i = 0; i < half; i++) {
        float update = 0.25f * ((i > 0 ? temp[half + i - 1] : 0) +
                               (i < half - 1 ? temp[half + i] : 0));
        temp[i] -= update;
    }

    for (int i = 0; i < half; i++) {
        data[2 * i] = temp[i];
        int idx = 2 * i + 1;
        if (idx < length) {
            float pred = 0.5f * (temp[i] + (i < half - 1 ? temp[i + 1] : temp[i]));
            data[idx] = temp[half + i] + pred;
        }
    }

    free(temp);
}

// Haar inverse DWT
static void dwt_haar_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    const int half = (length + 1) / 2;

    for (int i = 0; i < half; i++) {
        if (2 * i + 1 < length) {
            temp[2 * i] = data[i] + data[half + i];
            temp[2 * i + 1] = data[i] - data[half + i];
        } else {
            temp[2 * i] = data[i];
        }
    }

    for (int i = 0; i < length; i++) {
        data[i] = temp[i];
    }

    free(temp);
}

// Multi-level inverse DWT
static void apply_inverse_dwt_multilevel(float *data, int width, int height, int levels, int filter_type) {
    int max_size = (width > height) ? width : height;
    float *temp_row = malloc(max_size * sizeof(float));
    float *temp_col = malloc(max_size * sizeof(float));

    // Pre-calculate exact sequence of widths/heights
    int *widths = malloc((levels + 1) * sizeof(int));
    int *heights = malloc((levels + 1) * sizeof(int));

    widths[0] = width;
    heights[0] = height;
    for (int i = 1; i <= levels; i++) {
        widths[i] = (widths[i - 1] + 1) / 2;
        heights[i] = (heights[i - 1] + 1) / 2;
    }

    // Apply inverse transforms
    for (int level = levels - 1; level >= 0; level--) {
        int current_width = widths[level];
        int current_height = heights[level];

        if (current_width < 1 || current_height < 1) continue;
        if (current_width == 1 && current_height == 1) continue;

        // Column inverse transform first (vertical)
        for (int x = 0; x < current_width; x++) {
            for (int y = 0; y < current_height; y++) {
                temp_col[y] = data[y * width + x];
            }

            if (filter_type == 0) {
                dwt_53_inverse_1d(temp_col, current_height);
            } else if (filter_type == 1) {
                dwt_97_inverse_1d(temp_col, current_height);
            } else if (filter_type == 2) {
                dwt_cdf137_inverse_1d(temp_col, current_height);
            } else if (filter_type == 16) {
                dwt_dd4_inverse_1d(temp_col, current_height);
            } else if (filter_type == 255) {
                dwt_haar_inverse_1d(temp_col, current_height);
            }

            for (int y = 0; y < current_height; y++) {
                data[y * width + x] = temp_col[y];
            }
        }

        // Row inverse transform second (horizontal)
        for (int y = 0; y < current_height; y++) {
            for (int x = 0; x < current_width; x++) {
                temp_row[x] = data[y * width + x];
            }

            if (filter_type == 0) {
                dwt_53_inverse_1d(temp_row, current_width);
            } else if (filter_type == 1) {
                dwt_97_inverse_1d(temp_row, current_width);
            } else if (filter_type == 2) {
                dwt_cdf137_inverse_1d(temp_row, current_width);
            } else if (filter_type == 16) {
                dwt_dd4_inverse_1d(temp_row, current_width);
            } else if (filter_type == 255) {
                dwt_haar_inverse_1d(temp_row, current_width);
            }

            for (int x = 0; x < current_width; x++) {
                data[y * width + x] = temp_row[x];
            }
        }
    }

    free(widths);
    free(heights);
    free(temp_row);
    free(temp_col);
}

//=============================================================================
// Temporal DWT Functions
//=============================================================================

// Get temporal subband level for a given frame index in a GOP
static int get_temporal_subband_level(int frame_idx, int num_frames, int temporal_levels) {
    for (int level = 0; level < temporal_levels; level++) {
        int frames_at_this_level = num_frames >> (temporal_levels - level);
        if (frame_idx < frames_at_this_level) {
            return level;
        }
    }
    return temporal_levels;
}

// Calculate temporal quantiser scale for a given temporal subband level
static float get_temporal_quantiser_scale(uint8_t encoder_preset, int temporal_level) {
    const float BETA = (encoder_preset & 0x01) ? 0.0f : 0.6f;
    const float KAPPA = (encoder_preset & 0x01) ? 1.0f : 1.14f;
    return powf(2.0f, BETA * powf(temporal_level, KAPPA));
}

// Apply inverse 3D DWT to GOP data (spatial + temporal)
static void apply_inverse_3d_dwt(float **gop_y, float **gop_co, float **gop_cg,
                                int width, int height, int gop_size,
                                int spatial_levels, int temporal_levels, int filter_type,
                                int temporal_wavelet) {
    // Step 1: Apply inverse 2D spatial DWT to each frame
    for (int t = 0; t < gop_size; t++) {
        apply_inverse_dwt_multilevel(gop_y[t], width, height, spatial_levels, filter_type);
        apply_inverse_dwt_multilevel(gop_co[t], width, height, spatial_levels, filter_type);
        apply_inverse_dwt_multilevel(gop_cg[t], width, height, spatial_levels, filter_type);
    }

    // Step 2: Apply inverse temporal DWT
    if (gop_size < 2) return;

    int *temporal_lengths = malloc((temporal_levels + 1) * sizeof(int));
    temporal_lengths[0] = gop_size;
    for (int i = 1; i <= temporal_levels; i++) {
        temporal_lengths[i] = (temporal_lengths[i - 1] + 1) / 2;
    }

    float *temporal_line = malloc(gop_size * sizeof(float));
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            const int pixel_idx = y * width + x;

            // Process Y channel
            for (int t = 0; t < gop_size; t++) {
                temporal_line[t] = gop_y[t][pixel_idx];
            }
            for (int level = temporal_levels - 1; level >= 0; level--) {
                const int level_frames = temporal_lengths[level];
                if (level_frames >= 2) {
                    if (temporal_wavelet == 0) {
                        dwt_haar_inverse_1d(temporal_line, level_frames);
                    } else {
                        dwt_53_inverse_1d(temporal_line, level_frames);
                    }
                }
            }
            for (int t = 0; t < gop_size; t++) {
                gop_y[t][pixel_idx] = temporal_line[t];
            }

            // Process Co channel
            for (int t = 0; t < gop_size; t++) {
                temporal_line[t] = gop_co[t][pixel_idx];
            }
            for (int level = temporal_levels - 1; level >= 0; level--) {
                const int level_frames = temporal_lengths[level];
                if (level_frames >= 2) {
                    if (temporal_wavelet == 0) {
                        dwt_haar_inverse_1d(temporal_line, level_frames);
                    } else {
                        dwt_53_inverse_1d(temporal_line, level_frames);
                    }
                }
            }
            for (int t = 0; t < gop_size; t++) {
                gop_co[t][pixel_idx] = temporal_line[t];
            }

            // Process Cg channel
            for (int t = 0; t < gop_size; t++) {
                temporal_line[t] = gop_cg[t][pixel_idx];
            }
            for (int level = temporal_levels - 1; level >= 0; level--) {
                const int level_frames = temporal_lengths[level];
                if (level_frames >= 2) {
                    if (temporal_wavelet == 0) {
                        dwt_haar_inverse_1d(temporal_line, level_frames);
                    } else {
                        dwt_53_inverse_1d(temporal_line, level_frames);
                    }
                }
            }
            for (int t = 0; t < gop_size; t++) {
                gop_cg[t][pixel_idx] = temporal_line[t];
            }
        }
    }

    free(temporal_line);
    free(temporal_lengths);
}

//=============================================================================
// GOP Postprocessing Functions
//=============================================================================

// Postprocess GOP unified block (2-bit map format)
static int16_t ***postprocess_gop_unified(const uint8_t *decompressed_data, size_t data_size,
                                         int gop_size, int num_pixels, int channel_layout) {
    const int map_bytes_per_frame = (num_pixels * 2 + 7) / 8;

    const int has_y = (channel_layout & 0x04) == 0;
    const int has_co = (channel_layout & 0x02) == 0;
    const int has_cg = (channel_layout & 0x02) == 0;

    int read_ptr = 0;
    const int y_maps_start = has_y ? read_ptr : -1;
    if (has_y) read_ptr += map_bytes_per_frame * gop_size;

    const int co_maps_start = has_co ? read_ptr : -1;
    if (has_co) read_ptr += map_bytes_per_frame * gop_size;

    const int cg_maps_start = has_cg ? read_ptr : -1;
    if (has_cg) read_ptr += map_bytes_per_frame * gop_size;

    // Count "other" values
    int y_other_count = 0, co_other_count = 0, cg_other_count = 0;

    for (int frame = 0; frame < gop_size; frame++) {
        const int frame_map_offset = frame * map_bytes_per_frame;
        for (int i = 0; i < num_pixels; i++) {
            const int bit_pos = i * 2;
            const int byte_idx = bit_pos / 8;
            const int bit_offset = bit_pos % 8;

            if (has_y && y_maps_start + frame_map_offset + byte_idx < (int)data_size) {
                int code = (decompressed_data[y_maps_start + frame_map_offset + byte_idx] >> bit_offset) & 0x03;
                if (bit_offset == 7 && byte_idx + 1 < map_bytes_per_frame) {
                    const int next_byte = decompressed_data[y_maps_start + frame_map_offset + byte_idx + 1] & 0xFF;
                    code = (code & 0x01) | ((next_byte & 0x01) << 1);
                }
                if (code == 3) y_other_count++;
            }
            if (has_co && co_maps_start + frame_map_offset + byte_idx < (int)data_size) {
                int code = (decompressed_data[co_maps_start + frame_map_offset + byte_idx] >> bit_offset) & 0x03;
                if (bit_offset == 7 && byte_idx + 1 < map_bytes_per_frame) {
                    const int next_byte = decompressed_data[co_maps_start + frame_map_offset + byte_idx + 1] & 0xFF;
                    code = (code & 0x01) | ((next_byte & 0x01) << 1);
                }
                if (code == 3) co_other_count++;
            }
            if (has_cg && cg_maps_start + frame_map_offset + byte_idx < (int)data_size) {
                int code = (decompressed_data[cg_maps_start + frame_map_offset + byte_idx] >> bit_offset) & 0x03;
                if (bit_offset == 7 && byte_idx + 1 < map_bytes_per_frame) {
                    const int next_byte = decompressed_data[cg_maps_start + frame_map_offset + byte_idx + 1] & 0xFF;
                    code = (code & 0x01) | ((next_byte & 0x01) << 1);
                }
                if (code == 3) cg_other_count++;
            }
        }
    }

    const int y_values_start = read_ptr;
    read_ptr += y_other_count * 2;

    const int co_values_start = read_ptr;
    read_ptr += co_other_count * 2;

    const int cg_values_start = read_ptr;

    // Allocate output arrays
    int16_t ***output = malloc(gop_size * sizeof(int16_t **));
    for (int t = 0; t < gop_size; t++) {
        output[t] = malloc(3 * sizeof(int16_t *));
        output[t][0] = calloc(num_pixels, sizeof(int16_t));
        output[t][1] = calloc(num_pixels, sizeof(int16_t));
        output[t][2] = calloc(num_pixels, sizeof(int16_t));
    }

    int y_value_idx = 0, co_value_idx = 0, cg_value_idx = 0;

    for (int frame = 0; frame < gop_size; frame++) {
        const int frame_map_offset = frame * map_bytes_per_frame;
        for (int i = 0; i < num_pixels; i++) {
            const int bit_pos = i * 2;
            const int byte_idx = bit_pos / 8;
            const int bit_offset = bit_pos % 8;

            // Decode Y
            if (has_y && y_maps_start + frame_map_offset + byte_idx < (int)data_size) {
                int code = (decompressed_data[y_maps_start + frame_map_offset + byte_idx] >> bit_offset) & 0x03;
                if (bit_offset == 7 && byte_idx + 1 < map_bytes_per_frame) {
                    const int next_byte = decompressed_data[y_maps_start + frame_map_offset + byte_idx + 1] & 0xFF;
                    code = (code & 0x01) | ((next_byte & 0x01) << 1);
                }
                if (code == 0) {
                    output[frame][0][i] = 0;
                } else if (code == 1) {
                    output[frame][0][i] = 1;
                } else if (code == 2) {
                    output[frame][0][i] = -1;
                } else {
                    const int val_offset = y_values_start + y_value_idx * 2;
                    y_value_idx++;
                    if (val_offset + 1 < (int)data_size) {
                        const int lo = decompressed_data[val_offset] & 0xFF;
                        const int hi = (int8_t)decompressed_data[val_offset + 1];
                        output[frame][0][i] = (int16_t)((hi << 8) | lo);
                    } else {
                        output[frame][0][i] = 0;
                    }
                }
            }

            // Decode Co
            if (has_co && co_maps_start + frame_map_offset + byte_idx < (int)data_size) {
                int code = (decompressed_data[co_maps_start + frame_map_offset + byte_idx] >> bit_offset) & 0x03;
                if (bit_offset == 7 && byte_idx + 1 < map_bytes_per_frame) {
                    const int next_byte = decompressed_data[co_maps_start + frame_map_offset + byte_idx + 1] & 0xFF;
                    code = (code & 0x01) | ((next_byte & 0x01) << 1);
                }
                if (code == 0) {
                    output[frame][1][i] = 0;
                } else if (code == 1) {
                    output[frame][1][i] = 1;
                } else if (code == 2) {
                    output[frame][1][i] = -1;
                } else {
                    const int val_offset = co_values_start + co_value_idx * 2;
                    co_value_idx++;
                    if (val_offset + 1 < (int)data_size) {
                        const int lo = decompressed_data[val_offset] & 0xFF;
                        const int hi = (int8_t)decompressed_data[val_offset + 1];
                        output[frame][1][i] = (int16_t)((hi << 8) | lo);
                    } else {
                        output[frame][1][i] = 0;
                    }
                }
            }

            // Decode Cg
            if (has_cg && cg_maps_start + frame_map_offset + byte_idx < (int)data_size) {
                int code = (decompressed_data[cg_maps_start + frame_map_offset + byte_idx] >> bit_offset) & 0x03;
                if (bit_offset == 7 && byte_idx + 1 < map_bytes_per_frame) {
                    const int next_byte = decompressed_data[cg_maps_start + frame_map_offset + byte_idx + 1] & 0xFF;
                    code = (code & 0x01) | ((next_byte & 0x01) << 1);
                }
                if (code == 0) {
                    output[frame][2][i] = 0;
                } else if (code == 1) {
                    output[frame][2][i] = 1;
                } else if (code == 2) {
                    output[frame][2][i] = -1;
                } else {
                    const int val_offset = cg_values_start + cg_value_idx * 2;
                    cg_value_idx++;
                    if (val_offset + 1 < (int)data_size) {
                        const int lo = decompressed_data[val_offset] & 0xFF;
                        const int hi = (int8_t)decompressed_data[val_offset + 1];
                        output[frame][2][i] = (int16_t)((hi << 8) | lo);
                    } else {
                        output[frame][2][i] = 0;
                    }
                }
            }
        }
    }

    return output;
}

// Postprocess GOP RAW format
static int16_t ***postprocess_gop_raw(const uint8_t *decompressed_data, size_t data_size,
                                     int gop_size, int num_pixels, int channel_layout) {
    const int has_y = (channel_layout & 0x04) == 0;
    const int has_co = (channel_layout & 0x02) == 0;
    const int has_cg = (channel_layout & 0x02) == 0;

    int16_t ***output = malloc(gop_size * sizeof(int16_t **));
    for (int t = 0; t < gop_size; t++) {
        output[t] = malloc(3 * sizeof(int16_t *));
        output[t][0] = calloc(num_pixels, sizeof(int16_t));
        output[t][1] = calloc(num_pixels, sizeof(int16_t));
        output[t][2] = calloc(num_pixels, sizeof(int16_t));
    }

    int offset = 0;

    if (has_y) {
        const int channel_size = gop_size * num_pixels * sizeof(int16_t);
        if (offset + channel_size > (int)data_size) {
            goto error_cleanup;
        }
        const int16_t *y_data = (const int16_t *)(decompressed_data + offset);
        for (int t = 0; t < gop_size; t++) {
            memcpy(output[t][0], y_data + t * num_pixels, num_pixels * sizeof(int16_t));
        }
        offset += channel_size;
    }

    if (has_co) {
        const int channel_size = gop_size * num_pixels * sizeof(int16_t);
        if (offset + channel_size > (int)data_size) {
            goto error_cleanup;
        }
        const int16_t *co_data = (const int16_t *)(decompressed_data + offset);
        for (int t = 0; t < gop_size; t++) {
            memcpy(output[t][1], co_data + t * num_pixels, num_pixels * sizeof(int16_t));
        }
        offset += channel_size;
    }

    if (has_cg) {
        const int channel_size = gop_size * num_pixels * sizeof(int16_t);
        if (offset + channel_size > (int)data_size) {
            goto error_cleanup;
        }
        const int16_t *cg_data = (const int16_t *)(decompressed_data + offset);
        for (int t = 0; t < gop_size; t++) {
            memcpy(output[t][2], cg_data + t * num_pixels, num_pixels * sizeof(int16_t));
        }
        offset += channel_size;
    }

    return output;

error_cleanup:
    for (int t = 0; t < gop_size; t++) {
        free(output[t][0]);
        free(output[t][1]);
        free(output[t][2]);
        free(output[t]);
    }
    free(output);
    return NULL;
}

// Postprocess GOP EZBC format
static int16_t ***postprocess_gop_ezbc(const uint8_t *decompressed_data, size_t data_size,
                                      int gop_size, int num_pixels, int channel_layout,
                                      int *out_width, int *out_height) {
    int actual_width = 0, actual_height = 0;
    int actual_pixels = num_pixels;

    if (data_size >= 8) {
        const uint32_t first_frame_size = ((uint32_t)decompressed_data[0]) |
                                         ((uint32_t)decompressed_data[1] << 8) |
                                         ((uint32_t)decompressed_data[2] << 16) |
                                         ((uint32_t)decompressed_data[3] << 24);

        if (4 + first_frame_size <= data_size) {
            if (ezbc_peek_dimensions(decompressed_data + 4, channel_layout,
                                     &actual_width, &actual_height) == 0) {
                actual_pixels = actual_width * actual_height;
            }
        }
    }

    if (actual_width == 0 || actual_height == 0) {
        actual_width = (int)sqrt(num_pixels);
        actual_height = num_pixels / actual_width;
        actual_pixels = actual_width * actual_height;
    }

    if (out_width) *out_width = actual_width;
    if (out_height) *out_height = actual_height;

    int16_t ***output = malloc(gop_size * sizeof(int16_t **));
    for (int t = 0; t < gop_size; t++) {
        output[t] = malloc(3 * sizeof(int16_t *));
        output[t][0] = calloc(actual_pixels, sizeof(int16_t));
        output[t][1] = calloc(actual_pixels, sizeof(int16_t));
        output[t][2] = calloc(actual_pixels, sizeof(int16_t));
    }

    int offset = 0;

    for (int t = 0; t < gop_size; t++) {
        if (offset + 4 > (int)data_size) {
            goto error_cleanup;
        }

        const uint32_t frame_size = ((uint32_t)decompressed_data[offset + 0]) |
                                   ((uint32_t)decompressed_data[offset + 1] << 8) |
                                   ((uint32_t)decompressed_data[offset + 2] << 16) |
                                   ((uint32_t)decompressed_data[offset + 3] << 24);
        offset += 4;

        if (offset + frame_size > data_size) {
            goto error_cleanup;
        }

        postprocess_coefficients_ezbc(
            (uint8_t *)(decompressed_data + offset), actual_pixels,
            output[t][0], output[t][1], output[t][2],
            channel_layout);

        offset += frame_size;
    }

    return output;

error_cleanup:
    for (int t = 0; t < gop_size; t++) {
        free(output[t][0]);
        free(output[t][1]);
        free(output[t][2]);
        free(output[t]);
    }
    free(output);
    return NULL;
}

//=============================================================================
// Color Conversion
//=============================================================================

static void ycocgr_to_rgb(float y, float co, float cg, uint8_t *r, uint8_t *g, uint8_t *b) {
    float tmp = y - cg / 2.0f;
    float g_val = cg + tmp;
    float b_val = tmp - co / 2.0f;
    float r_val = co + b_val;

    *r = CLAMP(roundf(r_val), 0, 255);
    *g = CLAMP(roundf(g_val), 0, 255);
    *b = CLAMP(roundf(b_val), 0, 255);
}

static void ictcp_to_rgb(float i, float ct, float cp, uint8_t *r, uint8_t *g, uint8_t *b) {
    float l = i + 0.008609f * ct;
    float m = i - 0.008609f * ct;
    float s = i + 0.560031f * cp;

    l = powf(fmaxf(l, 0.0f), 1.0f / 0.1593f);
    m = powf(fmaxf(m, 0.0f), 1.0f / 0.1593f);
    s = powf(fmaxf(s, 0.0f), 1.0f / 0.1593f);

    float r_val = 5.432622f * l - 4.679910f * m + 0.247288f * s;
    float g_val = -1.106160f * l + 2.311198f * m - 0.205038f * s;
    float b_val = 0.028262f * l - 0.195689f * m + 1.167427f * s;

    *r = CLAMP((int)(r_val * 255.0f + 0.5f), 0, 255);
    *g = CLAMP((int)(g_val * 255.0f + 0.5f), 0, 255);
    *b = CLAMP((int)(b_val * 255.0f + 0.5f), 0, 255);
}

//=============================================================================
// Public API Implementation
//=============================================================================

tav_video_context_t *tav_video_create(const tav_video_params_t *params) {
    if (!params) return NULL;

    tav_video_context_t *ctx = calloc(1, sizeof(tav_video_context_t));
    if (!ctx) return NULL;

    ctx->params = *params;
    ctx->verbose = 0;

    const int buffer_size = params->width * params->height;

    // Allocate working buffers
    ctx->dwt_buffer_y = calloc(buffer_size, sizeof(float));
    ctx->dwt_buffer_co = calloc(buffer_size, sizeof(float));
    ctx->dwt_buffer_cg = calloc(buffer_size, sizeof(float));
    ctx->reference_ycocg_y = calloc(buffer_size, sizeof(float));
    ctx->reference_ycocg_co = calloc(buffer_size, sizeof(float));
    ctx->reference_ycocg_cg = calloc(buffer_size, sizeof(float));

    if (!ctx->dwt_buffer_y || !ctx->dwt_buffer_co || !ctx->dwt_buffer_cg ||
        !ctx->reference_ycocg_y || !ctx->reference_ycocg_co || !ctx->reference_ycocg_cg) {
        tav_video_free(ctx);
        return NULL;
    }

    snprintf(ctx->error_msg, sizeof(ctx->error_msg), "No error");
    return ctx;
}

void tav_video_free(tav_video_context_t *ctx) {
    if (!ctx) return;

    free(ctx->dwt_buffer_y);
    free(ctx->dwt_buffer_co);
    free(ctx->dwt_buffer_cg);
    free(ctx->reference_ycocg_y);
    free(ctx->reference_ycocg_co);
    free(ctx->reference_ycocg_cg);
    free(ctx);
}

int tav_video_decode_gop(tav_video_context_t *ctx,
                         const uint8_t *compressed_data, uint32_t compressed_size,
                         uint8_t gop_size, uint8_t **rgb_frames) {
    if (!ctx || !compressed_data || !rgb_frames) {
        if (ctx) snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Invalid parameters");
        return -1;
    }

    const int width = ctx->params.width;
    const int height = ctx->params.height;
    const int num_pixels = width * height;

    // Decompress with Zstd
    const size_t decompressed_bound = ZSTD_getFrameContentSize(compressed_data, compressed_size);
    if (ZSTD_isError(decompressed_bound)) {
        snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Zstd decompression failed");
        return -1;
    }

    uint8_t *decompressed_data = malloc(decompressed_bound);
    if (!decompressed_data) {
        snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Memory allocation failed");
        return -1;
    }

    const size_t decompressed_size = ZSTD_decompress(decompressed_data, decompressed_bound,
                                                      compressed_data, compressed_size);
    if (ZSTD_isError(decompressed_size)) {
        free(decompressed_data);
        snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Zstd decompression failed");
        return -1;
    }

    // Postprocess GOP data based on entropy coder type
    int16_t ***gop_coeffs = NULL;
    int actual_width = width;
    int actual_height = height;

    if (ctx->params.entropy_coder == 0) {
        gop_coeffs = postprocess_gop_unified(decompressed_data, decompressed_size, gop_size, num_pixels, ctx->params.channel_layout);
    } else if (ctx->params.entropy_coder == 1) {
        gop_coeffs = postprocess_gop_ezbc(decompressed_data, decompressed_size, gop_size, num_pixels, ctx->params.channel_layout, &actual_width, &actual_height);
    } else if (ctx->params.entropy_coder == 2) {
        gop_coeffs = postprocess_gop_raw(decompressed_data, decompressed_size, gop_size, num_pixels, ctx->params.channel_layout);
    }

    free(decompressed_data);

    if (!gop_coeffs) {
        snprintf(ctx->error_msg, sizeof(ctx->error_msg), "GOP postprocessing failed");
        return -1;
    }

    // Use actual dimensions from EZBC data (may differ from params for interlaced content)
    int final_width = width;
    int final_height = height;
    int final_num_pixels = num_pixels;

    if (actual_width != 0 && actual_height != 0) {
        if (actual_width != width || actual_height != height) {
            if (ctx->verbose) {
                fprintf(stderr, "Warning: EZBC dimensions (%dx%d) differ from params (%dx%d), using EZBC dimensions\n",
                        actual_width, actual_height, width, height);
            }
        }
        final_width = actual_width;
        final_height = actual_height;
        final_num_pixels = actual_width * actual_height;
    }

    // Allocate GOP float buffers for 3D DWT using actual dimensions
    float **gop_y = malloc(gop_size * sizeof(float *));
    float **gop_co = malloc(gop_size * sizeof(float *));
    float **gop_cg = malloc(gop_size * sizeof(float *));

    for (int t = 0; t < gop_size; t++) {
        gop_y[t] = calloc(final_num_pixels, sizeof(float));
        gop_co[t] = calloc(final_num_pixels, sizeof(float));
        gop_cg[t] = calloc(final_num_pixels, sizeof(float));
    }

    // Dequantise each frame
    for (int t = 0; t < gop_size; t++) {
        const int temporal_level = get_temporal_subband_level(t, gop_size, ctx->params.temporal_levels);
        const float temporal_scale = get_temporal_quantiser_scale(ctx->params.encoder_preset, temporal_level);

        const float base_q_y =  roundf(QLUT[ctx->params.quantiser_y] * temporal_scale);
        const float base_q_co = roundf(QLUT[ctx->params.quantiser_co] * temporal_scale);
        const float base_q_cg = roundf(QLUT[ctx->params.quantiser_cg] * temporal_scale);

        if (ctx->params.perceptual_tuning) {
            dequantise_dwt_subbands_perceptual(0, QLUT[ctx->params.quantiser_y],
                                              gop_coeffs[t][0], gop_y[t], final_width, final_height,
                                              ctx->params.decomp_levels, base_q_y, 0);
            dequantise_dwt_subbands_perceptual(0, QLUT[ctx->params.quantiser_y],
                                              gop_coeffs[t][1], gop_co[t], final_width, final_height,
                                              ctx->params.decomp_levels, base_q_co, 1);
            dequantise_dwt_subbands_perceptual(0, QLUT[ctx->params.quantiser_y],
                                              gop_coeffs[t][2], gop_cg[t], final_width, final_height,
                                              ctx->params.decomp_levels, base_q_cg, 1);
        } else {
            // Uniform dequantisation
            for (int i = 0; i < final_num_pixels; i++) {
                gop_y[t][i] = gop_coeffs[t][0][i] * base_q_y;
                gop_co[t][i] = gop_coeffs[t][1][i] * base_q_co;
                gop_cg[t][i] = gop_coeffs[t][2][i] * base_q_cg;
            }
        }

        // Apply grain synthesis to Y channel ONLY (using ORIGINAL dimensions - grain must match encoder's frame size)
        // Note: Grain synthesis is NOT applied to chroma channels
        apply_grain_synthesis(gop_y[t], width, height, ctx->params.decomp_levels, t,
                            QLUT[ctx->params.quantiser_y], ctx->params.encoder_preset);
    }

    // Free quantised coefficients
    for (int t = 0; t < gop_size; t++) {
        free(gop_coeffs[t][0]);
        free(gop_coeffs[t][1]);
        free(gop_coeffs[t][2]);
        free(gop_coeffs[t]);
    }
    free(gop_coeffs);

    // Apply inverse 3D DWT
    apply_inverse_3d_dwt(gop_y, gop_co, gop_cg, final_width, final_height, gop_size,
                        ctx->params.decomp_levels, ctx->params.temporal_levels,
                        ctx->params.wavelet_filter, ctx->params.temporal_wavelet);

    // Convert to RGB and write to output frames
    for (int t = 0; t < gop_size; t++) {
        for (int y = 0; y < final_height; y++) {
            for (int x = 0; x < final_width; x++) {
                const int idx = y * final_width + x;
                const int rgb_idx = (y * final_width + x) * 3;

                if (ctx->params.channel_layout == 0) {
                    ycocgr_to_rgb(gop_y[t][idx], gop_co[t][idx], gop_cg[t][idx],
                                 &rgb_frames[t][rgb_idx], &rgb_frames[t][rgb_idx + 1], &rgb_frames[t][rgb_idx + 2]);
                } else {
                    ictcp_to_rgb(gop_y[t][idx], gop_co[t][idx], gop_cg[t][idx],
                                &rgb_frames[t][rgb_idx], &rgb_frames[t][rgb_idx + 1], &rgb_frames[t][rgb_idx + 2]);
                }
            }
        }
    }

    // Free GOP buffers
    for (int t = 0; t < gop_size; t++) {
        free(gop_y[t]);
        free(gop_co[t]);
        free(gop_cg[t]);
    }
    free(gop_y);
    free(gop_co);
    free(gop_cg);

    return 0;
}

int tav_video_decode_iframe(tav_video_context_t *ctx,
                            const uint8_t *compressed_data, uint32_t packet_size,
                            uint8_t *rgb_frame) {
    if (!ctx || !compressed_data || !rgb_frame) {
        if (ctx) snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Invalid parameters");
        return -1;
    }

    const int width = ctx->params.width;
    const int height = ctx->params.height;
    const int num_pixels = width * height;

    // Decompress
    const size_t decompressed_bound = ZSTD_getFrameContentSize(compressed_data, packet_size);
    if (ZSTD_isError(decompressed_bound)) {
        snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Zstd decompression failed");
        return -1;
    }

    uint8_t *decompressed_data = malloc(decompressed_bound);
    const size_t decompressed_size = ZSTD_decompress(decompressed_data, decompressed_bound,
                                                      compressed_data, packet_size);
    if (ZSTD_isError(decompressed_size)) {
        free(decompressed_data);
        snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Zstd decompression failed");
        return -1;
    }

    // Allocate coefficient buffers
    int16_t *coeffs_y = calloc(num_pixels, sizeof(int16_t));
    int16_t *coeffs_co = calloc(num_pixels, sizeof(int16_t));
    int16_t *coeffs_cg = calloc(num_pixels, sizeof(int16_t));

    // Postprocess based on entropy coder
    if (ctx->params.entropy_coder == 0) {
        postprocess_coefficients_twobit(decompressed_data, num_pixels, coeffs_y, coeffs_co, coeffs_cg);
    } else if (ctx->params.entropy_coder == 1) {
        postprocess_coefficients_ezbc(decompressed_data, num_pixels, coeffs_y, coeffs_co, coeffs_cg, ctx->params.channel_layout);
    }

    free(decompressed_data);

    // Dequantise
    const float base_q_y = QLUT[ctx->params.quantiser_y];
    const float base_q_co = QLUT[ctx->params.quantiser_co];
    const float base_q_cg = QLUT[ctx->params.quantiser_cg];

    if (ctx->params.perceptual_tuning) {
        dequantise_dwt_subbands_perceptual(0, QLUT[ctx->params.quantiser_y],
                                          coeffs_y, ctx->dwt_buffer_y, width, height,
                                          ctx->params.decomp_levels, base_q_y, 0);
        dequantise_dwt_subbands_perceptual(0, QLUT[ctx->params.quantiser_y],
                                          coeffs_co, ctx->dwt_buffer_co, width, height,
                                          ctx->params.decomp_levels, base_q_co, 1);
        dequantise_dwt_subbands_perceptual(0, QLUT[ctx->params.quantiser_y],
                                          coeffs_cg, ctx->dwt_buffer_cg, width, height,
                                          ctx->params.decomp_levels, base_q_cg, 1);
    } else {
        for (int i = 0; i < num_pixels; i++) {
            ctx->dwt_buffer_y[i] = coeffs_y[i] * base_q_y;
            ctx->dwt_buffer_co[i] = coeffs_co[i] * base_q_co;
            ctx->dwt_buffer_cg[i] = coeffs_cg[i] * base_q_cg;
        }
    }

    free(coeffs_y);
    free(coeffs_co);
    free(coeffs_cg);

    // Apply grain synthesis to Y channel only (not applied to chroma)
    apply_grain_synthesis(ctx->dwt_buffer_y, width, height, ctx->params.decomp_levels, 0,
                        QLUT[ctx->params.quantiser_y], ctx->params.encoder_preset);

    // Apply inverse DWT
    apply_inverse_dwt_multilevel(ctx->dwt_buffer_y, width, height, ctx->params.decomp_levels, ctx->params.wavelet_filter);
    apply_inverse_dwt_multilevel(ctx->dwt_buffer_co, width, height, ctx->params.decomp_levels, ctx->params.wavelet_filter);
    apply_inverse_dwt_multilevel(ctx->dwt_buffer_cg, width, height, ctx->params.decomp_levels, ctx->params.wavelet_filter);

    // Store as reference for P-frames
    memcpy(ctx->reference_ycocg_y, ctx->dwt_buffer_y, num_pixels * sizeof(float));
    memcpy(ctx->reference_ycocg_co, ctx->dwt_buffer_co, num_pixels * sizeof(float));
    memcpy(ctx->reference_ycocg_cg, ctx->dwt_buffer_cg, num_pixels * sizeof(float));

    // Convert to RGB
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            const int idx = y * width + x;
            const int rgb_idx = (y * width + x) * 3;

            if (ctx->params.channel_layout == 0) {
                ycocgr_to_rgb(ctx->dwt_buffer_y[idx], ctx->dwt_buffer_co[idx], ctx->dwt_buffer_cg[idx],
                             &rgb_frame[rgb_idx], &rgb_frame[rgb_idx + 1], &rgb_frame[rgb_idx + 2]);
            } else {
                ictcp_to_rgb(ctx->dwt_buffer_y[idx], ctx->dwt_buffer_co[idx], ctx->dwt_buffer_cg[idx],
                            &rgb_frame[rgb_idx], &rgb_frame[rgb_idx + 1], &rgb_frame[rgb_idx + 2]);
            }
        }
    }

    return 0;
}

int tav_video_decode_pframe(tav_video_context_t *ctx,
                            const uint8_t *compressed_data, uint32_t packet_size,
                            uint8_t *rgb_frame) {
    if (!ctx || !compressed_data || !rgb_frame) {
        if (ctx) snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Invalid parameters");
        return -1;
    }

    const int width = ctx->params.width;
    const int height = ctx->params.height;
    const int num_pixels = width * height;

    // Decompress
    const size_t decompressed_bound = ZSTD_getFrameContentSize(compressed_data, packet_size);
    if (ZSTD_isError(decompressed_bound)) {
        snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Zstd decompression failed");
        return -1;
    }

    uint8_t *decompressed_data = malloc(decompressed_bound);
    const size_t decompressed_size = ZSTD_decompress(decompressed_data, decompressed_bound,
                                                      compressed_data, packet_size);
    if (ZSTD_isError(decompressed_size)) {
        free(decompressed_data);
        snprintf(ctx->error_msg, sizeof(ctx->error_msg), "Zstd decompression failed");
        return -1;
    }

    // Allocate coefficient buffers
    int16_t *coeffs_y = calloc(num_pixels, sizeof(int16_t));
    int16_t *coeffs_co = calloc(num_pixels, sizeof(int16_t));
    int16_t *coeffs_cg = calloc(num_pixels, sizeof(int16_t));

    // Postprocess
    if (ctx->params.entropy_coder == 0) {
        postprocess_coefficients_twobit(decompressed_data, num_pixels, coeffs_y, coeffs_co, coeffs_cg);
    } else if (ctx->params.entropy_coder == 1) {
        postprocess_coefficients_ezbc(decompressed_data, num_pixels, coeffs_y, coeffs_co, coeffs_cg, ctx->params.channel_layout);
    }

    free(decompressed_data);

    // Dequantise
    const float base_q_y = QLUT[ctx->params.quantiser_y];
    const float base_q_co = QLUT[ctx->params.quantiser_co];
    const float base_q_cg = QLUT[ctx->params.quantiser_cg];

    if (ctx->params.perceptual_tuning) {
        dequantise_dwt_subbands_perceptual(0, QLUT[ctx->params.quantiser_y],
                                          coeffs_y, ctx->dwt_buffer_y, width, height,
                                          ctx->params.decomp_levels, base_q_y, 0);
        dequantise_dwt_subbands_perceptual(0, QLUT[ctx->params.quantiser_y],
                                          coeffs_co, ctx->dwt_buffer_co, width, height,
                                          ctx->params.decomp_levels, base_q_co, 1);
        dequantise_dwt_subbands_perceptual(0, QLUT[ctx->params.quantiser_y],
                                          coeffs_cg, ctx->dwt_buffer_cg, width, height,
                                          ctx->params.decomp_levels, base_q_cg, 1);
    } else {
        for (int i = 0; i < num_pixels; i++) {
            ctx->dwt_buffer_y[i] = coeffs_y[i] * base_q_y;
            ctx->dwt_buffer_co[i] = coeffs_co[i] * base_q_co;
            ctx->dwt_buffer_cg[i] = coeffs_cg[i] * base_q_cg;
        }
    }

    free(coeffs_y);
    free(coeffs_co);
    free(coeffs_cg);

    // Apply grain synthesis to Y channel only (not applied to chroma)
    apply_grain_synthesis(ctx->dwt_buffer_y, width, height, ctx->params.decomp_levels, 0,
                        QLUT[ctx->params.quantiser_y], ctx->params.encoder_preset);

    // Apply inverse DWT
    apply_inverse_dwt_multilevel(ctx->dwt_buffer_y, width, height, ctx->params.decomp_levels, ctx->params.wavelet_filter);
    apply_inverse_dwt_multilevel(ctx->dwt_buffer_co, width, height, ctx->params.decomp_levels, ctx->params.wavelet_filter);
    apply_inverse_dwt_multilevel(ctx->dwt_buffer_cg, width, height, ctx->params.decomp_levels, ctx->params.wavelet_filter);

    // Add to reference frame (delta mode)
    for (int i = 0; i < num_pixels; i++) {
        ctx->dwt_buffer_y[i] += ctx->reference_ycocg_y[i];
        ctx->dwt_buffer_co[i] += ctx->reference_ycocg_co[i];
        ctx->dwt_buffer_cg[i] += ctx->reference_ycocg_cg[i];
    }

    // Store as new reference
    memcpy(ctx->reference_ycocg_y, ctx->dwt_buffer_y, num_pixels * sizeof(float));
    memcpy(ctx->reference_ycocg_co, ctx->dwt_buffer_co, num_pixels * sizeof(float));
    memcpy(ctx->reference_ycocg_cg, ctx->dwt_buffer_cg, num_pixels * sizeof(float));

    // Convert to RGB
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            const int idx = y * width + x;
            const int rgb_idx = (y * width + x) * 3;

            if (ctx->params.channel_layout == 0) {
                ycocgr_to_rgb(ctx->dwt_buffer_y[idx], ctx->dwt_buffer_co[idx], ctx->dwt_buffer_cg[idx],
                             &rgb_frame[rgb_idx], &rgb_frame[rgb_idx + 1], &rgb_frame[rgb_idx + 2]);
            } else {
                ictcp_to_rgb(ctx->dwt_buffer_y[idx], ctx->dwt_buffer_co[idx], ctx->dwt_buffer_cg[idx],
                            &rgb_frame[rgb_idx], &rgb_frame[rgb_idx + 1], &rgb_frame[rgb_idx + 2]);
            }
        }
    }

    return 0;
}

const char *tav_video_get_error(tav_video_context_t *ctx) {
    if (!ctx) return "Invalid context";
    return ctx->error_msg;
}

void tav_video_set_verbose(tav_video_context_t *ctx, int verbose) {
    if (ctx) ctx->verbose = verbose;
}
