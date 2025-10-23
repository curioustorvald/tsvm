# Created by CuriousTorvald and Claude on 2025-08-17.
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
TAD_TARGETS = encoder_tad decoder_tad
TEST_TARGETS = test_mesh_warp test_mesh_roundtrip

# Build all encoders
all: $(TARGETS)

# Build main encoder
tev: encoder_tev.c
	rm -f encoder_tev
	$(CC) $(CFLAGS) -o encoder_tev $< $(LIBS)

tav: encoder_tav.c encoder_tad.c encoder_tav_opencv.cpp estimate_affine_from_blocks.cpp
	rm -f encoder_tav encoder_tav.o encoder_tad.o encoder_tav_opencv.o
	$(CC) $(CFLAGS) -c encoder_tav.c -o encoder_tav.o
	$(CC) $(CFLAGS) -c encoder_tad.c -o encoder_tad.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) -c encoder_tav_opencv.cpp -o encoder_tav_opencv.o
	$(CXX) -o encoder_tav encoder_tav.o encoder_tad.o encoder_tav_opencv.o $(LIBS) $(OPENCV_LIBS)

tav_decoder: decoder_tav.c
	rm -f decoder_tav
	$(CC) $(CFLAGS) -o decoder_tav $< $(LIBS)

# Build TAD (Terrarum Advanced Audio) tools
encoder_tad: encoder_tad_standalone.c encoder_tad.c encoder_tad.h
	rm -f encoder_tad encoder_tad_standalone.o encoder_tad.o
	$(CC) $(CFLAGS) -c encoder_tad.c -o encoder_tad.o
	$(CC) $(CFLAGS) -c encoder_tad_standalone.c -o encoder_tad_standalone.o
	$(CC) -o encoder_tad encoder_tad_standalone.o encoder_tad.o $(LIBS)

decoder_tad: decoder_tad.c
	rm -f decoder_tad
	$(CC) $(CFLAGS) -o decoder_tad $< $(LIBS)

# Build all TAD tools
tad: $(TAD_TARGETS)

# Build test programs
test_mesh_warp: test_mesh_warp.cpp encoder_tav_opencv.cpp estimate_affine_from_blocks.cpp
	rm -f test_mesh_warp test_mesh_warp.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) -o test_mesh_warp test_mesh_warp.cpp encoder_tav_opencv.cpp estimate_affine_from_blocks.cpp $(OPENCV_LIBS)

test_mesh_roundtrip: test_mesh_roundtrip.cpp encoder_tav_opencv.cpp
	rm -f test_mesh_roundtrip test_mesh_roundtrip.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) -o test_mesh_roundtrip test_mesh_roundtrip.cpp encoder_tav_opencv.cpp $(OPENCV_LIBS)

test_interpolation_comparison: test_interpolation_comparison.cpp encoder_tav_opencv.cpp
	rm -f test_interpolation_comparison test_interpolation_comparison.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) -o test_interpolation_comparison test_interpolation_comparison.cpp encoder_tav_opencv.cpp $(OPENCV_LIBS)

test_bidirectional_prediction: test_bidirectional_prediction.cpp encoder_tav_opencv.cpp
	rm -f test_bidirectional_prediction test_bidirectional_prediction.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) -o test_bidirectional_prediction test_bidirectional_prediction.cpp encoder_tav_opencv.cpp $(OPENCV_LIBS)

test_mpeg_motion: test_mpeg_motion.cpp
	rm -f test_mpeg_motion test_mpeg_motion.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) -o test_mpeg_motion test_mpeg_motion.cpp $(OPENCV_LIBS)

tests: $(TEST_TARGETS)

# Build with debug symbols
debug: CFLAGS += -g -DDEBUG
debug: $(TARGETS)

# Clean build artifacts
clean:
	rm -f $(TARGETS) $(TAD_TARGETS) $(TAD16_TARGETS) $(TAD10_TARGETS) *.o

# Install (copy to PATH)
install: $(TARGETS) $(TAD_TARGETS)
	cp encoder_tev /usr/local/bin/
	cp encoder_tav /usr/local/bin/
	cp decoder_tav /usr/local/bin/
	cp encoder_tad /usr/local/bin/
	cp decoder_tad /usr/local/bin/

# Check for required dependencies
check-deps:
	@echo "Checking dependencies..."
	@pkg-config --exists libzstd || (echo "Error: libzstd-dev not found. Install with: sudo apt install libzstd-dev" && exit 1)
	@pkg-config --exists opencv4 || (echo "Error: OpenCV 4 not found. Install with: sudo apt install libopencv-dev" && exit 1)
	@echo "All dependencies found."

# Help
help:
	@echo "TSVM Enhanced Video (TEV) and Audio (TAD) Encoders"
	@echo ""
	@echo "Targets:"
	@echo "  all          - Build video encoders (default)"
	@echo "  tev          - Build the TEV video encoder"
	@echo "  tav          - Build the TAV advanced video encoder"
	@echo "  tad          - Build all TAD audio tools (encoder, decoder)"
	@echo "  encoder_tad  - Build TAD audio encoder"
	@echo "  decoder_tad  - Build TAD audio decoder"
	@echo "  tad16        - Build TAD16 tools (PCM16 alternative for comparison)"
	@echo "  encoder_tad16- Build TAD16 audio encoder (PCM16 version)"
	@echo "  decoder_tad16- Build TAD16 audio decoder (PCM16 version)"
	@echo "  tad10        - Build TAD10 tools (PCM10 alternative for comparison)"
	@echo "  encoder_tad10- Build TAD10 audio encoder (PCM10 version)"
	@echo "  decoder_tad10- Build TAD10 audio decoder (PCM10 version)"
	@echo "  debug        - Build with debug symbols"
	@echo "  clean        - Remove build artifacts"
	@echo "  install      - Install to /usr/local/bin"
	@echo "  check-deps   - Check for required dependencies"
	@echo "  help         - Show this help"
	@echo ""
	@echo "Usage:"
	@echo "  make               # Build video encoders"
	@echo "  make tev           # Build TEV encoder"
	@echo "  make tav           # Build TAV encoder"
	@echo "  make tad           # Build all TAD audio tools"
	@echo "  make tad16         # Build TAD16 tools (for comparison testing)"
	@echo "  make tad10         # Build TAD10 tools (for comparison testing)"
	@echo "  sudo make install  # Install all encoders"

.PHONY: all clean install check-deps help debug tad tad16 tad10
