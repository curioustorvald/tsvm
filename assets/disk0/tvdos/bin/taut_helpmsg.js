if (!_G.TAUT) _G.TAUT = {};
let help = {}

////////////////////////////////////////////////////////////////////////////////////////////////////

/*
Tags:
<b> - print the text in emphasis colour (colVoiceHdr aka 230)
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
&bul;<b>Y</b> : <O>play the entire song from the current cue</O>
&bul;<b>U</b> : <O>play the current cue then stop</O>
&bul;<b>I</b> : <O>play the current row</O>
&bul;<b>O</b> : <O>stop the playback</O>
&bul;<b>tab</b> : <O>switch forward a tab</O>
&bul;<b>TAB</b> : <O>switch backward a tab</O>
&bul;<b>q</b> : <O>close &microtone;</O>
`

////////////////////////////////////////////////////////////////////////////////////////////////////

let helpTimeline = `<c>TIMELINE VIEW</c>
<c>\u00B7${'\u00B8'.repeat(13)}\u00B9</c>
Timeline has two distinct modes: view and edit mode. Two modes are toggled using the space bar.

<b>&nbsp;VIEW MODE</b>
<b>\u00B7${'\u00B8'.repeat(9)}\u00B9</b>
&bul;Note jamming : <O>plays the note</O>
&bul;<b>&udlr;</b> : <O>move the viewing cursor by voices and rows</O>
&bul;<b>pg&updn;</b> : <O>go to previous/next cue</O>
&bul;<b>W</b>&mdot;<b>E</b>&mdot;<b>R</b> : <O>toggle timeline view mode. W-most detailed, R-most abridged</O>
&bul;<b>n</b> : <O>toggle soloing of the selected voice</O>
&bul;<b>m</b> : <O>toggle muting of the selected voice</O>
&bul;<b>[</b>&mdot;<b>]</b> : <O>change tick rate of playhead</O> 

<b>&nbsp;EDIT MODE</b>
<b>\u00B7${'\u00B8'.repeat(9)}\u00B9</b>
&bul;Note jamming : <O>(note column) inserts the note</O>
&bul;<b>{</b>&mdot;<b>}</b> : <O>(note column) lower/raise a note by one octave (or period)</O>
&bul;<b>[</b>&mdot;<b>]</b> : <O>(note column) lower/raise a note by one unit</O>
&bul;<b>z</b> : <O>(note column) insert a key-off &keyoffsym;</O>
&bul;<b>x</b> : <O>(note column) insert a note-cut &notecutsym;</O>
&bul;<b>.</b> : <O>clear fields</O>
&bul;<b>bksp</b> : <O>delete one character on the selected column</O>
&bul;<b>0</b>&ddot;<b>9</b> <b>a</b>&ddot;<b>f</b> : <O>inserts a (hexa)decimal number</O>
&bul;<b>0</b>&ddot;<b>9</b> <b>a</b>&ddot;<b>z</b> : <O>(fx column) inserts an effect</O>
&bul;<b>^</b>&mdot;<b>v</b> : <O>(volume column) slide up/down</O>
&bul;<b>&lt;</b>&mdot;<b>&gt;</b>: <O>(panning column) slide left/right</O>
&bul;<b>-</b>&mdot;<b>=</b> : <O>(vol/pan col) fine slide down/up</O>
&bul;<b>&udlr;</b> : <O>move the viewing cursor by columns and rows</O>
&bul;<b>pg&updn;</b> : <O>go to previous/next cue</O>

<b>&nbsp;ACCIDENTALS</b>
<b>\u00B7${'\u00B8'.repeat(11)}\u00B9</b>
&demisharp;&nbsp;&sharp;&nbsp;&doublesharp;&nbsp;&triplesharp;&nbsp;&quadsharp;&nbsp;&demiflat;&nbsp;&flat;&nbsp;&doubleflat;&nbsp;&tripleflat;&nbsp;&nbsp;&accuptick;&nbsp;&nbsp;&accupup;&nbsp;&nbsp;&accdntick;&nbsp;&nbsp;&accdndn;
<b>C&nbsp;&nbsp;c&nbsp;&nbsp;cx&nbsp;x&nbsp;&nbsp;xx&nbsp;B&nbsp;&nbsp;b&nbsp;&nbsp;bb&nbsp;bbb&nbsp;^&nbsp;&nbsp;^^&nbsp;v&nbsp;&nbsp;vv</b>

<b>&nbsp;GLOBAL EDIT</b>
<b>\u00B7${'\u00B8'.repeat(11)}\u00B9</b>
&bul;<b>Q</b> : <O>retune current song into different tuning</O>
`

////////////////////////////////////////////////////////////////////////////////////////////////////

// assemble help text pieces to complete help message

const SCRW = con.getmaxyx()[1]
const HRULE = '\u00B4\u00B5'.repeat((_G.TAUT.HELPMSG_WIDTH) >>> 1) + '\n'

// Display-command palette. taut.js's popup uses (HELP_COL_TEXT on background) as the
// default colour pair, so embedded `\x1B[38;5;Nm` codes switch foreground only.
const HELP_COL_TEXT      = 239 // popup body default (== colWHITE)
const HELP_COL_EMPH      = 230 // <b>...</b> highlight (== colVoiceHdr)
const HELP_COL_BRAND     = 211 // first half of "Microtone"
const HELP_COL_BRAND_DIM = 239 // second half of "Microtone"

const fgEsc = (n) => `\x1B[38;5;${n}m`
const ESC_DEFAULT = fgEsc(HELP_COL_TEXT)
const ESC_EMPH    = fgEsc(HELP_COL_EMPH)
const MICROTONE   = `${fgEsc(HELP_COL_BRAND)}Micro${fgEsc(HELP_COL_BRAND_DIM)}tone${ESC_DEFAULT}`

// Replace &xxx; entities with their final printable representations.
function expandEntities(s) {
    return s
        .replaceAll('&microtone;',  MICROTONE)
        .replaceAll('&bul;',        '\u00F9')
        .replaceAll('&ddot;',       '\u008419u')
        .replaceAll('&mdot;',       '\u00FA')
        .replaceAll('&updn;',       '\u008418u')
        .replaceAll('&udlr;',       '\u008428u\u008429u')
        .replaceAll('&keyoffsym;',  '\u00A0\u00B1\u00B1\u00A1')
        .replaceAll('&notecutsym;', '\u00A4\u00A4\u00A4\u00A4')
        .replaceAll('&nbsp;',       '\u007F')
        .replaceAll('&shy;',        '')
        .replaceAll('&lt;',        '<')
        .replaceAll('&gt;',        '>')
        .replaceAll('&demisharp;',   '\u0080\u0081')
        .replaceAll('&sharp;',       '\u0082\u0083')
        .replaceAll('&sesquisharp;', '\u0084132u\u0085')
        .replaceAll('&doublesharp;', '\u0086\u0087')
        .replaceAll('&triplesharp;', '\u0088\u0089')
        .replaceAll('&quadsharp;',   '\u008A\u008B')
        .replaceAll('&demiflat;',    '\u008C\u008D')
        .replaceAll('&flat;',        '\u008E\u008F')
        .replaceAll('&sesquiflat;',  '\u0090\u0091')
        .replaceAll('&doubleflat;',  '\u0092\u0093')
        .replaceAll('&tripleflat;',  '\u0094\u0095')
        .replaceAll('&quadflat;',    '\u0096\u0097')
        .replaceAll('&accuptick;',    '\u009A')
        .replaceAll('&accdntick;',    '\u009B')
        .replaceAll('&accupup;',    '\u009C')
        .replaceAll('&accdndn;',    '\u009D')
}

// Tokenise a (post-entity-expansion) line. Returns an array of:
//   {type:'word',   text:String, w:int}  - non-breakable run of visible chars (may carry ANSI escapes)
//   {type:'sp'}                          - a single soft space (eligible for break/expansion)
//   {type:'anchor', open:Boolean}        - <o>/</o> markers (zero width)
//
// Width accounting:
//   - ANSI escapes (`\x1B[...m`)         : 0 visible chars
//   - TSVM unicode escapes (`..u`) : 1 visible char
//   - non-breaking space ( )        : 1 visible char (consumed as part of a word)
//   - soft hyphen (­)               : dropped (not implemented as a break point)
//   - everything else                    : 1 visible char
function tokenise(line) {
    const tokens = []
    let buf = ''
    let bufW = 0
    let i = 0

    const flushWord = () => {
        if (buf.length > 0) {
            tokens.push({type: 'word', text: buf, w: bufW})
            buf = ''
            bufW = 0
        }
    }

    while (i < line.length) {
        // inline tags (case-sensitive for <b>, case-insensitive for <o>)
        if (line.slice(i, i + 3) === '<b>')  { buf += ESC_EMPH;    i += 3; continue }
        if (line.slice(i, i + 4) === '</b>') { buf += ESC_DEFAULT; i += 4; continue }
        const head3 = line.slice(i, i + 3).toLowerCase()
        const head4 = line.slice(i, i + 4).toLowerCase()
        if (head3 === '<o>')  { flushWord(); tokens.push({type: 'anchor', open: true});  i += 3; continue }
        if (head4 === '</o>') { flushWord(); tokens.push({type: 'anchor', open: false}); i += 4; continue }

        const c  = line[i]
        const cc = line.charCodeAt(i)

        if (cc === 0x1B) {
            // pre-existing ANSI escape - copy verbatim, zero visible width
            const m = line.indexOf('m', i)
            const end = (m < 0) ? line.length : m + 1
            buf += line.slice(i, end)
            i = end
        }
        else if (cc === 0x84) {
            // TSVM <digits>u escape - copy verbatim, one visible char
            const u = line.indexOf('u', i)
            const end = (u < 0) ? line.length : u + 1
            buf += line.slice(i, end)
            bufW += 1
            i = end
        }
        else if (c === ' ') {
            flushWord()
            tokens.push({type: 'sp'})
            i += 1
        }
        else if (cc === 0x00AD) {
            // soft hyphen: drop (no break-point handling for now)
            i += 1
        }
        else {
            buf += c
            bufW += 1
            i += 1
        }
    }
    flushWord()
    return tokens
}

// Build wrapped lines from a token stream then format each one according to alignment.
// Returns an array of strings, each exactly `width` visible chars wide (padded with
// trailing spaces) so the caller can blit them without further math.
function wrapAndAlign(tokens, width, alignment) {
    const lines = [] // each: {tokens, indent, contentW}
    let curTokens = []
    let curW = 0
    let curIndent = 0
    let nextIndent = 0 // indent the *next* flushed line should use

    const flushLine = () => {
        // strip trailing soft spaces
        while (curTokens.length > 0 && curTokens[curTokens.length - 1].type === 'sp') {
            curTokens.pop()
            curW -= 1
        }
        lines.push({tokens: curTokens, indent: curIndent, contentW: curW})
        curTokens = []
        curW = 0
        curIndent = nextIndent
    }

    for (const tok of tokens) {
        if (tok.type === 'anchor') {
            // anchor opens at the current visible column (accounting for indent)
            if (tok.open) nextIndent = curIndent + curW
            else          nextIndent = 0
            continue
        }

        if (tok.type === 'sp') {
            // ignore leading soft spaces on a fresh line
            if (curW === 0) continue
            // hard wrap if the line is already at the right edge
            if (curIndent + curW + 1 > width) { flushLine(); continue }
            curTokens.push(tok)
            curW += 1
            continue
        }

        // word
        const tw = tok.w
        if (curIndent + curW + tw > width) {
            flushLine()
            // word too wide for the wrapped line: emit it on its own row (possibly clipped by terminal)
            if (curIndent + tw > width) {
                curTokens.push(tok)
                curW += tw
                flushLine()
                continue
            }
        }
        curTokens.push(tok)
        curW += tw
    }

    if (curTokens.length > 0 || lines.length === 0) flushLine()

    return lines.map((line, i) => formatLine(line, width, alignment, i === lines.length - 1))
}

function formatLine(line, totalWidth, alignment, isLast) {
    if (line.tokens.length === 0) return ' '.repeat(totalWidth)

    const indent    = ' '.repeat(line.indent)
    const remaining = totalWidth - line.indent - line.contentW
    const pad       = (n) => (n > 0) ? ' '.repeat(n) : ''
    const flatText  = () => line.tokens.map(t => (t.type === 'sp') ? ' ' : t.text).join('')

    if (alignment === 'c') {
        const left = remaining >> 1
        return indent + pad(left) + flatText() + pad(remaining - left)
    }
    if (alignment === 'r') return indent + pad(remaining) + flatText()
    if (alignment === 'l') return indent + flatText() + pad(remaining)

    // justified: only expand spaces when there's slack and we're not on the
    // last (or single) wrapped line
    if (isLast || remaining <= 0) return indent + flatText() + pad(remaining)

    const spaceCount = line.tokens.reduce((n, t) => n + (t.type === 'sp' ? 1 : 0), 0)
    if (spaceCount === 0) return indent + flatText() + pad(remaining)

    const baseExtra = (remaining / spaceCount) | 0
    let leftover    = remaining - baseExtra * spaceCount

    let out = indent
    for (const tok of line.tokens) {
        if (tok.type === 'sp') {
            const extra = baseExtra + (leftover > 0 ? 1 : 0)
            if (leftover > 0) leftover -= 1
            out += ' '.repeat(1 + extra)
        } else {
            out += tok.text
        }
    }
    return out
}

// Process a single source line: peel a leading <c>/<r>/<l> alignment tag (if present),
// strip its matching close tag, then tokenise + wrap.
function typesetSourceLine(line, width) {
    if (line.length === 0) return [' '.repeat(width)]

    let alignment = 'j' // justified default
    const startMatch = line.match(/^<([crl])>/i)
    if (startMatch) {
        alignment = startMatch[1].toLowerCase()
        line = line.slice(startMatch[0].length)
        const closeRe = new RegExp(`</${alignment}>$`, 'i')
        line = line.replace(closeRe, '')
    }

    const tokens = tokenise(line)
    return wrapAndAlign(tokens, width, alignment)
}

function typesetText(text, width) {
    text = expandEntities(text)
    const out = []
    for (const srcLine of text.split('\n')) {
        for (const outLine of typesetSourceLine(srcLine, width)) out.push(outLine)
    }
    return out
}

function typeset(text, customWidth) {
    let typesetWidth = customWidth
    if (typesetWidth === undefined) typesetWidth = _G.TAUT.HELPMSG_WIDTH
    if (typesetWidth === undefined) {
        const currentPosX = con.getyx()[1] // 1-indexed
        typesetWidth = SCRW - currentPosX + 1
    }
    return typesetText(text, typesetWidth)
}

let helpMessages = [ // index: taut.js PANEL_NAMES
    [helpJam, helpTimeline, helpCommon, helpNotation].join(HRULE),
    [helpCommon, helpNotation].join(HRULE), // placeholder
    [helpCommon, helpNotation].join(HRULE), // placeholder
    [helpCommon, helpNotation].join(HRULE), // placeholder
    [helpCommon, helpNotation].join(HRULE), // placeholder
    [helpCommon, helpNotation].join(HRULE), // placeholder
    [helpCommon, helpNotation].join(HRULE), // placeholder
]

help.MSG_BY_TABS = helpMessages.map(it => typeset(it))
help.typeset     = typeset
help.COL_TEXT    = HELP_COL_TEXT
help.COL_EMPH    = HELP_COL_EMPH

if (!_G.TAUT.HELPMSG) _G.TAUT.HELPMSG=help;
