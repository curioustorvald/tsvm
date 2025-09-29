// TAV Decoder - Working version with TSVM inverse DWT
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <zstd.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <signal.h>

// TAV format constants
#define TAV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x56"
#define TAV_MODE_SKIP      0x00
#define TAV_MODE_INTRA     0x01
#define TAV_MODE_DELTA     0x02
#define TAV_PACKET_IFRAME      0x10
#define TAV_PACKET_PFRAME      0x11
#define TAV_PACKET_AUDIO_MP2   0x20
#define TAV_PACKET_SUBTITLE    0x30
#define TAV_PACKET_SYNC        0xFF

// Channel layout constants (bit-field design)
#define CHANNEL_LAYOUT_YCOCG     0  // Y-Co-Cg (000: no alpha, has chroma, has luma)
#define CHANNEL_LAYOUT_YCOCG_A   1  // Y-Co-Cg-A (001: has alpha, has chroma, has luma)
#define CHANNEL_LAYOUT_Y_ONLY    2  // Y only (010: no alpha, no chroma, has luma)
#define CHANNEL_LAYOUT_Y_A       3  // Y-A (011: has alpha, no chroma, has luma)
#define CHANNEL_LAYOUT_COCG      4  // Co-Cg (100: no alpha, has chroma, no luma)
#define CHANNEL_LAYOUT_COCG_A    5  // Co-Cg-A (101: has alpha, has chroma, no luma)

// Utility macros
static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
}

// Helper function to check if alpha channel is needed for given channel layout
static inline int needs_alpha_channel(int channel_layout) {
    return (channel_layout & 1) != 0; // bit 0: 1 means has alpha
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

// Decoder: reconstruct coefficients from concatenated significance maps
// Layout: [Y_map][Co_map][Cg_map][Y_vals][Co_vals][Cg_vals]
static void postprocess_coefficients_concatenated(uint8_t *compressed_data, int coeff_count,
                                                 int16_t *output_y, int16_t *output_co, int16_t *output_cg) {
    int map_bytes = (coeff_count + 7) / 8;

    // Pointers to each section
    uint8_t *y_map = compressed_data;
    uint8_t *co_map = compressed_data + map_bytes;
    uint8_t *cg_map = compressed_data + map_bytes * 2;

    // Count non-zeros for each channel to find value arrays
    int y_nonzeros = 0, co_nonzeros = 0, cg_nonzeros = 0;

    for (int i = 0; i < coeff_count; i++) {
        int byte_idx = i / 8;
        int bit_idx = i % 8;

        if (y_map[byte_idx] & (1 << bit_idx)) y_nonzeros++;
        if (co_map[byte_idx] & (1 << bit_idx)) co_nonzeros++;
        if (cg_map[byte_idx] & (1 << bit_idx)) cg_nonzeros++;
    }

    // Pointers to value arrays
    int16_t *y_values = (int16_t *)(compressed_data + map_bytes * 3);
    int16_t *co_values = y_values + y_nonzeros;
    int16_t *cg_values = co_values + co_nonzeros;

    // Clear outputs
    memset(output_y, 0, coeff_count * sizeof(int16_t));
    memset(output_co, 0, coeff_count * sizeof(int16_t));
    memset(output_cg, 0, coeff_count * sizeof(int16_t));

    // Reconstruct coefficients for each channel
    int y_idx = 0, co_idx = 0, cg_idx = 0;
    for (int i = 0; i < coeff_count; i++) {
        int byte_idx = i / 8;
        int bit_idx = i % 8;

        if (y_map[byte_idx] & (1 << bit_idx)) {
            output_y[i] = y_values[y_idx++];
        }
        if (co_map[byte_idx] & (1 << bit_idx)) {
            output_co[i] = co_values[co_idx++];
        }
        if (cg_map[byte_idx] & (1 << bit_idx)) {
            output_cg[i] = cg_values[cg_idx++];
        }
    }
}

// TAV header structure (32 bytes)
typedef struct {
    uint8_t magic[8];
    uint8_t version;
    uint16_t width;
    uint16_t height;
    uint8_t fps;
    uint32_t total_frames;
    uint8_t wavelet_filter;
    uint8_t decomp_levels;
    uint8_t quantiser_y;
    uint8_t quantiser_co;
    uint8_t quantiser_cg;
    uint8_t extra_flags;
    uint8_t video_flags;
    uint8_t encoder_quality;
    uint8_t channel_layout;
    uint8_t file_role;
    uint8_t reserved[4];
} __attribute__((packed)) tav_header_t;

// Decoder state
typedef struct {
    FILE *input_fp;
    FILE *audio_output_fp;      // For MP2 audio output when using -p flag
    tav_header_t header;
    uint8_t *current_frame_rgb;
    uint8_t *reference_frame_rgb;
    float *dwt_buffer_y;
    float *dwt_buffer_co;
    float *dwt_buffer_cg;
    float *reference_ycocg_y;   // Reference frame in YCoCg float space
    float *reference_ycocg_co;
    float *reference_ycocg_cg;
    int frame_count;
    int frame_size;
} tav_decoder_t;

// TAV Perceptual quantization constants (must match Kotlin decoder exactly)
static const int QLUT[] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096};
static const float ANISOTROPY_MULT[] = {2.0f, 1.8f, 1.6f, 1.4f, 1.2f, 1.0f};
static const float ANISOTROPY_BIAS[] = {0.4f, 0.2f, 0.1f, 0.0f, 0.0f, 0.0f};
static const float ANISOTROPY_MULT_CHROMA[] = {6.6f, 5.5f, 4.4f, 3.3f, 2.2f, 1.1f};
static const float ANISOTROPY_BIAS_CHROMA[] = {1.0f, 0.8f, 0.6f, 0.4f, 0.2f, 0.0f};
static const float FOUR_PIXEL_DETAILER = 0.88f;
static const float TWO_PIXEL_DETAILER = 0.92f;

