/**
 * LibPSG — PSG emulator and mixer for TSVM
 * Software-mixes various PSG channels and sends them to sound device as PCM
 * @author CuriousTorvald
 */

const HW_SAMPLING_RATE = 32000

function clamp(val, low, hi) { return (val < low) ? low : (val > hi) ? hi : val }
function clampS16(i) { return clamp(i, -32768, 32767) }
const uNybToSnyb = [0,1,2,3,4,5,6,7,-8,-7,-6,-5,-4,-3,-2,-1]
// returns: [unsigned high, unsigned low, signed high, signed low]
function getNybbles(b) { return [b >> 4, b & 15, uNybToSnyb[b >> 4], uNybToSnyb[b & 15]] }
function s8Tou8(i) { return i + 128 }
function s16Tou8(i) {
//    return s8Tou8((i >> 8) & 255)
    // apply dithering
    let ufval = (i / 65536.0) + 0.5
    let ival = randomRound(ufval * 255.0)
    return ival|0
}
function u16Tos16(i) { return (i > 32767) ? i - 65536 : i }
function randomRound(k) {
    let rnd = Math.random() // note to self: no triangular here
    return (rnd < (k - (k|0))) ? Math.ceil(k) : Math.floor(k)
}
function lerp(start, end, x) {
    return (1 - x) * start + x * end
}
function lerpAndRound(start, end, x) {
    return Math.round(lerp(start, end, x))
}



// output format: immediately uploadable into TSVM audio adapter

// ── Internal helpers ────────────────────────────────────────────────────────

function secToSamples(sec) { return Math.round(HW_SAMPLING_RATE * sec) }

function isNative(buf) { return buf.native }

function readU8(buf, ch, i) {
    return isNative(buf) ? (sys.peek(buf[ch] + i) & 255) : buf[ch][i]
}
function writeU8(buf, ch, i, v) {
    if (isNative(buf)) sys.poke(buf[ch] + i, v)
    else buf[ch][i] = v
}

// ── Buffer management ───────────────────────────────────────────────────────

function makeBuffer(length) {
    // returns [Uint8Array, Uint8Array] (stereo) that will be used to collect samples made by LibPSG.
    // Length: seconds. Number of elements: round(HW_SAMPLING_RATE * length)
    const n = secToSamples(length)
    const L = new Uint8Array(n)
    const R = new Uint8Array(n)
    L.fill(128)
    R.fill(128)
    return { 0: L, 1: R, samples: n, native: false }
}

function makeBufferNative(length) {
    // returns native buffer object (stereo) that will be used to collect samples made by LibPSG.
    // Length: seconds. Number of elements: round(HW_SAMPLING_RATE * length)
    // Free with freeBufferNative() when done.
    const n = secToSamples(length)
    const L = sys.malloc(n); sys.memset(L, 128, n)
    const R = sys.malloc(n); sys.memset(R, 128, n)
    return { 0: L, 1: R, samples: n, native: true }
}

function freeBufferNative(buf) {
    sys.free(buf[0])
    sys.free(buf[1])
}

function clearBuffer(buf, offsetSec, lengthSec) {
    // Re-silence a buffer region (fill with 128) for re-use across frames.
    const start = (offsetSec != null) ? secToSamples(offsetSec) : 0
    const total = (lengthSec != null) ? secToSamples(lengthSec) : (buf.samples - start)
    for (let i = 0; i < total; i++) {
        writeU8(buf, 0, start + i, 128)
        writeU8(buf, 1, start + i, 128)
    }
}

// ── Shared mix core ─────────────────────────────────────────────────────────

