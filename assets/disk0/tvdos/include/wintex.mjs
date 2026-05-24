/**
 * WinTex — TUI window management and renderer
 * @author CuriousTorvald
 */

class WindowObject {

    constructor(x, y, w, h, inputProcessor, drawContents, title, drawFrame) {
        this.isHighlighted = false
        this.x = x|0
        this.y = y|0
        this.width = w|0
        this.height = h|0
        this.inputProcessorFun = inputProcessor
        this.drawContentsFun = drawContents
        this.title = title
        this.titleLeft = undefined
        this.titleRight = undefined
        this.titleBack = 0 // default value
        this.titleBackLeft = 245 // default value
        this.titleBackRight = 245 // default value
        this.drawFrameFun = drawFrame || (() => {
            let oldFore = con.get_color_fore()
            let oldBack = con.get_color_back()

            let charset = (this.isHighlighted) ? [0xC9, 0xBB, 0xC8, 0xBC, 0xCD, 0xBA, 0xB5, 0xC6] : [0xDA, 0xBF, 0xC0, 0xD9, 0xC4, 0xB3, 0xB4, 0xC3]
            let colour = (this.isHighlighted) ? 230 : 253
            let colourText = (this.isHighlighted) ? 230 : 254

            // set fore colour
            print(`\x1B[38;5;${colour}m`)

            // draw top horz
            con.mvaddch(this.y, this.x, charset[0]); con.curs_right()
            print(`\x84${charset[4]}u`.repeat(this.width - 2))
            con.addch(charset[1])
            // draw vert
            for (let yp = this.y + 1; yp < this.y + this.height - 1; yp++) {
                con.mvaddch(yp, this.x , charset[5])
                con.mvaddch(yp, this.x + this.width - 1, charset[5])
            }
            // draw bottom horz
            con.mvaddch(this.y + this.height - 1, this.x, charset[2]); con.curs_right()
            print(`\x84${charset[4]}u`.repeat(this.width - 2))
            con.addch(charset[3])

            // draw title
            if (this.title !== undefined) {
                let tt = ''+this.title
                con.move(this.y, this.x + ((this.width - 2 - tt.length) >>> 1))
                if (this.titleBack !== undefined) print(`\x1B[48;5;${this.titleBack}m`)
                print(`\x84${charset[6]}u`)
                print(`\x1B[38;5;${colourText}m${tt}`)
                print(`\x1B[38;5;${colour}m\x84${charset[7]}u`)
                if (this.titleBack !== undefined) print(`\x1B[48;5;${oldBack}m`)
            }
            if (this.titleLeft !== undefined) {
                let tt = ''+this.titleLeft
                con.move(this.y, this.x)
                print(`\x84${charset[0]}u`)
                if (this.titleBackLeft !== undefined) print(`\x1B[48;5;${this.titleBackLeft}m`)
                print(`\x1B[38;5;${colourText}m`);print(tt)
                if (this.titleBackLeft !== undefined) print(`\x1B[48;5;${oldBack}m`)
                print(`\x1B[38;5;${colour}m`);print(`\x84${charset[4]}u`)
            }
            if (this.titleRight !== undefined) {
                let tt = ''+this.titleRight
                con.move(this.y, this.x + this.width - tt.length - 2)
                print(`\x84${charset[4]}u`)
                if (this.titleBackRight !== undefined) print(`\x1B[48;5;${this.titleBackRight}m`)
                print(`\x1B[38;5;${colourText}m${tt}`)
                if (this.titleBackRight !== undefined) print(`\x1B[48;5;${oldBack}m`)
                print(`\x1B[38;5;${colour}m\x84${charset[1]}u`)
            }


            // restore fore colour
            print(`\x1B[38;5;${oldFore}m`)
            print(`\x1B[48;5;${oldBack}m`)
        })
    }

    drawContents() { this.drawContentsFun(this) }
    drawFrame() { this.drawFrameFun(this) }
    processInput(event) { this.inputProcessorFun(this, event) }

}

/**
 * @param dy cursor change (positive or negative)
 * @param listSize size of the list to scroll
 * @param listHeight size of the list window
 * @param currentCursorPos ABSOLUTE position of the cursor
 * @param currentScrollPos current scroll position of the list
 * @param scrollPeek size of the scroll "peek"
 * @return [new cursor pos, new scroll pos]
 */
