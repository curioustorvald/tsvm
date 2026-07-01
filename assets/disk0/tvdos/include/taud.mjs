/*
 * LibTaud — Helper functions for interaction between Taud format and TSVM Tracker
 * Requires TVDOS to function.
 * @author CuriousTorvald
 */

// ── Format constants ────────────────────────────────────────────────────────

const TAUD_MAGIC        = [0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64]  // \x1F TSVMaud
const TAUD_VERSION      = 1
const TAUD_HEADER_SIZE  = 32     // magic(8) + version(1) + numSongs(1) + compSize(4) + projOff(4) + sig(14)
// Container kind = top two bits of the version byte (terranmon.txt:3342-3401).
//   00 → full .taud  (sample+inst image + song table + patterns)
//   10 → .tsii       (sample+inst image only; numSongs = 0, no song table)
//   11 → .tpif       (patterns only; sample+inst compSize = 0 — section absent —
//                     instruments come from a previously-loaded .tsii)
const TAUD_KIND_MASK       = 0xC0
const TAUD_KIND_FULL       = 0x00
const TAUD_KIND_SAMPLEINST = 0x80
const TAUD_KIND_PATTERN    = 0xC0
const TAUD_SONG_ENTRY   = 32     // see encodeSongEntry / decodeSongEntry below
// Sample+instrument image: 8 MB sample pool (banked, 16 × 512 K) + 128 K instrument bin = 8320 kB total.
// (terranmon.txt:1985-1997, 2533-2564 — bank-switched via MMIO 46.)
const SAMPLE_BANK_SIZE  = 524288             // 512 K — size of the sample-bin window
const SAMPLE_BANK_COUNT = 16                 // 16 banks × 512 K = 8 MB
const SAMPLEBIN_SIZE    = SAMPLE_BANK_SIZE * SAMPLE_BANK_COUNT   // 8 MB
const INSTBIN_SIZE      = 131072             // 512 inst × 256 bytes ($00..$FF + aux $100..$1FF)
const SAMPLEINST_SIZE   = SAMPLEBIN_SIZE + INSTBIN_SIZE          // 8519680 = 8320 kB
const SAMPLEBIN_WINDOW_OFFSET = 0            // peripheral memory window for the active sample bank
const AUXBIN_WINDOW_OFFSET    = 655360       // peripheral memory offset of aux instrument bin $100..$1FF
const INSTBIN_WINDOW_OFFSET   = 720896       // peripheral memory offset of instrument bin $00..$FF
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

// Little-endian IEEE-754 float32 → 4-byte array. Used to serialise the song
// table's "Frequency at the base note" field (terranmon.txt §"Song Table").
function _f32leBytes(v) {
    const fa = new Float32Array(1); fa[0] = v
    const u8 = new Uint8Array(fa.buffer)
    return [u8[0] & 0xFF, u8[1] & 0xFF, u8[2] & 0xFF, u8[3] & 0xFF]
}

// UTF-8-ish (byte-per-char, mirrors the loadTaudSongList reader's
// String.fromCharCode) null-terminated byte run for a string field.
function _strBytesNul(s) {
    const out = []
    const str = (s == null) ? '' : ('' + s)
    for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xFF)
    out.push(0)
    return out
}

// ── uploadTaudFile ──────────────────────────────────────────────────────────

