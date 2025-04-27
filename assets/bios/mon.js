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

Prompt on successful: .
Prompt on error: ?

 */


let uhex = (i, len) => { return (i >>> 0).toString(16).toUpperCase().padStart(len||2, '0').slice(-(len||2)) }

println(`/MONITOR/  ${sys.maxmem()} BYTES SYSTEM`)

let prompt = ['?','.']

let mode = "M"
let ptr = 0
let previousError = undefined

while (1) {
    print(prompt[+!previousError])
    let buf = read().split(' ')
    let cmd = buf[0].toUpperCase()

    if ("M" == cmd) {
        let addr = parseInt(buf[1], 16)
        let addr2 = parseInt(buf[2], 16)
        if (Number.isNaN(addr)) {
            println((uhex(ptr, 4))+' : '+uhex(sys.peek(ptr)))
            previousError = undefined
        }
        else {
            let oldptr = ptr
            ptr = addr
            if (Number.isNaN(addr2)) {
                println(uhex(sys.peek(ptr)))
                previousError = undefined
            }
            else if (Math.abs(addr2) <= Math.abs(addr))
                previousError = "Range error: end is greater than start"
            else {
                for (let i = 0; i <= Math.abs(addr2) - Math.abs(addr); i++) {
                    if (i % 16 == 0 && i > 0) { println() }
                    if (i % 16 == 0) { print((uhex(ptr, 4))+' : ') }
                    print(uhex(sys.peek(ptr)) + ' ')
                    if (addr < 0 && addr2 < 0) { ptr-- } else { ptr++ }
                }
                println()
                previousError = undefined
            }
            ptr = oldptr
        }
    }
    else if ("N" == cmd) {
        ptr++
        println((uhex(ptr, 4))+' : '+uhex(sys.peek(ptr)))
        previousError = undefined
    }
    else if ("J" == cmd) {
        let addr = parseInt(buf[1], 16)
        if (Number.isNaN(addr))
            previousError = "Jump address unspecified"
        else {
            ptr = addr
            previousError = undefined
        }
    }
    else if ("W" == cmd) {
        let arg = buf[1]
        if (arg == undefined)
            previousError = "No arguments given"
        else if (arg.length % 2 == 1)
            previousError = "Length of byte string is odd number"
        else {
            for (let i = 0; i < arg.length; i += 2) {
                let b = parseInt(arg.charAt(i)+arg.charAt(i+1), 16)
                sys.poke(ptr++, b)
            }
            previousError = undefined
        }
    }
    else if ('' == cmd) {
        // do nothing
    }
    else if ('?' == cmd) {
        println(previousError)
    }
    else {
        previousError = "Unknown command"
    }

}
