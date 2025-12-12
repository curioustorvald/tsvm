/**
 * TAV-DT Decoder - Digital Tape Format Decoder
 *
 * Decodes TAV-DT format with forward error correction.
 *
 * TAV-DT is a packetised streaming format designed for digital tape/broadcast:
 * - Fixed dimensions: 720x480 (NTSC) or 720x576 (PAL)
 * - 16-frame GOPs with 9/7 spatial wavelet, Haar temporal
 * - Mandatory TAD audio
 * - LDPC rate 1/2 for headers, Reed-Solomon (255,223) for payloads
 *
 * Packet structure (revised 2025-12-11):
 * - Main header: 24 bytes → 48 bytes LDPC encoded
 *   (sync + fps + flags + reserved + size + crc + timecode + offset_to_video)
 * - TAD subpacket: header (10→20 bytes LDPC) + RS-encoded payload
 * - TAV subpacket: header (8→16 bytes LDPC) + RS-encoded payload
 * - No packet type bytes - always audio then video
 *
 * Created by CuriousTorvald and Claude on 2025-12-09.
 * Revised 2025-12-11 for updated TAV-DT specification.
 */

#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <getopt.h>
#include <unistd.h>
#include <sys/wait.h>
#include <signal.h>
#include <time.h>
#include <pthread.h>

#include "tav_video_decoder.h"
#include "decoder_tad.h"
#include "reed_solomon.h"
#include "ldpc.h"

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
#define DT_SPATIAL_LEVELS  4
#define DT_TEMPORAL_LEVELS 2

// Header sizes (before LDPC encoding)
#define DT_MAIN_HEADER_SIZE   28   // sync(4) + fps(1) + flags(1) + reserved(2) + size(4) + crc(4) + timecode(8) + offset(4)
#define DT_TAD_HEADER_SIZE    10   // sample_count(2) + quant_bits(1) + compressed_size(4) + rs_block_count(3)
#define DT_TAV_HEADER_SIZE    8    // gop_size(1) + compressed_size(4) + rs_block_count(3)

// Quality level to quantiser mapping (must match encoder)
static const int QUALITY_Y[]  = {79, 47, 23, 11, 5, 2};
static const int QUALITY_CO[] = {123, 108, 91, 76, 59, 29};
static const int QUALITY_CG[] = {148, 133, 113, 99, 76, 39};

#define MAX_PATH 4096
#define MAX_DECODE_THREADS 16

// =============================================================================
// Multithreading Structures
// =============================================================================

#define DECODE_SLOT_EMPTY      0
#define DECODE_SLOT_PENDING    1
#define DECODE_SLOT_PROCESSING 2
#define DECODE_SLOT_DONE       3

// GOP decode job structure
typedef struct {
    // Input
    uint8_t *compressed_data;      // Raw GOP data to decode (owned by job)
    size_t compressed_size;
    int gop_size;                  // Number of frames in this GOP
    int job_id;                    // Sequential job ID for ordering output

    // Output
    uint8_t **rgb_frames;          // Decoded RGB24 frames [gop_size]
    size_t frame_size;             // Size of each frame in bytes
    int decode_result;             // 0 = success, -1 = error

    // Status
    volatile int status;           // DECODE_SLOT_EMPTY, PENDING, or DONE
} gop_decode_job_t;

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
// Decoder Context
// =============================================================================

typedef struct {
    // Input/output
    char *input_file;
    char *output_file;
    FILE *input_fp;

    // FFmpeg integration
    pid_t ffmpeg_pid;
    FILE *video_pipe;
    char audio_temp_file[MAX_PATH];
    FILE *audio_temp_fp;
    char video_temp_file[MAX_PATH];
    FILE *video_temp_fp;

    // Video parameters (derived from first packet)
    int width;
    int height;
    int framerate;
    int is_interlaced;
    int is_ntsc_framerate;
    int quality_index;
    int is_pal;

    // Video decoder context
    tav_video_context_t *video_ctx;

    // Statistics
    uint64_t packets_processed;
    uint64_t frames_decoded;
    uint64_t bytes_read;
    uint64_t crc_errors;
    uint64_t fec_corrections;
    uint64_t sync_losses;

    // Options
    int verbose;
    int dump_mode;  // Just dump packets, don't decode

    // Multithreading
    int num_threads;
    int num_slots;
    gop_decode_job_t *slots;
    tav_video_context_t **worker_video_ctx;  // Per-thread decoder contexts
    pthread_t *worker_threads;
    pthread_mutex_t mutex;
    pthread_cond_t cond_job_available;
    pthread_cond_t cond_slot_free;
    volatile int threads_should_exit;
    volatile int next_write_slot;      // Next slot to write to output
    volatile int jobs_submitted;
    volatile int jobs_completed;

    // Timing
    time_t start_time;
} dt_decoder_t;

// =============================================================================
// Utility Functions
// =============================================================================

static void print_usage(const char *program) {
    printf("TAV-DT Decoder - Digital Tape Format with FEC\n");
    printf("\nUsage: %s -i input.tavdt -o output.mkv [options]\n\n", program);
    printf("Required:\n");
    printf("  -i, --input FILE     Input TAV-DT file\n");
    printf("  -o, --output FILE    Output video file (FFV1/MKV)\n");
    printf("\nOptions:\n");
    printf("  -t, --threads N      Number of decoder threads (default: min(8, available CPUs))\n");
    printf("                       0 or 1 = single-threaded, 2-16 = multithreaded\n");
    printf("  --dump               Dump packet info without decoding\n");
    printf("  -v, --verbose        Verbose output\n");
    printf("  --help               Show this help\n");
}

