/*
TVDOS Linear File Strip.

Format:

- Header
- FileBlock... (repeatedly appended for every file collected)

# Header

Bytes   "TVDOSLFS\x01" - header
Uint16  Encoding
    00 00 : Pure ASCII/CP437
    01 00..0F : ISO 8859-1..16
    10 00 : UTF-8
    10 01 : UTF-16BE
    10 02 : UTF-16LE
Byte    Flags
    0b 0000 000r
        r: path is relative
Bytes[4] Reserved

# FileBlocks
Uint8    File type (only 1 is used)
Uint16   Length of the Path
Bytes[*] Fully Qualified Path string
Uint32   Length of the binary
Bytes[*] Binary representation of the file, no extra compression (to reduce the size of the archive, gzip the entire LFS
instead of compressing individual files)
 */

function printUsage() {
    println(`Collects files under a directory into a single archive.
Usage: lfs [-c/-x/-t] [-r] dest.lfs path\\to\\source
To collect a directory into myarchive.lfs:
       lfs -c myarchive.lfs path\\to\\directory
To collect a directory into myarchive.lfs, using relative path:
       lfs -c -r myarchive.lfs path\\to\\directory
To extract an archive to path\\to\\my\\files:
       lfs -x myarchive.lfs path\\to\\my\\files
To list the collected files:
       lfs -t myarchive.lfs`)
}

let option = undefined
let useRelative = false
const positional = []
for (let i = 1; i < exec_args.length; i++) {
    const a = exec_args[i]
    if (a === undefined) continue
    const au = a.toUpperCase()
    if (au === "-C" || au === "-X" || au === "-T") option = au
    else if (au === "-R") useRelative = true
    else positional.push(a)
}
const lfsPath = positional[0]
const dirPath = positional[1]

if (option === undefined || lfsPath === undefined || (option != "-T" && dirPath === undefined)) {
    printUsage()
    return 0
}


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

    const flagsByte = useRelative ? 0x01 : 0x00
    let out = "TVDOSLFS\x01\x00\x00" + String.fromCharCode(flagsByte) + "\x00\x00\x00\x00"
    const rootDirPathLen = rootDir.fullPath.length

    recurseDir(rootDir, file=>{
        let f = files.open(file.fullPath)
        let flen = f.size
        let fname = useRelative ? file.fullPath.substring(rootDirPathLen + 1) : file.fullPath
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

    const archiveRelative = (bytes.charCodeAt(11) & 0x01) !== 0

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
            // Fully qualified paths (e.g. "A:\foo\bar.txt") get their drive prefix
            // stripped so the archive contents re-root under the destination dir.
            let subPath = archiveRelative ? path : path.replace(/^[A-Za-z]:[\\\/]?/, "")
            let outfile = files.open(`${rootDir.fullPath}\\${subPath}`)

            mkDirs(files.open(`${outfile.driveLetter}:${outfile.parentPath}`))
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