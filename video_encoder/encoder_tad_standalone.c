// Created by CuriousTorvald and Claude on 2025-10-24.
// TAD32 (Terrarum Advanced Audio - PCM32 version) Encoder - Standalone program
// Alternative version: PCM32 throughout encoding, PCM8 conversion only at decoder
// Uses encoder_tad32.c library for encoding functions

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <getopt.h>
#include <math.h>
#include <time.h>
#include "encoder_tad.h"

#define ENCODER_VENDOR_STRING "Encoder-TAD32 (PCM32f version) 20251107"

// TAD32 format constants
#define TAD32_DEFAULT_CHUNK_SIZE 32768  // Using a prime number to force the worst condition

// Temporary file for FFmpeg PCM extraction
char TEMP_PCM_FILE[42];

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

    // Add the extension
    strcpy(filename + 37, ".tad");
    filename[41] = '\0';  // Null terminate
}

//=============================================================================
// Main Encoder
//=============================================================================

static void print_usage(const char *prog_name) {
    printf("Usage: %s -i <input> [options]\n", prog_name);
    printf("Options:\n");
    printf("  -i <file>       Input audio file (any format supported by FFmpeg)\n");
    printf("  -o <file>       Output TAD32 file (optional, auto-generated as input.qN.tad)\n");
    printf("  -q <level>      Quality level (0-5, default: %d)\n", TAD32_QUALITY_DEFAULT);
    printf("                  0 = lowest quality/smallest (max_index=31)\n");
    printf("                  1 = low quality (max_index=35)\n");
    printf("                  2 = medium quality (max_index=39)\n");
    printf("                  3 = good quality (max_index=47) [DEFAULT]\n");
    printf("                  4 = high quality (max_index=56)\n");
    printf("                  5 = very high quality/largest (max_index=89)\n");
    printf("  -v              Verbose output\n");
    printf("  -h, --help      Show this help\n");
    printf("\nVersion: %s\n", ENCODER_VENDOR_STRING);
    printf("Note: This is the PCM32 alternative version for comparison testing.\n");
    printf("      PCM32 is processed throughout encoding; PCM8 conversion happens at decoder.\n");
}

