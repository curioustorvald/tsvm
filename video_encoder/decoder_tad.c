// Created by CuriousTorvald and Claude on 2025-10-23.
// TAD (Terrarum Advanced Audio) Decoder - Reconstructs audio from TAD format

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include <getopt.h>

#define DECODER_VENDOR_STRING "Decoder-TAD 20251023"

// TAD format constants (must match encoder)
#define TAD_COEFF_SCALAR 1024.0f
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
    if (chunk_size < TAD_MIN_CHUNK_SIZE) {
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
    return levels - 2;
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
        dwt_dd4_inverse_1d(data, current_length);  // THEN apply inverse
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

static void ms_correlate(const float *mid, const float *side, uint8_t *left, uint8_t *right, size_t count, float dither_error[2][2]) {
    const float b1 = 1.5f;   // 1st feedback coefficient
    const float b2 = -0.75f; // 2nd feedback coefficient
    const float scale = 127.5f;
    const float bias  = 128.0f;

    for (size_t i = 0; i < count; i++) {
        // Decode M/S → L/R
        float m = mid[i];
        float s = side[i];
        float l = FCLAMP(m + s, -1.0f, 1.0f);
        float r = FCLAMP(m - s, -1.0f, 1.0f);

        // --- LEFT channel ---
        float feedbackL = b1 * dither_error[0][0] + b2 * dither_error[0][1];
        float ditherL = 0.5f * tpdf1(); // ±0.5 LSB TPDF
        float shapedL = l + feedbackL + ditherL / scale;
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
        float shapedR = r + feedbackR + ditherR / scale;
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

    float quality_scale = 4.0f + FCLAMP((3 - quality) * 0.5f, 0.0f, 1000.0f);

    for (int i = 0; i < dwt_levels; i++) {
        weights[i] = FCLAMP(base_weights[dwt_levels][i] * quality_scale, 1.0f, 1000.0f);
    }
}

static void dequantize_dwt_coefficients(const int16_t *quantized, float *coeffs, size_t count, int quality, int chunk_size, int dwt_levels) {
    float weights[16];
    get_quantization_weights(quality, dwt_levels, weights);

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

        // Map (dwt_levels+1) sidebands to dwt_levels weights
        int weight_idx = (sideband == 0) ? 0 : sideband - 1;
        if (weight_idx >= dwt_levels) weight_idx = dwt_levels - 1;

        float weight = weights[weight_idx];
        coeffs[i] = (float)quantized[i] * weight / TAD_COEFF_SCALAR;
    }

    free(sideband_starts);
}

//=============================================================================
// Significance Map Decoding
//=============================================================================

static size_t decode_sigmap_2bit(const uint8_t *input, int16_t *values, size_t count) {
    size_t map_bytes = (count * 2 + 7) / 8;
    const uint8_t *map = input;
    const uint8_t *read_ptr = input + map_bytes;

    const int16_t *value_ptr = (const int16_t*)read_ptr;
    uint32_t other_idx = 0;

    for (size_t i = 0; i < count; i++) {
        size_t bit_pos = i * 2;
        size_t byte_idx = bit_pos / 8;
        size_t bit_offset = bit_pos % 8;

        uint8_t code = (map[byte_idx] >> bit_offset) & 0x03;

        // Handle bit spillover
        if (bit_offset == 7) {
            code = (map[byte_idx] >> 7) | ((map[byte_idx + 1] & 0x01) << 1);
        }

        switch (code) {
            case 0: values[i] = 0; break;
            case 1: values[i] = 1; break;
            case 2: values[i] = -1; break;
            case 3: values[i] = value_ptr[other_idx++]; break;
        }
    }

    return map_bytes + other_idx * sizeof(int16_t);
}

//=============================================================================
// Chunk Decoding
//=============================================================================

static int decode_chunk(const uint8_t *input, size_t input_size, uint8_t *pcmu8_stereo,
                        int quality, size_t *bytes_consumed, size_t *samples_decoded) {
    const uint8_t *read_ptr = input;

    // Read chunk header
    uint16_t sample_count = *((const uint16_t*)read_ptr);
    read_ptr += sizeof(uint16_t);
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
    uint8_t *pcm8_left = malloc(sample_count * sizeof(uint8_t));
    uint8_t *pcm8_right = malloc(sample_count * sizeof(uint8_t));

    // Decode significance maps
    const uint8_t *payload_ptr = payload;
    size_t mid_bytes, side_bytes;

    mid_bytes = decode_sigmap_2bit(payload_ptr, quant_mid, sample_count);
    side_bytes = decode_sigmap_2bit(payload_ptr + mid_bytes, quant_side, sample_count);

    // Dequantize
    dequantize_dwt_coefficients(quant_mid, dwt_mid, sample_count, quality, sample_count, dwt_levels);
    dequantize_dwt_coefficients(quant_side, dwt_side, sample_count, quality, sample_count, dwt_levels);

    // Inverse DWT
    dwt_haar_inverse_multilevel(dwt_mid, sample_count, dwt_levels);
    dwt_haar_inverse_multilevel(dwt_side, sample_count, dwt_levels);

    float err[2][2] = {{0,0},{0,0}};

    // M/S to L/R correlation
    ms_correlate(dwt_mid, dwt_side, pcm8_left, pcm8_right, sample_count, err);

    // Interleave stereo output (PCMu8)
    for (size_t i = 0; i < sample_count; i++) {
        pcmu8_stereo[i * 2] = pcm8_left[i];
        pcmu8_stereo[i * 2 + 1] = pcm8_right[i];
    }

    // Cleanup
    free(quant_mid); free(quant_side); free(dwt_mid); free(dwt_side);
    free(pcm8_left); free(pcm8_right);
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
    printf("  -q <0-5>        Quality level used during encoding (default: 3)\n");
    printf("  -v              Verbose output\n");
    printf("  -h, --help      Show this help\n");
    printf("\nVersion: %s\n", DECODER_VENDOR_STRING);
    printf("Output format: PCMu8 (unsigned 8-bit) stereo @ 32000 Hz\n");
    printf("To convert to WAV: ffmpeg -f u8 -ar 32000 -ac 2 -i output.raw output.wav\n");
}

int main(int argc, char *argv[]) {
    char *input_file = NULL;
    char *output_file = NULL;
    int quality = 3;  // Must match encoder quality
    int verbose = 0;

    int opt;
    while ((opt = getopt(argc, argv, "i:o:q:vh")) != -1) {
        switch (opt) {
            case 'i':
                input_file = optarg;
                break;
            case 'o':
                output_file = optarg;
                break;
            case 'q':
                quality = atoi(optarg);
                if (quality < TAD_QUALITY_MIN || quality > TAD_QUALITY_MAX) {
                    fprintf(stderr, "Error: Quality must be between %d and %d\n",
                            TAD_QUALITY_MIN, TAD_QUALITY_MAX);
                    return 1;
                }
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
        printf("Quality: %d\n", quality);
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
                                  chunk_output, quality, &bytes_consumed, &samples_decoded);

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
