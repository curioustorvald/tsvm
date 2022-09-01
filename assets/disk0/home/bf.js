// exec_args: bf.js input_file optional_memsize
let memsize = exec_args[2]|0;
if (memsize <= 0) memsize = (sys.maxmem() < 30000) ? sys.maxmem()-256 : 30000;
let nativePtr = undefined;
try {
    nativePtr = sys.malloc(memsize);
}
catch (e) {
    printerrln("Could not allocate memory with size "+memsize);
    return 10;
}
let stubHead = "let mx="+memsize+";"+
"let fmod=function(a,b){return Number((a-(Math.floor(a/b)*b)).toPrecision(8));};"+
"let ip=function(){p=fmod(p+1,mx)};"+
"let dp=function(){p=fmod(p-1,mx)};"+
"let iv=function(){sys.poke(p,fmod(sys.peek(p)+1,256))};"+
"let dv=function(){sys.poke(p,fmod(sys.peek(p)-1,256))};"+
"let p="+nativePtr+";"
let translation = {
    62: "ip();",
    60: "dp();",
    43: "iv();",
    45: "dv();",
    46: "sys.print(String.fromCharCode(sys.peek(p)));",
    44: "sys.poke(p,sys.readKey());",
    91: "while(sys.peek(p)!=0){",
    93: "}"
};
if (exec_args[1] === undefined) {
    printerrln("Usage: bf <path-to-BF-program>");
    return 1;
}
let bfprg = "";
try {
    filesystem.open(_G.shell.getCurrentDrive(), exec_args[1], "R");
    bfprg = filesystem.readAll(_G.shell.getCurrentDrive());
}
catch(e) {
    printerrln(e);
    sys.free(nativePtr);
    return 1;
}
try {
    // translate
    let tprg = stubHead;
    for (let k = 0; k < bfprg.length; k++) {
        tprg += (translation[bfprg.charCodeAt(k)] || "");
    }

    // clear memory
    for (let k = 0; k < memsize; k++) {
        sys.poke(nativePtr+k, 0);
    }

    // run
    execApp(tprg);
}
catch (e) {
    printerrln(e);
    return 1;
}
finally {
    sys.free(nativePtr);
}

return 0;