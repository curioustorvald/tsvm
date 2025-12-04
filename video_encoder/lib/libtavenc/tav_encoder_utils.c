/**
 * TAV Encoder - Utilities Library
 *
 * Common utility functions and helpers used across the encoder.
 * Includes math utilities, clamping, filename generation, etc.
 *
 * Extracted from encoder_tav.c as part of library refactoring.
 */

#define _POSIX_C_SOURCE 200112L

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <math.h>

// =============================================================================
// Math Utilities
// =============================================================================

/**
 * Clamp integer value to range [min, max].
 */
int tav_clamp_int(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}

/**
 * Clamp float value to range [min, max].
 */
float tav_clamp_float(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

/**
 * Clamp double value to range [min, max].
 */
double tav_clamp_double(double x, double min, double max) {
    return x < min ? min : (x > max ? max : x);
}

/**
 * Round double to nearest integer.
 */
int tav_iround(double v) {
    return (int)floor(v + 0.5);
}

/**
 * Linear interpolation between two values.
 * @param a  Start value (when t=0)
 * @param b  End value (when t=1)
 * @param t  Interpolation factor (0.0 to 1.0)
 * @return   Interpolated value
 */
float tav_lerp(float a, float b, float t) {
    return a * (1.0f - t) + b * t;
}

/**
 * Double precision linear interpolation.
 */
double tav_lerp_double(double a, double b, double t) {
    return a * (1.0 - t) + b * t;
}

/**
 * Get minimum of two integers.
 */
int tav_min_int(int a, int b) {
    return a < b ? a : b;
}

/**
 * Get maximum of two integers.
 */
int tav_max_int(int a, int b) {
    return a > b ? a : b;
}

/**
 * Get minimum of two floats.
 */
float tav_min_float(float a, float b) {
    return a < b ? a : b;
}

/**
 * Get maximum of two floats.
 */
float tav_max_float(float a, float b) {
    return a > b ? a : b;
}

/**
 * Compute absolute value of integer.
 */
int tav_abs_int(int x) {
    return x < 0 ? -x : x;
}

/**
 * Compute absolute value of float.
 */
float tav_abs_float(float x) {
    return x < 0.0f ? -x : x;
}

/**
 * Sign function: returns -1, 0, or 1.
 */
int tav_sign(int x) {
    return (x > 0) - (x < 0);
}

/**
 * Check if integer is power of 2.
 */
int tav_is_power_of_2(int x) {
    return x > 0 && (x & (x - 1)) == 0;
}

/**
 * Round up to next power of 2.
 */
int tav_next_power_of_2(int x) {
    if (x <= 0) return 1;
    x--;
    x |= x >> 1;
    x |= x >> 2;
    x |= x >> 4;
    x |= x >> 8;
    x |= x >> 16;
    return x + 1;
}

/**
 * Compute floor of log2(x).
 * Returns -1 for x <= 0.
 */
int tav_floor_log2(int x) {
    if (x <= 0) return -1;
    int log = 0;
    while (x > 1) {
        x >>= 1;
        log++;
    }
    return log;
}

/**
 * Compute ceil of log2(x).
 * Returns -1 for x <= 0.
 */
int tav_ceil_log2(int x) {
    if (x <= 0) return -1;
    if (x == 1) return 0;
    int log = tav_floor_log2(x);
    // Check if x is power of 2
    if ((1 << log) == x) {
        return log;
    }
    return log + 1;
}

// =============================================================================
// Random Filename Generation
// =============================================================================

/**
 * Generate a random temporary filename with .mp2 extension.
 * Format: /tmp/[32 random chars].mp2
 *
 * @param filename  Output buffer (must be at least 42 bytes)
 */
void tav_generate_random_filename(char *filename) {
    static int seeded = 0;
    if (!seeded) {
        srand(time(NULL));
        seeded = 1;
    }

    const char charset[] = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const int charset_size = sizeof(charset) - 1;

    // Start with the prefix
    strcpy(filename, "/tmp/");

    // Generate 32 random characters
    for (int i = 0; i < 32; i++) {
        filename[5 + i] = charset[rand() % charset_size];
    }

    // Add the .mp2 extension
    strcpy(filename + 37, ".mp2");
    filename[41] = '\0';  // Null terminate
}

/**
 * Generate a random temporary filename with custom extension.
 * Format: /tmp/[32 random chars].[ext]
 *
 * @param filename  Output buffer (must be large enough for path + extension)
 * @param ext       File extension (without leading dot, e.g., "tmp", "wav")
 */
void tav_generate_random_filename_ext(char *filename, const char *ext) {
    static int seeded = 0;
    if (!seeded) {
        srand(time(NULL));
        seeded = 1;
    }

    const char charset[] = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const int charset_size = sizeof(charset) - 1;

    // Start with the prefix
    strcpy(filename, "/tmp/");

    // Generate 32 random characters
    for (int i = 0; i < 32; i++) {
        filename[5 + i] = charset[rand() % charset_size];
    }

    // Add the extension
    filename[37] = '.';
    strcpy(filename + 38, ext);
}

// =============================================================================
// Memory Utilities
// =============================================================================

/**
 * Safe malloc with error checking.
 * Exits program on allocation failure.
 */
void *tav_malloc(size_t size) {
    void *ptr = malloc(size);
    if (!ptr && size > 0) {
        fprintf(stderr, "ERROR: Failed to allocate %zu bytes\n", size);
        exit(1);
    }
    return ptr;
}

/**
 * Safe calloc with error checking.
 * Exits program on allocation failure.
 */
void *tav_calloc(size_t count, size_t size) {
    void *ptr = calloc(count, size);
    if (!ptr && count > 0 && size > 0) {
        fprintf(stderr, "ERROR: Failed to allocate %zu elements of %zu bytes\n", count, size);
        exit(1);
    }
    return ptr;
}

/**
 * Safe realloc with error checking.
 * Exits program on allocation failure.
 */
void *tav_realloc(void *ptr, size_t size) {
    void *new_ptr = realloc(ptr, size);
    if (!new_ptr && size > 0) {
        fprintf(stderr, "ERROR: Failed to reallocate to %zu bytes\n", size);
        exit(1);
    }
    return new_ptr;
}

/**
 * Allocate aligned memory.
 * Returns NULL on failure.
 */
void *tav_aligned_alloc(size_t alignment, size_t size) {
    // Ensure alignment is power of 2
    if (!tav_is_power_of_2(alignment)) {
        fprintf(stderr, "ERROR: Alignment must be power of 2, got %zu\n", alignment);
        return NULL;
    }

#ifdef _WIN32
    return _aligned_malloc(size, alignment);
#else
    void *ptr = NULL;
    if (posix_memalign(&ptr, alignment, size) != 0) {
        return NULL;
    }
    return ptr;
#endif
}

/**
 * Free aligned memory.
 */
void tav_aligned_free(void *ptr) {
#ifdef _WIN32
    _aligned_free(ptr);
#else
    free(ptr);
#endif
}

// =============================================================================
// Array Utilities
// =============================================================================

/**
 * Fill integer array with constant value.
 */
void tav_array_fill_int(int *array, size_t count, int value) {
    for (size_t i = 0; i < count; i++) {
        array[i] = value;
    }
}

/**
 * Fill float array with constant value.
 */
void tav_array_fill_float(float *array, size_t count, float value) {
    for (size_t i = 0; i < count; i++) {
        array[i] = value;
    }
}

/**
 * Copy integer array.
 */
void tav_array_copy_int(int *dst, const int *src, size_t count) {
    memcpy(dst, src, count * sizeof(int));
}

/**
 * Copy float array.
 */
void tav_array_copy_float(float *dst, const float *src, size_t count) {
    memcpy(dst, src, count * sizeof(float));
}

/**
 * Find maximum value in integer array.
 */
int tav_array_max_int(const int *array, size_t count) {
    if (count == 0) return 0;
    int max_val = array[0];
    for (size_t i = 1; i < count; i++) {
        if (array[i] > max_val) {
            max_val = array[i];
        }
    }
    return max_val;
}

/**
 * Find minimum value in integer array.
 */
int tav_array_min_int(const int *array, size_t count) {
    if (count == 0) return 0;
    int min_val = array[0];
    for (size_t i = 1; i < count; i++) {
        if (array[i] < min_val) {
            min_val = array[i];
        }
    }
    return min_val;
}

/**
 * Find maximum absolute value in float array.
 */
float tav_array_max_abs_float(const float *array, size_t count) {
    if (count == 0) return 0.0f;
    float max_abs = fabsf(array[0]);
    for (size_t i = 1; i < count; i++) {
        float abs_val = fabsf(array[i]);
        if (abs_val > max_abs) {
            max_abs = abs_val;
        }
    }
    return max_abs;
}

/**
 * Compute sum of integer array.
 */
long long tav_array_sum_int(const int *array, size_t count) {
    long long sum = 0;
    for (size_t i = 0; i < count; i++) {
        sum += array[i];
    }
    return sum;
}

/**
 * Compute sum of float array.
 */
double tav_array_sum_float(const float *array, size_t count) {
    double sum = 0.0;
    for (size_t i = 0; i < count; i++) {
        sum += array[i];
    }
    return sum;
}

/**
 * Compute mean of float array.
 */
float tav_array_mean_float(const float *array, size_t count) {
    if (count == 0) return 0.0f;
    return (float)(tav_array_sum_float(array, count) / count);
}

/**
 * Swap two integer values.
 */
void tav_swap_int(int *a, int *b) {
    int temp = *a;
    *a = *b;
    *b = temp;
}

/**
 * Swap two float values.
 */
void tav_swap_float(float *a, float *b) {
    float temp = *a;
    *a = *b;
    *b = temp;
}

/**
 * Swap two pointer values.
 */
void tav_swap_ptr(void **a, void **b) {
    void *temp = *a;
    *a = *b;
    *b = temp;
}