// sampleFn(i) must return a float in [-1, 1].
// Mixing maths: decode u8 → s16, apply op, clamp, dither back to u8.
function mixInto(buf, lengthSec, offsetSec, op, amp, pan, sampleFn) {
    const startIdx = secToSamples(offsetSec)
    const n = secToSamples(lengthSec)
    // Linear pan law: centre (pan=0) → both channels at full amp
    const gainL = Math.max(0, Math.min(1, 1.0 - pan))
    const gainR = Math.max(0, Math.min(1, 1.0 + pan))
    const opCode = (op === 'sub') ? 1 : (op === 'mul') ? 2 : 0  // default: add
    for (let i = 0; i < n; i++) {
        const v = sampleFn(i)           // oscillator value in [-1, 1]
        const oscBase = v * amp * 32767
        const oscL = Math.round(oscBase * gainL) | 0
        const oscR = Math.round(oscBase * gainR) | 0
        for (let ch = 0; ch < 2; ch++) {
            const osc = (ch === 0) ? oscL : oscR
            const cur = (readU8(buf, ch, startIdx + i) - 128) << 8
            let out
            switch (opCode) {
                case 0: out = cur + osc; break
                case 1: out = cur - osc; break
                case 2: out = (cur * osc) >> 15; break
            }
            writeU8(buf, ch, startIdx + i, s16Tou8(clampS16(out)))
        }
    }
}

// ── Waveform generators ─────────────────────────────────────────────────────

function makeSquare(buf, length, offset, freq, duty, op, amp, pan, phaseOffset) {
    // buffer: [Uint8Array, Uint8Array] or native buffer
    // length: in seconds
    // offset: in seconds
    // duty: 0.0 to 1.0. default 0.5 (fraction of period where output is +1)
    // freq: Hz
    // op: add / mul / sub; default: add
    // amp: 0.0 to 1.0; default: 0.5
    // pan: -1.0 to 1.0; default: 0.0
    // phaseOffset: optional absolute-time base (seconds) added to phase calc only,
    //              not to the buffer write position — use to ensure phase continuity
    //              across successive calls (e.g. frame boundaries).
    if (duty == null) duty = 0.5
    if (op   == null) op   = 'add'
    if (amp  == null) amp  = 0.5
    if (pan  == null) pan  = 0.0
    const tBase = (phaseOffset || 0) + offset
    mixInto(buf, length, offset, op, amp, pan, function(i) {
        const phase = ((tBase + i / HW_SAMPLING_RATE) * freq) % 1
        return (phase < duty) ? 1.0 : -1.0
    })
}

function makeTriangle(buf, length, offset, freq, duty, op, amp, pan) {
    // buffer: [Uint8Array, Uint8Array] or native buffer
    // length: in seconds
    // offset: in seconds
    // duty: skew. -1.0 = falling sawtooth, 0.0 = symmetric triangle, 1.0 = rising sawtooth
    // freq: Hz
    // op: add / mul / sub; default: add
    // amp: 0.0 to 1.0; default: 0.5
    // pan: -1.0 to 1.0; default: 0.0
    if (duty == null) duty = 0.0
    if (op   == null) op   = 'add'
    if (amp  == null) amp  = 0.5
    if (pan  == null) pan  = 0.0
    // riseFrac: fraction of period spent rising from -1 to +1
    // 0.0 → falling saw, 0.5 → symmetric triangle, 1.0 → rising saw
    const riseFrac = (duty + 1.0) * 0.5
    mixInto(buf, length, offset, op, amp, pan, function(i) {
        const t = offset + i / HW_SAMPLING_RATE
        const phase = (t * freq) % 1
        if (riseFrac <= 0) {
            return 1.0 - 2.0 * phase                               // falling saw
        } else if (riseFrac >= 1) {
            return -1.0 + 2.0 * phase                              // rising saw
        } else if (phase < riseFrac) {
            return -1.0 + 2.0 * (phase / riseFrac)                 // rising slope
        } else {
            return 1.0 - 2.0 * ((phase - riseFrac) / (1.0 - riseFrac)) // falling slope
        }
    })
}

