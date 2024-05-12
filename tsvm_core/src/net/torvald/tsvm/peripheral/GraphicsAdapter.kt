package net.torvald.tsvm.peripheral

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.graphics.*
import com.badlogic.gdx.graphics.g2d.Gdx2DPixmap
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.graphics.g2d.TextureRegion
import com.badlogic.gdx.graphics.glutils.FrameBuffer
import com.badlogic.gdx.math.Matrix4
import com.badlogic.gdx.utils.Disposable
import com.badlogic.gdx.utils.GdxRuntimeException
import net.torvald.UnsafeHelper
import net.torvald.UnsafePtr
import net.torvald.terrarum.DefaultGL32Shaders
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.*
import net.torvald.tsvm.FBM
import net.torvald.tsvm.LoadShader
import net.torvald.tsvm.kB
import net.torvald.tsvm.peripheral.GraphicsAdapter.Companion.DRAW_SHADER_FRAG
import java.io.InputStream
import java.io.OutputStream
import java.lang.IllegalArgumentException
import kotlin.experimental.and

data class AdapterConfig(
    val theme: String,
    val width: Int,
    val height: Int,
    val textCols: Int,
    val textRows: Int,
    val ttyDefaultFore: Int,
    val ttyDefaultBack: Int,
    val vramSize: Long,
    val chrRomPath: String,
    val decay: Float,
    val fragShader: String,
    val paletteShader: String = DRAW_SHADER_FRAG,
    val drawScale: Float = 1f,
    val scaleFiltered: Boolean = false,
    val baudRate: Double = 57600.0,
    val bitsPerChar: Int = 10 // start bit + 8 data bits + stop bit
)

data class SuperGraphicsAddonConfig(
    val bankCount: Int = 1
)

class ReferenceGraphicsAdapter(assetsRoot: String, vm: VM) : GraphicsAdapter(assetsRoot, vm, GraphicsAdapter.DEFAULT_CONFIG_COLOR_CRT)
class ReferenceGraphicsAdapter2(assetsRoot: String, vm: VM) : GraphicsAdapter(assetsRoot, vm, GraphicsAdapter.DEFAULT_CONFIG_COLOR_CRT, SuperGraphicsAddonConfig(2))
class ReferenceLikeLCD(assetsRoot: String, vm: VM) : GraphicsAdapter(assetsRoot, vm, GraphicsAdapter.DEFAULT_CONFIG_PMLCD)

/**
 * NOTE: if TTY size is greater than 80*32, SEGFAULT will occur because text buffer is fixed in size
 */
