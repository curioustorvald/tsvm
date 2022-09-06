if (exec_args[1] === undefined) {
    printerrln("Usage: hexdump <file>")
    return 1;
}

let file = files.open(`${_G.shell.getCurrentDrive()}:/${_G.shell.resolvePathInput(exec_args[1]).string}`)
if (!file.exists) {
    printerrln(_G.shell.resolvePathInput(exec_args[1]).string+": cannot open");
    return 1;
}
let fileContent = file.sread()

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