// Visual unit test for mesh warping with hierarchical block matching and affine estimation
// Picks 5 random frames from test_video.mp4, warps prev frame to current frame using mesh,
// and saves both warped and target frames for visual comparison
// Now includes: hierarchical diamond search, Laplacian smoothing, and selective affine transforms

#include <opencv2/opencv.hpp>
#include <opencv2/video/tracking.hpp>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <cstdio>
#include <ctime>

// Include the mesh functions from encoder
extern "C" {
    void estimate_motion_optical_flow(
        const unsigned char *frame1_rgb, const unsigned char *frame2_rgb,
        int width, int height,
        float **out_flow_x, float **out_flow_y
    );

    void build_mesh_from_flow(
        const float *flow_x, const float *flow_y,
        int width, int height,
        int mesh_w, int mesh_h,
        int16_t *mesh_dx, int16_t *mesh_dy
    );

    void smooth_mesh_laplacian(
        int16_t *mesh_dx, int16_t *mesh_dy,
        int mesh_width, int mesh_height,
        float smoothness, int iterations
    );

    int estimate_cell_affine(
        const float *flow_x, const float *flow_y,
        int width, int height,
        int cell_x, int cell_y,
        int cell_w, int cell_h,
        float threshold,
        int16_t *out_tx, int16_t *out_ty,
        int16_t *out_a11, int16_t *out_a12,
        int16_t *out_a21, int16_t *out_a22
    );
}

// Mesh warp with bilinear interpolation and optional affine support
static void apply_mesh_warp_rgb(
    const cv::Mat &src,          // Input BGR image
    cv::Mat &dst,                 // Output warped BGR image
    const int16_t *mesh_dx,       // Mesh motion vectors (1/8 pixel)
    const int16_t *mesh_dy,
    const uint8_t *affine_mask,   // 1=affine, 0=translation
    const int16_t *affine_a11,
    const int16_t *affine_a12,
    const int16_t *affine_a21,
    const int16_t *affine_a22,
    int mesh_w, int mesh_h
) {
    int width = src.cols;
    int height = src.rows;
    int cell_w = width / mesh_w;
    int cell_h = height / mesh_h;

    dst = cv::Mat(height, width, CV_8UC3);

    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            int cell_x = x / cell_w;
            int cell_y = y / cell_h;

            // Clamp to valid mesh range
            cell_x = std::min(cell_x, mesh_w - 2);
            cell_y = std::min(cell_y, mesh_h - 2);

            // Four corner control points
            int idx_00 = cell_y * mesh_w + cell_x;
            int idx_10 = idx_00 + 1;
            int idx_01 = (cell_y + 1) * mesh_w + cell_x;
            int idx_11 = idx_01 + 1;

            // Control point positions
            float cp_x0 = cell_x * cell_w + cell_w / 2.0f;
            float cp_y0 = cell_y * cell_h + cell_h / 2.0f;
            float cp_x1 = (cell_x + 1) * cell_w + cell_w / 2.0f;
            float cp_y1 = (cell_y + 1) * cell_h + cell_h / 2.0f;

            // Local coordinates
            float alpha = (x - cp_x0) / (cp_x1 - cp_x0);
            float beta = (y - cp_y0) / (cp_y1 - cp_y0);
            alpha = std::max(0.0f, std::min(1.0f, alpha));
            beta = std::max(0.0f, std::min(1.0f, beta));

            // Bilinear interpolation of motion vectors
            float dx = (1 - alpha) * (1 - beta) * (mesh_dx[idx_00] / 8.0f) +
                       alpha * (1 - beta) * (mesh_dx[idx_10] / 8.0f) +
                       (1 - alpha) * beta * (mesh_dx[idx_01] / 8.0f) +
                       alpha * beta * (mesh_dx[idx_11] / 8.0f);

            float dy = (1 - alpha) * (1 - beta) * (mesh_dy[idx_00] / 8.0f) +
                       alpha * (1 - beta) * (mesh_dy[idx_10] / 8.0f) +
                       (1 - alpha) * beta * (mesh_dy[idx_01] / 8.0f) +
                       alpha * beta * (mesh_dy[idx_11] / 8.0f);

            // Check if we're using affine in this cell
            // For simplicity, just use the top-left corner's affine parameters
            int cell_idx = cell_y * mesh_w + cell_x;
            if (affine_mask && affine_mask[cell_idx]) {
                // Apply affine transform
                // Compute position relative to cell center
                float rel_x = x - (cell_x * cell_w + cell_w / 2.0f);
                float rel_y = y - (cell_y * cell_h + cell_h / 2.0f);

                float a11 = affine_a11[cell_idx] / 256.0f;
                float a12 = affine_a12[cell_idx] / 256.0f;
                float a21 = affine_a21[cell_idx] / 256.0f;
                float a22 = affine_a22[cell_idx] / 256.0f;

                // Affine warp: [x'] = [a11 a12][x] + [dx]
                //               [y']   [a21 a22][y]   [dy]
                dx = a11 * rel_x + a12 * rel_y + dx;
                dy = a21 * rel_x + a22 * rel_y + dy;
            }

            // Source coordinates (inverse warp)
            float src_x = x + dx;
            float src_y = y + dy;

            // Bilinear interpolation
            int sx0 = (int)floorf(src_x);
            int sy0 = (int)floorf(src_y);
            int sx1 = sx0 + 1;
            int sy1 = sy0 + 1;

            sx0 = std::max(0, std::min(width - 1, sx0));
            sy0 = std::max(0, std::min(height - 1, sy0));
            sx1 = std::max(0, std::min(width - 1, sx1));
            sy1 = std::max(0, std::min(height - 1, sy1));

            float fx = src_x - sx0;
            float fy = src_y - sy0;

            // Interpolate each channel
            for (int c = 0; c < 3; c++) {
                float val_00 = src.at<cv::Vec3b>(sy0, sx0)[c];
                float val_10 = src.at<cv::Vec3b>(sy0, sx1)[c];
                float val_01 = src.at<cv::Vec3b>(sy1, sx0)[c];
                float val_11 = src.at<cv::Vec3b>(sy1, sx1)[c];

                float val = (1 - fx) * (1 - fy) * val_00 +
                            fx * (1 - fy) * val_10 +
                            (1 - fx) * fy * val_01 +
                            fx * fy * val_11;

                dst.at<cv::Vec3b>(y, x)[c] = (unsigned char)std::max(0.0f, std::min(255.0f, val));
            }
        }
    }
}

