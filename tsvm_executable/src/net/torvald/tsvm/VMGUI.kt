package net.torvald.tsvm

import com.badlogic.gdx.ApplicationAdapter
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.graphics.*
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.graphics.g2d.TextureRegion
import com.badlogic.gdx.graphics.glutils.FrameBuffer
import com.badlogic.gdx.graphics.glutils.ShaderProgram
import net.torvald.terrarum.DefaultGL32Shaders
import net.torvald.tsvm.peripheral.*
import net.torvald.tsvm.peripheral.GraphicsAdapter.Companion.DRAW_SHADER_VERT
import java.util.*
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.*
import kotlin.system.exitProcess


class EmulInstance(
    val vm: VM,
    val display: String?,
    val diskPath: String = "assets/disk0",
    val drawWidth: Int,
    val drawHeight: Int,
) {

    var extraPeripherals: List<Pair<Int, PeripheralEntry2>> = listOf(); private set

    constructor(
        vm: VM,
        display: String?,
        diskPath: String = "assets/disk0",
        drawWidth: Int,
        drawHeight: Int,
        extraPeripherals: List<Pair<Int, PeripheralEntry2>>
    ) : this(vm, display, diskPath, drawWidth, drawHeight) {
        this.extraPeripherals = extraPeripherals
    }

}

class VMGUI(val loaderInfo: EmulInstance, val viewportWidth: Int, val viewportHeight: Int) : ApplicationAdapter() {

    val vm = loaderInfo.vm

    lateinit var batch: SpriteBatch
    lateinit var camera: OrthographicCamera

    var gpu: GraphicsAdapter? = null
    lateinit var vmRunner: VMRunner
    lateinit var coroutineJob: Thread
    lateinit var memvwr: Memvwr
    lateinit var fullscreenQuad: Mesh
    lateinit var gpuFBO: FrameBuffer
    lateinit var winFBO: FrameBuffer

    val usememvwr = false

    private lateinit var crtShader: ShaderProgram

    internal val whatToDoOnVmExceptionQueue = ArrayList<() -> Unit>()

    fun loadShaderInline(frag0: String): ShaderProgram {
        // insert version code
        val frag: String
        if (Gdx.graphics.glVersion.majorVersion >= 4) {
            frag = "#version 400\n$frag0"
        }
        else {
            frag = "#version 330\n#define fma(a,b,c) (((a)*(b))+(c))\n$frag0"
        }

        val s = ShaderProgram(DRAW_SHADER_VERT, frag)

        if (s.log.lowercase(Locale.getDefault()).contains("error")) {
            throw java.lang.Error(String.format("Shader program loaded with %s failed:\n%s", frag, s.log))
        }

        return s
    }

    override fun create() {
        super.create()

        fullscreenQuad = Mesh(
                true, 4, 6,
                VertexAttribute.Position(),
                VertexAttribute.ColorUnpacked(),
                VertexAttribute.TexCoords(0)
        )
        updateFullscreenQuad(AppLoader.WIDTH, AppLoader.HEIGHT)

        batch = SpriteBatch(1000, DefaultGL32Shaders.createSpriteBatchShader())
        camera = OrthographicCamera(AppLoader.WIDTH.toFloat(), AppLoader.HEIGHT.toFloat())
        camera.setToOrtho(false)
        camera.update()
        batch.projectionMatrix = camera.combined

        crtShader = loadShaderInline(CRT_POST_SHADER)

        gpuFBO = FrameBuffer(Pixmap.Format.RGBA8888, viewportWidth, viewportHeight, false)
        winFBO = FrameBuffer(Pixmap.Format.RGBA8888, viewportWidth, viewportHeight, false)

        init()
    }

