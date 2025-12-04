/**
 * TAV Encoder - Color Space Conversion Library
 *
 * Public API for RGB <-> YCoCg-R and RGB <-> ICtCp color space conversions.
 */

#ifndef TAV_ENCODER_COLOR_H
#define TAV_ENCODER_COLOR_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// =============================================================================
// YCoCg-R Color Space Conversion
// =============================================================================

/**
 * Convert RGB24 to YCoCg-R color space for a full frame.
 *
 * @param rgb    Input RGB24 data (interleaved: RGBRGBRGB...)
 * @param y      Output luma channel
 * @param co     Output orange chrominance
 * @param cg     Output green chrominance
 * @param width  Frame width
 * @param height Frame height
 */
void tav_rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg,
                      int width, int height);

// =============================================================================
// ICtCp Color Space Conversion (HDR-capable)
// =============================================================================

/**
 * Convert sRGB8 to ICtCp color space using HLG transfer function.
 *
 * @param r8     Input red component (0-255)
 * @param g8     Input green component (0-255)
 * @param b8     Input blue component (0-255)
 * @param out_I  Output intensity (0-255)
 * @param out_Ct Output tritanope (0-255, centered at 127.5)
 * @param out_Cp Output protanope (0-255, centered at 127.5)
 */
void tav_srgb8_to_ictcp_hlg(uint8_t r8, uint8_t g8, uint8_t b8,
                             double *out_I, double *out_Ct, double *out_Cp);

/**
 * Convert ICtCp back to sRGB8 using HLG inverse transfer function.
 *
 * @param I8  Input intensity (0-255)
 * @param Ct8 Input tritanope (0-255, centered at 127.5)
 * @param Cp8 Input protanope (0-255, centered at 127.5)
 * @param r8  Output red component (0-255)
 * @param g8  Output green component (0-255)
 * @param b8  Output blue component (0-255)
 */
void tav_ictcp_hlg_to_srgb8(double I8, double Ct8, double Cp8,
                             uint8_t *r8, uint8_t *g8, uint8_t *b8);

#ifdef __cplusplus
}
#endif

#endif // TAV_ENCODER_COLOR_H
