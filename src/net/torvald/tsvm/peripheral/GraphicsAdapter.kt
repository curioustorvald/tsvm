package net.torvald.tsvm.peripheral

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.graphics.glutils.FrameBuffer
import net.torvald.UnsafeHelper
import net.torvald.tsvm.AppLoader
import net.torvald.tsvm.VM
import net.torvald.tsvm.kB
import net.torvald.tsvm.peripheral.GraphicsAdapter.Companion.DRAW_SHADER_FRAG
import java.io.InputStream
import java.io.OutputStream
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
    val paletteShader: String = DRAW_SHADER_FRAG
)

/**
 * NOTE: if TTY size is greater than 80*32, SEGFAULT will occur because text buffer is fixed in size
 */
open class GraphicsAdapter(val vm: VM, val config: AdapterConfig) :
    GlassTty(config.textRows, config.textCols), PeriBase {

    override fun getVM(): VM {
        return vm
    }

    protected val WIDTH = config.width
    protected val HEIGHT = config.height
    protected val VRAM_SIZE = config.vramSize
    protected val TTY_FORE_DEFAULT = config.ttyDefaultFore
    protected val TTY_BACK_DEFAULT = config.ttyDefaultBack
    protected val theme = config.theme

    internal val framebuffer = Pixmap(WIDTH, HEIGHT, Pixmap.Format.Alpha)
    protected var rendertex = Texture(1, 1, Pixmap.Format.RGBA8888)
    internal val paletteOfFloats = FloatArray(1024) {
        val rgba = DEFAULT_PALETTE[it / 4]
        val channel = it % 4
        rgba.shr((3 - channel) * 8).and(255) / 255f
    }
    protected val chrrom0 = Texture(config.chrRomPath)
    protected val faketex: Texture

    internal val spriteAndTextArea = UnsafeHelper.allocate(10660L)
    protected val unusedArea = ByteArray(92)

    protected val paletteShader = AppLoader.loadShaderInline(DRAW_SHADER_VERT,
        config.paletteShader
        /*if (theme.startsWith("pmlcd") && !theme.endsWith("_inverted"))
            DRAW_SHADER_FRAG_LCD_NOINV
        else if (theme.startsWith("pmlcd"))
            DRAW_SHADER_FRAG_LCD
        else
            DRAW_SHADER_FRAG*/
    )
    protected val textShader = AppLoader.loadShaderInline(DRAW_SHADER_VERT,
        config.fragShader
        /*if (theme.startsWith("crt_") && !theme.endsWith("color"))
            TEXT_TILING_SHADER_MONOCHROME
        else if (theme.startsWith("pmlcd") && !theme.endsWith("_inverted"))
            TEXT_TILING_SHADER_LCD_NOINV
        else if (theme.startsWith("pmlcd"))
            TEXT_TILING_SHADER_LCD
        else
            TEXT_TILING_SHADER_COLOUR*/
    )

    override var blinkCursor = true
    override var ttyRawMode = false
    private var graphicsUseSprites = false
    private var lastUsedColour = (-1).toByte()
    private var currentChrRom = 0
    private var chrWidth = 7f
    private var chrHeight = 14f

    override var ttyFore: Int = TTY_FORE_DEFAULT // cannot be Byte
    override var ttyBack: Int = TTY_BACK_DEFAULT // cannot be Byte

    private val textForePixmap = Pixmap(TEXT_COLS, TEXT_ROWS, Pixmap.Format.RGBA8888)
    private val textBackPixmap = Pixmap(TEXT_COLS, TEXT_ROWS, Pixmap.Format.RGBA8888)
    private val textPixmap = Pixmap(TEXT_COLS, TEXT_ROWS, Pixmap.Format.RGBA8888)

    private var textForeTex = Texture(textForePixmap)
    private var textBackTex = Texture(textBackPixmap)
    private var textTex = Texture(textPixmap)

    private val outFBOs = Array(2) { FrameBuffer(Pixmap.Format.RGBA8888, WIDTH, HEIGHT, false) }

    private val memTextCursorPosOffset = 2978L
    private val memTextForeOffset = 2980L
    private val memTextBackOffset = 2980L + 2560
    private val memTextOffset = 2980L + 2560 + 2560
    private val TEXT_AREA_SIZE = TEXT_COLS * TEXT_ROWS

    override var rawCursorPos: Int
        get() = spriteAndTextArea.getShort(memTextCursorPosOffset).toInt()
        set(value) { spriteAndTextArea.setShort(memTextCursorPosOffset, value.toShort()) }

    override fun getCursorPos() = rawCursorPos % TEXT_COLS to rawCursorPos / TEXT_COLS

    override fun setCursorPos(x: Int, y: Int) {
        var newx = x
        var newy = y

        if (newx >= TEXT_COLS) {
            newx = 0
            newy += 1
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
        framebuffer.blending = Pixmap.Blending.None
        textForePixmap.blending = Pixmap.Blending.None
        textBackPixmap.blending = Pixmap.Blending.None
        framebuffer.setColor(-1)
        framebuffer.fill()

        val pm = Pixmap(1, 1, Pixmap.Format.RGBA8888)
        pm.drawPixel(0, 0, -1)
        faketex = Texture(pm)
        pm.dispose()

        // initialise with NONZERO value; value zero corresponds with opaque black, and it will paint the whole screen black
        // when in text mode, and that's undesired behaviour
        // -1 is preferred because it points to the colour CLEAR, and it's constant.
        spriteAndTextArea.fillWith(-1)
        // fill text area with 0
        for (k in 0 until TEXT_ROWS * TEXT_COLS) {
            spriteAndTextArea[k + memTextOffset] = 0
        }

        if (theme.contains("color")) {
            unusedArea[0] = 2
            unusedArea[1] = 3
            unusedArea[2] = 4
        }

        setCursorPos(0, 0)

        println(framebuffer.pixels.limit())
    }

    override fun peek(addr: Long): Byte? {
        val adi = addr.toInt()
        return when (addr) {
            in 0 until 250880 -> framebuffer.pixels.get(adi)//framebuffer.getPixel(adi % WIDTH, adi / WIDTH).toByte()
            in 250880 until 250972 -> unusedArea[adi - 250880]
            in 250972 until 261632 -> spriteAndTextArea[addr - 250972]
            in 261632 until 262144 -> peekPalette(adi - 261632)
            in 0 until VM.HW_RESERVE_SIZE -> {
                println("[GraphicsAdapter] mirroring with input address $addr")
                peek(addr % VRAM_SIZE)
            } // HW mirroring
            else -> null
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toInt().and(255)
        when (addr) {
            in 0 until 250880 -> {
                lastUsedColour = byte
                framebuffer.pixels.put(adi, byte)
            }
            250883L -> {
                unusedArea[adi - 250880] = byte
                runCommand(byte)
            }
            in 250880 until 250972 -> unusedArea[adi - 250880] = byte
            in 250972 until 261632 -> spriteAndTextArea[addr - 250972] = byte
            in 261632 until 262144 -> pokePalette(adi - 261632, byte)
            in 0 until VM.HW_RESERVE_SIZE -> {
                println("[GraphicsAdapter] mirroring with input address $addr")
                poke(addr % VRAM_SIZE, byte)
            } // HW mirroring
        }
    }

    private fun getTextmodeAttirbutes(): Byte = (currentChrRom.and(15).shl(4) or
            ttyRawMode.toInt().shl(1) or
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
            11L -> 1

            in 0 until VM.MMIO_SIZE -> -1
            else -> null
        }
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        TODO("Not yet implemented")
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
                framebuffer.setColor(
                    paletteOfFloats[arg1 * 4],
                    paletteOfFloats[arg1 * 4 + 1],
                    paletteOfFloats[arg1 * 4 + 2],
                    paletteOfFloats[arg1 * 4 + 3]
                )
                framebuffer.fill()
            }
        }
    }

    override fun resetTtyStatus() {
        ttyFore = TTY_FORE_DEFAULT
        ttyBack = TTY_BACK_DEFAULT
    }

    override fun putChar(x: Int, y: Int, text: Byte, foreColour: Byte, backColour: Byte) {
        val textOff = toTtyTextOffset(x, y)
        spriteAndTextArea[memTextForeOffset + textOff] = foreColour
        spriteAndTextArea[memTextBackOffset + textOff] = backColour
        spriteAndTextArea[memTextOffset + textOff] = text
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
                    spriteAndTextArea.setInt(memTextForeOffset + i, foreBits)
                    spriteAndTextArea.setInt(memTextBackOffset + i, backBits)
                    spriteAndTextArea.setInt(memTextOffset + i, 0)
                }
                spriteAndTextArea.setShort(memTextCursorPosOffset, 0)
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
            spriteAndTextArea.ptr + memTextOffset + displacement,
            spriteAndTextArea.ptr + memTextOffset,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            spriteAndTextArea.ptr + memTextBackOffset + displacement,
            spriteAndTextArea.ptr + memTextBackOffset,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            spriteAndTextArea.ptr + memTextForeOffset + displacement,
            spriteAndTextArea.ptr + memTextForeOffset,
            TEXT_AREA_SIZE - displacement
        )
        for (i in 0 until displacement) {
            spriteAndTextArea[memTextOffset + TEXT_AREA_SIZE - displacement + i] = 0
            spriteAndTextArea[memTextBackOffset + TEXT_AREA_SIZE - displacement + i] = ttyBack.toByte()
            spriteAndTextArea[memTextForeOffset + TEXT_AREA_SIZE - displacement + i] = ttyFore.toByte()
        }
    }

    /** New lines are added at the top */
    override fun scrollDown(arg: Int) {
        val displacement = arg.toLong() * TEXT_COLS
        UnsafeHelper.memcpy(
            spriteAndTextArea.ptr + memTextOffset,
            spriteAndTextArea.ptr + memTextOffset + displacement,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            spriteAndTextArea.ptr + memTextBackOffset,
            spriteAndTextArea.ptr + memTextBackOffset + displacement,
            TEXT_AREA_SIZE - displacement
        )
        UnsafeHelper.memcpy(
            spriteAndTextArea.ptr + memTextForeOffset,
            spriteAndTextArea.ptr + memTextForeOffset + displacement,
            TEXT_AREA_SIZE - displacement
        )
        for (i in 0 until displacement) {
            spriteAndTextArea[memTextOffset + TEXT_AREA_SIZE + i] = 0
            spriteAndTextArea[memTextBackOffset + TEXT_AREA_SIZE + i] = ttyBack.toByte()
            spriteAndTextArea[memTextForeOffset + TEXT_AREA_SIZE + i] = ttyFore.toByte()
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
        setCursorPos((x / 8) + 8, y)
    }

    override fun crlf() {
        val (_, y) = getCursorPos()
        val newy = y + 1
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

    override fun dispose() {
        framebuffer.dispose()
        rendertex.dispose()
        spriteAndTextArea.destroy()
        textForePixmap.dispose()
        textBackPixmap.dispose()
        textPixmap.dispose()
        paletteShader.dispose()
        textShader.dispose()
        faketex.dispose()
        outFBOs.forEach { it.dispose() }

        try { textForeTex.dispose() } catch (_: Throwable) {}
        try { textBackTex.dispose() } catch (_: Throwable) {}

        chrrom0.dispose()
    }

    private var textCursorBlinkTimer = 0f
    private val textCursorBlinkInterval = 0.5f
    private var textCursorIsOn = true
    private var glowDecay = config.decay
    private var decayColor = Color(1f, 1f, 1f, 1f - glowDecay)

    open fun render(delta: Float, batch: SpriteBatch, xoff: Float, yoff: Float) {
        rendertex.dispose()
        rendertex = Texture(framebuffer, Pixmap.Format.RGBA8888, false)

        outFBOs[1].inUse {
            batch.shader = null
            batch.inUse {
                blendNormal(batch)
                batch.color = decayColor
                batch.draw(outFBOs[0].colorBufferTexture, 0f, HEIGHT.toFloat(), WIDTH.toFloat(), -HEIGHT.toFloat())
            }
        }


        outFBOs[0].inUse {
            val clearCol = Color(unusedArea[0].toInt().and(15).toFloat() / 15f,
                unusedArea[1].toInt().and(15).toFloat() / 15f,
                unusedArea[2].toInt().and(15).toFloat() / 15f, 1f)
            Gdx.gl.glClearColor(0f, 0f, 0f, 1f)
            Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)

            batch.shader = null
            batch.inUse {
                blendNormal(batch)

                // clear screen
                batch.color = if (theme.startsWith("pmlcd")) LCD_BASE_COL else clearCol
                batch.draw(faketex, 0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat())


                // initiialise draw
                batch.color = Color.WHITE
                batch.shader = paletteShader

                // feed palette data
                // must be done every time the shader is "actually loaded"
                // try this: if above line precedes 'batch.shader = paletteShader', it won't work
                batch.shader.setUniform4fv("pal", paletteOfFloats, 0, paletteOfFloats.size)
                if (theme.startsWith("pmlcd")) batch.shader.setUniformf("lcdBaseCol", LCD_BASE_COL)

                // draw framebuffer
                batch.draw(rendertex, 0f, 0f)

                // draw texts or sprites

                batch.color = Color.WHITE

                if (!graphicsUseSprites) {
                    // draw texts
                    val (cx, cy) = getCursorPos()

                    // prepare char buffer texture
                    for (y in 0 until TEXT_ROWS) {
                        for (x in 0 until TEXT_COLS) {
                            val drawCursor = blinkCursor && textCursorIsOn && cx == x && cy == y
                            val addr = y.toLong() * TEXT_COLS + x
                            val char =
                                if (drawCursor) 0xFF else spriteAndTextArea[memTextOffset + addr].toInt().and(255)
                            var back =
                                if (drawCursor) ttyBack else spriteAndTextArea[memTextBackOffset + addr].toInt()
                                    .and(255)
                            var fore =
                                if (drawCursor) ttyFore else spriteAndTextArea[memTextForeOffset + addr].toInt()
                                    .and(255)

                            if (!theme.contains("color")) {
                                if (back == 255) back = 0
                                if (fore == 255) fore = 0
                            }

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

                    batch.shader = textShader
                    textShader.setUniformi("foreColours", 4)
                    textShader.setUniformi("backColours", 3)
                    textShader.setUniformi("tilemap", 2)
                    textShader.setUniformi("tilesAtlas", 1)
                    textShader.setUniformi("u_texture", 0)
                    textShader.setUniformf("tilesInAxes", TEXT_COLS.toFloat(), TEXT_ROWS.toFloat())
                    textShader.setUniformf("screenDimension", WIDTH.toFloat(), HEIGHT.toFloat())
                    textShader.setUniformf("tilesInAtlas", 16f, 16f)
                    textShader.setUniformf("atlasTexSize", chrrom0.width.toFloat(), chrrom0.height.toFloat())
                    if (theme.startsWith("pmlcd")) batch.shader.setUniformf("lcdBaseCol", LCD_BASE_COL)

                    batch.draw(faketex, 0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat())

                    batch.shader = null
                } else {
                    // draw sprites
                    batch.shader = paletteShader

                    // feed palette data
                    // must be done every time the shader is "actually loaded"
                    // try this: if above line precedes 'batch.shader = paletteShader', it won't work
                    paletteShader.setUniform4fv("pal", paletteOfFloats, 0, paletteOfFloats.size)
                    TODO("sprite draw")
                }

            }

            batch.shader = null

        }

        outFBOs[1].inUse {
            batch.shader = null
            batch.inUse {
                blendNormal(batch)

                batch.color = decayColor
                batch.draw(outFBOs[0].colorBufferTexture, 0f, HEIGHT.toFloat(), WIDTH.toFloat(), -HEIGHT.toFloat())
            }
        }

        batch.shader = null
        batch.inUse {
            Gdx.gl.glClearColor(0f, 0f, 0f, 1f)
            Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)
            blendNormal(batch)

            batch.color = Color.WHITE
            batch.draw(outFBOs[1].colorBufferTexture, xoff, HEIGHT.toFloat() + yoff, WIDTH.toFloat(), -HEIGHT.toFloat())
        }


        textCursorBlinkTimer += delta
        if (textCursorBlinkTimer > textCursorBlinkInterval) {
            textCursorBlinkTimer -= 0.5f
            textCursorIsOn = !textCursorIsOn
        }

    }

    private fun blendNormal(batch: SpriteBatch) {
        Gdx.gl.glEnable(GL20.GL_TEXTURE_2D)
        Gdx.gl.glEnable(GL20.GL_BLEND)
        batch.setBlendFunctionSeparate(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA, GL20.GL_SRC_ALPHA, GL20.GL_ONE)
    }

    private fun peekPalette(offset: Int): Byte {
        if (offset == 255) return 0 // palette 255 is always transparent

        // FIXME always return zero?

        val highvalue = paletteOfFloats[offset * 2] // R, B
        val lowvalue = paletteOfFloats[offset * 2 + 1] // G, A
        return (highvalue.div(15f).toInt().shl(4) or lowvalue.div(15f).toInt()).toByte()
    }

    private fun pokePalette(offset: Int, byte: Byte) {
        // palette 255 is always transparent
        if (offset < 255) {
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

    private fun Boolean.toInt() = if (this) 1 else 0

    companion object {
        val VRAM_SIZE = 256.kB()

        const val THEME_COLORCRT = "crt_color"
        const val THEME_GREYCRT = "crt"
        const val THEME_LCD = "pmlcd"
        const val THEME_LCD_INVERTED = "pmlcd_inverted"

        private val LCD_BASE_COL = Color(0xa1a99cff.toInt())

        val DRAW_SHADER_FRAG = """
#version 130

varying vec4 v_color;
varying vec2 v_texCoords;
uniform sampler2D u_texture;
uniform vec4 pal[256];

float rand(vec2 co){
    return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
}

void main(void) {
    gl_FragColor = pal[int(texture2D(u_texture, v_texCoords).a * 255.0)];
}
        """.trimIndent()

        val DRAW_SHADER_FRAG_LCD = """
#version 130

varying vec4 v_color;
varying vec2 v_texCoords;
uniform sampler2D u_texture;
uniform vec4 pal[256];

float intensitySteps = 4.0;
uniform vec4 lcdBaseCol;

void main(void) {
    vec4 palCol = pal[int(texture2D(u_texture, v_texCoords).a * 255.0)];
    float lum = floor((3.0 * palCol.r + 4.0 * palCol.g + palCol.b) / 8.0 * intensitySteps) / intensitySteps;
    vec4 outIntensity = vec4(vec3(1.0 - lum), palCol.a);

    // LCD output will invert the luminosity. That is, normally white colour will be black on PM-LCD.
    gl_FragColor = lcdBaseCol * outIntensity;
}
        """.trimIndent()

        val DRAW_SHADER_FRAG_LCD_NOINV = """
#version 130

varying vec4 v_color;
varying vec2 v_texCoords;
uniform sampler2D u_texture;
uniform vec4 pal[256];

float intensitySteps = 4.0;
uniform vec4 lcdBaseCol;

void main(void) {
    vec4 palCol = pal[int(texture2D(u_texture, v_texCoords).a * 255.0)];
    float lum = floor((3.0 * palCol.r + 4.0 * palCol.g + palCol.b) / 8.0 * intensitySteps) / intensitySteps;
    vec4 outIntensity = vec4(vec3(lum), palCol.a);

    // LCD output will invert the luminosity. That is, normally white colour will be black on PM-LCD.
    gl_FragColor = lcdBaseCol * outIntensity;
}
        """.trimIndent()

        val DRAW_SHADER_VERT = """
#version 130

attribute vec4 a_position;
attribute vec4 a_color;
attribute vec2 a_texCoord0;

uniform mat4 u_projTrans;

varying vec4 v_color;
varying vec2 v_texCoords;

void main() {
    v_color = a_color;
    v_texCoords = a_texCoord0;
    gl_Position = u_projTrans * a_position;
}
        """.trimIndent()

        val TEXT_TILING_SHADER_COLOUR = """
#version 130
#ifdef GL_ES
precision mediump float;
#endif
#extension GL_EXT_gpu_shader4 : enable

//layout(origin_upper_left) in vec4 gl_FragCoord; // commented; requires #version 150 or later
// gl_FragCoord is origin to bottom-left

varying vec4 v_color;
varying vec2 v_texCoords;
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

void main() {

    // READ THE FUCKING MANUAL, YOU DONKEY !! //
    // This code purposedly uses flipped fragcoord. //
    // Make sure you don't use gl_FragCoord unknowingly! //
    // Remember, if there's a compile error, shader SILENTLY won't do anything //


    // default gl_FragCoord takes half-integer (represeting centre of the pixel) -- could be useful for phys solver?
    // This one, however, takes exact integer by rounding down. //
    vec2 flippedFragCoord = vec2(gl_FragCoord.x, screenDimension.y - gl_FragCoord.y); // NO IVEC2!!; this flips Y

    // get required tile numbers //

    vec4 tileFromMap = texture2D(tilemap, flippedFragCoord / screenDimension); // raw tile number
    vec4 foreColFromMap = texture2D(foreColours, flippedFragCoord / screenDimension);
    vec4 backColFromMap = texture2D(backColours, flippedFragCoord / screenDimension);

    int tile = getTileFromColor(tileFromMap);
    ivec2 tileXY = getTileXY(tile);

    // calculate the UV coord value for texture sampling //

    // don't really need highp here; read the GLES spec
    vec2 uvCoordForTile = (mod(flippedFragCoord, tileSizeInPx) / tileSizeInPx) / tilesInAtlas; // 0..0.00390625 regardless of tile position in atlas
    vec2 uvCoordOffsetTile = tileXY / tilesInAtlas; // where the tile starts in the atlas, using uv coord (0..1)

    // get final UV coord for the actual sampling //

    vec2 finalUVCoordForTile = uvCoordForTile + uvCoordOffsetTile;// where we should be actually looking for in atlas, using UV coord (0..1)

    // blending a breakage tex with main tex //

    vec4 tileCol = texture2D(tilesAtlas, finalUVCoordForTile);

    // apply colour. I'm expecting FONT ROM IMAGE to be greyscale
    gl_FragColor = mix(backColFromMap, foreColFromMap, tileCol.r);
}
""".trimIndent()

        val TEXT_TILING_SHADER_MONOCHROME = """
#version 130
#ifdef GL_ES
precision mediump float;
#endif
#extension GL_EXT_gpu_shader4 : enable

//layout(origin_upper_left) in vec4 gl_FragCoord; // commented; requires #version 150 or later
// gl_FragCoord is origin to bottom-left

varying vec4 v_color;
varying vec2 v_texCoords;
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

void main() {

    // READ THE FUCKING MANUAL, YOU DONKEY !! //
    // This code purposedly uses flipped fragcoord. //
    // Make sure you don't use gl_FragCoord unknowingly! //
    // Remember, if there's a compile error, shader SILENTLY won't do anything //


    // default gl_FragCoord takes half-integer (represeting centre of the pixel) -- could be useful for phys solver?
    // This one, however, takes exact integer by rounding down. //
    vec2 flippedFragCoord = vec2(gl_FragCoord.x, screenDimension.y - gl_FragCoord.y); // NO IVEC2!!; this flips Y

    // get required tile numbers //

    vec4 tileFromMap = texture2D(tilemap, flippedFragCoord / screenDimension); // raw tile number
    vec4 foreColFromMap = grey(texture2D(foreColours, flippedFragCoord / screenDimension));
    vec4 backColFromMap = grey(texture2D(backColours, flippedFragCoord / screenDimension));

    int tile = getTileFromColor(tileFromMap);
    ivec2 tileXY = getTileXY(tile);

    // calculate the UV coord value for texture sampling //

    // don't really need highp here; read the GLES spec
    vec2 uvCoordForTile = (mod(flippedFragCoord, tileSizeInPx) / tileSizeInPx) / tilesInAtlas; // 0..0.00390625 regardless of tile position in atlas
    vec2 uvCoordOffsetTile = tileXY / tilesInAtlas; // where the tile starts in the atlas, using uv coord (0..1)

    // get final UV coord for the actual sampling //

    vec2 finalUVCoordForTile = uvCoordForTile + uvCoordOffsetTile;// where we should be actually looking for in atlas, using UV coord (0..1)

    // blending a breakage tex with main tex //

    vec4 tileCol = texture2D(tilesAtlas, finalUVCoordForTile);

    // apply colour. I'm expecting FONT ROM IMAGE to be greyscale
    gl_FragColor = mix(backColFromMap, foreColFromMap, tileCol.r);
}
""".trimIndent()

        val TEXT_TILING_SHADER_LCD = """
#version 130
#ifdef GL_ES
precision mediump float;
#endif
#extension GL_EXT_gpu_shader4 : enable

//layout(origin_upper_left) in vec4 gl_FragCoord; // commented; requires #version 150 or later
// gl_FragCoord is origin to bottom-left

varying vec4 v_color;
varying vec2 v_texCoords;
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

    vec4 tileFromMap = texture2D(tilemap, flippedFragCoord / screenDimension); // raw tile number
    vec4 foreColFromMap = texture2D(foreColours, flippedFragCoord / screenDimension);
    vec4 backColFromMap = texture2D(backColours, flippedFragCoord / screenDimension);

    int tile = getTileFromColor(tileFromMap);
    ivec2 tileXY = getTileXY(tile);

    // calculate the UV coord value for texture sampling //

    // don't really need highp here; read the GLES spec
    vec2 uvCoordForTile = (mod(flippedFragCoord, tileSizeInPx) / tileSizeInPx) / tilesInAtlas; // 0..0.00390625 regardless of tile position in atlas
    vec2 uvCoordOffsetTile = tileXY / tilesInAtlas; // where the tile starts in the atlas, using uv coord (0..1)

    // get final UV coord for the actual sampling //

    vec2 finalUVCoordForTile = uvCoordForTile + uvCoordOffsetTile;// where we should be actually looking for in atlas, using UV coord (0..1)

    // blending a breakage tex with main tex //

    vec4 tileCol = texture2D(tilesAtlas, finalUVCoordForTile);

    vec4 palCol = vec4(1.0);
    // apply colour
    if (tileCol.r > 0) {
        palCol = foreColFromMap;
    }
    else {
        palCol = backColFromMap;
    }
    
    float lum = floor((3.0 * palCol.r + 4.0 * palCol.g + palCol.b) / 8.0 * intensitySteps) / intensitySteps;
    vec4 outIntensity = vec4(vec3(1.0 - lum), palCol.a);

    // LCD output will invert the luminosity. That is, normally white colour will be black on PM-LCD.
    gl_FragColor = lcdBaseCol * outIntensity;
}
""".trimIndent()

        val TEXT_TILING_SHADER_LCD_NOINV = """
#version 130
#ifdef GL_ES
precision mediump float;
#endif
#extension GL_EXT_gpu_shader4 : enable

//layout(origin_upper_left) in vec4 gl_FragCoord; // commented; requires #version 150 or later
// gl_FragCoord is origin to bottom-left

varying vec4 v_color;
varying vec2 v_texCoords;
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

    vec4 tileFromMap = texture2D(tilemap, flippedFragCoord / screenDimension); // raw tile number
    vec4 foreColFromMap = texture2D(foreColours, flippedFragCoord / screenDimension);
    vec4 backColFromMap = texture2D(backColours, flippedFragCoord / screenDimension);

    int tile = getTileFromColor(tileFromMap);
    ivec2 tileXY = getTileXY(tile);

    // calculate the UV coord value for texture sampling //

    // don't really need highp here; read the GLES spec
    vec2 uvCoordForTile = (mod(flippedFragCoord, tileSizeInPx) / tileSizeInPx) / tilesInAtlas; // 0..0.00390625 regardless of tile position in atlas
    vec2 uvCoordOffsetTile = tileXY / tilesInAtlas; // where the tile starts in the atlas, using uv coord (0..1)

    // get final UV coord for the actual sampling //

    vec2 finalUVCoordForTile = uvCoordForTile + uvCoordOffsetTile;// where we should be actually looking for in atlas, using UV coord (0..1)

    // blending a breakage tex with main tex //

    vec4 tileCol = texture2D(tilesAtlas, finalUVCoordForTile);

    vec4 palCol = vec4(1.0);
    // apply colour
    if (tileCol.r > 0) {
        palCol = foreColFromMap;
    }
    else {
        palCol = backColFromMap;
    }
    
    float lum = floor((3.0 * palCol.r + 4.0 * palCol.g + palCol.b) / 8.0 * intensitySteps) / intensitySteps;
    vec4 outIntensity = vec4(vec3(lum), palCol.a);

    // LCD output will invert the luminosity. That is, normally white colour will be black on PM-LCD.
    gl_FragColor = lcdBaseCol * outIntensity;
}
""".trimIndent()


        val DEFAULT_CONFIG_COLOR_CRT = AdapterConfig(
            "crt_color",
            560, 448, 80, 32, 254, 255, 256.kB(), "./cp437_fira_code.png", 0.32f, TEXT_TILING_SHADER_COLOUR
        )
        val DEFAULT_CONFIG_PMLCD = AdapterConfig(
            "pmlcd_inverted",
            560, 448, 80, 32, 254, 255, 256.kB(), "./FontROM7x14.png", 0.64f, TEXT_TILING_SHADER_LCD, DRAW_SHADER_FRAG_LCD
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
    }
}

fun FrameBuffer.inUse(action: () -> Unit) {
    this.begin()
    action()
    this.end()
}

fun SpriteBatch.inUse(action: () -> Unit) {
    this.begin()
    action()
    this.end()
}