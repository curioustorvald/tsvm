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
    ;["!BOOTSEC", "AUTOEXEC.BAT"].forEach((name)=>{
        dos.cp(`A:\\tvdos\\installer\\${name}`, `${destDrive}:\\${name}`)
    })
}