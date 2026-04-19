// Tracker Mode — Bach's Prelude in C Major (BWV 846)
// Run from the TVDOS shell: js tracker_test.js
// Uploads ~92 patterns on startup (takes a moment).

// -- Note table (12-TET, 4096-TET encoding) ------------------------------------
// C3 = 0x4000; each semitone = 4096/12 ≈ 341.33 steps; each octave = 4096 steps.
// Sharp suffix: s (e.g. Cs3); flat aliases also provided (e.g. Db3 = Cs3).
// Special values: Note.OFF = key-off, Note.CUT = note cut, Note.NOP = no-op.
var Note = (function() {
    var SEMITONE = 4096 / 12;
    var C3 = 0x4000;
    function n(oct, semi) { return Math.round(C3 + (oct - 3) * 4096 + semi * SEMITONE) & 0xFFFF; }
    var t = {};
    var names = ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
    var flats  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
    for (var oct = 0; oct <= 9; oct++) {
        for (var s = 0; s < 12; s++) {
            t[names[s] + oct] = n(oct, s);
            if (flats[s] !== names[s]) t[flats[s] + oct] = n(oct, s);
        }
    }
    t.OFF = 0x0000;   // key-off
    t.CUT = 0xFFFE;   // note cut (immediate)
    t.NOP = 0xFFFF;   // no-op (empty row)
    return t;
}());

var PLAYHEAD = 0;

// -- 1. Sample: triangle wave (256 samples @ C3) --------------------------------
var SAMPLE_LEN = 256;
var sampleBytes = new Array(SAMPLE_LEN);
for (var i = 0; i < SAMPLE_LEN; i++) {
    var phase = (i / SAMPLE_LEN) * 2.0;
    var val_ = phase < 1.0 ? phase : 2.0 - phase;
    sampleBytes[i] = Math.round(val_ * 254) & 0xFF;
}
var memBase = audio.getMemAddr();
for (var i = 0; i < SAMPLE_LEN; i++) {
    sys.poke(memBase - i, sampleBytes[i]);
}

// -- 2. Instrument 0 -----------------------------------------------------------
var instBytes = new Array(64).fill(0);
instBytes[2] = 0; instBytes[3] = 1;        // sampleLength = 256
instBytes[4] = 0x00; instBytes[5] = 0x7D;  // samplingRate = 32000
instBytes[10] = 0x00; instBytes[11] = 0x01;  // sampleLoopEnd = 256 (whole sample)
instBytes[12] = 1;                           // loopMode = 1 (forward)
instBytes[16] = 255; instBytes[17] = 0;     // envelope: vol=255, hold
audio.uploadInstrument(1, instBytes);

// -- 3. Piano-roll builder -----------------------------------------------------
// Source convention: C1=0, C2=12, C3=24, C4=36 (i.e. C3=24, octave every 12).
function midiToTsvm(n) {
    var oct = Math.floor(n / 12) + 1;
    return Math.round(0x3000 + oct * 4096 + (n % 12) * (4096 / 12)) & 0xFFFF;
}

var noteMap = {};  // absRow → TSVM note value
var rowCursor = 0;

function seq(notes, lens) {
    for (var i = 0; i < notes.length; i++) {
        noteMap[rowCursor] = midiToTsvm(notes[i]);
        rowCursor += lens[i];
    }
}

var TD = 3;  // rows per note step (= source TICK_DIVISOR)

function prel(n1, n2, n3, n4, n5) {
    seq([n1, n2, n3, n4, n5, n3, n4, n5, n1, n2, n3, n4, n5, n3, n4, n5],
        [TD+2, TD, TD, TD-1, TD, TD, TD, TD, TD, TD, TD, TD-1, TD, TD, TD, TD]);
}
function end1(n1,n2,n3,n4,n5,n6,n7,n8,n9) {
    seq([n1, n2, n3, n4, n5, n6, n5, n4, n5, n7, n8, n7, n8, n9, n8, n9],
        [TD+2, TD, TD, TD-1, TD, TD, TD, TD, TD, TD, TD, TD-1, TD, TD, TD, TD]);
}
function end2(n1,n2,n3,n4,n5,n6,n7,n8,n9) {
    seq([n1, n2, n3, n4, n5, n6, n5, n4, n5, n4, n3, n4, n7, n8, n9, n7],
        [TD+2, TD+1, TD+1, TD+1, TD+1, TD+2, TD+2, TD+2,
         TD+3, TD+3, TD+4, TD+4, TD+6, TD+8, TD+12, TD+24]);
}
function end3(ns) {
    for (var i = 0; i < ns.length; i++) {
        noteMap[rowCursor] = midiToTsvm(ns[i]);
        rowCursor += 1;
    }
    for (var i = 0; i < TD*2; i++) {
        noteMap[rowCursor] = Note.NOP
        rowCursor += 1;
    }
}

