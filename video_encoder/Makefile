# Created by Claude on 2025-08-17.
# Makefile for TSVM Enhanced Video (TEV) encoder

CC = gcc
CFLAGS = -std=c99 -Wall -Wextra -O2 -D_GNU_SOURCE
LIBS = -lm -lzstd

# Source files and targets
SOURCES = encoder_tev.c
TARGETS = encoder_tev

# Build all encoders
all: $(TARGETS)

# Build main encoder
encoder_tev: encoder_tev.c
	rm -f encoder_tev
	$(CC) $(CFLAGS) -o $@ $< $(LIBS)

# Default target
$(TARGETS): all

# Build with debug symbols
debug: CFLAGS += -g -DDEBUG
debug: $(TARGETS)

# Clean build artifacts
clean:
	rm -f $(TARGETS)

# Install (copy to PATH)
install: $(TARGETS)
	cp $(TARGETS) /usr/local/bin/

# Check for required dependencies
check-deps:
	@echo "Checking dependencies..."
	@echo "Using Zstd compression for better efficiency"
	@pkg-config --exists libzstd || (echo "Error: libzstd-dev not found. Install with: sudo apt install libzstd-dev" && exit 1)
	@echo "All dependencies found."

# Help
help:
	@echo "TSVM Enhanced Video (TEV) Encoder"
	@echo ""
	@echo "Targets:"
	@echo "  all          - Build both encoders (default)"
	@echo "  encoder_tev  - Build the main TEV encoder"
	@echo "  encoder_tev_xyb - Build the XYB color space encoder"
	@echo "  debug        - Build with debug symbols"
	@echo "  clean        - Remove build artifacts"
	@echo "  install      - Install to /usr/local/bin"
	@echo "  check-deps   - Check for required dependencies"
	@echo "  help         - Show this help"
	@echo ""
	@echo "Usage:"
	@echo "  make         # Build both encoders"
	@echo "  ./encoder_tev input.mp4 -o output.tev"
	@echo "  ./encoder_tev_xyb input.mp4 -o output.tev"

.PHONY: all clean install check-deps help debug
