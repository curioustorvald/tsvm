graphics.setBackground(2,1,3)
graphics.resetPalette()
const GL = require("gl")
const win = require("wintex")
const keysym = require("keysym")

function captureUserInput() {
    sys.poke(-40, 1)
}

function getKeyPushed(keyOrder) {
    return sys.peek(-41 - keyOrder)
}

function readMousePos() {
    let lx = sys.peek(-33) & 0xFF
    let hx = sys.peek(-34) & 0xFF
    let ly = sys.peek(-35) & 0xFF
    let hy = sys.peek(-36) & 0xFF
    return [(hx << 8) | lx, (hy << 8) | ly]
}

function readMouseButtons() {
    return sys.peek(-37) & 0xFF
}

// Returns true if any of the eight key event buffer slots holds keycode `kc`.
function isKeyDown(kc) {
    for (let i = 0; i < 8; i++) {
        if ((sys.peek(-41 - i) & 0xFF) === kc) return true
    }
    return false
}

let _fsh = {}

// Config file path
_fsh.CONFIG_PATH = "A:/home/config/fshrc"

// Widget row caps (must match the loop bounds in draw())
_fsh.TODO_MAX_ROWS = 13       // todoWidget draws i = 0..12
_fsh.QA_MAX_ROWS = 22         // quickAccessWidget draws i = 0..21
_fsh.TODO_TEXT_WIDTH = 24     // visible characters per todo row
_fsh.QA_LABEL_WIDTH = 24      // visible characters per QA label
_fsh.QA_CMD_WIDTH = 60        // command path field width in dialog

// Highlight foreground for keyboard focus on widget lists. The background
// stays transparent (255) so the wallpaper continues to show through.
_fsh.HL_FG = 230
_fsh.HL_BG = 255

// Dialog colour pair. Background MUST be opaque (bg 255 is transparent
// in TSVM and lets the pixel-layer wallpaper bleed through dialog cells).
_fsh.DIALOG_FG = 254
_fsh.DIALOG_BG = 242
_fsh.FIELD_BG = 240
_fsh.DIALOG_DIM_FG = 249

// Default Quick Access entries when fshrc is missing or empty
_fsh.DEFAULT_QA = [
    ["Files",     "/tvdos/bin/zsh.js"],
    ["Editor",    "/tvdos/bin/edit.js"],
    ["BASIC",     "/tbas/basic.js"],
    ["DOS Shell", "/tvdos/bin/command.js /fancy"]
]

// Mouse button bits (MMIO[36] layout per IOSpace.kt)
_fsh.MB_LEFT = 1
_fsh.MB_RIGHT = 2

// Current focus: null or {widgetId: string, index: number}.
// Index uses the same convention as hitTest: 0..length-1 are entries,
// `length` is the "+ Click to add" row.
_fsh.focus = null

// Parse fshrc text into {todos: [[text, done], ...], qa: [[label, cmd], ...]}.
// Returns null for both arrays when input is empty/whitespace.
_fsh.parseConfig = function(text) {
    let todos = []
    let qa = []
    let section = null
    if (!text) return {todos: todos, qa: qa}
    let lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i]
        // strip trailing \r if any
        if (line.length && line.charCodeAt(line.length - 1) === 13) {
            line = line.substring(0, line.length - 1)
        }
        if (line.length === 0) continue
        if (line.charAt(0) === "[") {
            let close = line.indexOf("]")
            if (close > 0) {
                let name = line.substring(1, close).trim().toUpperCase()
                if (name === "TODO" || name === "QUICK_ACCESS") section = name
                else section = null  // unknown section: ignore until next header
            }
            continue
        }
        if (section === "TODO") {
            if (line.length < 2) continue
            let marker = line.charAt(0)
            if ((marker === "+" || marker === "-") && line.charAt(1) === " ") {
                todos.push([line.substring(2), marker === "+"])
            }
        } else if (section === "QUICK_ACCESS") {
            let comma = line.indexOf(",")
            if (comma <= 0) continue     // need a non-empty label
            let label = line.substring(0, comma)
            let cmd = line.substring(comma + 1)
            qa.push([label, cmd])
        }
    }
    return {todos: todos, qa: qa}
}

// Build fshrc text from in-memory model. Inverse of parseConfig.
_fsh.serializeConfig = function(todos, qa) {
    let out = "[TODO]\n"
    for (let i = 0; i < todos.length; i++) {
        let t = todos[i]
        out += (t[1] ? "+ " : "- ") + t[0] + "\n"
    }
    out += "\n[QUICK_ACCESS]\n"
    for (let i = 0; i < qa.length; i++) {
        out += qa[i][0] + "," + qa[i][1] + "\n"
    }
    return out
}

// Read fshrc; populate todoWidget.todoList and quickAccessWidget.entries.
// Falls back to defaults on missing/empty/malformed file.
_fsh.loadConfig = function() {
    let f = files.open(_fsh.CONFIG_PATH)
    let parsed = {todos: [], qa: []}
    if (f.exists) {
        try {
            parsed = _fsh.parseConfig(f.sread())
        } catch (e) {
            serial.printerr("fsh.loadConfig: parse failed: " + e)
            parsed = {todos: [], qa: []}
        }
    }
    todoWidget.todoList = parsed.todos
    quickAccessWidget.entries = (parsed.qa.length > 0)
        ? parsed.qa
        : _fsh.DEFAULT_QA.slice()   // copy so saves don't mutate the constant
}

