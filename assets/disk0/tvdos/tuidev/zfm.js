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
let cursor = [0, 0]
// end of window states

let filesPanelDraw = (wo) => {
    let pathStr = path[windowMode].concat(['']).join("\\")
    if (windowMode) {
        wo.titleLeft = undefined
        wo.titleRight = pathStr
    }
    else {
        wo.titleLeft = pathStr
        wo.titleRight = undefined
    }

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

    // print entries
    for (let i = 0; i < Math.min(dirFileList[windowMode].length - s, LIST_HEIGHT); i++) {
        let file = dirFileList[windowMode][i+s]

        let backCol = (i == cursor[windowMode]) ? COL_BACK_SEL : COL_BACK

        con.move(wo.y + 2+i, wo.x + 1)
        if (file.isDirectory) {
            con.color_pair(COL_DIR, backCol)
            print("\\")
        }
        else {
            con.color_pair(COL_TEXT, backCol)
            print(" ")
        }

        // print filename
        con.move(wo.y + 2+i, wo.x + 2)
        print(file.name)
        print(' '.repeat(FILELIST_WIDTH - 2 - file.name.length))

        // print filesize
        con.color_pair(COL_TEXT, backCol)
        con.mvaddch(wo.y + 2+i, wo.x + FILELIST_WIDTH, 0xB3)

        let sizestr = ''+ (
            (file.size > 9999999) ? (((file.size / 100000)|0)/100 + "M") :
            (file.size > 9999) ? (((file.size / 1000)|0)/10 + "K") :
            file.size
        )
        con.move(wo.y + 2+i, wo.x + FILELIST_WIDTH + 1)
        print(' '.repeat(FILESIZE_WIDTH - sizestr.length + 1))
        print(sizestr)

    }
}
let opPanelDraw = (wo) => {
    function hr(y) {
        con.move(y, xp)
        print(`\x84196u`.repeat(SIDEBAR_WIDTH - 2))
    }

    con.color_pair(COL_TEXT, COL_BACK)

    let xp = wo.x + 1
    let yp = wo.y + 1

    // go up
    con.mvaddch(yp + 1, xp + 3, 0x18)
    con.move(yp + 2, xp)
    print(` \x1B[38;5;${COL_TEXT}mGo \x1B[38;5;${COL_HLACTION}mU\x1B[38;5;${COL_TEXT}mp`)

    hr(yp+4)

    // copy
    con.move(yp + 6, xp + 2)
    con.prnch(0xDB);con.prnch(0x1A);con.prnch(0xDB)
    con.move(yp + 7, xp)
    print(` \x1B[38;5;${COL_HLACTION}mC\x1B[38;5;${COL_TEXT}mopy`)

    hr(yp+9)

    // move
    con.move(yp + 11, xp + 2)
    con.prnch(0xB0);con.prnch(0x1A);con.prnch(0xDB)
    con.move(yp + 12, xp)
    print(` \x1B[38;5;${COL_HLACTION}mM\x1B[38;5;${COL_TEXT}move`)

    hr(yp+14)

    // delete
    con.move(yp + 16, xp + 2)
    con.prnch(0xDB);con.prnch(0x1A);con.prnch(0x58)
    con.move(yp + 17, xp)
    print(` \x1B[38;5;${COL_HLACTION}mD\x1B[38;5;${COL_TEXT}melete`)

    hr(yp+19)

    // mkdir
    con.move(yp + 21, xp + 2)
    con.prnch(0x2B);con.prnch(0xDE);con.prnch(0xDC)
    con.move(yp + 23, xp)
    print(` \x1B[38;5;${COL_TEXT}mm\x1B[38;5;${COL_HLACTION}mK\x1B[38;5;${COL_TEXT}mdir`)

    hr(yp+25)

    // other panel
    con.move(yp + 27, xp + 3)
    con.prnch((windowMode) ? 0x11 : 0x10)
    con.move(yp + 28, xp)
    print(`  \x1B[38;5;${COL_TEXT}m[\x1B[38;5;${COL_HLACTION}mZ\x1B[38;5;${COL_TEXT}m]`)
}




let windows = [[
    new win.WindowObject(1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, ()=>{}, filesPanelDraw), // left panel
    new win.WindowObject(WIDTH - SIDEBAR_WIDTH+1, 2, SIDEBAR_WIDTH, HEIGHT, ()=>{}, opPanelDraw),
//    new win.WindowObject(1, 2, SIDEBAR_WIDTH, HEIGHT, ()=>{}, opPanelDraw),
    new win.WindowObject(SIDEBAR_WIDTH + 1, 2, WIDTH - SIDEBAR_WIDTH, HEIGHT, ()=>{}, filesPanelDraw), // right panel
]]


function draw() {
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


    // draw panels
    windows[0].forEach((panel, i)=>{
        panel.isHighlighted = (i == windowFocus)
    })
    if (windowMode) {
        windows[0][2].drawContents()
        windows[0][2].drawFrame()
        windows[0][1].drawContents()
        windows[0][1].drawFrame()
    }
    else {
        windows[0][0].drawContents()
        windows[0][0].drawFrame()
        windows[0][1].drawContents()
        windows[0][1].drawFrame()
    }
}



con.clear()
draw()
con.move(WHEIGHT,1)

