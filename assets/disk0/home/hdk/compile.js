if (exec_args[1] === undefined) {
    println("Usage: compile myfile.js")
    println("The compiled file will be myfile.bin")
    return 1
}
const filenameWithoutExt = exec_args[1].substringBeforeLast(".")
_G.shell.execute(`gzip -c ${exec_args[1]} | writeto ${filenameWithoutExt}.gz`)
_G.shell.execute(`enc ${filenameWithoutExt}.gz ${filenameWithoutExt}.bin`)
_G.shell.execute(`rm ${filenameWithoutExt}.gz`)