/**
 * TAV Encoder Library - Tile Processing Implementation
 */

#include "tav_encoder_tile.h"
#include "tav_encoder_dwt.h"
#include <string.h>
#include <stdlib.h>

#define CLAMP(x, min, max) ((x) < (min) ? (min) : ((x) > (max) ? (max) : (x)))

void tav_extract_padded_tile(const float *frame_y, const float *frame_co, const float *frame_cg,
                             int frame_width, int frame_height,
                             int tile_x, int tile_y,
                             float *padded_y, float *padded_co, float *padded_cg) {
    const int core_start_x = tile_x * TAV_TILE_SIZE_X;
    const int core_start_y = tile_y * TAV_TILE_SIZE_Y;

    // Process row by row with bulk copying for core region where possible
    for (int py = 0; py < TAV_PADDED_TILE_SIZE_Y; py++) {
        // Map padded row to source image row
        int src_y = core_start_y + py - TAV_TILE_MARGIN;

        // Handle vertical boundary conditions with mirroring
        if (src_y < 0) {
            src_y = -src_y;
        } else if (src_y >= frame_height) {
            src_y = frame_height - 1 - (src_y - frame_height);
        }
        src_y = CLAMP(src_y, 0, frame_height - 1);

        // Calculate source and destination row offsets
        const int padded_row_offset = py * TAV_PADDED_TILE_SIZE_X;
        const int src_row_offset = src_y * frame_width;

        // Margin boundaries in padded tile
        const int core_start_px = TAV_TILE_MARGIN;
        const int core_end_px = TAV_TILE_MARGIN + TAV_TILE_SIZE_X;

        // Check if core region is entirely within frame bounds
        const int core_src_start_x = core_start_x;
        const int core_src_end_x = core_start_x + TAV_TILE_SIZE_X;

        if (core_src_start_x >= 0 && core_src_end_x <= frame_width) {
            // Bulk copy core region in one operation
            const int src_core_offset = src_row_offset + core_src_start_x;

            memcpy(&padded_y[padded_row_offset + core_start_px],
                   &frame_y[src_core_offset],
                   TAV_TILE_SIZE_X * sizeof(float));
            memcpy(&padded_co[padded_row_offset + core_start_px],
                   &frame_co[src_core_offset],
                   TAV_TILE_SIZE_X * sizeof(float));
            memcpy(&padded_cg[padded_row_offset + core_start_px],
                   &frame_cg[src_core_offset],
                   TAV_TILE_SIZE_X * sizeof(float));

            // Handle left margin pixels individually
            for (int px = 0; px < core_start_px; px++) {
                int src_x = core_start_x + px - TAV_TILE_MARGIN;
                if (src_x < 0) src_x = -src_x;
                src_x = CLAMP(src_x, 0, frame_width - 1);

                int src_idx = src_row_offset + src_x;
                int padded_idx = padded_row_offset + px;

                padded_y[padded_idx] = frame_y[src_idx];
                padded_co[padded_idx] = frame_co[src_idx];
                padded_cg[padded_idx] = frame_cg[src_idx];
            }

            // Handle right margin pixels individually
            for (int px = core_end_px; px < TAV_PADDED_TILE_SIZE_X; px++) {
                int src_x = core_start_x + px - TAV_TILE_MARGIN;
                if (src_x >= frame_width) {
                    src_x = frame_width - 1 - (src_x - frame_width);
                }
                src_x = CLAMP(src_x, 0, frame_width - 1);

                int src_idx = src_row_offset + src_x;
                int padded_idx = padded_row_offset + px;

                padded_y[padded_idx] = frame_y[src_idx];
                padded_co[padded_idx] = frame_co[src_idx];
                padded_cg[padded_idx] = frame_cg[src_idx];
            }
        } else {
            // Fallback: process entire row pixel by pixel (for edge tiles)
            for (int px = 0; px < TAV_PADDED_TILE_SIZE_X; px++) {
                int src_x = core_start_x + px - TAV_TILE_MARGIN;

                // Handle horizontal boundary conditions with mirroring
                if (src_x < 0) {
                    src_x = -src_x;
                } else if (src_x >= frame_width) {
                    src_x = frame_width - 1 - (src_x - frame_width);
                }
                src_x = CLAMP(src_x, 0, frame_width - 1);

                int src_idx = src_row_offset + src_x;
                int padded_idx = padded_row_offset + px;

                padded_y[padded_idx] = frame_y[src_idx];
                padded_co[padded_idx] = frame_co[src_idx];
                padded_cg[padded_idx] = frame_cg[src_idx];
            }
        }
    }
}

// Use existing 2D DWT from tav_encoder_dwt.c
// For padded tiles, we simply call the existing function with tile dimensions

void tav_dwt_2d_forward_padded_tile(float *tile_data, int levels, int filter_type) {
    // Use the existing 2D DWT with padded tile dimensions
    tav_dwt_2d_forward(tile_data, TAV_PADDED_TILE_SIZE_X, TAV_PADDED_TILE_SIZE_Y,
                       levels, filter_type);
}

void tav_dwt_2d_inverse_padded_tile(float *tile_data, int levels, int filter_type) {
    // Note: Inverse transform not yet implemented in library for arbitrary dimensions
    // For now, this is a placeholder - decoder uses different code path
    (void)tile_data;
    (void)levels;
    (void)filter_type;
}

void tav_crop_tile_margins(const float *padded_data, float *core_data) {
    for (int y = 0; y < TAV_TILE_SIZE_Y; y++) {
        const int padded_row = (y + TAV_TILE_MARGIN) * TAV_PADDED_TILE_SIZE_X + TAV_TILE_MARGIN;
        const int core_row = y * TAV_TILE_SIZE_X;
        memcpy(&core_data[core_row], &padded_data[padded_row], TAV_TILE_SIZE_X * sizeof(float));
    }
}

void tav_crop_tile_margins_edge(const float *padded_data, float *core_data,
                                int actual_width, int actual_height) {
    for (int y = 0; y < actual_height; y++) {
        const int padded_row = (y + TAV_TILE_MARGIN) * TAV_PADDED_TILE_SIZE_X + TAV_TILE_MARGIN;
        const int core_row = y * actual_width;
        memcpy(&core_data[core_row], &padded_data[padded_row], actual_width * sizeof(float));
    }
}

void tav_get_tile_dimensions(int frame_width, int frame_height,
                             int tile_x, int tile_y,
                             int *tile_width, int *tile_height) {
    // Calculate the starting position of this tile
    int start_x = tile_x * TAV_TILE_SIZE_X;
    int start_y = tile_y * TAV_TILE_SIZE_Y;

    // Calculate how much of the frame is left from this starting position
    int remaining_width = frame_width - start_x;
    int remaining_height = frame_height - start_y;

    // Tile width is the minimum of standard tile size and remaining width
    *tile_width = (remaining_width < TAV_TILE_SIZE_X) ? remaining_width : TAV_TILE_SIZE_X;
    *tile_height = (remaining_height < TAV_TILE_SIZE_Y) ? remaining_height : TAV_TILE_SIZE_Y;
}