static void generate_random_filename(char *filename, size_t size) {
    static int seeded = 0;
    if (!seeded) {
        srand((unsigned int)time(NULL));
        seeded = 1;
    }

    const char charset[] = "0123456789abcdefghijklmnopqrstuvwxyz";
    snprintf(filename, size, "/tmp/tavdt_dec_");
    size_t prefix_len = strlen(filename);
    for (int i = 0; i < 16; i++) {
        filename[prefix_len + i] = charset[rand() % (sizeof(charset) - 1)];
    }
    filename[prefix_len + 16] = '\0';
}

// =============================================================================
// Sync Pattern Search
// =============================================================================

static int find_sync_pattern(dt_decoder_t *dec) {
    uint8_t sync_bytes[4] = {0};
    uint8_t byte;

    // NTSC and PAL sync patterns as byte arrays (big endian)
    const uint8_t ntsc_sync[4] = {0xE3, 0x53, 0x7A, 0x1F};
    const uint8_t pal_sync[4] = {0xD1, 0x93, 0xA7, 0x45};

    // Sliding window search
    while (fread(&byte, 1, 1, dec->input_fp) == 1) {
        dec->bytes_read++;

        // Shift window
        sync_bytes[0] = sync_bytes[1];
        sync_bytes[1] = sync_bytes[2];
        sync_bytes[2] = sync_bytes[3];
        sync_bytes[3] = byte;

        // Check NTSC sync
        if (memcmp(sync_bytes, ntsc_sync, 4) == 0) {
            dec->is_pal = 0;
            // Seek back to start of sync pattern
            fseek(dec->input_fp, -4, SEEK_CUR);
            dec->bytes_read -= 4;
            return 0;
        }

        // Check PAL sync
        if (memcmp(sync_bytes, pal_sync, 4) == 0) {
            dec->is_pal = 1;
            // Seek back to start of sync pattern
            fseek(dec->input_fp, -4, SEEK_CUR);
            dec->bytes_read -= 4;
            return 0;
        }
    }

    return -1;  // EOF
}

// =============================================================================
// Header Decoding
// =============================================================================

typedef struct {
    uint32_t sync_pattern;
    uint8_t framerate;
    uint8_t flags;
    uint16_t reserved;
    uint32_t packet_size;
    uint32_t crc32;
    uint64_t timecode_ns;
    uint32_t offset_to_video;
} dt_packet_header_t;

static int read_and_decode_header(dt_decoder_t *dec, dt_packet_header_t *header) {
    // Read LDPC-encoded header (56 bytes = 28 bytes * 2)
    uint8_t encoded_header[DT_MAIN_HEADER_SIZE * 2];
    size_t bytes_read = fread(encoded_header, 1, DT_MAIN_HEADER_SIZE * 2, dec->input_fp);
    if (bytes_read < DT_MAIN_HEADER_SIZE * 2) return -1;
    dec->bytes_read += DT_MAIN_HEADER_SIZE * 2;

    // LDPC decode header (56 bytes -> 28 bytes)
    uint8_t decoded_header[DT_MAIN_HEADER_SIZE];
    int ldpc_result = ldpc_decode(encoded_header, DT_MAIN_HEADER_SIZE * 2, decoded_header);
    if (ldpc_result < 0) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: LDPC decode failed for main header\n");
        }
        // Try to use raw data anyway (first half)
        memcpy(decoded_header, encoded_header, DT_MAIN_HEADER_SIZE);
    } else if (ldpc_result > 0) {
        dec->fec_corrections++;
    }

    // Parse header fields
    header->sync_pattern = ((uint32_t)decoded_header[0] << 24) | ((uint32_t)decoded_header[1] << 16) |
                           ((uint32_t)decoded_header[2] << 8) | decoded_header[3];
    header->framerate = decoded_header[4];
    header->flags = decoded_header[5];
    header->reserved = decoded_header[6] | ((uint16_t)decoded_header[7] << 8);
    memcpy(&header->packet_size, decoded_header + 8, 4);
    memcpy(&header->crc32, decoded_header + 12, 4);
    memcpy(&header->timecode_ns, decoded_header + 16, 8);
    memcpy(&header->offset_to_video, decoded_header + 24, 4);

    // Verify sync pattern
    if (header->sync_pattern != TAV_DT_SYNC_NTSC && header->sync_pattern != TAV_DT_SYNC_PAL) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: Invalid sync pattern 0x%08X\n", header->sync_pattern);
        }
        dec->sync_losses++;
        return -2;
    }

    // Verify CRC-32 (covers first 12 bytes: sync + fps + flags + reserved + size)
    uint32_t calculated_crc = calculate_crc32(decoded_header, 12);
    if (calculated_crc != header->crc32) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: CRC mismatch (expected 0x%08X, got 0x%08X)\n",
                   header->crc32, calculated_crc);
        }
        dec->crc_errors++;
        // Continue anyway
    }

    // Update decoder state from first packet
    if (dec->packets_processed == 0) {
        dec->width = DT_WIDTH;
        dec->height = (header->sync_pattern == TAV_DT_SYNC_PAL) ? DT_HEIGHT_PAL : DT_HEIGHT_NTSC;
        dec->framerate = header->framerate;
        dec->is_interlaced = header->flags & 0x01;
        dec->is_ntsc_framerate = header->flags & 0x02;
        dec->quality_index = (header->flags >> 4) & 0x0F;
        if (dec->quality_index > 5) dec->quality_index = 5;

        if (dec->verbose) {
            printf("=== TAV-DT Stream Info ===\n");
            printf("  Format: %s %s\n",
                   (header->sync_pattern == TAV_DT_SYNC_NTSC) ? "NTSC" : "PAL",
                   dec->is_interlaced ? "interlaced" : "progressive");
            printf("  Resolution: %dx%d\n", dec->width, dec->height);
            printf("  Framerate: %d fps%s\n", dec->framerate,
                   dec->is_ntsc_framerate ? " (NTSC)" : "");
            printf("  Quality index: %d\n", dec->quality_index);
            printf("==========================\n\n");
        }
    }

    return 0;
}

