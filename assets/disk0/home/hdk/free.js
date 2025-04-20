if (exec_args[1] === undefined) {
    println("Usage: free ptr_in_hex")
    println("   This will free the pointer loaded using 'load'")
    return 1
}

// check for CUM header
const ptr = parseInt(exec_args[1], 16)
const magic = sys.peek(ptr)

if (magic != 0xA5) return 1


sys.free(ptr)