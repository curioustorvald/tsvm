if (exec_args[1] === undefined) {
    println("Usage: compile myfile")
    println("The compiled file will be myfile.bin")
    return 1
}

_G.shell.execute(`gzip -c ${exec_args[1]} | writeto ${exec_args[1]}.gz`)
_G.shell.execute(`enc ${exec_args[1]}.gz ${exec_args[1]}.bin`)
_G.shell.execute(`rm ${exec_args[1]}.gz`)