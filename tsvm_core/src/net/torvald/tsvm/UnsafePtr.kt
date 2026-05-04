package net.torvald

import sun.misc.Unsafe
import java.io.PrintStream

class DanglingPointerException(msg: String) : NullPointerException(msg)
class AddressOverflowException(msg: String) : IndexOutOfBoundsException(msg)

/**
 * Further read:
 * - http://www.docjar.com/docs/api/sun/misc/Unsafe.html
 *
 * Created by minjaesong on 2019-06-21.
 */
internal object UnsafeHelper {
    val unsafe: Unsafe

    init {
        val unsafeConstructor = Unsafe::class.java.getDeclaredConstructor()
        unsafeConstructor.isAccessible = true
        unsafe = unsafeConstructor.newInstance()
    }

    /**
     * A factory method to allocate a memory of given size and return its starting address as a pointer.
     */
    fun allocate(size: Long, caller: Any): UnsafePtr {
        val ptr = unsafe.allocateMemory(size)
        return UnsafePtr(ptr, size, caller)
    }

    fun memcpy(src: UnsafePtr, fromIndex: Long, dest: UnsafePtr, toIndex: Long, copyLength: Long) {
        if (src.destroyed || dest.destroyed) return
        unsafe.copyMemory(src.ptr + fromIndex, dest.ptr + toIndex, copyLength)
    }
    fun memcpy(srcAddress: Long, destAddress: Long, copyLength: Long) =
        unsafe.copyMemory(srcAddress, destAddress, copyLength)
    fun memcpyRaw(srcObj: Any?, srcPos: Long, destObj: Any?, destPos: Long, len: Long) =
        unsafe.copyMemory(srcObj, srcPos, destObj, destPos, len)

    /**
     * The array object in JVM is stored in this memory map:
     *
     * 0                 w                  2w                    *
     * | Some identifier | Other identifier | the actual data ... |
     *
     * (where w = 4 for 32-bit JVM and 8 for 64-bit JVM. If Compressed-OOP is involved, things may get complicated)
     *
     * @return offset from the array's base memory address (aka pointer) that the actual data begins.
     */
    fun getArrayOffset(obj: Any) = unsafe.arrayBaseOffset(obj.javaClass).toLong()
}

/**
 * To allocate a memory, use UnsafeHelper.allocate(long)
 *
 * All the getFloat/Int/whatever methods will follow the endianness of your system,
 * e.g. it'll be Little Endian on x86, Big Endian on PPC, User-defined on ARM; therefore these functions should not be
 * used when the portability matters (e.g. Savefile). In such situations, do byte-wise operations will be needed.
 *
 * Use of hashCode() is forbidden, use the pointer instead.
 */
internal class UnsafePtr(pointer: Long, allocSize: Long, private val caller: Any) {
    var destroyed = false
        private set

    var ptr: Long = pointer
        private set

    var size: Long = allocSize
        private set

    fun realloc(newSize: Long) {
        ptr = UnsafeHelper.unsafe.reallocateMemory(ptr, newSize)
        size = newSize
    }

    fun destroy() {
        if (!destroyed) {
//            println("[UnsafePtr] Destroying pointer $this; called from:")
//            printStackTrace(this)

            UnsafeHelper.unsafe.freeMemory(ptr)

            destroyed = true
        }
    }

    /**
     * Returns true when the operation should proceed; false when the pointer is destroyed
     * (so the caller short-circuits to a safe no-op / zero return).
     *
     * Why no exception: a JS worker thread that survives killVMenv (because it wasn't
     * tracked in vm.contexts, e.g. raw java.lang.Thread spawned by JS code) will keep
     * poking peripheral memory for one or more iterations after dispose(). Letting it
     * actually call unsafe.putByte on freed memory corrupts the malloc heap and crashes
     * the JVM with `free_list_checksum_botch`. Returning quietly turns the race into a
     * harmless no-op until the thread drains.
     */
    private inline fun aliveAt(index: Long): Boolean {
        if (destroyed) return false
        if (index < 0 || index >= size) return false
        return true
    }

    operator fun get(index: Long): Byte {
        if (!aliveAt(index)) return 0
        return UnsafeHelper.unsafe.getByte(ptr + index)
    }

    operator fun set(index: Long, value: Byte) {
        if (!aliveAt(index)) return
        UnsafeHelper.unsafe.putByte(ptr + index, value)
    }


    fun getFloatFree(index: Long): Float {
        if (!aliveAt(index + 3)) return 0f
        return UnsafeHelper.unsafe.getFloat(ptr + index)
    }
    fun getFloat(unit: Long): Float {
        val idx = unit * 4L
        if (!aliveAt(idx + 3)) return 0f
        return UnsafeHelper.unsafe.getFloat(ptr + idx)
    }

    fun getIntFree(index: Long): Int {
        if (!aliveAt(index + 3)) return 0
        return UnsafeHelper.unsafe.getInt(ptr + index)
    }
    fun getInt(unit: Long): Int {
        val idx = unit * 4L
        if (!aliveAt(idx + 3)) return 0
        return UnsafeHelper.unsafe.getInt(ptr + idx)
    }

    fun getShortFree(index: Long): Short {
        if (!aliveAt(index + 1)) return 0
        return UnsafeHelper.unsafe.getShort(ptr + index)
    }
    fun getShort(unit: Long): Short {
        val idx = unit * 2L
        if (!aliveAt(idx + 1)) return 0
        return UnsafeHelper.unsafe.getShort(ptr + idx)
    }

    fun setFloatFree(index: Long, value: Float) {
        if (!aliveAt(index + 3)) return
        UnsafeHelper.unsafe.putFloat(ptr + index, value)
    }
    fun setFloat(unit: Long, value: Float) {
        val idx = unit * 4L
        if (!aliveAt(idx + 3)) return
        UnsafeHelper.unsafe.putFloat(ptr + idx, value)
    }

    fun setIntFree(index: Long, value: Int) {
        if (!aliveAt(index + 3)) return
        UnsafeHelper.unsafe.putInt(ptr + index, value)
    }
    fun setInt(unit: Long, value: Int) {
        val idx = unit * 4L
        if (!aliveAt(idx + 3)) return
        UnsafeHelper.unsafe.putInt(ptr + idx, value)
    }

    fun setShortFree(index: Long, value: Short) {
        if (!aliveAt(index + 1)) return
        UnsafeHelper.unsafe.putShort(ptr + index, value)
    }
    fun setShortUnit(unit: Long, value: Short) {
        val idx = unit * 2L
        if (!aliveAt(idx + 1)) return
        UnsafeHelper.unsafe.putShort(ptr + idx, value)
    }

    fun fillWith(byte: Byte) {
        if (destroyed) return
        UnsafeHelper.unsafe.setMemory(ptr, size, byte)
    }

    override fun toString() = "0x${ptr.toString(16)} with size $size, created by $caller"
    override fun equals(other: Any?) = this.ptr == (other as UnsafePtr).ptr && this.size == other.size

    inline fun printStackTrace(obj: Any) = printStackTrace(obj, System.out) // because of Java

    fun printStackTrace(obj: Any, out: PrintStream = System.out) {
            Thread.currentThread().stackTrace.forEach {
                out.println("[${obj.javaClass.simpleName}] ... $it")
            }
    }
}