package net.torvald.tsvm

import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.math.MathUtils.*
import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.peripheral.fmod
import kotlin.experimental.and
import kotlin.experimental.or
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.cos
import kotlin.math.sqrt
import kotlin.math.PI

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
    fun setPalette(index: Int, r: Int, g: Int, b: Int, a: Int = 16) {
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

    fun plotPixel(x: Int, y: Int, color: Int) {
        getFirstGPU()?.let {
            if (x in 0 until it.config.width && y in 0 until it.config.height) {
                it.poke(y.toLong() * it.config.width + x, color.toByte())
                it.applyDelay()
            }
        }
    }

    fun plotPixel2(x: Int, y: Int, color: Int) {
        getFirstGPU()?.let {
            if (x in 0 until it.config.width && y in 0 until it.config.height) {
                it.poke(262144 + y.toLong() * it.config.width + x, color.toByte())
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

                val offsets = longArrayOf(k+1,
                    k+width-1,k+width,k+width+1,
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
    
    fun blockEncodeToYCoCg(blockX: Int, blockY: Int, srcPtr: Int, width: Int, channels: Int, hasAlpha: Boolean, pattern: Int): List<Any> {
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
            val (_1, _2, _3, _4) = blockEncodeToYCoCg(blockX, blockY, srcPtr, width, channels, hasAlpha, pattern)
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
        val coA = (a[0].toInt() and 0xFF) or ((a[1].toInt() and 0xFF) shl 8)
        val coB = (b[0].toInt() and 0xFF) or ((b[1].toInt() and 0xFF) shl 8)
        for (i in 0 until 4) {
            val va = (coA shr (i * 4)) and 0xF
            val vb = (coB shr (i * 4)) and 0xF
            val delta = abs(va - vb)
            score += contrastWeight(va, vb, delta, 3)
        }

        // Cg (bytes 2–3): 4 nybbles
        val cgA = (a[2].toInt() and 0xFF) or ((a[3].toInt() and 0xFF) shl 8)
        val cgB = (b[2].toInt() and 0xFF) or ((b[3].toInt() and 0xFF) shl 8)
        for (i in 0 until 4) {
            val va = (cgA shr (i * 4)) and 0xF
            val vb = (cgB shr (i * 4)) and 0xF
            val delta = abs(va - vb)
            score += contrastWeight(va, vb, delta, 3)
        }

        // Y (bytes 4–9): 16 nybbles
        for (i in 4 until 10) {
            val byteA = a[i].toInt() and 0xFF
            val byteB = b[i].toInt() and 0xFF

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
            val (_1, _2, _3, _4) = blockEncodeToYCoCg(blockX, blockY, srcPtr, width, channels, hasAlpha, pattern)
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
    private fun ycocgToRGB(co: Int, cg: Int, ys: Int, As: Int): Array<Int> { // ys: 4 Y-values
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

    private fun ycocgToRGB(co1: Int, co2: Int, cg1: Int, cg2: Int, ys: Int, As: Int): Array<Int> { // ys: 4 Y-values
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

            var corner = ycocgToRGB(co and 15, cg and 15, y1, a1)
            rg[0] = corner[0];ba[0] = corner[1]
            rg[1] = corner[2];ba[1] = corner[3]
            rg[4] = corner[4];ba[4] = corner[5]
            rg[5] = corner[6];ba[5] = corner[7]

            corner = ycocgToRGB((co shr 4) and 15, (cg shr 4) and 15, y2, a2)
            rg[2] = corner[0];ba[2] = corner[1]
            rg[3] = corner[2];ba[3] = corner[3]
            rg[6] = corner[4];ba[6] = corner[5]
            rg[7] = corner[6];ba[7] = corner[7]

            corner = ycocgToRGB((co shr 8) and 15, (cg shr 8) and 15, y3, a3)
            rg[8] = corner[0];ba[8] = corner[1]
            rg[9] = corner[2];ba[9] = corner[3]
            rg[12] = corner[4];ba[12] = corner[5]
            rg[13] = corner[6];ba[13] = corner[7]

            corner = ycocgToRGB((co shr 12) and 15, (cg shr 12) and 15, y4, a4)
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

        fun readByte(): Int = vm.peek(ptr++)!!.toInt() and 0xFF
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

                        var px = ycocgToRGB(co and 15, cg and 15, y1, 65535)
                        rg[0] = px[0]; ba[0] = px[1]
                        rg[1] = px[2]; ba[1] = px[3]
                        rg[4] = px[4]; ba[4] = px[5]
                        rg[5] = px[6]; ba[5] = px[7]

                        px = ycocgToRGB((co shr 4) and 15, (cg shr 4) and 15, y2, 65535)
                        rg[2] = px[0]; ba[2] = px[1]
                        rg[3] = px[2]; ba[3] = px[3]
                        rg[6] = px[4]; ba[6] = px[5]
                        rg[7] = px[6]; ba[7] = px[7]

                        px = ycocgToRGB((co shr 8) and 15, (cg shr 8) and 15, y3, 65535)
                        rg[8] = px[0]; ba[8] = px[1]
                        rg[9] = px[2]; ba[9] = px[3]
                        rg[12] = px[4]; ba[12] = px[5]
                        rg[13] = px[6]; ba[13] = px[7]

                        px = ycocgToRGB((co shr 12) and 15, (cg shr 12) and 15, y4, 65535)
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

            var corner = ycocgToRGB(co and 15, (co shr 8) and 15, cg and 15, (cg shr 8) and 15, y1, a1)
            rg[0] = corner[0];ba[0] = corner[1]
            rg[1] = corner[2];ba[1] = corner[3]
            rg[4] = corner[4];ba[4] = corner[5]
            rg[5] = corner[6];ba[5] = corner[7]

            corner = ycocgToRGB((co shr 4) and 15, (co shr 12) and 15, (cg shr 4) and 15, (cg shr 12) and 15, y2, a2)
            rg[2] = corner[0];ba[2] = corner[1]
            rg[3] = corner[2];ba[3] = corner[3]
            rg[6] = corner[4];ba[6] = corner[5]
            rg[7] = corner[6];ba[7] = corner[7]

            corner = ycocgToRGB((co shr 16) and 15, (co shr 24) and 15, (cg shr 16) and 15, (cg shr 24) and 15, y3, a3)
            rg[8] = corner[0];ba[8] = corner[1]
            rg[9] = corner[2];ba[9] = corner[3]
            rg[12] = corner[4];ba[12] = corner[5]
            rg[13] = corner[6];ba[13] = corner[7]

            corner = ycocgToRGB((co shr 20) and 15, (co shr 28) and 15, (cg shr 20) and 15, (cg shr 28) and 15, y4, a4)
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

    /**
     * Fast 8x8 DCT transform optimized for video compression
     * @param blockPtr pointer to 64 RGB values (192 bytes: R,G,B,R,G,B...)
     * @param dctPtr pointer to output DCT coefficients (192 floats: 64*3 channels)
     */
    fun tevDct8x8(blockPtr: Int, dctPtr: Int) {
        val gpu = getFirstGPU() ?: return
        
        // DCT-II basis functions pre-computed for 8x8 blocks
        val dctBasis = Array(8) { u ->
            Array(8) { x ->
                val cu = if (u == 0) 1.0 / sqrt(2.0) else 1.0
                cu * cos((2.0 * x + 1.0) * u * PI / 16.0) / 2.0
            }
        }
        
        val block = Array(3) { Array(8) { DoubleArray(8) } } // R,G,B channels
        val dctCoeffs = Array(3) { Array(8) { DoubleArray(8) } }
        
        // Read RGB block from memory
        for (y in 0..7) {
            for (x in 0..7) {
                val offset = (y * 8 + x) * 3
                val r = vm.peek(blockPtr.toLong() + offset)!! and -1
                val g = vm.peek(blockPtr.toLong() + offset + 1)!! and -1
                val b = vm.peek(blockPtr.toLong() + offset + 2)!! and -1
                
                // Convert to 0-1 range and center around 0
                block[0][y][x] = (r / 255.0) - 0.5
                block[1][y][x] = (g / 255.0) - 0.5
                block[2][y][x] = (b / 255.0) - 0.5
            }
        }
        
        // Apply 2D DCT to each channel
        for (channel in 0..2) {
            for (u in 0..7) {
                for (v in 0..7) {
                    var sum = 0.0
                    for (x in 0..7) {
                        for (y in 0..7) {
                            sum += dctBasis[u][x] * dctBasis[v][y] * block[channel][y][x]
                        }
                    }
                    dctCoeffs[channel][u][v] = sum
                }
            }
        }
        
        // Write DCT coefficients to memory (as IEEE 754 floats)
        for (channel in 0..2) {
            for (u in 0..7) {
                for (v in 0..7) {
                    val offset = (channel * 64 + u * 8 + v) * 4
                    val floatBits = java.lang.Float.floatToIntBits(dctCoeffs[channel][u][v].toFloat())
                    vm.poke(dctPtr.toLong() + offset, (floatBits and 0xFF).toByte())
                    vm.poke(dctPtr.toLong() + offset + 1, ((floatBits shr 8) and 0xFF).toByte())
                    vm.poke(dctPtr.toLong() + offset + 2, ((floatBits shr 16) and 0xFF).toByte())
                    vm.poke(dctPtr.toLong() + offset + 3, ((floatBits shr 24) and 0xFF).toByte())
                }
            }
        }
    }

    /**
     * Fast 8x8 inverse DCT optimized for video decompression
     * @param dctPtr pointer to DCT coefficients (192 floats)
     * @param blockPtr pointer to output RGB block (192 bytes)
     */
    fun tevIdct8x8(dctPtr: Int, blockPtr: Int) {
        val gpu = getFirstGPU() ?: return
        
        val dctBasis = Array(8) { u ->
            Array(8) { x ->
                val cu = if (u == 0) 1.0 / sqrt(2.0) else 1.0
                cu * cos((2.0 * x + 1.0) * u * PI / 16.0) / 2.0
            }
        }
        
        val dctCoeffs = Array(3) { Array(8) { DoubleArray(8) } }
        val block = Array(3) { Array(8) { DoubleArray(8) } }
        
        // Read DCT coefficients from memory
        for (channel in 0..2) {
            for (u in 0..7) {
                for (v in 0..7) {
                    val offset = (channel * 64 + u * 8 + v) * 4
                    val b0 = vm.peek(dctPtr.toLong() + offset)!! and -1
                    val b1 = vm.peek(dctPtr.toLong() + offset + 1)!! and -1
                    val b2 = vm.peek(dctPtr.toLong() + offset + 2)!! and -1
                    val b3 = vm.peek(dctPtr.toLong() + offset + 3)!! and -1
                    val floatBits = b0.toUint() or (b1.toUint() shl 8) or (b2.toUint() shl 16) or (b3.toUint() shl 24)
                    dctCoeffs[channel][u][v] = java.lang.Float.intBitsToFloat(floatBits).toDouble()
                }
            }
        }
        
        // Apply 2D inverse DCT to each channel
        for (channel in 0..2) {
            for (x in 0..7) {
                for (y in 0..7) {
                    var sum = 0.0
                    for (u in 0..7) {
                        for (v in 0..7) {
                            sum += dctBasis[u][x] * dctBasis[v][y] * dctCoeffs[channel][u][v]
                        }
                    }
                    block[channel][y][x] = sum + 0.5 // Add back DC offset
                }
            }
        }
        
        // Write RGB block to memory (clamped to 0-255)
        for (y in 0..7) {
            for (x in 0..7) {
                val offset = (y * 8 + x) * 3
                val r = (clamp(block[0][y][x] * 255.0, 0.0, 255.0)).toInt()
                val g = (clamp(block[1][y][x] * 255.0, 0.0, 255.0)).toInt()
                val b = (clamp(block[2][y][x] * 255.0, 0.0, 255.0)).toInt()
                
                vm.poke(blockPtr.toLong() + offset, r.toByte())
                vm.poke(blockPtr.toLong() + offset + 1, g.toByte())
                vm.poke(blockPtr.toLong() + offset + 2, b.toByte())
            }
        }
    }

    /**
     * Motion compensation: copy 8x8 block with sub-pixel interpolation
     * @param srcRG source R|G framebuffer address  
     * @param srcBA source B|A framebuffer address
     * @param destRG destination R|G framebuffer address
     * @param destBA destination B|A framebuffer address
     * @param srcX source X coordinate (in pixels)
     * @param srcY source Y coordinate (in pixels)
     * @param destX destination X coordinate (in pixels)
     * @param destY destination Y coordinate (in pixels)
     * @param mvX motion vector X (in 1/4 pixel units)
     * @param mvY motion vector Y (in 1/4 pixel units)
     */
    fun tevMotionCopy8x8(srcRG: Int, srcBA: Int, destRG: Int, destBA: Int, 
                        srcX: Int, srcY: Int, destX: Int, destY: Int, mvX: Int, mvY: Int) {
        val gpu = getFirstGPU() ?: return
        val width = gpu.config.width
        val height = gpu.config.height
        
        // Calculate actual source position with motion vector
        val actualSrcX = srcX + mvX / 4.0
        val actualSrcY = srcY + mvY / 4.0
        
        // For sub-pixel precision, use bilinear interpolation
        for (dy in 0..7) {
            for (dx in 0..7) {
                val sx = actualSrcX + dx
                val sy = actualSrcY + dy
                
                if (sx >= 0 && sy >= 0 && sx < width - 1 && sy < height - 1) {
                    // Integer and fractional parts
                    val ix = sx.toInt()
                    val iy = sy.toInt() 
                    val fx = sx - ix
                    val fy = sy - iy
                    
                    // Read 2x2 neighborhood for interpolation
                    val srcOffset00 = iy * width + ix
                    val srcOffset01 = iy * width + (ix + 1)
                    val srcOffset10 = (iy + 1) * width + ix
                    val srcOffset11 = (iy + 1) * width + (ix + 1)
                    
                    val rg00 = vm.peek(srcRG.toLong() + srcOffset00)!! and -1
                    val rg01 = vm.peek(srcRG.toLong() + srcOffset01)!! and -1
                    val rg10 = vm.peek(srcRG.toLong() + srcOffset10)!! and -1
                    val rg11 = vm.peek(srcRG.toLong() + srcOffset11)!! and -1
                    
                    val ba00 = vm.peek(srcBA.toLong() + srcOffset00)!! and -1
                    val ba01 = vm.peek(srcBA.toLong() + srcOffset01)!! and -1
                    val ba10 = vm.peek(srcBA.toLong() + srcOffset10)!! and -1
                    val ba11 = vm.peek(srcBA.toLong() + srcOffset11)!! and -1
                    
                    // Bilinear interpolation
                    val rgTop = rg00 * (1 - fx) + rg01 * fx
                    val rgBot = rg10 * (1 - fx) + rg11 * fx
                    val rgFinal = (rgTop * (1 - fy) + rgBot * fy).toInt()
                    
                    val baTop = ba00 * (1 - fx) + ba01 * fx
                    val baBot = ba10 * (1 - fx) + ba11 * fx
                    val baFinal = (baTop * (1 - fy) + baBot * fy).toInt()
                    
                    // Write to destination
                    val destOffset = (destY + dy) * width + (destX + dx)
                    if (destX + dx < width && destY + dy < height) {
                        vm.poke(destRG.toLong() + destOffset, rgFinal.toByte())
                        vm.poke(destBA.toLong() + destOffset, baFinal.toByte())
                    }
                }
            }
        }
    }

    /**
     * Convert 8x8 RGB block to 4096-color format (4:4:4 RGB)
     * @param rgbPtr pointer to RGB block (192 bytes)
     * @param destRG destination R|G framebuffer
     * @param destBA destination B|A framebuffer  
     * @param blockX block X coordinate (in 8-pixel units)
     * @param blockY block Y coordinate (in 8-pixel units)
     */
    fun tevRgbTo4096(rgbPtr: Int, destRG: Int, destBA: Int, blockX: Int, blockY: Int) {
        val gpu = getFirstGPU() ?: return
        val width = gpu.config.width
        
        for (y in 0..7) {
            for (x in 0..7) {
                val rgbOffset = (y * 8 + x) * 3
                val r = vm.peek(rgbPtr.toLong() + rgbOffset)!! and -1
                val g = vm.peek(rgbPtr.toLong() + rgbOffset + 1)!! and -1
                val b = vm.peek(rgbPtr.toLong() + rgbOffset + 2)!! and -1
                
                // Convert to 4-bit per channel (4096 colors)
                val r4 = (r * 15 + 127) / 255
                val g4 = (g * 15 + 127) / 255
                val b4 = (b * 15 + 127) / 255
                
                val pixelX = blockX * 8 + x
                val pixelY = blockY * 8 + y
                val destOffset = pixelY * width + pixelX
                
                if (pixelX < width && pixelY < gpu.config.height) {
                    vm.poke(destRG.toLong() + destOffset, ((r4 shl 4) or g4).toByte())
                    vm.poke(destBA.toLong() + destOffset, ((b4 shl 4) or 15).toByte()) // Alpha = 15 (opaque)
                }
            }
        }
    }

    /**
     * Motion estimation: find best motion vector for 8x8 block
     * @param refRG reference frame R|G data
     * @param refBA reference frame B|A data
     * @param curRG current frame R|G data
     * @param curBA current frame B|A data
     * @param blockX block X coordinate
     * @param blockY block Y coordinate
     * @param searchRange search range in pixels
     * @return packed motion vector (X in low 16 bits, Y in high 16 bits)
     */
    fun tevMotionEstimate8x8(refRG: Int, refBA: Int, curRG: Int, curBA: Int,
                           blockX: Int, blockY: Int, searchRange: Int): Int {
        val gpu = getFirstGPU() ?: return 0
        val width = gpu.config.width
        val height = gpu.config.height
        
        var bestMVX = 0
        var bestMVY = 0
        var bestSAD = Int.MAX_VALUE
        
        val startX = blockX * 8
        val startY = blockY * 8
        
        // Search in the specified range
        for (mvY in -searchRange..searchRange) {
            for (mvX in -searchRange..searchRange) {
                val refStartX = startX + mvX
                val refStartY = startY + mvY
                
                // Check bounds
                if (refStartX >= 0 && refStartY >= 0 && 
                    refStartX + 8 <= width && refStartY + 8 <= height) {
                    
                    var sad = 0
                    
                    // Calculate Sum of Absolute Differences
                    for (dy in 0..7) {
                        for (dx in 0..7) {
                            val curOffset = (startY + dy) * width + (startX + dx)
                            val refOffset = (refStartY + dy) * width + (refStartX + dx)
                            
                            val curRG = vm.peek(curRG.toLong() + curOffset)!! and -1
                            val curBA = vm.peek(curBA.toLong() + curOffset)!! and -1
                            val refRGVal = vm.peek(refRG.toLong() + refOffset)!! and -1
                            val refBAVal = vm.peek(refBA.toLong() + refOffset)!! and -1
                            
                            sad += abs((curRG and -16) - (refRGVal and -16)) + // R
                                   abs((curRG and 0x0F) - (refRGVal and 0x0F)) + // G
                                   abs((curBA and -16) - (refBAVal and -16))   // B
                        }
                    }
                    
                    if (sad < bestSAD) {
                        bestSAD = sad
                        bestMVX = mvX
                        bestMVY = mvY
                    }
                }
            }
        }
        
        // Pack motion vector (16-bit X, 16-bit Y)
        return (bestMVY shl 16) or (bestMVX and 0xFFFF)
    }

    val QUANT_TABLES = arrayOf(
    // Quality 0 (lowest)
    intArrayOf(80, 60, 50, 80, 120, 200, 255, 255,
    55, 60, 70, 95, 130, 255, 255, 255,
    70, 65, 80, 120, 200, 255, 255, 255,
    70, 85, 110, 145, 255, 255, 255, 255,
    90, 110, 185, 255, 255, 255, 255, 255,
    120, 175, 255, 255, 255, 255, 255, 255,
    245, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255),
    // Quality 1-6 (simplified)
    intArrayOf(40, 30, 25, 40, 60, 100, 128, 150,
    28, 30, 35, 48, 65, 128, 150, 180,
    35, 33, 40, 60, 100, 128, 150, 180,
    35, 43, 55, 73, 128, 150, 180, 200,
    45, 55, 93, 128, 150, 180, 200, 220,
    60, 88, 128, 150, 180, 200, 220, 240,
    123, 128, 150, 180, 200, 220, 240, 250,
    128, 150, 180, 200, 220, 240, 250, 255),
    intArrayOf(20, 15, 13, 20, 30, 50, 64, 75,
    14, 15, 18, 24, 33, 64, 75, 90,
    18, 17, 20, 30, 50, 64, 75, 90,
    18, 22, 28, 37, 64, 75, 90, 100,
    23, 28, 47, 64, 75, 90, 100, 110,
    30, 44, 64, 75, 90, 100, 110, 120,
    62, 64, 75, 90, 100, 110, 120, 125,
    64, 75, 90, 100, 110, 120, 125, 128),
    intArrayOf(16, 12, 10, 16, 24, 40, 51, 60,
    11, 12, 14, 19, 26, 51, 60, 72,
    14, 13, 16, 24, 40, 51, 60, 72,
    14, 17, 22, 29, 51, 60, 72, 80,
    18, 22, 37, 51, 60, 72, 80, 88,
    24, 35, 51, 60, 72, 80, 88, 96,
    49, 51, 60, 72, 80, 88, 96, 100,
    51, 60, 72, 80, 88, 96, 100, 102),
    intArrayOf(12, 9, 8, 12, 18, 30, 38, 45,
    8, 9, 11, 14, 20, 38, 45, 54,
    11, 10, 12, 18, 30, 38, 45, 54,
    11, 13, 17, 22, 38, 45, 54, 60,
    14, 17, 28, 38, 45, 54, 60, 66,
    18, 26, 38, 45, 54, 60, 66, 72,
    37, 38, 45, 54, 60, 66, 72, 75,
    38, 45, 54, 60, 66, 72, 75, 77),
    intArrayOf(10, 7, 6, 10, 15, 25, 32, 38,
    7, 7, 9, 12, 16, 32, 38, 45,
    9, 8, 10, 15, 25, 32, 38, 45,
    9, 11, 14, 18, 32, 38, 45, 50,
    12, 14, 23, 32, 38, 45, 50, 55,
    15, 22, 32, 38, 45, 50, 55, 60,
    31, 32, 38, 45, 50, 55, 60, 63,
    32, 38, 45, 50, 55, 60, 63, 65),
    intArrayOf(8, 6, 5, 8, 12, 20, 26, 30,
    6, 6, 7, 10, 13, 26, 30, 36,
    7, 7, 8, 12, 20, 26, 30, 36,
    7, 9, 11, 15, 26, 30, 36, 40,
    10, 11, 19, 26, 30, 36, 40, 44,
    12, 17, 26, 30, 36, 40, 44, 48,
    25, 26, 30, 36, 40, 44, 48, 50,
    26, 30, 36, 40, 44, 48, 50, 52),
    // Quality 7 (highest)
    intArrayOf(2, 1, 1, 2, 3, 5, 6, 7,
    1, 1, 1, 2, 3, 6, 7, 9,
    1, 1, 2, 3, 5, 6, 7, 9,
    1, 2, 3, 4, 6, 7, 9, 10,
    2, 3, 5, 6, 7, 9, 10, 11,
    3, 4, 6, 7, 9, 10, 11, 12,
    6, 6, 7, 9, 10, 11, 12, 13,
    6, 7, 9, 10, 11, 12, 13, 13)
    )

    /**
     * Hardware-accelerated TEV frame decoder
     * Decodes compressed TEV block data directly to framebuffer
     * 
     * @param blockDataPtr Pointer to decompressed TEV block data
     * @param rgPlaneAddr Address of RG plane in memory (can target the graphics hardware)
     * @param baPlaneAddr Address of BA plane in memory (can target the graphics hardware)
     * @param width Frame width in pixels
     * @param height Frame height in pixels
     * @param prevRGAddr Previous frame RG plane (for motion compensation)
     * @param prevBAAddr Previous frame BA plane (for motion compensation)
     */
    fun tevDecode(blockDataPtr: Long, rgPlaneAddr: Long, baPlaneAddr: Long, 
                  width: Int, height: Int, quality: Int, prevRGAddr: Long, prevBAAddr: Long) {

        assert(rgPlaneAddr * baPlaneAddr >= 0) { "RG and BA plane must be on a same memory scope (got $rgPlaneAddr, $baPlaneAddr)" }
        assert(prevRGAddr * prevBAAddr >= 0) { "Prev RG and BA plane must be on a same memory scope (got $prevRGAddr, $prevBAAddr)" }

        val blocksX = (width + 7) / 8
        val blocksY = (height + 7) / 8
        
        val quantTable = QUANT_TABLES[quality]
        
        var readPtr = blockDataPtr

        // decide increment "direction" by the sign of the pointer
        val prevAddrIncVec = if (prevRGAddr >= 0) 1 else -1
        val thisAddrIncVec = if (rgPlaneAddr >= 0) 1 else -1

        for (by in 0 until blocksY) {
            for (bx in 0 until blocksX) {
                val startX = bx * 8
                val startY = by * 8
                
                // Read TEV block header (7 bytes)
                val mode = vm.peek(readPtr)!!.toInt() and 0xFF
                val mvX = ((vm.peek(readPtr + 1)!!.toInt() and 0xFF) or 
                          ((vm.peek(readPtr + 2)!!.toInt() and 0xFF) shl 8)).toShort().toInt()
                val mvY = ((vm.peek(readPtr + 3)!!.toInt() and 0xFF) or 
                          ((vm.peek(readPtr + 4)!!.toInt() and 0xFF) shl 8)).toShort().toInt()
                readPtr += 7 // Skip CBP field
                
                // Read DCT coefficients (3 channels × 64 coefficients × 2 bytes)
                val dctCoeffs = IntArray(3 * 64)
                for (i in 0 until 3 * 64) {
                    val coeff = ((vm.peek(readPtr)!!.toInt() and 0xFF) or 
                                ((vm.peek(readPtr + 1)!!.toInt() and 0xFF) shl 8)).toShort().toInt()
                    dctCoeffs[i] = coeff
                    readPtr += 2
                }
                
                when (mode) {
                    0x00 -> { // TEV_MODE_SKIP - copy from previous frame
                        for (dy in 0 until 8) {
                            for (dx in 0 until 8) {
                                val x = startX + dx
                                val y = startY + dy
                                if (x < width && y < height) {
                                    val offset = y.toLong() * width + x
                                    val prevRG = vm.peek(prevRGAddr + offset*prevAddrIncVec)!!.toInt() and 0xFF
                                    val prevBA = vm.peek(prevBAAddr + offset*prevAddrIncVec)!!.toInt() and 0xFF
                                    vm.poke(rgPlaneAddr + offset*thisAddrIncVec, prevRG.toByte())
                                    vm.poke(baPlaneAddr + offset*thisAddrIncVec, prevBA.toByte())
                                }
                            }
                        }
                    }
                    
                    0x03 -> { // TEV_MODE_MOTION - motion compensation
                        for (dy in 0 until 8) {
                            for (dx in 0 until 8) {
                                val x = startX + dx
                                val y = startY + dy
                                val refX = x + mvX
                                val refY = y + mvY
                                
                                if (x < width && y < height) {
                                    val dstOffset = y.toLong() * width + x
                                    
                                    if (refX in 0 until width && refY in 0 until height) {
                                        val refOffset = refY.toLong() * width + refX
                                        val refRG = vm.peek(prevRGAddr + refOffset*prevAddrIncVec)!!.toInt() and 0xFF
                                        val refBA = vm.peek(prevBAAddr + refOffset*prevAddrIncVec)!!.toInt() and 0xFF
                                        vm.poke(rgPlaneAddr + dstOffset*thisAddrIncVec, refRG.toByte())
                                        vm.poke(baPlaneAddr + dstOffset*thisAddrIncVec, refBA.toByte())
                                    } else {
                                        // Out of bounds - use black
                                        vm.poke(rgPlaneAddr + dstOffset*thisAddrIncVec, 0.toByte())
                                        vm.poke(baPlaneAddr + dstOffset*thisAddrIncVec, 15.toByte()) // Alpha=15
                                    }
                                }
                            }
                        }
                    }
                    
                    else -> { // TEV_MODE_INTRA (0x01) or TEV_MODE_INTER (0x02) - DCT decode
                        // Extract DC coefficients and dequantize
                        val rDC = dctCoeffs[0 * 64 + 0] // R channel DC
                        val gDC = dctCoeffs[1 * 64 + 0] // G channel DC  
                        val bDC = dctCoeffs[2 * 64 + 0] // B channel DC
                        
                        // Convert DC to RGB (add 128 offset)
                        val r = kotlin.math.max(0, kotlin.math.min(255, rDC + 128))
                        val g = kotlin.math.max(0, kotlin.math.min(255, gDC + 128))
                        val b = kotlin.math.max(0, kotlin.math.min(255, bDC + 128))
                        
                        // Convert to 4-bit 4096-color format
                        val r4 = kotlin.math.max(0, kotlin.math.min(15, (r * 15 / 255)))
                        val g4 = kotlin.math.max(0, kotlin.math.min(15, (g * 15 / 255)))
                        val b4 = kotlin.math.max(0, kotlin.math.min(15, (b * 15 / 255)))
                        
                        val rgValue = (r4 shl 4) or g4      // R in MSB, G in LSB  
                        val baValue = (b4 shl 4) or 15      // B in MSB, A=15 (opaque) in LSB
                        
                        // Fill 8x8 block
                        for (dy in 0 until 8) {
                            for (dx in 0 until 8) {
                                val x = startX + dx
                                val y = startY + dy
                                if (x < width && y < height) {
                                    val offset = y.toLong() * width + x
                                    vm.poke(rgPlaneAddr + offset*thisAddrIncVec, rgValue.toByte())
                                    vm.poke(baPlaneAddr + offset*thisAddrIncVec, baValue.toByte())
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}