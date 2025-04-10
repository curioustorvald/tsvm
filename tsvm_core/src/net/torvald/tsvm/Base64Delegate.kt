package net.torvald.tsvm

import com.badlogic.gdx.utils.Base64Coder
import net.torvald.UnsafeHelper

class Base64Delegate(val vm: VM) {

    fun atob(inputstr: String): ByteArray {
        return Base64Coder.decode(inputstr)
    }

    fun atostr(inputstr: String): java.lang.String {
        return Base64Coder.decode(inputstr).toString(VM.CHARSET) as java.lang.String
    }

    fun btoa(inputbytes: ByteArray): java.lang.String {
        val sb = StringBuilder()
        sb.append(Base64Coder.encode(inputbytes))
        return sb.toString() as java.lang.String
    }

    fun atoptr(inputstr: String): Int {
        val b = atob(inputstr)
        val ptr = vm.malloc(b.size)
        UnsafeHelper.memcpyRaw(b, UnsafeHelper.getArrayOffset(b), null, vm.usermem.ptr + ptr, b.size.toLong())
        return ptr
    }

}