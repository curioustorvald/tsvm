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
#include <sys/time.h>
#include <getopt.h>
#include <signal.h>
#include "decoder_tad.h"  // Shared TAD decoder library
#include "tav_avx512.h"  // AVX-512 SIMD optimisations

#define DECODER_VENDOR_STRING "Decoder-TAV 20251124 (avx512,presets)"

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
#define TAV_PACKET_SUBTITLE_TC     0x31  // Subtitle - SKIPPED
#define TAV_PACKET_EXTENDED_HDR    0xEF  // Extended header - SKIPPED
#define TAV_PACKET_SCREEN_MASK     0xF2  // Screen masking (letterbox/pillarbox) - PARSED
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
    uint8_t encoder_preset;  // Byte 28: bit 0 = sports, bit 1 = anime
    uint8_t reserved;
    uint8_t device_orientation;
    uint8_t file_role;
} __attribute__((packed)) tav_header_t;

//=============================================================================
// Quantisation Lookup Table (matches TSVM exactly)
//=============================================================================

static const int QLUT[] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096};

// Perceptual quantisation constants (match TSVM)
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

static void dequantise_dwt_subbands_perceptual(int q_index, int q_y_global, const int16_t *quantised,
                                              float *dequantised, int width, int height, int decomp_levels,
                                              float base_quantiser, int is_chroma, int frame_num) {
    dwt_subband_info_t subbands[32]; // Max possible subbands
    const int subband_count = calculate_subband_layout(width, height, decomp_levels, subbands);

    const int coeff_count = width * height;
    memset(dequantised, 0, coeff_count * sizeof(float));

    int is_debug = 0;//(frame_num == 32);
//    if (frame_num == 32) {
//        fprintf(stderr, "DEBUG: dequantise called for frame %d, is_chroma=%d\n", frame_num, is_chroma);
//    }

    // Apply perceptual weighting to each subband
    for (int s = 0; s < subband_count; s++) {
        const dwt_subband_info_t *subband = &subbands[s];
        const float weight = get_perceptual_weight(q_index, q_y_global, subband->level,
                                                  subband->subband_type, is_chroma, decomp_levels);
        const float effective_quantiser = base_quantiser * weight;

        if (is_debug && !is_chroma) {
            if (subband->subband_type == 0) { // LL band
                fprintf(stderr, "  Subband level %d (LL): weight=%.6f, base_q=%.1f, effective_q=%.1f, count=%d\n",
                       subband->level, weight, base_quantiser, effective_quantiser, subband->coeff_count);

                // Print first 5 quantised LL coefficients
                fprintf(stderr, "    First 5 quantised LL: ");
                for (int k = 0; k < 5 && k < subband->coeff_count; k++) {
                    int idx = subband->coeff_start + k;
                    fprintf(stderr, "%d ", quantised[idx]);
                }
                fprintf(stderr, "\n");

                // Find max quantised LL coefficient
                int max_quant_ll = 0;
                for (int k = 0; k < subband->coeff_count; k++) {
                    int idx = subband->coeff_start + k;
                    int abs_val = quantised[idx] < 0 ? -quantised[idx] : quantised[idx];
                    if (abs_val > max_quant_ll) max_quant_ll = abs_val;
                }
                fprintf(stderr, "    Max quantised LL coefficient: %d (dequantises to %.1f)\n",
                       max_quant_ll, max_quant_ll * effective_quantiser);
            }
        }

        // Apply linear dequantisation with perceptual weights (matching encoder's linear storage)
        // FIX (2025-11-11): Both EZBC and Significance-map modes now store NORMALIZED coefficients
        //                   Encoder stores quantised values (e.g., round(377/48) = 8)
        //                   Decoder must multiply by effective quantiser to denormalize
        //                   Previous denormalization in EZBC caused int16_t overflow (clipping at 32767)
        //                   for bright pixels, creating dark DWT-pattern blemishes

#ifdef __AVX512F__
        // Use AVX-512 optimised dequantization if available (1.1x speedup against -Ofast)
        // Check: subband has >=16 elements AND won't exceed buffer bounds
        const int subband_end = subband->coeff_start + subband->coeff_count;
        if (g_simd_level >= SIMD_AVX512F && subband->coeff_count >= 16 && subband_end <= coeff_count) {
            dequantise_dwt_coefficients_avx512(
                quantised + subband->coeff_start,
                dequantised + subband->coeff_start,
                subband->coeff_count,
                effective_quantiser
            );
        } else {
#endif
            // Scalar fallback or small subbands
            for (int i = 0; i < subband->coeff_count; i++) {
                const int idx = subband->coeff_start + i;
                if (idx < coeff_count) {
                    const float untruncated = quantised[idx] * effective_quantiser;
                    dequantised[idx] = untruncated;
                }
            }
#ifdef __AVX512F__
        }
#endif
    }

    // Debug: Verify LL band was dequantised correctly
    if (is_debug && !is_chroma) {
        // Find LL band again to verify
        for (int s = 0; s < subband_count; s++) {
            const dwt_subband_info_t *subband = &subbands[s];
            if (subband->level == decomp_levels && subband->subband_type == 0) {
                fprintf(stderr, "  AFTER all subbands processed - First 5 dequantised LL: ");
                for (int k = 0; k < 5 && k < subband->coeff_count; k++) {
                    int idx = subband->coeff_start + k;
                    fprintf(stderr, "%.1f ", dequantised[idx]);
                }
                fprintf(stderr, "\n");

                // Find max dequantised LL
                float max_dequant_ll = -999.0f;
                for (int k = 0; k < subband->coeff_count; k++) {
                    int idx = subband->coeff_start + k;
                    float abs_val = dequantised[idx] < 0 ? -dequantised[idx] : dequantised[idx];
                    if (abs_val > max_dequant_ll) max_dequant_ll = abs_val;
                }
                fprintf(stderr, "  AFTER all subbands - Max dequantised LL: %.1f\n", max_dequant_ll);
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

// Apply grain synthesis from DWT coefficients (decoder subtracts noise)
// This must be called AFTER dequantisation but BEFORE inverse DWT
static void apply_grain_synthesis(float *coeffs, int width, int height,
                                          int decomp_levels, int frame_num, int q_y_global, uint8_t encoder_preset, int no_grain_synthesis) {
    // Command-line override: disable grain synthesis
    if (no_grain_synthesis) {
        return;  // Skip grain synthesis entirely
    }

    // Anime preset: completely disable grain synthesis
    if (encoder_preset & 0x02) {
        return;  // Skip grain synthesis entirely
    }

    dwt_subband_info_t subbands[32];
    const int subband_count = calculate_subband_layout(width, height, decomp_levels, subbands);

    // Noise amplitude (matches Kotlin: qYGlobal.coerceAtMost(32) * 0.8f)
    const float noise_amplitude = (q_y_global < 32 ? q_y_global : 32) * 0.4f; // somehow this term behaves differently from the Kotlin decoder

    // Process each subband (skip LL band which is level 0)
    for (int s = 0; s < subband_count; s++) {
        const dwt_subband_info_t *subband = &subbands[s];
        if (subband->level == 0) continue;  // Skip LL band

        // Calculate band index for RNG (matches Kotlin: level + subbandType * 31 + 16777619)
        uint32_t band = subband->level + subband->subband_type * 31 + 16777619;

        // Apply noise from each coefficient in this subband
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
static int calculate_dwt_levels(int chunk_size) {
    /*if (chunk_size < TAD_MIN_CHUNK_SIZE) {
        fprintf(stderr, "Error: Chunk size %d is below minimum %d\n", chunk_size, TAD_MIN_CHUNK_SIZE);
        return -1;
    }

    // Calculate levels: log2(chunk_size) - 1
    int levels = 0;
    int size = chunk_size;
    while (size > 1) {
        size >>= 1;
        levels++;
    }
    return levels - 2;*/
    return 9;
}

//=============================================================================
// Chunk Decoding (TAD Audio)
// NOTE: TAD decoding now uses shared tad32_decode_chunk() from decoder_tad.h
//       This ensures decoder_tav and decoder_tad use identical decoding logic
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
// EZBC (Embedded Zero Block Coding) Decoder
//=============================================================================

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

// Read N bits from EZBC bitstream (LSB-first within each byte)
static int ezbc_read_bits(ezbc_bitreader_t *reader, int num_bits) {
    int result = 0;
    for (int i = 0; i < num_bits; i++) {
        if (reader->byte_pos >= reader->size) {
            return result;  // End of stream
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

// EZBC block queues (simple dynamic arrays)
typedef struct {
    ezbc_block_t *blocks;
    int count;
    int capacity;
} ezbc_block_queue_t;

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

        // Set coefficient to threshold value with sign
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

    // Debug: Print first few bytes
//    fprintf(stderr, "[EZBC] Channel decode: offset=%zu, size=%zu, first 5 bytes: %02X %02X %02X %02X %02X\n",
//           offset, size,
//           ezbc_data[offset], ezbc_data[offset+1], ezbc_data[offset+2],
//           ezbc_data[offset+3], ezbc_data[offset+4]);

    // Read header: MSB bitplane (8 bits), width (16 bits), height (16 bits)
    const int msb_bitplane = ezbc_read_bits(&reader, 8);
    const int width = ezbc_read_bits(&reader, 16);
    const int height = ezbc_read_bits(&reader, 16);

//    fprintf(stderr, "[EZBC] Decoded header: MSB=%d, width=%d, height=%d (expected pixels=%d)\n",
//           msb_bitplane, width, height, expected_count);

    // With crop encoding, dimensions can vary per frame - trust the EZBC header
    // Just ensure we don't overflow the output buffer
    const int actual_count = width * height;
    if (actual_count > expected_count) {
        fprintf(stderr, "EZBC dimension overflow: %dx%d (%d) > %d\n",
                width, height, actual_count, expected_count);
        memset(output, 0, expected_count * sizeof(int16_t));
        return;
    }

    // If actual count is less, only decode what we need
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
                // Still insignificant
                ezbc_queue_add(&next_insignificant, insignificant.blocks[i]);
            } else {
                // Became significant - use recursive processing
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

            // Add refinement bit at current bitplane
            if (refine_bit) {
                const int bit_value = 1 << bitplane;
                if (output[idx] < 0) {
                    output[idx] -= bit_value;
                } else {
                    output[idx] += bit_value;
                }
            }

            // Keep in significant queue
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

    // Debug: Count non-zero coefficients
    int nonzero_count = 0;
    int16_t max_val = 0, min_val = 0;
    for (int i = 0; i < expected_count; i++) {
        if (output[i] != 0) {
            nonzero_count++;
            if (output[i] > max_val) max_val = output[i];
            if (output[i] < min_val) min_val = output[i];
        }
    }
//    fprintf(stderr, "[EZBC] Decoded %d non-zero coeffs (%.1f%%), range: [%d, %d]\n",
//           nonzero_count, 100.0 * nonzero_count / expected_count, min_val, max_val);
}

// Helper: peek at EZBC header to get dimensions without decoding
static int ezbc_peek_dimensions(const uint8_t *compressed_data, int channel_layout,
                                 int *out_width, int *out_height) {
    const int has_y = (channel_layout & 0x04) == 0;

    if (!has_y) {
        return -1;  // Need Y channel to get dimensions
    }

    // Read Y channel size header
    const uint32_t size = ((uint32_t)compressed_data[0]) |
                         ((uint32_t)compressed_data[1] << 8) |
                         ((uint32_t)compressed_data[2] << 16) |
                         ((uint32_t)compressed_data[3] << 24);

    if (size < 6) {
        return -1;  // Too small to contain EZBC header
    }

    // Skip to EZBC data for Y channel (after size header)
    const uint8_t *ezbc_data = compressed_data + 4;

    // Read EZBC header: skip MSB bitplane (1 byte), then read width and height
    // Note: EZBC uses bitstream format, but dimensions are at fixed positions
    // We need to parse the bitstream header carefully

    // Create a temporary reader to parse the bitstream
    ezbc_bitreader_t reader;
    reader.data = ezbc_data;
    reader.size = size;
    reader.byte_pos = 0;
    reader.bit_pos = 0;

    // Read header: MSB bitplane (8 bits), width (16 bits), height (16 bits)
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

    // Debug: Check if input has non-zero values
//    static int call_count = 0;
//    if (call_count < 5) {
//         Debug: count non-zero coefficients (disabled to reduce stderr output)
//         int nonzero = 0;
//         for (int i = 0; i < length; i++) {
//             if (data[i] != 0.0f) nonzero++;
//         }
//         fprintf(stderr, "    dwt_97_inverse_1d call #%d: length=%d, nonzero=%d, first 5: %.1f %.1f %.1f %.1f %.1f\n",
//                call_count, length, nonzero,
//                data[0], length > 1 ? data[1] : 0.0f, length > 2 ? data[2] : 0.0f,
//                length > 3 ? data[3] : 0.0f, length > 4 ? data[4] : 0.0f);
//         call_count++;
//    }

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

    // Debug: Check output (disabled to reduce stderr output)
    // if (call_count <= 5) {
    //     int nonzero_out = 0;
    //     for (int i = 0; i < length; i++) {
    //         if (data[i] != 0.0f) nonzero_out++;
    //     }
    //     fprintf(stderr, "      -> OUTPUT: nonzero=%d, first 5: %.1f %.1f %.1f %.1f %.1f\n",
    //            nonzero_out,
    //            data[0], length > 1 ? data[1] : 0.0f, length > 2 ? data[2] : 0.0f,
    //            length > 3 ? data[3] : 0.0f, length > 4 ? data[4] : 0.0f);
    // }

    free(temp);
}

// 5/3 inverse DWT using lifting scheme (JPEG 2000 reversible filter)
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

// Biorthogonal 2,4 (LeGall 2/4) INVERSE 1D transform
static void dwt_bior24_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(sizeof(float) * length);
    int half = (length + 1) / 2;
    int i;

    int nE = half;
    int nO = length / 2;

    float *even = temp;
    float *odd  = temp + nE;

    // Load L and H
    for (i = 0; i < nE; i++) {
        even[i] = data[i];
    }
    for (i = 0; i < nO; i++) {
        odd[i] = data[half + i];
    }

    // ---- Inverse update: s[i] = s[i] - 0.25*d[i] ----
    for (i = 0; i < nE; i++) {
        float d = (i < nO) ? odd[i] : 0.0f;
        even[i] = even[i] - 0.25f * d;
    }

    // ---- Inverse predict: o[i] = d[i] + 0.5*s[i] ----
    for (i = 0; i < nO; i++) {
        odd[i] = odd[i] + 0.5f * even[i];
    }

    // Interleave back into output
    for (i = 0; i < nO; i++) {
        data[2 * i]     = even[i];
        data[2 * i + 1] = odd[i];
    }
    if (nE > nO) {
        // Trailing even sample for odd length
        data[2 * nO] = even[nO];
    }

    free(temp);
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
    /*static int debug_once = 1;
    if (debug_once) {
        fprintf(stderr, "DWT dimension sequence for %dx%d with %d levels:\n", width, height, levels);
        for (int i = 0; i <= levels; i++) {
            fprintf(stderr, "  Level %d: %dx%d\n", i, widths[i], heights[i]);
        }
        debug_once = 0;
    }*/

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
            // fprintf(stderr, "After level %d (%dx%d): nonzero=%d/%d, data[0]=%.1f, data[1]=%.1f, data[width]=%.1f\n",
            //        level, current_width, current_height, nonzero_level, current_width * current_height,
            //        data[0], data[1], data[width]);

            if (level == 0) first_frame_levels = 0;  // Stop after level 0 of first frame
        }
    }

    // Debug: Check buffer after all levels complete (disabled to reduce stderr output)
    // static int debug_output_once = 1;
    // if (debug_output_once) {
    //     int nonzero_final = 0;
    //     for (int i = 0; i < width * height; i++) {
    //         if (data[i] != 0.0f) nonzero_final++;
    //     }
    //     fprintf(stderr, "After ALL IDWT levels complete: nonzero=%d/%d, first 10: ", nonzero_final, width * height);
    //     for (int i = 0; i < 10 && i < width * height; i++) {
    //         fprintf(stderr, "%.1f ", data[i]);
    //     }
    //     fprintf(stderr, "\n");
    //     debug_output_once = 0;
    // }

    free(widths);
    free(heights);
    free(temp_row);
    free(temp_col);
}

//=============================================================================
// Temporal DWT and GOP Decoding (matches TSVM)
//=============================================================================

// Get temporal subband level for a given frame index in a GOP
static int get_temporal_subband_level(int frame_idx, int num_frames, int temporal_levels) {
    // Match encoder logic exactly (encoder_tav.c:1487-1506)
    // After temporal DWT with N levels, frames are organised as:
    // Frames 0...num_frames/(2^N) = tL...L (N low-passes, coarsest, level 0)
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

// Calculate temporal quantiser scale for a given temporal subband level
static float get_temporal_quantiser_scale(uint8_t encoder_preset, int temporal_level) {
    // Uses exponential scaling: 2^(BETA × level^KAPPA)
    // With BETA=0.6, KAPPA=1.14:
    //   - Level 0 (tLL):  2^0.0 = 1.00
    //   - Level 1 (tH):   2^0.68 = 1.61
    //   - Level 2 (tHH):  2^1.29 = 2.45
    const float BETA = (encoder_preset & 0x01) ? 0.0f : 0.6f;
    const float KAPPA = (encoder_preset & 0x01) ? 1.0f : 1.14f;
    return powf(2.0f, BETA * powf(temporal_level, KAPPA));
}

// Inverse Haar 1D DWT
static void dwt_haar_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    const int half = (length + 1) / 2;

    // Inverse Haar transform: reconstruct from averages and differences
    // Read directly from data array (already has low-pass then high-pass layout)
    for (int i = 0; i < half; i++) {
        if (2 * i + 1 < length) {
            // Reconstruct adjacent pairs from average and difference
            temp[2 * i] = data[i] + data[half + i];      // average + difference
            temp[2 * i + 1] = data[i] - data[half + i];  // average - difference
        } else {
            // Handle odd length: last sample comes from low-pass only
            temp[2 * i] = data[i];
        }
    }

    // Copy reconstructed data back
    for (int i = 0; i < length; i++) {
        data[i] = temp[i];
    }

    free(temp);
}

// Apply inverse 3D DWT to GOP data (spatial + temporal)
// Order: SPATIAL first (each frame), then TEMPORAL (across frames)
static void apply_inverse_3d_dwt(float **gop_y, float **gop_co, float **gop_cg,
                                int width, int height, int gop_size,
                                int spatial_levels, int temporal_levels, int filter_type,
                                int temporal_motion_coder) {
    // Step 1: Apply inverse 2D spatial DWT to each frame
    for (int t = 0; t < gop_size; t++) {
        apply_inverse_dwt_multilevel(gop_y[t], width, height, spatial_levels, filter_type);
        apply_inverse_dwt_multilevel(gop_co[t], width, height, spatial_levels, filter_type);
        apply_inverse_dwt_multilevel(gop_cg[t], width, height, spatial_levels, filter_type);
    }

    // Step 2: Apply inverse temporal DWT to each spatial location
    // Only needed for GOPs with multiple frames (skip for I-frames)
    if (gop_size < 2) return;

    // Pre-calculate all intermediate lengths for temporal DWT (same fix as TAD)
    // This ensures correct reconstruction for non-power-of-2 GOP sizes
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
                    // Use selected temporal wavelet (0=Haar, 1=CDF 5/3)
                    if (temporal_motion_coder == 0) {
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
                    // Use selected temporal wavelet (0=Haar, 1=CDF 5/3)
                    if (temporal_motion_coder == 0) {
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
                    // Use selected temporal wavelet (0=Haar, 1=CDF 5/3)
                    if (temporal_motion_coder == 0) {
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

// Postprocess GOP unified block to per-frame coefficients (2-bit map format)
static int16_t ***postprocess_gop_unified(const uint8_t *decompressed_data, size_t data_size,
                                         int gop_size, int num_pixels, int channel_layout) {
    // 2 bits per coefficient
    const int map_bytes_per_frame = (num_pixels * 2 + 7) / 8;

    // Determine which channels are present
    // Bit 0: has alpha, Bit 1: has chroma (inverted), Bit 2: has luma (inverted)
    const int has_y = (channel_layout & 0x04) == 0;
    const int has_co = (channel_layout & 0x02) == 0;  // Inverted: 0 = has chroma
    const int has_cg = (channel_layout & 0x02) == 0;  // Inverted: 0 = has chroma

    // Calculate buffer positions for maps
    int read_ptr = 0;
    const int y_maps_start = has_y ? read_ptr : -1;
    if (has_y) read_ptr += map_bytes_per_frame * gop_size;

    const int co_maps_start = has_co ? read_ptr : -1;
    if (has_co) read_ptr += map_bytes_per_frame * gop_size;

    const int cg_maps_start = has_cg ? read_ptr : -1;
    if (has_cg) read_ptr += map_bytes_per_frame * gop_size;

    // Count "other" values (code 11) across ALL frames
    int y_other_count = 0;
    int co_other_count = 0;
    int cg_other_count = 0;

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

    // Value arrays start after all maps
    const int y_values_start = read_ptr;
    read_ptr += y_other_count * 2;

    const int co_values_start = read_ptr;
    read_ptr += co_other_count * 2;

    const int cg_values_start = read_ptr;

    // Allocate output arrays: [gop_size][3 channels][num_pixels]
    int16_t ***output = malloc(gop_size * sizeof(int16_t **));
    for (int t = 0; t < gop_size; t++) {
        output[t] = malloc(3 * sizeof(int16_t *));
        output[t][0] = calloc(num_pixels, sizeof(int16_t));  // Y
        output[t][1] = calloc(num_pixels, sizeof(int16_t));  // Co
        output[t][2] = calloc(num_pixels, sizeof(int16_t));  // Cg
    }

    int y_value_idx = 0;
    int co_value_idx = 0;
    int cg_value_idx = 0;

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
                } else {  // code == 3
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
                } else {  // code == 3
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
                } else {  // code == 3
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

// Postprocess GOP RAW format to per-frame coefficients (entropyCoder=2)
// Layout: [All_Y_coeffs][All_Co_coeffs][All_Cg_coeffs] (raw int16 arrays)
static int16_t ***postprocess_gop_raw(const uint8_t *decompressed_data, size_t data_size,
                                     int gop_size, int num_pixels, int channel_layout) {
    // Determine which channels are present
    const int has_y = (channel_layout & 0x04) == 0;
    const int has_co = (channel_layout & 0x02) == 0;
    const int has_cg = (channel_layout & 0x02) == 0;

    // Allocate output arrays: [gop_size][3 channels][num_pixels]
    int16_t ***output = malloc(gop_size * sizeof(int16_t **));
    for (int t = 0; t < gop_size; t++) {
        output[t] = malloc(3 * sizeof(int16_t *));
        output[t][0] = calloc(num_pixels, sizeof(int16_t));  // Y
        output[t][1] = calloc(num_pixels, sizeof(int16_t));  // Co
        output[t][2] = calloc(num_pixels, sizeof(int16_t));  // Cg
    }

    int offset = 0;

    // Read Y channel (all frames concatenated)
    if (has_y) {
        const int channel_size = gop_size * num_pixels * sizeof(int16_t);
        if (offset + channel_size > (int)data_size) {
            fprintf(stderr, "Error: Not enough data for Y channel in RAW GOP\n");
            goto error_cleanup;
        }
        const int16_t *y_data = (const int16_t *)(decompressed_data + offset);
        for (int t = 0; t < gop_size; t++) {
            memcpy(output[t][0], y_data + t * num_pixels, num_pixels * sizeof(int16_t));
        }
        offset += channel_size;
    }

    // Read Co channel (all frames concatenated)
    if (has_co) {
        const int channel_size = gop_size * num_pixels * sizeof(int16_t);
        if (offset + channel_size > (int)data_size) {
            fprintf(stderr, "Error: Not enough data for Co channel in RAW GOP\n");
            goto error_cleanup;
        }
        const int16_t *co_data = (const int16_t *)(decompressed_data + offset);
        for (int t = 0; t < gop_size; t++) {
            memcpy(output[t][1], co_data + t * num_pixels, num_pixels * sizeof(int16_t));
        }
        offset += channel_size;
    }

    // Read Cg channel (all frames concatenated)
    if (has_cg) {
        const int channel_size = gop_size * num_pixels * sizeof(int16_t);
        if (offset + channel_size > (int)data_size) {
            fprintf(stderr, "Error: Not enough data for Cg channel in RAW GOP\n");
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

// Postprocess GOP EZBC format to per-frame coefficients (entropyCoder=1)
// Layout: [frame0_size(4)][frame0_ezbc_data][frame1_size(4)][frame1_ezbc_data]...
// Note: EZBC is a complex embedded bitplane codec - this is a simplified placeholder
// Returns the actual dimensions through output parameters (for crop encoding support)
static int16_t ***postprocess_gop_ezbc(const uint8_t *decompressed_data, size_t data_size,
                                      int gop_size, int num_pixels, int channel_layout,
                                      int *out_width, int *out_height) {
    // First, peek at the first frame's dimensions to determine actual GOP size
    // (with crop encoding, GOP dimensions may be smaller than full frame)
    int actual_width = 0, actual_height = 0;
    int actual_pixels = num_pixels;  // Default to full frame if peek fails

    if (data_size >= 8) {  // Need at least frame size header + some EZBC data
        // Skip first frame's size header to get to EZBC data
        const uint32_t first_frame_size = ((uint32_t)decompressed_data[0]) |
                                         ((uint32_t)decompressed_data[1] << 8) |
                                         ((uint32_t)decompressed_data[2] << 16) |
                                         ((uint32_t)decompressed_data[3] << 24);

        if (4 + first_frame_size <= data_size) {
            if (ezbc_peek_dimensions(decompressed_data + 4, channel_layout,
                                     &actual_width, &actual_height) == 0) {
                actual_pixels = actual_width * actual_height;
                // Only log if dimensions differ significantly (crop encoding active)
                // Suppress repetitive messages by using static counter
                static int crop_log_count = 0;
                if (actual_pixels != num_pixels && crop_log_count < 3) {
                    fprintf(stderr, "[GOP-EZBC] Detected crop encoding: GOP dimensions %dx%d (%d pixels) vs full frame %d pixels\n",
                           actual_width, actual_height, actual_pixels, num_pixels);
                    crop_log_count++;
                    if (crop_log_count == 3) {
                        fprintf(stderr, "[GOP-EZBC] (Further crop encoding messages suppressed)\n");
                    }
                }
            }
        }
    }

    // If we didn't successfully peek dimensions, calculate from num_pixels
    if (actual_width == 0 || actual_height == 0) {
        // Assume square-ish dimensions - this is a fallback, should not happen with proper encoding
        actual_width = (int)sqrt(num_pixels);
        actual_height = num_pixels / actual_width;
        actual_pixels = actual_width * actual_height;
    }

    // Return actual dimensions to caller
    if (out_width) *out_width = actual_width;
    if (out_height) *out_height = actual_height;

    // Allocate output arrays: [gop_size][3 channels][actual_pixels]
    // Use actual GOP dimensions (may be cropped) not full frame size
    int16_t ***output = malloc(gop_size * sizeof(int16_t **));
    for (int t = 0; t < gop_size; t++) {
        output[t] = malloc(3 * sizeof(int16_t *));
        output[t][0] = calloc(actual_pixels, sizeof(int16_t));  // Y
        output[t][1] = calloc(actual_pixels, sizeof(int16_t));  // Co
        output[t][2] = calloc(actual_pixels, sizeof(int16_t));  // Cg
    }

    int offset = 0;

    // Read each frame
    for (int t = 0; t < gop_size; t++) {
        if (offset + 4 > (int)data_size) {
            fprintf(stderr, "Error: Not enough data for frame %d size in EZBC GOP\n", t);
            goto error_cleanup;
        }

        // Read frame size (4 bytes, little-endian)
        const uint32_t frame_size = ((uint32_t)decompressed_data[offset + 0]) |
                                   ((uint32_t)decompressed_data[offset + 1] << 8) |
                                   ((uint32_t)decompressed_data[offset + 2] << 16) |
                                   ((uint32_t)decompressed_data[offset + 3] << 24);
        offset += 4;

        if (offset + frame_size > data_size) {
            fprintf(stderr, "Error: Frame %d EZBC data exceeds buffer (size=%u, available=%zu)\n",
                   t, frame_size, data_size - offset);
            goto error_cleanup;
        }

        // Decode EZBC frame using the single-frame EZBC decoder
        // Pass actual_pixels (cropped size) not num_pixels (full frame size)
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
// YCoCg-R / ICtCp to RGB Conversion (matches TSVM)
//=============================================================================

static void ycocg_r_to_rgb(float y, float co, float cg, uint8_t *r, uint8_t *g, uint8_t *b) {
    float tmp = y - cg / 2.0f;
    float g_val = cg + tmp;
    float b_val = tmp - co / 2.0f;
    float r_val = co + b_val;

    // FIX: Use truncation (not rounding) to match Kotlin decoder behavior
    // Kotlin uses .toInt() which truncates toward zero (floor for positive values)
    *r = CLAMP(roundf(r_val), 0, 255);
    *g = CLAMP(roundf(g_val), 0, 255);
    *b = CLAMP(roundf(b_val), 0, 255);
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
// WAV File Writing
//=============================================================================

static void write_wav_header(FILE *fp, uint32_t sample_rate, uint16_t channels, uint32_t data_size) {
    // RIFF header
    fwrite("RIFF", 1, 4, fp);
    uint32_t file_size = 36 + data_size;
    fwrite(&file_size, 4, 1, fp);
    fwrite("WAVE", 1, 4, fp);

    // fmt chunk
    fwrite("fmt ", 1, 4, fp);
    uint32_t fmt_size = 16;
    fwrite(&fmt_size, 4, 1, fp);
    uint16_t audio_format = 1;  // PCM
    fwrite(&audio_format, 2, 1, fp);
    fwrite(&channels, 2, 1, fp);
    fwrite(&sample_rate, 4, 1, fp);
    uint32_t byte_rate = sample_rate * channels * 1;  // 1 byte per sample (u8)
    fwrite(&byte_rate, 4, 1, fp);
    uint16_t block_align = channels * 1;
    fwrite(&block_align, 2, 1, fp);
    uint16_t bits_per_sample = 8;
    fwrite(&bits_per_sample, 2, 1, fp);

    // data chunk
    fwrite("data", 1, 4, fp);
    fwrite(&data_size, 4, 1, fp);
}

//=============================================================================
// Decoder State Structure
//=============================================================================

// Screen masking entry (letterbox/pillarbox geometry change)
typedef struct {
    uint32_t frame_num;
    uint16_t top;
    uint16_t right;
    uint16_t bottom;
    uint16_t left;
} screen_mask_entry_t;

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
    int temporal_motion_coder;  // Temporal wavelet: 0=Haar, 1=CDF 5/3 (extracted from version)
    int no_grain_synthesis;     // Command-line flag: disable grain synthesis

    // Screen masking (letterbox/pillarbox) - array of geometry changes
    screen_mask_entry_t *screen_masks;
    int screen_mask_count;
    int screen_mask_capacity;
    // Current active mask
    uint16_t screen_mask_top;
    uint16_t screen_mask_right;
    uint16_t screen_mask_bottom;
    uint16_t screen_mask_left;

    // Phase 2: Decoding dimensions (may differ from full frame dimensions per GOP)
    int decoding_width;     // Actual encoded dimensions (cropped active region)
    int decoding_height;    // Updated when Screen Mask packet is encountered
    // Note: Buffers are allocated at max size (header.width × header.height)
    //       but only decoding_width × decoding_height portion is used

    // FFmpeg pipe for video only (audio from file)
    FILE *video_pipe;
    pid_t ffmpeg_pid;

    // Temporary audio file
    char *audio_file_path;
} tav_decoder_t;

//=============================================================================
// Pass 1: Extract Audio to WAV File
//=============================================================================

static int extract_audio_to_wav(const char *input_file, const char *wav_file, int verbose) {
    FILE *input_fp = fopen(input_file, "rb");
    if (!input_fp) {
        fprintf(stderr, "Failed to open input file for audio extraction\n");
        return -1;
    }

    // Read header
    tav_header_t header;
    if (fread(&header, sizeof(tav_header_t), 1, input_fp) != 1) {
        fclose(input_fp);
        return -1;
    }

    // Open temporary audio file
    FILE *wav_fp = fopen(wav_file, "wb");
    if (!wav_fp) {
        fprintf(stderr, "Failed to create temporary audio file\n");
        fclose(input_fp);
        return -1;
    }

    // Write placeholder WAV header (will be updated later)
    write_wav_header(wav_fp, 32000, 2, 0);

    uint32_t total_audio_bytes = 0;
    int packet_count = 0;

    if (verbose) {
        fprintf(stderr, "[Pass 1] Extracting audio to %s...\n", wav_file);
    }

    // Read all packets and extract audio
    while (1) {
        uint8_t packet_type;
        if (fread(&packet_type, 1, 1, input_fp) != 1) {
            break;  // EOF
        }

        packet_count++;

        // Skip non-audio packets
        if (packet_type == TAV_PACKET_SYNC || packet_type == TAV_PACKET_SYNC_NTSC) {
            continue;
        }

        if (packet_type == TAV_PACKET_TIMECODE) {
            fseek(input_fp, 8, SEEK_CUR);  // Skip timecode
            continue;
        }

        if (packet_type == TAV_PACKET_GOP_SYNC) {
            fseek(input_fp, 1, SEEK_CUR);  // Skip frame count
            continue;
        }

        if (packet_type == TAV_PACKET_SCREEN_MASK) {
            fseek(input_fp, 12, SEEK_CUR);  // Skip frame_num(4) + top(2) + right(2) + bottom(2) + left(2)
            continue;
        }

        if (packet_type == TAV_PACKET_GOP_UNIFIED) {
            uint8_t gop_size;
            uint32_t compressed_size;
            fread(&gop_size, 1, 1, input_fp);
            fread(&compressed_size, 4, 1, input_fp);
            fseek(input_fp, compressed_size, SEEK_CUR);  // Skip GOP data
            continue;
        }

        // Handle TAD audio
        if (packet_type == TAV_PACKET_AUDIO_TAD) {
            uint16_t sample_count_wrapper;
            uint32_t payload_size_plus_7;
            fread(&sample_count_wrapper, 2, 1, input_fp);
            fread(&payload_size_plus_7, 4, 1, input_fp);

            uint16_t sample_count_chunk;
            uint8_t quantiser_index;
            uint32_t compressed_size;
            fread(&sample_count_chunk, 2, 1, input_fp);
            fread(&quantiser_index, 1, 1, input_fp);
            fread(&compressed_size, 4, 1, input_fp);

            uint8_t *tad_compressed = malloc(compressed_size);
            fread(tad_compressed, 1, compressed_size, input_fp);

            // Build TAD chunk
            size_t tad_chunk_size = 2 + 1 + 4 + compressed_size;
            uint8_t *tad_chunk = malloc(tad_chunk_size);
            memcpy(tad_chunk, &sample_count_chunk, 2);
            memcpy(tad_chunk + 2, &quantiser_index, 1);
            memcpy(tad_chunk + 3, &compressed_size, 4);
            memcpy(tad_chunk + 7, tad_compressed, compressed_size);
            free(tad_compressed);

            // Decode TAD
            uint8_t *pcmu8_output = malloc(sample_count_chunk * 2);
            size_t bytes_consumed, samples_decoded;
            int decode_result = tad32_decode_chunk(tad_chunk, tad_chunk_size,
                                            pcmu8_output, &bytes_consumed, &samples_decoded);

            if (decode_result >= 0) {
                size_t pcm_bytes = samples_decoded * 2;
                fwrite(pcmu8_output, 1, pcm_bytes, wav_fp);
                total_audio_bytes += pcm_bytes;
            }

            free(tad_chunk);
            free(pcmu8_output);
            continue;
        }

        // Handle PCM8 audio
        if (packet_type == TAV_PACKET_AUDIO_PCM8) {
            uint32_t packet_size;
            fread(&packet_size, 4, 1, input_fp);

            uint8_t *compressed_data = malloc(packet_size);
            fread(compressed_data, 1, packet_size, input_fp);

            // Decompress
            size_t decompressed_bound = ZSTD_getFrameContentSize(compressed_data, packet_size);
            uint8_t *pcm_data = malloc(decompressed_bound);
            size_t decompressed_size = ZSTD_decompress(pcm_data, decompressed_bound,
                                                       compressed_data, packet_size);
            free(compressed_data);

            if (!ZSTD_isError(decompressed_size)) {
                fwrite(pcm_data, 1, decompressed_size, wav_fp);
                total_audio_bytes += decompressed_size;
            }

            free(pcm_data);
            continue;
        }

        // Handle EXTENDED_HDR packet (key-value pairs)
        if (packet_type == TAV_PACKET_EXTENDED_HDR) {
            uint16_t num_pairs;
            fread(&num_pairs, 2, 1, input_fp);
            for (int i = 0; i < num_pairs; i++) {
                fseek(input_fp, 4, SEEK_CUR);  // Skip key (4 bytes)
                uint8_t value_type;
                fread(&value_type, 1, 1, input_fp);
                if (value_type == 0x04) {
                    fseek(input_fp, 8, SEEK_CUR);  // uint64 value
                } else if (value_type == 0x10) {
                    uint16_t str_len;
                    fread(&str_len, 2, 1, input_fp);
                    fseek(input_fp, str_len, SEEK_CUR);  // string value
                }
            }
            continue;
        }

        // Read packet size for standard packets
        uint32_t packet_size;
        if (fread(&packet_size, 4, 1, input_fp) == 1) {
            fseek(input_fp, packet_size, SEEK_CUR);
        }
    }

    // Update WAV header with actual data size
    fseek(wav_fp, 0, SEEK_SET);
    write_wav_header(wav_fp, 32000, 2, total_audio_bytes);

    fclose(wav_fp);
    fclose(input_fp);

    if (verbose) {
        fprintf(stderr, "[Pass 1] Extracted %u bytes of audio (%d packets processed)\n",
               total_audio_bytes, packet_count);
    }

    return 0;
}

//=============================================================================
// Decoder Initialisation and Cleanup
//=============================================================================

static tav_decoder_t* tav_decoder_init(const char *input_file, const char *output_file, const char *audio_file, int no_grain_synthesis) {
    tav_decoder_t *decoder = calloc(1, sizeof(tav_decoder_t));
    if (!decoder) return NULL;

    decoder->no_grain_synthesis = no_grain_synthesis;
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
    // Extract temporal motion coder from version (versions 9-16 use CDF 5/3, 1-8 use Haar)
    decoder->temporal_motion_coder = (decoder->header.version > 8) ? 1 : 0;
    // Extract base version for determining monoblock mode
    uint8_t base_version = (decoder->header.version > 8) ? (decoder->header.version - 8) : decoder->header.version;
    decoder->is_monoblock = (base_version >= 3 && base_version <= 6);
    decoder->audio_file_path = strdup(audio_file);

    // Phase 2: Initialize decoding dimensions to full frame (will be updated by Screen Mask packets)
    decoder->decoding_width = decoder->header.width;
    decoder->decoding_height = decoder->header.height;

    // Allocate buffers
    decoder->current_frame_rgb = calloc(decoder->frame_size * 3, 1);
    decoder->reference_frame_rgb = calloc(decoder->frame_size * 3, 1);
    decoder->dwt_buffer_y = calloc(decoder->frame_size, sizeof(float));
    decoder->dwt_buffer_co = calloc(decoder->frame_size, sizeof(float));
    decoder->dwt_buffer_cg = calloc(decoder->frame_size, sizeof(float));
    decoder->reference_ycocg_y = calloc(decoder->frame_size, sizeof(float));
    decoder->reference_ycocg_co = calloc(decoder->frame_size, sizeof(float));
    decoder->reference_ycocg_cg = calloc(decoder->frame_size, sizeof(float));

    // Create FFmpeg process for video encoding (video pipe only, audio from file)
    int video_pipe_fd[2];
    if (pipe(video_pipe_fd) == -1) {
        fprintf(stderr, "Failed to create video pipe\n");
        free(decoder->current_frame_rgb);
        free(decoder->reference_frame_rgb);
        free(decoder->dwt_buffer_y);
        free(decoder->dwt_buffer_co);
        free(decoder->dwt_buffer_cg);
        free(decoder->reference_ycocg_y);
        free(decoder->reference_ycocg_co);
        free(decoder->reference_ycocg_cg);
        free(decoder->audio_file_path);
        fclose(decoder->input_fp);
        free(decoder);
        return NULL;
    }

    decoder->ffmpeg_pid = fork();
    if (decoder->ffmpeg_pid == -1) {
        fprintf(stderr, "Failed to fork FFmpeg process\n");
        close(video_pipe_fd[0]); close(video_pipe_fd[1]);
        free(decoder->current_frame_rgb);
        free(decoder->reference_frame_rgb);
        free(decoder->dwt_buffer_y);
        free(decoder->dwt_buffer_co);
        free(decoder->dwt_buffer_cg);
        free(decoder->reference_ycocg_y);
        free(decoder->reference_ycocg_co);
        free(decoder->reference_ycocg_cg);
        free(decoder->audio_file_path);
        fclose(decoder->input_fp);
        free(decoder);
        return NULL;
    } else if (decoder->ffmpeg_pid == 0) {
        // Child process - FFmpeg
        close(video_pipe_fd[1]);  // Close write end

        char video_size[32];
        char framerate[16];
        snprintf(video_size, sizeof(video_size), "%dx%d", decoder->header.width, decoder->header.height);
        snprintf(framerate, sizeof(framerate), "%d", decoder->header.fps);

        // Redirect video pipe to fd 3
        dup2(video_pipe_fd[0], 3);  // Video input on fd 3
        close(video_pipe_fd[0]);

        execl("/usr/bin/ffmpeg", "ffmpeg",
              "-f", "rawvideo",
              "-pixel_format", "rgb24",
              "-video_size", video_size,
              "-framerate", framerate,
              "-i", "pipe:3",              // Video from fd 3
              "-i", audio_file,            // Audio from file
              "-color_range", "2",
              "-c:v", "ffv1",              // FFV1 codec
              "-level", "3",               // FFV1 level 3
              "-coder", "1",               // Range coder
              "-context", "1",             // Large context
              "-g", "1",                   // GOP size 1 (all I-frames)
              "-slices", "24",             // 24 slices for threading
              "-slicecrc", "1",            // CRC per slice
              "-pixel_format", "rgb24",    // make FFmpeg encode to RGB
              "-color_range", "2",
              "-c:a", "pcm_u8",            // Audio codec (PCM unsigned 8-bit)
              "-f", "matroska",            // MKV container
              output_file,
              "-y",                        // Overwrite output
              "-v", "warning",             // Minimal logging
              (char*)NULL);

        fprintf(stderr, "Failed to start FFmpeg\n");
        exit(1);
    } else {
        // Parent process
        close(video_pipe_fd[0]);  // Close read end

        decoder->video_pipe = fdopen(video_pipe_fd[1], "wb");

        if (!decoder->video_pipe) {
            fprintf(stderr, "Failed to open video pipe for writing\n");
            kill(decoder->ffmpeg_pid, SIGTERM);
            free(decoder->current_frame_rgb);
            free(decoder->reference_frame_rgb);
            free(decoder->dwt_buffer_y);
            free(decoder->dwt_buffer_co);
            free(decoder->dwt_buffer_cg);
            free(decoder->reference_ycocg_y);
            free(decoder->reference_ycocg_co);
            free(decoder->reference_ycocg_cg);
            free(decoder->audio_file_path);
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
    free(decoder->screen_masks);
    free(decoder->audio_file_path);
    free(decoder);
}

//=============================================================================
// Screen Mask Management
//=============================================================================

// Fill masked regions (letterbox/pillarbox bars) with black
// Phase 2: Composite cropped frame back to full frame with black borders
static uint8_t* composite_to_full_frame(const uint8_t *cropped_rgb,
                                        int cropped_width, int cropped_height,
                                        int full_width, int full_height,
                                        uint16_t top, uint16_t right,
                                        uint16_t bottom, uint16_t left) {
    // Allocate full frame buffer (filled with black)
    uint8_t *full_frame = calloc(full_width * full_height * 3, sizeof(uint8_t));
    if (!full_frame) {
        return NULL;
    }

    // Calculate active region position in full frame
    const int dest_x = left;
    const int dest_y = top;

    // Copy cropped frame into active region
    for (int y = 0; y < cropped_height; y++) {
        for (int x = 0; x < cropped_width; x++) {
            const int src_offset = (y * cropped_width + x) * 3;
            const int dest_offset = ((dest_y + y) * full_width + (dest_x + x)) * 3;

            full_frame[dest_offset + 0] = cropped_rgb[src_offset + 0];  // R
            full_frame[dest_offset + 1] = cropped_rgb[src_offset + 1];  // G
            full_frame[dest_offset + 2] = cropped_rgb[src_offset + 2];  // B
        }
    }

    return full_frame;
}

static void fill_masked_regions(uint8_t *frame_rgb, int width, int height,
                                uint16_t top, uint16_t right, uint16_t bottom, uint16_t left) {
    // Fill top letterbox bar
    for (int y = 0; y < top && y < height; y++) {
        for (int x = 0; x < width; x++) {
            int offset = (y * width + x) * 3;
            frame_rgb[offset] = 255;     // R
            frame_rgb[offset + 1] = 0; // G
            frame_rgb[offset + 2] = 0; // B
        }
    }

    // Fill bottom letterbox bar
    for (int y = height - bottom; y < height; y++) {
        if (y < 0) continue;
        for (int x = 0; x < width; x++) {
            int offset = (y * width + x) * 3;
            frame_rgb[offset] = 255;     // R
            frame_rgb[offset + 1] = 0; // G
            frame_rgb[offset + 2] = 0; // B
        }
    }

    // Fill left pillarbox bar
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < left && x < width; x++) {
            int offset = (y * width + x) * 3;
            frame_rgb[offset] = 0;     // R
            frame_rgb[offset + 1] = 0; // G
            frame_rgb[offset + 2] = 255; // B
        }
    }

    // Fill right pillarbox bar
    for (int y = 0; y < height; y++) {
        for (int x = width - right; x < width; x++) {
            if (x < 0) continue;
            int offset = (y * width + x) * 3;
            frame_rgb[offset] = 0;     // R
            frame_rgb[offset + 1] = 0; // G
            frame_rgb[offset + 2] = 255; // B
        }
    }
}

// Update active screen mask for the given frame number
// Screen mask packets are sorted by frame_num, so we find the last entry
// with frame_num <= current_frame_num
static void update_screen_mask(tav_decoder_t *decoder, uint32_t current_frame_num) {
    if (!decoder->screen_masks || decoder->screen_mask_count == 0) {
        return;  // No screen mask entries
    }

    // Find the most recent screen mask entry for this frame
    // Entries are in order, so scan backwards for efficiency
    for (int i = decoder->screen_mask_count - 1; i >= 0; i--) {
        if (decoder->screen_masks[i].frame_num <= current_frame_num) {
            // Apply this mask
            decoder->screen_mask_top = decoder->screen_masks[i].top;
            decoder->screen_mask_right = decoder->screen_masks[i].right;
            decoder->screen_mask_bottom = decoder->screen_masks[i].bottom;
            decoder->screen_mask_left = decoder->screen_masks[i].left;
            return;
        }
    }
}

//=============================================================================
// Frame Decoding Logic
//=============================================================================

static int decode_i_or_p_frame(tav_decoder_t *decoder, uint8_t packet_type, uint32_t packet_size) {
    // Variable declarations for cleanup
    uint8_t *compressed_data = NULL;
    uint8_t *decompressed_data = NULL;
    int16_t *quantised_y = NULL;
    int16_t *quantised_co = NULL;
    int16_t *quantised_cg = NULL;
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
//    static int decomp_debug = 0;
//    if (decomp_debug < 3) {
//        fprintf(stderr, "  [ZSTD frame %d] Compressed size: %u, buffer size: %zu\n", decomp_debug, packet_size, decompressed_size);
//        fprintf(stderr, "  [ZSTD frame %d] First 16 bytes of COMPRESSED data: ", decomp_debug);
//        for (int i = 0; i < 16 && i < (int)packet_size; i++) {
//            fprintf(stderr, "%02X ", compressed_data[i]);
//        }
//        fprintf(stderr, "\n");
//    }

    size_t actual_size = ZSTD_decompress(decompressed_data, decompressed_size, compressed_data, packet_size);

    if (ZSTD_isError(actual_size)) {
        fprintf(stderr, "Error: ZSTD decompression failed: %s\n", ZSTD_getErrorName(actual_size));
        fprintf(stderr, "  Compressed size: %u, Buffer size: %zu\n", packet_size, decompressed_size);
        decode_success = 0;
        goto write_frame;
    }

//    if (decomp_debug < 3) {
//        fprintf(stderr, "  [ZSTD frame %d] Decompressed size: %zu\n", decomp_debug, actual_size);
//        fprintf(stderr, "  [ZSTD frame %d] First 16 bytes of DECOMPRESSED data: ", decomp_debug);
//        for (int i = 0; i < 16 && i < (int)actual_size; i++) {
//            fprintf(stderr, "%02X ", decompressed_data[i]);
//        }
//        fprintf(stderr, "\n");
//        decomp_debug++;
//    }

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
//    if (decoder->frame_count < 2) {
//        fprintf(stderr, "Frame %d: mode=%d, Q: Y=%d, Co=%d, Cg=%d, decompressed=%zu bytes\n",
//               decoder->frame_count, mode, qy, qco, qcg, actual_size);
//    }

    if (mode == TAV_MODE_SKIP) {
        // Copy from reference frame
        memcpy(decoder->current_frame_rgb, decoder->reference_frame_rgb, decoder->frame_size * 3);
    } else {
        // Decode coefficients (use function-level variables for proper cleanup)
        // Phase 2: Use decoding dimensions (actual encoded size)
        const int decoding_pixels = decoder->decoding_width * decoder->decoding_height;
        int coeff_count = decoding_pixels;
        quantised_y = calloc(coeff_count, sizeof(int16_t));
        quantised_co = calloc(coeff_count, sizeof(int16_t));
        quantised_cg = calloc(coeff_count, sizeof(int16_t));

        if (!quantised_y || !quantised_co || !quantised_cg) {
            fprintf(stderr, "Error: Failed to allocate coefficient buffers\n");
            decode_success = 0;
            goto write_frame;
        }

        // Postprocess coefficients based on entropy_coder value
        if (decoder->header.entropy_coder == 1) {
            // EZBC format (stub implementation)
            postprocess_coefficients_ezbc(ptr, coeff_count, quantised_y, quantised_co, quantised_cg,
                                         decoder->header.channel_layout);
        } else {
            // Default: Twobitmap format (entropy_coder=0)
            postprocess_coefficients_twobit(ptr, coeff_count, quantised_y, quantised_co, quantised_cg);
        }

        // Debug: Check first few coefficients
//        if (decoder->frame_count == 32) {
//            fprintf(stderr, "  First 10 quantised Y coeffs: ");
//            for (int i = 0; i < 10 && i < coeff_count; i++) {
//                fprintf(stderr, "%d ", quantised_y[i]);
//            }
//            fprintf(stderr, "\n");
//
             // Check for any large quantised values that should produce bright pixels
//            int max_quant_y = 0;
//            for (int i = 0; i < coeff_count; i++) {
//                int abs_val = quantised_y[i] < 0 ? -quantised_y[i] : quantised_y[i];
//                if (abs_val > max_quant_y) max_quant_y = abs_val;
//            }
//            fprintf(stderr, "  Max quantised Y coefficient: %d\n", max_quant_y);
//        }

        // Phase 2: Allocate temporary DWT buffers for cropped region processing
        float *temp_dwt_y = calloc(decoding_pixels, sizeof(float));
        float *temp_dwt_co = calloc(decoding_pixels, sizeof(float));
        float *temp_dwt_cg = calloc(decoding_pixels, sizeof(float));

        if (!temp_dwt_y || !temp_dwt_co || !temp_dwt_cg) {
            fprintf(stderr, "Error: Failed to allocate temporary DWT buffers\n");
            free(temp_dwt_y);
            free(temp_dwt_co);
            free(temp_dwt_cg);
            decode_success = 0;
            goto write_frame;
        }

        // Dequantise (perceptual for versions 5-8, uniform for 1-4)
        // Phase 2: Use decoding dimensions and temporary buffers
        // Extract base version for perceptual check
        uint8_t base_version = (decoder->header.version > 8) ? (decoder->header.version - 8) : decoder->header.version;
        const int is_perceptual = (base_version >= 5 && base_version <= 8);
        const int is_ezbc = (decoder->header.entropy_coder == 1);

        if (is_ezbc && is_perceptual) {
            // EZBC mode with perceptual quantisation: coefficients are normalised
            // Need to dequantise using perceptual weights (same as twobit-map mode)
            dequantise_dwt_subbands_perceptual(0, qy, quantised_y, temp_dwt_y,
                                              decoder->decoding_width, decoder->decoding_height,
                                              decoder->header.decomp_levels, qy, 0, decoder->frame_count);
            dequantise_dwt_subbands_perceptual(0, qy, quantised_co, temp_dwt_co,
                                              decoder->decoding_width, decoder->decoding_height,
                                              decoder->header.decomp_levels, qco, 1, decoder->frame_count);
            dequantise_dwt_subbands_perceptual(0, qy, quantised_cg, temp_dwt_cg,
                                              decoder->decoding_width, decoder->decoding_height,
                                              decoder->header.decomp_levels, qcg, 1, decoder->frame_count);
        } else if (is_perceptual) {
            dequantise_dwt_subbands_perceptual(0, qy, quantised_y, temp_dwt_y,
                                              decoder->decoding_width, decoder->decoding_height,
                                              decoder->header.decomp_levels, qy, 0, decoder->frame_count);
            dequantise_dwt_subbands_perceptual(0, qy, quantised_co, temp_dwt_co,
                                              decoder->decoding_width, decoder->decoding_height,
                                              decoder->header.decomp_levels, qco, 1, decoder->frame_count);
            dequantise_dwt_subbands_perceptual(0, qy, quantised_cg, temp_dwt_cg,
                                              decoder->decoding_width, decoder->decoding_height,
                                              decoder->header.decomp_levels, qcg, 1, decoder->frame_count);
        } else {
            for (int i = 0; i < coeff_count; i++) {
                temp_dwt_y[i] = quantised_y[i] * qy;
                temp_dwt_co[i] = quantised_co[i] * qco;
                temp_dwt_cg[i] = quantised_cg[i] * qcg;
            }
        }

        // Debug: Check dequantised values using correct subband layout
//        if (decoder->frame_count == 32) {
//            dwt_subband_info_t subbands[32];
//            const int subband_count = calculate_subband_layout(decoder->header.width, decoder->header.height,
//                                                              decoder->header.decomp_levels, subbands);
//
             // Find LL band (highest level, type 0)
//            for (int s = 0; s < subband_count; s++) {
//                if (subbands[s].level == decoder->header.decomp_levels && subbands[s].subband_type == 0) {
//                    fprintf(stderr, "  LL band: level=%d, start=%d, count=%d\n",
//                           subbands[s].level, subbands[s].coeff_start, subbands[s].coeff_count);
//                    fprintf(stderr, "    Reading LL first 5 from dwt_buffer_y[0-4]: %.1f %.1f %.1f %.1f %.1f\n",
//                           decoder->dwt_buffer_y[0], decoder->dwt_buffer_y[1], decoder->dwt_buffer_y[2],
//                           decoder->dwt_buffer_y[3], decoder->dwt_buffer_y[4]);
//
                     // Find max in CORRECT LL band
//                    float max_ll = -999.0f;
//                    for (int i = 0; i < subbands[s].coeff_count; i++) {
//                        int idx = subbands[s].coeff_start + i;
//                        if (decoder->dwt_buffer_y[idx] > max_ll) max_ll = decoder->dwt_buffer_y[idx];
//                    }
//                    fprintf(stderr, "  Max LL coefficient BEFORE grain removal: %.1f\n", max_ll);
//                    break;
//                }
//            }
//        }

        // Remove grain synthesis from Y channel (must happen after dequantisation, before inverse DWT)
        // Phase 2: Use decoding dimensions and temporary buffer
        apply_grain_synthesis(temp_dwt_y, decoder->decoding_width, decoder->decoding_height,
                                      decoder->header.decomp_levels, decoder->frame_count, decoder->header.quantiser_y,
                                      decoder->header.encoder_preset, decoder->no_grain_synthesis);

        // Debug: Check LL band AFTER grain removal
//        if (decoder->frame_count == 32) {
//            int ll_width = decoder->header.width;
//            int ll_height = decoder->header.height;
//            for (int l = 0; l < decoder->header.decomp_levels; l++) {
//                ll_width = (ll_width + 1) / 2;
//                ll_height = (ll_height + 1) / 2;
//            }
//            float max_ll = -999.0f;
//            for (int i = 0; i < ll_width * ll_height; i++) {
//                if (decoder->dwt_buffer_y[i] > max_ll) max_ll = decoder->dwt_buffer_y[i];
//            }
//            fprintf(stderr, "  Max LL coefficient AFTER grain removal: %.1f\n", max_ll);
//        }

        // Apply inverse DWT with correct non-power-of-2 dimension handling
        // Phase 2: Use decoding dimensions and temporary buffers
        // Note: quantised arrays freed at write_frame label
        apply_inverse_dwt_multilevel(temp_dwt_y, decoder->decoding_width, decoder->decoding_height,
                                   decoder->header.decomp_levels, decoder->header.wavelet_filter);
        apply_inverse_dwt_multilevel(temp_dwt_co, decoder->decoding_width, decoder->decoding_height,
                                   decoder->header.decomp_levels, decoder->header.wavelet_filter);
        apply_inverse_dwt_multilevel(temp_dwt_cg, decoder->decoding_width, decoder->decoding_height,
                                   decoder->header.decomp_levels, decoder->header.wavelet_filter);

        // Debug: Check spatial domain values after IDWT
//        if (decoder->frame_count == 32) {
//            float max_y_spatial = -999.0f;
//            for (int i = 0; i < decoder->frame_size; i++) {
//                if (decoder->dwt_buffer_y[i] > max_y_spatial) max_y_spatial = decoder->dwt_buffer_y[i];
//            }
//            fprintf(stderr, "  Max Y in spatial domain AFTER IDWT: %.1f\n", max_y_spatial);
//        }

        // Debug: Check spatial domain values after IDWT (original debug)
//        if (decoder->frame_count < 1) {
//            fprintf(stderr, "  After IDWT - First 10 Y values: ");
//            for (int i = 0; i < 10 && i < decoder->frame_size; i++) {
//                fprintf(stderr, "%.1f ", decoder->dwt_buffer_y[i]);
//            }
//            fprintf(stderr, "\n");
//            fprintf(stderr, "  Y range: min=%.1f, max=%.1f\n",
//                   decoder->dwt_buffer_y[0], decoder->dwt_buffer_y[decoder->frame_size-1]);
//        }

        // Handle P-frame delta accumulation (in YCoCg float space)
        // TODO Phase 2: P-frame support with crop encoding needs additional work
        //  - Reference frames are stored at full size but delta may be at cropped size
        //  - Need to extract/composite reference region appropriately
        if (packet_type == TAV_PACKET_PFRAME && mode == TAV_MODE_DELTA) {
            fprintf(stderr, "Warning: P-frame delta mode not yet fully supported with crop encoding\n");
            for (int i = 0; i < decoding_pixels; i++) {
                temp_dwt_y[i] += decoder->reference_ycocg_y[i];
                temp_dwt_co[i] += decoder->reference_ycocg_co[i];
                temp_dwt_cg[i] += decoder->reference_ycocg_cg[i];
            }
        }

        // Phase 2: Convert cropped region to RGB, then composite to full frame
        uint8_t *cropped_rgb = malloc(decoding_pixels * 3);
        if (!cropped_rgb) {
            fprintf(stderr, "Error: Failed to allocate cropped RGB buffer\n");
            free(temp_dwt_y);
            free(temp_dwt_co);
            free(temp_dwt_cg);
            decode_success = 0;
            goto write_frame;
        }

        // Convert YCoCg-R/ICtCp to RGB for cropped region
        // Extract base version for ICtCp check (even versions use ICtCp)
        uint8_t base_version_rgb = (decoder->header.version > 8) ? (decoder->header.version - 8) : decoder->header.version;
        const int is_ictcp = (base_version_rgb % 2 == 0);

        for (int i = 0; i < decoding_pixels; i++) {
            uint8_t r, g, b;
            if (is_ictcp) {
                ictcp_to_rgb(temp_dwt_y[i], temp_dwt_co[i], temp_dwt_cg[i], &r, &g, &b);
            } else {
                ycocg_r_to_rgb(temp_dwt_y[i], temp_dwt_co[i], temp_dwt_cg[i], &r, &g, &b);
            }

            // RGB byte order for FFmpeg rgb24
            cropped_rgb[i * 3 + 0] = r;
            cropped_rgb[i * 3 + 1] = g;
            cropped_rgb[i * 3 + 2] = b;
        }

        // Composite cropped frame to full frame with black borders
        uint8_t *full_frame_rgb = composite_to_full_frame(cropped_rgb,
                                                           decoder->decoding_width, decoder->decoding_height,
                                                           decoder->header.width, decoder->header.height,
                                                           decoder->screen_mask_top, decoder->screen_mask_right,
                                                           decoder->screen_mask_bottom, decoder->screen_mask_left);
        free(cropped_rgb);
        free(temp_dwt_y);
        free(temp_dwt_co);
        free(temp_dwt_cg);

        if (!full_frame_rgb) {
            fprintf(stderr, "Error: Failed to composite frame to full size\n");
            decode_success = 0;
            goto write_frame;
        }

        // Copy composited frame to decoder buffer
        memcpy(decoder->current_frame_rgb, full_frame_rgb, decoder->frame_size * 3);
        free(full_frame_rgb);

//        if (decoder->frame_count == 1000) {
//            fprintf(stderr, "\n=== Frame 1000 Value Analysis ===\n");
//            fprintf(stderr, "Max YCoCg values: Y=%.1f, Co=%.1f, Cg=%.1f\n", max_y, max_co, max_cg);
//            fprintf(stderr, "Max RGB values: R=%d, G=%d, B=%d\n", max_r, max_g, max_b);
//        }

        // Debug: Check RGB output
//        if (decoder->frame_count < 1) {
//            fprintf(stderr, "  First 5 pixels RGB: ");
//            for (int i = 0; i < 5 && i < decoder->frame_size; i++) {
//                fprintf(stderr, "(%d,%d,%d) ",
//                       decoder->current_frame_rgb[i*3],
//                       decoder->current_frame_rgb[i*3+1],
//                       decoder->current_frame_rgb[i*3+2]);
//            }
//            fprintf(stderr, "\n");
//        }

        // TODO Phase 2: Reference YCoCg frame update needs rework for crop encoding
        // Currently not updated because we use temporary buffers that are already freed
        // P-frame support will need to store reference at appropriate dimensions
        // memcpy(decoder->reference_ycocg_y, temp_dwt_y, decoding_pixels * sizeof(float));
        // memcpy(decoder->reference_ycocg_co, temp_dwt_co, decoding_pixels * sizeof(float));
        // memcpy(decoder->reference_ycocg_cg, temp_dwt_cg, decoding_pixels * sizeof(float));
    }

    // Update reference frame
    memcpy(decoder->reference_frame_rgb, decoder->current_frame_rgb, decoder->frame_size * 3);

write_frame:
    // Clean up temporary allocations
    if (compressed_data) free(compressed_data);
    if (decompressed_data) free(decompressed_data);
    if (quantised_y) free(quantised_y);
    if (quantised_co) free(quantised_co);
    if (quantised_cg) free(quantised_cg);

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
    printf("  -i <file>              Input TAV file\n");
    printf("  -o <file>              Output MKV file (optional, auto-generated from input)\n");
    printf("  -v                     Verbose output\n");
    printf("  --no-grain-synthesis   Disable grain synthesis (override encoder preset)\n");
    printf("  -h, --help             Show this help\n\n");
    printf("Supported features (matches TSVM decoder):\n");
    printf("  - I-frames and P-frames (delta mode)\n");
    printf("  - GOP unified 3D DWT (temporal compression)\n");
    printf("  - TAD audio (decoded to PCMu8)\n");
    printf("  - MP2 audio (passed through)\n");
    printf("  - All wavelet types (5/3, 9/7, CDF 13/7, DD-4, Haar)\n");
    printf("  - Perceptual quantisation (versions 5-8)\n");
    printf("  - YCoCg-R and ICtCp color spaces\n\n");
    printf("Unsupported features (not in TSVM decoder):\n");
    printf("  - MC-EZBC motion compensation\n");
    printf("  - MPEG-style residual coding (P/B-frames)\n");
    printf("  - Adaptive block partitioning\n\n");
}

int main(int argc, char *argv[]) {
    // Ignore SIGPIPE to prevent process termination if FFmpeg exits early
    signal(SIGPIPE, SIG_IGN);

    // Initialize AVX-512 runtime detection
    tav_simd_init();

    char *input_file = NULL;
    char *output_file = NULL;
    int verbose = 0;
    int no_grain_synthesis = 0;

    static struct option long_options[] = {
        {"help", no_argument, 0, 'h'},
        {"no-grain-synthesis", no_argument, 0, 1000},
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
            case 1000:  // --no-grain-synthesis
                no_grain_synthesis = 1;
                if (verbose) {
                    printf("Grain synthesis disabled\n");
                }
                break;
            default:
                print_usage(argv[0]);
                return 1;
        }
    }

    if (!input_file) {
        fprintf(stderr, "Error: Input file is required\n\n");
        print_usage(argv[0]);
        return 1;
    }

    // Generate output filename if not provided
    if (!output_file) {
        size_t input_len = strlen(input_file);
        output_file = malloc(input_len + 32);  // Extra space for extension

        // Find the last directory separator
        const char *basename_start = strrchr(input_file, '/');
        if (!basename_start) basename_start = strrchr(input_file, '\\');
        basename_start = basename_start ? basename_start + 1 : input_file;

        // Copy directory part
        size_t dir_len = basename_start - input_file;
        strncpy(output_file, input_file, dir_len);

        // Find the .tad extension
        const char *ext = strrchr(basename_start, '.');
        if (ext && (strcmp(ext, ".tav") == 0 || strcmp(ext, ".mv3") == 0)) {
            // Copy basename without .tav or .mv3
            size_t name_len = ext - basename_start;
            strncpy(output_file + dir_len, basename_start, name_len);
            output_file[dir_len + name_len] = '\0';
        } else {
            // No .tad extension, copy entire basename
            strcpy(output_file + dir_len, basename_start);
        }

        // Append appropriate extension
        strcat(output_file, ".mkv");

        if (verbose) {
            printf("Auto-generated output path: %s\n", output_file);
        }
    }

    // Create temporary audio file path
    char temp_audio_file[256];
    snprintf(temp_audio_file, sizeof(temp_audio_file), "/tmp/tav_audio_%d.wav", getpid());

    // Pass 1: Extract audio to WAV file
    if (extract_audio_to_wav(input_file, temp_audio_file, verbose) < 0) {
        fprintf(stderr, "Failed to extract audio\n");
        unlink(temp_audio_file);  // Clean up temp file if it exists
        return 1;
    }

    // Pass 2: Decode video with audio file
    tav_decoder_t *decoder = tav_decoder_init(input_file, output_file, temp_audio_file, no_grain_synthesis);
    if (!decoder) {
        fprintf(stderr, "Failed to initialise decoder\n");
        unlink(temp_audio_file);  // Clean up temp file
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

    // Start timing for FPS calculation
    struct timeval start_time, last_update_time;
    gettimeofday(&start_time, NULL);
    last_update_time = start_time;
    int frames_since_last_update = 0;

    // Main decoding loop
    int result = 1;
    int total_packets = 0;
    int iframe_count = 0;
    while (result > 0) {
        // Check file position before reading packet
        long file_pos = ftell(decoder->input_fp);

        uint8_t packet_type;
        if (fread(&packet_type, 1, 1, decoder->input_fp) != 1) {
            if (verbose) {
                fprintf(stderr, "Reached EOF at file position %ld after %d packets\n", file_pos, total_packets);
            }
            result = 0; // EOF
            break;
        }

        total_packets++;

        if (verbose && total_packets <= 30) {
            fprintf(stderr, "Packet %d at file pos %ld: Type 0x%02X\n", total_packets, file_pos, packet_type);
        }

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
            uint8_t gop_frame_count;
            if (fread(&gop_frame_count, 1, 1, decoder->input_fp) != 1) {
                fprintf(stderr, "Error: Failed to read GOP sync frame count\n");
                result = -1;
                break;
            }
            if (verbose) {
                fprintf(stderr, "Packet %d: GOP_SYNC (0x%02X) - %u frames from GOP\n",
                       total_packets, packet_type, gop_frame_count);
            }
            // Update decoder frame count (GOP already wrote frames)
            decoder->frame_count += gop_frame_count;
            frames_since_last_update += gop_frame_count;

            // Print progress every second or so
            struct timeval current_time;
            gettimeofday(&current_time, NULL);
            double time_since_update = (current_time.tv_sec - last_update_time.tv_sec) +
                                     (current_time.tv_usec - last_update_time.tv_usec) / 1000000.0;

            if (time_since_update >= 1.0 || decoder->frame_count == gop_frame_count) {  // Update every second
                double total_time = (current_time.tv_sec - start_time.tv_sec) +
                                  (current_time.tv_usec - start_time.tv_usec) / 1000000.0;
                double current_fps = frames_since_last_update / time_since_update;
                double avg_fps = decoder->frame_count / total_time;

                fprintf(stderr, "\rDecoding: Frame %d (%.1f fps, avg %.1f fps)    ",
                       decoder->frame_count, current_fps, avg_fps);
                fflush(stderr);

                last_update_time = current_time;
                frames_since_last_update = 0;
            }

            continue;
        }

        // Handle screen masking packets (letterbox/pillarbox detection)
        // Format: frame_num(4) + top(2) + right(2) + bottom(2) + left(2) = 12 bytes
        if (packet_type == TAV_PACKET_SCREEN_MASK) {
            uint32_t frame_num;
            uint16_t top, right, bottom, left;
            if (fread(&frame_num, 4, 1, decoder->input_fp) != 1 ||
                fread(&top, 2, 1, decoder->input_fp) != 1 ||
                fread(&right, 2, 1, decoder->input_fp) != 1 ||
                fread(&bottom, 2, 1, decoder->input_fp) != 1 ||
                fread(&left, 2, 1, decoder->input_fp) != 1) {
                fprintf(stderr, "Error: Failed to read screen mask packet\n");
                result = -1;
                break;
            }

            // Allocate array if needed
            if (decoder->screen_masks == NULL) {
                decoder->screen_mask_capacity = 16;
                decoder->screen_masks = malloc(decoder->screen_mask_capacity * sizeof(screen_mask_entry_t));
                decoder->screen_mask_count = 0;
            }

            // Expand array if needed
            if (decoder->screen_mask_count >= decoder->screen_mask_capacity) {
                decoder->screen_mask_capacity *= 2;
                decoder->screen_masks = realloc(decoder->screen_masks,
                                               decoder->screen_mask_capacity * sizeof(screen_mask_entry_t));
            }

            // Store entry
            screen_mask_entry_t *entry = &decoder->screen_masks[decoder->screen_mask_count++];
            entry->frame_num = frame_num;
            entry->top = top;
            entry->right = right;
            entry->bottom = bottom;
            entry->left = left;

            // Phase 2: Update current active mask and decoding dimensions
            decoder->screen_mask_top = top;
            decoder->screen_mask_right = right;
            decoder->screen_mask_bottom = bottom;
            decoder->screen_mask_left = left;

            // Calculate new decoding dimensions (active region size)
            decoder->decoding_width = decoder->header.width - left - right;
            decoder->decoding_height = decoder->header.height - top - bottom;

            if (verbose) {
                fprintf(stderr, "Packet %d: SCREEN_MASK (0x%02X) - frame=%u top=%u right=%u bottom=%u left=%u (decoding: %dx%d)\n",
                       total_packets, packet_type, frame_num, top, right, bottom, left,
                       decoder->decoding_width, decoder->decoding_height);
            }
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

            if (verbose) {
                fprintf(stderr, "Packet %d: GOP_UNIFIED (0x%02X), %u frames, %u bytes\n",
                       total_packets, packet_type, gop_size, compressed_size);
            }

            // Read compressed GOP data
            uint8_t *compressed_data = malloc(compressed_size);
            if (!compressed_data) {
                fprintf(stderr, "Error: Failed to allocate GOP compressed buffer (%u bytes)\n", compressed_size);
                result = -1;
                break;
            }

            if (fread(compressed_data, 1, compressed_size, decoder->input_fp) != compressed_size) {
                fprintf(stderr, "Error: Failed to read GOP compressed data\n");
                free(compressed_data);
                result = -1;
                break;
            }

            // Decompress with Zstd
            const size_t decompressed_bound = ZSTD_getFrameContentSize(compressed_data, compressed_size);
            if (decompressed_bound == ZSTD_CONTENTSIZE_ERROR || decompressed_bound == ZSTD_CONTENTSIZE_UNKNOWN) {
                fprintf(stderr, "Error: Invalid Zstd frame in GOP data\n");
                free(compressed_data);
                result = -1;
                break;
            }

            uint8_t *decompressed_data = malloc(decompressed_bound);
            if (!decompressed_data) {
                fprintf(stderr, "Error: Failed to allocate GOP decompressed buffer (%zu bytes)\n", decompressed_bound);
                free(compressed_data);
                result = -1;
                break;
            }

            const size_t decompressed_size = ZSTD_decompress(decompressed_data, decompressed_bound,
                                                            compressed_data, compressed_size);
            free(compressed_data);

            if (ZSTD_isError(decompressed_size)) {
                fprintf(stderr, "Error: Zstd decompression failed: %s\n", ZSTD_getErrorName(decompressed_size));
                free(decompressed_data);
                result = -1;
                break;
            }

            // Postprocess coefficients based on entropy_coder value
            // Phase 2: Use decoding dimensions (actual encoded size) for postprocessing
            int decoding_pixels = decoder->decoding_width * decoder->decoding_height;
            // Keep full frame size for buffer allocation
            const int num_pixels = decoder->header.width * decoder->header.height;
            int16_t ***quantised_gop;

            // GOP dimensions (may differ from full frame with crop encoding)
            int gop_width = decoder->decoding_width;
            int gop_height = decoder->decoding_height;

            if (decoder->header.entropy_coder == 2) {
                // RAW format: simple concatenated int16 arrays
                if (verbose) {
                    fprintf(stderr, "  Using RAW postprocessing (entropy_coder=2) for %dx%d (%d pixels)\n",
                           decoder->decoding_width, decoder->decoding_height, decoding_pixels);
                }
                quantised_gop = postprocess_gop_raw(decompressed_data, decompressed_size,
                                                   gop_size, num_pixels, decoder->header.channel_layout);
            } else if (decoder->header.entropy_coder == 1) {
                // EZBC format: embedded zero-block coding
                if (verbose) {
                    fprintf(stderr, "  Using EZBC postprocessing (entropy_coder=1) for %dx%d (%d pixels)\n",
                           decoder->decoding_width, decoder->decoding_height, decoding_pixels);
                }
                // EZBC will return actual GOP dimensions (may be cropped with crop encoding)
                quantised_gop = postprocess_gop_ezbc(decompressed_data, decompressed_size,
                                                    gop_size, num_pixels, decoder->header.channel_layout,
                                                    &gop_width, &gop_height);
                // Update decoding_pixels to match actual GOP dimensions
                if (gop_width > 0 && gop_height > 0) {
                    decoding_pixels = gop_width * gop_height;
                    if (verbose) {
                        fprintf(stderr, "  Actual GOP dimensions from EZBC: %dx%d (%d pixels)\n",
                               gop_width, gop_height, decoding_pixels);
                    }
                }
            } else {
                // Default: Twobitmap format (entropy_coder=0)
                if (verbose) {
                    fprintf(stderr, "  Using Twobitmap postprocessing (entropy_coder=0) for %dx%d (%d pixels)\n",
                           decoder->decoding_width, decoder->decoding_height, decoding_pixels);
                }
                quantised_gop = postprocess_gop_unified(decompressed_data, decompressed_size,
                                                       gop_size, num_pixels, decoder->header.channel_layout);
            }

            free(decompressed_data);

            if (!quantised_gop) {
                fprintf(stderr, "Error: Failed to postprocess GOP data\n");
                result = -1;
                break;
            }

            // Allocate GOP float buffers
            // Phase 2: Allocate at decoding size (cropped region), will composite to full frame later
            float **gop_y = malloc(gop_size * sizeof(float *));
            float **gop_co = malloc(gop_size * sizeof(float *));
            float **gop_cg = malloc(gop_size * sizeof(float *));

            for (int t = 0; t < gop_size; t++) {
                gop_y[t] = calloc(decoding_pixels, sizeof(float));
                gop_co[t] = calloc(decoding_pixels, sizeof(float));
                gop_cg[t] = calloc(decoding_pixels, sizeof(float));
            }

            // Dequantise with temporal scaling (perceptual quantisation for versions 5-8)
            // Extract base version for perceptual check
            uint8_t base_version_gop = (decoder->header.version > 8) ? (decoder->header.version - 8) : decoder->header.version;
            const int is_perceptual = (base_version_gop >= 5 && base_version_gop <= 8);
            const int is_ezbc = (decoder->header.entropy_coder == 1);
            const int temporal_levels = 2;  // Fixed for TAV GOP encoding

            for (int t = 0; t < gop_size; t++) {
                if (is_ezbc && is_perceptual) {
                    // EZBC mode with perceptual quantisation: coefficients are normalised
                    // Need to dequantise using perceptual weights (same as twobit-map mode)
                    const int temporal_level = get_temporal_subband_level(t, gop_size, temporal_levels);
                    const float temporal_scale = get_temporal_quantiser_scale(decoder->header.encoder_preset, temporal_level);

                    // FIX: Use QLUT to convert header quantiser indices to actual values
                    const float base_q_y = roundf(QLUT[decoder->header.quantiser_y] * temporal_scale);
                    const float base_q_co = roundf(QLUT[decoder->header.quantiser_co] * temporal_scale);
                    const float base_q_cg = roundf(QLUT[decoder->header.quantiser_cg] * temporal_scale);

                    // Phase 2: Use GOP dimensions (may be cropped) for dequantisation
                    dequantise_dwt_subbands_perceptual(0, QLUT[decoder->header.quantiser_y],
                                                      quantised_gop[t][0], gop_y[t],
                                                      gop_width, gop_height,
                                                      decoder->header.decomp_levels, base_q_y, 0, decoder->frame_count + t);
                    dequantise_dwt_subbands_perceptual(0, QLUT[decoder->header.quantiser_y],
                                                      quantised_gop[t][1], gop_co[t],
                                                      gop_width, gop_height,
                                                      decoder->header.decomp_levels, base_q_co, 1, decoder->frame_count + t);
                    dequantise_dwt_subbands_perceptual(0, QLUT[decoder->header.quantiser_y],
                                                      quantised_gop[t][2], gop_cg[t],
                                                      gop_width, gop_height,
                                                      decoder->header.decomp_levels, base_q_cg, 1, decoder->frame_count + t);

                    if (t == 0 && verbose) {
                        // Debug: Check multiple LL values
                        fprintf(stderr, "[GOP-EZBC] Frame 0 after dequant:\n");
                        fprintf(stderr, "  Quantised: LL[0]=%d, LL[1]=%d, LL[2]=%d\n",
                               quantised_gop[t][0][0], quantised_gop[t][0][1], quantised_gop[t][0][2]);
                        fprintf(stderr, "  Dequantised: LL[0]=%.1f, LL[1]=%.1f, LL[2]=%.1f\n",
                               gop_y[t][0], gop_y[t][1], gop_y[t][2]);
                        fprintf(stderr, "  base_q_y=%.1f, temporal_level=%d, temporal_scale=%.3f\n",
                               base_q_y, temporal_level, temporal_scale);
                    }
                } else if (!is_ezbc) {
                    // Normal mode: multiply by quantiser
                    const int temporal_level = get_temporal_subband_level(t, gop_size, temporal_levels);
                    const float temporal_scale = get_temporal_quantiser_scale(decoder->header.encoder_preset, temporal_level);

                    // CRITICAL: Must ROUND temporal quantiser to match encoder's roundf() behavior
                    // FIX: Use QLUT to convert header quantiser indices to actual values
                    const float base_q_y = roundf(QLUT[decoder->header.quantiser_y] * temporal_scale);
                    const float base_q_co = roundf(QLUT[decoder->header.quantiser_co] * temporal_scale);
                    const float base_q_cg = roundf(QLUT[decoder->header.quantiser_cg] * temporal_scale);

                    if (is_perceptual) {
                        // Phase 2: Use GOP dimensions (may be cropped) for dequantisation
                        dequantise_dwt_subbands_perceptual(0, QLUT[decoder->header.quantiser_y],
                                                          quantised_gop[t][0], gop_y[t],
                                                          gop_width, gop_height,
                                                          decoder->header.decomp_levels, base_q_y, 0, decoder->frame_count + t);
                        dequantise_dwt_subbands_perceptual(0, QLUT[decoder->header.quantiser_y],
                                                          quantised_gop[t][1], gop_co[t],
                                                          gop_width, gop_height,
                                                          decoder->header.decomp_levels, base_q_co, 1, decoder->frame_count + t);
                        dequantise_dwt_subbands_perceptual(0, QLUT[decoder->header.quantiser_y],
                                                          quantised_gop[t][2], gop_cg[t],
                                                          gop_width, gop_height,
                                                          decoder->header.decomp_levels, base_q_cg, 1, decoder->frame_count + t);
                    } else {
                        // Uniform quantisation for older versions
                        // Phase 2: Use decoding_pixels for uniform dequantisation
                        for (int i = 0; i < decoding_pixels; i++) {
                            gop_y[t][i] = quantised_gop[t][0][i] * base_q_y;
                            gop_co[t][i] = quantised_gop[t][1][i] * base_q_co;
                            gop_cg[t][i] = quantised_gop[t][2][i] * base_q_cg;
                        }
                    }
                }
            }

            // Free quantised coefficients
            for (int t = 0; t < gop_size; t++) {
                free(quantised_gop[t][0]);
                free(quantised_gop[t][1]);
                free(quantised_gop[t][2]);
                free(quantised_gop[t]);
            }
            free(quantised_gop);


            // Phase 2: Use GOP dimensions (may be cropped) for grain removal
            for (int t = 0; t < gop_size; t++) {
                apply_grain_synthesis(gop_y[t], gop_width, gop_height,
                                              decoder->header.decomp_levels, decoder->frame_count + t,
                                              decoder->header.quantiser_y, decoder->header.encoder_preset,
                                              decoder->no_grain_synthesis);
            }

            // Apply inverse 3D DWT (spatial + temporal)
            // Phase 2: Use GOP dimensions (may be cropped) for inverse DWT
            apply_inverse_3d_dwt(gop_y, gop_co, gop_cg, gop_width, gop_height,
                               gop_size, decoder->header.decomp_levels, temporal_levels,
                               decoder->header.wavelet_filter, decoder->temporal_motion_coder);

            // Debug: Check Y values after inverse DWT
            if (verbose && decoder->frame_count == 0) {
                fprintf(stderr, "[GOP-DEBUG] After inverse 3D DWT: Frame 0 Y[0]=%.1f, Y[1]=%.1f, Y[2]=%.1f\n",
                       gop_y[0][0], gop_y[0][1], gop_y[0][2]);
            }

            // Debug: Check spatial coefficients after inverse temporal DWT (before inverse spatial DWT)
//            if (is_ezbc) {
//                float max_y = 0.0f, min_y = 0.0f;
//                for (int i = 0; i < num_pixels; i++) {
//                    if (gop_y[0][i] > max_y) max_y = gop_y[0][i];
//                    if (gop_y[0][i] < min_y) min_y = gop_y[0][i];
//                }
//                fprintf(stderr, "[GOP-EZBC] After inverse temporal DWT, Frame 0 Y spatial coeffs range: [%.1f, %.1f], first 5: %.1f %.1f %.1f %.1f %.1f\n",
//                       min_y, max_y,
//                       gop_y[0][0], gop_y[0][1], gop_y[0][2], gop_y[0][3], gop_y[0][4]);
//            }

            // Convert YCoCg→RGB and write all GOP frames
            const int is_ictcp = (decoder->header.version % 2 == 0);

            // DEBUG: Print frame size calculation
//            if (decoder->frame_count == 0) {
//                fprintf(stderr, "[DEBUG] decoder->frame_size=%d, decoder->header.width=%d, decoder->header.height=%d\n",
//                       decoder->frame_size, decoder->header.width, decoder->header.height);
//                fprintf(stderr, "[DEBUG] bytes_to_write=%zu (should be %d)\n",
//                       (size_t)decoder->frame_size * 3, decoder->header.width * decoder->header.height * 3);
//            }

            // Calculate consistent screen mask offsets for crop-encoded GOPs
            // When crop encoding is active, all frames in GOP use same dimensions
            const int is_crop_encoded = (gop_width != decoder->header.width ||
                                        gop_height != decoder->header.height);
            uint16_t gop_mask_top = 0, gop_mask_bottom = 0, gop_mask_left = 0, gop_mask_right = 0;

            if (is_crop_encoded) {
                // Center the cropped region in the full frame
                if (gop_height < decoder->header.height) {
                    gop_mask_top = (decoder->header.height - gop_height) / 2;
                    gop_mask_bottom = decoder->header.height - gop_height - gop_mask_top;
                }
                if (gop_width < decoder->header.width) {
                    gop_mask_left = (decoder->header.width - gop_width) / 2;
                    gop_mask_right = decoder->header.width - gop_width - gop_mask_left;
                }
                if (verbose && decoder->frame_count == 0) {
                    fprintf(stderr, "[GOP-Crop] Centering %dx%d in %dx%d: top=%u, bottom=%u, left=%u, right=%u\n",
                           gop_width, gop_height, decoder->header.width, decoder->header.height,
                           gop_mask_top, gop_mask_bottom, gop_mask_left, gop_mask_right);
                }
            }

            for (int t = 0; t < gop_size; t++) {
                // Update screen mask only if NOT crop-encoded
                // Crop-encoded GOPs use consistent offsets calculated above
                if (!is_crop_encoded) {
                    update_screen_mask(decoder, decoder->frame_count + t);
                }

                // Phase 2: Convert cropped region to RGB, then composite to full frame
                uint8_t *cropped_rgb = malloc(decoding_pixels * 3);
                if (!cropped_rgb) {
                    fprintf(stderr, "Error: Failed to allocate cropped GOP frame buffer\n");
                    result = -1;
                    break;
                }

                // Convert cropped region to RGB
                for (int i = 0; i < decoding_pixels; i++) {
                    uint8_t r, g, b;
                    if (is_ictcp) {
                        ictcp_to_rgb(gop_y[t][i], gop_co[t][i], gop_cg[t][i], &r, &g, &b);
                    } else {
                        ycocg_r_to_rgb(gop_y[t][i], gop_co[t][i], gop_cg[t][i], &r, &g, &b);
                    }
                    cropped_rgb[i * 3 + 0] = r;
                    cropped_rgb[i * 3 + 1] = g;
                    cropped_rgb[i * 3 + 2] = b;
                }

                // Composite cropped frame to full frame with black borders
                // Use GOP-consistent offsets for crop-encoded, or per-frame offsets otherwise
                const uint16_t mask_top = is_crop_encoded ? gop_mask_top : decoder->screen_mask_top;
                const uint16_t mask_bottom = is_crop_encoded ? gop_mask_bottom : decoder->screen_mask_bottom;
                const uint16_t mask_left = is_crop_encoded ? gop_mask_left : decoder->screen_mask_left;
                const uint16_t mask_right = is_crop_encoded ? gop_mask_right : decoder->screen_mask_right;

                uint8_t *frame_rgb = composite_to_full_frame(cropped_rgb,
                                                             gop_width, gop_height,
                                                             decoder->header.width, decoder->header.height,
                                                             mask_top, mask_right, mask_bottom, mask_left);
                free(cropped_rgb);

                if (!frame_rgb) {
                    fprintf(stderr, "Error: Failed to composite GOP frame to full size\n");
                    result = -1;
                    break;
                }

                // Note: Phase 1 fill_masked_regions() is now replaced by Phase 2 composite function
                // which places the decoded cropped frame into a full-frame buffer with black borders

                // Write frame to FFmpeg video pipe
                const size_t bytes_to_write = decoder->frame_size * 3;

                // DEBUG: Verify we're writing to correct pipe
//                if (decoder->frame_count == 0 && t == 0) {
//                    fprintf(stderr, "[DEBUG] Writing frame to video_pipe=%p, bytes_to_write=%zu\n",
//                           (void*)decoder->video_pipe, bytes_to_write);
//                    fprintf(stderr, "[DEBUG] First 10 RGB bytes: %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X\n",
//                           frame_rgb[0], frame_rgb[1], frame_rgb[2], frame_rgb[3], frame_rgb[4],
//                           frame_rgb[5], frame_rgb[6], frame_rgb[7], frame_rgb[8], frame_rgb[9]);
//                }

                const size_t bytes_written = fwrite(frame_rgb, 1, bytes_to_write, decoder->video_pipe);
                if (bytes_written != bytes_to_write) {
                    fprintf(stderr, "Error: Failed to write GOP frame %d to FFmpeg (wrote %zu/%zu bytes)\n",
                           t, bytes_written, bytes_to_write);
                    free(frame_rgb);
                    result = -1;
                    break;
                }
                fflush(decoder->video_pipe);

                free(frame_rgb);
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

            // BUGFIX: Only break on error (result < 0), not on success (result = 1)
            if (result < 0) break;

            // GOP decoding doesn't update frame_count here - GOP_SYNC packet will do it
            if (verbose) {
                long pos_after_gop = ftell(decoder->input_fp);
                fprintf(stderr, "[DEBUG] After GOP: file pos = %ld, %d frames written (waiting for GOP_SYNC)\n",
                       pos_after_gop, gop_size);
            }

            continue;
        }

        // Handle TAD audio packets (already extracted in Pass 1, just skip)
        if (packet_type == TAV_PACKET_AUDIO_TAD) {
            uint16_t sample_count_wrapper;
            uint32_t payload_size_plus_7;
            fread(&sample_count_wrapper, 2, 1, decoder->input_fp);
            fread(&payload_size_plus_7, 4, 1, decoder->input_fp);

            // Skip TAD chunk (payload_size_plus_7 includes header and data)
            fseek(decoder->input_fp, payload_size_plus_7, SEEK_CUR);
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
                // Update active screen mask for this frame (Phase 1: just tracking, not applying)
                update_screen_mask(decoder, decoder->frame_count);

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

                // Update progress indicator
                frames_since_last_update++;
                struct timeval current_time;
                gettimeofday(&current_time, NULL);
                double time_since_update = (current_time.tv_sec - last_update_time.tv_sec) +
                                         (current_time.tv_usec - last_update_time.tv_usec) / 1000000.0;

                if (time_since_update >= 1.0 || decoder->frame_count == 1) {  // Update every second
                    double total_time = (current_time.tv_sec - start_time.tv_sec) +
                                      (current_time.tv_usec - start_time.tv_usec) / 1000000.0;
                    double current_fps = frames_since_last_update / time_since_update;
                    double avg_fps = decoder->frame_count / total_time;

                    fprintf(stderr, "\rDecoding: Frame %d (%.1f fps, avg %.1f fps)    ",
                           decoder->frame_count, current_fps, avg_fps);
                    fflush(stderr);

                    last_update_time = current_time;
                    frames_since_last_update = 0;
                }

                break;

            case TAV_PACKET_AUDIO_MP2:
            case TAV_PACKET_AUDIO_TRACK:
                // MP2 audio - write directly to audio pipe
                // Note: FFmpeg cannot decode MP2 from raw stream, so we skip for now
                if (verbose && total_packets < 20) {
                    fprintf(stderr, "Skipping MP2 audio packet (%u bytes) - not yet supported\n", packet_size);
                }
                fseek(decoder->input_fp, packet_size, SEEK_CUR);
                break;

            case TAV_PACKET_AUDIO_PCM8:
                // PCM8 audio - already extracted in Pass 1, just skip
                fseek(decoder->input_fp, packet_size, SEEK_CUR);
                break;

            case TAV_PACKET_SUBTITLE:
            case TAV_PACKET_SUBTITLE_TC:
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

    // Calculate final statistics
    struct timeval end_time;
    gettimeofday(&end_time, NULL);
    double total_time = (end_time.tv_sec - start_time.tv_sec) +
                       (end_time.tv_usec - start_time.tv_usec) / 1000000.0;

    if (verbose) {
        printf("\nDecoded %d frames\n", decoder->frame_count);
    }

    tav_decoder_free(decoder);

    if (result < 0) {
        fprintf(stderr, "Decoding error occurred\n");
        unlink(temp_audio_file);  // Clean up temp file
        return 1;
    }

    // Print final statistics (similar to encoder)
    fprintf(stderr, "\n");  // Clear progress line
    printf("\nDecoding complete!\n");
    printf("  Frames decoded: %d\n", decoder->frame_count);
    printf("  Decoding time: %.2fs (%.1f fps)\n", total_time, decoder->frame_count / total_time);
    printf("  Output: %s\n", output_file);

    // Clean up temporary audio file
    if (unlink(temp_audio_file) == 0 && verbose) {
        fprintf(stderr, "Cleaned up temporary audio file: %s\n", temp_audio_file);
    }

    return 0;
}
