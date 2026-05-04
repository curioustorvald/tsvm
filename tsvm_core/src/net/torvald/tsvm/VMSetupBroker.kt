package net.torvald.tsvm

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.utils.GdxRuntimeException
import com.badlogic.gdx.utils.JsonValue
import net.torvald.tsvm.peripheral.BlockTransferInterface
import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.peripheral.PeriBase
import net.torvald.tsvm.peripheral.VMProgramRom

/**
 * Created by minjaesong on 2022-12-15.
 */
object VMSetupBroker {

    /**
     * Standard function to start a VM.
     *
     * @param vm VM to initialise
     * @param gpu Display device to attach
     * @param vmRunners Hashmap on the host of VMs that holds the instances of the VMRunners for the given VM. Key: Int(VM's identifier), value: [net.torvald.tsvm.VMRunner]
     * @param coroutineJobs Hashmap on the host of VMs that holds the coroutine-job object for the currently running VM-instance. Key: Int(VM's identifier), value: [kotlin.coroutines.Job]
     */
    fun initVMenv(vm: VM, profileJson: JsonValue, profileName: String, gpu: GraphicsAdapter, vmRunners: HashMap<VmId, VMRunner>, coroutineJobs: HashMap<VmId, Thread>, whatToDoOnVmException: (Throwable) -> Unit) {
        // Refuse to start a new runner while the previous one is still alive:
        // running both concurrently would race on the VM's memory / IO and lead
        // to mixed text input, garbled rendering, and SIGSEGV on disposed peripherals.
        coroutineJobs[vm.id]?.let { old ->
            if (old.isAlive) {
                System.err.println("[VMSetupBroker] previous runner for ${vm.id} is still alive; tearing it down before re-init")
                killVMenv(vm, vmRunners, coroutineJobs)
            }
        }

        vm.init()

        try {
            vm.peripheralTable.getOrNull(1)?.peripheral?.dispose()
        }
        catch (_: GdxRuntimeException) {} // pixmap already disposed

        installPeripherals(vm, profileJson, profileName)

        vm.peripheralTable[1] = PeripheralEntry(gpu)//, GraphicsAdapter.VRAM_SIZE, 16, 0)

        vm.getPrintStream = { gpu.getPrintStream() }
        vm.getErrorStream = { gpu.getErrorStream() }
        vm.getInputStream = { gpu.getInputStream() }
        vm.poke(-90L, 0)

        vmRunners[vm.id] = VMRunnerFactory(vm.assetsDir, vm, "js")
        Thread({
            try {
                vmRunners[vm.id]?.executeCommand(vm.roms[0].readAll())
            }
            catch (e: Throwable) {
                whatToDoOnVmException(e)
            }
        }, "VmRunner:${vm.id}").let {
            coroutineJobs[vm.id] = it
            it.start()
        }
    }

    /**
     * Standard function to stop a VM. The VM will be in "ready" state for the next initialisation.
     *
     * @param vm VM to initialise
     * @param vmRunners Hashmap on the host of VMs that holds the instances of the VMRunners for the given VM. Key: Int(VM's identifier), value: [net.torvald.tsvm.VMRunner]
     * @param coroutineJobs Hashmap on the host of VMs that holds the coroutine-job object for the currently running VM-instance. Key: Int(VM's identifier), value: [kotlin.coroutines.Job]
     */
    fun killVMenv(vm: VM, vmRunners: HashMap<VmId, VMRunner>, coroutineJobs: HashMap<VmId, Thread>) {

        // Order is critical: stop ALL execution first, then dispose peripherals.
        // If we disposed peripherals while the runner thread is still alive, the
        // thread would touch destroyed UnsafePtrs and SIGSEGV.

        // 1. Stop parallel/child contexts. park() interrupts and joins them.
        vm.park()
        vm.poke(-90L, -128)

        // 2. Interrupt the main runner thread and cancel the GraalVM context.
        //    context.close(true) cancels in-flight script evaluation.
        val runnerThread = coroutineJobs[vm.id]
        runnerThread?.interrupt()
        try { vmRunners[vm.id]?.close() } catch (_: Throwable) {}

        // 3. Wait for the main runner thread to actually finish.
        if (runnerThread != null && runnerThread !== Thread.currentThread()) {
            try {
                runnerThread.join(2000L)
                if (runnerThread.isAlive) {
                    // Last resort: re-interrupt and accept that disposal will
                    // happen with the thread still alive. This is logged so
                    // diagnostics surface a stuck VM rather than failing silently.
                    System.err.println("[VMSetupBroker] runner ${vm.id} did not exit within 2s; proceeding anyway")
                    runnerThread.interrupt()
                }
            }
            catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }

        // 4. Now it's safe to release native resources held by peripherals.
        for (i in 1 until vm.peripheralTable.size) {
            try {
                vm.peripheralTable[i].peripheral?.dispose()
            }
            catch (_: Throwable) {}
        }

        // 5. Drop runner / job handles so a subsequent initVMenv won't see stale entries.
        vmRunners.remove(vm.id)
        coroutineJobs.remove(vm.id)

        vm.getPrintStream = { TODO() }
        vm.getErrorStream = { TODO() }
        vm.getInputStream = { TODO() }

    }

