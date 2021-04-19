//const menubarItems = ["File","Edit","View"];
const menubarItems = [`^S${String.fromCharCode(221)}save`,`^X${String.fromCharCode(221)}exit`];
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
const BIG_STRIDE = 32;

let filename = undefined;

if (exec_args !== undefined && exec_args[1] !== undefined) {
    filename = exec_args[1];
}
else {
    println("File to edit?");
    filename = read();
}
let driveLetter = _G.shell.getCurrentDrive();
let filePath = _G.shell.getPwdString() + filename;

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
let editingExistingFile = filesystem.open(driveLetter, filePath, "R");
if (editingExistingFile) {
    textbuffer = filesystem.readAll(driveLetter).split("\n");
}

let windowWidth = con.getmaxyx()[1];
let windowHeight = con.getmaxyx()[0];
let paintWidth = windowWidth - PAINT_START_X + 1;
let paintHeight = windowHeight - PAINT_START_Y + 1;
let scrollPeek = Math.ceil((paintHeight / 7));
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
        if (lnum - 1 >= textbuffer.length) print('    ');
        else if (lnum >= 1000) print(`${lnum}`);
        else if (lnum >= 100) print(`${lnum} `);
        else if (lnum >= 10) print(` ${lnum} `);
        else print(`  ${lnum} `);
    }
}

function drawLnCol() {
    con.curs_set(0);
    con.color_pair(COL_BACK, COL_TEXT);
    let lctxt = `  ${String.fromCharCode(25)}${cursorRow+1}:${cursorCol+1}`;
    for (let i = 0; i < lctxt.length + (cursorCol < 9); i++) {
        con.mvaddch(1, windowWidth - lctxt.length + (cursorCol >= 9) + i, lctxt.charCodeAt(i));
    }
    con.color_pair(COL_TEXT, COL_BACK);
}

function drawMain() {
    con.curs_set(0);
    drawInit();
    con.clear();

    // print menubar
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
        print(" ");
    });
    // fill rest of the space on the line
    con.color_pair(COL_BACK, COL_TEXT);
    let cursPos = con.getyx();
    for (let i = cursPos[1]; i <= windowWidth; i++) {
        con.mvaddch(1, i, 0);
    }

    // print line number
    drawLineNumbers();

    // print status line
    drawLnCol();

    con.move(PAINT_START_Y, PAINT_START_X); con.color_pair(COL_TEXT, COL_BACK);
}

function drawMenubarBase(index) {
    con.curs_set(0);
    drawInit();
    con.clear();

    // print menubar
    con.color_pair(COL_BACK, COL_TEXT);
    menubarItems.forEach((v,i)=>{
        if (index == i) {
            con.color_pair(COL_TEXT, COL_BACK);
            print(String.fromCharCode(221));
            print(v);
            print(String.fromCharCode(222));
        }
        else {
            con.color_pair(COL_BACK, COL_TEXT);
            print(` ${v} `);
        }

    });
    // fill rest of the space on the line
    con.color_pair(COL_BACK, COL_TEXT);
    let cursPos = con.getyx();
    for (let i = cursPos[1]; i <= windowWidth; i++) {
        con.mvaddch(1, i, 0);
    }

    // print menu items
    let menuHeight = paintHeight - 1;
    menubarContents[index].forEach((v,i) => {
        con.color_pair(COL_TEXT, COL_BACK);

        con.move(3 + (i % menuHeight), 2 + 12 * ((i / menuHeight)|0));
        print(v);
    });
}

function drawTextLine(paintRow) {
    if (paintRow < 0 || paintRow >= paintHeight) return;
    let theRealLine = scroll + paintRow
    con.curs_set(0);
    con.color_pair(COL_TEXT, (theRealLine == cursorRow) ? COL_CARET_ROW : COL_BACK);

    for (let x = 0; x < paintWidth; x++) {
        let text = textbuffer[theRealLine];
        let charCode =
            // nonexisting text row
            (undefined === textbuffer[theRealLine]) ? 0 :
            // left scroll indicator
            (x == 0 && scrollHor > 0) ? 17 :
            // right scroll indicator
            (x == paintWidth - 1 && x + scrollHor + 1 < text.length) ? 16 :
            // plain text
            text.charCodeAt(x + scrollHor); // NaN will be returned for nonexisting char but con.addch will cast NaN into zero

        con.mvaddch(PAINT_START_Y + paintRow, PAINT_START_X + x, charCode);
    }
}

