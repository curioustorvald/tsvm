function hitCtrlQ(keys) {
    return (keys[0] == 45 && (keys[1] == 129 || keys[1] == 130));
}

println("Hit Ctrl+Shift+T+R to exit")

while (true) {
    input.withEvent(event => {
        println(event)
    })
}