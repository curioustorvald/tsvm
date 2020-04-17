package net.torvald.tsvm

import com.badlogic.gdx.ApplicationAdapter
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.backends.lwjgl.LwjglApplicationConfiguration
import com.badlogic.gdx.graphics.OrthographicCamera
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.peripheral.GraphicsAdapter

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
        vmRunner = VMRunnerFactory(vm, "kts")
        vmRunner.executeCommand(gpuTestPaletteKt)
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
    }

    private val gpuTestPaletteKt = """
val w = 560
val h = 448
val hwoff = 1048576

fun inthash(x: Int): Int {
    var x = (x.shr(16) xor x) * 0x45d9f3b
    x = (x.shr(16) xor x) * 0x45d9f3b
    x = (x.shr(16) xor x)
    return x
}

var rng = (Math.floor(Math.random() * 2147483647) + 1).toInt()

bindings.forEach {
    println(it)
}

println(zzz)

while (true) {
    val tstart: Long = System.nanoTime()
    for (y1 in 0..359) {
        for (x1 in 0 until w) {
            val palnum = 20 * (y1 / 30) + (x1 / 28)
            vm.poke(-(y1 * w + x1 + 1L) - hwoff, inthash(palnum + rng).toByte())
        }
    }
    for (y2 in 360 until h) {
        for (x2 in 0 until w) {
            val palnum = 240 + x2 / 35
            vm.poke(-(y2 * w + x2 + 1L) - hwoff, palnum.toByte())
        }
    }
    for (k in 0..2239) {
        vm.poke(-(254912L + k + 1) - hwoff, -2) // white
        vm.poke(-(254912L + 2240 + k + 1) - hwoff, -1) // transparent
        vm.poke(-(254912L + 2240 * 2 + k + 1) - hwoff, Math.round(Math.random() * 255).toByte())
    }
    
    rng = inthash(rng)
    val tend: Long = System.nanoTime()
    println("Apparent FPS: " + 1000000000.0 / (tend - tstart))
}
    """.trimIndent()

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
    local tstart = vm.nanotime()

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
    
    local tend = vm.nanotime()
    
    print("Apparent FPS: "..tostring(1000000000.0 / (tend - tstart)))
end
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

var rng = Math.floor(Math.random() * 2147483647) + 1

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

    private val gpuTestPaletteJava = """
int w = 560;
int h = 448;
int hwoff = 1048576;

int inthash(double x) {
    return inthash((int) x);
}

int inthash(int x) {
    x = ((x >> 16) ^ x) * 0x45d9f3b;
    x = ((x >> 16) ^ x) * 0x45d9f3b;
    x = (x >> 16) ^ x;
    return x;
}

int rng = Math.floor(Math.random() * 2147483647) + 1;

while (true) {

    long tstart = nanotime.invoke();

    for (int y1 = 0; y1 < 360; y1++) {
        for (int x1 = 0; x1 < w; x1++) {
            int palnum = 20 * (y1 / 30) + (x1 / 28);
            poke.invoke(-(y1 * w + x1 + 1) - hwoff, inthash(palnum + rng));
        }
    }
    
    for (int y2 = 360; y2 < h; y2++) {
        for (int x2 = 0; x2 < w; x2++) {
            int palnum = 240 + x2 / 35;
            poke.invoke(-(y2 * w + x2 + 1) - hwoff, palnum);
        }
    }
    
    for (int k = 0; k < 2240; k++) {
        poke.invoke(-(254912 + k + 1) - hwoff, -2); // white
        poke.invoke(-(254912 + 2240 + k + 1) - hwoff, -1); // transparent
        poke.invoke(-(254912 + 2240*2 + k + 1) - hwoff, Math.round(Math.random() * 255));
    }
    
    rng = inthash(rng);
    
    long tend = nanotime.invoke();
    
    System.out.println("Apparent FPS: " + (1000000000.0 / (tend - tstart)));
}

    """.trimIndent()


    private val gpuTestPalettePy = """
import math
import random
        
w = 560
h = 448
hwoff = 1048576


def inthash(x):
    x = ((x >> 16) ^ x) * 0x45d9f3b
    x = ((x >> 16) ^ x) * 0x45d9f3b
    x = (x >> 16) ^ x
    return x

rng = random.randint(1, 2147483647)

while True:

    tstart = nanotime.invoke()

    for y1 in range(0, 360):
        for x1 in range(0, w):
            palnum = 20 * int(y1 / 30) + int(x1 / 28)
            poke.invoke(-(y1 * w + x1 + 1) - hwoff, inthash(palnum + rng))
        
    for y2 in range(360, h):
        for x2 in range(0, w):
            palnum = 240 + int(x2 / 35)
            poke.invoke(-(y2 * w + x2 + 1) - hwoff, palnum)
    
    for k in range(0, 2240):
        poke.invoke(-(254912 + k + 1) - hwoff, -2)
        poke.invoke(-(254912 + 2240 + k + 1) - hwoff, -1)
        poke.invoke(-(254912 + 2240*2 + k + 1) - hwoff, random.randint(0, 255))
    
    rng = inthash(rng)
    
    tend = nanotime.invoke()
    
    print("Apparent FPS: " + str(1000000000.0 / (tend - tstart)))

    """.trimIndent()


    private fun renderGame(delta: Float) {
        gpu.render(delta, batch, 0f, 0f)

    }


    override fun dispose() {
        super.dispose()
    }
}

const val EMDASH = 0x2014.toChar()