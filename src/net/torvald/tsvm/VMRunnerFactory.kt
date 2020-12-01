package net.torvald.tsvm

import jdk.nashorn.api.scripting.NashornScriptEngineFactory
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
                    private val engine: ScriptEngine = ScriptEngineManager().getEngineByName("Graal.js")
                    private val bind = engine.getBindings(ScriptContext.ENGINE_SCOPE)

                    init {
                        // see https://github.com/graalvm/graaljs/blob/master/docs/user/ScriptEngine.md
                        bind.put("polyglot.js.allowHostAccess", true)

                        bind.put("sys", VMJSR223Delegate(vm)) // TODO use delegator class to access peripheral (do not expose VM itself)
                        bind.put("graphics", GraphicsJSR223Delegate(vm))
                        bind.put("serial", VMSerialDebugger(vm))
                        bind.put("gzip", CompressorDelegate)
                        bind.put("base64", Base64Delegate)
                        bind.put("com", SerialHelperDelegate(vm))

                        val fr = FileReader("./assets/JS_INIT.js")
                        val prg = fr.readText()
                        fr.close()
                        engine.eval(sanitiseJS(prg))
                    }

                    override suspend fun executeCommand(command: String) {
                        try {
                            engine.eval(encapsulateJS(sanitiseJS(command)))
                        }
                        catch (e: javax.script.ScriptException) {
                            System.err.println("ScriptException from the script:")
                            System.err.println(command.substring(0, minOf(1024, command.length)))
                            throw e
                        }
                    }

                    override suspend fun evalGlobal(command: String) {
                        engine.eval("\"use strict\";" + sanitiseJS(command))
                    }
                }
            }
            else -> throw UnsupportedOperationException("Unsupported script extension: $extension")
        }
    }


    private fun sanitiseJS(code: String) = code//.replace("\\", "\\\\")
    private fun encapsulateJS(code: String) = "\"use strict\";(function(){$code})()"

}