// Persist the current in-memory todos + QA entries to fshrc.
_fsh.saveConfig = function() {
    try {
        let f = files.open(_fsh.CONFIG_PATH)
        if (!f.exists) f.mkFile()
        f.swrite(_fsh.serializeConfig(todoWidget.todoList, quickAccessWidget.entries))
    } catch (e) {
        serial.printerr("fsh.saveConfig: write failed: " + e)
    }
}

// Draw the bordered popup background. (row, col) is the top-left, (h, w)
// the size. Paints an opaque interior first (otherwise the wallpaper bleeds
// through cells with bg 255), then delegates frame drawing to wintex so the
// corner/edge glyphs always connect correctly.
_fsh.drawDialogFrame = function(row, col, h, w, title) {
    con.color_pair(_fsh.DIALOG_FG, _fsh.DIALOG_BG)
    for (let y = 0; y < h; y++) {
        con.move(row + y, col)
        print(' '.repeat(w))
    }
    let wo = new win.WindowObject(col, row, w, h, function(){}, function(){}, title)
    wo.isHighlighted = true
    wo.titleBack = _fsh.DIALOG_BG
    wo.drawFrame()
    con.color_pair(_fsh.DIALOG_FG, _fsh.DIALOG_BG)
}

// Slide the visible window so the caret stays inside (cursor at the
// rightmost column once it passes the field width).
_fsh.fieldScroll = function(cursor, width) {
    return cursor < width ? 0 : cursor - width + 1
}

// Draw a single-line bordered input field at (row, col) with given width.
// content is the current text; cursor is the caret offset within content
// focused brightens the border colour.
_fsh.drawDialogField = function(row, col, width, content, cursor, focused) {
    let frameFg = focused ? _fsh.DIALOG_FG : _fsh.DIALOG_DIM_FG
    // Clear the field area (3 rows × width+2 cols) with FIELD_BG first so any
    // stale chars from a previous render are wiped before we draw on top.
    con.color_pair(_fsh.DIALOG_FG, _fsh.FIELD_BG)
    con.move(row + 1, col + 1)
    print(' '.repeat(width))
    // Top border
    con.color_pair(frameFg, _fsh.DIALOG_BG)
    con.move(row, col)
    print('\u00DA')                                  // ┌
    print('\u00C4'.repeat(width))                    // ─
    print('\u00BF')                                  // ┐
    // Vertical borders + content
    con.move(row + 1, col)
    print('\u00B3')                                  // │
    con.color_pair(_fsh.DIALOG_FG, _fsh.DIALOG_BG)
    let scroll = _fsh.fieldScroll(cursor, width)
    let visible = content.substring(scroll, scroll + width)
    print(visible)
    con.color_pair(frameFg, _fsh.DIALOG_BG)
    con.move(row + 1, col + width + 1)
    print('\u00B3')                                  // │
    // Bottom border
    con.move(row + 2, col)
    print('\u00C0')                                  // └
    print('\u00C4'.repeat(width))                    // ─
    print('\u00D9')                                  // ┘
    con.color_pair(_fsh.DIALOG_FG, _fsh.DIALOG_BG)
}

// Draw a button as "[ Label ]" at the given position; highlights when focused.
_fsh.drawDialogButton = function(row, col, label, focused) {
    if (focused) con.color_pair(_fsh.HL_FG, _fsh.DIALOG_BG)
    else con.color_pair(_fsh.DIALOG_FG, _fsh.DIALOG_BG)
    con.move(row, col)
    print("[ " + label + " ]")
    con.color_pair(_fsh.DIALOG_FG, _fsh.DIALOG_BG)
}

