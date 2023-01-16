package net.torvald.tsvm

import com.badlogic.gdx.utils.Base64Coder
import net.torvald.UnsafeHelper

class Base64Delegate(val vm: VM) {

    fun atob(inputstr: String): ByteArray {
        return Base64Coder.decode(inputstr)
    }

    fun atostr(inputstr: String): String {
        return Base64Coder.decode(inputstr).toString(VM.CHARSET)
    }

    fun btoa(inputbytes: ByteArray): String {
        val sb = StringBuilder()
        sb.append(Base64Coder.encode(inputbytes))
        return sb.toString()
    }

    fun atoptr(inputstr: String): Int {
        val b = atob(inputstr)
        val ptr = vm.malloc(b.size)
        UnsafeHelper.memcpyRaw(b, UnsafeHelper.getArrayOffset(b), null, vm.usermem.ptr + ptr, b.size.toLong())
        return ptr
    }

}