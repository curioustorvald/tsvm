/**
 * TAV Encoder - Quantization Library
 *
 * Provides DWT coefficient quantization with perceptual weighting based on
 * the Human Visual System (HVS). Implements separable 3D quantization for
 * temporal GOP encoding.
 *
 * Extracted from encoder_tav.c as part of library refactoring.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

// Forward declaration of encoder context (defined in main encoder)
typedef struct tav_encoder_s tav_encoder_t;

// =============================================================================
// Utility Functions
// =============================================================================

static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}

static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

// =============================================================================
// Constants for Perceptual Model
// =============================================================================

// Dead-zone quantization scaling factors (applied selectively to luma only)
#define DEAD_ZONE_FINEST_SCALE 1.0f      // Full dead-zone for finest level
#define DEAD_ZONE_FINE_SCALE 0.5f        // Reduced dead-zone for second-finest level

// Anisotropy parameters for horizontal vs vertical detail quantization
// Index by quality level (0-5)
static const float ANISOTROPY_MULT[] = {5.1f, 3.8f, 2.7f, 2.0f, 1.5f, 1.2f, 1.0f};
static const float ANISOTROPY_BIAS[] = {0.4f, 0.3f, 0.2f, 0.1f, 0.0f, 0.0f, 0.0f};

// Chroma-specific anisotropy (more aggressive quantization)
static const float ANISOTROPY_MULT_CHROMA[] = {7.0f, 6.0f, 5.0f, 4.0f, 3.0f, 2.0f, 1.0f};
static const float ANISOTROPY_BIAS_CHROMA[] = {1.0f, 0.8f, 0.6f, 0.4f, 0.2f, 0.0f, 0.0f};

// Detail preservation factors for 2-pixel and 4-pixel structures
#define FOUR_PIXEL_DETAILER 0.88f
#define TWO_PIXEL_DETAILER  0.92f

// =============================================================================
// Subband Analysis Helper Functions
// =============================================================================

/**
 * Get decomposition level for coefficient at 2D spatial position.
 * Returns: level (1=finest to decomp_levels=coarsest, 0 for LL)
 */
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

/**
 * Get subband type for coefficient at 2D spatial position.
 * Returns: 0=LL, 1=LH, 2=HL, 3=HH
 */
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

/**
 * Legacy functions - convert linear index to 2D coords.
 */
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

/**
 * Get temporal subband level for frame index in GOP.
 * After temporal DWT with N levels, frames are organized as:
 * - Frames 0...num_frames/(2^N) = tL...L (N low-passes, coarsest)
 * - Remaining frames are temporal high-pass subbands at various levels
 *
 * Returns: 0 for coarsest (tLL), temporal_levels for finest (tHH)
 */
