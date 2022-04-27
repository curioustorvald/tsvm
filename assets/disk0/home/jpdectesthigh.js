if (!exec_args[1]) {
    printerrln("Usage: jpdectesthigh image.jpg")
}

filesystem.open("A", exec_args[1], "R")

let status = com.getStatusCode(0)
let infile = undefined
if (0 != status) return status


let fileLen = filesystem.getFileLen("A")
println(`DMA reading ${fileLen} bytes from disk...`)
infile = sys.malloc(fileLen)
dma.comToRam(0, 0, infile, fileLen)


println("decoding")

// decode
const [imgw, imgh, imageData] = graphics.decodeImageResample(infile, fileLen, -1, -1)

println(`dim: ${imgw}x${imgh}`)
println(`converting to displayable format...`)

// convert colour
graphics.setGraphicsMode(4)
graphics.imageToDirectCol(imageData, -1048577, -1310721, imgw, imgh, 4, 0)

sys.free(imageData)
sys.free(infile)
