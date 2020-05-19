println("JS Console");
var cmdHistory = []; // zeroth element is the oldest
var cmdHistoryScroll = 0; // 0 for outside-of-buffer, 1 for most recent
while (true) {
    print("JS> ");

    var cmdbuf = "";

    while (true) {
        var key = vm.readKey();

        // printable chars
        if (key >= 32 && key <= 126) {
            var s = String.fromCharCode(key);
            cmdbuf += s;
            print(s);
        }
        // backspace
        else if (key === 8 && cmdbuf.length > 0) {
            cmdbuf = cmdbuf.substring(0, cmdbuf.length - 1);
            print(String.fromCharCode(key));
        }
        // enter
        else if (key === 10 || key === 13) {
            println();
            try {
                println(eval(cmdbuf));
            }
            catch (e) {
                println(e);
            }
            finally {
                if (cmdbuf.trim().length > 0)
                    cmdHistory.push(cmdbuf);

                cmdHistoryScroll = 0;
                break;
            }
        }
        // up arrow
        else if (key === 19 && cmdHistory.length > 0 && cmdHistoryScroll < cmdHistory.length) {
            cmdHistoryScroll += 1;

            // back the cursor in order to type new cmd
            for (xx = 0; xx < cmdbuf.length; xx++) print(String.fromCharCode(8));
            cmdbuf = cmdHistory[cmdHistory.length - cmdHistoryScroll];
            // re-type the new command
            print(cmdbuf);

        }
        // down arrow
        else if (key === 20) {
            if (cmdHistoryScroll > 0) {
                // back the cursor in order to type new cmd
                for (xx = 0; xx < cmdbuf.length; xx++) print(String.fromCharCode(8));
                cmdbuf = cmdHistory[cmdHistory.length - cmdHistoryScroll];
                // re-type the new command
                print(cmdbuf);

                cmdHistoryScroll -= 1;
            }
            else {
                // back the cursor in order to type new cmd
                for (xx = 0; xx < cmdbuf.length; xx++) print(String.fromCharCode(8));
                cmdbuf = "";
            }
        }
    }
}