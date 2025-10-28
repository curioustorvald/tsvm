// Created by CuriousTorvald and Claude on 2025-10-24.
// TAD32 (Terrarum Advanced Audio - PCM32f version) Encoder Library
// Alternative version: PCM32f throughout encoding, PCM8 conversion only at decoder
// This file contains only the encoding functions for comparison testing

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include "encoder_tad.h"

// Undefine the macro version from header and define as array
#undef TAD32_COEFF_SCALARS

// Coefficient scalars for each subband (CDF 9/7 with 9 decomposition levels)
// Index 0 = LL band, Index 1-9 = H bands (L9 to L1)
static const float TAD32_COEFF_SCALARS[] = {64.0f, 45.255f, 32.0f, 22.627f, 16.0f, 11.314f, 8.0f, 5.657f, 4.0f, 2.828f};

// Base quantiser weight table (10 subbands: LL + 9 H bands)
// Linearly spaced from 1.0 (LL) to 2.0 (H9)
// These weights are multiplied by quantiser_scale during quantization
static const float BASE_QUANTISER_WEIGHTS[] = {
    1.0f,      // LL (L9) - finest preservation
    1.111f,    // H (L9)
    1.222f,    // H (L8)
    1.333f,    // H (L7)
    1.444f,    // H (L6)
    1.556f,    // H (L5)
    1.667f,    // H (L4)
    1.778f,    // H (L3)
    1.889f,    // H (L2)
    2.0f       // H (L1) - coarsest quantization
};

// Forward declarations for internal functions
static void dwt_dd4_forward_1d(float *data, int length);
static void dwt_dd4_forward_multilevel(float *data, int length, int levels);
static void quantize_dwt_coefficients(const float *coeffs, int8_t *quantized, size_t count, int apply_deadzone, int chunk_size, int dwt_levels, int quant_bits, int *current_subband_index, float quantiser_scale);
static size_t encode_twobitmap(const int8_t *values, size_t count, uint8_t *output);

static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

// Calculate DWT levels from chunk size
static int calculate_dwt_levels(int chunk_size) {
    /*if (chunk_size < TAD32_MIN_CHUNK_SIZE) {
        fprintf(stderr, "Error: Chunk size %d is below minimum %d\n", chunk_size, TAD32_MIN_CHUNK_SIZE);
        return -1;
    }

    int levels = 0;
    int size = chunk_size;
    while (size > 1) {
        size >>= 1;
        levels++;
    }

    // For non-power-of-2, we need to add 1 to levels
    int pow2 = 1 << levels;
    if (pow2 < chunk_size) {
        levels++;
    }

    return levels - 2;*/  // Maximum decomposition

    return 9;
}

//=============================================================================
// DD-4 DWT Implementation
//=============================================================================

