package net.torvald.tsvm.peripheral

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.Texture
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.tsvm.VM

class CharacterLCDdisplay(vm: VM) : GraphicsAdapter(vm, AdapterConfig(
    "pmlcd_inverted", 960, 400, 80, 25, 249, 255, 262144L, "./lcd.png", 0.7f, TEXT_TILING_SHADER_LCD, DRAW_SHADER_FRAG_LCD
)
) {

    private val machine = Texture("./8025_textonly.png")

    override fun peek(addr: Long): Byte? {
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
    }

    override fun render(delta: Float, batch: SpriteBatch, xoff: Float, yoff: Float) {
        /*batch.shader = null
        batch.inUse {
            batch.color = Color.WHITE
            batch.draw(machine, xoff, yoff)
        }
        super.render(delta, batch, xoff+200, yoff-200)
        */
        super.render(delta, batch, xoff, yoff)
    }

    override fun dispose() {
        machine.dispose()
        super.dispose()
    }
}