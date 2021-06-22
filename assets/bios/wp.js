const COL_TEXT = 239
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

const TYPESET_DEBUG_PRINT = true

const SYM_SPC = String.fromCharCode(250)
const SYM_TWOSPC = String.fromCharCode(251,252)
const SYM_FF = String.fromCharCode(253)
const SYM_LF = String.fromCharCode(254)
const SYM_HYPHEN = '-'

const NO_LINEHEAD_PUNCT = [33,34,39,41,44,46,58,59,62,63,93,125]
const NO_LINELAST_PUNCT = [34,39,40,60,91,123]
const THIN_PUNCT = [',','.',SYM_LF]

const NO_PRINT_CHAR = [0,252,253,254]

function typesetSymToVisual(code) {
    return (code >= 250 && code < 255) ? 32 : code
}


const TYPESET_STRATEGY_DONOTHING = 0 // not implemented yet!
const TYPESET_STRATEGY_RAGGEDRIGHT = 1 // not implemented yet!
const TYPESET_STRATEGY_LESSRAGGED = 2
const TYPESET_STRATEGY_JUSTIFIED = 3 // not implemented yet!
const typesetStrats = [undefined, undefined, typesetLessRagged, typesetJustified]

let PAGE_HEIGHT = 60
let PAGE_WIDTH = 70
// 80x60  -> 720x1080 text area; with 72px margin for each side, paper resolution is 864x1224, which is quite close to 1:sqrt(2) ratio

let scroll = 0
let scrollHor = 0
/*let paragraphs = [
'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.',
'Contrary to popular belief, Lorem Ipsum is not simply random text. It has roots in a piece of classical Latin literature from 45 BC, making it over 2000 years old. Richard McClintock, a Latin professor at Hampden-Sydney College in Virginia, looked up one of the more obscure Latin words, consectetur, from a Lorem Ipsum passage, and going through the cites of the word in classical literature, discovered the undoubtable source. Lorem Ipsum comes from sections 1.10.32 and 1.10.33 of "de Finibus Bonorum et Malorum" (The Extremes of Good and Evil) by Cicero, written in 45 BC. This book is a treatise on the theory of ethics, very popular during the Renaissance. The first line of Lorem Ipsum, "Lorem ipsum dolor sit amet..", comes from a line in section 1.10.32.',
'The standard chunk of Lorem Ipsum used since the 1500s is reproduced below for those interested. Sections 1.10.32 and 1.10.33 from "de Finibus Bonorum et Malorum" by Cicero are also reproduced in their exact original form, accompanied by English versions from the 1914 translation by H. Rackham.'
]*/
let paragraphs = [
'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.',
'Contrary to popular belief, Lorem Ipsum is not simply random text. It has roots in a piece of classical Latin literature from 45 BC, making it over 2000 years old. Richard McClintock, a Latin professor at Hampden-Sydney College in Virginia, looked up one of the more obscure Latin words, consectetur, from a Lorem Ipsum passage, and going through the cites of the word in classical literature, discovered the undoubtable source. Lorem Ipsum comes from sections 1.10.32 and 1.10.33 of "de Finibus Bonorum et Malorum" (The Extremes of Good and Evil) by Cicero, written in 45 BC. This book is a treatise on the theory of ethics, very popular during the Renaissance. The first line of Lorem Ipsum, "Lorem ipsum dolor sit amet..", comes from a line in section 1.10.32.',
'The standard chunk of Lorem Ipsum used since the 1500s is reproduced below for those interested. Sections 1.10.32 and 1.10.33 from "de Finibus Bonorum et Malorum" by Cicero are also reproduced in their exact original form, accompanied by English versions from the 1914 translation by H. Rackham.'
]
/*let paragraphs = [
'Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry\'s standard dummy text ever since the 1500s,  when an unknown printer took a galley  of type and scrambled it  to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting,remaining essentially unchanged.It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing  software like Aldus PageMaker  including versions of Lorem Ipsum.',
'Contrary to popular belief, Lorem Ipsum is not simply random text.  It has roots in a piece of classical Latin literature from  45 BC,  making it over 2000 years old. Richard McClintock, a Latin professor at Hampden-Sydney College in Virginia, looked up one of the more obscure Latin words,  consectetur,  from a Lorem Ipsum passage, and going through the cites of the word in classical literature, discovered the undoubtable source.  Lorem Ipsum comes from sections 1.10.32 and 1.10.33 of "de Finibus Bonorum et Malorum" (The Extremes of Good and Evil) by Cicero, written in 45 BC.  This book is a treatise on the theory of ethics, very popular during the Renaissance.The first line of Lorem Ipsum,"Lorem ipsum dolor sit amet..", comes from a line in section 1.10.32.',
'The standard chunk of Lorem Ipsum used since the 1500s is reproduced below for those interested. Sections 1.10.32 and 1.10.33 from "de Finibus Bonorum et Malorum" by Cicero are also reproduced in their exact original form, accompanied by English versions from the 1914 translation by H. Rackham.'
]*/
let typeset = {lineIndices: [], lineValidated: [], strategy: TYPESET_STRATEGY_JUSTIFIED} // index 0 == 2nd line
let cursorRow = 0
let cursorCol = 0
let page = 0
let exit = false
let bulletinShown = false
let cursoringCol = 0

