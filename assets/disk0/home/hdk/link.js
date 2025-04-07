if (exec_args[1] === undefined || exec_args[2] === undefined) {
    println("Usage: link -e/-o myfile.bin")
    println("   This will produce generic [E]xecutable/[O]bject code that will be loaded dynamically in the Core Memory")
    println("Usage: link -e/-o myfile.bin -a 1e00")
    println("   This will produce [E]xecutable/[O]bject code that will be loaded at memory address 1E00h")
    return 1
}

let infilePath = _G.shell.resolvePathInput(exec_args[2]).full
let infile = files.open(infilePath)
let outfile = files.open(infilePath + ".out")
let outMode = exec_args[1].toLowerCase()

let type = {
    "-r": "\x01",
    "-e": "\x02",
    "-o": "\x03",
    "-c": "\x04"
}

function toI32(num) {
    const buffer = new ArrayBuffer(4)
    const view = new DataView(buffer)
    view.setInt32(0, num, false)
    return Array.from(new Uint8Array(buffer))
}

function toI24(num) {
    return toI32(num).slice(-3)
}

function i32ToI24(int) {
    return int.slice(-3)
}

let addr = 0
if (exec_args[3] !== undefined && exec_args[3].toLowerCase() == "-a" && exec_args[4] !== undefined)
    addr = parseInt(exec_args[4], 16)

outfile.sappend("\x20\xC0\xCC\x0A")
outfile.sappend(type[outMode] || "\x00")
outfile.bappend(toI24(addr))
outfile.bappend(toI32(infile.size))
outfile.sappend(infile.sread())

infile.close()
outfile.close()

return 0