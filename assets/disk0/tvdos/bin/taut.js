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
const VERT = 0xDA

// global var for the app
_G.TAUT = {};
_G.TAUT.UI = {};
_G.TAUT.UI.NEXTPANEL = undefined;

// ── Module hub ──────────────────────────────────────────────────────────────
// taut.js is split across sibling taut_*.mjs modules (see the humble-brewing-harp
// plan). They run IN-PROCESS in this context — not as separate shell programs —
// so playback stays live and the editors can read player state. Each module
// exports init(HUB) and returns its public functions. HUB carries:
//   HUB.C        — read-only constants the modules need
//   HUB.S        — shared MUTABLE state (cross-module reassignable scalars live
//                  here, so a module and taut.js mutate the same object)
//   HUB.<helper> — refs to core helpers that stay in taut.js
//   HUB.<module> — back-refs to each module's exports, filled at init time
// Modules read HUB.* at CALL time, so forward / cross-module references resolve
// once every module has been init'd (which happens before the main loop). The
// hub is named HUB rather than ctx to avoid shadowing the many wintex-dialog
// callback params already called `ctx`. Sibling modules are required by absolute
// path so they live next to taut.js in \tvdos\bin\.
const HUB = { C: {}, S: {} }
const TAUT_BIN_DIR = `${_G.shell.getCurrentDrive()}:\\tvdos\\bin\\`
function requireTaut(name) { return require(TAUT_BIN_DIR + name + ".mjs") }

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
notefade:"~~~~",
notefastfade:"\u0084127u".repeat(4),

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
'5':"Filter cutoff",
'6':"Filter reson.",
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
const colInstMetaStray = 205   // inst drawn red when it's a stray meta-layer child (use the meta instead)
const colVol = 155
const colPan = 219
const colEffOp = 220
const colEffArg = 231
const colBackPtn = 255

// Cached 256-flag array (from taut_views.buildMetaLayerChildSlots): inst slots that are a
// non-meta layer child of a Metainstrument. Rebuilt lazily; invalidated on song switch and
// whenever a pattern panel is (re)entered (instruments may have changed in the Instrmnt tab).
let metaLayerFlags = null
function invalidateMetaLayerFlags() { metaLayerFlags = null }
function instColour(inst) {
    if (metaLayerFlags === null && HUB.views && HUB.views.buildMetaLayerChildSlots)
        metaLayerFlags = HUB.views.buildMetaLayerChildSlots()
    return (inst && metaLayerFlags && metaLayerFlags[inst]) ? colInstMetaStray : colInst
}

const PITCH_PRESET_IDX_DEFAULT = 120
// Seed value used during global init (integrity check + first rebuildPitchLut);
// the open/switch paths override it per-song from sMet via applySongPitchPreset().
let PITCH_PRESET_IDX = PITCH_PRESET_IDX_DEFAULT
// Row-highlight grid. Populated per-song from the sMet block's beat divisions
// (Primary = rows per beat, Secondary = rows per bar); 4/16 is the 4/4 default
// used when a song carries no sMet entry. See applySongBeatDiv().
const BEAT_DIV_PRIMARY_DEFAULT = 4
const BEAT_DIV_SECONDARY_DEFAULT = 16
let beatDivPrimary = BEAT_DIV_PRIMARY_DEFAULT
let beatDivSecondary = BEAT_DIV_SECONDARY_DEFAULT

// Set the row-highlight grid from a per-song metadata record (songsMeta.songs[i]).
function applySongBeatDiv(s) {
    beatDivPrimary   = (s && s.beatDivPrimary)   ? s.beatDivPrimary   : BEAT_DIV_PRIMARY_DEFAULT
    beatDivSecondary = (s && s.beatDivSecondary) ? s.beatDivSecondary : BEAT_DIV_SECONDARY_DEFAULT
}

// Set the active pitch/notation preset from a per-song metadata record (the sMet
// 'notation' field) and rebuild the pitch LUT. Falls back to the default when the
// song carries no notation or an unknown preset index.
function applySongPitchPreset(s) {
    const idx = s ? s.pitchPresetIdx : null
    PITCH_PRESET_IDX = (idx != null && pitchTablePresets[idx]) ? idx : PITCH_PRESET_IDX_DEFAULT
    rebuildPitchLut()
}
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
                    if (note >= 0x0000 && note <= 0x001F) continue
                    // Use the full absolute pitch as tonic; the modular ops
                    // in _cadTension / _harmonicCost normalise it.
                    tonic = note
                    break
                }
            }
            for (let row = 0; row < ROWS_PER_PAT; row++) {
                const off = 8 * row
                const note = ptn[off] | (ptn[off+1] << 8)
                if (note >= 0x0000 && note <= 0x001F) continue
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
    if (note === 0x0003) return sym.notefade
    if (note === 0x0004) return sym.notefastfade
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
             _note: note, _inst: inst, _effop: effop, _effarg: effarg, _voleff: voleff, _paneff: paneff }
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
    _note: 0x0000, _inst: 0, _effop: 0, _effarg: 0, _voleff: 0, _paneff: 0
}

function drawCellAt(y, x, cell, back) {
    con.move(y, x)
    con.color_pair(colNote,   back); print(cell.sNote)
    con.color_pair(instColour(cell._inst), back); print(cell.sInst)
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
        con.color_pair(instColour(cell._inst), back); print(cell.sInst)
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
    const tickPacked = sys.peek(ptr + entryOff + 8) & 0xFF
    const bpmStored = (sys.peek(ptr + entryOff + 7) & 0xFF) | ((tickPacked & 0x80) << 1)  // bit 7 of byte 8 = BPM high bit
    const tickRate  = tickPacked & 0x7F
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
            bpm:              ((sys.peek(ptr + entryOff + 7) & 0xFF) + 25 + ((sys.peek(ptr + entryOff + 8) & 0x80) << 1)),  // bit 7 of byte 8 = BPM high bit
            tickRate:         sys.peek(ptr + entryOff + 8) & 0x7F,
            mixerflags:       sys.peek(ptr + entryOff + 15) & 0xFF,
            songGlobalVolume: sys.peek(ptr + entryOff + 16) & 0xFF,
            songMixingVolume: sys.peek(ptr + entryOff + 17) & 0xFF,
            name: '',
            composer: '',
            copyright: '',
            pitchPresetIdx: null,
            beatDivPrimary: null,
            beatDivSecondary: null,
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
                        const beatPri = sys.peek(ptr + subStart + 2) & 0xFF
                        const beatSec = sys.peek(ptr + subStart + 3) & 0xFF
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
                            // 0 = unset → applySongBeatDiv falls back to the 4/4 default
                            songs[idx].beatDivPrimary = beatPri || null
                            songs[idx].beatDivSecondary = beatSec || null
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
const colEditHL    = 86   // sub-field cursor background while in pattern edit mode (red = editing)
const colColumnSep = 6
const colRowNum    = 250
const colRowNumEmph1 = 225
const colRowNumEmph2 = 155
const colStatus    = 253
const colVoiceHdr  = 230
const colVoiceHdrMuted = 249
const colVoiceHdrMutedCursorUp = 180
const colSep       = 252
const colScrollBar = 249
const colPushBtnBack = 143
const colTabBarBack = 187
const colTabBarBack2 = 136
const colTabBarOrn = 136
const colBrand = 211
const colPopupBack = 244
const colPopupBack2 = 243
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

    // View/Edit mode badge (Timeline + Patterns panels only)
    if (currentPanel === VIEW_TIMELINE || currentPanel === VIEW_PATTERN_DETAILS) {
        con.move(1, 22)
        if (patternEditMode) { con.color_pair(colWHITE, colEditHL); print(' EDIT ') }
        else                 { con.color_pair(235, 255);           print(' VIEW ') }
    }

    if (!patternEditMode) {
    }

    // Edit-mode info strip (right of the centred logo): the current jam instrument and
    // octave. Only shown while editing on a pattern panel; blank in view mode. Drawn only
    // if it fits between the logo and the transport buttons (rightmost is ~col SCRW-18).
    if ((currentPanel === VIEW_TIMELINE || currentPanel === VIEW_PATTERN_DETAILS) && patternEditMode) {
        // editOctave is the period index; the pattern shows octave digits as (period - 1)
        // in hex, so display the same so a jammed root key matches its cell's octave.
        const octShown = (editOctave - 1).toString(16)
        const stripX  = 4
        con.move(2, stripX)
        con.color_pair(colWHITE, 255); print('Inst ')
        con.color_pair(colInst, 255);  print(currentInstrument.hex02())
        con.color_pair(colWHITE, 255); print('  Oct ')
        con.color_pair(235, 255);  print(octShown)
    }
    // bpm spd
    else {
        con.move(2, 4)
        con.color_pair(colWHITE, 255); print(`BPM `)
        con.color_pair(161, 255); print(`${sBPM}`)
        con.color_pair(colWHITE, 255); print(`  Tick `)
        con.color_pair(235, 255); print(`${sSpd}`)
    }

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
                let bgColOffset = vaddr(TEXT_BACK_OFF + memOffset)
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
            const ovFg = (timelineColCursor === 1) ? instColour(cell._inst) : TL_FIELD_FGS[timelineColCursor]
            con.move(y, x + TL_FIELD_OFFSETS[timelineColCursor])
            con.color_pair(ovFg, patternEditMode ? colEditHL : colPlayback)
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
        [`0${sym.doubledot}9 A${sym.doubledot}F`,'Ptn'],
        ['-','Clr'],
    ['sep'],
        [`ent`,'Cmd/GoTo'],
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
        ['z','KOff'],
        ['x','KCut'],
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
    const hintElemFile = [
        [`28u29u`,'Nav'],
        ['u','Up'],
    ['sep'],
        ['O','Open'],['S','Save'],['A','SvAs'],['N','New'],
    ['sep'],
        ['K','MkDir'],['R','Rename'],
    ['sep'],
        ['tab','Panel'],
        ['!','Help'],
    ]
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
        ['E','Edit'],
    ['sep'],
        ['tab','Panel'],
    ['sep'],
        ['!','Help'],
    ]
    let hintElems = [hintElemTimeline, hintElemOrders, hintElemPatterns, hintElemSamples, hintElemInstruments, hintElemProject, hintElemFile]
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
        print('\u00B3'.repeat(detailW))

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

