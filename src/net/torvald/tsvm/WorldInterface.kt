package net.torvald.tsvm

interface WorldInterface {
    fun currentTimeInMills(): Long
}

/**
 * Real world interface for non-ingame testing. For the Ingame, implement your own.
 */
class TheRealWorld : WorldInterface {
    override fun currentTimeInMills(): Long = System.currentTimeMillis()
}