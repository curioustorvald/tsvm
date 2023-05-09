function printUsage() {
    println(`Usage: gzip [/d /c] file
To compress a file, replacing it with a gzipped compressed version:
       gzip file.ext
To decompress a file, replacing it with the original uncompressed version:
       gzip /d file.ext.gz
To compress a file specifying the output filename:
       gzip /c file.ext > compressed_file.ext.gz
To decompress a gzipped file specifying the output filename:
       gzip /c /d file.ext.gz > uncompressed_file.ext`)
}

if (exec_args[1] === undefined) {
    printUsage()
    return 0
}