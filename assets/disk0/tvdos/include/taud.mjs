/*
 * LibTaud — Helper functions for interaction between Taud format and TSVM Tracker
 * Requires TVDOS to function.
 * @author CuriousTorvald
 */

// ── Format constants ────────────────────────────────────────────────────────

const TAUD_MAGIC        = [0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64]  // \x1F TSVMaud
const TAUD_VERSION      = 1
const TAUD_HEADER_SIZE  = 32     // magic(8) + version(1) + numSongs(1) + compSize(4) + projOff(4) + sig(14)
const TAUD_SONG_ENTRY   = 32     // see encodeSongEntry / decodeSongEntry below
// Sample+instrument image: 8 MB sample pool (banked, 16 × 512 K) + 64 K instrument bin = 8256 kB total.
// (terranmon.txt:1985-1997, 2533-2564 — bank-switched via MMIO 46.)
const SAMPLE_BANK_SIZE  = 524288             // 512 K — size of the sample-bin window
const SAMPLE_BANK_COUNT = 16                 // 16 banks × 512 K = 8 MB
const SAMPLEBIN_SIZE    = SAMPLE_BANK_SIZE * SAMPLE_BANK_COUNT   // 8 MB
const INSTBIN_SIZE      = 65536              // 256 inst × 256 bytes
const SAMPLEINST_SIZE   = SAMPLEBIN_SIZE + INSTBIN_SIZE          // 8454144 = 8256 kB
const SAMPLEBIN_WINDOW_OFFSET = 0            // peripheral memory window for the active sample bank
const INSTBIN_WINDOW_OFFSET   = 720896       // peripheral memory offset of instrument bin
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
    // magic(8) + version(1) + numSongs(1) + compSize(4) + projOff(4) + signature(14)
    // = 32 bytes (terranmon.txt §Header).
    let version        = sys.peek(filePtr + pos) & 0xFF;  pos++
    let numSongs       = sys.peek(filePtr + pos) & 0xFF;  pos++
    let compressedSize = _peekU32LE(filePtr, pos);         pos += 4
    let projOff        = _peekU32LE(filePtr, pos);         pos += 4
    pos += 14  // signature
    // pos == 32 == TAUD_HEADER_SIZE

    if (songIndex < 0 || songIndex >= numSongs) {
        sys.free(filePtr)
        throw Error("taud: songIndex " + songIndex + " out of range (numSongs=" + numSongs + ")")
    }

    // -- 4. Decompress and upload sample+instrument bin -----------------------
    // The decompressed image is 8256 kB (8 MB samples bank-major + 64 K instruments)
    // which exceeds the 8 MB user-space cap, so we route through a hardware helper
    // that decompresses straight into the adapter's native sample/instrument
    // storage instead of staging a buffer in user memory.
    audio.uploadSampleInstBlob(filePtr + pos, compressedSize)
    audio.setSampleBank(0)
    pos += compressedSize

    // -- 5. Parse song-table entry for the requested song --------------------
    let entryOff   = pos + songIndex * TAUD_SONG_ENTRY
    let songOffset = _peekU32LE(filePtr, entryOff)
    let numVoices  = sys.peek(filePtr + entryOff + 4) & 0xFF
    let numPatsLo  = sys.peek(filePtr + entryOff + 5) & 0xFF
    let numPatsHi  = sys.peek(filePtr + entryOff + 6) & 0xFF
    let bpmStored  = sys.peek(filePtr + entryOff + 7) & 0xFF
    let tickRate   = sys.peek(filePtr + entryOff + 8) & 0xFF
    let mixerflags = sys.peek(filePtr + entryOff + 15) & 0xFF
    let songGlobalVolume = sys.peek(filePtr + entryOff + 16) & 0xFF
    let songMixingVolume = sys.peek(filePtr + entryOff + 17) & 0xFF
    let patBinCompSize   = _peekU32LE(filePtr, entryOff + 18)
    let cueSheetCompSize = _peekU32LE(filePtr, entryOff + 22)

    let bpm        = bpmStored + 25
    let patsToLoad = numPatsLo | (numPatsHi << 8)

    // -- 6. Decompress + upload patterns --------------------------------------
    let patBinSize  = patsToLoad * PATTERN_SIZE
    let patBinPtr   = sys.malloc(patBinSize)
    gzip.decompFromTo(filePtr + songOffset, patBinCompSize, patBinPtr)

    let patBytes = new Array(PATTERN_SIZE)
    for (let p = 0; p < patsToLoad; p++) {
        for (let k = 0; k < PATTERN_SIZE; k++)
            patBytes[k] = sys.peek(patBinPtr + p * PATTERN_SIZE + k) & 0xFF
        audio.uploadPattern(p, patBytes)
    }
    sys.free(patBinPtr)

    // -- 7. Decompress + upload cue sheet -------------------------------------
    let cueSheetSize = NUM_CUES * CUE_SIZE
    let cueSheetPtr  = sys.malloc(cueSheetSize)
    gzip.decompFromTo(filePtr + songOffset + patBinCompSize, cueSheetCompSize, cueSheetPtr)

    let cueBytes = new Array(CUE_SIZE)
    for (let c = 0; c < NUM_CUES; c++) {
        for (let k = 0; k < CUE_SIZE; k++)
            cueBytes[k] = sys.peek(cueSheetPtr + c * CUE_SIZE + k) & 0xFF
        audio.uploadCue(c, cueBytes)
    }
    sys.free(cueSheetPtr)

    // -- 8. Configure playhead ------------------------------------------------
    audio.setTrackerMode(playhead)
    audio.setBPM(playhead, bpm)
    audio.setTickRate(playhead, tickRate > 0 ? tickRate : 6)
    audio.setTrackerMixerFlags(playhead, mixerflags)
    audio.setSongGlobalVolume(playhead, songGlobalVolume)
    audio.setSongMixingVolume(playhead, songMixingVolume)

    // -- 9. Project Data — walk Ixmp blocks for multi-sample instruments -----
    // Terranmon spec: Project Data starts at `projOff` (zero = absent), magic is
    // \x1ETaudPrJ + 8 reserved bytes, then a stream of FourCC + Uint32-length
    // sections. We only consume "Ixmp" here; other sections (PNam, INam, sMet,
    // etc.) are skipped so the player apps remain free to parse them.
    if (projOff !== 0 && projOff + 16 <= fileSize) {
        const projMagic = [0x1E,0x54,0x61,0x75,0x64,0x50,0x72,0x4A]  // \x1ETaudPrJ
        let prjOk = true
        for (let i = 0; i < 8; i++) {
            if ((sys.peek(filePtr + projOff + i) & 0xFF) !== projMagic[i]) { prjOk = false; break }
        }
        if (prjOk) {
            const PATCH_SIZE = 31
            let p = projOff + 16  // skip magic(8) + reserved(8)
            while (p + 8 <= fileSize) {
                const fc = String.fromCharCode(
                    sys.peek(filePtr + p)     & 0xFF, sys.peek(filePtr + p + 1) & 0xFF,
                    sys.peek(filePtr + p + 2) & 0xFF, sys.peek(filePtr + p + 3) & 0xFF)
                const secLen = _peekU32LE(filePtr, p + 4)
                const payload = p + 8
                if (payload + secLen > fileSize) break
                if (fc === 'Ixmp') {
                    // Each entry: Uint8 instId + Uint24 patchCount + (patchCount × PATCH_SIZE) bytes.
                    let q = payload
                    const qEnd = payload + secLen
                    while (q + 4 <= qEnd) {
                        const instId   = sys.peek(filePtr + q) & 0xFF; q++
                        const cntLo    = sys.peek(filePtr + q) & 0xFF; q++
                        const cntMid   = sys.peek(filePtr + q) & 0xFF; q++
                        const cntHi    = sys.peek(filePtr + q) & 0xFF; q++
                        const patchCnt = cntLo | (cntMid << 8) | (cntHi << 16)
                        const blobLen  = patchCnt * PATCH_SIZE
                        if (q + blobLen > qEnd) break
                        let buf = new Array(blobLen)
                        for (let k = 0; k < blobLen; k++) buf[k] = sys.peek(filePtr + q + k) & 0xFF
                        audio.uploadInstrumentPatches(instId, buf)
                        q += blobLen
                    }
                }
                p = payload + secLen
            }
        }
    }


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
    // The 8256 kB raw image (8 MB samples + 64 K instruments) cannot fit in the
    // 8 MB user space, so we hand the entire compress step to a hardware helper
    // that reads directly out of the adapter's native sample/instrument storage.
    // Realistic sample data compresses well under both gzip and zstd; we cap the
    // destination at "uncompressed size + 8 K" headroom which suffices for any
    // sane musical content.
    const COMP_BUF_CAP = 1024 * 1024 * 4   // 4 MiB cap for compressed sample+inst blob
    let compBuf       = sys.malloc(COMP_BUF_CAP)
    let compressedSize = audio.captureSampleInstBlob(compBuf, COMP_BUF_CAP)
    if (compressedSize > COMP_BUF_CAP) {
        sys.free(compBuf)
        throw Error("taud: compressed sample+inst blob exceeded " + COMP_BUF_CAP + " bytes (got " + compressedSize + ")")
    }

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

    // -- 3. BPM / tick-rate / volumes from playhead 0 -------------------------
    let bpm      = audio.getBPM(0)      || 125
    let tickRate = audio.getTickRate(0) || 6
    let bpmStored = (bpm - 25) & 0xFF
    let songGlobalVolume = audio.getSongGlobalVolume(0)
    let songMixingVolume = audio.getSongMixingVolume(0)
    if (songGlobalVolume === undefined || songGlobalVolume === null) songGlobalVolume = 0x80
    if (songMixingVolume === undefined || songMixingVolume === null) songMixingVolume = 0x80

    // -- 4. Compress pattern bin ----------------------------------------------
    let patBinSize = patsToSave * PATTERN_SIZE
    let patBuf     = sys.malloc(patBinSize)
    sys.memcpy(memBase - 131072, patBuf, patBinSize)

    let patCompBuf = sys.malloc(patBinSize + 4096)
    let patCompSize = gzip.compFromTo(patBuf, patBinSize, patCompBuf)
    sys.free(patBuf)

    // -- 5. Compress cue sheet ------------------------------------------------
    // Cue entry c, byte k is at MMIO address 32768 + c*32 + k,
    // accessed as sys.peek(baseAddr − (32768 + c*32 + k)).
    let cueSheetSize = NUM_CUES * CUE_SIZE
    let cueBuf = sys.malloc(cueSheetSize)
    for (let c = 0; c < NUM_CUES; c++) {
        let cueOff = 32768 + c * CUE_SIZE
        for (let k = 0; k < CUE_SIZE; k++)
            sys.poke(cueBuf + c * CUE_SIZE + k,
                sys.peek(baseAddr - (cueOff + k)) & 0xFF)
    }

    let cueCompBuf  = sys.malloc(cueSheetSize + 4096)
    let cueCompSize = gzip.compFromTo(cueBuf, cueSheetSize, cueCompBuf)
    sys.free(cueBuf)

    // -- 6. Compute song offset (absolute from file start) --------------------
    // Layout: header(32) + compressed(compressedSize) + songTable(1 × TAUD_SONG_ENTRY)
    let songOffset = TAUD_HEADER_SIZE + compressedSize + 1 * TAUD_SONG_ENTRY

    // -- 7. Build header byte array (32 bytes) --------------------------------
    let sigBytes = new Array(14)
    for (let i = 0; i < 14; i++)
        sigBytes[i] = i < CAPTURE_SIGNATURE.length ? CAPTURE_SIGNATURE.charCodeAt(i) : 0

    let header = [
        // Magic (8)
        0x1F, 0x54, 0x53, 0x56, 0x4D, 0x61, 0x75, 0x64,
        // version, numSongs
        TAUD_VERSION, 1,
        // compressedSize uint32 LE (4) -- sample+inst bin
        (compressedSize        ) & 0xFF,
        (compressedSize >>>  8) & 0xFF,
        (compressedSize >>> 16) & 0xFF,
        (compressedSize >>> 24) & 0xFF,
        // project data offset (4) -- not emitted
        0x00, 0x00, 0x00, 0x00,
    ].concat(sigBytes)  // 8 + 2 + 4 + 4 + 14 = 32 bytes

    // -- 8. Build song-table row (32 bytes) -----------------------------------
    let songTable = [
        (songOffset        ) & 0xFF,
        (songOffset >>>  8) & 0xFF,
        (songOffset >>> 16) & 0xFF,
        (songOffset >>> 24) & 0xFF,
        20,                                    // numVoices
        numPats & 0xFF, (numPats >>> 8) & 0xFF, // numPatterns Uint16 LE
        bpmStored,                             // BPM with −25 bias
        tickRate,                              // initial tick-rate
        0x00,0xA0,                             // basenote (0xA000 -- C9)
        0x00,0xAC,0x02,0x46,                   // basefreq (8363 Hz)
        sys.peek(baseAddr - 7),                // mixer flags
        songGlobalVolume & 0xFF,               // global volume
        songMixingVolume & 0xFF,               // mixing volume
        // pattern bin compressed size (4)
        (patCompSize        ) & 0xFF,
        (patCompSize >>>  8) & 0xFF,
        (patCompSize >>> 16) & 0xFF,
        (patCompSize >>> 24) & 0xFF,
        // cue sheet compressed size (4)
        (cueCompSize        ) & 0xFF,
        (cueCompSize >>>  8) & 0xFF,
        (cueCompSize >>> 16) & 0xFF,
        (cueCompSize >>> 24) & 0xFF,
        // reserved (6)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]

    // -- 9. Write header (creates / truncates file) ---------------------------
    const fileHandle = files.open(outFile)
    fileHandle.bwrite(header)

    // -- 10. Append compressed sample+inst bin --------------------------------
    fileHandle.pwrite(compBuf, compressedSize, TAUD_HEADER_SIZE)
    sys.free(compBuf)

    // -- 11. Write song table -------------------------------------------------
    fileHandle.bwrite(songTable)

    // -- 12. Append compressed pattern bin ------------------------------------
    fileHandle.pwrite(patCompBuf, patCompSize,
        TAUD_HEADER_SIZE + compressedSize + songTable.length)
    sys.free(patCompBuf)

    // -- 13. Append compressed cue sheet --------------------------------------
    fileHandle.pwrite(cueCompBuf, cueCompSize,
        TAUD_HEADER_SIZE + compressedSize + songTable.length + patCompSize)
    sys.free(cueCompBuf)


    fileHandle.flush(); fileHandle.close()
}

exports = { uploadTaudFile, captureTrackerDataToFile }
