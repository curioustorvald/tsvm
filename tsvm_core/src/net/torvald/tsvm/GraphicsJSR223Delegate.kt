package net.torvald.tsvm

import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.math.MathUtils.PI
import com.badlogic.gdx.math.MathUtils.ceil
import com.badlogic.gdx.math.MathUtils.floor
import com.badlogic.gdx.math.MathUtils.round
import io.airlift.compress.zstd.ZstdInputStream
import net.torvald.UnsafeHelper
import net.torvald.UnsafePtr
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.peripheral.PeriBase
import net.torvald.tsvm.peripheral.fmod
import java.io.ByteArrayInputStream
import java.util.*
import kotlin.Any
import kotlin.Array
import kotlin.Boolean
import kotlin.BooleanArray
import kotlin.Byte
import kotlin.ByteArray
import kotlin.Double
import kotlin.Exception
import kotlin.Float
import kotlin.FloatArray
import kotlin.IllegalArgumentException
import kotlin.IllegalStateException
import kotlin.Int
import kotlin.IntArray
import kotlin.Long
import kotlin.LongArray
import kotlin.Pair
import kotlin.Short
import kotlin.ShortArray
import kotlin.String
import kotlin.Triple
import kotlin.arrayOf
import kotlin.byteArrayOf
import kotlin.collections.ArrayList
import kotlin.collections.HashMap
import kotlin.collections.List
import kotlin.collections.MutableMap
import kotlin.collections.component1
import kotlin.collections.component2
import kotlin.collections.component3
import kotlin.collections.component4
import kotlin.collections.copyOf
import kotlin.collections.count
import kotlin.collections.fill
import kotlin.collections.first
import kotlin.collections.forEach
import kotlin.collections.forEachIndexed
import kotlin.collections.indices
import kotlin.collections.isNotEmpty
import kotlin.collections.last
import kotlin.collections.listOf
import kotlin.collections.map
import kotlin.collections.maxOfOrNull
import kotlin.collections.mutableListOf
import kotlin.collections.mutableMapOf
import kotlin.collections.set
import kotlin.collections.sliceArray
import kotlin.collections.sorted
import kotlin.collections.sumOf
import kotlin.collections.toFloatArray
import kotlin.collections.toList
import kotlin.error
import kotlin.floatArrayOf
import kotlin.fromBits
import kotlin.intArrayOf
import kotlin.let
import kotlin.longArrayOf
import kotlin.math.*
import kotlin.repeat
import kotlin.text.format
import kotlin.text.lowercase
import kotlin.text.toString

class GraphicsJSR223Delegate(private val vm: VM) {

    private fun getFirstGPU(): GraphicsAdapter? {
        return vm.findPeribyType(VM.PERITYPE_GPU_AND_TERM)?.peripheral as? GraphicsAdapter
    }

    fun getGpuMemBase(): Int {
        return -1 - (1048576 * (vm.findPeriIndexByType(VM.PERITYPE_GPU_AND_TERM) ?: 0))
    }

    fun getVramSize() {
        getFirstGPU()?.let {
            it.mmio_read(11)
            it.applyDelay()
        }
    }

    fun resetPalette() {
        getFirstGPU()?.let {
            it.poke(250883L, 1)
            it.applyDelay()
        }
    }

    /**
     * @param index which palette number to modify, 0-255
     * @param r g - b - a - RGBA value, 0-15
     */
    fun setPalette(index: Int, r: Int, g: Int, b: Int, a: Int = 15) {
        getFirstGPU()?.let {
            it.paletteOfFloats[index * 4] = (r and 15) / 15f
            it.paletteOfFloats[index * 4 + 1] = (g and 15) / 15f
            it.paletteOfFloats[index * 4 + 2] = (b and 15) / 15f
            it.paletteOfFloats[index * 4 + 3] = (a and 15) / 15f
            it.applyDelay()
        }
    }

    fun setTextFore(b: Int) {
        getFirstGPU()?.let { it.ttyFore = b }
    }

    fun setTextBack(b: Int) {
        getFirstGPU()?.let { it.ttyBack = b }
    }

    fun getTextFore() = getFirstGPU()?.ttyFore
    fun getTextBack() = getFirstGPU()?.ttyBack

    /*fun loadBulk(fromAddr: Int, toAddr: Int, length: Int) {
        getFirstGPU()?._loadbulk(fromAddr, toAddr, length)
    }

    fun storeBulk(fromAddr: Int, toAddr: Int, length: Int) {
        getFirstGPU()?._storebulk(fromAddr, toAddr, length)
    }*/

    fun plotPixel(x: Int, y: Int, colour: Int) {
        getFirstGPU()?.let {
            if (x in 0 until it.config.width && y in 0 until it.config.height) {
                it.poke(y.toLong() * it.config.width + x, colour.toByte())
                it.applyDelay()
            }
        }
    }

    fun plotPixel2(x: Int, y: Int, colour: Int) {
        getFirstGPU()?.let {
            if (x in 0 until it.config.width && y in 0 until it.config.height) {
                it.poke(262144 + y.toLong() * it.config.width + x, colour.toByte())
                it.applyDelay()
            }
        }
    }

    /**
     * Sets absolute position of scrolling
     */
    fun setFramebufferScroll(x: Int, y: Int) {
        getFirstGPU()?.let {
            it.framebufferScrollX = x
            it.framebufferScrollY = y
            it.applyDelay()
        }
    }

    fun getFramebufferScroll(): IntArray {
        getFirstGPU()?.let {
            it.applyDelay()
            return intArrayOf(it.framebufferScrollX, it.framebufferScrollY)
        }
        return intArrayOf(0, 0)
    }

    fun scrollFrame(xdelta: Int, ydelta: Int) {
        getFirstGPU()?.let {
            it.framebufferScrollX = (it.framebufferScrollX + xdelta) fmod it.WIDTH
            it.framebufferScrollY = (it.framebufferScrollY + ydelta) fmod it.HEIGHT
            it.applyDelay()
        }
    }

    fun setLineOffset(line: Int, offset: Int) {
        getFirstGPU()?.let {
            it.scanlineOffsets[2L * line] = offset.toByte()
            it.scanlineOffsets[2L * line + 1] = offset.shr(8).toByte() // absolutely not USHR
            it.applyDelay()
        }
    }

    fun getLineOffset(line: Int): Int {
        getFirstGPU()?.let {
            var xoff = it.scanlineOffsets[2L * line].toUint() or it.scanlineOffsets[2L * line + 1].toUint().shl(8)
            if (xoff.and(0x8000) != 0) xoff = xoff or 0xFFFF0000.toInt()
            it.applyDelay()
            return xoff
        }
        return 0
    }

    fun setGraphicsMode(mode: Int) {
        getFirstGPU()?.let {
            it.mmio_write(12L, mode.toByte())
            it.applyDelay()
        }
    }

    fun getGraphicsMode() = getFirstGPU()?.let {
        it.applyDelay()
        it.mmio_read(12L)?.toUint() ?: 0
    }

    fun getPixelDimension(): IntArray {
        getFirstGPU()?.let {
            it.applyDelay()
            return intArrayOf(it.WIDTH, it.HEIGHT)
        }
        return intArrayOf(-1, -1)
    }

    fun getTermDimension(): IntArray {
        getFirstGPU()?.let {
            it.applyDelay()
            return intArrayOf(it.TEXT_ROWS, it.TEXT_COLS)
        }
        return intArrayOf(-1, -1)
    }

    fun getCursorYX(): IntArray {
        getFirstGPU()?.let {
            val (cx, cy) = it.getCursorPos()
            it.applyDelay()
            return intArrayOf(cy + 1, cx + 1)
        }
        return intArrayOf(-1, -1)
    }

    fun setCursorYX(cy: Int, cx: Int) {
        getFirstGPU()?.let {
            it.setCursorPos(cx - 1, cy - 1)
            it.applyDelay()
        }
    }


    fun setBackground(r: Int, g: Int, b: Int) {
        getFirstGPU()?.let {
            it.poke(250880, r.toByte())
            it.poke(250881, g.toByte())
            it.poke(250882, b.toByte())
            it.applyDelay()
        }
    }

    fun clearText() {
        getFirstGPU()?.let {
            it.eraseInDisp(2)
            it.applyDelay()
        }
    }

    fun clearPixels(col: Int) {
        getFirstGPU()?.let {
            it.poke(250884L, col.toByte())
            it.poke(250883L, 2)
            it.applyDelay()
        }
    }

    fun clearPixels2(col: Int) {
        getFirstGPU()?.let {
            it.poke(250883L, 4)
            it.poke(250884L, col.toByte())
            it.applyDelay()
        }
    }

    /**
     * prints a char as-is; won't interpret them as an escape sequence
     */
    fun putSymbol(c: Int) {
        getFirstGPU()?.let {
            val (cx, cy) = it.getCursorPos()


            it.putChar(cx, cy, c.toByte())

            it.applyDelay()
        }
    }

    fun putSymbolAt(cy: Int, cx: Int, c: Int) {
        getFirstGPU()?.let {
            it.putChar(cx - 1, cy - 1, c.toByte())
            it.applyDelay()
        }
    }

    /*private fun GraphicsAdapter._loadbulk(fromAddr: Int, toAddr: Int, length: Int) {
        UnsafeHelper.memcpy(
            vm.usermem.ptr + fromAddr,
            (this.framebuffer.pixels as DirectBuffer).address() + toAddr,
            length.toLong()
        )
    }

    private fun GraphicsAdapter._storebulk(fromAddr: Int, toAddr: Int, length: Int) {
        UnsafeHelper.memcpy(
            (this.framebuffer.pixels as DirectBuffer).address() + fromAddr,
            vm.usermem.ptr + toAddr,
            length.toLong()
        )
    }*/

    /*fun setHalfrowMode(set: Boolean) {
        getFirstGPU()?.halfrowMode = set
    }*/

    private fun GraphicsAdapter._loadSprite(spriteNum: Int, ptr: Int) {
        UnsafeHelper.memcpy(
            vm.usermem.ptr + ptr,
            (this.textArea).ptr + (260 * spriteNum) + 4,
            256
        )
    }

    private fun GraphicsAdapter._storeSprite(spriteNum: Int, ptr: Int) {
        UnsafeHelper.memcpy(
            (this.textArea).ptr + (260 * spriteNum) + 4,
            vm.usermem.ptr + ptr,
            256
        )
    }


    private fun Pixmap.getChannelCount() = when (this.format) {
        Pixmap.Format.Alpha, Pixmap.Format.Intensity -> 1
        Pixmap.Format.RGBA8888, Pixmap.Format.RGBA4444 -> 4
        Pixmap.Format.LuminanceAlpha -> 2
        else -> 3
    }

    // TODO make it callable using MMIO
    /**
     * Decode an image into uncompressed pixels and return dynamically allocated pointer which contains decoded pixels.
     *
     * @return Array of: width, height, ptr to image data
     */
    fun decodeImage(srcFilePtr: Int, srcFileLen: Int): IntArray {
        val data = ByteArray(srcFileLen)
        UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + srcFilePtr, data, UnsafeHelper.getArrayOffset(data), srcFileLen.toLong())

        val pixmap = Pixmap(data, 0, data.size)
        val width = pixmap.width
        val height = pixmap.height
        val channels = pixmap.getChannelCount()

        val outData = ByteArray(pixmap.pixels.capacity())
        val destPixmapPtr = vm.malloc(outData.size)
        pixmap.pixels.position(0)
        pixmap.pixels.get(outData)
        pixmap.pixels.position(0)
        pixmap.dispose()

