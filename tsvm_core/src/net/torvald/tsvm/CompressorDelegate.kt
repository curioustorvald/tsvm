package net.torvald.tsvm

import com.badlogic.gdx.utils.compression.Lzma
import io.airlift.compress.zstd.ZstdInputStream
import io.airlift.compress.zstd.ZstdOutputStream
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
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
        val ZSTD_HEADER = byteArrayOf(40, -75, 47, -3)

        fun comp(str: String) = comp(str.toByteArray(VM.CHARSET))

        fun comp(ba: ByteArray): ByteArray {
            val baos = ByteArrayOutputStream()
            val gz = ZstdOutputStream(baos)
            gz.write(ba); gz.flush(); gz.close()
            baos.flush(); baos.close()
            return baos.toByteArray()
        }


        fun decomp(str: String) = decomp(str.toByteArray(VM.CHARSET))

        fun decomp(ba: ByteArray): ByteArray {
            val header = ba[0].toUint().shl(24) or ba[1].toUint().shl(16) or ba[2].toUint().shl(8) or ba[3].toUint()

            val bais = ByteArrayInputStream(ba)
            val zis = when (header) {
                in 0x1F8B0800..0x1F8B08FF -> GZIPInputStream(bais)
                0x28B52FFD -> ZstdInputStream(bais)
                else -> throw Error()
            }
            val ret = zis.readBytes()
            zis.close(); bais.close()
            return ret
        }
    }
}