// Created by Claude on 2025-09-13.
// TAV (TSVM Advanced Video) Encoder - DWT-based compression with full resolution YCoCg-R
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include <unistd.h>
#include <sys/wait.h>
#include <getopt.h>
#include <ctype.h>
#include <sys/time.h>
#include <time.h>

// Float16 conversion functions (same as TEV)
static inline uint16_t float_to_float16(float fval) {
    uint32_t fbits = *(uint32_t*)&fval;
    uint16_t sign = (fbits >> 16) & 0x8000;
    uint32_t val = (fbits & 0x7fffffff) + 0x1000;

    if (val >= 0x47800000) {
        if ((fbits & 0x7fffffff) >= 0x47800000) {
            if (val < 0x7f800000)
                return sign | 0x7c00;
            return sign | 0x7c00 | ((fbits & 0x007fffff) >> 13);
        }
        return sign | 0x7bff;
    }
    if (val >= 0x38800000)
        return sign | ((val - 0x38000000) >> 13);
    if (val < 0x33000000)
        return sign;
    val = (fbits & 0x7fffffff) >> 23;

    return sign | (((fbits & 0x7fffff) | 0x800000) +
                   (0x800000 >> (val - 102))
                  ) >> (126 - val);
}

static inline float float16_to_float(uint16_t hbits) {
    uint32_t mant = hbits & 0x03ff;
    uint32_t exp = hbits & 0x7c00;
    
    if (exp == 0x7c00)
        exp = 0x3fc00;
    else if (exp != 0) {
        exp += 0x1c000;
        if (mant == 0 && exp > 0x1c400) {
            uint32_t fbits = ((hbits & 0x8000) << 16) | (exp << 13) | 0x3ff;
            return *(float*)&fbits;
        }
    }
    else if (mant != 0) {
        exp = 0x1c400;
        do {
            mant <<= 1;
            exp -= 0x400;
        } while ((mant & 0x400) == 0);
        mant &= 0x3ff;
    }
    
    uint32_t fbits = ((hbits & 0x8000) << 16) | ((exp | mant) << 13);
    return *(float*)&fbits;
}

// TSVM Advanced Video (TAV) format constants
#define TAV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x56"  // "\x1FTSVM TAV"
#define TAV_VERSION 1  // Initial DWT implementation

// Tile encoding modes (64x64 tiles)
#define TAV_MODE_SKIP      0x00  // Skip tile (copy from reference)
#define TAV_MODE_INTRA     0x01  // Intra DWT coding (I-frame tiles)
#define TAV_MODE_INTER     0x02  // Inter DWT coding with motion compensation
#define TAV_MODE_MOTION    0x03  // Motion vector only (good prediction)

// Video packet types
#define TAV_PACKET_IFRAME      0x10  // Intra frame (keyframe)
#define TAV_PACKET_PFRAME      0x11  // Predicted frame  
#define TAV_PACKET_AUDIO_MP2   0x20  // MP2 audio
#define TAV_PACKET_SUBTITLE    0x30  // Subtitle packet
#define TAV_PACKET_SYNC        0xFF  // Sync packet

// DWT settings
#define TILE_SIZE 64
#define MAX_DECOMP_LEVELS 4
#define DEFAULT_DECOMP_LEVELS 3

// Wavelet filter types
#define WAVELET_5_3_REVERSIBLE 0  // Lossless capable
#define WAVELET_9_7_IRREVERSIBLE 1  // Higher compression

// Default settings
#define DEFAULT_WIDTH 560
#define DEFAULT_HEIGHT 448
#define DEFAULT_FPS 30
#define DEFAULT_QUALITY 2

static void generate_random_filename(char *filename) {
    srand(time(NULL));

    const char charset[] = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const int charset_size = sizeof(charset) - 1;

    // Start with the prefix
    strcpy(filename, "/tmp/");

    // Generate 32 random characters
    for (int i = 0; i < 32; i++) {
        filename[5 + i] = charset[rand() % charset_size];
    }

    // Add the .mp2 extension
    strcpy(filename + 37, ".mp2");
    filename[41] = '\0';  // Null terminate
}

