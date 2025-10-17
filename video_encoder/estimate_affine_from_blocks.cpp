// Affine estimation for TAV mesh warping
// This file contains logic to estimate per-cell affine transforms from block motion

#include <cmath>
#include <cstdlib>
#include <cstring>

extern "C" {

// Estimate affine transform for a mesh cell from surrounding block motion vectors
// Uses least-squares fitting of motion vectors to affine model: [x'] = [a11 a12][x] + [tx]
//                                                                  [y']   [a21 a22][y]   [ty]
//
// Returns 1 if affine improves residual by >threshold, 0 if translation-only is better
int estimate_cell_affine(
    const float *flow_x, const float *flow_y,
    int width, int height,
    int cell_x, int cell_y,      // Cell position in mesh coordinates
    int cell_w, int cell_h,       // Cell size in pixels
    float threshold,              // Residual improvement threshold (e.g. 0.10 = 10%)
    short *out_tx, short *out_ty, // Translation (1/8 pixel)
    short *out_a11, short *out_a12, // Affine matrix (1/256 fixed-point)
    short *out_a21, short *out_a22
) {
    // Compute cell bounding box
    int x_start = cell_x * cell_w;
    int y_start = cell_y * cell_h;
    int x_end = (cell_x + 1) * cell_w;
    int y_end = (cell_y + 1) * cell_h;
    if (x_end > width) x_end = width;
    if (y_end > height) y_end = height;

    // Sample motion vectors from a 4×4 grid within the cell
    const int samples_x = 4;
    const int samples_y = 4;
    float sample_motion_x[16];
    float sample_motion_y[16];
    int sample_px[16];
    int sample_py[16];
    int n_samples = 0;

    for (int sy = 0; sy < samples_y; sy++) {
        for (int sx = 0; sx < samples_x; sx++) {
            int px = x_start + (x_end - x_start) * sx / (samples_x - 1);
            int py = y_start + (y_end - y_start) * sy / (samples_y - 1);

            if (px >= width) px = width - 1;
            if (py >= height) py = height - 1;

            int idx = py * width + px;
            sample_motion_x[n_samples] = flow_x[idx];
            sample_motion_y[n_samples] = flow_y[idx];
            sample_px[n_samples] = px - (x_start + x_end) / 2;  // Relative to cell center
            sample_py[n_samples] = py - (y_start + y_end) / 2;
            n_samples++;
        }
    }

    // 1. Compute translation-only model (average motion)
    float avg_dx = 0, avg_dy = 0;
    for (int i = 0; i < n_samples; i++) {
        avg_dx += sample_motion_x[i];
        avg_dy += sample_motion_y[i];
    }
    avg_dx /= n_samples;
    avg_dy /= n_samples;

    // Translation residual
    float trans_residual = 0;
    for (int i = 0; i < n_samples; i++) {
        float dx_err = sample_motion_x[i] - avg_dx;
        float dy_err = sample_motion_y[i] - avg_dy;
        trans_residual += dx_err * dx_err + dy_err * dy_err;
    }

    // 2. Estimate affine model using least-squares
    // Solve: [vx] = [a11 a12][px] + [tx]
    //        [vy]   [a21 a22][py]   [ty]
    // Using normal equations for 2×2 affine

    double sum_x = 0, sum_y = 0, sum_xx = 0, sum_yy = 0, sum_xy = 0;
    double sum_vx = 0, sum_vy = 0, sum_vx_x = 0, sum_vx_y = 0;
    double sum_vy_x = 0, sum_vy_y = 0;

    for (int i = 0; i < n_samples; i++) {
        double px = sample_px[i];
        double py = sample_py[i];
        double vx = sample_motion_x[i];
        double vy = sample_motion_y[i];

        sum_x += px;
        sum_y += py;
        sum_xx += px * px;
        sum_yy += py * py;
        sum_xy += px * py;
        sum_vx += vx;
        sum_vy += vy;
        sum_vx_x += vx * px;
        sum_vx_y += vx * py;
        sum_vy_x += vy * px;
        sum_vy_y += vy * py;
    }

    // Solve 2×2 system for [a11, a12, tx] and [a21, a22, ty]
    double n = n_samples;
    double det = n * sum_xx * sum_yy + 2 * sum_x * sum_y * sum_xy -
                 sum_xx * sum_y * sum_y - sum_yy * sum_x * sum_x - n * sum_xy * sum_xy;

    if (fabs(det) < 1e-6) {
        // Singular matrix, fall back to translation
        *out_tx = (short)(avg_dx * 8.0f);
        *out_ty = (short)(avg_dy * 8.0f);
        *out_a11 = 256;  // Identity
        *out_a12 = 0;
        *out_a21 = 0;
        *out_a22 = 256;
        return 0;  // Translation only
    }

    // Solve for affine parameters (simplified for readability)
    double a11 = (sum_vx_x * sum_yy * n - sum_vx_y * sum_xy * n - sum_vx * sum_y * sum_y +
                  sum_vx * sum_xy * sum_y + sum_vx_y * sum_x * sum_y - sum_vx_x * sum_y * sum_y) / det;
    double a12 = (sum_vx_y * sum_xx * n - sum_vx_x * sum_xy * n - sum_vx * sum_x * sum_xy +
                  sum_vx * sum_xx * sum_y + sum_vx_x * sum_x * sum_y - sum_vx_y * sum_x * sum_x) / det;
    double tx = (sum_vx - a11 * sum_x - a12 * sum_y) / n;

    double a21 = (sum_vy_x * sum_yy * n - sum_vy_y * sum_xy * n - sum_vy * sum_y * sum_y +
                  sum_vy * sum_xy * sum_y + sum_vy_y * sum_x * sum_y - sum_vy_x * sum_y * sum_y) / det;
    double a22 = (sum_vy_y * sum_xx * n - sum_vy_x * sum_xy * n - sum_vy * sum_x * sum_xy +
                  sum_vy * sum_xx * sum_y + sum_vy_x * sum_x * sum_y - sum_vy_y * sum_x * sum_x) / det;
    double ty = (sum_vy - a21 * sum_x - a22 * sum_y) / n;

    // Affine residual
    float affine_residual = 0;
    for (int i = 0; i < n_samples; i++) {
        double px = sample_px[i];
        double py = sample_py[i];
        double pred_vx = a11 * px + a12 * py + tx;
        double pred_vy = a21 * px + a22 * py + ty;
        double dx_err = sample_motion_x[i] - pred_vx;
        double dy_err = sample_motion_y[i] - pred_vy;
        affine_residual += dx_err * dx_err + dy_err * dy_err;
    }

    // Decision: Use affine if residual improves by > threshold
    float improvement = (trans_residual - affine_residual) / (trans_residual + 1e-6f);

    if (improvement > threshold) {
        // Use affine
        *out_tx = (short)(tx * 8.0f);
        *out_ty = (short)(ty * 8.0f);
        *out_a11 = (short)(a11 * 256.0);
        *out_a12 = (short)(a12 * 256.0);
        *out_a21 = (short)(a21 * 256.0);
        *out_a22 = (short)(a22 * 256.0);
        return 1;  // Affine
    } else {
        // Use translation
        *out_tx = (short)(avg_dx * 8.0f);
        *out_ty = (short)(avg_dy * 8.0f);
        *out_a11 = 256;  // Identity
        *out_a12 = 0;
        *out_a21 = 0;
        *out_a22 = 256;
        return 0;  // Translation only
    }
}

} // extern "C"
