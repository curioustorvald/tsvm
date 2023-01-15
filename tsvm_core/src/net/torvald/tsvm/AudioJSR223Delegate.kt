package net.torvald.tsvm

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.AudioAdapter
import org.graalvm.polyglot.Value
import kotlin.math.cos

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

    private val synthNWin = Array(64) { i -> FloatArray(32) { j -> cos(((16 + i) * (2 * j + 1)) * (Math.PI / 64.0)).toFloat() } }
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
    }








    /*
    mp2dec.js JavaScript MPEG-1 Audio Layer II decoder
    Copyright (C) 2011 Liam Wilson

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see http://www.gnu.org/licenses/.
    */
    /* Note this is a port of kjmp2 by Martin J. Fiedler: */

    /******************************************************************************
     ** kjmp2 -- a minimal MPEG-1 Audio Layer II decoder library                  **
     *******************************************************************************
     ** Copyright (C) 2006 Martin J. Fiedler martin.fiedler@gmx.net             **
     **                                                                           **
     ** This software is provided 'as-is', without any express or implied         **
     ** warranty. In no event will the authors be held liable for any damages     **
     ** arising from the use of this software.                                    **
     **                                                                           **
     ** Permission is granted to anyone to use this software for any purpose,     **
     ** including commercial applications, and to alter it and redistribute it    **
     ** freely, subject to the following restrictions:                            **
     **   1. The origin of this software must not be misrepresented; you must not **
     **      claim that you wrote the original software. If you use this software **
     **      in a product, an acknowledgment in the product documentation would   **
     **      be appreciated but is not required.                                  **
     **   2. Altered source versions must be plainly marked as such, and must not **
     **      be misrepresented as being the original software.                    **
     **   3. This notice may not be removed or altered from any source            **
     **      distribution.                                                        **
     ******************************************************************************/

    private var mp2_frame: Long? = null; // ptr
    private var STEREO=0;
    // #define JOINT_STEREO 1
    private var JOINT_STEREO=1;
    // #define DUAL_CHANNEL 2
    private var DUAL_CHANNEL=2;
    // #define MONO         3
    private var MONO=3;
    private val mp2_sample_rates = arrayOf(44100, 48000, 32000, 0);
    private val mp2_bitrates = arrayOf(32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384);
    private val mp2_scf_value = arrayOf(
        0x02000000, 0x01965FEA, 0x01428A30, 0x01000000,
        0x00CB2FF5, 0x00A14518, 0x00800000, 0x006597FB,
        0x0050A28C, 0x00400000, 0x0032CBFD, 0x00285146,
        0x00200000, 0x001965FF, 0x001428A3, 0x00100000,
        0x000CB2FF, 0x000A1451, 0x00080000, 0x00065980,
        0x00050A29, 0x00040000, 0x00032CC0, 0x00028514,
        0x00020000, 0x00019660, 0x0001428A, 0x00010000,
        0x0000CB30, 0x0000A145, 0x00008000, 0x00006598,
        0x000050A3, 0x00004000, 0x000032CC, 0x00002851,
        0x00002000, 0x00001966, 0x00001429, 0x00001000,
        0x00000CB3, 0x00000A14, 0x00000800, 0x00000659,
        0x0000050A, 0x00000400, 0x0000032D, 0x00000285,
        0x00000200, 0x00000196, 0x00000143, 0x00000100,
        0x000000CB, 0x000000A1, 0x00000080, 0x00000066,
        0x00000051, 0x00000040, 0x00000033, 0x00000028,
        0x00000020, 0x00000019, 0x00000014, 0);
    private val mp2_N = Array(64) { i -> IntArray(32) { j ->
        Math.floor(256.0 * Math.cos((16 + i) * ((j shl 1) + 1) * 0.0490873852123405)).toInt()
    } }
    private val mp2_U = IntArray(512)
    private val mp2_D = arrayOf(
        0x00000, 0x00000, 0x00000, 0x00000, 0x00000, 0x00000, 0x00000,-0x00001,
        -0x00001,-0x00001,-0x00001,-0x00002,-0x00002,-0x00003,-0x00003,-0x00004,
        -0x00004,-0x00005,-0x00006,-0x00006,-0x00007,-0x00008,-0x00009,-0x0000A,
        -0x0000C,-0x0000D,-0x0000F,-0x00010,-0x00012,-0x00014,-0x00017,-0x00019,
        -0x0001C,-0x0001E,-0x00022,-0x00025,-0x00028,-0x0002C,-0x00030,-0x00034,
        -0x00039,-0x0003E,-0x00043,-0x00048,-0x0004E,-0x00054,-0x0005A,-0x00060,
        -0x00067,-0x0006E,-0x00074,-0x0007C,-0x00083,-0x0008A,-0x00092,-0x00099,
        -0x000A0,-0x000A8,-0x000AF,-0x000B6,-0x000BD,-0x000C3,-0x000C9,-0x000CF,
        0x000D5, 0x000DA, 0x000DE, 0x000E1, 0x000E3, 0x000E4, 0x000E4, 0x000E3,
        0x000E0, 0x000DD, 0x000D7, 0x000D0, 0x000C8, 0x000BD, 0x000B1, 0x000A3,
        0x00092, 0x0007F, 0x0006A, 0x00053, 0x00039, 0x0001D,-0x00001,-0x00023,
        -0x00047,-0x0006E,-0x00098,-0x000C4,-0x000F3,-0x00125,-0x0015A,-0x00190,
        -0x001CA,-0x00206,-0x00244,-0x00284,-0x002C6,-0x0030A,-0x0034F,-0x00396,
        -0x003DE,-0x00427,-0x00470,-0x004B9,-0x00502,-0x0054B,-0x00593,-0x005D9,
        -0x0061E,-0x00661,-0x006A1,-0x006DE,-0x00718,-0x0074D,-0x0077E,-0x007A9,
        -0x007D0,-0x007EF,-0x00808,-0x0081A,-0x00824,-0x00826,-0x0081F,-0x0080E,
        0x007F5, 0x007D0, 0x007A0, 0x00765, 0x0071E, 0x006CB, 0x0066C, 0x005FF,
        0x00586, 0x00500, 0x0046B, 0x003CA, 0x0031A, 0x0025D, 0x00192, 0x000B9,
        -0x0002C,-0x0011F,-0x00220,-0x0032D,-0x00446,-0x0056B,-0x0069B,-0x007D5,
        -0x00919,-0x00A66,-0x00BBB,-0x00D16,-0x00E78,-0x00FDE,-0x01148,-0x012B3,
        -0x01420,-0x0158C,-0x016F6,-0x0185C,-0x019BC,-0x01B16,-0x01C66,-0x01DAC,
        -0x01EE5,-0x02010,-0x0212A,-0x02232,-0x02325,-0x02402,-0x024C7,-0x02570,
        -0x025FE,-0x0266D,-0x026BB,-0x026E6,-0x026ED,-0x026CE,-0x02686,-0x02615,
        -0x02577,-0x024AC,-0x023B2,-0x02287,-0x0212B,-0x01F9B,-0x01DD7,-0x01BDD,
        0x019AE, 0x01747, 0x014A8, 0x011D1, 0x00EC0, 0x00B77, 0x007F5, 0x0043A,
        0x00046,-0x003E5,-0x00849,-0x00CE3,-0x011B4,-0x016B9,-0x01BF1,-0x0215B,
        -0x026F6,-0x02CBE,-0x032B3,-0x038D3,-0x03F1A,-0x04586,-0x04C15,-0x052C4,
        -0x05990,-0x06075,-0x06771,-0x06E80,-0x0759F,-0x07CCA,-0x083FE,-0x08B37,
        -0x09270,-0x099A7,-0x0A0D7,-0x0A7FD,-0x0AF14,-0x0B618,-0x0BD05,-0x0C3D8,
        -0x0CA8C,-0x0D11D,-0x0D789,-0x0DDC9,-0x0E3DC,-0x0E9BD,-0x0EF68,-0x0F4DB,
        -0x0FA12,-0x0FF09,-0x103BD,-0x1082C,-0x10C53,-0x1102E,-0x113BD,-0x116FB,
        -0x119E8,-0x11C82,-0x11EC6,-0x120B3,-0x12248,-0x12385,-0x12467,-0x124EF,
        0x1251E, 0x124F0, 0x12468, 0x12386, 0x12249, 0x120B4, 0x11EC7, 0x11C83,
        0x119E9, 0x116FC, 0x113BE, 0x1102F, 0x10C54, 0x1082D, 0x103BE, 0x0FF0A,
        0x0FA13, 0x0F4DC, 0x0EF69, 0x0E9BE, 0x0E3DD, 0x0DDCA, 0x0D78A, 0x0D11E,
        0x0CA8D, 0x0C3D9, 0x0BD06, 0x0B619, 0x0AF15, 0x0A7FE, 0x0A0D8, 0x099A8,
        0x09271, 0x08B38, 0x083FF, 0x07CCB, 0x075A0, 0x06E81, 0x06772, 0x06076,
        0x05991, 0x052C5, 0x04C16, 0x04587, 0x03F1B, 0x038D4, 0x032B4, 0x02CBF,
        0x026F7, 0x0215C, 0x01BF2, 0x016BA, 0x011B5, 0x00CE4, 0x0084A, 0x003E6,
        -0x00045,-0x00439,-0x007F4,-0x00B76,-0x00EBF,-0x011D0,-0x014A7,-0x01746,
        0x019AE, 0x01BDE, 0x01DD8, 0x01F9C, 0x0212C, 0x02288, 0x023B3, 0x024AD,
        0x02578, 0x02616, 0x02687, 0x026CF, 0x026EE, 0x026E7, 0x026BC, 0x0266E,
        0x025FF, 0x02571, 0x024C8, 0x02403, 0x02326, 0x02233, 0x0212B, 0x02011,
        0x01EE6, 0x01DAD, 0x01C67, 0x01B17, 0x019BD, 0x0185D, 0x016F7, 0x0158D,
        0x01421, 0x012B4, 0x01149, 0x00FDF, 0x00E79, 0x00D17, 0x00BBC, 0x00A67,
        0x0091A, 0x007D6, 0x0069C, 0x0056C, 0x00447, 0x0032E, 0x00221, 0x00120,
        0x0002D,-0x000B8,-0x00191,-0x0025C,-0x00319,-0x003C9,-0x0046A,-0x004FF,
        -0x00585,-0x005FE,-0x0066B,-0x006CA,-0x0071D,-0x00764,-0x0079F,-0x007CF,
        0x007F5, 0x0080F, 0x00820, 0x00827, 0x00825, 0x0081B, 0x00809, 0x007F0,
        0x007D1, 0x007AA, 0x0077F, 0x0074E, 0x00719, 0x006DF, 0x006A2, 0x00662,
        0x0061F, 0x005DA, 0x00594, 0x0054C, 0x00503, 0x004BA, 0x00471, 0x00428,
        0x003DF, 0x00397, 0x00350, 0x0030B, 0x002C7, 0x00285, 0x00245, 0x00207,
        0x001CB, 0x00191, 0x0015B, 0x00126, 0x000F4, 0x000C5, 0x00099, 0x0006F,
        0x00048, 0x00024, 0x00002,-0x0001C,-0x00038,-0x00052,-0x00069,-0x0007E,
        -0x00091,-0x000A2,-0x000B0,-0x000BC,-0x000C7,-0x000CF,-0x000D6,-0x000DC,
        -0x000DF,-0x000E2,-0x000E3,-0x000E3,-0x000E2,-0x000E0,-0x000DD,-0x000D9,
        0x000D5, 0x000D0, 0x000CA, 0x000C4, 0x000BE, 0x000B7, 0x000B0, 0x000A9,
        0x000A1, 0x0009A, 0x00093, 0x0008B, 0x00084, 0x0007D, 0x00075, 0x0006F,
        0x00068, 0x00061, 0x0005B, 0x00055, 0x0004F, 0x00049, 0x00044, 0x0003F,
        0x0003A, 0x00035, 0x00031, 0x0002D, 0x00029, 0x00026, 0x00023, 0x0001F,
        0x0001D, 0x0001A, 0x00018, 0x00015, 0x00013, 0x00011, 0x00010, 0x0000E,
        0x0000D, 0x0000B, 0x0000A, 0x00009, 0x00008, 0x00007, 0x00007, 0x00006,
        0x00005, 0x00005, 0x00004, 0x00004, 0x00003, 0x00003, 0x00002, 0x00002,
        0x00002, 0x00002, 0x00001, 0x00001, 0x00001, 0x00001, 0x00001, 0x00001);
    private val mp2_quant_lut_step1= arrayOf(
        arrayOf(0,  0,  1,  1,  1,  2,  2,  2,  2,  2,  2,  2,  2,  2 ),
        arrayOf(0,  0,  0,  0,  0,  0,  1,  1,  1,  2,  2,  2,  2,  2 ));
    private val mp2_QUANT_TAB_A = 27 or 64 // Table 3-B.2a: high-rate, sblimit = 27
    private val mp2_QUANT_TAB_B = 30 or 64 // Table 3-B.2b: high-rate, sblimit = 30
    private val mp2_QUANT_TAB_C = 8 // Table 3-B.2c:  low-rate, sblimit =  8
    private val mp2_QUANT_TAB_D = 12 // Table 3-B.2d:  low-rate, sblimit = 12
    private val mp2_quant_lut_step2 = arrayOf(
        arrayOf(mp2_QUANT_TAB_C, mp2_QUANT_TAB_C, mp2_QUANT_TAB_D),
        arrayOf(mp2_QUANT_TAB_A, mp2_QUANT_TAB_A, mp2_QUANT_TAB_A),
        arrayOf(mp2_QUANT_TAB_B, mp2_QUANT_TAB_A, mp2_QUANT_TAB_B));
    private val mp2_quant_lut_step3 = arrayOf(
        arrayOf(0x44,0x44,
            0x34,0x34,0x34,0x34,0x34,0x34,0x34,0x34,0x34,0x34
        ),
        arrayOf(0x43,0x43,0x43,
            0x42,0x42,0x42,0x42,0x42,0x42,0x42,0x42,
            0x31,0x31,0x31,0x31,0x31,0x31,0x31,0x31,0x31,0x31,0x31,0x31,
            0x20,0x20,0x20,0x20,0x20,0x20,0x20));
    private val mp2_quant_lut_step4 = arrayOf(
        arrayOf(0, 1, 2, 17),
        arrayOf(0, 1, 2, 3, 4, 5, 6, 17),
        arrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17),
        arrayOf(0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17),
        arrayOf(0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17));
    private data class mp2_quantizer_spec(var nlevels: Int, var grouping: Boolean, var cw_bits: Int, var Smul: Int, var Sdiv: Int)
    private val mp2_quantizer_table =arrayOf(
        mp2_quantizer_spec   (     3, true,   5, 0x7FFF, 0xFFFF ),
        mp2_quantizer_spec   (     5, true,   7, 0x3FFF, 0x0002 ),
        mp2_quantizer_spec   (     7, false,  3, 0x2AAA, 0x0003 ),
        mp2_quantizer_spec   (     9, true,  10, 0x1FFF, 0x0002 ),
        mp2_quantizer_spec   (    15, false,  4, 0x1249, 0xFFFF ),
        mp2_quantizer_spec   (    31, false,  5, 0x0888, 0x0003 ),
        mp2_quantizer_spec   (    63, false,  6, 0x0421, 0xFFFF ),
        mp2_quantizer_spec   (   127, false,  7, 0x0208, 0x0009 ),
        mp2_quantizer_spec   (   255, false,  8, 0x0102, 0x007F ),
        mp2_quantizer_spec   (   511, false,  9, 0x0080, 0x0002 ),
        mp2_quantizer_spec   (  1023, false, 10, 0x0040, 0x0009 ),
        mp2_quantizer_spec   (  2047, false, 11, 0x0020, 0x0021 ),
        mp2_quantizer_spec   (  4095, false, 12, 0x0010, 0x0089 ),
        mp2_quantizer_spec   (  8191, false, 13, 0x0008, 0x0249 ),
        mp2_quantizer_spec   ( 16383, false, 14, 0x0004, 0x0AAB ),
        mp2_quantizer_spec   ( 32767, false, 15, 0x0002, 0x3FFF ),
        mp2_quantizer_spec   ( 65535, false, 16, 0x0001, 0xFFFF ));

    val KJMP2_MAGIC= 0x32706D;
    private var mp2_initialized = false;
    private var mp2_bit_window = 0;
    private var mp2_bits_in_window = 0;
    private var mp2_frame_pos = 0;

    private fun syspeek(ptr: Long) = vm.peek(ptr)!!.toUint()

    data class MP2(
        var Voffs: Int = 0,
        var id: Int = 0,
        var V: Array<IntArray> = Array(2) { IntArray(1024) }
    )


    private fun show_bits(bit_count: Int) = (mp2_bit_window shr (24 - (bit_count)));
    private fun get_bits(bit_count: Int): Int {
        var result = show_bits(bit_count);
        mp2_bit_window = (mp2_bit_window shl bit_count) and 0xFFFFFF;
        mp2_bits_in_window -= bit_count;
        while (mp2_bits_in_window < 16) {
            mp2_bit_window = mp2_bit_window or (syspeek(mp2_frame!! + mp2_frame_pos++) shl (16 - mp2_bits_in_window));
            mp2_bits_in_window += 8;
        }
        return result;
    }

    fun mp2Init(): MP2 {
        val mp2 = MP2()

        // check if global initialization is required
        if (!mp2_initialized) {
            mp2_initialized = true;
        }

        // perform local initialization: clean the context and put the magic in it
        for (i in 0 until 2){
            for (j in 1023 downTo 0){
                mp2.V[i][j] = 0;
            };
        };
        mp2.Voffs = 0;
        mp2.id = KJMP2_MAGIC;

        return mp2
    };

    private fun kjmp2_get_sample_rate(frame: Long?): Int {
        if (frame == null){
            return 0;};
        if ((syspeek(frame) != 0xFF) || (syspeek(frame +1) != 0xFD) || ((syspeek(frame +2) - 0x10) >= 0xE0)) {
            return 0;};
        return mp2_sample_rates[(syspeek(frame +2) shr 2) and 3];
    };

    private fun read_allocation(sb: Int, b2_table: Int): mp2_quantizer_spec? {
        var table_idx = mp2_quant_lut_step3[b2_table][sb];
        table_idx = mp2_quant_lut_step4[table_idx and 15][get_bits(table_idx shr 4)];
        return if (table_idx != 0) (mp2_quantizer_table[table_idx - 1]) else null
    }

    private fun read_samples(q: mp2_quantizer_spec?, scalefactor: Int, sample: IntArray) {
        var adj = 0;
        var value = 0;
        if (q == null) {
            // no bits allocated for this subband
            sample[0] = 0
            sample[1] = 0
            sample[2] = 0;
            return;
        }
        // resolve scalefactor
        var scalefactor = mp2_scf_value[scalefactor];

        // decode samples
        adj = q.nlevels;
        if (q.grouping) {
            // decode grouped samples
            value = get_bits(q.cw_bits);
            sample[0] = value % adj;
            value = Math.floor(value.toDouble() / adj).toInt();
            sample[1] = value % adj;
            sample[2] = Math.floor(value.toDouble() / adj).toInt();
        } else {
            // decode direct samples
            for(idx in 0 until 3)
            sample[idx] = get_bits(q.cw_bits);
        }

        // postmultiply samples
        adj = ((adj + 1) shr 1) - 1;
        for (idx in 0 until 3) {
            // step 1: renormalization to [-1..1]
            value = adj - sample[idx];
            value = (value * q.Smul) + Math.floor(value.toDouble() / q.Sdiv).toInt();
            // step 2: apply scalefactor
            sample[idx] = ( value * (scalefactor shr 12) + ((value * (scalefactor and 4095) + 2048) shr 12))  shr 12;  // scale adjust
        }
    }

    private var mp2_allocation: Array<Array<mp2_quantizer_spec?>> = Array(2) { Array(32) { null } }
    private var mp2_scfsi = Array(2) { IntArray(32) }
    private var mp2_scalefactor = Array(2) { Array(32) { IntArray(3) } }
    private var mp2_sample = Array(2) { Array(32) { IntArray(3) } }


    fun mp2GetInitialFrameSize(bytes: IntArray): Int {
        val b0 = bytes[0]
        val b1 = bytes[1]
        val b2 = bytes[2]

        // check sync pattern
        if ((b0 != 0xFF) || (b1 != 0xFD) || ((b2 - 0x10) >= 0xE0)) {
            throw Error("Not a MP2 Frame Head: ${listOf(b0, b1, b2).map { it.toString(16).padStart(2,'0') }.joinToString(" ")}")
        }

        val sampling_frequency = (b2 shr 2) and 3
        val bit_rate_index_minus1 = ((b2 shr 4) and 15) - 1
        if (bit_rate_index_minus1 > 13){
            throw Error("Invalid bit rate")  // invalid bit rate or 'free format'
        }
        val padding_bit = b2.shr(1) and 1
        return Math.floor(144000.0 * mp2_bitrates[bit_rate_index_minus1] / mp2_sample_rates[sampling_frequency]).toInt() + padding_bit
    }

    fun mp2DecodeFrame(mp2: MP2, framePtr: Long?, pcm: Boolean, outL: Long, outR: Long): IntArray {

        var pushSizeL = 0
        var pushSizeR = 0
        fun pushL(sampleL: Int) {
            vm.poke(outL + pushSizeL + 0, (sampleL and 255).toByte())
            vm.poke(outL + pushSizeL + 1, (sampleL shr 8).toByte())
            pushSizeL += 2
        }
        fun pushR(sampleR: Int) {
            vm.poke(outR + pushSizeR + 0, (sampleR and 255).toByte())
            vm.poke(outR + pushSizeR + 1, (sampleR shr 8).toByte())
            pushSizeR += 2
        }


        if (framePtr == null) {
            throw Error("Frame is null")
        }
        mp2_frame = framePtr;
        val bit_rate_index_minus1: Int;
        val sampling_frequency: Int;
        val padding_bit: Int;
        val mode: Int;
        val frame_size: Int;
        var bound: Int
        val sblimit: Int;
        val nch: Int;
        var sum: Int;
        var table_idx: Int;
        // general sanity check
        if (!mp2_initialized || (mp2.id != KJMP2_MAGIC)){
            throw Error("MP2 not initialised")
        };
        // check for valid header: syncword OK, MPEG-Audio Layer 2
        if ((syspeek(mp2_frame!!) != 0xFF) || ((syspeek(mp2_frame!! +1) and 0xFE) != 0xFC)){
            throw Error("Invalid header")
        };

        // set up the bitstream reader
        mp2_bit_window = syspeek(mp2_frame!! +2) shl 16;
        mp2_bits_in_window = 8;
        mp2_frame_pos = 3;

        // read the rest of the header
        bit_rate_index_minus1 = get_bits(4) - 1;
        if (bit_rate_index_minus1 > 13){
            throw Error("Invalid bit rate")  // invalid bit rate or 'free format'
        };
        sampling_frequency = get_bits(2);
        if (sampling_frequency == 3){
            throw Error("Invalid sampling frequency")
        };
        padding_bit = get_bits(1);
        get_bits(1);  // discard private_bit
        mode = get_bits(2);

        // parse the mode_extension, set up the stereo bound
        if (mode == JOINT_STEREO) {
            bound = (get_bits(2) + 1) shl 2;
        } else {
            get_bits(2);
            bound = if (mode == MONO) 0 else 32;
        }

        // discard the last 4 bits of the header and the CRC value, if present
        get_bits(4);
        if ((syspeek(mp2_frame!! +1) and 1) == 0)
            get_bits(16);

        // compute the frame size
        frame_size = Math.floor(144000.0 * mp2_bitrates[bit_rate_index_minus1] / mp2_sample_rates[sampling_frequency]).toInt() + padding_bit;
        if (!pcm){
            return intArrayOf(frame_size, pushSizeL);  // no decoding
        };

        // prepare the quantizer table lookups
        table_idx = if (mode == MONO) 0 else 1;
        table_idx = mp2_quant_lut_step1[table_idx][bit_rate_index_minus1];
        table_idx = mp2_quant_lut_step2[table_idx][sampling_frequency];
        sblimit = table_idx and 63;
        table_idx = table_idx shr 6;
        if (bound > sblimit){
            bound = sblimit;
        };

        // read the allocation information
        for (sb in 0 until bound){
            for (ch in 0 until 2){
                mp2_allocation[ch][sb] = read_allocation(sb, table_idx)
            };
        };

        for (sb in bound until sblimit){
            val tmp = read_allocation(sb, table_idx)
            mp2_allocation[0][sb] = tmp
            mp2_allocation[1][sb] = tmp
        };


        // read scale factor selector information
        nch = if (mode == MONO) 1 else 2;
        for (sb in 0 until sblimit) {
            for (ch in 0 until nch){
                if (mp2_allocation[ch][sb] != null){
                    mp2_scfsi[ch][sb] = get_bits(2);
                };
            }
            if (mode == MONO){
                mp2_scfsi[1][sb] = mp2_scfsi[0][sb];
            };
        };
        // read scale factors
        for (sb in 0 until sblimit) {
            for (ch in 0 until nch) {
                if (mp2_allocation[ch][sb] != null) {
                    when (mp2_scfsi[ch][sb]) {
                        0 -> {
                            mp2_scalefactor[ch][sb][0] = get_bits(6);
                            mp2_scalefactor[ch][sb][1] = get_bits(6);
                            mp2_scalefactor[ch][sb][2] = get_bits(6);
                        }
                        1 -> {
                            val tmp = get_bits(6);
                            mp2_scalefactor[ch][sb][0] = tmp
                            mp2_scalefactor[ch][sb][1] = tmp
                            mp2_scalefactor[ch][sb][2] = get_bits(6);
                        }
                        2 -> {
                            val tmp = get_bits(6);
                            mp2_scalefactor[ch][sb][0] = tmp
                            mp2_scalefactor[ch][sb][1] = tmp
                            mp2_scalefactor[ch][sb][2] = tmp
                        }
                        3 -> {
                            mp2_scalefactor[ch][sb][0] = get_bits(6);
                            val tmp = get_bits(6);
                            mp2_scalefactor[ch][sb][1] = tmp
                            mp2_scalefactor[ch][sb][2] = tmp
                        }
                    }
                }
            }
            if (mode == MONO){
                for (part in 0 until 3){
                    mp2_scalefactor[1][sb][part] = mp2_scalefactor[0][sb][part];
                };
            };
        }
        //  let ppcm=0;
        // coefficient input and reconstruction
        for (part in 0 until 3){
            for (gr in 0 until 4) {

                // read the samples
                for (sb in 0 until bound){
                    for (ch in 0 until 2){
                        read_samples(mp2_allocation[ch][sb], mp2_scalefactor[ch][sb][part], mp2_sample[ch][sb]);
                    };
                };
                for (sb in bound until sblimit) {
                    read_samples(mp2_allocation[0][sb], mp2_scalefactor[0][sb][part], mp2_sample[0][sb]);

                    for (idx in 0 until 3){
                        mp2_sample[1][sb][idx] = mp2_sample[0][sb][idx];
                    };
                };
                for (ch in 0 until 2){
                    for (sb in sblimit until 32){
                        for (idx in 0 until 3){
                            mp2_sample[ch][sb][idx] = 0;
                        };
                    };
                };

                // synthesis loop
                for (idx in 0 until 3) {
                    // shifting step
                    val tmp = (mp2.Voffs - 64) and 1023
                    mp2.Voffs = tmp
                    table_idx = tmp

                    for (ch in 0 until 2) {
                        // matrixing
                        for (i in 0 until 64) {
                            sum = 0;
                            for (j in 0 until 32)
                                sum += mp2_N[i][j] * mp2_sample[ch][j][idx];  // 8b*15b=23b
                            // intermediate value is 28 bit (23 + 5), clamp to 14b
                            mp2.V[ch][table_idx + i] = (sum + 8192) shr 14;
                        }

                        // construction of U
                        for (i in 0 until 8){
                                for (j in 0 until 32) {
                                mp2_U[(i shl 6) + j]      = mp2.V[ch][(table_idx + (i shl 7) + j     ) and 1023];
                                mp2_U[(i shl 6) + j + 32] = mp2.V[ch][(table_idx + (i shl 7) + j + 96) and 1023];
                            };
                        };
                        // apply window
                        for (i in 0 until 512){
                            mp2_U[i] = (mp2_U[i] * mp2_D[i] + 32) shr 6;
                        };
                        // output samples
                        for (j in 0 until 32) {
                            sum = 0;
                            for (i in 0 until 16){
                                sum -= mp2_U[(i shl 5) + j];
                            };
                            sum = (sum + 8) shr 4;
                            sum = sum.coerceIn(-32768, 32767)
                            if (ch == 0) { pushL(sum) }
                            if (ch == 1) { pushR(sum) }
                        }
                    } // end of synthesis channel loop
                } // end of synthesis sub-block loop

                // adjust PCM output pointer: decoded 3 * 32 = 96 stereo samples
                //            ppcm += 192;

            } // decoding of the granule finished
        }

        if (pushSizeL != pushSizeR && pushSizeR > 0) {
            throw Error("Push size mismatch -- U${pushSizeL} != R${pushSizeR}")
        }
        return intArrayOf(frame_size, pushSizeL);
        //    return intArrayOf(frame_size, 2304);
    };




}