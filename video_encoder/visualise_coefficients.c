// Visualise DWT Coefficients as Image
// Converts .bin coefficient file to PPM image with logarithmic color mapping
// Usage: ./visualise_coefficients <input.bin> <output.ppm> <width> <height>

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <math.h>

// Logarithmic color mapping for coefficient visualisation
// Zero: Black (#000000)
// Positive: Red to Yellow (#FF0000 to #FFFF00) - logarithmic
// Negative: Blue to Cyan (#0000FF to #00FFFF) - logarithmic
typedef struct {
    uint8_t r, g, b;
} rgb_t;

static rgb_t map_coefficient_to_color(int16_t coeff) {
    rgb_t color = {0, 0, 0};

    if (coeff == 0) {
        // Zero: pure black
        return color;
    }

    if (coeff > 0) {
        // Positive: Red (#FF0000) to Yellow (#FFFF00)
        // Logarithmic mapping: log2(1) = 0, log2(32767) ≈ 14.99
        double log_val = log2((double)coeff);
        double log_max = log2(32767.0);
        double normalised = log_val / log_max;  // 0.0 to 1.0

        color.r = 255;
        color.g = (uint8_t)(normalised * 255.0);
        color.b = 0;
    } else {
        // Negative: Blue (#0000FF) to Cyan (#00FFFF)
        // Logarithmic mapping: log2(1) = 0, log2(32768) = 15
        double log_val = log2((double)(-coeff));
        double log_max = log2(32768.0);
        double normalised = log_val / log_max;  // 0.0 to 1.0

        color.r = 0;
        color.g = (uint8_t)(normalised * 255.0);
        color.b = 255;
    }

    return color;
}

