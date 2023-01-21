package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM
import net.torvald.tsvm.getHashStr

abstract class PeriBase(open val typestring: String) {

    val hash = getHashStr()

    /**
     * Addr is not an offset; they can be "wired" into any other "chip" in the card other than its RAM
     */
    abstract fun peek(addr: Long): Byte?

    /**
     * Addr is not an offset; they can be "wired" into any other "chip" in the card other than its RAM
     */
    abstract fun poke(addr: Long, byte: Byte)

    abstract fun mmio_read(addr: Long): Byte?
    abstract fun mmio_write(addr: Long, byte: Byte)

    abstract fun dispose()

    abstract fun getVM(): VM

    override fun equals(other: Any?): Boolean {
        return (this.hash == (other as PeriBase).hash)
    }
}