const COL_TEXT = 253
const COL_BACK = 255
const COL_SUPERTEXT = 239
const COL_DIMTEXT = 249
const COL_LNUMBACK = 18
const COL_LNUMFORE = 253
const COL_CARET_ROW = 81
const PAINT_START_X = 5
const PAINT_START_Y = 2
const BIG_STRIDE = 999
const TAB_SIZE = 4

const caretLeft = 10
const caretRight = 80

let scroll = 0
let scrollHor = 0
let textbuffer = [""]
let cursorRow = 0
let cursorCol = 0
let exit = false
let scene = -1 // -1: main, 0: filemenu, 1: editmenu , ...
let bulletinShown = false
let cursoringCol = 0

let windowWidth = 0
let windowHeight = 0
let paintWidth = 0
let paintHeight = 0
let scrollPeek = 0
function drawInit() {
    windowWidth = con.getmaxyx()[1]
    windowHeight = con.getmaxyx()[0]
    paintWidth = windowWidth - PAINT_START_X + 1
    paintHeight = windowHeight - PAINT_START_Y + 1
    scrollPeek = Math.ceil((paintHeight / 7))
}
const scrollHorPeek = 1; // to accommodate the scroll indicator


function drawMain() {
    con.curs_set(0)
    drawInit()
    con.clear()
    con.color_pair(COL_TEXT, COL_BACK)

    // column indicator
    con.move(2,1)
    for (let k = 0; k < 9; k++) print(`${k}....:....`)
    con.color_pair(COL_BACK, COL_TEXT)
    con.mvaddch(2,1+caretLeft,91)
    con.mvaddch(2,1+caretRight,93)

    con.color_pair(COL_BACK, COL_TEXT)
}


drawMain()