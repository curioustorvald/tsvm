// Created by Claude on 2025-10-17
// MPEG-style bidirectional block motion compensation for TAV encoder
// Simplified: Single-level diamond search, variable blocks, overlaps, sub-pixel refinement

#include <opencv2/opencv.hpp>
#include <cstdlib>
#include <cstring>
#include <cmath>

extern "C" {

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

// Block-based motion compensation with bilinear interpolation (sub-pixel precision)
// MVs are in 1/4-pixel units
// This implements the warp() function from MC-EZBC pseudocode
void warp_block_motion(
    const float *src,          // Source frame
    int width, int height,
    const int16_t *mvs_x,      // Motion vectors X (1/4-pixel units)
    const int16_t *mvs_y,      // Motion vectors Y (1/4-pixel units)
    int block_size,            // Block size (e.g., 16)
    float *dst                 // Output warped frame
) {
    int num_blocks_x = (width + block_size - 1) / block_size;
    int num_blocks_y = (height + block_size - 1) / block_size;

    // Process each block
    for (int by = 0; by < num_blocks_y; by++) {
        for (int bx = 0; bx < num_blocks_x; bx++) {
            int block_idx = by * num_blocks_x + bx;

            // Get motion vector for this block (in 1/4-pixel units)
            float mv_x = mvs_x[block_idx] / 4.0f;  // Convert to pixels
            float mv_y = mvs_y[block_idx] / 4.0f;

            // Block boundaries in destination frame
            int block_x_start = bx * block_size;
            int block_y_start = by * block_size;
            int block_x_end = std::min(block_x_start + block_size, width);
            int block_y_end = std::min(block_y_start + block_size, height);

            // Warp each pixel in the block
            for (int y = block_y_start; y < block_y_end; y++) {
                for (int x = block_x_start; x < block_x_end; x++) {
                    // Source position (backward warping)
                    float src_x = x - mv_x;
                    float src_y = y - mv_y;

                    // Clamp to valid range
                    src_x = std::max(0.0f, std::min((float)(width - 1), src_x));
                    src_y = std::max(0.0f, std::min((float)(height - 1), src_y));

                    // Bilinear interpolation
                    int x0 = (int)src_x;
                    int y0 = (int)src_y;
                    int x1 = std::min(x0 + 1, width - 1);
                    int y1 = std::min(y0 + 1, height - 1);

                    float fx = src_x - x0;
                    float fy = src_y - y0;

                    float val00 = src[y0 * width + x0];
                    float val10 = src[y0 * width + x1];
                    float val01 = src[y1 * width + x0];
                    float val11 = src[y1 * width + x1];

                    float val_top = (1.0f - fx) * val00 + fx * val10;
                    float val_bot = (1.0f - fx) * val01 + fx * val11;
                    float val = (1.0f - fy) * val_top + fy * val_bot;

                    dst[y * width + x] = val;
                }
            }
        }
    }
}

// Bidirectional motion compensation for MC-EZBC predict step
// Implements: prediction = 0.5 * (warp(f0, MV_fwd) + warp(f1, MV_bwd))
void warp_bidirectional(
    const float *f0, const float *f1,
    int width, int height,
    const int16_t *mvs_fwd_x, const int16_t *mvs_fwd_y,  // F0 → F1
    const int16_t *mvs_bwd_x, const int16_t *mvs_bwd_y,  // F1 → F0
    int block_size,
    float *prediction          // Output: 0.5 * (warped_f0 + warped_f1)
) {
    int num_pixels = width * height;

    // Allocate temporary buffers
    float *warped_f0 = new float[num_pixels];
    float *warped_f1 = new float[num_pixels];

    // Warp f0 forward using forward MVs
    warp_block_motion(f0, width, height, mvs_fwd_x, mvs_fwd_y, block_size, warped_f0);

    // Warp f1 backward using backward MVs
    warp_block_motion(f1, width, height, mvs_bwd_x, mvs_bwd_y, block_size, warped_f1);

    // Average the two warped frames
    for (int i = 0; i < num_pixels; i++) {
        prediction[i] = 0.5f * (warped_f0[i] + warped_f1[i]);
    }

    delete[] warped_f0;
    delete[] warped_f1;
}

} // extern "C"
