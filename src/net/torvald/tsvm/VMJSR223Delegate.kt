package net.torvald.tsvm

import net.torvald.tsvm.peripheral.GraphicsAdapter

/**
 * Pass the instance of the class to the ScriptEngine's binding, preferably under the namespace of "vm"
 */
class VMJSR223Delegate(val vm: VM) {

    fun poke(addr: Int, value: Int) = vm.poke(addr.toLong(), value.toByte())
    fun peek(addr: Int) = vm.peek(addr.toLong())!!.toInt().and(255)
    fun nanoTime() = System.nanoTime()
    fun malloc(size: Int) = vm.malloc(size)
    fun free(ptr: Int) = vm.free(ptr)

    fun print(s: String) {
        //print("[Nashorn] $s")
        vm.printStream.write(s.toByteArray())
    }
    fun println(s: String) {
        //println("[Nashorn] $s")
        vm.printStream.write((s + '\n').toByteArray())
    }

}

class VMSerialDebugger(val vm: VM) {
    fun print(s: String) = System.out.println(s)
}