// Direct text-VRAM addressing. On real hardware the GPU text area is addressed
// backward (byte m at GPU_MEM - m). Under vtmgr's virtual consoles the physical
// GPU is owned by the compositor, so direct writes must instead target this
// pane's forward text-plane buffer (VT_TEXT_PLANE + m), which the compositor
// blits to the screen. vaddr(m) returns the address of text-area byte m for the
// current environment; the physical branch is identical to the old arithmetic.
const _VT_VRAM     = (typeof globalThis.VT_TEXT_PLANE !== 'undefined')
const VRAM_BASE    = _VT_VRAM ? globalThis.VT_TEXT_PLANE : GPU_MEM
const VRAM_SGN     = _VT_VRAM ? 1 : -1
function vaddr(m) { return VRAM_BASE + VRAM_SGN * m }

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
        const srcAddr = vaddr(chanOff + (srcTopY - 1) * SCRW)
        const dstAddr = vaddr(chanOff + (dstTopY - 1) * SCRW)
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
            const idxBase = chanOff + (PTNVIEW_OFFSET_Y + vr - 1) * SCRW
            sys.memcpy(vaddr(idxBase + srcOff), SCRATCH_PTR, SALVAGE_HORIZ_LEN)
            sys.memcpy(SCRATCH_PTR, vaddr(idxBase + dstOff), SALVAGE_HORIZ_LEN)
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
            const ovFg = (timelineColCursor === 1) ? instColour(cell._inst) : TL_FIELD_FGS[timelineColCursor]
            con.move(y, x + TL_FIELD_OFFSETS[timelineColCursor])
            con.color_pair(ovFg, patternEditMode ? colEditHL : colPlayback)
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

// ── Pattern-cell editing (Timeline + Patterns share one cell editor) ──
// patternEditMode is the View/Edit toggle (space bar); shared by both panels.
// currentInstrument is stamped onto jammed notes and auto-adopted when the cursor
// lands on a populated cell or the user types into the inst column.
// editOctave is the period index used as the base for white/black-snapped jamming.
let patternEditMode  = false
let currentInstrument = 1
let editOctave        = ANCHOR_PERIOD

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
// The mutable "current file" pointer the File tab reads/writes. Starts at the
// file taut was launched with; Open / Save As repoint it, New clears it to null
// (an unsaved in-memory project). switchSong reloads from this, NOT fullPathObj
// (which only records the launch path).
let currentFilePath = fullPathObj.full
applySongPitchPreset(songsMeta.songs[currentSongIndex])
applySongBeatDiv(songsMeta.songs[currentSongIndex])

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

// Shared tail of every "the project/song just changed" path (switchSong /
// openProject / newProject): rebuild the sample cache, reset master + per-song
// volumes, snapshot the device's initial mixer/volume state, and clear all the
// per-song UI cursors / scroll / mutes / playback positions. The caller is
// responsible for having uploaded the new song to the device first.
function finishLoadCommon() {
    refreshSamplesCache()
    invalidateMetaLayerFlags()
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
}

// Load song `index` from `path` into the editor + audio device. Assumes the
// caller has already stopped playback / reset the device and (for cross-file
// loads) refreshed songsMeta. Does NOT redraw.
function loadSongFromFile(path, index) {
    currentSongIndex = index
    song = loadTaud(path, index)
    applySongPitchPreset(songsMeta.songs[index])
    applySongBeatDiv(songsMeta.songs[index])
    taud.uploadTaudFile(path, index, PLAYHEAD)
    finishLoadCommon()
}

// Switch the active song within the currently-open multi-song .taud file.
// Re-uploads patterns+cues (and the shared sample/inst bin) to the audio
// adapter, reloads song metadata, and resets per-song UI / playback state.
function switchSong(newIndex) {
    if (newIndex < 0 || newIndex >= songsMeta.numSongs) return
    if (newIndex === currentSongIndex) return
    if (currentFilePath === null) return  // unsaved "new" project: nothing on disk to reload

    stopPlayback()
    resetAudioDevice()
    loadSongFromFile(currentFilePath, newIndex)
    drawAll()
}

// ── File-tab operations (open / save / new) ─────────────────────────────────
// Wired to taut_fileop's filenav-driven File tab through the HUB. The File tab
// owns the popups (confirm-unsaved etc.); these just do the state work and may
// throw (the caller reports the error).

// Replace songsMeta's CONTENTS in place (not the binding) so taut_views — which
// captured the songsMeta reference at init — keeps seeing the live metadata.
function replaceSongsMeta(m) {
    for (const k of Object.keys(songsMeta)) delete songsMeta[k]
    Object.assign(songsMeta, m)
}

// Open `path` as the new current project (song 0). Validates the file before
// touching any state, so a bad file leaves the current project intact.
function openProject(path) {
    const newMeta = loadTaudSongList(path)   // throws on bad magic / missing file
    stopPlayback()
    resetAudioDevice()
    replaceSongsMeta(newMeta)
    currentFilePath = path
    loadSongFromFile(path, 0)
    hasUnsavedChanges = false
}

// Overwrite `path` with the current device state (single-song capture).
function saveProjectToFile(path) {
    taud.captureTrackerDataToFile(path)   // throws on I/O error
    hasUnsavedChanges = false
}

// A blank in-memory project: one empty pattern, all-empty cue sheet, no
// instruments. currentFilePath becomes null (nothing on disk yet).
const NUM_PATTERNS_MAX = 256
function buildEmptyCueBytes() {
    // 10 lo + 10 mid + 10 hi nibble-pair bytes (all 0xFF == every voice 0xFFF
    // empty) + 2 instruction bytes (0). Inverse of loadTaud's cue decode.
    const b = new Array(CUE_SIZE).fill(0)
    for (let k = 0; k < 30; k++) b[k] = 0xFF
    return b
}
function buildEmptySong() {
    const patterns = [ new Uint8Array(PATTERN_SIZE) ]
    const cues = new Array(NUM_CUES)
    for (let c = 0; c < NUM_CUES; c++) {
        cues[c] = { ptns: new Array(NUM_VOICES).fill(CUE_EMPTY), instr: 0 }
    }
    return {
        filePath: null, songIndex: 0, version: 1, numSongs: 1,
        numVoices: NUM_VOICES, numPats: 1, bpm: 125, tickRate: 6,
        patterns, cues, lastActiveCue: -1,
    }
}
function buildEmptyMeta() {
    return {
        numSongs: 1, projectName: '',
        songs: [{
            index: 0, numVoices: NUM_VOICES, numPats: 1, bpm: 125, tickRate: 6,
            mixerflags: 0, songGlobalVolume: 0x80, songMixingVolume: 0x80,
            name: '', composer: '', copyright: '',
            pitchPresetIdx: null, beatDivPrimary: null, beatDivSecondary: null,
        }],
        instNames: [], sampleNames: [],
    }
}
function uploadEmptyDeviceState() {
    const zerosPat  = new Array(PATTERN_SIZE).fill(0)
    const emptyCue  = buildEmptyCueBytes()
    const zerosInst = new Array(256).fill(0)
    for (let p = 0; p < NUM_PATTERNS_MAX; p++) audio.uploadPattern(p, zerosPat)
    for (let c = 0; c < NUM_CUES; c++)         audio.uploadCue(c, emptyCue)
    for (let s = 0; s < 256; s++) { audio.uploadInstrument(s, zerosInst); audio.uploadInstrumentPatches(s, []) }
    audio.setTrackerMode(PLAYHEAD)
    audio.setBPM(PLAYHEAD, 125)
    audio.setTickRate(PLAYHEAD, 6)
    audio.setTrackerMixerFlags(PLAYHEAD, 0)
    audio.setSongGlobalVolume(PLAYHEAD, 0x80)
    audio.setSongMixingVolume(PLAYHEAD, 0x80)
}
function newProject() {
    stopPlayback()
    resetAudioDevice()
    uploadEmptyDeviceState()
    replaceSongsMeta(buildEmptyMeta())
    currentFilePath = null
    currentSongIndex = 0
    song = buildEmptySong()
    applySongPitchPreset(songsMeta.songs[0])
    applySongBeatDiv(songsMeta.songs[0])
    finishLoadCommon()
    hasUnsavedChanges = false
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
    const maxCue = ordersMaxRow()
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
    const maxCue = ordersMaxRow()

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
            const idxBase = chanOff + (PTNVIEW_OFFSET_Y + vr - 1) * SCRW
            sys.memcpy(vaddr(idxBase + srcOff), SCRATCH_PTR, stripWidth)
            sys.memcpy(SCRATCH_PTR, vaddr(idxBase + dstOff), stripWidth)
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
                    if (!arg8) return "HALT  "
                    switch (arg8 >>> 6) {
                        case 0b00:
                            return "FADE" + (arg8 & 63).dec02()
                        case 0b01:
                            return "HALT" + (arg8 & 63).dec02()
                        default:
                            return fallback
                    }
                case 0b0000:
                    return "NO-OP "
                default:
                    return fallback
            }
        default:
            return fallback
    }
}

