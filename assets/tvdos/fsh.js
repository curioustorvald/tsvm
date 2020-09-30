graphics.setBackground(3,3,3);

var _fsh = {};
_fsh.titlebarTex = new GL.Tex(2, 14, base64.atobarr("/u/+/v3+/f39/f39/f39/f39/P39/Pz8/Pv7+w=="));
_fsh.scrdim = con.getmaxyx();
_fsh.scrwidth = _fsh.scrdim[1];
_fsh.scrheight = _fsh.scrdim[0];
_fsh.brandName = "f\xb3Sh";
_fsh.brandLogoTexSmall = new GL.Tex(24, 14, base64.atobarr("///////////////////////////////////////////z///////////////////////////////z///////////////////////z8/Pz///z////8/Pz8/Pz8/P///////Pz///////z///z8///////8/P///////Pz///////z///z8///////8/Pz8/P/8/Pz8/Pz///z////8/Pz////8/P///Pz//Pz///////z///////z8///8/P///Pz//Pz///////z////////8/P/8/P///Pz//Pz///////z////////8/P/8/P///Pz//Pz///////z///z8/Pz8///8/P///Pz///////////z///////////////////////////////z////////////////////////////////////////////////////"));

_fsh.drawTitlebar = function(titletext) {
    GL.drawTexPattern(_fsh.titlebarTex, 0, 0, 560, 14);
    if (titletext === undefined || titletext.length == 0) {
        con.move(1,1);
        print(" ".repeat(_fsh.scrwidth));
        GL.drawTexImageOver(_fsh.brandLogoTexSmall, 268, 0);
    }
    else {
        con.color_pair(240, 255);//         vvv this number must be even
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
