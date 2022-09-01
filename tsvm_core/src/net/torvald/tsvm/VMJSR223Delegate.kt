package net.torvald.tsvm

import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUlong
import net.torvald.tsvm.peripheral.IOSpace
import java.nio.charset.Charset

/**
 * Pass the instance of the class to the ScriptEngine's binding, preferably under the namespace of "vm"
 */
class VMJSR223Delegate(val vm: VM) {

    fun poke(addr: Int, value: Int) = vm.poke(addr.toLong(), value.toByte())
    fun peek(addr: Int) = vm.peek(addr.toLong())!!.toInt().and(255)
    fun nanoTime() = System.nanoTime()
    fun malloc(size: Int) = vm.malloc(size)
    fun free(ptr: Int) = vm.free(ptr)
    fun memcpy(from: Int, to: Int, len: Int) {
        val len = len.toLong()
        // some special cases for native memcpy
        val ioSpace = vm.peripheralTable[0].peripheral!! as IOSpace
        // within scratchpad memory?
        if (from in 0 until 8388608 && (to + len) in 0 until 8388608)
            UnsafeHelper.memcpy(vm.usermem.ptr + from, vm.usermem.ptr + to, len)
        // first serial read buffer -> usermem
        else if (from in -4097 downTo -8192 && (to + len) in 0 until 8388608)
            UnsafeHelper.memcpy(ioSpace.blockTransferRx[0].ptr + (-4097 - from), vm.usermem.ptr + to, len)
        // usermem -> first serial write buffer
        else if (from in 0 until 8388608 && (to + len) in -4097L downTo -8192L)
            UnsafeHelper.memcpy(vm.usermem.ptr + from, ioSpace.blockTransferTx[0].ptr + (-4097 - to), len)
        else
            for (i in 0 until len) {
                vm.poke(to + i, vm.peek(from + i)!!)
            }
    }
    fun mapRom(slot: Int) {
        vm.romMapping = slot.and(255)
    }
    fun romReadAll(): String {
        if (vm.romMapping == 255 || vm.romMapping !in vm.roms.indices || vm.roms[vm.romMapping] == null) return ""
        return vm.roms[vm.romMapping]!!.readAll()
    }

    // @return in milliseconds
    fun uptime(): Long {
        vm.poke(-69, -1)
        var r = 0L
        for (i in 0L..7L) {
            r = r or vm.peek(-73 - i)!!.toUlong().shl(8 * i.toInt())
        }
        return r
    }
    fun currentTimeInMills(): Long {
        var r = 0L
        // there's a "hardware bug" where trying to get current time for the first time since boot would just return 0
        // this dirty fix will continuously query the value until nonzero value is returned
//        var q = 1
        do { // quick and dirty hack
//            println("currentTimeInMills spin ${q++}")
            vm.poke(-69, -1)
            Thread.sleep(1L)
            for (i in 0L..7L) {
                r = r or vm.peek(-81 - i)!!.toUlong().shl(8 * i.toInt())
            }
        } while (r == 0L)
        return r
    }

    fun print(s: Any) {
        //System.out.print("[Nashorn] $s")
        //System.out.print(s)
        vm.getPrintStream().write("$s".toByteArray(VM.CHARSET))
    }
    fun println(s: Any = "") {
        System.out.println("[Graal] $s")
        //System.out.println(s)
        vm.getPrintStream().write(("$s\n").toByteArray(VM.CHARSET))
    }

    /**
     * @return key being hit, of which:
     * a-zA-Z1-9: corresponding ASCII code
     *
     * Up: 200
     * Left: 203
     * Down: 208
     * Right: 205
     *
     * PgUp: 201
     * PgDn: 209
     * Home: 199
     * End: 207
     * Ins: 201
     * Del: 211
     *
     * Return: 13 (^M)
     * Bksp: 8 (^H)
     *
     * ^A-^Z: 1 through 26
     */
    fun readKey(): Int {
        val inputStream = vm.getInputStream()
        var key: Int = inputStream.read()
        inputStream.close()
        return key
    }

    /**
     * Read series of key inputs until Enter/Return key is pressed. Backspace will work but any other non-printable
     * characters (e.g. arrow keys) won't work.
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
        this.print("\n") // printout \n

        inputStream.close()
        return sb.toString()
    }

    /**
     * Read series of key inputs until Enter/Return key is pressed. Backspace will work but any other non-printable
     * characters (e.g. arrow keys) won't work.
     */
    fun readNoEcho(): String {
        val inputStream = vm.getInputStream()
        val sb = StringBuilder()
        var key: Int
        do {
            key = inputStream.read()

            when (key) {
                8 -> if (sb.isNotEmpty()) sb.deleteCharAt(sb.lastIndex)
                in 0x20..0x7E -> sb.append(key.toChar())
            }
        } while (key != 13 && key != 10)
        this.println() // printout \n

        inputStream.close()
        return sb.toString()
    }

    fun spin() {
        Thread.sleep(4L)
    }

    fun sleep(time: Long) {
        Thread.sleep(time)
    }

    fun waitForMemChg(addr: Int, andMask: Int, xorMask: Int) {
        while ((peek(addr) xor xorMask) and andMask == 0) {
            spin();
        }
    }
    fun waitForMemChg(addr: Int, andMask: Int) = waitForMemChg(addr, andMask, 0)

    fun getUsedMem() = vm.allocatedBlockCount * vm.MALLOC_UNIT

    fun getSysrq() = vm.sysrqDown
    fun unsetSysrq() {
        vm.sysrqDown = false
    }

    fun maxmem(): Int {
        return vm.memsize.toInt()
    }
    fun getMallocStatus(): IntArray {
        return intArrayOf(vm.MALLOC_UNIT, vm.allocatedBlockCount)
    }
}

class VMSerialDebugger(val vm: VM) {
    fun print(s: Any?) = System.out.print("$s")
    fun println(s: Any?) = System.out.println("$s")
    fun printerr(s: Any?) = System.err.println("$s")
}

class Parallel(val vm: VM) {
    fun spawnNewContext(): VMRunner {
        return VMRunnerFactory(vm.assetsDir, vm, "js")
    }
    fun attachProgram(name: String, context: VMRunner, program: String): Thread {
        Thread({ context.eval(program) }, name).let {
            vm.contexts.add(it)
            return it
        }
    }
    fun launch(thread: Thread) {
        thread.start()
    }
    fun suspend(thread: Thread) {
        thread.suspend()
    }
    fun resume(thread: Thread) {
        thread.resume()
    }
    fun kill(thread: Thread) {
        thread.interrupt()
        vm.contexts.remove(thread)
    }
    fun getThreadPool() = vm.contexts
}

class ParallelDummy()