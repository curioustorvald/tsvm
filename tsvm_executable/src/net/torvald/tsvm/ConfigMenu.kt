package net.torvald.tsvm

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.Input
import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT

/**
 * Created by minjaesong on 2023-05-12.
 */
class ConfigMenu(parent: VMEmuExecutable, x: Int, y: Int, w: Int, h: Int) : EmuMenu(parent, x, y, w, h) {

    override fun show() {
    }

    override fun hide() {
    }


    private var guiClickLatched = arrayOf(false, false, false, false, false, false, false, false)

    override fun update() {

        if (Gdx.input.isButtonPressed(Input.Buttons.LEFT)) {
            if (!guiClickLatched[Input.Buttons.LEFT]) {
                val mx = Gdx.input.x - x
                val my = Gdx.input.y - y

                // make com/card/ram buttons work
                if (mx in 26 until 76) {
                    // com
                    if (my in 37 until 37 + FONT.H*4) {
                        selectedPort = "com${1+((my-37) / FONT.H)}"
                    }
                    // card
                    else if (my in 102 until 102 + FONT.H*7) {
                        selectedPort = "card${1+((my-102) / FONT.H)}"
                    }


                    //ram
                    if (my in 206 until 206 + FONT.H*10) {
                        selectedRAM = "ram${ramsize[(my-206) / FONT.H]}k"
                    }


                }



                guiClickLatched[Input.Buttons.LEFT] = true
            }
        }
        else {
            guiClickLatched[Input.Buttons.LEFT] = false
        }

    }

    private val STR_COM = "\u00D6\u00D7\u00D8\u00D9"
    private val STR_CARD = "\u00DA\u00DB\u00DC\u00DD"

    private var selectedPort = "" // com1-4, card1-7
    private var selectedRAM = ""// ram16k..ram8192k
    private val ramsize = listOf(16,32,64,128,256,512,1024,2048,4096,8192)


    override fun render(batch: SpriteBatch) {

        batch.color = Color.WHITE

        parent.currentlyPersistentVM.let { vmInfo ->

            if (vmInfo == null) {
                batch.inUse {
                    FONT.draw(batch, "Please select a VM", 12f, 11f)
                }
            }
            else vmInfo.let { (vm, vmName) ->
                batch.inUse {
                    // background
                    batch.color = EmulatorGuiToolkit.Theme.COL_WELL
                    batch.fillRect(8, 35, 67, 56)
                    batch.fillRect(8, 100, 67, 95)
                    batch.fillRect(8, 204, 67, 134)

                    //labels
                    batch.color = Color.WHITE
                    // vm name
                    FONT.draw(batch, vmName, 12f, 11f)
                    // COM
                    "COM".forEachIndexed { index, c -> FONT.draw(batch, "$c", 12f, 44f + FONT.H * index) }
                    // CARD
                    "CARD".forEachIndexed { index, c -> FONT.draw(batch, "$c", 12f, 123f + FONT.H * index) }
                    // RAM
                    "RAM".forEachIndexed { index, c -> FONT.draw(batch, "$c", 12f, 251f + FONT.H * index) }


                    // COM buttons
                    for (i in 1..4) {
                        batch.setColourBy { selectedPort == "com$i" }
                        FONT.draw(batch, "$i", 29f, 24f + FONT.H * i)
                        FONT.draw(batch, STR_COM, 40f, 24f + FONT.H * i)
                    }


                    // CARD buttons
                    for (i in 1..7) {
                        batch.setColourBy { selectedPort == "card$i" }
                        FONT.draw(batch, "$i", 29f, 89f + FONT.H * i)
                        FONT.draw(batch, STR_CARD, 40f, 89f + FONT.H * i)
                    }


                    for (i in 0..9) {
                        val ramnum = ramsize[i]
                        batch.setColourBy { selectedRAM == "ram${ramnum}k" }
                        FONT.draw(batch, "${ramnum}K", 36f + (if (ramnum < 100) 7f else if (ramnum < 1000) 4f else 0f), 206f + FONT.H * i)
                    }



                    // test print
                    val text = if (selectedPort.startsWith("com"))
                        vm.getIO().blockTransferPorts[selectedPort[3].code - 0x31].recipient?.javaClass?.simpleName
                    else if (selectedPort.startsWith("card"))
                        vm.peripheralTable[selectedPort[4].code - 0x30].peripheral?.javaClass?.simpleName
                    else
                        ""

                    batch.color = Color.WHITE
                    FONT.draw(batch, text ?: "Nothing", 96f, 37f)
                }
            }

        }
    }

    override fun dispose() {
    }
}