/**
 * Load a Taud container into the tracker hardware. Handles all three kinds
 * (terranmon.txt:3342-3401), distinguished by the top two bits of the version
 * byte:
 *   - full .taud (00): uploads the sample+instrument image AND loads one song.
 *   - .tsii (10): uploads the sample+instrument image ONLY (the shared bank for a
 *     collection of .tpif files). songIndex / playhead are ignored.
 *   - .tpif (11): loads one song's patterns ONLY, leaving the resident
 *     sample+instrument bank untouched — load the companion .tsii FIRST.
 *
 * @param inFile             Full path with drive letter, e.g. "A:/music/song.taud"
 * @param songIndex          0-based index of the song in the SONG TABLE (ignored for .tsii)
 * @param playhead Playhead number (0-3) to configure (ignored for .tsii)
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

    const kind         = version & TAUD_KIND_MASK
    const isSampleInst = (kind === TAUD_KIND_SAMPLEINST)   // .tsii: instruments only
    const isPattern    = (kind === TAUD_KIND_PATTERN)      // .tpif: patterns only

    // -- 4. Decompress and upload sample+instrument bin -----------------------
    // The decompressed image is 8320 kB (8 MB samples bank-major + 128 K instruments)
    // which exceeds the 8 MB user-space cap, so we route through a hardware helper
    // that decompresses straight into the adapter's native sample/instrument
    // storage instead of staging a buffer in user memory.
    // Skipped for .tpif — its sample+inst section is absent (compSize = 0) and the
    // resident bank (from a previously-loaded .tsii) must be left intact.
    if (!isPattern) {
        audio.uploadSampleInstBlob(filePtr + pos, compressedSize)
        audio.setSampleBank(0)
        pos += compressedSize
    }

    // -- 5. Song table → patterns → cues → playhead (full .taud / .tpif only) --
    // A .tsii carries no song table (numSongs = 0); it stops after the bank + Ixmp.
    if (!isSampleInst) {
    if (songIndex < 0 || songIndex >= numSongs) {
        sys.free(filePtr)
        throw Error("taud: songIndex " + songIndex + " out of range (numSongs=" + numSongs + ")")
    }

    // -- 5a. Parse song-table entry for the requested song -------------------
    let entryOff   = pos + songIndex * TAUD_SONG_ENTRY
    let songOffset = _peekU32LE(filePtr, entryOff)
    let numVoices  = sys.peek(filePtr + entryOff + 4) & 0xFF
    let numPatsLo  = sys.peek(filePtr + entryOff + 5) & 0xFF
    let numPatsHi  = sys.peek(filePtr + entryOff + 6) & 0xFF
    let bpmStored  = sys.peek(filePtr + entryOff + 7) & 0xFF
    let tickPacked = sys.peek(filePtr + entryOff + 8) & 0xFF
    let tickRate   = tickPacked & 0x7F            // bits 0..6
    bpmStored     |= (tickPacked & 0x80) << 1     // bit 7 of byte 8 = BPM high bit (0x100..0x1FE)
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
    }  // end !isSampleInst (song table / patterns / cues / playhead)

    // -- 9. Project Data — walk Ixmp blocks for multi-sample instruments -----
    // Runs for every kind: a .tsii carries its instruments' Ixmp patches here; a
    // .tpif carries only p/s blocks (sMet) and contributes no patches.
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
            // Patches are VARIABLE LENGTH (since 2026-06-13): a version byte (feature
            // bit-flags 0b x00Pfpvi) + 30 common bytes, then optional x/v/p/f/P blocks.
            const patchLen = (ver) => 31
                + ((ver & 0x80) ? 15 : 0)   // x: extra-base-info (u32 flags1 + u32 flags2 + u16 fadeout + u16 cutoff + u16 reson + u8 initialAttenuation octet)
                + ((ver & 0x02) ? 54 : 0)   // v: volume envelope
                + ((ver & 0x04) ? 54 : 0)   // p: panning envelope
                + ((ver & 0x08) ? 54 : 0)   // f: filter envelope
                + ((ver & 0x10) ? 54 : 0)   // P: pitch envelope
            let p = projOff + 16  // skip magic(8) + reserved(8)
            while (p + 8 <= fileSize) {
                const fc = String.fromCharCode(
                    sys.peek(filePtr + p)     & 0xFF, sys.peek(filePtr + p + 1) & 0xFF,
                    sys.peek(filePtr + p + 2) & 0xFF, sys.peek(filePtr + p + 3) & 0xFF)
                const secLen = _peekU32LE(filePtr, p + 4)
                const payload = p + 8
                if (payload + secLen > fileSize) break
                if (fc === 'Ixmp') {
                    // Each entry header is 4 bytes: byte0 = instId low 8, bytes1-2 = Uint16
                    // patchCount, byte3 = instId high (bit0 -> instId bit 8, the aux-bin
                    // $100..$1FF selector). byte3 was the old Uint24 count's top byte (always
                    // 0 for real counts) so legacy $00..$FF files still parse correctly.
                    let q = payload
                    const qEnd = payload + secLen
                    while (q + 4 <= qEnd) {
                        const idLo     = sys.peek(filePtr + q) & 0xFF; q++
                        const cntLo    = sys.peek(filePtr + q) & 0xFF; q++
                        const cntMid   = sys.peek(filePtr + q) & 0xFF; q++
                        const idHi     = sys.peek(filePtr + q) & 0xFF; q++
                        const instId   = idLo | ((idHi & 0x01) << 8)
                        const patchCnt = cntLo | (cntMid << 8)
                        // Walk the patches to find the blob length (each depends on its version byte).
                        let blobLen = 0, scan = q, ok = true
                        for (let i = 0; i < patchCnt; i++) {
                            if (scan + 31 > qEnd) { ok = false; break }
                            const len = patchLen(sys.peek(filePtr + scan) & 0xFF)
                            if (scan + len > qEnd) { ok = false; break }
                            scan += len; blobLen += len
                        }
                        if (!ok) break
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
 * @param meta    Optional song metadata to bake into the file. When omitted the
 *                output is byte-identical to the legacy behaviour (tracker-default
 *                tuning, no sMet). Recognised fields:
 *                  baseNote    Uint16 tuning base note (default 0xA000 / C9)
 *                  baseFreq    Float32 frequency at baseNote (default 8363.0)
 *                  projectName project name → PNam section
 *                  sMet        { notation, beatPri, beatSec, name, composer,
 *                                copyright } → sMet section for song 0
 *                The new-project flow (taut "create on missing file") passes this
 *                so the chosen notation / beat divisions / tuning persist.
 */
