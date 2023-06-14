package net.torvald.tsvm

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.graphics.g2d.SpriteBatch
import net.torvald.reflection.extortField
import net.torvald.reflection.forceInvoke
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.DiskSkimmer.Companion.read
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.archivers.ClusteredFormatDOM
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.archivers.seekToCluster
import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.VMEmuExecutableWrapper.Companion.FONT
import net.torvald.tsvm.peripheral.TevdDiskDrive
import java.io.RandomAccessFile

/**
 * Created by minjaesong on 2023-03-25.
 */
class TevdMenu(parent: VMEmuExecutable, x: Int, y: Int, w: Int, h: Int) : EmuMenu(parent, x, y, w, h) {


    private val devHasHook = HashSet<TevdDiskDrive>()

    override fun show() {
    }

    override fun hide() {
    }

    override fun update() {
    }

    private fun setupHook(dev: TevdDiskDrive, batch: SpriteBatch) {
        if (!devHasHook.contains(dev)) {
            devHasHook.add(dev)

            val DOM = dev.extortField<ClusteredFormatDOM>("DOM")!!
            val ARCHIVE = DOM.extortField<RandomAccessFile>("ARCHIVE")!!

            // this fails due to two reasons:
            // 1. vm context is not GL context
            // 2. probing at the disk during read/write operation corrupts shits
            /*DOM.diskModifiedHook = {
                val batchInUse = batch.isDrawing
                if (!batchInUse) batch.begin()
                rebuildClustmap(batch, DOM, ARCHIVE, 12, 12 + 13 * 3 + btnGap)
                if (!batchInUse) batch.end()
            }*/

        }
    }

    override fun render(batch: SpriteBatch) {

        val dev = parent.currentlyPersistentVM?.vm?.getIO()?.blockTransferPorts?.getOrNull(cardIndex ?: -1)?.recipient


        if (dev?.javaClass?.simpleName == "TevdDiskDrive") {
            val dev = dev as TevdDiskDrive
            val DOM = dev.extortField<ClusteredFormatDOM>("DOM")!!
            val ARCHIVE = DOM.extortField<RandomAccessFile>("ARCHIVE")!!

            setupHook(dev, batch)

            batch.inUse {
                batch.color = Color.WHITE
                FONT.draw(batch, "Disk UUID: ${dev.diskUUIDstr}", 12f, 12f)
                FONT.draw(batch, "Used: ${DOM.usedClusterCount}/${DOM.totalClusterCount} Clusters", 12f, 12f + 13*1)
                FONT.draw(batch, "Cluster Map:", 12f, 12f + 13*2)

            }
        }
        else {
            batch.inUse {
                batch.color = Color.WHITE
                FONT.draw(batch, "Device is not TevdDiskDrive", 12f, 12f)
            }
        }


    }


    private val buttonColourFree = Color(0xfafafaff.toInt())
    private val buttonColourOccupied = listOf(
        4086 to Color(0xff0d89ff.toInt()),
        3269 to Color(0xff5899ff.toInt()),
        2452 to Color(0xff7daaff.toInt()),
        1635 to Color(0xff9bbaff.toInt()),
        818 to Color(0xffb6cbff.toInt()),
        1 to Color(0xfed0dcff.toInt()),
    )
    private fun contentsSizeToButtonColour(i: Int): Color {
        for (kv in buttonColourOccupied) {
            if (i >= kv.first) return kv.second
        }
        return buttonColourFree
    }

    private val buttonColourFAT = Color(0x6cee91ff.toInt())
    private val buttonColourFATdata = Color(0xf6cb07ff.toInt())
    private val buttonColourReserved = Color(0x12adffff.toInt())
    private val buttonColourVirtual = Color(0xece8d9ff.toInt())

    private var btnW = 12
    private var btnH = 12
    private var btnGap = 2


    private fun rebuildClustmap(batch: SpriteBatch, vdisk: ClusteredFormatDOM, ARCHIVE: RandomAccessFile, paintX: Int, paintY: Int) {
        val fatClusterCount = vdisk.extortField<Int>("fatClusterCount")!!

        vdisk?.let { vdisk ->
            for (i in 0 until vdisk.totalClusterCount) {
                val buttonCol = if (i in 0..1) buttonColourReserved
                else if (i < fatClusterCount!! + 2) {
                    ARCHIVE.seekToCluster(i)
                    var dataFats = 0
                    for (k in 0 until ClusteredFormatDOM.CLUSTER_SIZE step ClusteredFormatDOM.FAT_ENTRY_SIZE) {
                        if (ARCHIVE.read(ClusteredFormatDOM.FAT_ENTRY_SIZE).toInt24() >= ClusteredFormatDOM.INLINE_FILE_CLUSTER_BASE) dataFats += 1
                    }
                    buttonColourFAT.cpy().lerp(buttonColourFATdata, dataFats.toFloat() / ClusteredFormatDOM.FATS_PER_CLUSTER)
                }
                else if (i >= ARCHIVE.length() / ClusteredFormatDOM.CLUSTER_SIZE) buttonColourVirtual
                else {
                    contentsSizeToButtonColour(vdisk.contentSizeInThisCluster(i))
                }

                // do something with buttonCol
                val x = paintX + (i / 20) * (btnW + btnGap)
                val y = paintY + (i % 20) * (btnH + btnGap)
                batch.color = buttonCol
                batch.fillRect(x, y, btnW, btnH)

            }
        }
    }

    private fun ByteArray.toInt24(offset: Int = 0): Int {
        return  this[0 + offset].toUint().shl(16) or
                this[1 + offset].toUint().shl(8) or
                this[2 + offset].toUint()
    }


    override fun dispose() {
    }
}