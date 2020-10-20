package net.torvald.tsvm

import com.badlogic.gdx.utils.Base64Coder

class Base64Delegate {

    fun atob(inputstr: String): ByteArray {
        return Base64Coder.decode(inputstr)
    }

    fun btoa(inputbytes: ByteArray): String {
        val sb = StringBuilder()
        sb.append(Base64Coder.encode(inputbytes))
        return sb.toString()
    }

}