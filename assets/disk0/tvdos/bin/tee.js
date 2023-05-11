if (exec_args[1] === undefined) {
    println("Usage: after a pipe,\n       tee filename")
    return 0
}

if (!_G.shell.hasPipe()) {
    println("Pipe not opened")
    return 1
}

let txt = _G.shell.getPipe()
files.open(_G.shell.resolvePathInput(exec_args[1]).full).swrite(txt)
print(txt)