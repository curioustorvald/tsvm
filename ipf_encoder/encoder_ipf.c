/**
 * iPF Encoder - TSVM Interchangeable Picture Format Encoder
 *
 * Encodes images to iPF format (Type 1 or Type 2) with:
 * - YCoCg colour space with chroma subsampling
 * - 4x4 block encoding
 * - Optional Zstd compression
 * - Optional alpha channel
 * - Optional Adam7 progressive ordering
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
#define IPF_HEADER_SIZE 28  // 8 magic + 2 width + 2 height + 1 flags + 1 type + 10 reserved + 4 uncompressed size

#define DEFAULT_WIDTH 560
#define DEFAULT_HEIGHT 448

#define IPF_TYPE_1 0  // 4:2:0 chroma subsampling (12 bytes per block, +8 with alpha)
#define IPF_TYPE_2 1  // 4:2:2 chroma subsampling (16 bytes per block, +8 with alpha)

#define IPF_FLAG_ALPHA       0x01  // Has alpha channel
#define IPF_FLAG_ZSTD        0x10  // Zstd compressed
#define IPF_FLAG_PROGRESSIVE 0x80  // Adam7 progressive ordering

#define MAX_PATH 4096

// Bayer dithering kernel (4x4)
static const float BAYER_4X4[16] = {
     0.0f/16.0f,  8.0f/16.0f,  2.0f/16.0f, 10.0f/16.0f,
    12.0f/16.0f,  4.0f/16.0f, 14.0f/16.0f,  6.0f/16.0f,
     3.0f/16.0f, 11.0f/16.0f,  1.0f/16.0f,  9.0f/16.0f,
    15.0f/16.0f,  7.0f/16.0f, 13.0f/16.0f,  5.0f/16.0f
};

// Adam7 interlace pattern - pass number (1-7) for each pixel in 8x8 block
// 0 = not in this standard pattern, we'll adapt for 4x4 blocks
static const int ADAM7_PASS[8][8] = {
    {1, 6, 4, 6, 2, 6, 4, 6},
    {7, 7, 7, 7, 7, 7, 7, 7},
    {5, 6, 5, 6, 5, 6, 5, 6},
    {7, 7, 7, 7, 7, 7, 7, 7},
    {3, 6, 4, 6, 3, 6, 4, 6},
    {7, 7, 7, 7, 7, 7, 7, 7},
    {5, 6, 5, 6, 5, 6, 5, 6},
    {7, 7, 7, 7, 7, 7, 7, 7}
};

// =============================================================================
// Structures
// =============================================================================

typedef struct {
    char *input_file;
    char *output_file;
    int width;
    int height;
    int ipf_type;        // 0 = iPF1, 1 = iPF2
    int use_zstd;        // 1 = compress with Zstd
    int force_alpha;     // 1 = force alpha channel in output
    int no_alpha;        // 1 = strip alpha even if present in input
    int progressive;     // 1 = Adam7 progressive ordering
    int dither;          // Bayer dither pattern index (-1 = no dithering)
    int verbose;
} encoder_config_t;

typedef struct {
    uint8_t *data;       // RGB or RGBA data
    int width;
    int height;
    int channels;        // 3 = RGB, 4 = RGBA
    int has_alpha;       // 1 if input image has meaningful alpha
} image_t;

// =============================================================================
// Utility Functions
// =============================================================================

static void print_usage(const char *program) {
    printf("iPF Encoder - TSVM Interchangeable Picture Format\n");
    printf("\nUsage: %s -i input.png -o output.ipf [options]\n\n", program);
    printf("Required:\n");
    printf("  -i, --input FILE         Input image file (any format FFmpeg supports)\n");
    printf("  -o, --output FILE        Output iPF file\n");
    printf("\nOptions:\n");
    printf("  -s, --size WxH           Output size (default: %dx%d)\n", DEFAULT_WIDTH, DEFAULT_HEIGHT);
    printf("  -t, --type N             iPF type: 1 (4:2:0, default) or 2 (4:2:2)\n");
    printf("  --no-zstd                Disable Zstd compression (default: enabled)\n");
    printf("  --alpha                  Force alpha channel in output\n");
    printf("  --no-alpha               Strip alpha channel from input\n");
    printf("  -p, --progressive        Use Adam7 progressive ordering\n");
    printf("  -d, --dither N           Bayer dither pattern (0=4x4, -1=none, default: 0)\n");
    printf("  -v, --verbose            Verbose output\n");
    printf("  -h, --help               Show this help\n");
    printf("\nExamples:\n");
    printf("  %s -i photo.jpg -o photo.ipf\n", program);
    printf("  %s -i logo.png -o logo.ipf --alpha\n", program);
    printf("  %s -i image.png -o image.ipf -s 280x224 -t 2\n", program);
}

static int clampi(int v, int lo, int hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// Convert chroma value [-1..1] to 4-bit [0..15]
static int chroma_to_four_bits(float f) {
    return clampi((int)roundf(f * 8.0f) + 7, 0, 15);
}

// =============================================================================
// Image Loading via FFmpeg
// =============================================================================

/**
 * Probe input image dimensions using FFmpeg.
 * Returns 0 on success, -1 on error.
 */