// =============================================================================
// Multithreading Support
// =============================================================================

/**
 * Worker thread function for parallel GOP decoding
 */
static void *decoder_worker_thread(void *arg) {
    dt_decoder_t *dec = (dt_decoder_t *)arg;
    int thread_id = -1;

    // Find our thread ID
    for (int i = 0; i < dec->num_threads; i++) {
        if (pthread_equal(dec->worker_threads[i], pthread_self())) {
            thread_id = i;
            break;
        }
    }

    if (thread_id < 0) {
        fprintf(stderr, "Error: Worker thread couldn't find its ID\n");
        return NULL;
    }

    tav_video_context_t *video_ctx = dec->worker_video_ctx[thread_id];

    while (1) {
        pthread_mutex_lock(&dec->mutex);

        // Look for a pending job and claim it
        int job_idx = -1;
        for (int i = 0; i < dec->num_slots; i++) {
            if (dec->slots[i].status == DECODE_SLOT_PENDING) {
                job_idx = i;
                dec->slots[i].status = DECODE_SLOT_PROCESSING;  // Claim it - prevents other threads from picking it
                break;
            }
        }

        if (job_idx < 0) {
            // No jobs available, check if we should exit
            if (dec->threads_should_exit) {
                pthread_mutex_unlock(&dec->mutex);
                break;
            }

            // Wait for a job
            pthread_cond_wait(&dec->cond_job_available, &dec->mutex);
            pthread_mutex_unlock(&dec->mutex);
            continue;
        }

        pthread_mutex_unlock(&dec->mutex);

        // Decode this GOP
        gop_decode_job_t *job = &dec->slots[job_idx];

        // The compressed data format: [type(1)][gop_size(1)][size(4)][zstd_data]
        const uint8_t *zstd_data = job->compressed_data + 6;
        size_t zstd_size = job->compressed_size > 6 ? job->compressed_size - 6 : 0;

        job->decode_result = tav_video_decode_gop(video_ctx, zstd_data, zstd_size,
                                                   job->gop_size, job->rgb_frames);

        // Mark as done
        pthread_mutex_lock(&dec->mutex);
        job->status = DECODE_SLOT_DONE;
        dec->jobs_completed++;
        pthread_cond_broadcast(&dec->cond_slot_free);
        pthread_mutex_unlock(&dec->mutex);
    }

    return NULL;
}

/**
 * Initialize decoder threads
 */
static int init_decoder_threads(dt_decoder_t *dec) {
    if (dec->num_threads <= 1) {
        return 0;  // Single-threaded, nothing to initialize
    }

    dec->num_slots = dec->num_threads + 2;  // Pipeline with lookahead
    dec->slots = calloc(dec->num_slots, sizeof(gop_decode_job_t));
    if (!dec->slots) {
        fprintf(stderr, "Error: Cannot allocate decode slots\n");
        return -1;
    }

    // Initialize slots
    for (int i = 0; i < dec->num_slots; i++) {
        dec->slots[i].status = DECODE_SLOT_EMPTY;
        dec->slots[i].job_id = -1;
        dec->slots[i].rgb_frames = NULL;
        dec->slots[i].compressed_data = NULL;
    }

    // Create per-thread video decoder contexts
    dec->worker_video_ctx = calloc(dec->num_threads, sizeof(tav_video_context_t*));
    if (!dec->worker_video_ctx) {
        free(dec->slots);
        return -1;
    }

    tav_video_params_t vparams;
    vparams.width = dec->width;
    vparams.height = dec->is_interlaced ? dec->height / 2 : dec->height;
    vparams.decomp_levels = DT_SPATIAL_LEVELS;
    vparams.temporal_levels = DT_TEMPORAL_LEVELS;
    vparams.wavelet_filter = 1;     // CDF 9/7
    vparams.temporal_wavelet = 255; // Haar
    vparams.entropy_coder = 1;      // EZBC
    vparams.channel_layout = 0;     // YCoCg-R
    vparams.perceptual_tuning = 1;
    vparams.quantiser_y = QUALITY_Y[dec->quality_index];
    vparams.quantiser_co = QUALITY_CO[dec->quality_index];
    vparams.quantiser_cg = QUALITY_CG[dec->quality_index];
    vparams.encoder_preset = 0x01;  // Sports
    vparams.monoblock = 1;

    for (int i = 0; i < dec->num_threads; i++) {
        dec->worker_video_ctx[i] = tav_video_create(&vparams);
        if (!dec->worker_video_ctx[i]) {
            fprintf(stderr, "Error: Cannot create video decoder for thread %d\n", i);
            return -1;
        }
    }

    // Initialize threading primitives
    pthread_mutex_init(&dec->mutex, NULL);
    pthread_cond_init(&dec->cond_job_available, NULL);
    pthread_cond_init(&dec->cond_slot_free, NULL);
    dec->threads_should_exit = 0;
    dec->next_write_slot = 0;
    dec->jobs_submitted = 0;
    dec->jobs_completed = 0;

    // Create worker threads
    dec->worker_threads = calloc(dec->num_threads, sizeof(pthread_t));
    if (!dec->worker_threads) {
        return -1;
    }

    for (int i = 0; i < dec->num_threads; i++) {
        if (pthread_create(&dec->worker_threads[i], NULL, decoder_worker_thread, dec) != 0) {
            fprintf(stderr, "Error: Cannot create worker thread %d\n", i);
            return -1;
        }
    }

    if (dec->verbose) {
        printf("Initialized %d decoder threads\n", dec->num_threads);
    }

    return 0;
}

/**
 * Cleanup decoder threads
 */
