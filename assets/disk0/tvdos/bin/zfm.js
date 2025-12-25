const win = require("wintex")
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
const POPUP_HEIGHT = 16

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
    "log": 223
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
    "log": (f) => _G.shell.execute(`less "${f}"`)
}

let windowMode = 0 // 0 == left, 1 == right
let windowFocus = [0] // is a stack; 0: files window, 1: palette window, 2: popup window

// window states
let path = [["A:", "home"], ["A:"]]
let scroll = [0, 0]
let dirFileList = [[], []]
let cursor = [0, 0] // absolute position!
// end of window states


function bytesToReadable(i) {
    return ''+ (
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
let opPanelDraw = (wo) => {
    function hr(y) {
        con.move(y, xp)
        print(`\x84196u`.repeat(SIDEBAR_WIDTH - 2))
    }

    con.color_pair(COL_TEXT, COL_BACK)

    let xp = wo.x + 1
    let yp = wo.y + 1

    // other panel
    con.move(yp + 2, xp + 3)
    con.prnch((windowMode) ? 0x11 : 0x10)
    con.move(yp + 3, xp)
    print(`  \x1B[38;5;${COL_TEXT}m[\x1B[38;5;${COL_HLACTION}mZ\x1B[38;5;${COL_TEXT}m]`)

    hr(yp+5)

    // go up
    con.mvaddch(yp + 6, xp + 3, 0x18)
    con.move(yp + 7, xp)
    print(` \x1B[38;5;${COL_TEXT}mGo \x1B[38;5;${COL_HLACTION}mU\x1B[38;5;${COL_TEXT}mp`)

    hr(yp+8)

    // copy
    con.move(yp + 9, xp + 2)
    con.prnch(0xDB);con.prnch((windowMode) ? 0x1B : 0x1A);con.prnch(0xDB)
    con.move(yp + 10, xp)
    print(` \x1B[38;5;${COL_HLACTION}mC\x1B[38;5;${COL_TEXT}mopy`)

    hr(yp+11)

    // move
    con.move(yp + 12, xp + 2)
    if (windowMode) con.prnch([0xDB, 0x1B, 0xB0]); else con.prnch([0xB0, 0x1A, 0xDB])
    con.move(yp + 13, xp)
    print(` \x1B[38;5;${COL_TEXT}mMo\x1B[38;5;${COL_HLACTION}mv\x1B[38;5;${COL_TEXT}me`)

    hr(yp+14)

    // delete
    con.move(yp + 15, xp + 2)
    if (windowMode) con.prnch([0xDB, 0x1A, 0xF9]); else con.prnch([0xF9, 0x1B, 0xDB])
    con.move(yp + 16, xp)
    print(` \x1B[38;5;${COL_HLACTION}mD\x1B[38;5;${COL_TEXT}melete`)

    hr(yp+17)

    // mkdir
    con.move(yp + 18, xp + 2)
    con.prnch(0xDB)
    con.video_reverse();con.prnch(0x2B);con.video_reverse()
    con.prnch(0xDF)
    con.move(yp + 19, xp)
    print(` \x1B[38;5;${COL_TEXT}mM\x1B[38;5;${COL_HLACTION}mk\x1B[38;5;${COL_TEXT}mDir`)

    hr(yp+20)

    // rename
    con.move(yp + 21, xp + 2)
    con.prnch(0x4E);con.prnch(0x1A);con.prnch(0x52)
    con.move(yp + 22, xp)
    print(` \x1B[38;5;${COL_HLACTION}mR\x1B[38;5;${COL_TEXT}mename`)

    hr(yp+23)

    // the dreaded hamburger menu
    con.move(yp + 24, xp + 3)
    con.prnch(0xf0)
    con.move(yp + 25, xp)
    print(` \x1B[38;5;${COL_HLACTION}mM\x1B[38;5;${COL_TEXT}more`)

    hr(yp+26)

    // quit
    con.move(yp + 27, xp + 3)
    con.prnch(0x58)
    con.move(yp + 28, xp)
    print(` \x1B[38;5;${COL_HLACTION}mQ\x1B[38;5;${COL_TEXT}muit`)


}


let paletteDraw = (wo) => {
    function hr(y) {
        con.move(y, xp)
        print(`\x84196u`.repeat(POPUP_WIDTH - 2))
    }

    con.color_pair(COL_TEXT, COL_BACK)

    let xp = wo.x + 1
    let yp = wo.y + 1

    // erase first
    for (let y = 0; y <= POPUP_HEIGHT-2; y++) {
        con.move(yp + y, xp)
        print(" ".repeat(POPUP_WIDTH-2))
    }

    // finally draw something
    con.move(yp, xp)
    print("More commands (hit m to return):")
}


let popupDraw = (wo) => {

}

///////////////////////////////////////////////////////////////////////////////////////////////////

let filenavOninput = (window, event) => {

    let eventName = event[0]
    if (eventName == "key_down") {

    let keysym = event[1]
    let keyJustHit = (1 == event[2])
    let keycodes = [event[3],event[4],event[5],event[6],event[7],event[8],event[9],event[10]]
    let keycode = keycodes[0]

    if (keyJustHit && keysym == "q") {
        exit = true
    }
    else if (keyJustHit && keysym == "z") {
        windowMode = 1 - windowMode
        redraw() // this would double-redraw (hence no panel switching) or something if redraw() is not merely a request to do so
    }
    else if (keysym == "<UP>") {
        [cursor[windowMode], scroll[windowMode]] = win.scrollVert(-1, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], 1)
        drawFilePanel()
    }
    else if (keysym == "<DOWN>") {
        [cursor[windowMode], scroll[windowMode]] = win.scrollVert(+1, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], 1)
        drawFilePanel()
    }
    else if (keysym == "<PAGE_UP>") {
        [cursor[windowMode], scroll[windowMode]] = win.scrollVert(-LIST_HEIGHT, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], 1)
        drawFilePanel()
    }
    else if (keysym == "<PAGE_DOWN>") {
        [cursor[windowMode], scroll[windowMode]] = win.scrollVert(+LIST_HEIGHT, dirFileList[windowMode].length, LIST_HEIGHT, cursor[windowMode], scroll[windowMode], 1)
        drawFilePanel()
    }
    else if (keyJustHit && keycode == 66) { // enter
        let selectedFileCache = filePanelCache[windowMode][cursor[windowMode]]
        let selectedFile = selectedFileCache.file

        //serial.println(`selectedFile = ${selectedFile.fullPath}`)

        if (selectedFile.fullPath[1] == ":" && selectedFile.fullPath[2] == "\\" && selectedFile.fullPath.length == 3) {
            path[windowMode].push(selectedFile.fullPath)
            cursor[windowMode] = 0; scroll[windowMode] = 0
            refreshFilePanelCache(windowMode)
            drawFilePanel()
        }
        else if (selectedFileCache.isDirectory) {
            //serial.println(`selectedFile.name = ${selectedFile.name}`)
            path[windowMode].push(selectedFileCache.filename)
            cursor[windowMode] = 0; scroll[windowMode] = 0
            refreshFilePanelCache(windowMode)
            drawFilePanel()
        }
        else {
            let fileext = selectedFileCache.filename.substring(selectedFileCache.filename.lastIndexOf(".") + 1).toLowerCase()
            let execfun = EXEC_FUNS[fileext] || ((f) => _G.shell.execute(f))
            let errorlevel = 0

            con.curs_set(1);clearScr();con.move(1,1)
            try {
                //serial.println(selectedFile.fullPath)
                errorlevel = execfun(selectedFile.fullPath)
                //serial.println("1 errorlevel = " + errorlevel)
            }
            catch (e) {
                // TODO popup error
                println(e)
                errorlevel = 1
                //serial.println("2 errorlevel = " + errorlevel)
            }

            if (errorlevel) {
                println("Hit Return/Enter key to continue . . . .")
                sys.read()
            }

            firstRunLatch = true
            con.curs_set(0);clearScr()
            refreshFilePanelCache(windowMode)
            redraw()
        }
    }
    else if (keyJustHit && keysym == 'u') { // no bksp: used as an exit key for playmov/playwav
        if (path[windowMode].length >= 1) {
            path[windowMode].pop()
            cursor[windowMode] = 0; scroll[windowMode] = 0
            refreshFilePanelCache(windowMode)
            drawFilePanel()
        }
        else {
            // TODO list of drives

        }
    }
    else if (keyJustHit && keysym == 'm') {
        makePopup(1); redraw()
    }



    }
}



