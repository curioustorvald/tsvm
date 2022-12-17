package net.torvald.tsvm.peripheral

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.EntryDirectory
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.VDUtil
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toCanonicalString
import net.torvald.tsvm.VM
import java.io.*
import java.util.*
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Created by minjaesong on 2022-12-15.
 */
class TevdDiskDrive(private val vm: VM, private val driveNum: Int, private val theTevdPath: String, val diskUUIDstr: String) : BlockTransferInterface(false, true) {


    private val DBGPRN = true

    val diskID: UUID = UUID.fromString(diskUUIDstr)


    private fun printdbg(msg: Any) {
        if (DBGPRN) println("[TevDiskDrive] $msg")
    }

    private val tevdPath = File(theTevdPath)
    private val DOM = VDUtil.readDiskArchive(tevdPath, charset = VM.CHARSET)

    private var fileOpen = false
    private var fileOpenMode = -1 // 1: 'W", 2: 'A'
    private var file: TevdFileDescriptor = TevdFileDescriptor(DOM, "")
    //private var readModeLength = -1 // always 4096
    private var writeMode = false
    private var appendMode = false
    private var writeModeLength = -1

    private val messageComposeBuffer = ByteArrayOutputStream(BLOCK_SIZE) // always use this and don't alter blockSendBuffer please
    private var blockSendBuffer = ByteArray(1)
    private var blockSendCount = 0

    private val hasChanges = AtomicBoolean(false)

    init {
        statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)

        if (!tevdPath.exists()) {
            throw FileNotFoundException("Disk file '${theTevdPath}' not found")
        }

