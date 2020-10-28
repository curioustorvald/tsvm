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
        const val STATE_CODE_OPERATION_NOT_PERMITTED = 131
        const val STATE_CODE_SYSTEM_IO_ERROR = 192


        val errorMsgs = Array(256) { "" }

        init {
            errorMsgs[STATE_CODE_STANDBY] = "READY"
            errorMsgs[STATE_CODE_ILLEGAL_COMMAND] = "SYNTAX ERROR"
            errorMsgs[STATE_CODE_FILE_NOT_FOUND] = "FILE NOT FOUND"
            errorMsgs[STATE_CODE_FILE_ALREADY_OPENED] = "FILE ALREADY OPENED"
            errorMsgs[STATE_CODE_SYSTEM_IO_ERROR] = "IO ERROR ON SIMULATED DRIVE"
            errorMsgs[STATE_CODE_OPERATION_NOT_PERMITTED] = "OPERATION NOT PERMITTED"
        }
    }

     fun composePositiveAns(vararg msg: String): ByteArray {
        val sb = ArrayList<Byte>()
        sb.add(GOOD_NEWS)
        sb.addAll(msg[0].toByteArray().toTypedArray())
        for (k in 1 until msg.size) {
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
        for (k in 1 until msg.size) {
            sb.add(UNIT_SEP)
            sb.addAll(msg[k].toByteArray().toTypedArray())
        }
        sb.add(END_OF_SEND_BLOCK)
        return sb.toByteArray()
    }

    private val rootPath = File("test_assets/test_drive_$driveNum")

    private var fileOpen = false
    private var file = File(rootPath.toURI())
    //private var readModeLength = -1 // always 4096
    private var writeMode = false
    private var writeModeLength = -1

    private val messageComposeBuffer = ByteArrayOutputStream(BLOCK_SIZE) // always use this and don't alter blockSendBuffer please
    private var blockSendBuffer = ByteArray(1)
    private var blockSendCount = 0


    init {
        statusCode = STATE_CODE_STANDBY

        if (!rootPath.exists()) {
            rootPath.mkdirs()
        }
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

    /** Computer's attempt to startSend() will result in calling this very function.
     * In such cases, `inputData` will be the message the computer sends.
     *
     * Disk drive must create desired side effects in accordance with the input message.
     */
    override fun writeoutImpl(inputData: ByteArray) {
        if (writeMode) {

        }
        else {
            val inputString = trimNull(inputData).toString(VM.CHARSET)

            if (inputString.startsWith("DEVRST\u0017")) {
                //readModeLength = -1
                fileOpen = false
                file = File(rootPath.toURI())
                blockSendCount = 0
                statusCode = STATE_CODE_STANDBY
                writeMode = false
                writeModeLength = -1
            }
            else if (inputString.startsWith("DEVSTU\u0017")) {
                if (statusCode < 128) {
                    recipient?.writeout(composePositiveAns("${statusCode.toChar()}", errorMsgs[statusCode]))
                }
                else {
                    recipient?.writeout(composeNegativeAns("${statusCode.toChar()}", errorMsgs[statusCode]))
                }
            }
            else if (inputString.startsWith("DEVTYP\u0017"))
                recipient?.writeout(composePositiveAns("STOR"))
            else if (inputString.startsWith("DEVNAM\u0017"))
                recipient?.writeout(composePositiveAns("Testtec Virtual Disk Drive"))
            else if (inputString.startsWith("OPENR\"") || inputString.startsWith("OPENW\"") || inputString.startsWith("OPENA\"")) {
                if (fileOpen) {
                    statusCode = STATE_CODE_FILE_ALREADY_OPENED
                    return
                }

                println("[TestDiskDrive] msg: $inputString, lastIndex: ${inputString.lastIndex}")

                val openMode = inputString[4]
                println("[TestDiskDrive] open mode: $openMode")
                // split inputstring into path and optional drive-number

                // get position of latest delimeter (comma)
                var commaIndex = inputString.lastIndex
                while (commaIndex > 6) {
                    if (inputString[commaIndex] == ',') break; commaIndex -= 1
                }
                // sanity check if path is actually enclosed with double-quote
                if (commaIndex != 6 && inputString[commaIndex - 1] != '"') {
                    statusCode = STATE_CODE_ILLEGAL_COMMAND
                    return
                }
                val pathStr = inputString.substring(6, if (commaIndex == 6) inputString.lastIndex else commaIndex - 1)
                val driveNum =
                    if (commaIndex == 6) null else inputString.substring(commaIndex + 1, inputString.length).toInt()
                val filePath = sanitisePath(pathStr)

                // TODO driveNum is for disk drives that may have two or more slots built; for testing purposes we'll ignore it

                file = File(rootPath, filePath)
                println("[TestDiskDrive] file path: ${file.canonicalPath}, drive num: $driveNum")

                if (openMode == 'R' && !file.exists()) {
                    println("! file not found")
                    statusCode = STATE_CODE_FILE_NOT_FOUND
                    return
                }

                statusCode = STATE_CODE_STANDBY
                fileOpen = true
                blockSendCount = 0
            }
            else if (inputString.startsWith("LIST")) {
                // temporary behaviour to ignore any arguments
                resetBuf()
                messageComposeBuffer.write(getReadableLs().toByteArray(VM.CHARSET))
                statusCode = STATE_CODE_STANDBY
            }
            else if (inputString.startsWith("CLOSE")) {
                fileOpen = false
                statusCode = STATE_CODE_STANDBY
            }
            else if (inputString.startsWith("READ")) {
                //readModeLength = inputString.substring(4 until inputString.length).toInt()

                resetBuf()
                if (file.isFile) {
                    try {
                        messageComposeBuffer.write(file.readBytes())
                        statusCode = STATE_CODE_STANDBY
                    }
                    catch (e: IOException) {
                        statusCode = STATE_CODE_SYSTEM_IO_ERROR
                    }
                }
                else {
                    statusCode = STATE_CODE_OPERATION_NOT_PERMITTED
                    return
                }
            }
        }
    }

    val diskID: UUID = UUID(0, 0)

    private fun getReadableLs(): String {
        val sb = StringBuilder()
        val isRoot = (file.absolutePath == rootPath.absolutePath)

        if (file.isFile) sb.append(file.name)
        else {
            sb.append("Current directory: ")
            sb.append(if (isRoot) "(root)" else file.path)
            sb.append('\n')

            sb.append(".\n")
            if (isRoot) sb.append("..\n")
            // actual entries
            file.listFiles()!!.forEach {
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

                sb.append('\n')
            }
            sb.append('\n')
        }

        return sb.toString()
    }

    private fun sanitisePath(s: String) = s.replace('\\','/').replace(Regex("""\?<>:\*\|"""),"-")

}