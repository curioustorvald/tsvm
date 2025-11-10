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

//                printdbg("P${playhead.index+1} Vol ${playhead.masterVolume}; LpP ${playhead.pcmUploadLength}; start playback...")
//                    printdbg(""+(0..42).joinToString { String.format("%.2f", samples[it]) })

                        playhead.audioDevice.writeSamplesUI8(samples, 0, samples.size)

//                printdbg("P${playhead.index+1} go back to spinning")

                        Thread.sleep(12)
                    }
                    else if (playhead.isPlaying && writeQueue.isEmpty) {
                        printdbg("!! QUEUE EXHAUSTED !! QUEUE EXHAUSTED !! QUEUE EXHAUSTED !! QUEUE EXHAUSTED !! QUEUE EXHAUSTED !! QUEUE EXHAUSTED ")

                        // TODO: wait for 1-2 seconds then finally stop the device
//                    playhead.audioDevice.stop()

                        Thread.sleep(12)
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
    }

    internal val sampleBin = UnsafeHelper.allocate(114687L, this)
    internal val instruments = Array(256) { TaudInst() }
    internal val playdata = Array(256) { Array(64) { TaudPlayData(0,0,0,0,0,0,0,0) } }
    internal val playheads: Array<Playhead>
    internal val cueSheet = Array(2048) { PlayCue() }
    internal val pcmBin = UnsafeHelper.allocate(65536L, this)

    internal val mediaFrameBin = UnsafeHelper.allocate(1728, this)
    internal val mediaDecodedBin = UnsafeHelper.allocate(2304, this)

    @Volatile private var mp2Busy = false

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
        writeQueueingRunnables = Array(4) { WriteQueueingRunnable(playheads[it], pcmBin) }
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
            in 0..114687 -> sampleBin[addr]
            in 114688..131071 -> (adi - 114688).let { instruments[it / 64].getByte(it % 64) }
            in 131072..262143 -> (adi - 131072).let { playdata[it / (8*64)][(it / 8) % 64].getByte(it % 8) }
            in 262144..327679 -> tadInputBin[addr - 262144]   // TAD input buffer (65536 bytes)
            in 327680..393215 -> tadDecodedBin[addr - 327680]  // TAD decoded output (65536 bytes)
            else -> peek(addr % 393216)
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toUint()
        when (adi) {
            in 0..114687 -> { sampleBin[addr] = byte }
            in 114688..131071 -> (adi - 114688).let { instruments[it / 64].setByte(it % 64, bi) }
            in 131072..262143 -> (adi - 131072).let { playdata[it / (8*64)][(it / 8) % 64].setByte(it % 8, bi) }
            in 262144..327679 -> tadInputBin[addr - 262144] = byte   // TAD input buffer
            in 327680..393215 -> tadDecodedBin[addr - 327680] = byte  // TAD decoded output
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
            in 64..2367 -> mediaDecodedBin[addr - 64]
            in 2368..4095 -> mediaFrameBin[addr - 2368]
            in 4096..4097 -> 0
            in 32768..65535 -> (adi - 32768).let {
                cueSheet[it / 16].read(it % 15)
            }
            in 65536..131071 -> pcmBin[addr - 65536]
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
            in 64..2367 -> { mediaDecodedBin[addr - 64] = byte }
            in 2368..4095 -> { mediaFrameBin[addr - 2368] = byte }
            in 32768..65535 -> { (adi - 32768).let {
                cueSheet[it / 16].write(it % 15, bi)
            } }
            in 65536..131071 -> { pcmBin[addr - 65536] = byte }
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
            pcmBin.destroy()
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




    internal data class PlayCue(
        val patterns: IntArray = IntArray(15) { it },
        var instruction: PlayInstruction = PlayInstNop
    ) {
        fun write(index: Int, byte: Int) = when (index) {
            in 0..14 -> { patterns[index] = byte }
            15 -> { instruction = when (byte) {
                    in 128..255 -> PlayInstGoBack(byte and 127)
//                    in 64..127 -> Inst(byte and 63)
//                    in 32..63 -> Inst(byte and 31)
                    in 16..31 -> PlayInstSkip(byte and 15)
//                    in 8..15 -> Inst(byte and 7)
//                    in 4..7 -> Inst(byte and 3)
//                    in 2..3 -> Inst(byte and 1)
//                    1 -> Inst()
                    0 -> PlayInstNop
                    else -> throw InternalError("Bad offset $index")
            } }
            else -> throw InternalError("Bad offset $index")
        }
        fun read(index: Int): Byte = when(index) {
            in 0..14 -> patterns[index].toByte()
            15 -> {
                when (instruction) {
                    is PlayInstGoBack -> (0b10000000 or instruction.arg).toByte()
                    is PlayInstSkip -> (0b00010000 or instruction.arg).toByte()
                    is PlayInstNop -> 0
                    else -> throw InternalError("Bad instruction ${instruction.javaClass.simpleName}")
                }
            }
            else -> throw InternalError("Bad offset $index")
        }
    }

    internal open class PlayInstruction(val arg: Int)
    internal class PlayInstGoBack(arg: Int) : PlayInstruction(arg)
    internal class PlayInstSkip(arg: Int) : PlayInstruction(arg)
    internal object PlayInstNop : PlayInstruction(0)

    class Playhead(
        private val parent: AudioAdapter,
        val index: Int,

        var position: Int = 0,
        var pcmUploadLength: Int = 0,
        var masterVolume: Int = 0,
        var masterPan: Int = 128,
//        var samplingRateMult: ThreeFiveMiniUfloat = ThreeFiveMiniUfloat(32),
        var bpm: Int = 120, // "stored" as 96
        var tickRate: Int = 6,
        var pcmUpload: Boolean = false,

        var pcmQueue: Queue<ByteArray> = Queue<ByteArray>(),
        var pcmQueueSizeIndex: Int = 0,
        val audioDevice: OpenALBufferedAudioDevice,
    ) {
        // flags
        var isPcmMode: Boolean = false
            set(value) {
                if (value != isPcmMode) {
                    resetParams()
                }
                field = value
            }
        var isPlaying: Boolean = false
            set(value) {
                // play last bit from the buffer by feeding 0s
                if (isPlaying && !value) {
//                    println("!! inserting dummy bytes")
                    pcmQueue.addLast(ByteArray(audioDevice.bufferSize * audioDevice.bufferCount))
                }
                field = value
            }

        fun read(index: Int): Byte = when (index) {
            0 -> position.toByte()
            1 -> position.ushr(8).toByte()
            2 -> pcmUploadLength.toByte()
            3 -> pcmUploadLength.ushr(8).toByte()
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
                0 -> if (!isPcmMode) { position = position.and(0xff00) or position } else {}
                1 -> if (!isPcmMode) { position = position.and(0x00ff) or position.shl(8) } else {}
                2 -> { pcmUploadLength = pcmUploadLength.and(0xff00) or pcmUploadLength }
                3 -> { pcmUploadLength = pcmUploadLength.and(0x00ff) or pcmUploadLength.shl(8) }
                4 -> {
                    masterVolume = byte
                    audioDevice.setVolume(masterVolume / 255f)
                }
                5 -> { masterPan = byte }
                6 -> { byte.let {
                    isPcmMode = (it and 0b10000000) != 0
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
        var samplePtr: Int, // 17-bit number
        var sampleLength: Int,
        var samplingRate: Int,
        var samplePlayStart: Int,
        var sampleLoopStart: Int,
        var sampleLoopEnd: Int,
        // flags
        var loopMode: Int,
        var envelopes: Array<TaudInstVolEnv> // first int: volume (0..255), second int: offsets (minifloat indices)
    ) {
        constructor() : this(0, 0, 0, 0, 0, 0, 0, Array(24) { TaudInstVolEnv(0, ThreeFiveMiniUfloat(0)) })

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

            12 -> (samplePtr.ushr(16).and(1).shl(7) or loopMode.and(3)).toByte()
            13,14,15 -> -1
            in 16..63 step 2 -> envelopes[offset - 16].volume.toByte()
            in 17..63 step 2 -> envelopes[offset - 16].offset.index.toByte()
            else -> throw InternalError("Bad offset $offset")
        }

        fun setByte(offset: Int, byte: Int) = when (offset) {
            0 -> { samplePtr = samplePtr.and(0x1ff00) or byte }
            1 -> { samplePtr = samplePtr.and(0x000ff) or byte.shl(8) }

            2 -> { sampleLength = sampleLength.and(0x1ff00) or byte }
            3 -> { sampleLength = sampleLength.and(0x000ff) or byte.shl(8) }

            4 -> { samplingRate = samplingRate.and(0x1ff00) or byte }
            5 -> { samplingRate = samplingRate.and(0x000ff) or byte.shl(8) }

            6 -> { sampleLoopStart = sampleLoopStart.and(0x1ff00) or byte }
            7 -> { sampleLoopStart = sampleLoopStart.and(0x000ff) or byte.shl(8) }

            8 -> { sampleLoopEnd = sampleLoopEnd.and(0x1ff00) or byte }
            9 -> { sampleLoopEnd = sampleLoopEnd.and(0x000ff) or byte.shl(8) }

            10 -> {
                if (byte.and(0b1000_0000) != 0)
                    samplePtr = samplePtr or 0x10000

                loopMode = byte.and(3)
            }

            in 16..63 step 2 -> envelopes[offset - 16].volume = byte
            in 17..63 step 2 -> envelopes[offset - 16].offset = ThreeFiveMiniUfloat(byte)
            else -> throw InternalError("Bad offset $offset")
        }
    }



}