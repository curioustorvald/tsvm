package net.torvald.tsvm.peripheral

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.audio.AudioDevice
import com.badlogic.gdx.backends.lwjgl3.audio.OpenALLwjgl3Audio
import com.badlogic.gdx.utils.Queue
import net.torvald.UnsafeHelper
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.ThreeFiveMiniUfloat
import net.torvald.tsvm.VM

private fun Boolean.toInt() = if (this) 1 else 0

/**
 * Created by minjaesong on 2022-12-30.
 */
class AudioAdapter(val vm: VM) : PeriBase {

    private val DBGPRN = true
    private fun printdbg(msg: Any) {
        if (DBGPRN) println("[AudioAdapter] $msg")
    }
    
    companion object {
        const val SAMPLING_RATE = 30000
    }

    internal val sampleBin = UnsafeHelper.allocate(114687L)
    internal val instruments = Array(256) { TaudInst() }
    internal val playdata = Array(256) { Array(64) { TaudPlayData(0,0,0,0,0,0,0,0) } }
    internal val playheads = Array(4) { Playhead() }
    internal val cueSheet = Array(2048) { PlayCue() }
    internal val pcmBin = UnsafeHelper.allocate(65536L)

    private lateinit var audioDevices: Array<AudioDevice>
    private val renderThreads = Array(4) { Thread(getRenderFun(it)) }
    private val writeQueueingThreads = Array(4) { Thread(getQueueingFun(it)) }
//    private val writeQueues = Array(4) { Queue<FloatArray>() }

    /*private val alSources = Array(4) {
        val audioField = OpenALAudioDevice::class.java.getDeclaredField("audio")
        audioField.isAccessible = true
        val audio = audioField.get(audioDevices[it]) as OpenALLwjgl3Audio

        val obtainSourceMethod = OpenALLwjgl3Audio::class.java.getDeclaredMethod("obtainSource", java.lang.Boolean.TYPE)
        obtainSourceMethod.isAccessible = true
        val alSource = obtainSourceMethod.invoke(audio, true) as Int

        alSource
    }

    private val alBuffers = Array(4) {
        val buffers = IntArray(3)
        AL11.alGenBuffers(buffers)
        buffers
    }

    private fun freeAlSources() {
        audioDevices.forEachIndexed { index, adev ->
            val audioField = OpenALAudioDevice::class.java.getDeclaredField("audio")
            audioField.isAccessible = true
            val audio = audioField.get(adev) as OpenALLwjgl3Audio

            val freeSourceMethod = OpenALLwjgl3Audio::class.java.getDeclaredMethod("freeSource", java.lang.Integer.TYPE)
            freeSourceMethod.isAccessible = true
            freeSourceMethod.invoke(audio, alSources[index])
        }
    }

    private fun enqueuePacket(alSource: Int, alBuffer: Int, data: ByteBuffer) {
        AL11.alBufferData(alBuffer, AL11.AL_FORMAT_STEREO8, data, SAMPLING_RATE)
        AL11.alSourceQueueBuffers(alSource, alBuffer)

    }*/

    private val pcmCurrentPosInSamples = ShortArray(4)

    private var pcmPlaybackWatchdogs = Array(4) { Thread {

    } }

    private fun getRenderFun(pheadNum: Int): () -> Unit = { while (true) {
        render(playheads[pheadNum], pheadNum)
        Thread.sleep(1)
    } }

    private fun getQueueingFun(pheadNum: Int): () -> Unit = { while (true) {

        playheads[pheadNum].let {
            if (it.pcmUploadLength > 0) {
                printdbg("Downloading samples ${it.pcmUploadLength}")
                
                val samples = FloatArray(it.pcmUploadLength) { pcmBin[it.toLong()].toUint().div(255f) * 2f - 1f }
                it.pcmQueue.addLast(samples)

                it.pcmUploadLength = 0
                it.position += 1
            }
        }


        Thread.sleep(4)
    } }

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