static int probe_image_dimensions(const char *input_file, int *width, int *height, int *has_alpha) {
    char cmd[MAX_PATH * 2];

    // Use ffprobe to get dimensions and pixel format
    snprintf(cmd, sizeof(cmd),
             "ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height,pix_fmt "
             "-of csv=p=0:s=x \"%s\" 2>/dev/null",
             input_file);

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        fprintf(stderr, "Error: Failed to run ffprobe\n");
        return -1;
    }

    char buffer[256];
    if (fgets(buffer, sizeof(buffer), fp) == NULL) {
        pclose(fp);
        fprintf(stderr, "Error: Failed to read image info\n");
        return -1;
    }
    pclose(fp);

    // Parse "width x height x pix_fmt"
    char pix_fmt[64] = "";
    if (sscanf(buffer, "%dx%dx%63s", width, height, pix_fmt) < 2) {
        // Try alternate format without pix_fmt
        if (sscanf(buffer, "%dx%d", width, height) != 2) {
            fprintf(stderr, "Error: Failed to parse image dimensions\n");
            return -1;
        }
    }

    // Check if pixel format indicates alpha
    *has_alpha = (strstr(pix_fmt, "rgba") != NULL ||
                  strstr(pix_fmt, "argb") != NULL ||
                  strstr(pix_fmt, "bgra") != NULL ||
                  strstr(pix_fmt, "abgr") != NULL ||
                  strstr(pix_fmt, "ya") != NULL ||
                  strstr(pix_fmt, "pal8") != NULL ||  // palette may have alpha
                  strstr(pix_fmt, "yuva") != NULL);

    return 0;
}

/**
 * Load and resize image using FFmpeg.
 * Maintains aspect ratio and crops to target size.
 * Returns image data or NULL on error.
 */
static image_t* load_image(const char *input_file, int target_width, int target_height,
                           int want_alpha, int verbose) {
    int src_width, src_height, src_has_alpha;

    // Probe source dimensions
    if (probe_image_dimensions(input_file, &src_width, &src_height, &src_has_alpha) < 0) {
        return NULL;
    }

    if (verbose) {
        printf("Source image: %dx%d, alpha: %s\n",
               src_width, src_height, src_has_alpha ? "yes" : "no");
    }

    // Determine if we need alpha channel
    int use_alpha = want_alpha || src_has_alpha;
    int channels = use_alpha ? 4 : 3;
    const char *pix_fmt = use_alpha ? "rgba" : "rgb24";

    // Build FFmpeg command with scale and crop filter
    char cmd[MAX_PATH * 2];
    snprintf(cmd, sizeof(cmd),
             "ffmpeg -hide_banner -v quiet -i \"%s\" -f rawvideo -pix_fmt %s -vf "
             "\"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d\" -frames:v 1 -",
             input_file, pix_fmt, target_width, target_height, target_width, target_height);

    if (verbose) {
        printf("FFmpeg command: %s\n", cmd);
    }

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        fprintf(stderr, "Error: Failed to start FFmpeg\n");
        return NULL;
    }

    // Allocate image
    image_t *img = malloc(sizeof(image_t));
    if (!img) {
        pclose(fp);
        return NULL;
    }

    size_t data_size = (size_t)target_width * target_height * channels;
    img->data = malloc(data_size);
    if (!img->data) {
        free(img);
        pclose(fp);
        return NULL;
    }

    img->width = target_width;
    img->height = target_height;
    img->channels = channels;
    img->has_alpha = use_alpha;

    // Read image data
    size_t bytes_read = fread(img->data, 1, data_size, fp);
    pclose(fp);

    if (bytes_read != data_size) {
        fprintf(stderr, "Error: Expected %zu bytes, got %zu\n", data_size, bytes_read);
        free(img->data);
        free(img);
        return NULL;
    }

    if (verbose) {
        printf("Loaded %dx%d image, %d channels, %zu bytes\n",
               img->width, img->height, img->channels, data_size);
    }

    return img;
}

