// Test mesh warp round-trip consistency
// Warps a frame forward, then backward, and checks if we get the original back
// This is critical for MC-lifting invertibility

#include <opencv2/opencv.hpp>
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
}

// Mesh warp with bilinear interpolation (translation only)
static void apply_mesh_warp_rgb(
    const cv::Mat &src,
    cv::Mat &dst,
    const int16_t *mesh_dx,
    const int16_t *mesh_dy,
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

            cell_x = std::min(cell_x, mesh_w - 2);
            cell_y = std::min(cell_y, mesh_h - 2);

            int idx_00 = cell_y * mesh_w + cell_x;
            int idx_10 = idx_00 + 1;
            int idx_01 = (cell_y + 1) * mesh_w + cell_x;
            int idx_11 = idx_01 + 1;

            float cp_x0 = cell_x * cell_w + cell_w / 2.0f;
            float cp_y0 = cell_y * cell_h + cell_h / 2.0f;
            float cp_x1 = (cell_x + 1) * cell_w + cell_w / 2.0f;
            float cp_y1 = (cell_y + 1) * cell_h + cell_h / 2.0f;

            float alpha = (x - cp_x0) / (cp_x1 - cp_x0);
            float beta = (y - cp_y0) / (cp_y1 - cp_y0);
            alpha = std::max(0.0f, std::min(1.0f, alpha));
            beta = std::max(0.0f, std::min(1.0f, beta));

            float dx = (1 - alpha) * (1 - beta) * (mesh_dx[idx_00] / 8.0f) +
                       alpha * (1 - beta) * (mesh_dx[idx_10] / 8.0f) +
                       (1 - alpha) * beta * (mesh_dx[idx_01] / 8.0f) +
                       alpha * beta * (mesh_dx[idx_11] / 8.0f);

            float dy = (1 - alpha) * (1 - beta) * (mesh_dy[idx_00] / 8.0f) +
                       alpha * (1 - beta) * (mesh_dy[idx_10] / 8.0f) +
                       (1 - alpha) * beta * (mesh_dy[idx_01] / 8.0f) +
                       alpha * beta * (mesh_dy[idx_11] / 8.0f);

            float src_x = x + dx;
            float src_y = y + dy;

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

int main(int argc, char** argv) {
    const char* video_file = (argc > 1) ? argv[1] : "test_video.mp4";
    int num_tests = (argc > 2) ? atoi(argv[2]) : 5;

    printf("Opening video: %s\n", video_file);
    cv::VideoCapture cap(video_file);

    if (!cap.isOpened()) {
        fprintf(stderr, "Error: Cannot open video file\n");
        return 1;
    }

    int total_frames = (int)cap.get(cv::CAP_PROP_FRAME_COUNT);
    int width = (int)cap.get(cv::CAP_PROP_FRAME_WIDTH);
    int height = (int)cap.get(cv::CAP_PROP_FRAME_HEIGHT);

    printf("Video: %dx%d, %d frames\n", width, height, total_frames);

    // Mesh dimensions (32×32 cells)
    int mesh_cell_size = 32;
    int mesh_w = (width + mesh_cell_size - 1) / mesh_cell_size;
    int mesh_h = (height + mesh_cell_size - 1) / mesh_cell_size;
    if (mesh_w < 2) mesh_w = 2;
    if (mesh_h < 2) mesh_h = 2;

    printf("Mesh: %dx%d (approx %dx%d px cells)\n\n",
           mesh_w, mesh_h, width / mesh_w, height / mesh_h);

    float smoothness = 0.5f;
    int smooth_iterations = 8;

    srand(time(NULL));

    double total_forward_psnr = 0.0;
    double total_roundtrip_psnr = 0.0;
    double total_half_roundtrip_psnr = 0.0;

    for (int test = 0; test < num_tests; test++) {
        int frame_num = 5 + rand() % (total_frames - 10);

        printf("[Test %d/%d] Frame pair %d → %d\n", test + 1, num_tests, frame_num - 1, frame_num);

        cap.set(cv::CAP_PROP_POS_FRAMES, frame_num - 1);
        cv::Mat frame0, frame1;
        cap >> frame0;
        cap >> frame1;

        if (frame0.empty() || frame1.empty()) {
            fprintf(stderr, "Error reading frames\n");
            continue;
        }

        cv::Mat frame0_rgb, frame1_rgb;
        cv::cvtColor(frame0, frame0_rgb, cv::COLOR_BGR2RGB);
        cv::cvtColor(frame1, frame1_rgb, cv::COLOR_BGR2RGB);

        // Compute mesh (F0 → F1)
        float *flow_x = nullptr, *flow_y = nullptr;
        estimate_motion_optical_flow(frame0_rgb.data, frame1_rgb.data,
                                     width, height, &flow_x, &flow_y);

        int16_t *mesh_dx = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        int16_t *mesh_dy = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        build_mesh_from_flow(flow_x, flow_y, width, height, mesh_w, mesh_h, mesh_dx, mesh_dy);
        smooth_mesh_laplacian(mesh_dx, mesh_dy, mesh_w, mesh_h, smoothness, smooth_iterations);

        // Create inverted mesh
        int16_t *inv_mesh_dx = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        int16_t *inv_mesh_dy = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        for (int i = 0; i < mesh_w * mesh_h; i++) {
            inv_mesh_dx[i] = -mesh_dx[i];
            inv_mesh_dy[i] = -mesh_dy[i];
        }

        // Create half-mesh for symmetric lifting test
        int16_t *half_mesh_dx = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        int16_t *half_mesh_dy = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        int16_t *neg_half_mesh_dx = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        int16_t *neg_half_mesh_dy = (int16_t*)malloc(mesh_w * mesh_h * sizeof(int16_t));
        for (int i = 0; i < mesh_w * mesh_h; i++) {
            half_mesh_dx[i] = mesh_dx[i] / 2;
            half_mesh_dy[i] = mesh_dy[i] / 2;
            neg_half_mesh_dx[i] = -half_mesh_dx[i];
            neg_half_mesh_dy[i] = -half_mesh_dy[i];
        }

        // TEST 1: Full forward warp quality (F0 → F1)
        cv::Mat warped_forward;
        apply_mesh_warp_rgb(frame0, warped_forward, mesh_dx, mesh_dy, mesh_w, mesh_h);

        double forward_mse = 0.0;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                for (int c = 0; c < 3; c++) {
                    double diff = (double)warped_forward.at<cv::Vec3b>(y, x)[c] -
                                 (double)frame1.at<cv::Vec3b>(y, x)[c];
                    forward_mse += diff * diff;
                }
            }
        }
        forward_mse /= (width * height * 3);
        double forward_psnr = (forward_mse > 0) ? 10.0 * log10(255.0 * 255.0 / forward_mse) : 999.0;
        total_forward_psnr += forward_psnr;

        // TEST 2: Full round-trip (F0 → forward → backward → F0')
        cv::Mat roundtrip;
        apply_mesh_warp_rgb(warped_forward, roundtrip, inv_mesh_dx, inv_mesh_dy, mesh_w, mesh_h);

        double roundtrip_mse = 0.0;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                for (int c = 0; c < 3; c++) {
                    double diff = (double)roundtrip.at<cv::Vec3b>(y, x)[c] -
                                 (double)frame0.at<cv::Vec3b>(y, x)[c];
                    roundtrip_mse += diff * diff;
                }
            }
        }
        roundtrip_mse /= (width * height * 3);
        double roundtrip_psnr = (roundtrip_mse > 0) ? 10.0 * log10(255.0 * 255.0 / roundtrip_mse) : 999.0;
        total_roundtrip_psnr += roundtrip_psnr;

        // TEST 3: Half-step symmetric round-trip (MC-lifting style)
        // F0 → +½mesh, then → -½mesh (should return to F0)
        cv::Mat half_forward, half_roundtrip;
        apply_mesh_warp_rgb(frame0, half_forward, half_mesh_dx, half_mesh_dy, mesh_w, mesh_h);
        apply_mesh_warp_rgb(half_forward, half_roundtrip, neg_half_mesh_dx, neg_half_mesh_dy, mesh_w, mesh_h);

        double half_roundtrip_mse = 0.0;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                for (int c = 0; c < 3; c++) {
                    double diff = (double)half_roundtrip.at<cv::Vec3b>(y, x)[c] -
                                 (double)frame0.at<cv::Vec3b>(y, x)[c];
                    half_roundtrip_mse += diff * diff;
                }
            }
        }
        half_roundtrip_mse /= (width * height * 3);
        double half_roundtrip_psnr = (half_roundtrip_mse > 0) ? 10.0 * log10(255.0 * 255.0 / half_roundtrip_mse) : 999.0;
        total_half_roundtrip_psnr += half_roundtrip_psnr;

        printf("  Forward warp (F0→F1):       PSNR = %.2f dB\n", forward_psnr);
        printf("  Full round-trip (F0→F0'):   PSNR = %.2f dB\n", roundtrip_psnr);
        printf("  Half round-trip (±½mesh):   PSNR = %.2f dB\n", half_roundtrip_psnr);

        // Compute motion stats
        float avg_motion = 0.0f, max_motion = 0.0f;
        for (int i = 0; i < mesh_w * mesh_h; i++) {
            float dx = mesh_dx[i] / 8.0f;
            float dy = mesh_dy[i] / 8.0f;
            float motion = sqrtf(dx * dx + dy * dy);
            avg_motion += motion;
            if (motion > max_motion) max_motion = motion;
        }
        avg_motion /= (mesh_w * mesh_h);
        printf("  Motion: avg=%.2f px, max=%.2f px\n\n", avg_motion, max_motion);

        // Save visualization for worst case
        if (test == 0 || roundtrip_psnr < 30.0) {
            char filename[256];
            sprintf(filename, "roundtrip_%04d_original.png", frame_num);
            cv::imwrite(filename, frame0);
            sprintf(filename, "roundtrip_%04d_forward.png", frame_num);
            cv::imwrite(filename, warped_forward);
            sprintf(filename, "roundtrip_%04d_roundtrip.png", frame_num);
            cv::imwrite(filename, roundtrip);

            // Difference images
            cv::Mat diff_roundtrip = cv::Mat::zeros(height, width, CV_8UC3);
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    for (int c = 0; c < 3; c++) {
                        int diff = abs((int)roundtrip.at<cv::Vec3b>(y, x)[c] -
                                      (int)frame0.at<cv::Vec3b>(y, x)[c]);
                        diff_roundtrip.at<cv::Vec3b>(y, x)[c] = std::min(diff * 5, 255);
                    }
                }
            }
            sprintf(filename, "roundtrip_%04d_diff.png", frame_num);
            cv::imwrite(filename, diff_roundtrip);
            printf("  Saved visualization: roundtrip_%04d_*.png\n\n", frame_num);
        }

        free(flow_x);
        free(flow_y);
        free(mesh_dx);
        free(mesh_dy);
        free(inv_mesh_dx);
        free(inv_mesh_dy);
        free(half_mesh_dx);
        free(half_mesh_dy);
        free(neg_half_mesh_dx);
        free(neg_half_mesh_dy);
    }

    printf("===========================================\n");
    printf("Average Results (%d tests):\n", num_tests);
    printf("  Forward warp quality:       %.2f dB\n", total_forward_psnr / num_tests);
    printf("  Full round-trip error:      %.2f dB\n", total_roundtrip_psnr / num_tests);
    printf("  Half round-trip error:      %.2f dB\n", total_half_roundtrip_psnr / num_tests);
    printf("===========================================\n\n");

    if (total_roundtrip_psnr / num_tests < 35.0) {
        printf("WARNING: Round-trip PSNR < 35 dB indicates poor invertibility!\n");
        printf("This will cause MC-lifting to accumulate errors and hurt compression.\n");
        printf("Bilinear interpolation artifacts are likely the culprit.\n");
    } else {
        printf("Round-trip consistency looks acceptable (>35 dB).\n");
    }

    cap.release();
    return 0;
}
