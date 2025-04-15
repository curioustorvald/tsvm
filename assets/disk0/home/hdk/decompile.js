if (exec_args[1] === undefined) {
    println("Usage: decompile myfile.bin")
    println("The compiled file will be myfile.bin.js")
    return 1
}
_G.shell.execute(`enc ${exec_args[1]} ${exec_args[1]}.gz`)
_G.shell.execute(`gzip -c -d ${exec_args[1]}.gz | writeto ${exec_args[1]}.js`)
_G.shell.execute(`rm ${exec_args[1]}.gz`)