char TEMP_AUDIO_FILE[42];


// Utility macros
static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}
static inline float FCLAMP(float x, float min, float max) {
    return x < min ? min : (x > max ? max : x);
}

// MP2 audio rate table (same as TEV)
static const int MP2_RATE_TABLE[] = {128, 160, 224, 320, 384, 384};

// Quality level to quantization mapping for different channels
static const int QUALITY_Y[] = {90, 70, 50, 30, 15, 5};      // Luma (fine)
static const int QUALITY_CO[] = {80, 60, 40, 20, 10, 3};     // Chroma Co (aggressive)
static const int QUALITY_CG[] = {70, 50, 30, 15, 8, 2};      // Chroma Cg (very aggressive)

// DWT coefficient structure for each subband
typedef struct {
    int16_t *coeffs;
    int width, height;
    int size;
} dwt_subband_t;

// DWT tile structure
typedef struct {
    dwt_subband_t *ll, *lh, *hl, *hh;  // Subbands for each level
    int decomp_levels;
    int tile_x, tile_y;
} dwt_tile_t;

// Motion vector structure
typedef struct {
    int16_t mv_x, mv_y;  // 1/4 pixel precision
    float rate_control_factor;
} motion_vector_t;

// TAV encoder structure
typedef struct {
    // Input/output files
    char *input_file;
    char *output_file;
    char *subtitle_file;
    FILE *output_fp;
    FILE *mp2_file;
    FILE *ffmpeg_video_pipe;
    
    // Video parameters
    int width, height;
    int fps;
    int total_frames;
    int frame_count;
    
    // Encoding parameters
    int quality_level;
    int quantizer_y, quantizer_co, quantizer_cg;
    int wavelet_filter;
    int decomp_levels;
    int bitrate_mode;
    int target_bitrate;
    
    // Flags
    int progressive;
    int lossless;
    int enable_rcf;
    int enable_progressive_transmission;
    int enable_roi;
    int verbose;
    int test_mode;
    
    // Frame buffers
    uint8_t *current_frame_rgb;
    uint8_t *previous_frame_rgb;
    float *current_frame_y, *current_frame_co, *current_frame_cg;
    float *previous_frame_y, *previous_frame_co, *previous_frame_cg;
    
    // Tile processing
    int tiles_x, tiles_y;
    dwt_tile_t *tiles;
    motion_vector_t *motion_vectors;
    
    // Compression
    ZSTD_CCtx *zstd_ctx;
    void *compressed_buffer;
    size_t compressed_buffer_size;
    
    // Statistics
    size_t total_compressed_size;
    size_t total_uncompressed_size;
    
} tav_encoder_t;

// 5/3 Wavelet filter coefficients (reversible)
static const float WAVELET_5_3_LP[] = {0.5f, 1.0f, 0.5f};
static const float WAVELET_5_3_HP[] = {-0.125f, -0.25f, 0.75f, -0.25f, -0.125f};

// 9/7 Wavelet filter coefficients (irreversible - Daubechies)
static const float WAVELET_9_7_LP[] = {
    0.037828455507f, -0.023849465020f, -0.110624404418f, 0.377402855613f,
    0.852698679009f, 0.377402855613f, -0.110624404418f, -0.023849465020f, 0.037828455507f
};
static const float WAVELET_9_7_HP[] = {
    0.064538882629f, -0.040689417609f, -0.418092273222f, 0.788485616406f,
    -0.418092273222f, -0.040689417609f, 0.064538882629f
};

// Function prototypes
static void show_usage(const char *program_name);
static tav_encoder_t* create_encoder(void);
static void cleanup_encoder(tav_encoder_t *enc);
static int initialize_encoder(tav_encoder_t *enc);
static int encode_frame(tav_encoder_t *enc, int frame_num, int is_keyframe);
static void rgb_to_ycocg(const uint8_t *rgb, float *y, float *co, float *cg, int width, int height);
static void dwt_2d_forward(float *input, dwt_tile_t *tile, int filter_type);
static void dwt_2d_inverse(dwt_tile_t *tile, float *output, int filter_type);
static void quantize_subbands(dwt_tile_t *tile, int q_y, int q_co, int q_cg, float rcf);
static int estimate_motion_64x64(const float *current, const float *reference, 
                                 int width, int height, int tile_x, int tile_y, 
                                 motion_vector_t *mv);
