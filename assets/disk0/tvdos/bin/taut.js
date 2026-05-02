/**
 * TSVM Audio Device Tracker
 *
 * Created by minjaesong on 2026-04-20
 */

const win = require("wintex")
const font = require("font")
const taud = require("taud")
const keys = require("keysym")
const gl = require("gl")

const BUILD_DATE = "260424"
const TRACKER_SIGNATURE = "TsvmTaut"+BUILD_DATE // 14-byte string

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

/* Fx/Vx/Px */
fx:'\u00F8',
px:'\u00AC',
vx:'\u00AD',

/* transport control */
playall:'\u00A8',
playcue:'\u00A9',
playrow:'\u00AA',
stop:'\u00AB',

/* miscellaneous */
unticked:"\u00AE",
ticked:"\u00AF",
middot:MIDDOT,
doubledot:"\u008419u",
statusstop:"\u008420u\u008421u",
statusplay:"\u008422u\u008423u",
playhead:"\u00A7",

leftshade:'\u00B0',
rightshade:'\u00B2',
}

const fxNames = {
'0':"--           ",
'1':"Mixer config ",
'2':"UNIMPLEMENTED",
'3':"UNIMPLEMENTED",
'4':"UNIMPLEMENTED",
'5':"UNIMPLEMENTED",
'6':"UNIMPLEMENTED",
'7':"UNIMPLEMENTED",
'8':"Bitcrusher   ",
'9':"UNIMPLEMENTED",
A:"Tick speed   ",
B:"Jump to order",
C:"Break pattern",
D:"Volume slide ",
E:"Pitch down   ",
F:"Pitch up     ",
G:"Portamento   ",
H:"Vibrato      ",
I:"Tremor       ",
J:"Arpeggio     ",
K:"UNIMPLEMENTED", // Volume slide+Vibrato. Use H0000 and VolEff instead
L:"UNIMPLEMENTED", // Volume slide+Portamento. Use G0000 and VolEff instead
M:"UNIMPLEMENTED", // IT: Set channel volume. Use VolEff instead
N:"UNIMPLEMENTED", // IT: Channel volume slide. Use VolEff instead
O:"Sample offset",
P:"UNIMPLEMENTED", // IT: panning slide. Use PanEff instead
Q:"Retrigger    ",
R:"Tremolo      ",
S:"Special      ",
S0:"UNIMPLEMENTED", // PT: Set audio filter.
S1:"Gliss. ctrl  ",
S2:"Sample tune  ",
S3:"Vibrato LFO  ",
S4:"Tremolo LFO  ",
S5:"Panbrello LFO",
S6:"UNIMPLEMENTED", // IT: Fine pattern delay.
S7:"UNIMPLEMENTED", // IT: misc. functions
S8:"Channel pan  ", // Taud: 8-bit channel panning.
S9:"UNIMPLEMENTED", // IT: Sound control.
SA:"UNIMPLEMENTED", // SC3: Stereo control. IT: Sample offset high twobyte.
SB:"Pattern loop ",
SC:"Note cut     ",
SD:"Note delay   ",
SE:"Pattern delay",
SF:"Funk it      ",
T:"Tempo        ",
U:"Fine vibrato ",
V:"Global volume",
W:"UNIMPLEMENTED", // IT: Global volume slide.
X:"UNIMPLEMENTED", // IT: 8-bit channel panning. Use PanEff or S80xx instead
Y:"Panbrello    ",
Z:"UNIMPLEMENTED", // IT: MIDI macro.
}
const panFxNames = {
0:"Set to",
1:"Slide L",
2:"Slide R",
3:"Fine slide",
30:"Fine slide L",
31:"Fine slide R",
999:"---",
}
const volFxNames = {
0:"Set to",
1:"Slide UP",
2:"Slide DN",
3:"Fine slide",
30:"Fine slide DN",
31:"Fine slide UP",
999:"---",
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
10123:{index:10123,name:"\u00FC\u00FD\u00FE",         table:[0x0,0x184,0x2B8,0x43C,0x570,0x6F4,0x828,0x95C,0xAE0,0xC14,0xD98,0xECC],
sym:[` \u00E0\u00E1`,` \u00E2\u00E3`,` \u00E4\u00E5`,` \u00E6\u00E7`,` \u00E8\u00E9`,` \u00EA\u00EB`,` \u00EC\u00ED`,` \u00EE\u00EF`,` \u00F0\u00F1`,` \u00F2\u00F3`,` \u00F4\u00F5`,` \u00F6\u00F7`]},



}


const volEffSym = [sym.volset, sym.volup, sym.voldn, sym.volfineup, sym.volfinedn]
const panEffSym = [sym.panset, sym.panle, sym.panri, sym.panfinele, sym.panfineri]

const colNote = 239
const colInst = 114
const colVol = 155
const colPan = 219
const colEffOp = 220
const colEffArg = 231
const colBackPtn = 255

let PITCH_PRESET_IDX = 240 // TODO read from the Project Data section of the .taud
let beatDivPrimary = 4 // TODO read from the Project Data section of the .taud
let beatDivSecondary = 16
let hasUnsavedChanges = false

// pitchSymLut[pitchInOct] = [symString, octaveOffset]
// octaveOffset is 1 when pitchInOct is closer to the next octave's root (wraps up) than to any table entry.
// Call rebuildPitchLut() whenever PITCH_PRESET_IDX changes.
const pitchSymLut = new Array(0x1000)

