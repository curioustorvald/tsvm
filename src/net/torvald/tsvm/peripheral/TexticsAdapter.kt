package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.VM
import net.torvald.tsvm.kB
import kotlin.math.absoluteValue

class TexticsAdapter(vm: VM) : GraphicsAdapter(vm, AdapterConfig(
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
    GraphicsAdapter.TEXT_TILING_SHADER_MONOCHROME
)) {
/*class TexticsAdapter(vm: VM) : GraphicsAdapter(vm, AdapterConfig(
    "crt_color",
    560,
    448,
    80,
    32,
    254,
    255,
    256.kB(),
    "./cp437_fira_code.png",
    0.64f
)) {*/

    private val crtGradTex = Texture("./assets/crt_grad.png")

    companion object {
        val crtColor = hashMapOf(
            "white" to Color(0xe4eaffff.toInt()),
            "amber" to Color(0xffb700ff.toInt()),
            "green" to Color(0x4aff00ff)
        )
    }

    override fun peek(addr: Long): Byte? {
        return when (addr) {
            in 0 until 250880 -> (-1).toByte()
            else -> super.peek(addr)
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        when (addr) {
            in 0 until 250880 -> { /*do nothing*/ }
            else -> super.poke(addr, byte)
        }
    }

    private val TEX_HEIGHT = WIDTH * Math.sqrt(HEIGHT.toDouble() / WIDTH).toFloat()
    private val ALIGN = (HEIGHT - TEX_HEIGHT).absoluteValue / 2f
    private val phosphorCol = crtColor[theme.substring(4)] ?: crtColor["white"]

    override fun render(delta: Float, batch: SpriteBatch, xoff: Float, yoff: Float) {
        super.render(delta, batch, xoff, yoff)


        batch.inUse {
            batch.enableBlending()

            // phosphor
            batch.setBlendFunction(GL20.GL_DST_COLOR, GL20.GL_ONE_MINUS_SRC_ALPHA)
            batch.color = phosphorCol
            batch.draw(faketex, xoff, HEIGHT + yoff, WIDTH.toFloat(), -HEIGHT.toFloat())

            // CRT glass
            batch.setBlendFunction(GL20.GL_ONE, GL20.GL_ONE_MINUS_SRC_COLOR)
            batch.color = Color.WHITE
            batch.draw(crtGradTex, xoff, HEIGHT + ALIGN + yoff, WIDTH.toFloat(), -TEX_HEIGHT)
            //batch.draw(crtGradTex, xoff, HEIGHT + yoff, WIDTH.toFloat(), -HEIGHT.toFloat())
        }
    }

    override fun dispose() {
        crtGradTex.dispose()
        super.dispose()
    }
}