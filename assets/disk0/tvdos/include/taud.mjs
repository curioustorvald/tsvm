/*
 * LibTaud — Helper functions for interaction between Taud format and TSVM Tracker
 * Requires TVDOS to function.
 * @author CuriousTorvald
 */

// ── Format constants ────────────────────────────────────────────────────────

const TAUD_MAGIC        = [0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64]  // \x1F TSVMaud
const TAUD_VERSION      = 1
const TAUD_HEADER_SIZE  = 32     // magic(8) + version(1) + numSongs(1) + compSize(4) + rsvd(2) + sig(16)
const TAUD_SONG_ENTRY   = 16     // bytes per song-table row (offset(4)+voices(1)+pats(2)+bpm(1)+tick(1)+pad(7))
const SAMPLEINST_SIZE   = 786432 // 737280 sample + 49152 instrument (256 × 192)
const PATTERN_SIZE      = 512    // bytes per pattern (64 rows × 8 bytes)
const NUM_PATTERNS_MAX  = 256
const NUM_CUES          = 1024
const CUE_SIZE          = 32     // bytes per cue entry (packed 12-bit×20 voices + instruction + pad)

// Signature written into the file (14 bytes, space-padded)
const CAPTURE_SIGNATURE = "LibTaud/TSVM  "

// ── Internal helpers ────────────────────────────────────────────────────────

function _peekU32LE(ptr, off) {
    return ((sys.peek(ptr+off)   & 0xFF)       ) |
           ((sys.peek(ptr+off+1) & 0xFF) <<  8 ) |
           ((sys.peek(ptr+off+2) & 0xFF) << 16 ) |
           ((sys.peek(ptr+off+3) & 0xFF) * 0x1000000)  // avoid sign-extend
}

function _pokeU32LE(ptr, off, v) {
    sys.poke(ptr+off,   (v        ) & 0xFF)
    sys.poke(ptr+off+1, (v >>>  8) & 0xFF)
    sys.poke(ptr+off+2, (v >>> 16) & 0xFF)
    sys.poke(ptr+off+3, (v >>> 24) & 0xFF)
}

// ── uploadTaudFile ──────────────────────────────────────────────────────────

/**
 * Load one song from a Taud file into the tracker hardware and configure the
 * given playhead ready to play.
 *
 * @param inFile             Full path with drive letter, e.g. "A:/music/song.taud"
 * @param songIndex          0-based index of the song in the SONG TABLE
 * @param playhead Playhead number (0-3) to configure
 */
