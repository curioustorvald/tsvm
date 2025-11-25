if (!exec_args[1]) {
    printerrln("Usage: jpdectest image.jpg")
}

const fullFilePath = _G.shell.resolvePathInput(exec_args[1])
const file = files.open(fullFilePath.full)
const fileLen = file.size
const infile = sys.malloc(file.size); file.pread(infile, fileLen, 0)

//println("decoding")

// decode
const [imgw, imgh, channels, imageData] = graphics.decodeImageResample(infile, fileLen, -1, -1)

//println(`dim: ${imgw}x${imgh}`)
//println(`converting to displayable format...`)

// convert colour
graphics.setGraphicsMode(0)
graphics.imageToDisplayableFormat(imageData, -1048577, imgw, imgh, 4, 1)

sys.free(imageData)
sys.free(infile)
