const win = require("wintex")
const keys = require("keysym")

const COL_TEXT = 253
const COL_BACK = 255
const COL_BACK_SEL = 81
const COL_HLTEXT = 230
const COL_HLACTION = 39
const COL_DIR = COL_TEXT
const COL_SUPERTEXT = 239
const COL_DIMTEXT = 249
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
    "mv1": (f) => _G.shell.execute(`playmv1 "${f}" -i`),
    "mv2": (f) => _G.shell.execute(`playtev "${f}" -i`),
    "mv3": (f) => _G.shell.execute(`playtav "${f}" -i`),
    "tav": (f) => _G.shell.execute(`playtav "${f}" -i`),
    "im3": (f) => _G.shell.execute(`playtav "${f}" -i`),
    "tap": (f) => _G.shell.execute(`playtav "${f}" -i`),
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

let windowMode = 0 // 0 == left, 1 == right

// window states
let path = [["A:", "home"], ["A:"]]
let scroll = [0, 0]
let dirFileList = [[], []]
let cursor = [0, 0] // absolute position!
// end of window states


function bytesToReadable(i) {
    return ''+ (
       (i > 999999999999) ? (((i / 10000000000)|0)/100 + "T") :
       (i > 999999999) ? (((i / 10000000)|0)/100 + "G") :
       (i > 999999) ? (((i / 10000)|0)/100 + "M") :
       (i > 9999) ? (((i / 100)|0)/10 + "K") :
       i
   )
}

let filePanelCache = [[], []]

function refreshFilePanelCache(side) {
    let pathStr = path[side].concat(['']).join("\\").replaceAll('\\\\', '\\')
    const showDrives = (pathStr.length == 0)



    filePanelCache[side] = []

    let ds = []
    let fs = []

    //serial.println(`pathStr=${pathStr}`)
    if (!showDrives) {
        let letter = pathStr[0]
        let serialPath = pathStr.substring(3)
        // remove trailing slashes
        while (serialPath.endsWith("\\")) {
            serialPath = serialPath.substring(0, serialPath.length - 1)
        }

        let port = _TVDOS.DRV.FS.SERIAL._toPorts(letter)
        com.sendMessage(port[0], "DEVRST\x17")
        com.sendMessage(port[0], "OPENR"+'"'+serialPath+'",'+port[1])
        //serial.println("OPENR"+'"'+serialPath+'",'+port[1])
        com.sendMessage(port[0], "LISTFILES")
        let response = com.getStatusCode(port[0])
        let rawStr = com.pullMessage(port[0]) // {\x11 | \x12} <name> [ \x1E {\x11 | \x12} <name> ] \x17

        //serial.println(`rawStr=${rawStr}`)


        rawStr.substring(0, rawStr.length).split('\x1E').forEach((s) => {
            let fname = undefined
            if (s[0] == '\x11') {
                fname = s.substr(1)
                //serial.println(`fname=(dir)${fname}`)
                ds.push(files.open(`${pathStr}${fname}`))
            }
            else if (s[0] == '\x12') {
                fname = s.substr(1)
                //serial.println(`fname=(file)${fname}`)
                fs.push(files.open(`${pathStr}${fname}`))
            }
        })
    }
    else {
        Object.entries(_TVDOS.DRIVES).map(it=>{
            let [letter, [port, drivenum]] = it
            let dinfo = _TVDOS.DRIVEINFO[letter]

            if (dinfo.type == "STOR") {
                let file = files.open(`${letter}:\\`)
                ds.push(file)
                //serial.println(`fileList ${file.fullPath}`)
            }
        })
    }

    ds.sort((a,b) => (a.name > b.name) ? 1 : (a.name < b.name) ? -1 : 0)
    fs.sort((a,b) => (a.name > b.name) ? 1 : (a.name < b.name) ? -1 : 0)
    dirFileList[side] = ds.concat(fs)

    let filesCount = dirFileList[side].length

    for (let i = 0; i < filesCount; i++) {
        let isDirectory = (i < ds.length)
        let file = dirFileList[side][i]
        let sizestr;
        if (!showDrives) {
            sizestr = (file) ? bytesToReadable(file.size) : ''  // FIXME file.size creates disk access
        }
        else if (file) {
            let port = _TVDOS.DRIVES[file.driveLetter]
            _TVDOS.DRV.FS.SERIAL._flush(port[0]);_TVDOS.DRV.FS.SERIAL._close(port[0])
            com.sendMessage(port[0], "USAGE")
            let response = com.getStatusCode(port[0])
            if (0 == response) {
                let rawStr = com.fetchResponse(port[0]).split('/') // USED1234/TOTAL23412341
                let usedBytes = (rawStr[0].substring(4))|0
                let totalBytes = (rawStr[1].substring(5))|0
                sizestr = bytesToReadable(usedBytes)
            }
            else {
                sizestr = ''
            }
        }
        else {
            sizestr = ''
        }
        let filename = (showDrives && file) ? file.fullPath : (file) ? file.name : ''
        let fileext = filename.substring(filename.lastIndexOf(".") + 1).toLowerCase()

        filePanelCache[side].push({
            file: file,
            isDirectory: isDirectory,
            sizestr: sizestr,
            filename: filename,
            fileext: fileext
        })
    }
}