function rebuildPitchLut() {
    const preset = pitchTablePresets[PITCH_PRESET_IDX]
    if (!preset || preset.table.length === 0) return
    const table = preset.table
    const syms  = preset.sym
    for (let p = 0; p < 0x1000; p++) {
        let best = 0, bestDist = 0x1000
        for (let i = 0; i < table.length; i++) {
            const d = Math.abs(p - table[i])
            if (d < bestDist) { bestDist = d; best = i }
        }
        // Distance to the next octave's root (0x1000) vs nearest table entry.
        if ((0x1000 - p) < bestDist) {
            pitchSymLut[p] = [syms[0], 1]
        } else {
            pitchSymLut[p] = [syms[best], 0]
        }
    }
}
rebuildPitchLut()

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
    if (pitchTablePresets[PITCH_PRESET_IDX].table.length === 0) return note.hex04()
    const [s, o] = pitchSymLut[note & 0xFFF]
    return s + ((note >> 12) - 1 + o)
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
    if (voleff === 0xC0) {
        sVolEff = ''
        sVolArg = sym.middot.repeat(2)
    }
    else if (voleff >>> 6 == 1 || voleff >>> 6 == 2) {
        sVolArg = (voleffarg & 15).hex1()
    }
    else if (voleff >>> 6 == 3) {
        if (voleffarg == 0) {
            sVolEff = sym.middot
            sVolArg = sym.middot
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
    if (paneff === 0xC0) {
        sPanEff = ''
        sPanArg = sym.middot.repeat(2)
    }
    else if (paneff >>> 6 == 1 || paneff >>> 6 == 2) {
        sPanArg = (paneffarg & 15).hex1()
    }
    else if (paneff >>> 6 == 3) {
        if (paneffarg == 0) {
            sPanEff = sym.middot
            sPanArg = sym.middot
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

    return { sNote, sInst, sVolEff, sVolArg, sPanEff, sPanArg, sEffOp, sEffArg,
             _note: note, _effop: effop, _effarg: effarg, _voleff: voleff, _paneff: paneff }
}

const EMPTY_CELL = {
    sNote:   sym.middot.repeat(4),
    sInst:   sym.middot.repeat(2),
    sVolEff: '',
    sVolArg: sym.middot.repeat(2),
    sPanEff: '',
    sPanArg: sym.middot.repeat(2),
    sEffOp:  sym.middot,
    sEffArg: sym.middot.repeat(4),
    _note: 0xFFFF, _effop: 0, _effarg: 0, _voleff: 0, _paneff: 0
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

// Styles: -1 = spaced (dddd ii vv pp effff, 19 chars)
//          0 = compact/current (15 chars)
//          1 = non-NOP preference note/fx + vol/pan (7 chars: 5+2, letters start on border)
//          2 = non-NOP preference note/fx only (5 chars, letters start on border)
function drawCellAtStyled(y, x, cell, back, style) {
    if (style === 0) { drawCellAt(y, x, cell, back); return }
    if (style === -1) {
        con.move(y, x)
        con.color_pair(colNote,    back); print(cell.sNote)
        con.color_pair(colBackPtn, back); print(' ')
        con.color_pair(colInst,    back); print(cell.sInst)
        con.color_pair(colBackPtn, back); print(' ')
        con.color_pair(colVol,     back); print(cell.sVolEff); print(cell.sVolArg)
        con.color_pair(colBackPtn, back); print(' ')
        con.color_pair(colPan,     back); print(cell.sPanEff); print(cell.sPanArg)
        con.color_pair(colBackPtn, back); print(' ')
        con.color_pair(colEffOp,   back); print(cell.sEffOp)
        con.color_pair(colEffArg,  back); print(cell.sEffArg)
        return
    }
    // Styles 1 and 2: note-or-fx field (5 chars) starts on the border column [+ vol-or-pan (2 chars)]
    const noteEmpty = (cell._note === 0xFFFF)
    const fxEmpty   = (cell._effop === 0 && cell._effarg === 0)
    const volEmpty  = (cell._voleff === 0)
    const panEmpty  = (cell._paneff === 0)
    con.move(y, x)
    if (!noteEmpty) {
        con.color_pair(colBackPtn, back); print(' ')
        con.color_pair(colNote,    back); print(cell.sNote)
    } else if (!fxEmpty) {
        con.color_pair(colEffOp,  back); print(cell.sEffOp)
        con.color_pair(colEffArg, back); print(cell.sEffArg)
    } else {
        con.color_pair(colNote, back); print(sym.middot.repeat(5))
    }
    if (style === 1) {
        //con.color_pair(colBackPtn, back); print(' ')
        if (!volEmpty) {
            con.color_pair(colVol, back); print(cell.sVolEff); print(cell.sVolArg)
        } else if (!panEmpty) {
            con.color_pair(colPan, back); print(cell.sPanEff); print(cell.sPanArg)
        } else {
            con.color_pair(colVol, back); print(sym.middot.repeat(2))
        }
    }
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// .TAUD FILE LOADER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

const TAUD_MAGIC       = [0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64]
const TAUD_HEADER_SIZE = 32
const TAUD_SONG_ENTRY  = 32
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
    const patBinCompSize   = _peekU32LE(ptr, entryOff + 18)
    const cueSheetCompSize = _peekU32LE(ptr, entryOff + 22)

    // Decompress pattern bin
    const patBinSize = numPats * PATTERN_SIZE
    const patBinPtr  = sys.malloc(patBinSize)
    gzip.decompFromTo(ptr + songOff, patBinCompSize, patBinPtr)

    const patterns = new Array(numPats)
    for (let p = 0; p < numPats; p++) {
        const ptn = new Uint8Array(PATTERN_SIZE)
        for (let k = 0; k < PATTERN_SIZE; k++) {
            ptn[k] = sys.peek(patBinPtr + p * PATTERN_SIZE + k) & 0xFF
        }
        patterns[p] = ptn
    }
    sys.free(patBinPtr)

    // Decompress cue sheet
    const cueSheetSize = NUM_CUES * CUE_SIZE
    const cueSheetPtr  = sys.malloc(cueSheetSize)
    gzip.decompFromTo(ptr + songOff + patBinCompSize, cueSheetCompSize, cueSheetPtr)

    const cues = new Array(NUM_CUES)
    let lastActiveCue = -1
    for (let c = 0; c < NUM_CUES; c++) {
        const ptns = new Array(NUM_VOICES)
        for (let i = 0; i < 10; i++) {
            const lo = sys.peek(cueSheetPtr + c * CUE_SIZE + i)      & 0xFF
            const mi = sys.peek(cueSheetPtr + c * CUE_SIZE + 10 + i) & 0xFF
            const hi = sys.peek(cueSheetPtr + c * CUE_SIZE + 20 + i) & 0xFF
            ptns[i*2]   = ((hi >> 4) << 8) | ((mi >> 4) << 4) | (lo >> 4)
            ptns[i*2+1] = ((hi & 0xF) << 8) | ((mi & 0xF) << 4) | (lo & 0xF)
        }
        const instr = sys.peek(cueSheetPtr + c * CUE_SIZE + 30) & 0xFF
        cues[c] = { ptns, instr }

        for (let v = 0; v < NUM_VOICES; v++) {
            if (ptns[v] !== CUE_EMPTY) { lastActiveCue = c; break }
        }
    }
    sys.free(cueSheetPtr)

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
const [SCRPW, SCRPH] = graphics.getPixelDimension()
const PTNVIEW_OFFSET_X = 3
const PTNVIEW_OFFSET_Y = 5
const PTNVIEW_HEIGHT = SCRH - PTNVIEW_OFFSET_Y

const TIMELINE_COLSIZES = [15, 7, 5]
let timelineRowStyle      = 0
let COLSIZE_TIMELINE_FULL = TIMELINE_COLSIZES[0]
let VOCSIZE_TIMELINE_FULL = Math.floor((SCRW - 3) / COLSIZE_TIMELINE_FULL)

const ORDERS_CMD_X   = 5
const ORDERS_VOICE_X = 9
const VOCSIZE_ORDERS = Math.floor((SCRW - 8) / 4)

const VIEW_TIMELINE = 0
const VIEW_CUES = 1
const VIEW_PATTERN_DETAILS = 2
const VIEW_SAMPLES  = 3
const VIEW_INSTRMNT = 4
const VIEW_PROJECT  = 5
const VIEW_FILE     = 6

const colPlayback  = 86
const colHighlight = 41
const colColumnSep = 6
const colRowNum    = 250
const colRowNumEmph1 = 225
const colRowNumEmph2 = 155
const colStatus    = 253
const colVoiceHdr  = 230
const colSep       = 252
const colPushBtnBack = 143
const colTabBarBack = 187
const colTabBarBack2 = 136
const colTabBarOrn = 136
const colBrand = 211
const colPopupBack = 245//57
const colTabActive = 239
const colTabInactive = 45

// protip: avoid using colour zero
const colWHITE = 239
const colBLACK = 240

let separatorStyle = 0

const PATEDITOR_LIST_X   = 1
const PATEDITOR_SEP1_X   = 5
const PATEDITOR_GRID_X   = 7
const PATEDITOR_CELL_X   = 10
const PATEDITOR_SEP2_X   = 30
const PATEDITOR_DETAIL_X = 32

const PLAYMODE_NONE = 0
const PLAYMODE_SONG = 1
const PLAYMODE_CUE  = 2
const PLAYMODE_ROW  = 3

function fillLine(y, c, back) {
    con.color_pair(c, back)
    for (let x = 1; x <= SCRW; x++) {
        con.move(y, x); con.addch(32)
    }
}

const TAB_GAP = 3
const PANEL_NAMES = ['Timeline', 'Cues', 'Patterns', 'Samples', 'Instrmnt', 'Project', 'File']

function drawAlwaysOnElems() {
    drawStatusBar()
    drawTabBar()
}

const transportControlReverse = [PLAYMODE_NONE, PLAYMODE_ROW, PLAYMODE_CUE, PLAYMODE_SONG]
const transportControlSymbol = [sym.stop, sym.playrow, sym.playcue, sym.playall]
const transportControlColour = [160,20,20,20]
const transportControlHint = ["O","I","U","Y"]
let transportControlOldPos = 3 // index for transportControlReverse
function drawStatusBar() {
    fillLine(1, colWHITE, 255)
    fillLine(2, colWHITE, 255)

    const sCueIdx = cueIdx.hex03()
    const sCueMax = (song.lastActiveCue < 0 ? 0 : song.lastActiveCue).hex03()
    const vMax = song.numVoices.dec02()
    const vHi = Math.min(voiceOff + VOCSIZE_TIMELINE_FULL, song.numVoices).dec02()
    const vLow = (voiceOff+1).dec02()
    const songPath = song.filePath
    const sRow = cursorRow.dec02()
    const sBPM = ''+audio.getBPM(PLAYHEAD)
    const sSpd = ''+audio.getTickRate(PLAYHEAD)

    // transport control and its control hints
    let transportControlNewPos = transportControlOldPos
    transportControlReverse.forEach((thisMode, j) => {
        let active = (playbackMode == thisMode)

        if (active)
            con.color_pair(transportControlColour[j], 255)
        else
            con.color_pair(colWHITE, 255)

        con.move(1, SCRW - 5*(j+1) + 1 + 2)
        print(transportControlSymbol[j])

        if (active)
            con.color_pair(transportControlColour[j], 255)
        else
            con.color_pair(235, 255)

        con.move(2, SCRW - 5*(j+1) + 1 + 2)
        print(transportControlHint[j])

        if (active) transportControlNewPos = j;
    })

    // draw tob bar background
    gl.drawTexPattern(buttonTexture, 0, 0, SCRPW, 28)
    graphics.plotPixel(0, 0, 255)
    graphics.plotPixel(0, 1, 254)
    graphics.plotPixel(SCRPW-1, 0, 255)
    graphics.plotPixel(SCRPW-1, 1, 254)
    // update pos tracking
    transportControlOldPos = transportControlNewPos


    // current audio device status
    // play/stop sym
    con.color_pair(colWHITE, 255)
    con.move(1,1)
    print(`${sym.playhead}${PLAYHEAD}`)
    con.move(2,1)
    print((playbackMode == PLAYMODE_NONE) ? sym.statusstop : sym.statusplay)

    // beat indicator
    let beatCursorRow = cursorRow
    while (beatCursorRow >= beatDivSecondary) { beatCursorRow -= beatDivSecondary }
    let beatInd = (playbackMode != PLAYMODE_NONE && beatCursorRow % beatDivPrimary < (beatDivPrimary >>> 1)) ?
     ((beatCursorRow % beatDivSecondary < (beatDivPrimary >>> 1)) ? '\u00846u' : '\u00847u') :
     ''

    // cue row
    con.move(1,4)
    con.color_pair(colWHITE, 255); print(`Cue `)
    con.color_pair(20, 255); print(`${sCueIdx}`)
//    con.color_pair(colWHITE, 255); print(`/`)
//    con.color_pair(20, 255); print(`${sCueMax}`)
    con.color_pair(colWHITE, 255); print(`  Row `)
    con.color_pair(130, 255); print(`${sRow}${beatInd}`)

    // bpm spd
    con.move(2,4)
    con.color_pair(colWHITE, 255); print(`BPM `)
    con.color_pair(161, 255); print(`${sBPM}`)
    con.color_pair(colWHITE, 255); print(`  Tick `)
    con.color_pair(235, 255); print(`${sSpd}`)

    // app title
    gl.drawTexImageOver(logoTexture, (SCRPW-logoTexture.width) >>> 1, 7)

}

function drawTabBar() {
    con.color_pair(colTabBarOrn, colTabBarBack)
    con.move(3,1)
    print(`\u00FB`.repeat(SCRW))

    const XOFF = 2
    const YOFF = 3

    con.move(YOFF, XOFF)
    for (let i = 0; i < PANEL_NAMES.length; i++) {
        if (i > 0) con.curs_right(TAB_GAP);
        let tabName = PANEL_NAMES[i]

        let colFore = (currentPanel === i) ? colTabActive : colTabInactive
        let colBack = (currentPanel === i) ? colTabBarBack2 : colTabBarBack
        let colFore2 = (currentPanel === i) ? colTabBarBack2 : colTabBarBack
        let colBack2 = (currentPanel === i) ? colTabBarBack : colTabBarBack
        let spcL = (currentPanel === i) ? sym.leftshade : ' '
        let spcR = (currentPanel === i) ? sym.rightshade : ' '

        con.color_pair(colFore2, colBack2); print(spcL)
        con.color_pair(colFore, colBack); print(tabName)
        con.color_pair(colFore2, colBack2); print(spcR)
    }


    con.color_pair(colStatus, 255)
}

/**
 * @param style 0: condensed timeline, 1: vertical bars between voices
 */
function drawSeparators(style) {
    if (style == 1) {
        con.color_pair(colSep, 255)
        for (let c = 0; c < VOCSIZE_TIMELINE_FULL - 1; c++) {
            for (let y = PTNVIEW_OFFSET_Y - 1; y < PTNVIEW_HEIGHT; y++) {
                con.move(y, PTNVIEW_OFFSET_X + COLSIZE_TIMELINE_FULL * (c+1) - 1)
                con.prnch(0xB3)
            }
        }
    }
    else {
        // paint the first column of pattern view with colour
        for (let x = PTNVIEW_OFFSET_X; x < SCRW - 3; x += COLSIZE_TIMELINE_FULL) {
            for (let y = 0; y < PTNVIEW_HEIGHT+1; y++) {
                let memOffset = (y+PTNVIEW_OFFSET_Y-2) * SCRW + (x-1)
                let bgColOffset = GPU_MEM - TEXT_BACK_OFF - memOffset
                let oldBgCol = sys.peek(bgColOffset)
                if (oldBgCol == 255) {
                    sys.poke(bgColOffset, colColumnSep)
                }
            }
        }

        con.color_pair(colSep, 255)
    }
}

function drawVoiceHeaders() {
    fillLine(PTNVIEW_OFFSET_Y - 1, colVoiceHdr, 255)
    const cue = song.cues[cueIdx]
    for (let c = 0; c < VOCSIZE_TIMELINE_FULL; c++) {
        const voice = voiceOff + c
        const x = PTNVIEW_OFFSET_X + COLSIZE_TIMELINE_FULL * c
        con.move(PTNVIEW_OFFSET_Y - 1, x)
        if (voice >= song.numVoices) {
            con.color_pair(colVoiceHdr, 255)
            print(`                     `.substring(0, COLSIZE_TIMELINE_FULL))
        } else {
            const isCursor = (voice === cursorVox)
            const isMuted  = voiceMutes[voice]
            con.color_pair(isMuted ? 249 : colVoiceHdr, isCursor ? colHighlight : 255)
            const ptnIdx = cue.ptns[voice]
            const vlabel = `V${(voice+1).dec02()}`
            const plabel = (ptnIdx === CUE_EMPTY) ? '---' : ptnIdx.hex03()
            const label =
                (timelineRowStyle == 0) ? `  ${vlabel} ptn ${plabel}    ` :
                (timelineRowStyle == 1) ? ` ${vlabel.substring(1)}:${plabel}` :
                ` ${vlabel}`
            print((label + '                     ').substring(0, COLSIZE_TIMELINE_FULL))
        }
    }

    drawSeparators(separatorStyle)
}

// Sub-field layout for style-0 cells (shared by drawPatternRowAt and drawVoiceColumnAt)
const TL_FIELD_OFFSETS = [0, 4, 6, 8, 10, 11]
const TL_FIELD_FGS     = [colNote, colInst, colVol, colPan, colEffOp, colEffArg]

function drawPatternRowAt(viewRow, style = timelineRowStyle) {
    const actualRow = scrollRow + viewRow
    const y = PTNVIEW_OFFSET_Y + viewRow
    const highlight = (actualRow === cursorRow)
    const back = highlight ? (playbackMode !== PLAYMODE_NONE ? colPlayback : colHighlight) : colBackPtn
    const cue = song.cues[cueIdx]

    con.color_pair(colRowNum, back)
    if (actualRow < ROWS_PER_PAT) {
        let actualRowForBeatCalc = actualRow
        while (actualRowForBeatCalc >= beatDivSecondary) { actualRowForBeatCalc -= beatDivSecondary }

        if (actualRowForBeatCalc % beatDivPrimary == 0) {con.color_pair(colRowNumEmph1, back)}
        if (actualRowForBeatCalc % beatDivSecondary == 0) {con.color_pair(colRowNumEmph2, back)}
        let rowstr = actualRow.dec02()
        con.move(y, 1); con.prnch(rowstr.charCodeAt(0)); con.move(y, 2); con.prnch(rowstr.charCodeAt(1))

        if (timelineRowStyle != 1) {
            con.move(y, SCRW-2); con.prnch(rowstr.charCodeAt(0)); con.move(y, SCRW-1); con.prnch(rowstr.charCodeAt(1))
        }
    }
    else {
        print('      ')
    }
    // TODO scroll indicator on x=SCRW?

    for (let c = 0; c < VOCSIZE_TIMELINE_FULL; c++) {
        const voice = voiceOff + c
        const x = PTNVIEW_OFFSET_X + COLSIZE_TIMELINE_FULL * c
        let cell = EMPTY_CELL
        if (actualRow < ROWS_PER_PAT && voice < song.numVoices) {
            const ptnIdx = cue.ptns[voice]
            if (ptnIdx !== CUE_EMPTY && ptnIdx < song.numPats) {
                cell = buildRowCell(song.patterns[ptnIdx], actualRow)
            }
        }
        drawCellAtStyled(y, x, cell, back, style)
        if (style === 0 && highlight && playbackMode === PLAYMODE_NONE && voice === cursorVox) {
            const fieldStr = [cell.sNote, cell.sInst, cell.sVolEff+cell.sVolArg,
                              cell.sPanEff+cell.sPanArg, cell.sEffOp, cell.sEffArg][timelineColCursor]
            con.move(y, x + TL_FIELD_OFFSETS[timelineColCursor])
            con.color_pair(TL_FIELD_FGS[timelineColCursor], colPlayback)
            print(fieldStr)
        }
    }

    drawSeparators(separatorStyle)
}

function drawPatternView(style = timelineRowStyle) {
    for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) drawPatternRowAt(vr, style)
}

function drawControlHint() {
    let hintElemTimeline = [
        [`\u008428u\u008429u`,'Nav'],
        [`Pg\u008418u`,'Cue'],
    ['sep'],
        ['WER','View'],
    ['sep'],
        ['Sp','Edit'],
    ['sep'],
        ['m','Mute'],
        ['s','Solo'],
    ['sep'],
        ['Tab','Panel']
//    ['sep'],
//        ['q','Quit'],
    ]
    let hintElemOrders = [
        [`\u008428u\u008429u`,'Nav'],
        [`Ent`,'Go to cue'],
    ['sep'],
        ['Sp','Edit'],
    ['sep'],
        ['Tab','Panel'],
//    ['sep'],
//        ['q','Quit'],
    ]

    let hintElemPatterns = [
        [`\u008428u\u008429u`,'Nav'],
        [`Pg\u008418u`,'Ptn'],
    ['sep'],
        ['Sp','Edit'],
    ['sep'],
        ['Tab','Panel'],
//    ['sep'],
//        ['q','Quit'],
    ]

    let hintElemEditNoteValue = [ // only enabled in viewmode 'E' or in pattern editor
        [`\u008428u\u008429u`,'Nav'],
        [`Pg\u008418u`,'Cue'],
    ['sep'],
        [`A${sym.doubledot}G`,'Note'],
        [`0${sym.doubledot}9`,'Oct'],
        ['[]',`Tone\u008418u`],
    ['sep'],
        ['#',sym.sharp],
        ['@','Acc'],
    ['sep'],
        ['=','KOff'],
        ['^','KCut'],
//    ['sep'],
//        ['Sp','ExitEdit'],
    ]
    let hintElemEditInstValue = [
        [`\u008428u\u008429u`,'Nav'],
        [`Pg\u008418u`,'Cue'],
    ['sep'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,'Instrument'],
    ['sep'],
        ['Sp','ExitEdit'],
    ]
    let hintElemEditVolEff = [
        [`\u008428u\u008429u`,'Nav'],
        [`Pg\u008418u`,'Cue'],
    ['sep'],
        ['h','Set'],
        ['j','SlideDn'],
        ['k','SlideUp'],
        ['u','FineDn'],
        ['i','FineUp'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,'Val'],
//    ['sep'],
//        ['Sp','ExitEdit'],
    ]
    let hintElemEditPanEff = [
        [`\u008428u\u008429u`,'Nav'],
        [`Pg\u008418u`,'Cue'],
    ['sep'],
        ['h','Set'],
        ['j','SlideL'],
        ['k','SlideR'],
        ['u','FineL'],
        ['i','FineR'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,'Val'],
//    ['sep'],
//        ['Sp','ExitEdit'],
    ]
    let hintElemEditFxSym = [
        [`\u008428u\u008429u`,'Nav'],
        [`Pg\u008418u`,'Cue'],
    ['sep'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,`FxSym`],
    ['sep'],
        ['Sp','ExitEdit'],
    ]
    let hintElemEditFxVal = [
        [`\u008428u\u008429u`,'Nav'],
        [`Pg\u008418u`,'Cue'],
    ['sep'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,`FxVal`],
    ['sep'],
        ['Sp','ExitEdit'],
    ]

    const hintElemExternal = [['Tab','Panel']]
    let hintElems = [hintElemTimeline, hintElemOrders, hintElemPatterns, hintElemExternal, hintElemExternal, hintElemExternal, hintElemExternal]
    let hintElemPat = [hintElemEditNoteValue, hintElemEditInstValue, hintElemEditVolEff, hintElemEditPanEff, hintElemEditFxSym, hintElemEditFxVal]

    // erase current line
    con.move(SCRH, 1)
    print(' '.repeat(SCRW-1))

    // start writing
    con.move(SCRH, 1)

    hintElems[currentPanel].forEach((pair, i, list) => {
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

function drawVoiceDetail(isVerticalLayout = false, ptn = null, activeRow = -1, cumState = null) {
    // Resolve pattern data: null ptn uses timeline context (cursorVox / cursorRow)
    let ptnDat
    if (ptn === null) {
        const cue    = song.cues[cueIdx]
        const ptnIdx = cue.ptns[cursorVox]
        if (ptnIdx === CUE_EMPTY || ptnIdx >= song.numPats) return
        const srcPtn = song.patterns[ptnIdx]
        const row    = (activeRow >= 0) ? activeRow : cursorRow
        const off    = 8 * row
        ptnDat = srcPtn.slice(off, off + 8)
    } else {
        const row = (activeRow >= 0) ? activeRow : 0
        const off = 8 * row
        ptnDat = ptn.slice(off, off + 8)
    }

    const note      = ptnDat[0] | (ptnDat[1] << 8)
    const inst      = ptnDat[2]
    const voleff    = ptnDat[3]
    const voleffop  = (voleff >>> 6) & 3
    const voleffarg = voleff & 63
    const paneff    = ptnDat[4]
    const paneffop  = (paneff >>> 6) & 3
    const paneffarg = paneff & 63
    const effop     = ptnDat[5]
    const effarg    = ptnDat[6] | (ptnDat[7] << 8)

    let fx = effop > 0 ? effop.toString(36).toUpperCase() : '0'
    if (fx === 'S') fx += (effarg >>> 12).hex1()
    const fxName = fxNames[fx] || '?            '

    if (!isVerticalLayout) {
        return
        con.move(PTNVIEW_OFFSET_Y-2, 1)
        print(`Pitch $${note.hex04()}  Inst $${inst.hex02()}  ${sym.vx} ${voleffop}.$${voleffarg.hex02()}  ` +
              `${sym.px} ${paneffop}.$${paneffarg.hex02()}  ${sym.fx} ${fxName} $${effarg.hex04()}`)
    } else {
        const dx      = PATEDITOR_DETAIL_X
        const detailW = SCRW - dx + 1

        let voleffop1 = (voleffop == 3) ? 30 + (voleffarg >>> 5) : voleffop
        let paneffop1 = (paneffop == 3) ? 30 + (paneffarg >>> 5) : paneffop
        let voleffarg1 = '$'+((voleffop == 3) ? voleffarg & 15 : voleffarg).hex02()
        let paneffarg1 = '$'+((paneffop == 3) ? paneffarg & 15 : paneffarg).hex02()
        if (voleff == 0xC0) { voleffop1 = 999; voleffarg1 = '' }
        if (paneff == 0xC0) { paneffop1 = 999; paneffarg1 = '' }

        const lines = []
        lines.push({ label: 'Note ', value: `${noteToStr(note)} ($${note.hex04()})`,         fg: colNote   })
        lines.push({ label: 'Inst ', value: inst === 0 ? '---' : ('$'+inst.hex02()),    fg: colInst   })
        lines.push({ label: 'Vx   ', value: `${volFxNames[voleffop1]} ${voleffarg1}`, fg: colVol    })
        lines.push({ label: 'Px   ', value: `${panFxNames[paneffop1]} ${paneffarg1}`, fg: colPan    })
        lines.push({ label: 'Fx    ', value: fxName.trimEnd(),                    fg: colEffOp  })
        lines.push({ label: 'FxOp ', value: fx,                                  fg: colEffOp  })
        lines.push({ label: 'FxArg', value: `$${effarg.hex04()}`,                fg: colEffArg })

        if (cumState !== null) {
            lines.push({ label: '------', value: '',                                                                  fg: colSep    })
            lines.push({ label: 'L.Note', value: noteToStr(cumState.lastNote),                                        fg: colNote   })
            lines.push({ label: 'L.Inst', value: cumState.lastInst === 0 ? '---' : ('$'+cumState.lastInst.hex02()),          fg: colInst   })
            lines.push({ label: 'Vol   ', value: `$${cumState.volAbs.hex02()}`,                                       fg: colVol    })
            lines.push({ label: 'Pan   ', value: `$${cumState.panAbs.hex02()}`,                                       fg: colPan    })
            const _apo  = Math.abs(cumState.pitchOff)
            const _psgn = cumState.pitchOff > 0 ? '+' : cumState.pitchOff < 0 ? '-' : '='
            const _absN = (cumState.lastNote !== 0xFFFF && cumState.pitchOff !== 0)
                ? noteToStr(Math.max(0, Math.min(0xFFFE, cumState.lastNote + cumState.pitchOff))) + ' '
                : ''
            lines.push({ label: 'Pitch ', value: `${_absN}(${_psgn}$${_apo.hex04()})`,                               fg: colNote   })
            lines.push({ label: `E${MIDDOT}F   `, value: `$${cumState.memEF.hex04()}`,                                        fg: colEffArg })
            lines.push({ label: 'G     ', value: `$${cumState.memG.hex04()}`,                                         fg: colEffArg })
            lines.push({ label: `H${MIDDOT}U   `, value: `$${cumState.memHU.speed.hex02()}/$${cumState.memHU.depth.hex02()}`, fg: colEffArg })
            lines.push({ label: 'R     ', value: `$${cumState.memR.speed.hex02()}/$${cumState.memR.depth.hex02()}`,   fg: colEffArg })
            lines.push({ label: 'Y     ', value: `$${cumState.memY.speed.hex02()}/$${cumState.memY.depth.hex02()}`,   fg: colEffArg })
            lines.push({ label: 'D     ', value: `$${cumState.memD.hex04()}`,                                         fg: colEffArg })
            lines.push({ label: 'I     ', value: `$${cumState.memI.hex04()}`,                                         fg: colEffArg })
            lines.push({ label: 'J     ', value: `$${cumState.memJ.hex04()}`,                                         fg: colEffArg })
            lines.push({ label: 'O     ', value: `$${cumState.memO.hex04()}`,                                         fg: colEffArg })
            lines.push({ label: 'Q     ', value: `$${cumState.memQ.hex04()}`,                                         fg: colEffArg })
            lines.push({ label: 'Tslid ', value: `$${cumState.memTSlide.hex02()}`,                                    fg: colEffArg })
        }

        const showCount = Math.min(lines.length, PTNVIEW_HEIGHT)
        for (let i = 0; i < showCount; i++) {
            const y    = PTNVIEW_OFFSET_Y + i
            const line = lines[i]
            con.move(y, dx)
            con.color_pair(colStatus, 255)
            print((line.label + '      ').substring(0, 6) + ' ')
            con.color_pair(line.fg, 255)
            print((line.value + ' '.repeat(detailW)).substring(0, detailW - 8))
        }
        for (let i = showCount; i < PTNVIEW_HEIGHT; i++) {
            con.move(PTNVIEW_OFFSET_Y + i, dx)
            con.color_pair(colBackPtn, 255)
            print(' '.repeat(detailW))
        }
    }
}

function drawAll() {
    con.clear()
    drawAlwaysOnElems()
    drawControlHint()
    redrawPanel()
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

// Horizontal salvage
let SALVAGE_HORIZ_LEN = (VOCSIZE_TIMELINE_FULL - 1) * COLSIZE_TIMELINE_FULL

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
    // Column of the first char to copy (1-indexed); dest is COLSIZE_TIMELINE_FULL chars earlier/later.
    const srcX = PTNVIEW_OFFSET_X + (dVoice > 0 ? COLSIZE_TIMELINE_FULL : 0)
    const dstX = PTNVIEW_OFFSET_X + (dVoice > 0 ? 0 : COLSIZE_TIMELINE_FULL)
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
 * Redraw every row of one voice column (slot 0..VOCSIZE_TIMELINE_FULL-1) after a horizontal shift.
 * Also redraws separators for the whole row so any separator at the exposed boundary
 * (which the VRAM shift left correct) is confirmed visually consistent.
 */
function drawVoiceColumnAt(slot) {
    const voice  = voiceOff + slot
    const x      = PTNVIEW_OFFSET_X + COLSIZE_TIMELINE_FULL * slot
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
        drawCellAtStyled(y, x, cell, back, timelineRowStyle)
        if (timelineRowStyle === 0 && highlight && playbackMode === PLAYMODE_NONE && voice === cursorVox) {
            const fieldStr = [cell.sNote, cell.sInst, cell.sVolEff+cell.sVolArg,
                              cell.sPanEff+cell.sPanArg, cell.sEffOp, cell.sEffArg][timelineColCursor]
            con.move(y, x + TL_FIELD_OFFSETS[timelineColCursor])
            con.color_pair(TL_FIELD_FGS[timelineColCursor], colPlayback)
            print(fieldStr)
        }
    }
}

function setTimelineRowStyle(style) {
    timelineRowStyle      = style
    COLSIZE_TIMELINE_FULL = TIMELINE_COLSIZES[style]
    VOCSIZE_TIMELINE_FULL = Math.floor((SCRW - 3) / COLSIZE_TIMELINE_FULL)
    SALVAGE_HORIZ_LEN     = (VOCSIZE_TIMELINE_FULL - 1) * COLSIZE_TIMELINE_FULL
    clampVoice()
    drawAll()
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// APPLICATION STUB
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

con.curs_set(0)
graphics.setBackground(0x23,0x39,0x58)
//graphics.setBackground(0x12,0x32,0x5f)
graphics.setGraphicsMode(0)

let currentPanel = VIEW_TIMELINE
let cueIdx           = 0
let cursorRow        = 0
let scrollRow        = 0
let voiceOff         = 0
let cursorVox        = 0
let timelineColCursor = 0   // sub-field within cursorVox (0=note,1=inst,2=vol,3=pan,4=fxop,5=fxarg)
let ordersCursor    = 0
let ordersScroll    = 0
let ordersColCursor = 0   // 0=Cmd, 1..numVoices=voice columns
let ordersVoiceOff  = 0   // horizontal scroll for voice columns
let patternIdx        = 0
let patternListScroll = 0
let patternGridRow    = 0
let patternGridScroll = 0
let patternGridCol    = 0
let simState          = null
let simStateKey       = ''

if (exec_args[1] === undefined) {
    println(`Usage: ${exec_args[0]} path_to.taud`)
    return 1
}

const fullPathObj = _G.shell.resolvePathInput(exec_args[1])
if (fullPathObj === undefined) {
    println(`taut: cannot resolve path: ${exec_args[1]}`)
    return 1
}

const logofile = files.open("A:/tvdos/bin/tauthdr.r8")
const logoBytes = logofile.bread(); logofile.close()
const logoTexture = new gl.Texture(90, 14, logoBytes)
const buttonfile = files.open("A:/tvdos/bin/tautbtn.r8")
const buttonBytes = buttonfile.bread(); buttonfile.close()
const buttonTexture = new gl.Texture(2, 28, buttonBytes)
//const buttonNullfile = files.open("A:/tvdos/bin/tautbtn0.r8")
//const buttonNullBytes = buttonNullfile.bread(); buttonNullfile.close()
//const buttonNullTexture = new gl.Texture(35, 28, buttonNullBytes)

font.setLowRom("A:/tvdos/bin/tautfont_low.chr")
font.setHighRom("A:/tvdos/bin/tautfont_high.chr")
const song = loadTaud(fullPathObj.full, 0)

const voiceMutes = new Array(NUM_VOICES).fill(false)
let timelineMuteSnapshot = null

function resetAudioDevice() {
    audio.resetParams(PLAYHEAD)
    audio.purgeQueue(PLAYHEAD)
    audio.stop(PLAYHEAD)
}

function applyMuteTransition(toPanel) {
    if (toPanel === VIEW_PATTERN_DETAILS) {
        timelineMuteSnapshot = voiceMutes.slice()
        if (voiceMutes[0]) {
            voiceMutes[0] = false
            audio.setVoiceMute(PLAYHEAD, 0, false)
        }
    } else if (toPanel === VIEW_TIMELINE && timelineMuteSnapshot !== null) {
        for (let i = 0; i < song.numVoices; i++) {
            voiceMutes[i] = timelineMuteSnapshot[i]
            audio.setVoiceMute(PLAYHEAD, i, voiceMutes[i])
        }
        timelineMuteSnapshot = null
    }
}

function redrawFull() { drawAll() }

function redrawPanel() {
    panels[currentPanel].drawContents()
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// PANELS
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

function drawTimelineContents(wo) {
    drawVoiceHeaders()
    drawPatternView()
    drawSeparators(separatorStyle)
    drawVoiceDetail()
}

function drawOrdersHeader() {
    fillLine(PTNVIEW_OFFSET_Y - 1, colVoiceHdr, 255)
    con.move(PTNVIEW_OFFSET_Y - 1, 1)
    con.color_pair(colVoiceHdr, 255)
    print('    ')
    con.color_pair(colVoiceHdr, ordersColCursor === 0 ? colHighlight : 255)
    print('Cmd ')
    for (let c = 0; c < VOCSIZE_ORDERS; c++) {
        const v = ordersVoiceOff + c
        con.color_pair(colVoiceHdr, ordersColCursor === v + 1 ? colHighlight : 255)
        print(v < song.numVoices ? `V${(v+1).dec02()} ` : '    ')
    }
}

function drawOrdersContents(wo) {
    drawOrdersHeader()
    const maxCue = song.lastActiveCue < 0 ? 0 : song.lastActiveCue

    for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) {
        const ci    = ordersScroll + vr
        const y     = PTNVIEW_OFFSET_Y + vr
        const isSel = (ci === ordersCursor)
        const isCur = playbackMode !== PLAYMODE_NONE && ci === cueIdx
        const back  = isSel ? (playbackMode !== PLAYMODE_NONE ? colPlayback : colHighlight)
                             : (isCur ? colPlayback : colBackPtn)

        con.move(y, 1)
        if (ci > maxCue) {
            con.color_pair(colBackPtn, colBackPtn)
            print(' '.repeat(SCRW - 1))
        } else {
            const cue = song.cues[ci]
            con.color_pair(ci % 4 === 0 ? colRowNumEmph1 : colRowNum, back)
            print(ci.hex03())
            con.color_pair(colBackPtn, back)
            print(' ')
            // CMD column — crosshair highlight at (ordersCursor, col 0)
            const cmdBack = (isSel && ordersColCursor === 0) ? colPlayback : back
            con.color_pair(cue.instr ? colStatus : colSep, cmdBack)
            print(cue.instr ? cue.instr.hex02() : '--')
            con.color_pair(colBackPtn, back)
            print('  ')
            // Voice columns
            for (let c = 0; c < VOCSIZE_ORDERS; c++) {
                const v     = ordersVoiceOff + c
                const ptn   = v < song.numVoices ? cue.ptns[v] : CUE_EMPTY
                const vBack = (isSel && ordersColCursor === v + 1) ? colPlayback : back
                con.color_pair(ptn === CUE_EMPTY ? colSep : colStatus, vBack)
                print(ptn === CUE_EMPTY ? '---' : ptn.hex03())
                con.color_pair(colBackPtn, back)
                print(' ')
            }
            const endX = ORDERS_VOICE_X + VOCSIZE_ORDERS * 4
            if (endX <= SCRW) { con.color_pair(colBackPtn, back); print(' '.repeat(SCRW - endX)) }
        }
    }
}

function timelineInput(wo, event) {
    const keysym    = event[1]
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 4 : 1

    if (keyJustHit && shiftDown && event.includes(keys.W)) { setTimelineRowStyle(0); return }
    if (keyJustHit && shiftDown && event.includes(keys.E)) { setTimelineRowStyle(1); return }
    if (keyJustHit && shiftDown && event.includes(keys.R)) { setTimelineRowStyle(2); return }

    if (playbackMode !== PLAYMODE_NONE) {
        if (keyJustHit && shiftDown && event.includes(keys.Y) || keysym === " ") { stopPlayback(); redrawPanel(); drawAlwaysOnElems() }
        else if (keysym === "<LEFT>" || keysym === "<RIGHT>") {
            const dir = (keysym === "<LEFT>") ? -1 : 1
            const oldVoiceOff = voiceOff
            cursorVox += dir * moveDelta
            timelineColCursor = 0
            clampVoice()
            const dVoice = voiceOff - oldVoiceOff
            if (dVoice !== 0) { shiftPatternAreaHorizontal(dVoice); drawVoiceColumnAt(dVoice > 0 ? VOCSIZE_TIMELINE_FULL - 1 : 0) }
            drawVoiceHeaders(); drawSeparators(separatorStyle); drawAlwaysOnElems(); drawVoiceDetail()
        }
        else if (keyJustHit && !shiftDown && event.includes(keys.M)) { toggleMute(cursorVox) }
        else if (keyJustHit && !shiftDown && event.includes(keys.S)) { toggleSolo(cursorVox) }
        return
    }

    if (keyJustHit && shiftDown && event.includes(keys.Y)) { startPlaySong(); redrawPanel(); return }
    if (keyJustHit && shiftDown && event.includes(keys.U)) { startPlayCue();  redrawPanel(); return }
    if (              shiftDown && event.includes(keys.I)) { startPlayRow();  drawPatternRowAt(cursorRow - scrollRow); return }
    if (keyJustHit && shiftDown && event.includes(keys.O) || keysym === " ") { stopPlayback(); drawAlwaysOnElems(); return }

    const oldCursor = cursorRow
    const oldScroll = scrollRow
    let rowMove = false
    let fullRedraw = false

    if (keysym === "<LEFT>" || keysym === "<RIGHT>") {
        const dir = (keysym === "<LEFT>") ? -1 : 1
        const oldVoiceOff = voiceOff
        const prevVox = cursorVox
        let triedCross = false
        if (shiftDown || timelineRowStyle > 0) {
            cursorVox += dir * moveDelta
            timelineColCursor = dir > 0 ? 0 : 5
        } else {
            timelineColCursor += dir
            if (timelineColCursor < 0)      { timelineColCursor = 5; cursorVox--; triedCross = true }
            else if (timelineColCursor > 5) { timelineColCursor = 0; cursorVox++; triedCross = true }
        }
        clampVoice()
        if (triedCross && cursorVox === prevVox) timelineColCursor = dir < 0 ? 0 : 5
        const dVoice = voiceOff - oldVoiceOff
        if (dVoice !== 0) { shiftPatternAreaHorizontal(dVoice); drawVoiceColumnAt(dVoice > 0 ? VOCSIZE_TIMELINE_FULL - 1 : 0) }
        drawVoiceHeaders(); drawSeparators(separatorStyle); drawAlwaysOnElems(); drawVoiceDetail()
        drawPatternRowAt(cursorRow - scrollRow)
        return
    }

    if (keyJustHit && !shiftDown && event.includes(keys.M)) { toggleMute(cursorVox); return }
    if (keyJustHit && !shiftDown && event.includes(keys.S)) { toggleSolo(cursorVox); return }

    if      (keysym === "<UP>")        { cursorRow -= moveDelta;      rowMove = true }
    else if (keysym === "<DOWN>")      { cursorRow += moveDelta;      rowMove = true }
    else if (keysym === "<HOME>")      { cursorRow  = 0;              rowMove = true }
    else if (keysym === "<END>")       { cursorRow  = ROWS_PER_PAT-1; rowMove = true }
    else if (keysym === "<PAGE_UP>")   { cueIdx    -= moveDelta;      fullRedraw = true }
    else if (keysym === "<PAGE_DOWN>") { cueIdx    += moveDelta;      fullRedraw = true }
    else return

    clampCursor(); clampVoice(); clampCue()

    if (fullRedraw) { drawAll(); return }
    if (!rowMove || cursorRow === oldCursor) return

    const dScroll = scrollRow - oldScroll
    if (dScroll === 0) {
        drawPatternRowAt(oldCursor - scrollRow)
        drawPatternRowAt(cursorRow - scrollRow)
    } else if (Math.abs(dScroll) >= PTNVIEW_HEIGHT) {
        drawPatternView()
    } else {
        shiftPatternArea(-dScroll)
        if (dScroll > 0) { for (let i = 0; i < dScroll;  i++) drawPatternRowAt(PTNVIEW_HEIGHT - 1 - i) }
        else             { for (let i = 0; i < -dScroll; i++) drawPatternRowAt(i) }
        if (oldCursor >= scrollRow && oldCursor < scrollRow + PTNVIEW_HEIGHT) drawPatternRowAt(oldCursor - scrollRow)
        drawPatternRowAt(cursorRow - scrollRow)
    }
    drawSeparators(separatorStyle); drawAlwaysOnElems(); drawVoiceDetail()
}

function ordersInput(wo, event) {
    const keysym     = event[1]
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 4 : 1
    const maxCue     = song.lastActiveCue < 0 ? 0 : song.lastActiveCue

    if (playbackMode !== PLAYMODE_NONE) {
        if ((keyJustHit && shiftDown && event.includes(keys.Y)) || keysym === " ") {
            stopPlayback(); drawAlwaysOnElems()
        }
        return
    }

    if (keyJustHit && shiftDown && event.includes(keys.U)) {
        cueIdx = ordersCursor; clampCue(); startPlayCue(); drawAlwaysOnElems(); return
    }
    if ((keyJustHit && shiftDown && event.includes(keys.O)) || keysym === " ") {
        stopPlayback(); drawAlwaysOnElems(); return
    }

    if (keysym === '<UP>') {
        ordersCursor = Math.max(0, ordersCursor - moveDelta)
        if (ordersCursor < ordersScroll) ordersScroll = ordersCursor
        drawOrdersContents(wo)
    } else if (keysym === '<DOWN>') {
        ordersCursor = Math.min(maxCue, ordersCursor + moveDelta)
        if (ordersCursor >= ordersScroll + PTNVIEW_HEIGHT) ordersScroll = Math.max(0, ordersCursor - PTNVIEW_HEIGHT + 1)
        drawOrdersContents(wo)
    } else if (keysym === '<PAGE_UP>') {
        ordersCursor = Math.max(0, ordersCursor - PTNVIEW_HEIGHT)
        ordersScroll = Math.max(0, ordersScroll - PTNVIEW_HEIGHT)
        drawOrdersContents(wo)
    } else if (keysym === '<PAGE_DOWN>') {
        ordersCursor = Math.min(maxCue, ordersCursor + PTNVIEW_HEIGHT)
        if (ordersCursor >= ordersScroll + PTNVIEW_HEIGHT) ordersScroll = Math.max(0, ordersCursor - PTNVIEW_HEIGHT + 1)
        drawOrdersContents(wo)
    } else if (keysym === '<LEFT>' || keysym === '<RIGHT>') {
        ordersColCursor += (keysym === '<LEFT>') ? -1 : 1
        clampOrdersHoriz()
        drawOrdersContents(wo)
    } else if (keyJustHit && keysym === '\n') {
        cueIdx = ordersCursor
        clampCue()
        currentPanel = VIEW_TIMELINE
        drawAll()
        return
    } else {
        return
    }
    drawAlwaysOnElems()
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// PATTERN EDITOR PANEL
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Returns the visual width of a TSVM string (handles Nnu escape sequences)
function visWidth(s) {
    let w = 0, i = 0
    while (i < s.length) {
        if (s.charCodeAt(i) === 0x84) {
            i++
            while (i < s.length && s[i] !== 'u') i++
            i++
            w++
        } else { i++; w++ }
    }
    return w
}

function clampPatternIdx() {
    if (song.numPats === 0) { patternIdx = 0; patternListScroll = 0; return }
    if (patternIdx < 0) patternIdx = 0
    if (patternIdx >= song.numPats) patternIdx = song.numPats - 1
    if (patternIdx < patternListScroll) patternListScroll = patternIdx
    if (patternIdx < patternListScroll + (PTNVIEW_HEIGHT >>> 1) && patternListScroll > 0)
        patternListScroll = patternIdx - (PTNVIEW_HEIGHT >>> 1)
    if (patternIdx >= patternListScroll + ((PTNVIEW_HEIGHT + 1) >>> 1))
        patternListScroll = patternIdx - ((PTNVIEW_HEIGHT + 1) >>> 1) + 1
    if (patternListScroll < 0) patternListScroll = 0
    if (patternListScroll + PTNVIEW_HEIGHT > song.numPats)
        patternListScroll = Math.max(0, song.numPats - PTNVIEW_HEIGHT)
}

function scrollPatternGridTo(row) {
    if (row < patternGridScroll) patternGridScroll = row
    if (row < patternGridScroll + (PTNVIEW_HEIGHT >>> 1) && patternGridScroll > 0)
        patternGridScroll = row - (PTNVIEW_HEIGHT >>> 1)
    if (row >= patternGridScroll + ((PTNVIEW_HEIGHT + 1) >>> 1))
        patternGridScroll = row - ((PTNVIEW_HEIGHT + 1) >>> 1) + 1
    if (patternGridScroll < 0) patternGridScroll = 0
    if (patternGridScroll + PTNVIEW_HEIGHT > ROWS_PER_PAT)
        patternGridScroll = Math.max(0, ROWS_PER_PAT - PTNVIEW_HEIGHT)
}

function clampPatternGrid() {
    if (patternGridRow < 0) patternGridRow = 0
    if (patternGridRow >= ROWS_PER_PAT) patternGridRow = ROWS_PER_PAT - 1
    scrollPatternGridTo(patternGridRow)
    if (patternGridCol < 0) patternGridCol = 0
    if (patternGridCol > 5) patternGridCol = 5
}

// Returns the row to use for drawVoiceDetail: pbRow during playback, editor cursor otherwise
function getActiveRowForDetail() {
    return (playbackMode !== PLAYMODE_NONE) ? pbRow : patternGridRow
}

// Walk pattern rows 0..uptoRow and accumulate effect-memory cohort state
function simulateRowState(ptnDat, uptoRow) {
    const OP_A = 10
    const OP_D = 13, OP_E = 14, OP_F = 15, OP_G = 16
    const OP_H = 17, OP_I = 18, OP_J = 19, OP_O = 24
    const OP_Q = 26, OP_R = 27, OP_T = 29, OP_U = 30, OP_Y = 34

    let lastNote = 0xFFFF, lastInst = 0
    let volAbs = 0x3F, panAbs = 0x20
    let pitchOff = 0, portaTarget = -1
    let speed = audio.getTickRate(PLAYHEAD) // not always going to be correct but it should be mostly
    let memEF = 0, memG = 0
    let memHU = { speed: 0, depth: 0 }
    let memR  = { speed: 0, depth: 0 }
    let memY  = { speed: 0, depth: 0 }
    let memD = 0, memI = 0, memJ = 0, memO = 0, memQ = 0, memTSlide = 0

    const clampV = v => Math.max(0, Math.min(0x3F, v | 0))

    const limit = Math.min(uptoRow, ROWS_PER_PAT - 1)
    for (let row = 0; row <= limit; row++) {
        const off    = 8 * row
        const note   = ptnDat[off]   | (ptnDat[off+1] << 8)
        const inst   = ptnDat[off+2]
        const voleff = ptnDat[off+3]
        const paneff = ptnDat[off+4]
        const effop  = ptnDat[off+5]
        const effarg = ptnDat[off+6] | (ptnDat[off+7] << 8)

        // Notes on a portamento row (G) become the slide target; they don't retrigger
        const isGRow = (effop === OP_G)
        if (note !== 0xFFFF && note !== 0xFFFE) {
            if (!isGRow) {
                lastNote = note
                pitchOff = 0
                portaTarget = -1
            } else {
                portaTarget = note
            }
        }
        if (inst !== 0) lastInst = inst

        // Volume column: set OR slide (0xC0 = 3.00 nop is the empty sentinel, not 0x00)
        const volop    = (voleff >>> 6) & 3
        const volefarg = voleff & 63
        if (voleff !== 0xC0) {
            if (volop === 0) {
                volAbs = volefarg
            } else if (volop === 1) {
                volAbs = clampV(volAbs + (volefarg & 15) * (speed - 1))
            } else if (volop === 2) {
                volAbs = clampV(volAbs - (volefarg & 15) * (speed - 1))
            } else if (volop === 3 && volefarg !== 0) {
                if (volefarg >= 32) volAbs = clampV(volAbs + (volefarg & 15))  // fine slide up
                else                volAbs = clampV(volAbs - (volefarg & 15))  // fine slide down
            }
        }

        // Pan column: set OR slide (0xC0 = 3.00 nop is the empty sentinel, not 0x00)
        const panop    = (paneff >>> 6) & 3
        const panefarg = paneff & 63
        if (paneff !== 0xC0) {
            if (panop === 0) {
                panAbs = panefarg
            } else if (panop === 1) {
                panAbs = clampV(panAbs + (panefarg & 15) * (speed - 1))
            } else if (panop === 2) {
                panAbs = clampV(panAbs - (panefarg & 15) * (speed - 1))
            } else if (panop === 3 && panefarg !== 0) {
                if (panefarg >= 32) panAbs = clampV(panAbs + (panefarg & 15))
                else                panAbs = clampV(panAbs - (panefarg & 15))
            }
        }

        if (effop !== 0 || effarg !== 0) {
            if (effop === OP_A) {
                if ((effarg >>> 8) !== 0) speed = (effarg >>> 8)
            }
            else if (effop === OP_D) {
                const raw = (effarg !== 0) ? (memD = effarg) : memD
                if (raw !== 0) {
                    const hb    = (raw >>> 8) & 0xFF
                    const hiNib = (hb >>> 4) & 0xF
                    const loNib = hb & 0xF
                    if (hiNib === 0xF) {
                        // $Fy00 fine slide down, but $F000/$FF00 → fine slide up by $F
                        if (hb === 0xFF || loNib === 0) volAbs = clampV(volAbs + 0xF)
                        else                             volAbs = clampV(volAbs - loNib)
                    } else if (loNib === 0xF) {
                        volAbs = clampV(volAbs + hiNib)      // $xF00 fine slide up
                    } else if (hiNib === 0 && loNib !== 0) {
                        volAbs = clampV(volAbs - loNib * (speed - 1))  // $0y00 coarse down
                    } else if (hiNib !== 0 && loNib === 0) {
                        volAbs = clampV(volAbs + hiNib * (speed - 1))  // $x000 coarse up
                    }
                }
            }
            else if (effop === OP_E || effop === OP_F) {
                const raw = (effarg !== 0) ? (memEF = effarg) : memEF
                if (raw !== 0) {
                    const fine = (raw & 0xF000) === 0xF000
                    const amt  = fine ? (raw & 0x0FFF) : raw * (speed - 1)
                    if (effop === OP_E) pitchOff -= amt
                    else                pitchOff += amt
                }
            }
            else if (effop === OP_G) {
                if (effarg !== 0) memG = effarg
                if (portaTarget !== -1 && memG !== 0 && lastNote !== 0xFFFF) {
                    const curPitch = lastNote + pitchOff
                    const diff     = portaTarget - curPitch
                    if (diff !== 0) {
                        const absDiff = Math.abs(diff)
                        const maxStep = memG * (speed - 1)
                        pitchOff += Math.sign(diff) * Math.min(absDiff, maxStep)
                        if (absDiff <= maxStep) {
                            pitchOff = portaTarget - lastNote
                            portaTarget = -1
                        }
                    }
                }
            }
            else if (effop === OP_H || effop === OP_U) {
                const spd = (effarg >>> 8) & 0xFF; const dep = effarg & 0xFF
                if (spd !== 0) memHU.speed = spd; if (dep !== 0) memHU.depth = dep
            }
            else if (effop === OP_R) {
                const spd = (effarg >>> 8) & 0xFF; const dep = effarg & 0xFF
                if (spd !== 0) memR.speed = spd; if (dep !== 0) memR.depth = dep
            }
            else if (effop === OP_Y) {
                const spd = (effarg >>> 8) & 0xFF; const dep = effarg & 0xFF
                if (spd !== 0) memY.speed = spd; if (dep !== 0) memY.depth = dep
            }
            else if (effop === OP_I) { if (effarg !== 0) memI = effarg }
            else if (effop === OP_J) { if (effarg !== 0) memJ = effarg }
            else if (effop === OP_O) { if (effarg !== 0) memO = effarg }
            else if (effop === OP_Q) { if (effarg !== 0) memQ = effarg }
            else if (effop === OP_T) { if ((effarg >>> 8) === 0 && effarg !== 0) memTSlide = effarg }
        }
    }

    return { lastNote, lastInst, volAbs, panAbs, pitchOff,
             memEF, memG, memHU, memR, memY,
             memD, memI, memJ, memO, memQ, memTSlide }
}

function drawPatternListColumn() {
    for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) {
        const pi  = patternListScroll + vr
        const y   = PTNVIEW_OFFSET_Y + vr
        const isCur = (pi === patternIdx)
        con.move(y, PATEDITOR_LIST_X)
        if (pi >= song.numPats) {
            con.color_pair(255, colBackPtn)
            print('    ')
        } else {
            con.color_pair(isCur ? colStatus : colRowNum, isCur ? colHighlight : 255)
            print(pi.hex03())
            con.color_pair(colSep, 255)
            print(' ')
        }
    }
}

/**
 * @param viewRow which row
 */
function drawPatternGridRowAt(viewRow) {
    const actualRow = patternGridScroll + viewRow
    const y = PTNVIEW_OFFSET_Y + viewRow

    if (actualRow >= ROWS_PER_PAT) {
        con.move(y, PATEDITOR_GRID_X)
        con.color_pair(colBackPtn, 255)
        print(' '.repeat(PATEDITOR_SEP2_X - PATEDITOR_GRID_X))
        return
    }

    const ptn    = song.patterns[patternIdx]
    const isPbRow  = (playbackMode !== PLAYMODE_NONE && actualRow === pbRow)
    const isCurRow = (actualRow === patternGridRow)
    // Row number gets highlight bg to mark cursor row; playhead takes colPlayback priority
    const rowNumBack = isPbRow ? colPlayback : (isCurRow ? colHighlight : colBackPtn)
    const cellBack   = isPbRow ? colPlayback : colBackPtn

    con.color_pair(actualRow % 4 === 0 ? colRowNumEmph1 : colRowNum, rowNumBack)
    const rowstr = actualRow.dec02()
    con.move(y, PATEDITOR_GRID_X);   con.prnch(rowstr.charCodeAt(0))
    con.move(y, PATEDITOR_GRID_X+1); con.prnch(rowstr.charCodeAt(1))
    con.move(y, PATEDITOR_GRID_X+2)
    con.color_pair(colBackPtn, cellBack); con.addch(32)

    const cell = buildRowCell(ptn, actualRow)
    drawCellAtStyled(y, PATEDITOR_CELL_X, cell, cellBack, -1)

    // Overlay sub-field cursor highlight on the cursor row (not playhead).
    // Style -1 fixed column offsets from PATEDITOR_CELL_X: 0,5,8,11,14,15
    if (isCurRow && !isPbRow) {
        const fieldOffsets = [0, 5, 8, 11, 14, 15]
        const fieldStrs    = [
            cell.sNote,
            cell.sInst,
            cell.sVolEff + cell.sVolArg,
            cell.sPanEff + cell.sPanArg,
            cell.sEffOp,
            cell.sEffArg,
        ]
        const fieldFgs     = [colNote, colInst, colVol, colPan, colEffOp, colEffArg]
        const col = patternGridCol
        con.move(y, PATEDITOR_CELL_X + fieldOffsets[col])
        con.color_pair(fieldFgs[col], colHighlight)
        print(fieldStrs[col])
    }
}

function drawPatternGrid() {
    for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) drawPatternGridRowAt(vr)
}

function drawPatternsHeader() {
    fillLine(PTNVIEW_OFFSET_Y - 1, colVoiceHdr, 255)
    con.move(PTNVIEW_OFFSET_Y - 1, PATEDITOR_LIST_X)
    con.color_pair(colVoiceHdr, 255)
    print('Ptn ')
    con.move(PTNVIEW_OFFSET_Y - 1, PATEDITOR_GRID_X)
    if (song.numPats > 0)
        print(`Pattern ${patternIdx.hex03()}  Row ${patternGridRow.dec02()}`)
}

function drawPatternsContents(wo) {
    drawPatternsHeader()
    if (song.numPats === 0) {
        con.move(PTNVIEW_OFFSET_Y, 1)
        con.color_pair(colStatus, 255)
        print('(no patterns)')
        return
    }

    drawPatternListColumn()
    drawPatternGrid()

    // Column separators
    con.color_pair(colSep, 255)
    for (let y = PTNVIEW_OFFSET_Y - 1; y < PTNVIEW_OFFSET_Y + PTNVIEW_HEIGHT; y++) {
        con.move(y, PATEDITOR_SEP1_X); con.prnch(0xB3)
        con.move(y, PATEDITOR_SEP2_X); con.prnch(0xB3)
    }

    const activeRow = getActiveRowForDetail()
    const key = `${patternIdx}:${activeRow}:${playbackMode}`
    if (key !== simStateKey) {
        simState    = simulateRowState(song.patterns[patternIdx], activeRow)
        simStateKey = key
    }
    drawVoiceDetail(true, song.patterns[patternIdx], activeRow, simState)
}

function patternsInput(wo, event) {
    const keysym     = event[1]
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 4 : 1

    if (playbackMode !== PLAYMODE_NONE) {
        if ((keyJustHit && shiftDown && event.includes(keys.Y)) || keysym === " ") {
            stopPlayback(); simStateKey = ''; drawPatternsContents(wo); drawAlwaysOnElems()
        }
        return
    }

    if (keyJustHit && shiftDown && event.includes(keys.U)) { startPlayPattern(); drawPatternsContents(wo); return }
    if (              shiftDown && event.includes(keys.I)) { startPlayPatternRow(); drawPatternGrid(); return }
    if ((keyJustHit && shiftDown && event.includes(keys.O)) || keysym === " ") { stopPlayback(); drawAlwaysOnElems(); return }

    if (song.numPats === 0) return

    if (keysym === '<UP>' || keysym === '<DOWN>') {
        patternGridRow += (keysym === '<UP>') ? -moveDelta : moveDelta
        clampPatternGrid()
        simStateKey = ''
        drawPatternGrid()
        con.color_pair(colSep, 255)
        for (let y = PTNVIEW_OFFSET_Y - 1; y < PTNVIEW_OFFSET_Y + PTNVIEW_HEIGHT; y++) {
            con.move(y, PATEDITOR_SEP1_X); con.prnch(0xB3)
            con.move(y, PATEDITOR_SEP2_X); con.prnch(0xB3)
        }
        const activeRow = getActiveRowForDetail()
        const key = `${patternIdx}:${activeRow}:${playbackMode}`
        if (key !== simStateKey) { simState = simulateRowState(song.patterns[patternIdx], activeRow); simStateKey = key }
        drawVoiceDetail(true, song.patterns[patternIdx], activeRow, simState)
        drawPatternsHeader()
        return
    }

    if (keysym === '<HOME>') { patternGridRow = 0;              clampPatternGrid(); simStateKey = ''; drawPatternsContents(wo); return }
    if (keysym === '<END>')  { patternGridRow = ROWS_PER_PAT-1; clampPatternGrid(); simStateKey = ''; drawPatternsContents(wo); return }

    if (keysym === '<LEFT>' || keysym === '<RIGHT>') {
        patternGridCol += (keysym === '<LEFT>') ? -1 : 1
        clampPatternGrid()
        drawPatternGridRowAt(patternGridRow - patternGridScroll)
        con.color_pair(colSep, 255)
        con.move(patternGridRow - patternGridScroll + PTNVIEW_OFFSET_Y, PATEDITOR_SEP1_X); con.prnch(0xB3)
        con.move(patternGridRow - patternGridScroll + PTNVIEW_OFFSET_Y, PATEDITOR_SEP2_X); con.prnch(0xB3)
        return
    }

    if (keysym === '<PAGE_UP>' || keysym === '<PAGE_DOWN>') {
        patternIdx += (keysym === '<PAGE_UP>') ? -moveDelta : moveDelta
        clampPatternIdx()
        simStateKey = ''
        drawPatternsContents(wo)
        return
    }
}

const panelTimeline = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, timelineInput, drawTimelineContents, undefined, ()=>{})
const panelOrders   = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, ordersInput,   drawOrdersContents,   undefined, ()=>{})
const panelPatterns = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, patternsInput, drawPatternsContents, undefined, ()=>{})

// External sub-program panels: drawContents launches the sub-program synchronously.
// The sub-program draws rows 4+ and does NOT touch rows 1-3 (drawn by taut.js before launch).
// On exit, the sub-program sets _G.taut_nextPanel to request a tab switch.
function makeExternalPanelDraw(progName) {
    return function(wo) {
        // stop any playback first
        stopPlayback()
        // update the top bar
        drawAlwaysOnElems()

        _G.taut_nextPanel = undefined
        _G.shell.execute(`${progName} ${fullPathObj.full} ${currentPanel}`)
    }
}

function drawProjectContents(wo) {
    fillLine(PTNVIEW_OFFSET_Y - 1, colVoiceHdr, 255)
    for (let y = PTNVIEW_OFFSET_Y; y < SCRH; y++) fillLine(y, colBackPtn, 255)

    let mixerflag = initialTrackerMixerflags
    let flagstrbuf = ''
    let flagstr = [
        ['Linear pan','Equal-energy pan'],
        ['Linear tone','Amiga tone'],
    ]
    for (let i = 0; i < flagstr.length; i++) {
        let s = flagstr[i][(mixerflag >>> i) & 1 != 0]
        if (i > 0) flagstrbuf += ', ';
        flagstrbuf += s
    }


    let projMeta = {
        Filename: fullPathObj.string.split('\\').last(),
        Patterns: `${song.numPats}/4095 ($${song.numPats.hex03()})`,
        Cues: `${song.lastActiveCue}/1024 ($${song.lastActiveCue.hex03()})`,
        Notation: pitchTablePresets[PITCH_PRESET_IDX].name,
        Flags: `${flagstrbuf} ($${mixerflag.hex02()})`,
    }

    Object.entries(projMeta).forEach(([key, value], index) => {
        con.move(PTNVIEW_OFFSET_Y + index, 2)
        con.color_pair(colStatus, 255); print(key)
        con.move(PTNVIEW_OFFSET_Y + index, 12)
        con.color_pair(colVoiceHdr, colBLACK); print(value)
    })

    con.color_pair(colStatus, 255) // reset colour
}
function externalPanelInput(wo, event) {}

const panelSamples  = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, externalPanelInput, makeExternalPanelDraw('taut_sampleedit'), undefined, ()=>{})
const panelInstrmnt = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, externalPanelInput, makeExternalPanelDraw('taut_instredit'),  undefined, ()=>{})
const panelProject  = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, externalPanelInput, drawProjectContents,                       undefined, ()=>{})
const panelFile     = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, externalPanelInput, makeExternalPanelDraw('taut_fileop'),       undefined, ()=>{})