        audioDevices = Array(4) { OpenALBufferedAudioDevice(
            Gdx.audio as OpenALLwjgl3Audio,
            SAMPLING_RATE,
            false,
            deviceBufferSize,
            deviceBufferCount) {

        } }


//        printdbg("AudioAdapter latency: ${audioDevice.latency}")
        renderThreads.forEach { it.start() }
        writeQueueingThreads.forEach { it.start() }

    }

    /**
     * Put this function into a separate thread and keep track of the delta time by yourself
     */
    private fun render(playhead: Playhead, pheadNum: Int) {
        if (playhead.isPcmMode) {

            val writeQueue = playhead.pcmQueue

            if (playhead.isPlaying && writeQueue.notEmpty()) {

                printdbg("Taking samples from queue (queue size: ${writeQueue.size})")

                val samples = writeQueue.removeFirst()
                playhead.position = writeQueue.size

                printdbg("P${pheadNum+1} Vol ${playhead.masterVolume}; LpP ${playhead.pcmUploadLength}; start playback...")
//                    printdbg(""+(0..42).joinToString { String.format("%.2f", samples[it]) })
                if (playhead.masterVolume == 0) printdbg("P${pheadNum+1} volume is zero!")

                audioDevices[pheadNum].setVolume(playhead.masterVolume / 255f)
                audioDevices[pheadNum].writeSamples(samples, 0, samples.size)

                printdbg("P${pheadNum+1} go back to spinning")

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
            else -> peek(addr % 262144)
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        val adi = addr.toInt()
        val bi = byte.toUint()
        when (adi) {
            in 0..114687 -> { sampleBin[addr] = byte }
            in 114688..131071 -> (adi - 114688).let { instruments[it / 64].setByte(it % 64, bi) }
            in 131072..262143 -> (adi - 131072).let { playdata[it / (8*64)][(it / 8) % 64].setByte(it % 8, bi) }
        }
    }

    override fun mmio_read(addr: Long): Byte {
        val adi = addr.toInt()
        return when (adi) {
            in 0..9 -> playheads[0].read(adi)
            in 10..19 -> playheads[1].read(adi - 10)
            in 20..29 -> playheads[2].read(adi - 20)
            in 30..39 -> playheads[3].read(adi - 30)
            in 32768..65535 -> (adi - 32768).let {
                cueSheet[it / 16].read(it % 15)
            }
            in 65536..131071 -> pcmBin[addr - 65536]
            else -> mmio_read(addr % 131072)
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
            in 32768..65535 -> { (adi - 32768).let {
                cueSheet[it / 16].write(it % 15, bi)
            } }
            in 65536..131071 -> { pcmBin[addr - 65536] = byte }
        }
    }

    override fun dispose() {
        renderThreads.forEach { it.interrupt() }
        writeQueueingThreads.forEach { it.interrupt() }
        audioDevices.forEach { it.dispose() }
//        freeAlSources()
        sampleBin.destroy()
        pcmBin.destroy()
    }

    override fun getVM(): VM {
        return vm
    }

    override val typestring = VM.PERITYPE_SOUND




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

    internal data class Playhead(
        var position: Int = 0,
        var pcmUploadLength: Int = 0,
        var masterVolume: Int = 0,
        var masterPan: Int = 0,
        // flags
        var isPcmMode: Boolean = false,
        var isPlaying: Boolean = false,
        var samplingRateMult: ThreeFiveMiniUfloat = ThreeFiveMiniUfloat(32),
        var bpm: Int = 120, // "stored" as 96
        var tickRate: Int = 6,

        var pcmQueue: Queue<FloatArray> = Queue<FloatArray>()
    ) {
        fun read(index: Int): Byte = when (index) {
            0 -> position.toByte()
            1 -> position.ushr(8).toByte()
            2 -> pcmUploadLength.toByte()
            3 -> pcmUploadLength.ushr(8).toByte()
            4 -> masterVolume.toByte()
            5 -> masterPan.toByte()
            6 -> (isPcmMode.toInt().shl(7) or isPlaying.toInt().shl(4)).toByte()
            7 -> samplingRateMult.index.toByte()
            8 -> (bpm - 24).toByte()
            9 -> tickRate.toByte()
            else -> throw InternalError("Bad offset $index")
        }

        fun write(index: Int, byte: Int) = when (index) {
            0 -> if (!isPcmMode) { position = position.and(0xff00) or position } else {}
            1 -> if (!isPcmMode) { position = position.and(0x00ff) or position.shl(8) } else {}
            2 -> { pcmUploadLength = pcmUploadLength.and(0xff00) or pcmUploadLength }
            3 -> { pcmUploadLength = pcmUploadLength.and(0x00ff) or pcmUploadLength.shl(8) }
            4 -> { masterVolume = byte }
            5 -> { masterPan = byte }
            6 -> { byte.let {
                val oldPcmMode = isPcmMode
                isPcmMode = (it and 0b10000000) != 0
                isPlaying = (it and 0b00010000) != 0

                if (it and 0b01000000 != 0 || oldPcmMode != isPcmMode) resetParams()
                if (it and 0b00100000 != 0) purgeQueue()
            } }
            7 -> { samplingRateMult = ThreeFiveMiniUfloat(byte) }
            8 -> { bpm = byte + 24 }
            9 -> { tickRate = byte }
            else -> throw InternalError("Bad offset $index")
        }

        fun getSamplingRate() = 30000 - ((bpm - 24).and(255) or tickRate.and(255).shl(8)).toShort().toInt()
        fun setSamplingRate(rate: Int) {
            val rateDiff = (rate.coerceIn(0, 95535) - 30000).toShort().toInt()
            bpm = rateDiff.and(255) + 24
            tickRate = rateDiff.ushr(8).and(255)
        }

        fun resetParams() {
            position = 0
            pcmUploadLength = 0
            isPlaying = false
        }

        fun purgeQueue() {
            pcmQueue.clear()
            if (isPcmMode) {
                position = 0
                pcmUploadLength = 0
            }
        }
    }

    internal data class TaudPlayData(
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

    internal data class TaudInstVolEnv(var volume: Int, var offset: ThreeFiveMiniUfloat)
    internal data class TaudInst(
        var samplePtr: Int, // 17-bit number
        var sampleLength: Int,
        var samplingRate: Int,
        var sampleLoopStart: Int,
        var sampleLoopEnd: Int,
        // flags
        var loopMode: Int,
        var envelopes: Array<TaudInstVolEnv> // first int: volume (0..255), second int: offsets (minifloat indices)
    ) {
        constructor() : this(0, 0, 0, 0, 0, 0, Array(24) { TaudInstVolEnv(0, ThreeFiveMiniUfloat(0)) })

        fun getByte(offset: Int): Byte = when (offset) {
            0 -> samplePtr.toByte()
            1 -> samplePtr.ushr(8).toByte()

            2 -> sampleLength.toByte()
            3 -> sampleLength.ushr(8).toByte()

            4 -> samplingRate.toByte()
            5 -> samplingRate.ushr(8).toByte()

            6 -> sampleLoopStart.toByte()
            7 -> sampleLoopStart.ushr(8).toByte()

            8 -> sampleLoopEnd.toByte()
            9 -> sampleLoopEnd.ushr(8).toByte()

            10 -> (samplePtr.ushr(16).and(1).shl(7) or loopMode.and(3)).toByte()
            11,12,13,14,15 -> -1
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