// Modal dialog. opts = {
//   title: string,
//   fields: [{label, initial, width}, ...],
//   allowDelete: bool,
// }
// Returns {action: "ok"|"cancel"|"delete", values: [string, ...]}.
_fsh.showDialog = function(opts) {
    let fields = opts.fields
    let values = fields.map(function(f) { return f.initial || "" })
    // Caret position per field. Start at end of any pre-filled initial text.
    let cursors = values.map(function(v) { return v.length })

    // Layout
    let maxFieldW = fields.reduce(function(m, f) { return Math.max(m, f.width) }, 16)
    let titleW = (opts.title ? opts.title.length : 0) + 4
    let w = Math.max(maxFieldW + 6, titleW + 4, 24)
    let buttonsRow = 2 + fields.length * 4 + 1  // 1 label + 3 field rows per field
    let h = buttonsRow + 2
    let screen = con.getmaxyx()
    let row = Math.max(2, Math.floor((screen[0] - h) / 2))
    let col = Math.max(2, Math.floor((screen[1] - w) / 2))

    // Buttons list: indices follow Tab order after the last field
    let buttons = [{label: "OK", action: "ok"}, {label: "Cancel", action: "cancel"}]
    if (opts.allowDelete) buttons.splice(1, 0, {label: "Delete", action: "delete"})

    let focusIdx = 0            // 0..fields.length-1 = field; then buttons
    let totalFocus = fields.length + buttons.length
    let done = null             // {action, values} when set

    function render() {
        _fsh.drawDialogFrame(row, col, h, w, opts.title)
        // Fields
        for (let i = 0; i < fields.length; i++) {
            let labelRow = row + 1 + i * 4
            let fieldRow = labelRow + 1
            con.color_pair(_fsh.DIALOG_FG, _fsh.DIALOG_BG)
            con.move(labelRow, col + 2)
            print(fields[i].label + ":")
            _fsh.drawDialogField(fieldRow, col + 2, fields[i].width,
                values[i], cursors[i], i === focusIdx)
        }
        // Buttons centred on buttonsRow
        let totalBtnW = buttons.reduce(function(s, b) { return s + b.label.length + 5 }, 0) - 1
        let bx = col + Math.floor((w - totalBtnW) / 2)
        for (let i = 0; i < buttons.length; i++) {
            let bIdx = fields.length + i
            _fsh.drawDialogButton(row + buttonsRow, bx, buttons[i].label, bIdx === focusIdx)
            bx += buttons[i].label.length + 5
        }
        // Position the visible caret. Inside a field: place it on the content
        // row at the cursor offset (corrected for horizontal scroll). On a
        // button: hide the caret entirely.
        if (focusIdx < fields.length) {
            let fldWidth = fields[focusIdx].width
            let scroll = _fsh.fieldScroll(cursors[focusIdx], fldWidth)
            let contentRow = row + 1 + focusIdx * 4 + 2
            let contentCol = col + 2 + 1 + (cursors[focusIdx] - scroll)
            con.move(contentRow, contentCol)
            con.curs_set(1)
        } else {
            con.curs_set(0)
        }
    }

    render()

    // Note: con.getch() returns TSVM scancodes (defined in JS_INIT.js as
    // con.KEY_UP=200, KEY_DOWN=208, KEY_LEFT=203, KEY_RIGHT=205,
    // con.KEY_BACKSPACE=8, KEY_TAB=9, KEY_RETURN=10). Esc isn't in JS_INIT's
    // map — it arrives as ASCII 27 via keyTyped().
    while (done === null) {
        let k = con.getch()

        if (k === 27) {  // Esc
            done = {action: "cancel", values: values}
            break
        }
        if (k === con.KEY_TAB) {
            focusIdx = (focusIdx + 1) % totalFocus
            render()
            continue
        }
        // Up/Down always cycles focus across fields/buttons.
        if (k === con.KEY_UP) {
            focusIdx = (focusIdx - 1 + totalFocus) % totalFocus
            render()
            continue
        }
        if (k === con.KEY_DOWN) {
            focusIdx = (focusIdx + 1) % totalFocus
            render()
            continue
        }
        // Left/Right moves the caret inside a field; on a button it cycles.
        if (k === con.KEY_LEFT) {
            if (focusIdx < fields.length) {
                if (cursors[focusIdx] > 0) {
                    cursors[focusIdx] -= 1
                    render()
                }
            } else {
                focusIdx = (focusIdx - 1 + totalFocus) % totalFocus
                render()
            }
            continue
        }
        if (k === con.KEY_RIGHT) {
            if (focusIdx < fields.length) {
                if (cursors[focusIdx] < values[focusIdx].length) {
                    cursors[focusIdx] += 1
                    render()
                }
            } else {
                focusIdx = (focusIdx + 1) % totalFocus
                render()
            }
            continue
        }
        // On a field
        if (focusIdx < fields.length) {
            if (k === con.KEY_RETURN) {
                if (focusIdx < fields.length - 1) {
                    focusIdx += 1
                } else {
                    focusIdx = fields.length  // move to OK button
                }
                render()
                continue
            }
            if (k === con.KEY_BACKSPACE) {
                let c = cursors[focusIdx]
                if (c > 0) {
                    let v = values[focusIdx]
                    values[focusIdx] = v.substring(0, c - 1) + v.substring(c)
                    cursors[focusIdx] = c - 1
                    render()
                }
                continue
            }
            // Printable: insert at the caret.
            if (k >= 32 && k < 256 && values[focusIdx].length < fields[focusIdx].width * 4) {
                let v = values[focusIdx]
                let c = cursors[focusIdx]
                values[focusIdx] = v.substring(0, c) + String.fromCharCode(k) + v.substring(c)
                cursors[focusIdx] = c + 1
                render()
            }
            continue
        }
        // On a button
        if (k === con.KEY_RETURN || k === 32) {
            done = {action: buttons[focusIdx - fields.length].action, values: values}
            break
        }
    }

    con.curs_set(0)
    return done
}

// Map (mouse char x, mouse char y) to a row index for a widget drawn at
// (xoff, yoff) with `length` existing entries and `maxRows` total rows.
// Returns null / {kind:"add"} / {kind:"item", index: i}.
_fsh.hitTestList = function(charX, charY, xoff, yoff, textWidth, length, maxRows) {
    // Each row sits at (yoff + i + 2, xoff..xoff + textWidth + 1).
    // Column range: icon at xoff, text at xoff+2 .. xoff+1+textWidth.
    // Allow clicks anywhere on the row's char cells (icon + text region).
    let relY = charY - yoff - 2
    if (relY < 0 || relY >= maxRows) return null
    if (charX < xoff || charX > xoff + 1 + textWidth) return null
    if (relY < length) return {kind: "item", index: relY}
    if (relY === length) return {kind: "add"}
    return null
}

