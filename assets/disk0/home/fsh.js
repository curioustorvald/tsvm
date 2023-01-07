graphics.setBackground(2,1,3);
graphics.resetPalette();

function captureUserInput() {
    sys.poke(-40, 1);
}

function getKeyPushed(keyOrder) {
    return sys.peek(-41 - keyOrder);
}

let _fsh = {};
_fsh.titlebarTex = new GL.Texture(2, 14, base64.atob("/u/+/v3+/f39/f39/f39/f39/P39/Pz8/Pv7+w=="));
_fsh.scrdim = con.getmaxyx();
_fsh.scrwidth = _fsh.scrdim[1];
_fsh.scrheight = _fsh.scrdim[0];
_fsh.brandName = "f\xb3Sh";
_fsh.brandLogoTexSmall = new GL.Texture(24, 14, gzip.decomp(base64.atob(
"H4sIAAAAAAAAAPv/Hy/4Qbz458+fIeILQQBIwoSh6qECuMVBukCmIJkDVQ+RQNgLE0MX/w+1lyhxqIUwTLJ/sQMAcIXsbVABAAA="
)));
_fsh.scrlayout = ["com.fsh.clock","com.fsh.calendar","com.fsh.todo_list", "com.fsh.quick_access"];

_fsh.drawWallpaper = function() {
    let wp = files.open("A:/home/wall.bytes")
//    filesystem.open("A", "/tvdos/wall.bytes", "R")
    let b = sys.malloc(250880)
//    dma.comToRam(0, 0, b, 250880)
    wp.pread(b, 250880, 0)
    dma.ramToFrame(b, 0, 250880)
    sys.free(b)
};

_fsh.drawTitlebar = function(titletext) {
    GL.drawTexPattern(_fsh.titlebarTex, 0, 0, 560, 14);
    if (titletext === undefined || titletext.length == 0) {
        con.move(1,1);
        print(" ".repeat(_fsh.scrwidth));
        GL.drawTexImageOver(_fsh.brandLogoTexSmall, 268, 0);
    }
    else {
        con.color_pair(240, 255);
        GL.drawTexPattern(_fsh.titlebarTex, 268, 0, 24, 14);
        con.move(1, 1 + (_fsh.scrwidth - titletext.length) / 2);
        print(titletext);
    }
    con.color_pair(254, 255);
};


_fsh.Widget = function(id, w, h) {
    this.identifier = id;
    this.width = w;
    this.height = h;

    if (!this.identifier) {
        this.identifier = "";
    }

    //this.update = function() {};
    /**
     * Params charXoff and charYoff are ZERO-BASED!
     */
    this.draw = function(charXoff, charYoff) {};
}

_fsh.widgets = {}
_fsh.registerNewWidget = function(widget) {
    _fsh.widgets[widget.identifier] = widget;
}

let clockWidget = new _fsh.Widget("com.fsh.clock", _fsh.scrwidth - 8, 7*2);
clockWidget.numberSheet = new GL.SpriteSheet(19, 22, new GL.Texture(190, 22, gzip.decomp(base64.atob(
"H4sIAAAAAAAAAMWVW3LEMAgE739aHcFJJV5ZMD2I9ToVfcl4GBr80HF8r/FaR1ozMuIyoUu87lEXI0al5qVR5AebSwchSaNE6Nyo1Nw5HXF3SfPT4Bshl"+
"EycA8RD96mLlHbuhTgOrfLnUDZspafbSQWk56WEGvQEtWaWwgb8iz7a8AOXhsraO/q9Qw2/GnXovfVN+q2wM/p/oddn2cjF239GX3y11+SWCtc6FTHC1v"+
"TVPkDPWWn0w+DDz93UX9v9mF5KIsQ6OdN2KJoB4ui1bXXr0AMp0YfiQo//4XhpK8555dsNehAqVS5uhb5iHn3Kko769J59KmLBe/TSR7hcsd+hr+HnrwR"+
"9uvRF9+D3MP14gN7lqx+8OuNT+uqt3NFX3SN9fTbeeHNq+C29pRWzX5+Rcm7SZyjOKJ/2hkSPqul4xN279DrSYvCrNu2NI7ZMp1ouBxK3KBVVnEeAUWbK"+
"MUDn5DPsPxmUqHZQjGpy2hergM3EVBAAAA=="
))));

