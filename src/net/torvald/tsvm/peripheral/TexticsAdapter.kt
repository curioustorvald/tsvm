package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM

class TexticsAdapter(vm: VM, lcdMode: Boolean = false, lcdInvert: Boolean = true) : GraphicsAdapter(vm, lcdMode, lcdInvert) {

    override fun peek(addr: Long): Byte? {
        return when (addr) {
            in 0 until 250880 -> (-1).toByte()
            else -> super.peek(addr)
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        when (addr) {
            in 0 until 250880 -> { /*do nothing*/ }
            else -> super.poke(addr, byte)
        }
    }

}