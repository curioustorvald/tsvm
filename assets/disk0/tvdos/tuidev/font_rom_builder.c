/*
 * font_rom_builder.c
 * Build TSVM 7x14 font ROM from human-readable images (.png, .tga)
 *
 * Input: Image with no gaps between characters (7x14 pixels per glyph)
 * Output: TSVM-compatible font ROM file(s) padded to 1920 bytes
 *
 * Usage:
 *   gcc -O2 -std=c99 -Wall font_rom_builder.c -o font_rom_builder
 *   ./font_rom_builder <input.png|tga> <output_prefix>
 *
 * For 128-char images: outputs <output_prefix>_high.chr
 * For 256-char images: outputs <output_prefix>_low.chr and <output_prefix>_high.chr
 *
 * Image layout:
 *   - 128 chars: 16 columns × 8 rows = 112×112 pixels
 *   - 256 chars: 16 columns × 16 rows = 112×224 pixels
 *             or 32 columns × 8 rows = 224×112 pixels
 *
 * ROM format:
 *   - Each glyph: 14 bytes (one byte per row)
 *   - Bit 6 = leftmost pixel, Bit 0 = rightmost pixel
 *   - Each ROM padded to 1920 bytes
 */

#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define GLYPH_W 7
#define GLYPH_H 14
#define GLYPH_BYTES 14
#define ROM_PADDED_SIZE 1920

static void die(const char *msg) {
    fprintf(stderr, "Error: %s\n", msg);
    exit(1);
}

