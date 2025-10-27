// Created by CuriousTorvald and Claude on 2025-10-23.
// TAD (Terrarum Advanced Audio) Decoder - Reconstructs audio from TAD format

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include <getopt.h>

#define DECODER_VENDOR_STRING "Decoder-TAD 20251026"

// TAD format constants (must match encoder)
#undef TAD32_COEFF_SCALARS

// Coefficient scalars for each subband (CDF 9/7 with 9 decomposition levels)
// Index 0 = LL band, Index 1-9 = H bands (L9 to L1)
static const float TAD32_COEFF_SCALARS[] = {64.0f, 45.255f, 32.0f, 22.627f, 16.0f, 11.314f, 8.0f, 5.657f, 4.0f, 2.828f};

#define TAD_DEFAULT_CHUNK_SIZE 32768
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

static void dwt_haar_inverse_multilevel(float *data, int length, int levels) {
    // Calculate the length at the deepest level (size of low-pass after all forward DWTs)
    int current_length = length;
    for (int level = 0; level < levels; level++) {
        current_length = (current_length + 1) / 2;
    }
    // For 8 levels on 32768: 32768→16384→8192→4096→2048→1024→512→256→128

    // Inverse transform: double size FIRST, then apply inverse DWT
    // Level 8 inverse: 128 low + 128 high → 256 reconstructed
    // Level 7 inverse: 256 reconstructed + 256 high → 512 reconstructed
    // ... Level 1 inverse: 16384 reconstructed + 16384 high → 32768 reconstructed
    for (int level = levels - 1; level >= 0; level--) {
        current_length *= 2;  // MULTIPLY FIRST: 128→256, 256→512, ..., 16384→32768
        if (current_length > length) current_length = length;
//        dwt_haar_inverse_1d(data, current_length);  // THEN apply inverse
//        dwt_dd4_inverse_1d(data, current_length);  // THEN apply inverse
        dwt_97_inverse_1d(data, current_length);  // THEN apply inverse
    }
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

static void pcm32f_to_pcm8(const float *fleft, const float *fright, uint8_t *left, uint8_t *right, size_t count, float dither_error[2][2]) {
    const float b1 = 1.5f;   // 1st feedback coefficient
    const float b2 = -0.75f; // 2nd feedback coefficient
    const float scale = 127.5f;
    const float bias  = 128.0f;

    for (size_t i = 0; i < count; i++) {
        // --- LEFT channel ---
        float feedbackL = b1 * dither_error[0][0] + b2 * dither_error[0][1];
        float ditherL = 0.5f * tpdf1(); // ±0.5 LSB TPDF
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
        float ditherR = 0.5f * tpdf1();
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


#define LAMBDA_FIXED 5.0f

// Lambda-based decompanding decoder (inverse of Laplacian CDF-based encoder)
// Converts quantized index back to normalized float in [-1, 1]
static float lambda_decompanding(int16_t quant_val, int max_index) {
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

static void dequantize_dwt_coefficients(const int16_t *quantized, float *coeffs, size_t count, int chunk_size, int dwt_levels, int max_index) {

    // Calculate sideband boundaries dynamically
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
            if (i < sideband_starts[s + 1]) {
                sideband = s;
                break;
            }
        }

        // Decode using lambda companding
        float normalized_val = lambda_decompanding(quantized[i], max_index);

        // Denormalize using the subband scalar
        coeffs[i] = normalized_val * TAD32_COEFF_SCALARS[sideband];
    }

    free(sideband_starts);
}

//=============================================================================
// Bitplane Decoding with Delta Prediction
//=============================================================================

// Pure bitplane decoding with delta prediction: each coefficient uses exactly (quant_bits + 1) bits
// Bit layout: 1 sign bit + quant_bits magnitude bits
// Sign bit: 0 = positive/zero, 1 = negative
// Magnitude: unsigned value [0, 2^quant_bits - 1]
// Delta prediction: plane[i] ^= plane[i-1] (reversed by same operation)
static size_t decode_bitplanes(const uint8_t *input, int16_t *values, size_t count, int max_index) {
    int bits_per_coeff = ((int)ceilf(log2f(max_index))) + 1;  // 1 sign bit + quant_bits magnitude bits
    size_t plane_bytes = (count + 7) / 8;  // Bytes needed for one bitplane
    size_t input_bytes = plane_bytes * bits_per_coeff;

    // Allocate temporary bitplanes
    uint8_t **bitplanes = malloc(bits_per_coeff * sizeof(uint8_t*));
    for (int plane = 0; plane < bits_per_coeff; plane++) {
        bitplanes[plane] = malloc(plane_bytes);
        memcpy(bitplanes[plane], input + (plane * plane_bytes), plane_bytes);
    }

    // Reconstruct coefficients from bitplanes
    for (size_t i = 0; i < count; i++) {
        size_t byte_idx = i / 8;
        size_t bit_offset = i % 8;

        // Read sign bit (plane 0)
        uint8_t sign_bit = (bitplanes[0][byte_idx] >> bit_offset) & 0x01;

        // Read magnitude bits (planes 1 to quant_bits)
        uint16_t magnitude = 0;
        for (int b = 0; b < bits_per_coeff - 1; b++) {
            if (bitplanes[b + 1][byte_idx] & (1 << bit_offset)) {
                magnitude |= (1 << b);
            }
        }

        // Reconstruct signed value
        values[i] = sign_bit ? -(int16_t)magnitude : (int16_t)magnitude;
    }

    // Free temporary bitplanes
    for (int plane = 0; plane < bits_per_coeff; plane++) {
        free(bitplanes[plane]);
    }
    free(bitplanes);

    return input_bytes;
}

//=============================================================================
// Chunk Decoding
//=============================================================================

static int decode_chunk(const uint8_t *input, size_t input_size, uint8_t *pcmu8_stereo,
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
    size_t decompressed_size = sample_count * 4 * sizeof(int16_t);
    decompressed = malloc(decompressed_size);

    size_t actual_size = ZSTD_decompress(decompressed, decompressed_size, read_ptr, payload_size);

    if (ZSTD_isError(actual_size)) {
        fprintf(stderr, "Error: Zstd decompression failed: %s\n", ZSTD_getErrorName(actual_size));
        free(decompressed);
        return -1;
    }

    payload = decompressed;

    read_ptr += payload_size;
    *bytes_consumed = read_ptr - input;
    *samples_decoded = sample_count;

    // Allocate working buffers
    int16_t *quant_mid = malloc(sample_count * sizeof(int16_t));
    int16_t *quant_side = malloc(sample_count * sizeof(int16_t));
    float *dwt_mid = malloc(sample_count * sizeof(float));
    float *dwt_side = malloc(sample_count * sizeof(float));
    float *pcm32_left = malloc(sample_count * sizeof(float));
    float *pcm32_right = malloc(sample_count * sizeof(float));
    uint8_t *pcm8_left = malloc(sample_count * sizeof(uint8_t));
    uint8_t *pcm8_right = malloc(sample_count * sizeof(uint8_t));

    // Decode bitplanes
    const uint8_t *payload_ptr = payload;
    size_t mid_bytes, side_bytes;

    mid_bytes = decode_bitplanes(payload_ptr, quant_mid, sample_count, max_index);
    side_bytes = decode_bitplanes(payload_ptr + mid_bytes, quant_side, sample_count, max_index);

    // Dequantize
    dequantize_dwt_coefficients(quant_mid, dwt_mid, sample_count, sample_count, dwt_levels, max_index);
    dequantize_dwt_coefficients(quant_side, dwt_side, sample_count, sample_count, dwt_levels, max_index);

    // Inverse DWT
    dwt_haar_inverse_multilevel(dwt_mid, sample_count, dwt_levels);
    dwt_haar_inverse_multilevel(dwt_side, sample_count, dwt_levels);

    float err[2][2] = {{0,0},{0,0}};

    // M/S to L/R correlation
    ms_correlate(dwt_mid, dwt_side, pcm32_left, pcm32_right, sample_count);

    // expand dynamic range
    expand_gamma(pcm32_left, pcm32_right, sample_count);

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

static void print_usage(const char *prog_name) {
    printf("Usage: %s -i <input> -o <output> [options]\n", prog_name);
    printf("Options:\n");
    printf("  -i <file>       Input TAD file\n");
    printf("  -o <file>       Output PCMu8 file (raw 8-bit unsigned stereo @ 32kHz)\n");
    printf("  -v              Verbose output\n");
    printf("  -h, --help      Show this help\n");
    printf("\nVersion: %s\n", DECODER_VENDOR_STRING);
    printf("Output format: PCMu8 (unsigned 8-bit) stereo @ 32000 Hz\n");
    printf("To convert to WAV: ffmpeg -f u8 -ar 32000 -ac 2 -i output.raw output.wav\n");
}

int main(int argc, char *argv[]) {
    char *input_file = NULL;
    char *output_file = NULL;
    int verbose = 0;

    int opt;
    while ((opt = getopt(argc, argv, "i:o:vh")) != -1) {
        switch (opt) {
            case 'i':
                input_file = optarg;
                break;
            case 'o':
                output_file = optarg;
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

    if (!input_file || !output_file) {
        fprintf(stderr, "Error: Input and output files are required\n");
        print_usage(argv[0]);
        return 1;
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

    // Decode chunks
    size_t offset = 0;
    size_t chunk_count = 0;
    size_t total_samples = 0;
    // Allocate buffer for maximum chunk size (can handle variable sizes up to default)
    uint8_t *chunk_output = malloc(TAD_DEFAULT_CHUNK_SIZE * TAD_CHANNELS);

    while (offset < input_size) {
        size_t bytes_consumed, samples_decoded;
        int result = decode_chunk(input_data + offset, input_size - offset,
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

    // Cleanup
    free(input_data);
    free(chunk_output);
    fclose(output);

    printf("Output written to: %s\n", output_file);
    printf("Format: PCMu8 stereo @ %d Hz\n", TAD_SAMPLE_RATE);

    return 0;
}
