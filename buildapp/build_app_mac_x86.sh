#!/bin/bash
cd "${0%/*}"
SRCFILES="tbasmac_x86"
DESTDIR="out/TerranBASIC_macOS.x86.app"
RUNTIME="runtime-osx-x86"
# Cleanup
rm -rf $DESTDIR || true
mkdir $DESTDIR
mkdir $DESTDIR/Contents
mkdir $DESTDIR/Contents/MacOS

# Prepare an application
cp icns.png $DESTDIR/.icns
cp $SRCFILES/Info.plist $DESTDIR/Contents/
cp $SRCFILES/TerranBASIC.sh $DESTDIR/Contents/MacOS/
chmod +x $DESTDIR/Contents/MacOS/TerranBASIC.sh

# Copy over a Java runtime
cp -r "../out/$RUNTIME" $DESTDIR/Contents/MacOS/

# Copy over all the assets and a jarfile
cp -r "../out/TerranBASIC.jar" $DESTDIR/Contents/MacOS/

echo "Build successful: $DESTDIR"
