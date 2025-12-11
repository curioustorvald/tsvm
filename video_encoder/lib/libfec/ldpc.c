/**
 * LDPC Rate 1/2 Codec Implementation
 *
 * Simple LDPC for TAV-DT header protection.
 * Uses a systematic rate 1/2 code with bit-flipping decoder.
 *
 * The parity-check matrix is designed for good error correction on small blocks.
 * Each parity bit is computed as XOR of multiple data bits using a pseudo-random
 * but deterministic pattern.
 *
 * Created by CuriousTorvald and Claude on 2025-12-09.
 */

#include "ldpc.h"
#include <string.h>
#include <stdio.h>

// =============================================================================
// Parity-Check Matrix Generation
// =============================================================================

// For rate 1/2 LDPC: n = 2k bits, parity-check matrix H is (n-k) x n = k x 2k
// We use H = [P | I_k] where P is the parity pattern matrix
// This gives systematic encoding: c = [data | parity] where parity = P * data

// Parity pattern: each parity bit j depends on data bits where pattern[j][i] = 1
// We use a regular pattern with column weight 3 (each data bit affects 3 parity bits)
// and row weight varies to cover the data bits well

// Simple hash function for generating parity connections
static inline uint32_t hash_mix(uint32_t a, uint32_t b) {
    a ^= b;
    a = (a ^ (a >> 16)) * 0x85ebca6b;
    a = (a ^ (a >> 13)) * 0xc2b2ae35;
    return a ^ (a >> 16);
}

// Get bit from byte array
static inline int get_bit(const uint8_t *data, int bit_idx) {
    return (data[bit_idx >> 3] >> (7 - (bit_idx & 7))) & 1;
}

// Set bit in byte array
static inline void set_bit(uint8_t *data, int bit_idx, int value) {
    int byte_idx = bit_idx >> 3;
    int bit_pos = 7 - (bit_idx & 7);
    if (value) {
        data[byte_idx] |= (1 << bit_pos);
    } else {
        data[byte_idx] &= ~(1 << bit_pos);
    }
}

// Flip bit in byte array
static inline void flip_bit(uint8_t *data, int bit_idx) {
    int byte_idx = bit_idx >> 3;
    int bit_pos = 7 - (bit_idx & 7);
    data[byte_idx] ^= (1 << bit_pos);
}

// Get list of data bits that affect parity bit j
// Returns number of connected data bits, stores indices in connections[]
// For rate 1/2: data bits are 0 to k*8-1, parity bits are k*8 to 2*k*8-1
static int get_parity_connections(int parity_idx, int k_bits, int *connections) {
    int count = 0;

    // Use a deterministic pseudo-random pattern
    // Each parity bit connects to approximately k_bits/3 data bits
    // Different seeds for different parity positions ensure coverage

    uint32_t seed = hash_mix(0xDEADBEEF, (uint32_t)parity_idx);

    for (int i = 0; i < k_bits; i++) {
        // Each data bit has ~3/k_bits chance of connecting to this parity bit
        // Total connections per parity ~ 3 (column weight)
        uint32_t h = hash_mix(seed, (uint32_t)i);
        if ((h % (k_bits / 3 + 1)) == 0) {
            connections[count++] = i;
        }
    }

    // Ensure at least 2 connections per parity bit
    if (count < 2) {
        connections[count++] = parity_idx % k_bits;
        connections[count++] = (parity_idx + k_bits / 2) % k_bits;
    }

    return count;
}

// Get list of parity bits affected by data bit i
static int get_data_connections(int data_idx, int k_bits, int *connections) {
    int count = 0;

    for (int j = 0; j < k_bits; j++) {
        int parity_conns[LDPC_MAX_DATA_BYTES * 8];
        int n_conns = get_parity_connections(j, k_bits, parity_conns);

        for (int c = 0; c < n_conns; c++) {
            if (parity_conns[c] == data_idx) {
                connections[count++] = j;
                break;
            }
        }
    }

    return count;
}

// =============================================================================
// Initialization
// =============================================================================

static int ldpc_initialized = 0;

void ldpc_init(void) {
    if (ldpc_initialized) return;
    // No pre-computation needed - patterns generated on the fly
    ldpc_initialized = 1;
}

// =============================================================================
// Encoding
// =============================================================================

size_t ldpc_encode(const uint8_t *data, size_t data_len, uint8_t *output) {
    if (!ldpc_initialized) ldpc_init();

    if (data_len > LDPC_MAX_DATA_BYTES) {
        data_len = LDPC_MAX_DATA_BYTES;
    }

    int k_bits = (int)(data_len * 8);  // Number of data bits

    // Copy data to output (systematic encoding)
    memcpy(output, data, data_len);

    // Initialize parity bytes to zero
    memset(output + data_len, 0, data_len);

    // Compute parity bits
    for (int j = 0; j < k_bits; j++) {
        // Get data bits connected to parity bit j
        int connections[LDPC_MAX_DATA_BYTES * 8];
        int n_conns = get_parity_connections(j, k_bits, connections);

        // Parity bit = XOR of connected data bits
        int parity = 0;
        for (int c = 0; c < n_conns; c++) {
            parity ^= get_bit(data, connections[c]);
        }

        // Set parity bit
        set_bit(output + data_len, j, parity);
    }

    return data_len * 2;
}

