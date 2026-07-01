package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.tsvm.peripheral.AudioAdapter
import net.torvald.tsvm.peripheral.MP2Env

/**
 * Each playhead is separate OpenAL device with its own PCM sample buffers.
 * Media decoders (MP2, TAD) are independent to the playheads and there is only one.
 *
 * NOTES:
 * 1. Synchronisation between playheads are not guaranteed. Do not play music in multiple tracks.
 *
 * ## How to use Tracker Mode
 *
 * 1. Call `setTrackerMode(playhead)` to switch to tracker mode.
 * 2. Write sample data into the sample bin via `vm.poke` (peripheral memory space, offset 0+).
 * 3. Define instruments via `uploadInstrument(slot, byteArray)` or raw `vm.poke`.
 * 4. Define patterns via `uploadPattern(slot, byteArray)` or raw `vm.poke`.
 * 5. Define cue entries via `uploadCue(idx, byteArray)` or raw `vm.poke`.
 * 6. Set `setBPM(playhead, bpm)` and `setTickRate(playhead, rate)`.
 * 7. Set `setMasterVolume(playhead, 255)`.
 * 8. Call `setCuePosition(playhead, 0)` then `play(playhead)`.
 *
 * Note values: 0x4000 = C3 (sample's native pitch), 4096 steps per octave.
 * Empty row: note = 0x0000 (no trigger). Note sentinels (0x0000..0x001F): 0x0000 = no-op,
 * 0x0001 = key-off, 0x0002 = note cut, 0x0003 = note fade (IT-style, by instrument fadeout),
 * 0x0004 = fast fade, 0x0010..0x001F = Int0..IntF (interrupt notes — produce no sound; the engine
 * latches them for the host to dispatch via pollTrackerInterrupts / taud.mjs attachIntCallback).
 * Valid playable notes are 0x0020..0xFFFF. A pattern cell addresses instrument slots
 * 0-255 (the directly-addressable bin $00..$FF). Slots 256-511 are the auxiliary bin
 * $100..$1FF, reachable only as Metainstrument layers (not from a pattern cell).
 *
 * ## How to upload PCM audio into a playhead
 *
 * 1. prepare PCM data
 * 2. queue up PCM data by `audio.putPcmDataByPtr(pcmDataPtr, pcmDataLength, playhead)`
 * 3. specify PCM upload length by `audio.setSampleUploadLength(playhead, pcmDataLength)`
 * 4. start uploading `audio.startSampleUpload(playhead)`
 * 5. sample will be ready after a few microseconds.
 *
 * Uploaded samples will be queued by the playhead for gapless playback
 *
 * Created by minjaesong on 2022-12-31.
 */
class AudioJSR223Delegate(private val vm: VM) {

    private fun getFirstSnd(): AudioAdapter? {
        val a = vm.findPeribyType(VM.PERITYPE_SOUND)?.peripheral as? AudioAdapter
//        println("get AudioAdapter: $a; vm: $vm")
        return a
    }
    private fun getPlayhead(playhead: Int) = getFirstSnd()?.playheads?.get(playhead)

    fun setPcmMode(playhead: Int) { getPlayhead(playhead)?.isPcmMode = true }
    fun isPcmMode(playhead: Int) = getPlayhead(playhead)?.isPcmMode == true

    fun setTrackerMode(playhead: Int) { getPlayhead(playhead)?.isPcmMode = false }
    fun isTrackerMode(playhead: Int) = getPlayhead(playhead)?.isPcmMode == false

    fun setMasterVolume(playhead: Int, volume: Int) { getPlayhead(playhead)?.apply {
        masterVolume = volume and 255
        audioDevice.setVolume(masterVolume / 255f)
    } }
    fun getMasterVolume(playhead: Int) = getPlayhead(playhead)?.masterVolume

    fun setMasterPan(playhead: Int, pan: Int) { getPlayhead(playhead)?.masterPan = pan and 255 }
    fun getMasterPan(playhead: Int) = getPlayhead(playhead)?.masterPan

    fun play(playhead: Int) { getPlayhead(playhead)?.isPlaying = true }
    fun stop(playhead: Int) { getPlayhead(playhead)?.isPlaying = false }
    fun isPlaying(playhead: Int) = getPlayhead(playhead)?.isPlaying

    /**
     * Audition a single note on [voice] of a tracker-mode [playhead] WITHOUT starting song
     * playback — the note sounds immediately and its envelope/filter evolve, but rows/cues do
     * not advance. Intended for note-jamming in an editor (taut). [note] is the 16-bit pattern
     * note word (0x0020..0xFFFF playable; 0x0001 key-off / 0x0002 cut also work), [inst] the
     * instrument slot to trigger with (0-511; 256-511 = aux bin, so the editor can audition a
     * Metainstrument-layer subinstrument). No-op in PCM mode. Stop it with [jamStop].
     */
    fun jamNote(playhead: Int, voice: Int, note: Int, inst: Int) {
        val ad = getFirstSnd() ?: return
        val ph = getPlayhead(playhead) ?: return
        ad.jamNote(ph, voice, note and 0xFFFF, inst and 0x1FF)
    }

    /** Silence any audition started by [jamNote] on this [playhead]. */
    fun jamStop(playhead: Int) {
        val ad = getFirstSnd() ?: return
        val ph = getPlayhead(playhead) ?: return
        ad.jamStop(ph)
    }

    /** Lowest-numbered playhead that is not currently playing, so a player app can
     *  "occupy" an idle playhead instead of always clobbering playhead 0. Returns
     *  [fallback] when every playhead is busy (or no audio device is present). */
    fun getFreePlayhead(fallback: Int): Int {
        val playheads = getFirstSnd()?.playheads ?: return fallback
        for (i in playheads.indices) {
            if (!playheads[i].isPlaying) return i
        }
        return fallback
    }

//    fun setPosition(playhead: Int, pos: Int) { getPlayhead(playhead)?.position = pos and 65535 }
    fun getPosition(playhead: Int) = getPlayhead(playhead)?.position

    fun setSampleUploadLength(playhead: Int, length: Int) { getPlayhead(playhead)?.pcmUploadLength = length and 65535 }

//    fun setSamplingRate(playhead: Int, rate: Int) { getPlayhead(playhead)?.setSamplingRate(rate) }
//    fun getSamplingRate(playhead: Int) = getPlayhead(playhead)?.getSamplingRate()

    fun startSampleUpload(playhead: Int) { getPlayhead(playhead)?.pcmUpload = true }

    fun setBPM(playhead: Int, bpm: Int) { getPlayhead(playhead)?.bpm = bpm.coerceIn(25, 535) }
    fun getBPM(playhead: Int) = getPlayhead(playhead)?.bpm

    fun setTickRate(playhead: Int, rate: Int) { getPlayhead(playhead)?.tickRate = rate and 255 }
    fun getTickRate(playhead: Int) = getPlayhead(playhead)?.tickRate

    fun setCuePosition(playhead: Int, pos: Int) {
        getPlayhead(playhead)?.let { ph ->
            ph.position = pos and 1023
            ph.trackerState?.cuePos = ph.position
        }
    }
    fun getCuePosition(playhead: Int) = getPlayhead(playhead)?.position

