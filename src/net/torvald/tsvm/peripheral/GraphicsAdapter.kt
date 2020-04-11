package net.torvald.tsvm.peripheral

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.UnsafeHelper
import net.torvald.terrarumsansbitmap.gdx.TextureRegionPack
import net.torvald.tsvm.AppLoader
import net.torvald.tsvm.VM
import net.torvald.tsvm.kB
import kotlin.experimental.and

class GraphicsAdapter : PeriBase {

    internal val framebuffer = Pixmap(WIDTH, HEIGHT, Pixmap.Format.RGBA8888)
    private var rendertex = Texture(1, 1, Pixmap.Format.RGBA8888)
    private val paletteOfFloats = FloatArray(1024) {
        val rgba = DEFAULT_PALETTE[it / 4]
        val channel = it % 4
        rgba.shr((3 - channel) * 8).and(255) / 255f
    }
    private val chrrom0 = Texture("./EGA8x14.png")
    private val faketex: Texture

    private val spriteAndTextArea = UnsafeHelper.allocate(10660L)
    private val unusedArea = ByteArray(92)

    private val paletteShader = AppLoader.loadShaderInline(DRAW_SHADER_VERT, DRAW_SHADER_FRAG)
    private val textShader = AppLoader.loadShaderInline(DRAW_SHADER_VERT, TEXT_TILING_SHADER)

    private var textmodeBlinkCursor = true
    private var graphicsUseSprites = false
    private var lastUsedColour = (-1).toByte()
    private var currentChrRom = 0


    private val textForePixmap = Pixmap(TEXT_COLS, TEXT_ROWS, Pixmap.Format.RGBA8888)
    private val textBackPixmap = Pixmap(TEXT_COLS, TEXT_ROWS, Pixmap.Format.RGBA8888)
    private val textPixmap = Pixmap(TEXT_COLS, TEXT_ROWS, Pixmap.Format.RGBA8888)

