package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.UnsafePtr
import net.torvald.tsvm.firmware.Firmware
import net.torvald.tsvm.firmware.Firmware.Companion.toLuaValue
import net.torvald.tsvm.peripheral.IOSpace
import net.torvald.tsvm.peripheral.PeriBase
import org.luaj.vm2.LuaValue
import java.io.InputStream
import java.io.OutputStream
import java.io.PrintStream
import java.util.*
import kotlin.math.ceil
import kotlin.random.Random

/**
 * 1 byte = 2 pixels
 *
 * 560x448@4bpp = 125 440 bytes
 * 560x448@8bpp = 250 880 bytes
 *
 * -> 262144 bytes (256 kB)
 *
 * [USER AREA | HW AREA]
 *  Number of pheripherals = 8, of which the computer itself is considered as a peri.
 *
 * HW AREA = [Peripherals | MMIO | INTVEC]
 *
 * User area: 8 MB, hardware area: 8 MB
 *
 * 8192 kB
 *  User Space
 * 1024 kB
 *  Peripheral #8
 * 1024 kB
 *  Peripheral #7
 * ...
 * 1024 kB
 *  MMIO and Interrupt Vectors
 *  128 kB
 *   MMIO for Peri #8
 *  128 kB
 *   MMIO for Peri #7
 *  ...
 *  128 kB
 *   MMIO for the computer
 *   130816 bytes
 *    MMIO for Ports, etc.
 *   256 bytes
 *    Vectors for 64 interrupts
 *
 *
 */

class VM(
    _memsize: Long,
    val worldInterface: WorldInterface
) {

    val id = java.util.Random().nextInt()

    val memsize = minOf(USER_SPACE_SIZE, _memsize.toLong())
    private val MALLOC_UNIT = 64
    private val mallocBlockSize = (memsize / MALLOC_UNIT).toInt()

    internal val usermem = UnsafeHelper.allocate(memsize)

    val peripheralTable = Array(8) { PeripheralEntry() }

    internal fun getIO(): IOSpace = peripheralTable[0].peripheral as IOSpace

    //lateinit var printStream: OutputStream
    //lateinit var errorStream: OutputStream
    //lateinit var inputStream: InputStream // InputStream should not be a singleton, as it HAS TO open and close the stream.
    // Printstreams don't need that so they're singleton.

    var getPrintStream: () -> OutputStream = { TODO() }
    var getErrorStream: () -> OutputStream = { TODO() }
    var getInputStream: () -> InputStream = { TODO() }

    val startTime: Long

    init {
        peripheralTable[0] = PeripheralEntry(
            "io",
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

    internal fun poke(addr: Long, value: Byte) {
        val (memspace, offset) = translateAddr(addr)
        if (memspace == null)
            throw Firmware.ErrorIllegalAccess(addr)
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw Firmware.ErrorIllegalAccess(addr)
            else
                memspace.set(offset, value)
        }
        else
            (memspace as PeriBase).poke(offset, value)
    }

    internal fun peek(addr:Long): Byte? {
        val (memspace, offset) = translateAddr(addr)
        return if (memspace == null)
            null
        else if (memspace is UnsafePtr) {
            if (addr >= memspace.size)
                throw Firmware.ErrorIllegalAccess(addr)
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

    //fun Byte.toLuaValue() = LuaValue.valueOf(this.toInt())


    internal data class VMNativePtr(val address: Int, val size: Int)
}

data class PeripheralEntry(
    val type: String = "null",
    val peripheral: PeriBase? = null,
    val memsize: Long = 0,
    val mmioSize: Int = 0,
    val interruptCount: Int = 0 // max: 4
)

fun Int.kB() = this * 1024L
