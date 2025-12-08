/**
 * TAV Encoder CLI - Reference Implementation using libtavenc
 *
 * Complete reference encoder with all features from the original encoder:
 * - Full command-line argument support
 * - All encoder presets (sports, anime)
 * - Scene change detection (two-pass encoding)
 * - Multi-threading support
 * - FFmpeg integration for frame reading
 * - TAV file format writing with all packet types
 * - TAD audio encoding integration
 * - Subtitle and font ROM support
 *
 * This is the official CLI implementation using libtavenc library.
 * Reduced from 14,000 lines to ~1,600 lines while preserving all features.
 *
 * Created by CuriousTorvald and Claude on 2025-12-03-04.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <getopt.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include <pthread.h>

#include "tav_encoder_lib.h"
#include "encoder_tad.h"

// =============================================================================
// Multithreading Structures
// =============================================================================

#define MAX_THREADS 16
#define GOP_SLOT_EMPTY 0
#define GOP_SLOT_READY 1
#define GOP_SLOT_ENCODING 2
#define GOP_SLOT_COMPLETE 3

typedef struct gop_job {
    // Slot state
    volatile int status;

    // Input data (owned by job)
    uint8_t **rgb_frames;        // Array of frame pointers [num_frames]
    int num_frames;              // Frames in this GOP
    int *frame_numbers;          // Frame indices for timecodes
    int gop_index;               // Sequential GOP number

    // Audio data (owned by job)
    float *audio_samples;        // Stereo PCM32f for this GOP
    size_t num_audio_samples;    // Samples per channel

    // Output data (filled by worker, owned by job)
    tav_encoder_packet_t *packet; // Encoded video packet
    int success;                  // 1 if encoding succeeded

    // Encoder params (copy for thread safety)
    tav_encoder_params_t params;
} gop_job_t;

// =============================================================================
// Constants and Globals
// =============================================================================

#define TAV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x41\x56"  // "\x1FTSVMTAV"
#define MAX_PATH 4096
#define TEMP_AUDIO_FILE_SIZE 42
#define TEMP_PCM_FILE_SIZE 42
#define AUDIO_SAMPLE_RATE 32000  // TAD audio sample rate
#define MAX_SUBTITLE_LENGTH 2048
#define TAV_PACKET_SUBTITLE_TC 0x31  // Subtitle packet with timecode (SSF-TC format)
#define TAV_PACKET_SSF 0x30          // SSF packet (for font ROM)
#define TAV_PACKET_EXTENDED_HDR 0xEF // Extended header packet
#define FONTROM_OPCODE_LOW 0x80      // Low font ROM opcode
#define FONTROM_OPCODE_HIGH 0x81     // High font ROM opcode
#define MAX_FONTROM_SIZE 1920        // Max font ROM size in bytes

// Quality level to quantiser mapping (must match library tables)
static const int QUALITY_Y[] = {79, 47, 23, 11, 5, 2};   // Quality levels 0-5
static const int QUALITY_CO[] = {123, 108, 91, 76, 59, 29};
static const int QUALITY_CG[] = {148, 133, 113, 99, 76, 39};
static const float DEAD_ZONE_THRESHOLD[] = {1.5f, 1.5f, 1.2f, 1.1f, 0.8f, 0.6f, 0.0f};

static char TEMP_AUDIO_FILE[TEMP_AUDIO_FILE_SIZE];
static char TEMP_PCM_FILE[TEMP_PCM_FILE_SIZE];

// =============================================================================
// Subtitle Structures
// =============================================================================

typedef struct subtitle_entry {
    int start_frame;
    int end_frame;
    uint64_t start_time_ns;   // Start time in nanoseconds
    uint64_t end_time_ns;     // End time in nanoseconds
    char *text;
    struct subtitle_entry *next;
} subtitle_entry_t;

// =============================================================================
// CLI Context
// =============================================================================

typedef struct {
    // Input/output
    char *input_file;
    char *output_file;
    FILE *output_fp;

    // Video parameters (from library params)
    tav_encoder_params_t enc_params;

    // FFmpeg subprocess
    FILE *ffmpeg_pipe;
    int original_width, original_height;
    int original_fps_num, original_fps_den;

    // Encoding state
    int64_t frame_count;
    int64_t gop_count;
    size_t total_bytes;
    time_t start_time;

    // GOP frame buffer (for tav_encoder_encode_gop())
    uint8_t **gop_frames;         // Array of frame pointers [gop_size]
    int gop_frame_count;          // Number of frames in current GOP
    int *gop_frame_numbers;       // Frame numbers for timecodes [gop_size]

    // CLI options
    int verbose;
    int encode_limit;  // Max frames to encode (0=all)
    char *subtitle_file;
    char *fontrom_low;
    char *fontrom_high;
    int separate_audio_track;
    int use_native_audio;  // PCM8 instead of TAD

    // Audio encoding
    int has_audio;
    int audio_quality;           // TAD quality level (0-5)
    FILE *pcm_file;              // Extracted PCM32f audio file
    float *audio_buffer;         // Audio sample buffer (per-frame)
    size_t audio_buffer_size;    // Buffer size in samples per channel
    int samples_per_frame;       // Audio samples per video frame
    size_t audio_remaining;      // Remaining bytes in PCM file
    float *gop_audio_buffer;     // GOP audio accumulation buffer
    size_t gop_audio_samples;    // Accumulated audio samples for current GOP

    // Subtitle processing
    subtitle_entry_t *subtitles;

    // Extended Header support
    char *ffmpeg_version;        // FFmpeg version string (first line of "ffmpeg -version")
    uint64_t creation_time_us;   // Creation time in microseconds since UNIX Epoch (UTC)
    long extended_header_offset; // File offset for updating ENDT value at end
    int suppress_xhdr;           // If 1, don't write Extended Header

    // Multithreading
    int num_threads;             // 0 = single-threaded, 1+ = num worker threads
    gop_job_t *gop_jobs;         // Array of GOP job slots [num_threads]
    pthread_t *worker_threads;   // Array of worker thread handles [num_threads]
    pthread_mutex_t job_mutex;   // Mutex for job slot access
    pthread_cond_t job_ready;    // Signal when a job slot is ready for encoding
    pthread_cond_t job_complete; // Signal when a job slot is complete
    volatile int shutdown_workers; // 1 when workers should exit

} cli_context_t;

// =============================================================================
// Utility Functions
// =============================================================================

static void generate_random_filename(char *filename) {
    static int seeded = 0;
    if (!seeded) {
        srand(time(NULL));
        seeded = 1;
    }

    const char charset[] = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const int charset_size = sizeof(charset) - 1;

    strcpy(filename, "/tmp/");
    for (int i = 0; i < 32; i++) {
        filename[5 + i] = charset[rand() % charset_size];
    }
    filename[37] = '\0';
}

/**
 * Execute command and capture its output.
 * Returns dynamically allocated string that caller must free(), or NULL on error.
 */
static char* execute_command(const char* command) {
    FILE* pipe = popen(command, "r");
    if (!pipe) return NULL;

    size_t buffer_size = 4096;
    char* buffer = malloc(buffer_size);
    if (!buffer) {
        pclose(pipe);
        return NULL;
    }

    size_t total_size = 0;
    size_t bytes_read;

    while ((bytes_read = fread(buffer + total_size, 1, buffer_size - total_size - 1, pipe)) > 0) {
        total_size += bytes_read;
        if (total_size + 1 >= buffer_size) {
            buffer_size *= 2;
            char* new_buffer = realloc(buffer, buffer_size);
            if (!new_buffer) {
                free(buffer);
                pclose(pipe);
                return NULL;
            }
            buffer = new_buffer;
        }
    }

    buffer[total_size] = '\0';
    pclose(pipe);
    return buffer;
}

/**
 * Get FFmpeg version string (first line of "ffmpeg -version").
 * Returns dynamically allocated string that caller must free(), or NULL on error.
 */
static char* get_ffmpeg_version(void) {
    char *output = execute_command("ffmpeg -version 2>&1 | head -1");
    if (!output) return NULL;

    // Trim trailing newline/carriage return
    size_t len = strlen(output);
    while (len > 0 && (output[len-1] == '\n' || output[len-1] == '\r')) {
        output[len-1] = '\0';
        len--;
    }

    return output;  // Caller must free
}

/**
 * Get number of available CPU cores.
 * Returns the number of online processors, or 1 on error.
 */
static int get_available_cpus(void) {
#ifdef _SC_NPROCESSORS_ONLN
    long nproc = sysconf(_SC_NPROCESSORS_ONLN);
    if (nproc > 0) {
        return (int)nproc;
    }
#endif
    return 1;  // Fallback to single core
}

/**
 * Get default thread count: min(8, available_cpus)
 */
static int get_default_thread_count(void) {
    int available = get_available_cpus();
    return available < 8 ? available : 8;
}

static void print_usage(const char *program) {
    printf("TAV Encoder - TSVM Advanced Video Codec (Reference Implementation)\n");
    printf("\nUsage: %s -i input.mp4 -o output.tav [options]\n\n", program);
    printf("Required:\n");
    printf("  -i, --input FILE         Input video file\n");
    printf("  -o, --output FILE        Output TAV file\n");
    printf("\nVideo Options:\n");
    printf("  -s, --size WxH           Frame size (auto-detected if omitted)\n");
    printf("  -f, --fps NUM/DEN        Framerate (e.g., 60/1, 30000/1001)\n");
    printf("  -q, --quality N          Quality level 0-5 (default: 3)\n");
    printf("  -Q, --quantiser Y,Co,Cg  Custom quantisers (advanced)\n");
    printf("  -w, --wavelet N          Spatial wavelet: 0=5/3, 1=9/7 (default), 2=13/7, 16=DD-4, 255=Haar\n");
    printf("  --temporal-wavelet N     Temporal wavelet: 0=Haar (default), 1=CDF 5/3\n");
    printf("  -c, --colour-space N     Colour space: 0=YCoCg-R (default), 1=ICtCp\n");
    printf("  --decomp-levels N        Spatial DWT levels (0=auto, default: 6)\n");
    printf("  --temporal-levels N      Temporal DWT levels (0=auto, default: 2)\n");
    printf("\nGOP Options:\n");
    printf("  --temporal-dwt           Enable 3D DWT GOP encoding (default)\n");
    printf("  --intra-only             Disable temporal compression (I-frames only)\n");
    printf("  --gop-size N             GOP size 8/16/24 (default: 24)\n");
    printf("  --single-pass            Disable scene change detection\n");
    printf("\nPerformance:\n");
    printf("  -t, --threads N          Parallel encoding threads (default: min(8, available CPUs))\n");
    printf("                           0 or 1 = single-threaded, 2-16 = multithreaded\n");
    printf("                           Each thread encodes one GOP independently\n");
//    printf("\nTiling:\n");
//    printf("  --monoblock              Force single-tile mode (auto-disabled for > %dx%d)\n",
//           TAV_MONOBLOCK_MAX_WIDTH, TAV_MONOBLOCK_MAX_HEIGHT);
//    printf("  --tiled                  Force multi-tile mode (Padded Tiling)\n");
    printf("\nCompression:\n");
    printf("  --zstd-level N           Zstd level 3-22 (default: 7)\n");
    printf("  --no-perceptual-tuning   Disable HVS perceptual quantization\n");
    printf("  --no-dead-zone           Disable dead-zone quantization\n");
    printf("  --dead-zone-threshold N  Dead-zone threshold 1-10 (default: 0=disabled)\n");
    printf("  Note: EZBC entropy coder is always used (Twobitmap deprecated)\n");
    printf("\nEncoder Presets:\n");
    printf("  --preset-sports          Sports mode (finer temporal quantization)\n");
    printf("  --preset-anime           Anime mode (disable grain)\n");
    printf("\nAudio:\n");
    printf("  --tad-audio              Use TAD audio codec (default)\n");
    printf("  --pcm8-audio             Use native PCM8 audio\n");
    printf("  --audio-quality N        TAD audio quality 0-5 (default: matches video -q)\n");
    printf("  --no-audio               Disable audio encoding\n");
    printf("  --separate-audio-track   Multiplex audio as separate track\n");
    printf("\nMisc:\n");
    printf("  --encode-limit N         Encode only first N frames\n");
    printf("  --subtitle FILE          Add subtitle track (.srt)\n");
    printf("  --fontrom-low FILE       Font ROM for low ASCII (.chr)\n");
    printf("  --fontrom-high FILE      Font ROM for high ASCII (.chr)\n");
    printf("  --suppress-xhdr          Suppress Extended Header packet (enabled by default)\n");
    printf("  -v, --verbose            Verbose output\n");
    printf("  --help                   Show this help\n");
    printf("\nExamples:\n");
    printf("  # Basic encoding\n");
    printf("  %s -i video.mp4 -o out.tav -q 3\n\n", program);
    printf("  # High quality with CDF 5/3 wavelet\n");
    printf("  %s -i video.mp4 -o out.tav -q 5 -w 0\n\n", program);
    printf("  # Sports mode with larger GOP\n");
    printf("  %s -i video.mp4 -o out.tav --preset-sports --gop-size 24\n\n", program);
    printf("  # Advanced: separate quantiser per channel\n");
    printf("  %s -i video.mp4 -o out.tav -Q 3,5,6\n\n", program);
    printf("  # Multithreaded encoding with 4 threads\n");
    printf("  %s -i video.mp4 -o out.tav -t 4 -q 3\n", program);
}