function makeAliasedTriangle(buf, length, offset, freq, duty, op, amp, pan) {
    // buffer: [Uint8Array, Uint8Array] or native buffer
    // Famicom-style triangle — output is quantised to 16 DAC levels (4-bit, NES APU style).
    // The staircase quantisation introduces harmonics that mimic NES character.
    // length: in seconds
    // offset: in seconds
    // duty: skew. -1.0 = falling sawtooth, 0.0 = symmetric triangle, 1.0 = rising sawtooth
    // freq: Hz
    // op: add / mul / sub; default: add
    // amp: 0.0 to 1.0; default: 0.5
    // pan: -1.0 to 1.0; default: 0.0
    if (duty == null) duty = 0.0
    if (op   == null) op   = 'add'
    if (amp  == null) amp  = 0.5
    if (pan  == null) pan  = 0.0
    const riseFrac = (duty + 1.0) * 0.5
    mixInto(buf, length, offset, op, amp, pan, function(i) {
        const t = offset + i / HW_SAMPLING_RATE
        const phase = (t * freq) % 1
        let v
        if (riseFrac <= 0) {
            v = 1.0 - 2.0 * phase
        } else if (riseFrac >= 1) {
            v = -1.0 + 2.0 * phase
        } else if (phase < riseFrac) {
            v = -1.0 + 2.0 * (phase / riseFrac)
        } else {
            v = 1.0 - 2.0 * ((phase - riseFrac) / (1.0 - riseFrac))
        }
        // Quantise to 16 levels (NES triangle 4-bit DAC: 0..15 → -1..+1)
        const level = Math.max(0, Math.min(15, Math.round((v + 1.0) * 7.5)))
        return level / 7.5 - 1.0
    })
}

// ── LFSR helpers (for noise types 1 and 2) ─────────────────────────────────

function lfsrStep(state, mode) {
    // mode 0 (long/NES mode 0): feedback tap at bit 1; period 32767
    // mode 1 (short/NES mode 1): feedback tap at bit 6; period 93 (metallic/tonal)
    const bit0   = state & 1
    const bitTap = (mode === 0) ? (state >> 1) & 1 : (state >> 6) & 1
    const feed   = bit0 ^ bitTap
    return ((feed << 14) | (state >> 1)) & 0x7FFF
}

function lfsrAdvance(state, steps, mode) {
    for (let k = 0; k < steps; k++) state = lfsrStep(state, mode)
    return state
}

// NES APU documented LFSR periods
const LFSR_PERIOD_LONG  = 32767  // mode 0
const LFSR_PERIOD_SHORT = 93     // mode 1

