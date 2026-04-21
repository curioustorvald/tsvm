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

csharp:"\u0098",
cflat:"\u0098",
uptick:"\u009A",
dntick:"\u009B",
doubleuptick:"\u009C",
doubledntick:"\u009D",


/* special notes */
keyoff:"\u00A0\u00CD\u00CD\u00A1",
notecut:"\u00A4\u00A4\u00A4\u00A4",

/* miscellaneous */
unticked:"\u009E",
ticked:"\u009F",
}

const pitchTablePresets = [
{name:"null", table:[], sym:[]},
/* Xenharmonic, equal temperament */
{name:"5-TET", table:[0x0,0x333,0x666,0x99A,0xCCD],},
{name:"7-TET", table:[0x0,0x249,0x492,0x6DB,0x925,0xB6E,0xDB7],},
{name:"10-TET", table:[0x0,0x19A,0x333,0x4CD,0x666,0x800,0x99A,0xB33,0xCCD,0xE66],},
{name:"16-TET", table:[0x0,0x100,0x200,0x300,0x400,0x500,0x600,0x700,0x800,0x900,0xA00,0xB00,0xC00,0xD00,0xE00,0xF00],},
{name:"19-TET", table:[0x0,0xD8,0x1AF,0x287,0x35E,0x436,0x50D,0x5E5,0x6BD,0x794,0x86C,0x943,0xA1B,0xAF3,0xBCA,0xCA2,0xD79,0xE51,0xF28],},
{name:"22-TET", table:[0x0,0xBA,0x174,0x22F,0x2E9,0x3A3,0x45D,0x517,0x5D1,0x68C,0x746,0x800,0x8BA,0x974,0xA2F,0xAE9,0xBA3,0xC5D,0xD17,0xDD1,0xE8C,0xF46]},,
{name:"24-TET", table:[0x0,0xAB,0x155,0x200,0x2AB,0x355,0x400,0x4AB,0x555,0x600,0x6AB,0x755,0x800,0x8AB,0x955,0xA00,0xAAB,0xB55,0xC00,0xCAB,0xD55,0xE00,0xEAB,0xF55],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},

{name:"31-TET", table:[0x0,0x84,0x108,0x18C,0x211,0x295,0x319,0x39D,0x421,0x4A5,0x529,0x5AD,0x632,0x6B6,0x73A,0x7BE,0x842,0x8C6,0x94A,0x9CE,0xA53,0xAD7,0xB5B,0xBDF,0xC63,0xCE7,0xD6B,0xDEF,0xE74,0xEF8,0xF7C],
sym:[`C${sym.accnull}`,`C${sym.demisharp}`,`C${sym.sharp}`,`D${sym.flat}`,`D${sym.demiflat}`,`D${sym.accnull}`,`D${sym.demisharp}`,`D${sym.sharp}`,`E${sym.flat}`,`E${sym.demiflat}`,`E${sym.accnull}`,`E${sym.demisharp}`,`F${sym.demiflat}`,`F${sym.accnull}`,`F${sym.demisharp}`,`F${sym.sharp}`,`G${sym.flat}`,`G${sym.demiflat}`,`G${sym.accnull}`,`G${sym.demisharp}`,`G${sym.sharp}`,`A${sym.flat}`,`A${sym.demiflat}`,`A${sym.accnull}`,`A${sym.demisharp}`,`A${sym.sharp}`,`B${sym.flat}`,`B${sym.demiflat}`,`B${sym.accnull}`,`B${sym.demisharp}`,`C${sym.demiflat}`]},
{name:"53-TET Pythagorean Notation", table:[0x0,0x4D,0x9B,0xE8,0x135,0x182,0x1D0,0x21D,0x26A,0x2B8,0x305,0x352,0x39F,0x3ED,0x43A,0x487,0x4D5,0x522,0x56F,0x5BC,0x60A,0x657,0x6A4,0x6F2,0x73F,0x78C,0x7D9,0x827,0x874,0x8C1,0x90E,0x95C,0x9A9,0x9F6,0xA44,0xA91,0xADE,0xB2B,0xB79,0xBC6,0xC13,0xC61,0xCAE,0xCFB,0xD48,0xD96,0xDE3,0xE30,0xE7E,0xECB,0xF18,0xF65,0xFB3],
sym:[`C${sym.accnull}`,`B${sym.sharp}`,`A${sym.triplesharp}`,`E${sym.tripleflat}`,`D${sym.flat}`,`C${sym.sharp}`,`B${sym.doublesharp}`,`F${sym.tripleflat}`,`E${sym.doubleflat}`,`D${sym.accnull}`,`C${sym.doublesharp}`,`B${sym.triplesharp}`,`F${sym.doubleflat}`,`E${sym.flat}`,`D${sym.sharp}`,`C${sym.triplesharp}`,`G${sym.tripleflat}`,`F${sym.flat}`,`E${sym.accnull}`,`D${sym.doublesharp}`,`C${sym.quadsharp}`,`G${sym.doubleflat}`,`F${sym.accnull}`,`E${sym.sharp}`,`D${sym.triplesharp}`,`A${sym.tripleflat}`,`G${sym.flat}`,`F${sym.sharp}`,`E${sym.doublesharp}`,`D${sym.quadsharp}`,`A${sym.doubleflat}`,`G${sym.accnull}`,`F${sym.doublesharp}`,`E${sym.triplesharp}`,`B${sym.tripleflat}`,`A${sym.flat}`,`G${sym.sharp}`,`F${sym.triplesharp}`,`C${sym.tripleflat}`,`B${sym.doubleflat}`,`A${sym.accnull}`,`G${sym.doublesharp}`,`F${sym.quadsharp}`,`C${sym.doubleflat}`,`B${sym.flat}`,`A${sym.sharp}`,`G${sym.triplesharp}`,`D${sym.tripleflat}`,`C${sym.flat}`,`B${sym.accnull}`,`A${sym.doublesharp}`,`G${sym.quadsharp}`,`D${sym.doubleflat}`]},
{name:"53-TET Microtonal Notation", table:[0x0,0x4D,0x9B,0xE8,0x135,0x182,0x1D0,0x21D,0x26A,0x2B8,0x305,0x352,0x39F,0x3ED,0x43A,0x487,0x4D5,0x522,0x56F,0x5BC,0x60A,0x657,0x6A4,0x6F2,0x73F,0x78C,0x7D9,0x827,0x874,0x8C1,0x90E,0x95C,0x9A9,0x9F6,0xA44,0xA91,0xADE,0xB2B,0xB79,0xBC6,0xC13,0xC61,0xCAE,0xCFB,0xD48,0xD96,0xDE3,0xE30,0xE7E,0xECB,0xF18,0xF65,0xFB3],
sym:[`-C-`,`${sym.uptick}C-`,`${sym.doubleuptick}C-`,`${sym.doubledntick}C${sym.csharp}`,`${sym.dntick}C${sym.csharp}`,`-C${sym.csharp}`,`${sym.uptick}C${sym.csharp}`,`${sym.doubledntick}D-`,`${sym.dntick}D-`,`-D-`,`${sym.uptick}D-`,`${sym.doubleuptick}D-`,`${sym.doubledntick}D${sym.csharp}`,`${sym.dntick}D${sym.csharp}`,`-D${sym.csharp}`,`${sym.uptick}D${sym.csharp}`,`${sym.doubledntick}E-`,`${sym.dntick}E-`,`-E-`,`${sym.uptick}E-`,`${sym.doubleuptick}E-`,`${sym.dntick}F-`,`-F-`,`${sym.uptick}F-`,`${sym.doubleuptick}F-`,`${sym.doubledntick}F${sym.csharp}`,`${sym.dntick}F${sym.csharp}`,`-F${sym.csharp}`,`${sym.uptick}F${sym.csharp}`,`${sym.doubledntick}G-`,`${sym.dntick}G-`,`-G-`,`${sym.uptick}G-`,`${sym.doubleuptick}G-`,`${sym.doubledntick}G${sym.csharp}`,`${sym.dntick}G${sym.csharp}`,`-G${sym.csharp}`,`${sym.uptick}G${sym.csharp}`,`${sym.doubledntick}A-`,`${sym.dntick}A-`,`-A-`,`${sym.uptick}A-`,`${sym.doubleuptick}A-`,`${sym.doubledntick}A${sym.csharp}`,`${sym.dntick}A${sym.csharp}`,`-A${sym.csharp}`,`${sym.uptick}A${sym.csharp}`,`${sym.doubledntick}B-`,`${sym.dntick}B-`,`-B-`,`${sym.uptick}B-`,`${sym.doubleuptick}B-`,`${sym.dntick}C-`]},
/* 12-TET variations */
{name:"12-TET",                         table:[0x0,0x155,0x2AB,0x400,0x555,0x6AB,0x800,0x955,0xAAB,0xC00,0xD55,0xEAB],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},
{name:"Pythagorean Diminished Fifth", table:[0x0,0x134,0x2B8,0x3EC,0x570,0x6A4,0x7D8,0x95C,0xA90,0xC14,0xD48,0xECC],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},
{name:"Pythagorean Augmented Fourth", table:[0x0,0x134,0x2B8,0x3EC,0x570,0x6A4,0x828,0x95C,0xA90,0xC14,0xD48,0xECC],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},
{name:"Shierlu",                         table:[0x0,0x184,0x2B8,0x43C,0x570,0x6F4,0x828,0x95C,0xAE0,0xC14,0xD98,0xECC],
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},



]



pitchTablePresets[9].sym.forEach(s => print(s+'3\t')); println()
pitchTablePresets[10].sym.forEach(s => print(s+'3\t')); println()
pitchTablePresets[11].sym.forEach(s => print(s+'3\t')); println()