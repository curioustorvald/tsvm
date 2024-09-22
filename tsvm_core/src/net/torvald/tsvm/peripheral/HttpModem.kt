package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM
import net.torvald.tsvm.peripheral.TestDiskDrive.Companion.STATE_CODE_NO_SUCH_FILE_EXISTS
import net.torvald.tsvm.peripheral.TestDiskDrive.Companion.STATE_CODE_OPERATION_FAILED
import net.torvald.tsvm.peripheral.TestDiskDrive.Companion.STATE_CODE_SYSTEM_IO_ERROR
import net.torvald.tsvm.peripheral.TestDiskDrive.Companion.composePositiveAns
import java.io.*
import java.net.MalformedURLException
import java.net.URL


/**
 * To get a text from the web address, send message: `GET https:en.wikipedia.org/wiki/Http`
 *
 * Note that there is no double-slash after the protocol (or scheme)
 *
 * @param artificialDelayBlockSize How many bytes should be retrieved in a single block-read
 * @param artificialDelayWaitTime Delay in milliseconds between the block-reads. Put positive value in milliseconds to add a delay, zero or negative value to NOT add one.
 *
 * Created by minjaesong on 2022-09-22.
 */
class HttpModem(private val vm: VM, private val artificialDelayBlockSize: Int = 1024, private val artificialDelayWaitTime: Int = -1) : BlockTransferInterface(false, true) {

    private val DBGPRN = true

    private fun printdbg(msg: Any) {
        if (DBGPRN) println("[WgetModem] $msg")
    }

    private var cnxOpen = false
    private var cnxUrl: String? = null

    private val messageComposeBuffer = ByteArrayOutputStream(BLOCK_SIZE) // always use this and don't alter blockSendBuffer please
    private var blockSendBuffer = ByteArray(1)
    private var blockSendCount = 0

    private var writeMode = false
    private var writeModeLength = -1


    init {
        statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
    }

    override fun hasNext(): Boolean {
        return (blockSendCount * BLOCK_SIZE < blockSendBuffer.size)
    }

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

    private fun resetBuf() {
        blockSendCount = 0
        messageComposeBuffer.reset()
    }

    private fun selfReset() {
        //readModeLength = -1
        cnxOpen = false
        cnxUrl = null
        blockSendCount = 0
        writeMode = false
        writeModeLength = -1
    }

    private lateinit var writeBuffer: ByteArray
    private var writeBufferUsage = 0

    override fun writeoutImpl(inputData: ByteArray) {
        if (writeMode) {
            //println("[DiskDrive] writeout with inputdata length of ${inputData.size}")
            //println("[DiskDriveMsg] ${inputData.toString(Charsets.UTF_8)}")

            if (!cnxOpen) throw InternalError("Connection is not established but the modem is in write mode")

            System.arraycopy(inputData, 0, writeBuffer, writeBufferUsage, minOf(writeModeLength - writeBufferUsage, inputData.size, BLOCK_SIZE))
            writeBufferUsage += inputData.size

            if (writeBufferUsage >= writeModeLength) {
                // commit to the disk
                TODO("do something with writeBuffer")

                writeMode = false
            }
        }
        else {
            val inputString = inputData.trimNull().toString(VM.CHARSET)

            if (inputString.startsWith("DEVRST\u0017")) {
                printdbg("Device Reset")
                selfReset()
                statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
            }
            else if (inputString.startsWith("DEVSTU\u0017"))
                recipient?.writeout(composePositiveAns("${statusCode.get().toChar()}", TestDiskDrive.errorMsgs[statusCode.get()]))
            else if (inputString.startsWith("DEVTYP\u0017"))
                recipient?.writeout(composePositiveAns("HTTP"))
            else if (inputString.startsWith("DEVNAM\u0017"))
                recipient?.writeout(composePositiveAns("Wget Company HTTP Modem"))
            else if (inputString.startsWith("GET ")) {
                if (cnxUrl != null) {
                    statusCode.set(TestDiskDrive.STATE_CODE_FILE_ALREADY_OPENED)
                    return
                }

                printdbg("msg: $inputString, lastIndex: ${inputString.lastIndex}")

                cnxUrl = inputString.substring(4).filter { it in '!'..'~' }
                val protocolSep = cnxUrl!!.indexOf(':')
                cnxUrl = cnxUrl!!.substring(0, protocolSep) + "://" + cnxUrl!!.substring(protocolSep + 1)

                printdbg("URL: $cnxUrl")

                this.ready.setRelease(false)
                this.busy.setRelease(true)

                var httpIn: InputStream? = null
                var bufferedOut: OutputStream? = null
                resetBuf()
                try {
                    // check the http connection before we do anything to the fs
                    httpIn = BufferedInputStream(URL(cnxUrl).openStream())
                    messageComposeBuffer.reset()
                    bufferedOut = BufferedOutputStream(messageComposeBuffer, artificialDelayBlockSize)
                    val data = ByteArray(artificialDelayBlockSize)
                    var fileComplete = false
                    var count = 0
                    while (!fileComplete) {
                        count = httpIn.read(data, 0, artificialDelayBlockSize)
                        if (count <= 0) {
                            fileComplete = true
                        } else {
                            bufferedOut.write(data, 0, count)
                        }

                        if (artificialDelayWaitTime > 0) {
                            try {
                                Thread.sleep(artificialDelayWaitTime.toLong())
                            }
                            catch (e: InterruptedException) {}
                        }
                    }
                    statusCode.set(TestDiskDrive.STATE_CODE_STANDBY)
                }
                catch (e: MalformedURLException) {
                    statusCode.set(STATE_CODE_NO_SUCH_FILE_EXISTS) // MalformedUrl
                    printdbg("Malformed URL: $cnxUrl")
                }
                catch (e: IOException) {
                    statusCode.set(STATE_CODE_SYSTEM_IO_ERROR) // IoException
                    printdbg("IOException: $cnxUrl")
                }
                finally {
                    try {
                        bufferedOut?.close()
                        messageComposeBuffer.close()
                        httpIn?.close()
                    }
                    catch (e: IOException) {
                        statusCode.set(STATE_CODE_OPERATION_FAILED)  // UnableToCloseOutputStream
                        printdbg("Unable to close: $cnxUrl")
                    }
                    finally {
                        printdbg("Data in the URL: ${messageComposeBuffer.toString(VM.CHARSET)}")
                        selfReset()
                    }
                }
            }
            else
                statusCode.set(TestDiskDrive.STATE_CODE_ILLEGAL_COMMAND)

        }

    }


}