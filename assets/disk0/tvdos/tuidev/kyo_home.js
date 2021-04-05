// Loose reconstruction of the home screen of the Kyotronic 85/TRS-80 Model 100/etc.

let menu = [
    {label:"BASIC",pwd:"\\",exec:"basic",args:""},
    {label:"DOS",pwd:"\\",exec:"command",args:""},
    {label:"TEXT",pwd:"\\home",exec:"undefined",args:""},
    {label:"TELCOM",pwd:"\\home",exec:"undefined",args:""}
];

const MENU_COLS = 4;

function redraw() {
    con.clear();
    for (let i = 0; i < MENU_COLS*6; i++) {
        let m = menu[i];
        con.move(2+((i/MENU_COLS)|0),2+((i%MENU_COLS)*10));
        print(m ? m.label : "-.-");
    }
}

redraw();