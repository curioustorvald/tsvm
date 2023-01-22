package net.torvald.tsvm

import com.badlogic.gdx.Audio
import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_ACTIVE3
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_HIGHLIGHT2
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_WELL
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT
import net.torvald.tsvm.peripheral.AudioAdapter
import kotlin.math.roundToInt

/**
 * Created by minjaesong on 2023-01-22.
 */
class AudioMenu(parent: VMEmuExecutable, x: Int, y: Int, w: Int, h: Int) : EmuMenu(parent, x, y, w, h) {

    override fun show() {
    }

    override fun hide() {
    }

    override fun update() {
    }

    private val COL_SOUNDSCOPE_BACK = Color(0x081c08ff.toInt())
    private val COL_SOUNDSCOPE_FORE = Color(0x80f782ff.toInt())
    private val STR_PLAY = "\u00D2\u00D3"

    override fun render(batch: SpriteBatch) {

        val adev = parent.getCurrentlySelectedVM()?.vm?.peripheralTable?.getOrNull(cardIndex ?: -1)?.peripheral as? AudioAdapter

        batch.inUse {
            // draw backgrounds
            batch.color = COL_WELL
            for (i in 0..3) { batch.fillRect(7, 3 + 116*i, 102, 8*FONT.H + 4) }
            batch.color = COL_SOUNDSCOPE_BACK
            for (i in 0..3) { batch.fillRect(117, 3 + 116*i, 512, 8*FONT.H + 4) }
        }


        if (adev != null) {
            for (i in 0..3) {
                val ahead = (adev.extortField("playheads") as Array<AudioAdapter.Playhead>)[i]
                drawStatusLCD(adev, ahead, batch, i, 9f + 7, 5f + 7 + 116 * i)
                drawSoundscope(adev, ahead, batch, i, 117f, 5f + 116 * i)
            }
        }

    }

    private fun drawStatusLCD(audio: AudioAdapter, ahead: AudioAdapter.Playhead, batch: SpriteBatch, index: Int, x: Float, y: Float) {
        batch.inUse {
            batch.color = Color.WHITE
            // PLAY icon
            if (ahead.isPlaying)
                FONT.draw(batch, STR_PLAY, x, y)
            FONT.draw(batch, if (ahead.isPcmMode) "PCM" else "TRACKER", x + 21, y)

            // PCM Mode labels
            if (ahead.isPcmMode) {
                batch.color = Color.WHITE
                FONT.draw(batch, "Queue", x, y + 2*FONT.H)
                FONT.draw(batch, "Volume", x, y + 3*FONT.H)
                FONT.draw(batch, "Pan", x, y + 4*FONT.H)

                // Queue sparkline
                batch.color = COL_SOUNDSCOPE_BACK
                batch.fillRect(x + 5*FONT.W + 2, y + 2*FONT.H, FONT.W * 7, FONT.H)
                val qgrsize = ahead.getPcmQueueCapacity().let { ahead.position.coerceAtMost(it) / it.toDouble() }.times(FONT.W * 7).roundToInt()
                batch.color = COL_HIGHLIGHT2
                batch.fillRect(x + 5*FONT.W + 2, y + 2*FONT.H + 1, qgrsize, FONT.H - 2)

                batch.color = COL_ACTIVE3
                val qtxt = "${ahead.position}/${ahead.getPcmQueueCapacity()}"
                FONT.drawRalign(batch, qtxt, x + 84, y + 2*FONT.H)
                FONT.drawRalign(batch, "${ahead.masterVolume}", x + 84, y + 3*FONT.H)
                FONT.drawRalign(batch, "${ahead.masterPan}", x + 84, y + 4*FONT.H)
            }
            else {
                batch.color = Color.WHITE
                FONT.draw(batch, "Pos", x, y + 2*FONT.H)
                FONT.draw(batch, "Volume", x, y + 3*FONT.H)
                FONT.draw(batch, "Pan", x, y + 4*FONT.H)
                FONT.draw(batch, "BPM", x, y + 5*FONT.H)
                FONT.draw(batch, "Tickrate", x, y + 6*FONT.H)

                batch.color = COL_ACTIVE3
                FONT.drawRalign(batch, "${ahead.position}", x + 84, y + 2*FONT.H)
                FONT.drawRalign(batch, "${ahead.masterVolume}", x + 84, y + 3*FONT.H)
                FONT.drawRalign(batch, "${ahead.masterPan}", x + 84, y + 4*FONT.H)
                FONT.drawRalign(batch, "${ahead.bpm}", x + 84, y + 5*FONT.H)
                FONT.drawRalign(batch, "${ahead.tickRate}", x + 84, y + 6*FONT.H)
            }
        }
    }

    fun Int.u16Tos16() = if (this > 32767) this - 65536 else this

    private fun drawSoundscope(audio: AudioAdapter, ahead: AudioAdapter.Playhead, batch: SpriteBatch, index: Int, x: Float, y: Float) {
        val gdxadev = ahead.audioDevice
        val bytes = gdxadev.extortField("bytes") as ByteArray?
        val bytesLen = gdxadev.extortField("bytesLength") as Int
        val envelopeHalfHeight = 27

        batch.inUse {
            batch.color = COL_SOUNDSCOPE_FORE
            if (ahead.isPcmMode && bytes != null) {
                val smpCnt = bytesLen / 4 - 1

                for (s in 0..511) {
                    val i = (smpCnt * (s / 511.0)).roundToInt().and(0xfffffe)

                    val smpL = (bytes[i*4].toUint() or bytes[i*4+1].toUint().shl(8)).u16Tos16().toDouble().div(32767)
                    val smpR = (bytes[i*4+2].toUint() or bytes[i*4+3].toUint().shl(8)).u16Tos16().toDouble().div(32767)
                    val smpLH = (smpL * envelopeHalfHeight).roundToInt() // -50..50
                    val smpRH = (smpR * envelopeHalfHeight).roundToInt() // -50..50

                    batch.fillRect(x + s, y + 27, 1, smpLH)
                    batch.fillRect(x + s, y + 81, 1, smpLH)
                }
            }
            else {

            }
        }
    }

    override fun dispose() {
    }

    private fun Any.extortField(name: String): Any? { // yes I'm deliberately using negative words for the function name
        return this.javaClass.getDeclaredField(name).let {
            it.isAccessible = true
            it.get(this)
        }
    }
    private fun Any.forceInvoke(name: String, params: Array<Any>): Any? { // yes I'm deliberately using negative words for the function name
        return this.javaClass.getDeclaredMethod(name, *(params.map { it.javaClass }.toTypedArray())).let {
            it.isAccessible = true
            it.invoke(this, *params)
        }
    }

}