/**
 * TAV Encoder - Discrete Wavelet Transform (DWT) Library
 *
 * Provides multi-resolution wavelet decomposition for video compression.
 * Supports multiple wavelet types: CDF 5/3, 9/7, 13/7, DD-4, and Haar.
 *
 * Extracted from encoder_tav.c as part of library refactoring.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

// =============================================================================
// Wavelet Type Constants
// =============================================================================

#define WAVELET_5_3_REVERSIBLE 0       // CDF 5/3 - Lossless capable
#define WAVELET_9_7_IRREVERSIBLE 1     // CDF 9/7 - Higher compression (default)
#define WAVELET_BIORTHOGONAL_13_7 2    // Biorthogonal 13/7
#define WAVELET_DD4 16                 // Deslauriers-Dubuc 4-point interpolating
#define WAVELET_HAAR 255               // Haar - Simplest wavelet

// =============================================================================
// 1D Forward DWT Transforms
// =============================================================================

/**
 * CDF 5/3 reversible wavelet forward 1D transform (lossless capable).
 *
 * Uses lifting scheme with predict and update steps.
 * Output layout: [LL...LL, HH...HH] (low-pass, then high-pass)
 *
 * @param data   In/out signal data (modified in-place)
 * @param length Signal length (handles non-power-of-2)
 */
static void dwt_53_forward_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = calloc(length, sizeof(float));
    int half = (length + 1) / 2;

    // Predict step (high-pass)
    for (int i = 0; i < half; i++) {
        int idx = 2 * i + 1;
        if (idx < length) {
            float pred = 0.5f * (data[2 * i] + (2 * i + 2 < length ? data[2 * i + 2] : data[2 * i]));
            temp[half + i] = data[idx] - pred;
        }
    }

    // Update step (low-pass)
    for (int i = 0; i < half; i++) {
        float update = 0.25f * ((i > 0 ? temp[half + i - 1] : 0) +
                               (i < half - 1 ? temp[half + i] : 0));
        temp[i] = data[2 * i] + update;
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
}

/**
 * CDF 9/7 irreversible wavelet forward 1D transform (JPEG 2000 standard).
 *
 * Five-step lifting scheme with scaling for optimal compression.
 * Output layout: [LL...LL, HH...HH]
 *
 * @param data   In/out signal data
 * @param length Signal length
 */
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

    // JPEG2000 9/7 lifting coefficients
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

/**
 * CDF 9/7 integer-reversible wavelet forward 1D (fixed-point lifting).
 *
 * Same structure as 9/7 irreversible but uses integer arithmetic.
 *
 * @param data   In/out signal data
 * @param length Signal length
 */
static void dwt_97_iint_forward_1d(float *data, int length) {
    if (length < 2) return;
    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    for (int i = 0; i < half; ++i) temp[i] = data[2*i];
    for (int i = 0; i < length/2; ++i) temp[half + i] = data[2*i + 1];

    const int SHIFT = 16;
    const int64_t ROUND = 1LL << (SHIFT - 1);
    const int64_t A = -103949;  // α
    const int64_t B = -3472;    // β
    const int64_t G = 57862;    // γ
    const int64_t D = 29066;    // δ
    const int64_t K_FP  = 80542;  // ≈ 1.230174105 * 2^16
    const int64_t Ki_FP = 53283;  // ≈ (1/1.230174105) * 2^16

    #define RN(x) (((x)>=0)?(((x)+ROUND)>>SHIFT):(-((-(x)+ROUND)>>SHIFT)))

    // Predict α
    for (int i = 0; i < length/2; ++i) {
        int s = temp[i];
        int sn = (i+1<half)? temp[i+1] : s;
        temp[half+i] += RN(A * (int64_t)(s + sn));
    }

    // Update β
    for (int i = 0; i < half; ++i) {
        int d = (half+i<length)? temp[half+i]:0;
        int dp = (i>0 && half+i-1<length)? temp[half+i-1]:d;
        temp[i] += RN(B * (int64_t)(dp + d));
    }

    // Predict γ
    for (int i = 0; i < length/2; ++i) {
        int s = temp[i];
        int sn = (i+1<half)? temp[i+1]:s;
        temp[half+i] += RN(G * (int64_t)(s + sn));
    }

    // Update δ
    for (int i = 0; i < half; ++i) {
        int d = (half+i<length)? temp[half+i]:0;
        int dp = (i>0 && half+i-1<length)? temp[half+i-1]:d;
        temp[i] += RN(D * (int64_t)(dp + d));
    }

    // Scaling
    for (int i = 0; i < half; ++i) {
        temp[i] = (((int64_t)temp[i] * K_FP  + ROUND) >> SHIFT);
    }
    for (int i = 0; i < length/2; ++i) {
        if (half + i < length) {
            temp[half + i] = (((int64_t)temp[half + i] * Ki_FP + ROUND) >> SHIFT);
        }
    }

    memcpy(data, temp, length * sizeof(float));
    free(temp);
    #undef RN
}

