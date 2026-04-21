/**
 * TSVM Audio Device Tracker
 *
 * Created by minjaesong on 2026-04-20
 */

const win = require("wintex")
const font = require("font")

font.setHighRom("A:/tvdos/bin/tautfont_high.chr")

const sym = {
/* accidentals */
accnull:"\u00A2\u00A3",
demisharp:"\u0080\u0081",
sharp:"\u0082\u0083",
sesquisharp:"\u0084\u0085",
doublesharp:"\u0086\u0087",
triplesharp:"\u0088\u0089",
quadsharp:"\u008A\u008B",
demiflat:"\u008C\u008D",
flat:"\u008E\u008F",
sesquiflat:"\u0090\u0091",
doubleflat:"\u0092\u0093",
tripleflat:"\u0094\u0095",
quadflat:"\u0096\u0097",

/* special notes */
keyoff:"\u00A0\u00CD\u00CD\u00A1",
notecut:"\u00A4\u00A4\u00A4\u00A4",

/* miscellaneous */
cent:"\u009B",
unticked:"\u009E",
ticked:"\u009F",
}

const pitchTablePresets = [
{name:"null", table:[]},
/* Xenharmonic, equal temperament */
{name:"5-TET", table:[0x0,0x333,0x666,0x99A,0xCCD]},
{name:"7-TET", table:[0x0,0x249,0x492,0x6DB,0x925,0xB6E,0xDB7]},
{name:"10-TET", table:[0x0,0x19A,0x333,0x4CD,0x666,0x800,0x99A,0xB33,0xCCD,0xE66]},
{name:"16-TET", table:[0x0,0x100,0x200,0x300,0x400,0x500,0x600,0x700,0x800,0x900,0xA00,0xB00,0xC00,0xD00,0xE00,0xF00]},
{name:"19-TET", table:[0x0,0xD8,0x1AF,0x287,0x35E,0x436,0x50D,0x5E5,0x6BD,0x794,0x86C,0x943,0xA1B,0xAF3,0xBCA,0xCA2,0xD79,0xE51,0xF28]},
{name:"22-TET", table:[0x0,0xBA,0x174,0x22F,0x2E9,0x3A3,0x45D,0x517,0x5D1,0x68C,0x746,0x800,0x8BA,0x974,0xA2F,0xAE9,0xBA3,0xC5D,0xD17,0xDD1,0xE8C,0xF46]},
{name:"24-TET", table:[0x0,0xAB,0x155,0x200,0x2AB,0x355,0x400,0x4AB,0x555,0x600,0x6AB,0x755,0x800,0x8AB,0x955,0xA00,0xAAB,0xB55,0xC00,0xCAB,0xD55,0xE00,0xEAB,0xF55]},
{name:"31-TET", table:[0x0,0x84,0x108,0x18C,0x211,0x295,0x319,0x39D,0x421,0x4A5,0x529,0x5AD,0x632,0x6B6,0x73A,0x7BE,0x842,0x8C6,0x94A,0x9CE,0xA53,0xAD7,0xB5B,0xBDF,0xC63,0xCE7,0xD6B,0xDEF,0xE74,0xEF8,0xF7C]},
{name:"53-TET", table:[0x0,0x4D,0x9B,0xE8,0x135,0x182,0x1D0,0x21D,0x26A,0x2B8,0x305,0x352,0x39F,0x3ED,0x43A,0x487,0x4D5,0x522,0x56F,0x5BC,0x60A,0x657,0x6A4,0x6F2,0x73F,0x78C,0x7D9,0x827,0x874,0x8C1,0x90E,0x95C,0x9A9,0x9F6,0xA44,0xA91,0xADE,0xB2B,0xB79,0xBC6,0xC13,0xC61,0xCAE,0xCFB,0xD48,0xD96,0xDE3,0xE30,0xE7E,0xECB,0xF18,0xF65,0xFB3]},
/* 12-TET variations */
{name:"12-TET",                         table:[0x0,0x155,0x2AB,0x400,0x555,0x6AB,0x800,0x955,0xAAB,0xC00,0xD55,0xEAB]},
{name:"Pythagorean Diminished Fifth", table:[0x0,0x134,0x2B8,0x3EC,0x570,0x6A4,0x7D8,0x95C,0xA90,0xC14,0xD48,0xECC]},
{name:"Pythagorean Augmented Fourth", table:[0x0,0x134,0x2B8,0x3EC,0x570,0x6A4,0x828,0x95C,0xA90,0xC14,0xD48,0xECC]},
{name:"Shierlu",                         table:[0x0,0x184,0x2B8,0x43C,0x570,0x6F4,0x828,0x95C,0xAE0,0xC14,0xD98,0xECC]},


]

