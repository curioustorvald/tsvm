// Created by Claude on 2025-08-18.
// TEV (TSVM Enhanced Video) Encoder - YCoCg-R 4:2:0 16x16 Block Version
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include <zlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <getopt.h>
#include <sys/time.h>

// TSVM Enhanced Video (TEV) format constants
#define TEV_MAGIC "\x1F\x54\x53\x56\x4D\x54\x45\x56"  // "\x1FTSVM TEV"
#define TEV_VERSION 2  // Updated for YCoCg-R 4:2:0

// Block encoding modes (16x16 blocks)
#define TEV_MODE_SKIP      0x00  // Skip block (copy from reference)
#define TEV_MODE_INTRA     0x01  // Intra DCT coding (I-frame blocks)
#define TEV_MODE_INTER     0x02  // Inter DCT coding with motion compensation
#define TEV_MODE_MOTION    0x03  // Motion vector only (good prediction)

// Video packet types
#define TEV_PACKET_IFRAME      0x10  // Intra frame (keyframe)
#define TEV_PACKET_PFRAME      0x11  // Predicted frame  
#define TEV_PACKET_AUDIO_MP2   0x20  // MP2 audio
#define TEV_PACKET_SYNC        0xFF  // Sync packet

// Quality settings for quantization (Y channel) - 16x16 tables
static const uint8_t QUANT_TABLES_Y[8][256] = {
    // Quality 0 (lowest) - 16x16 table
    {80, 60, 50, 80, 120, 200, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     55, 60, 70, 95, 130, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     70, 65, 80, 120, 200, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     70, 85, 110, 145, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     90, 110, 185, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     120, 175, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     245, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255},
    // Quality 1
    {40, 30, 25, 40, 60, 100, 128, 150, 128, 150, 180, 200, 220, 240, 250, 255,
     28, 30, 35, 48, 65, 128, 150, 180, 150, 180, 200, 220, 240, 250, 255, 255,
     35, 33, 40, 60, 100, 128, 150, 180, 150, 180, 200, 220, 240, 250, 255, 255,
     35, 43, 55, 73, 128, 150, 180, 200, 180, 200, 220, 240, 250, 255, 255, 255,
     45, 55, 93, 128, 150, 180, 200, 220, 200, 220, 240, 250, 255, 255, 255, 255,
     60, 88, 128, 150, 180, 200, 220, 240, 220, 240, 250, 255, 255, 255, 255, 255,
     123, 128, 150, 180, 200, 220, 240, 250, 240, 250, 255, 255, 255, 255, 255, 255,
     128, 150, 180, 200, 220, 240, 250, 255, 250, 255, 255, 255, 255, 255, 255, 255,
     128, 150, 180, 200, 220, 240, 250, 255, 250, 255, 255, 255, 255, 255, 255, 255,
     150, 180, 200, 220, 240, 250, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     180, 200, 220, 240, 250, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     200, 220, 240, 250, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     220, 240, 250, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     240, 250, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     250, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255},
    // Quality 2
    {20, 15, 13, 20, 30, 50, 64, 75, 64, 75, 90, 100, 110, 120, 125, 128,
     14, 15, 18, 24, 33, 64, 75, 90, 75, 90, 100, 110, 120, 125, 128, 140,
     18, 17, 20, 30, 50, 64, 75, 90, 75, 90, 100, 110, 120, 125, 128, 140,
     18, 22, 28, 37, 64, 75, 90, 100, 90, 100, 110, 120, 125, 128, 140, 150,
     23, 28, 47, 64, 75, 90, 100, 110, 100, 110, 120, 125, 128, 140, 150, 160,
     30, 44, 64, 75, 90, 100, 110, 120, 110, 120, 125, 128, 140, 150, 160, 170,
     62, 64, 75, 90, 100, 110, 120, 125, 120, 125, 128, 140, 150, 160, 170, 180,
     64, 75, 90, 100, 110, 120, 125, 128, 125, 128, 140, 150, 160, 170, 180, 190,
     64, 75, 90, 100, 110, 120, 125, 128, 125, 128, 140, 150, 160, 170, 180, 190,
     75, 90, 100, 110, 120, 125, 128, 140, 128, 140, 150, 160, 170, 180, 190, 200,
     90, 100, 110, 120, 125, 128, 140, 150, 140, 150, 160, 170, 180, 190, 200, 210,
     100, 110, 120, 125, 128, 140, 150, 160, 150, 160, 170, 180, 190, 200, 210, 220,
     110, 120, 125, 128, 140, 150, 160, 170, 160, 170, 180, 190, 200, 210, 220, 230,
     120, 125, 128, 140, 150, 160, 170, 180, 170, 180, 190, 200, 210, 220, 230, 240,
     125, 128, 140, 150, 160, 170, 180, 190, 180, 190, 200, 210, 220, 230, 240, 250,
     128, 140, 150, 160, 170, 180, 190, 200, 190, 200, 210, 220, 230, 240, 250, 255},
    // Quality 3
    {16, 12, 10, 16, 24, 40, 51, 60, 51, 60, 72, 80, 88, 96, 100, 102,
     11, 12, 14, 19, 26, 51, 60, 72, 60, 72, 80, 88, 96, 100, 102, 110,
     14, 13, 16, 24, 40, 51, 60, 72, 60, 72, 80, 88, 96, 100, 102, 110,
     14, 17, 22, 29, 51, 60, 72, 80, 72, 80, 88, 96, 100, 102, 110, 120,
     18, 22, 37, 51, 60, 72, 80, 88, 80, 88, 96, 100, 102, 110, 120, 130,
     24, 35, 51, 60, 72, 80, 88, 96, 88, 96, 100, 102, 110, 120, 130, 140,
     49, 51, 60, 72, 80, 88, 96, 100, 96, 100, 102, 110, 120, 130, 140, 150,
     51, 60, 72, 80, 88, 96, 100, 102, 100, 102, 110, 120, 130, 140, 150, 160,
     51, 60, 72, 80, 88, 96, 100, 102, 100, 102, 110, 120, 130, 140, 150, 160,
     60, 72, 80, 88, 96, 100, 102, 110, 102, 110, 120, 130, 140, 150, 160, 170,
     72, 80, 88, 96, 100, 102, 110, 120, 110, 120, 130, 140, 150, 160, 170, 180,
     80, 88, 96, 100, 102, 110, 120, 130, 120, 130, 140, 150, 160, 170, 180, 190,
     88, 96, 100, 102, 110, 120, 130, 140, 130, 140, 150, 160, 170, 180, 190, 200,
     96, 100, 102, 110, 120, 130, 140, 150, 140, 150, 160, 170, 180, 190, 200, 210,
     100, 102, 110, 120, 130, 140, 150, 160, 150, 160, 170, 180, 190, 200, 210, 220,
     102, 110, 120, 130, 140, 150, 160, 170, 160, 170, 180, 190, 200, 210, 220, 230},
    // Quality 4
    {12, 9, 8, 12, 18, 30, 38, 45, 38, 45, 54, 60, 66, 72, 75, 77,
     8, 9, 11, 14, 20, 38, 45, 54, 45, 54, 60, 66, 72, 75, 77, 85,
     11, 10, 12, 18, 30, 38, 45, 54, 45, 54, 60, 66, 72, 75, 77, 85,
     11, 13, 17, 22, 38, 45, 54, 60, 54, 60, 66, 72, 75, 77, 85, 95,
     14, 17, 28, 38, 45, 54, 60, 66, 60, 66, 72, 75, 77, 85, 95, 105,
     18, 26, 38, 45, 54, 60, 66, 72, 66, 72, 75, 77, 85, 95, 105, 115,
     37, 38, 45, 54, 60, 66, 72, 75, 72, 75, 77, 85, 95, 105, 115, 125,
     38, 45, 54, 60, 66, 72, 75, 77, 75, 77, 85, 95, 105, 115, 125, 135,
     38, 45, 54, 60, 66, 72, 75, 77, 75, 77, 85, 95, 105, 115, 125, 135,
     45, 54, 60, 66, 72, 75, 77, 85, 77, 85, 95, 105, 115, 125, 135, 145,
     54, 60, 66, 72, 75, 77, 85, 95, 85, 95, 105, 115, 125, 135, 145, 155,
     60, 66, 72, 75, 77, 85, 95, 105, 95, 105, 115, 125, 135, 145, 155, 165,
     66, 72, 75, 77, 85, 95, 105, 115, 105, 115, 125, 135, 145, 155, 165, 175,
     72, 75, 77, 85, 95, 105, 115, 125, 115, 125, 135, 145, 155, 165, 175, 185,
     75, 77, 85, 95, 105, 115, 125, 135, 125, 135, 145, 155, 165, 175, 185, 195,
     77, 85, 95, 105, 115, 125, 135, 145, 135, 145, 155, 165, 175, 185, 195, 205},
    // Quality 5
    {10, 7, 6, 10, 15, 25, 32, 38, 32, 38, 45, 50, 55, 60, 63, 65,
     7, 7, 9, 12, 16, 32, 38, 45, 38, 45, 50, 55, 60, 63, 65, 70,
     9, 8, 10, 15, 25, 32, 38, 45, 38, 45, 50, 55, 60, 63, 65, 70,
     9, 11, 14, 18, 32, 38, 45, 50, 45, 50, 55, 60, 63, 65, 70, 75,
     12, 14, 23, 32, 38, 45, 50, 55, 50, 55, 60, 63, 65, 70, 75, 80,
     15, 22, 32, 38, 45, 50, 55, 60, 55, 60, 63, 65, 70, 75, 80, 85,
     31, 32, 38, 45, 50, 55, 60, 63, 60, 63, 65, 70, 75, 80, 85, 90,
     32, 38, 45, 50, 55, 60, 63, 65, 63, 65, 70, 75, 80, 85, 90, 95,
     32, 38, 45, 50, 55, 60, 63, 65, 63, 65, 70, 75, 80, 85, 90, 95,
     38, 45, 50, 55, 60, 63, 65, 70, 65, 70, 75, 80, 85, 90, 95, 100,
     45, 50, 55, 60, 63, 65, 70, 75, 70, 75, 80, 85, 90, 95, 100, 105,
     50, 55, 60, 63, 65, 70, 75, 80, 75, 80, 85, 90, 95, 100, 105, 110,
     55, 60, 63, 65, 70, 75, 80, 85, 80, 85, 90, 95, 100, 105, 110, 115,
     60, 63, 65, 70, 75, 80, 85, 90, 85, 90, 95, 100, 105, 110, 115, 120,
     63, 65, 70, 75, 80, 85, 90, 95, 90, 95, 100, 105, 110, 115, 120, 125,
     65, 70, 75, 80, 85, 90, 95, 100, 95, 100, 105, 110, 115, 120, 125, 130},
    // Quality 6
    {8, 6, 5, 8, 12, 20, 26, 30, 26, 30, 36, 40, 44, 48, 50, 52,
     6, 6, 7, 10, 13, 26, 30, 36, 30, 36, 40, 44, 48, 50, 52, 56,
     7, 7, 8, 12, 20, 26, 30, 36, 30, 36, 40, 44, 48, 50, 52, 56,
     7, 9, 11, 15, 26, 30, 36, 40, 36, 40, 44, 48, 50, 52, 56, 60,
     10, 11, 19, 26, 30, 36, 40, 44, 40, 44, 48, 50, 52, 56, 60, 64,
     12, 17, 26, 30, 36, 40, 44, 48, 44, 48, 50, 52, 56, 60, 64, 68,
     25, 26, 30, 36, 40, 44, 48, 50, 48, 50, 52, 56, 60, 64, 68, 72,
     26, 30, 36, 40, 44, 48, 50, 52, 50, 52, 56, 60, 64, 68, 72, 76,
     26, 30, 36, 40, 44, 48, 50, 52, 50, 52, 56, 60, 64, 68, 72, 76,
     30, 36, 40, 44, 48, 50, 52, 56, 52, 56, 60, 64, 68, 72, 76, 80,
     36, 40, 44, 48, 50, 52, 56, 60, 56, 60, 64, 68, 72, 76, 80, 84,
     40, 44, 48, 50, 52, 56, 60, 64, 60, 64, 68, 72, 76, 80, 84, 88,
     44, 48, 50, 52, 56, 60, 64, 68, 64, 68, 72, 76, 80, 84, 88, 92,
     48, 50, 52, 56, 60, 64, 68, 72, 68, 72, 76, 80, 84, 88, 92, 96,
     50, 52, 56, 60, 64, 68, 72, 76, 72, 76, 80, 84, 88, 92, 96, 100,
     52, 56, 60, 64, 68, 72, 76, 80, 76, 80, 84, 88, 92, 96, 100, 104},
    // Quality 7 (highest)
    {2, 1, 1, 2, 3, 5, 6, 7, 6, 7, 8, 9, 10, 11, 12, 13,
     1, 1, 1, 2, 3, 6, 7, 9, 7, 9, 10, 11, 12, 13, 14, 15,
     1, 1, 2, 3, 5, 6, 7, 9, 7, 9, 10, 11, 12, 13, 14, 15,
     1, 2, 3, 4, 6, 7, 9, 10, 9, 10, 11, 12, 13, 14, 15, 16,
     2, 3, 5, 6, 7, 9, 10, 11, 10, 11, 12, 13, 14, 15, 16, 17,
     3, 4, 6, 7, 9, 10, 11, 12, 11, 12, 13, 14, 15, 16, 17, 18,
     6, 6, 7, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 18, 19,
     6, 7, 9, 10, 11, 12, 13, 14, 13, 14, 15, 16, 17, 18, 19, 20,
     6, 7, 9, 10, 11, 12, 13, 14, 13, 14, 15, 16, 17, 18, 19, 20,
     7, 9, 10, 11, 12, 13, 14, 15, 14, 15, 16, 17, 18, 19, 20, 21,
     9, 10, 11, 12, 13, 14, 15, 16, 15, 16, 17, 18, 19, 20, 21, 22,
     10, 11, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 22, 23,
     11, 12, 13, 14, 15, 16, 17, 18, 17, 18, 19, 20, 21, 22, 23, 24,
     12, 13, 14, 15, 16, 17, 18, 19, 18, 19, 20, 21, 22, 23, 24, 25,
     13, 14, 15, 16, 17, 18, 19, 20, 19, 20, 21, 22, 23, 24, 25, 26,
     14, 15, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 26, 27}
};