// =============================================================================
// FFmpeg Integration
// =============================================================================

/**
 * Probe video file to get resolution and framerate using FFmpeg.
 */
static int get_video_info(const char *input_file, int *width, int *height,
                         int *fps_num, int *fps_den) {
    char cmd[MAX_PATH * 2];
    snprintf(cmd, sizeof(cmd),
             "ffprobe -v error -select_streams v:0 "
             "-show_entries stream=width,height,r_frame_rate "
             "-of default=noprint_wrappers=1:nokey=1 \"%s\"",
             input_file);

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        fprintf(stderr, "Error: Failed to run ffprobe\n");
        return -1;
    }

    if (fscanf(fp, "%d\n%d\n", width, height) != 2) {
        fprintf(stderr, "Error: Failed to parse video dimensions\n");
        pclose(fp);
        return -1;
    }

    char fps_str[64];
    if (fgets(fps_str, sizeof(fps_str), fp) == NULL) {
        fprintf(stderr, "Error: Failed to parse framerate\n");
        pclose(fp);
        return -1;
    }

    // Parse framerate (format: "num/den" or "num")
    if (sscanf(fps_str, "%d/%d", fps_num, fps_den) != 2) {
        if (sscanf(fps_str, "%d", fps_num) == 1) {
            *fps_den = 1;
        } else {
            fprintf(stderr, "Error: Failed to parse framerate: %s\n", fps_str);
            pclose(fp);
            return -1;
        }
    }

    pclose(fp);
    return 0;
}

/**
 * Open FFmpeg pipe for reading RGB24 frames.
 */
static FILE* open_ffmpeg_pipe(const char *input_file, int width, int height) {
    char cmd[MAX_PATH * 2];
    snprintf(cmd, sizeof(cmd),
             "ffmpeg -hide_banner -v quiet -i \"%s\" -f rawvideo -pix_fmt rgb24 -vf \"scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d\" -",
             input_file, width, height, width, height);

    FILE *fp = popen(cmd, "r");
    if (!fp) {
        fprintf(stderr, "Error: Failed to start FFmpeg\n");
        return NULL;
    }

    return fp;
}

/**
 * Read one RGB24 frame from FFmpeg pipe.
 * Returns 1 on success, 0 on EOF, -1 on error.
 */
static int read_rgb_frame(FILE *fp, uint8_t *rgb_frame, size_t frame_size) {
    size_t bytes_read = fread(rgb_frame, 1, frame_size, fp);

    if (bytes_read == 0) {
        return feof(fp) ? 0 : -1;  // EOF or error
    }

    if (bytes_read != frame_size) {
        fprintf(stderr, "Warning: Incomplete frame read (%zu/%zu bytes)\n",
                bytes_read, frame_size);
        return -1;
    }

    return 1;
}

// =============================================================================
// TAV File Format Writing
// =============================================================================

/**
 * Write TAV file header.
 */
static int write_tav_header(FILE *fp, const tav_encoder_params_t *params, int has_audio, int has_subtitles) {
    // Magic (8 bytes: \x1FTSVMTAV)
    fwrite(TAV_MAGIC, 1, 8, fp);

    // Version (1 byte) - calculate based on params
    // Version encoding (monoblock mode always used):
    //   3 = YCoCg-R monoblock uniform
    //   4 = ICtCp monoblock uniform
    //   5 = YCoCg-R monoblock perceptual
    //   6 = ICtCp monoblock perceptual
    //   Add 8 if using CDF 5/3 temporal wavelet
    uint8_t version;
    if (params->monoblock) {
        if (params->perceptual_tuning) {
            // Monoblock perceptual: version 5 (YCoCg-R) or 6 (ICtCp)
            version = params->channel_layout ? 6 : 5;
        } else {
            // Monoblock uniform: version 3 (YCoCg-R) or 4 (ICtCp)
            version = params->channel_layout ? 4 : 3;
        }
    } else {
        if (params->perceptual_tuning) {
            // Tiled perceptual: version 7 (YCoCg-R) or 8 (ICtCp)
            version = params->channel_layout ? 7 : 8;
        } else {
            // Tiled uniform: version 1 (YCoCg-R) or 2 (ICtCp)
            version = params->channel_layout ? 1 : 2;
        }
    }
    // Add 8 if using CDF 5/3 temporal wavelet
    if (params->enable_temporal_dwt && params->temporal_wavelet == 0) {
        version += 8;
    }
    fputc(version, fp);

    // Width (uint16_t, 2 bytes)
    // Write 0 if width exceeds 65535 (extended dimensions will be in XDIM)
    uint16_t width = (params->width > 65535) ? 0 : (uint16_t)params->width;
    fwrite(&width, sizeof(uint16_t), 1, fp);

    // Height (uint16_t, 2 bytes)
    // Write 0 if height exceeds 65535 (extended dimensions will be in XDIM)
    uint16_t height = (params->height > 65535) ? 0 : (uint16_t)params->height;
    fwrite(&height, sizeof(uint16_t), 1, fp);

    // FPS (uint8_t, 1 byte) - simplified to just fps_num
    uint8_t fps = (uint8_t)params->fps_num;
    fputc(fps, fp);

    // Total frames (uint32_t, 4 bytes) - will be updated later
    uint32_t total_frames = 0;
    fwrite(&total_frames, sizeof(uint32_t), 1, fp);

    // Wavelet filter (uint8_t, 1 byte)
    fputc((uint8_t)params->wavelet_type, fp);

    // Decomp levels (uint8_t, 1 byte)
    fputc((uint8_t)params->decomp_levels, fp);

    // Quantisers (3 bytes: Y, Co, Cg)
    fputc((uint8_t)params->quantiser_y, fp);
    fputc((uint8_t)params->quantiser_co, fp);
    fputc((uint8_t)params->quantiser_cg, fp);

    // Extra flags (uint8_t, 1 byte)
    uint8_t extra_flags = 0;
    if (has_audio) extra_flags |= 0x01;        // Bit 0: has audio
    if (has_subtitles) extra_flags |= 0x02;     // Bit 1: has subtitles
    fputc(extra_flags, fp);

    // Video flags (uint8_t, 1 byte)
    uint8_t video_flags = 0;  // Progressive, non-NTSC, lossy
    fputc(video_flags, fp);

    // Quality level (uint8_t, 1 byte)
    uint8_t quality_level = params->quality_level + 1;
    fputc(quality_level, fp);

    // Channel layout (uint8_t, 1 byte)
    fputc((uint8_t)params->channel_layout, fp);

    // Entropy coder (uint8_t, 1 byte): 0=Twobitmap, 1=EZBC
    fputc((uint8_t)params->entropy_coder, fp);

    // Encoder preset (uint8_t, 1 byte)
    fputc((uint8_t)params->encoder_preset, fp);

    // Reserved (uint8_t, 1 byte)
    fputc(0, fp);

    // Device orientation (uint8_t, 1 byte)
    fputc(0, fp);

    // File role (uint8_t, 1 byte)
    fputc(0, fp);

    return 0;
}

/**
 * Write Extended Header packet (0xEF) with metadata.
 * Returns the file offset of the ENDT value for later update, or -1 on error.
 */
static long write_extended_header(cli_context_t *cli, int width, int height) {
    FILE *fp = cli->output_fp;

    // Write packet type (0xEF)
    uint8_t packet_type = TAV_PACKET_EXTENDED_HDR;
    if (fwrite(&packet_type, 1, 1, fp) != 1) return -1;

    // Count key-value pairs: BGNT, ENDT, CDAT, VNDR, optionally FMPG, and optionally XDIM
    int has_xdim = (width > 65535 || height > 65535);
    uint16_t num_pairs = 4;  // BGNT, ENDT, CDAT, VNDR
    if (cli->ffmpeg_version) num_pairs++;  // FMPG
    if (has_xdim) num_pairs++;  // XDIM
    if (fwrite(&num_pairs, sizeof(uint16_t), 1, fp) != 1) return -1;

    // Helper macros for writing key-value pairs
    #define WRITE_KV_UINT64(key_str, value) do { \
        if (fwrite(key_str, 1, 4, fp) != 4) return -1; \
        uint8_t value_type = 0x04; /* Uint64 */ \
        if (fwrite(&value_type, 1, 1, fp) != 1) return -1; \
        uint64_t val = (value); \
        if (fwrite(&val, sizeof(uint64_t), 1, fp) != 1) return -1; \
    } while(0)

    #define WRITE_KV_BYTES(key_str, data, len) do { \
        if (fwrite(key_str, 1, 4, fp) != 4) return -1; \
        uint8_t value_type = 0x10; /* Bytes */ \
        if (fwrite(&value_type, 1, 1, fp) != 1) return -1; \
        uint16_t length = (len); \
        if (fwrite(&length, sizeof(uint16_t), 1, fp) != 1) return -1; \
        if (fwrite((data), 1, (len), fp) != (len)) return -1; \
    } while(0)

    // BGNT: Video begin time (0 nanoseconds for frame 0)
    WRITE_KV_UINT64("BGNT", 0ULL);

    // ENDT: Video end time (placeholder, will be updated at end)
    // Save the file offset of the ENDT value (after key + type byte)
    long endt_offset = ftell(fp) + 4 + 1;  // 4 bytes for "ENDT", 1 byte for type
    WRITE_KV_UINT64("ENDT", 0ULL);

    // CDAT: Creation time in microseconds since UNIX Epoch (UTC)
    WRITE_KV_UINT64("CDAT", cli->creation_time_us);

    // VNDR: Encoder name and version
    const char *vendor_str = "Encoder-TAV 20251208 (reference)";
    WRITE_KV_BYTES("VNDR", vendor_str, strlen(vendor_str));

    // FMPG: FFmpeg version (if available)
    if (cli->ffmpeg_version) {
        WRITE_KV_BYTES("FMPG", cli->ffmpeg_version, strlen(cli->ffmpeg_version));
    }

    // XDIM: Extended dimensions (if width or height exceeds 65535)
    if (has_xdim) {
        char xdim_str[32];
        snprintf(xdim_str, sizeof(xdim_str), "%d,%d", width, height);
        WRITE_KV_BYTES("XDIM", xdim_str, strlen(xdim_str));
    }

    #undef WRITE_KV_UINT64
    #undef WRITE_KV_BYTES

    return endt_offset;
}

