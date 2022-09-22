package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.util.*

/**
 * @param driveNum 0 for COM drive number 1, but the file path will still be zero-based
 */
class TestDiskDrive(private val vm: VM, private val driveNum: Int, theRootPath: File? = null) : BlockTransferInterface(false, true) {

    companion object {
        const val STATE_CODE_STANDBY = 0
        const val STATE_CODE_OPERATION_FAILED = 1

        const val STATE_CODE_ILLEGAL_COMMAND = 128
        const val STATE_CODE_NO_SUCH_FILE_EXISTS = 129
        const val STATE_CODE_FILE_ALREADY_OPENED = 130
        const val STATE_CODE_OPERATION_NOT_PERMITTED = 131
        const val STATE_CODE_READ_ONLY = 132
        const val STATE_CODE_NOT_A_FILE = 133
        const val STATE_CODE_NOT_A_DIRECTORY = 134
        const val STATE_CODE_NO_FILE_OPENED = 135
        const val STATE_CODE_SYSTEM_IO_ERROR = 192
        const val STATE_CODE_SYSTEM_SECURITY_ERROR = 193


        val errorMsgs = Array(256) { "" }

        init {
            errorMsgs[STATE_CODE_STANDBY] = "READY"
            errorMsgs[STATE_CODE_OPERATION_FAILED] = "OPERATION FAILED"

            errorMsgs[STATE_CODE_ILLEGAL_COMMAND] = "SYNTAX ERROR"
            errorMsgs[STATE_CODE_NO_SUCH_FILE_EXISTS] = "NO SUCH FILE EXISTS"
            errorMsgs[STATE_CODE_FILE_ALREADY_OPENED] = "FILE ALREADY OPENED"
            errorMsgs[STATE_CODE_SYSTEM_IO_ERROR] = "IO ERROR ON SIMULATED DRIVE"
            errorMsgs[STATE_CODE_SYSTEM_SECURITY_ERROR] = "SECURITY ERROR ON SIMULATED DRIVE"
            errorMsgs[STATE_CODE_OPERATION_NOT_PERMITTED] = "OPERATION NOT PERMITTED"
            errorMsgs[STATE_CODE_NOT_A_FILE] = "NOT A FILE"
            errorMsgs[STATE_CODE_NOT_A_DIRECTORY] = "NOT A DIRECTORY"
            errorMsgs[STATE_CODE_NO_FILE_OPENED] = "NO FILE OPENED"
        }

        fun composePositiveAns(vararg msg: String): ByteArray {
            val sb = ArrayList<Byte>()
            sb.addAll(msg[0].toByteArray().toTypedArray())
            for (k in 1 until msg.size) {
                sb.add(UNIT_SEP)
                sb.addAll(msg[k].toByteArray().toTypedArray())
            }
            sb.add(END_OF_SEND_BLOCK)
            return sb.toByteArray()
        }
    }

    private val DBGPRN = true

    private fun printdbg(msg: Any) {
        if (DBGPRN) println("[TestDiskDrive] $msg")
    }

    private val rootPath = theRootPath ?: File("test_assets/test_drive_$driveNum")

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

    private lateinit var writeBuffer: ByteArray
    private var writeBufferUsage = 0

