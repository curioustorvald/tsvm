package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.BlockTransferInterface.Companion.BLOCK_SIZE
import java.io.ByteArrayOutputStream
import kotlin.experimental.and
import kotlin.experimental.or

object SerialHelper {

    private const val SLEEP_TIME = 4L

    fun sendMessageGetBytes(vm: VM, portNo: Int, message: ByteArray): ByteArray {
        sendMessage(vm, portNo, message)
        waitUntilReady(vm, portNo)
        return getMessage(vm, portNo)
    }

    fun sendMessage(vm: VM, portNo: Int, message: ByteArray) {
        if (!checkIfDeviceIsThere(vm, portNo)) throw IllegalStateException("Device not connected")
        if (message.size > BLOCK_SIZE) throw NotImplementedError("sending message greater than 4096 is a future work :p")

        UnsafeHelper.memcpyRaw(
            message, UnsafeHelper.getArrayOffset(message),
            null, vm.getIO().blockTransferTx[portNo].ptr,
            minOf(BLOCK_SIZE, message.size).toLong()
        )
        initiateWriting(vm, portNo)
    }

    fun getMessage(vm: VM, portNo: Int): ByteArray {
        val msgBuffer = ByteArrayOutputStream(BLOCK_SIZE)

        // pull all the blocks of messages
        do {
            initiateReading(vm, portNo)
            while (!checkIfDeviceIsReady(vm, portNo)) { Thread.sleep(SLEEP_TIME) }

            val transStat = getBlockTransferStatus(vm, portNo)
            val incomingMsg = ByteArray(transStat.first)

            UnsafeHelper.memcpyRaw(
                null, vm.getIO().blockTransferRx[portNo].ptr,
                incomingMsg, UnsafeHelper.getArrayOffset(incomingMsg),
                transStat.first.toLong()
            )

            msgBuffer.write(incomingMsg)
        } while (getBlockTransferStatus(vm, portNo).second)

        return msgBuffer.toByteArray()
    }

    fun waitUntilReady(vm: VM, portNo: Int) {
        while (!checkIfDeviceIsReady(vm, portNo)) { Thread.sleep(SLEEP_TIME) }
    }


    private fun checkIfDeviceIsThere(vm: VM, portNo: Int) =
        (vm.getIO().mmio_read(4092L + portNo)!! and 1.toByte()) == 1.toByte()

    private fun checkIfDeviceIsReady(vm: VM, portNo: Int) =
        (vm.getIO().mmio_read(4092L + portNo)!! and 0b110.toByte()) == 0b011.toByte()

    private fun initiateWriting(vm: VM, portNo: Int) {
        vm.getIO().mmio_write(4092L + portNo, 0b1110)
    }

    private fun initiateReading(vm: VM, portNo: Int) {
        vm.getIO().mmio_write(4092L + portNo, 0b0110)
    }

    private fun setBlockTransferStatus(vm: VM, portNo: Int, blockSize: Int, moreToSend: Boolean = false) {
        vm.getIO().mmio_write(4084L + (portNo * 2), (blockSize and 255).toByte())
        vm.getIO().mmio_write(4085L + (portNo * 2),
            ((blockSize ushr 8).and(15) or (moreToSend.toInt() shl 7)).toByte()
        )
    }

    private fun getBlockTransferStatus(vm: VM, portNo: Int): Pair<Int, Boolean> {
        val bits = vm.getIO().mmio_read(4084L + (portNo * 2))!!.toUint() or
                (vm.getIO().mmio_read(4085L + (portNo * 2))!!.toUint() shl 8)
        val rawcnt = bits.and(BLOCK_SIZE - 1)
        return (if (rawcnt == 0) BLOCK_SIZE else rawcnt) to (bits < 0)
    }


    private fun Boolean.toInt() = if (this) 1 else 0
}