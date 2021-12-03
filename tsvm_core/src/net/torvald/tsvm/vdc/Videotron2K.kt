package net.torvald.tsvm.vdc

import net.torvald.UnsafeHelper
import torvald.random.HQRNG
import net.torvald.tsvm.peripheral.GraphicsAdapter
import java.lang.NumberFormatException
import java.util.*
import kotlin.collections.ArrayList
import kotlin.collections.HashMap
import kotlin.collections.HashSet

/**
 * See ./Videotron2K.md for documentation
 *
 * ## Variable Namespace
 * - Scenes and Variables use same namespace
 *
 */
class Videotron2K(var gpu: GraphicsAdapter?) {

    companion object {
        const val REGISTER_PREFIX = 0x7FFFFFFF_00000000L
        const val VARIABLE_PREFIX = 0x3FFFFFFF_00000000L
        const val PREFIX_MASK = (0xFFFFFFFFL).shl(32)

        const val REG_PX = REGISTER_PREFIX or 12
        const val REG_PY = REGISTER_PREFIX or 13
        const val REG_FRM = REGISTER_PREFIX or 14
        const val REG_TMR = REGISTER_PREFIX or 15

        const val REG_R1 = REGISTER_PREFIX
        const val REG_C1 = REGISTER_PREFIX + 6

        const val INDEXED_SCENE_MAX = 1048575

        const val VARIABLE_RATET = VARIABLE_PREFIX or 0
        const val VARIABLE_RATEF = VARIABLE_PREFIX or 1
        const val VARIABLE_WIDTH = VARIABLE_PREFIX or 2
        const val VARIABLE_HEIGHT = VARIABLE_PREFIX or 3

        private val specialRegs = hashMapOf(
            "px" to REG_PX,
            "py" to REG_PY,
            "frm" to REG_FRM,
            "tmr" to REG_TMR
        )

        private val reverseSpecialRegs = HashMap(specialRegs.entries.associate { (k, v) -> v to k })

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

        val screenfiller = """
        DEFINE RATEF 60
        DEFINE height 448
        DEFINE width 560

        mov r6 12345

        SCENE rng ; r6 is RNG value
            mul r6 r6 48271
            mod r6 r6 2147483647
            exit
        END SCENE

        SCENE fill_line
          @ mov px 0
            perform rng
            plot r6
            ; plot c1 ; will auto-increment px by one
            ; inc c1
            ; cmp r1 c1 251
            ; movzr r1 c1 0     ; mov (-zr r1) c1 0 -- first, the comparison is made with r1 then runs 'mov c1 0' if r1 == 0
            exitzr px
        END SCENE
        
        SCENE loop_frame
          @ mov py 0
            perform fill_line
            inc py
            cmp r1 py 448
            movzr r1 py 0
            next
            ; exeunt
            ; there's no EXIT command so this scene will make the program to go loop indefinitely
        END SCENE
        
        perform loop_frame
        
        """.trimIndent()
    }

    internal var regs = UnsafeHelper.allocate(16 * 4)
    internal var internalMem = UnsafeHelper.allocate(16384)
    internal var callStack = Stack<Pair<Long, Int>>() // Pair of Scene-ID (has SCENE_PREFIX; 0 with no prefix for root scene) and ProgramCounter

    /* Compile-time variables */
    private var scenes = HashMap<Long, Array<VT2Statement>>() // Long can have either SCENE_PREFIX- or INDEXED_SCENE_PREFIX-prefixed value
    private var varIdTable = HashMap<String, Long>() // String is always uppercase, Long always has VARIABLE_PREFIX added
    //private var sceneIdTable = HashMap<String, Long>() // String is always uppercase, Long always has SCENE_PREFIX added
    internal var currentScene = 0L // VARIABLE_PREFIX is normally added but ROOT scene is just zero. Used by both parser and executor
    internal var currentLineIndex = 0

    internal var pcLoopedBack = false
    internal var exeunt = false

    /* Run-time variables and status */
    internal var variableMap = HashMap<Long, Int>() // VarId with VARIABLE_PREFIX, Integer-value
    internal var sleepLatch = false

    // statistics stuffs
    internal var performanceCounterTmr = 0L
    var statsFrameTime = 0.0 // in seconds
        internal set

