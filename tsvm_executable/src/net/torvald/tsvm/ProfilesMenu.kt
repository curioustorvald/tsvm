package net.torvald.tsvm

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.Input.Buttons
import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT

/**
 * Created by minjaesong on 2022-10-25.
 */
class ProfilesMenu(parent: VMEmuExecutable, x: Int, y: Int, w: Int, h: Int) : EmuMenu(parent, x, y, w, h) {

    companion object {
        const val PROFILES_ROWS = 17 // 1 profile-row takes up 2 text-rows
    }

    private val profileNames = ArrayList<String>()
    private var profilesScroll = 0

    private var selectedProfileIndex: Int? = null

    private val viewportRows = parent.panelsY
    private val viewportColumns = parent.panelsX

    private fun resetState() {
        profilesScroll = 0
    }

    override fun show() {
        profileNames.clear()
        profileNames.addAll(parent.profiles.keys.sorted())
    }

    override fun hide() {

    }

    override fun update() {

        if (Gdx.input.isButtonPressed(Buttons.LEFT)) {
            val mx = Gdx.input.x - x
            val my = Gdx.input.y - y

            if (mx in 10 until 10+228) {
                if (my in 11 until 11+446) {
                    val li = (my - 11) / (2*FONT.H)

                    if (li < profileNames.size - profilesScroll)
                        selectedProfileIndex = li + profilesScroll
                    else
                        selectedProfileIndex = null
                }
            }
        }

    }

    private val STR_PLAY = "\u00D2\u00D3"
    private val STR_STOP = "\u00D0\u00D1"

    override fun render(batch: SpriteBatch) {
        batch.inUse {
            // draw list of installed profiles
            for (i in 0 until PROFILES_ROWS) {
                batch.setColourBy(EmulatorGuiToolkit.Theme.COL_WELL, EmulatorGuiToolkit.Theme.COL_WELL2) { (i % 2 == 0) }
                batch.fillRect(10, 11 + i*2*FONT.H, 228, 2*FONT.H)
            }

            for (i in 0 until Math.min(PROFILES_ROWS, profileNames.size)) {
                val index = profilesScroll + i

                val colBack = if (index == selectedProfileIndex) EmulatorGuiToolkit.Theme.COL_HIGHLIGHT
                        else if (i % 2 == 0) EmulatorGuiToolkit.Theme.COL_WELL
                        else EmulatorGuiToolkit.Theme.COL_WELL2
                val colFore = if (index == selectedProfileIndex) EmulatorGuiToolkit.Theme.COL_ACTIVE
                        else EmulatorGuiToolkit.Theme.COL_ACTIVE2
                val colFore2 = if (index == selectedProfileIndex) EmulatorGuiToolkit.Theme.COL_ACTIVE3
                else EmulatorGuiToolkit.Theme.COL_INACTIVE3

                val theVM = parent.getVMbyProfileName(profileNames[index])
                val isVMrunning = if (theVM != null) !theVM.disposed && theVM.startTime >= 0 else false
                val vmViewport = parent.getViewportForTheVM(theVM)

                val vmRunStatusText = if (isVMrunning) STR_PLAY else STR_STOP
                val vmViewportText = if (vmViewport != null) "on viewport #${vmViewport+1}" else "and hidden"

                batch.color = colBack
                batch.fillRect(10, 11 + i*2*FONT.H, 228, 2*FONT.H)

                batch.color = colFore
                FONT.draw(batch, profileNames[index], 12f, 11f + i*2*FONT.H)
                batch.color = colFore2
                FONT.draw(batch, "$vmRunStatusText $vmViewportText", 12f, 11f+FONT.H + i*2*FONT.H)
            }

            // draw profile detals view
            if (selectedProfileIndex != null) profileNames[selectedProfileIndex!!].let {  profileName ->
                batch.color = EmulatorGuiToolkit.Theme.COL_WELL2
                batch.fillRect(251, 11, 375, 260)
                batch.fillRect(251, 427, 375, 26)
                batch.fillRect(370, 375, 256, 26)

                val profile = parent.profiles[profileName]!!
                val theVM = parent.getVMbyProfileName(profileName)
                val isVMrunning = if (theVM != null) !theVM.disposed && theVM.startTime >= 0 else false
                val vmViewport = parent.getViewportForTheVM(theVM)


                val ramsize = profile.getLong("ramsize")
                val cardslots = profile.getInt("cardslots")
                val roms = profile.get("roms").iterator().map { it }
                val extraRomCount = roms.size - 1
                val coms = (1..4).map { profile.get("com$it")?.getString("cls") } // full classname of the COM device
                val cards = (1 until cardslots).map { profile.get("card$it")?.getString("cls") } // full classname of the cards

                batch.color = Color.WHITE
                FONT.draw(batch, "Memory: $ramsize bytes", 253f, 11f)
                FONT.draw(batch, "Card Slots: $cardslots", 253f, 11f + 1*FONT.H)
                FONT.draw(batch, "Extra ROMs: ${if (extraRomCount == 0) "none" else extraRomCount}", 253f, 11f + 2*FONT.H)
                FONT.draw(batch, "COM Ports:", 253f, 11f + 4*FONT.H)
                for (i in 1..4) {
                    FONT.draw(batch, "$i) ${coms[i-1]?.let { it.substring(it.lastIndexOf('.')+1) } ?: ""}", 253f, 11f + (4+i)*FONT.H)
                }

                FONT.draw(batch, "Peripherals (cards):", 253f, 11f + 10*FONT.H)
                FONT.draw(batch, "1) [Emulated Reference Graphics Adapter]", 253f, 11f + 11*FONT.H)
                for (i in 2 until cardslots) {
                    FONT.draw(batch, "$i) ${cards[i-1]?.let { it.substring(it.lastIndexOf('.')+1) } ?: ""}", 253f, 11f + (10+i)*FONT.H)
                }

                FONT.draw(batch, "Boot Drive: ${profile.get("com1").get("args")[1].asString()}", 253f, 11f + 19*FONT.H)



                // draw panel chooser
                FONT.draw(batch, "Show on Viewport:", 253f, 414f)

                batch.setColourBy { vmViewport == null }
                FONT.draw(batch, "Hi", 254f, 429f)
                FONT.draw(batch, "de", 254f, 439f)

                for (i in 1 until viewportRows * viewportColumns) {
                    batch.setColourBy { (vmViewport != null && i == vmViewport + 1) }
                    FONT.draw(batch, "$i", 254f + (i * 14f) + (if (i < 10) 7f else 0f), 434f)
                }



                // draw machine control
                FONT.draw(batch, "Machine Control:", 253f, 381f)

                batch.setColourBy { !isVMrunning }
                FONT.draw(batch, STR_STOP, 377f, 382f)
                batch.setColourBy { isVMrunning }
                FONT.draw(batch, STR_PLAY, 398f, 382f)

            }
        }
    }

    private fun SpriteBatch.setColourBy(colourIfTrue: Color = EmulatorGuiToolkit.Theme.COL_ACTIVE3, colourIfFalse: Color = Color.WHITE, predicate: () -> Boolean) {
        this.color = if (predicate()) colourIfTrue else colourIfFalse
    }
}