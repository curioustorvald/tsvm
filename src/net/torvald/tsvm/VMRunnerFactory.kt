package net.torvald.tsvm

import jdk.nashorn.api.scripting.NashornScriptEngineFactory
import jdk.nashorn.api.scripting.ScriptUtils
import jdk.nashorn.internal.runtime.regexp.joni.Syntax.Java
import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.vdc.Videotron2K
import java.io.FileReader
import javax.script.ScriptContext
import javax.script.ScriptEngine
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
            "js" -> {
                object : VMRunner(extension) {
                    private val engine: ScriptEngine// = ScriptEngineManager().getEngineByExtension(extension)

                    init {
                        val engineFactory = NashornScriptEngineFactory()
                        engine = engineFactory.getScriptEngine("-strict", "--no-java", "--no-syntax-extensions", "--language=es6")
                        assertNotNull(engine, "Script engine for extension $extension not found")
                    }

                    private val context = SimpleScriptContext()
                    private val bind = context.getBindings(ScriptContext.ENGINE_SCOPE)

                    init {
                        bind.put("sys", VMJSR223Delegate(vm)) // TODO use delegator class to access peripheral (do not expose VM itself)
                        bind.put("graphics", GraphicsJSR223Delegate(vm))
                        bind.put("serial", VMSerialDebugger(vm))
                        bind.put("gzip", CompressorDelegate())
                        bind.put("base64", Base64Delegate())
                        bind.put("com", SerialHelperDelegate(vm))

                        if (extension == "js") {
                            val fr = FileReader("./assets/JS_INIT.js")
                            val prg = fr.readText()
                            fr.close()
                            engine.eval(sanitiseJS(prg), context)
                        }
                    }

                    override suspend fun executeCommand(command: String) {
                        try {
                            engine.eval("\"use strict\";" + encapsulateJS(sanitiseJS(command)), context)
                        }
                        catch (e: javax.script.ScriptException) {
                            System.err.println("ScriptException from the script:")
                            System.err.println(command.substring(0, minOf(1024, command.length)))
                            throw e
                        }
                    }

                    override suspend fun evalGlobal(command: String) {
                        engine.eval("\"use strict\";" + sanitiseJS(command), context)
                    }
                }
            }
            else -> throw UnsupportedOperationException("Unsupported script extension: $extension")
        }
    }


    private fun sanitiseJS(code: String) = code//.replace("\\", "\\\\")
    private fun encapsulateJS(code: String) = "(function(){$code})()"

}
