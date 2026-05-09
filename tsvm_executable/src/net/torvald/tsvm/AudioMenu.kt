package net.torvald.tsvm

import com.badlogic.gdx.Audio
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.Input
import com.badlogic.gdx.Input.Buttons
import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.reflection.extortField
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_ACTIVE
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_ACTIVE2
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_ACTIVE3
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_HIGHLIGHT
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_HIGHLIGHT2
import net.torvald.tsvm.EmulatorGuiToolkit.Theme.COL_WELL
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.TINY
import net.torvald.tsvm.peripheral.AudioAdapter
import java.util.BitSet
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.roundToInt

/**
 * Created by minjaesong on 2023-01-22.
 */
class AudioMenu(parent: VMEmuExecutable, x: Int, y: Int, w: Int, h: Int) : EmuMenu(parent, x, y, w, h) {

    // Per-playhead view mode: 0=detailed pattern, 1=abridged pattern (stub), 2=super-abridged (stub),
    //                         3=cuesheet detail, 4=per-voice waveform
    private val scopeMode = IntArray(4) { 4 }
    private val scopeScrollHorz = IntArray(4)
    private val SCOPE_MODE_COUNT = 5

    // Which playhead the big scope is showing. Status-panel clicks change this.
    private var selectedPlayhead = 0

    // Layout — one big scope on top, four status panels along the bottom.
    private val bigScopeX = 7
    private val bigScopeY = 5
    private val bigScopeW = 622
    private val bigScopeH = 336
    private val statusW = 102
    private val statusH = 8 * FONT.H + 4
    private val statusY = bigScopeY + bigScopeH + 4
    // Spread the four status panels evenly across the big-scope width.
    private fun statusX(i: Int): Int = bigScopeX + i * (bigScopeW - statusW) / 3

    override fun show() {
    }

    override fun hide() {
    }

    private var guiClickLatched = arrayOf(false, false, false, false, false, false, false, false)
    private var guiKeypressLatched = BitSet(256)

    private fun panelAtMouse(mx: Int, my: Int): Int {
        if (my !in statusY until (statusY + statusH)) return -1
        for (i in 0..3) {
            val sx = statusX(i)
            if (mx in sx until (sx + statusW)) return i
        }
        return -1
    }

    private fun mouseInBigScope(mx: Int, my: Int): Boolean =
        mx in bigScopeX until (bigScopeX + bigScopeW) &&
        my in bigScopeY until (bigScopeY + bigScopeH)

