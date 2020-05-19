function readConsoleInput() {
    var cmdbuf = "";
    var key = -1;
    while (key != 10 && key != 13) {
        key = vm.readKey();
        // printable chars
        if (key >= 32 && key <= 126) {
            var s = String.fromCharCode(key);
            cmdbuf += s;
            print(s);
        }
        // backspace
        else if (key == 8 && cmdbuf.length > 0) {
            cmdbuf = cmdbuf.substring(0, cmdbuf.length - 1);
            print(String.fromCharCode(key));
        }
        // up down key
        else if (key >= 19 && key <= 20) {
            return key;
        }
        // left right key
        else if (key >= 19 && key <= 20) {
            //
        }
    }
    return cmdbuf;
}

println("JS Console");
while (true) {
    print("JS> ");

    var cmdbuf = readConsoleInput();

    if (typeof cmdbuf == "string") {
        println();
        try {
            println(eval(cmdbuf));
        }
        catch (e) {
            println(e);
        }
    }
}