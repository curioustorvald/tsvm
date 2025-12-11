/**
 * LDPC Rate 1/2 Codec for TAV-DT
 *
 * Simple LDPC implementation for header protection in TAV-DT format.
 * Rate 1/2: k data bytes → 2k encoded bytes (doubles the size)
 *
 * Uses systematic encoding where first k bytes are data, last k bytes are parity.
 * Decoding uses iterative bit-flipping algorithm.
 *
 * Designed for small blocks (headers up to 64 bytes).
 *
 * Created by CuriousTorvald and Claude on 2025-12-09.
 */

#ifndef LDPC_H
#define LDPC_H

#include <stdint.h>
#include <stddef.h>

// Maximum block size (data bytes before encoding)
#define LDPC_MAX_DATA_BYTES 64

// LDPC decoder parameters
#define LDPC_MAX_ITERATIONS 50

/**
 * Initialize LDPC codec.
 * Must be called once before using encode/decode functions.
 * Thread-safe: uses static initialization.
 */
void ldpc_init(void);

/**
 * Encode data block with LDPC rate 1/2.
 *
 * @param data      Input data bytes
 * @param data_len  Length of input data (1 to LDPC_MAX_DATA_BYTES)
 * @param output    Output buffer (must hold 2 * data_len bytes)
 * @return          Output length (2 * data_len)
 *
 * Output format: [data bytes][parity bytes]
 * The output is systematic: first data_len bytes are the original data.
 */
size_t ldpc_encode(const uint8_t *data, size_t data_len, uint8_t *output);

/**
 * Decode LDPC rate 1/2 encoded block.
 *
 * @param encoded     Input encoded data (2 * data_len bytes)
 * @param encoded_len Length of encoded data (must be even, max 2*LDPC_MAX_DATA_BYTES)
 * @param output      Output buffer for decoded data (encoded_len / 2 bytes)
 * @return            0 on success, -1 if decoding failed (too many errors)
 *
 * Uses iterative bit-flipping decoder.
 */
int ldpc_decode(const uint8_t *encoded, size_t encoded_len, uint8_t *output);

/**
 * Calculate syndrome for validation.
 *
 * @param codeword   Encoded codeword (2 * data_len bytes)
 * @param len        Length of codeword
 * @return           1 if valid (zero syndrome), 0 if errors detected
 */
int ldpc_check_syndrome(const uint8_t *codeword, size_t len);

#endif // LDPC_H