// Four-point interpolating Deslauriers-Dubuc (DD-4) wavelet forward 1D transform
static void dwt_dd4_forward_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Split into even/odd samples
    for (int i = 0; i < half; i++) {
        temp[i] = data[2 * i];           // Even (low)
    }
    for (int i = 0; i < length / 2; i++) {
        temp[half + i] = data[2 * i + 1]; // Odd (high)
    }

    // DD-4 forward prediction step with four-point kernel
    for (int i = 0; i < length / 2; i++) {
        float s_m1, s_0, s_1, s_2;

        if (i > 0) s_m1 = temp[i - 1];
        else s_m1 = temp[0]; // Mirror boundary

        s_0 = temp[i];

        if (i + 1 < half) s_1 = temp[i + 1];
        else s_1 = temp[half - 1];

        if (i + 2 < half) s_2 = temp[i + 2];
        else if (half > 1) s_2 = temp[half - 2];
        else s_2 = temp[half - 1];

        float prediction = (-1.0f/16.0f) * s_m1 + (9.0f/16.0f) * s_0 +
                          (9.0f/16.0f) * s_1 + (-1.0f/16.0f) * s_2;

        temp[half + i] -= prediction;
    }

    // DD-4 update step
    for (int i = 0; i < half; i++) {
        float d_curr = (i < length / 2) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && i - 1 < length / 2) ? temp[half + i - 1] : 0.0f;
        temp[i] += 0.25f * (d_prev + d_curr);
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// 1D DWT using lifting scheme for 9/7 irreversible filter
static void dwt_97_forward_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;  // Handle odd lengths properly

    // Split into even/odd samples
    for (int i = 0; i < half; i++) {
        temp[i] = data[2 * i];           // Even (low)
    }
    for (int i = 0; i < length / 2; i++) {
        temp[half + i] = data[2 * i + 1]; // Odd (high)
    }

    // JPEG2000 9/7 forward lifting steps (corrected to match decoder)
    const float alpha = -1.586134342f;
    const float beta = -0.052980118f;
    const float gamma = 0.882911076f;
    const float delta = 0.443506852f;
    const float K = 1.230174105f;

    // Step 1: Predict α - d[i] += α * (s[i] + s[i+1])
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] += alpha * (s_curr + s_next);
        }
    }

    // Step 2: Update β - s[i] += β * (d[i-1] + d[i])
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] += beta * (d_prev + d_curr);
    }

    // Step 3: Predict γ - d[i] += γ * (s[i] + s[i+1])
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] += gamma * (s_curr + s_next);
        }
    }

    // Step 4: Update δ - s[i] += δ * (d[i-1] + d[i])
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] += delta * (d_prev + d_curr);
    }

    // Step 5: Scaling - s[i] *= K, d[i] /= K
    for (int i = 0; i < half; i++) {
        temp[i] *= K;  // Low-pass coefficients
    }
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            temp[half + i] /= K;  // High-pass coefficients
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// Apply multi-level DWT (using DD-4 wavelet)
static void dwt_dd4_forward_multilevel(float *data, int length, int levels) {
    int current_length = length;
    for (int level = 0; level < levels; level++) {
//        dwt_dd4_forward_1d(data, current_length);
        dwt_97_forward_1d(data, current_length);
        current_length = (current_length + 1) / 2;
    }
}

//=============================================================================
// M/S Stereo Decorrelation (PCM32f version)
//=============================================================================

static void ms_decorrelate(const float *left, const float *right, float *mid, float *side, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // Mid = (L + R) / 2, Side = (L - R) / 2
        float l = left[i];
        float r = right[i];
        mid[i] = (l + r) / 2.0f;
        side[i] = (l - r) / 2.0f;
    }
}

static float signum(float x) {
    if (x > 0.0f) return 1.0f;
    if (x < 0.0f) return -1.0f;
    return 0.0f;
}

static void compress_gamma(float *left, float *right, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // encode(x) = sign(x) * |x|^γ where γ=0.5
        float x = left[i];
        left[i] = signum(x) * sqrtf(fabsf(x));
        float y = right[i];
        right[i] = signum(y) * sqrtf(fabsf(y));
    }
}

static void compress_mu_law(float *left, float *right, size_t count) {
    static float MU = 255.0f;

    for (size_t i = 0; i < count; i++) {
        // encode(x) = sign(x) * |x|^γ where γ=0.5
        float x = left[i];
        left[i] = signum(x) * logf(1.0f + MU * fabsf(x)) / logf(1.0f + MU);
        float y = right[i];
        right[i] = signum(y) * logf(1.0f + MU * fabsf(y)) / logf(1.0f + MU);
    }
}

//=============================================================================
// Quantization with Frequency-Dependent Weighting
//=============================================================================

#define LAMBDA_FIXED 6.0f

// Lambda-based companding encoder (based on Laplacian distribution CDF)
// val must be normalised to [-1,1]
// Returns quantized index in range [-127, +127]
static int8_t lambda_companding(float val, int max_index) {
    // Handle zero
    if (fabsf(val) < 1e-9f) {
        return 0;
    }

    int sign = (val < 0) ? -1 : 1;
    float abs_val = fabsf(val);

    // Clamp to [0, 1]
    if (abs_val > 1.0f) abs_val = 1.0f;


    // Laplacian CDF for x >= 0: F(x) = 1 - 0.5 * exp(-λ*x)
    // Map to [0.5, 1.0] range (half of CDF for positive values)
    float cdf = 1.0f - 0.5f * expf(-LAMBDA_FIXED * abs_val);

    // Map CDF from [0.5, 1.0] to [0, 1] for positive half
    float normalized_cdf = (cdf - 0.5f) * 2.0f;

    // Quantize to index
    int index = (int)roundf(normalized_cdf * max_index);

    // Clamp index to valid range [0, max_index]
    if (index < 0) index = 0;
    if (index > max_index) index = max_index;

    return (int8_t)(sign * index);
}