// Quality settings for quantization (Chroma channels - 8x8)
static const uint8_t QUANT_TABLES_C[8][64] = {
    // Quality 0 (lowest)
    {120, 90, 75, 120, 180, 255, 255, 255,
     83, 90, 105, 143, 195, 255, 255, 255,
     105, 98, 120, 180, 255, 255, 255, 255,
     105, 128, 165, 218, 255, 255, 255, 255,
     135, 165, 255, 255, 255, 255, 255, 255,
     180, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255,
     255, 255, 255, 255, 255, 255, 255, 255},
    // Quality 1
    {60, 45, 38, 60, 90, 150, 192, 225,
     42, 45, 53, 72, 98, 192, 225, 255,
     53, 49, 60, 90, 150, 192, 225, 255,
     53, 64, 83, 109, 192, 225, 255, 255,
     68, 83, 139, 192, 225, 255, 255, 255,
     90, 132, 192, 225, 255, 255, 255, 255,
     185, 192, 225, 255, 255, 255, 255, 255,
     192, 225, 255, 255, 255, 255, 255, 255},
    // Quality 2 
    {30, 23, 19, 30, 45, 75, 96, 113,
     21, 23, 27, 36, 49, 96, 113, 135,
     27, 25, 30, 45, 75, 96, 113, 135,
     27, 32, 42, 55, 96, 113, 135, 150,
     34, 42, 70, 96, 113, 135, 150, 165,
     45, 66, 96, 113, 135, 150, 165, 180,
     93, 96, 113, 135, 150, 165, 180, 188,
     96, 113, 135, 150, 165, 180, 188, 192},
    // Quality 3
    {24, 18, 15, 24, 36, 60, 77, 90,
     17, 18, 21, 29, 39, 77, 90, 108,
     21, 20, 24, 36, 60, 77, 90, 108,
     21, 26, 33, 44, 77, 90, 108, 120,
     27, 33, 56, 77, 90, 108, 120, 132,
     36, 53, 77, 90, 108, 120, 132, 144,
     74, 77, 90, 108, 120, 132, 144, 150,
     77, 90, 108, 120, 132, 144, 150, 154},
    // Quality 4
    {18, 14, 12, 18, 27, 45, 57, 68,
     13, 14, 16, 22, 30, 57, 68, 81,
     16, 15, 18, 27, 45, 57, 68, 81,
     16, 20, 25, 33, 57, 68, 81, 90,
     20, 25, 42, 57, 68, 81, 90, 99,
     27, 39, 57, 68, 81, 90, 99, 108,
     56, 57, 68, 81, 90, 99, 108, 113,
     57, 68, 81, 90, 99, 108, 113, 116},
    // Quality 5
    {15, 11, 9, 15, 23, 38, 48, 57,
     11, 11, 13, 18, 24, 48, 57, 68,
     13, 12, 15, 23, 38, 48, 57, 68,
     13, 16, 21, 28, 48, 57, 68, 75,
     17, 21, 35, 48, 57, 68, 75, 83,
     23, 33, 48, 57, 68, 75, 83, 90,
     46, 48, 57, 68, 75, 83, 90, 94,
     48, 57, 68, 75, 83, 90, 94, 96},
    // Quality 6
    {12, 9, 8, 12, 18, 30, 39, 45,
     9, 9, 11, 14, 20, 39, 45, 54,
     11, 10, 12, 18, 30, 39, 45, 54,
     11, 13, 17, 22, 39, 45, 54, 60,
     14, 17, 28, 39, 45, 54, 60, 66,
     18, 26, 39, 45, 54, 60, 66, 72,
     38, 39, 45, 54, 60, 66, 72, 75,
     39, 45, 54, 60, 66, 72, 75, 77},
    // Quality 7 (highest)
    {3, 2, 2, 3, 5, 8, 9, 11,
     2, 2, 2, 3, 5, 9, 11, 14,
     2, 2, 3, 5, 8, 9, 11, 14,
     2, 3, 5, 6, 9, 11, 14, 15,
     3, 5, 8, 9, 11, 14, 15, 17,
     5, 6, 9, 11, 14, 15, 17, 18,
     9, 9, 11, 14, 15, 17, 18, 20,
     9, 11, 14, 15, 17, 18, 20, 20}
};