clockWidget.clockColon = new GL.Texture(4, 3, base64.atob("7+/v7+/v7+/v7+/v"));
clockWidget.monthNames = ["Spring", "Summer", "Autumn", "Winter"];
clockWidget.dayNames = ["Mondag  ", "Tysdag  ", "Midtveke", "Torsdag ", "Fredag  ", "Laurdag ", "Sundag  ", "Verddag "];
clockWidget.draw = function(charXoff, charYoff) {
    con.color_pair(254, 255);
    let xoff = charXoff * 7;
    let yoff = charYoff * 14 + 3;
    let timeInMinutes = ((sys.currentTimeInMills() / 60000)|0);
    let mins = timeInMinutes % 60;
    let hours = ((timeInMinutes / 60)|0) % 24;
    let ordinalDay = ((timeInMinutes / (60*24))|0) % 120;
    let visualDay = (ordinalDay % 30) + 1;
    let months = ((timeInMinutes / (60*24*30))|0) % 4;
    let dayName = ordinalDay % 7; // 0 for Mondag
    if (ordinalDay == 119) dayName = 7; // Verddag
    let years = ((timeInMinutes / (60*24*30*120))|0) + 125;
    // draw timepiece
    GL.drawSprite(clockWidget.numberSheet, (hours / 10)|0, 0, xoff, yoff, 1);
    GL.drawSprite(clockWidget.numberSheet, hours % 10, 0, xoff + 24, yoff, 1);
    GL.drawTexImage(clockWidget.clockColon, xoff + 48, yoff + 5, 1);
    GL.drawTexImage(clockWidget.clockColon, xoff + 48, yoff + 14, 1);
    GL.drawSprite(clockWidget.numberSheet, (mins / 10)|0, 0, xoff + 57, yoff, 1);
    GL.drawSprite(clockWidget.numberSheet, mins % 10, 0, xoff + 81, yoff, 1);
    // print month and date
    con.move(1 + charYoff, 17 + charXoff);
    print(clockWidget.monthNames[months]+" "+visualDay);
    // print year and dayname
    con.move(2 + charYoff, 17 + charXoff);
    print("\xE7"+years+" "+clockWidget.dayNames[dayName]);
};


let calendarWidget = new _fsh.Widget("com.fsh.calendar", (_fsh.scrwidth - 8) / 2, 7*6)
calendarWidget.dayLabels = [
    " 1  2  3  4  5  6  7 \xFA\xFA",
    " 8  9 10 11 12 13 14 \xFA\xFA",
    "15 16 17 18 19 20 21 \xFA\xFA",
    "22 23 24 25 26 27 28 \xFA\xFA",
    "29 30  1  2  3  4  5 \xFA\xFA",
    " 6  7  8  9 10 11 12 \xFA\xFA",
    "13 14 15 16 17 18 19 \xFA\xFA",
    "20 21 22 23 24 25 26 \xFA\xFA",
    "27 28 29 30  1  2  3 \xFA\xFA",
    " 4  5  6  7  8  9 10 \xFA\xFA",
    "11 12 13 14 15 16 17 \xFA\xFA",
    "18 19 20 21 22 23 24 \xFA\xFA",
    "25 26 27 28 29 30  1 \xFA\xFA",
    " 2  3  4  5  6  7  8 \xFA\xFA",
    " 9 10 11 12 13 14 15 \xFA\xFA",
    "16 17 18 19 20 21 22 \xFA\xFA",
    "23 24 25 26 27 28 29 30"
]
calendarWidget.seasonCols = [229,39,215,239,253]
calendarWidget.draw = function(charXoff, charYoff) {
    con.color_pair(254, 255)
    let xoff = charXoff * 7
    let yoff = charYoff * 14 + 3

    let timeInMinutes = ((sys.currentTimeInMills() / 60000)|0)
    let ordinalDay = ((timeInMinutes / (60*24))|0) % 120
    let offset = (119 == ordinalDay) ? 16 : (ordinalDay / 7)|0


    con.move(charYoff, charXoff)
    print("Mo Ty Mi To Fr La Su Ve")

    for (let i = -3; i <= 3; i++) {
        let lineOff = (offset + i + 17) % 17 // adding 17 to prevent mod-ing on negative number
        let line = calendarWidget.dayLabels[lineOff]
        let textCol = 0

        con.move(charYoff + 4 + i, charXoff)

        for (let x = 0; x <= 23; x++) {
            let paintingDayOrd = lineOff*7 + ((x/3)|0)
            if (x >= 21 && lineOff != 16) textCol = calendarWidget.seasonCols[4]
            else textCol = calendarWidget.seasonCols[(paintingDayOrd / 30)|0]

            // special colour for spaces between numbers
            if (x % 3 == 2) con.color_pair(255,255)
            // mark today
            else if (paintingDayOrd == ordinalDay && x < 21 || paintingDayOrd == 119 && ordinalDay == 119) con.color_pair(0,textCol)
            // paint normal day number with seasonal colour
            else con.color_pair(textCol,255)

            con.addch(line.charCodeAt(x))
            con.curs_right()
        }
    }
}

