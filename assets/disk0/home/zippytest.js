serial.println(typeof atob);

const inputstr =
'println("TERRAN Megatrends inc.");let p=0;let m=[[0,255,170,85,105,15,165,30,199,113,142,227,202,254,186,190],[255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255]];con.move(2,1),print("000 KB OK");try{for(;p<8<<20;){con.move(2,1);var x=""+(p+1>>10);print(x<10?"00"+x:x<100?"0"+x:x);for(var t=0;t<m.length;t++){for(var b=0;b<m[t].length;b++)if(sys.poke(p+b,m[t][b]),m[t][b]!=sys.peek(p+b))throw"Memory Error";for(var b=0;b<m[t].length;b++)if(sys.poke(p+b,255-m[t][b]),255-m[t][b]!=sys.peek(p+b))throw"Memory Error"}p+=m[0].length}}catch(t){"Memory Error"==t?println(" Memory Error"):println(" KB OK!")}var _BIOS={FIRST_BOOTABLE_PORT:[0,1]};Object.freeze(_BIOS);let n=0,s=0;for(;n<4&&(!com.areYouThere(n)||(com.sendMessage(n,"LOADBOOT"),s=com.getStatusCode(n),0!=s));)n+=1;n<4?eval(com.fetchResponse(n).trimNull()):printerrln("No bootable medium found.");';
serial.println(inputstr);


let inputbytes = [];

for (let i = 0; i < inputstr.length; i++) {
    inputbytes.push(inputstr.charCodeAt(i));
}

let compstr = gzip.comp(inputbytes);


for (let i = 0; i < compstr.length; i++) {
    serial.print((compstr[i] & 255).toString(16).padStart(2,'0') + " ");
}