function drawTextbuffer() {
    for (let k = 0; k < paintHeight; k++) {
        drawTextLine(k)
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
    drawTextLine(paintHeight - 2);
    gotoText();
}

function gotoText() {
    con.move(PAINT_START_Y + cursorRow - scroll, PAINT_START_X + cursorCol - scrollHor);
    con.curs_set(1);
}


// FUNCTIONING FUNCTIONS (LOL) //

function writeout() {
    filesystem.open(driveLetter, filePath, "W");
    filesystem.write(driveLetter, textbuffer.join('\n'));
}

// KEYBOARDING FUNCTIONS //

function hitCtrlS() {
    sys.poke(-40, 1);
    return (sys.peek(-41) == 47 && (sys.peek(-42) == 129 || sys.peek(-42) == 130));
}
function hitCtrlX() {
    sys.poke(-40, 1);
    return (sys.peek(-41) == 52 && (sys.peek(-42) == 129 || sys.peek(-42) == 130));
}
function hitAny() {
    sys.poke(-40, 1);
    return sys.peek(-41) != 0;
}

function appendText(code) {
    if (textbuffer[cursorRow] === undefined)
        textbuffer[cursorRow] = String.fromCharCode(code);
    else {
        let s = textbuffer[cursorRow].substring(0);
        textbuffer[cursorRow] = s.substring(0, cursorCol) + String.fromCharCode(code) + s.substring(cursorCol);
    }
}

function appendLine() {
    //textbuffer.push("");
    let s1 = textbuffer[cursorRow].substring(0, cursorCol);
    let s2 = textbuffer[cursorRow].substring(cursorCol);
    textbuffer.splice(cursorRow, 1, s1, s2);

    // reset horizontal scroll before going to the next line
    scrollHor = 0;
    drawTextLine(cursorRow - scroll);

    // go to the next line
    cursorRow += 1;
    cursorCol = 0;
    cursoringCol = cursorCol;

    if (cursorRow >= windowHeight - scrollPeek) {
        scroll += 1;
        drawLineNumbers();
    }

    drawTextbuffer();
}

function backspaceOnce() {
    // delete a linebreak
    if (cursorCol == 0 && cursorRow > 0) {
        let s1 = textbuffer[cursorRow - 1];
        let s2 = textbuffer[cursorRow];
        textbuffer.splice(cursorRow - 1, 2, s1+s2);
        cursorMoveRelative(0,-1); cursorMoveRelative(Number.MAX_SAFE_INTEGER, 0); cursorHorAbsolute(s1.length);
    }
    // delete a character
    else if (cursorCol > 0) {
        let s = textbuffer[cursorRow].substring(0);
        textbuffer[cursorRow] = s.substring(0, cursorCol - 1) + s.substring(cursorCol);
        cursorMoveRelative(-1,0);
    }
}

// this one actually cares about the current scrolling stats
function cursorMoveRelative(odx, ody) {
    //gotoText(); // update cursor pos
    let cursorPos = con.getyx();

    let dx = odx + (cursoringCol - cursorCol);
    let dy = ody;
    let px = cursorPos[1] - PAINT_START_X; let py = cursorPos[0] - PAINT_START_Y;
    let nx = px + dx; let ny = py + dy;
    let oldScroll = scroll;
    let oldScrollHor = scrollHor;

    // clamp dx/dy
    if (cursorRow + dy > textbuffer.length - 1)
        dy = textbuffer.length - cursorRow;
    else if (cursorRow + dy < 0)
        dy = -cursorRow;

    // set new dx if destination col is outside of the line
    if (cursorCol + dx > textbuffer[cursorRow + dy].length)
        dx -= (cursorCol + dx) - textbuffer[cursorRow].length + 1
    else if (cursorCol + dx < 0)
        dx = -cursorCol;


    // move editor cursor
    cursorRow += dy;
    if (cursorRow < 0) cursorRow = 0;
    else if (cursorRow >= textbuffer.length) cursorRow = textbuffer.length - 1;

    let tlen = textbuffer[cursorRow].length;

    cursorCol += dx; cursoringCol = cursorCol;
    if (cursorCol < 0) cursorCol = 0;
    else if (cursorCol >= tlen + 1) cursorCol = tlen + 1;


    // update horizontal scroll stats
    if (dx != 0) {
        let stride = paintWidth - 1 - scrollHorPeek;

        if (nx > stride) {
            scrollHor += nx - stride;
            nx = stride;
        }
        else if (nx < 0 + scrollHorPeek) {
            scrollHor += nx - scrollHorPeek; // nx is less than zero
            nx = 1;

            // scroll to the left?
            if (scrollHor <= -1) {
                scrollHor = 0;
                nx = 0;
            }
        }
    }

    // update vertical scroll stats
    if (dy != 0) {
        let stride = paintHeight - 1 - scrollPeek;

        if (ny > stride) {
            scroll += ny - stride;
            ny = stride;
        }
        else if (ny < 0 + scrollPeek) {
            scroll += ny - scrollPeek; // ny is less than zero
            ny = 1;

            // scroll to the top?
            if (scroll <= -1) { // scroll of -1 would result to show "Line 0" on screen
                scroll = 0;
                ny = 0;
            }
        }
    }

    serial.println(`dY:${dy} nY:${ny} scrY:${scroll} row:${cursorRow} | wDim:${paintHeight}R ${paintWidth}C peek:${scrollPeek}`);

    // update screendraw
    if (oldScroll != scroll) {
        drawTextbuffer(); drawLineNumbers();
    }
    else if (oldScrollHor != scrollHor) {
        drawTextLine(ny);
    }
    // remove old caret highlights
    if (dy != 0 && COL_CARET_ROW !== undefined) {
        drawTextLine(cursorRow - dy);
        drawTextLine(cursorRow);
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
    drawTextLine(cursorRow - scroll);
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

while (!exit) {
    let key = con.getch();

    if (bulletinShown) dismissBulletin();

    if (key == 24) // Ctrl-X
        exit = true;
    else if (key == 19 && !bulletinShown) {
        writeout();
        displayBulletin(`Wrote ${textbuffer.length} lines`);
    }
    else if (key == con.KEY_BACKSPACE) { // Bksp
        backspaceOnce(); drawLnCol(); gotoText();
    }
    else if (key == con.KEY_RETURN) { // Return
        appendLine(); drawLineNumbers(); drawLnCol(); gotoText();
    }
    else if (key == con.KEY_LEFT) {
        cursorMoveRelative(-1,0);
    }
    else if (key == con.KEY_RIGHT) {
        cursorMoveRelative(1,0);
    }
    else if (key == con.KEY_UP) {
        cursorMoveRelative(0,-1);
    }
    else if (key == con.KEY_DOWN) {
        cursorMoveRelative(0,1);
    }
    else if (key == con.KEY_PAGE_UP) {
        cursorMoveRelative(0, -paintHeight + 1);
    }
    else if (key == con.KEY_PAGE_DOWN) {
        cursorMoveRelative(0, paintHeight - 1);
    }
    else if (key == con.KEY_HOME) {
        cursorMoveRelative(-BIG_STRIDE, 0);
    }
    else if (key == con.KEY_END)  {
        cursorMoveRelative(BIG_STRIDE, 0);
    }
    else if (key >= 32 && key < 128) { // printables (excludes \n)
        appendText(key); cursorMoveRelative(1,0); drawTextLine(cursorRow - scroll);
    }
}

con.clear();
return 0;