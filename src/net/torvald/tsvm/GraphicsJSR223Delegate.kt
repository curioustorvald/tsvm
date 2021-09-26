package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.peripheral.fmod

class GraphicsJSR223Delegate(val vm: VM) {

    private fun getFirstGPU(): GraphicsAdapter? {
        return vm.findPeribyType(VM.PERITYPE_GPU_AND_TERM)?.peripheral as? GraphicsAdapter
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

    fun scrollFrame(xdelta: Int, ydelta: Int) {
        getFirstGPU()?.let {
            it.framebufferScrollX = (it.framebufferScrollX + xdelta) fmod it.framebuffer.width
            it.framebufferScrollY = (it.framebufferScrollY + ydelta) fmod it.framebuffer.height
        }
    }

    fun setLineOffset(line: Int, offset: Int) {
        getFirstGPU()?.let {
            it.poke(250900L + 2*line, offset.shr(8).toByte()) // absolutely not USHR
            it.poke(250901L + 2*line, offset.toByte())
        }
    }

    fun getLineOffset(line: Int): Int {
        getFirstGPU()?.let {
            var xoff = it.peek(250900L + 2*line)!!.toUint().shl(8) or it.peek(250901L + 2*line)!!.toUint()
            if (xoff.and(0x8000) != 0) xoff = xoff or 0xFFFF0000.toInt()
            return xoff
        }
        return 0
    }

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
        getFirstGPU()?.let {
            it.setCursorPos(cy - 1, cx - 1)
        }
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
        getFirstGPU()?.let {
            it.putChar(cx - 1, cy - 1, c.toByte())
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


}