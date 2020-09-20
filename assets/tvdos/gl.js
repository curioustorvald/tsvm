/*
TVDOS Graphics Library

Has no affiliation with OpenGL by Khronos Group
 */

var GL = {};
GL.Tex = function(w, h, bytes) {
    this.width = w;
    this.height = h;
    this.texData = bytes;
};
GL.drawTexPattern = function(tex, x, y, width, height) {
    for (var yy = 0; yy < height; yy++) {
        for (var xx = 0; xx < width; xx++) {
            var tx = xx % tex.width;
            var ty = yy % tex.height;
            var c = tex.texData[ty * tex.width + tx];
            graphics.plotPixel(x + xx, y + yy, c);
        }
    }
};
GL.drawTexImage = function(tex, x, y) {
    GL.drawTexPattern(tex, x, y, tex.width, tex.height);
};
Object.freeze(GL);