static void free_image(image_t *img) {
    if (img) {
        free(img->data);
        free(img);
    }
}

// =============================================================================
// iPF Block Encoding
// =============================================================================

/**
 * Encode a 4x4 block to YCoCg with dithering.
 * Returns arrays of Y (16 values), A (16 values), Co (16 values), Cg (16 values).
 */
static void encode_block_to_ycocg(const image_t *img, int block_x, int block_y,
                                  int dither_pattern,
                                  int *Y_out, int *A_out, float *Co_out, float *Cg_out) {
    for (int py = 0; py < 4; py++) {
        for (int px = 0; px < 4; px++) {
            int ox = block_x * 4 + px;
            int oy = block_y * 4 + py;

            // Handle out-of-bounds (extend edge pixels)
            ox = clampi(ox, 0, img->width - 1);
            oy = clampi(oy, 0, img->height - 1);

            // Get dither threshold
            float t = 0.0f;
            if (dither_pattern >= 0) {
                t = BAYER_4X4[(py % 4) * 4 + (px % 4)];
            }

            // Read pixel
            int offset = (oy * img->width + ox) * img->channels;
            float r0 = img->data[offset + 0] / 255.0f;
            float g0 = (img->channels >= 3) ? img->data[offset + 1] / 255.0f : r0;
            float b0 = (img->channels >= 3) ? img->data[offset + 2] / 255.0f : r0;
            float a0 = (img->channels == 4) ? img->data[offset + 3] / 255.0f : 1.0f;

            // Apply dithering
            float r = floorf((t / 15.0f + r0) * 15.0f) / 15.0f;
            float g = floorf((t / 15.0f + g0) * 15.0f) / 15.0f;
            float b = floorf((t / 15.0f + b0) * 15.0f) / 15.0f;
            float a = floorf((t / 15.0f + a0) * 15.0f) / 15.0f;

            // Convert to YCoCg
            float co = r - b;           // [-1..1]
            float tmp = b + co / 2.0f;
            float cg = g - tmp;         // [-1..1]
            float y = tmp + cg / 2.0f;  // [0..1]

            int index = py * 4 + px;
            Y_out[index] = (int)roundf(y * 15.0f);
            A_out[index] = (int)roundf(a * 15.0f);
            Co_out[index] = co;
            Cg_out[index] = cg;
        }
    }
}

/**
 * Encode iPF1 block (4:2:0 chroma subsampling).
 * Returns 12 bytes (or 20 with alpha).
 */
