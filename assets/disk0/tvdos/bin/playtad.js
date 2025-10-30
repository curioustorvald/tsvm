const SND_BASE_ADDR = audio.getBaseAddr()
const SND_MEM_ADDR = audio.getMemAddr()
const TAD_INPUT_ADDR = SND_MEM_ADDR - 262144  // TAD input buffer (matches TAV packet 0x24)
const TAD_DECODED_ADDR = SND_MEM_ADDR - 262144 + 65536  // TAD decoded buffer

if (!SND_BASE_ADDR) return 10

// Check for help flag or missing arguments
if (!exec_args[1] || exec_args[1] == "-h" || exec_args[1] == "--help") {
    serial.println("Usage: playtad <file.tad> [-i | -d] [quality]")
    serial.println("  -i         Interactive mode (progress bar, press Backspace to exit)")
    serial.println("  -d         Dump mode (show first 3 chunks with payload hex and decoded samples)")
    serial.println("")
    serial.println("Examples:")
    serial.println("  playtad audio.tad -i        # Play with progress bar")
    serial.println("  playtad audio.tad -d        # Dump first 3 chunks for debugging")
    return 0
}

const pcm = require("pcm")
const interactive = exec_args[2] && exec_args[2].toLowerCase() == "-i"
const dumpCoeffs = exec_args[2] && exec_args[2].toLowerCase() == "-d"

function printdbg(s) { if (0) serial.println(s) }


class SequentialFileBuffer {

    constructor(path, offset, length) {
        if (Array.isArray(path)) throw Error("arg #1 is path(string), not array")

        this.path = path
        this.file = files.open(path)

        this.offset = offset || 0
        this.originalOffset = offset
        this.length = length || this.file.size

        this.seq = require("seqread")
        this.seq.prepare(path)
    }

    readBytes(size, ptr) {
        return this.seq.readBytes(size, ptr)
    }

    readByte() {
        let ptr = this.seq.readBytes(1)
        let val = sys.peek(ptr)
        sys.free(ptr)
        return val
    }

    readShort() {
        let ptr = this.seq.readBytes(2)
        let val = sys.peek(ptr) | (sys.peek(ptr + 1) << 8)
        sys.free(ptr)
        return val
    }

    readInt() {
        let ptr = this.seq.readBytes(4)
        let val = sys.peek(ptr) | (sys.peek(ptr + 1) << 8) | (sys.peek(ptr + 2) << 16) | (sys.peek(ptr + 3) << 24)
        sys.free(ptr)
        return val
    }

    readStr(n) {
        let ptr = this.seq.readBytes(n)
        let s = ''
        for (let i = 0; i < n; i++) {
            if (i >= this.length) break
            s += String.fromCharCode(sys.peek(ptr + i))
        }
        sys.free(ptr)
        return s
    }

    unread(diff) {
        let newSkipLen = this.seq.getReadCount() - diff
        this.seq.prepare(this.path)
        this.seq.skip(newSkipLen)
    }

    rewind() {
        this.seq.prepare(this.path)
    }

    seek(p) {
        this.seq.prepare(this.path)
        this.seq.skip(p)
    }

    get byteLength() {
        return this.length
    }

    get fileHeader() {
        return this.seq.fileHeader
    }

    getReadCount() {
        return this.seq.getReadCount()
    }
}


// Read TAD chunk header to determine format
let filebuf = new SequentialFileBuffer(_G.shell.resolvePathInput(exec_args[1]).full)
const FILE_SIZE = filebuf.length

if (FILE_SIZE < 7) {
    serial.println(`ERROR: File too small (${FILE_SIZE} bytes). Expected TAD format.`)
    return 1
}

// Read first chunk header (standalone TAD format: no TAV wrapper)
let firstSampleCount = filebuf.readShort()
let firstMaxIndex = filebuf.readByte()
let firstPayloadSize = filebuf.readInt()

// Validate first chunk
if (firstSampleCount < 0 || firstSampleCount > 65536) {
    serial.println(`ERROR: Invalid sample count ${firstSampleCount}. File may be corrupted.`)
    return 1
}
if (firstMaxIndex < 0 || firstMaxIndex > 255) {
    serial.println(`ERROR: Invalid max index ${firstMaxIndex}. File may be corrupted.`)
    return 1
}
if (firstPayloadSize < 1 || firstPayloadSize > 65536) {
    serial.println(`ERROR: Invalid payload size ${firstPayloadSize}. File may be corrupted.`)
    return 1
}

