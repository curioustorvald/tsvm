package net.torvald.tsvm

import com.badlogic.gdx.graphics.g2d.SpriteBatch

/**
 * Created by minjaesong on 2022-10-25.
 */
abstract class EmuMenu(val parent: VMEmuExecutable, val x: Int, val y: Int, val w: Int, val h: Int) {

    abstract fun show()
    abstract fun hide()
    abstract fun update()
    abstract fun render(batch: SpriteBatch)
    abstract fun dispose()

}