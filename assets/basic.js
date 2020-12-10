/*
NOTE: do not allow concatenation of commands!

Operators

; - When used by PRINT and INPUT, concatenates two printables; numbers will have one space between them while strings
    will not.
, - Function argument separator
+ - Just as in JS; concatenates two strings

Test Programs:

1 REM Random Maze
10 PRINT(CHR(47+ROUND(RND(1))*45);)
20 GOTO 10

*/
if (exec_args !== undefined && exec_args[1] !== undefined && exec_args[1].startsWith("-?")) {
    println("Usage: basic <optional path to basic program>");
    println("When the optional basic program is set, the interpreter will run the program and then quit if successful, remain open if the program had an error.");
    return 0;
}


let INDEX_BASE = 0;
let TRACEON = false;
let DBGON = true;
let DATA_CURSOR = 0;
let DATA_CONSTS = [];

if (system.maxmem() < 8192) {
    println("Out of memory. BASIC requires 8K or more User RAM");
    throw Error("Out of memory");
}

let vmemsize = system.maxmem() - 5236;

let cmdbuf = []; // index: line number
let cmdbufMemFootPrint = 0;
let prompt = "Ok";

/* if string can be FOR REAL cast to number */
function isNumable(s) {
    return s !== undefined && (typeof s.trim == "function" && s.trim() !== "" || s.trim == undefined) && !isNaN(s);
}

let lang = {};
lang.badNumberFormat = Error("Illegal number format");
lang.badOperatorFormat = Error("Illegal operator format");
lang.divByZero = Error("Division by zero");
lang.badFunctionCallFormat = function(reason) {
    return Error("Illegal function call" + ((reason) ? ": "+reason : ""));
};
lang.unmatchedBrackets = Error("Unmatched brackets");
lang.missingOperand = Error("Missing operand");
lang.noSuchFile = Error("No such file");
lang.outOfData = function(line) {
    return Error("Out of DATA"+(line !== undefined ? (" in "+line) : ""));
};
lang.nextWithoutFor = function(line, varname) {
    return Error("NEXT "+((varname !== undefined) ? ("'"+varname+"'") : "")+"without FOR in "+line);
};
lang.syntaxfehler = function(line, reason) {
    return Error("Syntax error" + ((line !== undefined) ? (" in "+line) : "") + ((reason !== undefined) ? (": "+reason) : ""));
};
lang.illegalType = function(line, obj) {
    return Error("Type mismatch" + ((obj !== undefined) ? ` "${obj} (typeof ${typeof obj})"` : "") + ((line !== undefined) ? (" in "+line) : ""));
 };
