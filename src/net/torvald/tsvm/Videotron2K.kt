package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.random.HQRNG
import net.torvald.tsvm.peripheral.GraphicsAdapter
import java.lang.NumberFormatException

/**
 * See ./Videotron2K.md for documentation
 */
class Videotron2K(val gpu: GraphicsAdapter) {

    private val screenfiller = """
        DEFINE RATEF 60
        DEFINE height 448
        DEFINE width 560

        SCENE fill_line
          @ mov 0 px
            plot c1 ; will auto-increment px by one
            inc c1
            cmp c1 251 r3
            movzr r3 c3 0     ; mov (-zr r3) c3 0 -- first, the comparison is made with r3 then runs 'mov c3 0' if r3 == 0
            cmp px 560 r1
            exitzr r1
        END SCENE
        
        SCENE loop_frame
          @ mov 0 py
            perform fill_line
            inc py
            next
            ; there's no EXIT command so this scene will make the program to go loop indefinitely
        END SCENE
        
        perform loop_frame
        
    """.trimIndent()

    private var regs = UnsafeHelper.allocate(16 * 8)
    private var internalMem = UnsafeHelper.allocate(16384)

    private var scenes = HashMap<Long, Array<VT2Statement>>()
    private var varIdTable = HashMap<String, Long>() // String is always uppercase, Long always has VARIABLE_PREFIX added
    private var currentScene: Long? = null // if it's named_scene, VARIABLE_PREFIX is added; indexed_scene does not.

    private val reComment = Regex(""";[^\n]*""")
    private val reTokenizer = Regex(""" +""")

    private val debugPrint = true
    private val rng = HQRNG()

    fun eval(command: String) {
        val rootStatements = ArrayList<VT2Statement>()
        val sceneStatements = ArrayList<VT2Statement>()

        command.replace(reComment, "").split('\n')
            .mapIndexed { index, s -> index to s }.filter { it.second.isNotBlank() }
            .forEach { (lnum, stmt) ->
                val stmtUpper = stmt.toUpperCase()
                val wordsUpper = stmtUpper.split(reTokenizer)

                if (stmtUpper.startsWith("SCENE_")) { // indexed scene
                    val scenenumStr = stmt.substring(6)
                    try {
                        val scenenum = scenenumStr.toLong()

                        currentScene = scenenum
                    }
                    catch (e: NumberFormatException) {
                        throw IllegalArgumentException("Line $lnum: Illegal scene numeral on $scenenumStr")
                    }
                }
                else if (stmtUpper.startsWith("SCENE ")) { // named scene
                    val sceneName = wordsUpper[1]
                    if (sceneName.isNullOrBlank()) {
                        throw IllegalArgumentException("Line $lnum: Illegal scene name on $stmt")
                    }
                    else if (hasVar(sceneName)) {
                        throw IllegalArgumentException("Line $lnum: Scene name or variable '$sceneName' already exists")
                    }

                    currentScene = registerNewVariable(sceneName)
                }
                else if (wordsUpper[0] == "END" && wordsUpper[1] == "SCENE") { // END SCENE
                    if (currentScene == null) {
                        throw IllegalArgumentException("Line $lnum: END SCENE is called without matching SCENE definition")
                    }

                    scenes[currentScene!!] = sceneStatements.toTypedArray()

                    sceneStatements.clear()
                    currentScene = null
                }
                else {
                    val cmdBuffer = if (currentScene != null) sceneStatements else rootStatements

                    cmdBuffer.add(translateLine(lnum, stmt))
                }
            }


        if (debugPrint) {
            scenes.forEach { id, statements ->
                println("SCENE #$id")
                statements.forEach { println("    $it") }
                println("END SCENE\n")
            }

            rootStatements.forEach { println(it) }
        }
    }

    private fun translateLine(lnum: Int, line: String): VT2Statement {
        val tokens = line.split(reTokenizer)
        if (tokens.isEmpty()) throw InternalError("Line $lnum: empty line not filtered!")

        val isInit = tokens[0] == "@"
        val cmdstr = tokens[isInit.toInt()].toUpperCase()

        val cmd: Int = Command.dict[cmdstr] ?: throw RuntimeException("Syntax Error at line $lnum") // conditional code is pre-added on dict
        val args = tokens.subList(1 + isInit.toInt(), tokens.size).map { parseArgString(it) }

        return VT2Statement(if (isInit) StatementPrefix.INIT else StatementPrefix.NONE, cmd, args.toLongArray())
    }

