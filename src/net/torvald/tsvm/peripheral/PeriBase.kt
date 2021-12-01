package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM

interface PeriBase {

    /**
     * Addr is not an offset; they can be "wired" into any other "chip" in the card other than its RAM
     */
    fun peek(addr: Long): Byte?

    /**
     * Addr is not an offset; they can be "wired" into any other "chip" in the card other than its RAM
     */
    fun poke(addr: Long, byte: Byte)

    fun mmio_read(addr: Long): Byte?
    fun mmio_write(addr: Long, byte: Byte)

    fun dispose()

    fun getVM(): VM

    val typestring: String
}