// Create visualization overlay showing affine cells
static void create_affine_overlay(
    cv::Mat &img,
    const uint8_t *affine_mask,
    int mesh_w, int mesh_h
) {
    int width = img.cols;
    int height = img.rows;
    int cell_w = width / mesh_w;
    int cell_h = height / mesh_h;

    for (int my = 0; my < mesh_h; my++) {
        for (int mx = 0; mx < mesh_w; mx++) {
            int idx = my * mesh_w + mx;

            if (affine_mask[idx]) {
                // Draw green rectangle for affine cells
                int x0 = mx * cell_w;
                int y0 = my * cell_h;
                int x1 = (mx + 1) * cell_w;
                int y1 = (my + 1) * cell_h;

                cv::rectangle(img,
                             cv::Point(x0, y0),
                             cv::Point(x1, y1),
                             cv::Scalar(0, 255, 0), 1);
            }
        }
    }
}

int main(int argc, char** argv) {
    const char* video_file = (argc > 1) ? argv[1] : "test_video.mp4";
    int num_test_frames = (argc > 2) ? atoi(argv[2]) : 5;

    printf("Opening video: %s\n", video_file);
    cv::VideoCapture cap(video_file);

    if (!cap.isOpened()) {
        fprintf(stderr, "Error: Cannot open video file %s\n", video_file);
        return 1;
    }

    int total_frames = (int)cap.get(cv::CAP_PROP_FRAME_COUNT);
    int width = (int)cap.get(cv::CAP_PROP_FRAME_WIDTH);
    int height = (int)cap.get(cv::CAP_PROP_FRAME_HEIGHT);

    printf("Video: %dx%d, %d frames\n", width, height, total_frames);

    if (total_frames < 10) {
        fprintf(stderr, "Error: Video too short (need at least 10 frames)\n");
        return 1;
    }

    // Calculate mesh dimensions (32×32 pixel cells, matches current encoder)
    int mesh_cell_size = 32;
    int mesh_w = (width + mesh_cell_size - 1) / mesh_cell_size;
    int mesh_h = (height + mesh_cell_size - 1) / mesh_cell_size;
    if (mesh_w < 2) mesh_w = 2;
    if (mesh_h < 2) mesh_h = 2;

    printf("Mesh: %dx%d (approx %dx%d px cells)\n",
           mesh_w, mesh_h, width / mesh_w, height / mesh_h);

    // Encoder parameters (match current encoder_tav.c settings)
    float smoothness = 0.5f;      // Mesh smoothness weight
    int smooth_iterations = 8;     // Smoothing iterations
    float affine_threshold = 0.40f; // 40% improvement required for affine

    printf("Settings: smoothness=%.2f, iterations=%d, affine_threshold=%.0f%%\n",
           smoothness, smooth_iterations, affine_threshold * 100.0f);

    // Seed random number generator
    srand(time(NULL));

    // Pick random frames (avoid first and last 5 frames)
    printf("\nTesting %d random frame pairs:\n", num_test_frames);
    for (int test = 0; test < num_test_frames; test++) {
        // Pick random frame (ensure we have a previous frame)
        int frame_num = 5 + rand() % (total_frames - 10);

        printf("\n[Test %d/%d] Warping frame %d → frame %d (inverse warp)\n",
               test + 1, num_test_frames, frame_num - 1, frame_num);

        // Read previous frame (source for warping)
        cap.set(cv::CAP_PROP_POS_FRAMES, frame_num - 1);

        cv::Mat prev_frame;
        cap >> prev_frame;
        if (prev_frame.empty()) {
            fprintf(stderr, "Error reading frame %d\n", frame_num - 1);
            continue;
        }

        // Read current frame (target to match)
        cv::Mat curr_frame;
        cap >> curr_frame;
        if (curr_frame.empty()) {
            fprintf(stderr, "Error reading frame %d\n", frame_num);
            continue;
        }

        // Convert to RGB for block matching
        cv::Mat prev_rgb, curr_rgb;
        cv::cvtColor(prev_frame, prev_rgb, cv::COLOR_BGR2RGB);
        cv::cvtColor(curr_frame, curr_rgb, cv::COLOR_BGR2RGB);

        // Compute hierarchical block matching (replaces optical flow)
        printf("  Computing hierarchical block matching...\n");
        float *flow_x = nullptr, *flow_y = nullptr;
        estimate_motion_optical_flow(
            prev_rgb.data, curr_rgb.data,
            width, height,
            &flow_x, &flow_y
        );

        // Build mesh from flow
        printf("  Building mesh from block matches...\n");
        int16_t *mesh_dx = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        int16_t *mesh_dy = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        build_mesh_from_flow(flow_x, flow_y, width, height, mesh_w, mesh_h, mesh_dx, mesh_dy);

        // Apply Laplacian smoothing
        printf("  Applying Laplacian smoothing (%d iterations, %.2f weight)...\n",
               smooth_iterations, smoothness);
        smooth_mesh_laplacian(mesh_dx, mesh_dy, mesh_w, mesh_h, smoothness, smooth_iterations);

        // Estimate selective per-cell affine transforms
        printf("  Estimating selective affine transforms (threshold=%.0f%%)...\n",
               affine_threshold * 100.0f);
        uint8_t *affine_mask = (uint8_t*)calloc(mesh_w * mesh_h, sizeof(uint8_t));
        int16_t *affine_a11 = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        int16_t *affine_a12 = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        int16_t *affine_a21 = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        int16_t *affine_a22 = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));

        int cell_w = width / mesh_w;
        int cell_h = height / mesh_h;
        int affine_count = 0;

        for (int cy = 0; cy < mesh_h; cy++) {
            for (int cx = 0; cx < mesh_w; cx++) {
                int cell_idx = cy * mesh_w + cx;

                int16_t tx, ty, a11, a12, a21, a22;
                int use_affine = estimate_cell_affine(
                    flow_x, flow_y,
                    width, height,
                    cx, cy, cell_w, cell_h,
                    affine_threshold,
                    &tx, &ty, &a11, &a12, &a21, &a22
                );

                affine_mask[cell_idx] = use_affine ? 1 : 0;
                mesh_dx[cell_idx] = tx;
                mesh_dy[cell_idx] = ty;
                affine_a11[cell_idx] = a11;
                affine_a12[cell_idx] = a12;
                affine_a21[cell_idx] = a21;
                affine_a22[cell_idx] = a22;

                if (use_affine) affine_count++;
            }
        }

        printf("  Affine usage: %d/%d cells (%.1f%%)\n",
               affine_count, mesh_w * mesh_h,
               100.0f * affine_count / (mesh_w * mesh_h));

        // Warp previous frame to current frame
        printf("  Warping frame with mesh + affine...\n");
        cv::Mat warped;
        apply_mesh_warp_rgb(prev_frame, warped, mesh_dx, mesh_dy,
                           affine_mask, affine_a11, affine_a12, affine_a21, affine_a22,
                           mesh_w, mesh_h);

        // Create visualization with affine overlay
        cv::Mat warped_viz = warped.clone();
        create_affine_overlay(warped_viz, affine_mask, mesh_w, mesh_h);

        // Compute MSE between warped and target
        double mse = 0.0;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                for (int c = 0; c < 3; c++) {
                    double diff = (double)warped.at<cv::Vec3b>(y, x)[c] -
                                 (double)curr_frame.at<cv::Vec3b>(y, x)[c];
                    mse += diff * diff;
                }
            }
        }
        mse /= (width * height * 3);
        double psnr = (mse > 0) ? 10.0 * log10(255.0 * 255.0 / mse) : 999.0;
        printf("  Warp quality: MSE=%.2f, PSNR=%.2f dB\n", mse, psnr);

        // Save images
        char filename[256];
        sprintf(filename, "test_mesh_frame_%04d_source.png", frame_num - 1);
        cv::imwrite(filename, prev_frame);
        printf("  Saved source: %s\n", filename);

        sprintf(filename, "test_mesh_frame_%04d_warped.png", frame_num);
        cv::imwrite(filename, warped);
        printf("  Saved warped: %s\n", filename);

        sprintf(filename, "test_mesh_frame_%04d_warped_viz.png", frame_num);
        cv::imwrite(filename, warped_viz);
        printf("  Saved warped+viz (green=affine): %s\n", filename);

        sprintf(filename, "test_mesh_frame_%04d_target.png", frame_num);
        cv::imwrite(filename, curr_frame);
        printf("  Saved target: %s\n", filename);

        // Compute difference image
        cv::Mat diff_img = cv::Mat::zeros(height, width, CV_8UC3);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                for (int c = 0; c < 3; c++) {
                    int diff = abs((int)warped.at<cv::Vec3b>(y, x)[c] -
                                  (int)curr_frame.at<cv::Vec3b>(y, x)[c]);
                    diff_img.at<cv::Vec3b>(y, x)[c] = std::min(diff * 3, 255); // Amplify for visibility
                }
            }
        }
        sprintf(filename, "test_mesh_frame_%04d_diff.png", frame_num);
        cv::imwrite(filename, diff_img);
        printf("  Saved difference (amplified 3x): %s\n", filename);

        // Compute motion statistics
        float max_motion = 0.0f, avg_motion = 0.0f;
        for (int i = 0; i < mesh_w * mesh_h; i++) {
            float dx = mesh_dx[i] / 8.0f;
            float dy = mesh_dy[i] / 8.0f;
            float motion = sqrtf(dx * dx + dy * dy);
            avg_motion += motion;
            if (motion > max_motion) max_motion = motion;
        }
        avg_motion /= (mesh_w * mesh_h);
        printf("  Motion: avg=%.2f px, max=%.2f px\n", avg_motion, max_motion);

        // Cleanup
        free(flow_x);
        free(flow_y);
        free(mesh_dx);
        free(mesh_dy);
        free(affine_mask);
        free(affine_a11);
        free(affine_a12);
        free(affine_a21);
        free(affine_a22);
    }

    printf("\nDone! Check output images:\n");
    printf("  *_source.png: Original frame before warping\n");
    printf("  *_warped.png: Warped frame (should match target)\n");
    printf("  *_warped_viz.png: Warped with green overlay showing affine cells\n");
    printf("  *_target.png: Target frame to match\n");
    printf("  *_diff.png: Difference image (should be mostly black if warp is good)\n");

    cap.release();
    return 0;
}
