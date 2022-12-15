package net.torvald.tsvm.peripheral

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.VDUtil
import net.torvald.tsvm.VM
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException

/**
 * Created by minjaesong on 2022-12-15.
 */
class TevdDiskDrive(private val vm: VM, private val theRootPath: String) : BlockTransferInterface(false, true) {


    private val DBGPRN = true


    private fun printdbg(msg: Any) {
        if (DBGPRN) println("[TestDiskDrive] $msg")
    }

    private val rootPath = File(theRootPath)

    private var fileOpen = false
    private var fileOpenMode = -1 // 1: 'W", 2: 'A'
    private var file = File(rootPath.toURI())
    //private var readModeLength = -1 // always 4096
    private var writeMode = false
    private var appendMode = false
    private var writeModeLength = -1

    private val messageComposeBuffer = ByteArrayOutputStream(BLOCK_SIZE) // always use this and don't alter blockSendBuffer please
    private var blockSendBuffer = ByteArray(1)
    private var blockSendCount = 0


    init {
        statusCode = TestDiskDrive.STATE_CODE_STANDBY

        if (!rootPath.exists()) {
            throw FileNotFoundException("Disk file '${theRootPath}' not found")
        }
    }

    private val DOM = VDUtil.readDiskArchive(rootPath, charset = VM.CHARSET)

    companion object {
        /** How often the changes in DOM (disk object model) should be saved to the physical drive when there are changes. Seconds. */
        const val COMMIT_INTERVAL = 30
    }

    fun commit() {
        VDUtil.dumpToRealMachine(DOM, rootPath)
    }


    private fun resetBuf() {
        blockSendCount = 0
        messageComposeBuffer.reset()
    }


    override fun hasNext(): Boolean {


        return (blockSendCount * BLOCK_SIZE < blockSendBuffer.size)
    }

    /** Computer's attempt to startRead() will result in calling this very function.
     *
     * Disk drive must send prepared message (or file transfer packet) to the computer.
     */
    override fun startSendImpl(recipient: BlockTransferInterface): Int {
        if (blockSendCount == 0) {
            blockSendBuffer = messageComposeBuffer.toByteArray()
        }

        val sendSize = if (blockSendBuffer.size - (blockSendCount * BLOCK_SIZE) < BLOCK_SIZE)
            blockSendBuffer.size % BLOCK_SIZE
        else BLOCK_SIZE

        recipient.writeout(ByteArray(sendSize) {
            blockSendBuffer[blockSendCount * BLOCK_SIZE + it]
        })

        blockSendCount += 1

        return sendSize
    }

    private lateinit var writeBuffer: ByteArray
    private var writeBufferUsage = 0

    override fun writeoutImpl(inputData: ByteArray) {
        TODO("Not yet implemented")
    }


}