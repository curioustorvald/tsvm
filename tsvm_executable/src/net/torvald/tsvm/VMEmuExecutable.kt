package net.torvald.tsvm

import com.badlogic.gdx.ApplicationAdapter
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.graphics.*
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import net.torvald.terrarum.FlippingSpriteBatch
import net.torvald.terrarum.imagefont.TinyAlphNum
import net.torvald.tsvm.peripheral.GraphicsAdapter
import net.torvald.tsvm.peripheral.ReferenceGraphicsAdapter2
import net.torvald.tsvm.peripheral.TestDiskDrive
import net.torvald.tsvm.peripheral.TsvmBios
import java.io.File
import java.util.*
import kotlin.collections.HashMap

/**
 * Created by minjaesong on 2022-10-22.
 */
class VMEmuExecutable(val windowWidth: Int, val windowHeight: Int, var panelsX: Int, var panelsY: Int, val diskPathRoot: String) : ApplicationAdapter() {

    private data class VMRunnerInfo(val vm: VM, val name: String)

    private val vms = arrayOfNulls<VMRunnerInfo>(this.panelsX * this.panelsY - 1) // index: # of the window where the reboot was requested

    private var currentVMselection: Int? = 0 // null: emulator menu is selected

    lateinit var batch: SpriteBatch
    lateinit var fbatch: FlippingSpriteBatch
    lateinit var camera: OrthographicCamera

    var vmRunners = HashMap<Int, VMRunner>() // <VM's identifier, VMRunner>
    var coroutineJobs = HashMap<Int, Job>() // <VM's identifier, Job>

    lateinit var fullscreenQuad: Mesh

    private lateinit var sqtex: Texture

    private lateinit var font: TinyAlphNum

    override fun create() {
        super.create()

        sqtex = Texture(Gdx.files.internal("net/torvald/tsvm/sq.tga"))

        font = TinyAlphNum

        fullscreenQuad = Mesh(
            true, 4, 6,
            VertexAttribute.Position(),
            VertexAttribute.ColorUnpacked(),
            VertexAttribute.TexCoords(0)
        )
        updateFullscreenQuad(AppLoader.WIDTH, AppLoader.HEIGHT)

        batch = SpriteBatch()
        fbatch = FlippingSpriteBatch()
        camera = OrthographicCamera(AppLoader.WIDTH.toFloat(), AppLoader.HEIGHT.toFloat())
        camera.setToOrtho(true)
        camera.update()
        batch.projectionMatrix = camera.combined
        fbatch.projectionMatrix = camera.combined


        // install the default VM on slot 0
        val vm = VM("./assets", 8192 shl 10, TheRealWorld(), arrayOf(TsvmBios), 8)
        vm.getIO().blockTransferPorts[0].attachDevice(TestDiskDrive(vm, 0, File("assets/disk0")))
        initVMenv(vm)
        vms[0] = VMRunnerInfo(vm, "Initial VM")

        val vm2 = VM("./assets", 64 shl 10, TheRealWorld(), arrayOf(TsvmBios), 8)
        vm2.getIO().blockTransferPorts[0].attachDevice(TestDiskDrive(vm2, 0, File("assets/disk0")))
        initVMenv(vm2)
        vms[1] = VMRunnerInfo(vm2, "Initial VM2")

        init()
    }

    private fun init() {
        changeActiveSession(0)
    }

    private val vmEmuInputProcessor = VMEmuInputProcessor(this)

    private fun changeActiveSession(index: Int?) {
        currentVMselection = index
        // TODO somehow implement the inputstream that cares about the currentVMselection
        Gdx.input.inputProcessor = if (currentVMselection != null) vms[currentVMselection!!]?.vm?.getIO() else vmEmuInputProcessor
    }