let filesPanelDraw = (wo) => {
    let usedBytes = undefined
    let totalBytes = undefined
    let freeBytes = undefined
    let pathStr = path[windowMode].concat(['']).join("\\").replaceAll('\\\\', '\\')

    //serial.println(`pathStr=${pathStr}`)

    let port = _TVDOS.DRIVES[pathStr[0]]

    const showDrives = (pathStr.length == 0)

    if (!showDrives) {
        _TVDOS.DRV.FS.SERIAL._flush(port[0]);_TVDOS.DRV.FS.SERIAL._close(port[0])
        com.sendMessage(port[0], "USAGE")
        let response = com.getStatusCode(port[0])
        if (0 == response) {
            let rawStr = com.fetchResponse(port[0]).split('/') // USED1234/TOTAL23412341
            usedBytes = (rawStr[0].substring(4))|0
            totalBytes = (rawStr[1].substring(5))|0
            freeBytes = totalBytes - usedBytes
        }
    }

    let diskSizestr = (isNaN(freeBytes / totalBytes)) ? undefined : bytesToReadable(usedBytes)+"/"+bytesToReadable(totalBytes)

    wo.titleLeft = (showDrives) ? "(drives)" : pathStr
    wo.titleRight = diskSizestr


    // draw list header
    con.color_pair(COL_HLTEXT, COL_BACK)
    con.move(wo.y + 1, wo.x + 1); print(" Name")
    con.mvaddch(wo.y + 1, wo.x + FILELIST_WIDTH, 0xB3)
    con.curs_right(); print(" Size")


    con.color_pair(COL_TEXT, COL_BACK)

    let s = scroll[windowMode]
    let filesCount = dirFileList[windowMode].length

    // print entries
    for (let i = 0; i < LIST_HEIGHT; i++) {
        let listObj = filePanelCache[windowMode][i+s]
        if (listObj) {
            let file = listObj.file
            let isDirectory = listObj.isDirectory
            let sizestr = listObj.sizestr
            let filename = listObj.filename//(showDrives && file) ? file.fullPath : (file) ? file.name : ''
            let fileext = listObj.fileext

            // set bg colour
            let backCol = (i == cursor[windowMode] - s) ? COL_BACK_SEL : COL_BACK
            // set fg colour (if there are more at the top/bottom, dim the colour)
            let foreCol = (i == 0 && s > 0 || i == LIST_HEIGHT - 1 && i + s < filesCount - 1) ? COL_DIMTEXT : (COL_HL_EXT[fileext] || COL_TEXT)

            // print filename
            con.color_pair(foreCol, backCol)
            con.move(wo.y + 2+i, wo.x + 1)
            print(((file && isDirectory && !showDrives) ? '\\' : ' ') + filename)
            print(' '.repeat(FILELIST_WIDTH - 2 - filename.length))

            // print |
            con.color_pair(COL_TEXT, backCol)
            con.mvaddch(wo.y + 2+i, wo.x + FILELIST_WIDTH, 0xB3)

            // print filesize
            con.color_pair(foreCol, backCol)
            con.move(wo.y + 2+i, wo.x + FILELIST_WIDTH + 1)
            if (file && isDirectory && !showDrives) {
                print(' '.repeat(FILESIZE_WIDTH - sizestr.length))
                print(sizestr); con.prnch(0x7F)
            }
            else {
                print(' '.repeat(FILESIZE_WIDTH - sizestr.length + 1))
                print(sizestr)
            }
        }
        else {
            // set bg colour
            let backCol = (i == cursor[windowMode] - s) ? COL_BACK_SEL : COL_BACK
            // set fg colour (if there are more at the top/bottom, dim the colour)
            let foreCol = COL_TEXT

            // print empty filename
            con.color_pair(foreCol, backCol)
            con.move(wo.y + 2+i, wo.x + 1)
            print(' '.repeat(FILELIST_WIDTH - 1))

            // print |
            con.color_pair(COL_TEXT, backCol)
            con.mvaddch(wo.y + 2+i, wo.x + FILELIST_WIDTH, 0xB3)

            // print empty filesize
            con.color_pair(foreCol, backCol)
            con.move(wo.y + 2+i, wo.x + FILELIST_WIDTH + 1)
            print(' '.repeat(FILESIZE_WIDTH + 1))
        }
    }

    con.color_pair(COL_TEXT, COL_BACK)

}
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
    function labCol(i) { return (opHover === i) ? COL_HLTEXT : COL_TEXT }

    con.color_pair(COL_TEXT, COL_BACK)

    let xp = wo.x + 1
    let yp = wo.y + 1

    // other panel
    con.move(yp + 2, xp + 3)
    con.color_pair(labCol(0), 255); con.prnch((windowMode) ? 0x11 : 0x10)
    con.move(yp + 3, xp)
    print(`  \x1B[38;5;${labCol(0)}m[\x1B[38;5;${COL_HLACTION}mZ\x1B[38;5;${labCol(0)}m]`)

    hr(0, yp+5)

    // go up
    con.color_pair(labCol(1), 255); con.mvaddch(yp + 6, xp + 3, 0x18)
    con.move(yp + 7, xp)
    print(` \x1B[38;5;${labCol(1)}mGo \x1B[38;5;${COL_HLACTION}mU\x1B[38;5;${labCol(1)}mp`)

    hr(1, yp+8)

    // copy
    con.move(yp + 9, xp + 2)
    con.color_pair(labCol(2), 255); con.prnch(0xDB);con.prnch((windowMode) ? 0x1B : 0x1A);con.prnch(0xDB)
    con.move(yp + 10, xp)
    print(` \x1B[38;5;${COL_HLACTION}mC\x1B[38;5;${labCol(2)}mopy`)

    hr(2, yp+11)

    // move
    con.move(yp + 12, xp + 2)
    con.color_pair(labCol(3), 255); if (windowMode) con.prnch([0xDB, 0x1B, 0xB0]); else con.prnch([0xB0, 0x1A, 0xDB])
    con.move(yp + 13, xp)
    print(` \x1B[38;5;${labCol(3)}mMo\x1B[38;5;${COL_HLACTION}mv\x1B[38;5;${labCol(3)}me`)

    hr(3, yp+14)

    // delete
    con.move(yp + 15, xp + 2)
    con.color_pair(labCol(4), 255); if (windowMode) con.prnch([0xDB, 0x1A, 0xF9]); else con.prnch([0xF9, 0x1B, 0xDB])
    con.move(yp + 16, xp)
    print(` \x1B[38;5;${COL_HLACTION}mD\x1B[38;5;${labCol(4)}melete`)

    hr(4, yp+17)

    // mkdir
    con.move(yp + 18, xp + 2)
    con.color_pair(labCol(5), 255);
    con.prnch(0xDB)
    con.video_reverse();con.prnch(0x2B);con.video_reverse()
    con.prnch(0xDF)
    con.move(yp + 19, xp)
    print(` \x1B[38;5;${labCol(5)}mM\x1B[38;5;${COL_HLACTION}mk\x1B[38;5;${labCol(5)}mDir`)

    hr(5, yp+20)

    // rename
    con.move(yp + 21, xp + 2)
    con.color_pair(labCol(6), 255); con.prnch(0x4E);con.prnch(0x1A);con.prnch(0x52)
    con.move(yp + 22, xp)
    print(` \x1B[38;5;${COL_HLACTION}mR\x1B[38;5;${labCol(6)}mename`)

    hr(6, yp+23)

    // the dreaded hamburger menu
    con.move(yp + 24, xp + 3)
    con.color_pair(labCol(7), 255); con.prnch(0xf0)
    con.move(yp + 25, xp)
    print(` \x1B[38;5;${COL_HLACTION}mM\x1B[38;5;${labCol(7)}more`)

    hr(7, yp+26)

    // quit
    con.move(yp + 27, xp + 3)
    con.color_pair(labCol(8), 255); con.prnch(0x58)
    con.move(yp + 28, xp)
    print(` \x1B[38;5;${COL_HLACTION}mQ\x1B[38;5;${labCol(8)}muit`)

    con.color_pair(COL_TEXT, 255)
}


