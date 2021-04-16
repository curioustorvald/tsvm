// Loose reconstruction of the home screen of the Kyotronic 85/TRS-80 Model 100/etc.

let menu = [
    {label:"BASIC",pwd:"\\",exec:"basic",args:""},
    {label:"DOS",pwd:"\\",exec:"command",args:""},
    {label:"TEXT",pwd:"\\home",exec:"edit",args:""},
    {label:"TELCOM",pwd:"\\home",exec:"undefined",args:""}
];

const MENU_COLS = 4;
const MENU_ROWS = 6;
const COL_SIZE = 10;

function redraw() {
    con.clear();
    for (let i = 0; i < MENU_COLS*MENU_ROWS; i++) {
        let m = menu[i];
        con.move(2+((i / MENU_COLS)|0),2+((i % MENU_COLS)*COL_SIZE));
        print(m ? m.label : "-.-");
    }
}

redraw();