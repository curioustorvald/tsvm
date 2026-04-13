#!/bin/bash
if (( $EUID == 0 )); then echo "The build process is not meant to be run with root privilege, exiting now." >&2; exit 1; fi

cd "${0%/*}"
SRCFILES="tbaswindows_x86"
DESTDIR="TerranBASIC_windows.x86.exe"
RUNTIME="runtime-windows-x86"

# Cleanup
rm -rf $DESTDIR || true
mkdir $DESTDIR

# Prepare an application
cp $SRCFILES/TerranBASIC.bat $DESTDIR/

# Copy over a Java runtime
cp -r "../out/$RUNTIME" $DESTDIR/

# Copy over all the assets and a jarfile
cp -r "../out/TerranBASIC.jar" $DESTDIR/
cp "../lib/compiler-23.1.10.jar" "../lib/compiler-management-23.1.10.jar" "../lib/truffle-compiler-23.1.10.jar" "../lib/truffle-api-23.1.10.jar" "../lib/truffle-runtime-23.1.10.jar" "../lib/polyglot-23.1.10.jar" "../lib/collections-23.1.10.jar" "../lib/word-23.1.10.jar" "../lib/nativeimage-23.1.10.jar" "../lib/jniutils-23.1.10.jar" $DESTDIR/

# Temporary solution: zip everything
zip -r -9 -l "out/$DESTDIR.zip" $DESTDIR
rm -rf $DESTDIR || true
echo "Build successful: $DESTDIR"