    private var textForeTex = Texture(textForePixmap)
    private var textBackTex = Texture(textBackPixmap)
    private var textTex = Texture(textPixmap)



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
    }

    override fun peek(addr: Long): Byte? {
        val adi = addr.toInt()
        return when (addr) {
            in 0 until 250880 -> framebuffer.getPixel(adi % WIDTH, adi / WIDTH).toByte()
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
                framebuffer.drawPixel(adi % WIDTH, adi / WIDTH, bi.shl(24))
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

    private fun getTextmodeAttirbutes(): Byte = (currentChrRom.and(15).shl(4) or textmodeBlinkCursor.toInt()).toByte()

    private fun getGraphicsAttributes(): Byte = graphicsUseSprites.toInt().toByte()

    private fun setTextmodeAttributes(rawbyte: Byte) {
        currentChrRom = rawbyte.toInt().and(0b11110000).ushr(4)
        textmodeBlinkCursor = rawbyte.and(1) == 1.toByte()
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
        spriteAndTextArea.destroy()
        textForePixmap.dispose()
        textBackPixmap.dispose()
        textPixmap.dispose()
        paletteShader.dispose()
        textShader.dispose()
        faketex.dispose()

        try { textForeTex.dispose() } catch (_: Throwable) {}
        try { textBackTex.dispose() } catch (_: Throwable) {}

        chrrom0.dispose()
    }

    fun render(batch: SpriteBatch, x: Float, y: Float) {
        rendertex.dispose()
        rendertex = Texture(framebuffer)


        batch.begin()

        // initiialise draw
        batch.color = Color.WHITE
        batch.shader = paletteShader

        // feed palette data
        // must be done every time the shader is "actually loaded"
        // try this: if above line precedes 'batch.shader = paletteShader', it won't work
        paletteShader.setUniform4fv("pal", paletteOfFloats, 0, paletteOfFloats.size)

        // draw framebuffer
        batch.draw(rendertex, x, y)

        batch.end()


        // draw texts or sprites
        batch.begin()

        batch.color = Color.WHITE

        if (!graphicsUseSprites) {
            // draw texts

            // prepare char buffer texture
            for (y in 0 until TEXT_ROWS) {
                for (x in 0 until TEXT_COLS) {
                    val addr = y.toLong() * TEXT_COLS + x
                    val char = spriteAndTextArea[3940 + 2240 + 2240 + addr].toInt().and(255)
                    val back = spriteAndTextArea[3940 + 2240 + addr].toInt().and(255)
                    val fore = spriteAndTextArea[3940 + addr].toInt().and(255)

                    textPixmap.setColor(Color(paletteOfFloats[4 * char], paletteOfFloats[4 * char + 1], paletteOfFloats[4 * char + 2], paletteOfFloats[4 * char + 3]))
                    textPixmap.drawPixel(x, y)
                    textBackPixmap.setColor(Color(paletteOfFloats[4 * back], paletteOfFloats[4 * back + 1], paletteOfFloats[4 * back + 2], paletteOfFloats[4 * back + 3]))
                    textBackPixmap.drawPixel(x, y)
                    textForePixmap.setColor(Color(paletteOfFloats[4 * fore], paletteOfFloats[4 * fore + 1], paletteOfFloats[4 * fore + 2], paletteOfFloats[4 * fore + 3]))
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
            textShader.setUniformi("tilesAtlas", 1)
            textShader.setUniformi("foreColours", 4)
            textShader.setUniformi("backColours", 3)
            textShader.setUniformi("tilemap", 2)
            textShader.setUniformi("u_texture", 0)
            textShader.setUniformf("tilesInAxes", TEXT_COLS.toFloat(), TEXT_ROWS.toFloat())
            textShader.setUniformf("screenDimension", WIDTH.toFloat(), HEIGHT.toFloat())

            batch.draw(faketex, 0f, 0f, WIDTH.toFloat(), HEIGHT.toFloat())
        }
        else {
            // draw sprites
            batch.shader = paletteShader

            // feed palette data
            // must be done every time the shader is "actually loaded"
            // try this: if above line precedes 'batch.shader = paletteShader', it won't work
            paletteShader.setUniform4fv("pal", paletteOfFloats, 0, paletteOfFloats.size)
            TODO("sprite draw")
        }


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
        const val TEXT_COLS = 70
        const val TEXT_ROWS = 32
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

        val TEXT_TILING_SHADER = """
#version 120
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
uniform vec2 tilesInAxes; // basically a screen dimension; vec2(tiles_in_horizontal, tiles_in_vertical)

uniform sampler2D tilesAtlas;
uniform sampler2D foreColours;
uniform sampler2D backColours;
uniform sampler2D tilemap;

uniform ivec2 tilesInAtlas = ivec2(16, 16);
uniform ivec2 atlasTexSize = ivec2(128, 224);
ivec2 tileSizeInPx = atlasTexSize / tilesInAtlas; // should be like ivec2(16, 16)

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

    vec4 tileFromMap = texture2D(tilemap, flippedFragCoord / tilesInAxes); // raw tile number
    vec4 foreColFromMap = texture2D(foreColours, flippedFragCoord / tilesInAxes);
    vec4 backColFromMap = texture2D(backColours, flippedFragCoord / tilesInAxes);

    int tile = getTileFromColor(tileFromMap);
    ivec2 tileXY = getTileXY(tile);

    // cauculate the UV coord value for texture sampling //

    vec2 coordInTile = mod(flippedFragCoord, tileSizeInPx) / tileSizeInPx; // 0..1 regardless of tile position in atlas

    // don't really need highp here; read the GLES spec
    vec2 singleTileSizeInUV = vec2(1) / tilesInAtlas; // constant 0.00390625 for unmodified default uniforms

    vec2 uvCoordForTile = coordInTile * singleTileSizeInUV; // 0..0.00390625 regardless of tile position in atlas

    vec2 uvCoordOffsetTile = tileXY * singleTileSizeInUV; // where the tile starts in the atlas, using uv coord (0..1)

    // get final UV coord for the actual sampling //

    vec2 finalUVCoordForTile = (uvCoordForTile + uvCoordOffsetTile);// where we should be actually looking for in atlas, using UV coord (0..1)

    // blending a breakage tex with main tex //

    vec4 tileCol = texture2D(tilesAtlas, finalUVCoordForTile);

    // apply colour
    if (tileCol.a > 0.1) {
        gl_FragColor = foreColFromMap;
    }
    else {
        gl_FragColor = backColFromMap;
    }

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