let filename = "NEWFILE"
let modified = false
let editorMode = 1 // 0: Visual Mode, 1: Edit Mode, 2: Command Mode; just like the good ol' Vi
const editorModeLabel = ["VISUAL MODE (hit I to EDIT, hit : to enter a COMMAND)", "EDIT MODE (hit ESC for Visual Mode)", ":"]
let cmdbuf = ""

let windowWidth = 0
let windowHeight = 0
let paintWidth = 0
let paintHeight = 0
let scrollPeek = 0
let PAINT_START_X = 0
let caretLeft = 0
let caretRight = 0
const scrollHorPeek = 1; // to accommodate the scroll indicator
function drawInit() {
    // wipe screen
    for (let i = 0; i < 80*32; i++) {
        sys.poke(-1302529 - i, COL_TEXT)
        sys.poke(-1305089 - i, COL_BACK)
        sys.poke(-1307649 - i, 0)
    }

    // set variables
    windowWidth = con.getmaxyx()[1]
    windowHeight = con.getmaxyx()[0]
    caretLeft = (windowWidth - PAGE_WIDTH) >> 1
    caretRight = caretLeft + PAGE_WIDTH

    PAINT_START_X = caretLeft + 1

    paintWidth = caretRight - caretLeft
    paintHeight = windowHeight - PAINT_START_Y

    scrollPeek = Math.ceil((paintHeight / 7))

}

function ctrlToSym(c) {
    if (c == 10) return 254
    if (c == 32) return 250
    return c
}

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

function typesetLessRagged(lineStart, lineEnd) {
    let printbuf = []
    let lineIndices = []
    for (let i = lineStart; i < lineEnd; i++) { printbuf.push('') }

    let vr = 0; let vc = 0 // virtual row/column
    let text = (typeset.lineIndices[lineStart] !== undefined)
        ? paragraphs.join('\n').slice(typeset.lineIndices[lineStart], typeset.lineIndices[lineEnd] || 9999999)
        : paragraphs.join('\n')

    let ln = function(i) {
        vr += 1;vc = 0
        lineIndices.push(i)
    }

    for (let i = 0; i < text.length; i++) {
        let cM2 = text.charCodeAt(i-2)
        let cM1 = text.charCodeAt(i-1)
        let c = text.charCodeAt(i)
        let c1 = text.charCodeAt(i+1)
        let c2 = text.charCodeAt(i+2)

        //serial.println(`i:${i} char:'${String.fromCharCode(cM2,cM1,32,c,32,c1,c2)}' Ln ${vr} Col ${vc}`)

        if (c == 10) {
            printbuf[vr] += SYM_LF
            ln(i+1)
            printbuf[vr] = ''
        }
        else if (vc == paintWidth - 1 && NO_LINEHEAD_PUNCT.includes(c1)) {
            printbuf[vr] += String.fromCharCode(c, c1)
            ln(i)
            i += (32 == c2) ? 2 : 1
            lineIndices[lineIndices.length - 1] = i+1
        }
        else if (vc == paintWidth - 1 && NO_LINELAST_PUNCT.includes(c)) {
            ln(i)
            printbuf[vr] += String.fromCharCode(c)
        }
        else if (vc == paintWidth - 1) {
            if (32 == c || 32 == c1 || 10 == c1) {
                printbuf[vr] += String.fromCharCode(ctrlToSym(c))
                if (32 == c1 || 10 == c1) printbuf[vr] += String.fromCharCode(ctrlToSym(c1))
                ln(i+1)
                if (32 == c1 || 10 == c1) {
                    i += 1
                    lineIndices[lineIndices.length - 1] += 1
                }
            }
            // if the head-char of the word happens to sit on the rightmost side and the char right before is ' '
            else if (32 == cM2) {
                printbuf[vr] = printbuf[vr].substring(0, printbuf[vr].length - 1)
                ln(i-1); vc = 1
                printbuf[vr] += String.fromCharCode(cM1, c)
            }
            else {
                printbuf[vr] += (45 == cM1 || 32 == cM1) ? ' ' : '-'
                ln(i)
                printbuf[vr] += String.fromCharCode(c)
                vc += 1
            }
        }
        else if (c >= 32 && c <= 175 || c >= 224 && c <= 253) {
            printbuf[vr] += String.fromCharCode(ctrlToSym(c))
            vc += 1
        }

        if (vr > paintHeight || c === undefined) break
    }

    return [printbuf, lineIndices]
}