static int encode_ipf1_block(const int *Ys, const int *As, const float *COs, const float *CGs,
                             int has_alpha, uint8_t *out) {
    // Subsample Co/Cg by averaging 2x2 regions (4:2:0)
    int cos1 = chroma_to_four_bits((COs[0] + COs[1] + COs[4] + COs[5]) / 4.0f);
    int cos2 = chroma_to_four_bits((COs[2] + COs[3] + COs[6] + COs[7]) / 4.0f);
    int cos3 = chroma_to_four_bits((COs[8] + COs[9] + COs[12] + COs[13]) / 4.0f);
    int cos4 = chroma_to_four_bits((COs[10] + COs[11] + COs[14] + COs[15]) / 4.0f);

    int cgs1 = chroma_to_four_bits((CGs[0] + CGs[1] + CGs[4] + CGs[5]) / 4.0f);
    int cgs2 = chroma_to_four_bits((CGs[2] + CGs[3] + CGs[6] + CGs[7]) / 4.0f);
    int cgs3 = chroma_to_four_bits((CGs[8] + CGs[9] + CGs[12] + CGs[13]) / 4.0f);
    int cgs4 = chroma_to_four_bits((CGs[10] + CGs[11] + CGs[14] + CGs[15]) / 4.0f);

    // Pack according to iPF1 format
    // uint16 [Co4 | Co3 | Co2 | Co1]
    out[0] = (cos2 << 4) | cos1;
    out[1] = (cos4 << 4) | cos3;
    // uint16 [Cg4 | Cg3 | Cg2 | Cg1]
    out[2] = (cgs2 << 4) | cgs1;
    out[3] = (cgs4 << 4) | cgs3;
    // Y values: [Y1|Y0|Y5|Y4], [Y3|Y2|Y7|Y6], [Y9|Y8|YD|YC], [YB|YA|YF|YE]
    out[4] = (Ys[1] << 4) | Ys[0];
    out[5] = (Ys[5] << 4) | Ys[4];
    out[6] = (Ys[3] << 4) | Ys[2];
    out[7] = (Ys[7] << 4) | Ys[6];
    out[8] = (Ys[9] << 4) | Ys[8];
    out[9] = (Ys[13] << 4) | Ys[12];
    out[10] = (Ys[11] << 4) | Ys[10];
    out[11] = (Ys[15] << 4) | Ys[14];

    int block_size = 12;

    if (has_alpha) {
        // Alpha values: same layout as Y
        out[12] = (As[1] << 4) | As[0];
        out[13] = (As[5] << 4) | As[4];
        out[14] = (As[3] << 4) | As[2];
        out[15] = (As[7] << 4) | As[6];
        out[16] = (As[9] << 4) | As[8];
        out[17] = (As[13] << 4) | As[12];
        out[18] = (As[11] << 4) | As[10];
        out[19] = (As[15] << 4) | As[14];
        block_size = 20;
    }

    return block_size;
}

/**
 * Encode iPF2 block (4:2:2 chroma subsampling).
 * Returns 16 bytes (or 24 with alpha).
 */
static int encode_ipf2_block(const int *Ys, const int *As, const float *COs, const float *CGs,
                             int has_alpha, uint8_t *out) {
    // Subsample Co/Cg horizontally only (4:2:2) - 8 values each
    int cos1 = chroma_to_four_bits((COs[0] + COs[1]) / 2.0f);
    int cos2 = chroma_to_four_bits((COs[2] + COs[3]) / 2.0f);
    int cos3 = chroma_to_four_bits((COs[4] + COs[5]) / 2.0f);
    int cos4 = chroma_to_four_bits((COs[6] + COs[7]) / 2.0f);
    int cos5 = chroma_to_four_bits((COs[8] + COs[9]) / 2.0f);
    int cos6 = chroma_to_four_bits((COs[10] + COs[11]) / 2.0f);
    int cos7 = chroma_to_four_bits((COs[12] + COs[13]) / 2.0f);
    int cos8 = chroma_to_four_bits((COs[14] + COs[15]) / 2.0f);

    int cgs1 = chroma_to_four_bits((CGs[0] + CGs[1]) / 2.0f);
    int cgs2 = chroma_to_four_bits((CGs[2] + CGs[3]) / 2.0f);
    int cgs3 = chroma_to_four_bits((CGs[4] + CGs[5]) / 2.0f);
    int cgs4 = chroma_to_four_bits((CGs[6] + CGs[7]) / 2.0f);
    int cgs5 = chroma_to_four_bits((CGs[8] + CGs[9]) / 2.0f);
    int cgs6 = chroma_to_four_bits((CGs[10] + CGs[11]) / 2.0f);
    int cgs7 = chroma_to_four_bits((CGs[12] + CGs[13]) / 2.0f);
    int cgs8 = chroma_to_four_bits((CGs[14] + CGs[15]) / 2.0f);

    // Pack according to iPF2 format
    // uint32 [Co8 | Co7 | Co6 | Co5 | Co4 | Co3 | Co2 | Co1]
    out[0] = (cos2 << 4) | cos1;
    out[1] = (cos4 << 4) | cos3;
    out[2] = (cos6 << 4) | cos5;
    out[3] = (cos8 << 4) | cos7;
    // uint32 [Cg8 | Cg7 | Cg6 | Cg5 | Cg4 | Cg3 | Cg2 | Cg1]
    out[4] = (cgs2 << 4) | cgs1;
    out[5] = (cgs4 << 4) | cgs3;
    out[6] = (cgs6 << 4) | cgs5;
    out[7] = (cgs8 << 4) | cgs7;
    // Y values: same as iPF1
    out[8] = (Ys[1] << 4) | Ys[0];
    out[9] = (Ys[5] << 4) | Ys[4];
    out[10] = (Ys[3] << 4) | Ys[2];
    out[11] = (Ys[7] << 4) | Ys[6];
    out[12] = (Ys[9] << 4) | Ys[8];
    out[13] = (Ys[13] << 4) | Ys[12];
    out[14] = (Ys[11] << 4) | Ys[10];
    out[15] = (Ys[15] << 4) | Ys[14];

    int block_size = 16;

    if (has_alpha) {
        // Alpha values: same layout as Y
        out[16] = (As[1] << 4) | As[0];
        out[17] = (As[5] << 4) | As[4];
        out[18] = (As[3] << 4) | As[2];
        out[19] = (As[7] << 4) | As[6];
        out[20] = (As[9] << 4) | As[8];
        out[21] = (As[13] << 4) | As[12];
        out[22] = (As[11] << 4) | As[10];
        out[23] = (As[15] << 4) | As[14];
        block_size = 24;
    }

    return block_size;
}

