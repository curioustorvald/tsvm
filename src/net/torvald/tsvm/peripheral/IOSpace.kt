package net.torvald.tsvm.peripheral

class IOSpace : PeriBase {
    override fun peek(addr: Long): Byte? {
        TODO("Not yet implemented")
    }

    override fun poke(addr: Long, byte: Byte) {
        TODO("Not yet implemented")
    }

    override fun mmio_read(addr: Long): Byte? {
        TODO("Not yet implemented")
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        TODO("Not yet implemented")
    }

    override fun dispose() {
        TODO("Not yet implemented")
    }
}