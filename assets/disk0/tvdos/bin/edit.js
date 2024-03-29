//const menubarItems = ["File","Edit","View"];
const menubarItems = [`^S${String.fromCharCode(221)}save`,`^Q${String.fromCharCode(221)}quit`];
const menubarFile = ["New","Open","Save","Save as","Exit"];
const menubarEdit = ["Undo","Redo","Cut","Copy","Paste","Select All","Deselect"];
const menubarView = ["Go To Line"];
const menubarContents = [menubarFile, menubarEdit, menubarView];
const COL_TEXT = 253;
const COL_BACK = 255;
const COL_SUPERTEXT = 239;
const COL_DIMTEXT = 249;
const COL_LNUMBACK = 18;
const COL_LNUMFORE = 253;
const COL_CARET_ROW = 81;
const PAINT_START_X = 5;
const PAINT_START_Y = 2;
const BIG_STRIDE = 10000;
const TAB_SIZE = 4;

let filename = undefined;

if (exec_args !== undefined && exec_args[1] !== undefined) {
    filename = exec_args[1];
}
else {
    println("File to edit?");
    filename = read();
}

let contentChanged = false;

let scroll = 0;
let scrollHor = 0;
let textbuffer = [""];
let cursorRow = 0;
let cursorCol = 0;
let exit = false;
let scene = -1; // -1: main, 0: filemenu, 1: editmenu , ...
let bulletinShown = false;
let cursoringCol = 0;

// load existing file if it's there
let file = files.open(`${_G.shell.resolvePathInput(filename).full}`)
let editingExistingFile = file.exists
if (editingExistingFile) {
    textbuffer = file.sread().split("\n")
}

let windowWidth = 0;
let windowHeight = 0;
let paintWidth = 0;
let paintHeight = 0;
let scrollPeek = 0;
function drawInit() {
    windowWidth = con.getmaxyx()[1];
    windowHeight = con.getmaxyx()[0];
    paintWidth = windowWidth - PAINT_START_X + 1;
    paintHeight = windowHeight - PAINT_START_Y + 1;
    scrollPeek = Math.ceil((paintHeight / 7));
}
const scrollHorPeek = 1; // to accommodate the scroll indicator

function reset_status() {
    textbuffer = [""];
    scroll = 0; scrollHor = 0;
    cursorRow = 0; cursorCol = 0; cursoringCol = cursorCol;
}

// DRAWING FUNCTIONS //

function drawLineNumbers() {
    con.curs_set(0);
    con.color_pair(COL_LNUMFORE, COL_LNUMBACK);
    for (let y = 0; y < paintHeight; y++) {
        con.move(y + PAINT_START_Y, 1);
        let lnum = scroll + y + 1;
        if (lnum < 1 || lnum - 1 >= textbuffer.length) print('    ');
        else if (lnum >= 10000) print(`${String.fromCharCode(64+lnum/10000)}${(""+lnum%10000).padStart(4,'0')}`);
        else if (lnum >= 1000) print(`${lnum}`);
        else if (lnum >= 100) print(`${lnum} `);
        else if (lnum >= 10) print(` ${lnum} `);
        else print(`  ${lnum} `);
    }
}

function drawLnCol() {
    con.curs_set(0);
    con.color_pair(COL_BACK, COL_TEXT);

    drawMenubarBase();

    let lctxt = `${String.fromCharCode(25)}${cursorRow+1}:${cursorCol+1}`;
    con.move(1, windowWidth - lctxt.length - 2); con.addch(222);
    con.curs_right(); con.addch(221);
    for (let i = 0; i < lctxt.length + (cursorCol < 9); i++) {
        con.curs_right(); con.addch(lctxt.charCodeAt(i));
    }
    con.color_pair(COL_TEXT, COL_BACK);
}

function drawMain() {
    con.curs_set(0);
    drawInit();
    con.clear();

//    printMenubarBase();

    // print line number
    drawLineNumbers();

    // print status line
    drawLnCol();

    con.move(PAINT_START_Y, PAINT_START_X); con.color_pair(COL_TEXT, COL_BACK);
}