// ── Cue-sheet editing helpers (shared by the Cues panel inline editor + the
//    command popup). The Cues panel lets the cursor sit on ONE blank row past the
//    last active cue so a new cue can be appended; ordersMaxRow() is that bound. ──
function ordersMaxRow() {
    const last = song.lastActiveCue < 0 ? 0 : song.lastActiveCue
    return Math.min(NUM_CUES - 1, last + 1)
}

// Re-scan the cue sheet for the highest cue carrying any non-empty voice pattern.
// Mirrors loadTaud's lastActiveCue rule (voices only; a command-only cue is not
// "active"). Cheap enough to run on every cue edit.
function recomputeLastActiveCue() {
    let last = -1
    for (let c = 0; c < NUM_CUES; c++) {
        const ptns = song.cues[c].ptns
        for (let v = 0; v < NUM_VOICES; v++) {
            if (ptns[v] !== CUE_EMPTY) { last = c; break }
        }
    }
    song.lastActiveCue = last
}

// Push one in-memory cue back to the audio adapter so playback reflects the edit
// (cues are not lazily synced like patterns), then mark the project dirty.
function commitCue(ci) {
    audio.uploadCue(ci, encodeCue(song.cues[ci]))
    hasUnsavedChanges = true
}

// Edit one voice's pattern index in cue `ci` from a single keystroke. Hex digits
// accumulate (shift-register, masked to 12 bits); '-' clears to CUE_EMPTY (0xFFF);
// Backspace drops a digit. Returns true if the cell changed.
function editCuePtn(ci, voice, sc, shiftDown) {
    const cue = song.cues[ci]
    const cur = cue.ptns[voice]
    let next = cur
    if (sc === keys.MINUS && !shiftDown) {
        next = CUE_EMPTY
    } else if (sc === keys.BACKSPACE) {
        next = (cur === CUE_EMPTY) ? CUE_EMPTY : (cur >>> 4)
    } else if (!shiftDown) {
        const nib = scToHexNibble(sc)
        if (nib < 0) return false
        const base = (cur === CUE_EMPTY) ? 0 : cur
        next = ((base << 4) | nib) & 0xFFF
    } else {
        return false
    }
    if (next === cur) return false
    cue.ptns[voice] = next
    recomputeLastActiveCue()
    commitCue(ci)
    return true
}

