package net.torvald.tsvm.peripheral

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.Input
import com.badlogic.gdx.InputProcessor
import com.badlogic.gdx.backends.lwjgl3.audio.OpenALLwjgl3Audio
import com.badlogic.gdx.math.Vector2
import com.badlogic.gdx.utils.viewport.Viewport
import net.torvald.AddressOverflowException
import net.torvald.DanglingPointerException
import net.torvald.UnsafeHelper
import net.torvald.tsvm.CircularArray
import net.torvald.tsvm.VM
import net.torvald.tsvm.isNonZero
import net.torvald.tsvm.toInt
import java.util.concurrent.atomic.AtomicInteger
import kotlin.experimental.and
import kotlin.math.floor

class IOSpace(val vm: VM) : PeriBase("io"), InputProcessor {

    override fun getVM(): VM {
        return vm
    }

    /**
     * Viewport that maps screen pixels (as reported by `Gdx.input.x/y`) to the VM's
     * logical framebuffer coordinate space. The host application owns the rendering
     * camera, so the host is responsible for installing a viewport whose world
     * coordinates match the VM framebuffer (origin top-left, world size = framebuffer
     * size in pixels) and whose screen rectangle matches where the VM is drawn.
     *
     * If left null, `Gdx.input.x/y` is forwarded verbatim — only correct when the VM
     * occupies the entire window at 1:1 scale.
     */
    var inputViewport: Viewport? = null
    private val tmpMouseVec = Vector2()
    // Letterbox offset and renderable area inside the inputViewport, set by the host VMGUI.
    // After unproject, mouse pixel coords are shifted by (inputOriginX, inputOriginY) and
    // clamped to (inputAreaW, inputAreaH) so apps see VM-screen pixel coords (0..drawWidth).
    var inputOriginX: Int = 0
    var inputOriginY: Int = 0
    var inputAreaW: Int = Int.MAX_VALUE
    var inputAreaH: Int = Int.MAX_VALUE

    /** Accepts a keycode */
    private val keyboardBuffer = CircularArray<Byte>(32, true)

    internal val blockTransferRx = arrayOf(
        UnsafeHelper.allocate(4096, this),
        UnsafeHelper.allocate(4096, this),
        UnsafeHelper.allocate(4096, this),
        UnsafeHelper.allocate(4096, this)
    )
    internal val blockTransferTx = arrayOf(
        UnsafeHelper.allocate(4096, this),
        UnsafeHelper.allocate(4096, this),
        UnsafeHelper.allocate(4096, this),
        UnsafeHelper.allocate(4096, this)
    )
    /*private*/ val blockTransferPorts = Array(4) { BlockTransferPort(vm, it) }

    internal val peripheralFast = UnsafeHelper.allocate(1024, this)

    private val keyEventBuffers = ByteArray(8)

    private var acpiShutoff = true
    private var bmsIsCharging = false
    private var bmsHasBattery = false
    private var bmsIsBatteryOperated = false

    /** Built-in beeper / PSG speaker (MMIO 93..99). See terranmon.txt §93..99. */
    private val beeper = Beeper()

    init {
        //blockTransferPorts[1].attachDevice(TestFunctionGenerator())
        //blockTransferPorts[0].attachDevice(TestDiskDrive(vm, 0, File("assets")))
        //blockTransferPorts[0].attachDevice(TestDiskDrive(vm, 0, File("assets/disk0")))

        // for testers: use EmulInstance

        peripheralFast.fillWith(0)
    }

    private fun composeBlockTransferStatus(portno: Int): Int {
        return blockTransferPorts[portno].isMaster.toInt(5) or
                blockTransferPorts[portno].isSlave.toInt(4) or
                blockTransferPorts[portno].getMode().toInt(3) or
                blockTransferPorts[portno].busy.get().toInt(2) or
                blockTransferPorts[portno].areYouReady().toInt(1) or
                blockTransferPorts[portno].cableConnected().toInt()
    }

