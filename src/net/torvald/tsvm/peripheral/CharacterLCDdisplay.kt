package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUlong
import net.torvald.terrarumsansbitmap.gdx.TextureRegionPack
import net.torvald.tsvm.VM

class CharacterLCDdisplay(vm: VM) : GraphicsAdapter(vm, AdapterConfig(
    "pmlcd_inverted", 240, 64, 40, 8, 253, 255, 262144L, "lcd2.png", 0.7f, TEXT_TILING_SHADER_LCD, DRAW_SHADER_FRAG_LCD, 2f
)
) {

    private val machine = Texture("./assets/4008_portable_full.png")
    private val lcdFont = TextureRegionPack(Texture("./assets/lcd.png"), 12, 16)

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

    override fun render(delta: Float, batch: SpriteBatch, xoff: Float, yoff: Float) {
        batch.shader = null
        batch.inUse {
            batch.color = Color.WHITE
            batch.draw(machine, xoff, yoff)
        }
        super.render(delta, batch, xoff+74, yoff+102)

        // draw BMS and RTC
        val batPerc = "89"
        val batVolt = "5.1"
        val batText = "  $batPerc% ${batVolt}V"
        val msg = (1024L until 1048L).map { vm.getIO().mmio_read(it)!!.toInt().and(255) }
        vm.poke(-69,2)
        val time_t = currentTimeInMills()
        val min = (time_t / 60000) % 60
        val hour = (time_t / 3600000) % 24
        val clock = "${"$hour".padStart(2,'0')}:${"$min".padStart(2,'0')} "

        batch.shader = null
        batch.inUse {
            batch.color = Color.WHITE
            val y = yoff + 102 + config.height * config.drawScale
            for (x in 0 until config.textCols) {
                batch.draw(lcdFont.get(0,0), xoff+74 + x * lcdFont.tileW, y)
            }
            for (x in clock.indices) {
                val ccode = clock[x].toInt()
                batch.draw(lcdFont.get(ccode % 16, ccode / 16), xoff+74 + x * lcdFont.tileW, y)
            }
            for (x in msg.indices) {
                val ccode = msg[x]
                batch.draw(lcdFont.get(ccode % 16, ccode / 16), xoff+74 + (x + 6) * lcdFont.tileW, y)
            }
            for (x in batText.indices) {
                val ccode = batText[x].toInt()
                batch.draw(lcdFont.get(ccode % 16, ccode / 16), xoff+74 + (config.textCols - batText.length + x) * lcdFont.tileW, y)
            }
        }
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