static size_t compress_tile_data(tav_encoder_t *enc, const dwt_tile_t *tiles, 
                                 const motion_vector_t *mvs, int num_tiles,
                                 uint8_t packet_type);

// Show usage information
static void show_usage(const char *program_name) {
    printf("TAV DWT-based Video Encoder\n");
    printf("Usage: %s [options] -i input.mp4 -o output.tav\n\n", program_name);
    printf("Options:\n");
    printf("  -i, --input FILE       Input video file\n");
    printf("  -o, --output FILE      Output video file (use '-' for stdout)\n");
    printf("  -s, --size WxH         Video size (default: %dx%d)\n", DEFAULT_WIDTH, DEFAULT_HEIGHT);
    printf("  -f, --fps N            Output frames per second (enables frame rate conversion)\n");
    printf("  -q, --quality N        Quality level 0-5 (default: 2)\n");
    printf("  -Q, --quantizer Y,Co,Cg Quantizer levels 0-100 for each channel\n");
    printf("  -w, --wavelet N        Wavelet filter: 0=5/3 reversible, 1=9/7 irreversible (default: 1)\n");
    printf("  -d, --decomp N         Decomposition levels 1-4 (default: 3)\n");
    printf("  -b, --bitrate N        Target bitrate in kbps (enables bitrate control mode)\n");
    printf("  -p, --progressive      Use progressive scan (default: interlaced)\n");
    printf("  -S, --subtitles FILE   SubRip (.srt) or SAMI (.smi) subtitle file\n");
    printf("  -v, --verbose          Verbose output\n");
    printf("  -t, --test             Test mode: generate solid colour frames\n");
    printf("  --lossless             Lossless mode: use 5/3 reversible wavelet\n");
    printf("  --enable-rcf           Enable per-tile rate control (experimental)\n");
    printf("  --enable-progressive   Enable progressive transmission\n");
    printf("  --enable-roi           Enable region-of-interest coding\n");
    printf("  --help                 Show this help\n\n");
    
    printf("Audio Rate by Quality:\n  ");
    for (int i = 0; i < sizeof(MP2_RATE_TABLE) / sizeof(int); i++) {
        printf("%d: %d kbps\t", i, MP2_RATE_TABLE[i]);
    }
    printf("\n\nQuantizer Value by Quality:\n");
    printf("  Y (Luma):  ");
    for (int i = 0; i < 6; i++) {
        printf("%d: Q%d  ", i, QUALITY_Y[i]);
    }
    printf("\n  Co (Chroma): ");
    for (int i = 0; i < 6; i++) {
        printf("%d: Q%d  ", i, QUALITY_CO[i]);
    }
    printf("\n  Cg (Chroma): ");
    for (int i = 0; i < 6; i++) {
        printf("%d: Q%d  ", i, QUALITY_CG[i]);
    }
    
    printf("\n\nFeatures:\n");
    printf("  - 64x64 DWT tiles with multi-resolution encoding\n");
    printf("  - Full resolution YCoCg-R color space\n");
    printf("  - Progressive transmission and ROI coding\n");
    printf("  - Motion compensation with ±16 pixel search range\n");
    printf("  - Lossless and lossy compression modes\n");
    
    printf("\nExamples:\n");
    printf("  %s -i input.mp4 -o output.tav                    # Default settings\n", program_name);
    printf("  %s -i input.mkv -q 3 -w 1 -d 4 -o output.tav     # High quality with 9/7 wavelet\n", program_name);
    printf("  %s -i input.avi --lossless -o output.tav         # Lossless encoding\n", program_name);
    printf("  %s -i input.mp4 -b 800 -o output.tav             # 800 kbps bitrate target\n", program_name);
    printf("  %s -i input.webm -S subs.srt -o output.tav       # With subtitles\n", program_name);
}

