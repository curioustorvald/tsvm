package net.torvald.tsvm.vdc

import net.torvald.tsvm.VM
import net.torvald.tsvm.peripheral.GraphicsAdapter

fun main() {
    val vdc = Videotron2K(null)

    vdc.eval(Videotron2K.screenfiller)
}