_fsh.titlebarTex = new GL.Texture(2, 14, base64.atob("/u/+/v3+/f39/f39/f39/f39/P39/Pz8/Pv7+w=="))
_fsh.scrdim = con.getmaxyx()
_fsh.scrwidth = _fsh.scrdim[1]
_fsh.scrheight = _fsh.scrdim[0]
_fsh.brandName = "f\xb3Sh"
_fsh.brandLogoTexSmall = new GL.Texture(24, 14, gzip.decomp(base64.atob(
"H4sIAAAAAAAAAPv/Hy/4Qbz458+fIeILQQBIwoSh6qECuMVBukCmIJkDVQ+RQNgLE0MX/w+1lyhxqIUwTLJ/sQMAcIXsbVABAAA="
)))
_fsh.scrlayout = ["com.fsh.clock","com.fsh.calendar","com.fsh.todo_list", "com.fsh.quick_access"]

_fsh.drawWallpaper = function() {
    let wp = files.open("A:/home/wall.bytes")
//    filesystem.open("A", "/tvdos/wall.bytes", "R")
    let b = sys.malloc(250880)
//    dma.comToRam(0, 0, b, 250880)
    wp.pread(b, 250880, 0)
    dma.ramToFrame(b, 0, 250880)
    sys.free(b)
}

_fsh.drawTitlebar = function(titletext) {
    GL.drawTexPattern(_fsh.titlebarTex, 0, 0, 560, 14)
    if (titletext === undefined || titletext.length == 0) {
        con.move(1,1)
        print(" ".repeat(_fsh.scrwidth))
        GL.drawTexImageOver(_fsh.brandLogoTexSmall, 268, 0)
    }
    else {
        con.color_pair(240, 255)
        GL.drawTexPattern(_fsh.titlebarTex, 268, 0, 24, 14)
        con.move(1, 1 + (_fsh.scrwidth - titletext.length) / 2)
        print(titletext)
    }
    con.color_pair(254, 255)
}


_fsh.Widget = function(id, w, h) {
    this.identifier = id
    this.width = w
    this.height = h

    if (!this.identifier) {
        this.identifier = ""
    }

    //this.update = function() {}
    /**
     * Params charXoff and charYoff are ZERO-BASED!
     */
    this.draw = function(charXoff, charYoff) {}
}

_fsh.widgets = {}
_fsh.registerNewWidget = function(widget) {
    _fsh.widgets[widget.identifier] = widget
}

let clockWidget = new _fsh.Widget("com.fsh.clock", _fsh.scrwidth - 8, 7*2)
clockWidget.numberSheet = new GL.SpriteSheet(19, 22, new GL.Texture(190, 22, gzip.decomp(base64.atob(
"H4sIAAAAAAAAAMWVW3LEMAgE739aHcFJJV5ZMD2I9ToVfcl4GBr80HF8r/FaR1ozMuIyoUu87lEXI0al5qVR5AebSwchSaNE6Nyo1Nw5HXF3SfPT4Bshl"+
"EycA8RD96mLlHbuhTgOrfLnUDZspafbSQWk56WEGvQEtWaWwgb8iz7a8AOXhsraO/q9Qw2/GnXovfVN+q2wM/p/oddn2cjF239GX3y11+SWCtc6FTHC1v"+
"TVPkDPWWn0w+DDz93UX9v9mF5KIsQ6OdN2KJoB4ui1bXXr0AMp0YfiQo//4XhpK8555dsNehAqVS5uhb5iHn3Kko769J59KmLBe/TSR7hcsd+hr+HnrwR"+
"9uvRF9+D3MP14gN7lqx+8OuNT+uqt3NFX3SN9fTbeeHNq+C29pRWzX5+Rcm7SZyjOKJ/2hkSPqul4xN279DrSYvCrNu2NI7ZMp1ouBxK3KBVVnEeAUWbK"+
"MUDn5DPsPxmUqHZQjGpy2hergM3EVBAAAA=="
))))

clockWidget.clockColon = new GL.Texture(4, 3, base64.atob("7+/v7+/v7+/v7+/v"))
clockWidget.monthNames = ["Spring", "Summer", "Autumn", "Winter"]
clockWidget.dayNames = ["Mondag  ", "Tysdag  ", "Midtveke", "Torsdag ", "Fredag  ", "Laurdag ", "Sundag  ", "Verddag "]
clockWidget.draw = function(charXoff, charYoff) {
    con.color_pair(254, 255)
    let xoff = charXoff * 7
    let yoff = charYoff * 14 + 3
    let timeInMinutes = ((sys.currentTimeInMills() / 60000)|0)
    let mins = timeInMinutes % 60
    let hours = ((timeInMinutes / 60)|0) % 24
    let ordinalDay = ((timeInMinutes / (60*24))|0) % 120
    let visualDay = (ordinalDay % 30) + 1
    let months = ((timeInMinutes / (60*24*30))|0) % 4
    let dayName = ordinalDay % 7 // 0 for Mondag
    if (ordinalDay == 119) dayName = 7 // Verddag
    let years = ((timeInMinutes / (60*24*30*120))|0) + 125
    // draw timepiece
    GL.drawSprite(clockWidget.numberSheet, (hours / 10)|0, 0, xoff, yoff, 1)
    GL.drawSprite(clockWidget.numberSheet, hours % 10, 0, xoff + 24, yoff, 1)
    GL.drawTexImage(clockWidget.clockColon, xoff + 48, yoff + 5, 1)
    GL.drawTexImage(clockWidget.clockColon, xoff + 48, yoff + 14, 1)
    GL.drawSprite(clockWidget.numberSheet, (mins / 10)|0, 0, xoff + 57, yoff, 1)
    GL.drawSprite(clockWidget.numberSheet, mins % 10, 0, xoff + 81, yoff, 1)
    // print month and date
    con.move(1 + charYoff, 17 + charXoff)
    print(clockWidget.monthNames[months]+" "+visualDay)
    // print year and dayname
    con.move(2 + charYoff, 17 + charXoff)
    print("\xE7"+years+" "+clockWidget.dayNames[dayName])
}


