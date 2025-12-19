/**
 * iPF Decoder - TSVM Interchangeable Picture Format Decoder
 *
 * Decodes iPF format (Type 1 or Type 2) images to standard formats via FFmpeg.
 *
 * Created by CuriousTorvald and Claude on 2025-12-19.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <getopt.h>
#include <zstd.h>

// =============================================================================
// Constants
// =============================================================================

#define IPF_MAGIC "\x1F\x54\x53\x56\x4D\x69\x50\x46"  // "\x1FTSVMiPF"
#define IPF_HEADER_SIZE 28  // 8 magic + 2 width + 2 height + 1 flags + 1 type + 10 reserved + 4 uncompressed

#define IPF_TYPE_1 0  // 4:2:0 chroma subsampling
#define IPF_TYPE_2 1  // 4:2:2 chroma subsampling

#define IPF_FLAG_ALPHA       0x01
#define IPF_FLAG_ZSTD        0x10
#define IPF_FLAG_PROGRESSIVE 0x80

#define MAX_PATH 4096

// =============================================================================
// Structures
// =============================================================================

typedef struct {
    uint16_t width;
    uint16_t height;
    uint8_t flags;
    uint8_t type;
    uint32_t uncompressed_size;
} ipf_header_t;

typedef struct {
    char *input_file;
    char *output_file;
    int verbose;
    int raw_output;  // Output raw RGB instead of using FFmpeg
} decoder_config_t;

// =============================================================================
// Utility Functions
// =============================================================================

static void print_usage(const char *program) {
    printf("iPF Decoder - TSVM Interchangeable Picture Format\n");
    printf("\nUsage: %s -i input.ipf -o output.png [options]\n\n", program);
    printf("Required:\n");
    printf("  -i, --input FILE         Input iPF file\n");
    printf("  -o, --output FILE        Output image file (any format FFmpeg supports)\n");
    printf("\nOptions:\n");
    printf("  --raw                    Output raw RGB24/RGBA data instead of image file\n");
    printf("  -v, --verbose            Verbose output\n");
    printf("  -h, --help               Show this help\n");
    printf("\nExamples:\n");
    printf("  %s -i photo.ipf -o photo.png\n", program);
    printf("  %s -i logo.ipf -o logo.jpg -v\n", program);
}

static float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// =============================================================================
// iPF File Reading
// =============================================================================

static int read_ipf_header(FILE *fp, ipf_header_t *header) {
    uint8_t magic[8];

    if (fread(magic, 1, 8, fp) != 8) {
        fprintf(stderr, "Error: Failed to read magic\n");
        return -1;
    }

    if (memcmp(magic, IPF_MAGIC, 8) != 0) {
        fprintf(stderr, "Error: Invalid iPF magic\n");
        return -1;
    }

    // Read width (uint16 LE)
    if (fread(&header->width, 2, 1, fp) != 1) return -1;

    // Read height (uint16 LE)
    if (fread(&header->height, 2, 1, fp) != 1) return -1;

    // Read flags
    if (fread(&header->flags, 1, 1, fp) != 1) return -1;

    // Read type
    if (fread(&header->type, 1, 1, fp) != 1) return -1;

    // Skip reserved (10 bytes)
    fseek(fp, 10, SEEK_CUR);

    // Read uncompressed size (uint32 LE)
    if (fread(&header->uncompressed_size, 4, 1, fp) != 1) return -1;

    return 0;
}

// =============================================================================
// YCoCg to RGB Conversion
// =============================================================================

/**
 * Convert YCoCg to RGB for 4 pixels sharing the same chroma.
 * y_values: 4 Y values packed as nibbles (Y0|Y1 in low byte, Y2|Y3 in high byte style)
 * a_values: 4 alpha values packed similarly
 * co, cg: 4-bit chroma values [0..15]
 *
 * Output: fills rgb array with R,G,B[,A] values for 4 pixels
 */
