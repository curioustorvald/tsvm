package net.torvald.tsvm.peripheral

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.InputProcessor
import net.torvald.UnsafeHelper
import net.torvald.tsvm.VM
import net.torvald.util.CircularArray
import kotlin.experimental.and

class IOSpace(val vm: VM) : PeriBase, InputProcessor {

    override fun getVM(): VM {
        return vm
    }

    /** Absolute x-position of the computer GUI */
    var guiPosX = 0
    /** Absolute y-position of the computer GUI */
    var guiPosY = 0

    /** Accepts a keycode */
    private val keyboardBuffer = CircularArray<Byte>(32, true)

    internal val blockTransferRx = arrayOf(
        UnsafeHelper.allocate(4096),
        UnsafeHelper.allocate(4096),
        UnsafeHelper.allocate(4096),
        UnsafeHelper.allocate(4096)
    )
    internal val blockTransferTx = arrayOf(
        UnsafeHelper.allocate(4096),
        UnsafeHelper.allocate(4096),
        UnsafeHelper.allocate(4096),
        UnsafeHelper.allocate(4096)
    )
    private val blockTransferPorts = Array(4) { BlockTransferPort(vm, it) }

    private val keyEventBuffers = ByteArray(8)

    init {
        blockTransferPorts[0].attachDevice(TestFunctionGenerator())
    }

    private fun composeBlockTransferStatus(portno: Int): Int {
        return blockTransferPorts[portno].isMaster.toInt().shl(5) or
                blockTransferPorts[portno].isSlave.toInt().shl(4) or
                blockTransferPorts[portno].getMode().toInt().shl(3) or
                blockTransferPorts[portno].busy.toInt().shl(2) or
                blockTransferPorts[portno].areYouReady().toInt().shl(1) or
                blockTransferPorts[portno].cableConnected().toInt()
    }

    private fun setBlockTransferPortStatus(portno: Int, bits: Byte) {
        blockTransferPorts[portno].setMode(bits.and(0b0000_1000) != 0.toByte())
        blockTransferPorts[portno].ready = bits.and(0b0000_0010) != 0.toByte()
        if (bits.and(0b0000_0100) != 0.toByte()) {
            if (blockTransferPorts[portno].getMode())
                blockTransferPorts[portno].startSend()
            else
                blockTransferPorts[portno].startRead()
        }
    }

    override fun peek(addr: Long): Byte? {
        return mmio_read(addr)
    }

    override fun poke(addr: Long, byte: Byte) {
        mmio_write(addr, byte)
    }