/* converts 4096-TET (1 octave = 4096 tones) to conventional notation, with approximation
 * @param n note number (0..65535)
 * @param tets how many tones within octave under chosen pitch preset. Obtained by `preset.table.length`
 */
function noteName4096(n, tets) {
  const N = 4096;

  // Precompute bases (integer-rounded)
  const base = [0x0, 0x2AB, 0x555, 0x6AB, 0x955, 0xC00, 0xEAB] // [0, 2, 4, 5, 7, 9, 11] in 12-TET
  const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];


  // accidental mapping
  function accidental(k) {
    switch (k) {
      case 0: return sym.accnull; // no accidentals
      case 1: return sym.demisharp; // common in 24-tet
      case 2: return sym.sharp; // common
      case 3: return sym.sesquisharp; // common in 24-tet
      case 4: return sym.doublesharp; // the 'x' symbol
      case 5: return sym.triplesharp; // '#x'
      case 6: return sym.quadsharp; // 'xx'
      case -1: return sym.demiflat; // common in 24-tet
      case -2: return sym.flat; // common
      case -3: return sym.sesquiflat; // common in 24-tet
      case -4: return sym.doubleflat; // 'bb'
      case -5: return sym.tripleflat; // 'bbb'
      case -6: return sym.quadflat; // 'bbbb'
    }
  }

  // octave (C-based)
  const octave = ((n / N)|0) - 1; // AudioAdapter defines C3 to be 0x4000
  const p = ((n % N) + N) % N;

  // `tets` counts the octave endpoint (12-TET = 11)
  // Pick an accidental unit coherent with the tuning:
  //   - if the TET is a multiple of 12, sharp = one semitone (so demi/sesqui
  //     land on real notes when the TET is also a multiple of 24)
  //   - otherwise, sharp = one TET step — this lets 19/22/31/53-TET etc. spell
  //     each step as its own letter+accidental instead of collapsing neighbours
  const nTet = Math.max(1, tets);
  const accUnit = (nTet % 12 === 0) ? N/12 : N/nTet;

  // accidental offsets; k maps to a pitch shift in accUnit units:
  // 0, ±0.5 (demi), ±1 (sharp/flat), ±1.5 (sesqui), ±2 (double), ±3 (triple), ±4 (quad)
  const accValues = [
    [ 0, 0],
    [ 2,  accUnit       ], [-2, -accUnit       ],
    [ 4,  accUnit * 2   ], [-4, -accUnit * 2   ],
    [ 1,  accUnit * 0.5 ], [-1, -accUnit * 0.5 ],
    [ 3,  accUnit * 1.5 ], [-3, -accUnit * 1.5 ],
    [ 5,  accUnit * 3   ], [-5, -accUnit * 3   ],
    [ 6,  accUnit * 4   ], [-6, -accUnit * 4   ],
  ];

  // exoticness cost per accidental, scaled so it only breaks ties and slightly
  // biases toward simpler accidentals.  In high TETs (31, 53, ...) triple/quad
  // are structurally necessary, so penalties must stay well below one step.
  function kPenalty(k) {
    switch (Math.abs(k)) {
      case 0: return 0;
      case 2: return 2;   // sharp / flat
      case 4: return 4;   // double
      case 5: return 6;   // triple
      case 6: return 8;   // quad
      case 1: return 10;  // demi — quarter-tone, usually unused outside 24n-TET
      case 3: return 12;  // sesqui
    }
  }

  let best = null;
  for (let l = 0; l < 7; l++) {
    for (const [k, v] of accValues) {
      // try the letter in the previous, current, and next octave so notes near
      // the octave boundary can spell as e.g. C(next) instead of B-sharp
      for (const octShift of [-1, 0, 1]) {
        const target = base[l] + v + octShift * N;
        const err = Math.abs(p - target);
        if (err > N / 2) continue;
        const cost = err + kPenalty(k);
        if (best == null || cost < best.cost) {
          best = { letter: l, k: k, octShift: octShift, cost: cost };
        }
      }
    }
  }

  return letters[best.letter] + accidental(best.k) + octave;
}


for (let i = 1; i < pitchTablePresets.length; i++) {
    let preset = pitchTablePresets[i]
    println("Notes in "+preset.name+":")
    preset.table.forEach(v => {
        print(`${noteName4096(0x4000 + v, preset.table.length + 1)} `)
    })
    println()
}