    fun resetVarIdTable() {
        varIdTable.clear()
        varIdTable["RATET"] = VARIABLE_RATET
        varIdTable["RATEF"] = VARIABLE_RATEF
        varIdTable["WIDTH"] = VARIABLE_WIDTH
        varIdTable["HEIGHT"] = VARIABLE_HEIGHT
    }

    private val reComment = Regex(""";[^\n]*""")
    private val reTokenizer = Regex(""" +""")
    private val reGeneralReg = Regex("""[rR][0-9]""")
    private val reCountReg = Regex("""[cC][0-9]""")

    private val infoPrint = true
    private val debugPrint = false
    private val rng = torvald.random.HQRNG()

    fun eval(command: String) {
        val rootStatements = parseCommands(command)


        if (infoPrint) {
            scenes.forEach { id, statements ->
                println("SCENE #${id and 0xFFFFFFFFL}")
                statements.forEachIndexed { i, it -> println("I ${i.toString().padEnd(5, ' ')}$it") }
                println("END SCENE\n")
            }

            rootStatements.forEachIndexed { i, it -> println("I ${i.toString().padEnd(5, ' ')}$it") }
        }

        execute(rootStatements)
    }

    private fun execute(rootStatements: Array<VT2Statement>) {
        variableMap.clear()
        currentScene = 0
        regs.fillWith(0)

        while (!exeunt) {
            val scene = if (currentScene == 0L) rootStatements else scenes[currentScene]!!
            val it = scene[currentLineIndex]
            val oldSceneNo = currentScene

            if (it.prefix != StatementPrefix.INIT || it.prefix == StatementPrefix.INIT && !pcLoopedBack) {
                if (debugPrint) println("Run-Scene: ${currentScene and 0xFFFFFFFFL}, Lindex: $currentLineIndex, Inst: $it")
                Command.checkConditionAndRun(it.command, this, it.args)
                if (debugPrint) println("Reg-r1: ${regs.getInt((REG_R1 and 0xF) * 4)}, c1: ${regs.getInt((REG_C1 and 0xF) * 4)}, px: ${regs.getInt((REG_PX and 0xF) * 4)}")
            }




            // increment PC
            currentLineIndex += 1
            //// check if PC should loop back into the beginning of the scene
            if (currentScene == oldSceneNo && currentLineIndex == scene.size) {
                currentLineIndex = 0
                pcLoopedBack = true
            }
            if (currentScene != oldSceneNo) {
                pcLoopedBack = false
            }
        }
        exeunt = false


        if (infoPrint) println("Ende")
    }

    /**
     * Clobbers scenes, varIdTable, sceneIdTable and temporary variable sceneIdTable
     *
     * @return root statements; scene statements are stored in 'scenes'
     */
    private fun parseCommands(command: String): Array<VT2Statement> {
        scenes.clear()
        resetVarIdTable()
        //sceneIdTable.clear()
        val rootStatements = ArrayList<VT2Statement>()
        val sceneStatements = ArrayList<VT2Statement>()

        command.replace(reComment, "").split('\n')
            .mapIndexed { index, s -> index to s }.filter { it.second.isNotBlank() }
            .forEach { (lnum, stmt) ->
                val stmt = stmt.trim()
                val stmtUpper = stmt.toUpperCase()
                val wordsUpper = stmtUpper.split(reTokenizer)

                if (stmtUpper.startsWith("SCENE_")) { // indexed scene
                    if (currentScene != 0L) throw IllegalStateException("Line $lnum: Scenes cannot be nested")

                    val scenenumStr = stmt.substring(6)
                    try {
                        val scenenum = scenenumStr.toLong()

                        currentScene = VARIABLE_PREFIX or scenenum
                    }
                    catch (e: NumberFormatException) {
                        throw IllegalArgumentException("Line $lnum: Illegal scene numeral on $scenenumStr")
                    }
                }
                else if (stmtUpper.startsWith("SCENE ")) { // named scene
                    if (currentScene != 0L) throw IllegalStateException("Line $lnum: Scenes cannot be nested")

                    val sceneName = wordsUpper[1]
                    if (sceneName.isNullOrBlank()) {
                        throw IllegalArgumentException("Line $lnum: Illegal scene name on $stmt")
                    }
                    else if (hasVar(sceneName)) {
                        throw IllegalArgumentException("Line $lnum: Scene name or variable '$sceneName' already exists")
                    }

                    currentScene = registerNewVariable(sceneName) // scenes use same addr space as vars, to make things easier on the backend
                }
                else if (wordsUpper[0] == "END" && wordsUpper[1] == "SCENE") { // END SCENE
                    if (currentScene == 0L) throw IllegalArgumentException("Line $lnum: END SCENE is called without matching SCENE definition")

                    scenes[currentScene] = sceneStatements.toTypedArray()

                    sceneStatements.clear()
                    currentScene = 0L
                }
                else {
                    val cmdBuffer = if (currentScene != 0L) sceneStatements else rootStatements

                    cmdBuffer.add(translateLine(lnum + 1, stmt))
                }
            }

        return rootStatements.toTypedArray()
    }

