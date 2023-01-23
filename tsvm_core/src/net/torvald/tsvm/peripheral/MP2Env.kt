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

package net.torvald.tsvm.peripheral

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.VM
import java.util.*
import kotlin.collections.ArrayList
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

class MP2Env(val vm: VM) {
    private var mp2_frame: Long? = null; // ptr
    private var mp2_frameIncr = 1
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
            mp2_bit_window = mp2_bit_window or (syspeek(mp2_frame!! + mp2_frame_pos * mp2_frameIncr) shl (16 - mp2_bits_in_window));
            mp2_frame_pos += 1
            mp2_bits_in_window += 8;
        }
        return result;
    }

    fun initialise(): MP2 {
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


    fun getInitialFrameSize(bytes: IntArray): Int {
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
        return floor(144000.0 * mp2_bitrates[bit_rate_index_minus1] / mp2_sample_rates[sampling_frequency]).toInt() + padding_bit
    }

    private fun randomRound(k: Double): Double {
        val rnd = (Math.random() + Math.random()) / 2.0 // this produces triangular distribution
        return if (rnd < (k - (k.toInt()))) ceil(k) else floor(k)
    }

    private fun s16Tou8(i: Int): Byte {
        // apply dithering
        val ufval = (i.toDouble() / 65536.0) + 0.5
        val ival = randomRound(ufval * 255.0)
        return ival.toInt().toByte()
    }

    private val samplesL = IntArray(1152) // should contain 1152 samples
    private val samplesR = IntArray(1152) // should contain 1152 samples

    internal fun decodeFrameU8(mp2: MP2, framePtr: Long?, pcm: Boolean, out: Long): IntArray {
        val outVector = if (out >= 0) 1 else -1

        var pushSizeL = 0
        var pushSizeR = 0

        val pushL: (Int) -> Unit = { sampleL: Int ->
            samplesL[pushSizeL++] = sampleL
        }
        val pushR: (Int) -> Unit = { sampleR: Int ->
            samplesR[pushSizeR++] = sampleR
        }

        val ret = try {
            _decodeFrame(mp2, framePtr, pcm, pushL, pushR)
        }
        catch (e: Throwable) {
            e.printStackTrace()
            intArrayOf(0, 0)
        }

        // dither samples and store them to the given "out" pointer
        var outPos = out
        for (i in 0..1151) {
            vm.poke(outPos, s16Tou8(samplesL[i]))
            vm.poke(outPos + outVector, s16Tou8(samplesR[i]))
            outPos += 2*outVector
        }

        return ret
    }

    fun decodeFrame(mp2: MP2, framePtr: Long?, pcm: Boolean, outL: Long, outR: Long): IntArray {
        var pushSizeL = 0
        var pushSizeR = 0

        val pushL = { sampleL: Int ->
            vm.poke(outL + pushSizeL + 0, (sampleL and 255).toByte())
            vm.poke(outL + pushSizeL + 1, (sampleL shr 8).toByte())
            pushSizeL += 2
        }
        val pushR = { sampleR: Int ->
            vm.poke(outR + pushSizeR + 0, (sampleR and 255).toByte())
            vm.poke(outR + pushSizeR + 1, (sampleR shr 8).toByte())
            pushSizeR += 2
        }

        return _decodeFrame(mp2, framePtr, pcm, pushL, pushR)
    }

    private fun _decodeFrame(mp2: MP2, framePtr: Long?, pcm: Boolean, pushL: (Int) -> Unit, pushR: (Int) -> Unit): IntArray {
        if (framePtr == null) {
            throw Error("Frame is null")
        }
        val incr = if (framePtr >= 0) 1 else -1
        mp2_frameIncr = incr
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
        if ((syspeek(mp2_frame!!) != 0xFF) || ((syspeek(mp2_frame!! + 1*incr) and 0xFE) != 0xFC)){
            throw Error("Invalid MP2 header at $mp2_frame: ${syspeek(mp2_frame!!).toString(16)} ${syspeek(mp2_frame!! + 1*incr).toString(16)}")
        };

        // set up the bitstream reader
        mp2_bit_window = syspeek(mp2_frame!! + 2*incr) shl 16;
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
        if ((syspeek(mp2_frame!! + 1*incr) and 1) == 0)
            get_bits(16);

        // compute the frame size
        frame_size = Math.floor(144000.0 * mp2_bitrates[bit_rate_index_minus1] / mp2_sample_rates[sampling_frequency]).toInt() + padding_bit;
        if (!pcm){
            return intArrayOf(frame_size, 0);  // no decoding
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

//        if (pushSizeL != pushSizeR && pushSizeR > 0) {
//            throw Error("Push size mismatch -- U${pushSizeL} != R${pushSizeR}")
//        }
//        return intArrayOf(frame_size, pushSizeL);
            return intArrayOf(frame_size, 2304);
    };

}
