/**
 * Microtone. formerly known as TSVM Audio Device Tracker. (taut)
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
const DOTHORZ = "\u00B4\u00B5"
const VERT = 0xDA

// global var for the app
_G.TAUT = {};
_G.TAUT.UI = {};
_G.TAUT.UI.NEXTPANEL = undefined;

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
cdemisharp:"\u00A7",
cdemiflat:"\u00A8",
uptick:"\u009A",
dntick:"\u009B",
doubleuptick:"\u009C",
doubledntick:"\u009D",


/* special notes */
keyoff:"\u00A0\u00B1\u00B1\u00A1",
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

/* transport control */
playall:'\u00E1',
playcue:'\u00E2',
playrow:'\u00E3',
stop:'\u00E4',

/* GUI stuffs */
slider1: '\u00E4', // slider knob fitting in 7px cell snugly
slider2: '\u00E5\u00E6', // slider knob fitting in right 6px then 1px to the next cell
slider3: '\u00E7\u00E8', // slider knob fitting in right 5px then 2px to the next cell
slider4: '\u00E9\u00EA', // slider knob fitting in right 4px then 3px to the next cell
slider5: '\u00EB\u00EE', // slider knob fitting in right 3px then 4px to the next cell
slider6: '\u00EF\u00F0', // slider knob fitting in right 2px then 5px to the next cell
slider7: '\u00F1\u00F2', // slider knob fitting in right 1px then 6px to the next cell

vhairline1: '\u00AD', // vertical line on left 1px
vhairline2: '\u00AE', // vertical line on left 2px
vhairline3: '\u00AF', // vertical line on left 3px
vhairline4: '\u00DA', // vertical line on the centre
vhairline5: '\u00F6', // vertical line on left 5px
vhairline6: '\u00F7', // vertical line on left 6px
vhairline7: '\u00F8', // vertical line on left 7px

taut_scrollgutter_top: 0xBA,
taut_scrollgutter_mid: 0xBB,
taut_scrollgutter_bot: 0xBC,
taut_scrollgutter_top_full: 0xBD,
taut_scrollgutter_mid_full: 0xBE,
taut_scrollgutter_bot_full: 0xBF,

blob0: '\u00840u',
blob1: '\u00841u',
blob2: '\u00842u',
blob3: '\u00843u',
blob4: '\u00844u',
blob5: '\u00845u',
blob6: '\u00846u',
blob7: '\u00847u',
blob8: '\u00848u',
blob9: '\u00849u',
blob10: '\u008410u',

unticked: '\u009E',
ticked: '\u009F',

/* miscellaneous */
middot:MIDDOT,
doubledot:"\u008419u",
statusstop:"\u008420u\u008421u",
statusplay:"\u008422u\u008423u",
playhead:"\u00E0",

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
'7':"Pattern Ditto",
'8':"Bitcrusher   ",
'9':"Overdrive    ",
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
K:"Vibrafade    ",
L:"Portafade    ",
M:"Channel vol  ",
N:"Chan.volslide",
O:"Sample offset",
P:"Chan.panslide",
Q:"Retrigger    ",
R:"Tremolo      ",
S:"Special      ",
S0:"Amiga Filter ",
S1:"Gliss. ctrl  ",
S2:"Sample tune  ",
S3:"Vibrato LFO  ",
S4:"Tremolo LFO  ",
S5:"Panbrello LFO",
S6:"Fine delay   ",
S7:"Note action  ",
S8:"Channel pan  ", // Taud: 8-bit channel panning
S9:"UNIMPLEMENTED", // IT: Sound control
SA:"UNIMPLEMENTED", // ST3: Stereo control. IT: Sample offset high twobyte (not applicable because Taud has 64k limit)
SB:"Pattern loop ",
SC:"Note cut     ",
SD:"Note delay   ",
SE:"Pattern delay",
SF:"Funk repeat  ",
T:"Tempo        ",
U:"Fine vibrato ",
V:"Global volume",
W:"G.Vol Slide  ",
X:"UNIMPLEMENTED", // IT: 8-bit channel panning. Use S 80xx instead
Y:"Panbrello    ",
Z:"UNIMPLEMENTED", // IT: MIDI macro
}
const panFxNames = {
0:"Set to",
1:"Slide R",
2:"Slide L",
3:"Fine slide",
30:"Fine slide R",
31:"Fine slide L",
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
// t: type of the tuning. M - Macrotonal, m - microtonal, d - 12-tone
    
0:{index:0,name:"Raw format",table:[],interval:0x1000,t:'',sym:[]}, // when null is specified, hex numbers will be displayed instead
/* Xenharmonic, equal temperament */
10:{index:10,name:"Octave only",table:[0x0],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`]},
20:{index:20,name:"2-TET",table:[0x0,0x800],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`,`F${sym.sharp}`]},
30:{index:30,name:"3-TET",table:[0x0,0x555,0xAAB],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`,`E${sym.accnull}`,`G${sym.sharp}`]},
40:{index:40,name:"4-TET",table:[0x0,0x400,0x800,0xC00],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`,`D${sym.sharp}`,`F${sym.sharp}`,`A${sym.accnull}`]},
50:{index:50,name:"5-TET",table:[0x0,0x333,0x666,0x99A,0xCCD],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`,`D${sym.accnull}`,`E${sym.accnull}`,`G${sym.accnull}`,`A${sym.accnull}`]},
60:{index:60,name:"6-TET",table:[0x0,0x2AB,0x555,0x800,0xAAB,0xD55],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`,`D${sym.accnull}`,`E${sym.accnull}`,`F${sym.sharp}`,`G${sym.sharp}`,`A${sym.sharp}`]},
70:{index:70,name:"7-TET",table:[0x0,0x249,0x492,0x6DB,0x925,0xB6E,0xDB7],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`,`D${sym.accnull}`,`E${sym.accnull}`,`F${sym.accnull}`,`G${sym.accnull}`,`A${sym.accnull}`,`B${sym.accnull}`]},
80:{index:80,name:"8-TET",table:[0x0,0x200,0x400,0x600,0x800,0xA00,0xC00,0xE00],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`,`D${sym.accnull}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.sharp}`,`A${sym.accnull}`,`B${sym.accnull}`]},
90:{index:90,name:"9-TET",table:[0x0,0x1C7,0x38E,0x555,0x71C,0x8E4,0xAAB,0xC72,0xE39],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`,`D${sym.accnull}`,`E${sym.accnull}`,`E${sym.sharp}`,`F${sym.accnull}`,`G${sym.accnull}`,`A${sym.accnull}`,`B${sym.accnull}`,`B${sym.sharp}`]},
100:{index:100,name:"10-TET",table:[0x0,0x19A,0x333,0x4CD,0x666,0x800,0x99A,0xB33,0xCCD,0xE66],interval:0x1000,t:'M',
sym:[`C${sym.accnull}`,`D${sym.flat}`,`D${sym.accnull}`,`E${sym.flat}`,`E${sym.accnull}`,`E${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`]},
150:{index:150,name:"15-TET",table:[0x0,0x111,0x222,0x333,0x444,0x555,0x666,0x777,0x889,0x99A,0xAAB,0xBBC,0xCCD,0xDDE,0xEEF],interval:0x1000,t:'m',
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.flat}`,`E${sym.accnull}`,`E${sym.sharp}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.flat}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.flat}`,`B${sym.accnull}`]},
160:{index:160,name:"16-TET",table:[0x0,0x100,0x200,0x300,0x400,0x500,0x600,0x700,0x800,0x900,0xA00,0xB00,0xC00,0xD00,0xE00,0xF00],interval:0x1000,t:'m',
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`E${sym.sharp}`,`F${sym.flat}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`,`B${sym.sharp}`,`C${sym.flat}`]},
170:{index:170,name:"17-TET",table:[0x0,0xF1,0x1E2,0x2D3,0x3C4,0x4B5,0x5A6,0x697,0x788,0x878,0x969,0xA5A,0xB4B,0xC3C,0xD2D,0xE1E,0xF0F],interval:0x1000,t:'m',
sym:[`C${sym.accnull}`,`D${sym.flat}`,`C${sym.sharp}`,`D${sym.accnull}`,`E${sym.flat}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`G${sym.flat}`,`F${sym.sharp}`,`G${sym.accnull}`,`A${sym.flat}`,`G${sym.sharp}`,`A${sym.accnull}`,`B${sym.flat}`,`A${sym.sharp}`,`B${sym.accnull}`]},
190:{index:190,name:"19-TET",table:[0x0,0xD8,0x1AF,0x287,0x35E,0x436,0x50D,0x5E5,0x6BD,0x794,0x86C,0x943,0xA1B,0xAF3,0xBCA,0xCA2,0xD79,0xE51,0xF28],interval:0x1000,t:'m',
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.flat}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.flat}`,`E${sym.accnull}`,`E${sym.sharp}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.flat}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.flat}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.flat}`,`B${sym.accnull}`,`B${sym.sharp}`]},
220:{index:220,name:"22-TET",table:[0x0,0xBA,0x174,0x22F,0x2E9,0x3A3,0x45D,0x517,0x5D1,0x68C,0x746,0x800,0x8BA,0x974,0xA2F,0xAE9,0xBA3,0xC5D,0xD17,0xDD1,0xE8C,0xF46],interval:0x1000,t:'m',
sym:[`C${sym.accnull}`,`C${sym.demisharp}`,`C${sym.sharp}`,`D${sym.demiflat}`,`D${sym.accnull}`,`D${sym.demisharp}`,`D${sym.sharp}`,`E${sym.demiflat}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.demisharp}`,`F${sym.sharp}`,`G${sym.demiflat}`,`G${sym.accnull}`,`G${sym.demisharp}`,`G${sym.sharp}`,`A${sym.demiflat}`,`A${sym.accnull}`,`A${sym.demisharp}`,`A${sym.sharp}`,`B${sym.demiflat}`,`B${sym.accnull}`]},
240:{index:240,name:"24-TET",table:[0x0,0xAB,0x155,0x200,0x2AB,0x355,0x400,0x4AB,0x555,0x600,0x6AB,0x755,0x800,0x8AB,0x955,0xA00,0xAAB,0xB55,0xC00,0xCAB,0xD55,0xE00,0xEAB,0xF55],interval:0x1000,t:'m',
sym:[`C${sym.accnull}`,`C${sym.demisharp}`,`C${sym.sharp}`,`D${sym.demiflat}`,`D${sym.accnull}`,`D${sym.demisharp}`,`D${sym.sharp}`,`E${sym.demiflat}`,`E${sym.accnull}`,`E${sym.demisharp}`,`F${sym.accnull}`,`F${sym.demisharp}`,`F${sym.sharp}`,`G${sym.demiflat}`,`G${sym.accnull}`,`G${sym.demisharp}`,`G${sym.sharp}`,`A${sym.demiflat}`,`A${sym.accnull}`,`A${sym.demisharp}`,`A${sym.sharp}`,`B${sym.demiflat}`,`B${sym.accnull}`,`B${sym.demisharp}`]},
310:{index:310,name:"31-TET",table:[0x0,0x84,0x108,0x18C,0x211,0x295,0x319,0x39D,0x421,0x4A5,0x529,0x5AD,0x632,0x6B6,0x73A,0x7BE,0x842,0x8C6,0x94A,0x9CE,0xA53,0xAD7,0xB5B,0xBDF,0xC63,0xCE7,0xD6B,0xDEF,0xE74,0xEF8,0xF7C],interval:0x1000,t:'m',
sym:[`C${sym.accnull}`,`C${sym.demisharp}`,`C${sym.sharp}`,`D${sym.flat}`,`D${sym.demiflat}`,`D${sym.accnull}`,`D${sym.demisharp}`,`D${sym.sharp}`,`E${sym.flat}`,`E${sym.demiflat}`,`E${sym.accnull}`,`E${sym.demisharp}`,`F${sym.demiflat}`,`F${sym.accnull}`,`F${sym.demisharp}`,`F${sym.sharp}`,`G${sym.flat}`,`G${sym.demiflat}`,`G${sym.accnull}`,`G${sym.demisharp}`,`G${sym.sharp}`,`A${sym.flat}`,`A${sym.demiflat}`,`A${sym.accnull}`,`A${sym.demisharp}`,`A${sym.sharp}`,`B${sym.flat}`,`B${sym.demiflat}`,`B${sym.accnull}`,`B${sym.demisharp}`,`C${sym.demiflat}`]},
410:{index:410,name:"41-TET (Kite)",table:[0x0,0x64,0xC8,0x12C,0x190,0x1F4,0x257,0x2BB,0x31F,0x383,0x3E7,0x44B,0x4AF,0x513,0x577,0x5DB,0x63E,0x6A2,0x706,0x76A,0x7CE,0x832,0x896,0x8FA,0x95E,0x9C2,0xA25,0xA89,0xAED,0xB51,0xBB5,0xC19,0xC7D,0xCE1,0xD45,0xDA9,0xE0C,0xE70,0xED4,0xF38,0xF9C],interval:0x1000,t:'m',
sym:[`${BIGDOT}C-`,`${sym.uptick}C-`,`${sym.doubledntick}C${sym.csharp}`,`${sym.dntick}C${sym.csharp}`,`${BIGDOT}C${sym.csharp}`,`${sym.uptick}C${sym.csharp}`,`${sym.dntick}D-`,`${BIGDOT}D-`,`${sym.uptick}D-`,`${sym.doubledntick}D${sym.csharp}`,`${sym.dntick}D${sym.csharp}`,`${BIGDOT}D${sym.csharp}`,`${sym.uptick}D${sym.csharp}`,`${sym.dntick}E-`,`${BIGDOT}E-`,`${sym.uptick}E-`,`${sym.doubleuptick}E-`,`${BIGDOT}F-`,`${sym.uptick}F-`,`${sym.doubledntick}F${sym.csharp}`,`${sym.dntick}F${sym.csharp}`,`${BIGDOT}F${sym.csharp}`,`${sym.uptick}F${sym.csharp}`,`${sym.dntick}G-`,`${BIGDOT}G-`,`${sym.uptick}G-`,`${sym.doubledntick}G${sym.csharp}`,`${sym.dntick}G${sym.csharp}`,`${BIGDOT}G${sym.csharp}`,`${sym.uptick}G${sym.csharp}`,`${sym.dntick}A-`,`${BIGDOT}A-`,`${sym.uptick}A-`,`${sym.doubledntick}A${sym.csharp}`,`${sym.dntick}A${sym.csharp}`,`${BIGDOT}A${sym.csharp}`,`${sym.uptick}A${sym.csharp}`,`${sym.dntick}B-`,`${BIGDOT}B-`,`${sym.uptick}B-`,`${sym.doubleuptick}B-`]},
530:{index:530,name:"53-TET (Kite)",table:[0x0,0x4D,0x9B,0xE8,0x135,0x182,0x1D0,0x21D,0x26A,0x2B8,0x305,0x352,0x39F,0x3ED,0x43A,0x487,0x4D5,0x522,0x56F,0x5BC,0x60A,0x657,0x6A4,0x6F2,0x73F,0x78C,0x7D9,0x827,0x874,0x8C1,0x90E,0x95C,0x9A9,0x9F6,0xA44,0xA91,0xADE,0xB2B,0xB79,0xBC6,0xC13,0xC61,0xCAE,0xCFB,0xD48,0xD96,0xDE3,0xE30,0xE7E,0xECB,0xF18,0xF65,0xFB3],interval:0x1000,t:'m',
sym:[`${BIGDOT}C-`,`${sym.uptick}C-`,`${sym.doubleuptick}C-`,`${sym.doubledntick}C${sym.csharp}`,`${sym.dntick}C${sym.csharp}`,`${BIGDOT}C${sym.csharp}`,`${sym.uptick}C${sym.csharp}`,`${sym.doubledntick}D-`,`${sym.dntick}D-`,`${BIGDOT}D-`,`${sym.uptick}D-`,`${sym.doubleuptick}D-`,`${sym.doubledntick}D${sym.csharp}`,`${sym.dntick}D${sym.csharp}`,`${BIGDOT}D${sym.csharp}`,`${sym.uptick}D${sym.csharp}`,`${sym.doubledntick}E-`,`${sym.dntick}E-`,`${BIGDOT}E-`,`${sym.uptick}E-`,`${sym.doubleuptick}E-`,`${sym.dntick}F-`,`${BIGDOT}F-`,`${sym.uptick}F-`,`${sym.doubleuptick}F-`,`${sym.doubledntick}F${sym.csharp}`,`${sym.dntick}F${sym.csharp}`,`${BIGDOT}F${sym.csharp}`,`${sym.uptick}F${sym.csharp}`,`${sym.doubledntick}G-`,`${sym.dntick}G-`,`${BIGDOT}G-`,`${sym.uptick}G-`,`${sym.doubleuptick}G-`,`${sym.doubledntick}G${sym.csharp}`,`${sym.dntick}G${sym.csharp}`,`${BIGDOT}G${sym.csharp}`,`${sym.uptick}G${sym.csharp}`,`${sym.doubledntick}A-`,`${sym.dntick}A-`,`${BIGDOT}A-`,`${sym.uptick}A-`,`${sym.doubleuptick}A-`,`${sym.doubledntick}A${sym.csharp}`,`${sym.dntick}A${sym.csharp}`,`${BIGDOT}A${sym.csharp}`,`${sym.uptick}A${sym.csharp}`,`${sym.doubledntick}B-`,`${sym.dntick}B-`,`${BIGDOT}B-`,`${sym.uptick}B-`,`${sym.doubleuptick}B-`,`${sym.dntick}C-`]},
531:{index:531,name:"53-TET (Pythagorean)",table:[0x0,0x4D,0x9B,0xE8,0x135,0x182,0x1D0,0x21D,0x26A,0x2B8,0x305,0x352,0x39F,0x3ED,0x43A,0x487,0x4D5,0x522,0x56F,0x5BC,0x60A,0x657,0x6A4,0x6F2,0x73F,0x78C,0x7D9,0x827,0x874,0x8C1,0x90E,0x95C,0x9A9,0x9F6,0xA44,0xA91,0xADE,0xB2B,0xB79,0xBC6,0xC13,0xC61,0xCAE,0xCFB,0xD48,0xD96,0xDE3,0xE30,0xE7E,0xECB,0xF18,0xF65,0xFB3],interval:0x1000,t:'m',
sym:[`C${sym.accnull}`,`B${sym.sharp}`,`A${sym.triplesharp}`,`E${sym.tripleflat}`,`D${sym.flat}`,`C${sym.sharp}`,`B${sym.doublesharp}`,`F${sym.tripleflat}`,`E${sym.doubleflat}`,`D${sym.accnull}`,`C${sym.doublesharp}`,`B${sym.triplesharp}`,`F${sym.doubleflat}`,`E${sym.flat}`,`D${sym.sharp}`,`C${sym.triplesharp}`,`G${sym.tripleflat}`,`F${sym.flat}`,`E${sym.accnull}`,`D${sym.doublesharp}`,`C${sym.quadsharp}`,`G${sym.doubleflat}`,`F${sym.accnull}`,`E${sym.sharp}`,`D${sym.triplesharp}`,`A${sym.tripleflat}`,`G${sym.flat}`,`F${sym.sharp}`,`E${sym.doublesharp}`,`D${sym.quadsharp}`,`A${sym.doubleflat}`,`G${sym.accnull}`,`F${sym.doublesharp}`,`E${sym.triplesharp}`,`B${sym.tripleflat}`,`A${sym.flat}`,`G${sym.sharp}`,`F${sym.triplesharp}`,`C${sym.tripleflat}`,`B${sym.doubleflat}`,`A${sym.accnull}`,`G${sym.doublesharp}`,`F${sym.quadsharp}`,`C${sym.doubleflat}`,`B${sym.flat}`,`A${sym.sharp}`,`G${sym.triplesharp}`,`D${sym.tripleflat}`,`C${sym.flat}`,`B${sym.accnull}`,`A${sym.doublesharp}`,`G${sym.quadsharp}`,`D${sym.doubleflat}`]},
960:{index:960,name:"96-TET (Kite)",table:[0x0,0x2B,0x55,0x80,0xAB,0xD5,0x100,0x12B,0x155,0x180,0x1AB,0x1D5,0x200,0x22B,0x255,0x280,0x2AB,0x2D5,0x300,0x32B,0x355,0x380,0x3AB,0x3D5,0x400,0x42B,0x455,0x480,0x4AB,0x4D5,0x500,0x52B,0x555,0x580,0x5AB,0x5D5,0x600,0x62B,0x655,0x680,0x6AB,0x6D5,0x700,0x72B,0x755,0x780,0x7AB,0x7D5,0x800,0x82B,0x855,0x880,0x8AB,0x8D5,0x900,0x92B,0x955,0x980,0x9AB,0x9D5,0xA00,0xA2B,0xA55,0xA80,0xAAB,0xAD5,0xB00,0xB2B,0xB55,0xB80,0xBAB,0xBD5,0xC00,0xC2B,0xC55,0xC80,0xCAB,0xCD5,0xD00,0xD2B,0xD55,0xD80,0xDAB,0xDD5,0xE00,0xE2B,0xE55,0xE80,0xEAB,0xED5,0xF00,0xF2B,0xF55,0xF80,0xFAB,0xFD5],interval:0x1000,t:'m',
sym:[`${BIGDOT}C-`,`${sym.uptick}C-`,`${sym.doubleuptick}C-`,`${sym.dntick}C${sym.cdemisharp}`,`${BIGDOT}C${sym.cdemisharp}`,`${sym.uptick}C${sym.cdemisharp}`,`${sym.doubleuptick}C${sym.cdemisharp}`,`${sym.dntick}C${sym.csharp}`,`${BIGDOT}C${sym.csharp}`,`${sym.uptick}C${sym.csharp}`,`${sym.doubleuptick}C${sym.csharp}`,`${sym.dntick}D${sym.cdemiflat}`,`${BIGDOT}D${sym.cdemiflat}`,`${sym.uptick}D${sym.cdemiflat}`,`${sym.doubleuptick}D${sym.cdemiflat}`,`${sym.dntick}D-`,`${BIGDOT}D-`,`${sym.uptick}D-`,`${sym.doubleuptick}D-`,`${sym.dntick}D${sym.cdemisharp}`,`${BIGDOT}D${sym.cdemisharp}`,`${sym.uptick}D${sym.cdemisharp}`,`${sym.doubleuptick}D${sym.cdemisharp}`,`${sym.dntick}D${sym.csharp}`,`${BIGDOT}D${sym.csharp}`,`${sym.uptick}D${sym.csharp}`,`${sym.doubleuptick}D${sym.csharp}`,`${sym.dntick}E${sym.cdemiflat}`,`${BIGDOT}E${sym.cdemiflat}`,`${sym.uptick}E${sym.cdemiflat}`,`${sym.doubleuptick}E${sym.cdemiflat}`,`${sym.dntick}E-`,`${BIGDOT}E-`,`${sym.uptick}E-`,`${sym.doubleuptick}E-`,`${sym.dntick}E${sym.cdemisharp}`,`${BIGDOT}E${sym.cdemisharp}`,`${sym.uptick}E${sym.cdemisharp}`,`${sym.doubleuptick}E${sym.cdemisharp}`,`${sym.dntick}F-`,`${BIGDOT}F-`,`${sym.uptick}F-`,`${sym.doubleuptick}F-`,`${sym.dntick}F${sym.cdemisharp}`,`${BIGDOT}F${sym.cdemisharp}`,`${sym.uptick}F${sym.cdemisharp}`,`${sym.doubleuptick}F${sym.cdemisharp}`,`${sym.dntick}F${sym.csharp}`,`${BIGDOT}F${sym.csharp}`,`${sym.uptick}F${sym.csharp}`,`${sym.doubleuptick}F${sym.csharp}`,`${sym.dntick}G${sym.cdemiflat}`,`${BIGDOT}G${sym.cdemiflat}`,`${sym.uptick}G${sym.cdemiflat}`,`${sym.doubleuptick}G${sym.cdemiflat}`,`${sym.dntick}G-`,`${BIGDOT}G-`,`${sym.uptick}G-`,`${sym.doubleuptick}G-`,`${sym.dntick}G${sym.cdemisharp}`,`${BIGDOT}G${sym.cdemisharp}`,`${sym.uptick}G${sym.cdemisharp}`,`${sym.doubleuptick}G${sym.cdemisharp}`,`${sym.dntick}G${sym.csharp}`,`${BIGDOT}G${sym.csharp}`,`${sym.uptick}G${sym.csharp}`,`${sym.doubleuptick}G${sym.csharp}`,`${sym.dntick}A${sym.cdemiflat}`,`${BIGDOT}A${sym.cdemiflat}`,`${sym.uptick}A${sym.cdemiflat}`,`${sym.doubleuptick}A${sym.cdemiflat}`,`${sym.dntick}A-`,`${BIGDOT}A-`,`${sym.uptick}A-`,`${sym.doubleuptick}A-`,`${sym.dntick}A${sym.cdemisharp}`,`${BIGDOT}A${sym.cdemisharp}`,`${sym.uptick}A${sym.cdemisharp}`,`${sym.doubleuptick}A${sym.cdemisharp}`,`${sym.dntick}A${sym.csharp}`,`${BIGDOT}A${sym.csharp}`,`${sym.uptick}A${sym.csharp}`,`${sym.doubleuptick}A${sym.csharp}`,`${sym.dntick}B${sym.cdemiflat}`,`${BIGDOT}B${sym.cdemiflat}`,`${sym.uptick}B${sym.cdemiflat}`,`${sym.doubleuptick}B${sym.cdemiflat}`,`${sym.dntick}B-`,`${BIGDOT}B-`,`${sym.uptick}B-`,`${sym.doubleuptick}B-`,`${sym.dntick}B${sym.cdemisharp}`,`${BIGDOT}B${sym.cdemisharp}`,`${sym.uptick}B${sym.cdemisharp}`,`${sym.doubleuptick}B${sym.cdemisharp}`,`${sym.dntick}C-`]},
/* 12-TET variations */
120:{index:120,name:"12-TET",table:[0x0,0x155,0x2AB,0x400,0x555,0x6AB,0x800,0x955,0xAAB,0xC00,0xD55,0xEAB],interval:0x1000,t:'d',
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},
10121:{index:10121,name:"Pythagorean dim. 5th",table:[0x0,0x134,0x2B8,0x3EC,0x570,0x6A4,0x7D8,0x95C,0xA90,0xC14,0xD48,0xECC],interval:0x1000,t:'d',
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},
10122:{index:10122,name:"Pythagorean aug. 4th",table:[0x0,0x134,0x2B8,0x3EC,0x570,0x6A4,0x828,0x95C,0xA90,0xC14,0xD48,0xECC],interval:0x1000,t:'d',
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`D${sym.sharp}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`G${sym.sharp}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},
10123:{index:10123,name:"\u00FC\u00FD\u00FE (shi'er lu)",         table:[0x0,0x184,0x2B8,0x43C,0x570,0x6F4,0x828,0x95C,0xAE0,0xC14,0xD98,0xECC],interval:0x1000,t:'d',
sym:[` \u00C0\u00C1`,` \u00C2\u00C3`,` \u00C4\u00C5`,` \u00C6\u00C7`,` \u00C8\u00C9`,` \u00CA\u00CB`,` \u00CC\u00CD`,` \u00CE\u00CF`,` \u00D0\u00D1`,` \u00D2\u00D3`,` \u00D4\u00D5`,` \u00D6\u00D7`]},
/* non-octave */
35130:{index:35130,name:"Equal-Tempered Bohlen-Pierce",table:[0x0,0x1F3,0x3E7,0x5DA,0x7CE,0x9C1,0xBB4,0xDA8,0xF9B,0x118E,0x1382,0x1575,0x1769],interval:0x195C,t:'M',
sym:[`C${sym.accnull}`,`C${sym.sharp}`,`D${sym.accnull}`,`E${sym.accnull}`,`F${sym.accnull}`,`F${sym.sharp}`,`G${sym.accnull}`,`H${sym.accnull}`,`H${sym.sharp}`,`J${sym.accnull}`,`A${sym.accnull}`,`A${sym.sharp}`,`B${sym.accnull}`]},


}

