// Created by CuriousTorvald and Claude on 2025-10-23.
// TAD (Terrarum Advanced Audio) Encoder Library - DWT-based audio compression
// This file contains only the encoding functions for use by encoder_tad.c and encoder_tav.c

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include "encoder_tad.h"

// Forward declarations for internal functions
static void dwt_haar_forward_1d(float *data, int length);
static void dwt_dd4_forward_1d(float *data, int length);
static void dwt_97_forward_1d(float *data, int length);
static void dwt_haar_forward_multilevel(float *data, int length, int levels);
static void ms_decorrelate(const int8_t *left, const int8_t *right, int8_t *mid, int8_t *side, size_t count);
static void convert_pcm16_to_pcm8_dithered(const int16_t *pcm16, int8_t *pcm8, int num_samples, int16_t *dither_error);
static void get_quantization_weights(int quality, int dwt_levels, float *weights);
static int get_deadzone_threshold(int quality);
static void quantize_dwt_coefficients(const float *coeffs, int16_t *quantized, size_t count, int quality, int apply_deadzone, int chunk_size, int dwt_levels);
static size_t encode_sigmap_2bit(const int16_t *values, size_t count, uint8_t *output);

static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

// Calculate DWT levels from chunk size (non-power-of-2 supported, >= 1024)
static int calculate_dwt_levels(int chunk_size) {
    if (chunk_size < TAD_MIN_CHUNK_SIZE) {
        fprintf(stderr, "Error: Chunk size %d is below minimum %d\n", chunk_size, TAD_MIN_CHUNK_SIZE);
        return -1;
    }

    // For non-power-of-2, find next power of 2 and calculate levels
    // Then subtract 2 for maximum decomposition
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

    return levels - 2;  // Maximum decomposition leaves 2-sample approximation
}

//=============================================================================
// Haar DWT Implementation
//=============================================================================

static void dwt_haar_forward_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Haar transform: compute averages (low-pass) and differences (high-pass)
    for (int i = 0; i < half; i++) {
        if (2 * i + 1 < length) {
            // Average of adjacent pairs (low-pass)
            temp[i] = (data[2 * i] + data[2 * i + 1]) / 2.0f;
            // Difference of adjacent pairs (high-pass)
            temp[half + i] = (data[2 * i] - data[2 * i + 1]) / 2.0f;
        } else {
            // Handle odd length: last sample goes to low-pass
            temp[i] = data[2 * i];
            if (half + i < length) {
                temp[half + i] = 0.0f;
            }
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

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
    int half = (length + 1) / 2;

    // Split into even/odd samples
    for (int i = 0; i < half; i++) {
        temp[i] = data[2 * i];           // Even (low)
    }
    for (int i = 0; i < length / 2; i++) {
        temp[half + i] = data[2 * i + 1]; // Odd (high)
    }

    // JPEG2000 9/7 forward lifting steps
    const float alpha = -1.586134342f;
    const float beta = -0.052980118f;
    const float gamma = 0.882911076f;
    const float delta = 0.443506852f;
    const float K = 1.230174105f;

    // Step 1: Predict α
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] += alpha * (s_curr + s_next);
        }
    }

    // Step 2: Update β
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] += beta * (d_prev + d_curr);
    }

    // Step 3: Predict γ
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] += gamma * (s_curr + s_next);
        }
    }

    // Step 4: Update δ
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] += delta * (d_prev + d_curr);
    }

    // Step 5: Scaling
    for (int i = 0; i < half; i++) {
        temp[i] *= K;
    }
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            temp[half + i] /= K;
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// Apply multi-level DWT (using DD-4 wavelet)
static void dwt_haar_forward_multilevel(float *data, int length, int levels) {
    int current_length = length;
    for (int level = 0; level < levels; level++) {
        dwt_dd4_forward_1d(data, current_length);
        current_length = (current_length + 1) / 2;
    }
}

//=============================================================================
// M/S Stereo Decorrelation
//=============================================================================

static void ms_decorrelate(const int8_t *left, const int8_t *right, int8_t *mid, int8_t *side, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // Mid = (L + R) / 2, Side = (L - R) / 2
        int32_t l = left[i];
        int32_t r = right[i];
        mid[i] = (int8_t)((l + r) / 2);
        side[i] = (int8_t)((l - r) / 2);
    }
}

//=============================================================================
// PCM16 to Signed PCM8 Conversion with Dithering
//=============================================================================

