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
    lateinit var gpu: GraphicsAdapter

    lateinit var batch: SpriteBatch
    lateinit var camera: OrthographicCamera

    lateinit var vmRunner: VMRunner

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
        //vmRunner = VMRunnerFactory(vm, "lua")
        //vmRunner.executeCommand(gpuTestPalette)
        // TEST KTS PRG
        vmRunner = VMRunnerFactory(vm, "js")
        vmRunner.executeCommand(gpuTestPaletteJs)
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

        renderGame(dt)
    }

    private var latch = true

    private fun updateGame(delta: Float) {
        // black screening workaround
        if (latch) {
            latch = false
            //paintTestPalette()
            val peripheralSlot = vm.findPeribyType(VM.PERITYPE_GRAPHICS)!!
            val hwoff = VM.HW_RESERVE_SIZE * peripheralSlot
            for (i in 250880 until 250972) {
                vm.poke(-(i + 1) - hwoff, 0)
            }
        }
    }

    fun poke(addr: Long, value: Byte) = vm.poke(addr, value)

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
            vm.poke(-(254912 + k + 1) - hwoff, -2) // white
            // text background
            vm.poke(-(254912 + 2240 + k + 1) - hwoff, -1) // transparent
            // texts
            vm.poke(-(254912 + 2240*2 + k + 1) - hwoff, Math.random().times(255).roundToInt().toByte())
        }
    }
    private val gpuTestPalette = """
local vm = require("rawmem")
local bit = require("bit32")
local w = 560
local h = 448
local hwoff = 1048576

local function inthash(x)
    local x = bit.bxor(bit.arshift(x, 16), x) * 0x45d9f3b
    x = bit.bxor(bit.arshift(x, 16), x) * 0x45d9f3b
    x = bit.bxor(bit.arshift(x, 16), x)
    return x
end

local rng = math.floor(math.random() * 2147483647)

while true do
    local tstart = os.clock()

    for y = 0, 359 do
        for x = 0, w - 1 do
            palnum = 20 * int(y / 30) + int(x / 28)
            vm.poke(-(y * w + x + 1) - hwoff, inthash(palnum + rng))
        end
    end

    for y = 360, h - 1 do
        for x = 0, w - 1 do
            palnum = 240 + int(x / 35)
            vm.poke(-(y * w + x + 1) - hwoff, palnum)
        end
    end

    for k = 0, 2239 do
        vm.poke(-(254912 + k + 1) - hwoff, 254)
        vm.poke(-(254912 + 2240 + k + 1) - hwoff, 255)
        vm.poke(-(254912 + 2240*2 + k + 1) - hwoff, math.floor(math.random() * 255.0))
    end
    
    rng = inthash(rng)
    
    local tend = os.clock()
    
    print("Apparent FPS: "..tostring(1.0 / (tend - tstart)))
end
    """.trimIndent()

    private val gpuTestPaletteKt = """
import kotlin.math.roundToInt


local w = 560
local h = 448
val hwoff = 1048576

while (true) {
    for (y in 0 until 360) {
        for (x in 0 until w) {
            val palnum = 20 * (y / 30) + (x / 28)
            poke(-(y.toLong() * w + x + 1) - hwoff, palnum.toByte())
        }
    }
    
    for (y in 360 until h) {
        for (x in 0 until w) {
            val palnum = 240 + (x / 35)
            poke(-(y.toLong() * w + x + 1) - hwoff, palnum.toByte())
        }
    }
    
    for (k in 0 until 2240) {
        poke(-(254912 + k + 1) - hwoff, -2) // white
        poke(-(254912 + 2240 + k + 1) - hwoff, -1) // transparent
        poke(-(254912 + 2240*2 + k + 1) - hwoff, Math.random().times(255).roundToInt().toByte())
    }
}
    """.trimIndent()

    private val gpuTestPaletteJs = """
var w = 560
var h = 448
var hwoff = 1048576

print(typeof print) //function
print(typeof poke.invoke) //function

function inthash(x) {
    x = ((x >> 16) ^ x) * 0x45d9f3b
    x = ((x >> 16) ^ x) * 0x45d9f3b
    x = (x >> 16) ^ x
    return x
}

var rng = Math.floor(Math.random() * 2147483647)

while (true) {

    var tstart = nanotime.invoke()

    for (var y = 0; y < 360; y++) {
        for (var x = 0; x < w; x++) {
            var palnum = 20 * Math.floor(y / 30) + Math.floor(x / 28)
            poke.invoke(-(y * w + x + 1) - hwoff, inthash(palnum + rng))
        }
    }
    
    for (var y = 360; y < h; y++) {
        for (var x = 0; x < w; x++) {
            var palnum = 240 + Math.floor(x / 35)
            poke.invoke(-(y * w + x + 1) - hwoff, palnum)
        }
    }
    
    for (var k = 0; k < 2240; k++) {
        poke.invoke(-(254912 + k + 1) - hwoff, -2) // white
        poke.invoke(-(254912 + 2240 + k + 1) - hwoff, -1) // transparent
        poke.invoke(-(254912 + 2240*2 + k + 1) - hwoff, Math.round(Math.random() * 255))
    }
    
    rng = inthash(rng)
    
    var tend = nanotime.invoke()
    
    print("Apparent FPS: " + (1000000000 / (tend - tstart)))
}

    """.trimIndent()



    private fun renderGame(delta: Float) {
        gpu.render(delta, batch, 0f, 0f)

    }


    override fun dispose() {
        super.dispose()
    }
}

const val EMDASH = 0x2014.toChar()