static void cleanup_decoder_threads(dt_decoder_t *dec) {
    if (dec->num_threads <= 1) {
        return;
    }

    // Signal threads to exit
    pthread_mutex_lock(&dec->mutex);
    dec->threads_should_exit = 1;
    pthread_cond_broadcast(&dec->cond_job_available);
    pthread_mutex_unlock(&dec->mutex);

    // Wait for threads
    if (dec->worker_threads) {
        for (int i = 0; i < dec->num_threads; i++) {
            pthread_join(dec->worker_threads[i], NULL);
        }
        free(dec->worker_threads);
    }

    // Free video contexts
    if (dec->worker_video_ctx) {
        for (int i = 0; i < dec->num_threads; i++) {
            if (dec->worker_video_ctx[i]) {
                tav_video_free(dec->worker_video_ctx[i]);
            }
        }
        free(dec->worker_video_ctx);
    }

    // Free slots
    if (dec->slots) {
        for (int i = 0; i < dec->num_slots; i++) {
            if (dec->slots[i].rgb_frames) {
                for (int f = 0; f < dec->slots[i].gop_size; f++) {
                    free(dec->slots[i].rgb_frames[f]);
                }
                free(dec->slots[i].rgb_frames);
            }
            if (dec->slots[i].compressed_data) {
                free(dec->slots[i].compressed_data);
            }
        }
        free(dec->slots);
    }

    pthread_mutex_destroy(&dec->mutex);
    pthread_cond_destroy(&dec->cond_job_available);
    pthread_cond_destroy(&dec->cond_slot_free);
}

// =============================================================================
// Subpacket Decoding
// =============================================================================

static int decode_audio_subpacket(dt_decoder_t *dec, const uint8_t *data, size_t data_len,
                                   size_t *consumed) {
    // Minimum: 20 byte LDPC header
    if (data_len < DT_TAD_HEADER_SIZE * 2) return -1;

    size_t offset = 0;

    // LDPC decode TAD header (20 bytes -> 10 bytes)
    uint8_t decoded_tad_header[DT_TAD_HEADER_SIZE];
    int ldpc_result = ldpc_decode(data + offset, DT_TAD_HEADER_SIZE * 2, decoded_tad_header);
    if (ldpc_result < 0) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: LDPC decode failed for TAD header\n");
        }
        memcpy(decoded_tad_header, data + offset, DT_TAD_HEADER_SIZE);
    } else if (ldpc_result > 0) {
        dec->fec_corrections++;
    }
    offset += DT_TAD_HEADER_SIZE * 2;

    // Parse TAD header
    uint16_t sample_count;
    uint8_t quant_bits;
    uint32_t compressed_size;
    uint32_t rs_block_count;

    memcpy(&sample_count, decoded_tad_header, 2);
    quant_bits = decoded_tad_header[2];
    memcpy(&compressed_size, decoded_tad_header + 3, 4);
    // uint24 rs_block_count (little endian)
    rs_block_count = decoded_tad_header[7] |
                     ((uint32_t)decoded_tad_header[8] << 8) |
                     ((uint32_t)decoded_tad_header[9] << 16);

    if (dec->verbose) {
        printf("  TAD: samples=%u, quant_bits=%u, compressed=%u, rs_blocks=%u\n",
               sample_count, quant_bits, compressed_size, rs_block_count);
    }

    // Calculate RS payload size
    size_t rs_total = rs_block_count * RS_BLOCK_SIZE;

    // Handle empty audio packet (no samples in this GOP)
    if (compressed_size == 0 || rs_block_count == 0 || sample_count == 0) {
        *consumed = offset;
        return 0;  // Successfully processed empty audio packet
    }

    if (offset + rs_total > data_len) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: Audio packet truncated\n");
        }
        *consumed = data_len;
        return -1;
    }

    // RS decode payload
    uint8_t *rs_data = malloc(rs_total);
    if (!rs_data) return -1;
    memcpy(rs_data, data + offset, rs_total);

    uint8_t *decoded_payload = malloc(compressed_size);
    if (!decoded_payload) {
        free(rs_data);
        return -1;
    }

    int rs_result = rs_decode_blocks(rs_data, rs_total, decoded_payload, compressed_size);
    if (rs_result < 0) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: RS decode failed for audio\n");
        }
    } else if (rs_result > 0) {
        dec->fec_corrections += rs_result;
    }

    // decoded_payload already contains the full TAD chunk format:
    // [sample_count(2)][max_index(1)][payload_size(4)][zstd_data]
    // No need to rebuild the header - pass it directly to the TAD decoder

    // Read the actual sample count from the TAD chunk header (not the wrapper header)
    // The wrapper header sample_count might be incorrect or 0 in some cases
    uint16_t tad_chunk_sample_count;
    memcpy(&tad_chunk_sample_count, decoded_payload, 2);

    // Decode TAD to PCMu8 - allocate based on TAD chunk's sample count
    uint8_t *pcmu8_output = malloc(tad_chunk_sample_count * 2);
    if (!pcmu8_output) {
        free(rs_data);
        free(decoded_payload);
        return -1;
    }

    size_t bytes_consumed_tad, samples_decoded;
    int tad_result = tad32_decode_chunk(decoded_payload, compressed_size, pcmu8_output,
                                         &bytes_consumed_tad, &samples_decoded);

    if (tad_result == 0 && samples_decoded > 0 && dec->audio_temp_fp) {
        fwrite(pcmu8_output, 1, samples_decoded * 2, dec->audio_temp_fp);
    }

    free(pcmu8_output);
    free(rs_data);
    free(decoded_payload);

    offset += rs_total;
    *consumed = offset;

    return 0;
}

/**
 * Multithreaded video decoding - submit GOP to worker pool
 */
