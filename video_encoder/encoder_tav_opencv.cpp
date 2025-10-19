// Created by Claude on 2025-10-17
// MPEG-style bidirectional block motion compensation for TAV encoder
// Simplified: Single-level diamond search, variable blocks, overlaps, sub-pixel refinement

#include <opencv2/opencv.hpp>
#include <cstdlib>
#include <cstring>
#include <cmath>

extern "C" {

// Helper: Compute SAD (Sum of Absolute Differences) for a block
static int compute_sad(
    const unsigned char *ref, const unsigned char *cur,
    int ref_x, int ref_y, int cur_x, int cur_y,
    int width, int height, int block_size
) {
    int sad = 0;
    for (int by = 0; by < block_size; by++) {
        for (int bx = 0; bx < block_size; bx++) {
            int ry = ref_y + by;
            int rx = ref_x + bx;
            int cy = cur_y + by;
            int cx = cur_x + bx;

            // Boundary check
            if (rx < 0 || rx >= width || ry < 0 || ry >= height ||
                cx < 0 || cx >= width || cy < 0 || cy >= height) {
                sad += 255;  // Penalty for out-of-bounds
                continue;
            }

            int ref_val = ref[ry * width + rx];
            int cur_val = cur[cy * width + cx];
            sad += abs(ref_val - cur_val);
        }
    }
    return sad;
}

// Parabolic interpolation for sub-pixel refinement
// Given SAD values at positions (-1, 0, +1), estimate peak location
static float parabolic_interp(int sad_m1, int sad_0, int sad_p1) {
    // Fit parabola: y = a*x^2 + b*x + c
    // Peak at x = -b/(2a) = (sad_m1 - sad_p1) / (2*(sad_m1 - 2*sad_0 + sad_p1))
    int denom = 2 * (sad_m1 - 2 * sad_0 + sad_p1);
    if (denom == 0) return 0.0f;

    float offset = (float)(sad_m1 - sad_p1) / denom;
    // Clamp to ±0.5 for reasonable sub-pixel values
    if (offset < -0.5f) offset = -0.5f;
    if (offset > 0.5f) offset = 0.5f;

    return offset;
}

// Diamond search pattern for integer-pixel motion estimation
static void diamond_search(
    const unsigned char *ref, const unsigned char *cur,
    int cx, int cy, int width, int height, int block_size,
    int search_range, int *best_dx, int *best_dy
) {
    // Large diamond pattern (distance 2)
    const int large_diamond[8][2] = {
        {0, -2}, {-1, -1}, {1, -1}, {-2, 0},
        {2, 0}, {-1, 1}, {1, 1}, {0, 2}
    };

    // Small diamond pattern (distance 1)
    const int small_diamond[4][2] = {
        {0, -1}, {-1, 0}, {1, 0}, {0, 1}
    };

    int dx = 0, dy = 0;
    int best_sad = compute_sad(ref, cur, cx + dx, cy + dy, cx, cy, width, height, block_size);

    // Large diamond search
    bool improved = true;
    while (improved) {
        improved = false;
        for (int i = 0; i < 8; i++) {
            int test_dx = dx + large_diamond[i][0];
            int test_dy = dy + large_diamond[i][1];

            if (abs(test_dx) > search_range || abs(test_dy) > search_range) {
                continue;
            }

            int sad = compute_sad(ref, cur, cx + test_dx, cy + test_dy, cx, cy, width, height, block_size);
            if (sad < best_sad) {
                best_sad = sad;
                dx = test_dx;
                dy = test_dy;
                improved = true;
                break;
            }
        }
    }

    // Small diamond refinement
    improved = true;
    while (improved) {
        improved = false;
        for (int i = 0; i < 4; i++) {
            int test_dx = dx + small_diamond[i][0];
            int test_dy = dy + small_diamond[i][1];

            if (abs(test_dx) > search_range || abs(test_dy) > search_range) {
                continue;
            }

            int sad = compute_sad(ref, cur, cx + test_dx, cy + test_dy, cx, cy, width, height, block_size);
            if (sad < best_sad) {
                best_sad = sad;
                dx = test_dx;
                dy = test_dy;
                improved = true;
                break;
            }
        }
    }

    *best_dx = dx;
    *best_dy = dy;
}

// Sub-pixel refinement using parabolic interpolation
static void subpixel_refinement(
    const unsigned char *ref, const unsigned char *cur,
    int cx, int cy, int width, int height, int block_size,
    int int_dx, int int_dy,  // Integer-pixel motion
    float *subpix_dx, float *subpix_dy  // Output: 1/4-pixel precision
) {
    // Get SAD at integer position and neighbors
    int sad_0_0 = compute_sad(ref, cur, cx + int_dx, cy + int_dy, cx, cy, width, height, block_size);

    // Horizontal neighbors
    int sad_m1_0 = compute_sad(ref, cur, cx + int_dx - 1, cy + int_dy, cx, cy, width, height, block_size);
    int sad_p1_0 = compute_sad(ref, cur, cx + int_dx + 1, cy + int_dy, cx, cy, width, height, block_size);

    // Vertical neighbors
    int sad_0_m1 = compute_sad(ref, cur, cx + int_dx, cy + int_dy - 1, cx, cy, width, height, block_size);
    int sad_0_p1 = compute_sad(ref, cur, cx + int_dx, cy + int_dy + 1, cx, cy, width, height, block_size);

    // Parabolic interpolation
    float offset_x = parabolic_interp(sad_m1_0, sad_0_0, sad_p1_0);
    float offset_y = parabolic_interp(sad_0_m1, sad_0_0, sad_0_p1);

    // Quantize to 1/4-pixel precision
    *subpix_dx = int_dx + roundf(offset_x * 4.0f) / 4.0f;
    *subpix_dy = int_dy + roundf(offset_y * 4.0f) / 4.0f;
}

// MPEG-style bidirectional motion estimation
// Uses variable block sizes (16×16, optionally split to 8×8)
// 4-pixel overlap between blocks to reduce blocking artifacts
// Diamond search + parabolic sub-pixel refinement
void estimate_motion_optical_flow(
    const unsigned char *frame1_rgb, const unsigned char *frame2_rgb,
    int width, int height,
    float **out_flow_x, float **out_flow_y
) {
    // Convert RGB to grayscale
    unsigned char *gray1 = (unsigned char*)std::malloc(width * height);
    unsigned char *gray2 = (unsigned char*)std::malloc(width * height);

    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            int idx = y * width + x;
            int rgb_idx = idx * 3;

            gray1[idx] = (unsigned char)(0.299f * frame1_rgb[rgb_idx] +
                                         0.587f * frame1_rgb[rgb_idx + 1] +
                                         0.114f * frame1_rgb[rgb_idx + 2]);
            gray2[idx] = (unsigned char)(0.299f * frame2_rgb[rgb_idx] +
                                         0.587f * frame2_rgb[rgb_idx + 1] +
                                         0.114f * frame2_rgb[rgb_idx + 2]);
        }
    }

    *out_flow_x = (float*)std::malloc(width * height * sizeof(float));
    *out_flow_y = (float*)std::malloc(width * height * sizeof(float));
    std::memset(*out_flow_x, 0, width * height * sizeof(float));
    std::memset(*out_flow_y, 0, width * height * sizeof(float));

    // Block parameters
    const int block_size = 16;
    const int overlap = 4;
    const int stride = block_size - overlap;  // 12 pixels
    const int search_range = 16;  // ±16 pixels

    // Process overlapping blocks
    for (int by = 0; by < height; by += stride) {
        for (int bx = 0; bx < width; bx += stride) {
            int actual_block_size = block_size;

            // Clamp block to frame boundary
            if (bx + block_size > width || by + block_size > height) {
                continue;  // Skip partial blocks at edges
            }

            // Integer-pixel diamond search
            int int_dx = 0, int_dy = 0;
            diamond_search(gray1, gray2, bx, by, width, height,
                          actual_block_size, search_range, &int_dx, &int_dy);

            // Sub-pixel refinement
            float subpix_dx = 0.0f, subpix_dy = 0.0f;
            subpixel_refinement(gray1, gray2, bx, by, width, height,
                              actual_block_size, int_dx, int_dy,
                              &subpix_dx, &subpix_dy);

            // Fill motion vectors for block with distance-weighted blending in overlap regions
            for (int y = by; y < by + actual_block_size && y < height; y++) {
                for (int x = bx; x < bx + actual_block_size && x < width; x++) {
                    int idx = y * width + x;

                    // Distance from block center for blending weight
                    float dx_from_center = (x - (bx + actual_block_size / 2));
                    float dy_from_center = (y - (by + actual_block_size / 2));
                    float dist = sqrtf(dx_from_center * dx_from_center +
                                      dy_from_center * dy_from_center);

                    // Weight decreases with distance from center (for smooth blending in overlaps)
                    float weight = 1.0f / (1.0f + dist / actual_block_size);

                    // Accumulate weighted motion (will be normalized later)
                    (*out_flow_x)[idx] += subpix_dx * weight;
                    (*out_flow_y)[idx] += subpix_dy * weight;
                }
            }
        }
    }

    std::free(gray1);
    std::free(gray2);
}

