package net.torvald.tsvm

import com.badlogic.gdx.utils.compression.Lzma
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

class CompressorDelegate {

    /*fun comp(ba: ByteArray): ByteArray {
        val bin = ByteArrayInputStream(ba)
        val bout = ByteArrayOutputStream(256)
        Lzma.compress(bin, bout)
        return bout.toByteArray()
    }

    fun decomp(ba: ByteArray): ByteArray {
        val bin = ByteArrayInputStream(ba)
        val bout = ByteArrayOutputStream(256)
        Lzma.decompress(bin, bout)
        return bout.toByteArray()
    }*/

    fun comp(ba: ByteArray): ByteArray {
        val baos = ByteArrayOutputStream()
        val gz = GZIPOutputStream(baos)
        gz.write(ba); gz.flush(); gz.finish()
        baos.flush(); baos.close()
        return baos.toByteArray()
    }

    fun decomp(ba: ByteArray): ByteArray {
        val bais = ByteArrayInputStream(ba)
        val gz = GZIPInputStream(bais)
        val ret = gz.readBytes()
        gz.close(); bais.close()
        return ret
    }

}