/**
 * Deslauriers-Dubuc 4-point interpolating wavelet forward 1D (DD-4).
 *
 * Uses four-sample prediction kernel: w[-1]=-1/16, w[0]=9/16, w[1]=9/16, w[2]=-1/16
 * Good for smooth signals and still images.
 *
 * @param data   In/out signal data
 * @param length Signal length
 */
static void dwt_dd4_forward_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Split into even/odd samples
    for (int i = 0; i < half; i++) {
        temp[i] = data[2 * i];
    }
    for (int i = 0; i < length / 2; i++) {
        temp[half + i] = data[2 * i + 1];
    }

    // DD-4 prediction step with four-point kernel
    for (int i = 0; i < length / 2; i++) {
        // Get four neighbouring even samples with symmetric boundary extension
        float s_m1, s_0, s_1, s_2;

        s_m1 = (i > 0) ? temp[i - 1] : temp[0];
        s_0 = temp[i];
        s_1 = (i + 1 < half) ? temp[i + 1] : temp[half - 1];
        s_2 = (i + 2 < half) ? temp[i + 2] : ((half > 1) ? temp[half - 2] : temp[half - 1]);

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

/**
 * Biorthogonal 13/7 wavelet forward 1D.
 *
 * Analysis filters: Low-pass (13 taps), High-pass (7 taps)
 * Simplified implementation using 5/3 structure with scaling.
 *
 * @param data   In/out signal data
 * @param length Signal length
 */
static void dwt_bior137_forward_1d(float *data, int length) {
    if (length < 2) return;

    const float K = 1.230174105f;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Predict step (high-pass)
    for (int i = 0; i < half; i++) {
        int idx = 2 * i + 1;
        if (idx < length) {
            float left = data[2 * i];
            float right = (2 * i + 2 < length) ? data[2 * i + 2] : data[2 * i];
            float prediction = 0.5f * (left + right);
            temp[half + i] = data[idx] - prediction;
        }
    }

    // Update step (low-pass)
    for (int i = 0; i < half; i++) {
        float update = 0.25f * ((i > 0 ? temp[half + i - 1] : 0) +
                               (i < half - 1 ? temp[half + i] : 0));
        temp[i] = data[2 * i] + update;
    }

    // Scaling
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

/**
 * Haar wavelet forward 1D transform.
 *
 * The simplest wavelet: averages (low-pass) and differences (high-pass).
 * Useful for temporal DWT in GOPs.
 *
 * @param data   In/out signal data
 * @param length Signal length
 */
static void dwt_haar_forward_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    for (int i = 0; i < half; i++) {
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
// 1D Inverse DWT Transforms
// =============================================================================

/**
 * CDF 5/3 reversible wavelet inverse 1D transform.
 *
 * Reverses dwt_53_forward_1d() transform exactly.
 *
 * @param data   In/out coefficient data
 * @param length Signal length
 */
static void dwt_53_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Copy low-pass and high-pass coefficients
    memcpy(temp, data, length * sizeof(float));

    // Undo update step
    for (int i = 0; i < half; i++) {
        float update = 0.25f * ((i > 0 ? temp[half + i - 1] : 0) +
                               (i < half - 1 ? temp[half + i] : 0));
        temp[i] -= update;
    }

    // Undo predict step
    for (int i = 0; i < half; i++) {
        int idx = 2 * i + 1;
        if (idx < length) {
            float pred = 0.5f * (temp[i] + ((i + 1 < half) ? temp[i + 1] : temp[i]));
            data[2 * i] = temp[i];
            data[idx] = temp[half + i] + pred;
        } else {
            data[2 * i] = temp[i];
        }
    }

    free(temp);
}

/**
 * Haar wavelet inverse 1D transform.
 *
 * Reverses dwt_haar_forward_1d() transform.
 *
 * @param data   In/out coefficient data
 * @param length Signal length
 */
static void dwt_haar_inverse_1d(float *data, int length) {
    if (length < 2) return;

    float *temp = malloc(length * sizeof(float));
    int half = (length + 1) / 2;

    // Reconstruct from averages and differences
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

// =============================================================================
// 2D DWT Transform
// =============================================================================

/**
 * Apply 2D forward DWT to a frame (in-place).
 *
 * Applies separable 1D transforms: horizontal (rows), then vertical (columns).
 * Supports multi-level decomposition.
 *
 * @param data        In/out 2D image data (row-major, width stride)
 * @param width       Image width
 * @param height      Image height
 * @param levels      Number of decomposition levels
 * @param filter_type Wavelet type (WAVELET_* constant)
 */
void tav_dwt_2d_forward(float *data, int width, int height, int levels, int filter_type) {
    const int max_size = (width > height) ? width : height;
    float *temp_row = malloc(max_size * sizeof(float));
    float *temp_col = malloc(max_size * sizeof(float));

    // Pre-calculate dimensions for each level
    int *widths = malloc((levels + 1) * sizeof(int));
    int *heights = malloc((levels + 1) * sizeof(int));
    widths[0] = width;
    heights[0] = height;
    for (int i = 1; i <= levels; i++) {
        widths[i] = (widths[i - 1] + 1) / 2;
        heights[i] = (heights[i - 1] + 1) / 2;
    }

    // Apply multi-level decomposition
    for (int level = 0; level < levels; level++) {
        int current_width = widths[level];
        int current_height = heights[level];
        if (current_width < 1 || current_height < 1) break;

        // Row transform (horizontal)
        for (int y = 0; y < current_height; y++) {
            // Extract row
            for (int x = 0; x < current_width; x++) {
                temp_row[x] = data[y * width + x];
            }

            // Apply 1D DWT
            switch (filter_type) {
                case WAVELET_5_3_REVERSIBLE:
                    dwt_53_forward_1d(temp_row, current_width);
                    break;
                case WAVELET_9_7_IRREVERSIBLE:
                    dwt_97_forward_1d(temp_row, current_width);
                    break;
                case WAVELET_BIORTHOGONAL_13_7:
                    dwt_bior137_forward_1d(temp_row, current_width);
                    break;
                case WAVELET_DD4:
                    dwt_dd4_forward_1d(temp_row, current_width);
                    break;
                case WAVELET_HAAR:
                    dwt_haar_forward_1d(temp_row, current_width);
                    break;
            }

            // Write back
            for (int x = 0; x < current_width; x++) {
                data[y * width + x] = temp_row[x];
            }
        }

        // Column transform (vertical)
        for (int x = 0; x < current_width; x++) {
            // Extract column
            for (int y = 0; y < current_height; y++) {
                temp_col[y] = data[y * width + x];
            }

            // Apply 1D DWT
            switch (filter_type) {
                case WAVELET_5_3_REVERSIBLE:
                    dwt_53_forward_1d(temp_col, current_height);
                    break;
                case WAVELET_9_7_IRREVERSIBLE:
                    dwt_97_forward_1d(temp_col, current_height);
                    break;
                case WAVELET_BIORTHOGONAL_13_7:
                    dwt_bior137_forward_1d(temp_col, current_height);
                    break;
                case WAVELET_DD4:
                    dwt_dd4_forward_1d(temp_col, current_height);
                    break;
                case WAVELET_HAAR:
                    dwt_haar_forward_1d(temp_col, current_height);
                    break;
            }

            // Write back
            for (int y = 0; y < current_height; y++) {
                data[y * width + x] = temp_col[y];
            }
        }
    }

    free(widths);
    free(heights);
    free(temp_row);
    free(temp_col);
}

// =============================================================================
// 3D DWT Transform (Temporal + Spatial)
// =============================================================================

/**
 * Apply 3D forward DWT to a GOP (group of pictures).
 *
 * First applies temporal DWT across frames at each spatial location,
 * then applies 2D spatial DWT to each resulting temporal subband.
 *
 * @param gop_data        Array of frame pointers [num_frames][width*height]
 * @param width           Frame width
 * @param height          Frame height
 * @param num_frames      Number of frames in GOP
 * @param spatial_levels  Number of 2D spatial decomposition levels
 * @param temporal_levels Number of 1D temporal decomposition levels
 * @param spatial_filter  Wavelet type for spatial transform
 * @param temporal_filter Wavelet type for temporal transform (0=Haar, 1=5/3)
 */
void tav_dwt_3d_forward(float **gop_data, int width, int height, int num_frames,
                        int spatial_levels, int temporal_levels,
                        int spatial_filter, int temporal_filter) {
    if (num_frames < 2 || width < 2 || height < 2) return;

    float *temporal_line = malloc(num_frames * sizeof(float));

    // Pre-calculate temporal lengths for non-power-of-2 GOPs
    int *temporal_lengths = malloc((temporal_levels + 1) * sizeof(int));
    temporal_lengths[0] = num_frames;
    for (int i = 1; i <= temporal_levels; i++) {
        temporal_lengths[i] = (temporal_lengths[i - 1] + 1) / 2;
    }

    // Step 1: Apply temporal DWT across frames
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            int pixel_idx = y * width + x;

            // Extract temporal signal
            for (int t = 0; t < num_frames; t++) {
                temporal_line[t] = gop_data[t][pixel_idx];
            }

            // Apply temporal DWT with multiple levels
            for (int level = 0; level < temporal_levels; level++) {
                int level_frames = temporal_lengths[level];
                if (level_frames >= 2) {
                    if (temporal_filter == 255) {
                        // Haar temporal (default)
                        dwt_haar_forward_1d(temporal_line, level_frames);
                    } else if (temporal_filter == 0) {
                        // CDF 5/3 temporal
                        dwt_53_forward_1d(temporal_line, level_frames);
                    } else {
                        // Fallback to Haar for unsupported wavelets
                        dwt_haar_forward_1d(temporal_line, level_frames);
                    }
                }
            }

            // Write back temporal coefficients
            for (int t = 0; t < num_frames; t++) {
                gop_data[t][pixel_idx] = temporal_line[t];
            }
        }
    }

    free(temporal_lengths);
    free(temporal_line);

    // Step 2: Apply 2D spatial DWT to each temporal subband
    for (int t = 0; t < num_frames; t++) {
        tav_dwt_2d_forward(gop_data[t], width, height, spatial_levels, spatial_filter);
    }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculate recommended number of decomposition levels for given dimensions.
 *
 * @param width  Image width
 * @param height Image height
 * @return       Recommended number of levels (1-6)
 */
int tav_dwt_calculate_levels(int width, int height) {
    int levels = 0;
    int min_size = (width < height) ? width : height;

    // Keep halving until we reach minimum size
    while (min_size >= 32) {
        min_size /= 2;
        levels++;
    }

    // Cap at reasonable maximum
    return (levels > 6) ? 6 : levels;
}
