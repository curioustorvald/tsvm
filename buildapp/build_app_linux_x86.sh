#!/bin/bash
if (( $EUID == 0 )); then echo "The build process is not meant to be run with root privilege, exiting now." >&2; exit 1; fi

cd "${0%/*}"
APPIMAGETOOL="appimagetool-x86_64.AppImage"
SRCFILES="tbaslinux_x86"
DESTDIR="TerranBASIC_linux.x86"
RUNTIME="runtime-linux-x86"

# Cleanup
rm -rf $DESTDIR || true
mkdir $DESTDIR

# Prepare an application
cp icns.png $DESTDIR/icns.png
cp $SRCFILES/TerranBASIC.desktop $DESTDIR/
cp $SRCFILES/AppRun $DESTDIR/AppRun
chmod +x $DESTDIR/AppRun

# Copy over a Java runtime
cp -r "../out/$RUNTIME" $DESTDIR/

# Copy over all the assets and a jarfile
cp -r "../out/TerranBASIC.jar" $DESTDIR/
cp "../lib/compiler-23.1.10.jar" "../lib/compiler-management-23.1.10.jar" "../lib/truffle-compiler-23.1.10.jar" "../lib/truffle-api-23.1.10.jar" "../lib/truffle-runtime-23.1.10.jar" "../lib/polyglot-23.1.10.jar" "../lib/collections-23.1.10.jar" "../lib/word-23.1.10.jar" "../lib/nativeimage-23.1.10.jar" "../lib/jniutils-23.1.10.jar" $DESTDIR/

# Pack everything to AppImage
"./$APPIMAGETOOL" $DESTDIR "out/$DESTDIR.AppImage" || { echo 'Building AppImage failed' >&2; exit 1; }
chmod +x "out/$DESTDIR.AppImage"
rm -rf $DESTDIR || true
echo "Build successful: $DESTDIR"
