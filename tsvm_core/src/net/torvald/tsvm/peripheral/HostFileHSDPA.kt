package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM
import java.io.File
import java.io.RandomAccessFile

/**
 * Host File High Speed Disk Peripheral Adapter (HostFileHSDPA)
 * 
 * A testing version of HSDPA that uses actual files on the host computer as disk sources.
 * Each disk corresponds to a single file on the host filesystem.
 * 
 * Created by Claude on 2025-08-16.
 */
class HostFileHSDPA : HSDPA {
    
    // Primary constructor for Java reflection compatibility
    constructor(vm: VM,
                hostFilePath0: String,
                hostFilePath1: String,
                hostFilePath2: String,
                hostFilePath3: String,
                baudRate: java.lang.Long) : super(vm, baudRate.toLong()) {
        initializeHostFiles(listOf(hostFilePath0, hostFilePath1, hostFilePath2, hostFilePath3))
    }

    // Host files for each disk slot
    private val hostFiles = Array<RandomAccessFile?>(MAX_DISKS) { null }
    private val hostFilePaths = Array<String?>(MAX_DISKS) { null }

    private fun initializeHostFiles(hostFilePathsList: List<String>) {
        if (hostFilePathsList.isNotEmpty()) {
            for (i in 0 until minOf(hostFilePathsList.size, MAX_DISKS)) {
                val file = File(hostFilePathsList[i])
                if (file.exists() && file.isFile) {
                    this.hostFiles[i] = RandomAccessFile(file, "r")
                    this.hostFilePaths[i] = hostFilePathsList[i]
                    println("HostFileHSDPA: Attached file '${hostFilePathsList[i]}' to disk $i")
                } else {
                    println("HostFileHSDPA: Warning - file '${hostFilePathsList[i]}' does not exist or is not a file")
                }
            }
        }
    }

    /**
     * Attaches a host file to a disk slot
     * @param diskIndex Disk slot index (0-3)
     * @param filePath Path to the host file
     */
    fun attachHostFile(diskIndex: Int, filePath: String) {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return
        
        try {
            // Close existing file if any
            hostFiles[diskIndex]?.close()
            
            // Open new file
            val file = File(filePath)
            if (file.exists() && file.isFile) {
                hostFiles[diskIndex] = RandomAccessFile(file, "r")
                hostFilePaths[diskIndex] = filePath
                println("HSDPA: Attached file '$filePath' to disk $diskIndex")
            } else {
                println("HSDPA: Warning - file '$filePath' does not exist or is not a file")
            }
        } catch (e: Exception) {
            println("HSDPA: Error attaching file '$filePath' to disk $diskIndex: ${e.message}")
        }
    }
    
    /**
     * Detaches a host file from a disk slot
     * @param diskIndex Disk slot index (0-3)
     */
    fun detachHostFile(diskIndex: Int) {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return
        
        try {
            hostFiles[diskIndex]?.close()
            hostFiles[diskIndex] = null
            hostFilePaths[diskIndex] = null
            println("HSDPA: Detached file from disk $diskIndex")
        } catch (e: Exception) {
            println("HSDPA: Error detaching file from disk $diskIndex: ${e.message}")
        }
    }
    
    /**
     * Gets the size of the file attached to a disk slot
     * @param diskIndex Disk slot index (0-3)
     * @return File size in bytes, or 0 if no file attached
     */
    fun getAttachedFileSize(diskIndex: Int): Long {
        if (diskIndex < 0 || diskIndex >= MAX_DISKS) return 0L
        
        return try {
            hostFiles[diskIndex]?.length() ?: 0L
        } catch (e: Exception) {
            0L
        }
    }
    
    override fun sequentialIOSkip(bytes: Int) {
        sequentialIOPosition += bytes
        // Clamp position to file bounds if needed
        val activeDiskIndex = getActiveDiskIndex()
        if (activeDiskIndex >= 0) {
            val fileSize = getAttachedFileSize(activeDiskIndex)
            if (sequentialIOPosition > fileSize) {
                sequentialIOPosition = fileSize
            }
        }
    }
    