// check pitchTablePresets integrity
function checkPitchTablePresetsIntegrity() {
    const seenIndices = {}
    for (const key in pitchTablePresets) {
        const preset = pitchTablePresets[key]
        const keyNum = +key
        if (preset == null) throw Error(`pitchTablePresets[${key}] is null/undefined`)
        if (typeof preset.index !== 'number') throw Error(`pitchTablePresets[${key}].index is not a number`)
        if (preset.index !== keyNum) throw Error(`pitchTablePresets[${key}].index (${preset.index}) does not match its key (${key})`)
        if (seenIndices[preset.index]) throw Error(`duplicate index ${preset.index} in pitchTablePresets`)
        seenIndices[preset.index] = true
        if (typeof preset.name !== 'string') throw Error(`pitchTablePresets[${key}].name is not a string`)
        if (!Array.isArray(preset.table)) throw Error(`pitchTablePresets[${key}].table is not an array`)
        if (!Array.isArray(preset.sym)) throw Error(`pitchTablePresets[${key}].sym is not an array`)
        if (preset.table.length !== preset.sym.length) throw Error(`pitchTablePresets[${key}] (${preset.name}): table.length (${preset.table.length}) != sym.length (${preset.sym.length})`)
        for (let i = 0; i < preset.table.length; i++) {
            const v = preset.table[i]
            if (typeof v !== 'number' || !Number.isFinite(v)) throw Error(`pitchTablePresets[${key}] (${preset.name}): table[${i}] is not a finite number`)
            if (i > 0 && v <= preset.table[i - 1]) throw Error(`pitchTablePresets[${key}] (${preset.name}): table is not strictly ascending at index ${i} (0x${preset.table[i-1].toString(16)} -> 0x${v.toString(16)})`)
        }
        for (let i = 0; i < preset.sym.length; i++) {
            if (typeof preset.sym[i] !== 'string') throw Error(`pitchTablePresets[${key}] (${preset.name}): sym[${i}] is not a string`)
        }
    }
}
checkPitchTablePresetsIntegrity()

const volEffSym = [sym.volset, sym.volup, sym.voldn, sym.volfineup, sym.volfinedn]
const panEffSym = [sym.panset, sym.panri, sym.panle, sym.panfineri, sym.panfinele]

const colNote = 239
const colInst = 114
const colVol = 155
const colPan = 219
const colEffOp = 220
const colEffArg = 231
const colBackPtn = 255

const PITCH_PRESET_IDX_DEFAULT = 120
let PITCH_PRESET_IDX = PITCH_PRESET_IDX_DEFAULT // TODO read from the Project Data section of the .taud
let beatDivPrimary = 4 // TODO read from the Project Data section of the .taud
let beatDivSecondary = 16
let hasUnsavedChanges = false
let patternsOutOfSync = false  // in-memory song.patterns has edits not yet pushed to the audio adapter

// Pitch encoding: a 16-bit absolute value with Middle C anchored at 0x5000.
// For octave systems (interval == 0x1000) the value decomposes naturally as
// (octave << 12) | pitchInOctave. For non-octave systems the "period" (e.g.
// the BP tritave at 0x195C) does not align with 4-bit boundaries; the period
// index and offset must be computed by integer-divmod against the interval,
// using ANCHOR_NOTE / ANCHOR_PERIOD as the fixed reference point.
const ANCHOR_NOTE = 0x5000
const ANCHOR_PERIOD = 5
function decomposeNote(note, interval) {
    const delta = note - ANCHOR_NOTE
    const k = Math.floor(delta / interval)
    return [ANCHOR_PERIOD + k, delta - k * interval]
}
function composeNote(periodIdx, offset, interval) {
    return ANCHOR_NOTE + (periodIdx - ANCHOR_PERIOD) * interval + offset
}

// pitchSymLut[offsetInPeriod] = [symString, periodOffset]
// periodOffset is 1 when offsetInPeriod is closer to the next period's root
// (one `interval` above) than to any table entry — i.e. the note should wrap
// up to the first entry of the next period.
// Call rebuildPitchLut() whenever PITCH_PRESET_IDX changes; the LUT is sized
// to the preset's interval so non-octave tunings (e.g. BP at 0x195C) work.
let pitchSymLut = new Array(0x1000)

function rebuildPitchLut() {
    const preset = pitchTablePresets[PITCH_PRESET_IDX]
    if (!preset || preset.table.length === 0) return
    const table = preset.table
    const syms  = preset.sym
    const interval = preset.interval
    if (pitchSymLut.length !== interval) pitchSymLut = new Array(interval)
    for (let p = 0; p < interval; p++) {
        let best = 0, bestDist = interval
        for (let i = 0; i < table.length; i++) {
            const d = Math.abs(p - table[i])
            if (d < bestDist) { bestDist = d; best = i }
        }
        // Distance to the next period's root (one interval up) vs nearest table entry.
        if ((interval - p) < bestDist) {
            pitchSymLut[p] = [syms[0], 1]
        } else {
            pitchSymLut[p] = [syms[best], 0]
        }
    }
}
rebuildPitchLut()

// Tonal-tension function used by the 'cadence' retune method. Implements
// the tonal-distance term D_tonic from cadential_motion.md §3-§4 by locating
// each pitch in fifth-circle space relative to `tonic`. The abstract 3:2
// fifth (0x95A in 0x1000-per-octave units, ≈ 702 cents) is used as the
// fifth-circle generator, which is tuning-agnostic — the same landscape
// applies whether the candidate sits in 5-TET, 12-TET, 22-TET, etc.
//
// For each integer k in [-6, 6], target_k = (k * 0x95A) mod 0x1000 is the
// k-th fifth-stack position above the tonic (in pitch-class space). Tension
// = |k|*0x100 + |d - target_k|_cyclic, so well-tuned fifth-circle positions
// get low values: tonic 0, P5/P4 ≈ 0x105, M2/m7 ≈ 0x209, M6/m3 ≈ 0x30E,
// M3/m6 ≈ 0x413, M7/m2 ≈ 0x517, tritone ≈ 0x61C. Pitches that don't sit on
// any fifth-stack position degrade gracefully via the residual term.
//
// The k=0 path is gated to a narrow tonic neighbourhood (TONIC_TOL ≈ 30c).
// Otherwise a leading tone would score as "very close to tonic in pitch-
// class space" and pick up an artificially low tension via k=0, masking the
// real musical fact that it's at fifth-circle distance 5 from tonic and
// hence highly tense (cf. Krumhansl's tonal hierarchy: B is the least
// stable diatonic note in C, despite sitting a semitone below C).
function _cadTension(p, tonic, interval) {
    const FIFTH_PC  = 0x95A
    const TONIC_TOL = 0x40
    const half = interval >>> 1
    const d = ((p - tonic) % interval + interval) % interval
    const cyclic = (d <= half) ? d : (interval - d)
    let bestT = (cyclic <= TONIC_TOL) ? cyclic : Infinity
    for (let k = -6; k <= 6; k++) {
        if (k === 0) continue
        const target = ((k * FIFTH_PC) % interval + interval) % interval
        let dist = Math.abs(d - target)
        if (dist > half) dist = interval - dist
        const candT = Math.abs(k) * 0x100 + dist
        if (candT < bestT) bestT = candT
    }
    return bestT
}

// Just-intonation reference ratios (in 0x1000-per-octave units) and pull
// weights used as the harmonic attractor field A(P) for the 'harmonic'
// retune method (see cadence_aware_nearest_harmonic.md §4A). Lower weight
// = simpler ratio = stronger pull. Cost of a candidate is the minimum
// weight*distance across all references.
const _HARM_REFS = [
    [0,     1.0],  // 1:1 unison / 2:1 octave
    [0x1D2, 4.0],  // 9:8 major tone
    [0x435, 3.0],  // 6:5 minor third
    [0x527, 3.0],  // 5:4 major third
    [0x6A4, 2.0],  // 4:3 perfect fourth
    [0x95B, 2.0],  // 3:2 perfect fifth
    [0xAB7, 3.0],  // 8:5 minor sixth
    [0xBCB, 3.0],  // 5:3 major sixth
    [0xD3D, 4.0],  // 9:5 minor seventh
]
function _harmonicCost(p, tonic, interval) {
    const half = interval >>> 1
    const d = ((p - tonic) % interval + interval) % interval
    let best = Infinity
    for (let i = 0; i < _HARM_REFS.length; i++) {
        const ref = _HARM_REFS[i]
        let dist = Math.abs(d - ref[0])
        if (dist > half) dist = interval - dist
        const cost = ref[1] * dist
        if (cost < best) best = cost
    }
    return best
}

// Remap every note in every pattern of the current song to `newIdx`'s pitch
// table, then switch PITCH_PRESET_IDX. Special note values (empty/cut/keyoff)
// are left alone.
//
// Four mapping methods are supported:
//   'pitch' (nearest-note) — each note's lower 12 bits snap to the closest
//       entry in the new table. Pitches closer to the next octave's root
//       (0x1000) than to any table entry wrap up by one octave (mirrors
//       rebuildPitchLut's octaveOffset logic).
//   'delta' (nearest-delta) — per pattern, the first non-empty note uses the
//       nearest-pitch rule; each subsequent note is chosen so that the
//       interval from the previously mapped note is closest to the interval
//       between the corresponding original notes. Candidates are drawn from
//       the table across adjacent octaves so the mapping can cross octave
//       boundaries naturally.
//   'cadence' (nearest-cadence) — per pattern, the first non-empty note's
//       pitch class is taken as the tonic and the first note uses the
//       nearest-pitch rule. Each subsequent note is chosen so that the
//       change in tonal tension (see _cadTension) from the previously
//       mapped note matches the change in the original sequence, with raw
//       pitch displacement as a tiebreaker. This preserves cadential
//       trajectories — V→I-style descents stay V→I-style — rather than
//       absolute pitch positions or raw intervals, mirroring the framing in
//       cadential_motion.md §2 (motion along -∇T) and §9 (trajectories
//       carry cadentiality better than coordinates).
//   'harmonic' (cadence-aware nearest-harmonic) — implements
//       P_n = P_{n-1} + Q(Δ_n) + λ_n A(P_n) from
//       cadence_aware_nearest_harmonic.md §1. Per pattern, the first
//       non-empty note's pitch class is taken as the tonic. Each subsequent
//       note is scored as pitchErr + λ_n * harmonicCost where λ_n
//       = 1 − exp(−(duration−1)/4), with duration measured in rows until
//       the next event in the (still-original) row sequence. Short notes
//       get λ ≈ 0 and behave like nearest-delta — "freedom during travel"
//       (§10) — while sustained / pattern-end notes approach λ → 1 and lock
//       onto the JI attractor field — "precision during landing".
function retuneAllPatterns(newIdx, method) {
    if (method !== 'delta' && method !== 'cadence' && method !== 'harmonic') method = 'pitch'
    const newPreset = pitchTablePresets[newIdx]
    if (!newPreset) return
    const srcPreset = pitchTablePresets[PITCH_PRESET_IDX]
    const newTable = newPreset.table
    const newInterval = newPreset.interval
    // Tension/harmonic shapes are read out of the SOURCE tuning's modular
    // space — they describe the composition the user wrote, not the snap
    // grid we're mapping onto. For octave→octave retunes this collapses to
    // the original behaviour (both intervals are 0x1000).
    const srcInterval = srcPreset.interval || 0x1000

    // Yield candidate absolute pitches in the new tuning whose period root
    // lies within ±1 period of `absRef`. Includes the next period's root
    // itself so a target that lands just past the top entry can snap up.
    const forEachCandidate = (absRef, fn) => {
        const baseK = Math.floor((absRef - ANCHOR_NOTE) / newInterval)
        for (let dK = -1; dK <= 1; dK++) {
            const root = ANCHOR_NOTE + (baseK + dK) * newInterval
            for (let i = 0; i < newTable.length; i++) {
                const cand = root + newTable[i]
                if (cand >= 0 && cand <= 0xFFFF) fn(cand)
            }
            const nextRoot = root + newInterval
            if (nextRoot >= 0 && nextRoot <= 0xFFFF) fn(nextRoot)
        }
    }

    if (newTable.length > 0) {
        for (let p = 0; p < song.numPats; p++) {
            const ptn = song.patterns[p]
            let prevOrigAbs = -1
            let prevMappedAbs = 0
            let tonic = 0
            if (method === 'cadence' || method === 'harmonic') {
                for (let row = 0; row < ROWS_PER_PAT; row++) {
                    const off = 8 * row
                    const note = ptn[off] | (ptn[off+1] << 8)
                    if (note === 0x0000 || note === 0x0001 || note === 0x0002 || (note >= 0x0010 && note <= 0x001F)) continue
                    // Use the full absolute pitch as tonic; the modular ops
                    // in _cadTension / _harmonicCost normalise it.
                    tonic = note
                    break
                }
            }
            for (let row = 0; row < ROWS_PER_PAT; row++) {
                const off = 8 * row
                const note = ptn[off] | (ptn[off+1] << 8)
                if (note === 0x0000 || note === 0x0001 || note === 0x0002 || (note >= 0x0010 && note <= 0x001F)) continue
                const origAbs = note
                let newAbs
                if ((method === 'delta' || method === 'cadence' || method === 'harmonic') && prevOrigAbs >= 0) {
                    const targetAbs = prevMappedAbs + (origAbs - prevOrigAbs)
                    let targetDeltaT = 0, tMappedPrev = 0, lambda = 0
                    if (method === 'cadence') {
                        targetDeltaT = _cadTension(origAbs, tonic, srcInterval) - _cadTension(prevOrigAbs, tonic, srcInterval)
                        tMappedPrev  = _cadTension(prevMappedAbs, tonic, srcInterval)
                    } else if (method === 'harmonic') {
                        let duration = 1
                        for (let r = row + 1; r < ROWS_PER_PAT; r++) {
                            const noff = 8 * r
                            const n = ptn[noff] | (ptn[noff+1] << 8)
                            if (n !== 0x0001) break
                            duration++
                        }
                        lambda = 1 - Math.exp(-(duration - 1) / 4)
                    }
                    let bestAbs = 0, bestScore = Infinity
                    forEachCandidate(targetAbs, (cand) => {
                        const pitchErr = Math.abs(cand - targetAbs)
                        let score = pitchErr
                        if (method === 'cadence') {
                            const candDeltaT = _cadTension(cand, tonic, srcInterval) - tMappedPrev
                            score = Math.abs(candDeltaT - targetDeltaT) * 2 + pitchErr
                        } else if (method === 'harmonic') {
                            score = pitchErr + lambda * _harmonicCost(cand, tonic, srcInterval)
                        }
                        if (score < bestScore) { bestScore = score; bestAbs = cand }
                    })
                    newAbs = bestAbs
                } else {
                    // Nearest-pitch: snap source absolute pitch to the closest
                    // entry in the new tuning's snap grid.
                    let bestAbs = 0, bestDist = Infinity
                    forEachCandidate(origAbs, (cand) => {
                        const d = Math.abs(cand - origAbs)
                        if (d < bestDist) { bestDist = d; bestAbs = cand }
                    })
                    newAbs = bestAbs
                }
                if (newAbs < 0) newAbs = 0
                if (newAbs > 0xFFFF) newAbs = 0xFFFF
                const newNote = newAbs & 0xFFFF
                ptn[off]   = newNote & 0xFF
                ptn[off+1] = (newNote >>> 8) & 0xFF
                prevOrigAbs = origAbs
                prevMappedAbs = newAbs
            }
        }
        hasUnsavedChanges = true
        patternsOutOfSync = true
    }
    PITCH_PRESET_IDX = newIdx
    rebuildPitchLut()
}

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
    if (note === 0x0000) return sym.middot.repeat(4)
    if (note === 0x0001) return sym.keyoff
    if (note === 0x0002) return sym.notecut
    if (note >= 0x0010 && note <= 0x001F) return ('Int' + (note & 0xF).toString(16).toUpperCase()).padEnd(4)
    const preset = pitchTablePresets[PITCH_PRESET_IDX]
    if (preset.table.length === 0) return note.hex04()
    const [period, offset] = decomposeNote(note, preset.interval)
    const [s, o] = pitchSymLut[offset]
    return s + (period - 1 + o).toString(16) // period 10 -> 'a'
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
    _note: 0x0000, _effop: 0, _effarg: 0, _voleff: 0, _paneff: 0
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
    const noteEmpty = (cell._note === 0x0000)
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
        const instr = (sys.peek(cueSheetPtr + c * CUE_SIZE + 30) << 8) | sys.peek(cueSheetPtr + c * CUE_SIZE + 31)
        cues[c] = { ptns, instr }

        for (let v = 0; v < NUM_VOICES; v++) {
            if (ptns[v] !== CUE_EMPTY) { lastActiveCue = c; break }
        }
    }
    sys.free(cueSheetPtr)

    sys.free(ptr)

    return {
        filePath, songIndex, version, numSongs, numVoices, numPats,
        bpm: bpmStored + 25, tickRate,
        patterns, cues, lastActiveCue
    }
}

