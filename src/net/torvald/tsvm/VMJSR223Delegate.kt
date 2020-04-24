package net.torvald.tsvm

import net.torvald.tsvm.peripheral.GraphicsAdapter

/**
 * Pass the instance of the class to the ScriptEngine's binding, preferably under the namespace of "vm"
 */
class VMJSR223Delegate(val vm: VM) {

    fun poke(addr: Int, value: Int) = vm.poke(addr.toLong(), value.toByte())
    fun peek(addr: Int) = vm.peek(addr.toLong())
    fun nanoTime() = System.nanoTime()
    fun dmagload(from: Int, to: Int, length: Int) {
        val periid = vm.findPeribyType("gpu")
        if (periid == null)
            throw IllegalStateException("GPU not found")
        else {
            (vm.peripheralTable[periid].peripheral as GraphicsAdapter).bulkLoad(vm, from.toLong(), to.toLong(), length.toLong())
        }
    }

}