let filenavOninput = (window, event) => {
    let eventName = event[0]
    if (eventName !== "key_down") return

    let keysym = event[1]
    let keyJustHit = (1 == event[2])
    let keycodes = [event[3],event[4],event[5],event[6],event[7],event[8],event[9],event[10]]
    let keycode = keycodes[0]

    let scrollPeek = (LIST_HEIGHT / 3)|0

    if      (keyJustHit && keysym == "q") actQuit()
    else if (keyJustHit && keysym == "z") actSwitchPanel()
    else if (keyJustHit && keysym == 'u') actGoUp()
    else if (keyJustHit && keysym == 'c') actCopy()
    else if (keyJustHit && keysym == 'v') actMove()
    else if (keyJustHit && keysym == 'd') actDelete()
    else if (keyJustHit && keysym == 'k') actMkdir()
    else if (keyJustHit && keysym == 'r') actRename()
    else if (keyJustHit && keysym == 'm') actMore()
    else if (keysym == "<UP>") {
        [cursor[windowMode], scroll[windowMode]] = win.scrollVert(-1, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], scrollPeek)
        drawFilePanel()
    }
    else if (keysym == "<DOWN>") {
        [cursor[windowMode], scroll[windowMode]] = win.scrollVert(+1, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], scrollPeek)
        drawFilePanel()
    }
    else if (keysym == "<PAGE_UP>") {
        [cursor[windowMode], scroll[windowMode]] = win.scrollVert(-LIST_HEIGHT, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], scrollPeek)
        drawFilePanel()
    }
    else if (keysym == "<PAGE_DOWN>") {
        [cursor[windowMode], scroll[windowMode]] = win.scrollVert(+LIST_HEIGHT, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], scrollPeek)
        drawFilePanel()
    }
    else if (keyJustHit && keycode == 66) { // enter
        actActivate()
    }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// Popup wrappers (delegate to win.showDialog in wintex.mjs)
