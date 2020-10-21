package net.torvald.tsvm

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import java.io.InputStream

class VmFilesystemDelegate(val vm: VM, val portNo: Int) {

    fun getFileInputStream(path: String) = DiskDriveFileInputStream(vm, portNo, path)

}

class DiskDriveFileInputStream(vm: VM, portNo: Int, path: String) : InputStream() {

    private val contents = SerialHelper.sendMessageGetBytes(vm, portNo, "OPENR\"$path\"".toByteArray(VM.CHARSET))
    private var readCursor = 0

    init {
        contents.toString() // meaningless statement to NOT lazy eval the property
    }

    override fun markSupported() = true

    override fun read(): Int {
        if (readCursor >= contents.size) return -1
        val ret = contents[readCursor].toUint()
        readCursor += 1
        return ret
    }

    override fun skip(n: Long): Long {
        val newReadCursor = minOf(contents.size.toLong(), readCursor + n)
        val diff = newReadCursor - readCursor
        readCursor = newReadCursor.toInt()
        return diff
    }

    override fun reset() {
        readCursor = 0
    }

    override fun mark(i: Int) {
        TODO()
    }

    override fun read(p0: ByteArray): Int {
        var readBytes = 0
        for (k in p0.indices) {
            val r = read()
            p0[k] = r.toByte()
            if (r >= 0) readBytes += 1
        }

        return readBytes
    }

    override fun read(p0: ByteArray, p1: Int, p2: Int): Int {
        TODO()
    }

    override fun close() {
        TODO()
    }
}