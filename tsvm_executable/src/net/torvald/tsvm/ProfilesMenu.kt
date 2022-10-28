package net.torvald.tsvm

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
    }

    override fun render(batch: SpriteBatch) {
        batch.inUse {
            batch.color = EmulatorGuiToolkit.Theme.COL_WELL
            it.fillRect(10, 11, 228, 446)

            for (i in 0 until Math.min(PROFILES_ROWS, profileNames.size)) {
                val index = profilesScroll + i

                val colBack = if (index == selectedProfileIndex) EmulatorGuiToolkit.Theme.COL_HIGHLIGHT
                        else if (i % 2 == 0) EmulatorGuiToolkit.Theme.COL_WELL
                        else EmulatorGuiToolkit.Theme.COL_WELL2
                val colFore = if (index == selectedProfileIndex) EmulatorGuiToolkit.Theme.COL_ACTIVE
                        else EmulatorGuiToolkit.Theme.COL_ACTIVE2

                val theVM = parent.getVMbyProfileName(profileNames[index])
                val isVMrunning = if (theVM != null) !theVM.disposed && theVM.startTime >= 0 else false
                val vmViewport = parent.getViewportForTheVM(theVM)

                val vmRunStatusText = if (isVMrunning) "\u00D2\u00D3" else "\u00D0\u00D1"
                val vmViewportText = if (vmViewport != null) "on viewport #${vmViewport+1}" else "and hidden"

                batch.color = colBack
                it.fillRect(10, 11 + i*2*FONT.H, 228, 26)

                batch.color = colFore
                FONT.draw(batch, profileNames[index], 12f, 11f + i*2*FONT.H)
                batch.color = EmulatorGuiToolkit.Theme.COL_ACTIVE3
                FONT.draw(batch, "$vmRunStatusText $vmViewportText", 12f, 11f+FONT.H + i*2*FONT.H)


            }
        }
    }
}