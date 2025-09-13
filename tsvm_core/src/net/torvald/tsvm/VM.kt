package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.UnsafePtr
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toHex
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.*
import org.graalvm.polyglot.Context
import org.graalvm.polyglot.Value
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.Charset
import java.util.*
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil


class ErrorIllegalAccess(vm: VM, addr: Long) : RuntimeException("Segmentation fault at 0x${addr.toString(16).padStart(8, '0')} on VM id ${vm.id}")

@JvmInline
value class VmId(val text: String) {
    override fun toString() = text
}


/**
 * A class representing an instance of a Virtual Machine
 */

class VM(
    val assetsDir: String,
    _memsize: Long,
    val worldInterface: WorldInterface,
    val roms: Array<VMProgramRom>, // first ROM must contain the BIOS
    _peripheralSlots: Int = 8,
    val watchdogs: HashMap<String, VMWatchdog>
) {

    val peripheralSlots = _peripheralSlots.coerceIn(1,8)

    val id = VmId(getHashStr(6).let { it.substring(0..2) + "-" + it.substring(3..5) })

    override fun toString() = "tsvm.VM!$id"

    internal val contexts = ArrayList<Thread>()

    val memsize = minOf(USER_SPACE_SIZE, _memsize.toLong())
    val MALLOC_UNIT = 64
    val MALLOC_RESERVED_BLOCKS = 4 // 4*64=256 bytes are always reserved and won't be allocated to a pointer
    private val mallocBlockSize = (memsize / MALLOC_UNIT).toInt()

    internal val usermem = UnsafeHelper.allocate(memsize, this)

    val peripheralTable = Array(peripheralSlots) { PeripheralEntry() }

    fun getIO(): IOSpace = peripheralTable[0].peripheral as IOSpace

    //lateinit var printStream: OutputStream
    //lateinit var errorStream: OutputStream
    //lateinit var inputStream: InputStream // InputStream should not be a singleton, as it HAS TO open and close the stream.
    // Printstreams don't need that so they're singleton.

    var getPrintStream: () -> OutputStream = { TODO() }
    var getErrorStream: () -> OutputStream = { TODO() }
    var getInputStream: () -> InputStream = { TODO() }

    var startTime: Long = -1; private set

    var resetDown = false
    var stopDown = false
    var sysrqDown = false


    private var currentContext: Context? = null

    fun setCurrentJSContext(context: Context) {
        currentContext = context
    }

    private fun getCurrentJSContext(): Context {
        return currentContext ?: throw IllegalStateException("No JavaScript context available")
    }



    // VT tracking of the VM
    private var currentVTIndex = 0 // default to physical terminal
    private val vtOutputStreams = mutableMapOf<Int, OutputStream>()
    private val vtInputStreams = mutableMapOf<Int, InputStream>()
    private val vtTerminals = mutableMapOf<Int, VTTerminalAdapter>()

    fun getCurrentVT(): Int {
        // try to read from JS context
        try {
            val context = getCurrentJSContext()
            val currentVT = context.eval("js", "_TVDOS.CURRENT_VT || 0").asInt()
            return currentVT
        }
        catch (e: Exception) {
            return currentVTIndex
        }
    }

    fun setCurrentVT(vtIndex: Int) {
        currentVTIndex = vtIndex
        // Also update JavaScript context if available
        try {
            val context = getCurrentJSContext()
            context.eval("js", "_TVDOS.CURRENT_VT = $vtIndex")
        }
        catch (e: Exception) {
            // Context not available, continue with local tracking
        }
    }

    private fun getVTTerminal(vtIndex: Int, buffer: Value): VTTerminalAdapter {
        return vtTerminals.getOrPut(vtIndex) {
            VTTerminalAdapter(vtIndex, buffer)
        }
    }

    fun getVTOutputStream(vtIndex: Int): OutputStream {
        return vtOutputStreams.getOrPut(vtIndex) {
            if (vtIndex == 0) {
                // VT0 is physical terminal - use existing terminal
                getPrintStream()
            } else {
                // Create virtual terminal output stream
                createVTOutputStream(vtIndex)
            }
        }
    }

    private fun createVTOutputStream(vtIndex: Int): OutputStream {
        return object : OutputStream() {
            override fun write(b: Int) {
                // Write to virtual terminal buffer
                writeToVTBuffer(vtIndex, byteArrayOf(b.toByte()))
            }

            override fun write(b: ByteArray, off: Int, len: Int) {
                // Write to virtual terminal buffer
                writeToVTBuffer(vtIndex, b.sliceArray(off until off + len))
            }
        }
    }



    private val rawCursorPosLo = 252030L
    private val rawCursorPosHi = rawCursorPosLo + 1
    private val ptrTxtFore = rawCursorPosHi + 1
    private val ptrTxtBack = ptrTxtFore + 2560
    private val ptrTxt = ptrTxtBack + 2560

    private fun writeToVTBuffer(vtIndex: Int, textToWrite: ByteArray) {
        try {
            // Access the JavaScript VT device driver
            val context = getCurrentJSContext()

            val VMEM: Value = context.eval("js", "return _TVDOS.VT_CONTEXTS[$vtIndex].buffer")



            val rawCursorPos = VMEM.getArrayElement(rawCursorPosLo).asByte().toUint() or
                                  VMEM.getArrayElement(rawCursorPosHi).asByte().toUint().shl(8) // Cursor position in: (y*80 + x)
            val printOff = rawCursorPos

            // mimic the behaviour of the GraphicsAdapter.getPrintStream.write(ByteArray)
            this.isIdle.set(true)
            Objects.checkFromIndexSize(printOff, textToWrite.size, textToWrite.size)

            for (i in 0 until textToWrite.size) {
                vtWriteOut(VMEM, textToWrite[i])
            }
            this.isIdle.set(false)
        } catch (e: Exception) {
            System.err.println("Failed to write to VT$vtIndex: ${e.message}")
        }
    }

    private fun vtWriteOut(VMEM: Value, char: Byte) {
        val terminal = getVTTerminal(getCurrentVT(), VMEM)
        terminal.writeOut(char) // calls GlassTty.writeOut() which handles everything
    }

    private inner class VTTerminalAdapter(private val vtIndex: Int, private val VMEM: Value) : StandardTty(32, 80) {

        private fun toTtyTextOffset(x: Int, y: Int): Int {
            return TEXT_COLS * y + x
        }

        override fun putChar(x: Int, y: Int, text: Byte, foreColour: Byte, backColour: Byte) {
            val textOff = toTtyTextOffset(x, y)
            VMEM.setArrayElement(ptrTxtFore + textOff, foreColour)
            VMEM.setArrayElement(ptrTxtBack + textOff, backColour)
            VMEM.setArrayElement(ptrTxt + textOff, text)
        }

        override fun eraseInDisp(arg: Int) {
            when (arg) {
                2 -> {
                    val foreBits = ttyFore or ttyFore.shl(8) or ttyFore.shl(16) or ttyFore.shl(24)
                    val backBits = ttyBack or ttyBack.shl(8) or ttyBack.shl(16) or ttyBack.shl(24)
                    for (i in 0 until TEXT_COLS * TEXT_ROWS step 4) {
                        VMEM.setArrayElement(ptrTxtFore + 1, foreBits)
                        VMEM.setArrayElement(ptrTxtBack + 1, backBits)
                        VMEM.setArrayElement(ptrTxt + 1, 0)
                    }
                    VMEM.setArrayElement(rawCursorPosLo, 0)
                    VMEM.setArrayElement(rawCursorPosHi, 0)
                }
                else -> TODO()
            }
        }

        override fun eraseInLine(arg: Int) {
            when (arg) {
                else -> TODO()
            }
        }

        override fun scrollUp(arg: Int) {
            TODO("Not yet implemented")
        }

        override fun scrollDown(arg: Int) {
            TODO("Not yet implemented")
        }

        override fun getPrintStream(): OutputStream {
            TODO("how???")
        }

        override fun getErrorStream(): OutputStream {
            TODO("how???")
        }

        override fun getInputStream(): InputStream {
            TODO("how???")
        }

        override fun putKey(key: Int) {
            // VT has no keyboard attached
        }

        override fun takeKey(): Int {
            // VT has no keyboard attached
            return 0
        }

        override fun peek(addr: Long): Byte? {
            if (addr < 0) return null
            return VMEM.getArrayElement(addr % 524288).asByte()
        }

        override fun poke(addr: Long, byte: Byte) {
            if (addr < 0) return
            VMEM.setArrayElement(addr % 524288, byte)
        }

        override fun mmio_read(addr: Long): Byte? {
            return null
        }

        override fun mmio_write(addr: Long, byte: Byte) {
        }

        override fun dispose() {
        }

        override fun getVM(): VM {
            return this@VM
        }

        override fun getCursorPos(): Pair<Int, Int> {
            val rawPos = VMEM.getArrayElement(rawCursorPosLo).asByte().toUint() or
                    VMEM.getArrayElement(rawCursorPosHi).asByte().toUint().shl(8)
            return (rawPos % 80) to (rawPos / 80)
        }

        override fun setCursorPos(x: Int, y: Int) {
            val rawPos = (y * 80 + x).coerceIn(0, 2559)
            VMEM.setArrayElement(rawCursorPosLo, (rawPos and 0xFF).toByte())
            VMEM.setArrayElement(rawCursorPosHi, (rawPos shr 8).toByte())
        }

        override var rawCursorPos: Int
            get() = TODO("Not yet implemented")
            set(value) {}
        override var blinkCursor: Boolean
            get() = TODO("Not yet implemented")
            set(value) {}
        override var ttyFore: Int
            get() = TODO("Not yet implemented")
            set(value) {}
        override var ttyBack: Int
            get() = TODO("Not yet implemented")
            set(value) {}
        override var ttyRawMode: Boolean
            get() = TODO("Not yet implemented")
            set(value) {}


    }



    var romMapping = 255
        internal set

    private val mallocMap = BitSet(mallocBlockSize)
    private val mallocSizes = HashMap<Int, Int>() // HashMap<Block Index, Block Count>
    var allocatedBlockCount = 0; private set

    val isRunning: Boolean
        get() = !disposed &&startTime >= 0

    val isIdle = AtomicBoolean(true)

    init {
        println("[VM] Creating new VM with ID of $id, memsize $memsize")

        peripheralTable[0] = PeripheralEntry(IOSpace(this))
    }

    fun killAllContexts() {
        contexts.forEach { it.interrupt() }
        contexts.clear()
    }

    /**
     * Makes the VM stop suddenly without disposing of.
     */
    fun park() {
        killAllContexts()
        startTime = -1
    }

    fun init() {
        killAllContexts()
        usermem.fillWith(0)
        mallocMap.clear()
        mallocSizes.clear()
        allocatedBlockCount = 0

        startTime = System.currentTimeMillis()
    }


    fun findPeribyType(searchTerm: String): PeripheralEntry? {
        for (i in 0 until peripheralSlots) {
            if (peripheralTable[i].type == searchTerm) return peripheralTable[i]
        }
        return null
    }

    fun findPeriIndexByType(searchTerm: String): Int? {
        for (i in 0 until peripheralSlots) {
            if (peripheralTable[i].type == searchTerm) return i
        }
        return null
    }

    fun findPeriSlotNum(peri: PeriBase): Int? {
        for (i in 0 until peripheralSlots) {
            if (peripheralTable[i].peripheral == peri) return i
        }
        return null
    }

    fun update(delta: Float) {
        getIO().update(delta)
    }

    fun dispose() {
        killAllContexts()
        usermem.destroy()
        peripheralTable.forEach { it.peripheral?.dispose() }
        disposed = true
    }


    /**
     * To check if the VM has started, check if startTime >= 0
     */
    var disposed = false; private set

    /**
     * @return system uptime in milliseconds
     */
    open fun getUptime() = System.currentTimeMillis() - startTime

    /*
    NOTE: re-fill peripheralTable whenever the VM cold-boots!
          you are absolutely not supposed to hot-swap peripheral cards when the computer is on
     */


    companion object {
        val CHARSET = Charset.forName("iso-8859-1") // no cp437 because i dunno

        val MMIO_SIZE = 128.kB()
        val HW_RESERVE_SIZE = 1024.kB()
        val USER_SPACE_SIZE = 8192.kB()

        const val PERITYPE_GPU_AND_TERM = "gpu"
        const val PERITYPE_SOUND = "snd"
    }

    internal fun translateAddr(addr: Long): Pair<Any?, Long> {
        return when (addr) {
            // DO note that numbers in Lua are double precision floats (ignore Lua 5.3 for now)
            in 0..8192.kB() - 1 -> usermem to addr
            in -1024.kB()..-1 -> peripheralTable.getOrNull(0)?.peripheral to (-addr - 1)
            in -2048.kB()..-1024.kB() - 1 -> peripheralTable.getOrNull(1)?.peripheral to (-addr - 1 - 1024.kB())
            in -3072.kB()..-2048.kB() - 1 -> peripheralTable.getOrNull(2)?.peripheral to (-addr - 1 - 2048.kB())
            in -4096.kB()..-3072.kB() - 1 -> peripheralTable.getOrNull(3)?.peripheral to (-addr - 1 - 3072.kB())
            in -5120.kB()..-4096.kB() - 1 -> peripheralTable.getOrNull(4)?.peripheral to (-addr - 1 - 4096.kB())
            in -6144.kB()..-5120.kB() - 1 -> peripheralTable.getOrNull(5)?.peripheral to (-addr - 1 - 5120.kB())
            in -7168.kB()..-6144.kB() - 1 -> peripheralTable.getOrNull(6)?.peripheral to (-addr - 1 - 6144.kB())
            in -8192.kB()..-7168.kB() - 1 -> peripheralTable.getOrNull(7)?.peripheral to (-addr - 1 - 7168.kB())
            else -> null to addr
        }
    }

    fun poke(addr: Long, value: Byte) {
        val (memspace, offset) = translateAddr(addr)
        if (memspace == null)
            throw ErrorIllegalAccess(this, addr)
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw ErrorIllegalAccess(this, addr)
            else
                memspace.set(offset, value)
        }
        else
            (memspace as PeriBase).poke(offset, value)
    }

    fun pokeShort(addr: Long, value: Short) {
        val value0 = value.toByte()
        val value1 = value.toInt().shr(8).toByte()

        val (memspace, offset) = translateAddr(addr)
        if (memspace == null)
            throw ErrorIllegalAccess(this, addr)
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw ErrorIllegalAccess(this, addr)
            else {
                memspace.set(offset+0, value0)
                memspace.set(offset+1, value1)
            }
        }
        else {
            (memspace as PeriBase).poke(offset+0, value0)
            (memspace as PeriBase).poke(offset+1, value1)
        }
    }

    fun pokeFloat(addr: Long, value: Float) {
        val vi = value.toRawBits()
        val value0 = vi.toByte()
        val value1 = vi.shr(8).toByte()
        val value2 = vi.shr(16).toByte()
        val value3 = vi.shr(24).toByte()

        val (memspace, offset) = translateAddr(addr)
        if (memspace == null)
            throw ErrorIllegalAccess(this, addr)
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw ErrorIllegalAccess(this, addr)
            else {
                memspace.set(offset+0, value0)
                memspace.set(offset+1, value1)
                memspace.set(offset+2, value2)
                memspace.set(offset+3, value3)
            }
        }
        else {
            (memspace as PeriBase).poke(offset+0, value0)
            (memspace as PeriBase).poke(offset+1, value1)
            (memspace as PeriBase).poke(offset+2, value2)
            (memspace as PeriBase).poke(offset+3, value3)
        }
    }

    fun pokeInt(addr: Long, value: Int) {
        val value0 = value.toByte()
        val value1 = value.shr(8).toByte()
        val value2 = value.shr(16).toByte()
        val value3 = value.shr(24).toByte()

        val (memspace, offset) = translateAddr(addr)
        if (memspace == null)
            throw ErrorIllegalAccess(this, addr)
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw ErrorIllegalAccess(this, addr)
            else {
                memspace.set(offset+0, value0)
                memspace.set(offset+1, value1)
                memspace.set(offset+2, value2)
                memspace.set(offset+3, value3)
            }
        }
        else {
            (memspace as PeriBase).poke(offset+0, value0)
            (memspace as PeriBase).poke(offset+1, value1)
            (memspace as PeriBase).poke(offset+2, value2)
            (memspace as PeriBase).poke(offset+3, value3)
        }
    }

    fun peek(addr:Long): Byte {
        val (memspace, offset) = translateAddr(addr)

//        println("peek $addr -> ${offset}@${memspace?.javaClass?.canonicalName}")

        return if (memspace == null)
            throw NullPointerException()//null
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw ErrorIllegalAccess(this, addr)
            else
                memspace.get(offset)
        }
        else
            (memspace as PeriBase).peek(offset)!!
    }

    fun peekShort(addr: Long): Short {
        val (memspace, offset) = translateAddr(addr)

        return if (memspace == null)
            throw NullPointerException()//null
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw ErrorIllegalAccess(this, addr)
            else {
                (memspace.get(offset+0).toUint() or
                 memspace.get(offset+1).toUint().shl(8)).toShort()
            }
        }
        else {
            ((memspace as PeriBase).peek(offset+0)!!.toUint() or
             (memspace as PeriBase).peek(offset+1)!!.toUint().shl(8)).toShort()
        }
    }

    fun peekFloat(addr: Long): Float {
        val (memspace, offset) = translateAddr(addr)

        return if (memspace == null)
            throw NullPointerException()//null
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw ErrorIllegalAccess(this, addr)
            else {
                Float.fromBits(memspace.get(offset+0).toUint() or
                 memspace.get(offset+1).toUint().shl(8) or
                 memspace.get(offset+2).toUint().shl(16) or
                 memspace.get(offset+3).toUint().shl(24)
                )
            }
        }
        else {
            Float.fromBits((memspace as PeriBase).peek(offset+0)!!.toUint() or
             (memspace as PeriBase).peek(offset+1)!!.toUint().shl(8) or
             (memspace as PeriBase).peek(offset+2)!!.toUint().shl(16) or
             (memspace as PeriBase).peek(offset+3)!!.toUint().shl(24)
            )
        }
    }

    fun peekInt(addr: Long): Int? {
        val (memspace, offset) = translateAddr(addr)

        return if (memspace == null)
            throw NullPointerException()//null
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw ErrorIllegalAccess(this, addr)
            else {
                (memspace.get(offset+0).toUint() or
                        memspace.get(offset+1).toUint().shl(8) or
                        memspace.get(offset+2).toUint().shl(16) or
                        memspace.get(offset+3).toUint().shl(24)
                )
            }
        }
        else {
            ((memspace as PeriBase).peek(offset+0)!!.toUint() or
                    (memspace as PeriBase).peek(offset+1)!!.toUint().shl(8) or
                    (memspace as PeriBase).peek(offset+2)!!.toUint().shl(16) or
                    (memspace as PeriBase).peek(offset+3)!!.toUint().shl(24)
            )
        }
    }

    private fun findEmptySpace(blockSize: Int): Int? {
        var cursorHead = MALLOC_RESERVED_BLOCKS
        var cursorTail: Int
        val cursorHeadMaxInclusive = mallocBlockSize - blockSize
        while (cursorHead <= cursorHeadMaxInclusive) {
            cursorHead = mallocMap.nextClearBit(cursorHead)
            cursorTail = cursorHead + blockSize - 1
            if (cursorTail > mallocBlockSize) return null
            if (mallocMap.get(cursorTail) == false) {
                var isNotEmpty = false
                for (k in cursorHead..cursorTail) {
                    isNotEmpty = isNotEmpty or mallocMap[k]
                }

                if (!isNotEmpty) {
                    mallocMap.set(cursorHead, cursorTail + 1)
                    return cursorHead
                }
            }
            cursorHead = cursorTail + 1
        }
        return null
    }

    internal fun malloc(size: Int): Int {
        if (size <= 0) throw IllegalArgumentException("Invalid malloc size: $size")

        val allocBlocks = ceil(size.toDouble() / MALLOC_UNIT).toInt()
        val blockStart = findEmptySpace(allocBlocks) ?: throw OutOfMemoryError("No space for $allocBlocks blocks ($size bytes requested)")

        allocatedBlockCount += allocBlocks
        mallocSizes[blockStart] = allocBlocks
        return blockStart * MALLOC_UNIT
    }

    internal fun free(ptr: Int) {
        val index = ptr / MALLOC_UNIT
        val count = mallocSizes[index] ?: throw OutOfMemoryError("No allocation for pointer 0x${ptr.toHex()}")

        mallocMap.set(index, index + count, false)
        mallocSizes.remove(index)
        allocatedBlockCount -= count
    }

    internal fun forceAlloc(ptr: Int, size: Int) {
        val allocBlocks = ceil(size.toDouble() / MALLOC_UNIT).toInt()
        val blockStart = ptr / MALLOC_UNIT

        var previouslyUnallocated = 0
        for (i in blockStart until blockStart + allocBlocks) {
            if (mallocMap.get(i) == false) previouslyUnallocated++
            mallocMap.set(i, true)
        }
        allocatedBlockCount += previouslyUnallocated
        mallocSizes[blockStart] = allocBlocks
    }

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
            for (i in 0 until len) buf[i] = peek(from + i*fromVector)!!
            UnsafeHelper.memcpy(buf.ptr, toDev, len)
            buf.destroy()
        }
        else if (fromDev != null) {
            for (i in 0 until len) poke(to + i*toVector, UnsafeHelper.unsafe.getByte(fromDev + i))
        }
        else {
            for (i in 0 until len) poke(to + i*toVector, peek(from + i*fromVector)!!)
        }
    }

    fun memset(dest: Int, ch: Int, count: Int): Int {
        val incVec = if (dest >= 0) 1L else -1L
        for (i in 0 until count) {
            poke(dest + count*incVec, ch.toByte())
        }
        return dest
    }

    fun memsetI24(dest: Int, ch: Int, countInBytes: Int): Int {
        val r = ch.ushr(16).and(255).toByte()
        val g = ch.ushr(8).and(255).toByte()
        val b = ch.ushr(0).and(255).toByte()
        val incVec = if (dest >= 0) 1L else -1L
        for (i in 0 until countInBytes step 3) {
            poke(dest + (i + 0)*incVec, r)
            poke(dest + (i + 1)*incVec, g)
            poke(dest + (i + 2)*incVec, b)
        }
        return dest
    }

    fun bulkPeekShort(from: Int, to: ShortArray, sizeInBytes: Int) {
        if (from !in 0..8*1024*1024) throw IllegalArgumentException()
        UnsafeHelper.memcpyRaw(null, usermem.ptr + from, to, UnsafeHelper.getArrayOffset(to), sizeInBytes.toLong())
    }

    fun bulkPeekInt(from: Int, to: IntArray, sizeInBytes: Int) {
        if (from !in 0..8*1024*1024) throw IllegalArgumentException()
        UnsafeHelper.memcpyRaw(null, usermem.ptr + from, to, UnsafeHelper.getArrayOffset(to), sizeInBytes.toLong())
    }

    fun bulkPeekFloat(from: Int, to: FloatArray, sizeInBytes: Int) {
        if (from !in 0..8*1024*1024) throw IllegalArgumentException()
        UnsafeHelper.memcpyRaw(null, usermem.ptr + from, to, UnsafeHelper.getArrayOffset(to), sizeInBytes.toLong())
    }

    private fun relPtrInDev(from: Long, len: Long, start: Int, end: Int) =
        (from in start..end && (from + len) in start..end)

    private fun getDev(from: Long, len: Long, isDest: Boolean): Long? {
        return if (from >= 0) usermem.ptr + from
        // MMIO area
        else if (from in -1048576..-1 && (from - len) in -1048577..-1) {
            val fromIndex = (-from-1) / 131072
            val dev = peripheralTable[fromIndex.toInt()].peripheral ?: return null
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
            val dev = peripheralTable[fromIndex.toInt()].peripheral ?: return null
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

    internal data class VMNativePtr(val address: Int, val size: Int)
}

class PeripheralEntry(
    val peripheral: PeriBase? = null,
//    val memsize: Long = 0,
//    val mmioSize: Int = 0,
//    val interruptCount: Int = 0, // max: 4
) {
    val type = peripheral?.typestring
}

class PeripheralEntry2(
    val peripheralClassname: String,
    vararg val args: Any
)

internal fun Int.kB() = this * 1024L
