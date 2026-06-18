package net.torvald.tsvm.peripheral

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.backends.lwjgl3.audio.OpenALLwjgl3Audio
import com.badlogic.gdx.utils.GdxRuntimeException
import com.badlogic.gdx.utils.Queue
import io.airlift.compress.zstd.ZstdInputStream
import net.torvald.UnsafeHelper
import net.torvald.UnsafePtr
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.ThreeFiveMiniUfloat
import net.torvald.tsvm.VM
import net.torvald.tsvm.toInt
import java.io.ByteArrayInputStream
import kotlin.math.log2
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.exp

private class RenderRunnable(val playhead: AudioAdapter.Playhead) : Runnable {
    private fun printdbg(msg: Any) {
        if (AudioAdapter.DBGPRN) println("[AudioAdapter] $msg")
    }
    override fun run() {
        while (!Thread.currentThread().isInterrupted) {
            try {
                if (playhead.isPcmMode) {

                    val writeQueue = playhead.pcmQueue

                    if (playhead.isPlaying && writeQueue.notEmpty()) {

                        printdbg("Taking samples from queue (queue size: ${writeQueue.size}/${playhead.getPcmQueueCapacity()})")

                        val samples = writeQueue.removeFirst()
                        playhead.position = writeQueue.size

                        playhead.audioDevice.writeSamplesUI8(samples, 0, samples.size)

                        Thread.sleep(6)
                    }
                    else if (playhead.isPlaying && writeQueue.isEmpty) {
                        printdbg("!! QUEUE EXHAUSTED !! QUEUE EXHAUSTED !! QUEUE EXHAUSTED !! QUEUE EXHAUSTED !! QUEUE EXHAUSTED !! QUEUE EXHAUSTED ")

                        Thread.sleep(6)
                    }
                } else {
                    // Tracker mode
                    if (playhead.isPlaying) {
                        val out = playhead.parent.generateTrackerAudio(playhead)
                        if (out != null) {
                            playhead.audioDevice.writeStereoSamplesUI8(out, 0, AudioAdapter.TRACKER_CHUNK)
                        }
                        Thread.sleep(6)
                    }
                }


                Thread.sleep(1)
            }
            catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
            catch (e: Exception) {
                System.err.println("[AudioAdapter] RenderRunnable crashed: $e")
                e.printStackTrace()
            }
        }
    }
}

private class WriteQueueingRunnable(val playhead: AudioAdapter.Playhead, val pcmBin: UnsafePtr) : Runnable {
    private fun printdbg(msg: Any) {
        if (AudioAdapter.DBGPRN) println("[AudioAdapter] $msg")
    }
    override fun run() {
        while (!Thread.currentThread().isInterrupted) {
            try {
                playhead.let {
                    if (/*it.pcmQueue.size < it.getPcmQueueCapacity() &&*/ it.pcmUpload && it.pcmUploadLength > 0) {
                        printdbg("Downloading samples ${it.pcmUploadLength}")

                        val samples = ByteArray(it.pcmUploadLength)
                        UnsafeHelper.memcpyRaw(
                            null,
                            pcmBin.ptr,
                            samples,
                            UnsafeHelper.getArrayOffset(samples),
                            it.pcmUploadLength.toLong()
                        )
                        it.pcmQueue.addLast(samples)

                        it.pcmUploadLength = 0
                        it.position = it.pcmQueue.size
                        Thread.sleep(6)
                    }
                    else if (it.pcmUpload) {
//                    printdbg("Rejecting samples (queueSize: ${it.pcmQueue.size}, uploadLength: ${it.pcmUploadLength})")
                        Thread.sleep(6)
                    }
                }

                Thread.sleep(1)
            }
            catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }
}

/**
 * Created by minjaesong on 2022-12-30.
 */
class AudioAdapter(val vm: VM) : PeriBase(VM.PERITYPE_SOUND) {

    private fun printdbg(msg: Any) {
        if (DBGPRN) println("[AudioAdapter] $msg")
    }

    companion object {
        internal val DBGPRN = false
        const val SAMPLING_RATE = 32000
        const val TRACKER_CHUNK = 512
        // Per-voice soundscope ring-buffer length. Power of two so wrap-around is a single AND.
        // Sized at 4× the soundscope width so the AudioMenu waveform view always has spare
        // samples on either side of the centre to search for a stable trigger point.
        const val SCOPE_BUFFER_SIZE = 2048
        // Mixer-private background-voice pool size per playhead. NNA "Continue/Note Off/Note Fade"
        // ghosts displaced foreground voices into this pool; oldest is evicted on overflow.
        const val MAX_BG_VOICES = 256
        const val MIDDLE_C = 0x5000   // reference C for instrument samplingRate (terranmon.txt:2000)
        // Amiga period at MIDDLE_C for a standard 8363 Hz instrument (NTSC clock 3579545 Hz).
        // PT "C-2" period 428 ↔ TSVM MIDDLE_C ↔ 8363 Hz; mod2taud uses the same convention.
        // Trackers may use different labelling conventions (e.g. C5) for Middle C.
        // For non-tracker context, Middle C shall be labelled as C4.
        const val AMIGA_BASE_PERIOD = 428.0
        // Reference frequency for linear-freq tone mode (toneMode == 2). Fixed at 12-TET
        // A4 = 440 Hz so that 1 Hz/tick at C4 ≈ 1 Hz at the audible output: 261.6256 ×
        // 2^(9/12) = 440 Hz exactly. MONOTONE (.MON) — the only source format using
        // linear-freq slides — uses A0 = 27.5 Hz with the same equal-temperament tuning,
        // so emitted Hz values map directly to audible Hz at any pitch.
        const val LINEAR_FREQ_C4_HZ = 261.6255653005986
        // Anti-click ramp-out: when a sample naturally ends or is cut, the voice keeps
        // mixing for this many output samples while gain decays linearly to 0.
        // 8 ms at 32 kHz — long enough to bury the click, short enough not to read as fade.
        // Applied on sample end only (preserves attack transients on note start).
        const val RAMP_OUT_SAMPLES = 256
        // Fast note-fade (note word 0x0004): a quick choke for SF2 exclusiveClass (e.g. a
        // closed hi-hat silencing a ringing open hi-hat). FluidSynth's kill uses
        // GEN_VOLENVRELEASE = -2000 timecents ≈ 0.315 s (fluid_voice.c:1404); the voice keeps
        // playing while fadeoutVolume ramps to zero over this time, then deactivates.
        const val FAST_FADE_SEC = 0.3
        // Volume-change anti-click ramp: voleff/notefx (volume column, D vol-slides,
        // tremor, tremolo, retrig vol-mod, fine slides etc.) mutate Voice.rowVolume
        // and M / N mutate Voice.channelVolume mid-note. The mixer ramps the actual
        // applied gain (combining both axes) across [VOL_RAMP_SAMPLES] output samples
        // to mask the discontinuity. ~2 ms at 32 kHz — short enough not to smear
        // tremolo at fast speeds, long enough to bury per-tick slide steps. Bypassed
        // on fresh note triggers (triggerNote snaps currentMixVolume to target) so
        // attack transients pass through untouched.
        const val VOL_RAMP_SAMPLES = 64

        // Sample bin: 8 MB total, banked through a 512 K window at peripheral
        // memory 0..524287. MMIO 46 holds the currently-exposed bank index.
        const val SAMPLE_BANK_SIZE: Long = 524288L           // 512 K
        const val SAMPLE_BANK_COUNT: Int = 16                // 16 × 512 K = 8 MB
        const val SAMPLE_BIN_TOTAL: Long = SAMPLE_BANK_SIZE * SAMPLE_BANK_COUNT
        const val SAMPLE_BANK_MASK: Int = SAMPLE_BANK_COUNT - 1

        // Interpolation modes (TAUD_NOTE_EFFECTS.md §1, bits 2-4 of global behaviour flags).
        //   0 = default (Fast Sinc, 16-tap windowed sinc), 1 = none (zero-order hold),
        //   2 = Amiga 500 (ZOH + A500 1-pole LPF), 3 = Amiga 1200 (ZOH + A1200 LPF — bypassed),
        //   4 = SNES 4-tap gaussian (BRR-style, preserves the int16 mid-sum overflow quirk),
        //   5 = NES 2A03 DPCM (1-bit sigma-delta on a 7-bit ±2-stepping counter).
        // Amiga modes additionally apply a 2-pole Sallen-Key "LED" LPF when ts.ledFilterOn,
        // which is toggled by S $0000 / S $0100 (TAUD_NOTE_EFFECTS.md §"S $0x00").
        const val INTERP_DEFAULT  = 0
        const val INTERP_NONE     = 1
        const val INTERP_A500     = 2
        const val INTERP_A1200    = 3
        const val INTERP_SNES     = 4
        const val INTERP_NES_DPCM = 5

        // Fast Sinc — 6-tap windowed sinc with 1024 sub-sample positions.
        // Mirrors MilkyTracker's MIXER_SINCTABLE (ResamplerSinc.h: WIDTH=8, 1024-step table,
        // window = 0.5 + 0.5·cos(πi / WIDTH·step)).  Coefficients are symmetric so we only
        // store half the kernel; the second half is index-mirrored at lookup time.
        const val SINC_WIDTH = 3
        const val SINC_PRECISION_SHIFT = 10
        const val SINC_PRECISION = 1 shl SINC_PRECISION_SHIFT     // 1024
        private val SINC_TABLE: DoubleArray = run {
            val n = SINC_PRECISION * SINC_WIDTH
            val out = DoubleArray(n)
            val winFreq = PI / SINC_WIDTH / SINC_PRECISION
            out[0] = 1.0
            for (i in 1 until n) {
                val t = i * PI / SINC_PRECISION
                val win = 0.5 + 0.5 * cos(winFreq * i)
                out[i] = sin(t) / t * win
            }
            out
        }

        /** Windowed-sinc kernel value for fractional offset `frac ∈ [0,1)` and signed tap [−WIDTH+1, WIDTH]. */
        private fun sincTap(frac: Double, tap: Int): Double {
            val x = (tap - frac) * SINC_PRECISION  // distance in sub-sample units
            val ax = kotlin.math.abs(x)
            val idx = ax.toInt()
            if (idx >= SINC_PRECISION * SINC_WIDTH - 1) return 0.0
            // Linear interpolation between adjacent table entries for sub-sub-sample precision.
            val f = ax - idx
            return SINC_TABLE[idx] * (1.0 - f) + SINC_TABLE[idx + 1] * f
        }

        // SNES BRR 4-tap gaussian table (512 entries, monotonically rising 0x000..0x519).
        // Mirrors xander-haj/z3c snes/dsp.c gaussValues[]. The DSP indexes this table with
        // four phases derived from an 8-bit fractional offset: gauss[offset] (newest tap),
        // gauss[0x100+offset] (olds — peaks near the playhead), gauss[0x1ff-offset] (olders —
        // contains the peak value 0x519), and gauss[0xff-offset] (oldest). Coefficients sum
        // to ~2049 at every phase, so the SNES DSP right-shifts the sum by 1 after a
        // deliberate int16 wrap-around on the partial sum (audible as the famous
        // "SNES gauss overflow chirp" on loud samples — preserved here for authenticity).
        private val SNES_GAUSS = intArrayOf(
            0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000, 0x000,
            0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x001, 0x002, 0x002, 0x002, 0x002, 0x002,
            0x002, 0x002, 0x003, 0x003, 0x003, 0x003, 0x003, 0x004, 0x004, 0x004, 0x004, 0x004, 0x005, 0x005, 0x005, 0x005,
            0x006, 0x006, 0x006, 0x006, 0x007, 0x007, 0x007, 0x008, 0x008, 0x008, 0x009, 0x009, 0x009, 0x00A, 0x00A, 0x00A,
            0x00B, 0x00B, 0x00B, 0x00C, 0x00C, 0x00D, 0x00D, 0x00E, 0x00E, 0x00F, 0x00F, 0x00F, 0x010, 0x010, 0x011, 0x011,
            0x012, 0x013, 0x013, 0x014, 0x014, 0x015, 0x015, 0x016, 0x017, 0x017, 0x018, 0x018, 0x019, 0x01A, 0x01B, 0x01B,
            0x01C, 0x01D, 0x01D, 0x01E, 0x01F, 0x020, 0x020, 0x021, 0x022, 0x023, 0x024, 0x024, 0x025, 0x026, 0x027, 0x028,
            0x029, 0x02A, 0x02B, 0x02C, 0x02D, 0x02E, 0x02F, 0x030, 0x031, 0x032, 0x033, 0x034, 0x035, 0x036, 0x037, 0x038,
            0x03A, 0x03B, 0x03C, 0x03D, 0x03E, 0x040, 0x041, 0x042, 0x043, 0x045, 0x046, 0x047, 0x049, 0x04A, 0x04C, 0x04D,
            0x04E, 0x050, 0x051, 0x053, 0x054, 0x056, 0x057, 0x059, 0x05A, 0x05C, 0x05E, 0x05F, 0x061, 0x063, 0x064, 0x066,
            0x068, 0x06A, 0x06B, 0x06D, 0x06F, 0x071, 0x073, 0x075, 0x076, 0x078, 0x07A, 0x07C, 0x07E, 0x080, 0x082, 0x084,
            0x086, 0x089, 0x08B, 0x08D, 0x08F, 0x091, 0x093, 0x096, 0x098, 0x09A, 0x09C, 0x09F, 0x0A1, 0x0A3, 0x0A6, 0x0A8,
            0x0AB, 0x0AD, 0x0AF, 0x0B2, 0x0B4, 0x0B7, 0x0BA, 0x0BC, 0x0BF, 0x0C1, 0x0C4, 0x0C7, 0x0C9, 0x0CC, 0x0CF, 0x0D2,
            0x0D4, 0x0D7, 0x0DA, 0x0DD, 0x0E0, 0x0E3, 0x0E6, 0x0E9, 0x0EC, 0x0EF, 0x0F2, 0x0F5, 0x0F8, 0x0FB, 0x0FE, 0x101,
            0x104, 0x107, 0x10B, 0x10E, 0x111, 0x114, 0x118, 0x11B, 0x11E, 0x122, 0x125, 0x129, 0x12C, 0x130, 0x133, 0x137,
            0x13A, 0x13E, 0x141, 0x145, 0x148, 0x14C, 0x150, 0x153, 0x157, 0x15B, 0x15F, 0x162, 0x166, 0x16A, 0x16E, 0x172,
            0x176, 0x17A, 0x17D, 0x181, 0x185, 0x189, 0x18D, 0x191, 0x195, 0x19A, 0x19E, 0x1A2, 0x1A6, 0x1AA, 0x1AE, 0x1B2,
            0x1B7, 0x1BB, 0x1BF, 0x1C3, 0x1C8, 0x1CC, 0x1D0, 0x1D5, 0x1D9, 0x1DD, 0x1E2, 0x1E6, 0x1EB, 0x1EF, 0x1F3, 0x1F8,
            0x1FC, 0x201, 0x205, 0x20A, 0x20F, 0x213, 0x218, 0x21C, 0x221, 0x226, 0x22A, 0x22F, 0x233, 0x238, 0x23D, 0x241,
            0x246, 0x24B, 0x250, 0x254, 0x259, 0x25E, 0x263, 0x267, 0x26C, 0x271, 0x276, 0x27B, 0x280, 0x284, 0x289, 0x28E,
            0x293, 0x298, 0x29D, 0x2A2, 0x2A6, 0x2AB, 0x2B0, 0x2B5, 0x2BA, 0x2BF, 0x2C4, 0x2C9, 0x2CE, 0x2D3, 0x2D8, 0x2DC,
            0x2E1, 0x2E6, 0x2EB, 0x2F0, 0x2F5, 0x2FA, 0x2FF, 0x304, 0x309, 0x30E, 0x313, 0x318, 0x31D, 0x322, 0x326, 0x32B,
            0x330, 0x335, 0x33A, 0x33F, 0x344, 0x349, 0x34E, 0x353, 0x357, 0x35C, 0x361, 0x366, 0x36B, 0x370, 0x374, 0x379,
            0x37E, 0x383, 0x388, 0x38C, 0x391, 0x396, 0x39B, 0x39F, 0x3A4, 0x3A9, 0x3AD, 0x3B2, 0x3B7, 0x3BB, 0x3C0, 0x3C5,
            0x3C9, 0x3CE, 0x3D2, 0x3D7, 0x3DC, 0x3E0, 0x3E5, 0x3E9, 0x3ED, 0x3F2, 0x3F6, 0x3FB, 0x3FF, 0x403, 0x408, 0x40C,
            0x410, 0x415, 0x419, 0x41D, 0x421, 0x425, 0x42A, 0x42E, 0x432, 0x436, 0x43A, 0x43E, 0x442, 0x446, 0x44A, 0x44E,
            0x452, 0x455, 0x459, 0x45D, 0x461, 0x465, 0x468, 0x46C, 0x470, 0x473, 0x477, 0x47A, 0x47E, 0x481, 0x485, 0x488,
            0x48C, 0x48F, 0x492, 0x496, 0x499, 0x49C, 0x49F, 0x4A2, 0x4A6, 0x4A9, 0x4AC, 0x4AF, 0x4B2, 0x4B5, 0x4B7, 0x4BA,
            0x4BD, 0x4C0, 0x4C3, 0x4C5, 0x4C8, 0x4CB, 0x4CD, 0x4D0, 0x4D2, 0x4D5, 0x4D7, 0x4D9, 0x4DC, 0x4DE, 0x4E0, 0x4E3,
            0x4E5, 0x4E7, 0x4E9, 0x4EB, 0x4ED, 0x4EF, 0x4F1, 0x4F3, 0x4F5, 0x4F6, 0x4F8, 0x4FA, 0x4FB, 0x4FD, 0x4FF, 0x500,
            0x502, 0x503, 0x504, 0x506, 0x507, 0x508, 0x50A, 0x50B, 0x50C, 0x50D, 0x50E, 0x50F, 0x510, 0x511, 0x511, 0x512,
            0x513, 0x514, 0x514, 0x515, 0x516, 0x516, 0x517, 0x517, 0x517, 0x518, 0x518, 0x518, 0x518, 0x518, 0x519, 0x519
        )

        // Amiga filter coefficients (precomputed at SAMPLING_RATE = 32 kHz, see pt2_paula.c
        // and pt2_rcfilters.c).  All filters operate on the post-mix stereo bus per playhead.
        //
        //   A500_LP : 1-pole RC LPF, R = 360 Ω, C = 0.1 µF  →  fc ≈ 4420.97 Hz
        //   LED_LP  : 2-pole Sallen-Key, R1=R2=10 kΩ, C1=6800 pF, C2=3900 pF
        //             →  fc ≈ 3090.53 Hz, Q ≈ 0.660225
        //   A1200_LP: cutoff ~34.4 kHz, well above Nyquist at 32 kHz → bypassed (matches pt2-clone).
        private val AMIGA_A500_LP_FC = 4420.971
        private val AMIGA_LED_FC     = 3090.533
        private val AMIGA_LED_Q      = 0.660225

        // 1-pole coefficients (Direct Form II) for A500 LPF.
        val AMIGA_A500_B1: Double = exp(-2.0 * PI * AMIGA_A500_LP_FC / SAMPLING_RATE)
        val AMIGA_A500_A0: Double = 1.0 - AMIGA_A500_B1

        // 2-pole biquad coefficients (musicdsp.org #38) for LED Sallen-Key LPF.
        private val AMIGA_LED_A_BASE = 1.0 / kotlin.math.tan(PI * AMIGA_LED_FC / SAMPLING_RATE)
        private val AMIGA_LED_B_BASE = 1.0 / AMIGA_LED_Q
        val AMIGA_LED_A1: Double = 1.0 / (1.0 + AMIGA_LED_B_BASE * AMIGA_LED_A_BASE + AMIGA_LED_A_BASE * AMIGA_LED_A_BASE)
        val AMIGA_LED_A2: Double = 2.0 * AMIGA_LED_A1
        val AMIGA_LED_B1: Double = 2.0 * (1.0 - AMIGA_LED_A_BASE * AMIGA_LED_A_BASE) * AMIGA_LED_A1
        val AMIGA_LED_B2: Double = (1.0 - AMIGA_LED_B_BASE * AMIGA_LED_A_BASE + AMIGA_LED_A_BASE * AMIGA_LED_A_BASE) * AMIGA_LED_A1
    }

    // Memory map (terranmon.txt:1985-1997, updated 2026-05-08):
    //   0..524287       sample bin window (512K — exposes one bank of 8 MB pool)
    //   524288..720895  reserved (no-op on access)
    //   720896..786431  instrument bin (256 inst × 256 bytes = 64K)
    //   786432..        play data 1 / 2 / TAD blocks (anchors unchanged)
    //
    // Backing sample memory is 8 MB, banked in 16 × 512K pages. MMIO 46 holds
    // the currently-exposed bank index (0..15); reads/writes through the window
    // hit `sampleBin[sampleBank * 524288 + offset]`.
    internal val sampleBin = UnsafeHelper.allocate(SAMPLE_BIN_TOTAL, this)
    @Volatile var sampleBank: Int = 0  // 0..15, controls the 0..524287 window
    internal val instruments = Array(256) { TaudInst(it) }
    internal val playdata = Array(4096) { Array(64) { TaudPlayData(0x0000, 0, 0, 0, 32, 0, 0, 0) } }
    internal val playheads: Array<Playhead>
    internal val cueSheet = Array(1024) { PlayCue() }
    internal val pcmBin = arrayOf(
        UnsafeHelper.allocate(65536L, this),
        UnsafeHelper.allocate(65536L, this),
        UnsafeHelper.allocate(65536L, this),
        UnsafeHelper.allocate(65536L, this),
    )

    internal val mediaFrameBin = UnsafeHelper.allocate(1728, this)
    internal val mediaDecodedBin = UnsafeHelper.allocate(2304, this)

    @Volatile private var mp2Busy = false

    @Volatile var selectedPcmBin = 0

    // TAD (Terrarum Advanced Audio) decoder buffers
    internal val tadInputBin = UnsafeHelper.allocate(65536L, this)   // Input: compressed TAD chunk (max 64KB)
    internal val tadDecodedBin = UnsafeHelper.allocate(65536L, this) // Output: PCMu8 stereo (32768 samples * 2 channels)
    internal var tadQuality = 2  // Quality level used during encoding (0-5)
    @Volatile private var tadBusy = false

    // TAD decoder constants - Coefficient scalars for each subband (matching C decoder)
    // Index 0 = LL band, Index 1-9 = H bands (L9 to L1)
    private val TAD32_COEFF_SCALARS = floatArrayOf(
        64.0f, 45.255f, 32.0f, 22.627f, 16.0f, 11.314f, 8.0f, 5.657f, 4.0f, 2.828f
    )

    // Base quantiser weight table (10 subbands: LL + 9 H bands)
    // CRITICAL: Different weights for Mid (channel 0) and Side (channel 1) channels!
    private val BASE_QUANTISER_WEIGHTS = arrayOf(
        floatArrayOf( // Mid channel (channel 0)
            4.0f,    // LL (L9) DC
            2.0f,    // H (L9) 31.25 hz
            1.8f,    // H (L8) 62.5 hz
            1.6f,    // H (L7) 125 hz
            1.4f,    // H (L6) 250 hz
            1.2f,    // H (L5) 500 hz
            1.0f,    // H (L4) 1 khz
            1.0f,    // H (L3) 2 khz
            1.3f,    // H (L2) 4 khz
            2.0f     // H (L1) 8 khz
        ),
        floatArrayOf( // Side channel (channel 1)
            6.0f,    // LL (L9) DC
            5.0f,    // H (L9) 31.25 hz
            2.6f,    // H (L8) 62.5 hz
            2.4f,    // H (L7) 125 hz
            1.8f,    // H (L6) 250 hz
            1.3f,    // H (L5) 500 hz
            1.0f,    // H (L4) 1 khz
            1.0f,    // H (L3) 2 khz
            1.6f,    // H (L2) 4 khz
            3.2f     // H (L1) 8 khz
        )
    )

    private val LAMBDA_FIXED = 6.0f

    // Deadzone marker for stochastic reconstruction (must match encoder)
    private val DEADZONE_MARKER_QUANT = (-128).toByte()

    // Deadband thresholds (must match encoder)
    private val DEADBANDS = arrayOf(
        floatArrayOf(  // Mid channel
            1.0f, 0.3f, 0.3f, 0.3f, 0.3f, 0.2f, 0.2f, 0.05f, 0.05f, 0.05f
        ),
        floatArrayOf(  // Side channel
            1.0f, 0.3f, 0.3f, 0.3f, 0.3f, 0.2f, 0.2f, 0.05f, 0.05f, 0.05f
        )
    )

    // Dither state for noise shaping (2 channels, 2 history samples each)
    private val ditherError = Array(2) { FloatArray(2) }

    // De-emphasis filter state (persistent across chunks to prevent discontinuities)
    private var deemphPrevXL = 0.0f
    private var deemphPrevYL = 0.0f
    private var deemphPrevXR = 0.0f
    private var deemphPrevYR = 0.0f

    private val renderRunnables: Array<RenderRunnable>
    private val renderThreads: Array<Thread>
    private val writeQueueingRunnables: Array<WriteQueueingRunnable>
    private val writeQueueingThreads: Array<Thread>

    private val renderThreadGroup = ThreadGroup("AudioRenderThreadGroup")
    private val writeQueueingGroup = ThreadGroup("AudioQriteQueueingThreadGroup")

    private val threadExceptionHandler = Thread.UncaughtExceptionHandler { thread, throwable ->
        throwable.printStackTrace()
    }

    internal val mp2Env = MP2Env(vm)

    override fun toString() = "AudioAdapter!$hash"

    init {

        val deviceBufferSize = Gdx.audio.javaClass.getDeclaredField("deviceBufferSize").let {
            it.isAccessible = true
            it.get(Gdx.audio) as Int
        }
        val deviceBufferCount = Gdx.audio.javaClass.getDeclaredField("deviceBufferCount").let {
            it.isAccessible = true
            it.get(Gdx.audio) as Int
        }

        printdbg("buffer size: $deviceBufferSize x $deviceBufferCount")

        playheads = Array(4) {
            val adev  = OpenALBufferedAudioDevice(
                Gdx.audio as OpenALLwjgl3Audio,
                SAMPLING_RATE,
                false,
                deviceBufferSize,
                deviceBufferCount
            ) {

            }


            Playhead(this, index = it, audioDevice = adev)
        }


        renderRunnables = Array(4) { RenderRunnable(playheads[it]) }
        renderThreads = Array(4) { Thread(renderThreadGroup, renderRunnables[it], "AudioRenderHead${it+1}!$hash") }
        writeQueueingRunnables = Array(4) { WriteQueueingRunnable(playheads[it], pcmBin[it]) }
        writeQueueingThreads = Array(4) { Thread(writeQueueingGroup, writeQueueingRunnables[it], "AudioQueueingHead${it+1}!$hash") }

//        printdbg("AudioAdapter latency: ${audioDevice.latency}")
        renderThreads.forEach { it.uncaughtExceptionHandler = threadExceptionHandler; it.start() }
        writeQueueingThreads.forEach { it.uncaughtExceptionHandler = threadExceptionHandler; it.start() }

    }

    /**
     * Put this function into a separate thread and keep track of the delta time by yourself
     */
    private fun render(playhead: Playhead) {
        if (playhead.isPcmMode) {

            val writeQueue = playhead.pcmQueue

            if (playhead.isPlaying && writeQueue.notEmpty()) {

                printdbg("Taking samples from queue (queue size: ${writeQueue.size})")

                val samples = writeQueue.removeFirst()
                playhead.position = writeQueue.size

//                printdbg("P${playhead.index+1} Vol ${playhead.masterVolume}; LpP ${playhead.pcmUploadLength}; start playback...")
//                    printdbg(""+(0..42).joinToString { String.format("%.2f", samples[it]) })

                playhead.audioDevice.writeSamplesUI8(samples, 0, samples.size)

//                printdbg("P${playhead.index+1} go back to spinning")

            }
            else if (playhead.isPlaying) {
//                printdbg("Queue exhausted, stopping...")
//                it.isPlaying = false
            }
        }
    }