static int decode_video_subpacket_mt(dt_decoder_t *dec, const uint8_t *data, size_t data_len,
                                      size_t *consumed) {
    // Minimum: 16 byte LDPC header
    if (data_len < DT_TAV_HEADER_SIZE * 2) return -1;

    size_t offset = 0;

    // LDPC decode TAV header (16 bytes -> 8 bytes)
    uint8_t decoded_tav_header[DT_TAV_HEADER_SIZE];
    int ldpc_result = ldpc_decode(data + offset, DT_TAV_HEADER_SIZE * 2, decoded_tav_header);
    if (ldpc_result < 0) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: LDPC decode failed for TAV header\n");
        }
        memcpy(decoded_tav_header, data + offset, DT_TAV_HEADER_SIZE);
    } else if (ldpc_result > 0) {
        dec->fec_corrections++;
    }
    offset += DT_TAV_HEADER_SIZE * 2;

    // Parse TAV header
    uint8_t gop_size = decoded_tav_header[0];
    uint32_t compressed_size;
    uint32_t rs_block_count;

    memcpy(&compressed_size, decoded_tav_header + 1, 4);
    rs_block_count = decoded_tav_header[5] |
                     ((uint32_t)decoded_tav_header[6] << 8) |
                     ((uint32_t)decoded_tav_header[7] << 16);

    // Calculate RS payload size
    size_t rs_total = rs_block_count * RS_BLOCK_SIZE;

    if (offset + rs_total > data_len) {
        *consumed = data_len;
        return -1;
    }

    // RS decode payload
    uint8_t *rs_data = malloc(rs_total);
    if (!rs_data) return -1;
    memcpy(rs_data, data + offset, rs_total);

    uint8_t *decoded_payload = malloc(compressed_size);
    if (!decoded_payload) {
        free(rs_data);
        return -1;
    }

    int rs_result = rs_decode_blocks(rs_data, rs_total, decoded_payload, compressed_size);
    if (rs_result > 0) {
        dec->fec_corrections += rs_result;
    }
    free(rs_data);

    // Lazy initialization of multithreading (after first packet header is known)
    if (!dec->worker_threads && dec->num_threads > 1) {
        if (init_decoder_threads(dec) != 0) {
            fprintf(stderr, "Error: Cannot initialize decoder threads, falling back to single-threaded\n");
            dec->num_threads = 1;
            // Fall back to single-threaded decoding for this packet
            free(decoded_payload);
            *consumed = offset + rs_total;
            return -1;
        }
        if (dec->verbose) {
            printf("Initialized multithreaded decoding: %d threads\n", dec->num_threads);
        }
    }

    // Find an empty slot
    int slot_idx = -1;
    pthread_mutex_lock(&dec->mutex);

    while (slot_idx < 0) {
        // Try to write completed GOPs first
        for (int i = 0; i < dec->num_slots; i++) {
            if (dec->slots[i].status == DECODE_SLOT_DONE &&
                dec->slots[i].job_id == dec->next_write_slot) {

                gop_decode_job_t *job = &dec->slots[i];
                pthread_mutex_unlock(&dec->mutex);

                // Write frames to temp file
                if (job->decode_result == 0 && dec->video_temp_fp) {
                    for (int f = 0; f < job->gop_size; f++) {
                        fwrite(job->rgb_frames[f], 1, job->frame_size, dec->video_temp_fp);
                        dec->frames_decoded++;
                    }
                }

                pthread_mutex_lock(&dec->mutex);

                // Free job resources while holding mutex
                for (int f = 0; f < job->gop_size; f++) {
                    free(job->rgb_frames[f]);
                }
                free(job->rgb_frames);
                free(job->compressed_data);

                job->status = DECODE_SLOT_EMPTY;
                job->rgb_frames = NULL;
                job->compressed_data = NULL;
                dec->next_write_slot++;
                break;
            }
        }

        // Look for empty slot
        for (int i = 0; i < dec->num_slots; i++) {
            if (dec->slots[i].status == DECODE_SLOT_EMPTY) {
                slot_idx = i;
                break;
            }
        }

        if (slot_idx < 0) {
            // Wait for a slot to become available
            pthread_cond_wait(&dec->cond_slot_free, &dec->mutex);
        }
    }

    // Fill the slot
    gop_decode_job_t *job = &dec->slots[slot_idx];

    int internal_height = dec->is_interlaced ? dec->height / 2 : dec->height;
    size_t frame_size = dec->width * internal_height * 3;

    job->compressed_data = decoded_payload;  // Transfer ownership
    job->compressed_size = compressed_size;
    job->gop_size = gop_size;
    job->job_id = dec->jobs_submitted++;
    job->frame_size = frame_size;
    job->decode_result = -1;

    // Allocate frame buffers
    job->rgb_frames = malloc(gop_size * sizeof(uint8_t*));
    for (int i = 0; i < gop_size; i++) {
        job->rgb_frames[i] = malloc(frame_size);
    }

    // Submit job
    job->status = DECODE_SLOT_PENDING;
    pthread_cond_broadcast(&dec->cond_job_available);
    pthread_mutex_unlock(&dec->mutex);

    offset += rs_total;
    *consumed = offset;

    return 0;
}

