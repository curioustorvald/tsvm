package net.torvald.tsvm.peripheral

/**
 * Output destination for one [AudioAdapter] playhead.
 *
 * The stock implementation is [OpenALBufferedAudioDevice], which plays the samples straight to the
 * host's OpenAL device. A host application (e.g. a game that embeds the VM) may install its own
 * implementation through [net.torvald.tsvm.VM.audioSinkFactory] to capture the VM's audio instead —
 * for example to route it through a spatialised in-world mixer.
 *
 * Created by minjaesong on 2026-06-28.
 */
interface TsvmAudioSink {
    /** Size, in bytes, of a single device buffer. */
    val bufferSize: Int
    /** Number of device buffers. */
    val bufferCount: Int

    /**
     * Write interleaved stereo unsigned-8-bit samples `[L0, R0, L1, R1, ...]`.
     *
     * Implementations are expected to provide back-pressure (block or otherwise pace the caller) so
     * the AudioAdapter render thread does not free-run, mirroring how a real audio device throttles
     * to its playback rate.
     */
    fun writeStereoSamplesUI8(samples: ByteArray, offset: Int, numPairs: Int)

    /** Master volume, 0f..1f. */
    fun setVolume(volume: Float)

    fun dispose()
}