lang.refError = function(line, obj) {
    serial.printerr(`${line} Unresolved reference:`);
    serial.printerr(`    object: ${obj}, typeof: ${typeof obj}`);
    serial.printerr(`    entries: ${Object.entries(obj)}`);
    return Error("Unresolved reference" + ((obj !== undefined) ? ` "${obj}"` : "") + ((line !== undefined) ? (" in "+line) : ""));
};
lang.nowhereToReturn = function(line) { return "RETURN without GOSUB in " + line; };
lang.errorinline = function(line, stmt, errobj) {
    return Error('Error'+((line !== undefined) ? (" in "+line) : "")+' on statement "'+stmt+'": '+errobj);
};
lang.parserError = function(line, errorobj) {
    return Error("Parser error in " + line + ": " + errorobj);
};
lang.outOfMem = function(line) {
    return Error("Out of memory in " + line);
};
lang.dupDef = function(line, varname) {
    return Error("Duplicate definition"+((varname !== undefined) ? (" on "+varname) : "")+" in "+line);
};
lang.asgnOnConst = function(line, constname) {
    return Error('Trying to modify constant "'+constname+'" in '+line);
};
lang.subscrOutOfRng = function(line, object, index, maxlen) {
    return Error("Subscript out of range"+(object !== undefined ? (' for "'+object+'"') : '')+(index !== undefined ? (` (index: ${index}, len: ${maxlen})`) : "")+(line !== undefined ? (" in "+line) : ""));
};
lang.aG = " arguments were given";
lang.ord = function(n) {
    if (n % 10 == 1 && n % 100 != 11) return n+"st";
    if (n % 10 == 2 && n % 100 != 12) return n+"nd";
    if (n % 10 == 3 && n % 100 != 13) return n+"rd";
    return n+"th";
}
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
    var port = _BIOS.FIRST_BOOTABLE_PORT;

    fs._flush(port[0]); fs._close(port[0]);

    var mode = operationMode.toUpperCase();
    if (mode != "R" && mode != "W" && mode != "A") {
        throw Error("Unknown file opening mode: " + mode);
    }

    com.sendMessage(port[0], "OPEN"+mode+'"'+path+'",'+port[1]);
    let response = com.getStatusCode(port[0]);
    return (response == 0);
};
// @return the entire contents of the file in String
fs.readAll = function() {
    var port = _BIOS.FIRST_BOOTABLE_PORT;
    com.sendMessage(port[0], "READ");
    var response = com.getStatusCode(port[0]);
    if (135 == response) {
        throw Error("File not opened");
    }
    if (response < 0 || response >= 128) {
        throw Error("Reading a file failed with "+response);
    }
    return com.pullMessage(port[0]);
};
fs.write = function(string) {
    var port = _BIOS.FIRST_BOOTABLE_PORT;
    com.sendMessage(port[0], "WRITE"+string.length);
    var response = com.getStatusCode(port[0]);
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
    var varsMemSize = 0;

    Object.entries(bStatus.vars).forEach((pair, i) => {
        var object = pair[1];

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
 * @type derived from JStoBASICtype + "usrdefun" + "internal_arrindexing_lazy" + "internal_assignment_object"
 * @see bStatus.builtin["="]
 */
let BasicVar = function(literal, type) {
    this.bvLiteral = literal;
    this.bvType = type;
}
// Abstract Syntax Tree
// creates empty tree node
let astToString = function(ast) {
    if (ast === undefined || ast.astType === undefined) return "";
    var sb = "";
    var marker = ("lit" == ast.astType) ? "i" :
                 ("op" == ast.astType) ? String.fromCharCode(177) :
                 ("string" == ast.astType) ? String.fromCharCode(182) :
                 ("num" == ast.astType) ? String.fromCharCode(162) :
                 ("array" == ast.astType) ? "[" : String.fromCharCode(163);
    sb += "| ".repeat(ast.astDepth) + marker+" Line "+ast.astLnum+" ("+ast.astType+")\n";
    sb += "| ".repeat(ast.astDepth+1) + "leaves: "+(ast.astLeaves.length)+"\n";
    sb += "| ".repeat(ast.astDepth+1) + "value: "+ast.astValue+" (type: "+typeof ast.astValue+")\n";
    for (var k = 0; k < ast.astLeaves.length; k++) {
        if (k > 0)
            sb += "| ".repeat(ast.astDepth+1) + " " + ast.astSeps[k - 1] + "\n";
        sb += astToString(ast.astLeaves[k]);
    }
    sb += "| ".repeat(ast.astDepth) + "`-----------------\n";
    return sb;
}
let BasicAST = function() {
    this.astLnum = 0;
    this.astDepth = 0;
    this.astLeaves = [];
    this.astSeps = [];
    this.astValue = undefined;
    this.astType = "null"; // literal, operator, string, number, array, function, null, defun_args (! NOT usrdefun !)
}
let literalTypes = ["string", "num", "bool", "array", "generator"];
/*
@param variable SyntaxTreeReturnObj, of which  the 'troType' is defined in BasicAST.
@return a value, if the input type if string or number, its literal value will be returned. Otherwise will search the
        BASIC variable table and return the literal value of the BasicVar; undefined will be returned if no such var exists.
*/
let resolve = function(variable) {
    // head error checking
    if (variable.troType === undefined) {
        // primitves types somehow injected from elsewhere (main culprit: MAP)
        //throw Error(`BasicIntpError: trying to resolve unknown object '${variable}' with entries ${Object.entries(variable)}`);

        if (isNumable(variable)) return variable*1;
        if (Array.isArray(variable)) return variable;
        if (typeof variabe == "object")
            throw Error(`BasicIntpError: trying to resolve unknown object '${variable}' with entries ${Object.entries(variable)}`);
        return variable;
    }
    else if (variable.troType === "internal_arrindexing_lazy")
        return eval("variable.troValue.arrFull"+variable.troValue.arrKey);
    else if (literalTypes.includes(variable.troType) || variable.troType.startsWith("internal_"))
        return variable.troValue;
    else if (variable.troType == "lit") {
        var basicVar = bStatus.vars[variable.troValue];
        if (basicVar.bvLiteral === "") return "";
        return (basicVar !== undefined) ? basicVar.bvLiteral : undefined;
    }
    else if (variable.troType == "null")
        return undefined;
    // tail error checking
    else
        throw Error("BasicIntpError: unknown variable with type "+variable.troType+", with value "+variable.troValue);
}
let argCheckErr = function(lnum, o) {
    if (o === undefined || o.troType == "null") throw lang.refError(lnum, o);
    if (o.troType == "lit" && bStatus.vars[o.troValue] === undefined) throw lang.refError(lnum, o);
}
let oneArg = function(lnum, args, action) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    argCheckErr(lnum, args[0]);
    var rsvArg0 = resolve(args[0]);
    return action(rsvArg0);
}
let oneArgNum = function(lnum, args, action) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    argCheckErr(lnum, args[0]);
    var rsvArg0 = resolve(args[0]);
    if (isNaN(rsvArg0)) throw lang.illegalType(lnum, args[0]);
    return action(rsvArg0);
}
let twoArg = function(lnum, args, action) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    argCheckErr(lnum, args[0]);
    var rsvArg0 = resolve(args[0]);
    argCheckErr(lnum, args[1]);
    var rsvArg1 = resolve(args[1]);
    return action(rsvArg0, rsvArg1);
}
let twoArgNum = function(lnum, args, action) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    argCheckErr(lnum, args[0]);
    var rsvArg0 = resolve(args[0]);
    if (isNaN(rsvArg0)) throw lang.illegalType(lnum, "LH:"+Object.entries(args[0]));
    argCheckErr(lnum, args[1]);
    var rsvArg1 = resolve(args[1]);
    if (isNaN(rsvArg1)) throw lang.illegalType(lnum, "RH:"+Object.entries(args[1]));
    return action(rsvArg0, rsvArg1);
}
let threeArg = function(lnum, args, action) {
    if (args.length != 3) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    argCheckErr(lnum, args[0]);
    var rsvArg0 = resolve(args[0]);
    argCheckErr(lnum, args[1]);
    var rsvArg1 = resolve(args[1]);
    argCheckErr(lnum, args[2]);
    var rsvArg2 = resolve(args[2]);
    return action(rsvArg0, rsvArg1, rsvArg2);
}
let threeArgNum = function(lnum, args, action) {
    if (args.length != 3) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    if (rsvArg0 === undefined) throw lang.refError(lnum, args[0]);
    argCheckErr(lnum, args[0]);
    if (isNaN(rsvArg0)) throw lang.illegalType(lnum, args[0]);
    if (rsvArg1 === undefined) throw lang.refError(lnum, args[1]);
    argCheckErr(lnum, args[1]);
    if (isNaN(rsvArg1)) throw lang.illegalType(lnum, args[1]);
    if (rsvArg2 === undefined) throw lang.refError(lnum, args[2]);
    argCheckErr(lnum, args[2]);
    if (isNaN(rsvArg2)) throw lang.illegalType(lnum, args[2]);
    return action(rsvArg0, rsvArg1, rsvArg2);
}
let varArg = function(lnum, args, action) {
    var rsvArg = args.map((it) => {
        argCheckErr(lnum, it);
        var r = resolve(it);
        return r;
    });
    return action(rsvArg);
}
let varArgNum = function(lnum, args, action) {
    var rsvArg = args.map((it) => {
        argCheckErr(lnum, it);
        var r = resolve(it);
        if (isNaN(r)) throw lang.illegalType(lnum, r);
        return r;
    });
    return action(rsvArg);
}
let _primesgen = function() {
    let primesgen = new ForGen(2,0);
    primesgen.hasNext = (_) => true;
    primesgen.getNext = function(_) {
        do {
            primesgen.current += 1;
        } while (!(function(n){
            if (n == 2 || n == 3) return true;
            if (n % 2 == 0 || n % 3 == 0) return false;
            for (let i = 5; i * i <= n; i = i + 6)
                if (n % i == 0 || n % (i + 2) == 0)
                    return false;
            return true;
        })(primesgen.current));

        return primesgen.current;
    };
    primesgen.toString = (_) => "Generator: primes";
    return primesgen;
}
let _basicConsts = {
   "NIL": new BasicVar([], "array"),
   "PI": new BasicVar(Math.PI, "num"),
   "TAU": new BasicVar(Math.PI * 2.0, "num"),
   "EULER": new BasicVar(Math.E, "num"),
   "PRIMES": new BasicVar(_primesgen, "generator")
};
Object.freeze(_basicConsts);
let initBvars = function() {
    return JSON.parse(JSON.stringify(_basicConsts));
}
let ForGen = function(s,e,t) {
    this.start = s;
    this.end = e;
    this.step = t || 1;

    this.current = this.start;
    this.stepsgn = (this.step > 0) ? 1 : -1;

    this.hasNext = function() {
        return this.current*this.stepsgn + this.step*this.stepsgn <= (this.end + this.step)*this.stepsgn;
        // 1 to 10 step 1
        // 1 + 1 <= 11 -> true
        // 10 + 1 <= 11 -> true
        // 11 + 1 <= 11 -> false

        // 10 to 1 step -1
        // -10 + 1 <= 0 -> true
        // -1 + 1 <= 0 -> true
        // 0 + 1 <= 0 -> false
    }

    // mutableVar: the actual number stored into the FOR-Variable, because BASIC's FOR-Var is mutable af
    // returns undefined if there is no next()
    this.getNext = function(mutated) {
        //if (mutated === undefined) throw "InternalError: parametre is missing";
        if (mutated !== undefined) this.current = (mutated|0);
        this.current += this.step;
        //serial.println(`[BASIC.FORGEN] ${(mutated|0)} -> ${this.current}`);
        return this.hasNext() ? this.current : undefined;
    }

    this.toArray = function() {
        let a = [];
        let cur = this.start;
        while (cur*this.stepsgn + this.step*this.stepsgn <= (this.end + this.step)*this.stepsgn) {
            a.push(cur);
            cur += this.step;
        }
        return a;
    }
    this.reset = function() {
        this.current = this.start;
    }
    this.toString = function() {
        return `Generator: ${this.start} to ${this.end}`+((this.step !== 1) ? ` step ${this.step}` : '');
    }
}
let bStatus = {};
bStatus.gosubStack = [];
bStatus.forLnums = {}; // key: forVar, value: linenum
bStatus.forStack = []; // forVars only
bStatus.vars = initBvars(); // contains instances of BasicVars
bStatus.rnd = 0; // stores mantissa (23 bits long) of single precision floating point number
bStatus.getDimSize = function(array, dim) {
    var dims = [];
    while (true) {
        dims.push(array.length);

        if (Array.isArray(array[0]))
            array = array[0];
        else
            break;
    }
    return dims[dim];
};
bStatus.getArrayIndexFun = function(lnum, arrayName, array) {
    return function(lnum, args, seps) {
        // NOTE: BASIC arrays are index in column-major order, which is OPPOSITE of C/JS/etc.
        return varArgNum(lnum, args, (dims) => {
            if (TRACEON) serial.println("ar dims: "+dims);

            let dimcnt = 1;
            let oldIndexingStr = "";
            let indexingstr = "";

            dims.forEach(d => {
                oldIndexingStr = indexingstr;
                indexingstr += `[${d-INDEX_BASE}]`;

                var testingArr = eval(`array${indexingstr}`);
                if (testingArr === undefined)
                    throw lang.subscrOutOfRng(lnum, `${arrayName}${oldIndexingStr} (${lang.ord(dimcnt)} dim)`, d-INDEX_BASE, bStatus.getDimSize(array, dimcnt-1));

                dimcnt += 1;
            });

            if (TRACEON)
                serial.println("ar indexedValue = "+`/*ar1*/array${indexingstr}`);

            return {arrFull: array, arrName: arrayName, arrKey: indexingstr};
        });
    };
};
bStatus.getDefunThunk = function(lnum, exprTree) {
    let tree = JSON.parse(JSON.stringify(exprTree)); // ALWAYS create new tree instance!
    return function(lnum, args, seps) {
        let argsMap = [];
        args.map(it => {
            argCheckErr(lnum, it);
            return resolve(it);
        }).forEach(arg => argsMap.push(arg));

        if (DBGON) {
            serial.println("[BASIC.getDefunThunk] thunk args:");
            serial.println(argsMap);
        }

        // perform renaming
        bF._recurseApplyAST(tree, (it) => {
            if ("defun_args" == it.astType) {
                if (DBGON) {
                    serial.println("[BASIC.getDefunThunk] thunk renamed arg tree brance:");
                    serial.println(astToString(it));
                }

                let argsIndex = it.astValue;
                let theArg = argsMap[argsIndex]; // instanceof theArg == resolved version of SyntaxTreeReturnObj

                if (theArg === undefined)
                    throw lang.badFunctionCallFormat(lang.ord(argsIndex)+" argument was not given");

                it.astValue = theArg;
                it.astType = JStoBASICtype(theArg);
            }
        });

        if (DBGON) {
            serial.println("[BASIC.getDefunThunk] thunk tree:");
            serial.println(astToString(tree));
        }

        // evaluate new tree
        return resolve(bF._executeSyntaxTree(lnum, tree, 0));
    }
};
bStatus.builtin = {
/*
@param lnum line number
@param args instance of the SyntaxTreeReturnObj

if no args were given (e.g. "10 NEXT()"), args[0] will be: {troType: null, troValue: , troNextLine: 11}
if no arg text were given (e.g. "10 NEXT"), args will have zero length

DEFUN'd functions must be treated as if their args is "vararg"
*/
"=" : {args:2, f:function(lnum, args) {
    // THIS FUNCTION MUST BE COPIED TO 'INPUT'
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    var troValue = args[0].troValue;

    var rh = resolve(args[1]);
    if (rh === undefined) throw lang.refError(lnum, "RH:"+args[1].troValue);

    if (isNumable(rh)) rh = rh*1 // if string we got can be cast to number, do it

    //println(lnum+" = lh: "+Object.entries(args[0]));
    //println(lnum+" = rh raw: "+Object.entries(args[1]));
    //println(lnum+" = rh resolved: "+rh);
    //try { println(lnum+" = rh resolved entries: "+Object.entries(rh)); }
    //catch (_) {}


    if (troValue.arrFull !== undefined) { // assign to existing array
        if (isNaN(rh) && !Array.isArray(rh)) throw lang.illegalType(lnum, rh);
        let arr = eval("troValue.arrFull"+troValue.arrKey);
        if (Array.isArray(arr)) throw lang.subscrOutOfRng(lnum, arr);
        eval("troValue.arrFull"+troValue.arrKey+"=rh");
        return {asgnVarName: troValue.arrName, asgnValue: rh};
    }
    else {
        var varname = troValue.toUpperCase();
        var type = JStoBASICtype(rh);
        if (_basicConsts[varname]) throw lang.asgnOnConst(lnum, varname);
        // special case for scalar array
        // it basically bypasses the regular resolve subroutine
        if (args[1].troType !== undefined && args[1].troType == "array") {
            bStatus.vars[varname] = new BasicVar(args[1].troValue, "array");
            return {asgnVarName: varname, asgnValue: rh};
        }
        else {
            bStatus.vars[varname] = new BasicVar(rh, type);
            return {asgnVarName: varname, asgnValue: rh};
        }
    }
}},
"IN" : {args:2, f:function(lnum, args) { // almost same as =, but don't actually make new variable. Used by FOR statement
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    var troValue = args[0].troValue;

    var rh = resolve(args[1]);
    if (rh === undefined) throw lang.refError(lnum, "RH:"+args[1].troValue);

    if (troValue.arrFull !== undefined) {
        throw lang.syntaxfehler(lnum);
    }
    else {
        var varname = troValue.toUpperCase();
        var type = JStoBASICtype(rh);
        if (_basicConsts[varname]) throw lang.asgnOnConst(lnum, varname);
        return {asgnVarName: varname, asgnValue: rh};
    }
}},
"==" : {args:2, f:function(lnum, args) {
    return twoArg(lnum, args, (lh,rh) => lh == rh);
}},
"<>" : {args:2, f:function(lnum, args) {
    return twoArg(lnum, args, (lh,rh) => lh != rh);
}},
"><" : {args:2, f:function(lnum, args) {
    return twoArg(lnum, args, (lh,rh) => lh != rh);
}},
"<=" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh <= rh);
}},
"=<" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh <= rh);
}},
">=" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh >= rh);
}},
"=>" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh >= rh);
}},
"<" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh < rh);
}},
">" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh > rh);
}},
"<<" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh << rh);
}},
">>" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh >> rh);
}},
"UNARYMINUS" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => -lh);
}},
"UNARYPLUS" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => +lh);
}},
"BAND" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh & rh);
}},
"BOR" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh | rh);
}},
"BXOR" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh ^ rh);
}},
"!" : {args:2, f:function(lnum, args) { // Haskell-style CONS
    return twoArg(lnum, args, (lh,rh) => {
        if (isNaN(lh))
            throw lang.illegalType(lnum, lh); // BASIC array is numbers only
        if (!Array.isArray(rh))
            throw lang.illegalType(lnum, rh);
        return [lh].concat(rh);
    });
}},
"~" : {args:2, f:function(lnum, args) { // array PUSH
    return twoArg(lnum, args, (lh,rh) => {
        if (isNaN(rh))
            throw lang.illegalType(lnum, rh); // BASIC array is numbers only
        if (!Array.isArray(lh))
            throw lang.illegalType(lnum, lh);
        return lh.concat([rh]);
    });
}},
"#" : {args:2, f:function(lnum, args) { // array CONCAT
    return twoArg(lnum, args, (lh,rh) => {
        if (!Array.isArray(rh))
            throw lang.illegalType(lnum, rh);
        if (!Array.isArray(lh))
            throw lang.illegalType(lnum, lh);
        return lh.concat(rh);
    });
}},
"+" : {args:2, f:function(lnum, args) { // addition, string concat
    return twoArg(lnum, args, (lh,rh) => (!isNaN(lh) && !isNaN(rh)) ? (lh*1 + rh*1) : (lh + rh));
}},
"-" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh - rh);
}},
"*" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh * rh);
}},
"/" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => {
        if (rh == 0) throw lang.divByZero;
        return lh / rh
    });
}},
"MOD" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => lh % rh);
}},
"^" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (lh,rh) => Math.pow(lh, rh));
}},
"TO" : {args:2, f:function(lnum, args) {
    return twoArgNum(lnum, args, (from, to) => new ForGen(from, to, 1));
}},
"STEP" : {args:2, f:function(lnum, args) {
    return twoArg(lnum, args, (gen, step) => {
        if (!(gen instanceof ForGen)) throw lang.illegalType(lnum, gen);
        return new ForGen(gen.start, gen.end, step);
    });
}},
"DIM" : {args:2, f:function(lnum, args) {
    return varArgNum(lnum, args, (revdims) => {
        let dims = revdims.reverse();
        let arraydec = "Array(dims[0]).fill(0)";
        for (let k = 1; k < dims.length; k++) {
            arraydec = `Array(dims[${k}]).fill().map(_=>${arraydec})`
        }
        return eval(arraydec);
    });
}},
"PRINT" : {args:"vararg", f:function(lnum, args, seps) {
    if (args.length == 0)
        println();
    else {
        for (var llll = 0; llll < args.length; llll++) {
            // parse separators.
            // ; - concat
            // , - tab
            if (llll >= 1) {
                if (seps[llll - 1] == ",") print("\t");
            }

            var rsvArg = resolve(args[llll]);
            if (rsvArg === undefined && args[llll] !== undefined && args[llll].troType != "null") throw lang.refError(lnum, args[llll].troValue);

            //serial.println(`${lnum} PRINT ${lang.ord(llll)} arg: ${Object.entries(args[llll])}, resolved: ${rsvArg}`);

            let printstr = "";
            if (rsvArg === undefined || rsvArg === "")
                printstr = "";
            else if (rsvArg.toString !== undefined)
                printstr = rsvArg.toString();
            else
                printstr = rsvArg;

            print(printstr);
            if (TRACEON) serial.println("[BASIC.PRINT] "+printstr);
        }
    }

    if (args[args.length - 1] !== undefined && args[args.length - 1].troType != "null") println();
}},
"EMIT" : {args:"vararg", f:function(lnum, args, seps) {
    if (args.length == 0)
        println();
    else {
        for (var llll = 0; llll < args.length; llll++) {
            // parse separators.
            // ; - concat
            // , - tab
            if (llll >= 1) {
                if (seps[llll - 1] == ",") print("\t");
            }

            var rsvArg = resolve(args[llll]);
            if (rsvArg === undefined && args[llll] !== undefined && args[llll].troType != "null") throw lang.refError(lnum, args[llll].troValue);

            let printstr = "";
            if (rsvArg === undefined)
                print("")
            else if (!isNaN(rsvArg)) {
                let c = con.getyx();
                con.addch(rsvArg);
            }
            else if (rsvArg.toString !== undefined)
                print(rsvArg.toString());
            else
                printstr = (rsvArg);

            if (TRACEON) serial.println("[BASIC.EMIT] "+printstr);
        }
    }

    if (args[args.length - 1] !== undefined && args[args.length - 1].troType != "null") println();
}},
"POKE" : {args:2, f:function(lnum, args) {
    twoArgNum(lnum, args, (lh,rh) => sys.poke(lh, rh));
}},
"PEEK" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => sys.peek(lh));
}},
"GOTO" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => {
        if (lh < 0) throw lang.syntaxfehler(lnum, lh);
        return lh;
    });
}},
"GOSUB" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => {
        if (lh < 0) throw lang.syntaxfehler(lnum, lh);
        bStatus.gosubStack.push(lnum + 1);
        //println(lnum+" GOSUB into "+lh);
        return lh;
    });
}},
"RETURN" : {args:0, f:function(lnum, args) {
    var r = bStatus.gosubStack.pop();
    if (r === undefined) throw lang.nowhereToReturn(lnum);
    //println(lnum+" RETURN to "+r);
    return r;
}},
"CLEAR" : {args:0, f:function(lnum, args) {
    bStatus.vars = initBvars();
}},
"PLOT" : {args:3, f:function(lnum, args) {
    threeArgNum(lnum, args, (xpos, ypos, color) => graphics.plotPixel(xpos, ypos, color));
}},
"AND" : {args:2, f:function(lnum, args) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    var rsvArg = args.map((it) => resolve(it));
    rsvArg.forEach((v) => {
        if (v === undefined) throw lang.refError(lnum, v);
        if (typeof v !== "boolean") throw lang.illegalType(lnum, v);
    });
    var argum = rsvArg.map((it) => {
        if (it === undefined) throw lang.refError(lnum, it);
        return it;
    });
    return argum[0] && argum[1];
}},
"OR" : {args:2, f:function(lnum, args) {
    if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    var rsvArg = args.map((it) => resolve(it));
    rsvArg.forEach((v) => {
        if (v === undefined) throw lang.refError(lnum, v.value);
        if (typeof v !== "boolean") throw lang.illegalType(lnum, v);
    });
    var argum = rsvArg.map((it) => {
        if (it === undefined) throw lang.refError(lnum, it);
        return it;
    });
    return argum[0] || argum[1];
}},
"RND" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => {
        if (!(args.length > 0 && args[0].troValue === 0))
            bStatus.rnd = Math.random();//(bStatus.rnd * 214013 + 2531011) % 16777216; // GW-BASIC does this
        return bStatus.rnd;
    });
}},
"ROUND" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => Math.round(lh));
}},
"FLOOR" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => Math.floor(lh));
}},
"INT" : {args:1, f:function(lnum, args) { // synonymous to FLOOR
    return oneArgNum(lnum, args, (lh) => Math.floor(lh));
}},
"CEIL" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => Math.ceil(lh));
}},
"FIX" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => (lh|0));
}},
"CHR" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => String.fromCharCode(lh));
}},
"TEST" : {args:1, f:function(lnum, args) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    return resolve(args[0]);
}},
"FOREACH" : {args:1, f:function(lnum, args) { // list comprehension model
    var asgnObj = resolve(args[0]);
    // type check
    if (asgnObj === undefined) throw lang.syntaxfehler(lnum);
    if (!Array.isArray(asgnObj.asgnValue)) throw lang.illegalType(lnum, asgnObj);

    var varname = asgnObj.asgnVarName;

    // assign new variable
    // the var itself will have head of the array, and the head itself will be removed from the array
    bStatus.vars[varname] = new BasicVar(asgnObj.asgnValue[0], JStoBASICtype(asgnObj.asgnValue.shift()));
    // stores entire array (sans head) into temporary storage
    bStatus.vars["for var "+varname] = new BasicVar(asgnObj.asgnValue, "array");
    // put the varname to forstack
    bStatus.forLnums[varname] = lnum;
    bStatus.forStack.push(varname);
}},
"FOR" : {args:1, f:function(lnum, args) { // generator model
    var asgnObj = resolve(args[0]);
    // type check
    if (asgnObj === undefined) throw lang.syntaxfehler(lnum);
    if (!(asgnObj.asgnValue instanceof ForGen)) throw lang.illegalType(lnum, typeof asgnObj);

    var varname = asgnObj.asgnVarName;
    var generator = asgnObj.asgnValue;


    // assign new variable
    // the var itself will have head of the array, and the head itself will be removed from the array
    bStatus.vars[varname] = new BasicVar(generator.start, "num");
    // stores entire array (sans head) into temporary storage
    bStatus.vars["for var "+varname] = new BasicVar(generator, "generator");
    // put the varname to forstack
    bStatus.forLnums[varname] = lnum;
    bStatus.forStack.push(varname);
}},
"NEXT" : {args:"vararg", f:function(lnum, args) {
    // if no args were given
    if (args.length == 0 || (args.length == 1 && args.troType == "null")) {
        // go to most recent FOR
        var forVarname = bStatus.forStack.pop();
        //serial.println(lnum+" NEXT > forVarname = "+forVarname);
        if (forVarname === undefined) {
            throw lang.nextWithoutFor(lnum);
        }

        if (TRACEON) serial.println("[BASIC.FOR] looping "+forVarname);

        var forVar = bStatus.vars["for var "+forVarname].bvLiteral;

        if (forVar instanceof ForGen)
            bStatus.vars[forVarname].bvLiteral = forVar.getNext(bStatus.vars[forVarname].bvLiteral);
        else
            bStatus.vars[forVarname].bvLiteral = forVar.shift();

        if ((bStatus.vars[forVarname].bvLiteral !== undefined)) {
            // feed popped value back, we're not done yet
            bStatus.forStack.push(forVarname);
            return bStatus.forLnums[forVarname] + 1;
        }
        else {
            if (forVar instanceof ForGen)
                bStatus.vars[forVarname].bvLiteral = forVar.current; // true BASIC compatibility for generator
            else
                bStatus.vars[forVarname] === undefined; // unregister the variable

            return lnum + 1;
        }
    }

    throw lang.syntaxfehler(lnum, "extra arguments for NEXT");
}},
"BREAKTO" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => {
        var forVarname = bStatus.forStack.pop();
        if (forVarname === undefined) {
            throw lang.nextWithoutFor(lnum);
        }
        if (TRACEON) serial.println(`[BASIC.FOR] breaking from ${forVarname}, jump to ${lh}`);

        if (lh < 0) throw lang.syntaxfehler(lnum, lh);
        return lh;
    });
}},
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
"INPUT" : {args:"vararg", f:function(lnum, args) {
    if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
    var troValue = args[0].troValue;

    // print out prompt text
    print("? "); var rh = sys.read().trim();

    // if string we got can be cast to number, do it
    // NOTE: empty string will be cast to 0, which corresponds to GW-BASIC
    if (!isNaN(rh)) rh = rh*1

    if (troValue.arrFull !== undefined) { // assign to existing array
        if (isNaN(rh) && !Array.isArray(rh)) throw lang.illegalType(lnum, rh);
        let arr = eval("troValue.arrFull"+troValue.arrKey);
        if (Array.isArray(arr)) throw lang.subscrOutOfRng(lnum, arr);
        eval("troValue.arrFull"+troValue.arrKey+"=rh");
        return {asgnVarName: troValue.arrName, asgnValue: rh};
    }
    else {
        var varname = troValue.toUpperCase();
        //println("input varname: "+varname);
        var type = JStoBASICtype(rh);
        if (_basicConsts[varname]) throw lang.asgnOnConst(lnum, varname);
        bStatus.vars[varname] = new BasicVar(rh, type);
        return {asgnVarName: varname, asgnValue: rh};
    }
}},
"END" : {args:0, f:function(lnum, args) {
    serial.println("Program terminated in "+lnum);
    return Number.MAX_SAFE_INTEGER; // GOTO far-far-away
}},
"SPC" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => " ".repeat(lh));
}},
"LEFT" : {args:2, f:function(lnum, args) {
    return twoArg(lnum, args, (str, len) => str.substring(0, len));
}},
"MID" : {args:3, f:function(lnum, args) {
    return threeArg(lnum, args, (str, start, len) => str.substring(start-INDEX_BASE, start-INDEX_BASE+len));
}},
"RIGHT" : {args:2, f:function(lnum, args) {
    return twoArg(lnum, args, (str, len) => str.substring(str.length - len, str.length));
}},
"SGN" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => (it > 0) ? 1 : (it < 0) ? -1 : 0);
}},
"ABS" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.abs(it));
}},
"SIN" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.sin(it));
}},
"COS" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.cos(it));
}},
"TAN" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.tan(it));
}},
"EXP" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.exp(it));
}},
"ASN" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.asin(it));
}},
"ACO" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.acos(it));
}},
"ATN" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.atan(it));
}},
"SQR" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.sqrt(it));
}},
"CBR" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.cbrt(it));
}},
"SINH" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.sinh(it));
}},
"COSH" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.cosh(it));
}},
"TANH" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.tanh(it));
}},
"LOG" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (it) => Math.log(it));
}},
"RESTORE" : {args:0, f:function(lnum, args) {
    DATA_CURSOR = 0;
}},
"READ" : {args:0, f:function(lnum, args) {
    let r = DATA_CONSTS.shift();
    if (r === undefined) throw lang.outOfData(lnum);
}},
"OPTIONBASE" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => {
        if (lh != 0 && lh != 1) throw lang.syntaxfehler(line);
        INDEX_BASE = lh|0;
    });
}},
"DATA" : {args:"vararg", f:function() { /*DATA must do nothing when encountered; they must be pre-processed*/ }},
/* Syopsis: MAP function, functor
 */