static int decode_video_subpacket(dt_decoder_t *dec, const uint8_t *data, size_t data_len,
                                   size_t *consumed) {
    // Minimum: 16 byte LDPC header
    if (data_len < DT_TAV_HEADER_SIZE * 2) return -1;

    size_t offset = 0;

    // LDPC decode TAV header (16 bytes -> 8 bytes)
    uint8_t decoded_tav_header[DT_TAV_HEADER_SIZE];
    int ldpc_result = ldpc_decode(data + offset, DT_TAV_HEADER_SIZE * 2, decoded_tav_header);
    if (ldpc_result < 0) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: LDPC decode failed for TAV header\n");
        }
        memcpy(decoded_tav_header, data + offset, DT_TAV_HEADER_SIZE);
    } else if (ldpc_result > 0) {
        dec->fec_corrections++;
    }
    offset += DT_TAV_HEADER_SIZE * 2;

    // Parse TAV header
    uint8_t gop_size = decoded_tav_header[0];
    uint32_t compressed_size;
    uint32_t rs_block_count;

    memcpy(&compressed_size, decoded_tav_header + 1, 4);
    // uint24 rs_block_count (little endian)
    rs_block_count = decoded_tav_header[5] |
                     ((uint32_t)decoded_tav_header[6] << 8) |
                     ((uint32_t)decoded_tav_header[7] << 16);

    if (dec->verbose) {
        printf("  TAV: gop_size=%u, compressed=%u, rs_blocks=%u\n",
               gop_size, compressed_size, rs_block_count);
    }

    // Calculate RS payload size
    size_t rs_total = rs_block_count * RS_BLOCK_SIZE;

    if (offset + rs_total > data_len) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: Video packet truncated\n");
        }
        *consumed = data_len;
        return -1;
    }

    // RS decode payload
    uint8_t *rs_data = malloc(rs_total);
    if (!rs_data) return -1;
    memcpy(rs_data, data + offset, rs_total);

    uint8_t *decoded_payload = malloc(compressed_size);
    if (!decoded_payload) {
        free(rs_data);
        return -1;
    }

    int rs_result = rs_decode_blocks(rs_data, rs_total, decoded_payload, compressed_size);
    if (rs_result < 0) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: RS decode failed for video\n");
        }
    } else if (rs_result > 0) {
        dec->fec_corrections += rs_result;
    }

    // Initialize video decoder if needed
    if (!dec->video_ctx) {
        tav_video_params_t vparams;
        vparams.width = dec->width;
        vparams.height = dec->is_interlaced ? dec->height / 2 : dec->height;
        vparams.decomp_levels = DT_SPATIAL_LEVELS;
        vparams.temporal_levels = DT_TEMPORAL_LEVELS;
        vparams.wavelet_filter = 1;     // CDF 9/7
        vparams.temporal_wavelet = 255; // Haar
        vparams.entropy_coder = 1;      // EZBC
        vparams.channel_layout = 0;     // YCoCg-R
        vparams.perceptual_tuning = 1;
        vparams.quantiser_y = QUALITY_Y[dec->quality_index];
        vparams.quantiser_co = QUALITY_CO[dec->quality_index];
        vparams.quantiser_cg = QUALITY_CG[dec->quality_index];
        vparams.encoder_preset = 0x01;  // Sports
        vparams.monoblock = 1;

        dec->video_ctx = tav_video_create(&vparams);
        if (!dec->video_ctx) {
            fprintf(stderr, "Error: Cannot create video decoder\n");
            free(rs_data);
            free(decoded_payload);
            return -1;
        }
        if (dec->verbose) {
            tav_video_set_verbose(dec->video_ctx, 1);
        }
    }

    // Allocate frame buffers
    int internal_height = dec->is_interlaced ? dec->height / 2 : dec->height;
    size_t frame_size = dec->width * internal_height * 3;
    uint8_t **rgb_frames = malloc(gop_size * sizeof(uint8_t *));
    for (int i = 0; i < gop_size; i++) {
        rgb_frames[i] = malloc(frame_size);
    }

    // Decode GOP
    // The encoder packet format is [type(1)][gop_size(1)][size(4)][zstd_data]
    // Skip the 6-byte header to get to the raw Zstd-compressed data
    const uint8_t *zstd_data = decoded_payload + 6;
    size_t zstd_size = compressed_size > 6 ? compressed_size - 6 : 0;

    // Debug: check packet header
    if (dec->verbose && decoded_payload) {
        fprintf(stderr, "DEBUG: Video packet header: type=0x%02x gop=%d size=%u (total=%u, zstd=%zu)\n",
                decoded_payload[0], decoded_payload[1],
                *(uint32_t*)(decoded_payload + 2), (unsigned)compressed_size, zstd_size);
        fprintf(stderr, "DEBUG: First 16 bytes of zstd data: ");
        for (int i = 0; i < 16 && i < (int)zstd_size; i++) {
            fprintf(stderr, "%02x ", zstd_data[i]);
        }
        fprintf(stderr, "\n");
    }

    int decode_result = tav_video_decode_gop(dec->video_ctx, zstd_data, zstd_size,
                                              gop_size, rgb_frames);

    if (decode_result == 0) {
        // Write frames to video temp file
        for (int i = 0; i < gop_size; i++) {
            if (dec->video_temp_fp) {
                fwrite(rgb_frames[i], 1, frame_size, dec->video_temp_fp);
            }
            dec->frames_decoded++;
        }
    } else {
        if (dec->verbose) {
            const char *err = tav_video_get_error(dec->video_ctx);
            fprintf(stderr, "Warning: Video decode failed: %s\n", err ? err : "unknown error");
        }
    }

    // Cleanup
    for (int i = 0; i < gop_size; i++) {
        free(rgb_frames[i]);
    }
    free(rgb_frames);
    free(rs_data);
    free(decoded_payload);

    offset += rs_total;
    *consumed = offset;

    return 0;
}

// =============================================================================
// FFmpeg Output
// =============================================================================