static void quantize_dwt_coefficients(const float *coeffs, int8_t *quantized, size_t count, int apply_deadzone, int chunk_size, int dwt_levels, int max_index, int *current_subband_index, float quantiser_scale) {
    int first_band_size = chunk_size >> dwt_levels;

    int *sideband_starts = malloc((dwt_levels + 2) * sizeof(int));
    sideband_starts[0] = 0;
    sideband_starts[1] = first_band_size;
    for (int i = 2; i <= dwt_levels + 1; i++) {
        sideband_starts[i] = sideband_starts[i-1] + (first_band_size << (i-2));
    }

    for (size_t i = 0; i < count; i++) {
        int sideband = dwt_levels;
        for (int s = 0; s <= dwt_levels; s++) {
            if (i < (size_t)sideband_starts[s + 1]) {
                sideband = s;
                break;
            }
        }

        // Store subband index (LL=0, H1=1, H2=2, ..., H9=9 for dwt_levels=9)
        if (current_subband_index != NULL) {
            current_subband_index[i] = sideband;
        }

        // Apply base weight and quantiser scaling
        float weight = BASE_QUANTISER_WEIGHTS[sideband] * quantiser_scale;
        float val = (coeffs[i] / (TAD32_COEFF_SCALARS[sideband] * weight)); // val is normalised to [-1,1]
        int8_t quant_val = lambda_companding(val, max_index);

        quantized[i] = quant_val;
    }

    free(sideband_starts);
}

//=============================================================================
// Twobit-map Significance Map Encoding
//=============================================================================

// Twobit-map encoding: 2 bits per coefficient for common values
// 00 = 0
// 01 = +1
// 10 = -1
// 11 = other value (followed by int8_t in separate array)
static size_t encode_twobitmap(const int8_t *values, size_t count, uint8_t *output) {
    // Calculate size needed for twobit map
    size_t map_bytes = (count * 2 + 7) / 8;  // 2 bits per coefficient

    // First pass: create significance map and count "other" values
    uint8_t *map = output;
    memset(map, 0, map_bytes);

    size_t other_count = 0;
    for (size_t i = 0; i < count; i++) {
        int8_t val = values[i];
        uint8_t code;

        if (val == 0) {
            code = 0;  // 00
        } else if (val == 1) {
            code = 1;  // 01
        } else if (val == -1) {
            code = 2;  // 10
        } else {
            code = 3;  // 11
            other_count++;
        }

        // Write 2-bit code into map
        size_t bit_offset = i * 2;
        size_t byte_idx = bit_offset / 8;
        size_t bit_in_byte = bit_offset % 8;

        map[byte_idx] |= (code << bit_in_byte);
    }

    // Second pass: write "other" values
    int8_t *other_values = (int8_t*)(output + map_bytes);
    size_t other_idx = 0;

    for (size_t i = 0; i < count; i++) {
        int8_t val = values[i];
        if (val != 0 && val != 1 && val != -1) {
            other_values[other_idx++] = val;
        }
    }

    return map_bytes + other_count;
}

//=============================================================================
// Coefficient Statistics
//=============================================================================

static int compare_float(const void *a, const void *b) {
    float fa = *(const float*)a;
    float fb = *(const float*)b;
    if (fa < fb) return -1;
    if (fa > fb) return 1;
    return 0;
}

typedef struct {
    float min;
    float q1;
    float median;
    float q3;
    float max;
    float lambda;  // Laplacian distribution parameter (1/b, where b is scale)
} CoeffStats;

typedef struct {
    float *data;
    size_t count;
    size_t capacity;
} CoeffAccumulator;