/**
 * Update ENDT value in Extended Header.
 * Seeks to the stored offset and updates the uint64_t ENDT value.
 */
static int update_extended_header_endt(FILE *fp, long endt_offset, uint64_t end_time_ns) {
    if (endt_offset < 0) return -1;  // Extended Header not written

    long current_pos = ftell(fp);
    if (current_pos < 0) return -1;

    // Seek to ENDT value offset
    if (fseek(fp, endt_offset, SEEK_SET) != 0) return -1;

    // Write ENDT value
    if (fwrite(&end_time_ns, sizeof(uint64_t), 1, fp) != 1) {
        fseek(fp, current_pos, SEEK_SET);
        return -1;
    }

    // Restore file position
    if (fseek(fp, current_pos, SEEK_SET) != 0) return -1;

    return 0;
}

/**
 * Update total frames in header.
 * Seeks back to offset 14 and updates the uint32_t total_frames field.
 */
static int update_total_frames(FILE *fp, uint32_t total_frames) {
    long current_pos = ftell(fp);
    if (current_pos < 0) {
        return -1;
    }

    // Seek to total_frames field (offset 14: magic(8) + version(1) + width(2) + height(2) + fps(1))
    if (fseek(fp, 14, SEEK_SET) != 0) {
        return -1;
    }

    // Write total frames
    fwrite(&total_frames, sizeof(uint32_t), 1, fp);

    // Seek back to original position
    if (fseek(fp, current_pos, SEEK_SET) != 0) {
        return -1;
    }

    return 0;
}

/**
 * Write TAV packet to file.
 */
static int write_tav_packet(FILE *fp, const tav_encoder_packet_t *packet) {
    if (!packet || !packet->data) {
        return -1;
    }

    // Packet is already formatted: [type(1)][size(4)][data(N)]
    // Or: [type(1)][gop_size(1)][size(4)][data(N)] for GOP packets
    size_t written = fwrite(packet->data, 1, packet->size, fp);

    if (written != packet->size) {
        fprintf(stderr, "Error: Failed to write packet (%zu/%zu bytes)\n",
                written, packet->size);
        return -1;
    }

    return 0;
}

/**
 * Write timecode packet.
 * Format: [type(1)][timecode_ns(8)] where timecode_ns is uint64_t in nanoseconds
 */
static int write_timecode_packet(FILE *fp, int64_t frame_number, int fps_num, int fps_den) {
    uint8_t packet[9];
    packet[0] = TAV_PACKET_TIMECODE;

    // Convert frame number to nanoseconds
    // timecode_ns = (frame_number * fps_den * 1000000000) / fps_num
    uint64_t timecode_ns = ((uint64_t)frame_number * (uint64_t)fps_den * 1000000000ULL) / (uint64_t)fps_num;
    memcpy(packet + 1, &timecode_ns, 8);

    fwrite(packet, 1, 9, fp);
    return 0;
}

/**
 * Write GOP sync packet.
 * Format: [type(1)][frame_count(1)]
 */
static int write_gop_sync_packet(FILE *fp, int frame_count) {
    uint8_t packet[2];
    packet[0] = TAV_PACKET_GOP_SYNC;
    packet[1] = (uint8_t)frame_count;

    fwrite(packet, 1, 2, fp);
    return 0;
}

/**
 * Write sync packet (0xFF) for intra-only mode.
 * Format: [type(1)] (no payload)
 */
static int write_sync_packet(FILE *fp) {
    uint8_t packet = TAV_PACKET_SYNC;
    fwrite(&packet, 1, 1, fp);
    return 0;
}

// =============================================================================
// Audio Encoding Functions
// =============================================================================

/**
 * Extract audio from video file to PCM32f stereo at 32kHz.
 * Uses FFmpeg with high-quality resampling and highpass filter.
 */
static int extract_audio_to_file(const char *input_file, const char *output_file) {
    char cmd[MAX_PATH * 2];
    snprintf(cmd, sizeof(cmd),
             "ffmpeg -hide_banner -v quiet -i \"%s\" -f f32le -acodec pcm_f32le -ar %d -ac 2 "
             "-af \"aresample=resampler=soxr:precision=28:cutoff=0.99:dither_scale=0,highpass=f=16\" "
             "-y \"%s\" 2>/dev/null",
             input_file, AUDIO_SAMPLE_RATE, output_file);

    int result = system(cmd);
    if (result != 0) {
        fprintf(stderr, "Warning: FFmpeg audio extraction failed\n");
        return 0;
    }

    // Check if output file exists and has content
    struct stat st;
    if (stat(output_file, &st) != 0 || st.st_size == 0) {
        return 0;
    }

    return 1;
}

/**
 * Read audio samples for one frame from PCM file.
 * Returns number of samples actually read.
 */
static size_t read_audio_samples(cli_context_t *cli, float *buffer, size_t samples_to_read) {
    if (!cli->pcm_file || cli->audio_remaining == 0) {
        return 0;
    }

    // Calculate bytes to read (stereo float32)
    size_t bytes_to_read = samples_to_read * 2 * sizeof(float);
    if (bytes_to_read > cli->audio_remaining) {
        bytes_to_read = cli->audio_remaining;
        samples_to_read = bytes_to_read / (2 * sizeof(float));
    }

    size_t bytes_read = fread(buffer, 1, bytes_to_read, cli->pcm_file);
    cli->audio_remaining -= bytes_read;

    return bytes_read / (2 * sizeof(float));
}

/**
 * Encode and write TAD audio packet.
 * Format per terranmon.txt:
 *   uint8  Packet Type (0x24)
 *   <header for decoding packet>
 *   uint16 Sample Count
 *   uint32 Compressed Size + 7
 *   <header for decoding TAD chunk>
 *   uint16 Sample Count
 *   uint8  Quantiser Bits
 *   uint32 Compressed Size
 *   *      Zstd-compressed TAD
 */
static int write_audio_packet(FILE *fp, cli_context_t *cli, float *pcm_samples, size_t num_samples) {
    if (num_samples == 0) {
        return 0;
    }

    // Allocate buffer for TAD-encoded data
    size_t max_output_size = num_samples * 4 * sizeof(float) + 1024;
    uint8_t *tad_buffer = malloc(max_output_size);
    if (!tad_buffer) {
        fprintf(stderr, "Error: Cannot allocate TAD buffer\n");
        return -1;
    }

    // Encode with TAD (returns: sample_count(2) + max_index(1) + payload_size(4) + payload)
    int max_index = tad32_quality_to_max_index(cli->audio_quality);
    size_t tad_chunk_size = tad32_encode_chunk(pcm_samples, num_samples, max_index, 1.0f, tad_buffer);

    if (tad_chunk_size == 0) {
        fprintf(stderr, "Error: TAD encoding failed\n");
        free(tad_buffer);
        return -1;
    }

    // Extract TAD chunk header
    uint16_t sample_count;
    uint8_t quantiser_bits;
    uint32_t compressed_size;
    memcpy(&sample_count, tad_buffer, 2);
    memcpy(&quantiser_bits, tad_buffer + 2, 1);
    memcpy(&compressed_size, tad_buffer + 3, 4);

    // Write TAV packet header
    fputc(TAV_PACKET_AUDIO_TAD, fp);                        // Packet type (0x24)
    fwrite(&sample_count, 2, 1, fp);                         // Sample count
    uint32_t packet_payload_size = compressed_size + 7;      // TAD chunk size
    fwrite(&packet_payload_size, 4, 1, fp);                  // Compressed size + 7

    // Write TAD chunk (sample_count, quantiser_bits, compressed_size, payload)
    fwrite(tad_buffer, 1, tad_chunk_size, fp);

    free(tad_buffer);
    return 1 + 2 + 4 + tad_chunk_size;  // Total bytes written
}

// =============================================================================
// Subtitle Functions
// =============================================================================

/**
 * Convert SRT timestamp to nanoseconds.
 * Format: "HH:MM:SS,mmm" (e.g., "00:01:23,456")
 */
static uint64_t srt_time_to_ns(const char *time_str) {
    int hours = 0, minutes = 0, seconds = 0, milliseconds = 0;
    if (sscanf(time_str, "%d:%d:%d,%d", &hours, &minutes, &seconds, &milliseconds) != 4) {
        return 0;
    }

    uint64_t total_ns = 0;
    total_ns += (uint64_t)hours * 3600ULL * 1000000000ULL;
    total_ns += (uint64_t)minutes * 60ULL * 1000000000ULL;
    total_ns += (uint64_t)seconds * 1000000000ULL;
    total_ns += (uint64_t)milliseconds * 1000000ULL;

    return total_ns;
}

/**
 * Parse SRT subtitle file.
 * Returns linked list of subtitle entries, or NULL on error.
 */
static subtitle_entry_t* parse_srt_file(const char *filename) {
    FILE *file = fopen(filename, "r");
    if (!file) {
        fprintf(stderr, "Failed to open subtitle file: %s\n", filename);
        return NULL;
    }

    subtitle_entry_t *head = NULL;
    subtitle_entry_t *tail = NULL;
    char line[1024];
    int state = 0;  // 0=index, 1=time, 2=text, 3=blank

    subtitle_entry_t *current_entry = NULL;
    char *text_buffer = NULL;
    size_t text_buffer_size = 0;

    while (fgets(line, sizeof(line), file)) {
        // Remove trailing newline/carriage return
        size_t len = strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) {
            line[--len] = '\0';
        }

        if (state == 0) {  // Expecting subtitle index
            if (strlen(line) == 0) continue;  // Skip empty lines
            current_entry = calloc(1, sizeof(subtitle_entry_t));
            if (!current_entry) break;
            state = 1;
        } else if (state == 1) {  // Expecting time range
            char start_time[32], end_time[32];
            if (sscanf(line, "%31s --> %31s", start_time, end_time) == 2) {
                current_entry->start_time_ns = srt_time_to_ns(start_time);
                current_entry->end_time_ns = srt_time_to_ns(end_time);

                if (current_entry->start_time_ns == 0 && current_entry->end_time_ns == 0) {
                    free(current_entry);
                    current_entry = NULL;
                    state = 3;  // Skip to next blank line
                    continue;
                }

                // Initialize text buffer
                text_buffer_size = 256;
                text_buffer = malloc(text_buffer_size);
                if (!text_buffer) {
                    free(current_entry);
                    current_entry = NULL;
                    break;
                }
                text_buffer[0] = '\0';
                state = 2;
            } else {
                free(current_entry);
                current_entry = NULL;
                state = 3;  // Skip malformed entry
            }
        } else if (state == 2) {  // Collecting subtitle text
            if (strlen(line) == 0) {
                // End of subtitle text
                current_entry->text = strdup(text_buffer);
                free(text_buffer);
                text_buffer = NULL;

                // Add to list
                if (!head) {
                    head = current_entry;
                    tail = current_entry;
                } else {
                    tail->next = current_entry;
                    tail = current_entry;
                }
                current_entry = NULL;
                state = 0;
            } else {
                // Append text line
                size_t current_len = strlen(text_buffer);
                size_t line_len = strlen(line);
                size_t needed = current_len + line_len + 2;  // +2 for newline and null

                if (needed > text_buffer_size) {
                    text_buffer_size = needed + 256;
                    char *new_buffer = realloc(text_buffer, text_buffer_size);
                    if (!new_buffer) {
                        free(text_buffer);
                        free(current_entry);
                        current_entry = NULL;
                        break;
                    }
                    text_buffer = new_buffer;
                }

                if (current_len > 0) {
                    strcat(text_buffer, "\n");
                }
                strcat(text_buffer, line);
            }
        } else if (state == 3) {  // Skipping to next blank line
            if (strlen(line) == 0) {
                state = 0;
            }
        }
    }

    // Handle last subtitle if file ended while collecting text
    if (state == 2 && current_entry && text_buffer) {
        current_entry->text = strdup(text_buffer);
        free(text_buffer);
        text_buffer = NULL;

        // Add to list
        if (!head) {
            head = current_entry;
            tail = current_entry;
        } else {
            tail->next = current_entry;
            tail = current_entry;
        }
        current_entry = NULL;
    } else if (current_entry) {
        // Cleanup any incomplete entry
        free(current_entry);
        if (text_buffer) free(text_buffer);
    }

    fclose(file);
    return head;
}