function timelineInput(wo, event) {
    const keysym    = event[1]
    const sc         = event[3]                      // primary physical scancode (layout-independent)
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 4 : 1

    if (keyJustHit && shiftDown && event.includes(keys.W)) { setTimelineRowStyle(0); return }
    if (keyJustHit && shiftDown && event.includes(keys.E)) { setTimelineRowStyle(1); return }
    if (keyJustHit && shiftDown && event.includes(keys.R)) { setTimelineRowStyle(2); return }

    // [ / ] nudges the tick rate, EXCEPT in edit mode on the note column where they
    // lower/raise the note by one unit (handled by the cell editor below).
    if (keyJustHit && !shiftDown && (sc === keys.LEFT_BRACKET || sc === keys.RIGHT_BRACKET) &&
        !(patternEditMode && playbackMode === PLAYMODE_NONE && timelineColCursor === 0)) {
        nudgeTickRate(sc === keys.LEFT_BRACKET ? -1 : 1); return
    }

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
    if (keyJustHit && shiftDown && event.includes(keys.O)) { stopPlayback(); drawAlwaysOnElems(); return }
    // Space toggles View/Edit while stopped (the playing branch above already stops on space).
    if (keysym === " ") { if (keyJustHit) toggleEditMode(); return }

    // ── Edit mode: insert/jam into the current cell (discrete, on key-down only);
    // View mode: audition jam keys. Navigation keys fall through to the cursor logic. ──
    // Cell editing needs the detailed timeline (style 0) where the sub-field cursor exists.
    if (patternEditMode && keyJustHit && timelineRowStyle === 0) {
        const cue    = song.cues[cueIdx]
        const ptnIdx = cue ? cue.ptns[cursorVox] : CUE_EMPTY
        if (ptnIdx !== CUE_EMPTY && ptnIdx < song.numPats) {
            const ptnDat = song.patterns[ptnIdx]
            const res = editPatternCell(ptnDat, cursorRow, timelineColCursor, event, noteFieldScreenPos())
            if (res.changed) {
                simStateKey = ''
                if (res.audition >= 0 && typeof audio.jamNote === 'function')
                    audio.jamNote(PLAYHEAD, cursorVox, res.audition, currentInstrument)
                drawPatternRowAt(cursorRow - scrollRow)
                if (res.advance) {
                    const oc = cursorRow, os = scrollRow
                    cursorRow = Math.min(ROWS_PER_PAT - 1, cursorRow + 1)
                    clampCursor()
                    if (scrollRow === os) drawPatternRowAt(oc - scrollRow)
                    else                  drawPatternView()
                    drawPatternRowAt(cursorRow - scrollRow)
                    drawSeparators(separatorStyle)
                }
                drawAlwaysOnElems()
                return
            }
            if (res.octave) { drawAlwaysOnElems(); return }   // octave-only change: refresh the indicator
        }
    } else if (!patternEditMode && keyJustHit && !shiftDown && jamScancodeToSemitone(sc) !== null) {
        const n = semitoneToNote(jamScancodeToSemitone(sc), editOctave)
        if (n !== null && typeof audio.jamNote === 'function') audio.jamNote(PLAYHEAD, cursorVox, n, currentInstrument)
        return
    }

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
        if (patternEditMode) { const c = currentEditCell(); if (c) adoptInstrumentFromCell(c.ptnDat, c.row) }
        const dVoice = voiceOff - oldVoiceOff
        if (dVoice !== 0) { shiftPatternAreaHorizontal(dVoice); drawVoiceColumnAt(dVoice > 0 ? VOCSIZE_TIMELINE_FULL - 1 : 0) }
        drawVoiceHeaders(); drawSeparators(separatorStyle); drawAlwaysOnElems(); drawVoiceDetail()
        drawPatternRowAt(cursorRow - scrollRow)
        return
    }

    // Mute / solo are View-mode only (not in the documented EDIT MODE controls).
    if (!patternEditMode && keyJustHit && !shiftDown && event.includes(keys.M)) { toggleMute(cursorVox); return }
    if (!patternEditMode && keyJustHit && !shiftDown && event.includes(keys.N)) { toggleSolo(cursorVox); return }

    if      (keysym === "<UP>")        { cursorRow -= moveDelta;      rowMove = true }
    else if (keysym === "<DOWN>")      { cursorRow += moveDelta;      rowMove = true }
    else if (keysym === "<HOME>")      { cursorRow  = 0;              rowMove = true }
    else if (keysym === "<END>")       { cursorRow  = ROWS_PER_PAT-1; rowMove = true }
    else if (keysym === "<PAGE_UP>")   { cueIdx    -= moveDelta;      fullRedraw = true }
    else if (keysym === "<PAGE_DOWN>") { cueIdx    += moveDelta;      fullRedraw = true }
    else return

    clampCursor(); clampVoice(); clampCue()
    if (patternEditMode) { const c = currentEditCell(); if (c) adoptInstrumentFromCell(c.ptnDat, c.row) }

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
    const maxCue     = ordersMaxRow()

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

    // ── Cue editing (stopped only) ─────────────────────────────────────────────
    // Command column (col 0): Enter opens the command popup.
    // Voice columns (col >= 1): hex digits accumulate the pattern index, '-' clears
    // it to empty (0xFFF), Backspace drops a digit. (Enter on a voice column falls
    // through to the "go to cue" handler below.)
    if (keyJustHit && !shiftDown && ordersColCursor === 0 && keysym === '\n') {
        openCueCmdPopup(ordersCursor); return
    }
    if (keyJustHit && ordersColCursor >= 1) {
        let sc = event[3]; if (sc == 59) sc = event[4]; if (sc == 60) sc = event[5]
        const isEditKey = sc && (sc === keys.MINUS || sc === keys.BACKSPACE || scToHexNibble(sc) >= 0)
        if (isEditKey) {
            const oldMax = ordersMaxRow()
            if (editCuePtn(ordersCursor, ordersColCursor - 1, sc, shiftDown)) {
                if (ordersMaxRow() !== oldMax) {
                    if (ordersCursor > ordersMaxRow()) ordersCursor = ordersMaxRow()
                    scrollOrdersTo(ordersCursor)
                    drawOrdersContents(wo)
                } else {
                    drawOrdersRowAt(ordersCursor)
                }
                drawAlwaysOnElems()
            }
            return
        }
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
// PATTERN CELL EDITOR (shared by Timeline + Patterns panels)
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Special note words (non-pitched). 0 = empty, 1..4 = key-off/cut/fade/fastfade.
// 0x10..0x1F are reserved internal interrupts; pitched notes are >= 0x20.
function noteIsPitched(n) { return n >= 0x0020 }

// ── The cell editor dispatches on the raw key SCANCODE (event[3] = keys.head()), not the
// layout-resolved keysym, so the piano layout and edit keys keep their physical positions on
// any keyboard layout (QWERTY / Dvorak / Colemak). Shift state is read separately. ──

// White/black piano layout by physical key: a s d f g h j k = white keys
// (semitone 0 2 4 5 7 9 11 12), w e t y u = black keys (1 3 6 8 10).
const SC_JAM = {}
;[[keys.A,0],[keys.W,1],[keys.S,2],[keys.E,3],[keys.D,4],[keys.F,5],[keys.T,6],
  [keys.G,7],[keys.Y,8],[keys.H,9],[keys.U,10],[keys.J,11],[keys.K,12]].forEach(p => SC_JAM[p[0]] = p[1])
function jamScancodeToSemitone(sc) {
    return Object.prototype.hasOwnProperty.call(SC_JAM, sc) ? SC_JAM[sc] : null
}

// Scancode → digit (0..9) and scancode → letter index (a=0..z=25), built from the keysym
// table so they don't assume a contiguous scancode range.
const SC_DIGIT = {}
for (let d = 0; d <= 9; d++) SC_DIGIT[keys['NUM_' + d]] = d
const SC_LETTER = {}
;('ABCDEFGHIJKLMNOPQRSTUVWXYZ').split('').forEach((c, i) => { SC_LETTER[keys[c]] = i })
// hex nibble (0..15) from a digit / a..f scancode, else -1
function scToHexNibble(sc) {
    if (Object.prototype.hasOwnProperty.call(SC_DIGIT, sc)) return SC_DIGIT[sc]
    if (Object.prototype.hasOwnProperty.call(SC_LETTER, sc) && SC_LETTER[sc] < 6) return 10 + SC_LETTER[sc]
    return -1
}
// base-36 value (0..35) from a digit / a..z scancode, else -1 (effect-op column)
function scToBase36(sc) {
    if (Object.prototype.hasOwnProperty.call(SC_DIGIT, sc)) return SC_DIGIT[sc]
    if (Object.prototype.hasOwnProperty.call(SC_LETTER, sc)) return 10 + SC_LETTER[sc]
    return -1
}

// Map a 12-EDO semitone to a note word in the active tuning by snapping the semitone's
// fractional period position to the NEAREST entry of the preset's pitch table (white/black
// snapped). Returns null for the Raw preset (no table) \u2014 jamming is then disabled.
function semitoneToNote(semi, period) {
    const preset = pitchTablePresets[PITCH_PRESET_IDX]
    if (!preset || preset.table.length === 0) return null
    const interval = preset.interval
    const table    = preset.table
    let pos   = Math.round(semi / 12 * interval)
    let carry = 0
    while (pos >= interval) { pos -= interval; carry++ }   // semitone 12 wraps to next period root
    let bestIdx = 0, bestDist = Infinity
    for (let i = 0; i < table.length; i++) {
        const d = Math.abs(table[i] - pos)
        if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    // The next period's root (interval above) can be the true nearest degree near the top.
    let off = table[bestIdx], periodAdj = carry
    if ((interval - pos) < bestDist) { off = table[0]; periodAdj = carry + 1 }
    // Clamp into the playable note range (>= 0x20; below that are the special-note words).
    return Math.max(0x0020, Math.min(0xFFFF, composeNote(period + periodAdj, off, interval)))
}

// Shift a pitched note to the adjacent pitch-table degree (period-wrapping). No-op on
// special notes. Raw preset: \u00b11 raw unit.
function nudgeNoteUnit(note, dir) {
    if (!noteIsPitched(note)) return note
    const preset = pitchTablePresets[PITCH_PRESET_IDX]
    if (!preset || preset.table.length === 0) return Math.max(0x20, Math.min(0xFFFF, note + dir))
    const interval = preset.interval, table = preset.table
    const [period, off] = decomposeNote(note, interval)
    let idx = 0, best = Infinity
    for (let i = 0; i < table.length; i++) { const d = Math.abs(table[i] - off); if (d < best) { best = d; idx = i } }
    idx += dir
    let per = period
    if (idx < 0)                 { idx = table.length - 1; per -= 1 }
    else if (idx >= table.length){ idx = 0;                per += 1 }
    return Math.max(0x20, Math.min(0xFFFF, composeNote(per, table[idx], interval)))
}

// Shift a pitched note by one period (octave). No-op on special notes.
function nudgeNoteOctave(note, dir) {
    if (!noteIsPitched(note)) return note
    const preset = pitchTablePresets[PITCH_PRESET_IDX]
    const interval = (preset && preset.table.length) ? preset.interval : 0x1000
    return Math.max(0x20, Math.min(0xFFFF, note + dir * interval))
}

// \u2500\u2500 cell byte accessors (ptnDat = the 512-byte Uint8Array, row 0..63) \u2500\u2500
function cellNote(p, r)  { const o = 8*r; return p[o] | (p[o+1] << 8) }
function writeNote(p, r, n) { const o = 8*r; p[o] = n & 0xFF; p[o+1] = (n >>> 8) & 0xFF }
function cellInst(p, r)  { return p[8*r + 2] }
function writeInst(p, r, v) { p[8*r + 2] = v & 0xFF }

// Edit a vol/pan byte from one keystroke (by scancode + shift). Selector = top 2 bits
// (0=SET, 1=up/right, 2=down/left, 3=fine; fine dir bit 0x20). Empty sentinel = 0xC0.
// Physical keys: ^ = Shift+6 (vol slide up), v = V key (vol slide down), < / > = Shift+,/.
// (pan slide left/right), - / = (fine down/up), . = clear, Backspace = drop a digit.
function editVolPanByte(byte, sc, shiftDown, isPan) {
    const SEL_SET = 0, SEL_UP = 1, SEL_DOWN = 2, SEL_FINE = 3
    let sel = (byte >>> 6) & 3, arg = byte & 0x3F
    const empty = (sel === SEL_FINE && arg === 0)   // 0xC0

    if (sc === keys.PERIOD && !shiftDown) return 0xC0
    if (sc === keys.BACKSPACE) {
        if (empty) return 0xC0
        if (sel === SEL_SET) return arg >>> 4                        // shift a set-vol digit out
        const m = (arg & 0x1F) >>> 4                                 // shift a slide/fine digit out
        if (m === 0) return 0xC0
        return ((sel & 3) << 6) | (arg & 0x20) | (m & 0x1F)
    }
    // selector keys (checked before SET digits so Shift+6 is '^', not the digit 6)
    const lowArg = arg & 0x0F
    if (!isPan && shiftDown && sc === keys.NUM_6)  return (SEL_UP   << 6) | lowArg   // ^
    if (!isPan && !shiftDown && sc === keys.V)     return (SEL_DOWN << 6) | lowArg   // v
    if ( isPan && shiftDown && sc === keys.PERIOD) return (SEL_UP   << 6) | lowArg   // > (pan slide right)
    if ( isPan && shiftDown && sc === keys.COMMA)  return (SEL_DOWN << 6) | lowArg   // < (pan slide left)
    if (!shiftDown && sc === keys.MINUS)  return (SEL_FINE << 6) | Math.max(1, arg & 0x1F)         // - fine down
    if (!shiftDown && sc === keys.EQUALS) return (SEL_FINE << 6) | 0x20 | Math.max(1, arg & 0x1F)  // = fine up
    // hex digit edits the argument in the current selector's width
    if (!shiftDown) {
        const nib = scToHexNibble(sc)
        if (nib >= 0) {
            if (sel === SEL_SET || empty) return ((((empty ? 0 : arg) << 4) | nib) & 0x3F)  // SET, 2 digits
            if (sel === SEL_UP || sel === SEL_DOWN) return (sel << 6) | (nib & 0x0F)         // slide, 1 digit
            return (SEL_FINE << 6) | (arg & 0x20) | (nib & 0x1F)                             // fine magnitude
        }
    }
    return byte
}

// The shared cell editor. Mutates ptnDat at (row, col) from key event `ev`.
// `popupPos` = {y, x} of the note field (only used for the 'b' raw-hex popup).
// Returns { changed, advance, audition } \u2014 audition is a note word to jam, or -1.
function editPatternCell(ptnDat, row, col, ev, popupPos) {
    let sc = ev[3]; if (sc == 59) sc = ev[4]; if (sc == 60) sc = ev[5]; // sc = first non-shift scancode
    if (!sc) return { changed: false, advance: false, audition: -1, octave: false }
    const shiftDown = (ev.includes(59) || ev.includes(60))
    const isClear   = (sc === keys.PERIOD && !shiftDown)        // '.'
    const isBack    = (sc === keys.BACKSPACE)
    const o = 8 * row
    let changed = false, advance = false, audition = -1, octave = false

    if (col === 0) {                                   // \u2500\u2500 note \u2500\u2500
        const semi = (!shiftDown) ? jamScancodeToSemitone(sc) : null
        if (semi !== null) {
            const n = semitoneToNote(semi, editOctave)
            if (n !== null) { writeNote(ptnDat, row, n); writeInst(ptnDat, row, currentInstrument)
                              changed = true; advance = true; audition = n }
        }
        // Special notes (key-off / cut / fade / fast-fade) are inserted but not auditioned
        // (jamming a key-off through the trigger path would resolve a bogus sample).
        else if (!shiftDown && sc === keys.Z) { writeNote(ptnDat, row, 0x0001); changed = true; advance = true }
        else if (!shiftDown && sc === keys.X) { writeNote(ptnDat, row, 0x0002); changed = true; advance = true }
        else if (!shiftDown && sc === keys.C) { writeNote(ptnDat, row, 0x0003); changed = true; advance = true }
        else if (!shiftDown && sc === keys.V) { writeNote(ptnDat, row, 0x0004); changed = true; advance = true }
        else if (!shiftDown && sc === keys.B && popupPos) {
            const raw = openInlineHexEdit(popupPos.y, popupPos.x, 4, cellNote(ptnDat, row))
            if (raw !== null) { const w = raw & 0xFFFF; writeNote(ptnDat, row, w); changed = true; advance = true; if (noteIsPitched(w)) audition = w }
        }
        // [ / ] octave nudge; { / } unit nudge (Shift+[ / Shift+])
        else if (shiftDown && (sc === keys.LEFT_BRACKET || sc === keys.RIGHT_BRACKET)) {
            const cur = cellNote(ptnDat, row)
            if (noteIsPitched(cur)) { const n = nudgeNoteUnit(cur, sc === keys.LEFT_BRACKET ? -1 : 1); writeNote(ptnDat, row, n); changed = true; audition = n }
        }
        else if (!shiftDown && (sc === keys.LEFT_BRACKET || sc === keys.RIGHT_BRACKET)) {
            const dir = (sc === keys.LEFT_BRACKET) ? -1 : 1
            const cur = cellNote(ptnDat, row)
            if (noteIsPitched(cur)) { const n = nudgeNoteOctave(cur, dir); writeNote(ptnDat, row, n); editOctave = decomposeNote(n, pitchTablePresets[PITCH_PRESET_IDX].interval)[0]; changed = true; audition = n }
            // No-sound cell (< 0x20): nothing to transpose, so move the jam octave instead
            // (octave-only — refreshes the indicator without dirtying the pattern).
            else { editOctave = Math.max(1, Math.min(14, editOctave + dir)); octave = true }
        }
        else if (isClear || isBack) { writeNote(ptnDat, row, 0); changed = true }
    }
    else if (col === 1) {                              // \u2500\u2500 instrument \u2500\u2500
        const nib = (!shiftDown) ? scToHexNibble(sc) : -1
        if (nib >= 0) {
            const v = ((cellInst(ptnDat, row) << 4) | nib) & 0xFF
            writeInst(ptnDat, row, v); currentInstrument = v; changed = true
        }
        else if (isBack)  { writeInst(ptnDat, row, cellInst(ptnDat, row) >>> 4); changed = true }
        else if (isClear) { writeInst(ptnDat, row, 0); changed = true }
    }
    else if (col === 2 || col === 3) {                 // \u2500\u2500 volume / panning \u2500\u2500
        const off = (col === 2) ? o + 3 : o + 4
        const nb  = editVolPanByte(ptnDat[off], sc, shiftDown, col === 3)
        if (nb !== ptnDat[off]) { ptnDat[off] = nb & 0xFF; changed = true }
    }
    else if (col === 4) {                              // \u2500\u2500 effect op \u2500\u2500
        const v = (!shiftDown) ? scToBase36(sc) : -1
        if (v >= 0)            { ptnDat[o+5] = v & 0xFF; changed = true }
        else if (isClear || isBack) { ptnDat[o+5] = 0; changed = true }
    }
    else if (col === 5) {                              // \u2500\u2500 effect arg (16-bit) \u2500\u2500
        const cur = ptnDat[o+6] | (ptnDat[o+7] << 8)
        const nib = (!shiftDown) ? scToHexNibble(sc) : -1
        if (nib >= 0) {
            const v = ((cur << 4) | nib) & 0xFFFF
            ptnDat[o+6] = v & 0xFF; ptnDat[o+7] = (v >>> 8) & 0xFF; changed = true
        }
        else if (isBack)  { const v = cur >>> 4; ptnDat[o+6] = v & 0xFF; ptnDat[o+7] = (v >>> 8) & 0xFF; changed = true }
        else if (isClear) { ptnDat[o+6] = 0; ptnDat[o+7] = 0; changed = true }
    }

    if (changed) { patternsOutOfSync = true; if (HUB && HUB.markUnsaved) HUB.markUnsaved() }
    return { changed, advance, audition, octave }
}

// Adopt the instrument under a cell as the current instrument, if it carries one.
function adoptInstrumentFromCell(ptnDat, row) {
    const inst = cellInst(ptnDat, row)
    if (inst !== 0) currentInstrument = inst
}

// Resolve the cell currently under the edit cursor for whichever pattern panel is active.
// Returns { ptnDat, row, col, voice } or null (e.g. a timeline voice with no pattern).
function currentEditCell() {
    if (currentPanel === VIEW_TIMELINE) {
        const cue = song.cues[cueIdx]
        const pi  = cue ? cue.ptns[cursorVox] : CUE_EMPTY
        if (pi !== CUE_EMPTY && pi < song.numPats)
            return { ptnDat: song.patterns[pi], row: cursorRow, col: timelineColCursor, voice: cursorVox }
    } else if (currentPanel === VIEW_PATTERN_DETAILS) {
        if (song.numPats > 0)
            return { ptnDat: song.patterns[patternIdx], row: patternGridRow, col: patternGridCol, voice: 0 }
    }
    return null
}

// Screen position {y, x} of the note field under the edit cursor (for the 'b' raw-hex popup).
function noteFieldScreenPos() {
    if (currentPanel === VIEW_TIMELINE) {
        if (timelineRowStyle !== 0) return null   // sub-field cursor only exists in the detailed style
        const x = PTNVIEW_OFFSET_X + COLSIZE_TIMELINE_FULL * (cursorVox - voiceOff) + TL_FIELD_OFFSETS[0]
        const y = PTNVIEW_OFFSET_Y + (cursorRow - scrollRow)
        return { y, x }
    } else if (currentPanel === VIEW_PATTERN_DETAILS) {
        return { y: PTNVIEW_OFFSET_Y + (patternGridRow - patternGridScroll), x: PATEDITOR_CELL_X }
    }
    return null
}

// Toggle View/Edit mode (shared by both pattern panels). On entering edit, seed the current
// instrument from the Instruments-tab selection, then auto-adopt the cell under the cursor.
// On leaving, silence any lingering audition.
function toggleEditMode() {
    patternEditMode = !patternEditMode
    if (patternEditMode) {
        const seed = (HUB.views && HUB.views.getSelectedInstrumentSlot && HUB.views.getSelectedInstrumentSlot()) || currentInstrument
        currentInstrument = seed || 1
        const c = currentEditCell(); if (c) adoptInstrumentFromCell(c.ptnDat, c.row)
    } else if (typeof audio.jamStop === 'function') {
        audio.jamStop(PLAYHEAD)
    }
    redrawPanel(); drawAlwaysOnElems()
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
    const maxCue = ordersMaxRow()
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
                if (hi === 0xFF) {
                    bpm = Math.max(25, Math.min(535, (effarg & 0xFF) + 0x118))  // T $FFxx — extended tempo
                } else if (hi !== 0) {
                    bpm = Math.max(25, Math.min(535, hi + 0x19))
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
        const fieldFgs     = [colNote, instColour(cell._inst), colVol, colPan, colEffOp, colEffArg]
        const col = patternGridCol
        con.move(y, PATEDITOR_CELL_X + fieldOffsets[col])
        con.color_pair(fieldFgs[col], patternEditMode ? colEditHL : colHighlight)
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
    const sc          = event[3]                     // primary physical scancode (layout-independent)
    const keyJustHit = (1 == event[2])
    const shiftDown  = (event.includes(59) || event.includes(60))
    const moveDelta  = shiftDown ? 4 : 1

    // [ / ] nudges tick rate, except in edit mode on the note column (unit nudge below).
    if (keyJustHit && !shiftDown && (sc === keys.LEFT_BRACKET || sc === keys.RIGHT_BRACKET) &&
        !(patternEditMode && playbackMode === PLAYMODE_NONE && patternGridCol === 0)) {
        nudgeTickRate(sc === keys.LEFT_BRACKET ? -1 : 1); return
    }

    if (playbackMode !== PLAYMODE_NONE) {
        if ((keyJustHit && shiftDown && event.includes(keys.Y)) || keysym === " ") {
            stopPlayback(); simStateKey = ''; drawPatternsContents(wo); drawAlwaysOnElems()
        }
        return
    }

    if (keyJustHit && shiftDown && event.includes(keys.U)) { startPlayPattern(); drawPatternsContents(wo); return }
    if (              shiftDown && event.includes(keys.I)) { startPlayPatternRow(); drawPatternGrid(); return }
    if (keyJustHit && shiftDown && event.includes(keys.O)) { stopPlayback(); drawAlwaysOnElems(); return }
    // Space toggles View/Edit while stopped.
    if (keysym === " ") { if (keyJustHit) toggleEditMode(); return }

    if (song.numPats === 0) return

    // ── Edit mode: insert/jam into the current cell (discrete); View mode: audition. ──
    if (patternEditMode && keyJustHit) {
        const ptnDat = song.patterns[patternIdx]
        const res = editPatternCell(ptnDat, patternGridRow, patternGridCol, event, noteFieldScreenPos())
        if (res.changed) {
            if (res.audition >= 0 && typeof audio.jamNote === 'function')
                audio.jamNote(PLAYHEAD, 0, res.audition, currentInstrument)
            if (res.advance) { patternGridRow = Math.min(ROWS_PER_PAT - 1, patternGridRow + 1); clampPatternGrid() }
            simStateKey = ''
            drawPatternsContents(wo)
            drawAlwaysOnElems()
            return
        }
        if (res.octave) { drawAlwaysOnElems(); return }   // octave-only change: refresh the indicator
    } else if (!patternEditMode && keyJustHit && !shiftDown && jamScancodeToSemitone(sc) !== null) {
        const n = semitoneToNote(jamScancodeToSemitone(sc), editOctave)
        if (n !== null && typeof audio.jamNote === 'function') audio.jamNote(PLAYHEAD, 0, n, currentInstrument)
        return
    }

    if (keysym === '<UP>' || keysym === '<DOWN>') {
        patternGridRow += (keysym === '<UP>') ? -moveDelta : moveDelta
        clampPatternGrid()
        if (patternEditMode) { adoptInstrumentFromCell(song.patterns[patternIdx], patternGridRow); drawAlwaysOnElems() }
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

    if (keysym === '<HOME>') { patternGridRow = 0;              clampPatternGrid(); if (patternEditMode) { adoptInstrumentFromCell(song.patterns[patternIdx], patternGridRow); drawAlwaysOnElems() } simStateKey = ''; drawPatternsContents(wo); return }
    if (keysym === '<END>')  { patternGridRow = ROWS_PER_PAT-1; clampPatternGrid(); if (patternEditMode) { adoptInstrumentFromCell(song.patterns[patternIdx], patternGridRow); drawAlwaysOnElems() } simStateKey = ''; drawPatternsContents(wo); return }

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
        if (patternEditMode) { adoptInstrumentFromCell(song.patterns[patternIdx], patternGridRow); drawAlwaysOnElems() }
        simStateKey = ''
        drawPatternsContents(wo)
        return
    }
}

const panelTimeline = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, timelineInput, drawTimelineContents, undefined, ()=>{})
const panelOrders   = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, ordersInput,   drawOrdersContents,   undefined, ()=>{})
const panelPatterns = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, patternsInput, drawPatternsContents, undefined, ()=>{})