    override fun peek(addr: Long): Byte {
        return when (val adi = addr.toInt()) {
            in 0..524287 -> sampleBin[sampleBank * SAMPLE_BANK_SIZE + addr]
            in 524288..720895 -> 0  // reserved
            in 720896..786431 -> (adi - 720896).let { instruments[it / 256].getByte(it % 256) }
            in 786432..851967 -> { val off = adi - 786432; playdata[playheads[0].patBank1 * 128 + off / 512][(off % 512) / 8].getByte(off % 8) }
            in 851968..917503 -> { val off = adi - 851968; playdata[playheads[0].patBank2 * 128 + off / 512][(off % 512) / 8].getByte(off % 8) }
            in 917504..983039 -> tadInputBin[addr - 917504]   // TAD input buffer (65536 bytes)
            in 983040..1048575 -> tadDecodedBin[addr - 983040]  // TAD decoded output (65536 bytes)
            else -> peek(addr % 1048576)
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toUint()
        when (adi) {
            in 0..524287 -> { sampleBin[sampleBank * SAMPLE_BANK_SIZE + addr] = byte }
            in 524288..720895 -> { /* reserved */ }
            in 720896..786431 -> (adi - 720896).let { instruments[it / 256].setByte(it % 256, bi) }
            in 786432..851967 -> { val off = adi - 786432; playdata[playheads[0].patBank1 * 128 + off / 512][(off % 512) / 8].setByte(off % 8, bi) }
            in 851968..917503 -> { val off = adi - 851968; playdata[playheads[0].patBank2 * 128 + off / 512][(off % 512) / 8].setByte(off % 8, bi) }
            in 917504..983039 -> tadInputBin[addr - 917504] = byte   // TAD input buffer
            in 983040..1048575 -> tadDecodedBin[addr - 983040] = byte  // TAD decoded output
        }
    }

    override fun mmio_read(addr: Long): Byte {
        val adi = addr.toInt()
        return when (adi) {
            in 0..9 -> playheads[0].read(adi)
            in 10..19 -> playheads[1].read(adi - 10)
            in 20..29 -> playheads[2].read(adi - 20)
            in 30..39 -> playheads[3].read(adi - 30)
            40 -> -1
            41 -> mp2Busy.toInt().toByte()
            42 -> -1  // TAD control (write-only)
            43 -> tadQuality.toByte()
            44 -> tadBusy.toInt().toByte()
            45 -> selectedPcmBin.toByte()
            46 -> sampleBank.toByte()
            in 64..2367 -> mediaDecodedBin[addr - 64]
            in 2368..4095 -> mediaFrameBin[addr - 2368]
            in 4096..4097 -> 0
            // Per-voice fader (0 = unity, 255 = silence): 256 bytes per playhead, only the first
            // 20 entries map to live voice slots; the rest read 0.
            in 4098..5121 -> {
                val off = adi - 4098
                val ph = off ushr 8           // playhead index 0..3
                val v = off and 0xFF          // voice index 0..255
                if (v < 20) (playheads[ph].trackerState?.voices?.getOrNull(v)?.fader ?: 0).toByte()
                else 0.toByte()
            }
            in 32768..65535 -> (adi - 32768).let {
                cueSheet[it / 32].read(it % 32)
            }
            in 65536..131071 -> pcmBin[selectedPcmBin][addr - 65536]
            else -> {
                println("[AudioAdapter] Bus mirroring on mmio_reading while trying to read address $addr")
                mmio_read(addr % 131072)
            }
        }
    }

    override fun mmio_write(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toUint()
        when (adi) {
            in 0..9 -> { playheads[0].write(adi, bi) }
            in 10..19 -> { playheads[1].write(adi - 10, bi) }
            in 20..29 -> { playheads[2].write(adi - 20, bi) }
            in 30..39 -> { playheads[3].write(adi - 30, bi) }
            40 -> {
                if (bi and 16 != 0) { mp2Context = mp2Env.initialise() }
                if (bi and 1 != 0) decodeMp2()
            }
            42 -> {
                // TAD control: bit 0 = decode
                if (bi and 1 != 0) decodeTad()
            }
            43 -> {
                // TAD quality (0-5)
                tadQuality = bi.coerceIn(0, 5)
            }
            45 -> selectedPcmBin = bi % 4
            46 -> sampleBank = bi and SAMPLE_BANK_MASK
            // Per-voice fader writes: see mmio_read for layout. Indices 20..255 are accepted
            // but ignored so software can stride 256 bytes per playhead without bounds-checking.
            in 4098..5121 -> {
                val off = adi - 4098
                val ph = off ushr 8
                val v = off and 0xFF
                if (v < 20) {
                    playheads[ph].trackerState?.voices?.getOrNull(v)?.fader = bi
                }
            }
            in 64..2367 -> { mediaDecodedBin[addr - 64] = byte }
            in 2368..4095 -> { mediaFrameBin[addr - 2368] = byte }
            in 32768..65535 -> { (adi - 32768).let {
                cueSheet[it / 32].write(it % 32, bi)
            } }
            in 65536..131071 -> { pcmBin[selectedPcmBin][addr - 65536] = byte }
        }
    }

    private var disposed = false

    override fun dispose() {
        if (!disposed) {
            disposed = true
            System.err.println("Dispose AudioAdapter")
            renderThreadGroup.interrupt()
            writeQueueingGroup.interrupt()
            playheads.forEach { it.dispose() }
            sampleBin.destroy()
            pcmBin.forEach { it.destroy() }
            mediaFrameBin.destroy()
            mediaDecodedBin.destroy()
            tadInputBin.destroy()
            tadDecodedBin.destroy()
        }
        else {
            System.err.println("AudioAdapter already disposed")
        }
    }

    override fun getVM(): VM {
        return vm
    }

    private var mp2Context = mp2Env.initialise()

    private fun decodeMp2() {
        val periMmioBase = vm.findPeriSlotNum(this)!! * -131072 - 1L
        mp2Env.decodeFrameU8(mp2Context, periMmioBase - 2368, true, periMmioBase - 64)
    }

    //=============================================================================
    // TAD (Terrarum Advanced Audio) Decoder
    //=============================================================================

    // Laplacian-distributed noise (for stochastic reconstruction)
    private fun laplacianNoise(scale: Float): Float {
        val u = urand() - 0.5f  // [-0.5, 0.5)
        val sign = if (u >= 0.0f) 1.0f else -1.0f
        var absU = kotlin.math.abs(u)

        // Avoid log(0)
        if (absU >= 0.49999f) absU = 0.49999f

        // Inverse Laplacian CDF with λ = 1/scale
        val x = -sign * kotlin.math.ln(1.0f - 2.0f * absU) * scale
        return x
    }

    // Uniform random in [0, 1) - kept for compatibility
    private fun frand01(): Float {
        return urand()
    }

    // TPDF (Triangular Probability Density Function) noise in [-1, +1)
    private fun tpdf1(): Float {
        return frand01() - frand01()
    }

    // Lambda-based decompanding decoder (inverse of Laplacian CDF-based encoder)
    // Converts quantised index back to normalised float in [-1, 1]
    private fun lambdaDecompanding(quantVal: Byte, maxIndex: Int): Float {
        // Handle zero
        if (quantVal == 0.toByte()) {
            return 0.0f
        }

        val sign = if (quantVal < 0) -1 else 1
        var absIndex = kotlin.math.abs(quantVal.toInt())

        // Clamp to valid range
        if (absIndex > maxIndex) absIndex = maxIndex

        // Map index back to normalised CDF [0, 1]
        val normalisedCdf = absIndex.toFloat() / maxIndex

        // Map from [0, 1] back to [0.5, 1.0] (CDF range for positive half)
        val cdf = 0.5f + normalisedCdf * 0.5f

        // Inverse Laplacian CDF for x >= 0: x = -(1/λ) * ln(2*(1-F))
        // For F in [0.5, 1.0]: x = -(1/λ) * ln(2*(1-F))
        var absVal = -(1.0f / LAMBDA_FIXED) * kotlin.math.ln(2.0f * (1.0f - cdf))

        // Clamp to [0, 1]
        absVal = absVal.coerceIn(0.0f, 1.0f)

        return sign * absVal
    }

    private fun signum(x: Float): Float {
        return when {
            x > 0.0f -> 1.0f
            x < 0.0f -> -1.0f
            else -> 0.0f
        }
    }

    // Gamma expansion (inverse of gamma compression)
    private fun expandGamma(left: FloatArray, right: FloatArray, count: Int) {
        for (i in 0 until count) {
            // decode(y) = sign(y) * |y|^(1/γ) where γ=0.5
            val x = left[i]
            val a = kotlin.math.abs(x)
            left[i] = signum(x) * a * a

            val y = right[i]
            val b = kotlin.math.abs(y)
            right[i] = signum(y) * b * b
        }
    }

    //=============================================================================
    // De-emphasis Filter
    //=============================================================================

    private fun calculateDeemphasisCoeffs(): Triple<Float, Float, Float> {
        // De-emphasis factor
        val alpha = 0.5f

        val b0 = 1.0f
        val b1 = 0.0f  // No feedforward delay
        val a1 = -alpha  // NEGATIVE because equation has minus sign: y = x - a1*prev_y

        return Triple(b0, b1, a1)
    }

    private fun applyDeemphasis(left: FloatArray, right: FloatArray, count: Int) {
        val (b0, b1, a1) = calculateDeemphasisCoeffs()

        // Left channel - use instance state variables (persistent across chunks)
        for (i in 0 until count) {
            val x = left[i]
            val y = b0 * x + b1 * deemphPrevXL - a1 * deemphPrevYL
            left[i] = y
            deemphPrevXL = x
            deemphPrevYL = y
        }

        // Right channel - use instance state variables (persistent across chunks)
        for (i in 0 until count) {
            val x = right[i]
            val y = b0 * x + b1 * deemphPrevXR - a1 * deemphPrevYR
            right[i] = y
            deemphPrevXR = x
            deemphPrevYR = y
        }
    }

    // M/S stereo correlation (no dithering - that's now in spectral interpolation)
    private fun msCorrelate(mid: FloatArray, side: FloatArray, left: FloatArray, right: FloatArray, sampleCount: Int) {
        for (i in 0 until sampleCount) {
            // Decode M/S → L/R
            val m = mid[i]
            val s = side[i]
            left[i] = (m + s).coerceIn(-1.0f, 1.0f)
            right[i] = (m - s).coerceIn(-1.0f, 1.0f)
        }
    }

    // PCM32f to PCM8 conversion with noise-shaped dithering
    private fun pcm32fToPcm8(fleft: FloatArray, fright: FloatArray, sampleCount: Int) {
        val b1 = 1.5f   // 1st feedback coefficient
        val b2 = -0.75f // 2nd feedback coefficient
        val scale = 127.5f
        val bias = 128

        // Reduced dither amplitude to coordinate with coefficient-domain dithering
        val ditherScale = 0.2f  // Reduced from 0.5

        for (i in 0 until sampleCount) {
            // --- LEFT channel ---
            val feedbackL = b1 * ditherError[0][0] + b2 * ditherError[0][1]
            val ditherL = ditherScale * tpdf1() // Reduced TPDF dither
            val shapedL = (fleft[i] + feedbackL + ditherL / scale).coerceIn(-1.0f, 1.0f)

            val qL = (shapedL * scale).roundToInt().coerceIn(-128, 127)
            tadDecodedBin[i * 2L] = (qL + bias).toByte()

            val qerrL = shapedL - qL.toFloat() / scale
            ditherError[0][1] = ditherError[0][0] // shift history
            ditherError[0][0] = qerrL

            // --- RIGHT channel ---
            val feedbackR = b1 * ditherError[1][0] + b2 * ditherError[1][1]
            val ditherR = ditherScale * tpdf1()
            val shapedR = (fright[i] + feedbackR + ditherR / scale).coerceIn(-1.0f, 1.0f)

            val qR = (shapedR * scale).roundToInt().coerceIn(-128, 127)
            tadDecodedBin[i * 2L + 1] = (qR + bias).toByte()

            val qerrR = shapedR - qR.toFloat() / scale
            ditherError[1][1] = ditherError[1][0]
            ditherError[1][0] = qerrR
        }
    }

    //=============================================================================
    // Binary Tree EZBC Decoder (1D Variant for TAD)
    //=============================================================================

    // Bitstream reader for EZBC
    private class TadBitstreamReader(private val data: ByteArray) {
        private var bytePos = 0
        private var bitPos = 0

        fun readBit(): Int {
            if (bytePos >= data.size) {
                println("ERROR: Bitstream underflow")
                return 0
            }

            val bit = ((data[bytePos].toInt() and 0xFF) shr bitPos) and 1

            bitPos++
            if (bitPos == 8) {
                bitPos = 0
                bytePos++
            }

            return bit
        }

        fun readBits(numBits: Int): Int {
            var value = 0
            for (i in 0 until numBits) {
                value = value or (readBit() shl i)
            }
            return value
        }

        fun getBytesConsumed(): Int {
            return bytePos + if (bitPos > 0) 1 else 0
        }
    }

    // Block structure for 1D binary tree
    private data class TadBlock(val start: Int, val length: Int)

    // Queue for block processing
    private class TadBlockQueue {
        private val blocks = ArrayList<TadBlock>()

        fun push(block: TadBlock) {
            blocks.add(block)
        }

        fun get(index: Int): TadBlock = blocks[index]

        val size: Int get() = blocks.size

        fun clear() {
            blocks.clear()
        }
    }

    // Track coefficient state for refinement
    private data class TadCoeffState(var significant: Boolean = false, var firstBitplane: Int = 0)

    // Check if all coefficients in block have |coeff| < threshold
    private fun tadIsZeroBlock(coeffs: ByteArray, block: TadBlock, threshold: Int): Boolean {
        for (i in block.start until block.start + block.length) {
            if (kotlin.math.abs(coeffs[i].toInt()) >= threshold) {
                return false
            }
        }
        return true
    }

    // Get MSB position (bitplane number)
    private fun tadGetMsbBitplane(value: Int): Int {
        if (value == 0) return 0
        var bitplane = 0
        var v = value
        while (v > 1) {
            v = v shr 1
            bitplane++
        }
        return bitplane
    }

    // Recursively decode a significant block - subdivide until size 1
    private fun tadDecodeSignificantBlockRecursive(
        bs: TadBitstreamReader,
        coeffs: ByteArray,
        states: Array<TadCoeffState>,
        bitplane: Int,
        block: TadBlock,
        nextInsignificant: TadBlockQueue,
        nextSignificant: TadBlockQueue
    ) {
        // If size 1: read sign bit and reconstruct value
        if (block.length == 1) {
            val idx = block.start
            val signBit = bs.readBit()

            // Reconstruct absolute value from bitplane
            val absVal = 1 shl bitplane

            // Apply sign
            coeffs[idx] = (if (signBit != 0) -absVal else absVal).toByte()

            states[idx].significant = true
            states[idx].firstBitplane = bitplane
            nextSignificant.push(block)
            return
        }

        // Block is > 1: subdivide into left and right halves
        val mid = block.length / 2.coerceAtLeast(1)

        // Process left child
        val left = TadBlock(block.start, mid)
        val leftSig = bs.readBit()
        if (leftSig != 0) {
            tadDecodeSignificantBlockRecursive(bs, coeffs, states, bitplane, left, nextInsignificant, nextSignificant)
        } else {
            nextInsignificant.push(left)
        }

        // Process right child (if exists)
        if (block.length > mid) {
            val right = TadBlock(block.start + mid, block.length - mid)
            val rightSig = bs.readBit()
            if (rightSig != 0) {
                tadDecodeSignificantBlockRecursive(bs, coeffs, states, bitplane, right, nextInsignificant, nextSignificant)
            } else {
                nextInsignificant.push(right)
            }
        }
    }

    // Binary tree EZBC decoding for a single channel (1D variant)
    private fun tadDecodeChannelEzbc(input: ByteArray, inputSize: Int, coeffs: ByteArray): Int {
        val bs = TadBitstreamReader(input)

        // Read header: MSB bitplane and length
        val msbBitplane = bs.readBits(8)
        val count = bs.readBits(16)

        // Initialise coefficient array to zero
        coeffs.fill(0)

        // Track coefficient significance
        val states = Array(count) { TadCoeffState() }

        // Initialise queues
        val insignificantQueue = TadBlockQueue()
        val nextInsignificant = TadBlockQueue()
        val significantQueue = TadBlockQueue()
        val nextSignificant = TadBlockQueue()

        // Start with root block as insignificant
        val root = TadBlock(0, count)
        insignificantQueue.push(root)

        // Process bitplanes from MSB to LSB
        for (bitplane in msbBitplane downTo 0) {
            val threshold = 1 shl bitplane

            // Process insignificant blocks
            for (i in 0 until insignificantQueue.size) {
                val block = insignificantQueue.get(i)

                val sig = bs.readBit()
                if (sig == 0) {
                    // Still insignificant
                    nextInsignificant.push(block)
                } else {
                    // Became significant: recursively decode
                    tadDecodeSignificantBlockRecursive(
                        bs, coeffs, states, bitplane, block,
                        nextInsignificant, nextSignificant
                    )
                }
            }

            // Refinement pass: read next bit for already-significant coefficients
            for (i in 0 until significantQueue.size) {
                val block = significantQueue.get(i)
                val idx = block.start

                val bit = bs.readBit()

                // Add this bit to the coefficient's magnitude
                if (bit != 0) {
                    val sign = if (coeffs[idx] < 0) -1 else 1
                    val absVal = kotlin.math.abs(coeffs[idx].toInt())
                    coeffs[idx] = (sign * (absVal or (1 shl bitplane))).toByte()
                }

                // Add to nextSignificant so it continues being refined
                nextSignificant.push(block)
            }

            // Swap queues for next bitplane
            insignificantQueue.clear()
            for (i in 0 until nextInsignificant.size) {
                insignificantQueue.push(nextInsignificant.get(i))
            }
            nextInsignificant.clear()

            significantQueue.clear()
            for (i in 0 until nextSignificant.size) {
                significantQueue.push(nextSignificant.get(i))
            }
            nextSignificant.clear()
        }

        return bs.getBytesConsumed()
    }

    private fun decodeTad() {
        tadBusy = true
        try {
            // Read chunk header from tadInputBin
            var offset = 0L

            val sampleCount = (
                    (tadInputBin[offset++].toUint()) or
                            ((tadInputBin[offset++].toUint()) shl 8)
                    )
            val maxIndex = tadInputBin[offset++].toUint()
            val payloadSizeField = (
                    (tadInputBin[offset++].toUint()) or
                            ((tadInputBin[offset++].toUint()) shl 8) or
                            ((tadInputBin[offset++].toUint()) shl 16) or
                            ((tadInputBin[offset++].toUint()) shl 24)
                    )

            // MSB of payload size = 1 means the payload is stored uncompressed (no Zstd).
            val payloadIsRaw = (payloadSizeField and 0x80000000.toInt()) != 0
            val payloadSize = payloadSizeField and 0x7FFFFFFF

            // Read payload bytes
            val compressed = ByteArray(payloadSize)
            UnsafeHelper.memcpyRaw(null, tadInputBin.ptr + offset, compressed, UnsafeHelper.getArrayOffset(compressed), payloadSize.toLong())

            val payload: ByteArray = if (payloadIsRaw) {
                compressed
            } else {
                try {
                    ZstdInputStream(ByteArrayInputStream(compressed)).use { zstd ->
                        zstd.readBytes()
                    }
                } catch (e: Exception) {
                    println("ERROR: Zstd decompression failed: ${e.message}")
                    return
                }
            }

            // Decode using binary tree EZBC - FIXED!
            val quantMid = ByteArray(sampleCount)
            val quantSide = ByteArray(sampleCount)

            // Decode Mid channel
            val midBytesConsumed = tadDecodeChannelEzbc(
                payload,
                payload.size,
                quantMid
            )

            // Decode Side channel (starts after Mid channel data)
            val sideBytesConsumed = tadDecodeChannelEzbc(
                payload.sliceArray(midBytesConsumed until payload.size),
                payload.size - midBytesConsumed,
                quantSide
            )

            // Calculate DWT levels from sample count
            val dwtLevels = calculateDwtLevels(sampleCount)

            // Dequantise to Float32
            val dwtMid = FloatArray(sampleCount)
            val dwtSide = FloatArray(sampleCount)
            dequantiseDwtCoefficients(0, quantMid, dwtMid, sampleCount, maxIndex, dwtLevels)
            dequantiseDwtCoefficients(1, quantSide, dwtSide, sampleCount, maxIndex, dwtLevels)

            // Inverse DWT using CDF 9/7 wavelet (produces Float32 samples in range [-1.0, 1.0])
            dwt97InverseMultilevel(dwtMid, sampleCount, dwtLevels)
            dwt97InverseMultilevel(dwtSide, sampleCount, dwtLevels)

            // M/S to L/R correlation
            val pcm32Left = FloatArray(sampleCount)
            val pcm32Right = FloatArray(sampleCount)
            msCorrelate(dwtMid, dwtSide, pcm32Left, pcm32Right, sampleCount)

            // Expand dynamic range (gamma expansion)
            expandGamma(pcm32Left, pcm32Right, sampleCount)
//            expandMuLaw(pcm32Left, pcm32Right, sampleCount)

            // Apply de-emphasis filter (AFTER gamma expansion, BEFORE PCM32f to PCM8)
            applyDeemphasis(pcm32Left, pcm32Right, sampleCount)

            // Dither to 8-bit PCMu8
            pcm32fToPcm8(pcm32Left, pcm32Right, sampleCount)

        } catch (e: Exception) {
            e.printStackTrace()
        } finally {
            tadBusy = false
        }
    }

    private fun calculateDwtLevels(chunkSize: Int): Int {
        // Hard-coded to 9 levels to match C decoder
        return 9
    }

    // Compute RMS energy of a coefficient band
    private fun computeBandRms(c: FloatArray, start: Int, len: Int): Float {
        if (len == 0) return 0.0f
        var sumsq = 0.0
        for (i in 0 until len) {
            val v = c[start + i].toDouble()
            sumsq += v * v
        }
        return kotlin.math.sqrt((sumsq / len)).toFloat()
    }

    // Fast PRNG for light dithering (xorshift32)
    private var xorshift32State = 0x9E3779B9u

    private fun xorshift32(): UInt {
        var x = xorshift32State
        x = x xor (x shl 13)
        x = x xor (x shr 17)
        x = x xor (x shl 5)
        xorshift32State = x
        return x
    }

    private fun urand(): Float {
        return (xorshift32() and 0xFFFFFFu).toFloat() / 16777216.0f
    }

    private fun tpdf(): Float {
        return urand() - urand()
    }

    // Simplified spectral reconstruction for wavelet coefficients
    // Conservative approach: only add light dither to reduce quantisation grain
    private fun spectralInterpolateBand(c: FloatArray, start: Int, len: Int, Q: Float, lowerBandRms: Float) {
        if (len < 4) return

        xorshift32State = 0x9E3779B9u xor len.toUInt() xor (Q * 65536.0f).toUInt()
        val ditherAmp = 0.05f * Q  // Very light dither (~-60 dBFS)

        // Just add ultra-light TPDF dither to reduce quantisation grain
        for (i in 0 until len) {
            c[start + i] += tpdf() * ditherAmp
        }
    }

    private fun dequantiseDwtCoefficients(channel: Int, quantised: ByteArray, coeffs: FloatArray, count: Int,
                                         maxIndex: Int, dwtLevels: Int) {
        // Calculate sideband boundaries dynamically
        val firstBandSize = count shr dwtLevels
        val sidebandStarts = IntArray(dwtLevels + 2)
        sidebandStarts[0] = 0
        sidebandStarts[1] = firstBandSize
        for (i in 2..dwtLevels + 1) {
            sidebandStarts[i] = sidebandStarts[i - 1] + (firstBandSize shl (i - 2))
        }

        // Dequantise all coefficients with stochastic reconstruction for deadzoned values
        val quantiserScale = 1.0f
        for (i in 0 until count) {
            var sideband = dwtLevels
            for (s in 0..dwtLevels) {
                if (i < sidebandStarts[s + 1]) {
                    sideband = s
                    break
                }
            }

            // Check for deadzone marker
            /*if (quantised[i] == DEADZONE_MARKER_QUANT) {
                // Stochastic reconstruction: generate Laplacian noise in deadband range
                val deadbandThreshold = DEADBANDS[channel][sideband]

                // Generate Laplacian-distributed noise scaled to deadband width
                // Use scale = threshold/3 to keep ~99% of samples within [-threshold, +threshold]
                var noise = laplacianNoise(deadbandThreshold / 3.0f)

                // Clamp to deadband range
                if (noise > deadbandThreshold) noise = deadbandThreshold
                if (noise < -deadbandThreshold) noise = -deadbandThreshold

                // Apply scalar (but not quantiser weight - noise is already in correct range)
                coeffs[i] = noise * TAD32_COEFF_SCALARS[sideband]
            } else {*/
                // Normal dequantisation using lambda decompanding
                val normalisedVal = lambdaDecompanding(quantised[i], maxIndex)

                // Denormalise using the subband scalar and apply base weight + quantiser scaling
                // CRITICAL: Use channel-specific weights (Mid=0, Side=1)
                val weight = BASE_QUANTISER_WEIGHTS[channel][sideband] * quantiserScale
                coeffs[i] = normalisedVal * TAD32_COEFF_SCALARS[sideband] * weight
//            }
        }

        // Note: Stochastic reconstruction replaces the old spectral interpolation step
        // No need for additional processing - deadzoned coefficients already have appropriate noise
    }

    // 9/7 inverse DWT (CDF 9/7 wavelet - matches C implementation)
    private fun dwt97Inverse1d(data: FloatArray, length: Int) {
        if (length < 2) return

        val temp = FloatArray(length)
        val half = (length + 1) / 2

        // Split into low and high frequency components (matching TSVM layout)
        for (i in 0 until half) {
            temp[i] = data[i]  // Low-pass coefficients (first half)
        }
        for (i in 0 until length / 2) {
            if (half + i < length) {
                temp[half + i] = data[half + i]  // High-pass coefficients (second half)
            }
        }

        // 9/7 inverse lifting coefficients from TSVM
        val alpha = -1.586134342f
        val beta = -0.052980118f
        val gamma = 0.882911076f
        val delta = 0.443506852f
        val K = 1.230174105f

        // Step 1: Undo scaling
        for (i in 0 until half) {
            temp[i] /= K  // Low-pass coefficients
        }
        for (i in 0 until length / 2) {
            if (half + i < length) {
                temp[half + i] *= K  // High-pass coefficients
            }
        }

        // Step 2: Undo δ update
        for (i in 0 until half) {
            val dCurr = if (half + i < length) temp[half + i] else 0.0f
            val dPrev = if (i > 0 && half + i - 1 < length) temp[half + i - 1] else dCurr
            temp[i] -= delta * (dCurr + dPrev)
        }

        // Step 3: Undo γ predict
        for (i in 0 until length / 2) {
            if (half + i < length) {
                val sCurr = temp[i]
                val sNext = if (i + 1 < half) temp[i + 1] else sCurr
                temp[half + i] -= gamma * (sCurr + sNext)
            }
        }

        // Step 4: Undo β update
        for (i in 0 until half) {
            val dCurr = if (half + i < length) temp[half + i] else 0.0f
            val dPrev = if (i > 0 && half + i - 1 < length) temp[half + i - 1] else dCurr
            temp[i] -= beta * (dCurr + dPrev)
        }

        // Step 5: Undo α predict
        for (i in 0 until length / 2) {
            if (half + i < length) {
                val sCurr = temp[i]
                val sNext = if (i + 1 < half) temp[i + 1] else sCurr
                temp[half + i] -= alpha * (sCurr + sNext)
            }
        }

        // Reconstruction - interleave low and high pass
        for (i in 0 until length) {
            if (i % 2 == 0) {
                // Even positions: low-pass coefficients
                data[i] = temp[i / 2]
            } else {
                // Odd positions: high-pass coefficients
                val idx = i / 2
                if (half + idx < length) {
                    data[i] = temp[half + idx]
                } else {
                    data[i] = 0.0f
                }
            }
        }
    }

    private fun dwt97InverseMultilevel(data: FloatArray, length: Int, levels: Int) {
        // Pre-calculate all intermediate lengths used during forward transform
        // Forward uses: data[0..length-1], then data[0..(length+1)/2-1], etc.
        val lengths = IntArray(levels + 1)
        lengths[0] = length
        for (i in 1..levels) {
            lengths[i] = (lengths[i - 1] + 1) / 2
        }

        // Inverse transform: apply inverse DWT using exact forward lengths in reverse order
        // Forward applied DWT with lengths: [length, (length+1)/2, ((length+1)/2+1)/2, ...]
        // Inverse must use same lengths in reverse: [..., ((length+1)/2+1)/2, (length+1)/2, length]
        for (level in levels - 1 downTo 0) {
            dwt97Inverse1d(data, lengths[level])
        }
    }




    //=========================================================================
    // Tracker Engine
    //
    // Effect opcodes follow base-36 digit values (see TAUD_NOTE_EFFECTS.md):
    //   0x00       : no effect
    //   0x08, 0x09 : Taud-only voice FX (8 = bitcrusher, 9 = overdrive; see §8/§9).
    //   0x0A..0x23 : letters A..Z (A=0x0A speed, B=0x0B order jump,
    //                C=0x0C pattern break, D=0x0D vol slide, E=0x0E pitch
    //                down, F=0x0F pitch up, G=0x10 tone porta,
    //                H=0x11 vibrato, I=0x12 tremor, J=0x13 arpeggio,
    //                K=0x14 K, L=0x15 L, O=0x18 sample offset,
    //                Q=0x1A retrig, R=0x1B tremolo, S=0x1C subcommands,
    //                T=0x1D tempo, U=0x1E fine vibrato, V=0x1F global vol,
    //                Y=0x22 panbrello).
    //   K (0x14) and L (0x15) are intentionally no-op in the engine — the
    //   converter is required to split them into a recall-only H/G plus a
    //   volume-column slide cell.
    //=========================================================================

    // 64-entry signed sine table (OpenMPT-style). See TAUD_NOTE_EFFECTS.md §H.
    private val MOD_SIN_TABLE = intArrayOf(
        0x00, 0x0C, 0x19, 0x25, 0x31, 0x3C, 0x47, 0x51,
        0x5A, 0x62, 0x6A, 0x70, 0x75, 0x7A, 0x7D, 0x7E,
        0x7F, 0x7E, 0x7D, 0x7A, 0x75, 0x70, 0x6A, 0x62,
        0x5A, 0x51, 0x47, 0x3C, 0x31, 0x25, 0x19, 0x0C,
        0x00, -0x0C, -0x19, -0x25, -0x31, -0x3C, -0x47, -0x51,
        -0x5A, -0x62, -0x6A, -0x70, -0x75, -0x7A, -0x7D, -0x7E,
        -0x7F, -0x7E, -0x7D, -0x7A, -0x75, -0x70, -0x6A, -0x62,
        -0x5A, -0x51, -0x47, -0x3C, -0x31, -0x25, -0x19, -0x0C
    )

    // ST3-style fine-tune Hz reference offsets in 4096-TET units (S $2x00).
    private val FINETUNE_OFFSET = intArrayOf(
        -0x0154, -0x0132, -0x0111, -0x00E4, -0x00B8, -0x008B, -0x005D, -0x003B,
        0x0000,  0x0023,  0x0046,  0x0074,  0x0098,  0x00C8,  0x00F9,  0x0110
    )

    // LFO sample for vibrato/tremolo waveforms; pos is the 8-bit phase accumulator.
    // See TAUD_NOTE_EFFECTS.md §S$3x for shape semantics.
    private fun lfoSample(pos: Int, wave: Int): Int {
        val idx = (pos ushr 2) and 0x3F
        return when (wave and 3) {
            0 -> MOD_SIN_TABLE[idx]                                  // sine
            1 -> 0x7F - (idx shl 2)                                  // ramp down
            2 -> if (idx < 32) 0x7F else -0x7F                       // square
            else -> ((Math.random() * 256).toInt() and 0xFF) - 0x80  // random
        }
    }

    // Effect opcode constants (base-36 digit values).
    // Letters A..Z map to 0x0A..0x23 (digit value 10..35).
    private object EffectOp {
        const val OP_NONE = 0x00
        const val OP_1 = 0x01
        const val OP_5 = 0x05
        const val OP_6 = 0x06
        const val OP_7 = 0x07
        const val OP_8 = 0x08
        const val OP_9 = 0x09
        const val OP_A = 0x0A
        const val OP_B = 0x0B
        const val OP_C = 0x0C
        const val OP_D = 0x0D
        const val OP_E = 0x0E
        const val OP_F = 0x0F
        const val OP_G = 0x10
        const val OP_H = 0x11
        const val OP_I = 0x12
        const val OP_J = 0x13
        const val OP_K = 0x14
        const val OP_L = 0x15
        const val OP_M = 0x16
        const val OP_N = 0x17
        const val OP_O = 0x18
        const val OP_P = 0x19
        const val OP_Q = 0x1A
        const val OP_R = 0x1B
        const val OP_S = 0x1C
        const val OP_T = 0x1D
        const val OP_U = 0x1E
        const val OP_V = 0x1F
        const val OP_W = 0x20
        const val OP_X = 0x21
        const val OP_Y = 0x22
        const val OP_Z = 0x23
    }

    // Active-sample-aware playback rate. Reads from the Voice's snapshotted sample
    // view (set by [applyActiveSample]) so Ixmp-overlaid instruments use the patch's
    // samplingRate / detune, not the base inst's.
    // Metainstrument layer mix-gain lookup — the "Perceptually Significant Octet to
    // Decibel Table" (terranmon.txt) converted to linear amplitude (10^(dB/20)).
    // Octet 0 = silence, 159 = unity (0 dB), 255 = +24 dB.
    private val META_MIX_GAIN = doubleArrayOf(
        0.0, 5e-05, 5.6e-05, 6.3e-05, 7.1e-05, 7.9e-05, 8.9e-05, 0.0001,
        0.000112, 0.000126, 0.000141, 0.000158, 0.000178, 0.0002, 0.000224, 0.000251,
        0.000282, 0.000316, 0.000355, 0.000398, 0.000447, 0.000501, 0.000562, 0.000631,
        0.000708, 0.000794, 0.000891, 0.001, 0.001122, 0.001259, 0.001413, 0.001585,
        0.001778, 0.001995, 0.002239, 0.002512, 0.002818, 0.003162, 0.003548, 0.003981,
        0.004467, 0.005012, 0.005623, 0.00631, 0.007079, 0.007943, 0.008913, 0.01,
        0.01122, 0.012589, 0.014125, 0.015849, 0.017783, 0.019953, 0.022387, 0.025119,
        0.028184, 0.031623, 0.035481, 0.039811, 0.044668, 0.050119, 0.056234, 0.063096,
        0.066834, 0.070795, 0.074989, 0.079433, 0.08414, 0.089125, 0.094406, 0.1,
        0.105925, 0.112202, 0.11885, 0.125893, 0.133352, 0.141254, 0.149624, 0.158489,
        0.16788, 0.177828, 0.188365, 0.199526, 0.211349, 0.223872, 0.237137, 0.251189,
        0.258523, 0.266073, 0.273842, 0.281838, 0.290068, 0.298538, 0.307256, 0.316228,
        0.325462, 0.334965, 0.344747, 0.354813, 0.365174, 0.375837, 0.386812, 0.398107,
        0.409732, 0.421697, 0.43401, 0.446684, 0.459727, 0.473151, 0.486968, 0.501187,
        0.508452, 0.515822, 0.523299, 0.530884, 0.53858, 0.546387, 0.554307, 0.562341,
        0.570493, 0.578762, 0.587151, 0.595662, 0.604296, 0.613056, 0.621942, 0.630957,
        0.640103, 0.649382, 0.658795, 0.668344, 0.678032, 0.68786, 0.697831, 0.707946,
        0.718208, 0.728618, 0.73918, 0.749894, 0.760764, 0.771792, 0.782979, 0.794328,
        0.805842, 0.817523, 0.829373, 0.841395, 0.853591, 0.865964, 0.878517, 0.891251,
        0.90417, 0.917276, 0.930572, 0.944061, 0.957745, 0.971628, 0.985712, 1.0,
        1.014495, 1.029201, 1.044119, 1.059254, 1.074608, 1.090184, 1.105987, 1.122018,
        1.138282, 1.154782, 1.171521, 1.188502, 1.20573, 1.223207, 1.240938, 1.258925,
        1.277174, 1.295687, 1.314468, 1.333521, 1.352851, 1.372461, 1.392355, 1.412538,
        1.433013, 1.453784, 1.474857, 1.496236, 1.517924, 1.539927, 1.562248, 1.584893,
        1.607867, 1.631173, 1.654817, 1.678804, 1.703139, 1.727826, 1.752871, 1.778279,
        1.804056, 1.830206, 1.856735, 1.883649, 1.910953, 1.938653, 1.966754, 1.995262,
        2.053525, 2.113489, 2.175204, 2.238721, 2.304093, 2.371374, 2.440619, 2.511886,
        2.585235, 2.660725, 2.73842, 2.818383, 2.900681, 2.985383, 3.072557, 3.162278,
        3.254618, 3.349654, 3.447466, 3.548134, 3.651741, 3.758374, 3.868121, 3.981072,
        4.216965, 4.466836, 4.731513, 5.011872, 5.308844, 5.623413, 5.956621, 6.309573,
        6.683439, 7.079458, 7.498942, 7.943282, 8.413951, 8.912509, 9.440609, 10.0,
        10.592537, 11.220185, 11.885022, 12.589254, 13.335214, 14.125375, 14.962357, 15.848932
    )

    private fun computePlaybackRate(voice: Voice, noteVal: Int): Double =
        voice.activeSamplingRate.toDouble() / SAMPLING_RATE *
        2.0.pow((noteVal - MIDDLE_C + voice.activeSampleDetune) / 4096.0)

    /**
     * Snapshot the sample-scope state for [voice] from either the base instrument
     * or a resolved Ixmp patch. Called by every fresh trigger; the per-tick read
     * sites then go through voice.active* instead of inst.* so multi-sample
     * (IT/XM keyboard table) instruments select the right sample per note.
     *
     * Sentinels on the patch: defaultPan == 0xFF, defaultNoteVolume == 0,
     * vibratoWaveform == 0xFF all defer to the base instrument. Other fields
     * are always carried by the patch (converter responsibility).
     */
    private fun applyActiveSample(voice: Voice, inst: TaudInst, patch: TaudInstPatch?) {
        if (patch == null) {
            voice.activeSamplePtr        = inst.samplePtr
            voice.activeSampleLength     = inst.sampleLength
            voice.activeSamplePlayStart  = inst.samplePlayStart
            voice.activeSampleLoopStart  = inst.sampleLoopStart
            voice.activeSampleLoopEnd    = inst.sampleLoopEnd
            voice.activeSamplingRate     = inst.samplingRate
            voice.activeSampleDetune     = inst.sampleDetuneSigned
            voice.activeLoopMode         = inst.loopMode
            voice.activeVibratoSpeed     = inst.vibratoSpeed
            voice.activeVibratoSweep     = inst.vibratoSweep
            voice.activeVibratoDepth     = inst.vibratoDepth
            voice.activeVibratoRate      = inst.vibratoRate
            voice.activeVibratoWaveform  = inst.vibratoWaveform
        } else {
            voice.activeSamplePtr        = patch.samplePtr
            voice.activeSampleLength     = patch.sampleLength
            voice.activeSamplePlayStart  = patch.playStart
            voice.activeSampleLoopStart  = patch.loopStart
            voice.activeSampleLoopEnd    = patch.loopEnd
            voice.activeSamplingRate     = patch.samplingRate
            voice.activeSampleDetune     = patch.sampleDetune
            voice.activeLoopMode         = patch.loopMode
            voice.activeVibratoSpeed     = patch.vibratoSpeed
            voice.activeVibratoSweep     = patch.vibratoSweep
            voice.activeVibratoDepth     = patch.vibratoDepth
            voice.activeVibratoRate      = patch.vibratoRate
            voice.activeVibratoWaveform  =
                if (patch.vibratoWaveform == 0xFF) inst.vibratoWaveform else patch.vibratoWaveform
        }
        resolveActiveEnvelopes(voice, inst, patch)
    }

    /**
     * Snapshot the active volume / pan / pitch / filter envelopes and the fadeout +
     * cutoff + resonance scalars onto [voice] from either the base instrument or a
     * resolved Ixmp patch. Called by [applyActiveSample] (every trigger).
     *
     * The base instrument exposes two pf-envelope slots (bytes 19.. and 197..); each is
     * routed into the pitch or filter role by its m-bit (LOOP-word bit 7). A patch's 'P'
     * (pitch) / 'f' (filter) blocks override the corresponding role; its 'v' / 'p' / 'x'
     * blocks override the volume / pan envelopes and the fadeout/cutoff/resonance. Any
     * block the patch does not carry defers to the base instrument.
     */
    private fun resolveActiveEnvelopes(voice: Voice, inst: TaudInst, patch: TaudInstPatch?) {
        val volEnv = patch?.volEnv
        if (volEnv != null) {
            voice.activeVolEnv = volEnv; voice.activeVolEnvLoop = patch.volEnvLoop; voice.activeVolEnvSustain = patch.volEnvSustain
        } else {
            voice.activeVolEnv = inst.volEnvelopes; voice.activeVolEnvLoop = inst.volEnvLoop; voice.activeVolEnvSustain = inst.volEnvSustainWord
        }
        val panEnv = patch?.panEnv
        if (panEnv != null) {
            voice.activePanEnv = panEnv; voice.activePanEnvLoop = patch.panEnvLoop; voice.activePanEnvSustain = patch.panEnvSustain
        } else {
            voice.activePanEnv = inst.panEnvelopes; voice.activePanEnvLoop = inst.panEnvLoop; voice.activePanEnvSustain = inst.panEnvSustainWord
        }

        // Pitch + filter: route the base inst's two pf-slots by their m-bit, then let the
        // patch override the matching role. m-bit (LOOP-word bit 7): 0 = pitch, 1 = filter.
        var pitEnv = inst.pfEnvelopes;  var pitLoop = 0; var pitSus = 0; var pitOn = false
        var filEnv = inst.pfEnvelopes;  var filLoop = 0; var filSus = 0; var filOn = false
        // base slot 1 (bytes 19..)
        if (envPresent(inst.pfEnvLoop)) {
            if ((inst.pfEnvLoop ushr 7) and 1 != 0) { filEnv = inst.pfEnvelopes; filLoop = inst.pfEnvLoop; filSus = inst.pfEnvSustainWord; filOn = true }
            else                                    { pitEnv = inst.pfEnvelopes; pitLoop = inst.pfEnvLoop; pitSus = inst.pfEnvSustainWord; pitOn = true }
        }
        // base slot 2 (bytes 197..)
        if (envPresent(inst.pf2EnvLoop)) {
            if ((inst.pf2EnvLoop ushr 7) and 1 != 0) { filEnv = inst.pf2Envelopes; filLoop = inst.pf2EnvLoop; filSus = inst.pf2EnvSustainWord; filOn = true }
            else                                     { pitEnv = inst.pf2Envelopes; pitLoop = inst.pf2EnvLoop; pitSus = inst.pf2EnvSustainWord; pitOn = true }
        }
        // patch overrides by role
        val pPit = patch?.pitchEnv
        if (pPit != null)  { pitEnv = pPit; pitLoop = patch.pitchEnvLoop; pitSus = patch.pitchEnvSustain; pitOn = envPresent(patch.pitchEnvLoop) }
        val pFil = patch?.filterEnv
        if (pFil != null)  { filEnv = pFil; filLoop = patch.filterEnvLoop; filSus = patch.filterEnvSustain; filOn = envPresent(patch.filterEnvLoop) }
        voice.activePitchEnv = pitEnv;  voice.activePitchEnvLoop = pitLoop;  voice.activePitchEnvSustain = pitSus;  voice.hasPitchEnv = pitOn
        voice.activeFilterEnv = filEnv; voice.activeFilterEnvLoop = filLoop; voice.activeFilterEnvSustain = filSus; voice.hasFilterEnv = filOn

        // Fadeout / cutoff / resonance / initialAttenuation / filter mode (patch 'x' block,
        // else base inst). In SF mode the cutoff/resonance are 16-bit (cents / centibels).
        if (patch != null && patch.hasExtra) {
            voice.activeFadeoutStep = patch.fadeoutStep
            voice.filterSfMode = patch.filterSfMode
            voice.activeDefaultCutoff = patch.extraCutoff
            voice.activeDefaultResonance = patch.extraResonance
            voice.activeAttenGain = attenGainOf(patch.extraInitialAttenOctet)
        } else {
            voice.activeFadeoutStep = inst.volumeFadeoutLow or ((inst.fadeoutHigh and 0x0F) shl 8)
            voice.filterSfMode = inst.filterSfMode
            voice.activeDefaultCutoff = inst.defaultCutoff16
            voice.activeDefaultResonance = inst.defaultResonance16
            voice.activeAttenGain = attenGainOf(inst.initialAttenOctet)
        }
    }

    /** initialAttenuation octet ("Perceptually Significant Octet to Decibel Table") → linear
     *  amplitude multiplier. Octet 0 is the unset sentinel (= unity); 159 = 0 dB; 111 = −6 dB. */
    private fun attenGainOf(octet: Int): Double =
        if (octet <= 0) 1.0 else META_MIX_GAIN[octet and 0xFF]

    // Convert a 4096-TET noteVal to its Amiga-period equivalent (Double, no rounding).
    private fun noteValToAmigaPeriod(noteVal: Int): Double =
        AMIGA_BASE_PERIOD * 2.0.pow(-(noteVal - MIDDLE_C).toDouble() / 4096.0)

    // Convert an Amiga period (Double) to the nearest 4096-TET noteVal.
    private fun amigaPeriodToNoteVal(period: Double): Int =
        (MIDDLE_C + 4096.0 * log2(AMIGA_BASE_PERIOD / period)).roundToInt()

    // Applies one tick of Amiga-mode pitch slide.  When the song is in Amiga tone mode, E/F coarse
    // slide arguments are stored as raw tracker period units (the original ProTracker/ST3 byte),
    // *not* scaled to 4096-TET — see TAUD_NOTE_EFFECTS.md §1 and §E/F.  Sign convention matches
    // linear mode: negative = pitch down (E effect), positive = pitch up (F effect), so a positive
    // slideArg subtracts from the period (pitch rises).
    //
    // Period state is persisted on the Voice (voice.amigaPeriod) so accumulated period changes
    // don't lose sub-noteVal precision via repeated noteVal-int rounding.  voice.amigaPeriod < 0
    // means the cache is stale and must be reseeded from the current noteVal.
    private fun amigaSlideTick(voice: Voice, slideArg: Int): Int {
        if (voice.amigaPeriod < 0.0) voice.amigaPeriod = noteValToAmigaPeriod(voice.noteVal)
        voice.amigaPeriod = (voice.amigaPeriod - slideArg).coerceAtLeast(1.0)
        return amigaPeriodToNoteVal(voice.amigaPeriod)
    }

    // One-shot Amiga slide that does NOT mutate persistent period state — used for
    // fine slides (EFx / FFx) which are applied once per row at tick 0.  The next
    // multi-tick slide will reseed amigaPeriod from the resulting noteVal.
    private fun amigaSlideOnce(noteVal: Int, slideArg: Int): Int {
        val period = noteValToAmigaPeriod(noteVal)
        val newPeriod = (period - slideArg).coerceAtLeast(1.0)
        return amigaPeriodToNoteVal(newPeriod)
    }

    // Linear-frequency mode (toneMode == 2): E / F / G arguments are interpreted as Hz/tick.
    // The reference is fixed at 12-TET A4 = 440 Hz (so MIDDLE_C ≈ 261.6256 Hz). MONOTONE
    // (.MON) is the canonical source — its 1xx/2xx/3xx commands use Hz/tick directly, so
    // mon2taud.py emits the raw byte and relies on this mode. Like Amiga mode, a per-voice
    // linearFreq cache (`voice.linearFreq`) preserves sub-noteVal precision across ticks;
    // -1.0 means stale and must be reseeded from current noteVal.
    private fun noteValToFreqHz(noteVal: Int): Double =
        LINEAR_FREQ_C4_HZ * 2.0.pow((noteVal - MIDDLE_C).toDouble() / 4096.0)

    private fun freqHzToNoteVal(freq: Double): Int =
        (MIDDLE_C + 4096.0 * log2(freq / LINEAR_FREQ_C4_HZ)).roundToInt()

    // Per-tick linear-freq slide. Sign convention matches linear/Amiga modes: positive
    // slideArg = pitch up = freq rises; negative = pitch down = freq falls.
    private fun linearFreqSlideTick(voice: Voice, slideArg: Int): Int {
        if (voice.linearFreq < 0.0) voice.linearFreq = noteValToFreqHz(voice.noteVal)
        voice.linearFreq = (voice.linearFreq + slideArg).coerceAtLeast(1.0)
        return freqHzToNoteVal(voice.linearFreq)
    }

    // One-shot linear-freq slide for fine E/F (applied once per row at tick 0); does
    // not mutate persistent state.
    private fun linearFreqSlideOnce(noteVal: Int, slideArg: Int): Int {
        val freq = noteValToFreqHz(noteVal)
        val newFreq = (freq + slideArg).coerceAtLeast(1.0)
        return freqHzToNoteVal(newFreq)
    }

    /**
     * Resolve the active wrap region for an envelope based on the LOOP and
     * SUSTAIN words and key state.
     *
     * Encoding (terranmon.txt:2049+, 2114+):
     *   LOOP word (offset 15/17/19):    0b 0000_0sss_ssXcb_eeeee
     *   SUSTAIN word (offset 189/191/193): 0b 0000_0sss_ss00b_eeeee
     *   In both, bit 5 = b (enable). bits 12..8 = start, bits 4..0 = end.
     *
     * Priority (matches schismtracker player/sndmix.c:480-499):
     *   if SUSTAIN.b and !keyOff : wrap (sus_start, sus_end)
     *   elif LOOP.b              : wrap (loop_start, loop_end)
     *   else                     : no wrap (envelope walks forward and holds)
     *
     * Returns -1 in `wrapEnd` when no wrap is active.
     */
    private inline fun resolveEnvWrap(loopWord: Int, sustainWord: Int, keyOff: Boolean,
                                       outRange: IntArray) {
        val susB = (sustainWord ushr 5) and 1 != 0
        val loopB = (loopWord ushr 5) and 1 != 0
        if (susB && !keyOff) {
            outRange[0] = (sustainWord ushr 8) and 0x1F
            outRange[1] = sustainWord and 0x1F
        } else if (loopB) {
            outRange[0] = (loopWord ushr 8) and 0x1F
            outRange[1] = loopWord and 0x1F
        } else {
            outRange[0] = -1
            outRange[1] = -1
        }
    }

    // Envelope-present test (terranmon.txt byte 15/17/19, P bit at LOOP word bit 13).
    // The P bit is the sole presence signal — converters set it whenever they emit
    // envelope nodes. Pre-2026-05-06 .taud files without P will not have pan/pf
    // envelopes evaluated; re-convert from source.
    private inline fun envPresent(loopWord: Int): Boolean = ((loopWord ushr 13) and 1) != 0

    // Reusable per-envelope wrap-range scratch (avoid per-tick allocation).
    private val volWrap = IntArray(2)
    private val panWrap = IntArray(2)
    private val pfWrap  = IntArray(2)
    // Scratch in/out boxes for advancePfRole (shared pitch+filter walk). Single-threaded
    // per playhead; pitch and filter advance sequentially within one tick.
    private val pfIdxBox  = IntArray(1)
    private val pfTimeBox = DoubleArray(1)

    /**
     * "Key Lift" (instrument flag byte 186 bit 5; NNA pattern 0b100): MIDI-exact
     * key release. IT key-off semantics only release the SUSTAIN wrap — the
     * envelope playhead still walks the remainder of the pre-sustain nodes
     * (hold/decay) before it ever reaches the release nodes, which makes
     * held-style instruments (SF2 imports with multi-second hold/decay) ring
     * long past the key-up like a depressed sustain pedal. A Key Lift
     * instrument instead jumps the volume-envelope playhead straight to the
     * sustain-end node on key-off, so the post-sustain (release) nodes play
     * immediately — exactly what a MIDI synth does when the key is lifted.
     *
     * Call wherever `keyOff = true` is applied to a voice (pattern KEY_OFF,
     * NNA Note Off ghosts, DCA Note Off, past-note S$71). The level step from
     * the current envelope value to the sustain node is absorbed by the
     * per-sample envVolMix smoothing.
     */
    private fun applyKeyLift(voice: Voice, inst: TaudInst) {
        if (!inst.nnaKeyLift) return
        // The volume envelope and its sustain word are the ACTIVE (patch-or-base) ones,
        // so per-patch SF2 ADSR layers each jump to their own sustain-end node on key-off.
        val sus = voice.activeVolEnvSustain
        if ((sus ushr 5) and 1 == 0) return        // no sustain region — nothing to jump to
        val susEnd = sus and 0x1F
        if (voice.envIndex >= susEnd) return       // already at/past the release boundary
        voice.envIndex = susEnd
        voice.envTimeSec = 0.0
        voice.envVolume = (voice.activeVolEnv[susEnd].value / 63.0).coerceIn(0.0, 1.0)
    }

    private fun advanceEnvelope(voice: Voice, tickSec: Double) {
        val maxIdx = 24

        // Volume envelope. Evaluation is gated only by voice.volEnvOn (toggled by S$7/$8);
        // the LOOP/SUSTAIN `b` bits gate WRAPPING behaviour, not whether the envelope runs.
        // This matches Schism (player/sndmix.c:470-502): CHN_VOLENV is set independently of
        // ENV_VOLLOOP / ENV_VOLSUSTAIN, so an envelope marked "enabled but no wrap" still
        // walks forward — which is exactly the IT idiom of an instrument whose envelope
        // shape provides the natural decay. Without this, IT envelopes with flags=0x01
        // (enabled-no-loop-no-sustain) would never advance and the envelope-end-zero cut
        // rule below would never fire — voices would hang forever on key-off / NNA-Continue.
        // Default-only envelopes (single full-volume point at value 63 with offset 0) are
        // safe to evaluate: the engine just holds at envVolume = 1.0, no audible effect.
        // The envelope read is the ACTIVE (patch-or-base) one — see resolveActiveEnvelopes.
        val volEnv = voice.activeVolEnv
        if (voice.volEnvOn) {
            resolveEnvWrap(voice.activeVolEnvLoop, voice.activeVolEnvSustain, voice.keyOff, volWrap)
            val wStart = volWrap[0]
            val wEnd   = volWrap[1]
            val wrapping = wStart >= 0

            if (wrapping && voice.envIndex == wEnd && wStart == wEnd) {
                // Hold at the wrap point (FT2 single-point sustain).
                voice.envVolume = (volEnv[voice.envIndex].value / 63.0).coerceIn(0.0, 1.0)
            } else if (wrapping && voice.envIndex == wEnd) {
                voice.envTimeSec = 0.0
                voice.envIndex = wStart
                voice.envVolume = (volEnv[voice.envIndex].value / 63.0).coerceIn(0.0, 1.0)
            } else if (voice.envIndex >= maxIdx) {
                val vEnd = volEnv[maxIdx].value
                voice.envVolume = (vEnd / 63.0).coerceIn(0.0, 1.0)
                // Schism's "envelope-end + last-value-0 ⇒ cut" rule (player/sndmix.c:493-498):
                // applies only in fall-through (no active sustain or loop wrap) since Schism
                // suppresses fade_flag inside both wrap branches. Without this rule, instruments
                // with fadeout=0 + envelope ending at 0 would silently hold their voices forever.
                // Use startRampOut instead of bare active=false so the trailing sample value
                // fades to zero over RAMP_OUT_SAMPLES (~8 ms); a hard deactivation here would
                // click because envVolMix still has not fully reached 0 by the time this tick
                // fires.
                if (vEnd == 0 && !wrapping) startRampOut(voice)
            } else {
                val vOffset = volEnv[voice.envIndex].offset.toDouble()
                val vCurValue = volEnv[voice.envIndex].value
                if (vOffset == 0.0) {
                    // Reached a terminator point — envelope holds here.
                    voice.envVolume = (vCurValue / 63.0).coerceIn(0.0, 1.0)
                    // Same Schism cut rule as above: only when in fall-through.
                    if (vCurValue == 0 && !wrapping) startRampOut(voice)
                } else {
                    voice.envTimeSec += tickSec
                    if (voice.envTimeSec >= vOffset) {
                        voice.envTimeSec -= vOffset
                        val nextIdx = if (wrapping && voice.envIndex == wEnd) wStart
                                      else (voice.envIndex + 1).coerceAtMost(maxIdx)
                        voice.envIndex = nextIdx
                        voice.envVolume = (volEnv[voice.envIndex].value / 63.0).coerceIn(0.0, 1.0)
                    } else {
                        val cur = (vCurValue / 63.0).coerceIn(0.0, 1.0)
                        val nxt = (volEnv[(voice.envIndex + 1).coerceAtMost(maxIdx)].value / 63.0).coerceIn(0.0, 1.0)
                        voice.envVolume = cur + (nxt - cur) * (voice.envTimeSec / vOffset)
                    }
                }
            }
        }

        // Pan envelope. Presence is decided once per trigger and stored on the voice
        // (voice.hasPanEnv is keyed on LOOP.P — see triggerNote). Like the volume
        // envelope above, evaluation is no longer gated by the wrap-enable bits: an
        // envelope marked "present but no wrap" still walks forward, matching the IT
        // idiom (pan-env flag=0x01) and Schism player/sndmix.c:470-502.
        if (!voice.hasPanEnv || !voice.panEnvOn) return
        val panEnv = voice.activePanEnv
        resolveEnvWrap(voice.activePanEnvLoop, voice.activePanEnvSustain, voice.keyOff, panWrap)
        val pStart = panWrap[0]
        val pEnd   = panWrap[1]
        val pWrapping = pStart >= 0

        if (pWrapping && voice.envPanIndex == pEnd && pStart == pEnd) {
            voice.envPan = panEnv[voice.envPanIndex].value / 255.0
        } else if (pWrapping && voice.envPanIndex == pEnd) {
            voice.envPanTimeSec = 0.0
            voice.envPanIndex = pStart
            voice.envPan = panEnv[voice.envPanIndex].value / 255.0
        } else if (voice.envPanIndex >= maxIdx) {
            voice.envPan = panEnv[maxIdx].value / 255.0
        } else {
            val pOffset = panEnv[voice.envPanIndex].offset.toDouble()
            if (pOffset == 0.0) {
                voice.envPan = panEnv[voice.envPanIndex].value / 255.0
            } else {
                voice.envPanTimeSec += tickSec
                if (voice.envPanTimeSec >= pOffset) {
                    voice.envPanTimeSec -= pOffset
                    val nextIdx = if (pWrapping && voice.envPanIndex == pEnd) pStart
                                  else (voice.envPanIndex + 1).coerceAtMost(maxIdx)
                    voice.envPanIndex = nextIdx
                    voice.envPan = panEnv[voice.envPanIndex].value / 255.0
                } else {
                    val cur = panEnv[voice.envPanIndex].value / 255.0
                    val nxt = panEnv[(voice.envPanIndex + 1).coerceAtMost(maxIdx)].value / 255.0
                    voice.envPan = cur + (nxt - cur) * (voice.envPanTimeSec / pOffset)
                }
            }
        }
    }

    /**
     * Generic 25-node envelope walk shared by the pitch and filter envelopes. Reads the
     * active env array + LOOP/SUSTAIN words and the supplied playhead state, returns the
     * new value (0.0..1.0; 0.5 = unity) and writes back the advanced index/time via the
     * 2-element [stateIO] scratch ([0]=index, [1] holds the elapsed time as raw bits is
     * impractical, so time is passed/returned through [timeBox]). Kept allocation-free.
     */
    private fun advancePfRole(
        env: Array<TaudInstEnvPoint>, loopWord: Int, susWord: Int, keyOff: Boolean,
        tickSec: Double, wrapScratch: IntArray, idxBox: IntArray, timeBox: DoubleArray
    ): Double {
        val maxIdx = 24
        resolveEnvWrap(loopWord, susWord, keyOff, wrapScratch)
        val susStart = wrapScratch[0]
        val susEnd   = wrapScratch[1]
        val susOn    = susStart >= 0
        var idx = idxBox[0]
        if (susOn && idx == susEnd && susStart == susEnd) {
            return env[idx].value / 255.0
        } else if (susOn && idx == susEnd) {
            timeBox[0] = 0.0; idx = susStart; idxBox[0] = idx
            return env[idx].value / 255.0
        } else if (idx >= maxIdx) {
            return env[maxIdx].value / 255.0
        } else {
            // Advance through zero-duration nodes rather than freezing on them. A node
            // whose offset rounds to 0 (sub-4 ms — ThreeFiveMinifloat's smallest non-zero
            // step is ≈3.9 ms, so e.g. an SF2 filter mod-env's 1 ms attack stores offset 0)
            // is passed instantly, so the envelope must move on to the next node. The old
            // code returned here WITHOUT advancing the index, stranding fast-attack filter
            // mod-envs at their first node: the filter never opened from its base cutoff to
            // the sustain cutoff, so Strings/Flute/Guitar (SF2 base ~600 Hz, sustain ~6 kHz)
            // played permanently muffled. The loop stops at a sustain/loop boundary (handled
            // by the susEnd branch below and the top-of-function checks) or at maxIdx.
            while (idx < maxIdx && !(susOn && idx == susEnd) && env[idx].offset.toDouble() == 0.0) {
                idx++
            }
            if (susOn && idx == susEnd) {
                // Reached the sustain/loop end while skipping: hold (single-node sustain) or
                // loop back to susStart, mirroring the top-of-function dispatch.
                if (susStart != susEnd) { timeBox[0] = 0.0; idx = susStart }
                idxBox[0] = idx
                return env[idx].value / 255.0
            }
            idxBox[0] = idx
            if (idx >= maxIdx) {
                return env[maxIdx].value / 255.0
            }
            val offset = env[idx].offset.toDouble()
            timeBox[0] += tickSec
            if (timeBox[0] >= offset) {
                timeBox[0] -= offset
                idx = (idx + 1).coerceAtMost(maxIdx)
                idxBox[0] = idx
                return env[idx].value / 255.0
            }
            val cur = env[idx].value / 255.0
            val nxt = env[(idx + 1).coerceAtMost(maxIdx)].value / 255.0
            return cur + (nxt - cur) * (timeBox[0] / offset)
        }
    }

    /** Advance the pitch envelope (drives playback rate; 0.5 = unity). */
    private fun advancePitchEnvelope(voice: Voice, tickSec: Double) {
        if (!voice.hasPitchEnv || !voice.pitchEnvOn) return
        pfIdxBox[0] = voice.envPitchIndex; pfTimeBox[0] = voice.envPitchTimeSec
        voice.envPitchValue = advancePfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
            voice.activePitchEnvSustain, voice.keyOff, tickSec, pfWrap, pfIdxBox, pfTimeBox)
        voice.envPitchIndex = pfIdxBox[0]; voice.envPitchTimeSec = pfTimeBox[0]
    }

