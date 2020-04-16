package net.torvald.tsvm

import javax.script.ScriptContext
import javax.script.ScriptEngineManager
import javax.script.SimpleScriptContext

abstract class VMRunner(val extension: String) {

    var thread = Thread()
    abstract fun executeCommand(command: String)

}

object VMRunnerFactory {

    operator fun invoke(vm: VM, extension: String): VMRunner {
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
            "kt", "kts" -> {
                object : VMRunner(extension) {
                    init {
                        TODO()
                    }

                    override fun executeCommand(command: String) {
                        TODO()
                    }
                }
            }
            "js" -> {
                object : VMRunner(extension) {
                    private val engine = ScriptEngineManager().getEngineByExtension("js")!!
                    private val context = SimpleScriptContext()
                    private val bind = context.getBindings(ScriptContext.ENGINE_SCOPE)

                    init {
                        engine.eval("true") as Boolean // init the engine here

                        bind.put("poke", { a: Long, b: Byte -> vm.poke(a, b) })
                        bind.put("nanotime", { System.nanoTime() })
                    }

                    override fun executeCommand(command: String) {
                        thread = Thread {
                            engine.eval(command, context)
                        }
                        thread.start()
                    }
                }
            }
            else -> throw UnsupportedOperationException("Unsupported script extension: $extension")
        }
    }

}