// Row offsets (within the meta block at the top of the Project panel) of the editable rows.
const PROJ_META_ROW_FLAGS = 6
const PROJ_META_ROW_GVOL  = 7
const PROJ_META_ROW_MVOL  = 8
const PROJ_META_VALUE_X   = 12

const SLIDER_TW_SMALL = 25
const SLIDER_TW_WIDE  = 36

// GlobalVol / MixingVol get the instrument-tab treatment: an editable HEX capsule
// (click or Enter → openInlineHexEdit), a visual-only decimal, and a 0..255 slider.
const PROJ_VOL_CAP_X     = PROJ_META_VALUE_X                    // hex capsule [▌$FF▐] left-cap col
const PROJ_VOL_CAP_W     = 5
const PROJ_VOL_DEC_X     = PROJ_VOL_CAP_X + 6                   // visual-only decimal
const PROJ_VOL_SLIDER_SX = PROJ_VOL_DEC_X + 8                   // slider left-pad col
const PROJ_VOL_SLIDER_TW = SLIDER_TW_SMALL//SCRW - 2 - (PROJ_VOL_SLIDER_SX + 1)  // trough ends ~2 cols from the edge

// Rebuilt by drawProjectContents; hit-tested by registerProjectMouse.
let projSliders = []

// Render one volume row (key + hex capsule + decimal + knob) and register its
// slider entry. `commit(v)` applies the new value; `metaCursor` is the keyboard
// cursor value for the row so a mouse click can sync the selection.
function drawProjVolRow(y, selected, key, val0, commit, metaCursor) {
    const sx = PROJ_VOL_SLIDER_SX, tw = PROJ_VOL_SLIDER_TW
    const render = (v) => {
        con.move(y, 2)
        con.color_pair(selected ? colWHITE : colStatus, selected ? colHighlight : 255)
        print(key)
        drawNumCapsule(y, PROJ_VOL_CAP_X, 3, '$' + v.hex02())            // editable hex
        con.move(y, PROJ_VOL_DEC_X); con.color_pair(colVoiceHdr, colBackPtn)
        const decW = PROJ_VOL_SLIDER_SX - PROJ_VOL_DEC_X
        print(('(' + v + ')' + ' '.repeat(decW)).substring(0, decW))     // visual-only decimal
        drawSlider(y, sx, tw, v / 255)
    }
    render(val0)
    const entry = {
        y, sx, tw, troughLeftPx: sx * CELL_PW, min: 0, max: 255,
        numY: y, numX: PROJ_VOL_CAP_X, numW: PROJ_VOL_CAP_W,
        val: val0, render, commit, repaint: redrawPanel, metaCursor
    }
    entry.editHex = () => {
        const nv = openInlineHexEdit(y, PROJ_VOL_CAP_X, 2, entry.val)
        if (nv !== null) { entry.val = nv & 0xFF; commit(entry.val) }
        redrawPanel()
    }
    projSliders.push(entry)
}

