package net.torvald.tsvm

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.reflection.extortField
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.EntryID
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.PartialDOM
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT
import net.torvald.tsvm.peripheral.TevdDiskDrive

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

        val dev = parent.currentlyPersistentVM?.vm?.getIO()?.blockTransferPorts?.getOrNull(cardIndex ?: -1)?.recipient

        if (dev?.javaClass?.simpleName == "TevdDiskDrive") {
            val dev = dev as TevdDiskDrive
            val DOM = dev.extortField("DOM") as PartialDOM
            val DOMfileCache = DOM.extortField("fileCache") as HashMap<EntryID, *>

            batch.inUse {
                batch.color = Color.WHITE
                FONT.draw(batch, "Disk UUID: ${dev.diskUUIDstr}", 12f, 12f)
                FONT.draw(batch, "F I L E   C A C H E", 12f, 12f+FONT.H)
                var row = 2
                DOMfileCache.forEach { (id, entry) ->
                    val str = "${(row-1).toString().padStart(2,' ')}. ID $id (hits: ${entry.extortField("hits")})"
                    FONT.draw(batch, str, 12f, 12f + FONT.H * row)

                    row += 1
                }
            }
        }
        else {
            batch.inUse {
                batch.color = Color.WHITE
                FONT.draw(batch, "Device is not TevdDiskDrive", 12f, 12f)
            }
        }


    }

    override fun dispose() {
    }
}