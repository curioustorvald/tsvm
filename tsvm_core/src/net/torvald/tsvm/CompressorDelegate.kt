package net.torvald.tsvm

import com.badlogic.gdx.utils.compression.Lzma
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

class CompressorDelegate(private val vm: VM) {

    fun comp(str: String) = Companion.comp(str)
    fun comp(ba: ByteArray) = Companion.comp(ba)

    /**
     * @return length of the bytes compressed
     */
    fun compFromTo(input: Int, len: Int, output: Int): Int {
        val inbytes = ByteArray(len) { vm.peek(input.toLong() + it)!! }
        comp(inbytes).let {
            it.forEachIndexed { index, byte ->
                vm.poke(output.toLong() + index, byte)
            }
            return it.size
        }
    }

    fun compTo(str: String, output: Int): Int {
        comp(str).let {
            it.forEachIndexed { index, byte ->
                vm.poke(output.toLong() + index, byte)
            }
            return it.size
        }
    }

    fun compTo(ba: ByteArray, output: Int): Int {
        comp(ba).let {
            it.forEachIndexed { index, byte ->
                vm.poke(output.toLong() + index, byte)
            }
            return it.size
        }
    }


    fun decomp(str: String) = Companion.decomp(str)
    fun decomp(ba: ByteArray) = Companion.decomp(ba)

    fun decompTo(str: String, pointer: Int): Int {
        val bytes = decomp(str)
        bytes.forEachIndexed { index, byte ->
            vm.poke(pointer.toLong() + index, byte)
        }
        return bytes.size
    }

    fun decompTo(ba: ByteArray, pointer: Int): Int {
        val bytes = decomp(ba)
        bytes.forEachIndexed { index, byte ->
            vm.poke(pointer.toLong() + index, byte)
        }
        return bytes.size
    }

    /**
     * @return length of the bytes compressed
     */
    fun decompFromTo(input: Int, len: Int, output: Int): Int {
        val inbytes = ByteArray(len) { vm.peek(input.toLong() + it)!! }
        decomp(inbytes).let {
            it.forEachIndexed { index, byte ->
                vm.poke(output.toLong() + index, byte)
            }
            return it.size
        }
    }

    companion object {
        val GZIP_HEADER = byteArrayOf(31, -117, 8) // .gz in DEFLATE

        fun comp(str: String) = comp(str.toByteArray(VM.CHARSET))

        fun comp(ba: ByteArray): ByteArray {
            val baos = ByteArrayOutputStream()
            val gz = GZIPOutputStream(baos)
            gz.write(ba); gz.flush(); gz.finish()
            baos.flush(); baos.close()
            return baos.toByteArray()
        }


        fun decomp(str: String) = decomp(str.toByteArray(VM.CHARSET))

        fun decomp(ba: ByteArray): ByteArray {
            val bais = ByteArrayInputStream(ba)
            val gz = GZIPInputStream(bais)
            val ret = gz.readBytes()
            gz.close(); bais.close()
            return ret
        }
    }
}