typedef struct {
    int8_t *data;
    size_t count;
    size_t capacity;
} QuantAccumulator;

// Global accumulators for statistics
static CoeffAccumulator *mid_accumulators = NULL;
static CoeffAccumulator *side_accumulators = NULL;
static QuantAccumulator *mid_quant_accumulators = NULL;
static QuantAccumulator *side_quant_accumulators = NULL;
static int num_subbands = 0;
static int stats_initialized = 0;
static int stats_dwt_levels = 0;

static void init_statistics(int dwt_levels) {
    if (stats_initialized) return;

    num_subbands = dwt_levels + 1;
    stats_dwt_levels = dwt_levels;

    mid_accumulators = calloc(num_subbands, sizeof(CoeffAccumulator));
    side_accumulators = calloc(num_subbands, sizeof(CoeffAccumulator));
    mid_quant_accumulators = calloc(num_subbands, sizeof(QuantAccumulator));
    side_quant_accumulators = calloc(num_subbands, sizeof(QuantAccumulator));

    for (int i = 0; i < num_subbands; i++) {
        mid_accumulators[i].capacity = 1024;
        mid_accumulators[i].data = malloc(mid_accumulators[i].capacity * sizeof(float));
        mid_accumulators[i].count = 0;

        side_accumulators[i].capacity = 1024;
        side_accumulators[i].data = malloc(side_accumulators[i].capacity * sizeof(float));
        side_accumulators[i].count = 0;

        mid_quant_accumulators[i].capacity = 1024;
        mid_quant_accumulators[i].data = malloc(mid_quant_accumulators[i].capacity * sizeof(int8_t));
        mid_quant_accumulators[i].count = 0;

        side_quant_accumulators[i].capacity = 1024;
        side_quant_accumulators[i].data = malloc(side_quant_accumulators[i].capacity * sizeof(int8_t));
        side_quant_accumulators[i].count = 0;
    }

    stats_initialized = 1;
}

static void accumulate_coefficients(const float *coeffs, int dwt_levels, int chunk_size, CoeffAccumulator *accumulators) {
    int first_band_size = chunk_size >> dwt_levels;

    int *sideband_starts = malloc((dwt_levels + 2) * sizeof(int));
    sideband_starts[0] = 0;
    sideband_starts[1] = first_band_size;
    for (int i = 2; i <= dwt_levels + 1; i++) {
        sideband_starts[i] = sideband_starts[i-1] + (first_band_size << (i-2));
    }

    for (int s = 0; s <= dwt_levels; s++) {
        size_t start = sideband_starts[s];
        size_t end = sideband_starts[s + 1];
        size_t band_size = end - start;

        // Expand capacity if needed
        while (accumulators[s].count + band_size > accumulators[s].capacity) {
            accumulators[s].capacity *= 2;
            accumulators[s].data = realloc(accumulators[s].data,
                                          accumulators[s].capacity * sizeof(float));
        }

        // Copy coefficients
        memcpy(accumulators[s].data + accumulators[s].count,
               coeffs + start, band_size * sizeof(float));
        accumulators[s].count += band_size;
    }

    free(sideband_starts);
}

static void accumulate_quantized(const int8_t *quant, int dwt_levels, int chunk_size, QuantAccumulator *accumulators) {
    int first_band_size = chunk_size >> dwt_levels;

    int *sideband_starts = malloc((dwt_levels + 2) * sizeof(int));
    sideband_starts[0] = 0;
    sideband_starts[1] = first_band_size;
    for (int i = 2; i <= dwt_levels + 1; i++) {
        sideband_starts[i] = sideband_starts[i-1] + (first_band_size << (i-2));
    }

    for (int s = 0; s <= dwt_levels; s++) {
        size_t start = sideband_starts[s];
        size_t end = sideband_starts[s + 1];
        size_t band_size = end - start;

        // Expand capacity if needed
        while (accumulators[s].count + band_size > accumulators[s].capacity) {
            accumulators[s].capacity *= 2;
            accumulators[s].data = realloc(accumulators[s].data,
                                          accumulators[s].capacity * sizeof(int8_t));
        }

        // Copy coefficients
        memcpy(accumulators[s].data + accumulators[s].count,
               quant + start, band_size * sizeof(int8_t));
        accumulators[s].count += band_size;
    }

    free(sideband_starts);
}

