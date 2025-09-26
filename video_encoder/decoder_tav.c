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

// Utility macros
static inline int CLAMP(int x, int min, int max) {
    return x < min ? min : (x > max ? max : x);
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
    uint8_t file_role;
    uint8_t reserved[5];
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

    int qy = qy_override ? qy_override : decoder->header.quantiser_y;
    int qco = qco_override ? qco_override : decoder->header.quantiser_co;
    int qcg = qcg_override ? qcg_override : decoder->header.quantiser_cg;

    if (mode == TAV_MODE_SKIP) {
        // Copy from reference frame
        memcpy(decoder->current_frame_rgb, decoder->reference_frame_rgb, decoder->frame_size * 3);
    } else {
        // Read coefficients in TSVM order: all Y, then all Co, then all Cg
        int coeff_count = decoder->frame_size;
        uint8_t *coeff_ptr = ptr;

        // Read and dequantize coefficients (simple version for now)
        for (int i = 0; i < coeff_count; i++) {
            int16_t y_coeff = (int16_t)((coeff_ptr[1] << 8) | coeff_ptr[0]);
            decoder->dwt_buffer_y[i] = y_coeff * qy;
            coeff_ptr += 2;
        }
        for (int i = 0; i < coeff_count; i++) {
            int16_t co_coeff = (int16_t)((coeff_ptr[1] << 8) | coeff_ptr[0]);
            decoder->dwt_buffer_co[i] = co_coeff * qco;
            coeff_ptr += 2;
        }
        for (int i = 0; i < coeff_count; i++) {
            int16_t cg_coeff = (int16_t)((coeff_ptr[1] << 8) | coeff_ptr[0]);
            decoder->dwt_buffer_cg[i] = cg_coeff * qcg;
            coeff_ptr += 2;
        }

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