function makeNoise(buf, length, offset, freq, type, op, amp, pan, phaseOffset) {
    // buffer: [Uint8Array, Uint8Array] or native buffer
    // length: in seconds
    // offset: in seconds
    // type:
    //   -1: 8-bit white noise (random float per period, sample-and-hold)
    //    0: 1-bit white noise (random ±1 per period, sample-and-hold)
    //    1: 1-bit LFSR long mode  — NES mode 0, tap=bit0^bit1, period 32767 (full-spectrum)
    //    2: 1-bit LFSR short mode — NES mode 1, tap=bit0^bit6, period 93 (metallic/tonal)
    // freq: Hz (clock rate of the noise generator)
    // op: add / mul / sub; default: add
    // amp: 0.0 to 1.0; default: 0.5
    // pan: -1.0 to 1.0; default: 0.0
    // phaseOffset: optional absolute-time base (seconds) added to phase/LFSR calc only —
    //              see makeSquare for details.
    //
    // LFSR types (1 and 2) are deterministic given (phaseOffset+offset, freq): calling
    // with monotonically advancing phaseOffset+offset produces a seamless noise stream
    // across frames. White noise types (-1, 0) are random per call.
    if (op  == null) op  = 'add'
    if (amp == null) amp = 0.5
    if (pan == null) pan = 0.0
    const tBase = (phaseOffset || 0) + offset

    if (type === -1) {
        // 8-bit white: new random float in [-1, 1] each clock period
        let prevClock = -1
        let noiseVal = 0.0
        mixInto(buf, length, offset, op, amp, pan, function(i) {
            const currentClock = Math.floor((tBase + i / HW_SAMPLING_RATE) * freq) | 0
            if (currentClock !== prevClock) {
                prevClock = currentClock
                noiseVal = Math.random() * 2.0 - 1.0
            }
            return noiseVal
        })
    } else if (type === 0) {
        // 1-bit white: random ±1 each clock period
        let prevClock = -1
        let noiseVal = 1.0
        mixInto(buf, length, offset, op, amp, pan, function(i) {
            const currentClock = Math.floor((tBase + i / HW_SAMPLING_RATE) * freq) | 0
            if (currentClock !== prevClock) {
                prevClock = currentClock
                noiseVal = (Math.random() >= 0.5) ? 1.0 : -1.0
            }
            return noiseVal
        })
    } else {
        // LFSR-based noise (types 1 and 2)
        const mode   = (type === 2) ? 1 : 0
        const period = (mode === 0) ? LFSR_PERIOD_LONG : LFSR_PERIOD_SHORT
        // Advance to deterministic position for this tBase so consecutive frame
        // calls with monotonically advancing phaseOffset produce a seamless noise stream.
        const startClock = Math.floor(tBase * freq) | 0
        let lfsr      = lfsrAdvance(1, startClock % period, mode)
        let prevClock = startClock
        mixInto(buf, length, offset, op, amp, pan, function(i) {
            const currentClock = Math.floor((tBase + i / HW_SAMPLING_RATE) * freq) | 0
            const delta = currentClock - prevClock
            if (delta > 0) {
                const steps = delta % period
                if (steps > 0) lfsr = lfsrAdvance(lfsr, steps, mode)
                prevClock = currentClock
            }
            return (lfsr & 1) ? 1.0 : -1.0
        })
    }
}

function makeAliasedTriangleNES(buf, length, offset, freq, duty, op, amp, pan, phaseOffset) {
    // NES APU triangle — quantised to the authentic 32-step, 4-bit (0..15) staircase.
    // The 32-step sequence is: 15,14,...,1,0, 0,1,...,14,15 (descending then ascending).
    // This mirrors the real NES triangle DAC which has 32 equal-height steps per period.
    // duty parameter is accepted for API symmetry but ignored (NES triangle is always symmetric).
    // phaseOffset: optional absolute-time base (seconds) — see makeSquare for details.
    if (op  == null) op  = 'add'
    if (amp == null) amp = 0.5
    if (pan == null) pan = 0.0
    const tBase = (phaseOffset || 0) + offset
    mixInto(buf, length, offset, op, amp, pan, function(i) {
        const phase = ((tBase + i / HW_SAMPLING_RATE) * freq) % 1
        const step32 = Math.floor(phase * 32) | 0  // 0..31
        // step 0..15: descend from 15 to 0; step 16..31: ascend from 0 to 15
        const level = (step32 < 16) ? (15 - step32) : (step32 - 16)
        return level / 7.5 - 1.0  // map 0..15 → -1..+1
    })
}

// ── Send to audio hardware ──────────────────────────────────────────────────

