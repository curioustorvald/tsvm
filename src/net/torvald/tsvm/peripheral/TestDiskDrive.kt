package net.torvald.tsvm.peripheral

import java.io.File
import java.util.*

class TestDiskDrive(private val driveNum: Int) : BlockTransferInterface(false, true) {

    private var fileOpen = false
    private var readModeLength = -1

    private val rootPath = File("test_assets/test_drive_$driveNum")

    init {
        if (!rootPath.exists()) {
            rootPath.mkdirs()
        }
    }

    fun composePositiveAns(vararg msg: String): ByteArray {
        val sb = ArrayList<Byte>()
        sb.add(0x06)
        sb.addAll(msg[0].toByteArray().toTypedArray())
        for (k in 1 until msg.lastIndex) {
            sb.add(0x1F)
            sb.addAll(msg[k].toByteArray().toTypedArray())
        }
        sb.add(0x17)
        return sb.toByteArray()
    }

    fun composeNegativeAns(vararg msg: String): ByteArray {
        val sb = ArrayList<Byte>()
        sb.add(0x15)
        sb.addAll(msg[0].toByteArray().toTypedArray())
        for (k in 1 until msg.lastIndex) {
            sb.add(0x1F)
            sb.addAll(msg[k].toByteArray().toTypedArray())
        }
        sb.add(0x17)
        return sb.toByteArray()
    }

    override fun hasNext(): Boolean {
        if (!fileOpen) return false


        return false
    }

    /** Computer's attempt to startRead() will result in calling this very function.
     *
     * Disk drive must send prepared message (or file transfer packet) to the computer.
     */
    override fun startSend() {
        TODO("Not yet implemented")
    }

    /** Computer's attempt to startSend() will result in calling this very function.
     * In such cases, `inputData` will be the message the computer sends.
     *
     * Disk drive must create desired side effects in accordance with the input message.
     */
    override fun writeout(inputData: ByteArray) {
        val inputString = inputData.toString()

        if (inputString.startsWith("DEVRST\u0017")) {
            readModeLength = -1
            fileOpen = false
        }
        else if (inputString.startsWith("DEVTYP\u0017"))
            startSend { it.writeout(composePositiveAns("STOR")) }
        else if (inputString.startsWith("DEVNAM\u0017"))
            startSend { it.writeout(composePositiveAns("Testtec Virtual Disk Drive")) }
        else if (inputString.startsWith("OPENR\"")) {



            fileOpen = true
        }
        else if (inputString.startsWith("CLOSE")) {



            fileOpen = false
        }
        else if (inputString.startsWith("READ")) {



            readModeLength = inputString.substring(4 until inputString.length).toInt()
        }
        else if (inputString.startsWith("LIST")) {
            startSend { it.writeout("\"LOREM.TXT\"            TXT\nTotal 1 files on the disk".toByteArray()) }
        }
    }

    val diskID: UUID = UUID(0, 0)


}