function uploadTaudFile(inFile, songIndex, playhead) {
    const drive    = inFile[0].toUpperCase()
    const diskPath = inFile.substring(2)

    const memBase  = audio.getMemAddr()

    // -- 1. Read whole file into VM memory ------------------------------------
    const fileHandle = files.open(inFile)

    if (!fileHandle.exists) {
        throw Error("taud: file not exists")
    }

    const fileSize = fileHandle.size
    const filePtr  = sys.malloc(fileSize)
    fileHandle.pread(filePtr, fileSize, 0)

    let pos = 0

    // -- 2. Verify magic ------------------------------------------------------
    for (let i = 0; i < 8; i++) {
        let magicc = sys.peek(filePtr + i)
        if (magicc !== TAUD_MAGIC[i]) {
            sys.free(filePtr)
            throw Error("taud: bad magic byte " + magicc.toString(16) + " at index " + i)
        }
    }
    pos = 8

    // -- 3. Parse header ------------------------------------------------------
    // version(1) + numSongs(1) + compressedSize(4) + rsvd(2) + signature(16) = 24 bytes
    let version        = sys.peek(filePtr + pos) & 0xFF;  pos++
    let numSongs       = sys.peek(filePtr + pos) & 0xFF;  pos++
    let compressedSize = _peekU32LE(filePtr, pos);         pos += 4
    pos += 18  // skip reserved(2) + signature(16)
    // pos == 32 == TAUD_HEADER_SIZE

    if (songIndex < 0 || songIndex >= numSongs) {
        sys.free(filePtr)
        throw Error("taud: songIndex " + songIndex + " out of range (numSongs=" + numSongs + ")")
    }

    // -- 4. Decompress and upload sample+instrument bin -----------------------
    let decompPtr = sys.malloc(SAMPLEINST_SIZE)
    gzip.decompFromTo(filePtr + pos, compressedSize, decompPtr)
    pos += compressedSize

    // Write decompressed data to peripheral memory (backwards addressing:
    // peripheral byte k lives at memBase - k).
    for (let i = 0; i < SAMPLEINST_SIZE; i++) {
        // TODO use sys.memcpy
        sys.poke(memBase - i, sys.peek(decompPtr + i))
    }
    sys.free(decompPtr)

    // -- 5. Parse song-table entry for the requested song --------------------
    let entryOff   = pos + songIndex * TAUD_SONG_ENTRY
    let songOffset = _peekU32LE(filePtr, entryOff)
    let numVoices  = sys.peek(filePtr + entryOff + 4) & 0xFF
    let numPatsLo  = sys.peek(filePtr + entryOff + 5) & 0xFF
    let numPatsHi  = sys.peek(filePtr + entryOff + 6) & 0xFF
    let bpmStored  = sys.peek(filePtr + entryOff + 7) & 0xFF
    let tickRate   = sys.peek(filePtr + entryOff + 8) & 0xFF
    let mixerflags = sys.peek(filePtr + entryOff + 15) & 0xFF

    let bpm        = bpmStored + 24
    let patsToLoad = numPatsLo | (numPatsHi << 8)

    // -- 6. Upload patterns ---------------------------------------------------
    let songBase  = filePtr + songOffset
    let patBytes  = new Array(PATTERN_SIZE)
    for (let p = 0; p < patsToLoad; p++) {
        for (let k = 0; k < PATTERN_SIZE; k++)
            patBytes[k] = sys.peek(songBase + p * PATTERN_SIZE + k) & 0xFF
        audio.uploadPattern(p, patBytes)
    }

    // -- 7. Upload cue sheet --------------------------------------------------
    let cueBase  = songBase + patsToLoad * PATTERN_SIZE
    let cueBytes = new Array(CUE_SIZE)
    for (let c = 0; c < NUM_CUES; c++) {
        for (let k = 0; k < CUE_SIZE; k++)
            cueBytes[k] = sys.peek(cueBase + c * CUE_SIZE + k) & 0xFF
        audio.uploadCue(c, cueBytes)
    }

    // -- 8. Configure playhead ------------------------------------------------
    audio.setTrackerMode(playhead)
    audio.setBPM(playhead, bpm)
    audio.setTickRate(playhead, tickRate > 0 ? tickRate : 6)
    audio.setTrackerMixerFlags(playhead, mixerflags)


    fileHandle.close()
    sys.free(filePtr)
}

// ── captureTrackerDataToFile ────────────────────────────────────────────────

/**
 * Dump the current tracker hardware state (sample bin, instruments, patterns
 * in bank 0, cue sheet) to a single-song Taud file.  BPM and tick-rate are
 * taken from playhead 0.
 *
 * @param outFile Full path with drive letter, e.g. "A:/music/out.taud"
 */
