package net.torvald.tsvm.peripheral

import com.badlogic.gdx.utils.Queue

/**
 * Implements standard TTY that can interpret some of the ANSI escape sequences
 */
abstract class GlassTty(val TEXT_ROWS: Int, val TEXT_COLS: Int) {

    abstract fun getCursorPos(): Pair<Int, Int>
    abstract fun setCursorPos(x: Int, y: Int)

    abstract var rawCursorPos: Int
    abstract var blinkCursor: Boolean

    abstract var ttyFore: Int
    abstract var ttyBack: Int
    abstract var ttyRawMode: Boolean

    abstract fun putChar(x: Int, y: Int, text: Byte, foreColour: Byte = ttyFore.toByte(), backColour: Byte = ttyBack.toByte())

    private var ttyMode = Queue<Byte>() // stores escape sequences like: <ESC> [

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
        TODO()

        if (ESC == char) {
            // beginning of the escape sequence
            if (ttyMode.isEmpty) {
                ttyMode.addLast(char)
            }
            else {
                return true
            }
        }
        // Any escape sequences
        else if (ttyMode.size >= 1) {
            // make a state machine; if the machine should move into accepting state: accept a char, and return false;
            //   for a rejecting state (sequence not in the transition table): clear the ttyMode, and return false;
            //   for a terminating state (escape sequence is terminated successfully): run interpretCSI(), and return false.


            return false
        }
    }

    private fun interpretEscapeSequence() {
        TODO()
    }



    private val ESC = 0x1B.toByte()
    private val LBRACKET = 0x5B.toByte()

    private val FORE_DEFAULT = 254
    private val BACK_DEFAULT = 255

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
  CSI -> CursorY [label="G"]
  CSI -> EraseDisp [label="J"]
  CSI -> EraseLine [label="K"]
  CSI -> ScrollUp [label="S"]
  CSI -> ScrollDown [label="T"]

  numeral -> numeral [label="0..9"]
  numeral -> CursorUp [label="A"]
  numeral -> CursorDown [label="B"]
  numeral -> CursorFwd [label="C"]
  numeral -> CursorBack [label="D"]
  numeral -> CursorNextLine [label="E"]
  numeral -> CursorPrevLine [label="F"]
  numeral -> CursorY [label="G"]
  numeral -> EraseDisp [label="J"]
  numeral -> EraseLine [label="K"]
  numeral -> ScrollUp [label="S"]
  numeral -> ScrollDown [label="T"]

  numeral -> SGR [label="(any unacceptable char)"]

  numeral -> separator1 [label=";"]
  separator1 -> numeral2 [label="0..9"]
  numeral2 -> numeral2 [label="0..9"]
  numeral2 -> CursorPos [label="H"]

  numeral2 -> separator2 [label=";"]

  separator2 -> numeral3 [label="0..9"]
  numeral3 -> numeral3 [label="0..9"]

  numeral3 -> "SGR-Colour" [label="(any unacceptable char)"]

  ESC [shape=Mdiamond]
  Reset -> end
  CursorUp -> end
  CursorDown -> end
  CursorFwd -> end
  CursorBack -> end
  CursorNextLine -> end
  CursorPrevLine -> end
  CursorY -> end
  EraseDisp -> end
  EraseLine -> end
  ScrollUp -> end
  ScrollDown -> end
  CursorPos -> end
  SGR -> end
  "SGR-Colour" -> end
  end [shape=Msquare]
}

 */