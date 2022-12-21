package net.torvald.tsvm

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.VDUtil
import net.torvald.tsvm.VM
import java.io.File

/**
 * Created by minjaesong on 2022-12-21.
 */
fun main(args: Array<String>) {
    if (args.size != 1)
        println("Usage: java -jar BuildTvdosBootable.jar outfile")

    val disk = VDUtil.createNewDisk(720L shl 10, "TVDOS", VM.CHARSET)

    val tvdosDir = VDUtil.addDir(disk, 0, "tvdos".toByteArray(VM.CHARSET))
    val homeDir = VDUtil.addDir(disk, 0, "home".toByteArray(VM.CHARSET))

    //tvdos/bin/*
    VDUtil.importDirRecurse(disk, File("assets/disk0/tvdos/bin"), tvdosDir, VM.CHARSET)

    //tvdos/*
    listOf(
        VDUtil.importFile(File("assets/disk0/tvdos/gl.js"), disk.generateUniqueID(), VM.CHARSET),
        VDUtil.importFile(File("assets/disk0/tvdos/TVDOS.SYS"), disk.generateUniqueID(), VM.CHARSET),
        VDUtil.importFile(File("assets/disk0/tvdos/us_colemak.key"), disk.generateUniqueID(), VM.CHARSET),
        VDUtil.importFile(File("assets/disk0/tvdos/us_qwerty.key"), disk.generateUniqueID(), VM.CHARSET),
//        VDUtil.importFile(File("assets/disk0/tvdos/wall.bytes"), disk.generateUniqueID(), VM.CHARSET),
//        VDUtil.importFile(File("assets/disk0/tvdos/wall.png"), disk.generateUniqueID(), VM.CHARSET),
    ).forEach {
        VDUtil.addFile(disk, tvdosDir, it)
    }

    // bare file in root dir
    listOf(
        VDUtil.importFile(File("assets/disk0/root.bootable/!BOOTSEC"), disk.generateUniqueID(), VM.CHARSET),
        VDUtil.importFile(File("assets/disk0/root.bootable/AUTOEXEC.BAT"), disk.generateUniqueID(), VM.CHARSET),
    ).forEach {
        VDUtil.addFile(disk, 0, it)
    }


    VDUtil.dumpToRealMachine(disk, File(args[0]))
}
