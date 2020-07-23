package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.tsvm.peripheral.GraphicsAdapter
import java.lang.NumberFormatException

/**
 * See ./Videotron2K.md for documentation
 */
class Videotron2K(val gpu: GraphicsAdapter) {

    private var regs = UnsafeHelper.allocate(16 * 8)
    private var internalMem = UnsafeHelper.allocate(16384)

    private var scenes = HashMap<String, Array<VT2Statement>>()
    private var varIdTable = HashMap<String, Long>()

    private val reComment = Regex(""";[^\n]*""")
    private val reTokenizer = Regex(""" +""")

    private val conditional = arrayOf("ZR", "NZ", "GT", "LS", "GE", "LE")

    fun eval(command: String) {
        var command = command.replace(reComment, "")
    }

    private fun translateLine(lnum: Int, line: String): VT2Statement? {
        val tokens = line.split(reTokenizer)
        if (tokens.isEmpty()) return null

        val isInit = tokens[0] == "@"
        val cmdstr = tokens[isInit.toInt()].toUpperCase()
        val cmdcond = (conditional.linearSearch { it == cmdstr.substring(cmdstr.length - 2, cmdstr.length) } ?: -1) + 1
        val realcmd = if (cmdcond > 0) cmdstr.substring(0, cmdstr.length - 2) else cmdstr

        val cmd: Int = Command.dict[realcmd] ?: throw RuntimeException("Syntax Error at line $lnum")
        val args = tokens.subList(1 + isInit.toInt(), tokens.size).map { parseArgString(it) }

        return VT2Statement(if (isInit) StatementPrefix.INIT else StatementPrefix.NONE, cmd or cmdcond, args.toLongArray())
    }

    private fun parseArgString(token: String): Long {
        if (token.toIntOrNull() != null)
            return token.toLong().and(0xFFFFFFFF)
        else if (token.endsWith('h') && token.substring(0, token.lastIndex).toIntOrNull() != null)
            return token.substring(0, token.lastIndex).toInt(16).toLong().and(0xFFFFFFFF)
        else if (token.startsWith('r') && token.substring(1, token.length).toIntOrNull() != null)
            return REGISTER_PREFIX or token.substring(1, token.length).toLong().and(0xFFFFFFFF)
        else {
            TODO("variable assignation and utilisation")
        }
    }

    private class VT2Statement(val prefix: Int = StatementPrefix.NONE, val command: Int, val args: LongArray)

    fun dispose() {
        regs.destroy()
    }

    private fun Boolean.toInt() = if (this) 1 else 0

    private fun <T> Array<T>.linearSearch(selector: (T) -> Boolean): Int? {
        this.forEachIndexed { index, it ->
            if (selector.invoke(it)) return index
        }

        return null
    }

    companion object {
        private const val REGISTER_PREFIX = 0x7FFFFFFF_00000000L
        private const val VARIABLE_PREFIX = 0x3FFFFFFF_00000000L
    }
}

object StatementPrefix {
    const val NONE = 0
    const val INIT = 1
}

object Command {
    const val NOP = 0
    const val ADD = 0x8
    const val SUB = 0x10
    const val MUL = 0x18
    const val DIV = 0x20
    const val AND = 0x28
    const val OR = 0x30
    const val XOR = 0x38
    const val SHL = 0x40
    const val SHR = 0x48
    const val USHR = 0x50
    const val INC = 0x58
    const val DEC = 0x60
    const val NOT = 0x68
    const val NEG = 0x70

    const val CMP = 0x100

    const val MOV = 0x200
    const val DATA = 0x208
    const val MCP = 0x210

    const val PERFORM = 0x300
    const val NEXT = 0x308
    const val EXIT = 0x310
    const val EXEUNT = 0x318

    const val FILLIN = 0x400
    const val PLOT = 0x408
    const val FILLSCR = 0x410
    const val GOTO = 0x418
    const val BORDER = 0x420

    const val WAIT = 0x600

    const val DEFINE = 0xFFF8

    val dict = hashMapOf(
        "NOP" to NOP,
        "ADD" to ADD,
        "SUB" to SUB,
        "MUL" to MUL,
        "DIV" to DIV,
        "AND" to AND,
        "OR" to OR,
        "XOR" to XOR,
        "SHL" to SHL,
        "SHR" to SHR,
        "USHR" to USHR,
        "INC" to INC,
        "DEC" to DEC,
        "NOT" to NOT,
        "NEG" to NEG,

        "CMP" to CMP,

        "MOV" to MOV,
        "DATA" to DATA,
        "MCP" to MCP,

        "PERFORM" to PERFORM,
        "NEXT" to NEXT,
        "EXIT" to EXIT,
        "EXEUNT" to EXEUNT,

        "FILLIN" to FILLIN,
        "PLOT" to PLOT,
        "FILLSCR" to FILLSCR,
        "GOTO" to GOTO,
        "BORDER" to BORDER,

        "WAIT" to WAIT,

        "DEFINE" to DEFINE
    )
}