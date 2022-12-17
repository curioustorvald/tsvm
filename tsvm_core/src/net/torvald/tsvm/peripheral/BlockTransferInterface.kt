package net.torvald.tsvm.peripheral

import java.util.concurrent.atomic.AtomicBoolean

abstract class BlockTransferInterface(val isMaster: Boolean, val isSlave: Boolean) {

    protected var recipient: BlockTransferInterface? = null

    @Volatile val ready = AtomicBoolean(true)
    @Volatile val busy = AtomicBoolean(false)

    @Volatile var statusCode = 0

    protected var sendmode = false; private set
    @Volatile var blockSize = 0

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
                this.blockSize = startSendImpl(it)
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
        blockSize = minOf(inputData.size, BLOCK_SIZE)
        writeoutImpl(inputData)
        busy.setRelease(false)
        ready.setRelease(true)
    }
    abstract fun hasNext(): Boolean
    open fun doYouHaveNext(): Boolean = recipient?.hasNext() ?: false
    open fun yourBlockSize(): Int = recipient?.blockSize ?: 0

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
