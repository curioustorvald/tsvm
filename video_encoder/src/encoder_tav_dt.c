/**
 * TAV-DT Encoder - Digital Tape Format Encoder
 *
 * Encodes video to TAV-DT format with forward error correction.
 *
 * TAV-DT is a packetised streaming format designed for digital tape/broadcast:
 * - Fixed dimensions: 720x480 (NTSC) or 720x576 (PAL)
 * - 16-frame GOPs with 9/7 spatial wavelet, Haar temporal
 * - Mandatory TAD audio
 * - LDPC rate 1/2 for headers, Reed-Solomon (255,223) for payloads
 *
 * Packet structure (revised 2025-12-15):
 * - Main header: 28 bytes -> 56 bytes LDPC encoded
 *   Layout: sync(4) + fps(1) + flags(1) + reserved(2) + size(4) + timecode(8) + offset(4) + crc(4)
 *   CRC covers bytes 0-23 (everything except CRC itself)
 * - TAD subpacket: header (10->20 bytes LDPC) + RS-encoded payload
 * - TAV subpacket: header (8->16 bytes LDPC) + RS-encoded payload
 * - No packet type bytes - always audio then video
 *
 * Created by CuriousTorvald and Claude on 2025-12-09.
 * Revised 2025-12-15 for updated TAV-DT specification (CRC now covers timecode and offset).
 */

#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <getopt.h>
#include <unistd.h>
#include <sys/wait.h>
#include <time.h>
#include <math.h>
#include <pthread.h>

#include "tav_encoder_lib.h"
#include "encoder_tad.h"
#include "reed_solomon.h"
#include "ldpc.h"
#include "ldpc_payload.h"

// FEC mode for payloads (stored in flags byte bit 2)
#define FEC_MODE_RS   0    // Reed-Solomon (255,223) - default
#define FEC_MODE_LDPC 1    // LDPC (255,223) - experimental

// =============================================================================
// Constants
// =============================================================================

// TAV-DT sync patterns (big endian)
#define TAV_DT_SYNC_NTSC  0xE3537A1F
#define TAV_DT_SYNC_PAL   0xD193A745

// TAV-DT dimensions
#define DT_WIDTH          720
#define DT_HEIGHT_NTSC    480
#define DT_HEIGHT_PAL     576

// Fixed parameters
#define DT_GOP_SIZE        16
#define DT_SPATIAL_LEVELS  4
#define DT_TEMPORAL_LEVELS 2

// Header sizes (before LDPC encoding)
#define DT_MAIN_HEADER_SIZE   28   // sync(4) + fps(1) + flags(1) + reserved(2) + size(4) + crc(4) + timecode(8) + offset(4)
#define DT_TAD_HEADER_SIZE    10   // sample_count(2) + quant_bits(1) + compressed_size(4) + rs_block_count(3)
#define DT_TAV_HEADER_SIZE    8    // gop_size(1) + compressed_size(4) + rs_block_count(3)

// Quality level to quantiser mapping
static const int QUALITY_Y[]  = {79, 47, 23, 11, 5, 2};
static const int QUALITY_CO[] = {123, 108, 91, 76, 59, 29};
static const int QUALITY_CG[] = {148, 133, 113, 99, 76, 39};

// Audio samples per GOP (32kHz / framerate * gop_size)
#define AUDIO_SAMPLE_RATE 32000

// =============================================================================
// Multithreading Structures
// =============================================================================

#define GOP_SLOT_EMPTY     0
#define GOP_SLOT_READY     1
#define GOP_SLOT_ENCODING  2
#define GOP_SLOT_COMPLETE  3

typedef struct {
    // Input frames (copied from main thread)
    uint8_t **rgb_frames;     // Frame data pointers [gop_size]
    int *frame_numbers;       // Frame number array [gop_size]
    int num_frames;           // Actual number of frames in this GOP
    int gop_index;            // Sequential GOP index for ordering output

    // Audio samples for this GOP
    float *audio_samples;     // Interleaved stereo samples
    size_t audio_sample_count;

    // Output
    tav_encoder_packet_t *packet;  // Encoded video packet
    uint8_t *tad_output;           // Encoded audio data
    size_t tad_size;               // Encoded audio size
    int success;                   // 1 if encoding succeeded

    // Encoder params (copy for thread safety)
    tav_encoder_params_t params;

    // Slot status
    volatile int status;
} gop_job_t;

/**
 * Get number of available CPUs.
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
 * Get default thread count (cap at 8)
 */
static int get_default_thread_count(void) {
    int available = get_available_cpus();
    return available < 8 ? available : 8;
}

// =============================================================================
// CRC-32
// =============================================================================

static uint32_t crc32_table[256];
static int crc32_initialized = 0;

static void init_crc32_table(void) {
    if (crc32_initialized) return;
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t crc = i;
        for (int j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
        }
        crc32_table[i] = crc;
    }
    crc32_initialized = 1;
}

static uint32_t calculate_crc32(const uint8_t *data, size_t length) {
    init_crc32_table();
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < length; i++) {
        crc = (crc >> 8) ^ crc32_table[(crc ^ data[i]) & 0xFF];
    }
    return crc ^ 0xFFFFFFFF;
}

// =============================================================================
// Encoder Context
// =============================================================================

typedef struct {
    // Input/output
    char *input_file;
    char *output_file;
    FILE *output_fp;

    // Video encoder context
    tav_encoder_context_t *video_ctx;

    // Video parameters
    int width;
    int height;
    int fps_num;
    int fps_den;
    int is_interlaced;
    int is_pal;
    int quality_index;

    // Frame buffers
    uint8_t **gop_frames;
    int gop_frame_count;

    // Audio buffer
    float *audio_buffer;
    size_t audio_buffer_samples;
    size_t audio_buffer_capacity;

    // Timecode
    uint64_t current_timecode_ns;
    int frame_number;

    // Statistics
    uint64_t packets_written;
    uint64_t bytes_written;
    uint64_t frames_encoded;

    // Options
    int verbose;
    int encode_limit;
    int fec_mode;                // FEC_MODE_RS or FEC_MODE_LDPC for payloads

    // Multithreading
    int num_threads;             // 0 = single-threaded, 1+ = num worker threads
    gop_job_t *gop_jobs;         // Array of GOP job slots [num_threads]
    pthread_t *worker_threads;   // Array of worker thread handles [num_threads]
    pthread_mutex_t job_mutex;   // Mutex for job slot access
    pthread_cond_t job_ready;    // Signal when a job slot is ready for encoding
    pthread_cond_t job_complete; // Signal when a job slot is complete
    volatile int shutdown_workers; // 1 when workers should exit

    // Encoder params (template for worker threads)
    tav_encoder_params_t enc_params;
} dt_encoder_t;

