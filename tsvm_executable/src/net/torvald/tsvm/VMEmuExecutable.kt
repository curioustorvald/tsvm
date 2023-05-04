package net.torvald.tsvm

import com.badlogic.gdx.ApplicationAdapter
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.Input.Buttons
import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.graphics.*
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import net.torvald.terrarum.DefaultGL32Shaders
import net.torvald.terrarum.FlippingSpriteBatch
import net.torvald.terrarum.imagefont.TinyAlphNum
import net.torvald.terrarum.utils.JsonFetcher
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.SQTEX
import net.torvald.tsvm.peripheral.*
import java.io.File
import kotlin.system.exitProcess

class VMEmuExecutableWrapper(val windowWidth: Int, val windowHeight: Int, var panelsX: Int, var panelsY: Int, val diskPathRoot: String) : ApplicationAdapter() {

    private lateinit var executable: VMEmuExecutable

    companion object {
        lateinit var SQTEX: Texture; private set
        lateinit var FONT: TinyAlphNum; private set
    }

    override fun create() {
        FONT = TinyAlphNum
        SQTEX = Texture(Gdx.files.internal("net/torvald/tsvm/sq.tga"))
        executable = VMEmuExecutable(windowWidth, windowHeight, panelsX, panelsY, diskPathRoot)
        executable.create()
    }

    override fun resize(width: Int, height: Int) {
        executable.resize(width, height)
    }

    override fun render() {
        executable.render()
    }

    override fun pause() {
        executable.pause()
    }

    override fun resume() {
        executable.resume()
    }

    override fun dispose() {
//        println("App Dispose")
        executable.dispose()
        SQTEX.dispose()
        exitProcess(1)
    }
}


/**
 * Created by minjaesong on 2022-10-22.
 */
class VMEmuExecutable(val windowWidth: Int, val windowHeight: Int, var panelsX: Int, var panelsY: Int, val diskPathRoot: String) : ApplicationAdapter() {

    val TEVD_COMMIT = TevdPartialDomCommitWatchdog
    val TEVD_SYNC = TevdPartialDomCommitWatchdog

    val watchdogs = hashMapOf<String, VMWatchdog>(
        "TEVD_COMMIT" to TEVD_COMMIT,
        "TEVD_SYNC" to TEVD_SYNC
    )

    data class VMRunnerInfo(val vm: VM, val profileName: String)

    private val vms = arrayOfNulls<VMRunnerInfo>(this.panelsX * this.panelsY - 1) // index: # of the window where the reboot was requested

    var currentVMselection: Int? = 0 // null: emulator menu is selected

    lateinit var batch: SpriteBatch
    lateinit var fbatch: FlippingSpriteBatch
    lateinit var camera: OrthographicCamera

    var vmRunners = HashMap<VmId, VMRunner>() // <VM's identifier, VMRunner>
    var coroutineJobs = HashMap<VmId, Thread>() // <VM's identifier, Job>

    companion object {
        val APPDATADIR = TsvmEmulator.defaultDir

        val FILE_CONFIG = Gdx.files.absolute(TsvmEmulator.configDir)
        val FILE_PROFILES = Gdx.files.absolute(TsvmEmulator.profilesDir)
    }

    val fullscreenQuad = Mesh(
        true, 4, 6,
        VertexAttribute.Position(),
        VertexAttribute.ColorUnpacked(),
        VertexAttribute.TexCoords(0)
    )

    val profiles = HashMap<String, JsonValue>()

    private val currentlyLoadedProfiles = HashMap<String, VM>()
    internal fun getVMbyProfileName(name: String): VM? {
        if (profiles.containsKey(name)) {
            return currentlyLoadedProfiles.getOrPut(name) { makeVMfromJson(profiles[name]!!, name) }
        }
        else
            return null
    }

    internal fun getViewportForTheVM(vm: VM?): Int? = if (vm == null) null else vms.indexOfFirst { vm.id == it?.vm?.id }.let { if (it < 0) null else it }

    internal fun moveView(oldIndex: Int, newIndex: Int?) {
        if (oldIndex != newIndex) {
            if (newIndex != null) {
                vms[newIndex] = vms[oldIndex]
            }
            vms[oldIndex] = null
        }
    }

    internal fun addVMtoView(vm: VM, profileName: String, index: Int) {
        vms[index] = VMRunnerInfo(vm, profileName)
    }