static int get_temporal_subband_level(int frame_idx, int num_frames, int temporal_levels) {
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

// =============================================================================
// Perceptual Model Functions (HVS-based weighting)
// =============================================================================

// Linear interpolation helper
static float lerp(float x, float y, float a) {
    return x * (1.f - a) + y * a;
}

/**
 * Perceptual model for LH subband (horizontal details).
 * Human eyes are more sensitive to horizontal details than vertical.
 * Curve: https://www.desmos.com/calculator/mjlpwqm8ge
 *
 * @param quality  Quality level (0-5)
 * @param level    Normalized decomposition level (1.0-6.0)
 * @return         Perceptual weight multiplier
 */
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

/**
 * Perceptual model for HL subband (vertical details).
 * Derived from LH with anisotropy compensation.
 *
 * @param quality  Quality level (0-5)
 * @param LH       LH subband weight
 * @return         Perceptual weight multiplier
 */
static float perceptual_model3_HL(int quality, float LH) {
    return fmaf(LH, ANISOTROPY_MULT[quality], ANISOTROPY_BIAS[quality]);
}

/**
 * Perceptual model for HH subband (diagonal details).
 * Interpolates between LH and HL based on level.
 *
 * @param LH     LH subband weight
 * @param HL     HL subband weight
 * @param level  Normalized decomposition level
 * @return       Perceptual weight multiplier
 */
static float perceptual_model3_HH(float LH, float HL, float level) {
    float Kx = fmaf((sqrtf(level) - 1.f), 0.5f, 0.5f);
    return lerp(LH, HL, Kx);
}

/**
 * Perceptual model for LL subband (low-frequency baseband).
 * Contains most image energy, preserve carefully.
 *
 * @param quality  Quality level (0-5)
 * @param level    Normalized decomposition level
 * @return         Perceptual weight multiplier
 */
static float perceptual_model3_LL(int quality, float level) {
    float n = perceptual_model3_LH(quality, level);
    float m = perceptual_model3_LH(quality, level - 1) / n;

    return n / m;
}

/**
 * Chroma-specific perceptual model base curve.
 * Less critical for human perception, more aggressive quantization.
 *
 * @param quality  Quality level (0-5)
 * @param level    Normalized decomposition level
 * @return         Perceptual weight multiplier
 */
static float perceptual_model3_chroma_basecurve(int quality, float level) {
    return 1.0f - (1.0f / (0.5f * quality * quality + 1.0f)) * (level - 4.0f);
}

/**
 * Get perceptual weight for a specific subband and level.
 * Implements HVS-optimized frequency weighting.
 *
 * NOTE: This function requires enc->quality_level field from encoder context.
 *
 * @param enc           Encoder context (for quality_level)
 * @param level0        Decomposition level (1-based: 1=finest, decomp_levels=coarsest)
 * @param subband_type  Subband type (0=LL, 1=LH, 2=HL, 3=HH)
 * @param is_chroma     1 for chroma channels, 0 for luma
 * @param max_levels    Maximum decomposition levels
 * @return              Perceptual weight multiplier (≥1.0)
 */
static float get_perceptual_weight(tav_encoder_t *enc, int level0, int subband_type, int is_chroma, int max_levels);

/**
 * Get perceptual weight for coefficient at linear index position.
 * Maps linear coefficient index to DWT subband layout.
 *
 * NOTE: This function requires enc->widths[]/enc->heights[] arrays from encoder context.
 *
 * @param enc             Encoder context (for widths/heights arrays and quality_level)
 * @param linear_idx      Linear coefficient index
 * @param width           Frame width
 * @param height          Frame height
 * @param decomp_levels   Number of decomposition levels
 * @param is_chroma       1 for chroma channels, 0 for luma
 * @return                Perceptual weight multiplier (≥1.0)
 */
static float get_perceptual_weight_for_position(tav_encoder_t *enc, int linear_idx, int width, int height, int decomp_levels, int is_chroma);

// =============================================================================
// Quantization Functions
// =============================================================================

/**
 * Quantize DWT coefficients with uniform quantization and optional dead-zone.
 *
 * This is the basic quantization function without perceptual weighting.
 * Dead-zone quantization is applied selectively to luma channel only:
 * - HH1 (finest diagonal): full dead-zone
 * - LH1/HL1/HH2: half dead-zone
 * - Coarser levels: no dead-zone (preserve structure)
 *
 * @param coeffs               Input DWT coefficients (float)
 * @param quantised            Output quantized coefficients (int16_t)
 * @param size                 Number of coefficients
 * @param quantiser            Base quantizer value (1-4096)
 * @param dead_zone_threshold  Dead-zone threshold (0.0 = disabled)
 * @param width                Frame width
 * @param height               Frame height
 * @param decomp_levels        Number of decomposition levels
 * @param is_chroma            1 for chroma channels, 0 for luma
 */
void tav_quantise_uniform(float *coeffs, int16_t *quantised, int size, int quantiser,
                          float dead_zone_threshold, int width, int height,
                          int decomp_levels, int is_chroma);

/**
 * Quantize DWT coefficients with per-coefficient perceptual weighting.
 *
 * Applies HVS-optimized frequency weighting to each coefficient based on its
 * position in the DWT subband tree. Implements the full perceptual model with
 * dead-zone quantization for luma.
 *
 * NOTE: This function requires encoder context fields:
 * - enc->widths[]/enc->heights[] for subband layout
 * - enc->quality_level for perceptual model
 * - enc->dead_zone_threshold for dead-zone quantization
 *
 * @param enc             Encoder context
 * @param coeffs          Input DWT coefficients (float)
 * @param quantised       Output quantized coefficients (int16_t)
 * @param size            Number of coefficients
 * @param base_quantiser  Base quantizer value (before perceptual weighting)
 * @param dead_zone_threshold  Dead-zone threshold (0.0 = disabled)
 * @param width           Frame width
 * @param height          Frame height
 * @param decomp_levels   Number of decomposition levels
 * @param is_chroma       1 for chroma channels, 0 for luma
 * @param frame_count     Current frame number (for any frame-dependent logic)
 */
void tav_quantise_perceptual(tav_encoder_t *enc,
                              float *coeffs, int16_t *quantised, int size,
                              int base_quantiser, float dead_zone_threshold, int width, int height,
                              int decomp_levels, int is_chroma, int frame_count);

/**
 * Quantize 3D DWT coefficients with SEPARABLE temporal-spatial quantization.
 *
 * After 3D DWT (temporal + spatial), GOP coefficients have this structure:
 * - Temporal DWT applied first → temporal subbands at different levels
 * - Spatial 2D DWT applied to each temporal subband
 *
 * Quantization strategy:
 * 1. Compute temporal base quantizer: tH_base(level) = Qbase * 2^(beta*level^kappa)
 *    - tLL (level 0): coarsest temporal → smallest quantizer
 *    - tHH (highest level): finest temporal → largest quantizer
 * 2. Apply spatial perceptual weighting to tH_base
 * 3. Final quantizer: Q_effective = tH_base × spatial_weight
 *
 * NOTE: This function requires encoder context fields:
 * - enc->encoder_preset for sports mode detection
 * - enc->temporal_decomp_levels for temporal level calculation
 * - enc->verbose for debug output
 * - Plus all fields needed by tav_quantise_perceptual()
 *
 * @param enc             Encoder context
 * @param gop_coeffs      GOP coefficients [frame][pixel] (temporal subbands)
 * @param quantised       Output quantized coefficients [frame][pixel]
 * @param num_frames      Number of temporal subband frames
 * @param spatial_size    Number of spatial coefficients per frame
 * @param base_quantiser  Base quantizer value (before temporal/spatial scaling)
 * @param is_chroma       1 for chroma channels, 0 for luma
 */
void tav_quantise_3d_dwt(tav_encoder_t *enc,
                         float **gop_coeffs, int16_t **quantised, int num_frames,
                         int spatial_size, int base_quantiser, int is_chroma);

/**
 * Convert floating-point quantizer to integer with dithering (for bitrate mode).
 *
 * Implements Floyd-Steinberg style error diffusion to avoid quantization
 * artifacts when converting float quantizer values to integers for rate control.
 *
 * NOTE: This function requires encoder context fields:
 * - enc->adjusted_quantiser_y_float (current float quantizer)
 * - enc->dither_accumulator (accumulated error, modified by this function)
 *
 * @param enc  Encoder context
 * @return     Integer quantizer value (0-254)
 */
int tav_quantiser_float_to_int_dithered(tav_encoder_t *enc);

// =============================================================================
// Perceptual Weight Implementation (requires encoder context)
// =============================================================================

// NOTE: This implementation requires encoder context (enc->quality_level)
// Struct definition will be in encoder header when integrated

#ifndef TAV_ENCODER_QUANTIZE_INTERNAL
// Forward declare structure access - will be properly defined when integrated
struct tav_encoder_s {
    int quality_level;
    int *widths;
    int *heights;
    int decomp_levels;
    float dead_zone_threshold;
    int encoder_preset;
    int temporal_decomp_levels;
    int verbose;
    int frame_count;
    float adjusted_quantiser_y_float;
    float dither_accumulator;
    int width;
    int height;
    int perceptual_tuning;
};
#endif

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

static float get_perceptual_weight_for_position(tav_encoder_t *enc, int linear_idx, int width, int height, int decomp_levels, int is_chroma) {
    // If perceptual tuning is disabled, use uniform quantization (weight = 1.0)
    if (!enc->perceptual_tuning) {
        return 1.0f;
    }

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

// =============================================================================
// Quantization Function Implementations
// =============================================================================

void tav_quantise_uniform(float *coeffs, int16_t *quantised, int size, int quantiser,
                          float dead_zone_threshold, int width, int height,
                          int decomp_levels, int is_chroma) {
    float effective_q = quantiser;
    effective_q = FCLAMP(effective_q, 1.0f, 4096.0f);

    // Scalar implementation (AVX-512 version would go in separate optimized module)
    for (int i = 0; i < size; i++) {
        float quantised_val = coeffs[i] / effective_q;

        // Apply dead-zone quantisation ONLY to luma channel and specific subbands
        if (dead_zone_threshold > 0.0f && !is_chroma) {
            int level = get_subband_level(i, width, height, decomp_levels);
            int subband_type = get_subband_type(i, width, height, decomp_levels);
            float level_threshold = 0.0f;

            if (level == 1) {
                // Finest level
                if (subband_type == 3) {
                    // HH1: full dead-zone
                    level_threshold = dead_zone_threshold * DEAD_ZONE_FINEST_SCALE;
                } else if (subband_type == 1 || subband_type == 2) {
                    // LH1, HL1: half dead-zone
                    level_threshold = dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
            } else if (level == 2) {
                // Second-finest level
                if (subband_type == 3) {
                    // HH2: half dead-zone
                    level_threshold = dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
            }

            if (fabsf(quantised_val) <= level_threshold) {
                quantised_val = 0.0f;
            }
        }

        quantised[i] = (int16_t)CLAMP((int)(quantised_val + (quantised_val >= 0 ? 0.5f : -0.5f)), -32768, 32767);
    }
}

void tav_quantise_perceptual(tav_encoder_t *enc,
                              float *coeffs, int16_t *quantised, int size,
                              int base_quantiser, float dead_zone_threshold, int width, int height,
                              int decomp_levels, int is_chroma, int frame_count) {
    float effective_base_q = base_quantiser;
    effective_base_q = FCLAMP(effective_base_q, 1.0f, 4096.0f);

    for (int i = 0; i < size; i++) {
        // Apply perceptual weight based on coefficient's position in DWT layout
        float weight = get_perceptual_weight_for_position(enc, i, width, height, decomp_levels, is_chroma);
        float effective_q = effective_base_q * weight;
        float quantised_val = coeffs[i] / effective_q;

        // Apply dead-zone quantisation ONLY to luma channel
        if (dead_zone_threshold > 0.0f && !is_chroma) {
            int level = get_subband_level(i, width, height, decomp_levels);
            int subband_type = get_subband_type(i, width, height, decomp_levels);
            float level_threshold = 0.0f;

            if (level == 1) {
                if (subband_type == 3) {
                    level_threshold = dead_zone_threshold * DEAD_ZONE_FINEST_SCALE;
                } else if (subband_type == 1 || subband_type == 2) {
                    level_threshold = dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
            } else if (level == 2) {
                if (subband_type == 3) {
                    level_threshold = dead_zone_threshold * DEAD_ZONE_FINE_SCALE;
                }
            }

            if (fabsf(quantised_val) <= level_threshold) {
                quantised_val = 0.0f;
            }
        }

        quantised[i] = (int16_t)CLAMP((int)(quantised_val + (quantised_val >= 0 ? 0.5f : -0.5f)), -32768, 32767);
    }
}

void tav_quantise_3d_dwt(tav_encoder_t *enc,
                         float **gop_coeffs, int16_t **quantised, int num_frames,
                         int spatial_size, int base_quantiser, int is_chroma) {
    // Sports preset: use finer temporal quantisation (less aggressive)
    const float BETA = (enc->encoder_preset & 0x01) ? 0.0f : 0.6f;
    const float KAPPA = (enc->encoder_preset & 0x01) ? 1.0f : 1.14f;

    // Process each temporal subband independently (separable approach)
    for (int t = 0; t < num_frames; t++) {
        // Step 1: Determine temporal subband level
        int temporal_level = get_temporal_subband_level(t, num_frames, enc->temporal_decomp_levels);

        // Step 2: Compute temporal base quantiser using exponential scaling
        float temporal_scale = powf(2.0f, BETA * powf(temporal_level, KAPPA));
        float temporal_quantiser = base_quantiser * temporal_scale;

        int temporal_base_quantiser = (int)roundf(temporal_quantiser);
        temporal_base_quantiser = CLAMP(temporal_base_quantiser, 1, 255);

        // Step 3: Apply spatial quantisation within this temporal subband
        // Check if perceptual tuning is enabled (stored in encoder_preset bit 1)
        // NOTE: perceptual_tuning field is NOT in tav_encoder_s, so we check context flag
        // For now, just use perceptual (this will be controlled by caller disabling)
        tav_quantise_perceptual(
            enc,
            gop_coeffs[t],           // Input: spatial coefficients for this temporal subband
            quantised[t],            // Output: quantised spatial coefficients
            spatial_size,            // Number of spatial coefficients
            temporal_base_quantiser, // Temporally-scaled base quantiser
            enc->dead_zone_threshold, // Dead zone threshold
            enc->width,              // Frame width
            enc->height,             // Frame height
            enc->decomp_levels,      // Spatial decomposition levels
            is_chroma,               // Is chroma channel
            enc->frame_count + t     // Frame number
        );

        /*if (enc->verbose && (t == 0 || t == num_frames - 1)) {
            printf("  Temporal subband %d: level=%d, tH_base=%d\n",
                   t, temporal_level, temporal_base_quantiser);
        }*/
    }
}

int tav_quantiser_float_to_int_dithered(tav_encoder_t *enc) {
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