// =============================================================================
// Utility Functions
// =============================================================================

static void print_usage(const char *program) {
    printf("TAV-DT Encoder - Digital Tape Format with FEC\n");
    printf("\nUsage: %s -i input.mp4 -o output.tavdt [options]\n\n", program);
    printf("Required:\n");
    printf("  -i, --input FILE     Input video file (via FFmpeg)\n");
    printf("  -o, --output FILE    Output TAV-DT file\n");
    printf("\nOptions:\n");
    printf("  -q, --quality N      Quality level 0-5 (default: 3)\n");
    printf("  --ntsc               Force NTSC format (720x480, default)\n");
    printf("  --pal                Force PAL format (720x576)\n");
    printf("  --interlaced         Interlaced output\n");
    printf("  --ldpc-payload       Use LDPC(255,223) instead of RS(255,223) for payloads\n");
    printf("                       (experimental: better at high error rates)\n");
    printf("  --encode-limit N     Encode only N frames (for testing)\n");
    printf("  -t, --threads N      Parallel encoding threads (default: min(8, available CPUs))\n");
    printf("                       0 or 1 = single-threaded, 2-16 = multithreaded\n");
    printf("  -v, --verbose        Verbose output\n");
    printf("  -h, --help           Show this help\n");
}

// =============================================================================
// FEC Block Encoding (RS or LDPC based on mode)
// =============================================================================

static size_t encode_fec_blocks(const uint8_t *data, size_t data_len, uint8_t *output, int fec_mode) {
    if (fec_mode == FEC_MODE_LDPC) {
        // Use LDPC(255,223) encoding
        return ldpc_p_encode_blocks(data, data_len, output);
    } else {
        // Use RS(255,223) encoding (default)
        size_t output_len = 0;
        size_t remaining = data_len;
        const uint8_t *src = data;
        uint8_t *dst = output;

        while (remaining > 0) {
            size_t block_data = (remaining > RS_DATA_SIZE) ? RS_DATA_SIZE : remaining;
            size_t encoded_len = rs_encode(src, block_data, dst);

            // Pad to full block size for consistent block boundaries
            if (encoded_len < RS_BLOCK_SIZE) {
                memset(dst + encoded_len, 0, RS_BLOCK_SIZE - encoded_len);
            }

            src += block_data;
            dst += RS_BLOCK_SIZE;
            output_len += RS_BLOCK_SIZE;
            remaining -= block_data;
        }

        return output_len;
    }
}

// =============================================================================
// Packet Writing
// =============================================================================

static int write_packet(dt_encoder_t *enc, uint64_t timecode_ns,
                        const uint8_t *tad_data, size_t tad_size,
                        const uint8_t *tav_data, size_t tav_size,
                        int gop_size, uint16_t audio_samples, uint8_t audio_quant_bits) {

    // Calculate RS block counts
    uint32_t tad_rs_blocks = (tad_size + RS_DATA_SIZE - 1) / RS_DATA_SIZE;
    uint32_t tav_rs_blocks = (tav_size + RS_DATA_SIZE - 1) / RS_DATA_SIZE;

    // Calculate sizes
    size_t tad_rs_size = tad_rs_blocks * RS_BLOCK_SIZE;
    size_t tav_rs_size = tav_rs_blocks * RS_BLOCK_SIZE;

    size_t tad_subpacket_size = DT_TAD_HEADER_SIZE * 2 + tad_rs_size;  // LDPC header + RS payload
    size_t tav_subpacket_size = DT_TAV_HEADER_SIZE * 2 + tav_rs_size;  // LDPC header + RS payload

    uint32_t offset_to_video = tad_subpacket_size;
    uint32_t packet_size = tad_subpacket_size + tav_subpacket_size;

    // Build main header (28 bytes)
    // Layout (revised 2025-12-15): sync(4) + fps(1) + flags(1) + reserved(2) + size(4) + timecode(8) + offset(4) + crc(4)
    // CRC is calculated over bytes 0-23 (everything except CRC itself)
    uint8_t header[DT_MAIN_HEADER_SIZE];
    // Write sync pattern in big-endian (network byte order)
    uint32_t sync = enc->is_pal ? TAV_DT_SYNC_PAL : TAV_DT_SYNC_NTSC;
    header[0] = (sync >> 24) & 0xFF;
    header[1] = (sync >> 16) & 0xFF;
    header[2] = (sync >> 8) & 0xFF;
    header[3] = sync & 0xFF;

    // FPS byte: encode framerate
    uint8_t fps_byte;
    if (enc->fps_den == 1) fps_byte = enc->fps_num;
    else if (enc->fps_den == 1001) fps_byte = enc->fps_num / 1000;
    else fps_byte = enc->fps_num / enc->fps_den;
    header[4] = fps_byte;

    // Flags byte
    uint8_t flags = 0;
    flags |= (enc->is_interlaced ? 0x01 : 0x00);
    flags |= (enc->fps_den == 1001 ? 0x02 : 0x00);
    flags |= (enc->quality_index & 0x0F) << 4;
    header[5] = flags;

    // Reserved (2 bytes)
    header[6] = 0;
    header[7] = 0;

    // Packet size (4 bytes)
    memcpy(header + 8, &packet_size, 4);

    // Timecode (8 bytes) - now at offset 12
    memcpy(header + 12, &timecode_ns, 8);

    // Offset to video (4 bytes) - now at offset 20
    memcpy(header + 20, &offset_to_video, 4);

    // CRC-32 (4 bytes) - calculated over bytes 0-23 (sync + fps + flags + reserved + size + timecode + offset)
    uint32_t crc = calculate_crc32(header, 24);
    memcpy(header + 24, &crc, 4);

    // LDPC encode main header
    uint8_t ldpc_header[DT_MAIN_HEADER_SIZE * 2];
    ldpc_encode(header, DT_MAIN_HEADER_SIZE, ldpc_header);

    // Build TAD subpacket header (10 bytes)
    uint8_t tad_header[DT_TAD_HEADER_SIZE];
    memcpy(tad_header + 0, &audio_samples, 2);
    tad_header[2] = audio_quant_bits;
    uint32_t tad_compressed_size = tad_size;
    memcpy(tad_header + 3, &tad_compressed_size, 4);
    // RS block count as uint24
    tad_header[7] = tad_rs_blocks & 0xFF;
    tad_header[8] = (tad_rs_blocks >> 8) & 0xFF;
    tad_header[9] = (tad_rs_blocks >> 16) & 0xFF;

    uint8_t ldpc_tad_header[DT_TAD_HEADER_SIZE * 2];
    ldpc_encode(tad_header, DT_TAD_HEADER_SIZE, ldpc_tad_header);

    // Build TAV subpacket header (8 bytes)
    uint8_t tav_header[DT_TAV_HEADER_SIZE];
    tav_header[0] = gop_size;
    uint32_t tav_compressed_size = tav_size;
    memcpy(tav_header + 1, &tav_compressed_size, 4);
    // RS block count as uint24
    tav_header[5] = tav_rs_blocks & 0xFF;
    tav_header[6] = (tav_rs_blocks >> 8) & 0xFF;
    tav_header[7] = (tav_rs_blocks >> 16) & 0xFF;

    uint8_t ldpc_tav_header[DT_TAV_HEADER_SIZE * 2];
    ldpc_encode(tav_header, DT_TAV_HEADER_SIZE, ldpc_tav_header);

    // FEC encode payloads (RS or LDPC based on mode)
    uint8_t *tad_rs_data = malloc(tad_rs_size);
    uint8_t *tav_rs_data = malloc(tav_rs_size);

    encode_fec_blocks(tad_data, tad_size, tad_rs_data, enc->fec_mode);
    encode_fec_blocks(tav_data, tav_size, tav_rs_data, enc->fec_mode);

    // Write everything
    fwrite(ldpc_header, 1, DT_MAIN_HEADER_SIZE * 2, enc->output_fp);
    fwrite(ldpc_tad_header, 1, DT_TAD_HEADER_SIZE * 2, enc->output_fp);
    fwrite(tad_rs_data, 1, tad_rs_size, enc->output_fp);
    fwrite(ldpc_tav_header, 1, DT_TAV_HEADER_SIZE * 2, enc->output_fp);
    fwrite(tav_rs_data, 1, tav_rs_size, enc->output_fp);

    size_t total_written = DT_MAIN_HEADER_SIZE * 2 + tad_subpacket_size + tav_subpacket_size;

    if (enc->verbose) {
        printf("GOP %lu: %d frames, header=%zu tad=%zu tav=%zu total=%zu bytes\n",
               enc->packets_written + 1, gop_size,
               (size_t)(DT_MAIN_HEADER_SIZE * 2), tad_subpacket_size, tav_subpacket_size, total_written);
    }

    free(tad_rs_data);
    free(tav_rs_data);

    enc->packets_written++;
    enc->bytes_written += total_written;

    return 0;
}

