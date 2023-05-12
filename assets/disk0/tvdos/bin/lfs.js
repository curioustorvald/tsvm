function printUsage() {
    println(`Collects files under a directory into a single archive.
Usage: lfs [-c/-x/-t] dest.lfs path\\to\\source
To collect a directory into myarchive.lfs:
       lfs -c myarchive.lfs path\\to\\directory
To extract an archive to path\\to\\my\\files:
       lfs -x myarchive.lfs \\path\\to\\my\\files
To list the collected files:
       lfs -t myarchive.lfs`)
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
function mkDirs(fd) {
    let parent = files.open(`${fd.driveLetter}:${fd.parentPath}\\`)
    if (parent.exists) fd.mkDir()
    else mkDirs(parent)
}

const lfsFile = files.open(_G.shell.resolvePathInput(lfsPath).full)
const rootDir = ("-T" == option) ? undefined : files.open(_G.shell.resolvePathInput(dirPath).full)

if ("-C" == option) {
    if (!rootDir.exists) {
        printerrln(`No such directory: ${rootDir.fullPath}`)
        return 1
    }

    let out = "TVDOSLFS\x01\x00\x00\x00\x00\x00\x00\x00"
    const rootDirPathLen = rootDir.fullPath.length

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
else if ("-T" == option || "-X" == option) {
    if (!lfsFile.exists) {
        printerrln(`No such file: ${lfsFile.fullPath}`)
        return 1
    }

    const bytes = lfsFile.sread()
    if (bytes.substring(0, 9) != "TVDOSLFS\x01") {
        printerrln("File is not LFS")
        return 2
    }

    if ("-X" == option && !rootDir.exists) {
        rootDir.mkDir()
    }

    let curs = 16
    while (curs < bytes.length) {
        let fileType = bytes.charCodeAt(curs)
        let pathlen = (bytes.charCodeAt(curs+1) << 8) | bytes.charCodeAt(curs+2)
        curs += 3
        let path = bytes.substring(curs, curs + pathlen)
        curs += pathlen
        let filelen = (bytes.charCodeAt(curs) << 24) | (bytes.charCodeAt(curs+1) << 16) | (bytes.charCodeAt(curs+2) << 8) | bytes.charCodeAt(curs+3)
        curs += 4

        if ("-X" == option) {
            let filebytes = bytes.substring(curs, curs + filelen)
            let outfile = files.open(`${rootDir.fullPath}\\${path}`)

            mkDirs(files.open(`${rootDir.driveLetter}:${files.open(`${rootDir.fullPath}\\${path}`).parentPath}`))
            outfile.mkFile()
            outfile.swrite(filebytes)
        }
        else if ("-T" == option) {
            println(`${filelen}\t${path}`)
        }

        curs += filelen
    }
}
else {
    printerrln("Unknown option: " + option)
    return 2
}