// Read header + song-table + (optional) sMet from a .taud and return a per-song
// metadata list. Does NOT load patterns / cues / samples — that's loadTaud's job.
// Returned shape:
//   { numSongs, projectName, songs: [
//       { index, numVoices, numPats, bpm, tickRate, songGlobalVolume,
//         songMixingVolume, mixerflags, name, composer, copyright } ] }
function loadTaudSongList(filePath) {
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

    const numSongs = sys.peek(ptr + 9) & 0xFF
    const compSize = _peekU32LE(ptr, 10)
    const projOff  = _peekU32LE(ptr, 14)
    const songTableOff = TAUD_HEADER_SIZE + compSize

    const songs = new Array(numSongs)
    for (let i = 0; i < numSongs; i++) {
        const entryOff = songTableOff + i * TAUD_SONG_ENTRY
        songs[i] = {
            index:            i,
            numVoices:        sys.peek(ptr + entryOff + 4) & 0xFF,
            numPats:          (sys.peek(ptr + entryOff + 5) & 0xFF) |
                              ((sys.peek(ptr + entryOff + 6) & 0xFF) << 8),
            bpm:              ((sys.peek(ptr + entryOff + 7) & 0xFF) + 25),
            tickRate:         sys.peek(ptr + entryOff + 8) & 0xFF,
            mixerflags:       sys.peek(ptr + entryOff + 15) & 0xFF,
            songGlobalVolume: sys.peek(ptr + entryOff + 16) & 0xFF,
            songMixingVolume: sys.peek(ptr + entryOff + 17) & 0xFF,
            name: '',
            composer: '',
            copyright: '',
            pitchPresetIdx: null,
        }
    }

    let projectName = ''
    // 0x1E-separated UTF-8 strings; slot 0 is always present (typically empty)
    // because converters write a leading separator. Read all entries that exist.
    const instNames   = []
    const sampleNames = []

    function parseNameTable(payloadStart, secLen) {
        const out = []
        let s = ''
        for (let k = 0; k < secLen; k++) {
            const b = sys.peek(ptr + payloadStart + k) & 0xFF
            if (b === 0x1E) { out.push(s); s = '' }
            else            { s += String.fromCharCode(b) }
        }
        out.push(s)
        return out
    }

    // Parse Project Data section (\x1ETaudPrJ) for song names / project name.
    // See terranmon.txt "Project Data" / "sMet" for the format.
    if (projOff !== 0 && projOff + 16 <= fileSize) {
        const projMagic = [0x1E,0x54,0x61,0x75,0x64,0x50,0x72,0x4A] // \x1ETaudPrJ
        let magicOK = true
        for (let i = 0; i < 8; i++) {
            if ((sys.peek(ptr + projOff + i) & 0xFF) !== projMagic[i]) { magicOK = false; break }
        }
        if (magicOK) {
            let p = projOff + 16  // skip magic(8) + reserved(8)
            while (p + 8 <= fileSize) {
                const fc0 = sys.peek(ptr + p)     & 0xFF
                const fc1 = sys.peek(ptr + p + 1) & 0xFF
                const fc2 = sys.peek(ptr + p + 2) & 0xFF
                const fc3 = sys.peek(ptr + p + 3) & 0xFF
                const secLen = _peekU32LE(ptr, p + 4)
                const payloadStart = p + 8
                if (payloadStart + secLen > fileSize) break

                // 'PNam' = 0x50,0x4E,0x61,0x6D
                if (fc0 === 0x50 && fc1 === 0x4E && fc2 === 0x61 && fc3 === 0x6D) {
                    let s = ''
                    for (let k = 0; k < secLen; k++) {
                        const b = sys.peek(ptr + payloadStart + k) & 0xFF
                        if (b === 0) break
                        s += String.fromCharCode(b)
                    }
                    projectName = s
                }
                // 'INam' = 0x49,0x4E,0x61,0x6D
                else if (fc0 === 0x49 && fc1 === 0x4E && fc2 === 0x61 && fc3 === 0x6D) {
                    const names = parseNameTable(payloadStart, secLen)
                    for (let k = 0; k < names.length; k++) instNames[k] = names[k]
                }
                // 'SNam' = 0x53,0x4E,0x61,0x6D
                else if (fc0 === 0x53 && fc1 === 0x4E && fc2 === 0x61 && fc3 === 0x6D) {
                    const names = parseNameTable(payloadStart, secLen)
                    for (let k = 0; k < names.length; k++) sampleNames[k] = names[k]
                }
                // 'sMet' = 0x73,0x4D,0x65,0x74
                else if (fc0 === 0x73 && fc1 === 0x4D && fc2 === 0x65 && fc3 === 0x74) {
                    let q = payloadStart
                    const qEnd = payloadStart + secLen
                    while (q + 5 <= qEnd) {
                        const idx = sys.peek(ptr + q) & 0xFF
                        const subLen = _peekU32LE(ptr, q + 1)
                        const subStart = q + 5
                        if (subStart + subLen > qEnd) break
                        // payload: notation(u16) + beat_pri(u8) + beat_sec(u8) + name\0 + composer\0 + copyright\0
                        const notation = (sys.peek(ptr + subStart) & 0xFF) |
                                         ((sys.peek(ptr + subStart + 1) & 0xFF) << 8)
                        let r = subStart + 4   // skip notation(2) + pri(1) + sec(1)
                        const strs = []
                        while (strs.length < 3 && r < subStart + subLen) {
                            let s = ''
                            while (r < subStart + subLen) {
                                const b = sys.peek(ptr + r) & 0xFF; r++
                                if (b === 0) break
                                s += String.fromCharCode(b)
                            }
                            strs.push(s)
                        }
                        if (idx < numSongs) {
                            songs[idx].pitchPresetIdx = notation
                            if (strs[0] !== undefined) songs[idx].name = strs[0]
                            if (strs[1] !== undefined) songs[idx].composer = strs[1]
                            if (strs[2] !== undefined) songs[idx].copyright = strs[2]
                        }
                        q = subStart + subLen
                    }
                }

                p = payloadStart + secLen
            }
        }
    }

    sys.free(ptr)
    return { numSongs, projectName, songs, instNames, sampleNames }
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// GUI DEFINITION
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

const [SCRH, SCRW] = con.getmaxyx()
const [SCRPW, SCRPH] = graphics.getPixelDimension()
const CELL_PW = (SCRPW / SCRW) | 0       // px per character column
const CELL_PH = (SCRPH / SCRH) | 0       // px per character row
const PTNVIEW_OFFSET_X = 3
const PTNVIEW_OFFSET_Y = 5
const PTNVIEW_HEIGHT = SCRH - PTNVIEW_OFFSET_Y

const TIMELINE_COLSIZES = [15, 7, 5]
let timelineRowStyle      = 0
let COLSIZE_TIMELINE_FULL = TIMELINE_COLSIZES[0]
let VOCSIZE_TIMELINE_FULL = Math.floor((SCRW - 3) / COLSIZE_TIMELINE_FULL)

const ORDERS_CMD_X       = 5
const ORDERS_VOICE_X     = 12  // 1-indexed col where voice columns begin
const ORDERS_VOICE_COL_W = 4
const VOCSIZE_ORDERS     = Math.floor((SCRW - (ORDERS_VOICE_X - 1)) / ORDERS_VOICE_COL_W)

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
const colVoiceHdrMuted = 249
const colVoiceHdrMutedCursorUp = 180
const colSep       = 252
const colPushBtnBack = 143
const colTabBarBack = 187
const colTabBarBack2 = 136
const colTabBarOrn = 136
const colBrand = 211
const colPopupBack = 244
const colTabActive = 239
const colTabInactive = 45

// protip: avoid using colour zero
const colWHITE = 239
const colBLACK = 240

// Voice-header playback meters (volume bar grows from centre out; pan bar = centre tick + dot).
// Pixels are drawn beneath text — only the glyph foregrounds occlude the bars, so the bars sit
// on rows 0 and (cellH - 1) where the 7×14 glyph has the least foreground.
const METER_VOL_COL = colVol
const METER_PAN_COL = 214
const METER_VOL_TICK_COL = 127
const METER_PAN_TICK_COL = 198
const METER_BAR_PAD = 0        // px gap from cell edges (each side)
const METER_TRANSPARENT  = 255

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
    print(`P${PLAYHEAD+1}`)
    con.move(2,1)
    print((playbackMode == PLAYMODE_NONE) ? sym.statusstop : sym.statusplay)

    // beat indicator
    let beatCursorRow = cursorRow
    while (beatCursorRow >= beatDivSecondary) { beatCursorRow -= beatDivSecondary }
    let beatInd = (playbackMode != PLAYMODE_NONE && beatCursorRow % beatDivPrimary < (beatDivPrimary >>> 1)) ?
     ((beatCursorRow % beatDivSecondary < (beatDivPrimary >>> 1)) ? sym.blob8 : sym.blob5) :
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
                con.prnch(VERT)
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

const voiceHdrColByFlags = [colStatus, colVoiceHdr, colVoiceHdrMuted, colVoiceHdrMutedCursorUp] // default, cursorUp, muted, cursorUp+muted

function drawVoiceHeaders() {
    fillLine(PTNVIEW_OFFSET_Y - 1, colStatus, 255)
    const cue = song.cues[cueIdx]
    for (let c = 0; c < VOCSIZE_TIMELINE_FULL; c++) {
        const voice = voiceOff + c
        const x = PTNVIEW_OFFSET_X + COLSIZE_TIMELINE_FULL * c
        con.move(PTNVIEW_OFFSET_Y - 1, x)
        if (voice >= song.numVoices) {
            con.color_pair(colStatus, 255)
            print(`                     `.substring(0, COLSIZE_TIMELINE_FULL))
        } else {
            const isCursor = (voice === cursorVox)
            const isMuted  = voiceMutes[voice]
            con.color_pair(voiceHdrColByFlags[isMuted*2 + isCursor], 255)
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
    // Voice headers were just repainted with bg=255 (transparent), so any meter pixels
    // beneath them survived the redraw — but the cached per-slot state may still match,
    // which would skip the redraw on the next updatePlayback. Force a redraw by clearing
    // the cache; the next updatePlayback re-emits any active bars.
    invalidateVoiceMeters()
}

// Per-slot cache of last-drawn meter state: { voice, vol, pan } or null when slot is clear.
// Indexed by slot index 0..VOCSIZE_TIMELINE_FULL-1 (never grows beyond 20 slots in practice).
const meterPrevSlot = new Array(20).fill(null)
const meterThickness = 2

function invalidateVoiceMeters() {
    for (let i = 0; i < meterPrevSlot.length; i++) meterPrevSlot[i] = null
}

// Wipe the pixel strip used by the voice-header meters back to transparent (255).
// Called when leaving the Timeline panel or when playback stops.
function clearVoiceMeters() {
    const yPan = (PTNVIEW_OFFSET_Y - 2) * CELL_PH
    const yVol = (PTNVIEW_OFFSET_Y - 1) * CELL_PH - meterThickness
    graphics.plotRect(0, yPan, SCRPW, meterThickness, METER_TRANSPARENT)
    graphics.plotRect(0, yVol, SCRPW, meterThickness, METER_TRANSPARENT)
    invalidateVoiceMeters()
}

/**
 * Repaint the per-voice volume and pan indicators in the voice-header row.
 * Volume: horizontal bar growing from the cell centre outward, length ∝ effective tracker
 * volume (after envelopes, fadeout, vol-column/D/tremolo ramps, per-voice fader). Drawn on
 * the bottom strip of the header row.
 * Pan: horizontal bar stemming from the cell centre, signed length ∝ (pan-128)/128. Drawn
 * on the top strip of the header row.
 * Both strips get a centre tick drawn on top of the bar.
 * Only redraws slots whose (voice, volPix, panPix) tuple has changed since the last call,
 * so the work per frame stays bounded by actual movement.
 */
function drawVoiceMeters() {
    if (playbackMode === PLAYMODE_NONE || currentPanel !== VIEW_TIMELINE) return
    const yPan = (PTNVIEW_OFFSET_Y - 2) * CELL_PH                  // top edge of pan strip
    const yVol = (PTNVIEW_OFFSET_Y - 1) * CELL_PH - meterThickness // top edge of vol strip
    const slotPW = COLSIZE_TIMELINE_FULL * CELL_PW
    // Skip the leftmost cell of every slot — it's a text-mode separator whose background
    // colour paints on top of the framebuffer and would clip any meter pixels there.
    const drawW  = slotPW - CELL_PW
    const halfW  = (drawW >>> 1) - METER_BAR_PAD
    const stripW = drawW - 2 * METER_BAR_PAD + 1

    for (let c = 0; c < VOCSIZE_TIMELINE_FULL; c++) {
        const voice = voiceOff + c
        const slotX0 = (PTNVIEW_OFFSET_X + COLSIZE_TIMELINE_FULL * c) * CELL_PW
        const xCenter = slotX0 + (drawW >>> 1)
        const xStrip = slotX0 + METER_BAR_PAD
        const prev = meterPrevSlot[c]

        if (voice >= song.numVoices) {
            if (prev !== null) {
                graphics.plotRect(xStrip, yPan, stripW, meterThickness, METER_TRANSPARENT)
                graphics.plotRect(xStrip, yVol, stripW, meterThickness, METER_TRANSPARENT)
                meterPrevSlot[c] = null
            }
            continue
        }

        const volRaw = audio.getVoiceEffectiveVolume(PLAYHEAD, voice) || 0
        const panRaw = audio.getVoiceEffectivePan(PLAYHEAD, voice)
        const volPix = Math.max(0, Math.min(halfW, Math.round(volRaw * halfW)))
        // Pan range 0..255, centre 128 → map to ±halfW.
        let panPix = Math.round((panRaw - 128) / 128 * halfW)
        if (panPix < -halfW) panPix = -halfW
        else if (panPix > halfW) panPix = halfW

        if (prev !== null && prev.voice === voice && prev.vol === volPix && prev.pan === panPix) continue

        // Clear both bar strips in this slot before redrawing.
        graphics.plotRect(xStrip, yPan, stripW, meterThickness, METER_TRANSPARENT)
        graphics.plotRect(xStrip, yVol, stripW, meterThickness, METER_TRANSPARENT)
        // Volume bar (grows from centre out). Silent voices show no bar.
        if (volPix > 0) {
            graphics.plotRect(xCenter - volPix, yVol, 2 * volPix + 1, meterThickness, METER_VOL_COL)
        }
        // Pan bar (stems from centre, direction = sign of panPix). Centred pan shows no bar.
        if (panPix !== 0) {
            const px0 = (panPix > 0) ? xCenter : xCenter + panPix
            graphics.plotRect(px0, yPan, Math.abs(panPix) + 1, meterThickness, METER_PAN_COL)
        }
        // Centre ticks, drawn on top of the bars.
        graphics.plotRect(xCenter-1, yPan, 3, meterThickness, METER_PAN_TICK_COL)
        graphics.plotRect(xCenter-1, yVol, 3, meterThickness, METER_VOL_TICK_COL)

        meterPrevSlot[c] = { voice: voice, vol: volPix, pan: panPix }
    }
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
        [`pg\u008418u`,'Cue'],
    ['sep'],
        ['WER','View'],
    ['sep'],
        ['sp','Edit'],
    ['sep'],
        ['n','Solo'],
        ['m','Mute'],
    ['sep'],
        ['tab','Panel'],
    ['sep'],
        ['!','Help'],
//    ['sep'],
//        ['q','Quit'],
    ]
    let hintElemOrders = [
        [`\u008428u\u008429u`,'Nav'],
        [`ent`,'Go to cue'],
    ['sep'],
        ['sp','Edit'],
    ['sep'],
        ['tab','Panel'],
    ['sep'],
        ['!','Help'],
//    ['sep'],
//        ['q','Quit'],
    ]

    let hintElemPatterns = [
        [`\u008428u\u008429u`,'Nav'],
        [`pg\u008418u`,'Ptn'],
    ['sep'],
        ['sp','Edit'],
    ['sep'],
        ['tab','Panel'],
    ['sep'],
        ['!','Help'],
//    ['sep'],
//        ['q','Quit'],
    ]

    let hintElemEditNoteValue = [ // only enabled in viewmode 'E' or in pattern editor
        [`\u008428u\u008429u`,'Nav'],
        [`pg\u008418u`,'Cue'],
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
    ['sep'],
        ['!','Help'],
//    ['sep'],
//        ['Sp','ExitEdit'],
    ]
    let hintElemEditInstValue = [
        [`\u008428u\u008429u`,'Nav'],
        [`pg\u008418u`,'Cue'],
    ['sep'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,'Instrument'],
    ['sep'],
        ['!','Help'],
    // ['sep'],
    //     ['sp','ExitEdit'],
    ]
    let hintElemEditVolEff = [
        [`\u008428u\u008429u`,'Nav'],
        [`pg\u008418u`,'Cue'],
    ['sep'],
        ['.','Set'],
        ['v','SlideUp'],
        ['^','SlideDn'],
        ['-','FineDn'],
        ['=','FineUp'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,'Val'],
    ['sep'],
        ['!','Help'],
//    ['sep'],
//        ['Sp','ExitEdit'],
    ]
    let hintElemEditPanEff = [
        [`\u008428u\u008429u`,'Nav'],
        [`pg\u008418u`,'Cue'],
    ['sep'],
        ['.','Set'],
        ['<','SlideL'],
        ['>','SlideR'],
        ['-','FineL'],
        ['=','FineR'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,'Val'],
//    ['sep'],
//        ['Sp','ExitEdit'],
    ]
    let hintElemEditFxSym = [
        [`\u008428u\u008429u`,'Nav'],
        [`pg\u008418u`,'Cue'],
    ['sep'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,`FxSym`],
    ['sep'],
        ['!','Help'],
    // ['sep'],
    //     ['sp','ExitEdit'],
    ]
    let hintElemEditFxVal = [
        [`\u008428u\u008429u`,'Nav'],
        [`pg\u008418u`,'Cue'],
    ['sep'],
        [`0${sym.doubledot}9 A${sym.doubledot}F`,`FxVal`],
    ['sep'],
        ['!','Help'],
    // ['sep'],
    //     ['sp','ExitEdit'],
    ]

    const hintElemExternal = [['Tab','Panel'],['sep'],['!','Help']]
    const hintElemProject  = [
        [`\u008428u\u008429u`,'Nav'],
        [`ent`,'Edit/Switch'],
    ['sep'],
        ['tab','Panel'],
    ['sep'],
        ['!','Help'],
    ]
    const hintElemSamples = [
        [`\u008428u\u008429u`,'Nav'],
    ['sep'],
        ['e','Edit'],
        ['ent','View inst'],
    ['sep'],
        ['tab','Panel'],
    ['sep'],
        ['!','Help'],
    ]
    const hintElemInstruments = [
        [`\u008426u\u008427u`,'Nav'],
        [`\u008428u\u008429u`,'Tab'],
        [`1${sym.doubledot}5`,'Jump tab'],
    ['sep'],
        ['e','Edit'],
    ['sep'],
        ['tab','Panel'],
    ['sep'],
        ['!','Help'],
    ]
    let hintElems = [hintElemTimeline, hintElemOrders, hintElemPatterns, hintElemSamples, hintElemInstruments, hintElemProject, hintElemExternal]
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

        // Two-column, two-section layout.  Upper section: this row's cell fields,
        // split L (Note/Inst/Vx/Px) / R (Fx/FxOp/FxArg).  Lower section: cumulative
        // engine state, packed in column-major order across both columns.
        const colW = Math.floor(detailW / 2)
        const col1X = dx
        const col2X = dx + colW
        const labelW = 6
        const valW1  = colW - labelW - 2
        const valW2  = (detailW - colW) - labelW - 2

        const drawLine = (y, x, line, valWidth) => {
            con.move(y, x)
            con.color_pair(colStatus, 255)
            print((line.label + '      ').substring(0, labelW) + ' ')
            con.color_pair(line.fg, 255)
            const v = (line.value + ' '.repeat(valWidth + 1))
            print(v.substring(0, valWidth + 1))
        }
        const blankLine = (y, x, width) => {
            con.move(y, x)
            con.color_pair(colBackPtn, 255)
            print(' '.repeat(width))
        }

        const upperLeft = [
            { label: 'Note ', value: `${noteToStr(note)} ($${note.hex04()})`, fg: colNote },
            { label: 'Inst ', value: inst === 0 ? '---' : ('$'+inst.hex02()), fg: colInst },
            { label: 'Vx   ', value: `${volFxNames[voleffop1]} ${voleffarg1}`, fg: colVol },
            { label: 'Px   ', value: `${panFxNames[paneffop1]} ${paneffarg1}`, fg: colPan },
        ]
        const upperRight = [
            { label: 'Fx   ', value: fxName.trimEnd(),         fg: colEffOp  },
            { label: 'FxOp ', value: fx,                       fg: colEffOp  },
            { label: 'FxArg', value: `$${effarg.hex04()}`,     fg: colEffArg },
        ]
        const upperHeight = Math.max(upperLeft.length, upperRight.length)

        for (let i = 0; i < upperHeight; i++) {
            const y = PTNVIEW_OFFSET_Y + i
            if (i < upperLeft.length)  drawLine(y, col1X, upperLeft[i],  valW1)
            else                        blankLine(y, col1X, colW)
            if (i < upperRight.length) drawLine(y, col2X, upperRight[i], valW2)
            else                        blankLine(y, col2X, detailW - colW)
        }

        // Section divider
        const sepY = PTNVIEW_OFFSET_Y + upperHeight
        con.move(sepY, dx)
        con.color_pair(colSep, 255)
        print(DOTHORZ.repeat(detailW >>> 1))
        if (detailW % 2 == 1) print(DOTHORZ[0])

        // Lower section: cumulative state.
        const lowerY0 = sepY + 1
        const lowerH  = PTNVIEW_HEIGHT - upperHeight - 1
        let cumLines = []
        if (cumState !== null && lowerH > 0) {
            const _apo  = Math.abs(cumState.pitchOff)
            const _psgn = cumState.pitchOff > 0 ? '+' : cumState.pitchOff < 0 ? '-' : ' '
            const _absN = (cumState.lastNote !== 0x0000 && cumState.pitchOff !== 0)
                ? noteToStr(Math.max(0x20, Math.min(0xFFFF, cumState.lastNote + cumState.pitchOff))) + ' '
                : ''
            const _clipNm = ['clamp','fold','wrap','wrap'][cumState.clipMode]
            const _bcStr  = (cumState.bitcrushDepth === 0 && cumState.bitcrushSkip === 0)
                ? 'off'
                : `d${cumState.bitcrushDepth.toString(16).toUpperCase()}/s$${cumState.bitcrushSkip.hex02()}`
            const _odStr  = (cumState.overdriveAmp === 0) ? 'off' : `$${cumState.overdriveAmp.hex02()}`

            cumLines = [
                { label: 'L.Note', value: noteToStr(cumState.lastNote),                                          fg: colNote   },
                { label: 'L.Inst', value: cumState.lastInst === 0 ? '---' : ('$'+cumState.lastInst.hex02()),     fg: colInst   },
                { label: 'Vol   ', value: `$${cumState.volAbs.hex02()}`,                                         fg: colVol    },
                { label: 'Pan   ', value: `$${cumState.panAbs.hex02()}`,                                         fg: colPan    },
                { label: 'Pitch ', value: `${_absN}(${_psgn}$${_apo.hex04()})`,                                  fg: colNote   },
                { label: 'BPM   ', value: `${cumState.bpm}`,                                                     fg: colStatus },
                { label: 'Spd   ', value: `${cumState.speed}`,                                                   fg: colStatus },
                { label: 'GVol  ', value: `$${cumState.globalVol.hex02()}`,                                      fg: colStatus },
                { label: `E${MIDDOT}F   `, value: `$${cumState.memEF.hex04()}`,                                  fg: colEffArg },
                { label: 'G     ', value: `$${cumState.memG.hex04()}`,                                           fg: colEffArg },
                { label: `H${MIDDOT}U   `, value: `$${cumState.memHU.speed.hex02()}/$${cumState.memHU.depth.hex02()}`, fg: colEffArg },
                { label: 'R     ', value: `$${cumState.memR.speed.hex02()}/$${cumState.memR.depth.hex02()}`,     fg: colEffArg },
                { label: 'Y     ', value: `$${cumState.memY.speed.hex02()}/$${cumState.memY.depth.hex02()}`,     fg: colEffArg },
                { label: 'D     ', value: `$${cumState.memD.hex04()}`,                                           fg: colEffArg },
                { label: 'I     ', value: `$${cumState.memI.hex04()}`,                                           fg: colEffArg },
                { label: 'J     ', value: `$${cumState.memJ.hex04()}`,                                           fg: colEffArg },
                { label: 'O     ', value: `$${cumState.memO.hex04()}`,                                           fg: colEffArg },
                { label: 'Q     ', value: `$${cumState.memQ.hex04()}`,                                           fg: colEffArg },
                { label: 'Tslid ', value: `$${cumState.memTSlide.hex02()}`,                                      fg: colEffArg },
                { label: 'W     ', value: `$${cumState.memW.hex04()}`,                                           fg: colEffArg },
                { label: 'BCrsh ', value: _bcStr,                                                                fg: colEffArg },
                { label: 'OvDrv ', value: _odStr,                                                                fg: colEffArg },
                { label: 'Clip  ', value: _clipNm,                                                               fg: colEffArg },
            ]
        }

        // Column-major fill: cap per-column height to lowerH, drop overflow.
        const perCol  = Math.min(lowerH, Math.ceil(cumLines.length / 2))
        const totShow = Math.min(cumLines.length, perCol * 2)
        for (let i = 0; i < perCol; i++) {
            const yL = lowerY0 + i
            const idxL = i
            const idxR = perCol + i
            if (idxL < totShow) drawLine(yL, col1X, cumLines[idxL], valW1)
            else                blankLine(yL, col1X, colW)
            if (idxR < totShow) drawLine(yL, col2X, cumLines[idxR], valW2)
            else                blankLine(yL, col2X, detailW - colW)
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
    // Slot widths and per-slot voice mapping are about to change; wipe meter pixels so the
    // narrower/wider layout doesn't leave stale bar fragments from the old slot widths.
    clearVoiceMeters()
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

const logofile = files.open("A:"+_TVDOS.variables.DOSDIR+"/bin/tauthdr.r8")
const logoBytes = logofile.bread(); logofile.close()
const logoTexture = new gl.Texture(92, 14, logoBytes)
const buttonfile = files.open("A:"+_TVDOS.variables.DOSDIR+"/bin/tautbtn.r8")
const buttonBytes = buttonfile.bread(); buttonfile.close()
const buttonTexture = new gl.Texture(2, 28, buttonBytes)
//const buttonNullfile = files.open("A:"+_TVDOS.variables.DOSDIR+"/bin/tautbtn0.r8")
//const buttonNullBytes = buttonNullfile.bread(); buttonNullfile.close()
//const buttonNullTexture = new gl.Texture(35, 28, buttonNullBytes)

font.setLowRom("A:"+_TVDOS.variables.DOSDIR+"/bin/tautfont_low.chr")
font.setHighRom("A:"+_TVDOS.variables.DOSDIR+"/bin/tautfont_high.chr")
const songsMeta = loadTaudSongList(fullPathObj.full)
let currentSongIndex = 0
// Unified cursor: 0..PROJ_META_ROWS_COUNT-1 = editable meta rows (Flags / GVol / MVol);
//                 >= PROJ_META_ROWS_COUNT   = song list, songIdx = projectCursor - PROJ_META_ROWS_COUNT
let projectCursor = 0
const PROJ_META_ROWS_COUNT = 3
const PROJ_META_FLAGS = 0
const PROJ_META_GVOL  = 1
const PROJ_META_MVOL  = 2
let song = loadTaud(fullPathObj.full, currentSongIndex)

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

// Switch the active song within the currently-open multi-song .taud file.
// Re-uploads patterns+cues (and the shared sample/inst bin) to the audio
// adapter, reloads song metadata, and resets per-song UI / playback state.
function switchSong(newIndex) {
    if (newIndex < 0 || newIndex >= songsMeta.numSongs) return
    if (newIndex === currentSongIndex) return

    stopPlayback()
    resetAudioDevice()

    currentSongIndex = newIndex
    song = loadTaud(fullPathObj.full, newIndex)
    refreshSamplesCache()

    const newPitchIdx = songsMeta.songs[newIndex].pitchPresetIdx
    PITCH_PRESET_IDX = (newPitchIdx != null && pitchTablePresets[newPitchIdx])
        ? newPitchIdx
        : PITCH_PRESET_IDX_DEFAULT
    rebuildPitchLut()

    taud.uploadTaudFile(fullPathObj.full, newIndex, PLAYHEAD)
    patternsOutOfSync = false
    audio.setMasterVolume(PLAYHEAD, 255)
    audio.setMasterPan(PLAYHEAD, 128)
    initialTrackerMixerflags = audio.getTrackerMixerFlags(PLAYHEAD)
    initialGlobalVolume      = audio.getSongGlobalVolume(PLAYHEAD)
    initialMixingVolume      = audio.getSongMixingVolume(PLAYHEAD)

    // Reset per-song UI state
    cueIdx = 0; cursorRow = 0; scrollRow = 0; voiceOff = 0; cursorVox = 0
    timelineColCursor = 0
    ordersCursor = 0; ordersScroll = 0; ordersColCursor = 0; ordersVoiceOff = 0
    patternIdx = 0; patternListScroll = 0
    patternGridRow = 0; patternGridScroll = 0; patternGridCol = 0
    simState = null; simStateKey = ''

    for (let i = 0; i < NUM_VOICES; i++) {
        voiceMutes[i] = false
        audio.setVoiceMute(PLAYHEAD, i, false)
    }
    timelineMuteSnapshot = null

    pbCue = 0; pbRow = 0
    previewActive = false

    clampCursor(); clampVoice(); clampCue(); clampOrdersHoriz(); clampPatternIdx(); clampPatternGrid()
    drawAll()
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
    print('Comand ')
    for (let c = 0; c < VOCSIZE_ORDERS; c++) {
        const v = ordersVoiceOff + c
        con.color_pair(colVoiceHdr, ordersColCursor === v + 1 ? colHighlight : 255)
        print(v < song.numVoices ? `V${(v+1).dec02()} ` : '    ')
    }
}

function drawOrdersRowAt(ci) {
    const vr = ci - ordersScroll
    if (vr < 0 || vr >= PTNVIEW_HEIGHT) return
    const y     = PTNVIEW_OFFSET_Y + vr
    const maxCue = song.lastActiveCue < 0 ? 0 : song.lastActiveCue
    const isSel = (ci === ordersCursor)
    const isCur = playbackMode !== PLAYMODE_NONE && ci === cueIdx
    const back  = isSel ? (playbackMode !== PLAYMODE_NONE ? colPlayback : colHighlight)
                        : (isCur ? colPlayback : colBackPtn)

    con.move(y, 1)
    if (ci > maxCue) {
        con.color_pair(colBackPtn, colBackPtn)
        print(' '.repeat(SCRW - 1))
        return
    }

    const cue = song.cues[ci]
    con.color_pair(ci % 4 === 0 ? colRowNumEmph1 : colRowNum, back)
    print(ci.hex03())
    con.color_pair(colBackPtn, back)
    print(' ')
    // CMD column — crosshair highlight at (ordersCursor, col 0)
    const cmdBack = (isSel && ordersColCursor === 0) ? colPlayback : back
    con.color_pair(cue.instr ? colStatus : colSep, cmdBack)
    print(cue.instr ? cueInstToStr(cue.instr) : '------')
    con.color_pair(colBackPtn, back)
    print(' ')
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
    const endX = ORDERS_VOICE_X + VOCSIZE_ORDERS * ORDERS_VOICE_COL_W
    if (endX <= SCRW) { con.color_pair(colBackPtn, back); print(' '.repeat(SCRW - endX)) }
}

function drawOrdersContents(wo) {
    drawOrdersHeader()
    for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) drawOrdersRowAt(ordersScroll + vr)
}

// Redraw all rows of one voice column slot (0..VOCSIZE_ORDERS-1).
function drawOrdersVoiceColumnAt(slot) {
    const v = ordersVoiceOff + slot
    const x = ORDERS_VOICE_X + slot * ORDERS_VOICE_COL_W
    const maxCue = song.lastActiveCue < 0 ? 0 : song.lastActiveCue

    for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) {
        const ci = ordersScroll + vr
        const y  = PTNVIEW_OFFSET_Y + vr

        if (ci > maxCue) {
            con.move(y, x)
            con.color_pair(colBackPtn, colBackPtn)
            print('    ')
            continue
        }
        const isSel = (ci === ordersCursor)
        const isCur = playbackMode !== PLAYMODE_NONE && ci === cueIdx
        const back  = isSel ? (playbackMode !== PLAYMODE_NONE ? colPlayback : colHighlight)
                            : (isCur ? colPlayback : colBackPtn)
        const cue   = song.cues[ci]
        const ptn   = v < song.numVoices ? cue.ptns[v] : CUE_EMPTY
        const vBack = (isSel && ordersColCursor === v + 1) ? colPlayback : back

        con.move(y, x)
        con.color_pair(ptn === CUE_EMPTY ? colSep : colStatus, vBack)
        print(ptn === CUE_EMPTY ? '---' : ptn.hex03())
        con.color_pair(colBackPtn, back)
        print(' ')
    }
}

// Memory-shift the voice-column area horizontally by `dVoice` voice columns.
// Positive = scroll left (new column exposed on right); negative = scroll right.
// Touches body rows only; the header and Cmd column are untouched.
function shiftOrdersAreaHorizontal(dVoice) {
    if (dVoice === 0) return
    const absD = (dVoice < 0) ? -dVoice : dVoice
    if (absD >= VOCSIZE_ORDERS) return  // nothing to salvage

    const stripWidth = (VOCSIZE_ORDERS - absD) * ORDERS_VOICE_COL_W
    const srcX = ORDERS_VOICE_X + (dVoice > 0 ? absD * ORDERS_VOICE_COL_W : 0)
    const dstX = ORDERS_VOICE_X + (dVoice > 0 ? 0 : absD * ORDERS_VOICE_COL_W)
    const srcOff = srcX - 1
    const dstOff = dstX - 1

    for (let p = 0; p < 3; p++) {
        const chanOff = TEXT_PLANES[p]
        for (let vr = 0; vr < PTNVIEW_HEIGHT; vr++) {
            const rowBase = GPU_MEM - chanOff - (PTNVIEW_OFFSET_Y + vr - 1) * SCRW
            sys.memcpy(rowBase - srcOff, SCRATCH_PTR, stripWidth)
            sys.memcpy(SCRATCH_PTR, rowBase - dstOff, stripWidth)
        }
    }
}

function cueInstToStr(inst) {
    let foreword = (inst >>> 12) & 15
    let preamble = (inst >>> 8) & 15
    let arg12 = inst & 0xFFF
    let arg8 = inst & 0xFF
    let fallback = `?${inst.hex04()}?`
    switch (foreword) {
        case 0b1000:
            return "BAK" + arg12.hex03()
        case 0b1001:
            return "FWD" + arg12.hex03()
        case 0b1111:
            return "JMP" + arg12.hex03()
        case 0b0000:
            switch (preamble) {
                case 0b0010:
                    return "LEN " + arg8.dec02()
                case 0b0001:
                    return arg8 ? ("FADE" + arg8.dec02()) : "HALT  "
                case 0b0000:
                    return "NO-OP "
                default:
                    return fallback
            }
        default:
            return fallback
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

    if (keyJustHit && (keysym === '[' || keysym === ']')) { nudgeTickRate(keysym === '[' ? -1 : 1); return }

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
        else if (keyJustHit && !shiftDown && event.includes(keys.N)) { toggleSolo(cursorVox) }
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
    if (keyJustHit && !shiftDown && event.includes(keys.N)) { toggleSolo(cursorVox); return }

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

    if (keysym === '<UP>' || keysym === '<DOWN>' || keysym === '<PAGE_UP>' || keysym === '<PAGE_DOWN>') {
        const oldCursor = ordersCursor
        const oldScroll = ordersScroll

        if (keysym === '<UP>') {
            ordersCursor = Math.max(0, ordersCursor - moveDelta)
        } else if (keysym === '<DOWN>') {
            ordersCursor = Math.min(maxCue, ordersCursor + moveDelta)
        } else if (keysym === '<PAGE_UP>') {
            ordersCursor = Math.max(0, ordersCursor - PTNVIEW_HEIGHT)
        } else if (keysym === '<PAGE_DOWN>') {
            ordersCursor = Math.min(maxCue, ordersCursor + PTNVIEW_HEIGHT)
        }
        scrollOrdersTo(ordersCursor)

        if (ordersCursor === oldCursor && ordersScroll === oldScroll) return
        const dScroll = ordersScroll - oldScroll
        if (dScroll === 0) {
            drawOrdersRowAt(oldCursor)
            drawOrdersRowAt(ordersCursor)
        } else if (Math.abs(dScroll) >= PTNVIEW_HEIGHT) {
            drawOrdersContents(wo)
        } else {
            shiftPatternArea(-dScroll)
            if (dScroll > 0) for (let i = 0; i < dScroll;  i++) drawOrdersRowAt(ordersScroll + PTNVIEW_HEIGHT - 1 - i)
            else             for (let i = 0; i < -dScroll; i++) drawOrdersRowAt(ordersScroll + i)
            if (oldCursor >= ordersScroll && oldCursor < ordersScroll + PTNVIEW_HEIGHT) drawOrdersRowAt(oldCursor)
            drawOrdersRowAt(ordersCursor)
        }
    } else if (keysym === '<LEFT>' || keysym === '<RIGHT>') {
        const oldVoiceOff  = ordersVoiceOff
        const oldColCursor = ordersColCursor
        ordersColCursor += (keysym === '<LEFT>') ? -1 : 1
        clampOrdersHoriz()
        if (ordersColCursor === oldColCursor) return  // hit edge

        const dVoice = ordersVoiceOff - oldVoiceOff
        if (dVoice !== 0) {
            shiftOrdersAreaHorizontal(dVoice)
            if (dVoice > 0) for (let i = 0; i < dVoice;  i++) drawOrdersVoiceColumnAt(VOCSIZE_ORDERS - 1 - i)
            else            for (let i = 0; i < -dVoice; i++) drawOrdersVoiceColumnAt(i)
        }
        drawOrdersHeader()
        drawOrdersRowAt(ordersCursor)
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

// Returns the visual width of a TSVM string (handles \u0084Nnu escape sequences)
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

// Centre-anchored scroll: keep `sel` at the middle row of a `vis`-row viewport,
// clamped at the list's top and bottom. Returns the new scroll offset.
function centerScroll(sel, scroll, vis, total) {
    if (sel < scroll) scroll = sel
    if (sel < scroll + (vis >>> 1) && scroll > 0) scroll = sel - (vis >>> 1)
    if (sel >= scroll + ((vis + 1) >>> 1)) scroll = sel - ((vis + 1) >>> 1) + 1
    if (scroll < 0) scroll = 0
    if (scroll + vis > total) scroll = Math.max(0, total - vis)
    return scroll
}

function clampPatternIdx() {
    if (song.numPats === 0) { patternIdx = 0; patternListScroll = 0; return }
    if (patternIdx < 0) patternIdx = 0
    if (patternIdx >= song.numPats) patternIdx = song.numPats - 1
    patternListScroll = centerScroll(patternIdx, patternListScroll, PTNVIEW_HEIGHT, song.numPats)
}

function scrollPatternGridTo(row) {
    patternGridScroll = centerScroll(row, patternGridScroll, PTNVIEW_HEIGHT, ROWS_PER_PAT)
}

function scrollOrdersTo(ci) {
    const maxCue = song.lastActiveCue < 0 ? 0 : song.lastActiveCue
    ordersScroll = centerScroll(ci, ordersScroll, PTNVIEW_HEIGHT, maxCue + 1)
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

// Walk pattern rows 0..uptoRow and accumulate engine-visible cohort state.
// Mirrors AudioAdapter.kt applyTrackerRow / applyEffectRow / applySEffect for the
// state surfaced in the voice-detail panel.  Out of scope: B/C control flow,
// SEx pattern delay, SBx pattern loop, NNA / past-note actions, envelope toggles.
function simulateRowState(ptnDat, uptoRow) {
    const OP_1 = 1,  OP_8 = 8,  OP_9 = 9,  OP_A = 10
    const OP_D = 13, OP_E = 14, OP_F = 15, OP_G = 16
    const OP_H = 17, OP_I = 18, OP_J = 19, OP_O = 24
    const OP_Q = 26, OP_R = 27, OP_S = 28, OP_T = 29
    const OP_U = 30, OP_V = 31, OP_W = 32, OP_Y = 34

    // ST3-style finetune offsets, mirrors AudioAdapter.kt FINETUNE_OFFSET
    const FINETUNE_OFFSET = [
        -0x0154, -0x0132, -0x0111, -0x00E4, -0x00B8, -0x008B, -0x005D, -0x003B,
         0x0000,  0x0023,  0x0046,  0x0074,  0x0098,  0x00C8,  0x00F9,  0x0110
    ]

    let lastNote = 0x0000, lastInst = 0
    let volAbs   = 0x3F                  // 6-bit per-note volume (engine: noteVolume axis;
                                         // M / N's per-channel axis is not modelled here)
    let panAbs   = 0x80                  // 8-bit channel pan (engine width); centre = $80
    let pitchOff = 0, portaTarget = -1
    let bpm   = audio.getBPM(PLAYHEAD)   // best-effort starting tempo
    let speed = audio.getTickRate(PLAYHEAD)
    let globalVol = 0xFF
    let toneMode = 0   // 0=linear, 1=Amiga, 2=linear-freq, 3=reserved

    let memEF = 0, memG = 0
    let memHU = { speed: 0, depth: 0 }
    let memR  = { speed: 0, depth: 0 }
    let memY  = { speed: 0, depth: 0 }
    let memD = 0, memI = 0, memJ = 0, memO = 0, memQ = 0, memTSlide = 0, memW = 0

    // Bitcrusher / overdrive (clipMode shared between OP_8 and OP_9)
    let bitcrushDepth = 0, bitcrushSkip = 0
    let overdriveAmp  = 0
    let clipMode      = 0

    // S-effect state
    let glissandoOn = false
    let vibratoWave = 0, tremoloWave = 0, panbrelloWave = 0

    const clampV = v => Math.max(0, Math.min(0x3F, v | 0))
    const clampP = v => Math.max(0, Math.min(0xFF, v | 0))
    const clampG = v => Math.max(0, Math.min(0xFF, v | 0))

    const limit = Math.min(uptoRow, ROWS_PER_PAT - 1)
    for (let row = 0; row <= limit; row++) {
        const off    = 8 * row
        const note   = ptnDat[off]   | (ptnDat[off+1] << 8)
        const inst   = ptnDat[off+2]
        const voleff = ptnDat[off+3]
        const paneff = ptnDat[off+4]
        const effop  = ptnDat[off+5]
        const effarg = ptnDat[off+6] | (ptnDat[off+7] << 8)

        // Note column
        const isGRow = (effop === OP_G)
        const isNoteDelay = (effop === OP_S) && (((effarg >>> 12) & 0xF) === 0xD)
        // Track whether this row reloads the per-note default volume.  Engine:
        // triggerNote() (and the tone-porta-with-inst branch in advanceRow)
        // seed noteVolume from the instrument's Default Note Volume (byte 196)
        // — only when the row carries an instrument byte; a note-only retrigger
        // (inst === 0) inherits the channel's existing note volume. Tone-porta
        // rows follow the same rule (matches schism csf_instrument_change
        // inst_column branch, effects.c:1302). The per-channel axis
        // (channelVolume, set by Mxx / Nxx) is NOT reset on re-trigger and is
        // not tracked by this simulator. The simulator approximates the seed
        // as 0x3F (legacy fallback) — see the longer note below.
        let reloadDefaultVol = false
        if (note !== 0x0000 && note !== 0x0002 && !(note >= 0x0010 && note <= 0x001F)) {
            if (note === 0x0001) {
                // key-off; sample stays referenced
            } else if (isGRow) {
                portaTarget = note
                if (inst !== 0) reloadDefaultVol = true
            } else if (isNoteDelay) {
                // Delayed trigger: latched but doesn't fire on this row's first tick.
                // For "state at end of row" treat as if it triggered.
                lastNote = note
                pitchOff = 0
                portaTarget = -1
                if (inst !== 0) reloadDefaultVol = true
            } else {
                lastNote = note
                pitchOff = 0
                portaTarget = -1
                if (inst !== 0) reloadDefaultVol = true
            }
        }
        if (inst !== 0) lastInst = inst
        // Default vol reset must happen before the volume column so a SET selector
        // can still override on the same row (engine order: triggerNote → applyVolColumn).
        // Pan: simulator does not track per-instrument default pan, so it never resets
        // panAbs on trigger — this naturally matches the "stay at old value when inst === 0"
        // half of the policy. The engine-side default-pan reload (gated on inst !== 0)
        // is invisible here. Same limitation now applies to default volume: the engine
        // seeds noteVolume from the instrument's byte-196 "Default Note Volume" since
        // 2026-05-09 (terranmon §171, §196), but the simulator has no instrument-byte
        // access, so it falls back to 0x3F — equivalent to the legacy "DNV unset"
        // path. Tracker UI displays may therefore show a slightly off note volume on
        // fresh triggers when the instrument carries a reduced DNV.
        if (reloadDefaultVol) volAbs = 0x3F

        // Pre-scan effect column for S$80xx (8-bit pan SET wins over volcol/pancol SET).
        const rowHasS80 = (effop === OP_S) && (((effarg >>> 12) & 0xF) === 0x8)

        // Volume column.  voleff = (sel<<6) | value6.  $C0 = sel 3 / value 0 = empty nop.
        const volSel = (voleff >>> 6) & 3
        const volVal = voleff & 63
        if (voleff !== 0xC0) {
            if (volSel === 0) {
                volAbs = volVal
            } else if (volSel === 1) {
                volAbs = clampV(volAbs + volVal * (speed - 1))     // engine: per non-first tick
            } else if (volSel === 2) {
                volAbs = clampV(volAbs - volVal * (speed - 1))
            } else if (volSel === 3 && volVal !== 0) {
                const mag = volVal & 0x1F
                if ((volVal & 0x20) !== 0) volAbs = clampV(volAbs + mag)   // fine up
                else                       volAbs = clampV(volAbs - mag)   // fine down
            }
        }

        // Pan column.  Same encoding as volume.  Engine pan is 8-bit; SET expands 6→8 by replicating bits.
        const panSel = (paneff >>> 6) & 3
        const panVal = paneff & 63
        if (paneff !== 0xC0) {
            if (panSel === 0) {
                if (!rowHasS80) panAbs = ((panVal << 2) | (panVal >>> 4)) & 0xFF
            } else if (panSel === 1) {
                panAbs = clampP(panAbs + panVal * (speed - 1))
            } else if (panSel === 2) {
                panAbs = clampP(panAbs - panVal * (speed - 1))
            } else if (panSel === 3 && panVal !== 0) {
                const mag = panVal & 0x1F
                if ((panVal & 0x20) !== 0) panAbs = clampP(panAbs + mag)
                else                       panAbs = clampP(panAbs - mag)
            }
        }

        if (effop !== 0 || effarg !== 0) {
            if (effop === OP_1) {
                const flags = (effarg >>> 8) & 0xFF
                toneMode = flags & 3
            }
            else if (effop === OP_8) {
                const x = (effarg >>> 12) & 0xF
                const y = (effarg >>>  8) & 0xF
                const z =  effarg         & 0xFF
                clipMode = x & 3
                if (effarg === 0) { bitcrushDepth = 0; bitcrushSkip = 0 }
                else if (y !== 0 || z !== 0) { bitcrushDepth = y; bitcrushSkip = z }
            }
            else if (effop === OP_9) {
                const x = (effarg >>> 12) & 0xF
                const z =  effarg         & 0xFF
                clipMode = x & 3
                if (effarg === 0) overdriveAmp = 0
                else if (z !== 0) overdriveAmp = z
            }
            else if (effop === OP_A) {
                if ((effarg >>> 8) !== 0) speed = (effarg >>> 8)
            }
            else if (effop === OP_D) {
                const raw = (effarg !== 0) ? (memD = effarg) : memD
                if (raw !== 0) {
                    const hb    = (raw >>> 8) & 0xFF
                    const hiNib = (hb >>> 4) & 0xF
                    const loNib = hb & 0xF
                    if (hb === 0xFF || hb === 0xF0) {
                        volAbs = clampV(volAbs + 0xF)               // $FF00 / $F000 quirk
                    } else if (hiNib === 0xF && loNib !== 0) {
                        volAbs = clampV(volAbs - loNib)              // $Fy00 fine down
                    } else if (loNib === 0xF && hiNib !== 0) {
                        volAbs = clampV(volAbs + hiNib)              // $xF00 fine up
                    } else if (hiNib === 0 && loNib !== 0) {
                        volAbs = clampV(volAbs - loNib * (speed - 1))   // $0y00 coarse down
                    } else if (hiNib !== 0 && loNib === 0) {
                        volAbs = clampV(volAbs + hiNib * (speed - 1))   // $x000 coarse up
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
                if (portaTarget !== -1 && memG !== 0 && lastNote !== 0x0000) {
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
                if (spd !== 0) memHU.speed = spd
                if (dep !== 0) memHU.depth = dep
            }
            else if (effop === OP_R) {
                const spd = (effarg >>> 8) & 0xFF; const dep = effarg & 0xFF
                if (spd !== 0) memR.speed = spd
                if (dep !== 0) memR.depth = dep
            }
            else if (effop === OP_Y) {
                const spd = (effarg >>> 8) & 0xFF; const dep = effarg & 0xFF
                if (spd !== 0) memY.speed = spd
                if (dep !== 0) memY.depth = dep
            }
            else if (effop === OP_I) { if (effarg !== 0) memI = effarg }
            else if (effop === OP_J) { if (effarg !== 0) memJ = effarg }
            else if (effop === OP_O) { if (effarg !== 0) memO = effarg }
            else if (effop === OP_Q) { if (effarg !== 0) memQ = effarg }
            else if (effop === OP_S) {
                const sub = (effarg >>> 12) & 0xF
                const x   = (effarg >>>  8) & 0xF
                if (sub === 0x1) {
                    glissandoOn = (x !== 0)
                } else if (sub === 0x2) {
                    pitchOff += FINETUNE_OFFSET[x]
                } else if (sub === 0x3) {
                    vibratoWave = x & 3
                } else if (sub === 0x4) {
                    tremoloWave = x & 3
                } else if (sub === 0x5) {
                    panbrelloWave = x & 3
                } else if (sub === 0x8) {
                    panAbs = effarg & 0xFF       // S$80xx full 8-bit pan SET
                }
                // 0x6/0x7/0xB/0xC/0xD/0xE/0xF — out of scope (control flow / per-tick / NNA).
            }
            else if (effop === OP_T) {
                const hi = (effarg >>> 8) & 0xFF
                if (hi !== 0) {
                    bpm = Math.max(25, Math.min(280, hi + 0x19))
                } else {
                    const low = effarg & 0xFF
                    if ((low & 0xF0) === 0x00 || (low & 0xF0) === 0x10) memTSlide = low
                    // bpm slide accumulates per-tick in the engine; not modelled at row granularity
                }
            }
            else if (effop === OP_V) {
                globalVol = (effarg >>> 8) & 0xFF
            }
            else if (effop === OP_W) {
                const raw = (effarg !== 0) ? (memW = effarg) : memW
                if (raw !== 0) {
                    const hb    = (raw >>> 8) & 0xFF
                    const hiNib = (hb >>> 4) & 0xF
                    const loNib = hb & 0xF
                    if (hb === 0xFF || hb === 0xF0) {
                        globalVol = clampG(globalVol + 0xF)
                    } else if (hiNib === 0xF && loNib !== 0) {
                        globalVol = clampG(globalVol - loNib)
                    } else if (loNib === 0xF && hiNib !== 0) {
                        globalVol = clampG(globalVol + hiNib)
                    } else if (hiNib === 0 && loNib !== 0) {
                        globalVol = clampG(globalVol - loNib * (speed - 1))
                    } else if (hiNib !== 0 && loNib === 0) {
                        globalVol = clampG(globalVol + hiNib * (speed - 1))
                    }
                }
            }
        }
    }

    return { lastNote, lastInst, volAbs, panAbs, pitchOff,
             bpm, speed, globalVol,
             toneMode,
             bitcrushDepth, bitcrushSkip, overdriveAmp, clipMode,
             glissandoOn, vibratoWave, tremoloWave, panbrelloWave,
             memEF, memG, memHU, memR, memY,
             memD, memI, memJ, memO, memQ, memTSlide, memW }
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
        con.move(y, PATEDITOR_SEP1_X); con.prnch(VERT)
        con.move(y, PATEDITOR_SEP2_X); con.prnch(VERT)
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

    if (keyJustHit && (keysym === '[' || keysym === ']')) { nudgeTickRate(keysym === '[' ? -1 : 1); return }

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
            con.move(y, PATEDITOR_SEP1_X); con.prnch(VERT)
            con.move(y, PATEDITOR_SEP2_X); con.prnch(VERT)
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
        con.move(patternGridRow - patternGridScroll + PTNVIEW_OFFSET_Y, PATEDITOR_SEP1_X); con.prnch(VERT)
        con.move(patternGridRow - patternGridScroll + PTNVIEW_OFFSET_Y, PATEDITOR_SEP2_X); con.prnch(VERT)
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
// On exit, the sub-program sets _G.TAUT.UI.NEXTPANEL to request a tab switch.
function makeExternalPanelDraw(progName) {
    return function(wo) {
        // stop any playback first
        stopPlayback()
        // update the top bar
        drawAlwaysOnElems()

        _G.TAUT.UI.NEXTPANEL = undefined
        _G.shell.execute(`${progName} ${fullPathObj.full} ${currentPanel}`)
    }
}

// Row offsets (within the meta block at the top of the Project panel) of the editable rows.
const PROJ_META_ROW_FLAGS = 5
const PROJ_META_ROW_GVOL  = 6
const PROJ_META_ROW_MVOL  = 7
const PROJ_META_VALUE_X   = 12

function drawProjectContents(wo) {
    fillLine(PTNVIEW_OFFSET_Y - 1, colVoiceHdr, 255)
    for (let y = PTNVIEW_OFFSET_Y; y < SCRH; y++) fillLine(y, colBackPtn, 255)

    let mixerflag = initialTrackerMixerflags
    let toneModeStr = ['Linear pitch','Amiga pitch','Linear freq',''][mixerflag & 3]
    let intpModeStr = ['Default','None','A500','A1200','SNES','DPCM','',''][(mixerflag >>> 2) & 7]
    let flagStrSelected = [toneModeStr, intpModeStr]


    let projMeta = {
        Filename: fullPathObj.string.split('\\').last(),
        ProjName: songsMeta.projectName || '(unnamed)',
        Patterns: `${song.numPats}/4095 ($${song.numPats.hex03()})`,
        Cues: `${song.lastActiveCue}/1024 ($${song.lastActiveCue.hex03()})`,
        Notation: pitchTablePresets[PITCH_PRESET_IDX].name,
        Flags: `${flagStrSelected.join(', ')} ($${mixerflag.hex02()})`,
        GlobalVol: `$${initialGlobalVolume.hex02()}`,
        MixingVol: `$${initialMixingVolume.hex02()}`
    }

    const editableMap = {
        [PROJ_META_ROW_FLAGS]: PROJ_META_FLAGS,
        [PROJ_META_ROW_GVOL] : PROJ_META_GVOL,
        [PROJ_META_ROW_MVOL] : PROJ_META_MVOL,
    }

    Object.entries(projMeta).forEach(([key, value], index) => {
        con.move(PTNVIEW_OFFSET_Y + index, 2)
        con.color_pair(colStatus, 255); print(key)
        con.move(PTNVIEW_OFFSET_Y + index, PROJ_META_VALUE_X)
        const isEditable = (index in editableMap)
        const isSelected = isEditable && projectCursor === editableMap[index]
        if (isSelected) {
            con.color_pair(colWHITE, colHighlight); print(' ' + value + ' ')
        } else if (isEditable) {
            con.color_pair(colVoiceHdr, colBackPtn); print(' ' + value + ' ')
        } else {
            con.color_pair(colVoiceHdr, colBLACK); print(value)
        }
    })

    drawProjectSongList()

    con.color_pair(colStatus, 255) // reset colour
}

const PROJ_SONGLIST_Y = PTNVIEW_OFFSET_Y + 9   // header row of the song list
const PROJ_SONGLIST_X = 2

function projectSongListRowsVisible() {
    return Math.max(0, SCRH - PROJ_SONGLIST_Y - 1)
}

let projectSongScroll = 0

function clampProjectCursor() {
    const n = songsMeta.numSongs
    const maxCur = PROJ_META_ROWS_COUNT + Math.max(0, n - 1)
    if (projectCursor < 0) projectCursor = 0
    if (projectCursor > maxCur) projectCursor = maxCur
    const rowsVis = projectSongListRowsVisible()
    if (projectCursor >= PROJ_META_ROWS_COUNT) {
        const songIdx = projectCursor - PROJ_META_ROWS_COUNT
        if (songIdx < projectSongScroll) projectSongScroll = songIdx
        else if (songIdx >= projectSongScroll + rowsVis)
            projectSongScroll = songIdx - rowsVis + 1
    }
    if (projectSongScroll < 0) projectSongScroll = 0
}

function drawProjectSongList() {
    const headerY = PROJ_SONGLIST_Y
    con.move(headerY, PROJ_SONGLIST_X)
    con.color_pair(colStatus, 255)
    print(`Songs: ${songsMeta.numSongs}`)

    const rowsVis = projectSongListRowsVisible()
    const colW    = SCRW - PROJ_SONGLIST_X - 1
    for (let row = 0; row < rowsVis; row++) {
        const idx = projectSongScroll + row
        const y   = headerY + 1 + row
        con.move(y, PROJ_SONGLIST_X)
        if (idx >= songsMeta.numSongs) {
            con.color_pair(colStatus, colBackPtn)
            print(' '.repeat(colW))
            continue
        }
        const s        = songsMeta.songs[idx]
        const isActive = (idx === currentSongIndex)
        const isSel    = (projectCursor >= PROJ_META_ROWS_COUNT) &&
                         (idx === projectCursor - PROJ_META_ROWS_COUNT)
        const back     = isSel ? colHighlight : colBackPtn

        const marker  = isActive ? sym.playhead : ' '
        const numStr  = (idx + 1).toString().padStart(2, '0')
        const nameRaw = s.name || `(song ${idx + 1})`
        const META_W = 28
        const nameW   = Math.max(4, colW - 6 - META_W)
        const nameStr = nameRaw.length > nameW ? nameRaw.substring(0, nameW) : nameRaw.padEnd(nameW)
        const meta    = `V${s.numVoices.dec02()} P${s.numPats.toString().padStart(3,'0')}` +
                        ` BPM${s.bpm.toString().padStart(3,'0')} tk${s.tickRate.dec02()}` +
                        ` g${s.songGlobalVolume.hex02()}`

        con.color_pair(isActive ? colWHITE : colVoiceHdr, back)
        print(`${marker} ${numStr} ${nameStr} ${meta}`)
    }

    // scroll indicator on the right edge
    if (songsMeta.numSongs > rowsVis) {
        const maxScroll = songsMeta.numSongs - rowsVis
        const indPos    = (maxScroll === 0) ? 0 : ((projectSongScroll * (rowsVis - 1) / maxScroll) | 0)
        for (let r = 0; r < rowsVis; r++) {
            con.move(headerY + 1 + r, SCRW)
            con.color_pair(colStatus, colBackPtn)
            print(r === indPos ? sym.ticked : sym.unticked)
        }
    }
}

function projectInput(wo, event) {
    if (event[0] !== 'key_down') return
    const keysym     = event[1]
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 4 : 1

    if (playbackMode !== PLAYMODE_NONE) {
        if (keysym === ' ' || (keyJustHit && shiftDown && (event.includes(keys.Y) || event.includes(keys.O)))) {
            stopPlayback(); drawAlwaysOnElems()
        }
        return
    }

    // if (!keyJustHit) return

    if (keysym === '<UP>') {
        projectCursor -= moveDelta; clampProjectCursor(); redrawPanel(); return
    }
    if (keysym === '<DOWN>') {
        projectCursor += moveDelta; clampProjectCursor(); redrawPanel(); return
    }
    if (keysym === '<PAGE_UP>') {
        projectCursor -= projectSongListRowsVisible(); clampProjectCursor(); redrawPanel(); return
    }
    if (keysym === '<PAGE_DOWN>') {
        projectCursor += projectSongListRowsVisible(); clampProjectCursor(); redrawPanel(); return
    }
    if (keysym === '<HOME>') {
        projectCursor = 0; clampProjectCursor(); redrawPanel(); return
    }
    if (keysym === '<END>') {
        projectCursor = PROJ_META_ROWS_COUNT + Math.max(0, songsMeta.numSongs - 1)
        clampProjectCursor(); redrawPanel(); return
    }
    if (keysym === '\n') {
        if (projectCursor === PROJ_META_FLAGS) {
            openFlagsPopup()
        } else if (projectCursor === PROJ_META_GVOL) {
            const v = openInlineHexEdit(PTNVIEW_OFFSET_Y + PROJ_META_ROW_GVOL, PROJ_META_VALUE_X, 2, initialGlobalVolume)
            if (v !== null) {
                initialGlobalVolume = v & 0xFF
                audio.setSongGlobalVolume(PLAYHEAD, initialGlobalVolume)
                hasUnsavedChanges = true
            }
            redrawPanel()
        } else if (projectCursor === PROJ_META_MVOL) {
            const v = openInlineHexEdit(PTNVIEW_OFFSET_Y + PROJ_META_ROW_MVOL, PROJ_META_VALUE_X, 2, initialMixingVolume)
            if (v !== null) {
                initialMixingVolume = v & 0xFF
                audio.setSongMixingVolume(PLAYHEAD, initialMixingVolume)
                hasUnsavedChanges = true
            }
            redrawPanel()
        } else {
            const songIdx = projectCursor - PROJ_META_ROWS_COUNT
            if (songIdx !== currentSongIndex) switchSong(songIdx)
        }
        return
    }
    if (keysym === ' ') {
        stopPlayback(); drawAlwaysOnElems(); return
    }
}

function externalPanelInput(wo, event) {}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// SAMPLES VIEWER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// The Samples tab is an internal viewer: sample list on the left, properties +
// "used by" instrument list + waveform graphics on the right, and an Edit
// button that launches the external taut_sampleedit sub-program.
//
// Sample identity in .taud is derived from (samplePtr, sampleLen) inside the
// 256-byte instrument records (terranmon.txt §"Instrument bin"). Conversion
// scripts pack samples into the 8 MB pool in slot order, so sorting unique
// pointers ascending lines up with SNam[i] in the project-data block.

// Peripheral memory window offsets, from terranmon.txt:1994-1999.
const TAUT_SBANK_SIZE       = 524288  // 512 K window for sample bin
const TAUT_INST_WINDOW_OFF  = 720896  // instrument bin starts here in peri space
const TAUT_INST_RECORD_SIZE = 256
const TAUT_INST_COUNT       = 256     // slots 0..255; slot 0 is unused

// Read one 256-byte instrument record straight out of the audio adapter.
function readInstRecord(slot) {
    const memBase = audio.getMemAddr()
    const base    = TAUT_INST_WINDOW_OFF + slot * TAUT_INST_RECORD_SIZE
    const rec = new Uint8Array(TAUT_INST_RECORD_SIZE)
    for (let i = 0; i < TAUT_INST_RECORD_SIZE; i++) {
        rec[i] = sys.peek(memBase - (base + i)) & 0xFF
    }
    return rec
}

// Decode the fields the viewer actually cares about. Offsets from terranmon.txt:2071+.
function decodeInstRecord(rec) {
    const samplePtr  = (rec[0]) | (rec[1] << 8) | (rec[2] << 16) | (rec[3] * 0x1000000)
    const sampleLen  = rec[4] | (rec[5] << 8)
    const c4Rate     = rec[6] | (rec[7] << 8)
    const playStart  = rec[8] | (rec[9] << 8)
    const loopStart  = rec[10] | (rec[11] << 8)
    const loopEnd    = rec[12] | (rec[13] << 8)
    const sampleFlags = rec[14]
    const instGV     = rec[171]
    const defNoteVol = rec[196]
    const detune     = rec[184] | (rec[185] << 8)
    return {
        samplePtr, sampleLen, c4Rate, playStart, loopStart, loopEnd,
        sampleFlags, instGV, defNoteVol, detune
    }
}

// Scan all 256 instruments and build the deduped sample list. Each returned
// entry is { ptr, len, c4Rate, playStart, loopStart, loopEnd, sampleFlags,
// usedBy[], name }. usedBy is a list of instrument slot numbers (1..255).
let samplesCache = null

function buildSampleIndex() {
    const byPtr = new Map()
    for (let i = 1; i < TAUT_INST_COUNT; i++) {
        const d = decodeInstRecord(readInstRecord(i))
        if (d.sampleLen === 0) continue
        const key = d.samplePtr + ':' + d.sampleLen
        if (!byPtr.has(key)) {
            byPtr.set(key, {
                ptr:        d.samplePtr,
                len:        d.sampleLen,
                c4Rate:     d.c4Rate,
                playStart:  d.playStart,
                loopStart:  d.loopStart,
                loopEnd:    d.loopEnd,
                sampleFlags:d.sampleFlags,
                usedBy:     [],
                name:       ''
            })
        }
        byPtr.get(key).usedBy.push(i)
    }
    const list = Array.from(byPtr.values()).sort((a, b) => a.ptr - b.ptr)
    const names = (songsMeta && songsMeta.sampleNames) || []
    for (let i = 0; i < list.length; i++) {
        // SNam is slot-indexed (entry 0 unused); converters keep sample order
        // identical to pool order, so list[i] corresponds to names[i+1].
        const n = names[i + 1]
        list[i].name = (n != null) ? n : ''
    }
    return list
}

function refreshSamplesCache() { samplesCache = buildSampleIndex() }

// ── Layout ───────────────────────────────────────────────────────────────────
// Panel area is rows PTNVIEW_OFFSET_Y .. SCRH-1 (the hint bar lives at SCRH).
// Columns mirror the Patterns tab: list body | scroll-bar col | VERT separator | right pane.
const SMP_LIST_X      = 1
const SMP_LIST_BODY_W = 27                              // text width of one list row
const SMP_LIST_W      = SMP_LIST_BODY_W + 1             // body + 1-col scroll indicator
const SMP_LIST_SCROLL_X = SMP_LIST_X + SMP_LIST_BODY_W  // scroll-indicator column
const SMP_LIST_Y    = PTNVIEW_OFFSET_Y
const SMP_LIST_H    = PTNVIEW_HEIGHT                    // full panel height
const SMP_SEP_X     = SMP_LIST_X + SMP_LIST_W           // vertical separator column
const SMP_RIGHT_X   = SMP_SEP_X + 1
const SMP_RIGHT_Y   = PTNVIEW_OFFSET_Y
const SMP_PROP_H    = 10                  // rows 5..14
const SMP_USED_Y    = SMP_RIGHT_Y + SMP_PROP_H            // header row
const SMP_USED_HDR_H = 1
const SMP_USED_LIST_H = 5
const SMP_WAVE_Y    = SMP_USED_Y + SMP_USED_HDR_H + SMP_USED_LIST_H   // row 21
const SMP_BTN_Y     = SCRH - 1            // bottom-most panel row, reserved for Edit button
const SMP_WAVE_H_ROWS = SMP_BTN_Y - SMP_WAVE_Y                        // visual rows used by the waveform

const colSmpListBg     = colBackPtn
const colSmpListSel    = colHighlight
const colSmpListNumFg  = colInst
const colSmpListNameFg = colStatus
const colSmpPropLabel  = colVoiceHdr
const colSmpPropValue  = colWHITE
const colSmpUsedHdr    = colVoiceHdr
const colSmpUsedFg     = colInst
const colSmpWaveLine   = 77        // bright cyan-ish; visible on dark bg
const colSmpWaveMid    = 246       // dim grey for zero-line
const colSmpWaveFunk   = 221       // orange — loop bytes live-inverted by funk repeat (S$Fx)

// Funk-repeat introspection API (getVoiceFunkSpeed / getInstrumentFunkMask) ships with this
// feature; on an un-rebuilt host VM it's absent and the waveform stays the stored sample.
const hasFunkAPI = (typeof audio !== 'undefined' &&
    typeof audio.getVoiceFunkSpeed === 'function' &&
    typeof audio.getInstrumentFunkMask === 'function')

let smpListScroll = 0
let smpListCursor = 0

function clampSamplesCursor() {
    const n = samplesCache ? samplesCache.length : 0
    if (smpListCursor < 0) smpListCursor = 0
    if (smpListCursor >= n) smpListCursor = Math.max(0, n - 1)
    if (smpListCursor < smpListScroll) smpListScroll = smpListCursor
    if (smpListCursor >= smpListScroll + SMP_LIST_H)
        smpListScroll = smpListCursor - SMP_LIST_H + 1
    if (smpListScroll < 0) smpListScroll = 0
}

function drawSamplesListColumn() {
    const n = samplesCache ? samplesCache.length : 0
    for (let row = 0; row < SMP_LIST_H; row++) {
        const idx = smpListScroll + row
        const y = SMP_LIST_Y + row
        con.move(y, SMP_LIST_X)
        if (idx >= n) {
            con.color_pair(colSmpListNameFg, colSmpListBg)
            print(' '.repeat(SMP_LIST_BODY_W))
            continue
        }
        const s = samplesCache[idx]
        const isSel = (idx === smpListCursor)
        const back  = isSel ? colSmpListSel : colSmpListBg
        const numStr = (idx + 1).toString(16).toUpperCase().padStart(2, '0')
        const nameRaw = (s.name && s.name.length) ? s.name : '(sample ' + (idx + 1) + ')'
        const nameW = SMP_LIST_BODY_W - 6   // ' NN  name ' totals 6 + N chars
        const nameStr = (nameRaw.length > nameW ? nameRaw.substring(0, nameW) : nameRaw.padEnd(nameW))
        con.color_pair(colSmpListNumFg, back); print(' ' + numStr + ' ')
        con.color_pair(colSmpListNameFg, back); print(' ')
        con.color_pair(isSel ? colWHITE : colSmpListNameFg, back); print(nameStr)
        con.color_pair(colSmpListNameFg, back); print(' ')
    }
    // scroll indicator on the rightmost column of the list area (left of the separator)
    if (n > SMP_LIST_H) {
        const maxScroll = n - SMP_LIST_H
        const indPos = (maxScroll === 0) ? 0 : ((smpListScroll * (SMP_LIST_H - 1) / maxScroll) | 0)
        for (let r = 0; r < SMP_LIST_H; r++) {
            con.move(SMP_LIST_Y + r, SMP_LIST_SCROLL_X)
            con.color_pair(colStatus, colSmpListBg)

            let scrollChar = (r == 0) ? sym.taut_scrollgutter_top : (r == SMP_LIST_H - 1) ? sym.taut_scrollgutter_bot : sym.taut_scrollgutter_mid
            if (r == indPos) scrollChar += 3;
            con.addch(scrollChar)
        }
    } else {
        for (let r = 0; r < SMP_LIST_H; r++) {
            con.move(SMP_LIST_Y + r, SMP_LIST_SCROLL_X)
            con.color_pair(colStatus, colSmpListBg); print(' ')
        }
    }
}

function drawSamplesSeparator() {
    con.color_pair(colSep, colBackPtn)
    for (let y = SMP_LIST_Y; y < SCRH; y++) {
        con.move(y, SMP_SEP_X); con.prnch(VERT)
    }
}

function loopModeName(flags) {
    const lp = flags & 3
    const sus = (flags >>> 2) & 1
    const names = ['none', 'forward', 'pingpong', 'oneshot']
    return names[lp] + (sus ? ' (sustain)' : '')
}

function drawSamplesProperties() {
    const rightW = SCRW - SMP_RIGHT_X + 1
    // Clear right side
    for (let r = 0; r < SMP_PROP_H + SMP_USED_HDR_H + SMP_USED_LIST_H; r++) {
        con.move(SMP_RIGHT_Y + r, SMP_RIGHT_X)
        con.color_pair(colSmpPropValue, colBackPtn)
        print(' '.repeat(rightW))
    }

    const n = samplesCache ? samplesCache.length : 0
    if (n === 0) {
        con.move(SMP_RIGHT_Y, SMP_RIGHT_X)
        con.color_pair(colSmpPropLabel, colBackPtn)
        print('No samples in this project.')
        return
    }

    const s = samplesCache[smpListCursor]
    if (!s) return

    const rows = [
        ['Sample #', (smpListCursor + 1).toString(16).toUpperCase().padStart(2, '0') + '  ($' + s.ptr.toString(16).toUpperCase().padStart(6, '0') + ')'],
        ['Name',     s.name && s.name.length ? s.name : '(unnamed)'],
        ['Length',   s.len + ' bytes  ($' + s.len.toString(16).toUpperCase().padStart(4, '0') + ')'],
        ['Rate@C4',  s.c4Rate + ' Hz'],
        ['Play st.', '$' + s.playStart.toString(16).toUpperCase().padStart(4, '0')],
        ['Loop',     loopModeName(s.sampleFlags) +
                        '  [$' + s.loopStart.toString(16).toUpperCase().padStart(4, '0') +
                        '..$' + s.loopEnd.toString(16).toUpperCase().padStart(4, '0') + ']'],
        ['Bank',     ((s.ptr / TAUT_SBANK_SIZE) | 0) + '/15'],
        ['Used by',  s.usedBy.length + ' instrument' + (s.usedBy.length === 1 ? '' : 's')],
    ]

    for (let i = 0; i < rows.length; i++) {
        const y = SMP_RIGHT_Y + i
        con.move(y, SMP_RIGHT_X)
        con.color_pair(colSmpPropLabel, colBackPtn)
        print((rows[i][0] + '         ').substring(0, 10))
        con.color_pair(colSmpPropValue, colBackPtn)
        const v = rows[i][1]
        const valMax = rightW - 11
        print(v.length > valMax ? v.substring(0, valMax) : v)
    }
}

// Vertical scroll for the "Used by instruments" list (small in this viewer).
let smpUsedScroll = 0

function drawSamplesUsedBy() {
    const s = (samplesCache && samplesCache[smpListCursor]) || null
    const used = s ? s.usedBy : []
    const names = (songsMeta && songsMeta.instNames) || []
    const visible = SMP_USED_LIST_H

    const rightW = SCRW - SMP_RIGHT_X + 1
    con.move(SMP_USED_Y, SMP_RIGHT_X)
    con.color_pair(colSmpUsedHdr, colBackPtn)
    print(`Used by instruments (${used.length}):`.padEnd(rightW))

    if (smpUsedScroll > Math.max(0, used.length - visible))
        smpUsedScroll = Math.max(0, used.length - visible)
    if (smpUsedScroll < 0) smpUsedScroll = 0

    for (let r = 0; r < visible; r++) {
        const y = SMP_USED_Y + 1 + r
        con.move(y, SMP_RIGHT_X)
        con.color_pair(colSmpPropValue, colBackPtn)
        const idx = smpUsedScroll + r
        if (idx >= used.length) {
            print(' '.repeat(rightW))
            continue
        }
        const slot = used[idx]
        const iname = names[slot] || '(unnamed)'
        const numStr = '$' + slot.toString(16).toUpperCase().padStart(2, '0')
        con.color_pair(colSmpUsedFg, colBackPtn)
        print(' ' + numStr + ' ')
        con.color_pair(colSmpPropValue, colBackPtn)
        const nameW = rightW - 5
        print(iname.length > nameW ? iname.substring(0, nameW) : iname.padEnd(nameW))
    }
}

// ── Waveform rendering ──────────────────────────────────────────────────────
// Renders one sample under the right panel as baseline-filled bars (each bar is
// a plotRect anchored at the zero line, extending to the sample amplitude),
// using the graphics layer. Samples are unsigned 8-bit; bank-switch is required
// because only 512 K of the 8 MB pool is mapped at a time. We restore bank 0
// (the playback-expected default) when done.

// Pixel rect occupied by the waveform inside the Samples viewer. Both the
// waveform painter and the leave-Samples cleanup need to reach for the same
// geometry, so it lives in one helper.
function sampleWaveformRect() {
    return {
        x: (SMP_RIGHT_X - 1) * CELL_PW,
        y: (SMP_WAVE_Y - 1) * CELL_PH,
        w: (SCRW - SMP_RIGHT_X + 1) * CELL_PW,
        h: SMP_WAVE_H_ROWS * CELL_PH,
    }
}

function clearSampleWaveformArea() {
    const r = sampleWaveformRect()
    graphics.plotRect(r.x-2, r.y-2, r.w+4, r.h+4, 255)   // 255 = transparent
}

// Instrument slot of an active voice that's funk-repeating (S$Fx) one of the sample's `usedBy`
// instruments, or -1. Returns -1 when not playing / no funking voice / API absent. Drives the
// per-frame repaint cadence only — the *displayed* mask comes from funkMaskForSample, which also
// honours masks that persist after the funking voice has gone idle.
function findFunkInstForSample(usedBy) {
    if (!hasFunkAPI) return -1
    const numVox = (song && song.numVoices) ? song.numVoices : NUM_VOICES
    for (let v = 0; v < numVox; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        if (audio.getVoiceFunkSpeed(PLAYHEAD, v) <= 0) continue
        const inst = audio.getVoiceInstrument(PLAYHEAD, v)
        if (usedBy.indexOf(inst) >= 0) return inst
    }
    return -1
}

// Funk XOR mask to DISPLAY for this sample, or null. The per-instrument mask persists in the engine
// for the whole playback session (cleared only on stop-and-replay), so once a loop has been
// funk-inverted the overlay must stay even after the funking voice goes idle — matching ProTracker,
// whose destructive EFx edits never revert until the song is reloaded. Prefer an actively-funking
// instrument (its mask is live this frame); otherwise show any usedBy instrument that still carries
// a non-empty mask from earlier in the session.
function funkMaskForSample(usedBy, activeInst) {
    if (!hasFunkAPI) return null
    if (activeInst > 0) {
        const m = audio.getInstrumentFunkMask(activeInst)
        if (m && m.length > 0) return m
    }
    for (let i = 0; i < usedBy.length; i++) {
        const m = audio.getInstrumentFunkMask(usedBy[i])
        if (m && m.length > 0) return m
    }
    return null
}

// Whether a voice was actively funk-repeating the displayed sample on the last paint. Drives the
// per-frame repaint cadence in tickFunkWaveform (repaint while the live mask changes, plus one
// settling frame after it stops). The painted overlay itself persists — the engine keeps the mask.
let funkWaveLast = false

function drawSampleWaveform() {
    const r = sampleWaveformRect()
    const wx0 = r.x, wy0 = r.y, wW = r.w, wH = r.h

    // Clear waveform area to transparent (255 = transparent against text bg)
    clearSampleWaveformArea()

    const s = (samplesCache && samplesCache[smpListCursor]) || null
    if (!s || s.len === 0) { funkWaveLast = false; return }

    // Funk-repeat overlay. The per-instrument XOR mask flips loop-region bytes by 0xFF and persists
    // in the engine until stop-and-replay, so the overlay must remain even after the voice that
    // funked the sample goes idle — matching ProTracker's destructive EFx, whose inverted bytes
    // never revert until the song is reloaded. We therefore key the overlay off the persisted mask,
    // not off a currently-active funking voice. funkLE is clamped to the snapshot mask's coverage so
    // the bit lookup can never run off the (host) array.
    let funkMask = null, funkLS = 0, funkLE = 0
    let activeFunk = false
    if (playbackMode !== PLAYMODE_NONE && s.loopEnd > s.loopStart) {
        const activeInst = findFunkInstForSample(s.usedBy)
        activeFunk = (activeInst > 0)
        const m = funkMaskForSample(s.usedBy, activeInst)
        if (m) {
            funkMask = m
            funkLS = s.loopStart
            funkLE = Math.min(s.loopEnd, funkLS + m.length * 8)
        }
    }
    funkWaveLast = activeFunk

    const memBase  = audio.getMemAddr()
    const prevBank = audio.getSampleBank() || 0
    let curBank = -1

    // Zero line and value→y mapping (unsigned 8-bit: 255 → top, 0 → bottom).
    const baseY = wy0 + (wH >>> 1)
    const yOf = (v) => wy0 + (((wH * (255 - v)) / 255) | 0)

    // Read sample byte p (0..len-1) applying the live funk-flip overlay; sets the
    // shared `flippedAny` flag whenever a byte was inverted by the funk mask.
    let flippedAny = false
    const readByte = (p) => {
        const abs = s.ptr + p
        const bank = (abs / TAUT_SBANK_SIZE) | 0
        if (bank !== curBank) { audio.setSampleBank(bank); curBank = bank }
        let v = sys.peek(memBase - (abs - bank * TAUT_SBANK_SIZE)) & 0xFF
        if (funkMask !== null && p >= funkLS && p < funkLE) {
            const k = p - funkLS
            if ((funkMask[k >>> 3] >>> (k & 7)) & 1) { v ^= 0xFF; flippedAny = true }
        }
        return v
    }

    // Zero/baseline line
    graphics.plotRect(wx0, baseY, wW, 1, colSmpWaveMid)

    // Per-sample bar width: how many pixels each sample spans, at least 1px.
    const rectW = Math.max(1, Math.ceil(wW / s.len))

    if (s.len <= wW) {
        // Fewer samples than pixels: one baseline-filled bar per sample.
        for (let i = 0; i < s.len; i++) {
            flippedAny = false
            const yv = yOf(readByte(i))
            const top = Math.min(baseY, yv)
            graphics.plotRect(wx0 + ((i * wW / s.len) | 0), top, rectW,
                              Math.max(1, Math.abs(baseY - yv)),
                              flippedAny ? colSmpWaveFunk : colSmpWaveLine)
        }
    } else {
        // More samples than pixels: reduce each 1px column to its min/max and
        // fill from the baseline through the envelope (a solid filled waveform).
        for (let col = 0; col < wW; col++) {
            const start = (col * s.len / wW) | 0
            const end   = Math.min(s.len, (((col + 1) * s.len / wW) | 0))
            if (end <= start) continue
            const step = Math.max(1, ((end - start) / 8) | 0)
            let mn = 255, mx = 0
            flippedAny = false
            for (let p = start; p < end; p += step) {
                const v = readByte(p)
                if (v < mn) mn = v
                if (v > mx) mx = v
            }
            const yTop = Math.min(baseY, yOf(mx))
            const yBot = Math.max(baseY, yOf(mn))
            graphics.plotRect(wx0 + col, yTop, 1, Math.max(1, yBot - yTop + 1),
                              flippedAny ? colSmpWaveFunk : colSmpWaveLine)
        }
    }

    // Restore bank 0 for playback (engine expects bank 0 as default)
    audio.setSampleBank(prevBank)
}

// Per-frame driver: while a voice is funk-repeating the displayed sample, repaint the waveform
// each frame so the overlay tracks the live mask. One settling repaint fires after funk stops
// (funkWaveLast); the persisted overlay then stays until the engine clears the mask on replay.
function tickFunkWaveform() {
    if (currentPanel !== VIEW_SAMPLES) { funkWaveLast = false; return }
    const s = (samplesCache && samplesCache[smpListCursor]) || null
    const funking = !!(s && s.len > 0 && playbackMode !== PLAYMODE_NONE &&
                       findFunkInstForSample(s.usedBy) > 0)
    if (funking || funkWaveLast) drawSampleWaveform()
}

function drawSamplesEditButton() {
    const y = SMP_BTN_Y
    con.move(y, SMP_RIGHT_X)
    con.color_pair(colSmpUsedHdr, colBackPtn)
    print('[ E ]')
    con.color_pair(colSmpPropValue, colBackPtn)
    const label = ' Edit sample'
    print(label)
    const rest = SCRW - (SMP_RIGHT_X + 5 + label.length) + 1
    if (rest > 0) print(' '.repeat(rest))
}

function clearSamplesPanel() {
    // Panel area only — leave the hint row (SCRH) alone; drawControlHint owns it.
    for (let y = PTNVIEW_OFFSET_Y; y < SCRH; y++) fillLine(y, colSmpPropValue, colBackPtn)
}

function drawSamplesContents(wo) {
    if (samplesCache === null) refreshSamplesCache()
    clampSamplesCursor()
    clearSamplesPanel()
    drawSamplesListColumn()
    drawSamplesSeparator()
    drawSamplesProperties()
    drawSamplesUsedBy()
    drawSampleWaveform()
    drawSamplesEditButton()
    // The list column just repainted col 1 with a leading space on every row,
    // so any prior blob is gone — invalidate the cache, then re-stamp blobs
    // immediately when playback is live so the user does not see a one-frame gap.
    invalidateSamplesBlob()
    if (playbackMode !== PLAYMODE_NONE) drawSamplesPlayBlobs()
    // Same reasoning for the waveform playhead cursor — drawSampleWaveform just
    // wiped the area, so its prior column is irrelevant. Re-stamp if playing.
    invalidateSmpCursor()
    if (playbackMode !== PLAYMODE_NONE) drawSampleCursor()
}

let pendingEditorLaunch = null   // { progName, args[] }

function requestEditorLaunch(progName, args) {
    pendingEditorLaunch = { progName, args: args || [] }
}

// Jump into the in-process instrument viewer with the cursor parked on `instSlot`.
// `instSlotToIdx` is the {slot → cache index} map built by refreshInstrumentsCache;
// when the slot isn't in the cache (rare — empty slot with no name), we fall back
// to cursor 0 instead of failing the switch.
function launchInstrumentViewerFor(instSlot) {
    if (instrumentsCache === null) refreshInstrumentsCache()
    const idx = (instSlotToIdx && instSlotToIdx[instSlot] != null) ? instSlotToIdx[instSlot] : -1
    if (idx >= 0) instListCursor = idx
    clampInstrumentsCursor()
    switchToPanel(VIEW_INSTRMNT)
}

function samplesInput(wo, event) {
    if (event[0] !== 'key_down') return
    const keysym     = event[1]
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 8 : 1

    const n = samplesCache ? samplesCache.length : 0
    if (n === 0) {
        if (keysym === 'e' || keysym === 'E') {
            requestEditorLaunch('taut_sampleedit', [fullPathObj.full, VIEW_SAMPLES, -1])
        }
        return
    }

    if (keysym === '<UP>')   { smpListCursor -= moveDelta; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<DOWN>') { smpListCursor += moveDelta; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<PAGE_UP>')   { smpListCursor -= SMP_LIST_H; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<PAGE_DOWN>') { smpListCursor += SMP_LIST_H; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<HOME>') { smpListCursor = 0; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }
    if (keysym === '<END>')  { smpListCursor = n - 1; clampSamplesCursor(); smpUsedScroll = 0; drawSamplesContents(); return }

    if (keysym === 'e' || keysym === 'E') {
        requestEditorLaunch('taut_sampleedit', [fullPathObj.full, VIEW_SAMPLES, smpListCursor])
        return
    }

    if (keysym === '\n') {
        // Open the first instrument that uses this sample in the (stub) inst viewer
        const s = samplesCache[smpListCursor]
        if (s && s.usedBy.length > 0) {
            launchInstrumentViewerFor(s.usedBy[0])
        }
        return
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// END SAMPLES VIEWER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////


/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// INSTRUMENTS VIEWER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Mirrors the Samples tab skeleton: list on the left, multi-tabbed property pane
// on the right. Tabs are General / Volume / Panning / Pitch — the latter three
// each carry an envelope graph rendered through the graphics layer.
//
// All field offsets/encodings follow terranmon.txt §"Instrument bin" (offsets
// 0..196). Envelope nodes (offsets 21 / 71 / 121) are 25 × {value u8, time u8}
// where the time byte is a 3.5 unsigned minifloat — converted here using the
// same decoder formula as ThreeFiveMinifloat.kt / taud_common.py MINUFLOAT_LUT.

// 3.5 unsigned minifloat: exp = bits 7..5 (0..7), mant = bits 4..0 (0..31).
//   exp == 0 : value = mant / 256                        (smallest non-zero step = 1/256 s)
//   exp >  0 : value = (mant + 32) * 2^(exp - 9)         (max = 15.75 s at 0xFF)
function envTimeFromByte(b) {
    const exp  = (b >>> 5) & 7
    const mant =  b        & 31
    return (exp === 0) ? (mant / 256) : ((mant + 32) * Math.pow(2, exp - 9))
}

// Decode one of the three envelopes from the 256-byte instrument record. `kind`
// selects the node array (vol/pan/pf) and the LOOP/SUSTAIN word locations.
//   nodes: {value, durByte, durSec} array, truncated at the first dur=0 node
//          (the terminator — see terranmon.txt §envelope nodes "0 = hold").
//   terminatorIdx: index of the terminator, or -1 if all 25 slots are walked.
function decodeEnvelope(rec, kind) {
    const nodeBase = (kind === 'vol') ? 21  : (kind === 'pan') ? 71  : 121
    const loopOff  = (kind === 'vol') ? 15  : (kind === 'pan') ? 17  : 19
    const sustOff  = (kind === 'vol') ? 189 : (kind === 'pan') ? 191 : 193
    const valMask  = (kind === 'vol') ? 0x3F : 0xFF
    const loopWord = rec[loopOff] | (rec[loopOff + 1] << 8)
    const sustWord = rec[sustOff] | (rec[sustOff + 1] << 8)
    const present    = ((loopWord >>> 13) & 1) === 1
    const loopEnable = ((loopWord >>> 5)  & 1) === 1
    const loopStart  =  (loopWord >>> 8)  & 0x1F
    const loopEnd    =  (loopWord)        & 0x1F
    const carry      = ((loopWord >>> 6)  & 1) === 1
    const panUseDef  = (kind === 'pan') && (((loopWord >>> 7) & 1) === 1)
    const pfFilter   = (kind === 'pf')  && (((loopWord >>> 7) & 1) === 1)
    const sustEnable = ((sustWord >>> 5)  & 1) === 1
    const sustStart  =  (sustWord >>> 8)  & 0x1F
    const sustEnd    =  (sustWord)        & 0x1F
    const nodes = []
    let terminatorIdx = -1
    for (let i = 0; i < 25; i++) {
        const value   = rec[nodeBase + i * 2]     & valMask
        const durByte = rec[nodeBase + i * 2 + 1] & 0xFF
        const durSec  = envTimeFromByte(durByte)
        nodes.push({ value, durByte, durSec })
        if (durByte === 0) { terminatorIdx = i; break }
    }
    return {
        kind, present, loopEnable, loopStart, loopEnd, carry,
        panUseDef, pfFilter, sustEnable, sustStart, sustEnd,
        nodes, terminatorIdx, valueMax: valMask
    }
}

// Decode the full 256-byte instrument record into a structured object suitable
// for display. Field offsets/encodings track terranmon.txt §"Instrument bin".
function decodeInstFull(rec) {
    const samplePtr      = (rec[0]) | (rec[1] << 8) | (rec[2] << 16) | (rec[3] * 0x1000000)
    const sampleLen      = rec[4]  | (rec[5]  << 8)
    const c4Rate         = rec[6]  | (rec[7]  << 8)
    const playStart      = rec[8]  | (rec[9]  << 8)
    const sLoopStart     = rec[10] | (rec[11] << 8)
    const sLoopEnd       = rec[12] | (rec[13] << 8)
    const sampleFlags    = rec[14]
    const igv            = rec[171]
    const fadeoutLo      = rec[172]
    const fadeoutHi      = rec[173]
    const fadeout        = fadeoutLo | ((fadeoutHi & 0x0F) << 8)
    const volSwing       = rec[174]
    const vibSpeed       = rec[175]
    const vibSweep       = rec[176]
    const defPan         = rec[177]
    const pitchPanCenter = rec[178] | (rec[179] << 8)
    let   pitchPanSep    = rec[180]; if (pitchPanSep >= 128) pitchPanSep -= 256
    const panSwing       = rec[181]
    const defCutoff      = rec[182]
    const defReso        = rec[183]
    let   detune         = rec[184] | (rec[185] << 8); if (detune >= 0x8000) detune -= 0x10000
    const instFlag       = rec[186]
    const nna            = instFlag & 3
    const vibWaveform    = (instFlag >>> 2) & 7
    const vibDepth       = rec[187]
    const vibRate        = rec[188]
    const dcByte         = rec[195]
    const dct            = dcByte & 3
    const dca            = (dcByte >>> 2) & 3
    const defNoteVol     = rec[196]
    return {
        samplePtr, sampleLen, c4Rate, playStart, sLoopStart, sLoopEnd, sampleFlags,
        igv, fadeout, volSwing, vibSpeed, vibSweep, defPan,
        pitchPanCenter, pitchPanSep, panSwing, defCutoff, defReso,
        detune, nna, vibWaveform, vibDepth, vibRate, dct, dca, defNoteVol,
        volEnv: decodeEnvelope(rec, 'vol'),
        panEnv: decodeEnvelope(rec, 'pan'),
        pfEnv:  decodeEnvelope(rec, 'pf')
    }
}

// Scan slots 1..255. Keep any slot that either has a non-empty sample length
// or a project-data INam entry. Returns a flat list — UI cursor walks this,
// not raw slot numbers — and a {slot → cacheIdx} reverse map for
// launchInstrumentViewerFor's jump-to-slot path.
let instrumentsCache = null
let instSlotToIdx    = null

function buildInstrumentIndex() {
    const list = []
    const names = (songsMeta && songsMeta.instNames) || []
    for (let i = 1; i < TAUT_INST_COUNT; i++) {
        const rec = readInstRecord(i)
        const sampleLen = rec[4] | (rec[5] << 8)
        const nm = names[i] || ''
        if (sampleLen === 0 && nm === '') continue
        list.push({ slot: i, name: nm, decoded: decodeInstFull(rec) })
    }
    instSlotToIdx = {}
    for (let i = 0; i < list.length; i++) instSlotToIdx[list[i].slot] = i
    return list
}

function refreshInstrumentsCache() { instrumentsCache = buildInstrumentIndex() }

// ── Layout ─────────────────────────────────────────────────────────────────
const INST_LIST_X        = 1
const INST_LIST_BODY_W   = 27
const INST_LIST_W        = INST_LIST_BODY_W + 1
const INST_LIST_SCROLL_X = INST_LIST_X + INST_LIST_BODY_W
const INST_LIST_Y        = PTNVIEW_OFFSET_Y
const INST_LIST_H        = PTNVIEW_HEIGHT
const INST_SEP_X         = INST_LIST_X + INST_LIST_W
const INST_RIGHT_X       = INST_SEP_X + 1
const INST_RIGHT_Y       = PTNVIEW_OFFSET_Y
const INST_RIGHT_W       = SCRW - INST_RIGHT_X + 1
const INST_BTN_Y         = SCRH - 1
const INST_TAB_Y         = INST_RIGHT_Y                       // tab strip row
const INST_BODY_Y        = INST_RIGHT_Y + 2                   // first content row
const INST_BODY_H        = INST_BTN_Y - INST_BODY_Y           // content rows (excludes button)

// General tab content does not fit in the 24-row body area of an 80x32 terminal,
// so it splits into two pages (sample/volume/panning on page 1;
// filter/vibrato/note-actions/tuning on page 2).
const INST_TAB_NAMES = ['Gen.1', 'Gen.2', 'Volume', 'Pan', 'Pitch']
const INST_TAB_GEN1 = 0, INST_TAB_GEN2 = 1, INST_TAB_VOL = 2, INST_TAB_PAN = 3, INST_TAB_PIT = 4

const colInstListBg     = colBackPtn
const colInstListSel    = colHighlight
const colInstListNumFg  = colInst
const colInstListNameFg = colStatus
const colInstGroupHdr   = colVoiceHdr
const colInstLabel      = colStatus
const colInstValue      = colWHITE
const colInstHighlight  = colVol
const colInstEnvLine    = 77            // bright cyan-ish, same as sample wave
const colInstEnvNode    = 198           // pink-ish — node markers stand out from line
const colInstEnvAxis    = 246           // dim grey for zero/center line
const colInstEnvHair    = 251           // darker grey — quarter-point hairlines (dashed)
const colInstEnvLoop    = 220           // muted yellow-orange — loop range band
const colInstEnvSust    = 145           // muted yellow-green — loop range band
const colInstEnvLoopSuper= 230           // muted yellow-orange — loop range band
const colInstEnvSustSuper= 155           // muted yellow-green — loop range band

let instListScroll = 0
let instListCursor = 0
let instSubTab     = INST_TAB_GEN1

function clampInstrumentsCursor() {
    const n = instrumentsCache ? instrumentsCache.length : 0
    if (instListCursor < 0) instListCursor = 0
    if (instListCursor >= n) instListCursor = Math.max(0, n - 1)
    if (instListCursor < instListScroll) instListScroll = instListCursor
    if (instListCursor >= instListScroll + INST_LIST_H)
        instListScroll = instListCursor - INST_LIST_H + 1
    if (instListScroll < 0) instListScroll = 0
}

function drawInstrumentsListColumn() {
    const n = instrumentsCache ? instrumentsCache.length : 0
    for (let row = 0; row < INST_LIST_H; row++) {
        const idx = instListScroll + row
        const y = INST_LIST_Y + row
        con.move(y, INST_LIST_X)
        if (idx >= n) {
            con.color_pair(colInstListNameFg, colInstListBg)
            print(' '.repeat(INST_LIST_BODY_W))
            continue
        }
        const e = instrumentsCache[idx]
        const isSel = (idx === instListCursor)
        const back  = isSel ? colInstListSel : colInstListBg
        const numStr = e.slot.toString(16).toUpperCase().padStart(2, '0')
        const nameRaw = (e.name && e.name.length) ? e.name : '(instrument $' + numStr + ')'
        const nameW = INST_LIST_BODY_W - 6
        const nameStr = (nameRaw.length > nameW ? nameRaw.substring(0, nameW) : nameRaw.padEnd(nameW))
        con.color_pair(colInstListNumFg, back); print(' ' + numStr + ' ')
        con.color_pair(colInstListNameFg, back); print(' ')
        con.color_pair(isSel ? colWHITE : colInstListNameFg, back); print(nameStr)
        con.color_pair(colInstListNameFg, back); print(' ')
    }
    // scroll indicator column
    if (n > INST_LIST_H) {
        const maxScroll = n - INST_LIST_H
        const indPos = (maxScroll === 0) ? 0 : ((instListScroll * (INST_LIST_H - 1) / maxScroll) | 0)
        for (let r = 0; r < INST_LIST_H; r++) {
            con.move(INST_LIST_Y + r, INST_LIST_SCROLL_X)
            con.color_pair(colStatus, colInstListBg)

            let scrollChar = (r == 0) ? sym.taut_scrollgutter_top : (r == INST_LIST_H - 1) ? sym.taut_scrollgutter_bot : sym.taut_scrollgutter_mid
            if (r == indPos) scrollChar += 3;
            con.addch(scrollChar)        }
    } else {
        for (let r = 0; r < INST_LIST_H; r++) {
            con.move(INST_LIST_Y + r, INST_LIST_SCROLL_X)
            con.color_pair(colStatus, colInstListBg); print(' ')
        }
    }
}

function drawInstrumentsSeparator() {
    con.color_pair(colSep, colBackPtn)
    for (let y = INST_LIST_Y; y < SCRH; y++) {
        con.move(y, INST_SEP_X); con.prnch(VERT)
    }
}

// Geometry helper for one tab chip in the right-pane tab strip. Tabs partition
// INST_RIGHT_W into 4 equal-width chips with a 1-col gap at each boundary; the
// click handler uses the same formula in reverse to map cx → tab index.
function instTabRect(tabIdx) {
    const slotW = (INST_RIGHT_W / INST_TAB_NAMES.length) | 0
    return { x: INST_RIGHT_X + tabIdx * slotW, y: INST_TAB_Y, w: slotW }
}

function drawInstrumentsTabStrip() {
    // background row for the tab strip
    con.move(INST_TAB_Y, INST_RIGHT_X)
    con.color_pair(colTabBarOrn, colTabBarBack)
    print(' '.repeat(INST_RIGHT_W))
    for (let i = 0; i < INST_TAB_NAMES.length; i++) {
        const r = instTabRect(i)
        const active = (instSubTab === i)
        const fg = active ? colTabActive : colTabInactive
        const bg = active ? colTabBarBack2 : colTabBarBack
        con.move(r.y, r.x)
        con.color_pair(fg, bg)
        const lbl = INST_TAB_NAMES[i]
        const pad = Math.max(0, r.w - lbl.length)
        const padL = pad >>> 1
        const padR = pad - padL

        let colFore = active ? colTabActive : colTabInactive
        let colBack = active ? colTabBarBack2 : colTabBarBack
        let colFore2 = active ? colTabBarBack2 : colTabBarBack
        let colBack2 = active ? colTabBarBack : colTabBarBack
        let spcL = active ? sym.leftshade : ' '
        let spcR = active ? sym.rightshade : ' '

        con.color_pair(colFore2, colBack2); print(spcL)
        con.color_pair(colFore, colBack); print(' '.repeat(padL-1) + lbl + ' '.repeat(padR-1))
        con.color_pair(colFore2, colBack2); print(spcR)
    }
    // 1-row gap under the tabs
    con.move(INST_TAB_Y + 1, INST_RIGHT_X)
    con.color_pair(colInstValue, colBackPtn)
    print(' '.repeat(INST_RIGHT_W))
}

// Clear the right-pane body area (tab content rows + button row).
function clearInstrumentsBody() {
    for (let r = 0; r < INST_BODY_H + 1; r++) {
        con.move(INST_BODY_Y + r, INST_RIGHT_X)
        con.color_pair(colInstValue, colBackPtn)
        print(' '.repeat(INST_RIGHT_W))
    }
}

// ── Text helpers ───────────────────────────────────────────────────────────
function _hex(n, w) { return n.toString(16).toUpperCase().padStart(w, '0') }
function _signed(n) { return (n >= 0 ? '+' : '') + n }

function loopModeNameInst(flags) {
    const lp = flags & 3
    const sus = (flags >>> 2) & 1
    const names = ['none', 'forward', 'pingpong', 'oneshot']
    return names[lp] + (sus ? ' (sustain)' : '')
}
const NNA_NAMES = ['Cut', 'Off', 'Continue', 'Fade']
const DCT_NAMES = ['off', 'note', 'sample', 'instrument']
const DCA_NAMES = ['Cut', 'Off', 'Fade', 'reserved']
const VIB_WF_NAMES = ['sine', 'ramp-dn', 'square', 'random', 'ramp-up', '?', '?', '?']

// Place a value at column INST_RIGHT_X + labelW. Labels are colour
// colInstLabel; values are colInstValue. Truncates to fit INST_RIGHT_W.
function drawLabelRow(y, label, value, labelW) {
    if (labelW == null) labelW = 12
    con.move(y, INST_RIGHT_X)
    con.color_pair(colInstLabel, colBackPtn)
    print((label + ' '.repeat(labelW)).substring(0, labelW))
    con.color_pair(colInstValue, colBackPtn)
    const maxV = INST_RIGHT_W - labelW
    const v = (value == null) ? '' : String(value)
    print(v.length > maxV ? v.substring(0, maxV) : v)
}

function drawGroupHeader(y, title) {
    con.move(y, INST_RIGHT_X)
    con.color_pair(colInstGroupHdr, colBackPtn)
    const txt = title + ' '
    const dashes = Math.max(0, INST_RIGHT_W - txt.length)
    print(txt + `\u00FB`.repeat(dashes))
}

// ── Tab body: General (page 1 + page 2) ───────────────────────────────────
// Page 1 (Gen.1):
//   Sample binding   — sample link, length, c4Rate, play/loop positions, loop mode
//   Volume           — IGV, default note vol, fadeout, vol swing
//   Panning          — default pan + "use" flag, pitch-pan centre/separation, pan swing
// Page 2 (Gen.2):
//   Filter           — default cutoff/resonance
//   Vibrato          — waveform, speed, depth, sweep, rate
//   Note actions     — NNA, DCT/DCA
//   Tuning           — signed 4096-TET detune offset
//
// Two pages because the 80x32 terminal's 24-row body cannot hold every field at
// once; the user explicitly OK'd this split.
function drawInstTabGeneral1(e) {
    const d = e.decoded
    let y = INST_BODY_Y
    const sampleNames = (songsMeta && songsMeta.sampleNames) || []
    // Map decoded.samplePtr+len back to a sample-name slot (best-effort: same
    // dedup convention as buildSampleIndex).
    let sampleLabel = '(none)'
    if (d.sampleLen > 0) {
        // Walk samplesCache if it's been built; otherwise fall back to slot 0.
        if (samplesCache === null) refreshSamplesCache()
        let smpIdx = -1
        for (let i = 0; i < samplesCache.length; i++) {
            if (samplesCache[i].ptr === d.samplePtr && samplesCache[i].len === d.sampleLen) {
                smpIdx = i; break
            }
        }
        if (smpIdx >= 0) {
            const sn = sampleNames[smpIdx + 1] || ''
            sampleLabel = '$' + _hex(smpIdx + 1, 2) + (sn.length ? '  ' + sn : '  (unnamed)')
        } else {
            sampleLabel = '@$' + _hex(d.samplePtr, 6)
        }
    }

    drawGroupHeader(y++, 'Sample binding')
    drawLabelRow(y++, '  Sample:',  sampleLabel)
    drawLabelRow(y++, '  Length:',  d.sampleLen + ' bytes ($' + _hex(d.sampleLen, 4) + ')  Rate@C4: ' + d.c4Rate + ' Hz')
    drawLabelRow(y++, '  Play st:', '$' + _hex(d.playStart, 4))
    drawLabelRow(y++, '  Loop:',    loopModeNameInst(d.sampleFlags) +
                                    '  [$' + _hex(d.sLoopStart, 4) + '..$' + _hex(d.sLoopEnd, 4) + ']')

    y++
    drawGroupHeader(y++, 'Volume')
    drawLabelRow(y++, '  Inst. GV:', _hex(d.igv, 2) + '  (' + d.igv + '/255)')
    drawLabelRow(y++, '  DefNote:',  _hex(d.defNoteVol, 2) + '  (' + d.defNoteVol + '/255' +
                                     (d.defNoteVol === 0 ? '  legacy: row default 63' : '') + ')')
    let fadeStr
    if (d.fadeout === 0)             fadeStr = '0  (no fade)'
    else if (d.fadeout >= 1024)      fadeStr = d.fadeout + '  (1-tick cut)'
    else {
        const ticks = (1024 / d.fadeout)
        fadeStr = d.fadeout + '  (~' + ticks.toFixed(1) + ' ticks)'
    }
    drawLabelRow(y++, '  Fadeout:', fadeStr)
    drawLabelRow(y++, '  Swing:',   _hex(d.volSwing, 2))

    y++
    drawGroupHeader(y++, 'Panning')
    drawLabelRow(y++, '  Default:', _hex(d.defPan, 2) + '  Use: ' +
                                    (d.panEnv.panUseDef ? sym.ticked + ' on' : sym.unticked + ' off'))
    drawLabelRow(y++, '  PPanCtr:', '$' + _hex(d.pitchPanCenter, 4) + '  Sep: ' + _signed(d.pitchPanSep))
    drawLabelRow(y++, '  Swing:',   _hex(d.panSwing, 2))
}

function drawInstTabGeneral2(e) {
    const d = e.decoded
    let y = INST_BODY_Y

    drawGroupHeader(y++, 'Filter')
    drawLabelRow(y++, '  Cutoff:',  (d.defCutoff === 0xFF ? 'off' : ('$' + _hex(d.defCutoff, 2) +
                                    '   (' + d.defCutoff + '/254)')))
    drawLabelRow(y++, '  Reso:',    (d.defReso   === 0xFF ? 'off' : ('$' + _hex(d.defReso, 2) +
                                    '   (' + d.defReso + '/254)')))

    y++
    drawGroupHeader(y++, 'Vibrato')
    drawLabelRow(y++, '  Waveform:', VIB_WF_NAMES[d.vibWaveform & 7])
    drawLabelRow(y++, '  Speed:',   _hex(d.vibSpeed, 2) + '   Depth: ' + _hex(d.vibDepth, 2))
    drawLabelRow(y++, '  Sweep:',   _hex(d.vibSweep, 2) + '   Rate:  ' + _hex(d.vibRate, 2))

    y++
    drawGroupHeader(y++, 'Note actions')
    drawLabelRow(y++, '  NNA:',     NNA_NAMES[d.nna & 3])
    drawLabelRow(y++, '  DCT:',     DCT_NAMES[d.dct & 3])
    drawLabelRow(y++, '  DCA:',     DCA_NAMES[d.dca & 3])

    y++
    drawGroupHeader(y++, 'Tuning')
    const detStr = _signed(d.detune) + '   (' + (d.detune / 0x1000).toFixed(3) + ' octave, 4096-TET)'
    drawLabelRow(y++, '  Detune:',  detStr)
}

// ── Envelope rendering (shared by Volume/Panning/Pitch tabs) ───────────────

// Pick a "nice" time-grid interval for `totalTime` (seconds). Aims for at most
// ~8 vertical hairlines, choosing from a fixed ladder so the number rendered
// next to "Total:" reads cleanly (no 0.157s grids). The smallest viable step
// covers fast envelopes (~50 ms); the top of the ladder covers the 15.75 s
// maximum the 3.5 minifloat can encode.
function pickEnvTimeGrid(totalTime) {
    const ladder = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0]
    for (let i = 0; i < ladder.length; i++) {
        if (totalTime / ladder[i] <= 8) return ladder[i]
    }
    return ladder[ladder.length - 1]
}

// Pixel rect of the envelope-graph area for the given tab content row range.
// Width spans the full right pane; height is the lower half of the body area.
function instEnvelopeRect() {
    const graphRowY = INST_BODY_Y + 7      // 7 rows of text above the graph
    const x = (INST_RIGHT_X - 1) * CELL_PW
    const y = (graphRowY - 1) * CELL_PH
    const w = INST_RIGHT_W * CELL_PW
    const h = (INST_BTN_Y - graphRowY) * CELL_PH
    return { x, y, w, h, graphRowY }
}

// Clear graphics overlay over the right-pane envelope graph. Called by
// drawInstrumentsContents on every redraw and by switchToPanel when leaving
// the instrument viewer (mirrors clearSampleWaveformArea for the same reason).
function clearInstrumentsEnvelopeArea() {
    const r = instEnvelopeRect()
    graphics.plotRect(r.x-2, r.y-2, r.w+4, r.h+4, 255)
    // Also clear the row of text that the graph overlays would otherwise visually
    // smudge — the body redraw paints these rows blank anyway, but switchToPanel
    // bypasses the body redraw on exit.
}

// Bresenham line via plotPixel. Used to connect envelope nodes.
function envPlotLine(x0, y0, x1, y1, col) {
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    // Guard against pathological inputs; envelope coords are screen-bound.
    let safety = 4096
    while (safety-- > 0) {
        graphics.plotPixel(x0, y0, col)
        if (x0 === x1 && y0 === y1) break
        const e2 = 2 * err
        if (e2 >= dy) { err += dy; x0 += sx }
        if (e2 <= dx) { err += dx; y0 += sy }
    }
}

// Draw the envelope chart for one envelope (vol/pan/pf). Plots:
//   • Quarter-point dashed hairlines as a faint reference grid.
//   • Solid axis line (bottom for vol, mid for pan/pitch).
//   • Loop / sustain wrap regions as faint vertical bands behind the curve.
//   • Polyline through all active nodes; each node a 3×3 marker.
// Time axis: cumulative durSec across nodes, scaled to fit graph width.
// Value axis: 0 at bottom, env.valueMax at top.
function drawEnvelopeGraph(env) {
    const r = instEnvelopeRect()
    clearInstrumentsEnvelopeArea()  // clear

    // Dashed reference hairlines at quarter points of the value range. Drawn
    // first so the solid axis line / loop bands / polyline can stack on top.
    // For pan/pitch the 50% level is the main axis; we skip it here to keep
    // the solid line visually distinct from the dashes.
    const hairFracs = (env.kind === 'vol') ? [0.25, 0.5, 0.75] : [0.25, 0.75]
    for (let fi = 0; fi < hairFracs.length; fi++) {
        const yy = r.y + r.h - 1 - ((hairFracs[fi] * (r.h - 1)) | 0)
        for (let xx = r.x; xx < r.x + r.w; xx += 6) {
            graphics.plotRect(xx, yy, 2, 1, colInstEnvHair)
        }
    }

    // Solid axis line — bottom of graph for vol, mid for pan/pitch.
    if (env.kind !== 'vol') {
        const midY = r.y + (r.h >>> 1)
        graphics.plotRect(r.x, midY, r.w, 1, colInstEnvAxis)
    } else {
        graphics.plotRect(r.x, r.y + r.h - 1, r.w, 1, colInstEnvAxis)
    }

    // No envelope to draw when there are zero active nodes (shouldn't happen
    // for well-formed records, but be defensive).
    const lastIdx = (env.terminatorIdx >= 0) ? env.terminatorIdx : (env.nodes.length - 1)
    if (lastIdx < 0) return

    // Cumulative time of each node (node 0 is at t=0; node i is at sum of
    // dur[0..i-1] for i>=1). The terminator's own dur is 0 so it lands at
    // the sum of the preceding nodes.
    const xs = new Array(lastIdx + 1)
    let acc = 0
    xs[0] = 0
    for (let i = 1; i <= lastIdx; i++) {
        acc += env.nodes[i - 1].durSec
        xs[i] = acc
    }
    // When total time is 0 (single-node held envelope), give the x-axis a
    // tiny non-zero span so node 0 still renders at the left edge.
    const totalTime = Math.max(acc, 1e-6)

    const valueMax = env.valueMax || 0xFF
    const pxX = (t) => r.x + Math.min(r.w - 1, Math.max(0, ((t / totalTime) * (r.w - 1)) | 0))
    const pxY = (v) => r.y + r.h - 1 - Math.min(r.h - 1, Math.max(0, ((v / valueMax) * (r.h - 1)) | 0))

    // Vertical time-grid hairlines. Same dashed style as the value-axis
    // hairlines (2 px on, 4 px off) but oriented vertically; spacing comes
    // from pickEnvTimeGrid so we never spam more than ~8 lines across the
    // graph regardless of envelope duration.
    if (acc > 0) {
        const grid = pickEnvTimeGrid(totalTime)
        for (let t = grid; t < totalTime; t += grid) {
            const xx = pxX(t)
            for (let yy = r.y; yy < r.y + r.h; yy += 6) {
                graphics.plotRect(xx, yy, 1, 2, colInstEnvHair)
            }
        }
    }

    // Loop / sustain bands behind the polyline.
    if (env.loopEnable && env.loopStart <= lastIdx && env.loopEnd <= lastIdx) {
        const x0 = pxX(xs[env.loopStart])
        const x1 = pxX(xs[env.loopEnd])
        const bw = Math.max(1, x1 - x0)
        graphics.plotRect(x0, r.y, bw, r.h, colInstEnvLoop, 2)
        // start & end hairline
        graphics.plotRect(x0, r.y, 1, r.h, colInstEnvLoopSuper)
        graphics.plotRect(x1, r.y, 1, r.h, colInstEnvLoopSuper)
    }
    if (env.sustEnable && env.sustStart <= lastIdx && env.sustEnd <= lastIdx) {
        const x0 = pxX(xs[env.sustStart])
        const x1 = pxX(xs[env.sustEnd])
        const bw = Math.max(1, x1 - x0)
        graphics.plotRect(x0, r.y, bw, r.h, colInstEnvSust, 2)
        // start & end hairline
        graphics.plotRect(x0, r.y, 1, r.h, colInstEnvSustSuper)
        graphics.plotRect(x1, r.y, 1, r.h, colInstEnvSustSuper)
    }

    // Polyline through the envelope.
    for (let i = 0; i < lastIdx; i++) {
        envPlotLine(pxX(xs[i]), pxY(env.nodes[i].value),
                    pxX(xs[i + 1]), pxY(env.nodes[i + 1].value), colInstEnvLine)
    }
    // Node markers (3×3 squares centred on the node coordinate).
    for (let i = 0; i <= lastIdx; i++) {
        const cx = pxX(xs[i]), cy = pxY(env.nodes[i].value)
        graphics.plotRect(cx - 1, cy - 1, 3, 3, colInstEnvNode)
    }
}

// Common envelope-tab body: a few lines of summary text above the graph.
// `extra` is an array of additional [label, value] rows specific to this kind
// (e.g. pan's "Use default pan" flag).
function drawInstTabEnvelope(e, env, kindLabel, extra) {
    let y = INST_BODY_Y
    drawGroupHeader(y++, kindLabel + ' envelope')
    drawLabelRow(y++, '  Present:', (env.present ? sym.ticked + ' yes (P=1)' : sym.unticked + ' no  (P=0)'))
    const realCount = (env.terminatorIdx >= 0) ? (env.terminatorIdx + 1) : env.nodes.length
    drawLabelRow(y++, '  Nodes:',   realCount + ' / 25' +
                                    (env.carry ? '   Carry: ' + sym.ticked : '   Carry: ' + sym.unticked))
    drawLabelRow(y++, '  Loop:',    env.loopEnable
                                    ? (sym.ticked + ' [' + env.loopStart + '..' + env.loopEnd + ']')
                                    : (sym.unticked + ' off'))
    drawLabelRow(y++, '  Sustain:', env.sustEnable
                                    ? (sym.ticked + ' [' + env.sustStart + '..' + env.sustEnd + ']')
                                    : (sym.unticked + ' off'))
    if (extra) {
        for (let i = 0; i < extra.length; i++) {
            drawLabelRow(y++, '  ' + extra[i][0], extra[i][1])
        }
    }
    // Total envelope length + the time-grid step the graph below uses, so the
    // dashed vertical hairlines have a readable scale.
    const lastIdx = (env.terminatorIdx >= 0) ? env.terminatorIdx : (env.nodes.length - 1)
    let totalSec = 0
    for (let i = 0; i < lastIdx; i++) totalSec += env.nodes[i].durSec
    const gridStep = pickEnvTimeGrid(Math.max(totalSec, 1e-6))
    drawLabelRow(y++, '  Length:', totalSec.toFixed(3) + ' s   (grid ' + gridStep + ' s)')

    drawEnvelopeGraph(env)
}

function drawInstTabVolume(e)  { drawInstTabEnvelope(e, e.decoded.volEnv, 'Volume') }
function drawInstTabPanning(e) {
    drawInstTabEnvelope(e, e.decoded.panEnv, 'Panning', [
        ['UseDef:', (e.decoded.panEnv.panUseDef ? sym.ticked + ' on' : sym.unticked + ' off') +
                    '  (chan-pan source: byte $B1)']
    ])
}
function drawInstTabPitch(e) {
    const env = e.decoded.pfEnv
    drawInstTabEnvelope(e, env, env.pfFilter ? 'Filter' : 'Pitch', [
        ['Mode:', env.pfFilter ? 'filter cutoff' : 'pitch']
    ])
}

// ── Edit button (bottom row) ───────────────────────────────────────────────
function drawInstrumentsEditButton() {
    const y = INST_BTN_Y
    con.move(y, INST_RIGHT_X)
    con.color_pair(colInstGroupHdr, colBackPtn); print('[ E ]')
    con.color_pair(colInstValue,    colBackPtn)
    const label = ' Edit instrument'
    print(label)
    const rest = INST_RIGHT_W - (5 + label.length)
    if (rest > 0) print(' '.repeat(rest))
}

function clearInstrumentsPanel() {
    for (let y = PTNVIEW_OFFSET_Y; y < SCRH; y++) fillLine(y, colInstValue, colBackPtn)
}

function drawInstrumentsContents(wo) {
    if (instrumentsCache === null) refreshInstrumentsCache()
    clampInstrumentsCursor()
    clearInstrumentsPanel()
    drawInstrumentsListColumn()
    drawInstrumentsSeparator()
    drawInstrumentsTabStrip()

    const n = instrumentsCache ? instrumentsCache.length : 0
    if (n === 0) {
        con.move(INST_BODY_Y, INST_RIGHT_X)
        con.color_pair(colInstGroupHdr, colBackPtn)
        print('No instruments in this project.')
        // wipe any old envelope graph
        clearInstrumentsEnvelopeArea()
        drawInstrumentsEditButton()
        return
    }
    const e = instrumentsCache[instListCursor]
    // Body redraw wipes its rows before re-rendering, so don't paint the graph
    // until after the text tabs are drawn — otherwise plotRect-555 fill at the
    // end of the body redraw would erase the graph again.
    clearInstrumentsEnvelopeArea()
    if      (instSubTab === INST_TAB_GEN1) drawInstTabGeneral1(e)
    else if (instSubTab === INST_TAB_GEN2) drawInstTabGeneral2(e)
    else if (instSubTab === INST_TAB_VOL)  drawInstTabVolume(e)
    else if (instSubTab === INST_TAB_PAN)  drawInstTabPanning(e)
    else                                   drawInstTabPitch(e)
    drawInstrumentsEditButton()
    // List redraw wiped col 1 across every row — invalidate, then re-stamp
    // immediately while playing so the live indicator isn't blank for a frame.
    invalidateInstrumentsBlob()
    if (playbackMode !== PLAYMODE_NONE) drawInstrumentsPlayBlobs()
    // Envelope-graph cursor: the panel rebuild wiped any prior hairline; invalidate
    // and re-stamp so the user doesn't see it blink off on tab / inst switches.
    invalidateEnvCursor()
    if (playbackMode !== PLAYMODE_NONE) drawEnvelopeCursor()
}

function instrumentsInput(wo, event) {
    if (event[0] !== 'key_down') return
    const keysym     = event[1]
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 8 : 1

    const n = instrumentsCache ? instrumentsCache.length : 0
    if (n === 0) {
        if (keysym === 'e' || keysym === 'E') {
            requestEditorLaunch('taut_instredit', [fullPathObj.full, VIEW_INSTRMNT, -1])
        }
        return
    }
    if (keysym === '<UP>')        { instListCursor -= moveDelta; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<DOWN>')      { instListCursor += moveDelta; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<PAGE_UP>')   { instListCursor -= INST_LIST_H; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<PAGE_DOWN>') { instListCursor += INST_LIST_H; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<HOME>')      { instListCursor = 0; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    if (keysym === '<END>')       { instListCursor = n - 1; clampInstrumentsCursor(); drawInstrumentsContents(); return }
    // Tab cycling. <LEFT>/<RIGHT> walk subtab, mirroring the IT mouse-tab feel.
    if (keysym === '<LEFT>')      { instSubTab = (instSubTab + INST_TAB_NAMES.length - 1) % INST_TAB_NAMES.length; drawInstrumentsContents(); return }
    if (keysym === '<RIGHT>')     { instSubTab = (instSubTab + 1) % INST_TAB_NAMES.length; drawInstrumentsContents(); return }
    // Number keys 1..5 jump directly to a tab. Convenient when arrow keys are taken.
    if (keysym === '1') { instSubTab = INST_TAB_GEN1; drawInstrumentsContents(); return }
    if (keysym === '2') { instSubTab = INST_TAB_GEN2; drawInstrumentsContents(); return }
    if (keysym === '3') { instSubTab = INST_TAB_VOL;  drawInstrumentsContents(); return }
    if (keysym === '4') { instSubTab = INST_TAB_PAN;  drawInstrumentsContents(); return }
    if (keysym === '5') { instSubTab = INST_TAB_PIT;  drawInstrumentsContents(); return }
    if (keysym === 'e' || keysym === 'E') {
        const e = instrumentsCache[instListCursor]
        if (e) requestEditorLaunch('taut_instredit', [fullPathObj.full, VIEW_INSTRMNT, e.slot])
        return
    }
}

function registerInstrumentsMouse() {
    // Left list
    addPanelMouseRegion(INST_LIST_X, INST_LIST_Y, INST_SEP_X - INST_LIST_X, INST_LIST_H, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            const n = instrumentsCache ? instrumentsCache.length : 0
            const target = instListScroll + (cy - INST_LIST_Y)
            if (target < 0 || target >= n) return
            instListCursor = target
            clampInstrumentsCursor()
            drawInstrumentsContents()
        },
        onWheel: (cy, cx, dy) => {
            instListCursor += dy * 3
            clampInstrumentsCursor()
            drawInstrumentsContents()
        }
    })
    // Right-pane tab strip: clicking a chip selects that tab.
    for (let i = 0; i < INST_TAB_NAMES.length; i++) {
        const idx = i
        const r = instTabRect(i)
        addPanelMouseRegion(r.x, r.y, r.w, 1, {
            onClick: (cy, cx, btn) => {
                if (btn !== 1) return
                instSubTab = idx
                drawInstrumentsContents()
            }
        })
    }
    // Edit button
    addPanelMouseRegion(INST_RIGHT_X, INST_BTN_Y, 22, 1, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            const n = instrumentsCache ? instrumentsCache.length : 0
            const slot = (n > 0) ? instrumentsCache[instListCursor].slot : -1
            requestEditorLaunch('taut_instredit', [fullPathObj.full, VIEW_INSTRMNT, slot])
        }
    })
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// END INSTRUMENTS VIEWER
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// LIVE-PLAY BLOB (Samples / Instruments column 1)
/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Per-row marker painted in column 1 of the Samples / Instruments list while a
// voice is actively sounding the corresponding sample / instrument. The glyph
// (sym.blob1..blob10) tracks the loudest active voice that references the row;
// sym.blob0 wipes the cell. The glyph FOREGROUND is colour-coded by polyphony —
// the number of notes (live voices + NNA ghosts) currently sounding the row —
// via a green→yellow→orange→red heat ramp. Per-row last-drawn (level, colour
// bucket) is cached so the per-frame repaint only redraws rows that changed —
// mirrors the bounded-work pattern used by drawVoiceMeters().

const smpBlobPrev  = new Array(SMP_LIST_H).fill(-1)
const instBlobPrev = new Array(INST_LIST_H).fill(-1)

// Polyphony heat ramp for the blob foreground: more simultaneously-sounding notes → hotter.
const colBlobPoly1 = 34   // blue  — 1 note
const colBlobPoly2 = 76   // green  — 2 note
const colBlobPoly3 = 230  // yellow — 3 notes
const colBlobPoly4 = 221  // orange — 4 notes
const colBlobPoly5 = 211  // red    — 5+ notes
const blobPolyCols = [colBlobPoly1, colBlobPoly2, colBlobPoly3, colBlobPoly4, colBlobPoly5]

// Note count → ramp bucket: 0 (silent), 1..3 verbatim, 4+ saturates at 4.
function blobPolyBucket(count) {
    if (count <= 0) return 0
    return count >= 5 ? 5 : count
}

// getActiveNoteCounts (the foreground+ghost polyphony API) ships with this feature; on an
// un-rebuilt host VM it's absent and blobs fall back to the plain number-column colour.
const hasNoteCountAPI = (typeof audio !== 'undefined' && typeof audio.getActiveNoteCounts === 'function')

function invalidateSamplesBlob()     { for (let i = 0; i < smpBlobPrev.length;  i++) smpBlobPrev[i]  = -1 }
function invalidateInstrumentsBlob() { for (let i = 0; i < instBlobPrev.length; i++) instBlobPrev[i] = -1 }

// Walks the live voice slots and returns {instrumentId → loudest effective volume}.
// Silent / inactive voices are skipped. Volumes are 0.0..1.0.
function activeInstVolumes() {
    const out = {}
    const numVox = (song && song.numVoices) ? song.numVoices : NUM_VOICES
    for (let v = 0; v < numVox; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        const inst = audio.getVoiceInstrument(PLAYHEAD, v)
        if (!inst) continue
        const vol = audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0
        if (!(vol > 0)) continue
        if (!(inst in out) || out[inst] < vol) out[inst] = vol
    }
    return out
}

// 0.0 → 0 (clear); (0, 1] → 1..10 via ceil so the quietest audible voice still shows blob1.
function blobLevelForVolume(v) {
    if (!(v > 0)) return 0
    let lvl = Math.ceil(v * 10)
    if (lvl < 1)  lvl = 1
    if (lvl > 10) lvl = 10
    return lvl
}

function drawSamplesPlayBlobs() {
    if (currentPanel !== VIEW_SAMPLES || !samplesCache) return
    const playing  = (playbackMode !== PLAYMODE_NONE)
    const instVols = playing ? activeInstVolumes() : null
    const counts   = (playing && hasNoteCountAPI) ? audio.getActiveNoteCounts(PLAYHEAD) : null
    const n = samplesCache.length
    for (let row = 0; row < SMP_LIST_H; row++) {
        const idx = smpListScroll + row
        let level = 0, poly = 0
        if (playing && idx < n) {
            const ub = samplesCache[idx].usedBy
            let m = 0, c = 0
            for (let j = 0; j < ub.length; j++) {
                const w = instVols[ub[j]] || 0
                if (w > m) m = w
                if (counts) c += counts[ub[j]] || 0
            }
            level = blobLevelForVolume(m)
            poly  = blobPolyBucket(c)
        }
        // Ghost-only rows have notes sounding but no exposed foreground volume — floor the glyph
        // to blob1 so the colour-coded marker is still visible.
        if (poly > 0 && level === 0) level = 1
        const key = level * 8 + poly   // cache combines glyph level + colour bucket
        if (smpBlobPrev[row] === key) continue
        const isSel = (idx === smpListCursor)
        const back  = isSel ? colSmpListSel : colSmpListBg
        const fg    = (poly > 0) ? blobPolyCols[poly - 1] : colSmpListNumFg
        con.move(SMP_LIST_Y + row, SMP_LIST_X)
        con.color_pair(fg, back)
        print(sym['blob' + level])
        smpBlobPrev[row] = key
    }
}

function drawInstrumentsPlayBlobs() {
    if (currentPanel !== VIEW_INSTRMNT || !instrumentsCache) return
    const playing  = (playbackMode !== PLAYMODE_NONE)
    const instVols = playing ? activeInstVolumes() : null
    const counts   = (playing && hasNoteCountAPI) ? audio.getActiveNoteCounts(PLAYHEAD) : null
    const n = instrumentsCache.length
    for (let row = 0; row < INST_LIST_H; row++) {
        const idx = instListScroll + row
        let level = 0, poly = 0
        if (playing && idx < n) {
            const slot = instrumentsCache[idx].slot
            level = blobLevelForVolume(instVols[slot] || 0)
            poly  = blobPolyBucket(counts ? (counts[slot] || 0) : 0)
        }
        // Ghost-only rows sound but expose no foreground volume — floor to blob1 so the colour shows.
        if (poly > 0 && level === 0) level = 1
        const key = level * 8 + poly
        if (instBlobPrev[row] === key) continue
        const isSel = (idx === instListCursor)
        const back  = isSel ? colInstListSel : colInstListBg
        const fg    = (poly > 0) ? blobPolyCols[poly - 1] : colInstListNumFg
        con.move(INST_LIST_Y + row, INST_LIST_X)
        con.color_pair(fg, back)
        print(sym['blob' + level])
        instBlobPrev[row] = key
    }
}

// ── Playback-position cursor (sample waveform + vol/pan/pitch envelope graphs) ───────────────
// Vertical hairline glyph painted in the text layer at the column closest to the live
// playback position of EVERY voice that's sounding the displayed sample / instrument — one
// hairline per voice. Sub-pixel offset within the cell picks between vhairline1..vhairline7
// (vhairlineN draws the line N pixels from the cell's left edge; vhairline4 is the cell centre
// on a 7-px cell). When several voices want the same text column they are resolved quiet→loud,
// so the loudest voice's hairline wins the shared column.

const colPlayCursor = 215 // same hue used for the timeline play row

// Last-drawn state so each frame only repaints when something actually moved. Now that we draw
// one hairline per voice, *Cols is the list of text columns currently stamped and *Sig is a
// signature of the resolved per-column glyphs (so we can detect when any hairline moved).
// envCursorPrev{Tab,Inst}: the (tab, instrument-slot) the env hairlines belong to.
let envCursorPrevCols = []
let envCursorPrevSig  = ''
let envCursorPrevTab  = -1
let envCursorPrevInst = -1
let smpCursorPrevCols = []
let smpCursorPrevSig  = ''
let smpCursorPrevIdx  = -1

function invalidateEnvCursor() { envCursorPrevCols = []; envCursorPrevSig = ''; envCursorPrevTab = -1; envCursorPrevInst = -1 }
function invalidateSmpCursor() { smpCursorPrevCols = []; smpCursorPrevSig = ''; smpCursorPrevIdx = -1 }

// Map a pixel-space X coordinate to (text-column, vhairline glyph) such that the glyph's
// drawn line lands within ±½ a sub-pixel of xPix. Cell pixels are 1-indexed positions
// (left edge = pos 1), matching the vhairlineN naming.
function pixelToHairline(xPix) {
    const col0 = Math.floor(xPix / CELL_PW)
    let pos    = xPix - col0 * CELL_PW + 1   // 1..CELL_PW
    if (pos < 1) pos = 1
    if (pos > 7) pos = 7
    return { col: col0 + 1, hair: sym['vhairline' + pos] }
}

// All active voices currently bound to `slot` (1..255), as {voice, vol}. Empty if none.
function activeVoicesForInstSlot(slot) {
    const out = []
    const numVox = (song && song.numVoices) ? song.numVoices : NUM_VOICES
    for (let v = 0; v < numVox; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        if (audio.getVoiceInstrument(PLAYHEAD, v) !== slot) continue
        out.push({ voice: v, vol: audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0 })
    }
    return out
}

// All active voices whose instrument is in `usedBy` (the inst-slot list attached to a
// samplesCache entry — multiple instruments may share one sample), as {voice, vol}.
function activeVoicesForSampleEntry(usedBy) {
    const out = []
    const numVox = (song && song.numVoices) ? song.numVoices : NUM_VOICES
    for (let v = 0; v < numVox; v++) {
        if (!audio.getVoiceActive(PLAYHEAD, v)) continue
        const inst = audio.getVoiceInstrument(PLAYHEAD, v)
        if (usedBy.indexOf(inst) < 0) continue
        out.push({ voice: v, vol: audio.getVoiceEffectiveVolume(PLAYHEAD, v) || 0 })
    }
    return out
}

// Collapse a list of {col, hair, vol} hairline hits into a per-column glyph map, resolving
// shared columns quiet→loud so the loudest voice's hairline wins. Returns { cols, colMap, sig }
// where cols is the sorted column list, colMap maps col→glyph, and sig detects visual changes.
function resolveHairlineHits(hits) {
    hits.sort((a, b) => a.vol - b.vol)
    const colMap = {}
    for (let i = 0; i < hits.length; i++) colMap[hits[i].col] = hits[i].hair
    const cols = Object.keys(colMap).map(Number).sort((a, b) => a - b)
    let sig = ''
    for (let i = 0; i < cols.length; i++) sig += cols[i] + ':' + colMap[cols[i]] + ','
    return { cols, colMap, sig }
}

// Pull the envelope object + JSR223 getter pair for the active inst sub-tab. Returns null
// for tabs without a graph (Gen.1 / Gen.2).
function envBundleForCurrentTab(e) {
    if (instSubTab === INST_TAB_VOL) return { env: e.decoded.volEnv,
        idxFn: 'getVoiceEnvVolIndex',   timeFn: 'getVoiceEnvVolTime' }
    if (instSubTab === INST_TAB_PAN) return { env: e.decoded.panEnv,
        idxFn: 'getVoiceEnvPanIndex',   timeFn: 'getVoiceEnvPanTime' }
    if (instSubTab === INST_TAB_PIT) return { env: e.decoded.pfEnv,
        idxFn: 'getVoiceEnvPitchIndex', timeFn: 'getVoiceEnvPitchTime' }
    return null
}

// First/last text row covered by the inst-tab envelope graph. Mirrors instEnvelopeRect()
// in text-coord units so we know which rows to stamp / erase the hairline on.
function envGraphTextRows() {
    const graphRowY = INST_BODY_Y + 7
    return { y0: graphRowY, y1: INST_BTN_Y - 1 }
}

// Same idea for the Samples-tab waveform.
function smpWaveTextRows() {
    return { y0: SMP_WAVE_Y, y1: SMP_BTN_Y - 1 }
}

function paintEnvCursorAt(col, hairSym) {
    const rng = envGraphTextRows()
    con.color_pair(colPlayCursor, 255)
    for (let y = rng.y0; y <= rng.y1; y++) {
        con.move(y, col)
        print(hairSym)
    }
}

function eraseEnvCursorIfAny() {
    if (envCursorPrevCols.length === 0) return
    const rng = envGraphTextRows()
    con.color_pair(colInstValue, 255)
    for (let k = 0; k < envCursorPrevCols.length; k++) {
        const col = envCursorPrevCols[k]
        for (let y = rng.y0; y <= rng.y1; y++) {
            con.move(y, col)
            print(' ')
        }
    }
    envCursorPrevCols = []
    envCursorPrevSig  = ''
    envCursorPrevTab  = -1
    envCursorPrevInst = -1
}

function paintSmpCursorAt(col, hairSym) {
    const rng = smpWaveTextRows()
    con.color_pair(colPlayCursor, 255)
    for (let y = rng.y0; y <= rng.y1; y++) {
        con.move(y, col)
        print(hairSym)
    }
}

function eraseSmpCursorIfAny() {
    if (smpCursorPrevCols.length === 0) return
    const rng = smpWaveTextRows()
    con.color_pair(colSmpPropValue, 255)
    for (let k = 0; k < smpCursorPrevCols.length; k++) {
        const col = smpCursorPrevCols[k]
        for (let y = rng.y0; y <= rng.y1; y++) {
            con.move(y, col)
            print(' ')
        }
    }
    smpCursorPrevCols = []
    smpCursorPrevSig  = ''
    smpCursorPrevIdx  = -1
}

function drawEnvelopeCursor() {
    if (currentPanel !== VIEW_INSTRMNT) { invalidateEnvCursor(); return }
    if (!instrumentsCache || instrumentsCache.length === 0) { eraseEnvCursorIfAny(); return }
    const e = instrumentsCache[instListCursor]
    if (!e) { eraseEnvCursorIfAny(); return }
    const bundle = envBundleForCurrentTab(e)
    // Gen.1 / Gen.2 have no envelope graph — wipe any stale hairline and bail.
    if (!bundle) { eraseEnvCursorIfAny(); return }
    const env = bundle.env
    const lastIdx = (env.terminatorIdx >= 0) ? env.terminatorIdx : (env.nodes.length - 1)
    if (lastIdx < 0) { eraseEnvCursorIfAny(); return }

    const hits = []
    if (playbackMode !== PLAYMODE_NONE) {
        // Cumulative time at each node (mirrors xs[] in drawEnvelopeGraph) — shared by all voices.
        let acc = 0
        const xs = new Array(lastIdx + 1)
        xs[0] = 0
        for (let i = 1; i <= lastIdx; i++) { acc += env.nodes[i - 1].durSec; xs[i] = acc }
        const totalTime = Math.max(acc, 1e-6)
        const r = instEnvelopeRect()
        const voices = activeVoicesForInstSlot(e.slot)
        for (let k = 0; k < voices.length; k++) {
            const v = voices[k].voice
            const envIdx  = audio[bundle.idxFn](PLAYHEAD, v)
            const envTime = audio[bundle.timeFn](PLAYHEAD, v)
            if (envIdx < 0) continue
            const ei = Math.max(0, Math.min(lastIdx, envIdx))
            const segLen = (ei < lastIdx) ? env.nodes[ei].durSec : 0
            const tInto  = Math.max(0, Math.min(segLen, envTime))
            const elapsed = xs[ei] + tInto
            const xPix = r.x + Math.min(r.w - 1, Math.max(0, ((elapsed / totalTime) * (r.w - 1)) | 0))
            const sel = pixelToHairline(xPix)
            hits.push({ col: sel.col, hair: sel.hair, vol: voices[k].vol })
        }
    }
    const res = resolveHairlineHits(hits)

    if (res.sig === envCursorPrevSig &&
        envCursorPrevTab  === instSubTab &&
        envCursorPrevInst === e.slot) return

    eraseEnvCursorIfAny()
    if (res.cols.length > 0) {
        for (let i = 0; i < res.cols.length; i++) paintEnvCursorAt(res.cols[i], res.colMap[res.cols[i]])
        envCursorPrevCols = res.cols
        envCursorPrevSig  = res.sig
        envCursorPrevTab  = instSubTab
        envCursorPrevInst = e.slot
    }
}

function drawSampleCursor() {
    if (currentPanel !== VIEW_SAMPLES) { invalidateSmpCursor(); return }
    if (!samplesCache || samplesCache.length === 0) { eraseSmpCursorIfAny(); return }
    const s = samplesCache[smpListCursor]
    if (!s || s.len <= 0) { eraseSmpCursorIfAny(); return }

    const hits = []
    if (playbackMode !== PLAYMODE_NONE) {
        const r = sampleWaveformRect()
        const voices = activeVoicesForSampleEntry(s.usedBy)
        for (let k = 0; k < voices.length; k++) {
            const pos = audio.getVoiceSamplePos(PLAYHEAD, voices[k].voice)
            if (pos < 0) continue
            const norm = Math.max(0, Math.min(1, pos / s.len))
            const xPix = r.x + Math.min(r.w - 1, Math.max(0, (norm * (r.w - 1)) | 0))
            const sel = pixelToHairline(xPix)
            hits.push({ col: sel.col, hair: sel.hair, vol: voices[k].vol })
        }
    }
    const res = resolveHairlineHits(hits)

    if (res.sig === smpCursorPrevSig && smpCursorPrevIdx === smpListCursor) return

    eraseSmpCursorIfAny()
    if (res.cols.length > 0) {
        for (let i = 0; i < res.cols.length; i++) paintSmpCursorAt(res.cols[i], res.colMap[res.cols[i]])
        smpCursorPrevCols = res.cols
        smpCursorPrevSig  = res.sig
        smpCursorPrevIdx  = smpListCursor
    }
}

const panelSamples  = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, samplesInput,    drawSamplesContents,    undefined, ()=>{})
const panelInstrmnt = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, instrumentsInput, drawInstrumentsContents, undefined, ()=>{})
const panelProject  = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, projectInput,    drawProjectContents,    undefined, ()=>{})
const panelFile     = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, externalPanelInput, makeExternalPanelDraw('taut_fileop'), undefined, ()=>{})

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

// Push in-memory song.patterns to the audio adapter if local edits haven't been
// uploaded yet. Called by every start-play entry point so playback always reflects
// the current editor state (e.g. after Retune).
function reuploadPatternsIfNeeded() {
    if (!patternsOutOfSync) return
    const patBytes = new Array(PATTERN_SIZE)
    for (let p = 0; p < song.numPats; p++) {
        const ptn = song.patterns[p]
        for (let k = 0; k < PATTERN_SIZE; k++) patBytes[k] = ptn[k] & 0xFF
        audio.uploadPattern(p, patBytes)
    }
    patternsOutOfSync = false
}

// Adjust the live tick rate by `delta`. The engine still honours 'A' (set speed) effects,
// which will overwrite this value when their row is hit during playback.
function nudgeTickRate(delta) {
    const cur = audio.getTickRate(PLAYHEAD) | 0
    const next = Math.max(1, Math.min(255, cur + delta))
    if (next === cur) return
    audio.setTickRate(PLAYHEAD, next)
    drawAlwaysOnElems()
}

function startPlaySong() {
    restoreFullSongParams()
    reuploadPatternsIfNeeded()
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
    reuploadPatternsIfNeeded()
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
    reuploadPatternsIfNeeded()
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
    reuploadPatternsIfNeeded()
    audio.stop(PLAYHEAD)
    audio.setBPM(PLAYHEAD, song.bpm)
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
    reuploadPatternsIfNeeded()
    audio.stop(PLAYHEAD)
    audio.setBPM(PLAYHEAD, song.bpm)
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
    clearVoiceMeters()
    // updatePlayback no longer fires after this point — paint the final clear
    // pass ourselves so stale blobs / hairlines don't linger on Samples / Instruments.
    drawSamplesPlayBlobs()
    drawInstrumentsPlayBlobs()
    tickFunkWaveform()   // restore the stored waveform now that funk repeat has stopped
    drawSampleCursor()
    drawEnvelopeCursor()
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
        clearVoiceMeters()
        // playbackMode is NONE now → these paint a final blob0 / clear-cursor pass.
        drawSamplesPlayBlobs()
        drawInstrumentsPlayBlobs()
        tickFunkWaveform()   // restore the stored waveform now that playback has stopped
        drawSampleCursor()
        drawEnvelopeCursor()
        return
    }

    drawVoiceMeters()
    drawSamplesPlayBlobs()
    drawInstrumentsPlayBlobs()
    tickFunkWaveform()   // realtime funk-repeat overlay (no-op unless funking this sample)
    drawSampleCursor()
    drawEnvelopeCursor()

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
            scrollOrdersTo(cueIdx)
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
    scrollRow = centerScroll(cursorRow, scrollRow, PTNVIEW_HEIGHT, ROWS_PER_PAT)
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
// HELP POPUP
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

const HELP_POPUP_W   = SCRW - 8
const HELP_POPUP_X   = ((SCRW - HELP_POPUP_W) / 2 | 0) + 1
const HELP_POPUP_Y   = 5
const HELP_POPUP_H   = SCRH - HELP_POPUP_Y - 1
const HELP_CONTENT_X = HELP_POPUP_X + 2
const HELP_CONTENT_Y = HELP_POPUP_Y + 2
const HELP_CONTENT_W = HELP_POPUP_W - 6
const HELP_CONTENT_H = HELP_POPUP_H - 3

// Pre-typeset every panel's help text. taut_helpmsg.js reads HELPMSG_WIDTH for
// the wrap width and stores ready-to-print display strings into MSG_BY_TABS.
_G.TAUT.HELPMSG_WIDTH = HELP_CONTENT_W
_G.shell.execute("taut_helpmsg")

function openHelpPopup() {
    const helpmsg = _G.TAUT.HELPMSG || {}
    const lines   = (helpmsg.MSG_BY_TABS && helpmsg.MSG_BY_TABS[currentPanel]) || ['']
    const colText = helpmsg.COL_TEXT || colWHITE

    win.showDialog({
        title: `Help: ${PANEL_NAMES[currentPanel]}`,
        drawFrame: popupDrawFrame,
        colours: popupColours,
        list: {
            items: lines.map(l => ({ label: l })),
            bg: colPopupBack,
            height: HELP_CONTENT_H,
            width: HELP_CONTENT_W+4,
            selectable: () => false,
            renderItem: (ctx) => {
                con.color_pair(colText, ctx.listBg)
                con.move(ctx.y, ctx.x)
                const line = (ctx.item.label != null ? ctx.item.label : '')
                print(line.padEnd(ctx.w, ' ').substring(0, ctx.w))
            },
        },
        buttons: [{ label: 'OK', action: 'ok', default: true }],
        onKey: (ks, _shift, ctx) => {
            if (ks === '!' || ks === 'q') { ctx.close({ action: 'cancel' }); return true }
            return false
        },
    })
    drawAll()
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// SHARED POPUP CHROME
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Custom window-frame painter passed to wintex showDialog as `drawFrame`.
// Paints a title bar at the top row, then fills the rest of the popup with
// `colPopupBack` (including the bottom row, so the spacing row below wintex's
// button strip stays painted).
const popupDrawFrame = (wo) => {
    // draw header
    con.move(wo.y, wo.x)
    con.color_pair(colTabBarOrn, colTabBarBack)
    print(`\u00FB`.repeat(wo.width))

    // imprint title
    let titleWidth = wo.title.length
    con.move(wo.y, wo.x + (((wo.width - titleWidth - 2) & 254) >>> 1))
    con.color_pair(colTabInactive, colTabBarBack); print(` ${wo.title} `)

    // fill content area (title row already painted above)
    for (let r = 1; r < wo.height; r++) {
        con.move(wo.y + r, wo.x)
        con.color_pair(230, colPopupBack)
        print(' '.repeat(wo.width))
    }
}

// Standard colour palette shared by every taut popup so wintex's defaults blend
// with taut's popup chrome.
const popupColours = {
    // fg:        colStatus,
    // bg:        colPopupBack,
    // fieldBg:   240,
    // dimFg:     colVoiceHdrMuted,
    // hlFg:      colWHITE,
    // focusBg:   colHighlight,
    // listBg:    colPopupBack,
    // listSelBg: colHighlight,
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
    const messageLines = ['Exit Microtone?']
    if (hasUnsavedChanges) messageLines.push('You have unsaved changes.')

    const res = win.showDialog({
        title: 'Quit?',
        drawFrame: popupDrawFrame,
        colours: popupColours,
        message: messageLines,
        buttons: [
            { label: 'Yes', action: 'yes' },
            { label: 'No',  action: 'no', default: true },
        ],
        onKey: (ks, _shift, ctx) => {
            if (ks === 'y' || ks === 'Y') { ctx.close({ action: 'yes' }); return true }
            if (ks === 'n' || ks === 'N') { ctx.close({ action: 'no' });  return true }
            return false
        },
    })

    const result = (res.action === 'yes')
    if (!result) drawAll()
    return result
}

function openGotoPopup() {
    const prompts = ['Cue (hex):', 'Cue (hex):', 'Pattern (hex):']
    const promptStr = prompts[currentPanel] || 'Number:'

    const res = win.showDialog({
        title: 'Go To',
        drawFrame: popupDrawFrame,
        colours: popupColours,
        fields: [{ label: promptStr, width: 4, maxLength: 3 }],
        buttons: [
            { label: 'OK',     action: 'ok' },
            { label: 'Cancel', action: 'cancel' },
        ],
    })
    if (res.action === 'ok' && res.values[0]) {
        const n = parseInt(res.values[0], 16)
        if (!isNaN(n)) applyGoto(n)
    }
    drawAll()
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// RETUNE POPUP
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

function openRetunePopup() {
    const entries = Object.values(pitchTablePresets).sort((a, b) => a.index - b.index)
    const n = entries.length

    // Foreground colour by tuning type (preset.t):
    //   'd' = 12-tone family, 'M' = Macrotonal, 'm' = microtonal, '' = Raw.
    const tuningTypeColour = { d: 230, M: colPan, m: colInst, '': colStatus }

    const methodLabels = {
        pitch:    'Nearest-note',
        delta:    'Nearest-delta',
        cadence:  'Nearest-cadence',
        harmonic: 'Nearest-harmonic', // this thing is cadence-aware (hopefully)
    }
    const methodCycle = ['pitch', 'harmonic', 'delta'/*, 'cadence'*/]
    let method = 'pitch'

    let selIdx = entries.findIndex(p => p.index === PITCH_PRESET_IDX)
    if (selIdx < 0) selIdx = 0

    const items = entries.map(e => ({ label: e.name, preset: e }))
    const listH = Math.min(n, 13)
    const messageLines = [
        'Select new tuning preset:',
        'Method: ' + methodLabels[method],
    ]

    const res = win.showDialog({
        title: 'Retune',
        drawFrame: popupDrawFrame,
        colours: popupColours,
        message: messageLines,
        list: {
            items: items,
            height: listH,
            width: 36,
            cursor: selIdx,
            renderItem: (ctx) => {
                const e = ctx.item.preset
                const isCur = (e.index === PITCH_PRESET_IDX)
                const fore = (e.t in tuningTypeColour) ? tuningTypeColour[e.t] : 230
                const useFg = (ctx.isCursor && ctx.focused) ? colWHITE : fore
                const useBg = (ctx.isCursor && ctx.focused) ? colHighlight : ctx.listBg
                con.color_pair(useFg, useBg)
                con.move(ctx.y, ctx.x)
                const marker = isCur ? sym.playhead : ' '
                let label = `${marker} ${e.name}`
                if (label.length > ctx.w) label = label.substring(0, ctx.w)
                else label = label.padEnd(ctx.w, ' ')
                print(label)
            },
        },
        buttons: [
            { label: 'OK',     action: 'ok' },
            { label: 'Cancel', action: 'cancel' },
        ],
        onKey: (ks, _shift, ctx) => {
            if (ks === 'm' || ks === 'M') {
                method = methodCycle[(methodCycle.indexOf(method) + 1) % methodCycle.length]
                messageLines[1] = 'Method: ' + methodLabels[method]
                ctx.render()
                return true
            }
            return false
        },
    })

    if (res.action === 'ok' && res.listItem) {
        const target = res.listItem.preset
        if (target && target.index !== PITCH_PRESET_IDX) {
            retuneAllPatterns(target.index, method)
        }
    }

    drawAll()
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MIXER FLAGS POPUP
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

function openFlagsPopup() {
    const toneNames = ['Linear pitch', 'Amiga pitch', 'Linear freq']
    const intpNames = ['Default', 'None', 'A500', 'A1200', 'SNES', 'DPCM']

    let toneMode = initialTrackerMixerflags & 3
    let intpMode = (initialTrackerMixerflags >>> 2) & 7
    if (toneMode >= toneNames.length) toneMode = 0
    if (intpMode >= intpNames.length) intpMode = 0

    // Build list rows: headers + selectable radio options.
    const items = []
    items.push({ label: 'Tone Mode:', kind: 'header' })
    toneNames.forEach((nm, i) => items.push({ label: nm, kind: 'tone', idx: i }))
    items.push({ label: '', kind: 'spacer' })
    items.push({ label: 'Interpolation:', kind: 'header' })
    intpNames.forEach((nm, i) => items.push({ label: nm, kind: 'intp', idx: i }))

    const res = win.showDialog({
        title: 'Mixer Flags',
        drawFrame: popupDrawFrame,
        colours: popupColours,
        list: {
            items: items,
            height: items.length,
            width: 22,
            showScrollbar: false,
            selectable: (it) => it.kind === 'tone' || it.kind === 'intp',
            renderItem: (ctx) => {
                const it = ctx.item
                con.move(ctx.y, ctx.x)
                if (it.kind === 'header') {
                    con.color_pair(colStatus, colPopupBack)
                    print(it.label.padEnd(ctx.w, ' ').substring(0, ctx.w))
                    return
                }
                if (it.kind === 'spacer') {
                    con.color_pair(colStatus, colPopupBack)
                    print(' '.repeat(ctx.w))
                    return
                }
                const isChecked = (it.kind === 'tone')
                    ? (toneMode === it.idx)
                    : (intpMode === it.idx)
                const useBg = (ctx.isCursor && ctx.focused) ? colHighlight : colPopupBack
                const useFg = isChecked ? colVoiceHdr : colWHITE
                con.color_pair(useFg, useBg)
                const line = ' ' + (isChecked ? sym.ticked : sym.unticked) + ' ' + it.label
                print(line.padEnd(ctx.w, ' ').substring(0, ctx.w))
            },
            // Space and left-click toggle the radio; Enter commits via OK.
            onActivate: (item, _idx, key) => {
                if (key === ' ' || key === 'click') {
                    if      (item.kind === 'tone') toneMode = item.idx
                    else if (item.kind === 'intp') intpMode = item.idx
                    return null
                }
                if (key === '\n') return 'ok'
                return null
            },
        },
        buttons: [
            { label: 'OK',     action: 'ok' },
            { label: 'Cancel', action: 'cancel' },
        ],
    })

    if (res.action === 'ok') {
        const newFlags = (initialTrackerMixerflags & ~0x1F) |
                         (toneMode & 3) | ((intpMode & 7) << 2)
        if (newFlags !== initialTrackerMixerflags) {
            initialTrackerMixerflags = newFlags
            audio.setTrackerMixerFlags(PLAYHEAD, newFlags)
            hasUnsavedChanges = true
        }
    }

    drawAll()
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// INLINE HEX EDITOR
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Overlay an editable hex field at (y, x) with `digits` digits, pre-filled from `initialValue`.
// Returns the new integer on commit, or null on cancel. Reusable for pattern-grid edits.
function openInlineHexEdit(y, x, digits, initialValue) {
    let buf = (initialValue >>> 0).toString(16).toUpperCase()
    if (buf.length > digits) buf = buf.substring(buf.length - digits)
    buf = buf.padStart(digits, '0')

    let cur = 0
    let cancelled = false
    let done = false

    const repaint = () => {
        con.move(y, x)
        con.color_pair(colWHITE, colHighlight)
        print(' $' + buf + ' ')
        con.move(y, x + 2 + cur)
        con.color_pair(colBLACK, colWHITE)
        print(buf[cur])
        con.color_pair(colStatus, 255)
    }

    repaint()
    let eventJustReceived = true

    // Field spans " $XX " — onClick on a digit moves the cursor there.
    // Outside-click commits (Enter); right-click cancels.
    // Region order matters: dispatchMouseEvent searches in reverse, so the
    // field region (registered last) is tested before the catch-all.
    pushMousePopup([
        { x: 1, y: 1, w: SCRW, h: SCRH, onClick: (cy, cx, btn) => {
            if (btn === 1) done = true
            else if (btn === 2) { cancelled = true; done = true }
        }},
        { x: x + 2, y: y, w: digits, h: 1, onClick: (cy, cx, btn) => {
            if (btn === 1) { cur = cx - (x + 2); repaint() }
            else if (btn === 2) { cancelled = true; done = true }
        }, onWheel: (cy, cx, dy) => {
            // Wheel adjusts the digit under the cursor.
            const digit = parseInt(buf[cur], 16)
            const next = (digit + (dy < 0 ? 1 : -1) + 16) & 0xF
            buf = buf.substring(0, cur) + next.toString(16).toUpperCase() + buf.substring(cur + 1)
            repaint()
        }},
    ])

    while (!done) {
        input.withEvent(ev => {
            if (eventJustReceived && (ev[0] === 'key_down' || ev[0] === 'mouse_down')) {
                eventJustReceived = false; return
            }
            if (dispatchMouseEvent(ev)) return
            if (ev[0] !== 'key_down') return
            if (1 !== ev[2]) return
            const ks = ev[1]

            if (ks === '<ESC>') { cancelled = true; done = true; return }
            if (ks === '\n')    { done = true; return }
            if (ks === '<LEFT>'  && cur > 0)          { cur--; repaint(); return }
            if (ks === '<RIGHT>' && cur < digits - 1) { cur++; repaint(); return }
            if (ks === '<HOME>')                      { cur = 0; repaint(); return }
            if (ks === '<END>')                       { cur = digits - 1; repaint(); return }
            if (ks.length === 1 && '0123456789abcdefABCDEF'.includes(ks)) {
                buf = buf.substring(0, cur) + ks.toUpperCase() + buf.substring(cur + 1)
                if (cur < digits - 1) cur++
                else done = true
                repaint()
                return
            }
        })
    }

    popMousePopup()

    return cancelled ? null : parseInt(buf, 16)
}

clampCursor(); clampVoice(); clampCue(); clampOrdersHoriz(); clampPatternIdx(); clampPatternGrid()
drawAll()

resetAudioDevice()
taud.uploadTaudFile(fullPathObj.full, currentSongIndex, PLAYHEAD)
refreshSamplesCache()
audio.setMasterVolume(PLAYHEAD, 255)
audio.setMasterPan(PLAYHEAD, 128)
let initialTrackerMixerflags = audio.getTrackerMixerFlags(PLAYHEAD)
let initialGlobalVolume = audio.getSongGlobalVolume(PLAYHEAD)
let initialMixingVolume = audio.getSongMixingVolume(PLAYHEAD)

function isExternalPanel(p) {
    return p === VIEW_FILE
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MOUSE INPUT
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Region registry. Coordinates are 1-indexed text cell positions. Each region:
//   {x, y, w, h, onClick(cy, cx, btn, ev)?, onWheel(cy, cx, dy, ev)?, onRelease(...)?}
// MOUSE_GLOBAL  — tabs + transport, live for the whole session.
// MOUSE_PANEL   — per-panel viewport handlers, cleared whenever the panel changes.
// MOUSE_POPUP_STACK — popups push their own region set on open and pop on close;
//                     while non-empty, only the topmost set receives mouse events.
const MOUSE_GLOBAL = []
const MOUSE_PANEL  = []
const MOUSE_POPUP_STACK = []

// Wrap push/pop so closing a popup also drops any onHoverLeave that would otherwise
// be invoked against the popup's stale regions on the next mouse move.
//
// When the pop happens with a mouse button still held, the popup was almost certainly
// closed by a click. We arm `swallowResidualClick` so the trailing mouse_up (and any
// echo mouse_down from that same physical click) doesn't leak into the panel that the
// popup was covering. A keyboard close leaves no button held, so this is a no-op.
let swallowResidualClick = false
function pushMousePopup(regions) { MOUSE_POPUP_STACK.push(regions); lastHoveredRegion = null }
function popMousePopup() {
    MOUSE_POPUP_STACK.pop()
    lastHoveredRegion = null
    if ((sys.peek(-37) & 0x07) !== 0) swallowResidualClick = true
}

function pixelToCell(px, py) {
    return [(py / CELL_PH | 0) + 1, (px / CELL_PW | 0) + 1]  // [cy, cx], 1-indexed
}

function regionHits(r, cy, cx) {
    return cy >= r.y && cy < r.y + r.h && cx >= r.x && cx < r.x + r.w
}

// Dispatch a mouse event to the topmost matching region. Returns true if handled.
// `mouse_move` also fires onHoverLeave for the previously-hovered region so popups can
// repaint un-hovered buttons without tracking that themselves.
let lastHoveredRegion = null
function dispatchMouseEvent(event) {
    const t = event[0]
    if (t !== 'mouse_down' && t !== 'mouse_wheel' && t !== 'mouse_up' && t !== 'mouse_move') return false

    // Eat residual events from the click that just closed a popup. The flag is armed
    // by popMousePopup when a button was still held at pop time; it clears on the
    // matching mouse_up so the next fresh press goes through normally.
    if (swallowResidualClick && MOUSE_POPUP_STACK.length === 0) {
        if (t === 'mouse_up')   { swallowResidualClick = false; return true }
        if (t === 'mouse_down') { return true }
        if (t === 'mouse_move') { return true }
        // mouse_wheel passes through — it's its own gesture, not part of the closing click
    }

    const [cy, cx] = pixelToCell(event[1], event[2])
    const pool = (MOUSE_POPUP_STACK.length > 0)
        ? MOUSE_POPUP_STACK[MOUSE_POPUP_STACK.length - 1]
        : MOUSE_PANEL.concat(MOUSE_GLOBAL)

    if (t === 'mouse_move') {
        let hit = null
        for (let i = pool.length - 1; i >= 0; i--) {
            const r = pool[i]
            if (regionHits(r, cy, cx) && (r.onHover || r.onHoverLeave)) { hit = r; break }
        }
        if (hit !== lastHoveredRegion) {
            if (lastHoveredRegion && lastHoveredRegion.onHoverLeave) lastHoveredRegion.onHoverLeave()
            lastHoveredRegion = hit
        }
        if (hit && hit.onHover) { hit.onHover(cy, cx, event); return true }
        return false
    }

    for (let i = pool.length - 1; i >= 0; i--) {
        const r = pool[i]
        if (!regionHits(r, cy, cx)) continue
        if (t === 'mouse_down'  && r.onClick)   { r.onClick(cy, cx, event[3], event); return true }
        if (t === 'mouse_wheel' && r.onWheel)   { r.onWheel(cy, cx, event[3], event); return true }
        if (t === 'mouse_up'    && r.onRelease) { r.onRelease(cy, cx, event[3], event); return true }
    }
    return false
}

function clearPanelMouseRegions() { MOUSE_PANEL.length = 0 }
function addPanelMouseRegion(x, y, w, h, handlers)  { MOUSE_PANEL.push(Object.assign({x, y, w, h}, handlers)) }
function addGlobalMouseRegion(x, y, w, h, handlers) { MOUSE_GLOBAL.push(Object.assign({x, y, w, h}, handlers)) }

// Apply the same panel-switch logic the Tab key path uses.
function switchToPanel(newPanel) {
    if (newPanel === currentPanel) return
    const wasTimeline = (currentPanel === VIEW_TIMELINE)
    const wasSamples  = (currentPanel === VIEW_SAMPLES)
    const wasInstrmnt = (currentPanel === VIEW_INSTRMNT)
    currentPanel = newPanel
    applyMuteTransition(currentPanel)
    if (wasTimeline && currentPanel !== VIEW_TIMELINE) clearVoiceMeters()
    if (wasSamples  && currentPanel !== VIEW_SAMPLES)  clearSampleWaveformArea()
    if (wasInstrmnt && currentPanel !== VIEW_INSTRMNT) clearInstrumentsEnvelopeArea()
    if (isExternalPanel(currentPanel)) {
        clearPanelMouseRegions()
        con.clear(); drawAlwaysOnElems(); drawControlHint()
        pendingExternalDraw = true
    } else {
        rebuildPanelMouseRegions()
        drawAll()
    }
}

// --- Tab bar regions (registered once; tab geometry is constant) ---
function registerTabRegions() {
    let col = 2  // XOFF, mirrors drawTabBar
    for (let i = 0; i < PANEL_NAMES.length; i++) {
        const w = 1 + PANEL_NAMES[i].length + 1  // spcL + name + spcR
        const tabIdx = i
        addGlobalMouseRegion(col, 3, w, 1, {
            onClick: (cy, cx, btn) => { if (btn === 1) switchToPanel(tabIdx) }
        })
        col += w + (i < PANEL_NAMES.length - 1 ? TAB_GAP : 0)
    }
}

// --- Transport regions (rows 1-2 on the right edge) ---
// Order j: 0=stop, 1=playrow, 2=playcue, 3=playall — mirrors drawStatusBar's loop.
function registerTransportRegions() {
    for (let j = 0; j < 4; j++) {
        const glyphCol = SCRW - 5 * (j + 1) + 3
        const idx = j
        addGlobalMouseRegion(glyphCol - 1, 1, 3, 2, {
            onClick: (cy, cx, btn) => {
                if (btn !== 1) return
                if (idx === 0) {
                    if (playbackMode !== PLAYMODE_NONE) { stopPlayback(); drawAlwaysOnElems(); redrawPanel() }
                    return
                }
                // The play handlers vary by panel — match the keyboard shortcut mapping.
                if (currentPanel === VIEW_PATTERN_DETAILS) {
                    if (idx === 1) startPlayPatternRow()
                    else           startPlayPattern()
                    drawPatternsContents(panelPatterns)
                } else {
                    if (idx === 1)      startPlayRow()
                    else if (idx === 2) startPlayCue()
                    else                startPlaySong()
                    redrawPanel()
                }
                drawAlwaysOnElems()
            }
        })
    }
}

// --- Per-panel viewport regions ---
function rebuildPanelMouseRegions() {
    clearPanelMouseRegions()
    if      (currentPanel === VIEW_TIMELINE)        registerTimelineMouse()
    else if (currentPanel === VIEW_CUES)            registerOrdersMouse()
    else if (currentPanel === VIEW_PATTERN_DETAILS) registerPatternsMouse()
    else if (currentPanel === VIEW_SAMPLES)         registerSamplesMouse()
    else if (currentPanel === VIEW_INSTRMNT)        registerInstrumentsMouse()
    else if (currentPanel === VIEW_PROJECT)         registerProjectMouse()
}

function registerSamplesMouse() {
    // Left list (incl. scroll-indicator column, but excluding the separator).
    addPanelMouseRegion(SMP_LIST_X, SMP_LIST_Y, SMP_SEP_X - SMP_LIST_X, SMP_LIST_H, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            const n = samplesCache ? samplesCache.length : 0
            const target = smpListScroll + (cy - SMP_LIST_Y)
            if (target < 0 || target >= n) return
            smpListCursor = target
            smpUsedScroll = 0
            clampSamplesCursor()
            drawSamplesContents()
        },
        onWheel: (cy, cx, dy) => {
            smpListCursor += dy * 3
            clampSamplesCursor()
            smpUsedScroll = 0
            drawSamplesContents()
        }
    })
    // Right "Used by" list: click launches inst viewer for that slot
    addPanelMouseRegion(SMP_RIGHT_X, SMP_USED_Y + 1, SCRW - SMP_RIGHT_X + 1, SMP_USED_LIST_H, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            const s = samplesCache && samplesCache[smpListCursor]
            if (!s) return
            const idx = smpUsedScroll + (cy - (SMP_USED_Y + 1))
            if (idx < 0 || idx >= s.usedBy.length) return
            launchInstrumentViewerFor(s.usedBy[idx])
        },
        onWheel: (cy, cx, dy) => {
            const s = samplesCache && samplesCache[smpListCursor]
            if (!s) return
            smpUsedScroll += dy
            drawSamplesUsedBy()
        }
    })
    // Bottom-row Edit button
    addPanelMouseRegion(SMP_RIGHT_X, SMP_BTN_Y, 18, 1, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1) return
            requestEditorLaunch('taut_sampleedit', [fullPathObj.full, VIEW_SAMPLES, smpListCursor])
        }
    })
}

function registerTimelineMouse() {
    addPanelMouseRegion(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1 || playbackMode !== PLAYMODE_NONE) return
            const viewRow   = cy - PTNVIEW_OFFSET_Y
            const targetRow = scrollRow + viewRow
            if (targetRow < 0 || targetRow >= ROWS_PER_PAT) return
            const oldCursor = cursorRow
            const oldVoxOff = voiceOff
            cursorRow = targetRow
            const relCol = cx - PTNVIEW_OFFSET_X
            if (relCol >= 0) {
                const colSlot = (relCol / COLSIZE_TIMELINE_FULL) | 0
                const targetVox = voiceOff + colSlot
                if (targetVox >= 0 && targetVox < song.numVoices) {
                    cursorVox = targetVox
                    const fieldX = relCol - colSlot * COLSIZE_TIMELINE_FULL
                    let field = 0
                    for (let k = 0; k < TL_FIELD_OFFSETS.length; k++) if (fieldX >= TL_FIELD_OFFSETS[k]) field = k
                    timelineColCursor = field
                }
            }
            clampCursor(); clampVoice()
            if (voiceOff !== oldVoxOff || Math.abs(cursorRow - oldCursor) >= PTNVIEW_HEIGHT) drawAll()
            else {
                drawPatternView(); drawVoiceHeaders(); drawSeparators(separatorStyle)
                drawAlwaysOnElems(); drawVoiceDetail()
            }
        },
        onWheel: (cy, cx, dy) => {
            if (playbackMode !== PLAYMODE_NONE) return
            cursorRow += dy * 3
            clampCursor()
            drawPatternView(); drawSeparators(separatorStyle); drawAlwaysOnElems(); drawVoiceDetail()
        }
    })
}