// =============================================================================
// FFmpeg Integration
// =============================================================================

static FILE *spawn_ffmpeg_video(dt_encoder_t *enc, pid_t *pid) {
    int pipefd[2];
    if (pipe(pipefd) < 0) {
        fprintf(stderr, "Error: Failed to create pipe\n");
        return NULL;
    }

    *pid = fork();
    if (*pid < 0) {
        fprintf(stderr, "Error: Failed to fork\n");
        close(pipefd[0]);
        close(pipefd[1]);
        return NULL;
    }

    if (*pid == 0) {
        // Child process
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        close(pipefd[1]);

        char video_size[32];
        snprintf(video_size, sizeof(video_size), "%dx%d", enc->width, enc->height);

        // Use same filtergraph as reference TAV encoder
        char vf[256];
        snprintf(vf, sizeof(vf),
                 "scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d%s",
                 enc->width, enc->height, enc->width, enc->height,
                 enc->is_interlaced ? ",setfield=tff" : "");

        execlp("ffmpeg", "ffmpeg",
               "-hide_banner",
               "-i", enc->input_file,
               "-vf", vf,
               "-pix_fmt", "rgb24",
               "-f", "rawvideo",
               "-an",
               "-v", "warning",
               "-",
               (char*)NULL);

        fprintf(stderr, "Error: Failed to execute FFmpeg\n");
        exit(1);
    }

    close(pipefd[1]);
    return fdopen(pipefd[0], "rb");
}

static FILE *spawn_ffmpeg_audio(dt_encoder_t *enc, pid_t *pid) {
    int pipefd[2];
    if (pipe(pipefd) < 0) {
        fprintf(stderr, "Error: Failed to create pipe\n");
        return NULL;
    }

    *pid = fork();
    if (*pid < 0) {
        fprintf(stderr, "Error: Failed to fork\n");
        close(pipefd[0]);
        close(pipefd[1]);
        return NULL;
    }

    if (*pid == 0) {
        // Child process
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        close(pipefd[1]);

        execlp("ffmpeg", "ffmpeg",
               "-i", enc->input_file,
               "-f", "f32le",
               "-acodec", "pcm_f32le",
               "-ar", "32000",
               "-ac", "2",
               "-vn",
               "-v", "warning",
               "-",
               (char*)NULL);

        fprintf(stderr, "Error: Failed to execute FFmpeg\n");
        exit(1);
    }

    close(pipefd[1]);
    return fdopen(pipefd[0], "rb");
}

// =============================================================================
// Multithreading Support
// =============================================================================

/**
 * Worker thread context - passed to worker_thread_main.
 */
typedef struct {
    dt_encoder_t *enc;
    int thread_id;
} worker_context_t;

/**
 * Worker thread main function.
 * Continuously picks up jobs from the job pool and encodes them.
 */
static void *worker_thread_main(void *arg) {
    worker_context_t *wctx = (worker_context_t *)arg;
    dt_encoder_t *enc = wctx->enc;
    (void)wctx->thread_id;  // Unused but kept for debugging

    while (1) {
        pthread_mutex_lock(&enc->job_mutex);

        // Wait for a job or shutdown signal
        while (!enc->shutdown_workers) {
            // Look for a job slot that is ready to encode
            int found_job = -1;
            for (int i = 0; i < enc->num_threads; i++) {
                if (enc->gop_jobs[i].status == GOP_SLOT_READY) {
                    enc->gop_jobs[i].status = GOP_SLOT_ENCODING;
                    found_job = i;
                    break;
                }
            }

            if (found_job >= 0) {
                pthread_mutex_unlock(&enc->job_mutex);

                // Encode this GOP
                gop_job_t *job = &enc->gop_jobs[found_job];

                // Create thread-local encoder context
                tav_encoder_context_t *ctx = tav_encoder_create(&job->params);
                if (!ctx) {
                    fprintf(stderr, "Failed to create encoder for GOP %d\n", job->gop_index);
                    job->success = 0;
                } else {
                    // Encode video GOP
                    int result = tav_encoder_encode_gop(ctx,
                                                         (const uint8_t **)job->rgb_frames,
                                                         job->num_frames, job->frame_numbers,
                                                         &job->packet);
                    job->success = (result >= 0 && job->packet != NULL);

                    // Encode audio
                    if (job->success && job->audio_sample_count > 0) {
                        int max_index = tad32_quality_to_max_index(enc->quality_index);
                        job->tad_size = tad32_encode_chunk(job->audio_samples, job->audio_sample_count,
                                                           max_index, 1.0f, job->tad_output);
                    }

                    tav_encoder_free(ctx);
                }

                // Mark job as complete (reacquire lock for next iteration)
                pthread_mutex_lock(&enc->job_mutex);
                job->status = GOP_SLOT_COMPLETE;
                pthread_cond_broadcast(&enc->job_complete);
                // Keep lock held for next iteration of inner while loop
                continue;  // Look for more jobs
            }

            // No job found, wait for signal
            pthread_cond_wait(&enc->job_ready, &enc->job_mutex);
        }

        pthread_mutex_unlock(&enc->job_mutex);
        break;  // Shutdown
    }

    free(wctx);
    return NULL;
}

