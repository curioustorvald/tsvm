println("let's install!")


function copyFiles(destDrive) {
    function dir(path) {
        return `${destDrive}:/${path}`
    }

    const dos = _G.shell.coreutils

    dos.mkdir(dir("home"))
    dos.mkdir(dir("tvdos"))
    dos.mkdir(dir("tvdos\\bin"))

    // tvdos/bin
    files.open("A:\\tvdos\\bin").list().forEach((file)=>{
        dos.cp(file.fullPath, `${destDrive}:${file.path}`)
    })

    // tvdos
    ;["gl.js", "TVDOS.SYS", "us_colemak.key", "us_qwerty.key"].forEach((name)=>{
        dos.cp(`A:\\tvdos\\${name}`, `${destDrive}:\\tvdos\\${name}`)
    })

    // bare files in the root dir
    ;["AUTOEXEC.BAT"].forEach((name)=>{
        dos.cp(`A:\\tvdos\\installer\\${name}`, `${destDrive}:\\${name}`)
    })

    // install bootloader
    val bootloader = files.open("A:\\tvdos\\installer\\!BOOTSEC").sread()
    let [port, poru] = _TVDOS.DRV.FS.SERIAL._toPorts(destDrive)[0]
    com.sendMessage(port, "FLUSH");com.sendMessage(port, "CLOSE")
    com.sendMessage(port, `NEWTEVDBOOT,${poru}`) // read-only check will be performed by the other writes
    com.sendMessage(port, bootloader)
    com.sendMessage(port, "FLUSH");com.sendMessage(port, "CLOSE")


}