    internal fun getCurrentlySelectedVM(): VMRunnerInfo? = if (currentVMselection == null) null else vms[currentVMselection!!]
    internal var currentlyPersistentVM: VMRunnerInfo? = null
        get() {
            if (currentVMselection != null) { field = vms[currentVMselection!!] }
            return field
        }
        private set

    private fun writeProfilesToFile(outFile: FileHandle) {
        val out = StringBuilder()
        out.append('{')

        profiles.forEach { name, jsonValue ->
            out.append("\"$name\":")
            out.append(jsonValue.toJson(JsonWriter.OutputType.json))
            out.append(",")
            println("[VMEmuExecutable] wrote VM profile $name")
        }

        out.deleteCharAt(out.lastIndex).append('}')

        val outstr = out.toString()

        outFile.writeString(outstr, false)
    }


    override fun create() {
        super.create()

        updateFullscreenQuad(TsvmEmulator.WIDTH, TsvmEmulator.HEIGHT)

        batch = SpriteBatch(1000, DefaultGL32Shaders.createSpriteBatchShader())
        fbatch = FlippingSpriteBatch()
        camera = OrthographicCamera(TsvmEmulator.WIDTH.toFloat(), TsvmEmulator.HEIGHT.toFloat())
        camera.setToOrtho(true)
        camera.update()
        batch.projectionMatrix = camera.combined
        fbatch.projectionMatrix = camera.combined


        // create profiles.json if the file is not there
        if (!FILE_PROFILES.exists()) {
            FILE_PROFILES.writeString("{${defaultProfile}}", false)
            println("[VMEmuExecutable] creating new profile.json")
        }
        // read profiles
        JsonFetcher(FILE_PROFILES.file()).let {
            JsonFetcher.forEachSiblings(it) { profileName, profileJson ->
                profiles[profileName] = profileJson
                println("[VMEmuExecutable] read VM profile $profileName")
            }
        }


        // install the default VM on slot 0
        /*val vm = VM("./assets", 8192 shl 10, TheRealWorld(), arrayOf(TsvmBios), 8)
        vm.getIO().blockTransferPorts[0].attachDevice(TestDiskDrive(vm, 0, File("assets/disk0")))
        initVMenv(vm)
        vms[0] = VMRunnerInfo(vm, "Initial VM")*/

        val vm1 = getVMbyProfileName("Initial VM")!!
        initVMenv(vm1, "Initial VM")
        vms[0] = VMRunnerInfo(vm1, "Initial VM")

        init()
    }

    private fun init() {
        changeActiveSession(0)
    }

    private val vmEmuInputProcessor = VMEmuInputProcessor(this)

    private fun changeActiveSession(index: Int?) {
        currentVMselection = index
        // TODO somehow implement the inputstream that cares about the currentVMselection
        Gdx.input.inputProcessor = if (currentVMselection != null) vms[currentVMselection!!]?.vm?.getIO() ?: null else vmEmuInputProcessor

        refreshCardTabs()
        refreshComTabs()
    }

    internal fun initVMenv(vm: VM, profileName: String) {
        val gpu = ReferenceGraphicsAdapter2("./assets", vm)
        VMSetupBroker.initVMenv(vm, profiles[profileName]!!, profileName, gpu, vmRunners, coroutineJobs) {
            it.printStackTrace()
            VMSetupBroker.killVMenv(vm, vmRunners, coroutineJobs)
        }
    }

    internal fun killVMenv(vm: VM) {
        VMSetupBroker.killVMenv(vm, vmRunners, coroutineJobs)
    }

    private fun setCameraPosition(newX: Float, newY: Float) {
        camera.position.set((-newX + TsvmEmulator.WIDTH / 2), (-newY + TsvmEmulator.HEIGHT / 2), 0f) // deliberate integer division
        camera.update()
        batch.projectionMatrix = camera.combined
        fbatch.projectionMatrix = camera.combined
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

        val dt = Gdx.graphics.deltaTime
        updateAkku += dt

        var i = 0L
        while (updateAkku >= updateRate) {
            updateGame(updateRate)
            updateAkku -= updateRate
            i += 1
        }

        renderGame(dt)

        watchdogs.forEach { (_, watchdog) -> watchdog.update(dt) }
    }

    private fun reboot(profileName: String) {
        val vm = currentlyLoadedProfiles[profileName]!!

        vmRunners[vm.id]!!.close()
        coroutineJobs[vm.id]!!.interrupt()

        vm.init()
        initVMenv(vm, profileName)
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
            if (it?.vm?.resetDown == true && index == currentVMselection) { reboot(it.profileName) }
            if (it?.vm?.isRunning == true) it?.vm?.update(delta)
        }

