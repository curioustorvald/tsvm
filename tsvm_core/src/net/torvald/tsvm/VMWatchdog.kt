package net.torvald.tsvm

import com.badlogic.gdx.utils.Queue
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.VDUtil
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.VirtualDisk
import java.io.File

/**
 * Created by minjaesong on 2022-12-18.
 */
abstract class VMWatchdog {

    /** Seconds between sleep */
    abstract val interval: Float
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


object TevdSyncWatchdog : VMWatchdog() {
    override val interval = 5f

    private val messageQueue = ArrayList<Pair<File, VirtualDisk>>()

    override fun consumeMessages() {
        synchronized(this) {
            messageQueue.forEach { (outfile, dom) ->
                VDUtil.dumpToRealMachine(dom, outfile)
//                println("[${this.javaClass.simpleName}] dump ${outfile.path}")
            }
            messageQueue.clear()
        }
    }

    override fun addMessage(message: Array<Any?>) {
        val file = message[0] as File
        val dom = message[1] as VirtualDisk

        val hasDup = messageQueue.fold(false) { acc, pair -> acc or (pair.first.path == file.path) }
        if (!hasDup) {
            messageQueue.add(file to dom)
        }
    }
}