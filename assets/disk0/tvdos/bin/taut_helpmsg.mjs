/**
 * TAUT help-text module.
 *
 * In-process replacement for the old taut_helpmsg.js sub-program. Exports
 * init(HUB) which typesets every panel's help text at HUB.C.HELP_CONTENT_W and
 * returns { MSG_BY_TABS, typeset, COL_TEXT, COL_EMPH }. taut.js stores the result
 * on HUB.help; openHelpPopup reads it.
 *
 * The help-text strings themselves are width-independent, so they live at module
 * top level; only the rule width and final typesetting depend on HUB.
 *
 * Converted from taut_helpmsg.js (separate program) on 2026-06-21. The \uXXXX
 * escapes are kept verbatim from the original — TSVM's string parser is not
 * Unicode and treats raw bytes differently from escapes, so do not normalise them.
 */

let ts = require("typesetter")

////////////////////////////////////////////////////////////////////////////////////////////////////

/*
Tags:
<b> - print the text in emphasis colour (colVoiceHdr aka 230)
<s> - print the text in deemphasis colour (248)
<c> - centre the line. If the line spans multiple lines, centre each line
<r> - align right
<l> - align left
<o> - create virtual typesetting box. Left anchor: where the text cursor is. Right anchor: end of the line
&microtone; - replace with the brand string (<col 211>Micro</col><col 239>tone</col>)

&bul; - replace with bullet (\u00F9)
&ddot; - replace with double-dot (\u008419u)
&mdot; - replace with BIGDOT (\u00FA)
&updn; - up-down arrow (\u008418u)
&udlr; - four direction arrow (\u008428u\u008429u)

&keyoffsym; - pattern view key-off symbol (\u00A0\u00B1\u00B1\u00A1)
&notecutsym; - pattern view note-cut symbol (\u00A4\u00A4\u00A4\u00A4)

&demisharp;
&sharp;
&sesquisharp;
&doublesharp;
&triplesharp;
&quadsharp;
&demiflat;
&flat;
&sesquiflat;
&doubleflat;
&tripleflat;
&quadflat;
&accuptick;
&accdntick;
&accupup;
&accdndn;

&nbsp; - nonbreakable space (only meaningful for typesetters)
&shy; - soft hyphen (only meaningful for typesetters)

default alignment: fully justified
 */

let helpNotation = `<c>CONTROL NOTATION</c>
<c>\u00B7${'\u00B8'.repeat(16)}\u00B9</c>
&microtone; <O>shortcuts differentiate normal and shifted shortcuts.</O>
&bul;<b>a</b>&ddot;<b>z</b> : <O>alphabet without shift-in</O>
&bul;<b>A</b>&ddot;<b>Z</b> : <O>alphabet with shift-in</O>
&bul;<b>^q</b> : <O>hit 'q' with control key</O>
&bul;<b>^Q</b> : <O>hit 'q' with control and shift key</O>
`

////////////////////////////////////////////////////////////////////////////////////////////////////

let helpJam = `<c>NOTE JAMMING</c>
<c>\u00B7${'\u00B8'.repeat(12)}\u00B9</c>
Push keys to play or insert notes.
&nbsp;w&nbsp;e&nbsp;&nbsp;&nbsp;t&nbsp;y&nbsp;u
a&nbsp;s&nbsp;d&nbsp;f&nbsp;g&nbsp;h&nbsp;j&nbsp;k
`

////////////////////////////////////////////////////////////////////////////////////////////////////

let helpCommon = `<c>COMMON CONTROLS</c>
<c>\u00B7${'\u00B8'.repeat(15)}\u00B9</c>
&bul;<b>!</b> : <O>show this help message</O>
&bul;<b>Y</b> : <O>plays the entire song from the current cue</O>
&bul;<b>U</b> : <O>plays the current cue then stop</O>
&bul;<b>I</b> : <O>plays the current row</O>
&bul;<b>O</b> : <O>stops the playback</O>
&bul;<b>ent</b> : <O>(Timeline/Patterns) plays from the cursor row; while playing, stops</O>
&bul;<b>ENT</b> : <O>(Timeline) plays the song from the very beginning; (Patterns) previews the pattern from the top</O>
&bul;<b>^ent</b> : <O>(Timeline) plays from the current cue</O>
&bul;<b>tab</b> : <O>switchs forward a tab</O>
&bul;<b>TAB</b> : <O>switchs backward a tab</O>
&bul;<b>q</b> : <O>closes &microtone;</O>
`

////////////////////////////////////////////////////////////////////////////////////////////////////

