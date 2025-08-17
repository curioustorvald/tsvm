# Created by Claude on 2025-08-17.
# Makefile for TSVM Enhanced Video (TEV) encoder

CC = gcc
CFLAGS = -std=c99 -Wall -Wextra -O2 -D_GNU_SOURCE
LIBS = -lm -lz

# Source files
SOURCES = encoder_tev.c
TARGET = encoder_tev

# Build encoder
$(TARGET): $(SOURCES)
	rm -f $(TARGET)
	$(CC) $(CFLAGS) -o $@ $< $(LIBS)

# Build with debug symbols
debug: CFLAGS += -g -DDEBUG
debug: $(TARGET)

# Clean build artifacts
clean:
	rm -f $(TARGET)

# Install (copy to PATH)
install: $(TARGET)
	cp $(TARGET) /usr/local/bin/

# Check for required dependencies
check-deps:
	@echo "Checking dependencies..."
	@echo "libzstd no longer required - using gzip compression instead"
	@pkg-config --exists zlib || (echo "Error: zlib-dev not found. Install with: sudo apt install zlib1g-dev" && exit 1)
	@echo "All dependencies found."

# Help
help:
	@echo "TSVM Enhanced Video (TEV) Encoder"
	@echo ""
	@echo "Targets:"
	@echo "  encoder_tev  - Build the encoder (default)"
	@echo "  debug        - Build with debug symbols"
	@echo "  clean        - Remove build artifacts"
	@echo "  install      - Install to /usr/local/bin"
	@echo "  check-deps   - Check for required dependencies"
	@echo "  help         - Show this help"
	@echo ""
	@echo "Usage:"
	@echo "  make"
	@echo "  ./encoder_tev input.mp4 -o output.tev"

.PHONY: clean install check-deps help debug
