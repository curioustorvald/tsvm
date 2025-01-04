TSVM Hardware Development Kit

Codes in the new computer hardware (e.g. EEPROM) are decrypted, decompressed
then executed, so your program must be minified, compressed, then encrypted to
be runnable, and this entire process is called "compiling".

Do note that this "encryption" is highly insecure; its only purpose is to deter
the casual attempts at cracking.

## From Your Readable Code to Binary

1. The source code is optionally minified. As minifying tool is not provided
   (yet!), external tools must be used.
2. Pass your code to `compile.js` to compress and encrypt the source.
3. Pass the .bin file to the ROM writer to bake your code to the ROM.

## From The Binary to Readable Code

1. Download the code in the ROM to your working computer using ROM reader.
2. Pass your .bin to `decompile.js` to decrypt and uncompress the file.

Note that both processes use `enc.js` internally, so make sure the file exists
on the working directory.
