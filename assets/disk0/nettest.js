let url="http://localhost/testnet/test.txt"

let file = files.open("B:\\"+url)

if (!file.exists) {
    printerrln("No such URL: "+url)
    return 1
}

let text = file.sread()
println(text)
