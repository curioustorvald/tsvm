const fullFilePath = _G.shell.resolvePathInput(exec_args[1])

let seqread = undefined
let fullFilePathStr = fullFilePath.full
let mode = ""

// Select seqread driver to use
if (fullFilePathStr.startsWith('$:/TAPE') || fullFilePathStr.startsWith('$:\\TAPE')) {
    seqread = require("seqreadtape")
    seqread.prepare(fullFilePathStr)
    seqread.seek(0)
    mode = "tape"
} else {
    seqread = undefined
}


if ("tape" == mode) {
    const prg = seqread.readString(65536)
    eval(prg)
}