package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM
import java.io.InputStream
import java.io.OutputStream

/**
 * Created by minjaesong on 2022-05-23.
 */
class SerialStdioHost(val hostVM: VM) : BlockTransferInterface(true, true) {

    var otherVM: VM? = null

    override fun attachDevice(device: BlockTransferInterface?) {
        if (device !is SerialStdioHost) throw IllegalArgumentException("Other device is not SerialStdioHost: ${device?.javaClass?.canonicalName}")
        super.attachDevice(device)
        otherVM = device.hostVM
    }

    private fun getOthersFirstGPU(): GraphicsAdapter? {
        return otherVM!!.findPeribyType(VM.PERITYPE_GPU_AND_TERM)?.peripheral as? GraphicsAdapter
    }

    val out = object : OutputStream() {
        override fun write(p0: Int) {
            getOthersFirstGPU()?.writeOut(p0.toByte())
        }
    }

    val err = object : OutputStream() {
        private val SGI_RED = byteArrayOf(0x1B, 0x5B, 0x33, 0x31, 0x6D)
        private val SGI_RESET = byteArrayOf(0x1B, 0x5B, 0x6D)

        override fun write(p0: Int) {
            getOthersFirstGPU()?.let { g ->
                SGI_RED.forEach { g.writeOut(it) }
                g.writeOut(p0.toByte())
                SGI_RESET.forEach { g.writeOut(it) }
            }
        }

        override fun write(p0: ByteArray) {
            getOthersFirstGPU()?.let { g ->
                SGI_RED.forEach { g.writeOut(it) }
                p0.forEach { g.writeOut(it) }
                SGI_RESET.forEach { g.writeOut(it) }
            }
        }
    }

    val `in` = object : InputStream() {
        init {
            otherVM?.getIO()?.mmio_write(38L, 1)
        }

        override fun read(): Int {
            if (otherVM != null) {
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

    override fun writeoutImpl(inputData: ByteArray) {
        TODO("Not yet implemented")
    }

    override fun hasNext(): Boolean {
        TODO("Not yet implemented")
    }


}