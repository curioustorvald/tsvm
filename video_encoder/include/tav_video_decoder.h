// Created by CuriousTorvald and Claude on 2025-12-02.
// TAV Video Decoder Library - Shared decoding functions for TAV format
// Can be used by both regular TAV decoder and TAV-DT decoder

#ifndef TAV_VIDEO_DECODER_H
#define TAV_VIDEO_DECODER_H

#include <stdint.h>
#include <stddef.h>

// Video decoder context - opaque to users
typedef struct tav_video_context tav_video_context_t;

// Video parameters structure
typedef struct {
    int width;
    int height;
    int decomp_levels;        // Spatial DWT levels (typically 4)
    int temporal_levels;      // Temporal DWT levels (typically 2)
    int wavelet_filter;       // 0=CDF 5/3, 1=CDF 9/7, 2=CDF 13/7, 16=DD-4, 255=Haar
    int temporal_wavelet;     // Temporal wavelet (0=CDF 5/3, 1=CDF 9/7)
    int entropy_coder;        // 0=Twobitmap, 1=EZBC, 2=RAW
    int channel_layout;       // 0=YCoCg-R, 1=ICtCp
    int perceptual_tuning;    // 1=perceptual quantisation, 0=uniform
    uint8_t quantiser_y;      // Base quantiser index for Y/I
    uint8_t quantiser_co;     // Base quantiser index for Co/Ct
    uint8_t quantiser_cg;     // Base quantiser index for Cg/Cp
    uint8_t encoder_preset;   // Encoder preset flags (sports, anime, etc.)
    int monoblock;            // 1=single tile (monoblock), 0=multi-tile
    int no_zstd;              // 1=packets are uncompressed (Video Flags bit 4), 0=Zstd compressed
} tav_video_params_t;

// Create video decoder context
// Returns NULL on failure
tav_video_context_t *tav_video_create(const tav_video_params_t *params);

// Free video decoder context
void tav_video_free(tav_video_context_t *ctx);

// Decode GOP_UNIFIED packet (0x12) to RGB24 frames
// Input: compressed_data - GOP packet data (after packet type byte)
//        compressed_size - size of compressed data
//        gop_size - number of frames in GOP (read from packet)
// Output: rgb_frames - array of pointers to RGB24 frame buffers (width*height*3 each)
//         Must be pre-allocated by caller (gop_size pointers, each pointing to width*height*3 bytes)
// Returns: 0 on success, -1 on error
int tav_video_decode_gop(tav_video_context_t *ctx,
                         const uint8_t *compressed_data, uint32_t compressed_size,
                         uint8_t gop_size, uint8_t **rgb_frames);

// Decode IFRAME packet (0x10) to RGB24 frame
// Input: compressed_data - I-frame packet data (after packet type byte)
//        packet_size - size of packet data
// Output: rgb_frame - pointer to RGB24 frame buffer (width*height*3 bytes)
//         Must be pre-allocated by caller
// Returns: 0 on success, -1 on error
int tav_video_decode_iframe(tav_video_context_t *ctx,
                            const uint8_t *compressed_data, uint32_t packet_size,
                            uint8_t *rgb_frame);

// Decode PFRAME packet (0x11) to RGB24 frame (delta from reference)
// Input: compressed_data - P-frame packet data (after packet type byte)
//        packet_size - size of packet data
// Output: rgb_frame - pointer to RGB24 frame buffer (width*height*3 bytes)
//         Must be pre-allocated by caller
// Returns: 0 on success, -1 on error
// Note: Requires previous frame to be decoded first (stored internally as reference)
int tav_video_decode_pframe(tav_video_context_t *ctx,
                            const uint8_t *compressed_data, uint32_t packet_size,
                            uint8_t *rgb_frame);

// Get last error message
const char *tav_video_get_error(tav_video_context_t *ctx);

// Enable verbose debug output
void tav_video_set_verbose(tav_video_context_t *ctx, int verbose);

#endif // TAV_VIDEO_DECODER_H
