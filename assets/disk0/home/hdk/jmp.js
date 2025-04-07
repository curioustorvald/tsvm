if (exec_args[1] === undefined) {
    println("Usage: jmp pointer_in_hexadecimal")
    println("   This will execute the binary image stored on the Core Memory at the given pointer.")
    return 1
}


const ptr = parseInt(exec_args[1], 16)
const magic = sys.peek(ptr)

if (magic != 0xA5) return 1

//////////////////////////////////

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

//////////////////////////////////

const payloadSize = (sys.peek(ptr+1) << 16) | (sys.peek(ptr+2) << 8) | sys.peek(ptr+3)

let encrypted = new Int8Array(payloadSize)

// read and decrypt
for (let outcnt = 0; outcnt < payloadSize; outcnt++) {
    encrypted[outcnt] = sys.peek(ptr+4+outcnt) ^ keyBytes[keyCursor++]
    if (keyCursor >= keyBytes.length) {
        getNewKeySeq()
    }
}

let image = gzip.decomp(encrypted)

eval(image)