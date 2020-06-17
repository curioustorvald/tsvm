package net.torvald.tsvm

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.peripheral.IOSpace
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Font
import javax.swing.JFrame
import javax.swing.JTextArea
import javax.swing.WindowConstants

class Memvwr(val vm: VM) : JFrame() {

    val memArea = JTextArea()

    fun composeVwrText() {
        val sb = StringBuilder()
        val io = vm.peripheralTable[0].peripheral as IOSpace

        sb.append("== MMIO ==\n")

        sb.append("Keyboard buffer: ")
        for (i in 0L..31L) {
            sb.append(io.peek(i)!!.toUByte().toString(16).padStart(2, '0').toUpperCase())
            sb.append(' ')
        }
        sb.append('\n')

        sb.append("Keyboard/Mouse input latched: ")
        sb.append(io.peek(39L) != 0.toByte())
        sb.append('\n')
        sb.append("Mouse pos: ")
        sb.append((io.peek(32L)!!.toUint() or (io.peek(33L)!!.toUint() shl 8)).toShort())
        sb.append(", ")
        sb.append((io.peek(34L)!!.toUint() or (io.peek(35L)!!.toUint() shl 8)).toShort())
        sb.append(" (mouse down: ")
        sb.append(io.peek(36L) != 0.toByte())
        sb.append(")\n")
        sb.append("Keys pressed: ")
        for (i in 40L..47L) {
            sb.append(io.peek(i)!!.toUByte().toString(16).padStart(2, '0').toUpperCase())
            sb.append(' ')
        }
        sb.append('\n')

        sb.append("TTY Keyboard read: ")
        sb.append(io.peek(38L) != 0.toByte())
        sb.append('\n')

        sb.append("Counter latched: ")
        sb.append(io.peek(68L)!!.toString(2).padStart(8, '0'))
        sb.append('\n')

        sb.append("\nBlock transfer status:\n")
        for (port in 0..3) {
            val status = io.peek(4084L + 2 * port)!!.toUint() or (io.peek(4085L + 2 * port)!!.toUint() shl 8)

            sb.append("== Port ${port + 1}\n")
            sb.append("  hasNext: ${(status and 0x8000) != 0}\n")
            sb.append("  size of the block: ${if (status and 0xFFF == 0) 4096 else status and 0xFFF}\n")
        }

        sb.append("\nBlock transfer control:\n")
        for (port in 0..3) {
            val status = io.peek(4092L + port)!!

            sb.append("== Port ${port + 1}: ${status.toString(2).padStart(8, '0')}\n")
        }

        memArea.text = sb.toString()
    }

    fun update() {
        composeVwrText()
    }

    init {
        memArea.font = Font("Monospaced", Font.PLAIN, 12)
        memArea.highlighter = null

        this.layout = BorderLayout()
        this.isVisible = true
        this.add(javax.swing.JScrollPane(memArea), BorderLayout.CENTER)
        this.defaultCloseOperation = WindowConstants.EXIT_ON_CLOSE
        this.size = Dimension(800, 960)
    }
}