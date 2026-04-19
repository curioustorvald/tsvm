package net.torvald.tsvm

import com.badlogic.gdx.Audio
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.Input.Buttons
import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.reflection.extortField
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_ACTIVE3
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_HIGHLIGHT2
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_WELL
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.TINY
import net.torvald.tsvm.peripheral.AudioAdapter
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * Created by minjaesong on 2023-01-22.
 */
class AudioMenu(parent: VMEmuExecutable, x: Int, y: Int, w: Int, h: Int) : EmuMenu(parent, x, y, w, h) {

    // Per-playhead view mode: 0=detailed pattern, 1=abridged pattern (stub), 2=super-abridged (stub), 3=cuesheet detail
    private val scopeMode = IntArray(4)

    override fun show() {
    }

    override fun hide() {
    }

    private var guiClickLatched = arrayOf(false, false, false, false, false, false, false, false)

    override fun update() {
        if (Gdx.input.isButtonPressed(Buttons.LEFT)) {
            if (!guiClickLatched[Buttons.LEFT]) {
                val mx = Gdx.input.x - x
                val my = Gdx.input.y - y

                if (mx in 117..629) {
                    for (i in 0..3) {
                        val syTop = h - 7 - 115 * i - 8 * FONT.H
                        val syBot = h - 3 - 115 * i
                        if (my in syTop..syBot) {
                            scopeMode[3 - i] = (scopeMode[3 - i] + 1) % 4
                            break
                        }
                    }
                }

                guiClickLatched[Buttons.LEFT] = true
            }
        }
        else {
            guiClickLatched[Buttons.LEFT] = false
        }

    }

    private val COL_SOUNDSCOPE_BACK = Color(0x081c08ff.toInt())
    private val COL_SOUNDSCOPE_FORE = Color(0x80f782ff.toInt())
    private val COL_TRACKER_ROW     = Color(0x103010ff.toInt())
    private val STR_PLAY = "\u00D2\u00D3"

    // Pattern field colours (loosely following MilkyTracker scheme)
    private val COL_NOTE    = Color(1f, 1f, 1f, 1f)              // white
    private val COL_INST    = Color(0x6BB5FFff.toInt())           // sky blue
    private val COL_VOL     = Color(0x80FF50ff.toInt())           // lime
    private val COL_PAN     = Color(0xFFC040ff.toInt())           // amber
    private val COL_EFF     = Color(0xFF50FFff.toInt())           // magenta
    private val COL_EFFARG  = Color(0xFFAF7Fff.toInt())           // apricot

    // Voice colours for cue-sheet view — 10-colour palette cycling across 20 voices
    private val COL_VOICE_PALETTE = arrayOf(
        Color(0xC0C0C0ff.toInt()),   //  0: silver
        Color(0xFF8080ff.toInt()),   //  1: salmon
        Color(0xFFBF60ff.toInt()),   //  2: tangerine
        Color(0xFFFF70ff.toInt()),   //  3: yellow
        Color(0x80FF80ff.toInt()),   //  4: lime
        Color(0x60EEEEff.toInt()),   //  5: aqua
        Color(0x80A0FFff.toInt()),   //  6: periwinkle
        Color(0xD080FFff.toInt()),   //  7: orchid
        Color(0xFF80C0ff.toInt()),   //  8: pink
        Color(0xA0D0A0ff.toInt()),   //  9: sage
    )


    override fun render(batch: SpriteBatch) {

        val adev = parent.currentlyPersistentVM?.vm?.peripheralTable?.getOrNull(cardIndex ?: -1)?.peripheral as? AudioAdapter

        if (adev != null) {

            // draw status LCD
            batch.inUse {
                // draw backgrounds
                batch.color = COL_WELL
                for (i in 0..3) { batch.fillRect(7, 5 + 115*i, 102, 8*FONT.H + 4) }
            }
            for (i in 0..3) {
                val ahead = adev.extortField<Array<AudioAdapter.Playhead>>("playheads")!![i]
                drawStatusLCD(adev, ahead, batch, i, 9f + 7, 7f + 7 + 115 * i)
            }

            // draw Soundscope like this so that the overflown queue sparkline would not be overlaid on top of the envelopes
            batch.inUse {
                // draw backgrounds
                batch.color = COL_SOUNDSCOPE_BACK
                for (i in 0..3) { batch.fillRect(117, 5 + 115*i, 512, 8*FONT.H + 4) }
            }
            for (i in 0..3) {
                val ahead = adev.extortField<Array<AudioAdapter.Playhead>>("playheads")!![i]
                drawSoundscope(adev, ahead, batch, i, 117f, 5f + 115 * i)
            }
        }
        else {
            batch.inUse {
                batch.color = Color.WHITE
                FONT.draw(batch, "Please select a VM", 12f, 11f + 0* FONT.H)
            }
        }

    }