    private fun setBlockTransferPortStatus(portno: Int, bits: Byte) {
        blockTransferPorts[portno].setMode(bits.and(0b0000_1000) != 0.toByte())
        blockTransferPorts[portno].ready.set(bits.and(0b0000_0010) != 0.toByte())
        if (bits.and(0b0000_0100) != 0.toByte()) {
            if (blockTransferPorts[portno].getMode()) {
                //println("[IOSpace] startSend()")
                blockTransferPorts[portno].startSend()
            }
            else {
                //println("[IOSpace] startRead()")
                blockTransferPorts[portno].startRead()
            }
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
            36L -> {
                // bit 0: left, bit 1: right, bit 2: middle, bit 6: wheel up, bit 7: wheel down
                // Wheel bits are latched on scrolled() and cleared on read so a one-shot
                // detent fires exactly once for the polling app.
                (mouseButtons or wheelLatch.getAndSet(0)).toByte()
            }
            37L -> {
                val key = keyboardBuffer.removeTail() ?: -1
                keyPushed = !keyboardBuffer.isEmpty  // Clear flag when buffer becomes empty
                key
            }
            38L -> keyboardInputRequested.toInt().toByte()
            39L -> rawInputFunctionLatched.toInt().toByte()
            in 40..47 -> keyEventBuffers[adi - 40]
            48L -> (vm.resetDown.toInt(7) or vm.sysrqDown.toInt(6) or vm.stopDown.toInt()).toByte()
            49L -> keyPushed.toInt().toByte()

            in 64..67 -> vm.memsize.shr((adi - 64) * 8).toByte()
            68L -> (uptimeCounterLatched.toInt() or RTClatched.toInt(1)).toByte()

            in 72..79 -> systemUptime.ushr((adi - 72) * 8).and(255).toByte()
            in 80..87 -> rtc.ushr((adi - 80) * 8).and(255).toByte()

            88L -> vm.romMapping.toByte()

            89L -> ((acpiShutoff.toInt(7)) or (bmsIsBatteryOperated.toInt(3)) or (bmsHasBattery.toInt(1))
                    or bmsIsCharging.toInt()).toByte()

            // 93 RO: reading uploads the staged command (94..99) into the live tone and
            //        returns the beeper status (bit 0 = a tone is currently sounding).
            93L -> beeper.upload()
            in 94..99 -> beeper.readCommand(adi - 94)

            in 2048L..4075L -> hyveArea[addr.toInt() - 2048]

            in 1024..2047 -> peripheralFast[addr - 1024]

            4076L -> blockTransferPorts[0].statusCode.toByte()
            4077L -> blockTransferPorts[1].statusCode.toByte()
            4078L -> blockTransferPorts[2].statusCode.toByte()
            4079L -> blockTransferPorts[3].statusCode.toByte()

            4080L -> blockTransferPorts[0].getYourStatusCode().toByte()
            4081L -> blockTransferPorts[1].getYourStatusCode().toByte()
            4082L -> blockTransferPorts[2].getYourStatusCode().toByte()
            4083L -> blockTransferPorts[3].getYourStatusCode().toByte()

            4084L -> (blockTransferPorts[0].yourBlockSize().toByte())
            4085L -> (blockTransferPorts[0].doYouHaveNext().toInt(7) or (blockTransferPorts[0].yourBlockSize() == 0).toInt(4) or blockTransferPorts[0].yourBlockSize().ushr(8).and(15)).toByte()
            4086L -> (blockTransferPorts[1].yourBlockSize().toByte())
            4087L -> (blockTransferPorts[1].doYouHaveNext().toInt(7) or (blockTransferPorts[1].yourBlockSize() == 0).toInt(4) or blockTransferPorts[1].yourBlockSize().ushr(8).and(15)).toByte()
            4088L -> (blockTransferPorts[2].yourBlockSize().toByte())
            4089L -> (blockTransferPorts[2].doYouHaveNext().toInt(7) or (blockTransferPorts[2].yourBlockSize() == 0).toInt(4) or blockTransferPorts[2].yourBlockSize().ushr(8).and(15)).toByte()
            4090L -> (blockTransferPorts[3].yourBlockSize().toByte())
            4091L -> (blockTransferPorts[3].doYouHaveNext().toInt(7) or (blockTransferPorts[3].yourBlockSize() == 0).toInt(4) or blockTransferPorts[3].yourBlockSize().ushr(8).and(15)).toByte()

            in 4092..4095 -> composeBlockTransferStatus(adi - 4092).toByte()

            in 4096..8191 -> blockTransferRx[0][addr - 4096]
            in 8192..12287 -> blockTransferRx[1][addr - 8192]
            in 12288..16383 -> blockTransferRx[2][addr - 12288]
            in 16384..20479 -> blockTransferRx[3][addr - 16384]

            in 65536..131071 -> if (vm.romMapping == -1) 255.toByte() else vm.roms[vm.romMapping]?.get(adi - 65536)

            in 131072..262143 -> vm.peripheralTable[1].peripheral?.mmio_read(addr - 131072)
            in 262144..393215 -> vm.peripheralTable[2].peripheral?.mmio_read(addr - 262144)
            in 393216..524287 -> vm.peripheralTable[3].peripheral?.mmio_read(addr - 393216)
            in 524288..655359 -> vm.peripheralTable[4].peripheral?.mmio_read(addr - 524288)
            in 655360..786431 -> vm.peripheralTable[5].peripheral?.mmio_read(addr - 655360)
            in 786432..917503 -> vm.peripheralTable[6].peripheral?.mmio_read(addr - 786432)
            in 917504..1048575 -> vm.peripheralTable[7].peripheral?.mmio_read(addr - 917504)

            else -> null
        }
    }

