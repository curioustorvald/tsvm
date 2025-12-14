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

# libfec - Forward Error Correction library (LDPC + Reed-Solomon)
LIBFEC_OBJ = lib/libfec/ldpc.o lib/libfec/reed_solomon.o

# =============================================================================
# Targets
# =============================================================================

# Source files and targets
TARGETS = libs encoder_tav_ref decoder_tav_ref tav_inspector tad tav_dt
LIBRARIES = lib/libtavenc.a lib/libtavdec.a lib/libtadenc.a lib/libtaddec.a lib/libfec.a
TAV_TARGETS = encoder_tav_ref decoder_tav_ref tav_inspector
TAD_TARGETS = encoder_tad decoder_tad
DT_TARGETS = encoder_tav_dt decoder_tav_dt tavdt_noise_injector

# Build all encoders (default)
all: clean $(TARGETS)

# Build all libraries
libs: $(LIBRARIES)

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

tav_inspector: tav_inspector.c
	rm -f tav_inspector
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -o tav_inspector $< $(LIBS)

tav: $(TAV_TARGETS)

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

lib/libfec/%.o: lib/libfec/%.c
	$(CC) $(CFLAGS) -Ilib/libfec -c $< -o $@

# Build static libraries
lib/libtavenc.a: $(LIBTAVENC_OBJ)
	ar rcs $@ $^

lib/libtavdec.a: $(LIBTAVDEC_OBJ)
	ar rcs $@ $^

lib/libtadenc.a: $(LIBTADENC_OBJ)
	ar rcs $@ $^

lib/libtaddec.a: $(LIBTADDEC_OBJ)
	ar rcs $@ $^

lib/libfec.a: $(LIBFEC_OBJ)
	ar rcs $@ $^

# =============================================================================
# TAV-DT (Digital Tape) Encoder/Decoder
# =============================================================================

# TAV-DT encoder with FEC (multithreaded)
encoder_tav_dt: src/encoder_tav_dt.c lib/libtavenc.a lib/libtadenc.a lib/libfec.a
	rm -f encoder_tav_dt
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -Iinclude -Ilib/libfec -o encoder_tav_dt src/encoder_tav_dt.c lib/libtavenc.a lib/libtadenc.a lib/libfec.a $(LIBS) -lpthread
	@echo ""
	@echo "TAV-DT encoder built: encoder_tav_dt"
	@echo "Digital Tape format with LDPC and Reed-Solomon FEC (multithreaded)"

# TAV-DT decoder with FEC (multithreaded)
decoder_tav_dt: src/decoder_tav_dt.c lib/libtavdec.a lib/libtaddec.a lib/libfec.a
	rm -f decoder_tav_dt
	$(CC) $(CFLAGS) $(ZSTD_CFLAGS) -Iinclude -Ilib/libfec -o decoder_tav_dt src/decoder_tav_dt.c lib/libtavdec.a lib/libtaddec.a lib/libfec.a $(LIBS) -lpthread
	@echo ""
	@echo "TAV-DT decoder built: decoder_tav_dt"
	@echo "Digital Tape format with LDPC and Reed-Solomon FEC (multithreaded)"

# TAV-DT noise injector (channel simulator)
tavdt_noise_injector: tavdt_noise_injector.c
	rm -f tavdt_noise_injector
	$(CC) -std=c99 -Wall -O2 -D_GNU_SOURCE -o tavdt_noise_injector tavdt_noise_injector.c -lm
	@echo ""
	@echo "TAV-DT noise injector built: tavdt_noise_injector"
	@echo "Simulates QPSK satellite channel noise (AWGN + burst)"

# Build all TAV-DT tools
tav_dt: $(DT_TARGETS)

# Build with debug symbols
debug: CFLAGS += -g -DDEBUG -fsanitize=address -fno-omit-frame-pointer
debug: DBGFLAGS += -fsanitize=address -fno-omit-frame-pointer
debug: clean $(TARGETS)

# Clean build artifacts
clean:
	rm -f $(TARGETS) $(TAD_TARGETS) $(DT_TARGETS) $(LIBRARIES) *.o lib/*/*.o

# Install (copy to PATH)
install: $(TARGETS)
	cp encoder_tav_ref $(PREFIX)/bin/
	cp decoder_tav_ref $(PREFIX)/bin/
	cp encoder_tad $(PREFIX)/bin/
	cp decoder_tad $(PREFIX)/bin/
	cp encoder_tav_dt $(PREFIX)/bin/
	cp decoder_tav_dt $(PREFIX)/bin/
	cp tav_inspector $(PREFIX)/bin/

# Check for required dependencies
check-deps:
	@echo "Checking dependencies..."
	@pkg-config --exists libzstd || (echo "Error: libzstd-dev not found. Install with: sudo apt install libzstd-dev" && exit 1)
	@echo "All dependencies found."

# Help
help:
	@echo "TSVM Advanced Video (TAV) and Audio (TAD) Encoders"
	@echo ""
	@echo "Targets:"
	@echo "  all          - Build video encoders (default)"
	@echo "  libs         - Build all codec libraries (.a files)"
	@echo "  tav          - Build the TAV advanced video encoder"
	@echo "  tav_dt       - Build all TAV-DT (Digital Tape) tools with FEC"
	@echo "  tavdt_noise_injector - Build TAV-DT channel noise simulator"
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
	@echo "  lib/libfec.a     - Forward Error Correction library (LDPC + RS)"
	@echo ""
	@echo "Usage:"
	@echo "  make               # Build video encoders"
	@echo "  make libs          # Build all libraries"
	@echo "  make tav           # Build TAV encoder"
	@echo "  make tav_dt        # Build TAV-DT encoder/decoder with FEC"
	@echo "  make tad           # Build all TAD audio tools"
	@echo "  sudo make install  # Install all encoders"

.PHONY: all libs clean install check-deps help debug tad tav_dt tests
