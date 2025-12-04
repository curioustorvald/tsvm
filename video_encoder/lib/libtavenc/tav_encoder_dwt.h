/**
 * TAV Encoder - Discrete Wavelet Transform Library
 *
 * Public API for multi-resolution wavelet decomposition.
 * Supports multiple wavelet types: CDF 5/3, 9/7, 13/7, DD-4, Haar
 */

#ifndef TAV_ENCODER_DWT_H
#define TAV_ENCODER_DWT_H

#ifdef __cplusplus
extern "C" {
#endif

// =============================================================================
// Wavelet Type Constants
// =============================================================================

#define WAVELET_5_3_REVERSIBLE 0      // CDF 5/3 reversible (lossless capable)
#define WAVELET_9_7_IRREVERSIBLE 1    // CDF 9/7 JPEG2000 (default, best compression)
#define WAVELET_BIORTHOGONAL_13_7 2   // CDF 13/7 experimental
#define WAVELET_DD4 16                // Deslauriers-Dubuc 4-point interpolating
#define WAVELET_HAAR 255              // Haar (demonstration only)

// =============================================================================
// 2D Discrete Wavelet Transform
// =============================================================================

/**
 * Apply 2D wavelet transform to spatial data.
 *
 * Uses separable 1D transforms: apply horizontal rows, then vertical columns.
 * Multi-level decomposition creates frequency subbands: LL, LH, HL, HH.
 *
 * @param data         Input/output data array (modified in-place)
 * @param width        Frame width
 * @param height       Frame height
 * @param levels       Number of decomposition levels (0 = auto-calculate)
 * @param filter_type  Wavelet type (WAVELET_* constants)
 */
void tav_dwt_2d_forward(float *data, int width, int height,
                        int levels, int filter_type);

// =============================================================================
// 3D Discrete Wavelet Transform (GOP Temporal + Spatial)
// =============================================================================

/**
 * Apply 3D wavelet transform to group-of-pictures (GOP).
 *
 * Process:
 * 1. Apply temporal 1D DWT across frames at each spatial position
 * 2. Apply spatial 2D DWT to each temporal subband frame
 *
 * @param gop_data         Array of frame pointers [num_frames]
 * @param width            Frame width
 * @param height           Frame height
 * @param num_frames       Number of frames in GOP
 * @param spatial_levels   Spatial decomposition levels (0 = auto)
 * @param temporal_levels  Temporal decomposition levels
 * @param spatial_filter   Wavelet type for spatial transform
 * @param temporal_filter  Wavelet type for temporal transform
 */
void tav_dwt_3d_forward(float **gop_data, int width, int height, int num_frames,
                        int spatial_levels, int temporal_levels,
                        int spatial_filter, int temporal_filter);

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculate optimal number of decomposition levels for given dimensions.
 *
 * Uses formula: floor(log2(min(width, height))) - 1
 * Ensures at least 2x2 low-pass subband remains after decomposition.
 *
 * @param width   Frame width
 * @param height  Frame height
 * @return        Recommended number of levels
 */
int tav_dwt_calculate_levels(int width, int height);

#ifdef __cplusplus
}
#endif

#endif // TAV_ENCODER_DWT_H
