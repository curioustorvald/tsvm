package net.torvald.tsvm.peripheral

import net.torvald.terrarum.modulecomputers.virtualcomputer.tvd.toUint
import net.torvald.tsvm.VM


/**
 * High Speed Disk Peripheral Adapter (HSDPA)
 *
 * Created by minjaesong on 2025-05-06.
 */
open class HSDPA(val vm: VM, val baudRate: Long = 133_333_333L): PeriBase("hsdpa") {

    companion object {
        const val BUFFER_SIZE = 1048576 // 1MB buffer size
        const val MAX_DISKS = 4

        // MMIO register offsets (relative to peripheral base)
        const val REG_DISK1_STATUS = 0
        const val REG_DISK2_STATUS = 3
        const val REG_DISK3_STATUS = 6
        const val REG_DISK4_STATUS = 9
        const val REG_DISK_CONTROL = 12
        const val REG_DISK_STATUS_CODE = 16
        const val REG_ACTIVE_DISK = 20

        // Sequential I/O registers
        const val REG_SEQ_IO_CONTROL = 256
        const val REG_SEQ_IO_OPCODE = 258
        const val REG_SEQ_IO_ARG1 = 259
        const val REG_SEQ_IO_ARG2 = 262
        const val REG_SEQ_IO_ARG3 = 265
        const val REG_SEQ_IO_ARG4 = 268

        // Sequential I/O opcodes
        const val OPCODE_NOP = 0x00
        const val OPCODE_SKIP = 0x01
        const val OPCODE_READ = 0x02
        const val OPCODE_WRITE = 0x03
        const val OPCODE_REWIND = 0xF0
        const val OPCODE_TERMINATE = 0xFF
    }

    override val typestring = "hsdpa"

    override fun getVM() = vm

    // Buffer for block transfer
    private val buffer = ByteArray(BUFFER_SIZE)

    // Disk interfaces
    private val diskInterfaces = Array(MAX_DISKS) { DiskInterface(baudRate.toInt()) }

    // Currently active disk (0-based index, -1 means no disk selected)
    private var activeDisk = -1
    
    // Sequential I/O state
    protected var sequentialIOActive = false
    protected var sequentialIOPosition = 0L

    override fun peek(addr: Long): Byte? {
        // Memory Space area - for buffer access
        return if (addr in 0L until BUFFER_SIZE) {
            buffer[addr.toInt()]
        } else {
            null
        }
    }

    override fun poke(addr: Long, byte: Byte) {
        // Memory Space area - for buffer access
        if (addr in 0L until BUFFER_SIZE) {
            buffer[addr.toInt()] = byte
        }
    }

    override fun dispose() {
    }

    private var opcodeBuf = 0
    private var arg1 = 0
    private var arg2 = 0

    /**
     * Reads a value from the MMIO register
     * @param address Register address
     * @return Value at the register
     */
    override fun mmio_read(addr: Long): Byte? {
        val address = addr.toInt()
        return when (address) {
            in REG_DISK1_STATUS..REG_DISK4_STATUS+2 -> {
                val diskIndex = (address - REG_DISK1_STATUS) / 3
                val offset = (address - REG_DISK1_STATUS) % 3
                getDiskStatusRegister(diskIndex, offset)
            }
            in REG_DISK_CONTROL..REG_DISK_CONTROL+3 -> {
                val diskIndex = address - REG_DISK_CONTROL
                getDiskControlRegister(diskIndex)
            }
            in REG_DISK_STATUS_CODE..REG_DISK_STATUS_CODE+3 -> {
                val diskIndex = address - REG_DISK_STATUS_CODE
                getDiskStatusCodeRegister(diskIndex)
            }
            REG_ACTIVE_DISK -> {
                (activeDisk + 1).toByte() // 1-based in register
            }
            REG_SEQ_IO_CONTROL -> {
                // Return sequential I/O control flags
                var flags = 0
                if (sequentialIOActive) flags = flags or 0x01
                flags.toByte()
            }
            REG_SEQ_IO_CONTROL + 1 -> {
                // Second byte of control flags (currently unused)
                0
            }
            REG_SEQ_IO_OPCODE -> {
                opcodeBuf.toByte()
            }
            in REG_SEQ_IO_ARG1..REG_SEQ_IO_ARG1+2 -> {
                (arg1 ushr ((address - REG_SEQ_IO_ARG1) * 8)).toByte()
            }
            in REG_SEQ_IO_ARG2..REG_SEQ_IO_ARG2+2 -> {
                (arg2 ushr ((address - REG_SEQ_IO_ARG2) * 8)).toByte()
            }
            else -> null
        }
    }

