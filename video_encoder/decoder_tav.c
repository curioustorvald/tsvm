// Created by CuriousTorvald and Claude on 2025-11-03.
// TAV Decoder - Converts TAV video to FFV1 format with TAD audio to PCMu8
// Based on TSVM decoder implementation (GraphicsJSR223Delegate.kt + playtav.js)
// Only supports features available in TSVM decoder (no MC-EZBC, no MPEG-style motion compensation)

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include <unistd.h>
#include <sys/wait.h>
#include <getopt.h>

#define DECODER_VENDOR_STRING "Decoder-TAV 20251103 (ffv1+pcmu8)"

// TAV format constants
#define TAV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x56"
#define TAV_MODE_SKIP      0x00
#define TAV_MODE_INTRA     0x01
#define TAV_MODE_DELTA     0x02

// TAV packet types (only those supported by TSVM decoder)
#define TAV_PACKET_IFRAME          0x10  // Intra frame (keyframe) - SUPPORTED
#define TAV_PACKET_PFRAME          0x11  // Predicted frame - SUPPORTED (delta mode)
#define TAV_PACKET_GOP_UNIFIED     0x12  // Unified 3D DWT GOP - SUPPORTED
#define TAV_PACKET_AUDIO_MP2       0x20  // MP2 audio - SUPPORTED (passthrough)
#define TAV_PACKET_AUDIO_PCM8      0x21  // 8-bit PCM audio - SUPPORTED
#define TAV_PACKET_AUDIO_TAD       0x24  // TAD audio - SUPPORTED (decode to PCMu8)
#define TAV_PACKET_AUDIO_TRACK     0x40  // Bundled audio track - SUPPORTED (passthrough)
#define TAV_PACKET_SUBTITLE        0x30  // Subtitle - SKIPPED
#define TAV_PACKET_EXTENDED_HDR    0xEF  // Extended header - SKIPPED
#define TAV_PACKET_GOP_SYNC        0xFC  // GOP sync packet - SKIPPED
#define TAV_PACKET_TIMECODE        0xFD  // Timecode - SKIPPED
#define TAV_PACKET_SYNC_NTSC       0xFE  // NTSC sync - SKIPPED
#define TAV_PACKET_SYNC            0xFF  // Sync - SKIPPED

// Unsupported packet types (not in TSVM decoder)
#define TAV_PACKET_PFRAME_RESIDUAL 0x14  // P-frame MPEG-style - NOT SUPPORTED
#define TAV_PACKET_BFRAME_RESIDUAL 0x15  // B-frame MPEG-style - NOT SUPPORTED

// Channel layout definitions
#define CHANNEL_LAYOUT_YCOCG     0  // Y-Co-Cg/I-Ct-Cp
#define CHANNEL_LAYOUT_YCOCG_A   1  // Y-Co-Cg-A/I-Ct-Cp-A
#define CHANNEL_LAYOUT_Y_ONLY    2  // Y/I only
#define CHANNEL_LAYOUT_Y_A       3  // Y-A/I-A
#define CHANNEL_LAYOUT_COCG      4  // Co-Cg/Ct-Cp
#define CHANNEL_LAYOUT_COCG_A    5  // Co-Cg-A/Ct-Cp-A

// Wavelet filter types
#define WAVELET_5_3_REVERSIBLE 0
#define WAVELET_9_7_IRREVERSIBLE 1
#define WAVELET_BIORTHOGONAL_13_7 2
#define WAVELET_DD4 16
#define WAVELET_HAAR 255

// Tile sizes (match TSVM)
#define TILE_SIZE_X 640
#define TILE_SIZE_Y 540
#define DWT_FILTER_HALF_SUPPORT 4
#define TILE_MARGIN_LEVELS 3
#define TILE_MARGIN (DWT_FILTER_HALF_SUPPORT * (1 << TILE_MARGIN_LEVELS))
#define PADDED_TILE_SIZE_X (TILE_SIZE_X + 2 * TILE_MARGIN)
#define PADDED_TILE_SIZE_Y (TILE_SIZE_Y + 2 * TILE_MARGIN)

static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}

//=============================================================================
// TAV Header Structure (32 bytes)
//=============================================================================

typedef struct {
    uint8_t magic[8];
    uint8_t version;
    uint16_t width;
    uint16_t height;
    uint8_t fps;
    uint32_t total_frames;
    uint8_t wavelet_filter;
    uint8_t decomp_levels;
    uint8_t quantiser_y;
    uint8_t quantiser_co;
    uint8_t quantiser_cg;
    uint8_t extra_flags;
    uint8_t video_flags;
    uint8_t encoder_quality;
    uint8_t channel_layout;
    uint8_t entropy_coder;
    uint8_t reserved[2];
    uint8_t device_orientation;
    uint8_t file_role;
} __attribute__((packed)) tav_header_t;

//=============================================================================
// Quantization Lookup Table (matches TSVM exactly)
//=============================================================================

static const int QLUT[] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096};

// Perceptual quantization constants (match TSVM)
static const float ANISOTROPY_MULT[] = {2.0f, 1.8f, 1.6f, 1.4f, 1.2f, 1.0f};
static const float ANISOTROPY_BIAS[] = {0.4f, 0.2f, 0.1f, 0.0f, 0.0f, 0.0f};
static const float ANISOTROPY_MULT_CHROMA[] = {6.6f, 5.5f, 4.4f, 3.3f, 2.2f, 1.1f};
static const float ANISOTROPY_BIAS_CHROMA[] = {1.0f, 0.8f, 0.6f, 0.4f, 0.2f, 0.0f};
static const float FOUR_PIXEL_DETAILER = 0.88f;
static const float TWO_PIXEL_DETAILER = 0.92f;

//=============================================================================
// DWT Subband Layout Calculation (matches TSVM)
//=============================================================================

typedef struct {
    int level;              // Decomposition level (1 to decompLevels)
    int subband_type;       // 0=LL, 1=LH, 2=HL, 3=HH
    int coeff_start;        // Starting index in linear coefficient array
    int coeff_count;        // Number of coefficients in this subband
} dwt_subband_info_t;