let paletteInput = (window, event) => {

    let eventName = event[0]
    if (eventName == "key_down") {

    let keysym = event[1]
    let keyJustHit = (1 == event[2])
    let keycodes = [event[3],event[4],event[5],event[6],event[7],event[8],event[9],event[10]]
    let keycode = keycodes[0]

    if (keyJustHit && keysym == 'm') {
        removePopup(); redraw()
    }

    }
}



let popupInput = (window, event) => {


}

///////////////////////////////////////////////////////////////////////////////////////////////////

let windows = [
/*index 0: main three panels*/[
    new win.WindowObject(1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, filenavOninput, filesPanelDraw), // left panel
    new win.WindowObject(WIDTH - SIDEBAR_WIDTH+1, 2, SIDEBAR_WIDTH, HEIGHT, ()=>{}, opPanelDraw),
//    new win.WindowObject(1, 2, SIDEBAR_WIDTH, HEIGHT, ()=>{}, opPanelDraw),
    new win.WindowObject(SIDEBAR_WIDTH + 1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, filenavOninput, filesPanelDraw), // right panel
],
/*index 1: commands palette*/[
    new win.WindowObject((WIDTH - POPUP_WIDTH) / 2, (HEIGHT - POPUP_HEIGHT) / 2, POPUP_WIDTH, POPUP_HEIGHT, paletteInput, paletteDraw, "Commands")
],
/*index 2: popup messages*/[
    new win.WindowObject((WIDTH - POPUP_WIDTH) / 2, (HEIGHT - POPUP_HEIGHT) / 2, POPUP_WIDTH, POPUP_HEIGHT, popupInput, popupDraw)
]]