let calendarWidget = new _fsh.Widget("com.fsh.calendar", (_fsh.scrwidth - 8) / 2, 7*6)
calendarWidget.dayLabels = [
    " 1  2  3  4  5  6  7 \xFA\xFA",
    " 8  9 10 11 12 13 14 \xFA\xFA",
    "15 16 17 18 19 20 21 \xFA\xFA",
    "22 23 24 25 26 27 28 \xFA\xFA",
    "29 30  1  2  3  4  5 \xFA\xFA",
    " 6  7  8  9 10 11 12 \xFA\xFA",
    "13 14 15 16 17 18 19 \xFA\xFA",
    "20 21 22 23 24 25 26 \xFA\xFA",
    "27 28 29 30  1  2  3 \xFA\xFA",
    " 4  5  6  7  8  9 10 \xFA\xFA",
    "11 12 13 14 15 16 17 \xFA\xFA",
    "18 19 20 21 22 23 24 \xFA\xFA",
    "25 26 27 28 29 30  1 \xFA\xFA",
    " 2  3  4  5  6  7  8 \xFA\xFA",
    " 9 10 11 12 13 14 15 \xFA\xFA",
    "16 17 18 19 20 21 22 \xFA\xFA",
    "23 24 25 26 27 28 29 30"
]
calendarWidget.seasonCols = [229,39,215,239,253]
calendarWidget.draw = function(charXoff, charYoff) {
    con.color_pair(254, 255)
    let xoff = charXoff * 7
    let yoff = charYoff * 14 + 3

    let timeInMinutes = ((sys.currentTimeInMills() / 60000)|0)
    let ordinalDay = ((timeInMinutes / (60*24))|0) % 120
    let offset = (119 == ordinalDay) ? 16 : (ordinalDay / 7)|0


    con.move(charYoff, charXoff)
    print("Mo Ty Mi To Fr La Su Ve")

    for (let i = -3; i <= 3; i++) {
        let lineOff = (offset + i + 17) % 17 // adding 17 to prevent mod-ing on negative number
        let line = calendarWidget.dayLabels[lineOff]
        let textCol = 0

        con.move(charYoff + 4 + i, charXoff)

        for (let x = 0; x <= 23; x++) {
            let paintingDayOrd = lineOff*7 + ((x/3)|0)
            if (x >= 21 && lineOff != 16) textCol = calendarWidget.seasonCols[4]
            else textCol = calendarWidget.seasonCols[(paintingDayOrd / 30)|0]

            // special colour for spaces between numbers
            if (x % 3 == 2) con.color_pair(255,255)
            // mark today
            else if (paintingDayOrd == ordinalDay && x < 21 || paintingDayOrd == 119 && ordinalDay == 119) con.color_pair(0,textCol)
            // paint normal day number with seasonal colour
            else con.color_pair(textCol,255)

            con.addch(line.charCodeAt(x))
            con.curs_right()
        }
    }
}

let todoWidget = new _fsh.Widget("com.fsh.todo_list", (_fsh.scrwidth - 8) / 2, 7*10)
todoWidget.todoList = [["Hello, world!", true]]
todoWidget.draw = function(charXoff, charYoff) {
    let focusIndex = (_fsh.focus && _fsh.focus.widgetId === todoWidget.identifier)
        ? _fsh.focus.index : -1

    con.color_pair(254, 255)
    let xoff = charXoff * 7
    let yoff = charYoff * 14 + 3

    con.move(charYoff, charXoff)
    print('\u00CD'.repeat(10)+" TODO "+'\u00CD'.repeat(10))

    for (let i = 0; i <= 12; i++) {
        let list = todoWidget.todoList[i] || ["Click to add"+" ".repeat(_fsh.TODO_TEXT_WIDTH - 12), null]
        let isFocused = (i === focusIndex)

        if (isFocused) con.color_pair(_fsh.HL_FG, _fsh.HL_BG)
        else if (list[1] === null) con.color_pair(249, 255)
        else con.color_pair(254, 255)

        con.move(charYoff + i + 2, charXoff)
        con.addch((list[1] === null) ? 43 : (list[1]) ? 0x9F : 0x9E)

        if (i > todoWidget.todoList.length) {
            // Filler row \u2014 keep underscores but don't highlight (can't focus here)
            con.color_pair(254, 255)
            for (let k = 0; k < 24; k++) {
                con.mvaddch(charYoff + i + 2, charXoff + 2 + k, 95)
            }
        }
        else {
            con.move(charYoff + i + 2, charXoff + 2)
            // Pad text to TODO_TEXT_WIDTH so the highlight bar covers full row
            let text = `${list[0]}`
            if (text.length > _fsh.TODO_TEXT_WIDTH) text = text.substring(0, _fsh.TODO_TEXT_WIDTH)
            if (isFocused) text = text + " ".repeat(_fsh.TODO_TEXT_WIDTH - text.length)
            print(text)
        }
    }
}