static void write_rom(const char *filename, const uint8_t *glyphs, int glyph_count) {
    FILE *out = fopen(filename, "wb");
    if (!out) {
        fprintf(stderr, "Failed to open output file: %s\n", filename);
        exit(1);
    }

    // Write glyph data
    size_t data_size = glyph_count * GLYPH_BYTES;
    fwrite(glyphs, 1, data_size, out);

    // Pad to 1920 bytes
    if (data_size < ROM_PADDED_SIZE) {
        size_t padding = ROM_PADDED_SIZE - data_size;
        uint8_t *pad = calloc(padding, 1);
        fwrite(pad, 1, padding, out);
        free(pad);
        fprintf(stderr, "  Wrote %zu bytes + %zu bytes padding = %d bytes total\n",
                data_size, padding, ROM_PADDED_SIZE);
    } else {
        fprintf(stderr, "  Wrote %zu bytes (no padding needed)\n", data_size);
    }

    fclose(out);
    fprintf(stderr, "  Output: %s\n", filename);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <input.png|tga> <output_prefix>\n", argv[0]);
        fprintf(stderr, "\n");
        fprintf(stderr, "Converts human-readable font images to TSVM font ROM format.\n");
        fprintf(stderr, "\n");
        fprintf(stderr, "Input requirements:\n");
        fprintf(stderr, "  - Image with no gaps between characters\n");
        fprintf(stderr, "  - Each character is 7x14 pixels\n");
        fprintf(stderr, "  - 128 chars: typically 112x112 (16 cols × 8 rows)\n");
        fprintf(stderr, "  - 256 chars: typically 112x224 (16 cols × 16 rows)\n");
        fprintf(stderr, "\n");
        fprintf(stderr, "Output:\n");
        fprintf(stderr, "  - 128 chars: <prefix>_high.chr (high ROM only)\n");
        fprintf(stderr, "  - 256 chars: <prefix>_low.chr + <prefix>_high.chr\n");
        fprintf(stderr, "  - Each ROM padded to 1920 bytes\n");
        return 1;
    }

    const char *input_path = argv[1];
    const char *output_prefix = argv[2];

    // Get image dimensions using ImageMagick identify
    char cmd[1024];
    snprintf(cmd, sizeof(cmd), "identify -format '%%w %%h' \"%s\" 2>/dev/null", input_path);

    FILE *pipe = popen(cmd, "r");
    if (!pipe) die("Failed to run 'identify' command (ImageMagick required)");

    int img_w = 0, img_h = 0;
    if (fscanf(pipe, "%d %d", &img_w, &img_h) != 2) {
        pclose(pipe);
        die("Failed to read image dimensions (is ImageMagick installed?)");
    }
    pclose(pipe);

    fprintf(stderr, "Input: %s (%dx%d)\n", input_path, img_w, img_h);

    // Calculate grid dimensions
    int cols = img_w / GLYPH_W;
    int rows = img_h / GLYPH_H;
    int total_chars = cols * rows;

    if (img_w % GLYPH_W != 0 || img_h % GLYPH_H != 0) {
        fprintf(stderr, "Warning: Image dimensions not evenly divisible by %dx%d\n",
                GLYPH_W, GLYPH_H);
    }

    fprintf(stderr, "Grid: %d columns × %d rows = %d characters\n", cols, rows, total_chars);

    // Validate character count
    if (total_chars != 128 && total_chars != 256) {
        fprintf(stderr, "Error: Expected 128 or 256 characters, got %d\n", total_chars);
        fprintf(stderr, "  For 128 chars: use 112x112 (16×8) or similar layout\n");
        fprintf(stderr, "  For 256 chars: use 112x224 (16×16) or 224x112 (32×8)\n");
        return 1;
    }

    // Read image as grayscale using ImageMagick convert
    // IMPORTANT: Flatten alpha onto black background first, so transparent pixels become black
    size_t img_size = img_w * img_h;
    uint8_t *img_data = malloc(img_size);
    if (!img_data) die("Memory allocation failed");

    snprintf(cmd, sizeof(cmd),
             "convert \"%s\" -background black -alpha remove -colorspace Gray -depth 8 gray:- 2>/dev/null",
             input_path);

    pipe = popen(cmd, "r");
    if (!pipe) die("Failed to run 'convert' command (ImageMagick required)");

    if (fread(img_data, 1, img_size, pipe) != img_size) {
        pclose(pipe);
        die("Failed to read image data from ImageMagick");
    }
    pclose(pipe);

    fprintf(stderr, "Read %zu bytes of grayscale data\n", img_size);

    // Extract glyphs
    uint8_t *glyphs = calloc(total_chars, GLYPH_BYTES);
    if (!glyphs) die("Memory allocation failed");

    for (int gy = 0; gy < rows; gy++) {
        for (int gx = 0; gx < cols; gx++) {
            int glyph_idx = gy * cols + gx;
            uint8_t *glyph = &glyphs[glyph_idx * GLYPH_BYTES];

            for (int row = 0; row < GLYPH_H; row++) {
                uint8_t byte = 0;
                for (int col = 0; col < GLYPH_W; col++) {
                    int px = gx * GLYPH_W + col;
                    int py = gy * GLYPH_H + row;
                    uint8_t pixel = img_data[py * img_w + px];

                    // Threshold: >= 128 is foreground (white/lit)
                    int is_set = (pixel >= 128) ? 1 : 0;

                    // Pack: bit 6 = leftmost, bit 0 = rightmost
                    if (is_set) {
                        byte |= (1u << (6 - col));
                    }
                }
                glyph[row] = byte;
            }
        }
    }

    free(img_data);
    fprintf(stderr, "Extracted %d glyphs\n", total_chars);

    // Write output ROM file(s)
    char out_path[1024];

    if (total_chars == 128) {
        // High ROM only (chars 128-255)
        snprintf(out_path, sizeof(out_path), "%s.chr", output_prefix);
        fprintf(stderr, "\nWriting high ROM (128 chars):\n");
        write_rom(out_path, glyphs, 128);
    } else {
        // 256 chars: low ROM (0-127) and high ROM (128-255)
        snprintf(out_path, sizeof(out_path), "%s_low.chr", output_prefix);
        fprintf(stderr, "\nWriting low ROM (chars 0-127):\n");
        write_rom(out_path, glyphs, 128);

        snprintf(out_path, sizeof(out_path), "%s_high.chr", output_prefix);
        fprintf(stderr, "\nWriting high ROM (chars 128-255):\n");
        write_rom(out_path, &glyphs[128 * GLYPH_BYTES], 128);
    }

    free(glyphs);
    fprintf(stderr, "\nDone.\n");
    return 0;
}