function captureTrackerDataToFile(outFile, meta) {
    const drive    = outFile[0].toUpperCase()
    const diskPath = outFile.substring(2)

    const memBase  = audio.getMemAddr()
    const baseAddr = audio.getBaseAddr()

    // -- 1. Compress sample+instrument bin ------------------------------------
    // The 8320 kB raw image (8 MB samples + 128 K instruments) cannot fit in the
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
    let bpmStored = Math.max(0, Math.min(0x1FE, bpm - 25))  // 9-bit (0..510 ⇒ BPM 25..535)
    let songGlobalVolume = audio.getSongGlobalVolume(0)
    let songMixingVolume = audio.getSongMixingVolume(0)
    if (songGlobalVolume === undefined || songGlobalVolume === null) songGlobalVolume = 0x80
    if (songMixingVolume === undefined || songMixingVolume === null) songMixingVolume = 0x80

    // Tuning (song table base note + frequency). Tracker default is C9 / 8363 Hz
    // unless `meta` overrides it (e.g. the new-project dialog's A4@440 choice).
    const baseNote  = (meta && meta.baseNote) ? (meta.baseNote & 0xFFFF) : 0xA000
    const baseFreqB = _f32leBytes((meta && meta.baseFreq > 0) ? meta.baseFreq : 8363.0)

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

    // -- 6.5 Build Ixmp project-data block (preserves multi-sample instruments)
    // Without this, saving a song whose instruments carry Ixmp patches (IT/XM
    // keyboard tables, SF2 imports) would silently collapse every instrument to
    // its base sample on the next load. Section format per terranmon.txt
    // §"Project Data" / §"Ixmp": magic(8) + reserved(8) + FourCC + Uint32 len +
    // repetition of { Uint8 instId-low, Uint16 count, Uint8 instId-high, patches }.
    // Slots 0..511: 0..255 = directly-addressable bin, 256..511 = aux bin (meta layers).
    let ixmpPayload = []
    for (let s = 0; s < 512; s++) {
        const cnt = audio.getInstrumentPatchCount(s)
        if (cnt <= 0) continue
        const blob = audio.getInstrumentPatches(s)   // flat variable-length patch bytes
        ixmpPayload.push(s & 0xFF, cnt & 0xFF, (cnt >>> 8) & 0xFF, (s >>> 8) & 0x01)
        for (let k = 0; k < blob.length; k++) ixmpPayload.push(blob[k] & 0xFF)
    }
    // Build the optional sMet payload (song 0 metadata) from `meta`. The sMet
    // SECTION payload is a concatenation of per-song sub-entries; here just one.
    // Sub-entry layout mirrors loadTaudSongList's reader:
    //   Uint8 songIndex, Uint32 subLen, then subLen bytes of
    //   { notation(u16) beatPri(u8) beatSec(u8) name\0 composer\0 copyright\0 }.
    let smetPayload = null
    if (meta && meta.sMet) {
        const m = meta.sMet
        const notation = (m.notation | 0) & 0xFFFF
        const sub = [ notation & 0xFF, (notation >>> 8) & 0xFF, (m.beatPri | 0) & 0xFF, (m.beatSec | 0) & 0xFF ]
            .concat(_strBytesNul(m.name))
            .concat(_strBytesNul(m.composer))
            .concat(_strBytesNul(m.copyright))
        smetPayload = [ 0, sub.length & 0xFF, (sub.length >>> 8) & 0xFF, (sub.length >>> 16) & 0xFF, (sub.length >>> 24) & 0xFF ]
            .concat(sub)
    }

    // Assemble the Project Data sections. Ixmp (multi-sample instruments) is
    // emitted when present; sMet / PNam only when `meta` supplies them. The block
    // header (magic + reserved) is written only when at least one section exists,
    // so a legacy capture with no Ixmp/meta still produces projOff = 0.
    const _sections = []
    if (ixmpPayload.length > 0)    _sections.push({ fourcc: [0x49,0x78,0x6D,0x70], payload: ixmpPayload })  // 'Ixmp'
    if (smetPayload)               _sections.push({ fourcc: [0x73,0x4D,0x65,0x74], payload: smetPayload })  // 'sMet'
    if (meta && meta.projectName)  _sections.push({ fourcc: [0x50,0x4E,0x61,0x6D], payload: _strBytesNul(meta.projectName) })  // 'PNam'

    let projData = []
    let projOff  = 0
    if (_sections.length > 0) {
        projData = [
            0x1E, 0x54, 0x61, 0x75, 0x64, 0x50, 0x72, 0x4A,   // \x1ETaudPrJ
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,   // reserved
        ]
        for (const sec of _sections) {
            const L = sec.payload.length
            projData.push(sec.fourcc[0], sec.fourcc[1], sec.fourcc[2], sec.fourcc[3],
                          L & 0xFF, (L >>> 8) & 0xFF, (L >>> 16) & 0xFF, (L >>> 24) & 0xFF)
            for (let k = 0; k < L; k++) projData.push(sec.payload[k] & 0xFF)
        }
        projOff = songOffset + patCompSize + cueCompSize
    }

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
        // project data offset (4) -- zero when no Ixmp/etc. to carry
        (projOff        ) & 0xFF,
        (projOff >>>  8) & 0xFF,
        (projOff >>> 16) & 0xFF,
        (projOff >>> 24) & 0xFF,
    ].concat(sigBytes)  // 8 + 2 + 4 + 4 + 14 = 32 bytes

    // -- 8. Build song-table row (32 bytes) -----------------------------------
    let songTable = [
        (songOffset        ) & 0xFF,
        (songOffset >>>  8) & 0xFF,
        (songOffset >>> 16) & 0xFF,
        (songOffset >>> 24) & 0xFF,
        20,                                    // numVoices
        numPats & 0xFF, (numPats >>> 8) & 0xFF, // numPatterns Uint16 LE
        bpmStored & 0xFF,                      // BPM with −25 bias (low 8 bits)
        (((bpmStored >> 8) & 1) << 7) | (tickRate & 0x7F),  // bit 7 = BPM high bit; bits 0..6 = tick-rate
        baseNote & 0xFF, (baseNote >>> 8) & 0xFF,  // basenote (Uint16 LE; default 0xA000 -- C9)
        baseFreqB[0], baseFreqB[1], baseFreqB[2], baseFreqB[3],  // basefreq (Float32 LE; default 8363 Hz)
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

    // -- 9. Write the file (header truncates/creates; the rest is appended) ----
    // The sections are laid out strictly sequentially (header → sample+inst →
    // song table → pattern bin → cue sheet → project data), so we write the
    // header with bwrite (truncate) and APPEND everything after it. This avoids
    // pwrite-with-offset, which serial-attached disk drives (the boot drive's
    // SERIAL driver) reject — captureTrackerDataToFile must work on those too.
    // The stored projOff / songOffset stay valid because the append order
    // reproduces the exact offsets they were computed from.
    const fileHandle = files.open(outFile)
    fileHandle.bwrite(header)

    // -- 10. Append compressed sample+inst bin --------------------------------
    fileHandle.pappend(compBuf, compressedSize)
    sys.free(compBuf)

    // -- 11. Append song table ------------------------------------------------
    fileHandle.bappend(songTable)

    // -- 12. Append compressed pattern bin ------------------------------------
    fileHandle.pappend(patCompBuf, patCompSize)
    sys.free(patCompBuf)

    // -- 13. Append compressed cue sheet --------------------------------------
    fileHandle.pappend(cueCompBuf, cueCompSize)
    sys.free(cueCompBuf)

    // -- 14. Append project data (Ixmp / sMet / PNam) at projOff --------------
    if (projData.length > 0) {
        let projBuf = sys.malloc(projData.length)
        for (let k = 0; k < projData.length; k++) sys.poke(projBuf + k, projData[k])
        fileHandle.pappend(projBuf, projData.length)
        sys.free(projBuf)
    }

    fileHandle.flush(); fileHandle.close()
}

