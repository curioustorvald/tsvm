/**
 * LibSeqread — sequentially read files from disk drive
 * @author CuriousTorvald
 */
let readCount = 0
let port = undefined
let fileHeader = new Uint8Array(4096)
// Valid byte count of the block currently sitting in the read buffer. The disk's last block is
// usually shorter than 4096; without tracking this the reuse path read 4096-padding bytes of stale
// buffer past EOF (white-noise burst / the old OOB crash).
let curBlockLen = 0

function prepare(fullPath) {
    if (fullPath[2] != '/' && fullPath[2] != '\\') throw Error("Expected full path with drive letter, got " + fullPath)


    readCount = 0
    curBlockLen = 0

    let driveLetter = fullPath[0].toUpperCase()
    let diskPath = fullPath.substring(2).replaceAll("\\",'/')

    // remove '/' at the head of the diskPath
    while (diskPath[0] == '/') {
        diskPath = diskPath.substring(1)
    }

    port = _TVDOS.DRV.FS.SERIAL._toPorts(driveLetter)[0]

    com.sendMessage(port, "DEVRST\x17")
    com.sendMessage(port, `OPENR"${diskPath}",1`)
    let statusCode = com.getStatusCode(port)

    if (statusCode != 0) {
        throw Error(`No such file (${statusCode}; ${driveLetter}:\\${diskPath})`)
        return statusCode
    }

    com.sendMessage(port, "READ")
    statusCode = com.getStatusCode(port)
    if (statusCode != 0) {
        throw Error("READ failed with "+statusCode)
        return statusCode
    }

    sys.poke(-4093 - port, 6);/*sys.sleep(0)*/

    for (let i = 0; i < 4096; i++) {
        fileHeader[i] = sys.peek(-4097 - port*4096 - i)
    }

    return 0
}

function readBytes(length, ptrToDecode) {
    if (length <= 0) return
//    serial.println(`readBytes(${length}); readCount = ${readCount}`)
    let ptr = (ptrToDecode === undefined) ? sys.malloc(length) : ptrToDecode
    let requiredBlocks = Math.floor((readCount + length) / 4096) - Math.floor(readCount / 4096)

    let destVector = (ptr >= 0) ? 1 : -1

    let completedReads = 0


    for (let bc = 0; bc < requiredBlocks + 1; bc++) {
        if (completedReads >= length) break

        if (readCount % 4096 == 0) {
//            serial.println("READ from serial")
            // pull the actual message
            if (readCount > 0) { sys.poke(-4093 - port, 6);/*sys.sleep(0)*/ } // spinning is required as Graal run is desynced with the Java side

            let blockTransferStatus = ((sys.peek(-4085 - port*2) & 255) | ((sys.peek(-4086 - port*2) & 255) << 8))
            let thisBlockLen = blockTransferStatus & 4095
            // bit 12 (0x1000) of the status = "the disk's block size is exactly 0" — the EOF marker.
            // Without it a 0-length terminating block is indistinguishable from a full 4096-byte
            // block (4096 & 4095 == 0 too), so the old code read 4096 bytes of stale buffer past EOF.
            let blockIsEmpty = (blockTransferStatus & 0x1000) != 0
            if (thisBlockLen == 0 && !blockIsEmpty) thisBlockLen = 4096 // [1, 4096]

            curBlockLen = thisBlockLen

//            serial.println(`block: (${thisBlockLen})[${[...Array(thisBlockLen).keys()].map(k => (sys.peek(-4097 - k) & 255).toString(16).padStart(2,'0')).join()}]`)

            if (thisBlockLen == 0) break // EOF: nothing more to read (zero-filled below)

            let remaining = Math.min(thisBlockLen, length - completedReads)

//            serial.println(`Pulled a block (${thisBlockLen}); readCount = ${readCount}, completedReads = ${completedReads}, remaining = ${remaining}`)

            // copy from read buffer to designated position
            sys.memcpy(-4097 - port*4096, ptr + completedReads*destVector, remaining)

            // increment readCount properly
            readCount += remaining
            completedReads += remaining
        }
        else {
            let padding = readCount % 4096
            // Only `curBlockLen - padding` bytes of the buffered block are real; the rest is stale.
            // A short final block leaves padding >= curBlockLen, i.e. we are past EOF.
            let avail = curBlockLen - padding
            if (avail <= 0) break // past the short last block: EOF (zero-filled below)
            let thisBlockLen = Math.min(avail, length - completedReads)

//            serial.println(`padding = ${padding}; avail = ${avail}`)
//            serial.println(`Reusing a block (${thisBlockLen}); readCount = ${readCount}, completedReads = ${completedReads}`)

            // copy from read buffer to designated position
            sys.memcpy(-4097 - port*4096 - padding, ptr + completedReads*destVector, thisBlockLen)

            // increment readCount properly
            readCount += thisBlockLen
            completedReads += thisBlockLen
        }
    }

    // Reached EOF before satisfying the request: zero-fill the remainder so callers get defined
    // bytes (silence, for audio) instead of stale garbage, and advance readCount so the caller's
    // read loop still terminates (it was relying on readCount reaching the requested position).
    while (completedReads < length) {
        sys.poke(ptr + completedReads * destVector, 0)
        completedReads += 1
        readCount += 1
    }

    //serial.println(`END readBytes(${length}); readCount = ${readCount}\n`)

    return ptr
}

function readInt() {
    let b = readBytes(4)
    let i = (sys.peek(b)) | (sys.peek(b+1) << 8) | (sys.peek(b+2) << 16) | (sys.peek(b+3) << 24)
    sys.free(b)
    return i
}

function readShort() {
    let b = readBytes(2)
    let i = (sys.peek(b)) | (sys.peek(b+1) << 8)
    sys.free(b)
    return i
}

function readOneByte() {
    let b = readBytes(1)
    let i = sys.peek(b)
    sys.free(b)
    return i
}

function readFourCC() {
    let b = readBytes(4)
    let a = [sys.peek(b), sys.peek(b+1), sys.peek(b+2), sys.peek(b+3)]
    sys.free(b)
    let s = String.fromCharCode.apply(null, a)
//    serial.println(`readFourCC: ${s}; ${a.map(it=>"0x"+it.toString(16).padStart(2,'0')).join()}`)
    if (s.length != 4) throw Error(`FourCC is not 4 characters long (${s}; ${a.map(it=>"0x"+it.toString(16).padStart(2,'0')).join()})`)
    return s
}

function readString(length) {
    let b = readBytes(length)
    let s = ""
    for (let k = 0; k < length; k++) {
        s += String.fromCharCode(sys.peek(b + k))
    }
    sys.free(b)
    return s
}

function skip(n) {
    let b = readBytes(n)
    if (b !== undefined) sys.free(b)
}

function getReadCount() {
    return readCount
}

function rewind() {
    // Send REWIND command to reset stream position
    com.sendMessage(port, "REWIND")
    let statusCode = com.getStatusCode(port)
    if (statusCode != 0) {
        throw Error("REWIND failed with "+statusCode)
    }
    readCount = 0
}

function seek(position) {
    if (position < 0) {
        throw Error("seek: position must be non-negative")
    }

    let relPos = position - readCount

    if (relPos == 0) {
        return  // Already at target position
    } else if (relPos < 0) {
        // Seeking backward - must rewind and skip forward
        rewind()
        if (position > 0) {
            skip(position)
        }
    } else {
        // Seeking forward - skip the difference
        skip(relPos)
    }
}

exports = {fileHeader, prepare, readBytes, readInt, readShort, readFourCC, readOneByte, readString, skip, getReadCount, seek, rewind}