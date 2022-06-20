package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM
import java.io.InputStream
import java.io.OutputStream

/**
 * Created by minjaesong on 2022-05-23.
 */
class SerialStdioHost(val runnerVM: VM) : BlockTransferInterface(true, true) {

    /**
     * - IDLE: Initial status
     * - HOST: Usually the server computer
     * - TERMINAL: Usually the user computer that connects to the host
     * - PRINTSTREAM: When set, any received bytes will go into the monitor
     * - INPUTSTREAM: When set, any received bytes will be handled internally (usually, when host sets the terminal to this mode, the host will interpret any data sent from the terminal as input by the human behind the terminal)
     */
    enum class Mode {
        IDLE, HOST, CLIENT, PRINTSTREAM, INPUTSTREAM
    }

    var otherVM: VM? = null

    private var mode: Mode = Mode.IDLE
    private var stream: Mode = Mode.IDLE

    override fun attachDevice(device: BlockTransferInterface?) {
        if (device !is SerialStdioHost) throw IllegalArgumentException("Other device is not SerialStdioHost: ${device?.javaClass?.canonicalName}")
        super.attachDevice(device)
        otherVM = device.runnerVM
    }

    private fun getOthersFirstGPU(): GraphicsAdapter {
        return otherVM!!.findPeribyType(VM.PERITYPE_GPU_AND_TERM)?.peripheral as GraphicsAdapter
    }

    private fun getHostsFirstGPU(): GraphicsAdapter {
        return runnerVM.findPeribyType(VM.PERITYPE_GPU_AND_TERM)?.peripheral as GraphicsAdapter
    }

    // sends a byte to client's GPU
    val out = object : OutputStream() {
        override fun write(p0: Int) {
            if ((recipient as SerialStdioHost).readyToBePossessed)
                getOthersFirstGPU().writeOut(p0.toByte())
        }
    }

    val err = object : OutputStream() {
        private val SGI_RED = byteArrayOf(0x1B, 0x5B, 0x33, 0x31, 0x6D)
        private val SGI_RESET = byteArrayOf(0x1B, 0x5B, 0x6D)

        override fun write(p0: Int) {
            if ((recipient as SerialStdioHost).readyToBePossessed) {
                getOthersFirstGPU().let { g ->
                    SGI_RED.forEach { g.writeOut(it) }
                    g.writeOut(p0.toByte())
                    SGI_RESET.forEach { g.writeOut(it) }
                }
            }
        }

        override fun write(p0: ByteArray) {
            if ((recipient as SerialStdioHost).readyToBePossessed) {
                getOthersFirstGPU().let { g ->
                    SGI_RED.forEach { g.writeOut(it) }
                    p0.forEach { g.writeOut(it) }
                    SGI_RESET.forEach { g.writeOut(it) }
                }
            }
        }
    }

    // sends a byte from the client to the host
    val `in` = object : InputStream() {
        init {
            otherVM?.getIO()?.mmio_write(38L, 1)
        }

        override fun read(): Int {
            if (otherVM != null && (recipient as SerialStdioHost).readyToBePossessed) {
                var key: Byte
                do {
                    Thread.sleep(4L) // if spinning rate is too fast, this function will fail.
                    // Possible cause: Input event handling of GDX is done on separate thread
                    key = otherVM!!.getIO().mmio_read(37L)!!
                } while (key == (-1).toByte())

                //println("[stdin] key = $key")
                return key.toInt().and(255)
            }
            else return -1
        }

        override fun close() {
            otherVM?.getIO()?.mmio_write(38L, 0)
        }
    }

    override fun startSendImpl(recipient: BlockTransferInterface): Int {
        TODO("Not yet implemented")
    }

    private var readyToBePossessed = false
    
    /**
     * Commands:
     *
     * - "LISTEN": when idle, sets the device to TERMINAL mode
     * - "HOST": when idle, sets the device to HOST mode
     * - \x14: hangs up the connection and routes stdio back to the TERMINAL's GraphicsAdapter
     *
     * // NOTE TO SELF: are these necessary?
     *
     * - \x11: tells TERMINAL to enter printstream mode (routes stdio to this device)
     * - \x12: tells TERMINAL to enter datastream mode
     * - \x13: tells TERMINAL to enter keyboard-read mode
     */
    override fun writeoutImpl(inputData: ByteArray) {
        val inputString = inputData.trimNull().toString(VM.CHARSET)

        if (mode == Mode.IDLE) {
            if (inputString.startsWith("LISTEN")) {
                mode = Mode.CLIENT
                readyToBePossessed = true
            }
            else if (inputString.startsWith("HOST")) {
                mode = Mode.HOST
                hijackHostPrint()
                hijackClientRead()
            }
        }
        else {
            if (mode == Mode.HOST) {
                when (inputData[0]) {
                    DC_HUP -> {
                        releaseHostPrint()
                        releaseClientRead()
                        mode = Mode.IDLE
                    }
                }
            }
            else if (mode == Mode.CLIENT) {
                when (inputData[0]) {
                    DC_HUP -> {
                        mode = Mode.IDLE
                        readyToBePossessed = false
                    }
                }
            }
        }
    }

    private fun hijackHostPrint() {
        runnerVM.getPrintStream = { this.out }
        runnerVM.getErrorStream = { this.err }
    }

    private fun hijackClientRead() {
        otherVM!!.getInputStream = { this.`in` }
    }

    private fun releaseHostPrint() {
        getHostsFirstGPU().let {
            runnerVM.getPrintStream = { it.getPrintStream() }
            runnerVM.getErrorStream = { it.getErrorStream() }
        }
    }

    private fun releaseClientRead() {
        otherVM!!.getInputStream = { getOthersFirstGPU().getInputStream() }
    }

    override fun hasNext(): Boolean {
        TODO("Not yet implemented")
    }

    private companion object {
        const val DC_PRINT = 0x11.toByte()
        const val DC_DATA = 0x12.toByte()
        const val DC_INPUT = 0x13.toByte()
        const val DC_HUP = 0x14.toByte()
    }
}