// Audio constants (reuse MP2 from existing system)
#define MP2_SAMPLE_RATE 32000
#define MP2_DEFAULT_PACKET_SIZE 0x240

// Encoding parameters
#define MAX_MOTION_SEARCH 16
#define KEYFRAME_INTERVAL 30
#define BLOCK_SIZE 16  // 16x16 blocks now

// Default values
#define DEFAULT_WIDTH 560
#define DEFAULT_HEIGHT 448
#define TEMP_AUDIO_FILE "/tmp/tev_temp_audio.mp2"

typedef struct __attribute__((packed)) {
    uint8_t mode;           // Block encoding mode
    int16_t mv_x, mv_y;     // Motion vector (1/4 pixel precision)
    uint16_t cbp;           // Coded block pattern (which channels have non-zero coeffs)
    int16_t y_coeffs[256];  // Quantized Y DCT coefficients (16x16)
    int16_t co_coeffs[64];  // Quantized Co DCT coefficients (8x8)
    int16_t cg_coeffs[64];  // Quantized Cg DCT coefficients (8x8)
} tev_block_t;

typedef struct {
    char *input_file;
    char *output_file;
    int width;
    int height;
    int fps;
    int total_frames;
    double duration;
    int has_audio;
    int output_to_stdout;
    int quality;  // 0-7, higher = better quality
    
    // Frame buffers (8-bit RGB format for encoding)
    uint8_t *current_rgb, *previous_rgb, *reference_rgb;
    
    // YCoCg workspace
    float *y_workspace, *co_workspace, *cg_workspace;
    float *dct_workspace;       // DCT coefficients
    tev_block_t *block_data;    // Encoded block data
    uint8_t *compressed_buffer; // Zstd output
    
    // Audio handling
    FILE *mp2_file;
    int mp2_packet_size;
    size_t audio_remaining;
    uint8_t *mp2_buffer;
    
    // Compression context
    z_stream gzip_stream;
    
    // FFmpeg processes
    FILE *ffmpeg_video_pipe;
    
    // Progress tracking
    struct timeval start_time;
    size_t total_output_bytes;
    
    // Statistics
    int blocks_skip, blocks_intra, blocks_inter, blocks_motion;
} tev_encoder_t;