static void ycocg_to_rgb_quad(int co, int cg, int y0, int y1, int y2, int y3,
                              int a0, int a1, int a2, int a3,
                              int has_alpha, uint8_t *rgb) {
    // Convert chroma from [0..15] to [-1..1]
    float co_f = (co - 7) / 8.0f;
    float cg_f = (cg - 7) / 8.0f;

    int ys[4] = {y0, y1, y2, y3};
    int as[4] = {a0, a1, a2, a3};

    int stride = has_alpha ? 4 : 3;

    for (int i = 0; i < 4; i++) {
        float y = ys[i] / 15.0f;

        // YCoCg to RGB conversion
        float tmp = y - cg_f / 2.0f;
        float g = clampf(cg_f + tmp, 0.0f, 1.0f);
        float b = clampf(tmp - co_f / 2.0f, 0.0f, 1.0f);
        float r = clampf(b + co_f, 0.0f, 1.0f);

        rgb[i * stride + 0] = (uint8_t)(r * 255.0f + 0.5f);
        rgb[i * stride + 1] = (uint8_t)(g * 255.0f + 0.5f);
        rgb[i * stride + 2] = (uint8_t)(b * 255.0f + 0.5f);

        if (has_alpha) {
            rgb[i * stride + 3] = (uint8_t)(as[i] * 17);  // Scale 0-15 to 0-255
        }
    }
}

/**
 * Decode iPF1 block (4:2:0 chroma subsampling).
 * Input: 12 bytes (or 20 with alpha)
 * Output: 16 pixels in RGB24/RGBA format
 */
