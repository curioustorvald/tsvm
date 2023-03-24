package net.torvald.tsvm.peripheral

import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.VM
import java.io.File

/**
 * Created by minjaesong on 2022-07-20.
 */
open class RamBank(val vm: VM, bankCount: Int, val writable: Boolean = true) : PeriBase("ramb") {

    val bankSize = 524288L

    protected var banks = bankCount.coerceIn(2..256)
        private set

    init {
        if (banks % 2 == 1) banks += 1
    }

    internal val mem = UnsafeHelper.allocate(bankSize * banks, this)

    internal var map0 = 0
    internal var map1 = 1

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

    private data class DMAQueue(var addrSys: Long = -1, var addrMem: Long = -1, var len: Long = -1, var bankNo1: Int = -1, var bankNo2: Int = -1)

    private val dmaQueue = Array(8) { DMAQueue() }

    override fun mmio_read(addr: Long): Byte {
        return when (addr) {
            0L -> map0.toByte()
            1L -> map1.toByte()

            in 16L..31L -> 0

            32L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].addrSys.toByte()
            33L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].addrSys.ushr(8).toByte()
            34L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].addrSys.ushr(16).toByte()
            35L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].addrMem.toByte()
            36L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].addrMem.ushr(8).toByte()
            37L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].addrMem.ushr(16).toByte()
            38L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].len.toByte()
            39L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].len.ushr(8).toByte()
            40L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].len.ushr(16).toByte()
            41L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].bankNo1.toByte()
            42L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[0].bankNo2.toByte()

            44L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].addrSys.toByte()
            45L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].addrSys.ushr(8).toByte()
            46L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].addrSys.ushr(16).toByte()
            47L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].addrMem.toByte()
            48L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].addrMem.ushr(8).toByte()
            49L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].addrMem.ushr(16).toByte()
            50L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].len.toByte()
            51L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].len.ushr(8).toByte()
            52L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].len.ushr(16).toByte()
            53L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].bankNo1.toByte()
            54L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[1].bankNo2.toByte()

            56L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].addrSys.toByte()
            57L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].addrSys.ushr(8).toByte()
            58L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].addrSys.ushr(16).toByte()
            59L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].addrMem.toByte()
            60L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].addrMem.ushr(8).toByte()
            61L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].addrMem.ushr(16).toByte()
            62L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].len.toByte()
            63L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].len.ushr(8).toByte()
            64L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].len.ushr(16).toByte()
            65L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].bankNo1.toByte()
            66L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[2].bankNo2.toByte()

            68L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].addrSys.toByte()
            69L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].addrSys.ushr(8).toByte()
            30L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].addrSys.ushr(16).toByte()
            71L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].addrMem.toByte()
            72L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].addrMem.ushr(8).toByte()
            73L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].addrMem.ushr(16).toByte()
            74L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].len.toByte()
            75L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].len.ushr(8).toByte()
            76L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].len.ushr(16).toByte()
            77L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].bankNo1.toByte()
            78L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[3].bankNo2.toByte()

            80L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].addrSys.toByte()
            81L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].addrSys.ushr(8).toByte()
            82L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].addrSys.ushr(16).toByte()
            83L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].addrMem.toByte()
            84L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].addrMem.ushr(8).toByte()
            85L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].addrMem.ushr(16).toByte()
            86L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].len.toByte()
            87L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].len.ushr(8).toByte()
            88L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].len.ushr(16).toByte()
            89L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].bankNo1.toByte()
            90L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[4].bankNo2.toByte()

            92L ->  if (!writable) mmio_read(addr % 32L) else dmaQueue[5].addrSys.toByte()
            93L ->  if (!writable) mmio_read(addr % 32L) else dmaQueue[5].addrSys.ushr(8).toByte()
            94L ->  if (!writable) mmio_read(addr % 32L) else dmaQueue[5].addrSys.ushr(16).toByte()
            95L ->  if (!writable) mmio_read(addr % 32L) else dmaQueue[5].addrMem.toByte()
            96L ->  if (!writable) mmio_read(addr % 32L) else dmaQueue[5].addrMem.ushr(8).toByte()
            97L ->  if (!writable) mmio_read(addr % 32L) else dmaQueue[5].addrMem.ushr(16).toByte()
            98L ->  if (!writable) mmio_read(addr % 32L) else dmaQueue[5].len.toByte()
            99L ->  if (!writable) mmio_read(addr % 32L) else dmaQueue[5].len.ushr(8).toByte()
            100L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[5].len.ushr(16).toByte()
            101L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[5].bankNo1.toByte()
            102L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[5].bankNo2.toByte()

            104L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].addrSys.toByte()
            105L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].addrSys.ushr(8).toByte()
            106L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].addrSys.ushr(16).toByte()
            107L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].addrMem.toByte()
            108L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].addrMem.ushr(8).toByte()
            109L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].addrMem.ushr(16).toByte()
            110L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].len.toByte()
            111L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].len.ushr(8).toByte()
            112L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].len.ushr(16).toByte()
            113L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].bankNo1.toByte()
            114L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[6].bankNo2.toByte()

            116L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].addrSys.toByte()
            117L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].addrSys.ushr(8).toByte()
            118L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].addrSys.ushr(16).toByte()
            119L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].addrMem.toByte()
            120L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].addrMem.ushr(8).toByte()
            121L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].addrMem.ushr(16).toByte()
            122L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].len.toByte()
            123L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].len.ushr(8).toByte()
            124L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].len.ushr(16).toByte()
            125L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].bankNo1.toByte()
            126L -> if (!writable) mmio_read(addr % 32L) else dmaQueue[7].bankNo2.toByte()

            else -> mmio_read(addr % 32L)
        }
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        when (addr) {
            0L -> map0 = byte.toUint()
            1L -> map1 = byte.toUint()

            in 16L..23L -> {
                val lane = dmaQueue[(addr - 16).toInt()]
                val op = byte.toInt()

                val len1 = minOf(0, lane.len, bankSize - lane.addrMem, bankSize)
                val len2 = lane.len - len1

                val periMemOffset1 = if (len1 <= 0) null else lane.bankNo1 * bankSize + lane.addrMem
                val periMemOffset2 = lane.bankNo2 * bankSize + minOf(0, lane.addrMem - bankSize)

                when (op) {
                    1 -> {
                        if (periMemOffset1 != null) UnsafeHelper.memcpy(mem, periMemOffset1, vm.usermem, lane.addrSys, len1)
                        UnsafeHelper.memcpy(mem, periMemOffset2, vm.usermem, lane.addrSys + len1, len2)
                    }
                    2 -> {
                        if (periMemOffset1 != null) UnsafeHelper.memcpy(vm.usermem, lane.addrSys, mem, periMemOffset1, len1)
                        UnsafeHelper.memcpy(vm.usermem, lane.addrSys + len1, mem, periMemOffset2, len2)
                    }
                }
            }

            32L -> if (writable) dmaQueue[0].addrSys = dmaQueue[0].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            33L -> if (writable) dmaQueue[0].addrSys = dmaQueue[0].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            34L -> if (writable) dmaQueue[0].addrSys = dmaQueue[0].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            35L -> if (writable) dmaQueue[0].addrMem = dmaQueue[0].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            36L -> if (writable) dmaQueue[0].addrMem = dmaQueue[0].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            37L -> if (writable) dmaQueue[0].addrMem = dmaQueue[0].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            38L -> if (writable) dmaQueue[0].len = dmaQueue[0].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            39L -> if (writable) dmaQueue[0].len = dmaQueue[0].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            40L -> if (writable) dmaQueue[0].len = dmaQueue[0].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            41L -> if (writable) dmaQueue[0].bankNo1 = byte.toUint()
            42L -> if (writable) dmaQueue[0].bankNo2 = byte.toUint()

            44L -> if (writable) dmaQueue[1].addrSys = dmaQueue[1].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            45L -> if (writable) dmaQueue[1].addrSys = dmaQueue[1].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            46L -> if (writable) dmaQueue[1].addrSys = dmaQueue[1].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            47L -> if (writable) dmaQueue[1].addrMem = dmaQueue[1].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            48L -> if (writable) dmaQueue[1].addrMem = dmaQueue[1].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            49L -> if (writable) dmaQueue[1].addrMem = dmaQueue[1].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            50L -> if (writable) dmaQueue[1].len = dmaQueue[1].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            51L -> if (writable) dmaQueue[1].len = dmaQueue[1].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            52L -> if (writable) dmaQueue[1].len = dmaQueue[1].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            53L -> if (writable) dmaQueue[1].bankNo1 = byte.toUint()
            54L -> if (writable) dmaQueue[1].bankNo2 = byte.toUint()

            56L -> if (writable) dmaQueue[2].addrSys = dmaQueue[2].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            57L -> if (writable) dmaQueue[2].addrSys = dmaQueue[2].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            58L -> if (writable) dmaQueue[2].addrSys = dmaQueue[2].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            59L -> if (writable) dmaQueue[2].addrMem = dmaQueue[2].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            60L -> if (writable) dmaQueue[2].addrMem = dmaQueue[2].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            61L -> if (writable) dmaQueue[2].addrMem = dmaQueue[2].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            62L -> if (writable) dmaQueue[2].len = dmaQueue[2].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            63L -> if (writable) dmaQueue[2].len = dmaQueue[2].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            64L -> if (writable) dmaQueue[2].len = dmaQueue[2].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            65L -> if (writable) dmaQueue[2].bankNo1 = byte.toUint()
            66L -> if (writable) dmaQueue[2].bankNo2 = byte.toUint()

            68L -> if (writable) dmaQueue[3].addrSys = dmaQueue[3].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            69L -> if (writable) dmaQueue[3].addrSys = dmaQueue[3].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            30L -> if (writable) dmaQueue[3].addrSys = dmaQueue[3].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            71L -> if (writable) dmaQueue[3].addrMem = dmaQueue[3].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            72L -> if (writable) dmaQueue[3].addrMem = dmaQueue[3].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            73L -> if (writable) dmaQueue[3].addrMem = dmaQueue[3].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            74L -> if (writable) dmaQueue[3].len = dmaQueue[3].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            75L -> if (writable) dmaQueue[3].len = dmaQueue[3].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            76L -> if (writable) dmaQueue[3].len = dmaQueue[3].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            77L -> if (writable) dmaQueue[3].bankNo1 = byte.toUint()
            78L -> if (writable) dmaQueue[3].bankNo2 = byte.toUint()

            80L -> if (writable) dmaQueue[4].addrSys = dmaQueue[4].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            81L -> if (writable) dmaQueue[4].addrSys = dmaQueue[4].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            82L -> if (writable) dmaQueue[4].addrSys = dmaQueue[4].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            83L -> if (writable) dmaQueue[4].addrMem = dmaQueue[4].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            84L -> if (writable) dmaQueue[4].addrMem = dmaQueue[4].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            85L -> if (writable) dmaQueue[4].addrMem = dmaQueue[4].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            86L -> if (writable) dmaQueue[4].len = dmaQueue[4].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            87L -> if (writable) dmaQueue[4].len = dmaQueue[4].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            88L -> if (writable) dmaQueue[4].len = dmaQueue[4].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            89L -> if (writable) dmaQueue[4].bankNo1 = byte.toUint()
            90L -> if (writable) dmaQueue[4].bankNo2 = byte.toUint()

            92L ->  if (writable) dmaQueue[5].addrSys = dmaQueue[5].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            93L ->  if (writable) dmaQueue[5].addrSys = dmaQueue[5].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            94L ->  if (writable) dmaQueue[5].addrSys = dmaQueue[5].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            95L ->  if (writable) dmaQueue[5].addrMem = dmaQueue[5].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            96L ->  if (writable) dmaQueue[5].addrMem = dmaQueue[5].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            97L ->  if (writable) dmaQueue[5].addrMem = dmaQueue[5].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            98L ->  if (writable) dmaQueue[5].len = dmaQueue[5].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            99L ->  if (writable) dmaQueue[5].len = dmaQueue[5].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            100L -> if (writable) dmaQueue[5].len = dmaQueue[5].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            101L -> if (writable) dmaQueue[5].bankNo1 = byte.toUint()
            102L -> if (writable) dmaQueue[5].bankNo2 = byte.toUint()

            104L -> if (writable) dmaQueue[6].addrSys = dmaQueue[6].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            105L -> if (writable) dmaQueue[6].addrSys = dmaQueue[6].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            106L -> if (writable) dmaQueue[6].addrSys = dmaQueue[6].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            107L -> if (writable) dmaQueue[6].addrMem = dmaQueue[6].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            108L -> if (writable) dmaQueue[6].addrMem = dmaQueue[6].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            109L -> if (writable) dmaQueue[6].addrMem = dmaQueue[6].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            110L -> if (writable) dmaQueue[6].len = dmaQueue[6].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            111L -> if (writable) dmaQueue[6].len = dmaQueue[6].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            112L -> if (writable) dmaQueue[6].len = dmaQueue[6].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            113L -> if (writable) dmaQueue[6].bankNo1 = byte.toUint()
            114L -> if (writable) dmaQueue[6].bankNo2 = byte.toUint()

            116L -> if (writable) dmaQueue[7].addrSys = dmaQueue[7].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            117L -> if (writable) dmaQueue[7].addrSys = dmaQueue[7].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            118L -> if (writable) dmaQueue[7].addrSys = dmaQueue[7].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            119L -> if (writable) dmaQueue[7].addrMem = dmaQueue[7].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            120L -> if (writable) dmaQueue[7].addrMem = dmaQueue[7].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            121L -> if (writable) dmaQueue[7].addrMem = dmaQueue[7].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            122L -> if (writable) dmaQueue[7].len = dmaQueue[7].addrSys.and(0xFFFF00) or byte.toUint().toLong()
            123L -> if (writable) dmaQueue[7].len = dmaQueue[7].addrSys.and(0xFF00FF) or byte.toUint().shl(8).toLong()
            124L -> if (writable) dmaQueue[7].len = dmaQueue[7].addrSys.and(0x0000FF) or byte.toUint().shl(16).toLong()
            125L -> if (writable) dmaQueue[7].bankNo1 = byte.toUint()
            126L -> if (writable) dmaQueue[7].bankNo2 = byte.toUint()
        }
    }

    override fun dispose() {
        mem.destroy()
    }

    override fun getVM() = vm
}

open class RomBank(vm: VM, romfile: File, bankCount: Int) : RamBank(vm, bankCount, false) {
    init {
        val bytes = romfile.readBytes()
        UnsafeHelper.memcpyRaw(bytes, 0, null, mem.ptr, bytes.size.toLong())
    }
    override val typestring = "romb"
    override fun poke(addr: Long, byte: Byte) {

    }
}