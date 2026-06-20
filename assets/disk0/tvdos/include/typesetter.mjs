/*
 * typesetter.mjs - Rich-text typesetter for TVDOS console output.
 *
 * Wraps and aligns text using a tiny markup language. Originally lifted
 * out of taut_helpmsg.js so other tools (motd, help popups, ...) can
 * share the same formatter.
 *
 * Markup
 * ------
 *   <b>...</b>   emphasised foreground colour
 *   <b>...</b>   de-emphasised foreground colour
 *   <c>...</c>   centre-align this source line
 *   <r>...</r>   right-align this source line
 *   <l>...</l>   left-align this source line
 *   <o>...</o>   virtual typesetting box. Left anchor is the cursor
 *                column at the open tag, right anchor is the wrap edge.
 *   default alignment is fully justified (override per-call via opts).
 *
 * Entities
 * --------
 *   &microtone;          "Microtone" wordmark
 *   &bul; &ddot; &mdot;  bullet glyphs
 *   &updn; &udlr;        arrow glyphs
 *   &keyoffsym; &notecutsym;
 *   &demisharp; &sharp; &sesquisharp; &doublesharp; &triplesharp; &quadsharp;
 *   &demiflat; &flat; &sesquiflat; &doubleflat; &tripleflat; &quadflat;
 *   &accuptick; &accdntick; &accupup; &accdndn;
 *   &nbsp;               non-breaking space
 *   &shy;                soft hyphen (currently dropped)
 *   &lt; &gt;            literal angle brackets
 *
 * Usage
 * -----
 *   let ts = require("typesetter")
 *   let lines = ts.typeset(text, width)            // array of width-wide strings
 *   let lines = ts.typeset(text)                   // width = rest of current row
 *   let lines = ts.typeset(text, width, { defaultAlign: 'l' })
 */


///////////////////////////////////////////////////////////////////////////////
// Palette / ANSI helpers
///////////////////////////////////////////////////////////////////////////////

const COL_TEXT      = 239 // popup body default (== colWHITE)
const COL_EMPH      = 230 // <b>...</b> highlight (== colVoiceHdr)
const COL_DEEMPH      = 248 // <s>...</s> unhighlight
const COL_BRAND     = 211 // first half of "Microtone"
const COL_BRAND_DIM = 239 // second half of "Microtone"

const fgEsc = (n) => `\x1B[38;5;${n}m`
const ESC_DEFAULT = fgEsc(COL_TEXT)
const ESC_EMPH    = fgEsc(COL_EMPH)
const ESC_DEEMPH    = fgEsc(COL_DEEMPH)
const MICROTONE   = `${fgEsc(COL_BRAND)}Micro${fgEsc(COL_BRAND_DIM)}tone${ESC_DEFAULT}`


///////////////////////////////////////////////////////////////////////////////
// Entity expansion
///////////////////////////////////////////////////////////////////////////////

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
        .replaceAll('&nbsp;',       '\u00840u')
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


///////////////////////////////////////////////////////////////////////////////
// Tokeniser
///////////////////////////////////////////////////////////////////////////////

// Tokenise a (post-entity-expansion) line. Returns an array of:
//   {type:'word',   text:String, w:int}  - non-breakable run of visible chars (may carry ANSI escapes)
//   {type:'sp'}                          - a single soft space (eligible for break/expansion)
//   {type:'anchor', open:Boolean}        - <o>/</o> markers (zero width)
//
// Width accounting:
//   - ANSI escapes (`\x1B[...m`)         : 0 visible chars
//   - TSVM unicode escapes (`\u0084..u`) : 1 visible char
//   - non-breaking space (' ')        : 1 visible char (consumed as part of a word)
//   - soft hyphen (\u00AD)               : dropped (not implemented as a break point)
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
        if (line.slice(i, i + 3) === '<s>')  { buf += ESC_DEEMPH;    i += 3; continue }
        if (line.slice(i, i + 4) === '</s>') { buf += ESC_DEFAULT; i += 4; continue }
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
            // TSVM \u0084<digits>u escape - copy verbatim, one visible char
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


///////////////////////////////////////////////////////////////////////////////
// Line builder
///////////////////////////////////////////////////////////////////////////////

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
function typesetSourceLine(line, width, defaultAlign) {
    if (line.length === 0) return [' '.repeat(width)]

    let alignment = defaultAlign || 'j' // justified default
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

function typesetText(text, width, defaultAlign) {
    text = expandEntities(text)
    const out = []
    for (const srcLine of text.split('\n')) {
        for (const outLine of typesetSourceLine(srcLine, width, defaultAlign)) out.push(outLine)
    }
    return out
}

// Convenience entry: `typeset(text)` defaults the wrap width to "rest of current row".
// `opts` may be `{ defaultAlign: 'l' | 'c' | 'r' | 'j' }`.
function typeset(text, customWidth, opts) {
    let typesetWidth = customWidth
    if (typesetWidth === undefined) {
        const SCRW = con.getmaxyx()[1]
        const currentPosX = con.getyx()[1] // 1-indexed
        typesetWidth = SCRW - currentPosX + 1
    }
    let defaultAlign = (opts && opts.defaultAlign) || 'j'
    return typesetText(text, typesetWidth, defaultAlign)
}


///////////////////////////////////////////////////////////////////////////////
// Module exports
///////////////////////////////////////////////////////////////////////////////

exports = {
    typeset,
    typesetText,
    typesetSourceLine,
    tokenise,
    expandEntities,
    fgEsc,
    COL_TEXT,
    COL_EMPH,
    COL_BRAND,
    COL_BRAND_DIM,
    ESC_DEFAULT,
    ESC_EMPH,
    ESC_DEEMPH,
    MICROTONE,
}
