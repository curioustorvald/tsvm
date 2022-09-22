let f = files.open("A:/tvdos/bin")

//f.driveLetter = "Z"


println(`File path: ${f.path}`)
println(`FS driver: ${f.driverID}`)
println(`DrvLetter: ${f.driveLetter}`)
println(`Parent: ${f.parentPath}`)
println(`Size: ${f.size}`)



println(`List of files:`)
let ls = f.list()
ls.forEach(it=>{
    println(`${it.path}\t${it.name}\t${it.size}`)
})

println(`Size again: ${f.size}`)