// Rewind to start
filebuf.rewind()

// Calculate approximate frame info
const AVG_CHUNK_SIZE = 7 + firstPayloadSize  // TAD header (2+1+4) + payload
const SAMPLE_RATE = 32000
const bufRealTimeLen = Math.floor((firstSampleCount / SAMPLE_RATE) * 1000)  // milliseconds per chunk

if (dumpCoeffs) {
    serial.println(`TAD Coefficient Dump Mode`)
    serial.println(`File: ${filebuf.file.name}`)
    serial.println(`First chunk header:`)
    serial.println(`  Sample Count: ${firstSampleCount}`)
    serial.println(`  Max Index: ${firstMaxIndex}`)
    serial.println(`  Payload Size: ${firstPayloadSize} bytes`)
    serial.println(`Chunk Duration: ${bufRealTimeLen} ms`)
    serial.println(``)
}


let bytes_left = FILE_SIZE
let decodedLength = 0
let chunkNumber = 0


con.curs_set(0)
let [__, CONSOLE_WIDTH] = con.getmaxyx()
if (interactive) {
    let [cy, cx] = con.getyx()
    // file name
    con.mvaddch(cy, 1)
    con.prnch(0xC9);con.prnch(0xCD);con.prnch(0xB5)
    print(filebuf.file.name)
    con.prnch(0xC6);con.prnch(0xCD)
    print("\x84205u".repeat(CONSOLE_WIDTH - 26 - filebuf.file.name.length))
    con.prnch(0xB5)
    print("Hold Bksp to Exit")
    con.prnch(0xC6);con.prnch(0xCD);con.prnch(0xBB)

    // L R pillar
    con.prnch(0xBA)
    con.mvaddch(cy+1, CONSOLE_WIDTH, 0xBA)

    // media info
    let mediaInfoStr = `TAD Q${firstMaxIndex} ${SAMPLE_RATE/1000}kHz`
    con.move(cy+2,1)
    con.prnch(0xC8)
    print("\x84205u".repeat(CONSOLE_WIDTH - 5 - mediaInfoStr.length))
    con.prnch(0xB5)
    print(mediaInfoStr)
    con.prnch(0xC6);con.prnch(0xCD);con.prnch(0xBC)

    con.move(cy+1, 2)
}
let [cy, cx] = con.getyx()
let paintWidth = CONSOLE_WIDTH - 20

function bytesToSec(i) {
    // Approximate: use first chunk's ratio
    return Math.round((i / FILE_SIZE) * (FILE_SIZE / AVG_CHUNK_SIZE) * (bufRealTimeLen / 1000))
}

function secToReadable(n) {
    let mins = ''+((n/60)|0)
    let secs = ''+(n % 60)
    return `${mins.padStart(2,'0')}:${secs.padStart(2,'0')}`
}

function printPlayBar() {
    if (interactive) {
        let currently = decodedLength
        let total = FILE_SIZE

        let currentlySec = bytesToSec(currently)
        let totalSec = bytesToSec(total)

        con.move(cy, 3)
        print(' '.repeat(15))
        con.move(cy, 3)

        print(`${secToReadable(currentlySec)} / ${secToReadable(totalSec)}`)

        con.move(cy, 17)
        print(' ')
        let progressbar = '\x84196u'.repeat(paintWidth + 1)
        print(progressbar)

        con.mvaddch(cy, 18 + Math.round(paintWidth * (currently / total)), 0xDB)
    }
}


audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setPcmQueueCapacityIndex(0, 2) // queue size is now 8
const QUEUE_MAX = audio.getPcmQueueCapacity(0)
audio.setMasterVolume(0, 255)
audio.play(0)


let stopPlay = false
let errorlevel = 0

