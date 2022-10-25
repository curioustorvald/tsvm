package net.torvald.tsvm

import com.badlogic.gdx.graphics.g2d.SpriteBatch

/**
 * Created by minjaesong on 2022-10-25.
 */
interface EmuMenu {

    fun update()

    fun render(batch: SpriteBatch)

}