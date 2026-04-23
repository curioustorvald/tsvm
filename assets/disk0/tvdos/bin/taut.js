/**
 * TSVM Audio Device Tracker
 *
 * Created by minjaesong on 2026-04-20
 */

const win = require("wintex")
const font = require("font")
const taud = require("taud")

font.setHighRom("A:/tvdos/bin/tautfont_high.chr")

const MIDDOT = "\u00FA"
const BIGDOT = "\u00F9"
const BULLET = "\u00847u"
const VERT = "\u00B3"
const TWOVERT = "\u00BA"

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
volset:'',//MIDDOT,
volup:"\u008430u",
voldn:"\u008431u",
volfineup:"+",
volfinedn:"-",

panset:'',//MIDDOT,
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
const colEffOp = 213
const colEffArg = 231
const colBackPtn = 255

const PITCH_PRESET_IDX = 240 // TODO read from the Project Data section of the .taud

Number.prototype.hex02 = function() {
    return this.toString(16).toUpperCase().padStart(2,'0')
}
Number.prototype.hex03 = function() {
    return this.toString(16).toUpperCase().padStart(3,'0')
}
Number.prototype.hex04 = function() {
    return this.toString(16).toUpperCase().padStart(4,'0')
}
Number.prototype.hexD2 = function() {
    return this.toString(16).toUpperCase().padStart(2, sym.middot)
}
Number.prototype.hex1 = function() {
    return this.toString(16).toUpperCase()
}
Number.prototype.dec02 = function() {
    return this.toString(10).toUpperCase().padStart(2,'0')
}
Number.prototype.decD2 = function() {
    return this.toString(10).toUpperCase().padStart(2, sym.middot)
}


function noteToStr(note) {
    if (note === 0xFFFF) return sym.middot.repeat(4)
    if (note === 0xFFFE) return sym.notecut
    if (note === 0x0000) return sym.keyoff
    const table = pitchTablePresets[PITCH_PRESET_IDX].table
    const syms  = pitchTablePresets[PITCH_PRESET_IDX].sym
    if (table.length === 0) return note.hex04()
    const pitchInOct = note & 0xFFF
    const octave = (note >> 12) - 1
    let best = 0, bestDist = 0x1000
    for (let i = 0; i < table.length; i++) {
        const d = Math.abs(pitchInOct - table[i])
        if (d < bestDist) { bestDist = d; best = i }
    }
    if ((0x1000 - pitchInOct) < bestDist) return syms[0] + (octave + 1)
    return syms[best] + octave
}

/**
 * Builds the coloured string fragments for a single row of pattern data.
 */
function buildRowCell(ptnDat, row) {
    const off = 8 * row

    const note = ptnDat[off] | (ptnDat[off+1] << 8)
    const inst = ptnDat[off+2]
    const voleff = ptnDat[off+3]
    const voleffarg = voleff & 63
    const paneff = ptnDat[off+4]
    const paneffarg = paneff & 63
    const effop = ptnDat[off+5]
    const effarg = ptnDat[off+6] | (ptnDat[off+7] << 8)

    const sNote = noteToStr(note)

    let sInst = inst.hexD2()
    if (inst == 0) sInst = sym.middot.repeat(2)

    let sVolEff = volEffSym[voleff >>> 6]
    let sVolArg = voleffarg.hexD2()
    if (voleff === 0) {
        sVolEff = ''
        sVolArg = sym.middot.repeat(2)
    }
    else if (voleff >>> 6 == 3) {
        if (voleffarg == 0) {
            sVolEff = sym.middot
            sVolArg = sym.middot.repeat(1)
        }
        else if (voleffarg >= 32) {
            sVolEff = volEffSym[3]
            sVolArg = (voleffarg & 15).hex1()
        }
        else {
            sVolEff = volEffSym[4]
            sVolArg = (voleffarg & 15).hex1()
        }
    }

    let sPanEff = panEffSym[paneff >>> 6]
    let sPanArg = paneffarg.hexD2()
    if (paneff === 0) {
        sPanEff = ''
        sPanArg = sym.middot.repeat(2)
    }
    else if (paneff >>> 6 == 3) {
        if (paneffarg == 0) {
            sPanEff = sym.middot
            sPanArg = sym.middot.repeat(1)
        }
        else if (paneffarg >= 32) {
            sPanEff = panEffSym[4]
            sPanArg = (paneffarg & 15).hex1()
        }
        else {
            sPanEff = panEffSym[3]
            sPanArg = (paneffarg & 15).hex1()
        }
    }

    let sEffOp = (effop > 0) ? effop.toString(36).toUpperCase()[0] : sym.middot
    let sEffArg = effarg.hex04()
    if (effop === 0 && effarg === 0) {
        sEffOp = sym.middot
        sEffArg = sym.middot.repeat(4)
    }

    return { sNote, sInst, sVolEff, sVolArg, sPanEff, sPanArg, sEffOp, sEffArg }
}

