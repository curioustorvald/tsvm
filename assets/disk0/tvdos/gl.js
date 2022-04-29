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
        let tx = this.tileWidth * (x|0);
        if (tx + this.tileWidth > this.texture.width) throw "Sprite x-offset of "+tx+" is greater than sprite width "+this.texture.width;
        return tx;
    };

    this.getOffY = function(y) {
        let ty = this.tileHeight * (y|0);
        if (ty + this.tileHeight > this.texture.height) throw "Sprite y-offset of "+ty+" is greater than sprite height "+this.texture.height;
        return ty;
    };
};
GL.drawTexPattern = function(texture, x, y, width, height, framebuffer, fgcol, bgcol) {
    if (!(texture instanceof GL.Texture) && !(texture instanceof GL.MonoTex)) throw Error("Texture is not a GL Texture types");

    let paint = (!framebuffer) ? graphics.plotPixel : graphics.plotPixel2
    for (let yy = 0; yy < height; yy++) {
        for (let xx = 0; xx < width;) {
            let tx = xx % texture.width;
            let ty = yy % texture.height;
            if (texture instanceof GL.Texture) {
                let c = texture.texData[ty * texture.width + tx];
                paint(x + xx, y + yy, c);
            }
            else if (texture instanceof GL.MonoTex) {
                let octet = texture.texData[ty * (texture.width >> 3) + (tx >> 3)];
                for (let i = 0; i < 8; i++) {
                    let bit = ((octet >>> (7 - i)) & 1 != 0)
                    paint(x + xx + i, y + yy, bit ? bgcol : fgcol);
                }
            }

            xx += (texture instanceof GL.MonoTex) ? 8 : 1;
        }
    }
};
GL.drawTexPatternOver = function(texture, x, y, width, height, framebuffer, fgcol) {
    if (!(texture instanceof GL.Texture) && !(texture instanceof GL.MonoTex)) throw Error("Texture is not a GL Texture types");

    let paint = (!framebuffer) ? graphics.plotPixel : graphics.plotPixel2
    for (let yy = 0; yy < height; yy++) {
        for (let xx = 0; xx < width;) {
            let tx = xx % texture.width;
            let ty = yy % texture.height;
            if (texture instanceof GL.Texture) {
                let c = texture.texData[ty * texture.width + tx];
                if ((c & 255) != 255) {
                    paint(x + xx, y + yy, c);
                }
            }
            else if (texture instanceof GL.MonoTex) {
                let octet = texture.texData[ty * (texture.width >> 3) + (tx >> 3)];
                for (let i = 0; i < 8; i++) {
                    let bit = ((octet >>> (7 - i)) & 1 != 0)
                    if (bit) paint(x + xx + i, y + yy, fgcol);
                }
            }

            xx += (texture instanceof GL.MonoTex) ? 8 : 1;
        }
    }
};
/*
 * Draws a texture verbatim - color of 255 will be written to the screen buffer
 */
GL.drawTexImage = function(texture, x, y, framebuffer, fgcol, bgcol) {
    GL.drawTexPattern(texture, x, y, texture.width, texture.height, framebuffer, fgcol, bgcol);
};
/*
 * Draws texture with blitting - color of 255 will pass-thru what's already on the screen buffer
 */
GL.drawTexImageOver = function(texture, x, y, framebuffer, fgcol) {
    GL.drawTexPatternOver(texture, x, y, texture.width, texture.height, framebuffer, fgcol);
};
/*
 * @param xi x-index in the spritesheet, ZERO-BASED INDEX
 * @param yi y-index in the spritesheet, ZERO-BASED INDEX
 * @param x x-position on the framebuffer where the sprite will be drawn
 * @param y y-position on the framebuffer where the sprite will be drawn
 * @param overrideFG if the value is set and the current pixel of the sheet is not 255, plots this colour instead
 * @param overrideBG if the value is set and the current pixel of the sheet is 255, plots this colour instead
 */
GL.drawSprite = function(sheet, xi, yi, x, y, framebuffer, overrideFG, overrideBG) {
    let paint = (!framebuffer) ? graphics.plotPixel : graphics.plotPixel2
    let offx = sheet.getOffX(xi);
    let offy = sheet.getOffY(yi);
    for (let ty = 0; ty < sheet.tileHeight; ty++) {
        for (let tx = 0; tx < sheet.tileWidth; tx++) {
            let c = sheet.texture.texData[(ty + offy) * sheet.texture.width + (tx + offx)];
            if ((c & 255) == 255)
                paint(x + tx, (y + ty)|0, (overrideBG !== undefined) ? overrideBG : c);
            else
                paint(x + tx, (y + ty)|0, (overrideFG !== undefined) ? overrideFG : c);
        }
    }
};
/*
 * @param xi x-index in the spritesheet, ZERO-BASED INDEX
 * @param yi y-index in the spritesheet, ZERO-BASED INDEX
 * @param x x-position on the framebuffer where the sprite will be drawn
 * @param y y-position on the framebuffer where the sprite will be drawn
 * @param overrideFG if the value is set and the current pixel of the sheet is not 255, plots this colour instead
 */
GL.drawSpriteOver = function(sheet, xi, yi, x, y, framebuffer, overrideFG) {
    let paint = (!framebuffer) ? graphics.plotPixel : graphics.plotPixel2
    let offx = sheet.getOffX(xi);
    let offy = sheet.getOffY(yi);
    for (let ty = 0; ty < sheet.tileHeight; ty++) {
        for (let tx = 0; tx < sheet.tileWidth; tx++) {
            let c = sheet.texture.texData[(ty + offy) * sheet.texture.width + (tx + offx)];
            if ((c & 255) != 255) {
                paint(x + tx, (y + ty)|0, overrideFG || c);
            }
        }
    }
};

Object.freeze(GL); // this returns frozen 'GL'
