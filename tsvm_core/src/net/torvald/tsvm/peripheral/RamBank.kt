package net.torvald.tsvm.peripheral

import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.VM
import java.io.File

/**
 * Created by minjaesong on 2022-07-20.
 */
open class RamBank(val vm: VM, bankCount: Int) : PeriBase {

    val bankSize = 524288L

    protected var banks = bankCount.coerceIn(2..256)
        private set

    init {
        if (banks % 2 == 1) banks += 1
    }

    internal val mem = UnsafeHelper.allocate(bankSize * banks, this)

    protected var map0 = 0
    protected var map1 = 1

    override fun peek(addr: Long): Byte {
        return when (addr) {
            in 0L until bankSize -> mem[bankSize * map0 + (addr % bankSize)]
            in bankSize until 2 * bankSize -> mem[bankSize * map1 + (addr % bankSize)]
            else -> throw IllegalArgumentException("Offset: $addr")
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        when (addr) {
            in 0L until bankSize -> mem[bankSize * map0 + (addr % bankSize)] = byte
            in bankSize until 2 * bankSize -> mem[bankSize * map1 + (addr % bankSize)] = byte
            else -> throw IllegalArgumentException("Offset: $addr")
        }
    }

    override fun mmio_read(addr: Long): Byte {
        return when (addr) {
            0L -> map0.toByte()
            1L -> map1.toByte()
            else -> -1
        }
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        when (addr) {
            0L -> map0 = byte.toUint()
            1L -> map1 = byte.toUint()
        }
    }

    override fun dispose() {
        mem.destroy()
    }

    override fun getVM() = vm

    override val typestring = "RAMB"
}

open class RomBank(vm: VM, romfile: File, bankCount: Int) : RamBank(vm, bankCount) {
    init {
        val bytes = romfile.readBytes()
        UnsafeHelper.memcpyRaw(bytes, 0, null, mem.ptr, bytes.size.toLong())
    }
    override val typestring = "ROMB"
}