function captureTrackerDataToFile(outFile) {
    const drive    = outFile[0].toUpperCase()
    const diskPath = outFile.substring(2)

    const memBase  = audio.getMemAddr()
    const baseAddr = audio.getBaseAddr()

    // -- 1. Compress sample+instrument bin ------------------------------------
    // sys.memcpy(negative_src, positive_dst, len) copies peripheral byte k from
    // (memBase - k) into (sampleInstBuf + k).
    let sampleInstBuf = sys.malloc(SAMPLEINST_SIZE)
    sys.memcpy(memBase, sampleInstBuf, SAMPLEINST_SIZE)

    let compBuf       = sys.malloc(SAMPLEINST_SIZE + 4096)  // headroom for incompressible data
    let compressedSize = gzip.compFromTo(sampleInstBuf, SAMPLEINST_SIZE, compBuf)
    sys.free(sampleInstBuf)

    // -- 2. Find last non-empty pattern in bank 0 (all-zero = uninitialized) --
    let numPatsActual = 0
    outer: for (let p = NUM_PATTERNS_MAX - 1; p >= 0; p--) {
        let patBase = 131072 + p * PATTERN_SIZE  // offset within peripheral memory space
        for (let k = 0; k < PATTERN_SIZE; k++) {
            if ((sys.peek(memBase - (patBase + k)) & 0xFF) !== 0) {
                numPatsActual = p + 1
                break outer
            }
        }
    }
    if (numPatsActual === 0) numPatsActual = 1  // always emit at least one pattern slot

    let numPats    = numPatsActual  // Uint16, 1-65535
    let patsToSave = numPatsActual

    // -- 3. BPM / tick-rate from playhead 0 -----------------------------------
    let bpm      = audio.getBPM(0)      || 125
    let tickRate = audio.getTickRate(0) || 6
    let bpmStored = (bpm - 24) & 0xFF

    // -- 4. Compute song offset (absolute from file start) --------------------
    // Layout: header(32) + compressed(compressedSize) + songTable(1 × TAUD_SONG_ENTRY)
    let songOffset = TAUD_HEADER_SIZE + compressedSize + 1 * TAUD_SONG_ENTRY

    // -- 5. Build header byte array (32 bytes) --------------------------------
    let sigBytes = new Array(16)
    for (let i = 0; i < 16; i++)
        sigBytes[i] = i < CAPTURE_SIGNATURE.length ? CAPTURE_SIGNATURE.charCodeAt(i) : 0

    let header = [
        // Magic (8)
        0x1F, 0x54, 0x53, 0x56, 0x4D, 0x61, 0x75, 0x64,
        // version, numSongs
        TAUD_VERSION, 1,
        // compressedSize uint32 LE (4)
        (compressedSize        ) & 0xFF,
        (compressedSize >>>  8) & 0xFF,
        (compressedSize >>> 16) & 0xFF,
        (compressedSize >>> 24) & 0xFF,
        // reserved (4)
        0x00, 0x00, 0x00, 0x00,
    ].concat(sigBytes)  // 8 + 2 + 4 + 2 + 16 = 32 bytes

    // -- 6. Build song-table row (16 bytes) -----------------------------------
    let songTable = [
        (songOffset        ) & 0xFF,
        (songOffset >>>  8) & 0xFF,
        (songOffset >>> 16) & 0xFF,
        (songOffset >>> 24) & 0xFF,
        20,                                    // numVoices
        numPats & 0xFF, (numPats >>> 8) & 0xFF, // numPatterns Uint16 LE
        bpmStored,                             // BPM with −24 bias
        tickRate,                              // initial tick-rate
        0x00,0xA0,              // basenote (0xA000 -- C9)
        0x00,0xAC,0x02,0x46, // basefreq (8363 Hz)
        sys.peek(baseAddr - 7), // mixer flags
    ]

    // -- 7. Write header (creates / truncates file) ---------------------------
    const fileHandle = files.open(outFile)
    fileHandle.bwrite(header)

    // -- 8. Append compressed sample+inst bin ---------------------------------
    fileHandle.pwrite(compBuf, compressedSize, 32)
    sys.free(compBuf)

    // -- 9. Write song table --------------------------------------------------
    fileHandle.bwrite(songTable)

    // -- 10. Append pattern bin -----------------------------------------------
    let patBuf = sys.malloc(patsToSave * PATTERN_SIZE)
    sys.memcpy(memBase - 131072, patBuf, patsToSave * PATTERN_SIZE)
    fileHandle.pwrite(patBuf, patsToSave * PATTERN_SIZE, 32 + compressedSize + songTable.length)
    sys.free(patBuf)

    // -- 11. Append cue sheet (all 1024 entries from MMIO space) --------------
    // Cue entry c, byte k is at MMIO address 32768 + c*32 + k,
    // accessed as sys.peek(baseAddr − (32768 + c*32 + k)).
    let cueBuf = sys.malloc(NUM_CUES * CUE_SIZE)
    for (let c = 0; c < NUM_CUES; c++) {
        let cueOff = 32768 + c * CUE_SIZE
        for (let k = 0; k < CUE_SIZE; k++)
            sys.poke(cueBuf + c * CUE_SIZE + k,
                sys.peek(baseAddr - (cueOff + k)) & 0xFF)
    }
    fileHandle.pwrite(cueBuf, NUM_CUES * CUE_SIZE, 32 + compressedSize + songTable.length + patsToSave * PATTERN_SIZE)
    sys.free(cueBuf)


    fileHandle.flush(); fileHandle.close()
}

exports = { uploadTaudFile, captureTrackerDataToFile }