// Build distortion mesh from dense optical flow field
void build_mesh_from_flow(
    const float *flow_x, const float *flow_y,
    int width, int height,
    int mesh_w, int mesh_h,
    short *mesh_dx, short *mesh_dy  // Output: 1/8 pixel precision
) {
    int cell_w = width / mesh_w;
    int cell_h = height / mesh_h;

    for (int my = 0; my < mesh_h; my++) {
        for (int mx = 0; mx < mesh_w; mx++) {
            // Cell center coordinates
            int cx = mx * cell_w + cell_w / 2;
            int cy = my * cell_h + cell_h / 2;

            // Sample flow at cell center (5×5 neighborhood for robustness)
            float sum_dx = 0.0f, sum_dy = 0.0f;
            int count = 0;

            for (int dy = -2; dy <= 2; dy++) {
                for (int dx = -2; dx <= 2; dx++) {
                    int px = cx + dx;
                    int py = cy + dy;
                    if (px >= 0 && px < width && py >= 0 && py < height) {
                        int idx = py * width + px;
                        sum_dx += flow_x[idx];
                        sum_dy += flow_y[idx];
                        count++;
                    }
                }
            }

            float avg_dx = (count > 0) ? (sum_dx / count) : 0.0f;
            float avg_dy = (count > 0) ? (sum_dy / count) : 0.0f;

            int mesh_idx = my * mesh_w + mx;
            mesh_dx[mesh_idx] = (short)(avg_dx * 4.0f);  // 1/4 pixel precision
            mesh_dy[mesh_idx] = (short)(avg_dy * 4.0f);
        }
    }
}

