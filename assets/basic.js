/*
NOTE: do not allow concatenation of commands!

Operators

; - When used by PRINT and INPUT, concatenates two printables; numbers will have one space between them while strings
    will not.
, - Function argument separator
+ - Just as in JS; concatenates two strings

Test Programs:

1 REM Random Maze
10 PRINT(CHR$(47+ROUND(RND(1))*45);)
20 GOTO 10

*/
if (system.maxmem() < 8192) {
    println("Out of memory. BASIC requires 8K or more User RAM");
    throw new Error("Out of memory");
}

let vmemsize = system.maxmem() - 5236;

let cmdbuf = []; // index: line number
let cmdbufMemFootPrint = 0;
let prompt = "Ok";

let lang = {};
lang.badNumberFormat = "Illegal number format";
lang.badOperatorFormat = "Illegal operator format";
lang.badFunctionCallFormat = "Illegal function call";
lang.unmatchedBrackets = "Unmatched brackets";
lang.missingOperand = "Missing operand";
lang.noSuchFile = "No such file";
lang.nextWithoutFor = function(line, varname) {
    return "NEXT "+((varname !== undefined) ? ("'"+varname+"'") : "")+"without FOR in "+line;
};
lang.syntaxfehler = function(line, reason) {
    return "Syntax error" + ((line !== undefined) ? (" in "+line) : "") + ((reason !== undefined) ? (": "+reason) : "");
};
lang.illegalType = function(line, obj) {
    return "Type mismatch" + ((obj !== undefined) ? " \"" + obj + "\"" : "") + ((line !== undefined) ? (" in "+line) : "");
 };
lang.refError = function(line, obj) {
    return "Unresolved reference" + ((obj !== undefined) ? " \"" + obj + "\"" : "") + ((line !== undefined) ? (" in "+line) : "");
};
lang.nowhereToReturn = function(line) { return "RETURN without GOSUB in " + line; };
lang.errorinline = function(line, stmt, errobj) {
    return 'Error'+((line !== undefined) ? (" in "+line) : "")+' on statement "'+stmt+'": '+errobj;
};
lang.parserError = function(line, errorobj) {
    return "Parser error in " + line + ": " + errorobj;
};
lang.outOfMem = function(line) {
    return "Out of memory in " + line;
};
lang.dupDef = function(line, varname) {
    return "Duplicate definition"+((varname !== undefined) ? (" on "+varname) : "")+" in "+line;
};
lang.asgnOnConst = function(line, constname) {
    return 'Trying to modify constant "'+constname+'" in '+line;
};
Object.freeze(lang);

let fs = {};
fs._close = function(portNo) {
    com.sendMessage(portNo, "CLOSE");
};
fs._flush = function(portNo) {
    com.sendMessage(portNo, "FLUSH");
};
// @return true if operation committed successfully, false if:
//             - opening file with R-mode and target file does not exists
//         throws if:
//             - java.lang.NullPointerException if path is null
//             - Error if operation mode is not "R", "W" nor "A"
fs.open = function(path, operationMode) {
    let port = _BIOS.FIRST_BOOTABLE_PORT;

    fs._flush(port[0]); fs._close(port[0]);

    let mode = operationMode.toUpperCase();
    if (mode != "R" && mode != "W" && mode != "A") {
        throw Error("Unknown file opening mode: " + mode);
    }

    com.sendMessage(port[0], "OPEN"+mode+'"'+path+'",'+port[1]);
    let response = com.getStatusCode(port[0]);
    return (response == 0);
};
// @return the entire contents of the file in String
fs.readAll = function() {
    let port = _BIOS.FIRST_BOOTABLE_PORT;
    com.sendMessage(port[0], "READ");
    let response = com.getStatusCode(port[0]);
    if (135 == response) {
        throw Error("File not opened");
    }
    if (response < 0 || response >= 128) {
        throw Error("Reading a file failed with "+response);
    }
    return com.pullMessage(port[0]);
};
fs.write = function(string) {
    let port = _BIOS.FIRST_BOOTABLE_PORT;
    com.sendMessage(port[0], "WRITE"+string.length);
    let response = com.getStatusCode(port[0]);
    if (135 == response) {
        throw Error("File not opened");
    }
    if (response < 0 || response >= 128) {
        throw Error("Writing a file failed with "+response);
    }
    com.sendMessage(port[0], string);
    fs._flush(port[0]); fs._close(port[0]);
};
Object.freeze(fs);

// implement your own con object here
// requirements: reset_graphics(), getch(), curs_set(int), hitterminate(), resetkeybuf(), addch(int)

let getUsedMemSize = function() {
    let varsMemSize = 0;

    Object.entries(bStatus.vars).forEach(function(pair,i) {
        let object = pair[1];

        if (Array.isArray(object)) {
            // TODO test 1-D array
            varsMemSize += object.length * 8;
        }
        else if (!isNaN(object)) varsMemSize += 8;
        else if (typeof object === "string" || object instanceof String) varsMemSize += object.length;
        else varsMemSize += 1;
    });
    return varsMemSize + cmdbufMemFootPrint; // + array's dimsize * 8 + variables' sizeof literal + functions' expression length
}

let reLineNum = /^[0-9]+ /;
//var reFloat = /^([\-+]?[0-9]*[.][0-9]+[eE]*[\-+0-9]*[fF]*|[\-+]?[0-9]+[.eEfF][0-9+\-]*[fF]?)$/;
//var reDec = /^([\-+]?[0-9_]+)$/;
//var reHex = /^(0[Xx][0-9A-Fa-f_]+)$/;
//var reBin = /^(0[Bb][01_]+)$/;

// must match partial
let reNumber = /([0-9]*[.][0-9]+[eE]*[\-+0-9]*[fF]*|[0-9]+[.eEfF][0-9+\-]*[fF]?)|([0-9_]+)|(0[Xx][0-9A-Fa-f_]+)|(0[Bb][01_]+)/;
//let reOps = /\^|;|\*|\/|\+|\-|[<>=]{1,2}/;

let reNum = /[0-9]+/;
let tbasexit = false;

println("Terran BASIC 1.0  "+vmemsize+" bytes free");
println(prompt);

// variable object constructor
/** variable object constructor
 * @param literal Javascript object or primitive
 * @type derived from parseSigil or JStoBASICtype
 * @see bStatus.builtin["="]
 */
