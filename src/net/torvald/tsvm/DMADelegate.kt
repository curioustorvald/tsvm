package net.torvald.tsvm

import net.torvald.UnsafeHelper
import net.torvald.tsvm.peripheral.GraphicsAdapter

/**
 * Created by minjaesong on 2021-10-15.
 */
class DMADelegate(val vm: VM) {

    private val READ = "READ".toByteArray(VM.CHARSET)
    private val FLUSH = "FLUSH".toByteArray(VM.CHARSET)
    private val CLOSE = "CLOSE".toByteArray(VM.CHARSET)

    private fun WRITE(n: Int) = "WRITE$n".toByteArray(VM.CHARSET)

    fun ramToFrame(from: Int, devnum: Int, offset: Int, length: Int) {
        (vm.peripheralTable[devnum].peripheral as? GraphicsAdapter)?.let {
            val data = ByteArray(length)
            UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + from, data, UnsafeHelper.getArrayOffset(data), length.toLong())
            it.framebuffer.pixels.position(offset)
            it.framebuffer.pixels.put(data)
            it.framebuffer.pixels.position(0) // rewinding to avoid graphical glitch
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

    fun frameToRam(from: Int, to: Int, devnum: Int, length: Int) {
        (vm.peripheralTable[devnum].peripheral as? GraphicsAdapter)?.let {
            val data = ByteArray(length)
            it.framebuffer.pixels.position(from)
            it.framebuffer.pixels.get(data)
            it.framebuffer.pixels.position(0) // rewinding to avoid graphical glitch
            UnsafeHelper.memcpyRaw(data, UnsafeHelper.getArrayOffset(data), null, vm.usermem.ptr + to, length.toLong())
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
            UnsafeHelper.memcpyRaw(file, UnsafeHelper.getArrayOffset(file) + srcOff.toLong(), null, vm.usermem.ptr + destOff, length.toLong())
        }
    }

    fun ramToCom(srcOff: Int, portNo: Int, length: Int) {
        SerialHelper.sendMessage(vm, portNo, WRITE(length))
        val response = SerialHelper.getStatusCode(vm, portNo)
        if (response == 0) {
            val msg = ByteArray(length)
            UnsafeHelper.memcpyRaw(null, vm.usermem.ptr + srcOff, msg, UnsafeHelper.getArrayOffset(msg), length.toLong())
            SerialHelper.sendMessage(vm, portNo, msg)
            SerialHelper.sendMessage(vm, portNo, FLUSH)
            SerialHelper.sendMessage(vm, portNo, CLOSE)
        }
    }

    fun ramToRam(from: Int, to: Int, length: Int) {
        UnsafeHelper.memcpy(vm.usermem.ptr + from, vm.usermem.ptr + to, length.toLong())
    }
}