let helpTimeline = `<c>TIMELINE VIEW</c>
<c>\u00B7${'\u00B8'.repeat(13)}\u00B9</c>
Timeline has two distinct modes: view and edit mode. Two modes are toggled using the space bar.

<b>&nbsp;VIEW MODE</b>
<b>\u00B7${'\u00B8'.repeat(9)}\u00B9</b>
&bul;Note jamming : <O>plays the note</O>
&bul;<b>&udlr;</b> : <O>moves the viewing cursor by voices and rows</O>
&bul;<b>pg&updn;</b> : <O>goes to previous/next cue</O>
&bul;<b>W</b>&mdot;<b>E</b>&mdot;<b>R</b> : <O>toggles timeline view mode. W-most detailed, R-most abridged</O>
&bul;<b>N</b> : <O>toggles the note column between notation and raw hex (also in Patterns)</O>
&bul;<b>n</b> : <O>toggles soloing of the selected voice</O>
&bul;<b>m</b> : <O>toggles muting of the selected voice</O>
&bul;<b>[</b>&mdot;<b>]</b> : <O>changes the jam octave (while playing: changes tick rate of playhead)</O>
&bul;<b>{</b>&mdot;<b>}</b> : <O>changes the current instrument</O>

<b>&nbsp;EDIT MODE</b>
<b>\u00B7${'\u00B8'.repeat(9)}\u00B9</b>
&bul;Note jamming : <O>(note column) inserts the note</O>
&bul;<b>[</b>&mdot;<b>]</b> : <O>(note column) lowers/raises a note by one octave (or period); (inst column) previous/next instrument; (vol/pan column) nudges the value</O>
&bul;<b>{</b>&mdot;<b>}</b> : <O>(note column) lowers/raises a note by one unit; (vol/pan column) fine-slide nudge</O>
&bul;<b>z</b>&mdot;<b>\`</b> : <O>(note column) inserts a key-off &keyoffsym;</O>
&bul;<b>x</b> : <O>(note column) inserts a note-cut &notecutsym;</O>
&bul;<b>c</b> : <O>(note column) inserts a note fade &notefadesym;</O>
&bul;<b>v</b> : <O>(note column) inserts a fast fade &notefastfadesym;</O>
&bul;<b>b</b> : <O>(note column) inserts a note by raw hexadecimal (popup)</O>
&bul;<b>0</b>&ddot;<b>9</b> <b>a</b>&ddot;<b>f</b> : <O>(note column, raw-hex display) types the note word digit by digit</O>
&bul;<b>.</b> : <O>clears fields</O>
&bul;<b>bksp</b> : <O>deletes one character on the selected column</O>
&bul;<b>0</b>&ddot;<b>9</b> <b>a</b>&ddot;<b>f</b> : <O>inserts a (hexa)decimal number</O>
&bul;<b>0</b>&ddot;<b>9</b> <b>a</b>&ddot;<b>z</b> : <O>(fx column) inserts an effect</O>
&bul;<b>^</b>&mdot;<b>v</b> : <O>(volume column) slide up/down</O>
&bul;<b>&lt;</b>&mdot;<b>&gt;</b>: <O>(panning column) slide left/right</O>
&bul;<b>-</b>&mdot;<b>=</b> : <O>(vol/pan col) fine slide down/up</O>
&bul;<b>&udlr;</b> : <O>moves the viewing cursor by columns and rows</O>
&bul;<b>pg&updn;</b> : <O>goes to previous/next cue</O>

<b>&nbsp;ACCIDENTALS</b>
<b>\u00B7${'\u00B8'.repeat(11)}\u00B9</b>
&demisharp;&nbsp;&sharp;&nbsp;&doublesharp;&nbsp;&triplesharp;&nbsp;&quadsharp;&nbsp;&demiflat;&nbsp;&flat;&nbsp;&doubleflat;&nbsp;&tripleflat;&nbsp;&nbsp;&accuptick;&nbsp;&nbsp;&accupup;&nbsp;&nbsp;&accdntick;&nbsp;&nbsp;&accdndn;
<b>C&nbsp;&nbsp;c&nbsp;&nbsp;cx&nbsp;x&nbsp;&nbsp;xx&nbsp;B&nbsp;&nbsp;b&nbsp;&nbsp;bb&nbsp;bbb&nbsp;^&nbsp;&nbsp;^^&nbsp;v&nbsp;&nbsp;vv</b>

<b>&nbsp;GLOBAL EDIT</b>
<b>\u00B7${'\u00B8'.repeat(11)}\u00B9</b>
&bul;<b>Q</b> : <O>retunes current song into different tuning and strategy. In general, nearest-note works best for macrotonals, nearest-harmonic and nearest-delta works best for highly microtonals (31+); 17- and 19-TET takes nearest-harmonic pretty well, while 22-TET seem to only benefit from the nearest-note</O>
`

