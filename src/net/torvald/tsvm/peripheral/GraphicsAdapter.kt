package net.torvald.tsvm.peripheral

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.AppLoader
import net.torvald.tsvm.VM
import net.torvald.tsvm.kB

class GraphicsAdapter : PeriBase {

    internal val framebuffer = Pixmap(WIDTH, HEIGHT, Pixmap.Format.RGBA8888)
    private var rendertex = Texture(1, 1, Pixmap.Format.RGBA8888)
    private val paletteOfFloats = FloatArray(1024) {
        val rgba = DEFAULT_PALETTE[it / 4]
        val channel = it % 4
        rgba.shr((3 - channel) * 8).and(255) / 255f
    }

    private val paletteShader = AppLoader.loadShaderInline(DRAW_SHADER_VERT, DRAW_SHADER_FRAG)

    private var textmodeBlinkCursor = true

    private var graphicsUseSprites = false

    private var lastUsedColour = (-1).toByte()

    init {
        framebuffer.blending = Pixmap.Blending.None
        framebuffer.setColor(-1)
        framebuffer.fill()
    }

    override fun peek(addr: Long): Byte? {
        val adi = addr.toInt()
        return when (addr) {
            in 0 until 250880 -> framebuffer.getPixel(adi % WIDTH, adi / WIDTH).toByte()
            in 261632 until 262144 -> peekPalette(adi - 261632)
            in 0 until VM.HW_RESERVE_SIZE -> peek(addr % VRAM_SIZE) // HW mirroring
            else -> null
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toInt().and(255)
        when (addr) {
            in 0 until 250880 -> {
                lastUsedColour = byte
                framebuffer.drawPixel(adi % WIDTH, adi / WIDTH, bi.shl(24))
            }
            in 261632 until 262144 -> pokePalette(adi - 261632, byte)
            in 0 until VM.HW_RESERVE_SIZE -> poke(addr % VRAM_SIZE, byte) // HW mirroring
        }
    }

    override fun mmio_read(addr: Long): Byte? {
        return when (addr) {
            0L -> (WIDTH % 256).toByte()
            1L -> (WIDTH / 256).toByte()
            2L -> (HEIGHT % 256).toByte()
            3L -> (HEIGHT / 256).toByte()
            4L -> 70
            5L -> 32
            6L -> textmodeBlinkCursor.toInt().toByte()
            7L -> graphicsUseSprites.toInt().toByte()
            8L -> lastUsedColour

            in 0 until VM.MMIO_SIZE -> -1
            else -> null
        }
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        TODO("Not yet implemented")
    }

    override fun dispose() {
        framebuffer.dispose()
        rendertex.dispose()
    }

    fun render(batch: SpriteBatch, x: Float, y: Float) {
        rendertex.dispose()
        rendertex = Texture(framebuffer)

        batch.begin()
        batch.color = Color.WHITE
        batch.shader = paletteShader
        paletteShader.setUniform4fv("pal", paletteOfFloats, 0, paletteOfFloats.size)
        // must be done every time the shader is "actually loaded"
        // try this: if above line precedes 'batch.shader = paletteShader', it won't work
        batch.draw(rendertex, x, y)
        batch.end()

        batch.shader = null
    }

    private fun peekPalette(offset: Int): Byte {
        val highvalue = paletteOfFloats[offset * 2] // R, B
        val lowvalue = paletteOfFloats[offset * 2 + 1] // G, A
        return (highvalue.div(15f).toInt().shl(4) or lowvalue.div(15f).toInt()).toByte()
    }

    private fun pokePalette(offset: Int, byte: Byte) {
        val highvalue = byte.toInt().and(0xF0).ushr(4) / 15f
        val lowvalue  = byte.toInt().and(0x0F) / 15f

        paletteOfFloats[offset * 2] = highvalue
        paletteOfFloats[offset * 2 + 1] = lowvalue
    }


    private fun Boolean.toInt() = if (this) 1 else 0

    companion object {
        const val WIDTH = 560
        const val HEIGHT = 448
        val VRAM_SIZE = 256.kB()

        val DRAW_SHADER_FRAG = """
            #version 120
            
            varying vec4 v_color;
            varying vec2 v_texCoords;
            uniform sampler2D u_texture;
            uniform vec4 pal[256];
            
            float rand(vec2 co){
                return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
            }
            
            void main(void) {
                gl_FragColor = pal[int(texture2D(u_texture, v_texCoords).r * 255.0)];
                //gl_FragColor = vec4(texture2D(u_texture, v_texCoords).rrr, 1.0);
            }
        """.trimIndent()

        val DRAW_SHADER_VERT = """
            #version 120
            
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