static void decode_ipf1_block(const uint8_t *block, int has_alpha, uint8_t *pixels, int stride) {
    // Read chroma (4 values for 2x2 regions)
    int co1 = block[0] & 0x0F;
    int co2 = (block[0] >> 4) & 0x0F;
    int co3 = block[1] & 0x0F;
    int co4 = (block[1] >> 4) & 0x0F;

    int cg1 = block[2] & 0x0F;
    int cg2 = (block[2] >> 4) & 0x0F;
    int cg3 = block[3] & 0x0F;
    int cg4 = (block[3] >> 4) & 0x0F;

    // Read Y values (16 values)
    // Layout: [Y1|Y0|Y5|Y4], [Y3|Y2|Y7|Y6], [Y9|Y8|YD|YC], [YB|YA|YF|YE]
    int Y[16];
    Y[0] = block[4] & 0x0F;
    Y[1] = (block[4] >> 4) & 0x0F;
    Y[4] = block[5] & 0x0F;
    Y[5] = (block[5] >> 4) & 0x0F;
    Y[2] = block[6] & 0x0F;
    Y[3] = (block[6] >> 4) & 0x0F;
    Y[6] = block[7] & 0x0F;
    Y[7] = (block[7] >> 4) & 0x0F;
    Y[8] = block[8] & 0x0F;
    Y[9] = (block[8] >> 4) & 0x0F;
    Y[12] = block[9] & 0x0F;
    Y[13] = (block[9] >> 4) & 0x0F;
    Y[10] = block[10] & 0x0F;
    Y[11] = (block[10] >> 4) & 0x0F;
    Y[14] = block[11] & 0x0F;
    Y[15] = (block[11] >> 4) & 0x0F;

    // Read alpha values if present
    int A[16];
    if (has_alpha) {
        A[0] = block[12] & 0x0F;
        A[1] = (block[12] >> 4) & 0x0F;
        A[4] = block[13] & 0x0F;
        A[5] = (block[13] >> 4) & 0x0F;
        A[2] = block[14] & 0x0F;
        A[3] = (block[14] >> 4) & 0x0F;
        A[6] = block[15] & 0x0F;
        A[7] = (block[15] >> 4) & 0x0F;
        A[8] = block[16] & 0x0F;
        A[9] = (block[16] >> 4) & 0x0F;
        A[12] = block[17] & 0x0F;
        A[13] = (block[17] >> 4) & 0x0F;
        A[10] = block[18] & 0x0F;
        A[11] = (block[18] >> 4) & 0x0F;
        A[14] = block[19] & 0x0F;
        A[15] = (block[19] >> 4) & 0x0F;
    } else {
        for (int i = 0; i < 16; i++) A[i] = 15;
    }

    int channels = has_alpha ? 4 : 3;
    uint8_t quad[16];  // 4 pixels max

    // Decode 4 quads (2x2 regions), each sharing one chroma pair
    // Top-left quad (pixels 0,1,4,5) uses co1/cg1
    ycocg_to_rgb_quad(co1, cg1, Y[0], Y[1], Y[4], Y[5], A[0], A[1], A[4], A[5], has_alpha, quad);
    memcpy(pixels + 0 * stride + 0 * channels, quad + 0 * channels, channels);
    memcpy(pixels + 0 * stride + 1 * channels, quad + 1 * channels, channels);
    memcpy(pixels + 1 * stride + 0 * channels, quad + 2 * channels, channels);
    memcpy(pixels + 1 * stride + 1 * channels, quad + 3 * channels, channels);

    // Top-right quad (pixels 2,3,6,7) uses co2/cg2
    ycocg_to_rgb_quad(co2, cg2, Y[2], Y[3], Y[6], Y[7], A[2], A[3], A[6], A[7], has_alpha, quad);
    memcpy(pixels + 0 * stride + 2 * channels, quad + 0 * channels, channels);
    memcpy(pixels + 0 * stride + 3 * channels, quad + 1 * channels, channels);
    memcpy(pixels + 1 * stride + 2 * channels, quad + 2 * channels, channels);
    memcpy(pixels + 1 * stride + 3 * channels, quad + 3 * channels, channels);

    // Bottom-left quad (pixels 8,9,12,13) uses co3/cg3
    ycocg_to_rgb_quad(co3, cg3, Y[8], Y[9], Y[12], Y[13], A[8], A[9], A[12], A[13], has_alpha, quad);
    memcpy(pixels + 2 * stride + 0 * channels, quad + 0 * channels, channels);
    memcpy(pixels + 2 * stride + 1 * channels, quad + 1 * channels, channels);
    memcpy(pixels + 3 * stride + 0 * channels, quad + 2 * channels, channels);
    memcpy(pixels + 3 * stride + 1 * channels, quad + 3 * channels, channels);

    // Bottom-right quad (pixels 10,11,14,15) uses co4/cg4
    ycocg_to_rgb_quad(co4, cg4, Y[10], Y[11], Y[14], Y[15], A[10], A[11], A[14], A[15], has_alpha, quad);
    memcpy(pixels + 2 * stride + 2 * channels, quad + 0 * channels, channels);
    memcpy(pixels + 2 * stride + 3 * channels, quad + 1 * channels, channels);
    memcpy(pixels + 3 * stride + 2 * channels, quad + 2 * channels, channels);
    memcpy(pixels + 3 * stride + 3 * channels, quad + 3 * channels, channels);
}

/**
 * Decode iPF2 block (4:2:2 chroma subsampling).
 * Input: 16 bytes (or 24 with alpha)
 * Output: 16 pixels in RGB24/RGBA format
 */
