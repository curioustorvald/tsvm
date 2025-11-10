/**
 * TAV+UCF Payload Writer for TAV Files
 * Creates a TAV header-only (32 bytes) + UCF cue file (4KB) for concatenated TAV files
 * Total output size: 4096 bytes (32 + 4064)
 * Usage: ./create_ucf_payload input.tav output.ucf [track_names.txt]
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define TAV_HEADER_SIZE 32
#define UCF_SIZE 4064
#define TAV_OFFSET_BIAS (TAV_HEADER_SIZE + UCF_SIZE)
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

// Write TAV header-only payload (File Role = 1)
static void write_tav_header_only(FILE *out) {
    uint8_t header[TAV_HEADER_SIZE] = {0};

    // Magic: "\x1FTSVMTAV"
    header[0] = 0x1F;
    header[1] = 'T';
    header[2] = 'S';
    header[3] = 'V';
    header[4] = 'M';
    header[5] = 'T';
    header[6] = 'A';
    header[7] = 'V';

    // Version: 5 (YCoCg-R perceptual)
    header[8] = 5;

    // Width: 560 (little-endian)
    header[9] = 0x30;
    header[10] = 0x02;

    // Height: 448 (little-endian)
    header[11] = 0xC0;
    header[12] = 0x01;

    // FPS: 30
    header[13] = 30;

    // Total Frames: 0xFFFFFFFF (still image marker / not applicable)
    header[14] = 0xFF;
    header[15] = 0xFF;
    header[16] = 0xFF;
    header[17] = 0xFF;

    // Wavelet Filter Type: 1 (9/7 irreversible, default)
    header[18] = 1;

    // Decomposition Levels: 6
    header[19] = 6;

    // Quantiser Indices (Y, Co, Cg): 255 (not applicable for header-only)
    header[20] = 0xFF;
    header[21] = 0xFF;
    header[22] = 0xFF;

    // Extra Feature Flags: 0x80 (bit 7 = has no actual packets)
    header[23] = 0x80;

    // Video Flags: 0
    header[24] = 0;

    // Encoder quality level: 0
    header[25] = 0;

    // Channel layout: 0 (Y-Co-Cg)
    header[26] = 0;

    // Reserved[4]: zeros (27-30 already initialised to 0)

    // File Role: 1 (header-only, UCF payload follows)
    header[31] = 1;

    fwrite(header, 1, TAV_HEADER_SIZE, out);
}

// Write UCF header
static void write_ucf_header(FILE *out, uint16_t num_cues) {
    uint8_t magic[8] = {0x1F, 'T', 'S', 'V', 'M', 'U', 'C', 'F'};
    uint8_t version = 1;
    uint32_t cue_file_size = TAV_OFFSET_BIAS;
    uint8_t reserved = 0;

    fwrite(magic, 1, 8, out);
    fwrite(&version, 1, 1, out);
    fwrite(&num_cues, 2, 1, out);
    fwrite(&cue_file_size, 4, 1, out);
    fwrite(&reserved, 1, 1, out);
}

// Write UCF cue element (internal addressing, human+machine interactable)
static void write_cue_element(FILE *out, uint64_t offset, const char *name) {
    uint8_t addressing_mode = 0x22;  // 0x20 (human) | 0x01 (machine) | 0x02 (internal)
    uint16_t name_len = strlen(name);

    // Offset with 4KB bias
    uint64_t biased_offset = offset + TAV_OFFSET_BIAS;

    fwrite(&addressing_mode, 1, 1, out);
    fwrite(&name_len, 2, 1, out);
    fwrite(name, 1, name_len, out);

    // Write 48-bit (6-byte) offset
    fwrite(&biased_offset, 6, 1, out);
}

// Read track names from file (newline-delimited)
static char **read_track_names(const char *filename, int *count_out) {
    FILE *f = fopen(filename, "r");
    if (!f) {
        return NULL;
    }

    char **names = NULL;
    int count = 0;
    int capacity = 16;
    char line[256];

    names = malloc(capacity * sizeof(char *));
    if (!names) {
        fclose(f);
        return NULL;
    }

    while (fgets(line, sizeof(line), f)) {
        // Remove trailing newline
        size_t len = strlen(line);
        if (len > 0 && line[len - 1] == '\n') {
            line[len - 1] = '\0';
            len--;
        }
        if (len > 0 && line[len - 1] == '\r') {
            line[len - 1] = '\0';
            len--;
        }

        // Skip empty lines
        if (len == 0) {
            continue;
        }

        // Expand capacity if needed
        if (count >= capacity) {
            capacity *= 2;
            char **new_names = realloc(names, capacity * sizeof(char *));
            if (!new_names) {
                // Cleanup on failure
                for (int i = 0; i < count; i++) {
                    free(names[i]);
                }
                free(names);
                fclose(f);
                return NULL;
            }
            names = new_names;
        }

        // Allocate and copy name
        names[count] = strdup(line);
        if (!names[count]) {
            // Cleanup on failure
            for (int i = 0; i < count; i++) {
                free(names[i]);
            }
            free(names);
            fclose(f);
            return NULL;
        }
        count++;
    }

    fclose(f);
    *count_out = count;
    return names;
}

// Find all TAV headers in the file (with smart packet-wise skipping)
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

    uint8_t magic[8];

    while (1) {
        // Remember current position before reading
        uint64_t pos = ftell(in);

        // Try to read magic
        if (fread(magic, 1, 8, in) != 8) {
            // End of file
            break;
        }

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
            uint64_t packet_pos = pos + 32;
            fseek(in, packet_pos, SEEK_SET);

            // Smart packet-wise skipping
            while (1) {
                uint8_t packet_type;
                if (fread(&packet_type, 1, 1, in) != 1) {
                    // End of file
                    break;
                }

                // Check if this is the start of next TAV file (0x1F is prohibited as packet type)
                if (packet_type == 0x1F) {
                    // Rewind 1 byte to re-read as magic at the top of outer loop
                    fseek(in, packet_pos, SEEK_SET);
                    break;
                }

                // printf("TAV Packet 0x%02X at 0x%lX\n", packet_type, packet_pos);

                // Sync packets (0xFE, 0xFF) have no payload size - they're single-byte packets
                if (packet_type == 0xFE || packet_type == 0xFF) {
                    packet_pos += 1;
                    fseek(in, packet_pos, SEEK_SET);
                    continue;
                }

                // Read payload size (uint32, little-endian)
                uint32_t payload_size = 0;
                if (fread(&payload_size, 4, 1, in) != 1) {
                    // End of file
                    break;
                }

                // Skip packet: 1 byte (type) + 4 bytes (size) + payload_size
                packet_pos += 1 + 4 + payload_size;
                fseek(in, packet_pos, SEEK_SET);
            }
        } else {
            // Move forward by 1 byte for next search
            fseek(in, pos + 1, SEEK_SET);
        }
    }

    *offsets_out = offsets;
    return count;
}

int main(int argc, char *argv[]) {
    if (argc < 3 || argc > 4) {
        fprintf(stderr, "Usage: %s <input.tav> <output.ucf> [track_names.txt]\n", argv[0]);
        fprintf(stderr, "Creates a 4KB UCF payload for concatenated TAV file\n");
        fprintf(stderr, "  track_names.txt: Optional file with track names (one per line)\n");
        return 1;
    }

    const char *input_path = argv[1];
    const char *output_path = argv[2];
    const char *names_path = (argc == 4) ? argv[3] : NULL;

    // Read track names if provided
    char **track_names = NULL;
    int num_names = 0;
    if (names_path) {
        track_names = read_track_names(names_path, &num_names);
        if (track_names) {
            printf("Loaded %d track name(s) from '%s'\n", num_names, names_path);
        } else {
            fprintf(stderr, "Warning: Could not read track names from '%s', using defaults\n", names_path);
        }
    }

    // Open input file
    FILE *in = fopen(input_path, "rb");
    if (!in) {
        fprintf(stderr, "Error: Cannot open input file '%s'\n", input_path);
        if (track_names) {
            for (int i = 0; i < num_names; i++) {
                free(track_names[i]);
            }
            free(track_names);
        }
        return 1;
    }

    // Find all TAV headers
    uint64_t *offsets = NULL;
    int num_tracks = find_tav_headers(in, &offsets);
    fclose(in);

    if (num_tracks < 0) {
        fprintf(stderr, "Error: Failed to scan input file\n");
        if (track_names) {
            for (int i = 0; i < num_names; i++) {
                free(track_names[i]);
            }
            free(track_names);
        }
        return 1;
    }

    if (num_tracks == 0) {
        fprintf(stderr, "Error: No TAV headers found in input file\n");
        free(offsets);
        if (track_names) {
            for (int i = 0; i < num_names; i++) {
                free(track_names[i]);
            }
            free(track_names);
        }
        return 1;
    }

    printf("\nFound %d TAV header(s)\n", num_tracks);

    // Create output UCF file
    FILE *out = fopen(output_path, "wb");
    if (!out) {
        fprintf(stderr, "Error: Cannot create output file '%s'\n", output_path);
        free(offsets);
        if (track_names) {
            for (int i = 0; i < num_names; i++) {
                free(track_names[i]);
            }
            free(track_names);
        }
        return 1;
    }

    // Write TAV header-only payload (File Role = 1)
    write_tav_header_only(out);
    printf("Written TAV header-only payload (%d bytes)\n", TAV_HEADER_SIZE);

    // Write UCF header
    write_ucf_header(out, num_tracks);

    // Write cue elements
    for (int i = 0; i < num_tracks; i++) {
        char default_name[32];
        const char *name;

        // Use custom name if available, otherwise generate default
        if (track_names && i < num_names) {
            name = track_names[i];
        } else {
            snprintf(default_name, sizeof(default_name), "Track %d", i + 1);
            name = default_name;
        }

        write_cue_element(out, offsets[i], name);
        printf("Written cue element: '%s' at offset 0x%lX (biased: 0x%lX)\n",
               name, offsets[i], offsets[i] + TAV_OFFSET_BIAS);
    }

    // Get current file position
    long current_pos = ftell(out);

    // Fill remaining space with zeros to reach TAV header + 4KB UCF
    size_t target_size = TAV_HEADER_SIZE + UCF_SIZE;
    if (current_pos < target_size) {
        size_t remaining = target_size - current_pos;
        uint8_t *zeros = calloc(remaining, 1);
        if (zeros) {
            fwrite(zeros, 1, remaining, out);
            free(zeros);
        }
    }

    fclose(out);
    free(offsets);

    // Clean up track names
    if (track_names) {
        for (int i = 0; i < num_names; i++) {
            free(track_names[i]);
        }
        free(track_names);
    }

    printf("\nTAV+UCF payload created successfully: %s\n", output_path);
    printf("File size: %zu bytes (TAV header: %d + UCF: %d)\n",
           (size_t)(TAV_HEADER_SIZE + UCF_SIZE), TAV_HEADER_SIZE, UCF_SIZE);
    printf("\nTo create seekable TAV file, prepend this payload to your concatenated TAV file:\n");
    printf("  cat %s input.tav > output_seekable.tav\n", output_path);

    return 0;
}