// ── Interrupt-note callbacks ──────────────────────────────────────────────────
//
// Taud reserves 16 "interrupt notes" — Int0..IntF, the note words 0x0010..0x001F
// (terranmon.txt §Play Data). They produce no sound; they are sync markers a song
// can sprinkle through its patterns so a host program reacts to the music (trigger a
// visual, swap a sample, advance a script…). The engine has no built-in behaviour
// for them: when one is encountered during playback it merely latches the interrupt
// number in the adapter (AudioAdapter TrackerState.pendingInterrupts). A program
// registers JS callbacks here, and the engine "plays" each interrupt by invoking its
// callbacks when `pollInterrupts` next drains the latch.
//
// WHY POLLING: a JS module cannot be called from the native audio render thread, so
// the firings are accumulated in a per-playhead latch and dispatched from the
// program's own loop. Call `pollInterrupts(playhead)` once per frame; the latch
// accumulates between calls, so no interrupt is ever missed (repeated fires of the
// SAME interrupt between two polls collapse into a single callback invocation —
// edge-triggered, level-collapsed).
//
// Usage:
//     const taud = require("taud")
//     taud.uploadTaudFile("A:/music/song.taud", 0, PLAYHEAD)
//     taud.attachIntCallback(PLAYHEAD, 0, () => triggerStrobe())
//     audio.play(PLAYHEAD)
//     while (audio.isPlaying(PLAYHEAD)) {
//         taud.pollInterrupts(PLAYHEAD)   // fires any callbacks for interrupts hit this frame
//         ...draw a frame...
//     }