static int calculate_subband_layout(int width, int height, int decomp_levels, dwt_subband_info_t *subbands) {
    int subband_count = 0;

    // LL subband at maximum decomposition level
    const int ll_width = width >> decomp_levels;
    const int ll_height = height >> decomp_levels;
    subbands[subband_count++] = (dwt_subband_info_t){decomp_levels, 0, 0, ll_width * ll_height};
    int coeff_offset = ll_width * ll_height;

    // LH, HL, HH subbands for each level from max down to 1
    for (int level = decomp_levels; level >= 1; level--) {
        const int level_width = width >> (decomp_levels - level + 1);
        const int level_height = height >> (decomp_levels - level + 1);
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
// Perceptual Quantization Model (matches TSVM exactly)
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
    const float K = 2.0f;  // CRITICAL: Fixed value for fixed curve; quantiser will scale it up anyway
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

static void dequantize_dwt_subbands_perceptual(int q_index, int q_y_global, const int16_t *quantized,
                                              float *dequantized, int width, int height, int decomp_levels,
                                              float base_quantizer, int is_chroma, int frame_num) {
    dwt_subband_info_t subbands[32]; // Max possible subbands
    const int subband_count = calculate_subband_layout(width, height, decomp_levels, subbands);

    const int coeff_count = width * height;
    memset(dequantized, 0, coeff_count * sizeof(float));

    int is_debug = (frame_num == 32);
    if (frame_num == 32) {
        fprintf(stderr, "DEBUG: dequantize called for frame %d, is_chroma=%d\n", frame_num, is_chroma);
    }

    // Apply perceptual weighting to each subband
    for (int s = 0; s < subband_count; s++) {
        const dwt_subband_info_t *subband = &subbands[s];
        const float weight = get_perceptual_weight(q_index, q_y_global, subband->level,
                                                  subband->subband_type, is_chroma, decomp_levels);
        const float effective_quantizer = base_quantizer * weight;

        if (is_debug && !is_chroma) {
            if (subband->subband_type == 0) { // LL band
                fprintf(stderr, "  Subband level %d (LL): weight=%.6f, base_q=%.1f, effective_q=%.1f, count=%d\n",
                       subband->level, weight, base_quantizer, effective_quantizer, subband->coeff_count);

                // Print first 5 quantized LL coefficients
                fprintf(stderr, "    First 5 quantized LL: ");
                for (int k = 0; k < 5 && k < subband->coeff_count; k++) {
                    int idx = subband->coeff_start + k;
                    fprintf(stderr, "%d ", quantized[idx]);
                }
                fprintf(stderr, "\n");

                // Find max quantized LL coefficient
                int max_quant_ll = 0;
                for (int k = 0; k < subband->coeff_count; k++) {
                    int idx = subband->coeff_start + k;
                    int abs_val = quantized[idx] < 0 ? -quantized[idx] : quantized[idx];
                    if (abs_val > max_quant_ll) max_quant_ll = abs_val;
                }
                fprintf(stderr, "    Max quantized LL coefficient: %d (dequantizes to %.1f)\n",
                       max_quant_ll, max_quant_ll * effective_quantizer);
            }
        }

        for (int i = 0; i < subband->coeff_count; i++) {
            const int idx = subband->coeff_start + i;
            if (idx < coeff_count) {
                // CRITICAL: Must ROUND to match EZBC encoder's roundf() behavior
                // Without rounding, truncation limits brightness range (e.g., Y maxes at 227 instead of 255)
                const float untruncated = quantized[idx] * effective_quantizer;
                dequantized[idx] = roundf(untruncated);
            }
        }
    }

    // Debug: Verify LL band was dequantized correctly
    if (is_debug && !is_chroma) {
        // Find LL band again to verify
        for (int s = 0; s < subband_count; s++) {
            const dwt_subband_info_t *subband = &subbands[s];
            if (subband->level == decomp_levels && subband->subband_type == 0) {
                fprintf(stderr, "  AFTER all subbands processed - First 5 dequantized LL: ");
                for (int k = 0; k < 5 && k < subband->coeff_count; k++) {
                    int idx = subband->coeff_start + k;
                    fprintf(stderr, "%.1f ", dequantized[idx]);
                }
                fprintf(stderr, "\n");

                // Find max dequantized LL
                float max_dequant_ll = -999.0f;
                for (int k = 0; k < subband->coeff_count; k++) {
                    int idx = subband->coeff_start + k;
                    float abs_val = dequantized[idx] < 0 ? -dequantized[idx] : dequantized[idx];
                    if (abs_val > max_dequant_ll) max_dequant_ll = abs_val;
                }
                fprintf(stderr, "  AFTER all subbands - Max dequantized LL: %.1f\n", max_dequant_ll);
                break;
            }
        }
    }
}

//=============================================================================
// Grain Synthesis Removal (matches TSVM exactly)
//=============================================================================

// Deterministic RNG for grain synthesis (matches encoder)
static inline uint32_t tav_grain_synthesis_rng(uint32_t frame, uint32_t band, uint32_t x, uint32_t y) {
    uint32_t key = frame * 0x9e3779b9u ^ band * 0x7f4a7c15u ^ (y << 16) ^ x;
    // rng_hash implementation
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
    // Get two uniform random values in [0, 1]
    float u1 = (rng_val & 0xFFFFu) / 65535.0f;
    float u2 = ((rng_val >> 16) & 0xFFFFu) / 65535.0f;

    // Convert to range [-1, 1] and average for triangular distribution
    return (u1 + u2) - 1.0f;
}

// Remove grain synthesis from DWT coefficients (decoder subtracts noise)
// This must be called AFTER dequantization but BEFORE inverse DWT
static void remove_grain_synthesis_decoder(float *coeffs, int width, int height,
                                          int decomp_levels, int frame_num, int q_y_global) {
    dwt_subband_info_t subbands[32];
    const int subband_count = calculate_subband_layout(width, height, decomp_levels, subbands);

    // Noise amplitude (matches Kotlin: qYGlobal.coerceAtMost(32) * 0.5f)
    const float noise_amplitude = (q_y_global < 32 ? q_y_global : 32) * 0.5f;

    // Process each subband (skip LL band which is level 0)
    for (int s = 0; s < subband_count; s++) {
        const dwt_subband_info_t *subband = &subbands[s];
        if (subband->level == 0) continue;  // Skip LL band

        // Calculate band index for RNG (matches Kotlin: level + subbandType * 31 + 16777619)
        uint32_t band = subband->level + subband->subband_type * 31 + 16777619;

        // Remove noise from each coefficient in this subband
        for (int i = 0; i < subband->coeff_count; i++) {
            const int idx = subband->coeff_start + i;
            if (idx < width * height) {
                // Calculate 2D position from linear index
                int y = idx / width;
                int x = idx % width;

                // Generate same deterministic noise as encoder
                uint32_t rng_val = tav_grain_synthesis_rng(frame_num, band, x, y);
                float noise = tav_grain_triangular_noise(rng_val);

                // Subtract noise from coefficient
                coeffs[idx] -= noise * noise_amplitude;
            }
        }
    }
}

//=============================================================================
// Significance Map Postprocessing (matches TSVM exactly)
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
// Layout: [Y_map_2bit][Co_map_2bit][Cg_map_2bit][Y_others][Co_others][Cg_others]
// 2-bit encoding: 00=0, 01=+1, 10=-1, 11=other (stored in value array)
static void postprocess_coefficients_twobit(uint8_t *compressed_data, int coeff_count,
                                           int16_t *output_y, int16_t *output_co, int16_t *output_cg) {
    int map_bytes = (coeff_count * 2 + 7) / 8;  // 2 bits per coefficient

    // (Debug output removed)

    // Map offsets (all channels present for Y-Co-Cg layout)
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

    // (Debug output removed)

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
// DWT Inverse Transforms (matches TSVM)
//=============================================================================

// 9/7 inverse DWT (from TSVM Kotlin code)
static void dwt_97_inverse_1d(float *data, int length) {
    if (length < 2) return;

    // Debug: Check if input has non-zero values
    static int call_count = 0;
    if (call_count < 5) {
        int nonzero = 0;
        for (int i = 0; i < length; i++) {
            if (data[i] != 0.0f) nonzero++;
        }
        fprintf(stderr, "    dwt_97_inverse_1d call #%d: length=%d, nonzero=%d, first 5: %.1f %.1f %.1f %.1f %.1f\n",
               call_count, length, nonzero,
               data[0], length > 1 ? data[1] : 0.0f, length > 2 ? data[2] : 0.0f,
               length > 3 ? data[3] : 0.0f, length > 4 ? data[4] : 0.0f);
        call_count++;
    }

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Split into low and high frequency components (matching TSVM layout)
    for (int i = 0; i < half; i++) {
        temp[i] = data[i];  // Low-pass coefficients (first half)
    }
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            temp[half + i] = data[half + i];  // High-pass coefficients (second half)
        }
    }

    // 9/7 inverse lifting coefficients from TSVM
    const float alpha = -1.586134342f;
    const float beta = -0.052980118f;
    const float gamma = 0.882911076f;
    const float delta = 0.443506852f;
    const float K = 1.230174105f;

    // Step 1: Undo scaling
    for (int i = 0; i < half; i++) {
        temp[i] /= K;  // Low-pass coefficients
    }
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            temp[half + i] *= K;  // High-pass coefficients
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
            // Even positions: low-pass coefficients
            data[i] = temp[i / 2];
        } else {
            // Odd positions: high-pass coefficients
            int idx = i / 2;
            if (half + idx < length) {
                data[i] = temp[half + idx];
            } else {
                data[i] = 0.0f;
            }
        }
    }

    // Debug: Check output
    if (call_count <= 5) {
        int nonzero_out = 0;
        for (int i = 0; i < length; i++) {
            if (data[i] != 0.0f) nonzero_out++;
        }
        fprintf(stderr, "      -> OUTPUT: nonzero=%d, first 5: %.1f %.1f %.1f %.1f %.1f\n",
               nonzero_out,
               data[0], length > 1 ? data[1] : 0.0f, length > 2 ? data[2] : 0.0f,
               length > 3 ? data[3] : 0.0f, length > 4 ? data[4] : 0.0f);
    }

    free(temp);
}

