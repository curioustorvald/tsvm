package net.torvald.tsvm

import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.vdc.Videotron2K
import java.io.FileReader
import javax.script.ScriptContext
import javax.script.ScriptEngineManager
import javax.script.SimpleScriptContext
import kotlin.test.assertNotNull

abstract class VMRunner(val extension: String) {

    abstract suspend fun executeCommand(command: String)
    abstract suspend fun evalGlobal(command: String)

}

object VMRunnerFactory {

    private var firstTime = true

    operator fun invoke(vm: VM, extension: String): VMRunner {

        if (firstTime) {
            firstTime = false
            ScriptEngineManager().engineFactories.forEach {
                println("[VMRunnerFactory] ext: ${it.extensions}, name: ${it.engineName}")
            }
        }

        return when (extension) {
            "lua" -> {
                object : VMRunner(extension) {

                    private val vmLua = VMLuaAdapter(vm)

                    override suspend fun executeCommand(command: String) {
                        vmLua.lua.load(command).call()
                    }

                    override suspend fun evalGlobal(command: String) {
                        TODO("Not yet implemented")
                    }
                }
            }
            "vt2" -> {
                object : VMRunner(extension) {

                    val engine =
                        Videotron2K(vm.findPeribyType(VM.PERITYPE_GPU_AND_TERM)!!.peripheral!! as GraphicsAdapter)

                    override suspend fun executeCommand(command: String) {
                        engine.eval(command)
                    }

                    override suspend fun evalGlobal(command: String) {
                        TODO("Not yet implemented")
                    }
                }
            }
            else -> {
                object : VMRunner(extension) {
                    private val engine = ScriptEngineManager().getEngineByExtension(extension)

                    init {
                        assertNotNull(engine, "Script engine for extension $extension not found")
                    }

                    private val context = SimpleScriptContext()
                    private val bind = context.getBindings(ScriptContext.ENGINE_SCOPE)

                    init {
                        bind.put("sys", VMJSR223Delegate(vm)) // TODO use delegator class to access peripheral (do not expose VM itself)
                        bind.put("graphics", GraphicsJSR223Delegate(vm))
                        //bind.put("poke", { a: Long, b: Byte -> vm.poke(a, b) }) // kts: lambda does not work...
                        //bind.put("nanotime", { System.nanoTime() })
                        bind.put("serial", VMSerialDebugger(vm))

                        if (extension == "js") {
                            val fr = FileReader("./assets/JS_INIT.js")
                            val prg = fr.readText()
                            fr.close()
                            engine.eval(toSingleLine(prg), context)
                        }
                    }

                    override suspend fun executeCommand(command: String) {
                        engine.eval("\"use strict\";" + sanitiseJS(toSingleLine(command)), context)
                    }

                    override suspend fun evalGlobal(command: String) {
                        engine.eval("\"use strict\";" + toSingleLine(command), context)
                    }
                }
            }
            //else -> throw UnsupportedOperationException("Unsupported script extension: $extension")
        }
    }


    private fun toSingleLine(code: String) = code.replace(Regex("//[^\\n]*"), "").replace('\n', ' ')
    private fun sanitiseJS(code: String) = "eval('${toSingleLine(code).replace("\\", "\\\\")}')"

}