function getRealLength(text) {
    return text.replaceAll(SYM_TWOSPC, ' ').replaceAll(SYM_LF, '').replaceAll(SYM_FF, '').length
}

function typesetJustified(lineStart, lineEnd) {
    const pnTier = {'.':1, ',':2}
    function wordobj(t,v) { return {type:t, value:v} }
    function getWordLen(o) { return (o.type.startsWith("ct")) ? 0 : o.value.length }
    function wordTypeOf(c, c1) {
        if (c == " ") return "sp"
        else if ((c1 == " " || c1 == "\n") && (NO_LINEHEAD_PUNCT.includes(c.charCodeAt(0)) || NO_LINELAST_PUNCT.includes(c.charCodeAt(0)))) return "pn"
        else return "tx"
    }
    function shufflePNs(pns) {
        let pnsWithSortID = pns.map(it => {
            let rndnum = (Math.random() * 65536)|0
            let tier = pnTier[it.value] || 16
            return {key: (tier-1) * 65536 + rndnum, value: it}
        })
        pnsWithSortID.sort((it, other) => it.key - other.key)
        return pnsWithSortID.map(it => it.value)
    }
    function printdbg(msg) { serial.println(`L${lc}\t${msg}`) }

    let printbuf = []
    let lineIndices = []

    let text = (typeset.lineIndices[lineStart] !== undefined)
        ? paragraphs.join('\n').slice(typeset.lineIndices[lineStart], typeset.lineIndices[lineEnd] || 9999999)
        : paragraphs.join('\n')

    let textCursor = 0
    let lc = 1
    let isParHead = true
    while (true) {

        let _status = wordTypeOf(text.charAt(textCursor), text.charAt(textCursor+1)) // state of the state machine
        let _linelen = 0

        let words = [wordobj(_status, "")] // {type: "tx/sp/pn/ct", value: ""}

        // fill in words array
        while (_linelen <= paintWidth || _status == "tx") {

            let c = text.charAt(textCursor + _linelen)
            let c1 = text.charAt(textCursor + _linelen + 1)

            let newStatus = wordTypeOf(c, c1)

            if (_status != newStatus) {
                if (newStatus != "tx" && _linelen > paintWidth) break
                _status = newStatus
                words.push(wordobj(_status, ""))
            }

            if (c == '\n') {
                words.last().type = "ct_lf"
                words.last().value = SYM_LF
                break
            }
            else if ("tx" == _status) {
                words.last().value += c; _linelen += 1
            }
            else if ("sp" == _status) {
                words.last().value += SYM_SPC; _linelen += 1
            }
            else if ("pn" == _status) {
                words.last().value += c; _linelen += 1
            }


            if (c1 == '\n') {
                words.push(wordobj("ct_lf", SYM_LF))
                break
            }
        }



        function tryJustify(recDepth, adjust, fuckit) {
            let spacesRemoved = 0
            let isLineEnd = (words.last().type == "ct_lf")
            // trim spaces at the end of the line
            while ("sp" == words.last().type) {
                spacesRemoved += getWordLen(words.pop())
            }
            // trim spaces at the head of the line
            while (!isParHead && "sp" == words.head().type) {
                let rlen = getWordLen(words.shift())
                spacesRemoved -= rlen
            }

            printdbg(`spacesRemoved = ${spacesRemoved}`)
            //printdbg(`Space trim-nugding ${-spacesRemoved} characters`)
            //adjust -= spacesRemoved

            let spcAfterPunct = [] // indices in the WORDS
            words.forEach((o,i,a) => {
                if (i > 0 && THIN_PUNCT.includes(a[i-1].value) && getWordLen(o) > 0 && o.type == "sp") {
                    spcAfterPunct.push(i)
                }
            })
            let normalSpc = [] // indices in the WORDS
            words.forEach((o,i,a) => {
                if (i > 0 && !THIN_PUNCT.includes(a[i-1].value) && getWordLen(o) > 0 && o.type == "sp") {
                    normalSpc.push(i)
                }
            })


            let justBuf = words.reduce((s,o) => s+o.value, '')
            let justLen = words.reduce((s,o) => s+getWordLen(o), 0)

            printdbg(`(${justLen})[${words.flatMap(o => o.value.split('').map(s => typesetSymToVisual(s.charCodeAt(0)))).reduce((a,c) => a + String.fromCharCode(c),'')}${(isLineEnd) ? "\\\\" : "]"}<${adjust}>`)

            // termination condition
            if (fuckit || (justLen == paintWidth + 1 && THIN_PUNCT.includes(words.last().value) || justLen == paintWidth)) {
                printdbg("TERMINATE")

                if (isLineEnd) {
                    printdbg("Line end detected, nudging 1 character")
                    adjust += 1
                }

                printbuf.push(justBuf.slice(0))
                printdbg(`Cursor advance: ${justLen + adjust}`)

                // NOTE: a dangling-lette-r simply does not happen; do the math! *tapping forehead with index finder*

                printdbg(`(${justLen})[${words.flatMap(o => o.value.split('').map(s => typesetSymToVisual(s.charCodeAt(0)))).reduce((a,c) => a + String.fromCharCode(c),'')}${(isLineEnd) ? "\\\\" : "]"}<${adjust}>`)

                let justedTextLen = 0
                let lastLine = printbuf.last()
                for (let i = 0; i < lastLine.length; i++) {
                    justedTextLen += 1 - NO_PRINT_CHAR.includes(lastLine.charCodeAt(i))
                }
                printdbg(`justedTextLen = ${justedTextLen}`)
                return justedTextLen + adjust
            }
            // try hyphenation
            else if (justLen > paintWidth && getWordLen(words.last()) >= 4 && justLen - getWordLen(words.last()) <= paintWidth - 3 && !words.last().value.includes(SYM_HYPHEN)) {
                printdbg("HYP-HEN-ATE")
                let lengthBeforeLastWord = justLen - getWordLen(words.last())
                let lengthAfterHyphen = justLen

                words.last().value = words.last().value.slice(0, paintWidth - lengthBeforeLastWord - 1) + SYM_HYPHEN
                printdbg(`hyphenate-nugding -1 characters`)
                adjust -= 1 // hyphen is inserted therefore the actual line length is 1 character less
            }
            // try contract puncts
            else if (justLen > paintWidth && spcAfterPunct.length >= justLen - paintWidth) {
                printdbg("CONTRACT,PUNCT")

                let contractTargets = spcAfterPunct.shuffle()
                printdbg(`contract targets: ${contractTargets.join()}, amount: ${justLen - paintWidth}`)

                for (let i = 0; i < Math.min(contractTargets.length, justLen - paintWidth); i++) {
                    words[contractTargets[i]].value = ''
                }

                //adjust += getWordLen(words.last()) // the last word is going to be appended
                printdbg(`contract-nugding ${justLen - paintWidth} characters`)
                adjust += justLen - paintWidth // the last word is going to be appended
            }
            // if any concatenation is impossible, recurse without last word (spaces will be trimmed on recursion), so that if-clauses below would treat them
            else if (justLen > paintWidth && spcAfterPunct.length < justLen - paintWidth) {
                printdbg("TOSS OUT LAST")
                while ("tx" == words.last().type) {
                    let poplen = getWordLen(words.pop())
                    //adjust -= poplen
                }
            }
            // expand spaces
            else if (!isLineEnd && justLen < paintWidth) {
                printdbg("EXPAND  SPACES   BETWEEN")

                let expandTargets = normalSpc.shuffle().concat(spcAfterPunct.shuffle())
                printdbg(`expand targets: ${expandTargets.join()}, amount: ${paintWidth - justLen}`)

                for (let i = 0; i < Math.min(expandTargets.length, paintWidth - justLen); i++) {
                    let old = words[expandTargets[i]].value
                    words[expandTargets[i]].value = (SYM_SPC == old) ? SYM_TWOSPC :
                        (SYM_TWOSPC == old) ? `\x00${SYM_SPC}\x00` :
                        (` ${SYM_SPC} ` == old) ? `\x00${SYM_TWOSPC}\x00` :
                        (` ${SYM_SPC} ` == old) ? `\x00\x00${SYM_SPC}\x00\x00` :
                        (old.length % 2 == 0) ? ('\x00' + old) : (old + '\x00')
                    //adjust += 1
                }
            }
            // fuckit
            else {
                printdbg("GIVE UP")
                return tryJustify(recDepth + 1, adjust, true)

            }

            //printdbg(`[${words.flatMap(o => o.value.split('').map(s => typesetSymToVisual(s.charCodeAt(0)))).reduce((a,c) => a + String.fromCharCode(c),'')}]`)
            return tryJustify(recDepth + 1, adjust)
        }




        words.forEach((o,i) => printdbg(`${i}\t${o.type}\t${o.value}`))
        textCursor += tryJustify(0,0)

        isParHead = false

        lc += 1




        if (printbuf.length > 5) break
        if (printbuf.length > paintHeight || textCursor >= text.length) break

        printdbg("======================")
    }

    return [printbuf, lineIndices]
}

