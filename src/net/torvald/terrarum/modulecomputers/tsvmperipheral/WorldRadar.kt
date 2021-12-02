package net.torvald.terrarum.modulecomputers.tsvmperipheral

import com.badlogic.gdx.files.FileHandle
import com.badlogic.gdx.graphics.Pixmap
import net.torvald.tsvm.VM
import net.torvald.tsvm.peripheral.BlockTransferInterface
import net.torvald.tsvm.peripheral.TestDiskDrive
import net.torvald.tsvm.peripheral.trimNull
import java.io.ByteArrayOutputStream

/**
 * Created by minjaesong on 2021-12-02.
 */
class WorldRadar(pngfile: FileHandle) : BlockTransferInterface(false, true) {

    private val W = 162
    private val H = 142

    private val world = ByteArray(256*256)

    private val AIR = 0.toByte()
    private val DIRT = 1.toByte()
    private val GRASS = 2.toByte()
    private val STONE = 16.toByte()

    private val AIR_OUT = 0.toByte()
    private val GRASS_OUT = 2.toByte()
    private val DIRT_OUT = 4.toByte()
    private val STONE_OUT = 7.toByte()

    init {
        statusCode = TestDiskDrive.STATE_CODE_STANDBY

        val worldTex = Pixmap(pngfile)
        for (y in 0 until worldTex.height) { for (x in 0 until worldTex.width) {
            val c = worldTex.getPixel(x, y)
            world[y * worldTex.width + x] = when (c) {
                0x46712dff -> GRASS
                0x9b9a9bff.toInt() -> STONE
                0x6a5130ff -> DIRT
                else -> AIR
            }
        }}

        worldTex.dispose()
    }

    private val messageComposeBuffer = ByteArrayOutputStream(BLOCK_SIZE) // always use this and don't alter blockSendBuffer please
    private var blockSendBuffer = ByteArray(1)
    private var blockSendCount = 0

    private fun resetBuf() {
        blockSendCount = 0
        messageComposeBuffer.reset()
    }


    override fun hasNext(): Boolean {
        return (blockSendCount * BLOCK_SIZE < blockSendBuffer.size)
    }

    override fun startSendImpl(recipient: BlockTransferInterface): Int {
        if (blockSendCount == 0) {
            blockSendBuffer = messageComposeBuffer.toByteArray()
        }

        val sendSize = if (blockSendBuffer.size - (blockSendCount * BLOCK_SIZE) < BLOCK_SIZE)
            blockSendBuffer.size % BLOCK_SIZE
        else BLOCK_SIZE

        recipient.writeout(ByteArray(sendSize) {
            blockSendBuffer[blockSendCount * BLOCK_SIZE + it]
        })

        blockSendCount += 1

        return sendSize
    }

    private var oldCmdbuf = HashMap<Int,Byte>(1024)

    override fun writeoutImpl(inputData: ByteArray) {
        val inputString = inputData.trimNull().toString(VM.CHARSET)

        // prepare draw commands
        /*
         * draw command format:
         *
         * <Y> <X> <COL>
         *
         * marking rules:
         *
         * : exposed = has at least 1 nonsolid on 4 sides
         *
         * 1. exposed grass -> 2
         * 2. exposed dirt -> 4
         * 3. exposed stone -> 7
         * 4. stone exposed to dirt/grass -> 7
         */
        if (inputString.startsWith("POLL")) {
            resetBuf()
            val cmdbuf = HashMap<Int,Byte>(1024)

            for (y in 1..H-2) { for (x in 1..W-2) {
                val yx = (y-1).shl(8) or x
                val i = y * W + x
                val nearby = listOf(i-W,i-1,i+1,i+W).map { world[it] } // up, left, right, down
                val block = world[i]

                if (block == GRASS && nearby.contains(AIR)) {
                    cmdbuf[yx] = GRASS_OUT
                }
                else if (block == DIRT && nearby.contains(AIR)) {
                    cmdbuf[yx] = DIRT_OUT
                }
                else if (block == STONE && (nearby.contains(AIR) || nearby.contains(GRASS) || nearby.contains(DIRT))) {
                    cmdbuf[yx] = STONE_OUT
                }
            }}

            (oldCmdbuf.keys union cmdbuf.keys).sorted().forEach { key ->
                val value = (cmdbuf[key] ?: AIR_OUT).toInt()
                val x = key % 256
                val y = key / 256
                messageComposeBuffer.write(y)
                messageComposeBuffer.write(x)
                messageComposeBuffer.write(value)
            }

            oldCmdbuf = cmdbuf
        }
    }
}