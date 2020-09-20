graphics.setBackground(3,3,3);

var _fsh = {};
_fsh.titlebartex = new GL.Tex(2, 14, [254, 239, 254, 254, 253, 254, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253, 252, 253, 253, 252, 252, 252, 252, 251, 251, 251]);

GL.drawTexPattern(_fsh.titlebartex, 0, 0, 560, 14);

con.color_pair(254, 255);
con.clear();
con.curs_set(0);
