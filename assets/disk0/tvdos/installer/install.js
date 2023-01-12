const win = require("wintex")
const [HEIGHt, WIDTH] = con.getmaxyx()

println("let's install!")

/* procedure:

CANCELLED_BY_USER :=
    Untick all sidebar
    title: Abort Installation
    message: Installation of TVDOS was cancelled by the user.
    with button: Quit
    on button Quit: exit with errorlevel 1

NO_SUITABLE_TARGET :=
    Untick all sidebar
    title: Unable to Install
    message: Your system appears to not have a suitable disk for TVDOS installation. Please shut off the power, insert/plug the disk then restart the computer and the installer.
    with button: Quit
    on button Quit: exit with errorlevel 127

Sidebar and Chapter Title :=
    [] Welcome - License Agreement
    [] Customisation - User Interface
    [] Disk - Installation Target
    [] Summary - Installation Settings
    [] Installation - Perform Installation

var USER_INTERFACE; // "zfm" or "cmd"

0. Probe all suitable installation candidates
0.1 If there is none, do NO_SUITABLE_TARGET
    else, proceed to next step


1. Chapter Welcome
    show wall of text: <COPYING>
    with button: Abort, [], Next
    on Abort: do CANCELLED_BY_USER


2. Chapter Customisation
    message: Select the default user interface your new system will have. You can change the configuration any time after the installation.
    button1:
        title: Z File Manager (emph with same goldenrod colour as the focused window frame)
        desc: Text-based Graphical Interface for navigating the system using arrow keys
    button2:
        title: Command-line Interface (emph with same goldenrod colour as the focused window frame)
        desc: Traditional DOS experience. Black screen, blinking cursor
    with button: Abort, Back Next.
    on Abort: do CANCELLED_BY_USER
    on Next with button1: set USER_INTERFACE to "zfm"
    on Next with button2: set USER_INTERFACE to "cmd"


3. Chapter Disk
    message: Choose the disk to install TVDOS.
             Selected disk will be cleared only on the actual Installation step.
    show buttons on grid arrangement. use template:
        title: <drive letter>: // A:  B:  C:  etc
        desc:
            if clean: This disk is clear
                      Total <disk size> bytes
            if has bootsector: This disk has bootsector
                               Used <used size> bytes/Total <disk size> bytes
            if has files: This disk has files on it
                          Used <used size> bytes/Total <disk size> bytes
        with button: Abort, Back, Next
        on Abort: do CANCELLED_BY_USER
        on Next with non-clean disk selected: show popup
            heading: Warning
            title: Selected disk will be wiped clean and any files on it will be lost permanently. Proceed with installation?
            with button: Cancel, Proceed
            on Cancel: go back to disk selection
            on Proceed: go to next step


4. Chapter Summary
    message: This is the overview of the installation. Read carefully before clicking Next.
    show wall of text:
        Booting
            - on Drive <drive letter>:

        Environment
            - start system with <program>  (program := if USER_INTERFACE is zfm, "Z File Manager"; is cmd, "Command Line Interface")
            - Size of packages to install: <filesize> kB

    with button: Abort, Back, Next
    on Abort: do CANCELLED_BY_USER


5. Chapter Installation
5.1 Disk Clear
    message: Disk is being cleared, do not turn off the power
    formatDrive(destDrive, "TVDOS", driveNum)
5.2 Copy Files
    message: Installing TVDOS...
    copyFiles(destDrive)


6. Still on Chapter Installtion but change title: Installation Was Successful
    message: TVDOS is successfully installed. You may continue using the Live Boot environment.
             To boot from the new disk, turn off the computer, remove the installation medium, then restart the computer.
    with button: [], [], OK
    on OK: con.clear(); exit with errorlevel 0

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