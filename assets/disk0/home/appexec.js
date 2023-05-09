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


function strToInt48(str) {
    let s = [...str].map(it=>it.charCodeAt(0))
    return ((4294967296 + (s[0] << 40)) + (s[1] << 32) + (s[2] << 24) + (s[3] << 16) + (s[4] << 8) + s[5]) - 4294967296

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
    let sectName = filebytes.substring(16 * (i+1), 16 * (i+1) + 10).trimNull()
    let sectOffset = strToInt48(filebytes.substring(16 * (i+1) + 10, 16 * (i+1) + 16))
    sectionTable.push([sectName, sectOffset])
}

for (let i = 0; i < sectionTable.length - 1; i++) {
    let [sectName, sectOffset] = sectionTable[i]
    let nextSectOffset = sectionTable[i+1][1]

    let uncompLen = strToInt48(filebytes.substring(sectOffset, sectOffset + 6))
    let compPayload = filebytes.substring(sectOffset + 6, nextSectOffset)

    if ("RODATA" == sectName) {
        let rodataPtr = 0
        while (rodataPtr < nextSectOffset - sectOffset) {
            let labelLen = filebytes.charCodeAt(sectOffset + rodataPtr)
            let label = filebytes.substring(sectOffset + rodataPtr + 1, sectOffset + rodataPtr + 1 + labelLen)
            let payloadLen = strToInt48(filebytes.substring(sectOffset + rodataPtr + 1 + labelLen, sectOffset + rodataPtr + 1 + labelLen + 6))
            let uncompLen = strToInt48(filebytes.substring(sectOffset + rodataPtr + 1 + labelLen + 6, sectOffset + rodataPtr + 1 + labelLen + 12))
            let sectPayload = filebytes.substring(sectOffset + rodataPtr + 1 + labelLen + 12, sectOffset + rodataPtr + 1 + labelLen + 12 + payloadLen)


            try {
                let ptr = sys.malloc(uncompLen)
                decompToPtrFun(sectPayload, ptr)
                rodata[label] = ptr
            }
            catch (e) {
                rodata[label] = null
            }

            decompFun(payload)

            rodataPtr += 13 + labelLen + payloadLen
        }
    }
    else if ("TEXT" == sectName) {
        let program = String.fromCharCode.apply(null, decompFun(compPayload))

        // inject RODATA map
        let rodataSnippet = `const __RODATA=Object.freeze(${JSON.stringify(rodata)});`

        files.open(PATH_MOUNT + "run.com").swrite(rodataSnippet+program)
    }
}

let errorlevel = _G.shell.execute(PATH_MOUNT + "run.com")

try {
    files.open(PATH_MOUNT).remove()
}
catch (e) {}

return errorlevel