/**
 * Initialize multithreading resources.
 * Returns 0 on success, -1 on failure.
 */
static int init_threading(dt_encoder_t *enc) {
    if (enc->num_threads <= 0) {
        return 0;  // Single-threaded mode
    }

    // Initialize mutex and condition variables
    if (pthread_mutex_init(&enc->job_mutex, NULL) != 0) {
        fprintf(stderr, "Error: Failed to initialize job mutex\n");
        return -1;
    }
    if (pthread_cond_init(&enc->job_ready, NULL) != 0) {
        fprintf(stderr, "Error: Failed to initialize job_ready cond\n");
        pthread_mutex_destroy(&enc->job_mutex);
        return -1;
    }
    if (pthread_cond_init(&enc->job_complete, NULL) != 0) {
        fprintf(stderr, "Error: Failed to initialize job_complete cond\n");
        pthread_cond_destroy(&enc->job_ready);
        pthread_mutex_destroy(&enc->job_mutex);
        return -1;
    }

    // Allocate job slots (one per thread)
    enc->gop_jobs = calloc(enc->num_threads, sizeof(gop_job_t));
    if (!enc->gop_jobs) {
        fprintf(stderr, "Error: Failed to allocate job slots\n");
        pthread_cond_destroy(&enc->job_complete);
        pthread_cond_destroy(&enc->job_ready);
        pthread_mutex_destroy(&enc->job_mutex);
        return -1;
    }

    // Allocate worker thread handles
    enc->worker_threads = malloc(enc->num_threads * sizeof(pthread_t));
    if (!enc->worker_threads) {
        fprintf(stderr, "Error: Failed to allocate thread handles\n");
        free(enc->gop_jobs);
        pthread_cond_destroy(&enc->job_complete);
        pthread_cond_destroy(&enc->job_ready);
        pthread_mutex_destroy(&enc->job_mutex);
        return -1;
    }

    // Start worker threads
    enc->shutdown_workers = 0;
    for (int i = 0; i < enc->num_threads; i++) {
        worker_context_t *wctx = malloc(sizeof(worker_context_t));
        if (!wctx) {
            fprintf(stderr, "Error: Failed to allocate worker context\n");
            enc->shutdown_workers = 1;
            pthread_cond_broadcast(&enc->job_ready);
            for (int j = 0; j < i; j++) {
                pthread_join(enc->worker_threads[j], NULL);
            }
            free(enc->worker_threads);
            free(enc->gop_jobs);
            pthread_cond_destroy(&enc->job_complete);
            pthread_cond_destroy(&enc->job_ready);
            pthread_mutex_destroy(&enc->job_mutex);
            return -1;
        }
        wctx->enc = enc;
        wctx->thread_id = i;

        if (pthread_create(&enc->worker_threads[i], NULL, worker_thread_main, wctx) != 0) {
            fprintf(stderr, "Error: Failed to create worker thread %d\n", i);
            free(wctx);
            enc->shutdown_workers = 1;
            pthread_cond_broadcast(&enc->job_ready);
            for (int j = 0; j < i; j++) {
                pthread_join(enc->worker_threads[j], NULL);
            }
            free(enc->worker_threads);
            free(enc->gop_jobs);
            pthread_cond_destroy(&enc->job_complete);
            pthread_cond_destroy(&enc->job_ready);
            pthread_mutex_destroy(&enc->job_mutex);
            return -1;
        }
    }

    printf("Started %d worker threads for parallel GOP encoding\n", enc->num_threads);
    return 0;
}

/**
 * Shutdown multithreading resources.
 */
static void shutdown_threading(dt_encoder_t *enc) {
    if (enc->num_threads <= 0) {
        return;
    }

    // Signal workers to shutdown
    pthread_mutex_lock(&enc->job_mutex);
    enc->shutdown_workers = 1;
    pthread_cond_broadcast(&enc->job_ready);
    pthread_mutex_unlock(&enc->job_mutex);

    // Wait for all workers to finish
    for (int i = 0; i < enc->num_threads; i++) {
        pthread_join(enc->worker_threads[i], NULL);
    }

    // Free job slots (and any remaining resources)
    if (enc->gop_jobs) {
        for (int i = 0; i < enc->num_threads; i++) {
            if (enc->gop_jobs[i].packet) {
                tav_encoder_free_packet(enc->gop_jobs[i].packet);
            }
        }
        free(enc->gop_jobs);
        enc->gop_jobs = NULL;
    }

    if (enc->worker_threads) {
        free(enc->worker_threads);
        enc->worker_threads = NULL;
    }

    pthread_cond_destroy(&enc->job_complete);
    pthread_cond_destroy(&enc->job_ready);
    pthread_mutex_destroy(&enc->job_mutex);
}

// =============================================================================
// Main Encoding Loop
// =============================================================================

