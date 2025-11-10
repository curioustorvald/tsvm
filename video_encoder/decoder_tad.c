// Created by CuriousTorvald and Claude on 2025-10-23.
// TAD (Terrarum Advanced Audio) Decoder - Reconstructs audio from TAD format

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include <getopt.h>
#include "encoder_tad.h"

#define DECODER_VENDOR_STRING "Decoder-TAD 20251026"

// TAD format constants (must match encoder)
#undef TAD32_COEFF_SCALARS

// Coefficient scalars for each subband (CDF 9/7 with 9 decomposition levels)
// Index 0 = LL band, Index 1-9 = H bands (L9 to L1)
static const float TAD32_COEFF_SCALARS[] = {64.0f, 45.255f, 32.0f, 22.627f, 16.0f, 11.314f, 8.0f, 5.657f, 4.0f, 2.828f};

// Base quantiser weight table (10 subbands: LL + 9 H bands)
// These weights are multiplied by quantiser_scale during quantization
static const float BASE_QUANTISER_WEIGHTS[2][10] = {
{ // mid channel
    4.0f,    // LL (L9) DC
    2.0f,    // H (L9) 31.25 hz
    1.8f,    // H (L8) 62.5 hz
    1.6f,    // H (L7) 125 hz
    1.4f,    // H (L6) 250 hz
    1.2f,    // H (L5) 500 hz
    1.0f,    // H (L4) 1 khz
    1.0f,    // H (L3) 2 khz
    1.3f,    // H (L2) 4 khz
    2.0f     // H (L1) 8 khz
},
{ // side channel
    6.0f,    // LL (L9) DC
    5.0f,    // H (L9) 31.25 hz
    2.6f,    // H (L8) 62.5 hz
    2.4f,    // H (L7) 125 hz
    1.8f,    // H (L6) 250 hz
    1.3f,    // H (L5) 500 hz
    1.0f,    // H (L4) 1 khz
    1.0f,    // H (L3) 2 khz
    1.6f,    // H (L2) 4 khz
    3.2f     // H (L1) 8 khz
}};

#define TAD_DEFAULT_CHUNK_SIZE 31991
#define TAD_MIN_CHUNK_SIZE 1024
#define TAD_SAMPLE_RATE 32000
#define TAD_CHANNELS 2

// Significance map methods
#define TAD_SIGMAP_1BIT 0
#define TAD_SIGMAP_2BIT 1
#define TAD_SIGMAP_RLE  2

// Quality levels
#define TAD_QUALITY_MIN 0
#define TAD_QUALITY_MAX 5

static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

//=============================================================================
// Spectral Interpolation for Coefficient Reconstruction
//=============================================================================

// Fast PRNG for light dithering (xorshift32)
static inline uint32_t xorshift32(uint32_t *s) {
    uint32_t x = *s;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return *s = x;
}

static inline float urand(uint32_t *s) {
    return (xorshift32(s) & 0xFFFFFF) / 16777216.0f;
}

static inline float tpdf(uint32_t *s) {
    return urand(s) - urand(s);
}

// Compute RMS energy of a coefficient band
static float compute_band_rms(const float *c, size_t len) {
    if (len == 0) return 0.0f;
    double sumsq = 0.0;
    for (size_t i = 0; i < len; i++) {
        sumsq += (double)c[i] * c[i];
    }
    return sqrtf((float)(sumsq / (double)len));
}

// Simplified spectral reconstruction for wavelet coefficients
// Conservative approach: only interpolate obvious holes, add light dither
// Avoids aggressive AR prediction that can create artifacts
static void spectral_interpolate_band(float *c, size_t len, float Q, float lower_band_rms) {
    if (len < 4) return;

    uint32_t seed = 0x9E3779B9u ^ (uint32_t)len ^ (uint32_t)(Q * 65536.0f);
    const float dither_amp = 0.02f * Q;  // Very light dither

    // Just add ultra-light TPDF dither to reduce quantization grain
    // No aggressive hole filling or AR prediction that might create artifacts
    for (size_t i = 0; i < len; i++) {
        c[i] += tpdf(&seed) * dither_amp;
    }

    (void)lower_band_rms;  // Unused for now - conservative approach
}

//=============================================================================
// WAV Header Writing
//=============================================================================

static void write_wav_header(FILE *output, uint32_t data_size, uint16_t channels, uint32_t sample_rate, uint16_t bits_per_sample) {
    uint32_t byte_rate = sample_rate * channels * bits_per_sample / 8;
    uint16_t block_align = channels * bits_per_sample / 8;
    uint32_t chunk_size = 36 + data_size;

    // RIFF header
    fwrite("RIFF", 1, 4, output);
    fwrite(&chunk_size, 4, 1, output);
    fwrite("WAVE", 1, 4, output);

    // fmt chunk
    fwrite("fmt ", 1, 4, output);
    uint32_t fmt_size = 16;
    fwrite(&fmt_size, 4, 1, output);
    uint16_t audio_format = 1;  // PCM
    fwrite(&audio_format, 2, 1, output);
    fwrite(&channels, 2, 1, output);
    fwrite(&sample_rate, 4, 1, output);
    fwrite(&byte_rate, 4, 1, output);
    fwrite(&block_align, 2, 1, output);
    fwrite(&bits_per_sample, 2, 1, output);

    // data chunk header
    fwrite("data", 1, 4, output);
    fwrite(&data_size, 4, 1, output);
}

