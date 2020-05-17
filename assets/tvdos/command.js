var DOS_VERSION = "1.0";
var PROMPT_TEXT = ">";
var CURRENT_DRIVE = "A";

var shell_pwd = [""];

var welcome_text = "TSVM Disk Operating System, version " + DOS_VERSION;

function get_prompt_text() {
    return CURRENT_DRIVE + ":\\\\" + shell_pwd.join("\\\\") + PROMPT_TEXT;
}

function greet() {
    println(welcome_text);
    println();
}


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

println("Starting TVDOS...");

greet();

/*while (true) {
    print(get_prompt_text());
    var s = read();
    println();
    println("String read: " + s + "@");
}*/

println(vm.peek(-4093)); // expecting an odd number
vm.poke(-4093, 6);
for (i = 0; i < 4096; i++) {
    print(String.fromCharCode(vm.peek(-4097 - i)));
}
println();