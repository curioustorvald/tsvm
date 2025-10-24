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

// Forward declarations for internal functions
static void dwt_dd4_forward_1d(float *data, int length);
static void dwt_dd4_forward_multilevel(float *data, int length, int levels);
static void ms_decorrelate_16(const float *left, const float *right, float *mid, float *side, size_t count);
static void get_quantization_weights(int quality, int dwt_levels, float *weights);
static int get_deadzone_threshold(int quality);
static void quantize_dwt_coefficients(const float *coeffs, int16_t *quantized, size_t count, int quality, int apply_deadzone, int chunk_size, int dwt_levels);
static size_t encode_sigmap_2bit(const int16_t *values, size_t count, uint8_t *output);

static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

// Calculate DWT levels from chunk size
static int calculate_dwt_levels(int chunk_size) {
    if (chunk_size < TAD32_MIN_CHUNK_SIZE) {
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

    return levels - 2;  // Maximum decomposition
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

// Apply multi-level DWT (using DD-4 wavelet)
static void dwt_dd4_forward_multilevel(float *data, int length, int levels) {
    int current_length = length;
    for (int level = 0; level < levels; level++) {
        dwt_dd4_forward_1d(data, current_length);
        current_length = (current_length + 1) / 2;
    }
}

//=============================================================================
// M/S Stereo Decorrelation (PCM32f version)
//=============================================================================

static void ms_decorrelate_16(const float *left, const float *right, float *mid, float *side, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // Mid = (L + R) / 2, Side = (L - R) / 2
        float l = left[i];
        float r = right[i];
        mid[i] = (l + r) / 2.0f;
        side[i] = (l - r) / 2.0f;
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

    float quality_scale = 4.0f * (1.0f + FCLAMP((4 - quality) * 0.5f, 0.0f, 1000.0f));

    for (int i = 0; i < dwt_levels; i++) {
        weights[i] = base_weights[dwt_levels][i] * quality_scale;
    }
}

static int get_deadzone_threshold(int quality) {
    const int thresholds[] = {0,0,0,0,0,0};  // Q0 to Q5
    return thresholds[quality];
}

static void quantize_dwt_coefficients(const float *coeffs, int16_t *quantized, size_t count, int quality, int apply_deadzone, int chunk_size, int dwt_levels) {
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

        int weight_idx = (sideband == 0) ? 0 : sideband - 1;
        if (weight_idx >= dwt_levels) weight_idx = dwt_levels - 1;

        float weight = weights[weight_idx];
        float val = coeffs[i] / weight * TAD32_COEFF_SCALAR;
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

//=============================================================================
// Significance Map Encoding
//=============================================================================

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

    // Step 2: M/S decorrelation
    ms_decorrelate_16(pcm32_left, pcm32_right, pcm32_mid, pcm32_side, num_samples);

    // Step 3: Convert to float and apply DWT
    for (size_t i = 0; i < num_samples; i++) {
        dwt_mid[i] = pcm32_mid[i];
        dwt_side[i] = pcm32_side[i];
    }

    dwt_dd4_forward_multilevel(dwt_mid, num_samples, dwt_levels);
    dwt_dd4_forward_multilevel(dwt_side, num_samples, dwt_levels);

    // Step 4: Quantize with frequency-dependent weights and dead zone
    quantize_dwt_coefficients(dwt_mid, quant_mid, num_samples, quality, 1, num_samples, dwt_levels);
    quantize_dwt_coefficients(dwt_side, quant_side, num_samples, quality, 1, num_samples, dwt_levels);

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