// Calculate DWT levels from chunk size (must be power of 2, >= 1024)
static int calculate_dwt_levels(int chunk_size) {
    /*if (chunk_size < TAD_MIN_CHUNK_SIZE) {
        fprintf(stderr, "Error: Chunk size %d is below minimum %d\n", chunk_size, TAD_MIN_CHUNK_SIZE);
        return -1;
    }

    // Calculate levels: log2(chunk_size) - 1
    int levels = 0;
    int size = chunk_size;
    while (size > 1) {
        size >>= 1;
        levels++;
    }
    return levels - 2;*/
    return 9;
}

//=============================================================================
// Stochastic Reconstruction for Deadzoned Coefficients
//=============================================================================

// Special marker for deadzoned coefficients (must match encoder)
#define DEADZONE_MARKER_QUANT (-128)

// Deadband thresholds (must match encoder)
static const float DEADBANDS[2][10] = {
{ // mid channel
    0.20f,    // LL (L9) DC
    0.06f,    // H (L9) 31.25 hz
    0.06f,    // H (L8) 62.5 hz
    0.06f,    // H (L7) 125 hz
    0.06f,    // H (L6) 250 hz
    0.04f,    // H (L5) 500 hz
    0.04f,    // H (L4) 1 khz
    0.01f,    // H (L3) 2 khz
    0.01f,    // H (L2) 4 khz
    0.01f     // H (L1) 8 khz
},
{ // side channel
    0.20f,    // LL (L9) DC
    0.06f,    // H (L9) 31.25 hz
    0.06f,    // H (L8) 62.5 hz
    0.06f,    // H (L7) 125 hz
    0.06f,    // H (L6) 250 hz
    0.04f,    // H (L5) 500 hz
    0.04f,    // H (L4) 1 khz
    0.01f,    // H (L3) 2 khz
    0.01f,    // H (L2) 4 khz
    0.01f     // H (L1) 8 khz
}};

// Fast PRNG state (xorshift32) for stochastic reconstruction
static uint32_t deadzone_rng_state = 0x12345678u;

// Laplacian-distributed noise (better approximation than TPDF)
// Uses inverse CDF method: X = -sign(U) * ln(1 - 2*|U|) / λ
static float laplacian_noise(float scale) {
    float u = urand(&deadzone_rng_state) - 0.5f;  // [-0.5, 0.5)
    float sign = (u >= 0.0f) ? 1.0f : -1.0f;
    float abs_u = fabsf(u);

    // Avoid log(0) by clamping
    if (abs_u >= 0.49999f) abs_u = 0.49999f;

    // Inverse Laplacian CDF with λ = 1/scale
    float x = -sign * logf(1.0f - 2.0f * abs_u) * scale;

    return x;
}

//=============================================================================
// Haar DWT Implementation (inverse only needed for decoder)
//=============================================================================

static void dwt_haar_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    for (int i = 0; i < half; i++) {
        if (2 * i + 1 < length) {
            temp[2 * i] = data[i] + data[half + i];
            temp[2 * i + 1] = data[i] - data[half + i];
        } else {
            temp[2 * i] = data[i];
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// 9/7 inverse DWT (from TSVM Kotlin code)
static void dwt_97_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Split into low and high frequency components (matching TSVM layout)
    for (int i = 0; i < half; i++) {
        temp[i] = data[i];  // Low-pass coefficients (first half)
    }
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            temp[half + i] = data[half + i];  // High-pass coefficients (second half)
        }
    }

    // 9/7 inverse lifting coefficients from TSVM
    const float alpha = -1.586134342f;
    const float beta = -0.052980118f;
    const float gamma = 0.882911076f;
    const float delta = 0.443506852f;
    const float K = 1.230174105f;

    // Step 1: Undo scaling
    for (int i = 0; i < half; i++) {
        temp[i] /= K;  // Low-pass coefficients
    }
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            temp[half + i] *= K;  // High-pass coefficients
        }
    }

    // Step 2: Undo δ update
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] -= delta * (d_curr + d_prev);
    }

    // Step 3: Undo γ predict
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] -= gamma * (s_curr + s_next);
        }
    }

    // Step 4: Undo β update
    for (int i = 0; i < half; i++) {
        float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && half + i - 1 < length) ? temp[half + i - 1] : d_curr;
        temp[i] -= beta * (d_curr + d_prev);
    }

    // Step 5: Undo α predict
    for (int i = 0; i < length / 2; i++) {
        if (half + i < length) {
            float s_curr = temp[i];
            float s_next = (i + 1 < half) ? temp[i + 1] : s_curr;
            temp[half + i] -= alpha * (s_curr + s_next);
        }
    }

    // Reconstruction - interleave low and high pass
    for (int i = 0; i < length; i++) {
        if (i % 2 == 0) {
            // Even positions: low-pass coefficients
            data[i] = temp[i / 2];
        } else {
            // Odd positions: high-pass coefficients
            int idx = i / 2;
            if (half + idx < length) {
                data[i] = temp[half + idx];
            } else {
                data[i] = 0.0f;
            }
        }
    }

    free(temp);
}

