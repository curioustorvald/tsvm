# Created by CuriousTorvald and Claude on 2025-08-17.
# Makefile for TSVM Enhanced Video (TEV) encoder and libraries

CC = gcc
CXX = g++
CFLAGS = -std=c99 -Wall -Wextra -Ofast -D_GNU_SOURCE -march=native -mavx512f -mavx512dq -mavx512bw -mavx512vl -Iinclude
CXXFLAGS = -std=c++11 -Wall -Wextra -Ofast -D_GNU_SOURCE -march=native -mavx512f -mavx512dq -mavx512bw -mavx512vl -Iinclude
DBGFLAGS =
PREFIX = /usr/local

# Zstd flags (use pkg-config if available, fallback for cross-platform compatibility)
ZSTD_CFLAGS = $(shell pkg-config --cflags libzstd 2>/dev/null || echo "")
ZSTD_LIBS = $(shell pkg-config --libs libzstd 2>/dev/null || echo "-lzstd")
LIBS = -lm $(ZSTD_LIBS)

# OpenCV flags (for TAV encoder with mesh warping)
OPENCV_CFLAGS = $(shell pkg-config --cflags opencv4)
OPENCV_LIBS = $(shell pkg-config --libs opencv4)

# =============================================================================
# Library Object Files
# =============================================================================

# libtavenc - TAV encoder library
LIBTAVENC_OBJ = lib/libtavenc/tav_encoder_lib.o \
                lib/libtavenc/tav_encoder_color.o \
                lib/libtavenc/tav_encoder_dwt.o \
                lib/libtavenc/tav_encoder_quantize.o \
                lib/libtavenc/tav_encoder_ezbc.o \
                lib/libtavenc/tav_encoder_utils.o \
                lib/libtavenc/tav_encoder_tile.o

# libtavdec - TAV decoder library
LIBTAVDEC_OBJ = lib/libtavdec/tav_video_decoder.o

# libtadenc - TAD encoder library
LIBTADENC_OBJ = lib/libtadenc/encoder_tad.o

# libtaddec - TAD decoder library
LIBTADDEC_OBJ = lib/libtaddec/decoder_tad.o

# =============================================================================
# Targets
# =============================================================================

# Source files and targets
TARGETS = clean libs encoder_tav_ref decoder_tav_ref tav_inspector
TAD_TARGETS = encoder_tad decoder_tad
LIBRARIES = lib/libtavenc.a lib/libtavdec.a lib/libtadenc.a lib/libtaddec.a
TEST_TARGETS = test_mesh_warp test_mesh_roundtrip

# Build all encoders (default)
all: $(TARGETS)

# Build all libraries
libs: $(LIBRARIES)

# Build main encoder
tev: encoder_tev.c
	rm -f encoder_tev
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -o encoder_tev $< $(LIBS)

tav: src/encoder_tav.c lib/libtadenc/encoder_tad.c encoder_tav_opencv.cpp
	rm -f encoder_tav encoder_tav.o encoder_tad.o encoder_tav_opencv.o
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -c src/encoder_tav.c -o encoder_tav.o
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -c lib/libtadenc/encoder_tad.c -o encoder_tad.o
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) $(ZSTD_CFLAGS) -c encoder_tav_opencv.cpp -o encoder_tav_opencv.o
	$(CXX) $(DBGFLAGS) -o encoder_tav encoder_tav.o encoder_tad.o encoder_tav_opencv.o $(LIBS) $(OPENCV_LIBS)

tav_inspector: tav_inspector.c
	rm -f tav_inspector
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -o tav_inspector $< $(LIBS)

tav_dt_decoder: src/decoder_tav_dt.c lib/libtaddec/decoder_tad.c include/decoder_tad.h lib/libtavdec/tav_video_decoder.c include/tav_video_decoder.h
	rm -f decoder_tav_dt decoder_tav_dt.o tav_video_decoder.o decoder_tad.o
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -DTAD_DECODER_LIB -c lib/libtaddec/decoder_tad.c -o decoder_tad.o
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -c lib/libtavdec/tav_video_decoder.c -o tav_video_decoder.o
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -c src/decoder_tav_dt.c -o decoder_tav_dt.o
	$(CC) $(DBGFLAGS) -o decoder_tav_dt decoder_tav_dt.o decoder_tad.o tav_video_decoder.o $(LIBS)

