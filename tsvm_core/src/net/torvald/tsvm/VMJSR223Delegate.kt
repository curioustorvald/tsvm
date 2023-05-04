package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.UnsafePtr
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUlong
import net.torvald.tsvm.peripheral.*

/**
 * Pass the instance of the class to the ScriptEngine's binding, preferably under the namespace of "vm"
 */
class VMJSR223Delegate(private val vm: VM) {

    private fun relPtrInDev(from: Long, len: Long, start: Int, end: Int) =
        (from in start..end && (from + len) in start..end)

    private fun getDev(from: Long, len: Long, isDest: Boolean): Long? {
        return if (from >= 0) vm.usermem.ptr + from
        // MMIO area
        else if (from in -1048576..-1 && (from - len) in -1048577..-1) {
            val fromIndex = (-from-1) / 131072
            val dev = vm.peripheralTable[fromIndex.toInt()].peripheral ?: return null
            val fromRel = (-from-1) % 131072
            if (fromRel + len > 131072) return null

            return if (dev is IOSpace) {
                if (relPtrInDev(fromRel, len, 1024, 2047)) dev.peripheralFast.ptr + fromRel - 1024
                else if (relPtrInDev(fromRel, len, 4096, 8191)) (if (isDest) dev.blockTransferTx[0] else dev.blockTransferRx[0]).ptr + fromRel - 4096
                else if (relPtrInDev(fromRel, len, 8192, 12287)) (if (isDest) dev.blockTransferTx[1] else dev.blockTransferRx[1]).ptr + fromRel - 8192
                else if (relPtrInDev(fromRel, len, 12288, 16383)) (if (isDest) dev.blockTransferTx[2] else dev.blockTransferRx[2]).ptr + fromRel - 12288
                else if (relPtrInDev(fromRel, len, 16384, 20479)) (if (isDest) dev.blockTransferTx[3] else dev.blockTransferRx[3]).ptr + fromRel - 16384
                else null
            }
            else if (dev is AudioAdapter) {
                if (relPtrInDev(fromRel, len, 64, 2367)) dev.mediaDecodedBin.ptr + fromRel - 64
                else if (relPtrInDev(fromRel, len, 2368, 4096)) dev.mediaFrameBin.ptr + fromRel - 2368
                else null
            }
            else if (dev is GraphicsAdapter) {
                if (relPtrInDev(fromRel, len, 1024, 2047)) dev.scanlineOffsets.ptr + fromRel - 1024
                else if (relPtrInDev(fromRel, len, 2048, 4095)) dev.mappedFontRom.ptr + fromRel - 2048
                else if (relPtrInDev(fromRel, len, 65536, 131071)) dev.instArea.ptr + fromRel - 65536
                else null
            }
            else null
        }
        // memory area
        else {
            val fromIndex = (-from-1) / 1048576
            val dev = vm.peripheralTable[fromIndex.toInt()].peripheral ?: return null
            val fromRel = (-from-1) % 1048576
            if (fromRel + len > 1048576) return null

            return if (dev is AudioAdapter) {
                if (relPtrInDev(fromRel, len, 0, 114687)) dev.sampleBin.ptr + fromRel - 0
                else null
            }
            else if (dev is GraphicsAdapter) {
                if (relPtrInDev(fromRel, len, 0, 250879)) dev.framebuffer.ptr + fromRel - 0
                else if (relPtrInDev(fromRel, len, 250880, 251903)) dev.unusedArea.ptr + fromRel - 250880
                else if (relPtrInDev(fromRel, len, 253950, 261631)) dev.textArea.ptr + fromRel - 253950
                else if (relPtrInDev(fromRel, len, 262144, 513023)) dev.framebuffer2?.ptr?.plus(fromRel)?.minus(253950)
                else null
            }
            else if (dev is RamBank) {
                if (relPtrInDev(fromRel, len, 0, 524287))
                    dev.mem.ptr + 524288*dev.map0 + fromRel
                else if (relPtrInDev(fromRel, len, 524288, 131071))
                    dev.mem.ptr + 524288*dev.map1 + fromRel - 524288
                else
                    null
            }
            else null
        }
    }

    fun getVmId() = vm.id.toString()

    fun poke(addr: Int, value: Int) = vm.poke(addr.toLong(), value.toByte())
    fun peek(addr: Int) = vm.peek(addr.toLong())!!.toInt().and(255)
    fun nanoTime() = System.nanoTime()
    fun malloc(size: Int) = vm.malloc(size)
    fun free(ptr: Int) = vm.free(ptr)
    fun memcpy(from: Int, to: Int, len: Int) {
        val from = from.toLong()
        val to = to.toLong()
        val len = len.toLong()

        val fromVector = if (from >= 0) 1 else -1
        val toVector = if (to >= 0) 1 else -1
        val fromDev = getDev(from, len, false)
        val toDev = getDev(to, len, true)

//        println("from = $from, to = $to")
//        println("fromDev = $fromDev, toDev = $toDev")

        if (fromDev != null && toDev != null)
            UnsafeHelper.memcpy(fromDev, toDev, len)
        else if (fromDev == null && toDev != null) {
            val buf = UnsafeHelper.allocate(len, this)
            for (i in 0 until len) buf[i] = vm.peek(from + i*fromVector)!!
            UnsafeHelper.memcpy(buf.ptr, toDev, len)
            buf.destroy()
        }
        else if (fromDev != null) {
            for (i in 0 until len) vm.poke(to + i*toVector, UnsafeHelper.unsafe.getByte(fromDev + i))
        }
        else {
            for (i in 0 until len) vm.poke(to + i*toVector, vm.peek(from + i*fromVector)!!)
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
            Thread.sleep(1L)
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

class VMSerialDebugger(private val vm: VM) {
    fun print(s: Any?) = System.out.print("$s")
    fun println(s: Any?) = System.out.println("$s")
    fun printerr(s: Any?) = System.err.println("$s")
}

class Parallel(private val vm: VM) {
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