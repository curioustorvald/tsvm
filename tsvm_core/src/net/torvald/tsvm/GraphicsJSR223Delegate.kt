package net.torvald.tsvm

import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.math.MathUtils.floor
import com.badlogic.gdx.math.MathUtils.round
import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.peripheral.fmod
import kotlin.math.roundToInt

class GraphicsJSR223Delegate(val vm: VM) {

    private fun getFirstGPU(): GraphicsAdapter? {
        return vm.findPeribyType(VM.PERITYPE_GPU_AND_TERM)?.peripheral as? GraphicsAdapter
    }

    fun getVramSize() {
        getFirstGPU()?.mmio_read(11)
    }

    fun resetPalette() {
        getFirstGPU()?.poke(250883L, 1)
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
        }
    }

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
        }
    }

    fun getFramebufferScroll(): IntArray {
        getFirstGPU()?.let { return intArrayOf(it.framebufferScrollX, it.framebufferScrollY) }
        return intArrayOf(0, 0)
    }

    fun scrollFrame(xdelta: Int, ydelta: Int) {
        getFirstGPU()?.let {
            it.framebufferScrollX = (it.framebufferScrollX + xdelta) fmod it.framebuffer.width
            it.framebufferScrollY = (it.framebufferScrollY + ydelta) fmod it.framebuffer.height
        }
    }

    fun setLineOffset(line: Int, offset: Int) {
        getFirstGPU()?.let {
            it.scanlineOffsets[2L * line] = offset.toByte()
            it.scanlineOffsets[2L * line + 1] = offset.shr(8).toByte() // absolutely not USHR
        }
    }

    fun getLineOffset(line: Int): Int {
        getFirstGPU()?.let {
            var xoff = it.scanlineOffsets[2L * line].toUint() or it.scanlineOffsets[2L * line + 1].toUint().shl(8)
            if (xoff.and(0x8000) != 0) xoff = xoff or 0xFFFF0000.toInt()
            return xoff
        }
        return 0
    }

    fun setGraphicsMode(mode: Int) {
        getFirstGPU()?.mmio_write(12L, mode.toByte())
    }

    fun getGraphicsMode() = getFirstGPU()?.mmio_read(12L)?.toUint() ?: 0

    fun getPixelDimension(): IntArray {
        getFirstGPU()?.let { return intArrayOf(it.framebuffer.width, it.framebuffer.height) }
        return intArrayOf(-1, -1)
    }

    fun getTermDimension(): IntArray {
        getFirstGPU()?.let { return intArrayOf(it.TEXT_ROWS, it.TEXT_COLS) }
        return intArrayOf(-1, -1)
    }

    fun getCursorYX(): IntArray {
        getFirstGPU()?.let {
            val (cx, cy) = it.getCursorPos()
            return intArrayOf(cy + 1, cx + 1)
        }
        return intArrayOf(-1, -1)
    }

    fun setCursorYX(cy: Int, cx: Int) {
        getFirstGPU()?.setCursorPos(cx - 1, cy - 1)
    }


    fun setBackground(r: Int, g: Int, b: Int) {
        getFirstGPU()?.let {
            it.poke(250880, r.toByte())
            it.poke(250881, g.toByte())
            it.poke(250882, b.toByte())
        }
    }

    fun clearText() {
        getFirstGPU()?.eraseInDisp(2)
    }

    fun clearPixels(col: Int) {
        getFirstGPU()?.poke(250884L, col.toByte())
        getFirstGPU()?.poke(250883L, 2)
    }

    /**
     * prints a char as-is; won't interpret them as an escape sequence
     */
    fun putSymbol(c: Int) {
        getFirstGPU()?.let {
            val (cx, cy) = it.getCursorPos()


            it.putChar(cx, cy, c.toByte())
        }
    }

    fun putSymbolAt(cy: Int, cx: Int, c: Int) {
        getFirstGPU()?.putChar(cx - 1, cy - 1, c.toByte())
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

        val outData = ByteArray(pixmap.pixels.capacity())
        val destPixmapPtr = vm.malloc(outData.size)
        pixmap.pixels.position(0)
        pixmap.pixels.get(outData)
        pixmap.pixels.position(0)
        pixmap.dispose()

        UnsafeHelper.memcpyRaw(outData, UnsafeHelper.getArrayOffset(outData), null, vm.usermem.ptr + destPixmapPtr, outData.size.toLong())
        return intArrayOf(width, height, destPixmapPtr)
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

        val outData = ByteArray(pixmap.pixels.capacity())
        pixmap.pixels.position(0)
        pixmap.pixels.get(outData)
        pixmap.pixels.position(0)
        pixmap.dispose()

        UnsafeHelper.memcpyRaw(outData, UnsafeHelper.getArrayOffset(outData), null, vm.usermem.ptr + destPixmapPtr, outData.size.toLong())
        return intArrayOf(width, height, destPixmapPtr)
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

        if (width <= -1.0 && height <= -1.0 && gpu != null) {
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
        pixmap.pixels.position(0)
        pixmap.pixels.get(outData)
        pixmap.pixels.position(0)
        pixmap.dispose()
        inPixmap.dispose()

        UnsafeHelper.memcpyRaw(outData, UnsafeHelper.getArrayOffset(outData), null, vm.usermem.ptr + destPixmapPtr, outData.size.toLong())
        return intArrayOf(width, height, destPixmapPtr)
    }

    fun decodeImageResampleTo(srcFilePtr: Int, srcFileLen: Int, width0: Int, height0: Int, destPixmapPtr: Int): IntArray {
        var width = width0
        var height = height0


        val data = ByteArray(srcFileLen)
        UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + srcFilePtr, data, UnsafeHelper.getArrayOffset(data), srcFileLen.toLong())

        val inPixmap = Pixmap(data, 0, data.size)
        val gpu = getFirstGPU()

        if (width <= -1.0 && height <= -1.0 && gpu != null) {
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
        pixmap.pixels.position(0)
        pixmap.pixels.get(outData)
        pixmap.pixels.position(0)
        pixmap.dispose()
        inPixmap.dispose()

        UnsafeHelper.memcpyRaw(outData, UnsafeHelper.getArrayOffset(outData), null, vm.usermem.ptr + destPixmapPtr, outData.size.toLong())
        return intArrayOf(width, height, destPixmapPtr)
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

    private val bayerKernel = intArrayOf(
        0,8,2,10,
        12,4,14,6,
        3,11,1,9,
        15,7,13,5,
    ).map { (it.toFloat() + 0.5f) / 16f }.toFloatArray()

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
                val t = bayerKernel[4 * (y % 4) + (x % 4)]

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
            val srcimg = UnsafeHelper.allocate(width * height * 4L * channels) // array of floats!

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

}