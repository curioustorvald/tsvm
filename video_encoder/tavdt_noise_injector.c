// TAV-DT Noise Injector - Simulates satellite transmission channel noise
// Models QPSK over Ku-band satellite with AWGN and burst interference
// to compile: gcc -O2 -o tavdt_noise_injector tavdt_noise_injector.c -lm
// Created by CuriousTorvald and Claude on 2025-12-14

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <getopt.h>
#include <time.h>

// Buffer size for streaming processing
#define BUFFER_SIZE (1024 * 1024)  // 1 MB chunks

// Default TAV-DT bitrate for timing calculations (~2 Mbps)
#define DEFAULT_BITRATE_BPS 2000000.0

// Global bitrate (can be overridden by --bitrate)
static double g_bitrate_bps = DEFAULT_BITRATE_BPS;

// Burst noise parameters
#define BURST_LENGTH_MEAN   100.0
#define BURST_LENGTH_STDDEV  30.0
#define BURST_LENGTH_MIN     10

//=============================================================================
// PRNG Functions (xorshift64)
//=============================================================================

static uint64_t xorshift64(uint64_t *state) {
    uint64_t x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    return *state = x;
}

// Returns uniform random in [0, 1)
static double rand_uniform(uint64_t *state) {
    return (double)xorshift64(state) / (double)UINT64_MAX;
}

// Box-Muller transform for Gaussian random numbers
static double gaussian_rand(uint64_t *state, double mean, double stddev) {
    double u1 = rand_uniform(state);
    double u2 = rand_uniform(state);

    // Avoid log(0)
    if (u1 < 1e-15) u1 = 1e-15;

    double z = sqrt(-2.0 * log(u1)) * cos(2.0 * M_PI * u2);
    return mean + stddev * z;
}

//=============================================================================
// BER Calculation
//=============================================================================

// Calculate BER from SNR in dB for QPSK modulation
// BER = 0.5 * erfc(sqrt(Eb/N0))
// For QPSK, Eb/N0 = SNR (2 bits per symbol)
static double snr_to_ber(double snr_db) {
    double snr_linear = pow(10.0, snr_db / 10.0);
    double eb_n0 = snr_linear;
    return 0.5 * erfc(sqrt(eb_n0));
}

//=============================================================================
// Burst State Management
//=============================================================================

typedef struct {
    double current_time_sec;       // Elapsed playback time
    double next_burst_time;        // When next burst occurs
    int burst_bytes_remaining;     // Bytes left in current burst (0 = no active burst)
    double burst_interval;         // Mean interval between bursts (60.0 / bursts_per_minute)
    double burst_ber;              // BER during burst
    int burst_count;               // Total bursts applied
    int total_burst_bytes;         // Total bytes affected by bursts
    int verbose;                   // Verbose output flag
} burst_state_t;

static void burst_state_init(burst_state_t *state, double bursts_per_minute,
                             double burst_ber, int verbose, uint64_t *seed) {
    state->current_time_sec = 0.0;
    state->burst_bytes_remaining = 0;
    state->burst_ber = burst_ber;
    state->burst_count = 0;
    state->total_burst_bytes = 0;
    state->verbose = verbose;

    if (bursts_per_minute > 0) {
        state->burst_interval = 60.0 / bursts_per_minute;
        // Schedule first burst using exponential distribution
        state->next_burst_time = -state->burst_interval * log(rand_uniform(seed));
    } else {
        state->burst_interval = 0;
        state->next_burst_time = 1e30;  // Never burst
    }
}

static void burst_state_advance_time(burst_state_t *state, double delta_sec, uint64_t *seed) {
    double end_time = state->current_time_sec + delta_sec;

    // Check if any bursts should occur during this time span
    while (state->burst_interval > 0 && state->next_burst_time < end_time) {
        // A burst should start during this chunk
        if (state->burst_bytes_remaining == 0) {
            double length = gaussian_rand(seed, BURST_LENGTH_MEAN, BURST_LENGTH_STDDEV);
            state->burst_bytes_remaining = (int)fmax(BURST_LENGTH_MIN, length);
            state->burst_count++;

            if (state->verbose) {
                fprintf(stderr, "  [burst] time %.2fs, %d bytes\n",
                        state->next_burst_time, state->burst_bytes_remaining);
            }
        }

        // Schedule next burst
        double wait = -state->burst_interval * log(rand_uniform(seed));
        if (wait < 0.001) wait = 0.001;  // Minimum 1ms between bursts
        state->next_burst_time += wait;
    }

    state->current_time_sec = end_time;
}

//=============================================================================
// Noise Application Functions
//=============================================================================

