if (exec_args[1] === undefined) {
    println("Usage: compile -le/-lo myfile.js")
    println("    The compiled and linked file will be myfile.out")
    return 1
}

// with linking
if (exec_args[2]) {
    const filenameWithoutExt = exec_args[2].substringBeforeLast(".")
    const tempFilename = generateRandomHashStr(32)

        _G.shell.execute(`gzip -c ${exec_args[2]} | writeto ${tempFilename}.gz`)
        _G.shell.execute(`enc ${tempFilename}.gz ${tempFilename}.bin`)
        _G.shell.execute(`rm ${tempFilename}.gz`)

        _G.shell.execute(`link -${exec_args[1][2]} ${tempFilename}.bin`)
        _G.shell.execute(`mv ${tempFilename}.out ${filenameWithoutExt}.out`)
        _G.shell.execute(`rm ${tempFilename}.bin`)
}
// with no linking
else {
    const filenameWithoutExt = exec_args[1].substringBeforeLast(".")
    _G.shell.execute(`gzip -c ${exec_args[1]} | writeto ${filenameWithoutExt}.gz`)
    _G.shell.execute(`enc ${filenameWithoutExt}.gz ${filenameWithoutExt}.bin`)
    _G.shell.execute(`rm ${filenameWithoutExt}.gz`)
}
