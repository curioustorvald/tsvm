/*
TVDOS Graphics Library

Has no affiliation with OpenGL by Khronos Group
 */

var GL = {};

// bytes should be able to handle both JSArray and Java ByteArray (toString = "[B")?
GL.Texture = function(w, h, bytes) {
    this.width = w;
    this.height = h;
    this.texData = bytes;

    if (!Array.isArray(bytes) && !bytes.toString().startsWith("[B")) {
        throw "Texture data is not an instance of array";
    }
};
GL.SpriteSheet = function(tilew, tileh, tex) {
    this.tileWidth = tilew;
    this.tileHeight = tileh;
    this.texture = tex;

    if (!tex instanceof GL.Texture) {
        throw "Texture is not an instance of GL.Texture";
    }

    this.getOffX = function(x) { // THIS, or: GL.SpriteSheet.prototype.getOffX
        var tx = this.tileWidth * x;
        if (tx + this.tileWidth > this.texture.width) throw "Sprite x-offset of "+tx+" is greater than sprite width "+this.texture.width;
        return tx;
    };

    this.getOffY = function(y) {
        var ty = this.tileHeight * y;
        if (ty + this.tileHeight > this.texture.height) throw "Sprite y-offset of "+ty+" is greater than sprite height "+this.texture.height;
        return ty;
    };
};
GL.drawTexPattern = function(texture, x, y, width, height) {
    for (var yy = 0; yy < height; yy++) {
        for (var xx = 0; xx < width; xx++) {
            var tx = xx % texture.width;
            var ty = yy % texture.height;
            var c = texture.texData[ty * texture.width + tx];
            graphics.plotPixel(x + xx, y + yy, c);
        }
    }
};
GL.drawTexPatternOver = function(texture, x, y, width, height) {
    for (var yy = 0; yy < height; yy++) {
        for (var xx = 0; xx < width; xx++) {
            var tx = xx % texture.width;
            var ty = yy % texture.height;
            var c = texture.texData[ty * texture.width + tx];
            if ((c & 255) != 255) {
                graphics.plotPixel(x + xx, y + yy, c);
            }
        }
    }
};
/*
 * Draws a texture verbatim - color of 255 will be written to the screen buffer
 */
GL.drawTexImage = function(texture, x, y) {
    GL.drawTexPattern(texture, x, y, texture.width, texture.height);
};
/*
 * Draws texture with blitting - color of 255 will pass-thru what's already on the screen buffer
 */
GL.drawTexImageOver = function(texture, x, y) {
    for (var ty = 0; ty < texture.height; ty++) {
        for (var tx = 0; tx < texture.width; tx++) {
            var c = texture.texData[ty * texture.width + tx];
            if ((c & 255) != 255) {
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
            var c = sheet.texture.texData[(ty + offy) * sheet.texture.width + (tx + offx)];
            graphics.plotPixel(x + tx, y + ty, c);
        }
    }
};
GL.drawSpriteOver = function(sheet, xi, yi, x, y) {
    var offx = sheet.getOffX(xi);
    var offy = sheet.getOffY(yi);
    for (var ty = 0; ty < sheet.tileHeight; ty++) {
        for (var tx = 0; tx < sheet.tileWidth; tx++) {
            var c = sheet.texture.texData[(ty + offy) * sheet.texture.width + (tx + offx)];
            if ((c & 255) != 255) {
                graphics.plotPixel(x + tx, y + ty, c);
            }
        }
    }
};

Object.freeze(GL); // this returns frozen 'GL'
