package net.torvald.tsvm.peripheral

import net.torvald.UnsafeHelper
import net.torvald.tsvm.VM

/**
 * Implementation of single COM port
 */
class BlockTransferPort(val vm: VM, val portno: Int) : BlockTransferInterface(true, false) {

    internal var hasNext = false

    override fun startSend() {
        startSend { recipient ->
            val ba = ByteArray(BLOCK_SIZE) { vm.getIO().blockTransferTx[portno][it.toLong()] }
            recipient.writeout(ba)
        }

        this.ready = true
        this.busy = false
    }

    override fun hasNext(): Boolean = hasNext

    override fun writeout(inputData: ByteArray) {
        writeout(inputData) {
            //val copySize = minOf(BLOCK_SIZE, inputData.size).toLong()
            //val arrayOffset = UnsafeHelper.getArrayOffset(inputData)
            //UnsafeHelper.memcpyRaw(inputData, arrayOffset, null, vm.getIO().blockTransferRx[portno].ptr, copySize)

            // not exposing raw memory to block probable security hole
            for (k in 0 until BLOCK_SIZE) {
                vm.getIO().blockTransferRx[portno][k.toLong()] = if (k >= inputData.size) 0 else inputData[k]
            }
        }

        this.ready = true
        this.busy = false
    }



}