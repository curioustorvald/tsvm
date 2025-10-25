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

// Forward declarations for internal functions
static void dwt_dd4_forward_1d(float *data, int length);
static void dwt_dd4_forward_multilevel(float *data, int length, int levels);
static void ms_decorrelate_16(const float *left, const float *right, float *mid, float *side, size_t count);
static void get_quantization_weights(int quality, int dwt_levels, float *weights);
static int get_deadzone_threshold(int quality);
static void quantize_dwt_coefficients(const float *coeffs, int16_t *quantized, size_t count, int quality, int apply_deadzone, int chunk_size, int dwt_levels, int *current_subband_index);
static size_t encode_sigmap_2bit(const int16_t *values, size_t count, uint8_t *output);

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

//=============================================================================
// Quantization with Frequency-Dependent Weighting
//=============================================================================

static void get_quantization_weights(int quality, int dwt_levels, float *weights) {
    const float base_weights[16][16] = {
        /* 0*/{1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f},
        /* 1*/{1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f},
        /* 2*/{1.0f, 1.0f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /* 3*/{0.2f, 1.0f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /* 4*/{0.2f, 0.8f, 1.0f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /* 5*/{0.2f, 0.8f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /* 6*/{0.2f, 0.2f, 0.8f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /* 7*/{0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /* 8*/{0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /* 9*/{0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /*10*/{0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /*11*/{0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /*12*/{0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f},
        /*13*/{0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f},
        /*14*/{0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f},
        /*15*/{0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f}
    };

    float quality_scale = 1.0f * (1.0f + FCLAMP((5 - quality) * 0.5f, 0.0f, 1000.0f));

    for (int i = 0; i < dwt_levels; i++) {
        weights[i] = 1.0f;//base_weights[dwt_levels][i] * quality_scale;
    }
}

#define QUANT_STEPS 512.0f // 64 -> [-64..64] -> 7 bits for LL

static int get_deadzone_threshold(int quality) {
    const int thresholds[] = {0,0,0,0,0,0};  // Q0 to Q5
    return thresholds[quality];
}

static void quantize_dwt_coefficients(const float *coeffs, int16_t *quantized, size_t count, int quality, int apply_deadzone, int chunk_size, int dwt_levels, int *current_subband_index) {
    float weights[16];
    get_quantization_weights(quality, dwt_levels, weights);
    int deadzone = apply_deadzone ? get_deadzone_threshold(quality) : 0;

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

        int weight_idx = (sideband == 0) ? 0 : sideband - 1;
        if (weight_idx >= dwt_levels) weight_idx = dwt_levels - 1;

        float weight = weights[weight_idx];
        float val = (coeffs[i] / TAD32_COEFF_SCALARS[sideband]) * (QUANT_STEPS * weight);
        // (coeffs[i] / TAD32_COEFF_SCALARS[sideband]) normalises coeffs to -1..1
        int16_t quant_val = (int16_t)roundf(val);

        if (apply_deadzone && sideband >= dwt_levels - 1) {
            if (quant_val > -deadzone && quant_val < deadzone) {
                quant_val = 0;
            }
        }

        quantized[i] = quant_val;
    }

    free(sideband_starts);
}

// idea 1: power-of-two companding
// for quant step 8:
// Q -> Float
// 0 -> 0
// 1 -> 1/128
// 2 -> 1/64
// 3 -> 1/32
// 4 -> 1/16
// 5 -> 1/8
// 6 -> 1/4
// 7 -> 1/2
// 8 -> 1/1
// for -1 to -8, just invert the sign


//=============================================================================
// Significance Map Encoding
//=============================================================================

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
} CoeffStats;

typedef struct {
    float *data;
    size_t count;
    size_t capacity;
} CoeffAccumulator;

// Global accumulators for statistics
static CoeffAccumulator *mid_accumulators = NULL;
static CoeffAccumulator *side_accumulators = NULL;
static int num_subbands = 0;
static int stats_initialized = 0;
static int stats_dwt_levels = 0;

static void init_statistics(int dwt_levels) {
    if (stats_initialized) return;

    num_subbands = dwt_levels + 1;
    stats_dwt_levels = dwt_levels;

    mid_accumulators = calloc(num_subbands, sizeof(CoeffAccumulator));
    side_accumulators = calloc(num_subbands, sizeof(CoeffAccumulator));

    for (int i = 0; i < num_subbands; i++) {
        mid_accumulators[i].capacity = 1024;
        mid_accumulators[i].data = malloc(mid_accumulators[i].capacity * sizeof(float));
        mid_accumulators[i].count = 0;

        side_accumulators[i].capacity = 1024;
        side_accumulators[i].data = malloc(side_accumulators[i].capacity * sizeof(float));
        side_accumulators[i].count = 0;
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

static void calculate_coeff_stats(const float *coeffs, size_t count, CoeffStats *stats) {
    if (count == 0) {
        stats->min = stats->q1 = stats->median = stats->q3 = stats->max = 0.0f;
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

void tad32_print_statistics(void) {
    if (!stats_initialized) return;

    fprintf(stderr, "\n=== TAD Coefficient Statistics (before quantization) ===\n");

    // Print Mid channel statistics
    fprintf(stderr, "\nMid Channel:\n");
    fprintf(stderr, "%-12s %10s %10s %10s %10s %10s %10s\n",
            "Subband", "Samples", "Min", "Q1", "Median", "Q3", "Max");
    fprintf(stderr, "--------------------------------------------------------------------------------\n");

    for (int s = 0; s < num_subbands; s++) {
        CoeffStats stats;
        calculate_coeff_stats(mid_accumulators[s].data, mid_accumulators[s].count, &stats);

        char band_name[16];
        if (s == 0) {
            snprintf(band_name, sizeof(band_name), "LL (L%d)", stats_dwt_levels);
        } else {
            snprintf(band_name, sizeof(band_name), "H (L%d)", stats_dwt_levels - s + 1);
        }

        fprintf(stderr, "%-12s %10zu %10.3f %10.3f %10.3f %10.3f %10.3f\n",
                band_name, mid_accumulators[s].count,
                stats.min, stats.q1, stats.median, stats.q3, stats.max);
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
    fprintf(stderr, "%-12s %10s %10s %10s %10s %10s %10s\n",
            "Subband", "Samples", "Min", "Q1", "Median", "Q3", "Max");
    fprintf(stderr, "--------------------------------------------------------------------------------\n");

    for (int s = 0; s < num_subbands; s++) {
        CoeffStats stats;
        calculate_coeff_stats(side_accumulators[s].data, side_accumulators[s].count, &stats);

        char band_name[16];
        if (s == 0) {
            snprintf(band_name, sizeof(band_name), "LL (L%d)", stats_dwt_levels);
        } else {
            snprintf(band_name, sizeof(band_name), "H (L%d)", stats_dwt_levels - s + 1);
        }

        fprintf(stderr, "%-12s %10zu %10.3f %10.3f %10.3f %10.3f %10.3f\n",
                band_name, side_accumulators[s].count,
                stats.min, stats.q1, stats.median, stats.q3, stats.max);
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

    fprintf(stderr, "\n");
}

void tad32_free_statistics(void) {
    if (!stats_initialized) return;

    for (int i = 0; i < num_subbands; i++) {
        free(mid_accumulators[i].data);
        free(side_accumulators[i].data);
    }
    free(mid_accumulators);
    free(side_accumulators);

    mid_accumulators = NULL;
    side_accumulators = NULL;
    stats_initialized = 0;
}

static size_t encode_sigmap_2bit(const int16_t *values, size_t count, uint8_t *output) {
    size_t map_bytes = (count * 2 + 7) / 8;
    uint8_t *map = output;
    memset(map, 0, map_bytes);

    uint8_t *write_ptr = output + map_bytes;
    int16_t *value_ptr = (int16_t*)write_ptr;
    uint32_t other_count = 0;

    for (size_t i = 0; i < count; i++) {
        int16_t val = values[i];
        uint8_t code;

        if (val == 0) code = 0;       // 00
        else if (val == 1) code = 1;  // 01
        else if (val == -1) code = 2; // 10
        else {
            code = 3;  // 11
            value_ptr[other_count++] = val;
        }

        size_t bit_pos = i * 2;
        size_t byte_idx = bit_pos / 8;
        size_t bit_offset = bit_pos % 8;

        map[byte_idx] |= (code << bit_offset);
        if (bit_offset == 7 && byte_idx + 1 < map_bytes) {
            map[byte_idx + 1] |= (code >> 1);
        }
    }

    return map_bytes + other_count * sizeof(int16_t);
}

//=============================================================================
// Public API: Chunk Encoding
//=============================================================================

size_t tad32_encode_chunk(const float *pcm32_stereo, size_t num_samples, int quality,
                          int use_zstd, uint8_t *output) {
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

    int16_t *quant_mid = malloc(num_samples * sizeof(int16_t));
    int16_t *quant_side = malloc(num_samples * sizeof(int16_t));

    // Step 1: Deinterleave stereo
    for (size_t i = 0; i < num_samples; i++) {
        pcm32_left[i] = pcm32_stereo[i * 2];
        pcm32_right[i] = pcm32_stereo[i * 2 + 1];
    }

    // Step 1.1: Compress dynamic range
//    compress_gamma(pcm32_left, pcm32_right, num_samples);

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

    // Step 4: Quantize with frequency-dependent weights and dead zone
    quantize_dwt_coefficients(dwt_mid, quant_mid, num_samples, quality, 1, num_samples, dwt_levels, NULL);
    quantize_dwt_coefficients(dwt_side, quant_side, num_samples, quality, 1, num_samples, dwt_levels, NULL);

    // Step 5: Encode with 2-bit significance map (32-bit version)
    uint8_t *temp_buffer = malloc(num_samples * 4 * sizeof(int32_t));
    size_t mid_size = encode_sigmap_2bit(quant_mid, num_samples, temp_buffer);
    size_t side_size = encode_sigmap_2bit(quant_side, num_samples, temp_buffer + mid_size);

    size_t uncompressed_size = mid_size + side_size;

    // Step 6: Optional Zstd compression
    uint8_t *write_ptr = output;

    *((uint16_t*)write_ptr) = (uint16_t)num_samples;
    write_ptr += sizeof(uint16_t);

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
