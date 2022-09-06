if (exec_args[1] === undefined) {
    println("TOUCH - TVDOS file date and time setting utility");
    println()
    println("SYNOPSIS")
    println("    TOUCH [/C] path")
    println()
    println("/C   = don't create files that do not already exist")
    return 1;
}

let path = _G.shell.resolvePathInput(exec_args[2] || exec_args[1]).string;
let driveLetter = _G.shell.getCurrentDrive();
let noNewFile = (exec_args[1] == "/c" || exec_args[1] == "/C");
let file = files.open(`${driveLetter}:/${path}`)
if (!file.exists) {
    printerrln("TOUCH: Can't open "+file.fullPath+" due to IO error");
    return 1;
}

if (!noNewFile) {
    file.mkFile()
}

let touched = file.touch()
if (!touched) {
    printerrln("TOUCH: Can't touch "+file.fullPath+" due to IO error");
    return 2;
}

return 0;