    /** Advance the filter envelope (drives cutoff; 0.5 = unity). */
    private fun advanceFilterEnvelope(voice: Voice, tickSec: Double) {
        if (!voice.hasFilterEnv || !voice.filterEnvOn) return
        pfIdxBox[0] = voice.envFilterIndex; pfTimeBox[0] = voice.envFilterTimeSec
        voice.envFilterValue = advancePfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
            voice.activeFilterEnvSustain, voice.keyOff, tickSec, pfWrap, pfIdxBox, pfTimeBox)
        voice.envFilterIndex = pfIdxBox[0]; voice.envFilterTimeSec = pfTimeBox[0]
    }

    /**
     * Recompute the IT-compatible 2-pole resonant low-pass coefficients for
     * `voice` when its cutoff or resonance has changed since the last refresh.
     *
     * Taud's filter range mirrors Impulse Tracker's at double resolution:
     * Taud 0..254 maps to IT 0..127, while Taud 255 means "filter off" (the
     * IT high-bit-clear sentinel). The filter is bypassed when cutoff = 255.
     *
     * The coefficient math and topology mirror OpenMPT/Schism Tracker (see
     * reference_materials/tracker_filter/openmpt_Snd_flt.cpp and
     * schism_filters.c). Notably this is NOT a biquad: the recurrence has no
     * feedforward x[n-1] / x[n-2] terms.
     *
     *   frequency = 110 Hz × 2^(itCutoff / 24 + 0.25)         (IT 0..127)
     *   dmpfac    = 10 ^ (-itResonance × 0.009375)            (= 24/128/20 dB)
     *   r         = mixingFreq / (2π × frequency)
     *   d         = dmpfac × r + dmpfac − 1
     *   e         = r²
     *   denom     = 1 + d + e
     *   A0        = 1 / denom
     *   B0        = (d + 2e) / denom
     *   B1        = −e / denom
     *   y[n]      = A0 × x[n] + B0 × y[n−1] + B1 × y[n−2]
     *
     * SoundFont mode uses a different, faithful port of FluidSynth's filter
     * (reference_materials/fluidsynth/src/rvoice/fluid_iir_filter_impl.cpp):
     * the RBJ biquad low-pass with the SF2 `sqrt(1/Q)` resonance gain-norm.
     * The IT all-pole filter is overdamped — even at the SF2 "open" default
     * (13500 cents) it loses ~3 dB at 8 kHz / ~5 dB at 12 kHz, which is audible
     * muffling against FluidSynth on every default-filter GM instrument. The
     * biquad's passband is maximally flat (Butterworth at the default Q), so
     * SF mode now switches topology rather than just remapping cutoff/Q.
     */
    private fun refreshVoiceFilter(voice: Voice) {
        val cut = voice.currentCutoff
        val res = voice.currentResonance
        if (cut == voice.filterCutoffCached && res == voice.filterResonanceCached) return
        voice.filterCutoffCached = cut
        voice.filterResonanceCached = res

        val nyquist = SAMPLING_RATE * 0.5 - 1.0
//        println("voice.filterSfMode = ${voice.filterSfMode}")
        if (voice.filterSfMode) {
            // SoundFont mode: cutoff = absolute cents, resonance = centibels above DC gain.
            //   freq = 8.176 Hz × 2^(cents/1200)   (cents relative to 8.176 Hz = MIDI 0)
            // FluidSynth clamps fres to [5 Hz, 0.45·fs] and uses it as an anti-alias
            // filter rather than switching off near Nyquist (fluid_iir_filter_calc).
            if (cut >= 0xFFFF) { voice.filterActive = false; return }
            val fres = (8.176 * 2.0.pow(cut / 1200.0)).coerceIn(5.0, 0.45 * SAMPLING_RATE)

            // SF2 Q (centibels) → linear Q, with FluidSynth's −3.01 dB offset so that
            // Q=0 cB is Butterworth (q_lin = 1/√2), i.e. no resonance hump
            // (fluid_iir_filter_q_from_dB). Clamp dB to [0, 96] as FluidSynth does.
            val qcb = if (res >= 0xFFFF) 0 else res
            val qDb = (qcb / 10.0).coerceIn(0.0, 96.0) - 3.01
            val qLin = 10.0.pow(qDb / 20.0).coerceAtLeast(0.001)

            // RBJ cookbook low-pass (bilinear-transformed), normalised to a0.
            val omega = 2.0 * PI * fres / SAMPLING_RATE
            val sinC = sin(omega)
            val cosC = cos(omega)
            val alpha = sinC / (2.0 * qLin)
            val a0inv = 1.0 / (1.0 + alpha)
            // SF2 §2.01 p.59: halve the resonance-peak height by scaling the gain
            // with sqrt(1/Q); folded into the b coefficients here.
            val gain = a0inv / sqrt(qLin)
            voice.filterBqB1  = (1.0 - cosC) * gain
            voice.filterBqB02 = voice.filterBqB1 * 0.5
            voice.filterBqA1  = -2.0 * cosC * a0inv
            voice.filterBqA2  = (1.0 - alpha) * a0inv
            voice.filterIsBiquad = true
            voice.filterActive = true
            return
        }

        if (cut.coerceIn(0, 255) >= 255) { voice.filterActive = false; return }
        val itCutoff    = cut.coerceIn(0, 254) * 0.5                 // 0..127
        val itResonance = if (res >= 255) 0.0 else res.coerceIn(0, 254) * 0.5
        val frequency = (110.0 * 2.0.pow(itCutoff / 24.0 + 0.25)).coerceAtMost(nyquist)
        val dmpfac    = 10.0.pow(-itResonance * (24.0 / 128.0) / 20.0)

        val r = SAMPLING_RATE / (2.0 * PI * frequency)
        val d = dmpfac * r + dmpfac - 1.0
        val e = r * r
        val denom = 1.0 + d + e

        voice.filterA0 = 1.0 / denom
        voice.filterB0 = (d + e + e) / denom
        voice.filterB1 = -e / denom
        voice.filterIsBiquad = false
        voice.filterActive = true
    }

    /** Apply the cached voice low-pass to one mono sample. Caller must have
     *  called refreshVoiceFilter at the start of the tick.
     *
     *  SoundFont voices run FluidSynth's RBJ biquad (Direct Form I):
     *    y[n] = b02·(x[n]+x[n-2]) + b1·x[n-1] - a1·y[n-1] - a2·y[n-2]
     *
     *  Tracker voices run the IT all-pole recurrence, whose history taps are
     *  clipped to ±2.0 to tame resonance ringing on extreme settings (matching
     *  OpenMPT's ClipFilter helper). The biquad does not clip — FluidSynth runs
     *  it unclamped, and the SF2 gain-norm already bounds the resonance peak. */
    private fun applyVoiceFilter(voice: Voice, x0: Double): Double {
        if (!voice.filterActive) return x0
        if (voice.filterIsBiquad) {
            val y0 = voice.filterBqB02 * (x0 + voice.filterX2) +
                     voice.filterBqB1 * voice.filterX1 -
                     voice.filterBqA1 * voice.filterY1 -
                     voice.filterBqA2 * voice.filterY2
            voice.filterX2 = voice.filterX1
            voice.filterX1 = x0
            voice.filterY2 = voice.filterY1
            voice.filterY1 = y0
            return y0
        }
        val y1Clipped = voice.filterY1.coerceIn(-2.0, 2.0)
        val y2Clipped = voice.filterY2.coerceIn(-2.0, 2.0)
        val y0 = voice.filterA0 * x0 +
                 voice.filterB0 * y1Clipped +
                 voice.filterB1 * y2Clipped
        voice.filterY2 = voice.filterY1
        voice.filterY1 = y0
        return y0
    }

    /**
     * Apply Taud's voice-level overdrive (effect 9) and bitcrusher (effect 8) to a
     * post-filter sample in [-1, 1].  Call once per output sample, per active voice.
     *
     * Order is overdrive → shared clipper → bitcrusher (sample-rate reduce → bit depth quantise).
     * If neither effect is engaged the input is returned unchanged.  See TAUD_NOTE_EFFECTS.md §8/§9.
     */
    private fun applyTaudVoiceFx(voice: Voice, sample: Double): Double {
        var s = sample
        val overdriveOn = voice.overdriveAmp > 0
        // 8..15 collapses to a no-op on TSVM's 8-bit mixdown, but we still allow the bit field to
        // ride alongside an active sample-skip — only depth in 1..7 actually quantises.
        val depthQuantises = voice.bitcrusherDepth in 1..7
        val skipActive = voice.bitcrusherSkip > 0
        val crushActive = depthQuantises || skipActive

        if (overdriveOn) {
            s *= (16 + voice.overdriveAmp) / 16.0
            s = clipSample(s, voice.clipMode)
        }

        if (crushActive) {
            if (voice.bitcrusherCounter == 0) {
                if (depthQuantises) {
                    val levels = (1 shl voice.bitcrusherDepth) - 1
                    val clipped = clipSample(s, voice.clipMode).coerceIn(-1.0, 1.0)
                    val q = kotlin.math.floor((clipped + 1.0) * 0.5 * levels + 0.5)
                        .coerceIn(0.0, levels.toDouble())
                    s = (q / levels) * 2.0 - 1.0
                }
                voice.bitcrusherHeld = s
            } else {
                s = voice.bitcrusherHeld
            }
            if (skipActive) {
                voice.bitcrusherCounter = (voice.bitcrusherCounter + 1) % (voice.bitcrusherSkip + 1)
            } else {
                voice.bitcrusherCounter = 0
            }
        }
        return s
    }

    /**
     * Shared clipper for effects 8 and 9.  Modes: 0 clamp, 1 fold (triangle), 2 wrap (sawtooth).
     * Inputs outside [-1, 1] are folded/wrapped back into range; well-behaved samples pass through.
     */
    private fun clipSample(x: Double, mode: Int): Double = when (mode and 3) {
        1 -> {
            // Ping-pong fold around ±1.  Loops handle arbitrary overdrive ratios up to 16.94×
            // without runaway: each iteration shrinks |v| by 2, so worst-case ~5 passes.
            var v = x
            while (v > 1.0)  v = 2.0 - v
            while (v < -1.0) v = -2.0 - v
            v
        }
        2 -> {
            // Period-2 wrap, mapped so that x = ±1 land on themselves (no DC step at boundary).
            var v = ((x + 1.0) % 2.0)
            if (v < 0.0) v += 2.0
            v - 1.0
        }
        else -> x.coerceIn(-1.0, 1.0)  // mode 0 (and any reserved value) — clamp
    }

    /**
     * IT-style auto-vibrato: returns a 4096-TET pitch delta to add to the
     * playback note for the current tick, and advances the LFO phase.
     * Vibrato depth ramps in linearly over `vibratoSweep` ticks (Sweep semantics
     * inverted from IT — IT's "Sweep" is actually the ramp-up time in ticks;
     * 0 means full depth immediately).
     */
    private fun advanceAutoVibrato(voice: Voice, inst: TaudInst): Int {
        // Reads come from the voice's active-sample snapshot (patch-aware) so multi-sample
        // IT/XM instruments use the per-sample auto-vibrato that the trigger resolved to.
        // [inst] is retained in the signature for callsite continuity but only the voice's
        // active fields are consulted here.
        val depth0 = voice.activeVibratoDepth
        if (depth0 == 0 || voice.activeVibratoSpeed == 0) return 0

        // Two ramp-in semantics:
        //   FT2 vibratoSweep (byte 176): "ticks to fully ramp" — depth = depth0 * t / sweep.
        //   IT vibratoRate   (byte 188): "ramp acceleration" — accumulator += rate per tick,
        //                                 capped at depth0 * 256, then divided by 256.
        val ftSweep  = voice.activeVibratoSweep
        val itRate   = voice.activeVibratoRate
        val t        = voice.autoVibTicksSinceTrigger
        val rampDepth = when {
            ftSweep != 0 -> ((depth0 * t / ftSweep).coerceAtMost(depth0))
            itRate  != 0 -> ((t * itRate) ushr 8).coerceAtMost(depth0)
            else         -> depth0
        }
        voice.autoVibTicksSinceTrigger++

        // Vibrato waveform selector lives in instrumentFlag bits 2-4 (snapshotted onto voice).
        // 0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (FT2 only).
        // lfoSample handles 0..3; treat 4 (ramp-up) as negated ramp-down.
        val wave = voice.activeVibratoWaveform
        val rawSample = if (wave == 4) -lfoSample(voice.autoVibPhase, 1)
                        else            lfoSample(voice.autoVibPhase, wave and 3)
        // 4096-TET delta. depth0 is now 0..255 (was 0..15 in old layout); the
        // shift compensates so depth ≈255 yields a similar musical excursion
        // (~±9 cents) to the old depth ≈15.
        val pitchDelta = (rawSample * rampDepth) shr 10
        voice.autoVibPhase = (voice.autoVibPhase + voice.activeVibratoSpeed * 2) and 0xFF
        return pitchDelta
    }

    /**
     * Read one PCM sample (in [-1, 1]) at integer index [idx], honouring the instrument's
     * funk-repeat mask.  Out-of-range indices are clamped to the sample bounds; the
     * caller is responsible for wrapping into a loop region first if loop semantics apply.
     *
     * Sample-geometry reads come from the voice's active-sample snapshot so Ixmp-patched
     * voices read the right bytes. The funk-mask continues to live on the base instrument
     * (PT2 effect; doesn't combine with multi-sample IT/XM in practice).
     */
    private fun readSamplePoint(voice: Voice, inst: TaudInst, idx: Int, sampleLen: Int, binMax: Int): Double {
        val i = idx.coerceIn(0, sampleLen - 1)
        var b = sampleBin[(voice.activeSamplePtr + i).coerceAtMost(binMax).toLong()].toUint()
        if (inst.funkMask != null && inst.sampleLoopEnd > inst.sampleLoopStart) {
            val ls = inst.sampleLoopStart
            if (i in ls until inst.sampleLoopEnd && inst.funkBit(i - ls)) b = b xor 0xFF
        }
        return (b - 127.5) / 127.5
    }

    private fun fetchTrackerSample(voice: Voice, inst: TaudInst, interpMode: Int): Double {
        if (inst.index == 0) return 0.0

        val sampleLen = voice.activeSampleLength.coerceAtLeast(1)
        val loopStart = voice.activeSampleLoopStart.toDouble()
        val loopEnd = voice.activeSampleLoopEnd.toDouble().coerceAtLeast(1.0)
        val binMax = (SAMPLE_BIN_TOTAL - 1).toInt()  // 8 MB pool, addressed via samplePtr directly (not banked)

        val i0 = voice.samplePos.toInt().coerceIn(0, sampleLen - 1)
        val frac = voice.samplePos - i0.toDouble()

        // Interpolation:
        //   INTERP_DEFAULT  (0): 6-tap windowed sinc (Fast Sinc; MilkyTracker MIXER_SINCTABLE)
        //   INTERP_NONE     (1): zero-order hold
        //   INTERP_A500/A1200 (2/3): zero-order hold per Paula; LPF applied at mix stage
        //   INTERP_SNES     (4): SNES BRR 4-tap gaussian
        //   INTERP_NES_DPCM (5): NES 2A03 DMC 1-bit sigma-delta playback simulation
        // Edge clamping: out-of-range taps are clipped to sample bounds (acceptable smear
        // at sample edges; matches MilkyTracker's outSideLoop fallback).
        val sample: Double = when (interpMode) {
            INTERP_DEFAULT -> {
                var acc = 0.0
                // Taps span [i0 - WIDTH, i0 + WIDTH], with the kernel centred on i0+frac.
                for (j in -SINC_WIDTH .. SINC_WIDTH) {
                    val coeff = sincTap(frac, j)
                    if (coeff != 0.0) acc += readSamplePoint(voice, inst, i0 + j, sampleLen, binMax) * coeff
                }
                acc
            }
            INTERP_SNES -> {
                // Four taps centred between samples i0 and i0+1, indexed in SNES naming:
                //   oldests = sample at i0 - 1, olders = i0, olds = i0 + 1, news = i0 + 2.
                // Promote each [-1, 1] sample to signed 16-bit, run the canonical BRR
                // formula in integer arithmetic, then map (out >> 1) back to [-1, 1].
                // The (out & 0xffff) → int16 cast after the third tap reproduces the
                // SNES hardware mid-sum overflow (the famous gauss "chirp").
                val oldest = (readSamplePoint(voice, inst, i0 - 1, sampleLen, binMax) * 32767.0).toInt()
                val olders = (readSamplePoint(voice, inst, i0,     sampleLen, binMax) * 32767.0).toInt()
                val olds   = (readSamplePoint(voice, inst, i0 + 1, sampleLen, binMax) * 32767.0).toInt()
                val news   = (readSamplePoint(voice, inst, i0 + 2, sampleLen, binMax) * 32767.0).toInt()
                val offset = (frac * 256.0).toInt().coerceIn(0, 255)
                var out = (SNES_GAUSS[0xff  - offset] * oldest) shr 10
                out    += (SNES_GAUSS[0x1ff - offset] * olders) shr 10
                out    += (SNES_GAUSS[0x100 + offset] * olds)   shr 10
                out     = out.toShort().toInt()
                out    += (SNES_GAUSS[offset]         * news)   shr 10
                out     = out.coerceIn(-32768, 32767)
                (out shr 1) / 16384.0
            }
            INTERP_NES_DPCM -> {
                // NES 2A03 DMC (Delta Modulation Channel) playback simulation. The DMC
                // is a 1-bit sigma-delta DAC: each clock reads one bit and slews a 7-bit
                // output counter (0..127) by ±2, clamped at the rails. Here the bitstream
                // is synthesised on the fly by comparing each ZOH-fetched sample against
                // the counter, then applying canonical DMC update rules (NESdev wiki
                // "APU DMC"):
                //   target > counter ∧ counter ≤ 125 : counter += 2
                //   target < counter ∧ counter ≥   2 : counter -= 2
                //   else                              : silent clip at the rail
                // The DMC clock is locked to the host sample rate (32 kHz, just below
                // NTSC DMC rate $F = 33144 Hz); the ±2-per-tick slew-rate limit gives
                // DPCM its signature — slow / quiet signals reconstruct cleanly, fast
                // transients break into triangle-flank crunch. The 7-bit counter further
                // imposes 64 effective output levels (only even values are reachable from
                // a mid-rail seed), reproducing DMC's coarse quantisation. Per-voice
                // counter persists across samples and is reseeded to mid-rail on note
                // trigger (see triggerNote).
                val target = readSamplePoint(voice, inst, i0, sampleLen, binMax)
                val targetLevel = ((target + 1.0) * 63.5).toInt().coerceIn(0, 127)
                when {
                    targetLevel > voice.nesDpcmCounter && voice.nesDpcmCounter <= 125 ->
                        voice.nesDpcmCounter += 2
                    targetLevel < voice.nesDpcmCounter && voice.nesDpcmCounter >= 2 ->
                        voice.nesDpcmCounter -= 2
                }
                (voice.nesDpcmCounter - 63.5) / 63.5
            }
            INTERP_NONE, INTERP_A500, INTERP_A1200 ->
                // Paula-style ZOH — emit the integer-indexed sample byte without
                // sub-sample fade. Aliasing is removed by the post-mix Amiga LPFs.
                readSamplePoint(voice, inst, i0, sampleLen, binMax)
            else -> readSamplePoint(voice, inst, i0, sampleLen, binMax)
        }

        // While ramping out at sample end, hold position so the mixer keeps emitting the
        // clamped last-sample value with decaying gain — no further advance, no re-trigger
        // of the end check.
        if (voice.rampOutSamples > 0) return sample

        if (voice.forward) {
            voice.samplePos += voice.playbackRate
            // When the sustain bit is set, key-off escapes the loop: the sample plays past
            // loopEnd until it ends naturally (loopMode 0 semantics).
            val effectiveLoopMode =
                if (voice.activeSampleLoopSustain && voice.keyOff) 0 else (voice.activeLoopMode and 3)
            when (effectiveLoopMode) {
                0 -> if (voice.samplePos >= sampleLen) {
                    voice.samplePos = (sampleLen - 1).toDouble().coerceAtLeast(0.0)
                    startRampOut(voice)
                }
                1 -> if (voice.samplePos >= loopEnd) voice.samplePos -= (loopEnd - loopStart).coerceAtLeast(1.0)
                2 -> if (voice.samplePos >= loopEnd) { voice.samplePos = loopEnd; voice.forward = false }
                3 -> if (voice.samplePos >= sampleLen) {
                    voice.samplePos = (sampleLen - 1).toDouble().coerceAtLeast(0.0)
                    startRampOut(voice)
                }
            }
        } else {
            voice.samplePos -= voice.playbackRate
            if (voice.samplePos < loopStart) { voice.samplePos = loopStart; voice.forward = true }
        }
        return sample
    }

