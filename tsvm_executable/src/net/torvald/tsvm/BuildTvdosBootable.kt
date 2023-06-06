package net.torvald.tsvm

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.archivers.ClusteredFormatDOM
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.archivers.Clustfile
import java.io.File

/**
 * Created by minjaesong on 2022-12-21.
 */
fun main(args: Array<String>) {
    if (args.size != 1)
        println("Usage: java -jar BuildTvdosBootable.jar outfile")

    val outfile = File(args[0])

    val disk = ClusteredFormatDOM.createNewArchive(outfile, VM.CHARSET, "TVDOS", 240, byteArrayOf(0x10, 0x01))
    val DOM = ClusteredFormatDOM(disk)

    Clustfile(DOM, "/home").also { it.mkdir() }

    //tvdos/bin/*
    Clustfile(DOM, "/tvdos/bin").importFrom(File("assets/disk0/tvdos/bin"))
    Clustfile(DOM, "/tvdos/include").importFrom(File("assets/disk0/tvdos/include"))
    Clustfile(DOM, "/tvdos/installer").importFrom(File("assets/disk0/tvdos/installer"))
    Clustfile(DOM, "/tvdos/sbin").importFrom(File("assets/disk0/tvdos/sbin"))

    //tvdos/*
    Clustfile(DOM, "/tvdos/TVDOS.SYS").also { it.importFrom(File("assets/disk0/tvdos/TVDOS.SYS")) }
    Clustfile(DOM, "/tvdos/us_colemak.key").also { it.importFrom(File("assets/disk0/tvdos/us_colemak.key")) }
    Clustfile(DOM, "/tvdos/us_qwerty.key").also { it.importFrom(File("assets/disk0/tvdos/us_qwerty.key")) }


    // bare file in root dir
    Clustfile(DOM, "/AUTOEXEC.BAT").also { it.importFrom(File("assets/disk0/root.bootable/AUTOEXEC.BAT")) }

    DOM.writeBoot(File("assets/disk0/root.bootable/!BOOTSEC").readBytes())
}
