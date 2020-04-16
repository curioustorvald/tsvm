package net.torvald.tsvm

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
            else -> throw UnsupportedOperationException("Unsupported script extension: $extension")
        }
    }

}