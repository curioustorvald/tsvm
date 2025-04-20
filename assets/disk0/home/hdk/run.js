if (exec_args[1] === undefined) {
    println("Usage: run pointer_in_hexadecimal <optional args>")
    println("   This will execute the binary image stored on the Core Memory at the given pointer.")
    return 1
}


const ptr = parseInt(exec_args[1], 16)
const magic = sys.peek(ptr)

if (magic != 0xA5) return 1


const source = sys.toObjectCode(ptr)
const wrapper = new Function("exec_args", `const g={exec_args};with(g){${source}}`);
const newArgs = ["@ptr:"+ptr].concat(exec_args.slice(2))

wrapper(newArgs)