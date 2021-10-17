sys.poke(-1299460, 4)

let off = -1300607 - (14*0x4F)
let char = [0,42,85,62,65,85,65,81,93,65,62,0,0,0]
for (let i = 0; i < char.length; i++) {
    sys.poke(off - i, char[i])
}

// check if things are copied well
for (let k = 0; k < 14*128; k += 14) {
    let c = (k / 14)|0
    let x = 7 * ((c % 16)|0)
    let y = 14 * ((c / 16)|0)

    for (let l = 0; l < 14; l++) {
        let byte = sys.peek(-1300607 - k - l)
        for (let b = 0; b < 7; b++) {
            let px = 239 * ((byte >> (6 - b)) & 1)
            graphics.plotPixel(200+x+b, 200+y+l, px)
        }
    }
}


sys.poke(-1299460, 6)

for (let y=0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
        con.addch(y*16+x)
        con.curs_right()
    }
    println()
}