static void decode_ipf2_block(const uint8_t *block, int has_alpha, uint8_t *pixels, int stride) {
    // Read chroma (8 values for horizontal pairs)
    int co[8], cg[8];
    co[0] = block[0] & 0x0F;
    co[1] = (block[0] >> 4) & 0x0F;
    co[2] = block[1] & 0x0F;
    co[3] = (block[1] >> 4) & 0x0F;
    co[4] = block[2] & 0x0F;
    co[5] = (block[2] >> 4) & 0x0F;
    co[6] = block[3] & 0x0F;
    co[7] = (block[3] >> 4) & 0x0F;

    cg[0] = block[4] & 0x0F;
    cg[1] = (block[4] >> 4) & 0x0F;
    cg[2] = block[5] & 0x0F;
    cg[3] = (block[5] >> 4) & 0x0F;
    cg[4] = block[6] & 0x0F;
    cg[5] = (block[6] >> 4) & 0x0F;
    cg[6] = block[7] & 0x0F;
    cg[7] = (block[7] >> 4) & 0x0F;

    // Read Y values (16 values) - same layout as iPF1
    int Y[16];
    Y[0] = block[8] & 0x0F;
    Y[1] = (block[8] >> 4) & 0x0F;
    Y[4] = block[9] & 0x0F;
    Y[5] = (block[9] >> 4) & 0x0F;
    Y[2] = block[10] & 0x0F;
    Y[3] = (block[10] >> 4) & 0x0F;
    Y[6] = block[11] & 0x0F;
    Y[7] = (block[11] >> 4) & 0x0F;
    Y[8] = block[12] & 0x0F;
    Y[9] = (block[12] >> 4) & 0x0F;
    Y[12] = block[13] & 0x0F;
    Y[13] = (block[13] >> 4) & 0x0F;
    Y[10] = block[14] & 0x0F;
    Y[11] = (block[14] >> 4) & 0x0F;
    Y[14] = block[15] & 0x0F;
    Y[15] = (block[15] >> 4) & 0x0F;

    // Read alpha values if present
    int A[16];
    if (has_alpha) {
        A[0] = block[16] & 0x0F;
        A[1] = (block[16] >> 4) & 0x0F;
        A[4] = block[17] & 0x0F;
        A[5] = (block[17] >> 4) & 0x0F;
        A[2] = block[18] & 0x0F;
        A[3] = (block[18] >> 4) & 0x0F;
        A[6] = block[19] & 0x0F;
        A[7] = (block[19] >> 4) & 0x0F;
        A[8] = block[20] & 0x0F;
        A[9] = (block[20] >> 4) & 0x0F;
        A[12] = block[21] & 0x0F;
        A[13] = (block[21] >> 4) & 0x0F;
        A[10] = block[22] & 0x0F;
        A[11] = (block[22] >> 4) & 0x0F;
        A[14] = block[23] & 0x0F;
        A[15] = (block[23] >> 4) & 0x0F;
    } else {
        for (int i = 0; i < 16; i++) A[i] = 15;
    }

    int channels = has_alpha ? 4 : 3;

    // iPF2: 4:2:2 - each horizontal pair shares chroma
    // Row 0: pixels 0,1 share co[0]/cg[0], pixels 2,3 share co[1]/cg[1]
    // Row 1: pixels 4,5 share co[2]/cg[2], pixels 6,7 share co[3]/cg[3]
    // Row 2: pixels 8,9 share co[4]/cg[4], pixels 10,11 share co[5]/cg[5]
    // Row 3: pixels 12,13 share co[6]/cg[6], pixels 14,15 share co[7]/cg[7]

    int pixel_map[8][4] = {
        {0, 1, 0, 1},    // co/cg index 0: pixels 0,1
        {2, 3, 2, 3},    // co/cg index 1: pixels 2,3
        {4, 5, 4, 5},    // co/cg index 2: pixels 4,5
        {6, 7, 6, 7},    // co/cg index 3: pixels 6,7
        {8, 9, 8, 9},    // co/cg index 4: pixels 8,9
        {10, 11, 10, 11}, // co/cg index 5: pixels 10,11
        {12, 13, 12, 13}, // co/cg index 6: pixels 12,13
        {14, 15, 14, 15}  // co/cg index 7: pixels 14,15
    };

    for (int ci = 0; ci < 8; ci++) {
        int p0 = pixel_map[ci][0];
        int p1 = pixel_map[ci][1];

        uint8_t quad[16];  // 4 pixels max (ycocg_to_rgb_quad writes 4 pixels)
        ycocg_to_rgb_quad(co[ci], cg[ci], Y[p0], Y[p1], Y[p0], Y[p1],
                          A[p0], A[p1], A[p0], A[p1], has_alpha, quad);

        int row = p0 / 4;
        int col0 = p0 % 4;
        int col1 = p1 % 4;

        memcpy(pixels + row * stride + col0 * channels, quad + 0 * channels, channels);
        memcpy(pixels + row * stride + col1 * channels, quad + 1 * channels, channels);
    }
}