int main(int argc, char *argv[]) {
    if (argc != 5) {
        printf("Usage: %s <input.bin> <output.ppm> <width> <height>\n", argv[0]);
        printf("Example: %s frame_060.tavframe.y.bin output.ppm 560 448\n", argv[0]);
        return 1;
    }

    const char *input_file = argv[1];
    const char *output_file = argv[2];
    int width = atoi(argv[3]);
    int height = atoi(argv[4]);

    if (width <= 0 || height <= 0) {
        printf("Error: Invalid dimensions %dx%d\n", width, height);
        return 1;
    }

    size_t expected_count = width * height;

    // Load coefficient file
    FILE *fp_in = fopen(input_file, "rb");
    if (!fp_in) {
        printf("Error: Cannot open %s\n", input_file);
        return 1;
    }

    // Get file size
    fseek(fp_in, 0, SEEK_END);
    long file_size = ftell(fp_in);
    fseek(fp_in, 0, SEEK_SET);

    size_t coeff_count = file_size / sizeof(int16_t);

    if (coeff_count != expected_count) {
        printf("Warning: File contains %zu coefficients, expected %zu (%dx%d)\n",
               coeff_count, expected_count, width, height);
    }

    // Allocate coefficient buffer
    int16_t *coeffs = malloc(expected_count * sizeof(int16_t));
    if (!coeffs) {
        printf("Error: Memory allocation failed\n");
        fclose(fp_in);
        return 1;
    }

    // Read coefficients
    size_t read_count = fread(coeffs, sizeof(int16_t), expected_count, fp_in);
    fclose(fp_in);

    if (read_count != expected_count) {
        printf("Error: Read %zu coefficients, expected %zu\n", read_count, expected_count);
        free(coeffs);
        return 1;
    }

    // Analyse coefficient distribution - Overall and per-subband
    size_t zeros = 0, positives = 0, negatives = 0;
    int16_t min_val = INT16_MAX, max_val = INT16_MIN;

    // Calculate overall statistics
    for (size_t i = 0; i < expected_count; i++) {
        if (coeffs[i] == 0) zeros++;
        else if (coeffs[i] > 0) positives++;
        else negatives++;

        if (coeffs[i] < min_val) min_val = coeffs[i];
        if (coeffs[i] > max_val) max_val = coeffs[i];
    }

    printf("Overall coefficient statistics:\n");
    printf("  Total: %zu\n", expected_count);
    printf("  Zeros: %zu (%.1f%%)\n", zeros, 100.0 * zeros / expected_count);
    printf("  Positives: %zu (%.1f%%)\n", positives, 100.0 * positives / expected_count);
    printf("  Negatives: %zu (%.1f%%)\n", negatives, 100.0 * negatives / expected_count);
    printf("  Range: [%d, %d]\n\n", min_val, max_val);

    // Per-subband statistics
    // Linear layout: [LL1, LH1, HL1, HH1, LH2, HL2, HH2, ..., LH6, HL6, HH6]
    size_t offset = 0;

    // Determine number of DWT levels (assuming standard 6-level for 560x448)
    int num_levels = 6;
    int w = width, h = height;

    // LL subband (deepest level, smallest)
    int ll_divisor = 1 << num_levels;  // 2^6 = 64
    int ll_w = w / ll_divisor;
    int ll_h = h / ll_divisor;
    size_t ll_size = ll_w * ll_h;

    if (offset + ll_size <= expected_count) {
        size_t ll_zeros = 0, ll_pos = 0, ll_neg = 0;
        int16_t ll_min = INT16_MAX, ll_max = INT16_MIN;

        for (size_t i = 0; i < ll_size; i++) {
            int16_t val = coeffs[offset + i];
            if (val == 0) ll_zeros++;
            else if (val > 0) ll_pos++;
            else ll_neg++;
            if (val < ll_min) ll_min = val;
            if (val > ll_max) ll_max = val;
        }

        printf("LL%d subband:\n", num_levels);
        printf("  Total: %zu\n", ll_size);
        printf("  Zeros: %zu (%.1f%%)\n", ll_zeros, 100.0 * ll_zeros / ll_size);
        printf("  Positives: %zu (%.1f%%)\n", ll_pos, 100.0 * ll_pos / ll_size);
        printf("  Negatives: %zu (%.1f%%)\n", ll_neg, 100.0 * ll_neg / ll_size);
        printf("  Range: [%d, %d]\n\n", ll_min, ll_max);

        offset += ll_size;
    }

    // LH, HL, HH subbands for each level (from deepest to finest)
    for (int level = num_levels; level >= 1; level--) {
        int divisor = 1 << level;  // 2^level
        int sub_w = w / divisor;
        int sub_h = h / divisor;
        size_t sub_size = sub_w * sub_h;

        if (offset + 3 * sub_size > expected_count) break;

        // LH subband
        size_t lh_zeros = 0, lh_pos = 0, lh_neg = 0;
        int16_t lh_min = INT16_MAX, lh_max = INT16_MIN;
        for (size_t i = 0; i < sub_size; i++) {
            int16_t val = coeffs[offset + i];
            if (val == 0) lh_zeros++;
            else if (val > 0) lh_pos++;
            else lh_neg++;
            if (val < lh_min) lh_min = val;
            if (val > lh_max) lh_max = val;
        }
        offset += sub_size;

        // HL subband
        size_t hl_zeros = 0, hl_pos = 0, hl_neg = 0;
        int16_t hl_min = INT16_MAX, hl_max = INT16_MIN;
        for (size_t i = 0; i < sub_size; i++) {
            int16_t val = coeffs[offset + i];
            if (val == 0) hl_zeros++;
            else if (val > 0) hl_pos++;
            else hl_neg++;
            if (val < hl_min) hl_min = val;
            if (val > hl_max) hl_max = val;
        }
        offset += sub_size;

        // HH subband
        size_t hh_zeros = 0, hh_pos = 0, hh_neg = 0;
        int16_t hh_min = INT16_MAX, hh_max = INT16_MIN;
        for (size_t i = 0; i < sub_size; i++) {
            int16_t val = coeffs[offset + i];
            if (val == 0) hh_zeros++;
            else if (val > 0) hh_pos++;
            else hh_neg++;
            if (val < hh_min) hh_min = val;
            if (val > hh_max) hh_max = val;
        }
        offset += sub_size;

        printf("Level %d subbands (%dx%d each):\n", level, sub_w, sub_h);
        printf("  LH%d: Total=%zu, Zeros=%zu (%.1f%%), Pos=%zu (%.1f%%), Neg=%zu (%.1f%%), Range=[%d,%d]\n",
               level, sub_size, lh_zeros, 100.0*lh_zeros/sub_size,
               lh_pos, 100.0*lh_pos/sub_size, lh_neg, 100.0*lh_neg/sub_size, lh_min, lh_max);
        printf("  HL%d: Total=%zu, Zeros=%zu (%.1f%%), Pos=%zu (%.1f%%), Neg=%zu (%.1f%%), Range=[%d,%d]\n",
               level, sub_size, hl_zeros, 100.0*hl_zeros/sub_size,
               hl_pos, 100.0*hl_pos/sub_size, hl_neg, 100.0*hl_neg/sub_size, hl_min, hl_max);
        printf("  HH%d: Total=%zu, Zeros=%zu (%.1f%%), Pos=%zu (%.1f%%), Neg=%zu (%.1f%%), Range=[%d,%d]\n\n",
               level, sub_size, hh_zeros, 100.0*hh_zeros/sub_size,
               hh_pos, 100.0*hh_pos/sub_size, hh_neg, 100.0*hh_neg/sub_size, hh_min, hh_max);
    }

    // Write PPM image
    FILE *fp_out = fopen(output_file, "wb");
    if (!fp_out) {
        printf("Error: Cannot create %s\n", output_file);
        free(coeffs);
        return 1;
    }

    // PPM header
    fprintf(fp_out, "P6\n%d %d\n255\n", width, height);

    // Write pixel data
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            size_t idx = y * width + x;
            rgb_t color = map_coefficient_to_color(coeffs[idx]);
            fwrite(&color, 3, 1, fp_out);
        }
    }

    fclose(fp_out);
    free(coeffs);

    printf("\nWrote %dx%d image to %s\n", width, height, output_file);
    printf("Color mapping:\n");
    printf("  Black:  Zero coefficients\n");
    printf("  Red→Yellow: Positive coefficients (logarithmic)\n");
    printf("  Blue→Cyan: Negative coefficients (logarithmic)\n");

    return 0;
}
