#!/bin/bash
if (( $EUID == 0 )); then echo "The build process is not meant to be run with root privilege, exiting now." >&2; exit 1; fi

cd "${0%/*}"
APPIMAGETOOL="appimagetool-x86_64.AppImage"
SRCFILES="tbaslinux_arm"
DESTDIR="TerranBASIC_linux.arm"
RUNTIME="runtime-linux-arm"

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

# Pack everything to AppImage
ARCH=arm_aarch64 "./$APPIMAGETOOL" $DESTDIR "out/$DESTDIR.AppImage" || { echo 'Building AppImage failed' >&2; exit 1; }
chmod +x "out/$DESTDIR.AppImage"
rm -rf $DESTDIR || true
echo "Build successful: $DESTDIR"
