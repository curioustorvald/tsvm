package net.torvald.tsvm

/**
 * Created by minjaesong on 2022-12-30.
 */
inline class ThreeFiveMiniUfloat(val index: Int = 0) {

    init {
        if (index and 0xffffff00.toInt() != 0) throw IllegalArgumentException("Index not in 0..255 ($index)")
    }

    companion object {
        val LUT = floatArrayOf(0f,0.03125f,0.0625f,0.09375f,0.125f,0.15625f,0.1875f,0.21875f,0.25f,0.28125f,0.3125f,0.34375f,0.375f,0.40625f,0.4375f,0.46875f,0.5f,0.53125f,0.5625f,0.59375f,0.625f,0.65625f,0.6875f,0.71875f,0.75f,0.78125f,0.8125f,0.84375f,0.875f,0.90625f,0.9375f,0.96875f,1f,1.03125f,1.0625f,1.09375f,1.125f,1.15625f,1.1875f,1.21875f,1.25f,1.28125f,1.3125f,1.34375f,1.375f,1.40625f,1.4375f,1.46875f,1.5f,1.53125f,1.5625f,1.59375f,1.625f,1.65625f,1.6875f,1.71875f,1.75f,1.78125f,1.8125f,1.84375f,1.875f,1.90625f,1.9375f,1.96875f,2f,2.0625f,2.125f,2.1875f,2.25f,2.3125f,2.375f,2.4375f,2.5f,2.5625f,2.625f,2.6875f,2.75f,2.8125f,2.875f,2.9375f,3f,3.0625f,3.125f,3.1875f,3.25f,3.3125f,3.375f,3.4375f,3.5f,3.5625f,3.625f,3.6875f,3.75f,3.8125f,3.875f,3.9375f,4f,4.125f,4.25f,4.375f,4.5f,4.625f,4.75f,4.875f,5f,5.125f,5.25f,5.375f,5.5f,5.625f,5.75f,5.875f,6f,6.125f,6.25f,6.375f,6.5f,6.625f,6.75f,6.875f,7f,7.125f,7.25f,7.375f,7.5f,7.625f,7.75f,7.875f,8f,8.25f,8.5f,8.75f,9f,9.25f,9.5f,9.75f,10f,10.25f,10.5f,10.75f,11f,11.25f,11.5f,11.75f,12f,12.25f,12.5f,12.75f,13f,13.25f,13.5f,13.75f,14f,14.25f,14.5f,14.75f,15f,15.25f,15.5f,15.75f,16f,16.5f,17f,17.5f,18f,18.5f,19f,19.5f,20f,20.5f,21f,21.5f,22f,22.5f,23f,23.5f,24f,24.5f,25f,25.5f,26f,26.5f,27f,27.5f,28f,28.5f,29f,29.5f,30f,30.5f,31f,31.5f,32f,33f,34f,35f,36f,37f,38f,39f,40f,41f,42f,43f,44f,45f,46f,47f,48f,49f,50f,51f,52f,53f,54f,55f,56f,57f,58f,59f,60f,61f,62f,63f,64f,66f,68f,70f,72f,74f,76f,78f,80f,82f,84f,86f,88f,90f,92f,94f,96f,98f,100f,102f,104f,106f,108f,110f,112f,114f,116f,118f,120f,122f,124f,126f)

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