// =============================================================================
// Decoding
// =============================================================================

int ldpc_check_syndrome(const uint8_t *codeword, size_t len) {
    if (!ldpc_initialized) ldpc_init();

    size_t data_len = len / 2;
    int k_bits = (int)(data_len * 8);

    // Check all parity equations
    for (int j = 0; j < k_bits; j++) {
        int connections[LDPC_MAX_DATA_BYTES * 8];
        int n_conns = get_parity_connections(j, k_bits, connections);

        // Compute syndrome bit: XOR of connected data bits XOR parity bit
        int syndrome = get_bit(codeword + data_len, j);
        for (int c = 0; c < n_conns; c++) {
            syndrome ^= get_bit(codeword, connections[c]);
        }

        if (syndrome != 0) {
            return 0;  // Syndrome non-zero: errors detected
        }
    }

    return 1;  // Zero syndrome: valid codeword
}

int ldpc_decode(const uint8_t *encoded, size_t encoded_len, uint8_t *output) {
    if (!ldpc_initialized) ldpc_init();

    if (encoded_len < 2 || (encoded_len & 1) != 0) {
        return -1;  // Invalid length
    }

    size_t data_len = encoded_len / 2;
    if (data_len > LDPC_MAX_DATA_BYTES) {
        return -1;
    }

    int k_bits = (int)(data_len * 8);

    // Working copy of codeword
    uint8_t codeword[LDPC_MAX_DATA_BYTES * 2];
    memcpy(codeword, encoded, encoded_len);

    // Bit-flipping decoder
    for (int iter = 0; iter < LDPC_MAX_ITERATIONS; iter++) {
        // Compute syndromes (which parity checks fail)
        int syndrome[LDPC_MAX_DATA_BYTES * 8];
        int syndrome_count = 0;

        for (int j = 0; j < k_bits; j++) {
            int connections[LDPC_MAX_DATA_BYTES * 8];
            int n_conns = get_parity_connections(j, k_bits, connections);

            // Syndrome bit = XOR of connected data bits XOR parity bit
            syndrome[j] = get_bit(codeword + data_len, j);
            for (int c = 0; c < n_conns; c++) {
                syndrome[j] ^= get_bit(codeword, connections[c]);
            }

            if (syndrome[j]) syndrome_count++;
        }

        // Check if we're done (all syndromes zero)
        if (syndrome_count == 0) {
            // Success - copy decoded data
            memcpy(output, codeword, data_len);
            return 0;
        }

        // Count failed checks for each bit
        int data_fails[LDPC_MAX_DATA_BYTES * 8];
        int parity_fails[LDPC_MAX_DATA_BYTES * 8];
        memset(data_fails, 0, sizeof(data_fails));
        memset(parity_fails, 0, sizeof(parity_fails));

        for (int j = 0; j < k_bits; j++) {
            if (syndrome[j]) {
                // This check failed - increment count for all connected bits
                int connections[LDPC_MAX_DATA_BYTES * 8];
                int n_conns = get_parity_connections(j, k_bits, connections);

                for (int c = 0; c < n_conns; c++) {
                    data_fails[connections[c]]++;
                }
                parity_fails[j]++;
            }
        }

        // Find bit with most failures
        int max_fails = 0;
        int flip_type = 0;  // 0 = data, 1 = parity
        int flip_idx = 0;

        for (int i = 0; i < k_bits; i++) {
            if (data_fails[i] > max_fails) {
                max_fails = data_fails[i];
                flip_type = 0;
                flip_idx = i;
            }
        }

        for (int j = 0; j < k_bits; j++) {
            if (parity_fails[j] > max_fails) {
                max_fails = parity_fails[j];
                flip_type = 1;
                flip_idx = j;
            }
        }

        // Flip the most suspicious bit
        if (max_fails > 0) {
            if (flip_type == 0) {
                flip_bit(codeword, flip_idx);
            } else {
                flip_bit(codeword + data_len, flip_idx);
            }
        } else {
            // No progress possible
            break;
        }
    }

    // Failed to decode - return best effort
    // Check if we at least have valid data by syndrome count
    int final_syndromes = 0;
    for (int j = 0; j < k_bits; j++) {
        int connections[LDPC_MAX_DATA_BYTES * 8];
        int n_conns = get_parity_connections(j, k_bits, connections);

        int syn = get_bit(codeword + data_len, j);
        for (int c = 0; c < n_conns; c++) {
            syn ^= get_bit(codeword, connections[c]);
        }
        if (syn) final_syndromes++;
    }

    // If only a few syndromes fail, return data anyway (soft failure)
    if (final_syndromes <= k_bits / 8) {
        memcpy(output, codeword, data_len);
        return 0;  // Partial success
    }

    // Total failure - return original data as best effort
    memcpy(output, encoded, data_len);
    return -1;
}