    /**
     * Writes a value to the MMIO register
     * @param address Register address
     * @param value Value to write
     */
    override fun mmio_write(addr: Long, value: Byte) {
        val address = addr.toInt()
        println("HSDPA: mmio_write(addr=$addr, value=0x${(value.toInt() and 0xFF).toString(16)})")
        when (address) {
            in REG_DISK1_STATUS..REG_DISK4_STATUS+2 -> {
                val diskIndex = (address - REG_DISK1_STATUS) / 3
                val offset = (address - REG_DISK1_STATUS) % 3
                setDiskStatusRegister(diskIndex, offset, value)
            }
            in REG_DISK_CONTROL..REG_DISK_CONTROL+3 -> {
                val diskIndex = address - REG_DISK_CONTROL
                setDiskControlRegister(diskIndex, value)
            }
            in REG_DISK_STATUS_CODE..REG_DISK_STATUS_CODE+3 -> {
                val diskIndex = address - REG_DISK_STATUS_CODE
                setDiskStatusCodeRegister(diskIndex, value)
            }
            REG_ACTIVE_DISK -> {
                setActiveDisk(value.toInt() - 1) // 1-based in register
            }
            REG_SEQ_IO_CONTROL -> {
                // Set sequential I/O control flags
                sequentialIOActive = (value.toInt() and 0x01) != 0
            }
            REG_SEQ_IO_CONTROL + 1 -> {
                // Second byte of control flags (currently unused)
            }
            REG_SEQ_IO_OPCODE -> {
                opcodeBuf = value.toUint()
                println("HSDPA: Writing opcode 0x${value.toUint().toString(16)} to register")
                handleSequentialIOOpcode(value.toUint())
            }
            in REG_SEQ_IO_ARG1..REG_SEQ_IO_ARG1+2 -> {
                val byteOffset = (address - REG_SEQ_IO_ARG1)
                if (byteOffset == 0) {
                    // Reset arg1 when writing to LSB
                    arg1 = value.toUint()
                } else {
                    arg1 = arg1 or (value.toUint() shl (byteOffset * 8))
                }
            }
            in REG_SEQ_IO_ARG2..REG_SEQ_IO_ARG2+2 -> {
                val byteOffset = (address - REG_SEQ_IO_ARG2)
                if (byteOffset == 0) {
                    // Reset arg2 when writing to LSB
                    arg2 = value.toUint()
                } else {
                    arg2 = arg2 or (value.toUint() shl (byteOffset * 8))
                }
            }
            else -> null
        }
    }

    /**
     * Gets the disk status register value
     * @param diskIndex Disk index (0-3)
     * @param offset Offset within the 3-byte status register (0-2)
     * @return Register value
     */
    private fun getDiskStatusRegister(diskIndex: Int, offset: Int): Byte {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return 0

        val disk = diskInterfaces[diskIndex]

        return when (offset) {
            0 -> (disk.yourBlockSize() and 0xFF).toByte()
            1 -> ((disk.yourBlockSize() shr 8) and 0xFF).toByte()
            2 -> {
                var value = 0
                if (disk.doYouHaveNext()) value = value or 0x10
                if (disk.yourBlockSize() == 0) value = value or 0x04
                value = value or ((disk.yourBlockSize() shr 16) and 0x0F)
                value.toByte()
            }
            else -> 0
        }
    }

    /**
     * Sets the disk status register value
     * @param diskIndex Disk index (0-3)
     * @param offset Offset within the 3-byte status register (0-2)
     * @param value Value to set
     */
    private fun setDiskStatusRegister(diskIndex: Int, offset: Int, value: Byte) {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return

        val disk = diskInterfaces[diskIndex]

        when (offset) {
            0 -> {
                // Update LSB of block size
                val currentSize = disk.blockSize.get()
                val newSize = (currentSize and 0xFFFF00) or (value.toInt() and 0xFF)
                disk.blockSize.set(newSize)
            }
            1 -> {
                // Update middle byte of block size
                val currentSize = disk.blockSize.get()
                val newSize = (currentSize and 0xFF00FF) or ((value.toInt() and 0xFF) shl 8)
                disk.blockSize.set(newSize)
            }
            2 -> {
                // Update MSB and flags
                val currentSize = disk.blockSize.get()
                val hasNext = (value.toInt() and 0x10) != 0
                val isZero = (value.toInt() and 0x04) != 0
                val msb = value.toInt() and 0x0F

                val newSize = if (isZero) {
                    0
                } else {
                    (currentSize and 0x00FFFF) or (msb shl 16)
                }

                disk.blockSize.set(newSize)
                // Set hasNext flag
                disk.setHasNext(hasNext)
            }
        }
    }

    /**
     * Gets the disk control register value
     * @param diskIndex Disk index (0-3)
     * @return Register value
     */
    private fun getDiskControlRegister(diskIndex: Int): Byte {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return 0

        val disk = diskInterfaces[diskIndex]

        var value = 0
        if (disk.getMode()) value = value or 0x08 // Send mode
        if (disk.busy.get()) value = value or 0x04 // Busy
        if (disk.ready.get()) value = value or 0x02 // Ready
        if (disk.cableConnected()) value = value or 0x01 // Connected

        return value.toByte()
    }

