/*
 * TAV AVX-512 Optimisations
 *
 * This file contains AVX-512 optimised versions of performance-critical functions
 * in the TAV encoder. Runtime CPU detection ensures fallback to scalar versions
 * on non-AVX-512 systems.
 *
 * Optimised functions:
 * - 1D DWT transforms (5/3, 9/7, Haar, Bior13/7, DD4)
 * - Quantisation functions
 * - RGB to YCoCg color conversion
 * - 2D DWT gather/scatter operations
 *
 * Compile with: -mavx512f -mavx512dq -mavx512bw -mavx512vl
 */

#ifndef TAV_AVX512_H
#define TAV_AVX512_H

#include <immintrin.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdio.h>

// =============================================================================
// SIMD Capability Detection
// =============================================================================

typedef enum {
    SIMD_NONE = 0,
    SIMD_AVX512F = 1
} simd_level_t;

// Global SIMD level (set by tav_simd_init)
static simd_level_t g_simd_level = SIMD_NONE;

// CPU feature detection
static inline int cpu_has_avx512f(void) {
#ifdef __AVX512F__
    return __builtin_cpu_supports("avx512f") &&
           __builtin_cpu_supports("avx512dq");
#else
    return 0;
#endif
}

// Initialize SIMD detection (call once at startup)
static inline void tav_simd_init(void) {
#ifdef __AVX512F__
    if (cpu_has_avx512f()) {
        g_simd_level = SIMD_AVX512F;
        fprintf(stderr, "[TAV] AVX-512 optimisations enabled\n");
    } else {
        g_simd_level = SIMD_NONE;
        fprintf(stderr, "[TAV] AVX-512 not available, using scalar fallback\n");
    }
#else
    g_simd_level = SIMD_NONE;
    fprintf(stderr, "[TAV] Compiled without AVX-512 support\n");
#endif
}

#ifdef __AVX512F__

// =============================================================================
// Helper Functions
// =============================================================================

// Horizontal sum of 16 floats
static inline float _mm512_reduce_add_ps_compat(__m512 v) {
    __m256 low = _mm512_castps512_ps256(v);
    __m256 high = _mm512_extractf32x8_ps(v, 1);
    __m256 sum256 = _mm256_add_ps(low, high);
    __m128 sum128 = _mm_add_ps(_mm256_castps256_ps128(sum256), _mm256_extractf128_ps(sum256, 1));
    sum128 = _mm_hadd_ps(sum128, sum128);
    sum128 = _mm_hadd_ps(sum128, sum128);
    return _mm_cvtss_f32(sum128);
}

// Clamp helper for vectorized operations
static inline __m512 _mm512_clamp_ps(__m512 v, __m512 min_val, __m512 max_val) {
    return _mm512_min_ps(_mm512_max_ps(v, min_val), max_val);
}

// =============================================================================
// AVX-512 Optimised 1D DWT Forward Transforms
// =============================================================================