// Single-threaded encoding loop
static int run_encoder_st(dt_encoder_t *enc, FILE *video_pipe, FILE *audio_pipe,
                          pid_t video_pid __attribute__((unused)),
                          pid_t audio_pid __attribute__((unused))) {
    size_t frame_size = enc->width * enc->height * 3;
    double gop_duration = (double)DT_GOP_SIZE * enc->fps_den / enc->fps_num;
    size_t audio_samples_per_gop = (size_t)(AUDIO_SAMPLE_RATE * gop_duration) + 1024;

    // TAD output buffer
    size_t tad_buffer_size = audio_samples_per_gop * 2;
    uint8_t *tad_output = malloc(tad_buffer_size);

    enc->frame_number = 0;
    enc->gop_frame_count = 0;
    enc->current_timecode_ns = 0;

    clock_t start_time = clock();

    while (1) {
        if (enc->encode_limit > 0 && enc->frame_number >= enc->encode_limit) {
            break;
        }

        size_t bytes_read = fread(enc->gop_frames[enc->gop_frame_count], 1, frame_size, video_pipe);
        if (bytes_read < frame_size) {
            break;
        }

        enc->gop_frame_count++;
        enc->frame_number++;

        // Read corresponding audio
        double frame_duration = (double)enc->fps_den / enc->fps_num;
        size_t audio_samples_per_frame = (size_t)(AUDIO_SAMPLE_RATE * frame_duration);
        size_t audio_bytes = audio_samples_per_frame * 2 * sizeof(float);

        if (enc->audio_buffer_samples + audio_samples_per_frame > enc->audio_buffer_capacity) {
            size_t new_capacity = enc->audio_buffer_capacity * 2;
            float *new_buffer = realloc(enc->audio_buffer, new_capacity * 2 * sizeof(float));
            if (new_buffer) {
                enc->audio_buffer = new_buffer;
                enc->audio_buffer_capacity = new_capacity;
            }
        }

        size_t audio_read = fread(enc->audio_buffer + enc->audio_buffer_samples * 2,
                                  1, audio_bytes, audio_pipe);
        enc->audio_buffer_samples += audio_read / (2 * sizeof(float));

        // Encode GOP when full
        if (enc->gop_frame_count >= DT_GOP_SIZE) {
            tav_encoder_packet_t *video_packet = NULL;
            int frame_numbers[DT_GOP_SIZE];
            for (int i = 0; i < DT_GOP_SIZE; i++) {
                frame_numbers[i] = enc->frame_number - DT_GOP_SIZE + i;
            }

            int result = tav_encoder_encode_gop(enc->video_ctx,
                                                 (const uint8_t **)enc->gop_frames,
                                                 DT_GOP_SIZE, frame_numbers, &video_packet);

            if (result < 0 || !video_packet) {
                fprintf(stderr, "Error: Video encoding failed\n");
                break;
            }

            int max_index = tad32_quality_to_max_index(enc->quality_index);
            size_t tad_size = tad32_encode_chunk(enc->audio_buffer, enc->audio_buffer_samples,
                                                  max_index, 1.0f, tad_output);

            write_packet(enc, enc->current_timecode_ns,
                         tad_output, tad_size,
                         video_packet->data, video_packet->size,
                         DT_GOP_SIZE, (uint16_t)enc->audio_buffer_samples, max_index);

            enc->current_timecode_ns += (uint64_t)(gop_duration * 1e9);
            enc->frames_encoded += DT_GOP_SIZE;
            enc->gop_frame_count = 0;
            enc->audio_buffer_samples = 0;

            tav_encoder_free_packet(video_packet);

            // Display progress
            clock_t now = clock();
            double elapsed = (double)(now - start_time) / CLOCKS_PER_SEC;
            double fps = elapsed > 0 ? (double)enc->frame_number / elapsed : 0.0;
            double duration = (double)enc->frame_number * enc->fps_den / enc->fps_num;
            double bitrate = duration > 0 ? (ftell(enc->output_fp) * 8.0) / duration / 1000.0 : 0.0;
            long gop_count = enc->frame_number / DT_GOP_SIZE;
            size_t total_kb = ftell(enc->output_fp) / 1024;

            printf("\rFrame %d | GOPs: %ld | %.1f fps | %.1f kbps | %zu KB    ",
                   enc->frame_number, gop_count, fps, bitrate, total_kb);
            fflush(stdout);
        }
    }

    // Handle partial final GOP
    if (enc->gop_frame_count > 0) {
        tav_encoder_packet_t *video_packet = NULL;
        int *frame_numbers = malloc(enc->gop_frame_count * sizeof(int));
        for (int i = 0; i < enc->gop_frame_count; i++) {
            frame_numbers[i] = enc->frame_number - enc->gop_frame_count + i;
        }

        int result = tav_encoder_encode_gop(enc->video_ctx,
                                             (const uint8_t **)enc->gop_frames,
                                             enc->gop_frame_count, frame_numbers, &video_packet);

        if (result >= 0 && video_packet) {
            int max_index = tad32_quality_to_max_index(enc->quality_index);
            size_t tad_size = tad32_encode_chunk(enc->audio_buffer, enc->audio_buffer_samples,
                                                  max_index, 1.0f, tad_output);

            write_packet(enc, enc->current_timecode_ns,
                         tad_output, tad_size,
                         video_packet->data, video_packet->size,
                         enc->gop_frame_count, (uint16_t)enc->audio_buffer_samples, max_index);

            enc->frames_encoded += enc->gop_frame_count;
            tav_encoder_free_packet(video_packet);
        }
        free(frame_numbers);
    }

    free(tad_output);
    return 0;
}