function typesetAndPrint(from, toExclusive) {
    let lineStart = from || scroll
    let lineEnd = toExclusive || lineStart + paintHeight

    let lineValidated = []
    let [printbuf, lineIndices] = typesetStrats[typeset.strategy](lineStart, lineEnd)

    for (let y = 0; y < paintHeight; y++) {
        let str = printbuf[y] || ''
        for (let x = 0; x < paintWidth + 3; x++) {
            sys.poke(
                -1307649 - ((y+2) * windowWidth + caretLeft) - x,
                str.charCodeAt(x) || 0
            )
        }
    }

    if (TYPESET_DEBUG_PRINT) {
        for (let y = 0; y < paintHeight; y++) {
            con.move(3+y, 1)
            print('     ')
            con.move(3+y, 1)
            print((lineIndices[y-1+lineStart]+1)|0 || '-')
        }
    }

    // update typeset info
    typeset.lineIndices = []
        .concat(typeset.lineIndices.slice(0, lineStart))
        .concat(lineIndices)
        .concat(typeset.lineIndices.slice(lineEnd))
    typeset.lineValidated = []
        .concat(typeset.lineValidated.slice(0, lineStart))
        .concat(lineIndices.map(it => true))
        .concat(typeset.lineValidated.slice(lineEnd))

    gotoText()
}

