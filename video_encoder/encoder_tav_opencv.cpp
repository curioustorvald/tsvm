// Created by Claude on 2025-10-17
// OpenCV-based optical flow and mesh warping functions for TAV encoder
// This file is compiled separately as C++ and linked with the C encoder

#include <opencv2/opencv.hpp>
#include <opencv2/video/tracking.hpp>
#include <cstdlib>
#include <cstring>
#include <cmath>

// Extern "C" linkage for functions callable from C code
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

// Helper: Diamond search pattern for motion estimation
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

            // Check search range bounds
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

// Hierarchical block matching motion estimation with deeper pyramid
// 3-level hierarchy to handle large motion (up to ±32px)
void estimate_motion_optical_flow(
    const unsigned char *frame1_rgb, const unsigned char *frame2_rgb,
    int width, int height,
    float **out_flow_x, float **out_flow_y
) {
    // Step 1: Convert RGB to grayscale
    unsigned char *gray1 = (unsigned char*)std::malloc(width * height);
    unsigned char *gray2 = (unsigned char*)std::malloc(width * height);

    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            int idx = y * width + x;
            int rgb_idx = idx * 3;

            // ITU-R BT.601 grayscale conversion
            gray1[idx] = (unsigned char)(0.299f * frame1_rgb[rgb_idx] +
                                         0.587f * frame1_rgb[rgb_idx + 1] +
                                         0.114f * frame1_rgb[rgb_idx + 2]);
            gray2[idx] = (unsigned char)(0.299f * frame2_rgb[rgb_idx] +
                                         0.587f * frame2_rgb[rgb_idx + 1] +
                                         0.114f * frame2_rgb[rgb_idx + 2]);
        }
    }

    // Step 2: 3-level hierarchical block matching (coarse to fine)
    // Level 0: 64×64 blocks, ±32 pixel search (captures large motion up to 32px)
    // Level 1: 32×32 blocks, ±16 pixel refinement
    // Level 2: 16×16 blocks, ±8 pixel final refinement

    *out_flow_x = (float*)std::malloc(width * height * sizeof(float));
    *out_flow_y = (float*)std::malloc(width * height * sizeof(float));

    // Initialize with zero motion
    std::memset(*out_flow_x, 0, width * height * sizeof(float));
    std::memset(*out_flow_y, 0, width * height * sizeof(float));

    // Level 0: Coarsest search (64×64 blocks, ±32px)
    const int block_size_l0 = 32;
    const int search_range_l0 = 16;

    for (int by = 0; by < height; by += block_size_l0) {
        for (int bx = 0; bx < width; bx += block_size_l0) {
            int dx = 0, dy = 0;
            diamond_search(gray1, gray2, bx, by, width, height,
                          block_size_l0, search_range_l0, &dx, &dy);

            // Fill flow for this block
            for (int y = by; y < by + block_size_l0 && y < height; y++) {
                for (int x = bx; x < bx + block_size_l0 && x < width; x++) {
                    int idx = y * width + x;
                    (*out_flow_x)[idx] = (float)dx;
                    (*out_flow_y)[idx] = (float)dy;
                }
            }
        }
    }

    // Level 1: Medium refinement (32×32 blocks, ±16px)
    const int block_size_l1 = 16;
    const int search_range_l1 = 8;

    for (int by = 0; by < height; by += block_size_l1) {
        for (int bx = 0; bx < width; bx += block_size_l1) {
            // Get initial guess from level 0
            int init_dx = (int)(*out_flow_x)[by * width + bx];
            int init_dy = (int)(*out_flow_y)[by * width + bx];

            // Search around initial guess
            int best_dx = init_dx;
            int best_dy = init_dy;
            int best_sad = compute_sad(gray1, gray2, bx + init_dx, by + init_dy,
                                      bx, by, width, height, block_size_l1);

            // Local search around initial guess
            for (int dy = -search_range_l1; dy <= search_range_l1; dy += 2) {
                for (int dx = -search_range_l1; dx <= search_range_l1; dx += 2) {
                    int test_dx = init_dx + dx;
                    int test_dy = init_dy + dy;

                    int sad = compute_sad(gray1, gray2, bx + test_dx, by + test_dy,
                                        bx, by, width, height, block_size_l1);
                    if (sad < best_sad) {
                        best_sad = sad;
                        best_dx = test_dx;
                        best_dy = test_dy;
                    }
                }
            }

            // Fill flow for this block
            for (int y = by; y < by + block_size_l1 && y < height; y++) {
                for (int x = bx; x < bx + block_size_l1 && x < width; x++) {
                    int idx = y * width + x;
                    (*out_flow_x)[idx] = (float)best_dx;
                    (*out_flow_y)[idx] = (float)best_dy;
                }
            }
        }
    }

    // Level 2: Finest refinement (16×16 blocks, ±8px)
    /*const int block_size_l2 = 16;
    const int search_range_l2 = 8;

    for (int by = 0; by < height; by += block_size_l2) {
        for (int bx = 0; bx < width; bx += block_size_l2) {
            // Get initial guess from level 1
            int init_dx = (int)(*out_flow_x)[by * width + bx];
            int init_dy = (int)(*out_flow_y)[by * width + bx];

            // Search around initial guess (finer grid)
            int best_dx = init_dx;
            int best_dy = init_dy;
            int best_sad = compute_sad(gray1, gray2, bx + init_dx, by + init_dy,
                                      bx, by, width, height, block_size_l2);

            // Exhaustive local search for final refinement
            for (int dy = -search_range_l2; dy <= search_range_l2; dy++) {
                for (int dx = -search_range_l2; dx <= search_range_l2; dx++) {
                    int test_dx = init_dx + dx;
                    int test_dy = init_dy + dy;

                    int sad = compute_sad(gray1, gray2, bx + test_dx, by + test_dy,
                                        bx, by, width, height, block_size_l2);
                    if (sad < best_sad) {
                        best_sad = sad;
                        best_dx = test_dx;
                        best_dy = test_dy;
                    }
                }
            }

            // Fill flow for this block
            for (int y = by; y < by + block_size_l2 && y < height; y++) {
                for (int x = bx; x < bx + block_size_l2 && x < width; x++) {
                    int idx = y * width + x;
                    (*out_flow_x)[idx] = (float)best_dx;
                    (*out_flow_y)[idx] = (float)best_dy;
                }
            }
        }
    }*/

    std::free(gray1);
    std::free(gray2);
}

