package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Texture
import net.torvald.UnsafeHelper
import net.torvald.tsvm.VM
import java.io.InputStream
import java.io.OutputStream

class TTY(assetsRoot: String, val vm: VM) : GlassTty(TEXT_ROWS, TEXT_COLS) {

    override val typestring = VM.PERITYPE_GPU_AND_TERM

    companion object {
        const val TEXT_ROWS = 25
        const val TEXT_COLS = 80
    }

    private val chrrom = Texture("$assetsRoot/tty.png")
    private val textBuffer = UnsafeHelper.allocate(TEXT_ROWS * TEXT_COLS * 2L, this)
    override var rawCursorPos = 0
    
    private val TEXT_AREA_SIZE = TEXT_COLS * TEXT_ROWS
    private val memTextOffset = 0L
    private val memTextAttrOffset = TEXT_AREA_SIZE.toLong()

    override var ttyFore = 0 // 0: normal, 1: intense, 2: dim
    override var ttyBack: Int
        get() = 0
        set(value) {}
    var ttyInv = false
    override var blinkCursor = true
    override var ttyRawMode = false

//    override var halfrowMode = false

    override fun getCursorPos() = rawCursorPos % TEXT_COLS to rawCursorPos / TEXT_COLS
    /**
     * Think of it as a real paper tty;
     * setCursorPos must "wrap" the cursor properly when x-value goes out of screen bound.
     * For y-value, only when y < 0, set y to zero and don't care about the y-value goes out of bound.
     */
    override fun setCursorPos(x: Int, y: Int) {
        var newx = x
        var newy = y

        if (newx >= TEXT_COLS) {
            newx = 0
            newy += 1
        }
        else if (newx < 0) {
            newx = 0
        }

        if (newy < 0) {
            newy = 0 // DON'T SCROLL when cursor goes ABOVE the screen
        }

        rawCursorPos = toTtyTextOffset(newx, newy)
    }
    private fun toTtyTextOffset(x: Int, y: Int) = y * TEXT_COLS + x


    override fun peek(addr: Long): Byte? {
        TODO("Not yet implemented")
    }

    override fun poke(addr: Long, byte: Byte) {
        TODO("Not yet implemented")
    }

    override fun mmio_read(addr: Long): Byte? {
        TODO("Not yet implemented")
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        TODO("Not yet implemented")
    }

    override fun getVM() = vm

    override fun putChar(x: Int, y: Int, text: Byte, foreColour: Byte, backColour: Byte) {
        val textOff = toTtyTextOffset(x, y)
        textBuffer[memTextAttrOffset + textOff] = 0
        textBuffer[memTextOffset + textOff] = text
    }

    override fun resetTtyStatus() {
        ttyFore = 0
        ttyInv = false
    }

    override fun cursorUp(arg: Int) {
        val (x, y) = getCursorPos()
        setCursorPos(x, y - arg)
    }

    override fun cursorDown(arg: Int) {
        val (x, y) = getCursorPos()
        val newy = y + arg
        setCursorPos(x, if (newy >= TEXT_ROWS) TEXT_ROWS - 1 else newy)
    }

    override fun cursorFwd(arg: Int) {
        val (x, y) = getCursorPos()
        setCursorPos(x + arg, y)
    }

    override fun cursorBack(arg: Int) {
        val (x, y) = getCursorPos()
        setCursorPos(x - arg, y)
    }

    override fun cursorNextLine(arg: Int) {
        val (_, y) = getCursorPos()
        val newy = y + arg
        setCursorPos(0, if (newy >= TEXT_ROWS) TEXT_ROWS - 1 else newy)
        if (newy >= TEXT_ROWS) {
            scrollUp(newy - TEXT_ROWS + 1)
        }
    }

    override fun cursorPrevLine(arg: Int) {
        val (_, y) = getCursorPos()
        setCursorPos(0, y - arg)
    }

    override fun cursorX(arg: Int) {
        val (_, y) = getCursorPos()
        setCursorPos(arg, y)
    }

    override fun eraseInDisp(arg: Int) {
        when (arg) {
            else -> TODO()
        }
    }

    override fun eraseInLine(arg: Int) {
        when (arg) {
            else -> TODO()
        }
    }

    override fun sgrOneArg(arg: Int) {
        TODO("Not yet implemented")
    }

    override fun sgrTwoArg(arg1: Int, arg2: Int) {
        TODO("Not yet implemented")
    }

    override fun sgrThreeArg(arg1: Int, arg2: Int, arg3: Int) {
        TODO("Not yet implemented")
    }

    override fun cursorXY(arg1: Int, arg2: Int) {
        TODO("Not yet implemented")
    }

    override fun ringBell() {
        TODO("Not yet implemented")
    }

    override fun insertTab() {
        TODO("Not yet implemented")
    }

    override fun crlf() {
        TODO("Not yet implemented")
    }

    override fun backspace() {
        TODO("Not yet implemented")
    }

    override fun privateSeqH(arg: Int) {
        TODO("Not yet implemented")
    }

    override fun privateSeqL(arg: Int) {
        TODO("Not yet implemented")
    }

    override fun getPrintStream(): OutputStream {
        TODO("Not yet implemented")
    }

    override fun getErrorStream(): OutputStream {
        TODO("Not yet implemented")
    }

    override fun getInputStream(): InputStream {
        TODO("Not yet implemented")
    }

    override fun putKey(key: Int) {
        vm.poke(-39, key.toByte())
    }

    override fun emitChar(code: Int) {
        TODO("Not yet implemented")
    }

    /**
     * @return key code in 0..255 (TODO: JInput Keycode or ASCII-Code?)
     */
    override fun takeKey(): Int {
        return vm.peek(-38)!!.toInt().and(255)
    }

    /** New lines are added at the bottom */
    override fun scrollUp(arg: Int) {
        val displacement = arg.toLong() * TEXT_COLS
        UnsafeHelper.memcpy(
            textBuffer.ptr + memTextOffset + displacement,
            textBuffer.ptr + memTextOffset,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            textBuffer.ptr + memTextAttrOffset + displacement,
            textBuffer.ptr + memTextAttrOffset,
            TEXT_AREA_SIZE - displacement
        )
        for (i in 0 until displacement) {
            textBuffer[memTextOffset + TEXT_AREA_SIZE - displacement + i] = 0
            textBuffer[memTextAttrOffset + TEXT_AREA_SIZE - displacement + i] = ttyFore.toByte()
        }
    }

    /** New lines are added at the top */
    override fun scrollDown(arg: Int) {
        val displacement = arg.toLong() * TEXT_COLS
        UnsafeHelper.memcpy(
            textBuffer.ptr + memTextOffset,
            textBuffer.ptr + memTextOffset + displacement,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            textBuffer.ptr + memTextAttrOffset,
            textBuffer.ptr + memTextAttrOffset + displacement,
            TEXT_AREA_SIZE - displacement
        )
        for (i in 0 until displacement) {
            textBuffer[memTextOffset + TEXT_AREA_SIZE + i] = 0
            textBuffer[memTextAttrOffset + TEXT_AREA_SIZE + i] = ttyFore.toByte()
        }
    }
    

    override fun dispose() {
        chrrom.dispose()
    }
}