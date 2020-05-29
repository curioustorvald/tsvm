package net.torvald.tsvm.peripheral

import java.util.*

class SerialDiskDrive : BlockTransferInterface(false, true) {

    override fun hasNext(): Boolean {
        TODO("Not yet implemented")
    }

    override fun startSend() {
        TODO("Not yet implemented")
    }

    override fun writeout(inputData: ByteArray) {
        TODO("Not yet implemented")
    }

    val diskID: UUID = UUID(0, 0)


}