function scrollVert(dy, listSize, listHeight, currentCursorPos, currentScrollPos, scrollPeek) {
    // clamp dy
    if (currentCursorPos + dy > listSize - 1)
        dy = (listSize - 1) - currentCursorPos
    else if (currentCursorPos + dy < 0)
        dy = -currentCursorPos

    let nextRow = currentCursorPos + dy
    
    // update vertical scroll stats
    if (dy != 0) {
        let visible = listHeight - 1 - scrollPeek

        if (nextRow - currentScrollPos > visible) {
            currentScrollPos = nextRow - visible
        }
        else if (nextRow - currentScrollPos < 0 + scrollPeek) {
            currentScrollPos = nextRow - scrollPeek // nextRow is less than zero
        }

        // NOTE: future-proofing here -- scroll clamping is moved outside of go-up/go-down
        // if-statements above because horizontal movements can disrupt vertical scrolls as well because
        // "normally" when you go right at the end of the line, you appear at the start of the next line

        // scroll to the bottom?
        if (listSize > listHeight && currentScrollPos > listSize - listHeight)
            // to make sure not show buncha empty lines
            currentScrollPos = listSize - listHeight
        // scroll to the top? (order is important!)
        if (currentScrollPos <= -1)
            currentScrollPos = 0 // scroll of -1 would result to show "Line 0" on screen
    }
    
    // move editor cursor
    currentCursorPos = nextRow
    return [currentCursorPos, currentScrollPos]
}

/**
 * @param dx cursor change (positive or negative)
 * @param stringSize length of the string to scroll
 * @param stringViewSize size of the string view
 * @param currentCursorPos ABSOLUTE position of the cursor
 * @param currentScrollPos current scroll position of the list
 * @param scrollPeek size of the scroll "peek"
 * @return [new cursor pos, new scroll pos]
 */
function scrollHorz(dx, stringSize, stringViewSize, currentCursorPos, currentScrollPos, scrollPeek) {
    // clamp dx
    if (currentCursorPos + dx > stringSize - 1)
        dx = (stringSize - 1) - currentCursorPos
    else if (currentCursorPos + dx < 0)
        dx = -currentCursorPos

    let nextCol = currentCursorPos + dx

    // update vertical scroll stats
    if (dx != 0) {
        let visible = stringViewSize - 1 - scrollPeek

        if (nextCol - currentScrollPos > visible) {
            currentScrollPos = nextCol - visible
        }
        else if (nextCol - currentScrollPos < 0 + scrollPeek) {
            currentScrollPos = nextCol - scrollPeek // nextCol is less than zero
        }

        // NOTE: future-proofing here -- scroll clamping is moved outside of go-up/go-down
        // if-statements above because horizontal movements can disrupt vertical scrolls as well because
        // "normally" when you go right at the end of the line, you appear at the start of the next line

        // scroll to the bottom?
        if (stringSize > stringViewSize && currentScrollPos > stringSize - stringViewSize)
            // to make sure not show buncha empty lines
            currentScrollPos = stringSize - stringViewSize
        // scroll to the top? (order is important!)
        if (currentScrollPos <= -1)
            currentScrollPos = 0 // scroll of -1 would result to show "Line 0" on screen
    }

    // move editor cursor
    currentCursorPos = nextCol
    return [currentCursorPos, currentScrollPos]
}