    override fun mmio_read(addr: Long): Byte? {
        val adi = addr.toInt()
        return when (addr) {
            in 0..31 -> keyboardBuffer[(addr.toInt())] ?: -1
            in 32..33 -> (mouseX.toInt() shr (adi - 32).times(8)).toByte()
            in 34..35 -> (mouseY.toInt() shr (adi - 34).times(8)).toByte()
            36L -> mouseDown.toInt().toByte()
            37L -> keyboardBuffer.removeTail() ?: -1
            38L -> keyboardInputRequested.toInt().toByte()
            39L -> rawInputFunctionLatched.toInt().toByte()
            in 40..47 -> keyEventBuffers[adi - 40]

            in 64..67 -> vm.memsize.shr((adi - 64) * 8).toByte()
            68L -> (uptimeCounterLatched.toInt() or RTClatched.toInt().shl(1)).toByte()

            in 72..79 -> systemUptime.ushr((adi - 72) * 8).and(255).toByte()
            in 80..87 -> rtc.ushr((adi - 80) * 8).and(255).toByte()

            4084L -> (blockTransferPorts[0].yourBlockSize().toByte())
            4085L -> (blockTransferPorts[0].doYouHaveNext().toInt().shl(7) or blockTransferPorts[0].yourBlockSize().ushr(8).and(15)).toByte()
            4086L -> (blockTransferPorts[1].yourBlockSize().toByte())
            4087L -> (blockTransferPorts[1].doYouHaveNext().toInt().shl(7) or blockTransferPorts[1].yourBlockSize().ushr(8).and(15)).toByte()
            4088L -> (blockTransferPorts[2].yourBlockSize().toByte())
            4089L -> (blockTransferPorts[2].doYouHaveNext().toInt().shl(7) or blockTransferPorts[2].yourBlockSize().ushr(8).and(15)).toByte()
            4090L -> (blockTransferPorts[3].yourBlockSize().toByte())
            4091L -> (blockTransferPorts[3].doYouHaveNext().toInt().shl(7) or blockTransferPorts[3].yourBlockSize().ushr(8).and(15)).toByte()

            in 4092..4095 -> composeBlockTransferStatus(adi - 4092).toByte()

            in 4096..8191 -> blockTransferRx[0][addr - 4096]
            in 8192..12287 -> blockTransferRx[1][addr - 8192]
            in 12288..16383 -> blockTransferRx[2][addr - 12288]
            in 16384..20479 -> blockTransferRx[3][addr - 16384]

            in 131072..262143 -> vm.peripheralTable[1].peripheral?.mmio_read(addr - 131072)
            in 262144..393215 -> vm.peripheralTable[2].peripheral?.mmio_read(addr - 262144)
            in 393216..524287 -> vm.peripheralTable[3].peripheral?.mmio_read(addr - 393216)
            in 524288..655359 -> vm.peripheralTable[4].peripheral?.mmio_read(addr - 524288)
            in 655360..786431 -> vm.peripheralTable[5].peripheral?.mmio_read(addr - 655360)
            in 786432..917503 -> vm.peripheralTable[6].peripheral?.mmio_read(addr - 786432)
            in 917504..1048575 -> vm.peripheralTable[7].peripheral?.mmio_read(addr - 917504)

            else -> -1
        }
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toInt().and(255)
        when (addr) {
            37L -> keyboardBuffer.appendHead(byte)
            38L -> {
                keyboardInputRequested = (byte.isNonZero())
                if (keyboardInputRequested) keyboardBuffer.clear()
            }
            39L -> rawInputFunctionLatched = (byte.isNonZero())
            in 40..47 -> keyEventBuffers[adi - 40] = byte
            68L -> {
                uptimeCounterLatched = byte.and(0b01).isNonZero()
                RTClatched = byte.and(0b10).isNonZero()
            }

            4084L -> blockTransferPorts[0].blockSize = blockTransferPorts[0].blockSize.and(0xFF00) or byte.toInt().and(255)
            4085L -> {
                blockTransferPorts[0].hasNext = (byte < 0)
                blockTransferPorts[0].blockSize = blockTransferPorts[0].blockSize.and(0x00FF) or byte.toInt().and(15)
            }
            4086L -> blockTransferPorts[1].blockSize = blockTransferPorts[1].blockSize.and(0xFF00) or byte.toInt().and(255)
            4087L -> {
                blockTransferPorts[1].hasNext = (byte < 0)
                blockTransferPorts[1].blockSize = blockTransferPorts[1].blockSize.and(0x00FF) or byte.toInt().and(15)
            }
            4088L -> blockTransferPorts[2].blockSize = blockTransferPorts[2].blockSize.and(0xFF00) or byte.toInt().and(255)
            4089L -> {
                blockTransferPorts[2].hasNext = (byte < 0)
                blockTransferPorts[2].blockSize = blockTransferPorts[2].blockSize.and(0x00FF) or byte.toInt().and(15)
            }
            4090L -> blockTransferPorts[3].blockSize = blockTransferPorts[3].blockSize.and(0xFF00) or byte.toInt().and(255)
            4091L -> {
                blockTransferPorts[3].hasNext = (byte < 0)
                blockTransferPorts[3].blockSize = blockTransferPorts[3].blockSize.and(0x00FF) or byte.toInt().and(15)
            }

            in 4092..4095 -> setBlockTransferPortStatus(adi - 4092, byte)

            in 4096..8191 -> blockTransferTx[0][addr - 4096] = byte
            in 8192..12287 -> blockTransferTx[1][addr - 8192] = byte
            in 12288..16383 -> blockTransferTx[2][addr - 12288] = byte
            in 16384..20479 -> blockTransferTx[3][addr - 16384] = byte

            in 131072..262143 -> vm.peripheralTable[1].peripheral?.mmio_write(addr - 131072, byte)
            in 262144..393215 -> vm.peripheralTable[2].peripheral?.mmio_write(addr - 262144, byte)
            in 393216..524287 -> vm.peripheralTable[3].peripheral?.mmio_write(addr - 393216, byte)
            in 524288..655359 -> vm.peripheralTable[4].peripheral?.mmio_write(addr - 524288, byte)
            in 655360..786431 -> vm.peripheralTable[5].peripheral?.mmio_write(addr - 655360, byte)
            in 786432..917503 -> vm.peripheralTable[6].peripheral?.mmio_write(addr - 786432, byte)
            in 917504..1048575 -> vm.peripheralTable[7].peripheral?.mmio_write(addr - 917504, byte)
        }
    }