try {
    while (bytes_left > 0 && !stopPlay) {

        if (interactive) {
            sys.poke(-40, 1)
            if (sys.peek(-41) == 67) {  // Backspace key
                stopPlay = true
            }
        }

        printPlayBar()

        // Read TAD chunk header (standalone TAD format)
        // Format: [sample_count][max_index][payload_size][payload]
        let sampleCount = filebuf.readShort()
        let maxIndex = filebuf.readByte()
        let payloadSize = filebuf.readInt()

        // Validate every chunk (not just first one)
        if (sampleCount < 0 || sampleCount > 65536) {
            serial.println(`ERROR: Chunk ${chunkNumber}: Invalid sample count ${sampleCount}. File may be corrupted.`)
            errorlevel = 1
            break
        }
        if (maxIndex < 0 || maxIndex > 255) {
            serial.println(`ERROR: Chunk ${chunkNumber}: Invalid max index ${maxIndex}. File may be corrupted.`)
            errorlevel = 1
            break
        }
        if (payloadSize < 1 || payloadSize > 65536) {
            serial.println(`ERROR: Chunk ${chunkNumber}: Invalid payload size ${payloadSize}. File may be corrupted.`)
            errorlevel = 1
            break
        }
        if (payloadSize + 7 > bytes_left) {
            serial.println(`ERROR: Chunk ${chunkNumber}: Chunk size ${payloadSize + 7} exceeds remaining file size ${bytes_left}`)
            errorlevel = 1
            break
        }

        if (dumpCoeffs && chunkNumber < 3) {
            serial.println(`=== Chunk ${chunkNumber} ===`)
            serial.println(`  Sample Count: ${sampleCount}`)
            serial.println(`  Max Index: ${maxIndex}`)
            serial.println(`  Payload Size: ${payloadSize} bytes`)
            serial.println(`  Bytes remaining in file: ${bytes_left}`)
        }

        // Rewind 7 bytes to re-read the header along with payload
        // This allows reading the complete chunk (header + payload) in one call
        filebuf.unread(7)

        // Read entire chunk (header + payload) to TAD input buffer
        // This matches TAV's approach for packet 0x24
        let totalChunkSize = 7 + payloadSize
        filebuf.readBytes(totalChunkSize, TAD_INPUT_ADDR)

        if (dumpCoeffs && chunkNumber < 3) {
            // Dump first 32 bytes of compressed payload (skip 7-byte header)
            serial.print(`  Compressed data (first 32 bytes): `)
            for (let i = 0; i < Math.min(32, payloadSize); i++) {
                let b = sys.peek(TAD_INPUT_ADDR + 7 + i)
                serial.print(`${(b & 0xFF).toString(16).padStart(2, '0')} `)
            }
            serial.println('')
        }

        // Decode TAD chunk
        audio.tadDecode()

        if (dumpCoeffs && chunkNumber < 3) {
            // After decoding, the decoded PCMu8 samples are in tadDecodedBin
            serial.println(`  Decoded ${sampleCount} samples`)

            // Dump first 16 decoded samples (PCMu8 stereo interleaved)
            serial.print(`  Decoded (first 16 L samples): `)
            for (let i = 0; i < 16; i++) {
                serial.print(`${sys.peek(TAD_DECODED_ADDR + i * 2) & 0xFF} `)
            }
            serial.println('')
            serial.print(`  Decoded (first 16 R samples): `)
            for (let i = 0; i < 16; i++) {
                serial.print(`${sys.peek(TAD_DECODED_ADDR + i * 2 + 1) & 0xFF} `)
            }
            serial.println('')
            serial.println('')
        }

        // Upload decoded audio to queue
        audio.tadUploadDecoded(0, sampleCount)

        if (!dumpCoeffs) {
            // Sleep for the duration of the audio chunk to pace playback
            // This prevents uploading everything at once
            sys.sleep(bufRealTimeLen)
        }

        // Chunk size = header (7 bytes) + payload
        let chunkSize = 7 + payloadSize
        bytes_left -= chunkSize
        decodedLength += chunkSize
        chunkNumber++

        // Limit coefficient dump to first 3 chunks
        if (dumpCoeffs && chunkNumber >= 3) {
            serial.println(`... (remaining chunks omitted)`)
            // Keep playing but don't dump more
        }
    }
}
catch (e) {
    printerrln(e)
    errorlevel = 1
}
finally {
    if (interactive) {
        con.move(cy + 3, 1)
        con.curs_set(1)
    }
}

return errorlevel
