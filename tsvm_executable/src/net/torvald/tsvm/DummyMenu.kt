package net.torvald.tsvm

import com.badlogic.gdx.graphics.g2d.SpriteBatch

/**
 * Created by minjaesong on 2023-01-02.
 */
class DummyMenu(parent: VMEmuExecutable, x: Int, y: Int, w: Int, h: Int) : EmuMenu(parent, x, y, w, h) {

    override fun show() {
    }

    override fun hide() {
    }

    override fun update() {
    }

    override fun render(batch: SpriteBatch) {
    }

    override fun dispose() {
    }
}