// Laplacian smoothing for mesh spatial coherence
void smooth_mesh_laplacian(
    short *mesh_dx, short *mesh_dy,
    int mesh_width, int mesh_height,
    float smoothness, int iterations
) {
    short *temp_dx = (short*)std::malloc(mesh_width * mesh_height * sizeof(short));
    short *temp_dy = (short*)std::malloc(mesh_width * mesh_height * sizeof(short));

    for (int iter = 0; iter < iterations; iter++) {
        std::memcpy(temp_dx, mesh_dx, mesh_width * mesh_height * sizeof(short));
        std::memcpy(temp_dy, mesh_dy, mesh_width * mesh_height * sizeof(short));

        for (int my = 0; my < mesh_height; my++) {
            for (int mx = 0; mx < mesh_width; mx++) {
                int idx = my * mesh_width + mx;

                float neighbor_dx = 0.0f, neighbor_dy = 0.0f;
                int neighbor_count = 0;

                int neighbors[4][2] = {{0, -1}, {0, 1}, {-1, 0}, {1, 0}};
                for (int n = 0; n < 4; n++) {
                    int nx = mx + neighbors[n][0];
                    int ny = my + neighbors[n][1];
                    if (nx >= 0 && nx < mesh_width && ny >= 0 && ny < mesh_height) {
                        int nidx = ny * mesh_width + nx;
                        neighbor_dx += temp_dx[nidx];
                        neighbor_dy += temp_dy[nidx];
                        neighbor_count++;
                    }
                }

                if (neighbor_count > 0) {
                    neighbor_dx /= neighbor_count;
                    neighbor_dy /= neighbor_count;

                    float data_weight = 1.0f - smoothness;
                    mesh_dx[idx] = (short)(data_weight * temp_dx[idx] + smoothness * neighbor_dx);
                    mesh_dy[idx] = (short)(data_weight * temp_dy[idx] + smoothness * neighbor_dy);
                }
            }
        }
    }

    std::free(temp_dx);
    std::free(temp_dy);
}

