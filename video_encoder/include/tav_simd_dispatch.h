/*
 * TAV SIMD Function Dispatcher
 *
 * This file provides runtime CPU detection and function pointer dispatch
 * for SIMD-optimized versions of performance-critical TAV encoder functions.
 *
 * Usage:
 * 1. Include this header after defining all scalar functions
 * 2. Call tav_simd_init() once at encoder initialization
 * 3. Use function pointers (e.g., dwt_53_forward_1d_ptr) throughout code
 *
 * The dispatcher will automatically select AVX-512, AVX2, or scalar versions
 * based on runtime CPU capabilities.
 */

#ifndef TAV_SIMD_DISPATCH_H
#define TAV_SIMD_DISPATCH_H

#include <stdint.h>

// =============================================================================
// Function Pointer Types
// =============================================================================

// 1D DWT function pointer types
typedef void (*dwt_1d_func_t)(float *data, int length);

// Quantization function pointer types
typedef void (*quantise_basic_func_t)(
    float *coeffs, int16_t *quantised, int size,
    float effective_q, float dead_zone_threshold,
    int width, int height, int decomp_levels, int is_chroma,
    int (*get_subband_level)(int, int, int, int),
    int (*get_subband_type)(int, int, int, int)
);

typedef void (*quantise_perceptual_func_t)(
    float *coeffs, int16_t *quantised, int size,
    float *weights, float base_quantiser
);

// Color conversion function pointer type
typedef void (*rgb_to_ycocg_func_t)(
    const uint8_t *rgb, float *y, float *co, float *cg,
    int width, int height
);

// 2D DWT column operations
typedef void (*dwt_2d_column_extract_func_t)(
    const float *tile_data, float *column,
    int x, int width, int height
);

typedef void (*dwt_2d_column_insert_func_t)(
    float *tile_data, const float *column,
    int x, int width, int height
);

// =============================================================================
// Global Function Pointers (initialized by tav_simd_init)
// =============================================================================

// DWT 1D transforms
static dwt_1d_func_t dwt_53_forward_1d_ptr = NULL;
static dwt_1d_func_t dwt_97_forward_1d_ptr = NULL;
static dwt_1d_func_t dwt_haar_forward_1d_ptr = NULL;
static dwt_1d_func_t dwt_53_inverse_1d_ptr = NULL;
static dwt_1d_func_t dwt_haar_inverse_1d_ptr = NULL;

// Quantization
static quantise_basic_func_t quantise_dwt_coefficients_ptr = NULL;
static quantise_perceptual_func_t quantise_dwt_coefficients_perceptual_ptr = NULL;

// Color conversion
static rgb_to_ycocg_func_t rgb_to_ycocg_ptr = NULL;

// 2D DWT column operations
static dwt_2d_column_extract_func_t dwt_2d_extract_column_ptr = NULL;
static dwt_2d_column_insert_func_t dwt_2d_insert_column_ptr = NULL;

// =============================================================================
// SIMD Capability Detection
// =============================================================================

typedef enum {
    SIMD_NONE = 0,
    SIMD_AVX512F = 1,
    SIMD_AVX2 = 2,
    SIMD_SSE42 = 3
} simd_level_t;

static simd_level_t detected_simd_level = SIMD_NONE;

static inline simd_level_t detect_simd_capabilities(void) {
#if defined(__GNUC__) || defined(__clang__)
    // Use GCC/Clang built-in CPU detection
    if (!__builtin_cpu_supports("sse4.2")) {
        return SIMD_NONE;
    }

#ifdef __AVX512F__
    if (__builtin_cpu_supports("avx512f") &&
        __builtin_cpu_supports("avx512dq") &&
        __builtin_cpu_supports("avx512bw") &&
        __builtin_cpu_supports("avx512vl")) {
        return SIMD_AVX512F;
    }
#endif

#ifdef __AVX2__
    if (__builtin_cpu_supports("avx2")) {
        return SIMD_AVX2;
    }
#endif

    if (__builtin_cpu_supports("sse4.2")) {
        return SIMD_SSE42;
    }
#endif

    return SIMD_NONE;
}

// =============================================================================
// Scalar Fallback Wrappers
// =============================================================================

// These wrappers adapt the scalar functions to match function pointer signatures

static void quantise_dwt_coefficients_scalar_wrapper(
    float *coeffs, int16_t *quantised, int size,
    float effective_q, float dead_zone_threshold,
    int width, int height, int decomp_levels, int is_chroma,
    int (*get_subband_level)(int, int, int, int),
    int (*get_subband_type)(int, int, int, int)
);
// Implementation provided by including encoder - just declare prototype

static void quantise_dwt_coefficients_perceptual_scalar_wrapper(
    float *coeffs, int16_t *quantised, int size,
    float *weights, float base_quantiser
);
// Implementation provided by including encoder

static void dwt_2d_extract_column_scalar(
    const float *tile_data, float *column,
    int x, int width, int height
) {
    for (int y = 0; y < height; y++) {
        column[y] = tile_data[y * width + x];
    }
}

static void dwt_2d_insert_column_scalar(
    float *tile_data, const float *column,
    int x, int width, int height
) {
    for (int y = 0; y < height; y++) {
        tile_data[y * width + x] = column[y];
    }
}