let quickAccessWidget = new _fsh.Widget("com.fsh.quick_access", (_fsh.scrwidth - 8) / 2, 7*20)
quickAccessWidget.entries = [ // TODO read from /home/config/fshrc
    ["Files", "/tvdos/bin/zfm.js"],
    ["Editor", "/tvdos/bin/edit.js"],
    ["BASIC", "/tbas/basic.js"],
    ["DOS Shell", "/tvdos/bin/command.js -fancy"]
]
quickAccessWidget.draw = function(charXoff, charYoff) {
    let focusIndex = (_fsh.focus && _fsh.focus.widgetId === quickAccessWidget.identifier)
        ? _fsh.focus.index : -1

    con.color_pair(254, 255)
    let xoff = charXoff * 7
    let yoff = charYoff * 14 + 3

    con.move(charYoff, charXoff)
    print('\u00CD'.repeat(6)+" QUICK ACCESS "+'\u00CD'.repeat(6))

    for (let i = 0; i <= 21; i++) {
        let list = quickAccessWidget.entries[i] || ["Click to add"+" ".repeat(_fsh.QA_LABEL_WIDTH - 12), null]
        let isFocused = (i === focusIndex)

        if (isFocused) con.color_pair(_fsh.HL_FG, _fsh.HL_BG)
        else if (list[1] === null) con.color_pair(249, 255)
        else con.color_pair(254, 255)

        con.move(charYoff + i + 2, charXoff)
        con.addch((list[1] === null) ? 0xF9 : (list[1]) ? 7 : 0x7F)

        if (i > quickAccessWidget.entries.length) {
            con.color_pair(254, 255)
            for (let k = 0; k < 24; k++) {
                con.mvaddch(charYoff + i + 2, charXoff + 2 + k, 95)
            }
        }
        else {
            con.move(charYoff + i + 2, charXoff + 2)
            let text = `${list[0]}`
            if (text.length > _fsh.QA_LABEL_WIDTH) text = text.substring(0, _fsh.QA_LABEL_WIDTH)
            if (isFocused) text = text + " ".repeat(_fsh.QA_LABEL_WIDTH - text.length)
            print(text)
        }
    }
}

todoWidget.hitTest = function(charX, charY, xoff, yoff) {
    return _fsh.hitTestList(charX, charY, xoff, yoff,
        _fsh.TODO_TEXT_WIDTH, todoWidget.todoList.length, _fsh.TODO_MAX_ROWS)
}

quickAccessWidget.hitTest = function(charX, charY, xoff, yoff) {
    return _fsh.hitTestList(charX, charY, xoff, yoff,
        _fsh.QA_LABEL_WIDTH, quickAccessWidget.entries.length, _fsh.QA_MAX_ROWS)
}


// Re-render the whole shell. Use after a dialog closes (which clobbered
// the underlying char cells) or after execApp returns.
_fsh.redrawAll = function() {
    con.color_pair(254, 255)
    con.clear()
    graphics.clearPixels(255)
    graphics.clearPixels2(255)
    graphics.setFramebufferScroll(0, 0)
    _fsh.drawWallpaper()
    _fsh.drawTitlebar()
    _fsh.widgets["com.fsh.clock"].draw(25, 3)
    _fsh.widgets["com.fsh.calendar"].draw(12, 8)
    _fsh.widgets["com.fsh.todo_list"].draw(10, 17)
    _fsh.widgets["com.fsh.quick_access"].draw(47, 8)
}

_fsh.openAddTodoDialog = function() {
    let res = _fsh.showDialog({
        title: "New Todo",
        fields: [{label: "Text", initial: "", width: _fsh.TODO_TEXT_WIDTH}],
        allowDelete: false
    })
    _fsh.redrawAll()
    if (res.action !== "ok") return
    let text = res.values[0].trim()
    if (text.length === 0) return
    if (todoWidget.todoList.length >= _fsh.TODO_MAX_ROWS) return
    todoWidget.todoList.push([text, false])
    _fsh.saveConfig()
}

_fsh.openEditTodoDialog = function(index) {
    let entry = todoWidget.todoList[index]
    if (!entry) return
    let res = _fsh.showDialog({
        title: "Edit Todo",
        fields: [{label: "Text", initial: entry[0], width: _fsh.TODO_TEXT_WIDTH}],
        allowDelete: true
    })
    _fsh.redrawAll()
    if (res.action === "cancel") return
    if (res.action === "delete") {
        todoWidget.todoList.splice(index, 1)
        _fsh.saveConfig()
        return
    }
    let text = res.values[0].trim()
    if (text.length === 0) return
    todoWidget.todoList[index] = [text, entry[1]]
    _fsh.saveConfig()
}

_fsh.openAddQaDialog = function() {
    let res = _fsh.showDialog({
        title: "New Quick Access",
        fields: [
            {label: "Label",   initial: "", width: _fsh.QA_LABEL_WIDTH},
            {label: "Command", initial: "", width: _fsh.QA_CMD_WIDTH}
        ],
        allowDelete: false
    })
    _fsh.redrawAll()
    if (res.action !== "ok") return
    let label = res.values[0].trim()
    let cmd = res.values[1].trim()
    if (label.length === 0 || cmd.length === 0) return
    if (quickAccessWidget.entries.length >= _fsh.QA_MAX_ROWS) return
    quickAccessWidget.entries.push([label, cmd])
    _fsh.saveConfig()
}

