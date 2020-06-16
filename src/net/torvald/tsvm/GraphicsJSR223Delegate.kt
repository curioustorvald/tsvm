package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.tsvm.peripheral.GraphicsAdapter
import sun.nio.ch.DirectBuffer

class GraphicsJSR223Delegate(val vm: VM) {

    private fun getFirstGPU(): GraphicsAdapter? {
        return vm.findPeribyType(VM.PERITYPE_TERM)?.peripheral as? GraphicsAdapter
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

    fun loadBulk(fromAddr: Int, toAddr: Int, length: Int) {
        getFirstGPU()?.let {
            it._loadbulk(fromAddr, toAddr, length)
        }
    }

    fun storeBulk(fromAddr: Int, toAddr: Int, length: Int) {
        getFirstGPU()?.let {
            it._storebulk(fromAddr, toAddr, length)
        }
    }

    fun plotPixel(x: Int, y: Int, color: Byte) {
        getFirstGPU()?.let {
            if (x in 0 until GraphicsAdapter.WIDTH && y in 0 until GraphicsAdapter.HEIGHT) {
                it.poke(y.toLong() * GraphicsAdapter.WIDTH + x, color)
            }
        }
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

    /**
     * prints a char as-is; won't interpret them as an escape sequence
     */
    fun putSymbol(char: Byte) {
        getFirstGPU()?.let {
            val (cx, cy) = it.getCursorPos()


            it.putChar(cx, cy, char)
            it.setCursorPos(cx + 1, cy)
        }
    }

    private fun GraphicsAdapter._loadbulk(fromAddr: Int, toAddr: Int, length: Int) {
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
    }

    private fun GraphicsAdapter._loadSprite(spriteNum: Int, ptr: Int) {
        UnsafeHelper.memcpy(
            vm.usermem.ptr + ptr,
            (this.spriteAndTextArea).ptr + (260 * spriteNum) + 4,
            256
        )
    }

    private fun GraphicsAdapter._storeSprite(spriteNum: Int, ptr: Int) {
        UnsafeHelper.memcpy(
            (this.spriteAndTextArea).ptr + (260 * spriteNum) + 4,
            vm.usermem.ptr + ptr,
            256
        )
    }


}