    private fun init() {
        vm.init()

        if (loaderInfo.display != null) {
            val loadedClass = Class.forName(loaderInfo.display)
            val loadedClassConstructor = loadedClass.getConstructor(String::class.java, vm::class.java)
            val loadedClassInstance = loadedClassConstructor.newInstance("./assets", vm)
            gpu = (loadedClassInstance as GraphicsAdapter)

            vm.peripheralTable[1] = PeripheralEntry(
                gpu,
//                GraphicsAdapter.VRAM_SIZE,
//                16,
//                0
            )

            vm.getPrintStream = { gpu!!.getPrintStream() }
            vm.getErrorStream = { gpu!!.getErrorStream() }
            vm.getInputStream = { gpu!!.getInputStream() }
        }
        else {
            vm.getPrintStream = { System.out }
            vm.getErrorStream = { System.err }
            vm.getInputStream = { System.`in` }
        }

        loaderInfo.extraPeripherals.forEach { (port, peri) ->
            val typeargs = peri.args.map { it.javaClass }.toTypedArray()

            val loadedClass = Class.forName(peri.peripheralClassname)
            val loadedClassConstructor = loadedClass.getConstructor(*typeargs)
            val loadedClassInstance = loadedClassConstructor.newInstance(*peri.args)

            vm.peripheralTable[port] = PeripheralEntry(
                loadedClassInstance as PeriBase,
//                peri.memsize,
//                peri.mmioSize,
//                peri.interruptCount
            )
        }

        Gdx.input.inputProcessor = vm.getIO()

        if (usememvwr) memvwr = Memvwr(vm)


        vmRunner = VMRunnerFactory(vm.assetsDir, vm, "js")
        coroutineJob = Thread({
            try {
                vmRunner.executeCommand(vm.roms[0]!!.readAll())
            }
            catch (e: Throwable) {
                e.printStackTrace()
                whatToDoOnVmExceptionQueue.add { killVMenv() }
            }
        }, "VmRunner:${vm.id}")
        coroutineJob.start()

        vmKilled.set(0)
    }

    private val vmKilled = AtomicLong(0)

    private fun killVMenv() {
        if (vmKilled.compareAndSet(0, System.currentTimeMillis())) {
            System.err.println("VMGUI is killing VM environment...")
            vm.park()
            vm.poke(-90L, -128)
            for (i in 1 until vm.peripheralTable.size) {
                try {
                    vm.peripheralTable[i].peripheral?.dispose()
                }
                catch (_: Throwable) {
                }
            }
            coroutineJob.interrupt()
            vmRunner.close()
            vm.getPrintStream = { TODO() }
            vm.getErrorStream = { TODO() }
            vm.getInputStream = { TODO() }
        }
        else {
            System.err.println("VMGUI is NOT killing VM environment: already been killed")
        }
    }

    private var rebootRequested = false

    private fun reboot() {
        /*vmRunner.close()
        coroutineJob.interrupt()

        init()*/

        // hypervisor will take over by monitoring MMIO addr 48
    }

    private var updateAkku = 0.0
    private var updateRate = 1f / 60f

    override fun render() {
        gdxClearAndSetBlend(.094f, .094f, .094f, 0f)
        setCameraPosition(0f, 0f)

        // update window title with contents of the  'built-in status display'
        val msg = (1024L until 1048L).map { cp437toUni[vm.getIO().mmio_read(it)!!.toInt().and(255)] }.joinToString("").trim()
        Gdx.graphics.setTitle("$msg $EMDASH F: ${Gdx.graphics.framesPerSecond}")

        if (usememvwr) memvwr.update()

        super.render()

        val dt = Gdx.graphics.deltaTime
        updateAkku += dt

        var i = 0L
        while (updateAkku >= updateRate) {
            updateGame(updateRate)
            updateAkku -= updateRate
            i += 1
        }

        renderGame(dt)

        vm.watchdogs.forEach { (_, watchdog) -> watchdog.update(dt) }


        val vmExceptionHandlers = whatToDoOnVmExceptionQueue.toList()
        vmExceptionHandlers.forEach { it.invoke() }
        synchronized(whatToDoOnVmExceptionQueue) {
            vmExceptionHandlers.forEach {
                whatToDoOnVmExceptionQueue.remove(it)
            }
        }
    }

    private fun updateGame(delta: Float) {
        if (!vm.resetDown && rebootRequested) {
            reboot()
            rebootRequested = false
        }

        vm.update(delta)

        if (vm.resetDown) rebootRequested = true
    }

    fun poke(addr: Long, value: Byte) = vm.poke(addr, value)

    private val defaultGuiBackgroundColour = Color(0x444444ff)

    private var framecount = 0L