    /**
     * Engage the MilkyTracker-style sample-end ramp. The voice keeps emitting its held
     * last-sample value for [RAMP_OUT_SAMPLES] more output samples while gain decays
     * linearly from 1.0 to 0.0; the mixer flips voice.active = false at the end.
     * No-op if already ramping (don't restart a running ramp from a re-entrant call).
     */
    private fun startRampOut(voice: Voice) {
        if (voice.rampOutSamples > 0) return
        voice.rampOutSamples = RAMP_OUT_SAMPLES
        voice.rampOutGain    = 1.0
        voice.rampOutStep    = 1.0 / RAMP_OUT_SAMPLES
    }

    /**
     * Fast note-fade (note word 0x0004 — SF2 exclusiveClass choke). Starts an immediate
     * note-fade that drives fadeoutVolume from 1.0 to 0.0 over [FAST_FADE_SEC] while the
     * sample keeps advancing (unlike ^^CUT's hard stop, and far quicker than the
     * instrument's own release fadeout). The per-tick fadeout step (subtracted as
     * fadeStep/1024 each song tick at bpm·0.4 Hz) is sized to the current tempo so the
     * fade lands on [FAST_FADE_SEC] regardless of BPM. Mirrors FluidSynth's
     * fluid_voice_kill_excl (a −2000-timecent release). No-op on an inactive voice.
     */
    private fun startFastFade(voice: Voice, playhead: Playhead) {
        if (!voice.active) return
        voice.noteFading = true
        val ticks = (FAST_FADE_SEC * playhead.bpm * 0.4).coerceAtLeast(1.0)
        voice.activeFadeoutStep = (1024.0 / ticks).roundToInt().coerceIn(1, 0xFFF)
    }

    /**
     * Per-sample volume-ramp tick. Smooths [Voice.currentMixVolume] toward
     * `(rowVolume / 63.0) × (channelVolume / 63.0)` over [VOL_RAMP_SAMPLES]
     * samples whenever the mixer detects a discrepancy. Discrepancies arise
     * from voleff/notefx that mutate rowVolume mid-note (volume column SET /
     * fine slides, D vol-slide tick, vol-column slide tick, tremor gating,
     * tremolo, retrig vol-mod, S$80 cuts, etc.) AND from channel-volume
     * changes (M / N) — both factors share one ramp so a per-channel slide
     * during a per-note slide doesn't double-step. Fresh triggers bypass
     * this by snapping currentMixVolume in [triggerNote], so attacks are
     * unsmoothed.
     */
    private fun advanceVolumeRamp(voice: Voice) {
        val target = (voice.rowVolume / 63.0) * (voice.channelVolume / 63.0)
        // Deferred key-on snap: triggerNote arms this so the first mixer sample after a
        // fresh trigger re-syncs to the post-row rowVolume (already adjusted by any
        // V-column SET / fine slide on the same row). Bypasses the ramp entirely.
        if (voice.snapMixVolume) {
            voice.currentMixVolume = target
            voice.volRampSamples = 0
            voice.volRampStep = 0.0
            voice.snapMixVolume = false
            return
        }
        if (voice.volRampSamples > 0) {
            voice.currentMixVolume += voice.volRampStep
            voice.volRampSamples--
            if (voice.volRampSamples == 0) voice.currentMixVolume = target
        } else if (voice.currentMixVolume != target) {
            voice.volRampStep = (target - voice.currentMixVolume) / VOL_RAMP_SAMPLES
            voice.volRampSamples = VOL_RAMP_SAMPLES - 1
            voice.currentMixVolume += voice.volRampStep
        }
    }

    /**
     * Trigger a fresh note on [voice]: load the instrument, reset sample position, kick off the envelope.
     * Pulled out so S$Dx (note delay) can defer the same logic to a later tick.
     */
    /**
     * Trigger-time default noteVolume seed derived from the instrument's
     * Default Note Volume (byte 196). Pre-2026-05-09 .taud files left this
     * byte zero; treating 0 as "field not present" and falling back to 0x3F
     * keeps legacy behaviour. Used by both [triggerNote] and the tone-porta
     * + instrument-byte path in [advanceRow] — both must seed identically
     * (Schism player/effects.c:1302 writes `chan->volume = psmp->volume`
     * unconditionally on inst-column rows, regardless of porta). Sets
     * noteVolume only — channelVolume (IT chan->global_volume) survives.
     */
    private fun rowVolumeFromDefault(inst: TaudInst, patch: TaudInstPatch? = null): Int {
        // Patch overrides the base inst's DNV unless the sentinel (0 = no override).
        val dnv = patch?.defaultNoteVolume?.takeIf { it != 0 } ?: inst.defaultNoteVolume
        return if (dnv == 0) 0x3F else (dnv * 63 + 127) / 255
    }

    /** Cap [TrackerState.backgroundVoices] to [MAX_BG_VOICES], preferring to evict the
     *  oldest NON-layer ghost so a live Metainstrument note never loses one of its layers. */
    private fun capBackgroundVoices(ts: TrackerState) {
        while (ts.backgroundVoices.size > MAX_BG_VOICES) {
            val idx = ts.backgroundVoices.indexOfFirst { !it.isLayerChild }
            if (idx >= 0) ts.backgroundVoices.removeAt(idx) else ts.backgroundVoices.removeFirst()
        }
    }

    /** Release the layer children of channel [vi] (from a previous Metainstrument note):
     *  detach them and apply each layer instrument's own NNA so the displaced note's tail
     *  rides on as an ordinary background ghost. Called at the start of a fresh trigger. */
    private fun releaseLayerChildren(ts: TrackerState, vi: Int) {
        for (bg in ts.backgroundVoices) {
            if (!bg.isLayerChild || bg.sourceChannel != vi) continue
            bg.isLayerChild = false
            when (instruments[bg.instrumentId].newNoteAction) {
                0 -> if (!bg.keyOff) { bg.keyOff = true; applyKeyLift(bg, instruments[bg.instrumentId]) }
                1 -> bg.active = false        // note cut
                3 -> bg.noteFading = true     // note fade
                // 2 = continue
            }
        }
    }

    /** Hard-cut the layer children of channel [vi] (pattern note-cut 0x0002 on the channel). */
    private fun cutLayerChildren(ts: TrackerState, vi: Int) {
        for (bg in ts.backgroundVoices) if (bg.isLayerChild && bg.sourceChannel == vi) bg.active = false
    }

    /**
     * Trigger [noteVal]/[instId] on the foreground [voice] of channel [vi]. When [instId]
     * is a Metainstrument (terranmon.txt "Metainstrument definition"), fan out: the first
     * layer whose (pitch × volume) rectangle contains the trigger plays on the foreground
     * voice; every other matching layer spawns a tracked background "layer child". Old
     * layer children of the channel are released first (per their own NNA). For a normal
     * instrument this is exactly the historical [triggerNote] call (volOverride = -1), so
     * non-meta playback is byte-identical.
     *
     * [rowVolOverride] is the V-column-derived trigger volume (or -1). For metas it is the
     * velocity used to resolve velocity-conditional layers and the layers' note volume. The
     * normal path also forwards it so a non-meta instrument's velocity-split Ixmp patches
     * resolve on the ACTUAL trigger velocity, not the default-note-volume seed: without this
     * every trigger probes [resolvePatch] at the byte-196 default (≈63), so any velocity tile
     * the song never hits at full velocity falls through to the instrument's base/canonical
     * sample. For an SF2 drum kit (one non-meta instrument, base = most-hit patch = usually a
     * hi-hat) that means a kick/snare never struck at max velocity audibly plays the hi-hat.
     * When there is no V column (rowVolOverride == -1) the seed is unchanged, so classic
     * tracker content — which has no velocity-split Ixmp patches — is byte-identical.
     */
    private fun triggerMetaOrNote(ts: TrackerState, voice: Voice, vi: Int,
                                  noteVal: Int, instId: Int, rowVolOverride: Int) {
        releaseLayerChildren(ts, vi)
        val inst = if (instId != 0) instruments[instId] else instruments[voice.instrumentId]
        if (!inst.isMeta) {
            triggerNote(voice, noteVal, instId, rowVolOverride)   // honour V-column velocity for patch lookup
            voice.layerMixGain = 1.0
            voice.layerRelDetune = 0
            voice.isLayerChild = false
            return
        }
        val seedVol = if (rowVolOverride in 0..0x3F) rowVolOverride else 0x3F
        val layers = inst.resolveMetaLayers(noteVal, seedVol)
        if (layers.isEmpty()) {                       // no layer covers this note: silence
            voice.active = false
            voice.layerMixGain = 1.0
            voice.layerRelDetune = 0
            return
        }
        val l0 = layers[0]
        triggerNote(voice, (noteVal + l0.detune).coerceIn(0x20, 0xFFFF), l0.instIdx, rowVolOverride)
        voice.layerMixGain   = META_MIX_GAIN[l0.mixOctet and 0xFF]
        voice.layerRelDetune = 0
        voice.isLayerChild   = false
        voice.metaForeground = true   // marks the channel as playing a meta (S$7x fan-out / no-op)
        for (k in 1 until layers.size) {
            val lk = layers[k]
            val child = Voice()
            triggerNote(child, (noteVal + lk.detune).coerceIn(0x20, 0xFFFF), lk.instIdx, rowVolOverride)
            child.isLayerChild   = true
            child.sourceChannel  = vi
            child.layerRelDetune = lk.detune - l0.detune
            child.layerMixGain   = META_MIX_GAIN[lk.mixOctet and 0xFF]
            // Match layer 0's channel context so M/pan and the first tick agree.
            child.channelVolume = voice.channelVolume
            child.channelPan    = voice.channelPan
            child.rowPan        = voice.rowPan
            ts.backgroundVoices.addLast(child)
        }
        capBackgroundVoices(ts)
    }

    private fun triggerNote(voice: Voice, noteVal: Int, instId: Int, volOverride: Int) {
        if (instId != 0) voice.instrumentId = instId
        val inst = instruments[voice.instrumentId]
        // Resolve the Ixmp patch (if any) for this trigger. Volume axis uses the
        // pre-patch seed so the rectangle test is well-defined; the patch's own
        // DNV is then layered onto the final voice.noteVolume below.
        val seedVolForLookup = when {
            volOverride >= 0 -> volOverride.coerceIn(0, 0x3F)
            instId != 0      -> rowVolumeFromDefault(inst, null)
            else             -> voice.noteVolume.coerceIn(0, 0x3F)
        }
        val patch = inst.resolvePatch(noteVal, seedVolForLookup)
        applyActiveSample(voice, inst, patch)
        voice.tonePortaTarget = -1   // fresh note trigger cancels any running porta
        voice.samplePos = voice.activeSamplePlayStart.toDouble()
        voice.forward = true
        voice.active = true
        voice.keyOff = false
        voice.envIndex = 0
        voice.envTimeSec = 0.0
        voice.envVolume = (voice.activeVolEnv[0].value / 63.0).coerceIn(0.0, 1.0)
        // Snap the per-sample-smoothed envelope to the fresh starting value so attack
        // transients land at the envelope's node-0 value immediately. Per-tick step is
        // recomputed by applyTrackerTick on the next tick boundary.
        voice.envVolMix = voice.envVolume
        voice.envVolStep = 0.0
        voice.envPanIndex = 0
        voice.envPanTimeSec = 0.0
        voice.envPan = voice.activePanEnv[0].value / 255.0
        // Envelope-present gate (added 2026-05-06). Driven by the P bit at LOOP-word
        // bit 13 (high byte's bit 5; offsets 16/18/20 bit 5), set by converters
        // whenever they emit envelope nodes. The active LOOP word is the patch-or-base
        // one (resolveActiveEnvelopes); hasPitchEnv/hasFilterEnv are already latched there.
        voice.hasPanEnv = envPresent(voice.activePanEnvLoop)
        // Pitch / filter envelope playhead seeds (the role split + presence were resolved
        // by resolveActiveEnvelopes from the base inst's two pf-slots and any patch override).
        voice.envPitchIndex   = 0
        voice.envPitchTimeSec = 0.0
        voice.envPitchValue   = if (voice.hasPitchEnv) voice.activePitchEnv[0].value / 255.0 else 0.5
        voice.envFilterIndex   = 0
        voice.envFilterTimeSec = 0.0
        voice.envFilterValue   = if (voice.hasFilterEnv) voice.activeFilterEnv[0].value / 255.0 else 0.5
        // Fadeout starts at unity; advances only after key-off.
        voice.fadeoutVolume = 1.0
        // Cancel any sample-end ramp left over from the previous note — a fresh trigger's
        // attack must not be muted by a trailing fade.
        voice.rampOutSamples = 0
        voice.rampOutGain    = 0.0
        // Auto-vibrato sweep ramp restarts on every fresh trigger.
        voice.autoVibPhase = 0
        voice.autoVibTicksSinceTrigger = 0
        // Reseed the NES DPCM sigma-delta counter to mid-rail so the first
        // output sample after key-on doesn't carry the previous note's residual
        // DC slew (relevant only when interpolationMode == INTERP_NES_DPCM).
        voice.nesDpcmCounter = 63
        // Funk repeat (S$Fx): PT2 resets n_wavestart to n_loopstart on every fresh
        // note trigger (pt2_replayer.c:1094, 1100). funkSpeed and funkAccumulator
        // persist across notes, matching PT2.
        voice.funkWritePos = 0
        // Random vol/pan swing biases — seeded once per trigger (range determined by inst.volumeSwing/panSwing).
        voice.randomVolBias = if (inst.volumeSwing != 0)
            (Math.random() * (2 * inst.volumeSwing + 1)).toInt() - inst.volumeSwing else 0
        voice.randomPanBias = if (inst.panSwing != 0)
            (Math.random() * (2 * inst.panSwing + 1)).toInt() - inst.panSwing else 0
        // Default pan / pitch-pan separation: only re-applied when the row carried an instrument
        // byte. A note-only retrigger (instId == 0) inherits the channel's existing pan, mirroring
        // the volume policy below.
        if (instId != 0) {
            // Default pan: applied unless the pattern row has already overridden channelPan.
            // The pan envelope's 'p' flag ("use default pan") lives in the pan LOOP word at bit 7.
            // An Ixmp patch's defaultPan (when non-sentinel, i.e. != 0xFF) takes precedence over
            // the base instrument's defaultPan.
            if ((voice.activePanEnvLoop ushr 7) and 1 != 0) {
                val patchPan = patch?.defaultPan?.takeIf { it != 0xFF }
                voice.channelPan = patchPan ?: inst.defaultPan
                voice.rowPan = (voice.channelPan ushr 2).coerceIn(0, 63)
            }
            // Pitch-pan separation: when PPS != 0, played notes far from PPC drift in pan.
            // PPS is signed (-32..+32), full-scale at one octave (4096 4096-TET units) above PPC.
            if (inst.pitchPanSeparation != 0) {
                val noteDelta = (noteVal - inst.pitchPanCentre).toDouble() / 4096.0
                val panShift = (noteDelta * inst.pitchPanSeparation * 4.0).toInt()  // ~×4 = 32→128 swing
                voice.channelPan = (voice.channelPan + panShift).coerceIn(0, 255)
                voice.rowPan = (voice.channelPan ushr 2).coerceIn(0, 63)
            }
        }
        // Filter cutoff/resonance defaults — adjusted per-tick by the filter envelope. Uses
        // the ACTIVE values (patch 'x' block overrides the base inst's defaultCutoff/Resonance).
        // 255 = filter off (IT high-bit-clear); 0..254 = active range matching IT 0..127 at double resolution.
        voice.currentCutoff = voice.activeDefaultCutoff
        voice.currentResonance = voice.activeDefaultResonance
        voice.filterY1 = 0.0; voice.filterY2 = 0.0; voice.filterX1 = 0.0; voice.filterX2 = 0.0
        voice.filterCutoffCached = -1   // force coefficient refresh on first tick
        voice.filterResonanceCached = -1
        voice.noteVal = noteVal
        voice.basePitch = noteVal
        voice.amigaPeriod = -1.0   // fresh trigger: period state must reseed from the new noteVal
        voice.linearFreq  = -1.0   // ditto for linear-freq mode (toneMode == 2)
        voice.playbackRate = computePlaybackRate(voice, noteVal)
        // Fresh trigger seeds noteVolume from the per-instrument "default note volume"
        // (byte 196) when the row carried an instrument byte but no explicit V column —
        // matching IT's `chan->volume = psmp->volume` rule (Schism player/effects.c:1302
        // and :1432). Pre-2026-05-09 .taud files left byte 196 zero and folded sample.vol
        // into IGV instead; treating 0 as "field not present" and falling back to 0x3F
        // preserves legacy behaviour. A note-only retrigger (instId == 0) inherits the
        // channel's existing note volume so held-volume sustains keep working across
        // retriggers. channelVolume is deliberately NOT reset here — IT keeps
        // chan->global_volume across sample changes, so M / N writes persist.
        // Continuous per-instrument scaling lives in instGlobalVolume (byte 171), which the
        // mixer applies independently of this seed.
        // When an Ixmp patch overrides DNV (non-sentinel), the patch wins via rowVolumeFromDefault.
        voice.noteVolume = when {
            volOverride >= 0 -> volOverride.coerceIn(0, 0x3F)
            instId != 0     -> rowVolumeFromDefault(inst, patch)
            else            -> voice.noteVolume
        }
        voice.rowVolume = voice.noteVolume
        // Defer the anti-click ramp snap to the next mixer sample. applyVolColumn and
        // applyEffectRow run *after* triggerNote in applyTrackerRow and frequently
        // override rowVolume on the same row (e.g., a key-on row carrying a V column
        // value of 30). Snapping currentMixVolume here would set it to 1.0, then the
        // mixer would detect the lowered post-volColumn target and ramp DOWN from
        // 1.0 — an audible transient spike at every soft-attack note. The deferred
        // snap reads rowVolume after the row has fully resolved.
        voice.snapMixVolume = true
        voice.volRampSamples = 0
        voice.volRampStep = 0.0
        voice.noteWasCut = false
        voice.noteFading = false
        // S $73..$7E state resets on each fresh trigger so per-note overrides don't leak.
        voice.nnaOverride = -1
        voice.volEnvOn = true
        voice.panEnvOn = true
        voice.pitchEnvOn = true
        voice.filterEnvOn = true
        // Default to "not a meta foreground"; triggerMetaOrNote re-sets this for the meta path.
        voice.metaForeground = false
        // Vibrato/tremolo/panbrello retrigger: reset LFO position when waveform requests it.
        if (voice.vibratoRetrig) voice.vibratoLfoPos = 0
        if (voice.tremoloRetrig) voice.tremoloLfoPos = 0
        if (voice.panbrelloRetrig) voice.panbrelloLfoPos = 0
    }

    /**
     * IT-style Duplicate Check (DCT/DCA). Runs *before* NNA on every fresh foreground
     * trigger: existing voices on this channel — the foreground itself plus any of its
     * own background ghosts — that match the new note under DCT have DCA applied.
     * Reference: schismtracker effects.c:1664-1764 (csf_check_nna).
     *
     * DCT (per existing voice's instrument):
     *   1 = note        — same noteVal AND same instrumentId
     *   2 = sample      — same canonical sample (matched by samplePtr+sampleLength)
     *   3 = instrument  — same instrumentId
     * DCA: 0 = note cut, 1 = note off (release sustain), 2 = note fade.
     *
     * Note: the foreground voice will be replaced by triggerNote() right after this,
     * so applying DCA to it is mostly relevant for ghosts spawned *from* it via NNA
     * — the ghost is cloned from the (already-DCA-modified) foreground state.
     */
    private fun applyDuplicateCheck(ts: TrackerState, channel: Int, newInstId: Int, newNote: Int) {
        if (newInstId == 0) return
        val newInst = instruments[newInstId]
        // For DCT=2 (sample match) we compare canonical sample identity. With Ixmp, the
        // new note's effective sample is the patch's (or the base inst's if no patch).
        // Volume axis defaults to full (0x3F) at this resolution point — the actual
        // trigger volume isn't known yet and the IT DCT model is volume-agnostic anyway.
        val newPatch = newInst.resolvePatch(newNote, 0x3F)
        val newSmpPtr = newPatch?.samplePtr ?: newInst.samplePtr
        val newSmpLen = newPatch?.sampleLength ?: newInst.sampleLength

        fun isDuplicate(v: Voice): Boolean {
            val existInst = instruments[v.instrumentId]
            return when (existInst.duplicateCheckType) {
                1 -> v.noteVal == newNote && v.instrumentId == newInstId
                2 -> v.instrumentId == newInstId &&
                     v.activeSamplePtr == newSmpPtr &&
                     v.activeSampleLength == newSmpLen
                3 -> v.instrumentId == newInstId
                else -> false
            }
        }

        fun applyAction(v: Voice) {
            val existInst = instruments[v.instrumentId]
            when (existInst.duplicateCheckAction) {
                0 -> { v.fadeoutVolume = 0.0; v.active = false }
                1 -> { v.keyOff = true; applyKeyLift(v, existInst) }
                2 -> v.noteFading = true
            }
        }

        val fg = ts.voices[channel]
        if (fg.active && instruments[fg.instrumentId].duplicateCheckType != 0 && isDuplicate(fg)) {
            applyAction(fg)
        }

        val it = ts.backgroundVoices.iterator()
        while (it.hasNext()) {
            val bg = it.next()
            if (bg.sourceChannel != channel || !bg.active) continue
            if (instruments[bg.instrumentId].duplicateCheckType == 0) continue
            if (!isDuplicate(bg)) continue
            applyAction(bg)
            if (!bg.active) it.remove()
        }
    }

    /**
     * On a fresh foreground trigger, optionally migrate the existing voice into the
     * mixer-private background pool per the New Note Action setting (instrument default
     * unless overridden by S $73..$76). Note Cut: no ghost, foreground retriggers in place.
     * Note Off: ghost gets keyOff (sustain release + fadeout). Continue: ghost as-is.
     * Note Fade: ghost begins fadeout immediately without releasing sustain.
     */
    private fun maybeSpawnBackgroundForNNA(ts: TrackerState, voice: Voice, channel: Int) {
        if (!voice.active) return
        val nna = if (voice.nnaOverride >= 0) voice.nnaOverride
                  else instruments[voice.instrumentId].newNoteAction
        if (nna == 1) return  // Note Cut — foreground sample is replaced; no background needed.

        val bg = ghostVoice(voice, channel)
        when (nna) {
            0 -> {                      // Note Off — release sustain; fadeout starts naturally.
                bg.keyOff = true
                applyKeyLift(bg, instruments[bg.instrumentId])
            }
            3 -> bg.noteFading = true   // Note Fade — fadeout immediately, sustain still loops.
            // 2 (Continue) — ghost continues unchanged.
        }
        ts.backgroundVoices.addLast(bg)
        capBackgroundVoices(ts)
    }

    /** Snapshot the playback-relevant state of [src] into a fresh Voice tagged for [channel]. */
    private fun ghostVoice(src: Voice, channel: Int): Voice {
        val v = Voice()
        v.active = true
        v.fader = src.fader
        v.instrumentId = src.instrumentId
        v.samplePos = src.samplePos
        v.playbackRate = src.playbackRate
        v.forward = src.forward
        v.noteVolume = src.noteVolume
        v.channelVolume = src.channelVolume
        v.rowVolume = src.rowVolume
        v.channelPan = src.channelPan
        v.rowPan = src.rowPan
        // Inherit the smoothed gain so the ghost picks up where the foreground left off
        // without a click. Ramp state (counter/step) intentionally not copied — the ghost
        // doesn't take new voleff/notefx events, so any in-flight ramp can complete via
        // the snap-to-target on first mix iteration.
        v.currentMixVolume = src.currentMixVolume
        v.keyOff = src.keyOff
        v.envIndex = src.envIndex
        v.envTimeSec = src.envTimeSec
        v.envVolume = src.envVolume
        v.envVolMix = src.envVolMix
        v.envVolStep = src.envVolStep
        v.envPanIndex = src.envPanIndex
        v.envPanTimeSec = src.envPanTimeSec
        v.envPan = src.envPan
        v.hasPanEnv = src.hasPanEnv
        v.hasPitchEnv = src.hasPitchEnv
        v.envPitchIndex = src.envPitchIndex
        v.envPitchTimeSec = src.envPitchTimeSec
        v.envPitchValue = src.envPitchValue
        v.hasFilterEnv = src.hasFilterEnv
        v.envFilterIndex = src.envFilterIndex
        v.envFilterTimeSec = src.envFilterTimeSec
        v.envFilterValue = src.envFilterValue
        v.fadeoutVolume = src.fadeoutVolume
        v.autoVibPhase = src.autoVibPhase
        v.autoVibTicksSinceTrigger = src.autoVibTicksSinceTrigger
        v.currentCutoff = src.currentCutoff
        v.currentResonance = src.currentResonance
        v.filterSfMode = src.filterSfMode
        v.filterActive = src.filterActive
        v.filterA0 = src.filterA0
        v.filterB0 = src.filterB0
        v.filterB1 = src.filterB1
        v.filterY1 = src.filterY1
        v.filterY2 = src.filterY2
        v.filterIsBiquad = src.filterIsBiquad
        v.filterBqB02 = src.filterBqB02
        v.filterBqB1 = src.filterBqB1
        v.filterBqA1 = src.filterBqA1
        v.filterBqA2 = src.filterBqA2
        v.filterX1 = src.filterX1
        v.filterX2 = src.filterX2
        v.filterCutoffCached = src.filterCutoffCached
        v.filterResonanceCached = src.filterResonanceCached
        v.randomVolBias = src.randomVolBias
        v.randomPanBias = src.randomPanBias
        v.noteVal = src.noteVal
        v.basePitch = src.basePitch
        v.amigaPeriod = src.amigaPeriod
        v.linearFreq  = src.linearFreq
        v.volEnvOn = src.volEnvOn
        v.panEnvOn = src.panEnvOn
        v.pitchEnvOn = src.pitchEnvOn
        v.filterEnvOn = src.filterEnvOn
        v.metaForeground = src.metaForeground
        v.noteFading = src.noteFading
        // Keep the source's Metainstrument layer-0 mix gain on the ghost so an NNA tail of
        // a layered note fades at the same level it was sounding (isLayerChild stays false:
        // a ghost is a free-running tail, not a tracked child of the live note).
        v.layerMixGain = src.layerMixGain
        // Voice-FX state (effects 8/9): preserve so the NNA-ghosted tail keeps the same timbre.
        v.clipMode = src.clipMode
        v.bitcrusherDepth = src.bitcrusherDepth
        v.bitcrusherSkip = src.bitcrusherSkip
        v.bitcrusherCounter = src.bitcrusherCounter
        v.bitcrusherHeld = src.bitcrusherHeld
        v.overdriveAmp = src.overdriveAmp
        v.sourceChannel = channel
        // Active-sample snapshot must follow the foreground voice so the ghost's per-tick
        // playback (samplingRate, loop bounds, auto-vibrato) keeps using the patch the
        // foreground had bound — not the base instrument it would otherwise re-derive.
        v.activeSamplePtr        = src.activeSamplePtr
        v.activeSampleLength     = src.activeSampleLength
        v.activeSamplePlayStart  = src.activeSamplePlayStart
        v.activeSampleLoopStart  = src.activeSampleLoopStart
        v.activeSampleLoopEnd    = src.activeSampleLoopEnd
        v.activeSamplingRate     = src.activeSamplingRate
        v.activeSampleDetune     = src.activeSampleDetune
        v.activeLoopMode         = src.activeLoopMode
        v.activeVibratoSpeed     = src.activeVibratoSpeed
        v.activeVibratoSweep     = src.activeVibratoSweep
        v.activeVibratoDepth     = src.activeVibratoDepth
        v.activeVibratoRate      = src.activeVibratoRate
        v.activeVibratoWaveform  = src.activeVibratoWaveform
        // Active-envelope view must follow too, so the ghost keeps its patch's ADSR /
        // pan / pitch / filter envelopes + fadeout/cutoff/resonance (not the base inst's).
        v.activeVolEnv           = src.activeVolEnv
        v.activeVolEnvLoop       = src.activeVolEnvLoop
        v.activeVolEnvSustain    = src.activeVolEnvSustain
        v.activePanEnv           = src.activePanEnv
        v.activePanEnvLoop       = src.activePanEnvLoop
        v.activePanEnvSustain    = src.activePanEnvSustain
        v.activePitchEnv         = src.activePitchEnv
        v.activePitchEnvLoop     = src.activePitchEnvLoop
        v.activePitchEnvSustain  = src.activePitchEnvSustain
        v.activeFilterEnv        = src.activeFilterEnv
        v.activeFilterEnvLoop    = src.activeFilterEnvLoop
        v.activeFilterEnvSustain = src.activeFilterEnvSustain
        v.activeFadeoutStep      = src.activeFadeoutStep
        v.activeDefaultCutoff    = src.activeDefaultCutoff
        v.activeDefaultResonance = src.activeDefaultResonance
        v.activeAttenGain        = src.activeAttenGain
        return v
    }

    /** Past-note action (S $70..$72): apply [action] to all background voices spawned by [channel]. */
    private fun applyPastNoteAction(ts: TrackerState, channel: Int, action: Int) {
        when (action) {
            0 -> {  // Past Note Cut — drop them.
                val iter = ts.backgroundVoices.iterator()
                while (iter.hasNext()) if (iter.next().sourceChannel == channel) iter.remove()
            }
            1 -> ts.backgroundVoices.forEach { bg ->  // Past Note Off — sustain release.
                if (bg.sourceChannel == channel) {
                    bg.keyOff = true
                    applyKeyLift(bg, instruments[bg.instrumentId])
                }
            }
            2 -> ts.backgroundVoices.forEach { bg ->  // Past Note Fade — start fadeout.
                if (bg.sourceChannel == channel) bg.noteFading = true
            }
        }
    }

    private fun applyVolColumn(voice: Voice, value: Int, sel: Int) {
        // value is the 6-bit cell field; sel is the 2-bit selector. See TAUD_NOTE_EFFECTS.md
        // §"Volume column effects" for the multi-selector encoding.
        // SET / fine writes to noteVolume (per-note, persistent across rows until re-trigger);
        // rowVolume is mirrored so the change is audible immediately for this row's mixing.
        // channelVolume is left alone — vol-col is the per-note volume axis, M / N drive the
        // independent per-channel axis (TAUD_NOTE_EFFECTS.md §3).
        when (sel) {
            0 -> { voice.noteVolume = value.coerceIn(0, 0x3F); voice.rowVolume = voice.noteVolume }
            1 -> voice.volColSlideUp = value
            2 -> voice.volColSlideDown = value
            3 -> {
                if (value == 0) return

                val mag = value and 0x1F
                voice.noteVolume = if ((value and 0x20) != 0) (voice.noteVolume + mag).coerceAtMost(0x3F)
                                   else (voice.noteVolume - mag).coerceAtLeast(0)
                voice.rowVolume = voice.noteVolume
            }
        }
    }

    private fun applyPanColumn(voice: Voice, value: Int, sel: Int) {
        // S $80xx (8-bit pan SET in the effect column) wins over PanEff SET (6-bit) on the same
        // row — skip the SET branch here so the effect column's higher-precision write is final.
        // Slide selectors (1/2/3) still apply, since their per-tick behaviour is independent.
        val rowHasS80 = voice.rowEffect == EffectOp.OP_S &&
                        ((voice.rowEffectArg ushr 12) and 0xF) == 0x8
        when (sel) {
            0 -> if (!rowHasS80) { voice.channelPan = (value shl 2) or (value ushr 4); voice.rowPan = (voice.channelPan shr 2).coerceIn(0, 63) }
            1 -> voice.panColSlideRight = value
            2 -> voice.panColSlideLeft = value
            3 -> {
                if (value == 0) return

                val mag = value and 0x1F
                voice.channelPan = if ((value and 0x20) != 0) (voice.channelPan + mag).coerceAtMost(0xFF)
                                   else (voice.channelPan - mag).coerceAtLeast(0)
                voice.rowPan = (voice.channelPan shr 2).coerceIn(0, 63)
            }
        }
    }

