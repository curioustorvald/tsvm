/**
 * TAV Encoder - Color Space Conversion Library
 *
 * Provides RGB <-> YCoCg-R and RGB <-> ICtCp color space conversions
 * for the TSVM Advanced Video (TAV) encoder.
 *
 * Extracted from encoder_tav.c as part of library refactoring.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

// =============================================================================
// Utility Functions
// =============================================================================

static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}

static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

static inline int iround(double v) {
    return (int)floor(v + 0.5);
}

// =============================================================================
// sRGB Gamma Helpers
// =============================================================================

static inline double srgb_linearise(double val) {
    if (val <= 0.04045) return val / 12.92;
    return pow((val + 0.055) / 1.055, 2.4);
}

static inline double srgb_unlinearise(double val) {
    if (val <= 0.0031308) return 12.92 * val;
    return 1.055 * pow(val, 1.0/2.4) - 0.055;
}

// =============================================================================
// HLG (Hybrid Log-Gamma) Transfer Functions
// =============================================================================

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

// =============================================================================
// Color Space Transformation Matrices
// =============================================================================

// BT.2100 RGB -> LMS matrix
static const double M_RGB_TO_LMS[3][3] = {
    {1688.0/4096, 2146.0/4096,  262.0/4096},
    { 683.0/4096, 2951.0/4096,  462.0/4096},
    {  99.0/4096,  309.0/4096, 3688.0/4096}
};

// LMS -> RGB inverse matrix
static const double M_LMS_TO_RGB[3][3] = {
    { 6.1723815689243215, -5.319534979827695,   0.14699442094633924},
    {-1.3243428148026244,  2.560286104841917,  -0.2359203727576164},
    {-0.011819739235953752, -0.26473549971186555, 1.2767952602537955}
};

// ICtCp matrix (L' M' S' -> I Ct Cp) - BT.2100 constants
static const double M_LMSPRIME_TO_ICTCP[3][3] = {
    { 2048.0/4096.0,   2048.0/4096.0,     0.0          },
    { 3625.0/4096.0,  -7465.0/4096.0,  3840.0/4096.0   },
    { 9500.0/4096.0,  -9212.0/4096.0,  -288.0/4096.0   }
};

// ICtCp -> L' M' S' inverse matrix
static const double M_ICTCP_TO_LMSPRIME[3][3] = {
    { 1.0,   0.015718580108730416,   0.2095810681164055 },
    { 1.0,  -0.015718580108730416,  -0.20958106811640548},
    { 1.0,   1.0212710798422344,    -0.6052744909924316 }
};

// =============================================================================
// YCoCg-R Color Space Conversion
// =============================================================================

/**
 * Convert RGB24 to YCoCg-R color space for a full frame.
 *
 * YCoCg-R is a reversible color transform optimized for compression:
 * - Y  = luma (G + (R-B)/2)
 * - Co = orange chrominance (R - B)
 * - Cg = green chrominance (G - (R+B)/2)
 *
 * @param rgb    Input RGB24 data (planar: RRRR...GGGG...BBBB...)
 * @param y      Output luma channel
 * @param co     Output orange chrominance
 * @param cg     Output green chrominance
 * @param width  Frame width
 * @param height Frame height
 */