function registerOrdersMouse() {
    // Layout (1-indexed cells, mirrors drawOrdersRowAt):
    //   cols 1..3   = row number       (no column meaning)
    //   col  4      = gap
    //   cols 5..10  = CMD               (ordersColCursor = 0)
    //   col  11     = gap
    //   cols 12 + s*4 .. 12 + s*4 + 3   = voice slot s on screen
    //                                     (ordersColCursor = ordersVoiceOff + s + 1)
    //
    // Returns the ordersColCursor value for a given cx, or -1 if not on a column.
    const colAtX = (cx) => {
        if (cx >= ORDERS_CMD_X && cx < ORDERS_CMD_X + 6) return 0
        if (cx >= ORDERS_VOICE_X) {
            const slot = ((cx - ORDERS_VOICE_X) / ORDERS_VOICE_COL_W) | 0
            if (slot < 0 || slot >= VOCSIZE_ORDERS) return -1
            const v = ordersVoiceOff + slot
            if (v >= song.numVoices) return -1
            return v + 1
        }
        return -1
    }

    const hscrollBy = (dx) => {
        const maxOff = Math.max(0, song.numVoices - VOCSIZE_ORDERS)
        const next = Math.max(0, Math.min(maxOff, ordersVoiceOff + dx))
        if (next === ordersVoiceOff) return false
        ordersVoiceOff = next
        return true
    }

    // Header row: click selects a column without touching the row; wheel scrolls
    // voice columns horizontally (it's the natural place for column navigation).
    addPanelMouseRegion(1, PTNVIEW_OFFSET_Y - 1, SCRW, 1, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1 || playbackMode !== PLAYMODE_NONE) return
            const col = colAtX(cx)
            if (col < 0) return
            ordersColCursor = col
            clampOrdersHoriz(); redrawPanel(); drawAlwaysOnElems()
        },
        onWheel: (cy, cx, dy) => {
            if (hscrollBy(dy * 3)) { redrawPanel(); drawAlwaysOnElems() }
        },
    })

    // Content rows: click sets the row and (when on a column) the column too;
    // wheel scrolls vertically; Shift+wheel scrolls horizontally.
    addPanelMouseRegion(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, {
        onClick: (cy, cx, btn, ev) => {
            if (btn !== 1 || playbackMode !== PLAYMODE_NONE) return
            const viewRow   = cy - PTNVIEW_OFFSET_Y
            const targetIdx = ordersScroll + viewRow
            const maxCue    = song.lastActiveCue < 0 ? 0 : song.lastActiveCue
            if (targetIdx < 0 || targetIdx > maxCue) return
            ordersCursor = targetIdx
            const col = colAtX(cx)
            if (col >= 0) ordersColCursor = col
            scrollOrdersTo(ordersCursor)
            clampOrdersHoriz()
            redrawPanel(); drawAlwaysOnElems()
        },
        onWheel: (cy, cx, dy, ev) => {
            const shiftDown = (ev.includes(59) || ev.includes(60))
            if (shiftDown) {
                if (hscrollBy(dy * 3)) { redrawPanel(); drawAlwaysOnElems() }
                return
            }
            const maxCue = song.lastActiveCue < 0 ? 0 : song.lastActiveCue
            ordersCursor += dy * 3
            if (ordersCursor < 0) ordersCursor = 0
            if (ordersCursor > maxCue) ordersCursor = maxCue
            scrollOrdersTo(ordersCursor)
            redrawPanel(); drawAlwaysOnElems()
        }
    })
}

