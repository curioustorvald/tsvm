package net.torvald.tsvm.peripheral

import net.torvald.tsvm.CompressorDelegate
import net.torvald.tsvm.CompressorDelegate.GZIP_HEADER
import net.torvald.tsvm.VM
import net.torvald.tsvm.startsWith
import java.io.File

open class VMProgramRom(path: String) {
    private val contents: ByteArray

    init {
        val bytes = File(path).readBytes()
        contents = bytes.sliceArray(0 until minOf(65536, bytes.size))
    }

    fun readAll(): String {
        // check if bios is compressed in gzip
        return if (contents.startsWith(GZIP_HEADER))
            CompressorDelegate.decomp(contents).toString(VM.CHARSET)
        else
            contents.toString(VM.CHARSET)
    }

    fun get(addr: Int): Byte = contents[addr]
}

object GenericBios : VMProgramRom("./assets/bios/bios1.bin")
object OEMBios : VMProgramRom("./assets/bios/TBMBIOS.js")
object QuickBios : VMProgramRom("./assets/bios/quick.js")
object BasicBios : VMProgramRom("./assets/bios/basicbios.js")
object TandemBios : VMProgramRom("./assets/bios/tandemport.js")
object BasicRom : VMProgramRom("./assets/bios/basic.bin")
object TBASRelBios : VMProgramRom("./assets/bios/tbasdist.js")
object WPBios : VMProgramRom("./assets/bios/wp.js")