        UnsafeHelper.memcpyRaw(outData, UnsafeHelper.getArrayOffset(outData), null, vm.usermem.ptr + destPixmapPtr, outData.size.toLong())
        return intArrayOf(width, height, channels, destPixmapPtr)
    }

    /**
     * Decode an image into uncompressed pixels and store them to given pointer.
     *
     * @return Array of: width, height, ptr to image data
     */
    fun decodeImageTo(srcFilePtr: Int, srcFileLen: Int, destPixmapPtr: Int): IntArray {
        val data = ByteArray(srcFileLen)
        UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + srcFilePtr, data, UnsafeHelper.getArrayOffset(data), srcFileLen.toLong())

        val pixmap = Pixmap(data, 0, data.size)
        val width = pixmap.width
        val height = pixmap.height
        val channels = pixmap.getChannelCount()

        val outData = ByteArray(pixmap.pixels.capacity())
        pixmap.pixels.position(0)
        pixmap.pixels.get(outData)
        pixmap.pixels.position(0)
        pixmap.dispose()

        UnsafeHelper.memcpyRaw(outData, UnsafeHelper.getArrayOffset(outData), null, vm.usermem.ptr + destPixmapPtr, outData.size.toLong())
        return intArrayOf(width, height, channels, destPixmapPtr)
    }

    /**
     * Special number for width and height:
     * - If either width or height is zero, the resulting image will be proportionally scaled using the other value
     * - If both are zero, original image dimension will be used.
     * - If both are -1, image will be resized so that the entire picture fits into the screen.
     *
     * Will always return 4-channel image data
     */
    fun decodeImageResample(srcFilePtr: Int, srcFileLen: Int, width0: Int, height0: Int): IntArray {
        var width = width0
        var height = height0


        val data = ByteArray(srcFileLen)
        UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + srcFilePtr, data, UnsafeHelper.getArrayOffset(data), srcFileLen.toLong())

        val inPixmap = Pixmap(data, 0, data.size)
        val gpu = getFirstGPU()

        if (width <= -1f && height <= -1f && gpu != null) {
            if (inPixmap.width > inPixmap.height) {
                val scale = inPixmap.height.toFloat() / inPixmap.width.toFloat()
                width = gpu.config.width
                height = (width * scale).roundToInt()
            }
            else {
                val scale = inPixmap.width.toFloat() / inPixmap.height.toFloat()
                height = gpu.config.height
                width = (height * scale).roundToInt()
            }
        }
        else if (width == 0 && height == 0) {
            width = inPixmap.width
            height = inPixmap.height
        }
        else if (width <= 0) {
            val scale = inPixmap.width.toFloat() / inPixmap.height.toFloat()
            width = (height * scale).roundToInt()
        }
        else if (height <= 0) {
            val scale = inPixmap.width.toFloat() / inPixmap.height.toFloat()
            height = (width * scale).roundToInt()
        }

        val pixmap = Pixmap(width, height, Pixmap.Format.RGBA8888)
        inPixmap.filter = Pixmap.Filter.BiLinear
        pixmap.filter = Pixmap.Filter.BiLinear
        pixmap.drawPixmap(inPixmap, 0, 0, inPixmap.width, inPixmap.height, 0, 0, width, height)

        val destPixmapPtr = vm.malloc(width * height)
        val outData = ByteArray(pixmap.pixels.capacity())
        val channels = pixmap.getChannelCount()

        pixmap.pixels.position(0)
        pixmap.pixels.get(outData)
        pixmap.pixels.position(0)
        pixmap.dispose()
        inPixmap.dispose()

        UnsafeHelper.memcpyRaw(outData, UnsafeHelper.getArrayOffset(outData), null, vm.usermem.ptr + destPixmapPtr, outData.size.toLong())
        return intArrayOf(width, height, channels, destPixmapPtr)
    }

    fun decodeImageResampleTo(srcFilePtr: Int, srcFileLen: Int, width0: Int, height0: Int, destPixmapPtr: Int): IntArray {
        var width = width0
        var height = height0


        val data = ByteArray(srcFileLen)
        UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + srcFilePtr, data, UnsafeHelper.getArrayOffset(data), srcFileLen.toLong())

        val inPixmap = Pixmap(data, 0, data.size)
        val gpu = getFirstGPU()

        if (width <= -1f && height <= -1f && gpu != null) {
            if (inPixmap.width > inPixmap.height) {
                val scale = inPixmap.height.toFloat() / inPixmap.width.toFloat()
                width = gpu.config.width
                height = (width * scale).roundToInt()
            }
            else {
                val scale = inPixmap.width.toFloat() / inPixmap.height.toFloat()
                height = gpu.config.height
                width = (height * scale).roundToInt()
            }
        }
        else if (width == 0 && height == 0) {
            width = inPixmap.width
            height = inPixmap.height
        }
        else if (width <= 0) {
            val scale = inPixmap.width.toFloat() / inPixmap.height.toFloat()
            width = (height * scale).roundToInt()
        }
        else if (height <= 0) {
            val scale = inPixmap.width.toFloat() / inPixmap.height.toFloat()
            height = (width * scale).roundToInt()
        }

        val pixmap = Pixmap(width, height, Pixmap.Format.RGBA8888)
        inPixmap.filter = Pixmap.Filter.BiLinear
        pixmap.filter = Pixmap.Filter.BiLinear
        pixmap.drawPixmap(inPixmap, 0, 0, inPixmap.width, inPixmap.height, 0, 0, width, height)

        val outData = ByteArray(pixmap.pixels.capacity())
        val channels = pixmap.getChannelCount()

        pixmap.pixels.position(0)
        pixmap.pixels.get(outData)
        pixmap.pixels.position(0)
        pixmap.dispose()
        inPixmap.dispose()

        UnsafeHelper.memcpyRaw(outData, UnsafeHelper.getArrayOffset(outData), null, vm.usermem.ptr + destPixmapPtr, outData.size.toLong())
        return intArrayOf(width, height, channels, destPixmapPtr)
    }

    private val clut = intArrayOf(0,0,6,6,1,1,7,2,2,2,2,3,3,3,49,4,241,241,241,6,1,1,1,7,7,2,2,8,3,3,49,9,5,5,242,6,6,6,1,7,7,7,2,8,8,3,3,9,5,5,5,11,11,6,6,12,52,7,7,53,8,8,54,54,10,10,5,11,11,11,57,12,12,52,13,13,13,8,8,14,10,10,10,16,16,11,11,17,57,12,12,58,13,13,59,59,15,15,10,16,16,16,11,17,17,57,18,18,58,58,13,19,15,15,15,15,16,16,16,62,17,17,17,18,18,18,58,19,60,15,21,61,61,16,16,62,62,23,63,17,18,18,64,64,60,20,20,21,21,61,67,22,22,62,23,23,63,69,24,64,20,20,20,20,21,21,21,67,22,22,68,68,23,23,69,69,65,65,20,26,66,21,21,27,67,67,22,28,68,23,29,29,25,25,25,26,26,26,26,72,27,27,73,28,28,68,74,29,70,70,31,31,71,26,26,32,72,72,27,73,73,28,34,74,30,30,30,31,31,31,31,77,32,32,78,33,33,33,79,34,35,35,76,76,76,31,31,37,77,32,78,78,33,33,33,79,0,0,46,1,1,1,47,42,42,2,48,3,3,3,49,4,241,241,241,6,1,1,1,47,7,2,2,8,3,3,49,49,5,5,242,242,6,6,1,7,7,7,2,8,8,3,3,9,5,5,5,11,6,6,6,52,52,7,7,53,8,8,54,54,10,10,5,11,11,11,6,12,12,52,13,13,53,13,14,14,10,10,10,56,11,11,11,57,57,12,12,58,13,13,59,59,15,15,15,16,16,16,11,17,17,57,18,18,58,13,13,19,15,15,15,15,16,16,16,62,17,17,17,18,18,18,58,19,60,15,61,61,61,16,16,62,62,63,63,63,18,18,64,64,60,60,20,61,21,61,67,22,22,62,23,23,63,69,24,64,20,20,20,66,21,21,21,67,22,22,68,23,23,63,69,69,65,65,20,26,66,21,21,27,67,67,22,28,68,23,29,69,25,25,25,26,26,26,26,72,27,27,73,28,28,68,74,29,70,70,31,71,71,26,26,32,72,72,27,73,73,28,34,74,30,30,30,31,31,31,31,77,32,32,78,33,33,33,79,34,35,35,76,76,76,31,31,37,77,32,78,78,33,33,79,79,40,40,46,41,41,1,47,42,42,2,48,43,43,3,49,4,45,241,241,46,46,1,47,47,47,2,48,48,3,3,49,49,45,242,242,242,46,46,1,47,47,47,42,48,48,43,3,49,50,5,243,243,243,6,6,52,52,7,7,53,8,8,54,54,50,50,5,51,51,51,6,12,52,52,13,13,53,53,8,54,10,10,10,56,56,11,11,57,57,12,58,58,13,13,59,59,55,55,10,56,56,56,11,17,57,57,18,18,58,13,13,59,15,15,15,16,16,16,56,62,17,17,57,18,18,58,58,19,60,15,15,61,61,16,16,62,62,63,63,63,18,18,64,64,60,60,60,61,61,61,67,22,22,62,23,63,63,109,24,64,20,20,20,66,21,61,21,67,22,22,68,23,23,63,69,69,65,65,66,66,66,21,21,27,67,67,22,68,68,23,23,69,25,25,25,26,26,26,66,72,27,27,73,28,28,68,74,29,70,70,71,71,71,26,26,72,72,72,73,73,73,28,34,74,30,30,30,31,31,31,71,77,32,72,118,33,73,73,79,34,75,75,76,76,76,31,31,77,77,32,78,78,78,33,79,79,40,40,86,41,41,41,47,47,42,42,48,43,43,3,49,4,40,40,40,46,41,41,47,47,47,42,48,48,43,43,49,49,45,45,242,46,46,46,41,47,47,47,42,48,48,43,54,49,45,45,243,243,243,46,46,52,52,47,53,53,48,8,54,54,50,50,50,51,51,51,6,52,52,52,53,53,53,53,54,54,50,50,50,56,51,51,57,57,57,52,52,58,53,53,59,59,55,55,55,56,56,56,51,57,57,57,18,58,58,13,13,59,55,55,55,55,56,56,56,102,17,57,57,18,58,58,58,19,60,15,15,61,61,16,16,62,62,63,63,63,18,18,64,104,60,60,60,61,61,61,107,62,62,62,63,63,63,109,24,64,60,60,60,66,61,61,61,67,62,62,62,23,63,63,69,109,65,65,66,66,66,66,21,67,67,22,22,68,68,23,23,69,65,65,65,66,26,66,66,72,27,67,73,28,68,68,114,114,70,70,71,71,71,26,26,72,72,72,73,73,73,28,74,74,70,70,70,70,31,71,71,117,32,72,118,73,73,73,79,74,75,75,76,76,76,31,71,77,77,32,32,78,78,33,79,79,40,40,86,81,41,41,87,87,42,42,48,43,43,43,89,44,40,40,40,86,46,41,41,47,47,42,42,48,43,43,89,89,45,45,91,46,46,46,41,87,47,47,42,48,48,43,94,89,45,45,45,243,46,46,46,92,92,47,47,93,48,48,54,94,50,50,96,244,244,244,46,52,52,52,53,53,53,53,48,54,50,50,50,96,51,245,245,97,52,52,52,98,53,53,59,99,55,55,55,56,56,56,246,57,57,57,58,58,58,53,53,59,55,55,55,55,56,56,56,246,57,57,57,58,58,58,58,19,100,100,101,101,101,56,56,102,102,63,103,103,18,18,104,104,60,60,60,61,61,61,107,62,62,102,63,63,103,109,64,64,60,60,60,106,61,61,61,107,62,62,108,63,63,63,109,109,65,65,105,66,66,61,61,67,67,107,68,68,68,63,69,69,65,65,65,65,66,66,112,112,67,67,113,68,68,68,114,114,110,70,70,71,71,26,66,72,72,67,73,113,28,68,74,74,70,70,70,70,71,71,71,117,72,72,118,73,73,73,119,74,115,115,76,76,76,71,71,117,77,32,72,118,118,73,79,119,80,40,86,86,81,41,87,87,82,82,88,83,43,43,89,84,85,40,40,86,86,41,87,87,82,42,88,88,83,43,89,89,85,85,91,86,86,86,92,87,87,87,88,88,88,43,94,89,90,45,91,91,91,46,92,92,92,47,93,93,48,48,94,94,90,90,96,91,244,244,97,92,92,92,93,93,93,99,99,94,95,50,96,96,96,245,245,97,97,52,98,98,53,53,99,99,95,95,50,96,96,96,246,246,97,97,98,98,98,53,53,99,55,55,55,101,56,56,102,246,57,57,57,58,58,58,98,59,100,100,101,101,101,56,102,102,102,103,103,103,58,58,104,104,100,100,100,101,101,101,107,102,102,102,103,103,103,109,104,104,60,60,106,106,101,61,107,107,62,62,108,63,63,63,109,109,105,105,105,106,106,106,61,107,107,107,108,108,108,63,69,109,65,65,65,111,66,66,106,112,67,67,113,68,68,108,114,69,110,110,110,111,111,111,66,112,112,67,113,113,113,68,114,114,70,70,110,110,71,71,117,117,72,112,118,113,113,113,119,74,115,115,116,116,116,71,71,117,117,72,118,118,118,73,119,119,80,80,126,81,81,81,87,87,82,82,88,83,83,83,89,84,80,80,86,86,81,81,87,87,82,82,88,88,83,83,89,89,85,85,131,86,86,86,92,87,87,87,88,88,88,83,94,89,90,85,91,91,86,86,86,92,92,87,93,93,88,88,94,94,90,90,90,91,91,91,137,92,92,92,93,93,93,88,99,94,90,90,96,96,91,245,97,97,97,92,98,98,93,93,99,99,95,95,95,96,96,246,246,246,97,97,98,98,98,98,99,99,95,95,95,95,96,96,247,247,247,97,97,98,98,98,98,99,100,101,101,101,101,96,102,102,102,103,103,103,103,104,104,104,100,100,100,101,101,101,147,102,102,102,103,103,103,103,104,104,100,100,100,106,101,101,101,107,102,102,108,108,103,103,109,109,105,105,106,106,106,106,61,107,107,107,108,108,108,103,109,109,105,105,105,105,106,106,106,112,107,107,113,108,108,108,114,109,110,110,111,111,111,111,66,112,112,112,113,113,113,108,114,114,110,110,110,110,111,111,117,117,112,112,118,113,113,113,119,114,115,115,115,116,116,111,71,117,117,72,118,118,118,113,119,119,80,80,126,126,81,81,127,127,82,82,128,83,83,83,129,89,80,80,126,126,81,81,127,127,87,82,128,88,83,83,129,89,85,85,131,131,86,81,132,132,87,87,82,88,88,83,134,89,85,85,131,131,86,86,86,132,87,87,87,88,88,88,134,94,90,90,136,136,91,91,137,137,92,92,87,93,93,88,139,94,90,90,90,136,91,91,91,137,137,92,138,138,93,93,139,139,95,95,95,96,96,246,246,246,97,97,98,98,98,93,99,99,95,95,95,95,96,96,247,247,247,97,97,98,98,98,144,99,140,141,141,141,141,96,142,142,248,248,143,143,98,98,144,144,100,100,100,101,101,101,147,102,102,102,103,103,103,149,149,104,100,100,100,146,101,101,101,147,102,102,148,103,103,103,149,149,105,105,105,106,106,101,101,107,107,107,108,108,108,103,109,109,105,105,105,106,106,106,152,152,107,107,153,108,108,108,154,154,110,110,111,151,111,106,106,112,112,112,113,113,113,108,114,114,110,110,110,111,111,111,157,157,112,112,158,113,113,113,159,114,115,115,156,156,116,111,111,117,157,117,118,158,113,113,119,159,120,80,126,126,121,81,127,127,122,82,128,123,123,83,129,124,125,80,126,126,126,81,127,127,127,122,128,128,83,83,129,129,125,80,131,126,126,81,132,127,127,87,133,128,128,83,134,129,130,85,131,131,131,86,132,132,132,87,133,133,128,88,134,134,130,130,136,131,131,131,137,132,132,138,138,133,133,139,139,134,135,90,136,136,136,91,137,137,137,92,138,138,93,93,139,139,135,135,90,136,136,136,91,137,137,137,138,138,138,138,139,139,95,95,95,141,96,96,247,247,247,97,97,98,98,98,144,99,140,140,141,141,141,96,142,142,248,248,143,143,143,144,144,144,140,140,141,141,141,141,147,142,142,249,143,143,143,149,144,144,145,146,146,146,146,101,147,147,147,102,148,148,103,143,149,149,145,145,145,146,146,146,101,147,147,147,148,148,148,103,149,149,150,151,151,151,106,106,152,152,152,107,153,153,108,108,154,154,150,150,150,151,151,106,106,152,152,152,153,153,153,108,154,154,156,156,156,156,111,111,157,157,112,152,158,113,113,159,159,114,155,155,156,156,156,156,111,157,157,157,158,158,158,113,159,159,120,120,126,121,121,121,127,127,122,122,128,123,123,123,129,124,120,120,126,126,121,121,172,127,122,122,128,128,123,123,129,129,125,125,171,126,126,126,132,132,127,122,133,128,128,123,134,129,130,130,131,131,131,126,126,132,132,127,133,133,128,128,134,134,130,130,130,131,131,131,177,132,132,132,133,133,133,128,134,134,135,130,136,136,136,131,137,137,137,132,138,138,133,133,139,139,135,135,135,136,136,136,91,137,137,137,138,138,138,138,139,139,135,135,135,136,136,136,182,248,137,137,137,138,138,138,144,139,140,140,141,141,141,96,142,142,248,248,143,143,143,144,144,144,140,140,140,141,141,141,187,142,142,249,249,143,143,149,144,144,140,140,146,146,141,141,147,147,142,142,250,250,143,143,149,149,145,145,146,146,146,146,147,147,147,147,148,148,148,103,149,149,145,145,145,145,146,146,146,152,147,147,153,148,148,148,154,149,150,150,150,151,151,151,106,152,152,152,153,153,153,108,154,154,150,150,150,150,151,151,157,157,152,152,158,153,153,153,159,154,155,155,156,156,156,156,157,157,157,157,158,158,158,153,159,159,120,120,166,166,121,121,167,167,122,122,168,123,123,174,169,129,120,120,171,126,121,121,172,127,127,122,168,128,123,123,169,129,125,125,171,171,126,121,172,172,127,122,122,128,128,123,174,129,125,125,171,171,126,126,172,172,127,127,173,133,128,128,174,134,130,130,176,131,131,131,177,132,132,132,127,133,133,179,179,134,130,130,130,176,131,131,131,177,132,132,132,138,133,133,139,139,135,135,135,136,136,136,131,137,137,137,138,138,138,133,133,139,135,135,135,135,136,136,182,182,137,137,137,138,138,138,184,139,180,181,181,181,181,136,182,182,182,183,183,183,183,184,184,184,140,140,140,141,141,141,187,142,142,249,249,143,143,189,144,144,140,140,140,140,141,141,187,187,142,142,250,250,143,143,189,189,145,145,145,146,146,146,192,147,147,147,251,148,148,194,149,149,145,145,145,145,146,146,192,192,147,147,193,148,148,148,194,194,150,150,151,151,151,146,146,152,152,147,153,153,153,148,154,154,150,150,150,150,151,151,151,197,152,152,198,153,153,153,199,154,155,155,155,156,156,151,151,157,157,152,158,158,153,153,159,159,165,120,166,166,161,121,167,167,162,168,168,163,123,174,169,164,165,120,166,166,161,121,172,167,167,173,168,168,163,174,169,169,165,120,171,171,166,121,172,172,167,173,173,168,128,123,174,169,170,125,171,171,171,126,172,172,172,127,173,173,168,128,174,174,170,125,176,171,171,126,177,177,172,178,178,173,173,179,179,174,175,130,176,176,176,131,177,177,177,178,178,178,133,133,179,179,175,175,135,176,176,136,131,177,177,137,178,178,178,133,179,179,135,135,135,181,136,136,182,182,137,137,137,178,138,138,184,184,180,180,181,181,181,136,182,182,182,183,183,183,138,184,184,184,180,180,181,181,181,181,187,182,182,182,183,183,183,189,184,184,185,185,186,186,141,141,187,187,187,188,250,188,143,143,189,189,185,185,185,186,186,186,192,187,187,187,251,251,251,143,189,189,190,191,191,191,146,146,192,192,192,147,193,193,252,194,194,194,190,190,190,191,191,191,146,192,192,147,193,193,193,252,194,194,195,196,196,196,151,151,197,197,197,198,198,193,153,199,199,199,195,195,196,196,196,196,151,197,197,197,198,198,198,153,199,199,160,160,166,166,161,161,167,167,162,162,168,163,163,174,169,164,160,160,166,166,161,161,172,167,162,162,168,168,163,163,169,169,165,165,171,166,166,161,172,172,167,162,173,168,163,174,174,169,170,170,171,171,171,166,172,172,172,167,173,173,168,163,174,174,170,170,170,171,171,171,217,172,172,172,173,173,173,168,174,174,175,175,176,176,176,171,177,177,177,172,178,178,173,173,179,179,175,175,175,176,176,176,177,177,177,177,178,178,178,178,179,179,175,175,175,181,176,176,222,182,177,177,183,178,178,178,184,179,180,180,181,181,181,181,182,182,182,183,183,183,183,184,184,184,180,180,180,181,181,181,227,182,182,182,183,183,183,183,184,184,185,186,186,186,181,181,187,187,187,182,188,188,183,189,189,189,185,185,185,186,186,186,232,187,187,187,188,188,188,234,189,189,185,185,191,191,186,186,192,192,187,187,193,252,252,252,194,194,190,190,191,191,191,191,192,192,192,192,193,193,253,253,253,194,190,190,190,196,191,191,191,197,192,192,198,193,193,193,199,194,195,195,195,196,196,196,197,197,197,197,198,198,198,153,199,199,160,160,211,166,161,161,212,207,162,162,208,163,163,214,209,169,160,160,211,206,161,161,212,207,162,162,208,168,163,214,214,169,165,165,211,166,166,161,212,212,167,162,213,168,163,163,214,169,165,165,211,171,166,166,212,172,172,167,213,173,168,163,214,174,170,170,216,171,171,171,217,172,172,172,218,173,173,219,219,174,170,170,170,216,171,171,217,217,177,172,218,178,173,173,219,179,175,175,175,176,176,176,222,177,177,177,178,178,178,173,179,179,175,175,175,221,176,176,222,222,177,177,177,178,178,178,224,179,180,221,221,221,181,176,222,222,182,223,223,183,178,178,224,224,180,180,180,181,181,181,227,182,182,182,183,183,183,229,229,184,180,180,180,180,181,181,227,227,182,182,228,183,183,183,229,189,185,185,185,186,186,186,232,187,187,187,188,188,188,234,189,189,185,185,185,185,186,186,232,232,187,187,233,188,252,252,234,234,190,190,190,191,191,191,237,192,192,192,193,193,253,253,253,194,190,190,190,190,191,191,237,237,192,192,238,193,193,254,254,254,195,195,195,196,196,196,191,197,197,192,198,198,193,193,199,199,205,160,206,206,201,161,212,207,202,213,208,203,163,214,209,204,205,160,211,206,161,161,212,207,207,213,208,203,163,214,214,209,205,160,211,211,206,161,212,212,207,213,213,208,163,214,214,209,210,165,211,211,166,166,217,212,212,167,213,213,168,168,214,214,215,210,216,211,171,166,217,217,212,218,218,213,173,219,219,214,215,170,216,216,216,171,217,217,217,172,218,218,173,173,219,219,215,215,216,216,216,171,171,217,217,177,218,218,178,173,219,219,220,175,221,221,176,176,222,222,177,223,223,218,178,224,224,224,220,221,221,221,221,176,222,222,222,223,223,223,178,224,224,224,220,220,221,221,221,181,227,222,222,228,223,223,223,229,229,224,225,225,226,226,226,181,227,227,227,228,228,228,183,229,229,229,225,225,226,226,226,226,232,227,227,233,228,228,228,234,229,229,230,231,231,231,231,186,232,232,232,233,233,233,188,234,234,234,230,230,230,231,231,186,232,232,232,238,233,233,233,253,253,234,236,236,236,236,236,191,237,237,192,192,238,238,193,254,254,254,235,235,236,236,236,191,237,237,237,192,238,238,193,193,239,239,200,200,206,206,201,201,207,207,202,202,208,203,203,214,209,209,205,205,206,206,201,201,212,207,202,213,208,203,203,214,214,209,205,205,211,206,206,201,212,212,207,202,213,208,203,214,214,209,210,210,211,211,211,206,212,212,212,207,213,213,208,203,214,214,210,210,216,211,211,211,217,217,212,218,218,213,213,219,219,214,215,215,216,216,216,211,217,217,217,212,218,218,213,213,219,219,215,215,215,216,216,216,171,217,217,217,218,218,218,218,219,219,215,215,221,216,216,216,222,222,217,217,223,218,218,224,224,219,220,220,221,221,221,221,222,222,222,223,223,223,223,224,224,224,220,220,221,221,221,221,222,222,222,222,223,223,223,229,224,224,225,225,226,226,221,221,227,227,227,228,228,228,223,223,229,229,225,225,225,226,226,226,227,227,227,227,228,228,228,228,229,229,230,231,231,231,231,226,232,232,232,227,233,228,228,234,234,234,230,230,230,231,231,231,232,232,232,232,233,233,233,254,234,234,230,230,230,236,231,231,237,237,232,232,238,233,233,233,254,254,235,235,236,236,236,236,237,237,237,237,238,238,238,193,239,239).map { it.toByte() }

    /**
     * Burkes Kernel.
     * https://tannerhelland.com/2012/12/28/dithering-eleven-algorithms-source-code.html
     */
    private val ditherKernel = floatArrayOf(
        7f/16f,
        3f/16f,5f/16f,1f/16f,
    )

    private val bayerKernels = arrayOf(
        intArrayOf(
            0,8,2,10,
            12,4,14,6,
            3,11,1,9,
            15,7,13,5,
        ),
        intArrayOf(
            8,2,10,0,
            4,14,6,12,
            11,1,9,3,
            7,13,5,15,
        ),
        intArrayOf(
            7,13,5,15,
            8,2,10,0,
            4,14,6,12,
            11,1,9,3,
        ),
        intArrayOf(
            15,7,13,5,
            0,8,2,10,
            12,4,14,6,
            3,11,1,9,
        )
    ).map{ it.map { (it.toFloat() + 0.5f) / 16f }.toFloatArray() }

    /**
     * This method always assume that you're using the default palette
     *
     * @param channels number of channels in the image data. 3 will be assumed if unspecified.
     * @param useDither 0: no dither, 1: floyd-steinberd, 2: 4*4 bayer matrix
     */
    fun imageToDisplayableFormat(srcPtr: Int, destPtr: Int, width: Int, height: Int, channels: Int, useDither: Int) {
        val useAlpha = (channels == 4)
        val sign = if (destPtr >= 0) 1 else -1
        val len = width * height
        if (2 == useDither) {
            for (k in 0L until len) {
                val x = (k % width).toInt()
                val y = (k / width).toInt()
                val t = bayerKernels[0][4 * (y % 4) + (x % 4)]

                val r = vm.peek(srcPtr + channels * k + 0)!!.toUint().toFloat() / 255f
                val g = vm.peek(srcPtr + channels * k + 1)!!.toUint().toFloat() / 255f
                val b = vm.peek(srcPtr + channels * k + 2)!!.toUint().toFloat() / 255f
                val a = if (useAlpha) vm.peek(srcPtr + channels * k + 3)!!.toUint().toFloat() / 255f else 1f

                // default palette is 6-8-5 level RGB (plus 15 shades of grey)

                val r1 = t / 5f + r
                val g1 = t / 7f + g
                val b1 = t / 4f + b
                val a1 = t / 1f + a

                val ra = floor(5f * r1)
                val ga = floor(7f * g1)
                val ba = floor(4f * b1)
                val aa = floor(1f * a1)

                val rgb = ra * 40 + ga * 5 + ba

                val q = if (aa < 0.5) 255.toByte() else rgb.toByte()
                vm.poke(destPtr + k*sign, q)
            }
        }
        else if (1 == useDither) {
            val srcimg = UnsafeHelper.allocate(width * height * 4L * channels, this) // array of floats!

            for (k in 0L until len) {
                srcimg.setFloat(channels * k + 0, vm.peek(srcPtr + channels * k + 0)!!.toUint().toFloat() / 255f)
                srcimg.setFloat(channels * k + 1, vm.peek(srcPtr + channels * k + 1)!!.toUint().toFloat() / 255f)
                srcimg.setFloat(channels * k + 2, vm.peek(srcPtr + channels * k + 2)!!.toUint().toFloat() / 255f)
                if (useAlpha) srcimg.setFloat(channels * k + 3, vm.peek(srcPtr + channels * k + 3)!!.toUint().toFloat() / 255f)
            }


            for (k in 0L until len) {

                val or = srcimg.getFloat(channels * k + 0).coerceIn(0f, 1f)
                val og = srcimg.getFloat(channels * k + 1).coerceIn(0f, 1f)
                val ob = srcimg.getFloat(channels * k + 2).coerceIn(0f, 1f) // to remove "overshooting" of which I have no clue why it still occurs
                val oa = if (useAlpha) srcimg.getFloat(channels * k + 3).coerceIn(0f, 1f) else 1f

                val oqr = or.times(15).roundToInt()
                val oqg = og.times(15).roundToInt()
                val oqb = ob.times(15).roundToInt()

                val nc = if (oa < 0.5f) 255.toByte() else clut[oqr*256 + oqg*16 + oqb]
                val (nr, ng, nb, na) = GraphicsAdapter.DEFAULT_PALETTE_NUMBERS_FLOAT[nc.toUint()]

                vm.poke(destPtr + k*sign, nc)

                val qer = or - nr
                val qeg = og - ng
                val qeb = ob - nb
                val qea = if (useAlpha) oa - na else 0f

                val offsets = longArrayOf(
                    k + 1,
                    k + width - 1, k + width, k + width + 1,
                )

                offsets.forEachIndexed { index, offset ->
                    val px = offset % width
                    val py = offset / width
                    if (px in 0 until width && py in 0 until height) {
                        val srcr = srcimg.getFloat(channels * offset + 0)
                        val srcg = srcimg.getFloat(channels * offset + 1)
                        val srcb = srcimg.getFloat(channels * offset + 2)
                        val srca = if (useAlpha) srcimg.getFloat(channels * offset + 3) else 0f
                        srcimg.setFloat(channels * offset + 0, srcr + qer * ditherKernel[index])
                        srcimg.setFloat(channels * offset + 1, srcg + qeg * ditherKernel[index])
                        srcimg.setFloat(channels * offset + 2, srcb + qeb * ditherKernel[index])
                        if (useAlpha) srcimg.setFloat(channels * offset + 3, srca + qea * ditherKernel[index])
                    }
                }
            }

            srcimg.destroy()
        }
        else {
            for (k in 0L until len) {
                val r = vm.peek(srcPtr + channels * k + 0)!!.toUint().ushr(4)
                val g = vm.peek(srcPtr + channels * k + 1)!!.toUint().ushr(4)
                val b = vm.peek(srcPtr + channels * k + 2)!!.toUint().ushr(4)
                val a = if (useAlpha) vm.peek(srcPtr + channels * k + 3)!!.toUint().ushr(4) else 15
                val q = if (a < 8) 255.toByte() else clut[r*256 + g*16 + b]
                vm.poke(destPtr + k*sign, q)
            }
        }
    }

    fun imageToDirectCol(srcPtr: Int, destRG: Int, destBA: Int, width: Int, height: Int, channels: Int, pattern: Int = 0) {
        val useAlpha = (channels == 4)
        val sign = if (destRG >= 0) 1 else -1
        val len = width * height
        if (destRG * destBA < 0) throw IllegalArgumentException("Both destination memories must be on the same domain (both being Usermem or HWmem)")

        for (k in 0L until len) {
            val x = (k % width).toInt()
            val y = (k / width).toInt()
            val t = bayerKernels[pattern % bayerKernels.size][4 * (y % 4) + (x % 4)]

            val r = vm.peek(srcPtr + channels * k + 0)!!.toUint().toFloat() / 255f
            val g = vm.peek(srcPtr + channels * k + 1)!!.toUint().toFloat() / 255f
            val b = vm.peek(srcPtr + channels * k + 2)!!.toUint().toFloat() / 255f
            val a = if (useAlpha) vm.peek(srcPtr + channels * k + 3)!!.toUint().toFloat() / 255f else 1f

            // default palette is 16-16-16 level RGB (plus 15 shades of grey)

            val r1 = t / 15f + r
            val g1 = t / 15f + g
            val b1 = t / 15f + b
            val a1 = t / 15f + a

            val ra = floor(15f * r1)
            val ga = floor(15f * g1)
            val ba = floor(15f * b1)
            val aa = floor(15f * a1)

            vm.poke(destRG + k*sign, (ra.shl(4) or ga).toByte())
            vm.poke(destBA + k*sign, (ba.shl(4) or aa).toByte())
        }
    }

    private fun chromaToFourBits(f: Float): Int {
        return (round(f * 8) + 7).coerceIn(0..15)
    }
    
    fun blockEncodeToYCoCgFourBits(blockX: Int, blockY: Int, srcPtr: Int, width: Int, channels: Int, hasAlpha: Boolean, pattern: Int): List<Any> {
        val Ys = IntArray(16)
        val As = IntArray(16)
        val COs = FloatArray(16)
        val CGs = FloatArray(16)

        for (py in 0..3) { for (px in 0..3) {
            // TODO oob-check
            val ox = blockX * 4 + px
            val oy = blockY * 4 + py
            val t = if (pattern < 0) 0f else bayerKernels[pattern % bayerKernels.size][4 * (py % 4) + (px % 4)]
            val offset = channels * (oy * width + ox)

            val r0 = vm.peek(srcPtr + offset+0L)!!.toUint() / 255f
            val g0 = if (channels == 1) r0 else vm.peek(srcPtr + offset+1L)!!.toUint() / 255f
            val b0 = if (channels == 1) r0 else vm.peek(srcPtr + offset+2L)!!.toUint() / 255f
            val a0 = if (hasAlpha) vm.peek(srcPtr + offset+(channels - 1L))!! / 255f else 1f

            val r = floor((t / 15f + r0) * 15f) / 15f
            val g = floor((t / 15f + g0) * 15f) / 15f
            val b = floor((t / 15f + b0) * 15f) / 15f
            val a = floor((t / 15f + a0) * 15f) / 15f

            val co = r - b // [-1..1]
            val tmp = b + co / 2f
            val cg = g - tmp // [-1..1]
            val y = tmp + cg / 2f // [0..1]

            val index = py * 4 + px
            Ys[index] = round(y * 15)
            As[index] = round(a * 15)
            COs[index] = co
            CGs[index] = cg
        }}
        
        return listOf(Ys, As, COs, CGs)
    }

    fun encodeIpf1(srcPtr: Int, destPtr: Int, width: Int, height: Int, channels: Int, hasAlpha: Boolean, pattern: Int) {
        var writeCount = 0L
        
        for (blockY in 0 until ceil(height / 4f)) {
        for (blockX in 0 until ceil(width / 4f)) {
            val (_1, _2, _3, _4) = blockEncodeToYCoCgFourBits(blockX, blockY, srcPtr, width, channels, hasAlpha, pattern)
            val Ys = _1 as IntArray; val As = _2 as IntArray; val COs = _3 as FloatArray; val CGs = _4 as FloatArray
            
            // subsample by averaging
            val cos1 = chromaToFourBits((COs[0]+ COs[1]+ COs[4]+ COs[5]) / 4f)
            val cos2 = chromaToFourBits((COs[2]+ COs[3]+ COs[6]+ COs[7]) / 4f)
            val cos3 = chromaToFourBits((COs[8]+ COs[9]+ COs[12]+COs[13]) / 4f)
            val cos4 = chromaToFourBits((COs[10]+COs[11]+COs[14]+COs[15]) / 4f)

            val cgs1 = chromaToFourBits((CGs[0]+ CGs[1]+ CGs[4]+ CGs[5]) / 4f)
            val cgs2 = chromaToFourBits((CGs[2]+ CGs[3]+ CGs[6]+ CGs[7]) / 4f)
            val cgs3 = chromaToFourBits((CGs[8]+ CGs[9]+ CGs[12]+CGs[13]) / 4f)
            val cgs4 = chromaToFourBits((CGs[10]+CGs[11]+CGs[14]+CGs[15]) / 4f)

            // append encoded blocks to the file
            val outBlock = destPtr + writeCount

            vm.poke(outBlock+ 0, ((cos2 shl 4) or cos1).toByte())
            vm.poke(outBlock+ 1, ((cos4 shl 4) or cos3).toByte())
            vm.poke(outBlock+ 2, ((cgs2 shl 4) or cgs1).toByte())
            vm.poke(outBlock+ 3, ((cgs4 shl 4) or cgs3).toByte())
            vm.poke(outBlock+ 4, ((Ys[1] shl 4) or Ys[0]).toByte())
            vm.poke(outBlock+ 5, ((Ys[5] shl 4) or Ys[4]).toByte())
            vm.poke(outBlock+ 6, ((Ys[3] shl 4) or Ys[2]).toByte())
            vm.poke(outBlock+ 7, ((Ys[7] shl 4) or Ys[6]).toByte())
            vm.poke(outBlock+ 8, ((Ys[9] shl 4) or Ys[8]).toByte())
            vm.poke(outBlock+ 9, ((Ys[13] shl 4) or Ys[12]).toByte())
            vm.poke(outBlock+10, ((Ys[11] shl 4) or Ys[10]).toByte())
            vm.poke(outBlock+11, ((Ys[15] shl 4) or Ys[14]).toByte())

            if (hasAlpha) {
                vm.poke(outBlock+12, ((As[1] shl 4) or As[0]).toByte())
                vm.poke(outBlock+13, ((As[5] shl 4) or As[4]).toByte())
                vm.poke(outBlock+14, ((As[3] shl 4) or As[2]).toByte())
                vm.poke(outBlock+15, ((As[7] shl 4) or As[6]).toByte())
                vm.poke(outBlock+16, ((As[9] shl 4) or As[8]).toByte())
                vm.poke(outBlock+17, ((As[13] shl 4) or As[12]).toByte())
                vm.poke(outBlock+18, ((As[11] shl 4) or As[10]).toByte())
                vm.poke(outBlock+19, ((As[15] shl 4) or As[14]).toByte())
                writeCount += 8
            }
            writeCount += 12
        }} 
    }

    /**
     * @return non-zero if delta-encoded, 0 if delta encoding is worthless
     */
    fun encodeIpf1d(
        previousPtr: Int, // full iPF picture frame for t minus one
        currentPtr: Int, // full iPF picture frame for t equals zero
        outPtr: Int, // where to write delta-encoded payloads to. Not touched if delta-encoding is worthless
        width: Int, height: Int,
    ): Int {
        var skipCount = 0
        var outOffset = outPtr.toLong()
        val blockSize = 12
        val blocksPerRow = ceil(width / 4f).toInt()
        val blocksPerCol = ceil(height / 4f).toInt()
        val tempBlockA = ByteArray(blockSize)
        val tempBlockB = ByteArray(blockSize)

        var currentState: Byte? = null
        fun emitState(newState: Byte) {
            if (currentState != newState) {
                currentState = newState
                vm.poke(outOffset++, newState)
            }
        }

        fun writeVarInt(n: Int) {
            var value = n
            while (true) {
                val part = value and 0x7F
                value = value ushr 7
                vm.poke(outOffset++, (if (value > 0) (part or 0x80) else part).toByte())
                if (value == 0) break
            }
        }

        val blockBuffer = ArrayList<ByteArray>()

        fun flushBlockBuffer() {
            if (blockBuffer.isNotEmpty()) {
                // change state
                emitState(PATCH)
                // write length
                writeVarInt(blockBuffer.size)
                blockBuffer.forEach {
                    for (i in 0 until blockSize) {
                        vm.poke(outOffset++, it[i])
                    }
                }
                blockBuffer.clear()
            }
        }

        for (blockIndex in 0 until (blocksPerRow * blocksPerCol)) {
            val offsetA = previousPtr.toLong() + blockIndex * blockSize
            val offsetB = currentPtr.toLong() + blockIndex * blockSize

            for (i in 0 until blockSize) {
                tempBlockA[i] = vm.peek(offsetA + i)!!
                tempBlockB[i] = vm.peek(offsetB + i)!!
            }

            if (isSignificantlyDifferent(tempBlockA, tempBlockB)) {
                // [skip payload]
                if (skipCount > 0) {
                    emitState(SKIP)
                    writeVarInt(skipCount)
                }
                skipCount = 0

                // [block payload]
                blockBuffer.add(tempBlockB.copyOf())
            }
            else {
                flushBlockBuffer()
                skipCount++
            }
        }
        flushBlockBuffer()

        vm.poke(outOffset++, -1)

        return (outOffset - outPtr).toInt()
    }

    private fun isSignificantlyDifferent(a: ByteArray, b: ByteArray): Boolean {
        var score = 0.0

        fun contrastWeight(v1: Int, v2: Int, delta: Int, weight: Int): Double {
            val avg = (v1 + v2) / 2.0
            val contrast = if (avg < 4 || avg > 11) 1.5 else 1.0
            return delta * weight * contrast
        }

        // Co (bytes 0–1): 4 nybbles
        val coA = (a[0].toUint()) or ((a[1].toUint()) shl 8)
        val coB = (b[0].toUint()) or ((b[1].toUint()) shl 8)
        for (i in 0 until 4) {
            val va = (coA shr (i * 4)) and 0xF
            val vb = (coB shr (i * 4)) and 0xF
            val delta = abs(va - vb)
            score += contrastWeight(va, vb, delta, 3)
        }

        // Cg (bytes 2–3): 4 nybbles
        val cgA = (a[2].toUint()) or ((a[3].toUint()) shl 8)
        val cgB = (b[2].toUint()) or ((b[3].toUint()) shl 8)
        for (i in 0 until 4) {
            val va = (cgA shr (i * 4)) and 0xF
            val vb = (cgB shr (i * 4)) and 0xF
            val delta = abs(va - vb)
            score += contrastWeight(va, vb, delta, 3)
        }

        // Y (bytes 4–9): 16 nybbles
        for (i in 4 until 10) {
            val byteA = a[i].toUint()
            val byteB = b[i].toUint()

            val yAHigh = (byteA shr 4) and 0xF
            val yALow = byteA and 0xF
            val yBHigh = (byteB shr 4) and 0xF
            val yBLow = byteB and 0xF

            val deltaHigh = abs(yAHigh - yBHigh)
            val deltaLow = abs(yALow - yBLow)

            score += contrastWeight(yAHigh, yBHigh, deltaHigh, 2)
            score += contrastWeight(yALow, yBLow, deltaLow, 2)
        }

        return score > 4.0
    }

    fun encodeIpf2(srcPtr: Int, destPtr: Int, width: Int, height: Int, channels: Int, hasAlpha: Boolean, pattern: Int) {
        var writeCount = 0L

        for (blockY in 0 until ceil(height / 4f)) {
        for (blockX in 0 until ceil(width / 4f)) {
            val (_1, _2, _3, _4) = blockEncodeToYCoCgFourBits(blockX, blockY, srcPtr, width, channels, hasAlpha, pattern)
            val Ys = _1 as IntArray; val As = _2 as IntArray; val COs = _3 as FloatArray; val CGs = _4 as FloatArray

            // subsample by averaging
            val cos1 = chromaToFourBits((COs[0]+COs[1]) / 2f)
            val cos2 = chromaToFourBits((COs[2]+COs[3]) / 2f)
            val cos3 = chromaToFourBits((COs[4]+COs[5]) / 2f)
            val cos4 = chromaToFourBits((COs[6]+COs[7]) / 2f)
            val cos5 = chromaToFourBits((COs[8]+COs[9]) / 2f)
            val cos6 = chromaToFourBits((COs[10]+COs[11]) / 2f)
            val cos7 = chromaToFourBits((COs[12]+COs[13]) / 2f)
            val cos8 = chromaToFourBits((COs[14]+COs[15]) / 2f)

            val cgs1 = chromaToFourBits((CGs[0]+CGs[1]) / 2f)
            val cgs2 = chromaToFourBits((CGs[2]+CGs[3]) / 2f)
            val cgs3 = chromaToFourBits((CGs[4]+CGs[5]) / 2f)
            val cgs4 = chromaToFourBits((CGs[6]+CGs[7]) / 2f)
            val cgs5 = chromaToFourBits((CGs[8]+CGs[9]) / 2f)
            val cgs6 = chromaToFourBits((CGs[10]+CGs[11]) / 2f)
            val cgs7 = chromaToFourBits((CGs[12]+CGs[13]) / 2f)
            val cgs8 = chromaToFourBits((CGs[14]+CGs[15]) / 2f)

            // append encoded blocks to the file
            val outBlock = destPtr + writeCount

            vm.poke(outBlock+ 0, ((cos2 shl 4) or cos1).toByte())
            vm.poke(outBlock+ 1, ((cos4 shl 4) or cos3).toByte())
            vm.poke(outBlock+ 2, ((cos6 shl 4) or cos5).toByte())
            vm.poke(outBlock+ 3, ((cos8 shl 4) or cos7).toByte())
            vm.poke(outBlock+ 4, ((cgs2 shl 4) or cgs1).toByte())
            vm.poke(outBlock+ 5, ((cgs4 shl 4) or cgs3).toByte())
            vm.poke(outBlock+ 6, ((cgs6 shl 4) or cgs5).toByte())
            vm.poke(outBlock+ 7, ((cgs8 shl 4) or cgs7).toByte())
            vm.poke(outBlock+ 8, ((Ys[1] shl 4) or Ys[0]).toByte())
            vm.poke(outBlock+ 9, ((Ys[5] shl 4) or Ys[4]).toByte())
            vm.poke(outBlock+10, ((Ys[3] shl 4) or Ys[2]).toByte())
            vm.poke(outBlock+11, ((Ys[7] shl 4) or Ys[6]).toByte())
            vm.poke(outBlock+12, ((Ys[9] shl 4) or Ys[8]).toByte())
            vm.poke(outBlock+13, ((Ys[13] shl 4) or Ys[12]).toByte())
            vm.poke(outBlock+14, ((Ys[11] shl 4) or Ys[10]).toByte())
            vm.poke(outBlock+15, ((Ys[15] shl 4) or Ys[14]).toByte())

            if (hasAlpha) {
                vm.poke(outBlock+16, ((As[1] shl 4) or As[0]).toByte())
                vm.poke(outBlock+17, ((As[5] shl 4) or As[4]).toByte())
                vm.poke(outBlock+18, ((As[3] shl 4) or As[2]).toByte())
                vm.poke(outBlock+19, ((As[7] shl 4) or As[6]).toByte())
                vm.poke(outBlock+20, ((As[9] shl 4) or As[8]).toByte())
                vm.poke(outBlock+21, ((As[13] shl 4) or As[12]).toByte())
                vm.poke(outBlock+22, ((As[11] shl 4) or As[10]).toByte())
                vm.poke(outBlock+23, ((As[15] shl 4) or As[14]).toByte())
                writeCount += 8
            }
            writeCount += 16
        }}
    }

    private fun clampRGB(f: Float) = f.coerceIn(0f, 1f)
    private fun ipf1YcocgToRGB(co: Int, cg: Int, ys: Int, As: Int): Array<Int> { // ys: 4 Y-values
        // return [R1|G1, B1|A1, R2|G2, B2|A2, R3|G3, B3|A3, R4|G4, B4|A4]

//    cocg = 0x7777
//    ys = 0x7777

        val co = (co - 7) / 8f
        val cg = (cg - 7) / 8f

        val y1 = (ys and 15) / 15f
        val a1 = As and 15
        var tmp = y1 - cg / 2f
        val g1 = clampRGB(cg + tmp)
        val b1 = clampRGB(tmp - co / 2f)
        val r1 = clampRGB(b1 + co)

        val y2 = ((ys shr 4) and 15) / 15f
        val a2 = (As shr 4) and 15
        tmp = y2 - cg / 2f
        val g2 = clampRGB(cg + tmp)
        val b2 = clampRGB(tmp - co / 2f)
        val r2 = clampRGB(b2 + co)

        val y3 = ((ys shr 8) and 15) / 15f
        val a3 = (As shr 8) and 15
        tmp = y3 - cg / 2f
        val g3 = clampRGB(cg + tmp)
        val b3 = clampRGB(tmp - co / 2f)
        val r3 = clampRGB(b3 + co)

        val y4 = ((ys shr 12) and 15) / 15f
        val a4 = (As shr 12) and 15
        tmp = y4 - cg / 2f
        val g4 = clampRGB(cg + tmp)
        val b4 = clampRGB(tmp - co / 2f)
        val r4 = clampRGB(b4 + co)

        return arrayOf(
            (round(r1 * 15) shl 4) or round(g1 * 15),
            (round(b1 * 15) shl 4) or a1,
            (round(r2 * 15) shl 4) or round(g2 * 15),
            (round(b2 * 15) shl 4) or a2,
            (round(r3 * 15) shl 4) or round(g3 * 15),
            (round(b3 * 15) shl 4) or a3,
            (round(r4 * 15) shl 4) or round(g4 * 15),
            (round(b4 * 15) shl 4) or a4,
        )
    }

    private fun ipf2YcocgToRGB(co1: Int, co2: Int, cg1: Int, cg2: Int, ys: Int, As: Int): Array<Int> { // ys: 4 Y-values
        // return [R1|G1, B1|A1, R2|G2, B2|A2, R3|G3, B3|A3, R4|G4, B4|A4]

//    cocg = 0x7777
//    ys = 0x7777

        val co1 = (co1 - 7) / 8f
        val co2 = (co2 - 7) / 8f
        val cg1 = (cg1 - 7) / 8f
        val cg2 = (cg2 - 7) / 8f

        val y1 = (ys and 15) / 15f
        val a1 = As and 15
        var tmp = y1 - cg1 / 2f
        val g1 = clampRGB(cg1 + tmp)
        val b1 = clampRGB(tmp - co1 / 2f)
        val r1 = clampRGB(b1 + co1)

        val y2 = ((ys shr 4) and 15) / 15f
        val a2 = (As shr 4) and 15
        tmp = y2 - cg1 / 2f
        val g2 = clampRGB(cg1 + tmp)
        val b2 = clampRGB(tmp - co1 / 2f)
        val r2 = clampRGB(b2 + co1)

        val y3 = ((ys shr 8) and 15) / 15f
        val a3 = (As shr 8) and 15
        tmp = y3 - cg2 / 2f
        val g3 = clampRGB(cg2 + tmp)
        val b3 = clampRGB(tmp - co2 / 2f)
        val r3 = clampRGB(b3 + co2)

        val y4 = ((ys shr 12) and 15) / 15f
        val a4 = (As shr 12) and 15
        tmp = y4 - cg2 / 2f
        val g4 = clampRGB(cg2 + tmp)
        val b4 = clampRGB(tmp - co2 / 2f)
        val r4 = clampRGB(b4 + co2)

        return arrayOf(
            (round(r1 * 15) shl 4) or round(g1 * 15),
            (round(b1 * 15) shl 4) or a1,
            (round(r2 * 15) shl 4) or round(g2 * 15),
            (round(b2 * 15) shl 4) or a2,
            (round(r3 * 15) shl 4) or round(g3 * 15),
            (round(b3 * 15) shl 4) or a3,
            (round(r4 * 15) shl 4) or round(g4 * 15),
            (round(b4 * 15) shl 4) or a4,
        )
    }

    fun decodeIpf1(srcPtr: Int, destRG: Int, destBA: Int, width: Int, height: Int, hasAlpha: Boolean) {
        val sign = if (destRG >= 0) 1 else -1
        if (destRG * destBA < 0) throw IllegalArgumentException("Both destination memories must be on the same domain (both being Usermem or HWmem)")
        val sptr = srcPtr.toLong()
        val dptr1 = destRG.toLong()
        val dptr2 = destBA.toLong()
        var readCount = 0
        fun readShort() =
            vm.peek(sptr + readCount++)!!.toUint() or vm.peek(sptr + readCount++)!!.toUint().shl(8)


        for (blockY in 0 until ceil(height / 4f)) {
        for (blockX in 0 until ceil(width / 4f)) {
            val rg = IntArray(16) // [R1G1, R2G2, R3G3, R4G4, ...]
            val ba = IntArray(16)

            val co = readShort()
            val cg = readShort()
            val y1 = readShort()
            val y2 = readShort()
            val y3 = readShort()
            val y4 = readShort()

            var a1 = 65535; var a2 = 65535; var a3 = 65535; var a4 = 65535

            if (hasAlpha) {
                a1 = readShort()
                a2 = readShort()
                a3 = readShort()
                a4 = readShort()
            }

            var corner = ipf1YcocgToRGB(co and 15, cg and 15, y1, a1)
            rg[0] = corner[0];ba[0] = corner[1]
            rg[1] = corner[2];ba[1] = corner[3]
            rg[4] = corner[4];ba[4] = corner[5]
            rg[5] = corner[6];ba[5] = corner[7]

            corner = ipf1YcocgToRGB((co shr 4) and 15, (cg shr 4) and 15, y2, a2)
            rg[2] = corner[0];ba[2] = corner[1]
            rg[3] = corner[2];ba[3] = corner[3]
            rg[6] = corner[4];ba[6] = corner[5]
            rg[7] = corner[6];ba[7] = corner[7]

            corner = ipf1YcocgToRGB((co shr 8) and 15, (cg shr 8) and 15, y3, a3)
            rg[8] = corner[0];ba[8] = corner[1]
            rg[9] = corner[2];ba[9] = corner[3]
            rg[12] = corner[4];ba[12] = corner[5]
            rg[13] = corner[6];ba[13] = corner[7]

            corner = ipf1YcocgToRGB((co shr 12) and 15, (cg shr 12) and 15, y4, a4)
            rg[10] = corner[0];ba[10] = corner[1]
            rg[11] = corner[2];ba[11] = corner[3]
            rg[14] = corner[4];ba[14] = corner[5]
            rg[15] = corner[6];ba[15] = corner[7]


            // move decoded pixels into memory
            for (py in 0..3) { for (px in 0..3) {
                val ox = blockX * 4 + px
                val oy = blockY * 4 + py
                val offset = oy * 560 + ox
                vm.poke(dptr1 + offset*sign, rg[py * 4 + px].toByte())
                vm.poke(dptr2 + offset*sign, ba[py * 4 + px].toByte())
            }}
        }}
    }

    fun applyIpf1d(ipf1DeltaPtr: Int, destRG: Int, destBA: Int, width: Int, height: Int) {
        val BLOCK_SIZE = 12
        val blocksPerRow = (width + 3) / 4
        val totalBlocks = ((width + 3) / 4) * ((height + 3) / 4)

        val gpu = getFirstGPU()
        val sign = if (destRG >= 0) 1 else -1
        if (destRG * destBA < 0) throw IllegalArgumentException("Both destination memories must be on the same domain")

        var ptr = ipf1DeltaPtr.toLong()
        var blockIndex = 0

        fun readByte(): Int = vm.peek(ptr++)!!.toUint()
        fun readShort(): Int {
            val low = readByte()
            val high = readByte()
            return low or (high shl 8)
        }

        fun readVarInt(): Int {
            var value = 0
            var shift = 0
            while (true) {
                val byte = readByte()
                value = value or ((byte and 0x7F) shl shift)
                if ((byte and 0x80) == 0) break
                shift += 7
            }
            return value
        }

        while (true) {
            val opcode = readByte().toByte()
            when (opcode) {
                SKIP -> { // Skip blocks
                    val count = readVarInt()
                    blockIndex += count
                }

                PATCH -> { // Write literal patch
                    val count = readVarInt()

                    for (i in 0 until count) {
                        if (blockIndex >= totalBlocks) break

                        val co = readShort()
                        val cg = readShort()
                        val y1 = readShort()
                        val y2 = readShort()
                        val y3 = readShort()
                        val y4 = readShort()

                        val rg = IntArray(16)
                        val ba = IntArray(16)

                        var px = ipf1YcocgToRGB(co and 15, cg and 15, y1, 65535)
                        rg[0] = px[0]; ba[0] = px[1]
                        rg[1] = px[2]; ba[1] = px[3]
                        rg[4] = px[4]; ba[4] = px[5]
                        rg[5] = px[6]; ba[5] = px[7]

                        px = ipf1YcocgToRGB((co shr 4) and 15, (cg shr 4) and 15, y2, 65535)
                        rg[2] = px[0]; ba[2] = px[1]
                        rg[3] = px[2]; ba[3] = px[3]
                        rg[6] = px[4]; ba[6] = px[5]
                        rg[7] = px[6]; ba[7] = px[7]

                        px = ipf1YcocgToRGB((co shr 8) and 15, (cg shr 8) and 15, y3, 65535)
                        rg[8] = px[0]; ba[8] = px[1]
                        rg[9] = px[2]; ba[9] = px[3]
                        rg[12] = px[4]; ba[12] = px[5]
                        rg[13] = px[6]; ba[13] = px[7]

                        px = ipf1YcocgToRGB((co shr 12) and 15, (cg shr 12) and 15, y4, 65535)
                        rg[10] = px[0]; ba[10] = px[1]
                        rg[11] = px[2]; ba[11] = px[3]
                        rg[14] = px[4]; ba[14] = px[5]
                        rg[15] = px[6]; ba[15] = px[7]

                        val blockX = blockIndex % blocksPerRow
                        val blockY = blockIndex / blocksPerRow

                        for (py in 0..3) {
                            for (pxi in 0..3) {
                                val ox = blockX * 4 + pxi
                                val oy = blockY * 4 + py
                                if (ox < width && oy < height) {
                                    val offset = oy * 560 + ox
                                    val i = py * 4 + pxi
                                    vm.poke((destRG + offset * sign).toLong(), rg[i].toByte())
                                    vm.poke((destBA + offset * sign).toLong(), ba[i].toByte())
                                }
                            }
                        }

                        blockIndex++
                    }
                }

                REPEAT -> { // Repeat last literal
                    val repeatCount = readVarInt()
                    repeat(repeatCount) {
                        // Just skip applying. We assume previous patch was already applied visually.
                        blockIndex++
                    }
                }

                END -> return // End of stream
                else -> error("Unknown delta opcode: ${opcode.toString(16)}")
            }
        }
    }


    fun decodeIpf2(srcPtr: Int, destRG: Int, destBA: Int, width: Int, height: Int, hasAlpha: Boolean) {
        val sign = if (destRG >= 0) 1 else -1
        if (destRG * destBA < 0) throw IllegalArgumentException("Both destination memories must be on the same domain (both being Usermem or HWmem)")
        val sptr = srcPtr.toLong()
        val dptr1 = destRG.toLong()
        val dptr2 = destBA.toLong()
        var readCount = 0
        fun readShort() =
            vm.peek(sptr + readCount++)!!.toUint() or vm.peek(sptr + readCount++)!!.toUint().shl(8)
        fun readInt() =
            vm.peek(sptr + readCount++)!!.toUint() or vm.peek(sptr + readCount++)!!.toUint().shl(8) or vm.peek(sptr + readCount++)!!.toUint().shl(16) or vm.peek(sptr + readCount++)!!.toUint().shl(24)


        for (blockY in 0 until ceil(height / 4f)) {
        for (blockX in 0 until ceil(width / 4f)) {
            val rg = IntArray(16) // [R1G1, R2G2, R3G3, R4G4, ...]
            val ba = IntArray(16)

            val co = readInt()
            val cg = readInt()
            val y1 = readShort()
            val y2 = readShort()
            val y3 = readShort()
            val y4 = readShort()

            var a1 = 65535; var a2 = 65535; var a3 = 65535; var a4 = 65535

            if (hasAlpha) {
                a1 = readShort()
                a2 = readShort()
                a3 = readShort()
                a4 = readShort()
            }

            var corner = ipf2YcocgToRGB(co and 15, (co shr 8) and 15, cg and 15, (cg shr 8) and 15, y1, a1)
            rg[0] = corner[0];ba[0] = corner[1]
            rg[1] = corner[2];ba[1] = corner[3]
            rg[4] = corner[4];ba[4] = corner[5]
            rg[5] = corner[6];ba[5] = corner[7]

            corner = ipf2YcocgToRGB((co shr 4) and 15, (co shr 12) and 15, (cg shr 4) and 15, (cg shr 12) and 15, y2, a2)
            rg[2] = corner[0];ba[2] = corner[1]
            rg[3] = corner[2];ba[3] = corner[3]
            rg[6] = corner[4];ba[6] = corner[5]
            rg[7] = corner[6];ba[7] = corner[7]

            corner = ipf2YcocgToRGB((co shr 16) and 15, (co shr 24) and 15, (cg shr 16) and 15, (cg shr 24) and 15, y3, a3)
            rg[8] = corner[0];ba[8] = corner[1]
            rg[9] = corner[2];ba[9] = corner[3]
            rg[12] = corner[4];ba[12] = corner[5]
            rg[13] = corner[6];ba[13] = corner[7]

            corner = ipf2YcocgToRGB((co shr 20) and 15, (co shr 28) and 15, (cg shr 20) and 15, (cg shr 28) and 15, y4, a4)
            rg[10] = corner[0];ba[10] = corner[1]
            rg[11] = corner[2];ba[11] = corner[3]
            rg[14] = corner[4];ba[14] = corner[5]
            rg[15] = corner[6];ba[15] = corner[7]


            // move decoded pixels into memory
            for (py in 0..3) { for (px in 0..3) {
                val ox = blockX * 4 + px
                val oy = blockY * 4 + py
                val offset = oy * 560 + ox
                vm.poke(dptr1 + offset*sign, rg[py * 4 + px].toByte())
                vm.poke(dptr2 + offset*sign, ba[py * 4 + px].toByte())
            }}
        }}
    }


    private val SKIP = 0x00.toByte()
    private val PATCH = 0x01.toByte()
    private val REPEAT = 0x02.toByte()
    private val END = 0xFF.toByte()

    // TEV (TSVM Enhanced Video) format support
    // Created by Claude on 2025-08-17

    // Reusable working arrays to reduce allocation overhead
    private val tevIdct8TempBuffer = FloatArray(64)
    private val tevIdct16TempBuffer = FloatArray(256) // For 16x16 IDCT
    private val tevIdct16SeparableBuffer = FloatArray(256) // For separable 16x16 IDCT

    fun jpeg_quality_to_mult(q: Float): Float {
        return (if ((q < 50)) 5000f / q else 200f - 2 * q) / 100f
    }

    // Quality settings for quantisation (Y channel) - 16x16 tables
    val QUANT_TABLE_Y: IntArray = intArrayOf(
        16, 14, 12, 11, 11, 13, 16, 20, 24, 30, 39, 48, 54, 61, 67, 73,
        14, 13, 12, 12, 12, 15, 18, 21, 25, 33, 46, 57, 61, 65, 67, 70,
        13, 12, 12, 13, 14, 17, 19, 23, 27, 36, 53, 66, 68, 69, 68, 67,
        13, 13, 13, 14, 15, 18, 22, 26, 32, 41, 56, 67, 71, 74, 70, 67,
        14, 14, 14, 15, 17, 20, 24, 30, 38, 47, 58, 68, 74, 79, 73, 67,
        15, 15, 15, 17, 19, 22, 27, 34, 44, 55, 68, 79, 83, 85, 78, 70,
        15, 16, 17, 20, 22, 26, 30, 38, 49, 63, 81, 94, 93, 91, 83, 74,
        16, 18, 20, 24, 28, 33, 38, 47, 57, 73, 93, 108, 105, 101, 91, 81,
        19, 21, 23, 29, 35, 43, 52, 60, 68, 83, 105, 121, 118, 115, 102, 89,
        21, 24, 27, 35, 43, 53, 62, 70, 78, 91, 113, 128, 127, 125, 112, 99,
        25, 30, 34, 43, 53, 61, 68, 76, 85, 97, 114, 127, 130, 132, 120, 108,
        31, 38, 44, 54, 64, 71, 76, 84, 94, 105, 118, 129, 135, 138, 127, 116,
        45, 52, 60, 69, 78, 84, 90, 97, 107, 118, 130, 139, 142, 143, 133, 122,
        59, 68, 76, 84, 91, 97, 102, 110, 120, 129, 139, 147, 147, 146, 137, 127,
        73, 82, 92, 98, 103, 107, 110, 117, 126, 132, 134, 136, 138, 138, 133, 127,
        86, 98, 109, 112, 114, 116, 118, 124, 133, 135, 129, 125, 128, 130, 128, 127)

    // Quality settings for quantisation (Co channel - orange-blue, 8x8)
    val QUANT_TABLE_C: IntArray =  intArrayOf(
        17, 18, 24, 47, 99, 99, 99, 99,
        18, 21, 26, 66, 99, 99, 99, 99,
        24, 26, 56, 99, 99, 99, 99, 99,
        47, 66, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99)

    /**
     * Upload RGB frame buffer to graphics framebuffer with dithering
     * @param rgbAddr Source RGB buffer (24-bit: R,G,B bytes)
     * @param width Frame width
     * @param height Frame height
     * @param frameCount Frame counter for dithering
     */
    fun uploadRGBToFramebuffer(rgbAddr: Long, width: Int, height: Int, frameCount: Int) {
        uploadRGBToFramebuffer(rgbAddr, width, height, frameCount, false)
    }

    /**
     * Bulk peek RGB data from VM memory, handling both user and peripheral memory
     */
    private fun bulkPeekRGB(startAddr: Long, numPixels: Int, rgbAddrIncVec: Int, destBuffer: ByteArray) {
        val totalBytes = numPixels * 3
        
        // Bounds check to prevent buffer overflow
        if (totalBytes > destBuffer.size) {
            throw IllegalArgumentException("Required bytes ($totalBytes) exceeds buffer size (${destBuffer.size})")
        }
        
        if (totalBytes <= 0) {
            return // Nothing to read
        }
        
        val (memspace, offset) = vm.translateAddr(startAddr)
        
        if (memspace is UnsafePtr) {
            // Check bounds for UnsafePtr
            val endAddr = if (rgbAddrIncVec == 1) offset + totalBytes else offset
            if (endAddr < 0 || endAddr >= memspace.size) {
                // Fallback to individual peeks with bounds checking
                for (i in 0 until totalBytes) {
                    val addr = offset + i * rgbAddrIncVec
                    destBuffer[i] = if (addr >= 0 && addr < memspace.size) {
                        memspace.get(addr)
                    } else {
                        0
                    }
                }
                return
            }
            
            // Direct memory access for user memory
            if (rgbAddrIncVec == 1) {
                // Forward direction - single bulk copy
                UnsafeHelper.memcpyRaw(null, memspace.ptr + offset, 
                    destBuffer, UnsafeHelper.getArrayOffset(destBuffer), totalBytes.toLong())
            } else {
                // Backward direction - reverse copy with bounds checking
                for (i in 0 until totalBytes) {
                    val addr = offset - i
                    destBuffer[i] = if (addr >= 0 && addr < memspace.size) {
                        memspace.get(addr)
                    } else {
                        0
                    }
                }
            }
        } else if (memspace is PeriBase) {
            // Peripheral memory - still need individual peeks
            for (i in 0 until totalBytes) {
                destBuffer[i] = memspace.peek(offset + i * rgbAddrIncVec) ?: 0
            }
        } else {
            // Invalid memory - fill with zeros
            for (i in 0 until kotlin.math.min(totalBytes, destBuffer.size)) {
                destBuffer[i] = 0
            }
        }
    }

    /**
     * Upload RGB frame buffer to graphics framebuffer with dithering and optional resize
     * @param rgbAddr Source RGB buffer (24-bit: R,G,B bytes)
     * @param width Frame width
     * @param height Frame height
     * @param frameCount Frame counter for dithering
     * @param resizeToFull If true, resize video to fill entire screen; if false, center video
     */
    fun uploadRGBToFramebuffer(rgbAddr: Long, width: Int, height: Int, frameCount: Int, resizeToFull: Boolean) {
        val gpu = (vm.peripheralTable[1].peripheral as GraphicsAdapter)
        val graphicsMode = gpu.graphicsMode

        val rgbAddrIncVec = if (rgbAddr >= 0) 1 else -1

        // Get native resolution
        val nativeWidth = gpu.config.width
        val nativeHeight = gpu.config.height
        val totalNativePixels = (nativeWidth * nativeHeight)
        val totalVideoPixels = width * height

        val chunkSize = 32768
        val rgbBulkBuffer = ByteArray(chunkSize * 3)
        val rgChunk = ByteArray(chunkSize)
        val baChunk = ByteArray(chunkSize)
        val rChunk = ByteArray(chunkSize)
        val gChunk = ByteArray(chunkSize)
        val bChunk = ByteArray(chunkSize)
        val aChunk = ByteArray(chunkSize); aChunk.fill(-1)
        var pixelsProcessed = 0

        // Helper function to write chunks to framebuffer (shared between native size and resize paths)
        fun writeChunksToFramebuffer(
            pixelsInChunk: Int,
            rgChunk: ByteArray, baChunk: ByteArray,
            rChunk: ByteArray, gChunk: ByteArray, bChunk: ByteArray, aChunk: ByteArray
        ) {
            val pixelIndex = pixelsProcessed
            val videoY = pixelIndex / width
            val videoX = pixelIndex % width
            val nativePos = videoY * nativeWidth + videoX
            if (graphicsMode == 4) {
                UnsafeHelper.memcpyRaw(
                    rgChunk, UnsafeHelper.getArrayOffset(rgChunk),
                    null, gpu.framebuffer.ptr + nativePos, pixelsInChunk.toLong()
                )
                UnsafeHelper.memcpyRaw(
                    baChunk, UnsafeHelper.getArrayOffset(baChunk),
                    null, gpu.framebuffer2!!.ptr + nativePos, pixelsInChunk.toLong()
                )
            }
            else if (graphicsMode == 5) {
                UnsafeHelper.memcpyRaw(
                    rChunk, UnsafeHelper.getArrayOffset(rChunk),
                    null, gpu.framebuffer.ptr + nativePos, pixelsInChunk.toLong()
                )
                UnsafeHelper.memcpyRaw(
                    gChunk, UnsafeHelper.getArrayOffset(gChunk),
                    null, gpu.framebuffer2!!.ptr + nativePos, pixelsInChunk.toLong()
                )
                UnsafeHelper.memcpyRaw(
                    bChunk, UnsafeHelper.getArrayOffset(bChunk),
                    null, gpu.framebuffer3!!.ptr + nativePos, pixelsInChunk.toLong()
                )
                UnsafeHelper.memcpyRaw(
                    aChunk, UnsafeHelper.getArrayOffset(aChunk),
                    null, gpu.framebuffer4!!.ptr + nativePos, pixelsInChunk.toLong()
                )
            }

            pixelsProcessed += pixelsInChunk
        }

        fun writeToChunk(r: Int, g: Int, b: Int, videoX: Int, videoY: Int, i: Int) {
            if (graphicsMode == 4) {
                // Apply Bayer dithering and convert to 4-bit
                val r4 = ditherValue(r, videoX, videoY, frameCount)
                val g4 = ditherValue(g, videoX, videoY, frameCount)
                val b4 = ditherValue(b, videoX, videoY, frameCount)

                // Pack RGB values and store in chunk arrays for batch processing
                rgChunk[i] = ((r4 shl 4) or g4).toByte()
                baChunk[i] = ((b4 shl 4) or 15).toByte()

            }
            else if (graphicsMode == 5) {
                rChunk[i] = r.toByte()
                gChunk[i] = g.toByte()
                bChunk[i] = b.toByte()
            }
        }

        if (width == nativeWidth && height == nativeHeight) {
            while (pixelsProcessed < totalNativePixels) {
                val pixelsInChunk = kotlin.math.min(chunkSize, totalNativePixels - pixelsProcessed)
                val rgbStartAddr = rgbAddr + (pixelsProcessed.toLong() * 3) * rgbAddrIncVec

                // Bulk read RGB data for this chunk
                bulkPeekRGB(rgbStartAddr, pixelsInChunk, rgbAddrIncVec, rgbBulkBuffer)

                // Process pixels using bulk-read data
                for (i in 0 until pixelsInChunk) {
                    val pixelIndex = pixelsProcessed + i
                    val videoY = pixelIndex / width
                    val videoX = pixelIndex % width

                    // Read RGB values from bulk buffer
                    val r = rgbBulkBuffer[i*3].toUint()
                    val g = rgbBulkBuffer[i*3 + 1].toUint()
                    val b = rgbBulkBuffer[i*3 + 2].toUint()

                    writeToChunk(r, g, b, videoX, videoY, i)
                }

                // Write chunks to framebuffer
                writeChunksToFramebuffer(pixelsInChunk, rgChunk, baChunk, rChunk, gChunk, bChunk, aChunk)
            }
        }
        else if (resizeToFull && (width / 2 != nativeWidth / 2 || height / 2 != nativeHeight / 2)) {
            // Calculate scaling factors for resize-to-full (source to native mapping)
            val scaleX = width.toFloat() / nativeWidth.toFloat()
            val scaleY = height.toFloat() / nativeHeight.toFloat()

            while (pixelsProcessed < totalNativePixels) {
                val pixelsInChunk = kotlin.math.min(chunkSize, (totalNativePixels - pixelsProcessed).toInt())

                // Batch process chunk of pixels
                for (i in 0 until pixelsInChunk) {
                    val nativePixelIndex = pixelsProcessed + i
                    val nativeY = nativePixelIndex / nativeWidth
                    val nativeX = nativePixelIndex % nativeWidth

                    // Map native pixel to source video coordinates for bilinear sampling
                    val videoX = nativeX * scaleX
                    val videoY = nativeY * scaleY

                    // Sample RGB values using bilinear interpolation (optimised version)
                    val rgb = sampleBilinearOptimised(rgbAddr, width, height, videoX, videoY, rgbAddrIncVec)
                    val r = rgb[0]
                    val g = rgb[1]
                    val b = rgb[2]

                    writeToChunk(r, g, b, nativeX, nativeY, i)
                }

                // Write chunks to framebuffer
                writeChunksToFramebuffer(pixelsInChunk, rgChunk, baChunk, rChunk, gChunk, bChunk, aChunk)
            }
        } else {
            // Optimised centering logic with bulk memory operations
            val offsetX = (nativeWidth - width) / 2
            val offsetY = (nativeHeight - height) / 2

            while (pixelsProcessed < totalVideoPixels) {
                val pixelsInChunk = kotlin.math.min(chunkSize, totalVideoPixels - pixelsProcessed)
                val rgbStartAddr = rgbAddr + (pixelsProcessed.toLong() * 3) * rgbAddrIncVec
                
                // Bulk read RGB data for this chunk
                bulkPeekRGB(rgbStartAddr, pixelsInChunk, rgbAddrIncVec, rgbBulkBuffer)
                
                // Process pixels using bulk-read data
                for (i in 0 until pixelsInChunk) {
                    val pixelIndex = pixelsProcessed + i
                    val videoY = pixelIndex / width
                    val videoX = pixelIndex % width
                    
                    // Calculate position in native framebuffer (centered)
                    val nativeX = videoX + offsetX
                    val nativeY = videoY + offsetY
                    
                    // Skip pixels outside framebuffer bounds
                    if (nativeX !in 0 until nativeWidth || nativeY !in 0 until nativeHeight) {
                        continue
                    }
                    
                    // Read RGB values from bulk buffer
                    val rgbIndex = i * 3
                    val r = rgbBulkBuffer[rgbIndex].toUint()
                    val g = rgbBulkBuffer[rgbIndex + 1].toUint()
                    val b = rgbBulkBuffer[rgbIndex + 2].toUint()

                    writeToChunk(r, g, b, videoX, videoY, i)
                }

                // Write chunks to framebuffer
                writeChunksToFramebuffer(pixelsInChunk, rgChunk, baChunk, rChunk, gChunk, bChunk, aChunk)
            }
        }
    }

    /**
     * Apply Bayer dithering to reduce banding when quantising to 4-bit
     */
    private fun ditherValue(value: Int, x: Int, y: Int, f: Int): Int {
        // Preserve pure values (0 and 255) exactly to maintain colour primaries
        if (value == 0) return 0
        if (value == 255) return 15
        
        val t = bayerKernels[f % 4][4 * (y % 4) + (x % 4)] // use rotating bayerKernel to time-dither the static pattern for even better visuals
        val q = floor((t / 15f + (value / 255f)) * 15f) / 15f
        return round(15f * q)
    }

    /**
     * Sample RGB values using bilinear interpolation
     * @param rgbAddr Source RGB buffer address
     * @param width Source image width
     * @param height Source image height  
     * @param x Floating-point x coordinate in source image
     * @param y Floating-point y coordinate in source image
     * @param rgbAddrIncVec Address increment vector
     * @return IntArray containing interpolated [R, G, B] values
     */
    private fun sampleBilinear(rgbAddr: Long, width: Int, height: Int, x: Float, y: Float, rgbAddrIncVec: Int): IntArray {
        // Clamp coordinates to valid range
        val clampedX = x.coerceIn(0f, (width - 1).toFloat())
        val clampedY = y.coerceIn(0f, (height - 1).toFloat())
        
        // Get integer coordinates and fractional parts
        val x0 = clampedX.toInt()
        val y0 = clampedY.toInt()
        val x1 = kotlin.math.min(x0 + 1, width - 1)
        val y1 = kotlin.math.min(y0 + 1, height - 1)
        
        val fx = clampedX - x0
        val fy = clampedY - y0
        
        // Sample the four corner pixels
        fun samplePixel(px: Int, py: Int): IntArray {
            val pixelIndex = py * width + px
            val rgbOffset = (pixelIndex.toLong() * 3) * rgbAddrIncVec
            return intArrayOf(
                vm.peek(rgbAddr + rgbOffset)!!.toUint(),
                vm.peek(rgbAddr + rgbOffset + rgbAddrIncVec)!!.toUint(),
                vm.peek(rgbAddr + rgbOffset + rgbAddrIncVec * 2)!!.toUint()
            )
        }
        
        val c00 = samplePixel(x0, y0) // top-left
        val c10 = samplePixel(x1, y0) // top-right
        val c01 = samplePixel(x0, y1) // bottom-left
        val c11 = samplePixel(x1, y1) // bottom-right
        
        // Bilinear interpolation
        val result = IntArray(3)
        for (i in 0..2) {
            val top = c00[i] * (1f - fx) + c10[i] * fx
            val bottom = c01[i] * (1f - fx) + c11[i] * fx
            result[i] = (top * (1f - fy) + bottom * fy).toInt().coerceIn(0, 255)
        }
        
        return result
    }

    /**
     * Optimised bilinear sampling with bulk memory access and caching
     */
    private fun sampleBilinearOptimised(rgbAddr: Long, width: Int, height: Int, x: Float, y: Float, rgbAddrIncVec: Int): IntArray {
        // Clamp coordinates to valid range
        val clampedX = x.coerceIn(0f, (width - 1).toFloat())
        val clampedY = y.coerceIn(0f, (height - 1).toFloat())
        
        // Get integer coordinates and fractional parts
        val x0 = clampedX.toInt()
        val y0 = clampedY.toInt()
        val x1 = kotlin.math.min(x0 + 1, width - 1)
        val y1 = kotlin.math.min(y0 + 1, height - 1)
        
        val fx = clampedX - x0
        val fy = clampedY - y0
        
        // Use bulk read for the 4 corner pixels (2x2 block)
        val pixelBuffer = ByteArray(12) // 4 pixels * 3 bytes
        val (memspace, baseOffset) = vm.translateAddr(rgbAddr)
        
        if (memspace is UnsafePtr && rgbAddrIncVec == 1) {
            // Optimised path for user memory with forward addressing
            val y0RowAddr = baseOffset + (y0 * width + x0) * 3
            val y1RowAddr = baseOffset + (y1 * width + x0) * 3
            
            // Read row 0 (top-left, top-right)
            UnsafeHelper.memcpyRaw(null, memspace.ptr + y0RowAddr, 
                pixelBuffer, UnsafeHelper.getArrayOffset(pixelBuffer), 6L) // 2 pixels * 3 bytes
            
            // Read row 1 (bottom-left, bottom-right)  
            UnsafeHelper.memcpyRaw(null, memspace.ptr + y1RowAddr,
                pixelBuffer, UnsafeHelper.getArrayOffset(pixelBuffer) + 6, 6L)
                
            // Extract corner values from bulk-read data
            val c00 = intArrayOf(pixelBuffer[0].toUint(), pixelBuffer[1].toUint(), pixelBuffer[2].toUint())
            val c10 = intArrayOf(pixelBuffer[3].toUint(), pixelBuffer[4].toUint(), pixelBuffer[5].toUint())  
            val c01 = intArrayOf(pixelBuffer[6].toUint(), pixelBuffer[7].toUint(), pixelBuffer[8].toUint())
            val c11 = intArrayOf(pixelBuffer[9].toUint(), pixelBuffer[10].toUint(), pixelBuffer[11].toUint())
            
            // Fast integer-based bilinear interpolation
            val result = IntArray(3)
            for (i in 0..2) {
                val top = c00[i] + ((c10[i] - c00[i]) * fx).toInt()
                val bottom = c01[i] + ((c11[i] - c01[i]) * fx).toInt()
                result[i] = (top + ((bottom - top) * fy).toInt()).coerceIn(0, 255)
            }
            return result
        } else {
            // Fallback to original individual peeks for peripheral memory or reverse addressing
            return sampleBilinear(rgbAddr, width, height, x, y, rgbAddrIncVec)
        }
    }

    val dctBasis8 = Array(8) { u ->
        FloatArray(8) { x ->
            val cu = if (u == 0) 1.0 / sqrt(2.0) else 1.0
            (0.5 * cu * cos((2.0 * x + 1.0) * u * PI / 16.0)).toFloat()
        }
    }

    private fun tevIdct8x8_fast(coeffs: ShortArray, quantTable: IntArray, isChromaResidual: Boolean = false, qualityIndex: Int, rateControlFactor: Float): IntArray {
        val result = IntArray(64)
        // Reuse preallocated temp buffer to reduce GC pressure
        for (i in coeffs.indices) {
            tevIdct8TempBuffer[i] = coeffs[i] * (quantTable[i] * jpeg_quality_to_mult(qualityIndex * rateControlFactor)).coerceIn(1f, 255f)
        }

        // Fast separable IDCT (row-column decomposition)
        // First pass: Process rows (8 1D IDCTs)
        for (row in 0 until 8) {
            for (col in 0 until 8) {
                var sum = 0f
                for (u in 0 until 8) {
                    val coeffIdx = row * 8 + u
                    val coeff = if (isChromaResidual && coeffIdx == 0) {
                        coeffs[coeffIdx].toFloat() // DC lossless for chroma residual
                    } else {
                        coeffs[coeffIdx] * (quantTable[coeffIdx] * jpeg_quality_to_mult(qualityIndex * rateControlFactor)).coerceIn(1f, 255f)
                    }
                    sum += dctBasis8[u][col] * coeff
                }
                tevIdct8TempBuffer[row * 8 + col] = sum
            }
        }

        // Second pass: Process columns (8 1D IDCTs)
        for (col in 0 until 8) {
            for (row in 0 until 8) {
                var sum = 0f
                for (v in 0 until 8) {
                    sum += dctBasis8[v][row] * tevIdct8TempBuffer[v * 8 + col]
                }

                val pixel = if (isChromaResidual) {
                    sum.coerceIn(-256f, 255f)
                } else {
                    (sum + 128f).coerceIn(0f, 255f)
                }
                result[row * 8 + col] = pixel.toInt()
            }
        }

        return result
    }

    val dctBasis16 = Array(16) { u ->
        FloatArray(16) { x ->
            val cu = if (u == 0) 1.0 / sqrt(2.0) else 1.0
            (0.25 * cu * cos((2.0 * x + 1.0) * u * PI / 32.0)).toFloat()
        }
    }
    
    // 16x16 IDCT for Y channel (YCoCg-R format) with boundary-aware deblocking
    private fun tevIdct16x16_fast(coeffs: ShortArray, quantTable: IntArray, qualityIndex: Int, rateControlFactor: Float): IntArray {
        val result = IntArray(256) // 16x16 = 256
        
        // Process coefficients and dequantise using preallocated buffer
        for (u in 0 until 16) {
            for (v in 0 until 16) {
                val idx = u * 16 + v
                val coeff = if (idx == 0) {
                    coeffs[idx].toFloat() // DC lossless for luma
                } else {
                    coeffs[idx] * (quantTable[idx] * jpeg_quality_to_mult(qualityIndex * rateControlFactor)).coerceIn(1f, 255f)
                }
                tevIdct16TempBuffer[idx] = coeff
            }
        }

        // Fast separable IDCT
        // First pass: Process rows (16 1D IDCTs)
        for (row in 0 until 16) {
            for (col in 0 until 16) {
                var sum = 0f
                for (u in 0 until 16) {
                    sum += dctBasis16[u][col] * tevIdct16TempBuffer[row * 16 + u]
                }
                tevIdct16SeparableBuffer[row * 16 + col] = sum
            }
        }
        
        // Second pass: Process columns (16 1D IDCTs)  
        for (col in 0 until 16) {
            for (row in 0 until 16) {
                var sum = 0f
                for (v in 0 until 16) {
                    sum += dctBasis16[v][row] * tevIdct16SeparableBuffer[v * 16 + col]
                }
                val pixel = (sum + 128f).coerceIn(0f, 255f)
                result[row * 16 + col] = pixel.toInt()
            }
        }
        
        return result
    }

    // YCoCg-R to RGB conversion with 4:2:0 chroma upsampling
    // Pre-allocated arrays for chroma component caching (reused across blocks)
    private val cgHalfCache = IntArray(64) // 8x8 cache for cg/2 values
    private val coHalfCache = IntArray(64) // 8x8 cache for co/2 values
    
    // Temporary buffer for interlaced field processing
    private val interlacedFieldBuffer = IntArray(560 * 224 * 3) // Half-height RGB buffer

    /**
     * YADIF (Yet Another Deinterlacing Filter) implementation - Optimised
     * Converts interlaced field to progressive frame with temporal/spatial interpolation
     */
    fun yadifDeinterlace(fieldRGBAddr: Long, outputRGBAddr: Long, width: Int, height: Int, 
                        prevFieldAddr: Long, nextFieldAddr: Long, fieldParity: Int, 
                        fieldIncVec: Int, outputIncVec: Int) {

        val fieldHeight = height / 2
        val rowBytes = width * 3
        val maxChunkRows = kotlin.math.min(256, fieldHeight) // Limit chunk rows to prevent huge buffers
        val maxChunkPixels = maxChunkRows * width
        val maxChunkBytes = maxChunkPixels * 3
        
        // Pre-allocate buffers for bulk operations with proper sizing
        val fieldBuffer = ByteArray(maxChunkBytes)
        val prevBuffer = ByteArray(maxChunkBytes)
        val nextBuffer = ByteArray(maxChunkBytes)
        val outputBuffer = ByteArray(maxChunkBytes)
        
        // Process field data in chunks for better cache efficiency
        for (yChunk in 0 until fieldHeight step maxChunkRows) {
            val chunkHeight = kotlin.math.min(maxChunkRows, fieldHeight - yChunk)
            val totalPixelsInChunk = chunkHeight * width
            val totalBytesInChunk = totalPixelsInChunk * 3
            
            // Safety check to prevent buffer overflow
            if (totalBytesInChunk > maxChunkBytes) {
                throw IllegalStateException("Chunk size ($totalBytesInChunk) exceeds buffer size ($maxChunkBytes)")
            }
            
            // Bulk read current field data
            val fieldStartAddr = fieldRGBAddr + (yChunk * rowBytes) * fieldIncVec
            bulkPeekRGB(fieldStartAddr, totalPixelsInChunk, fieldIncVec, fieldBuffer)
            
            // Bulk read temporal data if available
            var hasPrevNext = false
            if (prevFieldAddr != 0L && nextFieldAddr != 0L) {
                val prevStartAddr = prevFieldAddr + (yChunk * rowBytes) * fieldIncVec
                val nextStartAddr = nextFieldAddr + (yChunk * rowBytes) * fieldIncVec
                bulkPeekRGB(prevStartAddr, totalPixelsInChunk, fieldIncVec, prevBuffer)
                bulkPeekRGB(nextStartAddr, totalPixelsInChunk, fieldIncVec, nextBuffer)
                hasPrevNext = true
            }
            
            // Process each row in the chunk
            for (y in 0 until chunkHeight) {
                val globalY = yChunk + y
                val rowStartIdx = y * width * 3
                
                // Copy current field line directly (bulk operation)
                val outputOffset = ((globalY * 2 + fieldParity) * width) * 3
                val outputAddr = outputRGBAddr + outputOffset * outputIncVec
                
                if (outputIncVec == 1) {
                    // Direct bulk copy for forward addressing
                    val (outputMemspace, outputOffset2) = vm.translateAddr(outputAddr)
                    if (outputMemspace is UnsafePtr) {
                        UnsafeHelper.memcpyRaw(
                            fieldBuffer, UnsafeHelper.getArrayOffset(fieldBuffer) + rowStartIdx,
                            null, outputMemspace.ptr + outputOffset2, rowBytes.toLong())
                    } else {
                        // Fallback to individual pokes
                        for (i in 0 until rowBytes) {
                            vm.poke(outputAddr + i, fieldBuffer[rowStartIdx + i])
                        }
                    }
                } else {
                    // Individual pokes for reverse addressing
                    for (i in 0 until rowBytes) {
                        vm.poke(outputAddr + i * outputIncVec, fieldBuffer[rowStartIdx + i])
                    }
                }
                
                // Interpolate missing lines using vectorised YADIF
                if (globalY > 0 && globalY < fieldHeight - 1) {
                    val interpLine = globalY * 2 + (1 - fieldParity)
                    
                    if (interpLine < height) {
                        processYadifInterpolation(
                            fieldBuffer, prevBuffer, nextBuffer, outputBuffer,
                            y, width, rowStartIdx, hasPrevNext, globalY, fieldHeight)
                        
                        // Write interpolated line
                        val interpOutputOffset = (interpLine * width) * 3
                        val interpOutputAddr = outputRGBAddr + interpOutputOffset * outputIncVec
                        
                        if (outputIncVec == 1) {
                            val (interpMemspace, interpOffset2) = vm.translateAddr(interpOutputAddr)
                            if (interpMemspace is UnsafePtr) {
                                UnsafeHelper.memcpyRaw(
                                    outputBuffer, UnsafeHelper.getArrayOffset(outputBuffer),
                                    null, interpMemspace.ptr + interpOffset2, rowBytes.toLong())
                            } else {
                                for (i in 0 until rowBytes) {
                                    vm.poke(interpOutputAddr + i, outputBuffer[i])
                                }
                            }
                        } else {
                            for (i in 0 until rowBytes) {
                                vm.poke(interpOutputAddr + i * outputIncVec, outputBuffer[i])
                            }
                        }
                    }
                }
            }
        }

        // Cover up top and bottom lines with border colour (optimised)
        val destT = 0
        val destB = (height - 2) * width * 3
        val col = (vm.peek(-1299457)!!.toUint() shl 16) or (vm.peek(-1299458)!!.toUint() shl 8) or vm.peek(-1299459)!!.toUint()
        vm.memsetI24(outputRGBAddr.toInt() + destT, col, width * 6)
        vm.memsetI24(outputRGBAddr.toInt() + destB, col, width * 6)
    }

    /**
     * Process YADIF interpolation for a single row using vectorised operations
     */
    private fun processYadifInterpolation(
        fieldBuffer: ByteArray, prevBuffer: ByteArray, nextBuffer: ByteArray, outputBuffer: ByteArray,
        y: Int, width: Int, rowStartIdx: Int, hasPrevNext: Boolean, globalY: Int, fieldHeight: Int) {
        
        val rowBytes = width * 3
        val aboveRowIdx = if (globalY > 0) rowStartIdx - rowBytes else rowStartIdx
        val belowRowIdx = if (globalY < fieldHeight - 1) rowStartIdx + rowBytes else rowStartIdx
        
        // Process RGB components in parallel
        for (x in 0 until width) {
            val pixelIdx = x * 3
            
            for (c in 0..2) {
                val idx = pixelIdx + c
                
                // Get spatial neighbours
                val above = fieldBuffer[aboveRowIdx + idx].toUint()
                val below = fieldBuffer[belowRowIdx + idx].toUint()
                val current = fieldBuffer[rowStartIdx + idx].toUint()
                
                // Spatial interpolation
                val spatialInterp = (above + below) / 2
                
                // Temporal prediction
                var temporalPred = spatialInterp
                if (hasPrevNext) {
                    val prevPixel = prevBuffer[rowStartIdx + idx].toUint()
                    val nextPixel = nextBuffer[rowStartIdx + idx].toUint()
                    val tempInterp = (prevPixel + nextPixel) / 2
                    
                    // YADIF edge-directed decision (optimised)
                    val spatialDiff = kotlin.math.abs(above.toInt() - below.toInt())
                    val temporalDiff = kotlin.math.abs(prevPixel.toInt() - nextPixel.toInt())
                    
                    temporalPred = when {
                        spatialDiff < 32 && temporalDiff < 32 -> 
                            (spatialInterp + tempInterp + current) / 3
                        spatialDiff < temporalDiff -> 
                            (spatialInterp * 3 + tempInterp) / 4
                        else -> 
                            (tempInterp * 3 + spatialInterp) / 4
                    }
                }
                
                // Final edge-directed filtering
                val finalValue = if (kotlin.math.abs(above.toInt() - below.toInt()) < 16) {
                    (current + temporalPred) / 2
                } else {
                    temporalPred
                }
                
                outputBuffer[idx] = finalValue.coerceIn(0, 255).toByte()
            }
        }
    }
    
    /**
     * BWDIF (Bob Weaver Deinterlacing with Interpolation and Filtering) implementation
     * Advanced motion-adaptive deinterlacing with better temporal prediction than YADIF
     */
    fun bwdifDeinterlace(fieldRGBAddr: Long, outputRGBAddr: Long, width: Int, height: Int, 
                        prevFieldAddr: Long, nextFieldAddr: Long, fieldParity: Int, 
                        fieldIncVec: Int, outputIncVec: Int) {

        val fieldHeight = height / 2
        
        for (y in 0 until fieldHeight) {
            for (x in 0 until width) {
                val fieldOffset = (y * width + x) * 3
                val outputOffset = ((y * 2 + fieldParity) * width + x) * 3
                
                // Copy current field lines directly (no interpolation needed) with loop unrolling
                vm.poke(outputRGBAddr + (outputOffset + 0) * outputIncVec, vm.peek(fieldRGBAddr + (fieldOffset + 0) * fieldIncVec)!!)
                vm.poke(outputRGBAddr + (outputOffset + 1) * outputIncVec, vm.peek(fieldRGBAddr + (fieldOffset + 1) * fieldIncVec)!!)
                vm.poke(outputRGBAddr + (outputOffset + 2) * outputIncVec, vm.peek(fieldRGBAddr + (fieldOffset + 2) * fieldIncVec)!!)

                // Interpolate missing lines using BWDIF algorithm
                if (y > 0 && y < fieldHeight - 1) {
                    val interpLine = if (fieldParity == 0) {
                        y * 2 + 1  // Even field: interpolate odd progressive lines (1,3,5...)
                    } else {
                        y * 2 + 2  // Odd field: interpolate even progressive lines (2,4,6...)
                    }
                    
                    if (interpLine < height) {
                        val interpOutputOffset = (interpLine * width + x) * 3
                    
                        for (c in 0..2) {
                            // Get spatial neighbours from sequential field data
                            val fieldStride = width * 3
                            val aboveOffset = fieldOffset - fieldStride + c
                            val belowOffset = fieldOffset + fieldStride + c
                            val currentOffset = fieldOffset + c
                            
                            // Ensure we don't read out of bounds
                            val above = if (y > 0) {
                                vm.peek(fieldRGBAddr + aboveOffset * fieldIncVec)!!.toInt() and 0xFF
                            } else {
                                vm.peek(fieldRGBAddr + currentOffset * fieldIncVec)!!.toInt() and 0xFF
                            }
                            
                            val below = if (y < fieldHeight - 1) {
                                vm.peek(fieldRGBAddr + belowOffset * fieldIncVec)!!.toInt() and 0xFF
                            } else {
                                vm.peek(fieldRGBAddr + currentOffset * fieldIncVec)!!.toInt() and 0xFF
                            }
                            
                            val current = vm.peek(fieldRGBAddr + currentOffset * fieldIncVec)!!.toInt() and 0xFF

                            // BWDIF temporal prediction - more sophisticated than YADIF
                            var interpolatedValue = (above + below) / 2  // Default spatial interpolation
                            
                            if (prevFieldAddr != 0L && nextFieldAddr != 0L) {
                                // Get temporal neighbours
                                val tempFieldOffset = (y * width + x) * 3 + c
                                val prevPixel = (vm.peek(prevFieldAddr + tempFieldOffset * fieldIncVec)?.toInt() ?: current) and 0xFF
                                val nextPixel = (vm.peek(nextFieldAddr + tempFieldOffset * fieldIncVec)?.toInt() ?: current) and 0xFF
                                
                                // BWDIF-inspired temporal differences (adapted for 3-frame window)
                                // Note: True BWDIF uses 5 frames, we adapt to 3-frame constraint
                                
                                // Get spatial neighbours from previous and next fields for temporal comparison
                                // Use same addressing pattern as working YADIF implementation
                                val prevAboveOffset = if (y > 0) ((y-1) * width + x) * 3 + c else tempFieldOffset
                                val prevBelowOffset = if (y < fieldHeight - 1) ((y+1) * width + x) * 3 + c else tempFieldOffset
                                val nextAboveOffset = if (y > 0) ((y-1) * width + x) * 3 + c else tempFieldOffset
                                val nextBelowOffset = if (y < fieldHeight - 1) ((y+1) * width + x) * 3 + c else tempFieldOffset
                                
                                val prevAbove = (vm.peek(prevFieldAddr + prevAboveOffset * fieldIncVec)?.toInt() ?: above) and 0xFF
                                val prevBelow = (vm.peek(prevFieldAddr + prevBelowOffset * fieldIncVec)?.toInt() ?: below) and 0xFF
                                val nextAbove = (vm.peek(nextFieldAddr + nextAboveOffset * fieldIncVec)?.toInt() ?: above) and 0xFF  
                                val nextBelow = (vm.peek(nextFieldAddr + nextBelowOffset * fieldIncVec)?.toInt() ?: below) and 0xFF
                                
                                // BWDIF temporal differences adapted to 3-frame window
                                val temporalDiff0 = kotlin.math.abs(prevPixel - nextPixel)  // Main temporal difference
                                val temporalDiff1 = (kotlin.math.abs(prevAbove - above) + kotlin.math.abs(prevBelow - below)) / 2  // Previous frame spatial consistency
                                val temporalDiff2 = (kotlin.math.abs(nextAbove - above) + kotlin.math.abs(nextBelow - below)) / 2  // Next frame spatial consistency
                                val maxTemporalDiff = kotlin.math.max(kotlin.math.max(temporalDiff0 / 2, temporalDiff1), temporalDiff2)
                                
                                val spatialDiff = kotlin.math.abs(above - below)
                                
                                if (maxTemporalDiff > 16) {  // Conservative threshold 
                                    val temporalInterp = (prevPixel + nextPixel) / 2
                                    val spatialInterp = (above + below) / 2
                                    
                                    // BWDIF-style decision making
                                    interpolatedValue = if (spatialDiff < maxTemporalDiff) {
                                        temporalInterp  // Trust temporal when spatial is stable
                                    } else {
                                        spatialInterp   // Trust spatial when temporal is unreliable
                                    }
                                } else {
                                    // Low temporal variation: use spatial like YADIF
                                    interpolatedValue = (above + below) / 2
                                }
                            }

                            vm.poke(outputRGBAddr + (interpOutputOffset + c) * outputIncVec,
                                   interpolatedValue.coerceIn(0, 255).toByte())
                        }
                    }
                }
            }
        }
        
        // Cover up border lines like YADIF
        val destT = 0
        val destB = (height - 2) * width * 3
        val col = (vm.peek(-1299457)!!.toUint() shl 16) or (vm.peek(-1299458)!!.toUint() shl 8) or vm.peek(-1299459)!!.toUint()
        vm.memsetI24(outputRGBAddr.toInt() + destT, col, width * 6)
        vm.memsetI24(outputRGBAddr.toInt() + destB, col, width * 6)
    }
    
    fun tevYcocgToRGB(yBlock: IntArray, coBlock: IntArray, cgBlock: IntArray): IntArray {
        val rgbData = IntArray(16 * 16 * 3)  // R,G,B for 16x16 pixels
        
        // Pre-compute chroma division components for 8x8 chroma block (each reused 4x in 4:2:0)
        for (i in 0 until 64) {
            cgHalfCache[i] = cgBlock[i] / 2
            coHalfCache[i] = coBlock[i] / 2
        }
        
        // Process 16x16 luma with cached chroma components  
        for (py in 0 until 16) {
            for (px in 0 until 16) {
                val yIdx = py * 16 + px
                val y = yBlock[yIdx]
                
                // Get pre-computed chroma components (4:2:0 upsampling)
                val coIdx = (py / 2) * 8 + (px / 2)
                
                // YCoCg-R inverse transform using cached division results
                val tmp = y - cgHalfCache[coIdx]
                val g = cgBlock[coIdx] + tmp
                val b = tmp - coHalfCache[coIdx]
                val r = b + coBlock[coIdx]
                
                // Clamp and store RGB
                val baseIdx = (py * 16 + px) * 3
                rgbData[baseIdx] = r.coerceIn(0, 255)     // R
                rgbData[baseIdx + 1] = g.coerceIn(0, 255) // G
                rgbData[baseIdx + 2] = b.coerceIn(0, 255) // B
            }
        }
        
        return rgbData
    }

    // ICtCp to RGB conversion for TEV version 3
    fun tevIctcpToRGB(iBlock: IntArray, ctBlock: IntArray, cpBlock: IntArray): IntArray {
        val rgbData = IntArray(16 * 16 * 3)  // R,G,B for 16x16 pixels

        // Process 16x16 I channel with 8x8 Ct/Cp channels (4:2:0 upsampling)
        for (py in 0 until 16) {
            for (px in 0 until 16) {
                val iIdx = py * 16 + px
                val i = iBlock[iIdx]

                // Get Ct/Cp from 8x8 chroma blocks (4:2:0 upsampling)
                val ctIdx = (py / 2) * 8 + (px / 2)
                val ct = ctBlock[ctIdx]
                val cp = cpBlock[ctIdx]

                // Convert scaled values back to ICtCp range
                // I channel: IDCT already added 128, so i is in [0,255]. Reverse encoder: (c1*255-128)+128 = c1*255
                val I = i / 255.0f
                // Ct/Cp were scaled: c2/c3 * 255.0, so reverse: ct/cp / 255.0
                val Ct = (ct / 255.0f)
                val Cp = (cp / 255.0f)

                // ICtCp -> L'M'S' (inverse matrix)
                val Lp = I + 0.015718580108730416f * Ct + 0.2095810681164055f * Cp
                val Mp = I - 0.015718580108730416f * Ct - 0.20958106811640548f * Cp
                val Sp = I + 1.0212710798422344f * Ct - 0.6052744909924316f * Cp

                // HLG decode: L'M'S' -> linear LMS
                val L = HLG_EOTF(Lp)
                val M = HLG_EOTF(Mp)
                val S = HLG_EOTF(Sp)

                // LMS -> linear sRGB (inverse matrix)
                val rLin = 6.1723815689243215f * L -5.319534979827695f * M + 0.14699442094633924f * S
                val gLin = -1.3243428148026244f * L + 2.560286104841917f * M -0.2359203727576164f * S
                val bLin = -0.011819739235953752f * L -0.26473549971186555f * M + 1.2767952602537955f * S

                // Gamma encode to sRGB
                val rSrgb = srgbUnlinearise(rLin)
                val gSrgb = srgbUnlinearise(gLin)
                val bSrgb = srgbUnlinearise(bLin)

                // Convert to 8-bit and store
                val baseIdx = (py * 16 + px) * 3
                rgbData[baseIdx] = (rSrgb * 255.0f).toInt().coerceIn(0, 255)     // R
                rgbData[baseIdx + 1] = (gSrgb * 255.0f).toInt().coerceIn(0, 255) // G
                rgbData[baseIdx + 2] = (bSrgb * 255.0f).toInt().coerceIn(0, 255) // B
            }
        }

        return rgbData
    }

    // Helper functions for ICtCp decoding

    // Inverse HLG OETF (HLG -> linear)
    fun HLG_EOTF(V: Float): Float {
        val a = 0.17883277f
        val b = 1.0f - 4.0f * a
        val c = 0.5f - a * ln(4.0f * a)

        if (V <= 0.5f)
            return (V * V) / 3.0f
        else
            return (exp((V - c)/a) + b) / 12.0f
    }

    // sRGB gamma decode: nonlinear -> linear
    private fun srgbLinearise(value: Double): Double {
        return if (value <= 0.04045) {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).pow(2.4)
        }
    }

    // sRGB gamma encode: linear -> nonlinear
    private fun srgbUnlinearise(value: Float): Float {
        return if (value <= 0.0031308f) {
            value * 12.92f
        } else {
            1.055f * value.pow(1.0f / 2.4f) - 0.055f
        }
    }

    // RGB to YCoCg-R conversion for INTER mode residual calculation
    fun tevRGBToYcocg(rgbBlock: IntArray): IntArray {
        val ycocgData = IntArray(16 * 16 * 3)  // Y,Co,Cg for 16x16 pixels
        
        for (py in 0 until 16) {
            for (px in 0 until 16) {
                val baseIdx = (py * 16 + px) * 3
                val r = rgbBlock[baseIdx]
                val g = rgbBlock[baseIdx + 1] 
                val b = rgbBlock[baseIdx + 2]
                
                // YCoCg-R forward transform
                val co = r - b
                val tmp = b + (co / 2)
                val cg = g - tmp
                val y = tmp + (cg / 2)
                
                // Store YCoCg values
                val yIdx = py * 16 + px
                ycocgData[yIdx * 3] = y.coerceIn(0, 255)        // Y
                ycocgData[yIdx * 3 + 1] = co.coerceIn(-256, 255) // Co
                ycocgData[yIdx * 3 + 2] = cg.coerceIn(-256, 255) // Cg
            }
        }
        
        return ycocgData
    }

    /**
     * Enhanced TEV Deblocking Filter - Uses Knusperli-inspired techniques for superior boundary analysis
     * 
     * Advanced features inspired by Google's Knusperli algorithm:
     * - Frequency-domain boundary discontinuity detection
     * - High-frequency penalty system to preserve detail
     * - Linear gradient pattern analysis for directional filtering
     * - Adaptive strength based on local image complexity
     * - Bulk memory operations for improved performance
     * 
     * @param rgbAddr RGB frame buffer address (24-bit: R,G,B per pixel)
     * @param width Frame width in pixels
     * @param height Frame height in pixels 
     * @param blockSize Size of blocks (16 for TEV format)
     * @param strength Base filter strength (0.0-1.0, adaptive adjustment applied)
     */
    private fun tevDeblockingFilterEnhanced(rgbAddr: Long, width: Int, height: Int, 
                                          blockSize: Int = 16, strength: Float = 1.0f) {
        val blocksX = (width + blockSize - 1) / blockSize
        val blocksY = (height + blockSize - 1) / blockSize
        val thisAddrIncVec: Long = if (rgbAddr < 0) -1 else 1
        
        // Knusperli-inspired constants adapted for RGB post-processing
        val kLinearGradient = intArrayOf(318, -285, 81, -32, 17, -9, 5, -2) // Gradient pattern (8 taps for block boundary)
        val kAlphaSqrt2 = intArrayOf(1024, 1448, 1448, 1448, 1448, 1448, 1448, 1448) // Alpha * sqrt(2) in 10-bit fixed-point
        
        // Bulk memory access helpers for performance
        fun getPixelBulk(x: Int, y: Int): IntArray {
            if (x < 0 || y < 0 || x >= width || y >= height) return intArrayOf(0, 0, 0)
            val offset = (y.toLong() * width + x) * 3
            val addr = rgbAddr + offset * thisAddrIncVec
            return intArrayOf(
                vm.peek(addr)!!.toUint().toInt(),
                vm.peek(addr + thisAddrIncVec)!!.toUint().toInt(), 
                vm.peek(addr + 2 * thisAddrIncVec)!!.toUint().toInt()
            )
        }
        
        fun setPixelBulk(x: Int, y: Int, rgb: IntArray) {
            if (x < 0 || y < 0 || x >= width || y >= height) return
            val offset = (y.toLong() * width + x) * 3
            val addr = rgbAddr + offset * thisAddrIncVec
            vm.poke(addr, rgb[0].coerceIn(0, 255).toByte())
            vm.poke(addr + thisAddrIncVec, rgb[1].coerceIn(0, 255).toByte())
            vm.poke(addr + 2 * thisAddrIncVec, rgb[2].coerceIn(0, 255).toByte())
        }
        
        // ENHANCED: Knusperli-inspired boundary discontinuity analysis
        fun analyseBoundaryDiscontinuity(samples: IntArray): Pair<Long, Long> {
            // samples: 8-pixel samples across the boundary for frequency analysis
            var delta = 0L
            var hfPenalty = 0L

            for (u in 0 until 8) {
                val alpha = kAlphaSqrt2[u]
                val sign = if (u and 1 != 0) -1 else 1
                val leftVal = samples[u]
                val rightVal = samples[7 - u] // Mirror for boundary analysis

                delta += alpha * (rightVal - sign * leftVal)
                hfPenalty += (u * u) * (leftVal * leftVal + rightVal * rightVal)
            }

            return Pair(delta, hfPenalty)
        }

        // ENHANCED: Adaptive strength based on local complexity
        fun calculateAdaptiveStrength(baseStrength: Float, hfPenalty: Long, delta: Long): Float {
            val complexity = kotlin.math.sqrt(hfPenalty.toDouble()).toFloat()
            val discontinuityMagnitude = kotlin.math.abs(delta).toFloat()

            // Reduce filtering strength in high-frequency areas (preserve detail)
            val complexityFactor = if (complexity > 800) 0.3f else 1.0f

            // Increase filtering strength for clear discontinuities
            val discontinuityFactor = kotlin.math.min(2.0f, discontinuityMagnitude / 1000.0f)

            return baseStrength * complexityFactor * discontinuityFactor
        }

        // ENHANCED: Apply Knusperli-style corrections using linear gradient patterns
        fun applyBoundaryCorrection(
            samples: IntArray, delta: Long, adaptiveStrength: Float
        ): IntArray {
            val result = samples.clone()
            val correction = (delta * 724 shr 31).toInt() // Apply sqrt(2)/2 weighting like Knusperli

            // Apply linear gradient corrections across boundary
            for (i in 0 until 8) {
                val gradientWeight = kLinearGradient[i] * correction / 1024 // Scale from 10-bit fixed-point
                val sign = if (i < 4) 1 else -1 // Left/right side weighting

                val adjustment = (gradientWeight * sign * adaptiveStrength).toInt()
                result[i] = (result[i] + adjustment).coerceIn(0, 255)
            }

            return result
        }

        // ENHANCED HORIZONTAL DEBLOCKING: Using Knusperli-inspired boundary analysis
        for (by in 0 until blocksY) {
            for (bx in 1 until blocksX) {
                val blockEdgeX = bx * blockSize
                if (blockEdgeX >= width) continue

                // Process boundary in chunks for better performance
                val yStart = by * blockSize
                val yEnd = minOf((by + 1) * blockSize, height)

                for (y in yStart until yEnd step 2) { // Process 2 lines at a time
                    if (y + 1 >= height) continue

                    // Sample 8x2 pixel region across boundary for both lines
                    val samples1 = IntArray(24) // 8 pixels × 3 channels (RGB)
                    val samples2 = IntArray(24)

                    for (i in 0 until 8) {
                        val x = blockEdgeX - 4 + i
                        val rgb1 = getPixelBulk(x, y)
                        val rgb2 = getPixelBulk(x, y + 1)

                        samples1[i * 3] = rgb1[0]     // R
                        samples1[i * 3 + 1] = rgb1[1] // G
                        samples1[i * 3 + 2] = rgb1[2] // B
                        samples2[i * 3] = rgb2[0]
                        samples2[i * 3 + 1] = rgb2[1]
                        samples2[i * 3 + 2] = rgb2[2]
                    }

                    // Analyse each colour channel separately
                    for (c in 0..2) {
                        val channelSamples1 = IntArray(8) { samples1[it * 3 + c] }
                        val channelSamples2 = IntArray(8) { samples2[it * 3 + c] }

                        val (delta1, hfPenalty1) = analyseBoundaryDiscontinuity(channelSamples1)
                        val (delta2, hfPenalty2) = analyseBoundaryDiscontinuity(channelSamples2)

                        // Skip if very small discontinuity (early exit optimisation)
                        if (kotlin.math.abs(delta1) < 50 && kotlin.math.abs(delta2) < 50) continue

                        // Calculate adaptive filtering strength
                        val adaptiveStrength1 = calculateAdaptiveStrength(strength, hfPenalty1, delta1)
                        val adaptiveStrength2 = calculateAdaptiveStrength(strength, hfPenalty2, delta2)

                        // Apply corrections if strength is significant
                        if (adaptiveStrength1 > 0.05f) {
                            val corrected1 = applyBoundaryCorrection(channelSamples1, delta1, adaptiveStrength1)
                            for (i in 0 until 8) {
                                samples1[i * 3 + c] = corrected1[i]
                            }
                        }

                        if (adaptiveStrength2 > 0.05f) {
                            val corrected2 = applyBoundaryCorrection(channelSamples2, delta2, adaptiveStrength2)
                            for (i in 0 until 8) {
                                samples2[i * 3 + c] = corrected2[i]
                            }
                        }
                    }

                    // Write back corrected pixels in bulk
                    for (i in 2..5) { // Only write middle 4 pixels to avoid artifacts
                        val x = blockEdgeX - 4 + i
                        setPixelBulk(x, y, intArrayOf(samples1[i * 3], samples1[i * 3 + 1], samples1[i * 3 + 2]))
                        if (y + 1 < height) {
                            setPixelBulk(x, y + 1, intArrayOf(samples2[i * 3], samples2[i * 3 + 1], samples2[i * 3 + 2]))
                        }
                    }
                }
            }
        }

        // ENHANCED VERTICAL DEBLOCKING: Same approach for horizontal block boundaries
        for (by in 1 until blocksY) {
            for (bx in 0 until blocksX) {
                val blockEdgeY = by * blockSize
                if (blockEdgeY >= height) continue

                val xStart = bx * blockSize
                val xEnd = minOf((bx + 1) * blockSize, width)

                for (x in xStart until xEnd step 2) {
                    if (x + 1 >= width) continue

                    // Sample 8x2 pixel region across vertical boundary
                    val samples1 = IntArray(24)
                    val samples2 = IntArray(24)

                    for (i in 0 until 8) {
                        val y = blockEdgeY - 4 + i
                        val rgb1 = getPixelBulk(x, y)
                        val rgb2 = getPixelBulk(x + 1, y)

                        samples1[i * 3] = rgb1[0]
                        samples1[i * 3 + 1] = rgb1[1]
                        samples1[i * 3 + 2] = rgb1[2]
                        samples2[i * 3] = rgb2[0]
                        samples2[i * 3 + 1] = rgb2[1]
                        samples2[i * 3 + 2] = rgb2[2]
                    }

                    // Same boundary analysis and correction as horizontal
                    for (c in 0..2) {
                        val channelSamples1 = IntArray(8) { samples1[it * 3 + c] }
                        val channelSamples2 = IntArray(8) { samples2[it * 3 + c] }

                        val (delta1, hfPenalty1) = analyseBoundaryDiscontinuity(channelSamples1)
                        val (delta2, hfPenalty2) = analyseBoundaryDiscontinuity(channelSamples2)

                        if (kotlin.math.abs(delta1) < 50 && kotlin.math.abs(delta2) < 50) continue

                        val adaptiveStrength1 = calculateAdaptiveStrength(strength, hfPenalty1, delta1)
                        val adaptiveStrength2 = calculateAdaptiveStrength(strength, hfPenalty2, delta2)

                        if (adaptiveStrength1 > 0.05f) {
                            val corrected1 = applyBoundaryCorrection(channelSamples1, delta1, adaptiveStrength1)
                            for (i in 0 until 8) {
                                samples1[i * 3 + c] = corrected1[i]
                            }
                        }

                        if (adaptiveStrength2 > 0.05f) {
                            val corrected2 = applyBoundaryCorrection(channelSamples2, delta2, adaptiveStrength2)
                            for (i in 0 until 8) {
                                samples2[i * 3 + c] = corrected2[i]
                            }
                        }
                    }

                    // Write back corrected pixels
                    for (i in 2..5) {
                        val y = blockEdgeY - 4 + i
                        setPixelBulk(x, y, intArrayOf(samples1[i * 3], samples1[i * 3 + 1], samples1[i * 3 + 2]))
                        if (x + 1 < width) {
                            setPixelBulk(x + 1, y, intArrayOf(samples2[i * 3], samples2[i * 3 + 1], samples2[i * 3 + 2]))
                        }
                    }
                }
            }
        }
    }

    /**
     * Bulk write RGB block data to VM memory
     */
    private fun bulkWriteRGB(destAddr: Long, rgbData: IntArray, width: Int, height: Int,
                           startX: Int, startY: Int, blockWidth: Int, blockHeight: Int, addrIncVec: Int) {
        val (memspace, baseOffset) = vm.translateAddr(destAddr)

        if (memspace is UnsafePtr && addrIncVec == 1) {
            // Optimised path for user memory with forward addressing
            for (dy in 0 until blockHeight) {
                val y = startY + dy
                if (y >= height) break

                val rowStartX = kotlin.math.max(0, startX)
                val rowEndX = kotlin.math.min(width, startX + blockWidth)
                val rowPixels = rowEndX - rowStartX

                if (rowPixels > 0) {
                    val srcRowOffset = dy * blockWidth * 3 + (rowStartX - startX) * 3
                    val dstRowOffset = baseOffset + (y * width + rowStartX) * 3
                    val rowBytes = rowPixels * 3

                    // Convert IntArray to ByteArray for this row
                    val rowBuffer = ByteArray(rowBytes)
                    for (i in 0 until rowBytes) {
                        rowBuffer[i] = rgbData[srcRowOffset + i].toByte()
                    }

                    // Bulk write the row
                    UnsafeHelper.memcpyRaw(
                        rowBuffer, UnsafeHelper.getArrayOffset(rowBuffer),
                        null, memspace.ptr + dstRowOffset, rowBytes.toLong())
                }
            }
        } else {
            // Fallback to individual pokes for peripheral memory or reverse addressing
            for (dy in 0 until blockHeight) {
                for (dx in 0 until blockWidth) {
                    val x = startX + dx
                    val y = startY + dy
                    if (x < width && y < height) {
                        val rgbIdx = (dy * blockWidth + dx) * 3
                        val bufferOffset = (y.toLong() * width + x) * 3

                        vm.poke(destAddr + bufferOffset * addrIncVec, rgbData[rgbIdx].toByte())
                        vm.poke(destAddr + (bufferOffset + 1) * addrIncVec, rgbData[rgbIdx + 1].toByte())
                        vm.poke(destAddr + (bufferOffset + 2) * addrIncVec, rgbData[rgbIdx + 2].toByte())
                    }
                }
            }
        }
    }

    /**
     * Hardware-accelerated TEV frame decoder for YCoCg-R 4:2:0 format
     * Decodes compressed TEV block data directly to framebuffer
     *
     * @param blockDataPtr Pointer to decompressed TEV block data
     * @param currentRGBAddr Address of current frame RGB buffer (24-bit: R,G,B per pixel)
     * @param prevRGBAddr Address of previous frame RGB buffer (for motion compensation)
     * @param width Frame width in pixels
     * @param height Frame height in pixels
     * @param quality Quantisation quality level (0-7)
     * @param frameCount Frame counter for temporal patterns
     */
    fun tevDecode(blockDataPtr: Long, currentRGBAddr: Long, prevRGBAddr: Long,
                  width: Int, height: Int, qY: Int, qCo: Int, qCg: Int, frameCount: Int,
                  debugMotionVectors: Boolean = false, tevVersion: Int = 2,
                  enableDeblocking: Boolean = true, enableBoundaryAwareDecoding: Boolean = false) {

        // height doesn't change when interlaced, because that's the encoder's output

        // For interlaced mode, decode to half-height field first
        val blocksX = (width + 15) / 16  // 16x16 blocks now
        val blocksY = (height + 15) / 16

        var readPtr = blockDataPtr

        // decide increment "direction" by the sign of the pointer
        val prevAddrIncVec = if (prevRGBAddr >= 0) 1 else -1
        val thisAddrIncVec = if (currentRGBAddr >= 0) 1 else -1

        // Two-pass approach for knusperli boundary-aware decoding
        if (enableBoundaryAwareDecoding) {
            // PASS 1: Collect all blocks with raw coefficients
            val yBlocks = Array<ShortArray?>(blocksX * blocksY) { null }
            val coBlocks = Array<ShortArray?>(blocksX * blocksY) { null }
            val cgBlocks = Array<ShortArray?>(blocksX * blocksY) { null }
            val blockModes = IntArray(blocksX * blocksY)
            val motionVectors = Array(blocksX * blocksY) { intArrayOf(0, 0) }
            val rateControlFactors = FloatArray(blocksX * blocksY)

            // Collect all blocks first
            var tempReadPtr = readPtr
            for (by in 0 until blocksY) {
                for (bx in 0 until blocksX) {
                    val blockIndex = by * blocksX + bx

                    // Read TEV block header to get rate control factor
                    val headerBuffer = ByteArray(11)
                    val (memspace, offset) = vm.translateAddr(tempReadPtr)
                    if (memspace is UnsafePtr) {
                        UnsafeHelper.memcpyRaw(null, memspace.ptr + offset,
                            headerBuffer, UnsafeHelper.getArrayOffset(headerBuffer), 11L)
                    } else {
                        // Fallback for peripheral memory
                        for (i in 0 until 11) {
                            headerBuffer[i] = vm.peek(tempReadPtr + i) ?: 0
                        }
                    }

                    val mode = headerBuffer[0].toUint()
                    val mvX = ((headerBuffer[1].toUint()) or ((headerBuffer[2].toUint()) shl 8)).toShort().toInt()
                    val mvY = ((headerBuffer[3].toUint()) or ((headerBuffer[4].toUint()) shl 8)).toShort().toInt()
                    val rateControlFactor = Float.fromBits((headerBuffer[5].toUint()) or
                            ((headerBuffer[6].toUint()) shl 8) or
                            ((headerBuffer[7].toUint()) shl 16) or
                            ((headerBuffer[8].toUint()) shl 24))
                    tempReadPtr += 11 // Skip header

                    blockModes[blockIndex] = mode.toInt()
                    motionVectors[blockIndex] = intArrayOf(mvX, mvY)
                    rateControlFactors[blockIndex] = rateControlFactor

                    // TEV format always has 768 bytes of DCT coefficients per block (fixed size)
                    val coeffShortArray = ShortArray(384) // 256 Y + 64 Co + 64 Cg = 384 shorts

                    // Use bulk read like the original implementation
                    vm.bulkPeekShort(tempReadPtr.toInt(), coeffShortArray, 768)
                    tempReadPtr += 768

                    when (mode.toInt()) {
                        0x01, 0x02 -> { // INTRA or INTER - store raw coefficients for boundary optimisation
                            yBlocks[blockIndex] = coeffShortArray.sliceArray(0 until 256)
                            coBlocks[blockIndex] = coeffShortArray.sliceArray(256 until 320)
                            cgBlocks[blockIndex] = coeffShortArray.sliceArray(320 until 384)
                        }
                        // For SKIP (0x00) and MOTION (0x03), coefficients are ignored but still need to be read
                    }
                }
            }

            // PASS 2: Apply proper knusperli boundary optimisation (Google's algorithm)
            val (optimisedYBlocks, optimisedCoBlocks, optimisedCgBlocks) = tevApplyKnusperliOptimisation(
                yBlocks, coBlocks, cgBlocks,
                if (tevVersion == 3) QUANT_TABLE_Y else QUANT_TABLE_Y,
                if (tevVersion == 3) QUANT_TABLE_C else QUANT_TABLE_C,
                if (tevVersion == 3) QUANT_TABLE_C else QUANT_TABLE_C,
                qY, qCo, qCg, rateControlFactors,
                blocksX, blocksY
            )

            // PASS 3: Convert optimised blocks to RGB and output
            for (by in 0 until blocksY) {
                for (bx in 0 until blocksX) {
                    val blockIndex = by * blocksX + bx
                    val startX = bx * 16
                    val startY = by * 16

                    when (blockModes[blockIndex]) {
                        0x00 -> { // SKIP - copy from previous frame
                            tevHandleSkipBlockTwoPass(startX, startY, currentRGBAddr, prevRGBAddr, width, height, thisAddrIncVec, prevAddrIncVec)
                        }
                        0x03 -> { // MOTION - copy with motion vector
                            val mv = motionVectors[blockIndex]
                            tevHandleMotionBlockTwoPass(startX, startY, mv[0], mv[1], currentRGBAddr, prevRGBAddr, width, height, thisAddrIncVec, prevAddrIncVec, debugMotionVectors)
                        }
                        0x01, 0x02 -> { // INTRA/INTER - use optimised DCT blocks
                            val yBlock = optimisedYBlocks[blockIndex]
                            val coBlock = optimisedCoBlocks[blockIndex]
                            val cgBlock = optimisedCgBlocks[blockIndex]

                            if (yBlock != null && coBlock != null && cgBlock != null) {
                                // Skip INTER motion compensation for now (debugging)
                                // TODO: Implement proper motion compensation for two-pass mode
                                // if (blockModes[blockIndex] == 0x02) {
                                //     val mv = motionVectors[blockIndex]
                                //     tevApplyMotionCompensationTwoPass(yBlock, coBlock, cgBlock, startX, startY, mv[0], mv[1], prevRGBAddr, width, height, prevAddrIncVec)
                                // }

                                // Use IDCT on knusperli-optimised coefficients (coefficients are already optimally dequantised)
                                val yPixels = tevIdct16x16_fromOptimisedCoeffs(yBlock)
                                val coPixels = tevIdct8x8_fromOptimisedCoeffs(coBlock)
                                val cgPixels = tevIdct8x8_fromOptimisedCoeffs(cgBlock)

                                val rgbData = if (tevVersion == 3) {
                                    tevIctcpToRGB(yPixels, coPixels, cgPixels)
                                } else {
                                    tevYcocgToRGB(yPixels, coPixels, cgPixels)
                                }

                                bulkWriteRGB(currentRGBAddr, rgbData, width, height, startX, startY, 16, 16, thisAddrIncVec)
                            }
                        }
                    }
                }
            }
        } else {
            // Standard single-pass decoding (original logic)
            for (by in 0 until blocksY) {
                for (bx in 0 until blocksX) {
                    val startX = bx * 16
                    val startY = by * 16

                    // Read TEV block header (11 bytes) with bulk operation
                    val headerBuffer = ByteArray(11)
                    val (memspace, offset) = vm.translateAddr(readPtr)
                    if (memspace is UnsafePtr) {
                        UnsafeHelper.memcpyRaw(null, memspace.ptr + offset,
                            headerBuffer, UnsafeHelper.getArrayOffset(headerBuffer), 11L)
                    } else {
                        // Fallback for peripheral memory
                        for (i in 0 until 11) {
                            headerBuffer[i] = vm.peek(readPtr + i) ?: 0
                        }
                    }
                    val mode = headerBuffer[0].toUint()
                    val mvX = ((headerBuffer[1].toUint()) or ((headerBuffer[2].toUint()) shl 8)).toShort().toInt()
                    val mvY = ((headerBuffer[3].toUint()) or ((headerBuffer[4].toUint()) shl 8)).toShort().toInt()
                    val rateControlFactor = Float.fromBits((headerBuffer[5].toUint()) or
                            ((headerBuffer[6].toUint()) shl 8) or
                            ((headerBuffer[7].toUint()) shl 16) or
                            ((headerBuffer[8].toUint()) shl 24))
                    readPtr += 11 // Skip CBP field


                    when (mode) {
                        0x00 -> { // TEV_MODE_SKIP - copy RGB from previous frame (optimised with memcpy)
                            // Check if we can copy the entire block at once (no clipping)
                            if (startX + 16 <= width && startY + 16 <= height) {
                                // Optimised case: copy entire 16x16 block with row-by-row memcpy
                                for (dy in 0 until 16) {
                                    val srcRowOffset = ((startY + dy).toLong() * width + startX) * 3
                                    val dstRowOffset = srcRowOffset
                                    vm.memcpy(
                                        (prevRGBAddr + srcRowOffset*prevAddrIncVec).toInt(),
                                        (currentRGBAddr + dstRowOffset*thisAddrIncVec).toInt(),
                                        48  // 16 pixels × 3 bytes = 48 bytes per row
                                    )
                                }
                            } else {
                                // Optimised fallback using row-by-row copying for boundary blocks
                                for (dy in 0 until 16) {
                                    val y = startY + dy
                                    if (y < height) {
                                        val rowStartX = kotlin.math.max(0, startX)
                                        val rowEndX = kotlin.math.min(width, startX + 16)
                                        val rowPixels = rowEndX - rowStartX

                                        if (rowPixels > 0) {
                                            val srcRowOffset = (y.toLong() * width + rowStartX) * 3
                                            val dstRowOffset = srcRowOffset
                                            val rowBytes = rowPixels * 3

                                            // Use vm.memcpy for partial rows
                                            vm.memcpy(
                                                (prevRGBAddr + srcRowOffset*prevAddrIncVec).toInt(),
                                                (currentRGBAddr + dstRowOffset*thisAddrIncVec).toInt(),
                                                rowBytes
                                            )
                                        }
                                    }
                                }
                            }
                            // Skip DCT coefficients for fixed-size block format: Y(256×2) + Co(64×2) + Cg(64×2) = 768 bytes
                            readPtr += 768
                        }

                        0x03 -> { // TEV_MODE_MOTION - motion compensation with RGB (optimised with memcpy)
                            if (debugMotionVectors) {
                                // Debug mode: use original pixel-by-pixel for motion vector visualisation
                                for (dy in 0 until 16) {
                                    for (dx in 0 until 16) {
                                        val x = startX + dx
                                        val y = startY + dy
                                        val refX = x + mvX
                                        val refY = y + mvY

                                        if (x < width && y < height) {
                                            val dstPixelOffset = y.toLong() * width + x
                                            val dstRgbOffset = dstPixelOffset * 3

                                            // Debug: Colour INTER blocks by motion vector magnitude
                                            val mvMagnitude = kotlin.math.sqrt((mvX * mvX + mvY * mvY).toDouble()).toInt()
                                            val intensity = (mvMagnitude * 8).coerceIn(0, 255) // Scale for visibility

                                            vm.poke(currentRGBAddr + dstRgbOffset*thisAddrIncVec, intensity.toByte())        // R = MV magnitude
                                            vm.poke(currentRGBAddr + (dstRgbOffset + 1)*thisAddrIncVec, 0.toByte())         // G = 0
                                            vm.poke(currentRGBAddr + (dstRgbOffset + 2)*thisAddrIncVec, (255-intensity).toByte()) // B = inverse
                                        }
                                    }
                                }
                            } else {
                                // Optimised motion compensation
                                val refStartX = startX + mvX
                                val refStartY = startY + mvY

                                // Check if entire 16x16 block can be copied with memcpy (no bounds issues)
                                if (startX + 16 <= width && startY + 16 <= height &&
                                    refStartX >= 0 && refStartY >= 0 && refStartX + 16 <= width && refStartY + 16 <= height) {

                                    // Optimised case: copy entire 16x16 block with row-by-row memcpy
                                    for (dy in 0 until 16) {
                                        val srcRowOffset = ((refStartY + dy).toLong() * width + refStartX) * 3
                                        val dstRowOffset = ((startY + dy).toLong() * width + startX) * 3
                                        vm.memcpy(
                                            (prevRGBAddr + srcRowOffset*prevAddrIncVec).toInt(),
                                            (currentRGBAddr + dstRowOffset*thisAddrIncVec).toInt(),
                                            48  // 16 pixels × 3 bytes = 48 bytes per row
                                        )
                                    }
                                } else {
                                    // Fallback to pixel-by-pixel for boundary/out-of-bounds cases
                                    for (dy in 0 until 16) {
                                        for (dx in 0 until 16) {
                                            val x = startX + dx
                                            val y = startY + dy
                                            val refX = x + mvX
                                            val refY = y + mvY

                                            if (x < width && y < height) {
                                                val dstPixelOffset = y.toLong() * width + x
                                                val dstRgbOffset = dstPixelOffset * 3

                                                if (refX >= 0 && refY >= 0 && refX < width && refY < height) {
                                                    val refPixelOffset = refY.toLong() * width + refX
                                                    val refRgbOffset = refPixelOffset * 3

                                                    // Additional safety: ensure RGB offset is within valid range
                                                    val maxValidOffset = (width * height - 1) * 3L + 2
                                                    if (refRgbOffset >= 0 && refRgbOffset <= maxValidOffset) {
                                                        // Copy RGB from reference position
                                                        val refR = vm.peek(prevRGBAddr + refRgbOffset*prevAddrIncVec)!!
                                                        val refG = vm.peek(prevRGBAddr + (refRgbOffset + 1)*prevAddrIncVec)!!
                                                        val refB = vm.peek(prevRGBAddr + (refRgbOffset + 2)*prevAddrIncVec)!!

                                                        vm.poke(currentRGBAddr + dstRgbOffset*thisAddrIncVec, refR)
                                                        vm.poke(currentRGBAddr + (dstRgbOffset + 1)*thisAddrIncVec, refG)
                                                        vm.poke(currentRGBAddr + (dstRgbOffset + 2)*thisAddrIncVec, refB)
                                                    } else {
                                                        // Invalid RGB offset - use black
                                                        vm.poke(currentRGBAddr + dstRgbOffset*thisAddrIncVec, 0.toByte())        // R=0
                                                        vm.poke(currentRGBAddr + (dstRgbOffset + 1)*thisAddrIncVec, 0.toByte())  // G=0
                                                        vm.poke(currentRGBAddr + (dstRgbOffset + 2)*thisAddrIncVec, 0.toByte())  // B=0
                                                    }
                                                } else {
                                                    // Out of bounds - use black
                                                    vm.poke(currentRGBAddr + dstRgbOffset*thisAddrIncVec, 0.toByte())        // R=0
                                                    vm.poke(currentRGBAddr + (dstRgbOffset + 1)*thisAddrIncVec, 0.toByte())  // G=0
                                                    vm.poke(currentRGBAddr + (dstRgbOffset + 2)*thisAddrIncVec, 0.toByte())  // B=0
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            // Skip DCT coefficients for fixed-size block format: Y(256×2) + Co(64×2) + Cg(64×2) = 768 bytes
                            readPtr += 768
                        }

                        0x01 -> { // TEV_MODE_INTRA - Full YCoCg-R DCT decode (no motion compensation)
                            // Regular lossy mode: quantised int16 coefficients
                            // Optimised bulk reading of all DCT coefficients: Y(256×2) + Co(64×2) + Cg(64×2) = 768 bytes
                            val coeffShortArray = ShortArray(384) // Total coefficients: 256 + 64 + 64 = 384 shorts
                            vm.bulkPeekShort(readPtr.toInt(), coeffShortArray, 768)
                            readPtr += 768

                            // Perform hardware IDCT for each channel using fast algorithm
                            val yBlock = tevIdct16x16_fast(coeffShortArray.sliceArray(0 until 256), if (tevVersion == 3) QUANT_TABLE_Y else QUANT_TABLE_Y, qY, rateControlFactor)
                            val coBlock = tevIdct8x8_fast(coeffShortArray.sliceArray(256 until 320), if (tevVersion == 3) QUANT_TABLE_C else QUANT_TABLE_C, true, qCo, rateControlFactor)
                            val cgBlock = tevIdct8x8_fast(coeffShortArray.sliceArray(320 until 384), if (tevVersion == 3) QUANT_TABLE_C else QUANT_TABLE_C, true, qCg, rateControlFactor)

                            // Convert to RGB (YCoCg-R for v2, XYB for v3)
                            val rgbData = if (tevVersion == 3) {
                                tevIctcpToRGB(yBlock, coBlock, cgBlock)  // XYB format (v3)
                            } else {
                                tevYcocgToRGB(yBlock, coBlock, cgBlock)  // YCoCg-R format (v2)
                            }

                            // Store RGB data to frame buffer with bulk write
                            bulkWriteRGB(currentRGBAddr, rgbData, width, height, startX, startY, 16, 16, thisAddrIncVec)
                        }

                        0x02 -> { // TEV_MODE_INTER - Motion compensation + residual DCT
                            // Step 1: Read residual DCT coefficients

                            // Optimised bulk reading of all DCT coefficients: Y(256×2) + Co(64×2) + Cg(64×2) = 768 bytes
                            val coeffShortArray = ShortArray(384) // Total coefficients: 256 + 64 + 64 = 384 shorts
                            vm.bulkPeekShort(readPtr.toInt(), coeffShortArray, 768)
                            readPtr += 768

                            // Step 2: Decode residual DCT
                            val yResidual = tevIdct16x16_fast(coeffShortArray.sliceArray(0 until 256), if (tevVersion == 3) QUANT_TABLE_Y else QUANT_TABLE_Y, qY, rateControlFactor)
                            val coResidual = tevIdct8x8_fast(coeffShortArray.sliceArray(256 until 320), if (tevVersion == 3) QUANT_TABLE_C else QUANT_TABLE_C, true, qCo, rateControlFactor)
                            val cgResidual = tevIdct8x8_fast(coeffShortArray.sliceArray(320 until 384), if (tevVersion == 3) QUANT_TABLE_C else QUANT_TABLE_C, true, qCg, rateControlFactor)

                            // Step 3: Build motion-compensated YCoCg-R block and add residuals
                            val finalY = IntArray(256)
                            val finalCo = IntArray(64)
                            val finalCg = IntArray(64)

                            // Process Y residuals (16x16)
                            for (dy in 0 until 16) {
                                for (dx in 0 until 16) {
                                    val x = startX + dx
                                    val y = startY + dy
                                    val refX = x + mvX  // Revert to original motion compensation
                                    val refY = y + mvY
                                    val pixelIdx = dy * 16 + dx

                                    if (x < width && y < height) {
                                        var mcY: Int

                                        if (refX >= 0 && refY >= 0 && refX < width && refY < height) {
                                            // Get motion-compensated RGB from previous frame
                                            val refPixelOffset = refY.toLong() * width + refX
                                            val refRgbOffset = refPixelOffset * 3

                                            val mcR = vm.peek(prevRGBAddr + refRgbOffset*prevAddrIncVec)!!.toUint().toInt()
                                            val mcG = vm.peek(prevRGBAddr + (refRgbOffset + 1)*prevAddrIncVec)!!.toUint().toInt()
                                            val mcB = vm.peek(prevRGBAddr + (refRgbOffset + 2)*prevAddrIncVec)!!.toUint().toInt()


                                            // Convert motion-compensated RGB to Y only
                                            mcY = (mcR + 2*mcG + mcB) / 4  // Keep full 0-255 range for prediction
                                        } else {
                                            // Out of bounds reference - use black
                                            mcY = 0
                                        }

                                        // Add Y residual: prediction + (IDCT_output - 128)
                                        // IDCT adds +128 bias, encoder already accounts for prediction centering
                                        val residual = yResidual[pixelIdx] - 128  // Remove only IDCT bias
                                        finalY[pixelIdx] = (mcY + residual).coerceIn(0, 255)
                                    }
                                }
                            }

                            // Process chroma residuals separately (8x8 subsampled)
                            for (cy in 0 until 8) {
                                for (cx in 0 until 8) {
                                    // Chroma coordinates are at 2x2 block centers in subsampled space
                                    val x = startX + cx * 2
                                    val y = startY + cy * 2

                                    // Apply motion vector to chroma block center
                                    val refX = x + mvX
                                    val refY = y + mvY
                                    val chromaIdx = cy * 8 + cx

                                    if (x < width && y < height) {
                                        var mcCo: Int
                                        var mcCg: Int

                                        // Sample 2x2 block from motion-compensated position for chroma
                                        if (refX >= 0 && refY >= 0 && refX < width - 1 && refY < height - 1) {
                                            var coSum = 0
                                            var cgSum = 0
                                            var count = 0

                                            // Sample 2x2 block for chroma subsampling (like encoder)
                                            for (dy in 0 until 2) {
                                                for (dx in 0 until 2) {
                                                    val sampleX = refX + dx
                                                    val sampleY = refY + dy
                                                    if (sampleX < width && sampleY < height) {
                                                        val refPixelOffset = sampleY.toLong() * width + sampleX
                                                        val refRgbOffset = refPixelOffset * 3

                                                        val mcR = vm.peek(prevRGBAddr + refRgbOffset*prevAddrIncVec)!!.toUint().toInt()
                                                        val mcG = vm.peek(prevRGBAddr + (refRgbOffset + 1)*prevAddrIncVec)!!.toUint().toInt()
                                                        val mcB = vm.peek(prevRGBAddr + (refRgbOffset + 2)*prevAddrIncVec)!!.toUint().toInt()

                                                        val co = mcR - mcB
                                                        val tmp = mcB + (co / 2)
                                                        val cg = mcG - tmp

                                                        coSum += co
                                                        cgSum += cg
                                                        count++
                                                    }
                                                }
                                            }

                                            mcCo = if (count > 0) coSum / count else 0
                                            mcCg = if (count > 0) cgSum / count else 0
                                        } else {
                                            // Out of bounds reference - use neutral chroma values
                                            mcCo = 0
                                            mcCg = 0
                                        }

                                        // Add chroma residuals
                                        finalCo[chromaIdx] = (mcCo + (coResidual[chromaIdx])).coerceIn(-256, 255)
                                        finalCg[chromaIdx] = (mcCg + (cgResidual[chromaIdx])).coerceIn(-256, 255)
                                    }
                                }
                            }

                            // Step 4: Convert final data to RGB (YCoCg-R for v2, XYB for v3)
                            val finalRgb = if (tevVersion == 3) {
                                tevIctcpToRGB(finalY, finalCo, finalCg)  // XYB format (v3)
                            } else {
                                tevYcocgToRGB(finalY, finalCo, finalCg)  // YCoCg-R format (v2)
                            }

                            // Step 5: Store final RGB data to frame buffer
                            if (debugMotionVectors) {
                                // Debug mode: individual pokes for motion vector visualisation
                                for (dy in 0 until 16) {
                                    for (dx in 0 until 16) {
                                        val x = startX + dx
                                        val y = startY + dy
                                        if (x < width && y < height) {
                                            val imageOffset = y.toLong() * width + x
                                            val bufferOffset = imageOffset * 3

                                            val mvMagnitude = kotlin.math.sqrt((mvX * mvX + mvY * mvY).toDouble()).toInt()
                                            val intensity = (mvMagnitude * 8).coerceIn(0, 255) // Scale for visibility

                                            vm.poke(currentRGBAddr + bufferOffset*thisAddrIncVec, intensity.toByte())        // R = MV magnitude
                                            vm.poke(currentRGBAddr + (bufferOffset + 1)*thisAddrIncVec, 0.toByte())         // G = 0
                                            vm.poke(currentRGBAddr + (bufferOffset + 2)*thisAddrIncVec, (255-intensity).toByte()) // B = inverse
                                        }
                                    }
                                }
                            } else {
                                // Optimised bulk write for normal operation
                                bulkWriteRGB(currentRGBAddr, finalRgb, width, height, startX, startY, 16, 16, thisAddrIncVec)
                            }
                        }

                        else -> {
                            // Unknown block mode - skip DCT coefficients and use black
                            readPtr += 768 // Skip Y(256×2) + Co(64×2) + Cg(64×2) = 768 bytes

                            for (dy in 0 until 16) {
                                for (dx in 0 until 16) {
                                    val x = startX + dx
                                    val y = startY + dy
                                    if (x < width && y < height) {
                                        val imageOffset = y.toLong() * width + x
                                        val bufferOffset = imageOffset * 3

                                        vm.poke(currentRGBAddr + bufferOffset*thisAddrIncVec, 0.toByte())      // R=0
                                        vm.poke(currentRGBAddr + (bufferOffset + 1)*thisAddrIncVec, 0.toByte()) // G=0
                                        vm.poke(currentRGBAddr + (bufferOffset + 2)*thisAddrIncVec, 0.toByte()) // B=0
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Apply enhanced deblocking filter if enabled to reduce blocking artifacts
        if (enableDeblocking) {
            tevDeblockingFilterEnhanced(currentRGBAddr, width, height)
        }
    }

    fun tevDeinterlace(frameCount: Int, width: Int, height: Int, prevField: Long, currentField: Long, nextField: Long, outputRGB: Long, algorithm: String = "yadif") {
        // Apply selected deinterlacing algorithm: field -> progressive frame
        val fieldParity = (frameCount + 1) % 2

        when (algorithm.lowercase()) {
            "bwdif" -> {
                bwdifDeinterlace(
                    currentField, outputRGB, width, height * 2,
                    prevField, nextField,
                    fieldParity,
                    1, 1
                )
            }
            "yadif", "" -> {
                yadifDeinterlace(
                    currentField, outputRGB, width, height * 2,
                    prevField, nextField,
                    fieldParity,
                    1, 1
                )
            }
            else -> {
                // Default to YADIF for unknown algorithms
                yadifDeinterlace(
                    currentField, outputRGB, width, height * 2,
                    prevField, nextField,
                    fieldParity,
                    1, 1
                )
            }
        }
    }

    fun tavDeinterlace(frameCount: Int, width: Int, height: Int, prevField: Long, currentField: Long, nextField: Long, outputRGB: Long, algorithm: String = "yadif") {
        // TAV deinterlacing - same logic as TEV
        tevDeinterlace(frameCount, width, height, prevField, currentField, nextField, outputRGB, algorithm)
    }

    // Helper functions for motion compensation and block handling in two-pass mode
    private fun tevHandleSkipBlockTwoPass(startX: Int, startY: Int, currentRGBAddr: Long, prevRGBAddr: Long,
                                          width: Int, height: Int, thisAddrIncVec: Int, prevAddrIncVec: Int) {
        // Copy 16x16 block from previous frame
        for (py in 0 until 16) {
            val y = startY + py
            if (y >= height) break

            for (px in 0 until 16) {
                val x = startX + px
                if (x >= width) break

                val offset = (y * width + x) * 3
                val prevR = vm.peek(prevRGBAddr + offset * prevAddrIncVec) ?: 0
                val prevG = vm.peek(prevRGBAddr + (offset + 1) * prevAddrIncVec) ?: 0
                val prevB = vm.peek(prevRGBAddr + (offset + 2) * prevAddrIncVec) ?: 0

                vm.poke(currentRGBAddr + offset * thisAddrIncVec, prevR)
                vm.poke(currentRGBAddr + (offset + 1) * thisAddrIncVec, prevG)
                vm.poke(currentRGBAddr + (offset + 2) * thisAddrIncVec, prevB)
            }
        }
    }

    private fun tevHandleMotionBlockTwoPass(startX: Int, startY: Int, mvX: Int, mvY: Int,
                                            currentRGBAddr: Long, prevRGBAddr: Long,
                                            width: Int, height: Int, thisAddrIncVec: Int, prevAddrIncVec: Int,
                                            debugMotionVectors: Boolean) {
        // Copy 16x16 block with motion compensation
        for (py in 0 until 16) {
            val y = startY + py
            if (y >= height) break

            for (px in 0 until 16) {
                val x = startX + px
                if (x >= width) break

                val srcX = (x + mvX).coerceIn(0, width - 1)
                val srcY = (y + mvY).coerceIn(0, height - 1)

                val srcOffset = (srcY * width + srcX) * 3
                val dstOffset = (y * width + x) * 3

                val r = vm.peek(prevRGBAddr + srcOffset * prevAddrIncVec) ?: 0
                val g = vm.peek(prevRGBAddr + (srcOffset + 1) * prevAddrIncVec) ?: 0
                val b = vm.peek(prevRGBAddr + (srcOffset + 2) * prevAddrIncVec) ?: 0

                vm.poke(currentRGBAddr + dstOffset * thisAddrIncVec, r)
                vm.poke(currentRGBAddr + (dstOffset + 1) * thisAddrIncVec, g)
                vm.poke(currentRGBAddr + (dstOffset + 2) * thisAddrIncVec, b)
            }
        }
    }

    /*private fun tevApplyMotionCompensationTwoPass(yBlock: ShortArray, coBlock: ShortArray, cgBlock: ShortArray,
                                      startX: Int, startY: Int, mvX: Int, mvY: Int,
                                      prevRGBAddr: Long, width: Int, height: Int, prevAddrIncVec: Int) {
        // For INTER blocks, add residual to motion-compensated reference
        // This is a simplified version - full implementation would extract reference block and add residuals

        // Apply motion compensation by reading reference pixels and converting to YCoCg-R coefficients
        for (py in 0 until 16) {
            val y = startY + py
            if (y >= height) break

            for (px in 0 until 16) {
                val x = startX + px
                if (x >= width) break

                val srcX = (x + mvX).coerceIn(0, width - 1)
                val srcY = (y + mvY).coerceIn(0, height - 1)

                val srcOffset = (srcY * width + srcX) * 3
                val r = vm.peek(prevRGBAddr + srcOffset * prevAddrIncVec)?.toInt() ?: 0
                val g = vm.peek(prevRGBAddr + (srcOffset + 1) * prevAddrIncVec)?.toInt() ?: 0
                val b = vm.peek(prevRGBAddr + (srcOffset + 2) * prevAddrIncVec)?.toInt() ?: 0

                // Convert reference RGB to YCoCg-R and add residual
                val co = r - b
                val tmp = b + (co / 2)
                val cg = g - tmp
                val refY = tmp + (cg / 2)

                val yIdx = py * 16 + px
                if (yIdx < yBlock.size) {
                    yBlock[yIdx] += refY.toFloat()
                }

                val cIdx = (py / 2) * 8 + (px / 2)
                if (cIdx < coBlock.size) {
                    coBlock[cIdx] += co.toFloat()
                    cgBlock[cIdx] += cg.toFloat()
                }
            }
        }
    }*/

    // Proper knusperli boundary-aware DCT optimisation based on Google's algorithm
    private fun tevApplyKnusperliOptimisation(
        yBlocks: Array<ShortArray?>, coBlocks: Array<ShortArray?>, cgBlocks: Array<ShortArray?>,
        quantTableY: IntArray, quantTableCo: IntArray, quantTableCg: IntArray,
        qY: Int, qCo: Int, qCg: Int, rateControlFactors: FloatArray,
        blocksX: Int, blocksY: Int
    ): Triple<Array<FloatArray?>, Array<FloatArray?>, Array<FloatArray?>> {
        // Google's knusperli constants (10-bit fixed-point precision)
        val kLinearGradient = intArrayOf(318, -285, 81, -32, 0, 0, 0, 0) // Only first 4 are used for 8x8, first 8 for 16x16
        val kAlphaSqrt2 = intArrayOf(1024, 1448, 1448, 1448, 1448, 1448, 1448, 1448)
        val kHalfSqrt2 = 724 // sqrt(2)/2 in 10-bit fixed-point

        // Convert to dequantised FloatArrays and apply knusperli optimisation
        val optimisedYBlocks = tevConvertAndOptimise16x16Blocks(yBlocks, quantTableY, qY, rateControlFactors, blocksX, blocksY, kLinearGradient, kAlphaSqrt2, kHalfSqrt2)
        val optimisedCoBlocks = tevConvertAndOptimise8x8Blocks(coBlocks, quantTableCo, qCo, rateControlFactors, blocksX, blocksY, kLinearGradient, kAlphaSqrt2, kHalfSqrt2)
        val optimisedCgBlocks = tevConvertAndOptimise8x8Blocks(cgBlocks, quantTableCg, qCg, rateControlFactors, blocksX, blocksY, kLinearGradient, kAlphaSqrt2, kHalfSqrt2)

        return Triple(optimisedYBlocks, optimisedCoBlocks, optimisedCgBlocks)
    }

    // IDCT functions for knusperli-optimised coefficients (coefficients are already dequantised)
    private fun tevIdct16x16_fromOptimisedCoeffs(coeffs: FloatArray): IntArray {
        val result = IntArray(256) // 16x16

        // Apply 2D IDCT directly to optimised coefficients (fix u/v indexing)
        for (y in 0 until 16) {
            for (x in 0 until 16) {
                var sum = 0.0
                for (v in 0 until 16) {
                    for (u in 0 until 16) {
                        val coeff = coeffs[v * 16 + u]  // Match original TEV coefficient layout
                        val cu = if (u == 0) 1.0 / Math.sqrt(2.0) else 1.0
                        val cv = if (v == 0) 1.0 / Math.sqrt(2.0) else 1.0
                        sum += 0.25 * 0.25 * cu * cv * coeff *
                               Math.cos((2.0 * x + 1.0) * u * Math.PI / 32.0) *
                               Math.cos((2.0 * y + 1.0) * v * Math.PI / 32.0)
                    }
                }
                result[y * 16 + x] = (sum + 128).toInt().coerceIn(0, 255) // Add DC offset
            }
        }
        return result
    }

    private fun tevIdct8x8_fromOptimisedCoeffs(coeffs: FloatArray): IntArray {
        val result = IntArray(64) // 8x8

        // Apply 2D IDCT directly to optimised coefficients (fix u/v indexing)
        for (y in 0 until 8) {
            for (x in 0 until 8) {
                var sum = 0.0
                for (v in 0 until 8) {
                    for (u in 0 until 8) {
                        val coeff = coeffs[v * 8 + u]  // Match original TEV coefficient layout
                        val cu = if (u == 0) 1.0 / Math.sqrt(2.0) else 1.0
                        val cv = if (v == 0) 1.0 / Math.sqrt(2.0) else 1.0
                        sum += 0.5 * 0.5 * cu * cv * coeff *
                               Math.cos((2.0 * x + 1.0) * u * Math.PI / 16.0) *
                               Math.cos((2.0 * y + 1.0) * v * Math.PI / 16.0)
                    }
                }
                // For chroma with isChromaResidual=true, do NOT add +128 (like normal IDCT)
                result[y * 8 + x] = sum.toInt().coerceIn(-256, 255)
            }
        }
        return result
    }

    // Convert and optimise functions for proper knusperli implementation
    // Direct 16x16 block processing for Y blocks (no subdivision needed)
    private fun tevConvertAndOptimise16x16Blocks(
        blocks: Array<ShortArray?>, quantTable: IntArray, qScale: Int, rateControlFactors: FloatArray,
        blocksX: Int, blocksY: Int,
        kLinearGradient: IntArray, kAlphaSqrt2: IntArray, kHalfSqrt2: Int
    ): Array<FloatArray?> {
        val result = Array<FloatArray?>(blocks.size) { null }

        // Extended constants for 16x16 blocks (based on Google's 8x8 pattern)
        val kLinearGradient16 = intArrayOf(318, -285, 81, -32, 17, -9, 5, -2, 1, 0, 0, 0, 0, 0, 0, 0)
        val kAlphaSqrt2_16 = intArrayOf(1024, 1448, 1448, 1448, 1448, 1448, 1448, 1448, 1448, 1448, 1448, 1448, 1448, 1448, 1448, 1448)

        // Apply knusperli boundary optimisation to 16x16 blocks
        tevProcessBlocksWithKnusperli16x16(blocks, quantTable, qScale, rateControlFactors,
                                       blocksX, blocksY, kLinearGradient16, kAlphaSqrt2_16, kHalfSqrt2)

        // Convert optimised ShortArray blocks to FloatArray (dequantised)
        for (blockIndex in 0 until blocks.size) {
            val block = blocks[blockIndex]
            if (block != null) {
                result[blockIndex] = FloatArray(256) // 16x16 = 256 coefficients
                val rateControlFactor = rateControlFactors[blockIndex]

                for (i in 0 until 256) {
                    val coeffIdx = i.coerceIn(0, quantTable.size - 1)
                    val quantValue = if (i == 0) 1.0f else {
                        quantTable[coeffIdx] * jpeg_quality_to_mult(qScale * rateControlFactor)
                    }
                    result[blockIndex]!![i] = block[i] * quantValue.coerceIn(1f, 255f)
                }
            }
        }

        return result
    }

    // Optimised 16x16 version of Knusperli processing for Y blocks
    private fun tevProcessBlocksWithKnusperli16x16(
        blocks: Array<ShortArray?>, quantTable: IntArray, qScale: Int, rateControlFactors: FloatArray,
        blocksX: Int, blocksY: Int,
        kLinearGradient16: IntArray, kAlphaSqrt2_16: IntArray, kHalfSqrt2: Int
    ) {
        val coeffsSize = 256 // 16x16 = 256
        val numBlocks = blocksX * blocksY

        // OPTIMISATION 1: Pre-compute quantisation values to avoid repeated calculations
        val quantValues = Array(numBlocks) { IntArray(coeffsSize) }
        val quantHalfValues = Array(numBlocks) { IntArray(coeffsSize) }

        for (blockIndex in 0 until numBlocks) {
            val block = blocks[blockIndex]
            if (block != null) {
                val rateControlFactor = rateControlFactors[blockIndex]
                val qualityMult = jpeg_quality_to_mult(qScale * rateControlFactor)

                quantValues[blockIndex][0] = 1 // DC is lossless
                quantHalfValues[blockIndex][0] = 0 // DC has no quantisation interval

                for (i in 1 until coeffsSize) {
                    val coeffIdx = i.coerceIn(0, quantTable.size - 1)
                    val quant = (quantTable[coeffIdx] * qualityMult).coerceIn(1f, 255f).toInt()
                    quantValues[blockIndex][i] = quant
                    quantHalfValues[blockIndex][i] = quant / 2
                }
            }
        }

        // OPTIMISATION 2: Use single-allocation arrays with block-stride access
        val blocksMid = Array(numBlocks) { IntArray(coeffsSize) }
        val blocksOff = Array(numBlocks) { LongArray(coeffsSize) } // Keep Long for accumulation

        // Step 1: Setup dequantised values and initialise adjustments (BULK OPTIMIZED)
        for (blockIndex in 0 until numBlocks) {
            val block = blocks[blockIndex]
            if (block != null) {
                val mid = blocksMid[blockIndex]
                val off = blocksOff[blockIndex]
                val quantVals = quantValues[blockIndex]

                // OPTIMISATION 9: Bulk dequantisation using vectorised operations
                tevBulkDequantiseCoefficients(block, mid, quantVals, coeffsSize)

                // OPTIMISATION 10: Bulk zero initialisation of adjustments
                off.fill(0L)
            }
        }

        // OPTIMISATION 7: Combined boundary analysis loops for better cache locality
        // Process horizontal and vertical boundaries in interleaved pattern
        for (by in 0 until blocksY) {
            for (bx in 0 until blocksX) {
                val currentIndex = by * blocksX + bx

                // Horizontal boundary (if not rightmost column)
                if (bx < blocksX - 1) {
                    val rightIndex = currentIndex + 1
                    if (blocks[currentIndex] != null && blocks[rightIndex] != null) {
                        tevAnalyseHorizontalBoundary16x16(
                            currentIndex, rightIndex, blocksMid, blocksOff,
                            kLinearGradient16, kAlphaSqrt2_16
                        )
                    }
                }

                // Vertical boundary (if not bottom row)
                if (by < blocksY - 1) {
                    val bottomIndex = currentIndex + blocksX
                    if (blocks[currentIndex] != null && blocks[bottomIndex] != null) {
                        tevAnalyseVerticalBoundary16x16(
                            currentIndex, bottomIndex, blocksMid, blocksOff,
                            kLinearGradient16, kAlphaSqrt2_16
                        )
                    }
                }
            }
        }

        // Step 4: Apply corrections and clamp to quantisation intervals (BULK OPTIMIZED)
        for (blockIndex in 0 until numBlocks) {
            val block = blocks[blockIndex]
            if (block != null) {
                // OPTIMISATION 11: Bulk apply corrections and quantisation clamping
                tevBulkApplyCorrectionsAndClamp(
                    block, blocksMid[blockIndex], blocksOff[blockIndex],
                    quantValues[blockIndex], quantHalfValues[blockIndex],
                    kHalfSqrt2, coeffsSize
                )
            }
        }
    }

    // BULK MEMORY ACCESS HELPER FUNCTIONS FOR KNUSPERLI

    /**
     * OPTIMISATION 9: Bulk dequantisation using vectorised operations
     * Performs coefficient * quantisation in optimised chunks
     */
    private fun tevBulkDequantiseCoefficients(
        coeffs: ShortArray, result: IntArray, quantVals: IntArray, size: Int
    ) {
        // Process in chunks of 16 for better vectorisation (CPU can process multiple values per instruction)
        var i = 0
        val chunks = size and 0xFFFFFFF0.toInt() // Round down to nearest 16

        // Bulk process 16 coefficients at a time for SIMD-friendly operations
        while (i < chunks) {
            // Manual loop unrolling for better performance
            result[i] = coeffs[i].toInt() * quantVals[i]
            result[i + 1] = coeffs[i + 1].toInt() * quantVals[i + 1]
            result[i + 2] = coeffs[i + 2].toInt() * quantVals[i + 2]
            result[i + 3] = coeffs[i + 3].toInt() * quantVals[i + 3]
            result[i + 4] = coeffs[i + 4].toInt() * quantVals[i + 4]
            result[i + 5] = coeffs[i + 5].toInt() * quantVals[i + 5]
            result[i + 6] = coeffs[i + 6].toInt() * quantVals[i + 6]
            result[i + 7] = coeffs[i + 7].toInt() * quantVals[i + 7]
            result[i + 8] = coeffs[i + 8].toInt() * quantVals[i + 8]
            result[i + 9] = coeffs[i + 9].toInt() * quantVals[i + 9]
            result[i + 10] = coeffs[i + 10].toInt() * quantVals[i + 10]
            result[i + 11] = coeffs[i + 11].toInt() * quantVals[i + 11]
            result[i + 12] = coeffs[i + 12].toInt() * quantVals[i + 12]
            result[i + 13] = coeffs[i + 13].toInt() * quantVals[i + 13]
            result[i + 14] = coeffs[i + 14].toInt() * quantVals[i + 14]
            result[i + 15] = coeffs[i + 15].toInt() * quantVals[i + 15]
            i += 16
        }

        // Handle remaining coefficients
        while (i < size) {
            result[i] = coeffs[i].toInt() * quantVals[i]
            i++
        }
    }

    /**
     * OPTIMISATION 11: Bulk apply corrections and quantisation clamping
     * Vectorised correction application with proper bounds checking
     */
    private fun tevBulkApplyCorrectionsAndClamp(
        block: ShortArray, mid: IntArray, off: LongArray,
        quantVals: IntArray, quantHalf: IntArray,
        kHalfSqrt2: Int, size: Int
    ) {
        var i = 0
        val chunks = size and 0xFFFFFFF0.toInt() // Process in chunks of 16

        // Bulk process corrections in chunks for better CPU pipeline utilisation
        while (i < chunks) {
            // Apply corrections with sqrt(2)/2 weighting - bulk operations
            val corr0 = ((off[i] * kHalfSqrt2) shr 31).toInt()
            val corr1 = ((off[i + 1] * kHalfSqrt2) shr 31).toInt()
            val corr2 = ((off[i + 2] * kHalfSqrt2) shr 31).toInt()
            val corr3 = ((off[i + 3] * kHalfSqrt2) shr 31).toInt()
            val corr4 = ((off[i + 4] * kHalfSqrt2) shr 31).toInt()
            val corr5 = ((off[i + 5] * kHalfSqrt2) shr 31).toInt()
            val corr6 = ((off[i + 6] * kHalfSqrt2) shr 31).toInt()
            val corr7 = ((off[i + 7] * kHalfSqrt2) shr 31).toInt()

            mid[i] += corr0
            mid[i + 1] += corr1
            mid[i + 2] += corr2
            mid[i + 3] += corr3
            mid[i + 4] += corr4
            mid[i + 5] += corr5
            mid[i + 6] += corr6
            mid[i + 7] += corr7

            // Apply quantisation interval clamping - bulk operations
            val orig0 = block[i].toInt() * quantVals[i]
            val orig1 = block[i + 1].toInt() * quantVals[i + 1]
            val orig2 = block[i + 2].toInt() * quantVals[i + 2]
            val orig3 = block[i + 3].toInt() * quantVals[i + 3]
            val orig4 = block[i + 4].toInt() * quantVals[i + 4]
            val orig5 = block[i + 5].toInt() * quantVals[i + 5]
            val orig6 = block[i + 6].toInt() * quantVals[i + 6]
            val orig7 = block[i + 7].toInt() * quantVals[i + 7]

            mid[i] = mid[i].coerceIn(orig0 - quantHalf[i], orig0 + quantHalf[i])
            mid[i + 1] = mid[i + 1].coerceIn(orig1 - quantHalf[i + 1], orig1 + quantHalf[i + 1])
            mid[i + 2] = mid[i + 2].coerceIn(orig2 - quantHalf[i + 2], orig2 + quantHalf[i + 2])
            mid[i + 3] = mid[i + 3].coerceIn(orig3 - quantHalf[i + 3], orig3 + quantHalf[i + 3])
            mid[i + 4] = mid[i + 4].coerceIn(orig4 - quantHalf[i + 4], orig4 + quantHalf[i + 4])
            mid[i + 5] = mid[i + 5].coerceIn(orig5 - quantHalf[i + 5], orig5 + quantHalf[i + 5])
            mid[i + 6] = mid[i + 6].coerceIn(orig6 - quantHalf[i + 6], orig6 + quantHalf[i + 6])
            mid[i + 7] = mid[i + 7].coerceIn(orig7 - quantHalf[i + 7], orig7 + quantHalf[i + 7])

            // Convert back to quantised coefficients - bulk operations
            val quantMax = Short.MAX_VALUE.toInt()
            val quantMin = Short.MIN_VALUE.toInt()
            block[i] = (mid[i] / quantVals[i]).coerceIn(quantMin, quantMax).toShort()
            block[i + 1] = (mid[i + 1] / quantVals[i + 1]).coerceIn(quantMin, quantMax).toShort()
            block[i + 2] = (mid[i + 2] / quantVals[i + 2]).coerceIn(quantMin, quantMax).toShort()
            block[i + 3] = (mid[i + 3] / quantVals[i + 3]).coerceIn(quantMin, quantMax).toShort()
            block[i + 4] = (mid[i + 4] / quantVals[i + 4]).coerceIn(quantMin, quantMax).toShort()
            block[i + 5] = (mid[i + 5] / quantVals[i + 5]).coerceIn(quantMin, quantMax).toShort()
            block[i + 6] = (mid[i + 6] / quantVals[i + 6]).coerceIn(quantMin, quantMax).toShort()
            block[i + 7] = (mid[i + 7] / quantVals[i + 7]).coerceIn(quantMin, quantMax).toShort()

            i += 8 // Process 8 at a time for the remaining corrections
        }

        // Handle remaining coefficients (usually 0-15 remaining for 256-coefficient blocks)
        while (i < size) {
            mid[i] += ((off[i] * kHalfSqrt2) shr 31).toInt()

            val originalValue = block[i].toInt() * quantVals[i]
            mid[i] = mid[i].coerceIn(originalValue - quantHalf[i], originalValue + quantHalf[i])

            block[i] = (mid[i] / quantVals[i]).coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
            i++
        }
    }

    // OPTIMIZED 16x16 horizontal boundary analysis
    private fun tevAnalyseHorizontalBoundary16x16(
        leftBlockIndex: Int, rightBlockIndex: Int,
        blocksMid: Array<IntArray>, blocksOff: Array<LongArray>,
        kLinearGradient16: IntArray, kAlphaSqrt2_16: IntArray
    ) {
        val leftMid = blocksMid[leftBlockIndex]
        val rightMid = blocksMid[rightBlockIndex]
        val leftOff = blocksOff[leftBlockIndex]
        val rightOff = blocksOff[rightBlockIndex]

        // OPTIMISATION 4: Process multiple frequencies in single loop for better cache locality
        for (v in 0 until 8) { // Only low-to-mid frequencies
            var deltaV = 0L
            var hfPenalty = 0L
            val vOffset = v * 16

            // First pass: Calculate boundary discontinuity
            for (u in 0 until 16) {
                val idx = vOffset + u
                val alpha = kAlphaSqrt2_16[u]
                val sign = if (u and 1 != 0) -1 else 1
                val gi = leftMid[idx]
                val gj = rightMid[idx]

                deltaV += alpha * (gj - sign * gi)
                hfPenalty += (u * u) * (gi * gi + gj * gj)
            }

            // OPTIMISATION 8: Early exit for very small adjustments
            if (kotlin.math.abs(deltaV) < 100) continue

            // OPTIMISATION 5: Apply high-frequency damping once per frequency band
            if (hfPenalty > 1600) deltaV /= 2

            // Second pass: Apply corrections (BULK OPTIMIZED with unrolling)
            val correction = deltaV
            // Bulk apply corrections for 16 coefficients - manually unrolled for performance
            leftOff[vOffset] += correction * kLinearGradient16[0]
            rightOff[vOffset] += correction * kLinearGradient16[0]
            leftOff[vOffset + 1] += correction * kLinearGradient16[1]
            rightOff[vOffset + 1] -= correction * kLinearGradient16[1] // Alternating signs
            leftOff[vOffset + 2] += correction * kLinearGradient16[2]
            rightOff[vOffset + 2] += correction * kLinearGradient16[2]
            leftOff[vOffset + 3] += correction * kLinearGradient16[3]
            rightOff[vOffset + 3] -= correction * kLinearGradient16[3]
            leftOff[vOffset + 4] += correction * kLinearGradient16[4]
            rightOff[vOffset + 4] += correction * kLinearGradient16[4]
            leftOff[vOffset + 5] += correction * kLinearGradient16[5]
            rightOff[vOffset + 5] -= correction * kLinearGradient16[5]
            leftOff[vOffset + 6] += correction * kLinearGradient16[6]
            rightOff[vOffset + 6] += correction * kLinearGradient16[6]
            leftOff[vOffset + 7] += correction * kLinearGradient16[7]
            rightOff[vOffset + 7] -= correction * kLinearGradient16[7]
            leftOff[vOffset + 8] += correction * kLinearGradient16[8]
            rightOff[vOffset + 8] += correction * kLinearGradient16[8]
            leftOff[vOffset + 9] += correction * kLinearGradient16[9]
            rightOff[vOffset + 9] -= correction * kLinearGradient16[9]
            leftOff[vOffset + 10] += correction * kLinearGradient16[10]
            rightOff[vOffset + 10] += correction * kLinearGradient16[10]
            leftOff[vOffset + 11] += correction * kLinearGradient16[11]
            rightOff[vOffset + 11] -= correction * kLinearGradient16[11]
            leftOff[vOffset + 12] += correction * kLinearGradient16[12]
            rightOff[vOffset + 12] += correction * kLinearGradient16[12]
            leftOff[vOffset + 13] += correction * kLinearGradient16[13]
            rightOff[vOffset + 13] -= correction * kLinearGradient16[13]
            leftOff[vOffset + 14] += correction * kLinearGradient16[14]
            rightOff[vOffset + 14] += correction * kLinearGradient16[14]
            leftOff[vOffset + 15] += correction * kLinearGradient16[15]
            rightOff[vOffset + 15] -= correction * kLinearGradient16[15]
        }
    }

    // OPTIMIZED 16x16 vertical boundary analysis
    private fun tevAnalyseVerticalBoundary16x16(
        topBlockIndex: Int, bottomBlockIndex: Int,
        blocksMid: Array<IntArray>, blocksOff: Array<LongArray>,
        kLinearGradient16: IntArray, kAlphaSqrt2_16: IntArray
    ) {
        val topMid = blocksMid[topBlockIndex]
        val bottomMid = blocksMid[bottomBlockIndex]
        val topOff = blocksOff[topBlockIndex]
        val bottomOff = blocksOff[bottomBlockIndex]

        // OPTIMISATION 6: Optimised vertical analysis with better cache access pattern
        for (u in 0 until 16) { // Only low-to-mid frequencies
            var deltaU = 0L
            var hfPenalty = 0L

            // First pass: Calculate boundary discontinuity
            for (v in 0 until 16) {
                val idx = v * 16 + u
                val alpha = kAlphaSqrt2_16[v]
                val sign = if (v and 1 != 0) -1 else 1
                val gi = topMid[idx]
                val gj = bottomMid[idx]

                deltaU += alpha * (gj - sign * gi)
                hfPenalty += (v * v) * (gi * gi + gj * gj)
            }

            // Early exit for very small adjustments
            if (kotlin.math.abs(deltaU) < 100) continue

            // Apply high-frequency damping once per frequency band
            if (hfPenalty > 1600) deltaU /= 2

            // Second pass: Apply corrections (BULK OPTIMIZED vertical)
            val correction = deltaU
            // Bulk apply corrections for 16 vertical coefficients - manually unrolled
            topOff[u] += correction * kLinearGradient16[0]
            bottomOff[u] += correction * kLinearGradient16[0]
            topOff[16 + u] += correction * kLinearGradient16[1]
            bottomOff[16 + u] -= correction * kLinearGradient16[1] // Alternating signs
            topOff[32 + u] += correction * kLinearGradient16[2]
            bottomOff[32 + u] += correction * kLinearGradient16[2]
            topOff[48 + u] += correction * kLinearGradient16[3]
            bottomOff[48 + u] -= correction * kLinearGradient16[3]
            topOff[64 + u] += correction * kLinearGradient16[4]
            bottomOff[64 + u] += correction * kLinearGradient16[4]
            topOff[80 + u] += correction * kLinearGradient16[5]
            bottomOff[80 + u] -= correction * kLinearGradient16[5]
            topOff[96 + u] += correction * kLinearGradient16[6]
            bottomOff[96 + u] += correction * kLinearGradient16[6]
            topOff[112 + u] += correction * kLinearGradient16[7]
            bottomOff[112 + u] -= correction * kLinearGradient16[7]
            topOff[128 + u] += correction * kLinearGradient16[8]
            bottomOff[128 + u] += correction * kLinearGradient16[8]
            topOff[144 + u] += correction * kLinearGradient16[9]
            bottomOff[144 + u] -= correction * kLinearGradient16[9]
            topOff[160 + u] += correction * kLinearGradient16[10]
            bottomOff[160 + u] += correction * kLinearGradient16[10]
            topOff[176 + u] += correction * kLinearGradient16[11]
            bottomOff[176 + u] -= correction * kLinearGradient16[11]
            topOff[192 + u] += correction * kLinearGradient16[12]
            bottomOff[192 + u] += correction * kLinearGradient16[12]
            topOff[208 + u] += correction * kLinearGradient16[13]
            bottomOff[208 + u] -= correction * kLinearGradient16[13]
            topOff[224 + u] += correction * kLinearGradient16[14]
            bottomOff[224 + u] += correction * kLinearGradient16[14]
            topOff[240 + u] += correction * kLinearGradient16[15]
            bottomOff[240 + u] -= correction * kLinearGradient16[15]
        }
    }

    private fun tevConvertAndOptimise8x8Blocks(
        blocks: Array<ShortArray?>, quantTable: IntArray, qScale: Int, rateControlFactors: FloatArray,
        blocksX: Int, blocksY: Int,
        kLinearGradient: IntArray, kAlphaSqrt2: IntArray, kHalfSqrt2: Int
    ): Array<FloatArray?> {
        val coeffsSize = 64
        val numBlocks = blocksX * blocksY

        // Step 1: Setup quantisation intervals for all blocks (using integers like Google's code)
        val blocksMid = Array(numBlocks) { IntArray(coeffsSize) }
        val blocksMin = Array(numBlocks) { IntArray(coeffsSize) }
        val blocksMax = Array(numBlocks) { IntArray(coeffsSize) }
        val blocksOff = Array(numBlocks) { LongArray(coeffsSize) } // Long for accumulation

        for (blockIndex in 0 until numBlocks) {
            val block = blocks[blockIndex]
            if (block != null) {
                val rateControlFactor = rateControlFactors[blockIndex]
                for (i in 0 until coeffsSize) {
                    val quantIdx = i.coerceIn(0, quantTable.size - 1)

                    if (i == 0) {
                        // DC coefficient: lossless (no quantisation)
                        val dcValue = block[i].toInt()
                        blocksMid[blockIndex][i] = dcValue
                        blocksMin[blockIndex][i] = dcValue  // No interval for DC
                        blocksMax[blockIndex][i] = dcValue
                    } else {
                        // AC coefficients: use quantisation intervals
                        val quant = (quantTable[quantIdx] * jpeg_quality_to_mult(qScale * rateControlFactor)).coerceIn(1f, 255f).toInt()

                        // Standard dequantised value (midpoint)
                        blocksMid[blockIndex][i] = block[i].toInt() * quant

                        // Quantisation interval bounds
                        val halfQuant = quant / 2
                        blocksMin[blockIndex][i] = blocksMid[blockIndex][i] - halfQuant
                        blocksMax[blockIndex][i] = blocksMid[blockIndex][i] + halfQuant
                    }

                    // Initialise adjustment accumulator
                    blocksOff[blockIndex][i] = 0L
                }
            }
        }

        // Step 2: Horizontal continuity analysis
        for (by in 0 until blocksY) {
            for (bx in 0 until blocksX - 1) {
                val leftBlockIndex = by * blocksX + bx
                val rightBlockIndex = by * blocksX + (bx + 1)

                if (blocks[leftBlockIndex] != null && blocks[rightBlockIndex] != null) {
                    tevAnalyseHorizontalBoundary8x8(
                        leftBlockIndex, rightBlockIndex, blocksMid, blocksOff,
                        kLinearGradient, kAlphaSqrt2
                    )
                }
            }
        }

        // Step 3: Vertical continuity analysis
        for (by in 0 until blocksY - 1) {
            for (bx in 0 until blocksX) {
                val topBlockIndex = by * blocksX + bx
                val bottomBlockIndex = (by + 1) * blocksX + bx

                if (blocks[topBlockIndex] != null && blocks[bottomBlockIndex] != null) {
                    tevAnalyseVerticalBoundary8x8(
                        topBlockIndex, bottomBlockIndex, blocksMid, blocksOff,
                        kLinearGradient, kAlphaSqrt2
                    )
                }
            }
        }

        // Step 4: Apply corrections and return optimised dequantised coefficients
        val result = Array<FloatArray?>(blocks.size) { null }
        for (blockIndex in 0 until numBlocks) {
            val block = blocks[blockIndex]
            if (block != null) {
                result[blockIndex] = FloatArray(coeffsSize) { i ->
                    // Apply corrections with sqrt(2)/2 weighting (Google's exact formula with right shift)
                    blocksMid[blockIndex][i] += ((blocksOff[blockIndex][i] * kHalfSqrt2) shr 31).toInt()

                    // Clamp to quantisation interval bounds
                    val optimisedValue = blocksMid[blockIndex][i].coerceIn(
                        blocksMin[blockIndex][i],
                        blocksMax[blockIndex][i]
                    )

                    optimisedValue.toFloat()
                }
            }
        }

        return result
    }

    // BULK OPTIMIZED 8x8 horizontal boundary analysis for chroma channels
    private fun tevAnalyseHorizontalBoundary8x8(
        leftBlockIndex: Int, rightBlockIndex: Int,
        blocksMid: Array<IntArray>, blocksOff: Array<LongArray>,
        kLinearGradient: IntArray, kAlphaSqrt2: IntArray
    ) {
        val leftMid = blocksMid[leftBlockIndex]
        val rightMid = blocksMid[rightBlockIndex]
        val leftOff = blocksOff[leftBlockIndex]
        val rightOff = blocksOff[rightBlockIndex]

        // OPTIMISATION 12: Process 8x8 boundaries with bulk operations (v < 4 for low-to-mid frequencies)
        for (v in 0 until 4) { // Only low-to-mid frequencies for 8x8
            var deltaV = 0L
            var hfPenalty = 0L
            val vOffset = v * 8

            // First pass: Calculate boundary discontinuity
            for (u in 0 until 8) {
                val idx = vOffset + u
                val alpha = kAlphaSqrt2[u] // Direct access (u < 8)
                val sign = if (u and 1 != 0) -1 else 1
                val gi = leftMid[idx]
                val gj = rightMid[idx]

                deltaV += alpha * (gj - sign * gi)
                hfPenalty += (u * u) * (gi * gi + gj * gj)
            }

            // Early exit for very small adjustments
            if (kotlin.math.abs(deltaV) < 100) continue

            // Apply high-frequency damping once per frequency band
            if (hfPenalty > 400) deltaV /= 2 // 8x8 threshold

            // Second pass: Apply corrections (BULK OPTIMIZED with unrolling for 8x8)
            val correction = deltaV
            // Bulk apply corrections for 8 coefficients - manually unrolled for performance
            leftOff[vOffset] += correction * kLinearGradient[0]
            rightOff[vOffset] += correction * kLinearGradient[0]
            leftOff[vOffset + 1] += correction * kLinearGradient[1]
            rightOff[vOffset + 1] -= correction * kLinearGradient[1] // Alternating signs
            leftOff[vOffset + 2] += correction * kLinearGradient[2]
            rightOff[vOffset + 2] += correction * kLinearGradient[2]
            leftOff[vOffset + 3] += correction * kLinearGradient[3]
            rightOff[vOffset + 3] -= correction * kLinearGradient[3]
            leftOff[vOffset + 4] += correction * kLinearGradient[4]
            rightOff[vOffset + 4] += correction * kLinearGradient[4]
            leftOff[vOffset + 5] += correction * kLinearGradient[5]
            rightOff[vOffset + 5] -= correction * kLinearGradient[5]
            leftOff[vOffset + 6] += correction * kLinearGradient[6]
            rightOff[vOffset + 6] += correction * kLinearGradient[6]
            leftOff[vOffset + 7] += correction * kLinearGradient[7]
            rightOff[vOffset + 7] -= correction * kLinearGradient[7]
        }
    }

    // BULK OPTIMIZED 8x8 vertical boundary analysis for chroma channels
    private fun tevAnalyseVerticalBoundary8x8(
        topBlockIndex: Int, bottomBlockIndex: Int,
        blocksMid: Array<IntArray>, blocksOff: Array<LongArray>, 
        kLinearGradient: IntArray, kAlphaSqrt2: IntArray
    ) {
        val topMid = blocksMid[topBlockIndex]
        val bottomMid = blocksMid[bottomBlockIndex]
        val topOff = blocksOff[topBlockIndex]
        val bottomOff = blocksOff[bottomBlockIndex]
        
        // OPTIMISATION 13: Optimised vertical analysis for 8x8 with better cache access pattern
        for (u in 0 until 4) { // Only low-to-mid frequencies for 8x8
            var deltaU = 0L
            var hfPenalty = 0L
            
            // First pass: Calculate boundary discontinuity
            for (v in 0 until 8) {
                val idx = v * 8 + u
                val alpha = kAlphaSqrt2[v] // Direct access (v < 8)
                val sign = if (v and 1 != 0) -1 else 1
                val gi = topMid[idx]
                val gj = bottomMid[idx]
                
                deltaU += alpha * (gj - sign * gi)
                hfPenalty += (v * v) * (gi * gi + gj * gj)
            }
            
            // Early exit for very small adjustments
            if (kotlin.math.abs(deltaU) < 100) continue
            
            // Apply high-frequency damping once per frequency band
            if (hfPenalty > 400) deltaU /= 2 // 8x8 threshold
            
            // Second pass: Apply corrections (BULK OPTIMIZED vertical for 8x8)
            val correction = deltaU
            // Bulk apply corrections for 8 vertical coefficients - manually unrolled
            topOff[u] += correction * kLinearGradient[0]
            bottomOff[u] += correction * kLinearGradient[0]
            topOff[8 + u] += correction * kLinearGradient[1]
            bottomOff[8 + u] -= correction * kLinearGradient[1] // Alternating signs
            topOff[16 + u] += correction * kLinearGradient[2]
            bottomOff[16 + u] += correction * kLinearGradient[2]
            topOff[24 + u] += correction * kLinearGradient[3]
            bottomOff[24 + u] -= correction * kLinearGradient[3]
            topOff[32 + u] += correction * kLinearGradient[4]
            bottomOff[32 + u] += correction * kLinearGradient[4]
            topOff[40 + u] += correction * kLinearGradient[5]
            bottomOff[40 + u] -= correction * kLinearGradient[5]
            topOff[48 + u] += correction * kLinearGradient[6]
            bottomOff[48 + u] += correction * kLinearGradient[6]
            topOff[56 + u] += correction * kLinearGradient[7]
            bottomOff[56 + u] -= correction * kLinearGradient[7]
        }
    }

    // ================= TAV (TSVM Advanced Video) Decoder =================
    // DWT-based video codec with ICtCp colour space support

    // Postprocess coefficients from significance map format (legacy - single channel)
    private fun postprocessCoefficients(compressedData: ByteArray, compressedOffset: Int, coeffCount: Int, outputCoeffs: ShortArray) {
        val mapBytes = (coeffCount + 7) / 8

        // Clear output array
        outputCoeffs.fill(0)

        // Extract significance map and values
        var valueIdx = 0
        val valuesOffset = compressedOffset + mapBytes

        for (i in 0 until coeffCount) {
            val byteIdx = i / 8
            val bitIdx = i % 8
            val mapByte = compressedData[compressedOffset + byteIdx].toInt() and 0xFF

            if ((mapByte and (1 shl bitIdx)) != 0) {
                // Non-zero coefficient - read the value
                val valueOffset = valuesOffset + valueIdx * 2
                outputCoeffs[i] = (((compressedData[valueOffset + 1].toInt() and 0xFF) shl 8) or
                                  (compressedData[valueOffset].toInt() and 0xFF)).toShort()
                valueIdx++
            }
        }
    }

    // Postprocess coefficients from concatenated significance maps format (current - optimal)
    // Channel layout constants (bit-field design)
    companion object {
        const val CHANNEL_LAYOUT_YCOCG = 0     // Y-Co-Cg (000: no alpha, has chroma, has luma)
        const val CHANNEL_LAYOUT_YCOCG_A = 1   // Y-Co-Cg-A (001: has alpha, has chroma, has luma)
        const val CHANNEL_LAYOUT_Y_ONLY = 2    // Y only (010: no alpha, no chroma, has luma)
        const val CHANNEL_LAYOUT_Y_A = 3       // Y-A (011: has alpha, no chroma, has luma)
        const val CHANNEL_LAYOUT_COCG = 4      // Co-Cg (100: no alpha, has chroma, no luma)
        const val CHANNEL_LAYOUT_COCG_A = 5    // Co-Cg-A (101: has alpha, has chroma, no luma)

        // ICtCp→RGB LUT (256×256×256 × 3 bytes = 48 MB)
        // Layout: lut[I * 256 * 256 * 3 + Ct * 256 * 3 + Cp * 3 + channel]
        // where I ∈ [0,255], Ct ∈ [0,511], Cp ∈ [0,511], channel ∈ {0=R, 1=G, 2=B}
        private val ICTCP_LUT_SIZE = 256L * 256L * 256L * 3L  // 201,326,592 bytes
        private var ictcpLUT: UnsafePtr? = null

        init {
            println("[ICtCp LUT] Initializing 256×256×256 lookup table (48 MB)...")
            val startTime = System.currentTimeMillis()

            // Allocate native memory
            ictcpLUT = UnsafeHelper.allocate(ICTCP_LUT_SIZE, this)

            // Precompute all possible ICtCp→RGB conversions
            for (i in 0..255) {
                for (ct in 0..255) {
                    for (cp in 0..255) {
                        // Convert index to ICtCp values (matching decoder range)
                        val I = i / 255.0f
                        val Ct = (ct - 127.5f) / 255.0f  // Center at 127.5 for symmetric range
                        val Cp = (cp - 127.5f) / 255.0f

                        // ICtCp → L'M'S' (inverse matrix)
                        val Lp = I + 0.015718580108730416f * Ct + 0.2095810681164055f * Cp
                        val Mp = I - 0.015718580108730416f * Ct - 0.20958106811640548f * Cp
                        val Sp = I + 1.0212710798422344f * Ct - 0.6052744909924316f * Cp

                        // HLG decode: L'M'S' → linear LMS
                        val L = HLG_EOTF_static(Lp)
                        val M = HLG_EOTF_static(Mp)
                        val S = HLG_EOTF_static(Sp)

                        // LMS → linear sRGB (inverse matrix)
                        val rLin = 6.1723815689243215f * L - 5.319534979827695f * M + 0.14699442094633924f * S
                        val gLin = -1.3243428148026244f * L + 2.560286104841917f * M - 0.2359203727576164f * S
                        val bLin = -0.011819739235953752f * L - 0.26473549971186555f * M + 1.2767952602537955f * S

                        // Gamma encode to sRGB
                        val rSrgb = srgbUnlinearise_static(rLin)
                        val gSrgb = srgbUnlinearise_static(gLin)
                        val bSrgb = srgbUnlinearise_static(bLin)

                        // Store RGB bytes in LUT
                        val lutIndex = (i.toLong() * 256L * 256L * 3L) + (ct.toLong() * 256L * 3L) + (cp.toLong() * 3L)
                        ictcpLUT!!.set(lutIndex + 0, (rSrgb * 255.0f).toInt().coerceIn(0, 255).toByte())
                        ictcpLUT!!.set(lutIndex + 1, (gSrgb * 255.0f).toInt().coerceIn(0, 255).toByte())
                        ictcpLUT!!.set(lutIndex + 2, (bSrgb * 255.0f).toInt().coerceIn(0, 255).toByte())
                    }
                }

                // Progress indicator every 32 I values
                if (i % 32 == 0) {
                    print(".")
                }
            }

            val elapsedMs = System.currentTimeMillis() - startTime
            println("\n[ICtCp LUT] Initialized in ${elapsedMs}ms")

            // Register shutdown hook to free native memory
            Runtime.getRuntime().addShutdownHook(Thread {
                println("[ICtCp LUT] Freeing native memory...")
                ictcpLUT?.destroy()
                ictcpLUT = null
            })
        }

        // Static helper functions for LUT initialization (must match instance methods)
        private fun HLG_EOTF_static(V: Float): Float {
            val a = 0.17883277f
            val b = 1.0f - 4.0f * a
            val c = 0.5f - a * ln(4.0f * a)

            return if (V <= 0.5f)
                (V * V) / 3.0f
            else
                (exp((V - c) / a) + b) / 12.0f
        }

        private fun srgbUnlinearise_static(value: Float): Float {
            return if (value <= 0.0031308f) {
                value * 12.92f
            } else {
                1.055f * value.pow(1.0f / 2.4f) - 0.055f
            }
        }

        // Fast LUT lookup function (no bounds checking with UnsafePtr)
        fun lookupICtCpToRGB(I: Int, Ct: Int, Cp: Int): Triple<Byte, Byte, Byte> {
            val lutIndex = (I.toLong() * 256L * 256L * 3L) + (Ct.toLong() * 256L * 3L) + (Cp.toLong() * 3L)
            val r = ictcpLUT!!.get(lutIndex + 0)
            val g = ictcpLUT!!.get(lutIndex + 1)
            val b = ictcpLUT!!.get(lutIndex + 2)
            return Triple(r, g, b)
        }
    }

    // Variable channel layout postprocessing for concatenated maps
    // Significance Map v2.1 (twobit-map): 2 bits per coefficient
    // 00=zero, 01=+1, 10=-1, 11=other (stored as int16)
    private fun postprocessCoefficientsVariableLayout(compressedData: ByteArray, compressedOffset: Int, coeffCount: Int,
                                                     channelLayout: Int, outputY: ShortArray?, outputCo: ShortArray?,
                                                     outputCg: ShortArray?, outputAlpha: ShortArray?) {
        val mapBytes = (coeffCount * 2 + 7) / 8  // 2 bits per coefficient

        // Determine active channels based on layout (bit-field design)
        val hasY = channelLayout and 4 == 0      // bit 2 inverted: 0 means has luma
        val hasCo = channelLayout and 2 == 0     // bit 1 inverted: 0 means has chroma
        val hasCg = channelLayout and 2 == 0     // bit 1 inverted: 0 means has chroma (same as Co)
        val hasAlpha = channelLayout and 1 != 0  // bit 0: 1 means has alpha

        // Clear output arrays
        outputY?.fill(0)
        outputCo?.fill(0)
        outputCg?.fill(0)
        outputAlpha?.fill(0)

        var mapOffset = compressedOffset
        var mapIndex = 0

        // Map offsets for active channels
        val yMapOffset = if (hasY) { val offset = mapOffset; mapOffset += mapBytes; offset } else -1
        val coMapOffset = if (hasCo) { val offset = mapOffset; mapOffset += mapBytes; offset } else -1
        val cgMapOffset = if (hasCg) { val offset = mapOffset; mapOffset += mapBytes; offset } else -1
        val alphaMapOffset = if (hasAlpha) { val offset = mapOffset; mapOffset += mapBytes; offset } else -1

        // Helper function to extract 2-bit code
        fun getTwoBitCode(mapStart: Int, coeffIdx: Int): Int {
            val bitPos = coeffIdx * 2
            val byteIdx = bitPos / 8
            val bitOffset = bitPos % 8

            val byte0 = compressedData[mapStart + byteIdx].toInt() and 0xFF
            val code = (byte0 shr bitOffset) and 0x03

            // Handle byte boundary crossing
            return if (bitOffset == 7 && byteIdx + 1 < mapBytes) {
                val byte1 = compressedData[mapStart + byteIdx + 1].toInt() and 0xFF
                ((byte0 shr 7) and 0x01) or ((byte1 shl 1) and 0x02)
            } else {
                code
            }
        }

        // Count "other" values (code 11) for each active channel
        var yOthers = 0
        var coOthers = 0
        var cgOthers = 0
        var alphaOthers = 0

        for (i in 0 until coeffCount) {
            if (hasY && yMapOffset >= 0 && getTwoBitCode(yMapOffset, i) == 3) yOthers++
            if (hasCo && coMapOffset >= 0 && getTwoBitCode(coMapOffset, i) == 3) coOthers++
            if (hasCg && cgMapOffset >= 0 && getTwoBitCode(cgMapOffset, i) == 3) cgOthers++
            if (hasAlpha && alphaMapOffset >= 0 && getTwoBitCode(alphaMapOffset, i) == 3) alphaOthers++
        }

        // Calculate value array offsets (only for "other" values)
        var valueOffset = mapOffset
        val yValuesOffset = if (hasY) { val offset = valueOffset; valueOffset += yOthers * 2; offset } else -1
        val coValuesOffset = if (hasCo) { val offset = valueOffset; valueOffset += coOthers * 2; offset } else -1
        val cgValuesOffset = if (hasCg) { val offset = valueOffset; valueOffset += cgOthers * 2; offset } else -1
        val alphaValuesOffset = if (hasAlpha) { val offset = valueOffset; valueOffset += alphaOthers * 2; offset } else -1

        // Reconstruct coefficients
        var yValueIdx = 0
        var coValueIdx = 0
        var cgValueIdx = 0
        var alphaValueIdx = 0

        for (i in 0 until coeffCount) {
            // Y channel
            if (hasY && yMapOffset >= 0 && outputY != null) {
                when (getTwoBitCode(yMapOffset, i)) {
                    0 -> outputY[i] = 0     // 00 = zero
                    1 -> outputY[i] = 1     // 01 = +1
                    2 -> outputY[i] = -1    // 10 = -1
                    3 -> {                  // 11 = other (read int16)
                        val valuePos = yValuesOffset + yValueIdx * 2
                        outputY[i] = (((compressedData[valuePos + 1].toInt() and 0xFF) shl 8) or
                                     (compressedData[valuePos].toInt() and 0xFF)).toShort()
                        yValueIdx++
                    }
                }
            }

            // Co channel
            if (hasCo && coMapOffset >= 0 && outputCo != null) {
                when (getTwoBitCode(coMapOffset, i)) {
                    0 -> outputCo[i] = 0
                    1 -> outputCo[i] = 1
                    2 -> outputCo[i] = -1
                    3 -> {
                        val valuePos = coValuesOffset + coValueIdx * 2
                        outputCo[i] = (((compressedData[valuePos + 1].toInt() and 0xFF) shl 8) or
                                      (compressedData[valuePos].toInt() and 0xFF)).toShort()
                        coValueIdx++
                    }
                }
            }

            // Cg channel
            if (hasCg && cgMapOffset >= 0 && outputCg != null) {
                when (getTwoBitCode(cgMapOffset, i)) {
                    0 -> outputCg[i] = 0
                    1 -> outputCg[i] = 1
                    2 -> outputCg[i] = -1
                    3 -> {
                        val valuePos = cgValuesOffset + cgValueIdx * 2
                        outputCg[i] = (((compressedData[valuePos + 1].toInt() and 0xFF) shl 8) or
                                      (compressedData[valuePos].toInt() and 0xFF)).toShort()
                        cgValueIdx++
                    }
                }
            }

            // Alpha channel
            if (hasAlpha && alphaMapOffset >= 0 && outputAlpha != null) {
                when (getTwoBitCode(alphaMapOffset, i)) {
                    0 -> outputAlpha[i] = 0
                    1 -> outputAlpha[i] = 1
                    2 -> outputAlpha[i] = -1
                    3 -> {
                        val valuePos = alphaValuesOffset + alphaValueIdx * 2
                        outputAlpha[i] = (((compressedData[valuePos + 1].toInt() and 0xFF) shl 8) or
                                         (compressedData[valuePos].toInt() and 0xFF)).toShort()
                        alphaValueIdx++
                    }
                }
            }
        }
    }

    // TAV Simulated overlapping tiles constants (must match encoder)
    private val TAV_TILE_SIZE_X = 640
    private val TAV_TILE_SIZE_Y = 540
    private val TAV_TILE_MARGIN = 32  // 32-pixel margin for 3 DWT levels (4 * 2^3 = 32px)
    private val TAV_PADDED_TILE_SIZE_X = TAV_TILE_SIZE_X + 2 * TAV_TILE_MARGIN
    private val TAV_PADDED_TILE_SIZE_Y = TAV_TILE_SIZE_Y + 2 * TAV_TILE_MARGIN

    // TAV coefficient delta storage for previous frame (for efficient P-frames)
    private var tavPreviousCoeffsY: MutableMap<Int, FloatArray>? = null
    private var tavPreviousCoeffsCo: MutableMap<Int, FloatArray>? = null
    private var tavPreviousCoeffsCg: MutableMap<Int, FloatArray>? = null

    // TAV Perceptual dequantisation support (must match encoder weights)
    data class DWTSubbandInfo(
        val level: Int,          // Decomposition level (1 to decompLevels)
        val subbandType: Int,    // 0=LL, 1=LH, 2=HL, 3=HH
        val coeffStart: Int,     // Starting index in linear coefficient array
        val coeffCount: Int,     // Number of coefficients in this subband
        val perceptualWeight: Float // Quantisation multiplier for this subband
    )


    // TAV Perceptual dequantisation helper functions (must match encoder implementation exactly)
    private fun calculateSubbandLayout(width: Int, height: Int, decompLevels: Int): List<DWTSubbandInfo> {
        val subbands = mutableListOf<DWTSubbandInfo>()

        // Start with the LL subband at maximum decomposition level (MUST match encoder exactly)
        val llWidth = width shr decompLevels  // Right shift by decomp_levels (equivalent to >> in C)
        val llHeight = height shr decompLevels
        subbands.add(DWTSubbandInfo(decompLevels, 0, 0, llWidth * llHeight, 0f)) // LL subband
        var coeffOffset = llWidth * llHeight

        // Add LH, HL, HH subbands for each level from max down to 1 (MUST match encoder exactly)
        for (level in decompLevels downTo 1) {
            // Use encoder's exact calculation: width >> (decomp_levels - level + 1)
            val levelWidth = width shr (decompLevels - level + 1)
            val levelHeight = height shr (decompLevels - level + 1)
            val subbandSize = levelWidth * levelHeight

            // LH subband (horizontal high, vertical low)
            subbands.add(DWTSubbandInfo(level, 1, coeffOffset, subbandSize, 0f))
            coeffOffset += subbandSize

            // HL subband (horizontal low, vertical high)
            subbands.add(DWTSubbandInfo(level, 2, coeffOffset, subbandSize, 0f))
            coeffOffset += subbandSize

            // HH subband (horizontal high, vertical high)
            subbands.add(DWTSubbandInfo(level, 3, coeffOffset, subbandSize, 0f))
            coeffOffset += subbandSize
        }

        // Debug: Validate subband coverage
        if (tavDebugCurrentFrameNumber == tavDebugFrameTarget) {
            val expectedTotal = width * height
            val actualTotal = subbands.sumOf { it.coeffCount }
            val maxIndex = subbands.maxOfOrNull { it.coeffStart + it.coeffCount - 1 } ?: -1

            println("SUBBAND LAYOUT VALIDATION:")
            println("  Expected coeffs: $expectedTotal (${width}x${height})")
            println("  Actual coeffs: $actualTotal")
            println("  Max index: $maxIndex")
            println("  Decomp levels: $decompLevels")

            // Check for overlaps and gaps
            val covered = BooleanArray(expectedTotal)
            var overlaps = 0
            for (subband in subbands) {
                for (i in 0 until subband.coeffCount) {
                    val idx = subband.coeffStart + i
                    if (idx < covered.size) {
                        if (covered[idx]) overlaps++
                        covered[idx] = true
                    }
                }
            }
            val gaps = covered.count { !it }
            println("  Overlaps: $overlaps, Gaps: $gaps")

            if (gaps > 0 || overlaps > 0 || actualTotal != expectedTotal) {
                println("  ERROR: Subband layout is incorrect!")
            }
        }

        return subbands
    }

    var ANISOTROPY_MULT = floatArrayOf(5.1f, 3.8f, 2.7f, 2.0f, 1.5f, 1.2f, 1.0f)
    var ANISOTROPY_BIAS = floatArrayOf(0.4f, 0.3f, 0.2f, 0.1f, 0.0f, 0.0f, 0.0f)
    var ANISOTROPY_MULT_CHROMA = floatArrayOf(7.0f, 6.0f, 5.0f, 4.0f, 3.0f, 2.0f, 1.0f)
    var ANISOTROPY_BIAS_CHROMA = floatArrayOf(1.0f, 0.8f, 0.6f, 0.4f, 0.2f, 0.0f, 0.0f)



    private fun perceptual_model3_LH(level: Float): Float {
        val H4 = 1.2f
        val Q = 2f // using fixed value for fixed curve; quantiser will scale it up anyway
        val Q12 = Q * 12f
        val x = level

        val Lx = H4 - ((Q + 1f) / 15f) * (x - 4f)
        val C3 = -1f / 45f * (Q12 + 92)
        val G3x = (-x / 180f) * (Q12 + 5 * x * x - 60 * x + 252) - C3 + H4

        return if (level >= 4) Lx else G3x
    }

    private fun perceptual_model3_HL(quality: Int, LH: Float): Float {
        return LH * ANISOTROPY_MULT[quality] + ANISOTROPY_BIAS[quality]
    }

    fun lerp(x: Float, y: Float, a: Float): Float {
        return x * (1f - a) + y * a
    }

    fun perceptual_model3_HH(LH: Float, HL: Float, level: Float): Float {
        val Kx: Float = (sqrt(level) - 1f) * 0.5f + 0.5f
        return lerp(LH, HL, Kx)
    }

    fun perceptual_model3_LL(level: Float): Float {
        val n = perceptual_model3_LH(level)
        val m = perceptual_model3_LH(level - 1) / n

        return n / m
    }

    fun perceptual_model3_chroma_basecurve(quality: Int, level: Float): Float {
        return 1.0f - (1.0f / (0.5f * quality * quality + 1.0f)) * (level - 4f) // just a line that passes (4,1)
    }

    private val FOUR_PIXEL_DETAILER = 0.88f
    private val TWO_PIXEL_DETAILER = 0.92f

    private fun tavDeriveEncoderQindex(qIndex: Int, qYGlobal: Int): Int {
        if (qIndex > 0) return qIndex - 1
        return if (qYGlobal >= 79) 0
        else if (qYGlobal >= 47) 1
        else if (qYGlobal >= 23) 2
        else if (qYGlobal >= 11) 3
        else if (qYGlobal >= 5) 4
        else if (qYGlobal >= 2) 5
        else 6
    }

    // level is one-based index
    private fun getPerceptualWeight(qIndex: Int, qYGlobal: Int, level0: Int, subbandType: Int, isChroma: Boolean, maxLevels: Int): Float {
        // Psychovisual model based on DWT coefficient statistics and Human Visual System sensitivity

        val level = 1.0f + ((level0 - 1.0f) / (maxLevels - 1.0f)) * 5.0f


        val qualityLevel = tavDeriveEncoderQindex(qIndex, qYGlobal)

        if (!isChroma) {
            // LUMA CHANNEL: Based on statistical analysis from real video content
            
            // LL subband - contains most image energy, preserve carefully
            if (subbandType == 0) return perceptual_model3_LL(level)
            
            // LH subband - horizontal details (human eyes more sensitive)
            val LH: Float = perceptual_model3_LH(level)
            if (subbandType == 1) return LH
            
            // HL subband - vertical details
            val HL: Float = perceptual_model3_HL(qualityLevel, LH)
            if (subbandType == 2) return HL * (if (level in 1.8f..2.2f) TWO_PIXEL_DETAILER else if (level in 2.8f..3.2f) FOUR_PIXEL_DETAILER else 1f)

            // HH subband - diagonal details
            else return perceptual_model3_HH(LH, HL, level) * (if (level in 1.8f..2.2f) TWO_PIXEL_DETAILER else if (level in 2.8f..3.2f) FOUR_PIXEL_DETAILER else 1f)
            
        } else {
            // CHROMA CHANNELS: Less critical for human perception, more aggressive quantisation
            val base = perceptual_model3_chroma_basecurve(qualityLevel, level - 1)

            if (subbandType == 0) { // LL chroma - still important but less than luma
                return 1.0f
            }
            else if (subbandType == 1) { // LH chroma - horizontal chroma details
                return base.coerceAtLeast(1.0f)
            }
            else if (subbandType == 2) { // HL chroma - vertical chroma details (even less critical)
                return (base * ANISOTROPY_MULT_CHROMA[qualityLevel]).coerceAtLeast(1.0f)
            }
            else { // HH chroma - diagonal chroma details (most aggressive)
                return (base * ANISOTROPY_MULT_CHROMA[qualityLevel] + ANISOTROPY_BIAS_CHROMA[qualityLevel]).coerceAtLeast(1.0f)
            }
        }
    }


    // Helper function to calculate five-number summary for coefficient analysis
    private fun calculateFiveNumberSummary(values: List<Int>): String {
        if (values.isEmpty()) return "empty"
        val sorted = values.sorted()
        val n = sorted.size

        val min = sorted[0]
        val max = sorted[n - 1]
        val median = if (n % 2 == 1) sorted[n / 2] else (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
        val q1 = if (n >= 4) sorted[n / 4] else sorted[0]
        val q3 = if (n >= 4) sorted[3 * n / 4] else sorted[n - 1]

        return "min=$min, Q1=$q1, med=%.1f, Q3=$q3, max=$max, n=$n".format(median)
    }

    private fun dequantiseDWTSubbandsPerceptual(qIndex: Int, qYGlobal: Int, quantised: ShortArray, dequantised: FloatArray,
                                               subbands: List<DWTSubbandInfo>, baseQuantiser: Float, isChroma: Boolean, decompLevels: Int) {

        // CRITICAL FIX: Encoder stores coefficients in LINEAR order, not subband-mapped order!
        // The subband layout calculation is only used for determining perceptual weights,
        // but coefficients are stored and read sequentially in memory.

        // Create weight map for linear coefficient array
        val weights = FloatArray(quantised.size) { 1.0f }

        // Calculate perceptual weight for each coefficient position based on its subband
        for (subband in subbands) {
            val weight = getPerceptualWeight(qIndex, qYGlobal, subband.level, subband.subbandType, isChroma, decompLevels)

            // Apply weight to all coefficients in this subband
            for (i in 0 until subband.coeffCount) {
                val idx = subband.coeffStart + i
                if (idx < weights.size) {
                    weights[idx] = weight
                }
            }
        }

        // Apply linear dequantisation with perceptual weights (matching encoder's linear storage)
        for (i in quantised.indices) {
            if (i < dequantised.size) {
                val effectiveQuantiser = baseQuantiser * weights[i]
                dequantised[i] = quantised[i] * effectiveQuantiser
            }
        }

        // Debug output for verification
        if (tavDebugCurrentFrameNumber == tavDebugFrameTarget) {
            val channelType = if (isChroma) "Chroma" else "Luma"
            var nonZeroCoeffs = 0
            val weightStats = weights.toList().sorted()
            val weightRange = if (weightStats.isNotEmpty())
                "weights: ${weightStats.first()}-${weightStats.last()}" else "no weights"

            for (coeff in quantised) {
                if (coeff != 0.toShort()) nonZeroCoeffs++
            }

            println("LINEAR PERCEPTUAL DEQUANT: $channelType - coeffs=${quantised.size}, nonzero=$nonZeroCoeffs, $weightRange")
        }
    }

    private val tavDebugFrameTarget = -1 // use negative number to disable the debug print
    private var tavDebugCurrentFrameNumber = 0

    // ==============================================================================
    // Grain Synthesis Functions (must match encoder implementation)
    // ==============================================================================

    // Stateless RNG for grain synthesis (matches C encoder implementation)
    private inline fun tavGrainSynthesisRNG(frame: UInt, band: UInt, x: UInt, y: UInt): UInt {
        val key = frame * 0x9e3779b9u xor band * 0x7f4a7c15u xor (y shl 16) xor x
        // rng_hash implementation
        var hash = key
        hash = hash xor (hash shr 16)
        hash = hash * 0x7feb352du
        hash = hash xor (hash shr 15)
        hash = hash * 0x846ca68bu
        hash = hash xor (hash shr 16)
        return hash
    }

    // Generate triangular noise from uint32 RNG (returns value in range [-1.0, 1.0])
    private inline fun tavGrainTriangularNoise(rngVal: UInt): Float {
        // Get two uniform random values in [0, 1]
        val u1 = (rngVal and 0xFFFFu).toFloat() / 65535.0f
        val u2 = ((rngVal shr 16) and 0xFFFFu).toFloat() / 65535.0f

        // Convert to range [-1, 1] and average for triangular distribution
        return (u1 + u2) - 1.0f
    }

    // Remove grain synthesis from DWT coefficients (decoder subtracts noise)
    // This must be called AFTER dequantization but BEFORE inverse DWT
    private fun removeGrainSynthesisDecoder(coeffs: FloatArray, width: Int, height: Int,
                                           decompLevels: Int, frameNum: Int, quantiser: Float,
                                           subbands: List<DWTSubbandInfo>, qIndex: Int = 3, qYGlobal: Int = 0,
                                           usePerceptualWeights: Boolean = false) {
        // Only apply to Y channel, excluding LL band
        // Noise amplitude = half of quantization step (scaled by perceptual weight if enabled)

        // Process each subband (skip LL which is level 0)
        for (subband in subbands) {
            if (subband.level == 0) continue // Skip LL band

            // Calculate perceptual weight for this subband if perceptual mode is enabled
            /*val perceptualWeight = if (usePerceptualWeights) {
                getPerceptualWeight(qIndex, qYGlobal, subband.level, subband.subbandType, false, decompLevels)
            } else {
                1.0f
            }

            // Noise amplitude for this subband
            val noiseAmplitude = (quantiser * perceptualWeight) * 0.5f*/
            val noiseAmplitude = quantiser.coerceAtMost(32f) * 0.5f

            // Remove noise from each coefficient in this subband
            for (i in 0 until subband.coeffCount) {
                val idx = subband.coeffStart + i
                if (idx < coeffs.size) {
                    // Calculate 2D position from linear index
                    val y = idx / width
                    val x = idx % width

                    // Generate same deterministic noise as encoder
                    val rngVal = tavGrainSynthesisRNG(frameNum.toUInt(), (subband.level + subband.subbandType * 31 + 16777619).toUInt(), x.toUInt(), y.toUInt())
                    val noise = tavGrainTriangularNoise(rngVal)

                    // Subtract noise from coefficient
                    coeffs[idx] -= noise * noiseAmplitude
                }
            }
        }
    }

    private val TAV_QLUT = intArrayOf(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,100,102,104,106,108,110,112,114,116,118,120,122,124,126,128,132,136,140,144,148,152,156,160,164,168,172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,264,272,280,288,296,304,312,320,328,336,344,352,360,368,376,384,392,400,408,416,424,432,440,448,456,464,472,480,488,496,504,512,528,544,560,576,592,608,624,640,656,672,688,704,720,736,752,768,784,800,816,832,848,864,880,896,912,928,944,960,976,992,1008,1024,1056,1088,1120,1152,1184,1216,1248,1280,1312,1344,1376,1408,1440,1472,1504,1536,1568,1600,1632,1664,1696,1728,1760,1792,1824,1856,1888,1920,1952,1984,2016,2048,2112,2176,2240,2304,2368,2432,2496,2560,2624,2688,2752,2816,2880,2944,3008,3072,3136,3200,3264,3328,3392,3456,3520,3584,3648,3712,3776,3840,3904,3968,4032,4096)

    // New tavDecode function that accepts compressed data and decompresses internally
    fun tavDecodeCompressed(compressedDataPtr: Long, compressedSize: Int, currentRGBAddr: Long, prevRGBAddr: Long,
                            width: Int, height: Int, qIndex: Int, qYGlobal: Int, qCoGlobal: Int, qCgGlobal: Int, channelLayout: Int,
                            frameCount: Int, waveletFilter: Int = 1, decompLevels: Int = 6, isLossless: Boolean = false, tavVersion: Int = 1): HashMap<String, Any> {

        // Read compressed data from VM memory into byte array
        val compressedData = ByteArray(compressedSize)
        for (i in 0 until compressedSize) {
            compressedData[i] = vm.peek(compressedDataPtr + i)!!.toByte()
        }

        return try {
            // Decompress using Zstd
            val bais = ByteArrayInputStream(compressedData)
            val zis = ZstdInputStream(bais)
            val decompressedData = zis.readBytes()
            zis.close()
            bais.close()

            // Allocate buffer for decompressed data
            val decompressedBuffer = vm.malloc(decompressedData.size)

            try {
                // Copy decompressed data to unsafe buffer
                UnsafeHelper.memcpyRaw(
                    decompressedData, UnsafeHelper.getArrayOffset(decompressedData),
                    null, vm.usermem.ptr + decompressedBuffer.toLong(),
                    decompressedData.size.toLong()
                )

                // Call the existing tavDecode function with decompressed data
                tavDecode(decompressedBuffer.toLong(), currentRGBAddr, prevRGBAddr,
                    width, height, qIndex, qYGlobal, qCoGlobal, qCgGlobal, channelLayout,
                    frameCount, waveletFilter, decompLevels, isLossless, tavVersion)

            } finally {
                // Clean up allocated buffer
                vm.free(decompressedBuffer)
            }

        } catch (e: Exception) {
            println("TAV Zstd decompression error: ${e.message}")
            throw e
        }
    }

    // Original tavDecode function for backward compatibility (now handles decompressed data)
    fun tavDecode(blockDataPtr: Long, currentRGBAddr: Long, prevRGBAddr: Long,
                  width: Int, height: Int, qIndex: Int, qYGlobal: Int, qCoGlobal: Int, qCgGlobal: Int, channelLayout: Int,
                  frameCount: Int, waveletFilter: Int = 1, decompLevels: Int = 6, isLossless: Boolean = false, tavVersion: Int = 1): HashMap<String, Any> {

        val dbgOut = HashMap<String, Any>()

        tavDebugCurrentFrameNumber = frameCount

        var readPtr = blockDataPtr

        try {
            // Determine if monoblock mode based on TAV version
            val isMonoblock = (tavVersion in 3..6)

            val tilesX: Int
            val tilesY: Int

            if (isMonoblock) {
                // Monoblock mode: single tile covering entire frame
                tilesX = 1
                tilesY = 1
            } else {
                // Standard mode: multiple 720x720 tiles
                tilesX = (width + TAV_TILE_SIZE_X - 1) / TAV_TILE_SIZE_X
                tilesY = (height + TAV_TILE_SIZE_Y - 1) / TAV_TILE_SIZE_Y
            }
            
            // Process each tile
            for (tileY in 0 until tilesY) {
                for (tileX in 0 until tilesX) {
                    
                    // Read tile header (4 bytes: mode + qY + qCo + qCg)
                    val mode = vm.peek(readPtr++).toUint()
                    val qY = vm.peek(readPtr++).toUint().let { if (it == 0) qYGlobal else TAV_QLUT[it - 1] }
                    val qCo = vm.peek(readPtr++).toUint().let { if (it == 0) qCoGlobal else TAV_QLUT[it - 1] }
                    val qCg = vm.peek(readPtr++).toUint().let { if (it == 0) qCgGlobal else TAV_QLUT[it - 1] }

                    dbgOut["qY"] = qY
                    dbgOut["qCo"] = qCo
                    dbgOut["qCg"] = qCg
                    dbgOut["frameMode"] = ""

                    // debug print: raw decompressed bytes
                    /*print("TAV Decode raw bytes (Frame $frameCount, mode: ${arrayOf("SKIP", "INTRA", "DELTA")[mode]}): ")
                    for (i in 0 until 32) {
                        print("${vm.peek(blockDataPtr + i).toUint().toString(16).uppercase().padStart(2, '0')} ")
                    }
                    println("...")*/

                    when (mode) {
                        0x00 -> { // TAV_MODE_SKIP
                            // Copy 280x224 tile from previous frame to current frame
                            tavCopyTileRGB(tileX, tileY, currentRGBAddr, prevRGBAddr, width, height)
                            dbgOut["frameMode"] = "S"
                        }
                        0x01 -> { // TAV_MODE_INTRA
                            // Decode DWT coefficients directly to RGB buffer
                            readPtr = tavDecodeDWTIntraTileRGB(qIndex, qYGlobal, channelLayout, readPtr, tileX, tileY, currentRGBAddr,
                                                          width, height, qY, qCo, qCg,
                                                          waveletFilter, decompLevels, isLossless, tavVersion, isMonoblock, frameCount)
                            dbgOut["frameMode"] = " "
                        }
                        0x02 -> { // TAV_MODE_DELTA
                            // Coefficient delta encoding for efficient P-frames
                            readPtr = tavDecodeDeltaTileRGB(readPtr, channelLayout, tileX, tileY, currentRGBAddr,
                                                      width, height, qY, qCo, qCg,
                                                      waveletFilter, decompLevels, isLossless, tavVersion, isMonoblock, frameCount)
                            dbgOut["frameMode"] = " "
                        }
                    }
                }
            }

        } catch (e: Exception) {
            println("TAV decode error: ${e.message}")
        }

        return dbgOut
    }

    private fun tavDecodeDWTIntraTileRGB(qIndex: Int, qYGlobal: Int, channelLayout: Int, readPtr: Long, tileX: Int, tileY: Int, currentRGBAddr: Long,
                                         width: Int, height: Int, qY: Int, qCo: Int, qCg: Int,
                                         waveletFilter: Int, decompLevels: Int, isLossless: Boolean, tavVersion: Int, isMonoblock: Boolean = false, frameCount: Int): Long {
        // Determine coefficient count based on mode
        val coeffCount = if (isMonoblock) {
            // Monoblock mode: entire frame
            width * height
        } else {
            // Standard mode: padded tiles (344x288)
            TAV_PADDED_TILE_SIZE_X * TAV_PADDED_TILE_SIZE_Y
        }

        var ptr = readPtr

        // Read quantised DWT coefficients for Y, Co, Cg, and Alpha channels
        val quantisedY = ShortArray(coeffCount)
        val quantisedCo = ShortArray(coeffCount)
        val quantisedCg = ShortArray(coeffCount)
        val quantisedAlpha = ShortArray(coeffCount)

        // First, we need to determine the size of compressed data for each channel
        // Read a large buffer to work with significance map format
        val maxPossibleSize = coeffCount * 3 * 2 + (coeffCount + 7) / 8 * 3  // Worst case: original size + maps
        val coeffBuffer = ByteArray(maxPossibleSize)
        UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + ptr, coeffBuffer, UnsafeHelper.getArrayOffset(coeffBuffer), maxPossibleSize.toLong())

        // Calculate significance map size
        val mapBytes = (coeffCount + 7) / 8

        // Find sizes of each channel's compressed data by counting non-zeros in significance maps
        fun countNonZerosInMap(offset: Int): Int {
            var count = 0
            for (i in 0 until mapBytes) {
                val byte = coeffBuffer[offset + i].toInt() and 0xFF
                for (bit in 0 until 8) {
                    if (i * 8 + bit < coeffCount && (byte and (1 shl bit)) != 0) {
                        count++
                    }
                }
            }
            return count
        }

        // Helper function for concatenated maps format
        fun countNonZerosInMapConcatenated(mapOffset: Int, mapSize: Int): Int {
            var count = 0
            for (i in 0 until mapSize) {
                val byte = coeffBuffer[mapOffset + i].toInt() and 0xFF
                for (bit in 0 until 8) {
                    if (i * 8 + bit < coeffCount && (byte and (1 shl bit)) != 0) {
                        count++
                    }
                }
            }
            return count
        }

        // Use variable channel layout concatenated maps format
        postprocessCoefficientsVariableLayout(coeffBuffer, 0, coeffCount, channelLayout, quantisedY, quantisedCo, quantisedCg, quantisedAlpha)

        // Calculate total size for variable channel layout format
        val numChannels = when (channelLayout) {
            CHANNEL_LAYOUT_YCOCG -> 3    // Y-Co-Cg
            CHANNEL_LAYOUT_YCOCG_A -> 4  // Y-Co-Cg-A
            CHANNEL_LAYOUT_Y_ONLY -> 1   // Y only
            CHANNEL_LAYOUT_Y_A -> 2      // Y-A
            CHANNEL_LAYOUT_COCG -> 2     // Co-Cg
            CHANNEL_LAYOUT_COCG_A -> 3   // Co-Cg-A
            else -> 3  // fallback to Y-Co-Cg
        }

        val totalMapSize = mapBytes * numChannels
        var totalNonZeros = 0
        for (ch in 0 until numChannels) {
            totalNonZeros += countNonZerosInMapConcatenated(mapBytes * ch, mapBytes)
        }
        val totalValueSize = totalNonZeros * 2

        ptr += (totalMapSize + totalValueSize)
        
        // Dequantise coefficient data
        val yTile = FloatArray(coeffCount)
        val coTile = FloatArray(coeffCount)
        val cgTile = FloatArray(coeffCount)

        // Check if perceptual quantisation is used (versions 5 and 6)
        val isPerceptual = (tavVersion in 5..8)

        // Debug: Print version detection for frame 120
        if (tavDebugCurrentFrameNumber == tavDebugFrameTarget) {
            println("[VERSION-DEBUG-INTRA] Frame $tavDebugCurrentFrameNumber - TAV version: $tavVersion, isPerceptual: $isPerceptual")
        }

        if (isPerceptual) {
            // Perceptual dequantisation with subband-specific weights
            val tileWidth = if (isMonoblock) width else TAV_PADDED_TILE_SIZE_X
            val tileHeight = if (isMonoblock) height else TAV_PADDED_TILE_SIZE_Y
            val subbands = calculateSubbandLayout(tileWidth, tileHeight, decompLevels)

            dequantiseDWTSubbandsPerceptual(qIndex, qYGlobal, quantisedY, yTile, subbands, qY.toFloat(), false, decompLevels)
            dequantiseDWTSubbandsPerceptual(qIndex, qYGlobal, quantisedCo, coTile, subbands, qCo.toFloat(), true, decompLevels)
            dequantiseDWTSubbandsPerceptual(qIndex, qYGlobal, quantisedCg, cgTile, subbands, qCg.toFloat(), true, decompLevels)

            // Remove grain synthesis from Y channel (must happen after dequantization, before inverse DWT)
            // Use perceptual weights since this is the perceptual quantization path
            removeGrainSynthesisDecoder(yTile, tileWidth, tileHeight, decompLevels, frameCount, qY.toFloat(), subbands, qIndex, qYGlobal, true)

            // Apply film grain filter if enabled
            // commented; grain synthesis is now a part of the spec
            /*if (filmGrainLevel > 0) {
                val random = java.util.Random()
                for (i in 0 until coeffCount) {
                    yTile[i] += (random.nextInt(filmGrainLevel * 2 + 1) - filmGrainLevel).toFloat()
//                    coTile[i] += (random.nextInt(filmGrainLevel * 2 + 1) - filmGrainLevel).toFloat()
//                    cgTile[i] += (random.nextInt(filmGrainLevel * 2 + 1) - filmGrainLevel).toFloat()
                }
            }*/

            // Debug: Check coefficient values before inverse DWT
            if (tavDebugCurrentFrameNumber == tavDebugFrameTarget) {
                var maxYDequant = 0.0f
                var nonzeroY = 0
                for (coeff in yTile) {
                    if (coeff != 0.0f) {
                        nonzeroY++
                        if (kotlin.math.abs(coeff) > maxYDequant) {
                            maxYDequant = kotlin.math.abs(coeff)
                        }
                    }
                }
                println("[DECODER-INTRA] Frame $tavDebugCurrentFrameNumber - Before IDWT: Y max=${maxYDequant.toInt()}, nonzero=$nonzeroY")

                // Debug: Check if subband layout is correct - print actual coefficient positions
                println("PERCEPTUAL SUBBAND LAYOUT DEBUG:")
                println("  Total coeffs: ${yTile.size}, Decomp levels: $decompLevels, Tile size: ${tileWidth}x${tileHeight}")
                for (subband in subbands) {
                    if (subband.level <= 6) { // LH, HL, HH for levels 1-2
                        var sampleCoeffs = 0
                        val coeffCount = minOf(1000, subband.coeffCount)
                        for (i in 0 until coeffCount) { // Sample first 100 coeffs
                            val idx = subband.coeffStart + i
                            if (idx < yTile.size && yTile[idx] != 0.0f) {
                                sampleCoeffs++
                            }
                        }
                        val subbandName = when(subband.subbandType) {
                            0 -> "LL${subband.level}"
                            1 -> "LH${subband.level}"
                            2 -> "HL${subband.level}"
                            3 -> "HH${subband.level}"
                            else -> "??${subband.level}"
                        }
                        println("  $subbandName: start=${subband.coeffStart}, count=${subband.coeffCount}, sample_nonzero=$sampleCoeffs/$coeffCount")

                        // Debug: Print first few RAW QUANTISED values for comparison (before dequantisation)
                        print("    $subbandName raw_quant: ")
                        for (i in 0 until minOf(32, subband.coeffCount)) {
                            val idx = subband.coeffStart + i
                            if (idx < quantisedY.size) {
                                print("${quantisedY[idx]} ")
                            }
                        }
                        println()
                    }
                }
            }
        } else {
            // Uniform dequantisation for versions 3 and 4
            for (i in 0 until coeffCount) {
                yTile[i] = quantisedY[i] * qY.toFloat()
                coTile[i] = quantisedCo[i] * qCo.toFloat()
                cgTile[i] = quantisedCg[i] * qCg.toFloat()
            }

            // Remove grain synthesis from Y channel (must happen after dequantization, before inverse DWT)
            val tileWidth = if (isMonoblock) width else TAV_PADDED_TILE_SIZE_X
            val tileHeight = if (isMonoblock) height else TAV_PADDED_TILE_SIZE_Y
            val subbands = calculateSubbandLayout(tileWidth, tileHeight, decompLevels)
            removeGrainSynthesisDecoder(yTile, tileWidth, tileHeight, decompLevels, frameCount, qY.toFloat(), subbands)

            // Apply film grain filter if enabled
            // commented; grain synthesis is now a part of the spec
            /*if (filmGrainLevel > 0) {
                val random = java.util.Random()
                for (i in 0 until coeffCount) {
                    yTile[i] += (random.nextInt(filmGrainLevel * 2 + 1) - filmGrainLevel).toFloat()
//                    coTile[i] += (random.nextInt(filmGrainLevel * 2 + 1) - filmGrainLevel).toFloat()
//                    cgTile[i] += (random.nextInt(filmGrainLevel * 2 + 1) - filmGrainLevel).toFloat()
                }
            }*/

            // Debug: Uniform quantisation subband analysis for comparison
            if (tavDebugCurrentFrameNumber == tavDebugFrameTarget) {
                val tileWidth = if (isMonoblock) width else TAV_PADDED_TILE_SIZE_X
                val tileHeight = if (isMonoblock) height else TAV_PADDED_TILE_SIZE_Y
                val subbands = calculateSubbandLayout(tileWidth, tileHeight, decompLevels)

                // Comprehensive five-number summary for uniform quantisation baseline
                for (subband in subbands) {
                    // Collect all quantised coefficient values for this subband (luma only for baseline)
                    val coeffValues = mutableListOf<Int>()
                    for (i in 0 until subband.coeffCount) {
                        val idx = subband.coeffStart + i
                        if (idx < quantisedY.size) {
                            val quantVal = quantisedY[idx].toInt()
                            coeffValues.add(quantVal)
                        }
                    }

                    // Calculate and print five-number summary for uniform mode
                    val subbandTypeName = when (subband.subbandType) {
                        0 -> "LL"
                        1 -> "LH"
                        2 -> "HL"
                        3 -> "HH"
                        else -> "??"
                    }
                    val summary = calculateFiveNumberSummary(coeffValues)
                    println("UNIFORM SUBBAND STATS: Luma ${subbandTypeName}${subband.level} uniformQ=${qY.toFloat()} - $summary")
                }
                var maxYDequant = 0.0f
                var nonzeroY = 0
                for (coeff in yTile) {
                    if (coeff != 0.0f) {
                        nonzeroY++
                        if (kotlin.math.abs(coeff) > maxYDequant) {
                            maxYDequant = kotlin.math.abs(coeff)
                        }
                    }
                }
                println("[DECODER-INTRA] Frame $tavDebugCurrentFrameNumber - Before IDWT: Y max=${maxYDequant.toInt()}, nonzero=$nonzeroY")

                // Debug: Check if subband layout is correct for uniform too - print actual coefficient positions
                println("UNIFORM SUBBAND LAYOUT DEBUG:")
                println("  Total coeffs: ${yTile.size}, Decomp levels: $decompLevels, Tile size: ${tileWidth}x${tileHeight}")
                for (subband in subbands) {
                    if (subband.level <= 6) { // LH, HL, HH for levels 1-2
                        var sampleCoeffs = 0
                        val coeffCount = minOf(1000, subband.coeffCount)
                        for (i in 0 until coeffCount) { // Sample first 100 coeffs
                            val idx = subband.coeffStart + i
                            if (idx < yTile.size && yTile[idx] != 0.0f) {
                                sampleCoeffs++
                            }
                        }
                        val subbandName = when(subband.subbandType) {
                            0 -> "LL${subband.level}"
                            1 -> "LH${subband.level}"
                            2 -> "HL${subband.level}"
                            3 -> "HH${subband.level}"
                            else -> "??${subband.level}"
                        }
                        println("  $subbandName: start=${subband.coeffStart}, count=${subband.coeffCount}, sample_nonzero=$sampleCoeffs/$coeffCount")

                        // Debug: Print first few RAW QUANTISED values for comparison with perceptual (before dequantisation)
                        print("    $subbandName raw_quant: ")
                        for (i in 0 until minOf(32, subband.coeffCount)) {
                            val idx = subband.coeffStart + i
                            if (idx < quantisedY.size) {
                                print("${quantisedY[idx]} ")
                            }
                        }
                        println()
                    }
                }
            }
        }
        
        // Store coefficients for future delta reference (for P-frames)
        val tileIdx = if (isMonoblock) {
            0  // Single tile index for monoblock
        } else {
            tileY * ((width + TAV_TILE_SIZE_X - 1) / TAV_TILE_SIZE_X) + tileX
        }

        if (tavPreviousCoeffsY == null) {
            tavPreviousCoeffsY = mutableMapOf()
            tavPreviousCoeffsCo = mutableMapOf()
            tavPreviousCoeffsCg = mutableMapOf()
        }
        tavPreviousCoeffsY!![tileIdx] = yTile.clone()
        tavPreviousCoeffsCo!![tileIdx] = coTile.clone()
        tavPreviousCoeffsCg!![tileIdx] = cgTile.clone()
        
        // Apply inverse DWT
        val tileWidth = if (isMonoblock) width else TAV_PADDED_TILE_SIZE_X
        val tileHeight = if (isMonoblock) height else TAV_PADDED_TILE_SIZE_Y

        if (isLossless) {
            tavApplyDWTInverseMultiLevel(yTile, tileWidth, tileHeight, decompLevels, 0, TavSharpenLuma)
            tavApplyDWTInverseMultiLevel(coTile, tileWidth, tileHeight, decompLevels, 0, TavNullFilter)
            tavApplyDWTInverseMultiLevel(cgTile, tileWidth, tileHeight, decompLevels, 0, TavNullFilter)
        } else {
            tavApplyDWTInverseMultiLevel(yTile, tileWidth, tileHeight, decompLevels, waveletFilter, TavSharpenLuma)
            tavApplyDWTInverseMultiLevel(coTile, tileWidth, tileHeight, decompLevels, waveletFilter, TavNullFilter)
            tavApplyDWTInverseMultiLevel(cgTile, tileWidth, tileHeight, decompLevels, waveletFilter, TavNullFilter)
        }

        // Debug: Check coefficient values after inverse DWT
        if (tavDebugCurrentFrameNumber == tavDebugFrameTarget) {
            var maxYIdwt = 0.0f
            var minYIdwt = 0.0f
            var maxCoIdwt = 0.0f
            var minCoIdwt = 0.0f
            var maxCgIdwt = 0.0f
            var minCgIdwt = 0.0f
            for (coeff in yTile) {
                if (coeff > maxYIdwt) maxYIdwt = coeff
                if (coeff < minYIdwt) minYIdwt = coeff
            }
            for (coeff in coTile) {
                if (coeff > maxCoIdwt) maxCoIdwt = coeff
                if (coeff < minCoIdwt) minCoIdwt = coeff
            }
            for (coeff in cgTile) {
                if (coeff > maxCgIdwt) maxCgIdwt = coeff
                if (coeff < minCgIdwt) minCgIdwt = coeff
            }
            println("[DECODER-INTRA] Frame $tavDebugCurrentFrameNumber - After IDWT: Y=[${minYIdwt.toInt()}, ${maxYIdwt.toInt()}], Co=[${minCoIdwt.toInt()}, ${maxCoIdwt.toInt()}], Cg=[${minCgIdwt.toInt()}, ${maxCgIdwt.toInt()}]")
        }
        
        // Extract final tile data
        val finalYTile: FloatArray
        val finalCoTile: FloatArray
        val finalCgTile: FloatArray
        val finalAlphaTile: FloatArray

        if (isMonoblock) {
            // Monoblock mode: use full frame data directly (no padding to extract)
            finalYTile = yTile
            finalCoTile = coTile
            finalCgTile = cgTile
        } else {
            // Standard mode: extract core 280x224 pixels from reconstructed padded tiles (344x288)
            finalYTile = FloatArray(TAV_TILE_SIZE_X * TAV_TILE_SIZE_Y)
            finalCoTile = FloatArray(TAV_TILE_SIZE_X * TAV_TILE_SIZE_Y)
            finalCgTile = FloatArray(TAV_TILE_SIZE_X * TAV_TILE_SIZE_Y)

            for (y in 0 until TAV_TILE_SIZE_Y) {
                for (x in 0 until TAV_TILE_SIZE_X) {
                    val coreIdx = y * TAV_TILE_SIZE_X + x
                    val paddedIdx = (y + TAV_TILE_MARGIN) * TAV_PADDED_TILE_SIZE_X + (x + TAV_TILE_MARGIN)

                    finalYTile[coreIdx] = yTile[paddedIdx]
                    finalCoTile[coreIdx] = coTile[paddedIdx]
                    finalCgTile[coreIdx] = cgTile[paddedIdx]
                }
            }
        }

        // write Y=127 if there's no luma channel
        if (channelLayout == CHANNEL_LAYOUT_COCG || channelLayout == CHANNEL_LAYOUT_COCG_A) {
            Arrays.fill(finalYTile, 127f)
        }
        
        // Convert to RGB based on TAV version and mode
        if (tavVersion % 2 == 0) {
            // ICtCp color space
            if (isMonoblock) {
                tavConvertICtCpMonoblockToRGB(finalYTile, finalCoTile, finalCgTile, currentRGBAddr, width, height)
            } else {
                tavConvertICtCpTileToRGB(tileX, tileY, finalYTile, finalCoTile, finalCgTile, currentRGBAddr, width, height)
            }
        } else {
            // YCoCg-R color space (v1, v3)
            if (isMonoblock) {
                tavConvertYCoCgMonoblockToRGB(finalYTile, finalCoTile, finalCgTile, currentRGBAddr, width, height)
            } else {
                tavConvertYCoCgTileToRGB(tileX, tileY, finalYTile, finalCoTile, finalCgTile, currentRGBAddr, width, height)
            }
        }
        
        return ptr
    }

    private fun tavConvertYCoCgTileToRGB(tileX: Int, tileY: Int, yTile: FloatArray, coTile: FloatArray, cgTile: FloatArray,
                                         rgbAddr: Long, width: Int, height: Int) {
        val startX = tileX * TAV_TILE_SIZE_X
        val startY = tileY * TAV_TILE_SIZE_Y
        
        // OPTIMISATION: Process pixels row by row with bulk copying for better cache locality
        for (y in 0 until TAV_TILE_SIZE_Y) {
            val frameY = startY + y
            if (frameY >= height) break
            
            // Calculate valid pixel range for this row
            val validStartX = maxOf(0, startX)
            val validEndX = minOf(width, startX + TAV_TILE_SIZE_X)
            val validPixelsInRow = validEndX - validStartX
            
            if (validPixelsInRow > 0) {
                // Create row buffer for bulk RGB data
                val rowRgbBuffer = ByteArray(validPixelsInRow * 3)
                var bufferIdx = 0
                
                for (x in validStartX until validEndX) {
                    val tileIdx = y * TAV_TILE_SIZE_X + (x - startX)
                    
                    // YCoCg-R to RGB conversion (exact inverse of encoder)
                    val Y = yTile[tileIdx]
                    val Co = coTile[tileIdx] 
                    val Cg = cgTile[tileIdx]
                    
                    // Inverse of encoder's YCoCg-R transform:
                    val tmp = Y - Cg / 2.0f
                    val g = Cg + tmp
                    val b = tmp - Co / 2.0f
                    val r = Co + b
                    
                    rowRgbBuffer[bufferIdx++] = r.toInt().coerceIn(0, 255).toByte()
                    rowRgbBuffer[bufferIdx++] = g.toInt().coerceIn(0, 255).toByte()
                    rowRgbBuffer[bufferIdx++] = b.toInt().coerceIn(0, 255).toByte()
                }
                
                // OPTIMISATION: Bulk copy entire row at once
                val rowStartOffset = (frameY * width + validStartX) * 3L
                UnsafeHelper.memcpyRaw(rowRgbBuffer, UnsafeHelper.getArrayOffset(rowRgbBuffer), 
                                     null, vm.usermem.ptr + rgbAddr + rowStartOffset, rowRgbBuffer.size.toLong())
            }
        }
    }

    private fun tavConvertICtCpTileToRGB(tileX: Int, tileY: Int, iTile: FloatArray, ctTile: FloatArray, cpTile: FloatArray,
                                         rgbAddr: Long, width: Int, height: Int) {
        val startX = tileX * TAV_TILE_SIZE_X
        val startY = tileY * TAV_TILE_SIZE_Y

        // OPTIMISATION: Process pixels row by row with bulk copying for better cache locality
        for (y in 0 until TAV_TILE_SIZE_Y) {
            val frameY = startY + y
            if (frameY >= height) break

            // Calculate valid pixel range for this row
            val validStartX = maxOf(0, startX)
            val validEndX = minOf(width, startX + TAV_TILE_SIZE_X)
            val validPixelsInRow = validEndX - validStartX

            if (validPixelsInRow > 0) {
                // Create row buffer for bulk RGB data
                val rowRgbBuffer = ByteArray(validPixelsInRow * 3)
                var bufferIdx = 0

                for (x in validStartX until validEndX) {
                    val tileIdx = y * TAV_TILE_SIZE_X + (x - startX)

                    // ICtCp to RGB conversion via LUT
                    // Convert float values to LUT indices (values already in [0,255] from IDWT)
                    val iIdx = iTile[tileIdx].toInt().coerceIn(0, 255)
                    val ctIdx = ctTile[tileIdx].toInt().coerceIn(0, 255)
                    val cpIdx = cpTile[tileIdx].toInt().coerceIn(0, 255)

                    // Direct LUT lookup (no bounds checking with UnsafePtr)
                    val lutIndex = (iIdx.toLong() * 256L * 256L * 3L) + (ctIdx.toLong() * 256L * 3L) + (cpIdx.toLong() * 3L)
                    rowRgbBuffer[bufferIdx++] = ictcpLUT!!.get(lutIndex + 0)
                    rowRgbBuffer[bufferIdx++] = ictcpLUT!!.get(lutIndex + 1)
                    rowRgbBuffer[bufferIdx++] = ictcpLUT!!.get(lutIndex + 2)
                }

                // OPTIMISATION: Bulk copy entire row at once
                val rowStartOffset = (frameY * width + validStartX) * 3L
                UnsafeHelper.memcpyRaw(rowRgbBuffer, UnsafeHelper.getArrayOffset(rowRgbBuffer),
                                     null, vm.usermem.ptr + rgbAddr + rowStartOffset, rowRgbBuffer.size.toLong())
            }
        }
    }

    // Monoblock conversion functions (full frame processing)
    private fun tavConvertYCoCgMonoblockToRGB(yData: FloatArray, coData: FloatArray, cgData: FloatArray,
                                              rgbAddr: Long, width: Int, height: Int) {
        // Debug: Check if this is frame 120 for final RGB comparison
        val isFrame120Debug = tavDebugCurrentFrameNumber == tavDebugFrameTarget  // Enable for debugging
        var debugSampleCount = 0
        var debugRSum = 0
        var debugGSum = 0
        var debugBSum = 0
        var debugYSum = 0.0f
        var debugCoSum = 0.0f
        var debugCgSum = 0.0f

        // Process entire frame at once for monoblock mode
        for (y in 0 until height) {
            // Create row buffer for bulk RGB data
            val rowRgbBuffer = ByteArray(width * 3)
            var bufferIdx = 0

            for (x in 0 until width) {
                val idx = y * width + x

                // YCoCg-R to RGB conversion (exact inverse of encoder)
                val Y = yData[idx]
                val Co = coData[idx]
                val Cg = cgData[idx]

                // Inverse of encoder's YCoCg-R transform:
                val tmp = Y - Cg / 2.0f
                val g = Cg + tmp
                val b = tmp - Co / 2.0f
                val r = Co + b

                val rInt = r.toInt().coerceIn(0, 255)
                val gInt = g.toInt().coerceIn(0, 255)
                val bInt = b.toInt().coerceIn(0, 255)

                rowRgbBuffer[bufferIdx++] = rInt.toByte()
                rowRgbBuffer[bufferIdx++] = gInt.toByte()
                rowRgbBuffer[bufferIdx++] = bInt.toByte()

                // Debug: Sample RGB values for frame 120 comparison
                if (isFrame120Debug && y in 100..199 && x in 100..199) { // Sample 100x100 region
                    debugSampleCount++
                    debugRSum += rInt
                    debugGSum += gInt
                    debugBSum += bInt
                    debugYSum += Y
                    debugCoSum += Co
                    debugCgSum += Cg
                }
            }

            // OPTIMISATION: Bulk copy entire row at once
            val rowStartOffset = y * width * 3L
            UnsafeHelper.memcpyRaw(rowRgbBuffer, UnsafeHelper.getArrayOffset(rowRgbBuffer),
                                 null, vm.usermem.ptr + rgbAddr + rowStartOffset, rowRgbBuffer.size.toLong())
        }

        // Debug: Print RGB sample statistics for frame 120 comparison
        if (isFrame120Debug && debugSampleCount > 0) {
            val avgR = debugRSum / debugSampleCount
            val avgG = debugGSum / debugSampleCount
            val avgB = debugBSum / debugSampleCount
            val avgY = debugYSum / debugSampleCount
            val avgCo = debugCoSum / debugSampleCount
            val avgCg = debugCgSum / debugSampleCount
            println("[RGB-FINAL] Sample region (100x100): avgYCoCg=[${avgY.toInt()},${avgCo.toInt()},${avgCg.toInt()}] → avgRGB=[$avgR,$avgG,$avgB], samples=$debugSampleCount")
        }
    }

    private fun tavConvertICtCpMonoblockToRGB(iData: FloatArray, ctData: FloatArray, cpData: FloatArray,
                                              rgbAddr: Long, width: Int, height: Int) {
        // Process entire frame at once for monoblock mode
        for (y in 0 until height) {
            // Create row buffer for bulk RGB data
            val rowRgbBuffer = ByteArray(width * 3)
            var bufferIdx = 0

            for (x in 0 until width) {
                val idx = y * width + x

                // ICtCp to RGB conversion via LUT
                // Convert float values to LUT indices (values already in [0,255] from IDWT)
                val iIdx = iData[idx].toInt().coerceIn(0, 255)
                val ctIdx = ctData[idx].toInt().coerceIn(0, 255)
                val cpIdx = cpData[idx].toInt().coerceIn(0, 255)

                // Direct LUT lookup (no bounds checking with UnsafePtr)
                val lutIndex = (iIdx.toLong() * 256L * 256L * 3L) + (ctIdx.toLong() * 256L * 3L) + (cpIdx.toLong() * 3L)
                rowRgbBuffer[bufferIdx++] = ictcpLUT!!.get(lutIndex + 0)
                rowRgbBuffer[bufferIdx++] = ictcpLUT!!.get(lutIndex + 1)
                rowRgbBuffer[bufferIdx++] = ictcpLUT!!.get(lutIndex + 2)
            }

            // OPTIMISATION: Bulk copy entire row at once
            val rowStartOffset = y * width * 3L
            UnsafeHelper.memcpyRaw(rowRgbBuffer, UnsafeHelper.getArrayOffset(rowRgbBuffer),
                                 null, vm.usermem.ptr + rgbAddr + rowStartOffset, rowRgbBuffer.size.toLong())
        }
    }

    // Helper functions (simplified versions of existing DWT functions)
    private fun tavCopyTileRGB(tileX: Int, tileY: Int, currentRGBAddr: Long, prevRGBAddr: Long, width: Int, height: Int) {
        val startX = tileX * TAV_TILE_SIZE_X
        val startY = tileY * TAV_TILE_SIZE_Y
        
        // OPTIMISATION: Copy entire rows at once for maximum performance
        for (y in 0 until TAV_TILE_SIZE_Y) {
            val frameY = startY + y
            if (frameY >= height) break
            
            // Calculate valid pixel range for this row
            val validStartX = maxOf(0, startX)
            val validEndX = minOf(width, startX + TAV_TILE_SIZE_X)
            val validPixelsInRow = validEndX - validStartX
            
            if (validPixelsInRow > 0) {
                val rowStartOffset = (frameY * width + validStartX) * 3L
                val rowByteCount = validPixelsInRow * 3L
                
                // OPTIMISATION: Bulk copy entire row of RGB data in one operation
                UnsafeHelper.memcpy(
                    vm.usermem.ptr + prevRGBAddr + rowStartOffset,
                    vm.usermem.ptr + currentRGBAddr + rowStartOffset,
                    rowByteCount
                )
            }
        }
    }

    private fun getPerceptualModelChromaBase(qualityLevel: Int, level: Int): Float {
        // Simplified chroma base curve
        return 1.0f - (1.0f / (0.5f * qualityLevel * qualityLevel + 1.0f)) * (level - 4.0f)
    }

    private fun tavDecodeDeltaTileRGB(readPtr: Long, channelLayout: Int, tileX: Int, tileY: Int, currentRGBAddr: Long,
                                      width: Int, height: Int, qY: Int, qCo: Int, qCg: Int,
                                      waveletFilter: Int, decompLevels: Int, isLossless: Boolean, tavVersion: Int, isMonoblock: Boolean = false, frameCount: Int = 0): Long {
        
        val tileIdx = if (isMonoblock) {
            0  // Single tile index for monoblock
        } else {
            tileY * ((width + TAV_TILE_SIZE_X - 1) / TAV_TILE_SIZE_X) + tileX
        }
        var ptr = readPtr

        // Initialise coefficient storage if needed
        if (tavPreviousCoeffsY == null) {
            tavPreviousCoeffsY = mutableMapOf()
            tavPreviousCoeffsCo = mutableMapOf()
            tavPreviousCoeffsCg = mutableMapOf()
        }

        // Determine coefficient count based on mode
        val coeffCount = if (isMonoblock) {
            // Monoblock mode: entire frame
            width * height
        } else {
            // Standard mode: padded tiles (344x288)
            TAV_PADDED_TILE_SIZE_X * TAV_PADDED_TILE_SIZE_Y
        }
        
        // Read delta coefficients using significance map format (same as intra but with deltas)
        val deltaY = ShortArray(coeffCount)
        val deltaCo = ShortArray(coeffCount)
        val deltaCg = ShortArray(coeffCount)
        val deltaAlpha = ShortArray(coeffCount)

        // Read using significance map format for deltas too
        val maxPossibleSize = coeffCount * 3 * 2 + (coeffCount + 7) / 8 * 3  // Worst case
        val coeffBuffer = ByteArray(maxPossibleSize)
        UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + ptr, coeffBuffer, UnsafeHelper.getArrayOffset(coeffBuffer), maxPossibleSize.toLong())

        val mapBytes = (coeffCount + 7) / 8

        // Helper function for counting non-zeros (same as in intra)
        fun countNonZerosInMap(offset: Int): Int {
            var count = 0
            for (i in 0 until mapBytes) {
                val byte = coeffBuffer[offset + i].toInt() and 0xFF
                for (bit in 0 until 8) {
                    if (i * 8 + bit < coeffCount && (byte and (1 shl bit)) != 0) {
                        count++
                    }
                }
            }
            return count
        }

        // Helper function for concatenated maps format
        fun countNonZerosInMapConcatenated(mapOffset: Int, mapSize: Int): Int {
            var count = 0
            for (i in 0 until mapSize) {
                val byte = coeffBuffer[mapOffset + i].toInt() and 0xFF
                for (bit in 0 until 8) {
                    if (i * 8 + bit < coeffCount && (byte and (1 shl bit)) != 0) {
                        count++
                    }
                }
            }
            return count
        }

        // Use variable channel layout concatenated maps format for deltas
        postprocessCoefficientsVariableLayout(coeffBuffer, 0, coeffCount, channelLayout, deltaY, deltaCo, deltaCg, deltaAlpha)

        // Calculate total size for variable channel layout format (deltas)
        val numChannels = when (channelLayout) {
            CHANNEL_LAYOUT_YCOCG -> 3    // Y-Co-Cg
            CHANNEL_LAYOUT_YCOCG_A -> 4  // Y-Co-Cg-A
            CHANNEL_LAYOUT_Y_ONLY -> 1   // Y only
            CHANNEL_LAYOUT_Y_A -> 2      // Y-A
            CHANNEL_LAYOUT_COCG -> 2     // Co-Cg
            CHANNEL_LAYOUT_COCG_A -> 3   // Co-Cg-A
            else -> 3  // fallback to Y-Co-Cg
        }

        val totalMapSize = mapBytes * numChannels
        var totalNonZeros = 0
        for (ch in 0 until numChannels) {
            totalNonZeros += countNonZerosInMapConcatenated(mapBytes * ch, mapBytes)
        }
        val totalValueSize = totalNonZeros * 2

        ptr += (totalMapSize + totalValueSize)
        
        // Get or initialise previous coefficients for this tile
        val prevY = tavPreviousCoeffsY!![tileIdx] ?: FloatArray(coeffCount)
        val prevCo = tavPreviousCoeffsCo!![tileIdx] ?: FloatArray(coeffCount)
        val prevCg = tavPreviousCoeffsCg!![tileIdx] ?: FloatArray(coeffCount)
        
        // Reconstruct current coefficients: current = previous + delta
        val currentY = FloatArray(coeffCount)
        val currentCo = FloatArray(coeffCount)
        val currentCg = FloatArray(coeffCount)

        // Delta-specific perceptual reconstruction using motion-optimized coefficients
        // Estimate quality level from quantisation parameters for perceptual weighting
        val estimatedQualityY = when {
            qY <= 6 -> 4    // High quality
            qY <= 12 -> 3   // Medium-high quality
            qY <= 25 -> 2   // Medium quality
            qY <= 42 -> 1   // Medium-low quality
            else -> 0       // Low quality
        }

        // TEMPORARILY DISABLED: Delta-specific perceptual reconstruction
        // Use uniform delta reconstruction (same as original implementation)
        for (i in 0 until coeffCount) {
            currentY[i] = prevY[i] + (deltaY[i].toFloat() * qY)
            currentCo[i] = prevCo[i] + (deltaCo[i].toFloat() * qCo)
            currentCg[i] = prevCg[i] + (deltaCg[i].toFloat() * qCg)
        }

        // Remove grain synthesis from Y channel (must happen after dequantization, before inverse DWT)
        val tileWidth = if (isMonoblock) width else TAV_PADDED_TILE_SIZE_X
        val tileHeight = if (isMonoblock) height else TAV_PADDED_TILE_SIZE_Y
        val subbands = calculateSubbandLayout(tileWidth, tileHeight, decompLevels)
        // Delta frames use uniform quantization for the deltas themselves, so no perceptual weights
        removeGrainSynthesisDecoder(currentY, tileWidth, tileHeight, decompLevels, frameCount, qY.toFloat(), subbands)

        // Apply film grain filter if enabled
        // commented; grain synthesis is now a part of the spec
        /*if (filmGrainLevel > 0) {
            val random = java.util.Random()
            for (i in 0 until coeffCount) {
                currentY[i] += (random.nextInt(filmGrainLevel * 2 + 1) - filmGrainLevel).toFloat()
//                currentCo[i] += (random.nextInt(filmGrainLevel * 2 + 1) - filmGrainLevel).toFloat()
//                currentCg[i] += (random.nextInt(filmGrainLevel * 2 + 1) - filmGrainLevel).toFloat()
            }
        }*/

        // Store current coefficients as previous for next frame
        tavPreviousCoeffsY!![tileIdx] = currentY.clone()
        tavPreviousCoeffsCo!![tileIdx] = currentCo.clone()
        tavPreviousCoeffsCg!![tileIdx] = currentCg.clone()
        
        // Apply inverse DWT
        if (isLossless) {
            tavApplyDWTInverseMultiLevel(currentY, tileWidth, tileHeight, decompLevels, 0, TavSharpenLuma)
            tavApplyDWTInverseMultiLevel(currentCo, tileWidth, tileHeight, decompLevels, 0, TavNullFilter)
            tavApplyDWTInverseMultiLevel(currentCg, tileWidth, tileHeight, decompLevels, 0, TavNullFilter)
        } else {
            tavApplyDWTInverseMultiLevel(currentY, tileWidth, tileHeight, decompLevels, waveletFilter, TavSharpenLuma)
            tavApplyDWTInverseMultiLevel(currentCo, tileWidth, tileHeight, decompLevels, waveletFilter, TavNullFilter)
            tavApplyDWTInverseMultiLevel(currentCg, tileWidth, tileHeight, decompLevels, waveletFilter, TavNullFilter)
        }

        // Debug: Check coefficient values after inverse DWT
        if (tavDebugCurrentFrameNumber == tavDebugFrameTarget) {
            var maxYIdwt = 0.0f
            var minYIdwt = 0.0f
            var maxCoIdwt = 0.0f
            var minCoIdwt = 0.0f
            var maxCgIdwt = 0.0f
            var minCgIdwt = 0.0f
            for (coeff in currentY) {
                if (coeff > maxYIdwt) maxYIdwt = coeff
                if (coeff < minYIdwt) minYIdwt = coeff
            }
            for (coeff in currentCo) {
                if (coeff > maxCoIdwt) maxCoIdwt = coeff
                if (coeff < minCoIdwt) minCoIdwt = coeff
            }
            for (coeff in currentCg) {
                if (coeff > maxCgIdwt) maxCgIdwt = coeff
                if (coeff < minCgIdwt) minCgIdwt = coeff
            }
            println("[DECODER-DELTA] Frame $tavDebugCurrentFrameNumber - After IDWT: Y=[${minYIdwt.toInt()}, ${maxYIdwt.toInt()}], Co=[${minCoIdwt.toInt()}, ${maxCoIdwt.toInt()}], Cg=[${minCgIdwt.toInt()}, ${maxCgIdwt.toInt()}]")
        }
        
        // Extract final tile data
        val finalYTile: FloatArray
        val finalCoTile: FloatArray
        val finalCgTile: FloatArray
        val finalAlphaTile: FloatArray

        if (isMonoblock) {
            // Monoblock mode: use full frame data directly (no padding to extract)
            finalYTile = currentY
            finalCoTile = currentCo
            finalCgTile = currentCg
        } else {
            // Standard mode: extract core 280x224 pixels from reconstructed padded tiles (344x288)
            finalYTile = FloatArray(TAV_TILE_SIZE_X * TAV_TILE_SIZE_Y)
            finalCoTile = FloatArray(TAV_TILE_SIZE_X * TAV_TILE_SIZE_Y)
            finalCgTile = FloatArray(TAV_TILE_SIZE_X * TAV_TILE_SIZE_Y)

            for (y in 0 until TAV_TILE_SIZE_Y) {
                for (x in 0 until TAV_TILE_SIZE_X) {
                    val coreIdx = y * TAV_TILE_SIZE_X + x
                    val paddedIdx = (y + TAV_TILE_MARGIN) * TAV_PADDED_TILE_SIZE_X + (x + TAV_TILE_MARGIN)

                    finalYTile[coreIdx] = currentY[paddedIdx]
                    finalCoTile[coreIdx] = currentCo[paddedIdx]
                    finalCgTile[coreIdx] = currentCg[paddedIdx]
                }
            }
        }

        // write Y=127 if there's no luma channel
        if (channelLayout == CHANNEL_LAYOUT_COCG || channelLayout == CHANNEL_LAYOUT_COCG_A) {
            Arrays.fill(finalYTile, 127f)
        }

        // Convert to RGB based on TAV version and mode
        // v1,v3 = YCoCg-R, v2,v4 = ICtCp
        if (tavVersion % 2 == 0) {
            // ICtCp color space
            if (isMonoblock) {
                tavConvertICtCpMonoblockToRGB(finalYTile, finalCoTile, finalCgTile, currentRGBAddr, width, height)
            } else {
                tavConvertICtCpTileToRGB(tileX, tileY, finalYTile, finalCoTile, finalCgTile, currentRGBAddr, width, height)
            }
        } else {
            // YCoCg-R color space (v1, v3)
            if (isMonoblock) {
                tavConvertYCoCgMonoblockToRGB(finalYTile, finalCoTile, finalCgTile, currentRGBAddr, width, height)
            } else {
                tavConvertYCoCgTileToRGB(tileX, tileY, finalYTile, finalCoTile, finalCgTile, currentRGBAddr, width, height)
            }
        }
        
        return ptr
    }

    private fun getRGBPixel(rgbPtr: Long, pixelIdx: Int): ByteArray {
        val offset = pixelIdx * 3L
        return byteArrayOf(
            vm.peek(rgbPtr + offset),
            vm.peek(rgbPtr + offset + 1),
            vm.peek(rgbPtr + offset + 2)
        )
    }

    private interface TavWaveletFilter {
        fun getCoeffMultiplier(level: Int): Float // level 0: finest

        fun applyGain(level: Int, c: Float): Float {
            val T = 2f
            val gain = getCoeffMultiplier(level)
            return if (c.absoluteValue < T)
                c * (1f + (gain - 1f) * c.absoluteValue / T)
            else
                c * gain
        }
    }

    private object TavSharpenNormal : TavWaveletFilter {
        override fun getCoeffMultiplier(level: Int): Float {
            return when (level) {
                0 -> 1.18f
                1 -> 1.02f
                2 -> 0.85f
                else -> 1f
            }
        }
    }

    private object TavSharpenWeak : TavWaveletFilter {
        override fun getCoeffMultiplier(level: Int): Float {
            return when (level) {
                0 -> 1.08f
                1 -> 1.01f
                2 -> 0.93f
                else -> 1f
            }
        }
    }

    private object TavSharpenStrong : TavWaveletFilter {
        override fun getCoeffMultiplier(level: Int): Float {
            return when (level) {
                0 -> 1.30f
                1 -> 1.05f
                2 -> 0.77f
                else -> 1f
            }
        }
    }
    // normal/strong sharpen filters make horizontal/vertical hairline artefacts

    private val TavSharpenLuma = TavSharpenWeak

    private object TavNullFilter : TavWaveletFilter {
        override fun getCoeffMultiplier(level: Int): Float = 1.0f
    }

    private fun tavApplyDWTInverseMultiLevel(data: FloatArray, width: Int, height: Int, levels: Int, filterType: Int, sharpenFilter: TavWaveletFilter) {
        // Multi-level inverse DWT - reconstruct from smallest to largest (reverse of encoder)
        val maxSize = kotlin.math.max(width, height)
        val tempRow = FloatArray(maxSize)
        val tempCol = FloatArray(maxSize)

        for (level in levels - 1 downTo 0) {
            val currentWidth = width shr level
            val currentHeight = height shr level

            // Handle edge cases for very small decomposition levels
            if (currentWidth < 1 || currentHeight < 1) continue // Skip invalid sizes
            if (currentWidth == 1 && currentHeight == 1) {
                // Single DC coefficient, no DWT needed but preserve it
                continue
            }

            // Debug: Sample coefficient values before this level's reconstruction
            if (tavDebugCurrentFrameNumber == tavDebugFrameTarget) {
                var maxCoeff = 0.0f
                var nonzeroCoeff = 0
                val sampleSize = minOf(100, currentWidth * currentHeight)
                for (i in 0 until sampleSize) {
                    val coeff = kotlin.math.abs(data[i])
                    if (coeff > maxCoeff) maxCoeff = coeff
                    if (coeff > 0.1f) nonzeroCoeff++
                }
                println("[IDWT-LEVEL-$level] BEFORE: ${currentWidth}x${currentHeight}, max=${maxCoeff.toInt()}, nonzero=$nonzeroCoeff/$sampleSize")
            }

            // Apply inverse DWT to current subband region - EXACT match to encoder
            // The encoder does ROW transform first, then COLUMN transform
            // So inverse must do COLUMN inverse first, then ROW inverse

            // Column inverse transform first (vertical)
            for (x in 0 until currentWidth) {
                for (y in 0 until currentHeight) {
                    tempCol[y] = sharpenFilter.applyGain(level, data[y * width + x])
                }

                if (filterType == 0) {
                    tavApplyDWT53Inverse1D(tempCol, currentHeight)
                } else if (filterType == 1) {
                    tavApplyDWT97Inverse1D(tempCol, currentHeight)
                } else if (filterType == 2) {
                    tavApplyDWTBior137Inverse1D(tempCol, currentHeight)
                } else if (filterType == 16) {
                    tavApplyDWTDD4Inverse1D(tempCol, currentHeight)
                } else if (filterType == 255) {
                    tavApplyDWTHaarInverse1D(tempCol, currentHeight)
                }

                for (y in 0 until currentHeight) {
                    data[y * width + x] = tempCol[y]
                }
            }

            // Row inverse transform second (horizontal)
            for (y in 0 until currentHeight) {
                for (x in 0 until currentWidth) {
                    tempRow[x] = sharpenFilter.applyGain(level, data[y * width + x])
                }

                if (filterType == 0) {
                    tavApplyDWT53Inverse1D(tempRow, currentWidth)
                } else if (filterType == 1) {
                    tavApplyDWT97Inverse1D(tempRow, currentWidth)
                } else if (filterType == 2) {
                    tavApplyDWTBior137Inverse1D(tempRow, currentWidth)
                } else if (filterType == 16) {
                    tavApplyDWTDD4Inverse1D(tempRow, currentWidth)
                } else if (filterType == 255) {
                    tavApplyDWTHaarInverse1D(tempRow, currentWidth)
                }

                for (x in 0 until currentWidth) {
                    data[y * width + x] = tempRow[x]
                }
            }

            // Debug: Sample coefficient values after this level's reconstruction
            if (tavDebugCurrentFrameNumber == tavDebugFrameTarget) {
                var maxCoeff = 0.0f
                var nonzeroCoeff = 0
                val sampleSize = minOf(100, currentWidth * currentHeight)
                for (i in 0 until sampleSize) {
                    val coeff = kotlin.math.abs(data[i])
                    if (coeff > maxCoeff) maxCoeff = coeff
                    if (coeff > 0.1f) nonzeroCoeff++
                }
                println("[IDWT-LEVEL-$level] AFTER:  ${currentWidth}x${currentHeight}, max=${maxCoeff.toInt()}, nonzero=$nonzeroCoeff/$sampleSize")
            }
        }
    }

    // 1D lifting scheme implementations for 9/7 irreversible filter
    private fun tavApplyDWT97Inverse1D(data: FloatArray, length: Int) {
        if (length < 2) return

        val temp = FloatArray(length)
        val half = (length + 1) / 2  // Handle odd lengths properly

        // Split into low and high frequency components (matching encoder layout)
        // After forward DWT: first half = low-pass, second half = high-pass
        for (i in 0 until half) {
            temp[i] = data[i]              // Low-pass coefficients (first half)
        }
        for (i in 0 until length / 2) {
            if (half + i < length && half + i < data.size) {
                temp[half + i] = data[half + i] // High-pass coefficients (second half)
            }
        }

        // 9/7 inverse lifting coefficients (original working values)
        val alpha = -1.586134342f
        val beta = -0.052980118f
        val gamma = 0.882911076f
        val delta = 0.443506852f
        val K = 1.230174105f

        // JPEG2000 9/7 inverse lifting steps (corrected implementation)
        // Reference order: undo scaling → undo δ → undo γ → undo β → undo α → interleave

        // Step 1: Undo scaling - s[i] /= K, d[i] *= K
        for (i in 0 until half) {
            temp[i] /= K  // Low-pass coefficients
        }
        for (i in 0 until length / 2) {
            if (half + i < length) {
                temp[half + i] *= K  // High-pass coefficients
            }
        }

        // Step 2: Undo δ update - s[i] -= δ * (d[i] + d[i-1])
        for (i in 0 until half) {
            val d_curr = if (half + i < length) temp[half + i] else 0.0f
            val d_prev = if (i > 0 && half + i - 1 < length) temp[half + i - 1] else d_curr
            temp[i] -= delta * (d_curr + d_prev)
        }

        // Step 3: Undo γ predict - d[i] -= γ * (s[i] + s[i+1])
        for (i in 0 until length / 2) {
            if (half + i < length) {
                val s_curr = temp[i]
                val s_next = if (i + 1 < half) temp[i + 1] else s_curr
                temp[half + i] -= gamma * (s_curr + s_next)
            }
        }

        // Step 4: Undo β update - s[i] -= β * (d[i] + d[i-1])
        for (i in 0 until half) {
            val d_curr = if (half + i < length) temp[half + i] else 0.0f
            val d_prev = if (i > 0 && half + i - 1 < length) temp[half + i - 1] else d_curr
            temp[i] -= beta * (d_curr + d_prev)
        }

        // Step 5: Undo α predict - d[i] -= α * (s[i] + s[i+1])
        for (i in 0 until length / 2) {
            if (half + i < length) {
                val s_curr = temp[i]
                val s_next = if (i + 1 < half) temp[i + 1] else s_curr
                temp[half + i] -= alpha * (s_curr + s_next)
            }
        }

        // Simple reconstruction (revert to working version)
        for (i in 0 until length) {
            if (i % 2 == 0) {
                // Even positions: low-pass coefficients
                data[i] = temp[i / 2]
            } else {
                // Odd positions: high-pass coefficients
                val idx = i / 2
                if (half + idx < length) {
                    data[i] = temp[half + idx]
                } else {
                    data[i] = 0.0f // Boundary case
                }
            }
        }
    }

    private fun tavApplyDWT53Inverse1D(data: FloatArray, length: Int) {
        if (length < 2) return

        val temp = FloatArray(length)
        val half = (length + 1) / 2  // Handle odd lengths properly

        // Split into low and high frequency components (matching encoder layout)
        for (i in 0 until half) {
            temp[i] = data[i]              // Low-pass coefficients (first half)
        }
        for (i in 0 until length / 2) {
            if (half + i < length && half + i < data.size) {
                temp[half + i] = data[half + i] // High-pass coefficients (second half)
            }
        }

        // 5/3 inverse lifting (undo forward steps in reverse order)

        // Step 2: Undo update step (1/4 coefficient) - JPEG2000 symmetric extension
        for (i in 0 until half) {
            val leftIdx = half + i - 1
            val centerIdx = half + i
            
            // Symmetric extension for boundary handling
            val left = when {
                leftIdx >= 0 && leftIdx < length -> temp[leftIdx]
                centerIdx < length && centerIdx + 1 < length -> temp[centerIdx + 1] // Mirror
                centerIdx < length -> temp[centerIdx]
                else -> 0.0f
            }
            val right = if (centerIdx < length) temp[centerIdx] else 0.0f
            temp[i] -= 0.25f * (left + right)
        }

        // Step 1: Undo predict step (1/2 coefficient) - JPEG2000 symmetric extension
        for (i in 0 until length / 2) {
            if (half + i < length) {
                val left = temp[i]
                // Symmetric extension for right boundary
                val right = if (i < half - 1) temp[i + 1] else if (half > 2) temp[half - 2] else temp[half - 1]
                temp[half + i] += 0.5f * (left + right)  // ADD to undo the subtraction in encoder
            }
        }

        // Simple reconstruction (revert to working version)
        for (i in 0 until length) {
            if (i % 2 == 0) {
                // Even positions: low-pass coefficients
                data[i] = temp[i / 2]
            } else {
                // Odd positions: high-pass coefficients
                val idx = i / 2
                if (half + idx < length) {
                    data[i] = temp[half + idx]
                } else {
                    // Symmetric extension: mirror the last available high-pass coefficient
                    val lastHighIdx = (length / 2) - 1
                    if (lastHighIdx >= 0 && half + lastHighIdx < length) {
                        data[i] = temp[half + lastHighIdx]
                    } else {
                        data[i] = 0.0f
                    }
                }
            }
        }
    }

    // Four-point interpolating Deslauriers-Dubuc (DD-4) wavelet inverse 1D transform
    // Reverses the four-sample prediction kernel: w[-1]=-1/16, w[0]=9/16, w[1]=9/16, w[2]=-1/16
    private fun tavApplyDWTDD4Inverse1D(data: FloatArray, length: Int) {
        if (length < 2) return

        val temp = FloatArray(length)
        val half = (length + 1) / 2  // Handle odd lengths properly

        // Split into low and high frequency components (matching encoder layout)
        for (i in 0 until half) {
            temp[i] = data[i]              // Low-pass coefficients (first half)
        }
        for (i in 0 until length / 2) {
            if (half + i < length && half + i < data.size) {
                temp[half + i] = data[half + i] // High-pass coefficients (second half)
            }
        }

        // DD-4 inverse lifting (undo forward steps in reverse order)

        // Step 2: Undo update step - s[i] -= 0.25 * (d[i-1] + d[i])
        for (i in 0 until half) {
            val d_curr = if (i < length / 2) temp[half + i] else 0.0f
            val d_prev = if (i > 0 && i - 1 < length / 2) temp[half + i - 1] else 0.0f
            temp[i] -= 0.25f * (d_prev + d_curr)
        }

        // Step 1: Undo four-point prediction - add back the four-point prediction
        // d[i] += prediction where prediction = (-1/16)*s[i-1] + (9/16)*s[i] + (9/16)*s[i+1] + (-1/16)*s[i+2]
        for (i in 0 until length / 2) {
            // Get four neighboring even samples with symmetric boundary extension
            val s_m1: Float
            val s_0: Float
            val s_1: Float
            val s_2: Float

            // s[i-1]
            s_m1 = if (i > 0) temp[i - 1] else temp[0] // Mirror boundary

            // s[i]
            s_0 = temp[i]

            // s[i+1]
            s_1 = if (i + 1 < half) temp[i + 1] else temp[half - 1] // Mirror boundary

            // s[i+2]
            s_2 = if (i + 2 < half) temp[i + 2]
                  else if (half > 1) temp[half - 2] // Mirror boundary
                  else temp[half - 1]

            // Apply four-point prediction kernel (add back what was subtracted)
            val prediction = (-1.0f/16.0f) * s_m1 + (9.0f/16.0f) * s_0 +
                           (9.0f/16.0f) * s_1 + (-1.0f/16.0f) * s_2

            temp[half + i] += prediction
        }

        // Reconstruction - interleave low and high frequency components
        for (i in 0 until length) {
            if (i % 2 == 0) {
                // Even positions: low-pass coefficients
                data[i] = temp[i / 2]
            } else {
                // Odd positions: high-pass coefficients
                val idx = i / 2
                if (half + idx < length) {
                    data[i] = temp[half + idx]
                } else {
                    // Symmetric extension: mirror the last available high-pass coefficient
                    val lastHighIdx = (length / 2) - 1
                    if (lastHighIdx >= 0 && half + lastHighIdx < length) {
                        data[i] = temp[half + lastHighIdx]
                    } else {
                        data[i] = 0.0f
                    }
                }
            }
        }
    }

    // Biorthogonal 13/7 wavelet inverse 1D transform
    // Synthesis filters: Low-pass (13 taps), High-pass (7 taps)
    private fun tavApplyDWTBior137Inverse1D(data: FloatArray, length: Int) {
        if (length < 2) return

        val temp = FloatArray(length)
        val half = (length + 1) / 2

        // Split into low and high frequency components
        for (i in 0 until half) {
            temp[i] = data[i]              // Low-pass coefficients
        }
        for (i in 0 until length / 2) {
            if (half + i < length) {
                temp[half + i] = data[half + i] // High-pass coefficients
            }
        }

        // Biorthogonal 13/7 inverse lifting (undo forward steps in reverse order)
        // Must exactly reverse the operations from the forward transform (simplified to match 5/3 structure)

        val K = 1.230174105f

        // Step 1: Undo scaling - s[i] /= K, d[i] *= K
        for (i in 0 until half) {
            temp[i] /= K  // Low-pass coefficients
        }
        for (i in 0 until length / 2) {
            if (half + i < length) {
                temp[half + i] *= K  // High-pass coefficients
            }
        }

        // Step 2: Undo update step (reverse of encoder step 2)
        for (i in 0 until half) {
            val leftIdx = half + i - 1
            val centerIdx = half + i

            // Same boundary handling as 5/3
            val left = when {
                leftIdx >= 0 && leftIdx < length -> temp[leftIdx]
                centerIdx < length && centerIdx + 1 < length -> temp[centerIdx + 1] // Mirror
                centerIdx < length -> temp[centerIdx]
                else -> 0.0f
            }
            val right = if (centerIdx < length) temp[centerIdx] else 0.0f
            temp[i] -= 0.25f * (left + right)
        }

        // Step 1: Undo predict step (reverse of encoder step 1)
        for (i in 0 until length / 2) {
            if (half + i < length) {
                // Simple 2-tap prediction (same as encoder)
                val left = temp[i]
                val right = if (i + 1 < half) temp[i + 1] else temp[half - 1]
                val prediction = 0.5f * (left + right)

                temp[half + i] += prediction
            }
        }

        // Reconstruction - interleave low and high frequency components
        for (i in 0 until length) {
            if (i % 2 == 0) {
                // Even positions: low-pass coefficients
                data[i] = temp[i / 2]
            } else {
                // Odd positions: high-pass coefficients
                val idx = i / 2
                if (half + idx < length) {
                    data[i] = temp[half + idx]
                } else {
                    data[i] = 0.0f
                }
            }
        }
    }

    // Haar wavelet inverse 1D transform
    // The simplest wavelet: reverses averages and differences
    private fun tavApplyDWTHaarInverse1D(data: FloatArray, length: Int) {
        if (length < 2) return

        val temp = FloatArray(length)
        val half = (length + 1) / 2

        // Split into low and high frequency components
        for (i in 0 until half) {
            temp[i] = data[i]              // Low-pass coefficients (averages)
        }
        for (i in 0 until length / 2) {
            if (half + i < length) {
                temp[half + i] = data[half + i] // High-pass coefficients (differences)
            }
        }

        // Haar inverse: reconstruct original samples from averages and differences
        for (i in 0 until half) {
            if (2 * i + 1 < length) {
                val avg = temp[i]           // Average (low-pass)
                val diff = if (half + i < length) temp[half + i] else 0.0f  // Difference (high-pass)

                // Reconstruct original adjacent pair
                data[2 * i] = avg + diff        // First sample: average + difference
                data[2 * i + 1] = avg - diff    // Second sample: average - difference
            } else {
                // Handle odd length: last sample comes directly from low-pass
                data[2 * i] = temp[i]
            }
        }
    }

}