#ifndef RANGE_CODER_H
#define RANGE_CODER_H

#include <stdint.h>
#include <stddef.h>

// Simple range coder for signed 16-bit integers
// Uses adaptive frequency model for better compression

typedef struct {
    uint32_t low;
    uint32_t range;
    uint8_t *buffer;
    size_t buffer_pos;
    size_t buffer_capacity;
} RangeEncoder;

typedef struct {
    uint32_t low;
    uint32_t range;
    uint32_t code;
    const uint8_t *buffer;
    size_t buffer_pos;
    size_t buffer_size;
} RangeDecoder;

// Initialize encoder
void range_encoder_init(RangeEncoder *enc, uint8_t *buffer, size_t capacity);

// Encode a signed 16-bit value with Laplacian distribution (λ=5.0, μ=0)
void range_encode_int16_laplacian(RangeEncoder *enc, int16_t value, int16_t max_abs_value, float lambda);

// Finalize encoding and return bytes written
size_t range_encoder_finish(RangeEncoder *enc);

// Initialize decoder
void range_decoder_init(RangeDecoder *dec, const uint8_t *buffer, size_t size);

// Decode a signed 16-bit value with Laplacian distribution (λ=5.0, μ=0)
int16_t range_decode_int16_laplacian(RangeDecoder *dec, int16_t max_abs_value, float lambda);

#endif // RANGE_CODER_H
