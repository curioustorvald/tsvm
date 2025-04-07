if (exec_args[1] === undefined) {
    println("Usage: jmp pointer_in_hexadecimal")
    println("   This will execute the binary image stored on the Core Memory at the given pointer.")
    return 1
}


const ptr = parseInt(exec_args[1], 16)
const magic = sys.peek(ptr)

if (magic != 0xA5) return 1

eval(sys.toObjectCode(ptr))