    override fun sequentialIORead(bytes: Int, vmMemoryPointer0: Int) {
        val activeDiskIndex = getActiveDiskIndex()
        if (activeDiskIndex < 0 || hostFiles[activeDiskIndex] == null) {
            // No file attached, just advance position
            sequentialIOPosition += bytes
            return
        }

        // convert Uint24 to Int32
        val vmMemoryPointer = if (vmMemoryPointer0 and 0x800000 != 0)
            (0xFF000000.toInt() or vmMemoryPointer0)
        else
            vmMemoryPointer0

        try {
            val file = hostFiles[activeDiskIndex]!!
            val readPosition = sequentialIOPosition
            file.seek(sequentialIOPosition)
            
            // Read data into a temporary buffer
            val readBuffer = ByteArray(bytes)
            val bytesRead = file.read(readBuffer)
            
            if (bytesRead > 0) {
                // Copy data to VM memory
                // Handle negative addresses (backwards addressing) vs positive addresses
                if (vmMemoryPointer < 0) {
                    // Negative addresses use backwards addressing  
                    for (i in 0 until bytesRead) {
                        vm.poke(vmMemoryPointer - i.toLong(), readBuffer[i])
                    }
                } else {
                    // Positive addresses use forward addressing
                    for (i in 0 until bytesRead) {
                        vm.poke(vmMemoryPointer + i.toLong(), readBuffer[i])
                    }
                }
                sequentialIOPosition += bytesRead
                
            }
            
            // Fill remaining bytes with zeros if we read less than requested
            if (bytesRead < bytes) {
                if (vmMemoryPointer < 0) {
                    // Negative addresses use backwards addressing
                    for (i in bytesRead until bytes) {
                        vm.poke(vmMemoryPointer - i.toLong(), 0)
                    }
                } else {
                    // Positive addresses use forward addressing
                    for (i in bytesRead until bytes) {
                        vm.poke(vmMemoryPointer + i.toLong(), 0)
                    }
                }
                sequentialIOPosition += (bytes - bytesRead)
            }
            
        } catch (e: Exception) {
            // Just advance position on error
            sequentialIOPosition += bytes
        }
    }
    
    override fun sequentialIOWrite(bytes: Int, vmMemoryPointer0: Int) {
        val activeDiskIndex = getActiveDiskIndex()
        if (activeDiskIndex < 0 || hostFiles[activeDiskIndex] == null) {
            // No file attached, just advance position
            sequentialIOPosition += bytes
            return
        }

        // convert Uint24 to Int32
        val vmMemoryPointer = if (vmMemoryPointer0 and 0x800000 != 0)
            (0xFF000000.toInt() or vmMemoryPointer0)
        else
            vmMemoryPointer0

        // For now, we only support read-only access to host files
        // In a full implementation, we would write to the file here
        sequentialIOPosition += bytes
    }
    
    /**
     * Gets the currently active disk index
     * @return Active disk index (0-3), or -1 if no disk is active
     */
    private fun getActiveDiskIndex(): Int {
        // Read the active disk register
        val activeReg = mmio_read(REG_ACTIVE_DISK.toLong())?.toInt() ?: 0
        return if (activeReg > 0) activeReg - 1 else -1
    }
    
    override fun dispose() {
        super.dispose()
        
        // Close all open files
        for (i in 0 until MAX_DISKS) {
            try {
                hostFiles[i]?.close()
            } catch (e: Exception) {
                // Ignore errors during cleanup
            }
        }
    }
    
    /**
     * Gets information about attached files
     * @return Array of file info strings
     */
    fun getAttachedFilesInfo(): Array<String> {
        return Array(MAX_DISKS) { i ->
            val path = hostFilePaths[i]
            if (path != null) {
                val size = getAttachedFileSize(i)
                "Disk $i: $path (${size} bytes)"
            } else {
                "Disk $i: No file attached"
            }
        }
    }
}