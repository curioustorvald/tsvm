package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.*

class TestDiskDrive(private val driveNum: Int) : BlockTransferInterface(false, true) {

    companion object {
        const val STATE_CODE_STANDBY = 0
        const val STATE_CODE_ILLEGAL_COMMAND = 128
        const val STATE_CODE_FILE_NOT_FOUND = 129
        const val STATE_CODE_FILE_ALREADY_OPENED = 130
        const val STATE_CODE_SYSTEM_IO_ERROR = 192


        val errorMsgs = Array(256) { "" }

        init {
            errorMsgs[STATE_CODE_STANDBY] = "READY"
            errorMsgs[STATE_CODE_ILLEGAL_COMMAND] = "SYNTAX ERROR"
            errorMsgs[STATE_CODE_FILE_NOT_FOUND] = "FILE NOT FOUND"
            errorMsgs[STATE_CODE_FILE_ALREADY_OPENED] = "FILE ALREADY OPENED"
            errorMsgs[STATE_CODE_SYSTEM_IO_ERROR] = "IO ERROR ON SIMULATED DRIVE"
        }
    }

     fun composePositiveAns(vararg msg: String): ByteArray {
        val sb = ArrayList<Byte>()
        sb.add(GOOD_NEWS)
        sb.addAll(msg[0].toByteArray().toTypedArray())
        for (k in 1 until msg.lastIndex) {
            sb.add(UNIT_SEP)
            sb.addAll(msg[k].toByteArray().toTypedArray())
        }
        sb.add(END_OF_SEND_BLOCK)
        return sb.toByteArray()
    }

    fun composeNegativeAns(vararg msg: String): ByteArray {
        val sb = ArrayList<Byte>()
        sb.add(BAD_NEWS)
        sb.addAll(msg[0].toByteArray().toTypedArray())
        for (k in 1 until msg.lastIndex) {
            sb.add(UNIT_SEP)
            sb.addAll(msg[k].toByteArray().toTypedArray())
        }
        sb.add(END_OF_SEND_BLOCK)
        return sb.toByteArray()
    }

    private var fileOpen = false
    private var file: File? = null
    //private var readModeLength = -1 // always 4096
    private var stateCode = STATE_CODE_STANDBY

    private val messageComposeBuffer = ByteArrayOutputStream(BLOCK_SIZE) // always use this and don't alter blockSendBuffer please
    private var blockSendBuffer = ByteArray(1)
    private var blockSendCount = 0

    private val rootPath = File("test_assets/test_drive_$driveNum")


    init {
        if (!rootPath.exists()) {
            rootPath.mkdirs()
        }
    }


    private fun resetBuf() {
        blockSendCount = 0
        messageComposeBuffer.reset()
    }


    override fun hasNext(): Boolean {


        return (blockSendCount * BLOCK_SIZE <= blockSendBuffer.size)
    }

    /** Computer's attempt to startRead() will result in calling this very function.
     *
     * Disk drive must send prepared message (or file transfer packet) to the computer.
     */
    override fun startSend() {
        recipient?.let { recipient ->
            if (blockSendCount == 0) {
                blockSendBuffer = messageComposeBuffer.toByteArray()
            }

            recipient.writeout(ByteArray(BLOCK_SIZE) {
                val i = (blockSendCount + 1) * BLOCK_SIZE
                if (i + it >= blockSendBuffer.size) {
                    0.toByte()
                }
                else {
                    blockSendBuffer[i + it]
                }
            })

            blockSendCount += 1
        }
    }

    /** Computer's attempt to startSend() will result in calling this very function.
     * In such cases, `inputData` will be the message the computer sends.
     *
     * Disk drive must create desired side effects in accordance with the input message.
     */
    override fun writeout(inputData: ByteArray) {
        ready = false
        busy = true


        val inputString = inputData.toString()

        if (inputString.startsWith("DEVRST$END_OF_SEND_BLOCK")) {
            //readModeLength = -1
            fileOpen = false
            file = null
            blockSendCount = 0
            stateCode = STATE_CODE_STANDBY
        }
        else if (inputString.startsWith("DEVSTU$END_OF_SEND_BLOCK")) {
            if (stateCode < 128) {
                recipient?.writeout(composePositiveAns("${stateCode.toChar()}", errorMsgs[stateCode]))
                //startSend { it.writeout(composePositiveAns("${stateCode.toChar()}", errorMsgs[stateCode])) }
            }
            else {
                startSend { it.writeout(composeNegativeAns("${stateCode.toChar()}", errorMsgs[stateCode])) }
            }
        }
        else if (inputString.startsWith("DEVTYP$END_OF_SEND_BLOCK"))
            //startSend { it.writeout(composePositiveAns("STOR")) }
            recipient?.writeout(composePositiveAns("STOR"))
        else if (inputString.startsWith("DEVNAM$END_OF_SEND_BLOCK"))
            //startSend { it.writeout(composePositiveAns("Testtec Virtual Disk Drive")) }
            recipient?.writeout(composePositiveAns("Testtec Virtual Disk Drive"))
        else if (inputString.startsWith("OPENR\"") || inputString.startsWith("OPENW\"") || inputString.startsWith("OPENA\"")) {
            if (file != null) {
                stateCode = STATE_CODE_FILE_ALREADY_OPENED
                return
            }

            val openMode = inputString[4]

            val prop = inputString.subSequence(6, inputString.length).split(",\"")

            if (prop.size == 0 || prop.size > 2) {
                stateCode = STATE_CODE_ILLEGAL_COMMAND
                return
            }
            val filePath = sanitisePath(prop[0])
            val driveNum = if (prop.size != 2) 0 else prop[1].toInt()

            // TODO driveNum is for disk drives that may have two or more slots built; for testing purposes we'll ignore it

            file = File(rootPath, filePath)

            if (openMode == 'R' && !file!!.exists()) {
                stateCode = STATE_CODE_FILE_NOT_FOUND
                return
            }

            fileOpen = true
        }
        else if (inputString.startsWith("LIST")) {
            // temporary behaviour to ignore any arguments
            resetBuf()
            messageComposeBuffer.write(getReadableLs().toByteArray(VM.CHARSET))
        }
        else if (inputString.startsWith("CLOSE")) {
            file = null
            fileOpen = false
        }
        else if (inputString.startsWith("READ")) {
            //readModeLength = inputString.substring(4 until inputString.length).toInt()

            resetBuf()
            if (file?.isFile == true) {
                try {
                    messageComposeBuffer.write(file!!.readBytes())
                    stateCode = STATE_CODE_STANDBY
                }
                catch (e: IOException) {
                    stateCode = STATE_CODE_SYSTEM_IO_ERROR
                }
            }
        }


        ready = true
        busy = false
    }

    val diskID: UUID = UUID(0, 0)

    private fun getReadableLs(): String {
        if (file == null) throw IllegalStateException("No file is opened")

        val sb = StringBuilder()

        if (file!!.isFile) sb.append(file!!.name)
        else {
            sb.append(".\n")
            if (file!!.absolutePath != rootPath.absolutePath) sb.append("..\n")
            // actual entries
            file!!.listFiles()!!.forEach {
                var filenameLen = it.name.length
                sb.append(it.name)
                if (it.isDirectory) {
                    sb.append("/")
                    filenameLen += 1
                }
                sb.append(" ".repeat(40 - filenameLen))
                if (it.isFile) {
                    sb.append("${it.length()} B")
                }
            }
            sb.append('\n')
        }

        return sb.toString()
    }

    private fun sanitisePath(s: String) = s.replace('\\','/').replace(Regex("""\?<>:\*\|"""),"-")

}