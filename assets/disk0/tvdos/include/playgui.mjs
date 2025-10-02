// Common GUI for media player
// Created by CuriousTorvald on 2025-09-30.

// Subtitle display functions
function clearSubtitleArea() {
    // Clear the subtitle area at the bottom of the screen
    // Text mode is 80x32, so clear the bottom few lines
    let oldFgColour = con.get_color_fore()
    let oldBgColour = con.get_color_back()

    con.color_pair(255, 255)  // transparent to clear

    // Clear bottom 4 lines for subtitles
    for (let row = 28; row <= 31; row++) {
        con.move(row, 1)
        for (let col = 1; col <= 80; col++) {
            print(" ")
        }
    }

    con.color_pair(oldFgColour, oldBgColour)
}

function getVisualLength(line) {
    // Calculate the visual length of a line excluding formatting tags
    let visualLength = 0
    let i = 0

    while (i < line.length) {
        if (i < line.length - 2 && line[i] === '<') {
            // Check for formatting tags and skip them
            if (line.substring(i, i + 3).toLowerCase() === '<b>' ||
                line.substring(i, i + 3).toLowerCase() === '<i>') {
                i += 3  // Skip tag
            } else if (i < line.length - 3 &&
                      (line.substring(i, i + 4).toLowerCase() === '</b>' ||
                       line.substring(i, i + 4).toLowerCase() === '</i>')) {
                i += 4  // Skip closing tag
            } else {
                // Not a formatting tag, count the character
                visualLength++
                i++
            }
        } else {
            // Regular character, count it
            visualLength++
            i++
        }
    }

    return visualLength
}

function displayFormattedLine(line) {
    // Parse line and handle <b> and <i> tags with colour changes
    // Default subtitle colour: yellow (231), formatted text: white (254)

    let i = 0
    let inBoldOrItalic = false

    // insert initial padding block
    con.color_pair(0, 255)
    con.prnch(0xDE)
    con.color_pair(231, 0)

    while (i < line.length) {
        if (i < line.length - 2 && line[i] === '<') {
            // Check for opening tags
            if (line.substring(i, i + 3).toLowerCase() === '<b>' ||
                line.substring(i, i + 3).toLowerCase() === '<i>') {
                con.color_pair(254, 0)  // Switch to white for formatted text
                inBoldOrItalic = true
                i += 3
            } else if (i < line.length - 3 &&
                      (line.substring(i, i + 4).toLowerCase() === '</b>' ||
                       line.substring(i, i + 4).toLowerCase() === '</i>')) {
                con.color_pair(231, 0)  // Switch back to yellow for normal text
                inBoldOrItalic = false
                i += 4
            } else {
                // Not a formatting tag, print the character
                print(line[i])
                i++
            }
        } else {
            // Regular character, print it
            print(line[i])
            i++
        }
    }

    // insert final padding block
    con.color_pair(0, 255)
    con.prnch(0xDD)
    con.color_pair(231, 0)
}

function displaySubtitle(text, position = 0) {
    if (!text || text.length === 0) {
        clearSubtitleArea()
        return
    }

    // Set subtitle colours: yellow (231) on black (0)
    let oldFgColour = con.get_color_fore()
    let oldBgColour = con.get_color_back()
    con.color_pair(231, 0)

    // Split text into lines
    let lines = text.split('\n')

    // Calculate position based on subtitle position setting
    let startRow, startCol
    // Calculate visual length without formatting tags for positioning
    let longestLineLength = lines.map(s => getVisualLength(s)).sort().last()

    switch (position) {
        case 2: // center left
        case 6: // center right
        case 8: // dead center
            startRow = 16 - Math.floor(lines.length / 2)
            break
        case 3: // top left
        case 4: // top center
        case 5: // top right
            startRow = 2
            break
        case 0: // bottom center
        case 1: // bottom left
        case 7: // bottom right
        default:
            startRow = 31 - lines.length
            startRow = 31 - lines.length
            startRow = 31 - lines.length  // Default to bottom center
    }

    // Display each line
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim()
        if (line.length === 0) continue

        let row = startRow + i
        if (row < 1) row = 1
        if (row > 32) row = 32

        // Calculate column based on alignment
        switch (position) {
            case 1: // bottom left
            case 2: // center left
            case 3: // top left
                startCol = 1
                break
            case 5: // top right
            case 6: // center right
            case 7: // bottom right
                startCol = Math.max(1, 78 - getVisualLength(line) - 2)
                break
            case 0: // bottom center
            case 4: // top center
            case 8: // dead center
            default:
                startCol = Math.max(1, Math.floor((80 - longestLineLength - 2) / 2) + 1)
                break
        }

        con.move(row, startCol)

        // Parse and display line with formatting tag support
        displayFormattedLine(line)
    }

    con.color_pair(oldFgColour, oldBgColour)
}

