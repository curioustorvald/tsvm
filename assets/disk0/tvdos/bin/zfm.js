const win = require("wintex")
const keys = require("keysym")
const filenav = require("filenav")

const COL_TEXT = 253
const COL_BACK = 255
const COL_BACK_SEL = 81
const COL_HLTEXT = 230
const COL_HLACTION = 39
const COL_DIR = COL_TEXT
const COL_SUPERTEXT = 239
const COL_DIMTEXT = 249
const COL_DISABLED = 244 // greyed-out op-panel buttons (mid grey on the 232..255 ramp)
const COL_LNUMBACK = 18
const COL_LNUMFORE = 253
const COL_BRAND = 161
const COL_BRAND_PAL = [241, 248]
const [WHEIGHT, WIDTH] = con.getmaxyx();const HEIGHT = WHEIGHT - 1
const SIDEBAR_WIDTH = 9
const LIST_HEIGHT = HEIGHT - 3
const FILESIZE_WIDTH = 7
const FILELIST_WIDTH = WIDTH - SIDEBAR_WIDTH - 3 - FILESIZE_WIDTH
const POPUP_WIDTH = 52 // always even number

const [SCRPW, SCRPH] = graphics.getPixelDimension()
const CELL_PW = (SCRPW / WIDTH) | 0
const CELL_PH = (SCRPH / WHEIGHT) | 0

const COL_HL_EXT = {
    "js": 215,
    "bas": 215,
    "bat": 215,
    "wav": 31,
    "adpcm": 31,
    "pcm": 32,
//    "mp3": 33,
    "tad": 33,
    "mp2": 34,
    "mv1": 213,
    "mv2": 213,
    "mv3": 213,
    "tav": 213,
    "ipf": 190,
    "ipf1": 190,
    "ipf2": 190,
    "im3": 190,
    "tap": 190,
    "txt": 223,
    "md": 223,
    "log": 223,
    "taud":109,
}

const EXEC_FUNS = {
    "wav": (f) => _G.shell.execute(`playwav "${f}" -i`),
    "adpcm": (f) => _G.shell.execute(`playwav "${f}" -i`),
//    "mp3": (f) => _G.shell.execute(`playmp3 "${f}" -i`),
    "mp2": (f) => _G.shell.execute(`playmp2 "${f}" -i`),
    "mv1": (f) => _G.shell.execute(`playmov "${f}" -i`),
    "mv2": (f) => _G.shell.execute(`playmov "${f}" -i`),
    "mv3": (f) => _G.shell.execute(`playmov "${f}" -i`),
    "tav": (f) => _G.shell.execute(`playmov "${f}" -i`),
    "im3": (f) => _G.shell.execute(`playmov "${f}" -i`),
    "tap": (f) => _G.shell.execute(`playmov "${f}" -i`),
    "tad": (f) => _G.shell.execute(`playtad "${f}" -i`),
    "pcm": (f) => _G.shell.execute(`playpcm "${f}" -i`),
    "ipf": (f) => _G.shell.execute(`decodeipf "${f}" -i`),
    "ipf1": (f) => _G.shell.execute(`decodeipf "${f}" -i`),
    "ipf2": (f) => _G.shell.execute(`decodeipf "${f}" -i`),
    "bas": (f) => _G.shell.execute(`basic "${f}"`),
    "txt": (f) => _G.shell.execute(`less "${f}"`),
    "md": (f) => _G.shell.execute(`less "${f}"`),
    "log": (f) => _G.shell.execute(`less "${f}"`),
    "taud": (f) => _G.shell.execute(`playtaud "${f}"`),
}

const EDIT_FUNS = {
    "taud": (f) => _G.shell.execute(`microtone "${f}"`),
}
const DEFAULT_EDITOR = `edit`

function makeExecFun(template) {
    return (f) => _G.shell.execute(template.replaceAll("{0}", `"${f}"`))
}