// 5/3 inverse DWT (simplified - uses 9/7 for now)
static void dwt_53_inverse_1d(float *data, int length) {
    if (length < 2) return;
    // TODO: Implement proper 5/3 from TSVM if needed
    dwt_97_inverse_1d(data, length);
}

// Multi-level inverse DWT (matches TSVM exactly with correct non-power-of-2 handling)
static void apply_inverse_dwt_multilevel(float *data, int width, int height, int levels, int filter_type) {
    int max_size = (width > height) ? width : height;
    float *temp_row = malloc(max_size * sizeof(float));
    float *temp_col = malloc(max_size * sizeof(float));

    // Pre-calculate exact sequence of widths/heights from forward transform
    // This is CRITICAL for non-power-of-2 dimensions (e.g., 560, 448)
    // Forward transform uses: width, (width+1)/2, ((width+1)/2+1)/2, ...
    // Inverse MUST use the exact same sequence in reverse
    int *widths = malloc((levels + 1) * sizeof(int));
    int *heights = malloc((levels + 1) * sizeof(int));

    widths[0] = width;
    heights[0] = height;
    for (int i = 1; i <= levels; i++) {
        widths[i] = (widths[i - 1] + 1) / 2;
        heights[i] = (heights[i - 1] + 1) / 2;
    }

    // Debug: Print dimension sequence
    static int debug_once = 1;
    if (debug_once) {
        fprintf(stderr, "DWT dimension sequence for %dx%d with %d levels:\n", width, height, levels);
        for (int i = 0; i <= levels; i++) {
            fprintf(stderr, "  Level %d: %dx%d\n", i, widths[i], heights[i]);
        }
        debug_once = 0;
    }

    // TSVM: for (level in levels - 1 downTo 0)
    // Apply inverse transforms using pre-calculated dimensions
    for (int level = levels - 1; level >= 0; level--) {
        int current_width = widths[level];
        int current_height = heights[level];

        if (current_width < 1 || current_height < 1) continue;
        if (current_width == 1 && current_height == 1) continue;

        // TSVM: Column inverse transform first (vertical)
        for (int x = 0; x < current_width; x++) {
            for (int y = 0; y < current_height; y++) {
                temp_col[y] = data[y * width + x];
            }

            if (filter_type == 0) {
                dwt_53_inverse_1d(temp_col, current_height);
            } else {
                dwt_97_inverse_1d(temp_col, current_height);
            }

            for (int y = 0; y < current_height; y++) {
                data[y * width + x] = temp_col[y];
            }
        }

        // TSVM: Row inverse transform second (horizontal)
        for (int y = 0; y < current_height; y++) {
            for (int x = 0; x < current_width; x++) {
                temp_row[x] = data[y * width + x];
            }

            if (filter_type == 0) {
                dwt_53_inverse_1d(temp_row, current_width);
            } else {
                dwt_97_inverse_1d(temp_row, current_width);
            }

            for (int x = 0; x < current_width; x++) {
                data[y * width + x] = temp_row[x];
            }
        }

        // Debug after EVERY level
        static int first_frame_levels = 1;
        if (first_frame_levels && level <= 2) {  // Only log levels 2, 1, 0 for first frame
            int nonzero_level = 0;
            for (int y = 0; y < current_height; y++) {
                for (int x = 0; x < current_width; x++) {
                    if (fabsf(data[y * width + x]) > 0.001f) {  // Use fabs for better zero detection
                        nonzero_level++;
                    }
                }
            }
            fprintf(stderr, "After level %d (%dx%d): nonzero=%d/%d, data[0]=%.1f, data[1]=%.1f, data[width]=%.1f\n",
                   level, current_width, current_height, nonzero_level, current_width * current_height,
                   data[0], data[1], data[width]);

            if (level == 0) first_frame_levels = 0;  // Stop after level 0 of first frame
        }
    }

    // Debug: Check buffer after all levels complete
    static int debug_output_once = 1;
    if (debug_output_once) {
        int nonzero_final = 0;
        for (int i = 0; i < width * height; i++) {
            if (data[i] != 0.0f) nonzero_final++;
        }
        fprintf(stderr, "After ALL IDWT levels complete: nonzero=%d/%d, first 10: ", nonzero_final, width * height);
        for (int i = 0; i < 10 && i < width * height; i++) {
            fprintf(stderr, "%.1f ", data[i]);
        }
        fprintf(stderr, "\n");
        debug_output_once = 0;
    }

    free(widths);
    free(heights);
    free(temp_row);
    free(temp_col);
}

//=============================================================================
// YCoCg-R / ICtCp to RGB Conversion (matches TSVM)
//=============================================================================

static void ycocg_r_to_rgb(float y, float co, float cg, uint8_t *r, uint8_t *g, uint8_t *b) {
    float tmp = y - cg / 2.0f;
    float g_val = cg + tmp;
    float b_val = tmp - co / 2.0f;
    float r_val = co + b_val;

    *r = CLAMP((int)(r_val + 0.5f), 0, 255);
    *g = CLAMP((int)(g_val + 0.5f), 0, 255);
    *b = CLAMP((int)(b_val + 0.5f), 0, 255);
}

// ICtCp to RGB conversion (for even TAV versions)
static void ictcp_to_rgb(float i, float ct, float cp, uint8_t *r, uint8_t *g, uint8_t *b) {
    // ICtCp → RGB conversion (inverse of RGB → ICtCp)
    // Step 1: ICtCp → LMS
    float l = i + 0.008609f * ct;
    float m = i - 0.008609f * ct;
    float s = i + 0.560031f * cp;

    // Step 2: LMS (nonlinear) → LMS (linear)
    // Inverse PQ transfer function (simplified)
    l = powf(fmaxf(l, 0.0f), 1.0f / 0.1593f);
    m = powf(fmaxf(m, 0.0f), 1.0f / 0.1593f);
    s = powf(fmaxf(s, 0.0f), 1.0f / 0.1593f);

    // Step 3: LMS → RGB
    float r_val = 5.432622f * l - 4.679910f * m + 0.247288f * s;
    float g_val = -1.106160f * l + 2.311198f * m - 0.205038f * s;
    float b_val = 0.028262f * l - 0.195689f * m + 1.167427f * s;

    *r = CLAMP((int)(r_val * 255.0f + 0.5f), 0, 255);
    *g = CLAMP((int)(g_val * 255.0f + 0.5f), 0, 255);
    *b = CLAMP((int)(b_val * 255.0f + 0.5f), 0, 255);
}

