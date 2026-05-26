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
                con.move(this.y + this.height - 1, this.x + this.width - tt.length - 2)
                print(`\x84${charset[4]}u`)
                if (this.titleBackRight !== undefined) print(`\x1B[48;5;${this.titleBackRight}m`)
                print(`\x1B[38;5;${colourText}m${tt}`)
                if (this.titleBackRight !== undefined) print(`\x1B[48;5;${oldBack}m`)
                print(`\x1B[38;5;${colour}m\x84${charset[3]}u`)
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
// Modal dialog with optional body text, input fields, a scrollable selection
// list, and OK/Cancel-style buttons. Layout from top to bottom:
//   title bar, message, fields, list, buttons.
//
// opts = {
//   title:   string,
//   message: string | string[]?,             -- optional body text drawn above fields/list
//   drawFrame: function(wo)?,                -- override for the window-frame painter;
//                                               same contract as WindowObject's
//                                               `drawFrame` slot. Useful when the caller
//                                               wants its own border / title styling.
//
//   fields:  [{label, initial?, width, maxLength?}, ...] -- omit / [] for no input
//                                               field. Label does NOT get auto-colon.
//                                               `maxLength` caps insertable chars
//                                               (default: width * 4).
//
//   list: {                                  -- optional vertical selection list
//     items:     [{label, ...}, ...],        -- arbitrary user objects; only `label`
//                                               is read by the default renderer.
//     height:    number,                     -- visible row count.
//     width:     number?,                    -- inner width override (default: popup w-4).
//     cursor:    number?,                    -- initial cursor row (default: first selectable).
//     selectable: function(item, i)->bool?,  -- default: every item selectable. Non-
//                                               selectable rows are skipped by arrow keys.
//                                               When NO row is selectable, arrow / PgUp
//                                               / PgDn scroll the view instead.
//     renderItem: function(ctx)?,            -- per-row painter; ctx exposes
//                                               { y, x, w, item, idx, isCursor, focused,
//                                                 listBg, selBg, fg, hlFg, dimFg }.
//                                               Default prints `item.label`.
//     onActivate: function(item, i, key)?,   -- fired on Enter ('\n') / Space (' ')
//                                               / left-click ('click'); return an
//                                               action string to close the dialog,
//                                               or null to stay open.
//     showScrollbar: bool?,                  -- default: auto (true when overflowing).
//     bg: number?,                           -- list background colour (default 242).
//   },
//
//   buttons: [{label, action, default?}, ...] -- defaults to [OK, Cancel] (+ Delete
//            if `allowDelete:true`)
//   allowDelete: bool,                       -- inserts a Delete button (fsh compat)
//   colours: {fg?, bg?, fieldBg?, dimFg?, hlFg?, focusBg?, listBg?, listSelBg?}
//                                            -- per-call overrides
//   disableKeyRepeat: bool,               -- when true, key won't repeat when held down
//   onKey: function(ks, shiftDown, ctx)?,    -- escape hatch for callers that need
//                                               extra key bindings. Runs BEFORE the
//                                               built-in handlers. Return true to
//                                               consume the key. `ctx` exposes
//                                               { render, close(result),
//                                                 getListCursor, setListCursor }.
// }
//
// Returns {action, values, listCursor, listItem}: `action` is the chosen button's
// `action` or the value returned from `onActivate` (default "ok"/"cancel"/"delete"),
// or "cancel" on Esc; `values` is the array of field strings in field order;
// `listCursor` is the final cursor index (-1 if there is no list); `listItem` is
// the item at that index.
//
// Behaviour:
//   - Tab / Shift+Tab and arrow Down / Up cycle focus across fields, list, and buttons.
//     Inside the list, arrow Up / Down move the cursor between selectable rows;
//     PgUp/PgDn move a page; Home/End jump to the first/last selectable row.
//   - Left / Right inside a field move the caret; on the list or a button they cycle focus.
//   - Home / End jump to start / end of the focused field.
//   - Enter on a field jumps to the next field, then to the first button. Enter
//     or Space on a button activates it. Enter or Space on a list row invokes
//     `onActivate(item, idx, key)`; if that returns a string, the dialog closes
//     with that action.
//   - Insert at caret. Backspace deletes left of caret; Forward-Del deletes right.
//   - Blinking caret (`con.curs_set(1)`) is positioned on the focused field and
//     hidden when the list or a button has focus.
//   - Mouse: left-click on a button activates it; click on a field puts focus
//     on that field and positions the caret under the click; click on a list row
//     moves the cursor (and fires `onActivate` if defined); mouse-wheel inside the
//     list scrolls it. Mouse hover on a button moves focus to it (the same focus
//     the keyboard uses).
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

    const c         = opts.colours || {}
    const fg        = (c.fg        != null) ? c.fg        : 254
    const bg        = (c.bg        != null) ? c.bg        : 244
    const fieldBg   = (c.fieldBg   != null) ? c.fieldBg   : 240
    const dimFg     = (c.dimFg     != null) ? c.dimFg     : 249
    const hlFg      = (c.hlFg      != null) ? c.hlFg      : 240
    const focusBg   = (c.focusBg   != null) ? c.focusBg   : 253
    const listBg    = (c.listBg    != null) ? c.listBg    : 243
    const listSelBg = (c.listSelBg != null) ? c.listSelBg : focusBg

    // List state
    const list = opts.list || null
    const listItems = list ? (list.items || []) : []
    const listSelectable = list && list.selectable ? list.selectable : (() => true)
    const listHeight     = list ? (list.height || Math.min(8, listItems.length)) : 0
    const hasList        = !!list
    const listOnActivate = list ? list.onActivate : null
    const listBgColour   = (list && list.bg != null) ? list.bg : listBg
    function firstSelectable(from, dir) {
        if (!hasList || listItems.length === 0) return -1
        let i = from
        for (let n = 0; n < listItems.length; n++) {
            if (i >= 0 && i < listItems.length && listSelectable(listItems[i], i)) return i
            i += dir
            if (i < 0) i = listItems.length - 1
            if (i >= listItems.length) i = 0
        }
        return -1
    }
    let listCursor = hasList
        ? (list.cursor != null ? list.cursor : firstSelectable(0, +1))
        : -1
    let listScroll = 0

    // Layout
    const buttonGap = 3
    const maxFieldW = fields.reduce((m, f) => Math.max(m, f.width), 16)
    const longestMsg = messageLines.reduce((m, l) => Math.max(m, l.length), 0)
    // When the caller pins `list.width`, trust it — string `.length` overcounts
    // visual width whenever items embed ANSI escapes or TVDOS \x84NNu sequences
    // (e.g. taut's help popup, whose rows are pre-typeset with fg-colour escapes).
    const longestItem = hasList && list.width == null
        ? listItems.reduce((m, it) => Math.max(m, (it.label || '').length), 0)
        : 0
    const titleW    = title.length + 4
    const btnRowW   = buttons.reduce((s, b) => s + b.label.length + 4, 0) + buttonGap * Math.max(0, buttons.length - 1)
    const listMinW  = hasList
        ? (list.width != null ? list.width + 4 : longestItem + 6)
        : 0
    const w = Math.max(maxFieldW + 6, titleW + 4, longestMsg + 6, btnRowW + 4, listMinW, 24)

    const msgRows      = messageLines.length + (messageLines.length > 0 ? 1 : 0)
    const fieldsBlockH = fields.length * 4
    const listBlockH   = hasList ? listHeight + 2 : 0   // top border + rows + bottom border

    let bodyRows = msgRows
    if (fields.length > 0) bodyRows += fieldsBlockH + 1   // +1 spacing after fields
    if (hasList)           bodyRows += listBlockH + 1     // +1 spacing after list
    if (bodyRows === 0)    bodyRows = 1                   // at least one row above buttons
    const buttonsRowOff = 1 + bodyRows
    const h = buttonsRowOff + 2

    const screen = con.getmaxyx()
    const row = Math.max(2, Math.floor((screen[0] - h) / 2))
    const col = Math.max(2, Math.floor((screen[1] - w) / 2))

    // Focus layout: 0..fields.length-1 = fields, [+1 = list if present], then buttons.
    const listFocusIdx = hasList ? fields.length : -1
    const buttonsFocusBase = fields.length + (hasList ? 1 : 0)
    const totalFocus = buttonsFocusBase + buttons.length

    // Pick initial focus: explicit default > list > first field > first button.
    let focusIdx = -1
    for (let i = 0; i < buttons.length; i++) {
        if (buttons[i].default) { focusIdx = buttonsFocusBase + i; break }
    }
    if (focusIdx < 0) {
        if (fields.length > 0)  focusIdx = 0
        else if (hasList)       focusIdx = listFocusIdx
        else                    focusIdx = buttonsFocusBase
    }
    let done = null

    function fieldScroll(cur, fw) { return cur < fw ? 0 : cur - fw + 1 }
    function fieldLabelRow(i) { return row + 1 + msgRows + i * 4 }
    function fieldBoxRow(i)   { return fieldLabelRow(i) + 1 }
    function fieldContentRow(i) { return fieldLabelRow(i) + 2 }
    function fieldBoxCol() { return col + 2 }
    function fieldContentRegion(i) { return { x: fieldBoxCol() + 1, y: fieldContentRow(i), w: fields[i].width } }

    function listBlockTopRow() {
        return row + 1 + msgRows + (fields.length > 0 ? fieldsBlockH + 1 : 0)
    }
    function listBlockCol()  { return col + 2 }
    function listBlockWidth() { return w - 4 }      // inner content width incl. borders
    function listContentRow(i) { return listBlockTopRow() + 1 + (i - listScroll) }
    function listContentCol()  { return listBlockCol() + 1 }
    function listScrollbarNeeded() {
        if (!hasList) return false
        if (list.showScrollbar != null) return list.showScrollbar
        return listItems.length > listHeight
    }
    function listContentInnerW() {
        return listBlockWidth() - 2 - (listScrollbarNeeded() ? 1 : 0)
    }

    function buttonRegions() {
        let bx = col + Math.floor((w - btnRowW) / 2)
        return buttons.map(b => {
            const r = { x: bx, y: row + buttonsRowOff, w: b.label.length + 4 }
            bx += b.label.length + 4 + buttonGap
            return r
        })
    }

    function drawFrameBox() {
        con.color_pair(fg, bg)
        for (let r = row; r < row + h; r++) {
            con.move(r, col)
            print(' '.repeat(w))
        }
        const wo = new WindowObject(col, row, w, h, ()=>{}, ()=>{}, title, opts.drawFrame)
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
        print(f.label)

        // Top border (3px padding w/ TSVM chr rom)
        con.color_pair(fieldBg, bg)
        con.move(fbRow, fbCol)
        print('\u00EC' + '\u00A9'.repeat(fw) + '\u00ED')

        // Left border (3px padding w/ TSVM chr rom)
        con.move(fbRow + 1, fbCol)
        print('\u00AB')

        // the content
        con.color_pair(fg, fieldBg)
        const s = fieldScroll(cursors[i], fw)
        const vis = values[i].substring(s, s + fw)
        print(vis.padEnd(fw, ' '))

        // Right border (3px padding w/ TSVM chr rom)
        con.color_pair(fieldBg, bg)
        con.move(fbRow + 1, fbCol + fw + 1)
        print('\u00AA')

        // Bottom border (3px padding w/ TSVM chr rom)
        con.move(fbRow + 2, fbCol)
        print('\u00F4' + '\u00AC'.repeat(fw) + '\u00F5')
        con.color_pair(fg, bg)
    }

    function drawList() {
        if (!hasList) return
        const lbCol = listBlockCol()
        const lbRow = listBlockTopRow()
        const lw    = listBlockWidth()
        const innerW = listContentInnerW()
        const focused = (focusIdx === listFocusIdx)
        const frameFg = focused ? fg : dimFg
        const sbar = listScrollbarNeeded()

        // Top border (drawField style)
        con.color_pair(listBgColour, bg)
        con.move(lbRow, lbCol)
        print('\u00EC' + '\u00A9'.repeat(lw - 2) + '\u00ED')

        // Side borders + rows
        for (let r = 0; r < listHeight; r++) {
            con.color_pair(listBgColour, bg)
            con.move(lbRow + 1 + r, lbCol)
            print('\u00AB')
            con.move(lbRow + 1 + r, lbCol + lw - 1)
            print('\u00AA')

            const idx = listScroll + r
            con.move(lbRow + 1 + r, lbCol + 1)
            if (idx >= listItems.length) {
                con.color_pair(fg, listBgColour)
                print(' '.repeat(innerW))
                continue
            }
            const it = listItems[idx]
            const isCursor = (idx === listCursor)
            const ctx = {
                y: lbRow + 1 + r,
                x: lbCol + 1,
                w: innerW,
                item: it,
                idx: idx,
                isCursor: isCursor,
                focused: focused,
                listBg: listBgColour,
                selBg: listSelBg,
                fg: fg,
                hlFg: hlFg,
                dimFg: dimFg,
            }
            if (list.renderItem) {
                list.renderItem(ctx)
            } else {
                const useFg = (isCursor && focused) ? hlFg : fg
                const useBg = (isCursor && focused) ? listSelBg : listBgColour
                con.color_pair(useFg, useBg)
                const label = (it.label || '').substring(0, innerW - 1)
                print(' ' + label.padEnd(innerW - 1, ' '))
            }

            // Scrollbar column
            if (sbar) {
                con.color_pair(dimFg, listBgColour)
                con.move(lbRow + 1 + r, lbCol + lw - 2)
                const maxScroll = Math.max(1, listItems.length - listHeight)
                const indPos = (maxScroll <= 0) ? 0 : ((listScroll * (listHeight - 1) / maxScroll) | 0)
                let trough = (r === 0) ? 0xBA : (r === listHeight - 1) ? 0xBC : 0xBB
                con.addch(r === indPos ? (trough + 3) : trough)
            }
        }

        // Bottom border
        con.color_pair(listBgColour, bg)
        con.move(lbRow + 1 + listHeight, lbCol)
        print('\u00F4' + '\u00AC'.repeat(lw - 2) + '\u00F5')
        con.color_pair(fg, bg)
    }

    function drawButton(i, regions) {
        const b = buttons[i]
        const bIdx = buttonsFocusBase + i
        const focused = (focusIdx === bIdx)
        const r = regions[i]
        const useFg = focused ? hlFg : fg
        const useBg = focused ? focusBg : bg
        con.color_pair(useFg, useBg)
        con.move(r.y, r.x-1)
        if (focused) {
            con.color_pair(useBg, bg)
            print('\u00DE')
            con.color_pair(useFg, useBg)
            print('[ ' + b.label + ' ]')
            con.color_pair(useBg, bg)
            print('\u00DD')
        }
        else
            print(' [ ' + b.label + ' ] ')
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

    function ensureListCursorVisible() {
        if (!hasList) return
        if (listCursor < 0) return
        if (listCursor < listScroll) listScroll = listCursor
        else if (listCursor >= listScroll + listHeight) listScroll = listCursor - listHeight + 1
        const maxScroll = Math.max(0, listItems.length - listHeight)
        if (listScroll > maxScroll) listScroll = maxScroll
        if (listScroll < 0) listScroll = 0
    }

    function scrollListBy(dir) {
        const maxScroll = Math.max(0, listItems.length - listHeight)
        let s = listScroll + dir
        if (s < 0) s = 0
        if (s > maxScroll) s = maxScroll
        listScroll = s
    }

    function moveListCursor(dir) {
        if (!hasList || listItems.length === 0) return
        // Scroll the view when nothing in the list is selectable (e.g. a help text body).
        if (listCursor < 0) { scrollListBy(dir); return }
        let next = listCursor
        for (let n = 0; n < listItems.length; n++) {
            next += dir
            if (next < 0 || next >= listItems.length) return
            if (listSelectable(listItems[next], next)) {
                listCursor = next
                ensureListCursorVisible()
                return
            }
        }
    }

    function pageListCursor(dir) {
        if (!hasList || listItems.length === 0) return
        if (listCursor < 0) { scrollListBy(dir * listHeight); return }
        let target = listCursor + dir * listHeight
        if (target < 0) target = 0
        if (target >= listItems.length) target = listItems.length - 1
        // Snap to nearest selectable
        let probe = target
        const step = dir < 0 ? -1 : 1
        while (probe >= 0 && probe < listItems.length && !listSelectable(listItems[probe], probe)) probe += step
        if (probe < 0 || probe >= listItems.length) probe = firstSelectable(target, -step)
        if (probe >= 0) { listCursor = probe; ensureListCursorVisible() }
    }

    function render() {
        drawFrameBox()
        drawMessage()
        for (let i = 0; i < fields.length; i++) drawField(i)
        drawList()
        const regs = buttonRegions()
        for (let i = 0; i < buttons.length; i++) drawButton(i, regs)
        positionCaret()
    }

    function moveFocus(dir) {
        focusIdx = (focusIdx + dir + totalFocus) % totalFocus
        render()
    }

    function activateButton(i) {
        done = {
            action: buttons[i].action,
            values: values.slice(),
            listCursor: listCursor,
            listItem: (hasList && listCursor >= 0) ? listItems[listCursor] : null,
        }
    }

    function activateListItem(idx, key) {
        if (!hasList || !listOnActivate) return false
        if (idx < 0 || idx >= listItems.length) return false
        if (!listSelectable(listItems[idx], idx)) return false
        const result = listOnActivate(listItems[idx], idx, key)
        if (result == null) {
            // Callback consumed the event but kept the dialog open (e.g. radio
            // toggle); reflect any state changes it made.
            render()
            return true
        }
        done = {
            action: result,
            values: values.slice(),
            listCursor: idx,
            listItem: listItems[idx],
        }
        return true
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
        if (hasList) {
            const lbRow = listBlockTopRow()
            const lbCol = listBlockCol()
            const innerW = listContentInnerW()
            if (cy > lbRow && cy <= lbRow + listHeight && cx >= lbCol + 1 && cx < lbCol + 1 + innerW) {
                const r = cy - (lbRow + 1)
                const idx = listScroll + r
                if (idx >= 0 && idx < listItems.length) return { kind: 'list', idx: idx }
            }
            if (cy > lbRow && cy <= lbRow + listHeight && cx >= lbCol && cx < lbCol + listBlockWidth()) {
                return { kind: 'listblank' }
            }
        }
        return null
    }

    const externalCtx = {
        render: () => render(),
        close: (result) => {
            done = Object.assign({
                action: 'cancel',
                values: values.slice(),
                listCursor: listCursor,
                listItem: (hasList && listCursor >= 0) ? listItems[listCursor] : null,
            }, result || {})
        },
        getListCursor: () => listCursor,
        setListCursor: (n) => {
            if (!hasList) return
            if (n < 0 || n >= listItems.length) return
            listCursor = n
            ensureListCursorVisible()
        },
    }

    ensureListCursorVisible()
    render()

    let eventJustReceived = true
    while (done === null) {
        input.withEvent(ev => {
            if (eventJustReceived && (ev[0] === 'key_down' || ev[0] === 'mouse_down')) {
                eventJustReceived = false; return
            }

            if (ev[0] === 'mouse_move') {
                const hit = hitTestMouse(ev)
                if (hit && hit.kind === 'button') {
                    const newFocus = buttonsFocusBase + hit.idx
                    if (newFocus !== focusIdx) {
                        focusIdx = newFocus
                        render()
                    }
                }
                return
            }
            if (ev[0] === 'mouse_down') {
                if (ev[3] !== 1) return
                const hit = hitTestMouse(ev)
                if (!hit) return
                if (hit.kind === 'button') {
                    focusIdx = buttonsFocusBase + hit.idx
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
                    return
                }
                if (hit.kind === 'list') {
                    focusIdx = listFocusIdx
                    if (listSelectable(listItems[hit.idx], hit.idx)) {
                        listCursor = hit.idx
                        ensureListCursorVisible()
                        render()
                        if (activateListItem(hit.idx, 'click')) return
                    } else {
                        render()
                    }
                    return
                }
                if (hit.kind === 'listblank') {
                    focusIdx = listFocusIdx
                    render()
                    return
                }
                return
            }
            if (ev[0] === 'mouse_wheel' && hasList) {
                const hit = hitTestMouse(ev)
                if (!hit || (hit.kind !== 'list' && hit.kind !== 'listblank')) return
                const dy = (ev[3] | 0) * 3
                const maxScroll = Math.max(0, listItems.length - listHeight)
                let next = listScroll + dy
                if (next < 0) next = 0
                if (next > maxScroll) next = maxScroll
                if (next !== listScroll) { listScroll = next; render() }
                return
            }
            if (ev[0] !== 'key_down') return
            if (opts.disableKeyRepeat && 1 !== ev[2]) return
            const ks = ev[1]
            const shiftDown = (ev.includes(59) || ev.includes(60))

            if (opts.onKey && opts.onKey(ks, shiftDown, externalCtx)) return

            if (ks === '<ESC>') {
                done = {
                    action: 'cancel',
                    values: values.slice(),
                    listCursor: listCursor,
                    listItem: (hasList && listCursor >= 0) ? listItems[listCursor] : null,
                }
                return
            }

            if (ks === '\t' || ks === '<TAB>') { moveFocus(shiftDown ? -1 : 1); return }

            // Vertical movement: arrows operate within the list when it has focus.
            if (ks === '<UP>') {
                if (focusIdx === listFocusIdx) { moveListCursor(-1); render() }
                else moveFocus(-1)
                return
            }
            if (ks === '<DOWN>') {
                if (focusIdx === listFocusIdx) { moveListCursor(+1); render() }
                else moveFocus(+1)
                return
            }
            if (ks === '<PAGE_UP>') {
                if (focusIdx === listFocusIdx) { pageListCursor(-1); render() }
                return
            }
            if (ks === '<PAGE_DOWN>') {
                if (focusIdx === listFocusIdx) { pageListCursor(+1); render() }
                return
            }

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
                else if (focusIdx === listFocusIdx) {
                    const t = firstSelectable(0, +1)
                    if (t >= 0) { listCursor = t; ensureListCursorVisible(); render() }
                    else        { listScroll = 0; render() }
                }
                return
            }
            if (ks === '<END>') {
                if (focusIdx < fields.length) { cursors[focusIdx] = values[focusIdx].length; render() }
                else if (focusIdx === listFocusIdx) {
                    const t = firstSelectable(listItems.length - 1, -1)
                    if (t >= 0) { listCursor = t; ensureListCursorVisible(); render() }
                    else        { listScroll = Math.max(0, listItems.length - listHeight); render() }
                }
                return
            }

            if (focusIdx < fields.length) {
                if (ks === '\n') {
                    if (focusIdx < fields.length - 1) focusIdx = focusIdx + 1
                    else if (hasList) focusIdx = listFocusIdx
                    else focusIdx = buttonsFocusBase
                    render()
                    return
                }
                if (ks === '\x08') {
                    const cur = cursors[focusIdx]
                    if (cur > 0) {
                        const v = values[focusIdx]
                        values[focusIdx] = v.substring(0, cur - 1) + v.substring(cur)
                        cursors[focusIdx] = cur - 1
                        render()
                    }
                    return
                }
                if (ks === '<DEL>') {
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
                    const cap = fields[focusIdx].maxLength != null
                        ? fields[focusIdx].maxLength
                        : fields[focusIdx].width * 4
                    if (code >= 32 && code < 256 && values[focusIdx].length < cap) {
                        const v = values[focusIdx]
                        const cur = cursors[focusIdx]
                        values[focusIdx] = v.substring(0, cur) + ks + v.substring(cur)
                        cursors[focusIdx] = cur + 1
                        render()
                    }
                    return
                }
            } else if (focusIdx === listFocusIdx) {
                if (ks === '\n' || ks === ' ') {
                    if (listCursor >= 0 && activateListItem(listCursor, ks)) return
                }
            } else {
                if (ks === '\n' || ks === ' ') { activateButton(focusIdx - buttonsFocusBase); return }
            }
        })
    }

    // Modal-dialog convention: wait for the user to release whatever key closed
    // the dialog before handing control back. TVDOS's input strobo
    // (TVDOS.SYS:input.withEvent) keeps re-firing `key_down` for a held key
    // once its ~250 ms initial-press delay elapses; without this drain a brief
    // hold on Enter inside a popup would surface as a fresh Enter to whatever
    // the popup was covering, e.g. activating the file under zfm's More menu.
    // A mouse close (or any path with no key held) leaves the head key at 0
    // and skips the wait.
    sys.poke(-40, 255)
    const heldHead = sys.peek(-41)
    if (heldHead !== 0) {
        while (true) {
            input.withEvent(() => {})
            if (sys.peek(-41) !== heldHead) break
        }
    }

    con.curs_set(0)
    con.color_pair(oldFG, oldBG)
    return done
}

exports = { WindowObject, scrollVert, scrollHorz, showDialog }