// DWT subband information for perceptual quantization
typedef struct {
    int level;              // Decomposition level (1 to decompLevels)
    int subband_type;       // 0=LL, 1=LH, 2=HL, 3=HH
    int coeff_start;        // Starting index in linear coefficient array
    int coeff_count;        // Number of coefficients in this subband
} dwt_subband_info_t;

// Perceptual model functions (must match Kotlin exactly)
static int tav_derive_encoder_qindex(int q_index, int q_y_global) {
    if (q_index > 0) return q_index - 1;
    if (q_y_global >= 60) return 0;
    else if (q_y_global >= 42) return 1;
    else if (q_y_global >= 25) return 2;
    else if (q_y_global >= 12) return 3;
    else if (q_y_global >= 6) return 4;
    else if (q_y_global >= 2) return 5;
    else return 5;
}

static float perceptual_model3_LH(int quality, float level) {
    const float H4 = 1.2f;
    const float Lx = H4 - ((quality + 1.0f) / 15.0f) * (level - 4.0f);
    const float Ld = (quality + 1.0f) / -15.0f;
    const float C = H4 - 4.0f * Ld - ((-16.0f * (quality - 5.0f)) / 15.0f);
    const float Gx = (Ld * level) - (((quality - 5.0f) * (level - 8.0f) * level) / 15.0f) + C;
    return (level >= 4) ? Lx : Gx;
}

static float perceptual_model3_HL(int quality, float LH) {
    return LH * ANISOTROPY_MULT[quality] + ANISOTROPY_BIAS[quality];
}

static float perceptual_model3_HH(float LH, float HL) {
    return (HL / LH) * 1.44f;
}

static float perceptual_model3_LL(int quality, float level) {
    const float n = perceptual_model3_LH(quality, level);
    const float m = perceptual_model3_LH(quality, level - 1) / n;
    return n / m;
}

static float perceptual_model3_chroma_basecurve(int quality, float level) {
    return 1.0f - (1.0f / (0.5f * quality * quality + 1.0f)) * (level - 4.0f);
}

static float get_perceptual_weight(int q_index, int q_y_global, int level0, int subband_type,
                                  int is_chroma, int max_levels) {
    // Convert to perceptual level (1-6 scale)
    const float level = 1.0f + ((level0 - 1.0f) / (max_levels - 1.0f)) * 5.0f;
    const int quality_level = tav_derive_encoder_qindex(q_index, q_y_global);

    if (!is_chroma) {
        // LUMA CHANNEL
        if (subband_type == 0) {
            return perceptual_model3_LL(quality_level, level);
        }

        const float LH = perceptual_model3_LH(quality_level, level);
        if (subband_type == 1) {
            return LH;
        }

        const float HL = perceptual_model3_HL(quality_level, LH);
        if (subband_type == 2) {
            float detailer = 1.0f;
            if (level >= 1.8f && level <= 2.2f) detailer = TWO_PIXEL_DETAILER;
            else if (level >= 2.8f && level <= 3.2f) detailer = FOUR_PIXEL_DETAILER;
            return HL * detailer;
        } else {
            // HH subband
            float detailer = 1.0f;
            if (level >= 1.8f && level <= 2.2f) detailer = TWO_PIXEL_DETAILER;
            else if (level >= 2.8f && level <= 3.2f) detailer = FOUR_PIXEL_DETAILER;
            return perceptual_model3_HH(LH, HL) * detailer;
        }
    } else {
        // CHROMA CHANNELS
        const float base = perceptual_model3_chroma_basecurve(quality_level, level - 1);
        if (subband_type == 0) {
            return 1.0f;
        } else if (subband_type == 1) {
            return fmaxf(base, 1.0f);
        } else if (subband_type == 2) {
            return fmaxf(base * ANISOTROPY_MULT_CHROMA[quality_level], 1.0f);
        } else {
            return fmaxf(base * ANISOTROPY_MULT_CHROMA[quality_level] + ANISOTROPY_BIAS_CHROMA[quality_level], 1.0f);
        }
    }
}

