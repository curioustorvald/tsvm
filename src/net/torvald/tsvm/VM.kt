package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.UnsafePtr
import net.torvald.tsvm.firmware.Firmware
import net.torvald.tsvm.firmware.Firmware.Companion.toLuaValue
import net.torvald.tsvm.peripheral.IOSpace
import net.torvald.tsvm.peripheral.PeriBase
import org.luaj.vm2.LuaValue
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
    _memsize: Int
) {

    val id = java.util.Random().nextInt()

    val memsize = minOf(USER_SPACE_SIZE, _memsize.toLong())

    internal val usermem = UnsafeHelper.allocate(memsize)

    val peripheralTable = Array(8) { PeripheralEntry() }

    init {
        peripheralTable[0] = PeripheralEntry(
            "io",
            IOSpace(),
            HW_RESERVE_SIZE,
            MMIO_SIZE.toInt() - 256,
            64
        )

        println("[VM] Creating new VM with ID of $id, memesize $memsize")
    }


    fun findPeribyType(searchTerm: String): Int? {
        for (i in 0..7) {
            if (peripheralTable[i].type == searchTerm) return i
        }
        return null
    }

    fun dispose() {
        usermem.destroy()
        peripheralTable.forEach { it.peripheral?.dispose() }
    }

    /*
    NOTE: re-fill peripheralTable whenever the VM cold-boots!
          you are absolutely not supposed to hot-swap peripheral cards when the computer is on
     */


    companion object {
        val MMIO_SIZE = 128.kB()
        val HW_RESERVE_SIZE = 1024.kB()
        val USER_SPACE_SIZE = 8192.kB()

        const val PERITYPE_GRAPHICS = "gpu"
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
            Firmware.errorIllegalAccess(addr)
        else if (memspace is UnsafePtr)
            memspace.set(offset, value)
        else
            (memspace as PeriBase).poke(offset, value)
    }

    fun peek(addr:Long): Byte? {
        val (memspace, offset) = translateAddr(addr)
        return if (memspace == null)
            null
        else if (memspace is UnsafePtr)
            memspace.get(offset)
        else
            (memspace as PeriBase).peek(offset)
    }

    fun Byte.toLuaValue() = LuaValue.valueOf(this.toInt())

}

data class PeripheralEntry(
    val type: String = "null",
    val peripheral: PeriBase? = null,
    val memsize: Long = 0,
    val mmioSize: Int = 0,
    val interruptCount: Int = 0 // max: 4
)

fun Int.kB() = this * 1024L
