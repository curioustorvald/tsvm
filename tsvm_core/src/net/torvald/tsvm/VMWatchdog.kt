package net.torvald.tsvm

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.PartialDOM
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.VDUtil
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.VirtualDisk
import java.io.File

/**
 * @param interval Seconds between sleep
 *
 * Created by minjaesong on 2022-12-18.
 */
abstract class VMWatchdog(val interval: Float) {

    protected var akku = 0f

    open fun update(delta: Float) {
        akku += delta
        while (akku > interval) {
            consumeMessages()
//            println("[${this.javaClass.simpleName}] boop!")
            akku -= interval
        }
    }

    protected abstract fun consumeMessages()
    abstract fun addMessage(message: Array<Any?>)

}


object TevdPartialDomCommitWatchdog : VMWatchdog(5f) {

    private val messageQueue = ArrayList<Pair<File, PartialDOM>>()

    override fun consumeMessages() {
        synchronized(this) {
            messageQueue.forEach { (outfile, dom) ->
                dom.commit()
                println("[${this.javaClass.simpleName}] commit ${outfile.path}")
            }
            messageQueue.clear()
        }
    }

    override fun addMessage(message: Array<Any?>) {
        val file = message[0] as File
        val dom = message[1] as PartialDOM

        val hasDup = messageQueue.fold(false) { acc, pair -> acc or (pair.first.path == file.path) }
        if (!hasDup) {
            messageQueue.add(file to dom)
        }
    }
}


object TevdPartialDomSyncWatchdog : VMWatchdog(120f) {

    private val messageQueue = ArrayList<Pair<File, PartialDOM>>()

    override fun consumeMessages() {
        synchronized(this) {
            messageQueue.forEach { (outfile, dom) ->
                dom.sync()
                println("[${this.javaClass.simpleName}] sync ${outfile.path}")
            }
            messageQueue.clear()
        }
    }

    override fun addMessage(message: Array<Any?>) {
        val file = message[0] as File
        val dom = message[1] as PartialDOM

        val hasDup = messageQueue.fold(false) { acc, pair -> acc or (pair.first.path == file.path) }
        if (!hasDup) {
            messageQueue.add(file to dom)
        }
    }
}