function registerPatternsMouse() {
    // Left column: pattern list. cx in [PATEDITOR_LIST_X, PATEDITOR_SEP1_X)
    addPanelMouseRegion(PATEDITOR_LIST_X, PTNVIEW_OFFSET_Y,
                        PATEDITOR_SEP1_X - PATEDITOR_LIST_X, PTNVIEW_HEIGHT, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1 || song.numPats === 0 || playbackMode !== PLAYMODE_NONE) return
            const targetIdx = patternListScroll + (cy - PTNVIEW_OFFSET_Y)
            if (targetIdx < 0 || targetIdx >= song.numPats) return
            patternIdx = targetIdx
            clampPatternIdx(); simStateKey = ''
            drawPatternsContents(panelPatterns)
        },
        onWheel: (cy, cx, dy) => {
            if (song.numPats === 0) return
            patternIdx += dy
            clampPatternIdx(); simStateKey = ''
            drawPatternsContents(panelPatterns)
        }
    })
    // Middle grid: pattern editor cells. cx in [PATEDITOR_GRID_X, PATEDITOR_DETAIL_X)
    addPanelMouseRegion(PATEDITOR_GRID_X, PTNVIEW_OFFSET_Y,
                        PATEDITOR_DETAIL_X - PATEDITOR_GRID_X, PTNVIEW_HEIGHT, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1 || song.numPats === 0 || playbackMode !== PLAYMODE_NONE) return
            const targetRow = patternGridScroll + (cy - PTNVIEW_OFFSET_Y)
            if (targetRow < 0 || targetRow >= ROWS_PER_PAT) return
            patternGridRow = targetRow
            const cellRel = cx - PATEDITOR_CELL_X
            const fieldOffsets = [0, 5, 8, 11, 14, 15]
            let field = 0
            for (let k = 0; k < fieldOffsets.length; k++) if (cellRel >= fieldOffsets[k]) field = k
            if (field < 0) field = 0; if (field > 5) field = 5
            patternGridCol = field
            clampPatternGrid(); simStateKey = ''
            drawPatternsContents(panelPatterns)
        },
        onWheel: (cy, cx, dy) => {
            if (song.numPats === 0) return
            patternGridRow += dy * 3
            clampPatternGrid(); simStateKey = ''
            drawPatternsContents(panelPatterns)
        }
    })
}