    private fun initVMenv(vm: VM) {
        vm.peripheralTable.getOrNull(1)?.peripheral?.dispose()

        val gpu = ReferenceGraphicsAdapter2("./assets", vm)
        vm.peripheralTable[1] = PeripheralEntry(gpu, GraphicsAdapter.VRAM_SIZE, 16, 0)

        vm.getPrintStream = { gpu.getPrintStream() }
        vm.getErrorStream = { gpu.getErrorStream() }
        vm.getInputStream = { gpu.getInputStream() }

        vmRunners[vm.id] = VMRunnerFactory(vm.assetsDir, vm, "js")
        coroutineJobs[vm.id] = GlobalScope.launch { vmRunners[vm.id]?.executeCommand(vm.roms[0]!!.readAll()) }
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

    private var updateAkku = 0.0
    private var updateRate = 1f / 60f

    override fun render() {
        gdxClearAndSetBlend(.094f, .094f, .094f, 0f)
        setCameraPosition(0f, 0f)

        // update window title with contents of the  'built-in status display'
        Gdx.graphics.setTitle("tsvm $EMDASH F: ${Gdx.graphics.framesPerSecond}")

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

    private fun reboot(vm: VM) {
        vmRunners[vm.id]!!.close()
        coroutineJobs[vm.id]!!.cancel("reboot requested")

        vm.init()
        initVMenv(vm)
    }

    private fun updateGame(delta: Float) {
        // update currently selected viewport
        val mouseX = Gdx.input.x
        val mouseY = Gdx.input.y
        if (Gdx.input.justTouched()) {
            val px = mouseX / windowWidth
            val py = mouseY / windowHeight
            val panel = py * panelsX + px

            changeActiveSession(if (panel < panelsX * panelsY - 1) panel else null)
        }

        vms.forEachIndexed { index, it ->
            if (it?.vm?.resetDown == true && index == currentVMselection) { reboot(it.vm) }
            it?.vm?.update(delta)
        }
    }

    private val defaultGuiBackgroundColour = Color(0x303039ff)

    private fun renderGame(delta: Float) {
        vms.forEachIndexed { index, vmInfo ->
            drawVMtoCanvas(delta, vmInfo?.vm, index % panelsX, index / panelsX)

            // draw Window frames and whatnot
            val xoff = (index % panelsX) * windowWidth
            val yoff = (index / panelsX) * windowHeight
            fbatch.inUse {
                it.color = if (index == currentVMselection) EmulatorGuiToolkit.Theme.COL_HIGHLIGHT else EmulatorGuiToolkit.Theme.COL_INACTIVE
                it.fillRect(xoff, yoff, windowWidth, 2)
                it.fillRect(xoff, yoff + windowHeight - 2, windowWidth, 2)
                it.fillRect(xoff, yoff, 2, windowHeight)
                it.fillRect(xoff + windowWidth - 2, yoff, 2, windowHeight)

                vmInfo?.name?.let { name ->
                    it.fillRect(xoff, yoff, (name.length + 2) * font.W, font.H)
                    it.color = if (index == currentVMselection) EmulatorGuiToolkit.Theme.COL_ACTIVE else EmulatorGuiToolkit.Theme.COL_ACTIVE2
                    font.draw(it, name, xoff + font.W.toFloat(), yoff.toFloat())
                }
            }
        }

        drawMenu(fbatch, (panelsX - 1f) * windowWidth, (panelsY - 1f) * windowHeight)
    }

    private fun drawVMtoCanvas(delta: Float, vm: VM?, pposX: Int, pposY: Int) {
        vm.let { vm ->
            // assuming the reference adapter of 560x448
            val xoff = pposX * windowWidth.toFloat()
            val yoff = pposY * windowHeight.toFloat()

            if (vm != null) {
                (vm.peripheralTable.getOrNull(1)?.peripheral as? GraphicsAdapter).let { gpu ->
                    if (gpu != null) {
                        val clearCol = gpu.getBackgroundColour()
                        // clear the viewport by drawing coloured rectangle becausewhynot
                        fbatch.color = clearCol
                        fbatch.inUse {
                            fbatch.fillRect(pposX * windowWidth, pposY * windowHeight, windowWidth, windowHeight)
                        }

                        gpu.render(delta, fbatch, xoff + 40f, yoff + 16f, false, null)
                    }
                    else {
                        // no graphics device available
                        fbatch.inUse {
                            fbatch.color = defaultGuiBackgroundColour
                            fbatch.fillRect(pposX * windowWidth, pposY * windowHeight, windowWidth, windowHeight)
                            // draw text
                            fbatch.color = EmulatorGuiToolkit.Theme.COL_INACTIVE
                            font.draw(fbatch, "no graphics device available", xoff + (windowWidth - 196) / 2, yoff + (windowHeight - 12) / 2)
                        }
                    }
                }
            }
            else {
                // no vm on the viewport
                fbatch.inUse {
                    fbatch.color = defaultGuiBackgroundColour
                    fbatch.fillRect(pposX * windowWidth, pposY * windowHeight, windowWidth, windowHeight)
                    // draw text
                    fbatch.color = EmulatorGuiToolkit.Theme.COL_INACTIVE
                    font.draw(fbatch, "no vm on this viewport", xoff + (windowWidth - 154) / 2, yoff + (windowHeight - 12) / 2)
                }
            }
        }
    }

    private fun resizePanel(panelsX: Int, panelsY: Int) {
        if (panelsX > 16 || panelsY > 16) throw IllegalArgumentException("Panel count too large: ($panelsX, $panelsY)")
        if (panelsX * panelsY <= 0) throw IllegalArgumentException("Illegal panel count: ($panelsX, $panelsY)")
        this.panelsX = panelsX
        this.panelsY = panelsY
        resize(windowWidth * panelsX, windowHeight * panelsY)
    }

    override fun resize(width: Int, height: Int) {
        super.resize(width, height)

        updateFullscreenQuad(width, height)

        camera.setToOrtho(true, width.toFloat(), height.toFloat())
        camera.update()
        batch.projectionMatrix = camera.combined
        fbatch.projectionMatrix = camera.combined
    }

    override fun dispose() {
        super.dispose()
        sqtex.dispose()
        batch.dispose()
        fbatch.dispose()
        fullscreenQuad.dispose()
        coroutineJobs.values.forEach { it.cancel() }
        vms.forEach { it?.vm?.dispose() }
    }

    fun SpriteBatch.fillRect(x: Int, y: Int, w: Int, h: Int) = this.draw(sqtex, x.toFloat(), y.toFloat(), w.toFloat(), h.toFloat())
    fun SpriteBatch.fillRect(x: Float, y: Float, w: Float, h: Float) = this.draw(sqtex, x, y, w, h)
    fun SpriteBatch.fillRect(x: Int, y: Int, w: Float, h: Float) = this.draw(sqtex, x.toFloat(), y.toFloat(), w, h)
    fun SpriteBatch.fillRect(x: Float, y: Float, w: Int, h: Int) = this.draw(sqtex, x, y, w.toFloat(), h.toFloat())

    fun SpriteBatch.inUse(f: (SpriteBatch) -> Unit) {
        this.begin()
        f(this)
        this.end()
    }

    private val menuTabs = listOf("Machine", "Peripherals", "Cards")
    private val tabPos = (menuTabs + "").mapIndexed { index, _ -> 1 + menuTabs.subList(0, index).sumBy { it.length } + 2 * index }
    private var menuTabSel = 0

    private fun drawMenu(batch: SpriteBatch, x: Float, y: Float) {
        batch.inUse {
            // draw the tab
            for (k in menuTabs.indices) {

                val textX = x + font.W * tabPos[k]

                if (k == menuTabSel) {
                    batch.color = EmulatorGuiToolkit.Theme.COL_HIGHLIGHT
                    batch.fillRect(textX - font.W, y, font.W * (menuTabs[k].length + 2f), font.H.toFloat())

                    batch.color = EmulatorGuiToolkit.Theme.COL_ACTIVE
                    font.draw(batch, menuTabs[k], textX, y)
                }
                else {
                    batch.color = EmulatorGuiToolkit.Theme.COL_INACTIVE
                    batch.fillRect(textX - font.W, y, font.W * (menuTabs[k].length + 2f), font.H.toFloat())

                    batch.color = EmulatorGuiToolkit.Theme.COL_ACTIVE2
                    font.draw(batch, menuTabs[k], textX, y)
                }
            }
            // tab edge
            batch.color = EmulatorGuiToolkit.Theme.COL_INACTIVE2
            val edgeX = x + (tabPos.last() - 1) * font.W
            val edgeW = windowWidth - (tabPos.last() - 1) * font.W
            batch.fillRect(edgeX, y, edgeW, font.H)

            // draw the window frame inside the tab
            batch.color = defaultGuiBackgroundColour
            batch.fillRect(x, y + font.H, windowWidth, windowHeight - font.H)
            batch.color = EmulatorGuiToolkit.Theme.COL_HIGHLIGHT
            batch.fillRect(x, y + font.H, windowWidth.toFloat(), 2f)
            batch.fillRect(x, y + windowHeight - 2f, windowWidth.toFloat(), 2f)
            batch.fillRect(x, y + font.H, 2f, windowHeight - font.H - 2f)
            batch.fillRect(x + windowWidth - 2f, y + font.H, 2f, windowHeight - font.H - 2f)
        }
    }
}

object EmulatorGuiToolkit {

    object Theme {
        val COL_INACTIVE = Color(0x858585ff.toInt())
        val COL_INACTIVE2 = Color(0x5a5a5fff.toInt())
        val COL_ACTIVE = Color(0x23ff00ff.toInt()) // neon green
        val COL_ACTIVE2 = Color(0xfff600ff.toInt()) // yellow
        val COL_HIGHLIGHT = Color(0xe43380ff.toInt()) // magenta
        val COL_DISABLED = Color(0xaaaaaaff.toInt())
    }

}