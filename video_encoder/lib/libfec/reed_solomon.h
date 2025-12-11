/**
 * Reed-Solomon (255,223) Codec for TAV-DT
 *
 * Standard RS code over GF(2^8):
 * - Block size: 255 bytes (223 data + 32 parity)
 * - Error correction: up to 16 byte errors
 * - Error detection: up to 32 byte errors
 *
 * Uses primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
 * Generator polynomial: g(x) = product of (x - alpha^i) for i = 0..31
 *
 * Created by CuriousTorvald and Claude on 2025-12-09.
 */

#ifndef REED_SOLOMON_H
#define REED_SOLOMON_H

#include <stdint.h>
#include <stddef.h>

// RS(255,223) parameters
#define RS_BLOCK_SIZE     255   // Total codeword size
#define RS_DATA_SIZE      223   // Data bytes per block
#define RS_PARITY_SIZE    32    // Parity bytes per block (2t = 32, t = 16)
#define RS_MAX_ERRORS     16    // Maximum correctable errors (t)

/**
 * Initialize Reed-Solomon codec.
 * Must be called once before using encode/decode functions.
 * Thread-safe: uses static initialization.
 */
void rs_init(void);

/**
 * Encode data block with Reed-Solomon parity.
 *
 * @param data      Input data (up to RS_DATA_SIZE bytes)
 * @param data_len  Length of input data (1 to RS_DATA_SIZE)
 * @param output    Output buffer (must hold data_len + RS_PARITY_SIZE bytes)
 *                  Format: [data][parity]
 * @return          Total output length (data_len + RS_PARITY_SIZE)
 *
 * Note: For data shorter than RS_DATA_SIZE, the encoder pads with zeros
 * internally but only outputs actual data + parity.
 */
size_t rs_encode(const uint8_t *data, size_t data_len, uint8_t *output);

/**
 * Decode and correct Reed-Solomon encoded block.
 *
 * @param data      Buffer containing [data][parity] (modified in-place)
 * @param data_len  Length of data portion (1 to RS_DATA_SIZE)
 * @return          Number of errors corrected (0-16), or -1 if uncorrectable
 *
 * On success, data buffer contains corrected data (parity may also be corrected).
 * On failure, data buffer contents are undefined.
 */
int rs_decode(uint8_t *data, size_t data_len);

/**
 * Encode data with automatic block splitting.
 * For data larger than RS_DATA_SIZE, splits into multiple RS blocks.
 *
 * @param data        Input data
 * @param data_len    Length of input data
 * @param output      Output buffer (must hold ceil(data_len/223) * 255 bytes)
 * @return            Total output length
 */
size_t rs_encode_blocks(const uint8_t *data, size_t data_len, uint8_t *output);

/**
 * Decode data with automatic block splitting.
 *
 * @param data        Buffer containing RS-encoded blocks (modified in-place)
 * @param total_len   Total length of encoded data (multiple of RS_BLOCK_SIZE)
 * @param output      Output buffer for decoded data
 * @param output_len  Expected length of decoded data
 * @return            Total errors corrected across all blocks, or -1 if any block failed
 */
int rs_decode_blocks(uint8_t *data, size_t total_len, uint8_t *output, size_t output_len);

#endif // REED_SOLOMON_H