// Apply AWGN-based bit errors to buffer
// Returns number of bits flipped
static int apply_background_noise(uint8_t *data, size_t len, double ber, uint64_t *seed) {
    int bits_flipped = 0;

    // Optimization: if BER is extremely low, use probability-based skipping
    if (ber < 1e-10) {
        return 0;  // Effectively no errors at this BER
    }

    for (size_t i = 0; i < len; i++) {
        for (int bit = 0; bit < 8; bit++) {
            if (rand_uniform(seed) < ber) {
                data[i] ^= (1 << bit);
                bits_flipped++;
            }
        }
    }

    return bits_flipped;
}

// Apply burst noise to buffer (checks/updates burst state)
// Returns number of bits flipped
static int apply_burst_noise(uint8_t *data, size_t len, burst_state_t *state, uint64_t *seed) {
    int bits_flipped = 0;

    if (state->burst_bytes_remaining <= 0) {
        return 0;
    }

    // Apply burst BER to bytes while burst is active
    size_t burst_bytes = (size_t)state->burst_bytes_remaining;
    if (burst_bytes > len) {
        burst_bytes = len;
    }

    for (size_t i = 0; i < burst_bytes; i++) {
        for (int bit = 0; bit < 8; bit++) {
            if (rand_uniform(seed) < state->burst_ber) {
                data[i] ^= (1 << bit);
                bits_flipped++;
            }
        }
    }

    state->total_burst_bytes += burst_bytes;
    state->burst_bytes_remaining -= burst_bytes;

    return bits_flipped;
}

//=============================================================================
// Byte Position to Time Conversion
//=============================================================================

// Convert byte position to approximate playback time based on bitrate
static double bytes_to_time(size_t byte_pos) {
    return (double)(byte_pos * 8) / g_bitrate_bps;
}

//=============================================================================
// Main Program
//=============================================================================

static void print_usage(const char *prog) {
    fprintf(stderr, "TAV-DT Noise Injector v1.0\n");
    fprintf(stderr, "Simulates QPSK satellite transmission channel noise\n\n");
    fprintf(stderr, "Usage: %s -i input.tavdt -o output.tavdt --snr N [options]\n\n", prog);
    fprintf(stderr, "Required:\n");
    fprintf(stderr, "  -i, --input FILE     Input TAV-DT file\n");
    fprintf(stderr, "  -o, --output FILE    Output corrupted file\n");
    fprintf(stderr, "  --snr N              Signal-to-noise ratio in dB (0-30)\n");
    fprintf(stderr, "\nOptional:\n");
    fprintf(stderr, "  --burst N            Burst events per minute (default: 0)\n");
    fprintf(stderr, "  --burst-ber N        BER during burst events (default: 0.5)\n");
    fprintf(stderr, "  --bitrate N          Stream bitrate in Mbps for timing (default: 2.0)\n");
    fprintf(stderr, "  --seed N             RNG seed for reproducibility\n");
    fprintf(stderr, "  -v, --verbose        Show detailed progress\n");
    fprintf(stderr, "  -h, --help           Show this help\n");
    fprintf(stderr, "\nSNR Reference:\n");
    fprintf(stderr, "   0 dB: Worst case (BER ~7.9e-2, 1 in 13 bits)\n");
    fprintf(stderr, "   6 dB: Poor but working (BER ~2.4e-3)\n");
    fprintf(stderr, "   9 dB: Typical working (BER ~1.9e-4)\n");
    fprintf(stderr, "  12 dB: Good condition (BER ~3.8e-6)\n");
    fprintf(stderr, "  30 dB: Near-perfect (BER ~2.9e-16)\n");
}

