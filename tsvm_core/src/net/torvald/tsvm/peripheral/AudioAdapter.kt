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
import net.torvald.tsvm.getHashStr
import net.torvald.tsvm.toInt
import java.io.ByteArrayInputStream
import kotlin.math.pow
import kotlin.math.roundToInt

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
        const val TRACKER_C3 = 0x4000
    }

    internal val sampleBin = UnsafeHelper.allocate(770048L, this)
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
            in 0..770047 -> sampleBin[addr]
            in 770048..786431 -> (adi - 770048).let { instruments[it / 64].getByte(it % 64) }
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
            in 0..770047 -> { sampleBin[addr] = byte }
            in 770048..786431 -> (adi - 770048).let { instruments[it / 64].setByte(it % 64, bi) }
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
    //   0x0A..0x23 : letters A..Z (A=0x0A speed, B=0x0B order jump,
    //                C=0x0C pattern break, D=0x0D vol slide, E=0x0E pitch
    //                down, F=0x0F pitch up, G=0x10 tone porta,
    //                H=0x11 vibrato, I=0x12 tremor, J=0x13 arpeggio,
    //                K=0x14 K, L=0x15 L, O=0x18 sample offset,
    //                Q=0x1A retrig, R=0x1B tremolo, S=0x1C subcommands,
    //                T=0x1D tempo, U=0x1E fine vibrato, V=0x1F global vol,
    //                W=0x20 panbrello).
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

    // Funk repeat advance table (S $Fx00). See TAUD_NOTE_EFFECTS.md §S$Fx.
    private val FUNK_TABLE = intArrayOf(
        0, 5, 6, 7, 8, 0xA, 0xB, 0xD, 0x10, 0x13, 0x16, 0x1A, 0x20, 0x2B, 0x40, 0x80
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
    }

    private fun computePlaybackRate(inst: TaudInst, noteVal: Int): Double =
        inst.samplingRate.toDouble() / SAMPLING_RATE * 2.0.pow((noteVal - TRACKER_C3) / 4096.0)

    private fun advanceEnvelope(voice: Voice, inst: TaudInst, tickSec: Double) {
        if (voice.envIndex >= 23) {
            voice.envVolume = inst.envelopes[23].volume / 255.0
            return
        }
        val offset = inst.envelopes[voice.envIndex].offset.toFloat().toDouble()
        if (offset == 0.0) {
            voice.envVolume = inst.envelopes[voice.envIndex].volume / 255.0
            return
        }
        voice.envTimeSec += tickSec
        if (voice.envTimeSec >= offset) {
            voice.envTimeSec -= offset
            voice.envIndex = (voice.envIndex + 1).coerceAtMost(23)
            voice.envVolume = inst.envelopes[voice.envIndex].volume / 255.0
        } else {
            val cur = inst.envelopes[voice.envIndex].volume / 255.0
            val nxt = inst.envelopes[(voice.envIndex + 1).coerceAtMost(23)].volume / 255.0
            voice.envVolume = cur + (nxt - cur) * (voice.envTimeSec / offset)
        }
    }

    private fun fetchTrackerSample(voice: Voice, inst: TaudInst): Double {
        if (inst.index == 0) return 0.0

        val basePtr = inst.samplePtr
        val sampleLen = inst.sampleLength.coerceAtLeast(1)
        val loopStart = inst.sampleLoopStart.toDouble()
        val loopEnd = inst.sampleLoopEnd.toDouble().coerceAtLeast(1.0)
        val binMax = 770047  // sampleBin is 770048 bytes (0..770047)

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
        val s0 = (b0 - 128) / 128.0
        val s1 = (b1 - 128) / 128.0
        val sample = s0 + (s1 - s0) * frac

        if (voice.forward) {
            voice.samplePos += voice.playbackRate
            when (inst.loopMode) {
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
        voice.envIndex = 0
        voice.envTimeSec = 0.0
        voice.envVolume = inst.envelopes[0].volume / 255.0
        voice.noteVal = noteVal
        voice.basePitch = noteVal
        voice.playbackRate = computePlaybackRate(inst, noteVal)
        if (volOverride >= 0) {
            voice.channelVolume = volOverride.coerceIn(0, 0x3F)
        }
        voice.rowVolume = voice.channelVolume
        voice.noteWasCut = false
        // Vibrato/tremolo/panbrello retrigger: reset LFO position when waveform requests it.
        if (voice.vibratoRetrig) voice.vibratoLfoPos = 0
        if (voice.tremoloRetrig) voice.tremoloLfoPos = 0
        if (voice.panbrelloRetrig) voice.panbrelloLfoPos = 0
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
        when (sel) {
            0 -> { voice.channelPan = (value shl 2) or (value ushr 4); voice.rowPan = (voice.channelPan shr 2).coerceIn(0, 63) }
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
            voice.volColSlideUp = 0; voice.volColSlideDown = 0
            voice.panColSlideRight = 0; voice.panColSlideLeft = 0
            voice.rowEffect = row.effect
            voice.rowEffectArg = row.effectArg

            // ── Note ──
            val toneG = (row.effect == EffectOp.OP_G)
            when (row.note) {
                0xFFFF -> {}                                    // no-op
                0x0000 -> voice.active = false                  // key-off (TODO release envelope)
                0xFFFE -> voice.active = false                  // note cut
                else -> {
                    if (toneG && voice.active) {
                        // Tone porta: target the note, do not retrigger sample.
                        voice.tonePortaTarget = row.note
                    } else if ((row.effect == EffectOp.OP_S) && ((row.effectArg ushr 12) and 0xF) == 0xD) {
                        // Note delay: defer trigger to the requested tick.
                        voice.noteDelayTick = (row.effectArg ushr 8) and 0xF
                        voice.delayedNote = row.note
                        voice.delayedInst = row.instrment
                        voice.delayedVol = if (row.volume >= 0) row.volume else -1
                    } else {
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
                    voice.noteVal = (voice.noteVal - mag).coerceIn(0, 0xFFFE); voice.basePitch = voice.noteVal
                    voice.playbackRate = computePlaybackRate(instruments[voice.instrumentId], voice.noteVal)
                } else {
                    voice.slideMode = 1; voice.slideArg = -arg
                }
            }
            EffectOp.OP_F -> {
                val arg = resolveArg(rawArg, voice.mem.ef).also { if (rawArg != 0) voice.mem.ef = it }
                if ((arg and 0xF000) == 0xF000) {
                    val mag = arg and 0x0FFF
                    voice.noteVal = (voice.noteVal + mag).coerceIn(0, 0xFFFE); voice.basePitch = voice.noteVal
                    voice.playbackRate = computePlaybackRate(instruments[voice.instrumentId], voice.noteVal)
                } else {
                    voice.slideMode = 2; voice.slideArg = arg
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
                if (inst.loopMode != 0 && inst.sampleLoopEnd > inst.sampleLoopStart && off > inst.sampleLoopEnd) {
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
                val sp = (rawArg ushr 8) and 0xFF
                val dp = rawArg and 0xFF
                if (sp != 0) voice.mem.wSpeed = sp
                if (dp != 0) voice.mem.wDepth = dp
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
                voice.playbackRate = computePlaybackRate(instruments[voice.instrumentId], voice.noteVal)
            }
            0x3 -> { voice.vibratoWave = x and 3; voice.vibratoRetrig = (x and 4) == 0 }
            0x4 -> { voice.tremoloWave = x and 3; voice.tremoloRetrig = (x and 4) == 0 }
            0x5 -> { voice.panbrelloWave = x and 3; voice.panbrelloRetrig = (x and 4) == 0 }
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
                    } else if (!ts.patternDelayActive) {
                        voice.loopCount--
                        if (voice.loopCount > 0) ts.pendingRowJump = voice.loopStartRow
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
            0xF -> { voice.funkSpeed = x; if (x == 0) voice.funkAccumulator = 0 }
        }
    }

    private fun applyTrackerTick(ts: TrackerState, playhead: Playhead) {
        val tickSec = 2.5 / playhead.bpm
        for (voice in ts.voices) {
            if (!voice.active && voice.noteDelayTick < 0) continue
            val inst = instruments[voice.instrumentId]

            // Note cut.
            if (voice.cutAtTick == ts.tickInRow) {
                voice.rowVolume = 0; voice.channelVolume = 0
                voice.noteWasCut = true
            }

            // Note delay — fire deferred trigger when the requested tick arrives.
            if (voice.noteDelayTick == ts.tickInRow) {
                triggerNote(voice, voice.delayedNote, voice.delayedInst, voice.delayedVol)
                voice.noteDelayTick = -1
            }

            if (!voice.active) { advanceEnvelope(voice, inst, tickSec); continue }

            // Pitch slides (E/F coarse on tick > 0).
            if (ts.tickInRow > 0 && (voice.slideMode == 1 || voice.slideMode == 2)) {
                voice.noteVal = (voice.noteVal + voice.slideArg).coerceIn(0, 0xFFFE)
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

            // Panbrello (W) — modulates panning around base.
            if (voice.panbrelloActive) {
                val sine = lfoSample(voice.panbrelloLfoPos, voice.panbrelloWave)
                val panDelta = (sine * voice.mem.wDepth) shr 9
                voice.rowPan = ((voice.channelPan ushr 2) + panDelta).coerceIn(0, 0x3F)
                voice.panbrelloLfoPos = (voice.panbrelloLfoPos + voice.mem.wSpeed * 4) and 0xFF
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
                    voice.samplePos = instruments[voice.instrumentId].samplePlayStart.toDouble()
                    voice.envIndex = 0; voice.envTimeSec = 0.0
                    voice.rowVolume = applyRetrigVolMod(voice.rowVolume, voice.retrigVolMod)
                    voice.channelVolume = voice.rowVolume
                }
            }

            // Update playback rate from final pitchToMixer.
            voice.playbackRate = computePlaybackRate(inst, pitchToMixer)

            advanceEnvelope(voice, inst, tickSec)
        }

        // Tempo slide — applied once per tick at the playhead level (any channel that armed it).
        for (voice in ts.voices) {
            if (voice.tempoSlideDir != 0 && ts.tickInRow > 0) {
                val tempoByte = (playhead.bpm - 0x18 + voice.tempoSlideDir * voice.tempoSlideAmount).coerceIn(0, 0xFF)
                playhead.bpm = (tempoByte + 0x18).coerceIn(24, 280)
            }
        }

        // Funk repeat (S$Fx) — advance bit-mask per tick on instruments with active funkSpeed.
        for (voice in ts.voices) {
            if (voice.funkSpeed == 0 || !voice.active) continue
            val inst = instruments[voice.instrumentId]
            if (inst.sampleLoopEnd <= inst.sampleLoopStart) continue
            voice.funkAccumulator += FUNK_TABLE[voice.funkSpeed and 0xF]
            while (voice.funkAccumulator >= 0x80) {
                voice.funkAccumulator -= 0x80
                val loopLen = (inst.sampleLoopEnd - inst.sampleLoopStart).coerceAtLeast(1)
                inst.toggleFunkBit(voice.funkWritePos % loopLen)
                voice.funkWritePos = (voice.funkWritePos + 1) % loopLen
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
                if (ts.tickInRow >= playhead.tickRate) {
                    ts.tickInRow = 0
                    advanceRow(ts, playhead)
                }
            }

            var mixL = 0.0
            var mixR = 0.0
            val gvol = playhead.globalVolume / 255.0
            for (voice in ts.voices) {
                if (!voice.active || voice.muted) continue
                val s = fetchTrackerSample(voice, instruments[voice.instrumentId])
                val vol = voice.envVolume * voice.rowVolume / 63.0 * gvol * playhead.masterVolume / 255.0
                mixL += s * vol * (63 - voice.rowPan) / 63.0
                mixR += s * vol * voice.rowPan / 63.0
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
        ts.pendingOrderJump = -1
        ts.pendingRowJump = -1

        when {
            pendingB >= 0 -> {
                ts.cuePos = pendingB.coerceAtMost(1023)
                ts.rowIndex = if (pendingC >= 0) pendingC else 0
                playhead.position = ts.cuePos
            }
            pendingC >= 0 -> {
                // Pattern break — advance order by one (or honour cue's own instruction), then jump to row.
                advanceTrackerCue(ts, playhead)
                ts.rowIndex = pendingC.coerceIn(0, 63)
            }
            else -> {
                ts.rowIndex++
                if (ts.rowIndex >= 64) {
                    ts.rowIndex = 0
                    advanceTrackerCue(ts, playhead)
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
        // W (panbrello) — private speed and depth.
        var wSpeed: Int = 0
        var wDepth: Int = 0
        // Private slots
        var d: Int = 0
        var i: Int = 0
        var j: Int = 0
        var o: Int = 0
        var q: Int = 0
        var tslide: Int = 0
    }

    class Voice {
        var active = false
        var muted = false
        var instrumentId = 0
        var samplePos = 0.0
        var playbackRate = 1.0
        var forward = true

        // Volumes: channel volume is the persistent base; rowVolume tracks per-tick output (set per row from channel volume + volume column).
        var channelVolume = 0x3F           // $00..$3F (default full)
        var rowVolume = 63                 // $00..$3F effective output volume after slides
        var channelPan = 0x80              // 8-bit; $80 centre. Cell column packs into 6-bit, S$80xx writes the full 8-bit.
        var rowPan = 32                    // 6-bit pan used by mixer, derived from channelPan

        var envIndex = 0
        var envTimeSec = 0.0
        var envVolume = 1.0

        // Pitch state (4096-TET units, signed when slid).
        var noteVal = 0xFFFF               // The currently sounding base note (no per-row vibrato/arp added)
        var basePitch = 0x4000             // Saved pre-effect pitch for vibrato/arp/glissando overlay

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

        // Panbrello (W) — uses memW.
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

        // Volume / pan column slides (selectors 1/2/3 from TAUD_NOTE_EFFECTS.md §"Volume column effects").
        var volColSlideUp = 0
        var volColSlideDown = 0
        var panColSlideRight = 0
        var panColSlideLeft = 0

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

        // Pending row-end events (set during a row by B/C; consumed at row end).
        var pendingOrderJump = -1          // -1 = none; otherwise the order index to jump to
        var pendingRowJump = -1            // -1 = none; otherwise the row index for the next pattern

        // Pattern-delay state (S$Ex) — number of additional row-repetitions remaining.
        var patternDelayRemaining = 0
        var patternDelayActive = false     // true while inside a delay block (gates SBx decrement)

        // Channel index of the SEx that won this row (lowest channel wins ties).
        var sexWinningChannel = -1

        // Pre-allocated mix buffers for dither path (reused each audio chunk).
        val mixLeft  = FloatArray(TRACKER_CHUNK)
        val mixRight = FloatArray(TRACKER_CHUNK)
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

        var pcmQueue: Queue<ByteArray> = Queue<ByteArray>(),
        var pcmQueueSizeIndex: Int = 0,
        val audioDevice: OpenALBufferedAudioDevice,
    ) {
        var trackerState: TrackerState? = TrackerState()  // default mode is tracker (isPcmMode=false)

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
            7 -> 0
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
                7 -> if (isPcmMode) { pcmUpload = true } else {}
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
            trackerState?.let { ts ->
                ts.cuePos = 0; ts.rowIndex = 0; ts.tickInRow = 0
                ts.samplesIntoTick = 0.0; ts.firstRow = true
                ts.pendingOrderJump = -1; ts.pendingRowJump = -1
                ts.patternDelayRemaining = 0; ts.patternDelayActive = false
                ts.sexWinningChannel = -1
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
                }
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

    data class TaudInstVolEnv(var volume: Int, var offset: ThreeFiveMiniUfloat)
    data class TaudInst(
        var index: Int,

        var samplePtr: Int, // 20-bit number
        var sampleLength: Int,
        var samplingRate: Int,
        var samplePlayStart: Int,
        var sampleLoopStart: Int,
        var sampleLoopEnd: Int,
        // flags
        var loopMode: Int,
        var envelopes: Array<TaudInstVolEnv> // first int: volume (0..255), second int: offsets (minifloat indices)
    ) {
        constructor(index: Int) : this(index, 0, 0, 0, 0, 0, 0, 0, Array(24) { TaudInstVolEnv(0, ThreeFiveMiniUfloat(0)) })

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

        fun getByte(offset: Int): Byte = when (offset) {
            0 -> samplePtr.toByte()
            1 -> samplePtr.ushr(8).toByte()

            2 -> sampleLength.toByte()
            3 -> sampleLength.ushr(8).toByte()

            4 -> samplingRate.toByte()
            5 -> samplingRate.ushr(8).toByte()

            6 -> samplePlayStart.toByte()
            7 -> samplePlayStart.ushr(8).toByte()

            8 -> sampleLoopStart.toByte()
            9 -> sampleLoopStart.ushr(8).toByte()

            10 -> sampleLoopEnd.toByte()
            11 -> sampleLoopEnd.ushr(8).toByte()

            12 -> (samplePtr.ushr(16).and(15).shl(4) or loopMode.and(3)).toByte()
            13,14,15 -> 0
            in 16..63 step 2 -> envelopes[(offset - 16) / 2].volume.toByte()
            in 17..63 step 2 -> envelopes[(offset - 17) / 2].offset.index.toByte()
            else -> throw InternalError("Bad offset $offset")
        }

        fun setByte(offset: Int, byte: Int) = when (offset) {
            0 -> { samplePtr = (samplePtr and 0xfff00) or byte }
            1 -> { samplePtr = (samplePtr and 0x000ff) or (byte shl 8) }

            2 -> { sampleLength = (sampleLength and 0xff00) or byte }
            3 -> { sampleLength = (sampleLength and 0x00ff) or (byte shl 8) }

            4 -> { samplingRate = (samplingRate and 0xff00) or byte }
            5 -> { samplingRate = (samplingRate and 0x00ff) or (byte shl 8) }

            6 -> { samplePlayStart = (samplePlayStart and 0xff00) or byte }
            7 -> { samplePlayStart = (samplePlayStart and 0x00ff) or (byte shl 8) }

            8 -> { sampleLoopStart = (sampleLoopStart and 0xff00) or byte }
            9 -> { sampleLoopStart = (sampleLoopStart and 0x00ff) or (byte shl 8) }

            10 -> { sampleLoopEnd = (sampleLoopEnd and 0xff00) or byte }
            11 -> { sampleLoopEnd = (sampleLoopEnd and 0x00ff) or (byte shl 8) }

            12 -> {
                samplePtr = if (byte and 0b1111_0000 != 0) samplePtr or ((byte ushr 4) shl 16)
                            else samplePtr and 0x0ffff
                loopMode = byte and 3
            }
            13, 14, 15 -> {}

            in 16..63 step 2 -> envelopes[(offset - 16) / 2].volume = byte
            in 17..63 step 2 -> envelopes[(offset - 17) / 2].offset = ThreeFiveMiniUfloat(byte)
            else -> throw InternalError("Bad offset $offset")
        }
    }



}