let helpCues = `<c>CUES VIEW</c>
<c>\u00B7${'\u00B8'.repeat(9)}\u00B9</c>
The cue sheet (order list) sequences patterns into a song. Each cue row plays the listed pattern of every voice at once; the two command columns (Cmd1, Cmd2) drive playback flow — a cue may carry up to two commands (e.g. a Pattern-length plus a Jump).

<b>&nbsp;NAVIGATION</b>
<b>\u00B7${'\u00B8'.repeat(11)}\u00B9</b>
&bul;<b>&udlr;</b> : <O>moves the cursor by cue rows and columns</O>
&bul;<b>Y</b> : <O>plays the entire song from the selected cue</O>
&bul;<b>U</b> : <O>plays the selected cue then stop</O>
&bul;<b>ent</b> : <O>(voice column) jumps to the selected cue in the Timeline</O>

<b>&nbsp;EDITING</b>
<b>\u00B7${'\u00B8'.repeat(9)}\u00B9</b>
&bul;<b>0</b>&ddot;<b>9</b> <b>a</b>&ddot;<b>f</b> : <O>(voice column) types the pattern number</O>
&bul;<b>-</b> : <O>(voice column) clears the cell to empty</O>
&bul;<b>bksp</b> : <O>(voice column) deletes one digit</O>
&bul;<b>ent</b> : <O>(Cmd1 / Cmd2 column) opens the command editor for that slot (popup)</O>
A blank row past the last cue is always available so a new cue can be appended.

<b>&nbsp;COMMANDS</b>
<b>\u00B7${'\u00B8'.repeat(10)}\u00B9</b>
&bul;<b>No-op</b> : <O>no action</O>
&bul;<b>Pattern length</b> : <O>set this cue's length to N+1 rows</O>
&bul;<b>Fade out at</b> : <O>fade global volume to zero by row N, then stop</O>
&bul;<b>Halt at end</b> : <O>play the full pattern, then stop</O>
&bul;<b>Halt at row</b> : <O>play up to row N then stop (0 = full)</O>
&bul;<b>Go back</b>&mdot;<b>Skip forward</b> : <O>jump N cues backward/forward</O>
&bul;<b>Jump to cue</b> : <O>jump to absolute cue N (loop)</O>
`

let helpPatterns = `<c>PATTERNS VIEW</c>
<c>\u00B7${'\u00B8'.repeat(13)}\u00B9</c>
Multi-pane pattern editor: up to three patterns side by side, each pane with its own pattern and scroll. The ACTIVE pane carries the cursor (and the preview); <b>&lt;-</b>&mdot;<b>-&gt;</b> at a cell edge crosses into the next pane, a click focuses a pane, and the wheel scrolls the pane under it without stealing focus. View/Edit modes and the cell editing keys are the same as the Timeline (see its help on the Timeline tab); <b>pg&updn;</b> walks the ACTIVE pane's pattern.

<b>&nbsp;PATTERN TOOLS (P)</b>
<b>\u00B7${'\u00B8'.repeat(17)}\u00B9</b>
&bul;<b>Duplicate pattern</b> : <O>appends a copy of this pattern after the last one</O>
&bul;<b>Transpose</b> : <O>moves every note by N degree steps of the active notation plus M whole periods; percussion and special notes are skipped</O>
&bul;<b>Lengthen xN</b> : <O>row r moves to row rxN with blank rows between (IT Alt-F, any factor)</O>
&bul;<b>Shorten /N</b> : <O>row rxN moves to row r, the rows between are dropped (IT Alt-G, any factor)</O>
&bul;<b>Volume scale</b> : <O>v = vxmult%+add on every non-empty volume, selector kept</O>
&bul;<b>Pan transform</b> : <O>widens/narrows pans about centre by mult% (negative swaps L/R), then shifts; empty cells stay empty</O>
&bul;<b>Change instrument</b> : <O>remaps the instrument column (blank From = every non-empty cell)</O>
`

////////////////////////////////////////////////////////////////////////////////////////////////////

