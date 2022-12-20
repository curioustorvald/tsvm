package net.torvald.tsvm.peripheral

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.*
import net.torvald.tsvm.VM
import java.io.IOException

/**
 * Created by minjaesong on 2022-12-17.
 */
class TevdFileDescriptor(val DOM: VirtualDisk, _pathstr: String) {

    val path = _pathstr.replace('\\', '/')
    val vdPath = VDUtil.VDPath(path, VM.CHARSET)

    val entryID: EntryID?
        get() = VDUtil.getFile(DOM, vdPath)?.entryID

    val canonicalPath = path.replace('/', '\\')

    /*init {
        println("$path's vdPath:")
        vdPath.hierarchy.forEach {
            println("  ${it.toCanonicalString(VM.CHARSET)} [${it.joinToString(" ") { it.toString(16).padStart(2, '0') } }]")
        }
    }*/

    val nameBytes = if (vdPath.hierarchy.isEmpty()) ByteArray(DiskEntry.NAME_LENGTH) else vdPath.last()
    val name = nameBytes.toCanonicalString(VM.CHARSET)


    val isFile: Boolean
        get() = entryID.let { if (it == null) false else VDUtil.isFileFollowSymlink(DOM, it) }

    val isDirectory: Boolean
        get() = entryID.let { if (it == null) false else VDUtil.isDirectoryFollowSymlink(DOM, it) }


    fun appendBytes(bytes: ByteArray) {
        val fileContent = VDUtil.getAsNormalFile(DOM, vdPath) // this is not an object properties: the reference to the file may have been changed
        fileContent.getContent().appendBytes(bytes)
    }

    fun writeBytes(bytes: ByteArray) {
        val fileContent = VDUtil.getAsNormalFile(DOM, vdPath)
//        println("[TevdFileDesc] ${path} writing ${bytes.size} bytes...")
//        println("Old: ${fileContent.getContent().toByteArray().toString(VM.CHARSET)}")
        fileContent.replaceContent(ByteArray64.fromByteArray(bytes))
//        println("New: ${fileContent.getContent().toByteArray().toString(VM.CHARSET)}")
    }

    /**
     * @param length how many bytes to read
     * @return actual bytes read, the size may be less than `length` if the actual file size is smaller
     */
    fun getHeadBytes64(length: Long): ByteArray64 {
        if (isDirectory) throw RuntimeException("Not a file")
        if (!exists()) throw IOException("File not found")

        val fileContent = VDUtil.getAsNormalFile(DOM, vdPath)

        return fileContent.getContent().let {
            it.sliceArray64(0L until minOf(length, it.size))
        }
    }
    /**
     * @param length how many bytes to read
     * @return actual bytes read, the size may be less than `length` if the actual file size is smaller
     */
    fun getHeadBytes(length: Int): ByteArray {
        if (isDirectory) throw RuntimeException("Not a file")
        if (!exists()) throw IOException("File not found")

        val fileContent = VDUtil.getAsNormalFile(DOM, vdPath)

        return fileContent.getContent().let {
            it.sliceArray(0 until minOf(length.toLong(), it.size).toInt())
        }
    }

    fun exists(): Boolean {
        return VDUtil.getFile(DOM, vdPath) != null
    }

    fun delete() {
        VDUtil.deleteFile(DOM, vdPath)
    }

    fun length(): Long {
        return if (isFile) VDUtil.getAsNormalFileOrNull(DOM, vdPath)?.getSizePure() ?: 0L
        else -1L
    }

    fun listFiles(): Array<TevdFileDescriptor>? {
        if (isFile) return null

        entryID.let {
            if (it == null) return null

            return VDUtil.getDirectoryEntries(DOM, it).map {
                TevdFileDescriptor(DOM, path + '/' + it.getFilenameString(VM.CHARSET))
            }.toTypedArray()
        }
    }

    fun readBytes(): ByteArray {
        if (isDirectory) throw RuntimeException("Not a file")
        if (!exists()) throw IOException("File not found")
        return VDUtil.getAsNormalFile(DOM, vdPath).getContent().toByteArray()
    }

    fun mkdir(): Boolean {
        return try {
            VDUtil.addDir(DOM, vdPath.getParent(), nameBytes)
            true
        }
        catch (e: KotlinNullPointerException) {
            false
        }
    }

    fun createNewFile(): Boolean {
        val fileContent = EntryFile(ByteArray64())
        val time_t = System.currentTimeMillis() / 1000
        val newFile = DiskEntry(-1, -1, nameBytes, time_t, time_t, fileContent)
        return try {
            VDUtil.addFile(DOM, vdPath.getParent(), newFile)
            true
        }
        catch (e: KotlinNullPointerException) {
            false
        }
    }

    fun setLastModified(newTime_t: Long): Boolean {
        return VDUtil.getFile(DOM, vdPath).let {
            if (it != null) {
                it.modificationDate = newTime_t
                true
            }
            else false
        }
    }


}