function drawMenubarBase() {
    // print menubar
    con.move(1,1);
    con.color_pair(COL_BACK, COL_TEXT);
    menubarItems.forEach(v=>{
        print(String.fromCharCode(222));
        for (let i = 0; i < v.length; i++) {
            let c = v.charCodeAt(i);
            if (c >= 65 && c <= 90 || c == 94)
                con.color_pair(COL_TEXT, COL_BACK);
            else
                con.color_pair(COL_BACK, COL_TEXT);

            con.addch(c); con.curs_right();
        }
//        print(" ");
    });
    // fill rest of the space on the line with filename
    con.color_pair(COL_BACK, COL_TEXT);
    con.addch(222);con.curs_right();
    con.addch(221);con.curs_right();
    let cursPos = con.getyx();
    let filenameStr = (contentChanged) ? `${filename}*` : filename;
    for (let i = cursPos[1]; i < windowWidth; i++) {
        con.mvaddch(1, i, filenameStr.codePointAt(i-cursPos[1]));
    }
}

function drawTextLineAbsolute(rowNumber, paintOffsetX) {
    let paintRow = rowNumber - scroll;

    if (paintRow < 0 || paintRow >= paintHeight) return;
    con.curs_set(0);
    con.color_pair(COL_TEXT, (rowNumber == cursorRow) ? COL_CARET_ROW : COL_BACK);

    for (let x = 0; x < paintWidth; x++) {
        let text = textbuffer[rowNumber];
        if (rowNumber < textbuffer.length - 1) text += String.fromCharCode(254);
        let charCode =
            // nonexisting text row
            (undefined === textbuffer[rowNumber]) ? 0 :
            // left scroll indicator
            (x == 0 && paintOffsetX > 0) ? 17 :
            // right scroll indicator
            (x == paintWidth - 1 && x + paintOffsetX + 1 < text.length) ? 16 :
            // plain text
            text.charCodeAt(x + paintOffsetX); // NaN will be returned for nonexisting char but con.addch will cast NaN into zero

        con.mvaddch(PAINT_START_Y + paintRow, PAINT_START_X + x, charCode);
    }
}

function drawTextbuffer(from, toExclusive) {
    let lineStart = from || scroll;
    let lineEnd = toExclusive || scroll + paintHeight;
    for (let k = lineStart; k < lineEnd; k++) {
        drawTextLineAbsolute(k, (k == cursorRow) ? scrollHor : 0);
    }
    gotoText();
}

function displayBulletin(text) {
    con.curs_set(0);
    bulletinShown = true;
    let txt = text.substring(0, windowWidth - 10);
    con.move(windowHeight - 1, (windowWidth - txt.length) / 2);
    con.color_pair(COL_BACK, COL_TEXT);
    print(` ${txt} `);
    con.color_pair(COL_TEXT, COL_BACK);
    gotoText();
}
function dismissBulletin() {
    bulletinShown = false;
    drawTextLineAbsolute(scroll + paintHeight - 2, scrollHor);
    gotoText();
}

function gotoText() {
    con.move(PAINT_START_Y + cursorRow - scroll, PAINT_START_X + cursorCol - scrollHor);
    con.curs_set(1);
}


// FUNCTIONING FUNCTIONS (LOL) //

function setContentChanged(b) {
    contentChanged = b
}

function writeout() {
    file.swrite(textbuffer.join("\n"))
    setContentChanged(false)
}

// KEYBOARDING FUNCTIONS //

function hitCtrlS() {
    sys.poke(-40, 255);
    return (sys.peek(-41) == 47 && (sys.peek(-42) == 129 || sys.peek(-42) == 130));
}
function hitCtrlQ() {
    sys.poke(-40, 255);
    return (sys.peek(-41) == 45 && (sys.peek(-42) == 129 || sys.peek(-42) == 130));
}
function hitAny() {
    sys.poke(-40, 255);sys.spin();
    return sys.peek(-41) != 0;
}

function insertChar(character, row, col) {
    if (textbuffer[row] === undefined)
        textbuffer[row] = character;
    else {
        let s = textbuffer[row].substring(0);
        textbuffer[row] = s.substring(0, col) + character + s.substring(col);
    }
}

function appendLine() {
    //textbuffer.push("");
    let s1 = textbuffer[cursorRow].substring(0, cursorCol);
    let s2 = textbuffer[cursorRow].substring(cursorCol);
    textbuffer.splice(cursorRow, 1, s1, s2);

    // reset horizontal scroll before going to the next line
    scrollHor = 0;
    drawTextLineAbsolute(cursorRow, scrollHor);

    // go to the next line
    cursorRow += 1;
    cursorCol = 0;
    cursoringCol = cursorCol;

    if (cursorRow >= windowHeight - scrollPeek)
        scroll += 1;

    drawTextbuffer(); drawLineNumbers();
}