// RGB to YCoCg-R transform
static void rgb_to_ycocgr(uint8_t r, uint8_t g, uint8_t b, int *y, int *co, int *cg) {
    *co = r - b;
    int tmp = b + ((*co) >> 1);
    *cg = g - tmp;
    *y = tmp + ((*cg) >> 1);
}

// YCoCg-R to RGB transform (for verification)
static void ycocgr_to_rgb(int y, int co, int cg, uint8_t *r, uint8_t *g, uint8_t *b) {
    int tmp = y - (cg >> 1);
    *g = cg + tmp;
    *b = tmp - (co >> 1);
    *r = *b + co;
    
    // Clamp values
    *r = (*r < 0) ? 0 : ((*r > 255) ? 255 : *r);
    *g = (*g < 0) ? 0 : ((*g > 255) ? 255 : *g);
    *b = (*b < 0) ? 0 : ((*b > 255) ? 255 : *b);
}

// 16x16 2D DCT
static void dct_16x16(float *input, float *output) {
    for (int u = 0; u < 16; u++) {
        for (int v = 0; v < 16; v++) {
            float sum = 0.0f;
            float cu = (u == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;
            float cv = (v == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;
            
            for (int x = 0; x < 16; x++) {
                for (int y = 0; y < 16; y++) {
                    sum += input[y * 16 + x] *
                           cosf((2.0f * x + 1.0f) * u * M_PI / 32.0f) *
                           cosf((2.0f * y + 1.0f) * v * M_PI / 32.0f);
                }
            }
            
            output[u * 16 + v] = 0.25f * cu * cv * sum;
        }
    }
}

// 8x8 2D DCT (for chroma)
static void dct_8x8(float *input, float *output) {
    for (int u = 0; u < 8; u++) {
        for (int v = 0; v < 8; v++) {
            float sum = 0.0f;
            float cu = (u == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;
            float cv = (v == 0) ? 1.0f / sqrtf(2.0f) : 1.0f;
            
            for (int x = 0; x < 8; x++) {
                for (int y = 0; y < 8; y++) {
                    sum += input[y * 8 + x] *
                           cosf((2.0f * x + 1.0f) * u * M_PI / 16.0f) *
                           cosf((2.0f * y + 1.0f) * v * M_PI / 16.0f);
                }
            }
            
            output[u * 8 + v] = 0.25f * cu * cv * sum;
        }
    }
}

// Quantize DCT coefficient using quality table
static int16_t quantize_coeff(float coeff, uint8_t quant, int is_dc) {
    if (is_dc) {
        // DC coefficient uses fixed quantizer
        return (int16_t)roundf(coeff / 8.0f);
    } else {
        // AC coefficients use quality table
        return (int16_t)roundf(coeff / quant);
    }
}

// Extract 16x16 block from RGB frame and convert to YCoCg-R
static void extract_ycocgr_block(uint8_t *rgb_frame, int width, int height,
                                int block_x, int block_y,
                                float *y_block, float *co_block, float *cg_block) {
    int start_x = block_x * 16;
    int start_y = block_y * 16;
    
    // Extract 16x16 Y block
    for (int py = 0; py < 16; py++) {
        for (int px = 0; px < 16; px++) {
            int x = start_x + px;
            int y = start_y + py;
            
            if (x < width && y < height) {
                int offset = (y * width + x) * 3;
                uint8_t r = rgb_frame[offset];
                uint8_t g = rgb_frame[offset + 1];
                uint8_t b = rgb_frame[offset + 2];
                
                int y_val, co_val, cg_val;
                rgb_to_ycocgr(r, g, b, &y_val, &co_val, &cg_val);
                
                y_block[py * 16 + px] = (float)y_val - 128.0f;  // Center around 0
            }
        }
    }
    
    // Extract 8x8 chroma blocks with 4:2:0 subsampling (average 2x2 pixels)
    for (int py = 0; py < 8; py++) {
        for (int px = 0; px < 8; px++) {
            int co_sum = 0, cg_sum = 0, count = 0;
            
            // Average 2x2 block of pixels
            for (int dy = 0; dy < 2; dy++) {
                for (int dx = 0; dx < 2; dx++) {
                    int x = start_x + px * 2 + dx;
                    int y = start_y + py * 2 + dy;
                    
                    if (x < width && y < height) {
                        int offset = (y * width + x) * 3;
                        uint8_t r = rgb_frame[offset];
                        uint8_t g = rgb_frame[offset + 1];
                        uint8_t b = rgb_frame[offset + 2];
                        
                        int y_val, co_val, cg_val;
                        rgb_to_ycocgr(r, g, b, &y_val, &co_val, &cg_val);
                        
                        co_sum += co_val;
                        cg_sum += cg_val;
                        count++;
                    }
                }
            }
            
            if (count > 0) {
                co_block[py * 8 + px] = (float)(co_sum / count);
                cg_block[py * 8 + px] = (float)(cg_sum / count);
            }
        }
    }
}

// Simple motion estimation (full search) for 16x16 blocks
static void estimate_motion(tev_encoder_t *enc, int block_x, int block_y, 
                           int16_t *best_mv_x, int16_t *best_mv_y) {
    int best_sad = INT_MAX;
    *best_mv_x = 0;
    *best_mv_y = 0;
    
    int start_x = block_x * 16;
    int start_y = block_y * 16;
    
    // Search in range [-16, +16] pixels
    for (int mv_y = -MAX_MOTION_SEARCH; mv_y <= MAX_MOTION_SEARCH; mv_y++) {
        for (int mv_x = -MAX_MOTION_SEARCH; mv_x <= MAX_MOTION_SEARCH; mv_x++) {
            int ref_x = start_x + mv_x;
            int ref_y = start_y + mv_y;
            
            // Check bounds
            if (ref_x < 0 || ref_y < 0 || 
                ref_x + 16 > enc->width || ref_y + 16 > enc->height) {
                continue;
            }
            
            // Calculate SAD for 16x16 block
            int sad = 0;
            for (int dy = 0; dy < 16; dy++) {
                for (int dx = 0; dx < 16; dx++) {
                    int cur_offset = ((start_y + dy) * enc->width + (start_x + dx)) * 3;
                    int ref_offset = ((ref_y + dy) * enc->width + (ref_x + dx)) * 3;
                    
                    // Compare luminance (approximate as average of RGB)
                    int cur_luma = (enc->current_rgb[cur_offset] + 
                                   enc->current_rgb[cur_offset + 1] + 
                                   enc->current_rgb[cur_offset + 2]) / 3;
                    int ref_luma = (enc->previous_rgb[ref_offset] + 
                                   enc->previous_rgb[ref_offset + 1] + 
                                   enc->previous_rgb[ref_offset + 2]) / 3;
                    
                    sad += abs(cur_luma - ref_luma);
                }
            }
            
            if (sad < best_sad) {
                best_sad = sad;
                *best_mv_x = mv_x;
                *best_mv_y = mv_y;
            }
        }
    }
}

// Encode a 16x16 block
static void encode_block(tev_encoder_t *enc, int block_x, int block_y, int is_keyframe) {
    tev_block_t *block = &enc->block_data[block_y * ((enc->width + 15) / 16) + block_x];
    
    // Extract YCoCg-R block
    extract_ycocgr_block(enc->current_rgb, enc->width, enc->height,
                        block_x, block_y,
                        enc->y_workspace, enc->co_workspace, enc->cg_workspace);
    
    if (is_keyframe) {
        // Intra coding
        block->mode = TEV_MODE_INTRA;
        block->mv_x = block->mv_y = 0;
        enc->blocks_intra++;
    } else {
        // Try motion estimation
        estimate_motion(enc, block_x, block_y, &block->mv_x, &block->mv_y);
        
        // For simplicity, always use INTRA mode for now
        // TODO: Implement proper mode decision
        block->mode = TEV_MODE_INTRA;
        block->mv_x = block->mv_y = 0;
        enc->blocks_intra++;
    }
    
    // Apply DCT transform
    dct_16x16(enc->y_workspace, enc->dct_workspace);
    
    // Quantize Y coefficients
    const uint8_t *y_quant = QUANT_TABLES_Y[enc->quality];
    for (int i = 0; i < 256; i++) {
        block->y_coeffs[i] = quantize_coeff(enc->dct_workspace[i], y_quant[i], i == 0);
    }
    
    // Apply DCT transform to chroma
    dct_8x8(enc->co_workspace, enc->dct_workspace);
    
    // Quantize Co coefficients  
    const uint8_t *c_quant = QUANT_TABLES_C[enc->quality];
    for (int i = 0; i < 64; i++) {
        block->co_coeffs[i] = quantize_coeff(enc->dct_workspace[i], c_quant[i], i == 0);
    }
    
    // Apply DCT transform to Cg
    dct_8x8(enc->cg_workspace, enc->dct_workspace);
    
    // Quantize Cg coefficients
    for (int i = 0; i < 64; i++) {
        block->cg_coeffs[i] = quantize_coeff(enc->dct_workspace[i], c_quant[i], i == 0);
    }
    
    // Set CBP (simplified - always encode all channels)
    block->cbp = 0x07;  // Y, Co, Cg all present
}

// Initialize encoder
static tev_encoder_t* init_encoder(void) {
    tev_encoder_t *enc = calloc(1, sizeof(tev_encoder_t));
    if (!enc) return NULL;
    
    enc->quality = 4;  // Default quality
    enc->mp2_packet_size = MP2_DEFAULT_PACKET_SIZE;
    
    return enc;
}

// Allocate encoder buffers
static int alloc_encoder_buffers(tev_encoder_t *enc) {
    int pixels = enc->width * enc->height;
    int blocks_x = (enc->width + 15) / 16;
    int blocks_y = (enc->height + 15) / 16;
    int total_blocks = blocks_x * blocks_y;
    
    enc->current_rgb = malloc(pixels * 3);
    enc->previous_rgb = malloc(pixels * 3);
    enc->reference_rgb = malloc(pixels * 3);
    
    enc->y_workspace = malloc(16 * 16 * sizeof(float));
    enc->co_workspace = malloc(8 * 8 * sizeof(float));
    enc->cg_workspace = malloc(8 * 8 * sizeof(float));
    enc->dct_workspace = malloc(16 * 16 * sizeof(float));
    
    enc->block_data = malloc(total_blocks * sizeof(tev_block_t));
    enc->compressed_buffer = malloc(total_blocks * sizeof(tev_block_t) * 2);
    enc->mp2_buffer = malloc(MP2_DEFAULT_PACKET_SIZE);
    
    if (!enc->current_rgb || !enc->previous_rgb || !enc->reference_rgb ||
        !enc->y_workspace || !enc->co_workspace || !enc->cg_workspace ||
        !enc->dct_workspace || !enc->block_data || 
        !enc->compressed_buffer || !enc->mp2_buffer) {
        return -1;
    }
    
    // Initialize gzip compression stream
    enc->gzip_stream.zalloc = Z_NULL;
    enc->gzip_stream.zfree = Z_NULL;
    enc->gzip_stream.opaque = Z_NULL;
    
    int gzip_init_result = deflateInit2(&enc->gzip_stream, Z_DEFAULT_COMPRESSION, 
                                       Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY); // 15+16 for gzip format
    
    if (gzip_init_result != Z_OK) {
        fprintf(stderr, "Failed to initialize gzip compression\n");
        return -1;
    }
    
    // Initialize previous frame to black
    memset(enc->previous_rgb, 0, pixels * 3);
    
    return 0;
}

// Free encoder resources
static void free_encoder(tev_encoder_t *enc) {
    if (!enc) return;
    
    deflateEnd(&enc->gzip_stream);
    
    free(enc->current_rgb);
    free(enc->previous_rgb);
    free(enc->reference_rgb);
    free(enc->y_workspace);
    free(enc->co_workspace);
    free(enc->cg_workspace);
    free(enc->dct_workspace);
    free(enc->block_data);
    free(enc->compressed_buffer);
    free(enc->mp2_buffer);
    free(enc);
}

// Write TEV header
static int write_tev_header(FILE *output, tev_encoder_t *enc) {
    // Magic + version
    fwrite(TEV_MAGIC, 1, 8, output);
    uint8_t version = TEV_VERSION;
    fwrite(&version, 1, 1, output);
    
    // Video parameters
    uint16_t width = enc->width;
    uint16_t height = enc->height;
    uint8_t fps = enc->fps;
    uint32_t total_frames = enc->total_frames;
    uint8_t quality = enc->quality;
    uint8_t has_audio = enc->has_audio;
    
    fwrite(&width, 2, 1, output);
    fwrite(&height, 2, 1, output);
    fwrite(&fps, 1, 1, output);
    fwrite(&total_frames, 4, 1, output);
    fwrite(&quality, 1, 1, output);
    fwrite(&has_audio, 1, 1, output);
    
    return 0;
}

// Encode and write a frame
static int encode_frame(tev_encoder_t *enc, FILE *output, int frame_num) {
    int is_keyframe = (frame_num % KEYFRAME_INTERVAL) == 0;
    int blocks_x = (enc->width + 15) / 16;
    int blocks_y = (enc->height + 15) / 16;
    
    // Encode all blocks
    for (int by = 0; by < blocks_y; by++) {
        for (int bx = 0; bx < blocks_x; bx++) {
            encode_block(enc, bx, by, is_keyframe);
        }
    }
    
    // Compress block data using gzip (compatible with TSVM decoder)
    size_t block_data_size = blocks_x * blocks_y * sizeof(tev_block_t);
    
    // Reset compression stream
    enc->gzip_stream.next_in = (Bytef*)enc->block_data;
    enc->gzip_stream.avail_in = block_data_size;
    enc->gzip_stream.next_out = (Bytef*)enc->compressed_buffer;
    enc->gzip_stream.avail_out = block_data_size * 2;
    
    if (deflateReset(&enc->gzip_stream) != Z_OK) {
        fprintf(stderr, "Gzip deflateReset failed\n");
        return -1;
    }
    
    int result = deflate(&enc->gzip_stream, Z_FINISH);
    if (result != Z_STREAM_END) {
        fprintf(stderr, "Gzip compression failed: %d\n", result);
        return -1;
    }
    
    size_t compressed_size = enc->gzip_stream.total_out;
    
    // Write frame packet header
    uint8_t packet_type = is_keyframe ? TEV_PACKET_IFRAME : TEV_PACKET_PFRAME;
    uint32_t payload_size = compressed_size;
    
    fwrite(&packet_type, 1, 1, output);
    fwrite(&payload_size, 4, 1, output);
    fwrite(enc->compressed_buffer, 1, compressed_size, output);
    
    enc->total_output_bytes += 5 + compressed_size;
    
    // Copy current frame to previous for next iteration
    memcpy(enc->previous_rgb, enc->current_rgb, enc->width * enc->height * 3);
    
    return 0;
}

// Show usage information
static void show_usage(const char *program_name) {
    printf("Usage: %s [options] -i input.mp4 -o output.tev\n", program_name);
    printf("Options:\n");
    printf("  -i, --input FILE     Input video file\n");
    printf("  -o, --output FILE    Output TEV file (use '-' for stdout)\n");
    printf("  -w, --width N        Video width (default: %d)\n", DEFAULT_WIDTH);
    printf("  -h, --height N       Video height (default: %d)\n", DEFAULT_HEIGHT);
    printf("  -f, --fps N          Frames per second (default: 15)\n");
    printf("  -q, --quality N      Quality level 0-7 (default: 4)\n");
    printf("  -v, --verbose        Verbose output\n");
    printf("  --help               Show this help\n");
}

// Main function
int main(int argc, char *argv[]) {
    tev_encoder_t *enc = init_encoder();
    if (!enc) {
        fprintf(stderr, "Failed to initialize encoder\n");
        return 1;
    }
    
    // Set defaults
    enc->width = DEFAULT_WIDTH;
    enc->height = DEFAULT_HEIGHT;
    enc->fps = 15;
    enc->quality = 4;
    
    static struct option long_options[] = {
        {"input", required_argument, 0, 'i'},
        {"output", required_argument, 0, 'o'},
        {"width", required_argument, 0, 'w'},
        {"height", required_argument, 0, 'h'},
        {"fps", required_argument, 0, 'f'},
        {"quality", required_argument, 0, 'q'},
        {"verbose", no_argument, 0, 'v'},
        {"help", no_argument, 0, 0},
        {0, 0, 0, 0}
    };
    
    int option_index = 0;
    int c;
    
    while ((c = getopt_long(argc, argv, "i:o:w:h:f:q:v", long_options, &option_index)) != -1) {
        switch (c) {
            case 'i':
                enc->input_file = optarg;
                break;
            case 'o':
                enc->output_file = optarg;
                enc->output_to_stdout = (strcmp(optarg, "-") == 0);
                break;
            case 'w':
                enc->width = atoi(optarg);
                break;
            case 'h':
                enc->height = atoi(optarg);
                break;
            case 'f':
                enc->fps = atoi(optarg);
                break;
            case 'q':
                enc->quality = atoi(optarg);
                if (enc->quality < 0) enc->quality = 0;
                if (enc->quality > 7) enc->quality = 7;
                break;
            case 'v':
                // Verbose flag (not implemented)
                break;
            case 0:
                if (strcmp(long_options[option_index].name, "help") == 0) {
                    show_usage(argv[0]);
                    free_encoder(enc);
                    return 0;
                }
                break;
            default:
                show_usage(argv[0]);
                free_encoder(enc);
                return 1;
        }
    }
    
    if (!enc->input_file || !enc->output_file) {
        fprintf(stderr, "Input and output files are required\n");
        show_usage(argv[0]);
        free_encoder(enc);
        return 1;
    }
    
    // Calculate total frames (simplified - assume 1 second for now)
    enc->total_frames = enc->fps;
    
    // Allocate buffers
    if (alloc_encoder_buffers(enc) < 0) {
        fprintf(stderr, "Failed to allocate encoder buffers\n");
        free_encoder(enc);
        return 1;
    }
    
    // Open output
    FILE *output = enc->output_to_stdout ? stdout : fopen(enc->output_file, "wb");
    if (!output) {
        perror("Failed to open output file");
        free_encoder(enc);
        return 1;
    }
    
    // Write TEV header
    write_tev_header(output, enc);
    
    // For this simplified version, create a test pattern
    printf("Encoding test pattern with YCoCg-R 4:2:0 format...\n");
    
    for (int frame = 0; frame < enc->total_frames; frame++) {
        // Generate test pattern (gradient)
        for (int y = 0; y < enc->height; y++) {
            for (int x = 0; x < enc->width; x++) {
                int offset = (y * enc->width + x) * 3;
                enc->current_rgb[offset] = (x * 255) / enc->width;     // R gradient
                enc->current_rgb[offset + 1] = (y * 255) / enc->height; // G gradient
                enc->current_rgb[offset + 2] = ((x + y) * 255) / (enc->width + enc->height); // B gradient
            }
        }
        
        // Encode frame
        if (encode_frame(enc, output, frame) < 0) {
            fprintf(stderr, "Failed to encode frame %d\n", frame);
            break;
        }
        
        printf("Encoded frame %d/%d\n", frame + 1, enc->total_frames);
    }
    
    // Write sync packet
    uint8_t sync_packet = TEV_PACKET_SYNC;
    uint32_t sync_size = 0;
    fwrite(&sync_packet, 1, 1, output);
    fwrite(&sync_size, 4, 1, output);
    
    if (!enc->output_to_stdout) {
        fclose(output);
    }
    
    printf("Encoding complete. Output size: %zu bytes\n", enc->total_output_bytes);
    printf("Block statistics: INTRA=%d, INTER=%d, MOTION=%d, SKIP=%d\n",
           enc->blocks_intra, enc->blocks_inter, enc->blocks_motion, enc->blocks_skip);
    
    free_encoder(enc);
    return 0;
}