function projTroughAt(cy, cx) {
    for (let i = 0; i < projSliders.length; i++) {
        const s = projSliders[i]
        if (cy === s.y && cx >= s.sx && cx <= s.sx + s.tw + 1) return s
    }
    return null
}
function projCapsuleAt(cy, cx) {
    for (let i = 0; i < projSliders.length; i++) {
        const s = projSliders[i]
        if (cy === s.numY && cx >= s.numX && cx < s.numX + s.numW) return s
    }
    return null
}

function drawProjectContents(wo) {
    projSliders.length = 0
    fillLine(PTNVIEW_OFFSET_Y - 1, colVoiceHdr, 255)
    for (let y = PTNVIEW_OFFSET_Y; y < SCRH; y++) fillLine(y, colBackPtn, 255)

    let mixerflag = initialTrackerMixerflags
    let toneModeStr = ['Linear pitch','Amiga pitch','Linear freq',''][mixerflag & 3]
    let intpModeStr = ['Default','None','A500','A1200','SNES','DPCM','',''][(mixerflag >>> 2) & 7]
    let flagStrSelected = [toneModeStr, intpModeStr]
    let projMeta = {
        Filename: (currentFilePath ? currentFilePath.split('\\').last() : '(untitled)'),
        ProjName: songsMeta.projectName || '(unnamed)',
        Patterns: `${song.numPats}/4095 ($${song.numPats.hex03()})`,
        Cues: `${song.lastActiveCue}/1024 ($${song.lastActiveCue.hex03()})`,
        Samples: sampleRamSummary(),
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
        const rowY = PTNVIEW_OFFSET_Y + index
        if (index === PROJ_META_ROW_GVOL) {
            drawProjVolRow(rowY, projectCursor === PROJ_META_GVOL, key, initialGlobalVolume, (v) => {
                initialGlobalVolume = v & 0xFF; audio.setSongGlobalVolume(PLAYHEAD, initialGlobalVolume); hasUnsavedChanges = true
            }, PROJ_META_GVOL)
            return
        }
        if (index === PROJ_META_ROW_MVOL) {
            drawProjVolRow(rowY, projectCursor === PROJ_META_MVOL, key, initialMixingVolume, (v) => {
                initialMixingVolume = v & 0xFF; audio.setSongMixingVolume(PLAYHEAD, initialMixingVolume); hasUnsavedChanges = true
            }, PROJ_META_MVOL)
            return
        }
        con.move(rowY, 2)
        con.color_pair(colStatus, 255); print(key)
        con.move(rowY, PROJ_META_VALUE_X)
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

const PROJ_SONGLIST_Y = PTNVIEW_OFFSET_Y + 10   // header row of the song list
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

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// VIEWS (Samples + Instruments + live-play blob/cursor)
/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Extracted to taut_views.mjs (in-process). It is required + wired below, AFTER
// the PLAYBACK STATE section, because the module reads PLAYHEAD / PLAYMODE_NONE /
// NUM_VOICES via HUB.C and those are defined there. The panels[] array is built
// at that wiring point too, since panelSamples / panelInstrmnt need the module's
// draw / input functions. The Sample / Instrument editors are now in-process
// modals inside the module (openSampleEdit / openAdvancedInstEdit), so there is
// no editor-launch glue here any more.

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// PLAYBACK STATE
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Occupy the first idle playhead rather than always grabbing #0, so launching
// taut doesn't cut off music already playing on another playhead. Falls back to
// #0 when all four are busy.
const PLAYHEAD = audio.getFreePlayhead(0)

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
    // Byte 30 = instruction high (foreword/preamble), byte 31 = instruction low (arg).
    const instr = cue.instr || 0
    bin[30] = (instr >>> 8) & 0xFF
    bin[31] = instr & 0xFF
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

// Drop accumulated funk-repeat (S$Fx) run-state and loop-inversion masks so a fresh play
// starts deterministic instead of inheriting a prior session's funkSpeed / inverted bytes.
// Engine still keeps PT2-style persistence across a natural loop; older runtimes lacking the
// API simply retain the inversions.
function clearFunkState() {
    if (typeof audio.resetFunkState === 'function') audio.resetFunkState(PLAYHEAD)
}

function startPlaySong() {
    restoreFullSongParams()
    reuploadPatternsIfNeeded()
    audio.stop(PLAYHEAD)
    clearFunkState()
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
    clearFunkState()
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
    clearFunkState()
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
    clearFunkState()
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
    clearFunkState()
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

// Pre-typeset every panel's help text. taut_helpmsg.mjs typesets at HELP_CONTENT_W
// (passed via HUB.C) and returns ready-to-print display strings in MSG_BY_TABS.
// In-process now — no separate shell program.
HUB.C.HELP_CONTENT_W = HELP_CONTENT_W
HUB.help = requireTaut("taut_helpmsg").init(HUB)

// In-process modules read shared constants from HUB.C and delegate engine-state
// mutations through HUB callbacks, so the engine keeps owning currentPanel /
// cueIdx / patternIdx / mixer flags / the unsaved flag. The arrow wrappers resolve
// at call time, so referencing engine state defined later (applyGoto,
// initialTrackerMixerflags) is fine — modules only call them once playing.
Object.assign(HUB.C, {
    sym, PANEL_NAMES, pitchTablePresets,
    colWHITE, colPopupBack, colTabBarOrn, colTabBarBack, colTabInactive,
    colPan, colInst, colStatus, colHighlight, colVoiceHdr,
    HELP_CONTENT_W, HELP_CONTENT_H,
})
HUB.getPanel          = () => currentPanel
HUB.drawAll           = () => drawAll()
HUB.applyGoto         = (n) => applyGoto(n)
HUB.retuneAllPatterns = (idx, method) => retuneAllPatterns(idx, method)
HUB.getPitchPresetIdx = () => PITCH_PRESET_IDX
HUB.getMixerFlags     = () => initialTrackerMixerflags
HUB.commitMixerFlags  = (f) => { initialTrackerMixerflags = f; audio.setTrackerMixerFlags(PLAYHEAD, f); hasUnsavedChanges = true }
HUB.hasUnsavedChanges = () => hasUnsavedChanges

// File-tab operations (taut_fileop, filenav-driven). The File tab owns the
// popups; these do the state work and may throw (the tab reports the error).
HUB.getCurrentFilePath = () => currentFilePath
HUB.setCurrentFilePath = (p) => { currentFilePath = p }
HUB.openProject        = (path) => openProject(path)
HUB.saveProject        = (path) => saveProjectToFile(path)
HUB.newProject         = () => newProject()

HUB.popups = requireTaut("taut_popups").init(HUB)
const { openHelpPopup, openGotoPopup, openRetunePopup, openFlagsPopup, openConfirmQuit, openCueCmdPopup } = HUB.popups

// ── Views module (Samples + Instruments + blob/cursor) ──────────────────────
// Wired here (not at the VIEWS marker above) because the module reads PLAYHEAD /
// PLAYMODE_NONE / NUM_VOICES, defined in the PLAYBACK STATE section above. Expand
// HUB.C with the constants the views read, hand over the engine helpers + live-
// state getters they call, then init + alias. panels[] is built right after, as
// panelSamples / panelInstrmnt need the module's draw / input functions.
Object.assign(HUB.C, {
    SCRW, SCRH, CELL_PH, CELL_PW, VERT, NUM_VOICES, PLAYHEAD, PLAYMODE_NONE,
    PTNVIEW_HEIGHT, PTNVIEW_OFFSET_Y, SLIDER_TW_SMALL, SLIDER_TW_WIDE,
    VIEW_TIMELINE, VIEW_INSTRMNT, VIEW_SAMPLES, VIEW_FILE, fullPathObj, songsMeta,
    colBackPtn, colBLACK, colScrollBar, colSep, colTabActive, colTabBarBack2, colVol,
})
HUB.noteToStr             = noteToStr
HUB.fillLine              = fillLine
HUB.drawControlHint       = drawControlHint
HUB.drawAlwaysOnElems     = drawAlwaysOnElems
HUB.openInlineNumEdit     = openInlineNumEdit
HUB.addPanelMouseRegion   = addPanelMouseRegion
HUB.clearPanelMouseRegions   = clearPanelMouseRegions
HUB.rebuildPanelMouseRegions = rebuildPanelMouseRegions
HUB.dispatchMouseEvent       = dispatchMouseEvent
HUB.switchToPanel         = switchToPanel
HUB.getSong               = () => song
HUB.getPlaybackMode       = () => playbackMode
HUB.markUnsaved           = () => { hasUnsavedChanges = true }
// Cue command-column editing (taut_popups openCueCmdPopup): read the current cue
// instruction word and commit a new one (push to the audio adapter + mark dirty).
HUB.getCueInstr           = (ci) => song.cues[ci].instr
HUB.commitCueInstr        = (ci, instr) => { song.cues[ci].instr = instr & 0xFFFF; commitCue(ci) }
// In-process editor modals (openSampleEdit / openAdvancedInstEdit) call this each
// frame to keep playback + blobs alive while open — the whole point of going
// frame to keep playback + blobs alive while open — the whole point of going
// in-process (the old separate programs called stopPlayback on entry).
HUB.tickPlayback          = () => { if (playbackMode !== PLAYMODE_NONE) updatePlayback() }
HUB.stopPlayback          = stopPlayback

// Shared piano-jam audition for the Instruments view + Advanced Edit: if `event` is a jam
// key (a..k / w..u, no shift) and playback is stopped, audition `instSlot` at editOctave and
// return true (so the caller swallows the key). Scancode-based like the pattern-view jam.
HUB.tryJamFromEvent = function(event, instSlot) {
    if (!event || event[0] !== 'key_down' || event[2] !== 1) return false
    if (playbackMode !== PLAYMODE_NONE) return false
    if (event.includes(59) || event.includes(60)) return false           // shifted = other commands
    let sc = event[3]; if (sc == 59) sc = event[4]; if (sc == 60) sc = event[5]
    const semi = jamScancodeToSemitone(sc)
    if (semi === null) return false
    const n = semitoneToNote(semi, editOctave)
    if (n !== null && (instSlot | 0) >= 1 && typeof audio.jamNote === 'function')
        audio.jamNote(PLAYHEAD, 0, n, instSlot | 0)
    return true
}

HUB.views = requireTaut("taut_views").init(HUB)
const {
    drawSamplesContents, samplesInput, drawInstrumentsContents, instrumentsInput,
    refreshSamplesCache, refreshInstrumentsCache,
    drawSamplesPlayBlobs, drawInstrumentsPlayBlobs, drawSampleCursor, drawEnvelopeCursor, tickFunkWaveform,
    clearSampleWaveformArea, clearInstrumentsEnvelopeArea, clampSamplesCursor,
    drawSamplesUsedBy, computeSampleRAMBytes, formatSampleRamK, launchInstrumentViewerFor,
    registerInstrumentsMouse, registerSamplesMouse, sampleRamSummary,
    drawSlider, drawNumCapsule, runSliderDrag,
} = HUB.views

HUB.fileop = requireTaut("taut_fileop").init(HUB)
const panelSamples  = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, samplesInput,    drawSamplesContents,    undefined, ()=>{})
const panelInstrmnt = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, instrumentsInput, drawInstrumentsContents, undefined, ()=>{})
const panelProject  = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, projectInput,    drawProjectContents,    undefined, ()=>{})
const panelFile     = new win.WindowObject(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, HUB.fileop.input, HUB.fileop.drawContents, undefined, ()=>{})
const panels = [panelTimeline, panelOrders, panelPatterns, panelSamples, panelInstrmnt, panelProject, panelFile]

