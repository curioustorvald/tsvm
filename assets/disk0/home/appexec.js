const filepath = exec_args[1]

if (!filepath) {
    println(`Usage: appexec path/to/application.app`)
    return 0
}

const file = files.open(_G.shell.resolvePathInput(filepath).full)

if (!file.exists) {
    println("File not found.")
    return 1
}

if (file.isDirectory) {
    println("Not an app file.")
    return 2
}

const filebytes = file.sread()


// check magic
if (filebytes.substring(0,4) != "\x7FApP") {
    println("Not an app file.")
    return 2
}

const endianness = filebytes.charCodeAt(4)
const sectionComp = filebytes.charCodeAt(6)
const sectionCount = filebytes.charCodeAt(7)
const targetOS = filebytes.charCodeAt(8)

const decompFun = (1 == sectionComp) ? (b) => gzip.decomp(b) : (b) => b
const decompToPtrFun = (1 == sectionComp) ? (b, target) => gzip.decompTo(b, target) : TODO()

if (targetOS != 1 && targetOS != 0) {
    println("App is not an TVDOS executable.")
    return 3
}


function strToInt32(str) {
    let s = [...str].map(it=>it.charCodeAt(0))
    return (s[0] << 24) + (s[1] << 16) + (s[2] << 8) + s[3]

}
function makeHash(length) {
	let e = "YBNDRFG8EJKMCPQXOTLVWIS2A345H769"
	let m = e.length
	let s = ""
	for (let i = 0; i < length; i++) {
	    s += e[Math.floor(Math.random()*m)]
	}
    return s
}

const PATH_MOUNT = `$:/TMP/${makeHash(32)}/`

// READ SECTIONS

let sectionTable = []
let rodata = {}

for (let i = 0; i < sectionCount; i++) {
    let sectName = filebytes.substring(16 * (i+1), 16 * (i+1) + 12).trimNull()
    let sectOffset = strToInt32(filebytes.substring(16 * (i+1) + 12, 16 * (i+1) + 16))
    sectionTable.push([sectName, sectOffset])
}

for (let i = 0; i < sectionTable.length - 1; i++) {
    let [sectName, sectOffset] = sectionTable[i]
    let nextSectOffset = sectionTable[i+1][1]

    let uncompLen = strToInt32(filebytes.substring(sectOffset, sectOffset + 4))
    let compPayload = filebytes.substring(sectOffset + 4, nextSectOffset)

    if ("RODATA" == sectName) {
        let rodataPtr = 0
        while (rodataPtr < nextSectOffset - sectOffset) {
            let labelLen = filebytes.charCodeAt(sectOffset + rodataPtr)
            let label = filebytes.substring(sectOffset + rodataPtr + 1, sectOffset + rodataPtr + 1 + labelLen)
            let payloadLen = strToInt32(filebytes.substring(sectOffset + rodataPtr + 1 + labelLen, sectOffset + rodataPtr + 1 + labelLen + 4))
            let uncompLen = strToInt32(filebytes.substring(sectOffset + rodataPtr + 1 + labelLen + 4, sectOffset + rodataPtr + 1 + labelLen + 8))
            let sectPayload = filebytes.substring(sectOffset + rodataPtr + 1 + labelLen + 8, sectOffset + rodataPtr + 1 + labelLen + 8 + payloadLen)


            try {
                let ptr = sys.malloc(uncompLen)
                decompToPtrFun(sectPayload, ptr)
                rodata[label] = ptr
            }
            catch (e) {
                rodata[label] = null
            }

            decompFun(payload)

            rodataPtr += 9 + labelLen + payloadLen
        }
    }
    else if ("TEXT" == sectName) {
        let program = btostr(decompFun(compPayload))

        // inject RODATA map
        let rodataSnippet = `const __RODATA=Object.freeze(${JSON.stringify(rodata)});`

        files.open(PATH_MOUNT + "run.com").swrite(rodataSnippet+program)
    }
    else if ("VDISK" == sectName) {
        let bytes = btostr(decompFun(compPayload))
        // unpack vdisk
        if (bytes.substring(0, 9) != "TVDOSLFS\x01") {
            printerrln("VDISK is not LFS")
            return 2
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
            let filebytes = bytes.substring(curs, curs + filelen)
            files.open(`${PATH_MOUNT}${path}`).swrite(filebytes)
            curs += filelen
        }
    }
}

let errorlevel = _G.shell.execute(PATH_MOUNT + "run.com")

try {
    files.open(PATH_MOUNT).remove()
}
catch (e) {}

return errorlevel