"MAP" : {args:2, f:function(lnum, args) {
    return twoArg(lnum, args, (fn, functor) => {
        // TODO test only works with DEFUN'd functions
        if (fn.astLeaves === undefined) throw lang.badFunctionCallFormat("Only works with DEFUN'd functions yet");
        if (functor.toArray === undefined && !Array.isArray(functor)) throw lang.syntaxfehler(lnum, functor);
        // generator?
        if (functor.toArray) functor = functor.toArray();

        return functor.map(it => bStatus.getDefunThunk(lnum, fn)(lnum, [it]));
    });
}},
/* Synopsis: FOLD function, init_value, functor
 * a function must accept two arguments, of which first argument will be an accumulator
 */
"FOLD" : {args:3, f:function(lnum, args) {
    return threeArg(lnum, args, (fn, init, functor) => {
        // TODO test only works with DEFUN'd functions
        if (fn.astLeaves === undefined) throw lang.badFunctionCallFormat("Only works with DEFUN'd functions yet");
        if (functor.toArray === undefined && !Array.isArray(functor)) throw lang.syntaxfehler(lnum, functor);
        // generator?
        if (functor.toArray) functor = functor.toArray();

        let akku = init;
        functor.forEach(it => {
            akku = bStatus.getDefunThunk(lnum, fn)(lnum, [akku, it]);
        });

        return akku;
    });
}},
/* GOTO and GOSUB won't work but that's probably the best...? */
"DO" : {args:"vararg", f:function(lnum, args) {
    //return resolve(args[args.length - 1]);
    return undefined;
}},
"OPTIONDEBUG" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => {
        if (lh != 0 && lh != 1) throw lang.syntaxfehler(line);
        DBGON = (1 == lh|0);
    });
}},
"OPTIONTRACE" : {args:1, f:function(lnum, args) {
    return oneArgNum(lnum, args, (lh) => {
        if (lh != 0 && lh != 1) throw lang.syntaxfehler(line);
        TRACEON = (1 == lh|0);
    });
}},
"RESOLVE" : {args:1, f:function(lnum, args) {
    if (DBGON) {
        return oneArg(lnum, args, (it) => {
            println(it);
        });
    }
    else {
        throw lang.syntaxfehler(lnum);
    }
}},
"RESOLVE0" : {args:1, f:function(lnum, args) {
    if (DBGON) {
        return oneArg(lnum, args, (it) => {
            println(Object.entries(it));
        });
    }
    else {
        throw lang.syntaxfehler(lnum);
    }
}},
"UNRESOLVE" : {args:1, f:function(lnum, args) {
    if (DBGON) {
        println(args[0]);
    }
    else {
        throw lang.syntaxfehler(lnum);
    }
}},
"UNRESOLVE0" : {args:1, f:function(lnum, args) {
    if (DBGON) {
        println(Object.entries(args[0]));
    }
    else {
        throw lang.syntaxfehler(lnum);
    }
}}
};
Object.freeze(bStatus.builtin);
let bF = {};
bF._1os = {"!":1,"~":1,"#":1,"<":1,"=":1,">":1,"*":1,"+":1,"-":1,"/":1,"^":1};
bF._2os = {"<":1,"=":1,">":1};
bF._uos = {"+":1,"-":1};
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
// define operator precedence here...
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
    "!":15,"~":15, // array CONS and PUSH
    "#": 16, // array concat
    "=":999,
    "IN":1000
};
bF._opRh = {"^":1,"=":1,"!":1,"IN":1};
// these names appear on executeSyntaxTree as "exceptional terms" on parsing (regular function calls are not "exceptional terms")
bF._keywords = {"IF":1,"THEN":1,"ELSE":1,"DEFUN":1};
bF._tokenise = function(lnum, cmd) {
    var _debugprintStateTransition = false;
    var k;
    var tokens = [];
    var states = [];
    var sb = "";
    var mode = "lit"; // lit, qot, paren, sep, op, num; operator2, numbersep, number2, limbo, escape, quote_end

    // NOTE: malformed numbers (e.g. "_b3", "_", "__") must be re-marked as literal or syntax error in the second pass

    if (_debugprintStateTransition) println("@@ TOKENISE @@");
    if (_debugprintStateTransition) println("Ln "+lnum+" cmd "+cmd);

    // TOKENISE
    for (k = 0; k < cmd.length; k++) {
        var char = cmd[k];
        var charCode = cmd.charCodeAt(k);

        if (_debugprintStateTransition) print("Char: "+char+"("+charCode+"), state: "+mode);

        if ("lit" == mode) {
            if (0x22 == charCode) { // "
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "qot";
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
            /*else if (bF._isNum(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "num";
            }*/
            else if (bF._is1o(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "op";
            }
            else {
                sb += char;
            }
        }
        else if ("num" == mode) {
            if (bF._isNum(charCode)) {
                sb += char;
            }
            else if (bF._isNumSep(charCode)) {
                sb += char;
                mode = "nsep";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "qot";
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
                mode = "op";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "lit";
            }
        }
        else if ("nsep" == mode) {
            if (bF._isNum2(charCode)) {
                sb += char;
                mode = "n2";
            }
            else {
                throw lang.syntaxfehler(lnum, lang.badNumberFormat);
            }
        }
        else if ("n2" == mode) {
            if (bF._isNum2(charCode)) {
                sb += char;
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push("num");
                mode = "qot";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push("num");
                mode = "limbo";
            }
            else if (bF._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("num");
                mode = "paren"
            }
            else if (bF._isSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("num");
                mode = "sep";
            }
            else if (bF._is1o(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("num");
                mode = "op";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push("num");
                mode = "lit";
            }
        }
        else if ("op" == mode) {
            if (bF._is2o(charCode)) {
                sb += char;
                mode = "o2";
            }
            else if (bF._isUnary(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
            }
            else if (bF._is1o(charCode)) {
                throw lang.syntaxfehler(lnum, lang.badOperatorFormat);
            }
            else if (bF._isNum(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "num";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "qot";
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
                mode = "lit";
            }
        }
        else if ("o2" == mode) {
            if (bF._is1o(charCode)) {
                throw lang.syntaxfehler(lnum, lang.badOperatorFormat);
            }
            else if (bF._isNum(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("op");
                mode = "num";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push("op");
                mode = "qot";
            }
            else if (" " == char) {
                tokens.push(sb); sb = ""; states.push("op");
                mode = "limbo";
            }
            else if (bF._isParen(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("op");
                mode = "paren"
            }
            else if (bF._isSep(charCode)) {
                tokens.push(sb); sb = "" + char; states.push("op");
                mode = "sep";
            }
            else {
                tokens.push(sb); sb = "" + char; states.push("op");
                mode = "lit";
            }
        }
        else if ("qot" == mode) {
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
            mode = "qot"; // ESCAPE is only legal when used inside of quote
        }
        else if ("quote_end" == mode) {
            if (" " == char) {
                sb = "";
                mode = "limbo";
            }
            else if (0x22 == charCode) {
                sb = "" + char;
                mode = "qot";
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
                mode = "num";
            }
            else if (bF._is1o(charCode)) {
                sb = "" + char;
                mode = "op"
            }
            else {
                sb = "" + char;
                mode = "lit";
            }
        }
        else if ("limbo" == mode) {
            if (char == " ") {
                /* do nothing */
            }
            else if (0x22 == charCode) {
                mode = "qot"
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
                mode = "num";
            }
            else if (bF._is1o(charCode)) {
                sb = "" + char;
                mode = "op"
            }
            else {
                sb = "" + char;
                mode = "lit";
            }
        }
        else if ("paren" == mode) {
            if (char == " ") {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "qot"
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
                mode = "num";
            }
            else if (bF._is1o(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "op"
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "lit";
            }
        }
        else if ("sep" == mode) {
            if (char == " ") {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "limbo";
            }
            else if (0x22 == charCode) {
                tokens.push(sb); sb = ""; states.push(mode);
                mode = "qot"
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
                mode = "num";
            }
            else if (bF._is1o(charCode)) {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "op"
            }
            else {
                tokens.push(sb); sb = "" + char; states.push(mode);
                mode = "lit";
            }
        }
        else {
            throw Error("Unknown parser state: " + mode);
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
        if (states[k] == "o2") states[k] = "op";
        else if (states[k] == "n2" || states[k] == "nsep") states[k] = "num";
    }

    if (tokens.length != states.length) throw Error("BasicIntpError: size of tokens and states does not match (line: "+lnum+")");

    return { "tokens": tokens, "states": states };
};
bF._parserElaboration = function(lnum, tokens, states) {
    var _debugprintElaboration = false;
    if (_debugprintElaboration) println("@@ ELABORATION @@");
    var k = 0;

    // NOTE: malformed numbers (e.g. "_b3", "_", "__") must be re-marked as literal or syntax error

    while (k < states.length) { // using while loop because array size will change during the execution
        if (states[k] == "num" && !reNumber.test(tokens[k]))
            states[k] = "lit";
        else if (states[k] == "lit" && bF._opPrc[tokens[k].toUpperCase()] !== undefined)
            states[k] = "op";
        else if (tokens[k].toUpperCase() == "TRUE" || tokens[k].toUpperCase() == "FALSE")
            states[k] = "bool";

        // decimalise hex/bin numbers (because Nashorn does not support binary literal)
        if (states[k] == "num") {
            if (tokens[k].toUpperCase().startsWith("0B")) {
                tokens[k] = parseInt(tokens[k].substring(2, tokens[k].length), 2) + "";
            }
        }

        k += 1;
    }
};
bF._recurseApplyAST = function(tree, action) {
    if (tree.astLeaves[0] === undefined)
        return action(tree);
    else {
        action(tree);
        tree.astLeaves.forEach(it => bF._recurseApplyAST(it, action))
    }
}
/** EBNF notation:
line = linenumber , stmt , {":" , stmt} ;
linenumber = digits ;

stmt =  
      "IF" , if_equation , "THEN" , stmt , ["ELSE" , stmt]
    | "DEFUN" , [lit] , "(" , [lit , {" , " , lit}] , ")" , "=" , stmt
    | "ON" , lit , lit , equation , {"," , equation}
    | function_call
    | "(" , stmt , ")" ;
    
function_call =
      lit
    | lit , function_call , {argsep , function_call}
    | lit , "(" , [function_call , {argsep , function_call}] , ")"
    | equation
    
equation = equation , op , equation
    | op_uni , equation
    | lit
    | "(" , equation , ")"

if_equation = if_equation , op - ("=") , if_equation
    | op_uni , if_equation
    | lit
    | "(" , if_equation , ")"
    
(* don't bother looking at these, because you already know the stuff *)    
    
function = lit ;
argsep = ","|";" ;
lit = alph , [digits] | num | string ; (* example: "MyVar_2" *)
op = "^" | "*" | "/" | "MOD" | "+" | "-" | "<<" | ">>" | "<" | ">" | "<="
    | "=<" | ">=" | "=>" | "==" | "<>" | "><" | "BAND" | "BXOR" | "BOR"
    | "AND" | "OR" | "TO" | "STEP" | "!" | "~" | "#" | "=" ;
op_uni = "-" | "+" ;

alph = letter | letter , alph ;
digits = digit | digit , digits ;
hexdigits = hexdigit | hexdigit , hexdigits ;
bindigits = bindigit | bindigit , bindigits ;
num = digits | digits , "." , [digits] | "." , digits
    | ("0x"|"0X") , hexdigits 
    | ("0b"|"0B") , bindigits ; (* sorry, no e-notation! *)
visible = ? ASCII 0x20 to 0x7E ? ;
string = '"' , (visible | visible , stringlit) , '"' ;

letter = "A" | "B" | "C" | "D" | "E" | "F" | "G"
    | "H" | "I" | "J" | "K" | "L" | "M" | "N"
    | "O" | "P" | "Q" | "R" | "S" | "T" | "U"
    | "V" | "W" | "X" | "Y" | "Z" | "a" | "b"
    | "c" | "d" | "e" | "f" | "g" | "h" | "i"
    | "j" | "k" | "l" | "m" | "n" | "o" | "p"
    | "q" | "r" | "s" | "t" | "u" | "v" | "w"
    | "x" | "y" | "z" | "_" ;
digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;
hexdigit = "A" | "B" | "C" | "D" | "E" | "F" | "a" | "b"
    | "c" | "d" | "e" | "f" | "0" | "1" | "2" | "3" | "4" | "5" | "6"
    | "7" | "8" | "9" ;
bindigit = "0" | "1" ;

(* all possible token states: lit num op bool qot paren sep *)

 */
// @return BasicAST
bF._parseEquation = functoin(lnum, tokens, states, recDepth) {

}
// @returns BasicAST
bF._parseTokens = function(lnum, tokens, states, recDepth) {

    function isSemanticLiteral(token, state) {
        return "]" == token || ")" == token ||
               "qot" == state || "num" == state || "bool" == state || "lit" == state;
    }

    var _debugSyntaxAnalysis = false;

    if (_debugSyntaxAnalysis) serial.println("@@ SYNTAX ANALYSIS @@");

    if (_debugSyntaxAnalysis) {
        serial.println("Parser Ln "+lnum+", Rec "+recDepth);
        serial.println("Tokens: "+tokens);
        serial.println("States: "+states);
    }

    if (tokens.length != states.length) throw Error("BasicIntpError: size of tokens and states does not match (line: "+lnum+", recursion depth: "+recDepth+")");
    if (tokens.length == 0) {
        if (_debugSyntaxAnalysis) serial.println("*empty tokens*");
        var retTreeHead = new BasicAST();
        retTreeHead.depth = recDepth;
        retTreeHead.lnum = lnum;
        return retTreeHead;
    }

    var k;
    var headWord = tokens[0].toLowerCase();
    var treeHead = new BasicAST();
    treeHead.astDepth = recDepth;
    treeHead.astLnum = lnum;

    // LITERAL
    if (tokens.length == 1 && (isSemanticLiteral(tokens[0], states[0]))) {
        // special case where there were only one word
        if (recDepth == 0) {
            // if that word is literal (e.g. "10 CLEAR"), interpret it as a function
            if (states[0] == "lit") {
                treeHead.astValue = tokens[0];
                treeHead.astType = "function";

                return treeHead;
            }
            // else, screw it
            else {
                throw lang.syntaxfehler(lnum, "TRAP_LITERALLY_LITERAL");
            }
        }

        if (_debugSyntaxAnalysis) serial.println("literal/number: "+tokens[0]);
        treeHead.astValue = ("qot" == states[0]) ? tokens[0] : tokens[0].toUpperCase();
        treeHead.astType = ("qot" == states[0]) ? "string" : ("num" == states[0]) ? "num" : "lit";
    }
    else if (tokens[0].toUpperCase() == "IF" && states[0] != "qot") {
        // find ELSE and THEN
        var indexElse = undefined;
        var indexThen = undefined;
        for (k = tokens.length - 1; k >= 1; k--) {
            if (indexElse === undefined && tokens[k].toUpperCase() == "ELSE" && states[k] != "qot") {
                indexElse = k;
            }
            else if (indexThen === undefined && tokens[k].toUpperCase() == "THEN" && states[k] != "qot") {
                indexThen = k;
            }
        }
        // find GOTO and use it as THEN
        var useGoto = false;
        if (indexThen === undefined) {
            for (k = (indexElse !== undefined) ? indexElse - 1 : tokens.length - 1; k >= 1; k--) {
                if (indexThen == undefined && tokens[k].toUpperCase() == "GOTO" && states[k] != "qot") {
                    useGoto = true;
                    indexThen = k;
                    break;
                }
            }
        }

        // generate tree
        if (indexThen === undefined) throw lang.syntaxfehler(lnum, "IF without THEN");

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
                    [].concat("lit", states.slice(indexThen + 1, (indexElse !== undefined) ? indexElse : tokens.length)),
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
            if (tokens[k] == "(" && states[k] != "qot") {
                parenDepth += 1;
                if (parenStart == -1 && parenDepth == 1) parenStart = k;
            }
            else if (tokens[k] == ")" && states[k] != "qot") {
                if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
                parenDepth -= 1;
            }

            if (parenDepth == 0) {
                if (states[k] == "op" && isSemanticLiteral(tokens[k-1], states[k-1]) &&
                        ((bF._opPrc[tokens[k].toUpperCase()] > topmostOpPrc) ||
                         (!bF._opRh[tokens[k].toUpperCase()] && bF._opPrc[tokens[k].toUpperCase()] == topmostOpPrc))
                ) {
                    topmostOp = tokens[k].toUpperCase();
                    topmostOpPrc = bF._opPrc[tokens[k].toUpperCase()];
                    operatorPos = k;
                }
            }
        }

        // == AUTOPAREN ==
        // TODO do it properly by counting number of arguments and whatnot
        if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
        if (_debugSyntaxAnalysis) serial.println("Paren position: "+parenStart+", "+parenEnd);

        // if there is no paren or paren does NOT start index 1
        // e.g. negative three should NOT require to be written as "-(3)"
        if ((parenStart > 1 || parenStart == -1) && (operatorPos != 1 && operatorPos != 0) && states[0] == "lit" && states[1] != "op") {
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
            if (tokens[k] == "(" && states[k] != "qot") {
                parenDepth += 1;
                if (parenStart == -1 && parenDepth == 1) parenStart = k;
            }
            else if (tokens[k] == ")" && states[k] != "qot") {
                if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
                parenDepth -= 1;
            }

            if (parenDepth == 1 && states[k] == "sep") {
                separators.push(k);
            }
            if (parenDepth == 0) {
                if (states[k] == "op" && isSemanticLiteral(tokens[k-1], states[k-1]) &&
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
                treeHead.astType = "op";
                treeHead.astLeaves[0] = bF._parseTokens(lnum, subtknL, substaL, recDepth + 1);
                treeHead.astLeaves[1] = bF._parseTokens(lnum, subtknR, substaR, recDepth + 1);
            }
            else {
                if (_debugSyntaxAnalysis) serial.println("re-parenthesising unary op");

                // parenthesize the unary op
                var unaryParenEnd = 1;
                while (unaryParenEnd < tokens.length) {
                    if (states[unaryParenEnd] == "op" && bF._opPrc[tokens[unaryParenEnd]] > 1)
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
                separators.slice(1, separators.length - 1).forEach((v) => { if (v !== undefined) seps.push(tokens[v]) });
            }
            else throw lang.badFunctionCallFormat();
            treeHead.astLeaves = leaves;//.filter(function(__v) { return __v !== undefined; });
            treeHead.astSeps = seps;
        }
    }


    return treeHead;

};
// @return is defined in BasicAST
let JStoBASICtype = function(object) {
    if (typeof object === "boolean") return "bool";
    else if (object === undefined) return "null";
    else if (object.arrName !== undefined) return "internal_arrindexing_lazy";
    else if (object.asgnVarName !== undefined) return "internal_assignment_object";
    else if (object instanceof ForGen) return "generator";
    else if (Array.isArray(object)) return "array";
    else if (!isNaN(object)) return "num";
    else if (typeof object === "string" || object instanceof String) return "string";
    // buncha error msgs
    else throw Error("BasicIntpError: un-translatable object with typeof "+(typeof object)+",\ntoString = "+object+",\nentries = "+Object.entries(object));
}
let SyntaxTreeReturnObj = function(type, value, nextLine) {
    this.troType = type;
    this.troValue = value;
    this.troNextLine = nextLine;
}
bF._gotoCmds = {GOTO:1,GOSUB:1,RETURN:1,NEXT:1,END:1,BREAKTO:1}; // put nonzero (truthy) value here
/**
 * @param lnum line number of BASIC
 * @param syntaxTree BasicAST
 * @param recDepth recursion depth used internally
 *
 * @return syntaxTreeReturnObject if recursion is escaped
 */
bF._troNOP = function(lnum) { return new SyntaxTreeReturnObj("null", undefined, lnum + 1); }
bF._executeSyntaxTree = function(lnum, syntaxTree, recDepth) {
    let _debugExec = true;
    let _debugPrintCurrentLine = true;
    let recWedge = "> ".repeat(recDepth);

    if (_debugExec || _debugPrintCurrentLine) serial.println(recWedge+"@@ EXECUTE @@");
    if (_debugPrintCurrentLine && recDepth == 0) {
        serial.println("Syntax Tree in "+lnum+":");
        serial.println(astToString(syntaxTree));
    }


    if (syntaxTree == undefined) return bF._troNOP(lnum);
    else if (syntaxTree.astValue == undefined) { // empty meaningless parens
        if (syntaxTree.astLeaves.length > 1) throw Error("WTF");
        return bF._executeSyntaxTree(lnum, syntaxTree.astLeaves[0], recDepth);
    }
    else if (syntaxTree.astType == "function" || syntaxTree.astType == "op") {
        if (_debugExec) serial.println(recWedge+"function|operator");
        if (_debugExec) serial.println(recWedge+astToString(syntaxTree));
        var funcName = syntaxTree.astValue.toUpperCase();
        var func = bStatus.builtin[funcName].f;

        if ("IF" == funcName) {
            if (syntaxTree.astLeaves.length != 2 && syntaxTree.astLeaves.length != 3) throw lang.syntaxfehler(lnum);
            var testedval = bF._executeSyntaxTree(lnum, syntaxTree.astLeaves[0], recDepth + 1);

            if (_debugExec) {
                serial.println(recWedge+"testedval:");
                serial.println(recWedge+"type="+testedval.astType);
                serial.println(recWedge+"value="+testedval.astValue);
                serial.println(recWedge+"nextLine="+testedval.astNextLine);
            }

            try {
                var iftest = bStatus.builtin["TEST"].f(lnum, [testedval]);

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
        else if ("DEFUN" == funcName) {
            //if (recDepth > 0) throw lang.badFunctionCallFormat(); // nested DEFUN is TODO and it involves currying and de bruijn indexing
            if (syntaxTree.astLeaves.length !== 1) throw lang.syntaxfehler(lnum, "DEFUN 1");
            if (syntaxTree.astLeaves[0].astValue !== "=") throw lang.syntaxfehler(lnum, "DEFUN 2 -- "+syntaxTree.astLeaves[0].astValue);
            if (syntaxTree.astLeaves[0].astLeaves.length !== 2) throw lang.syntaxfehler(lnum, "DEFUN 3");
            let nameTree = syntaxTree.astLeaves[0].astLeaves[0];
            let exprTree = syntaxTree.astLeaves[0].astLeaves[1];

            // create parametres map
            // NOTE: firstmost param ('x' as in foo(x,y,z)) gets index 0
            let defunName = nameTree.astValue.toUpperCase();
            let defunRenamingMap = {};
            nameTree.astLeaves.forEach((it, i) => {
                if (it.astType !== "lit") throw lang.syntaxfehler(lnum, "4");
                return defunRenamingMap[it.astValue] = i;
            });

            // rename the parametres
            bF._recurseApplyAST(exprTree, (it) => {
                if (it.astType == "lit") {
                    // check if parametre name is valid
                    // if the name is invalid, regard it as a global variable (i.e. do nothing)
                    if (defunRenamingMap[it.astValue] !== undefined) {
                        it.astType = "defun_args";
                        it.astValue = defunRenamingMap[it.astValue];
                    }
                }
                // decrease the recursion counter while we're looping
                it.astDepth -= 2;
            });

            // test print new tree
            //serial.println("[BASIC.DEFUN] defun debug info for function "+defunName);
            //serial.println("[BASIC.DEFUN] defun name tree: ");
            //serial.println(astToString(nameTree));
            //serial.println("[BASIC.DEFUN] defun renaming map: "+Object.entries(defunRenamingMap));
            //serial.println("[BASIC.DEFUN] defun expression tree:");
            //serial.println(astToString(exprTree));

            // check if the variable name already exists
            // search from constants
            if (_basicConsts[defunName]) throw lang.asgnOnConst(lnum, defunName);
            // search from builtin functions
            if (bStatus.builtin[defunName] !== undefined || bF[defunName.toLowerCase()] !== undefined)
                throw lang.dupDef(lnum, defunName);

            // finally assign the function to the variable table
            bStatus.vars[defunName] = new BasicVar(exprTree, "usrdefun");

            return new SyntaxTreeReturnObj("function", exprTree, lnum + 1);
        }
        else {
            var args = syntaxTree.astLeaves.map(it => bF._executeSyntaxTree(lnum, it, recDepth + 1));

            if (_debugExec) {
                serial.println(recWedge+"fn call name: "+funcName);
                serial.println(recWedge+"fn call args: "+(args.map(it => it.troType+" "+it.troValue)).join(", "));
            }

            // func not in builtins (e.g. array access, user-defined function defuns)
            if (func === undefined) {
                var someVar = bStatus.vars[funcName];

                //println(lnum+" _executeSyntaxTree: "+Object.entries(someVar));

                if (someVar === undefined) {
                    throw lang.syntaxfehler(lnum, funcName + " is undefined");
                }
                else if ("array" == someVar.bvType) {
                    func = bStatus.getArrayIndexFun(lnum, funcName, someVar.bvLiteral);
                }
                else if ("usrdefun" == someVar.bvType) {
                    func = bStatus.getDefunThunk(lnum, someVar.bvLiteral);
                }
                else {
                    throw lang.syntaxfehler(lnum, funcName + " is not a function or an array");
                }
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
                throw lang.errorinline(lnum, (funcName === undefined) ? "undefined" : funcName, (eeeee === undefined) ? "undefined" : eeeee);
            }
        }
    }
    else if (syntaxTree.astType == "num") {
        if (_debugExec) serial.println(recWedge+"num");
        return new SyntaxTreeReturnObj(syntaxTree.astType, (syntaxTree.astValue)*1, lnum + 1);
    }
    else if (syntaxTree.astType == "string" || syntaxTree.astType == "lit" || syntaxTree.astType == "bool") {
        if (_debugExec) serial.println(recWedge+"string|literal|bool");
        return new SyntaxTreeReturnObj(syntaxTree.astType, syntaxTree.astValue, lnum + 1);
    }
    else if (syntaxTree.astType == "null") {
        return bF._executeSyntaxTree(lnum, syntaxTree.astLeaves[0], recDepth + 1);
    }
    else {
        serial.println(recWedge+"Parse error in "+lnum);
        serial.println(recWedge+astToString(syntaxTree));
        throw Error("Parse error");
    }
};
// @returns: line number for the next command, normally (lnum + 1); if GOTO or GOSUB was met, returns its line number
bF._interpretLine = function(lnum, cmd) {
    var _debugprintHighestLevel = false;

    if (TRACEON) {
        //print(`[${lnum}]`);
        serial.println("[BASIC] Line "+lnum);
    }

    if (cmd.toUpperCase().startsWith("REM")) {
        if (_debugprintHighestLevel) serial.println(lnum+" "+cmd);
        return undefined;
    }

    // TOKENISE
    var tokenisedObject = bF._tokenise(lnum, cmd);
    var tokens = tokenisedObject.tokens;
    var states = tokenisedObject.states;


    // ELABORATION : distinguish numbers and operators from literals
    bF._parserElaboration(lnum, tokens, states);

    // PARSING (SYNTAX ANALYSIS)
    var syntaxTree = bF._parseTokens(lnum, tokens, states, 0);
    if (_debugprintHighestLevel) serial.println("Final syntax tree:");
    if (_debugprintHighestLevel) serial.println(astToString(syntaxTree));

    return syntaxTree;
}; // end INTERPRETLINE
bF._executeAndGet = function(lnum, syntaxTree) {
    // EXECUTE
    try {
        var execResult = bF._executeSyntaxTree(lnum, syntaxTree, 0);
        return execResult.troNextLine;
    }
    catch (e) {
        serial.printerr(`ERROR on ${lnum} -- PARSE TREE:\n${astToString(syntaxTree)}\nERROR CONTENTS:\n${e}\n${e.stack || "Stack trace undefined"}`);
        throw e;
    }
};
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
    bStatus.vars = initBvars();
    cmdbuf = [];
};
bF.renum = function(args) { // RENUM function
    var newcmdbuf = [];
    var linenumRelation = [[]];
    var cnt = 10;
    for (var k = 0; k < cmdbuf.length; k++) {
        if (cmdbuf[k] !== undefined) {
            newcmdbuf[cnt] = cmdbuf[k].trim();
            linenumRelation[k] = cnt;
            cnt += 10;
        }
    }
    // deal with goto/gosub line numbers
    for (k = 0; k < newcmdbuf.length; k++) {
        if (newcmdbuf[k] !== undefined && newcmdbuf[k].toLowerCase().startsWith("goto ")) {
            newcmdbuf[k] = "GOTO " + linenumRelation[newcmdbuf[k].match(reNum)[0]];
        }
        else if (newcmdbuf[k] !== undefined && newcmdbuf[k].toLowerCase().startsWith("gosub ")) {
            newcmdbuf[k] = "GOSUB " + linenumRelation[newcmdbuf[k].match(reNum)[0]];
        }
        else if (newcmdbuf[k] !== undefined && newcmdbuf[k].toLowerCase().startsWith("breakto ")) {
            newcmdbuf[k] = "BREAKTO " + linenumRelation[newcmdbuf[k].match(reNum)[0]];
        }
    }
    cmdbuf = newcmdbuf.slice(); // make shallow copy

    // recalculate memory footprint
    cmdbufMemFootPrint = 0;
    cmdbuf.forEach((v, i, arr) =>
        cmdbufMemFootPrint += ("" + i).length + 1 + v.length
    );
};
bF.fre = function(args) {
    println(vmemsize - getUsedMemSize());
};
bF.tron = function(args) {
    TRACEON = true;
};
bF.troff = function(args) {
    TRACEON = false;
};
bF.run = function(args) { // RUN function
    // pre-build the trees
    let programTree = [];
    cmdbuf.forEach((linestr, linenum) => {
        programTree[linenum] = bF._interpretLine(linenum, linestr.trim());
    });

    // actually execute the program
    var linenumber = 1;
    var oldnum = 1;
    do {
        if (cmdbuf[linenumber] !== undefined) {
            oldnum = linenumber;
            linenumber = bF._executeAndGet(linenumber, programTree[linenumber]);
        }
        else {
            linenumber += 1;
        }
        if (linenumber < 0) throw lang.badNumberFormat;
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
    var sb = "";
    cmdbuf.forEach((v, i) => sb += i+" "+v+"\n");
    fs.write(sb);
};
bF.load = function(args) { // LOAD function
    if (args[1] === undefined) throw lang.missingOperand;
    var fileOpened = fs.open(args[1], "R");
    if (!fileOpened) {
        fileOpened = fs.open(args[1]+".BAS", "R");
    }
    if (!fileOpened) {
        fileOpened = fs.open(args[1]+".bas", "R");
    }
    if (!fileOpened) {
        throw lang.noSuchFile;
        return;
    }
    var prg = fs.readAll();

    // reset the environment
    cmdbuf = [];
    bStatus.vars = initBvars();

    // read the source
    prg.split('\n').forEach((line) => {
        var i = line.indexOf(" ");
        var lnum = line.slice(0, i);
        if (isNaN(lnum)) throw lang.illegalType();
        cmdbuf[lnum] = line.slice(i + 1, line.length);
    });
};
bF.catalog = function(args) { // CATALOG function
    if (args[1] === undefined) args[1] = "\\";
    var pathOpened = fs.open(args[1], 'R');
    if (!pathOpened) {
        throw lang.noSuchFile;
        return;
    }
    var port = _BIOS.FIRST_BOOTABLE_PORT[0];
    com.sendMessage(port, "LIST");
    println(com.pullMessage(port));
};
Object.freeze(bF);

if (exec_args[1] !== undefined) {
    bF.load(["load", exec_args[1]]);
    try {
        bF.run();
        return 0;
    }
    catch (e) {
        serial.printerr(`${e}\n${e.stack || "Stack trace undefined"}`);
        println(e);
    }
}

while (!tbasexit) {
    var line = sys.read().trim();

    cmdbufMemFootPrint += line.length;

    if (reLineNum.test(line)) {
        var i = line.indexOf(" ");
        cmdbuf[line.slice(0, i)] = line.slice(i + 1, line.length);
    }
    else if (line.length > 0) {
        cmdbufMemFootPrint -= line.length;
        var cmd = line.split(" ");
        if (bF[cmd[0].toLowerCase()] === undefined) {
            serial.printerr("Unknown command: "+cmd[0].toLowerCase());
            println(lang.syntaxfehler());
        }
        else {
            try {
                bF[cmd[0].toLowerCase()](cmd);
            }
            catch (e) {
                serial.printerr(`${e}\n${e.stack || "Stack trace undefined"}`);
                println(e);
            }
        }

        println(prompt);
    }
}

0;