// =============================================================================
// Main Decoding
// =============================================================================

static int decode_ipf(const decoder_config_t *cfg) {
    FILE *fp = fopen(cfg->input_file, "rb");
    if (!fp) {
        fprintf(stderr, "Error: Failed to open input file: %s\n", cfg->input_file);
        return -1;
    }

    // Read header
    ipf_header_t header;
    if (read_ipf_header(fp, &header) < 0) {
        fclose(fp);
        return -1;
    }

    int has_alpha = (header.flags & IPF_FLAG_ALPHA) != 0;
    int use_zstd = (header.flags & IPF_FLAG_ZSTD) != 0;
    int progressive = (header.flags & IPF_FLAG_PROGRESSIVE) != 0;

    if (cfg->verbose) {
        printf("iPF Header:\n");
        printf("  Size: %dx%d\n", header.width, header.height);
        printf("  Type: iPF%d (%s)\n", header.type + 1,
               header.type == 0 ? "4:2:0" : "4:2:2");
        printf("  Flags: %s%s%s\n",
               has_alpha ? "alpha " : "",
               use_zstd ? "zstd " : "",
               progressive ? "progressive " : "");
        printf("  Uncompressed size: %u bytes\n", header.uncompressed_size);
    }

    if (progressive) {
        fprintf(stderr, "Warning: Progressive mode not implemented, decoding as sequential\n");
    }

    // Read compressed/raw block data
    fseek(fp, 0, SEEK_END);
    long file_size = ftell(fp);
    fseek(fp, IPF_HEADER_SIZE, SEEK_SET);

    size_t compressed_size = file_size - IPF_HEADER_SIZE;
    uint8_t *compressed_data = malloc(compressed_size);
    if (!compressed_data) {
        fclose(fp);
        fprintf(stderr, "Error: Failed to allocate memory\n");
        return -1;
    }

    if (fread(compressed_data, 1, compressed_size, fp) != compressed_size) {
        free(compressed_data);
        fclose(fp);
        fprintf(stderr, "Error: Failed to read block data\n");
        return -1;
    }
    fclose(fp);

    // Decompress if needed
    uint8_t *block_data;
    size_t block_data_size;

    if (use_zstd) {
        block_data_size = header.uncompressed_size;
        block_data = malloc(block_data_size);
        if (!block_data) {
            free(compressed_data);
            fprintf(stderr, "Error: Failed to allocate decompression buffer\n");
            return -1;
        }

        size_t result = ZSTD_decompress(block_data, block_data_size,
                                        compressed_data, compressed_size);
        if (ZSTD_isError(result)) {
            fprintf(stderr, "Error: Zstd decompression failed: %s\n",
                    ZSTD_getErrorName(result));
            free(block_data);
            free(compressed_data);
            return -1;
        }

        if (cfg->verbose) {
            printf("Decompressed: %zu -> %zu bytes\n", compressed_size, block_data_size);
        }

        free(compressed_data);
    } else {
        block_data = compressed_data;
        block_data_size = compressed_size;
    }

    // Allocate output image
    int channels = has_alpha ? 4 : 3;
    size_t image_size = (size_t)header.width * header.height * channels;
    uint8_t *image = malloc(image_size);
    if (!image) {
        free(block_data);
        fprintf(stderr, "Error: Failed to allocate image buffer\n");
        return -1;
    }

    // Decode blocks
    int blocks_x = (header.width + 3) / 4;
    int blocks_y = (header.height + 3) / 4;
    int block_size = (header.type == IPF_TYPE_1) ? (has_alpha ? 20 : 12) : (has_alpha ? 24 : 16);
    int row_stride = header.width * channels;
    int block_stride = 4 * channels;  // 4 pixels per block row

    size_t block_offset = 0;
    for (int by = 0; by < blocks_y; by++) {
        for (int bx = 0; bx < blocks_x; bx++) {
            // Calculate output position
            uint8_t *block_pixels = image + by * 4 * row_stride + bx * block_stride;

            if (header.type == IPF_TYPE_1) {
                decode_ipf1_block(block_data + block_offset, has_alpha, block_pixels, row_stride);
            } else {
                decode_ipf2_block(block_data + block_offset, has_alpha, block_pixels, row_stride);
            }

            block_offset += block_size;
        }
    }

    free(block_data);

    if (cfg->verbose) {
        printf("Decoded %d blocks (%dx%d)\n", blocks_x * blocks_y, blocks_x, blocks_y);
    }

    // Output image
    int result = 0;

    if (cfg->raw_output) {
        // Write raw RGB/RGBA data
        FILE *out = fopen(cfg->output_file, "wb");
        if (!out) {
            fprintf(stderr, "Error: Failed to open output file: %s\n", cfg->output_file);
            result = -1;
        } else {
            fwrite(image, 1, image_size, out);
            fclose(out);
            if (cfg->verbose) {
                printf("Wrote %zu bytes raw %s data\n", image_size, has_alpha ? "RGBA" : "RGB24");
            }
        }
    } else {
        // Use FFmpeg to write output image
        char cmd[MAX_PATH * 2];
        const char *pix_fmt = has_alpha ? "rgba" : "rgb24";

        snprintf(cmd, sizeof(cmd),
                 "ffmpeg -hide_banner -v quiet -y -f rawvideo -pix_fmt %s -s %dx%d "
                 "-i - \"%s\"",
                 pix_fmt, header.width, header.height, cfg->output_file);

        if (cfg->verbose) {
            printf("FFmpeg command: %s\n", cmd);
        }

        FILE *pipe = popen(cmd, "w");
        if (!pipe) {
            fprintf(stderr, "Error: Failed to start FFmpeg\n");
            result = -1;
        } else {
            fwrite(image, 1, image_size, pipe);
            int status = pclose(pipe);
            if (status != 0) {
                fprintf(stderr, "Error: FFmpeg failed with status %d\n", status);
                result = -1;
            }
        }
    }

    free(image);

    return result;
}

