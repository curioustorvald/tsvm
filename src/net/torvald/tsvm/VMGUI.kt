package net.torvald.tsvm

import com.badlogic.gdx.ApplicationAdapter
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.backends.lwjgl.LwjglApplicationConfiguration
import com.badlogic.gdx.graphics.*
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import kotlinx.coroutines.*
import net.torvald.tsvm.CompressorDelegate.GZIP_HEADER
import net.torvald.tsvm.peripheral.*
import java.io.File

fun ByteArray.startsWith(other: ByteArray) = this.sliceArray(other.indices).contentEquals(other)


data class EmulInstance(
    val appConfig: LwjglApplicationConfiguration,
    val vm: VM,
    val display: String,
    val diskPath: String = "assets/disk0"
)

class VMGUI(val loaderInfo: EmulInstance) : ApplicationAdapter() {

    val appConfig = loaderInfo.appConfig
    val vm = loaderInfo.vm

    lateinit var batch: SpriteBatch
    lateinit var camera: OrthographicCamera

    lateinit var gpu: GraphicsAdapter
    lateinit var vmRunner: VMRunner
    lateinit var coroutineJob: Job
    lateinit var memvwr: Memvwr
    lateinit var fullscreenQuad: Mesh

    val usememvwr = false

    override fun create() {
        super.create()

        fullscreenQuad = Mesh(
                true, 4, 6,
                VertexAttribute.Position(),
                VertexAttribute.ColorUnpacked(),
                VertexAttribute.TexCoords(0)
        )
        updateFullscreenQuad(appConfig.width, appConfig.height)

        batch = SpriteBatch()
        camera = OrthographicCamera(appConfig.width.toFloat(), appConfig.height.toFloat())
        camera.setToOrtho(false)
        camera.update()
        batch.projectionMatrix = camera.combined


        init()
    }

    private fun init() {
        val loadedClass = Class.forName(loaderInfo.display)
        val loadedClassConstructor = loadedClass.getConstructor(vm::class.java)
        val loadedClassInstance = loadedClassConstructor.newInstance(vm)
        gpu = (loadedClassInstance as GraphicsAdapter)

        vm.getIO().blockTransferPorts[0].attachDevice(TestDiskDrive(vm, 0, File(loaderInfo.diskPath)))

        vm.peripheralTable[1] = PeripheralEntry(
            VM.PERITYPE_GPU_AND_TERM,
            gpu,
            GraphicsAdapter.VRAM_SIZE,
            16,
            0
        )

        Gdx.input.inputProcessor = vm.getIO()

        vm.getPrintStream = { gpu.getPrintStream() }
        vm.getErrorStream = { gpu.getErrorStream() }
        vm.getInputStream = { gpu.getInputStream() }

        if (usememvwr) memvwr = Memvwr(vm)


        vmRunner = VMRunnerFactory(vm, "js")
        coroutineJob = GlobalScope.launch {
            vmRunner.executeCommand(vm.roms[0]!!.readAll())
        }
    }

    private var rebootRequested = false

    private fun reboot() {
        vmRunner.close()
        coroutineJob.cancel("reboot requested")

        vm.init()
        init()
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

        val dt = Gdx.graphics.rawDeltaTime
        updateAkku += dt

        var i = 0L
        while (updateAkku >= updateRate) {
            updateGame(updateRate)
            updateAkku -= updateRate
            i += 1
        }

        renderGame(dt)
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

    private fun renderGame(delta: Float) {
        gpu.render(delta, batch, 0f, 0f)
    }

    private fun setCameraPosition(newX: Float, newY: Float) {
        camera.position.set((-newX + appConfig.width / 2), (-newY + appConfig.height / 2), 0f) // deliberate integer division
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
        super.dispose()
        batch.dispose()
        fullscreenQuad.dispose()
        coroutineJob.cancel()
        vm.dispose()
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