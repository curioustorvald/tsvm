package net.torvald.tsvm.peripheral

/**
 * VLIW-style of Draw Call bytecodes
 *
 * Created by minjaesong on 2022-11-29.
 */
internal interface DrawCall {
    fun execute(gpu: GraphicsAdapter)
}

internal class DrawCallCompound(val call1: DrawCall, val call2: DrawCall, val call3: DrawCall) : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {
        call1.execute(gpu)
        call2.execute(gpu)
        call3.execute(gpu)
    }
}

internal object DrawCallNop : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {}
}

internal object DrawCallEnd : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {}
}

internal class GotoScanline(val line: Int) : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {
        gpu.rScanline = line
    }
}

internal class JumpIfScanline(
    val compare: Int,
    val whenLessThan: Int,
    val whenEqualTo: Int,
    val whenGreaterThan: Int
) : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {
        if (gpu.rScanline < compare) {
            if (whenLessThan != 65535) gpu.rScanline = whenLessThan - 1
        }
        else if (gpu.rScanline == compare) {
            if (whenEqualTo != 65535) gpu.rScanline = whenEqualTo - 1
        }
        else {
            if (whenGreaterThan != 65535) gpu.rScanline = whenGreaterThan - 1
        }
    }
}

/**
 * DrawDoubleLines: simply double the `len` parameter
 */
internal class DrawCallDrawLines(
    val opCount: Int, val colour: Int, val lenMult: Int,
    val xposs: IntArray, val lens: IntArray
) : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {
        val cc = colour.toByte()

        for (k in 0 until opCount) {
            for (i in xposs[k] until xposs[k] + lens[k]) gpu.framebuffer.set(gpu.rScanline * gpu.WIDTH * 1L + i, cc)
            gpu.rScanline += Math.ceil(lens[k].toDouble() / gpu.WIDTH).toInt()
        }
    }
}


internal class DrawCallCopyPixels(
    val opCount: Int,
    val addrFrom: Int,
    val xPos: Int,
    val lineLength: Int,
    val stride1: Int,
    val stride2: Int,
    val stride3: Int,
    val stride4: Int,
    val stride5: Int
) : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {
        TODO("Not yet implemented")
    }
}