# Makefile for iPF (TSVM Interchangeable Picture Format) Encoder
# Created by CuriousTorvald and Claude on 2025-12-19.

CC = gcc
CFLAGS = -std=c99 -Wall -Wextra -O2 -D_GNU_SOURCE
DBGFLAGS =
PREFIX = /usr/local

# Zstd flags (use pkg-config if available, fallback for cross-platform compatibility)
ZSTD_CFLAGS = $(shell pkg-config --cflags libzstd 2>/dev/null || echo "")
ZSTD_LIBS = $(shell pkg-config --libs libzstd 2>/dev/null || echo "-lzstd")
LIBS = -lm $(ZSTD_LIBS)

# Targets
TARGETS = encoder_ipf decoder_ipf

# Build all (default)
all: $(TARGETS)

encoder_ipf: encoder_ipf.c
	rm -f encoder_ipf
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -o encoder_ipf encoder_ipf.c $(LIBS)
	@echo "iPF encoder built: encoder_ipf"

decoder_ipf: decoder_ipf.c
	rm -f decoder_ipf
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -o decoder_ipf decoder_ipf.c $(LIBS)
	@echo "iPF decoder built: decoder_ipf"

# Build with debug symbols
debug: CFLAGS += -g -DDEBUG -fsanitize=address -fno-omit-frame-pointer
debug: DBGFLAGS += -fsanitize=address -fno-omit-frame-pointer
debug: clean $(TARGETS)

# Build with optimizations
release: CFLAGS = -std=c99 -Wall -Wextra -O3 -D_GNU_SOURCE -march=native
release: clean $(TARGETS)

# Clean build artifacts
clean:
	rm -f $(TARGETS) *.o

# Install
install: $(TARGETS)
	cp encoder_ipf $(PREFIX)/bin/
	cp decoder_ipf $(PREFIX)/bin/

# Check for required dependencies
check-deps:
	@echo "Checking dependencies..."
	@pkg-config --exists libzstd || (echo "Error: libzstd-dev not found. Install libzstd-dev or equivalent" && exit 1)
	@which ffmpeg >/dev/null 2>&1 || (echo "Error: ffmpeg not found in PATH" && exit 1)
	@which ffprobe >/dev/null 2>&1 || (echo "Error: ffprobe not found in PATH" && exit 1)
	@echo "All dependencies found."

# Help
help:
	@echo "iPF (TSVM Interchangeable Picture Format) Tools"
	@echo ""
	@echo "Targets:"
	@echo "  all          - Build encoder and decoder (default)"
	@echo "  encoder_ipf  - Build encoder only"
	@echo "  decoder_ipf  - Build decoder only"
	@echo "  debug        - Build with debug symbols and AddressSanitizer"
	@echo "  release      - Build with full optimizations"
	@echo "  clean        - Remove build artifacts"
	@echo "  install      - Install to /usr/local/bin"
	@echo "  check-deps   - Check for required dependencies"
	@echo "  help         - Show this help"
	@echo ""
	@echo "Requirements:"
	@echo "  - GCC with C99 support"
	@echo "  - libzstd-dev (Zstd compression library)"
	@echo "  - FFmpeg (for image encoding/decoding)"
	@echo ""
	@echo "Usage:"
	@echo "  make                                          # Build all"
	@echo "  ./encoder_ipf -i input.png -o output.ipf      # Encode"
	@echo "  ./decoder_ipf -i output.ipf -o decoded.png    # Decode"

.PHONY: all clean install check-deps help debug release
