package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.graphics.glutils.FrameBuffer
import com.badlogic.gdx.graphics.glutils.ShaderProgram
import net.torvald.tsvm.VM
import net.torvald.tsvm.kB
import kotlin.math.absoluteValue

open class TexticsAdapterBase(assetsRoot: String, vm: VM, config: AdapterConfig) : GraphicsAdapter(assetsRoot, vm, config) {

    init {
        println("Baud: $sleepMillis ms $sleepNanos ns")
    }

//    private val crtGradTex = Texture("$assetsRoot/crt_grad.png")

    companion object {
        val crtColor = hashMapOf(
            "white" to Color(0xe4eaffff.toInt()),
            "amber" to Color(0xffd600ff.toInt()),
            "green" to Color(0x4aff00ff)
        )
    }

    override fun applyDelay() {
        applyDelay0()
    }

    override fun peek(addr: Long): Byte? {
        return when (addr) {
            in 0 until 250972 -> (-1).toByte()
            else -> super.peek(addr)
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        when (addr) {
            in 0 until 250972 -> { /*do nothing*/ }
            else -> super.poke(addr, byte)
        }
    }

    override fun setCursorPos(x: Int, y: Int) {
        super.setCursorPos(x, y)
    }

    override fun putChar(x: Int, y: Int, text: Byte, foreColour: Byte, backColour: Byte) {
        super.putChar(x, y, text, foreColour, backColour)
    }

    private val TEX_HEIGHT = WIDTH * Math.sqrt(HEIGHT.toDouble() / WIDTH).toFloat()
    private val ALIGN = (HEIGHT - TEX_HEIGHT).absoluteValue / 2f
    private val phosphorCol = crtColor[theme.substring(4)] ?: crtColor["white"]

    override fun render(
        delta: Float,
        batch: SpriteBatch,
        xoff: Float,
        yoff: Float,
        flipY: Boolean,
        shader: ShaderProgram?,
        uiFBO: FrameBuffer?
    ) {

        super.render(delta, batch, xoff, yoff, flipY, shader, uiFBO)

        batch.inUse {
            batch.enableBlending()

            // phosphor
            batch.setBlendFunction(GL20.GL_DST_COLOR, GL20.GL_ONE_MINUS_SRC_ALPHA)
            batch.color = phosphorCol
            batch.draw(faketex, xoff, HEIGHT + yoff, WIDTH.toFloat(), -HEIGHT.toFloat())

            // CRT glass is overlaid by the caller (e.g. VMGUI)
//            batch.setBlendFunction(GL20.GL_ONE, GL20.GL_ONE_MINUS_SRC_COLOR)
//            batch.color = Color.WHITE
//            batch.draw(crtGradTex, xoff, HEIGHT + ALIGN + yoff, WIDTH.toFloat(), -TEX_HEIGHT)
        }
    }

    override fun dispose() {
//        crtGradTex.dispose()
        super.dispose()
    }
}

class Term(assetsRoot: String, vm: VM) : TexticsAdapterBase(assetsRoot, vm, AdapterConfig(
    "crt_white",
    720,
    480,
    80,
    32,
    254,
    0,
    256.kB(),
    "./hp2640.png",
    0.32f,
    GraphicsAdapter.TEXT_TILING_SHADER_MONOCHROME,
    baudRate = 9600.0
))

class WpTerm(assetsRoot: String, vm: VM) : TexticsAdapterBase(assetsRoot, vm, AdapterConfig(
    "crt_amber",
    810,
    360,
    90,
    20,
    254,
    0,
    256.kB(),
    "./wpfont.png",
    0.32f,
    GraphicsAdapter.TEXT_TILING_SHADER_MONOCHROME
))