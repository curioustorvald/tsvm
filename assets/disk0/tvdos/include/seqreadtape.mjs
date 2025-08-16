// Sequential reader for HSDPA TAPE devices
// Unlike seqread.mjs which is limited to 4096 bytes per read due to serial communication,
// this module can read larger chunks efficiently from HSDPA devices.

let readCount = 0
let currentTapeDevice = undefined
let fileDescriptor = undefined
let fileHeader = new Uint8Array(65536) // Much larger header buffer than serial version

// HSDPA peripheral addresses for slot 4
// MMIO area (for registers): -524289 to -655360 (backwards!)
const HSDPA_SLOT4_MMIO_START = -524289  // MMIO area start
const HSDPA_REG_ACTIVE_DISK = HSDPA_SLOT4_MMIO_START - 20
const HSDPA_REG_SEQ_IO_CONTROL = HSDPA_SLOT4_MMIO_START - 256
const HSDPA_REG_SEQ_IO_OPCODE = HSDPA_SLOT4_MMIO_START - 258
const HSDPA_REG_SEQ_IO_ARG1 = HSDPA_SLOT4_MMIO_START - 259
const HSDPA_REG_SEQ_IO_ARG2 = HSDPA_SLOT4_MMIO_START - 262

// Sequential I/O opcodes
const HSDPA_OPCODE_NOP = 0x00
const HSDPA_OPCODE_SKIP = 0x01
const HSDPA_OPCODE_READ = 0x02
const HSDPA_OPCODE_WRITE = 0x03
const HSDPA_OPCODE_REWIND = 0xF0
const HSDPA_OPCODE_TERMINATE = 0xFF

// Helper functions for HSDPA MMIO access
function hsdpaSetActiveDisk(diskNumber) {
    sys.poke(HSDPA_REG_ACTIVE_DISK, diskNumber) // 1-based
}

function hsdpaEnableSequentialIO() {
    sys.poke(HSDPA_REG_SEQ_IO_CONTROL, 0x01)
}

function hsdpaDisableSequentialIO() {
    sys.poke(HSDPA_REG_SEQ_IO_CONTROL, 0x00)
}

function hsdpaRewind() {
    sys.poke(HSDPA_REG_SEQ_IO_OPCODE, HSDPA_OPCODE_REWIND)
}

function hsdpaSkip(bytes) {
    // Write arg1 (3 bytes, little endian) - using backwards addressing
    sys.poke(HSDPA_REG_SEQ_IO_ARG1, bytes & 0xFF)        // LSB
    sys.poke(HSDPA_REG_SEQ_IO_ARG1 - 1, (bytes >> 8) & 0xFF)   // MSB
    sys.poke(HSDPA_REG_SEQ_IO_ARG1 - 2, (bytes >> 16) & 0xFF)  // MSB2
    // Execute skip operation
    sys.poke(HSDPA_REG_SEQ_IO_OPCODE, HSDPA_OPCODE_SKIP)
}

function hsdpaReadToMemory(bytes, vmMemoryPointer) {
    // Write arg1 (bytes to read) - using backwards addressing
    sys.poke(HSDPA_REG_SEQ_IO_ARG1, bytes & 0xFF)        // LSB
    sys.poke(HSDPA_REG_SEQ_IO_ARG1 - 1, (bytes >> 8) & 0xFF)   // MSB
    sys.poke(HSDPA_REG_SEQ_IO_ARG1 - 2, (bytes >> 16) & 0xFF)  // MSB2
    // Write arg2 (VM memory pointer) - handle negative numbers correctly
    let ptr = vmMemoryPointer >>> 0  // Convert to unsigned 32-bit
    sys.poke(HSDPA_REG_SEQ_IO_ARG2, ptr & 0xFF)           // LSB
    sys.poke(HSDPA_REG_SEQ_IO_ARG2 - 1, (ptr >> 8) & 0xFF)  // MSB
    sys.poke(HSDPA_REG_SEQ_IO_ARG2 - 2, (ptr >> 16) & 0xFF) // MSB2
    // Execute read operation
    sys.poke(HSDPA_REG_SEQ_IO_OPCODE, HSDPA_OPCODE_READ)
}

function hsdpaTerminate() {
    sys.poke(HSDPA_REG_SEQ_IO_OPCODE, HSDPA_OPCODE_TERMINATE)
}