// Inverse 1D transform of Four-point interpolating Deslauriers-Dubuc (DD-4)
static void dwt_dd4_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Split into low (even) and high (odd) parts
    for (int i = 0; i < half; i++) {
        temp[i] = data[i];               // Even (low-pass)
    }
    for (int i = 0; i < length / 2; i++) {
        temp[half + i] = data[half + i]; // Odd (high-pass)
    }

    // Undo update step: s[i] -= 0.25 * (d[i-1] + d[i])
    for (int i = 0; i < half; i++) {
        float d_curr = (i < length / 2) ? temp[half + i] : 0.0f;
        float d_prev = (i > 0 && i - 1 < length / 2) ? temp[half + i - 1] : 0.0f;
        temp[i] -= 0.25f * (d_prev + d_curr);
    }

    // Undo prediction step: d[i] += P(s[i-1], s[i], s[i+1], s[i+2])
    for (int i = 0; i < length / 2; i++) {
        float s_m1, s_0, s_1, s_2;

        if (i > 0) s_m1 = temp[i - 1];
        else s_m1 = temp[0];  // mirror boundary

        s_0 = temp[i];

        if (i + 1 < half) s_1 = temp[i + 1];
        else s_1 = temp[half - 1];

        if (i + 2 < half) s_2 = temp[i + 2];
        else if (half > 1) s_2 = temp[half - 2];
        else s_2 = temp[half - 1];

        float prediction = (-1.0f/16.0f)*s_m1 + (9.0f/16.0f)*s_0 +
                           (9.0f/16.0f)*s_1 + (-1.0f/16.0f)*s_2;

        temp[half + i] += prediction;
    }

    // Merge evens and odds back into the original order
    for (int i = 0; i < half; i++) {
        data[2 * i] = temp[i];
        if (2 * i + 1 < length)
            data[2 * i + 1] = temp[half + i];
    }

    free(temp);
}

static void dwt_inverse_multilevel(float *data, int length, int levels) {
    // Pre-calculate all intermediate lengths used during forward transform
    // Forward uses: data[0..length-1], then data[0..(length+1)/2-1], etc.
    int *lengths = malloc((levels + 1) * sizeof(int));
    lengths[0] = length;
    for (int i = 1; i <= levels; i++) {
        lengths[i] = (lengths[i - 1] + 1) / 2;
    }

    // Inverse transform: apply inverse DWT using exact forward lengths in reverse order
    // Forward applied DWT with lengths: [length, (length+1)/2, ((length+1)/2+1)/2, ...]
    // Inverse must use same lengths in reverse: [..., ((length+1)/2+1)/2, (length+1)/2, length]
    for (int level = levels - 1; level >= 0; level--) {
        int current_length = lengths[level];
//        dwt_haar_inverse_1d(data, current_length);  // THEN apply inverse
//        dwt_dd4_inverse_1d(data, current_length);  // THEN apply inverse
        dwt_97_inverse_1d(data, current_length);  // THEN apply inverse
    }

    free(lengths);
}

//=============================================================================
// M/S Stereo Correlation (inverse of decorrelation)
//=============================================================================

// Uniform random in [0, 1)
static inline float frand01(void) {
    return (float)rand() / ((float)RAND_MAX + 1.0f);
}

// TPDF noise in [-1, +1)
static inline float tpdf1(void) {
    return (frand01() - frand01());
}

static void ms_correlate(const float *mid, const float *side, float *left, float *right, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // Decode M/S → L/R
        float m = mid[i];
        float s = side[i];
        left[i] = FCLAMP((m + s), -1.0f, 1.0f);
        right[i] = FCLAMP((m - s), -1.0f, 1.0f);
    }
}

static float signum(float x) {
    if (x > 0.0f) return 1.0f;
    if (x < 0.0f) return -1.0f;
    return 0.0f;
}

static void expand_gamma(float *left, float *right, size_t count) {
    for (size_t i = 0; i < count; i++) {
        // decode(y) = sign(y) * |y|^(1/γ) where γ=0.5
        float x = left[i]; float a = fabsf(x);
        left[i] = signum(x) * a * a;
        float y = right[i]; float b = fabsf(y);
        right[i] = signum(y) * b * b;
    }
}

static void expand_mu_law(float *left, float *right, size_t count) {
    static float MU = 255.0f;

    for (size_t i = 0; i < count; i++) {
        // decode(y) = sign(y) * |y|^(1/γ) where γ=0.5
        float x = left[i];
        left[i] = signum(x) * (powf(1.0f + MU, fabsf(x)) - 1.0f) / MU;
        float y = right[i];
        right[i] = signum(y) * (powf(1.0f + MU, fabsf(y)) - 1.0f) / MU;
    }
}

//=============================================================================
// De-emphasis Filter
//=============================================================================

static void calculate_deemphasis_coeffs(float *b0, float *b1, float *a1) {
    // De-emphasis factor
    const float alpha = 0.5f;

    *b0 = 1.0f;
    *b1 = 0.0f;  // No feedforward delay
    *a1 = -alpha;  // NEGATIVE because equation has minus sign: y = x - a1*prev_y
}

