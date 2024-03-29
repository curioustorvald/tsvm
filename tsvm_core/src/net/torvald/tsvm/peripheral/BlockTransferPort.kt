package net.torvald.tsvm.peripheral

import net.torvald.UnsafeHelper
import net.torvald.tsvm.VM
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Implementation of single COM port
 */
class BlockTransferPort(val vm: VM, val portno: Int) : BlockTransferInterface(true, false) {

    val hasNext = AtomicBoolean(false)

    override fun startSendImpl(recipient: BlockTransferInterface): Int {
        recipient.writeout(ByteArray(BLOCK_SIZE) { vm.getIO().blockTransferTx[portno][it.toLong()] })
        return blockSize.get() // use MMIO to modify this variable
    }

    override fun hasNext(): Boolean = hasNext.get()

    override fun writeoutImpl(inputData: ByteArray) {
        //val copySize = minOf(BLOCK_SIZE, inputData.size).toLong()
        //val arrayOffset = UnsafeHelper.getArrayOffset(inputData)
        //UnsafeHelper.memcpyRaw(inputData, arrayOffset, null, vm.getIO().blockTransferRx[portno].ptr, copySize)

        // not exposing raw memory to block probable security hole
        //println("[BlockTranferPort] writeout size: ${inputData.size}")
        for (k in 0 until BLOCK_SIZE) {
            vm.getIO().blockTransferRx[portno][k.toLong()] = if (k >= inputData.size) 0 else inputData[k]
        }
    }



}