function sendBuffer(buf, playhead, offsetSec, lengthSec, stagingPtr) {
    // Interleaves the L and R channels into a staging region (LRLRLR…) and uploads
    // to the audio adapter pcmBin via the standard putPcmDataByPtr pipeline.
    //
    // offsetSec:  start of region to send (default: 0)
    // lengthSec:  duration to send (default: entire buffer from offsetSec)
    // stagingPtr: optional caller-owned native buffer (≥ min(chunk, 32768) * 2 bytes).
    //             Pass a pre-allocated pointer to avoid malloc/free per call —
    //             useful for the per-frame tvnes pattern.
    //
    // The function auto-chunks at 32768 stereo samples (pcmBin capacity).
    // Blocks briefly if the audio queue is saturated (queue depth > 2).
    const start = (offsetSec != null) ? secToSamples(offsetSec) : 0
    const total = (lengthSec != null) ? secToSamples(lengthSec) : (buf.samples - start)
    const MAX_CHUNK = 32768  // pcmBin = 65536 bytes; stereo → max 32768 samples per upload
    const ownsStaging = (stagingPtr == null)
    if (ownsStaging) stagingPtr = sys.malloc(Math.min(total, MAX_CHUNK) * 2)

    let remaining = total
    let cursor    = start
    while (remaining > 0) {
        const take = Math.min(remaining, MAX_CHUNK)
        // Interleave L, R into staging buffer
        for (let i = 0; i < take; i++) {
            sys.poke(stagingPtr + 2 * i,     readU8(buf, 0, cursor + i))
            sys.poke(stagingPtr + 2 * i + 1, readU8(buf, 1, cursor + i))
        }
        // Wait for room in the playback queue (mirrors playwav.js idiom)
        // while (audio.getPosition(playhead) > 2) sys.sleep(2)
        audio.putPcmDataByPtr(playhead, stagingPtr, take * 2, 0)
        audio.setSampleUploadLength(playhead, take * 2)
        audio.startSampleUpload(playhead)
        remaining -= take
        cursor    += take
    }

    if (ownsStaging) sys.free(stagingPtr)
}

// Lazily-allocated JS-side interleave scratch; shared across sendBufferFast calls.
let _sendFastScratch = null

function sendBufferFast(buf, playhead, offsetSec, lengthSec, stagingPtr) {
    // Like sendBuffer but interleaves L/R via a JS Uint8Array + one sys.pokeBytes per chunk,
    // instead of ~2n sys.poke calls.  Requires a non-native (JS-backed) buffer.
    // Falls back to sendBuffer for native buffers.
    if (isNative(buf)) { sendBuffer(buf, playhead, offsetSec, lengthSec, stagingPtr); return }

    const start = (offsetSec != null) ? secToSamples(offsetSec) : 0
    const total = (lengthSec != null) ? secToSamples(lengthSec) : (buf.samples - start)
    const MAX_CHUNK = 32768
    const ownsStaging = (stagingPtr == null)
    if (ownsStaging) stagingPtr = sys.malloc(Math.min(total, MAX_CHUNK) * 2)

    const scratchNeeded = Math.min(total, MAX_CHUNK) * 2
    if (_sendFastScratch == null || _sendFastScratch.length < scratchNeeded) {
        _sendFastScratch = new Uint8Array(scratchNeeded)
    }

    let remaining = total
    let cursor    = start
    while (remaining > 0) {
        const take = Math.min(remaining, MAX_CHUNK)
        const L = buf[0], R = buf[1], sc = _sendFastScratch
        for (let i = 0; i < take; i++) {
            sc[2 * i]     = L[cursor + i]
            sc[2 * i + 1] = R[cursor + i]
        }
        sys.pokeBytes(stagingPtr, sc.subarray(0, take * 2), take * 2)
        // while (audio.getPosition(playhead) > 2) sys.sleep(2)
        audio.putPcmDataByPtr(playhead, stagingPtr, take * 2, 0)
        audio.setSampleUploadLength(playhead, take * 2)
        audio.startSampleUpload(playhead)
        remaining -= take
        cursor    += take
    }

    if (ownsStaging) sys.free(stagingPtr)
}

exports = {
    HW_SAMPLING_RATE,
    makeBuffer, makeBufferNative, freeBufferNative, clearBuffer,
    makeSquare, makeTriangle, makeAliasedTriangle, makeAliasedTriangleNES, makeNoise,
    sendBuffer, sendBufferFast
}