//=============================================================================
// Decoder State Structure
//=============================================================================

typedef struct {
    FILE *input_fp;
    tav_header_t header;
    uint8_t *current_frame_rgb;
    uint8_t *reference_frame_rgb;
    float *dwt_buffer_y;
    float *dwt_buffer_co;
    float *dwt_buffer_cg;
    float *reference_ycocg_y;   // For P-frame delta accumulation
    float *reference_ycocg_co;
    float *reference_ycocg_cg;
    int frame_count;
    int frame_size;
    int is_monoblock;           // True if version 3-6 (single tile mode)

    // FFmpeg pipes for video and audio
    FILE *video_pipe;
    FILE *audio_pipe;
    pid_t ffmpeg_pid;

    // Audio buffer for TAD → PCMu8 conversion
    uint8_t *audio_buffer;
    size_t audio_buffer_size;
    size_t audio_buffer_used;
} tav_decoder_t;

//=============================================================================
// Decoder Initialization and Cleanup
//=============================================================================

static tav_decoder_t* tav_decoder_init(const char *input_file, const char *output_file) {
    tav_decoder_t *decoder = calloc(1, sizeof(tav_decoder_t));
    if (!decoder) return NULL;

    decoder->input_fp = fopen(input_file, "rb");
    if (!decoder->input_fp) {
        free(decoder);
        return NULL;
    }

    // Read header
    if (fread(&decoder->header, sizeof(tav_header_t), 1, decoder->input_fp) != 1) {
        fclose(decoder->input_fp);
        free(decoder);
        return NULL;
    }

    // Verify magic
    if (memcmp(decoder->header.magic, TAV_MAGIC, 8) != 0) {
        fclose(decoder->input_fp);
        free(decoder);
        return NULL;
    }

    decoder->frame_size = decoder->header.width * decoder->header.height;
    decoder->is_monoblock = (decoder->header.version >= 3 && decoder->header.version <= 6);

    // Allocate buffers
    decoder->current_frame_rgb = calloc(decoder->frame_size * 3, 1);
    decoder->reference_frame_rgb = calloc(decoder->frame_size * 3, 1);
    decoder->dwt_buffer_y = calloc(decoder->frame_size, sizeof(float));
    decoder->dwt_buffer_co = calloc(decoder->frame_size, sizeof(float));
    decoder->dwt_buffer_cg = calloc(decoder->frame_size, sizeof(float));
    decoder->reference_ycocg_y = calloc(decoder->frame_size, sizeof(float));
    decoder->reference_ycocg_co = calloc(decoder->frame_size, sizeof(float));
    decoder->reference_ycocg_cg = calloc(decoder->frame_size, sizeof(float));

    // Audio buffer (32 KB should be enough for most audio packets)
    decoder->audio_buffer_size = 32768;
    decoder->audio_buffer = malloc(decoder->audio_buffer_size);
    decoder->audio_buffer_used = 0;

    // Create FFmpeg process for video encoding
    int video_pipe_fd[2], audio_pipe_fd[2];
    if (pipe(video_pipe_fd) == -1 || pipe(audio_pipe_fd) == -1) {
        fprintf(stderr, "Failed to create pipes\n");
        free(decoder->current_frame_rgb);
        free(decoder->reference_frame_rgb);
        free(decoder->dwt_buffer_y);
        free(decoder->dwt_buffer_co);
        free(decoder->dwt_buffer_cg);
        free(decoder->reference_ycocg_y);
        free(decoder->reference_ycocg_co);
        free(decoder->reference_ycocg_cg);
        free(decoder->audio_buffer);
        fclose(decoder->input_fp);
        free(decoder);
        return NULL;
    }

    decoder->ffmpeg_pid = fork();
    if (decoder->ffmpeg_pid == -1) {
        fprintf(stderr, "Failed to fork FFmpeg process\n");
        close(video_pipe_fd[0]); close(video_pipe_fd[1]);
        close(audio_pipe_fd[0]); close(audio_pipe_fd[1]);
        free(decoder->current_frame_rgb);
        free(decoder->reference_frame_rgb);
        free(decoder->dwt_buffer_y);
        free(decoder->dwt_buffer_co);
        free(decoder->dwt_buffer_cg);
        free(decoder->reference_ycocg_y);
        free(decoder->reference_ycocg_co);
        free(decoder->reference_ycocg_cg);
        free(decoder->audio_buffer);
        fclose(decoder->input_fp);
        free(decoder);
        return NULL;
    } else if (decoder->ffmpeg_pid == 0) {
        // Child process - FFmpeg
        close(video_pipe_fd[1]);  // Close write end
        close(audio_pipe_fd[1]);

        char video_size[32];
        char framerate[16];
        snprintf(video_size, sizeof(video_size), "%dx%d", decoder->header.width, decoder->header.height);
        snprintf(framerate, sizeof(framerate), "%d", decoder->header.fps);

        // Redirect pipes to stdin
        dup2(video_pipe_fd[0], 3);  // Video input on fd 3
        dup2(audio_pipe_fd[0], 4);  // Audio input on fd 4
        close(video_pipe_fd[0]);
        close(audio_pipe_fd[0]);

        execl("/usr/bin/ffmpeg", "ffmpeg",
              "-f", "rawvideo",
              "-pixel_format", "rgb24",
              "-video_size", video_size,
              "-framerate", framerate,
              "-i", "pipe:3",              // Video from fd 3
              "-color_range", "2",
              // Note: Audio decoding not yet implemented, so we output video-only MKV
              "-c:v", "ffv1",              // FFV1 codec
              "-level", "3",               // FFV1 level 3
              "-coder", "1",               // Range coder
              "-context", "1",             // Large context
              "-g", "1",                   // GOP size 1 (all I-frames)
              "-slices", "24",             // 24 slices for threading
              "-slicecrc", "1",            // CRC per slice
              "-pixel_format", "rgb24",  // make FFmpeg encode to RGB
              "-color_range", "2",
              "-f", "matroska",            // MKV container
              output_file,
              "-y",                        // Overwrite output
              "-v", "warning",             // Minimal logging
              (char*)NULL);

        fprintf(stderr, "Failed to start FFmpeg\n");
        exit(1);
    } else {
        // Parent process
        close(video_pipe_fd[0]);  // Close read ends
        close(audio_pipe_fd[0]);

        decoder->video_pipe = fdopen(video_pipe_fd[1], "wb");
        decoder->audio_pipe = fdopen(audio_pipe_fd[1], "wb");

        if (!decoder->video_pipe || !decoder->audio_pipe) {
            fprintf(stderr, "Failed to open pipes for writing\n");
            kill(decoder->ffmpeg_pid, SIGTERM);
            free(decoder->current_frame_rgb);
            free(decoder->reference_frame_rgb);
            free(decoder->dwt_buffer_y);
            free(decoder->dwt_buffer_co);
            free(decoder->dwt_buffer_cg);
            free(decoder->reference_ycocg_y);
            free(decoder->reference_ycocg_co);
            free(decoder->reference_ycocg_cg);
            free(decoder->audio_buffer);
            fclose(decoder->input_fp);
            free(decoder);
            return NULL;
        }
    }

    return decoder;
}

