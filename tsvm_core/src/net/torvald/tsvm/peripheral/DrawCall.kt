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
        gpu.drawCallRscanline = line
    }
}

internal class JumpIfScanline(
    val compare: Int,
    val whenLessThan: Int,
    val whenEqualTo: Int,
    val whenGreaterThan: Int
) : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {
        if (gpu.drawCallRscanline < compare) {
            if (whenLessThan != 65535) gpu.drawCallRscanline = whenLessThan - 1
        }
        else if (gpu.drawCallRscanline == compare) {
            if (whenEqualTo != 65535) gpu.drawCallRscanline = whenEqualTo - 1
        }
        else {
            if (whenGreaterThan != 65535) gpu.drawCallRscanline = whenGreaterThan - 1
        }
    }
}

internal class DrawCallDrawLines(
    val opCount: Int, val colour: Int,
    val xposLen1: Int,
    val xposLen2: Int = 0,
    val xposLen3: Int = 0,
    val xposLen4: Int = 0,
    val xposLen5: Int = 0,
    val xposLen6: Int = 0,
    val xposLen7: Int = 0,
    val xposLen8: Int = 0
) : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {
        TODO("Not yet implemented")
    }
}

internal class DrawCallDrawDoubleLines(
    val opCount: Int, val colour: Int,
    val xposLen1: Int,
    val xposLen2: Int = 0,
    val xposLen3: Int = 0,
    val xposLen4: Int = 0,
    val xposLen5: Int = 0,
    val xposLen6: Int = 0,
    val xposLen7: Int = 0,
    val xposLen8: Int = 0
) : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {
        TODO("Not yet implemented")
    }
}

internal class DrawCallCopyPixels(
    val opCount: Int,
    val xPos: Int,
    val lineLength: Int,
    val stride1: Int,
    val stride2: Int = 0,
    val stride3: Int = 0,
    val stride4: Int = 0,
    val stride5: Int = 0,
) : DrawCall {
    override fun execute(gpu: GraphicsAdapter) {
        TODO("Not yet implemented")
    }
}