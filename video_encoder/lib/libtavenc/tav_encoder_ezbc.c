/**
 * TAV Encoder - EZBC (Embedded Zero Block Coding) Library
 *
 * Implements binary tree embedded zero block coding for efficient storage
 * of sparse wavelet coefficients. Exploits coefficient sparsity through
 * hierarchical significance testing and progressive bitplane encoding.
 *
 * Extracted from encoder_tav.c as part of library refactoring.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <stdbool.h>
#include <math.h>

// =============================================================================
// EZBC Structures
// =============================================================================

/**
 * Bitstream writer for bit-level encoding.
 */
typedef struct {
    uint8_t *data;
    size_t capacity;
    size_t byte_pos;
    uint8_t bit_pos;  // 0-7, current bit position in current byte
} bitstream_t;

/**
 * Block structure for EZBC quadtree decomposition.
 */
typedef struct {
    int x, y;           // Top-left position in 2D coefficient array
    int width, height;  // Block dimensions
} ezbc_block_t;

/**
 * Queue for EZBC block processing.
 */
typedef struct {
    ezbc_block_t *blocks;
    size_t count;
    size_t capacity;
} block_queue_t;

/**
 * Track coefficient state for refinement.
 */
typedef struct {
    bool significant;     // Has been marked significant
    int first_bitplane;   // Bitplane where it became significant
} coeff_state_t;

/**
 * EZBC encoding context for recursive processing.
 */
typedef struct {
    bitstream_t *bs;
    int16_t *coeffs;
    coeff_state_t *states;
    int width;
    int height;
    int bitplane;
    int threshold;
    block_queue_t *next_insignificant;
    block_queue_t *next_significant;
    int *sign_count;
} ezbc_context_t;

// =============================================================================
// Bitstream Operations
// =============================================================================

/**
 * Initialize bitstream with initial capacity.
 */
static void bitstream_init(bitstream_t *bs, size_t initial_capacity) {
    // Ensure minimum capacity to avoid issues with zero-size allocations
    if (initial_capacity < 64) initial_capacity = 64;
    bs->capacity = initial_capacity;
    bs->data = calloc(1, initial_capacity);
    if (!bs->data) {
        fprintf(stderr, "ERROR: Failed to allocate bitstream buffer of size %zu\n", initial_capacity);
        exit(1);
    }
    bs->byte_pos = 0;
    bs->bit_pos = 0;
}

/**
 * Write a single bit to bitstream.
 */
static void bitstream_write_bit(bitstream_t *bs, int bit) {
    // Grow if needed
    if (bs->byte_pos >= bs->capacity) {
        size_t old_capacity = bs->capacity;
        bs->capacity *= 2;
        bs->data = realloc(bs->data, bs->capacity);
        // Clear only the newly allocated memory region
        memset(bs->data + old_capacity, 0, bs->capacity - old_capacity);
    }

    if (bit) {
        bs->data[bs->byte_pos] |= (1 << bs->bit_pos);
    }

    bs->bit_pos++;
    if (bs->bit_pos == 8) {
        bs->bit_pos = 0;
        bs->byte_pos++;
    }
}

/**
 * Write multiple bits to bitstream (LSB first).
 */
static void bitstream_write_bits(bitstream_t *bs, uint32_t value, int num_bits) {
    for (int i = 0; i < num_bits; i++) {
        bitstream_write_bit(bs, (value >> i) & 1);
    }
}

/**
 * Get current bitstream size in bytes.
 */
static size_t bitstream_size(bitstream_t *bs) {
    return bs->byte_pos + (bs->bit_pos > 0 ? 1 : 0);
}

/**
 * Free bitstream buffer.
 */
static void bitstream_free(bitstream_t *bs) {
    free(bs->data);
}

// =============================================================================
// Block Queue Operations
// =============================================================================

/**
 * Initialize block queue with initial capacity.
 */
static void queue_init(block_queue_t *q) {
    q->capacity = 1024;
    q->blocks = malloc(q->capacity * sizeof(ezbc_block_t));
    q->count = 0;
}

/**
 * Push block onto queue, growing if needed.
 */
static void queue_push(block_queue_t *q, ezbc_block_t block) {
    if (q->count >= q->capacity) {
        q->capacity *= 2;
        q->blocks = realloc(q->blocks, q->capacity * sizeof(ezbc_block_t));
    }
    q->blocks[q->count++] = block;
}

/**
 * Free block queue.
 */