function registerProjectMouse() {
    addPanelMouseRegion(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, {
        onClick: (cy, cx, btn) => {
            if (btn !== 1 || playbackMode !== PLAYMODE_NONE) return
            // Meta rows occupy PTNVIEW_OFFSET_Y .. PTNVIEW_OFFSET_Y + PROJ_META_ROWS_COUNT - 1.
            // The song list starts at PROJ_SONGLIST_Y + 1.
            const metaRow = cy - PTNVIEW_OFFSET_Y
            if (metaRow >= 0 && metaRow < PROJ_META_ROWS_COUNT) {
                projectCursor = metaRow
                clampProjectCursor(); redrawPanel()
                return
            }
            const songRow = cy - (PROJ_SONGLIST_Y + 1)
            if (songRow >= 0) {
                const songIdx = projectSongScroll + songRow
                if (songIdx >= 0 && songIdx < songsMeta.numSongs) {
                    projectCursor = PROJ_META_ROWS_COUNT + songIdx
                    clampProjectCursor(); redrawPanel()
                }
            }
        },
        onWheel: (cy, cx, dy) => {
            const rowsVis = projectSongListRowsVisible()
            const maxScroll = Math.max(0, songsMeta.numSongs - rowsVis)
            projectSongScroll += dy * 3
            if (projectSongScroll < 0) projectSongScroll = 0
            if (projectSongScroll > maxScroll) projectSongScroll = maxScroll
            redrawPanel()
        }
    })
}

