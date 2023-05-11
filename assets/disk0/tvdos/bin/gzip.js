function printUsage() {
    println(`Compresses or de-compresses (with -D flag) a file in-place, or to stdout if -C flag is set.
Usage: gzip [-c] [-d] file
To compress a file, replacing it with a gzipped compressed version:
       gzip file.ext
To decompress a file, replacing it with the original uncompressed version:
       gzip -d file.ext.gz
To compress a file specifying the output filename:
       gzip -c file.ext | writeto compressed_file.ext.gz
To decompress a gzipped file specifying the output filename:
       gzip -c -d file.ext.gz | writeto uncompressed_file.ext`)
}

if (exec_args[1] === undefined) {
    printUsage()
    return 0
}

const options = exec_args.filter(it=>it.startsWith("-")).map(it=>it.toUpperCase())
const filePath = exec_args.filter(it=>!it.startsWith("-"))[1]


if (filePath === undefined) {
    printUsage()
    return 0
}

const decompMode = (options.indexOf("-D") >= 0)
const toStdout = (options.indexOf("-C") >= 0)


const file = files.open(_G.shell.resolvePathInput(filePath).full)
//const file2 = files.open(_G.shell.resolvePathInput(filePath).full + ".gz")

// returns Java byte[]
const actionfun = (decompMode) ?
    (str) => gzip.decomp(str)
:
    (str) => gzip.comp(str)


const writefun = (toStdout) ?
    (bytes) => print(btostr(bytes))
:
    (bytes) => file.swrite(btostr(bytes))


////////////////////////////////////////

writefun(actionfun(file.bread()))