static void queue_free(block_queue_t *q) {
    free(q->blocks);
}

// =============================================================================
// EZBC Helper Functions
// =============================================================================

/**
 * Check if all coefficients in block have |coeff| < threshold.
 */
static bool is_zero_block_ezbc(int16_t *coeffs, int width, int height,
                                const ezbc_block_t *block, int threshold) {
    for (int y = block->y; y < block->y + block->height && y < height; y++) {
        for (int x = block->x; x < block->x + block->width && x < width; x++) {
            int idx = y * width + x;
            if (abs(coeffs[idx]) >= threshold) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Find maximum absolute value in coefficient array.
 */
static int find_max_abs_ezbc(int16_t *coeffs, size_t count) {
    int max_abs = 0;
    for (size_t i = 0; i < count; i++) {
        int abs_val = abs(coeffs[i]);
        if (abs_val > max_abs) {
            max_abs = abs_val;
        }
    }
    return max_abs;
}

/**
 * Get MSB position (bitplane number).
 * Returns floor(log2(value)), i.e., the position of the highest set bit.
 */
static int get_msb_bitplane(int value) {
    if (value == 0) return 0;
    int bitplane = 0;
    while (value > 1) {
        value >>= 1;
        bitplane++;
    }
    return bitplane;
}

/**
 * Recursively process a significant block - subdivide until 1x1.
 */
static void process_significant_block_recursive(ezbc_context_t *ctx, ezbc_block_t block) {
    // If 1x1 block: emit sign bit and add to significant queue
    if (block.width == 1 && block.height == 1) {
        int idx = block.y * ctx->width + block.x;
        bitstream_write_bit(ctx->bs, ctx->coeffs[idx] < 0 ? 1 : 0);
        (*ctx->sign_count)++;
        ctx->states[idx].significant = true;
        ctx->states[idx].first_bitplane = ctx->bitplane;
        queue_push(ctx->next_significant, block);
        return;
    }

    // Block is > 1x1: subdivide into children and recursively process each
    int mid_x = block.width / 2;
    int mid_y = block.height / 2;
    if (mid_x == 0) mid_x = 1;
    if (mid_y == 0) mid_y = 1;

    // Process top-left child
    ezbc_block_t tl = {block.x, block.y, mid_x, mid_y};
    if (!is_zero_block_ezbc(ctx->coeffs, ctx->width, ctx->height, &tl, ctx->threshold)) {
        bitstream_write_bit(ctx->bs, 1);  // Significant
        process_significant_block_recursive(ctx, tl);
    } else {
        bitstream_write_bit(ctx->bs, 0);  // Insignificant
        queue_push(ctx->next_insignificant, tl);
    }

    // Process top-right child (if exists)
    if (block.width > mid_x) {
        ezbc_block_t tr = {block.x + mid_x, block.y, block.width - mid_x, mid_y};
        if (!is_zero_block_ezbc(ctx->coeffs, ctx->width, ctx->height, &tr, ctx->threshold)) {
            bitstream_write_bit(ctx->bs, 1);
            process_significant_block_recursive(ctx, tr);
        } else {
            bitstream_write_bit(ctx->bs, 0);
            queue_push(ctx->next_insignificant, tr);
        }
    }

    // Process bottom-left child (if exists)
    if (block.height > mid_y) {
        ezbc_block_t bl = {block.x, block.y + mid_y, mid_x, block.height - mid_y};
        if (!is_zero_block_ezbc(ctx->coeffs, ctx->width, ctx->height, &bl, ctx->threshold)) {
            bitstream_write_bit(ctx->bs, 1);
            process_significant_block_recursive(ctx, bl);
        } else {
            bitstream_write_bit(ctx->bs, 0);
            queue_push(ctx->next_insignificant, bl);
        }
    }

    // Process bottom-right child (if exists)
    if (block.width > mid_x && block.height > mid_y) {
        ezbc_block_t br = {block.x + mid_x, block.y + mid_y, block.width - mid_x, block.height - mid_y};
        if (!is_zero_block_ezbc(ctx->coeffs, ctx->width, ctx->height, &br, ctx->threshold)) {
            bitstream_write_bit(ctx->bs, 1);
            process_significant_block_recursive(ctx, br);
        } else {
            bitstream_write_bit(ctx->bs, 0);
            queue_push(ctx->next_insignificant, br);
        }
    }
}

// =============================================================================
// Main EZBC Encoding Function
// =============================================================================

/**
 * EZBC encoding for a single channel.
 *
 * Uses two separate queues for insignificant blocks and significant 1x1 blocks.
 * Encodes coefficients progressively from MSB to LSB bitplane.
 *
 * Algorithm:
 * 1. Find MSB bitplane from maximum absolute coefficient value
 * 2. Write header: MSB bitplane, width, height
 * 3. For each bitplane from MSB to 0:
 *    a. Process insignificant blocks: check if they become significant
 *    b. For newly significant blocks: recursively subdivide until 1x1
 *    c. Emit sign bits for newly significant 1x1 coefficients
 *    d. Process already-significant coefficients: emit refinement bits
 * 4. Return encoded bitstream
 *
 * @param coeffs  Input quantized coefficients (int16_t array)
 * @param count   Number of coefficients
 * @param width   Frame width
 * @param height  Frame height
 * @param output  Output buffer pointer (allocated by this function)
 * @return        Encoded size in bytes
 */
size_t tav_encode_channel_ezbc(int16_t *coeffs, size_t count, int width, int height,
                                uint8_t **output) {
    bitstream_t bs;
    bitstream_init(&bs, count / 4);  // Initial guess

    // Track coefficient significance
    coeff_state_t *states = calloc(count, sizeof(coeff_state_t));

    // Find maximum value to determine MSB bitplane
    int max_abs = find_max_abs_ezbc(coeffs, count);
    int msb_bitplane = get_msb_bitplane(max_abs);

    // Write header: MSB bitplane and dimensions
    bitstream_write_bits(&bs, msb_bitplane, 8);
    bitstream_write_bits(&bs, width, 16);
    bitstream_write_bits(&bs, height, 16);

    // Initialise two queues: insignificant blocks and significant 1x1 blocks
    block_queue_t insignificant_queue, next_insignificant;
    block_queue_t significant_queue, next_significant;

    queue_init(&insignificant_queue);
    queue_init(&next_insignificant);
    queue_init(&significant_queue);
    queue_init(&next_significant);

    // Start with root block as insignificant
    ezbc_block_t root = {0, 0, width, height};
    queue_push(&insignificant_queue, root);

    // Process bitplanes from MSB to LSB
    for (int bitplane = msb_bitplane; bitplane >= 0; bitplane--) {
        int threshold = 1 << bitplane;

        int sign_bits_this_bitplane = 0;

        // Process insignificant blocks - check if they become significant
        for (size_t i = 0; i < insignificant_queue.count; i++) {
            ezbc_block_t block = insignificant_queue.blocks[i];

            // Check if this block has any coefficient >= threshold
            if (is_zero_block_ezbc(coeffs, width, height, &block, threshold)) {
                // Still insignificant: emit 0
                bitstream_write_bit(&bs, 0);
                // Keep in insignificant queue for next bitplane
                queue_push(&next_insignificant, block);
            } else {
                // Became significant: emit 1
                bitstream_write_bit(&bs, 1);

                // Use recursive subdivision to process this block and all children
                ezbc_context_t ctx = {
                    .bs = &bs,
                    .coeffs = coeffs,
                    .states = states,
                    .width = width,
                    .height = height,
                    .bitplane = bitplane,
                    .threshold = threshold,
                    .next_insignificant = &next_insignificant,
                    .next_significant = &next_significant,
                    .sign_count = &sign_bits_this_bitplane
                };
                process_significant_block_recursive(&ctx, block);
            }
        }

        // Process significant 1x1 blocks - emit refinement bits
        for (size_t i = 0; i < significant_queue.count; i++) {
            ezbc_block_t block = significant_queue.blocks[i];
            int idx = block.y * width + block.x;
            int abs_val = abs(coeffs[idx]);

            // Emit refinement bit at current bitplane
            int bit = (abs_val >> bitplane) & 1;
            bitstream_write_bit(&bs, bit);

            // Keep in significant queue for next bitplane
            queue_push(&next_significant, block);
        }

        // Swap queues for next bitplane
        queue_free(&insignificant_queue);
        queue_free(&significant_queue);
        insignificant_queue = next_insignificant;
        significant_queue = next_significant;
        queue_init(&next_insignificant);
        queue_init(&next_significant);
    }

    // Free all queues
    queue_free(&insignificant_queue);
    queue_free(&significant_queue);
    queue_free(&next_insignificant);
    queue_free(&next_significant);
    free(states);

    size_t final_size = bitstream_size(&bs);
    *output = bs.data;

    return final_size;
}
