package net.torvald.tsvm.peripheral

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.InputProcessor
import net.torvald.UnsafeHelper
import net.torvald.tsvm.VM
import net.torvald.util.CircularArray

class IOSpace(val vm: VM) : PeriBase, InputProcessor {

    override fun getVM(): VM {
        return vm
    }

    /** Absolute x-position of the computer GUI */
    var guiPosX = 0
    /** Absolute y-position of the computer GUI */
    var guiPosY = 0

    private val keyboardBuffer = CircularArray<Byte>(32, true)
    private var mouseX: Short = 0
    private var mouseY: Short = 0
    private var mouseDown = false

    override fun peek(addr: Long): Byte? {
        return mmio_read(addr)
    }

    override fun poke(addr: Long, byte: Byte) {
        mmio_write(addr, byte)
    }

    override fun mmio_read(addr: Long): Byte? {
        val adi = addr.toInt()
        return when (addr) {
            in 0..31 -> keyboardBuffer[(addr.toInt())] ?: -1
            in 32..33 -> (mouseX.toInt() shr (adi - 32).times(8)).toByte()
            in 34..35 -> (mouseY.toInt() shr (adi - 34).times(8)).toByte()
            36L -> if (mouseDown) 1 else 0
            37L -> keyboardBuffer.removeHead() ?: -1
            else -> -1
        }
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toInt().and(255)
        when (addr) {
        }
    }

    override fun dispose() {
    }

    fun update(delta: Float) {
        mouseX = (Gdx.input.x + guiPosX).toShort()
        mouseY = (Gdx.input.y + guiPosY).toShort()
        mouseDown = Gdx.input.isTouched
    }

    override fun touchUp(p0: Int, p1: Int, p2: Int, p3: Int): Boolean {
        return false
    }

    override fun mouseMoved(p0: Int, p1: Int): Boolean {
        return false
    }

    override fun keyTyped(p0: Char): Boolean {
        keyboardBuffer.appendTail(p0.toByte())
        println("[IO] Key typed: $p0")
        return true
    }

    override fun scrolled(p0: Int): Boolean {
        return false
    }

    override fun keyUp(p0: Int): Boolean {
        return false
    }

    override fun touchDragged(p0: Int, p1: Int, p2: Int): Boolean {
        return false
    }

    override fun keyDown(p0: Int): Boolean {
        return false
    }

    override fun touchDown(p0: Int, p1: Int, p2: Int, p3: Int): Boolean {
        return false
    }
}