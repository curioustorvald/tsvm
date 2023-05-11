function printUsage() {
    println(`Collects files under a directory into a single archive.
Usage: lfs [-c/-x/-t] dest.lfs path\\to\\source
To collect a directory into myarchive.lfs:
       lfs -c myarchive.lfs path\\to\\directory
To extract an archive to path\\to\\my\\files:
       lfs -x myarchive.lfs \\path\\to\\my\\files
To list the collected files:
       lfs -t`)
}

let option = exec_args[1]
const lfsPath = exec_args[2]
const dirPath = exec_args[3]


if (option === undefined || lfsPath === undefined || option.toUpperCase() != "-T" && dirPath === undefined) {
    printUsage()
    return 0
}

option = option.toUpperCase()


function recurseDir(file, action) {
    if (!file.isDirectory) {
        action(file)
    }
    else {
        file.list().forEach(fd => {
            recurseDir(fd, action)
        })
    }

}

const lfsFile = files.open(_G.shell.resolvePathInput(lfsPath).full)
const rootDir = files.open(_G.shell.resolvePathInput(dirPath).full)

const rootDirPathLen = rootDir.fullPath.length

if ("-C" == option) {
    if (!rootDir.exists) {
        printerrln(`No such directory: ${rootDir.fullPath}`)
        return 1
    }

    let out = "TVDOSLFS\x01\x00\x00\x00\x00\x00\x00\x00"

    recurseDir(rootDir, file=>{
        let f = files.open(file.fullPath)
        let flen = f.size
        let fname = file.fullPath.substring(rootDirPathLen + 1)
        let plen = fname.length

        out += "\x01" + String.fromCharCode(
            (plen >>> 8) & 255,
             plen & 255
        )

        out += fname

        out += String.fromCharCode(
            (flen >>> 24) & 255,
            (flen >>> 16) & 255,
            (flen >>> 8) & 255,
             flen & 255
        )

        out += f.sread()
    })

    lfsFile.swrite(out)
}
else if ("T" == option || "-X" == option) {
    if (!lfsFile.exists) {
        printerrln(`No such file: ${lfsFile.fullPath}`)
        return 1
    }


    TODO()

}
else {
    printerrln("Unknown option: " + option)
    return 2
}