const panels = [panelTimeline, panelOrders, panelPatterns, panelSamples, panelInstrmnt, panelProject, panelFile]

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// PLAYBACK STATE
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

const PLAYHEAD = 0

// Scratch cue slot used for pattern-only preview; beyond any real cue the song uses
const PREVIEW_CUE_IDX = NUM_CUES - 1

let playbackMode = PLAYMODE_NONE
let playStartCue = 0
let playStartRow = 0
let pbCue = 0
let pbRow = 0
let previewActive = false  // true while a pattern-only preview is loaded in PREVIEW_CUE_IDX

// Encode a cue object (from song.cues[]) back to its 32-byte wire format
function encodeCue(cue) {
    const bin = new Uint8Array(CUE_SIZE)
    for (let i = 0; i < 10; i++) {
        const p0 = cue.ptns[i*2], p1 = cue.ptns[i*2+1]
        bin[i]    = ((p0 & 0xF) << 4)        | (p1 & 0xF)
        bin[10+i] = (((p0 >> 4) & 0xF) << 4) | ((p1 >> 4) & 0xF)
        bin[20+i] = (((p0 >> 8) & 0xF) << 4) | ((p1 >> 8) & 0xF)
    }
    bin[30] = cue.instr || 0
    return bin
}

// Build a preview cue with voice 0 = pidx, all other voices = CUE_EMPTY
function buildPreviewCue(pidx) {
    const bin = new Uint8Array(CUE_SIZE)
    for (let b = 0; b < 30; b++) bin[b] = 0xFF
    bin[0]  = ((pidx & 0xF) << 4)        | 0xF
    bin[10] = (((pidx >> 4) & 0xF) << 4) | 0xF
    bin[20] = (((pidx >> 8) & 0xF) << 4) | 0xF
    return bin
}