_fsh.openEditQaDialog = function(index) {
    let entry = quickAccessWidget.entries[index]
    if (!entry) return
    let res = _fsh.showDialog({
        title: "Edit Quick Access",
        fields: [
            {label: "Label",   initial: entry[0], width: _fsh.QA_LABEL_WIDTH},
            {label: "Command", initial: entry[1], width: _fsh.QA_CMD_WIDTH}
        ],
        allowDelete: true
    })
    _fsh.redrawAll()
    if (res.action === "cancel") return
    if (res.action === "delete") {
        quickAccessWidget.entries.splice(index, 1)
        _fsh.saveConfig()
        return
    }
    let label = res.values[0].trim()
    let cmd = res.values[1].trim()
    if (label.length === 0 || cmd.length === 0) return
    quickAccessWidget.entries[index] = [label, cmd]
    _fsh.saveConfig()
}

_fsh.toggleTodoDone = function(index) {
    let entry = todoWidget.todoList[index]
    if (!entry) return
    entry[1] = !entry[1]
    _fsh.saveConfig()
}

// Launch a Quick Access entry. cmd is the verbatim string the user typed.
// We split on first space to derive a program path + args; if the path
// has no leading "/", we treat it as relative to the current drive.
_fsh.launchEntry = function(label, cmd) {
    let firstSpace = cmd.indexOf(" ")
    let progPath = (firstSpace >= 0) ? cmd.substring(0, firstSpace) : cmd
    let argTail = (firstSpace >= 0) ? cmd.substring(firstSpace + 1) : ""
    let fullPath = progPath.startsWith("/") ? ("A:" + progPath) : progPath

    try {
        let f = files.open(fullPath)
        if (!f.exists) {
            serial.printerr("fsh.launchEntry: not found: " + fullPath)
            return
        }
        let code = f.sread()
        let tokens = [progPath].concat(argTail.length ? argTail.split(" ") : [])

        // erase all pixels and draw wallpaper
        con.reset_graphics()
        con.clear()
        graphics.clearPixels(255)
        graphics.clearPixels2(255)
        _fsh.drawWallpaper()
        con.curs_set(1)

        execApp(code, tokens)
    } catch (e) {
        serial.printerr("fsh.launchEntry: " + label + " failed: " + e)
    }
    con.curs_set(0)
    graphics.setBackground(2,1,3)
    graphics.resetPalette()
    _fsh.redrawAll()
}

// Layout map: widget positions hard-coded to match the draw calls below.
_fsh.layouts = {
    "com.fsh.todo_list":    {xoff: 10, yoff: 17, widget: null},
    "com.fsh.quick_access": {xoff: 47, yoff: 8,  widget: null}
}

// Find which widget (if any) was hit by (charX, charY). Returns
// {widgetId, hit} or null.
_fsh.findHit = function(charX, charY) {
    let ids = ["com.fsh.todo_list", "com.fsh.quick_access"]
    for (let i = 0; i < ids.length; i++) {
        let id = ids[i]
        let layout = _fsh.layouts[id]
        let widget = _fsh.widgets[id]
        let hit = widget.hitTest(charX, charY, layout.xoff, layout.yoff)
        if (hit) return {widgetId: id, hit: hit}
    }
    return null
}

_fsh.dispatchLeft = function(widgetId, hit) {
    if (hit.kind === "add") {
        if (widgetId === "com.fsh.todo_list") _fsh.openAddTodoDialog()
        else                                  _fsh.openAddQaDialog()
        return
    }
    // hit.kind === "item"
    if (widgetId === "com.fsh.todo_list") {
        _fsh.toggleTodoDone(hit.index)
    } else {
        let entry = quickAccessWidget.entries[hit.index]
        if (entry) _fsh.launchEntry(entry[0], entry[1])
    }
}

_fsh.dispatchRight = function(widgetId, hit) {
    if (hit.kind !== "item") return
    if (widgetId === "com.fsh.todo_list") _fsh.openEditTodoDialog(hit.index)
    else                                  _fsh.openEditQaDialog(hit.index)
}


// change graphics mode and check if it's supported
graphics.setGraphicsMode(3)
if (graphics.getGraphicsMode() == 0) {
    printerrln("Insufficient VRAM")
    return 1
}

// register widgets
_fsh.registerNewWidget(clockWidget)
_fsh.registerNewWidget(calendarWidget)
_fsh.registerNewWidget(todoWidget)
_fsh.registerNewWidget(quickAccessWidget)

// screen init
con.color_pair(254, 255)
con.clear()
con.curs_set(0)
graphics.clearPixels(255)
graphics.clearPixels2(255)
graphics.setFramebufferScroll(0,0)
_fsh.drawWallpaper()
_fsh.drawTitlebar()


// Load persisted state before the first draw
_fsh.loadConfig();

