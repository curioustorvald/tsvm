const COL_TEXT = 253
const COL_BACK = 255
const COL_SUPERTEXT = 239
const COL_DIMTEXT = 249
const COL_LNUMBACK = 18
const COL_LNUMFORE = 253
const COL_CARET_ROW = 81
const BIG_STRIDE = 999
const TAB_SIZE = 4
const PAINT_START_Y = 3
const MEM = system.maxmem()

const NO_LINEHEAD_PUNCT = [33,34,39,41,44,46,58,59,62,63,93,125]
const NO_LINELAST_PUNCT = [34,39,40,60,91,123]

let PAGE_HEIGHT = 56

let caretLeft = 10
let caretRight = 80

let scroll = 0
let scrollHor = 0
let textbuffer = ["Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum."]
let cursorRow = 0
let cursorCol = 0
let page = 0
let exit = false
let bulletinShown = false
let cursoringCol = 0

let filename = "NEWFILE"
let modified = true

let windowWidth = 0
let windowHeight = 0
let paintWidth = 0
let paintHeight = 0
let scrollPeek = 0
let PAINT_START_X = 0
function drawInit() {
    windowWidth = con.getmaxyx()[1]
    windowHeight = con.getmaxyx()[0]
    PAINT_START_X = caretLeft + 1

    paintWidth = caretRight - caretLeft + 1
    paintHeight = windowHeight - PAINT_START_Y + 1

    scrollPeek = Math.ceil((paintHeight / 7))

}
const scrollHorPeek = 1; // to accommodate the scroll indicator

function drawMenubar() {
    con.move(1,2)
    print(`FILE:${(modified) ? '*' : ' '}${filename}`)
}

function drawPRC() {
    con.move(1,2+20+6)
    print(`PG:${page+1} LN:${cursorRow+1} COL:${cursorCol+1}     `)


    let rb = MEM - textbuffer.map(it => it.length).reduce((acc,i) => acc + i)
    let rp = (rb/100)|0
    let s = `   REMAIN:${(rp/10)|0}.${rp%10}K`
    con.move(1,windowWidth - s.length)
    print(s)
}

function drawTextbuffer(from, toExclusive) {
    let lineStart = from || scroll
    let lineEnd = toExclusive || scroll + paintHeight

    let printbuf = []
    for (let i = 0; i < paintHeight; i++) { printbuf.push('') }
    let vr = 0; let vc = 0 // virtual row/column
    let text = textbuffer.slice(lineStart, lineEnd).join('\n')

    serial.println(`paintWidth = ${paintWidth}`)

    for (let i = 0; i < text.length; i++) {
        let c = text.charCodeAt(i)
        let c1 = text.charCodeAt(i+1)
        let c2 = text.charCodeAt(i+2)

        serial.println(`i:${i} char:'${String.fromCharCode(c,c1)}' Ln ${vr} Col ${vc}`)

        if (c == 10) {
            vr += 1;vc = 0
            printbuf[vr] = ''
        }
        else if (vc == paintWidth - 1 && NO_LINEHEAD_PUNCT.includes(c1)) {
            printbuf[vr] += String.fromCharCode(c, c1)
            vr += 1;vc = 0
            i += (32 == c2) ? 2 : 1
        }
        else if (vc == paintWidth - 1 && NO_LINELAST_PUNCT.includes(c)) {
            vr += 1;vc = 0
            printbuf[vr] += String.fromCharCode(c)
        }
        else if (vc == paintWidth - 1) {
            if (c == 32 || c1 == 32) {
                printbuf[vr] += String.fromCharCode(c)
                vr += 1;vc = 0

                if (c1 == 32) i += 1
            }
            else {
                printbuf[vr] += '-'
                vr += 1;vc = 0
                printbuf[vr] += String.fromCharCode(c)
                vc += 1
            }
        }
        else if (c >= 32) {
            printbuf[vr] += String.fromCharCode(c)
            vc += 1
        }

        if (vr > paintHeight || c === undefined) break;
    }

    for (let y = 0; y < paintHeight; y++) {
        con.move(3+y, 1+caretLeft)
        print(printbuf[y] || '')
    }

    gotoText()
}

function gotoText() {
    con.move(PAINT_START_Y + cursorRow - scroll, PAINT_START_X + cursorCol - scrollHor)
    con.curs_set(1)
}

function drawMain() {
    con.curs_set(0)
    drawInit()
    con.clear()
    con.color_pair(COL_TEXT, COL_BACK)

    drawMenubar()
    drawPRC()

    // column indicator
    con.move(2,1)
    for (let k = 0; k < 9; k++) print(`${k}....:....`)
    con.color_pair(COL_BACK, COL_TEXT)
    con.mvaddch(2,1+caretLeft,91)
    con.mvaddch(2,1+caretRight,93)

    con.color_pair(COL_TEXT, COL_BACK)
}


drawMain()
drawTextbuffer(0)