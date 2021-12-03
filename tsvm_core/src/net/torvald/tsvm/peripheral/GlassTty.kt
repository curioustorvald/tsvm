package net.torvald.tsvm.peripheral

import java.io.InputStream
import java.io.OutputStream
import java.util.*

/**
 * Implements standard TTY that can interpret some of the ANSI escape sequences
 *
 * A paper tty must be able to implemented by extending this class (and butchering some of the features), of which it
 * sets limits on some of the functions (notably 'setCursorPos')
 */
abstract class GlassTty(val TEXT_ROWS: Int, val TEXT_COLS: Int) {

    /**
     * (x, y)
     */
    abstract fun getCursorPos(): Pair<Int, Int>

    /**
     * Think of it as a real paper tty;
     * setCursorPos must "wrap" the cursor properly when x-value goes out of screen bound.
     * For y-value, only when y < 0, set y to zero and don't care about the y-value goes out of bound.
     */
    abstract fun setCursorPos(x: Int, y: Int)

    abstract var rawCursorPos: Int
    abstract var blinkCursor: Boolean

    abstract var ttyFore: Int
    abstract var ttyBack: Int
    abstract var ttyRawMode: Boolean

    abstract fun putChar(x: Int, y: Int, text: Byte, foreColour: Byte = ttyFore.toByte(), backColour: Byte = ttyBack.toByte())

    fun writeOut(char: Byte) {
        val (cx, cy) = getCursorPos()

        val printable = acceptChar(char) // this function processes the escape codes and CRLFs

        if (printable) {
            putChar(cx, cy, char)
            setCursorPos(cx + 1, cy) // should automatically wrap and advance a line for out-of-bound x-value
        }
    }

