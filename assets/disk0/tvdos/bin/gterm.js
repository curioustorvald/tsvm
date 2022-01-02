const SCRW = 560
const SCRH = 448
const CHARW = 7
const CHARH = 16
const ROWS = 28
const COLS = 80

const TITLEBAR_COL = 254
const TOOLBAR_COL = 64
const TOOLBAR_COL2 = 69

let isFileThere = filesystem.open("A", "/tvdos/bin/gfont.gz", "R")
if (isFileThere != 0) {
    printerrln("Main Font file not found")
    return isFileThere
}


const fontMainTexBytes = gzip.decomp(filesystem.readAll("A"))
const fontMainTex = new GL.Texture(CHARW*16, CHARH*16, fontMainTexBytes)
const fontMain = new GL.SpriteSheet(CHARW, CHARH, fontMainTex)

function drawInit() {
    con.reset_graphics();con.curs_set(0);con.clear();
    graphics.clearPixels(255);graphics.resetPalette();graphics.setFramebufferScroll(0,0);
    for(let i=0;i<SCRH;i++)graphics.setLineOffset(i,0)
}

function drawUI(scrollY) {
    for (let y = 0; y < CHARH; y++) for (let x = 0; x < SCRW; x++) graphics.plotPixel(x, (y+scrollY) % SCRH, TITLEBAR_COL)
    for (let y = 416; y < 432; y++) for (let x = 0; x < SCRW; x++) graphics.plotPixel(x, (y+scrollY) % SCRH, TOOLBAR_COL)
    for (let y = 432; y < 448; y++) for (let x = 0; x < SCRW; x++) graphics.plotPixel(x, (y+scrollY) % SCRH, TOOLBAR_COL2)
}

/*
 * @param codepoint unicode code point
 * @param col x-position of the character in the terminal, ONE-BASED INDEX
 * @param row y-position of the character in the terminal, ONE-BASED INDEX
 * @param bgcol background colour of the character
 * @param fgcol foreground colour of the character
 * @param scrollY `graphics.getFramebufferScroll()[1]`
 */
function paintGlyph(codepoint, col, row, bgcol, fgcol, scrollY) {
    let sheet = fontMain
    let xi = codepoint % 16
    let yi = codepoint / 16

    GL.drawSprite(sheet, xi, yi, CHARW*(col - 1), (CHARH*(row|0) + scrollY) % SCRH, fgcol, bgcol)
}


drawInit()
drawUI(graphics.getFramebufferScroll()[1])

let ttyFore = 252
let ttyBack = 255
let curs = 0

print = function(str) {
    if ((typeof str === 'string' || str instanceof String) && str.length > 0) {
        let scrollY = graphics.getFramebufferScroll()[1]
        let cp = unicode.utf8toCodepoints(str)
        for (let i = 0; i < cp.length; i++) {
            let c = cp[i]

            if (10 == c || 13 == c) {
                curs = (Math.ceil(curs / COLS)|0) * COLS
            }
            else {
                paintGlyph(c, 1+(curs % COLS), 1+(curs / COLS), ttyBack, ttyFore, scrollY)
                curs += 1
            }
        }
    }
}

// TODO basically port the GraphicsAdapter.kt into here

