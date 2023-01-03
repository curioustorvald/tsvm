package net.torvald.tsvm

import net.torvald.tsvm.peripheral.AudioAdapter

/**
 * Created by minjaesong on 2022-12-31.
 */
class AudioJSR223Delegate(private val vm: VM) {

    private fun getFirstSnd(): AudioAdapter? = vm.findPeribyType(VM.PERITYPE_SOUND)?.peripheral as? AudioAdapter
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

//    fun setPosition(playhead: Int, pos: Int) { getPlayhead(playhead)?.position = pos and 65535 }
    fun getPosition(playhead: Int) = getPlayhead(playhead)?.position

    fun setSampleUploadLength(playhead: Int, length: Int) { getPlayhead(playhead)?.pcmUploadLength = length and 65535 }

    fun setSamplingRate(playhead: Int, rate: Int) { getPlayhead(playhead)?.setSamplingRate(rate) }
    fun getSamplingRate(playhead: Int) = getPlayhead(playhead)?.getSamplingRate()

    fun startSampleUpload(playhead: Int) { getPlayhead(playhead)?.pcmUpload = true }

    fun setBPM(playhead: Int, bpm: Int) { getPlayhead(playhead)?.bpm = (bpm - 24).and(255) + 24 }
    fun getBPM(playhead: Int) = getPlayhead(playhead)?.bpm

    fun setTickRate(playhead: Int, rate: Int) { getPlayhead(playhead)?.tickRate = rate and 255 }
    fun getTickRate(playhead: Int) = getPlayhead(playhead)?.tickRate

    fun putPcmDataByPtr(ptr: Int, length: Int, destOffset: Int) {
        getFirstSnd()?.let {
            val vkMult = if (ptr >= 0) 1 else -1
            for (k in 0L until length) {
                val vk = k * vkMult
                it.pcmBin[k + destOffset] = vm.peek(ptr + vk)!!
            }
        }
    }
    fun getPcmData(index: Int) = getFirstSnd()?.pcmBin?.get(index.toLong())

    fun setPcmQueueSizeIndex(playhead: Int, index: Int) { getPlayhead(playhead)?.pcmQueueSizeIndex = index }
    fun getPcmQueueSizeIndex(playhead: Int, index: Int) { getPlayhead(playhead)?.pcmQueueSizeIndex }
    fun getPcmQueueSize(playhead: Int, index: Int) { getPlayhead(playhead)?.getPcmQueueSize() }

    fun resetParams(playhead: Int) {
        getPlayhead(playhead)?.resetParams()
    }

    fun purgeQueue(playhead: Int) {
        getPlayhead(playhead)?.purgeQueue()
    }
}