const EMPTY_CELL = {
    sNote:   sym.middot.repeat(4),
    sInst:   sym.middot.repeat(3),
    sVolEff: '',
    sVolArg: sym.middot.repeat(2),
    sPanEff: '',
    sPanArg: sym.middot.repeat(2),
    sEffOp:  sym.middot,
    sEffArg: sym.middot.repeat(4)
}

function drawCellAt(y, x, cell, back) {
    con.move(y, x)
    con.color_pair(colNote,   back); print(cell.sNote)
    con.color_pair(colInst,   back); print(cell.sInst)
    con.color_pair(colVol,    back); print(cell.sVolEff)
    con.color_pair(colVol,    back); print(cell.sVolArg)
    con.color_pair(colPan,    back); print(cell.sPanEff)
    con.color_pair(colPan,    back); print(cell.sPanArg)
    con.color_pair(colEffOp,  back); print(cell.sEffOp)
    con.color_pair(colEffArg, back); print(cell.sEffArg)
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// .TAUD FILE LOADER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

const TAUD_MAGIC       = [0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64]
const TAUD_HEADER_SIZE = 32
const TAUD_SONG_ENTRY  = 16
const PATTERN_SIZE     = 512
const ROWS_PER_PAT     = 64
const NUM_CUES         = 1024
const CUE_SIZE         = 32
const NUM_VOICES       = 20
const CUE_EMPTY        = 0xFFF

function _peekU32LE(ptr, off) {
    return ((sys.peek(ptr+off)   & 0xFF)       ) |
           ((sys.peek(ptr+off+1) & 0xFF) <<  8 ) |
           ((sys.peek(ptr+off+2) & 0xFF) << 16 ) |
           ((sys.peek(ptr+off+3) & 0xFF) * 0x1000000)
}

function loadTaud(filePath, songIndex) {
    const fh = files.open(filePath)
    if (!fh.exists) throw Error(`taut: file not exists: ${filePath}`)
    const fileSize = fh.size
    const ptr = sys.malloc(fileSize)
    fh.pread(ptr, fileSize, 0)
    fh.close()

    for (let i = 0; i < 8; i++) {
        if ((sys.peek(ptr + i) & 0xFF) !== TAUD_MAGIC[i]) {
            sys.free(ptr)
            throw Error(`taut: bad magic byte at ${i}`)
        }
    }

    const version  = sys.peek(ptr + 8) & 0xFF
    const numSongs = sys.peek(ptr + 9) & 0xFF
    const compSize = _peekU32LE(ptr, 10)

    if (songIndex < 0 || songIndex >= numSongs) {
        sys.free(ptr)
        throw Error(`taut: song index ${songIndex} out of range (numSongs=${numSongs})`)
    }

    const songTableOff = TAUD_HEADER_SIZE + compSize
    const entryOff     = songTableOff + songIndex * TAUD_SONG_ENTRY

    const songOff   = _peekU32LE(ptr, entryOff)
    const numVoices = sys.peek(ptr + entryOff + 4) & 0xFF
    const numPats   = (sys.peek(ptr + entryOff + 5) & 0xFF) |
                      ((sys.peek(ptr + entryOff + 6) & 0xFF) << 8)
    const bpmStored = sys.peek(ptr + entryOff + 7) & 0xFF
    const tickRate  = sys.peek(ptr + entryOff + 8) & 0xFF

    const patterns = new Array(numPats)
    for (let p = 0; p < numPats; p++) {
        const ptn = new Uint8Array(PATTERN_SIZE)
        for (let k = 0; k < PATTERN_SIZE; k++) {
            ptn[k] = sys.peek(ptr + songOff + p * PATTERN_SIZE + k) & 0xFF
        }
        patterns[p] = ptn
    }

    const cueBase = songOff + numPats * PATTERN_SIZE
    const cues = new Array(NUM_CUES)
    let lastActiveCue = -1
    for (let c = 0; c < NUM_CUES; c++) {
        const ptns = new Array(NUM_VOICES)
        for (let i = 0; i < 10; i++) {
            const lo = sys.peek(ptr + cueBase + c * CUE_SIZE + i)      & 0xFF
            const mi = sys.peek(ptr + cueBase + c * CUE_SIZE + 10 + i) & 0xFF
            const hi = sys.peek(ptr + cueBase + c * CUE_SIZE + 20 + i) & 0xFF
            ptns[i*2]   = ((hi >> 4) << 8) | ((mi >> 4) << 4) | (lo >> 4)
            ptns[i*2+1] = ((hi & 0xF) << 8) | ((mi & 0xF) << 4) | (lo & 0xF)
        }
        const instr = sys.peek(ptr + cueBase + c * CUE_SIZE + 30) & 0xFF
        cues[c] = { ptns, instr }

        for (let v = 0; v < NUM_VOICES; v++) {
            if (ptns[v] !== CUE_EMPTY) { lastActiveCue = c; break }
        }
    }

    sys.free(ptr)

    return {
        filePath, version, numSongs, numVoices, numPats,
        bpm: (bpmStored + 24) & 0xFF, tickRate,
        patterns, cues, lastActiveCue
    }
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// GUI DEFINITION
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

const [SCRH, SCRW] = con.getmaxyx()
const PTNVIEW_OFFSET_X = 3
const PTNVIEW_OFFSET_Y = 9
const PTNVIEW_HEIGHT = SCRH - PTNVIEW_OFFSET_Y
const COLSIZE = 15
const VOCSIZE = 5

const VIEW_TIMELINE = 0
const VIEW_ORDERS = 1
const VIEW_INSTRUMENT = 2
const VIEW_PATTERN_DETAILS = 3

const colPlayback  = 40
const colHighlight = 41
const colRowNum    = 249
const colRowNumEmph1 = 180
const colStatus    = 253
const colVoiceHdr  = 230
const colSep       = 252

let separatorStyle = 0

function fillLine(y, c, back) {
    con.color_pair(c, back)
    for (let x = 1; x <= SCRW; x++) {
        con.move(y, x); con.addch(32)
    }
}

function drawStatusBar() {
    fillLine(1, colStatus, 255)
    const maxCue = song.lastActiveCue < 0 ? 0 : song.lastActiveCue
    const vHi    = Math.min(voiceOff + VOCSIZE, song.numVoices)
    const txt = `${song.filePath}   Cue ${cueIdx.hex03()}/${maxCue.hex03()}   Row ${cursorRow.dec02()}   V${(voiceOff+1).dec02()}-${vHi.dec02()}/${song.numVoices.dec02()}   BPM ${song.bpm} Spd ${song.tickRate} `
    con.move(1, 1)
    con.color_pair(colStatus, 255)
    print(txt)
}

/**
 * @param style 0: condensed timeline, 1: vertical bars between voices
 */
function drawSeparators(style) {
    if (style == 1) {
        con.color_pair(colSep, 255)
        for (let c = 0; c < VOCSIZE - 1; c++) {
            for (let y = PTNVIEW_OFFSET_Y - 1; y < PTNVIEW_HEIGHT; y++) {
                con.move(y, PTNVIEW_OFFSET_X + COLSIZE * (c+1) - 1)
                con.prnch(0xB3)
            }
        }
    }
    else {
        // paint the first column of pattern view with colour
        for (let x = PTNVIEW_OFFSET_X; x < SCRW - 3; x += COLSIZE) {
            for (let y = 0; y < PTNVIEW_HEIGHT+1; y++) {
                let memOffset = (y+PTNVIEW_OFFSET_Y-2) * SCRW + (x-1)
                let bgColOffset = GPU_MEM - TEXT_BACK_OFF - memOffset
                sys.poke(bgColOffset, colHighlight)
            }
        }

        con.color_pair(colSep, 255)
    }
}

function drawVoiceHeaders() {
    fillLine(PTNVIEW_OFFSET_Y - 1, colVoiceHdr, 255)
    const cue = song.cues[cueIdx]
    for (let c = 0; c < VOCSIZE; c++) {
        const voice = voiceOff + c
        const x = PTNVIEW_OFFSET_X + COLSIZE * c
        con.move(PTNVIEW_OFFSET_Y - 1, x)
        if (voice >= song.numVoices) {
            con.color_pair(colVoiceHdr, 255)
            print(`                  `.substring(0, COLSIZE - 1))
        } else {
            const isCursor = (voice === cursorVox)
            const isMuted  = voiceMutes[voice]
            con.color_pair(isMuted ? 249 : colVoiceHdr, isCursor ? colHighlight : 255)
            const ptnIdx = cue.ptns[voice]
            const vlabel = `V${(voice+1).dec02()}`
            const plabel = (ptnIdx === CUE_EMPTY) ? '---' : ptnIdx.hex03()
            const label = `  ${vlabel} ptn ${plabel}    `
            print((label + '                  ').substring(0, COLSIZE - 1))
        }
    }

    drawSeparators(separatorStyle)
}

function drawPatternRowAt(viewRow) {
    const actualRow = scrollRow + viewRow
    const y = PTNVIEW_OFFSET_Y + viewRow
    const highlight = (actualRow === cursorRow)
    const back = highlight ? (playbackMode !== PLAYMODE_NONE ? colPlayback : colHighlight) : colBackPtn
    const cue = song.cues[cueIdx]

    con.color_pair(colRowNum, back)
    if (actualRow < ROWS_PER_PAT) {
        if (actualRow % 4 == 0) {con.color_pair(colRowNumEmph1, back)}
        let rowstr = actualRow.dec02()
        con.move(y, 1); con.prnch(rowstr.charCodeAt(0)); con.move(y, 2); con.prnch(rowstr.charCodeAt(1))
        con.move(y, SCRW-2); con.prnch(rowstr.charCodeAt(0)); con.move(y, SCRW-1); con.prnch(rowstr.charCodeAt(1))
    }
    else {
        print('      ')
    }
    // TODO scroll indicator on x=SCRW?

    for (let c = 0; c < VOCSIZE; c++) {
        const voice = voiceOff + c
        const x = PTNVIEW_OFFSET_X + COLSIZE * c
        let cell = EMPTY_CELL
        if (actualRow < ROWS_PER_PAT && voice < song.numVoices) {
            const ptnIdx = cue.ptns[voice]
            if (ptnIdx !== CUE_EMPTY && ptnIdx < song.numPats) {
                cell = buildRowCell(song.patterns[ptnIdx], actualRow)
            }
        }
        drawCellAt(y, x, cell, back)
    }

    drawSeparators(separatorStyle)
}

function drawPatternView() {
    for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) drawPatternRowAt(vr)
}

function drawControlHint() {
    let hintElem = [
        [`\u008424u\u008425u`,'Row'],
        [`\u008427u\u008426u`,'Vox'],
        [`Pg\u008424u\u008425u`,'Ptn'],
    ['sep'],
        ['F5','Song'],
        ['F6','Cue'],
        ['F7','Row'],
        ['F8/Sp','Stop'],
    ['sep'],
        ['m','Mute'],
        ['s','Solo']
    ]

    // erase current line
    con.move(SCRH, 1)
    print(' '.repeat(SCRW-1))

    // start writing
    con.move(SCRH, 1)
    hintElem.forEach((pair, i, list) => {
        con.color_pair(colStatus,255)
        if (pair[0] == 'sep') {
            print(` ${BIGDOT} `)
        }
        else {
            if (i > 0 && list[i-1][0] != 'sep') print(' ');
            con.color_pair(colVoiceHdr,255)
            print(pair[0]+' ')
            con.color_pair(colStatus,255)
            print(pair[1])
        }
    })
}

function toggleMute(vox) {
    voiceMutes[vox] = !voiceMutes[vox]
    audio.setVoiceMute(PLAYHEAD, vox, voiceMutes[vox])
    drawVoiceHeaders()
}

function toggleSolo(vox) {
    let inSolo = true
    for (let i = 0; i < song.numVoices; i++) {
        if (i !== vox && !voiceMutes[i]) { inSolo = false; break }
    }
    if (inSolo) {
        for (let i = 0; i < song.numVoices; i++) {
            voiceMutes[i] = false
            audio.setVoiceMute(PLAYHEAD, i, false)
        }
    } else {
        for (let i = 0; i < song.numVoices; i++) {
            const m = (i !== vox)
            voiceMutes[i] = m
            audio.setVoiceMute(PLAYHEAD, i, m)
        }
    }
    drawVoiceHeaders()
}

function drawVoiceDetail() {
    const cue = song.cues[cueIdx]
    const ptnIdx = cue.ptns[cursorVox]
    if (ptnIdx === CUE_EMPTY || ptnIdx >= song.numPats) return
    const ptn = song.patterns[ptnIdx]
    const ptnOff = 8 * cursorRow
    const ptnDat = ptn.slice(ptnOff, ptnOff + 8)

    const note = ptnDat[0] | (ptnDat[1] << 8)
    const inst = ptnDat[2]
    const voleff = ptnDat[3]
    const voleffop = (voleff >>> 6) & 3
    const voleffarg = voleff & 63
    const paneff = ptnDat[4]
    const paneffop = (paneff >>> 6) & 3
    const paneffarg = paneff & 63
    const effop = ptnDat[5]
    const effarg = ptnDat[6] | (ptnDat[7] << 8)

    con.move(6,1)
    print(`Pattern $${ptnIdx.hex02()}\tRow ${cursorRow.dec02()}\tVoice ${cursorVox+1}`)
    con.move(7,1)
    print(`Pitch $${note.hex04()}\tInst $${inst.hex02()}\tVolEff ${voleffop}.$${voleffarg.hex02()}\t`+
    `PanEff ${paneffop}.$${paneffarg.hex02()}\tFx ${effop.toString(36).toUpperCase()}.${effarg.hex04()}`)
}

function drawAll() {
    con.clear()
    drawStatusBar()
    drawVoiceHeaders()
    drawPatternView()
    drawVoiceDetail()
    drawSeparators(separatorStyle)
    drawControlHint()
    con.move(1, 1)
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// FAST SCROLL — shifts the pattern area in text VRAM so we only redraw newly exposed rows
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Graphics adapter text-area layout (see GraphicsAdapter.kt):
//   foreground-colour plane: offset 2
//   background-colour plane: offset 2 + 2560
//   character plane:         offset 2 + 2560 + 2560 = 5122
// Each plane is indexed as y * SCRW + x.  Peripheral byte k lives at gpuMem - k.
const GPU_MEM       = graphics.getGpuMemBase() - (250880+4+12+1008+2046)
const TEXT_FORE_OFF = 2
const TEXT_BACK_OFF = 2 + 2560
const TEXT_CHAR_OFF = 2 + 2560 + 2560
const TEXT_PLANES   = [TEXT_CHAR_OFF, TEXT_BACK_OFF, TEXT_FORE_OFF]

// One scratch strip, reused across shifts
const SCRATCH_PTR = sys.malloc(SCRW * PTNVIEW_HEIGHT)

// Horizontal salvage: 3 carried voice columns minus the missing trailing separator.
// For shift-left: source x=23..75 (old cols 1,2,3); dest x=5..57 (new cols 0,1,2).
// For shift-right: source x=5..57 (old cols 0,1,2); dest x=23..75 (new cols 1,2,3).
// The separator at the boundary of the exposed column is already in place after
// the shift (it was never overwritten), so no extra separator fix-up is needed.
const SALVAGE_HORIZ_LEN = (VOCSIZE - 1) * COLSIZE - 1  // 53 chars

/**
 * Shift the pattern-view rows by `dy` lines (positive = down, negative = up)
 * using bulk peri→main→peri memcpy for speed.  Does not touch status bar,
 * voice headers, or anything outside the pattern viewport.
 */
function shiftPatternArea(dy) {
    if (dy === 0) return
    const absDy = (dy < 0) ? -dy : dy
    if (absDy >= PTNVIEW_HEIGHT) return  // nothing to salvage, caller should full-redraw

    const srcTopY = (dy > 0) ? PTNVIEW_OFFSET_Y : (PTNVIEW_OFFSET_Y + absDy)
    const dstTopY = (dy > 0) ? (PTNVIEW_OFFSET_Y + absDy) : PTNVIEW_OFFSET_Y
    const stripBytes = (PTNVIEW_HEIGHT - absDy) * SCRW

    for (let p = 0; p < 3; p++) {
        const chanOff = TEXT_PLANES[p]
        const srcAddr = GPU_MEM - chanOff - (srcTopY - 1) * SCRW
        const dstAddr = GPU_MEM - chanOff - (dstTopY - 1) * SCRW
        sys.memcpy(srcAddr, SCRATCH_PTR, stripBytes)
        sys.memcpy(SCRATCH_PTR, dstAddr, stripBytes)
    }
}

/**
 * Shift the voice columns left (dVoice > 0) or right (dVoice < 0) by one column
 * using per-row peri→main→peri memcpy.  Only the pattern-view rows are touched;
 * voice headers and status bar must be redrawn by the caller.
 */
function shiftPatternAreaHorizontal(dVoice) {
    // Column of the first char to copy (1-indexed); dest is COLSIZE chars earlier/later.
    const srcX = PTNVIEW_OFFSET_X + (dVoice > 0 ? COLSIZE : 0)
    const dstX = PTNVIEW_OFFSET_X + (dVoice > 0 ? 0 : COLSIZE)
    const srcOff = srcX - 1  // 0-indexed offset from column 1 for address arithmetic
    const dstOff = dstX - 1

    for (let p = 0; p < 3; p++) {
        const chanOff = TEXT_PLANES[p]
        for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) {
            const rowBase = GPU_MEM - chanOff - (PTNVIEW_OFFSET_Y + vr - 1) * SCRW
            sys.memcpy(rowBase - srcOff, SCRATCH_PTR, SALVAGE_HORIZ_LEN)
            sys.memcpy(SCRATCH_PTR, rowBase - dstOff, SALVAGE_HORIZ_LEN)
        }
    }
}

/**
 * Redraw every row of one voice column (slot 0..VOCSIZE-1) after a horizontal shift.
 * Also redraws separators for the whole row so any separator at the exposed boundary
 * (which the VRAM shift left correct) is confirmed visually consistent.
 */
function drawVoiceColumnAt(slot) {
    const voice  = voiceOff + slot
    const x      = PTNVIEW_OFFSET_X + COLSIZE * slot
    const cue    = song.cues[cueIdx]
    const ptnIdx = (voice < song.numVoices) ? cue.ptns[voice] : CUE_EMPTY

    for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) {
        const actualRow = scrollRow + vr
        const y         = PTNVIEW_OFFSET_Y + vr
        const highlight = (actualRow === cursorRow)
        const back      = highlight ? (playbackMode !== PLAYMODE_NONE ? colPlayback : colHighlight) : colBackPtn

        let cell = EMPTY_CELL
        if (actualRow < ROWS_PER_PAT && voice < song.numVoices &&
                ptnIdx !== CUE_EMPTY && ptnIdx < song.numPats) {
            cell = buildRowCell(song.patterns[ptnIdx], actualRow)
        }
        drawCellAt(y, x, cell, back)
    }
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// APPLICATION STUB
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

con.curs_set(0)

let currentPanel = VIEW_TIMELINE
let cueIdx    = 0
let cursorRow = 0
let scrollRow = 0
let voiceOff  = 0
let cursorVox = 0

if (exec_args[1] === undefined) {
    println(`Usage: ${exec_args[0]} path_to.taud`)
    return 1
}

const fullPathObj = _G.shell.resolvePathInput(exec_args[1])
if (fullPathObj === undefined) {
    println(`taut: cannot resolve path: ${exec_args[1]}`)
    return 1
}

const song = loadTaud(fullPathObj.full, 0)

const voiceMutes = new Array(NUM_VOICES).fill(false)

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// PLAYBACK STATE
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

const PLAYHEAD = 0

const PLAYMODE_NONE = 0
const PLAYMODE_SONG = 1
const PLAYMODE_CUE  = 2
const PLAYMODE_ROW  = 3

let playbackMode = PLAYMODE_NONE
let playStartCue = 0
let playStartRow = 0
let pbCue = 0
let pbRow = 0

function startPlaySong() {
    audio.stop(PLAYHEAD)
    audio.setCuePosition(PLAYHEAD, cueIdx)
    audio.setTrackerRow(PLAYHEAD, 0)
    cursorRow = 0
    clampCursor()
    pbCue = cueIdx
    pbRow = 0
    playbackMode = PLAYMODE_SONG
    audio.play(PLAYHEAD)
}

function startPlayCue() {
    audio.stop(PLAYHEAD)
    audio.setCuePosition(PLAYHEAD, cueIdx)
    audio.setTrackerRow(PLAYHEAD, 0)
    playStartCue = cueIdx
    cursorRow = 0
    clampCursor()
    pbCue = cueIdx
    pbRow = 0
    playbackMode = PLAYMODE_CUE
    audio.play(PLAYHEAD)
}

function startPlayRow() {
    audio.stop(PLAYHEAD)
    audio.setCuePosition(PLAYHEAD, cueIdx)
    audio.setTrackerRow(PLAYHEAD, cursorRow)
    playStartCue = cueIdx
    playStartRow = cursorRow
    pbCue = cueIdx
    pbRow = cursorRow
    playbackMode = PLAYMODE_ROW
    audio.play(PLAYHEAD)
}

function stopPlayback() {
    audio.stop(PLAYHEAD)
    playbackMode = PLAYMODE_NONE
}

function updatePlayback() {
    if (!audio.isPlaying(PLAYHEAD)) {
        playbackMode = PLAYMODE_NONE
        if (cursorRow >= scrollRow && cursorRow < scrollRow + PTNVIEW_HEIGHT)
            drawPatternRowAt(cursorRow - scrollRow)
        drawStatusBar()
        return
    }

    const nowCue = audio.getCuePosition(PLAYHEAD)
    const nowRow = audio.getTrackerRow(PLAYHEAD)

    if (playbackMode === PLAYMODE_CUE && nowCue !== playStartCue) {
        stopPlayback()
        drawAll()
        return
    }
    if (playbackMode === PLAYMODE_ROW && (nowRow !== playStartRow || nowCue !== playStartCue)) {
        stopPlayback()
        if (cursorRow >= scrollRow && cursorRow < scrollRow + PTNVIEW_HEIGHT)
            drawPatternRowAt(cursorRow - scrollRow)
        drawStatusBar()
        return
    }

    if (nowCue === pbCue && nowRow === pbRow) return

    pbCue = nowCue
    pbRow = nowRow

    if (nowCue !== cueIdx) {
        cueIdx = nowCue
        cursorRow = nowRow
        clampCursor()
        drawAll()
    } else {
        const oldCursor = cursorRow
        const oldScroll = scrollRow
        cursorRow = nowRow
        clampCursor()
        const dScroll = scrollRow - oldScroll
        if (dScroll === 0) {
            drawPatternRowAt(oldCursor - scrollRow)
            drawPatternRowAt(cursorRow - scrollRow)
        } else if (Math.abs(dScroll) >= PTNVIEW_HEIGHT) {
            drawPatternView()
        } else {
            shiftPatternArea(-dScroll)
            if (dScroll > 0) {
                for (let i = 0; i < dScroll; i++) drawPatternRowAt(PTNVIEW_HEIGHT - 1 - i)
            } else {
                for (let i = 0; i < -dScroll; i++) drawPatternRowAt(i)
            }
            if (oldCursor >= scrollRow && oldCursor < scrollRow + PTNVIEW_HEIGHT)
                drawPatternRowAt(oldCursor - scrollRow)
            drawPatternRowAt(cursorRow - scrollRow)
        }
        drawStatusBar()
        drawSeparators(separatorStyle)
        drawVoiceDetail()
    }
}

function clampCursor() {
    if (cursorRow < 0) cursorRow = 0
    if (cursorRow >= ROWS_PER_PAT) cursorRow = ROWS_PER_PAT - 1
    if (cursorRow < scrollRow) scrollRow = cursorRow
    // these two IF statements will keep the cursor at the centre until viewpoint scroll edge has reached
    if (cursorRow < scrollRow + (PTNVIEW_HEIGHT>>>1) && scrollRow > 0) scrollRow = cursorRow - (PTNVIEW_HEIGHT>>>1)
    if (cursorRow >= scrollRow + ((PTNVIEW_HEIGHT+1)>>>1)) scrollRow = cursorRow - ((PTNVIEW_HEIGHT+1)>>>1) + 1
    if (scrollRow < 0) scrollRow = 0
    if (scrollRow + PTNVIEW_HEIGHT > ROWS_PER_PAT)
        scrollRow = Math.max(0, ROWS_PER_PAT - PTNVIEW_HEIGHT)
}

function clampVoice() {
    if (cursorVox < 0) cursorVox = 0
    if (cursorVox >= song.numVoices) cursorVox = song.numVoices - 1
    if (cursorVox < voiceOff) voiceOff = cursorVox
    if (cursorVox >= voiceOff + VOCSIZE) voiceOff = cursorVox - VOCSIZE + 1
    const maxOff = Math.max(0, song.numVoices - VOCSIZE)
    if (voiceOff < 0) voiceOff = 0
    if (voiceOff > maxOff) voiceOff = maxOff
}

function clampCue() {
    const maxCue = song.lastActiveCue < 0 ? 0 : song.lastActiveCue
    if (cueIdx < 0) cueIdx = 0
    if (cueIdx > maxCue) cueIdx = maxCue
}

clampCursor(); clampVoice(); clampCue()
drawAll()

audio.resetParams(PLAYHEAD)
audio.purgeQueue(PLAYHEAD)
audio.stop(PLAYHEAD)
taud.uploadTaudFile(fullPathObj.full, 0, PLAYHEAD)
audio.setMasterVolume(PLAYHEAD, 255)
audio.setMasterPan(PLAYHEAD, 128)

let exitFlag = false
while (!exitFlag) {
    input.withEvent(event => {
        if (event[0] !== "key_down") return
        const keysym = event[1]

        if (keysym === "<ESC>" || keysym === "q" || keysym === "Q") {
            exitFlag = true
            return
        }

        if (playbackMode !== PLAYMODE_NONE) {
            if (keysym === "<F8>" || keysym === " ") { stopPlayback(); drawAll() }
            else if (keysym === "<LEFT>" || keysym === "<RIGHT>") {
                const oldVoiceOff = voiceOff
                cursorVox += (keysym === "<LEFT>") ? -1 : 1
                clampVoice()
                const dVoice = voiceOff - oldVoiceOff
                if (dVoice !== 0) {
                    shiftPatternAreaHorizontal(dVoice)
                    drawVoiceColumnAt(dVoice > 0 ? VOCSIZE - 1 : 0)
                }
                drawVoiceHeaders()
                drawSeparators(separatorStyle)
                drawStatusBar()
            }
            else if (keysym === "m" || keysym === "M") { toggleMute(cursorVox) }
            else if (keysym === "s" || keysym === "S") { toggleSolo(cursorVox) }
            return
        }

        if (keysym === "<F5>") { startPlaySong(); drawAll(); return }
        if (keysym === "<F6>") { startPlayCue();  drawAll(); return }
        if (keysym === "<F7>") { startPlayRow();  drawPatternRowAt(cursorRow - scrollRow); return }
        if (keysym === "<F8>" || keysym === " ") { stopPlayback(); return }

        const oldCursor = cursorRow
        const oldScroll = scrollRow
        let rowMove = false       // pure row-cursor movement; can be fast-path
        let fullRedraw = false    // voice/cue change; needs full viewport refresh

        if (keysym === "<LEFT>" || keysym === "<RIGHT>") {
            const oldVoiceOff = voiceOff
            cursorVox += (keysym === "<LEFT>") ? -1 : 1
            clampVoice()
            const dVoice = voiceOff - oldVoiceOff
            if (dVoice !== 0) {
                shiftPatternAreaHorizontal(dVoice)
                drawVoiceColumnAt(dVoice > 0 ? VOCSIZE - 1 : 0)
            }
            drawVoiceHeaders()
            drawSeparators(separatorStyle)
            drawStatusBar()
            drawVoiceDetail()
            return
        }

        if (keysym === "m" || keysym === "M") { toggleMute(cursorVox); return }
        if (keysym === "s" || keysym === "S") { toggleSolo(cursorVox); return }

        if (keysym === "<UP>")             { cursorRow -= 1;               rowMove = true }
        else if (keysym === "<DOWN>")      { cursorRow += 1;               rowMove = true }
        else if (keysym === "<HOME>")      { cursorRow  = 0;               rowMove = true }
        else if (keysym === "<END>")       { cursorRow  = ROWS_PER_PAT-1;  rowMove = true }
        else if (keysym === "<PAGE_UP>")   { cueIdx    -= 1;               fullRedraw = true }
        else if (keysym === "<PAGE_DOWN>") { cueIdx    += 1;               fullRedraw = true }
        else return

        clampCursor(); clampVoice(); clampCue()

        if (fullRedraw) {
            drawAll()
            return
        }

        if (!rowMove || cursorRow === oldCursor) return

        const dScroll = scrollRow - oldScroll
        if (dScroll === 0) {
            // in-viewport cursor move: just flip the two affected rows
            drawPatternRowAt(oldCursor - scrollRow)
            drawPatternRowAt(cursorRow - scrollRow)
        }
        else if (Math.abs(dScroll) >= PTNVIEW_HEIGHT) {
            // huge jump, nothing salvageable
            drawPatternView()
        }
        else {
            // scroll: shift VRAM, then redraw only newly exposed edge rows
            shiftPatternArea(-dScroll)
            if (dScroll > 0) {
                for (let i = 0; i < dScroll; i++)
                    drawPatternRowAt(PTNVIEW_HEIGHT - 1 - i)
            } else {
                for (let i = 0; i < -dScroll; i++)
                    drawPatternRowAt(i)
            }
            // The old cursor row, if still visible, carried its highlight along with the shift — unhighlight it
            if (oldCursor >= scrollRow && oldCursor < scrollRow + PTNVIEW_HEIGHT)
                drawPatternRowAt(oldCursor - scrollRow)
            // The new cursor row always needs highlight
            drawPatternRowAt(cursorRow - scrollRow)
        }

        drawSeparators(separatorStyle)
        drawStatusBar()
        drawVoiceDetail()
    })

    if (playbackMode !== PLAYMODE_NONE) updatePlayback()
}

audio.stop(PLAYHEAD)
sys.free(SCRATCH_PTR)
con.clear()
con.move(1, 1)
con.curs_set(1)
return 0