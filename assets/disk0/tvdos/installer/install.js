println("let's install!")

/* procedure:

CANCELLED_BY_USER :=
    println("Installation of TVDOS was cancelled by the user.")
    exit with errorlevel 1


1. show the list of installable drives. Read-only drives are considered not installable
1.1 if there is at least one installable drives, show the following message:
    select drive to install [B,C,D]:
1.2 else, show the following message:
    No suitable drives were detected for installing TVDOS. The setup program will exit. (exit with errorlevel 2)

2. check if the drive has boot sector. if there is, show message:
    This drive appears to be bootable, which means there might be other operation system on this drive.
    Proceed anyway? [Y/N]:
2.1. if read().trim().toLowercase() is not "y", do CANCELLED_BY_USER

3. show the following message:
    In order to install TVDOS to the drive ${destDrive}, the drive must be wiped clean first.
    THIS PROCESS WILL IRREVERSIBLY DESTROY ALL THE DATA IN THE DRIVE ${destDrive}!
    Type "yes, I consent" to proceed, or type any other text to cancel the installation process:
3.1. if read().trim().toLowercase() is not "yes, i consent" or "yes i consent", do CANCELLED_BY_USER

4. show the following message:
    Enter the new name for the drive that TVDOS will be installed:

5. show the following message:
    The destination disk will be wiped now. Do not turn off the power...

6. formatDrive(destDrive, newName, driveNum)

7. show following message:
    TVDOS will be installed into the drive ${destDrive}...

8. copyFiles(destDrive)

9. show following message
    TVDOS is successfully installed. You may continue using the Live Boot environment.
    To boot from the newly-installed TVDOS, turn off the computer, remove the installation medium, then start the
    computer again. (exit with errorlevel 0)

*/


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

function formatDrive(destDrive, newName, driveNum) {
    let [port, poru] = _TVDOS.DRV.FS.SERIAL._toPorts(destDrive)[0]
    com.sendMessage(port, "FLUSH");com.sendMessage(port, "CLOSE")
    com.sendMessage(port, `TEVDDISCARDDRIVE"${newName}",${poru}`)
    let status = com.getStatusCode(port[0])
    if (status != 0)
        throw Error("Formatting the disk failed: "+status)


}