// -- 4. Build the piece --------------------------------------------------------
rowCursor = 16 * TD;  // 160-row intro silence

prel(24,28,31,36,40);
prel(24,26,33,38,41);
prel(23,26,31,38,41);
prel(24,28,31,36,40);
prel(24,28,33,40,45);
prel(24,26,30,33,38);
prel(23,26,31,38,43);
prel(23,24,28,31,36);
prel(21,24,28,31,36);
prel(14,21,26,30,36);
prel(19,23,26,31,35);
prel(19,22,28,31,37);
prel(17,21,26,33,38);
prel(17,20,26,29,35);
prel(16,19,24,31,36);
prel(16,17,21,24,29);
prel(14,17,21,24,29);
prel( 7,14,19,23,29);
prel(12,16,19,24,28);
prel(12,19,22,24,28);
prel( 5,17,21,24,28);
prel( 6,12,21,24,27);
prel( 8,17,23,24,26);
prel( 7,17,19,23,26);
prel( 7,16,19,24,28);
prel( 7,14,19,24,29);
prel( 7,14,19,23,29);
prel( 7,15,21,24,30);
prel( 7,16,19,24,31);
prel( 7,14,19,24,29);
prel( 7,14,19,23,29);
prel( 0,12,19,22,28);
end1( 0,12,17,21,24,29,21,17,14);
end2( 0,11,31,35,38,41,26,29,28);
end3([0,12,28,31,36]);

noteMap[rowCursor] = Note.OFF;    // key-off at start of final silence
rowCursor += 16 * TD - 5;         // 155 more rows of silence

var totalRows = rowCursor;         // 5836
var NUM_ROWS = 64;
var numPatterns = Math.ceil(totalRows / NUM_ROWS);  // 92

// -- 5. Build and upload patterns ----------------------------------------------
for (var p = 0; p < numPatterns; p++) {
    var patBytes = new Array(512).fill(0);
    for (var r = 0; r < NUM_ROWS; r++) {
        var absRow = p * NUM_ROWS + r;
        var noteVal = (noteMap[absRow] !== undefined) ? noteMap[absRow] : Note.NOP;
        var isOn = (noteVal !== Note.NOP && noteVal !== Note.OFF && noteVal !== Note.CUT);
        var off = r * 8;
        patBytes[off]     = noteVal & 0xFF;
        patBytes[off + 1] = (noteVal >> 8) & 0xFF;
        patBytes[off + 2] = 1;              // instrument 1
        patBytes[off + 3] = 63;  // volume
        patBytes[off + 4] = 31;  // pan (centre)
    }
    audio.uploadPattern(p, patBytes);
}

// -- 6. Cue sheet: one entry per pattern, last halts -------------------------
// Cue format: 32 bytes, 20 voices with 12-bit pattern numbers packed as:
//   bytes 0-9:  low nybbles (byte i = voice i*2 in hi-nybble, voice i*2+1 in lo-nybble)
//   bytes 10-19: mid nybbles (same packing)
//   bytes 20-29: high nybbles (same packing)
//   byte 30: instruction (0=NOP, 1=Halt)
// Voice 0 plays pattern c; voices 1-19 are disabled (0xFFF).
for (var c = 0; c < numPatterns; c++) {
    var cueBytes = new Array(32).fill(0xFF);
    // voice 0 = c (12-bit), voice 1 = 0xFFF → byte0=(c&0xF)<<4|0xF
    cueBytes[0]  = ((c & 0xF) << 4) | 0xF;           // lo nybbles v0,v1
    cueBytes[10] = (((c >> 4) & 0xF) << 4) | 0xF;    // mid nybbles v0,v1
    cueBytes[20] = (((c >> 8) & 0xF) << 4) | 0xF;    // hi nybbles v0,v1
    cueBytes[30] = (c === numPatterns - 1) ? 0x01 : 0;
    audio.uploadCue(c, cueBytes);
}

// -- 7. Playback ---------------------------------------------------------------
// BPM=500, tickRate=1: 1 row = 5 ms; 10 rows/step × 16 steps/bar ≈ 75 bars/min.
audio.setTrackerMode(PLAYHEAD);
audio.setBPM(PLAYHEAD, 250);
audio.setTickRate(PLAYHEAD, 6);
audio.setMasterVolume(PLAYHEAD, 255);
audio.setMasterPan(PLAYHEAD, 128);
audio.setCuePosition(PLAYHEAD, 0);
audio.play(PLAYHEAD);

println("Bach's Prelude in C Major -- " + numPatterns + " patterns loaded.");
println("Stop: audio.stop(" + PLAYHEAD + ")");