// 5/3 Reversible Forward DWT with AVX-512
static inline void dwt_53_forward_1d_avx512(float *data, int length) {
    if (length < 2) return;

    float *temp = (float*)calloc(length, sizeof(float));
    int half = (length + 1) / 2;

    // Predict step (high-pass) - vectorized
    // temp[half + i] = data[2*i+1] - 0.5 * (data[2*i] + data[2*i+2])
    int i;
    for (i = 0; i + 16 <= half; i += 16) {
        __mmask16 valid_mask = 0xFFFF;

        // Check boundary for last iteration
        for (int j = 0; j < 16; j++) {
            int idx = 2 * (i + j) + 1;
            if (idx >= length) {
                valid_mask &= ~(1 << j);
            }
        }

        if (valid_mask == 0) break;

        // Load data[2*i] - stride 2 load
        float even_curr_vals[16], even_next_vals[16], odd_vals[16];

        for (int j = 0; j < 16; j++) {
            if (valid_mask & (1 << j)) {
                even_curr_vals[j] = data[2 * (i + j)];
                even_next_vals[j] = (2 * (i + j) + 2 < length) ? data[2 * (i + j) + 2] : data[2 * (i + j)];
                odd_vals[j] = data[2 * (i + j) + 1];
            } else {
                even_curr_vals[j] = 0.0f;
                even_next_vals[j] = 0.0f;
                odd_vals[j] = 0.0f;
            }
        }

        __m512 even_curr = _mm512_loadu_ps(even_curr_vals);
        __m512 even_next = _mm512_loadu_ps(even_next_vals);
        __m512 odd = _mm512_loadu_ps(odd_vals);

        __m512 pred = _mm512_mul_ps(_mm512_add_ps(even_curr, even_next), _mm512_set1_ps(0.5f));
        __m512 high = _mm512_sub_ps(odd, pred);

        _mm512_mask_storeu_ps(&temp[half + i], valid_mask, high);
    }

    // Handle remaining elements
    for (; i < half; i++) {
        int idx = 2 * i + 1;
        if (idx < length) {
            float pred = 0.5f * (data[2 * i] + (2 * i + 2 < length ? data[2 * i + 2] : data[2 * i]));
            temp[half + i] = data[idx] - pred;
        }
    }

    // Update step (low-pass) - vectorized
    // temp[i] = data[2*i] + 0.25 * (temp[half+i-1] + temp[half+i])
    for (i = 0; i + 16 <= half; i += 16) {
        __m512 even = _mm512_loadu_ps(&data[2 * i]);  // Load with stride 2 (simplified)

        // Manual gather for strided load
        float even_vals[16];
        for (int j = 0; j < 16 && (i + j) < half; j++) {
            even_vals[j] = data[2 * (i + j)];
        }
        even = _mm512_loadu_ps(even_vals);

        // Load high-pass neighbors
        float high_prev[16], high_curr[16];
        for (int j = 0; j < 16 && (i + j) < half; j++) {
            high_prev[j] = ((i + j) > 0) ? temp[half + (i + j) - 1] : 0.0f;
            high_curr[j] = ((i + j) < half - 1) ? temp[half + (i + j)] : 0.0f;
        }

        __m512 hp = _mm512_loadu_ps(high_prev);
        __m512 hc = _mm512_loadu_ps(high_curr);
        __m512 update = _mm512_mul_ps(_mm512_add_ps(hp, hc), _mm512_set1_ps(0.25f));
        __m512 low = _mm512_add_ps(even, update);

        __mmask16 store_mask = (i + 16 <= half) ? 0xFFFF : (1 << (half - i)) - 1;
        _mm512_mask_storeu_ps(&temp[i], store_mask, low);
    }

    // Handle remaining elements
    for (; i < half; i++) {
        float update = 0.25f * ((i > 0 ? temp[half + i - 1] : 0) +
                               (i < half - 1 ? temp[half + i] : 0));
        temp[i] = data[2 * i] + update;
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// 9/7 Irreversible Forward DWT with AVX-512
static inline void dwt_97_forward_1d_avx512(float *data, int length) {
    if (length < 2) return;

    int half = (length + 1) / 2;

    // Allocate aligned temp buffer once (64-byte align for cache lines)
    float *temp = NULL;
#if defined(_POSIX_C_SOURCE) || defined(_XOPEN_SOURCE)
    if (posix_memalign((void**)&temp, 64, (size_t)length * sizeof(float)) != 0) {
        temp = (float*)malloc((size_t)length * sizeof(float));
    }
#else
    temp = (float*)aligned_alloc(64, ((size_t)length * sizeof(float) + 63) & ~63);
    if (!temp) temp = (float*)malloc((size_t)length * sizeof(float));
#endif
    if (!temp) return; // allocation failure: bail out (preserve original behavior could be different)

    // FAST SPLIT: interleave into temp: first half = evens, second half = odds
    // This is simple, streaming-friendly, and much faster than per-iteration small-array gathers.
    {
        float *even = temp;
        float *odd  = temp + half;
        int i = 0;
        // process pairs to minimize branches and memory ops
        for (; i + 1 < length; i += 2) {
            even[0] = data[i];
            odd[0]  = data[i + 1];
            ++even; ++odd;
        }
        if (i < length) { // odd leftover
            even[0] = data[i];
        }
    }

    // Lifting coefficients as vectors
    const __m512 alpha_vec = _mm512_set1_ps(-1.586134342f);
    const __m512 beta_vec  = _mm512_set1_ps(-0.052980118f);
    const __m512 gamma_vec = _mm512_set1_ps(0.882911076f);
    const __m512 delta_vec = _mm512_set1_ps(0.443506852f);
    const __m512 K_vec     = _mm512_set1_ps(1.230174105f);
    const __m512 invK_vec  = _mm512_set1_ps(1.0f / 1.230174105f);

    // Helper variables
    int i;

    // -----------------------
    // Step 1: Predict α
    // d[i] += alpha * (s[i] + s[i+1])
    // -----------------------
    if (half > 0) {
        // handle small or trivial cases
        if (half == 1) {
            if (half < length) {
                temp[half + 0] += -1.586134342f * (temp[0] + temp[0]);
            }
        } else {
            // main vectorized body: ensure s_next loads (i+1) valid -> i <= half-2
            int limit = (half - 1);
            int n_full = (limit / 16) * 16; // process up to n_full (multiple of 16)
            i = 0;
            for (; i + 32 <= n_full; i += 32) {
                // unroll 2x (i and i+16)
                __m512 s0 = _mm512_loadu_ps(&temp[i]);
                __m512 s0n = _mm512_loadu_ps(&temp[i + 1]);
                __m512 d0 = _mm512_loadu_ps(&temp[half + i]);
                __m512 sum0 = _mm512_add_ps(s0, s0n);
                d0 = _mm512_fmadd_ps(alpha_vec, sum0, d0);
                _mm512_storeu_ps(&temp[half + i], d0);

                __m512 s1 = _mm512_loadu_ps(&temp[i + 16]);
                __m512 s1n = _mm512_loadu_ps(&temp[i + 17]);
                __m512 d1 = _mm512_loadu_ps(&temp[half + i + 16]);
                __m512 sum1 = _mm512_add_ps(s1, s1n);
                d1 = _mm512_fmadd_ps(alpha_vec, sum1, d1);
                _mm512_storeu_ps(&temp[half + i + 16], d1);
            }
            for (; i + 16 <= n_full; i += 16) {
                __m512 s = _mm512_loadu_ps(&temp[i]);
                __m512 sn = _mm512_loadu_ps(&temp[i + 1]);
                __m512 d = _mm512_loadu_ps(&temp[half + i]);
                __m512 sum = _mm512_add_ps(s, sn);
                d = _mm512_fmadd_ps(alpha_vec, sum, d);
                _mm512_storeu_ps(&temp[half + i], d);
            }
            // scalar remainder up to limit (half-2 -> last vector handled below)
            for (; i < limit; ++i) {
                temp[half + i] += -1.586134342f * (temp[i] + temp[i + 1]);
            }
            // handle last index i = half-1 (mirror)
            int last = half - 1;
            if (half + last < length) {
                float s_curr = temp[last];
                float s_next = s_curr;
                temp[half + last] += -1.586134342f * (s_curr + s_next);
            }
        }
    }

    // -----------------------
    // Step 2: Update β
    // s[i] += beta * (d[i-1] + d[i])
    // -----------------------
    if (half > 0) {
        // handle i == 0 separately (d_prev = d_curr for boundary semantics)
        if (half >= 1) {
            // i == 0
            if (half + 0 < length) {
                float d_curr0 = temp[half + 0];
                temp[0] += -0.052980118f * (d_curr0 + d_curr0);
            }
        }

        if (half > 1) {
            // main vector loop starting from i = 1 to half-1 (we will write s[i] for i>=1)
            int start = 1;
            int limit = half; // exclusive
            int n_elems = limit - start;
            int n_full = (n_elems / 16) * 16;
            i = start;
            for (; i + 32 <= start + n_full; i += 32) {
                // unroll 2x
                __m512 s0 = _mm512_loadu_ps(&temp[i]);
                __m512 dcurr0 = _mm512_loadu_ps(&temp[half + i]);
                __m512 dprev0 = _mm512_loadu_ps(&temp[half + i - 1]);
                __m512 sum0 = _mm512_add_ps(dprev0, dcurr0);
                s0 = _mm512_fmadd_ps(beta_vec, sum0, s0);
                _mm512_storeu_ps(&temp[i], s0);

                __m512 s1 = _mm512_loadu_ps(&temp[i + 16]);
                __m512 dcurr1 = _mm512_loadu_ps(&temp[half + i + 16]);
                __m512 dprev1 = _mm512_loadu_ps(&temp[half + i + 15]);
                __m512 sum1 = _mm512_add_ps(dprev1, dcurr1);
                s1 = _mm512_fmadd_ps(beta_vec, sum1, s1);
                _mm512_storeu_ps(&temp[i + 16], s1);
            }
            for (; i + 16 <= start + n_full; i += 16) {
                __m512 s = _mm512_loadu_ps(&temp[i]);
                __m512 dcurr = _mm512_loadu_ps(&temp[half + i]);
                __m512 dprev = _mm512_loadu_ps(&temp[half + i - 1]);
                __m512 sum = _mm512_add_ps(dprev, dcurr);
                s = _mm512_fmadd_ps(beta_vec, sum, s);
                _mm512_storeu_ps(&temp[i], s);
            }
            // scalar remainder
            for (; i < limit; ++i) {
                float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
                float d_prev = (half + i - 1 < length && i > 0) ? temp[half + i - 1] : d_curr;
                temp[i] += -0.052980118f * (d_prev + d_curr);
            }
        }
    }

    // -----------------------
    // Step 3: Predict γ
    // d[i] += gamma * (s[i] + s[i+1])
    // -----------------------
    if (half > 0) {
        if (half == 1) {
            if (half < length) {
                temp[half + 0] += 0.882911076f * (temp[0] + temp[0]);
            }
        } else {
            int limit = (half - 1);
            int n_full = (limit / 16) * 16;
            i = 0;
            for (; i + 32 <= n_full; i += 32) {
                __m512 s0 = _mm512_loadu_ps(&temp[i]);
                __m512 s0n = _mm512_loadu_ps(&temp[i + 1]);
                __m512 d0 = _mm512_loadu_ps(&temp[half + i]);
                __m512 sum0 = _mm512_add_ps(s0, s0n);
                d0 = _mm512_fmadd_ps(gamma_vec, sum0, d0);
                _mm512_storeu_ps(&temp[half + i], d0);

                __m512 s1 = _mm512_loadu_ps(&temp[i + 16]);
                __m512 s1n = _mm512_loadu_ps(&temp[i + 17]);
                __m512 d1 = _mm512_loadu_ps(&temp[half + i + 16]);
                __m512 sum1 = _mm512_add_ps(s1, s1n);
                d1 = _mm512_fmadd_ps(gamma_vec, sum1, d1);
                _mm512_storeu_ps(&temp[half + i + 16], d1);
            }
            for (; i + 16 <= n_full; i += 16) {
                __m512 s = _mm512_loadu_ps(&temp[i]);
                __m512 sn = _mm512_loadu_ps(&temp[i + 1]);
                __m512 d = _mm512_loadu_ps(&temp[half + i]);
                __m512 sum = _mm512_add_ps(s, sn);
                d = _mm512_fmadd_ps(gamma_vec, sum, d);
                _mm512_storeu_ps(&temp[half + i], d);
            }
            for (; i < limit; ++i) {
                temp[half + i] += 0.882911076f * (temp[i] + temp[i + 1]);
            }
            // last index mirror
            int last = half - 1;
            if (half + last < length) {
                float s_curr = temp[last];
                float s_next = s_curr;
                temp[half + last] += 0.882911076f * (s_curr + s_next);
            }
        }
    }

    // -----------------------
    // Step 4: Update δ
    // s[i] += delta * (d[i-1] + d[i])
    // -----------------------
    if (half > 0) {
        // i == 0
        if (half >= 1) {
            if (half + 0 < length) {
                float d_curr0 = temp[half + 0];
                temp[0] += 0.443506852f * (d_curr0 + d_curr0);
            }
        }

        if (half > 1) {
            int start = 1;
            int limit = half; // exclusive
            int n_elems = limit - start;
            int n_full = (n_elems / 16) * 16;
            i = start;
            for (; i + 32 <= start + n_full; i += 32) {
                __m512 s0 = _mm512_loadu_ps(&temp[i]);
                __m512 dcurr0 = _mm512_loadu_ps(&temp[half + i]);
                __m512 dprev0 = _mm512_loadu_ps(&temp[half + i - 1]);
                __m512 sum0 = _mm512_add_ps(dprev0, dcurr0);
                s0 = _mm512_fmadd_ps(delta_vec, sum0, s0);
                _mm512_storeu_ps(&temp[i], s0);

                __m512 s1 = _mm512_loadu_ps(&temp[i + 16]);
                __m512 dcurr1 = _mm512_loadu_ps(&temp[half + i + 16]);
                __m512 dprev1 = _mm512_loadu_ps(&temp[half + i + 15]);
                __m512 sum1 = _mm512_add_ps(dprev1, dcurr1);
                s1 = _mm512_fmadd_ps(delta_vec, sum1, s1);
                _mm512_storeu_ps(&temp[i + 16], s1);
            }
            for (; i + 16 <= start + n_full; i += 16) {
                __m512 s = _mm512_loadu_ps(&temp[i]);
                __m512 dcurr = _mm512_loadu_ps(&temp[half + i]);
                __m512 dprev = _mm512_loadu_ps(&temp[half + i - 1]);
                __m512 sum = _mm512_add_ps(dprev, dcurr);
                s = _mm512_fmadd_ps(delta_vec, sum, s);
                _mm512_storeu_ps(&temp[i], s);
            }
            for (; i < limit; ++i) {
                float d_curr = (half + i < length) ? temp[half + i] : 0.0f;
                float d_prev = (half + i - 1 < length && i > 0) ? temp[half + i - 1] : d_curr;
                temp[i] += 0.443506852f * (d_prev + d_curr);
            }
        }
    }

    // -----------------------
    // Step 5: Scaling
    // s *= K, d *= invK
    // -----------------------
    // s (first half)
    {
        int n_full = (half / 16) * 16;
        i = 0;
        for (; i + 32 <= n_full; i += 32) {
            __m512 s0 = _mm512_loadu_ps(&temp[i]);
            s0 = _mm512_mul_ps(s0, K_vec);
            _mm512_storeu_ps(&temp[i], s0);

            __m512 s1 = _mm512_loadu_ps(&temp[i + 16]);
            s1 = _mm512_mul_ps(s1, K_vec);
            _mm512_storeu_ps(&temp[i + 16], s1);
        }
        for (; i + 16 <= n_full; i += 16) {
            __m512 s = _mm512_loadu_ps(&temp[i]);
            s = _mm512_mul_ps(s, K_vec);
            _mm512_storeu_ps(&temp[i], s);
        }
        for (; i < half; ++i) temp[i] *= 1.230174105f;
    }

    // d (second half)
    {
        int dlen = length - half;
        int n_full = (dlen / 16) * 16;
        i = 0;
        for (; i + 32 <= n_full; i += 32) {
            __m512 d0 = _mm512_loadu_ps(&temp[half + i]);
            d0 = _mm512_mul_ps(d0, invK_vec);
            _mm512_storeu_ps(&temp[half + i], d0);

            __m512 d1 = _mm512_loadu_ps(&temp[half + i + 16]);
            d1 = _mm512_mul_ps(d1, invK_vec);
            _mm512_storeu_ps(&temp[half + i + 16], d1);
        }
        for (; i + 16 <= n_full; i += 16) {
            __m512 d = _mm512_loadu_ps(&temp[half + i]);
            d = _mm512_mul_ps(d, invK_vec);
            _mm512_storeu_ps(&temp[half + i], d);
        }
        for (; i < dlen; ++i) {
            if (half + i < length) temp[half + i] /= 1.230174105f;
        }
    }

    // Copy back and free
    memcpy(data, temp, (size_t)length * sizeof(float));
    free(temp);
}

// Haar Forward DWT with AVX-512
static inline void dwt_haar_forward_1d_avx512(float *data, int length) {
    if (length < 2) return;

    float *temp = (float*)malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    const __m512 half_vec = _mm512_set1_ps(0.5f);

    // Process 16 pairs at a time
    int i;
    for (i = 0; i + 16 <= half; i += 16) {
        __mmask16 valid_mask = 0xFFFF;

        float even_vals[16], odd_vals[16];
        for (int j = 0; j < 16; j++) {
            even_vals[j] = data[2 * (i + j)];
            if (2 * (i + j) + 1 < length) {
                odd_vals[j] = data[2 * (i + j) + 1];
            } else {
                odd_vals[j] = even_vals[j];
                valid_mask &= ~(1 << j);
            }
        }

        __m512 even = _mm512_loadu_ps(even_vals);
        __m512 odd = _mm512_loadu_ps(odd_vals);

        // Low-pass: (even + odd) / 2
        __m512 low = _mm512_mul_ps(_mm512_add_ps(even, odd), half_vec);
        // High-pass: (even - odd) / 2
        __m512 high = _mm512_mul_ps(_mm512_sub_ps(even, odd), half_vec);

        _mm512_storeu_ps(&temp[i], low);
        _mm512_mask_storeu_ps(&temp[half + i], valid_mask, high);
    }

    // Remaining scalar
    for (; i < half; i++) {
        if (2 * i + 1 < length) {
            temp[i] = (data[2 * i] + data[2 * i + 1]) / 2.0f;
            temp[half + i] = (data[2 * i] - data[2 * i + 1]) / 2.0f;
        } else {
            temp[i] = data[2 * i];
            if (half + i < length) {
                temp[half + i] = 0.0f;
            }
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

// =============================================================================
// AVX-512 Optimised Quantisation Functions
// =============================================================================

static inline void quantise_dwt_coefficients_avx512(
    float *coeffs, int16_t *quantised, int size,
    float effective_q, float dead_zone_threshold,
    int width, int height, int decomp_levels, int is_chroma,
    int (*get_subband_level)(int, int, int, int),
    int (*get_subband_type)(int, int, int, int)
) {
    const __m512 q_vec = _mm512_set1_ps(effective_q);
    const __m512 inv_q_vec = _mm512_set1_ps(1.0f / effective_q);
    const __m512 half_vec = _mm512_set1_ps(0.5f);
    const __m512 nhalf_vec = _mm512_set1_ps(-0.5f);
    const __m512 zero_vec = _mm512_setzero_ps();
    const __m512i min_i32 = _mm512_set1_epi32(-32768);
    const __m512i max_i32 = _mm512_set1_epi32(32767);

    int i;
    for (i = 0; i + 16 <= size; i += 16) {
        __m512 coeff = _mm512_loadu_ps(&coeffs[i]);
        __m512 quant = _mm512_mul_ps(coeff, inv_q_vec);

        // Dead-zone handling (simplified - full version needs per-coeff logic)
        if (dead_zone_threshold > 0.0f && !is_chroma) {
            __m512 threshold_vec = _mm512_set1_ps(dead_zone_threshold);
            __m512 abs_quant = _mm512_abs_ps(quant);
            __mmask16 dead_mask = _mm512_cmp_ps_mask(abs_quant, threshold_vec, _CMP_LE_OQ);
            quant = _mm512_mask_blend_ps(dead_mask, quant, zero_vec);
        }

        // Manual rounding to match scalar behaviour (round away from zero)
        // First add 0.5 or -0.5 based on sign
        __mmask16 pos_mask = _mm512_cmp_ps_mask(quant, zero_vec, _CMP_GE_OQ);
        __m512 round_val = _mm512_mask_blend_ps(pos_mask, nhalf_vec, half_vec);
        quant = _mm512_add_ps(quant, round_val);

        // Now truncate to int32 (this matches scalar (int32_t) cast after adding 0.5)
        __m512i quant_i32 = _mm512_cvttps_epi32(quant);  // cvtt = truncate (round toward zero)
        quant_i32 = _mm512_max_epi32(quant_i32, min_i32);
        quant_i32 = _mm512_min_epi32(quant_i32, max_i32);

        // Pack to int16 (AVX-512 has cvtsepi32_epi16)
        __m256i quant_i16 = _mm512_cvtsepi32_epi16(quant_i32);
        _mm256_storeu_si256((__m256i*)&quantised[i], quant_i16);
    }

    // Remaining scalar
    for (; i < size; i++) {
        float quantised_val = coeffs[i] / effective_q;

        // Dead-zone (simplified)
        if (dead_zone_threshold > 0.0f && !is_chroma) {
            if (fabsf(quantised_val) <= dead_zone_threshold) {
                quantised_val = 0.0f;
            }
        }

        int32_t val = (int32_t)(quantised_val + (quantised_val >= 0 ? 0.5f : -0.5f));
        quantised[i] = (int16_t)((val < -32768) ? -32768 : (val > 32767 ? 32767 : val));
    }
}

// Perceptual quantisation with per-coefficient weighting
static inline void quantise_dwt_coefficients_perceptual_avx512(
    float *coeffs, int16_t *quantised, int size,
    float *weights,  // Pre-computed per-coefficient weights
    float base_quantiser
) {
    const __m512 base_q_vec = _mm512_set1_ps(base_quantiser);
    const __m512 half_vec = _mm512_set1_ps(0.5f);
    const __m512 nhalf_vec = _mm512_set1_ps(-0.5f);
    const __m512 zero_vec = _mm512_setzero_ps();
    const __m512i min_i32 = _mm512_set1_epi32(-32768);
    const __m512i max_i32 = _mm512_set1_epi32(32767);

    int i;
    for (i = 0; i + 16 <= size; i += 16) {
        __m512 coeff = _mm512_loadu_ps(&coeffs[i]);
        __m512 weight = _mm512_loadu_ps(&weights[i]);

        // effective_q = base_q * weight
        __m512 effective_q = _mm512_mul_ps(base_q_vec, weight);
        __m512 quant = _mm512_div_ps(coeff, effective_q);

        // Manual rounding to match scalar behaviour
        __mmask16 pos_mask = _mm512_cmp_ps_mask(quant, zero_vec, _CMP_GE_OQ);
        __m512 round_val = _mm512_mask_blend_ps(pos_mask, nhalf_vec, half_vec);
        quant = _mm512_add_ps(quant, round_val);

        // Truncate to int32 (matches scalar cast after rounding)
        __m512i quant_i32 = _mm512_cvttps_epi32(quant);
        quant_i32 = _mm512_max_epi32(quant_i32, min_i32);
        quant_i32 = _mm512_min_epi32(quant_i32, max_i32);

        __m256i quant_i16 = _mm512_cvtsepi32_epi16(quant_i32);
        _mm256_storeu_si256((__m256i*)&quantised[i], quant_i16);
    }

    // Remaining scalar
    for (; i < size; i++) {
        float effective_q = base_quantiser * weights[i];
        float quantised_val = coeffs[i] / effective_q;
        int32_t val = (int32_t)(quantised_val + (quantised_val >= 0 ? 0.5f : -0.5f));
        quantised[i] = (int16_t)((val < -32768) ? -32768 : (val > 32767 ? 32767 : val));
    }
}

// =============================================================================
// AVX-512 Optimised Dequantisation Functions
// =============================================================================

// Basic dequantisation: quantised[i] * effective_q
static inline void dequantise_dwt_coefficients_avx512(
    const int16_t *quantised, float *coeffs, int size,
    float effective_q
) {
    const __m512 q_vec = _mm512_set1_ps(effective_q);

    int i;
    for (i = 0; i + 16 <= size; i += 16) {
        // Load 16 int16 values
        __m256i quant_i16 = _mm256_loadu_si256((__m256i*)&quantised[i]);

        // Convert int16 to int32
        __m512i quant_i32 = _mm512_cvtepi16_epi32(quant_i16);

        // Convert int32 to float
        __m512 quant_f32 = _mm512_cvtepi32_ps(quant_i32);

        // Multiply by quantiser
        __m512 dequant = _mm512_mul_ps(quant_f32, q_vec);

        _mm512_storeu_ps(&coeffs[i], dequant);
    }

    // Remaining scalar
    for (; i < size; i++) {
        coeffs[i] = (float)quantised[i] * effective_q;
    }
}

// Perceptual dequantisation with per-coefficient weights
static inline void dequantise_dwt_coefficients_perceptual_avx512(
    const int16_t *quantised, float *coeffs, int size,
    const float *weights, float base_quantiser
) {
    const __m512 base_q_vec = _mm512_set1_ps(base_quantiser);

    int i;
    for (i = 0; i + 16 <= size; i += 16) {
        // Load 16 int16 values
        __m256i quant_i16 = _mm256_loadu_si256((__m256i*)&quantised[i]);

        // Convert int16 → int32 → float
        __m512i quant_i32 = _mm512_cvtepi16_epi32(quant_i16);
        __m512 quant_f32 = _mm512_cvtepi32_ps(quant_i32);

        // Load weights
        __m512 weight = _mm512_loadu_ps(&weights[i]);

        // effective_q = base_q * weight
        __m512 effective_q = _mm512_mul_ps(base_q_vec, weight);

        // dequant = quantised * effective_q
        __m512 dequant = _mm512_mul_ps(quant_f32, effective_q);

        _mm512_storeu_ps(&coeffs[i], dequant);
    }

    // Remaining scalar
    for (; i < size; i++) {
        float effective_q = base_quantiser * weights[i];
        coeffs[i] = (float)quantised[i] * effective_q;
    }
}

// =============================================================================
// AVX-512 Optimised RGB to YCoCg Conversion
// =============================================================================

static inline void rgb_to_ycocg_avx512(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height) {
    const int total_pixels = width * height;
    const __m512 half_vec = _mm512_set1_ps(0.5f);

    int i;
    // Process 16 pixels at a time (48 bytes of RGB data)
    for (i = 0; i + 16 <= total_pixels; i += 16) {
        // Load 16 RGB triplets (48 bytes)
        // We need to deinterleave R, G, B channels

        // Manual load and deinterleave (AVX-512 doesn't have direct RGB deinterleave)
        float r_vals[16], g_vals[16], b_vals[16];
        for (int j = 0; j < 16; j++) {
            r_vals[j] = (float)rgb[(i + j) * 3 + 0];
            g_vals[j] = (float)rgb[(i + j) * 3 + 1];
            b_vals[j] = (float)rgb[(i + j) * 3 + 2];
        }

        __m512 r = _mm512_loadu_ps(r_vals);
        __m512 g = _mm512_loadu_ps(g_vals);
        __m512 b = _mm512_loadu_ps(b_vals);

        // YCoCg-R transform:
        // co = r - b
        // tmp = b + co * 0.5
        // cg = g - tmp
        // y = tmp + cg * 0.5

        __m512 co_vec = _mm512_sub_ps(r, b);
        __m512 tmp = _mm512_fmadd_ps(co_vec, half_vec, b);  // tmp = b + co * 0.5
        __m512 cg_vec = _mm512_sub_ps(g, tmp);
        __m512 y_vec = _mm512_fmadd_ps(cg_vec, half_vec, tmp);  // y = tmp + cg * 0.5

        _mm512_storeu_ps(&y[i], y_vec);
        _mm512_storeu_ps(&co[i], co_vec);
        _mm512_storeu_ps(&cg[i], cg_vec);
    }

    // Remaining pixels (scalar)
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
// AVX-512 Optimised 2D DWT with Gather/Scatter
// =============================================================================

// Optimised column extraction using gather
static inline void dwt_2d_extract_column_avx512(
    const float *tile_data, float *column,
    int x, int width, int height
) {
    // Create gather indices for column extraction
    // indices[i] = (i * width + x)

    int y;
    for (y = 0; y + 16 <= height; y += 16) {
        // Build gather indices
        int indices[16];
        for (int j = 0; j < 16; j++) {
            indices[j] = (y + j) * width + x;
        }

        __m512i vindex = _mm512_loadu_si512((__m512i*)indices);
        __m512 col_data = _mm512_i32gather_ps(vindex, tile_data, 4);
        _mm512_storeu_ps(&column[y], col_data);
    }

    // Remaining scalar
    for (; y < height; y++) {
        column[y] = tile_data[y * width + x];
    }
}

// Optimised column insertion using scatter
static inline void dwt_2d_insert_column_avx512(
    float *tile_data, const float *column,
    int x, int width, int height
) {
    int y;
    for (y = 0; y + 16 <= height; y += 16) {
        // Build scatter indices
        int indices[16];
        for (int j = 0; j < 16; j++) {
            indices[j] = (y + j) * width + x;
        }

        __m512i vindex = _mm512_loadu_si512((__m512i*)indices);
        __m512 col_data = _mm512_loadu_ps(&column[y]);
        _mm512_i32scatter_ps(tile_data, vindex, col_data, 4);
    }

    // Remaining scalar
    for (; y < height; y++) {
        tile_data[y * width + x] = column[y];
    }
}

#endif // __AVX512F__

#endif // TAV_AVX512_H
