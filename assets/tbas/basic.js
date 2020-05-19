var vmemsize = 60300;
var vmemused = 0;
var cmdbuf = []; // index: line number
var prompt = "Ok";

var linenumRe = /^[0-9]+ +[^0-9]/;

println("Terran BASIC 1.0  "+vmemsize+" bytes free");
println(prompt);

var basicFunctions = new Object();
basicFunctions._basicList = function(v, i, arr) {
    if (i < 100) print(" ");
    print(i);
    print(" ");
    println(v);
};
basicFunctions.list = function(args) {
    if (args.length == 1) {
        cmdbuf.forEach(basicFunctions._basicList);
    }
    else if (args.length == 2) {
        if (typeof cmdbuf[args[1]] != "undefined")
            basicFunctions._basicList(cmdbuf[args[1]], args[1], undefined);
    }
    else {
        var lastIndex = (args[2] === ".") ? cmdbuf.length - 1 : (args[2] | 0);
        var i = 0;
        for (i = args[1]; i <= lastIndex; i++) {
            var cmd = cmdbuf[i];
            if (typeof cmd != "undefined") {
                basicFunctions._basicList(cmd, i, cmdbuf);
            }
        }
    }
};

while (true) {
    var line = vm.read();
    line = line.trim();

    if (linenumRe.test(line)) {
        var i = line.indexOf(" ");
        cmdbuf[line.slice(0, i)] = line.slice(i + 1, line.length);
    }
    else if (line.length > 0) {
        try {
            var cmd = line.split(" ");
            basicFunctions[cmd[0]](cmd);
        }
        catch (e) {
            println("Syntax error");
        }
        println(prompt);
    }
}