    /** Computer's attempt to startSend() will result in calling this very function.
     * In such cases, `inputData` will be the message the computer sends.
     *
     * Disk drive must create desired side effects in accordance with the input message.
     */
    override fun writeoutImpl(inputData: ByteArray) {
        if (writeMode || appendMode) {
            //println("[DiskDrive] writeout with inputdata length of ${inputData.size}")
            //println("[DiskDriveMsg] ${inputData.toString(Charsets.UTF_8)}")

            if (!fileOpen) throw InternalError("File is not open but the drive is in write mode")

            System.arraycopy(inputData, 0, writeBuffer, writeBufferUsage, minOf(writeModeLength - writeBufferUsage, inputData.size, BLOCK_SIZE))
            writeBufferUsage += inputData.size

            if (writeBufferUsage >= writeModeLength) {
                // commit to the disk
                if (appendMode)
                    file.appendBytes(writeBuffer)
                else if (writeMode)
                    file.writeBytes(writeBuffer)

                writeMode = false
                appendMode = false
            }
        }
        else {
            val inputString = inputData.trimNull().toString(VM.CHARSET)

            if (inputString.startsWith("DEVRST\u0017")) {
                printdbg("Device Reset")
                //readModeLength = -1
                fileOpen = false
                fileOpenMode = -1
                file = File(rootPath.toURI())
                blockSendCount = 0
                statusCode = STATE_CODE_STANDBY
                writeMode = false
                writeModeLength = -1
            }
            else if (inputString.startsWith("DEVSTU\u0017"))
                recipient?.writeout(composePositiveAns("${statusCode.toChar()}", errorMsgs[statusCode]))
            else if (inputString.startsWith("DEVTYP\u0017"))
                recipient?.writeout(composePositiveAns("STOR"))
            else if (inputString.startsWith("DEVNAM\u0017"))
                recipient?.writeout(composePositiveAns("Testtec Virtual Disk Drive"))
            else if (inputString.startsWith("OPENR\"") || inputString.startsWith("OPENW\"") || inputString.startsWith("OPENA\"")) {
                if (fileOpen) {

                    statusCode = STATE_CODE_FILE_ALREADY_OPENED
                    return
                }

                printdbg("msg: $inputString, lastIndex: ${inputString.lastIndex}")

                val openMode = inputString[4]
                printdbg("open mode: $openMode")
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
                val filePath = filterSuperRoot(sanitisePath(pathStr))

                // TODO driveNum is for disk drives that may have two or more slots built; for testing purposes we'll ignore it

                file = File(rootPath, filePath)
                printdbg("file path: ${file.canonicalPath}, drive num: $driveNum")

                if (openMode == 'R' && !file.exists()) {
                    printdbg("! file not found")
                    statusCode = STATE_CODE_NO_SUCH_FILE_EXISTS
                    return
                }

                statusCode = STATE_CODE_STANDBY
                fileOpen = true
                fileOpenMode = when (openMode) {
                    'W' -> 1
                    'A' -> 2
                    else -> -1
                }
                blockSendCount = 0
            }
            else if (inputString.startsWith("DELETE")) {
                if (!fileOpen) {
                    statusCode = STATE_CODE_NO_FILE_OPENED
                    return
                }
                try {
                    file.delete()
                }
                catch (e: SecurityException) {
                    statusCode = STATE_CODE_SYSTEM_SECURITY_ERROR
                    return
                }
                catch (e1: IOException) {
                    statusCode = STATE_CODE_SYSTEM_IO_ERROR
                    return
                }
            }
            else if (inputString.startsWith("LISTFILES")) {
                // TODO temporary behaviour to ignore any arguments
                resetBuf()
                if (!fileOpen) {
                    statusCode = STATE_CODE_NO_FILE_OPENED
                    return
                }
                try {
                    if (file.isDirectory) {
                        file.listFiles()!!.forEachIndexed { index, lsfile ->
                            if (index != 0) messageComposeBuffer.write(0x1E)
                            messageComposeBuffer.write(if (lsfile.isDirectory) 0x11 else 0x12)
                            messageComposeBuffer.write(lsfile.name.toByteArray(VM.CHARSET))
                        }

                        statusCode = STATE_CODE_STANDBY
                    }
                    else {
                        statusCode = STATE_CODE_NOT_A_DIRECTORY
                        return
                    }
                }
                catch (e: SecurityException) {
                    statusCode = STATE_CODE_SYSTEM_SECURITY_ERROR
                    return
                }
                catch (e1: IOException) {
                    statusCode = STATE_CODE_SYSTEM_IO_ERROR
                    return
                }
            }
            else if (inputString.startsWith("GETLEN")) {
                // TODO temporary behaviour to ignore any arguments
                resetBuf()
                if (!fileOpen) {
                    statusCode = STATE_CODE_NO_FILE_OPENED
                    return
                }

                messageComposeBuffer.write(getSizeStr().toByteArray(VM.CHARSET))
                statusCode = STATE_CODE_STANDBY
            }
            else if (inputString.startsWith("LIST")) {
                // TODO temporary behaviour to ignore any arguments
                resetBuf()
                if (!fileOpen) {
                    statusCode = STATE_CODE_NO_FILE_OPENED
                    return
                }

                messageComposeBuffer.write(getReadableLs().toByteArray(VM.CHARSET))
                statusCode = STATE_CODE_STANDBY
            }
            else if (inputString.startsWith("CLOSE")) {
                fileOpen = false
                fileOpenMode = -1
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
            else if (inputString.startsWith("LOADBOOT")) {
                var commaIndex = 0
                while (commaIndex < inputString.length) {
                    if (inputString[commaIndex] == ',') break
                    commaIndex += 1
                }
                val driveNum = if (commaIndex >= inputString.length) null else commaIndex

                // TODO driveNum is for disk drives that may have two or more slots built; for testing purposes we'll ignore it

                val bootFile = File(rootPath, "!BOOTSEC")

                if (!bootFile.exists()) {
                    statusCode = STATE_CODE_NO_SUCH_FILE_EXISTS
                    return
                }
                val fis = FileInputStream(bootFile)
                try {
                    val retMsg = ByteArray(BLOCK_SIZE)
                    fis.read(retMsg)
                    recipient?.writeout(retMsg)
                    statusCode = STATE_CODE_STANDBY
                }
                catch (e: IOException) {
                    statusCode = STATE_CODE_SYSTEM_IO_ERROR
                    return
                }
                finally {
                    fis.close()
                }
            }
            else if (inputString.startsWith("MKDIR")) {
                if (!fileOpen) {
                    statusCode = STATE_CODE_NO_FILE_OPENED
                    return
                }
                if (fileOpenMode < 1) {
                    statusCode = STATE_CODE_OPERATION_NOT_PERMITTED
                    return
                }
                try {
                    val status = file.mkdir()
                    statusCode = if (status) 0 else 1
                }
                catch (e: SecurityException) {
                    statusCode = STATE_CODE_SYSTEM_SECURITY_ERROR
                }
            }
            else if (inputString.startsWith("MKFILE")) {
                if (!fileOpen) {
                    statusCode = STATE_CODE_NO_FILE_OPENED
                    return
                }
                if (fileOpenMode < 1) {
                    statusCode = STATE_CODE_OPERATION_NOT_PERMITTED
                    return
                }
                try {
                    val f1 = file.createNewFile()
                    statusCode = if (f1) STATE_CODE_STANDBY else STATE_CODE_OPERATION_FAILED
                    return
                }
                catch (e: IOException) {
                    statusCode = STATE_CODE_SYSTEM_IO_ERROR
                }
                catch (e1: SecurityException) {
                    statusCode = STATE_CODE_SYSTEM_SECURITY_ERROR
                }
            }
            else if (inputString.startsWith("TOUCH")) {
                if (!fileOpen) {
                    statusCode = STATE_CODE_NO_FILE_OPENED
                    return
                }
                if (fileOpenMode < 1) {
                    statusCode = STATE_CODE_OPERATION_NOT_PERMITTED
                    return
                }
                try {
                    val f1 = file.setLastModified(vm.worldInterface.currentTimeInMills())
                    statusCode = if (f1) STATE_CODE_STANDBY else STATE_CODE_OPERATION_FAILED
                    return
                }
                catch (e: IOException) {
                    statusCode = STATE_CODE_SYSTEM_IO_ERROR
                }
                catch (e1: SecurityException) {
                    statusCode = STATE_CODE_SYSTEM_SECURITY_ERROR
                }
            }
            else if (inputString.startsWith("WRITE")) {
                if (!fileOpen) {
                    statusCode = STATE_CODE_NO_FILE_OPENED
                    return
                }
                if (fileOpenMode < 0) {
                    statusCode = STATE_CODE_OPERATION_NOT_PERMITTED
                    return
                }
                if (fileOpenMode == 1) { writeMode = true; appendMode = false }
                else if (fileOpenMode == 2) { writeMode = false; appendMode = true }
                writeModeLength = inputString.substring(5, inputString.length).toInt()
                writeBuffer = ByteArray(writeModeLength)
                writeBufferUsage = 0
                statusCode = STATE_CODE_STANDBY
            }
            else
                statusCode = STATE_CODE_ILLEGAL_COMMAND
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
        }

        return if (sb.last() == '\n') sb.substring(0, sb.lastIndex) else sb.toString()
    }

    private fun getSizeStr(): String {
        val sb = StringBuilder()
        val isRoot = (file.absolutePath == rootPath.absolutePath)

        if (file.isFile) sb.append(file.length())
        else sb.append(file.listFiles().size)

        return sb.toString()
    }

    private fun sanitisePath(s: String) = s.replace('\\','/').replace(Regex("""\?<>:\*\|"""),"-")

    // applies a "cap" if the path attemps to access parent directory of the root
    private fun filterSuperRoot(path: String): String {
        if (path.isEmpty()) return path

        var parentCount = 0
        val paths = path.split('/')
        val newPaths = ArrayList<String>()
        paths.forEach {
            if (it.isBlank() || it.isEmpty()) {
                /*do nothing*/
            }
            else if (it == "..") {
                parentCount -= -1
            }
            else if (it != ".") {
                parentCount += 1
            }

            if (parentCount < -1) parentCount = -1

            if (parentCount >= 0) {
                newPaths.add(it)
            }
        }

        return newPaths.joinToString("/")
    }

}