    private var ttyEscState = TTY_ESC_STATE.INITIAL
    private val ttyEscArguments = Stack<Int>()
    /**
     * ONLY accepts a character to either process the escape sequence, or say the input character is allowed to print.
     * This function will alter the internal state of the TTY intepreter (aka this very class)
     *
     * Any unrecognisable escape sequence will result the internal state to be reset but the character WILL NOT be marked
     * as printable.
     *
     * @return true if character should be printed as-is
     */
    private fun acceptChar(char: Byte): Boolean {
        fun reject(): Boolean {
            ttyEscState = TTY_ESC_STATE.INITIAL
            ttyEscArguments.clear()
            return true
        }
        fun accept(execute: () -> Unit): Boolean {
            ttyEscState = TTY_ESC_STATE.INITIAL
            execute.invoke()
            ttyEscArguments.clear()
            return false
        }
        fun registerNewNumberArg(newnum: Byte, newState: TTY_ESC_STATE) {
            ttyEscArguments.push(char.toInt() - 0x30)
            ttyEscState = newState
        }
        fun appendToExistingNumber(newnum: Byte) {
            ttyEscArguments.push(ttyEscArguments.pop() * 10 + (newnum.toInt() - 0x30))
        }

        //println("[tty] accepting char $char, state: $ttyEscState")

        when (ttyEscState) {
            TTY_ESC_STATE.INITIAL -> {
                when (char) {
                    ESC -> ttyEscState = TTY_ESC_STATE.ESC
                    LF -> crlf()
                    BS -> backspace()
                    TAB -> insertTab()
                    BEL -> ringBell()
                    in 0x00.toByte()..0x1F.toByte() -> return false
                    else -> return true
                }
            }
            TTY_ESC_STATE.ESC -> {
                when (char.toChar()) {
                    'c' -> return accept { resetTtyStatus() }
                    '[' -> ttyEscState = TTY_ESC_STATE.CSI
                    else -> return reject()
                }
            }
            TTY_ESC_STATE.CSI -> {
                when (char.toChar()) {
                    'A' -> return accept { cursorUp() }
                    'B' -> return accept { cursorDown() }
                    'C' -> return accept { cursorFwd() }
                    'D' -> return accept { cursorBack() }
                    'E' -> return accept { cursorNextLine() }
                    'F' -> return accept { cursorPrevLine() }
                    'G' -> return accept { cursorX() }
                    'J' -> return accept { eraseInDisp() }
                    'K' -> return accept { eraseInLine() }
                    'S' -> return accept { scrollUp() }
                    'T' -> return accept { scrollDown() }
                    'm' -> return accept { sgrOneArg() }
                    '?' -> ttyEscState = TTY_ESC_STATE.PRIVATESEQ
                    ';' -> {
                        ttyEscArguments.push(0)
                        ttyEscState = TTY_ESC_STATE.SEP1
                    }
                    in '0'..'9' -> registerNewNumberArg(char, TTY_ESC_STATE.NUM1)
                    else -> return reject()
                }
            }
            TTY_ESC_STATE.PRIVATESEQ -> {
                when (char.toChar()) {
                    in '0'..'9' -> registerNewNumberArg(char, TTY_ESC_STATE.PRIVATENUM)
                    else -> return reject()
                }
            }
            TTY_ESC_STATE.PRIVATENUM -> {
                when (char.toChar()) {
                    'h' -> return accept { privateSeqH(ttyEscArguments.pop()) }
                    'l' -> return accept { privateSeqL(ttyEscArguments.pop()) }
                    in '0'..'9' -> appendToExistingNumber(char)
                    else -> return reject()
                }
            }
            TTY_ESC_STATE.NUM1 -> {
                when (char.toChar()) {
                    'A' -> return accept { cursorUp(ttyEscArguments.pop()) }
                    'B' -> return accept { cursorDown(ttyEscArguments.pop()) }
                    'C' -> return accept { cursorFwd(ttyEscArguments.pop()) }
                    'D' -> return accept { cursorBack(ttyEscArguments.pop()) }
                    'E' -> return accept { cursorNextLine(ttyEscArguments.pop()) }
                    'F' -> return accept { cursorPrevLine(ttyEscArguments.pop()) }
                    'G' -> return accept { cursorX(ttyEscArguments.pop()) }
                    'J' -> return accept { eraseInDisp(ttyEscArguments.pop()) }
                    'K' -> return accept { eraseInLine(ttyEscArguments.pop()) }
                    'S' -> return accept { scrollUp(ttyEscArguments.pop()) }
                    'T' -> return accept { scrollDown(ttyEscArguments.pop()) }
                    'm' -> return accept { sgrOneArg(ttyEscArguments.pop()) }
                    ';' -> ttyEscState = TTY_ESC_STATE.SEP1
                    in '0'..'9' -> appendToExistingNumber(char)
                    else -> return reject()
                }
            }
            TTY_ESC_STATE.NUM2 -> {
                when (char.toChar()) {
                    in '0'..'9' -> appendToExistingNumber(char)
                    'H' -> return accept {
                        val arg2 = ttyEscArguments.pop()
                        val arg1 = ttyEscArguments.pop()
                        cursorXY(arg1, arg2)
                    }
                    'm' -> return accept {
                        val arg2 = ttyEscArguments.pop()
                        val arg1 = ttyEscArguments.pop()
                        sgrTwoArg(arg1, arg2)
                    }
                    ';' -> ttyEscState = TTY_ESC_STATE.SEP2
                    else -> return reject()
                }
            }
            TTY_ESC_STATE.NUM3 -> {
                when (char.toChar()) {
                    in '0'..'9' -> appendToExistingNumber(char)
                    'm' -> return accept {
                        val arg3 = ttyEscArguments.pop()
                        val arg2 = ttyEscArguments.pop()
                        val arg1 = ttyEscArguments.pop()
                        sgrThreeArg(arg1, arg2, arg3)
                    }
                    else -> return reject()
                }
            }
            TTY_ESC_STATE.SEP1 -> {
                when (char.toChar()) {
                    in '0'..'9' -> registerNewNumberArg(char, TTY_ESC_STATE.NUM2)
                    'H' -> return accept {
                        val arg1 = ttyEscArguments.pop()
                        cursorXY(arg1, 0)
                    }
                    'm' -> return accept {
                        val arg1 = ttyEscArguments.pop()
                        sgrTwoArg(arg1, 0)
                    }
                    ';' -> {
                        ttyEscArguments.push(0)
                        ttyEscState = TTY_ESC_STATE.SEP2
                    }
                    else -> return reject()
                }
            }
            TTY_ESC_STATE.SEP2 -> {
                when (char.toChar()) {
                    'm' -> return accept {
                        val arg2 = ttyEscArguments.pop()
                        val arg1 = ttyEscArguments.pop()
                        sgrThreeArg(arg1, arg2, 0)
                    }
                    in '0'..'9' -> registerNewNumberArg(char, TTY_ESC_STATE.NUM3)
                    else -> return reject()
                }
            }
        }

        return false
    }

