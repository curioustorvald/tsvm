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
/*
 * Draws a texture verbatim - color of 255 will be written to the screen buffer
 */
GL.drawTexImage = function(tex, x, y) {
    GL.drawTexPattern(tex, x, y, tex.width, tex.height);
};
/*
 * Draws texture with blitting - color of 255 will pass-thru what's already on the screen buffer
 */
GL.drawTexImageOver = function(tex, x, y) {
    for (var ty = 0; ty < tex.height; ty++) {
        for (var tx = 0; tx < tex.width; tx++) {
            var c = tex.texData[ty * tex.width + tx];
            if (c != 255) {
                graphics.plotPixel(x + tx, y + ty, c);
            }
        }
    }
};
Object.freeze(GL);