static void calculate_coeff_stats(const float *coeffs, size_t count, CoeffStats *stats) {
    if (count == 0) {
        stats->min = stats->q1 = stats->median = stats->q3 = stats->max = 0.0f;
        stats->lambda = 0.0f;
        return;
    }

    // Copy coefficients for sorting
    float *sorted = malloc(count * sizeof(float));
    memcpy(sorted, coeffs, count * sizeof(float));
    qsort(sorted, count, sizeof(float), compare_float);

    stats->min = sorted[0];
    stats->max = sorted[count - 1];
    stats->median = sorted[count / 2];
    stats->q1 = sorted[count / 4];
    stats->q3 = sorted[(3 * count) / 4];

    free(sorted);

    // Estimate Laplacian distribution parameter λ = 1/b
    // For Laplacian centered at μ=0, MLE gives: b = mean(|x|)
    // Therefore: λ = 1/b = 1/mean(|x|)
    double sum_abs = 0.0;
    for (size_t i = 0; i < count; i++) {
        sum_abs += fabs(coeffs[i]);
    }
    double mean_abs = sum_abs / count;
    stats->lambda = (mean_abs > 1e-9) ? (1.0f / mean_abs) : 0.0f;
}

#define HISTOGRAM_BINS 40
#define HISTOGRAM_WIDTH 60

static void print_histogram(const float *coeffs, size_t count, const char *title) {
    if (count == 0) return;

    // Find min/max
    float min_val = coeffs[0];
    float max_val = coeffs[0];
    for (size_t i = 1; i < count; i++) {
        if (coeffs[i] < min_val) min_val = coeffs[i];
        if (coeffs[i] > max_val) max_val = coeffs[i];
    }

    // Handle case where all values are the same
    if (fabsf(max_val - min_val) < 1e-9f) {
        fprintf(stderr, "  %s: All values are %.3f\n", title, min_val);
        return;
    }

    // Create histogram bins
    size_t bins[HISTOGRAM_BINS] = {0};
    float bin_width = (max_val - min_val) / HISTOGRAM_BINS;

    for (size_t i = 0; i < count; i++) {
        int bin = (int)((coeffs[i] - min_val) / bin_width);
        if (bin >= HISTOGRAM_BINS) bin = HISTOGRAM_BINS - 1;
        if (bin < 0) bin = 0;
        bins[bin]++;
    }

    // Find max bin count for scaling
    size_t max_bin = 0;
    for (int i = 0; i < HISTOGRAM_BINS; i++) {
        if (bins[i] > max_bin) max_bin = bins[i];
    }

    // Print histogram
    fprintf(stderr, "  %s Histogram (range: %.3f to %.3f):\n", title, min_val, max_val);

    // Print top 20 bins to keep output manageable
    for (int i = 0; i < HISTOGRAM_BINS; i++) {
        float bin_start = min_val + i * bin_width;
        float bin_end = bin_start + bin_width;
        int bar_width = (int)((bins[i] * HISTOGRAM_WIDTH) / max_bin);

        // Only print bins with significant content (> 1% of max)
        if (bins[i] > max_bin / 100) {
            fprintf(stderr, "  %8.3f-%8.3f [%7zu]: ", bin_start, bin_end, bins[i]);
            for (int j = 0; j < bar_width; j++) {
                fprintf(stderr, "█");
            }
            fprintf(stderr, "\n");
        }
    }
    fprintf(stderr, "\n");
}

typedef struct {
    int8_t value;
    size_t count;
    float percentage;
} ValueFrequency;

static int compare_value_frequency(const void *a, const void *b) {
    const ValueFrequency *va = (const ValueFrequency*)a;
    const ValueFrequency *vb = (const ValueFrequency*)b;
    // Sort by count descending
    if (vb->count > va->count) return 1;
    if (vb->count < va->count) return -1;
    return 0;
}