    abstract fun resetTtyStatus()
    abstract fun cursorUp(arg: Int = 1)
    abstract fun cursorDown(arg: Int = 1)
    abstract fun cursorFwd(arg: Int = 1)
    abstract fun cursorBack(arg: Int = 1)
    abstract fun cursorNextLine(arg: Int = 1)
    abstract fun cursorPrevLine(arg: Int = 1)
    abstract fun cursorX(arg: Int = 1) // aka Cursor Horizintal Absolute
    abstract fun eraseInDisp(arg: Int = 0)
    abstract fun eraseInLine(arg: Int = 0)
    /** New lines are added at the bottom */
    abstract fun scrollUp(arg: Int = 1)
    /** New lines are added at the top */
    abstract fun scrollDown(arg: Int = 1)
    abstract fun sgrOneArg(arg: Int = 0)
    abstract fun sgrTwoArg(arg1: Int, arg2: Int)
    abstract fun sgrThreeArg(arg1: Int, arg2: Int, arg3: Int)
    /** The values are one-based
     * @param arg1 y-position (row)
     * @param arg2 x-position (column) */
    abstract fun cursorXY(arg1: Int, arg2: Int)
    abstract fun ringBell()
    abstract fun insertTab()
    abstract fun crlf()
    abstract fun backspace()
    abstract fun privateSeqH(arg: Int)
    abstract fun privateSeqL(arg: Int)

    abstract fun getPrintStream(): OutputStream
    abstract fun getErrorStream(): OutputStream
    abstract fun getInputStream(): InputStream

    private val CR = 0x0D.toByte()
    private val LF = 0x0A.toByte()
    private val TAB = 0x09.toByte()
    private val BS = 0x08.toByte()
    private val BEL = 0x07.toByte()
    private val ESC = 0x1B.toByte()

    private enum class TTY_ESC_STATE {
        INITIAL, ESC, CSI, NUM1, SEP1, NUM2, SEP2, NUM3, PRIVATESEQ, PRIVATENUM
    }


    /**
     * Puts a key into a keyboard buffer
     */
    abstract fun putKey(key: Int)

    /**
     * Takes a key from a keyboard buffer
     */
    abstract fun takeKey(): Int

}

/*
Note 1. State machine for Escape sequence

digraph G {

  ESC -> Reset [label="c"]
  ESC -> CSI [label="["]

  CSI -> numeral [label="0..9"]
  CSI -> CursorUp [label="A"]
  CSI -> CursorDown [label="B"]
  CSI -> CursorFwd [label="C"]
  CSI -> CursorBack [label="D"]
  CSI -> CursorNextLine [label="E"]
  CSI -> CursorPrevLine [label="F"]
  CSI -> CursorX [label="G"]
  CSI -> EraseInDisp [label="J"]
  CSI -> EraseInLine [label="K"]
  CSI -> ScrollUp [label="S"]
  CSI -> ScrollDown [label="T"]
  CSI -> SGR [label="m"]
  CSI -> separator1 [label="; (zero)"]

  CSI -> privateseq [label="?"]

  privateseq -> privatenum [label="0..9"]

  privatenum -> privateSeqH [label=h]
  privatenum -> privateSeqL [label=l]

  numeral -> numeral [label="0..9"]
  numeral -> CursorUp [label="A"]
  numeral -> CursorDown [label="B"]
  numeral -> CursorFwd [label="C"]
  numeral -> CursorBack [label="D"]
  numeral -> CursorNextLine [label="E"]
  numeral -> CursorPrevLine [label="F"]
  numeral -> CursorX [label="G"]
  numeral -> EraseInDisp [label="J"]
  numeral -> EraseInLine [label="K"]
  numeral -> ScrollUp [label="S"]
  numeral -> ScrollDown [label="T"]

  numeral -> SGR [label="m"]

  numeral -> separator1 [label=";"]

  separator1 -> numeral2 [label="0..9"]
  separator1 -> separator2 [label="; (zero)"]
  separator1 -> CursorPos [label="H (zero)"]
  separator1 -> SGR2 [label="m (zero)"]

  numeral2 -> numeral2 [label="0..9"]
  numeral2 -> CursorPos [label="H"]
  numeral2 -> SGR2 [label="m"]
  numeral2 -> separator2 [label="; (zero)"]

  separator2 -> numeral3 [label="0..9"]
  numeral3 -> numeral3 [label="0..9"]

  separator2 -> SGR3 [label="m (zero)"]
  numeral3 -> SGR3 [label="m"]

  ESC [shape=Mdiamond]
  Reset -> end
  CursorUp -> end
  CursorDown -> end
  CursorFwd -> end
  CursorBack -> end
  CursorNextLine -> end
  CursorPrevLine -> end
  CursorX -> end
  EraseInDisp -> end
  EraseInLine -> end
  ScrollUp -> end
  ScrollDown -> end
  CursorPos -> end
  SGR -> end
  SGR2 -> end
  SGR3 -> end
  end [shape=Msquare]
}

 */