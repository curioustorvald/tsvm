package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

abstract class BlockTransferInterface(val isMaster: Boolean, val isSlave: Boolean, val baudRate: Int = 20_000_000) {

    var recipient: BlockTransferInterface? = null; protected set

    val ready = AtomicBoolean(true)
    val busy = AtomicBoolean(false)

    val statusCode = AtomicInteger(0)

    protected var sendmode = false; private set
    val blockSize = AtomicInteger(0)

    open fun attachDevice(device: BlockTransferInterface?) {
        recipient = device
        device?.recipient = this
    }

    open fun areYouReady(): Boolean = recipient?.ready?.get() ?: false
    open fun areYouBusy(): Boolean = recipient?.busy?.get() ?: false

    /** Writes a thing to the recipient.
     * A method exposed to outside of the box
     * @return number of bytes actually sent over*/
    abstract fun startSendImpl(recipient: BlockTransferInterface): Int
    /** The actual implementation */
    fun startSend() {
        //if (areYouReady()) {
            busy.setRelease(true)
            ready.setRelease(false)

            recipient?.let {
                val bytesSent = startSendImpl(it)
                this.blockSize.set(bytesSent)
                applyBaudRateDelay(bytesSent)
                //println("[BlockTransferInterface.startSend()] recipients blocksize = ${this.blockSize}")
            }

            busy.setRelease(false)
            ready.setRelease(true)
        //}
        //else {
        //    throw IOException("${this.javaClass.canonicalName}: Device '${recipient?.javaClass?.canonicalName}' is not ready to receive")
        //}
    }

    /** Ask the recipient to start send its thing to me so that I can 'read'
     */
    open fun startRead() {
        recipient?.startSend()
    }

    /** A method called by the sender so it can ACTUALLY write its thing onto me.
     *
     * @param inputData received message, usually 4096 bytes long and null-padded */
    abstract fun writeoutImpl(inputData: ByteArray)
    /** The actual implementation; must be called by a sender class */
    fun writeout(inputData: ByteArray) {
        busy.setRelease(true)
        ready.setRelease(false)

        val bytesReceived = minOf(inputData.size, BLOCK_SIZE)
        blockSize.setRelease(bytesReceived)
        writeoutImpl(inputData)

//        println("Contents: ${inputData.toString(VM.CHARSET)}")
        applyBaudRateDelay(bytesReceived)

        busy.setRelease(false)
        ready.setRelease(true)
    }
    abstract fun hasNext(): Boolean
    open fun doYouHaveNext(): Boolean = recipient?.hasNext() ?: false
    open fun yourBlockSize(): Int = recipient?.blockSize?.get() ?: 0

    fun getYourStatusCode() = recipient?.statusCode ?: 0

    /** @param sendmode TRUE for send, FALSE for receive */
    open fun setMode(sendmode: Boolean) {
        this.sendmode = sendmode
    }
    /** @return TRUE for send, FALSE for receive */
    open fun getMode(): Boolean = sendmode

    open fun cableConnected(): Boolean = recipient?.recipient == this

    companion object {
        const val BLOCK_SIZE = 4096

        // these consts are UNUSABLE on writeoutImpl because wtf
        // still possible to use on stringbuilder tho
        const val GOOD_NEWS = 0x06.toByte()
        const val BAD_NEWS = 0x15.toByte()
        const val UNIT_SEP = 0x1F.toByte()
        const val END_OF_SEND_BLOCK = 0x17.toByte()
    }


    private var lastTransmissionTime = 0L
    private var delayAkku = 0.0

    /**
     * Calculates and applies appropriate delay based on data size and baud rate
     * @param byteCount Number of bytes being transmitted
     */
    protected fun applyBaudRateDelay(byteCount: Int) {
        if (baudRate <= 0) return

        // Calculate delay in milliseconds
        // Baud rate is bits per second, and we assume 10 bits per byte (8 data bits + start/stop bits)
        val bitsTransmitted = byteCount * 10
        val expectedTransmissionTimeNS = (bitsTransmitted * 1000_000_000L).toDouble() / baudRate

        val currentTime = System.nanoTime()
        val elapsedTime = if (lastTransmissionTime > 0) currentTime - lastTransmissionTime else 0

        // Add to our accumulator
        if (expectedTransmissionTimeNS - elapsedTime > 0)
            delayAkku += expectedTransmissionTimeNS - elapsedTime


        // Only sleep if we need to slow down the transmission
        if (delayAkku >= 1000_000.0) {
            val sleepTimeMS = (delayAkku / 1000000).toLong()
            try {
                Thread.sleep(sleepTimeMS)
//                println("Sleep $sleepTimeMS ms for $byteCount bytes")
                delayAkku -= sleepTimeMS * 1000000.0
            }
            catch (e: InterruptedException) {
                // Handle interruption if needed
            }
        }
        else {
//            println("Sleep skip for $byteCount bytes")
        }

        // Update last transmission time
        lastTransmissionTime = System.nanoTime()
    }
}

fun ByteArray.trimNull(): ByteArray {
    var cnt = BlockTransferInterface.BLOCK_SIZE - 1
    while (cnt >= 0) {
        if (this[cnt] != 0.toByte()) break
        cnt -= 1
    }
    return this.sliceArray(0..cnt)
}

fun ByteArray.startsWith(other: ByteArray) = this.sliceArray(other.indices).contentEquals(other)