    private fun renderGame(delta: Float) {
        framecount++

        camera.setToOrtho(false, viewportWidth.toFloat(), viewportHeight.toFloat())
        batch.projectionMatrix = camera.combined
        gpuFBO.begin()
            val clearCol = gpu?.getBackgroundColour() ?: defaultGuiBackgroundColour
            Gdx.gl.glClearColor(clearCol.r, clearCol.g, clearCol.b, clearCol.a)
            Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)

            gpu?.render(
                delta, batch,
                (viewportWidth - loaderInfo.drawWidth).div(2).toFloat(),
                (viewportHeight - loaderInfo.drawHeight).div(2).toFloat(),
                flipY = true,
                uiFBO = gpuFBO
            )
        gpuFBO.end()


        camera.setToOrtho(false, viewportWidth.toFloat(), viewportHeight.toFloat())
        batch.projectionMatrix = camera.combined
        winFBO.begin()
        Gdx.gl.glClearColor(0f, 0f, 0f, 0f)
        Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)

        batch.inUse {
            batch.color = Color.WHITE

            // draw GPU and border
            batch.shader = crtShader
            batch.shader.setUniformf("resolution", viewportWidth.toFloat(), viewportHeight.toFloat())
            batch.shader.setUniformf("interlacer", (framecount % 2).toFloat())
            batch.setBlendFunctionSeparate(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA, GL20.GL_SRC_ALPHA, GL20.GL_ONE)
            batch.draw(gpuFBO.colorBufferTexture, 0f, 0f)
        }

        vm.findPeribyType("oled")?.let {
            val disp = it.peripheral as ExtDisp

            disp.render(batch,
                (viewportWidth - loaderInfo.drawWidth).div(2).toFloat() + (gpu?.config?.width ?: 0),
                (viewportHeight - loaderInfo.drawHeight).div(2).toFloat())
        }
        winFBO.end()


        camera.setToOrtho(true, viewportWidth * AppLoader.MAGN, viewportHeight * AppLoader.MAGN)
        batch.projectionMatrix = camera.combined

        Gdx.gl.glClearColor(0f, 0f, 0f, 0f)
        Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)
        batch.inUse {
            batch.shader = null
            batch.color = Color.WHITE
            batch.draw(winFBO.colorBufferTexture, 0f, 0f, viewportWidth * AppLoader.MAGN, viewportHeight * AppLoader.MAGN)
        }
    }

    private fun setCameraPosition(newX: Float, newY: Float) {
        camera.position.set((-newX + AppLoader.WIDTH / 2), (-newY + AppLoader.HEIGHT / 2), 0f) // deliberate integer division
        camera.update()
        batch.setProjectionMatrix(camera.combined)
    }

    private fun gdxClearAndSetBlend(r: Float, g: Float, b: Float, a: Float) {
        Gdx.gl.glClearColor(r,g,b,a)
        Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT)
        Gdx.gl.glEnable(GL20.GL_TEXTURE_2D)
        Gdx.gl.glEnable(GL20.GL_BLEND)
    }

    private fun updateFullscreenQuad(WIDTH: Int, HEIGHT: Int) { // NOT y-flipped quads!
        fullscreenQuad.setVertices(floatArrayOf(
                0f, 0f, 0f, 1f, 1f, 1f, 1f, 0f, 1f,
                WIDTH.toFloat(), 0f, 0f, 1f, 1f, 1f, 1f, 1f, 1f,
                WIDTH.toFloat(), HEIGHT.toFloat(), 0f, 1f, 1f, 1f, 1f, 1f, 0f,
                0f, HEIGHT.toFloat(), 0f, 1f, 1f, 1f, 1f, 0f, 0f
        ))
        fullscreenQuad.setIndices(shortArrayOf(0, 1, 2, 2, 3, 0))
    }

    override fun dispose() {
        killVMenv()
        super.dispose()
        batch.dispose()
        fullscreenQuad.dispose()
        coroutineJob.interrupt()
        crtShader.dispose()
        gpuFBO.dispose()
        winFBO.dispose()
        vm.dispose()

        System.err.println("VM disposed: ${vm.id}")
        exitProcess(0)
    }


    companion object {
        val cp437toUni = hashMapOf<Int, Char>(
            0 to 32.toChar(),
            1 to 0x263A.toChar(),
            2 to 0x263B.toChar(),
            3 to 0x2665.toChar(),
            4 to 0x2666.toChar(),
            5 to 0x2663.toChar(),
            6 to 0x2660.toChar(),
            7 to 0x2022.toChar(),
            8 to 0x25D8.toChar(),
            9 to 0x25CB.toChar(),
            10 to 0x25D9.toChar(),
            11 to 0x2642.toChar(),
            12 to 0x2640.toChar(),
            13 to 0x266A.toChar(),
            14 to 0x266B.toChar(),
            15 to 0x00A4.toChar(),

            16 to 0x25BA.toChar(),
            17 to 0x25C4.toChar(),
            18 to 0x2195.toChar(),
            19 to 0x203C.toChar(),
            20 to 0x00B6.toChar(),
            21 to 0x00A7.toChar(),
            22 to 0x25AC.toChar(),
            23 to 0x21A8.toChar(),
            24 to 0x2191.toChar(),
            25 to 0x2193.toChar(),
            26 to 0x2192.toChar(),
            27 to 0x2190.toChar(),
            28 to 0x221F.toChar(),
            29 to 0x2194.toChar(),
            30 to 0x25B2.toChar(),
            31 to 0x25BC.toChar(),

            127 to 0x2302.toChar(),

            158 to 0x2610.toChar(),
            159 to 0x2611.toChar()
        )

        init {
            for (k in 32..126) {
                cp437toUni[k] = k.toChar()
            }
        }
    }
}

