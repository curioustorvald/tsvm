package net.torvald.tsvm.peripheral

import net.torvald.tsvm.CompressorDelegate
import net.torvald.tsvm.CompressorDelegate.GZIP_HEADER
import net.torvald.tsvm.VM
import net.torvald.tsvm.startsWith
import java.io.File

interface VMProgramRom {
    fun readAll(): String
    operator fun get(addr: Int): Byte
}

object GenericBios : VMProgramRom {
    private val contents: ByteArray

    init {
        val bytes = File("./assets/bios/bios1.bin").readBytes()
        contents = bytes.sliceArray(0 until minOf(65536, bytes.size))
    }

    override fun readAll(): String {
        // check if bios is compressed in gzip
        return if (contents.startsWith(GZIP_HEADER))
            CompressorDelegate.decomp(contents).toString(VM.CHARSET)
        else
            contents.toString(VM.CHARSET)
    }

    override fun get(addr: Int): Byte = contents[addr]
}

object BasicBios : VMProgramRom {
    private val contents: ByteArray

    init {
        val bytes = File("./assets/bios/basicbios.js").readBytes()
        contents = bytes.sliceArray(0 until minOf(65536, bytes.size))
    }

    override fun readAll(): String {
        // check if bios is compressed in gzip
        return if (contents.startsWith(GZIP_HEADER))
            CompressorDelegate.decomp(contents).toString(VM.CHARSET)
        else
            contents.toString(VM.CHARSET)
    }

    override fun get(addr: Int): Byte = contents[addr]
}

object BasicRom : VMProgramRom {
    private val contents: ByteArray

    init {
        val bytes = File("./assets/bios/basic.bin").readBytes()
        contents = bytes.sliceArray(0 until minOf(65536, bytes.size))
    }

    override fun readAll(): String {
        // check if bios is compressed in gzip
        return if (contents.startsWith(GZIP_HEADER))
            CompressorDelegate.decomp(contents).toString(VM.CHARSET)
        else
            contents.toString(VM.CHARSET)
    }

    override fun get(addr: Int): Byte = contents[addr]
}