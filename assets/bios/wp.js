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
let paragraphs = [
'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.',
'Contrary to popular belief, Lorem Ipsum is not simply random text. It has roots in a piece of classical Latin literature from 45 BC, making it over 2000 years old. Richard McClintock, a Latin professor at Hampden-Sydney College in Virginia, looked up one of the more obscure Latin words, consectetur, from a Lorem Ipsum passage, and going through the cites of the word in classical literature, discovered the undoubtable source. Lorem Ipsum comes from sections 1.10.32 and 1.10.33 of "de Finibus Bonorum et Malorum" (The Extremes of Good and Evil) by Cicero, written in 45 BC. This book is a treatise on the theory of ethics, very popular during the Renaissance. The first line of Lorem Ipsum, "Lorem ipsum dolor sit amet..", comes from a line in section 1.10.32.',
'The standard chunk of Lorem Ipsum used since the 1500s is reproduced below for those interested. Sections 1.10.32 and 1.10.33 from "de Finibus Bonorum et Malorum" by Cicero are also reproduced in their exact original form, accompanied by English versions from the 1914 translation by H. Rackham.'
]
let cursorRow = 0
let cursorCol = 0
let page = 0
let exit = false
let bulletinShown = false
let cursoringCol = 0

let filename = "NEWFILE"
let modified = false

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
    let icon = (modified) ? '*' : '-'
    let fnamestr = `${icon} ${filename} ${icon}`
    con.move(1,(windowWidth - fnamestr.length) / 2)
    print(fnamestr)
}

function drawPRC() {
    con.move(1,2)
    print(`PG:${page+1} LN:${cursorRow+1} COL:${cursorCol+1}     `)


    let rb = MEM - paragraphs.map(it => it.length).reduce((acc,i) => acc + i)
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
    let text = paragraphs.slice(lineStart, lineEnd).join('\n')

    serial.println(`paintWidth = ${paintWidth}`)

    for (let i = 0; i < text.length; i++) {
        let cM2 = text.charCodeAt(i-2)
        let cM1 = text.charCodeAt(i-1)
        let c = text.charCodeAt(i)
        let c1 = text.charCodeAt(i+1)
        let c2 = text.charCodeAt(i+2)

        serial.println(`i:${i} char:'${String.fromCharCode(cM2,cM1,32,c,32,c1,c2)}' Ln ${vr} Col ${vc}`)

        if (c == 10) {
            printbuf[vr] += String.fromCharCode(254)
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
            if (32 == c || 32 == c1) {
                printbuf[vr] += String.fromCharCode(c)
                vr += 1;vc = 0

                if (c1 == 32) i += 1
            }
            else if (32 == cM2) {
                // todo delet last char
                printbuf[vr] = printbuf[vr].substring(0, printbuf[vr].length - 1)
                vr += 1; vc = 1
                printbuf[vr] += String.fromCharCode(cM1, c)
            }
            else {
                printbuf[vr] += (45 == cM1 || 32 == cM1) ? ' ' : '-'
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