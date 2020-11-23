package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.VM
import net.torvald.tsvm.kB
import kotlin.math.absoluteValue

class TexticsAdapter(vm: VM) : GraphicsAdapter(vm, AdapterConfig(
    "crt",
    720,
    375,
    80,
    25,
    254,
    0,
    256.kB(),
    "./hp2640.png",
    0.32f
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

    private val crtGradTex = Texture("./crt_grad.png")

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

    override fun render(delta: Float, batch: SpriteBatch, xoff: Float, yoff: Float) {
        super.render(delta, batch, xoff, yoff)

        // CRT's default grey
        batch.inUse {
            batch.enableBlending()
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