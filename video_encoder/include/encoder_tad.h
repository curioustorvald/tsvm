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
#define TAD32_QUALITY_MIN 0
#define TAD32_QUALITY_MAX 6
#define TAD32_QUALITY_DEFAULT 3
#define TAD32_ZSTD_LEVEL 15

static inline int tad32_quality_to_max_index(int quality) {
    static const int quality_map[6] = {21, 31, 44, 63, 89, 127};
    if (quality < 0) quality = 0;
    if (quality > 5) quality = 5;
    return quality_map[quality];
}

/**
 * Encode audio chunk with TAD32 codec (PCM32f version)
 *
 * @param pcm32_stereo    Input PCM32fLE stereo samples (interleaved L,R)
 * @param num_samples     Number of samples per channel (min 1024)
 * @param max_index       Maximum quantisation index (7=3bit, 15=4bit, 31=5bit, 63=6bit, 127=7bit)
 * @param quantiser_scale Quantiser scaling factor (1.0=baseline, 2.0=2x coarser quantisation)
 *                        Higher values = more aggressive quantisation = smaller files
 * @param zstd_level      Zstd compression level (1-22). Use negative value to disable compression.
 *                        When disabled, MSB of payload_size is set to indicate uncompressed data.
 * @param output          Output buffer (must be large enough)
 * @return                Number of bytes written to output, or 0 on error
 *
 * Output format:
 *   uint16 sample_count (samples per channel)
 *   uint8  max_index (maximum quantisation index)
 *   uint32 payload_size (bytes in payload; MSB=1 indicates uncompressed)
 *   *      payload (encoded M/S data, optionally Zstd-compressed)
 */
size_t tad32_encode_chunk(const float *pcm32_stereo, size_t num_samples,
                          int max_index,
                          float quantiser_scale, int zstd_level, uint8_t *output);

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