static void apply_deemphasis(float *left, float *right, size_t count) {
    // Static state variables - persistent across chunks to prevent discontinuities
    static float prev_x_l = 0.0f;
    static float prev_y_l = 0.0f;
    static float prev_x_r = 0.0f;
    static float prev_y_r = 0.0f;

    float b0, b1, a1;
    calculate_deemphasis_coeffs(&b0, &b1, &a1);

    // Left channel - use persistent state
    for (size_t i = 0; i < count; i++) {
        float x = left[i];
        float y = b0 * x + b1 * prev_x_l - a1 * prev_y_l;
        left[i] = y;
        prev_x_l = x;
        prev_y_l = y;
    }

    // Right channel - use persistent state
    for (size_t i = 0; i < count; i++) {
        float x = right[i];
        float y = b0 * x + b1 * prev_x_r - a1 * prev_y_r;
        right[i] = y;
        prev_x_r = x;
        prev_y_r = y;
    }
}

static void pcm32f_to_pcm8(const float *fleft, const float *fright, uint8_t *left, uint8_t *right, size_t count, float dither_error[2][2]) {
    const float b1 = 1.5f;   // 1st feedback coefficient
    const float b2 = -0.75f; // 2nd feedback coefficient
    const float scale = 127.5f;
    const float bias  = 128.0f;

    // Reduced dither amplitude to coordinate with coefficient-domain dithering
    // The decoder now adds TPDF dither in coefficient domain, so we reduce
    // sample-domain dither by ~60% to avoid doubling the noise floor
    const float dither_scale = 0.2f;  // Reduced from 0.5 (was ±0.5 LSB, now ±0.2 LSB)

    for (size_t i = 0; i < count; i++) {
        // --- LEFT channel ---
        float feedbackL = b1 * dither_error[0][0] + b2 * dither_error[0][1];
        float ditherL = dither_scale * tpdf1(); // Reduced TPDF dither
        float shapedL = fleft[i] + feedbackL + ditherL / scale;
        shapedL = FCLAMP(shapedL, -1.0f, 1.0f);

        int qL = (int)lrintf(shapedL * scale);
        if (qL < -128) qL = -128;
        else if (qL > 127) qL = 127;
        left[i] = (uint8_t)(qL + bias);

        float qerrL = shapedL - (float)qL / scale;
        dither_error[0][1] = dither_error[0][0]; // shift history
        dither_error[0][0] = qerrL;

        // --- RIGHT channel ---
        float feedbackR = b1 * dither_error[1][0] + b2 * dither_error[1][1];
        float ditherR = dither_scale * tpdf1(); // Reduced TPDF dither
        float shapedR = fright[i] + feedbackR + ditherR / scale;
        shapedR = FCLAMP(shapedR, -1.0f, 1.0f);

        int qR = (int)lrintf(shapedR * scale);
        if (qR < -128) qR = -128;
        else if (qR > 127) qR = 127;
        right[i] = (uint8_t)(qR + bias);

        float qerrR = shapedR - (float)qR / scale;
        dither_error[1][1] = dither_error[1][0];
        dither_error[1][0] = qerrR;
    }
}

//=============================================================================
// Dequantization (inverse of quantization)
//=============================================================================


#define LAMBDA_FIXED 6.0f

// Lambda-based decompanding decoder (inverse of Laplacian CDF-based encoder)
// Converts quantized index back to normalized float in [-1, 1]
static float lambda_decompanding(int8_t quant_val, int max_index) {
    // Handle zero
    if (quant_val == 0) {
        return 0.0f;
    }

    int sign = (quant_val < 0) ? -1 : 1;
    int abs_index = abs(quant_val);

    // Clamp to valid range
    if (abs_index > max_index) abs_index = max_index;

    // Map index back to normalized CDF [0, 1]
    float normalized_cdf = (float)abs_index / max_index;

    // Map from [0, 1] back to [0.5, 1.0] (CDF range for positive half)
    float cdf = 0.5f + normalized_cdf * 0.5f;

    // Inverse Laplacian CDF for x >= 0: x = -(1/λ) * ln(2*(1-F))
    // For F in [0.5, 1.0]: x = -(1/λ) * ln(2*(1-F))
    float abs_val = -(1.0f / LAMBDA_FIXED) * logf(2.0f * (1.0f - cdf));

    // Clamp to [0, 1]
    if (abs_val > 1.0f) abs_val = 1.0f;
    if (abs_val < 0.0f) abs_val = 0.0f;

    return sign * abs_val;
}

