
let infile = sys.malloc(752704)
let imagearea = sys.malloc(560*448*3)

con.clear()

for (let f = 1; f <= 52; f++) {
    let fname = `/movtestimg/${(''+f).padStart(3,'0')}.jpg`
    filesystem.open("A", fname, "R")
    let fileLen = filesystem.getFileLen("A")
    dma.comToRam(0, 0, infile, fileLen)

    graphics.decodeImageTo(infile, fileLen, imagearea)

    graphics.imageToDisplayableFormat(imagearea, -1048577, 560, 448, 3, 2)

}

sys.free(imagearea)
sys.free(infile)