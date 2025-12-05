/**
 * TAV Encoder - Quantization Library
 *
 * Public API for DWT coefficient quantization with perceptual weighting.
 */

#ifndef TAV_ENCODER_QUANTIZE_H
#define TAV_ENCODER_QUANTIZE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Forward declaration of encoder context (defined in main encoder)
typedef struct tav_encoder_s tav_encoder_t;

// =============================================================================
// Uniform Quantization
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

// =============================================================================
// Perceptual Quantization
// =============================================================================

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

// =============================================================================
// 3D GOP Quantization
// =============================================================================

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

// =============================================================================
// Rate Control
// =============================================================================

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

#ifdef __cplusplus
}
#endif

#endif // TAV_ENCODER_QUANTIZE_H
