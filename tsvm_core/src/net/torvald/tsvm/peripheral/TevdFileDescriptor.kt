package net.torvald.tsvm.peripheral

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.*
import net.torvald.tsvm.VM
import java.io.IOException

/**
 * Created by minjaesong on 2022-12-17.
 */
class TevdFileDescriptor(val DOM: PartialDOM, _pathstr: String) {

    val path = _pathstr.replace('\\', '/').let {
        var s = it.substring(0)
        while (s.startsWith("/"))
            s = s.substring(1)
        s
    }
    val vdPath = VDUtil.VDPath(path, VM.CHARSET)

    val entryID: EntryID?
        get() = DOM.requestFile(path)?.entryID

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
        get() = DOM.requestFile(path)?.contents is EntryFile // TODO follow symlink

    val isDirectory: Boolean
        get() = DOM.requestFile(path)?.contents is EntryDirectory // TODO follow symlink


    private fun requestFile(): Pair<DiskEntry, DiskEntryContent> {
        val file = DOM.requestFile(path) ?: throw IOException("File not found")
        val fileContent = file.contents

        return file to fileContent
    }


    fun appendBytes(bytes: ByteArray) {
//        val fileContent = VDUtil.getAsNormalFile(DOM, vdPath) // this is not an object properties: the reference to the file may have been changed
        val (file, fileContent) = requestFile()
        (fileContent as EntryFile).getContent().appendBytes(bytes) // TODO follow symlink
        file.modificationDate = VDUtil.currentUnixtime
    }

    fun writeBytes(bytes: ByteArray) {
        val (file, fileContent) = requestFile()
//        println("[TevdFileDesc] ${path} writing ${bytes.size} bytes...")
//        println("Old: ${fileContent.getContent().toByteArray().toString(VM.CHARSET)}")
        (fileContent as EntryFile).replaceContent(ByteArray64.fromByteArray(bytes)) // TODO follow symlink
//        println("New: ${fileContent.getContent().toByteArray().toString(VM.CHARSET)}")
        file.modificationDate = VDUtil.currentUnixtime
    }

    /**
     * @param length how many bytes to read
     * @return actual bytes read, the size may be less than `length` if the actual file size is smaller
     */
    fun getHeadBytes64(length: Long): ByteArray64 {
        val (file, fileContent) = requestFile()
        return (fileContent as EntryFile).getContent().let {
            it.sliceArray64(0L until minOf(length, it.size))
        }
    }
    /**
     * @param length how many bytes to read
     * @return actual bytes read, the size may be less than `length` if the actual file size is smaller
     */
    fun getHeadBytes(length: Int): ByteArray {
        val (file, fileContent) = requestFile()
        return (fileContent as EntryFile).getContent().let {
            it.sliceArray(0 until minOf(length.toLong(), it.size).toInt())
        }
    }

    fun exists(): Boolean {
        return (DOM.requestFile(path) != null)
    }

    fun delete(): Pair<Boolean, Throwable?> {
        return try {
            val parentDir = vdPath.getParent().toString()
            DOM.removeFile(path)
            DOM.requestFile(parentDir)!!.let {
                it.modificationDate = VDUtil.currentUnixtime
                DOM.touchFile(it)
            }

            true to null
        }
        catch (e: KotlinNullPointerException) {
            false to e
        }
    }

    fun length(): Long {
        val (file, fileContent) = requestFile()
        return if (fileContent is EntryFile)
            fileContent.getSizePure()
        else -1L
    }

    fun listFiles(): Array<TevdFileDescriptor>? {
        val (file, fileContent) = requestFile()
        return if (fileContent !is EntryDirectory) null // TODO follow symlink
        else (DOM.requestFile(path)?.contents as EntryDirectory).getContent().map { id -> DOM.requestFile(id)!! }.map {
            TevdFileDescriptor(DOM, path + '/' + it.getFilenameString(VM.CHARSET))
        }.toTypedArray()
    }

    fun readBytes(): ByteArray {
        val (file, fileContent) = requestFile()
        if (fileContent !is EntryFile) throw RuntimeException("Not a file") // TODO follow symlink
        else
            return fileContent.getContent().toByteArray()
    }

    fun mkdir(): Pair<Boolean, Throwable?> {
        return try {
            val parentDir = vdPath.getParent().toString()

            val dir = DOM.requestFile(parentDir)!!
            val dirContent = dir.contents as EntryDirectory

            val newTime = VDUtil.currentUnixtime
            val newID = DOM.generateUniqueID()
            val newDir = DiskEntry(newID, dir.entryID, nameBytes, newTime, newTime, EntryDirectory())

            DOM.addNewFile(newDir)
            DOM.touchFile(dir)
            dirContent.add(newID)

            dir.modificationDate = newTime

            true to null
        }
        catch (e: KotlinNullPointerException) {
            false to e
        }
    }

    fun createNewFile(): Pair<Boolean, Throwable?> {
        val fileContent = EntryFile(ByteArray64())
        val time_t = System.currentTimeMillis() / 1000
        val newFile = DiskEntry(-1, -1, nameBytes, time_t, time_t, fileContent)
        return try {
            val parentDir = vdPath.getParent().toString()

            val dir = DOM.requestFile(parentDir)!!
            val dirContent = dir.contents as EntryDirectory

            val newTime = VDUtil.currentUnixtime
            val newID = DOM.generateUniqueID()

            newFile.entryID = newID
            newFile.parentEntryID = dir.entryID

            DOM.addNewFile(newFile)
            DOM.touchFile(dir)
            dirContent.add(newID)

            dir.modificationDate = newTime

            true to null
        }
        catch (e: KotlinNullPointerException) {
            false to e
        }
    }

    fun setLastModified(newTime_t: Long): Pair<Boolean, Throwable?> {
        return try {
            DOM.requestFile(path)!!.let {
                it.modificationDate = newTime_t
                DOM.touchFile(it)
            }
            true to null
        }
        catch (e: KotlinNullPointerException) {
            false to e
        }
    }


}