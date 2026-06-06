/*
 * synopsis.js -- system-wide help / tldr.
 *
 * Prints a command's human-targeted one-line summary and an auto-generated
 * synopsis (usage line, arguments, options and constraints) derived from its
 * TSF .synopsis document via the `synopsis` library (synopsis.mjs).
 *
 * Usage: synopsis PROGRAM
 *        synopsis            (describes itself)
 */

let syn
try {
    syn = require("synopsis")
} catch (e) {
    printerrln("synopsis: the 'synopsis' library is not installed")
    return 1
}

const termW = (con.getmaxyx()[1]) || 80

// Word-wrap plain text to `width`, returning an array of lines.
function wrap(text, width) {
    if (!text) return []
    if (width < 8) width = 8
    let words = ('' + text).split(/\s+/).filter(function (w) { return w.length })
    let lines = [], line = ''
    words.forEach(function (w) {
        if (line.length === 0) line = w
        else if (line.length + 1 + w.length <= width) line += ' ' + w
        else { lines.push(line); line = w }
    })
    if (line.length) lines.push(line)
    return lines
}

// Print a "left  summary" row: the summary is wrapped into the right column and
// continuation lines are aligned under it. An over-wide `left` spills onto its
// own line.
function row(left, summary, leftW, indent) {
    let pad = ' '.repeat(indent)
    let gap = 2
    let sumW = Math.max(8, termW - indent - leftW - gap)
    let wrapped = wrap(summary, sumW)
    if (left.length > leftW) {
        println(pad + left)
        wrapped.forEach(function (l) { println(pad + ' '.repeat(leftW + gap) + l) })
    } else {
        let first = wrapped.length ? wrapped[0] : ''
        println(pad + left + ' '.repeat(leftW - left.length + gap) + first)
        for (let i = 1; i < wrapped.length; i++)
            println(pad + ' '.repeat(leftW + gap) + wrapped[i])
    }
}

// ---- resolve the target ----------------------------------------------------
let token = (exec_args[1] !== undefined && exec_args[1] !== '') ? exec_args[1] : "synopsis"

let model = syn.getModel(token)
if (!model) {
    printerrln(`synopsis: no synopsis found for '${token}'`)
    return 1
}

// Display name for a referenced symbol id (used by the constraints section).
function symDisplay(id) {
    let s = model.symbols[id]
    if (!s) return id
    if (s.kind === 'option')     return s.long || s.short || id
    if (s.kind === 'positional') return s.name || id
    if (s.kind === 'subcommand') return s.name || id
    return id
}

// Append a "{a, b, c}" hint of permitted values to a summary, if any.
function withValues(summary, values) {
    if (!values || !values.length) return summary || ''
    let vs = values.map(function (v) {
        return (v && typeof v === 'object' && ('value' in v)) ? v.value : v
    }).join(', ')
    return (summary ? summary + '  ' : '') + '{' + vs + '}'
}

// Left-column text for an option, e.g. "-o, --output=FILE".
function optionLeft(e) {
    let forms = []
    if (e.short) forms.push(e.short)
    if (e.long)  forms.push(e.long)
    let s = forms.join(', ')
    if (e.hasValue) {
        let vn = (e.value && (e.value.name || e.value.type)) || 'VALUE'
        if (e.long) s += e.valueRequired ? '=' + vn : '[=' + vn + ']'
        else        s += e.valueRequired ? ' ' + vn : ' [' + vn + ']'
    }
    return s
}
function optionSummary(e) {
    let s = e.summary || ''
    if (e.negatable) s += (s ? ' ' : '') + '(negatable)'
    if (e.value && e.value.values && e.value.values.length) s = withValues(s, e.value.values)
    return s
}

function constraintText(c) {
    let names = (c.symbols || []).map(symDisplay)
    if (c.type === 'conflicts')  return 'Mutually exclusive: ' + names.join(', ')
    if (c.type === 'requires')   return symDisplay(c.subject) + ' requires ' + (c.targets || []).map(symDisplay).join(', ')
    if (c.type === 'implies')    return symDisplay(c.subject) + ' implies ' + (c.targets || []).map(symDisplay).join(', ')
    if (c.type === 'cardinality') {
        let mn = c.minimum, mx = c.maximum, q
        if (mn === 1 && mx === 1) q = 'Exactly one of'
        else if (mn === 1 && mx === undefined) q = 'At least one of'
        else if (mn === undefined && mx === 1) q = 'At most one of'
        else q = `Between ${mn} and ${mx} of`
        return q + ': ' + names.join(', ')
    }
    return null
}

// ---- gather rows -----------------------------------------------------------
let argEntries = model.positionals.map(function (p) {
    return { left: (p.name || p.id) + (p.repeatable ? '...' : ''), summary: withValues(p.summary, p.values) }
})
let optEntries = model.flags.map(function (e) {
    return { left: optionLeft(e), summary: optionSummary(e) }
})
let subEntries = model.subcommands.map(function (s) {
    return { left: s.name, summary: s.summary || '' }
})

// shared left-column width (capped so a long flag does not push everything out)
let leftW = 4
argEntries.concat(optEntries, subEntries).forEach(function (e) { if (e.left.length > leftW) leftW = e.left.length })
if (leftW > 30) leftW = 30

// ---- render ----------------------------------------------------------------
let title = model.name || token
println(model.summary ? `${title} - ${model.summary}` : title)
println()

let usage = syn.getUsage(token)
if (usage) {
    println("Usage:")
    println("    " + usage)
    println()
}

if (model.description) {
    wrap(model.description, termW).forEach(function (l) { println(l) })
    println()
}

if (subEntries.length) {
    println("Commands:")
    subEntries.forEach(function (e) { row(e.left, e.summary, leftW, 4) })
    println()
}

if (argEntries.length) {
    println("Arguments:")
    argEntries.forEach(function (e) { row(e.left, e.summary, leftW, 4) })
    println()
}

if (optEntries.length) {
    println("Options:")
    optEntries.forEach(function (e) { row(e.left, e.summary, leftW, 4) })
    println()
}

if (model.constraints && model.constraints.length) {
    let lines = model.constraints.map(constraintText).filter(function (t) { return t })
    if (lines.length) {
        println("Constraints:")
        lines.forEach(function (l) { println("    " + l) })
        println()
    }
}

return 0
