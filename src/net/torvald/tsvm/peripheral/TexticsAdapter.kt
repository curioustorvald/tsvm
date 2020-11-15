package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import net.torvald.tsvm.VM
import net.torvald.tsvm.kB

class TexticsAdapter(vm: VM, theme: String) : GraphicsAdapter(vm, AdapterConfig(
    "crt_green",
    720,
    400,
    80,
    25,
    239,
    0,
    256.kB(),
    "./tty.png",
    0.7f
)) {

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