///////////////////////////////////////////////////////////////////////////////////////////////////

function showConfirmPopup(title, message) {
    const res = win.showDialog({
        title: title,
        message: message,
        fields: [],
        buttons: [
            { label: 'OK',     action: 'ok', default: true },
            { label: 'CANCEL', action: 'cancel' },
        ],
    })
    return res.action === 'ok'
}

function showInputPopup(title, prompt, defaultVal) {
    const res = win.showDialog({
        title: title,
        fields: [{ label: prompt, initial: defaultVal || '', width: POPUP_WIDTH - 6 }],
        buttons: [
            { label: 'OK',     action: 'ok', default: true },
            { label: 'CANCEL', action: 'cancel' },
        ],
    })
    return res.action === 'ok' ? res.values[0] : null
}

function showMessagePopup(title, message) {
    win.showDialog({
        title: title,
        message: message,
        fields: [],
        buttons: [{ label: 'OK', action: 'ok', default: true }],
    })
}

///////////////////////////////////////////////////////////////////////////////////////////////////

const windows = [
    new win.WindowObject(1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, filenavOninput, filesPanelDraw), // left panel
    new win.WindowObject(WIDTH - SIDEBAR_WIDTH+1, 2, SIDEBAR_WIDTH, HEIGHT, ()=>{}, opPanelDraw),
    new win.WindowObject(SIDEBAR_WIDTH + 1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, filenavOninput, filesPanelDraw), // right panel
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
        panel.isHighlighted = (i == 2 * windowMode)
    })
    if (windowMode) {
        RIGHTPANEL.drawContents()
        RIGHTPANEL.drawFrame()
    }
    else {
        LEFTPANEL.drawContents()
        LEFTPANEL.drawFrame()
    }
}