    override fun update() {
        val mx = Gdx.input.x - x
        val my = Gdx.input.y - y

        // ── LEFT click ─────────────────────────────────────────────────────────────
        // On a status panel: select that playhead as the big-scope target.
        // On the big scope:  cycle scope mode forward for the selected playhead.
        if (Gdx.input.isButtonPressed(Buttons.LEFT)) {
            if (!guiClickLatched[Buttons.LEFT]) {
                val panel = panelAtMouse(mx, my)
                if (panel >= 0) {
                    selectedPlayhead = panel
                } else if (mouseInBigScope(mx, my)) {
                    scopeMode[selectedPlayhead] =
                        (scopeMode[selectedPlayhead] + 1) % SCOPE_MODE_COUNT
                }
                guiClickLatched[Buttons.LEFT] = true
            }
        } else {
            guiClickLatched[Buttons.LEFT] = false
        }

        // ── RIGHT click on the big scope: cycle scope mode backward. ────────────────
        if (Gdx.input.isButtonPressed(Buttons.RIGHT)) {
            if (!guiClickLatched[Buttons.RIGHT]) {
                if (mouseInBigScope(mx, my)) {
                    scopeMode[selectedPlayhead] =
                        (scopeMode[selectedPlayhead] + SCOPE_MODE_COUNT - 1) % SCOPE_MODE_COUNT
                }
                guiClickLatched[Buttons.RIGHT] = true
            }
        } else {
            guiClickLatched[Buttons.RIGHT] = false
        }

        // ── Keyboard left/right: scroll the selected playhead's pattern view. ───────
        if (Gdx.input.isKeyPressed(Input.Keys.LEFT)) {
            if (!guiKeypressLatched[Input.Keys.LEFT]) {
                scopeScrollHorz[selectedPlayhead] =
                    (scopeScrollHorz[selectedPlayhead] - 1).coerceIn(0, 14)
                guiKeypressLatched[Input.Keys.LEFT] = true
            }
        } else {
            guiKeypressLatched[Input.Keys.LEFT] = false
        }
        if (Gdx.input.isKeyPressed(Input.Keys.RIGHT)) {
            if (!guiKeypressLatched[Input.Keys.RIGHT]) {
                scopeScrollHorz[selectedPlayhead] =
                    (scopeScrollHorz[selectedPlayhead] + 1).coerceIn(0, 14)
                guiKeypressLatched[Input.Keys.RIGHT] = true
            }
        } else {
            guiKeypressLatched[Input.Keys.RIGHT] = false
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
            val playheads = adev.extortField<Array<AudioAdapter.Playhead>>("playheads")!!

            // ── Big scope background (row 1) and status-panel backgrounds (row 2) ─────
            batch.inUse {
                batch.color = COL_SOUNDSCOPE_BACK
                batch.fillRect(bigScopeX, bigScopeY, bigScopeW, bigScopeH)

                // Highlight border behind the selected status panel.
                batch.color = COL_ACTIVE
                val selX = statusX(selectedPlayhead)
                batch.fillRect(selX - 2, statusY - 2, statusW + 4, statusH + 4)

                batch.color = COL_WELL
                for (i in 0..3) batch.fillRect(statusX(i), statusY, statusW, statusH)
            }

            // ── Big scope contents — only the selected playhead ────────────────────────
            drawSoundscope(adev, playheads[selectedPlayhead], batch, selectedPlayhead,
                bigScopeX.toFloat(), bigScopeY.toFloat(), bigScopeW, bigScopeH)

            // ── All four status LCDs along the bottom ──────────────────────────────────
            // Use the same (9, 9) inset from the panel as the original layout, so the
            // existing label-positioning math inside drawStatusLCD still fits cleanly.
            for (i in 0..3) {
                drawStatusLCD(adev, playheads[i], batch, i,
                    statusX(i).toFloat() + 9f, statusY.toFloat() + 9f)
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
            // "P{n+1}" tag — bright on the selected playhead so the panel-as-button
            // affordance is obvious.
            batch.color = if (index == selectedPlayhead) COL_ACTIVE else Color.WHITE
            FONT.draw(batch, "P${index + 1}", x, y)

            batch.color = Color.WHITE
            // PLAY icon (shifted right to make room for the playhead tag)
            if (ahead.isPlaying)
                FONT.draw(batch, STR_PLAY, x + 21, y)
            FONT.draw(batch, if (ahead.isPcmMode) "PCM" else "TRACKER", x + 42, y)

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
                FONT.drawRalign(batch, "${ahead.trackerState?.cuePos?.toString(16)?.uppercase()?.padStart(3,'0')}:${ahead.trackerState?.rowIndex?.toString()?.uppercase()?.padStart(2,'0')}", x + 84, y + 2*FONT.H)
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

    /**
     * Find the most-recent rising-edge zero crossing in [buf] that has at least
     * [cellW]/2 samples of context on either side, and return its position as a
     * sub-sample-accurate "age" (samples since the oldest sample at [writePos]).
     * Returns -1.0 if no usable crossing exists — the caller should then fall back
     * to a free-running display.
     */
    private fun findTriggerAge(buf: FloatArray, writePos: Int, cellW: Int): Double {
        val bufSize = buf.size
        val mask = bufSize - 1
        val halfW = cellW / 2
        val maxAge = bufSize - halfW          // exclusive: rightmost trigger that still has cellW/2 right-side samples
        val minAge = halfW                    // inclusive: leftmost trigger that still has cellW/2 left-side samples
        if (maxAge - 1 <= minAge) return -1.0 // cell is too wide vs the buffer

        // Walk newest → oldest within the search window. The most-recent crossing gives
        // the freshest snapshot on the right of the trigger, so the eye sees the least lag.
        var newer = buf[(writePos + maxAge - 1) and mask]
        for (age in maxAge - 2 downTo minAge) {
            val older = buf[(writePos + age) and mask]
            if (older < 0f && newer >= 0f) {
                // Linear interpolation between the two bracketing samples.
                val denom = (newer - older)
                val frac = if (denom > 1e-9f) (-older) / denom else 0f
                return age + frac.toDouble()
            }
            newer = older
        }
        return -1.0
    }

    /**
     * Pick a cols × rows grid for `n` waveform cells inside an `areaW × areaH` box.
     * Optimises for cell aspect close to [targetAspect] (in log-space, so 6:1 and 1.5:1
     * are penalised equally relative to 3:1) and lightly penalises wasted cells. Wide
     * scope areas naturally get more columns than rows; tall ones flip the other way.
     */
    private fun pickWaveformGrid(n: Int, areaW: Int, areaH: Int): IntArray {
        val targetAspect = 3.0
        val wastePenalty = 0.3
        var bestCols = 1
        var bestRows = n
        var bestScore = Double.POSITIVE_INFINITY
        for (cols in 1..n) {
            val rows = (n + cols - 1) / cols
            val cellW = areaW.toDouble() / cols
            val cellH = areaH.toDouble() / rows
            val aspect = cellW / cellH
            val score = abs(ln(aspect / targetAspect)) + wastePenalty * (cols * rows - n)
            if (score < bestScore) {
                bestScore = score
                bestCols = cols
                bestRows = rows
            }
        }
        return intArrayOf(bestCols, bestRows)
    }

    private val VOX_PER_VIEW = arrayOf(10,20,20)
    private val VOL_SYM = arrayOf('@','^','&',' ')
    private val PAN_SYM = arrayOf('@','<','>',' ')

    private fun drawSoundscope(audio: AudioAdapter, ahead: AudioAdapter.Playhead, batch: SpriteBatch, index: Int, x: Float, y: Float, w: Int, h: Int) {
        val gdxadev = ahead.audioDevice
        val bytes = gdxadev.extortField<ByteArray>("bytes")
        val bytesLen = gdxadev.extortField<Int>("bytesLength")!!
        val envelopeHalfHeight = h / 4
        val lCenterY = h / 4
        val rCenterY = 3 * h / 4
        val patOffY = 0

        batch.inUse {
            if (ahead.isPcmMode && bytes != null) {
                val smpCnt = bytesLen / 4 - 1

                try {
                    for (s in 0 until w) {
                        val i = (smpCnt * (s / (w - 1).toDouble())).roundToInt().and(0xfffffe)

                        val smpL =
                            (bytes[i * 4].toUint() or bytes[i * 4 + 1].toUint().shl(8)).u16Tos16().toDouble().div(32767)
                        val smpR = (bytes[i * 4 + 2].toUint() or bytes[i * 4 + 3].toUint().shl(8)).u16Tos16().toDouble()
                            .div(32767)

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
                            batch.fillRect(x + s, y + lCenterY, 1, smpLHi2)
                        }
                        if (smpRHi != smpRHi2) {
                            batch.color = COL_SOUNDSCOPE_FORE.cpy().mul(smpRHe)
                            batch.fillRect(x + s, y + rCenterY, 1, smpRHi2)
                        }

                        // base texture
                        batch.color = COL_SOUNDSCOPE_FORE
                        batch.fillRect(x + s, y + lCenterY, 1, smpLHi)
                        batch.fillRect(x + s, y + rCenterY, 1, smpRHi)
                    }

                    // PCM Samples count — drawn inside the scope (top-left) since the status
                    // panels no longer sit beside it in the new single-scope layout.
                    batch.color = Color.WHITE
                    FONT.draw(batch, "Samples", x + 4, y + patOffY)
                    batch.color = COL_ACTIVE3
                    FONT.draw(batch, "${smpCnt + 1}", x + 4 + 8 * FONT.W, y + patOffY)
                }
                catch (_: ArrayIndexOutOfBoundsException) {}
            }
            else {
                // Tracker pattern visualiser.
                // Modes: 0=detailed pattern, 1=abridged (stub), 2=super-abridged (stub), 3=cuesheet detail
                val ts = ahead.trackerState
                if (ts == null) {
                    batch.color = COL_SOUNDSCOPE_FORE
                    FONT.draw(batch, "No tracker state", x, y + patOffY)
                } else {
                    val cuePos = ts.cuePos
                    val rowIdx = ts.rowIndex
                    // Rows scale with available height — the original 17-row layout was sized
                    // for the old 108-pixel scope; the big scope can show many more rows.
                    val ROWS   = (h / TINY.H).coerceAtLeast(1)
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
                                val ry = y + patOffY +  r * TINY.H

                                if (here) {
                                    batch.color = COL_TRACKER_ROW
                                    batch.fillRect(x, ry, w, TINY.H)
                                }

                                var cx = x
                                // cursor + cue number
                                batch.color = if (here) Color.WHITE else COL_SOUNDSCOPE_FORE
                                TINY.draw(batch, "${ci.toString(16).padStart(3, '0').uppercase()}|", cx, ry)
                                cx += 4 * TINY.W

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

                        // ── Mode 4: Per-voice waveform ───────────────────────────────────
                        // Tile one waveform cell per "currently used" voice (cue-sheet
                        // pattern number != 0xFFF). The soundscope area is wide and short,
                        // so a cols × rows grid uses the space far better than a vertical
                        // stack — pickWaveformGrid() picks a layout that keeps cells roughly
                        // 3:1 wide while minimising empty slots.
                        4 -> {
                            val cuePats = IntArray(20) { vi -> readCuePat12(audio, cuePos, vi) }
                            val activeVoiceIndices = (0 until 20).filter { cuePats[it] != 0xFFF }
                            if (activeVoiceIndices.isEmpty()) {
                                batch.color = COL_SOUNDSCOPE_FORE
                                FONT.draw(batch, "No active voices", x, y + 4)
                            } else {
                                val scopeH = h
                                val scopeW = w
                                val n = activeVoiceIndices.size
                                val grid = pickWaveformGrid(n, scopeW, scopeH)
                                val cols = grid[0]
                                val rows = grid[1]
                                val cellW = scopeW / cols
                                val cellH = scopeH / rows
                                val halfH = ((cellH - 2) / 2).coerceAtLeast(1)
                                val voices = ts.voices
                                val drawLabel = cellH >= TINY.H + 1 && cellW >= 12

                                // Faint grid separators between cells.
                                batch.color = COL_TRACKER_ROW
                                for (r in 1 until rows) batch.fillRect(x, y + r * cellH, scopeW, 1)
                                for (c in 1 until cols) batch.fillRect(x + c * cellW, y, 1, scopeH)

                                for ((slot, vi) in activeVoiceIndices.withIndex()) {
                                    val voice = voices.getOrNull(vi) ?: continue
                                    val col = slot % cols
                                    val row = slot / cols
                                    val cellX = x + col * cellW
                                    val cellY = y + row * cellH
                                    val centerY = cellY + cellH / 2

                                    // baseline
                                    batch.color = COL_TRACKER_ROW
                                    batch.fillRect(cellX, centerY, cellW, 1)

                                    // waveform — anchor the cell centre on the most recent
                                    // sub-sample-accurate rising-edge zero crossing so that
                                    // periodic signals appear stationary (oscilloscope trigger).
                                    // Falls back to a free-running, oldest→newest sweep when no
                                    // usable trigger is found (e.g. silent voice or sub-sub-Hz tone).
                                    batch.color = COL_VOICE_PALETTE[vi % COL_VOICE_PALETTE.size]
                                    val buf = voice.scopeBuffer
                                    val bufSize = buf.size
                                    val mask = bufSize - 1
                                    val writePos = voice.scopeWritePos
                                    val centerCol = cellW / 2
                                    val triggerAge = findTriggerAge(buf, writePos, cellW)
                                    val freeRunStep = (bufSize - 1).toDouble() / (cellW - 1).coerceAtLeast(1)
                                    for (sx in 0 until cellW) {
                                        val readAge = if (triggerAge >= 0.0)
                                            triggerAge + (sx - centerCol).toDouble()
                                        else
                                            sx * freeRunStep
                                        val baseAge = floor(readAge).toInt()
                                        val frac = (readAge - baseAge).toFloat()
                                        val a = buf[(writePos + baseAge) and mask]
                                        val b = buf[(writePos + baseAge + 1) and mask]
                                        val v = ((1f - frac) * a + frac * b).coerceIn(-1f, 1f)
                                        val h = (v * halfH).roundToInt()
                                        if (h == 0) {
                                            batch.fillRect(cellX + sx, centerY, 1, 1)
                                        } else if (h > 0) {
                                            batch.fillRect(cellX + sx, centerY, 1, h)
                                        } else {
                                            batch.fillRect(cellX + sx, centerY + h, 1, -h)
                                        }
                                    }

                                    // voice index label (top-left of cell), only when there is room
                                    if (drawLabel) {
                                        batch.color = COL_VOICE_PALETTE[vi % COL_VOICE_PALETTE.size]
                                        TINY.draw(batch, (vi+1).toString().padStart(2, '0').uppercase(),
                                            cellX + 1, cellY + 1)
                                    }
                                }
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
                                    x, y + patOffY +  r * TINY.H)
                            }

                            // Vertical separator
                            batch.color = COL_SOUNDSCOPE_FORE
                            for (r in 0 until ROWS) TINY.draw(batch, "|", x + cueW, y + patOffY +  r * TINY.H)
                             */

                            // Pattern index for each voice in current cue
                            val cuePats = IntArray(20) { vi -> readCuePat12(audio, cuePos, vi) }

                            // Pattern rows (right area, 8 rows centred on current row)
                            // Layout: > rr NOTE in E.Vo E.Pn Eff ffff [voice1 …]
                            //          1  2    4  2    4    4   2    4
                            val rowFirst = (rowIdx - ROWS / 2).coerceAtLeast(0).coerceAtMost(PTN_MAX_ROWS - ROWS + 1)
                            for (r in 0 until ROWS) {
                                val ri = rowFirst + r
                                if (ri > PTN_MAX_ROWS) break
                                val here = ri == rowIdx
                                val ry = y + patOffY +  r * TINY.H

                                if (here) {
                                    batch.color = COL_TRACKER_ROW
                                    batch.fillRect(patX, ry, w - cueW - sepW, TINY.H)
                                }

                                var cx = patX

                                // cursor + row number (drawn once per row)
                                batch.color = if (here) Color.WHITE else COL_SOUNDSCOPE_FORE
//                                TINY.draw(batch, if (here) ">" else " ", cx, ry)
//                                cx += TINY.W
                                TINY.draw(batch, ri.toString().padStart(2, '0').uppercase(), cx, ry)
                                cx += 2 * TINY.W

                                for (vi in scopeScrollHorz[index] until (VOICES + scopeScrollHorz[index]).coerceAtMost(19)) {
                                    val pat12 = cuePats[vi]
                                    if (pat12 == 0xFFF) {
                                        if (vi == scopeScrollHorz[index]) {
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

                                        // perform correct bank change
                                        audio.mmio_write(2, (pat12 ushr 8).toByte())
                                        audio.mmio_write(3, (pat12 ushr 8).toByte())

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
                                        var instStr = instr.toString(16).padStart(2, '0').uppercase()
                                        if (instr == 0) {
                                            instStr = "@@"
                                        }

                                        // note
                                        batch.color = if (here) Color.WHITE else COL_NOTE
                                        TINY.draw(batch, noteStr, cx, ry)
                                        cx += 4 * TINY.W
                                        // instrument
                                        batch.color = if (here) Color.WHITE else COL_INST
                                        TINY.draw(batch, instStr, cx, ry)
                                        cx += 2 * TINY.W
                                        if (scopeMode[index] == 0) {
                                            // volume
                                            batch.color = if (here) Color.WHITE else COL_VOL
                                            var text = if (volByte == 0xC0) "@@@" else "${VOL_SYM[volEff]}${vol.toString().padStart(2, '0')}"
                                            // is this fine slide?
                                            if (volEff == 3 && vol != 0) {
                                                val dir = if (vol and 32 == 1) '+' else '-'
                                                text = "$dir${(vol and 31).toString().padStart(2,'0').uppercase()}"
                                            }
                                            TINY.draw(batch, text, cx, ry)
                                            cx += 3 * TINY.W
                                        }
                                        else if (scopeMode[index] == 1) {
                                            batch.color = if (here) Color.WHITE else COL_VOL
                                            TINY.draw(batch, vol.toString().padStart(2, '0'), cx, ry)
                                            cx += 2 * TINY.W
                                        }
                                        // pan
                                        if (scopeMode[index] == 0) {
                                            var text = if (panByte == 0xC0) "@@@" else "${PAN_SYM[panEff]}${pan.toString().padStart(2, '0')}"
                                            // is this fine slide?
                                            if (panEff == 3 && pan != 0) {
                                                val dir = if (pan and 32 == 1) '+' else '-'
                                                text = "$dir${(pan and 31).toString().padStart(2,'0').uppercase()}"
                                            }
                                            batch.color = if (here) Color.WHITE else COL_PAN
                                            TINY.draw(batch, text, cx, ry)
                                            cx += 3 * TINY.W
                                        }
                                        if (scopeMode[index] == 0) {
                                            var effSymStr = eff.toString(36).uppercase()
                                            var effArgStr = effArg.toString(16).padStart(4, '0').uppercase()

                                            if (eff == 0 && effArg == 0) {
                                                effSymStr = "@@"
                                                effArgStr = "@@@@"
                                            }

                                            // effect opcode
                                            batch.color = if (here) Color.WHITE else COL_EFF
                                            TINY.draw(batch, effSymStr, cx, ry)
                                            cx += 1 * TINY.W
                                            // effect argument
                                            batch.color = if (here) Color.WHITE else COL_EFFARG
                                            TINY.draw(batch, effArgStr, cx, ry)
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
