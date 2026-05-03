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
import kotlin.math.cos
import kotlin.math.log2
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.PI

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
        // Mixer-private background-voice pool size per playhead. NNA "Continue/Note Off/Note Fade"
        // ghosts displaced foreground voices into this pool; oldest is evicted on overflow.
        const val MAX_BG_VOICES = 64
        const val MIDDLE_C = 0x5000   // reference C for instrument samplingRate (terranmon.txt:2000)
        // Amiga period at MIDDLE_C for a standard 8363 Hz instrument (NTSC clock 3579545 Hz).
        // PT "C-2" period 428 ↔ TSVM MIDDLE_C ↔ 8363 Hz; mod2taud uses the same convention.
        // Trackers may use different labelling conventions (e.g. C5) for Middle C.
        // For non-tracker context, Middle C shall be labelled as C4.
        const val AMIGA_BASE_PERIOD = 428.0
    }

    internal val sampleBin = UnsafeHelper.allocate(737280L, this)
    internal val instruments = Array(256) { TaudInst(it) }
    internal val playdata = Array(4096) { Array(64) { TaudPlayData(0xFFFF, 0, 0, 0, 32, 0, 0, 0) } }
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
            in 0..737279 -> sampleBin[addr]
            in 737280..786431 -> (adi - 737280).let { instruments[it / 192].getByte(it % 192) }
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
            in 0..737279 -> { sampleBin[addr] = byte }
            in 737280..786431 -> (adi - 737280).let { instruments[it / 192].setByte(it % 192, bi) }
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
            in 64..2367 -> mediaDecodedBin[addr - 64]
            in 2368..4095 -> mediaFrameBin[addr - 2368]
            in 4096..4097 -> 0
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
        val periMmioBase = vm.findPeriSlotNum(this)!! * -786432 - 1L
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
            val payloadSize = (
                    (tadInputBin[offset++].toUint()) or
                            ((tadInputBin[offset++].toUint()) shl 8) or
                            ((tadInputBin[offset++].toUint()) shl 16) or
                            ((tadInputBin[offset++].toUint()) shl 24)
                    )

            // Decompress payload
            val compressed = ByteArray(payloadSize)
            UnsafeHelper.memcpyRaw(null, tadInputBin.ptr + offset, compressed, UnsafeHelper.getArrayOffset(compressed), payloadSize.toLong())

            val payload: ByteArray = try {
                ZstdInputStream(ByteArrayInputStream(compressed)).use { zstd ->
                    zstd.readBytes()
                }
            } catch (e: Exception) {
                println("ERROR: Zstd decompression failed: ${e.message}")
                return
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
        const val OP_O = 0x18
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

    private fun computePlaybackRate(inst: TaudInst, noteVal: Int): Double =
        inst.samplingRate.toDouble() / SAMPLING_RATE *
        2.0.pow((noteVal - MIDDLE_C + inst.sampleDetuneSigned) / 4096.0)

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

    private fun advanceEnvelope(voice: Voice, inst: TaudInst, tickSec: Double) {
        // 16-bit envelope-flag layout (terranmon.txt:2007-2030):
        //   0b 0ut sssss pcb eeeee
        //     bit 14 = u (enable sustain/loop)
        //     bit 13 = t (sustain — 1=breaks on key-off, 0=loops forever)
        //     bits 12..8 = sustain/loop start index (0..24)
        //     bit  7 = p (channel-specific flag — fadeout zero / use default pan)
        //     bit  6 = c (envelope carry)
        //     bit  5 = b (use envelope at all)
        //     bits 4..0 = sustain/loop end index (0..24)
        val maxIdx = 24

        // Volume envelope
        val vSus       = inst.volEnvSustain
        val vUseEnv    = (vSus ushr 5) and 1 != 0
        if (vUseEnv && voice.volEnvOn) {
            val vEnabled   = (vSus ushr 14) and 1 != 0
            val vIsSustain = (vSus ushr 13) and 1 != 0
            val vSusOn     = vEnabled && (!vIsSustain || !voice.keyOff)
            val vSusStart  = (vSus ushr 8) and 0x1F
            val vSusEnd    = vSus and 0x1F

            if (vSusOn && voice.envIndex == vSusEnd && vSusStart == vSusEnd) {
                voice.envVolume = (inst.volEnvelopes[voice.envIndex].value / 63.0).coerceIn(0.0, 1.0)
            } else if (vSusOn && voice.envIndex == vSusEnd) {
                voice.envTimeSec = 0.0
                voice.envIndex = vSusStart
                voice.envVolume = (inst.volEnvelopes[voice.envIndex].value / 63.0).coerceIn(0.0, 1.0)
            } else if (voice.envIndex >= maxIdx) {
                voice.envVolume = (inst.volEnvelopes[maxIdx].value / 63.0).coerceIn(0.0, 1.0)
            } else {
                val vOffset = inst.volEnvelopes[voice.envIndex].offset.toDouble()
                if (vOffset == 0.0) {
                    voice.envVolume = (inst.volEnvelopes[voice.envIndex].value / 63.0).coerceIn(0.0, 1.0)
                } else {
                    voice.envTimeSec += tickSec
                    if (voice.envTimeSec >= vOffset) {
                        voice.envTimeSec -= vOffset
                        val nextIdx = if (vSusOn && voice.envIndex == vSusEnd) vSusStart
                                      else (voice.envIndex + 1).coerceAtMost(maxIdx)
                        voice.envIndex = nextIdx
                        voice.envVolume = (inst.volEnvelopes[voice.envIndex].value / 63.0).coerceIn(0.0, 1.0)
                    } else {
                        val cur = (inst.volEnvelopes[voice.envIndex].value / 63.0).coerceIn(0.0, 1.0)
                        val nxt = (inst.volEnvelopes[(voice.envIndex + 1).coerceAtMost(maxIdx)].value / 63.0).coerceIn(0.0, 1.0)
                        voice.envVolume = cur + (nxt - cur) * (voice.envTimeSec / vOffset)
                    }
                }
            }
        }

        // Pan envelope (only when active for this instrument)
        if (!voice.hasPanEnv || !voice.panEnvOn) return
        val pSus       = inst.panEnvSustain
        val pUseEnv    = (pSus ushr 5) and 1 != 0
        if (!pUseEnv) return
        val pEnabled   = (pSus ushr 14) and 1 != 0
        val pIsSustain = (pSus ushr 13) and 1 != 0
        val pSusOn     = pEnabled && (!pIsSustain || !voice.keyOff)
        val pSusStart  = (pSus ushr 8) and 0x1F
        val pSusEnd    = pSus and 0x1F

        if (pSusOn && voice.envPanIndex == pSusEnd && pSusStart == pSusEnd) {
            voice.envPan = inst.panEnvelopes[voice.envPanIndex].value / 255.0
        } else if (pSusOn && voice.envPanIndex == pSusEnd) {
            voice.envPanTimeSec = 0.0
            voice.envPanIndex = pSusStart
            voice.envPan = inst.panEnvelopes[voice.envPanIndex].value / 255.0
        } else if (voice.envPanIndex >= maxIdx) {
            voice.envPan = inst.panEnvelopes[maxIdx].value / 255.0
        } else {
            val pOffset = inst.panEnvelopes[voice.envPanIndex].offset.toDouble()
            if (pOffset == 0.0) {
                voice.envPan = inst.panEnvelopes[voice.envPanIndex].value / 255.0
            } else {
                voice.envPanTimeSec += tickSec
                if (voice.envPanTimeSec >= pOffset) {
                    voice.envPanTimeSec -= pOffset
                    val nextIdx = if (pSusOn && voice.envPanIndex == pSusEnd) pSusStart
                                  else (voice.envPanIndex + 1).coerceAtMost(maxIdx)
                    voice.envPanIndex = nextIdx
                    voice.envPan = inst.panEnvelopes[voice.envPanIndex].value / 255.0
                } else {
                    val cur = inst.panEnvelopes[voice.envPanIndex].value / 255.0
                    val nxt = inst.panEnvelopes[(voice.envPanIndex + 1).coerceAtMost(maxIdx)].value / 255.0
                    voice.envPan = cur + (nxt - cur) * (voice.envPanTimeSec / pOffset)
                }
            }
        }
    }

    /**
     * Advance the pitch/filter envelope by `tickSec`. Same loop / sustain semantics
     * as advanceEnvelope. Result is stored in `voice.envPfValue` (0.0..1.0; 0.5 = unity).
     */
    private fun advancePfEnvelope(voice: Voice, inst: TaudInst, tickSec: Double) {
        if (!voice.hasPfEnv || !voice.pfEnvOn) return
        val maxIdx = 24
        val pSus       = inst.pfEnvSustain
        val pUseEnv    = (pSus ushr 5) and 1 != 0
        if (!pUseEnv) return
        val pEnabled   = (pSus ushr 14) and 1 != 0
        val pIsSustain = (pSus ushr 13) and 1 != 0
        val pSusOn     = pEnabled && (!pIsSustain || !voice.keyOff)
        val pSusStart  = (pSus ushr 8) and 0x1F
        val pSusEnd    = pSus and 0x1F

        if (pSusOn && voice.envPfIndex == pSusEnd && pSusStart == pSusEnd) {
            voice.envPfValue = inst.pfEnvelopes[voice.envPfIndex].value / 255.0
        } else if (pSusOn && voice.envPfIndex == pSusEnd) {
            voice.envPfTimeSec = 0.0
            voice.envPfIndex = pSusStart
            voice.envPfValue = inst.pfEnvelopes[voice.envPfIndex].value / 255.0
        } else if (voice.envPfIndex >= maxIdx) {
            voice.envPfValue = inst.pfEnvelopes[maxIdx].value / 255.0
        } else {
            val pOffset = inst.pfEnvelopes[voice.envPfIndex].offset.toDouble()
            if (pOffset == 0.0) {
                voice.envPfValue = inst.pfEnvelopes[voice.envPfIndex].value / 255.0
            } else {
                voice.envPfTimeSec += tickSec
                if (voice.envPfTimeSec >= pOffset) {
                    voice.envPfTimeSec -= pOffset
                    val nextIdx = if (pSusOn && voice.envPfIndex == pSusEnd) pSusStart
                                  else (voice.envPfIndex + 1).coerceAtMost(maxIdx)
                    voice.envPfIndex = nextIdx
                    voice.envPfValue = inst.pfEnvelopes[voice.envPfIndex].value / 255.0
                } else {
                    val cur = inst.pfEnvelopes[voice.envPfIndex].value / 255.0
                    val nxt = inst.pfEnvelopes[(voice.envPfIndex + 1).coerceAtMost(maxIdx)].value / 255.0
                    voice.envPfValue = cur + (nxt - cur) * (voice.envPfTimeSec / pOffset)
                }
            }
        }
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
     */
    private fun refreshVoiceFilter(voice: Voice) {
        val cut = voice.currentCutoff.coerceIn(0, 255)
        val res = voice.currentResonance.coerceIn(0, 255)
        if (cut == voice.filterCutoffCached && res == voice.filterResonanceCached) return
        voice.filterCutoffCached = cut
        voice.filterResonanceCached = res

        if (cut >= 255) {
            voice.filterActive = false
            return
        }

        val itCutoff    = cut * 0.5                                     // 0..127
        val itResonance = if (res >= 255) 0.0 else res * 0.5            // 0..127

        val nyquist   = SAMPLING_RATE * 0.5 - 1.0
        val frequency = (110.0 * 2.0.pow(itCutoff / 24.0 + 0.25)).coerceAtMost(nyquist)
        val dmpfac    = 10.0.pow(-itResonance * (24.0 / 128.0) / 20.0)

        val r = SAMPLING_RATE / (2.0 * PI * frequency)
        val d = dmpfac * r + dmpfac - 1.0
        val e = r * r
        val denom = 1.0 + d + e

        voice.filterA0 = 1.0 / denom
        voice.filterB0 = (d + e + e) / denom
        voice.filterB1 = -e / denom
        voice.filterActive = true
    }

    /** Apply the cached IT-style 2-pole LPF to one mono sample. Caller must
     *  have called refreshVoiceFilter at the start of the tick. The history
     *  taps are clipped to ±2.0 to tame resonance ringing on extreme settings,
     *  matching OpenMPT's ClipFilter helper. */
    private fun applyVoiceFilter(voice: Voice, x0: Double): Double {
        if (!voice.filterActive) return x0
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
        // Depth from byte 187 (full 0..255). Speed from byte 175 (FT2 0..255 scale).
        val depth0 = inst.vibratoDepth
        if (depth0 == 0 || inst.vibratoSpeed == 0) return 0

        // Two ramp-in semantics:
        //   FT2 vibratoSweep (byte 176): "ticks to fully ramp" — depth = depth0 * t / sweep.
        //   IT vibratoRate   (byte 188): "ramp acceleration" — accumulator += rate per tick,
        //                                 capped at depth0 * 256, then divided by 256.
        val ftSweep  = inst.vibratoSweep
        val itRate   = inst.vibratoRate
        val t        = voice.autoVibTicksSinceTrigger
        val rampDepth = when {
            ftSweep != 0 -> ((depth0 * t / ftSweep).coerceAtMost(depth0))
            itRate  != 0 -> ((t * itRate) ushr 8).coerceAtMost(depth0)
            else         -> depth0
        }
        voice.autoVibTicksSinceTrigger++

        // Vibrato waveform selector lives in instrumentFlag bits 2-4.
        // 0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (FT2 only).
        // lfoSample handles 0..3; treat 4 (ramp-up) as negated ramp-down.
        val wave = inst.vibratoWaveform
        val rawSample = if (wave == 4) -lfoSample(voice.autoVibPhase, 1)
                        else            lfoSample(voice.autoVibPhase, wave and 3)
        // 4096-TET delta. depth0 is now 0..255 (was 0..15 in old layout); the
        // shift compensates so depth ≈255 yields a similar musical excursion
        // (~±9 cents) to the old depth ≈15.
        val pitchDelta = (rawSample * rampDepth) shr 10
        voice.autoVibPhase = (voice.autoVibPhase + inst.vibratoSpeed * 2) and 0xFF
        return pitchDelta
    }

    private fun fetchTrackerSample(voice: Voice, inst: TaudInst): Double {
        if (inst.index == 0) return 0.0

        val basePtr = inst.samplePtr
        val sampleLen = inst.sampleLength.coerceAtLeast(1)
        val loopStart = inst.sampleLoopStart.toDouble()
        val loopEnd = inst.sampleLoopEnd.toDouble().coerceAtLeast(1.0)
        val binMax = 737279  // sampleBin is 737280 bytes (0..737279)

        val i0 = voice.samplePos.toInt().coerceIn(0, sampleLen - 1)
        val i1 = (i0 + 1).coerceAtMost(sampleLen - 1)
        val frac = voice.samplePos - i0.toDouble()
        var b0 = sampleBin[(basePtr + i0).coerceAtMost(binMax).toLong()].toUint()
        var b1 = sampleBin[(basePtr + i1).coerceAtMost(binMax).toLong()].toUint()
        // S$Fx funk repeat: XOR the high bit of bytes whose loop-relative index
        // is set in funkMask. Only meaningful when the sample has a loop region.
        if (inst.funkMask != null && inst.sampleLoopEnd > inst.sampleLoopStart) {
            val ls = inst.sampleLoopStart
            if (i0 in ls until inst.sampleLoopEnd && inst.funkBit(i0 - ls)) b0 = b0 xor 0x80
            if (i1 in ls until inst.sampleLoopEnd && inst.funkBit(i1 - ls)) b1 = b1 xor 0x80
        }
        val s0 = (b0 - 127.5) / 127.5
        val s1 = (b1 - 127.5) / 127.5
        val sample = s0 + (s1 - s0) * frac

        if (voice.forward) {
            voice.samplePos += voice.playbackRate
            // When the sustain bit is set, key-off escapes the loop: the sample plays past
            // loopEnd until it ends naturally (loopMode 0 semantics).
            val effectiveLoopMode =
                if (inst.sampleLoopSustain && voice.keyOff) 0 else (inst.loopMode and 3)
            when (effectiveLoopMode) {
                0 -> if (voice.samplePos >= sampleLen) voice.active = false
                1 -> if (voice.samplePos >= loopEnd) voice.samplePos -= (loopEnd - loopStart).coerceAtLeast(1.0)
                2 -> if (voice.samplePos >= loopEnd) { voice.samplePos = loopEnd; voice.forward = false }
                3 -> if (voice.samplePos >= sampleLen) { voice.samplePos = sampleLen.toDouble() - 1; voice.active = false }
            }
        } else {
            voice.samplePos -= voice.playbackRate
            if (voice.samplePos < loopStart) { voice.samplePos = loopStart; voice.forward = true }
        }
        return sample
    }

    /**
     * Trigger a fresh note on [voice]: load the instrument, reset sample position, kick off the envelope.
     * Pulled out so S$Dx (note delay) can defer the same logic to a later tick.
     */
    private fun triggerNote(voice: Voice, noteVal: Int, instId: Int, volOverride: Int) {
        if (instId != 0) voice.instrumentId = instId
        val inst = instruments[voice.instrumentId]
        voice.tonePortaTarget = -1   // fresh note trigger cancels any running porta
        voice.samplePos = inst.samplePlayStart.toDouble()
        voice.forward = true
        voice.active = true
        voice.keyOff = false
        voice.envIndex = 0
        voice.envTimeSec = 0.0
        voice.envVolume = (inst.volEnvelopes[0].value / 63.0).coerceIn(0.0, 1.0)
        voice.envPanIndex = 0
        voice.envPanTimeSec = 0.0
        voice.envPan = inst.panEnvelopes[0].value / 255.0
        // Pan envelope is active when the `b` (use envelope) flag is set in panEnvSustain.
        voice.hasPanEnv = (inst.panEnvSustain ushr 5) and 1 != 0
        // Pitch/filter envelope state.
        voice.hasPfEnv      = (inst.pfEnvSustain ushr 5) and 1 != 0
        voice.envPfIsFilter = (inst.pfEnvSustain ushr 7) and 1 != 0
        voice.envPfIndex    = 0
        voice.envPfTimeSec  = 0.0
        voice.envPfValue    = if (voice.hasPfEnv) inst.pfEnvelopes[0].value / 255.0 else 0.5
        // Fadeout starts at unity; advances only after key-off.
        voice.fadeoutVolume = 1.0
        // Auto-vibrato sweep ramp restarts on every fresh trigger.
        voice.autoVibPhase = 0
        voice.autoVibTicksSinceTrigger = 0
        // Random vol/pan swing biases — seeded once per trigger (range determined by inst.volumeSwing/panSwing).
        voice.randomVolBias = if (inst.volumeSwing != 0)
            (Math.random() * (2 * inst.volumeSwing + 1)).toInt() - inst.volumeSwing else 0
        voice.randomPanBias = if (inst.panSwing != 0)
            (Math.random() * (2 * inst.panSwing + 1)).toInt() - inst.panSwing else 0
        // Default pan: applied unless the pattern row has already overridden channelPan.
        // We treat the pan envelope "p" flag (panEnvSustain bit 7) as "use default pan".
        if ((inst.panEnvSustain ushr 7) and 1 != 0) {
            voice.channelPan = inst.defaultPan
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
        // Filter cutoff/resonance defaults — adjusted per-tick by the pf envelope when in filter mode.
        // 255 = filter off (IT high-bit-clear); 0..254 = active range matching IT 0..127 at double resolution.
        voice.currentCutoff = inst.defaultCutoff
        voice.currentResonance = inst.defaultResonance
        voice.filterY1 = 0.0; voice.filterY2 = 0.0
        voice.filterCutoffCached = -1   // force coefficient refresh on first tick
        voice.filterResonanceCached = -1
        voice.noteVal = noteVal
        voice.basePitch = noteVal
        voice.amigaPeriod = -1.0   // fresh trigger: period state must reseed from the new noteVal
        voice.playbackRate = computePlaybackRate(inst, noteVal)
        // Fresh trigger resets channel volume to full ($3F). Per-instrument scaling lives in
        // instGlobalVolume (byte 171), which the mixer applies as a multiplier. Converters
        // therefore no longer need to emit SEL_SET=Sv on note-trigger rows.
        voice.channelVolume = if (volOverride >= 0) volOverride.coerceIn(0, 0x3F) else 0x3F
        voice.rowVolume = voice.channelVolume
        voice.noteWasCut = false
        voice.noteFading = false
        // S $73..$7C state resets on each fresh trigger so per-note overrides don't leak.
        voice.nnaOverride = -1
        voice.volEnvOn = true
        voice.panEnvOn = true
        voice.pfEnvOn = true
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

        fun isDuplicate(v: Voice): Boolean {
            val existInst = instruments[v.instrumentId]
            return when (existInst.duplicateCheckType) {
                1 -> v.noteVal == newNote && v.instrumentId == newInstId
                2 -> v.instrumentId == newInstId &&
                     existInst.samplePtr == newInst.samplePtr &&
                     existInst.sampleLength == newInst.sampleLength
                3 -> v.instrumentId == newInstId
                else -> false
            }
        }

        fun applyAction(v: Voice) {
            val existInst = instruments[v.instrumentId]
            when (existInst.duplicateCheckAction) {
                0 -> { v.fadeoutVolume = 0.0; v.active = false }
                1 -> v.keyOff = true
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
            0 -> bg.keyOff = true       // Note Off — release sustain; fadeout starts naturally.
            3 -> bg.noteFading = true   // Note Fade — fadeout immediately, sustain still loops.
            // 2 (Continue) — ghost continues unchanged.
        }
        ts.backgroundVoices.addLast(bg)
        while (ts.backgroundVoices.size > MAX_BG_VOICES) {
            ts.backgroundVoices.removeFirst()
        }
    }

    /** Snapshot the playback-relevant state of [src] into a fresh Voice tagged for [channel]. */
    private fun ghostVoice(src: Voice, channel: Int): Voice {
        val v = Voice()
        v.active = true
        v.muted = src.muted
        v.instrumentId = src.instrumentId
        v.samplePos = src.samplePos
        v.playbackRate = src.playbackRate
        v.forward = src.forward
        v.channelVolume = src.channelVolume
        v.rowVolume = src.rowVolume
        v.channelPan = src.channelPan
        v.rowPan = src.rowPan
        v.keyOff = src.keyOff
        v.envIndex = src.envIndex
        v.envTimeSec = src.envTimeSec
        v.envVolume = src.envVolume
        v.envPanIndex = src.envPanIndex
        v.envPanTimeSec = src.envPanTimeSec
        v.envPan = src.envPan
        v.hasPanEnv = src.hasPanEnv
        v.hasPfEnv = src.hasPfEnv
        v.envPfIndex = src.envPfIndex
        v.envPfTimeSec = src.envPfTimeSec
        v.envPfValue = src.envPfValue
        v.envPfIsFilter = src.envPfIsFilter
        v.fadeoutVolume = src.fadeoutVolume
        v.autoVibPhase = src.autoVibPhase
        v.autoVibTicksSinceTrigger = src.autoVibTicksSinceTrigger
        v.currentCutoff = src.currentCutoff
        v.currentResonance = src.currentResonance
        v.filterActive = src.filterActive
        v.filterA0 = src.filterA0
        v.filterB0 = src.filterB0
        v.filterB1 = src.filterB1
        v.filterY1 = src.filterY1
        v.filterY2 = src.filterY2
        v.filterCutoffCached = src.filterCutoffCached
        v.filterResonanceCached = src.filterResonanceCached
        v.randomVolBias = src.randomVolBias
        v.randomPanBias = src.randomPanBias
        v.noteVal = src.noteVal
        v.basePitch = src.basePitch
        v.amigaPeriod = src.amigaPeriod
        v.volEnvOn = src.volEnvOn
        v.panEnvOn = src.panEnvOn
        v.pfEnvOn = src.pfEnvOn
        v.noteFading = src.noteFading
        // Voice-FX state (effects 8/9): preserve so the NNA-ghosted tail keeps the same timbre.
        v.clipMode = src.clipMode
        v.bitcrusherDepth = src.bitcrusherDepth
        v.bitcrusherSkip = src.bitcrusherSkip
        v.bitcrusherCounter = src.bitcrusherCounter
        v.bitcrusherHeld = src.bitcrusherHeld
        v.overdriveAmp = src.overdriveAmp
        v.sourceChannel = channel
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
                if (bg.sourceChannel == channel) bg.keyOff = true
            }
            2 -> ts.backgroundVoices.forEach { bg ->  // Past Note Fade — start fadeout.
                if (bg.sourceChannel == channel) bg.noteFading = true
            }
        }
    }

    private fun applyVolColumn(voice: Voice, value: Int, sel: Int) {
        // value is the 6-bit cell field; sel is the 2-bit selector. See TAUD_NOTE_EFFECTS.md
        // §"Volume column effects" for the multi-selector encoding.
        when (sel) {
            0 -> { voice.channelVolume = value.coerceIn(0, 0x3F); voice.rowVolume = voice.channelVolume }
            1 -> voice.volColSlideUp = value
            2 -> voice.volColSlideDown = value
            3 -> {
                if (value == 0) return

                val mag = value and 0x1F
                voice.rowVolume = if ((value and 0x20) != 0) (voice.rowVolume + mag).coerceAtMost(0x3F)
                                  else (voice.rowVolume - mag).coerceAtLeast(0)
                voice.channelVolume = voice.rowVolume
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
            val row = playdata[patIdx][ts.rowIndex]
            val voice = ts.voices[vi]

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
            voice.rowEffect = row.effect
            voice.rowEffectArg = row.effectArg

            // ── Note ──
            val toneG = (row.effect == EffectOp.OP_G)
            when (row.note) {
                // No note but an instrument byte is present: latch the instrument so
                // the *next* note-only trigger picks up the right sample. Trackers
                // call this an "instrument-only retrigger"; in MOD/S3M/IT the sample
                // keeps playing, but the channel's instrument reference advances.
                0xFFFF -> { if (row.instrment != 0) voice.instrumentId = row.instrment }
                0x0000 -> { voice.keyOff = true; voice.active = false }  // key-off; breaks sustain loop
                0xFFFE -> voice.active = false                  // note cut
                else -> {
                    if (toneG && voice.active) {
                        // Tone porta: target the note, do not retrigger sample.
                        voice.tonePortaTarget = row.note
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
                        triggerNote(voice, row.note, row.instrment, -1)
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
            EffectOp.OP_1 -> {
                // 1 $xx00 — Global behaviour flags byte in the high byte (see TAUD_NOTE_EFFECTS.md §1).
                // bit 0 (p): 0=linear pan, 1=equal-power pan
                // bit 1 (f): 0=linear pitch slides, 1=Amiga-mode pitch slides
                // bit 2 (m): fadeout-zero policy. 0=IT (stored 0 ⇒ no fadeout), 1=FT2 (stored 0 ⇒ cut on key-off)
                val flags = rawArg ushr 8
                ts.panLaw = flags and 1
                ts.amigaMode = (flags and 2) != 0
                ts.fadeoutCutOnZero = (flags and 4) != 0
            }
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
                val arg = resolveArg(rawArg, voice.mem.d).also { if (rawArg != 0) voice.mem.d = it }
                val hi = (arg ushr 8) and 0xFF
                val lo = hi and 0x0F
                val hin = (hi ushr 4) and 0x0F
                when {
                    hi == 0xFF -> { voice.rowVolume = (voice.rowVolume + 0xF).coerceAtMost(0x3F); voice.channelVolume = voice.rowVolume }   // DFF quirk: fine up by F
                    hin == 0xF && lo != 0 -> { voice.rowVolume = (voice.rowVolume - lo).coerceAtLeast(0); voice.channelVolume = voice.rowVolume }
                    lo == 0xF && hin != 0 -> { voice.rowVolume = (voice.rowVolume + hin).coerceAtMost(0x3F); voice.channelVolume = voice.rowVolume }
                    hin == 0 && lo != 0 -> { voice.slideMode = 5; voice.slideArg = -lo }     // slide down per non-first tick
                    lo == 0 && hin != 0 -> { voice.slideMode = 5; voice.slideArg = hin }     // slide up per non-first tick
                }
            }
            EffectOp.OP_E -> {
                val arg = resolveArg(rawArg, voice.mem.ef).also { if (rawArg != 0) voice.mem.ef = it }
                if ((arg and 0xF000) == 0xF000) {
                    val mag = arg and 0x0FFF
                    voice.noteVal = if (ts.amigaMode)
                        amigaSlideOnce(voice.noteVal, -mag).coerceIn(0, 0xFFFE)
                    else
                        (voice.noteVal - mag).coerceIn(0, 0xFFFE)
                    voice.basePitch = voice.noteVal
                    voice.amigaPeriod = -1.0   // reseed on next per-tick slide
                    voice.playbackRate = computePlaybackRate(instruments[voice.instrumentId], voice.noteVal)
                } else {
                    voice.slideMode = 1; voice.slideArg = -arg
                    voice.amigaPeriod = -1.0   // reseed at the start of a fresh multi-tick slide
                }
            }
            EffectOp.OP_F -> {
                val arg = resolveArg(rawArg, voice.mem.ef).also { if (rawArg != 0) voice.mem.ef = it }
                if ((arg and 0xF000) == 0xF000) {
                    val mag = arg and 0x0FFF
                    voice.noteVal = if (ts.amigaMode)
                        amigaSlideOnce(voice.noteVal, mag).coerceIn(0, 0xFFFE)
                    else
                        (voice.noteVal + mag).coerceIn(0, 0xFFFE)
                    voice.basePitch = voice.noteVal
                    voice.amigaPeriod = -1.0
                    voice.playbackRate = computePlaybackRate(instruments[voice.instrumentId], voice.noteVal)
                } else {
                    voice.slideMode = 2; voice.slideArg = arg
                    voice.amigaPeriod = -1.0
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
            EffectOp.OP_K, EffectOp.OP_L -> {} // engine no-op by design (converter splits them)
            EffectOp.OP_O -> {
                val arg = resolveArg(rawArg, voice.mem.o).also { if (rawArg != 0) voice.mem.o = it }
                val inst = instruments[voice.instrumentId]
                var off = arg
                if ((inst.loopMode and 3) != 0 && inst.sampleLoopEnd > inst.sampleLoopStart && off > inst.sampleLoopEnd) {
                    val loopLen = (inst.sampleLoopEnd - inst.sampleLoopStart).coerceAtLeast(1)
                    off = inst.sampleLoopStart + ((off - inst.sampleLoopStart) % loopLen)
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
                    playhead.bpm = (tempoByte + 0x18).coerceIn(24, 280)
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
            0x1 -> voice.glissandoOn = (x != 0)
            0x2 -> {
                voice.noteVal = (voice.noteVal + FINETUNE_OFFSET[x]).coerceIn(0, 0xFFFE)
                voice.basePitch = voice.noteVal
                voice.amigaPeriod = -1.0
                voice.playbackRate = computePlaybackRate(instruments[voice.instrumentId], voice.noteVal)
            }
            0x3 -> { voice.vibratoWave = x and 3; voice.vibratoRetrig = (x and 4) == 0 }
            0x4 -> { voice.tremoloWave = x and 3; voice.tremoloRetrig = (x and 4) == 0 }
            0x5 -> { voice.panbrelloWave = x and 3; voice.panbrelloRetrig = (x and 4) == 0 }
            0x6 -> ts.finePatternDelayExtra += x   // fine pattern delay: accumulate across channels
            0x7 -> when (x) {
                // Past-note actions on the channel's background ghosts.
                0x0 -> applyPastNoteAction(ts, vi, 0)   // Past Note Cut
                0x1 -> applyPastNoteAction(ts, vi, 1)   // Past Note Off
                0x2 -> applyPastNoteAction(ts, vi, 2)   // Past Note Fade
                // NNA override for the live note (used at next NNA event on this voice).
                // Codes follow the per-voice nnaOverride convention (0=Off, 1=Cut, 2=Continue, 3=Fade).
                0x3 -> voice.nnaOverride = 1            // NNA Note Cut
                0x4 -> voice.nnaOverride = 2            // NNA Note Continue
                0x5 -> voice.nnaOverride = 0            // NNA Note Off
                0x6 -> voice.nnaOverride = 3            // NNA Note Fade
                // Envelope on/off — mixer ignores and per-tick freezes the disabled envelope.
                0x7 -> voice.volEnvOn = false
                0x8 -> voice.volEnvOn = true
                0x9 -> voice.panEnvOn = false
                0xA -> voice.panEnvOn = true
                0xB -> voice.pfEnvOn = false
                0xC -> voice.pfEnvOn = true
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

    private fun applyTrackerTick(ts: TrackerState, playhead: Playhead) {
        val tickSec = 2.5 / playhead.bpm
        for (vi in 0 until ts.voices.size) {
            val voice = ts.voices[vi]
            if (!voice.active && voice.noteDelayTick < 0) continue
            val inst = instruments[voice.instrumentId]

            // Note cut.
            if (voice.cutAtTick == ts.tickInRow) {
                voice.rowVolume = 0; voice.channelVolume = 0
                voice.noteWasCut = true
            }

            // Note delay — fire deferred trigger when the requested tick arrives.
            // NNA fires now (not at row parse) so that delayed retriggers ghost correctly.
            if (voice.noteDelayTick == ts.tickInRow) {
                applyDuplicateCheck(ts, vi, voice.delayedInst, voice.delayedNote)
                maybeSpawnBackgroundForNNA(ts, voice, vi)
                triggerNote(voice, voice.delayedNote, voice.delayedInst, voice.delayedVol)
                voice.noteDelayTick = -1
            }

            if (!voice.active) { advanceEnvelope(voice, inst, tickSec); continue }

            // Pitch slides (E/F coarse on tick > 0).
            if (ts.tickInRow > 0 && (voice.slideMode == 1 || voice.slideMode == 2)) {
                voice.noteVal = if (ts.amigaMode)
                    amigaSlideTick(voice, voice.slideArg).coerceIn(0, 0xFFFE)
                else
                    (voice.noteVal + voice.slideArg).coerceIn(0, 0xFFFE)
                voice.basePitch = voice.noteVal
            }

            // Tone portamento (G).
            if (voice.tonePortaTarget >= 0 && ts.tickInRow > 0) {
                val target = voice.tonePortaTarget
                val sp = voice.tonePortaSpeed
                val delta = if (target > voice.noteVal) sp else -sp
                voice.noteVal += delta
                if ((delta > 0 && voice.noteVal >= target) || (delta < 0 && voice.noteVal <= target)) {
                    voice.noteVal = target; voice.tonePortaTarget = -1
                }
                voice.basePitch = voice.noteVal
                voice.amigaPeriod = -1.0   // tone porta works in linear noteVal space; reseed period
            }

            // Volume slides (D coarse on tick > 0).
            if (ts.tickInRow > 0 && voice.slideMode == 5) {
                voice.rowVolume = (voice.rowVolume + voice.slideArg).coerceIn(0, 0x3F)
                voice.channelVolume = voice.rowVolume
            }

            // Volume-column slides (selectors 1/2 — per non-first tick).
            if (ts.tickInRow > 0) {
                if (voice.volColSlideUp != 0) {
                    voice.rowVolume = (voice.rowVolume + voice.volColSlideUp).coerceAtMost(0x3F); voice.channelVolume = voice.rowVolume
                }
                if (voice.volColSlideDown != 0) {
                    voice.rowVolume = (voice.rowVolume - voice.volColSlideDown).coerceAtLeast(0); voice.channelVolume = voice.rowVolume
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
                pitchToMixer = (voice.noteVal + pitchDelta).coerceIn(0, 0xFFFE)
                voice.vibratoLfoPos = (voice.vibratoLfoPos + voice.mem.huSpeed * 4) and 0xFF
            }

            // Glissando (S$1x) — snap pitchToMixer to nearest semitone but leave noteVal smooth.
            if (voice.glissandoOn) {
                val semis = ((pitchToMixer * 12 + 2048) / 4096)
                pitchToMixer = (semis * 4096 / 12).coerceIn(0, 0xFFFE)
            }

            // Tremolo (R) — modulates output volume around base.
            if (voice.tremoloActive) {
                val sine = lfoSample(voice.tremoloLfoPos, voice.tremoloWave)
                val volDelta = (sine * voice.mem.rDepth) shr 9
                voice.rowVolume = (voice.channelVolume + volDelta).coerceIn(0, 0x3F)
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
                pitchToMixer = (voice.basePitch + arpDelta).coerceIn(0, 0xFFFE)
                voice.lastArpVoice = voiceIdx
            }

            // Q retrigger.
            if (voice.retrigActive && !voice.noteWasCut) {
                voice.retrigCounter++
                if (voice.retrigCounter >= voice.retrigInterval) {
                    voice.retrigCounter = 0
                    val retrigInst = instruments[voice.instrumentId]
                    voice.samplePos = retrigInst.samplePlayStart.toDouble()
                    voice.keyOff = false
                    voice.envIndex = 0; voice.envTimeSec = 0.0
                    voice.envPanIndex = 0; voice.envPanTimeSec = 0.0
                    voice.envPan = retrigInst.panEnvelopes[0].value / 255.0
                    voice.envPfIndex = 0; voice.envPfTimeSec = 0.0
                    voice.envPfValue = if (voice.hasPfEnv) retrigInst.pfEnvelopes[0].value / 255.0 else 0.5
                    voice.fadeoutVolume = 1.0
                    voice.autoVibPhase = 0
                    voice.autoVibTicksSinceTrigger = 0
                    voice.filterY1 = 0.0; voice.filterY2 = 0.0
                    voice.rowVolume = applyRetrigVolMod(voice.rowVolume, voice.retrigVolMod)
                    voice.channelVolume = voice.rowVolume
                }
            }

            // Auto-vibrato (instrument-supplied sample LFO) — added on top of pitchToMixer.
            val autoVibDelta = advanceAutoVibrato(voice, inst)

            // Pitch envelope contribution: env value 0..1, 0.5 = unity.
            // IT pitch envelope max is ±16 semitones (Schism sndmix.c:455-462 indexes
            // linear_slide_up_table[abs(envpitch)] where envpitch ∈ [-256,+256] and
            // table[255] = 65536·2^(255/192) ≈ 2.504, i.e. 15.94 semitones).
            val pitchEnvDelta = if (voice.hasPfEnv && voice.pfEnvOn && !voice.envPfIsFilter)
                ((voice.envPfValue - 0.5) * 2.0 * 16.0 * 4096.0 / 12.0).toInt()
            else 0

            val finalPitch = (pitchToMixer + autoVibDelta + pitchEnvDelta).coerceIn(0, 0xFFFE)
            voice.playbackRate = computePlaybackRate(inst, finalPitch)

            // Filter envelope (filter mode): scale baseCut by envValue (0..1, 0.5 = unity).
            // Schism filters.c:80-86 computes `cutoff_used = chan->cutoff * (flt_modifier+256)/256`
            // where flt_modifier = (env_value_0..64 - 32) * 8. Mapping TSVM's [0..1] env to Schism's
            // [-256..+256] modifier and accounting for our pre-doubled defaultCutoff (it2taud.py
            // stores IFC*2 in 0..254) gives `currentCutoff = baseCut * envPfValue` — at unity (0.5)
            // the filter sits at IFC, at max (1.0) it opens to 2*IFC, at min (0.0) it closes.
            // If the instrument has no initial cutoff (255 = off), the envelope drives the filter
            // from the maximum active value (254) so the filter can become audible during the note.
            if (voice.hasPfEnv && voice.pfEnvOn && voice.envPfIsFilter) {
                val baseCut = if (inst.defaultCutoff < 255) inst.defaultCutoff else 254
                voice.currentCutoff = (baseCut * voice.envPfValue).toInt().coerceIn(0, 254)
            }

            // Refresh biquad filter coefficients once per tick (only recomputes when changed).
            refreshVoiceFilter(voice)

            // Volume fadeout: after key-off OR Note-Fade NNA, decrement per tick.
            // The 12-bit fadeStep is split across volumeFadeoutLow + low nibble of fadeoutHigh.
            // Divisor selects per-tracker semantics:
            //   FT2 mode (fadeoutCutOnZero=true):  fadeStep / 65536 per tick — matches FT2 .XM (16-bit accumulator, decrement = stored).
            //   IT  mode (fadeoutCutOnZero=false): fadeStep / 1024  per tick — matches Schism (sndmix.c:331-339 + effects.c:1261:
            //                                                                  accumulator 65536, decrement = (stored<<5)<<1 = stored·64).
            // Stored 0: FT2 mode cuts on key-off; IT mode leaves voice playing (no fade).
            if (voice.keyOff || voice.noteFading) {
                val fadeStep = inst.volumeFadeoutLow or ((inst.fadeoutHigh and 0x0F) shl 8)
                if (fadeStep > 0) {
                    val divisor = if (ts.fadeoutCutOnZero) 65536.0 else 1024.0
                    voice.fadeoutVolume = (voice.fadeoutVolume - fadeStep / divisor).coerceAtLeast(0.0)
                    if (voice.fadeoutVolume <= 0.0) voice.active = false
                } else if (ts.fadeoutCutOnZero) {
                    voice.active = false
                }
            }

            advanceEnvelope(voice, inst, tickSec)
            advancePfEnvelope(voice, inst, tickSec)
        }

        // Tempo slide — applied once per tick at the playhead level (any channel that armed it).
        for (voice in ts.voices) {
            if (voice.tempoSlideDir != 0 && ts.tickInRow > 0) {
                val tempoByte = (playhead.bpm - 0x18 + voice.tempoSlideDir * voice.tempoSlideAmount).coerceIn(0, 0xFF)
                playhead.bpm = (tempoByte + 0x18).coerceIn(24, 280)
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
        for (voice in ts.voices) {
            if (voice.funkSpeed == 0 || !voice.active) continue
            val inst = instruments[voice.instrumentId]
            if (inst.sampleLoopEnd <= inst.sampleLoopStart) continue
            voice.funkAccumulator += voice.funkSpeed
            while (voice.funkAccumulator >= 0x80) {
                voice.funkAccumulator -= 0x80
                val loopLen = (inst.sampleLoopEnd - inst.sampleLoopStart).coerceAtLeast(1)
                inst.toggleFunkBit(voice.funkWritePos % loopLen)
                voice.funkWritePos = (voice.funkWritePos + 1) % loopLen
            }
        }

        // Background (NNA-ghost) voices: passive maintenance only — envelopes, fadeout, filter,
        // and pitch recompute. No row-driven effects (vibrato/tremolo/arp/Q/etc.) ever target
        // background voices; they continue from the moment of ghosting until they fade or end.
        val bgIt = ts.backgroundVoices.iterator()
        while (bgIt.hasNext()) {
            val bg = bgIt.next()
            if (!bg.active) { bgIt.remove(); continue }
            val inst = instruments[bg.instrumentId]
            advanceEnvelope(bg, inst, tickSec)
            advancePfEnvelope(bg, inst, tickSec)
            if (bg.keyOff || bg.noteFading) {
                val fadeStep = inst.volumeFadeoutLow or ((inst.fadeoutHigh and 0x0F) shl 8)
                if (fadeStep > 0) {
                    val divisor = if (ts.fadeoutCutOnZero) 65536.0 else 1024.0
                    bg.fadeoutVolume = (bg.fadeoutVolume - fadeStep / divisor).coerceAtLeast(0.0)
                } else if (ts.fadeoutCutOnZero) {
                    bg.active = false
                    bgIt.remove()
                    continue
                }
            }
            // Auto-vibrato keeps running on backgrounds — it's an instrument-intrinsic LFO.
            val autoVibDelta = advanceAutoVibrato(bg, inst)
            val pitchEnvDelta = if (bg.hasPfEnv && bg.pfEnvOn && !bg.envPfIsFilter)
                ((bg.envPfValue - 0.5) * 2.0 * 16.0 * 4096.0 / 12.0).toInt()
            else 0
            val finalPitch = (bg.noteVal + autoVibDelta + pitchEnvDelta).coerceIn(0, 0xFFFE)
            bg.playbackRate = computePlaybackRate(inst, finalPitch)
            // Filter-mode pf envelope: same scaling rule as foreground.
            if (bg.hasPfEnv && bg.pfEnvOn && bg.envPfIsFilter) {
                val baseCut = if (inst.defaultCutoff < 255) inst.defaultCutoff else 254
                bg.currentCutoff = (baseCut * bg.envPfValue).toInt().coerceIn(0, 254)
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

    private fun advanceTrackerCue(ts: TrackerState, playhead: Playhead) {
        val instr = cueSheet[ts.cuePos].instruction
        if (instr is PlayInstHalt) { playhead.isPlaying = false; return }
        ts.cuePos = when (instr) {
            is PlayInstGoBack -> (ts.cuePos - instr.arg).coerceAtLeast(0)
            is PlayInstSkip   -> (ts.cuePos + instr.arg).coerceAtMost(1023)
            else              -> (ts.cuePos + 1).coerceAtMost(1023)
        }
        playhead.position = ts.cuePos
    }

    // Per TAUD_NOTE_EFFECTS.md §S$Bx00: on pattern change reset loop_start_row and loop_count.
    private fun resetPatternLoopState(ts: TrackerState) {
        for (voice in ts.voices) {
            voice.loopStartRow = 0
            voice.loopCount = 0
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
                if (!voice.active || voice.muted) continue
                val voiceInst = instruments[voice.instrumentId]
                val s = applyTaudVoiceFx(voice, applyVoiceFilter(voice, fetchTrackerSample(voice, voiceInst)))
                val instGv = voiceInst.instGlobalVolume / 255.0
                // Volume swing bias (random per-trigger, ±randomVolBias of 0..255 units folded into the 0..63 row volume).
                val swingScale = 1.0 + voice.randomVolBias / 255.0
                // Volume envelope is bypassed (treated as unity) when S $77 has disabled it.
                val effEnvVol = if (voice.volEnvOn) voice.envVolume else 1.0
                val vol = effEnvVol * voice.fadeoutVolume * (voice.rowVolume / 63.0) *
                          swingScale * gvol * mvol * instGv * playhead.masterVolume / 255.0
                val pan = if (voice.hasPanEnv && voice.panEnvOn) {
                    val envPanRaw = (voice.envPan * 255.0).roundToInt().coerceIn(0, 255)
                    (voice.channelPan + envPanRaw - 128 + voice.randomPanBias).coerceIn(0, 255)
                } else (voice.channelPan + voice.randomPanBias).coerceIn(0, 255)
                val lGain: Double
                val rGain: Double
                when (ts.panLaw) {
                    1 -> { // equal-power: constant loudness at centre (0.707 each)
                        lGain = cos(PI * pan / 512.0)
                        rGain = sin(PI * pan / 512.0)
                    }
                    else -> { // linear balance (tracker default): centre gives 0 dB on both channels
                        lGain = if (pan < 0x80) 1.0 else 1.0 - (pan - 128.0) / 128.0
                        rGain = if (pan < 0x80) pan / 128.0 else 1.0
                    }
                }
                mixL += s * vol * lGain
                mixR += s * vol * rGain
            }
            // Background (NNA-ghost) voices — same per-sample mixing path as foreground, but
            // they live in a mixer-private pool that no row event can address.
            for (bg in ts.backgroundVoices) {
                if (!bg.active || bg.muted) continue
                val bgInst = instruments[bg.instrumentId]
                val s = applyTaudVoiceFx(bg, applyVoiceFilter(bg, fetchTrackerSample(bg, bgInst)))
                val instGv = bgInst.instGlobalVolume / 255.0
                val swingScale = 1.0 + bg.randomVolBias / 255.0
                val effEnvVol = if (bg.volEnvOn) bg.envVolume else 1.0
                val vol = effEnvVol * bg.fadeoutVolume * (bg.rowVolume / 63.0) *
                          swingScale * gvol * mvol * instGv * playhead.masterVolume / 255.0
                val pan = if (bg.hasPanEnv && bg.panEnvOn) {
                    val envPanRaw = (bg.envPan * 255.0).roundToInt().coerceIn(0, 255)
                    (bg.channelPan + envPanRaw - 128 + bg.randomPanBias).coerceIn(0, 255)
                } else (bg.channelPan + bg.randomPanBias).coerceIn(0, 255)
                val lGain: Double
                val rGain: Double
                when (ts.panLaw) {
                    1 -> { lGain = cos(PI * pan / 512.0); rGain = sin(PI * pan / 512.0) }
                    else -> {
                        lGain = if (pan < 0x80) 1.0 else 1.0 - (pan - 128.0) / 128.0
                        rGain = if (pan < 0x80) pan / 128.0 else 1.0
                    }
                }
                mixL += s * vol * lGain
                mixR += s * vol * rGain
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
                if (ts.rowIndex >= 64) {
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
        var instruction: PlayInstruction = PlayInstNop
    ) {
        // Cue layout (32 bytes, 20 voices, 12-bit pattern numbers):
        //   bytes  0-9:  packed low nybbles  (byte i => voice i*2 in hi, voice i*2+1 in lo)
        //   bytes 10-19: packed mid nybbles  (same packing)
        //   bytes 20-29: packed high nybbles (same packing)
        //   byte  30:    instruction
        //   byte  31:    unused
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
            30 -> { instruction = when {
                    byte >= 128 -> PlayInstGoBack(byte and 127)
                    byte in 16..31 -> PlayInstSkip(byte and 15)
                    byte == 1 -> PlayInstHalt
                    else -> PlayInstNop
            } }
            31 -> {}
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
            30 -> when (instruction) {
                is PlayInstGoBack -> (0b10000000 or instruction.arg).toByte()
                is PlayInstSkip   -> (0b00010000 or instruction.arg).toByte()
                is PlayInstHalt   -> 1
                else              -> 0
            }
            31 -> 0
            else -> throw InternalError("Bad offset $index")
        }
    }

    internal open class PlayInstruction(val arg: Int)
    internal class PlayInstGoBack(arg: Int) : PlayInstruction(arg)
    internal class PlayInstSkip(arg: Int) : PlayInstruction(arg)
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
    }

    class Voice {
        var active = false
        var muted = false
        var instrumentId = 0
        var samplePos = 0.0
        var playbackRate = 1.0
        var forward = true

        // -1 for live foreground voices held by TrackerState.voices[]; 0..19 for background
        // (mixer-private) ghosts spawned by NNA on the matching channel index.
        var sourceChannel = -1
        // -1 = use instrument-default NNA; otherwise overrides the next NNA event on this voice
        // (see S $73..$76). Cleared on every fresh trigger.
        var nnaOverride = -1
        // Per-voice envelope gates (S $77..$7C). When false the corresponding envelope is frozen
        // *and* its value is treated as unity by the mixer / pitch path.
        var volEnvOn = true
        var panEnvOn = true
        var pfEnvOn = true
        // Note-Fade NNA flag — triggers volume fadeout without sustain release (vs keyOff which
        // also breaks the volume envelope's sustain loop). Both paths feed the same fade decay.
        var noteFading = false

        // Volumes: channel volume is the persistent base; rowVolume tracks per-tick output (set per row from channel volume + volume column).
        var channelVolume = 0x3F           // $00..$3F (default full)
        var rowVolume = 63                 // $00..$3F effective output volume after slides
        var channelPan = 0x80              // 8-bit; $80 centre. Cell column packs into 6-bit, S$80xx writes the full 8-bit.
        var rowPan = 32                    // 6-bit pan used by mixer, derived from channelPan

        var keyOff = false
        var envIndex = 0
        var envTimeSec = 0.0
        var envVolume = 1.0
        var envPanIndex = 0
        var envPanTimeSec = 0.0
        var envPan = 0.5                   // 0.0=full-left, 1.0=full-right, 0.5=centre
        var hasPanEnv = false

        // Pitch / filter envelope (instrument-supplied, byte 19-20 + bytes 121-170).
        var hasPfEnv = false
        var envPfIndex = 0
        var envPfTimeSec = 0.0
        var envPfValue = 0.5               // 0.0..1.0; 0.5 = unity (no pitch shift / unmodulated cutoff)
        var envPfIsFilter = false          // mirror of inst.pfEnvSustain bit 7 latched at trigger

        // Volume fadeout — engaged after key-off, decays to 0 at rate inst.volumeFadeoutLow.
        var fadeoutVolume = 1.0

        // Auto-vibrato (per-sample on the IT side, hoisted to the instrument here).
        var autoVibPhase = 0               // 8-bit phase counter
        var autoVibTicksSinceTrigger = 0   // for sweep ramp-up

        // Filter / cutoff state — drives the per-voice IT-compatible 2-pole resonant LPF.
        // Convention: 255 = filter off (matches IT's high-bit-clear sentinel);
        //             0..254 = active range mirroring IT 0..127 at double resolution.
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
        // Snapshot of cutoff/resonance the cached coefficients correspond to.
        var filterCutoffCached = -1
        var filterResonanceCached = -1

        // Per-trigger random offsets from RV / RP swing (added to base vol/pan).
        var randomVolBias = 0              // signed
        var randomPanBias = 0              // signed

        // Pitch state (4096-TET units, signed when slid).
        var noteVal = 0xFFFF               // The currently sounding base note (no per-row vibrato/arp added)
        var basePitch = 0x4000             // Saved pre-effect pitch for vibrato/arp/glissando overlay
        // Amiga-mode period state, persisted across ticks so multi-tick E/F slides don't lose
        // sub-noteVal precision through repeated round-trip rounding (see amigaSlideTick).
        // -1.0 means "needs reseed from current noteVal".
        var amigaPeriod: Double = -1.0

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

        // Tempo slide (T $00xy) — per-channel because T is a per-channel effect, but we apply globally via playhead.
        var tempoSlideDir = 0              // 0 = none, -1 = down, +1 = up
        var tempoSlideAmount = 0

        // Global volume slide (W $xy00) — per-channel, applied to playhead.globalVolume on tick > 0.
        var wSlideDir = 0                  // 0 = none, -1 = down, +1 = up
        var wSlideAmount = 0

        // Volume / pan column slides (selectors 1/2/3 from TAUD_NOTE_EFFECTS.md §"Volume column effects").
        var volColSlideUp = 0
        var volColSlideDown = 0
        var panColSlideRight = 0
        var panColSlideLeft = 0

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
    }

    class TrackerState {
        var cuePos = 0
        var rowIndex = 0
        var tickInRow = 0
        var samplesIntoTick = 0.0
        var firstRow = true
        val voices = Array(20) { Voice() }

        // Global mixer config (effect 1).
        var panLaw = 0      // 0 = linear balance (default), 1 = equal-power
        var amigaMode = false  // false = linear pitch slides, true = Amiga period-space slides
        var fadeoutCutOnZero = false  // false = IT (stored 0 ⇒ no fadeout); true = FT2 (stored 0 ⇒ cut on key-off)

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
        var bpm: Int = 125,                // BPM, derived from tempoByte + 24. Spec default $65 ⇒ 125 BPM.
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
            8 -> (bpm - 24).toByte()
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
                    trackerState?.let { ts ->
                        ts.panLaw = byte and 1
                        ts.amigaMode = (byte and 2) != 0
                        ts.fadeoutCutOnZero = (byte and 4) != 0
                    }
                }
                8 -> { bpm = byte + 24 }
                9 -> { tickRate = byte }
                else -> throw InternalError("Bad offset $index")
            }
        }

        /*fun getSamplingRate() = 30000 - ((bpm - 24).and(255) or tickRate.and(255).shl(8)).toShort().toInt()
        fun setSamplingRate(rate: Int) {
            val rateDiff = (rate.coerceIn(0, 95535) - 30000).toShort().toInt()
            bpm = rateDiff.and(255) + 24
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
                ts.panLaw = initialGlobalFlags and 1
                ts.amigaMode = (initialGlobalFlags and 2) != 0
                ts.fadeoutCutOnZero = (initialGlobalFlags and 4) != 0
                ts.voices.forEach {
                    it.active = false
                    it.channelVolume = 0x3F
                    it.rowVolume = 0x3F
                    it.channelPan = 0x80
                    it.rowPan = 32
                    it.glissandoOn = false
                    it.loopStartRow = 0
                    it.loopCount = 0
                    it.funkSpeed = 0
                    it.funkAccumulator = 0
                    it.funkWritePos = 0
                    it.muted = false
                    it.nnaOverride = -1
                    it.volEnvOn = true; it.panEnvOn = true; it.pfEnvOn = true
                    it.noteFading = false
                }
                ts.backgroundVoices.clear()
            }
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
     * 192-byte instrument record (terranmon.txt:1997-2070).
     * Layout:
     *   0..3   u32 sample pointer
     *   4..5   u16 sample length
     *   6..7   u16 sampling rate at Middle C (0x5000) // NOTE: Taud treats middle C as C4, but some trackers show you C4 even if they are internally C5. Best practice: copy the value as-is.
     *   8..9   u16 play start
     *   10..11 u16 loop start
     *   12..13 u16 loop end
     *   14     u8  sample flags (low 2 bits = loop mode 0..3)
     *   15..16 u16 volume envelope flags    (0b 0ut sssss pcb eeeee)
     *   17..18 u16 panning envelope flags
     *   19..20 u16 pitch/filter envelope flags
     *   21..70  Bit16×25 volume envelope points (value 0x00-0x3F + minifloat dt)
     *   71..120 Bit16×25 panning envelope points (value 0x00-0xFF, 0x80=centre)
     *   121..170 Bit16×25 pitch/filter envelope points
     *   171    u8 instrument global volume
     *   172    u8 volume fadeout low bits
     *   173    u8 fadeout high bits (low nibble; 0b 0000 ffff)
     *   174    u8 volume swing
     *   175    u8 vibrato speed (FT2 instrumentwise; IT Vis rescaled to 0..255)
     *   176    u8 vibrato sweep (FT2-only ramp ticks; 0 for IT)
     *   177    u8 default pan
     *   178..179 u16 pitch-pan centre (4096-TET)
     *   180    s8 pitch-pan separation
     *   181    u8 pan swing
     *   182    u8 default cutoff
     *   183    u8 default resonance
     *   184..185 u16 sample detune (4096-TET, signed stored as u16)
     *   186    u8 instrument flag (0b 000 www nn — NNA bits 0-1, vib waveform bits 2-4)
     *                   NNA: 00=note off, 01=note cut, 10=continue, 11=note fade
     *                   waveform: 0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (FT2)
     *   187    u8 vibrato depth (0..255 full range)
     *   188    u8 vibrato rate  (0..255 full range — IT samplewise Vir)
     *   189    u8 duplicate-check / action (IT-only — 0b 0000 aadd)
     *                   dd  = DCT (Duplicate Check Type) 0=off, 1=note, 2=sample, 3=instrument
     *                   aa  = DCA (Duplicate Check Action) 0=note cut, 1=note off, 2=note fade
     *   190..191 byte[2] reserved
     */
    data class TaudInst(
        var index: Int,

        var samplePtr: Int,                 // 32-bit sample bin offset
        var sampleLength: Int,
        var samplingRate: Int,              // rate at MIDDLE_C
        var samplePlayStart: Int,
        var sampleLoopStart: Int,
        var sampleLoopEnd: Int,
        var loopMode: Int,                  // byte 14, low 3 bits (bits 0-1: loop kind, bit 2: sustain)
        var volEnvSustain: Int,             // bytes 15-16 (16-bit, see flag layout)
        var panEnvSustain: Int,             // bytes 17-18
        var pfEnvSustain: Int,              // bytes 19-20 (pitch/filter)
        var instGlobalVolume: Int,          // byte 171
        var volEnvelopes: Array<TaudInstEnvPoint>,   // 25 points
        var panEnvelopes: Array<TaudInstEnvPoint>,   // 25 points
        var pfEnvelopes: Array<TaudInstEnvPoint>,    // 25 points (pitch/filter)
        var volumeFadeoutLow: Int,          // byte 172
        var fadeoutHigh: Int,               // byte 173 (low nibble — 0b 0000 ffff)
        var volumeSwing: Int,               // byte 174
        var vibratoSpeed: Int,              // byte 175
        var vibratoSweep: Int,              // byte 176 (FT2 ramp ticks)
        var defaultPan: Int,                // byte 177
        var pitchPanCentre: Int,            // bytes 178-179
        var pitchPanSeparation: Int,        // byte 180 (signed)
        var panSwing: Int,                  // byte 181
        var defaultCutoff: Int,             // byte 182
        var defaultResonance: Int,          // byte 183
        var sampleDetune: Int,              // bytes 184-185 (signed 4096-TET stored as u16)
        var instrumentFlag: Int,            // byte 186 (NNA + vibrato waveform)
        var vibratoDepth: Int,              // byte 187 (0..255 full range)
        var vibratoRate: Int,               // byte 188 (IT samplewise Vir)
        var dupCheckFlag: Int               // byte 189 (DCT bits 0-1, DCA bits 2-3)
    ) {
        constructor(index: Int) : this(
            index, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF,
            Array(25) { TaudInstEnvPoint(0x3F, ThreeFiveMiniUfloat(0)) },
            Array(25) { TaudInstEnvPoint(0x80, ThreeFiveMiniUfloat(0)) },
            Array(25) { TaudInstEnvPoint(0x80, ThreeFiveMiniUfloat(0)) },
            0, 0, 0, 0, 0, 0x80, 0x5000, 0, 0, 0xFF, 0,
            0, 0, 0, 0, 0
        )

        /** Sample-flag byte 14 bit 2 — when set, the sample loop is a sustain loop:
         *  it loops while the note is held and is escaped on key-off. */
        val sampleLoopSustain: Boolean get() = (loopMode and 0x04) != 0
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

        // Reserved padding at offsets 190..191 (2 bytes per instrument).
        private val reserved = ByteArray(2)

        // Funk repeat (S$Fx00) bit-mask — non-destructive XOR overlay across the loop region.
        // Lazily allocated; a 1-bit flips the byte, a 0-bit leaves it intact.
        var funkMask: ByteArray? = null
        fun toggleFunkBit(loopOffset: Int) {
            val len = (sampleLoopEnd - sampleLoopStart).coerceAtLeast(1)
            val mask = funkMask ?: ByteArray((len + 7) / 8).also { funkMask = it }
            val idx = loopOffset.coerceIn(0, len - 1)
            mask[idx / 8] = (mask[idx / 8].toInt() xor (1 shl (idx and 7))).toByte()
        }
        fun funkBit(loopOffset: Int): Boolean {
            val mask = funkMask ?: return false
            val len = (sampleLoopEnd - sampleLoopStart).coerceAtLeast(1)
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
            15 -> volEnvSustain.toByte()
            16 -> volEnvSustain.ushr(8).toByte()
            17 -> panEnvSustain.toByte()
            18 -> panEnvSustain.ushr(8).toByte()
            19 -> pfEnvSustain.toByte()
            20 -> pfEnvSustain.ushr(8).toByte()

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
            189 -> dupCheckFlag.toByte()
            in 190..191 -> reserved[offset - 190]
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
            15 -> { volEnvSustain = (volEnvSustain and 0xff00) or byte }
            16 -> { volEnvSustain = (volEnvSustain and 0x00ff) or (byte shl 8) }
            17 -> { panEnvSustain = (panEnvSustain and 0xff00) or byte }
            18 -> { panEnvSustain = (panEnvSustain and 0x00ff) or (byte shl 8) }
            19 -> { pfEnvSustain = (pfEnvSustain and 0xff00) or byte }
            20 -> { pfEnvSustain = (pfEnvSustain and 0x00ff) or (byte shl 8) }

            in 21..70  -> envPointSet(volEnvelopes, 21,  offset, byte)
            in 71..120 -> envPointSet(panEnvelopes, 71,  offset, byte)
            in 121..170 -> envPointSet(pfEnvelopes,  121, offset, byte)

            171 -> { instGlobalVolume = byte and 0xFF }
            172 -> { volumeFadeoutLow = byte and 0xFF }
            173 -> { fadeoutHigh = byte and 0x0F }   // low nibble only (0b 0000 ffff)
            174 -> { volumeSwing = byte and 0xFF }
            175 -> { vibratoSpeed = byte and 0xFF }
            176 -> { vibratoSweep = byte and 0xFF }
            177 -> { defaultPan = byte and 0xFF }
            178 -> { pitchPanCentre = (pitchPanCentre and 0xff00) or byte }
            179 -> { pitchPanCentre = (pitchPanCentre and 0x00ff) or (byte shl 8) }
            180 -> { pitchPanSeparation = byte.toByte().toInt() }   // signed
            181 -> { panSwing = byte and 0xFF }
            182 -> { defaultCutoff = byte and 0xFF }
            183 -> { defaultResonance = byte and 0xFF }
            184 -> { sampleDetune = (sampleDetune and 0xff00) or byte }
            185 -> { sampleDetune = (sampleDetune and 0x00ff) or (byte shl 8) }
            186 -> { instrumentFlag = byte and 0xFF }
            187 -> { vibratoDepth = byte and 0xFF }
            188 -> { vibratoRate = byte and 0xFF }
            189 -> { dupCheckFlag = byte and 0x0F }   // DCT (bits 0-1) + DCA (bits 2-3)
            in 190..191 -> { reserved[offset - 190] = byte.toByte() }
            else -> throw InternalError("Bad offset $offset")
        }
    }



}