    private fun applyTrackerRow(ts: TrackerState, playhead: Playhead) {
        val cue = cueSheet[ts.cuePos]
        // Reset row-scope state before scanning channels.
        if (!ts.patternDelayActive) ts.sexWinningChannel = -1
        ts.finePatternDelayExtra = 0

        for (vi in 0..19) {
            val patNum = cue.patterns[vi]
            if (patNum == 0xFFF) continue
            val patIdx = patNum.coerceIn(0, 4095)
            val rawRow = playdata[patIdx][ts.rowIndex]
            val voice = ts.voices[vi]

            // ── Pattern Ditto (effect 7) row-time expansion ──
            // See TAUD_NOTE_EFFECTS.md §7. Arm the destination range when this row
            // carries a 7-opcode with a valid argument; then, if the current row
            // sits inside an active destination block, synthesise an effective cell
            // that combines the source-block cell with any explicit fields the
            // composer punched into the destination row.
            val n = ts.rowIndex
            val isArmer = (rawRow.effect == EffectOp.OP_7 && rawRow.effectArg != 0)
            if (isArmer) {
                val length = (rawRow.effectArg ushr 8) and 0xFF
                val repeats = rawRow.effectArg and 0xFF
                if (length > 0 && repeats > 0 && length <= n) {
                    val patLen = cueRowLimit(cue.instruction)
                    voice.dittoSourceStart = n - length
                    voice.dittoLength = length
                    voice.dittoEndRow = minOf(n + length * repeats - 1, patLen - 1)
                    voice.dittoActive = true
                }
                // else: malformed — leave any previously-armed ditto state alone.
            }

            val dittoArmRow = voice.dittoSourceStart + voice.dittoLength
            val row: TaudPlayData =
                if (voice.dittoActive && n in dittoArmRow..voice.dittoEndRow) {
                    val rel = (n - voice.dittoSourceStart) % voice.dittoLength
                    val srcRow = voice.dittoSourceStart + rel
                    val src = playdata[patIdx][srcRow]

                    // Vol- / pan-column "no-op" sentinel is SEL_FINE (3) with value 0.
                    val volIsSet = !(rawRow.volumeEff == 3 && rawRow.volume == 0)
                    val panIsSet = !(rawRow.panEff == 3 && rawRow.pan == 0)

                    // On the armer row, the 7-opcode is consumed by the marker, so
                    // for effect-column patching purposes the destination is treated
                    // as empty. Source 7-opcodes never propagate (no recursive
                    // expansion).
                    val destOp = if (isArmer) 0 else rawRow.effect
                    val destArg = if (isArmer) 0 else rawRow.effectArg
                    val effOp: Int
                    val effArg: Int
                    when {
                        destOp != 0 -> { effOp = destOp; effArg = destArg }
                        src.effect != EffectOp.OP_7 -> { effOp = src.effect; effArg = src.effectArg }
                        else -> { effOp = 0; effArg = 0 }
                    }

                    TaudPlayData(
                        note      = if (rawRow.note != 0x0000) rawRow.note else src.note,
                        instrment = if (rawRow.instrment != 0) rawRow.instrment else src.instrment,
                        volume    = if (volIsSet) rawRow.volume else src.volume,
                        volumeEff = if (volIsSet) rawRow.volumeEff else src.volumeEff,
                        pan       = if (panIsSet) rawRow.pan else src.pan,
                        panEff    = if (panIsSet) rawRow.panEff else src.panEff,
                        effect    = effOp,
                        effectArg = effArg,
                    )
                } else {
                    rawRow
                }

            // Reset per-row transient state.
            voice.cutAtTick = -1
            voice.noteDelayTick = -1
            voice.slideMode = 0
            voice.slideArg = 0
            voice.arpActive = false
            voice.tremorOn = 0
            voice.vibratoActive = false
            voice.tremoloActive = false
            voice.panbrelloActive = false
            voice.retrigActive = false
            voice.tempoSlideDir = 0
            voice.wSlideDir = 0
            voice.volColSlideUp = 0; voice.volColSlideDown = 0
            voice.panColSlideRight = 0; voice.panColSlideLeft = 0
            voice.nSlideDir = 0
            voice.rowEffect = row.effect
            voice.rowEffectArg = row.effectArg
            // Per-tick modulators (tremolo R, tremor I, per-tick D/N coarse slides, etc.) write
            // rowVolume directly to take effect within the row. At every row boundary rowVolume
            // is rebased to the persistent noteVolume so the next row starts from the per-note
            // baseline — any tremolo dip / tremor gate from the previous tick is forgotten, but
            // a D-slide's per-tick mutations of noteVolume itself survive (D writes both).
            voice.rowVolume = voice.noteVolume

            // ── Note ──
            // OP_L (combined porta + vol slide) also takes a tone-porta target without retriggering,
            // mirroring G's behaviour — the L command continues the porta started by an earlier G.
            val toneG = (row.effect == EffectOp.OP_G || row.effect == EffectOp.OP_L)
            when (row.note) {
                // No note but an instrument byte is present: latch the instrument and
                // re-seed the channel volume from the new sample's Default Note Volume.
                // PT, FT2, IT and Schism all do this — pt2_replayer.c:1086 writes
                // ch->n_volume = s->volume on every sample-byte row regardless of note;
                // ft2_replayer.c:1431-1434 calls resetVolumes(ch) when (note==0 && inst>0);
                // schism csf_instrument_change writes chan->volume = psmp->volume whenever
                // inst_column is set. Without this, a MOD pattern that runs continuous
                // volume slides while re-asserting the sample byte each row (e.g.
                // physical_presence ord 0x1F ch2: every row carries `... 1E A0F/A09/A02`)
                // silences after the first row because the slide saturates at 0 and there's
                // nothing to lift the volume back up before the next slide starts.
                0x0000 -> {
                    if (row.instrment != 0 && !instruments[row.instrment].isMeta) {
                        voice.instrumentId = row.instrment
                        // Re-resolve the patch on the new instrument against the voice's
                        // current note so multi-sample IT/XM instruments pick up the right
                        // sample (and per-patch DNV) even on a continue row. samplePos is
                        // preserved — Schism csf_instrument_change reloads sample geometry
                        // but does not retrigger.
                        val newInst = instruments[voice.instrumentId]
                        val newPatch = newInst.resolvePatch(voice.noteVal, voice.noteVolume)
                        applyActiveSample(voice, newInst, newPatch)
                        val seedVol = rowVolumeFromDefault(newInst, newPatch)
                        voice.noteVolume = seedVol
                        voice.rowVolume = seedVol
                        voice.keyOff = false
                        voice.noteFading = false
                        voice.fadeoutVolume = 1.0
                    }
                }
                // Key-off: release sustain; envelope walks past the sustain point and the fadeout
                // begins (foreground-voice fade path at line ~2380). The voice deactivates when
                // fadeoutVolume reaches 0, or immediately if FT2-mode fadeStep == 0. Setting
                // voice.active = false here would defeat both — instruments with sustain points
                // and non-zero fadeout (FT2 sustain-then-fade idiom) would be cut on the spot.
                0x0001 -> {
                    // A sub-row key-off (KEY_OFF + S$Dx) defers to the requested tick instead of
                    // firing at tick 0 — otherwise the note is released early and, on instruments
                    // that rely on the release leg to end, can ring on / cut short (issues 3 & 5).
                    val dTick = if ((row.effect == EffectOp.OP_S) && ((row.effectArg ushr 12) and 0xF) == 0xD)
                                (row.effectArg ushr 8) and 0xF else 0
                    if (dTick > 0) {
                        voice.noteDelayTick = dTick; voice.delayedNote = 0x0001
                        voice.delayedInst = 0; voice.delayedVol = -1
                    } else {
                        voice.keyOff = true
                        applyKeyLift(voice, instruments[voice.instrumentId])
                    }
                }
                0x0002 -> {
                    val dTick = if ((row.effect == EffectOp.OP_S) && ((row.effectArg ushr 12) and 0xF) == 0xD)
                                (row.effectArg ushr 8) and 0xF else 0
                    if (dTick > 0) {
                        voice.noteDelayTick = dTick; voice.delayedNote = 0x0002
                        voice.delayedInst = 0; voice.delayedVol = -1
                    } else { voice.active = false; cutLayerChildren(ts, vi) }  // note cut (immediate)
                }
                // Fast note-fade (SF2 exclusiveClass choke): begin a ~0.3 s fade. Honours a
                // sub-row S$Dx delay the same way KEY_OFF / note-cut do.
                0x0004 -> {
                    val dTick = if ((row.effect == EffectOp.OP_S) && ((row.effectArg ushr 12) and 0xF) == 0xD)
                                (row.effectArg ushr 8) and 0xF else 0
                    if (dTick > 0) {
                        voice.noteDelayTick = dTick; voice.delayedNote = 0x0004
                        voice.delayedInst = 0; voice.delayedVol = -1
                    } else {
                        startFastFade(voice, playhead)
                    }
                }
                // IT-style note fade ("~~~~"): set the Note-Fade flag (Schism CHN_NOTEFADE,
                // effects.c:1505-1509) — the voice's own fadeout step (activeFadeoutStep, the
                // instrument's volume fadeout) drives fadeoutVolume to 0 in the line ~3676 fade
                // path, while the sustain loop and volume envelope keep running. Unlike KEY_OFF
                // (0x0001) it does NOT release sustain (no applyKeyLift); unlike the fast fade
                // (0x0004) it does NOT override the fadeout rate. If the instrument's fadeout is
                // 0 the note rings on — matches IT, where CHN_NOTEFADE with a zero fadeout
                // subtracts nothing. Honours a sub-row S$Dx delay like KEY_OFF / note-cut do.
                0x0003 -> {
                    val dTick = if ((row.effect == EffectOp.OP_S) && ((row.effectArg ushr 12) and 0xF) == 0xD)
                                (row.effectArg ushr 8) and 0xF else 0
                    if (dTick > 0) {
                        voice.noteDelayTick = dTick; voice.delayedNote = 0x0003
                        voice.delayedInst = 0; voice.delayedVol = -1
                    } else {
                        voice.noteFading = true
                    }
                }
                in 0x0005..0x000F -> { /* reserved sentinel range, no engine handler */ }
                in 0x0010..0x001F -> { /* Int0..IntF: reserved interrupt slots, no engine handler yet */ }
                else -> {
                    if (toneG && voice.active) {
                        // Tone porta: target the note, do not retrigger sample.
                        voice.tonePortaTarget = row.note
                        // Instrument byte on a porta row reloads the channel's default
                        // volume even though the sample isn't retriggered. Mirrors schism
                        // csf_instrument_change (effects.c:1302) which writes
                        // chan->volume = psmp->volume whenever inst_column is set, and
                        // (effects.c:1402-1403) which clears CHN_KEYOFF | CHN_NOTEFADE
                        // so an in-progress fadeout from the prior note does not bleed
                        // into the porta'd note. fadeoutVolume is reset to unity so a
                        // volume-column SET on this row is heard at face value rather
                        // than scaled by the decayed tail. The seed must use the new
                        // instrument's Default Note Volume (byte 196) — hard-coding
                        // 0x3F here would push samples with a reduced default vol up
                        // to full level on every porta-with-inst row (e.g.
                        // nearly_there_.mod ord 0x1B ch 4 r49 jumped from ~35 to 63
                        // and the bump persisted through the following vibrato rows).
                        if (row.instrment != 0 && !instruments[row.instrment].isMeta) {
                            voice.instrumentId = row.instrment
                            // Porta + inst-byte: re-resolve the patch on the new instrument
                            // against the voice's current note (Schism evaluates the keyboard
                            // table at csf_instrument_change time; the porta target row.note
                            // is only the slide destination, not the sample selector).
                            val newInst = instruments[voice.instrumentId]
                            val newPatch = newInst.resolvePatch(voice.noteVal, voice.noteVolume)
                            applyActiveSample(voice, newInst, newPatch)
                            val seedVol = rowVolumeFromDefault(newInst, newPatch)
                            voice.noteVolume = seedVol
                            voice.rowVolume = seedVol
                            voice.keyOff = false
                            voice.noteFading = false
                            voice.fadeoutVolume = 1.0
                        }
                    } else if ((row.effect == EffectOp.OP_S) && ((row.effectArg ushr 12) and 0xF) == 0xD) {
                        // Note delay: defer trigger to the requested tick. NNA fires when the
                        // deferred trigger actually executes, not now.
                        voice.noteDelayTick = (row.effectArg ushr 8) and 0xF
                        voice.delayedNote = row.note
                        voice.delayedInst = row.instrment
                        // Only treat the vol cell as an override when it carries SEL_SET;
                        // SEL_FINE/0 (no-op) and slide selectors must not collapse into
                        // a SET=0 on the deferred trigger.
                        voice.delayedVol = if (row.volumeEff == 0) row.volume else -1
                    } else {
                        applyDuplicateCheck(ts, vi, row.instrment, row.note)
                        maybeSpawnBackgroundForNNA(ts, voice, vi)
                        // V-column SET value (selector 0) is the trigger velocity; passed so both
                        // Metainstrument layers AND a non-meta instrument's velocity-split Ixmp
                        // patches resolve on the real velocity (see triggerMetaOrNote). -1 when the
                        // row carries no SET volume, leaving the default-note-volume seed in place.
                        val trigVol = if (row.volumeEff == 0) row.volume else -1
                        triggerMetaOrNote(ts, voice, vi, row.note, row.instrment, trigVol)
                    }
                }
            }

            // ── Volume column (selectors per TAUD_NOTE_EFFECTS.md) ──
            // The cell already separates value (volume) and selector (volumeEff).
            applyVolColumn(voice, row.volume, row.volumeEff)
            applyPanColumn(voice, row.pan, row.panEff)

            // ── Effect column ──
            applyEffectRow(ts, playhead, voice, vi, row.effect, row.effectArg)
        }
    }

    /** Resolve a non-zero argument or recall from the cohort memory and return the effective arg. */
    private fun resolveArg(arg: Int, mem: Int): Int = if (arg != 0) arg else mem

    private fun applyEffectRow(ts: TrackerState, playhead: Playhead, voice: Voice, vi: Int, op: Int, rawArg: Int) {
        when (op) {
            EffectOp.OP_NONE -> {}
            EffectOp.OP_7 -> {
                // 7 $xxyy — Pattern Ditto.  See TAUD_NOTE_EFFECTS.md §7.
                // The opcode is a marker only; the row-time expansion in
                // [applyTrackerRow] consumes the armer cell and substitutes the
                // effective row from the source block, so by the time dispatch
                // reaches here either (a) the cell was an armer and we already
                // overwrote the synthesised row's effect to 0 / source effect,
                // or (b) we hit a malformed 7-cell (length == 0 or repeats == 0
                // or length > N) — both cases are no-ops at dispatch time.
            }
            EffectOp.OP_1 -> {
                // 1 $xx00 — Global behaviour flags byte in the high byte (see TAUD_NOTE_EFFECTS.md §1).
                // bits 0-1 (ff): 0=linear pitch, 1=Amiga period, 2=linear frequency (Hz/tick),
                //                3=reserved
                // bits 2-3 (rr): 0=Fast Sinc, 1=none, 2=Amiga 500, 3=Amiga 1200
                // Panning law is fixed to the equal-energy; no runtime selection.
                val flags = rawArg ushr 8
                playhead.updateTrackerGlobalBehaviour(flags)
            }
            EffectOp.OP_5 -> applyFilterParamEffect(ts, voice, vi, rawArg, isResonance = false)  // 5 $xxyy — Filter Cutoff Control
            EffectOp.OP_6 -> applyFilterParamEffect(ts, voice, vi, rawArg, isResonance = true)   // 6 $xxyy — Filter Resonance Control
            EffectOp.OP_8 -> {
                // 8 $xyzz — Bitcrusher.  See TAUD_NOTE_EFFECTS.md §8.
                //   x  = clipping mode (shared with effect 9): 0 clamp, 1 fold, 2 wrap.
                //   y  = bit depth 1..15 (0 disables quantiser; 8..15 no-op on TSVM 8-bit output).
                //   zz = sample-skip count 0..255.
                // 8 $0000 disables the bitcrusher entirely.
                // 8 $x000 only updates the shared clipping mode (does not disturb depth/skip).
                val x = (rawArg ushr 12) and 0xF
                val y = (rawArg ushr 8) and 0xF
                val z = rawArg and 0xFF
                voice.clipMode = x and 3
                if (rawArg == 0) {
                    voice.bitcrusherDepth = 0
                    voice.bitcrusherSkip = 0
                    voice.bitcrusherCounter = 0
                } else if (y == 0 && z == 0) {
                    // x000 — clip mode only, leave bitcrusher state alone.
                } else {
                    voice.bitcrusherDepth = y
                    voice.bitcrusherSkip = z
                    voice.bitcrusherCounter = 0
                }
            }
            EffectOp.OP_9 -> {
                // 9 $x0zz — Overdrive.  See TAUD_NOTE_EFFECTS.md §9.
                //   x  = clipping mode (shared with effect 8): 0 clamp, 1 fold, 2 wrap.
                //   zz = amplification index 0..255; gain = (16 + zz) / 16  ⇒  $00=1×, $10=2×, $FF≈16.94×.
                // 9 $0000 disables the overdrive entirely.
                // 9 $x000 only updates the shared clipping mode.
                val x = (rawArg ushr 12) and 0xF
                val z = rawArg and 0xFF
                voice.clipMode = x and 3
                if (rawArg == 0) {
                    voice.overdriveAmp = 0
                } else if (z == 0) {
                    // x000 — clip mode only.
                } else {
                    voice.overdriveAmp = z
                }
            }
            EffectOp.OP_A -> {
                val tr = (rawArg ushr 8) and 0xFF
                if (tr != 0) playhead.tickRate = tr
            }
            EffectOp.OP_B -> {
                // Highest-priority B wins for the row (lowest channel index in spec); first-set wins by ascending channel scan.
                if (ts.pendingOrderJump < 0) ts.pendingOrderJump = rawArg.coerceIn(0, 1023)
            }
            EffectOp.OP_C -> {
                if (ts.pendingRowJump < 0) ts.pendingRowJump = rawArg.coerceIn(0, 63)
            }
            EffectOp.OP_D -> {
                // D is the per-note volume slide (analog of IT D). Fine forms write noteVolume
                // immediately; coarse forms arm slideMode for the per-tick handler below, which
                // walks noteVolume too so the per-note volume persists into following rows.
                val arg = resolveArg(rawArg, voice.mem.d).also { if (rawArg != 0) voice.mem.d = it }
                val hi = (arg ushr 8) and 0xFF
                val lo = hi and 0x0F
                val hin = (hi ushr 4) and 0x0F
                when {
                    hi == 0xFF || hi == 0xF0 -> { voice.noteVolume = (voice.noteVolume + 0xF).coerceAtMost(0x3F); voice.rowVolume = voice.noteVolume }   // $FF00 / $F000 quirk: fine up by F (TAUD_NOTE_EFFECTS.md §D)
                    hin == 0xF && lo != 0 -> { voice.noteVolume = (voice.noteVolume - lo).coerceAtLeast(0); voice.rowVolume = voice.noteVolume }        // $Fy00 fine down by y
                    lo == 0xF && hin != 0 -> { voice.noteVolume = (voice.noteVolume + hin).coerceAtMost(0x3F); voice.rowVolume = voice.noteVolume }     // $xF00 fine up by x
                    hin == 0 && lo != 0 -> { voice.slideMode = 5; voice.slideArg = -lo }     // $0y00 coarse down per non-first tick
                    lo == 0 && hin != 0 -> { voice.slideMode = 5; voice.slideArg = hin }     // $x000 coarse up per non-first tick
                }
            }
            EffectOp.OP_E -> {
                val arg = resolveArg(rawArg, voice.mem.ef).also { if (rawArg != 0) voice.mem.ef = it }
                if ((arg and 0xF000) == 0xF000) {
                    val mag = arg and 0x0FFF
                    voice.noteVal = when (ts.toneMode) {
                        1    -> amigaSlideOnce(voice.noteVal, -mag)         // Amiga: subtract from pitch ⇒ adds period
                        2    -> linearFreqSlideOnce(voice.noteVal, -mag)    // Hz/tick: pitch down ⇒ -Hz
                        else -> voice.noteVal - mag                          // linear 4096-TET
                    }.coerceIn(0x20, 0xFFFF)
                    voice.basePitch = voice.noteVal
                    voice.amigaPeriod = -1.0   // reseed on next per-tick slide
                    voice.linearFreq  = -1.0
                    voice.playbackRate = computePlaybackRate(voice, voice.noteVal)
                } else {
                    voice.slideMode = 1; voice.slideArg = -arg
                    voice.amigaPeriod = -1.0   // reseed at the start of a fresh multi-tick slide
                    voice.linearFreq  = -1.0
                }
            }
            EffectOp.OP_F -> {
                val arg = resolveArg(rawArg, voice.mem.ef).also { if (rawArg != 0) voice.mem.ef = it }
                if ((arg and 0xF000) == 0xF000) {
                    val mag = arg and 0x0FFF
                    voice.noteVal = when (ts.toneMode) {
                        1    -> amigaSlideOnce(voice.noteVal, mag)
                        2    -> linearFreqSlideOnce(voice.noteVal, mag)
                        else -> voice.noteVal + mag
                    }.coerceIn(0x20, 0xFFFF)
                    voice.basePitch = voice.noteVal
                    voice.amigaPeriod = -1.0
                    voice.linearFreq  = -1.0
                    voice.playbackRate = computePlaybackRate(voice, voice.noteVal)
                } else {
                    voice.slideMode = 2; voice.slideArg = arg
                    voice.amigaPeriod = -1.0
                    voice.linearFreq  = -1.0
                }
            }
            EffectOp.OP_G -> {
                val arg = resolveArg(rawArg, voice.mem.g).also { if (rawArg != 0) voice.mem.g = it }
                voice.tonePortaSpeed = arg
                // tonePortaTarget was set in note-handling block above (or remains -1).
            }
            EffectOp.OP_H -> {
                val sp = (rawArg ushr 8) and 0xFF
                val dp = rawArg and 0xFF
                if (sp != 0) voice.mem.huSpeed = sp
                if (dp != 0) voice.mem.huDepth = dp
                voice.vibratoActive = true
                voice.vibratoFineShift = 6
            }
            EffectOp.OP_I -> {
                val arg = resolveArg(rawArg, voice.mem.i).also { if (rawArg != 0) voice.mem.i = it }
                voice.tremorOn = 1
                voice.tremorOnTime = ((arg ushr 8) and 0xFF) + 1
                voice.tremorOffTime = (arg and 0xFF) + 1
            }
            EffectOp.OP_J -> {
                val arg = resolveArg(rawArg, voice.mem.j).also { if (rawArg != 0) voice.mem.j = it }
                voice.arpActive = true
                voice.arpOff1 = (arg ushr 8) and 0xFF
                voice.arpOff2 = arg and 0xFF
            }
            EffectOp.OP_K -> {
                // K $xy00 — vibrato continuation + per-tick volume slide. xy lives in the high
                // byte; $00 recalls K's private memory (TAUD_NOTE_EFFECTS.md §K). Vibrato uses
                // the H/U memory cohort (no retrigger from K alone). Slide direction: high nibble
                // = up, low nibble = down; both non-zero ⇒ down wins (ST3 quirk).
                val raw = (rawArg ushr 8) and 0xFF
                val arg = if (raw != 0) raw.also { voice.mem.k = it } else voice.mem.k
                val hi = (arg ushr 4) and 0xF
                val lo = arg and 0xF
                voice.vibratoActive = true
                voice.vibratoFineShift = 6
                when {
                    lo != 0 -> { voice.volColSlideDown = lo }   // down wins
                    hi != 0 -> { voice.volColSlideUp = hi }
                }
            }
            EffectOp.OP_L -> {
                // L $xy00 — tone-portamento continuation + per-tick volume slide. xy lives in the
                // high byte; $00 recalls L's private memory (TAUD_NOTE_EFFECTS.md §L). The porta
                // target was set in the row's note-handling block (toneG includes OP_L); the
                // porta speed is recalled from G's memory so a prior G's rate carries forward.
                val raw = (rawArg ushr 8) and 0xFF
                val arg = if (raw != 0) raw.also { voice.mem.l = it } else voice.mem.l
                val hi = (arg ushr 4) and 0xF
                val lo = arg and 0xF
                voice.tonePortaSpeed = voice.mem.g
                when {
                    lo != 0 -> { voice.volColSlideDown = lo }
                    hi != 0 -> { voice.volColSlideUp = hi }
                }
            }
            EffectOp.OP_M -> {
                // M $xx00 — set channel volume to the high byte (literal, no recall). IT $40 is
                // clamped to Taud's $3F cap. M writes the per-channel volume axis only and does
                // NOT touch noteVolume / rowVolume — the per-note volume set by vol-col SET (or
                // seeded from the instrument default on the trigger row) survives across this M.
                // The mixer multiplies channelVolume into the gain via the volume-ramp target,
                // so the change is heard immediately on this row. See TAUD_NOTE_EFFECTS.md §M.
                voice.channelVolume = ((rawArg ushr 8) and 0xFF).coerceAtMost(0x3F)
            }
            EffectOp.OP_N -> {
                // N $xy00 — channel-volume slide. Same nibble decoding as D but writes only the
                // persistent channelVolume; noteVolume / rowVolume are untouched so per-note
                // volume state (vol-col SET, D slides) survives an N.
                val arg = resolveArg(rawArg, voice.mem.n).also { if (rawArg != 0) voice.mem.n = it }
                val hi = (arg ushr 8) and 0xFF
                val lo = hi and 0x0F
                val hin = (hi ushr 4) and 0x0F
                when {
                    hi == 0xFF || hi == 0xF0 -> voice.channelVolume = (voice.channelVolume + 0xF).coerceAtMost(0x3F)
                    hin == 0xF && lo != 0 -> voice.channelVolume = (voice.channelVolume - lo).coerceAtLeast(0)
                    lo == 0xF && hin != 0 -> voice.channelVolume = (voice.channelVolume + hin).coerceAtMost(0x3F)
                    hin == 0 && lo != 0 -> voice.nSlideDir = -lo                            // coarse down per non-first tick
                    lo == 0 && hin != 0 -> voice.nSlideDir = hin                            // coarse up per non-first tick
                }
            }
            EffectOp.OP_P -> {
                // P $xy00 — channel-panning slide. D-style nibble layout, but the IT panning
                // direction convention applies: low nibble = right, high nibble = left.
                val arg = resolveArg(rawArg, voice.mem.p).also { if (rawArg != 0) voice.mem.p = it }
                val hi = (arg ushr 8) and 0xFF
                val lo = hi and 0x0F        // low nibble of high byte → right
                val hin = (hi ushr 4) and 0x0F   // high nibble of high byte → left
                when {
                    hi == 0xFF || hi == 0xF0 -> {  // FF / F0 quirk: fine left by F (high-nib form wins)
                        voice.channelPan = (voice.channelPan - 0xF).coerceAtLeast(0)
                        voice.rowPan = (voice.channelPan ushr 2).coerceIn(0, 63)
                    }
                    hin == 0xF && lo != 0 -> {     // fine right by lo on tick 0
                        voice.channelPan = (voice.channelPan + lo).coerceAtMost(0xFF)
                        voice.rowPan = (voice.channelPan ushr 2).coerceIn(0, 63)
                    }
                    lo == 0xF && hin != 0 -> {     // fine left by hin on tick 0
                        voice.channelPan = (voice.channelPan - hin).coerceAtLeast(0)
                        voice.rowPan = (voice.channelPan ushr 2).coerceIn(0, 63)
                    }
                    hin == 0 && lo != 0 -> { voice.panColSlideRight = lo }   // coarse right per non-first tick
                    lo == 0 && hin != 0 -> { voice.panColSlideLeft = hin }   // coarse left per non-first tick
                }
            }
            EffectOp.OP_O -> {
                // Sample-offset O: clamps into the active sample's loop region when an O$xx
                // value lands past loopEnd. Reads from the patch-aware active-sample view.
                val arg = resolveArg(rawArg, voice.mem.o).also { if (rawArg != 0) voice.mem.o = it }
                var off = arg
                if ((voice.activeLoopMode and 3) != 0 &&
                    voice.activeSampleLoopEnd > voice.activeSampleLoopStart &&
                    off > voice.activeSampleLoopEnd) {
                    val loopLen = (voice.activeSampleLoopEnd - voice.activeSampleLoopStart).coerceAtLeast(1)
                    off = voice.activeSampleLoopStart + ((off - voice.activeSampleLoopStart) % loopLen)
                }
                voice.samplePos = off.toDouble()
            }
            EffectOp.OP_Q -> {
                val arg = resolveArg(rawArg, voice.mem.q)
                val y = arg and 0xFF
                if (y != 0) {
                    voice.mem.q = arg
                    voice.retrigInterval = y
                    voice.retrigVolMod = (arg ushr 8) and 0xF
                    voice.retrigActive = true
                    // Counter persists across rows per spec.
                }
                // y == 0 → entire effect ignored, even memory (spec).
            }
            EffectOp.OP_R -> {
                val sp = (rawArg ushr 8) and 0xFF
                val dp = rawArg and 0xFF
                if (sp != 0) voice.mem.rSpeed = sp
                if (dp != 0) voice.mem.rDepth = dp
                voice.tremoloActive = true
            }
            EffectOp.OP_S -> applySEffect(ts, voice, vi, rawArg)
            EffectOp.OP_T -> {
                val hi = (rawArg ushr 8) and 0xFF
                if (hi != 0) {
                    val tempoByte = hi
                    playhead.bpm = (tempoByte + 0x19).coerceIn(25, 280)
                } else {
                    val low = rawArg and 0xFF
                    when (low and 0xF0) {
                        0x00 -> { voice.tempoSlideDir = -1; voice.tempoSlideAmount = low and 0x0F; voice.mem.tslide = low }
                        0x10 -> { voice.tempoSlideDir = +1; voice.tempoSlideAmount = low and 0x0F; voice.mem.tslide = low }
                    }
                }
            }
            EffectOp.OP_U -> {
                val sp = (rawArg ushr 8) and 0xFF
                val dp = rawArg and 0xFF
                if (sp != 0) voice.mem.huSpeed = sp
                if (dp != 0) voice.mem.huDepth = dp
                voice.vibratoActive = true
                voice.vibratoFineShift = 8
            }
            EffectOp.OP_V -> {
                val hi = (rawArg ushr 8) and 0xFF
                playhead.globalVolume = hi
            }
            EffectOp.OP_W -> {
                val arg = resolveArg(rawArg, voice.mem.w).also { if (rawArg != 0) voice.mem.w = it }
                val hi = (arg ushr 8) and 0xFF
                val lo = hi and 0x0F
                val hin = (hi ushr 4) and 0x0F
                when {
                    hi == 0xFF -> playhead.globalVolume = (playhead.globalVolume + 0xF).coerceAtMost(0xFF)  // WFF quirk: fine up by F
                    hin == 0xF && lo != 0 -> playhead.globalVolume = (playhead.globalVolume - lo).coerceAtLeast(0)   // fine down on tick 0
                    lo == 0xF && hin != 0 -> playhead.globalVolume = (playhead.globalVolume + hin).coerceAtMost(0xFF) // fine up on tick 0
                    hin == 0 && lo != 0 -> { voice.wSlideDir = -1; voice.wSlideAmount = lo }   // coarse down per non-first tick
                    lo == 0 && hin != 0 -> { voice.wSlideDir = +1; voice.wSlideAmount = hin }  // coarse up per non-first tick
                }
            }
            EffectOp.OP_Y -> {
                val sp = (rawArg ushr 8) and 0xFF
                val dp = rawArg and 0xFF
                if (sp != 0) voice.mem.ySpeed = sp
                if (dp != 0) voice.mem.yDepth = dp
                voice.panbrelloActive = true
            }
        }
    }

    private fun applySEffect(ts: TrackerState, voice: Voice, vi: Int, arg: Int) {
        val sub = (arg ushr 12) and 0xF
        val x = (arg ushr 8) and 0xF
        when (sub) {
            0x0 -> {
                // S $0000 = LED on, S $0100 = LED off (PT E00 / E01 — pt2_replayer.c:608
                // computes filterOn = (cmd & 1) ^ 1, so x=0 → on, x=1 → off).
                // Only meaningful in Amiga interpolation modes; on linear / no-interp the
                // filter chain is bypassed so writes are silent no-ops.
                if (ts.interpolationMode == INTERP_A500 || ts.interpolationMode == INTERP_A1200) {
                    ts.ledFilterOn = (x == 0)
                }
            }
            0x1 -> voice.glissandoOn = (x != 0)
            0x2 -> {
                voice.noteVal = (voice.noteVal + FINETUNE_OFFSET[x]).coerceIn(0x20, 0xFFFF)
                voice.basePitch = voice.noteVal
                voice.amigaPeriod = -1.0
                voice.linearFreq  = -1.0
                voice.playbackRate = computePlaybackRate(voice, voice.noteVal)
            }
            0x3 -> { voice.vibratoWave = x and 3; voice.vibratoRetrig = (x and 4) == 0 }
            0x4 -> { voice.tremoloWave = x and 3; voice.tremoloRetrig = (x and 4) == 0 }
            0x5 -> { voice.panbrelloWave = x and 3; voice.panbrelloRetrig = (x and 4) == 0 }
            0x6 -> ts.finePatternDelayExtra += x   // fine pattern delay: accumulate across channels
            0x7 -> {
                // S$7x — Note/Instrument actions (TAUD_NOTE_EFFECTS.md §"S $7x00").
                // $0..$6 (past-note actions + NNA override) are no-ops on a metainstrument: its
                // live layer-child ghosts would otherwise be mistaken for past notes and culled.
                // $7..$E (envelope toggles) fan out across a meta's constituents — the foreground
                // voice plus every layer-child ghost on this channel (see [forEachEnvTarget]).
                val isMeta = voice.metaForeground
                when (x) {
                    // Past-note actions on the channel's background ghosts.
                    0x0 -> if (!isMeta) applyPastNoteAction(ts, vi, 0)   // Past Note Cut
                    0x1 -> if (!isMeta) applyPastNoteAction(ts, vi, 1)   // Past Note Off
                    0x2 -> if (!isMeta) applyPastNoteAction(ts, vi, 2)   // Past Note Fade
                    // NNA override for the live note (used at next NNA event on this voice).
                    // Codes follow the per-voice nnaOverride convention (0=Off, 1=Cut, 2=Continue, 3=Fade).
                    0x3 -> if (!isMeta) voice.nnaOverride = 1            // NNA Note Cut
                    0x4 -> if (!isMeta) voice.nnaOverride = 2            // NNA Note Continue
                    0x5 -> if (!isMeta) voice.nnaOverride = 0            // NNA Note Off
                    0x6 -> if (!isMeta) voice.nnaOverride = 3            // NNA Note Fade
                    // Envelope on/off — mixer ignores and per-tick freezes the disabled envelope.
                    0x7 -> forEachEnvTarget(ts, voice, vi) { it.volEnvOn = false }   // Volume Env Off
                    0x8 -> forEachEnvTarget(ts, voice, vi) { it.volEnvOn = true }    // Volume Env On
                    0x9 -> forEachEnvTarget(ts, voice, vi) { it.panEnvOn = false }   // Panning Env Off
                    0xA -> forEachEnvTarget(ts, voice, vi) { it.panEnvOn = true }    // Panning Env On
                    // $B/$C target the PITCH envelope when one is defined; on a filter-only
                    // instrument they fall back to the filter env (IT "pitch or filter" semantics).
                    0xB -> forEachEnvTarget(ts, voice, vi) { if (it.hasPitchEnv) it.pitchEnvOn = false else if (it.hasFilterEnv) it.filterEnvOn = false }
                    0xC -> forEachEnvTarget(ts, voice, vi) { if (it.hasPitchEnv) it.pitchEnvOn = true  else if (it.hasFilterEnv) it.filterEnvOn = true }
                    // $D/$E toggle the FILTER envelope specifically (Taud-specific; differs from MPTM).
                    0xD -> forEachEnvTarget(ts, voice, vi) { it.filterEnvOn = false } // Filter Env Off
                    0xE -> forEachEnvTarget(ts, voice, vi) { it.filterEnvOn = true }  // Filter Env On
                }
            }
            0x8 -> {
                // S$80xx — full 8-bit pan; arg low byte is the value.
                voice.channelPan = arg and 0xFF
                voice.rowPan = (voice.channelPan shr 2).coerceIn(0, 63)
            }
            0xB -> {
                if (x == 0) voice.loopStartRow = ts.rowIndex
                else {
                    if (voice.loopCount == 0) {
                        voice.loopCount = x
                        ts.pendingRowJump = voice.loopStartRow
                        ts.pendingRowJumpLocal = true
                    } else if (!ts.patternDelayActive) {
                        voice.loopCount--
                        if (voice.loopCount > 0) {
                            ts.pendingRowJump = voice.loopStartRow
                            ts.pendingRowJumpLocal = true
                        }
                    }
                }
            }
            0xC -> if (x != 0) voice.cutAtTick = x
            0xD -> {} // handled in note section above (note delay)
            0xE -> {
                // Pattern delay — first SEx in ascending channel order wins.
                if (ts.sexWinningChannel < 0) {
                    ts.sexWinningChannel = vi
                    ts.patternDelayRemaining = x
                }
            }
            0xF -> { voice.funkSpeed = arg and 0xFF; if (x == 0) voice.funkAccumulator = 0 }
        }
    }

    /** Apply an envelope toggle (S$77..$7E) to the right voice set: the foreground voice plus —
     *  for a metainstrument — every layer-child ghost on this channel, so all constituents move
     *  together. Ordinary instruments have no layer children, so only the foreground voice is
     *  touched. See TAUD_NOTE_EFFECTS.md §"S $7x00". */
    private inline fun forEachEnvTarget(ts: TrackerState, voice: Voice, vi: Int, action: (Voice) -> Unit) {
        action(voice)
        for (bg in ts.backgroundVoices) if (bg.isLayerChild && bg.sourceChannel == vi) action(bg)
    }