const val EMDASH = 0x2014.toChar()

const val CRT_POST_SHADER = """
#ifdef GL_ES
    precision mediump float;
#endif

in vec4 v_color;
in vec4 v_generic;
in vec2 v_texCoords;
uniform sampler2D u_texture;
uniform vec2 resolution = vec2(640.0, 480.0);
out vec4 fragColor;

const vec4 scanline = vec4(0.8, 0.8, 0.8, 1.0);
const vec4 one = vec4(1.0);
const vec4 pointfive = vec4(0.5);

const mat4 rgb_to_yuv = mat4(
    0.2126, -0.09991,  0.615,   0.0,
    0.7152, -0.33609, -0.55861, 0.0,
    0.0722,  0.436,   -0.05639, 0.0,
    0.0, 0.0, 0.0, 1.0
);

const mat4 yuv_to_rgb = mat4(
    1.0,      1.0,       1.0,   0.0,
    0.0,     -0.21482, 2.12798, 0.0,
    1.28033, -0.38059, 0.0,     0.0,
    0.0, 0.0, 0.0, 1.0
);

const float CRS = 0.2;

const mat4 crosstalk_mat = mat4(
    1.0,  0.0, 0.0, 0.0,
    CRS, 1.0, 0.0, 0.0,
    CRS, 0.0, 1.0, 0.0,
    0.0,  0.0, 0.0, 1.0
);

const float gamma = 2.4;
const float blurH = 0.8;
const float blurV = 0.4;

const vec4 gradingarg = vec4(1.4, 1.1, 1.1, 1.0);

const int bayer[14 * 14] = int[](131,187,8,78,50,18,134,89,155,102,29,95,184,73,22,86,113,171,142,105,34,166,9,60,151,128,40,110,168,137,45,28,64,188,82,54,124,189,80,13,156,56,7,61,186,121,154,6,108,177,24,100,38,176,93,123,83,148,96,17,88,133,44,145,69,161,139,72,30,181,115,27,163,47,178,65,164,14,120,48,5,127,153,52,190,58,126,81,116,21,106,77,173,92,191,63,99,12,76,144,4,185,37,149,192,39,135,23,117,31,170,132,35,172,103,66,129,79,3,97,57,159,70,141,53,94,114,20,49,158,19,146,169,122,183,11,104,180,2,165,152,87,182,118,91,42,67,25,84,147,43,85,125,68,16,136,71,10,193,112,160,138,51,111,162,26,194,46,174,107,41,143,33,74,1,101,195,15,75,140,109,90,32,62,157,98,167,119,179,59,36,130,175,55,0,150);
const float bayerSize = 14.0;
const float bayerDivider = bayerSize * bayerSize;

uniform float rcount = 96.0;
uniform float gcount = 96.0;
uniform float bcount = 96.0;
uniform float acount = 1.0;

uniform float interlacer = 0.0;

vec4 toYUV(vec4 rgb) { return rgb_to_yuv * rgb; }
vec4 toRGB(vec4 ycc) { return yuv_to_rgb * ycc; }

vec4 avr(vec4 a, vec4 b, float gam) {
    return vec4(
        pow((pow(a.x, 1.0 / gam) + pow(b.x, 1.0 / gam)) / 2.0, gam),
        (a.y + b.y) / 2.0,
        (a.z + b.z) / 2.0,
        (a.w + b.w) / 2.0
    );
}

vec4 grading(vec4 col0, vec4 args) {
    vec4 vel = vec4(1.0, 1.0 / args.y, 1.0 / args.z, 1.0);
    vec4 power = vec4(args.x, args.x, args.x, 1.0);
    
    vec4 col = crosstalk_mat * col0;
    
    vec4 sgn = sign(col);
    vec4 absval = abs(col);
    vec4 raised = pow(absval, vel);
    
    vec4 rgb = toRGB(sgn * raised);
    
    return pow(rgb, power);
}

const vec4 gradLow = vec4(0.02, 0.02, 0.02, 1.0);
const vec4 gradHigh = vec4(0.12, 0.12, 0.12, 1.0);
const float SQRT_2 = 1.4142135623730950488;

vec4 getRadialGrad(vec2 uv0) {
    vec2 uv = uv0 * vec2(2.0) - one.xy; // -1..1
    float distFromOrigin = length(uv); // 0..1.4142; origin is (0,0)
    float step = 1.0 - pow(distFromOrigin / SQRT_2, 2.0);
    return mix(gradLow, gradHigh, step);
}

vec4 screen(vec4 a, vec4 b) {
    return one - (one - a) * (one - b);
}

vec4 gammaIn(vec4 col) {
    return pow(col, vec4(gamma));
}

vec4 gammaOut(vec4 col) {
    return pow(col, vec4(1.0 / gamma));
}

vec4 nearestColour(vec4 incolor) {
    vec4 rgbaCounts = vec4(rcount, gcount, bcount, acount);
    vec4 color = incolor;

    color.r = floor((rgbaCounts.r - 1.0) * color.r + 0.5) / (rgbaCounts.r - 1.0);
    color.g = floor((rgbaCounts.g - 1.0) * color.g + 0.5) / (rgbaCounts.g - 1.0);
    color.b = floor((rgbaCounts.b - 1.0) * color.b + 0.5) / (rgbaCounts.b - 1.0);
    color.a = 1.0;//floor((rgbaCounts.a - 1.0) * color.a + 0.5) / (rgbaCounts.a - 1.0);

    return color;
}

void main() {
    vec4 rgbColourIn = v_color * texture(u_texture, v_texCoords);
    vec4 rgbColourL = v_color * mix(
            texture(u_texture, v_texCoords + (vec2(-blurH, -blurV) / resolution)),
            texture(u_texture, v_texCoords + (vec2(-blurH, +blurV) / resolution)),
            0.5);
    vec4 rgbColourR = v_color * mix(
            texture(u_texture, v_texCoords + (vec2(+blurH, -blurV) / resolution)),
            texture(u_texture, v_texCoords + (vec2(+blurH, +blurV) / resolution)),
            0.5);
                
    vec4 colourIn = toYUV(rgbColourIn);
    vec4 colourL = toYUV(rgbColourL);
    vec4 colourR = toYUV(rgbColourR);
        
    vec4 LRavr = avr(colourL, colourR, gamma);
    vec4 wgtavr = avr(LRavr, colourIn, gamma);
        
    vec4 outCol = wgtavr;
    vec4 out2 = clamp(grading(outCol, gradingarg) * ((mod(gl_FragCoord.y + interlacer, 2.0) >= 1.0) ? scanline : one), 0.0, 1.0);

    // mix in CRT glass overlay
    float spread = 1.0 / (0.299 * (rcount - 1.0) + 0.587 * (gcount - 1.0) + 0.114 * (bcount - 1.0));  // this spread value is optimised one -- try your own values for various effects!
    vec4 inColor = screen(out2, getRadialGrad((gl_FragCoord - pointfive).xy / resolution));
    vec2 entry = mod((gl_FragCoord - pointfive).xy, vec2(bayerSize, bayerSize));
    fragColor = nearestColour(inColor + spread * (bayer[int(entry.y) * int(bayerSize) + int(entry.x)] / bayerDivider - 0.5));
}

"""