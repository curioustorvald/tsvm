package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.BlockTransferInterface.Companion.BLOCK_SIZE
import net.torvald.tsvm.peripheral.BlockTransferInterface.Companion.END_OF_SEND_BLOCK
import net.torvald.tsvm.peripheral.trimNull
import java.io.ByteArrayOutputStream
import kotlin.experimental.and
import kotlin.experimental.or
import kotlin.math.ceil

object SerialHelper {

    private const val SLEEP_TIME = 1L

    fun sendMessageGetBytes(vm: VM, portNo: Int, message: ByteArray): ByteArray {
        sendMessage(vm, portNo, message)
        waitUntilReady(vm, portNo)
        return fetchResponse(vm, portNo)
    }

    fun sendMessage(vm: VM, portNo: Int, message: ByteArray) {
        if (!checkIfDeviceIsThere(vm, portNo)) throw IllegalStateException("Device not connected")

        /*UnsafeHelper.memcpyRaw(
            message, UnsafeHelper.getArrayOffset(message),
            null, vm.getIO().blockTransferTx[portNo].ptr,
            minOf(BLOCK_SIZE, message.size).toLong()
        )*/

        for (blockCount in 0 until ceil(message.size.toFloat() / BLOCK_SIZE).toInt()) {
            for (k in 0 until BLOCK_SIZE) {
                val index = BLOCK_SIZE * blockCount + k
                vm.getIO().blockTransferTx[portNo][k.toLong()] = if (index >= message.size) 0 else message[index]
            }
            initiateWriting(vm, portNo)
            waitUntilReady(vm, portNo)
        }


        // TODO assuming the write operation is finished... (wait for something?)
        getReady(vm, portNo)
    }

    // Returns what's on the RX buffer after sendMessage()
    // i.e won't (actually shouldn't) clobber the device's message compose buffer (see TestDiskDrive)
    fun fetchResponse(vm: VM, portNo: Int): ByteArray {
        val incomingMsg = ByteArray(BLOCK_SIZE)

        // incoming message is always 4K long and unused bytes are zero-filled. THIS IS INTENTIONAL
        UnsafeHelper.memcpyRaw(
            null, vm.getIO().blockTransferRx[portNo].ptr,
            incomingMsg, UnsafeHelper.getArrayOffset(incomingMsg),
            BLOCK_SIZE.toLong()
        )

        return incomingMsg
    }

    // Initiates startSend() function from the connected device
    fun pullMessage(vm: VM, portNo: Int): ByteArray {
        val msgBuffer = ByteArrayOutputStream(BLOCK_SIZE)

        // pull all the blocks of messages
        do {
            initiateReading(vm, portNo)
            waitUntilReady(vm, portNo)

            val transStat = getBlockTransferStatus(vm, portNo)
            val receivedLen = transStat.first//vm.getIO().blockTransferPorts[portNo].yourBlockSize()
            //println("[SerialHelper.pullMessage()] received length: $receivedLen")

            for (k in 0 until minOf(BLOCK_SIZE, receivedLen)) {
                msgBuffer.write(vm.getIO().blockTransferRx[portNo][k.toLong()].toInt())
            }

        } while (transStat.second)

        getReady(vm, portNo)

        return msgBuffer.toByteArray()
    }

    fun getDeviceStatus(vm: VM, portNo: Int): DeviceStatus {
        val msgStr = sendMessageGetBytes(vm, portNo, "DEVSTU$END_OF_SEND_BLOCK".toByteArray(VM.CHARSET))
        return DeviceStatus(
            msgStr[1].toUint(),
            msgStr.sliceArray(3 until msgStr.size - 1).toString(VM.CHARSET)
        )
    }

    fun waitUntilReady(vm: VM, portNo: Int) {
        while (!checkIfDeviceIsReady(vm, portNo)) { Thread.sleep(SLEEP_TIME) }
    }

    fun getStatusCode(vm: VM, portNo: Int) = vm.getIO().mmio_read(4080L + portNo)!!.toInt().and(255)

    fun checkIfDeviceIsThere(vm: VM, portNo: Int) =
        (vm.getIO().mmio_read(4092L + portNo)!! and 1.toByte()) == 1.toByte()

    fun checkIfDeviceIsReady(vm: VM, portNo: Int) =
        (vm.getIO().mmio_read(4092L + portNo)!! and 0b111.toByte()) == 0b011.toByte()

    private fun initiateWriting(vm: VM, portNo: Int) {
        vm.getIO().mmio_write(4092L + portNo, 0b1110)
    }

    private fun initiateReading(vm: VM, portNo: Int) {
        vm.getIO().mmio_write(4092L + portNo, 0b0110)
    }

    private fun getReady(vm: VM, portNo: Int) {
        val flags = vm.getIO().mmio_read(4092L + portNo)!!
        val newFlags = flags.and(0b1111_1001.toByte()).or(0b0000_0010)
        vm.getIO().mmio_write(4092L + portNo, newFlags)
    }

    private fun setBlockTransferStatus(vm: VM, portNo: Int, blockSize: Int, moreToSend: Boolean = false) {
        vm.getIO().mmio_write(4084L + (portNo * 2), (blockSize and 255).toByte())
        vm.getIO().mmio_write(4085L + (portNo * 2),
            ((blockSize ushr 8).and(15) or (moreToSend.toInt(7)) or (blockSize == 0).toInt(4)).toByte()
        )
    }

    private fun getBlockTransferStatus(vm: VM, portNo: Int): Pair<Int, Boolean> {
        val lb = vm.getIO().mmio_read(4084L + (portNo * 2))!!.toUint()
        val hb = vm.getIO().mmio_read(4085L + (portNo * 2))!!.toUint()
        val bits = lb or (hb shl 8)
        val rawcnt = bits.and(4095)
        val gotMore = bits.and(0x8000) != 0
        val actuallyZero = (hb and 0x10 != 0)
        return (if (rawcnt == 0 && !actuallyZero) BLOCK_SIZE else rawcnt) to gotMore
    }

    data class DeviceStatus(val code: Int, val message: String)
}

class SerialHelperDelegate(private val vm: VM) {
    fun sendMessage(portNo: Int, message: String) = SerialHelper.sendMessage(vm, portNo, message.toByteArray(VM.CHARSET))
    fun pullMessage(portNo: Int) = SerialHelper.pullMessage(vm, portNo).toString(VM.CHARSET)
    fun sendMessageGetBytes(portNo: Int, message: String) = SerialHelper.sendMessageGetBytes(vm, portNo, message.toByteArray(VM.CHARSET)).toString(VM.CHARSET)
    fun fetchResponse(portNo: Int) = SerialHelper.fetchResponse(vm, portNo).toString(VM.CHARSET)
    fun waitUntilReady(portNo: Int) = SerialHelper.waitUntilReady(vm, portNo)
    fun getStatusCode(portNo: Int) = SerialHelper.getStatusCode(vm, portNo)
    /** @return Object where { code: <Int>, message: <String> } */
    fun getDeviceStatus(portNo: Int) = SerialHelper.getDeviceStatus(vm, portNo)
    fun areYouThere(portNo: Int) = SerialHelper.checkIfDeviceIsThere(vm, portNo)
}