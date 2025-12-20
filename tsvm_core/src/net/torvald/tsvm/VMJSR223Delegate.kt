package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUlong
import net.torvald.tsvm.peripheral.*
import kotlin.math.absoluteValue

/**
 * Pass the instance of the class to the ScriptEngine's binding, preferably under the namespace of "vm"
 */
class VMJSR223Delegate(private val vm: VM) {

    private fun relPtrInDev(from: Long, len: Long, start: Int, end: Int) =
        (from in start..end && (from + len) in start..end)

    private fun getDev(from: Long, len: Long, isDest: Boolean): Long? {
//        System.err.print("getDev(from=$from, len=$len, isDest=$isDest) -> ")

        return if (from >= 0) {
//            System.err.println("USERMEM offset=$from")

            vm.usermem.ptr + from
        }
        // MMIO area
        else if (from in -1048576..-1 && (from - len) in -1048577..-1) {
            val fromIndex = ((-from-1) / 131072).absoluteValue
            val dev = vm.peripheralTable[fromIndex.toInt()].peripheral ?: return null
            val fromRel = (-from-1) % 131072
            if (fromRel + len > 131072) return null

//            System.err.println("MMIO dev=${dev.typestring}, fromIndex=$fromIndex, fromRel=$fromRel")

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

//            System.err.println("MEMORY dev=${dev.typestring}, fromIndex=$fromIndex, fromRel=$fromRel")

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
    
    // Float memory access functions for TEV video decoder
    fun poke_float(addr: Int, value: Double) {
        val floatBits = value.toFloat().toBits()
        vm.poke(addr.toLong() + 0, (floatBits and 0xFF).toByte())
        vm.poke(addr.toLong() + 1, ((floatBits shr 8) and 0xFF).toByte())
        vm.poke(addr.toLong() + 2, ((floatBits shr 16) and 0xFF).toByte())
        vm.poke(addr.toLong() + 3, ((floatBits shr 24) and 0xFF).toByte())
    }
    
    fun peek_float(addr: Int): Double {
        val b0 = vm.peek(addr.toLong() + 0)!!.toInt().and(255)
        val b1 = vm.peek(addr.toLong() + 1)!!.toInt().and(255)
        val b2 = vm.peek(addr.toLong() + 2)!!.toInt().and(255)
        val b3 = vm.peek(addr.toLong() + 3)!!.toInt().and(255)
        val floatBits = b0 or (b1 shl 8) or (b2 shl 16) or (b3 shl 24)
        return Float.fromBits(floatBits).toDouble()
    }
    
    fun nanoTime() = System.nanoTime()
    fun malloc(size: Int) = vm.malloc(size)
    fun memset(dest: Int, ch: Int, count: Int) = vm.memset(dest, ch, count)
    fun free(ptr: Int) = vm.free(ptr)
    fun forceAlloc(ptr: Int, size: Int) = vm.forceAlloc(ptr, size)
    fun memcpy(from: Int, to: Int, len: Int) {
        val from = from.toLong()
        val to = to.toLong()
        val len = len.toLong()

        val fromVector = if (from >= 0) 1 else -1
        val toVector = if (to >= 0) 1 else -1
        val fromDev = getDev(from, len, false)
        val toDev = getDev(to, len, true)

//        System.err.println("[sys.memcpy] from = $from, to = $to")
//        System.err.println("[sys.memcpy] fromDev = $fromDev, toDev = $toDev")

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
    fun romReadAll(): java.lang.String {
        if (vm.romMapping == 255 || vm.romMapping !in vm.roms.indices || vm.roms[vm.romMapping] == null) return "" as java.lang.String
        return vm.roms[vm.romMapping]!!.readAll() as java.lang.String
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
        //vm.getPrintStream().write("$s".toByteArray(VM.CHARSET))
        val vtIndex = vm.getCurrentVT() // Get current VT from VM context
        val outputStream = vm.getVTOutputStream(vtIndex)
        outputStream.write("$s".toByteArray(VM.CHARSET))
    }
    fun println(s: Any = "") {
        //vm.getPrintStream().write(("$s\n").toByteArray(VM.CHARSET))
        val vtIndex = vm.getCurrentVT() // Get current VT from VM context
        val outputStream = vm.getVTOutputStream(vtIndex)
        outputStream.write("$s\n".toByteArray(VM.CHARSET))
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
        // MMIO-based implementation that can be replicated by JS via MMIO read/writes
        vm.getIO().let {
            it.mmio_write(38, 1) // Set keyboardInputRequested = true (also clears buffer)

            vm.isIdle.set(true)
            while (it.mmio_read(49L) == 0.toByte()) { // Wait for keyPushed flag
                Thread.sleep(6L)
            }
            vm.isIdle.set(false)

            it.mmio_write(38, 0) // Clear keyboardInputRequested
            return it.mmio_read(37L)!!.toUint()  // Read and remove key from buffer
        }
    }

    /**
     * Read series of key inputs until Enter/Return key is pressed. Backspace will work but any other non-printable
     * characters (e.g. arrow keys) won't work.
     */
    fun read(): String {
//        val inputStream = vm.getInputStream()
        val sb = StringBuilder()
        var key: Int
        do {
//            key = inputStream.read()
            key = readKey()

            if ((key == 8 && sb.isNotEmpty()) || key in 0x20..0x7E) {
                this.print("${key.toChar()}")
            }

            when (key) {
                8 -> if (sb.isNotEmpty()) sb.deleteCharAt(sb.lastIndex)
                in 0x20..0x7E -> sb.append(key.toChar())
            }
        } while (key != 13 && key != 10)
        this.print("\n") // printout \n

//        inputStream.close()
        return sb.toString()
    }

    /**
     * Read series of key inputs until Enter/Return key is pressed. Backspace will work but any other non-printable
     * characters (e.g. arrow keys) won't work.
     */
    fun readNoEcho(): String {
//        val inputStream = vm.getInputStream()
        val sb = StringBuilder()
        var key: Int
        do {
//            key = inputStream.read()
            key = readKey()

            when (key) {
                8 -> if (sb.isNotEmpty()) sb.deleteCharAt(sb.lastIndex)
                in 0x20..0x7E -> sb.append(key.toChar())
            }
        } while (key != 13 && key != 10)
        this.println() // printout \n

//        inputStream.close()
        return sb.toString()
    }

    fun spin() {
        vm.isIdle.set(true)
        Thread.sleep(4L)
        vm.isIdle.set(false)
    }

    fun sleep(time: Long) {
        vm.isIdle.set(true)
        Thread.sleep(time)
        Thread.sleep(4L)
    }

    fun waitForMemChg(addr: Int, andMask: Int, xorMask: Int) {
        while ((peek(addr) xor xorMask) and andMask == 0) {
            vm.isIdle.set(true)
            Thread.sleep(1L)
            vm.isIdle.set(false)
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

    fun toObjectCode(ptr: Int): java.lang.String {
        val payloadSize = if (ptr >= 0)
            peek(ptr+1).shl(16) or peek(ptr+2).shl(8) or peek(ptr+3)
        else
            peek(ptr-1).shl(16) or peek(ptr-2).shl(8) or peek(ptr-3)

        val decrypted = decryptPayload(ptr, payloadSize, (ptr < 0))
        val image = CompressorDelegate.decomp(decrypted)
        return java.lang.String(image)
    }


    private fun decryptPayload(ptr: Int, payloadSize: Int, dec: Boolean): ByteArray {
        var key = "00"
        var keyBytes = byteArrayOf(0x00)
        var keyCursor = 0

        fun seq(s: String): String {
            var out = ""
            var cnt = 0
            var oldchar = s[0]

            for (char in s) {
                if (char == oldchar) {
                    cnt += 1
                } else {
                    out += cnt.toString() + oldchar
                    cnt = 1
                }
                oldchar = char
            }

            return out + cnt + oldchar
        }

        fun getNewKeySeq() {
            key = seq(key)
            keyBytes = ByteArray(key.length / 2)
            keyCursor = 0

            for (i in 0 until key.length step 2) {
                keyBytes[i / 2] = key.substring(i, minOf(i + 2, key.length)).toInt(16).toByte()
            }
        }

        ////////////////////////////

        val encrypted = ByteArray(payloadSize)

        for (outcnt in 0 until payloadSize) {
            encrypted[outcnt] = ((
                    if (!dec) peek(ptr + 4 + outcnt) else peek(ptr - 4 - outcnt))
                    xor keyBytes[keyCursor++].toUint()).toByte()
            if (keyCursor >= keyBytes.size) {
                getNewKeySeq()
            }
        }

        return encrypted
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
    fun isRunning(thread: Thread) = thread.isAlive
    fun getThreadPool() = vm.contexts
}

class ParallelDummy()