/**
 * Free subtitle list.
 */
static void free_subtitle_list(subtitle_entry_t *list) {
    while (list) {
        subtitle_entry_t *next = list->next;
        free(list->text);
        free(list);
        list = next;
    }
}

/**
 * Write subtitle packet in SSF-TC format.
 * Packet structure:
 *   uint8  Packet Type (0x31)
 *   uint32 Packet Size
 *   uint24 Subtitle Index (little-endian, always 0 for now)
 *   uint64 Timecode (nanoseconds, little-endian)
 *   uint8  Opcode (0x01=show, 0x02=hide)
 *   char[] Text (null-terminated, empty for hide)
 */
static int write_subtitle_packet(FILE *fp, uint64_t timecode_ns, uint8_t opcode, const char *text) {
    // Calculate packet size: index (3) + timecode (8) + opcode (1) + text + null
    size_t text_len = text ? strlen(text) : 0;
    size_t packet_size = 3 + 8 + 1 + text_len + 1;

    // Write packet type and size
    fputc(TAV_PACKET_SUBTITLE_TC, fp);
    uint32_t size32 = (uint32_t)packet_size;
    fwrite(&size32, 4, 1, fp);

    // Write subtitle index (24-bit, little-endian) - always 0
    uint8_t index_bytes[3] = {0, 0, 0};
    fwrite(index_bytes, 3, 1, fp);

    // Write timecode (64-bit, little-endian)
    uint8_t timecode_bytes[8];
    for (int i = 0; i < 8; i++) {
        timecode_bytes[i] = (timecode_ns >> (i * 8)) & 0xFF;
    }
    fwrite(timecode_bytes, 8, 1, fp);

    // Write opcode
    fputc(opcode, fp);

    // Write text if present
    if (text && text_len > 0) {
        fwrite(text, 1, text_len, fp);
    }

    // Write null terminator
    fputc(0, fp);

    return 1 + 4 + (int)packet_size;  // Total bytes written
}

/**
 * Write all subtitles upfront in SSF-TC format.
 * Each subtitle generates two packets: show and hide events.
 */
static int write_all_subtitles(FILE *fp, subtitle_entry_t *subtitles, int verbose) {
    if (!subtitles) return 0;

    int bytes_written = 0;
    int subtitle_count = 0;

    subtitle_entry_t *sub = subtitles;
    while (sub) {
        // Write show subtitle event (opcode 0x01)
        bytes_written += write_subtitle_packet(fp, sub->start_time_ns, 0x01, sub->text);

        // Write hide subtitle event (opcode 0x02)
        bytes_written += write_subtitle_packet(fp, sub->end_time_ns, 0x02, NULL);

        subtitle_count++;
        if (verbose) {
            printf("  Subtitle %d: show at %.3fs, hide at %.3fs: %.50s%s\n",
                   subtitle_count,
                   sub->start_time_ns / 1000000000.0,
                   sub->end_time_ns / 1000000000.0,
                   sub->text, strlen(sub->text) > 50 ? "..." : "");
        }

        sub = sub->next;
    }

    if (verbose && subtitle_count > 0) {
        printf("Wrote %d SSF-TC subtitle events (%d bytes)\n", subtitle_count * 2, bytes_written);
    }

    return bytes_written;
}

// =============================================================================
// Font ROM Functions
// =============================================================================

/**
 * Write font ROM packet in SSF format.
 * Packet structure:
 *   uint8  Packet Type (0x30 - SSF)
 *   uint32 Packet Size
 *   uint24 Index (3 bytes, always 0 for font ROM)
 *   uint8  Opcode (0x80=low font ROM, 0x81=high font ROM)
 *   uint16 Payload Length
 *   uint8[] Font data (up to 1920 bytes)
 *   uint8  Terminator (0x00)
 */
static int write_fontrom_packet(FILE *fp, const char *filename, uint8_t opcode, int verbose) {
    if (!filename || !fp) return 0;

    FILE *rom_file = fopen(filename, "rb");
    if (!rom_file) {
        fprintf(stderr, "Warning: Could not open font ROM file: %s\n", filename);
        return -1;
    }

    // Get file size
    fseek(rom_file, 0, SEEK_END);
    long file_size = ftell(rom_file);
    fseek(rom_file, 0, SEEK_SET);

    if (file_size > MAX_FONTROM_SIZE) {
        fprintf(stderr, "Warning: Font ROM file too large (max %d bytes): %s\n", MAX_FONTROM_SIZE, filename);
        fclose(rom_file);
        return -1;
    }

    // Read font data
    uint8_t *font_data = malloc(file_size);
    if (!font_data) {
        fprintf(stderr, "Error: Could not allocate memory for font ROM\n");
        fclose(rom_file);
        return -1;
    }

    size_t bytes_read = fread(font_data, 1, file_size, rom_file);
    fclose(rom_file);

    if (bytes_read != (size_t)file_size) {
        fprintf(stderr, "Warning: Could not read entire font ROM file: %s\n", filename);
        free(font_data);
        return -1;
    }

    // Calculate packet size: index(3) + opcode(1) + length(2) + data + terminator(1)
    uint32_t packet_size = 3 + 1 + 2 + file_size + 1;

    // Write packet type (0x30 - SSF)
    fputc(TAV_PACKET_SSF, fp);

    // Write packet size (uint32, little-endian)
    fputc(packet_size & 0xFF, fp);
    fputc((packet_size >> 8) & 0xFF, fp);
    fputc((packet_size >> 16) & 0xFF, fp);
    fputc((packet_size >> 24) & 0xFF, fp);

    // Write index (3 bytes, always 0 for font ROM)
    fputc(0, fp);
    fputc(0, fp);
    fputc(0, fp);

    // Write opcode
    fputc(opcode, fp);

    // Write payload length (uint16, little-endian)
    uint16_t payload_len = (uint16_t)file_size;
    fputc(payload_len & 0xFF, fp);
    fputc((payload_len >> 8) & 0xFF, fp);

    // Write font data
    fwrite(font_data, 1, file_size, fp);

    // Write terminator
    fputc(0x00, fp);

    free(font_data);

    if (verbose) {
        printf("  Font ROM uploaded: %s (%ld bytes, opcode 0x%02X)\n", filename, file_size, opcode);
    }

    return 1 + 4 + (int)packet_size;  // Total bytes written
}

// =============================================================================
// Worker Thread Functions
// =============================================================================

/**
 * Worker thread context - passed to worker_thread_main.
 */
typedef struct {
    cli_context_t *cli;
    int thread_id;
} worker_context_t;

/**
 * Worker thread main function.
 * Continuously picks up jobs from the job pool and encodes them.
 */
static void *worker_thread_main(void *arg) {
    worker_context_t *wctx = (worker_context_t *)arg;
    cli_context_t *cli = wctx->cli;
    (void)wctx->thread_id;  // Unused but kept for debugging

    while (1) {
        pthread_mutex_lock(&cli->job_mutex);

        // Wait for a job or shutdown signal
        while (!cli->shutdown_workers) {
            // Look for a job slot that is ready to encode
            int found_job = -1;
            for (int i = 0; i < cli->num_threads; i++) {
                if (cli->gop_jobs[i].status == GOP_SLOT_READY) {
                    cli->gop_jobs[i].status = GOP_SLOT_ENCODING;
                    found_job = i;
                    break;
                }
            }

            if (found_job >= 0) {
                pthread_mutex_unlock(&cli->job_mutex);

                // Encode this GOP
                gop_job_t *job = &cli->gop_jobs[found_job];

                // Create thread-local encoder context
                tav_encoder_context_t *ctx = tav_encoder_create(&job->params);
                if (!ctx) {
                    fprintf(stderr, "Failed to create encoder for GOP %d\n", job->gop_index);
                    job->success = 0;
                } else {
                    // Encode GOP
                    int result = tav_encoder_encode_gop(ctx,
                                                        (const uint8_t **)job->rgb_frames,
                                                        job->num_frames,
                                                        job->frame_numbers,
                                                        &job->packet);
                    job->success = (result == 1 && job->packet != NULL);
                    tav_encoder_free(ctx);
                }

                // Mark job as complete (reacquire lock for next iteration)
                pthread_mutex_lock(&cli->job_mutex);
                job->status = GOP_SLOT_COMPLETE;
                pthread_cond_broadcast(&cli->job_complete);
                // Keep lock held for next iteration of inner while loop
                continue;  // Look for more jobs
            }

            // No job found, wait for signal
            pthread_cond_wait(&cli->job_ready, &cli->job_mutex);
        }

        pthread_mutex_unlock(&cli->job_mutex);
        break;  // Shutdown
    }

    free(wctx);
    return NULL;
}

/**
 * Initialize multithreading resources.
 * Returns 0 on success, -1 on failure.
 */
static int init_threading(cli_context_t *cli) {
    if (cli->num_threads <= 0) {
        return 0;  // Single-threaded mode
    }

    // Initialize mutex and condition variables
    if (pthread_mutex_init(&cli->job_mutex, NULL) != 0) {
        fprintf(stderr, "Error: Failed to initialize job mutex\n");
        return -1;
    }
    if (pthread_cond_init(&cli->job_ready, NULL) != 0) {
        fprintf(stderr, "Error: Failed to initialize job_ready cond\n");
        pthread_mutex_destroy(&cli->job_mutex);
        return -1;
    }
    if (pthread_cond_init(&cli->job_complete, NULL) != 0) {
        fprintf(stderr, "Error: Failed to initialize job_complete cond\n");
        pthread_cond_destroy(&cli->job_ready);
        pthread_mutex_destroy(&cli->job_mutex);
        return -1;
    }

    // Allocate job slots (one per thread)
    cli->gop_jobs = calloc(cli->num_threads, sizeof(gop_job_t));
    if (!cli->gop_jobs) {
        fprintf(stderr, "Error: Failed to allocate job slots\n");
        pthread_cond_destroy(&cli->job_complete);
        pthread_cond_destroy(&cli->job_ready);
        pthread_mutex_destroy(&cli->job_mutex);
        return -1;
    }

    // Allocate worker thread handles
    cli->worker_threads = malloc(cli->num_threads * sizeof(pthread_t));
    if (!cli->worker_threads) {
        fprintf(stderr, "Error: Failed to allocate thread handles\n");
        free(cli->gop_jobs);
        pthread_cond_destroy(&cli->job_complete);
        pthread_cond_destroy(&cli->job_ready);
        pthread_mutex_destroy(&cli->job_mutex);
        return -1;
    }

    // Start worker threads
    cli->shutdown_workers = 0;
    for (int i = 0; i < cli->num_threads; i++) {
        worker_context_t *wctx = malloc(sizeof(worker_context_t));
        if (!wctx) {
            fprintf(stderr, "Error: Failed to allocate worker context\n");
            cli->shutdown_workers = 1;
            pthread_cond_broadcast(&cli->job_ready);
            for (int j = 0; j < i; j++) {
                pthread_join(cli->worker_threads[j], NULL);
            }
            free(cli->worker_threads);
            free(cli->gop_jobs);
            pthread_cond_destroy(&cli->job_complete);
            pthread_cond_destroy(&cli->job_ready);
            pthread_mutex_destroy(&cli->job_mutex);
            return -1;
        }
        wctx->cli = cli;
        wctx->thread_id = i;

        if (pthread_create(&cli->worker_threads[i], NULL, worker_thread_main, wctx) != 0) {
            fprintf(stderr, "Error: Failed to create worker thread %d\n", i);
            free(wctx);
            cli->shutdown_workers = 1;
            pthread_cond_broadcast(&cli->job_ready);
            for (int j = 0; j < i; j++) {
                pthread_join(cli->worker_threads[j], NULL);
            }
            free(cli->worker_threads);
            free(cli->gop_jobs);
            pthread_cond_destroy(&cli->job_complete);
            pthread_cond_destroy(&cli->job_ready);
            pthread_mutex_destroy(&cli->job_mutex);
            return -1;
        }
    }

    printf("Started %d worker threads for parallel GOP encoding\n", cli->num_threads);
    return 0;
}