    private fun drawStatusLCD(audio: AudioAdapter, ahead: AudioAdapter.Playhead, batch: SpriteBatch, index: Int, x: Float, y: Float) {
        // NOTE: Samples count for PCM mode is drawn by drawSoundscope() function, not this one!

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
                val qgrsize = ahead.getPcmQueueCapacity().let { ahead.position / it.toDouble() }.times(FONT.W * 7).roundToInt()
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
                FONT.drawRalign(batch, "${ahead.trackerState?.cuePos}:${ahead.trackerState?.rowIndex?.toString()?.uppercase()?.padStart(2,'0')}", x + 84, y + 2*FONT.H)
                FONT.drawRalign(batch, "${ahead.masterVolume}", x + 84, y + 3*FONT.H)
                FONT.drawRalign(batch, "${ahead.masterPan}", x + 84, y + 4*FONT.H)
                FONT.drawRalign(batch, "${ahead.bpm}", x + 84, y + 5*FONT.H)
                FONT.drawRalign(batch, "${ahead.tickRate}", x + 84, y + 6*FONT.H)
            }
        }
    }

    fun Int.u16Tos16() = if (this > 32767) this - 65536 else this

    private fun readCuePat12(audio: AudioAdapter, ci: Int, vi: Int): Int {
        val byteGroup = vi / 2
        val shift = if (vi % 2 == 0) 4 else 0
        val lo  = (audio.mmio_read(32768L + ci * 32 + byteGroup     ).toUint() ushr shift) and 0xF
        val mid = (audio.mmio_read(32768L + ci * 32 + 10 + byteGroup).toUint() ushr shift) and 0xF
        val hi  = (audio.mmio_read(32768L + ci * 32 + 20 + byteGroup).toUint() ushr shift) and 0xF
        return (hi shl 8) or (mid shl 4) or lo
    }

    private fun bipolarCeil(d: Double) =  (if (d >= 0.0) ceil(d) else floor(d)).toInt()
    private fun bipolarFloor(d: Double) = (if (d >= 0.0) floor(d) else ceil(d)).toInt()

    private val VOX_PER_VIEW = arrayOf(5,13,17)

    private fun drawSoundscope(audio: AudioAdapter, ahead: AudioAdapter.Playhead, batch: SpriteBatch, index: Int, x: Float, y: Float) {
        val gdxadev = ahead.audioDevice
        val bytes = gdxadev.extortField<ByteArray>("bytes")
        val bytesLen = gdxadev.extortField<Int>("bytesLength")!!
        val envelopeHalfHeight = 27

        batch.inUse {
            if (ahead.isPcmMode && bytes != null) {
                val smpCnt = bytesLen / 4 - 1

                for (s in 0..511) {
                    val i = (smpCnt * (s / 511.0)).roundToInt().and(0xfffffe)

                    val smpL = (bytes[i*4].toUint() or bytes[i*4+1].toUint().shl(8)).u16Tos16().toDouble().div(32767)
                    val smpR = (bytes[i*4+2].toUint() or bytes[i*4+3].toUint().shl(8)).u16Tos16().toDouble().div(32767)

                    val smpLH = smpL * envelopeHalfHeight
                    val smpRH = smpR * envelopeHalfHeight

                    val smpLHi = bipolarFloor(smpLH)
                    val smpRHi = bipolarFloor(smpRH)
                    val smpLHi2 = bipolarCeil(smpLH)
                    val smpRHi2 = bipolarCeil(smpRH)

                    val smpLHe = abs(smpLH - smpLHi).toFloat()
                    val smpRHe = abs(smpRH - smpRHi).toFloat()

                    // antialias in y-axis
                    if (smpLHi != smpLHi2) {
                        batch.color = COL_SOUNDSCOPE_FORE.cpy().mul(smpLHe)
                        batch.fillRect(x + s, y + 27, 1, smpLHi2)
                    }
                    if (smpRHi != smpRHi2) {
                        batch.color = COL_SOUNDSCOPE_FORE.cpy().mul(smpRHe)
                        batch.fillRect(x + s, y + 81, 1, smpRHi2)
                    }

                    // base texture
                    batch.color = COL_SOUNDSCOPE_FORE
                    batch.fillRect(x + s, y + 27, 1, smpLHi)
                    batch.fillRect(x + s, y + 81, 1, smpRHi)
                }

                batch.color = Color.WHITE
                FONT.draw(batch, "Samples", x - 101, y + 5*FONT.H + 9)
                batch.color = COL_ACTIVE3
                FONT.drawRalign(batch, "${smpCnt+1}", x - 17, y + 5*FONT.H + 9)

            }
            else {
                // Tracker pattern visualiser.
                // Modes: 0=detailed pattern, 1=abridged (stub), 2=super-abridged (stub), 3=cuesheet detail
                val ts = ahead.trackerState
                if (ts == null) {
                    batch.color = COL_SOUNDSCOPE_FORE
                    FONT.draw(batch, "No tracker state", x, y + 4)
                } else {
                    val cuePos = ts.cuePos
                    val rowIdx = ts.rowIndex
                    val ROWS   = 17
                    val PTN_MAX_ROWS = 63

                    when (scopeMode[index]) {

                        // ── Mode 3: Cue-sheet detail ─────────────────────────────────────
                        3 -> {
                            // Layout per row: >NNN|p00p01…p19|INS
                            // Voice pattern numbers are colour-coded; no spaces (colour provides separation).
                            val cueFirst = (cuePos - ROWS / 2).coerceAtLeast(0).coerceAtMost(1023 - ROWS + 1)
                            for (r in 0 until ROWS) {
                                val ci = cueFirst + r
                                if (ci > 1023) break
                                val here = ci == cuePos
                                val ry = y + 4 + r * TINY.H

                                if (here) {
                                    batch.color = COL_TRACKER_ROW
                                    batch.fillRect(x, ry, 512, TINY.H)
                                }

                                var cx = x
                                // cursor + cue number
                                batch.color = if (here) Color.WHITE else COL_SOUNDSCOPE_FORE
                                TINY.draw(batch, "${if (here) ">" else " "}${ci.toString(16).padStart(3, '0').uppercase()}|", cx, ry)
                                cx += 5 * TINY.W

                                // voice pattern numbers
                                for (vi in 0 until 20) {
                                    if (vi > 0) { cx += TINY.W }
                                    val pat = readCuePat12(audio, ci, vi)
                                    val patStr = if (pat == 0xFFF) "---"
                                    else pat.toString(16).padStart(3, '0').uppercase()
                                    batch.color = if (here) Color.WHITE else COL_VOICE_PALETTE[vi % COL_VOICE_PALETTE.size]
                                    TINY.draw(batch, patStr, cx, ry)
                                    cx += 3 * TINY.W
                                }

                                // instruction
                                val instrByte = audio.mmio_read(32768L + ci * 32 + 30).toUint()
                                val instrStr3 = when {
                                    instrByte == 0x00 -> "    " // no-op
                                    instrByte == 0x01 -> "HALT"
                                    instrByte and 0x80 != 0 -> "BACK ${(instrByte and 0x7F).toString(16).padStart(2, '0').uppercase()}"
                                    instrByte and 0xF0 == 0x10 -> "FWRD ${(instrByte and 0x0F).toString(16).uppercase()}"
                                    else -> "?${instrByte.toString(16).padStart(2, '0').uppercase()}"
                                }
                                batch.color = if (here) Color.WHITE else COL_SOUNDSCOPE_FORE
                                TINY.draw(batch, "|$instrStr3", cx, ry)
                            }
                        }

                        // ── Mode 0: Detailed pattern with colour-coded fields ────────────
                        // ── Mode 1: Abridged pattern with colour-coded fields ────────────
                        // ── Mode 2: Super-abridged pattern with colour-coded fields ────────────
                        0, 1, 2 -> {
                            val cueW = 4 * TINY.W
                            val sepW = TINY.W
//                            val patX = x + cueW + sepW
                            val patX = x
                            val VOICES = VOX_PER_VIEW[scopeMode[index]]

                            // Abridged cue sheet (left column, 8 entries centred on current cue)
                            /*val cueFirst = (cuePos - ROWS / 2).coerceAtLeast(0).coerceAtMost(1023 - ROWS + 1)
                            for (r in 0 until ROWS) {
                                val ci = cueFirst + r
                                if (ci > 1023) break
                                val here = ci == cuePos
                                batch.color = if (here) Color.WHITE else COL_SOUNDSCOPE_FORE
                                TINY.draw(batch,
                                    "${if (here) ">" else " "}${ci.toString(16).padStart(3, '0').uppercase()}",
                                    x, y + 4 + r * TINY.H)
                            }

                            // Vertical separator
                            batch.color = COL_SOUNDSCOPE_FORE
                            for (r in 0 until ROWS) TINY.draw(batch, "|", x + cueW, y + 4 + r * TINY.H)
                             */

                            // Pattern index for each voice in current cue
                            val cuePats = IntArray(VOICES) { vi -> readCuePat12(audio, cuePos, vi) }

                            // Pattern rows (right area, 8 rows centred on current row)
                            // Layout: > rr NOTE in E.Vo E.Pn Eff ffff [voice1 …]
                            //          1  2    4  2    4    4   2    4
                            val rowFirst = (rowIdx - ROWS / 2).coerceAtLeast(0).coerceAtMost(PTN_MAX_ROWS - ROWS + 1)
                            for (r in 0 until ROWS) {
                                val ri = rowFirst + r
                                if (ri > PTN_MAX_ROWS) break
                                val here = ri == rowIdx
                                val ry = y + 4 + r * TINY.H

                                if (here) {
                                    batch.color = COL_TRACKER_ROW
                                    batch.fillRect(patX, ry, 512 - cueW - sepW, TINY.H)
                                }

                                var cx = patX

                                // cursor + row number (drawn once per row)
                                batch.color = if (here) Color.WHITE else COL_SOUNDSCOPE_FORE
                                TINY.draw(batch, if (here) ">" else " ", cx, ry)
                                cx += TINY.W
                                TINY.draw(batch, ri.toString().padStart(2, '0').uppercase(), cx, ry)
                                cx += 2 * TINY.W

                                for (vi in 0 until VOICES) {
                                    val pat12 = cuePats[vi]
                                    if (pat12 == 0xFFF) {
                                        if (vi == 0) {
                                            // disabled voice — dimmed placeholder, same width as a live voice
                                            batch.color = COL_SOUNDSCOPE_FORE
                                            TINY.draw(
                                                batch,
                                                "(NO PATTERN DATA OR REACHED THE END OF THE SONG)                         ",
                                                cx,
                                                ry
                                            )
                                        }
                                    } else {
                                        val localPat = pat12 and 0xFF
                                        val base = if (localPat < 128) 786432L + localPat * 512 + ri * 8
                                        else 851968L + (localPat - 128) * 512 + ri * 8

                                        val noteLo  = audio.peek(base + 0).toUint()
                                        val noteHi  = audio.peek(base + 1).toUint()
                                        val noteVal = noteLo or (noteHi shl 8)
                                        val instr   = audio.peek(base + 2).toUint()
                                        val volByte = audio.peek(base + 3).toUint()
                                        val panByte = audio.peek(base + 4).toUint()
                                        val eff     = audio.peek(base + 5).toUint()
                                        val eaLo    = audio.peek(base + 6).toUint()
                                        val eaHi    = audio.peek(base + 7).toUint()

                                        val vol    = volByte and 63
                                        val volEff = (volByte ushr 6) and 3
                                        val pan    = panByte and 63
                                        val panEff = (panByte ushr 6) and 3
                                        val effArg = eaLo or (eaHi shl 8)

                                        val noteStr = when (noteVal) {
                                            0xFFFF -> "@@@@"
                                            0x0000 -> "===="
                                            0xFFFE -> "^^^^"
                                            else -> noteVal.toString(16).uppercase().padStart(4, '0')
                                        }

                                        // note
                                        batch.color = if (here) Color.WHITE else COL_NOTE
                                        TINY.draw(batch, noteStr, cx, ry)
                                        cx += 4 * TINY.W
                                        // instrument
                                        batch.color = if (here) Color.WHITE else COL_INST
                                        TINY.draw(batch, instr.toString(16).padStart(2, '0').uppercase(), cx, ry)
                                        cx += 2 * TINY.W
                                        if (scopeMode[index] == 0) {
                                            // volume
                                            batch.color = if (here) Color.WHITE else COL_VOL
                                            TINY.draw(batch, "$volEff.${vol.toString().padStart(2, '0')}", cx, ry)
                                            cx += 4 * TINY.W
                                        }
                                        else if (scopeMode[index] == 1) {
                                            batch.color = if (here) Color.WHITE else COL_VOL
                                            TINY.draw(batch, vol.toString().padStart(2, '0'), cx, ry)
                                            cx += 2 * TINY.W
                                        }
                                        // pan
                                        if (scopeMode[index] == 0) {
                                            batch.color = if (here) Color.WHITE else COL_PAN
                                            TINY.draw(batch, "$panEff.${pan.toString().padStart(2, '0')}", cx, ry)
                                            cx += 4 * TINY.W
                                        }
                                        if (scopeMode[index] == 0) {
                                            // effect opcode
                                            batch.color = if (here) Color.WHITE else COL_EFF
                                            TINY.draw(batch, eff.toString(16).padStart(2, '0').uppercase(), cx, ry)
                                            cx += 2 * TINY.W
                                        }
                                        if (scopeMode[index] == 0) {
                                            // effect argument
                                            batch.color = if (here) Color.WHITE else COL_EFFARG
                                            TINY.draw(batch, effArg.toString(16).padStart(4, '0').uppercase(), cx, ry)
                                            cx += 4 * TINY.W
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    override fun dispose() {
    }


}
