package net.torvald.tsvm

import com.badlogic.gdx.ApplicationAdapter
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.backends.lwjgl.LwjglApplicationConfiguration
import com.badlogic.gdx.graphics.OrthographicCamera
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.peripheral.GraphicsAdapter
import kotlin.math.roundToInt

class VMGUI(val appConfig: LwjglApplicationConfiguration) : ApplicationAdapter() {

    val vm = VM(8192)
    val vmLua = VMLuaAdapter(vm)
    lateinit var gpu: GraphicsAdapter

    lateinit var batch: SpriteBatch
    lateinit var camera: OrthographicCamera

    override fun create() {
        super.create()

        gpu = GraphicsAdapter()

        vm.peripheralTable[1] = PeripheralEntry(
            VM.PERITYPE_GRAPHICS,
            gpu,
            256.kB(),
            16,
            0
        )

        batch = SpriteBatch()
        camera = OrthographicCamera(appConfig.width.toFloat(), appConfig.height.toFloat())
        camera.setToOrtho(false)
        camera.update()
        batch.projectionMatrix = camera.combined
        Gdx.gl20.glViewport(0, 0, appConfig.width, appConfig.height)


        // TEST LUA PRG
        //vmLua.lua.load(gpuTestPalette).call()
    }

    private var updateAkku = 0.0
    private var updateRate = 1f / 60f

    override fun render() {
        Gdx.graphics.setTitle("${AppLoader.appTitle} $EMDASH F: ${Gdx.graphics.framesPerSecond}")

        super.render()

        val dt = Gdx.graphics.rawDeltaTime
        updateAkku += dt

        var i = 0L
        while (updateAkku >= updateRate) {
            updateGame(updateRate)
            updateAkku -= updateRate
            i += 1
        }

        renderGame()
    }

    private fun updateGame(delta: Float) {
        paintTestPalette()
    }

    private fun paintTestPalette() {
        val peripheralSlot = vm.findPeribyType(VM.PERITYPE_GRAPHICS)!!
        val hwoff = VM.HW_RESERVE_SIZE * peripheralSlot

        for (y in 0 until 360) {
            for (x in 0 until GraphicsAdapter.WIDTH) {
                val palnum = 20 * (y / 30) + (x / (GraphicsAdapter.WIDTH / 20))
                vm.poke(-(y.toLong() * GraphicsAdapter.WIDTH + x + 1) - hwoff, palnum.toByte())
            }
        }

        for (y in 360 until GraphicsAdapter.HEIGHT) {
            for (x in 0 until GraphicsAdapter.WIDTH) {
                val palnum = 240 + (x / 35)
                vm.poke(-(y.toLong() * GraphicsAdapter.WIDTH + x + 1) - hwoff, palnum.toByte())
            }
        }

        //vm.poke(-262143L - hwoff, Math.random().times(255.0).toByte())
        //vm.poke(-262144L - hwoff, Math.random().times(255.0).toByte())

        for (k in 0 until 2240) {
            // text foreground
            vm.poke(-(254912 + k + 1) - hwoff, (Math.random().times(255f).roundToInt()).toByte()) // white
            // text background
            vm.poke(-(254912 + 2240 + k + 1) - hwoff, (Math.random().times(255f).roundToInt()).toByte()) // transparent
            // texts
            vm.poke(-(254912 + 2240*2 + k + 1) - hwoff, (Math.random().times(255f).roundToInt()).toByte())
        }
    }

    private val gpuTestPalette = """
        local vm = require("rawmem")
        local w = 560
        local h = 448
        local hwoff = 1048576

        for y = 0, 359 do
            for x = 0, w - 1 do
                palnum = 20 * int(y / 30) + int(x / 28)
                vm.poke(-(y * w + x + 1) - hwoff, palnum)
            end
        end

        for y = 360, h - 1 do
            for x = 0, w - 1 do
                palnum = 240 + int(x / 35)
                vm.poke(-(y * w + x + 1) - hwoff, palnum)
            end
        end

        vm.poke(-262143 - hwoff, math.floor(math.random() * 255.0))
        vm.poke(-262144 - hwoff, math.floor(math.random() * 255.0))
    """.trimIndent()

    private fun renderGame() {
        gpu.render(batch, 0f, 0f)

    }


    override fun dispose() {
        super.dispose()
    }
}

const val EMDASH = 0x2014.toChar()