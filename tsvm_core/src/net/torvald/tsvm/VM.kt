package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.UnsafePtr
import net.torvald.tsvm.peripheral.IOSpace
import net.torvald.tsvm.peripheral.PeriBase
import net.torvald.tsvm.peripheral.VMProgramRom
import java.io.InputStream
import java.io.OutputStream
import java.util.*
import kotlin.math.ceil


class ErrorIllegalAccess(vm: VM, addr: Long) : RuntimeException("Segmentation fault at 0x${addr.toString(16).padStart(8, '0')} on VM id ${vm.id}")


/**
 * A class representing an instance of a Virtual Machine
 */

class VM(
    _memsize: Long,
    val worldInterface: WorldInterface,
    val roms: Array<VMProgramRom?> // first ROM must contain the BIOS
) {

    val id = java.util.Random().nextInt()

    val memsize = minOf(USER_SPACE_SIZE, _memsize.toLong())
    private val MALLOC_UNIT = 64
    private val mallocBlockSize = (memsize / MALLOC_UNIT).toInt()

    internal val usermem = UnsafeHelper.allocate(memsize)

    val peripheralTable = Array(8) { PeripheralEntry() }

    fun getIO(): IOSpace = peripheralTable[0].peripheral as IOSpace

    //lateinit var printStream: OutputStream
    //lateinit var errorStream: OutputStream
    //lateinit var inputStream: InputStream // InputStream should not be a singleton, as it HAS TO open and close the stream.
    // Printstreams don't need that so they're singleton.

    var getPrintStream: () -> OutputStream = { TODO() }
    var getErrorStream: () -> OutputStream = { TODO() }
    var getInputStream: () -> InputStream = { TODO() }

    var startTime: Long = -1

    var resetDown = false
    var stopDown = false

    var romMapping = 255
        internal set

    init {
        init()
    }

    fun init() {
        peripheralTable[0] = PeripheralEntry(
            IOSpace(this),
            HW_RESERVE_SIZE,
            MMIO_SIZE.toInt() - 256,
            64
        )

        println("[VM] Creating new VM with ID of $id, memsize $memsize")

        startTime = System.nanoTime()
    }


    fun findPeribyType(searchTerm: String): PeripheralEntry? {
        for (i in 0..7) {
            if (peripheralTable[i].type == searchTerm) return peripheralTable[i]
        }
        return null
    }

    fun update(delta: Float) {
        getIO().update(delta)
    }

    fun dispose() {
        usermem.destroy()
        peripheralTable.forEach { it.peripheral?.dispose() }
    }

    open fun getUptime() = System.nanoTime() - startTime

    /*
    NOTE: re-fill peripheralTable whenever the VM cold-boots!
          you are absolutely not supposed to hot-swap peripheral cards when the computer is on
     */


    companion object {
        val CHARSET = Charsets.ISO_8859_1

        val MMIO_SIZE = 128.kB()
        val HW_RESERVE_SIZE = 1024.kB()
        val USER_SPACE_SIZE = 8192.kB()

        const val PERITYPE_GPU_AND_TERM = "gpu"
    }

    internal fun translateAddr(addr: Long): Pair<Any?, Long> {
        return when (addr) {
            // DO note that numbers in Lua are double precision floats (ignore Lua 5.3 for now)
            in 0..8192.kB() - 1 -> usermem to addr
            in -1024.kB()..-1 -> peripheralTable[0].peripheral to (-addr - 1)
            in -2048.kB()..-1024.kB() - 1 -> peripheralTable[1].peripheral to (-addr - 1 - 1024.kB())
            in -3072.kB()..-2048.kB() - 1 -> peripheralTable[2].peripheral to (-addr - 1 - 2048.kB())
            in -4096.kB()..-3072.kB() - 1 -> peripheralTable[3].peripheral to (-addr - 1 - 3072.kB())
            in -5120.kB()..-4096.kB() - 1 -> peripheralTable[4].peripheral to (-addr - 1 - 4096.kB())
            in -6144.kB()..-5120.kB() - 1 -> peripheralTable[5].peripheral to (-addr - 1 - 5120.kB())
            in -7168.kB()..-6144.kB() - 1 -> peripheralTable[6].peripheral to (-addr - 1 - 6144.kB())
            in -8192.kB()..-7168.kB() - 1 -> peripheralTable[7].peripheral to (-addr - 1 - 7168.kB())
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

    fun peek(addr:Long): Byte? {
        val (memspace, offset) = translateAddr(addr)
        return if (memspace == null)
            null
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw ErrorIllegalAccess(this, addr)
            else
                memspace.get(offset)
        }
        else
            (memspace as PeriBase).peek(offset)
    }

    private val mallocMap = BitSet(mallocBlockSize)
    private val mallocSizes = HashMap<Int, Int>() // HashMap<Block Index, Block Count>

    private fun findEmptySpace(blockSize: Int): Int? {
        var cursorHead = 0
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
        val allocBlocks = ceil(size.toDouble() / MALLOC_UNIT).toInt()
        val blockStart = findEmptySpace(allocBlocks) ?: throw OutOfMemoryError()

        mallocSizes[blockStart] = allocBlocks
        return blockStart * MALLOC_UNIT
    }

    internal fun free(ptr: Int) {
        val index = ptr / MALLOC_UNIT
        val count = mallocSizes[index] ?: throw OutOfMemoryError()

        mallocMap.set(index, index + count, false)
        mallocSizes.remove(index)
    }

    internal data class VMNativePtr(val address: Int, val size: Int)
}

class PeripheralEntry(
    val peripheral: PeriBase? = null,
    val memsize: Long = 0,
    val mmioSize: Int = 0,
    val interruptCount: Int = 0, // max: 4
) {
    val type = peripheral?.typestring
}

class PeripheralEntry2(
    val memsize: Long = 0,
    val mmioSize: Int = 0,
    val interruptCount: Int = 0, // max: 4
    val peripheralClassname: String,
    vararg val args: Any
)

fun Int.kB() = this * 1024L