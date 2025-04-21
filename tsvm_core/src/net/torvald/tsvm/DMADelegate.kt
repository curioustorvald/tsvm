package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.tsvm.peripheral.GraphicsAdapter

/**
 * Created by minjaesong on 2021-10-15.
 */
class DMADelegate(private val vm: VM) {

    private val READ = "READ".toByteArray(VM.CHARSET)
    private val FLUSH = "FLUSH".toByteArray(VM.CHARSET)
    private val CLOSE = "CLOSE".toByteArray(VM.CHARSET)

    private fun WRITE(n: Int) = "WRITE$n".toByteArray(VM.CHARSET)

    fun ramToFrame(from: Int, devnum: Int, offset: Int, length: Int) {
        (vm.peripheralTable[devnum].peripheral as? GraphicsAdapter)?.let {
            UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + from, null, it.framebuffer.ptr + offset, length.toLong())
        }
    }

    fun ramToFrame2(from: Int, devnum: Int, offset: Int, length: Int) {
        (vm.peripheralTable[devnum].peripheral as? GraphicsAdapter)?.let {
            UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + from, null, it.framebuffer2!!.ptr + offset, length.toLong())
        }
    }

    fun ramToFrame(from: Int, to: Int, length: Int) {
        for (i in 0..7) {
            if (vm.peripheralTable[i].type == VM.PERITYPE_GPU_AND_TERM) {
                ramToFrame(from, i, to, length)
                return
            }
        }
    }

    fun ramToFrame2(from: Int, to: Int, length: Int) {
        for (i in 0..7) {
            if (vm.peripheralTable[i].type == VM.PERITYPE_GPU_AND_TERM) {
                ramToFrame2(from, i, to, length)
                return
            }
        }
    }

    fun frameToRam(from: Int, to: Int, devnum: Int, length: Int) {
        (vm.peripheralTable[devnum].peripheral as? GraphicsAdapter)?.let {
            UnsafeHelper.memcpyRaw(null, it.framebuffer.ptr + from, null, vm.usermem.ptr + to, length.toLong())
        }
    }

    fun frameToRam(from: Int, to: Int, length: Int) {
        for (i in 0..7) {
            if (vm.peripheralTable[i].type == VM.PERITYPE_GPU_AND_TERM) {
                frameToRam(from, to, i, length)
                return
            }
        }
    }

    fun comToRam(portNo: Int, srcOff: Int, destOff: Int, length: Int) {
        SerialHelper.sendMessage(vm, portNo, READ)
        val response = SerialHelper.getStatusCode(vm, portNo)
        if (response == 0) {
            val file = SerialHelper.pullMessage(vm, portNo)

            // to user mem
            if (destOff >= 0)
                UnsafeHelper.memcpyRaw(file, UnsafeHelper.getArrayOffset(file) + srcOff.toLong(), null, vm.usermem.ptr + destOff, length.toLong())
            // to hardware
            else {
                val destL = destOff.toLong()
                for (i in 0 until length) {
                    vm.poke(destL - i, file[i])
                }
            }
        }
    }

    fun ramToCom(srcOff: Int, portNo: Int, length: Int) {
        SerialHelper.sendMessage(vm, portNo, WRITE(length))
        val response = SerialHelper.getStatusCode(vm, portNo)
        if (response == 0) {
            val msg = ByteArray(length)
            // from user mem
            if (srcOff >= 0)
                UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + srcOff, msg, UnsafeHelper.getArrayOffset(msg), length.toLong())
            // from hardware
            else {
                val srcL = srcOff.toLong()
                for (i in 0 until length) {
                    msg[i] = vm.peek(srcL - i)!!
                }
            }
            SerialHelper.sendMessage(vm, portNo, msg)
            SerialHelper.sendMessage(vm, portNo, FLUSH)
            SerialHelper.sendMessage(vm, portNo, CLOSE)
        }
    }

    fun ramToRam(from: Int, to: Int, length: Int) {
        UnsafeHelper.memcpy(vm.usermem.ptr + from, vm.usermem.ptr + to, length.toLong())
    }

    fun strToRam(str: String, to: Int, srcOff: Int, length: Int) {
        for (i in srcOff until srcOff + length) {
            vm.poke(to.toLong() + i, str[i - srcOff].code.toByte())
        }
    }
}