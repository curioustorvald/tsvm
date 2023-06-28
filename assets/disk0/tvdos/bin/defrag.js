
let drive = _G.shell.getCurrentDrive()
let port = _TVDOS.DRV.FS.SERIAL._toPorts(drive)
    com.sendMessage(port[0], "CLOSE")
for (let i = 0; i < 20; i++) {
    com.sendMessage(port[0], "READCLUST"+i)
    let response = com.getStatusCode(port[0])
    if (response < 0 || response >= 128) {
        throw Error(`Reading cluster #${i} failed with `+response)
    }
    let bytes = com.pullMessage(port[0])
    print(`#${i}\t`)
    for (let k = 0; k < 16; k++) {
        print(bytes.charCodeAt(k).toString(16).padStart(2, '0'))
        print(' ')
    }
    println()
}