// =============================================================================
// Adam7 Progressive Ordering
// =============================================================================

/**
 * Get Adam7 pass number for a block at (block_x, block_y).
 * For blocks, we use a simplified version based on block position.
 */
static int get_adam7_pass(int block_x, int block_y) {
    // Use Adam7 pattern for 8x8 blocks, but adapt for 4x4 block indices
    int px = (block_x * 4) % 8;
    int py = (block_y * 4) % 8;
    return ADAM7_PASS[py][px];
}

/**
 * Encode blocks in Adam7 progressive order.
 * Returns the encoded block data in progressive order.
 */
static uint8_t* encode_progressive(const image_t *img, const encoder_config_t *cfg,
                                   int has_alpha, size_t *out_size) {
    int blocks_x = (img->width + 3) / 4;
    int blocks_y = (img->height + 3) / 4;
    int total_blocks = blocks_x * blocks_y;

    int block_size = (cfg->ipf_type == IPF_TYPE_1) ? (has_alpha ? 20 : 12) : (has_alpha ? 24 : 16);
    size_t max_size = (size_t)total_blocks * block_size;

    uint8_t *output = malloc(max_size);
    if (!output) return NULL;

    // Temporary storage for all encoded blocks
    uint8_t *all_blocks = malloc(max_size);
    if (!all_blocks) {
        free(output);
        return NULL;
    }

    // Encode all blocks first
    size_t offset = 0;
    for (int by = 0; by < blocks_y; by++) {
        for (int bx = 0; bx < blocks_x; bx++) {
            int Ys[16], As[16];
            float COs[16], CGs[16];

            encode_block_to_ycocg(img, bx, by, cfg->dither, Ys, As, COs, CGs);

            if (cfg->ipf_type == IPF_TYPE_1) {
                encode_ipf1_block(Ys, As, COs, CGs, has_alpha, all_blocks + offset);
            } else {
                encode_ipf2_block(Ys, As, COs, CGs, has_alpha, all_blocks + offset);
            }
            offset += block_size;
        }
    }

    // Reorder blocks according to Adam7 progressive order (7 passes)
    size_t out_offset = 0;
    for (int pass = 1; pass <= 7; pass++) {
        for (int by = 0; by < blocks_y; by++) {
            for (int bx = 0; bx < blocks_x; bx++) {
                if (get_adam7_pass(bx, by) == pass) {
                    int block_idx = by * blocks_x + bx;
                    memcpy(output + out_offset, all_blocks + block_idx * block_size, block_size);
                    out_offset += block_size;
                }
            }
        }
    }

    free(all_blocks);
    *out_size = out_offset;
    return output;
}

/**
 * Encode blocks in sequential (raster) order.
 */
