/**
 * LDPC(255,223) Codec for TAV-DT Payloads
 *
 * Alternative to RS(255,223) with same rate (~0.875):
 * - Block size: 255 bytes (223 data + 32 parity)
 * - Uses quasi-cyclic LDPC structure for efficiency
 * - Soft-decision belief propagation decoder
 *
 * Designed as drop-in replacement for RS(255,223):
 * - Same input/output sizes
 * - Same API style
 * - Different error correction characteristics:
 *   - LDPC: Better at high BER (>1e-3), gradual degradation
 *   - RS: Better at low BER, hard threshold at 16 byte errors
 *
 * Created by CuriousTorvald and Claude on 2025-12-15.
 */

#ifndef LDPC_PAYLOAD_H
#define LDPC_PAYLOAD_H

#include <stdint.h>
#include <stddef.h>

// LDPC(255,223) parameters - matches RS(255,223) for drop-in replacement
#define LDPC_P_BLOCK_SIZE    255   // Total codeword size (bytes)
#define LDPC_P_DATA_SIZE     223   // Data bytes per block
#define LDPC_P_PARITY_SIZE   32    // Parity bytes per block

// Decoder parameters
#define LDPC_P_MAX_ITERATIONS 30   // Maximum BP iterations
#define LDPC_P_EARLY_TERM     1    // Enable early termination on valid codeword

/**
 * Initialize LDPC(255,223) codec.
 * Must be called once before using encode/decode functions.
 * Thread-safe: uses static initialization.
 */
void ldpc_p_init(void);

/**
 * Encode data block with LDPC(255,223).
 *
 * @param data      Input data (up to LDPC_P_DATA_SIZE bytes)
 * @param data_len  Length of input data (1 to LDPC_P_DATA_SIZE)
 * @param output    Output buffer (must hold data_len + LDPC_P_PARITY_SIZE bytes)
 *                  Format: [data][parity]
 * @return          Total output length (data_len + LDPC_P_PARITY_SIZE)
 *
 * Note: For data shorter than LDPC_P_DATA_SIZE, the encoder pads with zeros
 * internally but only outputs actual data + parity.
 */
size_t ldpc_p_encode(const uint8_t *data, size_t data_len, uint8_t *output);

/**
 * Decode and correct LDPC(255,223) encoded block.
 *
 * @param data      Buffer containing [data][parity] (modified in-place)
 * @param data_len  Length of data portion (1 to LDPC_P_DATA_SIZE)
 * @return          Number of iterations used (1-30), or -1 if uncorrectable
 *
 * On success, data buffer contains corrected data.
 * On failure, data buffer contents are undefined.
 */
int ldpc_p_decode(uint8_t *data, size_t data_len);

/**
 * Encode data with automatic block splitting.
 * For data larger than LDPC_P_DATA_SIZE, splits into multiple blocks.
 *
 * @param data        Input data
 * @param data_len    Length of input data
 * @param output      Output buffer (must hold ceil(data_len/223) * 255 bytes)
 * @return            Total output length
 */
size_t ldpc_p_encode_blocks(const uint8_t *data, size_t data_len, uint8_t *output);

/**
 * Decode data with automatic block splitting.
 *
 * @param data        Buffer containing LDPC-encoded blocks (modified in-place)
 * @param total_len   Total length of encoded data (multiple of LDPC_P_BLOCK_SIZE)
 * @param output      Output buffer for decoded data
 * @param output_len  Expected length of decoded data
 * @return            Total iterations across all blocks, or -1 if any block failed
 */
int ldpc_p_decode_blocks(uint8_t *data, size_t total_len, uint8_t *output, size_t output_len);

/**
 * Check if codeword is valid (syndrome check).
 *
 * @param codeword   Full codeword (LDPC_P_BLOCK_SIZE bytes)
 * @return           1 if valid (zero syndrome), 0 if errors detected
 */
int ldpc_p_check_syndrome(const uint8_t *codeword);

#endif // LDPC_PAYLOAD_H