static void convert_pcm16_to_pcm8_dithered(const int16_t *pcm16, int8_t *pcm8, int num_samples, int16_t *dither_error) {
    for (int i = 0; i < num_samples; i++) {
        for (int ch = 0; ch < 2; ch++) {  // Stereo: L and R
            int idx = i * 2 + ch;
            int32_t sample = (int32_t)pcm16[idx];
            sample += dither_error[ch];
            int32_t quantized = sample >> 8;
            if (quantized < -128) quantized = -128;
            if (quantized > 127) quantized = 127;
            pcm8[idx] = (int8_t)quantized;
            dither_error[ch] = sample - (quantized << 8);
        }
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

    float quality_scale = 1.0f + FCLAMP((3 - quality) * 0.5f, 0.0f, 1000.0f);

    for (int i = 0; i < dwt_levels; i++) {
        weights[i] = FCLAMP(base_weights[dwt_levels][i] * quality_scale, 1.0f, 1000.0f);
    }
}

static int get_deadzone_threshold(int quality) {
    const int thresholds[] = {1,1,0,0,0,0};  // Q0 to Q5
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
        float val = coeffs[i] / weight;
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

size_t tad_encode_chunk(const int16_t *pcm16_stereo, size_t num_samples, int quality,
                        int use_zstd, uint8_t *output) {
    // Calculate DWT levels from chunk size
    int dwt_levels = calculate_dwt_levels(num_samples);
    if (dwt_levels < 0) {
        fprintf(stderr, "Error: Invalid chunk size %zu\n", num_samples);
        return 0;
    }

    // Allocate working buffers
    int8_t *pcm8_stereo = malloc(num_samples * 2 * sizeof(int8_t));
    int8_t *pcm8_left = malloc(num_samples * sizeof(int8_t));
    int8_t *pcm8_right = malloc(num_samples * sizeof(int8_t));
    int8_t *pcm8_mid = malloc(num_samples * sizeof(int8_t));
    int8_t *pcm8_side = malloc(num_samples * sizeof(int8_t));

    float *dwt_mid = malloc(num_samples * sizeof(float));
    float *dwt_side = malloc(num_samples * sizeof(float));

    int16_t *quant_mid = malloc(num_samples * sizeof(int16_t));
    int16_t *quant_side = malloc(num_samples * sizeof(int16_t));

    // Step 1: Convert PCM16 to signed PCM8 with dithering
    int16_t dither_error[2] = {0, 0};
    convert_pcm16_to_pcm8_dithered(pcm16_stereo, pcm8_stereo, num_samples, dither_error);

    // Deinterleave stereo
    for (size_t i = 0; i < num_samples; i++) {
        pcm8_left[i] = pcm8_stereo[i * 2];
        pcm8_right[i] = pcm8_stereo[i * 2 + 1];
    }

    // Step 2: M/S decorrelation
    ms_decorrelate(pcm8_left, pcm8_right, pcm8_mid, pcm8_side, num_samples);

    // Step 3: Convert to float and apply DWT
    for (size_t i = 0; i < num_samples; i++) {
        dwt_mid[i] = (float)pcm8_mid[i];
        dwt_side[i] = (float)pcm8_side[i];
    }

    dwt_haar_forward_multilevel(dwt_mid, num_samples, dwt_levels);
    dwt_haar_forward_multilevel(dwt_side, num_samples, dwt_levels);

    // Step 4: Quantize with frequency-dependent weights and dead zone
    quantize_dwt_coefficients(dwt_mid, quant_mid, num_samples, quality, 1, num_samples, dwt_levels);
    quantize_dwt_coefficients(dwt_side, quant_side, num_samples, quality, 1, num_samples, dwt_levels);

    // Step 5: Encode with 2-bit significance map
    uint8_t *temp_buffer = malloc(num_samples * 4 * sizeof(int16_t));
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

        payload_size = ZSTD_compress(zstd_buffer, zstd_bound, temp_buffer, uncompressed_size, TAD_ZSTD_LEVEL);

        if (ZSTD_isError(payload_size)) {
            fprintf(stderr, "Error: Zstd compression failed: %s\n", ZSTD_getErrorName(payload_size));
            free(zstd_buffer);
            free(pcm8_stereo); free(pcm8_left); free(pcm8_right);
            free(pcm8_mid); free(pcm8_side); free(dwt_mid); free(dwt_side);
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
    free(pcm8_stereo); free(pcm8_left); free(pcm8_right);
    free(pcm8_mid); free(pcm8_side); free(dwt_mid); free(dwt_side);
    free(quant_mid); free(quant_side); free(temp_buffer);

    return write_ptr - output;
}