static uint8_t* encode_sequential(const image_t *img, const encoder_config_t *cfg,
                                  int has_alpha, size_t *out_size) {
    int blocks_x = (img->width + 3) / 4;
    int blocks_y = (img->height + 3) / 4;
    int total_blocks = blocks_x * blocks_y;

    int block_size = (cfg->ipf_type == IPF_TYPE_1) ? (has_alpha ? 20 : 12) : (has_alpha ? 24 : 16);
    size_t max_size = (size_t)total_blocks * block_size;

    uint8_t *output = malloc(max_size);
    if (!output) return NULL;

    size_t offset = 0;
    for (int by = 0; by < blocks_y; by++) {
        for (int bx = 0; bx < blocks_x; bx++) {
            int Ys[16], As[16];
            float COs[16], CGs[16];

            encode_block_to_ycocg(img, bx, by, cfg->dither, Ys, As, COs, CGs);

            if (cfg->ipf_type == IPF_TYPE_1) {
                offset += encode_ipf1_block(Ys, As, COs, CGs, has_alpha, output + offset);
            } else {
                offset += encode_ipf2_block(Ys, As, COs, CGs, has_alpha, output + offset);
            }
        }
    }

    *out_size = offset;
    return output;
}

// =============================================================================
// iPF File Writing
// =============================================================================

static int write_ipf_file(const char *output_file, const encoder_config_t *cfg,
                          const image_t *img, int verbose) {
    // Determine if we use alpha
    int has_alpha = 0;
    if (cfg->force_alpha) {
        has_alpha = 1;
    } else if (!cfg->no_alpha && img->has_alpha) {
        has_alpha = 1;
    }

    // Encode blocks
    size_t block_data_size;
    uint8_t *block_data;

    if (cfg->progressive) {
        block_data = encode_progressive(img, cfg, has_alpha, &block_data_size);
    } else {
        block_data = encode_sequential(img, cfg, has_alpha, &block_data_size);
    }

    if (!block_data) {
        fprintf(stderr, "Error: Failed to encode image blocks\n");
        return -1;
    }

    if (verbose) {
        printf("Encoded %zu bytes of block data\n", block_data_size);
    }

    // Prepare output data (may be compressed)
    uint8_t *output_data = block_data;
    size_t output_size = block_data_size;
    uint8_t *compressed_data = NULL;

    if (cfg->use_zstd) {
        size_t max_compressed = ZSTD_compressBound(block_data_size);
        compressed_data = malloc(max_compressed);
        if (!compressed_data) {
            free(block_data);
            fprintf(stderr, "Error: Failed to allocate compression buffer\n");
            return -1;
        }

        output_size = ZSTD_compress(compressed_data, max_compressed,
                                    block_data, block_data_size, 7);
        if (ZSTD_isError(output_size)) {
            fprintf(stderr, "Error: Zstd compression failed: %s\n",
                    ZSTD_getErrorName(output_size));
            free(block_data);
            free(compressed_data);
            return -1;
        }

        output_data = compressed_data;

        if (verbose) {
            printf("Compressed: %zu -> %zu bytes (%.1f%%)\n",
                   block_data_size, output_size,
                   100.0 * output_size / block_data_size);
        }
    }

    // Open output file
    FILE *fp = fopen(output_file, "wb");
    if (!fp) {
        fprintf(stderr, "Error: Failed to open output file: %s\n", output_file);
        free(block_data);
        if (compressed_data) free(compressed_data);
        return -1;
    }

    // Build flags byte
    uint8_t flags = 0;
    if (has_alpha) flags |= IPF_FLAG_ALPHA;
    if (cfg->use_zstd) flags |= IPF_FLAG_ZSTD;
    if (cfg->progressive) flags |= IPF_FLAG_PROGRESSIVE | IPF_FLAG_ZSTD;  // Progressive always sets zstd flag

    // Write header
    // Magic: "\x1FTSVMiPF" (8 bytes)
    fwrite(IPF_MAGIC, 1, 8, fp);

    // Width (uint16 LE)
    uint16_t width_le = (uint16_t)cfg->width;
    fwrite(&width_le, 2, 1, fp);

    // Height (uint16 LE)
    uint16_t height_le = (uint16_t)cfg->height;
    fwrite(&height_le, 2, 1, fp);

    // Flags (uint8)
    fwrite(&flags, 1, 1, fp);

    // Type (uint8)
    uint8_t type_byte = (uint8_t)cfg->ipf_type;
    fwrite(&type_byte, 1, 1, fp);

    // Reserved (10 bytes)
    uint8_t reserved[10] = {0};
    fwrite(reserved, 1, 10, fp);

    // Uncompressed size (uint32 LE)
    uint32_t uncompressed_size_le = (uint32_t)block_data_size;
    fwrite(&uncompressed_size_le, 4, 1, fp);

    // Write block data
    fwrite(output_data, 1, output_size, fp);

    fclose(fp);

    if (verbose) {
        printf("Wrote %zu bytes to %s\n", IPF_HEADER_SIZE + output_size, output_file);
        printf("  Format: iPF%d, %dx%d\n", cfg->ipf_type + 1, cfg->width, cfg->height);
        printf("  Flags: %s%s%s\n",
               has_alpha ? "alpha " : "",
               cfg->use_zstd ? "zstd " : "",
               cfg->progressive ? "progressive " : "");
    }

    free(block_data);
    if (compressed_data) free(compressed_data);

    return 0;
}

