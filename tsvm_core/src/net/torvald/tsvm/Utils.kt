package net.torvald.tsvm

/**
 * Created by minjaesong on 2023-01-04.
 */
fun getHashStr(length: Int = 5) = (0 until length).map { "YBNDRFG8EJKMCPQXOTLVWIS2A345H769"[Math.random().times(32).toInt()] }.joinToString("")

fun Boolean.toInt(shift: Int = 0) = if (this) 1 shl shift else 0
fun Byte.isNonZero() = this != 0.toByte()