int main(int argc, char *argv[]) {
    const char *input_file = NULL;
    const char *output_file = NULL;
    double snr_db = -1;
    double bursts_per_minute = 0;
    double burst_ber = 0.5;
    uint64_t seed = 0;
    int seed_provided = 0;
    int verbose = 0;

    static struct option long_options[] = {
        {"input",     required_argument, 0, 'i'},
        {"output",    required_argument, 0, 'o'},
        {"snr",       required_argument, 0, 's'},
        {"burst",     required_argument, 0, 'b'},
        {"burst-ber", required_argument, 0, 'B'},
        {"bitrate",   required_argument, 0, 'r'},
        {"seed",      required_argument, 0, 'S'},
        {"verbose",   no_argument,       0, 'v'},
        {"help",      no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "i:o:vh", long_options, NULL)) != -1) {
        switch (opt) {
            case 'i':
                input_file = optarg;
                break;
            case 'o':
                output_file = optarg;
                break;
            case 's':
                snr_db = atof(optarg);
                break;
            case 'b':
                bursts_per_minute = atof(optarg);
                break;
            case 'B':
                burst_ber = atof(optarg);
                break;
            case 'r':
                g_bitrate_bps = atof(optarg) * 1000000.0;  // Convert Mbps to bps
                break;
            case 'S':
                seed = strtoull(optarg, NULL, 10);
                seed_provided = 1;
                break;
            case 'v':
                verbose = 1;
                break;
            case 'h':
            default:
                print_usage(argv[0]);
                return opt == 'h' ? 0 : 1;
        }
    }

    // Validate arguments
    if (!input_file || !output_file || snr_db < 0) {
        fprintf(stderr, "Error: Missing required arguments\n\n");
        print_usage(argv[0]);
        return 1;
    }

    if (burst_ber < 0 || burst_ber > 1) {
        fprintf(stderr, "Error: --burst-ber must be between 0 and 1\n");
        return 1;
    }

    // Initialize RNG
    if (!seed_provided) {
        seed = (uint64_t)time(NULL) ^ ((uint64_t)clock() << 32);
    }
    // Ensure seed is not zero (xorshift64 requirement)
    if (seed == 0) seed = 0x853c49e6748fea9bULL;
    // Warm up the generator (small seeds produce poor initial values)
    for (int i = 0; i < 10; i++) xorshift64(&seed);

    // Calculate BER from SNR
    double ber = snr_to_ber(snr_db);

    // Open files
    FILE *in_fp = fopen(input_file, "rb");
    if (!in_fp) {
        fprintf(stderr, "Error: Cannot open input file: %s\n", input_file);
        return 1;
    }

    FILE *out_fp = fopen(output_file, "wb");
    if (!out_fp) {
        fprintf(stderr, "Error: Cannot open output file: %s\n", output_file);
        fclose(in_fp);
        return 1;
    }

    // Print header info
    fprintf(stderr, "TAV-DT Noise Injector v1.0\n");
    fprintf(stderr, "Input:  %s\n", input_file);
    fprintf(stderr, "Output: %s\n", output_file);
    fprintf(stderr, "SNR:    %.1f dB (BER: %.2e)\n", snr_db, ber);
    if (bursts_per_minute > 0) {
        fprintf(stderr, "Burst:  %.1f events/minute (burst BER: %.2f)\n",
                bursts_per_minute, burst_ber);
    } else {
        fprintf(stderr, "Burst:  disabled\n");
    }
    if (seed_provided) {
        fprintf(stderr, "Seed:   %llu\n", (unsigned long long)seed);
    }
    fprintf(stderr, "\n");

    // Initialize burst state
    burst_state_t burst;
    burst_state_init(&burst, bursts_per_minute, burst_ber, verbose, &seed);

    // Allocate buffer for streaming processing
    uint8_t *buffer = malloc(BUFFER_SIZE);
    if (!buffer) {
        fprintf(stderr, "Error: Cannot allocate buffer\n");
        fclose(in_fp);
        fclose(out_fp);
        return 1;
    }

    // Processing statistics
    long long total_bytes = 0;
    long long bits_flipped_bg = 0;
    long long bits_flipped_burst = 0;
    int chunk_count = 0;

    // Process file in chunks
    size_t bytes_read;
    while ((bytes_read = fread(buffer, 1, BUFFER_SIZE, in_fp)) > 0) {
        // Calculate time delta for this chunk (for burst scheduling)
        double delta_sec = bytes_to_time(bytes_read);
        burst_state_advance_time(&burst, delta_sec, &seed);

        // Apply noise to chunk
        bits_flipped_bg += apply_background_noise(buffer, bytes_read, ber, &seed);
        bits_flipped_burst += apply_burst_noise(buffer, bytes_read, &burst, &seed);

        // Write corrupted chunk
        fwrite(buffer, 1, bytes_read, out_fp);

        total_bytes += bytes_read;
        chunk_count++;

        if (verbose && chunk_count % 10 == 0) {
            double time_pos = bytes_to_time(total_bytes);
            fprintf(stderr, "\rProcessed %.1f MB (%.1f sec)...",
                    total_bytes / (1024.0 * 1024.0), time_pos);
        }
    }

    if (verbose) {
        fprintf(stderr, "\r                                        \r");
    }

    // Clean up
    free(buffer);
    fclose(in_fp);
    fclose(out_fp);

    // Print summary
    double duration_sec = bytes_to_time(total_bytes);
    long long total_bits = total_bytes * 8;

    fprintf(stderr, "Complete.\n");
    fprintf(stderr, "  Total bytes: %lld (%.1f sec @ ~%.1f Mbps)\n",
            total_bytes, duration_sec, g_bitrate_bps / 1000000.0);
    fprintf(stderr, "  Background bits flipped: %lld (%.4f%%)\n",
            bits_flipped_bg, 100.0 * bits_flipped_bg / total_bits);
    if (bursts_per_minute > 0) {
        fprintf(stderr, "  Burst events: %d (%d bytes total)\n",
                burst.burst_count, burst.total_burst_bytes);
        fprintf(stderr, "  Burst bits flipped: %lld\n", bits_flipped_burst);
    }

    return 0;
}
