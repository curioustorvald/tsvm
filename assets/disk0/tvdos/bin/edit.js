let scroll = 0;
let textbuffer = ["The quick brown fox","jumps over a lazy dog 12345678901234567890", "Pack my box with", "five dozen liquor jugs"];
let cursorRow = 0;
let cursorCol = 0;

let windowSize = con.getmaxyx();
let paintWidth = windowSize[1]-4;
let paintHeight = windowSize[0]-2;
let scrollPeek = Math.ceil((paintHeight / 7));

const menubarItems = ["File","Edit","View"];
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
    windowSize = con.getmaxyx();
    scrollPeek = Math.ceil((paintHeight / 6));
    paintWidth = windowSize[1]-4;
    paintHeight = windowSize[0]-2;
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
            if (c >= 65 && c <= 90)
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
    for (let i = cursPos[1]; i <= windowSize[1]; i++) {
        con.mvaddch(1, i, 0);
    }

    // print line number
    con.color_pair(COL_LNUMFORE, COL_LNUMBACK);
    for (let y = 2; y < windowSize[0]; y++) {
        con.move(y,1);
        let lnum = scroll+y-1;
        if (lnum >= 1000) print(`${lnum}`);
        else if (lnum >= 100) print(`${lnum} `);
        else if (lnum >= 10) print(` ${lnum} `);
        else print(`  ${lnum} `);
    }

    // print status line
    con.color_pair(COL_BACK, COL_TEXT);
    let statusMsg = ` Ln ${cursorRow+1} Col ${cursorCol+1}`;
    for (let x = 1; x <= windowSize[1]; x++) {
        con.mvaddch(windowSize[0], x, ""+statusMsg.charCodeAt(x-1));
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
    for (let i = cursPos[1]; i <= windowSize[1]; i++) {
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
    con.move(2 + cursorRow, 5 + cursorCol);
}

drawMenubarBase(0);
drawMain();
drawTextbuffer();
