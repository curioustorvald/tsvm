package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.math.Matrix4
import net.torvald.tsvm.AppLoader
import net.torvald.tsvm.VM

/**
 * External Display that is always visible through its own UI ingame.
 *
 * Created by minjaesong on 2021-12-01.
 */
class ExtDisp(val vm: VM, val width: Int, val height: Int) : PeriBase {

    constructor(vm: VM, w: java.lang.Integer, h: java.lang.Integer) : this(
        vm, w.toInt(), h.toInt()
    )

    override val typestring = "oled"

    override fun getVM(): VM {
        return vm
    }

    internal val framebuffer = Pixmap(width, height, Pixmap.Format.Alpha)
    private val outFBObatch = SpriteBatch()

    protected val drawShader = AppLoader.loadShaderInline(GraphicsAdapter.DRAW_SHADER_VERT, OLED_PAL_SHADER)

    init {
        // no orthographic camera, must be "raw" Matrix4
        val m = Matrix4()
        m.setToOrtho2D(0f, 0f, width.toFloat(), height.toFloat())
        outFBObatch.projectionMatrix = m

        framebuffer.blending = Pixmap.Blending.None
        framebuffer.setColor(0)
        framebuffer.fill()
    }

    private lateinit var tex: Texture

    open fun render(uiBatch: SpriteBatch, xoff: Float, yoff: Float) {
        framebuffer.pixels.position(0)

        tex = Texture(framebuffer)

        uiBatch.inUse {
            uiBatch.color = Color.WHITE
            uiBatch.shader = drawShader
            uiBatch.draw(tex, xoff, yoff)
        }

        tex.dispose()
    }

    /**
     * Get the next power of two of the given number.
     *
     * E.g. for an input 100, this returns 128.
     * Returns 1 for all numbers <= 1.
     *
     * @param number The number to obtain the POT for.
     * @return The next power of two.
     */
    private fun nextPowerOfTwo(number: Int): Int {
        var number = number
        number--
        number = number or (number shr 1)
        number = number or (number shr 2)
        number = number or (number shr 4)
        number = number or (number shr 8)
        number = number or (number shr 16)
        number++
        number += if (number == 0) 1 else 0
        return number
    }

    override fun peek(addr: Long): Byte? {
        val adi = addr.toInt()
        return when (addr) {
            in 0 until width * height -> {
                framebuffer.pixels.get(adi)
            }
            in 0 until nextPowerOfTwo(width * height) -> { null }
            else -> peek(addr % nextPowerOfTwo(width * height))
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toInt().and(255)
        when (addr) {
            in 0 until width * height -> {
                framebuffer.pixels.put(adi, byte)
            }
            in 0 until nextPowerOfTwo(width * height) -> { /* do nothing */ }
            else -> poke(addr % nextPowerOfTwo(width * height), byte)
        }
    }

    override fun mmio_read(addr: Long): Byte? {
        TODO("Not yet implemented")
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        TODO("Not yet implemented")
    }

    override fun dispose() {
        try { framebuffer.dispose() } catch (e: Throwable) {}
        try { tex.dispose() } catch (e: Throwable) {}
    }


    companion object {
        val OLED_PAL_SHADER = """
#version 130

varying vec4 v_color;
varying vec2 v_texCoords;
uniform sampler2D u_texture;
vec4 pal[16] = vec4[](
vec4(0.0,0.0,0.0,1.0),
vec4(0.0,0.1765,0.6667,1.0),
vec4(0.0,0.6667,0.0,1.0),
vec4(0.0,0.7255,0.6667,1.0),
vec4(0.6667,0.0,0.0,1.0),
vec4(0.6667,0.1765,0.6667,1.0),
vec4(0.6667,0.6667,0.0,1.0),
vec4(0.6667,0.6667,0.6667,1.0),

vec4(0.0,0.0,0.0,1.0),
vec4(0.0,0.2667,1.0,1.0),
vec4(0.0,1.0,0.0,1.0),
vec4(0.0,1.0,1.0,1.0),
vec4(1.0,0.0,0.0,1.0),
vec4(1.0,0.2667,1.0,1.0),
vec4(1.0,1.0,0.0,1.0),
vec4(1.0,1.0,1.0,1.0)
);

void main(void) {
    gl_FragColor = pal[int(texture2D(u_texture, v_texCoords).a * 255.0) % 16];
}
        """
    }
}