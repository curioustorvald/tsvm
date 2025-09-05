package net.torvald.tsvm

import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.math.MathUtils.*
import com.badlogic.gdx.math.MathUtils.PI
import com.badlogic.gdx.math.MathUtils.ceil
import com.badlogic.gdx.math.MathUtils.floor
import com.badlogic.gdx.math.MathUtils.round
import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.peripheral.fmod
import kotlin.math.*

class GraphicsJSR223Delegate(private val vm: VM) {
    
    // Reusable working arrays to reduce allocation overhead
    private val idctTempBuffer = FloatArray(64)
    private val idct16TempBuffer = FloatArray(256) // For 16x16 IDCT
    private val idct16SeparableBuffer = FloatArray(256) // For separable 16x16 IDCT
    

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

    fun jpeg_quality_to_mult(q: Int): Float {
        return (if ((q < 50)) 5000f / q else 200f - 2 * q) / 100f
    }

    // Quality settings for quantization (Y channel) - 16x16 tables
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

    // Quality settings for quantization (Co channel - orange-blue, 8x8)
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
     */
    fun uploadRGBToFramebuffer(rgbAddr: Long, width: Int, height: Int, frameCounter: Int) {
        val gpu = (vm.peripheralTable[1].peripheral as GraphicsAdapter)

        val rgbAddrIncVec = if (rgbAddr >= 0) 1 else -1

        // Get native resolution
        val nativeWidth = gpu.config.width
        val nativeHeight = gpu.config.height
        
        // Calculate centering offset
        val offsetX = (nativeWidth - width) / 2
        val offsetY = (nativeHeight - height) / 2

        val totalNativePixels = (nativeWidth * nativeHeight).toLong()

        // Process video pixels in 8KB chunks to balance memory usage and performance
        val totalVideoPixels = width * height
        val chunkSize = 8192
        val rgChunk = ByteArray(chunkSize)
        val baChunk = ByteArray(chunkSize)
        val positionChunk = IntArray(chunkSize) // Store framebuffer positions
        
        var pixelsProcessed = 0
        
        while (pixelsProcessed < totalVideoPixels) {
            val pixelsInChunk = kotlin.math.min(chunkSize, totalVideoPixels - pixelsProcessed)
            
            // Batch process chunk of pixels
            for (i in 0 until pixelsInChunk) {
                val pixelIndex = pixelsProcessed + i
                val videoY = pixelIndex / width
                val videoX = pixelIndex % width
                
                // Calculate position in native framebuffer (centered)
                val nativeX = videoX + offsetX
                val nativeY = videoY + offsetY
                val nativePos = nativeY * nativeWidth + nativeX
                positionChunk[i] = nativePos
                
                val rgbOffset = (pixelIndex.toLong() * 3) * rgbAddrIncVec

                // Read RGB values (3 peek operations per pixel - still the bottleneck)
                val r = vm.peek(rgbAddr + rgbOffset)!!.toUint()
                val g = vm.peek(rgbAddr + rgbOffset + rgbAddrIncVec)!!.toUint()
                val b = vm.peek(rgbAddr + rgbOffset + rgbAddrIncVec * 2)!!.toUint()

                // Apply Bayer dithering and convert to 4-bit
                val r4 = ditherValue(r, videoX, videoY, frameCounter)
                val g4 = ditherValue(g, videoX, videoY, frameCounter)
                val b4 = ditherValue(b, videoX, videoY, frameCounter)

                // Pack and store in chunk buffers
                rgChunk[i] = ((r4 shl 4) or g4).toByte()
                baChunk[i] = ((b4 shl 4) or 15).toByte()
            }
            
            // Write pixels to their calculated positions in framebuffer
            for (i in 0 until pixelsInChunk) {
                val pos = positionChunk[i].toLong()
                // Bounds check to ensure we don't write outside framebuffer
                if (pos in 0 until totalNativePixels) {
                    UnsafeHelper.memcpyRaw(
                        rgChunk, UnsafeHelper.getArrayOffset(rgChunk) + i,
                        null, gpu.framebuffer.ptr + pos, 1L)
                    UnsafeHelper.memcpyRaw(
                        baChunk, UnsafeHelper.getArrayOffset(baChunk) + i,
                        null, gpu.framebuffer2!!.ptr + pos, 1L)
                }
            }

            pixelsProcessed += pixelsInChunk
        }
    }

