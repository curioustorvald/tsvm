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
let stubHead = "let x="+memsize+";"+
"let a=()=>sys.print(String.fromCharCode(sys.peek(t)));"+
"let k=(b)=>sys.poke(t,b);"+
"let b=()=>k(sys.readKey());"+
"let e=()=>sys.peek(t);"+
"let m=(a,b)=>Number((a-(Math.floor(a/b)*b)).toPrecision(8));"+
"let p=()=>{t=m(t+1,x)};"+
"let q=()=>{t=m(t-1,x)};"+
"let v=()=>k(m(e()+1,256));"+
"let w=()=>k(m(e()-1,256));"+
"let t="+nativePtr+";"
let translation = {
    62: "p();",
    60: "q();",
    43: "v();",
    45: "w();",
    46: "a();",
    44: "b();",
    91: "while(e()){",
    93: "}"
};
if (exec_args[1] === undefined) {
    printerrln("Usage: bf <path-to-BF-program>");
    return 1;
}
let bfprg = "";
try {
    let f = files.open(_G.shell.resolvePathInput(exec_args[1]).full);
    bfprg = f.sread();
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
    eval(tprg);
}
catch (e) {
    printerrln(e);
    return 1;
}
finally {
    sys.free(nativePtr);
}

return 0;