    /**
     * Sets the disk control register value
     * @param diskIndex Disk index (0-3)
     * @param value Value to set
     */
    private fun setDiskControlRegister(diskIndex: Int, value: Byte) {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return

        val disk = diskInterfaces[diskIndex]

        val sendMode = (value.toInt() and 0x08) != 0
        val startTransfer = (value.toInt() and 0x04) != 0
        val readyToReceive = (value.toInt() and 0x02) != 0

        // Set mode (send/receive)
        disk.setMode(sendMode)

        // Set ready flag
        disk.ready.set(readyToReceive)

        // Start transfer if requested
        if (startTransfer) {
            if (sendMode) {
                // Start sending
                disk.startSend()
            } else {
                // Start reading
                disk.startRead()
            }
        }
    }

    /**
     * Gets the disk status code register value
     * @param diskIndex Disk index (0-3)
     * @return Register value
     */
    private fun getDiskStatusCodeRegister(diskIndex: Int): Byte {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return 0

        val disk = diskInterfaces[diskIndex]
        return disk.getYourStatusCode().toByte()
    }

    /**
     * Sets the disk status code register value
     * @param diskIndex Disk index (0-3)
     * @param value Value to set
     */
    private fun setDiskStatusCodeRegister(diskIndex: Int, value: Byte) {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return

        val disk = diskInterfaces[diskIndex]
        disk.statusCode.set(value.toInt())
    }

    /**
     * Sets the active disk
     * @param diskIndex Disk index (0-3), or -1 to deselect all
     */
    private fun setActiveDisk(diskIndex: Int) {
        if (diskIndex < -1 || diskIndex >= MAX_DISKS) return

        // Deselect all disks first
        for (i in 0 until MAX_DISKS) {
            if (i != diskIndex) {
                diskInterfaces[i].ready.set(false)
            }
        }

        activeDisk = diskIndex
    }

    /**
     * Handles sequential I/O opcodes
     * @param opcode Opcode to handle
     */
    protected open fun handleSequentialIOOpcode(opcode: Int) {
        println("HSDPA: handleSequentialIOOpcode(0x${opcode.toString(16)})")
        when (opcode) {
            OPCODE_NOP -> {
                // No operation
                println("HSDPA: NOP")
            }
            OPCODE_SKIP -> {
                // Skip arg1 bytes in the active disk
                println("HSDPA: SKIP $arg1 bytes, activeDisk=$activeDisk")
                if (activeDisk in 0 until MAX_DISKS) {
                    sequentialIOSkip(arg1)
                }
            }
            OPCODE_READ -> {
                // Read arg1 bytes and store to core memory at pointer arg2
                println("HSDPA: READ $arg1 bytes to pointer $arg2, activeDisk=$activeDisk")
                println("HSDPA: arg1 = 0x${arg1.toString(16)}, arg2 = 0x${arg2.toString(16)}")
                if (activeDisk in 0 until MAX_DISKS) {
                    sequentialIORead(arg1, arg2)
                }
            }
            OPCODE_WRITE -> {
                // Write arg1 bytes from core memory at pointer arg2
                if (activeDisk in 0 until MAX_DISKS) {
                    sequentialIOWrite(arg1, arg2)
                }
            }
            OPCODE_REWIND -> {
                // Rewind to starting point
                println("HSDPA: REWIND to position 0")
                sequentialIOPosition = 0L
            }
            OPCODE_TERMINATE -> {
                // Terminate sequential I/O session
                sequentialIOActive = false
                sequentialIOPosition = 0L
                // Clear the buffer
                buffer.fill(0)
            }
        }
    }
    
    /**
     * Skip bytes in sequential I/O mode
     */
    protected open fun sequentialIOSkip(bytes: Int) {
        sequentialIOPosition += bytes
    }
    
    /**
     * Read bytes from disk to VM memory in sequential I/O mode
     */
    protected open fun sequentialIORead(bytes: Int, vmMemoryPointer: Int) {
        // Default implementation - subclasses should override
        // For now, just advance the position
        sequentialIOPosition += bytes
    }
    
    /**
     * Write bytes from VM memory to disk in sequential I/O mode
     */
    protected open fun sequentialIOWrite(bytes: Int, vmMemoryPointer: Int) {
        // Default implementation - subclasses should override
        // For now, just advance the position
        sequentialIOPosition += bytes
    }

    /**
     * Attaches a disk to a specific port
     * @param diskIndex Port index (0-3)
     * @param disk Disk to attach
     */
    fun attachDisk(diskIndex: Int, disk: BlockTransferInterface?) {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return

        diskInterfaces[diskIndex].attachDevice(disk)
    }

    /**
     * Disk interface implementation for HSDPA
     */
    inner class DiskInterface(baudRate: Int) : BlockTransferInterface(true, true, baudRate) {
        private var hasNextFlag = false

        override fun startSendImpl(recipient: BlockTransferInterface): Int {
            // Copy data from buffer to recipient
            val dataToSend = buffer.copyOf(blockSize.get())
            recipient.writeout(dataToSend)
            return dataToSend.size
        }

        override fun writeoutImpl(inputData: ByteArray) {
            // Copy received data to buffer
            val bytesToCopy = minOf(inputData.size, buffer.size)
            inputData.copyInto(buffer, 0, 0, bytesToCopy)
        }

        override fun hasNext(): Boolean {
            return hasNextFlag
        }

        fun setHasNext(hasNext: Boolean) {
            this.hasNextFlag = hasNext
        }
    }
}
