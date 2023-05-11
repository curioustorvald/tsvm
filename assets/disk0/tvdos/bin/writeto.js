if (exec_args[1] === undefined) {
    println("Usage: after a pipe,\n       writeto filename")
    return 0
}

if (!_G.shell.hasPipe()) {
    println("Pipe not opened")
    return 1
}

files.open(_G.shell.resolvePathInput(exec_args[1]).full).swrite(_G.shell.getPipe())