/**
 * Shutdown multithreading resources.
 */
static void shutdown_threading(cli_context_t *cli) {
    if (cli->num_threads <= 0) {
        return;
    }

    // Signal workers to shutdown
    pthread_mutex_lock(&cli->job_mutex);
    cli->shutdown_workers = 1;
    pthread_cond_broadcast(&cli->job_ready);
    pthread_mutex_unlock(&cli->job_mutex);

    // Wait for all workers to finish
    for (int i = 0; i < cli->num_threads; i++) {
        pthread_join(cli->worker_threads[i], NULL);
    }

    // Free job slots (and any remaining resources)
    if (cli->gop_jobs) {
        for (int i = 0; i < cli->num_threads; i++) {
            if (cli->gop_jobs[i].packet) {
                tav_encoder_free_packet(cli->gop_jobs[i].packet);
            }
            // Note: rgb_frames should already be freed by now
        }
        free(cli->gop_jobs);
        cli->gop_jobs = NULL;
    }

    if (cli->worker_threads) {
        free(cli->worker_threads);
        cli->worker_threads = NULL;
    }

    pthread_cond_destroy(&cli->job_complete);
    pthread_cond_destroy(&cli->job_ready);
    pthread_mutex_destroy(&cli->job_mutex);
}

// =============================================================================
// Multithreaded Encoding Loop
// =============================================================================

/**
 * Multithreaded video encoding function.
 * Uses worker threads to encode GOPs in parallel.
 */
static int encode_video_mt(cli_context_t *cli) {
    printf("Opening FFmpeg pipe...\n");
    cli->ffmpeg_pipe = open_ffmpeg_pipe(cli->input_file,
                                        cli->enc_params.width,
                                        cli->enc_params.height);
    if (!cli->ffmpeg_pipe) {
        return -1;
    }

    // Create temporary encoder to get calculated params (decomp_levels, etc.)
    printf("Creating encoder context...\n");
    tav_encoder_context_t *ctx = tav_encoder_create(&cli->enc_params);
    if (!ctx) {
        fprintf(stderr, "Error: %s\n", "Failed to create encoder");
        pclose(cli->ffmpeg_pipe);
        return -1;
    }
    tav_encoder_get_params(ctx, &cli->enc_params);
    tav_encoder_free(ctx);
    ctx = NULL;

    // Initialize threading
    if (init_threading(cli) < 0) {
        pclose(cli->ffmpeg_pipe);
        return -1;
    }

    // Allocate per-job frame buffers
    size_t frame_size = cli->enc_params.width * cli->enc_params.height * 3;
    int gop_size = cli->enc_params.gop_size;
    if (!cli->enc_params.enable_temporal_dwt) {
        gop_size = 1;
    }

    // Allocate frame buffers for each job slot
    for (int slot = 0; slot < cli->num_threads; slot++) {
        cli->gop_jobs[slot].rgb_frames = malloc(gop_size * sizeof(uint8_t*));
        cli->gop_jobs[slot].frame_numbers = malloc(gop_size * sizeof(int));
        if (!cli->gop_jobs[slot].rgb_frames || !cli->gop_jobs[slot].frame_numbers) {
            fprintf(stderr, "Error: Failed to allocate job slot %d buffers\n", slot);
            shutdown_threading(cli);
            pclose(cli->ffmpeg_pipe);
            return -1;
        }
        for (int f = 0; f < gop_size; f++) {
            cli->gop_jobs[slot].rgb_frames[f] = malloc(frame_size);
            if (!cli->gop_jobs[slot].rgb_frames[f]) {
                fprintf(stderr, "Error: Failed to allocate frame buffer for slot %d\n", slot);
                shutdown_threading(cli);
                pclose(cli->ffmpeg_pipe);
                return -1;
            }
        }
        // Copy encoder params for thread safety
        cli->gop_jobs[slot].params = cli->enc_params;
        cli->gop_jobs[slot].status = GOP_SLOT_EMPTY;
        cli->gop_jobs[slot].num_frames = 0;
    }

    // Allocate audio buffers if needed
    if (cli->has_audio) {
        size_t max_gop_audio = gop_size * cli->samples_per_frame * 2;
        cli->gop_audio_buffer = malloc(max_gop_audio * sizeof(float));
        cli->gop_audio_samples = 0;
        if (!cli->gop_audio_buffer) {
            fprintf(stderr, "Error: Failed to allocate GOP audio buffer\n");
            shutdown_threading(cli);
            pclose(cli->ffmpeg_pipe);
            return -1;
        }

        // Allocate per-job audio buffers
        for (int slot = 0; slot < cli->num_threads; slot++) {
            cli->gop_jobs[slot].audio_samples = malloc(max_gop_audio * sizeof(float));
            if (!cli->gop_jobs[slot].audio_samples) {
                fprintf(stderr, "Error: Failed to allocate audio buffer for slot %d\n", slot);
                shutdown_threading(cli);
                pclose(cli->ffmpeg_pipe);
                return -1;
            }
        }
    }

    // Temporary frame buffer for reading
    uint8_t *rgb_frame = malloc(frame_size);
    if (!rgb_frame) {
        fprintf(stderr, "Error: Failed to allocate frame buffer\n");
        shutdown_threading(cli);
        pclose(cli->ffmpeg_pipe);
        return -1;
    }

    // Write TAV header
    write_tav_header(cli->output_fp, &cli->enc_params, cli->has_audio, cli->subtitles != NULL);

    // Write Extended Header (unless suppressed)
    if (!cli->suppress_xhdr) {
        cli->extended_header_offset = write_extended_header(cli, cli->enc_params.width, cli->enc_params.height);
        if (cli->extended_header_offset < 0) {
            fprintf(stderr, "Warning: Failed to write Extended Header\n");
        }
    }

    // Write subtitles upfront
    if (cli->subtitles) {
        printf("Writing subtitles...\n");
        write_all_subtitles(cli->output_fp, cli->subtitles, cli->verbose);
    }

    // Write font ROMs if provided
    if (cli->fontrom_low) {
        printf("Uploading low font ROM...\n");
        write_fontrom_packet(cli->output_fp, cli->fontrom_low, FONTROM_OPCODE_LOW, cli->verbose);
    }
    if (cli->fontrom_high) {
        printf("Uploading high font ROM...\n");
        write_fontrom_packet(cli->output_fp, cli->fontrom_high, FONTROM_OPCODE_HIGH, cli->verbose);
    }

    printf("Encoding frames with %d threads...\n", cli->num_threads);
    cli->start_time = time(NULL);

    int current_slot = 0;           // Slot being filled
    int next_gop_to_write = 0;      // GOP index that should be written next
    int current_gop_index = 0;      // Current GOP index being assembled
    int frames_in_current_gop = 0;  // Frames accumulated in current slot
    int encoding_error = 0;
    int eof_reached = 0;

    while (!encoding_error) {
        // Step 1: Try to write any completed GOPs in order
        pthread_mutex_lock(&cli->job_mutex);
        while (!encoding_error) {
            // Find the slot with the next GOP to write
            int found = -1;
            for (int i = 0; i < cli->num_threads; i++) {
                if (cli->gop_jobs[i].status == GOP_SLOT_COMPLETE &&
                    cli->gop_jobs[i].gop_index == next_gop_to_write) {
                    found = i;
                    break;
                }
            }

            if (found < 0) break;  // No complete GOP ready to write

            gop_job_t *job = &cli->gop_jobs[found];
            pthread_mutex_unlock(&cli->job_mutex);

            // Write this GOP
            if (job->success && job->packet) {
                // Write TIMECODE
                write_timecode_packet(cli->output_fp, job->frame_numbers[0],
                                     cli->enc_params.fps_num, cli->enc_params.fps_den);

                // Write AUDIO for this GOP
                if (cli->has_audio && job->num_audio_samples > 0) {
                    write_audio_packet(cli->output_fp, cli, job->audio_samples, job->num_audio_samples);
                }

                // Write VIDEO packet
                write_tav_packet(cli->output_fp, job->packet);
                cli->total_bytes += job->packet->size;
                cli->gop_count++;

                // Write sync packet
                if (job->packet->packet_type == TAV_PACKET_GOP_UNIFIED) {
                    // For 3D-DWT mode, write GOP_SYNC (0xFC) with frame count
                    int frames_in_gop = job->packet->data[1];
                    write_gop_sync_packet(cli->output_fp, frames_in_gop);
                } else if (job->packet->packet_type == TAV_PACKET_IFRAME) {
                    // For intra-only mode, write SYNC (0xFF) with no payload
                    write_sync_packet(cli->output_fp);
                }

                tav_encoder_free_packet(job->packet);
                job->packet = NULL;
            } else {
                fprintf(stderr, "Error: GOP %d encoding failed\n", job->gop_index);
                encoding_error = 1;
            }

            // Mark slot as empty
            pthread_mutex_lock(&cli->job_mutex);
            job->status = GOP_SLOT_EMPTY;
            job->num_frames = 0;
            next_gop_to_write++;

            // Progress
            if (cli->verbose || cli->frame_count % 60 == 0) {
                time_t elapsed = time(NULL) - cli->start_time;
                double fps = elapsed > 0 ? (double)cli->frame_count / elapsed : 0.0;
                double bitrate = elapsed > 0 ?
                    (cli->total_bytes * 8.0) / (cli->frame_count / ((double)cli->enc_params.fps_num / cli->enc_params.fps_den)) / 1000.0 : 0.0;

                printf("\rFrame %ld | GOPs: %ld | %.1f fps | %.1f kbps | %zu KB    ",
                       cli->frame_count, cli->gop_count, fps, bitrate,
                       cli->total_bytes / 1024);
                fflush(stdout);
            }
        }
        pthread_mutex_unlock(&cli->job_mutex);

        if (encoding_error || eof_reached) break;

        // Step 2: Fill current GOP slot
        gop_job_t *slot = &cli->gop_jobs[current_slot];

        // Wait for slot to be empty (writing completed GOPs along the way)
        pthread_mutex_lock(&cli->job_mutex);
        while (slot->status != GOP_SLOT_EMPTY && !cli->shutdown_workers) {
            // While waiting, check if we can write any completed GOPs
            int wrote_something = 0;
            for (int i = 0; i < cli->num_threads; i++) {
                if (cli->gop_jobs[i].status == GOP_SLOT_COMPLETE &&
                    cli->gop_jobs[i].gop_index == next_gop_to_write) {
                    gop_job_t *job = &cli->gop_jobs[i];
                    pthread_mutex_unlock(&cli->job_mutex);

                    // Write this GOP
                    if (job->success && job->packet) {
                        write_timecode_packet(cli->output_fp, job->frame_numbers[0],
                                             cli->enc_params.fps_num, cli->enc_params.fps_den);
                        if (cli->has_audio && job->num_audio_samples > 0) {
                            write_audio_packet(cli->output_fp, cli, job->audio_samples, job->num_audio_samples);
                        }
                        write_tav_packet(cli->output_fp, job->packet);
                        cli->total_bytes += job->packet->size;
                        cli->gop_count++;

                        if (job->packet->packet_type == TAV_PACKET_GOP_UNIFIED) {
                            write_gop_sync_packet(cli->output_fp, job->packet->data[1]);
                        } else if (job->packet->packet_type == TAV_PACKET_IFRAME) {
                            write_sync_packet(cli->output_fp);
                        }

                        tav_encoder_free_packet(job->packet);
                        job->packet = NULL;

                        // Progress
                        time_t elapsed = time(NULL) - cli->start_time;
                        double fps = elapsed > 0 ? (double)cli->frame_count / elapsed : 0.0;
                        printf("\rFrame %ld | GOPs: %ld | %.1f fps | %zu KB    ",
                               cli->frame_count, cli->gop_count, fps, cli->total_bytes / 1024);
                        fflush(stdout);
                    }

                    pthread_mutex_lock(&cli->job_mutex);
                    job->status = GOP_SLOT_EMPTY;
                    job->num_frames = 0;
                    next_gop_to_write++;
                    wrote_something = 1;
                    break;
                }
            }
            if (!wrote_something) {
                pthread_cond_wait(&cli->job_complete, &cli->job_mutex);
            }
        }
        pthread_mutex_unlock(&cli->job_mutex);

        // Reset audio accumulator only when starting a fresh GOP
        if (frames_in_current_gop == 0) {
            slot->num_audio_samples = 0;
        }

        // Read frame from FFmpeg
        if (cli->encode_limit > 0 && cli->frame_count >= cli->encode_limit) {
            eof_reached = 1;
        } else {
            int result = read_rgb_frame(cli->ffmpeg_pipe, rgb_frame, frame_size);
            if (result == 0) {
                eof_reached = 1;
            } else if (result < 0) {
                fprintf(stderr, "Error reading frame\n");
                encoding_error = 1;
            } else {
                // Copy frame to slot buffer
                memcpy(slot->rgb_frames[frames_in_current_gop], rgb_frame, frame_size);
                slot->frame_numbers[frames_in_current_gop] = (int)cli->frame_count;
                frames_in_current_gop++;
                cli->frame_count++;

                // Accumulate audio
                if (cli->has_audio && cli->audio_buffer) {
                    size_t samples_read = read_audio_samples(cli, cli->audio_buffer, cli->samples_per_frame);
                    if (samples_read > 0) {
                        memcpy(slot->audio_samples + slot->num_audio_samples * 2,
                               cli->audio_buffer,
                               samples_read * 2 * sizeof(float));
                        slot->num_audio_samples += samples_read;
                    }
                }

                // Check if GOP is complete
                if (frames_in_current_gop >= gop_size) {
                    slot->num_frames = frames_in_current_gop;
                    slot->gop_index = current_gop_index;

                    // Submit GOP to worker threads
                    pthread_mutex_lock(&cli->job_mutex);
                    slot->status = GOP_SLOT_READY;
                    pthread_cond_broadcast(&cli->job_ready);
                    pthread_mutex_unlock(&cli->job_mutex);

                    // Move to next slot
                    current_slot = (current_slot + 1) % cli->num_threads;
                    current_gop_index++;
                    frames_in_current_gop = 0;

                    // Note: audio reset moved to after we confirm slot is empty
                }
            }
        }
    }

    // Handle partial GOP at end
    if (!encoding_error && frames_in_current_gop > 0) {
        printf("\nEncoding final partial GOP (%d frames)...\n", frames_in_current_gop);

        gop_job_t *slot = &cli->gop_jobs[current_slot];
        slot->num_frames = frames_in_current_gop;
        slot->gop_index = current_gop_index;

        pthread_mutex_lock(&cli->job_mutex);
        slot->status = GOP_SLOT_READY;
        pthread_cond_broadcast(&cli->job_ready);
        pthread_mutex_unlock(&cli->job_mutex);

        current_gop_index++;
    }

    // Wait for all remaining GOPs to complete and write them
    while (!encoding_error && next_gop_to_write < current_gop_index) {
        pthread_mutex_lock(&cli->job_mutex);

        // Find slot with next GOP to write
        int found = -1;
        while (found < 0 && !encoding_error) {
            for (int i = 0; i < cli->num_threads; i++) {
                if (cli->gop_jobs[i].status == GOP_SLOT_COMPLETE &&
                    cli->gop_jobs[i].gop_index == next_gop_to_write) {
                    found = i;
                    break;
                }
            }
            if (found < 0) {
                pthread_cond_wait(&cli->job_complete, &cli->job_mutex);
            }
        }

        if (found >= 0) {
            gop_job_t *job = &cli->gop_jobs[found];
            pthread_mutex_unlock(&cli->job_mutex);

            if (job->success && job->packet) {
                write_timecode_packet(cli->output_fp, job->frame_numbers[0],
                                     cli->enc_params.fps_num, cli->enc_params.fps_den);
                if (cli->has_audio && job->num_audio_samples > 0) {
                    write_audio_packet(cli->output_fp, cli, job->audio_samples, job->num_audio_samples);
                }
                write_tav_packet(cli->output_fp, job->packet);
                cli->total_bytes += job->packet->size;
                cli->gop_count++;

                if (job->packet->packet_type == TAV_PACKET_GOP_UNIFIED) {
                    write_gop_sync_packet(cli->output_fp, job->packet->data[1]);
                } else if (job->packet->packet_type == TAV_PACKET_IFRAME) {
                    write_sync_packet(cli->output_fp);
                }

                tav_encoder_free_packet(job->packet);
                job->packet = NULL;
            }

            pthread_mutex_lock(&cli->job_mutex);
            job->status = GOP_SLOT_EMPTY;
            next_gop_to_write++;
            pthread_mutex_unlock(&cli->job_mutex);
        } else {
            pthread_mutex_unlock(&cli->job_mutex);
        }
    }

    printf("\n");

    // Update total frames in header
    update_total_frames(cli->output_fp, (uint32_t)cli->frame_count);

    // Update ENDT in Extended Header
    if (!cli->suppress_xhdr && cli->extended_header_offset >= 0) {
        // Calculate end time in nanoseconds
        uint64_t end_time_ns = (uint64_t)cli->frame_count * 1000000000ULL * cli->enc_params.fps_den / cli->enc_params.fps_num;
        update_extended_header_endt(cli->output_fp, cli->extended_header_offset, end_time_ns);
    }

    // Free per-job frame buffers (must be done before shutdown_threading)
    for (int slot = 0; slot < cli->num_threads; slot++) {
        if (cli->gop_jobs[slot].rgb_frames) {
            for (int f = 0; f < gop_size; f++) {
                free(cli->gop_jobs[slot].rgb_frames[f]);
            }
            free(cli->gop_jobs[slot].rgb_frames);
            cli->gop_jobs[slot].rgb_frames = NULL;
        }
        free(cli->gop_jobs[slot].frame_numbers);
        cli->gop_jobs[slot].frame_numbers = NULL;
        free(cli->gop_jobs[slot].audio_samples);
        cli->gop_jobs[slot].audio_samples = NULL;
    }

    // Cleanup
    free(rgb_frame);
    shutdown_threading(cli);
    pclose(cli->ffmpeg_pipe);

    // Cleanup audio
    if (cli->audio_buffer) {
        free(cli->audio_buffer);
        cli->audio_buffer = NULL;
    }
    if (cli->gop_audio_buffer) {
        free(cli->gop_audio_buffer);
        cli->gop_audio_buffer = NULL;
    }
    if (cli->pcm_file) {
        fclose(cli->pcm_file);
        cli->pcm_file = NULL;
    }
    if (cli->has_audio) {
        unlink(TEMP_PCM_FILE);
    }

    // Final statistics
    time_t total_time = time(NULL) - cli->start_time;
    double avg_fps = total_time > 0 ? (double)cli->frame_count / total_time : 0.0;
    double duration = (double)cli->frame_count / ((double)cli->enc_params.fps_num / cli->enc_params.fps_den);
    double avg_bitrate = duration > 0 ? (cli->total_bytes * 8.0) / duration / 1000.0 : 0.0;

    printf("\nEncoding complete! (multithreaded, %d threads)\n", cli->num_threads);
    printf("  Frames encoded: %ld\n", cli->frame_count);
    printf("  GOPs encoded: %ld\n", cli->gop_count);
    printf("  Total size: %.2f MB\n", cli->total_bytes / (1024.0 * 1024.0));
    printf("  Duration: %.2f seconds\n", duration);
    printf("  Average bitrate: %.1f kbps\n", avg_bitrate);
    printf("  Encoding speed: %.1f fps\n", avg_fps);
    printf("  Time taken: %ld seconds\n", total_time);

    return encoding_error ? -1 : 0;
}

