package net.torvald.tsvm

import com.badlogic.gdx.utils.GdxRuntimeException
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.peripheral.ReferenceGraphicsAdapter2

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
     * @param coroutineJobs Hashmap on the host of VMs that holds the coroutine-job object for the currently running VM-instance. Key: Int(VM's identifier), value: [kotlinx.coroutines.Job]
     */
    fun initVMenv(vm: VM, gpu: GraphicsAdapter, vmRunners: HashMap<Int, VMRunner>, coroutineJobs: HashMap<Int, Job>) {
        vm.init()

        try {
            vm.peripheralTable.getOrNull(1)?.peripheral?.dispose()
        }
        catch (_: GdxRuntimeException) {} // pixmap already disposed

        vm.peripheralTable[1] = PeripheralEntry(gpu)//, GraphicsAdapter.VRAM_SIZE, 16, 0)

        vm.getPrintStream = { gpu.getPrintStream() }
        vm.getErrorStream = { gpu.getErrorStream() }
        vm.getInputStream = { gpu.getInputStream() }

        vmRunners[vm.id] = VMRunnerFactory(vm.assetsDir, vm, "js")
        coroutineJobs[vm.id] = GlobalScope.launch { vmRunners[vm.id]?.executeCommand(vm.roms[0]!!.readAll()) }
    }

    /**
     * Standard function to stop a VM. The VM will be in "ready" state for the next initialisation.
     *
     * @param vm VM to initialise
     * @param vmRunners Hashmap on the host of VMs that holds the instances of the VMRunners for the given VM. Key: Int(VM's identifier), value: [net.torvald.tsvm.VMRunner]
     * @param coroutineJobs Hashmap on the host of VMs that holds the coroutine-job object for the currently running VM-instance. Key: Int(VM's identifier), value: [kotlinx.coroutines.Job]
     */
    fun killVMenv(vm: VM, vmRunners: HashMap<Int, VMRunner>, coroutineJobs: HashMap<Int, Job>) {
        vm.park()

        for (i in 1 until vm.peripheralTable.size) {
            vm.peripheralTable[i].peripheral?.dispose()
        }

        vm.getPrintStream = { TODO() }
        vm.getErrorStream = { TODO() }
        vm.getInputStream = { TODO() }

        vmRunners[vm.id]?.close()
        coroutineJobs[vm.id]?.cancel("VM kill command received")
    }

}