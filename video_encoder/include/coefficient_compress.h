// Simple coefficient preprocessing for better compression
// Insert right before Zstd compression

#ifndef COEFFICIENT_COMPRESS_H
#define COEFFICIENT_COMPRESS_H

#include <stdint.h>
#include <string.h>

// Preprocess coefficients using significance map
// Returns new buffer size, modifies buffer in-place if possible
static size_t preprocess_coefficients(int16_t *coeffs, int coeff_count, uint8_t *output_buffer) {
    // Count non-zero coefficients
    int nonzero_count = 0;
    for (int i = 0; i < coeff_count; i++) {
        if (coeffs[i] != 0) nonzero_count++;
    }

    // Create significance map (1 bit per coefficient, packed into bytes)
    int map_bytes = (coeff_count + 7) / 8;  // Round up to nearest byte
    uint8_t *sig_map = output_buffer;
    int16_t *values = (int16_t *)(output_buffer + map_bytes);

    // Clear significance map
    memset(sig_map, 0, map_bytes);

    // Fill significance map and extract non-zero values
    int value_idx = 0;
    for (int i = 0; i < coeff_count; i++) {
        if (coeffs[i] != 0) {
            // Set bit in significance map
            int byte_idx = i / 8;
            int bit_idx = i % 8;
            sig_map[byte_idx] |= (1 << bit_idx);

            // Store the value
            values[value_idx++] = coeffs[i];
        }
    }

    return map_bytes + (nonzero_count * sizeof(int16_t));
}

// Decoder: reconstruct coefficients from significance map
static void postprocess_coefficients(uint8_t *compressed_data, int coeff_count, int16_t *output_coeffs) {
    int map_bytes = (coeff_count + 7) / 8;
    uint8_t *sig_map = compressed_data;
    int16_t *values = (int16_t *)(compressed_data + map_bytes);

    // Clear output
    memset(output_coeffs, 0, coeff_count * sizeof(int16_t));

    // Reconstruct coefficients
    int value_idx = 0;
    for (int i = 0; i < coeff_count; i++) {
        int byte_idx = i / 8;
        int bit_idx = i % 8;

        if (sig_map[byte_idx] & (1 << bit_idx)) {
            output_coeffs[i] = values[value_idx++];
        }
    }
}

#endif // COEFFICIENT_COMPRESS_H