static void print_top5_quantized_values(const int8_t *quant, size_t count, const char *title) {
    if (count == 0) {
        fprintf(stderr, "  %s: No data\n", title);
        return;
    }

    // For int8_t range is at most 256, so we can use direct indexing
    // Map from [-128, 127] to [0, 255]
    size_t freq[256] = {0};

    for (size_t i = 0; i < count; i++) {
        int idx = (int)quant[i] + 128;
        freq[idx]++;
    }

    // Find all unique values with their frequencies
    ValueFrequency values[256];
    int unique_count = 0;
    for (int i = 0; i < 256; i++) {
        if (freq[i] > 0) {
            values[unique_count].value = (int8_t)(i - 128);
            values[unique_count].count = freq[i];
            values[unique_count].percentage = (float)(freq[i] * 100.0) / count;
            unique_count++;
        }
    }

    // Sort by frequency
    qsort(values, unique_count, sizeof(ValueFrequency), compare_value_frequency);

    // Print top 10
    fprintf(stderr, "  %s Top 100 Values:\n", title);
    int print_count = (unique_count < 100) ? unique_count : 100;
    for (int i = 0; i < print_count; i++) {
        fprintf(stderr, "    %6d: %8zu occurrences (%5.2f%%)\n",
                values[i].value, values[i].count, values[i].percentage);
    }
    fprintf(stderr, "\n");
}

void tad32_print_statistics(void) {
    if (!stats_initialized) return;

    fprintf(stderr, "\n=== TAD Coefficient Statistics (before quantization) ===\n");

    // Print Mid channel statistics
    fprintf(stderr, "\nMid Channel:\n");
    fprintf(stderr, "%-12s %10s %10s %10s %10s %10s %10s %10s\n",
            "Subband", "Samples", "Min", "Q1", "Median", "Q3", "Max", "Lambda");
    fprintf(stderr, "----------------------------------------------------------------------------------------\n");

    for (int s = 0; s < num_subbands; s++) {
        CoeffStats stats;
        calculate_coeff_stats(mid_accumulators[s].data, mid_accumulators[s].count, &stats);

        char band_name[16];
        if (s == 0) {
            snprintf(band_name, sizeof(band_name), "LL (L%d)", stats_dwt_levels);
        } else {
            snprintf(band_name, sizeof(band_name), "H (L%d)", stats_dwt_levels - s + 1);
        }

        fprintf(stderr, "%-12s %10zu %10.3f %10.3f %10.3f %10.3f %10.3f %10.3f\n",
                band_name, mid_accumulators[s].count,
                stats.min, stats.q1, stats.median, stats.q3, stats.max, stats.lambda);
    }

    // Print Mid channel histograms
    fprintf(stderr, "\nMid Channel Histograms:\n");
    for (int s = 0; s < num_subbands; s++) {
        char band_name[32];
        if (s == 0) {
            snprintf(band_name, sizeof(band_name), "LL (L%d)", stats_dwt_levels);
        } else {
            snprintf(band_name, sizeof(band_name), "H (L%d)", stats_dwt_levels - s + 1);
        }
        print_histogram(mid_accumulators[s].data, mid_accumulators[s].count, band_name);
    }

    // Print Side channel statistics
    fprintf(stderr, "\nSide Channel:\n");
    fprintf(stderr, "%-12s %10s %10s %10s %10s %10s %10s %10s\n",
            "Subband", "Samples", "Min", "Q1", "Median", "Q3", "Max", "Lambda");
    fprintf(stderr, "----------------------------------------------------------------------------------------\n");

    for (int s = 0; s < num_subbands; s++) {
        CoeffStats stats;
        calculate_coeff_stats(side_accumulators[s].data, side_accumulators[s].count, &stats);

        char band_name[16];
        if (s == 0) {
            snprintf(band_name, sizeof(band_name), "LL (L%d)", stats_dwt_levels);
        } else {
            snprintf(band_name, sizeof(band_name), "H (L%d)", stats_dwt_levels - s + 1);
        }

        fprintf(stderr, "%-12s %10zu %10.3f %10.3f %10.3f %10.3f %10.3f %10.3f\n",
                band_name, side_accumulators[s].count,
                stats.min, stats.q1, stats.median, stats.q3, stats.max, stats.lambda);
    }

    // Print Side channel histograms
    fprintf(stderr, "\nSide Channel Histograms:\n");
    for (int s = 0; s < num_subbands; s++) {
        char band_name[32];
        if (s == 0) {
            snprintf(band_name, sizeof(band_name), "LL (L%d)", stats_dwt_levels);
        } else {
            snprintf(band_name, sizeof(band_name), "H (L%d)", stats_dwt_levels - s + 1);
        }
        print_histogram(side_accumulators[s].data, side_accumulators[s].count, band_name);
    }

    // Print quantized values statistics
    fprintf(stderr, "\n=== TAD Quantized Values Statistics (after quantization) ===\n");

    // Print Mid channel quantized values
    fprintf(stderr, "\nMid Channel Quantized Values:\n");
    for (int s = 0; s < num_subbands; s++) {
        char band_name[32];
        if (s == 0) {
            snprintf(band_name, sizeof(band_name), "LL (L%d)", stats_dwt_levels);
        } else {
            snprintf(band_name, sizeof(band_name), "H (L%d)", stats_dwt_levels - s + 1);
        }
        print_top5_quantized_values(mid_quant_accumulators[s].data, mid_quant_accumulators[s].count, band_name);
    }

    // Print Side channel quantized values
    fprintf(stderr, "\nSide Channel Quantized Values:\n");
    for (int s = 0; s < num_subbands; s++) {
        char band_name[32];
        if (s == 0) {
            snprintf(band_name, sizeof(band_name), "LL (L%d)", stats_dwt_levels);
        } else {
            snprintf(band_name, sizeof(band_name), "H (L%d)", stats_dwt_levels - s + 1);
        }
        print_top5_quantized_values(side_quant_accumulators[s].data, side_quant_accumulators[s].count, band_name);
    }

    fprintf(stderr, "\n");
}

