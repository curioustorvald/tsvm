package net.torvald.tsvm

import com.badlogic.gdx.utils.Base64Coder

object Base64Delegate {

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

}