// Calculate DWT subband layout (must match Kotlin exactly)
static int calculate_subband_layout(int width, int height, int decomp_levels, dwt_subband_info_t *subbands) {
    int subband_count = 0;

    // LL subband at maximum decomposition level
    const int ll_width = width >> decomp_levels;
    const int ll_height = height >> decomp_levels;
    subbands[subband_count++] = (dwt_subband_info_t){decomp_levels, 0, 0, ll_width * ll_height};
    int coeff_offset = ll_width * ll_height;

    // LH, HL, HH subbands for each level from max down to 1
    for (int level = decomp_levels; level >= 1; level--) {
        const int level_width = width >> (decomp_levels - level + 1);
        const int level_height = height >> (decomp_levels - level + 1);
        const int subband_size = level_width * level_height;

        // LH subband
        subbands[subband_count++] = (dwt_subband_info_t){level, 1, coeff_offset, subband_size};
        coeff_offset += subband_size;

        // HL subband
        subbands[subband_count++] = (dwt_subband_info_t){level, 2, coeff_offset, subband_size};
        coeff_offset += subband_size;

        // HH subband
        subbands[subband_count++] = (dwt_subband_info_t){level, 3, coeff_offset, subband_size};
        coeff_offset += subband_size;
    }

    return subband_count;
}