# Build TAD (Terrarum Advanced Audio) tools
encoder_tad: src/encoder_tad_standalone.c lib/libtadenc/encoder_tad.c include/encoder_tad.h
	rm -f encoder_tad encoder_tad_standalone.o encoder_tad.o
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -c lib/libtadenc/encoder_tad.c -o encoder_tad.o
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -c src/encoder_tad_standalone.c -o encoder_tad_standalone.o
	$(CC) $(DBGFLAGS) -o encoder_tad encoder_tad_standalone.o encoder_tad.o $(LIBS)

decoder_tad: lib/libtaddec/decoder_tad.c
	rm -f decoder_tad
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -o decoder_tad $< $(LIBS)

# Build all TAD tools
tad: $(TAD_TARGETS)

# =============================================================================
# Library Build Rules
# =============================================================================

# Compile library object files
lib/libtavenc/%.o: lib/libtavenc/%.c
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -c $< -o $@

lib/libtavdec/%.o: lib/libtavdec/%.c
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -c $< -o $@

lib/libtadenc/%.o: lib/libtadenc/%.c
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -c $< -o $@

lib/libtaddec/%.o: lib/libtaddec/%.c
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -DTAD_DECODER_LIB -c $< -o $@

# Build static libraries
lib/libtavenc.a: $(LIBTAVENC_OBJ)
	ar rcs $@ $^

lib/libtavdec.a: $(LIBTAVDEC_OBJ)
	ar rcs $@ $^

lib/libtadenc.a: $(LIBTADENC_OBJ)
	ar rcs $@ $^

lib/libtaddec.a: $(LIBTADDEC_OBJ)
	ar rcs $@ $^

# =============================================================================
# Test Programs
# =============================================================================

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
debug: CFLAGS += -g -DDEBUG -fsanitize=address
debug: DBGFLAGS += -fsanitize=address
debug: tav_new #$(TARGETS)

# Clean build artifacts
clean:
	rm -f $(TARGETS) $(TAD_TARGETS) $(LIBRARIES) *.o lib/*/*.o

# Install (copy to PATH)
install: $(TARGETS) $(TAD_TARGETS)
	cp encoder_tev $(PREFIX)/bin/
	cp encoder_tav $(PREFIX)/bin/
	cp decoder_tav $(PREFIX)/bin/
	cp encoder_tad $(PREFIX)/bin/
	cp decoder_tad $(PREFIX)/bin/
	cp decoder_tav_dt $(PREFIX)/bin/

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
	@echo "  libs         - Build all codec libraries (.a files)"
	@echo "  tev          - Build the TEV video encoder"
	@echo "  tav          - Build the TAV advanced video encoder"
	@echo "  tad          - Build all TAD audio tools (encoder, decoder)"
	@echo "  encoder_tad  - Build TAD audio encoder"
	@echo "  decoder_tad  - Build TAD audio decoder"
	@echo "  tests        - Build test programs"
	@echo "  debug        - Build with debug symbols"
	@echo "  clean        - Remove build artifacts"
	@echo "  install      - Install to /usr/local/bin"
	@echo "  check-deps   - Check for required dependencies"
	@echo "  help         - Show this help"
	@echo ""
	@echo "Libraries:"
	@echo "  lib/libtavenc.a  - TAV encoder library"
	@echo "  lib/libtavdec.a  - TAV decoder library"
	@echo "  lib/libtadenc.a  - TAD encoder library"
	@echo "  lib/libtaddec.a  - TAD decoder library"
	@echo ""
	@echo "Usage:"
	@echo "  make               # Build video encoders"
	@echo "  make libs          # Build all libraries"
	@echo "  make tev           # Build TEV encoder"
	@echo "  make tav           # Build TAV encoder"
	@echo "  make tad           # Build all TAD audio tools"
	@echo "  sudo make install  # Install all encoders"

.PHONY: all libs clean install check-deps help debug tad tests

# Reference encoder using libtavenc (replaces old monolithic encoder)
encoder_tav_ref: src/encoder_tav.c lib/libtavenc.a lib/libtadenc.a
	rm -f encoder_tav_ref
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -Iinclude -o encoder_tav_ref src/encoder_tav.c lib/libtavenc.a lib/libtadenc.a $(LIBS)
	@echo ""
	@echo "Reference encoder built: encoder_tav_ref"
	@echo "This is the official reference implementation with all features"

# Reference decoder using libtavdec (replaces old monolithic decoder)
decoder_tav_ref: src/decoder_tav.c lib/libtavdec.a lib/libtaddec.a
	rm -f decoder_tav_ref
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -Iinclude -o decoder_tav_ref src/decoder_tav.c lib/libtavdec.a lib/libtaddec.a $(LIBS)
	@echo ""
	@echo "Reference decoder built: decoder_tav_ref"
	@echo "This is the official reference implementation with all features"