    /**
     * You'll want to further init the things using the VM this function returns, such as:
     *
     * ```
     * makeVMfromJson(json.get(NAME)).let{
     *      initVMemv(it)
     *      vms[VIEWPORT_INDEX] = VMRunnerInfo(it, NAME)
     * }
     * ```
     */
    private fun installPeripherals(vm: VM, json: JsonValue, profileName: String): VM {
        println("Processing profile '$profileName'")

        val cardslots = json.getInt("cardslots")

        // install peripherals
        listOf("com1", "com2", "com3", "com4").map { json.get(it) }.forEachIndexed { index, jsonValue ->
            jsonValue?.let { deviceInfo ->
                val className = deviceInfo.getString("cls")

                val loadedClass = Class.forName(className)

                val argTypess = loadedClass.declaredConstructors
                var successful = false
                var k = 0
                // just try out all the possible argTypes
                while (!successful && k < argTypess.size) {
                    try {
                        val argTypes = argTypess[k].parameterTypes

                        println("COM${index+1} loadedClass = $className")
                        println("trying constructor args[${k}/${argTypess.lastIndex}]: ${argTypes.joinToString { it.canonicalName }}")

                        val args = deviceInfo.get("args").allIntoJavaType(argTypes.tail())
                        val loadedClassConstructor = loadedClass.getConstructor(*argTypes)
                        val loadedClassInstance = loadedClassConstructor.newInstance(vm, *args)

                        vm.getIO().blockTransferPorts[index].attachDevice(loadedClassInstance as BlockTransferInterface)
                        println("COM${index+1} = ${loadedClassInstance.javaClass.canonicalName}: ${args.joinToString()}")

                        successful = true
                    }
                    catch (e: IllegalArgumentException) {
//                        e.printStackTrace()
                    }
                    finally {
                        k += 1
                    }
                }
                if (!successful) {
                    throw RuntimeException("Invalid or insufficient arguments for $className in the profile $profileName")
                }

            }
        }
        (2..cardslots).map { it to json.get("card$it") }.forEach { (index, jsonValue) ->
            jsonValue?.let { deviceInfo ->
                val className = deviceInfo.getString("cls")

                println("CARD${index} loadedClass = $className")

                val loadedClass = Class.forName(className)
                val argTypes = loadedClass.declaredConstructors[0].parameterTypes
                val args = deviceInfo.get("args").allIntoJavaType(argTypes.tail())
                val loadedClassConstructor = loadedClass.getConstructor(*argTypes)
                val loadedClassInstance = loadedClassConstructor.newInstance(vm, *args)

                val peri = loadedClassInstance as PeriBase
                vm.peripheralTable[index] = PeripheralEntry(
                    peri
                )
            }
        }

        return vm
    }

    private fun JsonValue.allIntoJavaType(argTypes: Array<Class<*>>): Array<Any?> {
        val values = this.iterator().toList()
        if (values.size != argTypes.size) throw IllegalArgumentException("# of args: ${values.size}, # of arg types: ${argTypes.size}")

        return argTypes.mapIndexed { index, it -> when (it.canonicalName) {
            "float", "java.lang.Float" -> values[index].asFloat()
            "double", "java.lang.Double" -> values[index].asDouble()
            "byte", "java.lang.Byte" -> values[index].asByte()
            "char", "java.lang.Character" -> values[index].asChar()
            "short", "java.lang.Short" -> values[index].asShort()
            "int", "java.lang.Integer" -> values[index].asInt()
            "long", "java.lang.Long" -> values[index].asLong()
            "boolean", "java.lang.Boolean" -> values[index].asBoolean()
            "java.lang.String" -> values[index].asString()
            else -> throw NotImplementedError("No conversion for ${it.canonicalName} exists")
        } }.toTypedArray()
    }

    private fun <T> Array<T>.tail(): Array<T> = this.sliceArray(1..this.lastIndex)

}