function prepare(fullPath) {
    // Parse tape device path like "$:/TAPE0/"
    if (!fullPath.startsWith("$:/TAPE") && !fullPath.startsWith("$:\\TAPE")) {
        throw Error("seqreadtape: Expected TAPE device path like $:\\TAPE0, got '" + fullPath + "'")
    }
    
    readCount = 0
    
    // Extract tape number from path (TAPE0 -> 0, TAPE1 -> 1, etc.)
    let tapeMatch = fullPath.match(/\$:[/\\]TAPE([0-9]+)/)
    if (!tapeMatch) {
        throw Error("seqreadtape: Invalid TAPE device path format: " + fullPath)
    }
    
    let tapeNumber = parseInt(tapeMatch[1])
    if (tapeNumber < 0 || tapeNumber > 3) {
        throw Error("seqreadtape: TAPE device number must be 0-3, got " + tapeNumber)
    }
    
    currentTapeDevice = tapeNumber
    
    try {
        // Open the tape device using TVDOS file system
        fileDescriptor = files.open(fullPath)
        if (!fileDescriptor.exists) {
            throw Error(`seqreadtape: TAPE device ${tapeNumber} not available or no file attached`)
        }
        
        // Initialize HSDPA for sequential reading
        hsdpaSetActiveDisk(tapeNumber + 1) // HSDPA uses 1-based disk numbers
        hsdpaEnableSequentialIO()
        hsdpaRewind()
        
        // Read file header (much larger than serial version)
        let headerPtr = sys.malloc(fileHeader.length)
        try {
            hsdpaReadToMemory(fileHeader.length, headerPtr)
            
            // Copy header to our buffer
            for (let i = 0; i < fileHeader.length; i++) {
                fileHeader[i] = sys.peek(headerPtr + i) & 0xFF
            }
        } finally {
            sys.free(headerPtr)
        }
        
        // Reset position for actual reading
        hsdpaRewind()
        readCount = 0
        
        return 0
        
    } catch (e) {
        throw Error("seqreadtape: Failed to prepare TAPE device: " + e.message)
    }
}

function readBytes(length, ptrToDecode) {
    if (length <= 0) return
    
    let ptr = (ptrToDecode === undefined) ? sys.malloc(length) : ptrToDecode
    
    try {
        // Read directly using HSDPA - position is maintained automatically by HSDPA
        hsdpaReadToMemory(length, ptr)
        
        readCount += length
        
        return ptr
        
    } catch (e) {
        if (ptrToDecode === undefined) {
            sys.free(ptr)
        }
        throw Error("seqreadtape: Failed to read bytes: " + e.message)
    }
}

function readInt() {
    let b = readBytes(4)
    let i = (sys.peek(b)) | (sys.peek(b+1) << 8) | (sys.peek(b+2) << 16) | (sys.peek(b+3) << 24)
    sys.free(b)
    return i
}

function readShort() {
    let b = readBytes(2)
    let byte0 = sys.peek(b) & 0xFF
    let byte1 = sys.peek(b+1) & 0xFF
    let i = byte0 | (byte1 << 8)
    sys.free(b)
    return i
}

function readOneByte() {
    let b = readBytes(1)
    let i = sys.peek(b) & 0xFF
    sys.free(b)
    return i
}

function readFourCC() {
    let b = readBytes(4)
    let a = [sys.peek(b) & 0xFF, sys.peek(b+1) & 0xFF, sys.peek(b+2) & 0xFF, sys.peek(b+3) & 0xFF]
    sys.free(b)
    let s = String.fromCharCode.apply(null, a)
    if (s.length != 4) {
        throw Error(`seqreadtape: FourCC is not 4 characters long (${s}; ${a.map(it=>"0x"+it.toString(16).padStart(2,'0')).join()})`)
    }
    return s
}

function readString(length) {
    let b = readBytes(length)
    let s = ""
    for (let k = 0; k < length; k++) {
        s += String.fromCharCode(sys.peek(b + k) & 0xFF)
    }
    sys.free(b)
    return s
}

function skip(n) {
    if (n <= 0) return
    
    // For HSDPA, we can skip efficiently without reading
    hsdpaSkip(n)
    readCount += n
}

function getReadCount() {
    return readCount
}

function close() {
    if (fileDescriptor) {
        try {
            hsdpaTerminate()
            hsdpaDisableSequentialIO()
            fileDescriptor.close()
        } catch (e) {
            // Ignore close errors
        }
        fileDescriptor = undefined
        currentTapeDevice = undefined
        readCount = 0
    }
}

function getCurrentTapeDevice() {
    return currentTapeDevice
}

function isReady() {
    return fileDescriptor !== undefined && currentTapeDevice !== undefined
}

function seek(position) {
    // Seek to absolute position
    hsdpaRewind()
    if (position > 0) {
        hsdpaSkip(position)
    }
    readCount = position
}

function rewind() { seek(0) }

exports = {
    fileHeader, 
    prepare, 
    readBytes, 
    readInt, 
    readShort, 
    readFourCC, 
    readOneByte, 
    readString, 
    skip, 
    getReadCount,
    close,
    getCurrentTapeDevice,
    isReady,
    // Enhanced functions
    seek
}