function loadZfmrc() {
    try {
        let zfmrcPath = `A:${_TVDOS.variables.USERCONFIGPATH}\\zfmrc`
        let zfmrcFile = files.open(zfmrcPath)
        if (!zfmrcFile.exists) return

        let content = zfmrcFile.sread()
        let lines = content.split(/\r?\n/)
        let currentSection = null

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim()
            if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue

            if (line.startsWith("[") && line.endsWith("]")) {
                currentSection = line.substring(1, line.length - 1).toUpperCase()
                continue
            }

            if (currentSection === "EXEC_FUNS") {
                let commaIdx = line.indexOf(",")
                if (commaIdx < 0) continue
                let ext = line.substring(0, commaIdx).trim().toLowerCase()
                let template = line.substring(commaIdx + 1).trim()
                if (ext.length === 0 || template.length === 0) continue
                EXEC_FUNS[ext] = makeExecFun(template)
            }
            else if (currentSection === "COL_HL_EXT") {
                let commaIdx = line.indexOf(",")
                if (commaIdx < 0) continue
                let ext = line.substring(0, commaIdx).trim().toLowerCase()
                let colStr = line.substring(commaIdx + 1).trim()
                if (ext.length === 0 || colStr.length === 0) continue
                let col = parseInt(colStr, 10)
                if (isNaN(col)) continue
                COL_HL_EXT[ext] = col
            }
        }
    } catch (e) {
        serial.println("zfm: failed to load zfmrc: " + e.message)
    }
}

loadZfmrc()

///////////////////////////////////////////////////////////////////////////////////////////////////
// Mouse region registry
///////////////////////////////////////////////////////////////////////////////////////////////////

const MOUSE_PANEL = []
let lastHoveredRegion = null

function pixelToCell(px, py) {
    return [(py / CELL_PH | 0) + 1, (px / CELL_PW | 0) + 1]
}
function regionHits(r, cy, cx) {
    return cy >= r.y && cy < r.y + r.h && cx >= r.x && cx < r.x + r.w
}
function clearPanelMouseRegions() { MOUSE_PANEL.length = 0; lastHoveredRegion = null }
function addPanelMouseRegion(x, y, w, h, handlers) { MOUSE_PANEL.push(Object.assign({x, y, w, h}, handlers)) }

function dispatchMouseEvent(event) {
    const t = event[0]
    if (t !== 'mouse_down' && t !== 'mouse_wheel' && t !== 'mouse_up' && t !== 'mouse_move') return false
    const [cy, cx] = pixelToCell(event[1], event[2])

    if (t === 'mouse_move') {
        let hit = null
        for (let i = MOUSE_PANEL.length - 1; i >= 0; i--) {
            const r = MOUSE_PANEL[i]
            if (regionHits(r, cy, cx) && (r.onHover || r.onHoverLeave)) { hit = r; break }
        }
        if (hit !== lastHoveredRegion) {
            if (lastHoveredRegion && lastHoveredRegion.onHoverLeave) lastHoveredRegion.onHoverLeave()
            lastHoveredRegion = hit
        }
        if (hit && hit.onHover) { hit.onHover(cy, cx, event); return true }
        return false
    }

    for (let i = MOUSE_PANEL.length - 1; i >= 0; i--) {
        const r = MOUSE_PANEL[i]
        if (!regionHits(r, cy, cx)) continue
        if (t === 'mouse_down'  && r.onClick)   { r.onClick(cy, cx, event[3], event); return true }
        if (t === 'mouse_wheel' && r.onWheel)   { r.onWheel(cy, cx, event[3], event); return true }
        if (t === 'mouse_up'    && r.onRelease) { r.onRelease(cy, cx, event[3], event); return true }
    }
    return false
}

// Main-loop state (the navigator coordinates with these through the hooks below).
let redrawRequested = false
let exit = false
let firstRunLatch = true
let pendingPostExecDrain = false

///////////////////////////////////////////////////////////////////////////////////////////////////
// Op panel (sidebar). NOT part of the navigator — zfm owns it and routes its
// buttons through nav.invokeAction(id).
///////////////////////////////////////////////////////////////////////////////////////////////////

