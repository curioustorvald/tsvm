println("JS Console");
var _cmdHistory = []; // zeroth element is the oldest
var _cmdHistoryScroll = 0; // 0 for outside-of-buffer, 1 for most recent
while (true) {
    print("JS> ");

    var _cmdbuf = "";

    while (true) {
        var key = con.getch();

        // printable chars
        if (key >= 32 && key <= 126) {
            var __sss = String.fromCharCode(key);
            _cmdbuf += __sss;
            print(__sss);
        }
        // backspace
        else if (key === 8 && _cmdbuf.length > 0) {
            _cmdbuf = _cmdbuf.substring(0, _cmdbuf.length - 1);
            print(String.fromCharCode(key));
        }
        // enter
        else if (key === 10 || key === 13) {
            println();
            try {
                println(eval(_cmdbuf));
            }
            catch (e) {
                println(e);
            }
            finally {
                if (_cmdbuf.trim().length > 0)
                    _cmdHistory.push(_cmdbuf);

                _cmdHistoryScroll = 0;
                break;
            }
        }
        // up arrow
        else if (key === 19 && _cmdHistory.length > 0 && _cmdHistoryScroll < _cmdHistory.length) {
            _cmdHistoryScroll += 1;

            // back the cursor in order to type new cmd
            var __xx = 0;
            for (__xx = 0; __xx < _cmdbuf.length; __xx++) print(String.fromCharCode(8));
            _cmdbuf = _cmdHistory[_cmdHistory.length - _cmdHistoryScroll];
            // re-type the new command
            print(_cmdbuf);

        }
        // down arrow
        else if (key === 20) {
            if (_cmdHistoryScroll > 0) {
                // back the cursor in order to type new cmd
                var __xx = 0;
                for (__xx = 0; __xx < _cmdbuf.length; __xx++) print(String.fromCharCode(8));
                _cmdbuf = _cmdHistory[_cmdHistory.length - _cmdHistoryScroll];
                // re-type the new command
                print(_cmdbuf);

                _cmdHistoryScroll -= 1;
            }
            else {
                // back the cursor in order to type new cmd
                for (__xx = 0; __xx < _cmdbuf.length; __xx++) print(String.fromCharCode(8));
                _cmdbuf = "";
            }
        }
    }
}