package net.torvald.tsvm.peripheral

import net.torvald.UnsafeHelper
import net.torvald.tsvm.VM

/**
 * Implementation of single COM port
 */
internal class BlockTransferPort(val vm: VM, val portno: Int) : BlockTransferInterface(true, false) {

    internal var hasNext = false

    override fun startSend() {
        startSend { recipient ->
            val ba = ByteArray(BLOCK_SIZE) { vm.getIO().blockTransferRx[portno][it.toLong()] }
            recipient.writeout(ba)
        }
    }

    override fun hasNext(): Boolean = hasNext

    override fun writeout(inputData: ByteArray) {
        writeout(inputData) {
            val copySize = minOf(BLOCK_SIZE, inputData.size).toLong()
            val arrayOffset = UnsafeHelper.getArrayOffset(inputData).toLong()
            UnsafeHelper.memcpyRaw(inputData, arrayOffset, null, vm.getIO().blockTransferRx[portno].ptr, copySize)
        }
    }



}