static void dequantize_dwt_coefficients(int channel, const int8_t *quantized, float *coeffs, size_t count, int chunk_size, int dwt_levels, int max_index, float quantiser_scale) {

    // Calculate sideband boundaries dynamically
    int first_band_size = chunk_size >> dwt_levels;

    int *sideband_starts = malloc((dwt_levels + 2) * sizeof(int));
    sideband_starts[0] = 0;
    sideband_starts[1] = first_band_size;
    for (int i = 2; i <= dwt_levels + 1; i++) {
        sideband_starts[i] = sideband_starts[i-1] + (first_band_size << (i-2));
    }

    // Dequantize all coefficients with stochastic reconstruction for deadzoned values
    for (size_t i = 0; i < count; i++) {
        int sideband = dwt_levels;
        for (int s = 0; s <= dwt_levels; s++) {
            if (i < sideband_starts[s + 1]) {
                sideband = s;
                break;
            }
        }

        // Check for deadzone marker
        /*if (quantized[i] == (int8_t)0) {//DEADZONE_MARKER_QUANT) {
            // Stochastic reconstruction: generate Laplacian noise in deadband range
            float deadband_threshold = DEADBANDS[channel][sideband];

            // Generate Laplacian-distributed noise scaled to deadband width
            // Use scale = threshold/3 to keep ~99% of samples within [-threshold, +threshold]
            float noise = tpdf1() * deadband_threshold / 10.0f;

            // Clamp to deadband range
            if (noise > deadband_threshold) noise = deadband_threshold;
            if (noise < -deadband_threshold) noise = -deadband_threshold;

            // Apply scalar (but not quantiser weight - noise is already in correct range)
            coeffs[i] = noise * TAD32_COEFF_SCALARS[sideband];
        } else {*/
            // Normal dequantization using lambda decompanding
            float normalized_val = lambda_decompanding(quantized[i], max_index);

            // Denormalize using the subband scalar and apply base weight + quantiser scaling
            float weight = BASE_QUANTISER_WEIGHTS[channel][sideband] * quantiser_scale;
            coeffs[i] = normalized_val * TAD32_COEFF_SCALARS[sideband] * weight;
//        }
    }

    // Note: Stochastic reconstruction replaces the old spectral interpolation step
    // No need for additional processing - deadzoned coefficients already have appropriate noise

    free(sideband_starts);
}

//=============================================================================
// Binary Tree EZBC Decoder (1D Variant for TAD)
//=============================================================================

#include <stdbool.h>

// Bitstream reader for EZBC
typedef struct {
    const uint8_t *data;
    size_t size;
    size_t byte_pos;
    uint8_t bit_pos;  // 0-7, current bit position in current byte
} tad_bitstream_reader_t;

// Block structure for 1D binary tree (same as encoder)
typedef struct {
    int start;
    int length;
} tad_decode_block_t;

// Queue for block processing (same as encoder)
typedef struct {
    tad_decode_block_t *blocks;
    size_t count;
    size_t capacity;
} tad_decode_queue_t;

// Track coefficient state for refinement
typedef struct {
    bool significant;
    int first_bitplane;
} tad_decode_state_t;

// Bitstream read operations
static void tad_bitstream_reader_init(tad_bitstream_reader_t *bs, const uint8_t *data, size_t size) {
    bs->data = data;
    bs->size = size;
    bs->byte_pos = 0;
    bs->bit_pos = 0;
}

static int tad_bitstream_read_bit(tad_bitstream_reader_t *bs) {
    if (bs->byte_pos >= bs->size) {
        fprintf(stderr, "Error: Bitstream underflow\n");
        return 0;
    }

    int bit = (bs->data[bs->byte_pos] >> bs->bit_pos) & 1;

    bs->bit_pos++;
    if (bs->bit_pos == 8) {
        bs->bit_pos = 0;
        bs->byte_pos++;
    }

    return bit;
}

static uint32_t tad_bitstream_read_bits(tad_bitstream_reader_t *bs, int num_bits) {
    uint32_t value = 0;
    for (int i = 0; i < num_bits; i++) {
        value |= (tad_bitstream_read_bit(bs) << i);
    }
    return value;
}

// Queue operations
static void tad_decode_queue_init(tad_decode_queue_t *q) {
    q->capacity = 1024;
    q->blocks = malloc(q->capacity * sizeof(tad_decode_block_t));
    q->count = 0;
}

static void tad_decode_queue_push(tad_decode_queue_t *q, tad_decode_block_t block) {
    if (q->count >= q->capacity) {
        q->capacity *= 2;
        q->blocks = realloc(q->blocks, q->capacity * sizeof(tad_decode_block_t));
    }
    q->blocks[q->count++] = block;
}

static void tad_decode_queue_free(tad_decode_queue_t *q) {
    free(q->blocks);
}

// Context for recursive EZBC decoding
typedef struct {
    tad_bitstream_reader_t *bs;
    int8_t *coeffs;
    tad_decode_state_t *states;
    int bitplane;
    tad_decode_queue_t *next_insignificant;
    tad_decode_queue_t *next_significant;
} tad_decode_context_t;

// Recursively decode a significant block - subdivide until size 1
static void tad_decode_significant_block_recursive(tad_decode_context_t *ctx, tad_decode_block_t block) {
    // If size 1: read sign bit and reconstruct value
    if (block.length == 1) {
        int idx = block.start;
        int sign_bit = tad_bitstream_read_bit(ctx->bs);

        // Reconstruct absolute value from bitplane
        int abs_val = 1 << ctx->bitplane;

        // Apply sign
        ctx->coeffs[idx] = sign_bit ? -abs_val : abs_val;

        ctx->states[idx].significant = true;
        ctx->states[idx].first_bitplane = ctx->bitplane;
        tad_decode_queue_push(ctx->next_significant, block);
        return;
    }

    // Block is > 1: subdivide into left and right halves
    int mid = block.length / 2;
    if (mid == 0) mid = 1;

    // Process left child
    tad_decode_block_t left = {block.start, mid};
    int left_sig = tad_bitstream_read_bit(ctx->bs);
    if (left_sig) {
        tad_decode_significant_block_recursive(ctx, left);
    } else {
        tad_decode_queue_push(ctx->next_insignificant, left);
    }

    // Process right child (if exists)
    if (block.length > mid) {
        tad_decode_block_t right = {block.start + mid, block.length - mid};
        int right_sig = tad_bitstream_read_bit(ctx->bs);
        if (right_sig) {
            tad_decode_significant_block_recursive(ctx, right);
        } else {
            tad_decode_queue_push(ctx->next_insignificant, right);
        }
    }
}

