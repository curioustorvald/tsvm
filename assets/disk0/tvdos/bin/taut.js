/**
 * TSVM Audio Device Tracker
 *
 * Created by minjaesong on 2026-04-20
 */

const win = require("wintex")
const font = require("font")

font.setHighRom("A:/tvdos/bin/tautfont_high.chr")

const MIDDOT = "\u00FA"

const sym = {
/* accidentals */
accnull:"\u00A2\u00A3",
demisharp:"\u0080\u0081",
sharp:"\u0082\u0083",
sesquisharp:"\u0084132u\u0085", // refrain from using (not visible on CRT); 0x84 is used as a escape sequence for arbitrary unicode character in TSVM
doublesharp:"\u0086\u0087",
triplesharp:"\u0088\u0089",
quadsharp:"\u008A\u008B",
demiflat:"\u008C\u008D",
flat:"\u008E\u008F",
sesquiflat:"\u0090\u0091",
doubleflat:"\u0092\u0093",
tripleflat:"\u0094\u0095",
quadflat:"\u0096\u0097", // refrain from using (not visible on CRT)

csharp:"\u0098",
cflat:"\u0098",
cdemisharp:"\u009E",
cdemiflat:"\u009F",
uptick:"\u009A",
dntick:"\u009B",
doubleuptick:"\u009C",
doubledntick:"\u009D",


/* special notes */
keyoff:"\u00A0\u00CD\u00CD\u00A1",
notecut:"\u00A4\u00A4\u00A4\u00A4",

/* special effects */
volset:MIDDOT,
volup:"\u008430u",
voldn:"\u008431u",
volfineup:"+",
volfinedn:"-",

panset:MIDDOT,
panle:"\u008417u",
panri:"\u008416u",
panfinele:"\u008427u",
panfineri:"\u008426u",

/* miscellaneous */
unticked:"\u009E",
ticked:"\u009F",
middot:MIDDOT
}

