package net.torvald.tsvm

import javax.script.Compilable
import javax.script.ScriptContext
import javax.script.ScriptEngineManager
import javax.script.SimpleScriptContext
import kotlin.test.assertNotNull

abstract class VMRunner(val extension: String) {

    var thread = Thread()
    abstract fun executeCommand(command: String)

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

                    override fun executeCommand(command: String) {
                        thread = Thread {
                            vmLua.lua.load(command).call()
                        }
                        thread.start()
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
                        bind.put("vm", VMJSR223Delegate(vm)) // TODO use delegator class to access peripheral (do not expose VM itself)
                        bind.put("graphics", GraphicsJSR223Delegate(vm))
                        //bind.put("poke", { a: Long, b: Byte -> vm.poke(a, b) }) // kts: lambda does not work...
                        //bind.put("nanotime", { System.nanoTime() })
                    }

                    override fun executeCommand(command: String) {
                        thread = Thread {
                            //(engine as Compilable).compile(command).eval(context) // compiling does not work with bindings in kts
                            engine.eval(command, context)
                        }
                        thread.start()
                    }
                }
            }
            //else -> throw UnsupportedOperationException("Unsupported script extension: $extension")
        }
    }
}