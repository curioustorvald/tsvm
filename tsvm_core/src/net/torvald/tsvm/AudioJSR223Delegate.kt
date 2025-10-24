package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.tsvm.peripheral.AudioAdapter
import net.torvald.tsvm.peripheral.MP2Env

/**
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

//    fun setPosition(playhead: Int, pos: Int) { getPlayhead(playhead)?.position = pos and 65535 }
    fun getPosition(playhead: Int) = getPlayhead(playhead)?.position

    fun setSampleUploadLength(playhead: Int, length: Int) { getPlayhead(playhead)?.pcmUploadLength = length and 65535 }

//    fun setSamplingRate(playhead: Int, rate: Int) { getPlayhead(playhead)?.setSamplingRate(rate) }
//    fun getSamplingRate(playhead: Int) = getPlayhead(playhead)?.getSamplingRate()

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

    fun setPcmQueueCapacityIndex(playhead: Int, index: Int) { getPlayhead(playhead)?.pcmQueueSizeIndex = index }
    fun getPcmQueueCapacityIndex(playhead: Int) { getPlayhead(playhead)?.pcmQueueSizeIndex }
    fun getPcmQueueCapacity(playhead: Int) = getPlayhead(playhead)?.getPcmQueueCapacity()

    fun resetParams(playhead: Int) {
        getPlayhead(playhead)?.resetParams()
    }

    fun purgeQueue(playhead: Int) {
        getPlayhead(playhead)?.purgeQueue()
    }




//    fun mp2Init() = getFirstSnd()?.mp2Env?.initialise()
    fun mp2GetInitialFrameSize(bytes: IntArray) = getFirstSnd()?.mp2Env?.getInitialFrameSize(bytes)
//    fun mp2DecodeFrame(mp2: MP2Env.MP2, framePtr: Long?, pcm: Boolean, outL: Long, outR: Long) = getFirstSnd()?.mp2Env?.decodeFrame(mp2, framePtr, pcm, outL, outR)

    fun getBaseAddr(): Int? = getFirstSnd()?.let { return it.vm.findPeriSlotNum(it)?.times(-131072)?.minus(1) }
    fun getMemAddr(): Int? = getFirstSnd()?.let { return it.vm.findPeriSlotNum(it)?.times(-1048576)?.minus(1) }
    fun mp2Init() = getFirstSnd()?.mmio_write(40L, 16)
    fun mp2Decode() = getFirstSnd()?.mmio_write(40L, 1)
    fun mp2InitThenDecode() = getFirstSnd()?.mmio_write(40L, 17)
    fun mp2UploadDecoded(playhead: Int) {
        getFirstSnd()?.let {  snd ->
            val ba = ByteArray(2304)
            UnsafeHelper.memcpyRaw(null, snd.mediaDecodedBin.ptr, ba, UnsafeHelper.getArrayOffset(ba), 2304)
            snd.playheads[playhead].pcmQueue.addLast(ba)
        }
    }

    // TAD (Terrarum Advanced Audio) decoder functions
    fun tadSetQuality(quality: Int) {
        getFirstSnd()?.mmio_write(43L, quality.toByte())
    }

    fun tadGetQuality() = getFirstSnd()?.mmio_read(43L)?.toInt()

    fun tadDecode() {
        getFirstSnd()?.mmio_write(42L, 1)
    }

    fun tadIsBusy() = getFirstSnd()?.mmio_read(44L)?.toInt() == 1

    fun tadUploadDecoded(playhead: Int, sampleLength: Int) {
        if (sampleLength > 32768) throw Error("Sample size too long: expected <= 32768, got $sampleLength")
        getFirstSnd()?.let { snd ->
            val ba = ByteArray(sampleLength * 2)  // 32768 samples * 2 channels
            UnsafeHelper.memcpyRaw(null, snd.tadDecodedBin.ptr, ba, UnsafeHelper.getArrayOffset(ba), sampleLength * 2L)
            snd.playheads[playhead].pcmQueue.addLast(ba)
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