        Thread {
            while (vm.isRunning) {
                println("TevdCommitWatchdog ping")
                if (hasChanges.compareAndExchangeAcquire(true, false)) {
                    printdbg("Disk has changes, committing... $theTevdPath")
                    commit()
                }
                else {
                    printdbg("Disk has no changes, skipping... $theTevdPath")
                }
                Thread.sleep(1000L * COMMIT_INTERVAL)
            }
        }.let {
            it.start()
            vm.contexts.add(it)
        }
    }


    companion object {
        /** How often the changes in DOM (disk object model) should be saved to the physical drive when there are changes. Seconds. */
        const val COMMIT_INTERVAL = 5
    }

    fun commit() {
        VDUtil.dumpToRealMachine(DOM, tevdPath)
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
        println("[TevDiskDrive] inputString=${inputData.trimNull().toString(VM.CHARSET)}")

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

                printdbg("Raising HasChanges flag (end of write)")
                hasChanges.set(true)
            }
        }
        else {
            val inputString = inputData.trimNull().toString(VM.CHARSET)

            if (inputString.startsWith("DEVRST\u0017")) {
                printdbg("Device Reset")
                //readModeLength = -1
                fileOpen = false
                fileOpenMode = -1
                file = TevdFileDescriptor(DOM, "")
                blockSendCount = 0
                statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
                writeMode = false
                writeModeLength = -1
            }
            else if (inputString.startsWith("DEVSTU\u0017"))
                recipient?.writeout(
                    TestDiskDrive.composePositiveAns(
                        "${statusCode.get().toChar()}",
                        TestDiskDrive.errorMsgs[statusCode.get()]
                    )
                )
            else if (inputString.startsWith("DEVTYP\u0017"))
                recipient?.writeout(TestDiskDrive.composePositiveAns("STOR"))
            else if (inputString.startsWith("DEVNAM\u0017"))
                recipient?.writeout(TestDiskDrive.composePositiveAns("Generic Disk Drive"))
            else if (inputString.startsWith("OPENR\"") || inputString.startsWith("OPENW\"") || inputString.startsWith("OPENA\"")) {
                if (fileOpen) {

                    statusCode.set(TestDiskDrive.STATE_CODE_FILE_ALREADY_OPENED)
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
                    statusCode.set(TestDiskDrive.STATE_CODE_ILLEGAL_COMMAND)
                    return
                }
                val pathStr = inputString.substring(6, if (commaIndex == 6) inputString.lastIndex else commaIndex - 1)
                val driveNum =
                    if (commaIndex == 6) null else inputString.substring(commaIndex + 1, inputString.length).toInt()
                val filePath = filterSuperRoot(sanitisePath(pathStr))

                // TODO driveNum is for disk drives that may have two or more slots built; for testing purposes we'll ignore it

                file = TevdFileDescriptor(DOM, filePath)
                printdbg("file path: ${file.canonicalPath}, drive num: $driveNum")

                if (openMode == 'R' && !file.exists()) {
                    printdbg("! file not found")
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_SUCH_FILE_EXISTS)
                    return
                }
                else if (DOM.isReadOnly && (openMode == 'W' || openMode == 'A')) {
                    printdbg("! disk is read-only")
                    statusCode.set(TestDiskDrive.STATE_CODE_READ_ONLY)
                    return
                }

                statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
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
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_FILE_OPENED)
                    return
                }
                try {
                    file.delete()
                    printdbg("Raising HasChanges flag (file deleted)")
                    hasChanges.set(true)
                }
                catch (e: SecurityException) {
                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_SECURITY_ERROR)
                    return
                }
                catch (e1: IOException) {
                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_IO_ERROR)
                    return
                }
            }
            else if (inputString.startsWith("LISTFILES")) {
                // TODO temporary behaviour to ignore any arguments
                resetBuf()
                if (!fileOpen) {
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_FILE_OPENED)
                    return
                }
                try {
                    if (file.isDirectory) {
                        file.listFiles()!!.forEachIndexed { index, lsfile ->
                            if (index != 0) messageComposeBuffer.write(0x1E)
                            messageComposeBuffer.write(if (lsfile.isDirectory) 0x11 else 0x12)
                            messageComposeBuffer.write(lsfile.name.toByteArray(VM.CHARSET))
                        }

                        statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
                    }
                    else {
                        statusCode.set(TestDiskDrive.STATE_CODE_NOT_A_DIRECTORY)
                        return
                    }
                }
                catch (e: SecurityException) {
                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_SECURITY_ERROR)
                    return
                }
                catch (e1: IOException) {
                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_IO_ERROR)
                    return
                }
            }
            else if (inputString.startsWith("GETLEN")) {
                // TODO temporary behaviour to ignore any arguments
                resetBuf()
                if (!fileOpen) {
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_FILE_OPENED)
                    return
                }

                messageComposeBuffer.write(getSizeStr().toByteArray(VM.CHARSET))
                statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
            }
            else if (inputString.startsWith("LIST")) {
                // TODO temporary behaviour to ignore any arguments
                resetBuf()
                if (!fileOpen) {
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_FILE_OPENED)
                    return
                }

                messageComposeBuffer.write(getReadableLs().toByteArray(VM.CHARSET))
                statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
            }
            else if (inputString.startsWith("CLOSE")) {
                fileOpen = false
                fileOpenMode = -1
                statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
            }
            else if (inputString.startsWith("READ")) {
                //readModeLength = inputString.substring(4 until inputString.length).toInt()

                resetBuf()
                if (file.isFile) {
                    try {
                        messageComposeBuffer.write(file.readBytes())
                        statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
                    }
                    catch (e: IOException) {
                        statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_IO_ERROR)
                    }
                }
                else {
                    statusCode.set(TestDiskDrive.STATE_CODE_OPERATION_NOT_PERMITTED)
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

                val bootFile = TevdFileDescriptor(DOM, "!BOOTSEC")

                println("bootFile = $bootFile, ID: ${bootFile.entryID}, exists = ${bootFile.exists()}")

                if (!bootFile.exists()) {
                    println("bootfile not exists!")
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_SUCH_FILE_EXISTS)
                    return
                }
                try {
                    val retMsg = bootFile.getHeadBytes(BLOCK_SIZE)

                    println("retMsg = ${retMsg.toString(VM.CHARSET)}")

                    recipient?.writeout(retMsg)
                    statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
                }
                catch (e: IOException) {
                    println("exception:")
                    e.printStackTrace()

                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_IO_ERROR)
                    return
                }
            }
            else if (inputString.startsWith("MKDIR")) {
                if (!fileOpen) {
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_FILE_OPENED)
                    return
                }
                if (fileOpenMode < 1) {
                    statusCode.set(TestDiskDrive.STATE_CODE_OPERATION_NOT_PERMITTED)
                    return
                }
                try {
                    val status = file.mkdir()
                    statusCode.set(if (status) 0 else 1)
                    if (status) {
                        printdbg("Raising HasChanges flag (mkdir)")
                        hasChanges.set(true)
                    }
                }
                catch (e: SecurityException) {
                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_SECURITY_ERROR)
                }
            }
            else if (inputString.startsWith("MKFILE")) {
                if (!fileOpen) {
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_FILE_OPENED)
                    return
                }
                if (fileOpenMode < 1) {
                    statusCode.set(TestDiskDrive.STATE_CODE_OPERATION_NOT_PERMITTED)
                    return
                }
                try {
                    val f1 = file.createNewFile()
                    statusCode.set(if (f1) TestDiskDrive.STATE_CODE_STANDBY else TestDiskDrive.STATE_CODE_OPERATION_FAILED)
                    if (f1) {
                        printdbg("Raising HasChanges flag (mkfile)")
                        hasChanges.set(true)
                    }
                    return
                }
                catch (e: IOException) {
                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_IO_ERROR)
                }
                catch (e1: SecurityException) {
                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_SECURITY_ERROR)
                }
            }
            else if (inputString.startsWith("TOUCH")) {
                if (!fileOpen) {
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_FILE_OPENED)
                    return
                }
                if (fileOpenMode < 1) {
                    statusCode.set(TestDiskDrive.STATE_CODE_OPERATION_NOT_PERMITTED)
                    return
                }
                try {
                    val f1 = file.setLastModified(vm.worldInterface.currentTimeInMills())
                    statusCode.set(if (f1) TestDiskDrive.STATE_CODE_STANDBY else TestDiskDrive.STATE_CODE_OPERATION_FAILED)
                    if (f1) {
                        printdbg("Raising HasChanges flag (touch)")
                        hasChanges.set(true)
                    }
                    return
                }
                catch (e: IOException) {
                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_IO_ERROR)
                }
                catch (e1: SecurityException) {
                    statusCode.set(TestDiskDrive.STATE_CODE_SYSTEM_SECURITY_ERROR)
                }
            }
            else if (inputString.startsWith("WRITE")) {
                if (!fileOpen) {
                    statusCode.set(TestDiskDrive.STATE_CODE_NO_FILE_OPENED)
                    return
                }
                if (fileOpenMode < 0) {
                    statusCode.set(TestDiskDrive.STATE_CODE_OPERATION_NOT_PERMITTED)
                    return
                }
                if (fileOpenMode == 1) { writeMode = true; appendMode = false }
                else if (fileOpenMode == 2) { writeMode = false; appendMode = true }
                if (!file.exists()) {
                    val f1 = file.createNewFile()
                    statusCode.set(if (f1) TestDiskDrive.STATE_CODE_STANDBY else TestDiskDrive.STATE_CODE_OPERATION_FAILED)
                    if (!f1) { return }
                }
                writeModeLength = inputString.substring(5, inputString.length).toInt()
                writeBuffer = ByteArray(writeModeLength)
                writeBufferUsage = 0
                statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
            }
            else
                statusCode.set(TestDiskDrive.STATE_CODE_ILLEGAL_COMMAND)
        }
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

    private fun getReadableLs(): String {
        val sb = StringBuilder()
        val isRoot = (file.entryID == 0)

        if (file.isFile) sb.append(file.name)
        else {
            var filesCount = 0
            var dirsCount = 0

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

                    dirsCount += 1
                }

                sb.append(" ".repeat(40 - filenameLen))

                if (it.isFile) {
                    sb.append("${it.length()} B")

                    filesCount += 1
                }

                sb.append('\n')
            }

            sb.append("\n")
            sb.append("\n$filesCount Files, $dirsCount, Directories")
            sb.append("\nDisk used ${DOM.usedBytes} bytes")
            sb.append("\n${DOM.capacity - DOM.usedBytes} bytes free")
            if (DOM.isReadOnly)
                sb.append("\nThe disk is read-only!")
        }

        return if (sb.last() == '\n') sb.substring(0, sb.lastIndex) else sb.toString()
    }

    private fun getSizeStr(): String {
        val sb = StringBuilder()

        if (file.isFile) sb.append(file.length())
        else sb.append(file.listFiles()!!.size)

        return sb.toString()
    }

}