function backspaceOnce() {
    // delete a linebreak
    if (cursorCol == 0 && cursorRow > 0) {
        let s1 = textbuffer[cursorRow - 1];
        let s2 = textbuffer[cursorRow];
        textbuffer.splice(cursorRow - 1, 2, s1+s2);
        // move cursor and possibly scrollHor
        cursorMoveRelative(0,-1); cursorMoveRelative(Number.MAX_SAFE_INTEGER, 0);
        cursorHorAbsolute(s1.length);
        cursoringCol = cursorCol;
        // end of repositioning
        drawTextbuffer(cursorRow);
        drawLineNumbers();
    }
    // delete a character
    else if (cursorCol > 0) {
        let s = textbuffer[cursorRow].substring(0);
        textbuffer[cursorRow] = s.substring(0, cursorCol - 1) + s.substring(cursorCol);
        // identical to con.KEY_LEFT
        cursoringCol = cursorCol - 1;
        if (cursoringCol < 0) cursoringCol = 0;
        cursorMoveRelative(-1,0);
        // end of con.KEY_LEFT
        drawTextLineAbsolute(cursorRow, scrollHor);
    }
}

// this one actually cares about the current scrolling stats
function cursorMoveRelative(odx, ody) {
    //gotoText(); // update cursor pos

    let dx = odx;
    let dy = ody;
    let oldScroll = scroll;
    let oldScrollHor = scrollHor;

    // clamp dy
    if (cursorRow + dy > textbuffer.length - 1)
        dy = (textbuffer.length - 1) - cursorRow;
    else if (cursorRow + dy < 0)
        dy = -cursorRow;

    let nextRow = cursorRow + dy;
    let nextRowLen = textbuffer[nextRow].length;

    // clamp dx
    if (cursorCol + dx > nextRowLen)
        dx = (nextRowLen) - cursorCol;
    else if (cursorCol + dx < 0)
        dx = -cursorCol;

    let nextCol = cursorCol + dx;

    // set dx to the value that makes cursor to follow the minof(textlen, cursoringCol)
    if (cursoringCol != nextCol) {
        dx = Math.min(cursoringCol, nextRowLen) - cursorCol;
    }

    nextCol = cursorCol + dx;

    // update horizontal scroll stats
    if (dx != 0) {
        let visible = paintWidth - 1 - scrollHorPeek;

        if (nextCol - scrollHor > visible) {
            scrollHor = nextCol - visible;
        }
        else if (nextCol - scrollHor < 0 + scrollHorPeek) {
            scrollHor = nextCol - scrollHorPeek; // nextCol is less than zero
        }

        // NOTE: this scroll clamping is moved outside of go-left/go-right if-statements above because
        // vertical movements can disrupt horizontal scrolls as well due to the cursoringCol variable

        // scroll to the right?
        if (nextRowLen > paintWidth && scrollHor > nextRowLen - paintWidth + scrollHorPeek)
            // to prevent overscrolling that might happen after some complex navigation, AND
            // to make sure text cursor to be placed at the right end of the screen where "more line arrow"
            // goes which also makes editing field 1 character wider
            scrollHor = nextRowLen - paintWidth + scrollHorPeek;
        // scroll to the left? (order is important!)
        if (scrollHor <= -1 || nextRowLen < paintWidth - scrollHorPeek)
            scrollHor = 0;
    }

    // update vertical scroll stats
    if (dy != 0) {
        let visible = paintHeight - 1 - scrollPeek;

        if (nextRow - scroll > visible) {
            scroll = nextRow - visible;
        }
        else if (nextRow - scroll < 0 + scrollPeek) {
            scroll = nextRow - scrollPeek; // nextRow is less than zero
        }

        // NOTE: future-proofing here -- scroll clamping is moved outside of go-up/go-down
        // if-statements above because horizontal movements can disrupt vertical scrolls as well because
        // "normally" when you go right at the end of the line, you appear at the start of the next line

        // scroll to the bottom?
        if (textbuffer.length > paintHeight && scroll > textbuffer.length - paintHeight)
            // to make sure not show buncha empty lines
            scroll = textbuffer.length - paintHeight;
        // scroll to the top? (order is important!)
        if (scroll <= -1)
            scroll = 0; // scroll of -1 would result to show "Line 0" on screen
    }


    // move editor cursor
    cursorRow = nextRow;
    cursorCol = nextCol;


    //serial.println(`d ${dx} ${dy}; n ${nextCol} ${nextRow}; scr ${scrollHor} ${scroll}; R ${cursorRow} C ${cursorCol} | wDim:${paintHeight}R ${paintWidth}C peek:${scrollPeek}`);


    // update screendraw
    if (oldScroll != scroll) {
        drawTextbuffer(); drawLineNumbers();
    }
    // remove caret highlights and reset horizontal scrolling from the old line
    else if (dy != 0 || oldScrollHor != scrollHor) {
        drawTextLineAbsolute(cursorRow, scrollHor);
        if (dy != 0) drawTextLineAbsolute(cursorRow - dy, 0);
    }

    drawLnCol(); gotoText();
}

