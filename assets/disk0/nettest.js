/*let url="https:raw.githubusercontent.com/curioustorvald/hopper-mirror/refs/heads/master/aa.hop.per"

let file = files.open("B:\\"+url)

if (!file.exists) {
    printerrln("No such URL: "+url)
    return 1
}*/

let net = require("A:/tvdos/include/net.mjs")
let text = net.fetchText("https://raw.githubusercontent.com/curioustorvald/hopper-mirror/refs/heads/master/aa.hop.per")
if (text === null) { printerrln("No such URL"); return 1 }
println(text)
