package net.torvald.tsvm.peripheral

abstract class BlockTransferInterface(val isMaster: Boolean, val isSlave: Boolean) {

    protected var recipient: BlockTransferInterface? = null

    open var ready = true
    open var busy = false

    protected var sendmode = false; private set
    open var blockSize = 0

    open fun attachDevice(device: BlockTransferInterface?) {
        recipient = device
        device?.recipient = this
    }

    open fun areYouReady(): Boolean = recipient?.ready ?: false
    open fun areYouBusy(): Boolean = recipient?.busy ?: false

    /** A method exposed to outside of the box */
    abstract fun startSend()
    /** The actual implementation */
    protected fun startSend(sendfun: ((BlockTransferInterface) -> Unit)? = null) {
        if (areYouReady()) {
            busy = true
            ready = false

            recipient?.let { recipient ->
                sendfun?.invoke(recipient)
            }

            busy = false
            ready = true
        }
    }

    open fun startRead() {
        recipient?.startSend(null)
    }

    /** A method exposed to outside of the box */
    abstract fun writeout(inputData: ByteArray)
    /** The actual implementation; must be called by a sender class */
    protected fun writeout(inputData: ByteArray, writeoutfun: (() -> Unit)? = null) {
        busy = true
        ready = false
        blockSize = minOf(inputData.size, BLOCK_SIZE)
        writeoutfun?.invoke()
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
    }
}