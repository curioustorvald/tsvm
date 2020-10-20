graphics.setBackground(3,3,3);
graphics.resetPalette();

function captureUserInput() {
    sys.poke(-40, 1);
}

function getKeyPushed(keyOrder) {
    return sys.peek(-41 - keyOrder);
}

var _fsh = {};
_fsh.titlebarTex = new GL.Texture(2, 14, base64.atob("/u/+/v3+/f39/f39/f39/f39/P39/Pz8/Pv7+w=="));
_fsh.scrdim = con.getmaxyx();
_fsh.scrwidth = _fsh.scrdim[1];
_fsh.scrheight = _fsh.scrdim[0];
_fsh.brandName = "f\xb3Sh";
_fsh.brandLogoTexSmall = new GL.Texture(24, 14, gzip.decomp(base64.atob(
"H4sIAAAAAAAAAPv/Hy/4Qbz458+fIeILQQBIwoSh6qECuMVBukCmIJkDVQ+RQNgLE0MX/w+1lyhxqIUwTLJ/sQMAcIXsbVABAAA="
)));
_fsh.scrlayout = ["com.fsh.clock","com.fsh.calendar","com.fsh.apps_n_files"];

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

var clockWidget = new _fsh.Widget("com.fsh.clock", _fsh.scrwidth - 8, 7);
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
    var xoff = charXoff * 7;
    var yoff = charYoff * 14 + 3;
    var timeInMinutes = ((sys.currentTimeInMills() / 60000)|0);
    var mins = timeInMinutes % 60;
    var hours = ((timeInMinutes / 60)|0) % 24;
    var ordinalDay = ((timeInMinutes / (60*24))|0) % 120;
    var visualDay = (ordinalDay % 30) + 1;
    var months = ((timeInMinutes / (60*24*30))|0) % 4;
    var dayName = ordinalDay % 7; // 0 for Mondag
    if (ordinalDay == 119) dayName = 7; // Verddag
    var years = ((timeInMinutes / (60*24*30*120))|0) + 125;
    // draw timepiece
    GL.drawSprite(clockWidget.numberSheet, (hours / 10)|0, 0, xoff, yoff);
    GL.drawSprite(clockWidget.numberSheet, hours % 10, 0, xoff + 24, yoff);
    GL.drawTexImage(clockWidget.clockColon, xoff + 48, yoff + 5);
    GL.drawTexImage(clockWidget.clockColon, xoff + 48, yoff + 14);
    GL.drawSprite(clockWidget.numberSheet, (mins / 10)|0, 0, xoff + 57, yoff);
    GL.drawSprite(clockWidget.numberSheet, mins % 10, 0, xoff + 81, yoff);
    // print month and date
    con.move(1 + charYoff, 17 + charXoff);
    print(clockWidget.monthNames[months]+" "+visualDay);
    // print year and dayname
    con.mvaddch(2 + charYoff, 17 + charXoff, 5);
    con.move(2 + charYoff, 18 + charXoff);
    print(years+" "+clockWidget.dayNames[dayName]);
};


// register widgets
_fsh.registerNewWidget(clockWidget);

// screen init
con.color_pair(254, 255);
con.clear();
con.curs_set(0);
_fsh.drawTitlebar();


// TEST
con.move(2,1);
print("Hit backspace to exit");
while (true) {
    captureUserInput();
    if (getKeyPushed(0) == 67) break;

    _fsh.widgets["com.fsh.clock"].draw(25, 2);
}

con.move(3,1);
con.color_pair(201,255);
print("cya!");

let konsht = 3412341241;
print(konsht);