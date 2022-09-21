package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import com.badlogic.gdx.graphics.glutils.FrameBuffer
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUlong
import net.torvald.tsvm.TsvmTextureRegionPack
import net.torvald.tsvm.VM

/**
 * Mimicks Commodore CLCD
 *
 * Created by minjaesong on 2022-09-21.
 */
class CLCDDisplay(assetsRoot: String, vm: VM) : GraphicsAdapter(assetsRoot, vm, AdapterConfig(
    "pmlcd_inverted", 480, 128, 80, 16, 253, 255, 262144L, "lcd2.png", 0.7f, TEXT_TILING_SHADER_LCD, DRAW_SHADER_FRAG_LCD, 2f
)
) {

    private val machine = Texture("$assetsRoot/clcd.png")
    private val lcdFont = TsvmTextureRegionPack(Texture("$assetsRoot/lcd.png"), 12, 16)

    /*override fun peek(addr: Long): Byte? {
        return when (addr) {
            in 0 until 250880 -> (-1).toByte()
            else -> super.peek(addr)
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        when (addr) {
            in 0 until 250880 -> { /*do nothing*/ }
            else -> super.poke(addr, byte)
        }
    }*/

    override fun render(
        delta: Float,
        batch: SpriteBatch,
        xoff: Float,
        yoff: Float,
        flipY: Boolean,
        uiFBO: FrameBuffer?
    ) {
        batch.shader = null
        batch.inUse {
            batch.color = Color.WHITE
            batch.draw(machine, xoff, yoff)
        }
        super.render(delta, batch, xoff+60, yoff+90, flipY, uiFBO)
    }



    fun currentTimeInMills(): Long {
        vm.poke(-69, -1)
        var r = 0L
        for (i in 0L..7L) {
            r = r or vm.peek(-81 - i)!!.toUlong().shl(8 * i.toInt())
        }
        return r
    }


    override fun dispose() {
        machine.dispose()
        lcdFont.dispose()
        super.dispose()
    }
}