void tav_rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg,
                      int width, int height)
{
    const int total_pixels = width * height;

    // Process 4 pixels at a time for better cache utilization
    int i = 0;
    const int simd_end = (total_pixels / 4) * 4;

    // Vectorized processing for groups of 4 pixels
    for (i = 0; i < simd_end; i += 4) {
        const uint8_t *rgb_ptr = &rgb[i * 3];

        // Process 4 pixels simultaneously with loop unrolling
        for (int j = 0; j < 4; j++) {
            const int idx = i + j;
            const float r = rgb_ptr[j * 3 + 0];
            const float g = rgb_ptr[j * 3 + 1];
            const float b = rgb_ptr[j * 3 + 2];

            // YCoCg-R transform
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

// =============================================================================
// ICtCp Color Space Conversion (HDR-capable)
// =============================================================================

/**
 * Convert sRGB8 to ICtCp color space using HLG transfer function.
 *
 * ICtCp is a perceptually uniform color space designed for HDR content:
 * - I  = intensity (luma)
 * - Ct = tritanope (blue-yellow)
 * - Cp = protanope (red-green)
 *
 * Uses BT.2100 ICtCp with HLG OETF for better perceptual uniformity.
 *
 * @param r8     Input red component (0-255)
 * @param g8     Input green component (0-255)
 * @param b8     Input blue component (0-255)
 * @param out_I  Output intensity (0-255)
 * @param out_Ct Output tritanope (0-255, centered at 127.5)
 * @param out_Cp Output protanope (0-255, centered at 127.5)
 */
void tav_srgb8_to_ictcp_hlg(uint8_t r8, uint8_t g8, uint8_t b8,
                             double *out_I, double *out_Ct, double *out_Cp)
{
    // 1) Linearize sRGB to 0..1
    double r = srgb_linearise((double)r8 / 255.0);
    double g = srgb_linearise((double)g8 / 255.0);
    double b = srgb_linearise((double)b8 / 255.0);

    // 2) Linear RGB -> LMS (3x3 multiply)
    double L = M_RGB_TO_LMS[0][0]*r + M_RGB_TO_LMS[0][1]*g + M_RGB_TO_LMS[0][2]*b;
    double M = M_RGB_TO_LMS[1][0]*r + M_RGB_TO_LMS[1][1]*g + M_RGB_TO_LMS[1][2]*b;
    double S = M_RGB_TO_LMS[2][0]*r + M_RGB_TO_LMS[2][1]*g + M_RGB_TO_LMS[2][2]*b;

    // 3) Apply HLG OETF (Hybrid Log-Gamma)
    double Lp = HLG_OETF(L);
    double Mp = HLG_OETF(M);
    double Sp = HLG_OETF(S);

    // 4) L'M'S' -> ICtCp
    double I  = M_LMSPRIME_TO_ICTCP[0][0]*Lp + M_LMSPRIME_TO_ICTCP[0][1]*Mp + M_LMSPRIME_TO_ICTCP[0][2]*Sp;
    double Ct = M_LMSPRIME_TO_ICTCP[1][0]*Lp + M_LMSPRIME_TO_ICTCP[1][1]*Mp + M_LMSPRIME_TO_ICTCP[1][2]*Sp;
    double Cp = M_LMSPRIME_TO_ICTCP[2][0]*Lp + M_LMSPRIME_TO_ICTCP[2][1]*Mp + M_LMSPRIME_TO_ICTCP[2][2]*Sp;

    // 5) Scale and offset to 0-255 range
    *out_I = FCLAMP(I * 255.0, 0.0, 255.0);
    *out_Ct = FCLAMP(Ct * 255.0 + 127.5, 0.0, 255.0);
    *out_Cp = FCLAMP(Cp * 255.0 + 127.5, 0.0, 255.0);
}

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
                             uint8_t *r8, uint8_t *g8, uint8_t *b8)
{
    // 1) Denormalize from 0-255 range
    double I = I8 / 255.0;
    double Ct = (Ct8 - 127.5) / 255.0;
    double Cp = (Cp8 - 127.5) / 255.0;

    // 2) ICtCp -> L' M' S' (3x3 inverse multiply)
    double Lp = M_ICTCP_TO_LMSPRIME[0][0]*I + M_ICTCP_TO_LMSPRIME[0][1]*Ct + M_ICTCP_TO_LMSPRIME[0][2]*Cp;
    double Mp = M_ICTCP_TO_LMSPRIME[1][0]*I + M_ICTCP_TO_LMSPRIME[1][1]*Ct + M_ICTCP_TO_LMSPRIME[1][2]*Cp;
    double Sp = M_ICTCP_TO_LMSPRIME[2][0]*I + M_ICTCP_TO_LMSPRIME[2][1]*Ct + M_ICTCP_TO_LMSPRIME[2][2]*Cp;

    // 3) Apply HLG inverse EOTF
    double L = HLG_EOTF(Lp);
    double M = HLG_EOTF(Mp);
    double S = HLG_EOTF(Sp);

    // 4) LMS -> linear sRGB (3x3 inverse multiply)
    double r_lin = M_LMS_TO_RGB[0][0]*L + M_LMS_TO_RGB[0][1]*M + M_LMS_TO_RGB[0][2]*S;
    double g_lin = M_LMS_TO_RGB[1][0]*L + M_LMS_TO_RGB[1][1]*M + M_LMS_TO_RGB[1][2]*S;
    double b_lin = M_LMS_TO_RGB[2][0]*L + M_LMS_TO_RGB[2][1]*M + M_LMS_TO_RGB[2][2]*S;

    // 5) Apply sRGB gamma and convert to 0-255 with rounding
    double r = srgb_unlinearise(r_lin);
    double g = srgb_unlinearise(g_lin);
    double b = srgb_unlinearise(b_lin);

    *r8 = (uint8_t)iround(FCLAMP(r * 255.0, 0.0, 255.0));
    *g8 = (uint8_t)iround(FCLAMP(g * 255.0, 0.0, 255.0));
    *b8 = (uint8_t)iround(FCLAMP(b * 255.0, 0.0, 255.0));
}
