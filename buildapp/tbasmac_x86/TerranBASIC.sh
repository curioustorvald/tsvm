#!/bin/bash
cd "${0%/*}"
./runtime-osx-x86/bin/java -XstartOnFirstThread -Xms128M -Xmx2G -jar ./TerranBASIC.jar