const pitchTablePresets = {
// index: pitch table number to be recorded on .taudproj file
0:{index:0,name:"null", table:[], sym:[]}, // when null is specified, hex numbers will be displayed instead
/* Xenharmonic, equal temperament */
50:{index:50,name:"5-TET", table:[0x0,0x333,0x666,0x99A,0xCCD],
sym:[`C${sym.accnull}`,`D${sym.accnull}`,`E${sym.accnull}`,`G${sym.accnull}`,`A${sym.accnull}`]},
70:{index:70,name:"7-TET", table:[0x0,0x249,0x492,0x6DB,0x925,0xB6E,0xDB7],
sym:[`C${sym.accnull}`,`D${sym.accnull}`,`E${sym.accnull}`,`F${sym.accnull}`,`G${sym.accnull}`,`A${sym.accnull}`,`B${sym.accnull}`]},
100:{index:100,name:"10-TET", table:[0x0,0x19A,0x333,0x4CD,0x666,0x800,0x99A,0xB33,0xCCD,0xE66],
sym:[`C${sym.accnull}`,`D${sym.flat}`,`D${sym.accnull}`,`E${sym.flat}`,`E${sym.accnull}`,`E${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`]},
150:{index:150,name:"15-TET", table:[0x0,0x111,0x222,0x333,0x444,0x555,0x666,0x777,0x889,0x99A,0xAAB,0xBBC,0xCCD,0xDDE,0xEEF],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.flat}`,`E${sym.accnull}`,`E${sym.sharp}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.flat}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.flat}`,`B${sym.accnull}`]},
170:{index:170,name:"17-TET", table:[0x0,0xF1,0x1E2,0x2D3,0x3C4,0x4B5,0x5A6,0x697,0x788,0x878,0x969,0xA5A,0xB4B,0xC3C,0xD2D,0xE1E,0xF0F],
sym:[`C${sym.accnull}`,`D${sym.flat}`,`C${sym.sharp}`,`D${sym.accnull}`,`E${sym.flat}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`G${sym.flat}`,`F${sym.sharp}`,`G${sym.accnull}`,`A${sym.flat}`,`G${sym.sharp}`,`A${sym.accnull}`,`B${sym.flat}`,`A${sym.sharp}`,`B${sym.accnull}`]},
190:{index:190,name:"19-TET", table:[0x0,0xD8,0x1AF,0x287,0x35E,0x436,0x50D,0x5E5,0x6BD,0x794,0x86C,0x943,0xA1B,0xAF3,0xBCA,0xCA2,0xD79,0xE51,0xF28],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.flat}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.flat}`,`E${sym.accnull}`,`E${sym.sharp}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.flat}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.flat}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.flat}`,`B${sym.accnull}`,`B${sym.sharp}`]},
220:{index:220,name:"22-TET", table:[0x0,0xBA,0x174,0x22F,0x2E9,0x3A3,0x45D,0x517,0x5D1,0x68C,0x746,0x800,0x8BA,0x974,0xA2F,0xAE9,0xBA3,0xC5D,0xD17,0xDD1,0xE8C,0xF46],
sym:[`C${sym.accnull}`,`C${sym.demisharp}`,`C${sym.sharp}`,`D${sym.demiflat}`,`D${sym.accnull}`,`D${sym.demisharp}`,`D${sym.sharp}`,`E${sym.demiflat}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.demisharp}`,`F${sym.sharp}`,`G${sym.demiflat}`,`G${sym.accnull}`,`G${sym.demisharp}`,`G${sym.sharp}`,`A${sym.demiflat}`,`A${sym.accnull}`,`A${sym.demisharp}`,`A${sym.sharp}`,`B${sym.demiflat}`,`B${sym.accnull}`]},
240:{index:240,name:"24-TET", table:[0x0,0xAB,0x155,0x200,0x2AB,0x355,0x400,0x4AB,0x555,0x600,0x6AB,0x755,0x800,0x8AB,0x955,0xA00,0xAAB,0xB55,0xC00,0xCAB,0xD55,0xE00,0xEAB,0xF55],
sym:[`C${sym.accnull}`,`C${sym.demisharp}`,`C${sym.sharp}`,`D${sym.demiflat}`,`D${sym.accnull}`,`D${sym.demisharp}`,`D${sym.sharp}`,`E${sym.demiflat}`,`E${sym.accnull}`,`E${sym.demisharp}`,`F${sym.accnull}`,`F${sym.demisharp}`,`F${sym.sharp}`,`G${sym.demiflat}`,`G${sym.accnull}`,`G${sym.demisharp}`,`G${sym.sharp}`,`A${sym.demiflat}`,`A${sym.accnull}`,`A${sym.demisharp}`,`A${sym.sharp}`,`B${sym.demiflat}`,`B${sym.accnull}`,`B${sym.demisharp}`]},
310:{index:310,name:"31-TET", table:[0x0,0x84,0x108,0x18C,0x211,0x295,0x319,0x39D,0x421,0x4A5,0x529,0x5AD,0x632,0x6B6,0x73A,0x7BE,0x842,0x8C6,0x94A,0x9CE,0xA53,0xAD7,0xB5B,0xBDF,0xC63,0xCE7,0xD6B,0xDEF,0xE74,0xEF8,0xF7C],
sym:[`C${sym.accnull}`,`C${sym.demisharp}`,`C${sym.sharp}`,`D${sym.flat}`,`D${sym.demiflat}`,`D${sym.accnull}`,`D${sym.demisharp}`,`D${sym.sharp}`,`E${sym.flat}`,`E${sym.demiflat}`,`E${sym.accnull}`,`E${sym.demisharp}`,`F${sym.demiflat}`,`F${sym.accnull}`,`F${sym.demisharp}`,`F${sym.sharp}`,`G${sym.flat}`,`G${sym.demiflat}`,`G${sym.accnull}`,`G${sym.demisharp}`,`G${sym.sharp}`,`A${sym.flat}`,`A${sym.demiflat}`,`A${sym.accnull}`,`A${sym.demisharp}`,`A${sym.sharp}`,`B${sym.flat}`,`B${sym.demiflat}`,`B${sym.accnull}`,`B${sym.demisharp}`,`C${sym.demiflat}`]},
410:{index:410,name:"41-TET", table:[0x0,0x64,0xC8,0x12C,0x190,0x1F4,0x257,0x2BB,0x31F,0x383,0x3E7,0x44B,0x4AF,0x513,0x577,0x5DB,0x63E,0x6A2,0x706,0x76A,0x7CE,0x832,0x896,0x8FA,0x95E,0x9C2,0xA25,0xA89,0xAED,0xB51,0xBB5,0xC19,0xC7D,0xCE1,0xD45,0xDA9,0xE0C,0xE70,0xED4,0xF38,0xF9C],
sym:[`-C-`,`${sym.uptick}C-`,`${sym.doubledntick}C${sym.csharp}`,`${sym.dntick}C${sym.csharp}`,`-C${sym.csharp}`,`${sym.uptick}C${sym.csharp}`,`${sym.dntick}D-`,`-D-`,`${sym.uptick}D-`,`${sym.doubledntick}D${sym.csharp}`,`${sym.dntick}D${sym.csharp}`,`-D${sym.csharp}`,`${sym.uptick}D${sym.csharp}`,`${sym.dntick}E-`,`-E-`,`${sym.uptick}E-`,`${sym.doubleuptick}E-`,`-F-`,`${sym.uptick}F-`,`${sym.doubledntick}F${sym.csharp}`,`${sym.dntick}F${sym.csharp}`,`-F${sym.csharp}`,`${sym.uptick}F${sym.csharp}`,`${sym.dntick}G-`,`-G-`,`${sym.uptick}G-`,`${sym.doubledntick}G${sym.csharp}`,`${sym.dntick}G${sym.csharp}`,`-G${sym.csharp}`,`${sym.uptick}G${sym.csharp}`,`${sym.dntick}A-`,`-A-`,`${sym.uptick}A-`,`${sym.doubledntick}A${sym.csharp}`,`${sym.dntick}A${sym.csharp}`,`-A${sym.csharp}`,`${sym.uptick}A${sym.csharp}`,`${sym.dntick}B-`,`-B-`,`${sym.uptick}B-`,`${sym.doubleuptick}B-`]},
530:{index:530,name:"53-TET Microtonal Notation", table:[0x0,0x4D,0x9B,0xE8,0x135,0x182,0x1D0,0x21D,0x26A,0x2B8,0x305,0x352,0x39F,0x3ED,0x43A,0x487,0x4D5,0x522,0x56F,0x5BC,0x60A,0x657,0x6A4,0x6F2,0x73F,0x78C,0x7D9,0x827,0x874,0x8C1,0x90E,0x95C,0x9A9,0x9F6,0xA44,0xA91,0xADE,0xB2B,0xB79,0xBC6,0xC13,0xC61,0xCAE,0xCFB,0xD48,0xD96,0xDE3,0xE30,0xE7E,0xECB,0xF18,0xF65,0xFB3],
sym:[`-C-`,`${sym.uptick}C-`,`${sym.doubleuptick}C-`,`${sym.doubledntick}C${sym.csharp}`,`${sym.dntick}C${sym.csharp}`,`-C${sym.csharp}`,`${sym.uptick}C${sym.csharp}`,`${sym.doubledntick}D-`,`${sym.dntick}D-`,`-D-`,`${sym.uptick}D-`,`${sym.doubleuptick}D-`,`${sym.doubledntick}D${sym.csharp}`,`${sym.dntick}D${sym.csharp}`,`-D${sym.csharp}`,`${sym.uptick}D${sym.csharp}`,`${sym.doubledntick}E-`,`${sym.dntick}E-`,`-E-`,`${sym.uptick}E-`,`${sym.doubleuptick}E-`,`${sym.dntick}F-`,`-F-`,`${sym.uptick}F-`,`${sym.doubleuptick}F-`,`${sym.doubledntick}F${sym.csharp}`,`${sym.dntick}F${sym.csharp}`,`-F${sym.csharp}`,`${sym.uptick}F${sym.csharp}`,`${sym.doubledntick}G-`,`${sym.dntick}G-`,`-G-`,`${sym.uptick}G-`,`${sym.doubleuptick}G-`,`${sym.doubledntick}G${sym.csharp}`,`${sym.dntick}G${sym.csharp}`,`-G${sym.csharp}`,`${sym.uptick}G${sym.csharp}`,`${sym.doubledntick}A-`,`${sym.dntick}A-`,`-A-`,`${sym.uptick}A-`,`${sym.doubleuptick}A-`,`${sym.doubledntick}A${sym.csharp}`,`${sym.dntick}A${sym.csharp}`,`-A${sym.csharp}`,`${sym.uptick}A${sym.csharp}`,`${sym.doubledntick}B-`,`${sym.dntick}B-`,`-B-`,`${sym.uptick}B-`,`${sym.doubleuptick}B-`,`${sym.dntick}C-`]},
531:{index:531,name:"53-TET Pythagorean Notation", table:[0x0,0x4D,0x9B,0xE8,0x135,0x182,0x1D0,0x21D,0x26A,0x2B8,0x305,0x352,0x39F,0x3ED,0x43A,0x487,0x4D5,0x522,0x56F,0x5BC,0x60A,0x657,0x6A4,0x6F2,0x73F,0x78C,0x7D9,0x827,0x874,0x8C1,0x90E,0x95C,0x9A9,0x9F6,0xA44,0xA91,0xADE,0xB2B,0xB79,0xBC6,0xC13,0xC61,0xCAE,0xCFB,0xD48,0xD96,0xDE3,0xE30,0xE7E,0xECB,0xF18,0xF65,0xFB3],
sym:[`C${sym.accnull}`,`B${sym.sharp}`,`A${sym.triplesharp}`,`E${sym.tripleflat}`,`D${sym.flat}`,`C${sym.sharp}`,`B${sym.doublesharp}`,`F${sym.tripleflat}`,`E${sym.doubleflat}`,`D${sym.accnull}`,`C${sym.doublesharp}`,`B${sym.triplesharp}`,`F${sym.doubleflat}`,`E${sym.flat}`,`D${sym.sharp}`,`C${sym.triplesharp}`,`G${sym.tripleflat}`,`F${sym.flat}`,`E${sym.accnull}`,`D${sym.doublesharp}`,`C${sym.quadsharp}`,`G${sym.doubleflat}`,`F${sym.accnull}`,`E${sym.sharp}`,`D${sym.triplesharp}`,`A${sym.tripleflat}`,`G${sym.flat}`,`F${sym.sharp}`,`E${sym.doublesharp}`,`D${sym.quadsharp}`,`A${sym.doubleflat}`,`G${sym.accnull}`,`F${sym.doublesharp}`,`E${sym.triplesharp}`,`B${sym.tripleflat}`,`A${sym.flat}`,`G${sym.sharp}`,`F${sym.triplesharp}`,`C${sym.tripleflat}`,`B${sym.doubleflat}`,`A${sym.accnull}`,`G${sym.doublesharp}`,`F${sym.quadsharp}`,`C${sym.doubleflat}`,`B${sym.flat}`,`A${sym.sharp}`,`G${sym.triplesharp}`,`D${sym.tripleflat}`,`C${sym.flat}`,`B${sym.accnull}`,`A${sym.doublesharp}`,`G${sym.quadsharp}`,`D${sym.doubleflat}`]},
960:{index:960,name:"96-TET", table:[0x0,0x2B,0x55,0x80,0xAB,0xD5,0x100,0x12B,0x155,0x180,0x1AB,0x1D5,0x200,0x22B,0x255,0x280,0x2AB,0x2D5,0x300,0x32B,0x355,0x380,0x3AB,0x3D5,0x400,0x42B,0x455,0x480,0x4AB,0x4D5,0x500,0x52B,0x555,0x580,0x5AB,0x5D5,0x600,0x62B,0x655,0x680,0x6AB,0x6D5,0x700,0x72B,0x755,0x780,0x7AB,0x7D5,0x800,0x82B,0x855,0x880,0x8AB,0x8D5,0x900,0x92B,0x955,0x980,0x9AB,0x9D5,0xA00,0xA2B,0xA55,0xA80,0xAAB,0xAD5,0xB00,0xB2B,0xB55,0xB80,0xBAB,0xBD5,0xC00,0xC2B,0xC55,0xC80,0xCAB,0xCD5,0xD00,0xD2B,0xD55,0xD80,0xDAB,0xDD5,0xE00,0xE2B,0xE55,0xE80,0xEAB,0xED5,0xF00,0xF2B,0xF55,0xF80,0xFAB,0xFD5],
sym:[`-C-`,`${sym.uptick}C-`,`${sym.doubleuptick}C-`,`${sym.dntick}C${sym.cdemisharp}`,`-C${sym.cdemisharp}`,`${sym.uptick}C${sym.cdemisharp}`,`${sym.doubleuptick}C${sym.cdemisharp}`,`${sym.dntick}C${sym.csharp}`,`-C${sym.csharp}`,`${sym.uptick}C${sym.csharp}`,`${sym.doubleuptick}C${sym.csharp}`,`${sym.dntick}D${sym.cdemiflat}`,`-D${sym.cdemiflat}`,`${sym.uptick}D${sym.cdemiflat}`,`${sym.doubleuptick}D${sym.cdemiflat}`,`${sym.dntick}D-`,`-D-`,`${sym.uptick}D-`,`${sym.doubleuptick}D-`,`${sym.dntick}D${sym.cdemisharp}`,`-D${sym.cdemisharp}`,`${sym.uptick}D${sym.cdemisharp}`,`${sym.doubleuptick}D${sym.cdemisharp}`,`${sym.dntick}D${sym.csharp}`,`-D${sym.csharp}`,`${sym.uptick}D${sym.csharp}`,`${sym.doubleuptick}D${sym.csharp}`,`${sym.dntick}E${sym.cdemiflat}`,`-E${sym.cdemiflat}`,`${sym.uptick}E${sym.cdemiflat}`,`${sym.doubleuptick}E${sym.cdemiflat}`,`${sym.dntick}E-`,`-E-`,`${sym.uptick}E-`,`${sym.doubleuptick}E-`,`${sym.dntick}E${sym.cdemisharp}`,`-E${sym.cdemisharp}`,`${sym.uptick}E${sym.cdemisharp}`,`${sym.doubleuptick}E${sym.cdemisharp}`,`${sym.dntick}F-`,`-F-`,`${sym.uptick}F-`,`${sym.doubleuptick}F-`,`${sym.dntick}F${sym.cdemisharp}`,`-F${sym.cdemisharp}`,`${sym.uptick}F${sym.cdemisharp}`,`${sym.doubleuptick}F${sym.cdemisharp}`,`${sym.dntick}F${sym.csharp}`,`-F${sym.csharp}`,`${sym.uptick}F${sym.csharp}`,`${sym.doubleuptick}F${sym.csharp}`,`${sym.dntick}G${sym.cdemiflat}`,`-G${sym.cdemiflat}`,`${sym.uptick}G${sym.cdemiflat}`,`${sym.doubleuptick}G${sym.cdemiflat}`,`${sym.dntick}G-`,`-G-`,`${sym.uptick}G-`,`${sym.doubleuptick}G-`,`${sym.dntick}G${sym.cdemisharp}`,`-G${sym.cdemisharp}`,`${sym.uptick}G${sym.cdemisharp}`,`${sym.doubleuptick}G${sym.cdemisharp}`,`${sym.dntick}G${sym.csharp}`,`-G${sym.csharp}`,`${sym.uptick}G${sym.csharp}`,`${sym.doubleuptick}G${sym.csharp}`,`${sym.dntick}A${sym.cdemiflat}`,`-A${sym.cdemiflat}`,`${sym.uptick}A${sym.cdemiflat}`,`${sym.doubleuptick}A${sym.cdemiflat}`,`${sym.dntick}A-`,`-A-`,`${sym.uptick}A-`,`${sym.doubleuptick}A-`,`${sym.dntick}A${sym.cdemisharp}`,`-A${sym.cdemisharp}`,`${sym.uptick}A${sym.cdemisharp}`,`${sym.doubleuptick}A${sym.cdemisharp}`,`${sym.dntick}A${sym.csharp}`,`-A${sym.csharp}`,`${sym.uptick}A${sym.csharp}`,`${sym.doubleuptick}A${sym.csharp}`,`${sym.dntick}B${sym.cdemiflat}`,`-B${sym.cdemiflat}`,`${sym.uptick}B${sym.cdemiflat}`,`${sym.doubleuptick}B${sym.cdemiflat}`,`${sym.dntick}B-`,`-B-`,`${sym.uptick}B-`,`${sym.doubleuptick}B-`,`${sym.dntick}B${sym.cdemisharp}`,`-B${sym.cdemisharp}`,`${sym.uptick}B${sym.cdemisharp}`,`${sym.doubleuptick}B${sym.cdemisharp}`]},
/* 12-TET variations */
120:{index:120,name:"12-TET",                         table:[0x0,0x155,0x2AB,0x400,0x555,0x6AB,0x800,0x955,0xAAB,0xC00,0xD55,0xEAB],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},
10121:{index:10121,name:"Pythagorean Diminished Fifth", table:[0x0,0x134,0x2B8,0x3EC,0x570,0x6A4,0x7D8,0x95C,0xA90,0xC14,0xD48,0xECC],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},
10122:{index:10122,name:"Pythagorean Augmented Fourth", table:[0x0,0x134,0x2B8,0x3EC,0x570,0x6A4,0x828,0x95C,0xA90,0xC14,0xD48,0xECC],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},
10123:{index:10123,name:"Shierlu",                         table:[0x0,0x184,0x2B8,0x43C,0x570,0x6F4,0x828,0x95C,0xAE0,0xC14,0xD98,0xECC],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},



}


const volEffSym = [sym.volset, sym.volup, sym.voldn, sym.volfineup, sym.volfinedn]
const panEffSym = [sym.panset, sym.panle, sym.panri, sym.panfinele, sym.panfineri]

const colNote = 239
const colInst = 114
const colVol = 117
const colPan = 221
const colEffOp = 208
const colEffArg = 231
const colBackPtn = 255

/**
 * Prints out pattern data at current cursor position, assuming indexFrom and indexTo does not overflow current screen size
 */
function printPattern(patternData, indexFrom, indexTo, drawMode) {
    const off = 8*indexFrom

    const note = patternData[off] | (patternData[off+1] << 8)
    const inst = patternData[off+2]
    const voleff = patternData[off+3]
    const voleffarg = voleff & 63
    const paneff = patternData[off+4]
    const paneffarg = paneff & 63
    const effop = patternData[off+5]
    const effarg = patternData[off+6] | (patternData[off+7] << 8)

    let sNote = note.toString(16).toUpperCase().padStart(4,'0')
    if (note == 0xFFFF) sNote = sym.middot.repeat(4)
    if (note == 0xFFFE) sNote = sym.notecut
    if (note == 0x0000) sNote = sym.keyoff
    let sInst = inst.toString(16).toUpperCase().padStart(2,sym.middot)
    if (inst == 0) sInst = sym.middot.repeat(3);
    let sVolEff = volEffSym[voleff >>> 6]
    let sVolArg = voleffarg.toString().padStart(2,sym.middot)
    // fine slide notation
    if (voleff >>> 6 == 3) {
        if (voleffarg == 0) {
            sVolEff = sym.middot
            sVolArg = sym.middot.repeat(2)
        }
        else if (voleffarg >= 32) {
            sVolEff = volEffSym[3]
            sVolArg = (voleffarg & 31).toString().padStart(2,'0')
        }
        else {
            sVolEff = volEffSym[4]
            sVolArg = (voleffarg & 31).toString().padStart(2,'0')
        }
    }
    let sPanEff = panEffSym[voleff >>> 6]
    let sPanArg = paneffarg.toString().padStart(2,sym.middot)
    // fine slide notation
    if (paneff >>> 6 == 3) {
        if (paneffarg == 0) {
            sPanEff = sym.middot
            sPanArg = sym.middot.repeat(2)
        }
        else if (paneffarg >= 32) {
            sPanEff = panEffSym[4]
            sPanArg = (paneffarg & 31).toString().padStart(2,'0')
        }
        else {
            sPanEff = panEffSym[3]
            sPanArg = (paneffarg & 31).toString().padStart(2,'0')
        }
    }
    let sEffOp = effop.toString(36).toUpperCase()[0]
    let sEffArg = effarg.toString(16).toUpperCase().padStart(4,'0')
    if (sEffOp == 0 && sEffArg == 0) {
        sEffOp = sym.middot
        sEffArg = sym.middot.repeat(4)
    }

    let [cy, cx] = con.getyx()

    for (let i = 0; i < indexTo; i++) {
        con.move(cy + i, cx)

        con.color_pair(colNote, colBackPtn)
        print(sNote)

        con.color_pair(colInst, colBackPtn)
        print(sInst)

        con.color_pair(colVol, colBackPtn)
        print(sVolEff)
        con.color_pair(colVol, colBackPtn)
        print(sVolArg)

        con.color_pair(colPan, colBackPtn)
        print(sPanEff)
        con.color_pair(colPan, colBackPtn)
        print(sPanArg)

        con.color_pair(colEffOp, colBackPtn)
        print(sEffOp)
        con.color_pair(colEffArg, colBackPtn)
        print(sEffArg)
    }
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// GUI DEFINITION
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// drawing constants
const [SCRH, SCRW] = con.getmaxyx()
const PTNVIEW_OFFSET_X = 10
const PTNVIEW_OFFSET_Y = 4
const PTNVIEW_HEIGHT = SCRH - PTNVIEW_OFFSET_Y
const COLSIZE = 18
const VOCSIZE = 4

const VIEW_TIMELINE = 0
const VIEW_ORDERS = 1
const VIEW_INSTRUMENT = 2
const VIEW_PATTERN_DETAILS = 3

// draw functions
function drawPatternView() {
    for (let c = 0; c < VOCSIZE; c++) {
        con.move(PTNVIEW_OFFSET_Y,PTNVIEW_OFFSET_X+COLSIZE*c)
        printPattern(fakeData, 0, PTNVIEW_HEIGHT)

        // separator
        if (c < VOCSIZE - 1) {
            con.color_pair(252,255)
            for (let y = 0; y < PTNVIEW_HEIGHT; y++) {
                con.move(PTNVIEW_OFFSET_Y+y,PTNVIEW_OFFSET_X+COLSIZE*(c+1)-1)
                con.prnch(0xB3)
            }
        }
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// APPLICATION STUB
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// nav constants
const KEY_LEFT = 21
const KEY_RIGHT = 22
const KEY_UP = 19
const KEY_DOWN = 20
const KEY_RETURN = 66
const KEY_BKSP = 67
const KEY_TAB = 61

// GUI status
let currentPanel = VIEW_TIMELINE

// app run
let fakeData = new Uint8Array(512)
for (let i = 0; i < 512; i++) {
    fakeData[i] = (Math.random(sys.nanoTime())*256)&255
}

con.clear()
if (currentPanel == VIEW_TIMELINE) {
    drawPatternView()
}
con.move(1,1)