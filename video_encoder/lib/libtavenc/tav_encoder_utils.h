/**
 * TAV Encoder - Utilities Library
 *
 * Public API for common utility functions and helpers.
 */

#ifndef TAV_ENCODER_UTILS_H
#define TAV_ENCODER_UTILS_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// =============================================================================
// Math Utilities
// =============================================================================

/** Clamp integer value to range [min, max] */
int tav_clamp_int(int x, int min, int max);

/** Clamp float value to range [min, max] */
float tav_clamp_float(float x, float min, float max);

/** Clamp double value to range [min, max] */
double tav_clamp_double(double x, double min, double max);

/** Round double to nearest integer */
int tav_iround(double v);

/** Linear interpolation between two floats */
float tav_lerp(float a, float b, float t);

/** Linear interpolation between two doubles */
double tav_lerp_double(double a, double b, double t);

/** Get minimum of two integers */
int tav_min_int(int a, int b);

/** Get maximum of two integers */
int tav_max_int(int a, int b);

/** Get minimum of two floats */
float tav_min_float(float a, float b);

/** Get maximum of two floats */
float tav_max_float(float a, float b);

/** Compute absolute value of integer */
int tav_abs_int(int x);

/** Compute absolute value of float */
float tav_abs_float(float x);

/** Sign function: returns -1, 0, or 1 */
int tav_sign(int x);

/** Check if integer is power of 2 */
int tav_is_power_of_2(int x);

/** Round up to next power of 2 */
int tav_next_power_of_2(int x);

/** Compute floor of log2(x) */
int tav_floor_log2(int x);

/** Compute ceil of log2(x) */
int tav_ceil_log2(int x);

// =============================================================================
// Random Filename Generation
// =============================================================================

/**
 * Generate a random temporary filename with .mp2 extension.
 * Format: /tmp/[32 random chars].mp2
 *
 * @param filename  Output buffer (must be at least 42 bytes)
 */
void tav_generate_random_filename(char *filename);

/**
 * Generate a random temporary filename with custom extension.
 * Format: /tmp/[32 random chars].[ext]
 *
 * @param filename  Output buffer (must be large enough)
 * @param ext       File extension (without leading dot)
 */
void tav_generate_random_filename_ext(char *filename, const char *ext);

// =============================================================================
// Memory Utilities
// =============================================================================

/** Safe malloc with error checking (exits on failure) */
void *tav_malloc(size_t size);

/** Safe calloc with error checking (exits on failure) */
void *tav_calloc(size_t count, size_t size);

/** Safe realloc with error checking (exits on failure) */
void *tav_realloc(void *ptr, size_t size);

/** Allocate aligned memory (returns NULL on failure) */
void *tav_aligned_alloc(size_t alignment, size_t size);

/** Free aligned memory */
void tav_aligned_free(void *ptr);

// =============================================================================
// Array Utilities
// =============================================================================

/** Fill integer array with constant value */
void tav_array_fill_int(int *array, size_t count, int value);

/** Fill float array with constant value */
void tav_array_fill_float(float *array, size_t count, float value);

/** Copy integer array */
void tav_array_copy_int(int *dst, const int *src, size_t count);

/** Copy float array */
void tav_array_copy_float(float *dst, const float *src, size_t count);

/** Find maximum value in integer array */
int tav_array_max_int(const int *array, size_t count);

/** Find minimum value in integer array */
int tav_array_min_int(const int *array, size_t count);

/** Find maximum absolute value in float array */
float tav_array_max_abs_float(const float *array, size_t count);

/** Compute sum of integer array */
long long tav_array_sum_int(const int *array, size_t count);

/** Compute sum of float array */
double tav_array_sum_float(const float *array, size_t count);

/** Compute mean of float array */
float tav_array_mean_float(const float *array, size_t count);

/** Swap two integer values */
void tav_swap_int(int *a, int *b);

/** Swap two float values */
void tav_swap_float(float *a, float *b);

/** Swap two pointer values */
void tav_swap_ptr(void **a, void **b);

// =============================================================================
// Convenience Macros (for backward compatibility)
// =============================================================================

#define CLAMP(x, min, max)  tav_clamp_int(x, min, max)
#define FCLAMP(x, min, max) tav_clamp_float(x, min, max)

#ifdef __cplusplus
}
#endif

#endif // TAV_ENCODER_UTILS_H
