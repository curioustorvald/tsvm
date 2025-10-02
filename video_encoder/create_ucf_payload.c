/**
 * UCF Payload Writer for TAV Files
 * Creates a 4KB UCF cue file for concatenated TAV files
 * Usage: ./create_ucf_payload input.tav output.ucf
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define UCF_SIZE 4096
#define TAV_OFFSET_BIAS UCF_SIZE
#define TAV_MAGIC "\x1FTSVMTA"  // Matches both TAV and TAP

typedef struct {
    uint8_t magic[8];
    uint8_t version;
    uint16_t width;
    uint16_t height;
    uint8_t fps;
    uint32_t total_frames;
    // ... rest of header fields
} __attribute__((packed)) TAVHeader;

// Write UCF header
static void write_ucf_header(FILE *out, uint16_t num_cues) {
    uint8_t magic[8] = {0x1F, 'T', 'S', 'V', 'M', 'U', 'C', 'F'};
    uint8_t version = 1;
    uint32_t cue_file_size = UCF_SIZE;
    uint8_t reserved = 0;

    fwrite(magic, 1, 8, out);
    fwrite(&version, 1, 1, out);
    fwrite(&num_cues, 2, 1, out);
    fwrite(&cue_file_size, 4, 1, out);
    fwrite(&reserved, 1, 1, out);
}

// Write UCF cue element (internal addressing, human+machine interactable)
static void write_cue_element(FILE *out, uint64_t offset, uint16_t track_num) {
    uint8_t addressing_mode = 0x21;  // 0x20 (human) | 0x01 (machine) | 0x02 (internal)
    char name[16];
    snprintf(name, sizeof(name), "Track %d", track_num);
    uint16_t name_len = strlen(name);

    // Offset with 4KB bias
    uint64_t biased_offset = offset + TAV_OFFSET_BIAS;

    fwrite(&addressing_mode, 1, 1, out);
    fwrite(&name_len, 2, 1, out);
    fwrite(name, 1, name_len, out);

    // Write 48-bit (6-byte) offset
    fwrite(&biased_offset, 6, 1, out);
}

// Find all TAV headers in the file
static int find_tav_headers(FILE *in, uint64_t **offsets_out) {
    uint64_t *offsets = NULL;
    int count = 0;
    int capacity = 16;

    offsets = malloc(capacity * sizeof(uint64_t));
    if (!offsets) {
        fprintf(stderr, "Error: Memory allocation failed\n");
        return -1;
    }

    // Seek to beginning
    fseek(in, 0, SEEK_SET);

    uint64_t pos = 0;
    uint8_t magic[8];

    while (fread(magic, 1, 8, in) == 8) {
        // Check for TAV magic signature
        if (memcmp(magic, TAV_MAGIC, 7) == 0 && (magic[7] == 'V' || magic[7] == 'P')) {
            // Found TAV header
            if (count >= capacity) {
                capacity *= 2;
                uint64_t *new_offsets = realloc(offsets, capacity * sizeof(uint64_t));
                if (!new_offsets) {
                    fprintf(stderr, "Error: Memory reallocation failed\n");
                    free(offsets);
                    return -1;
                }
                offsets = new_offsets;
            }

            offsets[count++] = pos;
            printf("Found TAV header at offset: 0x%lX (%lu)\n", pos, pos);

            // Skip past this header (32 bytes total)
            fseek(in, pos + 32, SEEK_SET);
            pos += 32;
        } else {
            // Move forward by 1 byte for next search
            fseek(in, pos + 1, SEEK_SET);
            pos++;
        }
    }

    *offsets_out = offsets;
    return count;
}

int main(int argc, char *argv[]) {
    if (argc != 3) {
        fprintf(stderr, "Usage: %s <input.tav> <output.ucf>\n", argv[0]);
        fprintf(stderr, "Creates a 4KB UCF payload for concatenated TAV file\n");
        return 1;
    }

    const char *input_path = argv[1];
    const char *output_path = argv[2];

    // Open input file
    FILE *in = fopen(input_path, "rb");
    if (!in) {
        fprintf(stderr, "Error: Cannot open input file '%s'\n", input_path);
        return 1;
    }

    // Find all TAV headers
    uint64_t *offsets = NULL;
    int num_tracks = find_tav_headers(in, &offsets);
    fclose(in);

    if (num_tracks < 0) {
        fprintf(stderr, "Error: Failed to scan input file\n");
        return 1;
    }

    if (num_tracks == 0) {
        fprintf(stderr, "Error: No TAV headers found in input file\n");
        return 1;
    }

    printf("\nFound %d TAV header(s)\n", num_tracks);

    // Create output UCF file
    FILE *out = fopen(output_path, "wb");
    if (!out) {
        fprintf(stderr, "Error: Cannot create output file '%s'\n", output_path);
        free(offsets);
        return 1;
    }

    // Write UCF header
    write_ucf_header(out, num_tracks);

    // Write cue elements
    for (int i = 0; i < num_tracks; i++) {
        write_cue_element(out, offsets[i], i + 1);
        printf("Written cue element: Track %d at offset 0x%lX (biased: 0x%lX)\n",
               i + 1, offsets[i], offsets[i] + TAV_OFFSET_BIAS);
    }

    // Get current file position
    long current_pos = ftell(out);

    // Fill remaining space with zeros to reach 4KB
    if (current_pos < UCF_SIZE) {
        size_t remaining = UCF_SIZE - current_pos;
        uint8_t *zeros = calloc(remaining, 1);
        if (zeros) {
            fwrite(zeros, 1, remaining, out);
            free(zeros);
        }
    }

    fclose(out);
    free(offsets);

    printf("\nUCF payload created successfully: %s\n", output_path);
    printf("File size: %d bytes (4KB)\n", UCF_SIZE);
    printf("\nTo create seekable TAV file, prepend this UCF to your TAV file:\n");
    printf("  cat %s input.tav > output_seekable.tav\n", output_path);

    return 0;
}
