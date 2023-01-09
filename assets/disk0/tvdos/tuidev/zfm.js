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

let windowMode = 0 // 0 == left, 1 == right
let windowFocus = 0 // 0,2: files panel, 1: operation panel, -1: a wild popup message appeared

// window states
let path = [["A:"], ["A:"]]
let scroll = [0, 0]
let dirFileList = [[], []]
let cursor = [0, 0] // absolute position!
// end of window states


function bytesToReadable(i) {
    return ''+ (
       (i > 9999999) ? (((i / 100000)|0)/100 + "M") :
       (i > 9999) ? (((i / 1000)|0)/10 + "K") :
       i
   )
}

let filesPanelDraw = (wo) => {
    let pathStr = path[windowMode].concat(['']).join("\\")
    let port = _TVDOS.DRIVES[pathStr[0]]
    _TVDOS.DRV.FS.SERIAL._flush(port[0]);_TVDOS.DRV.FS.SERIAL._close(port[0])
    com.sendMessage(port[0], "USAGE")
    let response = com.getStatusCode(port[0])
    let usedBytes = undefined
    let totalBytes = undefined
    let freeBytes = undefined
    if (0 == response) {
        let rawStr = com.fetchResponse(port[0]).split('/') // USED1234/TOTAL23412341
        usedBytes = (rawStr[0].substring(4))|0
        totalBytes = (rawStr[1].substring(5))|0
        freeBytes = totalBytes - usedBytes
    }

    let diskSizestr = bytesToReadable(freeBytes)+"/"+bytesToReadable(totalBytes)

    wo.titleLeft = pathStr
    wo.titleRight = diskSizestr


    // draw list header
    con.color_pair(COL_HLTEXT, COL_BACK)
    con.move(wo.y + 1, wo.x + 1); print(" Name")
    con.mvaddch(wo.y + 1, wo.x + FILELIST_WIDTH, 0xB3)
    con.curs_right(); print(" Size")


    con.color_pair(COL_TEXT, COL_BACK)
    // draw list
    let directory = files.open(pathStr)
    let fileList = directory.list()
    let s = scroll[windowMode]

    // sort fileList
    let ds = []
    let fs = []
    fileList.forEach((file)=>{
        if (file.isDirectory)
            ds.push(file)
        else
            fs.push(file)
    })
    ds.sort((a,b) => (a.name > b.name) ? 1 : (a.name < b.name) ? -1 : 0)
    fs.sort((a,b) => (a.name > b.name) ? 1 : (a.name < b.name) ? -1 : 0)
    dirFileList[windowMode] = ds.concat(fs)

    let filesCount = dirFileList[windowMode].length
    // print entries
    for (let i = 0; i < Math.min(filesCount - s, LIST_HEIGHT); i++) {
        let file = dirFileList[windowMode][i+s]
        let sizestr = bytesToReadable(file.size)

        // set bg colour
        let backCol = (i == cursor[windowMode] - s) ? COL_BACK_SEL : COL_BACK
        // set fg colour (if there are more at the top/bottom, dim the colour)
        let foreCol = (i == 0 && s > 0 || i == LIST_HEIGHT - 1 && i + s < filesCount - 1) ? COL_DIMTEXT : COL_TEXT

        // print filename
        con.color_pair(foreCol, backCol)
        con.move(wo.y + 2+i, wo.x + 1)
        print(((file.isDirectory) ? '\\' : ' ')+file.name)
        print(' '.repeat(FILELIST_WIDTH - 2 - file.name.length))

        // print |
        con.color_pair(COL_TEXT, backCol)
        con.mvaddch(wo.y + 2+i, wo.x + FILELIST_WIDTH, 0xB3)

        // print filesize
        con.color_pair(foreCol, backCol)
        con.move(wo.y + 2+i, wo.x + FILELIST_WIDTH + 1)
        print(' '.repeat(FILESIZE_WIDTH - sizestr.length + 1))
        print(sizestr)
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
    con.move(yp + 3, xp + 3)
    con.prnch((windowMode) ? 0x11 : 0x10)
    con.move(yp + 4, xp)
    print(`  \x1B[38;5;${COL_TEXT}m[\x1B[38;5;${COL_HLACTION}mZ\x1B[38;5;${COL_TEXT}m]`)

    hr(yp+8)

    // go up
    con.mvaddch(yp + 9, xp + 3, 0x18)
    con.move(yp + 10, xp)
    print(` \x1B[38;5;${COL_TEXT}mGo \x1B[38;5;${COL_HLACTION}mU\x1B[38;5;${COL_TEXT}mp`)

    hr(yp+11)

    // copy
    con.move(yp + 12, xp + 2)
    con.prnch(0xDB);con.prnch((windowMode) ? 0x1B : 0x1A);con.prnch(0xDB)
    con.move(yp + 13, xp)
    print(` \x1B[38;5;${COL_HLACTION}mC\x1B[38;5;${COL_TEXT}mopy`)

    hr(yp+14)

    // move
    con.move(yp + 15, xp + 2)
    if (windowMode) con.prnch([0xDB, 0x1B, 0xB0]); else con.prnch([0xB0, 0x1A, 0xDB])
    con.move(yp + 16, xp)
    print(` \x1B[38;5;${COL_HLACTION}mM\x1B[38;5;${COL_TEXT}move`)

    hr(yp+17)

    // delete
    con.move(yp + 18, xp + 2)
    if (windowMode) con.prnch([0xDB, 0x1A, 0xF9]); else con.prnch([0xF9, 0x1B, 0xDB])
    con.move(yp + 19, xp)
    print(` \x1B[38;5;${COL_HLACTION}mD\x1B[38;5;${COL_TEXT}melete`)

    hr(yp+20)

    // mkdir
    con.move(yp + 21, xp + 2)
    con.prnch(0xDB)
    con.video_reverse();con.prnch(0x2B);con.video_reverse()
    con.prnch(0xDF)
    con.move(yp + 22, xp)
    print(` \x1B[38;5;${COL_TEXT}mm\x1B[38;5;${COL_HLACTION}mK\x1B[38;5;${COL_TEXT}mdir`)

    hr(yp+23)

    // rename
    con.move(yp + 24, xp + 2)
    con.prnch(0x4E);con.prnch(0x1A);con.prnch(0x52)
    con.move(yp + 25, xp)
    print(` \x1B[38;5;${COL_HLACTION}mR\x1B[38;5;${COL_TEXT}mename`)

    hr(yp+26)

    // quit
    con.move(yp + 27, xp + 3)
    con.prnch(0x7F)
    con.move(yp + 28, xp)
    print(` \x1B[38;5;${COL_HLACTION}mQ\x1B[38;5;${COL_TEXT}muit`)


}




let windows = [[
    new win.WindowObject(1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, ()=>{}, filesPanelDraw), // left panel
    new win.WindowObject(WIDTH - SIDEBAR_WIDTH+1, 2, SIDEBAR_WIDTH, HEIGHT, ()=>{}, opPanelDraw),
//    new win.WindowObject(1, 2, SIDEBAR_WIDTH, HEIGHT, ()=>{}, opPanelDraw),
    new win.WindowObject(SIDEBAR_WIDTH + 1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, ()=>{}, filesPanelDraw), // right panel
]]

const LEFTPANEL = windows[0][0]
const OPPANEL = windows[0][1]
const RIGHTPANEL = windows[0][2]

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
    windows[0].forEach((panel, i)=>{
        panel.isHighlighted = (i == windowFocus)
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
    con.clear()
    drawTitle()
    drawFilePanel()
    drawOpPanel()
}

function scrollFiles(ody) {
    let dy = ody
    let oldScroll = scroll[windowMode]
    let peek = 1

    // clamp dy
    if (cursor[windowMode] + dy > dirFileList[windowMode].length - 1)
        dy = (dirFileList[windowMode].length - 1) - cursor[windowMode]
    else if (cursor[windowMode] + dy < 0)
        dy = -cursor[windowMode]

    let nextRow = cursor[windowMode] + dy
    
    // update vertical scroll stats
    if (dy != 0) {
        let visible = LIST_HEIGHT - 1 - peek

        if (nextRow - scroll[windowMode] > visible) {
            scroll[windowMode] = nextRow - visible
        }
        else if (nextRow - scroll[windowMode] < 0 + peek) {
            scroll[windowMode] = nextRow - peek // nextRow is less than zero
        }

        // NOTE: future-proofing here -- scroll clamping is moved outside of go-up/go-down
        // if-statements above because horizontal movements can disrupt vertical scrolls as well because
        // "normally" when you go right at the end of the line, you appear at the start of the next line

        // scroll to the bottom?
        if (dirFileList[windowMode].length > LIST_HEIGHT && scroll[windowMode] > dirFileList[windowMode].length - LIST_HEIGHT)
            // to make sure not show buncha empty lines
            scroll[windowMode] = dirFileList[windowMode].length - LIST_HEIGHT
        // scroll to the top? (order is important!)
        if (scroll[windowMode] <= -1)
            scroll[windowMode] = 0 // scroll of -1 would result to show "Line 0" on screen
    }
    
    // move editor cursor
    cursor[windowMode] = nextRow

    // update screendraw
    drawFilePanel()
}

///////////////////////////////////////////////////////////////////////////////////////////////////

con.curs_set(0)
redraw()

let exit = false

while (!exit) {

    input.withEvent(event => {
        let eventName = event[0]
        if (eventName == "key_down") {

        let keysym = event[1]
        let keycodes = [event[3],event[4],event[5],event[6],event[7],event[8],event[9],event[10]]
        let keycode = keycodes[0]

        if (keysym == "q") {
            exit = true
        }
        else if (keysym == 'z') {
            windowMode = 1 - windowMode
            windowFocus = 2 - windowFocus
            redraw()
        }
        else if (keysym == "<UP>") {
            scrollFiles(-1)
        }
        else if (keysym == "<DOWN>") {
            scrollFiles(+1)
        }


    }})

}

con.curs_set(1)
con.clear()
return 0