    override fun dispose() {
        blockTransferRx.forEach { it.destroy() }
        blockTransferTx.forEach { it.destroy() }
    }

    private var mouseX: Short = 0
    private var mouseY: Short = 0
    private var mouseDown = false
    private var systemUptime = 0L
    private var rtc = 0L

    fun update(delta: Float) {
        if (rawInputFunctionLatched) {
            rawInputFunctionLatched = false

            // store mouse info
            mouseX = (Gdx.input.x + guiPosX).toShort()
            mouseY = (Gdx.input.y + guiPosY).toShort()
            mouseDown = Gdx.input.isTouched

            // strobe keys to fill the key read buffer
            var keysPushed = 0
            keyEventBuffers.fill(0)
            for (k in 1..254) {
                if (Gdx.input.isKeyPressed(k)) {
                    keyEventBuffers[keysPushed] = k.toByte()
                    keysPushed += 1
                }

                if (keysPushed >= 8) break
            }
        }

        if (uptimeCounterLatched) {
            uptimeCounterLatched = false
            systemUptime = vm.getUptime()
        }

        if (RTClatched) {
            RTClatched = false
            rtc = System.currentTimeMillis()
        }
    }

    override fun touchUp(p0: Int, p1: Int, p2: Int, p3: Int): Boolean {
        return false
    }

    override fun mouseMoved(p0: Int, p1: Int): Boolean {
        return false
    }

    override fun keyTyped(p0: Char): Boolean {
        if (keyboardInputRequested && !ttySpecialKeyLatched && p0.toInt() > 0) {
            //println("[IO] Key typed: ${p0.toInt()}")
            keyboardBuffer.appendHead(p0.toByte())
            return true
        }
        else {
            return false
        }
    }

    override fun scrolled(p0: Int): Boolean {
        return false
    }

    override fun keyUp(p0: Int): Boolean {
        ttySpecialKeyLatched = false
        return true
    }

    override fun touchDragged(p0: Int, p1: Int, p2: Int): Boolean {
        return false
    }

    private var keyboardInputRequested = false
    private var uptimeCounterLatched = false
    private var RTClatched = false
    private var rawInputFunctionLatched = false
    private var ttySpecialKeyLatched = false
    //                              UP DN LE RI
    private var specialKey = listOf(19,20,21,22).toSortedSet()
    override fun keyDown(p0: Int): Boolean {
        if (keyboardInputRequested && !ttySpecialKeyLatched && p0 in specialKey) {
            //println("[IO] Key down: $p0")
            keyboardBuffer.appendHead(p0.toByte())
        }

        return true
    }

    override fun touchDown(p0: Int, p1: Int, p2: Int, p3: Int): Boolean {
        return false
    }

    private fun Boolean.toInt() = if (this) 1 else 0
    private fun Byte.isNonZero() = this != 0.toByte()
}
