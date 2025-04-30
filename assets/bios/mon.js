/*
C O M M A N D S

L (srec literal) : load the s-record into the memory address specified by the s-record. Pointer will also be
                    moved to the specified start address if such field exists; otherwise untouched
J (hex addr) : jump to the program stored in the address
R : execute the code starting from the current pointer
M (hex addr) : shows a byte on the address
N : Increment the memory pointer, then show the byte on the address
W (hex string) : write given byte string to the memory starting from the current pointer. If the length of the
                    hex string is odd, error will be thrown. The pointer will auto-increment.
P : prints current pointer

Prompt on successful: .
Prompt on error: ?

 */


let uhex = (i, t) => (i >>> 0).toString(16).toUpperCase().padStart(t||2, '0').slice(-(t||2))

sys.sleep(256)

println(`/MONITOR/  ${sys.maxmem()} BYTES SYSTEM`)

let prompt = ['?','.']

let P = 0
let pE = undefined

let peek = (p) => {
    // TODO add open bus behaviour
    try {
        return sys.peek(p)
    }
    catch (e) {
        return (p & 0xFFFFFF) >>> 16
    }
}

let printAddr = (P) => {
if (P >= 0)
    print(' $'+(uhex(P, 6))+' : ')
else
    print('-$'+(uhex(-P, 6))+' : ')
}

while (1) {
    print(prompt[+!pE])
    let buf = read().split(' ')
    let cmd = buf[0].toUpperCase()

    let putNinc = b => { if (P >= 0) { sys.poke(P++, b) } else { sys.poke(P--, b) } }
    let getNinc = () => { if (P >= 0) { return sys.peek(P++) } else { return sys.poke(P--) } }

    if ("M" == cmd) {
        let addr = parseInt(buf[1], 16)
        let addr2 = parseInt(buf[2], 16)
        if (Number.isNaN(addr)) {
            printAddr(P)
            println(uhex(peek(P)))
            pE = undefined
        }
        else {
            let oldP = P
            P = addr
            if (Number.isNaN(addr2)) {
                printAddr(P)
                println(uhex(peek(P)))
                pE = undefined
            }
            else if (Math.abs(addr2) <= Math.abs(addr))
                pE = "Range error: end is greater than start"
            else {
                for (let i = 0; i <= Math.abs(addr2) - Math.abs(addr); i++) {
                    if (i % 16 == 0 && i > 0) { println() }
                    if (i % 16 == 0) { printAddr(P) }
                    print(uhex(peek(P)) + ' ')
                    if (addr < 0 && addr2 < 0) { P-- } else { P++ }
                }
                println()
                pE = undefined
            }
            P = oldP
        }
    }
    else if ("N" == cmd) {
        if (P >= 0) { P++ } else { P-- }
        printAddr(P)
        println(uhex(peek(P)))
        pE = undefined
    }
    else if ("J" == cmd) {
        let addr = parseInt(buf[1], 16)
        if (Number.isNaN(addr))
            pE = "Jump address unspecified"
        else {
            P = addr
            pE = undefined
        }
    }
    else if ("P" == cmd) {
        if (P >= 0) {
            println(` ${P} ($${uhex(P, 6)})`)
        }
        else {
            println(` ${P} (-$${uhex(-P, 6)})`)
        }
        pE = undefined
    }
    else if ("W" == cmd) {
        let arg = buf[1]
        if (arg == undefined)
            pE = "No arguments given"
        else {
            let str = buf.slice(1).join('').trim()

            if (str.length % 2 == 1)
                pE = "Length of byte string is odd number"
            else if (str.length == 0)
                pE = "No bytes given"
            else {
                for (let i = 0; i < str.length; i += 2) {
                    let b = parseInt(str.charAt(i)+str.charAt(i+1), 16)
                    putNinc(b)
                }
                pE = undefined
            }
        }
    }
    else if ("R" == cmd) {
        // parse and run CUM image
        // 0xA5 [payload size in 24 bit] [payload]

        let hdr = sys.peek(P)

        if (hdr != 0xA5) {
            pE = "Image is not executable"
        }
        else {
//            try {
                let src = sys.toObjectCode(P)
                pE = new Function(src)()
//            }
//            catch (e) {
//                pE = e
//                serial.printerr(e)
//            }
        }

    }
    else if ('' == cmd) {
        // do nothing
    }
    else if ('?' == cmd) {
        println(pE)
    }
    else {
        pE = "Unknown command"
    }

}
