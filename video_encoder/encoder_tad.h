#ifndef TAD_ENCODER_H
#define TAD_ENCODER_H

#include <stdint.h>
#include <stddef.h>

// TAD (Terrarum Advanced Audio) Encoder
// DWT-based perceptual audio codec for TSVM

// Constants
#define TAD_MIN_CHUNK_SIZE 1024       // Minimum: 1024 samples (supports non-power-of-2)
#define TAD_SAMPLE_RATE 32000
#define TAD_CHANNELS 2  // Stereo
#define TAD_SIGMAP_2BIT 1  // 2-bit: 00=0, 01=+1, 10=-1, 11=other
#define TAD_QUALITY_MIN 0
#define TAD_QUALITY_MAX 5
#define TAD_QUALITY_DEFAULT 3
#define TAD_ZSTD_LEVEL 7

/**
 * Encode audio chunk with TAD codec
 *
 * @param pcm16_stereo  Input PCM16LE stereo samples (interleaved L,R)
 * @param num_samples   Number of samples per channel (supports non-power-of-2, min 1024)
 * @param quality       Quality level 0-5 (0=lowest, 5=highest)
 * @param use_zstd      1=enable Zstd compression, 0=disable
 * @param output        Output buffer (must be large enough)
 * @return              Number of bytes written to output, or 0 on error
 *
 * Output format:
 *   uint8  sigmap_method (always 1 = 2-bit twobitmap)
 *   uint8  compressed_flag (1=Zstd, 0=raw)
 *   uint16 sample_count (samples per channel)
 *   uint32 payload_size (bytes in payload)
 *   *      payload (encoded M/S data, optionally Zstd-compressed)
 */
size_t tad_encode_chunk(const int16_t *pcm16_stereo, size_t num_samples, int quality,
                        int use_zstd, uint8_t *output);

#endif // TAD_ENCODER_H
