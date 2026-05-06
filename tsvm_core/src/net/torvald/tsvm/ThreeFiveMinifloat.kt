package net.torvald.tsvm

/**
 * 3.5 unsigned minifloat (3-bit exponent + 5-bit mantissa), scaled so the
 * smallest non-zero step is 1/256 s ≈ 3.91 ms and the maximum representable
 * value is 15.75 s. Used for Taud envelope point offsets — the resolution at
 * the low end is fine enough to resolve individual tracker ticks at every
 * supported BPM (worst case ±17 % at BPM 250+, vs. ±150 % under the original
 * 1/32-step bias).
 *
 * Created by minjaesong on 2022-12-30. Rebiased for tracker tick resolution
 * on 2026-05-07 (entire LUT divided by 8).
 */
@JvmInline
value class ThreeFiveMiniUfloat(val index: Int = 0) {

    init {
        if (index and 0xffffff00.toInt() != 0) throw IllegalArgumentException("Index not in 0..255 ($index)")
    }

    companion object {
        val LUT = floatArrayOf(0f,0.00390625f,0.0078125f,0.01171875f,0.015625f,0.01953125f,0.0234375f,0.02734375f,0.03125f,0.03515625f,0.0390625f,0.04296875f,0.046875f,0.05078125f,0.0546875f,0.05859375f,0.0625f,0.06640625f,0.0703125f,0.07421875f,0.078125f,0.08203125f,0.0859375f,0.08984375f,0.09375f,0.09765625f,0.1015625f,0.10546875f,0.109375f,0.11328125f,0.1171875f,0.12109375f,0.125f,0.12890625f,0.1328125f,0.13671875f,0.140625f,0.14453125f,0.1484375f,0.15234375f,0.15625f,0.16015625f,0.1640625f,0.16796875f,0.171875f,0.17578125f,0.1796875f,0.18359375f,0.1875f,0.19140625f,0.1953125f,0.19921875f,0.203125f,0.20703125f,0.2109375f,0.21484375f,0.21875f,0.22265625f,0.2265625f,0.23046875f,0.234375f,0.23828125f,0.2421875f,0.24609375f,0.25f,0.2578125f,0.265625f,0.2734375f,0.28125f,0.2890625f,0.296875f,0.3046875f,0.3125f,0.3203125f,0.328125f,0.3359375f,0.34375f,0.3515625f,0.359375f,0.3671875f,0.375f,0.3828125f,0.390625f,0.3984375f,0.40625f,0.4140625f,0.421875f,0.4296875f,0.4375f,0.4453125f,0.453125f,0.4609375f,0.46875f,0.4765625f,0.484375f,0.4921875f,0.5f,0.515625f,0.53125f,0.546875f,0.5625f,0.578125f,0.59375f,0.609375f,0.625f,0.640625f,0.65625f,0.671875f,0.6875f,0.703125f,0.71875f,0.734375f,0.75f,0.765625f,0.78125f,0.796875f,0.8125f,0.828125f,0.84375f,0.859375f,0.875f,0.890625f,0.90625f,0.921875f,0.9375f,0.953125f,0.96875f,0.984375f,1f,1.03125f,1.0625f,1.09375f,1.125f,1.15625f,1.1875f,1.21875f,1.25f,1.28125f,1.3125f,1.34375f,1.375f,1.40625f,1.4375f,1.46875f,1.5f,1.53125f,1.5625f,1.59375f,1.625f,1.65625f,1.6875f,1.71875f,1.75f,1.78125f,1.8125f,1.84375f,1.875f,1.90625f,1.9375f,1.96875f,2f,2.0625f,2.125f,2.1875f,2.25f,2.3125f,2.375f,2.4375f,2.5f,2.5625f,2.625f,2.6875f,2.75f,2.8125f,2.875f,2.9375f,3f,3.0625f,3.125f,3.1875f,3.25f,3.3125f,3.375f,3.4375f,3.5f,3.5625f,3.625f,3.6875f,3.75f,3.8125f,3.875f,3.9375f,4f,4.125f,4.25f,4.375f,4.5f,4.625f,4.75f,4.875f,5f,5.125f,5.25f,5.375f,5.5f,5.625f,5.75f,5.875f,6f,6.125f,6.25f,6.375f,6.5f,6.625f,6.75f,6.875f,7f,7.125f,7.25f,7.375f,7.5f,7.625f,7.75f,7.875f,8f,8.25f,8.5f,8.75f,9f,9.25f,9.5f,9.75f,10f,10.25f,10.5f,10.75f,11f,11.25f,11.5f,11.75f,12f,12.25f,12.5f,12.75f,13f,13.25f,13.5f,13.75f,14f,14.25f,14.5f,14.75f,15f,15.25f,15.5f,15.75f)

        private fun fromFloatToIndex(fval: Float): Int {
            val (llim, hlim) = binarySearchInterval(fval, LUT)
            return if (llim % 2 == 0) llim else hlim // round to nearest even
        }

        /**
         * e.g.
         *
         * 0 2 4 5 7 , find 3
         *
         * will return (1, 2), which corresponds value (2, 4) of which input value 3 is in between.
         */
        private fun binarySearchInterval(value: Float, array: FloatArray): Pair<Int, Int> {
            var low: Int = 0
            var high: Int = array.size - 1

            while (low <= high) {
                val mid = (low + high).ushr(1)
                val midVal = array[mid]

                if (value < midVal)
                    high = mid - 1
                else if (value > midVal)
                    low = mid + 1
                else
                    return Pair(mid, mid)
            }

            val first = Math.max(high, 0)
            val second = Math.min(low, array.size - 1)
            return Pair(first, second)
        }
    }

    constructor(fval: Float) : this(fromFloatToIndex(fval))

    fun toFloat() = LUT[index]
    fun toDouble() = LUT[index].toDouble()


}