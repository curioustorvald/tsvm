let scroll = 0;
let textbuffer = [""];
let cursorRow = 0;
let cursorCol = 0;

let windowSize = con.getmaxyx();
let paintWidth = windowSize[1]-4;
let paintHeight = windowSize[0]-2;
let scrollPeek = Math.ceil((paintHeight / 7));

const menubarItems = ["File","Edit","View"];
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

function redraw() {
    windowSize = con.getmaxyx();
    scrollPeek = Math.ceil((paintHeight / 6));
    paintWidth = windowSize[1]-4;
    paintHeight = windowSize[0]-2;

    con.clear();

    // print menubar
    con.color_pair(COL_BACK, COL_TEXT);
    menubarItems.forEach(v=>{
        print(" ");
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

redraw();