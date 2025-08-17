#!/bin/bash
# Created by Claude on 2025-08-17.
# Build script for TSVM Enhanced Video (TEV) encoder

set -e

echo "Building TSVM Enhanced Video (TEV) Encoder..."

# Check for required dependencies
echo "Checking dependencies..."

# Check for zstd development library
if ! pkg-config --exists libzstd; then
    echo "Error: libzstd development library not found"
    echo "Please install it with one of these commands:"
    echo "  Ubuntu/Debian: sudo apt install libzstd-dev"
    echo "  CentOS/RHEL:   sudo yum install libzstd-devel"
    echo "  openSUSE:      sudo zypper install libzstd-devel"
    echo "  macOS:         brew install zstd"
    exit 1
fi

# Check for zlib development library
if ! pkg-config --exists zlib; then
    echo "Error: zlib development library not found"
    echo "Please install it with one of these commands:"
    echo "  Ubuntu/Debian: sudo apt install zlib1g-dev"
    echo "  CentOS/RHEL:   sudo yum install zlib-devel"
    echo "  openSUSE:      sudo zypper install zlib-devel"
    echo "  macOS:         brew install zlib"
    exit 1
fi

# Check for FFmpeg (required for video processing)
if ! command -v ffmpeg &> /dev/null; then
    echo "Warning: FFmpeg not found. It's required for video input processing."
    echo "Please install FFmpeg:"
    echo "  Ubuntu/Debian: sudo apt install ffmpeg"
    echo "  CentOS/RHEL:   sudo yum install ffmpeg"
    echo "  openSUSE:      sudo zypper install ffmpeg"
    echo "  macOS:         brew install ffmpeg"
fi

echo "Dependencies OK."

# Build the encoder
echo "Compiling encoder..."
make clean
make

if [ -f "encoder_tev" ]; then
    echo "✓ Build successful!"
    echo ""
    echo "Usage:"
    echo "  ./encoder_tev input.mp4 -o output.tev"
    echo "  ./encoder_tev --help"
    echo ""
    echo "To install system-wide:"
    echo "  sudo make install"
else
    echo "✗ Build failed!"
    exit 1
fi