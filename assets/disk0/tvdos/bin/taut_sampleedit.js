/**
 * TAUT Sample Editor (stub)
 * Sub-program launched from taut.js's Samples viewer. Rows 1-3 are owned by
 * the parent; this program draws rows 4+.
 *
 * exec_args:
 *   [1] = path to .taud file
 *   [2] = parent panel index (where to return)
 *   [3] = sample index to preload (-1 if none)
 *
 * Sets _G.TAUT.UI.NEXTPANEL on return to request a panel switch back.
 *
 * Created by minjaesong on 2026-04-27
 * Stub editing UI added on 2026-05-26
 */

const win = require("wintex")

const PARENT_PANEL = (exec_args[2] !== undefined) ? (exec_args[2] | 0) : 3 // VIEW_SAMPLES
const SAMPLE_IDX   = (exec_args[3] !== undefined) ? (exec_args[3] | 0) : -1

const [SCRH, SCRW] = con.getmaxyx()
const PANEL_Y = 4
const PANEL_H = SCRH - PANEL_Y

const colStatus  = 253
const colContent = 240
const colHdr     = 230
const colEmph    = 211
const colDim     = 246
const colBack    = 255
const colSel     = 41

// Stub editor "fields": pretend toolbar. None of these write anything yet.
const TOOLS = [
    { key: 'L', label: 'Load .raw / .wav from disk' },
    { key: 'S', label: 'Save current sample to disk' },
    { key: 'D', label: 'Draw waveform freehand' },
    { key: 'X', label: 'Crop / trim selection' },
    { key: 'R', label: 'Resample' },
    { key: 'V', label: 'Reverse' },
    { key: 'N', label: 'Normalise to peak' },
    { key: 'F', label: 'Fade in / out' },
]

let toolCursor = 0

function drawSampleEditFrame() {
    for (let y = PANEL_Y; y < SCRH; y++) {
        con.move(y, 1)
        con.color_pair(colContent, colBack)
        print(' '.repeat(SCRW))
    }
    // Title
    con.move(PANEL_Y + 1, 3)
    con.color_pair(colHdr, colBack); print('[ Sample Editor ]  ')
    con.color_pair(colEmph, colBack); print('Sample ')
    con.color_pair(colStatus, colBack)
    if (SAMPLE_IDX >= 0) print('#' + (SAMPLE_IDX + 1).toString(16).toUpperCase().padStart(2, '0'))
    else                 print('(none)')

    con.move(PANEL_Y + 2, 3)
    con.color_pair(colDim, colBack)
    print('stub editor — actions below are placeholders only.')
}

function drawToolList() {
    const x = 5
    const y0 = PANEL_Y + 4
    con.move(y0, x)
    con.color_pair(colHdr, colBack); print('Editing actions')
    con.move(y0 + 1, x)
    con.color_pair(colDim, colBack); print('-'.repeat(16))

    for (let i = 0; i < TOOLS.length; i++) {
        const y = y0 + 3 + i
        const t = TOOLS[i]
        const sel = (i === toolCursor)
        const back = sel ? colSel : colBack
        con.move(y, x)
        con.color_pair(colHdr, back); print(' ' + t.key + ' ')
        con.color_pair(colStatus, back); print('  ')
        con.color_pair(sel ? colEmph : colStatus, back)
        const w = SCRW - x - 6
        const lbl = t.label.length > w ? t.label.substring(0, w) : t.label.padEnd(w)
        print(lbl)
    }

    // Drawing-area placeholder on the right
    const dx = 38
    const dy0 = PANEL_Y + 4
    const dw  = SCRW - dx - 2
    const dh  = SCRH - dy0 - 2
    con.move(dy0, dx)
    con.color_pair(colHdr, colBack); print('Waveform editor')
    con.move(dy0 + 1, dx)
    con.color_pair(colDim, colBack); print('-'.repeat(16))

    // Empty drawing rectangle made of dots
    for (let r = 0; r < dh; r++) {
        con.move(dy0 + 3 + r, dx)
        con.color_pair(colDim, colBack)
        if (r === (dh >>> 1)) print('-'.repeat(dw)) // zero line
        else print(' '.repeat(dw))
    }
    con.move(dy0 + 3 + (dh >>> 1) + 1, dx)
    con.color_pair(colDim, colBack)
    print('(drawing surface — not yet implemented)')
}

function drawHints() {
    con.move(SCRH, 1)
    con.color_pair(colStatus, colBack)
    print(' '.repeat(SCRW - 1))
    con.move(SCRH, 1)
    con.color_pair(colHdr, colBack); print('28u29u ')
    con.color_pair(colStatus, colBack); print('Tool ')
    con.color_pair(colHdr, colBack); print('Enter ')
    con.color_pair(colStatus, colBack); print('Apply ')
    con.color_pair(colHdr, colBack); print('Esc/Tab ')
    con.color_pair(colStatus, colBack); print('Back to viewer')
}

function flashAction(idx) {
    const t = TOOLS[idx]
    if (!t) return
    con.move(SCRH - 2, 5)
    con.color_pair(colEmph, colBack)
    print(('Action: ' + t.label + ' (stub, no-op)').padEnd(SCRW - 8))
}

function sampleEditInput(wo, event) {
    // wintex panel input — wired up but the loop below handles keys directly.
}

function drawAll() {
    drawSampleEditFrame()
    drawToolList()
    drawHints()
}

const panel = new win.WindowObject(1, PANEL_Y, SCRW, PANEL_H, sampleEditInput, drawAll, undefined, ()=>{})

panel.drawContents()

let done = false
while (!done) {
    input.withEvent(event => {
        if (event[0] !== 'key_down') return
        const keysym     = event[1]
        const keyJustHit = (1 == event[2])

        if (!keyJustHit) return

        if (keysym === '<ESCAPE>' || keysym === '<TAB>') {
            _G.TAUT.UI.NEXTPANEL = PARENT_PANEL
            done = true
            return
        }

        if (keysym === '<UP>')   { if (toolCursor > 0)              toolCursor--; drawToolList(); return }
        if (keysym === '<DOWN>') { if (toolCursor < TOOLS.length-1) toolCursor++; drawToolList(); return }

        if (keysym === '\n') {
            flashAction(toolCursor)
            return
        }

        // Direct key shortcuts
        for (let i = 0; i < TOOLS.length; i++) {
            if (keysym === TOOLS[i].key.toLowerCase() || keysym === TOOLS[i].key) {
                toolCursor = i
                drawToolList()
                flashAction(i)
                return
            }
        }
    })
}

return 0
