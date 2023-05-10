function printUsage() {
    println(`Usage: gzip [-c] [-d] file
To compress a file, replacing it with a gzipped compressed version:
       gzip file.ext
To decompress a file, replacing it with the original uncompressed version:
       gzip -d file.ext.gz
To compress a file specifying the output filename:
       gzip -c file.ext > compressed_file.ext.gz
To decompress a gzipped file specifying the output filename:
       gzip -c -d file.ext.gz > uncompressed_file.ext`)
}

if (exec_args[1] === undefined) {
    printUsage()
    return 0
}

const options = exec_args.filter(it=>it.startsWith("/")).map(it=>it.toUpperCase())
const filePath = exec_args.filter(it=>!it.startsWith("/"))[1]

if (filePath === undefined) {
    printUsage()
    return 0
}

const decompMode = (options.indexOf("-D") >= 0)
const toStdout = (options.indexOf("-C") >= 0)


const file = files.open(_G.shell.resolvePath(filePath).full)

// returns Java byte[]
const actionfun = if (decompMode)
    (str) => gzip.decomp(str)
else
    (str) => gzip.comp(str)


const writefun = if (toStdout)
    (bytes) => print(String.fromCharCode.apply(null, bytes))
else
    (bytes) => file.swrite(String.fromCharCode.apply(null, bytes))


////////////////////////////////////////

writefun(actionfun(file.sread()))