// Create encoder instance
static tav_encoder_t* create_encoder(void) {
    tav_encoder_t *enc = calloc(1, sizeof(tav_encoder_t));
    if (!enc) return NULL;
    
    // Set defaults
    enc->width = DEFAULT_WIDTH;
    enc->height = DEFAULT_HEIGHT; 
    enc->fps = DEFAULT_FPS;
    enc->quality_level = DEFAULT_QUALITY;
    enc->wavelet_filter = WAVELET_9_7_IRREVERSIBLE;
    enc->decomp_levels = DEFAULT_DECOMP_LEVELS;
    enc->quantizer_y = QUALITY_Y[DEFAULT_QUALITY];
    enc->quantizer_co = QUALITY_CO[DEFAULT_QUALITY];
    enc->quantizer_cg = QUALITY_CG[DEFAULT_QUALITY];
    
    return enc;
}

// Initialize encoder resources
static int initialize_encoder(tav_encoder_t *enc) {
    if (!enc) return -1;
    
    // Calculate tile dimensions
    enc->tiles_x = (enc->width + TILE_SIZE - 1) / TILE_SIZE;
    enc->tiles_y = (enc->height + TILE_SIZE - 1) / TILE_SIZE;
    int num_tiles = enc->tiles_x * enc->tiles_y;
    
    // Allocate frame buffers
    size_t frame_size = enc->width * enc->height;
    enc->current_frame_rgb = malloc(frame_size * 3);
    enc->previous_frame_rgb = malloc(frame_size * 3);
    enc->current_frame_y = malloc(frame_size * sizeof(float));
    enc->current_frame_co = malloc(frame_size * sizeof(float));
    enc->current_frame_cg = malloc(frame_size * sizeof(float));
    enc->previous_frame_y = malloc(frame_size * sizeof(float));
    enc->previous_frame_co = malloc(frame_size * sizeof(float));
    enc->previous_frame_cg = malloc(frame_size * sizeof(float));
    
    // Allocate tile structures
    enc->tiles = malloc(num_tiles * sizeof(dwt_tile_t));
    enc->motion_vectors = malloc(num_tiles * sizeof(motion_vector_t));
    
    // Initialize ZSTD compression
    enc->zstd_ctx = ZSTD_createCCtx();
    enc->compressed_buffer_size = ZSTD_compressBound(1024 * 1024); // 1MB max
    enc->compressed_buffer = malloc(enc->compressed_buffer_size);
    
    if (!enc->current_frame_rgb || !enc->previous_frame_rgb || 
        !enc->current_frame_y || !enc->current_frame_co || !enc->current_frame_cg ||
        !enc->previous_frame_y || !enc->previous_frame_co || !enc->previous_frame_cg ||
        !enc->tiles || !enc->motion_vectors || !enc->zstd_ctx || !enc->compressed_buffer) {
        return -1;
    }
    
    return 0;
}