// Restore the scratch cue slot and original BPM/tickRate before full-song playback
function restoreFullSongParams() {
    if (!previewActive) return
    audio.uploadCue(PREVIEW_CUE_IDX, encodeCue(song.cues[PREVIEW_CUE_IDX]))
    audio.setBPM(PLAYHEAD, song.bpm)
    audio.setTickRate(PLAYHEAD, song.tickRate)
    previewActive = false
}

function startPlaySong() {
    restoreFullSongParams()
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
    restoreFullSongParams()
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

function startPlayRow(fromRow, fromCue) {
    restoreFullSongParams()
    if (fromRow === undefined) fromRow = cursorRow
    if (fromCue === undefined) fromCue = cueIdx
    audio.stop(PLAYHEAD)
    audio.setCuePosition(PLAYHEAD, fromCue)
    audio.setTrackerRow(PLAYHEAD, fromRow)
    playStartCue = fromCue
    playStartRow = fromRow
    pbCue = fromCue
    pbRow = fromRow
    playbackMode = PLAYMODE_ROW
    audio.play(PLAYHEAD)
}

function startPlayPattern() {
    if (song.numPats === 0) return
    audio.stop(PLAYHEAD)
    audio.setBPM(PLAYHEAD, song.bpm)
    audio.setTickRate(PLAYHEAD, song.tickRate)
    audio.uploadCue(PREVIEW_CUE_IDX, buildPreviewCue(patternIdx))
    audio.setCuePosition(PLAYHEAD, PREVIEW_CUE_IDX)
    audio.setTrackerRow(PLAYHEAD, 0)
    playStartCue = PREVIEW_CUE_IDX
    pbCue = PREVIEW_CUE_IDX
    pbRow = 0
    playbackMode = PLAYMODE_CUE
    previewActive = true
    audio.play(PLAYHEAD)
}

function startPlayPatternRow() {
    if (song.numPats === 0) return
    audio.stop(PLAYHEAD)
    audio.setBPM(PLAYHEAD, song.bpm)
    audio.setTickRate(PLAYHEAD, song.tickRate)
    audio.uploadCue(PREVIEW_CUE_IDX, buildPreviewCue(patternIdx))
    audio.setCuePosition(PLAYHEAD, PREVIEW_CUE_IDX)
    audio.setTrackerRow(PLAYHEAD, patternGridRow)
    playStartCue = PREVIEW_CUE_IDX
    playStartRow = patternGridRow
    pbCue = PREVIEW_CUE_IDX
    pbRow = patternGridRow
    playbackMode = PLAYMODE_ROW
    previewActive = true
    audio.play(PLAYHEAD)
}

function stopPlayback() {
    audio.stop(PLAYHEAD)
    playbackMode = PLAYMODE_NONE
    clampPatternGrid()
}

function updatePlayback() {
    if (!audio.isPlaying(PLAYHEAD)) {
        playbackMode = PLAYMODE_NONE
        clampPatternGrid()
        if (currentPanel === VIEW_TIMELINE &&
                cursorRow >= scrollRow && cursorRow < scrollRow + PTNVIEW_HEIGHT)
            drawPatternRowAt(cursorRow - scrollRow)
        else if (currentPanel === VIEW_PATTERN_DETAILS && song.numPats > 0) { simStateKey = ''; redrawPanel() }
        drawAlwaysOnElems()
        return
    }

    const nowCue = audio.getCuePosition(PLAYHEAD)
    const nowRow = audio.getTrackerRow(PLAYHEAD)

    if (playbackMode === PLAYMODE_CUE && nowCue !== playStartCue) {
        stopPlayback()
        if (currentPanel === VIEW_TIMELINE) redrawPanel()
        else if (currentPanel === VIEW_PATTERN_DETAILS && song.numPats > 0) { simStateKey = ''; redrawPanel() }
        drawAlwaysOnElems()
        return
    }
    if (playbackMode === PLAYMODE_ROW && (nowRow !== playStartRow || nowCue !== playStartCue)) {
        stopPlayback()
        if (currentPanel === VIEW_TIMELINE &&
                cursorRow >= scrollRow && cursorRow < scrollRow + PTNVIEW_HEIGHT)
            drawPatternRowAt(cursorRow - scrollRow)
        else if (currentPanel === VIEW_PATTERN_DETAILS && song.numPats > 0) { simStateKey = ''; redrawPanel() }
        drawAlwaysOnElems()
        return
    }

    if (nowCue === pbCue && nowRow === pbRow) return

    pbCue = nowCue
    pbRow = nowRow

    if (!previewActive && nowCue !== cueIdx) {
        cueIdx = nowCue
        cursorRow = nowRow
        clampCursor()
        if (currentPanel === VIEW_TIMELINE) redrawPanel()
        else if (currentPanel === VIEW_PATTERN_DETAILS && song.numPats > 0) { simStateKey = ''; redrawPanel() }
        else if (currentPanel === VIEW_CUES) {
            if (cueIdx < ordersScroll) ordersScroll = cueIdx
            if (cueIdx >= ordersScroll + PTNVIEW_HEIGHT) ordersScroll = Math.max(0, cueIdx - PTNVIEW_HEIGHT + 1)
            drawOrdersContents()
        }
    } else if (previewActive || nowCue === cueIdx) {
        const oldCursor = cursorRow
        const oldScroll = scrollRow
        cursorRow = nowRow
        clampCursor()
        if (currentPanel === VIEW_TIMELINE) {
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
            drawSeparators(separatorStyle)
            drawVoiceDetail()
        } else if (currentPanel === VIEW_PATTERN_DETAILS && song.numPats > 0) {
            simStateKey = ''
            const activeRow = getActiveRowForDetail()
            simState    = simulateRowState(song.patterns[patternIdx], activeRow)
            simStateKey = `${patternIdx}:${activeRow}:${playbackMode}`
            scrollPatternGridTo(pbRow)
            drawPatternGrid()
            drawVoiceDetail(true, song.patterns[patternIdx], activeRow, simState)
        }
        drawAlwaysOnElems()
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
    // keep cursor centred until view reaches an edge (mirrors clampCursor logic)
    if (cursorVox < voiceOff + (VOCSIZE_TIMELINE_FULL>>>1) && voiceOff > 0) voiceOff = cursorVox - (VOCSIZE_TIMELINE_FULL>>>1)
    if (cursorVox >= voiceOff + ((VOCSIZE_TIMELINE_FULL+1)>>>1)) voiceOff = cursorVox - ((VOCSIZE_TIMELINE_FULL+1)>>>1) + 1
    const maxOff = Math.max(0, song.numVoices - VOCSIZE_TIMELINE_FULL)
    if (voiceOff < 0) voiceOff = 0
    if (voiceOff > maxOff) voiceOff = maxOff
}

function clampCue() {
    const maxCue = song.lastActiveCue < 0 ? 0 : song.lastActiveCue
    if (cueIdx < 0) cueIdx = 0
    if (cueIdx > maxCue) cueIdx = maxCue
}

function clampOrdersHoriz() {
    if (ordersColCursor < 0) ordersColCursor = 0
    if (ordersColCursor > song.numVoices) ordersColCursor = song.numVoices
    if (ordersColCursor >= 1) {
        const v = ordersColCursor - 1
        if (v < ordersVoiceOff) ordersVoiceOff = v
        if (v >= ordersVoiceOff + VOCSIZE_ORDERS) ordersVoiceOff = v - VOCSIZE_ORDERS + 1
        if (ordersVoiceOff < 0) ordersVoiceOff = 0
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// GOTO POPUP
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

const GOTO_POPUP_W = 26
const GOTO_POPUP_H = 5

const popupDrawFrame = (wo) => {
    // draw header
    con.move(wo.y, wo.x)
    con.color_pair(colTabBarOrn, colTabBarBack)
    print(`\u00FB`.repeat(wo.width))

    // imprint title
    let titleWidth = wo.title.length
    con.move(wo.y, wo.x + (((wo.width - titleWidth - 2) & 254) >>> 1))

    /*let colFore = colTabActive
    let colBack = colTabBarBack2
    let colFore2 = colTabBarBack2
    let colBack2 = colTabBarBack
    con.color_pair(colFore2, colBack2); print(sym.leftshade)
    con.color_pair(colFore, colBack); print(wo.title)
    con.color_pair(colFore2, colBack2); print(sym.rightshade)*/
    con.color_pair(colTabInactive, colTabBarBack); print(` ${wo.title} `)

    // fill content area
    for (let r = 1; r < wo.height - 1; r++) {
        con.move(wo.y + r, wo.x)
        con.color_pair(230, colPopupBack)
        print(' '.repeat(wo.width))
    }
}

function drawGotoPopup(popup, buf) {
    con.color_pair(230, colPopupBack)
    popup.drawFrame()

    const prompts = ['Cue (hex):', 'Cue (hex):', 'Pattern (hex):']
    const promptStr = prompts[currentPanel] || 'Number:'

    con.move(popup.y + 2, popup.x + 2)
    con.color_pair(colWHITE, colPopupBack)
    print(promptStr + ' ')
    con.color_pair(230, 240)
    print('[' + buf.padEnd(3, '_') + ']')

    con.color_pair(colStatus, 255) // reset colour
}

function applyGoto(num) {
    if (currentPanel === VIEW_TIMELINE) {
        cueIdx = num; clampCue()
    } else if (currentPanel === VIEW_CUES) {
        const maxCue = song.lastActiveCue < 0 ? 0 : song.lastActiveCue
        ordersCursor = Math.max(0, Math.min(maxCue, num))
        if (ordersCursor < ordersScroll) ordersScroll = ordersCursor
        if (ordersCursor >= ordersScroll + PTNVIEW_HEIGHT)
            ordersScroll = Math.max(0, ordersCursor - PTNVIEW_HEIGHT + 1)
    } else if (currentPanel === VIEW_PATTERN_DETAILS) {
        patternIdx = num; clampPatternIdx()
    }
}

function openConfirmQuit() {
    const pw = 25 + hasUnsavedChanges * 4
    const ph = 5 + hasUnsavedChanges
    const px = ((SCRW - pw) / 2 | 0) + 1
    const py = ((SCRH - ph) / 2 | 0)

    const popup = new win.WindowObject(px, py, pw, ph, ()=>{}, ()=>{}, 'Quit?', popupDrawFrame)
    popup.isHighlighted = true
    popup.titleBack = colPopupBack

    con.color_pair(230, colPopupBack)
    popup.drawFrame()

    con.move(py + 2, px + 2)
    con.color_pair(colWHITE, colPopupBack)
    print('Exit Microtone? ')
    con.color_pair(230, 240)
    print('[Y/N]')

    if (hasUnsavedChanges) {
        con.move(py + 3, px + 2)
        con.color_pair(colWHITE, colPopupBack)
        print('You have unsaved changes.')
    }

    con.color_pair(colStatus, 255) // reset colour

    let result = false
    let done = false
    let eventJustReceived = true
    while (!done) {
        input.withEvent(ev => {
            if (ev[0] !== 'key_down') return
            if (1 !== ev[2]) return
            const ks = ev[1]

            if (ks === 'y' || ks === 'Y' || ks === '\n') { result = true;  done = true }
            else if (ks === 'n' || ks === 'N' || ks === '<ESC>') { done = true }
        })
    }

    if (!result) drawAll()
    return result
}

function openGotoPopup() {
    const pw = GOTO_POPUP_W
    const ph = GOTO_POPUP_H
    const px = ((SCRW - pw) / 2 | 0) + 1
    const py = ((SCRH - ph) / 2 | 0)

    const popup = new win.WindowObject(px, py, pw, ph, ()=>{}, ()=>{}, 'Go To', popupDrawFrame)
    popup.isHighlighted = true
    popup.titleBack = colTabBarBack

    let buf = ''
    let done = false
    drawGotoPopup(popup, buf)

    let eventJustReceived = true

    while (!done) {
        input.withEvent(ev => {
            if (ev[0] !== 'key_down') return
            const ks = ev[1]
            if (1 !== ev[2]) return // not key just hit

            if (eventJustReceived) { // filter lingering input
                eventJustReceived = false
                return
            }

            if (ks === '<ESC>' || ks === 'x') {
                done = true
            } else if (ks === '\n') {
                if (buf.length > 0) applyGoto(parseInt(buf, 16))
                done = true
            } else if (ks === '\u0008') {
                buf = buf.slice(0, -1)
                drawGotoPopup(popup, buf)
            } else if (ks.length === 1 && '0123456789abcdefABCDEF'.includes(ks) && buf.length < 3) {
                buf += ks.toUpperCase()
                drawGotoPopup(popup, buf)
            }
        })
    }

    drawAll()
}

clampCursor(); clampVoice(); clampCue(); clampOrdersHoriz(); clampPatternIdx(); clampPatternGrid()
drawAll()

resetAudioDevice()
taud.uploadTaudFile(fullPathObj.full, 0, PLAYHEAD)
audio.setMasterVolume(PLAYHEAD, 255)
audio.setMasterPan(PLAYHEAD, 128)
const initialTrackerMixerflags = audio.getTrackerMixerFlags(PLAYHEAD)
const initialGlobalVolume = audio.getSongGlobalVolume(PLAYHEAD)
const initialMixingVolume = audio.getSongMixingVolume(PLAYHEAD)

function isExternalPanel(p) {
    return p === VIEW_SAMPLES || p === VIEW_INSTRMNT || p === VIEW_FILE
}

// Launching a sub-program from inside an input.withEvent callback causes the triggering
// Tab event to leak into the sub-program's own withEvent call (the event hasn't been
// consumed yet when the callback is still executing). We avoid this by deferring the
// actual shell.execute until after withEvent returns.
let exitFlag = false
let pendingExternalDraw = false

while (!exitFlag) {
    input.withEvent(event => {
        if (event[0] !== "key_down") return
        const keysym     = event[1]
        const keyJustHit = (1 == event[2])
        const shiftDown  = (event.includes(59) || event.includes(60))

        if (keyJustHit && keysym === "q") {
            if (openConfirmQuit()) exitFlag = true
            return
        }

        if (keyJustHit && keysym === "<TAB>") {
            currentPanel = (currentPanel + (shiftDown ? -1 : 1))
            if (currentPanel < 0) currentPanel += panels.length
            currentPanel = currentPanel % panels.length
            applyMuteTransition(currentPanel)
            if (isExternalPanel(currentPanel)) {
                // Redraw header now so the tab highlight is visible immediately,
                // but defer the actual sub-program launch to after withEvent returns.
                con.clear(); drawAlwaysOnElems(); drawControlHint()
                pendingExternalDraw = true
            } else {
                drawAll()
            }
            return
        }

        if (keyJustHit && shiftDown && event.includes(keys.G)) {
            openGotoPopup()
            return
        }

        panels[currentPanel].processInput(event)
    })

    // Launch external sub-program OUTSIDE the withEvent callback so the triggering
    // Tab event is fully consumed before the sub-program's event loop begins.
    if (pendingExternalDraw) {
        pendingExternalDraw = false
        redrawPanel()
        while (_G.taut_nextPanel !== undefined && _G.taut_nextPanel !== null) {
            currentPanel = _G.taut_nextPanel
            _G.taut_nextPanel = undefined
            applyMuteTransition(currentPanel)
            if (isExternalPanel(currentPanel)) {
                con.clear(); drawAlwaysOnElems(); drawControlHint()
                redrawPanel()
            } else {
                drawAll()
            }
        }
    }

    if (playbackMode !== PLAYMODE_NONE) updatePlayback()
}

audio.stop(PLAYHEAD)
resetAudioDevice()
sys.free(SCRATCH_PTR)
font.resetLowRom()
font.resetHighRom()
graphics.clearPixels(255)
con.clear()
con.move(1, 1)
con.curs_set(1)
return 0