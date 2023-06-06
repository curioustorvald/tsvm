function seq(s) {
    let out = ""
    let cnt = 0
    let oldchar = s[0]
    for (let char of s) {
        if (char === oldchar) {
            cnt += 1
        }
        else {
            out += ('' + cnt) + oldchar
            cnt = 1
        }
        oldchar = char
    }
    return out + cnt + oldchar
}



let infile = files.open(_G.shell.resolvePathInput(exec_args[1]).full)
let outfile = files.open(_G.shell.resolvePathInput(exec_args[2]).full)
let inBytes = infile.bread(); infile.close()
let outBytes = new Int8Array(inBytes.length)

let key = "00"
let keyBytes = [0x00]
let keyCursor = 0

function getNewKeySeq() {
    key = seq(key)
    keyBytes = []
    keyCursor = 0
    for (let i = 0; i < key.length; i += 2) {
        keyBytes.push(parseInt(key.substring(i, i+2), 16))
    }
}


for (let outcnt = 0; outcnt < inBytes.length; outcnt++) {
    outBytes[outcnt] = inBytes[outcnt] ^ keyBytes[keyCursor++]
    if (keyCursor >= keyBytes.length) {
        getNewKeySeq()
    }
}

outfile.bwrite(outBytes)