// Mux decoded video and audio temp files into final output
static int mux_output(dt_decoder_t *dec) {
    if (!dec->output_file) {
        if (dec->verbose) {
            printf("No output file specified, skipping mux\n");
        }
        return 0;
    }

    if (dec->frames_decoded == 0) {
        fprintf(stderr, "Warning: No frames decoded, skipping mux\n");
        return -1;
    }

    if (dec->verbose) {
        printf("Muxing output to %s...\n", dec->output_file);
    }

    int internal_height = dec->is_interlaced ? dec->height / 2 : dec->height;
    char video_size[32];
    char framerate[16];
    snprintf(video_size, sizeof(video_size), "%dx%d", dec->width, internal_height);
    snprintf(framerate, sizeof(framerate), "%d", dec->framerate);

    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "Error: Failed to fork for FFmpeg\n");
        return -1;
    }

    if (pid == 0) {
        // Child process - execute FFmpeg
        execl("/usr/bin/ffmpeg", "ffmpeg",
              "-f", "rawvideo",
              "-pixel_format", "rgb24",
              "-video_size", video_size,
              "-framerate", framerate,
              "-i", dec->video_temp_file,
              "-f", "u8",
              "-ar", "32000",
              "-ac", "2",
              "-i", dec->audio_temp_file,
              "-c:v", "ffv1",
              "-level", "3",
              "-coder", "1",
              "-context", "1",
              "-g", "1",
              "-slices", "24",
              "-slicecrc", "1",
              "-pixel_format", "rgb24",
              "-c:a", "pcm_u8",
              "-f", "matroska",
              dec->output_file,
              "-y",
              "-v", "warning",
              (char*)NULL);

        fprintf(stderr, "Error: Failed to execute FFmpeg\n");
        exit(1);
    } else {
        // Parent process - wait for FFmpeg
        int status;
        waitpid(pid, &status, 0);
        if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
            if (dec->verbose) {
                printf("Output written to %s\n", dec->output_file);
            }
            return 0;
        } else {
            fprintf(stderr, "Warning: FFmpeg mux failed (status %d)\n", WEXITSTATUS(status));
            return -1;
        }
    }
}

// Spawn FFmpeg for streaming output (unused in current implementation)
static int spawn_ffmpeg(dt_decoder_t *dec) {
    int video_pipe_fd[2];

    if (pipe(video_pipe_fd) < 0) {
        fprintf(stderr, "Error: Failed to create video pipe\n");
        return -1;
    }

    dec->ffmpeg_pid = fork();

    if (dec->ffmpeg_pid < 0) {
        fprintf(stderr, "Error: Failed to fork FFmpeg process\n");
        close(video_pipe_fd[0]);
        close(video_pipe_fd[1]);
        return -1;
    }

    if (dec->ffmpeg_pid == 0) {
        // Child process - execute FFmpeg
        close(video_pipe_fd[1]);

        int internal_height = dec->is_interlaced ? dec->height / 2 : dec->height;
        char video_size[32];
        char framerate[16];
        snprintf(video_size, sizeof(video_size), "%dx%d", dec->width, internal_height);
        snprintf(framerate, sizeof(framerate), "%d", dec->framerate);

        dup2(video_pipe_fd[0], 3);
        close(video_pipe_fd[0]);

        execl("/usr/bin/ffmpeg", "ffmpeg",
              "-f", "rawvideo",
              "-pixel_format", "rgb24",
              "-video_size", video_size,
              "-framerate", framerate,
              "-i", "pipe:3",
              "-f", "u8",
              "-ar", "32000",
              "-ac", "2",
              "-i", dec->audio_temp_file,
              "-c:v", "ffv1",
              "-level", "3",
              "-coder", "1",
              "-context", "1",
              "-g", "1",
              "-slices", "24",
              "-slicecrc", "1",
              "-pixel_format", "rgb24",
              "-c:a", "pcm_u8",
              "-f", "matroska",
              dec->output_file,
              "-y",
              "-v", "warning",
              (char*)NULL);

        fprintf(stderr, "Error: Failed to execute FFmpeg\n");
        exit(1);
    } else {
        close(video_pipe_fd[0]);
        dec->video_pipe = fdopen(video_pipe_fd[1], "wb");
        if (!dec->video_pipe) {
            fprintf(stderr, "Error: Failed to open video pipe\n");
            kill(dec->ffmpeg_pid, SIGTERM);
            return -1;
        }
    }

    return 0;
}

// =============================================================================
// Multithreading Support
// =============================================================================
// Main Decoding Loop
// =============================================================================

static int process_packet(dt_decoder_t *dec) {
    dt_packet_header_t header;

    // Find and read header
    if (find_sync_pattern(dec) != 0) {
        return -1;  // EOF
    }

    if (read_and_decode_header(dec, &header) != 0) {
        // Try to recover
        return 0;  // Continue
    }

    if (dec->verbose) {
        double timecode_sec = header.timecode_ns / 1000000000.0;
        printf("Packet %lu: timecode=%.3fs, size=%u, offset_to_video=%u\n",
               dec->packets_processed + 1, timecode_sec, header.packet_size, header.offset_to_video);
    }

    // Read packet payload (contains both TAD and TAV subpackets)
    uint8_t *packet_data = malloc(header.packet_size);
    if (!packet_data) return -1;

    size_t bytes_read = fread(packet_data, 1, header.packet_size, dec->input_fp);
    if (bytes_read < header.packet_size) {
        if (dec->verbose) {
            fprintf(stderr, "Warning: Incomplete packet (got %zu, expected %u)\n",
                   bytes_read, header.packet_size);
        }
        free(packet_data);
        return -1;
    }
    dec->bytes_read += bytes_read;

    // Process TAD subpacket (audio comes first, no type byte)
    size_t tad_consumed = 0;
    if (header.offset_to_video > 0) {
        decode_audio_subpacket(dec, packet_data, header.offset_to_video, &tad_consumed);
    }

    // Process TAV subpacket (video comes after audio)
    if (header.offset_to_video < header.packet_size) {
        size_t tav_consumed = 0;
        if (dec->num_threads > 1) {
            decode_video_subpacket_mt(dec, packet_data + header.offset_to_video,
                                       header.packet_size - header.offset_to_video, &tav_consumed);
        } else {
            decode_video_subpacket(dec, packet_data + header.offset_to_video,
                                   header.packet_size - header.offset_to_video, &tav_consumed);
        }
    }

    dec->packets_processed++;

    if (!dec->verbose && dec->packets_processed % 10 == 0) {
        fprintf(stderr, "\rDecoding packet %lu, frames: %lu...",
               dec->packets_processed, dec->frames_decoded);
    }

    free(packet_data);
    return 0;
}

