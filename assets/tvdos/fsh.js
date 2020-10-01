graphics.setBackground(3,3,3);
graphics.resetPalette();

var _fsh = {};
_fsh.titlebarTex = new GL.Tex(2, 14, base64.atob("/u/+/v3+/f39/f39/f39/f39/P39/Pz8/Pv7+w=="));
_fsh.scrdim = con.getmaxyx();
_fsh.scrwidth = _fsh.scrdim[1];
_fsh.scrheight = _fsh.scrdim[0];
_fsh.brandName = "f\xb3Sh";
_fsh.brandLogoTexSmall = new GL.Tex(24, 14, base64.atob("//////////////////////////////////////////j///////////////////////////////j////////////////////////z8/P///j///+hoaGhof+hof////////Pz//////j//6Gh//////+hof////////Pz//////j//6Gh//////+hoaGhof//8/Pz8/P///j///+hoaH///+hof//oaH///Pz//////j//////6Gh//+hof//oaH///Pz//////j///////+hof+hof//oaH///Pz//////j///////+hof+hof//oaH///Pz//////j//6GhoaGh//+hof//oaH///////////j///////////////////////////////j/////////////////////////////////////////////////////"));

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


// screen init
con.color_pair(254, 255);
con.clear();
con.curs_set(0);
_fsh.drawTitlebar();