const LEFTPANEL = windows[0][0]
const OPPANEL = windows[0][1]
const RIGHTPANEL = windows[0][2]

let currentPopup = 0

function makePopup(index) {
    currentPopup = index
    windowFocus.push(currentPopup)
    for (let i = 0; i < windows.length; i++) {
        windows[i].forEach(it => {
            it.isHighlighted = (i == index)
        })
    }
}

function removePopup() {
    windowFocus.pop()
    const index = windowFocus.last
    currentPopup = 0
    for (let i = 0; i < windows.length; i++) {
        windows[i].forEach(it => {
            it.isHighlighted = (i == index)
        })
    }
}

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
    // set highlight status
    const currentTopPanel = windowFocus.last()
    if (currentTopPanel == 0) {
        windows[0].forEach((panel, i)=>{
            panel.isHighlighted = (i == 2 * windowMode)
        })
    }
    else {
        windows[0].forEach((panel, i)=>{
            panel.isHighlighted = false
        })
    }
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

function drawPopupPanel() {
    if (currentPopup) {
        windows[currentPopup][0].drawContents()
        windows[currentPopup][0].drawFrame()
    }
}


function redraw() {
    redrawRequested = true
}

function _redraw() {
    clearScr()
    drawTitle()
    drawFilePanel()
    drawOpPanel()
    drawPopupPanel()
}

function clearScr() {
    con.clear()
    graphics.setBackground(34,51,68)
    graphics.clearPixels(255)
    graphics.setGraphicsMode(0)
}

///////////////////////////////////////////////////////////////////////////////////////////////////

con.curs_set(0)
refreshFilePanelCache(0)
refreshFilePanelCache(1)
_redraw()

let redrawRequested = false
let exit = false
let firstRunLatch = true

while (!exit) {
    input.withEvent(event => {

        let keysym = event[1]
        let keyJustHit = (1 == event[2])

        if (keyJustHit && event[3] != 66) { // release the latch right away if the key is not Return
            firstRunLatch = false
        }

        if (keyJustHit && firstRunLatch) { // filter out the initial ENTER key as they would cause unwanted behaviours
            firstRunLatch = false
        }
        else {
            windows[windowFocus.last()].forEach(it => {
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
}

con.curs_set(1)
con.clear()
return 0