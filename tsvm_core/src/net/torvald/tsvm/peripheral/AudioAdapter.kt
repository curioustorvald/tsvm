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

    private fun decodeTad() {
        tadBusy = true
        try {
            // Read chunk header from tadInputBin
            var offset = 0L

            val sampleCount = (
                    (tadInputBin[offset++].toInt() and 0xFF) or
                            ((tadInputBin[offset++].toInt() and 0xFF) shl 8)
                    )
            val payloadSize = (
                    (tadInputBin[offset++].toInt() and 0xFF) or
                            ((tadInputBin[offset++].toInt() and 0xFF) shl 8) or
                            ((tadInputBin[offset++].toInt() and 0xFF) shl 16) or
                            ((tadInputBin[offset++].toInt() and 0xFF) shl 24)
                    )

            // Decompress payload if needed
            val compressed = ByteArray(payloadSize)
            UnsafeHelper.memcpyRaw(null, tadInputBin.ptr + offset, compressed, UnsafeHelper.getArrayOffset(compressed), payloadSize.toLong())

            val payload: ByteArray = try {
                ZstdInputStream(ByteArrayInputStream(compressed)).use { zstd ->
                    zstd.readBytes()
                }
            } catch (e: Exception) {
                println("ERROR: Zstd decompression failed: ${e.message}")
            } as ByteArray

            // Decode significance maps
            val quantMid = ShortArray(sampleCount)
            val quantSide = ShortArray(sampleCount)

            var payloadOffset = 0
            val midBytes = decodeSigmap2bit(payload, payloadOffset, quantMid, sampleCount)
            payloadOffset += midBytes

            val sideBytes = decodeSigmap2bit(payload, payloadOffset, quantSide, sampleCount)

            // Calculate DWT levels from sample count
            val dwtLevels = calculateDwtLevels(sampleCount)

            // Dequantize
            val dwtMid = FloatArray(sampleCount)
            val dwtSide = FloatArray(sampleCount)
            dequantizeDwtCoefficients(quantMid, dwtMid, sampleCount, tadQuality, dwtLevels)
            dequantizeDwtCoefficients(quantSide, dwtSide, sampleCount, tadQuality, dwtLevels)

            // Inverse DWT
            dwtDD4InverseMultilevel(dwtMid, sampleCount, dwtLevels)
            dwtDD4InverseMultilevel(dwtSide, sampleCount, dwtLevels)

            // Convert to signed PCM8
            val pcm8Mid = ByteArray(sampleCount)
            val pcm8Side = ByteArray(sampleCount)
            for (i in 0 until sampleCount) {
                pcm8Mid[i] = dwtMid[i].coerceIn(-128f, 127f).toInt().toByte()
                pcm8Side[i] = dwtSide[i].coerceIn(-128f, 127f).toInt().toByte()
            }

            // M/S to L/R correlation and write to tadDecodedBin
            for (i in 0 until sampleCount) {
                val m = pcm8Mid[i].toInt()
                val s = pcm8Side[i].toInt()
                var l = m + s
                var r = m - s

                if (l < -128) l = -128
                if (l > 127) l = 127
                if (r < -128) r = -128
                if (r > 127) r = 127

                tadDecodedBin[i * 2L] = (l + 128).toByte()      // Left (PCMu8)
                tadDecodedBin[i * 2L + 1] = (r + 128).toByte()  // Right (PCMu8)
            }

        } catch (e: Exception) {
            e.printStackTrace()
        } finally {
            tadBusy = false
        }
    }

    private fun decodeSigmap2bit(input: ByteArray, offset: Int, values: ShortArray, count: Int): Int {
        val mapBytes = (count * 2 + 7) / 8
        var readPtr = offset + mapBytes
        var otherIdx = 0

        for (i in 0 until count) {
            val bitPos = i * 2
            val byteIdx = offset + bitPos / 8
            val bitOffset = bitPos % 8

            var code = ((input[byteIdx].toInt() and 0xFF) shr bitOffset) and 0x03

            // Handle bit spillover
            if (bitOffset == 7) {
                code = ((input[byteIdx].toInt() and 0xFF) shr 7) or
                       (((input[byteIdx + 1].toInt() and 0xFF) and 0x01) shl 1)
            }

            values[i] = when (code) {
                0 -> 0
                1 -> 1
                2 -> (-1).toShort()
                3 -> {
                    val v = ((input[readPtr].toInt() and 0xFF) or
                            ((input[readPtr + 1].toInt() and 0xFF) shl 8)).toShort()
                    readPtr += 2
                    otherIdx++
                    v
                }
                else -> 0
            }
        }

        return mapBytes + otherIdx * 2
    }

    private fun calculateDwtLevels(chunkSize: Int): Int {
        if (chunkSize < 1024) {
            throw IllegalArgumentException("Chunk size $chunkSize is below minimum 1024")
        }

        var levels = 0
        var size = chunkSize
        while (size > 1) {
            size = size shr 1
            levels++
        }
        return levels - 2  // Maximum decomposition leaves 4-sample approximation
    }

    private fun getQuantizationWeights(quality: Int, dwtLevels: Int): FloatArray {
        // Extended base weights to support up to 16 DWT levels
        val baseWeights = arrayOf(
            /* 0*/floatArrayOf(1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f),
            /* 1*/floatArrayOf(1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f),
            /* 2*/floatArrayOf(1.0f, 1.0f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /* 3*/floatArrayOf(0.2f, 1.0f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /* 4*/floatArrayOf(0.2f, 0.8f, 1.0f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /* 5*/floatArrayOf(0.2f, 0.8f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /* 6*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /* 7*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /* 8*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /* 9*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /*10*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /*11*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /*12*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f, 1.5f),
            /*13*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f, 1.5f),
            /*14*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f, 1.5f),
            /*15*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f, 1.5f),
            /*16*/floatArrayOf(0.2f, 0.2f, 0.8f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.25f, 1.5f)
        )
        val qualityScale = 1.0f + ((3 - quality) * 0.5f).coerceAtLeast(0.0f)
        return FloatArray(dwtLevels) { i -> (baseWeights[dwtLevels][i.coerceIn(0, 15)] * qualityScale).coerceAtLeast(1.0f) }
    }

    private fun dequantizeDwtCoefficients(quantized: ShortArray, coeffs: FloatArray, count: Int, quality: Int, dwtLevels: Int) {
        val weights = getQuantizationWeights(quality, dwtLevels)

        // Calculate sideband boundaries dynamically based on chunk size and DWT levels
        val firstBandSize = count shr dwtLevels
        val sidebandStarts = IntArray(dwtLevels + 2)
        sidebandStarts[0] = 0
        sidebandStarts[1] = firstBandSize
        for (i in 2..dwtLevels + 1) {
            sidebandStarts[i] = sidebandStarts[i - 1] + (firstBandSize shl (i - 2))
        }

        for (i in 0 until count) {
            var sideband = dwtLevels
            for (s in 0 until dwtLevels + 1) {
                if (i < sidebandStarts[s + 1]) {
                    sideband = s
                    break
                }
            }

            val weightIdx = if (sideband == 0) 0 else sideband - 1
            val weight = weights[weightIdx.coerceIn(0, dwtLevels - 1)]
            coeffs[i] = quantized[i].toFloat() * weight
        }
    }

    private fun dwtDD4Inverse1d(data: FloatArray, length: Int) {
        if (length < 2) return

        val temp = FloatArray(length)
        val half = (length + 1) / 2

        // Split into low and high parts
        for (i in 0 until half) {
            temp[i] = data[i]  // Even (low-pass)
        }
        for (i in 0 until length / 2) {
            temp[half + i] = data[half + i]  // Odd (high-pass)
        }

        // Undo update step: s[i] -= 0.25 * (d[i-1] + d[i])
        for (i in 0 until half) {
            val dCurr = if (i < length / 2) temp[half + i] else 0.0f
            val dPrev = if (i > 0 && i - 1 < length / 2) temp[half + i - 1] else 0.0f
            temp[i] -= 0.25f * (dPrev + dCurr)
        }

        // Undo prediction step: d[i] += P(s[i-1], s[i], s[i+1], s[i+2])
        for (i in 0 until length / 2) {
            val sM1 = if (i > 0) temp[i - 1] else temp[0]  // mirror boundary
            val s0 = temp[i]
            val s1 = if (i + 1 < half) temp[i + 1] else temp[half - 1]
            val s2 = if (i + 2 < half) temp[i + 2] else if (half > 1) temp[half - 2] else temp[half - 1]

            val prediction = (-1.0f/16.0f)*sM1 + (9.0f/16.0f)*s0 + (9.0f/16.0f)*s1 + (-1.0f/16.0f)*s2
            temp[half + i] += prediction
        }

        // Merge evens and odds back
        for (i in 0 until half) {
            data[2 * i] = temp[i]
            if (2 * i + 1 < length)
                data[2 * i + 1] = temp[half + i]
        }
    }

    private fun dwtDD4InverseMultilevel(data: FloatArray, length: Int, levels: Int) {
        // Calculate the length at the deepest level
        var currentLength = length
        for (level in 0 until levels) {
            currentLength = (currentLength + 1) / 2
        }

        // Inverse transform: double size FIRST, then apply inverse DWT
        for (level in levels - 1 downTo 0) {
            currentLength *= 2  // MULTIPLY FIRST
            if (currentLength > length) currentLength = length
            dwtDD4Inverse1d(data, currentLength)  // THEN apply inverse
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