// Binary tree EZBC decoding for a single channel (1D variant)
static int tad_decode_channel_ezbc(const uint8_t *input, size_t input_size, int8_t *coeffs, size_t *bytes_consumed) {
    tad_bitstream_reader_t bs;
    tad_bitstream_reader_init(&bs, input, input_size);

    // Read header: MSB bitplane and length
    int msb_bitplane = tad_bitstream_read_bits(&bs, 8);
    uint32_t count = tad_bitstream_read_bits(&bs, 16);

    // Initialize coefficient array to zero
    memset(coeffs, 0, count * sizeof(int8_t));

    // Track coefficient significance
    tad_decode_state_t *states = calloc(count, sizeof(tad_decode_state_t));

    // Initialize queues
    tad_decode_queue_t insignificant_queue, next_insignificant;
    tad_decode_queue_t significant_queue, next_significant;

    tad_decode_queue_init(&insignificant_queue);
    tad_decode_queue_init(&next_insignificant);
    tad_decode_queue_init(&significant_queue);
    tad_decode_queue_init(&next_significant);

    // Start with root block as insignificant
    tad_decode_block_t root = {0, (int)count};
    tad_decode_queue_push(&insignificant_queue, root);

    // Process bitplanes from MSB to LSB
    for (int bitplane = msb_bitplane; bitplane >= 0; bitplane--) {
        // Process insignificant blocks
        for (size_t i = 0; i < insignificant_queue.count; i++) {
            tad_decode_block_t block = insignificant_queue.blocks[i];

            int sig = tad_bitstream_read_bit(&bs);
            if (sig == 0) {
                // Still insignificant
                tad_decode_queue_push(&next_insignificant, block);
            } else {
                // Became significant: recursively decode
                tad_decode_context_t ctx = {
                    .bs = &bs,
                    .coeffs = coeffs,
                    .states = states,
                    .bitplane = bitplane,
                    .next_insignificant = &next_insignificant,
                    .next_significant = &next_significant
                };
                tad_decode_significant_block_recursive(&ctx, block);
            }
        }

        // Refinement pass: read next bit for already-significant coefficients
        for (size_t i = 0; i < significant_queue.count; i++) {
            tad_decode_block_t block = significant_queue.blocks[i];
            int idx = block.start;

            int bit = tad_bitstream_read_bit(&bs);

            // Add this bit to the coefficient's magnitude
            if (bit) {
                int sign = (coeffs[idx] < 0) ? -1 : 1;
                int abs_val = abs(coeffs[idx]);
                abs_val |= (1 << bitplane);
                coeffs[idx] = sign * abs_val;
            }

            // Add to next_significant so it continues being refined
            tad_decode_queue_push(&next_significant, block);
        }

        // Swap queues for next bitplane
        tad_decode_queue_t temp_insig = insignificant_queue;
        insignificant_queue = next_insignificant;
        next_insignificant = temp_insig;
        next_insignificant.count = 0;

        tad_decode_queue_t temp_sig = significant_queue;
        significant_queue = next_significant;
        next_significant = temp_sig;
        next_significant.count = 0;
    }

    // Cleanup
    tad_decode_queue_free(&insignificant_queue);
    tad_decode_queue_free(&next_insignificant);
    tad_decode_queue_free(&significant_queue);
    tad_decode_queue_free(&next_significant);
    free(states);

    // Calculate bytes consumed
    *bytes_consumed = bs.byte_pos + (bs.bit_pos > 0 ? 1 : 0);

    return 0;  // Success
}

//=============================================================================
// Chunk Decoding
//=============================================================================

