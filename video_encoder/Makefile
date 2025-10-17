# Created by Claude on 2025-08-17.
# Makefile for TSVM Enhanced Video (TEV) encoder

CC = gcc
CXX = g++
CFLAGS = -std=c99 -Wall -Wextra -O2 -D_GNU_SOURCE
CXXFLAGS = -std=c++11 -Wall -Wextra -O2 -D_GNU_SOURCE
LIBS = -lm -lzstd

# OpenCV flags (for TAV encoder with mesh warping)
OPENCV_CFLAGS = $(shell pkg-config --cflags opencv4)
OPENCV_LIBS = $(shell pkg-config --libs opencv4)

# Source files and targets
TARGETS = tev tav tav_decoder
TEST_TARGETS = test_mesh_warp test_mesh_roundtrip

# Build all encoders
all: $(TARGETS)

# Build main encoder
tev: encoder_tev.c
	rm -f encoder_tev
	$(CC) $(CFLAGS) -o encoder_tev $< $(LIBS)

tav: encoder_tav.c encoder_tav_opencv.cpp estimate_affine_from_blocks.cpp
	rm -f encoder_tav encoder_tav.o encoder_tav_opencv.o estimate_affine_from_blocks.o
	$(CC) $(CFLAGS) -c encoder_tav.c -o encoder_tav.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) -c encoder_tav_opencv.cpp -o encoder_tav_opencv.o
	$(CXX) $(CXXFLAGS) -c estimate_affine_from_blocks.cpp -o estimate_affine_from_blocks.o
	$(CXX) -o encoder_tav encoder_tav.o encoder_tav_opencv.o estimate_affine_from_blocks.o $(LIBS) -lfftw3f $(OPENCV_LIBS)

tav_decoder: decoder_tav.c
	rm -f decoder_tav
	$(CC) $(CFLAGS) -o decoder_tav $< $(LIBS)

# Build test programs
test_mesh_warp: test_mesh_warp.cpp encoder_tav_opencv.cpp estimate_affine_from_blocks.cpp
	rm -f test_mesh_warp test_mesh_warp.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) -o test_mesh_warp test_mesh_warp.cpp encoder_tav_opencv.cpp estimate_affine_from_blocks.cpp $(OPENCV_LIBS)

test_mesh_roundtrip: test_mesh_roundtrip.cpp encoder_tav_opencv.cpp
	rm -f test_mesh_roundtrip test_mesh_roundtrip.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) -o test_mesh_roundtrip test_mesh_roundtrip.cpp encoder_tav_opencv.cpp $(OPENCV_LIBS)

tests: $(TEST_TARGETS)

# Build with debug symbols
debug: CFLAGS += -g -DDEBUG
debug: $(TARGETS)

# Clean build artifacts
clean:
	rm -f $(TARGETS) *.o

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
	@pkg-config --exists fftw3f || (echo "Error: libfftw3-dev not found. Install with: sudo apt install libfftw3-dev" && exit 1)
	@pkg-config --exists opencv4 || (echo "Error: OpenCV 4 not found. Install with: sudo apt install libopencv-dev" && exit 1)
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
