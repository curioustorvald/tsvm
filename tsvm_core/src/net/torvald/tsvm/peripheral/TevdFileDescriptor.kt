package net.torvald.tsvm.peripheral

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.*
import net.torvald.tsvm.VM
import java.io.IOException

/**
 * Created by minjaesong on 2022-12-17.
 */
class TevdFileDescriptor(val DOM: VirtualDisk, _pathstr: String) {

    val path = _pathstr.replace('/', '\\')
    val vdPath = VDUtil.VDPath(path, VM.CHARSET)

    val entryID: EntryID?
        get() = VDUtil.getFile(DOM, vdPath)?.entryID

    val canonicalPath: String
        get() = path
    val name: String
        get() = path.substring(path.lastIndexOf('\\') + 1)
    val nameBytes: ByteArray
        get() = name.toByteArray(VM.CHARSET)


    val isFile: Boolean
        get() = entryID.let { if (it == null) false else VDUtil.isFileFollowSymlink(DOM, it) }

    val isDirectory: Boolean
        get() = entryID.let { if (it == null) false else VDUtil.isDirectoryFollowSymlink(DOM, it) }


    private var fileContent: EntryFile? = null

    fun appendBytes(bytes: ByteArray) {
        fileContent?.getContent()?.appendBytes(bytes)
    }

    fun writeBytes(bytes: ByteArray) {
        fileContent?.replaceContent(ByteArray64.fromByteArray(bytes))
    }

    /**
     * @param length how many bytes to read
     * @return actual bytes read, the size may be less than `length` if the actual file size is smaller
     */
    fun getHeadBytes64(length: Long): ByteArray64 {
        if (fileContent == null) throw IOException("No such file or not a file")
        return fileContent!!.getContent().sliceArray64(0L until length)
    }
    /**
     * @param length how many bytes to read
     * @return actual bytes read, the size may be less than `length` if the actual file size is smaller
     */
    fun getHeadBytes(length: Int): ByteArray {
        if (fileContent == null) throw IOException("No such file or not a file")
        return fileContent!!.getContent().sliceArray(0 until length)
    }

    fun exists(): Boolean {
        return VDUtil.getFile(DOM, vdPath) != null
    }

    fun delete() {
        fileContent = null
        VDUtil.deleteFile(DOM, vdPath)
    }

    fun length(): Long {
        return if (isFile) fileContent?.getSizePure() ?: 0L
        else -1L
    }

    fun listFiles(): Array<TevdFileDescriptor>? {
        if (isFile) return null

        entryID.let {
            if (it == null) return null

            return VDUtil.getDirectoryEntries(DOM, it).map {
                TevdFileDescriptor(DOM, path + '\\' + it.getFilenameString(VM.CHARSET))
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
        fileContent = EntryFile(ByteArray64())
        val time_t = System.currentTimeMillis() / 1000
        val newFile = DiskEntry(-1, -1, nameBytes, time_t, time_t, fileContent!!)
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