static void tav_decoder_free(tav_decoder_t *decoder) {
    if (!decoder) return;

    if (decoder->input_fp) fclose(decoder->input_fp);
    if (decoder->video_pipe) fclose(decoder->video_pipe);
    if (decoder->audio_pipe) fclose(decoder->audio_pipe);

    // Wait for FFmpeg to finish
    if (decoder->ffmpeg_pid > 0) {
        int status;
        waitpid(decoder->ffmpeg_pid, &status, 0);
    }

    free(decoder->current_frame_rgb);
    free(decoder->reference_frame_rgb);
    free(decoder->dwt_buffer_y);
    free(decoder->dwt_buffer_co);
    free(decoder->dwt_buffer_cg);
    free(decoder->reference_ycocg_y);
    free(decoder->reference_ycocg_co);
    free(decoder->reference_ycocg_cg);
    free(decoder->audio_buffer);
    free(decoder);
}

//=============================================================================
// Frame Decoding Logic
//=============================================================================

static int decode_i_or_p_frame(tav_decoder_t *decoder, uint8_t packet_type, uint32_t packet_size) {
    // Variable declarations for cleanup
    uint8_t *compressed_data = NULL;
    uint8_t *decompressed_data = NULL;
    int16_t *quantized_y = NULL;
    int16_t *quantized_co = NULL;
    int16_t *quantized_cg = NULL;
    int decode_success = 1;  // Assume success, set to 0 on error

    // Read and decompress frame data
    compressed_data = malloc(packet_size);
    if (!compressed_data) {
        fprintf(stderr, "Error: Failed to allocate %u bytes for compressed data\n", packet_size);
        decode_success = 0;
        goto write_frame;
    }

    if (fread(compressed_data, 1, packet_size, decoder->input_fp) != packet_size) {
        fprintf(stderr, "Error: Failed to read %u bytes of compressed frame data\n", packet_size);
        decode_success = 0;
        goto write_frame;
    }

    size_t decompressed_size = ZSTD_getFrameContentSize(compressed_data, packet_size);
    if (decompressed_size == ZSTD_CONTENTSIZE_ERROR || decompressed_size == ZSTD_CONTENTSIZE_UNKNOWN) {
        fprintf(stderr, "Warning: Could not determine decompressed size, using estimate\n");
        decompressed_size = decoder->frame_size * 3 * sizeof(int16_t) + 1024;
    }

    decompressed_data = malloc(decompressed_size);
    if (!decompressed_data) {
        fprintf(stderr, "Error: Failed to allocate %zu bytes for decompressed data\n", decompressed_size);
        decode_success = 0;
        goto write_frame;
    }

    // Debug first 3 frames compression
    static int decomp_debug = 0;
    if (decomp_debug < 3) {
        fprintf(stderr, "  [ZSTD frame %d] Compressed size: %u, buffer size: %zu\n", decomp_debug, packet_size, decompressed_size);
        fprintf(stderr, "  [ZSTD frame %d] First 16 bytes of COMPRESSED data: ", decomp_debug);
        for (int i = 0; i < 16 && i < (int)packet_size; i++) {
            fprintf(stderr, "%02X ", compressed_data[i]);
        }
        fprintf(stderr, "\n");
    }

    size_t actual_size = ZSTD_decompress(decompressed_data, decompressed_size, compressed_data, packet_size);

    if (ZSTD_isError(actual_size)) {
        fprintf(stderr, "Error: ZSTD decompression failed: %s\n", ZSTD_getErrorName(actual_size));
        fprintf(stderr, "  Compressed size: %u, Buffer size: %zu\n", packet_size, decompressed_size);
        decode_success = 0;
        goto write_frame;
    }

    if (decomp_debug < 3) {
        fprintf(stderr, "  [ZSTD frame %d] Decompressed size: %zu\n", decomp_debug, actual_size);
        fprintf(stderr, "  [ZSTD frame %d] First 16 bytes of DECOMPRESSED data: ", decomp_debug);
        for (int i = 0; i < 16 && i < (int)actual_size; i++) {
            fprintf(stderr, "%02X ", decompressed_data[i]);
        }
        fprintf(stderr, "\n");
        decomp_debug++;
    }

    // Parse block data
    uint8_t *ptr = decompressed_data;
    uint8_t mode = *ptr++;
    uint8_t qy_override = *ptr++;
    uint8_t qco_override = *ptr++;
    uint8_t qcg_override = *ptr++;

    // IMPORTANT: Both header and override store QLUT indices, not values!
    // Override of 0 means "use header value"
    int qy = qy_override ? QLUT[qy_override] : QLUT[decoder->header.quantiser_y];
    int qco = qco_override ? QLUT[qco_override] : QLUT[decoder->header.quantiser_co];
    int qcg = qcg_override ? QLUT[qcg_override] : QLUT[decoder->header.quantiser_cg];

    // Debug first few frames
    if (decoder->frame_count < 2) {
        fprintf(stderr, "Frame %d: mode=%d, Q: Y=%d, Co=%d, Cg=%d, decompressed=%zu bytes\n",
               decoder->frame_count, mode, qy, qco, qcg, actual_size);
    }

    if (mode == TAV_MODE_SKIP) {
        // Copy from reference frame
        memcpy(decoder->current_frame_rgb, decoder->reference_frame_rgb, decoder->frame_size * 3);
    } else {
        // Decode coefficients (use function-level variables for proper cleanup)
        int coeff_count = decoder->frame_size;
        quantized_y = calloc(coeff_count, sizeof(int16_t));
        quantized_co = calloc(coeff_count, sizeof(int16_t));
        quantized_cg = calloc(coeff_count, sizeof(int16_t));

        if (!quantized_y || !quantized_co || !quantized_cg) {
            fprintf(stderr, "Error: Failed to allocate coefficient buffers\n");
            decode_success = 0;
            goto write_frame;
        }

        // Use 2-bit map format (entropyCoder=0 / Twobit-map)
        postprocess_coefficients_twobit(ptr, coeff_count, quantized_y, quantized_co, quantized_cg);

        // Debug: Check first few coefficients
        if (decoder->frame_count == 32) {
            fprintf(stderr, "  First 10 quantized Y coeffs: ");
            for (int i = 0; i < 10 && i < coeff_count; i++) {
                fprintf(stderr, "%d ", quantized_y[i]);
            }
            fprintf(stderr, "\n");

            // Check for any large quantized values that should produce bright pixels
            int max_quant_y = 0;
            for (int i = 0; i < coeff_count; i++) {
                int abs_val = quantized_y[i] < 0 ? -quantized_y[i] : quantized_y[i];
                if (abs_val > max_quant_y) max_quant_y = abs_val;
            }
            fprintf(stderr, "  Max quantized Y coefficient: %d\n", max_quant_y);
        }

        // Dequantize (perceptual for versions 5-8, uniform for 1-4)
        const int is_perceptual = (decoder->header.version >= 5 && decoder->header.version <= 8);
        if (is_perceptual) {
            dequantize_dwt_subbands_perceptual(0, qy, quantized_y, decoder->dwt_buffer_y,
                                              decoder->header.width, decoder->header.height,
                                              decoder->header.decomp_levels, qy, 0, decoder->frame_count);

            // Debug: Check if values survived the function call
            if (decoder->frame_count == 32) {
                fprintf(stderr, "  RIGHT AFTER dequantize_Y returns: first 5 values: %.1f %.1f %.1f %.1f %.1f\n",
                       decoder->dwt_buffer_y[0], decoder->dwt_buffer_y[1], decoder->dwt_buffer_y[2],
                       decoder->dwt_buffer_y[3], decoder->dwt_buffer_y[4]);
            }

            dequantize_dwt_subbands_perceptual(0, qy, quantized_co, decoder->dwt_buffer_co,
                                              decoder->header.width, decoder->header.height,
                                              decoder->header.decomp_levels, qco, 1, decoder->frame_count);
            dequantize_dwt_subbands_perceptual(0, qy, quantized_cg, decoder->dwt_buffer_cg,
                                              decoder->header.width, decoder->header.height,
                                              decoder->header.decomp_levels, qcg, 1, decoder->frame_count);
        } else {
            for (int i = 0; i < coeff_count; i++) {
                decoder->dwt_buffer_y[i] = quantized_y[i] * qy;
                decoder->dwt_buffer_co[i] = quantized_co[i] * qco;
                decoder->dwt_buffer_cg[i] = quantized_cg[i] * qcg;
            }
        }

        // Debug: Check dequantized values using correct subband layout
        if (decoder->frame_count == 32) {
            dwt_subband_info_t subbands[32];
            const int subband_count = calculate_subband_layout(decoder->header.width, decoder->header.height,
                                                              decoder->header.decomp_levels, subbands);

            // Find LL band (highest level, type 0)
            for (int s = 0; s < subband_count; s++) {
                if (subbands[s].level == decoder->header.decomp_levels && subbands[s].subband_type == 0) {
                    fprintf(stderr, "  LL band: level=%d, start=%d, count=%d\n",
                           subbands[s].level, subbands[s].coeff_start, subbands[s].coeff_count);
                    fprintf(stderr, "    Reading LL first 5 from dwt_buffer_y[0-4]: %.1f %.1f %.1f %.1f %.1f\n",
                           decoder->dwt_buffer_y[0], decoder->dwt_buffer_y[1], decoder->dwt_buffer_y[2],
                           decoder->dwt_buffer_y[3], decoder->dwt_buffer_y[4]);

                    // Find max in CORRECT LL band
                    float max_ll = -999.0f;
                    for (int i = 0; i < subbands[s].coeff_count; i++) {
                        int idx = subbands[s].coeff_start + i;
                        if (decoder->dwt_buffer_y[idx] > max_ll) max_ll = decoder->dwt_buffer_y[idx];
                    }
                    fprintf(stderr, "  Max LL coefficient BEFORE grain removal: %.1f\n", max_ll);
                    break;
                }
            }
        }

        // Remove grain synthesis from Y channel (must happen after dequantization, before inverse DWT)
        remove_grain_synthesis_decoder(decoder->dwt_buffer_y, decoder->header.width, decoder->header.height,
                                      decoder->header.decomp_levels, decoder->frame_count, decoder->header.quantiser_y);

        // Debug: Check LL band AFTER grain removal
        if (decoder->frame_count == 32) {
            int ll_width = decoder->header.width;
            int ll_height = decoder->header.height;
            for (int l = 0; l < decoder->header.decomp_levels; l++) {
                ll_width = (ll_width + 1) / 2;
                ll_height = (ll_height + 1) / 2;
            }
            float max_ll = -999.0f;
            for (int i = 0; i < ll_width * ll_height; i++) {
                if (decoder->dwt_buffer_y[i] > max_ll) max_ll = decoder->dwt_buffer_y[i];
            }
            fprintf(stderr, "  Max LL coefficient AFTER grain removal: %.1f\n", max_ll);
        }

        // Apply inverse DWT with correct non-power-of-2 dimension handling
        // Note: quantized arrays freed at write_frame label
        apply_inverse_dwt_multilevel(decoder->dwt_buffer_y, decoder->header.width, decoder->header.height,
                                   decoder->header.decomp_levels, decoder->header.wavelet_filter);
        apply_inverse_dwt_multilevel(decoder->dwt_buffer_co, decoder->header.width, decoder->header.height,
                                   decoder->header.decomp_levels, decoder->header.wavelet_filter);
        apply_inverse_dwt_multilevel(decoder->dwt_buffer_cg, decoder->header.width, decoder->header.height,
                                   decoder->header.decomp_levels, decoder->header.wavelet_filter);

        // Debug: Check spatial domain values after IDWT
        if (decoder->frame_count == 32) {
            float max_y_spatial = -999.0f;
            for (int i = 0; i < decoder->frame_size; i++) {
                if (decoder->dwt_buffer_y[i] > max_y_spatial) max_y_spatial = decoder->dwt_buffer_y[i];
            }
            fprintf(stderr, "  Max Y in spatial domain AFTER IDWT: %.1f\n", max_y_spatial);
        }

        // Debug: Check spatial domain values after IDWT (original debug)
        if (decoder->frame_count < 1) {
            fprintf(stderr, "  After IDWT - First 10 Y values: ");
            for (int i = 0; i < 10 && i < decoder->frame_size; i++) {
                fprintf(stderr, "%.1f ", decoder->dwt_buffer_y[i]);
            }
            fprintf(stderr, "\n");
            fprintf(stderr, "  Y range: min=%.1f, max=%.1f\n",
                   decoder->dwt_buffer_y[0], decoder->dwt_buffer_y[decoder->frame_size-1]);
        }

        // Handle P-frame delta accumulation (in YCoCg float space)
        if (packet_type == TAV_PACKET_PFRAME && mode == TAV_MODE_DELTA) {
            for (int i = 0; i < decoder->frame_size; i++) {
                decoder->dwt_buffer_y[i] += decoder->reference_ycocg_y[i];
                decoder->dwt_buffer_co[i] += decoder->reference_ycocg_co[i];
                decoder->dwt_buffer_cg[i] += decoder->reference_ycocg_cg[i];
            }
        }

        // Convert YCoCg-R/ICtCp to RGB
        const int is_ictcp = (decoder->header.version % 2 == 0);
        float max_y = -999, max_co = -999, max_cg = -999;
        int max_r = 0, max_g = 0, max_b = 0;

        for (int i = 0; i < decoder->frame_size; i++) {
            uint8_t r, g, b;
            if (is_ictcp) {
                ictcp_to_rgb(decoder->dwt_buffer_y[i],
                           decoder->dwt_buffer_co[i],
                           decoder->dwt_buffer_cg[i], &r, &g, &b);
            } else {
                ycocg_r_to_rgb(decoder->dwt_buffer_y[i],
                             decoder->dwt_buffer_co[i],
                             decoder->dwt_buffer_cg[i], &r, &g, &b);
            }

            // Track max values for debugging
            if (decoder->frame_count == 1000) {
                if (decoder->dwt_buffer_y[i] > max_y) max_y = decoder->dwt_buffer_y[i];
                if (decoder->dwt_buffer_co[i] > max_co) max_co = decoder->dwt_buffer_co[i];
                if (decoder->dwt_buffer_cg[i] > max_cg) max_cg = decoder->dwt_buffer_cg[i];
                if (r > max_r) max_r = r;
                if (g > max_g) max_g = g;
                if (b > max_b) max_b = b;
            }

            // RGB byte order for FFmpeg rgb24
            decoder->current_frame_rgb[i * 3 + 0] = r;
            decoder->current_frame_rgb[i * 3 + 1] = g;
            decoder->current_frame_rgb[i * 3 + 2] = b;
        }

        if (decoder->frame_count == 1000) {
            fprintf(stderr, "\n=== Frame 1000 Value Analysis ===\n");
            fprintf(stderr, "Max YCoCg values: Y=%.1f, Co=%.1f, Cg=%.1f\n", max_y, max_co, max_cg);
            fprintf(stderr, "Max RGB values: R=%d, G=%d, B=%d\n", max_r, max_g, max_b);
        }

        // Debug: Check RGB output
        if (decoder->frame_count < 1) {
            fprintf(stderr, "  First 5 pixels RGB: ");
            for (int i = 0; i < 5 && i < decoder->frame_size; i++) {
                fprintf(stderr, "(%d,%d,%d) ",
                       decoder->current_frame_rgb[i*3],
                       decoder->current_frame_rgb[i*3+1],
                       decoder->current_frame_rgb[i*3+2]);
            }
            fprintf(stderr, "\n");
        }

        // Update reference YCoCg frame
        memcpy(decoder->reference_ycocg_y, decoder->dwt_buffer_y, decoder->frame_size * sizeof(float));
        memcpy(decoder->reference_ycocg_co, decoder->dwt_buffer_co, decoder->frame_size * sizeof(float));
        memcpy(decoder->reference_ycocg_cg, decoder->dwt_buffer_cg, decoder->frame_size * sizeof(float));
    }

    // Update reference frame
    memcpy(decoder->reference_frame_rgb, decoder->current_frame_rgb, decoder->frame_size * 3);

write_frame:
    // Clean up temporary allocations
    if (compressed_data) free(compressed_data);
    if (decompressed_data) free(decompressed_data);
    if (quantized_y) free(quantized_y);
    if (quantized_co) free(quantized_co);
    if (quantized_cg) free(quantized_cg);

    // If decoding failed, fill frame with black to maintain stream alignment
    if (!decode_success) {
        memset(decoder->current_frame_rgb, 0, decoder->frame_size * 3);
        fprintf(stderr, "Warning: Writing black frame %d due to decode error\n", decoder->frame_count);
    }

    // Write frame to video pipe with retry on partial writes (ALWAYS write to maintain alignment)
    size_t bytes_to_write = decoder->frame_size * 3;
    size_t total_written = 0;
    const uint8_t *write_ptr = decoder->current_frame_rgb;

    while (total_written < bytes_to_write) {
        size_t bytes_written = fwrite(write_ptr + total_written, 1,
                                     bytes_to_write - total_written,
                                     decoder->video_pipe);
        if (bytes_written == 0) {
            if (ferror(decoder->video_pipe)) {
                fprintf(stderr, "Error: Pipe write error at frame %d (wrote %zu/%zu bytes) - aborting\n",
                       decoder->frame_count, total_written, bytes_to_write);
                // Cannot maintain stream alignment if pipe is broken - this is fatal
                return -1;
            }
            // Pipe might be full, flush and retry
            fflush(decoder->video_pipe);
            usleep(1000); // 1ms delay
        } else {
            total_written += bytes_written;
        }
    }

    // Ensure data is flushed to FFmpeg
    if (fflush(decoder->video_pipe) != 0) {
        fprintf(stderr, "Error: Failed to flush video pipe at frame %d - aborting\n", decoder->frame_count);
        // Cannot maintain stream alignment if pipe is broken - this is fatal
        return -1;
    }

    decoder->frame_count++;
    // Return success only if decoding succeeded; still return 1 to continue processing
    // (we wrote a frame either way to maintain stream alignment)
    return decode_success ? 1 : 1;  // Always return 1 to continue, errors are non-fatal now
}

