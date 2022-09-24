let fout = files.open("$:/FBIPF")
let fin = files.open(_G.shell.resolvePathInput(exec_args[1]).full)

let ipfRead = fin.bread()
println(`Input file: ${ipfRead.length} bytes`)

fout.bwrite(ipfRead)

fin.close()
fout.close()