// Build distortion mesh from dense optical flow field
// Downsamples flow to coarse mesh grid using robust averaging
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
            // Cell center coordinates (control point position)
            int cx = mx * cell_w + cell_w / 2;
            int cy = my * cell_h + cell_h / 2;

            // Collect flow vectors in a neighborhood around cell center (5×5 window)
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

            // Average and convert to 1/8 pixel precision
            float avg_dx = (count > 0) ? (sum_dx / count) : 0.0f;
            float avg_dy = (count > 0) ? (sum_dy / count) : 0.0f;

            int mesh_idx = my * mesh_w + mx;
            mesh_dx[mesh_idx] = (short)(avg_dx * 8.0f);  // 1/8 pixel precision
            mesh_dy[mesh_idx] = (short)(avg_dy * 8.0f);
        }
    }
}

// Apply Laplacian smoothing to mesh for spatial coherence
// This prevents fold-overs and reduces high-frequency noise
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

                // Collect neighbor displacements
                float neighbor_dx = 0.0f, neighbor_dy = 0.0f;
                int neighbor_count = 0;

                // 4-connected neighbors (up, down, left, right)
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

                    // Weighted average: data term + smoothness term
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

// Apply bilinear mesh warp to a frame channel
// Uses inverse mapping (destination → source) to avoid holes
void warp_frame_with_mesh(
    const float *src_frame, int width, int height,
    const short *mesh_dx, const short *mesh_dy,
    int mesh_width, int mesh_height,
    float *dst_frame
) {
    int cell_w = width / mesh_width;
    int cell_h = height / mesh_height;

    // For each output pixel, compute source location using mesh warp
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            // Find which mesh cell this pixel belongs to
            int cell_x = x / cell_w;
            int cell_y = y / cell_h;

            // Clamp to valid mesh range
            if (cell_x >= mesh_width - 1) cell_x = mesh_width - 2;
            if (cell_y >= mesh_height - 1) cell_y = mesh_height - 2;
            if (cell_x < 0) cell_x = 0;
            if (cell_y < 0) cell_y = 0;

            // Get four corner control points
            int idx_00 = cell_y * mesh_width + cell_x;
            int idx_10 = idx_00 + 1;
            int idx_01 = (cell_y + 1) * mesh_width + cell_x;
            int idx_11 = idx_01 + 1;

            // Control point positions (cell centers)
            float cp_x0 = cell_x * cell_w + cell_w / 2.0f;
            float cp_y0 = cell_y * cell_h + cell_h / 2.0f;
            float cp_x1 = (cell_x + 1) * cell_w + cell_w / 2.0f;
            float cp_y1 = (cell_y + 1) * cell_h + cell_h / 2.0f;

            // Local coordinates within cell (0 to 1)
            float alpha = (x - cp_x0) / (cp_x1 - cp_x0);
            float beta = (y - cp_y0) / (cp_y1 - cp_y0);
            if (alpha < 0.0f) alpha = 0.0f;
            if (alpha > 1.0f) alpha = 1.0f;
            if (beta < 0.0f) beta = 0.0f;
            if (beta > 1.0f) beta = 1.0f;

            // Bilinear interpolation of motion vectors
            float dx_00 = mesh_dx[idx_00] / 8.0f;  // Convert to pixels
            float dy_00 = mesh_dy[idx_00] / 8.0f;
            float dx_10 = mesh_dx[idx_10] / 8.0f;
            float dy_10 = mesh_dy[idx_10] / 8.0f;
            float dx_01 = mesh_dx[idx_01] / 8.0f;
            float dy_01 = mesh_dy[idx_01] / 8.0f;
            float dx_11 = mesh_dx[idx_11] / 8.0f;
            float dy_11 = mesh_dy[idx_11] / 8.0f;

            float dx = (1 - alpha) * (1 - beta) * dx_00 +
                       alpha * (1 - beta) * dx_10 +
                       (1 - alpha) * beta * dx_01 +
                       alpha * beta * dx_11;

            float dy = (1 - alpha) * (1 - beta) * dy_00 +
                       alpha * (1 - beta) * dy_10 +
                       (1 - alpha) * beta * dy_01 +
                       alpha * beta * dy_11;

            // Source coordinates (inverse warp: dst → src)
            float src_x = x + dx;
            float src_y = y + dy;

            // Bilinear interpolation of source pixel
            int sx0 = (int)std::floor(src_x);
            int sy0 = (int)std::floor(src_y);
            int sx1 = sx0 + 1;
            int sy1 = sy0 + 1;

            // Clamp to frame bounds
            if (sx0 < 0) sx0 = 0;
            if (sy0 < 0) sy0 = 0;
            if (sx1 >= width) sx1 = width - 1;
            if (sy1 >= height) sy1 = height - 1;
            if (sx0 >= width) sx0 = width - 1;
            if (sy0 >= height) sy0 = height - 1;

            float fx = src_x - sx0;
            float fy = src_y - sy0;

            // Bilinear interpolation
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

} // extern "C"
