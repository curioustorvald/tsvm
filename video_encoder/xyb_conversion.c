// XYB Color Space Conversion Functions for TEV
// Based on JPEG XL XYB specification with proper sRGB linearization
// test with:
//// gcc -DXYB_TEST_MAIN -o test_xyb xyb_conversion.c -lm && ./test_xyb

#include <stdio.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>

#define CLAMP(x, min, max) ((x) < (min) ? (min) : ((x) > (max) ? (max) : (x)))

// XYB conversion constants from JPEG XL specification
static const double XYB_BIAS = 0.00379307325527544933;
static const double CBRT_BIAS = 0.155954200549248620; // cbrt(XYB_BIAS)

// RGB to LMS mixing coefficients
static const double RGB_TO_LMS[3][3] = {
    {0.3, 0.622, 0.078},                           // L coefficients
    {0.23, 0.692, 0.078},                          // M coefficients  
    {0.24342268924547819, 0.20476744424496821, 0.55180986650955360}  // S coefficients
};

// LMS to RGB inverse matrix (calculated via matrix inversion)
static const double LMS_TO_RGB[3][3] = {
    {11.0315669046, -9.8669439081, -0.1646229965},
    {-3.2541473811, 4.4187703776, -0.1646229965},
    {-3.6588512867, 2.7129230459, 1.9459282408}
};

// sRGB linearization (0..1 range)
static inline double srgb_linearize(double val) {
    if (val > 0.04045) {
        return pow((val + 0.055) / 1.055, 2.4);
    } else {
        return val / 12.92;
    }
}

// sRGB unlinearization (0..1 range) 
static inline double srgb_unlinearize(double val) {
    if (val > 0.0031308) {
        return 1.055 * pow(val, 1.0 / 2.4) - 0.055;
    } else {
        return val * 12.92;
    }
}

// Fast cube root approximation for performance
static inline double fast_cbrt(double x) {
    if (x < 0) return -cbrt(-x);
    return cbrt(x);
}

// RGB to XYB conversion with proper sRGB linearization
void rgb_to_xyb(uint8_t r, uint8_t g, uint8_t b, double *x, double *y, double *xyb_b) {
    // Convert RGB to 0-1 range and linearize sRGB
    double r_norm = srgb_linearize(r / 255.0);
    double g_norm = srgb_linearize(g / 255.0);
    double b_norm = srgb_linearize(b / 255.0);
    
    // RGB to LMS mixing with bias
    double lmix = RGB_TO_LMS[0][0] * r_norm + RGB_TO_LMS[0][1] * g_norm + RGB_TO_LMS[0][2] * b_norm + XYB_BIAS;
    double mmix = RGB_TO_LMS[1][0] * r_norm + RGB_TO_LMS[1][1] * g_norm + RGB_TO_LMS[1][2] * b_norm + XYB_BIAS;
    double smix = RGB_TO_LMS[2][0] * r_norm + RGB_TO_LMS[2][1] * g_norm + RGB_TO_LMS[2][2] * b_norm + XYB_BIAS;
    
    // Apply gamma correction (cube root)
    double lgamma = fast_cbrt(lmix) - CBRT_BIAS;
    double mgamma = fast_cbrt(mmix) - CBRT_BIAS;
    double sgamma = fast_cbrt(smix) - CBRT_BIAS;
    
    // LMS to XYB transformation
    *x = (lgamma - mgamma) / 2.0;
    *y = (lgamma + mgamma) / 2.0;
    *xyb_b = sgamma;
}

// XYB to RGB conversion with proper sRGB unlinearization
void xyb_to_rgb(double x, double y, double xyb_b, uint8_t *r, uint8_t *g, uint8_t *b) {
    // XYB to LMS gamma
    double lgamma = x + y;
    double mgamma = y - x;
    double sgamma = xyb_b;
    
    // Remove gamma correction
    double lmix = pow(lgamma + CBRT_BIAS, 3.0) - XYB_BIAS;
    double mmix = pow(mgamma + CBRT_BIAS, 3.0) - XYB_BIAS;
    double smix = pow(sgamma + CBRT_BIAS, 3.0) - XYB_BIAS;
    
    // LMS to linear RGB using inverse matrix
    double r_linear = LMS_TO_RGB[0][0] * lmix + LMS_TO_RGB[0][1] * mmix + LMS_TO_RGB[0][2] * smix;
    double g_linear = LMS_TO_RGB[1][0] * lmix + LMS_TO_RGB[1][1] * mmix + LMS_TO_RGB[1][2] * smix;
    double b_linear = LMS_TO_RGB[2][0] * lmix + LMS_TO_RGB[2][1] * mmix + LMS_TO_RGB[2][2] * smix;
    
    // Clamp linear RGB to valid range
    r_linear = CLAMP(r_linear, 0.0, 1.0);
    g_linear = CLAMP(g_linear, 0.0, 1.0);
    b_linear = CLAMP(b_linear, 0.0, 1.0);
    
    // Convert back to sRGB gamma and 0-255 range
    *r = CLAMP((int)(srgb_unlinearize(r_linear) * 255.0 + 0.5), 0, 255);
    *g = CLAMP((int)(srgb_unlinearize(g_linear) * 255.0 + 0.5), 0, 255);
    *b = CLAMP((int)(srgb_unlinearize(b_linear) * 255.0 + 0.5), 0, 255);
}