void tad32_free_statistics(void) {
    if (!stats_initialized) return;

    for (int i = 0; i < num_subbands; i++) {
        free(mid_accumulators[i].data);
        free(side_accumulators[i].data);
        free(mid_quant_accumulators[i].data);
        free(side_quant_accumulators[i].data);
    }
    free(mid_accumulators);
    free(side_accumulators);
    free(mid_quant_accumulators);
    free(side_quant_accumulators);

    mid_accumulators = NULL;
    side_accumulators = NULL;
    mid_quant_accumulators = NULL;
    side_quant_accumulators = NULL;
    stats_initialized = 0;
}

//=============================================================================
// Public API: Chunk Encoding
//=============================================================================

size_t tad32_encode_chunk(const float *pcm32_stereo, size_t num_samples,
                          int max_index, int use_zstd, int use_twobitmap,
                          float quantiser_scale, uint8_t *output) {
    // Calculate DWT levels from chunk size
    int dwt_levels = calculate_dwt_levels(num_samples);
    if (dwt_levels < 0) {
        fprintf(stderr, "Error: Invalid chunk size %zu\n", num_samples);
        return 0;
    }

    // Allocate working buffers (PCM32f throughout, int32 coefficients)
    float *pcm32_left = malloc(num_samples * sizeof(float));
    float *pcm32_right = malloc(num_samples * sizeof(float));
    float *pcm32_mid = malloc(num_samples * sizeof(float));
    float *pcm32_side = malloc(num_samples * sizeof(float));

    float *dwt_mid = malloc(num_samples * sizeof(float));
    float *dwt_side = malloc(num_samples * sizeof(float));

    int8_t *quant_mid = malloc(num_samples * sizeof(int8_t));
    int8_t *quant_side = malloc(num_samples * sizeof(int8_t));

    // Step 1: Deinterleave stereo
    for (size_t i = 0; i < num_samples; i++) {
        pcm32_left[i] = pcm32_stereo[i * 2];
        pcm32_right[i] = pcm32_stereo[i * 2 + 1];
    }

    // Step 1.1: Compress dynamic range
    compress_gamma(pcm32_left, pcm32_right, num_samples);

    // Step 2: M/S decorrelation
    ms_decorrelate(pcm32_left, pcm32_right, pcm32_mid, pcm32_side, num_samples);

    // Step 3: Convert to float and apply DWT
    for (size_t i = 0; i < num_samples; i++) {
        dwt_mid[i] = pcm32_mid[i];
        dwt_side[i] = pcm32_side[i];
    }

    dwt_dd4_forward_multilevel(dwt_mid, num_samples, dwt_levels);
    dwt_dd4_forward_multilevel(dwt_side, num_samples, dwt_levels);

    // Step 3.5: Accumulate coefficient statistics if enabled
    static int stats_enabled = -1;
    if (stats_enabled == -1) {
        stats_enabled = 1;//getenv("TAD_COEFF_STATS") != NULL;
        if (stats_enabled) {
            init_statistics(dwt_levels);
        }
    }
    if (stats_enabled) {
        accumulate_coefficients(dwt_mid, dwt_levels, num_samples, mid_accumulators);
        accumulate_coefficients(dwt_side, dwt_levels, num_samples, side_accumulators);
    }

    // Step 4: Quantize with frequency-dependent weights and quantiser scaling
    quantize_dwt_coefficients(dwt_mid, quant_mid, num_samples, 1, num_samples, dwt_levels, max_index, NULL, quantiser_scale);
    quantize_dwt_coefficients(dwt_side, quant_side, num_samples, 1, num_samples, dwt_levels, max_index, NULL, quantiser_scale);

    // Step 4.5: Accumulate quantized coefficient statistics if enabled
    if (stats_enabled) {
        accumulate_quantized(quant_mid, dwt_levels, num_samples, mid_quant_accumulators);
        accumulate_quantized(quant_side, dwt_levels, num_samples, side_quant_accumulators);
    }

    // Step 5: Encode with twobit-map significance map or raw int8_t storage
    uint8_t *temp_buffer = malloc(num_samples * 4);  // Generous buffer
    size_t mid_size, side_size;

    // Raw int8_t storage
    memcpy(temp_buffer, quant_mid, num_samples);
    mid_size = num_samples;
    memcpy(temp_buffer + mid_size, quant_side, num_samples);
    side_size = num_samples;

    size_t uncompressed_size = mid_size + side_size;

    // Step 6: Optional Zstd compression
    uint8_t *write_ptr = output;

    // Write chunk header
    *((uint16_t*)write_ptr) = (uint16_t)num_samples;
    write_ptr += sizeof(uint16_t);

    *write_ptr = (uint8_t)max_index;
    write_ptr += sizeof(uint8_t);

    uint32_t *payload_size_ptr = (uint32_t*)write_ptr;
    write_ptr += sizeof(uint32_t);

    size_t payload_size;

    if (use_zstd) {
        size_t zstd_bound = ZSTD_compressBound(uncompressed_size);
        uint8_t *zstd_buffer = malloc(zstd_bound);

        payload_size = ZSTD_compress(zstd_buffer, zstd_bound, temp_buffer, uncompressed_size, TAD32_ZSTD_LEVEL);

        if (ZSTD_isError(payload_size)) {
            fprintf(stderr, "Error: Zstd compression failed: %s\n", ZSTD_getErrorName(payload_size));
            free(zstd_buffer);
            free(pcm32_left); free(pcm32_right);
            free(pcm32_mid); free(pcm32_side); free(dwt_mid); free(dwt_side);
            free(quant_mid); free(quant_side); free(temp_buffer);
            return 0;
        }

        memcpy(write_ptr, zstd_buffer, payload_size);
        free(zstd_buffer);
    } else {
        payload_size = uncompressed_size;
        memcpy(write_ptr, temp_buffer, payload_size);
    }

    *payload_size_ptr = (uint32_t)payload_size;
    write_ptr += payload_size;

    // Cleanup
    free(pcm32_left); free(pcm32_right);
    free(pcm32_mid); free(pcm32_side); free(dwt_mid); free(dwt_side);
    free(quant_mid); free(quant_side); free(temp_buffer);

    return write_ptr - output;
}
