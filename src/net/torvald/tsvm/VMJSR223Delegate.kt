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
        vm.getPrintStream().write(s.toByteArray())
    }
    fun println(s: String) {
        //println("[Nashorn] $s")
        vm.getPrintStream().write((s + '\n').toByteArray())
    }
    fun println() = print('\n')

    //fun readKey() = vm.inputStream.read()

    /**
     * Read series of key inputs until Enter/Return key is pressed
     */
    fun read(): String {
        val inputStream = vm.getInputStream()
        val sb = StringBuilder()
        var key: Int
        do {
            key = inputStream.read()

            if ((key == 8 && sb.isNotEmpty()) || key in 0x20..0x7E) {
                this.print("${key.toChar()}")
            }

            when (key) {
                8 -> if (sb.isNotEmpty()) sb.deleteCharAt(sb.lastIndex)
                in 0x20..0x7E -> sb.append(key.toChar())
            }
        } while (key != 13 && key != 10)
        this.println()

        inputStream.close()
        return sb.toString()
    }
}

class VMSerialDebugger(val vm: VM) {
    fun println(s: String) = System.out.println(s)
}