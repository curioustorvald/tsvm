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

    if (coeff == 1) {
        // +1: Light green #55FF55
        color.r = 0x55;
        color.g = 0xFF;
        color.b = 0x55;
        return color;
    }

    if (coeff == -1) {
        // -1: Dark green #005500
        color.r = 0x00;
        color.g = 0x55;
        color.b = 0x00;
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
    size_t zeros = 0, ones = 0, positives = 0, negatives = 0;
    int16_t min_val = INT16_MAX, max_val = INT16_MIN;

    // Calculate overall statistics
    for (size_t i = 0; i < expected_count; i++) {
        if (coeffs[i] == 0) zeros++;
        else if (coeffs[i] == 1 || coeffs[i] == -1) ones++;
        else if (coeffs[i] > 0) positives++;
        else negatives++;

        if (coeffs[i] < min_val) min_val = coeffs[i];
        if (coeffs[i] > max_val) max_val = coeffs[i];
    }

    printf("Overall coefficient statistics:\n");
    printf("  Total: %zu\n", expected_count);
    printf("  Zeros: %zu (%.1f%%)\n", zeros, 100.0 * zeros / expected_count);
    printf("  Ones: %zu (%.1f%%)\n", ones, 100.0 * ones / expected_count);
    printf("  Positives: %zu (%.1f%%)\n", positives, 100.0 * positives / expected_count);
    printf("  Negatives: %zu (%.1f%%)\n", negatives, 100.0 * negatives / expected_count);
    printf("  Range: [%d, %d]\n\n", min_val, max_val);

    // Per-subband statistics using 2D spatial layout
    // The coefficients are stored in 2D spatial arrangement like the PPM image
    int num_levels = 6;

    // Helper macro to get coefficient from 2D position
    #define GET_COEFF(x, y) coeffs[(y) * width + (x)]

    // Calculate subband dimensions for each level
    int level_w[7], level_h[7];  // level_w[1] = width/2, level_w[6] = width/64
    for (int i = 1; i <= num_levels; i++) {
        level_w[i] = width / (1 << i);
        level_h[i] = height / (1 << i);
    }

    // LL6 subband (top-left corner)
    {
        int ll_w = level_w[6], ll_h = level_h[6];
        size_t ll_zeros = 0, ll_ones = 0, ll_pos = 0, ll_neg = 0;
        int16_t ll_min = INT16_MAX, ll_max = INT16_MIN;

        for (int y = 0; y < ll_h; y++) {
            for (int x = 0; x < ll_w; x++) {
                int16_t val = GET_COEFF(x, y);
                if (val == 0) ll_zeros++;
                else if (val == 1 || val == -1) ll_ones++;
                else if (val > 0) ll_pos++;
                else ll_neg++;
                if (val < ll_min) ll_min = val;
                if (val > ll_max) ll_max = val;
            }
        }

        size_t ll_total = ll_w * ll_h;
        printf("LL%d subband (%dx%d):\n", num_levels, ll_w, ll_h);
        printf("  Total: %zu\n", ll_total);
        printf("  Zeros: %zu (%.1f%%)\n", ll_zeros, 100.0 * ll_zeros / ll_total);
        printf("  Ones: %zu (%.1f%%)\n", ll_ones, 100.0 * ll_ones / ll_total);
        printf("  Positives: %zu (%.1f%%)\n", ll_pos, 100.0 * ll_pos / ll_total);
        printf("  Negatives: %zu (%.1f%%)\n", ll_neg, 100.0 * ll_neg / ll_total);
        printf("  Range: [%d, %d]\n\n", ll_min, ll_max);
    }

    // Process each level from deepest (6) to finest (1)
    for (int level = num_levels; level >= 1; level--) {
        int half_w = level_w[level];
        int half_h = level_h[level];

        // LH subband (horizontal high-pass) - right of LL region
        size_t lh_zeros = 0, lh_ones = 0, lh_pos = 0, lh_neg = 0;
        int16_t lh_min = INT16_MAX, lh_max = INT16_MIN;
        int lh_x0 = half_w, lh_y0 = 0;
        int lh_x1 = half_w * 2, lh_y1 = half_h;

        for (int y = lh_y0; y < lh_y1; y++) {
            for (int x = lh_x0; x < lh_x1; x++) {
                int16_t val = GET_COEFF(x, y);
                if (val == 0) lh_zeros++;
                else if (val == 1 || val == -1) lh_ones++;
                else if (val > 0) lh_pos++;
                else lh_neg++;
                if (val < lh_min) lh_min = val;
                if (val > lh_max) lh_max = val;
            }
        }

        // HL subband (vertical high-pass) - below LL region
        size_t hl_zeros = 0, hl_ones = 0, hl_pos = 0, hl_neg = 0;
        int16_t hl_min = INT16_MAX, hl_max = INT16_MIN;
        int hl_x0 = 0, hl_y0 = half_h;
        int hl_x1 = half_w, hl_y1 = half_h * 2;

        for (int y = hl_y0; y < hl_y1; y++) {
            for (int x = hl_x0; x < hl_x1; x++) {
                int16_t val = GET_COEFF(x, y);
                if (val == 0) hl_zeros++;
                else if (val == 1 || val == -1) hl_ones++;
                else if (val > 0) hl_pos++;
                else hl_neg++;
                if (val < hl_min) hl_min = val;
                if (val > hl_max) hl_max = val;
            }
        }

        // HH subband (diagonal high-pass) - bottom-right of LL region
        size_t hh_zeros = 0, hh_ones = 0, hh_pos = 0, hh_neg = 0;
        int16_t hh_min = INT16_MAX, hh_max = INT16_MIN;
        int hh_x0 = half_w, hh_y0 = half_h;
        int hh_x1 = half_w * 2, hh_y1 = half_h * 2;

        for (int y = hh_y0; y < hh_y1; y++) {
            for (int x = hh_x0; x < hh_x1; x++) {
                int16_t val = GET_COEFF(x, y);
                if (val == 0) hh_zeros++;
                else if (val == 1 || val == -1) hh_ones++;
                else if (val > 0) hh_pos++;
                else hh_neg++;
                if (val < hh_min) hh_min = val;
                if (val > hh_max) hh_max = val;
            }
        }

        size_t sub_total = half_w * half_h;
        printf("Level %d subbands (%dx%d each):\n", level, half_w, half_h);
        printf("  LH%d: Total=%zu, Zeros=%zu (%.1f%%), Ones=%zu (%.1f%%), Pos=%zu (%.1f%%), Neg=%zu (%.1f%%), Range=[%d,%d]\n",
               level, sub_total, lh_zeros, 100.0*lh_zeros/sub_total, lh_ones, 100.0*lh_ones/sub_total,
               lh_pos, 100.0*lh_pos/sub_total, lh_neg, 100.0*lh_neg/sub_total, lh_min, lh_max);
        printf("  HL%d: Total=%zu, Zeros=%zu (%.1f%%), Ones=%zu (%.1f%%), Pos=%zu (%.1f%%), Neg=%zu (%.1f%%), Range=[%d,%d]\n",
               level, sub_total, hl_zeros, 100.0*hl_zeros/sub_total, hl_ones, 100.0*hl_ones/sub_total,
               hl_pos, 100.0*hl_pos/sub_total, hl_neg, 100.0*hl_neg/sub_total, hl_min, hl_max);
        printf("  HH%d: Total=%zu, Zeros=%zu (%.1f%%), Ones=%zu (%.1f%%), Pos=%zu (%.1f%%), Neg=%zu (%.1f%%), Range=[%d,%d]\n\n",
               level, sub_total, hh_zeros, 100.0*hh_zeros/sub_total, hh_ones, 100.0*hh_ones/sub_total,
               hh_pos, 100.0*hh_pos/sub_total, hh_neg, 100.0*hh_neg/sub_total, hh_min, hh_max);
    }

    #undef GET_COEFF

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
    printf("  Light Green (#55FF55): +1 coefficients\n");
    printf("  Dark Green (#00AA00): -1 coefficients\n");
    printf("  Red→Yellow: Positive coefficients > +1 (logarithmic)\n");
    printf("  Blue→Cyan: Negative coefficients < -1 (logarithmic)\n");

    return 0;
}