    private fun translateLine(lnum: Int, line: String): VT2Statement {
        val tokens = line.split(reTokenizer)
        if (tokens.isEmpty()) throw InternalError("Line $lnum: empty line not filtered!")

        //println(tokens)

        val isInit = tokens[0] == "@"
        val cmdstr = tokens[isInit.toInt()].toUpperCase()

        val cmd: Int = Command.dict[cmdstr] ?: throw RuntimeException("Undefined instruction on line $lnum: $cmdstr ($line)") // conditional code is pre-added on dict
        val args = tokens.subList(1 + isInit.toInt(), tokens.size).map { parseArgString(cmdstr, lnum, it) }

        return VT2Statement(
            lnum,
            if (isInit) StatementPrefix.INIT else StatementPrefix.NONE,
            cmd,
            args.toLongArray()
        )
    }

    private fun parseArgString(parentCmd: String, lnum: Int, token: String): Long {
        if (token.toIntOrNull() != null) // number literal
            return token.toLong().and(0xFFFFFFFF)
        else if (token.endsWith('h') && token.substring(0, token.lastIndex).toIntOrNull() != null) // hex literal
            return token.substring(0, token.lastIndex).toInt(16).toLong().and(0xFFFFFFFF)
        else if (specialRegs.contains(token.toLowerCase())) // special registers
            return specialRegs[token.toLowerCase()]!!
        else if (token.matches(reGeneralReg)) // r-registers
            return REGISTER_PREFIX or token.substring(1, token.length).toLong().minus(1).and(0xFFFFFFFF)
        else if (token.matches(reCountReg)) // c-registers
            return REGISTER_PREFIX or token.substring(1, token.length).toLong().plus(5).and(0xFFFFFFFF)
        else {
            val varId = varIdTable[token.toUpperCase()] ?: (
                    if (parentCmd in Command.varDefiningCommands) registerNewVariable(token)
                    else throw NullPointerException("Undefined variable '$token' in line $lnum")
                    )

            return varId
        }
    }

    private fun registerNewVariable(varName: String): Long {
        var id: Long
        do {
            id = VARIABLE_PREFIX or rng.nextLong().and(0xFFFFFFFFL)
        } while (varIdTable.containsValue(id) || (id and 0xFFFFFFFFL) <= INDEXED_SCENE_MAX)

        varIdTable[varName.toUpperCase()] = id
        return id
    }

    private fun hasVar(name: String) = (varIdTable.containsKey(name.toUpperCase()))


    private class VT2Statement(val lnum: Int, val prefix: Int = StatementPrefix.NONE, val command: Int, val args: LongArray) {
        override fun toString(): String {
            return "L ${lnum.toString().padEnd(5, ' ')}" + StatementPrefix.toString(prefix) + " " + Command.reverseDict[command] + " " + (args.map { argsToString(it) })
        }