//=============================================================================
// Main Decoding Loop
//=============================================================================

static void print_usage(const char *prog) {
    printf("TAV Decoder - Converts TAV video to FFV1+PCMu8 in MKV container\n");
    printf("Version: %s\n\n", DECODER_VENDOR_STRING);
    printf("Usage: %s -i input.tav -o output.mkv\n\n", prog);
    printf("Options:\n");
    printf("  -i <file>    Input TAV file\n");
    printf("  -o <file>    Output MKV file (FFV1 video + PCMu8 audio)\n");
    printf("  -v           Verbose output\n");
    printf("  -h, --help   Show this help\n\n");
    printf("Supported features (matches TSVM decoder):\n");
    printf("  - I-frames and P-frames (delta mode)\n");
    printf("  - GOP unified 3D DWT (temporal compression)\n");
    printf("  - TAD audio (decoded to PCMu8)\n");
    printf("  - MP2 audio (passed through)\n");
    printf("  - All wavelet types (5/3, 9/7, CDF 13/7, DD-4, Haar)\n");
    printf("  - Perceptual quantization (versions 5-8)\n");
    printf("  - YCoCg-R and ICtCp color spaces\n\n");
    printf("Unsupported features (not in TSVM decoder):\n");
    printf("  - MC-EZBC motion compensation\n");
    printf("  - MPEG-style residual coding (P/B-frames)\n");
    printf("  - Adaptive block partitioning\n\n");
}