static int run_decoder(dt_decoder_t *dec) {
    // Open input file
    dec->input_fp = fopen(dec->input_file, "rb");
    if (!dec->input_fp) {
        fprintf(stderr, "Error: Cannot open input file: %s\n", dec->input_file);
        return -1;
    }

    // Create temp file for audio
    generate_random_filename(dec->audio_temp_file, sizeof(dec->audio_temp_file));
    dec->audio_temp_fp = fopen(dec->audio_temp_file, "wb");
    if (!dec->audio_temp_fp) {
        fprintf(stderr, "Warning: Cannot create temp audio file, audio will be skipped\n");
    }

    // Create temp file for video
    generate_random_filename(dec->video_temp_file, sizeof(dec->video_temp_file));
    dec->video_temp_fp = fopen(dec->video_temp_file, "wb");
    if (!dec->video_temp_fp) {
        fprintf(stderr, "Warning: Cannot create temp video file, video will be skipped\n");
    }

    // Note: Multithreading will be initialized lazily after reading first packet header
    // (need to know dimensions and quality settings first)

    // Decode all packets
    if (dec->verbose) {
        printf("Decoding TAV-DT stream...\n");
    }

    // Decode all packets, writing to temp files
    while (process_packet(dec) == 0) {
        // Progress is shown in process_packet
    }

    // Flush remaining GOPs in multithreaded mode
    if (dec->num_threads > 1) {
        pthread_mutex_lock(&dec->mutex);

        // Write all remaining completed GOPs in order
        while (dec->next_write_slot < dec->jobs_submitted) {
            int found = -1;
            for (int i = 0; i < dec->num_slots; i++) {
                if (dec->slots[i].status == DECODE_SLOT_DONE &&
                    dec->slots[i].job_id == dec->next_write_slot) {
                    found = i;
                    break;
                }
            }

            if (found >= 0) {
                gop_decode_job_t *job = &dec->slots[found];
                pthread_mutex_unlock(&dec->mutex);

                // Write frames
                if (job->decode_result == 0 && dec->video_temp_fp) {
                    for (int f = 0; f < job->gop_size; f++) {
                        fwrite(job->rgb_frames[f], 1, job->frame_size, dec->video_temp_fp);
                        dec->frames_decoded++;
                    }
                }

                pthread_mutex_lock(&dec->mutex);

                // Free resources while holding mutex
                for (int f = 0; f < job->gop_size; f++) {
                    free(job->rgb_frames[f]);
                }
                free(job->rgb_frames);
                free(job->compressed_data);

                job->status = DECODE_SLOT_EMPTY;
                job->rgb_frames = NULL;
                job->compressed_data = NULL;
                dec->next_write_slot++;
            } else {
                // Wait for the GOP to complete
                pthread_cond_wait(&dec->cond_slot_free, &dec->mutex);
            }
        }

        pthread_mutex_unlock(&dec->mutex);

        // Cleanup threads
        cleanup_decoder_threads(dec);
    }

    // Close temp files for reading by FFmpeg
    if (dec->audio_temp_fp) {
        fclose(dec->audio_temp_fp);
        dec->audio_temp_fp = NULL;
    }
    if (dec->video_temp_fp) {
        fclose(dec->video_temp_fp);
        dec->video_temp_fp = NULL;
    }

    fprintf(stderr, "\n");
    printf("\nDecoding complete:\n");
    printf("  Packets processed: %lu\n", dec->packets_processed);
    printf("  Frames decoded: %lu\n", dec->frames_decoded);
    printf("  Bytes read: %lu\n", dec->bytes_read);
    printf("  FEC corrections: %lu\n", dec->fec_corrections);
    printf("  CRC errors: %lu\n", dec->crc_errors);
    printf("  Sync losses: %lu\n", dec->sync_losses);

    // Mux output files
    mux_output(dec);

    // Cleanup
    if (dec->video_ctx) {
        tav_video_free(dec->video_ctx);
    }
    if (dec->video_pipe) {
        fclose(dec->video_pipe);
        waitpid(dec->ffmpeg_pid, NULL, 0);
    }
    if (dec->input_fp) {
        fclose(dec->input_fp);
    }

    // Remove temp files
    unlink(dec->audio_temp_file);
    unlink(dec->video_temp_file);

    return 0;
}

// =============================================================================
// Main
// =============================================================================

int main(int argc, char **argv) {
    dt_decoder_t dec;
    memset(&dec, 0, sizeof(dec));

    // Default thread count
    dec.num_threads = get_default_thread_count();

    // Initialize FEC libraries
    rs_init();
    ldpc_init();

    static struct option long_options[] = {
        {"input",   required_argument, 0, 'i'},
        {"output",  required_argument, 0, 'o'},
        {"threads", required_argument, 0, 't'},
        {"dump",    no_argument,       0, 'd'},
        {"verbose", no_argument,       0, 'v'},
        {"help",    no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "i:o:t:dvh", long_options, NULL)) != -1) {
        switch (opt) {
            case 'i':
                dec.input_file = optarg;
                break;
            case 'o':
                dec.output_file = optarg;
                break;
            case 't': {
                int threads = atoi(optarg);
                if (threads < 0) {
                    fprintf(stderr, "Error: Thread count must be positive\n");
                    return 1;
                }
                // Both 0 and 1 mean single-threaded (use value 0 internally)
                dec.num_threads = (threads <= 1) ? 0 : threads;
                if (dec.num_threads > MAX_DECODE_THREADS) dec.num_threads = MAX_DECODE_THREADS;
                break;
            }
            case 'd':
                dec.dump_mode = 1;
                break;
            case 'v':
                dec.verbose = 1;
                break;
            case 'h':
            default:
                print_usage(argv[0]);
                return opt == 'h' ? 0 : 1;
        }
    }

    // Validate arguments
    if (!dec.input_file || !dec.output_file) {
        fprintf(stderr, "Error: Input and output files are required\n");
        print_usage(argv[0]);
        return 1;
    }

    return run_decoder(&dec);
}
