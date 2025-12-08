/**
 * TAV Encoder Library - Tile Processing
 *
 * Functions for padded tile extraction and DWT processing.
 * Used when video dimensions exceed monoblock threshold (720x576).
 */

#ifndef TAV_ENCODER_TILE_H
#define TAV_ENCODER_TILE_H

#include <stdint.h>
#include <stddef.h>
#include "../../include/tav_encoder_lib.h"

// Tile dimensions (from header)
// TAV_TILE_SIZE_X = 640, TAV_TILE_SIZE_Y = 540
// TAV_PADDED_TILE_SIZE_X = 704, TAV_PADDED_TILE_SIZE_Y = 604
// TAV_TILE_MARGIN = 32

/**
 * Extract a padded tile from full-frame YCoCg buffers.
 *
 * Extracts a tile at position (tile_x, tile_y) with TAV_TILE_MARGIN pixels
 * of padding on all sides for seamless DWT processing. Uses symmetric
 * extension (mirroring) at frame boundaries.
 *
 * @param frame_y       Full frame Y channel
 * @param frame_co      Full frame Co channel
 * @param frame_cg      Full frame Cg channel
 * @param frame_width   Full frame width
 * @param frame_height  Full frame height
 * @param tile_x        Tile X index (0-based)
 * @param tile_y        Tile Y index (0-based)
 * @param padded_y      Output: Padded tile Y (PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y floats)
 * @param padded_co     Output: Padded tile Co
 * @param padded_cg     Output: Padded tile Cg
 */
void tav_extract_padded_tile(const float *frame_y, const float *frame_co, const float *frame_cg,
                             int frame_width, int frame_height,
                             int tile_x, int tile_y,
                             float *padded_y, float *padded_co, float *padded_cg);

/**
 * Apply 2D DWT forward transform to a padded tile.
 *
 * Uses fixed PADDED_TILE_SIZE dimensions (704x604) for optimal performance.
 *
 * @param tile_data     Tile data (modified in-place)
 * @param levels        Number of decomposition levels
 * @param filter_type   Wavelet filter type (0=CDF 5/3, 1=CDF 9/7, etc.)
 */
void tav_dwt_2d_forward_padded_tile(float *tile_data, int levels, int filter_type);

/**
 * Apply 2D DWT inverse transform to a padded tile.
 *
 * @param tile_data     Tile data (modified in-place)
 * @param levels        Number of decomposition levels
 * @param filter_type   Wavelet filter type
 */
void tav_dwt_2d_inverse_padded_tile(float *tile_data, int levels, int filter_type);

/**
 * Crop a padded tile to its core region (removing margins).
 *
 * Extracts the central TAV_TILE_SIZE_X × TAV_TILE_SIZE_Y region from a padded tile.
 *
 * @param padded_data   Padded tile (PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y)
 * @param core_data     Output: Core tile (TILE_SIZE_X * TILE_SIZE_Y)
 */
void tav_crop_tile_margins(const float *padded_data, float *core_data);

/**
 * Crop a padded tile to actual dimensions for edge tiles.
 *
 * For tiles at the right/bottom edges of a frame, the actual tile may be
 * smaller than TILE_SIZE_X × TILE_SIZE_Y. This function handles that case.
 *
 * @param padded_data   Padded tile (PADDED_TILE_SIZE_X * PADDED_TILE_SIZE_Y)
 * @param core_data     Output: Core tile data
 * @param actual_width  Actual tile width (may be < TILE_SIZE_X for edge tiles)
 * @param actual_height Actual tile height (may be < TILE_SIZE_Y for edge tiles)
 */
void tav_crop_tile_margins_edge(const float *padded_data, float *core_data,
                                int actual_width, int actual_height);

/**
 * Calculate actual tile dimensions for a given tile position.
 *
 * Edge tiles may be smaller than the standard tile size.
 *
 * @param frame_width   Full frame width
 * @param frame_height  Full frame height
 * @param tile_x        Tile X index
 * @param tile_y        Tile Y index
 * @param tile_width    Output: Actual tile width
 * @param tile_height   Output: Actual tile height
 */
void tav_get_tile_dimensions(int frame_width, int frame_height,
                             int tile_x, int tile_y,
                             int *tile_width, int *tile_height);

#endif // TAV_ENCODER_TILE_H
