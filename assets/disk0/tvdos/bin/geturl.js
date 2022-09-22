let url = exec_args[1]

if (url === undefined) {
    println("geturl: missing URL")
    println("Usage: geturl [URL]")
    return 1
}

let baseurl = url.split('#').head()
baseurl = baseurl.split('?').head()

let filename = baseurl.split('/').last()

// look for network device
let netDrive = undefined
Object.entries(_TVDOS.DRIVEINFO).forEach(([letter, info])=>{
//    println(`${letter} - ${info.name}, ${info.type}`)
    if (!netDrive && info.type == "HTTP")
        netDrive = letter
})

if (!netDrive) {
    println("No Internet-connected network device found.")
    return 1
}

let netfile = files.open(`${netDrive}:/${url.replace("://", ":")}`)
println(`Opening network file ${netfile.fullPath}`)
let savefile = files.open(_G.shell.resolvePathInput(filename).full)

let hostname = url.split('://')[1].split('/').head()

println(`Connecting to ${hostname}...`)
let response = netfile.sread()
if (response == null) {
    println(`Unable to resolve ${hostname}`)
    return 1
}
response = response.trimNull()
if (response.length == 0) {
    println(`The webpage does not exist or has zero length`)
    return 2
}
println(`Length: ${response.length}`)
println(`Saving to '${filename}'`)
savefile.swrite(response)
println(`'${filename}' saved`)