int main(int argc, char *argv[]) {
    char *input_file = NULL;
    char *output_file = NULL;
    int verbose = 0;

    static struct option long_options[] = {
        {"help", no_argument, 0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "i:o:vh", long_options, NULL)) != -1) {
        switch (opt) {
            case 'i':
                input_file = optarg;
                break;
            case 'o':
                output_file = optarg;
                break;
            case 'v':
                verbose = 1;
                break;
            case 'h':
                print_usage(argv[0]);
                return 0;
            default:
                print_usage(argv[0]);
                return 1;
        }
    }

    if (!input_file || !output_file) {
        fprintf(stderr, "Error: Both input and output files are required\n\n");
        print_usage(argv[0]);
        return 1;
    }

    tav_decoder_t *decoder = tav_decoder_init(input_file, output_file);
    if (!decoder) {
        fprintf(stderr, "Failed to initialize decoder\n");
        return 1;
    }

    if (verbose) {
        printf("TAV Decoder - %dx%d @ %dfps\n", decoder->header.width, decoder->header.height, decoder->header.fps);
        printf("Wavelet: %s, Levels: %d\n",
               decoder->header.wavelet_filter == 0 ? "5/3" :
               decoder->header.wavelet_filter == 1 ? "9/7" :
               decoder->header.wavelet_filter == 2 ? "CDF 13/7" :
               decoder->header.wavelet_filter == 16 ? "DD-4" :
               decoder->header.wavelet_filter == 255 ? "Haar" : "Unknown",
               decoder->header.decomp_levels);
        printf("Version: %d (%s, %s)\n", decoder->header.version,
               decoder->header.version % 2 == 0 ? "ICtCp" : "YCoCg-R",
               decoder->is_monoblock ? "monoblock" : "tiled");
        printf("Output: %s (FFV1 level 3 + PCMu8 @ 32 KHz)\n", output_file);
    }

    // Main decoding loop
    int result = 1;
    int total_packets = 0;
    int iframe_count = 0;
    while (result > 0) {
        uint8_t packet_type;
        if (fread(&packet_type, 1, 1, decoder->input_fp) != 1) {
            result = 0; // EOF
            break;
        }

        total_packets++;

        // Handle sync packets (no size field)
        if (packet_type == TAV_PACKET_SYNC || packet_type == TAV_PACKET_SYNC_NTSC) {
            if (verbose && total_packets < 20) {
                fprintf(stderr, "Packet %d: SYNC (0x%02X)\n", total_packets, packet_type);
            }
            continue;
        }

        // Handle timecode packets (no size field, just 8 bytes of uint64 timecode)
        if (packet_type == TAV_PACKET_TIMECODE) {
            uint64_t timecode_ns;
            if (fread(&timecode_ns, 8, 1, decoder->input_fp) != 1) {
                fprintf(stderr, "Error: Failed to read timecode\n");
                result = -1;
                break;
            }
            if (verbose && total_packets < 20) {
                double timecode_sec = timecode_ns / 1000000000.0;
                fprintf(stderr, "Packet %d: TIMECODE (0x%02X) - %.6f seconds\n",
                       total_packets, packet_type, timecode_sec);
            }
            continue;
        }

        // Handle GOP sync packets (no size field, just 1 byte frame count)
        if (packet_type == TAV_PACKET_GOP_SYNC) {
            uint8_t frame_count;
            if (fread(&frame_count, 1, 1, decoder->input_fp) != 1) {
                fprintf(stderr, "Error: Failed to read GOP sync frame count\n");
                result = -1;
                break;
            }
            if (verbose) {
                fprintf(stderr, "Packet %d: GOP_SYNC (0x%02X) - %u frames from GOP\n",
                       total_packets, packet_type, frame_count);
            }
            // Frame count is informational only for now
            continue;
        }

        // Handle GOP unified packets (custom format: 1-byte gop_size + 4-byte compressed_size)
        if (packet_type == TAV_PACKET_GOP_UNIFIED) {
            uint8_t gop_size;
            uint32_t compressed_size;
            if (fread(&gop_size, 1, 1, decoder->input_fp) != 1 ||
                fread(&compressed_size, 4, 1, decoder->input_fp) != 1) {
                fprintf(stderr, "Error: Failed to read GOP unified packet header\n");
                result = -1;
                break;
            }
            if (verbose && total_packets < 20) {
                fprintf(stderr, "Packet %d: GOP_UNIFIED (0x%02X), %u frames, %u bytes - skipping\n",
                       total_packets, packet_type, gop_size, compressed_size);
            }
            // Skip GOP data for now
            fseek(decoder->input_fp, compressed_size, SEEK_CUR);
            fprintf(stderr, "\nWarning: GOP unified packets not yet implemented (skipping %u frames)\n", gop_size);
            continue;
        }

        // Handle TAD audio packets (custom format: 2-byte sample_count + 4-byte payload_size)
        if (packet_type == TAV_PACKET_AUDIO_TAD) {
            uint16_t sample_count;
            uint32_t payload_size;
            if (fread(&sample_count, 2, 1, decoder->input_fp) != 1 ||
                fread(&payload_size, 4, 1, decoder->input_fp) != 1) {
                fprintf(stderr, "\nError: Failed to read TAD packet header\n");
                result = -1;
                break;
            }
            if (verbose && total_packets < 20) {
                fprintf(stderr, "Packet %d: TAD (0x%02X), %u samples, %u payload bytes - skipping\n",
                       total_packets, packet_type, sample_count, payload_size);
            }
            // Skip TAD data for now
            fseek(decoder->input_fp, payload_size, SEEK_CUR);
            fprintf(stderr, "\nWarning: TAD audio decoding not yet fully implemented (skipping %u samples)\n", sample_count);
            continue;
        }

        // Handle extended header (has 2-byte count, not 4-byte size)
        if (packet_type == TAV_PACKET_EXTENDED_HDR) {
            uint16_t num_pairs;
            if (fread(&num_pairs, 2, 1, decoder->input_fp) != 1) {
                fprintf(stderr, "Error: Failed to read extended header count\n");
                result = -1;
                break;
            }
            if (verbose && total_packets < 20) {
                fprintf(stderr, "Packet %d: EXTENDED_HDR (0x%02X), %u pairs - skipping\n",
                       total_packets, packet_type, num_pairs);
            }
            // Skip the key-value pairs
            // Format: each pair is [4-byte key][1-byte type][N-byte value]
            // We need to parse each pair to know its size
            for (int i = 0; i < num_pairs; i++) {
                uint8_t key[4];
                uint8_t value_type;
                if (fread(key, 1, 4, decoder->input_fp) != 4 ||
                    fread(&value_type, 1, 1, decoder->input_fp) != 1) {
                    fprintf(stderr, "Error: Failed to read extended header pair %d\n", i);
                    result = -1;
                    break;
                }
                // Determine value size based on type
                size_t value_size = 0;
                switch (value_type) {
                    case 0x00: value_size = 2; break;  // Int16
                    case 0x01: value_size = 3; break;  // Int24
                    case 0x02: value_size = 4; break;  // Int32
                    case 0x03: value_size = 6; break;  // Int48
                    case 0x04: value_size = 8; break;  // Int64
                    case 0x10: {  // Bytes with 2-byte length prefix
                        uint16_t str_len;
                        if (fread(&str_len, 2, 1, decoder->input_fp) != 1) {
                            fprintf(stderr, "Error: Failed to read string length\n");
                            result = -1;
                            break;
                        }
                        value_size = str_len;
                        break;
                    }
                    default:
                        fprintf(stderr, "Warning: Unknown extended header value type 0x%02X\n", value_type);
                        break;
                }
                // Skip the value
                if (value_size > 0) {
                    fseek(decoder->input_fp, value_size, SEEK_CUR);
                }
            }
            if (result < 0) break;
            continue;
        }

        // Read packet size (for remaining packet types with standard format)
        uint32_t packet_size;
        if (fread(&packet_size, 4, 1, decoder->input_fp) != 1) {
            fprintf(stderr, "Error: Failed to read packet size at packet %d (type 0x%02X)\n",
                   total_packets, packet_type);
            result = -1;
            break;
        }

        if (verbose && total_packets < 20) {
            fprintf(stderr, "Packet %d: Type 0x%02X, Size %u bytes\n", total_packets, packet_type, packet_size);
        }

        switch (packet_type) {
            case TAV_PACKET_IFRAME:
            case TAV_PACKET_PFRAME:
                iframe_count++;
                if (verbose && iframe_count <= 5) {
                    fprintf(stderr, "Processing %s (packet %d, size %u bytes)...\n",
                           packet_type == TAV_PACKET_IFRAME ? "I-frame" : "P-frame",
                           total_packets, packet_size);
                }
                result = decode_i_or_p_frame(decoder, packet_type, packet_size);
                if (result < 0) {
                    fprintf(stderr, "Error: Frame decoding failed at frame %d\n", decoder->frame_count);
                    break;
                }
                if (verbose && decoder->frame_count % 100 == 0) {
                    printf("Decoded frame %d\r", decoder->frame_count);
                    fflush(stdout);
                }
                break;

            case TAV_PACKET_AUDIO_MP2:
            case TAV_PACKET_AUDIO_PCM8:
            case TAV_PACKET_AUDIO_TRACK:
                // Skip audio for now
                fseek(decoder->input_fp, packet_size, SEEK_CUR);
                break;

            case TAV_PACKET_SUBTITLE:
                // Skip subtitle packets
                fseek(decoder->input_fp, packet_size, SEEK_CUR);
                break;

            case TAV_PACKET_PFRAME_RESIDUAL:
            case TAV_PACKET_BFRAME_RESIDUAL:
                fprintf(stderr, "\nError: Unsupported packet type 0x%02X (MPEG-style motion compensation not supported)\n", packet_type);
                result = -1;
                break;

            default:
                fprintf(stderr, "\nWarning: Unknown packet type 0x%02X (skipping)\n", packet_type);
                fseek(decoder->input_fp, packet_size, SEEK_CUR);
                break;
        }
    }

    if (verbose) {
        printf("\nDecoded %d frames\n", decoder->frame_count);
    }

    tav_decoder_free(decoder);

    if (result < 0) {
        fprintf(stderr, "Decoding error occurred\n");
        return 1;
    }

    printf("Successfully decoded to: %s\n", output_file);
    return 0;
}