// =============================================================================
// SIMD Initialization
// =============================================================================

static void tav_simd_init(void) {
    // Detect CPU capabilities
    detected_simd_level = detect_simd_capabilities();

    const char *simd_names[] = {"None", "AVX-512", "AVX2", "SSE4.2"};
    fprintf(stderr, "[TAV] SIMD level detected: %s\n",
            simd_names[detected_simd_level]);

#ifdef __AVX512F__
    if (detected_simd_level == SIMD_AVX512F) {
        fprintf(stderr, "[TAV] Using AVX-512 optimizations\n");

        // DWT functions
        extern void dwt_53_forward_1d_avx512(float *data, int length);
        extern void dwt_97_forward_1d_avx512(float *data, int length);
        extern void dwt_haar_forward_1d_avx512(float *data, int length);

        dwt_53_forward_1d_ptr = dwt_53_forward_1d_avx512;
        dwt_97_forward_1d_ptr = dwt_97_forward_1d_avx512;
        dwt_haar_forward_1d_ptr = dwt_haar_forward_1d_avx512;

        // Quantization
        // Note: Need wrapper functions that match the complex signature
        // For now, using scalar versions
        extern void dwt_53_forward_1d(float *data, int length);
        extern void dwt_97_forward_1d(float *data, int length);
        extern void dwt_haar_forward_1d(float *data, int length);
        extern void dwt_53_inverse_1d(float *data, int length);
        extern void dwt_haar_inverse_1d(float *data, int length);

        // Fallback to scalar for inverse (can optimize later)
        dwt_53_inverse_1d_ptr = dwt_53_inverse_1d;
        dwt_haar_inverse_1d_ptr = dwt_haar_inverse_1d;

        // Color conversion
        extern void rgb_to_ycocg_avx512(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height);
        rgb_to_ycocg_ptr = rgb_to_ycocg_avx512;

        // 2D column operations
        extern void dwt_2d_extract_column_avx512(const float *tile_data, float *column, int x, int width, int height);
        extern void dwt_2d_insert_column_avx512(float *tile_data, const float *column, int x, int width, int height);

        dwt_2d_extract_column_ptr = dwt_2d_extract_column_avx512;
        dwt_2d_insert_column_ptr = dwt_2d_insert_column_avx512;

        // Quantization uses scalar for now (needs integration work)
        extern void dwt_53_forward_1d(float *data, int length);
        extern void dwt_97_forward_1d(float *data, int length);
        extern void dwt_haar_forward_1d(float *data, int length);
        extern void dwt_53_inverse_1d(float *data, int length);
        extern void dwt_haar_inverse_1d(float *data, int length);
        extern void rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height);

        quantise_dwt_coefficients_ptr = quantise_dwt_coefficients_scalar_wrapper;
        quantise_dwt_coefficients_perceptual_ptr = quantise_dwt_coefficients_perceptual_scalar_wrapper;

        return;
    }
#endif

    // Fallback to scalar implementations
    fprintf(stderr, "[TAV] Using scalar (non-SIMD) implementations\n");

    extern void dwt_53_forward_1d(float *data, int length);
    extern void dwt_97_forward_1d(float *data, int length);
    extern void dwt_haar_forward_1d(float *data, int length);
    extern void dwt_53_inverse_1d(float *data, int length);
    extern void dwt_haar_inverse_1d(float *data, int length);
    extern void rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height);

    dwt_53_forward_1d_ptr = dwt_53_forward_1d;
    dwt_97_forward_1d_ptr = dwt_97_forward_1d;
    dwt_haar_forward_1d_ptr = dwt_haar_forward_1d;
    dwt_53_inverse_1d_ptr = dwt_53_inverse_1d;
    dwt_haar_inverse_1d_ptr = dwt_haar_inverse_1d;

    rgb_to_ycocg_ptr = rgb_to_ycocg;

    dwt_2d_extract_column_ptr = dwt_2d_extract_column_scalar;
    dwt_2d_insert_column_ptr = dwt_2d_insert_column_scalar;

    quantise_dwt_coefficients_ptr = quantise_dwt_coefficients_scalar_wrapper;
    quantise_dwt_coefficients_perceptual_ptr = quantise_dwt_coefficients_perceptual_scalar_wrapper;
}

// =============================================================================
// Convenience Macros for Code Readability
// =============================================================================

// Use these macros in encoder code for cleaner dispatch
#define DWT_53_FORWARD_1D(data, length) \
    dwt_53_forward_1d_ptr((data), (length))

#define DWT_97_FORWARD_1D(data, length) \
    dwt_97_forward_1d_ptr((data), (length))

#define DWT_HAAR_FORWARD_1D(data, length) \
    dwt_haar_forward_1d_ptr((data), (length))

#define RGB_TO_YCOCG(rgb, y, co, cg, width, height) \
    rgb_to_ycocg_ptr((rgb), (y), (co), (cg), (width), (height))

#define DWT_2D_EXTRACT_COLUMN(tile_data, column, x, width, height) \
    dwt_2d_extract_column_ptr((tile_data), (column), (x), (width), (height))

#define DWT_2D_INSERT_COLUMN(tile_data, column, x, width, height) \
    dwt_2d_insert_column_ptr((tile_data), (column), (x), (width), (height))

#endif // TAV_SIMD_DISPATCH_H
