let scroll = 0;
let textbuffer = ["The quick brown fox","jumps over a lazy dog 12345678901234567890", "Pack my box with", "five dozen liquor jugs", "The quick brown fox","jumps over a lazy dog 12345678901234567890", "Pack my box with", "five dozen liquor jugs"];
let cursorRow = 0;
let cursorCol = 0;
let exit = false;
let scene = -1; // -1: main, 0: filemenu, 1: editmenu , ...

let windowWidth = con.getmaxyx()[1];
let windowHeight = con.getmaxyx()[0];
let paintWidth = windowWidth - 4;
let paintHeight = windowHeight - 1;
let scrollPeek = Math.ceil((paintHeight / 7));

//const menubarItems = ["File","Edit","View"];
const menubarItems = [`^S${String.fromCharCode(221)}save`,`^X${String.fromCharCode(221)}exit`];
const menubarFile = ["New","Open","Save","Save as","Exit"];
const menubarEdit = ["Undo","Redo","Cut","Copy","Paste","Select All","Deselect"];
const menubarView = ["Go To Line"];
const menubarContents = [menubarFile, menubarEdit, menubarView];
const COL_TEXT = 252;
const COL_BACK = 255;
const COL_SUPERTEXT = 239;
const COL_DIMTEXT = 249;
const COL_LNUMBACK = 18;
const COL_LNUMFORE = 252;


function reset_status() {
    scroll = 0;
    textbuffer = [""];
    cursorRow = 0;
    cursorCol = 0;
}

function drawInit() {
    windowWidth = con.getmaxyx()[1];
    windowHeight = con.getmaxyx()[0];
    scrollPeek = Math.ceil((paintHeight / 6));
    paintWidth = windowWidth-4;
    paintHeight = windowHeight-2;
}

function drawMain() {
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
    con.color_pair(COL_LNUMFORE, COL_LNUMBACK);
    for (let y = 0; y <= paintHeight; y++) {
        con.move(y+2, 1);
        let lnum = scroll + y + 1;
        if (lnum >= 1000) print(`${lnum}`);
        else if (lnum >= 100) print(`${lnum} `);
        else if (lnum >= 10) print(` ${lnum} `);
        else print(`  ${lnum} `);
    }

    // print status line
    con.color_pair(COL_BACK, COL_TEXT);
    let lctxt = `${String.fromCharCode(25)}${cursorRow+1}:${cursorCol+1}`;
    for (let i = 0; i < lctxt.length; i++) {
        con.mvaddch(1, windowWidth- lctxt.length + i, lctxt.charCodeAt(i));
    }

    con.move(2,5); con.color_pair(COL_TEXT, COL_BACK);
}

function drawMenubarBase(index) {
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
    for(let x = 0; x < paintWidth; x++) {
        let charCode = (undefined === textbuffer[scroll + paintRow]) ? 0 : textbuffer[scroll + paintRow].charCodeAt(x)|0; // or-zero to convert NaN into 0
        con.mvaddch(2+paintRow, 5+x, charCode);
    }
}

function drawTextbuffer() {
    for (let k = 0; k < paintHeight; k++) {
        drawTextLine(k)
    }
    gotoText();
}

function displayBulletin(text) {
    let txt = text.substring(0, windowWidth - 10);
    con.move(windowHeight - 1, (windowWidth - txt.length) / 2);
    con.color_pair(COL_BACK, COL_TEXT);
    print(`[${txt}]`);
    con.color_pair(COL_TEXT, COL_BACK);
    gotoText();
}
function dismissBulletin() {
    drawTextLine(paintHeight - 1);
    gotoText();
}

function gotoText() {
    con.move(2 + cursorRow, 5 + cursorCol);
}

function hitCtrlS() {
    return (sys.peek(-41) == 47 && (sys.peek(-42) == 129 || sys.peek(-42) == 130));
}
function hitCtrlX() {
    return (sys.peek(-41) == 52 && (sys.peek(-42) == 129 || sys.peek(-42) == 130));
}
function hitAny() {
    return sys.peek(-41) != 0;
}

reset_status();
drawMain();
drawTextbuffer();

let keyDown = false;
while (!exit) {
    // capture keys down
    sys.poke(-40, 1);

    if (!keyDown) {
        if (hitAny()) keyDown = true;

        if (hitCtrlX()) {
            exit = true;
        }
        else if (hitCtrlS()) {
            displayBulletin("Wrote NaN lines");
        }
        else if (hitAny()) {
            dismissBulletin();
        }
    }

    sys.poke(-40, 1);
    if (keyDown && !hitAny()) {
        keyDown = false;
    }

    serial.println("keydown = "+keyDown);
}
