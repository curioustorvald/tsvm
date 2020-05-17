package net.torvald.tsvm.peripheral

import net.torvald.UnsafeHelper
import net.torvald.tsvm.VM

/**
 * Implementation of single COM port
 */
internal class BlockTransferPort(val vm: VM, val portno: Int) : BlockTransferInterface(true, false) {


    override fun startSend(sendfun: ((BlockTransferInterface) -> Unit)?) {
        super.startSend { recipient ->
            val ba = ByteArray(4096) { vm.getIO().blockTransforBlock[portno][it.toLong()] }
            recipient.writeout(ba)
        }
    }

    override fun writeout(inputData: ByteArray, writeoutfun: (() -> Unit)?) {
        super.writeout(inputData) {
            val copySize = minOf(4096, inputData.size).toLong()
            val arrayOffset = UnsafeHelper.getArrayOffset(inputData).toLong()
            UnsafeHelper.memcpyRaw(inputData, arrayOffset, null, vm.getIO().blockTransforBlock[portno].ptr, copySize)
        }
    }



}