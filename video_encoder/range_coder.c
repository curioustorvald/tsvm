// Simple range coder for TAD audio codec
// Based on range coding with Laplacian probability model

#include "range_coder.h"
#include <string.h>
#include <math.h>

#define TOP_VALUE 0xFFFFFFFFU
#define BOTTOM_VALUE 0x00FFFFFF

static inline void range_encoder_put_byte(RangeEncoder *enc, uint8_t byte) {
    if (enc->buffer_pos < enc->buffer_capacity) {
        enc->buffer[enc->buffer_pos++] = byte;
    }
}

static inline uint8_t range_decoder_get_byte(RangeDecoder *dec) {
    if (dec->buffer_pos < dec->buffer_size) {
        return dec->buffer[dec->buffer_pos++];
    }
    return 0;
}

static void range_encoder_renormalize(RangeEncoder *enc) {
    while (enc->range <= BOTTOM_VALUE) {
        range_encoder_put_byte(enc, (enc->low >> 24) & 0xFF);
        enc->low <<= 8;
        enc->range <<= 8;
    }
}

static void range_decoder_renormalize(RangeDecoder *dec) {
    while (dec->range <= BOTTOM_VALUE) {
        dec->code = (dec->code << 8) | range_decoder_get_byte(dec);
        dec->low <<= 8;
        dec->range <<= 8;
    }
}

void range_encoder_init(RangeEncoder *enc, uint8_t *buffer, size_t capacity) {
    enc->low = 0;
    enc->range = TOP_VALUE;
    enc->buffer = buffer;
    enc->buffer_pos = 0;
    enc->buffer_capacity = capacity;
}

// Calculate Laplacian CDF for a given value
// CDF(x) = 0.5 * exp(λx) for x < 0
// CDF(x) = 1 - 0.5 * exp(-λx) for x ≥ 0
static inline double laplacian_cdf(int16_t value, float lambda) {
    if (value < 0) {
        return 0.5 * exp(lambda * value);
    } else {
        return 1.0 - 0.5 * exp(-lambda * value);
    }
}

void range_encode_int16_laplacian(RangeEncoder *enc, int16_t value, int16_t max_abs_value, float lambda) {
    // Clamp to valid range
    if (value < -max_abs_value) value = -max_abs_value;
    if (value > max_abs_value) value = max_abs_value;

    // Calculate cumulative probabilities using Laplacian distribution
    // We need CDF at value and value+1 to get the probability mass for this symbol
    double cdf_low = (value == -max_abs_value) ? 0.0 : laplacian_cdf(value - 1, lambda);
    double cdf_high = laplacian_cdf(value, lambda);

    // Normalize to get cumulative counts in range [0, SCALE]
    const uint32_t SCALE = 0x10000;  // 65536 for precision
    uint32_t cum_low = (uint32_t)(cdf_low * SCALE);
    uint32_t cum_high = (uint32_t)(cdf_high * SCALE);

    // Ensure we have at least 1 unit of probability
    if (cum_high <= cum_low) cum_high = cum_low + 1;
    if (cum_high > SCALE) cum_high = SCALE;

    // Encode using cumulative probabilities
    uint64_t range_64 = (uint64_t)enc->range;
    enc->low += (uint32_t)((range_64 * cum_low) / SCALE);
    enc->range = (uint32_t)((range_64 * (cum_high - cum_low)) / SCALE);

    range_encoder_renormalize(enc);
}

size_t range_encoder_finish(RangeEncoder *enc) {
    // Flush remaining bytes
    for (int i = 0; i < 4; i++) {
        range_encoder_put_byte(enc, (enc->low >> 24) & 0xFF);
        enc->low <<= 8;
    }
    return enc->buffer_pos;
}

void range_decoder_init(RangeDecoder *dec, const uint8_t *buffer, size_t size) {
    dec->low = 0;
    dec->range = TOP_VALUE;
    dec->code = 0;
    dec->buffer = buffer;
    dec->buffer_pos = 0;
    dec->buffer_size = size;

    // Read initial bytes into code
    for (int i = 0; i < 4; i++) {
        dec->code = (dec->code << 8) | range_decoder_get_byte(dec);
    }
}

int16_t range_decode_int16_laplacian(RangeDecoder *dec, int16_t max_abs_value, float lambda) {
    const uint32_t SCALE = 0x10000;  // Must match encoder

    // Calculate current position in probability space
    uint64_t range_64 = (uint64_t)dec->range;
    uint32_t cum_freq = (uint32_t)(((uint64_t)(dec->code - dec->low) * SCALE) / range_64);

    // Binary search to find symbol whose CDF range contains cum_freq
    int16_t low = -max_abs_value;
    int16_t high = max_abs_value;
    int16_t value = 0;

    while (low <= high) {
        int16_t mid = (low + high) / 2;

        double cdf_low = (mid == -max_abs_value) ? 0.0 : laplacian_cdf(mid - 1, lambda);
        double cdf_high = laplacian_cdf(mid, lambda);

        uint32_t cum_low = (uint32_t)(cdf_low * SCALE);
        uint32_t cum_high = (uint32_t)(cdf_high * SCALE);

        if (cum_high <= cum_low) cum_high = cum_low + 1;

        if (cum_freq >= cum_low && cum_freq < cum_high) {
            // Found the symbol
            value = mid;

            // Update decoder state
            dec->low += (uint32_t)((range_64 * cum_low) / SCALE);
            dec->range = (uint32_t)((range_64 * (cum_high - cum_low)) / SCALE);

            range_decoder_renormalize(dec);
            return value;
        } else if (cum_freq < cum_low) {
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    // Fallback: shouldn't happen with correct encoding
    range_decoder_renormalize(dec);
    return value;
}