int main(int argc, char *argv[]) {
    generate_random_filename(TEMP_PCM_FILE);

    char *input_file = NULL;
    char *output_file = NULL;
    int quality = TAD32_QUALITY_DEFAULT;  // Default quality level (0-5)
    float quantiser_scale = 1.0f;  // Default quantiser scaling
    int verbose = 0;

    // Parse command line arguments
    static struct option long_options[] = {
        {"help", no_argument, 0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    int option_index = 0;
    while ((opt = getopt_long(argc, argv, "i:o:q:s:vh", long_options, &option_index)) != -1) {
        switch (opt) {
            case 'i':
                input_file = optarg;
                break;
            case 'o':
                output_file = optarg;
                break;
            case 'q':
                quality = atoi(optarg);
                if (quality < TAD32_QUALITY_MIN || quality > TAD32_QUALITY_MAX) {
                    fprintf(stderr, "Error: Quality must be in range %d-%d\n", TAD32_QUALITY_MIN, TAD32_QUALITY_MAX);
                    return 1;
                }
                break;
            case 's':
                quantiser_scale = atof(optarg);
                if (quantiser_scale < 0.5f || quantiser_scale > 4.0f) {
                    fprintf(stderr, "Error: Quantiser scale must be in range 0.5-4.0\n");
                    return 1;
                }
                break;
            case 'v':
                verbose = 1;
                break;
            case 'h':
                print_usage(argv[0]);
                return 0;
            default:
                print_usage(argv[0]);
                return 1;
        }
    }

    if (!input_file) {
        fprintf(stderr, "Error: Input file is required\n");
        print_usage(argv[0]);
        return 1;
    }

    // Convert quality (0-5) to max_index for quantisation
    int max_index = tad32_quality_to_max_index(quality);

    // Generate output filename if not provided
    if (!output_file) {
        // Allocate space for output filename
        size_t input_len = strlen(input_file);
        output_file = malloc(input_len + 32);  // Extra space for .qNN.tad

        // Find the last directory separator
        const char *basename_start = strrchr(input_file, '/');
        if (!basename_start) basename_start = strrchr(input_file, '\\');
        basename_start = basename_start ? basename_start + 1 : input_file;

        // Copy directory part
        size_t dir_len = basename_start - input_file;
        strncpy(output_file, input_file, dir_len);

        // Find the extension (last dot after basename)
        const char *ext = strrchr(basename_start, '.');
        if (ext && ext > basename_start) {
            // Copy basename without extension
            size_t name_len = ext - basename_start;
            strncpy(output_file + dir_len, basename_start, name_len);
            output_file[dir_len + name_len] = '\0';
        } else {
            // No extension, copy entire basename
            strcpy(output_file + dir_len, basename_start);
        }

        // Append .qNN.tad (use quality level for filename)
        sprintf(output_file + strlen(output_file), ".q%d.tad", quality);

        if (verbose) {
            printf("Auto-generated output path: %s\n", output_file);
        }
    }

    if (verbose) {
        printf("%s\n", ENCODER_VENDOR_STRING);
        printf("Input: %s\n", input_file);
        printf("Output: %s\n", output_file);
        printf("Quality level: %d (max_index=%d)\n", quality, max_index);
        printf("Quantiser scale: %.2f\n", quantiser_scale);
    }

    // Detect original sample rate for high-quality resampling
    char sample_rate_str[32] = "48000";  // Default fallback
    char detect_cmd[2048];
    snprintf(detect_cmd, sizeof(detect_cmd),
        "ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate "
        "-of default=noprint_wrappers=1:nokey=1 \"%s\" 2>/dev/null",
        input_file);

    FILE *probe = popen(detect_cmd, "r");
    if (probe) {
        if (fgets(sample_rate_str, sizeof(sample_rate_str), probe)) {
            // Remove newline
            sample_rate_str[strcspn(sample_rate_str, "\n")] = 0;
        }
        pclose(probe);
    }

    int original_rate = atoi(sample_rate_str);
    if (original_rate <= 0 || original_rate > 192000) {
        original_rate = 48000;  // Fallback
    }

    if (verbose) {
        printf("Detected original sample rate: %d Hz\n", original_rate);
        printf("Extracting and resampling audio to %d Hz...\n", TAD32_SAMPLE_RATE);
    }

    // Extract and resample in two passes for better quality
    // Pass 1: Extract at original sample rate
    char temp_original_pcm[256];
    snprintf(temp_original_pcm, sizeof(temp_original_pcm), "%s.orig", TEMP_PCM_FILE);

    char ffmpeg_cmd[2048];
    snprintf(ffmpeg_cmd, sizeof(ffmpeg_cmd),
        "ffmpeg -hide_banner -v error -i \"%s\" -f f32le -acodec pcm_f32le -ac %d -y \"%s\" 2>&1",
        input_file, TAD32_CHANNELS, temp_original_pcm);

    int result = system(ffmpeg_cmd);
    if (result != 0) {
        fprintf(stderr, "Error: FFmpeg extraction failed\n");
        return 1;
    }

    // Pass 2: Resample to 32kHz with high-quality SoXR resampler and highpass filter
    snprintf(ffmpeg_cmd, sizeof(ffmpeg_cmd),
        "ffmpeg -hide_banner -v error -f f32le -ar %d -ac %d -i \"%s\" "
        "-f f32le -acodec pcm_f32le -ar %d -ac %d "
        "-af \"aresample=resampler=soxr:precision=28:cutoff=0.99:dither_scale=0,highpass=f=16\" "
        "-y \"%s\" 2>&1",
        original_rate, TAD32_CHANNELS, temp_original_pcm, TAD32_SAMPLE_RATE, TAD32_CHANNELS, TEMP_PCM_FILE);

    result = system(ffmpeg_cmd);
    remove(temp_original_pcm);  // Clean up intermediate file

    if (result != 0) {
        fprintf(stderr, "Error: FFmpeg resampling failed\n");
        return 1;
    }

    // Open PCM file
    FILE *pcm_file = fopen(TEMP_PCM_FILE, "rb");
    if (!pcm_file) {
        fprintf(stderr, "Error: Could not open temporary PCM file\n");
        return 1;
    }

    // Get file size
    fseek(pcm_file, 0, SEEK_END);
    size_t pcm_size = ftell(pcm_file);
    fseek(pcm_file, 0, SEEK_SET);

    size_t total_samples = pcm_size / (TAD32_CHANNELS * sizeof(float));

    // Pad to even sample count
    if (total_samples % 2 == 1) {
        total_samples++;
        if (verbose) {
            printf("Odd sample count detected, padding with one zero sample\n");
        }
    }

    size_t num_chunks = (total_samples + TAD32_DEFAULT_CHUNK_SIZE - 1) / TAD32_DEFAULT_CHUNK_SIZE;

    if (verbose) {
        printf("Total samples: %zu (%.2f seconds)\n", total_samples,
               (double)total_samples / TAD32_SAMPLE_RATE);
        printf("Chunks: %zu (chunk size: %d samples)\n", num_chunks, TAD32_DEFAULT_CHUNK_SIZE);
    }

    // Open output file
    FILE *output = fopen(output_file, "wb");
    if (!output) {
        fprintf(stderr, "Error: Could not open output file\n");
        fclose(pcm_file);
        return 1;
    }

    // Process chunks using linked TAD32 encoder library
    size_t total_output_size = 0;
    float *chunk_buffer = malloc(TAD32_DEFAULT_CHUNK_SIZE * TAD32_CHANNELS * sizeof(float));
    uint8_t *output_buffer = malloc(TAD32_DEFAULT_CHUNK_SIZE * 4 * sizeof(float));  // Generous buffer

    for (size_t chunk_idx = 0; chunk_idx < num_chunks; chunk_idx++) {
        size_t chunk_samples = TAD32_DEFAULT_CHUNK_SIZE;
        size_t remaining = total_samples - (chunk_idx * TAD32_DEFAULT_CHUNK_SIZE);

        if (remaining < TAD32_DEFAULT_CHUNK_SIZE) {
            chunk_samples = remaining;
        }

        // Read chunk
        size_t samples_read = fread(chunk_buffer, TAD32_CHANNELS * sizeof(float),
                                   chunk_samples, pcm_file);
        (void)samples_read;  // Unused, but kept for compatibility

        // Pad with zeros if necessary
        if (chunk_samples < TAD32_DEFAULT_CHUNK_SIZE) {
            memset(&chunk_buffer[chunk_samples * TAD32_CHANNELS], 0,
                   (TAD32_DEFAULT_CHUNK_SIZE - chunk_samples) * TAD32_CHANNELS * sizeof(float));
        }

        // Encode chunk using linked tad32_encode_chunk() from encoder_tad32.c
        size_t encoded_size = tad32_encode_chunk(chunk_buffer, TAD32_DEFAULT_CHUNK_SIZE,
                                                 max_index,
                                                 quantiser_scale, output_buffer);

        if (encoded_size == 0) {
            fprintf(stderr, "Error: Chunk encoding failed at chunk %zu\n", chunk_idx);
            free(chunk_buffer);
            free(output_buffer);
            fclose(pcm_file);
            fclose(output);
            return 1;
        }

        // Write chunk to output
        fwrite(output_buffer, 1, encoded_size, output);
        total_output_size += encoded_size;

        if (verbose && (chunk_idx % 10 == 0 || chunk_idx == num_chunks - 1)) {
            printf("Processed chunk %zu/%zu (%.1f%%)\r", chunk_idx + 1, num_chunks,
                   (chunk_idx + 1) * 100.0 / num_chunks);
            fflush(stdout);
        }
    }

    if (verbose) {
        printf("\n");
    }

    // Print coefficient statistics if enabled
    tad32_print_statistics();
    tad32_free_statistics();

    // Cleanup
    free(chunk_buffer);
    free(output_buffer);
    fclose(pcm_file);
    fclose(output);
    remove(TEMP_PCM_FILE);

    // Print statistics
    size_t pcmu8_size = total_samples * TAD32_CHANNELS;  // PCMu8 baseline
    float compression_ratio = (float)pcmu8_size / total_output_size;

    printf("Encoding complete!\n");
    printf("PCMu8 size: %zu bytes\n", pcmu8_size);
    printf("TAD32 size: %zu bytes\n", total_output_size);
    printf("Compression ratio: %.2f:1 (%.1f%% of PCMu8)\n",
           compression_ratio, (total_output_size * 100.0) / pcmu8_size);

    if (compression_ratio < 1.8) {
        printf("Warning: Compression ratio below 2:1 target. Try lower quantisation bits or different settings.\n");
    }

    return 0;
}