let BasicVar = function(literal, type) {
    this.bvLiteral = literal;
    this.bvType = type;
}
// DEFUN (GW-BASIC equiv. of DEF FN) constructor
let BasicFun = function(params, expression) {
    this.params = params;
    this.expression = expression;
}
// DIM (array) constructor
/*let BasicArr = function() {
    var args = Array.from(arguments);
    if (args.length == 1)
        throw lang.syntaxfehler(args[0]);
    else if (args.length == 0)
        throw "BasicIntpError: pass the line number!";
    else {
        // create nested array as defined
        var dimsize = Number(args[1]);
        var a = new Array(args[1]);
        var internal = a;
        for (var i = 2; i < args.length; i++) {
            dimsize *= Number(args[i]);
            var inner = new Array(args[i]);
            internal.push(inner);
            internal = inner;
        }

        this.array = a;
        this.dimsize = dimsize;
    }
}*/
// Abstract Syntax Tree
// creates empty tree node
let BasicAST = function() {
    this.astLnum = 0;
    this.astDepth = 0;
    this.astLeaves = [];
    this.astSeps = [];
    this.astValue = undefined;
    this.astType = "null"; // literal, operator, string, number, array, function, null

    this.toString = function() {
        var sb = "";
        var marker = ("literal" == this.astType) ? "i" :
                     ("operator" == this.astType) ? String.fromCharCode(177) :
                     ("string" == this.astType) ? String.fromCharCode(182) :
                     ("number" == this.astType) ? String.fromCharCode(162) :
                     ("array" == this.astType) ? "[" : String.fromCharCode(163);
        sb += "| ".repeat(this.astDepth) + marker+" Line "+this.astLnum+" ("+this.astType+")\n";
        sb += "| ".repeat(this.astDepth+1) + "leaves: "+(this.astLeaves.length)+"\n";
        sb += "| ".repeat(this.astDepth+1) + "value: "+this.astValue+" (type: "+typeof this.astValue+")\n";
        for (var k = 0; k < this.astLeaves.length; k++) {
            if (k > 0)
                sb += "| ".repeat(this.astDepth+1) + " " + this.astSeps[k - 1] + "\n";
            sb += this.astLeaves[k].toString(); + "\n";
        }
        sb += "| ".repeat(this.astDepth) + "`-----------------\n";
        return sb;
    };
}
let parseSigil = function(s) {
    var rettype;
    if (s.endsWith("$"))
        rettype = "string";
    else if (s.endsWith("%"))
        rettype = "integer";
    else if (s.endsWith("!") || s.endsWith("#"))
        rettype = "float";

    return {sgName:(rettype === undefined) ? s.toUpperCase() : s.substring(0, s.length - 1).toUpperCase(), sgType:rettype};
}
let literalTypes = ["string", "number", "bool", "array"];
/*
@param variable SyntaxTreeReturnObj, of which  the 'troType' is defined in BasicAST.
@return a value, if the input type if string or number, its literal value will be returned. Otherwise will search the
        BASIC variable table and return the literal value of the BasicVar; undefined will be returned if no such var exists.
*/
let resolve = function(variable) {
    if (variable.troType === "internal_arrindexing_lazy")
        return variable.troValue.arrValue;
    else if (literalTypes.includes(variable.troType) || variable.troType.startsWith("internal_"))
        return variable.troValue;
    else if (variable.troType == "literal") {
        var basicVar = bStatus.vars[parseSigil(variable.troValue).sgName];
        return (basicVar !== undefined) ? basicVar.bvLiteral : undefined;
    }
    else if (variable.troType == "null")
        return undefined;
    else
        throw "BasicIntpError: unknown variable with type "+variable.troType+", with value "+variable.troValue
}
let oneArg = function(lnum, args, action) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var rsvArg0 = resolve(args[0]);
    if (rsvArg0 === undefined) throw lang.refError(lnum, args[0]);
    return action(rsvArg0);
}
let oneArgNum = function(lnum, args, action) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var rsvArg0 = resolve(args[0]);
    if (rsvArg0 === undefined) throw lang.refError(lnum, args[0]);
    if (isNaN(rsvArg0)) throw lang.illegalType(lnum, args[0]);
    return action(rsvArg0);
}
let twoArg = function(lnum, args, action) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var rsvArg0 = resolve(args[0]);
    if (rsvArg0 === undefined) throw lang.refError(lnum, args[0]);
    var rsvArg1 = resolve(args[1]);
    if (rsvArg1 === undefined) throw lang.refError(lnum, args[1]);
    return action(rsvArg0, rsvArg1);
}
let twoArgNum = function(lnum, args, action) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var rsvArg0 = resolve(args[0]);
    if (rsvArg0 === undefined) throw lang.refError(lnum, args[0]);
    if (isNaN(rsvArg0)) throw lang.illegalType(lnum, args[0]);
    var rsvArg1 = resolve(args[1]);
    if (rsvArg1 === undefined) throw lang.refError(lnum, args[1]);
    if (isNaN(rsvArg1)) throw lang.illegalType(lnum, args[1]);
    return action(rsvArg0, rsvArg1);
}
let threeArg = function(lnum, args, action) {
    if (args.length != 3) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var rsvArg0 = resolve(args[0]);
    if (rsvArg0 === undefined) throw lang.refError(lnum, args[0]);
    var rsvArg1 = resolve(args[1]);
    if (rsvArg1 === undefined) throw lang.refError(lnum, args[1]);
    var rsvArg2 = resolve(args[2]);
    if (rsvArg2 === undefined) throw lang.refError(lnum, args[2]);
    return action(rsvArg0, rsvArg1, rsvArg2);
}
let threeArgNum = function(lnum, args, action) {
    if (args.length != 3) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var rsvArg0 = resolve(args[0]);
    if (rsvArg0 === undefined) throw lang.refError(lnum, args[0]);
    if (isNaN(rsvArg0)) throw lang.illegalType(lnum, args[0]);
    var rsvArg1 = resolve(args[1]);
    if (rsvArg1 === undefined) throw lang.refError(lnum, args[1]);
    if (isNaN(rsvArg1)) throw lang.illegalType(lnum, args[1]);
    var rsvArg2 = resolve(args[2]);
    if (rsvArg2 === undefined) throw lang.refError(lnum, args[2]);
    if (isNaN(rsvArg2)) throw lang.illegalType(lnum, args[2]);
    return action(rsvArg0, rsvArg1, rsvArg2);
}
let initBvars = function() {
    return {
        "NIL": new BasicVar([], "array"),
        "PI": new BasicVar(Math.PI, "number"),
        "TAU": new BasicVar(Math.PI * 2.0, "number"),
        "EULER": new BasicVar(Math.E, "number")
    };
}
let bStatus = {};
bStatus.gosubStack = [];
bStatus.forLnums = {}; // key: forVar, value: linenum
bStatus.forStack = []; // forVars only
bStatus.vars = initBvars(); // contains instances of BasicVars
bStatus.consts = {"NIL":1}; Object.freeze(bStatus.consts);
bStatus.defuns = {};
bStatus.rnd = 0; // stores mantissa (23 bits long) of single precision floating point number
bStatus.getArrayIndexFun = function(lnum, arrayName, array) {
    return function(lnum, args) {
        // TODO test 1-d array
        // NOTE: BASIC arrays are index in column-major order, which is OPPOSITE of C/JS/etc.
        var rsvArg0 = resolve(args[0]);
        if (rsvArg0 === undefined) throw lang.refError(lnum, rsvArg0);
        if (isNaN(rsvArg0)) throw lang.illegalType(lnum, rsvArg0);

        return {arrValue: array[rsvArg0], arrObj: array, arrIndex: rsvArg0, arrName: arrayName}; //array[rsvArg0];
    };
};
bStatus.builtin = {
/*
@param lnum line number
@param args instance of the SyntaxTreeReturnObj

if no args were given (e.g. "10 NEXT()"), args[0] will be: {troType: null, troValue: , troNextLine: 11}
if no arg text were given (e.g. "10 NEXT"), args will have zero length
*/
"REM" : function(lnum, args) {},
"=" : function(lnum, args) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var troValue = args[0].troValue;

    var rh = resolve(args[1]);
    if (rh === undefined) throw lang.refError(lnum, "RH:"+args[1].troValue);

    if (troValue.arrObj !== undefined) {
        if (isNaN(rh)) throw lang.illegalType(lnum, rh);

        troValue.arrObj[troValue.arrIndex] = rh;
        return {asgnVarName: troValue.arrName, asgnValue: rh};
    }
    else {
        var sigil = parseSigil(troValue);
        var type = sigil.sgType || JStoBASICtype(rh);

        if (bStatus.consts[sigil.sgName]) throw lang.asgnOnConst(lnum, sigil.sgName);

        bStatus.vars[sigil.sgName] = new BasicVar(rh, type);
        return {asgnVarName: sigil.sgName, asgnValue: rh};
    }

},
"==" : function(lnum, args) {
    return twoArg(lnum, args, function(lh, rh) { return lh == rh; });
},
"<>" : function(lnum, args) {
    return twoArg(lnum, args, function(lh, rh) { return lh != rh; });
},
"><" : function(lnum, args) {
    return twoArg(lnum, args, function(lh, rh) { return lh != rh; });
},
"<=" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh <= rh; });
},
"=<" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh <= rh; });
},
">=" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh >= rh; });
},
"=>" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh >= rh; });
},
"<" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh < rh; });
},
">" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh > rh; });
},
"<<" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh << rh; });
},
">>" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh >> rh; });
},
"UNARYMINUS" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) { return -lh; });
},
"UNARYPLUS" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) { return +lh; });
},
"BAND" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh & rh; });
},
"BOR" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh | rh; });
},
"BXOR" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh ^ rh; });
},
":" : function(lnum, args) { // Haskell-style CONS
    return twoArg(lnum, args, function(lh, rh) {
        if (isNaN(lh))
            throw lang.illegalType(lnum, lh); // BASIC array is numbers only
        if (!Array.isArray(rh))
            throw lang.illegalType(lnum, rh);
        return [lh].concat(rh);
    });
},
"~" : function(lnum, args) { // array PUSH
    return twoArg(lnum, args, function(lh, rh) {
        if (isNaN(rh))
            throw lang.illegalType(lnum, rh); // BASIC array is numbers only
        if (!Array.isArray(lh))
            throw lang.illegalType(lnum, lh);
        return lh.concat([rh]);
    });
},
"#" : function(lnum, args) { // array CONCAT
    return twoArg(lnum, args, function(lh, rh) {
        if (!Array.isArray(rh))
            throw lang.illegalType(lnum, rh);
        if (!Array.isArray(lh))
            throw lang.illegalType(lnum, lh);
        return lh.concat(rh);
    });
},
"+" : function(lnum, args) { // addition, string concat
    return twoArg(lnum, args, function(lh, rh) { return lh + rh; });
},
"-" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh - rh; });
},
"*" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh * rh; });
},
"/" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh / rh; });
},
"MOD" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return lh % rh; });
},
"^" : function(lnum, args) {
    return twoArgNum(lnum, args, function(lh, rh) { return Math.pow(lh, rh); });
},
"TO" : function(lnum, args) {
    return twoArgNum(lnum, args, function(from, to) {
        let a = [];
        if (from <= to) {
            for (let k = from; k <= to; k++) {
                a.push(k);
            }
        }
        else {
            for (let k = -from; k <= -to; k++) {
                a.push(-k);
            }
        }

        return a;
    });
},
"STEP" : function(lnum, args) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var rsvArg0 = resolve(args[0]);
    if (rsvArg0 === undefined) throw lang.refError(lnum, rsvArg0);
    if (!Array.isArray(rsvArg0)) throw lang.illegalType(lnum, rsvArg0);
    var rsvArg1 = resolve(args[1]);
    if (rsvArg1 === undefined) throw lang.refError(lnum, rsvArg1);
    if (isNaN(rsvArg1)) throw lang.illegalType(lnum, rsvArg1);
    let a = []; let stepcnt = 0;
    rsvArg0.forEach(function(v,i) {
        if (stepcnt == 0) a.push(v);
        stepcnt = (stepcnt + 1) % rsvArg1;
    });
    return a;
},
"PRINT" : function(lnum, args, seps) {
    //serial.println("BASIC func: PRINT -- args="+(args.map(function(it) { return it.troType+" "+it.troValue; })).join(", "));

    if (args.length == 0)
        println();
    else {
        for (var llll = 0; llll < args.length; llll++) {
            // parse separators.
            // ; - concat
            // , - tab
            // numbers always surrounded by 1 whitespace
            if (llll >= 1) {
                if (seps[llll - 1] == ",") print("\t");
            }

            var rsvArg = resolve(args[llll]);
            if (rsvArg === undefined && args[llll].troType != "null") throw lang.refError(lnum, args[llll].troValue);

            if (args[llll].troType == "number")
                print(" "+rsvArg+" ");
            else
                print((rsvArg === undefined) ? "" : rsvArg);
        }
    }

    if (args[args.length - 1].troType != "null") println();
},
"EMIT" : function(lnum, args) {
    if (args.length > 0) {
        for (var llll = 0; llll < args.length; llll++) {
            var lvalll = resolve(args[llll]);
            if (isNaN(lvalll)) {
                print(lvalll);
            }
            else {
                con.addch(lvalll);
            }
        }
    }
},
"POKE" : function(lnum, args) {
    twoArgNum(lnum, args, function(lh, rh) { sys.poke(lh, rh); });
},
"PEEK" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) { return sys.peek(lh); });
},
"GOTO" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) { return lh; });
},
"GOSUB" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) {
        bStatus.gosubStack.push(lnum + 1);
        return lh;
    });
},
"RETURN" : function(lnum, args) {
    var r = bStatus.gosubStack.pop();
    if (r === undefined) throw lang.nowhereToReturn(lnum);
    return r;
},
"CLEAR" : function(lnum, args) {
    bStatus.vars = initBvars();
},
"PLOT" : function(lnum, args) {
    threeArgNum(lnum, args, function(xpos, ypos, color) { graphics.plotPixel(xpos, ypos, color); });
},
"AND" : function(lnum, args) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var rsvArg = args.map(function(it) { return resolve(it); });
    rsvArg.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v);
        if (typeof v !== "boolean") throw lang.illegalType(lnum, v);
    });
    var argum = rsvArg.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it);
        return it;
    });
    return argum[0] && argum[1];
},
"OR" : function(lnum, args) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    var rsvArg = args.map(function(it) { return resolve(it); });
    rsvArg.forEach(function(v) {
        if (v === undefined) throw lang.refError(lnum, v.value);
        if (typeof v !== "boolean") throw lang.illegalType(lnum, v);
    });
    var argum = rsvArg.map(function(it) {
        if (it === undefined) throw lang.refError(lnum, it);
        return it;
    });
    return argum[0] || argum[1];
},
"RND" : function(lnum, args) {
    if (!(args.length > 0 && args[0].troValue === 0))
        bStatus.rnd = (bStatus.rnd * 214013 + 2531011) % 16777216; // GW-BASIC does this


    return (bStatus.rnd) / 16777216;
},
"ROUND" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) { return Math.round(lh); });
},
"FLOOR" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) { return Math.floor(lh); });
},
"INT" : function(lnum, args) { // synonymous to FLOOR
    return oneArgNum(lnum, args, function(lh) { return Math.floor(lh); });
},
"CEIL" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) { return Math.ceil(lh); });
},
"FIX" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) { return (lh|0); });
},
"CHR$" : function(lnum, args) {
    return oneArgNum(lnum, args, function(lh) { return String.fromCharCode(lh); });
},
"TEST" : function(lnum, args) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length + " arguments were given");
    return resolve(args[0]);
},
"FOR" : function(lnum, args) {
    let asgnObj = resolve(args[0]);
    // type check
    if (asgnObj === undefined) throw  lang.syntaxfehler(lnum);
    if (!Array.isArray(asgnObj.asgnValue)) throw lang.illegalType(lnum, asgnObj);

    let varname = asgnObj.asgnVarName;

    // assign new variable
    // the var itself will have head of the array, and the head itself will be removed from the array
    bStatus.vars[varname] = new BasicVar(asgnObj.asgnValue[0], JStoBASICtype(asgnObj.asgnValue.shift()));
    // stores entire array (sans head) into temporary storage
    bStatus.vars["for var "+varname] = new BasicVar(asgnObj.asgnValue, "array");
    // put the varname to forstack
    bStatus.forLnums[asgnObj.asgnVarName] = lnum;
    bStatus.forStack.push(asgnObj.asgnVarName);
},
"NEXT" : function(lnum, args) {
    // if no args were given
    if (args.length == 0 || (args.length == 1 && args.troType == "null")) {
        // go to most recent FOR
        let forVarname = bStatus.forStack.pop();
        //serial.println(lnum+" NEXT > forVarname = "+forVarname);
        if (forVarname === undefined) {
            throw lang.nextWithoutFor(lnum);
        }
        bStatus.vars[forVarname].bvLiteral = bStatus.vars["for var "+forVarname].bvLiteral.shift();

        if ((bStatus.vars[forVarname].bvLiteral !== undefined)) {
            // feed popped value back, we're not done yet
            bStatus.forStack.push(forVarname);
            return bStatus.forLnums[forVarname] + 1;
        }
        else {
            bStatus.vars[forVarname] === undefined; // unregister the variable
            return lnum + 1;
        }
    }

    throw lang.syntaxfehler(lnum, "extra arguments for NEXT");
},
/*
10 input;"what is your name";a$

£ Line 10 (function)
| leaves: 3
| value: input (type: string)
£ Line 0 (null)
| leaves: 0
| value: undefined (type: undefined)
`-----------------
|  ;
| ¶ Line 10 (string)
| | leaves: 0
| | value: what is your name (type: string)
| `-----------------
|  ;
| i Line 10 (literal)
| | leaves: 0
| | value: A$ (type: string)
| `-----------------
`-----------------
10 input "what is your name";a$

£ Line 10 (function)
| leaves: 2
| value: input (type: string)
| ¶ Line 10 (string)
| | leaves: 0
| | value: what is your name (type: string)
| `-----------------
|  ;
| i Line 10 (literal)
| | leaves: 0
| | value: A$ (type: string)
| `-----------------
`-----------------
*/
"INPUT" : function(lnum, args) {
    // just use tail-end arg as an input variable
    let endArg = args.pop();
    if (endArg === undefined) {
        system.printerr("INPUT called with no arguments");
        return undefined;
    }

    // print out prompt text
    print("? ");

    let inputstr = sys.read().trim();

    // screw with the comma-separating because shrug
    bStatus.vars[endArg.troValue] = new BasicVar(inputstr, JStoBASICtype(inputstr));

    // return raw input string
    return inputstr;
}
};
Object.freeze(bStatus.builtin);
let bF = {};
bF._1os = {":":1,"~":1,"#":1,"<":1,"=":1,">":1,"*":1,"+":1,"-":1,"/":1,"^":1};
bF._2os = {"<":1,"=":1,">":1};
bF._uos = {"+":1,"-":1,"!":1};
bF._isNum = function(code) {
    return (code >= 0x30 && code <= 0x39) || code == 0x5F;
};
bF._isNum2 = function(code) {
    return (code >= 0x30 && code <= 0x39) || code == 0x5F || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
};
bF._isNumSep = function(code) {
    return code == 0x2E || code == 0x42 || code == 0x58 || code == 0x62 || code == 0x78;
};
bF._is1o = function(code) {
    return bF._1os[String.fromCharCode(code)]
};
bF._is2o = function(code) {
    return bF._2os[String.fromCharCode(code)]
};
bF._isUnary = function(code) {
    return bF._uos[String.fromCharCode(code)]
}
bF._isParenOpen = function(code) {
    return (code == 0x28 || code == 0x5B);
};
bF._isParenClose = function(code) {
    return (code == 0x29 || code == 0x5D);
};
bF._isParen = function(code) {
    return bF._isParenOpen(code) || bF._isParenClose(code);
};
bF._isSep = function(code) {
    return code == 0x2C || code == 0x3B;
};
bF._opPrc = {
    // function call in itself has highest precedence
    "^":1,
    "*":2,"/":2,
    "MOD":3,
    "+":4,"-":4,
    //";":5,
    "<<":6,">>":6,
    "<":7,">":7,"<=":7,"=<":7,">=":7,"=>":7,
    "==":8,"<>":8,"><":8,
    "BAND":8,
    "BXOR":9,
    "BOR":10,
    "AND":11,
    "OR":12,
    "TO":13,
    "STEP":14,
    ":":15,"~":15, // array CONS and PUSH
    "#": 16, // array concat
    "=":999
};
bF._opRh = {"^":1,"=":1,":":1};
bF._keywords = {

};
bF._tokenise = function(lnum, cmd) {
    let _debugprintStateTransition = false;
    let k;
    let tokens = [];
    let states = [];
    let sb = "";
    let mode = "literal"; // literal, quote, paren, sep, operator, number; operator2, numbersep, number2, limbo, escape, quote_end

    // NOTE: malformed numbers (e.g. "_b3", "_", "__") must be re-marked as literal or syntax error in the second pass

    if (_debugprintStateTransition) println("@@ TOKENISE @@");
    if (_debugprintStateTransition) println("Ln "+lnum+" cmd "+cmd);

    // TOKENISE
    for (k = 0; k < cmd.length; k++) {
        var char = cmd[k];
        var charCode = cmd.charCodeAt(k);

        if (_debugprintStateTransition) print("Char: "+char+"("+charCode+"), state: "+mode);

        if ("literal" == mode) {
            if (0x22 == charCode) { // "
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote";
            }
            else if (bF._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (bF._isSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else if (bF._isNum(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "number";
            }
            else if (bF._is1o(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "operator";
            }
            else {
                sb += char;
            }
        }
        else if ("number" == mode) {
            if (bF._isNum(charCode)) {
                sb += char;
            }
            else if (bF._isNumSep(charCode)) {
                sb += char;
                mode = "numbersep";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (bF._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren"
            }
            else if (bF._isSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else if (bF._is1o(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "operator";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "literal";
            }
        }
        else if ("numbersep" == mode) {
            if (bF._isNum2(charCode)) {
                sb += char;
                mode = "number2";
            }
            else {
                throw lang.syntaxfehler(lnum, lang.badNumberFormat);
            }
        }
        else if ("number2" == mode) {
            if (bF._isNum2(charCode)) {
                sb += char;
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push("number");
                mode = "quote";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push("number");
                mode = "limbo";
            }
            else if (bF._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("number");
                mode = "paren"
            }
            else if (bF._isSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("number");
                mode = "sep";
            }
            else if (bF._is1o(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("number");
                mode = "operator";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push("number");
                mode = "literal";
            }
        }
        else if ("operator" == mode) {
            if (bF._is2o(charCode)) {
                sb += char;
                mode = "operator2";
            }
            else if (bF._isUnary(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
            }
            else if (bF._is1o(charCode)) {
                throw lang.syntaxfehler(lnum, lang.badOperatorFormat);
            }
            else if (bF._isNum(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "number";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (bF._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren"
            }
            else if (bF._isSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "literal";
            }
        }
        else if ("operator2" == mode) {
            if (bF._is1o(charCode)) {
                throw lang.syntaxfehler(lnum, lang.badOperatorFormat);
            }
            else if (bF._isNum(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("operator");
                mode = "number";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push("operator");
                mode = "quote";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push("operator");
                mode = "limbo";
            }
            else if (bF._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("operator");
                mode = "paren"
            }
            else if (bF._isSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("operator");
                mode = "sep";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push("operator");
                mode = "literal";
            }
        }
        else if ("quote" == mode) {
            if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote_end";
            }
            else if (charCode == 0x5C) { // reverse solidus
                tokens.push(sb); sb = "";
                mode = "escape";
            }
            else {
                sb += char;
            }
        }
        else if ("escape" == mode) {
            if (0x5C == charCode) // reverse solidus
                sb += String.fromCharCode(0x5C);
            else if ("n" == char)
                sb += String.fromCharCode(0x0A);
            else if ("t" == char)
                sb += String.fromCharCode(0x09);
            else if (0x22 == charCode) // "
                sb += String.fromCharCode(0x22);
            else if (0x27 == charCode)
                sb += String.fromCharCode(0x27);
            else if ("e" == char)
                sb += String.fromCharCode(0x1B);
            else if ("a" == char)
                sb += String.fromCharCode(0x07);
            else if ("b" == char)
                sb += String.fromCharCode(0x08);
            mode = "quote"; // ESCAPE is only legal when used inside of quote
        }
        else if ("quote_end" == mode) {
            if (" " == char) {
                sb = "";
                mode = "limbo";
            }
            else if (0x22 == charCode) {
                sb = "" + char;
                mode = "quote";
            }
            else if (bF._isParen(charCode)) {
                sb = "" + char;
                mode = "paren";
            }
            else if (bF._isSep(charCode)) {
                sb = "" + char;
                mode = "sep";
            }
            else if (bF._isNum(charCode)) {
                sb = "" + char;
                mode = "number";
            }
            else if (bF._is1o(charCode)) {
                sb = "" + char;
                mode = "operator"
            }
            else {
                sb = "" + char;
                mode = "literal";
            }
        }
        else if ("limbo" == mode) {
            if (char == " ") {
                /* do nothing */
            }
            else if (0x22 == charCode) {
                mode = "quote"
            }
            else if (bF._isParen(charCode)) {
                sb = "" + char;
                mode = "paren";
            }
            else if (bF._isSep(charCode)) {
                sb = "" + char;
                mode = "sep";
            }
            else if (bF._isNum(charCode)) {
                sb = "" + char;
                mode = "number";
            }
            else if (bF._is1o(charCode)) {
                sb = "" + char;
                mode = "operator"
            }
            else {
                sb = "" + char;
                mode = "literal";
            }
        }
        else if ("paren" == mode) {
            if (char == " ") {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote"
            }
            else if (bF._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren";
            }
            else if (bF._isSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else if (bF._isNum(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "number";
            }
            else if (bF._is1o(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "operator"
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "literal";
            }
        }
        else if ("sep" == mode) {
            if (char == " ") {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "quote"
            }
            else if (bF._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "paren";
            }
            else if (bF._isSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "sep";
            }
            else if (bF._isNum(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "number";
            }
            else if (bF._is1o(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "operator"
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "literal";
            }
        }
        else {
            throw "Unknown parser state: " + mode;
        }

        if (_debugprintStateTransition) println("->"+mode);
    }

    if (sb.length > 0) {
        tokens.push(sb); states.push(mode);
    }

    // filter off initial empty token if the statement does NOT start with literal (e.g. "-3+5")
    if (tokens[0].length == 0) {
        tokens = tokens.slice(1, tokens.length);
        states = states.slice(1, states.length);
    }
    // clean up operator2 and number2
    for (k = 0; k < states.length; k++) {
        if (states[k] == "operator2") states[k] = "operator";
        else if (states[k] == "number2" || states[k] == "numbersep") states[k] = "number";
    }

    if (tokens.length != states.length) throw "BasicIntpError: size of tokens and states does not match (line: "+lnum+")";

    return { "tokens": tokens, "states": states };
};
bF._parserElaboration = function(lnum, tokens, states) {
    var _debugprintElaboration = false;
    if (_debugprintElaboration) println("@@ ELABORATION @@");
    var k = 0;

    // NOTE: malformed numbers (e.g. "_b3", "_", "__") must be re-marked as literal or syntax error

    while (k < states.length) { // using while loop because array size will change during the execution
        if (states[k] == "number" && !reNumber.test(tokens[k]))
            states[k] = "literal";
        else if (states[k] == "literal" && bF._opPrc[tokens[k].toUpperCase()] !== undefined)
            states[k] = "operator";
        else if (tokens[k].toUpperCase() == "TRUE" || tokens[k].toUpperCase() == "FALSE")
            states[k] = "bool";

        // decimalise hex/bin numbers (because Nashorn does not support binary literal)
        if (states[k] == "number") {
            if (tokens[k].toUpperCase().startsWith("0B")) {
                tokens[k] = parseInt(tokens[k].substring(2, tokens[k].length), 2) + "";
            }
        }

        k += 1;
    }
};
/**
 * @returns BasicAST
 */
bF._parseTokens = function(lnum, tokens, states, recDepth) {
    // DO NOT PERFORM SEMANTIC ANALYSIS HERE
    // at this point you can't (and shouldn't) distinguish whether or not defuns/variables are previously declared

    // a line has one of these forms:
    // EXPRESSION -> LITERAL |
    //               BINARY_OP |
    //               UNARY_OP |
    //               FOR_LOOP |
    //               IF_STMT |
    //               WHILE_LOOP |
    //               FUNCTION_CALL |
    //               GROUPING
    //
    // LITERAL -> NUMBERS | FUNCTION_OR_VARIABLE_NAME | BOOLS | QUOTES
    // IF_STMT -> "IF" EXPRESSION "THEN" EXPRESSION "ELSE" EXPRESSION |
    //            "IF" EXPRESSION "GOTO" NUMBERS "ELSE" NUMBERS |
    //            "IF" EXPRESSION "THEN" EXPRESSION |
    //            "IF" EXPRESSION "GOTO" NUMBERS
    // FOR_LOOP -> "FOR" FUNCTION_OR_VARIABLE_NAME "=" EXPRESSION "TO" EXPRESSION "STEP" EXPRESSION |
    //             "FOR" FUNCTION_OR_VARIABLE_NAME "=" EXPRESSION "TO" EXPRESSION
    // WHILE_LOOP -> "WHILE" EXPERSSION
    // BINARY_OP -> EXPRSSION OPERATOR EXPRESSION
    // UNARY_OP -> OPERATOR EXPRESSION
    // FUNCTION_CALL -> LITERAL GROUPING
    // GROUPING -> "(" EXPRESSION ")"

/*
for DEF*s, you might be able to go away with BINARY_OP, as the parsing tree would be:

f Line 10 (function)
| leaves: 1
| value: defun
| + Line 10 (operator)
| | leaves: 2
| | value: =
| | f Line 10 (function)
| | | leaves: 1
| | | value: sinc
| | | i Line 10 (literal)
| | | | leaves: 0
| | | | value: X
| | | `-----------------
| | `-----------------
| | + Line 10 (operator)
| | | leaves: 2
| | | value: /
| | | f Line 10 (function)
| | | | leaves: 1
| | | | value: sin
| | | | i Line 10 (literal)
| | | | | leaves: 0
| | | | | value: X
| | | | `-----------------
| | | `-----------------
| | | i Line 10 (literal)
| | | | leaves: 0
| | | | value: X
| | | `-----------------
| | `-----------------
| `-----------------
`-----------------

for input "DEFUN sinc(x) = sin(x) / x"
 */

    function isSemanticLiteral(token, state) {
        return "]" == token || ")" == token ||
               "quote" == state || "number" == state || "bool" == state || "literal" == state;
    }

    var _debugSyntaxAnalysis = false;

    if (_debugSyntaxAnalysis) serial.println("@@ SYNTAX ANALYSIS @@");

    if (_debugSyntaxAnalysis) {
        serial.println("Parser Ln "+lnum+", Rec "+recDepth);
        serial.println("Tokens: "+tokens);
        serial.println("States: "+states);
    }

    if (tokens.length != states.length) throw "BasicIntpError: size of tokens and states does not match (line: "+lnum+", recursion depth: "+recDepth+")";
    if (tokens.length == 0) {
        if (_debugSyntaxAnalysis) serial.println("*empty tokens*");
        var retTreeHead = new BasicAST();
        retTreeHead.depth = recDepth;
        retTreeHead.lnum = lnum;
        return retTreeHead;
    }

    let k;
    let headWord = tokens[0].toLowerCase();
    let treeHead = new BasicAST();
    treeHead.astDepth = recDepth;
    treeHead.astLnum = lnum;

    // TODO ability to parse arbitrary parentheses
    // test string: print((minus(plus(3,2),times(8,7))))
    //                   ^                             ^ these extra parens break your parser

    // LITERAL
    if (tokens.length == 1 && (isSemanticLiteral(tokens[0], states[0]))) {
        // special case where there were only one word
        if (recDepth == 0) {
            // if that word is literal (e.g. "10 CLEAR"), interpret it as a function
            if (states[0] == "literal") {
                treeHead.astValue = tokens[0];
                treeHead.astType = "function";

                return treeHead;
            }
            // else, screw it
            else {
                throw lang.syntaxfehler(lnum);
            }
        }

        if (_debugSyntaxAnalysis) serial.println("literal/number: "+tokens[0]);
        treeHead.astValue = ("quote" == states[0]) ? tokens[0] : tokens[0].toUpperCase();
        treeHead.astType = ("quote" == states[0]) ? "string" : ("number" == states[0]) ? "number" : "literal";
    }
    else if (tokens[0].toUpperCase() == "IF" && states[0] != "quote") {
        // find ELSE and THEN
        var indexElse = undefined;
        var indexThen = undefined;
        for (k = tokens.length - 1; k >= 1; k--) {
            if (indexElse === undefined && tokens[k].toUpperCase() == "ELSE" && states[k] != "quote") {
                indexElse = k;
            }
            else if (indexThen === undefined && tokens[k].toUpperCase() == "THEN" && states[k] != "quote") {
                indexThen = k;
            }
        }
        // find GOTO and use it as THEN
        var useGoto = false;
        if (indexThen === undefined) {
            for (k = (indexElse !== undefined) ? indexElse - 1 : tokens.length - 1; k >= 1; k--) {
                if (indexThen == undefined && tokens[k].toUpperCase() == "GOTO" && states[k] != "quote") {
                    useGoto = true;
                    indexThen = k;
                    break;
                }
            }
        }

        // generate tree
        if (indexThen === undefined) throw lang.syntaxfehler(lnum);

        treeHead.astValue = "if";
        treeHead.astType = "function";
        treeHead.astLeaves[0] = bF._parseTokens(
                lnum,
                tokens.slice(1, indexThen),
                states.slice(1, indexThen),
                recDepth + 1
        );
        if (!useGoto)
            treeHead.astLeaves[1] = bF._parseTokens(
                    lnum,
                    tokens.slice(indexThen + 1, (indexElse !== undefined) ? indexElse : tokens.length),
                    states.slice(indexThen + 1, (indexElse !== undefined) ? indexElse : tokens.length),
                    recDepth + 1
            );
        else
            treeHead.astLeaves[1] = bF._parseTokens(
                    lnum,
                    [].concat("goto", tokens.slice(indexThen + 1, (indexElse !== undefined) ? indexElse : tokens.length)),
                    [].concat("literal", states.slice(indexThen + 1, (indexElse !== undefined) ? indexElse : tokens.length)),
                    recDepth + 1
            );
        if (indexElse !== undefined) {
            treeHead.astLeaves[2] = bF._parseTokens(
                    lnum,
                    tokens.slice(indexElse + 1, tokens.length),
                    states.slice(indexElse + 1, tokens.length),
                    recDepth + 1
            );
        }
    }
    else {
        // scan for operators with highest precedence, use rightmost one if multiple were found
        var topmostOp;
        var topmostOpPrc = 0;
        var operatorPos = -1;

        // find and mark position of separators and parentheses
        // properly deal with the nested function calls
        var parenDepth = 0;
        var parenStart = -1;
        var parenEnd = -1;
        var separators = [];

        // initial scan for adding omitted parens
        for (k = 0; k < tokens.length; k++) {
            if (tokens[k] == "(" && states[k] != "quote") {
                parenDepth += 1;
                if (parenStart == -1 && parenDepth == 1) parenStart = k;
            }
            else if (tokens[k] == ")" && states[k] != "quote") {
                if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
                parenDepth -= 1;
            }

            if (parenDepth == 0) {
                if (states[k] == "operator" && isSemanticLiteral(tokens[k-1], states[k-1]) &&
                        ((bF._opPrc[tokens[k].toUpperCase()] > topmostOpPrc) ||
                         (!bF._opRh[tokens[k].toUpperCase()] && bF._opPrc[tokens[k].toUpperCase()] == topmostOpPrc))
                ) {
                    topmostOp = tokens[k].toUpperCase();
                    topmostOpPrc = bF._opPrc[tokens[k].toUpperCase()];
                    operatorPos = k;
                }
            }
        }

        if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
        if (_debugSyntaxAnalysis) serial.println("Paren position: "+parenStart+", "+parenEnd);

        // if there is no paren or paren does NOT start index 1
        // e.g. negative three should NOT require to be written as "-(3)"
        if ((parenStart > 1 || parenStart == -1) && (operatorPos != 1 && operatorPos != 0) && states[0] == "literal" && states[1] != "operator") {
            // make a paren!
            tokens = [].concat(tokens[0], "(", tokens.slice(1, tokens.length), ")");
            states = [].concat(states[0], "paren", states.slice(1, states.length), "paren");

            if (_debugSyntaxAnalysis) serial.println("inserting paren at right place");
            if (_debugSyntaxAnalysis) serial.println(tokens.join(","));

            return bF._parseTokens(lnum, tokens, states, recDepth);
        }

        // get the position of parens and separators
        parenStart = -1; parenEnd = -1; parenDepth = 0;
        topmostOpPrc = 0; operatorPos = -1;
        // running again but now with newly added parens
        for (k = 0; k < tokens.length; k++) {
            if (tokens[k] == "(" && states[k] != "quote") {
                parenDepth += 1;
                if (parenStart == -1 && parenDepth == 1) parenStart = k;
            }
            else if (tokens[k] == ")" && states[k] != "quote") {
                if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
                parenDepth -= 1;
            }

            if (parenDepth == 1 && states[k] == "sep") {
                separators.push(k);
            }
            if (parenDepth == 0) {
                if (states[k] == "operator" && isSemanticLiteral(tokens[k-1], states[k-1]) &&
                        ((bF._opPrc[tokens[k].toUpperCase()] > topmostOpPrc) ||
                         (!bF._opRh[tokens[k].toUpperCase()] && bF._opPrc[tokens[k].toUpperCase()] == topmostOpPrc))
                ) {
                    topmostOp = tokens[k].toUpperCase();
                    topmostOpPrc = bF._opPrc[tokens[k].toUpperCase()];
                    operatorPos = k;
                }
            }
        }

        if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
        if (_debugSyntaxAnalysis) serial.println("NEW Paren position: "+parenStart+", "+parenEnd);

        // BINARY_OP/UNARY_OP
        if (topmostOp !== undefined) {
            if (_debugSyntaxAnalysis) serial.println("operator: "+topmostOp+", pos: "+operatorPos);

            // BINARY_OP?
            if (operatorPos > 0) {
                var subtknL = tokens.slice(0, operatorPos);
                var subtknR = tokens.slice(operatorPos + 1, tokens.length);
                var substaL = states.slice(0, operatorPos);
                var substaR = states.slice(operatorPos + 1, tokens.length);

                treeHead.astValue = topmostOp;
                treeHead.astType = "operator";
                treeHead.astLeaves[0] = bF._parseTokens(lnum, subtknL, substaL, recDepth + 1);
                treeHead.astLeaves[1] = bF._parseTokens(lnum, subtknR, substaR, recDepth + 1);
            }
            else {
                if (_debugSyntaxAnalysis) serial.println("re-parenthesising unary op");

                // parenthesize the unary op
                var unaryParenEnd = 1;
                while (unaryParenEnd < tokens.length) {
                    if (states[unaryParenEnd] == "operator" && bF._opPrc[tokens[unaryParenEnd]] > 1)
                        break;

                    unaryParenEnd += 1;
                }

                var newTokens = [].concat("(", tokens.slice(0, unaryParenEnd), ")", tokens.slice(unaryParenEnd, tokens.length));
                var newStates = [].concat("paren", states.slice(0, unaryParenEnd), "paren", states.slice(unaryParenEnd, tokens.length));

                return bF._parseTokens(lnum, newTokens, newStates, recDepth + 1);
            }
        }
        // FUNCTION CALL
        else {
            if (_debugSyntaxAnalysis) serial.println("function call");
            var currentFunction = (states[0] == "paren") ? undefined : tokens[0];
            treeHead.astValue = ("-" == currentFunction) ? "UNARYMINUS" : ("+" == currentFunction) ? "UNARYPLUS" : currentFunction;
            treeHead.astType = (currentFunction === undefined) ? "null" : "function";
            if (_debugSyntaxAnalysis) serial.println("function name: "+treeHead.astValue);

            var leaves = [];
            var seps = [];

            // if there is no paren (this part deals with unary ops ONLY!)
            if (parenStart == -1 && parenEnd == -1) {
                var subtkn = tokens.slice(1, tokens.length);
                var substa = states.slice(1, tokens.length);

                if (_debugSyntaxAnalysis) serial.println("subtokenA: "+subtkn.join("/"));

                leaves.push(bF._parseTokens(lnum, subtkn, substa, recDepth + 1))
            }
            else if (parenEnd > parenStart) {
                separators = [parenStart].concat(separators, [parenEnd]);
                if (_debugSyntaxAnalysis) serial.println("separators: "+separators.join(","));
                // recursively parse comma-separated arguments

                // print ( plus ( 3 , 2 ) , times ( 8 , 7 ) )
                //       s                ^                 e
                // separators = [1,8,15]
                //         plus ( 3 , 2 ) / times ( 8 , 7 )
                //              s   ^   e         s   ^   e
                // separators = [1,5] ; [1,5]
                //                3 / 2   /         8 / 7
                for (k = 1; k < separators.length; k++) {
                    var subtkn = tokens.slice(separators[k - 1] + 1, separators[k]);
                    var substa = states.slice(separators[k - 1] + 1, separators[k]);

                    if (_debugSyntaxAnalysis) serial.println("subtokenB: "+subtkn.join("/"));

                    leaves.push(bF._parseTokens(lnum, subtkn, substa, recDepth + 1));
                }
                separators.slice(1, separators.length - 1).forEach(function(v) { if (v !== undefined) seps.push(tokens[v]); });
            }
            else throw lang.syntaxfehler(lnum, lang.badFunctionCallFormat);
            treeHead.astLeaves = leaves;//.filter(function(__v) { return __v !== undefined; });
            treeHead.astSeps = seps;
        }
    }


    return treeHead;

};
// @return is defined in BasicAST
let JStoBASICtype = function(object) {
    if (typeof object === "boolean") return "bool";
    else if (Array.isArray(object)) return "array";
    else if (!isNaN(object)) return "number";
    else if (typeof object === "string" || object instanceof String) return "string";
    else if (object === undefined) return "null";
    else if (object.asgnVarName !== undefined) return "internal_assignment_object";
    else if (object.arrValue !== undefined) return "internal_arrindexing_lazy";
    else throw "BasicIntpError: un-translatable object with typeof "+(typeof object)+",\ntoString = "+object+",\nentries = "+Object.entries(object);
}
let SyntaxTreeReturnObj = function(type, value, nextLine) {
    this.troType = type;
    this.troValue = value;
    this.troNextLine = nextLine;
}
bF._gotoCmds = { GOTO:1, GOSUB:1, NEXT:1 }; // put nonzero (truthy) value here
/**
 * @param lnum line number of BASIC
 * @param syntaxTree BasicAST
 * @param recDepth recursion depth used internally
 *
 * @return syntaxTreeReturnObject if recursion is escaped
 */
bF._executeSyntaxTree = function(lnum, syntaxTree, recDepth) {
    var _debugExec = true;
    var recWedge = "> ".repeat(recDepth);

    if (_debugExec) serial.println(recWedge+"@@ EXECUTE @@");

    if (syntaxTree === undefined || (recDepth == 0 && syntaxTree.astValue.toUpperCase() == "REM"))
        return new SyntaxTreeReturnObj("null", undefined, lnum + 1);
    else if (syntaxTree.astType == "function" || syntaxTree.astType == "operator") {
        if (_debugExec) serial.println(recWedge+"function|operator");
        if (_debugExec) serial.println(recWedge+syntaxTree.toString());
        var funcName = syntaxTree.astValue.toUpperCase();
        var func = bStatus.builtin[funcName];

        if (funcName == "IF") {
            if (syntaxTree.astLeaves.length != 2 && syntaxTree.astLeaves.length != 3) throw lang.syntaxfehler(lnum);
            var testedval = bF._executeSyntaxTree(lnum, syntaxTree.astLeaves[0], recDepth + 1);

            if (_debugExec) {
                serial.println(recWedge+"testedval:");
                serial.println(recWedge+"type="+testedval.astType);
                serial.println(recWedge+"value="+testedval.astValue);
                serial.println(recWedge+"nextLine="+testedval.astNextLine);
            }

            try {
                var iftest = bStatus.builtin["TEST"](lnum, [testedval]);

                if (!iftest && syntaxTree.astLeaves[2] !== undefined)
                    return bF._executeSyntaxTree(lnum, syntaxTree.astLeaves[2], recDepth + 1);
                else if (iftest)
                    return bF._executeSyntaxTree(lnum, syntaxTree.astLeaves[1], recDepth + 1);
                else
                    return new SyntaxTreeReturnObj("null", undefined, lnum + 1);
            }
            catch (eeeee) {
                throw lang.errorinline(lnum, "TEST", eeeee);
            }
        }
        else {
            var args = syntaxTree.astLeaves.map(function(it) { return bF._executeSyntaxTree(lnum, it, recDepth + 1); });

            if (_debugExec) {
                serial.println(recWedge+"fn call name: "+funcName);
                serial.println(recWedge+"fn call args: "+(args.map(function(it) { return it.troType+" "+it.troValue; })).join(", "));
            }

            // func not in builtins (e.g. array access, user-defined function defuns)
            if (func === undefined) {
                let someVar = bStatus.vars[funcName];
                if (someVar.bvType != "array") {
                    serial.printerr(lang.syntaxfehler(lnum, funcName + " is not a function or an array"));
                    throw lang.syntaxfehler(lnum, funcName + " is not a function or an array");
                }

                // TODO calling from bStatus.defuns

                func = bStatus.getArrayIndexFun(lnum, funcName, someVar.bvLiteral);
            }
            // call whatever the 'func' has whether it's builtin or we just made shit up right above
            try {
                var funcCallResult = func(lnum, args, syntaxTree.astSeps);

                return new SyntaxTreeReturnObj(
                        JStoBASICtype(funcCallResult),
                        funcCallResult,
                        (bF._gotoCmds[funcName] !== undefined) ? funcCallResult : lnum + 1,
                        syntaxTree.astSeps
                );
            }
            catch (eeeee) {
                throw lang.errorinline(lnum, funcName, eeeee);
            }
        }
    }
    else if (syntaxTree.astType == "number") {
        if (_debugExec) serial.println(recWedge+"number");
        return new SyntaxTreeReturnObj(syntaxTree.astType, +(syntaxTree.astValue), lnum + 1);
    }
    else if (syntaxTree.astType == "string" || syntaxTree.astType == "literal" || syntaxTree.astType == "bool") {
        if (_debugExec) serial.println(recWedge+"string|literal|bool");
        return new SyntaxTreeReturnObj(syntaxTree.astType, syntaxTree.astValue, lnum + 1);
    }
    else if (syntaxTree.astType == "null") {
        return new bF._executeSyntaxTree(lnum, syntaxTree.astLeaves[0], recDepth + 1);
    }
    else {
        serial.println(recWedge+"Parse error in "+lnum);
        serial.println(recWedge+syntaxTree.toString());
        throw "Parse error";
    }
};
// @returns: line number for the next command, normally (lnum + 1); if GOTO or GOSUB was met, returns its line number
bF._interpretLine = function(lnum, cmd) {
    var _debugprintHighestLevel = false;

    // TOKENISE
    var tokenisedObject = bF._tokenise(lnum, cmd);
    var tokens = tokenisedObject.tokens;
    var states = tokenisedObject.states;


    // ELABORATION : distinguish numbers and operators from literals
    bF._parserElaboration(lnum, tokens, states);

    // PARSING (SYNTAX ANALYSIS)
    var syntaxTree = bF._parseTokens(lnum, tokens, states, 0);
    if (_debugprintHighestLevel) serial.println("Final syntax tree:");
    if (_debugprintHighestLevel) serial.println(syntaxTree.toString());

    // EXECUTE
    //try {
        var execResult = bF._executeSyntaxTree(lnum, syntaxTree, 0);
        return execResult.troNextLine;
    //}
    //catch (e) {
    //    throw lang.parserError(lnum, e);
    //}
}; // end INTERPRETLINE
bF._basicList = function(v, i, arr) {
    if (i < 10) print(" ");
    if (i < 100) print(" ");
    print(i);
    print(" ");
    println(v);
};
bF.list = function(args) { // LIST function
    if (args.length == 1) {
        cmdbuf.forEach(bF._basicList);
    }
    else if (args.length == 2) {
        if (cmdbuf[args[1]] !== undefined)
            bF._basicList(cmdbuf[args[1]], args[1], undefined);
    }
    else {
        var lastIndex = (args[2] === ".") ? cmdbuf.length - 1 : (args[2] | 0);
        var i = 0;
        for (i = args[1]; i <= lastIndex; i++) {
            var cmd = cmdbuf[i];
            if (cmd !== undefined) {
                bF._basicList(cmd, i, cmdbuf);
            }
        }
    }
};
bF.system = function(args) { // SYSTEM function
    tbasexit = true;
};
bF.new = function(args) { // NEW function
    cmdbuf = [];
};
bF.renum = function(args) { // RENUM function
    var newcmdbuf = [];
    var linenumRelation = [[]];
    var cnt = 10;
    for (var k = 0; k < cmdbuf.length; k++) {
        if (cmdbuf[k] !== undefined) {
            newcmdbuf[cnt] = cmdbuf[k];
            linenumRelation[k] = cnt;
            cnt += 10;
        }
    }
    // deal with goto/gosub line numbers
    for (k = 0; k < newcmdbuf.length; k++) {
        if (newcmdbuf[k] !== undefined && newcmdbuf[k].toLowerCase().startsWith("goto ")) {
            newcmdbuf[k] = "goto " + linenumRelation[newcmdbuf[k].match(reNum)[0]];
        }
        else if (newcmdbuf[k] !== undefined && newcmdbuf[k].toLowerCase().startsWith("gosub ")) {
            newcmdbuf[k] = "gosub " + linenumRelation[newcmdbuf[k].match(reNum)[0]];
        }
    }
    cmdbuf = newcmdbuf.slice(); // make shallow copy

    // recalculate memory footprint
    cmdbufMemFootPrint = 0;
    cmdbuf.forEach(function(v, i, arr) {
        cmdbufMemFootPrint += ("" + i).length + 1 + v.length;
    });
};
bF.fre = function(args) {
    println(vmemsize - getUsedMemSize());
};
bF.run = function(args) { // RUN function
    var linenumber = 1;
    var oldnum = 1;
    do {
        if (cmdbuf[linenumber] !== undefined) {
            oldnum = linenumber;
            linenumber = bF._interpretLine(linenumber, cmdbuf[linenumber]);
        }
        else {
            linenumber += 1;
        }
        if (con.hitterminate()) {
            println("Break in "+oldnum);
            break;
        }
    } while (linenumber < cmdbuf.length)
    con.resetkeybuf();
};
bF.save = function(args) { // SAVE function
    if (args[1] === undefined) throw lang.missingOperand;
    fs.open(args[1], "W");
    let sb = "";
    cmdbuf.forEach(function(v,i) { sb += i+" "+v+"\n"; });
    fs.write(sb);
};
bF.load = function(args) { // LOAD function
    if (args[1] === undefined) throw lang.missingOperand;
    let fileOpened = fs.open(args[1], "R");
    if (!fileOpened) {
        throw lang.noSuchFile;
        return;
    }
    let prg = fs.readAll();

    cmdbuf = [];
    prg.split('\n').forEach(function(line) {
        let i = line.indexOf(" ");
        let lnum = line.slice(0, i);
        if (isNaN(lnum)) throw lang.illegalType();
        cmdbuf[lnum] = line.slice(i + 1, line.length);
    });
};
bF.catalog = function(args) { // CATALOG function
    if (args[1] === undefined) args[1] = "\\";
    let pathOpened = fs.open(args[1], 'R');
    if (!pathOpened) {
        throw lang.noSuchFile;
        return;
    }
    let port = _BIOS.FIRST_BOOTABLE_PORT[0];
    com.sendMessage(port, "LIST");
    println(com.pullMessage(port));
};
Object.freeze(bF);
while (!tbasexit) {
    let line = sys.read().trim();

    cmdbufMemFootPrint += line.length;

    if (reLineNum.test(line)) {
        let i = line.indexOf(" ");
        cmdbuf[line.slice(0, i)] = line.slice(i + 1, line.length);
    }
    else if (line.length > 0) {
        cmdbufMemFootPrint -= line.length;
        let cmd = line.split(" ");
        if (bF[cmd[0].toLowerCase()] === undefined) {
            serial.printerr("Unknown command: "+cmd[0].toLowerCase());
            println(lang.syntaxfehler());
        }
        else {
            try {
                bF[cmd[0].toLowerCase()](cmd);
            }
            catch (e) {
                serial.printerr(e);
                println(e);
            }
        }

        println(prompt);
    }
}

0;