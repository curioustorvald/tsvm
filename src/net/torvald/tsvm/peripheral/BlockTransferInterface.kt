package net.torvald.tsvm.peripheral

import java.io.IOException

abstract class BlockTransferInterface(val isMaster: Boolean, val isSlave: Boolean) {

    protected var recipient: BlockTransferInterface? = null

    open @Volatile var ready = true
    open @Volatile var busy = false

    protected var sendmode = false; private set
    open var blockSize = 0

    open fun attachDevice(device: BlockTransferInterface?) {
        recipient = device
        device?.recipient = this
    }

    open fun areYouReady(): Boolean = recipient?.ready ?: false
    open fun areYouBusy(): Boolean = recipient?.busy ?: false

    /** Writes a thing to the recipient.
     * A method exposed to outside of the box */
    abstract fun startSendImpl(recipient: BlockTransferInterface)
    /** The actual implementation */
    fun startSend() {
        //if (areYouReady()) {
            busy = true
            ready = false

            recipient?.let { startSendImpl(it) }

            busy = false
            ready = true
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

    /** A method called by the sender so it can ACTUALLY write its thing onto me. */
    abstract fun writeoutImpl(inputData: ByteArray)
    /** The actual implementation; must be called by a sender class */
    fun writeout(inputData: ByteArray) {
        busy = true
        ready = false
        blockSize = minOf(inputData.size, BLOCK_SIZE)
        writeoutImpl(inputData)
        busy = false
        ready = true
    }
    abstract fun hasNext(): Boolean
    open fun doYouHaveNext(): Boolean = recipient?.hasNext() ?: false
    open fun yourBlockSize(): Int = recipient?.blockSize ?: 0

    /** @param sendmode TRUE for send, FALSE for receive */
    open fun setMode(sendmode: Boolean) {
        this.sendmode = sendmode
    }
    /** @return TRUE for send, FALSE for receive */
    open fun getMode(): Boolean = sendmode

    open fun cableConnected(): Boolean = recipient?.recipient == this

    companion object {
        const val BLOCK_SIZE = 4096
        const val GOOD_NEWS = 0x06.toByte()
        const val BAD_NEWS = 0x15.toByte()
        const val UNIT_SEP = 0x1F.toByte()
        const val END_OF_SEND_BLOCK = 0x17.toByte()
    }
}