// Main function
int main(int argc, char *argv[]) {
    generate_random_filename(TEMP_AUDIO_FILE);

    printf("Initialising encoder...\n");
    tav_encoder_t *enc = create_encoder();
    if (!enc) {
        fprintf(stderr, "Error: Failed to create encoder\n");
        return 1;
    }
    
    // Command line option parsing (similar to TEV encoder)
    static struct option long_options[] = {
        {"input", required_argument, 0, 'i'},
        {"output", required_argument, 0, 'o'},
        {"size", required_argument, 0, 's'},
        {"fps", required_argument, 0, 'f'},
        {"quality", required_argument, 0, 'q'},
        {"quantizer", required_argument, 0, 'Q'},
        {"quantiser", required_argument, 0, 'Q'},
        {"wavelet", required_argument, 0, 'w'},
        {"decomp", required_argument, 0, 'd'},
        {"bitrate", required_argument, 0, 'b'},
        {"progressive", no_argument, 0, 'p'},
        {"subtitles", required_argument, 0, 'S'},
        {"verbose", no_argument, 0, 'v'},
        {"test", no_argument, 0, 't'},
        {"lossless", no_argument, 0, 1000},
        {"enable-rcf", no_argument, 0, 1001},
        {"enable-progressive", no_argument, 0, 1002},
        {"enable-roi", no_argument, 0, 1003},
        {"help", no_argument, 0, 1004},
        {0, 0, 0, 0}
    };
    
    int c, option_index = 0;
    while ((c = getopt_long(argc, argv, "i:o:s:f:q:Q:w:d:b:pS:vt", long_options, &option_index)) != -1) {
        switch (c) {
            case 'i':
                enc->input_file = strdup(optarg);
                break;
            case 'o':
                enc->output_file = strdup(optarg);
                break;
            case 'q':
                enc->quality_level = CLAMP(atoi(optarg), 0, 5);
                enc->quantizer_y = QUALITY_Y[enc->quality_level];
                enc->quantizer_co = QUALITY_CO[enc->quality_level];
                enc->quantizer_cg = QUALITY_CG[enc->quality_level];
                break;
            case 'w':
                enc->wavelet_filter = CLAMP(atoi(optarg), 0, 1);
                break;
            case 'd':
                enc->decomp_levels = CLAMP(atoi(optarg), 1, MAX_DECOMP_LEVELS);
                break;
            case 'p':
                enc->progressive = 1;
                break;
            case 'v':
                enc->verbose = 1;
                break;
            case 't':
                enc->test_mode = 1;
                break;
            case 1000: // --lossless
                enc->lossless = 1;
                enc->wavelet_filter = WAVELET_5_3_REVERSIBLE;
                break;
            case 1001: // --enable-rcf
                enc->enable_rcf = 1;
                break;
            case 1004: // --help
                show_usage(argv[0]);
                cleanup_encoder(enc);
                return 0;
            default:
                show_usage(argv[0]);
                cleanup_encoder(enc);
                return 1;
        }
    }
    
    if (!enc->input_file || !enc->output_file) {
        fprintf(stderr, "Error: Input and output files must be specified\n");
        show_usage(argv[0]);
        cleanup_encoder(enc);
        return 1;
    }
    
    if (initialize_encoder(enc) != 0) {
        fprintf(stderr, "Error: Failed to initialize encoder\n");
        cleanup_encoder(enc);
        return 1;
    }
    
    printf("TAV Encoder - DWT-based video compression\n");
    printf("Input: %s\n", enc->input_file);
    printf("Output: %s\n", enc->output_file);
    printf("Resolution: %dx%d\n", enc->width, enc->height);
    printf("Wavelet: %s\n", enc->wavelet_filter ? "9/7 irreversible" : "5/3 reversible");
    printf("Decomposition levels: %d\n", enc->decomp_levels);
    printf("Quality: Y=%d, Co=%d, Cg=%d\n", enc->quantizer_y, enc->quantizer_co, enc->quantizer_cg);
    
    // TODO: Implement actual encoding pipeline
    printf("Note: TAV encoder implementation in progress...\n");
    
    cleanup_encoder(enc);
    return 0;
}

// Cleanup encoder resources
static void cleanup_encoder(tav_encoder_t *enc) {
    if (!enc) return;
    
    if (enc->ffmpeg_video_pipe) {
        pclose(enc->ffmpeg_video_pipe);
    }
    if (enc->mp2_file) {
        fclose(enc->mp2_file);
        unlink(TEMP_AUDIO_FILE);
    }
    if (enc->output_fp) {
        fclose(enc->output_fp);
    }
    
    free(enc->input_file);
    free(enc->output_file);
    free(enc->subtitle_file);
    free(enc->current_frame_rgb);
    free(enc->previous_frame_rgb);
    free(enc->current_frame_y);
    free(enc->current_frame_co);
    free(enc->current_frame_cg);
    free(enc->previous_frame_y);
    free(enc->previous_frame_co);
    free(enc->previous_frame_cg);
    free(enc->tiles);
    free(enc->motion_vectors);
    free(enc->compressed_buffer);
    
    if (enc->zstd_ctx) {
        ZSTD_freeCCtx(enc->zstd_ctx);
    }
    
    free(enc);
}