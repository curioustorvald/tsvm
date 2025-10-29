#ifndef TAD32_ENCODER_H
#define TAD32_ENCODER_H

#include <stdint.h>
#include <stddef.h>

// TAD32 (Terrarum Advanced Audio - PCM32f version) Encoder
// DWT-based perceptual audio codec for TSVM
// Alternative version: PCM32f throughout encoding, PCM8 conversion only at decoder

// Constants
#define TAD32_COEFF_SCALARS {64.0f, 45.255f, 32.0f, 22.627f, 16.0f, 11.314f, 8.0f, 5.657f, 4.0f, 2.828f} // value only valid for CDF 9/7 with decomposition level 9. Index 0 = LL band
#define TAD32_MIN_CHUNK_SIZE 1024       // Minimum: 1024 samples
#define TAD32_SAMPLE_RATE 32000
#define TAD32_CHANNELS 2  // Stereo
#define TAD32_SIGMAP_2BIT 1  // 2-bit: 00=0, 01=+1, 10=-1, 11=other
#define TAD32_QUALITY_MIN 0
#define TAD32_QUALITY_MAX 5
#define TAD32_QUALITY_DEFAULT 3
#define TAD32_ZSTD_LEVEL 15

/**
 * Encode audio chunk with TAD32 codec (PCM32f version)
 *
 * @param pcm32_stereo    Input PCM32fLE stereo samples (interleaved L,R)
 * @param num_samples     Number of samples per channel (min 1024)
 * @param quant_bits      Quantization bits 4-12 (default: 7)
 * @param use_zstd        1=enable Zstd compression, 0=disable
 * @param use_twobitmap   1=enable twobitmap encoding, 0=raw int8_t storage
 * @param quantiser_scale Quantiser scaling factor (1.0=baseline, 2.0=2x coarser quantization)
 *                        Higher values = more aggressive quantization = smaller files
 * @param output          Output buffer (must be large enough)
 * @return                Number of bytes written to output, or 0 on error
 *
 * Output format:
 *   uint16 sample_count (samples per channel)
 *   uint8  quant_bits (quantization bits used)
 *   uint32 payload_size (bytes in payload)
 *   *      payload (encoded M/S data, optionally Zstd-compressed)
 */
size_t tad32_encode_chunk(const float *pcm32_stereo, size_t num_samples,
                          int quant_bits,
                          float quantiser_scale, uint8_t *output);

/**
 * Print accumulated coefficient statistics
 * Only effective if TAD_COEFF_STATS environment variable is set
 */
void tad32_print_statistics(void);

/**
 * Free accumulated statistics memory
 * Should be called after tad32_print_statistics()
 */
void tad32_free_statistics(void);

#endif // TAD32_ENCODER_H