// applyGoto stays in the engine \u2014 it mutates engine cursor state (cueIdx /
// ordersCursor / ordersScroll / patternIdx). taut_popups.mjs's Go-To dialog
// calls it through HUB.applyGoto.
function applyGoto(num) {
    if (currentPanel === VIEW_TIMELINE) {
        cueIdx = num; clampCue()
    } else if (currentPanel === VIEW_CUES) {
        const maxCue = ordersMaxRow()
        ordersCursor = Math.max(0, Math.min(maxCue, num))
        if (ordersCursor < ordersScroll) ordersScroll = ordersCursor
        if (ordersCursor >= ordersScroll + PTNVIEW_HEIGHT)
            ordersScroll = Math.max(0, ordersCursor - PTNVIEW_HEIGHT + 1)
    } else if (currentPanel === VIEW_PATTERN_DETAILS) {
        patternIdx = num; clampPatternIdx()
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////////////////
// INLINE HEX EDITOR
/////////////////////////////////////////////////////////////////////////////////////////////////////////////

// White digits on a dark field, used by openInlineNumEdit below. The views module
// has its own copy of this name; both are just colWHITE.
const colInstValue = colWHITE

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

// Inline DECIMAL number editor over a raw-number capsule. `x` is the first digit
// cell (the half-block caps painted by drawNumCapsule stay put either side).
// Type digits (and '-' when min < 0); Backspace edits; Enter / click-away commits
// (clamped to [min,max]); Esc / right-click cancels. Returns the value or null.
function openInlineNumEdit(y, x, digits, initialValue, min, max) {
    let buf = String(initialValue)
    if (buf.length > digits) buf = buf.substring(0, digits)
    const allowNeg = (min < 0)
    let cancelled = false
    let done = false

    const repaint = () => {
        const shown = (buf + ' '.repeat(digits)).substring(0, digits)
        con.move(y, x)
        con.color_pair(colInstValue, colBLACK)        // white digits on the black field
        print(shown)
        const cpos = Math.min(buf.length, digits - 1)  // inverse block cursor
        con.move(y, x + cpos)
        con.color_pair(colBLACK, colInstValue)
        print(shown[cpos])
        con.color_pair(colStatus, 255)
    }

    repaint()
    let eventJustReceived = true

    // Click-away commits; clicks on the digit cells are swallowed (field stays open).
    pushMousePopup([
        { x: 1, y: 1, w: SCRW, h: SCRH, onClick: (cy, cx, btn) => {
            if (btn === 1) done = true
            else if (btn === 2) { cancelled = true; done = true }
        }},
        { x, y, w: digits, h: 1, onClick: () => {} },
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

            if (ks === '<ESC>')   { cancelled = true; done = true; return }
            if (ks === '\n')      { done = true; return }
            if (ks === '\x08')    { if (buf.length) buf = buf.substring(0, buf.length - 1); repaint(); return }
            if (ks === '-' && allowNeg) {
                buf = (buf[0] === '-') ? buf.substring(1) : ('-' + buf)
                if (buf.length > digits) buf = buf.substring(0, digits)
                repaint(); return
            }
            if (ks.length === 1 && ks >= '0' && ks <= '9') {
                if (buf === '0')  buf = ''       // a fresh digit replaces a lone 0
                if (buf === '-0') buf = '-'
                if (buf.length < digits) buf += ks
                repaint(); return
            }
        })
    }

    popMousePopup()
    if (cancelled) return null
    let v = parseInt(buf, 10)
    if (isNaN(v)) return null
    if (v < min) v = min
    if (v > max) v = max
    return v
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

// Reset hover tracking too: on a panel switch the previously-hovered region is
// about to be removed, so a stale onHoverLeave must not fire into the new panel
// (the File panel is the first to register onHover regions).
function clearPanelMouseRegions() { MOUSE_PANEL.length = 0; lastHoveredRegion = null }
function addPanelMouseRegion(x, y, w, h, handlers)  { MOUSE_PANEL.push(Object.assign({x, y, w, h}, handlers)) }
function addGlobalMouseRegion(x, y, w, h, handlers) { MOUSE_GLOBAL.push(Object.assign({x, y, w, h}, handlers)) }

// Apply the same panel-switch logic the Tab key path uses.
function switchToPanel(newPanel) {
    if (newPanel === currentPanel) return
    if (typeof audio.jamStop === 'function') audio.jamStop(PLAYHEAD)   // silence any lingering jam audition
    invalidateMetaLayerFlags()                                         // instruments may have changed
    const wasTimeline = (currentPanel === VIEW_TIMELINE)
    const wasSamples  = (currentPanel === VIEW_SAMPLES)
    const wasInstrmnt = (currentPanel === VIEW_INSTRMNT)
    currentPanel = newPanel
    applyMuteTransition(currentPanel)
    if (wasTimeline && currentPanel !== VIEW_TIMELINE) clearVoiceMeters()
    if (wasSamples  && currentPanel !== VIEW_SAMPLES)  clearSampleWaveformArea()
    if (wasInstrmnt && currentPanel !== VIEW_INSTRMNT) clearInstrumentsEnvelopeArea()
    rebuildPanelMouseRegions()
    drawAll()
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
    else if (currentPanel === VIEW_FILE)            { HUB.fileop.onEnter(); HUB.fileop.registerMouse() }
}

// registerSamplesMouse moved into taut_views.mjs (it reads samples-private state);
// rebuildPanelMouseRegions calls it via the HUB.views alias.

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
            const maxCue    = ordersMaxRow()
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
            const maxCue = ordersMaxRow()
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

// Display-row offset (cy - PTNVIEW_OFFSET_Y) of each editable meta field → its
// keyboard cursor value. The editable rows render at offsets 6/7/8.
const PROJ_META_ROW_TO_CURSOR = {
    [PROJ_META_ROW_FLAGS]: PROJ_META_FLAGS,
    [PROJ_META_ROW_GVOL] : PROJ_META_GVOL,
    [PROJ_META_ROW_MVOL] : PROJ_META_MVOL,
}

function registerProjectMouse() {
    addPanelMouseRegion(1, PTNVIEW_OFFSET_Y, SCRW, PTNVIEW_HEIGHT, {
        onClick: (cy, cx, btn, ev) => {
            if (btn !== 1 || playbackMode !== PLAYMODE_NONE) return
            // Volume rows: click the hex capsule to type, the knob to slide.
            const cap = projCapsuleAt(cy, cx)
            if (cap) { projectCursor = cap.metaCursor; cap.editHex(); return }
            const tr = projTroughAt(cy, cx)
            if (tr)  { projectCursor = tr.metaCursor; runSliderDrag(tr, ev); return }
            // Otherwise: select an editable meta field, or a song in the list.
            const metaCursor = PROJ_META_ROW_TO_CURSOR[cy - PTNVIEW_OFFSET_Y]
            if (metaCursor !== undefined) {
                projectCursor = metaCursor
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
            // Wheel over a volume knob/capsule nudges ±1 (when stopped); else scroll.
            if (playbackMode === PLAYMODE_NONE) {
                const s = projTroughAt(cy, cx) || projCapsuleAt(cy, cx)
                if (s) {
                    const nv = Math.max(s.min, Math.min(s.max, s.val + (dy < 0 ? 1 : -1)))
                    if (nv !== s.val) { s.val = nv; s.render(nv); s.commit(nv) }
                    return
                }
            }
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

let exitFlag = false

while (!exitFlag) {
    // Fullscreen app: (re)assert the raw-keyboard grab each frame so cooked chars
    // never pile into this pane's ring (they'd flood the shell on exit), and so
    // it is re-established after a sub-editor returns. input.withEvent below is
    // auto-guarded by con.isActiveConsole(), so a backgrounded editor sees no
    // input. Both are no-ops on bare metal. Released in the teardown.
    con.setFullscreen(true)
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
            if (typeof audio.jamStop === 'function') audio.jamStop(PLAYHEAD)   // silence any lingering jam audition
            invalidateMetaLayerFlags()                                         // instruments may have changed
            const wasTimeline = (currentPanel === VIEW_TIMELINE)
            const wasSamples  = (currentPanel === VIEW_SAMPLES)
            currentPanel = (currentPanel + (shiftDown ? -1 : 1))
            if (currentPanel < 0) currentPanel += panels.length
            currentPanel = currentPanel % panels.length
            applyMuteTransition(currentPanel)
            if (wasTimeline && currentPanel !== VIEW_TIMELINE) clearVoiceMeters()
            if (wasSamples  && currentPanel !== VIEW_SAMPLES)  clearSampleWaveformArea()
            rebuildPanelMouseRegions()
            drawAll()
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

    // The sample / instrument editors and the File panel are all in-process now,
    // so there is no deferred sub-program launch to drain here — the editors run
    // their own modal loop (keeping playback live) directly from the viewer input.

    if (playbackMode !== PLAYMODE_NONE) updatePlayback()
}

audio.stop(PLAYHEAD)
con.setFullscreen(false)
resetAudioDevice()
sys.free(SCRATCH_PTR)
font.resetLowRom()
font.resetHighRom()
graphics.clearPixels(255)
con.clear()
con.move(1, 1)
con.curs_set(1)
return 0