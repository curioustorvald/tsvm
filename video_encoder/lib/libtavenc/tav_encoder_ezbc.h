/**
 * TAV Encoder - EZBC (Embedded Zero Block Coding) Library
 *
 * Public API for EZBC entropy coding of wavelet coefficients.
 */

#ifndef TAV_ENCODER_EZBC_H
#define TAV_ENCODER_EZBC_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// =============================================================================
// EZBC Encoding
// =============================================================================

/**
 * EZBC encoding for a single channel.
 *
 * Implements binary tree embedded zero block coding for efficient storage
 * of sparse wavelet coefficients. Exploits coefficient sparsity through
 * hierarchical significance testing and progressive bitplane encoding.
 *
 * Algorithm:
 * 1. Find MSB bitplane from maximum absolute coefficient value
 * 2. Write header: MSB bitplane (8 bits), width (16 bits), height (16 bits)
 * 3. For each bitplane from MSB to 0:
 *    a. Process insignificant blocks: check if they become significant
 *       - Emit 0 if still insignificant, 1 if became significant
 *    b. For newly significant blocks: recursively subdivide until 1x1
 *       - Emit tree structure: 1=child is significant, 0=child insignificant
 *    c. Emit sign bits for newly significant 1x1 coefficients (1=negative, 0=positive)
 *    d. Process already-significant coefficients: emit refinement bits
 *       - Emit bit at current bitplane for progressive reconstruction
 * 4. Return encoded bitstream
 *
 * Benefits:
 * - Exploits coefficient sparsity (typical: 86.9% zeros in luma, 97.8% in chroma)
 * - Progressive refinement from MSB to LSB
 * - Spatial clustering through quadtree decomposition
 * - No additional entropy coding needed (bitstream is already compressed)
 *
 * @param coeffs  Input quantized coefficients (int16_t array)
 * @param count   Number of coefficients (width × height)
 * @param width   Frame width (must match coefficient array layout)
 * @param height  Frame height (must match coefficient array layout)
 * @param output  Output buffer pointer (allocated by this function, caller must free)
 * @return        Encoded size in bytes (including header)
 */
size_t tav_encode_channel_ezbc(int16_t *coeffs, size_t count, int width, int height,
                                uint8_t **output);

#ifdef __cplusplus
}
#endif

#endif // TAV_ENCODER_EZBC_H