// Multithreaded encoding loop
static int run_encoder_mt(dt_encoder_t *enc, FILE *video_pipe, FILE *audio_pipe,
                          pid_t video_pid __attribute__((unused)),
                          pid_t audio_pid __attribute__((unused))) {
    size_t frame_size = enc->width * enc->height * 3;
    double gop_duration = (double)DT_GOP_SIZE * enc->fps_den / enc->fps_num;
    // Calculate audio buffer size with generous padding to handle FFmpeg's audio delivery
    // FFmpeg may deliver all audio for a GOP in the first read, so we need space for:
    // 1. The expected GOP audio: AUDIO_SAMPLE_RATE * gop_duration
    // 2. Worst-case per-frame variations: DT_GOP_SIZE * samples_per_frame
    size_t expected_samples = (size_t)(AUDIO_SAMPLE_RATE * gop_duration);
    size_t samples_per_frame = (size_t)(AUDIO_SAMPLE_RATE * enc->fps_den / enc->fps_num) + 1;
    size_t audio_samples_per_gop = expected_samples + (DT_GOP_SIZE * samples_per_frame);
    size_t tad_buffer_size = audio_samples_per_gop * 2;

    // Initialize threading
    if (init_threading(enc) < 0) {
        return -1;
    }

    // Allocate per-slot frame buffers and audio buffers
    for (int slot = 0; slot < enc->num_threads; slot++) {
        enc->gop_jobs[slot].rgb_frames = malloc(DT_GOP_SIZE * sizeof(uint8_t*));
        enc->gop_jobs[slot].frame_numbers = malloc(DT_GOP_SIZE * sizeof(int));
        enc->gop_jobs[slot].audio_samples = malloc(audio_samples_per_gop * 2 * sizeof(float));
        enc->gop_jobs[slot].tad_output = malloc(tad_buffer_size);

        if (!enc->gop_jobs[slot].rgb_frames || !enc->gop_jobs[slot].frame_numbers ||
            !enc->gop_jobs[slot].audio_samples || !enc->gop_jobs[slot].tad_output) {
            fprintf(stderr, "Error: Failed to allocate job slot %d buffers\n", slot);
            shutdown_threading(enc);
            return -1;
        }

        for (int f = 0; f < DT_GOP_SIZE; f++) {
            enc->gop_jobs[slot].rgb_frames[f] = malloc(frame_size);
            if (!enc->gop_jobs[slot].rgb_frames[f]) {
                fprintf(stderr, "Error: Failed to allocate frame buffer for slot %d\n", slot);
                shutdown_threading(enc);
                return -1;
            }
        }

        // Copy encoder params for thread safety
        enc->gop_jobs[slot].params = enc->enc_params;
        enc->gop_jobs[slot].status = GOP_SLOT_EMPTY;
        enc->gop_jobs[slot].num_frames = 0;
        enc->gop_jobs[slot].audio_sample_count = 0;
        enc->gop_jobs[slot].tad_size = 0;
        enc->gop_jobs[slot].packet = NULL;
        enc->gop_jobs[slot].success = 0;
    }

    printf("Encoding frames with %d threads...\n", enc->num_threads);
    clock_t start_time = clock();

    int current_slot = 0;
    int next_gop_to_write = 0;
    int current_gop_index = 0;
    int frames_in_current_gop = 0;
    int encoding_error = 0;
    int eof_reached = 0;
    enc->current_timecode_ns = 0;

    while (!encoding_error && !eof_reached) {
        // Step 1: Try to write any completed GOPs in order
        pthread_mutex_lock(&enc->job_mutex);
        while (!encoding_error) {
            int found = -1;
            for (int i = 0; i < enc->num_threads; i++) {
                if (enc->gop_jobs[i].status == GOP_SLOT_COMPLETE &&
                    enc->gop_jobs[i].gop_index == next_gop_to_write) {
                    found = i;
                    break;
                }
            }

            if (found < 0) break;

            gop_job_t *job = &enc->gop_jobs[found];
            pthread_mutex_unlock(&enc->job_mutex);

            // Write this GOP
            if (job->success && job->packet) {
                int max_index = tad32_quality_to_max_index(enc->quality_index);
                write_packet(enc, enc->current_timecode_ns,
                             job->tad_output, job->tad_size,
                             job->packet->data, job->packet->size,
                             job->num_frames, (uint16_t)job->audio_sample_count, max_index);

                enc->current_timecode_ns += (uint64_t)(gop_duration * 1e9);
                enc->frames_encoded += job->num_frames;

                tav_encoder_free_packet(job->packet);
                job->packet = NULL;

                // Display progress
                clock_t now = clock();
                double elapsed = (double)(now - start_time) / CLOCKS_PER_SEC;
                double fps = elapsed > 0 ? (double)enc->frames_encoded / elapsed : 0.0;
                double duration = (double)enc->frames_encoded * enc->fps_den / enc->fps_num;
                double bitrate = duration > 0 ? (ftell(enc->output_fp) * 8.0) / duration / 1000.0 : 0.0;
                long gop_count = enc->frames_encoded / DT_GOP_SIZE;
                size_t total_kb = ftell(enc->output_fp) / 1024;

                printf("\rFrame %lu | GOPs: %ld | %.1f fps | %.1f kbps | %zu KB    ",
                       enc->frames_encoded, gop_count, fps, bitrate, total_kb);
                fflush(stdout);
            }

            pthread_mutex_lock(&enc->job_mutex);
            job->status = GOP_SLOT_EMPTY;
            job->num_frames = 0;
            job->audio_sample_count = 0;
            job->tad_size = 0;
            next_gop_to_write++;
        }
        pthread_mutex_unlock(&enc->job_mutex);

        if (encoding_error || eof_reached) break;

        // Step 2: Fill current slot with frames
        gop_job_t *slot = &enc->gop_jobs[current_slot];

        // Wait for slot to be empty
        pthread_mutex_lock(&enc->job_mutex);
        while (slot->status != GOP_SLOT_EMPTY && !enc->shutdown_workers) {
            // While waiting, check if we can write any completed GOPs
            int wrote_something = 0;
            for (int i = 0; i < enc->num_threads; i++) {
                if (enc->gop_jobs[i].status == GOP_SLOT_COMPLETE &&
                    enc->gop_jobs[i].gop_index == next_gop_to_write) {
                    gop_job_t *job = &enc->gop_jobs[i];
                    pthread_mutex_unlock(&enc->job_mutex);

                    if (job->success && job->packet) {
                        int max_index = tad32_quality_to_max_index(enc->quality_index);
                        write_packet(enc, enc->current_timecode_ns,
                                     job->tad_output, job->tad_size,
                                     job->packet->data, job->packet->size,
                                     job->num_frames, (uint16_t)job->audio_sample_count, max_index);

                        enc->current_timecode_ns += (uint64_t)(gop_duration * 1e9);
                        enc->frames_encoded += job->num_frames;

                        tav_encoder_free_packet(job->packet);
                        job->packet = NULL;
                    }

                    pthread_mutex_lock(&enc->job_mutex);
                    job->status = GOP_SLOT_EMPTY;
                    job->num_frames = 0;
                    job->audio_sample_count = 0;
                    job->tad_size = 0;
                    next_gop_to_write++;
                    wrote_something = 1;
                    break;
                }
            }
            if (!wrote_something) {
                pthread_cond_wait(&enc->job_complete, &enc->job_mutex);
            }
        }
        pthread_mutex_unlock(&enc->job_mutex);

        // Reset audio accumulator only when starting a fresh GOP
        if (frames_in_current_gop == 0) {
            slot->audio_sample_count = 0;
        }

        // Read frames into the slot
        while (frames_in_current_gop < DT_GOP_SIZE && !eof_reached) {
            if (enc->encode_limit > 0 && enc->frame_number >= enc->encode_limit) {
                eof_reached = 1;
                break;
            }

            size_t bytes_read = fread(slot->rgb_frames[frames_in_current_gop], 1, frame_size, video_pipe);
            if (bytes_read < frame_size) {
                eof_reached = 1;
                break;
            }

            slot->frame_numbers[frames_in_current_gop] = enc->frame_number;
            enc->frame_number++;
            frames_in_current_gop++;

            // Read corresponding audio - read whatever is available up to buffer capacity
            // Note: FFmpeg may buffer audio, so the first read might get multiple frames worth
            size_t audio_buffer_capacity_samples = audio_samples_per_gop;
            size_t audio_space_remaining = audio_buffer_capacity_samples - slot->audio_sample_count;

            if (audio_space_remaining > 0) {
                // Read up to the remaining buffer space
                size_t max_read_bytes = audio_space_remaining * 2 * sizeof(float);
                size_t audio_read = fread(slot->audio_samples + slot->audio_sample_count * 2,
                                          1, max_read_bytes, audio_pipe);
                slot->audio_sample_count += audio_read / (2 * sizeof(float));
            }

            // Submit GOP when full
            if (frames_in_current_gop >= DT_GOP_SIZE) {
                slot->num_frames = frames_in_current_gop;
                slot->gop_index = current_gop_index;

                pthread_mutex_lock(&enc->job_mutex);
                slot->status = GOP_SLOT_READY;
                pthread_cond_broadcast(&enc->job_ready);
                pthread_mutex_unlock(&enc->job_mutex);

                current_slot = (current_slot + 1) % enc->num_threads;
                current_gop_index++;
                frames_in_current_gop = 0;
                break;  // Exit frame-reading loop to wait for next available slot
            }
        }
    }

    // Submit any partial GOP at EOF
    if (frames_in_current_gop > 0) {
        gop_job_t *slot = &enc->gop_jobs[current_slot];
        slot->num_frames = frames_in_current_gop;
        slot->gop_index = current_gop_index;

        pthread_mutex_lock(&enc->job_mutex);
        slot->status = GOP_SLOT_READY;
        pthread_cond_broadcast(&enc->job_ready);
        pthread_mutex_unlock(&enc->job_mutex);

        current_gop_index++;
    }

    // Wait for all remaining GOPs to complete and write them
    while (!encoding_error && next_gop_to_write < current_gop_index) {
        pthread_mutex_lock(&enc->job_mutex);

        int found = -1;
        while (found < 0 && !encoding_error) {
            for (int i = 0; i < enc->num_threads; i++) {
                if (enc->gop_jobs[i].status == GOP_SLOT_COMPLETE &&
                    enc->gop_jobs[i].gop_index == next_gop_to_write) {
                    found = i;
                    break;
                }
            }
            if (found < 0) {
                pthread_cond_wait(&enc->job_complete, &enc->job_mutex);
            }
        }

        if (found >= 0) {
            gop_job_t *job = &enc->gop_jobs[found];
            pthread_mutex_unlock(&enc->job_mutex);

            if (job->success && job->packet) {
                int max_index = tad32_quality_to_max_index(enc->quality_index);
                write_packet(enc, enc->current_timecode_ns,
                             job->tad_output, job->tad_size,
                             job->packet->data, job->packet->size,
                             job->num_frames, (uint16_t)job->audio_sample_count, max_index);

                enc->current_timecode_ns += (uint64_t)(gop_duration * 1e9);
                enc->frames_encoded += job->num_frames;

                tav_encoder_free_packet(job->packet);
                job->packet = NULL;
            }

            pthread_mutex_lock(&enc->job_mutex);
            job->status = GOP_SLOT_EMPTY;
            job->num_frames = 0;
            job->audio_sample_count = 0;
            job->tad_size = 0;
            next_gop_to_write++;
            pthread_mutex_unlock(&enc->job_mutex);
        } else {
            pthread_mutex_unlock(&enc->job_mutex);
        }
    }

    // Free per-slot buffers before shutdown
    for (int slot = 0; slot < enc->num_threads; slot++) {
        if (enc->gop_jobs[slot].rgb_frames) {
            for (int f = 0; f < DT_GOP_SIZE; f++) {
                free(enc->gop_jobs[slot].rgb_frames[f]);
            }
            free(enc->gop_jobs[slot].rgb_frames);
        }
        free(enc->gop_jobs[slot].frame_numbers);
        free(enc->gop_jobs[slot].audio_samples);
        free(enc->gop_jobs[slot].tad_output);
    }

    shutdown_threading(enc);

    return encoding_error ? -1 : 0;
}

