package net.torvald.tsvm

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.Pixmap
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_LAND
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_WELL
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT


/**
 * Created by minjaesong on 2023-01-02.
 */
class MMUMenu(parent: VMEmuExecutable, x: Int, y: Int, w: Int, h: Int) : EmuMenu(parent, x, y, w, h) {

    override fun show() {

    }

    override fun hide() {
    }

    override fun update() {
    }


    override fun render(batch: SpriteBatch) {
        batch.color = Color.WHITE

        parent.currentlyPersistentVM.let { vmInfo ->

            if (vmInfo == null) {
                batch.inUse {
                    FONT.draw(batch, "Please select a VM", 12f, 11f + 0* FONT.H)
                }
            }
            else vmInfo.let { (vm, vmName) ->
                batch.inUse {
                    FONT.draw(batch, "Allocated size: ${vm.allocatedBlockCount * vm.MALLOC_UNIT}", 12f, 11f + 0* FONT.H)



                }

                drawAllocMap(batch, vm, 62f, 2f * FONT.H)
            }
        }
    }

    private val plotColset = intArrayOf(
        0xea5545ff.toInt(), 0xf46a9bff.toInt(), 0xef9b20ff.toInt(), 0xedbf33ff.toInt(), 0xede15bff.toInt(), 0xbdcf32ff.toInt(),
        0x87bc45ff.toInt(), 0x27aeefff.toInt(), 0xb33dc6ff.toInt(), 0xe60049ff.toInt(), 0x0bb4ffff.toInt(), 0x50e991ff.toInt(),
        0xe6d800ff.toInt(), 0x9b19f5ff.toInt(), 0xffa300ff.toInt(), 0xdc0ab4ff.toInt(), 0xb3d4ffff.toInt(), 0x00bfa0ff.toInt(),
    )
    private val plotColours = plotColset.map { Color(it) }

    private val memmapPixmap = Pixmap(512, 256, Pixmap.Format.RGBA8888)

    private var mallocMap: List<Pair<Int, Int>> = listOf()

    private fun drawAllocMap(batch: SpriteBatch, vm: VM, x: Float, y: Float) {

        // clear the memmapPixmap
        memmapPixmap.setColor(0)
        memmapPixmap.fill()

        // unallocated map as black
        for (i in 0 until vm.memsize / vm.MALLOC_UNIT) {
            paintPixel(i.toInt(), 255)
        }

        try {
            // try to update the mallocMap
            mallocMap = vm.javaClass.getDeclaredField("mallocSizes").let {
                it.isAccessible = true
                it.get(vm) as HashMap<Int, Int>
            }.entries.map { it.key to it.value }.sortedBy { it.first }
        }
        catch (e: ConcurrentModificationException) { /* skip update for this frame */ }

        // allocated map
        mallocMap.forEachIndexed { index, (ptr, size) ->
            for (i in 0 until size) {
                paintPixel(ptr + i, plotColset[ptr % plotColset.size])
            }
        }

        val memmapTex = Texture(memmapPixmap)

        batch.inUse {
            // draw allocation map
            batch.color = COL_WELL
            batch.fillRect(x, y, 512, 256)
            batch.color = Color.WHITE
            batch.draw(memmapTex, x, y)

            // draw textual list
            mallocMap.forEachIndexed { index, (ptr, size) ->
                // hackishly draw textual list
                if (index < 52) {
                    val xoff = 15f + 155f * (index / 13)
                    val yoff = 286f + ((index % 13) * FONT.H)

                    batch.color = plotColours[ptr % plotColset.size]
                    batch.fillRect(xoff, yoff + 1, 10, 10)
                    batch.color = Color.WHITE
                    FONT.draw(batch, "  ${size * vm.MALLOC_UNIT} at ${ptr * vm.MALLOC_UNIT}", xoff, yoff)
                }
            }
        }

        memmapTex.dispose()

    }

    private fun paintPixel(index: Int, colour: Int) {
        memmapPixmap.setColor(colour)
        memmapPixmap.drawPixel(index / 256, index % 256)
    }

    override fun dispose() {
        memmapPixmap.dispose()
    }
}