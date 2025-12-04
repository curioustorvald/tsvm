// TEV Entropy Coder - Specialised for DCT coefficients
// Replaces gzip with video-optimized compression
#ifndef ENTROPY_CODER_H
#define ENTROPY_CODER_H

#include <stdint.h>
#include <stdio.h>

// Bit writer for variable-length codes
typedef struct {
    uint8_t *buffer;
    size_t buffer_size;
    size_t byte_pos;
    int bit_pos;  // 0-7, next bit to write
} bit_writer_t;

// Bit reader for decoding
typedef struct {
    const uint8_t *buffer;
    size_t buffer_size;
    size_t byte_pos;
    int bit_pos;  // 0-7, next bit to read
} bit_reader_t;

// Huffman table entry
typedef struct {
    uint16_t code;    // Huffman code
    uint8_t bits;     // Code length in bits
} huffman_entry_t;

// Video entropy coder optimized for TEV coefficients
typedef struct {
    // Huffman tables for different coefficient types
    huffman_entry_t y_dc_table[512];      // Y DC coefficients (-255 to +255)
    huffman_entry_t y_ac_table[512];      // Y AC coefficients
    huffman_entry_t c_dc_table[512];      // Chroma DC coefficients  
    huffman_entry_t c_ac_table[512];      // Chroma AC coefficients
    huffman_entry_t run_table[256];       // Zero run lengths (0-255)
    
    // Motion vector Huffman tables
    huffman_entry_t mv_table[65];         // Motion vectors (-32 to +32)
    
    // Bit writer/reader
    bit_writer_t writer;
    bit_reader_t reader;
} entropy_coder_t;

static const huffman_entry_t BLOCK_MODE_HUFFMAN[16];

void write_bits(bit_writer_t *writer, uint32_t value, int bits);
uint32_t read_bits(bit_reader_t *reader, int bits);

// Initialise entropy coder
entropy_coder_t* entropy_coder_create(uint8_t *buffer, size_t buffer_size);
void entropy_coder_destroy(entropy_coder_t *coder);

// Encoding functions
int encode_y_block(entropy_coder_t *coder, int16_t *y_coeffs);
int encode_chroma_block(entropy_coder_t *coder, int16_t *chroma_coeffs, int is_cg);
int encode_motion_vector(entropy_coder_t *coder, int16_t mv_x, int16_t mv_y);
int encode_block_mode(entropy_coder_t *coder, uint8_t mode);

// Decoding functions  
void entropy_coder_init_reader(entropy_coder_t *coder, const uint8_t *buffer, size_t buffer_size);
int decode_y_block(entropy_coder_t *coder, int16_t *y_coeffs);
int decode_chroma_block(entropy_coder_t *coder, int16_t *chroma_coeffs, int is_cg);
int decode_motion_vector(entropy_coder_t *coder, int16_t *mv_x, int16_t *mv_y);
int decode_block_mode(entropy_coder_t *coder, uint8_t *mode);

// Get compressed size
size_t entropy_coder_get_size(entropy_coder_t *coder);
void entropy_coder_reset(entropy_coder_t *coder);

#endif // ENTROPY_CODER_H