// Op panel buttons. yOff is the row offset (icon) inside the op panel frame;
// label sits at yOff+1. Hit regions span both rows.
// hitH is the row count for the mouse hit-box. The switch button gets a taller
// hit-box than the others because the icon glyph above its label leaves extra
// whitespace inside the cell above the first horizontal rule.
const OP_BUTTONS = [
    { id: 'switch', yOff: 0,  hitH: 5, key: 'z' },
    { id: 'up',     yOff: 6,  hitH: 2, key: 'u' },
    { id: 'copy',   yOff: 9,  hitH: 2, key: 'c' },
    { id: 'move',   yOff: 12, hitH: 2, key: 'v' },
    { id: 'delete', yOff: 15, hitH: 2, key: 'd' },
    { id: 'mkdir',  yOff: 18, hitH: 2, key: 'k' },
    { id: 'rename', yOff: 21, hitH: 2, key: 'r' },
    { id: 'more',   yOff: 24, hitH: 2, key: 'm' },
    { id: 'quit',   yOff: 27, hitH: 2, key: 'q' },
]
let opHover = -1

let opPanelDraw = (wo) => {
    function hr(i, y) {
        // draw horizontal rule...
        con.color_pair(COL_TEXT, 255)
        con.move(y, xp)
        print(`\u00C4`.repeat(SIDEBAR_WIDTH - 2))

        // if mouse is up, draw the whole box
        if (opHover == i) {
            let moveBack = (i == 0) ? 6 : 3

            con.color_pair(COL_HLTEXT, 255)
            con.move(y - moveBack, xp)
             print('\u00CD'.repeat(SIDEBAR_WIDTH - 2))
            con.move(y, xp)
            print('\u00CD'.repeat(SIDEBAR_WIDTH - 2))
        }
    }
    // A disabled button (per nav.isEnabled) is drawn in a dim grey with its
    // action key no longer popping, and registers no hover/click (see
    // setupPanelMouseRegions), so it reads as inert rather than silently dead.
    function enabled(i) { return nav.isEnabled(OP_BUTTONS[i].id) }
    function labCol(i) { return !enabled(i) ? COL_DISABLED : (opHover === i) ? COL_HLTEXT : COL_TEXT }
    function actCol(i) { return !enabled(i) ? COL_DISABLED : COL_HLACTION }

    con.color_pair(COL_TEXT, COL_BACK)

    let xp = wo.x + 1
    let yp = wo.y + 1

    // other panel
    con.move(yp + 2, xp + 3)
    con.color_pair(labCol(0), 255); con.prnch((nav.windowMode) ? 0x11 : 0x10)
    con.move(yp + 3, xp)
    print(`  \x1B[38;5;${labCol(0)}m[\x1B[38;5;${actCol(0)}mZ\x1B[38;5;${labCol(0)}m]`)

    hr(0, yp+5)

    // go up
    con.color_pair(labCol(1), 255); con.mvaddch(yp + 6, xp + 3, 0x18)
    con.move(yp + 7, xp)
    print(` \x1B[38;5;${labCol(1)}mGo \x1B[38;5;${actCol(1)}mU\x1B[38;5;${labCol(1)}mp`)

    hr(1, yp+8)

    // copy
    con.move(yp + 9, xp + 2)
    con.color_pair(labCol(2), 255); con.prnch(0xDB);con.prnch((nav.windowMode) ? 0x1B : 0x1A);con.prnch(0xDB)
    con.move(yp + 10, xp)
    print(` \x1B[38;5;${actCol(2)}mC\x1B[38;5;${labCol(2)}mopy`)

    hr(2, yp+11)

    // move
    con.move(yp + 12, xp + 2)
    con.color_pair(labCol(3), 255); if (nav.windowMode) con.prnch([0xDB, 0x1B, 0xB0]); else con.prnch([0xB0, 0x1A, 0xDB])
    con.move(yp + 13, xp)
    print(` \x1B[38;5;${labCol(3)}mMo\x1B[38;5;${actCol(3)}mv\x1B[38;5;${labCol(3)}me`)

    hr(3, yp+14)

    // delete
    con.move(yp + 15, xp + 2)
    con.color_pair(labCol(4), 255); if (nav.windowMode) con.prnch([0xDB, 0x1A, 0xF9]); else con.prnch([0xF9, 0x1B, 0xDB])
    con.move(yp + 16, xp)
    print(` \x1B[38;5;${actCol(4)}mD\x1B[38;5;${labCol(4)}melete`)

    hr(4, yp+17)

    // mkdir
    con.move(yp + 18, xp + 2)
    con.color_pair(labCol(5), 255);
    con.prnch(0xDB)
    con.video_reverse();con.prnch(0x2B);con.video_reverse()
    con.prnch(0xDF)
    con.move(yp + 19, xp)
    print(` \x1B[38;5;${labCol(5)}mM\x1B[38;5;${actCol(5)}mk\x1B[38;5;${labCol(5)}mDir`)

    hr(5, yp+20)

    // rename
    con.move(yp + 21, xp + 2)
    con.color_pair(labCol(6), 255); con.prnch(0x4E);con.prnch(0x1A);con.prnch(0x52)
    con.move(yp + 22, xp)
    print(` \x1B[38;5;${actCol(6)}mR\x1B[38;5;${labCol(6)}mename`)

    hr(6, yp+23)

    // the dreaded hamburger menu
    con.move(yp + 24, xp + 3)
    con.color_pair(labCol(7), 255); con.prnch(0xf0)
    con.move(yp + 25, xp)
    print(` \x1B[38;5;${actCol(7)}mM\x1B[38;5;${labCol(7)}more`)

    hr(7, yp+26)

    // quit
    con.move(yp + 27, xp + 3)
    con.color_pair(labCol(8), 255); con.prnch(0x58)
    con.move(yp + 28, xp)
    print(` \x1B[38;5;${actCol(8)}mQ\x1B[38;5;${labCol(8)}muit`)

    con.color_pair(COL_TEXT, 255)
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// More-op menu (the navigator's More hook). Vertical-list popup; selection runs
// execute / edit / open-terminal-here for the highlighted file.
///////////////////////////////////////////////////////////////////////////////////////////////////

// Vertical-list popup: items are stacked rows, navigable with arrow keys /
// mouse, selection (Enter / left-click on row) returns that item's action.
// A single Close button sits below the list; Esc and Close both yield 'close'.
// Thin wrapper over win.showDialog — see wintex.mjs for the underlying schema.
function showActionListPopup(opts) {
    const items = opts.items || []
    const closeLabel = opts.closeLabel || 'Close'
    const defaultIdx = items.findIndex(it => it.default)

    const res = win.showDialog({
        title: opts.title || '',
        message: opts.message,
        list: {
            items: items,
            height: items.length,
            cursor: defaultIdx >= 0 ? defaultIdx : 0,
            showScrollbar: false,
            onActivate: (item) => item.action,
        },
        buttons: [{ label: closeLabel, action: 'close' }],
    })

    if (res.action === 'cancel') return { action: 'close' }
    return { action: res.action }
}

function onMore(cache, nav) {
    const items = cache.isDirectory
        ? [
            { label: 'Open terminal here', action: 'terminal', default: true },
        ]
        : [
            { label: 'Execute',            action: 'execute', default: true },
            { label: 'Edit',               action: 'edit' },
            { label: 'Open terminal here', action: 'terminal' },
        ]

    const res = showActionListPopup({
        title: 'More',
        message: cache.file.name,
        items: items,
    })
    _redraw()

    if (res.action === 'execute') {
        nav.activate()
        return
    }
    if (res.action === 'edit') {
        const editfun = EDIT_FUNS[cache.fileext]
            || ((f) => _G.shell.execute(`${DEFAULT_EDITOR} "${f}"`))
        nav.runChild(() => editfun(cache.file.fullPath))
        return
    }
    if (res.action === 'terminal') {
        onTerminal(cache, nav)
    }
}

function onTerminal(cache, nav) {
    const targetDir = (cache && cache.isDirectory && cache.file)
        ? cache.file.fullPath
        : nav.getCurrentDirStr(nav.windowMode)
    if (!targetDir || targetDir.length === 0) return

    // TVDOS shell.parse has no working escape inside quotes (the `^` ESCAPE
    // state is a TODO), so we can't pass a quoted path through `command -k
    // "cd \"X\""`. The outer quotes carry the whole `cd <path>` as one token;
    // shell.execute then re-parses it. This works for paths without spaces;
    // paths with spaces will only cd to the first component.
    nav.runChild(() => _G.shell.execute(`command -k "cd ${targetDir}"`))
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// Navigator instance. zfm enables the full editing surface: quit, switch panel,
// more, and the file-mutation operations (copy/move/delete/mkdir/rename). "Go
// up" is the navigator's native function and needs no hook.
///////////////////////////////////////////////////////////////////////////////////////////////////

const nav = filenav.create({
    C: {
        LIST_HEIGHT, FILELIST_WIDTH, FILESIZE_WIDTH, POPUP_WIDTH,
        COL_TEXT, COL_BACK, COL_BACK_SEL, COL_HLTEXT, COL_DIMTEXT, COL_HL_EXT,
    },
    execFuns: EXEC_FUNS,
    win: win,
    initialPaths: [["A:", "home"], ["A:"]],
    addMouseRegion: addPanelMouseRegion,
    requestRedraw: redraw,
    redrawNow: _redraw,
    drawActivePanel: drawFilePanel,
    clearScr: clearScr,
    onChildExit: () => { firstRunLatch = true; pendingPostExecDrain = true },
    hooks: {
        onQuit:        () => { exit = true },
        onSwitchPanel: () => { nav.setWindowMode(1 - nav.windowMode); redraw() },
        onMore:        onMore,
        fs:            true,
    },
})

///////////////////////////////////////////////////////////////////////////////////////////////////

const windows = [
    new win.WindowObject(1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, nav.filenavOninput, nav.filesPanelDraw), // left panel
    new win.WindowObject(WIDTH - SIDEBAR_WIDTH+1, 2, SIDEBAR_WIDTH, HEIGHT, ()=>{}, opPanelDraw),
    new win.WindowObject(SIDEBAR_WIDTH + 1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, nav.filenavOninput, nav.filesPanelDraw), // right panel
]

const LEFTPANEL = windows[0]
const OPPANEL = windows[1]
const RIGHTPANEL = windows[2]

function drawTitle() {
    // draw window title
    con.color_pair(COL_BACK, COL_TEXT)
    con.move(1,1)
    print(' '.repeat(WIDTH))
    con.move(1, WIDTH/2 - 2)
    con.color_pair(COL_BRAND_PAL[0], COL_TEXT)
    print("z")
    con.color_pair(COL_BRAND_PAL[1], COL_TEXT)
    con.prnch(0xB3)
    con.color_pair(COL_BRAND, COL_TEXT)
    print("fm")
}


function drawFilePanel() {
    windows.forEach((panel, i) => {
        panel.isHighlighted = (i == 2 * nav.windowMode)
    })
    if (nav.windowMode) {
        RIGHTPANEL.drawContents()
        RIGHTPANEL.drawFrame()
    }
    else {
        LEFTPANEL.drawContents()
        LEFTPANEL.drawFrame()
    }
}

function drawOpPanel() {
    if (nav.windowMode)
        OPPANEL.x = 1
    else
        OPPANEL.x = WIDTH - SIDEBAR_WIDTH+1

    OPPANEL.drawContents()
    OPPANEL.drawFrame()
}

function redraw() {
    redrawRequested = true
}

function _redraw() {
    clearScr()
    drawTitle()
    drawFilePanel()
    drawOpPanel()
    setupPanelMouseRegions()
}

function clearScr() {
    con.clear()
    graphics.setBackground(34,51,68)
    graphics.clearPixels(255)
    graphics.setGraphicsMode(0)
    con.color_pair(COL_TEXT, COL_BACK)
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// Mouse region setup (file list comes from the navigator; op buttons stay here)
///////////////////////////////////////////////////////////////////////////////////////////////////

function setupPanelMouseRegions() {
    clearPanelMouseRegions()

    const fp = (nav.windowMode === 0) ? LEFTPANEL : RIGHTPANEL
    nav.setupMouseRegions(fp)

    // Op-panel button hover/click. Each button covers its icon row + label row.
    const opX = OPPANEL.x + 1
    const opW = SIDEBAR_WIDTH - 2
    for (let i = 0; i < OP_BUTTONS.length; i++) {
        const idx = i
        const btn = OP_BUTTONS[i]
        if (!nav.isEnabled(btn.id)) continue // disabled buttons get no hover/click
        addPanelMouseRegion(opX, OPPANEL.y + 1 + btn.yOff, opW, btn.hitH || 2, {
            onHover: () => {
                if (opHover !== idx) { opHover = idx; drawOpPanel() }
            },
            onHoverLeave: () => {
                if (opHover === idx) { opHover = -1; drawOpPanel() }
            },
            onClick: (cy, cx, btnNum) => {
                if (btnNum !== 1) return
                nav.invokeAction(btn.id)
            }
        })
    }
}

///////////////////////////////////////////////////////////////////////////////////////////////////

con.curs_set(0)
nav.refreshFilePanelCache(0)
nav.refreshFilePanelCache(1)
_redraw()

// Drain inherited mouse/key state from whoever launched us. Polling launchers
// like fsh.js can hand off with the mouse button still held; without this,
// input.withEvent's first call edge-detects that as a fresh mouse_down at the
// cursor and activates whichever file row happens to sit there.
//
// The same problem reappears after every child app returns, but draining
// inside the dispatcher callback is undone by TVDOS.SYS:1235 (input.withEvent
// unconditionally writes inputwork.oldMouse = its-stale-local-snapshot at the
// end of the outer call). So the navigator's runChild sets pendingPostExecDrain
// and the main loop calls drainInheritedInput() AFTER input.withEvent returns.
function drainInheritedInput() { input.withEvent(() => {}) }
drainInheritedInput()

while (!exit) {
    // Fullscreen app: (re)assert the raw-keyboard grab each frame so cooked chars
    // never pile into this pane's ring (they'd flood the shell on exit), and so
    // it is re-established after a launched program returns. input.withEvent
    // below is auto-guarded by con.isActiveConsole(); both are no-ops on bare
    // metal. Released after the loop.
    con.setFullscreen(true)
    input.withEvent(event => {

        if (dispatchMouseEvent(event)) {
            if (redrawRequested) {
                redrawRequested = false
                _redraw()
            }
            return
        }

        let keysym = event[1]
        let keyJustHit = (1 == event[2])

        if (keyJustHit && event[3] != keys.ENTER && keysym != "q") { // release the latch right away if the key is neither Return nor 'q'
            firstRunLatch = false
        }

        if (keyJustHit && firstRunLatch) { // filter out the initial ENTER/'q' key as they would cause unwanted behaviours
            firstRunLatch = false
        }
        else {
            windows.forEach(it => {
                if (it.isHighlighted) { // double input processing without this? wtf?!
                    it.processInput(event)
                }
            })
        }

        if (redrawRequested) {
            redrawRequested = false
            _redraw()
        }
    })

    // Re-baseline mouse state AFTER input.withEvent returns so its trailing
    // `inputwork.oldMouse = mouse` (TVDOS.SYS:1235) doesn't overwrite the
    // freshly-correct state with the stale snapshot taken at the start of the
    // outer call. Without this, a child app exited by a click leaves zfm with
    // oldBtns=0 while the user is still holding → spurious mouse_down next poll.
    if (pendingPostExecDrain) {
        pendingPostExecDrain = false
        drainInheritedInput()
    }
}

con.setFullscreen(false)
con.curs_set(1)
con.clear()
return 0
