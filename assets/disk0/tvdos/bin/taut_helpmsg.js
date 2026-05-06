if (!_G.TAUT) _G.TAUT = {};
let help = {}

////////////////////////////////////////////////////////////////////////////////////////////////////

/*
Tags:
<b> - print the text in emphasis colour (colVoiceHdr aka 230)
<c> - centre the line. If the line spans multiple lines, centre each line
<r> - align right
<l> - align left
&microtone; - replace with the brand string
&bul; - replace with bullet (\u00847u)
&ddot; - replace with double-dot (\u008419u)
&mdot; - replace with BIGDOT (\u00F9)
&updn; - up-down arrow (\u008418u)
&udlr; - four direction arrow (\u008428u\u008429u)
&keyoffsym; - pattern view key-off symbol (\u00A0\u00CD\u00CD\u00A1)
&notecutsym; - pattern view note-cut symbol (\u00A4\u00A4\u00A4\u00A4)
&nbsp; - nonbreakable space (only meaningful for typesetters)
&shy; - soft hyphen (only meaningful for typesetters)
default alignment: fully justified
 */

help.notation = `<c>CONTROL NOTATON</c>

&microtone; shortcuts differentiate normal and shifted shortcuts.
&bul;a&ddot;z : alphabet without shift-in
&bul;A&ddot;Z : alphabet with shift-in
&bul;^ : control key`

////////////////////////////////////////////////////////////////////////////////////////////////////

help.jam = `<c>NOTE JAMMING</c>

Push keys to play or insert notes.
&nbsp;w&nbsp;e&nbsp;&nbsp;&nbsp;t&nbsp;y&nbsp;u&nbsp;i
a&nbsp;s&nbsp;d&nbsp;f&nbsp;g&nbsp;h&nbsp;j&nbsp;k`

////////////////////////////////////////////////////////////////////////////////////////////////////

help.common = `<c>COMMON CONTROLS</c>

&bul;Y : play the entire song from the current cue
&bul;U : play the current cue then stop
&bul;I : play the current row
&bul;O : stop the playback
&bul;tab : switch forward a tab
&bul;TAB : switch backward a tab
&bul;q : close &microtone;`

////////////////////////////////////////////////////////////////////////////////////////////////////

help.timeline = `<c>TIMELINE VIEW</c>

Timeline has two distinct modes: view and edit mode. Two modes are toggled using the space bar.

<b>View mode</b>
&bul;Note jamming : plays the note
&bul;&udlr; : move the viewing cursor by voices and rows
&bul;pg&updn; : go to previous/next cue
&bul;W&mdot;E&mdot;R : toggle timeline view mode. W-most detailed, R-most abridged
&bul;n : toggle soloing of the selected voice
&bul;m : toggle muting of the selected voice

<b>Edit mode</b>
&bul;Note jammping : (note column) inserts the note
&bul;{&mdot;} : (note column) lower/raise a note by one octave (or period)
&bul;[&mdot;] : (note column) lower/raise a note by one unit
&bul;= : (note column) insert a key-off &keyoffsym;
&bul;^ : (note column) insert a note-cut &notecutsym;
&bul;. : remove a symbol on the selected column
&bul;bksp : delete one character on the selected column
&bul;0&ddot;9 a&ddot;f : inserts a (hexa)decimal number
&bul;^&mdot;v : (volume column) slide up/down
&bul;<&mdot;> : (panning column) slide left/right
&bul;-&mdot;= : (vol/pan col) fine slide down/up
&bul;&udlr; : move the viewing cursor by columns and rows
&bul;pg&updn; : go to previous/next cue`

////////////////////////////////////////////////////////////////////////////////////////////////////

if (!_G.TAUT.HELPMSG) _G.TAUT.HELPMSG=help;