    /**
     * notefx 5 (cutoff) / 6 (resonance) — Filter Cutoff/Resonance Control (TAUD_NOTE_EFFECTS.md §"5/6").
     *
     * Sets the instrument's filter cutoff (5) or resonance (6) directly; the change is instrument-wide,
     * so every note that shares the instrument — including notes already sounding — is affected. The
     * value is read mode-aware: IT mode takes the high byte ($xx) only, SF mode takes the full 16-bit
     * argument ($xxyy). $FFFF clears the override and restores the instrument's loaded default. The
     * effect has no memory.
     *
     * On a metainstrument the change fans out across every constituent currently sounding on this
     * channel (the foreground layer 0 plus its layer-child ghosts), so the whole stack moves together.
     */
    private fun applyFilterParamEffect(ts: TrackerState, voice: Voice, vi: Int, rawArg: Int, isResonance: Boolean) {
        // Target instrument set: the foreground voice's instrument plus those of any layer-child
        // ghosts on this channel (the set is just the one instrument for an ordinary instrument).
        val targets = HashSet<Int>()
        targets.add(voice.instrumentId)
        for (bg in ts.backgroundVoices) if (bg.isLayerChild && bg.sourceChannel == vi) targets.add(bg.instrumentId)

        for (id in targets) {
            val ti = instruments[id]
            val value = when {
                rawArg == 0xFFFF -> -1                       // reset: drop the override, restore default
                ti.filterSfMode  -> rawArg and 0xFFFF        // SF mode: full 16-bit cents / centibels
                else             -> (rawArg ushr 8) and 0xFF // IT mode: high byte only
            }
            if (isResonance) ti.resonanceOverride = value else ti.cutoffOverride = value
        }

        // Push the resolved value into every currently-active voice that shares a target instrument
        // so notes already sounding change immediately. Voices with a filter envelope recompute
        // currentCutoff from activeDefaultCutoff each tick; voices without one (and resonance, which
        // has no per-tick recompute) read the value seeded here. filterSfMode is re-synced so the
        // per-tick filter math reads the value in the right units.
        fun push(v: Voice) {
            if (v.instrumentId !in targets) return
            val ti = instruments[v.instrumentId]
            v.filterSfMode = ti.filterSfMode
            if (isResonance) {
                v.activeDefaultResonance = ti.defaultResonance16
                v.currentResonance = v.activeDefaultResonance
            } else {
                v.activeDefaultCutoff = ti.defaultCutoff16
                v.currentCutoff = v.activeDefaultCutoff
            }
            v.filterCutoffCached = -1; v.filterResonanceCached = -1   // force coefficient refresh
        }
        for (v in ts.voices) if (v.active) push(v)
        for (bg in ts.backgroundVoices) if (bg.active) push(bg)
    }

    private fun applyTrackerTick(ts: TrackerState, playhead: Playhead) {
        val tickSec = 2.5 / playhead.bpm
        // Samples-per-tick at the current BPM — used to spread the per-tick envVolume
        // jump across the upcoming tick interval so the mixer hears a continuous slope
        // instead of a stair-step. Recomputed every tick because BPM can change mid-row.
        val spt = SAMPLING_RATE * tickSec
        for (vi in 0 until ts.voices.size) {
            val voice = ts.voices[vi]
            if (!voice.active && voice.noteDelayTick < 0) continue
            var inst = instruments[voice.instrumentId]

            // Note cut. Zero noteVolume / rowVolume (silence this note) but leave channelVolume
            // alone — IT's note cut stops the sample, it doesn't reset chan->global_volume.
            if (voice.cutAtTick == ts.tickInRow) {
                voice.noteVolume = 0; voice.rowVolume = 0
                voice.noteWasCut = true
            }

            // Note delay — fire the deferred event when the requested tick arrives. A delayed
            // KEY_OFF / note-cut (converters emit sub-row key-offs as KEY_OFF + S$Dx) applies the
            // release/cut here instead of at tick 0; a delayed NOTE triggers with NNA now (not at
            // row parse) so that delayed retriggers ghost correctly.
            if (voice.noteDelayTick == ts.tickInRow) {
                when (voice.delayedNote) {
                    0x0001 -> {                                   // delayed KEY_OFF
                        voice.keyOff = true
                        applyKeyLift(voice, instruments[voice.instrumentId])
                    }
                    0x0002 -> { voice.active = false; cutLayerChildren(ts, vi) }  // delayed note cut
                    0x0003 -> voice.noteFading = true                             // delayed note fade (IT CHN_NOTEFADE)
                    0x0004 -> startFastFade(voice, playhead)                      // delayed fast fade
                    else -> {
                        applyDuplicateCheck(ts, vi, voice.delayedInst, voice.delayedNote)
                        maybeSpawnBackgroundForNNA(ts, voice, vi)
                        triggerMetaOrNote(ts, voice, vi, voice.delayedNote, voice.delayedInst, voice.delayedVol)
                    }
                }
                voice.noteDelayTick = -1
                // triggerNote may have swapped in a new instrument; re-bind so the rest of this
                // tick's per-voice work (playbackRate at L3090, envelope/fadeout/auto-vibrato)
                // uses the instrument that just fired, not the one the voice held on entry. On a
                // never-triggered voice the stale binding is instruments[0] (samplingRate 0),
                // which would zero playbackRate and freeze the sample — the "first note on a
                // fresh channel via S$Dx is silent" bug.
                inst = instruments[voice.instrumentId]
            }

            if (!voice.active) {
                advanceEnvelope(voice, tickSec)
                voice.envVolStep = if (spt > 0.0) (voice.envVolume - voice.envVolMix) / spt else 0.0
                continue
            }

            // Pitch slides (E/F coarse on tick > 0).
            if (ts.tickInRow > 0 && (voice.slideMode == 1 || voice.slideMode == 2)) {
                voice.noteVal = when (ts.toneMode) {
                    1    -> amigaSlideTick(voice, voice.slideArg)
                    2    -> linearFreqSlideTick(voice, voice.slideArg)
                    else -> voice.noteVal + voice.slideArg
                }.coerceIn(0x20, 0xFFFF)
                voice.basePitch = voice.noteVal
            }

            // Tone portamento (G). In linear-freq mode the speed is interpreted as Hz/tick
            // so MONOTONE 3xx (port-to-note in Hz) round-trips faithfully; in linear and
            // Amiga modes the speed is in 4096-TET pitch units (Amiga period units would be
            // backwards relative to PT semantics — see TAUD_NOTE_EFFECTS.md §G).
            if (voice.tonePortaTarget >= 0 && ts.tickInRow > 0) {
                val target = voice.tonePortaTarget
                val sp = voice.tonePortaSpeed
                if (ts.toneMode == 2) {
                    if (voice.linearFreq < 0.0) voice.linearFreq = noteValToFreqHz(voice.noteVal)
                    val targetFreq = noteValToFreqHz(target)
                    val dir = if (targetFreq > voice.linearFreq) +1.0 else -1.0
                    voice.linearFreq += dir * sp
                    if ((dir > 0 && voice.linearFreq >= targetFreq) ||
                        (dir < 0 && voice.linearFreq <= targetFreq)) {
                        voice.linearFreq = targetFreq
                        voice.noteVal = target
                        voice.tonePortaTarget = -1
                    } else {
                        voice.noteVal = freqHzToNoteVal(voice.linearFreq).coerceIn(0x20, 0xFFFF)
                    }
                    voice.basePitch = voice.noteVal
                    voice.amigaPeriod = -1.0
                } else {
                    val delta = if (target > voice.noteVal) sp else -sp
                    voice.noteVal += delta
                    if ((delta > 0 && voice.noteVal >= target) || (delta < 0 && voice.noteVal <= target)) {
                        voice.noteVal = target; voice.tonePortaTarget = -1
                    }
                    voice.basePitch = voice.noteVal
                    voice.amigaPeriod = -1.0   // tone porta works in linear noteVal space; reseed period
                    voice.linearFreq  = -1.0
                }
            }

            // Volume slides (D coarse on tick > 0). D walks the per-note volume; rowVolume
            // tracks it so the change is audible this tick and rebases on next row entry.
            if (ts.tickInRow > 0 && voice.slideMode == 5) {
                voice.noteVolume = (voice.noteVolume + voice.slideArg).coerceIn(0, 0x3F)
                voice.rowVolume = voice.noteVolume
            }

            // Volume-column slides (selectors 1/2 — per non-first tick) and N coarse slide.
            // Vol-col writes noteVolume; N writes channelVolume — they target independent axes.
            if (ts.tickInRow > 0) {
                if (voice.volColSlideUp != 0) {
                    voice.noteVolume = (voice.noteVolume + voice.volColSlideUp).coerceAtMost(0x3F); voice.rowVolume = voice.noteVolume
                }
                if (voice.volColSlideDown != 0) {
                    voice.noteVolume = (voice.noteVolume - voice.volColSlideDown).coerceAtLeast(0); voice.rowVolume = voice.noteVolume
                }
                if (voice.nSlideDir != 0) {
                    voice.channelVolume = (voice.channelVolume + voice.nSlideDir).coerceIn(0, 0x3F)
                }
                if (voice.panColSlideRight != 0) {
                    voice.channelPan = (voice.channelPan + voice.panColSlideRight).coerceAtMost(0xFF)
                    voice.rowPan = (voice.channelPan shr 2).coerceIn(0, 63)
                }
                if (voice.panColSlideLeft != 0) {
                    voice.channelPan = (voice.channelPan - voice.panColSlideLeft).coerceAtLeast(0)
                    voice.rowPan = (voice.channelPan shr 2).coerceIn(0, 63)
                }
            }

            // Tremor (I) — gates output volume.
            if (voice.tremorOn != 0) {
                voice.tremorTickInPhase++
                val limit = if (voice.tremorPhaseOn) voice.tremorOnTime else voice.tremorOffTime
                if (voice.tremorTickInPhase >= limit) { voice.tremorTickInPhase = 0; voice.tremorPhaseOn = !voice.tremorPhaseOn }
                if (!voice.tremorPhaseOn) voice.rowVolume = 0
            }

            // Vibrato (H/U) — applied as base-pitch overlay.
            var pitchToMixer = voice.noteVal
            if (voice.vibratoActive) {
                val sine = lfoSample(voice.vibratoLfoPos, voice.vibratoWave)
                val pitchDelta = (sine * voice.mem.huDepth) shr voice.vibratoFineShift
                pitchToMixer = (voice.noteVal + pitchDelta).coerceIn(0x20, 0xFFFF)
                voice.vibratoLfoPos = (voice.vibratoLfoPos + voice.mem.huSpeed * 4) and 0xFF
            }

            // Glissando (S$1x) — snap pitchToMixer to nearest semitone but leave noteVal smooth.
            if (voice.glissandoOn) {
                val semis = ((pitchToMixer * 12 + 2048) / 4096)
                pitchToMixer = (semis * 4096 / 12).coerceIn(0x20, 0xFFFF)
            }

            // Tremolo (R) — modulates rowVolume around the per-note volume base. IT's tremolo
            // operates on chan->volume (per-note), not chan->global_volume, so the LFO bias is
            // added to noteVolume rather than channelVolume. The result lands in rowVolume only,
            // so noteVolume itself is unaffected and tremolo dies cleanly when the row ends
            // (per-row rowVolume rebase) — which is what existing IT modules expect.
            if (voice.tremoloActive) {
                val sine = lfoSample(voice.tremoloLfoPos, voice.tremoloWave)
                val volDelta = (sine * voice.mem.rDepth) shr 9
                voice.rowVolume = (voice.noteVolume + volDelta).coerceIn(0, 0x3F)
                voice.tremoloLfoPos = (voice.tremoloLfoPos + voice.mem.rSpeed * 4) and 0xFF
            }

            // Panbrello (Y) — modulates panning around base.
            if (voice.panbrelloActive) {
                val sine = lfoSample(voice.panbrelloLfoPos, voice.panbrelloWave)
                val panDelta = (sine * voice.mem.yDepth) shr 9
                voice.rowPan = ((voice.channelPan ushr 2) + panDelta).coerceIn(0, 0x3F)
                voice.panbrelloLfoPos = (voice.panbrelloLfoPos + voice.mem.ySpeed * 4) and 0xFF
            }

            // Arpeggio (J) — overrides pitchToMixer for this tick (overlay on basePitch).
            if (voice.arpActive) {
                val voiceIdx = ts.tickInRow % 3
                val arpDelta = when (voiceIdx) { 1 -> voice.arpOff1 shl 8; 2 -> voice.arpOff2 shl 8; else -> 0 }
                pitchToMixer = (voice.basePitch + arpDelta).coerceIn(0x20, 0xFFFF)
                voice.lastArpVoice = voiceIdx
            }

            // Q retrigger.
            if (voice.retrigActive && !voice.noteWasCut) {
                voice.retrigCounter++
                if (voice.retrigCounter >= voice.retrigInterval) {
                    voice.retrigCounter = 0
                    // Use the voice's active sample's playStart (patch-aware) — without this
                    // a Q retrigger on a multi-sample instrument would jump to the base sample
                    // even though the voice is bound to a patch.
                    voice.samplePos = voice.activeSamplePlayStart.toDouble()
                    voice.keyOff = false
                    voice.envIndex = 0; voice.envTimeSec = 0.0
                    voice.envPanIndex = 0; voice.envPanTimeSec = 0.0
                    voice.envPan = voice.activePanEnv[0].value / 255.0
                    voice.envPitchIndex = 0; voice.envPitchTimeSec = 0.0
                    voice.envPitchValue = if (voice.hasPitchEnv) voice.activePitchEnv[0].value / 255.0 else 0.5
                    voice.envFilterIndex = 0; voice.envFilterTimeSec = 0.0
                    voice.envFilterValue = if (voice.hasFilterEnv) voice.activeFilterEnv[0].value / 255.0 else 0.5
                    voice.fadeoutVolume = 1.0
                    voice.autoVibPhase = 0
                    voice.autoVibTicksSinceTrigger = 0
                    voice.filterY1 = 0.0; voice.filterY2 = 0.0; voice.filterX1 = 0.0; voice.filterX2 = 0.0
                    voice.noteVolume = applyRetrigVolMod(voice.noteVolume, voice.retrigVolMod)
                    voice.rowVolume = voice.noteVolume
                }
            }

            // Auto-vibrato (instrument-supplied sample LFO) — added on top of pitchToMixer.
            val autoVibDelta = advanceAutoVibrato(voice, inst)

            // Pitch envelope contribution: env value 0..1, 0.5 = unity.
            // IT pitch envelope max is ±16 semitones (Schism sndmix.c:455-462 indexes
            // linear_slide_up_table[abs(envpitch)] where envpitch ∈ [-256,+256] and
            // table[255] = 65536·2^(255/192) ≈ 2.504, i.e. 15.94 semitones).
            val pitchEnvDelta = if (voice.hasPitchEnv && voice.pitchEnvOn)
                ((voice.envPitchValue - 0.5) * 2.0 * 16.0 * 4096.0 / 12.0).toInt()
            else 0

            val finalPitch = (pitchToMixer + autoVibDelta + pitchEnvDelta).coerceIn(0x20, 0xFFFF)
            voice.playbackRate = computePlaybackRate(voice, finalPitch)

            // Filter envelope: scale baseCut by envValue (0..1, 0.5 = unity).
            // Schism filters.c:80-86 computes `cutoff_used = chan->cutoff * (flt_modifier+256)/256`
            // where flt_modifier = (env_value_0..64 - 32) * 8. Mapping TSVM's [0..1] env to Schism's
            // [-256..+256] modifier and accounting for our pre-doubled defaultCutoff (it2taud.py
            // stores IFC*2 in 0..254) gives `currentCutoff = baseCut * envFilterValue` — at unity (0.5)
            // the filter sits at IFC, at max (1.0) it opens to 2*IFC, at min (0.0) it closes.
            // If the instrument has no initial cutoff (255 = off), the envelope drives the filter
            // from the maximum active value (254) so the filter can become audible during the note.
            // baseCut is the ACTIVE cutoff (patch 'x' override or base inst).
            if (voice.hasFilterEnv && voice.filterEnvOn) {
                if (voice.filterSfMode) {
                    // SF mode: activeDefaultCutoff is the PEAK cutoff in cents; the env scales it
                    // down (envFilterValue 1.0 = peak/open, 0 = closed). Converter sets node values
                    // = targetCents/peakCents so the SF2 mod-env sweep is reproduced exactly.
                    val baseCut = if (voice.activeDefaultCutoff < 0xFFFF) voice.activeDefaultCutoff else 13500
                    voice.currentCutoff = (baseCut * voice.envFilterValue).toInt().coerceIn(0, 0xFFFF)
                } else {
                    val baseCut = if (voice.activeDefaultCutoff < 255) voice.activeDefaultCutoff else 254
                    voice.currentCutoff = (baseCut * voice.envFilterValue).toInt().coerceIn(0, 254)
                }
            }

            // Refresh biquad filter coefficients once per tick (only recomputes when changed).
            refreshVoiceFilter(voice)

            // Volume fadeout: after key-off OR Note-Fade NNA, decrement per tick.
            // The 12-bit fadeStep is split across volumeFadeoutLow + low nibble of fadeoutHigh.
            // Engine semantics (terranmon.txt byte 172/173, TAUD_NOTE_EFFECTS.md §1 "Volume Fadeout"):
            //   fadeoutVolume -= fadeStep / 1024.0 per tick, clamped at 0.
            //   stored = 0     : no fade (the if-branch is skipped — voice plays on at envelope volume)
            //   stored = 1024  : exact 1-tick cut
            //   stored > 1024  : also a 1-tick cut (clamped)
            // Both IT and FT2 file formats encode "no fade" as stored=0 and "cut" as the slider-extreme
            // of the same field; converters scale source values into Taud's 0..4095 unit so the engine
            // sees one consistent encoding.
            if (voice.keyOff || voice.noteFading) {
                val fadeStep = voice.activeFadeoutStep
                if (fadeStep > 0) {
                    voice.fadeoutVolume = (voice.fadeoutVolume - fadeStep / 1024.0).coerceAtLeast(0.0)
                    if (voice.fadeoutVolume <= 0.0) voice.active = false
                }
            }

            advanceEnvelope(voice, tickSec)
            // Compute per-sample slope so envVolMix walks smoothly to the new envVolume
            // across the next tick interval; this turns the mixer's view of the envelope
            // from a stair-step into a continuous ramp and removes the per-tick clicks
            // that are otherwise audible on steep envelope slopes (e.g., XM volume
            // envelopes with fast attack/decay nodes — the slumberjack.xm symptom).
            voice.envVolStep = if (spt > 0.0) (voice.envVolume - voice.envVolMix) / spt else 0.0
            advancePitchEnvelope(voice, tickSec)
            advanceFilterEnvelope(voice, tickSec)
        }

        // Tempo slide — applied once per tick at the playhead level (any channel that armed it).
        for (voice in ts.voices) {
            if (voice.tempoSlideDir != 0 && ts.tickInRow > 0) {
                val tempoByte = (playhead.bpm - 0x19 + voice.tempoSlideDir * voice.tempoSlideAmount).coerceIn(0, 0xFF)
                playhead.bpm = (tempoByte + 0x19).coerceIn(25, 280)
            }
        }

        // Global volume slide (W coarse) — applied once per non-first tick per armed channel.
        if (ts.tickInRow > 0) {
            for (voice in ts.voices) {
                if (voice.wSlideDir != 0) {
                    playhead.globalVolume = (playhead.globalVolume + voice.wSlideDir * voice.wSlideAmount).coerceIn(0, 0xFF)
                }
            }
        }

        // Funk repeat (S$Fxxxx) — advance bit-mask per tick on instruments with active funkSpeed.
        // Matches PT2 updateFunk (pt2_replayer.c:278-297): hard-reset accumulator on overflow
        // (NOT subtract — drops residual), and pre-increment the write pointer before flipping
        // so the first invert after a fresh trigger lands on loop-relative byte 1.
        for (voice in ts.voices) {
            if (voice.funkSpeed == 0 || !voice.active) continue
            val inst = instruments[voice.instrumentId]
            if (inst.sampleLoopEnd <= inst.sampleLoopStart) continue
            voice.funkAccumulator += voice.funkSpeed
            if (voice.funkAccumulator >= 0x80) {
                voice.funkAccumulator = 0
                val loopLen = (inst.sampleLoopEnd - inst.sampleLoopStart).coerceAtLeast(1)
                voice.funkWritePos = (voice.funkWritePos + 1) % loopLen
                inst.toggleFunkBit(voice.funkWritePos)
            }
        }

        // Background (NNA-ghost) voices: passive maintenance only — envelopes, fadeout, filter,
        // and pitch recompute. No row-driven effects (vibrato/tremolo/arp/Q/etc.) ever target
        // background voices; they continue from the moment of ghosting until they fade or end.
        val bgIt = ts.backgroundVoices.iterator()
        while (bgIt.hasNext()) {
            val bg = bgIt.next()
            if (!bg.active) { bgIt.remove(); continue }
            // Metainstrument layer child: re-sync pitch / key-off / volume / pan from the
            // parent foreground voice each tick so tone-portamento, slides, KEY_OFF, M
            // channel-volume and panning carry to every layer of the note. When the parent
            // note ends, detach so this layer finishes its own release as a plain ghost.
            if (bg.isLayerChild) {
                val parent = ts.voices.getOrNull(bg.sourceChannel)
                if (parent == null || !parent.active) {
                    // Parent note ended: detach so this layer finishes its own release as a
                    // plain ghost. But if the parent was RELEASED (key-off / note-fade) and its
                    // own fadeout deactivated it in the SAME tick the release fired — a fast
                    // fadeout, e.g. fo≈1067 (a 1-tick cut) — the parent-sync below never ran
                    // while it was active, so the release was never carried across and a still
                    // looping/sustaining child would ring on until the next note displaces it.
                    // Inherit the parent's final release here before detaching (parent.keyOff /
                    // noteFading survive deactivation; both are reset on retrigger, so a true
                    // value means THIS note was released, not a stale flag). A parent that ended
                    // without release (natural sample/env end) leaves the child to finish on its
                    // own, unchanged. Symptom: long tails on multi-layer SF2 presets with a short
                    // release, e.g. Timbres of Heaven's sustained guitars/organs.
                    if (parent != null && !bg.keyOff && !bg.noteFading) {
                        if (parent.keyOff) { bg.keyOff = true; applyKeyLift(bg, instruments[bg.instrumentId]) }
                        else if (parent.noteFading) bg.noteFading = true
                    }
                    bg.isLayerChild = false
                } else {
                    bg.noteVal   = (parent.noteVal + bg.layerRelDetune).coerceIn(0x20, 0xFFFF)
                    bg.basePitch = bg.noteVal
                    bg.amigaPeriod = -1.0; bg.linearFreq = -1.0
                    if (parent.keyOff && !bg.keyOff) { bg.keyOff = true; applyKeyLift(bg, instruments[bg.instrumentId]) }
                    if (parent.noteFading && !bg.noteFading) bg.noteFading = true
                    bg.channelVolume = parent.channelVolume
                    bg.noteVolume    = parent.noteVolume
                    bg.rowVolume     = parent.rowVolume
                    bg.channelPan    = parent.channelPan
                    bg.rowPan        = parent.rowPan
                }
            }
            val inst = instruments[bg.instrumentId]
            advanceEnvelope(bg, tickSec)
            bg.envVolStep = if (spt > 0.0) (bg.envVolume - bg.envVolMix) / spt else 0.0
            advancePitchEnvelope(bg, tickSec)
            advanceFilterEnvelope(bg, tickSec)
            if (bg.keyOff || bg.noteFading) {
                val fadeStep = bg.activeFadeoutStep
                if (fadeStep > 0) {
                    // Mirrors the foreground-voice fade path above — single divisor of 1024.
                    bg.fadeoutVolume = (bg.fadeoutVolume - fadeStep / 1024.0).coerceAtLeast(0.0)
                }
            }
            // Auto-vibrato keeps running on backgrounds — it's an instrument-intrinsic LFO.
            val autoVibDelta = advanceAutoVibrato(bg, inst)
            val pitchEnvDelta = if (bg.hasPitchEnv && bg.pitchEnvOn)
                ((bg.envPitchValue - 0.5) * 2.0 * 16.0 * 4096.0 / 12.0).toInt()
            else 0
            val finalPitch = (bg.noteVal + autoVibDelta + pitchEnvDelta).coerceIn(0x20, 0xFFFF)
            bg.playbackRate = computePlaybackRate(bg, finalPitch)
            // Filter envelope: same scaling rule as foreground, using the active cutoff.
            // Must branch on SF mode too — an SF-mode ghost's cutoff is in cents (0..0xFFFF),
            // so the IT 0..254 clamp would otherwise collapse it to ~9 Hz (total muffling).
            if (bg.hasFilterEnv && bg.filterEnvOn) {
                if (bg.filterSfMode) {
                    val baseCut = if (bg.activeDefaultCutoff < 0xFFFF) bg.activeDefaultCutoff else 13500
                    bg.currentCutoff = (baseCut * bg.envFilterValue).toInt().coerceIn(0, 0xFFFF)
                } else {
                    val baseCut = if (bg.activeDefaultCutoff < 255) bg.activeDefaultCutoff else 254
                    bg.currentCutoff = (baseCut * bg.envFilterValue).toInt().coerceIn(0, 254)
                }
            }
            refreshVoiceFilter(bg)
            // Reap fully-faded ghosts so the pool stays drained.
            if ((bg.keyOff || bg.noteFading) && bg.fadeoutVolume <= 0.0) {
                bg.active = false
                bgIt.remove()
            }
        }
    }

    private fun applyRetrigVolMod(vol: Int, x: Int): Int = when (x and 0xF) {
        0, 8 -> vol
        1 -> vol - 0x01; 2 -> vol - 0x02; 3 -> vol - 0x04; 4 -> vol - 0x08; 5 -> vol - 0x10
        6 -> vol * 2 / 3
        7 -> vol shr 1
        9 -> vol + 0x01; 0xA -> vol + 0x02; 0xB -> vol + 0x04; 0xC -> vol + 0x08; 0xD -> vol + 0x10
        0xE -> vol * 3 / 2
        0xF -> vol shl 1
        else -> vol
    }.coerceIn(0, 0x3F)

    /** Effective playable row count for a cue: LEN and "halt at x" both shorten it. */
    private fun cueRowLimit(instr: PlayInstruction): Int = when (instr) {
        is PlayInstPatLen -> instr.rows
        is PlayInstHaltAt -> instr.rows
        else -> 64
    }

    private fun advanceTrackerCue(ts: TrackerState, playhead: Playhead) {
        val instr = cueSheet[ts.cuePos].instruction
        if (instr is PlayInstHalt || instr is PlayInstHaltAt) { playhead.isPlaying = false; return }
        ts.cuePos = when (instr) {
            is PlayInstGoBack -> (ts.cuePos - instr.arg).coerceAtLeast(0)
            is PlayInstSkip   -> (ts.cuePos + instr.arg).coerceAtMost(1023)
            is PlayInstJump   -> instr.arg.coerceIn(0, 1023)
            else              -> (ts.cuePos + 1).coerceAtMost(1023)
        }
        playhead.position = ts.cuePos
    }

    // Per-pattern voice state reset, called on every cue advance (B / C / natural end).
    //   - S$Bx pattern-loop counters (TAUD_NOTE_EFFECTS.md §S$Bx00).
    //   - Pattern-ditto (effect 7) destination range — the source block lives in the
    //     pattern we are leaving and must not bleed into the next one (§7).
    private fun resetPatternLoopState(ts: TrackerState) {
        for (voice in ts.voices) {
            voice.loopStartRow = 0
            voice.loopCount = 0
            voice.dittoActive = false
            voice.dittoSourceStart = 0
            voice.dittoLength = 0
            voice.dittoEndRow = 0
        }
    }

    internal fun generateTrackerAudio(playhead: Playhead): ByteArray? {
        val ts = playhead.trackerState ?: return null

        val out = ByteArray(TRACKER_CHUNK * 2)

        if (ts.firstRow) {
            ts.firstRow = false
            applyTrackerRow(ts, playhead)
        }

        for (n in 0 until TRACKER_CHUNK) {
            // Recompute samples-per-tick every iteration since T/T-slide can mutate BPM mid-row.
            val spt = SAMPLING_RATE * 2.5 / playhead.bpm
            ts.samplesIntoTick += 1.0
            if (ts.samplesIntoTick >= spt) {
                ts.samplesIntoTick -= spt
                applyTrackerTick(ts, playhead)
                ts.tickInRow++
                if (ts.tickInRow >= playhead.tickRate + ts.finePatternDelayExtra) {
                    ts.tickInRow = 0
                    advanceRow(ts, playhead)
                }
            }

            var mixL = 0.0
            var mixR = 0.0
            val gvol = playhead.globalVolume / 255.0
            val mvol = playhead.mixingVolume / 255.0
            for (voice in ts.voices) {
                if (!voice.active || voice.fader == 255) {
                    // Keep the soundscope flat between notes / while fully faded (incl. host mute)
                    // so the AudioMenu does not show stale waveform data once the voice goes silent.
                    voice.scopeBuffer[voice.scopeWritePos] = 0f
                    voice.scopeWritePos = (voice.scopeWritePos + 1) and (SCOPE_BUFFER_SIZE - 1)
                    continue
                }
                val voiceInst = instruments[voice.instrumentId]
                val s = applyTaudVoiceFx(voice, applyVoiceFilter(voice, fetchTrackerSample(voice, voiceInst, ts.interpolationMode)))
                val instGv = voiceInst.instGlobalVolume / 255.0
                // Volume swing bias (random per-trigger, ±randomVolBias of 0..255 units folded into the 0..63 row volume).
                val swingScale = 1.0 + voice.randomVolBias / 255.0
                // Per-sample envelope smoothing: walk envVolMix toward the tick-set
                // envVolume so the mixer sees a continuous slope instead of the per-tick
                // stair-step that produces clicks on steep envelope segments.
                voice.envVolMix += voice.envVolStep
                // Volume envelope is bypassed (treated as unity) when S $77 has disabled it.
                val effEnvVol = if (voice.volEnvOn) voice.envVolMix else 1.0
                // Anti-click ramp: smooths voleff/notefx-driven rowVolume steps. Key-on
                // triggers snap currentMixVolume to target (in triggerNote) so attacks
                // are passed through unramped.
                advanceVolumeRamp(voice)
                // External per-voice fader (0 = unity, 255 = silence). Folded into perVoiceGain
                // so the soundscope reflects what the user hears after the fader is applied.
                val faderGain = (255 - voice.fader) / 255.0
                // Split the gain stack so the soundscope can see the voice amplitude independently
                // of the playhead-wide faders (master / mixing / global volume).
                val perVoiceGain = effEnvVol * voice.fadeoutVolume * voice.currentMixVolume *
                                   swingScale * instGv * faderGain * voice.layerMixGain * voice.activeAttenGain
                val globalGain = gvol * mvol * playhead.masterVolume / 255.0
                val vol = perVoiceGain * globalGain
                val pan = if (voice.hasPanEnv && voice.panEnvOn) {
                    val envPanRaw = (voice.envPan * 255.0).roundToInt().coerceIn(0, 255)
                    (voice.channelPan + envPanRaw - 128 + voice.randomPanBias).coerceIn(0, 255)
                } else (voice.channelPan + voice.randomPanBias).coerceIn(0, 255)
                // equal-energy pan law
                val lGain = cos(PI * pan / 512.0)
                val rGain = sin(PI * pan / 512.0)
                // Sample-end ramp-out: snapshot gain, advance the ramp, deactivate at zero.
                val rampGain = if (voice.rampOutSamples > 0) {
                    val g = voice.rampOutGain
                    voice.rampOutGain -= voice.rampOutStep
                    voice.rampOutSamples--
                    if (voice.rampOutSamples == 0) voice.active = false
                    g
                } else 1.0
                // Per-voice soundscope capture — the voice's actual mono contribution before pan
                // and before the playhead-global faders. Includes envelope, fadeout, tremolo,
                // sample-end ramp-out and channel volume so the AudioMenu shows what the voice is
                // really doing, not the raw instrument sample.
                voice.scopeBuffer[voice.scopeWritePos] = (s * perVoiceGain * rampGain).toFloat()
                voice.scopeWritePos = (voice.scopeWritePos + 1) and (SCOPE_BUFFER_SIZE - 1)
                mixL += s * vol * lGain * rampGain
                mixR += s * vol * rGain * rampGain
            }
            // Background (NNA-ghost) voices — same per-sample mixing path as foreground, but
            // they live in a mixer-private pool that no row event can address.
            for (bg in ts.backgroundVoices) {
                if (!bg.active || bg.fader == 255) continue
                val bgInst = instruments[bg.instrumentId]
                val s = applyTaudVoiceFx(bg, applyVoiceFilter(bg, fetchTrackerSample(bg, bgInst, ts.interpolationMode)))
                val instGv = bgInst.instGlobalVolume / 255.0
                val swingScale = 1.0 + bg.randomVolBias / 255.0
                bg.envVolMix += bg.envVolStep
                val effEnvVol = if (bg.volEnvOn) bg.envVolMix else 1.0
                // Background voices don't receive new voleff/notefx events, but ghosting
                // can leave currentMixVolume mid-ramp from the foreground's last change —
                // keep advancing so the inherited ramp completes cleanly.
                advanceVolumeRamp(bg)
                // External fader snapshotted at ghost time (see ghostVoice). Subsequent host
                // changes to the source slot's fader don't affect already-ghosted voices.
                val faderGain = (255 - bg.fader) / 255.0
                val vol = effEnvVol * bg.fadeoutVolume * bg.currentMixVolume *
                          swingScale * gvol * mvol * instGv * faderGain * bg.layerMixGain * bg.activeAttenGain * playhead.masterVolume / 255.0
                val pan = if (bg.hasPanEnv && bg.panEnvOn) {
                    val envPanRaw = (bg.envPan * 255.0).roundToInt().coerceIn(0, 255)
                    (bg.channelPan + envPanRaw - 128 + bg.randomPanBias).coerceIn(0, 255)
                } else (bg.channelPan + bg.randomPanBias).coerceIn(0, 255)
                val lGain = cos(PI * pan / 512.0)
                val rGain = sin(PI * pan / 512.0)
                val rampGain = if (bg.rampOutSamples > 0) {
                    val g = bg.rampOutGain
                    bg.rampOutGain -= bg.rampOutStep
                    bg.rampOutSamples--
                    if (bg.rampOutSamples == 0) bg.active = false
                    g
                } else 1.0
                mixL += s * vol * lGain * rampGain
                mixR += s * vol * rGain * rampGain
            }

            // Amiga interpolation modes: post-mix LPF chain (matches pt2-clone Paula stage).
            // INTERP_A500 applies the 1-pole RC LPF (~4421 Hz). INTERP_A1200 has a cutoff
            // above Nyquist so its LPF is bypassed. The 2-pole "LED" filter (~3091 Hz, Q≈0.66)
            // is added on either Amiga mode when ts.ledFilterOn (S $0000 = on, S $0100 = off).
            // No-op for INTERP_DEFAULT and INTERP_NONE so non-Amiga modes pay no cost.
            when (ts.interpolationMode) {
                INTERP_A500 -> {
                    ts.amigaLPStateL = mixL * AMIGA_A500_A0 + ts.amigaLPStateL * AMIGA_A500_B1
                    ts.amigaLPStateR = mixR * AMIGA_A500_A0 + ts.amigaLPStateR * AMIGA_A500_B1
                    mixL = ts.amigaLPStateL
                    mixR = ts.amigaLPStateR
                    if (ts.ledFilterOn) {
                        val sl = ts.amigaLEDStateL; val sr = ts.amigaLEDStateR
                        val outL = mixL * AMIGA_LED_A1 + sl[0] * AMIGA_LED_A2 + sl[1] * AMIGA_LED_A1 - sl[2] * AMIGA_LED_B1 - sl[3] * AMIGA_LED_B2
                        val outR = mixR * AMIGA_LED_A1 + sr[0] * AMIGA_LED_A2 + sr[1] * AMIGA_LED_A1 - sr[2] * AMIGA_LED_B1 - sr[3] * AMIGA_LED_B2
                        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL
                        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR
                        mixL = outL; mixR = outR
                    }
                }
                INTERP_A1200 -> {
                    // A1200 1-pole LPF cutoff (~34 kHz) is above Nyquist at SAMPLING_RATE = 32 kHz,
                    // so it is bypassed (matches pt2_paula.c: useLowpassFilter = false).
                    if (ts.ledFilterOn) {
                        val sl = ts.amigaLEDStateL; val sr = ts.amigaLEDStateR
                        val outL = mixL * AMIGA_LED_A1 + sl[0] * AMIGA_LED_A2 + sl[1] * AMIGA_LED_A1 - sl[2] * AMIGA_LED_B1 - sl[3] * AMIGA_LED_B2
                        val outR = mixR * AMIGA_LED_A1 + sr[0] * AMIGA_LED_A2 + sr[1] * AMIGA_LED_A1 - sr[2] * AMIGA_LED_B1 - sr[3] * AMIGA_LED_B2
                        sl[1] = sl[0]; sl[0] = mixL; sl[3] = sl[2]; sl[2] = outL
                        sr[1] = sr[0]; sr[0] = mixR; sr[3] = sr[2]; sr[2] = outR
                        mixL = outL; mixR = outR
                    }
                }
            }

            ts.mixLeft[n]  = mixL.toFloat().coerceIn(-1.0f, 1.0f)
            ts.mixRight[n] = mixR.toFloat().coerceIn(-1.0f, 1.0f)
        }

        pcm32fToPcm8(ts.mixLeft, ts.mixRight, TRACKER_CHUNK)
        for (n in 0 until TRACKER_CHUNK) {
            out[n * 2]     = tadDecodedBin[n * 2L]
            out[n * 2 + 1] = tadDecodedBin[n * 2L + 1]
        }

        return out
    }

