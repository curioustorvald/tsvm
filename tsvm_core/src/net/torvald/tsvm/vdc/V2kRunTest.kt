package net.torvald.tsvm.vdc

import com.badlogic.gdx.ApplicationAdapter
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration
import com.badlogic.gdx.graphics.OrthographicCamera
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.graphics.glutils.ShaderProgram
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import net.torvald.tsvm.*
import net.torvald.tsvm.peripheral.GraphicsAdapter

class V2kRunTest : ApplicationAdapter() {

    val vm = VM(64.kB(), TheRealWorld(), arrayOf())
    lateinit var gpu: GraphicsAdapter

    lateinit var batch: SpriteBatch
    lateinit var camera: OrthographicCamera

    lateinit var vmRunner: VMRunner

    lateinit var coroutineJob: Job
    lateinit var vdc: Videotron2K

    override fun create() {
        super.create()

        gpu = GraphicsAdapter(vm, GraphicsAdapter.DEFAULT_CONFIG_COLOR_CRT)

        vm.peripheralTable[1] = PeripheralEntry(
            gpu,
            GraphicsAdapter.VRAM_SIZE,
            16,
            0
        )

        batch = SpriteBatch()
        camera = OrthographicCamera(net.torvald.tsvm.AppLoader.WIDTH.toFloat(), net.torvald.tsvm.AppLoader.WIDTH.toFloat())
        camera.setToOrtho(false)
        camera.update()
        batch.projectionMatrix = camera.combined
        Gdx.gl20.glViewport(0, 0, net.torvald.tsvm.AppLoader.WIDTH, net.torvald.tsvm.AppLoader.HEIGHT)

        vm.getPrintStream = { gpu.getPrintStream() }
        vm.getErrorStream = { gpu.getErrorStream() }
        vm.getInputStream = { gpu.getInputStream() }

        vdc = Videotron2K(gpu)

        vmRunner = VMRunnerFactory(vm, "js")
        coroutineJob = GlobalScope.launch {
            vdc.eval(Videotron2K.screenfiller)
        }


        Gdx.input.inputProcessor = vm.getIO()
    }

    private var updateAkku = 0.0
    private var updateRate = 1f / 60f

    override fun render() {
        Gdx.graphics.setTitle("${net.torvald.tsvm.AppLoader.appTitle} $EMDASH F: ${Gdx.graphics.framesPerSecond} $EMDASH VF: ${(1.0 / vdc.statsFrameTime).toInt()}")

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

    private var latch = true

    private fun updateGame(delta: Float) {
        vm.update(delta)
    }

    private fun renderGame(delta: Float) {
        gpu.render(delta, batch, 0f, 0f)

    }

    override fun dispose() {
        super.dispose()
        batch.dispose()
        coroutineJob.cancel()
        vm.dispose()
    }
}

fun main() {
    ShaderProgram.pedantic = false

    val appConfig = Lwjgl3ApplicationConfiguration()
    appConfig.setIdleFPS(60)
    appConfig.setForegroundFPS(60)
    appConfig.useVsync(false)
    appConfig.setResizable(false)
    appConfig.setTitle("Videotron2K Test")
    appConfig.setWindowedMode(560, 448)
    Lwjgl3Application(V2kRunTest(), appConfig)
}