// Public API: TAD32 chunk decoder (can be used by both standalone decoder and TAV decoder)
int tad32_decode_chunk(const uint8_t *input, size_t input_size, uint8_t *pcmu8_stereo,
                       size_t *bytes_consumed, size_t *samples_decoded) {
    const uint8_t *read_ptr = input;

    // Read chunk header
    uint16_t sample_count = *((const uint16_t*)read_ptr);
    read_ptr += sizeof(uint16_t);

    uint8_t max_index = *read_ptr;
    read_ptr += sizeof(uint8_t);

    uint32_t payload_size = *((const uint32_t*)read_ptr);
    read_ptr += sizeof(uint32_t);

    // Calculate DWT levels from sample count
    int dwt_levels = calculate_dwt_levels(sample_count);
    if (dwt_levels < 0) {
        fprintf(stderr, "Error: Invalid sample count %u\n", sample_count);
        return -1;
    }

    // Decompress if needed
    const uint8_t *payload;
    uint8_t *decompressed = NULL;

    // Estimate decompressed size (generous upper bound)
    size_t decompressed_size = sample_count * 4 * sizeof(int8_t);
    decompressed = malloc(decompressed_size);

    size_t actual_size = ZSTD_decompress(decompressed, decompressed_size, read_ptr, payload_size);

    if (ZSTD_isError(actual_size)) {
        fprintf(stderr, "Error: Zstd decompression failed: %s\n", ZSTD_getErrorName(actual_size));
        free(decompressed);
        return -1;
    }

    read_ptr += payload_size;
    *bytes_consumed = read_ptr - input;
    *samples_decoded = sample_count;

    // Allocate working buffers
    int8_t *quant_mid = malloc(sample_count * sizeof(int8_t));
    int8_t *quant_side = malloc(sample_count * sizeof(int8_t));
    float *dwt_mid = malloc(sample_count * sizeof(float));
    float *dwt_side = malloc(sample_count * sizeof(float));
    float *pcm32_left = malloc(sample_count * sizeof(float));
    float *pcm32_right = malloc(sample_count * sizeof(float));
    uint8_t *pcm8_left = malloc(sample_count * sizeof(uint8_t));
    uint8_t *pcm8_right = malloc(sample_count * sizeof(uint8_t));

    // Decode Mid/Side using binary tree EZBC - FIXED!
    size_t mid_bytes_consumed = 0;
    size_t side_bytes_consumed = 0;

    // Decode Mid channel
    int result = tad_decode_channel_ezbc(decompressed, actual_size, quant_mid, &mid_bytes_consumed);
    if (result != 0) {
        fprintf(stderr, "Error: EZBC decoding failed for Mid channel\n");
        free(decompressed);
        free(quant_mid); free(quant_side); free(dwt_mid); free(dwt_side);
        free(pcm32_left); free(pcm32_right); free(pcm8_left); free(pcm8_right);
        return -1;
    }

    // Decode Side channel (starts after Mid channel data)
    result = tad_decode_channel_ezbc(decompressed + mid_bytes_consumed,
                                      actual_size - mid_bytes_consumed,
                                      quant_side, &side_bytes_consumed);
    if (result != 0) {
        fprintf(stderr, "Error: EZBC decoding failed for Side channel\n");
        free(decompressed);
        free(quant_mid); free(quant_side); free(dwt_mid); free(dwt_side);
        free(pcm32_left); free(pcm32_right); free(pcm8_left); free(pcm8_right);
        return -1;
    }

    // Dequantize with quantiser scaling and spectral interpolation
    // Use quantiser_scale = 1.0f for baseline (must match encoder)
    float quantiser_scale = 1.0f;
    dequantize_dwt_coefficients(0, quant_mid, dwt_mid, sample_count, sample_count, dwt_levels, max_index, quantiser_scale);
    dequantize_dwt_coefficients(1, quant_side, dwt_side, sample_count, sample_count, dwt_levels, max_index, quantiser_scale);

    // Inverse DWT
    dwt_inverse_multilevel(dwt_mid, sample_count, dwt_levels);
    dwt_inverse_multilevel(dwt_side, sample_count, dwt_levels);

    float err[2][2] = {{0,0},{0,0}};

    // M/S to L/R correlation
    ms_correlate(dwt_mid, dwt_side, pcm32_left, pcm32_right, sample_count);

    // expand dynamic range
    expand_gamma(pcm32_left, pcm32_right, sample_count);
//    expand_mu_law(pcm32_left, pcm32_right, sample_count);

    // Apply de-emphasis filter (AFTER gamma expansion, BEFORE PCM32f to PCM8)
    apply_deemphasis(pcm32_left, pcm32_right, sample_count);

    // dither to 8-bit
    pcm32f_to_pcm8(pcm32_left, pcm32_right, pcm8_left, pcm8_right, sample_count, err);

    // Interleave stereo output (PCMu8)
    for (size_t i = 0; i < sample_count; i++) {
        pcmu8_stereo[i * 2] = pcm8_left[i];
        pcmu8_stereo[i * 2 + 1] = pcm8_right[i];
    }

    // Cleanup
    free(quant_mid); free(quant_side); free(dwt_mid); free(dwt_side);
    free(pcm32_left); free(pcm32_right); free(pcm8_left); free(pcm8_right);
    if (decompressed) free(decompressed);

    return 0;
}

//=============================================================================
// Main Decoder
//=============================================================================

#ifndef TAD_DECODER_LIB  // Only compile main() when building standalone decoder
static void print_usage(const char *prog_name) {
    printf("Usage: %s -i <input> [options]\n", prog_name);
    printf("Options:\n");
    printf("  -i <file>       Input TAD file\n");
    printf("  -o <file>       Output file (optional, auto-generated from input)\n");
    printf("                  Default: input_qNN.wav (or .pcm with --raw-pcm)\n");
    printf("  --raw-pcm       Output raw PCMu8 instead of WAV file\n");
    printf("  -v              Verbose output\n");
    printf("  -h, --help      Show this help\n");
    printf("\nVersion: %s\n", DECODER_VENDOR_STRING);
    printf("Default output: WAV file (8-bit unsigned PCM, stereo @ 32000 Hz)\n");
    printf("With --raw-pcm: PCMu8 raw file (8-bit unsigned stereo @ 32000 Hz)\n");
}