function emit(c) {
    return "\x84"+c+"u"
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)

    return [hours, minutes, secs]
        .map(val => val.toString().padStart(2, '0'))
        .join(':')
}

function drawProgressBar(progress, width) {
    // Clamp progress between 0 and 1
    progress = Math.max(0, Math.min(1, progress));

    // Calculate position in "half-character" resolution
    const position = progress * width * 2;
    const charIndex = Math.floor(position / 2);
    const isRightHalf = (position % 2) >= 1;

    let bar = '';

    for (let i = 0; i < width; i++) {
        if (i == charIndex) {
            bar += isRightHalf ? '\xDE' : '\xDD';
        } else {
            bar += '\xC4';
        }
    }

    return bar;
}

/*
status = {
    videoRate: int,
    frameCount: int,
    totalFrames: int,
    fps: int,
    qY: int,
    akku: float,
    fileName: String,
    fileOrd: int,
    currentStatus: int (0: stop/init, 1: play, 2: pause),
    resolution: string,
    colourSpace: string
}

*/
function printBottomBar(status) {
    con.color_pair(253, 0)
    con.move(32, 1)

    const fullTimeInSec = status.totalFrames / status.fps
    const progress = status.frameCount / (status.totalFrames - 1)
    const elapsed = progress * fullTimeInSec
    const remaining = (1 - progress) * fullTimeInSec

    const BAR = '\xB3'
    const statIcon = [emit(0xFE), emit(0x10), emit(0x13)]
    let sLeft = `${emit(0x1E)}${status.fileOrd}${emit(0x1F)}${BAR}${statIcon[status.currentStatus]} `
    let sRate = `${BAR}${(''+((status.videoRate/128)|0)).padStart(6, ' ')}`
    let timeElapsed = formatTime(elapsed)
    let timeRemaining = formatTime(remaining)
    let barWidth = 80 - (sLeft.length - 8 - ((status.currentStatus == 0) ? 1 : 0) + timeElapsed.length + timeRemaining.length + sRate.length) - 2
    let bar = drawProgressBar(progress, barWidth)

    let s = sLeft + timeElapsed + ' ' + bar + ' ' + timeRemaining + sRate
    print(s);con.addch(0x4B)

    con.move(1, 1)
}

function printTopBar(status, moreInfo) {
    con.color_pair(253, 0)
    con.move(1)

    const BAR = '\xB3'

    if (moreInfo) {
        let filename = status.fileName.split("\\").pop()

        let sF = `F ${(''+status.frameCount).padStart((''+status.totalFrames).length, ' ')}/${status.totalFrames}`
        let sQ = `Q${(''+status.qY).padStart(4,' ')},${(''+status.qCo).padStart(2,' ')},${(''+status.qCg).padStart(2,' ')}`
        let sFPS = `${(status.frameCount / status.akku).toFixed(2)}f`
        let sRes = `${status.resolution}`
        let sCol = `${status.colourSpace}`

        let sLeft = sF + BAR + sQ + BAR + sFPS + BAR + sRes + BAR + sCol + BAR
        let filenameSpace = 80 - sLeft.length
        if (filename.length > filenameSpace) {
            filename = filename.slice(0, filenameSpace - 1) + '~'
        }
        let remainingSpc = filenameSpace - status.fileName.length
        let sRight = (remainingSpc > 0) ? ' '.repeat(filenameSpace - status.fileName.length + 3) : ''

        print(sLeft + filename + sRight)
    } else {
        let s = status.fileName
        if (s.length > 80) {
            s = s.slice(0, 79) + '~'
        }
        let spcs = 80 - s.length
        let spcsLeft = (spcs / 2)|0
        let spcsRight = spcs - spcsLeft
        print(' '.repeat(spcsLeft))
        print(s)
        print(' '.repeat(spcsRight))
    }

    con.move(1, 1)
}

exports = {
    clearSubtitleArea,
    displaySubtitle,
    printTopBar,
    printBottomBar
}