    /**
     * Advance to the next row. Resolves pending B/C jumps and pattern-delay repeats.
     * Called once when [TrackerState.tickInRow] has just wrapped past [Playhead.tickRate].
     */
    private fun advanceRow(ts: TrackerState, playhead: Playhead) {
        // Pattern delay (S$Ex): replay the same row patternDelayRemaining more times.
        if (ts.patternDelayRemaining > 0) {
            ts.patternDelayRemaining--
            ts.patternDelayActive = true
            applyTrackerRow(ts, playhead)
            return
        }
        ts.patternDelayActive = false

        val pendingB = ts.pendingOrderJump
        val pendingC = ts.pendingRowJump
        val pendingLocal = ts.pendingRowJumpLocal
        ts.pendingOrderJump = -1
        ts.pendingRowJump = -1
        ts.pendingRowJumpLocal = false

        when {
            pendingB >= 0 -> {
                ts.cuePos = pendingB.coerceAtMost(1023)
                ts.rowIndex = if (pendingC >= 0) pendingC else 0
                playhead.position = ts.cuePos
                resetPatternLoopState(ts)
            }
            pendingC >= 0 && pendingLocal -> {
                // S$Bx pattern loop — stay in the current cue, just rewind the row.
                ts.rowIndex = pendingC.coerceIn(0, 63)
            }
            pendingC >= 0 -> {
                // C$xx pattern break — advance order by one (or honour cue's own instruction), then jump to row.
                advanceTrackerCue(ts, playhead)
                ts.rowIndex = pendingC.coerceIn(0, 63)
                resetPatternLoopState(ts)
            }
            else -> {
                ts.rowIndex++
                // LEN / "halt at x" cue instructions shorten the effective row
                // count so the engine wraps to the next cue (or halts) early.
                // Patterns fed by the converter are still 64 rows long; rows past
                // `rowLimit` are silent padding that we skip here.
                val rowLimit = cueRowLimit(cueSheet[ts.cuePos].instruction)
                if (ts.rowIndex >= rowLimit) {
                    ts.rowIndex = 0
                    advanceTrackerCue(ts, playhead)
                    resetPatternLoopState(ts)
                }
            }
        }
        applyTrackerRow(ts, playhead)
    }

    internal data class PlayCue(
        val patterns: IntArray = IntArray(20) { 0xFFF },
        var instruction: PlayInstruction = PlayInstNop,
        var instByte30: Int = 0,
        var instByte31: Int = 0,
    ) {
        // Cue layout (32 bytes, 20 voices, 12-bit pattern numbers):
        //   bytes  0-9:  packed low nybbles  (byte i => voice i*2 in hi, voice i*2+1 in lo)
        //   bytes 10-19: packed mid nybbles  (same packing)
        //   bytes 20-29: packed high nybbles (same packing)
        //   byte  30:    instruction (low byte)
        //   byte  31:    instruction arg byte (used by 2-byte forms: LEN, BAK, FWD, JMP)
        // Decoding rules per terranmon.txt §"Cue Sheet":
        //   00000010 00xxxxxx (LEN)    pattern length: rows = (xxxxxx) + 1, range 1..64
        //   00000001 00000000 (HALT)   play the full pattern then stop
        //   00000001 01xxxxxx (HALT x) play x rows then stop (x = 0 ⇒ full length)
        //   00000000          (NOP)    default 64-row cue
        //   1000xxxx yyyyyyyy (BAK)    go back 12-bit arg
        //   1001xxxx yyyyyyyy (FWD)    skip forward 12-bit arg
        //   1111xxxx yyyyyyyy (JMP)    go to absolute cue (loop back to cue arg)
        private fun recomputeInstruction() {
            val b30 = instByte30
            val b31 = instByte31
            instruction = when {
                b30 == 0x02 -> PlayInstPatLen((b31 and 0x3F) + 1)
                // HALT family: arg byte 01xxxxxx ⇒ "halt at x" (play x rows; x = 0 ⇒
                // full length, identical to a plain HALT). Any other arg ⇒ plain HALT.
                b30 == 0x01 -> if ((b31 and 0xC0) == 0x40) {
                    val x = b31 and 0x3F
                    PlayInstHaltAt(if (x == 0) 64 else x)
                } else PlayInstHalt
                b30 == 0x00 -> PlayInstNop
                // BAK: 1000xxxx yyyyyyyy — 12-bit arg combining b30 low nybble + b31.
                (b30 and 0xF0) == 0x80 -> PlayInstGoBack(((b30 and 0xF) shl 8) or (b31 and 0xFF))
                // FWD: 1001xxxx yyyyyyyy — 12-bit arg.
                (b30 and 0xF0) == 0x90 -> PlayInstSkip(((b30 and 0xF) shl 8) or (b31 and 0xFF))
                // JMP: 1111xxxx yyyyyyyy — go to absolute cue 0bxxxxyyyyyyyy.
                (b30 and 0xF0) == 0xF0 -> PlayInstJump(((b30 and 0xF) shl 8) or (b31 and 0xFF))
                else -> PlayInstNop
            }
        }
        fun write(index: Int, byte: Int) = when (index) {
            in 0..9 -> {
                val b = index * 2
                patterns[b]     = (patterns[b]     and 0xFF0) or ((byte ushr 4) and 0xF)
                patterns[b + 1] = (patterns[b + 1] and 0xFF0) or (byte and 0xF)
            }
            in 10..19 -> {
                val b = (index - 10) * 2
                patterns[b]     = (patterns[b]     and 0xF0F) or (((byte ushr 4) and 0xF) shl 4)
                patterns[b + 1] = (patterns[b + 1] and 0xF0F) or ((byte and 0xF) shl 4)
            }
            in 20..29 -> {
                val b = (index - 20) * 2
                patterns[b]     = (patterns[b]     and 0x0FF) or (((byte ushr 4) and 0xF) shl 8)
                patterns[b + 1] = (patterns[b + 1] and 0x0FF) or ((byte and 0xF) shl 8)
            }
            30 -> { instByte30 = byte and 0xFF; recomputeInstruction() }
            31 -> { instByte31 = byte and 0xFF; recomputeInstruction() }
            else -> throw InternalError("Bad offset $index")
        }
        fun read(index: Int): Byte = when (index) {
            in 0..9 -> {
                val b = index * 2
                (((patterns[b] and 0xF) shl 4) or (patterns[b + 1] and 0xF)).toByte()
            }
            in 10..19 -> {
                val b = (index - 10) * 2
                ((((patterns[b] ushr 4) and 0xF) shl 4) or ((patterns[b + 1] ushr 4) and 0xF)).toByte()
            }
            in 20..29 -> {
                val b = (index - 20) * 2
                ((((patterns[b] ushr 8) and 0xF) shl 4) or ((patterns[b + 1] ushr 8) and 0xF)).toByte()
            }
            30 -> instByte30.toByte()
            31 -> instByte31.toByte()
            else -> throw InternalError("Bad offset $index")
        }
    }

    internal open class PlayInstruction(val arg: Int)
    internal class PlayInstGoBack(arg: Int) : PlayInstruction(arg)
    internal class PlayInstSkip(arg: Int) : PlayInstruction(arg)
    /** "JMP": go to absolute cue [arg]. Used by looping converters to jump back
     *  to the loop-start cue (e.g. midi2taud's whole-song / loop-marker loop). */
    internal class PlayInstJump(arg: Int) : PlayInstruction(arg)
    internal class PlayInstPatLen(val rows: Int) : PlayInstruction(rows)
    /** "Halt at x": play [rows] rows of the pattern (1..64) then stop. */
    internal class PlayInstHaltAt(val rows: Int) : PlayInstruction(rows)
    internal object PlayInstHalt : PlayInstruction(0)
    internal object PlayInstNop : PlayInstruction(0)

    /** Per-channel effect memory cohorts and private slots (TAUD_NOTE_EFFECTS.md §6). */
    class MemorySlots {
        // Shared E/F (pitch slide). Stores the raw arg; mode is recovered from arg layout.
        var ef: Int = 0
        // G (tone porta) — private speed.
        var g: Int = 0
        // Shared H/U vibrato — separate speed and depth fields persist across both.
        var huSpeed: Int = 0
        var huDepth: Int = 0
        // R (tremolo) — private speed and depth.
        var rSpeed: Int = 0
        var rDepth: Int = 0
        // Y (panbrello) — private speed and depth.
        var ySpeed: Int = 0
        var yDepth: Int = 0
        // Private slots
        var d: Int = 0
        var i: Int = 0
        var j: Int = 0
        var o: Int = 0
        var q: Int = 0
        var tslide: Int = 0
        var w: Int = 0
        // K, L, N, P: each its own private slot. K and L store the high-byte
        // (xy nibble pair) of the most recent non-zero argument; N and P
        // store the same high-byte and let the per-tick form recover via
        // identical decoding to D. (M has no recall — literal-zero — so no
        // slot is needed.)
        var k: Int = 0
        var l: Int = 0
        var n: Int = 0
        var p: Int = 0
    }

    class Voice {
        var active = false
        // Externally-controlled 256-step attenuator (MMIO 4098.., AudioJSR223Delegate.setVoiceFader).
        // 0 = unity, 255 = silence — and 255 is also the "mute" sentinel that setVoiceMute writes,
        // so there is only one piece of host-owned per-voice state. Not touched by row events /
        // tracker effects; survives note triggers because the host owns it. Cleared back to 0 only
        // by resetParams() (full playhead reset).
        var fader = 0
        var samplePos = 0.0
        var playbackRate = 1.0
        var forward = true
        var instrumentId = 0

        // -1 for live foreground voices held by TrackerState.voices[]; 0..19 for background
        // (mixer-private) ghosts spawned by NNA on the matching channel index.
        var sourceChannel = -1

        // ── Metainstrument layering ──
        // A meta trigger plays its first matching layer on the foreground voice and spawns
        // the remaining matching layers as background voices tagged [isLayerChild]. Each
        // tick those children re-sync pitch / key-off / volume / pan from their parent
        // foreground voice (ts.voices[sourceChannel]); [layerRelDetune] is the child's
        // 4096-TET offset relative to the parent (layer 0), so tone-portamento and slides
        // on the channel carry to every layer. [layerMixGain] is the per-layer static mix
        // multiplier (from the layer's mix-volume octet) applied in the mixer; it is set on
        // the foreground voice too (layer 0's gain) and defaults to 1.0 for normal notes.
        var isLayerChild = false
        var layerRelDetune = 0
        var layerMixGain = 1.0
        // -1 = use instrument-default NNA; otherwise overrides the next NNA event on this voice
        // (see S $73..$76). Cleared on every fresh trigger.
        var nnaOverride = -1
        // Per-voice envelope gates (S $77..$7E). When false the corresponding envelope is frozen
        // *and* its value is treated as unity by the mixer / pitch path. The pitch and filter
        // gates are independent so S$7B/$7C (pitch) and S$7D/$7E (filter) toggle them separately.
        var volEnvOn = true
        var panEnvOn = true
        var pitchEnvOn = true
        var filterEnvOn = true
        // True when this foreground voice was triggered as a metainstrument's layer 0. Drives the
        // S$70..$76 no-op and the S$77..$7E / notefx-5/6 fan-out across constituent layers. Always
        // false on ordinary-instrument voices and on layer-child ghosts. See TAUD_NOTE_EFFECTS.md S$7x.
        var metaForeground = false
        // Note-Fade NNA flag — triggers volume fadeout without sustain release (vs keyOff which
        // also breaks the volume envelope's sustain loop). Both paths feed the same fade decay.
        var noteFading = false

        // Two-volume model (TAUD_NOTE_EFFECTS.md §3): mix = sample × note_vol × channel_vol × …
        //   noteVolume    — per-note volume (analog of IT chan->volume). Reset on note re-trigger
        //                   from the instrument's Default Note Volume; written by vol-col SET / fine,
        //                   D / K / L vol slides, vol-col slides, Q retrig vol mod. Persists across
        //                   rows until the next re-trigger.
        //   channelVolume — per-channel volume (analog of IT chan->global_volume). Written by M / N.
        //                   NOT reset by note re-trigger — the channel keeps its base volume across
        //                   sample changes, mirroring IT's chan->global_volume semantics.
        //   rowVolume     — per-tick mixer-facing volume. Reset to noteVolume at the start of every
        //                   row, then modulated by tremolo / tremor / per-tick slides.
        // Mixer gain ≈ (rowVolume / 63) × (channelVolume / 63).
        var noteVolume    = 0x3F           // $00..$3F (default full)
        var channelVolume = 0x3F           // $00..$3F (default full)
        var rowVolume     = 63             // $00..$3F effective output volume after slides
        var channelPan = 0x80              // 8-bit; $80 centre. Cell column packs into 6-bit, S$80xx writes the full 8-bit.
        var rowPan = 32                    // 6-bit pan used by mixer, derived from channelPan

        // Anti-click volume ramp. The mixer feeds [currentMixVolume] (smoothed copy of
        // (rowVolume/63) × (channelVolume/63)) into the per-voice gain stack so that
        // voleff/notefx-driven steps (vol column, D slides, tremor, tremolo, retrig
        // vol-mod, fine slides) AND M / N channel-volume changes ramp across
        // [VOL_RAMP_SAMPLES] samples rather than jumping. triggerNote() arms
        // [snapMixVolume] so the next mixer sample re-syncs currentMixVolume to the
        // post-row target — bypassing the ramp on key-on attacks. The snap is deferred
        // (not applied inside triggerNote) because applyVolColumn and applyEffectRow
        // run *after* triggerNote in applyTrackerRow and may lower rowVolume on the
        // same row (e.g., a key-on with a low V column value); snapping immediately
        // in triggerNote would leave currentMixVolume at 1.0 and force a ramp-down
        // to the new low target, producing an audible transient spike.
        var currentMixVolume = 1.0
        var volRampSamples = 0
        var volRampStep = 0.0
        var snapMixVolume = false

        var keyOff = false
        var envIndex = 0
        var envTimeSec = 0.0
        var envVolume = 1.0
        // Per-sample smoothed copy of envVolume. advanceEnvelope() runs once per tick
        // (~640 samples at 125 BPM, 32 kHz) and overwrites envVolume with a stair-step
        // approximation of the linear interpolation between envelope nodes — between
        // ticks envVolume is held constant, so steep envelope slopes click audibly at
        // every tick boundary. The mixer feeds envVolMix to the gain stack instead;
        // applyTrackerTick computes envVolStep so envVolMix ramps linearly across the
        // upcoming tick interval and lands on the new envVolume by the next tick.
        // triggerNote snaps envVolMix to the fresh envVolume so attacks aren't smeared.
        var envVolMix = 1.0
        var envVolStep = 0.0
        var envPanIndex = 0
        var envPanTimeSec = 0.0
        var envPan = 0.5                   // 0.0=full-left, 1.0=full-right, 0.5=centre
        var hasPanEnv = false

        // Pitch and filter envelopes. The Taud instrument carries two pf-env slots
        // (base bytes 19.. and 197..); they are routed by their m-bit into the pitch
        // and filter roles here so SF2's single mod-env can drive both at once. IT/XM
        // instruments populate only one role (pitch XOR filter). Per-patch Ixmp 'P'/'f'
        // blocks override the corresponding role. 0.5 = unity (no shift / unmodulated cutoff).
        var hasPitchEnv = false
        var envPitchIndex = 0
        var envPitchTimeSec = 0.0
        var envPitchValue = 0.5
        var hasFilterEnv = false
        var envFilterIndex = 0
        var envFilterTimeSec = 0.0
        var envFilterValue = 0.5

        // Volume fadeout — engaged after key-off, decays to 0 at rate inst.volumeFadeoutLow.
        var fadeoutVolume = 1.0

        // MilkyTracker-style anti-click ramp-out. Engaged when a sample naturally ends
        // (loopMode 0/3 reaching sampleLen). Gain ramps from 1.0 → 0.0 over rampOutSamples
        // while the held last-sample value keeps being emitted; voice deactivates at 0.
        // Not engaged on note start — attack transients pass unsmoothed.
        var rampOutSamples = 0
        var rampOutGain    = 0.0
        var rampOutStep    = 0.0

        // Auto-vibrato (per-sample on the IT side, hoisted to the instrument here).
        var autoVibPhase = 0               // 8-bit phase counter
        var autoVibTicksSinceTrigger = 0   // for sweep ramp-up

        // Active-sample view — snapshot of either the base instrument's sample-scope
        // fields or, when an Ixmp patch covers (noteVal, rowVolume) at trigger time,
        // the matching TaudInstPatch overlay. Per-tick and per-row code reads from
        // these instead of `inst.*` so multi-sample (IT keyboard table) instruments
        // play the correct sample for the triggered note. Snapshotted by triggerNote
        // and the equivalent paths (Q retrigger, NNA ghosting).
        var activeSamplePtr        = 0
        var activeSampleLength     = 0
        var activeSamplePlayStart  = 0
        var activeSampleLoopStart  = 0
        var activeSampleLoopEnd    = 0
        var activeSamplingRate     = 0
        var activeSampleDetune     = 0     // signed 4096-TET
        var activeLoopMode         = 0     // bits 0-1 = direction, bit 2 = sustain (matches inst byte 14)
        var activeVibratoSpeed     = 0
        var activeVibratoSweep     = 0
        var activeVibratoDepth     = 0
        var activeVibratoRate      = 0
        var activeVibratoWaveform  = 0     // bits 0-2 only
        val activeSampleLoopSustain: Boolean get() = (activeLoopMode and 0x04) != 0

        // Active-envelope view — snapshot of the base instrument's envelopes or, when an
        // Ixmp patch overrides them (v/p/f/P/x blocks), the patch's. The advance / key-lift
        // / fadeout / filter code reads these instead of inst.* so per-patch SF2 ADSR works.
        // Set by [resolveActiveEnvelopes] from every trigger (alongside the active sample).
        var activeVolEnv: Array<TaudInstEnvPoint> = Array(25) { TaudInstEnvPoint(0x3F, ThreeFiveMiniUfloat(0)) }
        var activeVolEnvLoop = 0
        var activeVolEnvSustain = 0
        var activePanEnv: Array<TaudInstEnvPoint> = Array(25) { TaudInstEnvPoint(0x80, ThreeFiveMiniUfloat(0)) }
        var activePanEnvLoop = 0
        var activePanEnvSustain = 0
        var activePitchEnv: Array<TaudInstEnvPoint> = Array(25) { TaudInstEnvPoint(0x80, ThreeFiveMiniUfloat(0)) }
        var activePitchEnvLoop = 0
        var activePitchEnvSustain = 0
        var activeFilterEnv: Array<TaudInstEnvPoint> = Array(25) { TaudInstEnvPoint(0x80, ThreeFiveMiniUfloat(0)) }
        var activeFilterEnvLoop = 0
        var activeFilterEnvSustain = 0
        var activeFadeoutStep = 0          // combined 12-bit fadeout (base byte 172-173 or patch x)
        var activeDefaultCutoff = 0xFF
        var activeDefaultResonance = 0xFF
        // Filter interpretation mode (base byte 173 bit 4 / patch 'x' flag bit 0):
        //   false (IT) : activeDefaultCutoff/Resonance + currentCutoff/Resonance are IT bytes
        //                0..254 (255 = off); refreshVoiceFilter uses the IT cutoff/dmpfac maths.
        //   true  (SF) : they are 16-bit — cutoff = SoundFont absolute cents, resonance =
        //                centibels above DC gain (0xFFFF = off); refreshVoiceFilter uses the
        //                SF maths (freq = 8.176·2^(cents/1200), dmpfac = 10^(−Qcb/200)).
        var filterSfMode = false
        // SF2 initialAttenuation as a linear amplitude multiplier (1.0 = unity), resolved from
        // the active patch's 'x' block or the base instrument. Applied in the mixer alongside —
        // and independently of — velocity / channel volume / instGlobalVolume.
        var activeAttenGain = 1.0

        // NES 2A03 DMC counter for INTERP_NES_DPCM (interpolation mode 5).
        // 7-bit unsigned (0..127), slews ±2 per output sample as the sigma-delta
        // bitstream is generated on the fly. Seeded to mid-rail (63) on every
        // fresh trigger so the first sample doesn't have to slew ~30 ticks up
        // from 0 to reach a typical instrument's DC level.
        var nesDpcmCounter = 63

        // Filter / cutoff state — drives the per-voice 2-pole resonant LPF.
        // IT mode: 255 = off, 0..254 = IT 0..127 at double resolution.
        // SF mode (filterSfMode): cutoff = SoundFont absolute cents, resonance = centibels
        //   above DC gain (0xFFFF = off). See [refreshVoiceFilter].
        var currentCutoff = 0xFF
        var currentResonance = 0xFF
        // IT 2-pole IIR-only state (updated per output sample) and cached coefficients
        // (recomputed per tick when cutoff/resonance change). Recurrence:
        //   y[n] = A0 × x[n] + B0 × y[n-1] + B1 × y[n-2]
        var filterActive = false
        var filterA0 = 1.0
        var filterB0 = 0.0
        var filterB1 = 0.0
        var filterY1 = 0.0
        var filterY2 = 0.0
        // SoundFont mode uses a proper RBJ biquad low-pass (matching FluidSynth's
        // fluid_iir_filter, not the IT all-pole topology — see refreshVoiceFilter).
        // When true, applyVoiceFilter runs the biquad recurrence:
        //   y[n] = b02·(x[n]+x[n-2]) + b1·x[n-1] - a1·y[n-1] - a2·y[n-2]
        // sharing filterY1/Y2 as the output history and adding x[n-1]/x[n-2].
        var filterIsBiquad = false
        var filterBqB02 = 0.0
        var filterBqB1 = 0.0
        var filterBqA1 = 0.0
        var filterBqA2 = 0.0
        var filterX1 = 0.0
        var filterX2 = 0.0
        // Snapshot of cutoff/resonance the cached coefficients correspond to.
        var filterCutoffCached = -1
        var filterResonanceCached = -1

        // Per-trigger random offsets from RV / RP swing (added to base vol/pan).
        var randomVolBias = 0              // signed
        var randomPanBias = 0              // signed

        // Pitch state (4096-TET units, signed when slid).
        var noteVal = 0x0000               // The currently sounding base note (no per-row vibrato/arp added); 0 = none yet
        var basePitch = 0x4000             // Saved pre-effect pitch for vibrato/arp/glissando overlay
        // Amiga-mode period state, persisted across ticks so multi-tick E/F slides don't lose
        // sub-noteVal precision through repeated round-trip rounding (see amigaSlideTick).
        // -1.0 means "needs reseed from current noteVal".
        var amigaPeriod: Double = -1.0
        // Linear-frequency-mode state (Hz). Same -1.0 = stale convention as amigaPeriod.
        // Used by toneMode == 2 (MONOTONE compat) for E / F coarse slides and G tone porta.
        var linearFreq: Double = -1.0

        // Per-row effect state (set in applyTrackerRow, consumed by applyTrackerTick).
        var rowEffect = 0
        var rowEffectArg = 0
        var slideMode = 0                  // 0 = none, 1 = pitch coarse-down, 2 = pitch coarse-up, 3 = porta, 4 = vol-slide modes packed in slideArg
        var slideArg = 0                   // generic slide arg (volume nibbles or pitch units per tick)
        var tonePortaTarget = -1           // -1 if inactive
        var tonePortaSpeed = 0
        var arpOff1 = 0
        var arpOff2 = 0
        var arpActive = false
        var lastArpVoice = 0               // 0 / 1 / 2 — which arp voice we ended on (J-after-arp pitch carry)
        var tremorOn = 0                   // 0 = inactive, 1 = active row (use I args)
        var tremorOnTime = 1
        var tremorOffTime = 1
        var tremorPhaseOn = true
        var tremorTickInPhase = 0

        // Vibrato (H / U) — uses memHU.
        var vibratoActive = false
        var vibratoLfoPos = 0              // 8-bit phase
        var vibratoWave = 0                // 0..3
        var vibratoRetrig = true
        var vibratoFineShift = 6           // 6 for H, 8 for U

        // Tremolo (R) — uses memR.
        var tremoloActive = false
        var tremoloLfoPos = 0
        var tremoloWave = 0
        var tremoloRetrig = true

        // Panbrello (Y) — uses memY.
        var panbrelloActive = false
        var panbrelloLfoPos = 0
        var panbrelloWave = 0
        var panbrelloRetrig = true

        // Glissando flag (S$1x).
        var glissandoOn = false

        // Q retrigger.
        var retrigCounter = 0
        var retrigInterval = 0
        var retrigVolMod = 0
        var retrigActive = false

        // Note delay (S$Dx) — buffered trigger (-1 = no delay).
        var noteDelayTick = -1
        var delayedNote = 0
        var delayedInst = 0
        var delayedVol = -1

        // Note cut (S$Cx).
        var cutAtTick = -1
        var noteWasCut = false             // suppresses Q retrigger after cut

        // Funk repeat (S$Fx) — non-destructive bit XOR mask is per-instrument; per-channel state tracks accumulator + write pointer.
        var funkSpeed = 0                  // 0 = off
        var funkAccumulator = 0
        var funkWritePos = 0

        // Pattern loop (S$Bx) — per-channel state.
        var loopStartRow = 0
        var loopCount = 0

        // Pattern ditto (effect 7) — per-channel state. See TAUD_NOTE_EFFECTS.md §7.
        // dittoActive is the master gate; while true, rows in
        // [dittoSourceStart + dittoLength .. dittoEndRow] are expanded by copying
        // the cells from the source block (dittoSourceStart .. dittoSourceStart +
        // dittoLength − 1) and patching in any non-empty fields from the raw
        // destination cell. All four reset on cue advance (B / C / natural end).
        var dittoActive = false
        var dittoSourceStart = 0
        var dittoLength = 0
        var dittoEndRow = 0

        // Tempo slide (T $00xy) — per-channel because T is a per-channel effect, but we apply globally via playhead.
        var tempoSlideDir = 0              // 0 = none, -1 = down, +1 = up
        var tempoSlideAmount = 0

        // Global volume slide (W $xy00) — per-channel, applied to playhead.globalVolume on tick > 0.
        var wSlideDir = 0                  // 0 = none, -1 = down, +1 = up
        var wSlideAmount = 0

        // Volume / pan column slides (selectors 1/2/3 from TAUD_NOTE_EFFECTS.md §"Volume column effects").
        // These per-tick slides modify noteVolume (the per-note axis); N has its own accumulator
        // below because it modifies channelVolume (the per-channel axis) instead.
        var volColSlideUp = 0
        var volColSlideDown = 0
        var panColSlideRight = 0
        var panColSlideLeft = 0
        // N coarse slide: signed delta applied to channelVolume per non-first tick. Re-armed by
        // each N row, cleared at row start (along with the other slide accumulators).
        var nSlideDir = 0

        // Bitcrusher (effect 8) and Overdrive (effect 9) — Taud-only voice FX.
        // clipMode is shared between both effects: 0=clamp, 1=fold, 2=wrap. See TAUD_NOTE_EFFECTS.md §8/§9.
        var clipMode = 0
        // Bitcrusher: depth in 1..15 (0 = quantiser disabled; 8..15 are no-op for TSVM 8-bit output).
        var bitcrusherDepth = 0
        // Bitcrusher: sample-skip count. 0 = no skip, N = hold post-FX output for N additional samples.
        var bitcrusherSkip = 0
        var bitcrusherCounter = 0          // sample-rate-reduction counter, mod (skip + 1)
        var bitcrusherHeld = 0.0           // last emitted post-quantisation value, held when skipping
        // Overdrive: 0 = disabled. Otherwise gain = (16 + amp) / 16, range 17/16..271/16 (≈16.94×).
        var overdriveAmp = 0

        // Effect-recall memory for this voice.
        val mem = MemorySlots()

        // AudioMenu soundscope ring buffer. Holds the most recent post-FX, pre-pan voice
        // sample values for visualisation only — not consumed by the mixer. Size is a
        // power of two so the write-position wrap is a simple AND.
        val scopeBuffer = FloatArray(SCOPE_BUFFER_SIZE)
        var scopeWritePos = 0
    }

    class TrackerState {
        var cuePos = 0
        var rowIndex = 0
        var tickInRow = 0
        var samplesIntoTick = 0.0
        var firstRow = true
        val voices = Array(20) { Voice() }

        // Global mixer config (effect 1). Panning law is fixed to the equal-energy.
        // Tone-slide mode for E / F / G effects (terranmon.txt §Song Table flags byte):
        //   0 = linear pitch slides (4096-TET units, default)
        //   1 = Amiga period slides (raw PT period units, applied in period space)
        //   2 = linear-frequency slides (Hz/tick — MONOTONE compat)
        //   3 = reserved
        var toneMode = 0

        // Interpolation mode (TAUD_NOTE_EFFECTS.md §1, bits 2-4 of global behaviour flags).
        // 0=Fast Sinc default, 1=none, 2=Amiga 500, 3=Amiga 1200, 4=SNES 4-tap gaussian,
        // 5=NES 2A03 DPCM simulation. See AudioAdapter.INTERP_*.
        var interpolationMode = INTERP_DEFAULT
        // Amiga "LED" 2-pole LPF on/off (S $0000 = on, S $0100 = off; PT E00/E01).
        // Only applies when interpolationMode is INTERP_A500 or INTERP_A1200.
        var ledFilterOn = false

        // Per-playhead Amiga filter state.  Live on the post-mix stereo bus so voice
        // come/go does not reset filter history.  All zeroed on resetParams().
        var amigaLPStateL = 0.0
        var amigaLPStateR = 0.0
        // 2-pole biquad delay line: [in_z1, in_z2, out_z1, out_z2] for L and R.
        val amigaLEDStateL = DoubleArray(4)
        val amigaLEDStateR = DoubleArray(4)

        // Pending row-end events (set during a row by B/C; consumed at row end).
        var pendingOrderJump = -1          // -1 = none; otherwise the order index to jump to
        var pendingRowJump = -1            // -1 = none; otherwise the row index for the next pattern
        // Distinguishes S$Bx pattern-loop (stays in current cue) from C$xx pattern-break (advances cue).
        var pendingRowJumpLocal = false

        // Pattern-delay state (S$Ex) — number of additional row-repetitions remaining.
        var patternDelayRemaining = 0
        var patternDelayActive = false     // true while inside a delay block (gates SBx decrement)

        // Channel index of the SEx that won this row (lowest channel wins ties).
        var sexWinningChannel = -1

        // Fine pattern delay (S$6x) — extra ticks added to the current row; accumulated across all channels.
        var finePatternDelayExtra = 0

        // Pre-allocated mix buffers for dither path (reused each audio chunk).
        val mixLeft  = FloatArray(TRACKER_CHUNK)
        val mixRight = FloatArray(TRACKER_CHUNK)

        // Mixer-private background voices: NNA-ghosted copies of displaced foreground voices.
        // Not addressable from row events; only S $70..$72 and the mixer/per-tick maintenance
        // touch them. ArrayDeque so we can evict oldest (head) when the pool is full.
        val backgroundVoices = ArrayDeque<Voice>()
    }

