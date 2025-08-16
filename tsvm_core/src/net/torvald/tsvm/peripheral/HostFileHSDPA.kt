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
    constructor(vm: VM, hostFilePaths: Array<String>, baudRate: java.lang.Long) : super(vm, baudRate.toLong()) {
        initializeHostFiles(hostFilePaths.toList())
    }
    
    // Secondary constructor for Kotlin usage
    constructor(vm: VM, hostFilePaths: List<String> = emptyList(), baudRate: Long = 133_333_333L) : super(vm, baudRate) {
        initializeHostFiles(hostFilePaths)
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
    
    override fun sequentialIORead(bytes: Int, vmMemoryPointer: Int) {
        println("HostFileHSDPA: sequentialIORead($bytes, $vmMemoryPointer)")
        val activeDiskIndex = getActiveDiskIndex()
        println("HostFileHSDPA: activeDiskIndex = $activeDiskIndex")
        if (activeDiskIndex < 0 || hostFiles[activeDiskIndex] == null) {
            // No file attached, just advance position
            println("HostFileHSDPA: No file attached, advancing position")
            sequentialIOPosition += bytes
            return
        }
        
        try {
            val file = hostFiles[activeDiskIndex]!!
            println("HostFileHSDPA: Seeking to position $sequentialIOPosition")
            file.seek(sequentialIOPosition)
            
            // Read data into a temporary buffer
            val readBuffer = ByteArray(bytes)
            val bytesRead = file.read(readBuffer)
            println("HostFileHSDPA: Read $bytesRead bytes from file")
            
            if (bytesRead > 0) {
                // Log first few bytes for debugging
                val firstBytes = readBuffer.take(8).map { (it.toInt() and 0xFF).toString(16).padStart(2, '0') }.joinToString(" ")
                println("HostFileHSDPA: First bytes: $firstBytes")
                
                // Copy data to VM memory
                for (i in 0 until bytesRead) {
                    vm.poke(vmMemoryPointer + i.toLong(), readBuffer[i])
                }
                sequentialIOPosition += bytesRead
                println("HostFileHSDPA: Copied $bytesRead bytes to VM memory at $vmMemoryPointer")
            }
            
            // Fill remaining bytes with zeros if we read less than requested
            if (bytesRead < bytes) {
                for (i in bytesRead until bytes) {
                    vm.poke(vmMemoryPointer + i.toLong(), 0)
                }
                sequentialIOPosition += (bytes - bytesRead)
            }
            
        } catch (e: Exception) {
            println("HSDPA: Error reading from file: ${e.message}")
            // Just advance position on error
            sequentialIOPosition += bytes
        }
    }
    
    override fun sequentialIOWrite(bytes: Int, vmMemoryPointer: Int) {
        val activeDiskIndex = getActiveDiskIndex()
        if (activeDiskIndex < 0 || hostFiles[activeDiskIndex] == null) {
            // No file attached, just advance position
            sequentialIOPosition += bytes
            return
        }
        
        // For now, we only support read-only access to host files
        // In a full implementation, we would write to the file here
        println("HSDPA: Write operation not supported in read-only mode")
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