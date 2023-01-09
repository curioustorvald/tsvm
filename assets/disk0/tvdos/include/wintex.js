class WindowObject {

    constructor(x, y, w, h, inputProcessor, drawContents, title, drawFrame) {
        this.isHighlighted = false
        this.x = x
        this.y = y
        this.width = w
        this.height = h
        this.inputProcessorFun = inputProcessor
        this.drawContentsFun = drawContents
        this.title = title
        this.titleLeft = undefined
        this.titleRight = undefined
        this.titleBack = 0 // default value
        this.titleBackLeft = 245 // default value
        this.titleBackRight = 245 // default value
        this.drawFrameFun = drawFrame || (() => {
            let oldFore = con.get_color_fore()
            let oldBack = con.get_color_back()

            let charset = (this.isHighlighted) ? [0xC9, 0xBB, 0xC8, 0xBC, 0xCD, 0xBA, 0xB5, 0xC6] : [0xDA, 0xBF, 0xC0, 0xD9, 0xC4, 0xB3, 0xB4, 0xC3]
            let colour = (this.isHighlighted) ? 230 : 253
            let colourText = (this.isHighlighted) ? 230 : 254

            // set fore colour
            print(`\x1B[38;5;${colour}m`)

            // draw top horz
            con.mvaddch(this.y, this.x, charset[0]); con.curs_right()
            print(`\x84${charset[4]}u`.repeat(this.width - 2))
            con.addch(charset[1])
            // draw vert
            for (let yp = this.y + 1; yp < this.y + this.height - 1; yp++) {
                con.mvaddch(yp, this.x , charset[5])
                con.mvaddch(yp, this.x + this.width - 1, charset[5])
            }
            // draw bottom horz
            con.mvaddch(this.y + this.height - 1, this.x, charset[2]); con.curs_right()
            print(`\x84${charset[4]}u`.repeat(this.width - 2))
            con.addch(charset[3])

            // draw title
            if (this.title !== undefined) {
                let tt = ''+this.title
                con.move(this.y, this.x + ((this.width - 2 - tt.length) >>> 1))
                if (this.titleBack !== undefined) print(`\x1B[48;5;${this.titleBack}m`)
                print(`\x84${charset[6]}u`)
                print(`\x1B[38;5;${colourText}m${tt}`)
                print(`\x1B[38;5;${colour}m\x84${charset[7]}u`)
                if (this.titleBack !== undefined) print(`\x1B[48;5;${oldBack}m`)
            }
            if (this.titleLeft !== undefined) {
                let tt = ''+this.titleLeft
                con.move(this.y, this.x)
                print(`\x84${charset[0]}u`)
                if (this.titleBackLeft !== undefined) print(`\x1B[48;5;${this.titleBackLeft}m`)
                print(`\x1B[38;5;${colourText}m`);print(tt)
                if (this.titleBackLeft !== undefined) print(`\x1B[48;5;${oldBack}m`)
                print(`\x1B[38;5;${colour}m`);print(`\x84${charset[4]}u`)
            }
            if (this.titleRight !== undefined) {
                let tt = ''+this.titleRight
                con.move(this.y, this.x + this.width - tt.length - 2)
                print(`\x84${charset[4]}u`)
                if (this.titleBackRight !== undefined) print(`\x1B[48;5;${this.titleBackRight}m`)
                print(`\x1B[38;5;${colourText}m${tt}`)
                if (this.titleBackRight !== undefined) print(`\x1B[48;5;${oldBack}m`)
                print(`\x1B[38;5;${colour}m\x84${charset[1]}u`)
            }


            // restore fore colour
            print(`\x1B[38;5;${oldFore}m`)
            print(`\x1B[48;5;${oldBack}m`)
        })
    }

    drawContents() { this.drawContentsFun(this) }
    drawFrame() { this.drawFrameFun(this) }
    processInput(event) { this.inputProcessor(this, event) }

}

exports = { WindowObject }