// Convert RGB to XYB with integer quantization suitable for TEV format
void rgb_to_xyb_quantized(uint8_t r, uint8_t g, uint8_t b, int *x_quant, int *y_quant, int *b_quant) {
    double x, y, xyb_b;
    rgb_to_xyb(r, g, b, &x, &y, &xyb_b);
    
    // Quantize to suitable integer ranges for TEV
    // Y channel: 0-255 (similar to current Y in YCoCg)  
    *y_quant = CLAMP((int)(y * 255.0 + 128.0), 0, 255);
    
    // X channel: -128 to +127 (similar to Co range)
    *x_quant = CLAMP((int)(x * 255.0), -128, 127);
    
    // B channel: -128 to +127 (similar to Cg, can be aggressively quantized)
    *b_quant = CLAMP((int)(xyb_b * 255.0), -128, 127);
}

// Test function to verify conversion accuracy
int test_xyb_conversion() {
    printf("Testing XYB conversion accuracy with sRGB linearization...\n");
    
    // Test with various RGB values
    uint8_t test_colors[][3] = {
        {255, 0, 0},    // Red
        {0, 255, 0},    // Green  
        {0, 0, 255},    // Blue
        {255, 255, 255}, // White
        {0, 0, 0},      // Black
        {128, 128, 128}, // Gray
        {255, 255, 0},  // Yellow
        {255, 0, 255},  // Magenta
        {0, 255, 255},  // Cyan
        // MacBeth chart colours converted to sRGB
        {0x73,0x52,0x44},
        {0xc2,0x96,0x82},
        {0x62,0x7a,0x9d},
        {0x57,0x6c,0x43},
        {0x85,0x80,0xb1},
        {0x67,0xbd,0xaa},
        {0xd6,0x7e,0x2c},
        {0x50,0x5b,0xa6},
        {0xc1,0x5a,0x63},
        {0x5e,0x3c,0x6c},
        {0x9d,0xbc,0x40},
        {0xe0,0xa3,0x2e},
        {0x38,0x3d,0x96},
        {0x46,0x94,0x49},
        {0xaf,0x36,0x3c},
        {0xe7,0xc7,0x1f},
        {0xbb,0x56,0x95},
        {0x08,0x85,0xa1},
        {0xf3,0xf3,0xf3},
        {0xc8,0xc8,0xc8},
        {0xa0,0xa0,0xa0},
        {0x7a,0x7a,0x7a},
        {0x55,0x55,0x55},
        {0x34,0x34,0x34}
    };
    
    int num_tests = sizeof(test_colors) / sizeof(test_colors[0]);
    int errors = 0;
    
    for (int i = 0; i < num_tests; i++) {
        uint8_t r_orig = test_colors[i][0];
        uint8_t g_orig = test_colors[i][1]; 
        uint8_t b_orig = test_colors[i][2];
        
        double x, y, xyb_b;
        uint8_t r_conv, g_conv, b_conv;
        
        // Forward and reverse conversion
        rgb_to_xyb(r_orig, g_orig, b_orig, &x, &y, &xyb_b);
        xyb_to_rgb(x, y, xyb_b, &r_conv, &g_conv, &b_conv);
        
        // Check accuracy (allow small rounding errors)
        int r_error = abs((int)r_orig - (int)r_conv);
        int g_error = abs((int)g_orig - (int)g_conv);
        int b_error = abs((int)b_orig - (int)b_conv);
        
        printf("RGB(%3d,%3d,%3d) -> XYB(%6.3f,%6.3f,%6.3f) -> RGB(%3d,%3d,%3d) [Error: %d,%d,%d]\n",
               r_orig, g_orig, b_orig, x, y, xyb_b, r_conv, g_conv, b_conv, r_error, g_error, b_error);
        
        if (r_error > 2 || g_error > 2 || b_error > 2) {
            errors++;
        }
    }
    
    printf("Test completed: %d/%d passed\n", num_tests - errors, num_tests);
    return errors == 0;
}

#ifdef XYB_TEST_MAIN
int main() {
    return test_xyb_conversion() ? 0 : 1;
}
#endif