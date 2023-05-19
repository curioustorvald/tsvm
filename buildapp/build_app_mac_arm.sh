#!/bin/bash
if (( $EUID == 0 )); then echo "The build process is not meant to be run with root privilege, exiting now." >&2; exit 1; fi

cd "${0%/*}"
SRCFILES="tbasmac_arm"
DESTDIR="out/TerranBASIC_macOS.arm.app"
RUNTIME="runtime-osx-arm"
# Cleanup
rm -rf $DESTDIR || true
mkdir $DESTDIR
mkdir $DESTDIR/Contents
mkdir $DESTDIR/Contents/MacOS
mkdir $DESTDIR/Contents/Resources

# Prepare an application
cp AppIcon.icns $DESTDIR/Contents/Resources/AppIcon.icns
cp $SRCFILES/Info.plist $DESTDIR/Contents/
cp $SRCFILES/TerranBASIC.sh $DESTDIR/Contents/MacOS/
chmod +x $DESTDIR/Contents/MacOS/TerranBASIC.sh

# Copy over a Java runtime
cp -r "../out/$RUNTIME" $DESTDIR/Contents/MacOS/

# Copy over all the assets and a jarfile
cp -r "../out/TerranBASIC.jar" $DESTDIR/Contents/MacOS/

echo "Build successful: $DESTDIR"
