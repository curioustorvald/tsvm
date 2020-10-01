/*
TVDOS Graphics Library

Has no affiliation with OpenGL by Khronos Group
 */

var GL = {};

GL.Tex = function(w, h, bytes) {
    this.width = w;
    this.height = h;
    this.texData = bytes;

    if (!Array.isArray(bytes)) {
        throw "Texture data is not an instance of array";
    }
};
GL.SpriteSheet = function(tilew, tileh, tex) {
    this.tileWidth = tilew;
    this.tileHeight = tile;
    this.texture = tex;

    if (!tex instanceof GL.Tex) {
        throw "Texture is not an instance of GL.Tex";
    }

    this.getOffX = function(x) { // THIS, or: GL.SpriteSheet.prototype.getOffX
        var tx = tileWidth * x;
        if (tx + tileWidth > tex.width) throw "Sprite x-offset of "+tx+" is greater than sprite width "+tex.width;
        return tx;
    };

    this.getOffY = function(y) {
        var ty = tileHeight * y;
        if (ty + tileHeight > tex.height) throw "Sprite y-offset of "+ty+" is greater than sprite height "+tex.height;
        return ty;
    };
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
GL.drawTexPatternOver = function(tex, x, y, width, height) {
    for (var yy = 0; yy < height; yy++) {
        for (var xx = 0; xx < width; xx++) {
            var tx = xx % tex.width;
            var ty = yy % tex.height;
            var c = tex.texData[ty * tex.width + tx];
            if (c != 255) {
                graphics.plotPixel(x + xx, y + yy, c);
            }
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
GL.drawSprite = function(sheet, xi, yi, x, y) {
    var offx = sheet.getOffX(xi);
    var offy = sheet.getOffY(yi);
    for (var ty = 0; ty < sheet.tileHeight; ty++) {
        for (var tx = 0; tx < sheet.tileWidth; tx++) {
            var c = sheet.tex.texData[(ty + offy) * tex.width + (tx + offx)];
            graphics.plotPixel(x + tx, y + ty, c);
        }
    }
};
GL.drawSpriteOver = function(sheet, xi, yi, x, y) {
    var offx = sheet.getOffX(xi);
    var offy = sheet.getOffY(yi);
    for (var ty = 0; ty < sheet.tileHeight; ty++) {
        for (var tx = 0; tx < sheet.tileWidth; tx++) {
            var c = sheet.tex.texData[(ty + offy) * tex.width + (tx + offx)];
            if (c != 255) {
                graphics.plotPixel(x + tx, y + ty, c);
            }
        }
    }
};

Object.freeze(GL);
