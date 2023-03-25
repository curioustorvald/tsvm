package net.torvald.tsvm

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT

/**
 * Created by minjaesong on 2023-03-25.
 */
class TevdMenu(parent: VMEmuExecutable, x: Int, y: Int, w: Int, h: Int) : EmuMenu(parent, x, y, w, h) {

    override fun show() {
    }

    override fun hide() {
    }

    override fun update() {
    }

    override fun render(batch: SpriteBatch) {

        batch.inUse {
            batch.color = Color.CORAL
            FONT.draw(batch, "Tevd!", 12f, 12f)
        }

    }

    override fun dispose() {
    }
}