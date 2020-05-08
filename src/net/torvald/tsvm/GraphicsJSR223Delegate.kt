package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.tsvm.peripheral.GraphicsAdapter
import sun.nio.ch.DirectBuffer

class GraphicsJSR223Delegate(val vm: VM) {

    private fun getFirstGPU(): GraphicsAdapter? {
        return vm.peripheralTable[vm.findPeribyType("gpu") ?: return null].peripheral as? GraphicsAdapter
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

    private fun GraphicsAdapter._loadbulk(fromAddr: Int, toAddr: Int, length: Int) {
        if (toAddr < 250880) {
            UnsafeHelper.memcpy(
                vm.usermem.ptr + fromAddr,
                (this.framebuffer.pixels as DirectBuffer).address() + toAddr,
                length.toLong()
            )
        }
        else if (toAddr < 250972) {

        }
    }

}