    private val hyveArea = ByteArray(2048)
    private var keyPushed = false

    override fun mmio_write(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toInt().and(255)
        try {
            when (addr) {
                37L -> keyboardBuffer.appendHead(byte)
                38L -> {
                    keyboardInputRequested = (byte.isNonZero())
                    if (keyboardInputRequested) {
                        keyboardBuffer.clear()
                        keyPushed = false  // Reset flag when buffer is cleared
                        vm.isIdle.set(true)
                    }
                    else
                        vm.isIdle.set(false)
                }

                39L -> rawInputFunctionLatched = (byte.isNonZero())
                in 40..47 -> keyEventBuffers[adi - 40] = byte
                49L -> keyPushed = (bi != 0)
                68L -> {
                    uptimeCounterLatched = byte.and(0b01).isNonZero()
                    RTClatched = byte.and(0b10).isNonZero()
                }

                88L -> vm.romMapping = bi
                89L -> {
                    acpiShutoff = byte.and(-128).isNonZero()
                }

                // 94..99 RW: beeper command staging. Takes effect on the next read of MMIO 93.
                in 94..99 -> beeper.writeCommand(adi - 94, byte)

                in 2048L..4075L -> hyveArea[addr.toInt() - 2048] = byte

                in 1024..2047 -> peripheralFast[addr - 1024] = byte

                4076L -> blockTransferPorts[0].statusCode.set(bi)
                4077L -> blockTransferPorts[1].statusCode.set(bi)
                4078L -> blockTransferPorts[2].statusCode.set(bi)
                4079L -> blockTransferPorts[3].statusCode.set(bi)

                4084L ->
                    blockTransferPorts[0].blockSize.getAcquire().let {
                        blockTransferPorts[0].blockSize.setRelease(it.and(0xFF00) or byte.toInt().and(255))
                    }

                4085L -> {
                    blockTransferPorts[0].hasNext.set(byte < 0)
                    blockTransferPorts[0].blockSize.getAcquire().let {
                        blockTransferPorts[0].blockSize.setRelease(it.and(0x00FF) or byte.toInt().and(15) or (it == 0).toInt(4))
                    }
                }

                4086L -> blockTransferPorts[1].blockSize.getAcquire().let {
                    blockTransferPorts[1].blockSize.setRelease(it.and(0xFF00) or byte.toInt().and(255))
                }

                4087L -> {
                    blockTransferPorts[1].hasNext.set(byte < 0)
                    blockTransferPorts[1].blockSize.getAcquire().let {
                        blockTransferPorts[1].blockSize.setRelease(it.and(0x00FF) or byte.toInt().and(15) or (it == 0).toInt(4))
                    }
                }

                4088L -> blockTransferPorts[2].blockSize.getAcquire().let {
                    blockTransferPorts[2].blockSize.setRelease(it.and(0xFF00) or byte.toInt().and(255))
                }

                4089L -> {
                    blockTransferPorts[2].hasNext.set(byte < 0)
                    blockTransferPorts[2].blockSize.getAcquire().let {
                        blockTransferPorts[2].blockSize.setRelease(it.and(0x00FF) or byte.toInt().and(15) or (it == 0).toInt(4))
                    }
                }

                4090L -> blockTransferPorts[3].blockSize.getAcquire().let {
                    blockTransferPorts[3].blockSize.setRelease(it.and(0xFF00) or byte.toInt().and(255))
                }

                4091L -> {
                    blockTransferPorts[3].hasNext.set(byte < 0)
                    blockTransferPorts[3].blockSize.getAcquire().let {
                        blockTransferPorts[3].blockSize.setRelease(it.and(0x00FF) or byte.toInt().and(15) or (it == 0).toInt(4))
                    }
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
        catch (_: DanglingPointerException) {}
        catch (_: AddressOverflowException) {}
    }

    override fun dispose() {
        beeper.dispose()
        blockTransferRx.forEach { it.destroy() }
        blockTransferTx.forEach { it.destroy() }
        peripheralFast.destroy()
    }

    private var mouseX: Short = 0
    private var mouseY: Short = 0
    private var mouseButtons: Int = 0  // bit 0 = LEFT, bit 1 = RIGHT, bit 2 = MIDDLE
    // bits 6 (wheel up) and 7 (wheel down) — set by scrolled(), cleared on MMIO[36] read
    private val wheelLatch = AtomicInteger(0)
    private var systemUptime = 0L
    private var rtc = 0L

    fun update(delta: Float) {
        // Only the VM whose IOSpace is wired up as the active InputProcessor (i.e. the
        // currently focused viewport) may observe global keyboard/mouse state. Otherwise
        // hidden VMs would all see the same keypresses as the focused one.
        val isFocused = Gdx.input.inputProcessor === this

        if (rawInputFunctionLatched) {
            rawInputFunctionLatched = false

            keyEventBuffers.fill(0)

            if (isFocused) {
                // store mouse info; unproject through the host-provided viewport so the
                // VM sees logical framebuffer pixels regardless of window magnification,
                // letterboxing or sub-region placement done by an embedding GDX app.
                val vp = inputViewport
                val rawX: Int
                val rawY: Int
                if (vp != null) {
                    tmpMouseVec.set(Gdx.input.x.toFloat(), Gdx.input.y.toFloat())
                    vp.unproject(tmpMouseVec)
                    rawX = tmpMouseVec.x.toInt()
                    rawY = tmpMouseVec.y.toInt()
                }
                else {
                    rawX = Gdx.input.x
                    rawY = Gdx.input.y
                }
                // Subtract the letterbox origin so apps see VM-screen pixel coords (0..drawWidth).
                mouseX = (rawX - inputOriginX).coerceIn(0, inputAreaW - 1).toShort()
                mouseY = (rawY - inputOriginY).coerceIn(0, inputAreaH - 1).toShort()
                mouseButtons = (if (Gdx.input.isButtonPressed(Input.Buttons.LEFT))   1 else 0) or
                               (if (Gdx.input.isButtonPressed(Input.Buttons.RIGHT))  2 else 0) or
                               (if (Gdx.input.isButtonPressed(Input.Buttons.MIDDLE)) 4 else 0)

                // strobe keys to fill the key read buffer
                var keysPushed = 0
                for (k in 1..254) {
                    if (Gdx.input.isKeyPressed(k)) {
                        keyEventBuffers[keysPushed] = k.toByte()
                        keysPushed += 1
                    }

                    if (keysPushed >= 8) break
                }
            }
            else {
                mouseButtons = 0
            }
        }

        if (uptimeCounterLatched) {
            uptimeCounterLatched = false
            systemUptime = vm.getUptime()
        }

        if (RTClatched) {
            RTClatched = false
            rtc = vm.worldInterface.currentTimeInMills()
        }

        if (isFocused) {
            // SIGTERM key combination: Ctrl+Shift+T+R
            vm.stopDown = (Gdx.input.isKeyPressed(Input.Keys.SHIFT_LEFT) &&
                    Gdx.input.isKeyPressed(Input.Keys.CONTROL_LEFT) &&
                    Gdx.input.isKeyPressed(Input.Keys.T) &&
                    Gdx.input.isKeyPressed(Input.Keys.R)) || Gdx.input.isKeyPressed(Input.Keys.PAUSE)
            if (vm.stopDown) println("[VM-${vm.id}] SIGTERM requested")

            // RESET key combination: Ctrl+Shift+R+S
            vm.resetDown = Gdx.input.isKeyPressed(Input.Keys.SHIFT_LEFT) &&
                    Gdx.input.isKeyPressed(Input.Keys.CONTROL_LEFT) &&
                    Gdx.input.isKeyPressed(Input.Keys.R) &&
                    Gdx.input.isKeyPressed(Input.Keys.S)
            if (vm.resetDown) println("[VM-${vm.id}] RESET requested")

            // SYSRQ key combination: Ctrl+Shift+S+Q
            vm.sysrqDown = (Gdx.input.isKeyPressed(Input.Keys.SHIFT_LEFT) &&
                    Gdx.input.isKeyPressed(Input.Keys.CONTROL_LEFT) &&
                    Gdx.input.isKeyPressed(Input.Keys.Q) &&
                    Gdx.input.isKeyPressed(Input.Keys.S)) || Gdx.input.isKeyPressed(Input.Keys.PRINT_SCREEN)
            if (vm.sysrqDown) println("[VM-${vm.id}] SYSRQ requested")
        }
        else {
            vm.stopDown = false
            vm.resetDown = false
            vm.sysrqDown = false
        }
    }

    override fun touchUp(p0: Int, p1: Int, p2: Int, p3: Int): Boolean {
        return false
    }

    override fun mouseMoved(p0: Int, p1: Int): Boolean {
        return false
    }

    override fun keyTyped(p0: Char): Boolean {
        if (keyboardInputRequested && p0.toInt() > 0) {
            //println("[IO] key typed = ${p0.toInt()}")
            keyboardBuffer.appendHead(p0.toByte())
            keyPushed = true  // Set after append; cleared when buffer is emptied via mmio_read(37)
            return true
        }
        else {
            return false
        }
    }

    override fun scrolled(amountX: Float, amountY: Float): Boolean {
        // LibGDX: amountY > 0 = scroll DOWN (toward user), amountY < 0 = scroll UP.
        // Latch bits 6/7 of MMIO[36]; the latch is cleared the next time MMIO[36] is read.
        if (Gdx.input.inputProcessor !== this) return false
        when {
            amountY < 0f -> wheelLatch.updateAndGet { it or 0x40 }
            amountY > 0f -> wheelLatch.updateAndGet { it or 0x80 }
        }
        return true
    }

    override fun keyUp(p0: Int): Boolean {
        //ttySpecialKeyLatched = false
        return true
    }

    override fun touchDragged(p0: Int, p1: Int, p2: Int): Boolean {
        return false
    }

    private var keyboardInputRequested = false
    private var uptimeCounterLatched = false
    private var RTClatched = false
    private var rawInputFunctionLatched = false
    private var specialKeys = hashMapOf(
        Input.Keys.HOME to 199.toByte(),
        Input.Keys.UP to 200.toByte(),
        Input.Keys.PAGE_UP to 201.toByte(),
        Input.Keys.LEFT to 203.toByte(),
        Input.Keys.RIGHT to 205.toByte(),
        Input.Keys.END to 207.toByte(),
        Input.Keys.DOWN to 208.toByte(),
        Input.Keys.PAGE_DOWN to 209.toByte(),
        Input.Keys.INSERT to 210.toByte(),
        Input.Keys.FORWARD_DEL to 211.toByte()
    )
    override fun keyDown(p0: Int): Boolean {
        if (keyboardInputRequested) {
            if (p0 in Input.Keys.A..Input.Keys.Z && (Gdx.input.isKeyPressed(Input.Keys.CONTROL_LEFT) || Gdx.input.isKeyPressed(Input.Keys.CONTROL_RIGHT))) {
                keyboardBuffer.appendHead((p0 - 28).toByte())
                keyPushed = true
            }
            else {
                specialKeys[p0]?.let {
                    //println("[IO] key special = ${it.toUInt()}")
                    keyboardBuffer.appendHead(it)
                    keyPushed = true
                }
            }
            return true
        }
        else {
            return false
        }
    }

    override fun touchDown(p0: Int, p1: Int, p2: Int, p3: Int): Boolean {
        return false
    }

    override fun touchCancelled(screenX: Int, screenY: Int, pointer: Int, button: Int): Boolean {
        return false
    }
}

/**
 * Built-in beeper / PSG speaker (terranmon.txt §93..99).
 *
 * A single square-wave tone generator modelled on the SN76489: a 14-bit frequency
 * divider over a 3579545/16 Hz master clock, with optional 60 Hz arpeggio
 * note-effects (two-, three- or four-note). The six command bytes (MMIO 94..99)
 * are write staging; reading MMIO 93 latches them into the live tone ("upload
 * beeper command").
 *
 * The OpenAL device and its render thread are created lazily on the first non-silent
 * upload, so a headless VM (no LibGDX OpenAL backend) simply stays silent.
 */
private class Beeper {

    companion object {
        private const val SAMPLE_RATE = 48000
        // SN76489 NTSC colourburst clock (3579545 Hz) after the chip's internal /16
        // prescaler. The square wave toggles every `divider` master ticks, so one full
        // period spans 2*divider ticks  ->  f = MASTER_CLOCK / (2 * divider).
        // (divider 254 -> 440.4 Hz, matching real SN76489 hardware.)
        private const val MASTER_CLOCK = 3579545.4545454545 / 16.0
        // Arpeggio note-effects step at 60 Hz: 48000 / 60 = 800 samples per step.
        private const val SAMPLES_PER_ARP_TICK = SAMPLE_RATE / 60
        private const val CHUNK = 512
        private const val AMPLITUDE = 8192  // ~ -12 dBFS; square waves are loud
    }

    // MMIO 94..99 write-staging registers:
    //   PPPPPPPP / pppppp_QQ / qqAABBCC / aaaaaaaa / bbbbbbbb / cccccccc
    // where AA/BB/CC are the high two bits of the 10-bit arpeggio deltas A/B/C.
    private val cmd = ByteArray(6)

    // Latched ("uploaded") live command, read by the render thread.
    @Volatile private var divider = 0   // 14-bit frequency divider; 0 = no sound
    @Volatile private var effect = 0    // QQ note-effect: 0 none, 1 four-note, 2 two-note, 3 three-note
    @Volatile private var argA = 0      // A (10-bit divisor delta)
    @Volatile private var argB = 0      // B (10-bit divisor delta)
    @Volatile private var argC = 0      // C (10-bit divisor delta)

    @Volatile private var running = false
    private var renderThread: Thread? = null
    private var audioDevice: OpenALBufferedAudioDevice? = null

    fun writeCommand(index: Int, byte: Byte) { cmd[index] = byte }
    fun readCommand(index: Int): Byte = cmd[index]

    /**
     * Latch MMIO 94..99 into the live tone and (lazily) start playback. Returns the
     * beeper status byte (bit 0 set while a tone is sounding). Invoked by a read of MMIO 93.
     */
    fun upload(): Byte {
        val hi  = cmd[0].toInt() and 255         // PPPPPPPP
        val lo  = cmd[1].toInt() and 255         // pppppp_QQ
        val ext = cmd[2].toInt() and 255         // qqAABBCC: high two bits of A/B/C
        divider = (hi shl 6) or (lo ushr 2)      // 14-bit frequency divider
        effect  = lo and 0b11                    // QQ
        argA    = (((ext ushr 4) and 0b11) shl 8) or (cmd[3].toInt() and 255)   // 10-bit A
        argB    = (((ext ushr 2) and 0b11) shl 8) or (cmd[4].toInt() and 255)   // 10-bit B
        argC    = (((ext       ) and 0b11) shl 8) or (cmd[5].toInt() and 255)   // 10-bit C
        if (divider != 0) ensureStarted()
        return (if (divider != 0) 1 else 0).toByte()
    }

    @Synchronized private fun ensureStarted() {
        if (running) return
        val audio = try { Gdx.audio } catch (e: Throwable) { null }
        if (audio !is OpenALLwjgl3Audio) return  // headless / no audio backend: stay silent
        val bufSize = reflectIntField(audio, "deviceBufferSize", 1024)
        val bufCount = reflectIntField(audio, "deviceBufferCount", 9)
        try {
            audioDevice = OpenALBufferedAudioDevice(audio, SAMPLE_RATE, true, bufSize, bufCount) {}
        }
        catch (e: Throwable) {
            System.err.println("[Beeper] could not open audio device: $e")
            return
        }
        running = true
        renderThread = Thread({ renderLoop() }, "BeeperRender").also {
            it.isDaemon = true
            it.uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { _, t -> t.printStackTrace() }
            it.start()
        }
    }

    private fun reflectIntField(target: Any, name: String, fallback: Int): Int = try {
        target.javaClass.getDeclaredField(name).let { it.isAccessible = true; it.getInt(target) }
    }
    catch (e: Throwable) { fallback }

    /**
     * Resolve the divisor for the current arpeggio step. A non-positive divisor (the
     * subtraction effects can overshoot when A/B exceed P) is treated as silence.
     */
    private fun divisorForTick(arpTick: Long): Int = when (effect) {
        // 10: two-note arpeggio — base / (P - A).
        2 -> if (arpTick and 1L == 0L) divider else divider - argA
        // 11: three-note arpeggio — base / (P - A) / (P - A - B).
        3 -> when ((arpTick % 3L).toInt()) { 0 -> divider; 1 -> divider - argA; else -> divider - argA - argB }
        // 01: four-note arpeggio — base / (P - A) / (P - A - B) / (P - A - B - C).
        1 -> when ((arpTick % 4L).toInt()) {
            0 -> divider; 1 -> divider - argA; 2 -> divider - argA - argB; else -> divider - argA - argB - argC
        }
        // 00: no effect.
        else -> divider
    }

    private fun renderLoop() {
        val buf = ShortArray(CHUNK)
        val hiSample = (AMPLITUDE-1).toShort()
        val loSample = (-AMPLITUDE).toShort()
        var phase = 0.0
        var arpSample = 0
        var arpTick = 0L
        while (running) {
            try {
                for (i in 0 until CHUNK) {
                    val div = divisorForTick(arpTick)
                    if (div <= 0) {
                        buf[i] = 0
                    }
                    else {
                        phase += (MASTER_CLOCK / (2.0 * div)) / SAMPLE_RATE
                        if (phase >= 1.0) phase -= floor(phase)
                        buf[i] = if (phase < 0.5) hiSample else loSample
                    }
                    if (++arpSample >= SAMPLES_PER_ARP_TICK) { arpSample = 0; arpTick++ }
                }
                // writeSamples blocks until a device buffer frees, pacing the loop in real time.
                audioDevice?.writeSamples(buf, 0, CHUNK)

                if (divider == 0) {
                    // Silent: stop feeding so the OpenAL source drains to quiet, then idle.
                    phase = 0.0; arpSample = 0; arpTick = 0L
                    Thread.sleep(4)
                    continue
                }
            }
            catch (e: InterruptedException) { break }
            catch (e: Throwable) {
                System.err.println("[Beeper] render error: $e")
                try { Thread.sleep(4) } catch (_: InterruptedException) { break }
            }
        }
    }

    fun dispose() {
        running = false
        renderThread?.let { it.interrupt(); try { it.join(200) } catch (_: InterruptedException) {} }
        renderThread = null
        try { audioDevice?.stop() } catch (_: Throwable) {}
        try { audioDevice?.dispose() } catch (_: Throwable) {}
        audioDevice = null
    }
}
