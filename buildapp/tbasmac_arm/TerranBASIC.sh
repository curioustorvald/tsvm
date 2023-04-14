#!/bin/bash
cd "${0%/*}"
./runtime-osx-arm/bin/java -XstartOnFirstThread -Xms128M -Xmx2G -jar ./TerranBASIC.jar
