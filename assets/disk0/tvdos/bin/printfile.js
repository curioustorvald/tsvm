const COL_LNUMBACK = 18
const COL_LNUMFORE = 253

let filename = undefined

if (exec_args !== undefined && exec_args[1] !== undefined) {
    filename = exec_args[1]
}
else {
    println("File to print out?")
    filename = read()
}
let driveLetter = _G.shell.getCurrentDrive()
let filePath = _G.shell.getPwdString() + filename

let file = files.open(`${driveLetter}:${filePath}`)

if (!file.exists) {
    printerrln("File not found")
    return 1
}

let textbuffer = file.sread().split("\n")

function drawLineNumber(lnum) {
    con.curs_set(0)
    con.color_pair(COL_LNUMFORE, COL_LNUMBACK)

    if (lnum < 1 || lnum - 1 >= textbuffer.length) print('    ')
    else if (lnum >= 10000) print(`${String.fromCharCode(64+lnum/10000)}${(""+lnum%10000).padStart(4,'0')}`)
    else if (lnum >= 1000) print(`${lnum}`)
    else if (lnum >= 100) print(`${lnum} `)
    else if (lnum >= 10) print(` ${lnum} `)
    else print(`  ${lnum} `)
}

textbuffer.forEach((line,i) => {
    drawLineNumber(i + 1)
    con.reset_graphics()
    print(' ')
    println(line)
})

return 0