    private fun parseArgString(token: String): Long {
        if (token.toIntOrNull() != null) // number literal
            return token.toLong().and(0xFFFFFFFF)
        else if (token.endsWith('h') && token.substring(0, token.lastIndex).toIntOrNull() != null) // hex literal
            return token.substring(0, token.lastIndex).toInt(16).toLong().and(0xFFFFFFFF)
        else if (token.startsWith('r') && token.substring(1, token.length).toIntOrNull() != null) // r-registers
            return REGISTER_PREFIX or token.substring(1, token.length).toLong().minus(1).and(0xFFFFFFFF)
        else if (token.startsWith('c') && token.substring(1, token.length).toIntOrNull() != null) // c-registers
            return REGISTER_PREFIX or token.substring(1, token.length).toLong().plus(5).and(0xFFFFFFFF)
        else {
            val varId = varIdTable[token.toUpperCase()] ?: throw IllegalArgumentException("Undefined variable: $token")

            return varId
        }
    }

    private fun registerNewVariable(varName: String): Long {
        var id: Long
        do {
            id = VARIABLE_PREFIX or rng.nextLong().and(0xFFFFFFFFL)
        } while (varIdTable.containsValue(id))

        varIdTable[varName.toUpperCase()] = id
        return id
    }

    private fun hasVar(name: String) = (varIdTable.containsKey(name.toUpperCase()))


    private class VT2Statement(val prefix: Int = StatementPrefix.NONE, val command: Int, val args: LongArray) {
        override fun toString(): String {
            return StatementPrefix.toString(prefix) + " " + Command.reverseDict[command] + " " + (args.map { argsToString(it) + " " })
        }

        private fun argsToString(i: Long): String {
            if (i and REGISTER_PREFIX != 0L) {
                val regnum = i and 0xFFFFFFFFL
                return if (regnum < 6) "r${regnum + 1}" else "c${regnum - 5}"
            }
            else return i.toInt().toString()
        }
    }

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

        private const val REG_PX = REGISTER_PREFIX or 12
        private const val REG_PY = REGISTER_PREFIX or 13
        private const val REG_FRM = REGISTER_PREFIX or 14
        private const val REG_TMR = REGISTER_PREFIX or 15

        private const val REG_R1 = REGISTER_PREFIX
        private const val REG_C1 = REGISTER_PREFIX + 6

        /*
        Registers internal variable ID:

        r1 = REGISTER_PREFIX + 0
        r2 = REGISTER_PREFIX + 1
        r3 = REGISTER_PREFIX + 2
        r4 = REGISTER_PREFIX + 3
        r5 = REGISTER_PREFIX + 4
        r6 = REGISTER_PREFIX + 5

        c1 = REGISTER_PREFIX + 6
        c2 = REGISTER_PREFIX + 7
        c3 = REGISTER_PREFIX + 8
        c4 = REGISTER_PREFIX + 9
        c5 = REGISTER_PREFIX + 10
        c6 = REGISTER_PREFIX + 11

        px = REGISTER_PREFIX + 12
        py = REGISTER_PREFIX + 13

        frm = REGISTER_PREFIX + 14
        tmr = REGISTER_PREFIX + 15
         */
    }
}

object StatementPrefix {
    const val NONE = 0
    const val INIT = 1

    fun toString(key: Int) = when(key) {
        INIT -> "@"
        else -> " "
    }
}

object Command {
    val conditional = arrayOf("ZR", "NZ", "GT", "LS", "GE", "LE")

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

    // fill in conditionals to dict
    init {
        dict.entries.forEach { (command, opcode) ->
            conditional.forEachIndexed { i, cond ->
                dict[command + cond] = opcode + i + 1
            }
        }
    }

    val reverseDict = HashMap<Int, String>(dict.entries.associate { (k,v)-> v to k })
}