function gotoText() {
    con.move(PAINT_START_Y + cursorRow - scroll, PAINT_START_X + cursorCol - scrollHor)
    con.curs_set(1)
}

function drawColumnInd() {
    for (let k = 0; k < windowWidth; k++) {
        let off = k - caretLeft + 1
        let char = 0xBC
        if (off % 10 == 0) char = 0xB0 + (off/10|0)
        if (off == 1) char = 0xB0
        if (k == caretRight - 1) char = 0xBA
        if (off % 10 == 5) char = 0xBB
        if (off <= 0 || off > paintWidth) char = 0xBC
        if (off - 1 == cursorCol) char += 16

        con.mvaddch(2, PAINT_START_X + off - 1, char)
    }
}

function drawCmdbuf() {
    con.move(windowHeight, 2)
    for (let i = 2; i <= windowWidth - 1; i++) {
        print(' ')
    }
    con.move(windowHeight, 2)
    print(editorModeLabel[editorMode])

    if (2 == editorMode) print(cmdbuf)
}

function drawMain() {
    con.curs_set(0)
    drawInit()
    con.color_pair(COL_TEXT, COL_BACK)

    drawMenubar()
    drawPRC()
    drawColumnInd()
    drawCmdbuf()

}


drawMain()
typesetAndPrint()