// will try to put the cursor at the right end of the screen as long as the text length is longer than the window width
function cursorHorAbsolute(pos) {
    let position = pos
    if (position > textbuffer[cursorRow].length) textbuffer[cursorRow].length;

    cursorCol = position;
    scrollHor = position - paintWidth + 2;
    if (scrollHor < 0) scrollHor = 0;
    drawTextLineAbsolute(cursorRow, scrollHor);
}

///////////////////////////////////////////////////////////////////////////////////////////////////

drawMain();
drawTextbuffer();

// show "welcome" message
if (!editingExistingFile)
    displayBulletin(`New File`);
else {
    drawLnCol();
    displayBulletin(`Read ${textbuffer.length} Lines`);
}

// if a key was held down when the app launched, wait for key to go up
while (1) {
    sys.poke(-40, 255);
    if (sys.peek(-41) == 0) break;
    sys.spin();
}

while (!exit) {
    input.withEvent(event => {
    let eventName = event[0]
    if (eventName == "key_down") {

    let keysym = event[1]
    let keycodes = [event[3],event[4],event[5],event[6],event[7],event[8],event[9],event[10]]
    let keycode = keycodes[0]

    if (bulletinShown) dismissBulletin();

    if (keysym == "q" && keycodes[1] == 129) // Ctrl-Q
        exit = true;
    else if (keysym == "s" && keycodes[1] == 129 && !bulletinShown) {
        writeout();
        drawLnCol();
        displayBulletin(`Wrote ${textbuffer.length} lines`);
    }
    else if (keycode == 67) { // Bksp
        setContentChanged(true)
        backspaceOnce();
        drawLnCol(); gotoText();
    }
    else if (keycode == 66) { // Return
        setContentChanged(true)
        appendLine(); drawLnCol(); gotoText();
    }
    else if (keysym == "<LEFT>") {
        cursoringCol = cursorCol - 1;
        if (cursoringCol < 0) cursoringCol = 0;
        cursorMoveRelative(-1,0);
    }
    else if (keysym == "<RIGHT>") {
        cursoringCol = cursorCol + 1;
        if (cursoringCol > textbuffer[cursorRow].length) cursoringCol = textbuffer[cursorRow].length;
        cursorMoveRelative(1,0);
    }
    else if (keysym == "<UP>") {
        cursorMoveRelative(0,-1);
    }
    else if (keysym == "<DOWN>") {
        cursorMoveRelative(0,1);
    }
    else if (keysym == "<PAGE_UP>") {
        cursorMoveRelative(0, -paintHeight + scrollPeek);
    }
    else if (keysym == "<PAGE_DOWN>") {
        cursorMoveRelative(0, paintHeight - scrollPeek);
    }
    else if (keysym == "<HOME>") {
        cursoringCol = 0;
        cursorMoveRelative(-BIG_STRIDE, 0);
    }
    else if (keysym == "<END>")  {
        cursoringCol = textbuffer[cursorRow].length;
        cursorMoveRelative(BIG_STRIDE, 0);
    }
    else if (keysym == "<TAB>") { // insert spaces appropriately
        setContentChanged(true)
        let tabsize = TAB_SIZE - (cursorCol % TAB_SIZE);

        for (let k = 0; k < tabsize; k++) {
            insertChar(32, cursorRow, cursorCol);
            // identical to con.KEY_RIGHT
            cursoringCol = cursorCol + 1;
            if (cursoringCol > textbuffer[cursorRow].length) cursoringCol = textbuffer[cursorRow].length;
            cursorMoveRelative(1,0);
            // end of con.KEY_RIGHT
        }
        drawTextLineAbsolute(cursorRow, scrollHor); drawLnCol(); gotoText();
    }
    else if (keysym.length == 1 || !keysym.startsWith("<")) { // printables (excludes \n)
        setContentChanged(true)
        insertChar(keysym, cursorRow, cursorCol);
        // identical to con.KEY_RIGHT
        cursoringCol = cursorCol + 1;
        if (cursoringCol > textbuffer[cursorRow].length) cursoringCol = textbuffer[cursorRow].length;
        cursorMoveRelative(1,0);
        // end of con.KEY_RIGHT
        drawTextLineAbsolute(cursorRow, scrollHor); drawLnCol(); gotoText();
    }

    }})
}

con.clear();
return 0;