// ---------------------------------------------------------------------------
// Modal dialog with multiple input fields and OK/Cancel-style buttons.
//
// opts = {
//   title:   string,
//   message: string | string[]?              -- optional body text drawn above fields
//   fields:  [{label, initial?, width}, ...] -- omit / [] for no input field
//   buttons: [{label, action, default?}, ...] -- defaults to [OK, Cancel] (+ Delete
//            if `allowDelete:true`)
//   allowDelete: bool,                       -- inserts a Delete button (fsh compat)
//   colours: {fg?, bg?, fieldBg?, dimFg?, hlFg?, focusBg?} -- per-call overrides
// }
//
// Returns {action, values}: `action` is the chosen button's `action`
// (default "ok"/"cancel"/"delete"), or "cancel" on Esc; `values` is the array
// of field strings in field order.
//
// Behaviour:
//   - Tab / Shift+Tab and arrow Down / Up cycle focus across fields and buttons.
//   - Left / Right inside a field move the caret; on a button they cycle focus.
//   - Home / End jump to start / end of the focused field.
//   - Enter on a field jumps to the next field, then to the first button. Enter
//     or Space on a button activates it.
//   - Insert at caret. Backspace deletes left of caret; Forward-Del deletes right.
//   - Blinking caret (`con.curs_set(1)`) is positioned on the focused field and
//     hidden when a button has focus.
//   - Mouse: left-click on a button activates it; click on a field puts focus
//     on that field and positions the caret under the click. Mouse hover on a
//     button highlights it.
const _dialogScreen = con.getmaxyx()
const _dialogPixDim = graphics.getPixelDimension()
const _CELL_PW = (_dialogPixDim[0] / _dialogScreen[1]) | 0
const _CELL_PH = (_dialogPixDim[1] / _dialogScreen[0]) | 0
function _pxToCell(px, py) { return [(py / _CELL_PH | 0) + 1, (px / _CELL_PW | 0) + 1] }