const NUM_INTERRUPTS = 16

// _intCallbacks[playhead] -> Array(16) where each slot is an Array<fn> or null.
const _intCallbacks = {}

function _ensurePh(playhead) {
    let ph = _intCallbacks[playhead]
    if (!ph) {
        ph = new Array(NUM_INTERRUPTS).fill(null)
        _intCallbacks[playhead] = ph
        // Drop any interrupts latched before the FIRST callback was attached so stale
        // pre-registration fires don't spuriously trigger the new callback on the next poll.
        if (typeof audio.pollTrackerInterrupts === "function") audio.pollTrackerInterrupts(playhead)
    }
    return ph
}

/**
 * Register `callback` to fire when interrupt note `intNum` (0..15 → Int0..IntF, note
 * words 0x0010..0x001F) is encountered on `playhead` during playback. Multiple
 * callbacks may share one interrupt; they fire in registration order. The callback is
 * invoked as `callback(intNum, playhead)`. Returns `callback` (use it with
 * `removeIntCallback`). Callbacks only fire while the program drives `pollInterrupts`.
 */
function attachIntCallback(playhead, intNum, callback) {
    if (typeof callback !== "function") throw Error("taud: interrupt callback must be a function")
    if (intNum < 0 || intNum >= NUM_INTERRUPTS) throw Error("taud: intNum out of range (0..15): " + intNum)
    const ph = _ensurePh(playhead)
    if (!ph[intNum]) ph[intNum] = []
    ph[intNum].push(callback)
    return callback
}