        private fun argsToString(i: Long): String {
            if (reverseSpecialRegs.contains(i))
                return reverseSpecialRegs[i]!!
            else if (i and REGISTER_PREFIX == REGISTER_PREFIX) {
                val regnum = i and 0xFFFFFFFFL
                return if (regnum < 6) "r${regnum + 1}" else "c${regnum - 5}"
            }
            else if (i and VARIABLE_PREFIX == VARIABLE_PREFIX) {
                return "var:${i and 0xFFFFFFFF}"
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
    const val MOD = 0x78

    const val CMP = 0x80
    const val MOV = 0x88
    const val DATA = 0x90
    const val MCP = 0x98

    const val PERFORM = 0x100
    const val NEXT = 0x108
    const val EXIT = 0x110
    const val EXEUNT = 0x118

    const val FILLIN = 0x200
    const val PLOT = 0x208
    const val FILLSCR = 0x210
    const val GOTO = 0x218
    const val BORDER = 0x220
    const val PLOTP = 0x228

    const val WAIT = 0x700
    const val DEFINE = 0x708

    const val INST_ID_MAX = 0x800 // 256 if divided by 8

    val dict = HashMap<String, Int>()

    val varDefiningCommands = HashSet<String>()
    val transferInst = HashSet<Int>()


    // fill in conditionals to dict
    init {
        /* dict = */hashMapOf(
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
            "MOD" to MOD,

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
            "PLOTP" to PLOTP,
            "FILLSCR" to FILLSCR,
            "GOTO" to GOTO,
            "BORDER" to BORDER,

            "WAIT" to WAIT,

            "DEFINE" to DEFINE
        ).entries.forEach { (command, opcode) ->
            dict[command] = opcode

            conditional.forEachIndexed { i, cond ->
                dict[command + cond] = opcode + i + 1
            }
        }

        /* varDefiningCommands = */hashSetOf(
            "DEFINE"
        ).forEach { command ->
            varDefiningCommands.add(command)

            conditional.forEach { cond ->
                varDefiningCommands.add(command + cond)
            }
        }

        /* transferInst = */hashSetOf(
            PERFORM, EXIT, EXEUNT
        ).forEach { command ->
            transferInst.add(command)

            conditional.forEachIndexed { cond, _ ->
                transferInst.add(command + cond)
            }
        }
    }

    val reverseDict = HashMap<Int, String>(dict.entries.associate { (k,v)-> v to k })

    /**
     * function (instance: Videotron2K, args: LongArray)
     */
    val instSet = Array<(Videotron2K, LongArray) -> Unit>(256) { { _, _ -> TODO("Instruction ID $it (${reverseDict[it * 8]})") } }

    init {
        instSet[NOP] = { _, _ -> }
        instSet[DEFINE shr 3] = { instance, args -> // DEFINE variable value
            if (args.size != 2) throw ArgsCountMismatch(2, args)

            instance.variableMap[args[0]] = if (args[1] and Videotron2K.VARIABLE_PREFIX == Videotron2K.VARIABLE_PREFIX) {
                instance.variableMap[args[1]] ?: throw NullVar()
            }
            else if (args[1] and Videotron2K.PREFIX_MASK == 0L) {
                args[1].toInt()
            }
            else {
                throw UnknownVariableType(args[1])
            }
        }
        instSet[MOV shr 3] = { instance, args -> // MOV register value
            if (args.size != 2) throw ArgsCountMismatch(2, args)
            checkRegisterLH(args[0])
            instance.regs.setInt((args[0] and 0xF) * 4, resolveVar(instance, args[1]))
        }
        instSet[MUL shr 3] = { instance, args -> // MUL ACC LH RH
            twoArgArithmetic(instance, args) { a,b -> a*b }
        }
        instSet[ADD shr 3] = { instance, args -> // ADD ACC LH RH
            twoArgArithmetic(instance, args) { a,b -> a+b }
        }
        instSet[MOD shr 3] = { instance, args -> // MOD ACC LH RH
            twoArgArithmetic(instance, args) { a,b -> a fmod b }
        }
        instSet[INC shr 3] = { instance, args -> // INC register
            if (args.size != 1) throw ArgsCountMismatch(1, args)
            checkRegisterLH(args[0])
            instance.regs.setInt((args[0] and 0xF) * 4, 1 + instance.regs.getInt((args[0] and 0xF) * 4))
        }
        instSet[DEC shr 3] = { instance, args -> // DEC register
            if (args.size != 1) throw ArgsCountMismatch(1, args)
            checkRegisterLH(args[0])
            instance.regs.setInt((args[0] and 0xF) * 4, 1 - instance.regs.getInt((args[0] and 0xF) * 4))
        }
        instSet[NEXT shr 3] = { instance, _ ->
            instance.regs.setInt((Videotron2K.REG_FRM and 0xF) * 4, 1 + instance.regs.getInt((Videotron2K.REG_FRM and 0xF) * 4))
            instance.sleepLatch = true

            val timeTook = (System.nanoTime() - instance.performanceCounterTmr).toDouble()
            instance.statsFrameTime = timeTook * 0.000001
            instance.performanceCounterTmr = System.nanoTime()
        }
        instSet[CMP shr 3] = { instance, args -> // CMP rA rB rC
            twoArgArithmetic(instance, args) { a,b -> if (a>b) 1 else if (a<b) -1 else 0 }
        }
        instSet[PLOT shr 3] = { instance, args -> // PLOT vararg-bytes
            if (args.isNotEmpty()) {
                val px = instance.regs.getInt((Videotron2K.REG_PX and 0xF) * 4)
                val py = instance.regs.getInt((Videotron2K.REG_PY and 0xF) * 4)
                val width = instance.variableMap[Videotron2K.VARIABLE_WIDTH]!!
                val memAddr = py * width + px

                args.forEachIndexed { index, variable ->
                    val value = resolveVar(instance, variable).toByte()
                    instance.gpu?.poke(memAddr.toLong() + index, value)
                }

                // write back auto-incremented value
                instance.regs.setInt((Videotron2K.REG_PX and 0xF) * 4, (px + args.size) fmod width)
            }
        }
        instSet[PERFORM shr 3] = { instance, args -> // PERFORM scene
            instance.callStack.push(instance.currentScene to instance.currentLineIndex)
            instance.currentScene = args[0]
            instance.currentLineIndex = -1
        }
        instSet[EXIT shr 3] = { instance, _ ->
            val (scene, line) = instance.callStack.pop()
            instance.currentScene = scene
            instance.currentLineIndex = line
            //println("EXIT!")
            //Thread.sleep(1000L)
        }
        instSet[EXEUNT shr 3] = { instance, _ ->
            instance.exeunt = true
        }
    }

    private inline fun twoArgArithmetic(instance: Videotron2K, args: LongArray, operation: (Int, Int) -> Int) {
        if (args.size != 3) throw ArgsCountMismatch(3, args)
        checkRegisterLH(args[0])
        val lh = resolveVar(instance, args[1])
        val rh = resolveVar(instance, args[2])
        instance.regs.setInt((args[0] and 0xF) * 4, operation(lh, rh))
    }

    fun checkConditionAndRun(inst: Int, instance: Videotron2K, args: LongArray) {
        val opcode = inst shr 3
        val condCode = inst and 7

        if (condCode == 0) {
            //if (inst !in transferInst) instance.currentLineIndex += 1
            instSet[opcode].invoke(instance, args)
            return
        }

        val condition = when (condCode) {
            1 -> resolveVar(instance, args[0]) == 0
            2 -> resolveVar(instance, args[0]) != 0
            3 -> resolveVar(instance, args[0]) > 0
            4 -> resolveVar(instance, args[0]) < 0
            5 -> resolveVar(instance, args[0]) >= 0
            6 -> resolveVar(instance, args[0]) <= 0
            else -> throw InternalError()
        }

        if (condition) {
            //if (inst !in transferInst) instance.currentLineIndex += 1
            instSet[opcode].invoke(instance, args.sliceArray(1 until args.size))
        }
    }

    private fun resolveVar(instance: Videotron2K, arg: Long): Int {
        return if (arg and Videotron2K.REGISTER_PREFIX == Videotron2K.REGISTER_PREFIX) {
            instance.regs.getInt((arg and 0xF) * 4)
        }
        else if (arg and Videotron2K.VARIABLE_PREFIX == Videotron2K.VARIABLE_PREFIX) {
            instance.variableMap[arg] ?: throw NullVar()
        }
        else arg.toInt()
    }

    private fun checkRegisterLH(arg: Long) {
        if (arg and Videotron2K.REGISTER_PREFIX != Videotron2K.REGISTER_PREFIX) {
            throw BadLeftHand("register")
        }
    }

    private infix fun Int.fmod(other: Int) = Math.floorMod(this, other)
}

internal class ArgsCountMismatch(expected: Int, args: LongArray) : RuntimeException("Argument count mismatch: expected $expected, got ${args.size}")
internal class UnknownVariableType(arg: Long) : RuntimeException("Unknown variable type: ${arg.ushr(32).toString(16)}")
internal class NullVar : RuntimeException("Variable is undeclared")
internal class BadLeftHand(type: String) : RuntimeException("Left-hand argument is not $type")
internal class BadRightHand(type: String) : RuntimeException("Right-hand argument is not $type")