// keyEventBuffers (read via sys.peek(-41-i)) holds *raw libGDX keycodes*,
// not the cooked TSVM scancodes that con.getch() returns. Existing fsh.js
// already uses 67 for Backspace (libGDX DEL); follow the same scheme here.
const KEY_ESC    = keysym.ESCAPE
const KEY_ENTER  = keysym.ENTER
const KEY_UP     = keysym.UP
const KEY_DOWN   = keysym.DOWN
const KEY_LEFT   = keysym.LEFT
const KEY_RIGHT  = keysym.RIGHT
const KEY_LSHIFT = keysym.SHIFT_LEFT
const KEY_RSHIFT = keysym.SHIFT_RIGHT

let prevButtons = 0
let prevMouseCharX = -1
let prevMouseCharY = -1
let keyLatch = {}   // {keycode: true} while the key is held — debounces "just pressed"

while (true) {
    captureUserInput()

    // -- keyboard --
    if (isKeyDown(KEY_ESC)) break;

    let shiftDown = isKeyDown(KEY_LSHIFT) || isKeyDown(KEY_RSHIFT)
    let enterPressed = false

    // Edge-detect each navigation key
    function edge(kc) {
        let down = isKeyDown(kc)
        let was  = !!keyLatch[kc]
        keyLatch[kc] = down
        return down && !was
    }

    if (edge(KEY_ENTER)) enterPressed = true;
    let navUp    = edge(KEY_UP)
    let navDown  = edge(KEY_DOWN)
    let navLeft  = edge(KEY_LEFT)
    let navRight = edge(KEY_RIGHT)

    // -- mouse --
    let pos = readMousePos()
    let charX = (pos[0] / 7) | 0
    let charY = (pos[1] / 14) | 0
    let mouseMoved = (charX !== prevMouseCharX || charY !== prevMouseCharY)
    prevMouseCharX = charX
    prevMouseCharY = charY

    let buttons = readMouseButtons()
    let leftEdge  = ((buttons & _fsh.MB_LEFT)  !== 0) && ((prevButtons & _fsh.MB_LEFT)  === 0)
    let rightEdge = ((buttons & _fsh.MB_RIGHT) !== 0) && ((prevButtons & _fsh.MB_RIGHT) === 0)
    prevButtons = buttons

    // -- focus update --
    if (navUp || navDown || navLeft || navRight) {
        if (!_fsh.focus) _fsh.focus = {widgetId: "com.fsh.todo_list", index: 0}
        if (navUp || navDown) {
            let layout = _fsh.layouts[_fsh.focus.widgetId]
            let maxRows = (_fsh.focus.widgetId === "com.fsh.todo_list")
                ? _fsh.TODO_MAX_ROWS : _fsh.QA_MAX_ROWS
            let length = (_fsh.focus.widgetId === "com.fsh.todo_list")
                ? todoWidget.todoList.length : quickAccessWidget.entries.length
            let maxIdx = Math.min(length, maxRows - 1)
            let next = _fsh.focus.index + (navDown ? 1 : -1)
            if (next < 0) next = 0
            if (next > maxIdx) next = maxIdx
            _fsh.focus.index = next
        } else {
            // Left/right switches widget
            let other = (_fsh.focus.widgetId === "com.fsh.todo_list")
                ? "com.fsh.quick_access" : "com.fsh.todo_list"
            let otherLength = (other === "com.fsh.todo_list")
                ? todoWidget.todoList.length : quickAccessWidget.entries.length
            let otherMaxRows = (other === "com.fsh.todo_list")
                ? _fsh.TODO_MAX_ROWS : _fsh.QA_MAX_ROWS
            let otherMaxIdx = Math.min(otherLength, otherMaxRows - 1)
            _fsh.focus = {widgetId: other, index: Math.min(_fsh.focus.index, otherMaxIdx)}
        }
    } else if (mouseMoved) {
        let h = _fsh.findHit(charX, charY)
        _fsh.focus = h ? {widgetId: h.widgetId, index: h.hit.kind === "add"
                            ? ((h.widgetId === "com.fsh.todo_list")
                                ? todoWidget.todoList.length
                                : quickAccessWidget.entries.length)
                            : h.hit.index} : null
    }

    // -- mouse click dispatch --
    if (leftEdge) {
        let h = _fsh.findHit(charX, charY)
        if (h) _fsh.dispatchLeft(h.widgetId, h.hit)
    } else if (rightEdge) {
        let h = _fsh.findHit(charX, charY)
        if (h) _fsh.dispatchRight(h.widgetId, h.hit)
    }

    // -- keyboard dispatch (synthesise click at focus) --
    if (enterPressed && _fsh.focus) {
        let length = (_fsh.focus.widgetId === "com.fsh.todo_list")
            ? todoWidget.todoList.length : quickAccessWidget.entries.length
        let hit = (_fsh.focus.index < length)
            ? {kind: "item", index: _fsh.focus.index}
            : (_fsh.focus.index === length ? {kind: "add"} : null)
        if (hit) {
            if (shiftDown) _fsh.dispatchRight(_fsh.focus.widgetId, hit)
            else           _fsh.dispatchLeft(_fsh.focus.widgetId, hit)
        }
    }

    // -- redraw --
    _fsh.widgets["com.fsh.clock"].draw(25, 3)
    _fsh.widgets["com.fsh.calendar"].draw(12, 8)
    _fsh.widgets["com.fsh.todo_list"].draw(10, 17)
    _fsh.widgets["com.fsh.quick_access"].draw(47, 8)

    sys.spin(); sys.spin()
}

con.reset_graphics()
con.clear()