/**
 * Remove a single `callback` previously attached to interrupt `intNum` on `playhead`.
 * Returns true if a matching callback was found and removed, false otherwise.
 */
function removeIntCallback(playhead, intNum, callback) {
    const ph = _intCallbacks[playhead]
    if (!ph || intNum < 0 || intNum >= NUM_INTERRUPTS || !ph[intNum]) return false
    const list = ph[intNum]
    const i = list.indexOf(callback)
    if (i < 0) return false
    list.splice(i, 1)
    if (list.length === 0) ph[intNum] = null
    return true
}

/**
 * Remove interrupt callbacks in bulk:
 *   removeAllIntCallback()                  → every callback on every playhead
 *   removeAllIntCallback(playhead)          → every interrupt on that playhead
 *   removeAllIntCallback(playhead, intNum)  → every callback on that one interrupt slot
 */
function removeAllIntCallback(playhead, intNum) {
    if (playhead === undefined) {
        for (const k in _intCallbacks) delete _intCallbacks[k]
        return
    }
    const ph = _intCallbacks[playhead]
    if (!ph) return
    if (intNum === undefined) { delete _intCallbacks[playhead]; return }
    if (intNum >= 0 && intNum < NUM_INTERRUPTS) ph[intNum] = null
}

/**
 * Drain `playhead`'s pending interrupt latch and invoke the registered callbacks for
 * every interrupt that fired since the last call. Call this once per frame from the
 * player's main loop. Returns the 16-bit mask of interrupts that fired (bit n = IntN),
 * or 0 when none fired. No-op — and skips the hardware read entirely — when nothing is
 * attached to `playhead`, so the common "no interrupts wanted" path costs nothing. A
 * throwing callback is isolated: it neither aborts the poll nor stops sibling callbacks.
 */
function pollInterrupts(playhead) {
    const ph = _intCallbacks[playhead]
    if (!ph) return 0
    const mask = (audio.pollTrackerInterrupts(playhead) | 0) & 0xFFFF
    if (mask === 0) return 0
    for (let n = 0; n < NUM_INTERRUPTS; n++) {
        if ((mask & (1 << n)) === 0) continue
        const list = ph[n]
        if (!list) continue
        // Iterate a snapshot so a callback may safely attach/detach during dispatch.
        const snapshot = list.slice()
        for (let i = 0; i < snapshot.length; i++) {
            try { snapshot[i](n, playhead) }
            catch (e) { /* a faulty callback must not break the play loop or its siblings */ }
        }
    }
    return mask
}

exports = {
    uploadTaudFile, captureTrackerDataToFile,
    attachIntCallback, removeIntCallback, removeAllIntCallback, pollInterrupts,
}