// Bilinear mesh warp
void warp_frame_with_mesh(
    const float *src_frame, int width, int height,
    const short *mesh_dx, const short *mesh_dy,
    int mesh_width, int mesh_height,
    float *dst_frame
) {
    int cell_w = width / mesh_width;
    int cell_h = height / mesh_height;

    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            int cell_x = x / cell_w;
            int cell_y = y / cell_h;

            if (cell_x >= mesh_width - 1) cell_x = mesh_width - 2;
            if (cell_y >= mesh_height - 1) cell_y = mesh_height - 2;
            if (cell_x < 0) cell_x = 0;
            if (cell_y < 0) cell_y = 0;

            int idx_00 = cell_y * mesh_width + cell_x;
            int idx_10 = idx_00 + 1;
            int idx_01 = (cell_y + 1) * mesh_width + cell_x;
            int idx_11 = idx_01 + 1;

            float cp_x0 = cell_x * cell_w + cell_w / 2.0f;
            float cp_y0 = cell_y * cell_h + cell_h / 2.0f;
            float cp_x1 = (cell_x + 1) * cell_w + cell_w / 2.0f;
            float cp_y1 = (cell_y + 1) * cell_h + cell_h / 2.0f;

            float alpha = (x - cp_x0) / (cp_x1 - cp_x0);
            float beta = (y - cp_y0) / (cp_y1 - cp_y0);
            if (alpha < 0.0f) alpha = 0.0f;
            if (alpha > 1.0f) alpha = 1.0f;
            if (beta < 0.0f) beta = 0.0f;
            if (beta > 1.0f) beta = 1.0f;

            float dx_00 = mesh_dx[idx_00] / 4.0f;
            float dy_00 = mesh_dy[idx_00] / 4.0f;
            float dx_10 = mesh_dx[idx_10] / 4.0f;
            float dy_10 = mesh_dy[idx_10] / 4.0f;
            float dx_01 = mesh_dx[idx_01] / 4.0f;
            float dy_01 = mesh_dy[idx_01] / 4.0f;
            float dx_11 = mesh_dx[idx_11] / 4.0f;
            float dy_11 = mesh_dy[idx_11] / 4.0f;

            float dx = (1 - alpha) * (1 - beta) * dx_00 +
                       alpha * (1 - beta) * dx_10 +
                       (1 - alpha) * beta * dx_01 +
                       alpha * beta * dx_11;

            float dy = (1 - alpha) * (1 - beta) * dy_00 +
                       alpha * (1 - beta) * dy_10 +
                       (1 - alpha) * beta * dy_01 +
                       alpha * beta * dy_11;

            float src_x = x + dx;
            float src_y = y + dy;

            int sx0 = (int)std::floor(src_x);
            int sy0 = (int)std::floor(src_y);
            int sx1 = sx0 + 1;
            int sy1 = sy0 + 1;

            if (sx0 < 0) sx0 = 0;
            if (sy0 < 0) sy0 = 0;
            if (sx1 >= width) sx1 = width - 1;
            if (sy1 >= height) sy1 = height - 1;
            if (sx0 >= width) sx0 = width - 1;
            if (sy0 >= height) sy0 = height - 1;

            float fx = src_x - sx0;
            float fy = src_y - sy0;

            float val_00 = src_frame[sy0 * width + sx0];
            float val_10 = src_frame[sy0 * width + sx1];
            float val_01 = src_frame[sy1 * width + sx0];
            float val_11 = src_frame[sy1 * width + sx1];

            float val = (1 - fx) * (1 - fy) * val_00 +
                        fx * (1 - fy) * val_10 +
                        (1 - fx) * fy * val_01 +
                        fx * fy * val_11;

            dst_frame[y * width + x] = val;
        }
    }
}