    fun getTrackerRow(playhead: Int) = getPlayhead(playhead)?.trackerState?.rowIndex ?: 0

    /** Drain and return the playhead's pending interrupt-note latch: a 16-bit mask where bit n is set
     *  if interrupt note IntN (note word 0x0010+n) was encountered since the last call. Reading clears
     *  the latch (read-to-acknowledge), so the mask accumulates every IntN fired between two reads and
     *  none is lost. Repeated fires of the SAME interrupt within one read window collapse into one bit.
     *  Returns 0 in PCM mode or when no interrupts are pending. Consumed by taud.mjs pollInterrupts. */
    fun pollTrackerInterrupts(playhead: Int): Int =
        getPlayhead(playhead)?.trackerState?.pendingInterrupts?.getAndSet(0) ?: 0

    /** Mute is now a thin wrapper over the per-voice fader: muting writes 255 (silence),
     *  unmuting clears the fader back to 0 (unity). Callers that want a partial attenuation
     *  should use setVoiceFader directly. */
    fun setVoiceMute(playhead: Int, voice: Int, muted: Boolean) {
        getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19))?.fader = if (muted) 255 else 0
    }
    fun getVoiceMute(playhead: Int, voice: Int): Boolean =
        (getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19))?.fader ?: 0) == 255

    /** Externally-controlled per-voice fader. 0 = unity, 255 = silence; values are masked to 8 bits.
     *  Mirrors MMIO 4098.. (256 bytes per playhead, first 20 entries map to live voice slots). */
    fun setVoiceFader(playhead: Int, voice: Int, fader: Int) {
        getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19))?.fader = fader and 255
    }
    fun getVoiceFader(playhead: Int, voice: Int): Int =
        getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19))?.fader ?: 0

    /** Effective per-voice tracker volume (0.0..1.0) — what the mixer applies right now after the
     *  envelope, fadeout, vol-column / D-slide / tremolo ramp, and the host-owned per-voice fader,
     *  but BEFORE master/mixing/global volumes. Returns 0.0 for inactive voices. Mirrors the
     *  perVoiceGain assembled in the per-sample mix loop (AudioAdapter.kt:3201). */
    fun getVoiceEffectiveVolume(playhead: Int, voice: Int): Double {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 0.0
        if (!v.active) return 0.0
        val effEnvVol = if (v.volEnvOn) v.envVolMix else 1.0
        val faderGain = (255 - v.fader) / 255.0
        return (effEnvVol * v.fadeoutVolume * v.currentMixVolume * faderGain).coerceIn(0.0, 1.0)
    }

    /** Effective per-voice tracker pan (0..255, 128 = centre) — channelPan modulated by the pan
     *  envelope when it is active. Returns 128 (centre) for inactive voices. Mirrors the pan
     *  selection in the per-sample mix loop (AudioAdapter.kt:3205). */
    fun getVoiceEffectivePan(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 128
        if (!v.active) return 128
        return if (v.hasPanEnv && v.panEnvOn) {
            val envPanRaw = (v.envPan * 255.0).toInt().coerceIn(0, 255)
            (v.channelPan + envPanRaw - 128).coerceIn(0, 255)
        } else v.channelPan.coerceIn(0, 255)
    }

    /** Whether the voice slot is currently sounding (i.e. owns an active sample). Mirrors
     *  `Voice.active` which is the source of truth for "is this voice contributing to the mix
     *  right now". Visualisers should treat this as the authoritative on/off bit. */
    fun getVoiceActive(playhead: Int, voice: Int): Boolean =
        getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19))?.active == true

    /** Active-note counts per instrument id (index 0..511; 256..511 = aux bin, where a
     *  Metainstrument's layer voices count): how many notes are sounding *right now* for each
     *  instrument, counting ~~BOTH~~ the live foreground voices ~~and the NNA background
     *  ghosts in the mixer-private pool~~~. Lets visualisers colour by polyphony. The ghost pool is
     *  mutated by the render thread, so it is read defensively by index and any transient
     *  inconsistency is tolerated (a single best-effort frame). */
    fun getActiveNoteCounts(playhead: Int): IntArray {
        val counts = IntArray(512)
        val ts = getPlayhead(playhead)?.trackerState ?: return counts
        for (v in ts.voices) {
            if (v.active) counts[v.instrumentId and 0x1FF]++
        }
        // disabling NNA for now
        /*try {
            val bg = ts.backgroundVoices
            for (i in 0 until bg.size) {
                val v = bg.getOrNull(i) ?: continue
                if (v.active) counts[v.instrumentId and 0x1FF]++
            }
        } catch (_: Exception) { /* ghost pool mutated mid-read — counts are best-effort */ }
        */
        return counts
    }

    /** Funk-repeat (S$Fx) speed currently driving the voice: 0 = off, otherwise the per-tick
     *  accumulator increment. A non-zero value on an active voice means the voice is live-inverting
     *  its instrument's loop region right now — visualisers can use this to gate the funk overlay. */
    fun getVoiceFunkSpeed(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 0
        if (!v.active) return 0
        return v.funkSpeed
    }

    /** Snapshot of an instrument's funk-repeat XOR mask (one bit per loop-region byte; a set bit
     *  flips that byte by 0xFF during playback). Returns the mask bytes as ints (0..255), or an
     *  empty array when the instrument has never been funk-repeated. The render thread mutates the
     *  live mask, so this returns a copy — the caller gets a stable single-frame view. */
    fun getInstrumentFunkMask(slot: Int): IntArray {
        val mask = getFirstSnd()?.instruments?.get(slot and 0x1FF)?.funkMask ?: return IntArray(0)
        return IntArray(mask.size) { mask[it].toInt() and 0xFF }
    }

    /** Live noteVal (0..65535, 4096-TET) of the foreground voice — the value the mixer is using
     *  *right now* including any in-flight vibrato / arpeggio / portamento delta. Returns 0 for
     *  inactive voices. */
    fun getVoiceNote(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 0
        if (!v.active) return 0
        return v.noteVal and 0xFFFF
    }

    /** Instrument id (0..255) currently bound to the voice slot, or 0 if the voice is inactive. */
    fun getVoiceInstrument(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 0
        if (!v.active) return 0
        return v.instrumentId and 0x1FF   // 0..511 (256..511 = aux bin); a meta layer plays an aux slot
    }

    /** Current sample-frame playback position (fractional double) of the voice. Returns -1.0
     *  when the voice is inactive so visualisers can distinguish "no cursor" from "cursor at 0". */
    fun getVoiceSamplePos(playhead: Int, voice: Int): Double {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return -1.0
        if (!v.active) return -1.0
        return v.samplePos
    }

    /** Sample pointer (byte offset into the 8 MB pool) of the sample the voice is ACTUALLY
     *  sounding right now — the resolved Ixmp patch sample, not just the base record. Returns
     *  -1 when the voice is inactive. Together with [getVoiceSampleLength] this is the (ptr,len)
     *  identity of the deduped sample, so visualisers can light only the truly-playing sample of
     *  a multisample instrument instead of every sample the instrument references. */
    fun getVoiceSamplePtr(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return -1
        if (!v.active) return -1
        return v.activeSamplePtr
    }

    /** Sample length (bytes) of the sample the voice is actually sounding — see [getVoiceSamplePtr].
     *  Returns 0 when inactive (a real sample is always ≥ 1 byte, so 0 is an unambiguous "none"). */
    fun getVoiceSampleLength(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 0
        if (!v.active) return 0
        return v.activeSampleLength
    }

    /** Volume-envelope segment index — i.e. the node the voice is currently moving *away* from
     *  (the next node it will hit is index + 1). Returns -1 when inactive. */
    fun getVoiceEnvVolIndex(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return -1
        if (!v.active) return -1
        return v.envIndex
    }
    /** Seconds elapsed *into* the current volume-envelope segment (0 ≤ t < segment.offset). */
    fun getVoiceEnvVolTime(playhead: Int, voice: Int): Double {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 0.0
        if (!v.active) return 0.0
        return v.envTimeSec
    }

    /** Pan-envelope segment index — see [getVoiceEnvVolIndex]. */
    fun getVoiceEnvPanIndex(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return -1
        if (!v.active) return -1
        return v.envPanIndex
    }
    /** Seconds elapsed into the current pan-envelope segment. */
    fun getVoiceEnvPanTime(playhead: Int, voice: Int): Double {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 0.0
        if (!v.active) return 0.0
        return v.envPanTimeSec
    }

    /** Pitch-envelope segment index — see [getVoiceEnvVolIndex]. */
    fun getVoiceEnvPitchIndex(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return -1
        if (!v.active) return -1
        return v.envPitchIndex
    }
    /** Seconds elapsed into the current pitch-envelope segment. */
    fun getVoiceEnvPitchTime(playhead: Int, voice: Int): Double {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 0.0
        if (!v.active) return 0.0
        return v.envPitchTimeSec
    }

    /** Filter-envelope segment index — see [getVoiceEnvVolIndex]. The pitch and filter
     *  envelopes are independent now (two pf-slots), so each role has its own playhead. */
    fun getVoiceEnvFilterIndex(playhead: Int, voice: Int): Int {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return -1
        if (!v.active) return -1
        return v.envFilterIndex
    }
    /** Seconds elapsed into the current filter-envelope segment. */
    fun getVoiceEnvFilterTime(playhead: Int, voice: Int): Double {
        val v = getPlayhead(playhead)?.trackerState?.voices?.getOrNull(voice.coerceIn(0, 19)) ?: return 0.0
        if (!v.active) return 0.0
        return v.envFilterTimeSec
    }

    /** Set the starting row for the next play call, resetting per-row timing and silencing active voices. */
    fun setTrackerRow(playhead: Int, row: Int) {
        getPlayhead(playhead)?.trackerState?.let { ts ->
            ts.rowIndex = row.coerceIn(0, 63)
            ts.tickInRow = 0
            ts.samplesIntoTick = 0.0
            ts.firstRow = true
            ts.pendingOrderJump = -1
            ts.pendingRowJump = -1
            ts.voices.forEach { it.active = false }
        }
    }

    /** Upload up to 256 bytes defining instrument `slot` (0-511; 256..511 = aux bin). (The record was
     *  widened from 192 to 256 bytes on 2026-05-06; the old cap silently dropped
     *  the pan/pf SUSTAIN-word tails, DCT/DCA and the Default Note Volume byte.) */
    fun uploadInstrument(slot: Int, bytes: IntArray) {
        getFirstSnd()?.instruments?.get(slot and 0x1FF)?.let { inst ->
            val rec = IntArray(256)
            for (i in 0 until minOf(256, bytes.size)) rec[i] = bytes[i] and 0xFF
            inst.loadRecord(rec)   // detects the Metainstrument sentinel; else per-byte fields
        }
    }

    /** Upload an Ixmp "extra samples" block for instrument [slot] (0-511). Patches are
     *  VARIABLE LENGTH (since 2026-06-13): each begins with a version byte (feature
     *  bit-flags 0b x00Pfpvi) + 30 common bytes, optionally followed by the x/v/p/f/P
     *  blocks in that order — see terranmon.txt "Ixmp. Instrument extra samples". A
     *  version byte with only the 'i' bit set is the legacy 31-byte record. Passing an
     *  empty array clears any previously-installed patches on this instrument. */
    fun uploadInstrumentPatches(slot: Int, bytes: IntArray) {
        val inst = getFirstSnd()?.instruments?.get(slot and 0x1FF) ?: return
        if (bytes.size < 31) { inst.extraPatches = null; return }
        fun u8 (o: Int) = bytes[o] and 0xFF
        fun u16(o: Int) = (bytes[o] and 0xFF) or ((bytes[o + 1] and 0xFF) shl 8)
        fun s16(o: Int): Int { val v = u16(o); return if (v >= 0x8000) v - 0x10000 else v }
        fun u32(o: Int) =  (bytes[o]     and 0xFF)        or
                          ((bytes[o + 1] and 0xFF) shl 8) or
                          ((bytes[o + 2] and 0xFF) shl 16) or
                          ((bytes[o + 3] and 0xFF) shl 24)
        val patches = ArrayList<AudioAdapter.TaudInstPatch>()
        var o = 0
        while (o + 31 <= bytes.size) {
            val ver = u8(o)
            var p = o + 31                       // version byte + 30 common bytes
            // Optional blocks, walked in the canonical on-wire order x, v, p, f, P.
            var hasExtra = false; var fadeoutStep = 0; var extraCutoff = 0xFF; var extraResonance = 0xFF
            var extraAttenOctet = 0; var filterSfMode = false
            if (ver and 0x80 != 0) {             // 'x' block (15 bytes): u32 flags1 + u32 flags2 + u16 fadeout + u16 cutoff + u16 reson + u8 initialAttenuation octet
                if (p + 15 > bytes.size) break
                filterSfMode = (u8(p) and 0x01) != 0           // flags1 bit 0: 0 = IT filter, 1 = SoundFont
                fadeoutStep = u16(p + 8); extraCutoff = u16(p + 10); extraResonance = u16(p + 12)
                extraAttenOctet = u8(p + 14)
                hasExtra = true; p += 15
            }
            fun readEnv(): Triple<Array<AudioAdapter.TaudInstEnvPoint>, Int, Int>? {
                if (p + 54 > bytes.size) return null
                val loop = u16(p); val sus = u16(p + 2)
                val arr = Array(25) { k ->
                    AudioAdapter.TaudInstEnvPoint(u8(p + 4 + 2 * k), ThreeFiveMiniUfloat(u8(p + 5 + 2 * k)))
                }
                p += 54
                return Triple(arr, loop, sus)
            }
            var volEnv: Array<AudioAdapter.TaudInstEnvPoint>? = null; var volLoop = 0; var volSus = 0
            var panEnv: Array<AudioAdapter.TaudInstEnvPoint>? = null; var panLoop = 0; var panSus = 0
            var filEnv: Array<AudioAdapter.TaudInstEnvPoint>? = null; var filLoop = 0; var filSus = 0
            var pitEnv: Array<AudioAdapter.TaudInstEnvPoint>? = null; var pitLoop = 0; var pitSus = 0
            if (ver and 0x02 != 0) { val e = readEnv() ?: break; volEnv = e.first; volLoop = e.second; volSus = e.third }
            if (ver and 0x04 != 0) { val e = readEnv() ?: break; panEnv = e.first; panLoop = e.second; panSus = e.third }
            if (ver and 0x08 != 0) { val e = readEnv() ?: break; filEnv = e.first; filLoop = e.second; filSus = e.third }
            if (ver and 0x10 != 0) { val e = readEnv() ?: break; pitEnv = e.first; pitLoop = e.second; pitSus = e.third }
            patches.add(AudioAdapter.TaudInstPatch(
                pitchStart        = u16(o + 1),
                pitchEnd          = u16(o + 3),
                volumeStart       = u8 (o + 5),
                volumeEnd         = u8 (o + 6),
                samplePtr         = u32(o + 7),
                sampleLength      = u16(o + 11),
                playStart         = u16(o + 13),
                loopStart         = u16(o + 15),
                loopEnd           = u16(o + 17),
                samplingRate      = u16(o + 19),
                sampleDetune      = s16(o + 21),
                loopMode          = u8 (o + 23),
                defaultPan        = u8 (o + 24),
                defaultNoteVolume = u8 (o + 25),
                vibratoSpeed      = u8 (o + 26),
                vibratoSweep      = u8 (o + 27),
                vibratoDepth      = u8 (o + 28),
                vibratoRate       = u8 (o + 29),
                vibratoWaveform   = u8 (o + 30),
                volEnv = volEnv, volEnvLoop = volLoop, volEnvSustain = volSus,
                panEnv = panEnv, panEnvLoop = panLoop, panEnvSustain = panSus,
                filterEnv = filEnv, filterEnvLoop = filLoop, filterEnvSustain = filSus,
                pitchEnv = pitEnv, pitchEnvLoop = pitLoop, pitchEnvSustain = pitSus,
                hasExtra = hasExtra, fadeoutStep = fadeoutStep, filterSfMode = filterSfMode,
                extraCutoff = extraCutoff, extraResonance = extraResonance,
                extraInitialAttenOctet = extraAttenOctet
            ))
            o = p
        }
        inst.extraPatches = if (patches.isEmpty()) null else patches.toTypedArray()
    }

    /** Number of Ixmp patches currently installed on instrument [slot], or 0 if none. */
    fun getInstrumentPatchCount(slot: Int): Int =
        getFirstSnd()?.instruments?.get(slot and 0x1FF)?.extraPatches?.size ?: 0

    /** Read back instrument [slot]'s Ixmp patches as a flat variable-length byte array in
     *  the upload wire format (exact inverse of [uploadInstrumentPatches]) so capture
     *  code can re-emit the Ixmp project-data section. Empty array when none. */
    fun getInstrumentPatches(slot: Int): IntArray {
        val patches = getFirstSnd()?.instruments?.get(slot and 0x1FF)?.extraPatches
            ?: return IntArray(0)
        val out = ArrayList<Int>(patches.size * 31)
        fun w8(v: Int)  { out.add(v and 0xFF) }
        fun w16(v: Int) { out.add(v and 0xFF); out.add((v ushr 8) and 0xFF) }
        fun w32(v: Int) { w16(v); w16(v ushr 16) }
        fun wEnv(env: Array<AudioAdapter.TaudInstEnvPoint>, loop: Int, sus: Int) {
            w16(loop); w16(sus)
            for (k in 0 until 25) { w8(env[k].value); w8(env[k].offset.index) }
        }
        patches.forEach { p ->
            // Reconstruct the version byte from which optional blocks are present.
            var ver = 0x01
            if (p.hasExtra)         ver = ver or 0x80
            if (p.volEnv != null)   ver = ver or 0x02
            if (p.panEnv != null)   ver = ver or 0x04
            if (p.filterEnv != null) ver = ver or 0x08
            if (p.pitchEnv != null) ver = ver or 0x10
            w8(ver)
            w16(p.pitchStart); w16(p.pitchEnd)
            w8(p.volumeStart); w8(p.volumeEnd)
            w32(p.samplePtr)
            w16(p.sampleLength); w16(p.playStart); w16(p.loopStart); w16(p.loopEnd)
            w16(p.samplingRate); w16(p.sampleDetune)     // two's complement round-trips
            w8(p.loopMode); w8(p.defaultPan); w8(p.defaultNoteVolume)
            w8(p.vibratoSpeed); w8(p.vibratoSweep); w8(p.vibratoDepth)
            w8(p.vibratoRate); w8(p.vibratoWaveform)
            // Blocks in the canonical on-wire order x, v, p, f, P.
            if (p.hasExtra) { w32(if (p.filterSfMode) 1 else 0); w32(0); w16(p.fadeoutStep); w16(p.extraCutoff); w16(p.extraResonance); w8(p.extraInitialAttenOctet) }
            p.volEnv?.let    { wEnv(it, p.volEnvLoop, p.volEnvSustain) }
            p.panEnv?.let    { wEnv(it, p.panEnvLoop, p.panEnvSustain) }
            p.filterEnv?.let { wEnv(it, p.filterEnvLoop, p.filterEnvSustain) }
            p.pitchEnv?.let  { wEnv(it, p.pitchEnvLoop, p.pitchEnvSustain) }
        }
        return out.toIntArray()
    }

    /** Clear any Ixmp patches previously uploaded to instrument [slot] (0-511; 256-511 = aux bin). */
    fun clearInstrumentPatches(slot: Int) {
        getFirstSnd()?.instruments?.get(slot and 0x1FF)?.extraPatches = null
    }

    /** Upload 512 bytes (64 rows × 8 bytes) defining pattern `slot` (0-4094). */
    fun uploadPattern(slot: Int, bytes: IntArray) {
        getFirstSnd()?.playdata?.get(slot and 0xFFF)?.let { pat ->
            for (i in 0 until minOf(512, bytes.size)) pat[i / 8].setByte(i % 8, bytes[i] and 0xFF)
        }
    }

    /** Upload 32 bytes defining cue entry `idx` (0-1023): packed 12-bit pattern numbers for 20 voices + instruction. */
    fun uploadCue(idx: Int, bytes: IntArray) {
        getFirstSnd()?.cueSheet?.get(idx and 0x3FF)?.let { cue ->
            for (i in 0 until minOf(32, bytes.size)) cue.write(i, bytes[i] and 0xFF)
        }
    }

    fun setTrackerMixerFlags(playhead: Int, flags: Int) {
        getFirstSnd()?.playheads?.get(playhead)?.let { ph ->
            ph.initialGlobalFlags = flags
            ph.updateTrackerGlobalBehaviour(flags)
        }
    }

    fun getTrackerMixerFlags(playhead: Int): Int? {
        return getFirstSnd()?.playheads?.get(playhead)?.initialGlobalFlags
    }

    fun setSongGlobalVolume(playhead: Int, volume: Int) { getPlayhead(playhead)?.globalVolume = volume and 255 }
    fun getSongGlobalVolume(playhead: Int) = getPlayhead(playhead)?.globalVolume

    fun setSongMixingVolume(playhead: Int, volume: Int) { getPlayhead(playhead)?.mixingVolume = volume and 255 }
    fun getSongMixingVolume(playhead: Int) = getPlayhead(playhead)?.mixingVolume

    fun putPcmDataByPtr(playhead: Int, ptr: Int, length: Int, destOffset: Int) {
        getFirstSnd()?.let {
            val vkMult = if (ptr >= 0) 1 else -1
            for (k in 0L until length) {
                val vk = k * vkMult
                it.pcmBin[playhead][k + destOffset] = vm.peek(ptr + vk)!!
            }
        }
    }

    /** Synchronously copy `length` bytes of PCMu8-stereo from `ptr` and enqueue them for playback,
     *  directly — like [mp2UploadDecoded]. The putPcmDataByPtr + setSampleUploadLength +
     *  startSampleUpload path hands off through the single-slot pcmBin/pcmUpload handshake serviced
     *  by WriteQueueingRunnable, which DROPS chunks when a caller queues several in a row (the
     *  next putPcmData overwrites pcmBin / clobbers pcmUploadLength before the thread copies it).
     *  Lost chunks make WAV/PCM playback skip and effectively fast-forward. Enqueue with no race. */
    fun queuePcmDataByPtr(playhead: Int, ptr: Int, length: Int) {
        if (length <= 0) return
        val snd = getFirstSnd() ?: return
        val ph = snd.playheads.getOrNull(playhead) ?: return
        val ba = ByteArray(length)
        if (ptr >= 0) {
            // user RAM — fast bulk copy
            UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + ptr, ba, UnsafeHelper.getArrayOffset(ba), length.toLong())
        } else {
            // peripheral memory grows toward 0 — read backwards, like putPcmDataByPtr
            for (k in 0 until length) ba[k] = vm.peek(ptr.toLong() - k.toLong())!!
        }
        ph.pcmQueue.add(ba)
        ph.position = ph.pcmQueue.size
    }
    fun getPcmData(playhead: Int, index: Int) = getFirstSnd()?.pcmBin?.get(playhead)?.get(index.toLong())

    fun setPcmQueueCapacityIndex(playhead: Int, index: Int) { getPlayhead(playhead)?.pcmQueueSizeIndex = index }
    fun getPcmQueueCapacityIndex(playhead: Int) = getPlayhead(playhead)?.pcmQueueSizeIndex
    fun getPcmQueueCapacity(playhead: Int) = getPlayhead(playhead)?.getPcmQueueCapacity()

    fun resetParams(playhead: Int) {
        getPlayhead(playhead)?.resetParams()
    }

    /** Clear funk-repeat (S$Fx) state (per-voice run-state + per-instrument loop-inversion masks)
     *  without disturbing tempo / volume / position. Call on a fresh play-from-start so stale funk
     *  state from a prior playback doesn't bleed into the replay. */
    fun resetFunkState(playhead: Int) {
        getPlayhead(playhead)?.resetFunkState()
    }

    fun purgeQueue(playhead: Int) {
        getPlayhead(playhead)?.purgeQueue()
    }