function drawOpPanel() {
    if (windowMode)
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
// File operations and op-panel actions
///////////////////////////////////////////////////////////////////////////////////////////////////

function getCurrentDirStr(side) {
    return path[side].concat(['']).join("\\").replaceAll('\\\\', '\\')
}

function clampCursorAfterChange() {
    const len = dirFileList[windowMode].length
    if (cursor[windowMode] >= len) cursor[windowMode] = Math.max(0, len - 1)
    const maxScroll = Math.max(0, len - LIST_HEIGHT)
    if (scroll[windowMode] > maxScroll) scroll[windowMode] = maxScroll
    if (scroll[windowMode] < 0) scroll[windowMode] = 0
}

function actSwitchPanel() {
    windowMode = 1 - windowMode
    redraw()
}

function actGoUp() {
    if (path[windowMode].length >= 1) {
        path[windowMode].pop()
        cursor[windowMode] = 0; scroll[windowMode] = 0
        refreshFilePanelCache(windowMode)
        _redraw()
    }
}

function actActivate() {
    let selectedFileCache = filePanelCache[windowMode][cursor[windowMode]]
    if (!selectedFileCache || !selectedFileCache.file) return
    let selectedFile = selectedFileCache.file

    if (selectedFile.fullPath[1] == ":" && selectedFile.fullPath[2] == "\\" && selectedFile.fullPath.length == 3) {
        path[windowMode].push(selectedFile.fullPath)
        cursor[windowMode] = 0; scroll[windowMode] = 0
        refreshFilePanelCache(windowMode)
        _redraw()
    }
    else if (selectedFileCache.isDirectory) {
        path[windowMode].push(selectedFileCache.filename)
        cursor[windowMode] = 0; scroll[windowMode] = 0
        refreshFilePanelCache(windowMode)
        _redraw()
    }
    else {
        let fileext = selectedFileCache.filename.substring(selectedFileCache.filename.lastIndexOf(".") + 1).toLowerCase()
        let execfun = EXEC_FUNS[fileext] || ((f) => _G.shell.execute(f))
        let errorlevel = 0

        con.curs_set(1); clearScr(); con.move(1,1)
        try {
            errorlevel = execfun(selectedFile.fullPath)
        }
        catch (e) {
            println(e)
            errorlevel = 1
        }

        if (errorlevel) {
            println("Hit Return/Enter key to continue . . . .")
            sys.read()
        }

        firstRunLatch = true
        con.curs_set(0); clearScr()
        refreshFilePanelCache(windowMode)
        pendingPostExecDrain = true
        redraw()
    }
}

function actCopy() {
    if (path[windowMode].length === 0) return
    const cache = filePanelCache[windowMode][cursor[windowMode]]
    if (!cache || !cache.file) return
    if (cache.isDirectory) { showMessagePopup('Copy', 'Directory copy is not supported.'); _redraw(); return }
    if (path[1 - windowMode].length === 0) { showMessagePopup('Copy', 'Cannot copy to drive list view.'); _redraw(); return }

    const srcPath = cache.file.fullPath
    const dstDir = getCurrentDirStr(1 - windowMode)
    const dstPath = dstDir + cache.file.name
    if (srcPath === dstPath) { _redraw(); return } // both panels point to same directory

    try {
        const srcFile = files.open(srcPath)
        const dstFile = files.open(dstPath)
        if (!srcFile.exists) { showMessagePopup('Copy', 'Source not found.'); _redraw(); return }
        if (dstFile.exists) {
            if (!showConfirmPopup('Copy', `Overwrite "${cache.file.name}"?`)) { _redraw(); return }
        }
        if (!dstFile.exists) dstFile.mkFile()
        dstFile.bwrite(srcFile.bread())
        try { dstFile.flush() } catch (e) {}
        try { dstFile.close() } catch (e) {}
        try { srcFile.close() } catch (e) {}
        refreshFilePanelCache(1 - windowMode)
    }
    catch (e) {
        showMessagePopup('Copy failed', e.message || ('' + e))
    }
    _redraw()
}

function actMove() {
    if (path[windowMode].length === 0) return
    const cache = filePanelCache[windowMode][cursor[windowMode]]
    if (!cache || !cache.file) return
    if (cache.isDirectory) { showMessagePopup('Move', 'Directory move is not supported.'); _redraw(); return }
    if (path[1 - windowMode].length === 0) { showMessagePopup('Move', 'Cannot move to drive list view.'); _redraw(); return }

    const srcPath = cache.file.fullPath
    const dstDir = getCurrentDirStr(1 - windowMode)
    const dstPath = dstDir + cache.file.name
    if (srcPath === dstPath) { _redraw(); return } // no-op

    try {
        const srcFile = files.open(srcPath)
        const dstFile = files.open(dstPath)
        if (!srcFile.exists) { showMessagePopup('Move', 'Source not found.'); _redraw(); return }
        if (dstFile.exists) {
            if (!showConfirmPopup('Move', `Overwrite "${cache.file.name}"?`)) { _redraw(); return }
        }
        if (!dstFile.exists) dstFile.mkFile()
        dstFile.bwrite(srcFile.bread())
        try { dstFile.flush() } catch (e) {}
        try { dstFile.close() } catch (e) {}
        srcFile.remove()
        refreshFilePanelCache(windowMode)
        refreshFilePanelCache(1 - windowMode)
        clampCursorAfterChange()
    }
    catch (e) {
        showMessagePopup('Move failed', e.message || ('' + e))
    }
    _redraw()
}

function actDelete() {
    if (path[windowMode].length === 0) return
    const cache = filePanelCache[windowMode][cursor[windowMode]]
    if (!cache || !cache.file) return

    const name = cache.file.name
    const kind = cache.isDirectory ? 'directory' : 'file'
    if (!showConfirmPopup('Delete', `Delete ${kind} "${name}"?`)) { _redraw(); return }

    try {
        const status = cache.file.remove()
        if (status !== undefined && status !== 0 && status !== true) {
            showMessagePopup('Delete failed', `Cannot delete "${name}" (status ${status}).`)
        }
        refreshFilePanelCache(windowMode)
        clampCursorAfterChange()
    }
    catch (e) {
        showMessagePopup('Delete failed', e.message || ('' + e))
    }
    _redraw()
}

function actMkdir() {
    if (path[windowMode].length === 0) { showMessagePopup('Mkdir', 'Choose a directory first.'); _redraw(); return }
    const name = showInputPopup('Make Directory', 'Directory name:', '')
    if (name === null || name.length === 0) { _redraw(); return }

    const dstPath = getCurrentDirStr(windowMode) + name
    try {
        const dstFile = files.open(dstPath)
        if (dstFile.exists) {
            showMessagePopup('Mkdir', `"${name}" already exists.`)
        }
        else {
            const ok = dstFile.mkDir()
            if (!ok) showMessagePopup('Mkdir failed', `Cannot create "${name}".`)
            else refreshFilePanelCache(windowMode)
        }
    }
    catch (e) {
        showMessagePopup('Mkdir failed', e.message || ('' + e))
    }
    _redraw()
}

function actRename() {
    if (path[windowMode].length === 0) return
    const cache = filePanelCache[windowMode][cursor[windowMode]]
    if (!cache || !cache.file) return
    if (cache.isDirectory) { showMessagePopup('Rename', 'Directory rename is not supported.'); _redraw(); return }

    const oldName = cache.file.name
    const newName = showInputPopup('Rename', 'New name:', oldName)
    if (newName === null || newName.length === 0 || newName === oldName) { _redraw(); return }

    const dirStr = getCurrentDirStr(windowMode)
    const srcPath = cache.file.fullPath
    const dstPath = dirStr + newName

    try {
        const srcFile = files.open(srcPath)
        const dstFile = files.open(dstPath)
        if (dstFile.exists) {
            if (!showConfirmPopup('Rename', `Overwrite "${newName}"?`)) { _redraw(); return }
        }
        if (!dstFile.exists) dstFile.mkFile()
        dstFile.bwrite(srcFile.bread())
        try { dstFile.flush() } catch (e) {}
        try { dstFile.close() } catch (e) {}
        srcFile.remove()
        refreshFilePanelCache(windowMode)
        clampCursorAfterChange()
    }
    catch (e) {
        showMessagePopup('Rename failed', e.message || ('' + e))
    }
    _redraw()
}

function actMore() {
    if (path[windowMode].length === 0) return
    const cache = filePanelCache[windowMode][cursor[windowMode]]
    if (!cache || !cache.file || cache.isDirectory) return

    const res = win.showDialog({
        title: 'More',
        message: cache.file.name,
        fields: [],
        buttons: [
            { label: 'Execute', action: 'execute', default: true },
            { label: 'Edit',    action: 'edit' },
            { label: 'Close',   action: 'close' },
        ],
    })
    _redraw()

    if (res.action === 'execute') {
        actActivate()
        return
    }
    if (res.action === 'edit') {
        const editfun = EDIT_FUNS[cache.fileext]
            || ((f) => _G.shell.execute(`${DEFAULT_EDITOR} "${f}"`))
        let errorlevel = 0
        con.curs_set(1); clearScr(); con.move(1, 1)
        try {
            errorlevel = editfun(cache.file.fullPath)
        }
        catch (e) {
            println(e)
            errorlevel = 1
        }
        if (errorlevel) {
            println("Hit Return/Enter key to continue . . . .")
            sys.read()
        }
        firstRunLatch = true
        con.curs_set(0); clearScr()
        refreshFilePanelCache(windowMode)
        pendingPostExecDrain = true
        redraw()
    }
}
function actQuit() { exit = true }

function invokeOpAction(id) {
    if      (id === 'switch') actSwitchPanel()
    else if (id === 'up')     actGoUp()
    else if (id === 'copy')   actCopy()
    else if (id === 'move')   actMove()
    else if (id === 'delete') actDelete()
    else if (id === 'mkdir')  actMkdir()
    else if (id === 'rename') actRename()
    else if (id === 'more')   actMore()
    else if (id === 'quit')   actQuit()
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// Mouse region setup (file list + op buttons)
///////////////////////////////////////////////////////////////////////////////////////////////////

function setupPanelMouseRegions() {
    clearPanelMouseRegions()

    const fp = (windowMode === 0) ? LEFTPANEL : RIGHTPANEL
    const fpX = fp.x + 1
    const fpW = fp.width - 2
    const fpY = fp.y + 2  // first file row (after frame top + header)

    // Wheel-scroll over the file list. Wheel and keyboard are the only inputs allowed
    // to move the scroll position; hover (below) only moves the caret.
    addPanelMouseRegion(fpX, fpY, fpW, LIST_HEIGHT, {
        onWheel: (cy, cx, dy) => {
            const filesCount = dirFileList[windowMode].length
            const maxScroll = Math.max(0, filesCount - LIST_HEIGHT)
            let s = scroll[windowMode] + dy * 3
            if (s > maxScroll) s = maxScroll
            if (s < 0) s = 0
            if (s !== scroll[windowMode]) {
                scroll[windowMode] = s
                drawFilePanel()
            }
        }
    })

    // One hover/click region per row so the caret can follow the mouse without
    // calling scrollVert (which would re-scroll the list near the upper/lower thirds).
    for (let i = 0; i < LIST_HEIGHT; i++) {
        const rowIdx = i
        addPanelMouseRegion(fpX, fpY + i, fpW, 1, {
            onHover: () => {
                const target = scroll[windowMode] + rowIdx
                if (target < dirFileList[windowMode].length && cursor[windowMode] !== target) {
                    cursor[windowMode] = target
                    drawFilePanel()
                }
            },
            onClick: (cy, cx, btn) => {
                const target = scroll[windowMode] + rowIdx
                if (target >= dirFileList[windowMode].length) return
                if (btn === 1) {
                    cursor[windowMode] = target
                    actActivate()
                }
                else if (btn === 2) {
                    cursor[windowMode] = target
                    drawFilePanel()
                    actMore()
                }
            }
        })
    }

    // Op-panel button hover/click. Each button covers its icon row + label row.
    const opX = OPPANEL.x + 1
    const opW = SIDEBAR_WIDTH - 2
    for (let i = 0; i < OP_BUTTONS.length; i++) {
        const idx = i
        const btn = OP_BUTTONS[i]
        addPanelMouseRegion(opX, OPPANEL.y + 1 + btn.yOff, opW, btn.hitH || 2, {
            onHover: () => {
                if (opHover !== idx) { opHover = idx; drawOpPanel() }
            },
            onHoverLeave: () => {
                if (opHover === idx) { opHover = -1; drawOpPanel() }
            },
            onClick: (cy, cx, btnNum) => {
                if (btnNum !== 1) return
                invokeOpAction(btn.id)
            }
        })
    }
}

///////////////////////////////////////////////////////////////////////////////////////////////////

con.curs_set(0)
refreshFilePanelCache(0)
refreshFilePanelCache(1)
_redraw()

// Drain inherited mouse/key state from whoever launched us. Polling launchers
// like fsh.js can hand off with the mouse button still held; without this,
// input.withEvent's first call edge-detects that as a fresh mouse_down at the
// cursor and activates whichever file row happens to sit there.
//
// The same problem reappears after every child app returns, but draining
// inside the dispatcher callback is undone by TVDOS.SYS:1235 (input.withEvent
// unconditionally writes inputwork.oldMouse = its-stale-local-snapshot at the
// end of the outer call). So actActivate / actMore set pendingPostExecDrain
// and the main loop calls drainInheritedInput() AFTER input.withEvent returns.
function drainInheritedInput() { input.withEvent(() => {}) }
drainInheritedInput()

let redrawRequested = false
let exit = false
let firstRunLatch = true
let pendingPostExecDrain = false

while (!exit) {
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

con.curs_set(1)
con.clear()
return 0