int main(int argc, char *argv[]) {
    char *input_file = NULL;
    char *output_file = NULL;
    int verbose = 0;
    int raw_pcm = 0;

    static struct option long_options[] = {
        {"raw-pcm", no_argument, 0, 'r'},
        {"help", no_argument, 0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    int option_index = 0;
    while ((opt = getopt_long(argc, argv, "i:o:vh", long_options, &option_index)) != -1) {
        switch (opt) {
            case 'i':
                input_file = optarg;
                break;
            case 'o':
                output_file = optarg;
                break;
            case 'r':
                raw_pcm = 1;
                break;
            case 'v':
                verbose = 1;
                break;
            case 'h':
                print_usage(argv[0]);
                return 0;
            default:
                print_usage(argv[0]);
                return 1;
        }
    }

    if (!input_file) {
        fprintf(stderr, "Error: Input file is required\n");
        print_usage(argv[0]);
        return 1;
    }

    // Generate output filename if not provided
    if (!output_file) {
        size_t input_len = strlen(input_file);
        output_file = malloc(input_len + 32);  // Extra space for extension

        // Find the last directory separator
        const char *basename_start = strrchr(input_file, '/');
        if (!basename_start) basename_start = strrchr(input_file, '\\');
        basename_start = basename_start ? basename_start + 1 : input_file;

        // Copy directory part
        size_t dir_len = basename_start - input_file;
        strncpy(output_file, input_file, dir_len);

        // Find the .tad extension
        const char *ext = strrchr(basename_start, '.');
        if (ext && strcmp(ext, ".tad") == 0) {
            // Copy basename without .tad
            size_t name_len = ext - basename_start;
            strncpy(output_file + dir_len, basename_start, name_len);
            output_file[dir_len + name_len] = '\0';

            // Replace last dot with underscore (for .qNN pattern)
            /*char *last_dot = strrchr(output_file, '.');
            if (last_dot && last_dot > output_file + dir_len) {
                *last_dot = '_';
            }*/
        } else {
            // No .tad extension, copy entire basename
            strcpy(output_file + dir_len, basename_start);
        }

        // Append appropriate extension
        strcat(output_file, raw_pcm ? ".pcm" : ".wav");

        if (verbose) {
            printf("Auto-generated output path: %s\n", output_file);
        }
    }

    if (verbose) {
        printf("%s\n", DECODER_VENDOR_STRING);
        printf("Input: %s\n", input_file);
        printf("Output: %s\n", output_file);
    }

    // Open input file
    FILE *input = fopen(input_file, "rb");
    if (!input) {
        fprintf(stderr, "Error: Could not open input file: %s\n", input_file);
        return 1;
    }

    // Get file size
    fseek(input, 0, SEEK_END);
    size_t input_size = ftell(input);
    fseek(input, 0, SEEK_SET);

    // Read entire file into memory
    uint8_t *input_data = malloc(input_size);
    fread(input_data, 1, input_size, input);
    fclose(input);

    // Open output file
    FILE *output = fopen(output_file, "wb");
    if (!output) {
        fprintf(stderr, "Error: Could not open output file: %s\n", output_file);
        free(input_data);
        return 1;
    }

    // Write placeholder WAV header if not in raw PCM mode
    if (!raw_pcm) {
        write_wav_header(output, 0, TAD_CHANNELS, TAD_SAMPLE_RATE, 8);
    }

    // Decode chunks
    size_t offset = 0;
    size_t chunk_count = 0;
    size_t total_samples = 0;
    // Allocate buffer for maximum chunk size (can handle variable sizes up to default)
    uint8_t *chunk_output = malloc(TAD_DEFAULT_CHUNK_SIZE * TAD_CHANNELS);

    while (offset < input_size) {
        size_t bytes_consumed, samples_decoded;
        int result = tad32_decode_chunk(input_data + offset, input_size - offset,
                                        chunk_output, &bytes_consumed, &samples_decoded);

        if (result != 0) {
            fprintf(stderr, "Error: Chunk decoding failed at offset %zu\n", offset);
            free(input_data);
            free(chunk_output);
            fclose(output);
            return 1;
        }

        // Write decoded chunk (only the actual samples)
        fwrite(chunk_output, TAD_CHANNELS, samples_decoded, output);

        offset += bytes_consumed;
        total_samples += samples_decoded;
        chunk_count++;

        if (verbose && (chunk_count % 10 == 0)) {
            printf("Decoded chunk %zu (offset %zu/%zu, %zu samples)\r", chunk_count, offset, input_size, samples_decoded);
            fflush(stdout);
        }
    }

    if (verbose) {
        printf("\nDecoding complete!\n");
        printf("Decoded %zu chunks\n", chunk_count);
        printf("Total samples: %zu (%.2f seconds)\n",
               total_samples,
               total_samples / (double)TAD_SAMPLE_RATE);
    }

    // Update WAV header with correct size if not in raw PCM mode
    if (!raw_pcm) {
        uint32_t data_size = total_samples * TAD_CHANNELS;
        fseek(output, 0, SEEK_SET);
        write_wav_header(output, data_size, TAD_CHANNELS, TAD_SAMPLE_RATE, 8);
    }

    // Cleanup
    free(input_data);
    free(chunk_output);
    fclose(output);

    printf("Output written to: %s\n", output_file);
    if (raw_pcm) {
        printf("Format: PCMu8 stereo @ %d Hz (raw PCM)\n", TAD_SAMPLE_RATE);
    } else {
        printf("Format: WAV file (8-bit unsigned PCM, stereo @ %d Hz)\n", TAD_SAMPLE_RATE);
    }

    return 0;
}
#endif  // TAD_DECODER_LIB
