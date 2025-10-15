# Created by Claude on 2025-08-17.
# Makefile for TSVM Enhanced Video (TEV) encoder

CC = gcc
CFLAGS = -std=c99 -Wall -Wextra -O2 -D_GNU_SOURCE
LIBS = -lm -lzstd

# Source files and targets
TARGETS = tev tav tav_decoder

# Build all encoders
all: $(TARGETS)

# Build main encoder
tev: encoder_tev.c
	rm -f encoder_tev
	$(CC) $(CFLAGS) -o encoder_tev $< $(LIBS)

tav: encoder_tav.c
	rm -f encoder_tav
	$(CC) $(CFLAGS) -o encoder_tav $< $(LIBS) -lfftw3f

tav_decoder: decoder_tav.c
	rm -f decoder_tav
	$(CC) $(CFLAGS) -o decoder_tav $< $(LIBS)

# Build with debug symbols
debug: CFLAGS += -g -DDEBUG
debug: $(TARGETS)

# Clean build artifacts
clean:
	rm -f $(TARGETS)

# Install (copy to PATH)
install: $(TARGETS)
	cp encoder_tev /usr/local/bin/
	cp encoder_tav /usr/local/bin/
	cp decoder_tav /usr/local/bin/

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
	@echo "  tev          - Build the main TEV encoder"
	@echo "  tav          - Build the advanced TAV encoder"
	@echo "  debug        - Build with debug symbols"
	@echo "  clean        - Remove build artifacts"
	@echo "  install      - Install to /usr/local/bin"
	@echo "  check-deps   - Check for required dependencies"
	@echo "  help         - Show this help"
	@echo ""
	@echo "Usage:"
	@echo "  make               # Build both encoders"
	@echo "  make tev           # Build TEV encoder"
	@echo "  make tav           # Build TAV encoder"
	@echo "  sudo make install  # Install both encoders"

.PHONY: all clean install check-deps help debug