        updateMenu()
    }

    val defaultGuiBackgroundColour = Color(0x303039ff)

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

                vmInfo?.profileName?.let { name ->
                    it.fillRect(xoff, yoff, (name.length + 2) * FONT.W, FONT.H)
                    it.color = if (index == currentVMselection) EmulatorGuiToolkit.Theme.COL_ACTIVE else EmulatorGuiToolkit.Theme.COL_ACTIVE4
                    FONT.draw(it, name, xoff + FONT.W.toFloat(), yoff.toFloat())
                }
            }
        }

        drawMenu(fbatch, (panelsX - 1f) * windowWidth, (panelsY - 1f) * windowHeight)
    }

    private fun drawVMtoCanvas(delta: Float, vm: VM?, pposX: Int, pposY: Int) {
        // assuming the reference adapter of 560x448
        val xoff = pposX * windowWidth.toFloat()
        val yoff = pposY * windowHeight.toFloat()

        if (vm != null) {
            (vm.peripheralTable.getOrNull(1)?.peripheral as? GraphicsAdapter).let { gpu ->
                if (gpu != null && !vm.isRunning) {
                    // vm has stopped
                    fbatch.inUse {
                        fbatch.color = defaultGuiBackgroundColour
                        fbatch.fillRect(pposX * windowWidth, pposY * windowHeight, windowWidth, windowHeight)
                        // draw text
                        fbatch.color = EmulatorGuiToolkit.Theme.COL_INACTIVE
                        FONT.draw(fbatch, "vm is not running", xoff + (windowWidth - 119) / 2, yoff + (windowHeight - 12) / 2)
                    }
                }
                else if (gpu != null) {
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
                        FONT.draw(fbatch, "no graphics device available", xoff + (windowWidth - 196) / 2, yoff + (windowHeight - 12) / 2)
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
                FONT.draw(fbatch, "no vm on this viewport", xoff + (windowWidth - 154) / 2, yoff + (windowHeight - 12) / 2)
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
        tabs.forEach { it.dispose() }
        batch.dispose()
        fbatch.dispose()
        fullscreenQuad.dispose()
        coroutineJobs.values.forEach { it.interrupt() }
        vms.forEach { it?.vm?.dispose() }

        writeProfilesToFile(Gdx.files.absolute("$APPDATADIR/profiles.json"))
    }

    private val menuTabW = windowWidth - 4
    private val menuTabH = windowHeight - 4 - FONT.H
    private val menuTabX = windowWidth * (panelsX-1) + 2
    private val menuTabY =windowHeight * (panelsY-1) + FONT.H + 2

    private val dummyMenu = DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH)
    private val menuRepository = mapOf(
        VM.PERITYPE_SOUND to AudioMenu(this, menuTabX, menuTabY, menuTabW, menuTabH),
        "TevdDiskDrive" to TevdMenu(this, menuTabX, menuTabY, menuTabW, menuTabH),
        "DUMMY" to dummyMenu
    )

    private val menuTabs = listOf("Profiles", "MMIO", "MMU", "COM1", "COM2", "COM3", "COM4", "Crd1", "Crd2", "Crd3", "Crd4", "Crd5", "Crd6", "Crd7")
    private val tabPos = (menuTabs + "").mapIndexed { index, _ -> 1 + menuTabs.subList(0, index).sumBy { it.length } + 2 * index }
    private val tabs = arrayOf(
        ProfilesMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // Profiles
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // MMIO
        MMUMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // MMU
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // COM1
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // COM2
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // COM3
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // COM4
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // Card1
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // Card2
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // Card3
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // Card4
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // Card5
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // Card6
        DummyMenu(this, menuTabX, menuTabY, menuTabW, menuTabH), // Card7
    )
    private var menuTabSel = 0

    private val cardTabIndex = menuTabs.indexOf("Crd1")
    private val comTabIndex = menuTabs.indexOf("COM1")

    private var tabChangeRequested: Int? = 0 // null: not requested

    // call this whenever the VM selection has changed
    private fun refreshCardTabs() {
        val vm = getCurrentlySelectedVM()?.vm

        if (vm != null) {
            for (i in 1..7) {
                val periType = vm.peripheralTable[i].type ?: "DUMMY"
                val menu = menuRepository[periType] ?: dummyMenu
                menu.cardIndex = i
                tabs[cardTabIndex + i - 1] = menu
//                println("Tabs[${cardTabIndex + i - 1}] = $periType")
            }
        }
    }
    // call this whenever the VM selection has changed
    private fun refreshComTabs() {
        val vm = getCurrentlySelectedVM()?.vm

        if (vm != null) {
            for (i in 0..3) {
                val periType = vm.getIO().blockTransferPorts[i].recipient?.javaClass?.simpleName ?: "DUMMY"
                val menu = menuRepository[periType] ?: dummyMenu
                menu.cardIndex = i // COM will recycle cardIndex
                tabs[comTabIndex + i] = menu
//                println("Tabs[${comTabIndex + i}] = $periType")
            }
        }
    }

    private fun drawMenu(batch: SpriteBatch, x: Float, y: Float) {
        if (tabChangeRequested != null) {
            tabs[menuTabSel].hide()
            tabs[tabChangeRequested!!].show()
            menuTabSel = tabChangeRequested!!
            tabChangeRequested = null
        }

        batch.inUse {
            // background for the entire area
            batch.color = defaultGuiBackgroundColour
            batch.fillRect(x, y, windowWidth, windowHeight)

            // draw the tab
            for (k in menuTabs.indices) {

                val textX = x + FONT.W * tabPos[k]

                if (k == menuTabSel) {
                    batch.color = EmulatorGuiToolkit.Theme.COL_HIGHLIGHT
                    batch.fillRect(textX - FONT.W, y, FONT.W * (menuTabs[k].length + 2f), FONT.H.toFloat())

                    batch.color = EmulatorGuiToolkit.Theme.COL_ACTIVE
                    FONT.draw(batch, menuTabs[k], textX, y)
                }
                else {
                    batch.color = if (k % 2 == 0) EmulatorGuiToolkit.Theme.COL_TAB_NOT_SELECTED else EmulatorGuiToolkit.Theme.COL_TAB_NOT_SELECTED2
                    batch.fillRect(textX - FONT.W, y, FONT.W * (menuTabs[k].length + 2f), FONT.H.toFloat())

                    batch.color = EmulatorGuiToolkit.Theme.COL_ACTIVE4
                    FONT.draw(batch, menuTabs[k], textX, y)
                }
            }

            // draw the window frame inside the tab
            batch.color = EmulatorGuiToolkit.Theme.COL_LAND
            batch.fillRect(x, y + FONT.H, windowWidth, windowHeight - FONT.H)
            batch.color = EmulatorGuiToolkit.Theme.COL_HIGHLIGHT
            batch.fillRect(x, y + FONT.H, windowWidth.toFloat(), 2f)
            batch.fillRect(x, y + windowHeight - 2f, windowWidth.toFloat(), 2f)
            batch.fillRect(x, y + FONT.H, 2f, windowHeight - FONT.H - 2f)
            batch.fillRect(x + windowWidth - 2f, y + FONT.H, 2f, windowHeight - FONT.H - 2f)
        }

        setCameraPosition(menuTabX.toFloat(), menuTabY.toFloat())
        tabs[menuTabSel].render(batch)
    }

    private fun updateMenu() {
        // update the tab
        var tabSelected = -1
        val x = (panelsX - 1) * windowWidth
        val y = (panelsY - 1) * windowHeight
        val mx = Gdx.input.x
        val my = Gdx.input.y
        if (Gdx.input.isButtonPressed(Buttons.LEFT) && my in y until y + FONT.H) {
            for (k in menuTabs.indices) {
                val textX = x + FONT.W * tabPos[k]
                if (mx in textX - FONT.W until textX - FONT.W + FONT.W * (menuTabs[k].length + 2)) {
                    tabSelected = k
                }
            }
        }
        if (tabSelected >= 0 && tabSelected != menuTabSel) {
            tabChangeRequested = tabSelected
        }

        // actually update the view within the tabs
        tabs[menuTabSel].update()
    }

    /**
     * - changing card1 does nothing! -- right now the emulator does not support using a Display Adapter other than the stock one.
     * - I still get a display when I missed the card1? -- card1 is substituted with the stock Display Adapter if the entry is missing.
     */
    private val defaultProfile = """
        "Initial VM": {
            "assetsdir":"./assets",
            "ramsize":8388608,
            "cardslots":8,
            "roms":["./assets/bios/tsvmbios.js"],
            "com1":{"cls":"net.torvald.tsvm.peripheral.TestDiskDrive", "args":[0, "./assets/disk0/"]},
            "com2":{"cls":"net.torvald.tsvm.peripheral.HttpModem", "args":[1024, -1]},
            "card4":{"cls":"net.torvald.tsvm.peripheral.RamBank", "args":[256]}
        }
    """.trimIndent()

    /**
     * You'll want to further init the things using the VM this function returns, such as:
     *
     * ```
     * makeVMfromJson(json.get(NAME)).let{
     *      initVMemv(it)
     *      vms[VIEWPORT_INDEX] = VMRunnerInfo(it, NAME)
     * }
     * ```
     */
    private fun makeVMfromJson(json: JsonValue, profileName: String): VM {
        println("Processing profile '$profileName'")

        val assetsDir = json.getString("assetsdir")
        val ramsize = json.getLong("ramsize")
        val cardslots = json.getInt("cardslots")
        val roms = json.get("roms").iterator().map { VMProgramRom(File(it.asString())) }.toTypedArray()

        val vm = VM(assetsDir, ramsize, TheRealWorld(), roms, cardslots, watchdogs)

        return vm
    }

    private fun JsonValue.allIntoJavaType(argTypes: Array<Class<*>>): Array<Any?> {
        val values = this.iterator().toList()
        if (values.size != argTypes.size) throw IllegalArgumentException("# of args: ${values.size}, # of arg types: ${argTypes.size}")

        return argTypes.mapIndexed { index, it -> when (it.canonicalName) {
            "float", "java.lang.Float" -> values[index].asFloat()
            "double", "java.lang.Double" -> values[index].asDouble()
            "byte", "java.lang.Byte" -> values[index].asByte()
            "char", "java.lang.Character" -> values[index].asChar()
            "short", "java.lang.Short" -> values[index].asShort()
            "int", "java.lang.Integer" -> values[index].asInt()
            "long", "java.lang.Long" -> values[index].asLong()
            "boolean", "java.lang.Boolean" -> values[index].asBoolean()
            "java.lang.String" -> values[index].asString()
            else -> throw NotImplementedError("No conversion for ${it.canonicalName} exists")
        } }.toTypedArray()
    }

    private fun <T> Array<T>.tail(): Array<T> = this.sliceArray(1..this.lastIndex)
}


object EmulatorGuiToolkit {

    object Theme {
        val COL_INACTIVE = Color(0x858585ff.toInt())
        val COL_INACTIVE2 = Color(0x5a5a5fff.toInt())
        val COL_INACTIVE3 = Color.WHITE
        val COL_ACTIVE = Color(0x86fffeff.toInt()) // cyan
        val COL_ACTIVE2 = Color(0xfff600ff.toInt()) // yellow
        val COL_ACTIVE3 = Color(0x0aff9eff.toInt()) // "EL green"
        val COL_ACTIVE4 = Color(0xd8e4eeff.toInt()) // not-so-white
        val COL_HIGHLIGHT = Color(0xd99c00ff.toInt()) // "golden frame"
        val COL_HIGHLIGHT2 = Color(0xb23a69ff.toInt()) // less saturated magenta
        val COL_DISABLED = Color(0xaaaaaaff.toInt())

        val COL_TAB_NOT_SELECTED = Color(0x585858ff.toInt()) // grey
        val COL_TAB_NOT_SELECTED2 = Color(0x686868ff.toInt()) // grey

        val COL_LAND = Color(0x6b8ba2ff.toInt())
        val COL_WELL = Color(0x374854ff.toInt())
        val COL_WELL2 = Color(0x3f5360ff.toInt())
    }

}


fun SpriteBatch.fillRect(x: Int, y: Int, w: Int, h: Int) = this.draw(SQTEX, x.toFloat(), y.toFloat(), w.toFloat(), h.toFloat())
fun SpriteBatch.fillRect(x: Float, y: Float, w: Float, h: Float) = this.draw(SQTEX, x, y, w, h)
fun SpriteBatch.fillRect(x: Int, y: Int, w: Float, h: Float) = this.draw(SQTEX, x.toFloat(), y.toFloat(), w, h)
fun SpriteBatch.fillRect(x: Float, y: Float, w: Int, h: Int) = this.draw(SQTEX, x, y, w.toFloat(), h.toFloat())

fun SpriteBatch.inUse(f: (SpriteBatch) -> Unit) {
    this.begin()
    f(this)
    this.end()
}