//    fun mp2Init() = getFirstSnd()?.mp2Env?.initialise()
    fun mp2GetInitialFrameSize(bytes: IntArray) = getFirstSnd()?.mp2Env?.getInitialFrameSize(bytes)
//    fun mp2DecodeFrame(mp2: MP2Env.MP2, framePtr: Long?, pcm: Boolean, outL: Long, outR: Long) = getFirstSnd()?.mp2Env?.decodeFrame(mp2, framePtr, pcm, outL, outR)

    fun getBaseAddr(): Int? = getFirstSnd()?.let { return it.vm.findPeriSlotNum(it)?.times(-131072)?.minus(1) }
    fun getMemAddr(): Int? = getFirstSnd()?.let { return it.vm.findPeriSlotNum(it)?.times(-1048576)?.minus(1) }

    /** Switch the sample-bin window (peripheral memory 0..524287) to bank `bank` (0..15).
     *  The 8 MB sample pool is organised as 16 × 512 K banks; only the selected bank
     *  is visible through the window. (terranmon.txt:1985-1997, MMIO 46.) */
    fun setSampleBank(bank: Int) { getFirstSnd()?.mmio_write(46L, bank.toByte()) }
    fun getSampleBank(): Int? = getFirstSnd()?.sampleBank

    /** Decompress a Taud sample+instrument blob (gzip or zstd) directly into the
     *  audio adapter's 8 MB sample pool and instrument bins, bypassing the user
     *  memory staging buffer. The decompressed payload is 8 MB samples followed by
     *  the instrument records: 128 K (512 records — the directly-addressable bin
     *  $00..$FF then the auxiliary bin $100..$1FF) for current files, or 64 K (256
     *  records, $00..$FF only) for legacy pre-2026-06-30 files, which is detected by
     *  the payload size. Slots not present in the blob are cleared.
     *
     *  Needed because user space is capped at 8 MB and cannot hold the full image as
     *  a contiguous buffer. */
    fun uploadSampleInstBlob(srcPtr: Int, srcLen: Int): Int {
        val snd = getFirstSnd() ?: return 0
        val inbytes = ByteArray(srcLen) { vm.peek(srcPtr.toLong() + it)!! }
        val bytes = CompressorDelegate.decomp(inbytes)
        val sampleSize = AudioAdapter.SAMPLE_BIN_TOTAL.toInt()
        if (bytes.size < sampleSize + 65536) return 0   // at least the directly-addressable bin
        UnsafeHelper.memcpyRaw(
            bytes, UnsafeHelper.getArrayOffset(bytes),
            null, snd.sampleBin.ptr,
            sampleSize.toLong()
        )
        // Records carried by the blob (256 = legacy $00..$FF only; 512 = + aux bin).
        val instCount = minOf(512, (bytes.size - sampleSize) / 256)
        val rec = IntArray(256)
        for (instIdx in 0 until 512) {
            if (instIdx < instCount) {
                val base = sampleSize + instIdx * 256
                for (k in 0 until 256) rec[k] = bytes[base + k].toInt() and 0xFF
            } else {
                rec.fill(0)   // clear slots absent from a legacy 256-record blob
            }
            snd.instruments[instIdx].loadRecord(rec)   // meta-aware
        }
        // The blob replaces the entire sample+instrument image, so any Ixmp patches
        // installed for the previous song are now stale (they point into the old
        // sample pool). Drop them all; the loader re-uploads the new song's Ixmp
        // section (if any) after this call.
        snd.instruments.forEach { it.extraPatches = null }
        return bytes.size
    }

    /** Compress the audio adapter's full 8 MB sample pool + 128 K instrument bins
     *  (512 records: $00..$FF then aux $100..$1FF) and write the resulting gzip/zstd
     *  blob to user-memory `dstPtr`. Returns the compressed size. The caller must
     *  ensure `dstMaxLen` is large enough; for incompressible noise the worst case is
     *  ~8.4 MB which exceeds user space — but realistic sample data compresses easily. */
    fun captureSampleInstBlob(dstPtr: Int, dstMaxLen: Int): Int {
        val snd = getFirstSnd() ?: return 0
        val sampleSize = AudioAdapter.SAMPLE_BIN_TOTAL.toInt()
        val instSize = 512 * 256                          // 128 K: 512 records
        val raw = ByteArray(sampleSize + instSize)
        UnsafeHelper.memcpyRaw(
            null, snd.sampleBin.ptr,
            raw, UnsafeHelper.getArrayOffset(raw),
            sampleSize.toLong()
        )
        for (i in 0 until instSize) {
            raw[sampleSize + i] = snd.instruments[i / 256].getByte(i % 256)
        }
        val compressed = CompressorDelegate.comp(raw)
        val n = minOf(compressed.size, dstMaxLen)
        for (i in 0 until n) vm.poke((dstPtr + i).toLong(), compressed[i])
        return compressed.size
    }
    fun mp2Init() = getFirstSnd()?.mmio_write(40L, 16)
    fun mp2Decode() = getFirstSnd()?.mmio_write(40L, 1)
    fun mp2InitThenDecode() = getFirstSnd()?.mmio_write(40L, 17)
    fun mp2UploadDecoded(playhead: Int) {
        getFirstSnd()?.let {  snd ->
            val ba = ByteArray(2304)
            UnsafeHelper.memcpyRaw(null, snd.mediaDecodedBin.ptr, ba, UnsafeHelper.getArrayOffset(ba), 2304)
            snd.playheads[playhead].pcmQueue.add(ba)
        }
    }

    fun tadDecode() {
        getFirstSnd()?.mmio_write(42L, 1)
    }

    fun tadIsBusy() = getFirstSnd()?.mmio_read(44L)?.toInt() == 1

    fun tadUploadDecoded(playhead: Int, sampleLength: Int) {
        if (sampleLength > 32768) throw Error("Sample size too long: expected <= 32768, got $sampleLength")
        getFirstSnd()?.let { snd ->
            val ba = ByteArray(sampleLength * 2)  // 32768 samples * 2 channels
            UnsafeHelper.memcpyRaw(null, snd.tadDecodedBin.ptr, ba, UnsafeHelper.getArrayOffset(ba), sampleLength * 2L)
            snd.playheads[playhead].pcmQueue.add(ba)
        }
    }

    fun putTadDataByPtr(ptr: Int, length: Int, destOffset: Int) {
        getFirstSnd()?.let { snd ->
            val vkMult = if (ptr >= 0) 1 else -1
            for (k in 0L until length) {
                val vk = k * vkMult
                snd.tadInputBin[k + destOffset] = vm.peek(ptr + vk)!!
            }
        }
    }

    fun getTadData(index: Int) = getFirstSnd()?.tadDecodedBin?.get(index.toLong())



    // while the following code does work, it was decided that MP3 is "too new" for tsvm and thus removed.
    /*
    js-mp3
    https://github.com/soundbus-technologies/js-mp3

    Copyright (c) 2018 SoundBus Technologies CO., LTD.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */

    /*private val synthNWin = Array(64) { i -> FloatArray(32) { j -> cos(((16 + i) * (2 * j + 1)) * (Math.PI / 64.0)).toFloat() } }
    private val synthDtbl = floatArrayOf(
        0.000000000f, -0.000015259f, -0.000015259f, -0.000015259f,
        -0.000015259f, -0.000015259f, -0.000015259f, -0.000030518f,
        -0.000030518f, -0.000030518f, -0.000030518f, -0.000045776f,
        -0.000045776f, -0.000061035f, -0.000061035f, -0.000076294f,
        -0.000076294f, -0.000091553f, -0.000106812f, -0.000106812f,
        -0.000122070f, -0.000137329f, -0.000152588f, -0.000167847f,
        -0.000198364f, -0.000213623f, -0.000244141f, -0.000259399f,
        -0.000289917f, -0.000320435f, -0.000366211f, -0.000396729f,
        -0.000442505f, -0.000473022f, -0.000534058f, -0.000579834f,
        -0.000625610f, -0.000686646f, -0.000747681f, -0.000808716f,
        -0.000885010f, -0.000961304f, -0.001037598f, -0.001113892f,
        -0.001205444f, -0.001296997f, -0.001388550f, -0.001480103f,
        -0.001586914f, -0.001693726f, -0.001785278f, -0.001907349f,
        -0.002014160f, -0.002120972f, -0.002243042f, -0.002349854f,
        -0.002456665f, -0.002578735f, -0.002685547f, -0.002792358f,
        -0.002899170f, -0.002990723f, -0.003082275f, -0.003173828f,
        0.003250122f, 0.003326416f, 0.003387451f, 0.003433228f,
        0.003463745f, 0.003479004f, 0.003479004f, 0.003463745f,
        0.003417969f, 0.003372192f, 0.003280640f, 0.003173828f,
        0.003051758f, 0.002883911f, 0.002700806f, 0.002487183f,
        0.002227783f, 0.001937866f, 0.001617432f, 0.001266479f,
        0.000869751f, 0.000442505f, -0.000030518f, -0.000549316f,
        -0.001098633f, -0.001693726f, -0.002334595f, -0.003005981f,
        -0.003723145f, -0.004486084f, -0.005294800f, -0.006118774f,
        -0.007003784f, -0.007919312f, -0.008865356f, -0.009841919f,
        -0.010848999f, -0.011886597f, -0.012939453f, -0.014022827f,
        -0.015121460f, -0.016235352f, -0.017349243f, -0.018463135f,
        -0.019577026f, -0.020690918f, -0.021789551f, -0.022857666f,
        -0.023910522f, -0.024932861f, -0.025909424f, -0.026840210f,
        -0.027725220f, -0.028533936f, -0.029281616f, -0.029937744f,
        -0.030532837f, -0.031005859f, -0.031387329f, -0.031661987f,
        -0.031814575f, -0.031845093f, -0.031738281f, -0.031478882f,
        0.031082153f, 0.030517578f, 0.029785156f, 0.028884888f,
        0.027801514f, 0.026535034f, 0.025085449f, 0.023422241f,
        0.021575928f, 0.019531250f, 0.017257690f, 0.014801025f,
        0.012115479f, 0.009231567f, 0.006134033f, 0.002822876f,
        -0.000686646f, -0.004394531f, -0.008316040f, -0.012420654f,
        -0.016708374f, -0.021179199f, -0.025817871f, -0.030609131f,
        -0.035552979f, -0.040634155f, -0.045837402f, -0.051132202f,
        -0.056533813f, -0.061996460f, -0.067520142f, -0.073059082f,
        -0.078628540f, -0.084182739f, -0.089706421f, -0.095169067f,
        -0.100540161f, -0.105819702f, -0.110946655f, -0.115921021f,
        -0.120697021f, -0.125259399f, -0.129562378f, -0.133590698f,
        -0.137298584f, -0.140670776f, -0.143676758f, -0.146255493f,
        -0.148422241f, -0.150115967f, -0.151306152f, -0.151962280f,
        -0.152069092f, -0.151596069f, -0.150497437f, -0.148773193f,
        -0.146362305f, -0.143264771f, -0.139450073f, -0.134887695f,
        -0.129577637f, -0.123474121f, -0.116577148f, -0.108856201f,
        0.100311279f, 0.090927124f, 0.080688477f, 0.069595337f,
        0.057617188f, 0.044784546f, 0.031082153f, 0.016510010f,
        0.001068115f, -0.015228271f, -0.032379150f, -0.050354004f,
        -0.069168091f, -0.088775635f, -0.109161377f, -0.130310059f,
        -0.152206421f, -0.174789429f, -0.198059082f, -0.221984863f,
        -0.246505737f, -0.271591187f, -0.297210693f, -0.323318481f,
        -0.349868774f, -0.376800537f, -0.404083252f, -0.431655884f,
        -0.459472656f, -0.487472534f, -0.515609741f, -0.543823242f,
        -0.572036743f, -0.600219727f, -0.628295898f, -0.656219482f,
        -0.683914185f, -0.711318970f, -0.738372803f, -0.765029907f,
        -0.791213989f, -0.816864014f, -0.841949463f, -0.866363525f,
        -0.890090942f, -0.913055420f, -0.935195923f, -0.956481934f,
        -0.976852417f, -0.996246338f, -1.014617920f, -1.031936646f,
        -1.048156738f, -1.063217163f, -1.077117920f, -1.089782715f,
        -1.101211548f, -1.111373901f, -1.120223999f, -1.127746582f,
        -1.133926392f, -1.138763428f, -1.142211914f, -1.144287109f,
        1.144989014f, 1.144287109f, 1.142211914f, 1.138763428f,
        1.133926392f, 1.127746582f, 1.120223999f, 1.111373901f,
        1.101211548f, 1.089782715f, 1.077117920f, 1.063217163f,
        1.048156738f, 1.031936646f, 1.014617920f, 0.996246338f,
        0.976852417f, 0.956481934f, 0.935195923f, 0.913055420f,
        0.890090942f, 0.866363525f, 0.841949463f, 0.816864014f,
        0.791213989f, 0.765029907f, 0.738372803f, 0.711318970f,
        0.683914185f, 0.656219482f, 0.628295898f, 0.600219727f,
        0.572036743f, 0.543823242f, 0.515609741f, 0.487472534f,
        0.459472656f, 0.431655884f, 0.404083252f, 0.376800537f,
        0.349868774f, 0.323318481f, 0.297210693f, 0.271591187f,
        0.246505737f, 0.221984863f, 0.198059082f, 0.174789429f,
        0.152206421f, 0.130310059f, 0.109161377f, 0.088775635f,
        0.069168091f, 0.050354004f, 0.032379150f, 0.015228271f,
        -0.001068115f, -0.016510010f, -0.031082153f, -0.044784546f,
        -0.057617188f, -0.069595337f, -0.080688477f, -0.090927124f,
        0.100311279f, 0.108856201f, 0.116577148f, 0.123474121f,
        0.129577637f, 0.134887695f, 0.139450073f, 0.143264771f,
        0.146362305f, 0.148773193f, 0.150497437f, 0.151596069f,
        0.152069092f, 0.151962280f, 0.151306152f, 0.150115967f,
        0.148422241f, 0.146255493f, 0.143676758f, 0.140670776f,
        0.137298584f, 0.133590698f, 0.129562378f, 0.125259399f,
        0.120697021f, 0.115921021f, 0.110946655f, 0.105819702f,
        0.100540161f, 0.095169067f, 0.089706421f, 0.084182739f,
        0.078628540f, 0.073059082f, 0.067520142f, 0.061996460f,
        0.056533813f, 0.051132202f, 0.045837402f, 0.040634155f,
        0.035552979f, 0.030609131f, 0.025817871f, 0.021179199f,
        0.016708374f, 0.012420654f, 0.008316040f, 0.004394531f,
        0.000686646f, -0.002822876f, -0.006134033f, -0.009231567f,
        -0.012115479f, -0.014801025f, -0.017257690f, -0.019531250f,
        -0.021575928f, -0.023422241f, -0.025085449f, -0.026535034f,
        -0.027801514f, -0.028884888f, -0.029785156f, -0.030517578f,
        0.031082153f, 0.031478882f, 0.031738281f, 0.031845093f,
        0.031814575f, 0.031661987f, 0.031387329f, 0.031005859f,
        0.030532837f, 0.029937744f, 0.029281616f, 0.028533936f,
        0.027725220f, 0.026840210f, 0.025909424f, 0.024932861f,
        0.023910522f, 0.022857666f, 0.021789551f, 0.020690918f,
        0.019577026f, 0.018463135f, 0.017349243f, 0.016235352f,
        0.015121460f, 0.014022827f, 0.012939453f, 0.011886597f,
        0.010848999f, 0.009841919f, 0.008865356f, 0.007919312f,
        0.007003784f, 0.006118774f, 0.005294800f, 0.004486084f,
        0.003723145f, 0.003005981f, 0.002334595f, 0.001693726f,
        0.001098633f, 0.000549316f, 0.000030518f, -0.000442505f,
        -0.000869751f, -0.001266479f, -0.001617432f, -0.001937866f,
        -0.002227783f, -0.002487183f, -0.002700806f, -0.002883911f,
        -0.003051758f, -0.003173828f, -0.003280640f, -0.003372192f,
        -0.003417969f, -0.003463745f, -0.003479004f, -0.003479004f,
        -0.003463745f, -0.003433228f, -0.003387451f, -0.003326416f,
        0.003250122f, 0.003173828f, 0.003082275f, 0.002990723f,
        0.002899170f, 0.002792358f, 0.002685547f, 0.002578735f,
        0.002456665f, 0.002349854f, 0.002243042f, 0.002120972f,
        0.002014160f, 0.001907349f, 0.001785278f, 0.001693726f,
        0.001586914f, 0.001480103f, 0.001388550f, 0.001296997f,
        0.001205444f, 0.001113892f, 0.001037598f, 0.000961304f,
        0.000885010f, 0.000808716f, 0.000747681f, 0.000686646f,
        0.000625610f, 0.000579834f, 0.000534058f, 0.000473022f,
        0.000442505f, 0.000396729f, 0.000366211f, 0.000320435f,
        0.000289917f, 0.000259399f, 0.000244141f, 0.000213623f,
        0.000198364f, 0.000167847f, 0.000152588f, 0.000137329f,
        0.000122070f, 0.000106812f, 0.000106812f, 0.000091553f,
        0.000076294f, 0.000076294f, 0.000061035f, 0.000061035f,
        0.000045776f, 0.000045776f, 0.000030518f, 0.000030518f,
        0.000030518f, 0.000030518f, 0.000015259f, 0.000015259f,
        0.000015259f, 0.000015259f, 0.000015259f, 0.000015259f,
    )

    private val imdctWinData = Array(4) { DoubleArray(36) }
    private val cosN12 = Array(6) { DoubleArray(12) }
    private val cosN36 = Array(18) { DoubleArray(36) }

    init {
        for (i in 0 until 36) {
            imdctWinData[0][i] = Math.sin(Math.PI / 36 * (i + 0.5));
        }
        for (i in 0 until 18) {
            imdctWinData[1][i] = Math.sin(Math.PI / 36 * (i + 0.5));
        }
        for (i in 18 until 24) {
            imdctWinData[1][i] = 1.0;
        }
        for (i in 24 until 30) {
            imdctWinData[1][i] = Math.sin(Math.PI / 12 * (i + 0.5 - 18.0));
        }
        for (i in 30 until 36) {
            imdctWinData[1][i] = 0.0;
        }
        for (i in 0 until 12) {
            imdctWinData[2][i] = Math.sin(Math.PI / 12 * (i + 0.5));
        }
        for (i in 12 until 36) {
            imdctWinData[2][i] = 0.0;
        }
        for (i in 0 until 6) {
            imdctWinData[3][i] = 0.0;
        }
        for (i in 6 until 12) {
            imdctWinData[3][i] = Math.sin(Math.PI / 12 * (i + 0.5 - 6.0));
        }
        for (i in 12 until 18) {
            imdctWinData[3][i] = 1.0;
        }
        for (i in 18 until 36) {
            imdctWinData[3][i] = Math.sin(Math.PI / 36 * (i + 0.5));
        }

        val cosN12_N = 12
        for (i in 0 until 6) {
            for (j in 0 until 12) {
                cosN12[i][j] = Math.cos(Math.PI / (2 * cosN12_N) * (2*j + 1 + cosN12_N/2) * (2*i + 1));
            }
        }

        val cosN36_N = 36
        for (i in 0 until 18) {
            for (j in 0 until 36) {
                cosN36[i][j] = Math.cos(Math.PI / (2 * cosN36_N) * (2*j + 1 + cosN36_N/2) * (2*i + 1));
            }
        }
    }

    private fun ImdctWin(inData: DoubleArray, blockType: Int): DoubleArray {
        val out = DoubleArray(36)

        if (blockType == 2) {
            val iwd = imdctWinData[blockType];
            val N = 12;
            for (i in 0 until 3) {
                for (p in 0 until N) {
                    var sum = 0.0;
                    for (m in 0 until N/2) {
                        sum += inData[i+3*m] * cosN12[m][p];
                    }
                    out[6*i+p+6] += sum * iwd[p];
                }
            }
            return out;
        }

        val N = 36;
        val iwd = imdctWinData[blockType]
        for (p in 0 until N) {
            var sum = 0.0;
            for (m in 0 until N/2) {
                sum += inData[m] * cosN36[m][p];
            }
            out[p] = sum * iwd[p];
        }
        return out;
    }




    private fun FloatArray.typedArraySet(xs: List<Float>, index: Int) {
        for (i in xs.indices) {
            this[i + index] = xs[i]
        }
    }

    private fun Value.grch(gr: Long, ch: Long) = this.getArrayElement(gr).getArrayElement(ch)

    fun mp3_hybridSynthesis(sideInfo: Value, mainDataIs: Value, storeCh: Value, gr: Long, ch: Long) {
        // Loop through all 32 subbands
        for (sb in 0 until 32) {
            // Determine blocktype for this subband
            var bt = sideInfo.getMember("BlockType").grch(gr,ch).asInt();
            if ((sideInfo.getMember("WinSwitchFlag").grch(gr,ch).asInt() == 1) &&
                (sideInfo.getMember("MixedBlockFlag").grch(gr,ch).asInt() == 1) && (sb < 2)) {
                bt = 0;
            }
            // Do the inverse modified DCT and windowing
            val inData = DoubleArray(18)
            for (i in 0 until 18) {
                inData[i] = mainDataIs.grch(gr,ch).getArrayElement(sb * 18L + i).asDouble()
            }
            val rawout = ImdctWin(inData, bt);
            // Overlapp add with stored vector into main_data vector
            for (i in 0L until 18L) {
                val storeChSb = storeCh.getArrayElement(sb.toLong())

                mainDataIs.grch(gr,ch).setArrayElement(sb * 18 + i, rawout[i.toInt()] + storeChSb.getArrayElement(i).asDouble())
                storeChSb.setArrayElement(i, rawout[i.toInt() + 18])
            }
        }
    }

    fun mp3_subbandSynthesis(nch: Int, frame: Value, gr: Long, ch: Long, out_ptr: Int) {
        val u_vec = FloatArray(512)
        val s_vec = FloatArray(32)

        val frameV_vec_ch = frame.getMember("v_vec").getArrayElement(ch)
        val d = frame.getMember("mainData").getMember("Is").grch(gr,ch)

        // Setup the n_win windowing vector and the v_vec intermediate vector
        for (ss in 0 until 18) { // Loop through 18 samples in 32 subbands
            // v_vec: Array(2)
            // v_vec[ch]: Float32Array(1024) -- instance of TypedArray
            frameV_vec_ch.invokeMember("set",
                frameV_vec_ch.invokeMember("slice", 0, 1024 - 64),
                64
            )
            //frame.v_vec[ch].set(frame.v_vec[ch].slice(0, 1024 - 64), 64); // copy(f.v_vec[ch][64:1024],
                                                                          // f.v_vec[ch][0:1024-64])

            //var d = frame.mainData.Is[gr][ch];
            for (i in 0 until 32) { // Copy next 32 time samples to a temp vector
                s_vec[i] = d.getArrayElement(i * 18L + ss).asDouble().toFloat()
                //s_vec[i] = d[i * 18 + ss];
            }
            for (i in 0 until 64) { // Matrix multiply input with n_win[][] matrix
                var sum = 0f
                for (j in 0 until 32) {
                    sum += synthNWin[i][j] * s_vec[j];
                }
                frameV_vec_ch.setArrayElement(i.toLong(), sum)
                //frame.v_vec[ch][i] = sum;
            }

            val v = frameV_vec_ch
            //var v = frame.v_vec[ch];
            for (i in 0 until 512 step 64) { // Build the U vector
                u_vec.typedArraySet(((i shl 1) until (i shl 1) + 32).map { v.getArrayElement(it.toLong()).asDouble().toFloat() }, i)
                //u_vec.set(v.slice((i shl 1), (i shl 1) + 32), i); // copy(u_vec[i:i+32],
                // v[(i<<1):(i<<1)+32])

                u_vec.typedArraySet(((i shl 1) + 96 until (i shl 1) + 128).map { v.getArrayElement(it.toLong()).asDouble().toFloat() }, i + 32)
                //u_vec.set(v.slice((i shl 1) + 96, (i shl 1) + 128), i + 32); // copy(u_vec[i+32:i+64],
                // v[(i<<1)+96:(i<<1)+128])
            }
            for (i in 0 until 512) { // Window by u_vec[i] with synthDtbl[i]
                u_vec[i] *= synthDtbl[i];
            }
            for (i in 0 until 32) { // Calc 32 samples,store in outdata vector
                var sum = 0f
                for (j in 0 until 512 step 32) {
                    sum += u_vec[j + i];
                }
                // sum now contains time sample 32*ss+i. Convert to 16-bit signed int
                val samp = (sum * 32767).coerceIn(-32767f, 32767f)
                val s = samp.toInt()
                val idx = if (nch == 1) {
                    2 * (32*ss + i)
                } else {
                    4 * (32*ss + i)
                }
                if (ch == 0L) {
                    vm.poke(out_ptr.toLong() + idx, s.toByte())
                    vm.poke(out_ptr.toLong() + idx + 1, (s ushr 8).toByte())
                } else {
                    vm.poke(out_ptr.toLong() + idx + 2, s.toByte())
                    vm.poke(out_ptr.toLong() + idx + 3, (s ushr 8).toByte())
                }
            }
        }
    }*/




}