// =============================================================================
// Main Entry Point
// =============================================================================

static int parse_size(const char *arg, int *width, int *height) {
    return sscanf(arg, "%dx%d", width, height) == 2 ? 0 : -1;
}

int main(int argc, char *argv[]) {
    encoder_config_t cfg = {
        .input_file = NULL,
        .output_file = NULL,
        .width = DEFAULT_WIDTH,
        .height = DEFAULT_HEIGHT,
        .ipf_type = IPF_TYPE_1,
        .use_zstd = 1,
        .force_alpha = 0,
        .no_alpha = 0,
        .progressive = 0,
        .dither = 0,
        .verbose = 0
    };

    static struct option long_options[] = {
        {"input",       required_argument, 0, 'i'},
        {"output",      required_argument, 0, 'o'},
        {"size",        required_argument, 0, 's'},
        {"type",        required_argument, 0, 't'},
        {"no-zstd",     no_argument,       0, 'Z'},
        {"alpha",       no_argument,       0, 'A'},
        {"no-alpha",    no_argument,       0, 'N'},
        {"progressive", no_argument,       0, 'p'},
        {"dither",      required_argument, 0, 'd'},
        {"verbose",     no_argument,       0, 'v'},
        {"help",        no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "i:o:s:t:pd:vh", long_options, NULL)) != -1) {
        switch (opt) {
            case 'i':
                cfg.input_file = optarg;
                break;
            case 'o':
                cfg.output_file = optarg;
                break;
            case 's':
                if (parse_size(optarg, &cfg.width, &cfg.height) != 0) {
                    fprintf(stderr, "Error: Invalid size format (use WxH)\n");
                    return 1;
                }
                break;
            case 't':
                cfg.ipf_type = atoi(optarg) - 1;  // User specifies 1 or 2
                if (cfg.ipf_type < 0 || cfg.ipf_type > 1) {
                    fprintf(stderr, "Error: Invalid iPF type (use 1 or 2)\n");
                    return 1;
                }
                break;
            case 'Z':
                cfg.use_zstd = 0;
                break;
            case 'A':
                cfg.force_alpha = 1;
                break;
            case 'N':
                cfg.no_alpha = 1;
                break;
            case 'p':
                cfg.progressive = 1;
                break;
            case 'd':
                cfg.dither = atoi(optarg);
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

    // Load image
    if (cfg.verbose) {
        printf("Loading image: %s\n", cfg.input_file);
    }

    image_t *img = load_image(cfg.input_file, cfg.width, cfg.height,
                              cfg.force_alpha, cfg.verbose);
    if (!img) {
        fprintf(stderr, "Error: Failed to load image\n");
        return 1;
    }

    // Encode and write iPF file
    int result = write_ipf_file(cfg.output_file, &cfg, img, cfg.verbose);

    free_image(img);

    if (result == 0) {
        printf("Successfully encoded: %s\n", cfg.output_file);
    }

    return result == 0 ? 0 : 1;
}