// Apply perceptual dequantization to DWT coefficients
static void dequantize_dwt_subbands_perceptual(int q_index, int q_y_global, const int16_t *quantized,
                                              float *dequantized, int width, int height, int decomp_levels,
                                              float base_quantizer, int is_chroma) {
    dwt_subband_info_t subbands[32]; // Max possible subbands
    const int subband_count = calculate_subband_layout(width, height, decomp_levels, subbands);

    // Initialize output array
    const int coeff_count = width * height;
    for (int i = 0; i < coeff_count; i++) {
        dequantized[i] = 0.0f;
    }

    // Apply perceptual weighting to each subband
    for (int s = 0; s < subband_count; s++) {
        const dwt_subband_info_t *subband = &subbands[s];
        const float weight = get_perceptual_weight(q_index, q_y_global, subband->level,
                                                  subband->subband_type, is_chroma, decomp_levels);
        const float effective_quantizer = base_quantizer * weight;

        for (int i = 0; i < subband->coeff_count; i++) {
            const int idx = subband->coeff_start + i;
            if (idx < coeff_count) {
                dequantized[idx] = quantized[idx] * effective_quantizer;
            }
        }
    }
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

// 5/3 inverse DWT (simplified for testing)
static void dwt_53_inverse_1d(float *data, int length) {
    if (length < 2) return;

    // For now, use a simplified version
    // TODO: Implement proper 5/3 from TSVM if needed
    dwt_97_inverse_1d(data, length);
}

// Multi-level inverse DWT (fixed to match TSVM exactly)
static void apply_inverse_dwt_multilevel(float *data, int width, int height, int levels, int filter_type) {
    int max_size = (width > height) ? width : height;
    float *temp_row = malloc(max_size * sizeof(float));
    float *temp_col = malloc(max_size * sizeof(float));

    // TSVM: for (level in levels - 1 downTo 0)
    for (int level = levels - 1; level >= 0; level--) {
        // TSVM: val currentWidth = width shr level
        int current_width = width >> level;
        int current_height = height >> level;

        // Handle edge cases
        if (current_width < 1 || current_height < 1) continue;
        if (current_width == 1 && current_height == 1) continue;

        // TSVM: Column inverse transform first (vertical)
        for (int x = 0; x < current_width; x++) {
            for (int y = 0; y < current_height; y++) {
                // TSVM applies sharpenFilter multiplier, we'll skip for now
                temp_col[y] = data[y * width + x];
            }

            if (filter_type == 0) {  // 5/3 reversible
                dwt_53_inverse_1d(temp_col, current_height);
            } else {  // 9/7 irreversible
                dwt_97_inverse_1d(temp_col, current_height);
            }

            for (int y = 0; y < current_height; y++) {
                data[y * width + x] = temp_col[y];
            }
        }

        // TSVM: Row inverse transform second (horizontal)
        for (int y = 0; y < current_height; y++) {
            for (int x = 0; x < current_width; x++) {
                // TSVM applies sharpenFilter multiplier, we'll skip for now
                temp_row[x] = data[y * width + x];
            }

            if (filter_type == 0) {  // 5/3 reversible
                dwt_53_inverse_1d(temp_row, current_width);
            } else {  // 9/7 irreversible
                dwt_97_inverse_1d(temp_row, current_width);
            }

            for (int x = 0; x < current_width; x++) {
                data[y * width + x] = temp_row[x];
            }
        }
    }

    free(temp_row);
    free(temp_col);
}

// YCoCg-R to RGB conversion (from TSVM)
static void ycocg_r_to_rgb(float y, float co, float cg, uint8_t *r, uint8_t *g, uint8_t *b) {
    float tmp = y - cg / 2.0f;
    float g_val = cg + tmp;
    float b_val = tmp - co / 2.0f;
    float r_val = co + b_val;

    *r = CLAMP((int)(r_val + 0.5f), 0, 255);
    *g = CLAMP((int)(g_val + 0.5f), 0, 255);
    *b = CLAMP((int)(b_val + 0.5f), 0, 255);
}

// Initialize decoder
static tav_decoder_t* tav_decoder_init(const char *input_file) {
    tav_decoder_t *decoder = calloc(1, sizeof(tav_decoder_t));
    if (!decoder) return NULL;

    decoder->input_fp = fopen(input_file, "rb");
    if (!decoder->input_fp) {
        free(decoder);
        return NULL;
    }

    // Read header
    if (fread(&decoder->header, sizeof(tav_header_t), 1, decoder->input_fp) != 1) {
        fclose(decoder->input_fp);
        free(decoder);
        return NULL;
    }

    // Verify magic
    if (memcmp(decoder->header.magic, TAV_MAGIC, 8) != 0) {
        fclose(decoder->input_fp);
        free(decoder);
        return NULL;
    }

    decoder->frame_size = decoder->header.width * decoder->header.height;

    // Allocate buffers
    decoder->current_frame_rgb = calloc(decoder->frame_size * 3, 1);
    decoder->reference_frame_rgb = calloc(decoder->frame_size * 3, 1);
    decoder->dwt_buffer_y = calloc(decoder->frame_size, sizeof(float));
    decoder->dwt_buffer_co = calloc(decoder->frame_size, sizeof(float));
    decoder->dwt_buffer_cg = calloc(decoder->frame_size, sizeof(float));
    decoder->reference_ycocg_y = calloc(decoder->frame_size, sizeof(float));
    decoder->reference_ycocg_co = calloc(decoder->frame_size, sizeof(float));
    decoder->reference_ycocg_cg = calloc(decoder->frame_size, sizeof(float));

    return decoder;
}

// Cleanup decoder
static void tav_decoder_free(tav_decoder_t *decoder) {
    if (!decoder) return;

    if (decoder->input_fp) fclose(decoder->input_fp);
    free(decoder->current_frame_rgb);
    free(decoder->reference_frame_rgb);
    free(decoder->dwt_buffer_y);
    free(decoder->dwt_buffer_co);
    free(decoder->dwt_buffer_cg);
    free(decoder->reference_ycocg_y);
    free(decoder->reference_ycocg_co);
    free(decoder->reference_ycocg_cg);
    free(decoder);
}

// Decode a single frame
static int decode_frame(tav_decoder_t *decoder) {
    uint8_t packet_type;
    uint32_t packet_size;

    // Check file position before reading
    long file_pos = ftell(decoder->input_fp);

    // Read packet header
    if (fread(&packet_type, 1, 1, decoder->input_fp) != 1) {
        fprintf(stderr, "EOF at frame %d (file pos: %ld)\n", decoder->frame_count, file_pos);
        return 0; // EOF
    }

    // Sync packets have no size field - they're just a single 0xFF byte
    if (packet_type == TAV_PACKET_SYNC) {
        if (decoder->frame_count < 5) {
            fprintf(stderr, "Found sync packet 0xFF at pos %ld\n", file_pos);
        }
        return decode_frame(decoder); // Immediately try next packet
    }

    // All other packets have a 4-byte size field
    if (fread(&packet_size, 4, 1, decoder->input_fp) != 1) {
        fprintf(stderr, "Error reading packet size at frame %d (file pos: %ld)\n", decoder->frame_count, file_pos);
        return -1; // Error
    }

    // Debug: Show packet info for first few frames
    if (decoder->frame_count < 5) {
        fprintf(stderr, "Frame %d: packet_type=0x%02X, size=%u (file pos: %ld)\n",
               decoder->frame_count, packet_type, packet_size, file_pos);
    }

    // Handle audio packets when using FFplay mode
    if (packet_type == TAV_PACKET_AUDIO_MP2) {
        if (decoder->audio_output_fp) {
            // Read and write MP2 audio data directly
            uint8_t *audio_data = malloc(packet_size);
            if (fread(audio_data, 1, packet_size, decoder->input_fp) == packet_size) {
                fwrite(audio_data, 1, packet_size, decoder->audio_output_fp);
                fflush(decoder->audio_output_fp);
            }
            free(audio_data);
        } else {
            // Skip audio packets in normal mode
            if (decoder->frame_count < 5) {
                long before_skip = ftell(decoder->input_fp);
                fprintf(stderr, "Skipping non-video packet: type=0x%02X, size=%u (pos: %ld)\n", packet_type, packet_size, before_skip);
                fseek(decoder->input_fp, packet_size, SEEK_CUR);
                long after_skip = ftell(decoder->input_fp);
                fprintf(stderr, "After skip: pos=%ld (moved %ld bytes)\n", after_skip, after_skip - before_skip);
            } else {
                fseek(decoder->input_fp, packet_size, SEEK_CUR);
            }
        }
        return decode_frame(decoder);
    }

    // Skip subtitle packets
    if (packet_type == TAV_PACKET_SUBTITLE) {
        if (decoder->frame_count < 5) {
            long before_skip = ftell(decoder->input_fp);
            fprintf(stderr, "Skipping subtitle packet: type=0x%02X, size=%u (pos: %ld)\n", packet_type, packet_size, before_skip);
            fseek(decoder->input_fp, packet_size, SEEK_CUR);
            long after_skip = ftell(decoder->input_fp);
            fprintf(stderr, "After skip: pos=%ld (moved %ld bytes)\n", after_skip, after_skip - before_skip);
        } else {
            fseek(decoder->input_fp, packet_size, SEEK_CUR);
        }
        return decode_frame(decoder);
    }

    if (packet_type != TAV_PACKET_IFRAME && packet_type != TAV_PACKET_PFRAME) {
        fprintf(stderr, "Unknown packet type: 0x%02X (expected 0x%02X for audio)\n", packet_type, TAV_PACKET_AUDIO_MP2);
        return -1;
    }

    // Read and decompress frame data
    uint8_t *compressed_data = malloc(packet_size);
    if (fread(compressed_data, 1, packet_size, decoder->input_fp) != packet_size) {
        free(compressed_data);
        return -1;
    }

    size_t decompressed_size = ZSTD_getFrameContentSize(compressed_data, packet_size);
    if (decompressed_size == ZSTD_CONTENTSIZE_ERROR || decompressed_size == ZSTD_CONTENTSIZE_UNKNOWN) {
        decompressed_size = decoder->frame_size * 3 * sizeof(int16_t) + 1024;
    }

    uint8_t *decompressed_data = malloc(decompressed_size);
    size_t actual_size = ZSTD_decompress(decompressed_data, decompressed_size, compressed_data, packet_size);

    if (ZSTD_isError(actual_size)) {
        fprintf(stderr, "ZSTD decompression failed: %s\n", ZSTD_getErrorName(actual_size));
        free(compressed_data);
        free(decompressed_data);
        return -1;
    }

    // Parse block data
    uint8_t *ptr = decompressed_data;
    uint8_t mode = *ptr++;
    uint8_t qy_override = *ptr++;
    uint8_t qco_override = *ptr++;
    uint8_t qcg_override = *ptr++;

    int qy = QLUT[qy_override ? qy_override : decoder->header.quantiser_y];
    int qco = QLUT[qco_override ? qco_override : decoder->header.quantiser_co];
    int qcg = QLUT[qcg_override ? qcg_override : decoder->header.quantiser_cg];

    if (mode == TAV_MODE_SKIP) {
        // Copy from reference frame
        memcpy(decoder->current_frame_rgb, decoder->reference_frame_rgb, decoder->frame_size * 3);
    } else {
        // Read coefficients with significance map postprocessing
        int coeff_count = decoder->frame_size;
        uint8_t *coeff_ptr = ptr;

        // Allocate arrays for decompressed coefficients
        int16_t *quantized_y = malloc(coeff_count * sizeof(int16_t));
        int16_t *quantized_co = malloc(coeff_count * sizeof(int16_t));
        int16_t *quantized_cg = malloc(coeff_count * sizeof(int16_t));

        // Use concatenated maps format: [Y_map][Co_map][Cg_map][Y_vals][Co_vals][Cg_vals]
        postprocess_coefficients_concatenated(coeff_ptr, coeff_count, quantized_y, quantized_co, quantized_cg);

        // Calculate total processed data size for concatenated format
        int map_bytes = (coeff_count + 7) / 8;
        int y_nonzeros = 0, co_nonzeros = 0, cg_nonzeros = 0;

        // Count non-zeros in each channel's significance map
        for (int i = 0; i < coeff_count; i++) {
            int byte_idx = i / 8;
            int bit_idx = i % 8;

            if (coeff_ptr[byte_idx] & (1 << bit_idx)) y_nonzeros++;                    // Y map
            if (coeff_ptr[map_bytes + byte_idx] & (1 << bit_idx)) co_nonzeros++;      // Co map
            if (coeff_ptr[map_bytes * 2 + byte_idx] & (1 << bit_idx)) cg_nonzeros++; // Cg map
        }

        // Total size consumed: 3 maps + all non-zero values
        size_t total_processed_size = map_bytes * 3 + (y_nonzeros + co_nonzeros + cg_nonzeros) * sizeof(int16_t);

        // Apply dequantization (perceptual for version 5, uniform for earlier versions)
        const int is_perceptual = (decoder->header.version == 5);
        if (is_perceptual) {
            // Use perceptual dequantization matching Kotlin decoder
            dequantize_dwt_subbands_perceptual(0, qy, quantized_y, decoder->dwt_buffer_y,
                                              decoder->header.width, decoder->header.height,
                                              decoder->header.decomp_levels, qy, 0);
            dequantize_dwt_subbands_perceptual(0, qy, quantized_co, decoder->dwt_buffer_co,
                                              decoder->header.width, decoder->header.height,
                                              decoder->header.decomp_levels, qco, 1);
            dequantize_dwt_subbands_perceptual(0, qy, quantized_cg, decoder->dwt_buffer_cg,
                                              decoder->header.width, decoder->header.height,
                                              decoder->header.decomp_levels, qcg, 1);
        } else {
            // Uniform dequantization for older versions
            for (int i = 0; i < coeff_count; i++) {
                decoder->dwt_buffer_y[i] = quantized_y[i] * qy;
                decoder->dwt_buffer_co[i] = quantized_co[i] * qco;
                decoder->dwt_buffer_cg[i] = quantized_cg[i] * qcg;
            }
        }

        free(quantized_y);
        free(quantized_co);
        free(quantized_cg);

        // Apply inverse DWT
        apply_inverse_dwt_multilevel(decoder->dwt_buffer_y, decoder->header.width, decoder->header.height,
                                   decoder->header.decomp_levels, decoder->header.wavelet_filter);
        apply_inverse_dwt_multilevel(decoder->dwt_buffer_co, decoder->header.width, decoder->header.height,
                                   decoder->header.decomp_levels, decoder->header.wavelet_filter);
        apply_inverse_dwt_multilevel(decoder->dwt_buffer_cg, decoder->header.width, decoder->header.height,
                                   decoder->header.decomp_levels, decoder->header.wavelet_filter);

        // Handle P-frame delta accumulation (in YCoCg float space)
        if (packet_type == TAV_PACKET_PFRAME && mode == TAV_MODE_DELTA) {
            // Add delta to reference frame
            for (int i = 0; i < decoder->frame_size; i++) {
                decoder->dwt_buffer_y[i] += decoder->reference_ycocg_y[i];
                decoder->dwt_buffer_co[i] += decoder->reference_ycocg_co[i];
                decoder->dwt_buffer_cg[i] += decoder->reference_ycocg_cg[i];
            }
        }

        // Convert YCoCg-R to RGB
        for (int i = 0; i < decoder->frame_size; i++) {
            uint8_t r, g, b;
            ycocg_r_to_rgb(decoder->dwt_buffer_y[i],
                          decoder->dwt_buffer_co[i],
                          decoder->dwt_buffer_cg[i], &r, &g, &b);

            decoder->current_frame_rgb[i * 3] = r;
            decoder->current_frame_rgb[i * 3 + 1] = g;
            decoder->current_frame_rgb[i * 3 + 2] = b;
        }

        // Update reference YCoCg frame (for future P-frames)
        memcpy(decoder->reference_ycocg_y, decoder->dwt_buffer_y, decoder->frame_size * sizeof(float));
        memcpy(decoder->reference_ycocg_co, decoder->dwt_buffer_co, decoder->frame_size * sizeof(float));
        memcpy(decoder->reference_ycocg_cg, decoder->dwt_buffer_cg, decoder->frame_size * sizeof(float));
    }

    // Update reference frame
    memcpy(decoder->reference_frame_rgb, decoder->current_frame_rgb, decoder->frame_size * 3);

    free(compressed_data);
    free(decompressed_data);
    decoder->frame_count++;

    // Debug: Check file position after processing frame
    if (decoder->frame_count < 5) {
        long end_pos = ftell(decoder->input_fp);
        fprintf(stderr, "Frame %d completed, file pos now: %ld\n", decoder->frame_count - 1, end_pos);
    }

    return 1;
}

// Output current frame as RGB24 to stdout
static void output_frame_rgb24(tav_decoder_t *decoder) {
    fwrite(decoder->current_frame_rgb, 1, decoder->frame_size * 3, stdout);
}

int main(int argc, char *argv[]) {
    char *input_file = NULL;
    int use_ffplay = 0;

    // Parse command line arguments
    if (argc < 2 || argc > 3) {
        fprintf(stderr, "Usage: %s input.tav [-p]\n", argv[0]);
        fprintf(stderr, "TAV Decoder decodes video packets into raw RGB24 picture that can be piped into FFmpeg or FFplay.\n");
        fprintf(stderr, "  -p    Start FFplay directly instead of outputting to stdout\n");
        fprintf(stderr, "\nExamples:\n");
        fprintf(stderr, "  %s input.tav | mpv --demuxer=rawvideo --demuxer-rawvideo-w=WIDTH --demuxer-rawvideo-h=HEIGHT -\n", argv[0]);
        fprintf(stderr, "  %s input.tav -p\n", argv[0]);
        return 1;
    }

    // Check for -p flag
    if (argc == 3) {
        if (strcmp(argv[2], "-p") == 0) {
            use_ffplay = 1;
            input_file = argv[1];
        } else if (strcmp(argv[1], "-p") == 0) {
            use_ffplay = 1;
            input_file = argv[2];
        } else {
            fprintf(stderr, "Error: Unknown flag '%s'\n", argv[2]);
            return 1;
        }
    } else {
        input_file = argv[1];
    }

    tav_decoder_t *decoder = tav_decoder_init(input_file);
    if (!decoder) {
        fprintf(stderr, "Failed to initialize decoder\n");
        return 1;
    }

    fprintf(stderr, "TAV Decoder - %dx%d @ %dfps, %d levels, version %d\n",
            decoder->header.width, decoder->header.height, decoder->header.fps,
            decoder->header.decomp_levels, decoder->header.version);

    fprintf(stderr, "Header says: %u total frames\n", decoder->header.total_frames);

    FILE *output_fp = stdout;
    pid_t ffplay_pid = 0, ffmpeg_pid = 0;
    char *audio_fifo_path = NULL;

    // If -p flag is used, use FFmpeg to mux video+audio and pipe to FFplay
    if (use_ffplay) {
        int video_pipe[2], audio_pipe[2], ffmpeg_pipe[2];
        if (pipe(video_pipe) == -1 || pipe(audio_pipe) == -1 || pipe(ffmpeg_pipe) == -1) {
            fprintf(stderr, "Failed to create pipes\n");
            tav_decoder_free(decoder);
            return 1;
        }

        ffmpeg_pid = fork();
        if (ffmpeg_pid == -1) {
            fprintf(stderr, "Failed to fork FFmpeg process\n");
            tav_decoder_free(decoder);
            return 1;
        } else if (ffmpeg_pid == 0) {
            // Child process 1 - FFmpeg muxer
            close(video_pipe[1]);  // Close write ends
            close(audio_pipe[1]);
            close(ffmpeg_pipe[0]);  // Close read end of output pipe

            char video_size[32];
            char framerate[16];
            snprintf(video_size, sizeof(video_size), "%dx%d", decoder->header.width, decoder->header.height);
            snprintf(framerate, sizeof(framerate), "%d", decoder->header.fps);

            // Redirect pipes to file descriptors
            dup2(video_pipe[0], 3);  // Video input on fd 3
            dup2(audio_pipe[0], 4);  // Audio input on fd 4
            dup2(ffmpeg_pipe[1], STDOUT_FILENO);  // Output to stdout

            close(video_pipe[0]);
            close(audio_pipe[0]);
            close(ffmpeg_pipe[1]);

            execl("/usr/bin/ffmpeg", "ffmpeg",
                  "-f", "rawvideo",
                  "-pixel_format", "rgb24",
                  "-video_size", video_size,
                  "-framerate", framerate,
                  "-i", "pipe:3",              // Video from fd 3
                  "-f", "mp3",                 // MP3 demuxer handles MP2/MP3
                  "-i", "pipe:4",              // Audio from fd 4
                  "-c:v", "libx264",           // Encode video to H.264
                  "-preset", "ultrafast",      // Fast encoding
                  "-crf", "23",                // Good quality
                  "-c:a", "copy",              // Copy audio as-is (no re-encoding)
                  "-f", "matroska",            // Output as MKV (good for streaming)
                  "-",                         // Output to stdout
                  "-v", "error",               // Minimal logging
                  (char*)NULL);

            // Try alternative path
            execl("/usr/local/bin/ffmpeg", "ffmpeg",
                  "-f", "rawvideo",
                  "-pixel_format", "rgb24",
                  "-video_size", video_size,
                  "-framerate", framerate,
                  "-i", "pipe:3",
                  "-f", "mp3",
                  "-i", "pipe:4",
                  "-c:v", "libx264",
                  "-preset", "ultrafast",
                  "-crf", "23",
                  "-c:a", "copy",
                  "-f", "matroska",
                  "-",
                  "-v", "error",
                  (char*)NULL);

            fprintf(stderr, "Failed to start ffmpeg for muxing\n");
            exit(1);
        }

        // Fork again for FFplay
        ffplay_pid = fork();
        if (ffplay_pid == -1) {
            fprintf(stderr, "Failed to fork FFplay process\n");
            kill(ffmpeg_pid, SIGTERM);
            tav_decoder_free(decoder);
            return 1;
        } else if (ffplay_pid == 0) {
            // Child process 2 - FFplay
            close(video_pipe[0]);  // Close unused ends
            close(video_pipe[1]);
            close(audio_pipe[0]);
            close(audio_pipe[1]);
            close(ffmpeg_pipe[1]);

            // Read from FFmpeg output
            dup2(ffmpeg_pipe[0], STDIN_FILENO);
            close(ffmpeg_pipe[0]);

            execl("/usr/bin/ffplay", "ffplay",
                  "-i", "-",                   // Input from stdin
                  "-v", "error",               // Minimal logging
                  (char*)NULL);

            execl("/usr/local/bin/ffplay", "ffplay",
                  "-i", "-",
                  "-v", "error",
                  (char*)NULL);

            fprintf(stderr, "Failed to start ffplay\n");
            exit(1);
        } else {
            // Parent process - write to video and audio pipes
            close(video_pipe[0]);   // Close read ends
            close(audio_pipe[0]);
            close(ffmpeg_pipe[0]);
            close(ffmpeg_pipe[1]);

            output_fp = fdopen(video_pipe[1], "wb");
            decoder->audio_output_fp = fdopen(audio_pipe[1], "wb");

            if (!output_fp || !decoder->audio_output_fp) {
                fprintf(stderr, "Failed to open pipes for writing\n");
                kill(ffmpeg_pid, SIGTERM);
                kill(ffplay_pid, SIGTERM);
                tav_decoder_free(decoder);
                return 1;
            }

            fprintf(stderr, "Starting FFmpeg muxer + FFplay for video+audio playback\n");
        }
    } else {
        fprintf(stderr, "To test: %s %s | ffplay -f rawvideo -pixel_format rgb24 -video_size %dx%d -framerate %d -\n",
                argv[0], input_file, decoder->header.width, decoder->header.height, decoder->header.fps);
    }

    int result;
    while ((result = decode_frame(decoder)) == 1) {
        // Write RGB24 data to output (stdout or ffplay pipe)
        fwrite(decoder->current_frame_rgb, decoder->frame_size * 3, 1, output_fp);
        fflush(output_fp);

        // Debug: Print frame progress (only to stderr)
        if (decoder->frame_count % 100 == 0 || decoder->frame_count < 5) {
            fprintf(stderr, "Decoded frame %d\n", decoder->frame_count);
        }
    }

    if (result < 0) {
        fprintf(stderr, "Decoding error\n");
        if (use_ffplay) {
            if (ffmpeg_pid > 0) kill(ffmpeg_pid, SIGTERM);
            if (ffplay_pid > 0) kill(ffplay_pid, SIGTERM);
        }
        tav_decoder_free(decoder);
        return 1;
    }

    fprintf(stderr, "Decoded %d frames\n", decoder->frame_count);

    // Clean up
    if (use_ffplay) {
        if (output_fp != stdout) {
            fclose(output_fp);
        }
        if (decoder->audio_output_fp) {
            fclose(decoder->audio_output_fp);
            decoder->audio_output_fp = NULL;
        }
        if (ffmpeg_pid > 0) {
            int status;
            waitpid(ffmpeg_pid, &status, 0);
        }
        if (ffplay_pid > 0) {
            int status;
            waitpid(ffplay_pid, &status, 0);
        }
    }

    tav_decoder_free(decoder);
    return 0;
}