registerTabRegions()
registerTransportRegions()
rebuildPanelMouseRegions()

// Launching a sub-program from inside an input.withEvent callback causes the triggering
// Tab event to leak into the sub-program's own withEvent call (the event hasn't been
// consumed yet when the callback is still executing). We avoid this by deferring the
// actual shell.execute until after withEvent returns.
let exitFlag = false
let pendingExternalDraw = false

while (!exitFlag) {
    input.withEvent(event => {
        if (dispatchMouseEvent(event)) return
        if (event[0] !== "key_down") return
        const keysym     = event[1]
        const keyJustHit = (1 == event[2])
        const shiftDown  = (event.includes(59) || event.includes(60))

        if (keyJustHit && shiftDown && event.includes(keys.Q) &&
                (currentPanel === VIEW_TIMELINE || currentPanel === VIEW_PATTERN_DETAILS)) {
            openRetunePopup()
            return
        }

        if (keyJustHit && keysym === "q") {
            if (openConfirmQuit()) exitFlag = true
            return
        }

        if (keyJustHit && keysym === "<TAB>") {
            const wasTimeline = (currentPanel === VIEW_TIMELINE)
            const wasSamples  = (currentPanel === VIEW_SAMPLES)
            currentPanel = (currentPanel + (shiftDown ? -1 : 1))
            if (currentPanel < 0) currentPanel += panels.length
            currentPanel = currentPanel % panels.length
            applyMuteTransition(currentPanel)
            if (wasTimeline && currentPanel !== VIEW_TIMELINE) clearVoiceMeters()
            if (wasSamples  && currentPanel !== VIEW_SAMPLES)  clearSampleWaveformArea()
            if (isExternalPanel(currentPanel)) {
                // Redraw header now so the tab highlight is visible immediately,
                // but defer the actual sub-program launch to after withEvent returns.
                clearPanelMouseRegions()
                con.clear(); drawAlwaysOnElems(); drawControlHint()
                pendingExternalDraw = true
            } else {
                rebuildPanelMouseRegions()
                drawAll()
            }
            return
        }

        if (keyJustHit && shiftDown && event.includes(keys.G)) {
            openGotoPopup()
            return
        }

        if (keyJustHit && keysym === '!') {
            openHelpPopup()
            return
        }

        panels[currentPanel].processInput(event)
    })

    // Launch external sub-program OUTSIDE the withEvent callback so the triggering
    // Tab event is fully consumed before the sub-program's event loop begins.
    if (pendingExternalDraw) {
        pendingExternalDraw = false
        redrawPanel()
        while (_G.TAUT.UI.NEXTPANEL !== undefined && _G.TAUT.UI.NEXTPANEL !== null) {
            const wasTimeline = (currentPanel === VIEW_TIMELINE)
            currentPanel = _G.TAUT.UI.NEXTPANEL
            _G.TAUT.UI.NEXTPANEL = undefined
            applyMuteTransition(currentPanel)
            if (wasTimeline && currentPanel !== VIEW_TIMELINE) clearVoiceMeters()
            if (isExternalPanel(currentPanel)) {
                clearPanelMouseRegions()
                con.clear(); drawAlwaysOnElems(); drawControlHint()
                redrawPanel()
            } else {
                rebuildPanelMouseRegions()
                drawAll()
            }
        }
    }

    // Launch the sample / instrument editor as a sub-program. Same deferral
    // reason as pendingExternalDraw: avoid leaking the trigger key into the
    // sub-program's own withEvent loop. The editor sets NEXTPANEL on exit
    // (typically back to its parent viewer), so the loop above will repaint.
    if (pendingEditorLaunch) {
        const { progName, args } = pendingEditorLaunch
        pendingEditorLaunch = null
        stopPlayback()
        clearSampleWaveformArea()
        clearPanelMouseRegions()
        con.clear(); drawAlwaysOnElems(); drawControlHint()
        _G.TAUT.UI.NEXTPANEL = undefined
        _G.shell.execute(`${progName} ${args.join(' ')}`)
        // After the editor returns, instruments / samples may have changed —
        // rebuild the deduped sample list before redrawing whatever panel comes next.
        refreshSamplesCache()
        if (_G.TAUT.UI.NEXTPANEL === undefined || _G.TAUT.UI.NEXTPANEL === null) {
            // Editor declined to switch panels — repaint the current panel.
            rebuildPanelMouseRegions()
            drawAll()
        } else {
            while (_G.TAUT.UI.NEXTPANEL !== undefined && _G.TAUT.UI.NEXTPANEL !== null) {
                const wasTimeline = (currentPanel === VIEW_TIMELINE)
                currentPanel = _G.TAUT.UI.NEXTPANEL
                _G.TAUT.UI.NEXTPANEL = undefined
                applyMuteTransition(currentPanel)
                if (wasTimeline && currentPanel !== VIEW_TIMELINE) clearVoiceMeters()
                if (isExternalPanel(currentPanel)) {
                    clearPanelMouseRegions()
                    con.clear(); drawAlwaysOnElems(); drawControlHint()
                    redrawPanel()
                } else {
                    rebuildPanelMouseRegions()
                    drawAll()
                }
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