let helpInstruments = `<c>INSTRUMENTS VIEW</c>
<c>\u00B7${'\u00B8'.repeat(16)}\u00B9</c>
Left list selects the instrument (note jamming plays it); tabs Gen.1/Gen.2 hold sliders and checkboxes, Volume/Pan/Pitch/Filter hold the EDITABLE envelope graphs.

<b>&nbsp;ENVELOPE EDITING</b>
<b>\u00B7${'\u00B8'.repeat(16)}\u00B9</b>
Drag a node on the graph with the mouse: vertical = value, horizontal = the preceding segment's duration (minifloat-quantised; node 0 is fixed at t=0). The rightmost fifth of the plot is headroom — drag the last node into it to extend the envelope. Keyboard:
&bul;<b>,</b>&mdot;<b>.</b> : <O>selects the previous/next node</O>
&bul;<b>-</b>&mdot;<b>=</b> : <O>node value down/up (<b>_</b>&mdot;<b>+</b> in steps of 8)</O>
&bul;<b>[</b>&mdot;<b>]</b> : <O>preceding-segment duration down/up (<b>{</b>&mdot;<b>}</b> coarse)</O>
&bul;<b>n</b> : <O>adds a node after the selection (splits the segment / extends the tail)</O>
&bul;<b>x</b> : <O>deletes the selected node (node 0 stays; deleting the last one truncates)</O>
&bul;<b>o</b> : <O>edits the envelope LOOP (enable + start/end node indices, dialog)</O>
&bul;<b>p</b> : <O>edits the envelope SUSTAIN (enable + start/end node indices, dialog)</O>
Editing an inactive Pitch/Filter envelope first CLAIMS its slot (Present + role bit) — same as ticking Present.

<b>&nbsp;ADVANCED EDIT</b>
<b>\u00B7${'\u00B8'.repeat(13)}\u00B9</b>
Enter / <b>E</b> on an instrument opens the Ixmp patch editor: <b>N</b>/<b>C</b>/<b>X</b> new/duplicate/delete patch, <b>K</b>/<b>J</b> reorder (match priority), <b>E</b> zone rect, <b>T</b> tuning/level, <b>L</b> play/loop, <b>S</b> bind a pooled sample, <b>O</b> toggles the shown envelope kind's OVERRIDE on the patch (on = copies the base envelope; the same node keys then edit the patch's own copy).
On a METAINSTRUMENT the same keys edit its LAYERS instead: <b>N</b>/<b>C</b>/<b>X</b> new/duplicate/delete layer (new opens the child-instrument picker), <b>K</b>/<b>J</b> reorder (layer 0 is the foreground layer), <b>E</b> layer rect, <b>T</b> mix/detune (mix octet: 159 = 0 dB), <b>S</b> re-bind the child instrument, <b>G</b> toggles strict gating.
`

////////////////////////////////////////////////////////////////////////////////////////////////////

let helpProjectFlags = `<c>MIXER FLAGS</c>
<c>\u00B7${'\u00B8'.repeat(11)}\u00B9</c>
Mixer flags define how should the mixer behave.

<b>&nbsp;TONE MODE</b>
<b>\u00B7${'\u00B8'.repeat(9)}\u00B9</b>
&bul;Linear pitch : <O>pitch shift effects operate on linear pitch scale. The default and recommended setting for a new project</O>
&bul;Amiga pitch : <O>pitch shift effects operate on Amiga period scale. Backwards compatible setting for MOD/S3M/XM/IT formats</O>
&bul;Linear freq : <O>pitch shift effects operate on linear frequency scale. Backwards compatible setting for MONOTONE format</O>

<b>&nbsp;INTERPOLATION</b>
<b>\u00B7${'\u00B8'.repeat(13)}\u00B9</b>
&bul;Default : <O>three-tap fast sinc interpolation. The default and recommended setting for a new project</O>
&bul;None : <O>zeroth-order hold</O>
&bul;A500 : <O>emulates what Paula chip of Amiga 500 does. <b>S 0x00</b> effects only work with this and Amiga 1200 mode</O>
&bul;A1200 : <O>emulates what Paula chip of Amiga 1200 does</O>
&bul;SNES : <O>four-tap gaussian interpolation used by SNES</O>
&bul;DPCM : <O>simulates Differential Pulse Code Modulation used by NES</O>
`

////////////////////////////////////////////////////////////////////////////////////////////////////

// assemble help text pieces to complete help message
function init(HUB) {
    const W = HUB.C.HELP_CONTENT_W

    const HRULE = '<s>' + '\u00B3'.repeat(W) + '</s>\n'

    // taut.js's popup uses (HELP_COL_TEXT on background) as the default colour pair.
    // The shared typesetter module owns the palette and the markup expander.
    function typeset(text) {
        return ts.typeset(text, W)
    }

    let helpMessages = [ // index: taut.js PANEL_NAMES
    /* Timeline */[helpJam, helpTimeline, helpCommon, helpNotation].join(HRULE),
    /* Cues */[helpCues, helpCommon, helpNotation].join(HRULE),
    /* Patterns */[helpJam, helpPatterns, helpCommon, helpNotation].join(HRULE),
    /* Samples */[helpCommon, helpNotation].join(HRULE), // placeholder
    /* Instruments */[helpInstruments, helpCommon, helpNotation].join(HRULE),
    /* Project */[helpProjectFlags, helpCommon, helpNotation].join(HRULE), // placeholder
    /* File */[helpCommon, helpNotation].join(HRULE), // placeholder
]

    return {
        MSG_BY_TABS: helpMessages.map(it => typeset(it)),
        typeset:     typeset,
        COL_TEXT:    ts.COL_TEXT,
        COL_EMPH:    ts.COL_EMPH,
    }
}

exports = { init }
