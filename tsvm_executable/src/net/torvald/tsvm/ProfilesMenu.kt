package net.torvald.tsvm

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.g2d.SpriteBatch

/**
 * Created by minjaesong on 2022-10-25.
 */
class ProfilesMenu(val w: Int, val h: Int) : EmuMenu {

    override fun update() {
    }

    override fun render(batch: SpriteBatch) {
        batch.inUse {
            batch.color = Color.LIME
            batch.fillRect(0, 0, w, h)
        }
    }
}