    /**
     * Apply Bayer dithering to reduce banding when quantizing to 4-bit
     */
    private fun ditherValue(value: Int, x: Int, y: Int, f: Int): Int {
        // Preserve pure values (0 and 255) exactly to maintain color primaries
        if (value == 0) return 0
        if (value == 255) return 15
        
        val t = bayerKernels[f % 4][4 * (y % 4) + (x % 4)] // use rotating bayerKernel to time-dither the static pattern for even better visuals
        val q = floor((t / 15f + (value / 255f)) * 15f) / 15f
        return round(15f * q)
    }


    val dctBasis8 = Array(8) { u ->
        FloatArray(8) { x ->
            val cu = if (u == 0) 1.0 / sqrt(2.0) else 1.0
            (0.5 * cu * cos((2.0 * x + 1.0) * u * PI / 16.0)).toFloat()
        }
    }

    private fun tevIdct8x8_fast(coeffs: ShortArray, quantTable: FloatArray, isChromaResidual: Boolean = false, mult: Float = 1f): IntArray {
        val result = IntArray(64)
        // Reuse preallocated temp buffer to reduce GC pressure

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
                        coeffs[coeffIdx] * quantTable[coeffIdx] * mult
                    }
                    sum += dctBasis8[u][col] * coeff
                }
                idctTempBuffer[row * 8 + col] = sum
            }
        }

        // Second pass: Process columns (8 1D IDCTs)
        for (col in 0 until 8) {
            for (row in 0 until 8) {
                var sum = 0f
                for (v in 0 until 8) {
                    sum += dctBasis8[v][row] * idctTempBuffer[v * 8 + col]
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
    
    // 16x16 IDCT for Y channel (YCoCg-R format)
    private fun tevIdct16x16_fast(coeffs: ShortArray, quantTable: FloatArray, mult: Float = 1.0f): IntArray {
        val result = IntArray(256) // 16x16 = 256
        
        // Process coefficients and dequantize using preallocated buffer
        for (u in 0 until 16) {
            for (v in 0 until 16) {
                val idx = u * 16 + v
                val coeff = if (idx == 0) {
                    coeffs[idx].toFloat() // DC lossless for luma
                } else {
                    coeffs[idx] * quantTable[idx] * mult
                }
                idct16TempBuffer[idx] = coeff
            }
        }
        
        // Fast separable IDCT: 8x performance improvement - but causes 90° rotation!
        // First pass: Process rows (16 1D IDCTs)
        for (row in 0 until 16) {
            for (col in 0 until 16) {
                var sum = 0f
                for (u in 0 until 16) {
                    sum += dctBasis16[u][col] * idct16TempBuffer[row * 16 + u]
                }
                idct16SeparableBuffer[row * 16 + col] = sum
            }
        }
        
        // Second pass: Process columns (16 1D IDCTs)  
        for (col in 0 until 16) {
            for (row in 0 until 16) {
                var sum = 0f
                for (v in 0 until 16) {
                    sum += dctBasis16[v][row] * idct16SeparableBuffer[v * 16 + col]
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
     * Extract a specific field (even or odd lines) from a progressive frame
     * Used for temporal prediction in Yadif deinterlacing
     */
    private fun extractFieldFromProgressive(progressiveAddr: Long, fieldAddr: Long, width: Int, height: Int, 
                                           fieldParity: Int, addrIncVec: Int) {
        assert(addrIncVec == 1)

        val fieldHeight = height / 2
        for (y in 0 until fieldHeight) {
            val progressiveY = y * 2 + fieldParity // Extract even (0) or odd (1) lines
            val progressiveOffset = (progressiveY * width) * 3
            val fieldOffset = (y * width) * 3

            vm.memcpy(progressiveAddr.toInt() + progressiveOffset, fieldAddr.toInt() + fieldOffset, width * 3)
        }
    }
    
    /**
     * YADIF (Yet Another Deinterlacing Filter) implementation
     * Converts interlaced field to progressive frame with temporal/spatial interpolation
     */
    fun yadifDeinterlace(fieldRGBAddr: Long, outputRGBAddr: Long, width: Int, height: Int, 
                        prevFieldAddr: Long, nextFieldAddr: Long, fieldParity: Int, 
                        fieldIncVec: Int, outputIncVec: Int) {

        val fieldHeight = height / 2
        
        for (y in 0 until fieldHeight) {
            for (x in 0 until width) {
                // fieldRGBAddr now contains sequential field data from extractFieldFromProgressive
                val fieldOffset = (y * width + x) * 3
                val outputOffset = ((y * 2 + fieldParity) * width + x) * 3
                
                // Copy current field lines directly (no interpolation needed) with loop unrolling
                vm.poke(outputRGBAddr + (outputOffset + 0) * outputIncVec, vm.peek(fieldRGBAddr + (fieldOffset + 0) * fieldIncVec)!!)
                vm.poke(outputRGBAddr + (outputOffset + 1) * outputIncVec, vm.peek(fieldRGBAddr + (fieldOffset + 1) * fieldIncVec)!!)
                vm.poke(outputRGBAddr + (outputOffset + 2) * outputIncVec, vm.peek(fieldRGBAddr + (fieldOffset + 2) * fieldIncVec)!!)

                // Interpolate missing lines using Yadif algorithm
                // Even field (0,2,4...) interpolates odd lines (1,3,5...)
                // Odd field (1,3,5...) interpolates even lines (2,4,6...) - skip line 0!
                if (y > 0 && y < fieldHeight - 1) {
                    // Even field: interpolate odd progressive lines (1,3,5...)
                    // Odd field: interpolate even progressive lines (2,4,6...)
                    val interpLine = y * 2 + (1 - fieldParity)

                    // Skip interpolation if the line would be out of bounds
                    if (interpLine < height) {
                        val interpOutputOffset = (interpLine * width + x) * 3
                    
                        for (c in 0..2) {
                            // Get spatial neighbors from sequential field data
                            val fieldStride = width * 3
                            val aboveOffset = fieldOffset - fieldStride + c
                            val belowOffset = fieldOffset + fieldStride + c
                            val currentOffset = fieldOffset + c
                            
                            // Ensure we don't read out of bounds
                            val above = if (y > 0) {
                                vm.peek(fieldRGBAddr + aboveOffset * fieldIncVec)!!.toInt() and 0xFF
                            } else {
                                // Use current pixel for top edge
                                vm.peek(fieldRGBAddr + currentOffset * fieldIncVec)!!.toInt() and 0xFF
                            }
                            
                            val below = if (y < fieldHeight - 1) {
                                vm.peek(fieldRGBAddr + belowOffset * fieldIncVec)!!.toInt() and 0xFF
                            } else {
                                // Use current pixel for bottom edge  
                                vm.peek(fieldRGBAddr + currentOffset * fieldIncVec)!!.toInt() and 0xFF
                            }
                            
                            val current = vm.peek(fieldRGBAddr + currentOffset * fieldIncVec)!!.toInt() and 0xFF

                            // Spatial interpolation
                            val spatialInterp = (above + below) / 2

                            // Temporal prediction using previous and next fields
                            var temporalPred = spatialInterp
                            if (prevFieldAddr != 0L && nextFieldAddr != 0L) {
                                // Get temporal neighbors from same spatial position
                                val tempFieldOffset = (y * width + x) * 3 + c  // Compact field addressing
                                val prevPixel = (vm.peek(prevFieldAddr + tempFieldOffset * fieldIncVec)?.toInt() ?: current) and 0xFF
                                val nextPixel = (vm.peek(nextFieldAddr + tempFieldOffset * fieldIncVec)?.toInt() ?: current) and 0xFF

                                // Simple temporal interpolation
                                val tempInterp = (prevPixel + nextPixel) / 2

                                // Yadif edge-directed temporal-spatial decision
                                val spatialDiff = kotlin.math.abs(above - below)
                                val temporalDiff = kotlin.math.abs(prevPixel - nextPixel)

                                // Choose between spatial and temporal prediction based on local characteristics
                                temporalPred = when {
                                    spatialDiff < 32 && temporalDiff < 32 -> {
                                        // Low spatial and temporal variation: blend all
                                        (spatialInterp + tempInterp + current) / 3
                                    }
                                    spatialDiff < temporalDiff -> {
                                        // Prefer spatial interpolation
                                        (spatialInterp * 3 + tempInterp) / 4
                                    }
                                    else -> {
                                        // Prefer temporal interpolation
                                        (tempInterp * 3 + spatialInterp) / 4
                                    }
                                }
                            }

                            // Final edge-directed filtering
                            val finalValue = if (kotlin.math.abs(above - below) < 16) {
                                (current + temporalPred) / 2  // Very low edge activity: blend with current
                            } else {
                                temporalPred  // Higher edge activity: use prediction
                            }

                            vm.poke(outputRGBAddr + (interpOutputOffset + c) * outputIncVec,
                                   finalValue.coerceIn(0, 255).toByte())
                        }
                    }
                }
            }
        }

        // cover up top two and bottom two lines with current border colour
        val destT = 0
        val destB = (height - 2) * width * 3
        val col = (vm.peek(-1299457)!!.toUint() shl 16) or (vm.peek(-1299458)!!.toUint() shl 8) or vm.peek(-1299459)!!.toUint()
        vm.memsetI24(outputRGBAddr.toInt() + destT, col, width * 6)
        vm.memsetI24(outputRGBAddr.toInt() + destB, col, width * 6)
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
                            // Get spatial neighbors from sequential field data
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
                                // Get temporal neighbors
                                val tempFieldOffset = (y * width + x) * 3 + c
                                val prevPixel = (vm.peek(prevFieldAddr + tempFieldOffset * fieldIncVec)?.toInt() ?: current) and 0xFF
                                val nextPixel = (vm.peek(nextFieldAddr + tempFieldOffset * fieldIncVec)?.toInt() ?: current) and 0xFF
                                
                                // BWDIF-inspired temporal differences (adapted for 3-frame window)
                                // Note: True BWDIF uses 5 frames, we adapt to 3-frame constraint
                                
                                // Get spatial neighbors from previous and next fields for temporal comparison
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
    
    // XYB conversion constants from JPEG XL specification
    private val XYB_BIAS = 0.00379307325527544933
    private val CBRT_BIAS = 0.155954200549248620 // cbrt(XYB_BIAS)
    
    // RGB to LMS mixing coefficients  
    private val RGB_TO_LMS = arrayOf(
        doubleArrayOf(0.3, 0.622, 0.078),                           // L coefficients
        doubleArrayOf(0.23, 0.692, 0.078),                          // M coefficients  
        doubleArrayOf(0.24342268924547819, 0.20476744424496821, 0.55180986650955360)  // S coefficients
    )
    
    // LMS to RGB inverse matrix
    private val LMS_TO_RGB = arrayOf(
        doubleArrayOf(11.0315669046, -9.8669439081, -0.1646229965),
        doubleArrayOf(-3.2541473811, 4.4187703776, -0.1646229965),
        doubleArrayOf(-3.6588512867, 2.7129230459, 1.9459282408)
    )
    
    // sRGB linearization functions
    private fun srgbLinearise(value: Double): Double {
        return if (value > 0.04045) {
            Math.pow((value + 0.055) / 1.055, 2.4)
        } else {
            value / 12.92
        }
    }
    
    private fun srgbUnlinearise(value: Double): Double {
        return if (value > 0.0031308) {
            1.055 * Math.pow(value, 1.0 / 2.4) - 0.055
        } else {
            value * 12.92
        }
    }
    
    // XYB to RGB conversion for hardware decoding
    fun tevXybToRGB(yBlock: IntArray, xBlock: IntArray, bBlock: IntArray): IntArray {
        val rgbData = IntArray(16 * 16 * 3)  // R,G,B for 16x16 pixels
        
        for (py in 0 until 16) {
            for (px in 0 until 16) {
                val yIdx = py * 16 + px
                val y = yBlock[yIdx]
                
                // Get chroma values from subsampled 8x8 blocks (nearest neighbor upsampling)
                val xbIdx = (py / 2) * 8 + (px / 2)
                val x = xBlock[xbIdx]
                val b = bBlock[xbIdx]
                
                // Optimal range-based dequantization (exact inverse of improved quantization)
                val X_MIN = -0.016; val X_MAX = 0.030
                val xVal = (x / 255.0) * (X_MAX - X_MIN) + X_MIN  // X: inverse of range mapping
                val Y_MAX = 0.85
                val yVal = (y / 255.0) * Y_MAX                    // Y: inverse of improved scale
                val B_MAX = 0.85
                val bVal = ((b + 128.0) / 255.0) * B_MAX          // B: inverse of ((val/B_MAX*255)-128)
                
                // XYB to LMS gamma
                val lgamma = xVal + yVal
                val mgamma = yVal - xVal
                val sgamma = bVal
                
                // Remove gamma correction
                val lmix = (lgamma + CBRT_BIAS).pow(3.0) - XYB_BIAS
                val mmix = (mgamma + CBRT_BIAS).pow(3.0) - XYB_BIAS
                val smix = (sgamma + CBRT_BIAS).pow(3.0) - XYB_BIAS
                
                // LMS to linear RGB using inverse matrix
                val rLinear = (LMS_TO_RGB[0][0] * lmix + LMS_TO_RGB[0][1] * mmix + LMS_TO_RGB[0][2] * smix).coerceIn(0.0, 1.0)
                val gLinear = (LMS_TO_RGB[1][0] * lmix + LMS_TO_RGB[1][1] * mmix + LMS_TO_RGB[1][2] * smix).coerceIn(0.0, 1.0)
                val bLinear = (LMS_TO_RGB[2][0] * lmix + LMS_TO_RGB[2][1] * mmix + LMS_TO_RGB[2][2] * smix).coerceIn(0.0, 1.0)
                
                // Convert back to sRGB gamma and 0-255 range
                val r = (srgbUnlinearise(rLinear) * 255.0 + 0.5).toInt().coerceIn(0, 255)
                val g = (srgbUnlinearise(gLinear) * 255.0 + 0.5).toInt().coerceIn(0, 255)
                val bRgb = (srgbUnlinearise(bLinear) * 255.0 + 0.5).toInt().coerceIn(0, 255)
                
                // Store RGB
                val baseIdx = (py * 16 + px) * 3
                rgbData[baseIdx] = r     // R
                rgbData[baseIdx + 1] = g // G
                rgbData[baseIdx + 2] = bRgb // B
            }
        }
        
        return rgbData
    }
    
    // RGB to XYB conversion for INTER mode residual calculation
    fun tevRGBToXyb(rgbBlock: IntArray): IntArray {
        val xybData = IntArray(16 * 16 * 3)  // Y,X,B for 16x16 pixels
        
        for (py in 0 until 16) {
            for (px in 0 until 16) {
                val baseIdx = (py * 16 + px) * 3
                val r = rgbBlock[baseIdx]
                val g = rgbBlock[baseIdx + 1]
                val b = rgbBlock[baseIdx + 2]
                
                // Convert RGB to 0-1 range and linearise sRGB
                val rNorm = srgbLinearise(r / 255.0)
                val gNorm = srgbLinearise(g / 255.0)
                val bNorm = srgbLinearise(b / 255.0)
                
                // RGB to LMS mixing with bias
                val lmix = RGB_TO_LMS[0][0] * rNorm + RGB_TO_LMS[0][1] * gNorm + RGB_TO_LMS[0][2] * bNorm + XYB_BIAS
                val mmix = RGB_TO_LMS[1][0] * rNorm + RGB_TO_LMS[1][1] * gNorm + RGB_TO_LMS[1][2] * bNorm + XYB_BIAS
                val smix = RGB_TO_LMS[2][0] * rNorm + RGB_TO_LMS[2][1] * gNorm + RGB_TO_LMS[2][2] * bNorm + XYB_BIAS
                
                // Apply gamma correction (cube root)
                val lgamma = lmix.pow(1.0 / 3.0) - CBRT_BIAS
                val mgamma = mmix.pow(1.0 / 3.0) - CBRT_BIAS
                val sgamma = smix.pow(1.0 / 3.0) - CBRT_BIAS
                
                // LMS to XYB transformation
                val xVal = (lgamma - mgamma) / 2.0
                val yVal = (lgamma + mgamma) / 2.0
                val bVal = sgamma
                
                // Optimal range-based quantization for XYB values (improved precision)
                // X: actual range -0.016 to +0.030, map to full 0-255 precision
                val X_MIN = -0.016; val X_MAX = 0.030
                val xQuant = (((xVal - X_MIN) / (X_MAX - X_MIN)) * 255.0).toInt().coerceIn(0, 255)
                // Y: range 0 to 0.85, map to 0 to 255 (improved scale)
                val Y_MAX = 0.85
                val yQuant = ((yVal / Y_MAX) * 255.0).toInt().coerceIn(0, 255)
                // B: range 0 to 0.85, map to -128 to +127 (optimized precision)
                val B_MAX = 0.85
                val bQuant = (((bVal / B_MAX) * 255.0) - 128.0).toInt().coerceIn(-128, 127)
                
                // Store XYB values
                val yIdx = py * 16 + px
                xybData[yIdx * 3] = yQuant     // Y
                xybData[yIdx * 3 + 1] = xQuant // X
                xybData[yIdx * 3 + 2] = bQuant // B
            }
        }
        
        return xybData
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
     * @param quality Quantization quality level (0-7)
     * @param frameCounter Frame counter for temporal patterns
     */
    fun tevDecode(blockDataPtr: Long, currentRGBAddr: Long, prevRGBAddr: Long,
                  width: Int, height: Int, qualityIndices: IntArray, frameCounter: Int,
                  debugMotionVectors: Boolean = false, tevVersion: Int = 2) {

        // height doesn't change when interlaced, because that's the encoder's output

        // For interlaced mode, decode to half-height field first
        val blocksX = (width + 15) / 16  // 16x16 blocks now
        val blocksY = (height + 15) / 16

        val quantYmult = jpeg_quality_to_mult(qualityIndices[0])
        val quantCOmult = jpeg_quality_to_mult(qualityIndices[1])
        val quantCGmult = jpeg_quality_to_mult(qualityIndices[2])
        val quantBmult = quantCGmult

        // Apply rate control factor to quantization tables (if not ~1.0, skip optimization)
        val quantTableY = QUANT_TABLE_Y.map { (it * quantYmult).coerceIn(1f, 255f) }.toFloatArray()
        val quantTableCo = QUANT_TABLE_C.map { (it * quantCOmult).coerceIn(1f, 255f) }.toFloatArray()
        val quantTableCg = QUANT_TABLE_C.map { (it * quantCGmult).coerceIn(1f, 255f) }.toFloatArray()
        val quantTableB = QUANT_TABLE_C.map { it * quantBmult.toFloat() }.toFloatArray()

        var readPtr = blockDataPtr

        // decide increment "direction" by the sign of the pointer  
        val prevAddrIncVec = if (prevRGBAddr >= 0) 1 else -1
        val thisAddrIncVec = if (currentRGBAddr >= 0) 1 else -1


        for (by in 0 until blocksY) {
            for (bx in 0 until blocksX) {
                val startX = bx * 16
                val startY = by * 16
                
                // Read TEV block header (7 bytes)
                val mode = vm.peek(readPtr)!!.toUint()
                val mvX = ((vm.peek(readPtr + 1)!!.toUint()) or 
                          ((vm.peek(readPtr + 2)!!.toUint()) shl 8)).toShort().toInt()
                val mvY = ((vm.peek(readPtr + 3)!!.toUint()) or 
                          ((vm.peek(readPtr + 4)!!.toUint()) shl 8)).toShort().toInt()
                val rateControlFactor = Float.fromBits((vm.peek(readPtr + 5)!!.toUint()) or
                        ((vm.peek(readPtr + 6)!!.toUint()) shl 8) or
                        ((vm.peek(readPtr + 7)!!.toUint()) shl 16) or
                        ((vm.peek(readPtr + 8)!!.toUint()) shl 24))
                readPtr += 11 // Skip CBP field
                
                
                when (mode) {
                    0x00 -> { // TEV_MODE_SKIP - copy RGB from previous frame (optimized with memcpy)
                        // Check if we can copy the entire block at once (no clipping)
                        if (startX + 16 <= width && startY + 16 <= height) {
                            // Optimized case: copy entire 16x16 block with row-by-row memcpy
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
                            // Fallback to pixel-by-pixel for boundary blocks
                            for (dy in 0 until 16) {
                                for (dx in 0 until 16) {
                                    val x = startX + dx
                                    val y = startY + dy
                                    if (x < width && y < height) {
                                        val pixelOffset = y.toLong() * width + x
                                        val rgbOffset = pixelOffset * 3
                                        
                                        // Copy RGB values from previous frame
                                        val prevR = vm.peek(prevRGBAddr + rgbOffset*prevAddrIncVec)!!
                                        val prevG = vm.peek(prevRGBAddr + (rgbOffset + 1)*prevAddrIncVec)!!
                                        val prevB = vm.peek(prevRGBAddr + (rgbOffset + 2)*prevAddrIncVec)!!
                                        
                                        vm.poke(currentRGBAddr + rgbOffset*thisAddrIncVec, prevR)
                                        vm.poke(currentRGBAddr + (rgbOffset + 1)*thisAddrIncVec, prevG)
                                        vm.poke(currentRGBAddr + (rgbOffset + 2)*thisAddrIncVec, prevB)
                                    }
                                }
                            }
                        }
                        // Skip DCT coefficients for fixed-size block format: Y(256×2) + Co(64×2) + Cg(64×2) = 768 bytes
                        readPtr += 768
                    }
                    
                    0x03 -> { // TEV_MODE_MOTION - motion compensation with RGB (optimized with memcpy)
                        if (debugMotionVectors) {
                            // Debug mode: use original pixel-by-pixel for motion vector visualization
                            for (dy in 0 until 16) {
                                for (dx in 0 until 16) {
                                    val x = startX + dx
                                    val y = startY + dy  
                                    val refX = x + mvX
                                    val refY = y + mvY
                                    
                                    if (x < width && y < height) {
                                        val dstPixelOffset = y.toLong() * width + x
                                        val dstRgbOffset = dstPixelOffset * 3
                                        
                                        // Debug: Color INTER blocks by motion vector magnitude
                                        val mvMagnitude = kotlin.math.sqrt((mvX * mvX + mvY * mvY).toDouble()).toInt()
                                        val intensity = (mvMagnitude * 8).coerceIn(0, 255) // Scale for visibility

                                        vm.poke(currentRGBAddr + dstRgbOffset*thisAddrIncVec, intensity.toByte())        // R = MV magnitude
                                        vm.poke(currentRGBAddr + (dstRgbOffset + 1)*thisAddrIncVec, 0.toByte())         // G = 0
                                        vm.poke(currentRGBAddr + (dstRgbOffset + 2)*thisAddrIncVec, (255-intensity).toByte()) // B = inverse
                                    }
                                }
                            }
                        } else {
                            // Optimized motion compensation
                            val refStartX = startX + mvX
                            val refStartY = startY + mvY
                            
                            // Check if entire 16x16 block can be copied with memcpy (no bounds issues)
                            if (startX + 16 <= width && startY + 16 <= height &&
                                refStartX >= 0 && refStartY >= 0 && refStartX + 16 <= width && refStartY + 16 <= height) {
                                
                                // Optimized case: copy entire 16x16 block with row-by-row memcpy
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
                        // Read DCT coefficients: Y (16x16=256), Co (8x8=64), Cg (8x8=64)

                        // Optimized bulk reading of all DCT coefficients: Y(256×2) + Co(64×2) + Cg(64×2) = 768 bytes
                        val coeffShortArray = ShortArray(384) // Total coefficients: 256 + 64 + 64 = 384 shorts
                        vm.bulkPeekShort(readPtr.toInt(), coeffShortArray, 768)
                        readPtr += 768
                        
                        // Perform hardware IDCT for each channel using fast algorithm
                        val yBlock = tevIdct16x16_fast(coeffShortArray.sliceArray(0 until 256), quantTableY, rateControlFactor)
                        val coBlock = tevIdct8x8_fast(coeffShortArray.sliceArray(256 until 320), quantTableCo, true, rateControlFactor)
                        val cgBlock = tevIdct8x8_fast(coeffShortArray.sliceArray(320 until 384), if (tevVersion == 3) quantTableB else quantTableCg, true, rateControlFactor)
                        
                        // Convert to RGB (YCoCg-R for v2, XYB for v3)
                        val rgbData = if (tevVersion == 3) {
                            tevXybToRGB(yBlock, coBlock, cgBlock)  // XYB format (v3)
                        } else {
                            tevYcocgToRGB(yBlock, coBlock, cgBlock)  // YCoCg-R format (v2)
                        }
                        
                        // Store RGB data to frame buffer (complete replacement)
                        for (dy in 0 until 16) {
                            for (dx in 0 until 16) {
                                val x = startX + dx
                                val y = startY + dy
                                if (x < width && y < height) {
                                    val rgbIdx = (dy * 16 + dx) * 3
                                    val imageOffset = y.toLong() * width + x
                                    val bufferOffset = imageOffset * 3
                                    
                                    vm.poke(currentRGBAddr + bufferOffset*thisAddrIncVec, rgbData[rgbIdx].toByte())
                                    vm.poke(currentRGBAddr + (bufferOffset + 1)*thisAddrIncVec, rgbData[rgbIdx + 1].toByte()) 
                                    vm.poke(currentRGBAddr + (bufferOffset + 2)*thisAddrIncVec, rgbData[rgbIdx + 2].toByte())
                                }
                            }
                        }
                    }
                    
                    0x02 -> { // TEV_MODE_INTER - Motion compensation + residual DCT
                        // Step 1: Read residual DCT coefficients
                        
                        // Optimized bulk reading of all DCT coefficients: Y(256×2) + Co(64×2) + Cg(64×2) = 768 bytes
                        val coeffShortArray = ShortArray(384) // Total coefficients: 256 + 64 + 64 = 384 shorts
                        vm.bulkPeekShort(readPtr.toInt(), coeffShortArray, 768)
                        readPtr += 768
                        
                        // Step 2: Decode residual DCT
                        val yResidual = tevIdct16x16_fast(coeffShortArray.sliceArray(0 until 256), quantTableY, rateControlFactor)
                        val coResidual = tevIdct8x8_fast(coeffShortArray.sliceArray(256 until 320), quantTableCo, true, rateControlFactor)
                        val cgResidual = tevIdct8x8_fast(coeffShortArray.sliceArray(320 until 384), if (tevVersion == 3) quantTableB else quantTableCg, true, rateControlFactor)

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
                            tevXybToRGB(finalY, finalCo, finalCg)  // XYB format (v3)
                        } else {
                            tevYcocgToRGB(finalY, finalCo, finalCg)  // YCoCg-R format (v2)
                        }
                        
                        // Step 5: Store final RGB data to frame buffer
                        for (dy in 0 until 16) {
                            for (dx in 0 until 16) {
                                val x = startX + dx
                                val y = startY + dy
                                if (x < width && y < height) {
                                    val imageOffset = y.toLong() * width + x
                                    val bufferOffset = imageOffset * 3
                                    
                                    if (debugMotionVectors) {
                                        // Debug: Color INTER blocks by motion vector magnitude
                                        val mvMagnitude = kotlin.math.sqrt((mvX * mvX + mvY * mvY).toDouble()).toInt()
                                        val intensity = (mvMagnitude * 8).coerceIn(0, 255) // Scale for visibility
                                        
                                        vm.poke(currentRGBAddr + bufferOffset*thisAddrIncVec, intensity.toByte())        // R = MV magnitude
                                        vm.poke(currentRGBAddr + (bufferOffset + 1)*thisAddrIncVec, 0.toByte())         // G = 0
                                        vm.poke(currentRGBAddr + (bufferOffset + 2)*thisAddrIncVec, (255-intensity).toByte()) // B = inverse
                                    } else {
                                        val rgbIdx = (dy * 16 + dx) * 3
                                        val finalR = finalRgb[rgbIdx]
                                        val finalG = finalRgb[rgbIdx + 1]  
                                        val finalB = finalRgb[rgbIdx + 2]
                                        
                                        vm.poke(currentRGBAddr + bufferOffset*thisAddrIncVec, finalR.toByte())
                                        vm.poke(currentRGBAddr + (bufferOffset + 1)*thisAddrIncVec, finalG.toByte()) 
                                        vm.poke(currentRGBAddr + (bufferOffset + 2)*thisAddrIncVec, finalB.toByte())
                                    }
                                }
                            }
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

    fun tevDeinterlace(frameCounter: Int, width: Int, height: Int, prevField: Long, currentField: Long, nextField: Long, outputRGB: Long, algorithm: String = "yadif") {
        // Apply selected deinterlacing algorithm: field -> progressive frame
        val fieldParity = (frameCounter + 1) % 2

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



}