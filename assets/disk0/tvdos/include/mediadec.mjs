/*
 * mediadec.mjs — the all-in-one media-decoding library for TVDOS movie players.
 *
 * One simple public API, three internal backends (iPF/MOV, TEV, TAV/TAP),
 * sharing the front-end utilities in mediadec_common.mjs.  Used by playmov.js.
 *
 *   const mediadec = require("mediadec")
 *   const dec = mediadec.open("A:\\film.tav", { interactive: true })
 *   while (true) {
 *       const ev = dec.step()              // [backend] decode the next due frame
 *       if (ev.type === 'eof') break
 *       if (ev.type !== 'frame') { sys.sleep(1); continue }
 *       dec.blit()                         // [draw] copy the frame to the screen
 *       // ...or in ASCII mode: dec.blit(); dec.sampleGray(buf,w,h); aa.render/flush
 *   }
 *   dec.close()
 *
 * The decoder object every backend returns exposes a uniform interface:
 *   .info {format,width,height,fps,totalFrames,hasAudio,hasSubtitles,
 *          isInterlaced,colourSpace,graphicsMode,isStill}
 *   .step()                 -> { type:'frame'|'idle'|'eof'|'newfile'|'error', frameCount }
 *   .blit()                 present the current native frame to the screen
 *   .sampleGray(dst,w,h)    fill an ASCII brightness buffer from the framebuffer
 *   .sampleColour(dst,w,h)  fill a per-cell RGB buffer (w*h*3) from the framebuffer
 *   .subtitle {visible,text,position,useUnicode,dirty}  (resolved by the lib)
 *   .pause(b)/.isPaused() .setVolume(v)/.getVolume()
 *   .seekSeconds(n) .cue(d) .cues
 *   .frameCount .currentTimecodeNs .videoRate .frameMode [.qY/.qCo/.qCg]
 *   .close()
 */

// NOTE: every require() below is deliberately made at call time (inside open()),
// never at module top level.  TVDOS's require() loads a module by eval()-ing it,
// and requiring one module *while another module is still being eval()-ed* nests
// the evals — which can collide on the loader's `let exports` binding and throw
// "Identifier 'exports' has already been declared" at load, breaking every file.
// Keeping requires at runtime means each is a single, non-nested eval.

// Open a movie file: sniff the magic, then hand off to the matching backend.
// `opts` (all optional): interactive, debugMotionVectors, enableDeblocking,
// enableBoundaryAwareDecoding, deinterlaceAlgorithm, filmGrainLevel.
function open(fullPathStr, opts) {
    opts = opts || {}

    const common = require("mediadec_common")

    // IMPORTANT: query the file size via files.open() BEFORE preparing seqread.
    // On the real disk driver both share the drive's serial port, so a files.open()
    // *after* seqread.prepare() clobbers the read position and the first readBytes()
    // returns driver leftovers (the size as an ASCII string) instead of the file's
    // bytes — which made every file fail the magic check. Every original player
    // reads the size first, then prepares seqread.
    const fileLength = files.open(fullPathStr).size
    const sr = common.openSeqread(fullPathStr)
    const magic = common.readMagic(sr)
    const fmt = common.detectFormat(magic)

    con.clear()
    con.curs_set(0)

    switch (fmt) {
        case 'mov': return require("mediadec_ipf").create(magic, sr, fileLength, opts, common)
        case 'tev': return require("mediadec_tev").create(magic, sr, fileLength, opts, common)
        case 'tav': return require("mediadec_tav").create(magic, sr, fileLength, opts, common, false)
        case 'tap': return require("mediadec_tav").create(magic, sr, fileLength, opts, common, true)
        case 'ucf':
            throw Error("UCF cue files are not directly playable; play the TAV stream they index")
        default:
            throw Error("Unrecognised movie file (magic: " + magic.map(b => b.toString(16)).join(' ') + ")")
    }
}

exports = {
    open: open,
    // Lazy require so this module never requires another at load time (see note above).
    detectFormat: function (magic) { return require("mediadec_common").detectFormat(magic) }
}
