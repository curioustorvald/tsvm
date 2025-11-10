#ifndef TAD32_DECODER_H
#define TAD32_DECODER_H

#include <stdint.h>
#include <stddef.h>

// TAD32 (Terrarum Advanced Audio - PCM32f version) Decoder
// DWT-based perceptual audio codec for TSVM
// Shared decoder library used by both decoder_tad (standalone) and decoder_tav (video decoder)

// Constants (must match encoder)
#define TAD32_SAMPLE_RATE 32000
#define TAD32_CHANNELS 2  // Stereo
#define TAD_DEFAULT_CHUNK_SIZE 31991  // Default chunk size for standalone TAD files

/**
 * Decode audio chunk with TAD32 codec
 *
 * @param input           Input TAD32 chunk data
 * @param input_size      Size of input buffer
 * @param pcmu8_stereo    Output PCMu8 stereo samples (interleaved L,R)
 * @param bytes_consumed  [out] Number of bytes consumed from input
 * @param samples_decoded [out] Number of samples decoded per channel
 * @return                0 on success, -1 on error
 *
 * Input format:
 *   uint16 sample_count (samples per channel)
 *   uint8  max_index (maximum quantization index)
 *   uint32 payload_size (bytes in payload)
 *   *      payload (encoded M/S data, Zstd-compressed with EZBC)
 *
 * Output format:
 *   PCMu8 stereo interleaved (8-bit unsigned PCM, L,R pairs)
 *   Range: [0, 255] where 128 = silence
 */
int tad32_decode_chunk(const uint8_t *input, size_t input_size, uint8_t *pcmu8_stereo,
                       size_t *bytes_consumed, size_t *samples_decoded);

#endif // TAD32_DECODER_H
