package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.VM
import net.torvald.tsvm.kB

class TexticsAdapter(vm: VM) : GraphicsAdapter(vm, AdapterConfig(
    "crt",
    720,
    375,
    80,
    25,
    254,
    0,
    256.kB(),
    "./hp2640.png",
    0.32f
)) {
/*class TexticsAdapter(vm: VM) : GraphicsAdapter(vm, AdapterConfig(
    "crt_color",
    560,
    448,
    80,
    32,
    254,
    255,
    256.kB(),
    "./cp437_fira_code.png",
    0.64f
)) {*/

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