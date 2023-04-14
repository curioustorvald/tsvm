#!/bin/bash
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

# Temporary solution: zip everything
zip -r -9 -l "out/$DESTDIR.zip" $DESTDIR
rm -rf $DESTDIR || true
echo "Build successful: $DESTDIR"