open class GraphicsAdapter(private val assetsRoot: String, val vm: VM, val config: AdapterConfig, val sgr: SuperGraphicsAddonConfig = SuperGraphicsAddonConfig()) :
    GlassTty(config.textRows, config.textCols) {

    override val typestring = VM.PERITYPE_GPU_AND_TERM

    override fun getVM(): VM {
        return vm
    }

    val WIDTH = config.width
    val HEIGHT = config.height
    val VRAM_SIZE = config.vramSize
    protected val TTY_FORE_DEFAULT = config.ttyDefaultFore
    protected val TTY_BACK_DEFAULT = config.ttyDefaultBack
    protected val theme = config.theme
    protected val TAB_SIZE = 8

    internal val framebuffer = UnsafeHelper.allocate(WIDTH.toLong() * HEIGHT, this)//Pixmap(WIDTH, HEIGHT, Pixmap.Format.Alpha)
    internal val framebuffer2 = if (sgr.bankCount >= 2) UnsafeHelper.allocate(WIDTH.toLong() * HEIGHT, this) else null
    internal val framebufferOut = Pixmap(WIDTH, HEIGHT, Pixmap.Format.RGBA8888)
    protected var rendertex = Texture(1, 1, Pixmap.Format.RGBA8888)
    internal val paletteOfFloats = FloatArray(1024) {
        val rgba = DEFAULT_PALETTE[it / 4]
        val channel = it % 4
        rgba.shr((3 - channel) * 8).and(255) / 255f
    }
    protected fun getOriginalChrrom(): Pixmap {
        fun getFileHandle(): FileHandle =
            if (config.chrRomPath.isEmpty())
                Gdx.files.classpath("net/torvald/tsvm/rom/FontROM7x14.png")
            else
                Gdx.files.internal("$assetsRoot/"+config.chrRomPath)

        return Pixmap(Gdx2DPixmap(getFileHandle().read(), Gdx2DPixmap.GDX2D_FORMAT_RGBA8888))
    }
    protected lateinit var chrrom: Pixmap
    protected var chrrom0 = Texture(1,1,Pixmap.Format.RGBA8888)
    protected val faketex: Texture

    internal val textArea = UnsafeHelper.allocate(7682, this)
    internal val unusedArea = UnsafeHelper.allocate(1024, this)
    internal val scanlineOffsets = UnsafeHelper.allocate(1024, this)

    protected val paletteShader = LoadShader(DRAW_SHADER_VERT, config.paletteShader)
    protected val textShader = LoadShader(DRAW_SHADER_VERT, config.fragShader)

    override var blinkCursor = true
    override var ttyRawMode = false
    private var graphicsUseSprites = false
    private var lastUsedColour = (-1).toByte()
    private var currentChrRom = 0
    private var chrWidth = 7f
    private var chrHeight = 14f
    var framebufferScrollX = 0
    var framebufferScrollY = 0
    private var fontRomMappingMode = 0 // 0: low, 1: high
    internal var mappedFontRom = UnsafeHelper.allocate(2048, this)

    override var ttyFore: Int = TTY_FORE_DEFAULT // cannot be Byte
    override var ttyBack: Int = TTY_BACK_DEFAULT // cannot be Byte

    private val textForePixmap = Pixmap(TEXT_COLS, TEXT_ROWS, Pixmap.Format.RGBA8888)
    private val textBackPixmap = Pixmap(TEXT_COLS, TEXT_ROWS, Pixmap.Format.RGBA8888)
    private val textPixmap = Pixmap(TEXT_COLS, TEXT_ROWS, Pixmap.Format.RGBA8888)

    private var textForeTex = Texture(textForePixmap)
    private var textBackTex = Texture(textBackPixmap)
    private var textTex = Texture(textPixmap)

    private val outFBOs = Array(2) { FrameBuffer(Pixmap.Format.RGBA8888, WIDTH, HEIGHT, false) }
    private val outFBOregion = Array(2) { TextureRegion(outFBOs[it].colorBufferTexture) }
    private val outFBObatch = SpriteBatch(1000, DefaultGL32Shaders.createSpriteBatchShader())

    private var graphicsMode = 0
    private var layerArrangement = 0


    private val memTextCursorPosOffset = 0L
    private val memTextForeOffset = 2L
    private val memTextBackOffset = 2L + 2560
    private val memTextOffset = 2L + 2560 + 2560
    private val TEXT_AREA_SIZE = TEXT_COLS * TEXT_ROWS

//    override var halfrowMode = false

    internal val instArea = UnsafeHelper.allocate(65536L, this)

    override var rawCursorPos: Int
        get() = textArea.getShortFree(memTextCursorPosOffset).toInt()
        set(value) { textArea.setShortFree(memTextCursorPosOffset, value.toShort()) }

    override fun getCursorPos() = rawCursorPos % TEXT_COLS to rawCursorPos / TEXT_COLS

    override fun setCursorPos(x: Int, y: Int) {
        var newx = x
        var newy = y

        if (newx >= TEXT_COLS) {
            newx = 0
            newy += 1 //+ halfrowMode.toInt()
        }
        else if (newx < 0) {
            newx = 0
        }

        if (newy < 0) {
            newy = 0 // DON'T SCROLL when cursor goes ABOVE the screen
        }
        else if (newy >= TEXT_ROWS) {
            scrollUp(newy - TEXT_ROWS + 1)
            setCursorPos(newy, TEXT_ROWS - 1)
            newy = TEXT_ROWS - 1
        }

        rawCursorPos = toTtyTextOffset(newx, newy)
    }
    private fun toTtyTextOffset(x: Int, y: Int) = y * TEXT_COLS + x

    init {
        // no orthographic camera, must be "raw" Matrix4
        val m = Matrix4()
        m.setToOrtho2D(0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat())
        outFBObatch.projectionMatrix = m


        framebufferOut.blending = Pixmap.Blending.None
        textForePixmap.blending = Pixmap.Blending.None
        textBackPixmap.blending = Pixmap.Blending.None
        framebuffer.fillWith(-1) // FF for palette mode, RGBA(15, 15, x, x) for direct colour
        framebuffer2?.fillWith(-16) // RGBA(x, x, 15, 0) for direct colour

        unusedArea.fillWith(0)
        scanlineOffsets.fillWith(0)

        val pm = Pixmap(1, 1, Pixmap.Format.RGBA8888)
        pm.drawPixel(0, 0, -1)
        faketex = Texture(pm)
        pm.dispose()


        // initialise with NONZERO value; value zero corresponds to opaque black, and it will paint the whole screen black
        // when in text mode, and that's undesired behaviour
        // -1 is preferred because it points to the colour CLEAR, and it's constant.
        textArea.fillWith(-1)
        // fill text area with 0
        for (k in 0 until TEXT_ROWS * TEXT_COLS) {
            textArea[k + memTextOffset] = 0
        }

        if (theme.contains("color")) {
            unusedArea[0] = 32
            unusedArea[1] = 48
            unusedArea[2] = 64
        }

        setCursorPos(0, 0)


        // fill in chrrom
        chrrom = Pixmap(16 * (config.width / config.textCols), 16 * (config.height / config.textRows), Pixmap.Format.RGBA8888)
        //chrrom = getOriginalChrrom()

        resetFontRom(0)
        resetFontRom(1)


    }

    override fun peek(addr: Long): Byte? {
        val adi = addr.toInt()
        if (framebuffer2 != null && addr >= 262144) {
            return when (addr - 262144) {
                in 0 until 250880 -> framebuffer2[addr - 262144]
                else -> null
            }
        }
        return when (addr) {
            in 0 until 250880 -> framebuffer[addr]
            in 250880 until 250880+1024 -> unusedArea[addr - 250880]
            in 253950 until 261632 -> textArea[addr - 253950]
            in 261632 until 262144 -> peekPalette(adi - 261632)
            in 0 until VM.HW_RESERVE_SIZE -> {
//                println("[GraphicsAdapter] mirroring with input address $addr")
                peek(addr % VRAM_SIZE)
            } // HW mirroring
            else -> null
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toInt().and(255)
        if (framebuffer2 != null) {
            when (addr - 262144) {
                in 0 until 250880 -> {
                    lastUsedColour = byte
                    framebuffer2[addr - 262144] = byte
                    return
                }
            }
        }
        when (addr) {
            in 0 until 250880 -> {
                lastUsedColour = byte
                framebuffer[addr] = byte
            }
            250883L -> {
                unusedArea[addr - 250880] = byte
                runCommand(byte)
            }
            in 250880 until 250880+1024 -> unusedArea[addr - 250880] = byte
            in 253950 until 261632 -> textArea[addr - 253950] = byte
            in 261632 until 262144 -> pokePalette(adi - 261632, byte)
            in 0 until VM.HW_RESERVE_SIZE -> {
//                println("[GraphicsAdapter] mirroring with input address $addr")
                poke(addr % VRAM_SIZE, byte)
            } // HW mirroring
        }
    }

    private fun getTextmodeAttirbutes(): Byte = (currentChrRom.and(15).shl(4) or
            ttyRawMode.toInt(1) or
            blinkCursor.toInt()).toByte()

    private fun getGraphicsAttributes(): Byte = graphicsUseSprites.toInt().toByte()

    private fun setTextmodeAttributes(rawbyte: Byte) {
        currentChrRom = rawbyte.toInt().and(0b11110000).ushr(4)
        blinkCursor = rawbyte.and(0b0001) != 0.toByte()
        ttyRawMode =  rawbyte.and(0b0010) != 0.toByte()
    }

    private fun setGraphicsAttributes(rawbyte: Byte) {
        graphicsUseSprites = rawbyte.and(1) == 1.toByte()
    }

    override fun mmio_read(addr: Long): Byte? {
        return when (addr) {
            0L -> (WIDTH % 256).toByte()
            1L -> (WIDTH / 256).toByte()
            2L -> (HEIGHT % 256).toByte()
            3L -> (HEIGHT / 256).toByte()
            4L -> TEXT_COLS.toByte()
            5L -> TEXT_ROWS.toByte()
            6L -> getTextmodeAttirbutes()
            7L -> getGraphicsAttributes()
            8L -> lastUsedColour
            9L -> ttyFore.toByte()
            10L -> ttyBack.toByte()
            11L -> sgr.bankCount.toByte()
            12L -> graphicsMode.toByte()
            13L -> layerArrangement.toByte()
            14L -> framebufferScrollX.toByte()
            15L -> framebufferScrollX.ushr(8).toByte()
            16L -> framebufferScrollY.toByte()
            17L -> framebufferScrollY.ushr(8).toByte()

            18L -> (drawCallBusy.toInt() or codecBusy.toInt(1)).toByte()
            19L -> -1
            20L -> drawCallProgramCounter.and(255).toByte()
            21L -> drawCallProgramCounter.ushr(8).and(255).toByte()


            in 1024L..2047L -> scanlineOffsets[addr - 1024]
            in 2048L..4095L -> mappedFontRom[addr - 2048]

            in 65536L..131071L -> instArea[addr - 65536]

            in 0 until VM.MMIO_SIZE -> -1
            else -> null
        }
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        val bi = byte.toUint()
        when (addr) {
            6L -> setTextmodeAttributes(byte)
            7L -> setGraphicsAttributes(byte)
            9L -> { ttyFore = bi }
            10L -> { ttyBack = bi }
            12L -> { if (bi >= 3 && sgr.bankCount == 1) graphicsMode = 0 else graphicsMode = bi }
            13L -> { layerArrangement = bi }
            14L -> { framebufferScrollX = framebufferScrollX.and(0xFFFFFF00.toInt()).or(bi) }
            15L -> { framebufferScrollX = framebufferScrollX.and(0xFFFF00FF.toInt()).or(bi shl 8) }
            16L -> { framebufferScrollY = framebufferScrollY.and(0xFFFFFF00.toInt()).or(bi) }
            17L -> { framebufferScrollY = framebufferScrollY.and(0xFFFF00FF.toInt()).or(bi shl 8) }

            19L -> { if (bi != 0) compileAndRunDrawCalls() }

            in 1024L..2047L -> { scanlineOffsets[addr - 1024] = byte }
            in 2048L..4095L ->  { mappedFontRom[addr - 2048] = byte }

            in 65536L..131071L -> instArea[addr - 65536] = byte

            else -> null
        }
    }

    private fun runCommand(opcode: Byte) {
        val arg1 = unusedArea[4].toInt().and(255)
        val arg2 = unusedArea[5].toInt().and(255)

        when (opcode.toInt()) {
            1 -> {
                for (it in 0 until 1024) {
                    val rgba = DEFAULT_PALETTE[it / 4]
                    val channel = it % 4
                    rgba.shr((3 - channel) * 8).and(255) / 255f
                }
            }
            2 -> {
                framebuffer.fillWith(arg1.toByte())
            }
            4 -> {
                framebuffer2?.fillWith(arg1.toByte())
            }
            3 -> {
                for (it in 0 until 1024) {
                    val rgba = DEFAULT_PALETTE[it / 4]
                    val channel = it % 4
                    rgba.shr((3 - channel) * 8).and(255) / 255f
                }
                framebuffer.fillWith(arg1.toByte())
                framebuffer2?.fillWith(arg2.toByte())
            }
            16, 17 -> readFontRom(opcode - 16)
            18, 19 -> writeFontRom(opcode - 18)
            20, 21 -> resetFontRom(opcode - 20)
        }
    }

    @Volatile private var codecBusy = false

    private var drawCallSize = 0
    private val drawCallBuffer = Array<DrawCall>(3640) { DrawCallEnd }
    @Volatile private var drawCallBusy = false
    internal var drawCallProgramCounter = 0
    internal var rScanline = 0

    private fun compileAndRunDrawCalls() {
        if (!drawCallBusy) {
            drawCallBusy = true
            compileWords()
            // TODO on separate thread?
            for (i in 0 until drawCallSize)
                drawCallBuffer[i].execute(this)
            drawCallBusy = false
        }
    }

        
    private fun compileWords() {
        drawCallSize = 0
        while (true) {
            val bytes = (0..17).map { instArea.get(18L*drawCallSize + it) }.toByteArray()

            println("Word #${drawCallSize+1}: ${bytes.joinToString(", ") { it.toUint().toString(16).padStart(2, '0') }}")

            val instruction = compileWord(bytes)

            println("Inst #${drawCallSize+1}: $instruction\n")

            drawCallBuffer[drawCallSize] = instruction
            drawCallSize += 1

            // check if the instruction contains END
            if (instruction is DrawCallCompound && (instruction.call1 is DrawCallEnd || instruction.call2 is DrawCallEnd || instruction.call3 is DrawCallEnd)) {
                break
            }
        }
    }

    private fun compileWord(bytes: ByteArray): DrawCall {

        val head = bytes[0]

        when (head) {
            in 0..127 -> {
                // D-type
                when (head) {
                    0x01.toByte() -> {
                        return JumpIfScanline(
                            bytes[1].toUint(),
                            toBigInt(bytes[2], bytes[3]),
                            toBigInt(bytes[4], bytes[5]),
                            toBigInt(bytes[6], bytes[7]),
                            toBigInt(bytes[8], bytes[9])
                        )
                    }
                    in 0x10..0x17 -> {
                        return DrawCallDrawLines(
                            (head and 0xF).toInt() + 1,
                            bytes[1].toUint(), 1,
                            intArrayOf(
                                bytes[2].toUint().shl(2) or bytes[3].toUint().and(192).ushr(6),
                                bytes[4].toUint().shl(2) or bytes[5].toUint().and(192).ushr(6),
                                bytes[6].toUint().shl(2) or bytes[7].toUint().and(192).ushr(6),
                                bytes[8].toUint().shl(2) or bytes[9].toUint().and(192).ushr(6),
                                bytes[10].toUint().shl(2) or bytes[11].toUint().and(192).ushr(6),
                                bytes[12].toUint().shl(2) or bytes[13].toUint().and(192).ushr(6),
                                bytes[14].toUint().shl(2) or bytes[15].toUint().and(192).ushr(6),
                                bytes[16].toUint().shl(2) or bytes[17].toUint().and(192).ushr(6)
                            ),
                            intArrayOf(
                                bytes[3].toUint().and(63).unzero(64),
                                bytes[5].toUint().and(63).unzero(64),
                                bytes[7].toUint().and(63).unzero(64),
                                bytes[9].toUint().and(63).unzero(64),
                                bytes[11].toUint().and(63).unzero(64),
                                bytes[13].toUint().and(63).unzero(64),
                                bytes[15].toUint().and(63).unzero(64),
                                bytes[17].toUint().and(63).unzero(64)
                            )
                        )
                    }
                    in 0x18..0x1F -> {
                        return DrawCallDrawLines(
                            (head and 0xF).toInt() - 7,
                            bytes[1].toUint(), 2,
                            intArrayOf(
                                bytes[2].toUint().shl(2) or bytes[3].toUint().and(192).ushr(6),
                                bytes[4].toUint().shl(2) or bytes[5].toUint().and(192).ushr(6),
                                bytes[6].toUint().shl(2) or bytes[7].toUint().and(192).ushr(6),
                                bytes[8].toUint().shl(2) or bytes[9].toUint().and(192).ushr(6),
                                bytes[10].toUint().shl(2) or bytes[11].toUint().and(192).ushr(6),
                                bytes[12].toUint().shl(2) or bytes[13].toUint().and(192).ushr(6),
                                bytes[14].toUint().shl(2) or bytes[15].toUint().and(192).ushr(6),
                                bytes[16].toUint().shl(2) or bytes[17].toUint().and(192).ushr(6)
                            ),
                            intArrayOf(
                                bytes[3].toUint().and(63).unzero(64),
                                bytes[5].toUint().and(63).unzero(64),
                                bytes[7].toUint().and(63).unzero(64),
                                bytes[9].toUint().and(63).unzero(64),
                                bytes[11].toUint().and(63).unzero(64),
                                bytes[13].toUint().and(63).unzero(64),
                                bytes[15].toUint().and(63).unzero(64),
                                bytes[17].toUint().and(63).unzero(64)
                            )
                        )
                    }
                    in 0x20..0x5F -> {
                        return DrawCallDrawMultiLines(
                            (head.toUint() ushr 2) and 7,
                            head.toUint().and(3).shl(8) or bytes[1].toUint(), if (head >= 0x40) 2 else 1,
                            intArrayOf(
                                bytes[2].toUint(), bytes[4].toUint(), bytes[6].toUint(), bytes[8].toUint(),
                                bytes[10].toUint(), bytes[12].toUint(), bytes[14].toUint(), bytes[16].toUint()
                            ),
                            intArrayOf(
                                bytes[3].toUint().unzero(256), bytes[5].toUint().unzero(256),
                                bytes[7].toUint().unzero(256), bytes[9].toUint().unzero(256),
                                bytes[11].toUint().unzero(256), bytes[13].toUint().unzero(256),
                                bytes[15].toUint().unzero(256), bytes[17].toUint().unzero(256)
                            )
                        )
                    }
                    else -> throw UnsupportedOperationException("Unknown Head byte 0x${head.toString(16).padStart(2,'0').toUpperCase()}")
                }
            }
            in -16..-1 -> {
                // C-type
                val call1 = bytesToControlCalls(bytes.sliceArray(0..5))
                val call2 = bytesToControlCalls(bytes.sliceArray(6..11))
                val call3 = bytesToControlCalls(bytes.sliceArray(12..17))
                return DrawCallCompound(call1, call2, call3)
            }
            else -> {
                // T-type
                when (head) {
                    in 0xA0..0xA1 -> {
                        return DrawCallCopyPixels(
                            (head and 2) == 1.toByte(),
                            bytes[1].toUint().unzero(256), bytes[2].toUint().unzero(256),
                            bytes[3].toUint(),
                            toBigInt(bytes[4], bytes[5]),
                            toBigInt(bytes[6], bytes[7], bytes[8]),
                            toBigInt(bytes[9], bytes[10], bytes[11]),
                            toBigInt(bytes[12], bytes[13], bytes[14]),
                            toBigInt(bytes[15], bytes[16], bytes[17])
                        )
                    }
                    else -> throw UnsupportedOperationException("Unknown Head byte 0x${head.toString(16).padStart(2,'0').toUpperCase()}")
                }
            }
        }
    }

    private fun bytesToControlCalls(bytes: ByteArray): DrawCall {
        return when (toBigInt(bytes[0], bytes[1])) {
            0xF00F -> DrawCallEnd
            0xF100 -> GotoScanline(toBigInt(bytes[2], bytes[3]))
            0xF101 -> ChangeGraphicsMode(toBigInt(bytes[2], bytes[3]))
            0xFFFF -> DrawCallNop
            else -> throw UnsupportedOperationException("Unknown Opcode 0x${toBigInt(bytes[0], bytes[1]).toString(16).padStart(4, '0').toUpperCase()}")
        }
    }

    private fun Int.unzero(n: Int) = if (this == 0) n else this
    private fun toBigInt(byte1: Byte, byte2: Byte, byte3: Byte? = null): Int {
        if (byte3 != null)
            return byte1.toUint().shl(16) or byte2.toUint().shl(8) or byte3.toUint()
        else
            return byte1.toUint().shl(8) or byte2.toUint()
    }

    open fun blockCopy(width: Int, height: Int, x: Int, y: Int, baseAddr: Int, stride: Int) {
        var line = y
        var srcPtr = vm.usermem.ptr + baseAddr
        while (line < y + height) {
            val destPtr = framebuffer.ptr + line * WIDTH + x

            UnsafeHelper.memcpy(srcPtr, destPtr, width.toLong())

            srcPtr += stride
            line += 1
        }
    }

    open fun blockCopyTransparency(width: Int, height: Int, x: Int, y: Int, transparencyKey: Byte, baseAddr: Int, stride: Int) {
        var line = y
        var srcPtr = baseAddr * 1L
        while (line < y + height) {
            val destPtr = line * WIDTH + x * 1L

//            UnsafeHelper.memcpy(srcPtr, destPtr, width.toLong())
            for (col in x until x + width) {
                val pixel = vm.usermem[srcPtr + col]
                if (pixel != transparencyKey) {
                    framebuffer[destPtr + col] = pixel
                }
            }

            srcPtr += stride
            line += 1
        }
    }

    /**
     * @param mode 0-Low, 1-High
     */
    open fun readFontRom(mode: Int) {
        // max char size: 8*15
        fontRomMappingMode = mode
        val cw = WIDTH / config.textCols
        val ch = HEIGHT / config.textRows
        if (cw > 8 || ch > 15) throw UnsupportedOperationException()

        val pixmap = chrrom
        val scanline = ByteArray(cw)
        val dataOffset = mode * chrrom0.width * chrrom0.height / 2

        for (char in 0 until 128) {
            val px = (char % 16) * cw; val py = (char / 16) * ch
            val off = dataOffset + (py * 16 * cw) + px
            for (line in 0 until ch) {
                pixmap.pixels.position(off + (line * 16 * cw))
                pixmap.pixels.get(scanline)
                pixmap.pixels.position(0) // rewinding to avoid graphical glitch
                var word = 0
                for (bm in 0 until scanline.size) {
                    val pixel = (scanline[bm] < 0).toInt()
                    word = word or (pixel shl (scanline.size - 1 - bm))
                }
                mappedFontRom[char.toLong() * ch + line] = word.toByte()
            }
        }

//        try { pixmap.dispose() } catch (e: GdxRuntimeException) {}
    }

    /**
     * @param mode 0-Low, 1-High
     */
    open fun writeFontRom(mode: Int) {
        // max char size: 8*15
        fontRomMappingMode = mode
        val cw = WIDTH / config.textCols
        val ch = HEIGHT / config.textRows

        if (cw > 8 || ch > 15) throw UnsupportedOperationException()

        val pixmap = chrrom
        val scanline = ByteArray(4 * cw)
        val dataOffset = mode * 4 * chrrom0.width * chrrom0.height / 2

        for (char in 0 until 128) {
            val px = (char % 16) * cw; val py = (char / 16) * ch
            val off = dataOffset + 4 * ((py * 16 * cw) + px)
            for (line in 0 until ch) {
                val word = mappedFontRom[char.toLong() * ch + line].toInt()
                for (bm in scanline.indices step 4) {
                    val pixel = 255 * ((word shr (cw - 1 - bm)) and 1)
                    val matte = (if (pixel == 0) 0 else 255).toByte()
                    scanline[bm+0] = matte
                    scanline[bm+1] = matte
                    scanline[bm+2] = matte
                    scanline[bm+3] = pixel.toByte()
                }
                pixmap.pixels.position(off + (line * 16 * 4 * cw))
                pixmap.pixels.put(scanline)
                pixmap.pixels.position(0) // rewinding to avoid graphical glitch
            }
        }

    }

    /**
     * @param mode 0-Low, 1-High
     */
    open fun resetFontRom(mode: Int) {
        val pixmap = getOriginalChrrom()

        val dy = mode * chrrom.height / 2

        chrrom.blending = Pixmap.Blending.None
        chrrom.drawPixmap(pixmap, 0, dy, 0, dy, chrrom.width, chrrom.height / 2)

        pixmap.dispose()
    }


    override fun resetTtyStatus() {
        ttyFore = TTY_FORE_DEFAULT
        ttyBack = TTY_BACK_DEFAULT
    }

    override fun putChar(x: Int, y: Int, text: Byte, foreColour: Byte, backColour: Byte) {
        val textOff = toTtyTextOffset(x, y)
        textArea[memTextForeOffset + textOff] = foreColour
        textArea[memTextBackOffset + textOff] = backColour
        textArea[memTextOffset + textOff] = text
    }

    override fun emitChar(code: Int) {
        val (x, y) = getCursorPos()
        putChar(x, y, code.toByte())
        setCursorPos(x + 1, y)
    }
    override fun cursorUp(arg: Int) {
        val (x, y) = getCursorPos()
        setCursorPos(x, y - arg)
    }

    override fun cursorDown(arg: Int) {
        val (x, y) = getCursorPos()
        val newy = y + arg
        setCursorPos(x, if (newy >= TEXT_ROWS) TEXT_ROWS - 1 else newy)
    }

    override fun cursorFwd(arg: Int) {
        val (x, y) = getCursorPos()
        setCursorPos(x + arg, y)
    }

    override fun cursorBack(arg: Int) {
        val (x, y) = getCursorPos()
        setCursorPos(x - arg, y)
    }

    override fun cursorNextLine(arg: Int) {
        val (_, y) = getCursorPos()
        val newy = y + arg
        setCursorPos(0, if (newy >= TEXT_ROWS) TEXT_ROWS - 1 else newy)
        if (newy >= TEXT_ROWS) {
            scrollUp(newy - TEXT_ROWS + 1)
        }
    }

    override fun cursorPrevLine(arg: Int) {
        val (_, y) = getCursorPos()
        setCursorPos(0, y - arg)
    }

    override fun cursorX(arg: Int) {
        val (_, y) = getCursorPos()
        setCursorPos(arg, y)
    }

    override fun eraseInDisp(arg: Int) {
        when (arg) {
            2 -> {
                val foreBits = ttyFore or ttyFore.shl(8) or ttyFore.shl(16) or ttyFore.shl(24)
                val backBits = ttyBack or ttyBack.shl(8) or ttyBack.shl(16) or ttyBack.shl(24)
                for (i in 0 until TEXT_COLS * TEXT_ROWS step 4) {
                    textArea.setIntFree(memTextForeOffset + i, foreBits)
                    textArea.setIntFree(memTextBackOffset + i, backBits)
                    textArea.setIntFree(memTextOffset + i, 0)
                }
                textArea.setShortFree(memTextCursorPosOffset, 0)
            }
            else -> TODO()
        }
    }

    override fun eraseInLine(arg: Int) {
        when (arg) {
            else -> TODO()
        }
    }

    /** New lines are added at the bottom */
    override fun scrollUp(arg: Int) {
        val displacement = arg.toLong() * TEXT_COLS
        UnsafeHelper.memcpy(
            textArea.ptr + memTextOffset + displacement,
            textArea.ptr + memTextOffset,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            textArea.ptr + memTextBackOffset + displacement,
            textArea.ptr + memTextBackOffset,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            textArea.ptr + memTextForeOffset + displacement,
            textArea.ptr + memTextForeOffset,
            TEXT_AREA_SIZE - displacement
        )
        for (i in 0 until displacement) {
            textArea[memTextOffset + TEXT_AREA_SIZE - displacement + i] = 0
            textArea[memTextBackOffset + TEXT_AREA_SIZE - displacement + i] = ttyBack.toByte()
            textArea[memTextForeOffset + TEXT_AREA_SIZE - displacement + i] = ttyFore.toByte()
        }
    }

    /** New lines are added at the top */
    override fun scrollDown(arg: Int) {
        val displacement = arg.toLong() * TEXT_COLS
        UnsafeHelper.memcpy(
            textArea.ptr + memTextOffset,
            textArea.ptr + memTextOffset + displacement,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            textArea.ptr + memTextBackOffset,
            textArea.ptr + memTextBackOffset + displacement,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            textArea.ptr + memTextForeOffset,
            textArea.ptr + memTextForeOffset + displacement,
            TEXT_AREA_SIZE - displacement
        )
        for (i in 0 until displacement) {
            textArea[memTextOffset + TEXT_AREA_SIZE + i] = 0
            textArea[memTextBackOffset + TEXT_AREA_SIZE + i] = ttyBack.toByte()
            textArea[memTextForeOffset + TEXT_AREA_SIZE + i] = ttyFore.toByte()
        }
    }

    /*
    Color table for default palette

    Black   240
    Red     211
    Green   61
    Yellow  230
    Blue    49
    Magenta 219
    Cyan    114
    White   254
     */
    private val sgrDefault8ColPal = intArrayOf(240,211,61,230,49,219,114,254)

    override fun sgrOneArg(arg: Int) {

        if (arg in 30..37) {
            ttyFore = sgrDefault8ColPal[arg - 30]
        }
        else if (arg in 40..47) {
            ttyBack = sgrDefault8ColPal[arg - 40]
        }
        else if (arg == 7) {
            val t = ttyFore
            ttyFore = ttyBack
            ttyBack = t
        }
        else if (arg == 0) {
            ttyFore = TTY_FORE_DEFAULT
            ttyBack = TTY_BACK_DEFAULT
            blinkCursor = true
        }
    }

    override fun sgrTwoArg(arg1: Int, arg2: Int) {
        TODO("Not yet implemented")
    }

    override fun sgrThreeArg(arg1: Int, arg2: Int, arg3: Int) {
        if (arg1 == 38 && arg2 == 5) {
            ttyFore = arg3
        }
        else if (arg1 == 48 && arg2 == 5) {
            ttyBack = arg3
        }
    }

    override fun privateSeqH(arg: Int) {
        when (arg) {
            25 -> blinkCursor = true
        }
    }

    override fun privateSeqL(arg: Int) {
        when (arg) {
            25 -> blinkCursor = false
        }
    }

    /** The values are one-based
     * @param arg1 y-position (row)
     * @param arg2 x-position (column) */
    override fun cursorXY(arg1: Int, arg2: Int) {
        setCursorPos(arg2 - 1, arg1 - 1)
    }

    override fun ringBell() {

    }

    override fun insertTab() {
        val (x, y) = getCursorPos()
        setCursorPos((x / TAB_SIZE + 1) * TAB_SIZE, y)
    }

    override fun crlf() {
        val (_, y) = getCursorPos()
        val newy = y + 1 //+ halfrowMode.toInt()
        setCursorPos(0, if (newy >= TEXT_ROWS) TEXT_ROWS - 1 else newy)
        if (newy >= TEXT_ROWS) scrollUp(1)
    }

    override fun backspace() {
        val (x, y) = getCursorPos()
        setCursorPos(x - 1, y)
        putChar(x - 1, y, 0x20.toByte())
    }


    private lateinit var PRINTSTREAM_INSTANCE: OutputStream
    private lateinit var ERRORSTREAM_INSTANCE: OutputStream
    //private lateinit var INPUTSTREAM_INSTANCE: InputStream

    override fun getPrintStream(): OutputStream {
        try {
            return PRINTSTREAM_INSTANCE
        }
        catch (e: UninitializedPropertyAccessException) {
            PRINTSTREAM_INSTANCE = object : OutputStream() {
                override fun write(p0: Int) {
                    writeOut(p0.toByte())
                }
            }

            return PRINTSTREAM_INSTANCE
        }

    }

    override fun getErrorStream(): OutputStream {
        try {
            return ERRORSTREAM_INSTANCE
        }
        catch (e: UninitializedPropertyAccessException) {
            ERRORSTREAM_INSTANCE = object : OutputStream() {
                private val SGI_RED = byteArrayOf(0x1B, 0x5B, 0x33, 0x31, 0x6D)
                private val SGI_RESET = byteArrayOf(0x1B, 0x5B, 0x6D)

                override fun write(p0: Int) {
                    SGI_RED.forEach { writeOut(it) }
                    writeOut(p0.toByte())
                    SGI_RESET.forEach { writeOut(it) }
                }

                override fun write(p0: ByteArray) {
                    SGI_RED.forEach { writeOut(it) }
                    p0.forEach { writeOut(it) }
                    SGI_RESET.forEach { writeOut(it) }
                }
            }

            return ERRORSTREAM_INSTANCE
        }
    }

    /**
     * As getting the keyboard input now requires proper open and closing, the inputstream cannot be a singleton, unlike
     * the printstream.
     */
    override fun getInputStream(): InputStream {
        return object : InputStream() {

            init {
                vm.getIO().mmio_write(38L, 1)
            }

            override fun read(): Int {
                var key: Byte
                do {
                    Thread.sleep(4L) // if spinning rate is too fast, this function will fail.
                    // Possible cause: Input event handling of GDX is done on separate thread
                    key = vm.getIO().mmio_read(37L)!!
                } while (key == (-1).toByte())

                //println("[stdin] key = $key")
                return key.toInt().and(255)
            }

            override fun close() {
                vm.getIO().mmio_write(38L, 0)
            }
        }
    }

    fun Disposable.tryDispose() {
        try { this.dispose() } catch (_: GdxRuntimeException) {} catch (_: IllegalArgumentException) {}
    }

    override fun dispose() {
        //testTex.dispose()
//        paletteShader.tryDispose()
//        textShader.tryDispose()
        framebuffer.destroy()
        framebuffer2?.destroy()
        framebufferOut.tryDispose()
        rendertex.tryDispose()
        textArea.destroy()
        textForePixmap.tryDispose()
        textBackPixmap.tryDispose()
        textPixmap.tryDispose()
        faketex.tryDispose()
//        outFBOs.forEach { it.tryDispose() }
        outFBObatch.tryDispose()

        textForeTex.tryDispose()
        textBackTex.tryDispose()

        chrrom0.tryDispose()
        chrrom.tryDispose()
        unusedArea.destroy()
        scanlineOffsets.destroy()
        instArea.destroy()
        mappedFontRom.destroy()
    }

    private var textCursorBlinkTimer = 0f
    private val textCursorBlinkInterval = 0.25f
    private var textCursorIsOn = true
    private var glowDecay = config.decay
    private var decayColor = Color(1f, 1f, 1f, 1f - glowDecay)

    fun getBackgroundColour() = Color(
        unusedArea[0].toUint() / 255f,
        unusedArea[1].toUint() / 255f,
        unusedArea[2].toUint() / 255f, 1f)

    private val isRefSize = (WIDTH == 560 && HEIGHT == 448)

    open fun render(delta: Float, uiBatch: SpriteBatch, xoff: Float, yoff: Float, flipY: Boolean = false,  uiFBO: FrameBuffer? = null) {
        uiFBO?.end()


        // must reset positions as pixmaps expect them to be zero
        framebufferOut.pixels.position(0)
        chrrom.pixels.position(0)

        framebufferOut.setColor(-1);framebufferOut.fill()
        if (graphicsMode == 4 && framebuffer2 != null) {
            for (y in 0 until HEIGHT) {
                var xoff = scanlineOffsets[2L * y].toUint() or scanlineOffsets[2L * y + 1].toUint().shl(8)
                if (xoff.and(0x8000) != 0) xoff = xoff or 0xFFFF0000.toInt()
                val xs = (0 + xoff).coerceIn(0, WIDTH - 1)..(WIDTH - 1 + xoff).coerceIn(0, WIDTH - 1)

                if (xoff in -(WIDTH - 1) until WIDTH) {
                    for (x in xs) {
                        val rg = framebuffer[y.toLong() * WIDTH + (x - xoff)].toUint() // coerceIn not required as (x - xoff) never escapes 0..559
                        val ba = framebuffer2[y.toLong() * WIDTH + (x - xoff)].toUint() // coerceIn not required as (x - xoff) never escapes 0..559
                        val r = rg.ushr(4).and(15)
                        val g = rg.and(15)
                        val b = ba.ushr(4).and(15)
                        val a = ba.and(15)
                        framebufferOut.setColor(
                                r.shl(28) or r.shl(24) or
                                g.shl(20) or g.shl(16) or
                                b.shl(12) or b.shl(8) or
                                a.shl(4) or a
                        )
                        framebufferOut.drawPixel(x, y)
                    }
                }
            }
        }
        else if (graphicsMode == 3 && framebuffer2 != null) {
            val layerOrder = (if (graphicsMode == 1) LAYERORDERS4 else LAYERORDERS2)[layerArrangement]

            val fb1 = if (layerOrder[0] == 0) framebuffer else framebuffer2
            val fb2 = if (layerOrder[0] == 0) framebuffer2 else framebuffer

            for (y in 0 until HEIGHT) {
                var xoff = scanlineOffsets[2L * y].toUint() or scanlineOffsets[2L * y + 1].toUint().shl(8)
                if (xoff.and(0x8000) != 0) xoff = xoff or 0xFFFF0000.toInt()
                val xs = (0 + xoff).coerceIn(0, WIDTH - 1)..(WIDTH - 1 + xoff).coerceIn(0, WIDTH - 1)

                if (xoff in -(WIDTH - 1) until WIDTH) {
                    for (x in xs) {
                        val colourIndex1 = fb1[y.toLong() * WIDTH + (x - xoff)].toUint()
                        val colourIndex2 = fb2[y.toLong() * WIDTH + (x - xoff)].toUint()
                        val colour1 = Color(
                            paletteOfFloats[4 * colourIndex1],
                            paletteOfFloats[4 * colourIndex1 + 1],
                            paletteOfFloats[4 * colourIndex1 + 2],
                            paletteOfFloats[4 * colourIndex1 + 3]
                        )
                        val colour2 = Color(
                            paletteOfFloats[4 * colourIndex2],
                            paletteOfFloats[4 * colourIndex2 + 1],
                            paletteOfFloats[4 * colourIndex2 + 2],
                            paletteOfFloats[4 * colourIndex2 + 3]
                        )
                        val colour = listOf(colour1, colour2).fold(Color(0)) { dest, src ->
                            // manually alpha compositing
                            // out_color = {src_color * src_alpha + dest_color * dest_alpha * (1-src_alpha)} / out_alpha
                            // see https://gamedev.stackexchange.com/a/115786
                            val outAlpha = (dest.a + (1f - dest.a) * src.a).coerceIn(0.0001f, 1f) // identical to 1 - (1 - dest.a) * (1 - src.a) but this is more optimised form

                            // src.a + dest.a - src.a*dest.a)
                            Color(
                                (src.r * src.a + dest.r * dest.a * (1f - src.a)) / outAlpha,
                                (src.g * src.a + dest.g * dest.a * (1f - src.a)) / outAlpha,
                                (src.b * src.a + dest.b* dest.a * (1f - src.a)) / outAlpha,
                                outAlpha
                            )
                        }

                        framebufferOut.setColor(colour)
                        framebufferOut.drawPixel(x, y)
                    }
                }
            }
        }
        else if (isRefSize && (graphicsMode == 1 || graphicsMode == 2)) {
            val layerOrder = (if (graphicsMode == 1) LAYERORDERS4 else LAYERORDERS2)[layerArrangement]
            for (y in 0..223) {
                var xoff = scanlineOffsets[2L * y].toUint().shl(8) or scanlineOffsets[2L * y + 1].toUint()
                if (xoff.and(0x8000) != 0) xoff = xoff or 0xFFFF0000.toInt()
                val xs = (0 + xoff).coerceIn(0, 279)..(279 + xoff).coerceIn(0, 279)

                if (xoff in -(280 - 1) until 280) {
                    for (x in xs) {
                        val colour = layerOrder.map { layer ->
                            if (graphicsMode == 1) {
                                val colourIndex = framebuffer[(280L * 224 * layer) + (y * 280 + x)].toUint()
                                Color(
                                    paletteOfFloats[4 * colourIndex],
                                    paletteOfFloats[4 * colourIndex + 1],
                                    paletteOfFloats[4 * colourIndex + 2],
                                    paletteOfFloats[4 * colourIndex + 3]
                                )
                            }
                            else {
                                val lowBits = framebuffer[(280L * 224 * layer * 2) + (y * 280 + x)].toUint()
                                val highBits = framebuffer[(280L * 224 * (layer*2 + 1)) + (y * 280 + x)].toUint()
                                val r = lowBits.ushr(4).and(15)
                                val g = lowBits.and(15)
                                val b = highBits.ushr(4).and(15)
                                val a = highBits.and(15)
                                Color(
                                    r / 15f,
                                    g / 15f,
                                    b / 15f,
                                    a / 15f
                                )
                            }
                        }.fold(Color(0)) { dest, src ->
                            // manually alpha compositing
                            // out_color = {src_color * src_alpha + dest_color * dest_alpha * (1-src_alpha)} / out_alpha
                            // see https://gamedev.stackexchange.com/a/115786
                            val outAlpha = (dest.a + (1f - dest.a) * src.a).coerceIn(0.0001f, 1f) // identical to 1 - (1 - dest.a) * (1 - src.a) but this is more optimised form
                            
                            // src.a + dest.a - src.a*dest.a)
                            Color(
                                (src.r * src.a + dest.r * dest.a * (1f - src.a)) / outAlpha,
                                (src.g * src.a + dest.g * dest.a * (1f - src.a)) / outAlpha,
                                (src.b * src.a + dest.b* dest.a * (1f - src.a)) / outAlpha,
                                outAlpha
                            )
                        }

                        framebufferOut.setColor(colour)
                        framebufferOut.drawPixel(x*2, y*2)
                        framebufferOut.drawPixel(x*2+1, y*2)
                        framebufferOut.drawPixel(x*2, y*2+1)
                        framebufferOut.drawPixel(x*2+1, y*2+1)
                    }
                }
            }
        }
        else {
            for (y in 0 until HEIGHT) {
                var xoff = scanlineOffsets[2L * y].toUint() or scanlineOffsets[2L * y + 1].toUint().shl(8)
                if (xoff.and(0x8000) != 0) xoff = xoff or 0xFFFF0000.toInt()
                val xs = (0 + xoff).coerceIn(0, WIDTH - 1)..(WIDTH - 1 + xoff).coerceIn(0, WIDTH - 1)

                if (xoff in -(WIDTH - 1) until WIDTH) {
                    for (x in xs) {
                        val colourIndex = framebuffer[y.toLong() * WIDTH + (x - xoff)].toUint() // coerceIn not required as (x - xoff) never escapes 0..559
                        framebufferOut.setColor(paletteOfFloats[4*colourIndex], paletteOfFloats[4*colourIndex+1], paletteOfFloats[4*colourIndex+2], paletteOfFloats[4*colourIndex+3])
                        framebufferOut.drawPixel(x, y)
                    }
                }
            }
        }

        chrrom0.dispose()
        chrrom0 = Texture(chrrom)
        chrrom0.setWrap(Texture.TextureWrap.Repeat, Texture.TextureWrap.Repeat)
        rendertex.dispose()
        rendertex = Texture(framebufferOut, Pixmap.Format.RGBA8888, false)

        val texOffX = (framebufferScrollX fmod WIDTH) * -1f
        val texOffY = (framebufferScrollY fmod HEIGHT) * 1f

        outFBOs[1].inUse {
            outFBObatch.inUse {
                outFBObatch.shader = null
                blendNormal(outFBObatch)
                outFBObatch.color = decayColor
                outFBObatch.draw(outFBOregion[0], 0f, HEIGHT.toFloat(), WIDTH.toFloat(), -HEIGHT.toFloat())
            }
        }


        outFBOs[0].inUse {
            val clearCol = getBackgroundColour()
            Gdx.gl.glClearColor(0f, 0f, 0f, 1f)
            Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)

            outFBObatch.inUse {
                outFBObatch.shader = null

                blendNormal(outFBObatch)

                // clear screen
                outFBObatch.color = if (theme.startsWith("pmlcd")) LCD_BASE_COL else clearCol
                outFBObatch.draw(faketex, 0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat())


                // initiialise draw
                outFBObatch.color = Color.WHITE
                outFBObatch.shader = paletteShader

                // feed palette data
                // must be done every time the shader is "actually loaded"
                // try this: if above line precedes 'batch.shader = paletteShader', it won't work
                paletteShader.setUniform4fv("pal", paletteOfFloats, 0, paletteOfFloats.size)
                paletteShader.setUniformf("lcdBaseCol", LCD_BASE_COL)

                // draw framebuffer
                outFBObatch.draw(rendertex, texOffX, texOffY)
                outFBObatch.draw(rendertex, texOffX + WIDTH, texOffY)
                outFBObatch.draw(rendertex, texOffX + WIDTH, texOffY - HEIGHT)
                outFBObatch.draw(rendertex, texOffX, texOffY - HEIGHT)

                // draw texts or sprites

                outFBObatch.color = Color.WHITE

                if (!graphicsUseSprites) {
                    // draw texts
                    val (cx, cy) = getCursorPos()

                    // prepare char buffer texture
                    for (y in 0 until TEXT_ROWS) {
                        for (x in 0 until TEXT_COLS) {
                            val drawCursor = blinkCursor && textCursorIsOn && cx == x && cy == y
                            val addr = y.toLong() * TEXT_COLS + x
                            val char =
                                if (drawCursor) 0xFF else textArea[memTextOffset + addr].toInt().and(255)
                            var back =
                                if (drawCursor) ttyBack else textArea[memTextBackOffset + addr].toInt()
                                    .and(255)
                            var fore =
                                if (drawCursor) ttyFore else textArea[memTextForeOffset + addr].toInt()
                                    .and(255)

                            textPixmap.setColor(Color(0f, 0f, char / 255f, 1f))
                            textPixmap.drawPixel(x, y)
                            textBackPixmap.setColor(
                                Color(
                                    paletteOfFloats[4 * back],
                                    paletteOfFloats[4 * back + 1],
                                    paletteOfFloats[4 * back + 2],
                                    paletteOfFloats[4 * back + 3]
                                )
                            )
                            textBackPixmap.drawPixel(x, y)
                            textForePixmap.setColor(
                                Color(
                                    paletteOfFloats[4 * fore],
                                    paletteOfFloats[4 * fore + 1],
                                    paletteOfFloats[4 * fore + 2],
                                    paletteOfFloats[4 * fore + 3]
                                )
                            )
                            textForePixmap.drawPixel(x, y)
                        }
                    }

                    // bake char buffer texture
                    textForeTex.dispose()
                    textBackTex.dispose()
                    textTex.dispose()
                    textForeTex = Texture(textForePixmap)
                    textBackTex = Texture(textBackPixmap)
                    textTex = Texture(textPixmap)

                    textForeTex.bind(4)
                    textBackTex.bind(3)
                    textTex.bind(2)
                    chrrom0.bind(1)
                    faketex.bind(0)

                    outFBObatch.shader = textShader
                    textShader.setUniformi("foreColours", 4)
                    textShader.setUniformi("backColours", 3)
                    textShader.setUniformi("tilemap", 2)
                    textShader.setUniformi("tilesAtlas", 1)
                    textShader.setUniformi("u_texture", 0)
                    textShader.setUniformf("tilesInAxes", TEXT_COLS.toFloat(), TEXT_ROWS.toFloat())
                    textShader.setUniformf("screenDimension", WIDTH.toFloat(), HEIGHT.toFloat())
                    textShader.setUniformf("tilesInAtlas", 16f, 16f)
                    textShader.setUniformf("atlasTexSize", chrrom0.width.toFloat(), chrrom0.height.toFloat())
                    textShader.setUniformf("lcdBaseCol", LCD_BASE_COL)

                    outFBObatch.draw(faketex, 0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat())

                    outFBObatch.shader = null
                } else {
                    // draw sprites
                    outFBObatch.shader = paletteShader

                    // feed palette data
                    // must be done every time the shader is "actually loaded"
                    // try this: if above line precedes 'batch.shader = paletteShader', it won't work
                    paletteShader.setUniform4fv("pal", paletteOfFloats, 0, paletteOfFloats.size)
                    TODO("sprite draw")
                }

            }

            outFBObatch.shader = null

        }

        outFBOs[1].inUse {
            outFBObatch.inUse {
                outFBObatch.shader = null
                blendNormal(outFBObatch)
                outFBObatch.color = decayColor
                outFBObatch.draw(outFBOregion[0], 0f, HEIGHT.toFloat(), WIDTH.toFloat(), -HEIGHT.toFloat())
            }
        }
        uiFBO?.begin()

        uiBatch.inUse {
            uiBatch.shader = null
            //Gdx.gl.glClearColor(0f, 0f, 0f, 0f)
            //Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)
            blendNormal(uiBatch)

            uiBatch.color = Color.WHITE
            outFBOregion[1].texture.setFilter(
                if (config.scaleFiltered) Texture.TextureFilter.Linear else Texture.TextureFilter.Nearest,
                if (config.scaleFiltered) Texture.TextureFilter.Linear else Texture.TextureFilter.Nearest
            )

            if (!flipY)
                uiBatch.draw(outFBOregion[1], xoff, HEIGHT * config.drawScale + yoff, WIDTH * config.drawScale, -HEIGHT * config.drawScale)
            else
                uiBatch.draw(outFBOregion[1], xoff, yoff, WIDTH * config.drawScale, HEIGHT * config.drawScale)

        }


        textCursorBlinkTimer += delta
        if (textCursorBlinkTimer > textCursorBlinkInterval) {
            textCursorBlinkTimer -= 0.25f
            textCursorIsOn = !textCursorIsOn
        }

        // force light cursor up while typing
        textCursorIsOn = textCursorIsOn || ((1..254).any { Gdx.input.isKeyPressed(it) })


    }

    private fun blendNormal(batch: SpriteBatch) {
        Gdx.gl.glEnable(GL20.GL_TEXTURE_2D)
        Gdx.gl.glEnable(GL20.GL_BLEND)
        batch.setBlendFunctionSeparate(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA, GL20.GL_SRC_ALPHA, GL20.GL_ONE)
    }

    private fun peekPalette(offset: Int): Byte {
        if (offset >= 255 * 2) return 0 // palette 255 is always transparent

        val highvalue = paletteOfFloats[offset * 2] // R, B
        val lowvalue = paletteOfFloats[offset * 2 + 1] // G, A
        return (highvalue.div(15f).toInt().shl(4) or lowvalue.div(15f).toInt()).toByte()
    }

    private fun pokePalette(offset: Int, byte: Byte) {
        // palette 255 is always transparent
        if (offset < 255 * 2) {
            val highvalue = byte.toInt().and(0xF0).ushr(4) / 15f
            val lowvalue = byte.toInt().and(0x0F) / 15f

            paletteOfFloats[offset * 2] = highvalue
            paletteOfFloats[offset * 2 + 1] = lowvalue
        }
    }

    override fun putKey(key: Int) {
        vm.poke(-39, key.toByte())
    }

    /**
     * @return key code in 0..255 (TODO: JInput Keycode or ASCII-Code?)
     */
    override fun takeKey(): Int {
        return vm.peek(-38)!!.toInt().and(255)
    }

    companion object {
        val VRAM_SIZE = 256.kB()

        const val THEME_COLORCRT = "crt_color"
        const val THEME_GREYCRT = "crt"
        const val THEME_LCD = "pmlcd"
        const val THEME_LCD_INVERTED = "pmlcd_inverted"

        private val LCD_BASE_COL = Color(0xa1a99cff.toInt())

        val DRAW_SHADER_FRAG = """
#version 150

out vec4 fragColor;

in vec4 v_color;
in vec2 v_texCoords;
uniform sampler2D u_texture;
uniform vec4 pal[256];

void main(void) {
    fragColor = texture(u_texture, v_texCoords);
}
        """.trimIndent()

        val DRAW_SHADER_FRAG_LCD = """
#version 150

out vec4 fragColor;

in vec4 v_color;
in vec2 v_texCoords;
uniform sampler2D u_texture;
uniform vec4 pal[256];

float intensitySteps = 4.0;
uniform vec4 lcdBaseCol;

void main(void) {
//    vec4 palCol = pal[int(texture(u_texture, v_texCoords).a * 255.0)];
    vec4 palCol = texture(u_texture, v_texCoords);
    float lum = ceil((3.0 * palCol.r + 4.0 * palCol.g + palCol.b) / 8.0 * intensitySteps) / intensitySteps;
    vec4 outIntensity = vec4(vec3(1.0 - lum), palCol.a);

    // LCD output will invert the luminosity. That is, normally white colour will be black on PM-LCD.
    fragColor = lcdBaseCol * outIntensity;
}
        """.trimIndent()

        val DRAW_SHADER_FRAG_LCD_NOINV = """
#version 150

out vec4 fragColor;

in vec4 v_color;
in vec2 v_texCoords;
uniform sampler2D u_texture;
uniform vec4 pal[256];

float intensitySteps = 4.0;
uniform vec4 lcdBaseCol;

void main(void) {
//    vec4 palCol = pal[int(texture(u_texture, v_texCoords).a * 255.0)];
    vec4 palCol = texture(u_texture, v_texCoords);    float lum = floor((3.0 * palCol.r + 4.0 * palCol.g + palCol.b) / 8.0 * intensitySteps) / intensitySteps;
    vec4 outIntensity = vec4(vec3(lum), palCol.a);

    // LCD output will invert the luminosity. That is, normally white colour will be black on PM-LCD.
    fragColor = lcdBaseCol * outIntensity;
}
        """.trimIndent()

        val DRAW_SHADER_VERT = """
#version 150

in vec4 a_position;
in vec4 a_color;
in vec2 a_texCoord0;

uniform mat4 u_projTrans;

out vec4 v_color;
out vec2 v_texCoords;

void main() {
    v_color = a_color;
    v_color.a *= 255.0 / 254.0;
    v_texCoords = a_texCoord0;
    gl_Position = u_projTrans * a_position;
}
        """.trimIndent()

        val TEXT_TILING_SHADER_COLOUR = """
#version 150

out vec4 fragColor;
#ifdef GL_ES
precision mediump float;
#endif

//layout(origin_upper_left) in vec4 gl_FragCoord; // commented; requires #version 150 or later
// gl_FragCoord is origin to bottom-left

in vec4 v_color;
in vec2 v_texCoords;
uniform sampler2D u_texture;


uniform vec2 screenDimension;
uniform vec2 tilesInAxes; // size of the tilemap texture; vec2(tiles_in_horizontal, tiles_in_vertical)

uniform sampler2D tilesAtlas;
uniform sampler2D foreColours;
uniform sampler2D backColours;
uniform sampler2D tilemap;

uniform vec2 tilesInAtlas = ivec2(16.0, 16.0);
uniform vec2 atlasTexSize = ivec2(128.0, 224.0);
vec2 tileSizeInPx = atlasTexSize / tilesInAtlas; // should be like ivec2(16, 16)

ivec2 getTileXY(int tileNumber) {
    return ivec2(tileNumber % int(tilesInAtlas.x), tileNumber / int(tilesInAtlas.x));
}

// return: int=0xaarrggbb
int _colToInt(vec4 color) {
    return int(color.b * 255) | (int(color.g * 255) << 8) | (int(color.r * 255) << 16);
}

// 0x0rggbb where int=0xaarrggbb
// return: [0..1048575]
int getTileFromColor(vec4 color) {
    return _colToInt(color) & 0xFFFFF;
}

uniform float sgmp = 6.3;
float sgmcomp = 2.0 / (1.0 + exp(-sgmp)) - 1.001; // making sure everything sits within [0..1)

float sigmoid(float x) {
    return (2.0 / (1.0 + exp(-sgmp * 2 * (x - 0.5))) - 1.0) / sgmcomp;
}

vec4 sigmoid(vec4 x) {
    return (2.0 / (1.0 + exp(-sgmp * 2 * (x - 0.5))) - 1.0) / sgmcomp;
}

float invsigmoid(float x) {    
    return 0.5 / sgmp * log((1 + sgmcomp * 2.0 * (x - 0.5)) / (1 - sgmcomp * 2.0 * (x - 0.5))) + 0.5;
}

vec4 invsigmoid(vec4 x) {
    return 0.5 / sgmp * log((1 + sgmcomp * 2.0 * (x - 0.5)) / (1 - sgmcomp * 2.0 * (x - 0.5))) + 0.5;
}

vec4 lin(vec4 v) {
    float r = (v.r <= 0.04045) ? v.r / 12.92 : pow((v.r + 0.055) / 1.055, 2.4);
    float g = (v.g <= 0.04045) ? v.g / 12.92 : pow((v.g + 0.055) / 1.055, 2.4);
    float b = (v.b <= 0.04045) ? v.b / 12.92 : pow((v.b + 0.055) / 1.055, 2.4);
    return vec4(r, g, b, v.a);
}

vec4 unlin(vec4 v) {
    float r = (v.r <= 0.0031308) ? 12.92 * v.r : 1.055 * pow(v.r, 1.0 / 2.4) - 0.055;
    float g = (v.g <= 0.0031308) ? 12.92 * v.g : 1.055 * pow(v.g, 1.0 / 2.4) - 0.055;
    float b = (v.b <= 0.0031308) ? 12.92 * v.b : 1.055 * pow(v.b, 1.0 / 2.4) - 0.055;
    return vec4(r, g, b, v.a);
}

vec4 linmix(vec4 a, vec4 b, float x) {
    return unlin(mix(lin(a), lin(b), x));
}

vec4 sigmoidmix(vec4 a, vec4 b, float x) {
    return sigmoid(mix(invsigmoid(a), invsigmoid(b), x));
}

const vec2 bc = vec2(1.0, 0.0); //binary constant

void main() {

    // READ THE FUCKING MANUAL, YOU DONKEY !! //
    // This code purposedly uses flipped fragcoord. //
    // Make sure you don't use gl_FragCoord unknowingly! //
    // Remember, if there's a compile error, shader SILENTLY won't do anything //


    // default gl_FragCoord takes half-integer (represeting centre of the pixel) -- could be useful for phys solver?
    // This one, however, takes exact integer by rounding down. //
    vec2 flippedFragCoord = vec2(gl_FragCoord.x, screenDimension.y - gl_FragCoord.y); // NO IVEC2!!; this flips Y

    // get required tile numbers //

    vec4 tileFromMap = texture(tilemap, flippedFragCoord / screenDimension); // raw tile number
    vec4 foreColFromMap = texture(foreColours, flippedFragCoord / screenDimension);
    vec4 backColFromMap = texture(backColours, flippedFragCoord / screenDimension);

    int tile = getTileFromColor(tileFromMap);
    vec2 tileXY = getTileXY(tile);

    // calculate the UV coord value for texture sampling //

    // don't really need highp here; read the GLES spec
    vec2 uvCoordForTile = mod(flippedFragCoord, tileSizeInPx) / atlasTexSize;
    vec2 uvCoordOffsetTile = tileXY / tilesInAtlas; // where the tile starts in the atlas, using uv coord (0..1)

    // get final UV coord for the actual sampling //

    vec2 finalUVCoordForTile = uvCoordForTile + uvCoordOffsetTile;// where we should be actually looking for in atlas, using UV coord (0..1)

    vec4 tileCol = texture(tilesAtlas, finalUVCoordForTile);

    fragColor = linmix(backColFromMap, foreColFromMap, tileCol.a);
}
""".trimIndent()

        val TEXT_TILING_SHADER_MONOCHROME = """
#version 150
#extension GL_EXT_gpu_shader4 : enable

out vec4 fragColor;
#ifdef GL_ES
precision mediump float;
#endif

//layout(origin_upper_left) in vec4 gl_FragCoord; // commented; requires #version 150 or later
// gl_FragCoord is origin to bottom-left

in vec4 v_color;
in vec2 v_texCoords;
uniform sampler2D u_texture;


uniform vec2 screenDimension;
uniform vec2 tilesInAxes; // size of the tilemap texture; vec2(tiles_in_horizontal, tiles_in_vertical)

uniform sampler2D tilesAtlas;
uniform sampler2D foreColours;
uniform sampler2D backColours;
uniform sampler2D tilemap;

uniform vec2 tilesInAtlas = ivec2(16.0, 16.0);
uniform vec2 atlasTexSize = ivec2(128.0, 224.0);
vec2 tileSizeInPx = atlasTexSize / tilesInAtlas; // should be like ivec2(16, 16)

ivec2 getTileXY(int tileNumber) {
    return ivec2(tileNumber % int(tilesInAtlas.x), tileNumber / int(tilesInAtlas.x));
}

// return: int=0xaarrggbb
int _colToInt(vec4 color) {
    return int(color.b * 255) | (int(color.g * 255) << 8) | (int(color.r * 255) << 16) | (int(color.a * 255) << 24);
}

// 0x0rggbb where int=0xaarrggbb
// return: [0..1048575]
int getTileFromColor(vec4 color) {
    return _colToInt(color) & 0xFFFFF;
}

vec4 grey(vec4 color) {
    float lum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b; // common standard used by both NTSC and PAL
    return vec4(lum, lum, lum, color.a);
}

uniform float sgmp = 6.3;
float sgmcomp = 2.0 / (1.0 + exp(-sgmp)) - 1.001; // making sure everything sits within [0..1)

float sigmoid(float x) {
    return (2.0 / (1.0 + exp(-sgmp * 2 * (x - 0.5))) - 1.0) / sgmcomp;
}

vec4 sigmoid(vec4 x) {
    return (2.0 / (1.0 + exp(-sgmp * 2 * (x - 0.5))) - 1.0) / sgmcomp;
}

float invsigmoid(float x) {    
    return 0.5 / sgmp * log((1 + sgmcomp * 2.0 * (x - 0.5)) / (1 - sgmcomp * 2.0 * (x - 0.5))) + 0.5;
}

vec4 invsigmoid(vec4 x) {
    return 0.5 / sgmp * log((1 + sgmcomp * 2.0 * (x - 0.5)) / (1 - sgmcomp * 2.0 * (x - 0.5))) + 0.5;
}

vec4 lin(vec4 v) {
    float r = (v.r <= 0.04045) ? v.r / 12.92 : pow((v.r + 0.055) / 1.055, 2.4);
    float g = (v.g <= 0.04045) ? v.g / 12.92 : pow((v.g + 0.055) / 1.055, 2.4);
    float b = (v.b <= 0.04045) ? v.b / 12.92 : pow((v.b + 0.055) / 1.055, 2.4);
    return vec4(r, g, b, v.a);
}

vec4 unlin(vec4 v) {
    float r = (v.r <= 0.0031308) ? 12.92 * v.r : 1.055 * pow(v.r, 1.0 / 2.4) - 0.055;
    float g = (v.g <= 0.0031308) ? 12.92 * v.g : 1.055 * pow(v.g, 1.0 / 2.4) - 0.055;
    float b = (v.b <= 0.0031308) ? 12.92 * v.b : 1.055 * pow(v.b, 1.0 / 2.4) - 0.055;
    return vec4(r, g, b, v.a);
}

vec4 linmix(vec4 a, vec4 b, float x) {
    return unlin(mix(lin(a), lin(b), x));
}

vec4 sigmoidmix(vec4 a, vec4 b, float x) {
    return sigmoid(mix(invsigmoid(a), invsigmoid(b), x));
}

void main() {

    // READ THE FUCKING MANUAL, YOU DONKEY !! //
    // This code purposedly uses flipped fragcoord. //
    // Make sure you don't use gl_FragCoord unknowingly! //
    // Remember, if there's a compile error, shader SILENTLY won't do anything //


    // default gl_FragCoord takes half-integer (represeting centre of the pixel) -- could be useful for phys solver?
    // This one, however, takes exact integer by rounding down. //
    vec2 flippedFragCoord = vec2(gl_FragCoord.x, screenDimension.y - gl_FragCoord.y); // NO IVEC2!!; this flips Y

    // get required tile numbers //

    vec4 tileFromMap = texture(tilemap, flippedFragCoord / screenDimension); // raw tile number
    vec4 foreColFromMap = grey(texture(foreColours, flippedFragCoord / screenDimension));
    vec4 backColFromMap = grey(texture(backColours, flippedFragCoord / screenDimension));

    int tile = getTileFromColor(tileFromMap);
    ivec2 tileXY = getTileXY(tile);

    // calculate the UV coord value for texture sampling //

    // don't really need highp here; read the GLES spec
    vec2 uvCoordForTile = mod(flippedFragCoord, tileSizeInPx) / atlasTexSize;
    vec2 uvCoordOffsetTile = tileXY / tilesInAtlas; // where the tile starts in the atlas, using uv coord (0..1)

    // get final UV coord for the actual sampling //

    vec2 finalUVCoordForTile = uvCoordForTile + uvCoordOffsetTile;// where we should be actually looking for in atlas, using UV coord (0..1)

    vec4 tileCol = texture(tilesAtlas, finalUVCoordForTile);

    fragColor = linmix(backColFromMap, foreColFromMap, tileCol.a);
}
""".trimIndent()

        val TEXT_TILING_SHADER_LCD = """
#version 150
#extension GL_EXT_gpu_shader4 : enable

out vec4 fragColor;
#ifdef GL_ES
precision mediump float;
#endif

//layout(origin_upper_left) in vec4 gl_FragCoord; // commented; requires #version 150 or later
// gl_FragCoord is origin to bottom-left

in vec4 v_color;
in vec2 v_texCoords;
uniform sampler2D u_texture;


uniform vec2 screenDimension;
uniform vec2 tilesInAxes; // size of the tilemap texture; vec2(tiles_in_horizontal, tiles_in_vertical)

uniform sampler2D tilesAtlas;
uniform sampler2D foreColours;
uniform sampler2D backColours;
uniform sampler2D tilemap;

uniform vec2 tilesInAtlas = ivec2(16.0, 16.0);
uniform vec2 atlasTexSize = ivec2(128.0, 224.0);
vec2 tileSizeInPx = atlasTexSize / tilesInAtlas; // should be like ivec2(16, 16)

ivec2 getTileXY(int tileNumber) {
    return ivec2(tileNumber % int(tilesInAtlas.x), tileNumber / int(tilesInAtlas.x));
}

// return: int=0xaarrggbb
int _colToInt(vec4 color) {
    return int(color.b * 255) | (int(color.g * 255) << 8) | (int(color.r * 255) << 16) | (int(color.a * 255) << 24);
}

// 0x0rggbb where int=0xaarrggbb
// return: [0..1048575]
int getTileFromColor(vec4 color) {
    return _colToInt(color) & 0xFFFFF;
}

float intensitySteps = 4.0;
uniform vec4 lcdBaseCol;

void main() {

    // READ THE FUCKING MANUAL, YOU DONKEY !! //
    // This code purposedly uses flipped fragcoord. //
    // Make sure you don't use gl_FragCoord unknowingly! //
    // Remember, if there's a compile error, shader SILENTLY won't do anything //


    // default gl_FragCoord takes half-integer (represeting centre of the pixel) -- could be useful for phys solver?
    // This one, however, takes exact integer by rounding down. //
    vec2 flippedFragCoord = vec2(gl_FragCoord.x, screenDimension.y - gl_FragCoord.y); // NO IVEC2!!; this flips Y

    // get required tile numbers //

    vec4 tileFromMap = texture(tilemap, flippedFragCoord / screenDimension); // raw tile number
    vec4 foreColFromMap = texture(foreColours, flippedFragCoord / screenDimension);
    vec4 backColFromMap = texture(backColours, flippedFragCoord / screenDimension);

    int tile = getTileFromColor(tileFromMap);
    ivec2 tileXY = getTileXY(tile);

    // calculate the UV coord value for texture sampling //

    // don't really need highp here; read the GLES spec
    vec2 uvCoordForTile = mod(flippedFragCoord, tileSizeInPx) / atlasTexSize;
    vec2 uvCoordOffsetTile = tileXY / tilesInAtlas; // where the tile starts in the atlas, using uv coord (0..1)

    // get final UV coord for the actual sampling //

    vec2 finalUVCoordForTile = uvCoordForTile + uvCoordOffsetTile;// where we should be actually looking for in atlas, using UV coord (0..1)

    // blending a breakage tex with main tex //

    vec4 tileCol = texture(tilesAtlas, finalUVCoordForTile);

    vec4 palCol = vec4(1.0);
    // apply colour
    if (tileCol.a > 0) {
        palCol = foreColFromMap;
    }
    else {
        palCol = backColFromMap;
    }
    
    float lum = floor((3.0 * palCol.r + 4.0 * palCol.g + palCol.b) / 8.0 * intensitySteps) / intensitySteps;
    vec4 outIntensity = vec4(vec3(1.0 - lum), palCol.a);

    // LCD output will invert the luminosity. That is, normally white colour will be black on PM-LCD.
    fragColor = lcdBaseCol * outIntensity;
}
""".trimIndent()

        val TEXT_TILING_SHADER_LCD_NOINV = """
#version 150
#extension GL_EXT_gpu_shader4 : enable

out vec4 fragColor;
#ifdef GL_ES
precision mediump float;
#endif

//layout(origin_upper_left) in vec4 gl_FragCoord; // commented; requires #version 150 or later
// gl_FragCoord is origin to bottom-left

in vec4 v_color;
in vec2 v_texCoords;
uniform sampler2D u_texture;


uniform vec2 screenDimension;
uniform vec2 tilesInAxes; // size of the tilemap texture; vec2(tiles_in_horizontal, tiles_in_vertical)

uniform sampler2D tilesAtlas;
uniform sampler2D foreColours;
uniform sampler2D backColours;
uniform sampler2D tilemap;

uniform vec2 tilesInAtlas = ivec2(16.0, 16.0);
uniform vec2 atlasTexSize = ivec2(128.0, 224.0);
vec2 tileSizeInPx = atlasTexSize / tilesInAtlas; // should be like ivec2(16, 16)

ivec2 getTileXY(int tileNumber) {
    return ivec2(tileNumber % int(tilesInAtlas.x), tileNumber / int(tilesInAtlas.x));
}

// return: int=0xaarrggbb
int _colToInt(vec4 color) {
    return int(color.b * 255) | (int(color.g * 255) << 8) | (int(color.r * 255) << 16) | (int(color.a * 255) << 24);
}

// 0x0rggbb where int=0xaarrggbb
// return: [0..1048575]
int getTileFromColor(vec4 color) {
    return _colToInt(color) & 0xFFFFF;
}

float intensitySteps = 4.0;
uniform vec4 lcdBaseCol;

void main() {

    // READ THE FUCKING MANUAL, YOU DONKEY !! //
    // This code purposedly uses flipped fragcoord. //
    // Make sure you don't use gl_FragCoord unknowingly! //
    // Remember, if there's a compile error, shader SILENTLY won't do anything //


    // default gl_FragCoord takes half-integer (represeting centre of the pixel) -- could be useful for phys solver?
    // This one, however, takes exact integer by rounding down. //
    vec2 flippedFragCoord = vec2(gl_FragCoord.x, screenDimension.y - gl_FragCoord.y); // NO IVEC2!!; this flips Y

    // get required tile numbers //

    vec4 tileFromMap = texture(tilemap, flippedFragCoord / screenDimension); // raw tile number
    vec4 foreColFromMap = texture(foreColours, flippedFragCoord / screenDimension);
    vec4 backColFromMap = texture(backColours, flippedFragCoord / screenDimension);

    int tile = getTileFromColor(tileFromMap);
    ivec2 tileXY = getTileXY(tile);

    // calculate the UV coord value for texture sampling //

    // don't really need highp here; read the GLES spec
    vec2 uvCoordForTile = (mod(flippedFragCoord, tileSizeInPx) / tileSizeInPx) / tilesInAtlas; // 0..0.00390625 regardless of tile position in atlas
    vec2 uvCoordOffsetTile = tileXY / tilesInAtlas; // where the tile starts in the atlas, using uv coord (0..1)

    // get final UV coord for the actual sampling //

    vec2 finalUVCoordForTile = uvCoordForTile + uvCoordOffsetTile;// where we should be actually looking for in atlas, using UV coord (0..1)

    // blending a breakage tex with main tex //

    vec4 tileCol = texture(tilesAtlas, finalUVCoordForTile);

    vec4 palCol = vec4(1.0);
    // apply colour
    if (tileCol.a > 0) {
        palCol = foreColFromMap;
    }
    else {
        palCol = backColFromMap;
    }
    
    float lum = floor((3.0 * palCol.r + 4.0 * palCol.g + palCol.b) / 8.0 * intensitySteps) / intensitySteps;
    vec4 outIntensity = vec4(vec3(lum), palCol.a);

    // LCD output will invert the luminosity. That is, normally white colour will be black on PM-LCD.
    fragColor = lcdBaseCol * outIntensity;
}
""".trimIndent()


        val DEFAULT_CONFIG_COLOR_CRT = AdapterConfig(
            "crt_color",
            560, 448, 80, 32, 253, 255, 256.kB(), "", 0.32f, TEXT_TILING_SHADER_COLOUR
        )
        val DEFAULT_CONFIG_PMLCD = AdapterConfig(
            "pmlcd_inverted",
            560, 448, 80, 32, 253, 255, 256.kB(), "", 0.64f, TEXT_TILING_SHADER_LCD, DRAW_SHADER_FRAG_LCD
        )

        val DEFAULT_CONFIG_FOR_TESTING = AdapterConfig(
            "crt_color",
            560, 448, 80, 32, 253, 255, 256.kB(), "", 0f, TEXT_TILING_SHADER_COLOUR
        )


        val DEFAULT_PALETTE = intArrayOf( // 0b rrrrrrrr gggggggg bbbbbbbb aaaaaaaa
            255,
            17663,
            35071,
            48127,
            65535,
            2228479,
            2245887,
            2263295,
            2276351,
            2293759,
            4456703,
            4474111,
            4491519,
            4504575,
            4521983,
            6684927,
            6702335,
            6719743,
            6732799,
            6750207,
            10027263,
            10044671,
            10062079,
            10075135,
            10092543,
            12255487,
            12272895,
            12290303,
            12303359,
            12320767,
            14483711,
            14501119,
            14518527,
            14531583,
            14548991,
            16711935,
            16729343,
            16746751,
            16759807,
            16777215,
            855638271,
            855655679,
            855673087,
            855686143,
            855703551,
            857866495,
            857883903,
            857901311,
            857914367,
            857931775,
            860094719,
            860112127,
            860129535,
            860142591,
            860159999,
            862322943,
            862340351,
            862357759,
            862370815,
            862388223,
            865665279,
            865682687,
            865700095,
            865713151,
            865730559,
            867893503,
            867910911,
            867928319,
            867941375,
            867958783,
            870121727,
            870139135,
            870156543,
            870169599,
            870187007,
            872349951,
            872367359,
            872384767,
            872397823,
            872415231,
            1711276287,
            1711293695,
            1711311103,
            1711324159,
            1711341567,
            1713504511,
            1713521919,
            1713539327,
            1713552383,
            1713569791,
            1715732735,
            1715750143,
            1715767551,
            1715780607,
            1715798015,
            1717960959,
            1717978367,
            1717995775,
            1718008831,
            1718026239,
            1721303295,
            1721320703,
            1721338111,
            1721351167,
            1721368575,
            1723531519,
            1723548927,
            1723566335,
            1723579391,
            1723596799,
            1725759743,
            1725777151,
            1725794559,
            1725807615,
            1725825023,
            1727987967,
            1728005375,
            1728022783,
            1728035839,
            1728053247,
            -1728052993,
            -1728035585,
            -1728018177,
            -1728005121,
            -1727987713,
            -1725824769,
            -1725807361,
            -1725789953,
            -1725776897,
            -1725759489,
            -1723596545,
            -1723579137,
            -1723561729,
            -1723548673,
            -1723531265,
            -1721368321,
            -1721350913,
            -1721333505,
            -1721320449,
            -1721303041,
            -1718025985,
            -1718008577,
            -1717991169,
            -1717978113,
            -1717960705,
            -1715797761,
            -1715780353,
            -1715762945,
            -1715749889,
            -1715732481,
            -1713569537,
            -1713552129,
            -1713534721,
            -1713521665,
            -1713504257,
            -1711341313,
            -1711323905,
            -1711306497,
            -1711293441,
            -1711276033,
            -872414977,
            -872397569,
            -872380161,
            -872367105,
            -872349697,
            -870186753,
            -870169345,
            -870151937,
            -870138881,
            -870121473,
            -867958529,
            -867941121,
            -867923713,
            -867910657,
            -867893249,
            -865730305,
            -865712897,
            -865695489,
            -865682433,
            -865665025,
            -862387969,
            -862370561,
            -862353153,
            -862340097,
            -862322689,
            -860159745,
            -860142337,
            -860124929,
            -860111873,
            -860094465,
            -857931521,
            -857914113,
            -857896705,
            -857883649,
            -857866241,
            -855703297,
            -855685889,
            -855668481,
            -855655425,
            -855638017,
            -16776961,
            -16759553,
            -16742145,
            -16729089,
            -16711681,
            -14548737,
            -14531329,
            -14513921,
            -14500865,
            -14483457,
            -12320513,
            -12303105,
            -12285697,
            -12272641,
            -12255233,
            -10092289,
            -10074881,
            -10057473,
            -10044417,
            -10027009,
            -6749953,
            -6732545,
            -6715137,
            -6702081,
            -6684673,
            -4521729,
            -4504321,
            -4486913,
            -4473857,
            -4456449,
            -2293505,
            -2276097,
            -2258689,
            -2245633,
            -2228225,
            -65281,
            -47873,
            -30465,
            -17409,
            -1,
            255,
            286331391,
            572662527,
            858993663,
            1145324799,
            1431655935,
            1717987071,
            2004318207,
            -2004317953,
            -1717986817,
            -1431655681,
            -1145324545,
            -858993409,
            -572662273,
            -286331137,
            0
        )

        val DEFAULT_PALETTE_NUMBERS = DEFAULT_PALETTE.map { // [[r,g,b,a], [r,g,b,a], [r,g,b,a], ...]
            intArrayOf(it.ushr(24).and(255), it.ushr(16).and(255), it.ushr(8).and(255), it.and(255))
        }

        val DEFAULT_PALETTE_NUMBERS_FLOAT = DEFAULT_PALETTE.map { // [[r,g,b,a], [r,g,b,a], [r,g,b,a], ...]
            floatArrayOf(
                it.ushr(24).and(255).div(255f),
                it.ushr(16).and(255).div(255f),
                it.ushr(8).and(255).div(255f),
                it.and(255).div(255f)
            )
        }

        val LAYERORDERS4 = listOf( // [drawn first, second, third, fourth], zero-indexed
            "1234",
            "1243",
            "1324",
            "1342",
            "1423",
            "1432",
            "2134",
            "2143",
            "2314",
            "2341",
            "2413",
            "2431",
            "3124",
            "3142",
            "3214",
            "3241",
            "3412",
            "3421",
            "4123",
            "4132",
            "4213",
            "4231",
            "4312",
            "4321",
        ).map { s -> (0..3).map { s[it].toInt() - 49 } }

        val LAYERORDERS2 = listOf( // [drawn first, second], zero-indexed
            "12",
            "12",
            "12",
            "12",
            "12",
            "12",
            "12",
            "21",
            "21",
            "21",
            "21",
            "21",
            "12",
            "12",
            "21",
            "21",
            "12",
            "21",
            "12",
            "12",
            "21",
            "21",
            "12",
            "21",
        ).map { s -> (0..1).map { s[it].toInt() - 49 } }
    }
}

internal infix fun Int.fmod(other: Int): Int {
    return Math.floorMod(this, other)
}

internal fun FrameBuffer.inUse(action: () -> Unit) {
    FBM.begin(this)
    action()
    FBM.end()
}

internal fun SpriteBatch.inUse(action: () -> Unit) {
    this.begin()
    action()
    this.end()
}