let todoWidget = new _fsh.Widget("com.fsh.todo_list", (_fsh.scrwidth - 8) / 2, 7*10)
todoWidget.todoList = [["Hello, world!", true]]
todoWidget.draw = function(charXoff, charYoff) {
    con.color_pair(254, 255)
    let xoff = charXoff * 7
    let yoff = charYoff * 14 + 3

    con.move(charYoff, charXoff)
    print("========== TODO ==========")

    for (let i = 0; i <= 12; i++) {
        let list = todoWidget.todoList[i] || ["Click to add", null]

        if (list[1] === null) con.color_pair(249, 255)
        else con.color_pair(254, 255)

        con.move(charYoff + i + 2, charXoff)
        con.addch((list[1] === null) ? 43 : (list[1]) ? 0x9F : 0x9E)

        if (i > todoWidget.todoList.length) {
            for (let k = 0; k < 24; k++) {
                con.mvaddch(charYoff + i + 2, charXoff + 2 + k, 95)
            }
        }
        else {
            con.move(charYoff + i + 2, charXoff + 2)
            print(`${list[0]}`)
        }
    }
}

let quickAccessWidget = new _fsh.Widget("com.fsh.quick_access", (_fsh.scrwidth - 8) / 2, 7*20)
quickAccessWidget.entries = [
    ["Files", "/tvdos/bin/explorer.js"],
    ["Editor", "/tvdos/bin/edit.js"],
    ["BASIC", "/tbas/basic.js"],
    ["DOS Shell", "/tvdos/bin/command.js /fancy"]
]
quickAccessWidget.draw = function(charXoff, charYoff) {
    con.color_pair(254, 255)
    let xoff = charXoff * 7
    let yoff = charYoff * 14 + 3

    con.move(charYoff, charXoff)
    print("====== QUICK ACCESS ======")

    for (let i = 0; i <= 21; i++) {
        let list = quickAccessWidget.entries[i] || ["Click to add", null]

        if (list[1] === null) con.color_pair(249, 255)
        else con.color_pair(254, 255)

        con.move(charYoff + i + 2, charXoff)
        con.addch((list[1] === null) ? 0xF9 : (list[1]) ? 7 : 0x7F)

        if (i > quickAccessWidget.entries.length) {
            for (let k = 0; k < 24; k++) {
                con.mvaddch(charYoff + i + 2, charXoff + 2 + k, 95)
            }
        }
        else {
            con.move(charYoff + i + 2, charXoff + 2)
            print(`${list[0]}`)
        }
    }
}


// change graphics mode and check if it's supported
graphics.setGraphicsMode(3)
if (graphics.getGraphicsMode() == 0) {
    printerrln("Insufficient VRAM")
    return 1
}

// register widgets
_fsh.registerNewWidget(clockWidget)
_fsh.registerNewWidget(calendarWidget)
_fsh.registerNewWidget(todoWidget)
_fsh.registerNewWidget(quickAccessWidget)

// screen init
con.color_pair(254, 255)
con.clear()
con.curs_set(0)
graphics.clearPixels(255)
graphics.clearPixels2(255)
graphics.setFramebufferScroll(0,0)
_fsh.drawWallpaper()
_fsh.drawTitlebar()


// TEST
con.move(2,1);
print("fSh is very much in-dev! Hit backspace to exit")

// TODO update for events: key down (updates some widgets), timer (updates clock and calendar widgets)
while (true) {
    captureUserInput();
    if (getKeyPushed(0) == 67) break;

    _fsh.widgets["com.fsh.clock"].draw(25, 3);
    _fsh.widgets["com.fsh.calendar"].draw(12, 8);
    _fsh.widgets["com.fsh.todo_list"].draw(10, 17);
    _fsh.widgets["com.fsh.quick_access"].draw(47, 8);

    sys.spin();sys.spin()
}

con.move(3,1);
con.color_pair(201,255);
print("cya!");

let konsht = 3412341241;
println(konsht);

let pppp = graphics.getCursorYX();
println(pppp.toString());