static int run_encoder(dt_encoder_t *enc) {
    // Open output file
    enc->output_fp = fopen(enc->output_file, "wb");
    if (!enc->output_fp) {
        fprintf(stderr, "Error: Cannot create output file: %s\n", enc->output_file);
        return -1;
    }

    // Set up video encoder params
    tav_encoder_params_init(&enc->enc_params, enc->width, enc->height);
    enc->enc_params.fps_num = enc->fps_num;
    enc->enc_params.fps_den = enc->fps_den;
    enc->enc_params.wavelet_type = 1;           // CDF 9/7
    enc->enc_params.temporal_wavelet = 255;     // Haar
    enc->enc_params.decomp_levels = DT_SPATIAL_LEVELS;
    enc->enc_params.temporal_levels = DT_TEMPORAL_LEVELS;
    enc->enc_params.enable_temporal_dwt = 1;
    enc->enc_params.gop_size = DT_GOP_SIZE;
    enc->enc_params.quality_level = enc->quality_index;
    enc->enc_params.quantiser_y = QUALITY_Y[enc->quality_index];
    enc->enc_params.quantiser_co = QUALITY_CO[enc->quality_index];
    enc->enc_params.quantiser_cg = QUALITY_CG[enc->quality_index];
    enc->enc_params.entropy_coder = 1;          // EZBC
    enc->enc_params.encoder_preset = 0x01;      // Sports mode
    enc->enc_params.monoblock = 1;              // Force monoblock
    enc->enc_params.verbose = enc->verbose;

    // For single-threaded mode, create a context to validate params
    enc->video_ctx = tav_encoder_create(&enc->enc_params);
    if (!enc->video_ctx) {
        fprintf(stderr, "Error: Cannot create video encoder\n");
        fclose(enc->output_fp);
        return -1;
    }

    printf("Forced Monoblock mode (--monoblock)\n");

    // Get actual parameters (may have been adjusted)
    tav_encoder_get_params(enc->video_ctx, &enc->enc_params);

    if (enc->verbose) {
        printf("Auto-selected Haar temporal wavelet with sports mode (resolution: %dx%d = %d pixels, quantiser_y = %d)\n",
               enc->width, enc->height, enc->width * enc->height, enc->enc_params.quantiser_y);
    }

    // Spawn FFmpeg for video
    pid_t video_pid;
    FILE *video_pipe = spawn_ffmpeg_video(enc, &video_pid);
    if (!video_pipe) {
        tav_encoder_free(enc->video_ctx);
        fclose(enc->output_fp);
        return -1;
    }

    // Spawn FFmpeg for audio
    pid_t audio_pid;
    FILE *audio_pipe = spawn_ffmpeg_audio(enc, &audio_pid);
    if (!audio_pipe) {
        fclose(video_pipe);
        waitpid(video_pid, NULL, 0);
        tav_encoder_free(enc->video_ctx);
        fclose(enc->output_fp);
        return -1;
    }

    // Allocate frame buffers for single-threaded mode
    size_t frame_size = enc->width * enc->height * 3;
    enc->gop_frames = malloc(DT_GOP_SIZE * sizeof(uint8_t *));
    for (int i = 0; i < DT_GOP_SIZE; i++) {
        enc->gop_frames[i] = malloc(frame_size);
    }

    // Audio buffer (enough for one GOP worth of audio)
    double gop_duration = (double)DT_GOP_SIZE * enc->fps_den / enc->fps_num;
    size_t audio_samples_per_gop = (size_t)(AUDIO_SAMPLE_RATE * gop_duration) + 1024;
    enc->audio_buffer = malloc(audio_samples_per_gop * 2 * sizeof(float));
    enc->audio_buffer_capacity = audio_samples_per_gop;
    enc->audio_buffer_samples = 0;

    clock_t start_time = clock();

    // Run encoding
    if (enc->num_threads > 0) {
        printf("Multithreaded mode: %d threads\n", enc->num_threads);
        run_encoder_mt(enc, video_pipe, audio_pipe, video_pid, audio_pid);
    } else {
        printf("Single-threaded mode\n");
        run_encoder_st(enc, video_pipe, audio_pipe, video_pid, audio_pid);
    }

    clock_t end_time = clock();
    double elapsed = (double)(end_time - start_time) / CLOCKS_PER_SEC;

    // Print statistics
    printf("\nEncoding complete%s:\n", enc->num_threads > 0 ? " (multithreaded)" : "");
    printf("  Frames: %lu\n", enc->frames_encoded);
    printf("  GOPs: %lu\n", enc->packets_written);
    printf("  Output size: %lu bytes (%.2f MB)\n", enc->bytes_written, enc->bytes_written / 1048576.0);
    printf("  Encoding speed: %.1f fps\n", enc->frames_encoded / elapsed);
    if (enc->frames_encoded > 0) {
        printf("  Bitrate: %.1f kbps\n",
               enc->bytes_written * 8.0 / (enc->frames_encoded * enc->fps_den / enc->fps_num) / 1000.0);
    }

    // Cleanup
    free(enc->audio_buffer);
    for (int i = 0; i < DT_GOP_SIZE; i++) {
        free(enc->gop_frames[i]);
    }
    free(enc->gop_frames);

    fclose(video_pipe);
    fclose(audio_pipe);
    waitpid(video_pid, NULL, 0);
    waitpid(audio_pid, NULL, 0);

    tav_encoder_free(enc->video_ctx);
    fclose(enc->output_fp);

    return 0;
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char **argv) {
    dt_encoder_t enc;
    memset(&enc, 0, sizeof(enc));

    // Defaults
    enc.width = DT_WIDTH;
    enc.height = DT_HEIGHT_NTSC;
    enc.fps_num = 24;
    enc.fps_den = 1;
    enc.quality_index = 3;
    enc.is_pal = 0;
    enc.is_interlaced = 0;
    enc.num_threads = get_default_thread_count();  // Default: min(8, available CPUs)

    // Initialize FEC libraries
    rs_init();
    ldpc_init();
    ldpc_p_init();  // LDPC payload codec

    static struct option long_options[] = {
        {"input",        required_argument, 0, 'i'},
        {"output",       required_argument, 0, 'o'},
        {"quality",      required_argument, 0, 'q'},
        {"threads",      required_argument, 0, 't'},
        {"ntsc",         no_argument,       0, 'N'},
        {"pal",          no_argument,       0, 'P'},
        {"interlaced",   no_argument,       0, 'I'},
        {"ldpc-payload", no_argument,       0, 'D'},
        {"encode-limit", required_argument, 0, 'L'},
        {"verbose",      no_argument,       0, 'v'},
        {"help",         no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "i:o:q:t:vhNPI", long_options, NULL)) != -1) {
        switch (opt) {
            case 'i':
                enc.input_file = optarg;
                break;
            case 'o':
                enc.output_file = optarg;
                break;
            case 'q':
                enc.quality_index = atoi(optarg);
                if (enc.quality_index < 0) enc.quality_index = 0;
                if (enc.quality_index > 5) enc.quality_index = 5;
                break;
            case 't': {
                int threads = atoi(optarg);
                if (threads < 0) {
                    fprintf(stderr, "Error: Thread count must be positive\n");
                    return 1;
                }
                // Both 0 and 1 mean single-threaded (use value 0 internally)
                enc.num_threads = (threads <= 1) ? 0 : threads;
                if (enc.num_threads > 16) enc.num_threads = 16;  // Cap at 16
                break;
            }
            case 'N':
                enc.is_pal = 0;
                enc.height = DT_HEIGHT_NTSC;
                break;
            case 'P':
                enc.is_pal = 1;
                enc.height = DT_HEIGHT_PAL;
                break;
            case 'I':
                enc.is_interlaced = 1;
                break;
            case 'D':
                enc.fec_mode = FEC_MODE_LDPC;
                break;
            case 'L':
                enc.encode_limit = atoi(optarg);
                break;
            case 'v':
                enc.verbose = 1;
                break;
            case 'h':
                print_usage(argv[0]);
                return 0;
            default:
                print_usage(argv[0]);
                return 1;
        }
    }

    if (!enc.input_file || !enc.output_file) {
        fprintf(stderr, "Error: Input and output files are required\n");
        print_usage(argv[0]);
        return 1;
    }

    // Probe input file for framerate
    char probe_cmd[4096];
    snprintf(probe_cmd, sizeof(probe_cmd),
             "ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nw=1:nk=1 '%s'",
             enc.input_file);

    FILE *probe = popen(probe_cmd, "r");
    if (probe) {
        char line[256];
        if (fgets(line, sizeof(line), probe)) {
            if (sscanf(line, "%d/%d", &enc.fps_num, &enc.fps_den) != 2) {
                enc.fps_num = 24;
                enc.fps_den = 1;
            }
        }
        pclose(probe);
    }

    printf("\nTAV-DT Encoder (Revised Spec 2025-12-11)\n");
    printf("  Format: %s %s\n", enc.is_pal ? "PAL" : "NTSC",
           enc.is_interlaced ? "interlaced" : "progressive");
    printf("  Resolution: %dx%d (internal: %dx%d)\n", enc.width, enc.height,
           enc.width, enc.is_interlaced ? enc.height / 2 : enc.height);
    printf("  Framerate: %d/%d\n", enc.fps_num, enc.fps_den);
    printf("  Quality: %d\n", enc.quality_index);
    printf("  GOP size: %d\n", DT_GOP_SIZE);
    printf("  Payload FEC: %s\n", enc.fec_mode == FEC_MODE_LDPC ? "LDPC(255,223)" : "RS(255,223)");
    printf("  Threads: %d%s\n", enc.num_threads > 0 ? enc.num_threads : 1,
           enc.num_threads > 0 ? " (multithreaded)" : " (single-threaded)");
    printf("  Header sizes: main=%dB tad=%dB tav=%dB (after LDPC)\n",
           DT_MAIN_HEADER_SIZE * 2, DT_TAD_HEADER_SIZE * 2, DT_TAV_HEADER_SIZE * 2);

    return run_encoder(&enc);
}