function showDialog(opts) {
    const fields  = opts.fields || []
    const values  = fields.map(f => (f.initial == null) ? '' : ('' + f.initial))
    const cursors = values.map(v => v.length)

    let oldFG = con.get_color_fore()
    let oldBG = con.get_color_back()

    let buttons
    if (opts.buttons) {
        buttons = opts.buttons
    } else {
        buttons = [{label: 'OK', action: 'ok', default: true}]
        if (opts.allowDelete) buttons.push({label: 'Delete', action: 'delete'})
        buttons.push({label: 'Cancel', action: 'cancel'})
    }

    const title = opts.title || ''
    const message = opts.message
    const messageLines = !message ? []
        : Array.isArray(message) ? message
        : ('' + message).split('\n')

    const c       = opts.colours || {}
    const fg      = (c.fg      != null) ? c.fg      : 254
    const bg      = (c.bg      != null) ? c.bg      : 242
    const fieldBg = (c.fieldBg != null) ? c.fieldBg : 240
    const dimFg   = (c.dimFg   != null) ? c.dimFg   : 249
    const hlFg    = (c.hlFg    != null) ? c.hlFg    : 230
    const focusBg = (c.focusBg != null) ? c.focusBg : bg

    // Layout
    const maxFieldW = fields.reduce((m, f) => Math.max(m, f.width), 16)
    const longestMsg = messageLines.reduce((m, l) => Math.max(m, l.length), 0)
    const titleW    = title.length + 4
    const btnRowW   = buttons.reduce((s, b) => s + b.label.length + 5, 0) - 1
    const w = Math.max(maxFieldW + 6, titleW + 4, longestMsg + 6, btnRowW + 4, 24)
    const msgTopOff = (messageLines.length > 0) ? 1 : 0
    const msgRows   = messageLines.length + (messageLines.length > 0 ? 1 : 0)
    const fieldsBlockH = fields.length * 4
    const buttonsRowOff = 1 + msgRows + (fields.length > 0 ? fieldsBlockH + 1 : 1)
    const h = buttonsRowOff + 2
    const screen = con.getmaxyx()
    const row = Math.max(2, Math.floor((screen[0] - h) / 2))
    const col = Math.max(2, Math.floor((screen[1] - w) / 2))

    // Pick initial focus: explicit default > first field > first button.
    let focusIdx = -1
    for (let i = 0; i < buttons.length; i++) {
        if (buttons[i].default) { focusIdx = fields.length + i; break }
    }
    if (focusIdx < 0) focusIdx = fields.length > 0 ? 0 : fields.length
    const totalFocus = fields.length + buttons.length
    let hoverBtn = -1
    let done = null

    function fieldScroll(cur, fw) { return cur < fw ? 0 : cur - fw + 1 }
    function fieldLabelRow(i) { return row + 1 + msgRows + i * 4 }
    function fieldBoxRow(i)   { return fieldLabelRow(i) + 1 }
    function fieldContentRow(i) { return fieldLabelRow(i) + 2 }
    function fieldBoxCol() { return col + 2 }
    function fieldContentRegion(i) { return { x: fieldBoxCol() + 1, y: fieldContentRow(i), w: fields[i].width } }

    function buttonRegions() {
        let bx = col + Math.floor((w - btnRowW) / 2)
        return buttons.map(b => {
            const r = { x: bx, y: row + buttonsRowOff, w: b.label.length + 4 }
            bx += b.label.length + 5
            return r
        })
    }

    function drawFrameBox() {
        con.color_pair(fg, bg)
        for (let r = row; r < row + h; r++) {
            con.move(r, col)
            print(' '.repeat(w))
        }
        const wo = new WindowObject(col, row, w, h, ()=>{}, ()=>{}, title)
        wo.isHighlighted = true
        wo.titleBack = bg
        wo.drawFrame()
        con.color_pair(fg, bg)
    }

    function drawMessage() {
        if (messageLines.length === 0) return
        con.color_pair(fg, bg)
        for (let i = 0; i < messageLines.length; i++) {
            con.move(row + 1 + i, col + 2)
            print(messageLines[i].padEnd(w - 4, ' '))
        }
    }

    function drawField(i) {
        const f = fields[i]
        const fbCol = fieldBoxCol()
        const fbRow = fieldBoxRow(i)
        const fw = f.width
        const focused = (focusIdx === i)
        const frameFg = focused ? fg : dimFg

        // Label
        con.color_pair(fg, bg)
        con.move(fieldLabelRow(i), fbCol)
        print(f.label + ':')

        // Top border
        con.color_pair(frameFg, bg)
        con.move(fbRow, fbCol)
        print('\u00DA' + '\u00C4'.repeat(fw) + '\u00BF')

        // Side borders + content
        con.color_pair(frameFg, bg)
        con.move(fbRow + 1, fbCol)
        print('\u00B3')
        con.color_pair(fg, fieldBg)
        const s = fieldScroll(cursors[i], fw)
        const vis = values[i].substring(s, s + fw)
        print(vis.padEnd(fw, ' '))
        con.color_pair(frameFg, bg)
        con.move(fbRow + 1, fbCol + fw + 1)
        print('\u00B3')

        // Bottom border
        con.move(fbRow + 2, fbCol)
        print('\u00C0' + '\u00C4'.repeat(fw) + '\u00D9')
        con.color_pair(fg, bg)
    }

    function drawButton(i, regions) {
        const b = buttons[i]
        const bIdx = fields.length + i
        const focused = (focusIdx === bIdx)
        const hovered = (hoverBtn === i)
        const r = regions[i]
        let useFg, useBg
        if (focused && hovered)      { useFg = hlFg; useBg = focusBg }
        else if (focused)            { useFg = hlFg; useBg = focusBg }
        else if (hovered)            { useFg = hlFg; useBg = bg }
        else                         { useFg = fg;   useBg = bg }
        con.color_pair(useFg, useBg)
        con.move(r.y, r.x)
        print('[ ' + b.label + ' ]')
        con.color_pair(fg, bg)
    }

    function positionCaret() {
        if (focusIdx < fields.length) {
            const fw = fields[focusIdx].width
            const s = fieldScroll(cursors[focusIdx], fw)
            con.move(fieldContentRow(focusIdx), fieldBoxCol() + 1 + (cursors[focusIdx] - s))
            con.curs_set(1)
        } else {
            con.curs_set(0)
        }
    }

    function render() {
        drawFrameBox()
        drawMessage()
        for (let i = 0; i < fields.length; i++) drawField(i)
        const regs = buttonRegions()
        for (let i = 0; i < buttons.length; i++) drawButton(i, regs)
        positionCaret()
    }

    function moveFocus(dir) {
        focusIdx = (focusIdx + dir + totalFocus) % totalFocus
        render()
    }

    function activateButton(i) {
        done = { action: buttons[i].action, values: values.slice() }
    }

    function hitTestMouse(ev) {
        const cell = _pxToCell(ev[1], ev[2])
        const cy = cell[0], cx = cell[1]
        const btnRegs = buttonRegions()
        for (let i = 0; i < btnRegs.length; i++) {
            const r = btnRegs[i]
            if (cy === r.y && cx >= r.x && cx < r.x + r.w) return { kind: 'button', idx: i }
        }
        for (let i = 0; i < fields.length; i++) {
            const r = fieldContentRegion(i)
            if (cy === r.y && cx >= r.x && cx < r.x + r.w) return { kind: 'field', idx: i, cx: cx, region: r }
        }
        return null
    }

    render()

    let eventJustReceived = true
    while (done === null) {
        input.withEvent(ev => {
            if (eventJustReceived && (ev[0] === 'key_down' || ev[0] === 'mouse_down')) {
                eventJustReceived = false; return
            }

            if (ev[0] === 'mouse_move') {
                const hit = hitTestMouse(ev)
                const newHover = (hit && hit.kind === 'button') ? hit.idx : -1
                if (newHover !== hoverBtn) {
                    hoverBtn = newHover
                    const regs = buttonRegions()
                    for (let i = 0; i < buttons.length; i++) drawButton(i, regs)
                    positionCaret()
                }
                return
            }
            if (ev[0] === 'mouse_down') {
                if (ev[3] !== 1) return
                const hit = hitTestMouse(ev)
                if (!hit) return
                if (hit.kind === 'button') {
                    focusIdx = fields.length + hit.idx
                    render()
                    activateButton(hit.idx)
                    return
                }
                if (hit.kind === 'field') {
                    focusIdx = hit.idx
                    const fw = fields[hit.idx].width
                    const s = fieldScroll(cursors[hit.idx], fw)
                    const newCur = s + (hit.cx - hit.region.x)
                    cursors[hit.idx] = Math.min(values[hit.idx].length, Math.max(0, newCur))
                    render()
                }
                return
            }
            if (ev[0] !== 'key_down') return
            if (1 !== ev[2]) return
            const ks = ev[1]
            const shiftDown = (ev.includes(59) || ev.includes(60))

            if (ks === '<ESC>') { done = { action: 'cancel', values: values.slice() }; return }

            if (ks === '\t' || ks === '<TAB>') { moveFocus(shiftDown ? -1 : 1); return }
            if (ks === '<UP>')                 { moveFocus(-1); return }
            if (ks === '<DOWN>')               { moveFocus(+1); return }

            if (ks === '<LEFT>') {
                if (focusIdx < fields.length) {
                    if (cursors[focusIdx] > 0) { cursors[focusIdx] -= 1; render() }
                } else moveFocus(-1)
                return
            }
            if (ks === '<RIGHT>') {
                if (focusIdx < fields.length) {
                    if (cursors[focusIdx] < values[focusIdx].length) { cursors[focusIdx] += 1; render() }
                } else moveFocus(+1)
                return
            }
            if (ks === '<HOME>') {
                if (focusIdx < fields.length) { cursors[focusIdx] = 0; render() }
                return
            }
            if (ks === '<END>') {
                if (focusIdx < fields.length) { cursors[focusIdx] = values[focusIdx].length; render() }
                return
            }

            if (focusIdx < fields.length) {
                if (ks === '\n') {
                    focusIdx = (focusIdx < fields.length - 1) ? focusIdx + 1 : fields.length
                    render()
                    return
                }
                if (ks === '') {
                    const cur = cursors[focusIdx]
                    if (cur > 0) {
                        const v = values[focusIdx]
                        values[focusIdx] = v.substring(0, cur - 1) + v.substring(cur)
                        cursors[focusIdx] = cur - 1
                        render()
                    }
                    return
                }
                if (ks === '<FORWARD_DEL>' || ks === '<DEL>') {
                    const cur = cursors[focusIdx]
                    const v = values[focusIdx]
                    if (cur < v.length) {
                        values[focusIdx] = v.substring(0, cur) + v.substring(cur + 1)
                        render()
                    }
                    return
                }
                if (typeof ks === 'string' && ks.length === 1) {
                    const code = ks.charCodeAt(0)
                    if (code >= 32 && code < 256 && values[focusIdx].length < fields[focusIdx].width * 4) {
                        const v = values[focusIdx]
                        const cur = cursors[focusIdx]
                        values[focusIdx] = v.substring(0, cur) + ks + v.substring(cur)
                        cursors[focusIdx] = cur + 1
                        render()
                    }
                    return
                }
            } else {
                if (ks === '\n' || ks === ' ') { activateButton(focusIdx - fields.length); return }
            }
        })
    }

    con.curs_set(0)
    con.color_pair(oldFG, oldBG)
    return done
}

exports = { WindowObject, scrollVert, scrollHorz, showDialog }
