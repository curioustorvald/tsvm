let filename = exec_args[1]
let fileContent = undefined
if (filename === undefined && _G.shell.hasPipe()) {
    fileContent = _G.shell.getPipe()
}
else if (filename === undefined) {
    println('Missing filename ("hexdump -?" for help)');
    return 0;
}
else {
    if (filename.startsWith("-?")) {
        println("hexdump <filename>");
        return 0;
    }

    let file = files.open(`${_G.shell.resolvePathInput(filename).full}`)
    if (!file.exists) {
        printerrln(file.fullPath+": cannot open");
        return 1;
    }

    fileContent = file.sread()
}


for (let k = 0; k < fileContent.length; k += 16) {
    for (let i = 0; i < 16; i++) {
        let charCode = fileContent.charCodeAt(k+i)
        if (!isNaN(charCode))
            print(`${charCode.toString(16).toUpperCase().padStart(2, '0')} `)
        else
            print(`   `)
    }
    print('| ')
    for (let i = 0; i < 16; i++) {
        let charCode = fileContent.charCodeAt(k+i)
        if (!isNaN(charCode))
            con.prnch(charCode)
        else
            con.prnch(0)
    }

    println()
}
return 0;