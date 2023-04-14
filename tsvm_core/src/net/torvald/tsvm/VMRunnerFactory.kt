package net.torvald.tsvm

import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.vdc.Videotron2K
import org.graalvm.polyglot.Context
import org.graalvm.polyglot.HostAccess
import java.io.FileReader
import javax.script.ScriptEngineManager

abstract class VMRunner(val extension: String) {
    abstract suspend fun evalGlobal(command: String) // Ring 0
    abstract suspend fun executeCommand(command: String) // Ring 1
    abstract fun eval(command: String) // Ring 2 (for child processes spawned using Parallel API)
    abstract fun close()
}

object VMRunnerFactory {

    private var firstTime = true

    operator fun invoke(assetsRoot: String, vm: VM, extension: String): VMRunner {

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

                    override fun eval(command: String) {
                        TODO("Not yet implemented")
                    }

                    override suspend fun evalGlobal(command: String) {
                        TODO("Not yet implemented")
                    }

                    override fun close() {
                        TODO("Not yet implemented")
                    }
                }
            }
            "js" -> {
                object : VMRunner(extension) {
                    private val ringOneParallel = Parallel(vm)
                    private val ringTwoParallel = ParallelDummy()

                    private val context = Context.newBuilder("js")
                        .allowHostAccess(HostAccess.ALL)
                        .allowHostClassLookup { false }
                        .allowIO(false)
                        .build()
                    private val bind = context.getBindings("js")

                    init {
                        // see https://github.com/graalvm/graaljs/blob/master/docs/user/ScriptEngine.md
                        bind.putMember("polyglot.js.allowHostAccess", true)
                        bind.putMember("js.console", false)

                        bind.putMember("sys", VMJSR223Delegate(vm)) // TODO use delegator class to access peripheral (do not expose VM itself)
                        bind.putMember("graphics", GraphicsJSR223Delegate(vm))
                        bind.putMember("serial", VMSerialDebugger(vm))
                        bind.putMember("gzip", CompressorDelegate(vm))
                        bind.putMember("base64", Base64Delegate(vm))
                        bind.putMember("com", SerialHelperDelegate(vm))
                        bind.putMember("dma", DMADelegate(vm))
                        bind.putMember("audio", AudioJSR223Delegate(vm))
                        bind.putMember("parallel", ringOneParallel)

                        val fr = this::class.java.classLoader.getResourceAsStream("net/torvald/tsvm/JS_INIT.js")
                        val prg = fr.readAllBytes().decodeToString()
                        context.eval("js", sanitiseJS(prg))
                    }

                    override suspend fun executeCommand(command: String) {
                        try {
                            bind.putMember("parallel", ringOneParallel)
                            context.eval("js", encapsulateJS(sanitiseJS(command)))
                        }
                        catch (e: javax.script.ScriptException) {
                            System.err.println("ScriptException from the script:")
                            System.err.println(command.substring(0, minOf(1024, command.length)))
                            throw e
                        }
                    }

                    override fun eval(command: String) {
                        try {
                            bind.putMember("parallel", ringTwoParallel)
                            context.eval("js", encapsulateJS(sanitiseJS(command)))
                        }
                        catch (e: javax.script.ScriptException) {
                            System.err.println("ScriptException from the script:")
                            System.err.println(command.substring(0, minOf(1024, command.length)))
                            throw e
                        }                    }

                    override suspend fun evalGlobal(command: String) {
                        bind.putMember("parallel", ringOneParallel)
                        context.eval("js", "\"use strict\";" + sanitiseJS(command))
                    }

                    override fun close() {
                        context.close(true)
                    }
                }
            }
            else -> throw UnsupportedOperationException("Unsupported script extension: $extension")
        }
    }


    private fun sanitiseJS(code: String) = code//.replace("\\", "\\\\")
    private fun encapsulateJS(code: String) = "\"use strict\";(function(){$code})()"

}