// Dense optical flow estimation using Farneback algorithm
// Computes flow at every pixel, then samples at block centers for motion vectors
// Much more spatially coherent than independent block matching
void estimate_optical_flow_motion(
    const float *current_y,    // Current frame Y channel (width×height)
    const float *reference_y,  // Reference frame Y channel
    int width, int height,
    int block_size,            // Block size (e.g., 16)
    int16_t *mvs_x,           // Output: motion vectors X (in 1/4-pixel units)
    int16_t *mvs_y            // Output: motion vectors Y (in 1/4-pixel units)
) {
    // Convert float Y channels to 8-bit grayscale for OpenCV
    cv::Mat cur_gray(height, width, CV_8UC1);
    cv::Mat ref_gray(height, width, CV_8UC1);

    // Detect if Y is in [0,1] range and scale to [0,255] if needed
    float y_min = current_y[0], y_max = current_y[0];
    for (int i = 1; i < width * height; i++) {
        if (current_y[i] < y_min) y_min = current_y[i];
        if (current_y[i] > y_max) y_max = current_y[i];
    }
    float scale = (y_max <= 1.1f) ? 255.0f : 1.0f;

    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            int idx = y * width + x;
            cur_gray.at<uint8_t>(y, x) = (uint8_t)std::round(std::max(0.0f, std::min(255.0f, current_y[idx] * scale)));
            ref_gray.at<uint8_t>(y, x) = (uint8_t)std::round(std::max(0.0f, std::min(255.0f, reference_y[idx] * scale)));
        }
    }

    // Compute dense optical flow using Farneback algorithm
    // IMPORTANT: We need BACKWARD flow (current → reference) for motion compensation
    // This tells us where to PULL pixels FROM in the reference frame
    cv::Mat flow;
    cv::calcOpticalFlowFarneback(
        cur_gray,      // Current frame (source)
        ref_gray,      // Reference frame (destination)
        flow,          // Output flow (2-channel float: dx, dy per pixel)
        0.5,           // pyr_scale: pyramid scale (0.5 = each layer is half size)
        3,             // levels: number of pyramid levels
        20,            // winsize: averaging window size
        3,             // iterations: number of iterations at each pyramid level
        5,             // poly_n: size of pixel neighborhood (5 or 7)
        1.2,           // poly_sigma: standard deviation of Gaussian for polynomial expansion
        0              // flags: 0 = normal, OPTFLOW_USE_INITIAL_FLOW = use input flow as initial estimate
    );

    // Sample flow at block centers to get motion vectors
    int num_blocks_x = (width + block_size - 1) / block_size;
    int num_blocks_y = (height + block_size - 1) / block_size;

    for (int by = 0; by < num_blocks_y; by++) {
        for (int bx = 0; bx < num_blocks_x; bx++) {
            int block_idx = by * num_blocks_x + bx;

            // Block center position
            int center_x = bx * block_size + block_size / 2;
            int center_y = by * block_size + block_size / 2;

            // Clamp to frame boundaries
            if (center_x >= width) center_x = width - 1;
            if (center_y >= height) center_y = height - 1;

            // Get flow at block center
            cv::Point2f flow_vec = flow.at<cv::Point2f>(center_y, center_x);

            // Convert to 1/4-pixel units and store
            // Flow is in pixels, positive = motion to the right/down
            mvs_x[block_idx] = (int16_t)std::round(flow_vec.x * 4.0f);
            mvs_y[block_idx] = (int16_t)std::round(flow_vec.y * 4.0f);
        }
    }
}

} // extern "C"
