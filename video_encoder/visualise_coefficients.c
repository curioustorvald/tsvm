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

    // Analyse coefficient distribution
    size_t zeros = 0, positives = 0, negatives = 0;
    int16_t min_val = INT16_MAX, max_val = INT16_MIN;

    for (size_t i = 0; i < expected_count; i++) {
        if (coeffs[i] == 0) zeros++;
        else if (coeffs[i] > 0) positives++;
        else negatives++;

        if (coeffs[i] < min_val) min_val = coeffs[i];
        if (coeffs[i] > max_val) max_val = coeffs[i];
    }

    printf("Coefficient statistics:\n");
    printf("  Total: %zu\n", expected_count);
    printf("  Zeros: %zu (%.1f%%)\n", zeros, 100.0 * zeros / expected_count);
    printf("  Positives: %zu (%.1f%%)\n", positives, 100.0 * positives / expected_count);
    printf("  Negatives: %zu (%.1f%%)\n", negatives, 100.0 * negatives / expected_count);
    printf("  Range: [%d, %d]\n", min_val, max_val);

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