// =============================================================================
// Single-Threaded Encoding Loop
// =============================================================================

static int encode_video(cli_context_t *cli) {
    // Dispatch to multithreaded version if threads > 0
    if (cli->num_threads > 0) {
        return encode_video_mt(cli);
    }

    printf("Opening FFmpeg pipe...\n");
    cli->ffmpeg_pipe = open_ffmpeg_pipe(cli->input_file,
                                        cli->enc_params.width,
                                        cli->enc_params.height);
    if (!cli->ffmpeg_pipe) {
        return -1;
    }

    // Create encoder
    printf("Creating encoder context...\n");
    tav_encoder_context_t *ctx = tav_encoder_create(&cli->enc_params);
    if (!ctx) {
        fprintf(stderr, "Error: %s\n", "Failed to create encoder");
        pclose(cli->ffmpeg_pipe);
        return -1;
    }

    // Get actual encoder params (with calculated values like decomp_levels)
    tav_encoder_get_params(ctx, &cli->enc_params);

    // NOW allocate GOP audio buffer with correct gop_size
    if (cli->has_audio) {
        size_t max_gop_audio = cli->enc_params.gop_size * cli->samples_per_frame * 2;
        cli->gop_audio_buffer = malloc(max_gop_audio * sizeof(float));
        cli->gop_audio_samples = 0;

        if (!cli->gop_audio_buffer) {
            fprintf(stderr, "Error: Failed to allocate GOP audio buffer\n");
            tav_encoder_free(ctx);
            pclose(cli->ffmpeg_pipe);
            return -1;
        }

        if (cli->verbose) {
            printf("  GOP audio buffer: %zu samples (%zu bytes)\n",
                   max_gop_audio / 2, max_gop_audio * sizeof(float));
        }
    }

    // Allocate GOP frame buffer for tav_encoder_encode_gop()
    size_t frame_size = cli->enc_params.width * cli->enc_params.height * 3;
    int gop_size = cli->enc_params.gop_size;

    // In intra-only mode, encode each frame immediately (GOP size = 1)
    if (!cli->enc_params.enable_temporal_dwt) {
        gop_size = 1;
    }

    cli->gop_frames = malloc(gop_size * sizeof(uint8_t*));
    cli->gop_frame_numbers = malloc(gop_size * sizeof(int));
    cli->gop_frame_count = 0;

    if (!cli->gop_frames || !cli->gop_frame_numbers) {
        fprintf(stderr, "Error: Failed to allocate GOP frame buffer\n");
        tav_encoder_free(ctx);
        pclose(cli->ffmpeg_pipe);
        return -1;
    }

    for (int i = 0; i < gop_size; i++) {
        cli->gop_frames[i] = malloc(frame_size);
        if (!cli->gop_frames[i]) {
            fprintf(stderr, "Error: Failed to allocate GOP frame %d\n", i);
            for (int j = 0; j < i; j++) free(cli->gop_frames[j]);
            free(cli->gop_frames);
            free(cli->gop_frame_numbers);
            tav_encoder_free(ctx);
            pclose(cli->ffmpeg_pipe);
            return -1;
        }
    }

    if (cli->verbose) {
        printf("  GOP frame buffer: %d frames x %zu bytes = %zu KB\n",
               gop_size, frame_size, (gop_size * frame_size) / 1024);
    }

    // Temporary frame buffer for reading from FFmpeg
    uint8_t *rgb_frame = malloc(frame_size);
    if (!rgb_frame) {
        fprintf(stderr, "Error: Failed to allocate frame buffer\n");
        for (int i = 0; i < gop_size; i++) free(cli->gop_frames[i]);
        free(cli->gop_frames);
        free(cli->gop_frame_numbers);
        tav_encoder_free(ctx);
        pclose(cli->ffmpeg_pipe);
        return -1;
    }

    // Write TAV header (with actual encoder params)
    write_tav_header(cli->output_fp, &cli->enc_params, cli->has_audio, cli->subtitles != NULL);

    // Write Extended Header (unless suppressed)
    if (!cli->suppress_xhdr) {
        cli->extended_header_offset = write_extended_header(cli, cli->enc_params.width, cli->enc_params.height);
        if (cli->extended_header_offset < 0) {
            fprintf(stderr, "Warning: Failed to write Extended Header\n");
        }
    }

    // Write subtitles upfront (SSF-TC format)
    if (cli->subtitles) {
        printf("Writing subtitles...\n");
        write_all_subtitles(cli->output_fp, cli->subtitles, cli->verbose);
    }

    // Write font ROMs if provided
    if (cli->fontrom_low) {
        printf("Uploading low font ROM...\n");
        write_fontrom_packet(cli->output_fp, cli->fontrom_low, FONTROM_OPCODE_LOW, cli->verbose);
    }
    if (cli->fontrom_high) {
        printf("Uploading high font ROM...\n");
        write_fontrom_packet(cli->output_fp, cli->fontrom_high, FONTROM_OPCODE_HIGH, cli->verbose);
    }

    // Encoding loop using tav_encoder_encode_gop()
    printf("Encoding frames...\n");
    cli->start_time = time(NULL);

    tav_encoder_packet_t *packet = NULL;
    int encoding_error = 0;

    while (1) {
        // Check encode limit
        if (cli->encode_limit > 0 && cli->frame_count >= cli->encode_limit) {
            break;
        }

        // Read frame from FFmpeg
        int result = read_rgb_frame(cli->ffmpeg_pipe, rgb_frame, frame_size);
        if (result == 0) {
            break;  // EOF
        } else if (result < 0) {
            fprintf(stderr, "Error reading frame\n");
            encoding_error = 1;
            break;
        }

        // Copy frame to GOP buffer
        memcpy(cli->gop_frames[cli->gop_frame_count], rgb_frame, frame_size);
        cli->gop_frame_numbers[cli->gop_frame_count] = (int)cli->frame_count;
        cli->gop_frame_count++;

        // Accumulate audio samples for this frame (will write when GOP completes)
        if (cli->has_audio && cli->audio_buffer && cli->gop_audio_buffer) {
            size_t samples_read = read_audio_samples(cli, cli->audio_buffer, cli->samples_per_frame);
            if (samples_read > 0) {
                // Append to GOP audio buffer (samples_read is per-channel count, stereo interleaved)
                memcpy(cli->gop_audio_buffer + cli->gop_audio_samples * 2,
                       cli->audio_buffer,
                       samples_read * 2 * sizeof(float));
                cli->gop_audio_samples += samples_read;
            }
        }

        cli->frame_count++;

        // Check if GOP is full
        if (cli->gop_frame_count >= gop_size) {
            // Encode complete GOP
            result = tav_encoder_encode_gop(ctx,
                                            (const uint8_t**)cli->gop_frames,
                                            cli->gop_frame_count,
                                            cli->gop_frame_numbers,
                                            &packet);

            if (result < 0) {
                fprintf(stderr, "Error: %s\n", tav_encoder_get_error(ctx));
                encoding_error = 1;
                break;
            }

            if (packet) {
                // GOP is complete - write in correct order: TIMECODE, AUDIO, VIDEO, GOP_SYNC

                // 1. Write timecode before GOP (use first frame number in GOP)
                write_timecode_packet(cli->output_fp, cli->gop_frame_numbers[0],
                                     cli->enc_params.fps_num, cli->enc_params.fps_den);

                // 2. Write accumulated audio for this GOP as single TAD packet
                if (cli->has_audio && cli->gop_audio_samples > 0) {
                    write_audio_packet(cli->output_fp, cli, cli->gop_audio_buffer, cli->gop_audio_samples);
                    cli->gop_audio_samples = 0;  // Reset for next GOP
                }

                // 3. Write video GOP packet
                write_tav_packet(cli->output_fp, packet);
                cli->total_bytes += packet->size;
                cli->gop_count++;

                // 4. Write sync packet after video packets
                if (packet->packet_type == TAV_PACKET_GOP_UNIFIED) {
                    int frames_in_gop = packet->data[1];
                    write_gop_sync_packet(cli->output_fp, frames_in_gop);
                } else if (packet->packet_type == TAV_PACKET_IFRAME) {
                    write_sync_packet(cli->output_fp);
                }

                tav_encoder_free_packet(packet);
                packet = NULL;
            }

            // Reset GOP buffer
            cli->gop_frame_count = 0;

            // Progress
            if (cli->verbose || cli->frame_count % 60 == 0) {
                time_t elapsed = time(NULL) - cli->start_time;
                double fps = elapsed > 0 ? (double)cli->frame_count / elapsed : 0.0;
                double bitrate = elapsed > 0 ?
                    (cli->total_bytes * 8.0) / (cli->frame_count / ((double)cli->enc_params.fps_num / cli->enc_params.fps_den)) / 1000.0 : 0.0;

                printf("\rFrame %ld/%ld | GOPs: %ld | %.1f fps | %.1f kbps | %zu KB",
                       cli->frame_count,
                       cli->encode_limit > 0 ? cli->encode_limit : 0L,
                       cli->gop_count, fps, bitrate,
                       cli->total_bytes / 1024);
                fflush(stdout);
            }
        }
    }

    printf("\n");

    // Encode remaining frames in GOP buffer (partial GOP)
    if (!encoding_error && cli->gop_frame_count > 0) {
        printf("Encoding final partial GOP (%d frames)...\n", cli->gop_frame_count);

        int result = tav_encoder_encode_gop(ctx,
                                            (const uint8_t**)cli->gop_frames,
                                            cli->gop_frame_count,
                                            cli->gop_frame_numbers,
                                            &packet);

        if (result < 0) {
            fprintf(stderr, "Error encoding final GOP: %s\n", tav_encoder_get_error(ctx));
        } else if (packet) {
            // Write remaining packets in correct order: TIMECODE, AUDIO, VIDEO, GOP_SYNC

            // 1. Write timecode
            write_timecode_packet(cli->output_fp, cli->gop_frame_numbers[0],
                                 cli->enc_params.fps_num, cli->enc_params.fps_den);

            // 2. Write any remaining accumulated audio for this GOP
            if (cli->has_audio && cli->gop_audio_samples > 0) {
                write_audio_packet(cli->output_fp, cli, cli->gop_audio_buffer, cli->gop_audio_samples);
                cli->gop_audio_samples = 0;
            }

            // 3. Write video packet
            write_tav_packet(cli->output_fp, packet);
            cli->total_bytes += packet->size;
            cli->gop_count++;

            // 4. Write sync packet after video packets
            if (packet->packet_type == TAV_PACKET_GOP_UNIFIED) {
                int frames_in_gop = packet->data[1];
                write_gop_sync_packet(cli->output_fp, frames_in_gop);
            } else if (packet->packet_type == TAV_PACKET_IFRAME) {
                write_sync_packet(cli->output_fp);
            }

            tav_encoder_free_packet(packet);
        }
    }

    // Update total frames in header
    update_total_frames(cli->output_fp, (uint32_t)cli->frame_count);

    // Update ENDT in Extended Header
    if (!cli->suppress_xhdr && cli->extended_header_offset >= 0) {
        // Calculate end time in nanoseconds
        uint64_t end_time_ns = (uint64_t)cli->frame_count * 1000000000ULL * cli->enc_params.fps_den / cli->enc_params.fps_num;
        update_extended_header_endt(cli->output_fp, cli->extended_header_offset, end_time_ns);
    }

    // Cleanup
    free(rgb_frame);
    tav_encoder_free(ctx);
    pclose(cli->ffmpeg_pipe);

    // Cleanup GOP frame buffer
    if (cli->gop_frames) {
        for (int i = 0; i < gop_size; i++) {
            free(cli->gop_frames[i]);
        }
        free(cli->gop_frames);
        cli->gop_frames = NULL;
    }
    if (cli->gop_frame_numbers) {
        free(cli->gop_frame_numbers);
        cli->gop_frame_numbers = NULL;
    }

    // Cleanup audio resources
    if (cli->audio_buffer) {
        free(cli->audio_buffer);
        cli->audio_buffer = NULL;
    }
    if (cli->gop_audio_buffer) {
        free(cli->gop_audio_buffer);
        cli->gop_audio_buffer = NULL;
    }
    if (cli->pcm_file) {
        fclose(cli->pcm_file);
        cli->pcm_file = NULL;
    }
    // Remove temporary audio file
    if (cli->has_audio) {
        unlink(TEMP_PCM_FILE);
    }

    // Final statistics
    time_t total_time = time(NULL) - cli->start_time;
    double avg_fps = total_time > 0 ? (double)cli->frame_count / total_time : 0.0;
    double duration = (double)cli->frame_count / ((double)cli->enc_params.fps_num / cli->enc_params.fps_den);
    double avg_bitrate = duration > 0 ? (cli->total_bytes * 8.0) / duration / 1000.0 : 0.0;

    printf("\nEncoding complete!\n");
    printf("  Frames encoded: %ld\n", cli->frame_count);
    printf("  GOPs encoded: %ld\n", cli->gop_count);
    printf("  Total size: %.2f MB\n", cli->total_bytes / (1024.0 * 1024.0));
    printf("  Duration: %.2f seconds\n", duration);
    printf("  Average bitrate: %.1f kbps\n", avg_bitrate);
    printf("  Encoding speed: %.1f fps\n", avg_fps);
    printf("  Time taken: %ld seconds\n", total_time);

    return 0;
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char *argv[]) {
    // Generate temp file names
    generate_random_filename(TEMP_AUDIO_FILE);
    generate_random_filename(TEMP_PCM_FILE);
    strcpy(TEMP_PCM_FILE + 37, ".pcm");
    strcpy(TEMP_AUDIO_FILE + 37, ".mp2");

    printf("TAV Encoder - TSVM Advanced Video Codec (Reference Implementation)\n");
    printf("Using libtavenc v1.0 - Complete feature set with all encoder presets\n\n");

    // Initialize CLI context
    cli_context_t cli = {0};

    // Initialize encoder params with defaults
    tav_encoder_params_init(&cli.enc_params, 480, 360);

    // Force EZBC entropy coder (Twobitmap is deprecated)
    cli.enc_params.entropy_coder = 1;  // Always use EZBC

    // Ensure two-pass scene detection is enabled by default
    cli.enc_params.enable_two_pass = 1;

    // Initialize audio defaults
    cli.has_audio = 1;              // Enabled by default
    cli.audio_quality = -1;         // Will match video quality if not specified
    cli.use_native_audio = 0;       // TAD by default

    // Initialize threading defaults: min(8, available CPUs)
    cli.num_threads = get_default_thread_count();

    // Command-line options
    static struct option long_options[] = {
        {"input", required_argument, 0, 'i'},
        {"output", required_argument, 0, 'o'},
        {"size", required_argument, 0, 's'},
        {"fps", required_argument, 0, 'f'},
        {"quality", required_argument, 0, 'q'},
        {"quantiser", required_argument, 0, 'Q'},
        {"wavelet", required_argument, 0, 'w'},
        {"temporal-wavelet", required_argument, 0, 1021},
        {"colour-space", required_argument, 0, 'c'},
        {"verbose", no_argument, 0, 'v'},
        {"intra-only", no_argument, 0, 1001},
        {"temporal-dwt", no_argument, 0, 1002},
        {"gop-size", required_argument, 0, 1003},
        {"single-pass", no_argument, 0, 1004},
        {"zstd-level", required_argument, 0, 1005},
        {"no-perceptual-tuning", no_argument, 0, 1006},
        {"no-dead-zone", no_argument, 0, 1007},
        {"dead-zone-threshold", required_argument, 0, 1023},
        {"decomp-levels", required_argument, 0, 1024},
        {"temporal-levels", required_argument, 0, 1025},
        {"encode-limit", required_argument, 0, 1009},
        {"subtitle", required_argument, 0, 1010},
        {"fontrom-low", required_argument, 0, 1011},
        {"fontrom-high", required_argument, 0, 1012},
        {"tad-audio", no_argument, 0, 1013},
        {"pcm8-audio", no_argument, 0, 1014},
        {"separate-audio-track", no_argument, 0, 1015},
        {"audio-quality", required_argument, 0, 1016},
        {"no-audio", no_argument, 0, 1017},
        {"preset-sports", no_argument, 0, 1026},
        {"preset-anime", no_argument, 0, 1027},
        {"monoblock", no_argument, 0, 1028},
        {"tiled", no_argument, 0, 1029},
        {"suppress-xhdr", no_argument, 0, 1030},
        {"threads", required_argument, 0, 't'},
        {"help", no_argument, 0, '?'},
        {0, 0, 0, 0}
    };

    int c, option_index = 0;
    while ((c = getopt_long(argc, argv, "i:o:s:f:q:Q:w:c:t:v?", long_options, &option_index)) != -1) {
        switch (c) {
            case 'i':
                cli.input_file = strdup(optarg);
                break;
            case 'o':
                cli.output_file = strdup(optarg);
                break;
            case 's': {
                int w, h;
                if (sscanf(optarg, "%dx%d", &w, &h) != 2) {
                    fprintf(stderr, "Error: Invalid size format. Use WxH (e.g., 480x360)\n");
                    return 1;
                }
                cli.enc_params.width = w;
                cli.enc_params.height = h;
                break;
            }
            case 'f': {
                int num, den = 1;
                if (sscanf(optarg, "%d/%d", &num, &den) < 1) {
                    fprintf(stderr, "Error: Invalid fps format. Use NUM or NUM/DEN\n");
                    return 1;
                }
                cli.enc_params.fps_num = num;
                cli.enc_params.fps_den = den;
                break;
            }
            case 'q': {
                int q = atoi(optarg);
                if (q < 0 || q > 5) {
                    fprintf(stderr, "Error: Quality must be 0-5\n");
                    return 1;
                }
                // Convert quality level to quantiser indices
                cli.enc_params.quality_level = q;
                cli.enc_params.quantiser_y = QUALITY_Y[q];
                cli.enc_params.quantiser_co = QUALITY_CO[q];
                cli.enc_params.quantiser_cg = QUALITY_CG[q];
                cli.enc_params.dead_zone_threshold = DEAD_ZONE_THRESHOLD[q];
                break;
            }
            case 'Q': {
                int y, co, cg;
                if (sscanf(optarg, "%d,%d,%d", &y, &co, &cg) != 3) {
                    fprintf(stderr, "Error: Invalid quantiser format. Use Y,Co,Cg\n");
                    return 1;
                }
                cli.enc_params.quantiser_y = y;
                cli.enc_params.quantiser_co = co;
                cli.enc_params.quantiser_cg = cg;
                break;
            }
            case 'w':
                cli.enc_params.wavelet_type = atoi(optarg);
                break;
            case 'c':
                cli.enc_params.channel_layout = atoi(optarg);
                break;
            case 'v':
                cli.verbose = 1;
                cli.enc_params.verbose = 1;
                break;
            case 1001:  // --intra-only
                cli.enc_params.enable_temporal_dwt = 0;
                break;
            case 1002:  // --temporal-dwt
                cli.enc_params.enable_temporal_dwt = 1;
                break;
            case 1003:  // --gop-size
                cli.enc_params.gop_size = atoi(optarg);
                break;
            case 1004:  // --single-pass
                cli.enc_params.enable_two_pass = 0;
                break;
            case 1005:  // --zstd-level
                cli.enc_params.zstd_level = atoi(optarg);
                break;
            case 1006:  // --no-perceptual-tuning
                cli.enc_params.perceptual_tuning = 0;
                break;
            case 1007:  // --no-dead-zone
                cli.enc_params.dead_zone_threshold = 0;
                break;
            case 1009:  // --encode-limit
                cli.encode_limit = atoi(optarg);
                break;
            case 1010:  // --subtitle
                cli.subtitle_file = strdup(optarg);
                break;
            case 1011:  // --fontrom-low
                cli.fontrom_low = strdup(optarg);
                break;
            case 1012:  // --fontrom-high
                cli.fontrom_high = strdup(optarg);
                break;
            case 1013:  // --tad-audio
                cli.use_native_audio = 0;
                break;
            case 1014:  // --pcm8-audio
                cli.use_native_audio = 1;
                break;
            case 1015:  // --separate-audio-track
                cli.separate_audio_track = 1;
                break;
            case 1016:  // --audio-quality
                cli.audio_quality = atoi(optarg);
                if (cli.audio_quality < 0 || cli.audio_quality > 5) {
                    fprintf(stderr, "Error: Audio quality must be 0-5\n");
                    return 1;
                }
                break;
            case 1017:  // --no-audio
                cli.has_audio = 0;
                break;
            case 1021:  // --temporal-wavelet
                cli.enc_params.temporal_wavelet = atoi(optarg);
                break;
            case 1023:  // --dead-zone-threshold
                cli.enc_params.dead_zone_threshold = atoi(optarg);
                break;
            case 1024:  // --decomp-levels
                cli.enc_params.decomp_levels = atoi(optarg);
                break;
            case 1025:  // --temporal-levels
                cli.enc_params.temporal_levels = atoi(optarg);
                break;
            case 1026:  // --preset-sports
                cli.enc_params.encoder_preset |= 0x01;
                break;
            case 1027:  // --preset-anime
                cli.enc_params.encoder_preset |= 0x02;
                break;
            case 1028:  // --monoblock
                cli.enc_params.monoblock = 1;
                break;
            case 1029:  // --tiled
                cli.enc_params.monoblock = 0;
                break;
            case 1030:  // --suppress-xhdr
                cli.suppress_xhdr = 1;
                break;
            case 't': {  // --threads
                int threads = atoi(optarg);
                if (threads < 0 || threads > MAX_THREADS) {
                    fprintf(stderr, "Error: Thread count must be 0-%d\n", MAX_THREADS);
                    return 1;
                }
                // Both 0 and 1 mean single-threaded (use value 0 internally)
                cli.num_threads = (threads <= 1) ? 0 : threads;
                break;
            }
            case '?':
            default:
                print_usage(argv[0]);
                return (c == '?') ? 0 : 1;
        }
    }

    // Validate required arguments
    if (!cli.input_file || !cli.output_file) {
        fprintf(stderr, "Error: Input and output files are required\n\n");
        print_usage(argv[0]);
        return 1;
    }

    // Probe video to get resolution and framerate
    int need_probe_dimensions = (cli.enc_params.width == 480 && cli.enc_params.height == 360);
    int need_probe_fps = (cli.enc_params.fps_num == 60 && cli.enc_params.fps_den == 1);

    if (need_probe_dimensions || need_probe_fps) {
        printf("Probing video file...\n");
        if (get_video_info(cli.input_file,
                          &cli.original_width, &cli.original_height,
                          &cli.original_fps_num, &cli.original_fps_den) < 0) {
            return 1;
        }

        // Use probed dimensions if not specified by -s
        if (need_probe_dimensions) {
            cli.enc_params.width = cli.original_width;
            cli.enc_params.height = cli.original_height;
            printf("  Resolution: %dx%d\n", cli.original_width, cli.original_height);
        }

        // Use probed framerate if not specified by -f
        if (need_probe_fps) {
            cli.enc_params.fps_num = cli.original_fps_num;
            cli.enc_params.fps_den = cli.original_fps_den;
            printf("  Framerate: %d/%d\n", cli.original_fps_num, cli.original_fps_den);
        }
    }

    // Set audio quality to match video quality if not specified
    if (cli.audio_quality < 0) {
        cli.audio_quality = cli.enc_params.quality_level;  // Match luma quality
    }

    // Extract audio if enabled
    if (cli.has_audio && !cli.use_native_audio) {
        printf("Extracting audio...\n");
        if (extract_audio_to_file(cli.input_file, TEMP_PCM_FILE)) {
            cli.pcm_file = fopen(TEMP_PCM_FILE, "rb");
            if (cli.pcm_file) {
                fseek(cli.pcm_file, 0, SEEK_END);
                cli.audio_remaining = ftell(cli.pcm_file);
                fseek(cli.pcm_file, 0, SEEK_SET);

                // Calculate samples per frame
                cli.samples_per_frame = (AUDIO_SAMPLE_RATE + cli.enc_params.fps_num - 1) / cli.enc_params.fps_num;

                // Allocate per-frame audio buffer
                cli.audio_buffer_size = cli.samples_per_frame * 2;  // Stereo
                cli.audio_buffer = malloc(cli.audio_buffer_size * sizeof(float));

                // Note: GOP audio buffer will be allocated in encode_video() after encoder creation
                // when we know the actual GOP size

                printf("  Audio: TAD quality %d, %d samples/frame\n",
                       cli.audio_quality, cli.samples_per_frame);
            } else {
                fprintf(stderr, "Warning: Failed to open extracted audio, encoding without audio\n");
                cli.has_audio = 0;
            }
        } else {
            fprintf(stderr, "Warning: No audio stream found or extraction failed\n");
            cli.has_audio = 0;
        }
    }

    // Parse subtitle file if provided
    if (cli.subtitle_file) {
        printf("Parsing subtitles: %s\n", cli.subtitle_file);
        cli.subtitles = parse_srt_file(cli.subtitle_file);
        if (cli.subtitles) {
            // Count subtitles
            int count = 0;
            subtitle_entry_t *sub = cli.subtitles;
            while (sub) {
                count++;
                sub = sub->next;
            }
            printf("  Loaded %d subtitles\n", count);
        } else {
            fprintf(stderr, "Warning: Failed to parse subtitle file\n");
        }
    }

    // Initialize Extended Header metadata
    cli.ffmpeg_version = get_ffmpeg_version();  // May return NULL if FFmpeg not found
    struct timespec ts;
    if (clock_gettime(CLOCK_REALTIME, &ts) == 0) {
        cli.creation_time_us = (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)ts.tv_nsec / 1000ULL;
    } else {
        // Fallback to time() if clock_gettime fails
        cli.creation_time_us = (uint64_t)time(NULL) * 1000000ULL;
    }

    // Open output file
    cli.output_fp = fopen(cli.output_file, "wb");
    if (!cli.output_fp) {
        fprintf(stderr, "Error: Failed to open output file: %s\n", cli.output_file);
        return 1;
    }

    // Encode video
    int result = encode_video(&cli);

    // Print output file before cleanup frees the string
    if (result >= 0) {
        printf("\nOutput written to: %s\n", cli.output_file);
    }

    // Cleanup
    fclose(cli.output_fp);
    free(cli.input_file);
    free(cli.output_file);
    if (cli.subtitle_file) {
        free(cli.subtitle_file);
    }
    if (cli.subtitles) {
        free_subtitle_list(cli.subtitles);
    }
    if (cli.fontrom_low) {
        free(cli.fontrom_low);
    }
    if (cli.fontrom_high) {
        free(cli.fontrom_high);
    }
    if (cli.ffmpeg_version) {
        free(cli.ffmpeg_version);
    }

    if (result < 0) {
        fprintf(stderr, "Encoding failed\n");
        return 1;
    }

    return 0;
}