    class Playhead(
        internal val parent: AudioAdapter,
        val index: Int,

        var position: Int = 0,
        var pcmUploadLength: Int = 0,
        var masterVolume: Int = 0,
        var masterPan: Int = 128,
//        var samplingRateMult: ThreeFiveMiniUfloat = ThreeFiveMiniUfloat(32),
        var bpm: Int = 125,                // BPM, derived from tempoByte + 25. Spec default $64 ⇒ 125 BPM.
        var tickRate: Int = 6,
        var pcmUpload: Boolean = false,
        var patBank1: Int = 0,
        var patBank2: Int = 0,
        var globalVolume: Int = 0x80,      // 8-bit, default $80 (spec §5). Mutated by V $xx00.
        var mixingVolume: Int = 0x80,      // 8-bit, default $80 (spec §5). Final-mix scaler, set once per song.

        var pcmQueue: Queue<ByteArray> = Queue<ByteArray>(),
        var pcmQueueSizeIndex: Int = 0,
        val audioDevice: OpenALBufferedAudioDevice,
    ) {
        fun updateTrackerGlobalBehaviour(flags: Int) {
            trackerState?.let { ts ->
                ts.toneMode = flags and 3
                ts.interpolationMode = (flags ushr 2) and 7
            }
        }

        var trackerState: TrackerState? = TrackerState()  // default mode is tracker (isPcmMode=false)

        // Initial global behaviour flags (song-table byte, written via MMIO register 7 in tracker mode).
        // Applied to TrackerState on every resetParams(); in-pattern effect '1' can override later.
        var initialGlobalFlags: Int = 0

        // flags
        var isPcmMode: Boolean = false
            set(value) {
                if (value != field) {
                    resetParams()
                    trackerState = if (!value) TrackerState() else null
                }
                field = value
            }
        var isPlaying: Boolean = false
            set(value) {
                // play last bit from the buffer by feeding 0s
                if (field && !value) {
//                    println("!! inserting dummy bytes")
                    if (isPcmMode) {
                        pcmQueue.addLast(ByteArray(audioDevice.bufferSize * audioDevice.bufferCount))
                    }
                }
                field = value
            }

        fun read(index: Int): Byte = when (index) {
            0 -> position.toByte()
            1 -> position.ushr(8).toByte()
            2 -> if (isPcmMode) pcmUploadLength.toByte() else patBank1.toByte()
            3 -> if (isPcmMode) pcmUploadLength.ushr(8).toByte() else patBank2.toByte()
            4 -> masterVolume.toByte()
            5 -> masterPan.toByte()
            6 -> (isPcmMode.toInt(7) or isPlaying.toInt(4) or pcmQueueSizeIndex.and(15)).toByte()
            7 -> initialGlobalFlags.toByte()
            8 -> (bpm - 25).toByte()
            9 -> tickRate.toByte()
            else -> throw InternalError("Bad offset $index")
        }

        fun write(index: Int, byte: Int) {
            val byte = byte and 255
            when (index) {
                0 -> if (!isPcmMode) { position = (position and 0xff00) or byte; trackerState?.cuePos = position } else {}
                1 -> if (!isPcmMode) { position = (position and 0x00ff) or (byte shl 8); trackerState?.cuePos = position } else {}
                2 -> if (isPcmMode) { pcmUploadLength = (pcmUploadLength and 0xff00) or byte } else { patBank1 = byte and 0x1F }
                3 -> if (isPcmMode) { pcmUploadLength = (pcmUploadLength and 0x00ff) or (byte shl 8) } else { patBank2 = byte and 0x1F }
                4 -> {
                    masterVolume = byte
                    audioDevice.setVolume(masterVolume / 255f)
                }
                5 -> { masterPan = byte }
                6 -> { byte.let {
                    isPcmMode = (it and 0b10000000) != 0
                    if (it and 0b01000000 != 0) resetParams()
                    isPlaying = (it and 0b00010000) != 0
                    pcmQueueSizeIndex = (it and 0b00001111)
                    if (it and 0b00100000 != 0) purgeQueue()
                } }
                7 -> if (isPcmMode) { pcmUpload = true } else {
                    initialGlobalFlags = byte
                    updateTrackerGlobalBehaviour(initialGlobalFlags)
                }
                8 -> { bpm = byte + 25 }
                9 -> { tickRate = byte }
                else -> throw InternalError("Bad offset $index")
            }
        }

        /*fun getSamplingRate() = 30000 - ((bpm - 25).and(255) or tickRate.and(255).shl(8)).toShort().toInt()
        fun setSamplingRate(rate: Int) {
            val rateDiff = (rate.coerceIn(0, 95535) - 30000).toShort().toInt()
            bpm = rateDiff.and(255) + 25
            tickRate = rateDiff.ushr(8).and(255)
        }*/

        fun resetParams() {
            position = 0
            pcmUploadLength = 0
            isPlaying = false
            pcmQueueSizeIndex = 2
            // Spec §5 defaults — applied on every reset so song-start state is well-defined.
            bpm = 125
            tickRate = 6
            globalVolume = 0x80
            mixingVolume = 0x80
            trackerState?.let { ts ->
                ts.cuePos = 0; ts.rowIndex = 0; ts.tickInRow = 0
                ts.samplesIntoTick = 0.0; ts.firstRow = true
                ts.pendingOrderJump = -1; ts.pendingRowJump = -1
                ts.pendingRowJumpLocal = false
                ts.patternDelayRemaining = 0; ts.patternDelayActive = false
                ts.sexWinningChannel = -1
                ts.finePatternDelayExtra = 0
                ts.toneMode = initialGlobalFlags and 3
                ts.interpolationMode = (initialGlobalFlags ushr 2) and 7
                ts.ledFilterOn = false
                ts.amigaLPStateL = 0.0; ts.amigaLPStateR = 0.0
                ts.amigaLEDStateL.fill(0.0); ts.amigaLEDStateR.fill(0.0)
                ts.voices.forEach {
                    it.active = false
                    it.noteVolume = 0x3F
                    it.channelVolume = 0x3F
                    it.rowVolume = 0x3F
                    it.currentMixVolume = 1.0
                    it.volRampSamples = 0
                    it.volRampStep = 0.0
                    it.snapMixVolume = false
                    it.envVolMix = 1.0
                    it.envVolStep = 0.0
                    it.channelPan = 0x80
                    it.rowPan = 32
                    it.glissandoOn = false
                    it.loopStartRow = 0
                    it.loopCount = 0
                    it.dittoActive = false
                    it.dittoSourceStart = 0
                    it.dittoLength = 0
                    it.dittoEndRow = 0
                    it.funkSpeed = 0
                    it.funkAccumulator = 0
                    it.funkWritePos = 0
                    it.fader = 0
                    it.nnaOverride = -1
                    it.volEnvOn = true; it.panEnvOn = true; it.pitchEnvOn = true; it.filterEnvOn = true
                    it.metaForeground = false
                    it.noteFading = false
                    it.layerMixGain = 1.0; it.isLayerChild = false; it.layerRelDetune = 0
                    // "What's playing" state — must be cleared alongside the volume reset
                    // above, otherwise a voice can carry a stale instrumentId from a prior
                    // session into a freshly-reset volume slot. Concretely: end of session
                    // leaves voice.instrumentId = N from the last retrigger; resetParams
                    // (run on session exit and re-entry) clears channelVolume back to 0x3F
                    // but used to leave instrumentId = N. The next session's first play of
                    // a row carrying note + porta + no instrument byte then triggers
                    // instruments[N] (a real sample) at the porta-target pitch with
                    // channelVolume = 0x3F — the unreeeal_superhero_3.taud cue-0 ch7/ch8
                    // "loud wrong note" symptom. triggerNote already reseeds these on a
                    // row carrying an instrument byte, so the asymmetry was only audible
                    // for the run of porta-only rows preceding the first inst-byte row.
                    it.instrumentId = 0
                    it.samplePos = 0.0
                    it.playbackRate = 1.0
                    it.forward = true
                    it.keyOff = false
                    it.envIndex = 0; it.envTimeSec = 0.0; it.envVolume = 1.0
                    it.envPanIndex = 0; it.envPanTimeSec = 0.0; it.envPan = 0.5
                    it.hasPanEnv = false
                    it.envPitchIndex = 0; it.envPitchTimeSec = 0.0; it.envPitchValue = 0.5
                    it.envFilterIndex = 0; it.envFilterTimeSec = 0.0; it.envFilterValue = 0.5
                    it.hasPitchEnv = false; it.hasFilterEnv = false
                    it.fadeoutVolume = 1.0
                    it.rampOutSamples = 0; it.rampOutGain = 0.0; it.rampOutStep = 0.0
                    it.noteVal = 0x0000; it.basePitch = 0x4000
                    it.amigaPeriod = -1.0; it.linearFreq = -1.0
                    it.tonePortaTarget = -1; it.tonePortaSpeed = 0
                    it.filterY1 = 0.0; it.filterY2 = 0.0; it.filterX1 = 0.0; it.filterX2 = 0.0
                    it.filterCutoffCached = -1; it.filterResonanceCached = -1
                    it.currentCutoff = 0xFF; it.currentResonance = 0xFF
                    it.nesDpcmCounter = 63
                }
                ts.backgroundVoices.clear()
                // Funk repeat (S$Fx): drop every per-instrument inversion mask so that
                // stop-and-replay starts from a clean cue-initial state. The masks accumulate
                // within a single playback (matching PT2's destructive-but-stable behaviour);
                // here we snapshot back to "no inversions yet" so a fresh play is reproducible
                // without needing to reload the song from disk.
                // notefx 5/6 cutoff/resonance overrides are likewise per-instrument runtime
                // state — clear them so a replay (or song loop) starts from the file defaults.
                parent.instruments.forEach { it.funkMask = null; it.cutoffOverride = -1; it.resonanceOverride = -1 }
            }
        }

        /** Clear funk-repeat (S$Fx) state only — per-voice run-state plus the per-instrument
         *  loop-inversion masks — without touching tempo / volume / position. taut calls this on
         *  every fresh play-from-start so accumulated inversions and a stale funkSpeed don't bleed
         *  from a prior session into the replay; full resetParams would also clobber bpm / tickRate /
         *  volume, which a replay must preserve. Masks still persist across a natural song loop. */
        fun resetFunkState() {
            trackerState?.voices?.forEach {
                it.funkSpeed = 0
                it.funkAccumulator = 0
                it.funkWritePos = 0
            }
            parent.instruments.forEach { it.funkMask = null }
        }

        fun purgeQueue() {
            pcmQueue.clear()
            if (isPcmMode) {
                position = 0
                pcmUploadLength = 0
            }
        }
        
        fun getPcmQueueCapacity() = QUEUE_SIZE[pcmQueueSizeIndex]

        fun dispose() {
            // audioDevice.dispose() is called by RenderRunnable.stop()
            System.err.println("AudioDevice dispose ${parent.renderThreads[index]}")
            try { audioDevice.dispose() } catch (e: GdxRuntimeException) { System.err.println("   "+ e.message) }
        }
        
        companion object {
            val QUEUE_SIZE = intArrayOf(4,6,8,12,16,24,32,48,64,96,128,192,256,384,512,768)
        }
    }

    data class TaudPlayData(
        var note: Int, // 0..65535
        var instrment: Int, // 0..255
        var volume: Int, // 0..63
        var volumeEff: Int, // 0..3
        var pan: Int, // 0..63
        var panEff: Int, // 0..3
        var effect: Int, // 0..255
        var effectArg: Int // 0..65535
    ) {
        fun getByte(offset: Int): Byte = when (offset) {
            0 -> note.toByte()
            1 -> note.ushr(8).toByte()
            2 -> instrment.toByte()
            3 -> (volume or volumeEff.shl(6)).toByte()
            4 -> (pan or panEff.shl(6)).toByte()
            5 -> effect.toByte()
            6 -> effectArg.toByte()
            7 -> effectArg.ushr(8).toByte()
            else -> throw InternalError("Bad offset $offset")
        }

        fun setByte(offset: Int, byte: Int) = when (offset) {
            0 -> { note = note.and(0xff00) or byte }
            1 -> { note = note.and(0x00ff) or byte.shl(8) }
            2 -> { instrment = byte }
            3 -> { volume = byte.and(63); volumeEff = byte.ushr(6).and(3) }
            4 -> { pan = byte.and(63); panEff = byte.ushr(6).and(3) }
            5 -> { effect = byte }
            6 -> { effectArg = effectArg.and(0xff00) or byte }
            7 -> { effectArg = effectArg.and(0x00ff) or byte.shl(8) }
            else -> throw InternalError("Bad offset $offset")
        }

    }

    data class TaudInstEnvPoint(var value: Int, var offset: ThreeFiveMiniUfloat)

    /**
     * One Ixmp "extra sample" patch — overlays sample-scope state on a base instrument
     * for a (noteVal, rowVolume) rectangle. See terranmon.txt "Ixmp. Instrument extra
     * samples" for the on-wire layout. Sample-scope fields always override; the optional
     * v / p / f / P / x blocks (since 2026-06-13) additionally override the base
     * instrument's volume / pan / filter / pitch envelopes and fadeout+cutoff+resonance.
     * Any block left absent (null env / hasExtra == false) defers to the base TaudInst,
     * along with NNA / DCT / DCA, pitch-pan, IGV and other instrument-scope fields.
     *
     * Sentinels: defaultPan == 0xFF, defaultNoteVolume == 0, vibratoWaveform == 0xFF
     * all mean "inherit the base instrument's value". samplingRate == 0 would silence
     * the patch (same semantics as base inst), so converters must always supply it.
     */
    data class TaudInstPatch(
        val pitchStart: Int,
        val pitchEnd: Int,
        val volumeStart: Int,
        val volumeEnd: Int,
        val samplePtr: Int,
        val sampleLength: Int,
        val playStart: Int,
        val loopStart: Int,
        val loopEnd: Int,
        val samplingRate: Int,
        val sampleDetune: Int,            // signed 4096-TET
        val loopMode: Int,                // matches base inst byte 14 (bits 0-1 = mode, bit 2 = sustain)
        val defaultPan: Int,              // 0..255; 0xFF = no override
        val defaultNoteVolume: Int,       // 0..255 IT-scaled; 0 = no override
        val vibratoSpeed: Int,
        val vibratoSweep: Int,
        val vibratoDepth: Int,
        val vibratoRate: Int,
        val vibratoWaveform: Int,         // 0..7; 0xFF = no override
        // Optional per-patch envelope/scalar overrides (null/false = defer to base inst).
        // Each env carries its own LOOP and SUSTAIN words (same encoding as the base inst).
        val volEnv: Array<TaudInstEnvPoint>? = null,   // 'v' block
        val volEnvLoop: Int = 0,
        val volEnvSustain: Int = 0,
        val panEnv: Array<TaudInstEnvPoint>? = null,   // 'p' block
        val panEnvLoop: Int = 0,
        val panEnvSustain: Int = 0,
        val filterEnv: Array<TaudInstEnvPoint>? = null,// 'f' block → drives cutoff
        val filterEnvLoop: Int = 0,
        val filterEnvSustain: Int = 0,
        val pitchEnv: Array<TaudInstEnvPoint>? = null, // 'P' block → drives pitch
        val pitchEnvLoop: Int = 0,
        val pitchEnvSustain: Int = 0,
        val hasExtra: Boolean = false,                 // 'x' block present
        val fadeoutStep: Int = 0,                      // combined 12-bit fadeout
        val filterSfMode: Boolean = false,             // 'x' flag bit 0: false = IT, true = SoundFont
        val extraCutoff: Int = 0xFF,                   // default cutoff — IT byte (255=off) or 16-bit SF cents (0xFFFF=off)
        val extraResonance: Int = 0xFF,                // default resonance — IT byte (255=off) or 16-bit SF centibels (0xFFFF=off)
        val extraInitialAttenOctet: Int = 0            // 'x' block per-patch initialAttenuation (dB-table octet; 0 = unity sentinel)
    ) {
        val sampleLoopSustain: Boolean get() = (loopMode and 0x04) != 0
    }

    /**
     * One layer of a Metainstrument (terranmon.txt "Metainstrument definition").
     * References a NORMAL instrument sounded simultaneously with the other layers,
     * gated by its (pitch × volume) rectangle, pitch-shifted by [detune] (added to
     * the trigger noteVal) and mixed at [mixOctet] (Perceptually-Significant-Octet
     * dB; 159 = unity). The raw octet is kept; the engine converts it to a linear
     * gain via [META_MIX_GAIN] at trigger time. */
    data class MetaLayer(
        val instIdx: Int,
        val mixOctet: Int,
        val detune: Int,            // signed 4096-TET
        val pitchStart: Int,
        val pitchEnd: Int,
        val volStart: Int,
        val volEnd: Int,
    )

    /**
     * 256-byte instrument record (terranmon.txt:2001+).
     *
     * Envelopes have FOUR independent regions per envelope (vol/pan/pf):
     *   - 25 envelope nodes (offsets 21 / 71 / 121).
     *   - LOOP word     (offsets 15 / 17 / 19) — always-active wrap region.
     *   - SUSTAIN word  (offsets 189 / 191 / 193) — wrap region active ONLY
     *                   while key is on; released on key-off.
     *
     * Priority during playback (matches schismtracker player/sndmix.c:480-499):
     *   if SUSTAIN.b == 1 and !key_off : wrap (sus_start, sus_end)
     *   elif LOOP.b == 1               : wrap (loop_start, loop_end)
     *   else                           : hold at last node
     *
     * Layout:
     *   0..3   u32 sample pointer
     *   4..5   u16 sample length
     *   6..7   u16 sampling rate at Middle C (0x5000)
     *   8..9   u16 play start
     *   10..11 u16 loop start
     *   12..13 u16 loop end
     *   14     u8  sample flags (low 2 bits = loop mode 0..3)
     *   15..16 u16 volume envelope LOOP word    (0b 0000_0sss_ss0cb_eeeee)
     *   17..18 u16 panning envelope LOOP word   (0b 0000_0sss_ssp_cb_eeeee, p=use-default-pan)
     *   19..20 u16 pitch/filter envelope LOOP word (0b 0000_0sss_ssm_cb_eeeee, m=mode)
     *   21..70  Bit16×25 volume envelope points
     *   71..120 Bit16×25 panning envelope points
     *   121..170 Bit16×25 pitch/filter envelope points
     *   171    u8 instrument global volume
     *   172    u8 volume fadeout low bits
     *   173    u8 fadeout high bits (low nibble; 0b 0000 ffff)
     *   174    u8 volume swing
     *   175    u8 vibrato speed
     *   176    u8 vibrato sweep
     *   177    u8 default pan
     *   178..179 u16 pitch-pan centre
     *   180    s8 pitch-pan separation
     *   181    u8 pan swing
     *   182    u8 default cutoff
     *   183    u8 default resonance
     *   184..185 u16 sample detune (signed)
     *   186    u8 instrument flag (NNA bits 0-1, vib waveform bits 2-4)
     *   187    u8 vibrato depth
     *   188    u8 vibrato rate
     *   189..190 u16 volume envelope SUSTAIN word   (0b 0000_0sss_ss00b_eeeee)
     *   191..192 u16 panning envelope SUSTAIN word
     *   193..194 u16 pitch/filter envelope SUSTAIN word
     *   195    u8 duplicate-check / action (relocated from old offset 189)
     *                  bits 0-1 = DCT, bits 2-3 = DCA
     *   196    u8 default note volume (0..255 → 0..63 on read).
     *                  Per-trigger seed for rowVolume when the row carries
     *                  a fresh note + instrument byte but no V column. 0
     *                  means "legacy file, fall back to 0x3F" (pre-2026-05-09
     *                  files folded sample.vol into IGV instead).
     *   197..255 reserved (59 bytes)
     */
    data class TaudInst(
        var index: Int,

        var samplePtr: Int,
        var sampleLength: Int,
        var samplingRate: Int,
        var samplePlayStart: Int,
        var sampleLoopStart: Int,
        var sampleLoopEnd: Int,
        var loopMode: Int,
        var volEnvLoop: Int,                // bytes 15-16 (LOOP word)
        var panEnvLoop: Int,                // bytes 17-18
        var pfEnvLoop: Int,                 // bytes 19-20
        var instGlobalVolume: Int,
        var volEnvelopes: Array<TaudInstEnvPoint>,
        var panEnvelopes: Array<TaudInstEnvPoint>,
        var pfEnvelopes: Array<TaudInstEnvPoint>,
        var volumeFadeoutLow: Int,
        var fadeoutHigh: Int,
        var volumeSwing: Int,
        var vibratoSpeed: Int,
        var vibratoSweep: Int,
        var defaultPan: Int,
        var pitchPanCentre: Int,
        var pitchPanSeparation: Int,
        var panSwing: Int,
        var defaultCutoff: Int,
        var defaultResonance: Int,
        var sampleDetune: Int,
        var instrumentFlag: Int,
        var vibratoDepth: Int,
        var vibratoRate: Int,
        var volEnvSustainWord: Int,         // bytes 189-190 (SUSTAIN word)
        var panEnvSustainWord: Int,         // bytes 191-192
        var pfEnvSustainWord: Int,          // bytes 193-194
        var dupCheckFlag: Int,              // byte 195 (relocated from 189)
        var defaultNoteVolume: Int,         // byte 196 — per-trigger rowVolume default
        // 2nd pitch/filter envelope (bytes 197-250) — the mandatory complement of the
        // byte 19.. pf-env (one pitch, one filter). Lets SF2's single modulation
        // envelope drive both targets at once; IT/XM leave this absent (LOOP-word P=0).
        var pf2EnvLoop: Int,                // bytes 197-198 (LOOP word, m-bit complements byte 19)
        var pf2EnvSustainWord: Int,         // bytes 199-200
        var pf2Envelopes: Array<TaudInstEnvPoint>  // bytes 201-250
    ) {
        constructor(index: Int) : this(
            index, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF,
            Array(25) { TaudInstEnvPoint(0x3F, ThreeFiveMiniUfloat(0)) },
            Array(25) { TaudInstEnvPoint(0x80, ThreeFiveMiniUfloat(0)) },
            Array(25) { TaudInstEnvPoint(0x80, ThreeFiveMiniUfloat(0)) },
            0, 0, 0, 0, 0, 0x80, 0x5000, 0, 0, 0xFF, 0,
            0, 0, 0, 0, 0, 0, 0, 0,
            0,
            0, 0,
            Array(25) { TaudInstEnvPoint(0x80, ThreeFiveMiniUfloat(0)) }
        )

        /** Sample-flag byte 14 bit 2 — when set, the sample loop is a sustain loop:
         *  it loops while the note is held and is escaped on key-off. */
        val sampleLoopSustain: Boolean get() = (loopMode and 0x04) != 0
        /** Key Lift — instrumentFlag bit 5 (terranmon byte 186, NNA pattern 0b100).
         *  MIDI-exact key release: on key-off the volume-envelope playhead jumps
         *  straight to the sustain-end node so the post-sustain (release) nodes
         *  play immediately, instead of IT's walk through the remaining
         *  hold/decay nodes first. See [applyKeyLift]. */
        val nnaKeyLift: Boolean get() = (instrumentFlag ushr 5) and 1 != 0
        /** New note action — instrumentFlag bits 0-1.
         *  0=note off, 1=note cut, 2=continue, 3=note fade. */
        val newNoteAction: Int get() = instrumentFlag and 0x03
        /** Auto-vibrato waveform — instrumentFlag bits 2-4.
         *  0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (FT2). */
        val vibratoWaveform: Int get() = (instrumentFlag ushr 2) and 0x07
        /** Sample detune as a signed 4096-TET delta. */
        val sampleDetuneSigned: Int get() = sampleDetune.toShort().toInt()
        /** Duplicate Check Type — 0=off, 1=note, 2=sample, 3=instrument (IT semantics). */
        val duplicateCheckType: Int get() = dupCheckFlag and 0x03
        /** Duplicate Check Action — 0=note cut, 1=note off, 2=note fade. */
        val duplicateCheckAction: Int get() = (dupCheckFlag ushr 2) and 0x03

        /** Filter interpretation mode — byte 173 bit 4 (`0b 000m_ffff`). false = ImpulseTracker
         *  (8-bit cutoff/resonance in bytes 182/183), true = SoundFont (16-bit: cutoff cents in
         *  byte 182<<8|252, resonance centibels in byte 183<<8|253). See [refreshVoiceFilter]. */
        val filterSfMode: Boolean get() = (fadeoutHigh ushr 4) and 1 != 0
        // Runtime cutoff / resonance overrides set by notefx 5 / 6 (Filter Cutoff/Resonance
        // Control, TAUD_NOTE_EFFECTS.md §"5/6"). -1 = no override (use the loaded default).
        // Stored in the active filter mode's native units (IT: 8-bit byte; SF: 16-bit cents /
        // centibels) so the *16 getters can return them verbatim. notefx 5/6 $FFFF clears the
        // override back to -1, restoring the loaded default. The effect is instrument-wide: every
        // note that shares this instrument reads these through [defaultCutoff16]/[defaultResonance16].
        var cutoffOverride: Int = -1
        var resonanceOverride: Int = -1

        /** Default cutoff resolved for the active filter mode: 8-bit IT byte, or the 16-bit
         *  SF absolute-cents value (high byte 182, low byte 252). A notefx-5 override wins. */
        val defaultCutoff16: Int get() =
            if (cutoffOverride >= 0) cutoffOverride
            else if (filterSfMode) ((defaultCutoff and 0xFF) shl 8) or (reserved[1].toInt() and 0xFF) else defaultCutoff
        /** Default resonance resolved for the active filter mode: 8-bit IT byte, or the 16-bit
         *  SF centibel value (high byte 183, low byte 253). A notefx-6 override wins. */
        val defaultResonance16: Int get() =
            if (resonanceOverride >= 0) resonanceOverride
            else if (filterSfMode) ((defaultResonance and 0xFF) shl 8) or (reserved[2].toInt() and 0xFF) else defaultResonance

        // Reserved padding at offsets 251..255 (5 bytes per instrument). Bytes
        // 197..250 are now the 2nd pf-envelope (pf2EnvLoop/pf2EnvSustainWord/pf2Envelopes).
        private val reserved = ByteArray(5)

        // Optional Ixmp "extra sample" patches — non-null when an Ixmp block was uploaded
        // for this instrument. Patches are scanned in order at trigger time; first hit on
        // (noteVal, rowVolume) wins (overlapping rectangles are INVALID per spec).
        var extraPatches: Array<TaudInstPatch>? = null

        /** Walk [extraPatches] and return the first patch whose pitch+volume rectangle
         *  contains the given trigger. Returns null when no patches are bound or none match. */
        fun resolvePatch(noteVal: Int, rowVolume: Int): TaudInstPatch? {
            val patches = extraPatches ?: return null
            for (p in patches) {
                if (noteVal in p.pitchStart..p.pitchEnd &&
                    rowVolume in p.volumeStart..p.volumeEnd) return p
            }
            return null
        }

        // ── Metainstrument (terranmon.txt "Metainstrument definition") ──
        // Non-null when this slot's u32 sample pointer has its high 16 bits == 0xFFFF.
        // The instrument then carries NO sample of its own; a trigger fans out into one
        // voice per matching layer. metaRaw retains the verbatim 256-byte record so
        // [getByte]/capture round-trips losslessly (parsing octet→gain is one-way).
        var metaLayers: Array<MetaLayer>? = null
        var metaRaw: IntArray? = null
        val isMeta: Boolean get() = metaLayers != null

        // initialAttenuation — a static per-instrument gain as a "Perceptually Significant
        // Octet to Decibel Table" octet (byte 251; 159 = unity, 111 = −6 dB; same table as the
        // Metainstrument layer mix). 0 = unity (unset sentinel) so legacy files (byte 251 was
        // reserved/zero) are unaffected. Applied as a velocity-INDEPENDENT amplitude multiplier
        // in the mixer, NOT folded into the volume envelope (so the envelope keeps full 0..63
        // resolution). The per-patch 'x' block carries its own override. See [attenGainOf].
        var initialAttenOctet: Int = 0

        /** All layers whose (pitch × volume) rectangle contains the trigger, in record
         *  order. Empty when none match (the trigger then sounds nothing). */
        fun resolveMetaLayers(noteVal: Int, rowVolume: Int): List<MetaLayer> {
            val layers = metaLayers ?: return emptyList()
            return layers.filter {
                noteVal in it.pitchStart..it.pitchEnd && rowVolume in it.volStart..it.volEnd
            }
        }

        /** Load a full 256-byte instrument record. Detects the Metainstrument sentinel
         *  (u32 sample-pointer high 16 bits == 0xFFFF) and parses its layer table;
         *  otherwise falls back to the per-byte [setByte] field assignment. */
        fun loadRecord(b: IntArray) {
            // A fresh record replaces any notefx 5/6 cutoff/resonance override from a prior song.
            cutoffOverride = -1; resonanceOverride = -1
            val sp = (b[0] and 0xFF) or ((b[1] and 0xFF) shl 8) or
                     ((b[2] and 0xFF) shl 16) or ((b[3] and 0xFF) shl 24)
            if ((sp ushr 16) and 0xFFFF == 0xFFFF) {
                val count = (sp ushr 8) and 0xFF                     // byte 1 = layer count
                val layers = ArrayList<MetaLayer>(count)
                var o = 4
                repeat(count) {
                    if (o + 10 > b.size) return@repeat
                    val instIdx = b[o] and 0xFF
                    val mixOctet = b[o + 1] and 0xFF
                    val detRaw = (b[o + 2] and 0xFF) or ((b[o + 3] and 0xFF) shl 8)
                    val detune = if (detRaw >= 0x8000) detRaw - 0x10000 else detRaw
                    val pStart = (b[o + 4] and 0xFF) or ((b[o + 5] and 0xFF) shl 8)
                    val pEnd   = (b[o + 6] and 0xFF) or ((b[o + 7] and 0xFF) shl 8)
                    val vStart = b[o + 8] and 0xFF
                    val vEnd   = b[o + 9] and 0xFF
                    // Skip self-/zero-/out-of-range references; no recursion into metas
                    // is validated here (the trigger path also guards).
                    if (instIdx in 1..255 && instIdx != index)
                        layers.add(MetaLayer(instIdx, mixOctet, detune, pStart, pEnd, vStart, vEnd))
                    o += 10
                }
                metaLayers = if (layers.isEmpty()) null else layers.toTypedArray()
                metaRaw = if (metaLayers != null) b.copyOf(256) else null
                extraPatches = null
            } else {
                metaLayers = null
                metaRaw = null
                for (i in 0 until minOf(256, b.size)) setByte(i, b[i] and 0xFF)
            }
        }

        // Funk repeat (S$Fx00) bit-mask — non-destructive XOR overlay across the loop region.
        // Lazily allocated; a 1-bit flips the byte, a 0-bit leaves it intact.
        // Mask is sized for the loop length at allocation time; if the loop bounds change
        // (e.g. a new song reuses this instrument slot with different sample data) the old
        // mask is stale and must be discarded — otherwise indexing past its end crashes the
        // render thread with ArrayIndexOutOfBoundsException.
        // Note: with Ixmp patches active the mask still indexes the BASE instrument's loop
        // region, not the active patch's. Funk repeat (S$Fx) is a PT2 effect and doesn't
        // coexist with multi-sample IT/XM instruments in practice.
        var funkMask: ByteArray? = null
        fun toggleFunkBit(loopOffset: Int) {
            val len = (sampleLoopEnd - sampleLoopStart).coerceAtLeast(1)
            val expectedSize = (len + 7) / 8
            var mask = funkMask
            if (mask == null || mask.size != expectedSize) {
                mask = ByteArray(expectedSize).also { funkMask = it }
            }
            val idx = loopOffset.coerceIn(0, len - 1)
            mask[idx / 8] = (mask[idx / 8].toInt() xor (1 shl (idx and 7))).toByte()
        }
        fun funkBit(loopOffset: Int): Boolean {
            val mask = funkMask ?: return false
            val len = (sampleLoopEnd - sampleLoopStart).coerceAtLeast(1)
            if (mask.size != (len + 7) / 8) { funkMask = null; return false }
            val idx = loopOffset.coerceIn(0, len - 1)
            return (mask[idx / 8].toInt() ushr (idx and 7)) and 1 != 0
        }

        private fun envPointGet(env: Array<TaudInstEnvPoint>, base: Int, offset: Int): Byte {
            val rel = offset - base
            val pt  = env[rel / 2]
            return if (rel and 1 == 0) pt.value.toByte() else pt.offset.index.toByte()
        }

        private fun envPointSet(env: Array<TaudInstEnvPoint>, base: Int, offset: Int, byte: Int) {
            val rel = offset - base
            val pt  = env[rel / 2]
            if (rel and 1 == 0) pt.value = byte
            else pt.offset = ThreeFiveMiniUfloat(byte)
        }

        fun getByte(offset: Int): Byte = when (offset) {
            // Metainstrument records play back verbatim from the stored raw bytes so
            // capture (captureSampleInstBlob) round-trips them losslessly.
            in 0..255 -> metaRaw?.let { return (it[offset] and 0xFF).toByte() } ?: getByteNormal(offset)
            else -> throw InternalError("Bad offset $offset")
        }

        private fun getByteNormal(offset: Int): Byte = when (offset) {
            0 -> samplePtr.toByte()
            1 -> samplePtr.ushr(8).toByte()
            2 -> samplePtr.ushr(16).toByte()
            3 -> samplePtr.ushr(24).toByte()

            4 -> sampleLength.toByte()
            5 -> sampleLength.ushr(8).toByte()

            6 -> samplingRate.toByte()
            7 -> samplingRate.ushr(8).toByte()

            8 -> samplePlayStart.toByte()
            9 -> samplePlayStart.ushr(8).toByte()

            10 -> sampleLoopStart.toByte()
            11 -> sampleLoopStart.ushr(8).toByte()

            12 -> sampleLoopEnd.toByte()
            13 -> sampleLoopEnd.ushr(8).toByte()

            14 -> (loopMode and 7).toByte()
            15 -> volEnvLoop.toByte()
            16 -> volEnvLoop.ushr(8).toByte()
            17 -> panEnvLoop.toByte()
            18 -> panEnvLoop.ushr(8).toByte()
            19 -> pfEnvLoop.toByte()
            20 -> pfEnvLoop.ushr(8).toByte()

            in 21..70  -> envPointGet(volEnvelopes, 21,  offset)
            in 71..120 -> envPointGet(panEnvelopes, 71,  offset)
            in 121..170 -> envPointGet(pfEnvelopes,  121, offset)

            171 -> instGlobalVolume.toByte()
            172 -> volumeFadeoutLow.toByte()
            173 -> fadeoutHigh.toByte()
            174 -> volumeSwing.toByte()
            175 -> vibratoSpeed.toByte()
            176 -> vibratoSweep.toByte()
            177 -> defaultPan.toByte()
            178 -> pitchPanCentre.toByte()
            179 -> pitchPanCentre.ushr(8).toByte()
            180 -> pitchPanSeparation.toByte()
            181 -> panSwing.toByte()
            182 -> defaultCutoff.toByte()
            183 -> defaultResonance.toByte()
            184 -> sampleDetune.toByte()
            185 -> sampleDetune.ushr(8).toByte()
            186 -> instrumentFlag.toByte()
            187 -> vibratoDepth.toByte()
            188 -> vibratoRate.toByte()
            189 -> volEnvSustainWord.toByte()
            190 -> volEnvSustainWord.ushr(8).toByte()
            191 -> panEnvSustainWord.toByte()
            192 -> panEnvSustainWord.ushr(8).toByte()
            193 -> pfEnvSustainWord.toByte()
            194 -> pfEnvSustainWord.ushr(8).toByte()
            195 -> dupCheckFlag.toByte()
            196 -> defaultNoteVolume.toByte()
            197 -> pf2EnvLoop.toByte()
            198 -> pf2EnvLoop.ushr(8).toByte()
            199 -> pf2EnvSustainWord.toByte()
            200 -> pf2EnvSustainWord.ushr(8).toByte()
            in 201..250 -> envPointGet(pf2Envelopes, 201, offset)
            251 -> initialAttenOctet.toByte()
            in 252..255 -> reserved[offset - 251]
            else -> throw InternalError("Bad offset $offset")
        }

        fun setByte(offset: Int, byte: Int) = when (offset) {
            0 -> { samplePtr = (samplePtr and 0xFFFFFF00.toInt()) or byte }
            1 -> { samplePtr = (samplePtr and 0xFFFF00FF.toInt()) or (byte shl 8) }
            2 -> { samplePtr = (samplePtr and 0xFF00FFFF.toInt()) or (byte shl 16) }
            3 -> { samplePtr = (samplePtr and 0x00FFFFFF) or (byte shl 24) }

            4 -> { sampleLength = (sampleLength and 0xff00) or byte }
            5 -> { sampleLength = (sampleLength and 0x00ff) or (byte shl 8) }

            6 -> { samplingRate = (samplingRate and 0xff00) or byte }
            7 -> { samplingRate = (samplingRate and 0x00ff) or (byte shl 8) }

            8 -> { samplePlayStart = (samplePlayStart and 0xff00) or byte }
            9 -> { samplePlayStart = (samplePlayStart and 0x00ff) or (byte shl 8) }

            10 -> { sampleLoopStart = (sampleLoopStart and 0xff00) or byte }
            11 -> { sampleLoopStart = (sampleLoopStart and 0x00ff) or (byte shl 8) }

            12 -> { sampleLoopEnd = (sampleLoopEnd and 0xff00) or byte }
            13 -> { sampleLoopEnd = (sampleLoopEnd and 0x00ff) or (byte shl 8) }

            14 -> { loopMode = byte and 7 }
            15 -> { volEnvLoop = (volEnvLoop and 0xff00) or byte }
            16 -> { volEnvLoop = (volEnvLoop and 0x00ff) or (byte shl 8) }
            17 -> { panEnvLoop = (panEnvLoop and 0xff00) or byte }
            18 -> { panEnvLoop = (panEnvLoop and 0x00ff) or (byte shl 8) }
            19 -> { pfEnvLoop = (pfEnvLoop and 0xff00) or byte }
            20 -> { pfEnvLoop = (pfEnvLoop and 0x00ff) or (byte shl 8) }

            in 21..70  -> envPointSet(volEnvelopes, 21,  offset, byte)
            in 71..120 -> envPointSet(panEnvelopes, 71,  offset, byte)
            in 121..170 -> envPointSet(pfEnvelopes,  121, offset, byte)

            171 -> { instGlobalVolume = byte and 0xFF }
            172 -> { volumeFadeoutLow = byte and 0xFF }
            173 -> { fadeoutHigh = byte and 0x1F }   // bits 0-3 = fadeout high, bit 4 = SF filter mode
            174 -> { volumeSwing = byte and 0xFF }
            175 -> { vibratoSpeed = byte and 0xFF }
            176 -> { vibratoSweep = byte and 0xFF }
            177 -> { defaultPan = byte and 0xFF }
            178 -> { pitchPanCentre = (pitchPanCentre and 0xff00) or byte }
            179 -> { pitchPanCentre = (pitchPanCentre and 0x00ff) or (byte shl 8) }
            180 -> { pitchPanSeparation = byte.toByte().toInt() }
            181 -> { panSwing = byte and 0xFF }
            182 -> { defaultCutoff = byte and 0xFF }
            183 -> { defaultResonance = byte and 0xFF }
            184 -> { sampleDetune = (sampleDetune and 0xff00) or byte }
            185 -> { sampleDetune = (sampleDetune and 0x00ff) or (byte shl 8) }
            186 -> { instrumentFlag = byte and 0xFF }
            187 -> { vibratoDepth = byte and 0xFF }
            188 -> { vibratoRate = byte and 0xFF }
            189 -> { volEnvSustainWord = (volEnvSustainWord and 0xff00) or byte }
            190 -> { volEnvSustainWord = (volEnvSustainWord and 0x00ff) or (byte shl 8) }
            191 -> { panEnvSustainWord = (panEnvSustainWord and 0xff00) or byte }
            192 -> { panEnvSustainWord = (panEnvSustainWord and 0x00ff) or (byte shl 8) }
            193 -> { pfEnvSustainWord = (pfEnvSustainWord and 0xff00) or byte }
            194 -> { pfEnvSustainWord = (pfEnvSustainWord and 0x00ff) or (byte shl 8) }
            195 -> { dupCheckFlag = byte and 0x0F }
            196 -> { defaultNoteVolume = byte and 0xFF }
            197 -> { pf2EnvLoop = (pf2EnvLoop and 0xff00) or byte }
            198 -> { pf2EnvLoop = (pf2EnvLoop and 0x00ff) or (byte shl 8) }
            199 -> { pf2EnvSustainWord = (pf2EnvSustainWord and 0xff00) or byte }
            200 -> { pf2EnvSustainWord = (pf2EnvSustainWord and 0x00ff) or (byte shl 8) }
            in 201..250 -> envPointSet(pf2Envelopes, 201, offset, byte)
            251 -> { initialAttenOctet = byte and 0xFF }
            in 252..255 -> { reserved[offset - 251] = byte.toByte() }
            else -> throw InternalError("Bad offset $offset")
        }
    }



}