// =============================================================================
// Main Entry Point
// =============================================================================

int main(int argc, char *argv[]) {
    decoder_config_t cfg = {
        .input_file = NULL,
        .output_file = NULL,
        .verbose = 0,
        .raw_output = 0
    };

    static struct option long_options[] = {
        {"input",   required_argument, 0, 'i'},
        {"output",  required_argument, 0, 'o'},
        {"raw",     no_argument,       0, 'R'},
        {"verbose", no_argument,       0, 'v'},
        {"help",    no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "i:o:vh", long_options, NULL)) != -1) {
        switch (opt) {
            case 'i':
                cfg.input_file = optarg;
                break;
            case 'o':
                cfg.output_file = optarg;
                break;
            case 'R':
                cfg.raw_output = 1;
                break;
            case 'v':
                cfg.verbose = 1;
                break;
            case 'h':
                print_usage(argv[0]);
                return 0;
            default:
                print_usage(argv[0]);
                return 1;
        }
    }

    // Validate required arguments
    if (!cfg.input_file || !cfg.output_file) {
        fprintf(stderr, "Error: Input and output files are required\n\n");
        print_usage(argv[0]);
        return 1;
    }

    int result = decode_ipf(&cfg);

    if (result == 0) {
        printf("Successfully decoded: %s\n", cfg.output_file);
    }

    return result == 0 ? 0 : 1;
}
