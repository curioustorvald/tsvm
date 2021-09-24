/*
TVDOS Graphics Library

Has no affiliation with OpenGL by Khronos Group
 */

const GL = {};

// bytes should be able to handle both JSArray and Java ByteArray (toString = "[B")?
GL.Texture = function(w, h, bytes) {
    this.width = w;
    this.height = h;
    this.texData = bytes;

    if (!Array.isArray(bytes) && !bytes.toString().startsWith("[B")) {
        throw "Texture data is not an instance of array";
    }
};
GL.MonoTex = function(w, h, bits) {
    this.width = w;
    this.height = h;
    this.texData = bits;

    if (!Array.isArray(bits) && !bits.toString().startsWith("[B")) {
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
GL.drawTexPattern = function(texture, x, y, width, height, fgcol, bgcol) {
    if (!(texture instanceof GL.Texture) && !(texture instanceof GL.MonoTex)) throw Error("Texture is not a GL Texture types");

    for (let yy = 0; yy < height; yy++) {
        for (let xx = 0; xx < width;) {
            let tx = xx % texture.width;
            let ty = yy % texture.height;
            if (texture instanceof GL.Texture) {
                let c = texture.texData[ty * texture.width + tx];
                graphics.plotPixel(x + xx, y + yy, c);
            }
            else if (texture instanceof GL.MonoTex) {
                let octet = texture.texData[ty * (texture.width >> 3) + (tx >> 3)];
                for (let i = 0; i < 8; i++) {
                    let bit = ((octet >>> (7 - i)) & 1 != 0)
                    graphics.plotPixel(x + xx + i, y + yy, bit ? bgcol : fgcol);
                }
            }

            xx += (texture instanceof GL.MonoTex) ? 8 : 1;
        }
    }
};
GL.drawTexPatternOver = function(texture, x, y, width, height, fgcol) {
    if (!(texture instanceof GL.Texture) && !(texture instanceof GL.MonoTex)) throw Error("Texture is not a GL Texture types");

    for (let yy = 0; yy < height; yy++) {
        for (let xx = 0; xx < width;) {
            let tx = xx % texture.width;
            let ty = yy % texture.height;
            if (texture instanceof GL.Texture) {
                if ((c & 255) != 255) {
                    let c = texture.texData[ty * texture.width + tx];
                    graphics.plotPixel(x + xx, y + yy, c);
                }
            }
            else if (texture instanceof GL.MonoTex) {
                let octet = texture.texData[ty * (texture.width >> 3) + (tx >> 3)];
                for (let i = 0; i < 8; i++) {
                    let bit = ((octet >>> (7 - i)) & 1 != 0)
                    if (bit) graphics.plotPixel(x + xx + i, y + yy, fgcol);
                }
            }

            xx += (texture instanceof GL.MonoTex) ? 8 : 1;
        }
    }
};
/*
 * Draws a texture verbatim - color of 255 will be written to the screen buffer
 */
GL.drawTexImage = function(texture, x, y, fgcol, bgcol) {
    GL.drawTexPattern(texture, x, y, texture.width, texture.height, fgcol, bgcol);
};
/*
 * Draws texture with blitting - color of 255 will pass-thru what's already on the screen buffer
 */
GL.drawTexImageOver = function(texture, x, y, fgcol) {
    GL.drawTexPatternOver(texture, x, y, texture.width, texture.height, fgcol);
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
