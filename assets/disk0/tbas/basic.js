
if (exec_args !== undefined && exec_args[1] !== undefined && exec_args[1].startsWith("-?")) {
	println("Usage: basic <optional path to basic program>");
	println("When the optional basic program is set, the interpreter will run the program and then quit if successful, remain open if the program had an error.");
	return 0;
}
const THEVERSION = "1.2-dev";
const PROD = true;
let INDEX_BASE = 0;
let TRACEON = (!PROD) && true;
let DBGON = (!PROD) && true;
let DATA_CURSOR = 0;
let DATA_CONSTS = [];
const BASIC_HOME_PATH = "/home/basic/"
if (system.maxmem() < 8192) {
	println("Out of memory. BASIC requires 8K or more User RAM");
	throw Error("Out of memory");
}
let vmemsize = system.maxmem();
let cmdbuf = []; 
let gotoLabels = {};
let cmdbufMemFootPrint = 0;
let prompt = "Ok";
let prescan = false;
let replCmdBuf = []; 
let replUsrConfirmed = false;
let lambdaBoundVars = []; 
function isNumable(s) {
	if (Array.isArray(s)) return false;
	if (s === undefined) return false;
	if (typeof s.trim == "function" && s.trim().length == 0) return false;
	return !isNaN(s); 
}
let tonum = (t) => t*1.0;
function cloneObject(o) { return JSON.parse(JSON.stringify(o)); }
class ParserError extends Error {
	constructor(...args) {
		super(...args);
		Error.captureStackTrace(this, ParserError);
	}
}
class BASICerror extends Error {
	constructor(...args) {
		super(...args);
		Error.captureStackTrace(this, ParserError);
	}
}
let lang = {};
lang.badNumberFormat = Error("Illegal number format");
lang.badOperatorFormat = Error("Illegal operator format");
lang.divByZero = Error("Division by zero");
lang.badFunctionCallFormat = function(line, reason) {
	return Error("Illegal function call" + ((line) ? " in "+line : "") + ((reason) ? ": "+reason : ""));
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
	serial.printerr(`	object: ${obj}, typeof: ${typeof obj}`);
	if (obj !== null && obj !== undefined) serial.printerr(`	entries: ${Object.entries(obj)}`);
	return Error("Unresolved reference" + ((obj !== undefined) ? ` "${obj}"` : "") + ((line !== undefined) ? (" in "+line) : ""));
};
lang.nowhereToReturn = function(line) { return "RETURN without GOSUB in " + line; };
lang.errorinline = function(line, stmt, errobj) {
	return Error('Error'+((line !== undefined) ? (" in "+line) : "")+' on "'+stmt+'": '+errobj);
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
fs.open = function(path, operationMode) {
	var port = _BIOS.FIRST_BOOTABLE_PORT;
	fs._flush(port[0]); fs._close(port[0]);
	var mode = operationMode.toUpperCase();
	if (mode != "R" && mode != "W" && mode != "A") {
		throw Error("Unknown file opening mode: " + mode);
	}
	com.sendMessage(port[0], "OPEN"+mode+'"'+BASIC_HOME_PATH+path+'",'+port[1]);
	let response = com.getStatusCode(port[0]);
	return (response == 0);
};
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
let getUsedMemSize = function() {
	var varsMemSize = 0;
	Object.entries(bS.vars).forEach((pair, i) => {
		var object = pair[1];
		if (Array.isArray(object)) {
			varsMemSize += object.length * 8;
		}
		else if (!isNaN(object)) varsMemSize += 8;
		else if (typeof object === "string" || object instanceof String) varsMemSize += object.length;
		else varsMemSize += 1;
	});
	return varsMemSize + cmdbufMemFootPrint; 
}
let reLineNum = /^[0-9]+ /;
let reNumber = /([0-9]*[.][0-9]+[eE]*[\-+0-9]*[fF]*|[0-9]+[.eEfF][0-9+\-]*[fF]?)|([0-9]+(\_[0-9])*)|(0[Xx][0-9A-Fa-f_]+)|(0[Bb][01_]+)/;
let reNum = /[0-9]+/;
let tbasexit = false;
const termWidth = con.getmaxyx()[1];
const termHeight = con.getmaxyx()[0];
const greetText = (termWidth >= 70) ? `Terran BASIC ${THEVERSION}  `+String.fromCharCode(179)+"  Scratchpad Memory: "+vmemsize+" bytes" : `Terran BASIC ${THEVERSION}`;
const greetLeftPad = (termWidth - greetText.length - 6) >> 1;
const greetRightPad = termWidth - greetLeftPad - greetText.length - 6;
con.clear();
con.color_pair(253,255);
print('  ');con.addch(17);
con.color_pair(0,253);
con.move(1,4);
print(" ".repeat(greetLeftPad)+greetText+" ".repeat(greetRightPad));
con.color_pair(253,255);
con.addch(16);con.curs_right();print('  ');
con.move(3,1);
con.color_pair(239,255);
println(prompt);
let BasicVar = function(literal, type) {
	this.bvLiteral = literal;
	this.bvType = type;
}
let astToString = function(ast, depth, isFinalLeaf) {
	let l__ = "| ";
	let recDepth = depth || 0;
	if (!isAST(ast)) return "";
	let hastStr = ast.astHash;
	let sb = "";
	let marker = ("lit" == ast.astType) ? "i" :
				 ("op" == ast.astType) ? "+" :
				 ("string" == ast.astType) ? "@" :
				 ("num" == ast.astType) ? "$" :
				 ("array" == ast.astType) ? "[" :
				 ("defun_args" === ast.astType) ? "d" : "f";
	sb += l__.repeat(recDepth)+`${marker} ${ast.astLnum}: "${ast.astValue}" (astType:${ast.astType}); leaves: ${ast.astLeaves.length}; hash:"${hastStr}"\n`;	
	for (var k = 0; k < ast.astLeaves.length; k++) {
		sb += astToString(ast.astLeaves[k], recDepth + 1, k == ast.astLeaves.length - 1);
		if (ast.astSeps[k] !== undefined)
			sb += l__.repeat(recDepth)+` sep:${ast.astSeps[k]}\n`;
	}
	sb += l__.repeat(recDepth)+"`"+"-".repeat(22)+'\n';
	return sb;
}
let monadToString = function(monad, depth) {
	let recDepth = depth || 0;
	let l__ = "  ";
	let sb = ` M"${monad.mHash}"(${monad.mType}): `
		sb += (monad.mVal === undefined) ? "(undefined)" : (isAST(monad.mVal)) ? `f"${monad.mVal.astHash}"` : (isMonad(monad.mVal)) ? `M"${monad.mVal.mHash}"` : monad.mVal;
	return sb;
}
let theLambdaBoundVars = function() {
	let sb = "";
	lambdaBoundVars.forEach((it,i) => {
		if (i > 0) sb += ' |';
		sb += ` ${i} [`;
		it.forEach((it,i) => {
			if (i > 0) sb += ',';
			sb += `${it[0]}:${it[1]}`; 
		});
		sb += ']';
	})
	return sb;
}
let makeBase32Hash = function() {
	let e = "YBNDRFG8EJKMCPQXOTLVWIS2A345H769";
	let m = e.length;
	return e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)] + e[Math.floor(Math.random()*m)]
}
let BasicAST = function() {
	this.astLnum = 0;
	this.astLeaves = [];
	this.astSeps = [];
	this.astValue = undefined;
	this.astType = "null"; 
	this.astHash = makeBase32Hash();
}
let isAST = (object) => (object === undefined) ? false : object.astLeaves !== undefined && object.astHash !== undefined
let isRunnable = (object) => isAST(object) || object.mType == "funseq";
let BasicFunSeq = function(f) {
	if (!Array.isArray(f) || !isAST(f[0])) throw new BASICerror("Not an array of functions");
	this.mHash = makeBase32Hash();
	this.mType = "funseq";
	this.mVal = f;
}
let BasicListMonad = function(m) {
	this.mHash = makeBase32Hash();
	this.mType = "list";
	this.mVal = [m];
}
let BasicMemoMonad = function(m) {
	this.mHash = makeBase32Hash();
	this.mType = "value";
	this.mVal = m; 
	this.seq = undefined; 
}
let isMonad = (o) => (o === undefined) ? false : (o.mType !== undefined);
let literalTypes = ["string", "num", "bool", "array", "generator", "usrdefun", "monad"];
let resolve = function(variable) {
	if (variable === undefined) return undefined;
	if (variable.troType === undefined) {
		if (isNumable(variable)) return tonum(variable);
		if (Array.isArray(variable)) return variable;
		if (isGenerator(variable) || isAST(variable) || isMonad(variable)) return variable;
		if (typeof variable == "object")
			throw Error(`BasicIntpError: trying to resolve unknown object '${variable}' with entries ${Object.entries(variable)}`);
		return variable;
	}
	else if (variable.troType === "internal_arrindexing_lazy")
		return eval("variable.troValue.arrFull"+variable.troValue.arrKey);
	else if (literalTypes.includes(variable.troType) || variable.troType.startsWith("internal_"))
		return variable.troValue;
	else if (variable.troType == "lit") {
		if (bS.builtin[variable.troValue] !== undefined) {
			return bS.wrapBuiltinToUsrdefun(variable.troValue);
		}
		else {
			let basicVar = bS.vars[variable.troValue];
			if (basicVar === undefined) throw lang.refError(undefined, variable.troValue);
			if (basicVar.bvLiteral === "") return "";
			return (basicVar !== undefined) ? basicVar.bvLiteral : undefined;
		}
	}
	else if (variable.troType == "null")
		return undefined;
	else
		throw Error("BasicIntpError: unknown variable/object with type "+variable.troType+", with value "+variable.troValue);
}
let findHighestIndex = function(exprTree) {
	let highestIndex = [-1,-1];
	let rec = function(exprTree) {
		bF._recurseApplyAST(exprTree, it => {
			if (it.astType == "defun_args") {
				let recIndex = it.astValue[0];
				let ordIndex = it.astValue[1];
				if (recIndex > highestIndex[0]) {
					highestIndex = [recIndex, 0];
				}
				if (recIndex == highestIndex[0] && ordIndex > highestIndex[1]) {
					highestIndex[1] = ordIndex;
				}
			}
			else if (isAST(it.astValue)) {
				rec(it.astValue);
			}
		});
	};rec(exprTree);
	return highestIndex;
}
let indexDec = function(node, recIndex) {
	if (node.astType == "defun_args" && node.astValue[0] === recIndex) {
		let newNode = cloneObject(node);
		newNode.astValue[1] -= 1;
		return newNode;
	}
	else return node;
}
let curryDefun = function(inputTree, inputValue) {	
	let exprTree = cloneObject(inputTree);
	let value = cloneObject(inputValue);
	let highestIndex = findHighestIndex(exprTree)[0];
	if (DBGON) {
		serial.println("[curryDefun] highest index to curry: "+highestIndex);
	}
	let substitution = new BasicAST();
	if (isAST(value)) {
		substitution = value;
	}
	else {
		substitution.astLnum = "??";
		substitution.astType = JStoBASICtype(value);
		substitution.astValue = value;
	}
	bF._recurseApplyAST(exprTree, it => {
		return (it.astType == "defun_args" && it.astValue[0] === highestIndex && it.astValue[1] === 0) ? substitution : indexDec(it, highestIndex)
	});
	return exprTree;
}
let getMonadEvalFun = (monad) => function(lnum, stmtnum, args, sep) {
	if (!isMonad(monad)) throw lang.badFunctionCallFormat(lnum, "not a monad");
	if (DBGON) {
		serial.println("[BASIC.MONADEVAL] monad:");
		serial.println(monadToString(monad));
	}
	if (monad.mType == "funseq") {
		let arg = args[0];
		monad.mVal.forEach(f => {
			arg = bS.getDefunThunk(f)(lnum, stmtnum, [arg]);
		})
		return arg;
	}
	else {
		return monad.mVal;
	}
}
let listMonConcat = function(parentm, childm) {
	parentm.mVal = parentm.mVal.concat(childm.mVal);
	return parentm;
}
let countArgs = function(defunTree) {
	let cnt = -1;
	bF._recurseApplyAST(defunTree, it => {
		if (it.astType == "defun_args" && it.astValue > cnt)
			cnt = it.astValue;
	});
	return cnt+1;
}
let argCheckErr = function(lnum, o) {
	if (o === undefined) throw lang.refError(lnum, "(variable is undefined)");
	if (o.troType == "null") throw lang.refError(lnum, o);
	if (o.troType == "lit" && bS.builtin[o.troValue] !== undefined) return;
	if (o.troType == "lit" && bS.vars[o.troValue] === undefined) throw lang.refError(lnum, o.troValue);
}
let oneArg = function(lnum, stmtnum, args, action) {
	if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	argCheckErr(lnum, args[0]);
	var rsvArg0 = resolve(args[0]);
	return action(rsvArg0);
}
let oneArgNul = function(lnum, stmtnum, args, action) {
	if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	var rsvArg0 = resolve(args[0]);
	return action(rsvArg0);
}
let oneArgNum = function(lnum, stmtnum, args, action) {
	if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	argCheckErr(lnum, args[0]);
	var rsvArg0 = resolve(args[0], 1);
	if (!isNumable(rsvArg0)) throw lang.illegalType(lnum, args[0]);
	return action(rsvArg0);
}
let twoArg = function(lnum, stmtnum, args, action) {
	if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	argCheckErr(lnum, args[0]);
	var rsvArg0 = resolve(args[0]);
	argCheckErr(lnum, args[1]);
	var rsvArg1 = resolve(args[1]);
	return action(rsvArg0, rsvArg1);
}
let twoArgNul = function(lnum, stmtnum, args, action) {
	if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	var rsvArg0 = resolve(args[0]);
	var rsvArg1 = resolve(args[1]);
	return action(rsvArg0, rsvArg1);
}
let twoArgNum = function(lnum, stmtnum, args, action) {
	if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	argCheckErr(lnum, args[0]);
	var rsvArg0 = resolve(args[0], 1);
	if (!isNumable(rsvArg0)) throw lang.illegalType(lnum, "LH:"+Object.entries(args[0]));
	argCheckErr(lnum, args[1]);
	var rsvArg1 = resolve(args[1], 1);
	if (!isNumable(rsvArg1)) throw lang.illegalType(lnum, "RH:"+Object.entries(args[1]));
	return action(rsvArg0, rsvArg1);
}
let threeArg = function(lnum, stmtnum, args, action) {
	if (args.length != 3) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	argCheckErr(lnum, args[0]);
	var rsvArg0 = resolve(args[0]);
	argCheckErr(lnum, args[1]);
	var rsvArg1 = resolve(args[1]);
	argCheckErr(lnum, args[2]);
	var rsvArg2 = resolve(args[2]);
	return action(rsvArg0, rsvArg1, rsvArg2);
}
let threeArgNum = function(lnum, stmtnum, args, action) {
	if (args.length != 3) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	argCheckErr(lnum, args[0]);
	var rsvArg0 = resolve(args[0], 1);
	if (!isNumable(rsvArg0)) throw lang.illegalType(lnum, "1H:"+Object.entries(args[0]));
	argCheckErr(lnum, args[1]);
	var rsvArg1 = resolve(args[1], 1);
	if (!isNumable(rsvArg1)) throw lang.illegalType(lnum, "2H:"+Object.entries(args[1]));
	argCheckErr(lnum, args[2]);
	var rsvArg2 = resolve(args[2], 1);
	if (!isNumable(rsvArg2)) throw lang.illegalType(lnum, "3H:"+Object.entries(args[2]));
	return action(rsvArg0, rsvArg1, rsvArg2);
}
let varArg = function(lnum, stmtnum, args, action) {
	var rsvArg = args.map((it) => {
		argCheckErr(lnum, it);
		var r = resolve(it);
		return r;
	});
	return action(rsvArg);
}
let varArgNum = function(lnum, stmtnum, args, action) {
	var rsvArg = args.map((it) => {
		argCheckErr(lnum, it);
		var r = resolve(it);
		if (isNaN(r)) throw lang.illegalType(lnum, r);
		return r;
	});
	return action(rsvArg);
}
let makeIdFun = () => {
	let i = new BasicAST();
	i.astValue = [0,0];
	i.astType = "defun_args";
	i.astLnum = "**";
	let a = new BasicAST();
	a.astValue = i;
	a.astType = "usrdefun";
	a.astLnum = "**";
	return a;
}
let _basicConsts = {
   "NIL": new BasicVar([], "array"),
   "PI": new BasicVar(Math.PI, "num"),
   "TAU": new BasicVar(Math.PI * 2.0, "num"),
   "EULER": new BasicVar(Math.E, "num"),
   "ID": new BasicVar(makeIdFun(), "usrdefun"),
   "UNDEFINED": new BasicVar(undefined, "null"),
   "TRUE": new BasicVar(true, "bool"),
   "FALSE": new BasicVar(false, "bool")
};
Object.freeze(_basicConsts);
let initBvars = function() {
	return cloneObject(_basicConsts);
}
let ForGen = function(s,e,t) {
	this.start = s;
	this.end = e;
	this.step = t || 1;
	this.current = this.start;
	this.stepsgn = (this.step > 0) ? 1 : -1;
}
let isGenerator = (o) => o.start !== undefined && o.end !== undefined && o.step !== undefined && o.stepsgn !== undefined
let genToArray = (gen) => {
	let a = [];
	let cur = gen.start;
	while (cur*gen.stepsgn + gen.step*gen.stepsgn <= (gen.end + gen.step)*gen.stepsgn) {
		a.push(cur);
		cur += gen.step;
	}
	return a;
}
let genHasHext = (o) => o.current*o.stepsgn + o.step*o.stepsgn <= (o.end + o.step)*o.stepsgn;
let genGetNext = (gen, mutated) => {
	if (mutated !== undefined) gen.current = tonum(mutated);
	gen.current += gen.step;
	return genHasHext(gen) ? gen.current : undefined;
}
let genToString = (gen) => `Generator: ${gen.start} to ${gen.end}`+((gen.step !== 1) ? ` step ${gen.step}` : '');
let genReset = (gen) => { gen.current = gen.start }
let bS = {}; 
bS.gosubStack = [];
bS.forLnums = {}; 
bS.forStack = []; 
bS.vars = initBvars(); 
bS.rnd = 0; 
bS.getDimSize = function(array, dim) {
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
bS.getArrayIndexFun = function(lnum, stmtnum, arrayName, array) {
	if (lnum === undefined || stmtnum === undefined) throw Error(`Line or statement number is undefined: (${lnum},${stmtnum})`);
	return function(lnum, stmtnum, args, seps) {
		if (lnum === undefined || stmtnum === undefined) throw Error(`Line or statement number is undefined: (${lnum},${stmtnum})`);
		return varArgNum(lnum, stmtnum, args, (dims) => {
			if (TRACEON) serial.println("ar dims: "+dims);
			let dimcnt = 1;
			let oldIndexingStr = "";
			let indexingstr = "";
			dims.forEach(d => {
				oldIndexingStr = indexingstr;
				indexingstr += `[${d-INDEX_BASE}]`;
				var testingArr = eval(`array${indexingstr}`);
				if (testingArr === undefined)
					throw lang.subscrOutOfRng(lnum, `${arrayName}${oldIndexingStr} (${lang.ord(dimcnt)} dim)`, d-INDEX_BASE, bS.getDimSize(array, dimcnt-1));
				dimcnt += 1;
			});
			if (TRACEON)
				serial.println("ar indexedValue = "+`array${indexingstr}`);
			return {arrFull: array, arrName: arrayName, arrKey: indexingstr};
		});
	};
};
bS.getDefunThunk = function(exprTree, norename) {
	if (!isRunnable(exprTree)) throw new BASICerror("not a syntax tree");
	if (isMonad(exprTree)) return getMonadEvalFun(exprTree);
	let tree = cloneObject(exprTree); 
	return function(lnum, stmtnum, args, seps) {
		if (lnum === undefined || stmtnum === undefined) throw Error(`Line or statement number is undefined: (${lnum},${stmtnum})`);
		if (!norename) {
			let argsMap = args.map(it => {
				let rit = resolve(it);
				return [JStoBASICtype(rit), rit]; 
			});
			lambdaBoundVars.unshift(argsMap);
			if (DBGON) {
				serial.println("[BASIC.getDefunThunk.invoke] unthunking: ");
				serial.println(astToString(tree));
				serial.println("[BASIC.getDefunThunk.invoke] thunk args:");
				serial.println(argsMap);
				serial.println("[BASIC.getDefunThunk.invoke] lambda bound vars:");
				serial.println(theLambdaBoundVars());
			}
			bF._recurseApplyAST(tree, (it) => {
				if ("defun_args" == it.astType) {
					if (DBGON) {
						serial.println("[BASIC.getDefunThunk.invoke] thunk renaming arg-tree branch:");
						serial.println(astToString(it));
					}
					let recIndex = it.astValue[0];
					let argIndex = it.astValue[1];
					let theArg = lambdaBoundVars[recIndex][argIndex]; 
					if (theArg !== undefined) { 
						if (DBGON) {
							serial.println("[BASIC.getDefunThunk.invoke] thunk renaming-theArg: "+theArg);
							serial.println(`${Object.entries(theArg)}`);
						}
						if (theArg[0] === "null") {
							throw new BASICerror(`Bound variable is ${theArg}; lambdaBoundVars: ${theLambdaBoundVars()}`);
						}
						it.astValue = theArg[1];
						it.astType = theArg[0];
					}
					if (DBGON) {
						serial.println("[BASIC.getDefunThunk.invoke] thunk successfully renamed arg-tree branch:");
						serial.println(astToString(it));
					}
				}
			});
			if (DBGON) {
				serial.println("[BASIC.getDefunThunk.invoke] resulting thunk tree:");
				serial.println(astToString(tree));
			}
		}
		else {
			if (DBGON) {
				serial.println("[BASIC.getDefunThunk.invoke] no rename, resulting thunk tree:");
				serial.println(astToString(tree));
			}
		}
		if (DBGON) {
			serial.println("[BASIC.getDefunThunk.invoke] evaluating tree:");
		}
		let ret = resolve(bF._executeSyntaxTree(lnum, stmtnum, tree, 0));
		if (!norename) {
			lambdaBoundVars.shift();
		}
		return ret;
	}
};
bS.wrapBuiltinToUsrdefun = function(funcname) {
	let argCount = bS.builtin[funcname].argc;
	if (argCount === undefined) throw new BASICerror(`${funcname} cannot be wrapped into usrdefun`);
	let leaves = [];
	for (let k = 0; k < argCount; k++) {
		let l = new BasicAST();
		l.astLnum = "**";
		l.astValue = [0,k];
		l.astType = "defun_args";
		leaves.push(l);
	}
	let tree = new BasicAST();
	tree.astLnum = "**";
	tree.astValue = funcname;
	tree.astType = "function";
	tree.astLeaves = leaves;
	return tree;
}
bS.addAsBasicVar = function(lnum, troValue, rh) {
	if (troValue.arrFull !== undefined) { 
		let arr = eval("troValue.arrFull"+troValue.arrKey);
		if (Array.isArray(arr)) throw lang.subscrOutOfRng(lnum, arr);
		eval("troValue.arrFull"+troValue.arrKey+"=rh");
		return {asgnVarName: troValue.arrName, asgnValue: rh};
	}
	else {
		let varname = troValue.toUpperCase();
		if (_basicConsts[varname]) throw lang.asgnOnConst(lnum, varname);
		let type = JStoBASICtype(rh);
		bS.vars[varname] = new BasicVar(rh, type);
		return {asgnVarName: varname, asgnValue: rh};
	}
}
bS.builtin = {
"=" : {argc:2, f:function(lnum, stmtnum, args) {
	if (args.length != 2) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	var troValue = args[0].troValue;
	var rh = resolve(args[1]);
	if (rh === undefined) throw lang.refError(lnum, "RH:"+args[1].troValue);
	if (isNumable(rh)) rh = tonum(rh) 
	return bS.addAsBasicVar(lnum, troValue, rh);
}},
"IN" : {argc:2, f:function(lnum, stmtnum, args) { 
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
"==" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNul(lnum, stmtnum, args, (lh,rh) => lh == rh);
}},
"<>" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (lh,rh) => lh != rh);
}},
"><" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (lh,rh) => lh != rh);
}},
"<=" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh <= rh);
}},
"=<" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh <= rh);
}},
">=" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh >= rh);
}},
"=>" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh >= rh);
}},
"<" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh < rh);
}},
">" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh > rh);
}},
"<<" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh << rh);
}},
">>" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh >>> rh);
}},
"UNARYMINUS" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => -lh);
}},
"UNARYPLUS" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => +lh);
}},
"UNARYLOGICNOT" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => !(lh));
}},
"UNARYBNOT" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => ~(lh));
}},
"BAND" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh & rh);
}},
"BOR" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh | rh);
}},
"BXOR" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh ^ rh);
}},
"!" : {argc:2, f:function(lnum, stmtnum, args) { 
	return twoArg(lnum, stmtnum, args, (lh,rh) => {
		if (Array.isArray(rh)) {
			return [lh].concat(rh);
		}
		else if (rh.mType === "list") {
			rh.mVal = [lh].concat(rh.mVal);
			return rh;
		}
		else throw lang.illegalType(lnum, rh);
	});
}},
"~" : {argc:2, f:function(lnum, stmtnum, args) { 
	return twoArg(lnum, stmtnum, args, (lh,rh) => {
		if (Array.isArray(lh)) {
			return lh.concat([rh]);
		}
		else if (lh.mType === "list") {
			lh.mVal = [lh.mVal].concat([rh]);
			return lh;
		}
		else throw lang.illegalType(lnum, lh);
	});
}},
"#" : {argc:2, f:function(lnum, stmtnum, args) { 
	return twoArg(lnum, stmtnum, args, (lh,rh) => {
		if (Array.isArray(lh) && Array.isArray(rh)) {
			return lh.concat(rh);
		}
		else if (lh.mType == "list" && rh.mType == "list") {
			let newMval = lh.mVal.concat(rh.mVal);
			return new BasicListMonad(newMval);
		}
		else
			throw lang.illegalType(lnum);
	});
}},
"+" : {argc:2, f:function(lnum, stmtnum, args) { 
	return twoArg(lnum, stmtnum, args, (lh,rh) => (!isNaN(lh) && !isNaN(rh)) ? (tonum(lh) + tonum(rh)) : (lh + rh));
}},
"-" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh - rh);
}},
"*" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => lh * rh);
}},
"/" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => {
		if (rh == 0) throw lang.divByZero;
		return lh / rh;
	});
}},
"\\" : {argc:2, f:function(lnum, stmtnum, args) { 
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => {
		if (rh == 0) throw lang.divByZero;
		return (lh / rh)|0;
	});
}},
"MOD" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => {
		if (rh == 0) throw lang.divByZero;
		return lh % rh;
	});
}},
"^" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (lh,rh) => {
		let r = Math.pow(lh, rh);
		if (isNaN(r)) throw lang.badFunctionCallFormat(lnum);
		if (!isFinite(r)) throw lang.divByZero;
		return r;
	});
}},
"TO" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArgNum(lnum, stmtnum, args, (from, to) => new ForGen(from, to, 1));
}},
"STEP" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (gen, step) => {
		if (!isGenerator(gen)) throw lang.illegalType(lnum, gen);
		return new ForGen(gen.start, gen.end, step);
	});
}},
"DIM" : {f:function(lnum, stmtnum, args) {
	return varArgNum(lnum, stmtnum, args, (revdims) => {
		let dims = revdims.reverse();
		let arraydec = "Array(dims[0]).fill(0)";
		for (let k = 1; k < dims.length; k++) {
			arraydec = `Array(dims[${k}]).fill().map(_=>${arraydec})`
		}
		return eval(arraydec);
	});
}},
"ARRAY CONSTRUCTOR" : {f:function(lnum, stmtnum, args) {
	return args.map(v => resolve(v));
}},
"PRINT" : {argc:1, f:function(lnum, stmtnum, args, seps) {
	if (args.length == 0)
		println();
	else {
		for (var llll = 0; llll < args.length; llll++) {
			if (llll >= 1) {
				if (seps[llll - 1] == ",") print("\t");
			}
			var rsvArg = resolve(args[llll]);
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
"EMIT" : {argc:1, f:function(lnum, stmtnum, args, seps) {
	if (args.length == 0)
		println();
	else {
		for (var llll = 0; llll < args.length; llll++) {
			if (llll >= 1) {
				if (seps[llll - 1] == ",") print("\t");
			}
			var rsvArg = resolve(args[llll]);
			if (rsvArg === undefined && args[llll] !== undefined && args[llll].troType != "null") throw lang.refError(lnum, args[llll].troValue);
			let printstr = "";
			if (rsvArg === undefined)
				print("")
			else if (isNumable(rsvArg)) {
				let c = con.getyx();
				con.addch(tonum(rsvArg));
				con.move(c[0],c[1]+1);
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
"POKE" : {argc:2, f:function(lnum, stmtnum, args) {
	twoArgNum(lnum, stmtnum, args, (lh,rh) => sys.poke(lh, rh));
}},
"PEEK" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => sys.peek(lh));
}},
"GOTO" : {argc:1, f:function(lnum, stmtnum, args) {
	let line = gotoLabels[args[0].troValue];
	if (line === undefined) line = resolve(args[0]);
	if (line < 0) throw lang.syntaxfehler(lnum, line);
	return new JumpObj(line, 0, lnum, line);
}},
"GOSUB" : {argc:1, f:function(lnum, stmtnum, args) {
	let line = gotoLabels[args[0].troValue];
	if (line === undefined) line = resolve(args[0]);
	if (line < 0) throw lang.syntaxfehler(lnum, line);
	bS.gosubStack.push([lnum, stmtnum + 1]);
	return new JumpObj(line, 0, lnum, line);
}},
"RETURN" : {f:function(lnum, stmtnum, args) {
	var r = bS.gosubStack.pop();
	if (r === undefined) throw lang.nowhereToReturn(lnum);
	return new JumpObj(r[0], r[1], lnum, r);
}},
"CLEAR" : {argc:0, f:function(lnum, stmtnum, args) {
	bS.vars = initBvars();
}},
"PLOT" : {argc:3, f:function(lnum, stmtnum, args) {
	threeArgNum(lnum, stmtnum, args, (xpos, ypos, color) => graphics.plotPixel(xpos, ypos, color));
}},
"AND" : {argc:2, f:function(lnum, stmtnum, args) {
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
"OR" : {argc:2, f:function(lnum, stmtnum, args) {
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
"RND" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => {
		if (!(args.length > 0 && args[0].troValue === 0))
			bS.rnd = Math.random();
		return bS.rnd;
	});
}},
"ROUND" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => Math.round(lh));
}},
"FLOOR" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => Math.floor(lh));
}},
"INT" : {argc:1, f:function(lnum, stmtnum, args) { 
	return oneArgNum(lnum, stmtnum, args, (lh) => Math.floor(lh));
}},
"CEIL" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => Math.ceil(lh));
}},
"FIX" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => (lh|0));
}},
"CHR" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => String.fromCharCode(lh));
}},
"TEST" : {argc:1, f:function(lnum, stmtnum, args) {
	if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	return resolve(args[0]);
}},
"FOREACH" : {f:function(lnum, stmtnum, args) { 
	var asgnObj = resolve(args[0]);
	if (asgnObj === undefined) throw lang.syntaxfehler(lnum);
	if (!Array.isArray(asgnObj.asgnValue)) throw lang.illegalType(lnum, asgnObj);
	var varname = asgnObj.asgnVarName;
	bS.vars[varname] = new BasicVar(asgnObj.asgnValue[0], JStoBASICtype(asgnObj.asgnValue.shift()));
	bS.vars["for var "+varname] = new BasicVar(asgnObj.asgnValue, "array");
	bS.forLnums[varname] = [lnum, stmtnum];
	bS.forStack.push(varname);
}},
"FOR" : {f:function(lnum, stmtnum, args) { 
	var asgnObj = resolve(args[0]);
	if (asgnObj === undefined) throw lang.syntaxfehler(lnum);
	if (!isGenerator(asgnObj.asgnValue)) throw lang.illegalType(lnum, typeof asgnObj);
	var varname = asgnObj.asgnVarName;
	var generator = asgnObj.asgnValue;
	bS.vars[varname] = new BasicVar(generator.start, "num");
	bS.vars["for var "+varname] = new BasicVar(generator, "generator");
	bS.forLnums[varname] = [lnum, stmtnum];
	bS.forStack.push(varname);
}},
"NEXT" : {f:function(lnum, stmtnum, args) {
	if (args.length == 0 || (args.length == 1 && args.troType == "null")) {
		var forVarname = bS.forStack.pop();
		if (forVarname === undefined) {
			throw lang.nextWithoutFor(lnum);
		}
		if (TRACEON) serial.println("[BASIC.FOR] looping "+forVarname);
		var forVar = bS.vars["for var "+forVarname].bvLiteral;
		if (isGenerator(forVar))
			bS.vars[forVarname].bvLiteral = genGetNext(forVar, bS.vars[forVarname].bvLiteral);
		else
			bS.vars[forVarname].bvLiteral = forVar.shift();
		if ((bS.vars[forVarname].bvLiteral !== undefined)) {
			bS.forStack.push(forVarname);
			let forLnum = bS.forLnums[forVarname]
			return new JumpObj(forLnum[0], forLnum[1]+1, lnum, [forLnum[0], forLnum[1]+1]); 
		}
		else {
			if (isGenerator(forVar))
				bS.vars[forVarname].bvLiteral = forVar.current; 
			else
				bS.vars[forVarname] === undefined; 
			return new JumpObj(lnum, stmtnum + 1, lnum, [lnum, stmtnum + 1]);
		}
	}
	throw lang.syntaxfehler(lnum, "extra arguments for NEXT");
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
"INPUT" : {argc:1, f:function(lnum, stmtnum, args) {
	if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	let troValue = args[0].troValue;
	print("? "); var rh = sys.read().trim();
	if (!isNaN(rh)) rh = tonum(rh)
	return bS.addAsBasicVar(lnum, troValue, rh);
}},
"CIN" : {argc:0, f:function(lnum, stmtnum, args) {
	return sys.read().trim();
}},
"END" : {argc:0, f:function(lnum, stmtnum, args) {
	serial.println("Program terminated in "+lnum);
	return new JumpObj(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, lnum, undefined); 
}},
"SPC" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => " ".repeat(lh));
}},
"LEFT" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (str, len) => str.substring(0, len));
}},
"MID" : {argc:3, f:function(lnum, stmtnum, args) {
	return threeArg(lnum, stmtnum, args, (str, start, len) => str.substring(start-INDEX_BASE, start-INDEX_BASE+len));
}},
"RIGHT" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (str, len) => str.substring(str.length - len, str.length));
}},
"SGN" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => (it > 0) ? 1 : (it < 0) ? -1 : 0);
}},
"ABS" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.abs(it));
}},
"SIN" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.sin(it));
}},
"COS" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.cos(it));
}},
"TAN" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.tan(it));
}},
"EXP" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.exp(it));
}},
"ASN" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.asin(it));
}},
"ACO" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.acos(it));
}},
"ATN" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.atan(it));
}},
"SQR" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.sqrt(it));
}},
"CBR" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.cbrt(it));
}},
"SINH" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.sinh(it));
}},
"COSH" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.cosh(it));
}},
"TANH" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.tanh(it));
}},
"LOG" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (it) => Math.log(it));
}},
"RESTORE" : {argc:0, f:function(lnum, stmtnum, args) {
	DATA_CURSOR = 0;
}},
"READ" : {argc:1, f:function(lnum, stmtnum, args) {
	if (args.length != 1) throw lang.syntaxfehler(lnum, args.length+lang.aG);
	let troValue = args[0].troValue;
	let rh = DATA_CONSTS[DATA_CURSOR++];
	if (rh === undefined) throw lang.outOfData(lnum);
	return bS.addAsBasicVar(lnum, troValue, rh);
}},
"DGET" : {argc:0, f:function(lnum, stmtnum, args) {
	let r = DATA_CONSTS[DATA_CURSOR++];
	if (r === undefined) throw lang.outOfData(lnum);
	return r;
}},
"OPTIONBASE" : {f:function(lnum, stmtnum, args) {
	return oneArgNum(lnum, stmtnum, args, (lh) => {
		if (lh != 0 && lh != 1) throw lang.syntaxfehler(line);
		INDEX_BASE = lh|0;
	});
}},
"DATA" : {f:function(lnum, stmtnum, args) {
	if (prescan) {
		args.forEach(it => DATA_CONSTS.push(resolve(it)));
	}
}},
"MAP" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (fn, functor) => {
		if (!isRunnable(fn)) throw lang.badFunctionCallFormat(lnum, "first argument is not a function: got "+JStoBASICtype(fn));
		if (!isGenerator(functor) && !Array.isArray(functor)) throw lang.syntaxfehler(lnum, "not a mappable type: "+functor+((typeof functor == "object") ? Object.entries(functor) : ""));
		if (isGenerator(functor)) functor = genToArray(functor);
		return functor.map(it => bS.getDefunThunk(fn)(lnum, stmtnum, [it]));
	});
}},
"FOLD" : {argc:3, f:function(lnum, stmtnum, args) {
	return threeArg(lnum, stmtnum, args, (fn, init, functor) => {
		if (!isRunnable(fn)) throw lang.badFunctionCallFormat(lnum, "first argument is not a function: got "+JStoBASICtype(fn));
		if (!isGenerator(functor) && !Array.isArray(functor)) throw lang.syntaxfehler(lnum, `not a mappable type '${Object.entries(args[2])}': `+functor+((typeof functor == "object") ? Object.entries(functor) : ""));
		if (isGenerator(functor)) functor = genToArray(functor);
		let akku = init;
		functor.forEach(it => {
			akku = bS.getDefunThunk(fn)(lnum, stmtnum, [akku, it]);
		});
		return akku;
	});
}},
"FILTER" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (fn, functor) => {
		if (!isRunnable(fn)) throw lang.badFunctionCallFormat(lnum, "first argument is not a function: got "+JStoBASICtype(fn));
		if (!isGenerator(functor) && !Array.isArray(functor)) throw lang.syntaxfehler(lnum, `not a mappable type '${Object.entries(args[1])}': `+functor+((typeof functor == "object") ? Object.entries(functor) : (typeof functor)));
		if (isGenerator(functor)) functor = genToArray(functor);
		return functor.filter(it => bS.getDefunThunk(fn)(lnum, stmtnum, [it]));
	});
}},
"DO" : {f:function(lnum, stmtnum, args) {
	return args[args.length - 1];
}},
"LABEL" : {f:function(lnum, stmtnum, args) {
	if (prescan) {
		let labelname = args[0].troValue;
		if (labelname === undefined) throw lang.syntaxfehler(lnum, "empty LABEL");
		gotoLabels[labelname] = lnum;
	}
}},
"ON" : {f:function(lnum, stmtnum, args) {
	if (args[2] === undefined) throw lang.syntaxfehler(lnum);
	let jmpFun = args.shift();
	let testvalue = resolve(args.shift())-INDEX_BASE;
	let jmpTarget = args[testvalue];
	if (jmpFun !== "GOTO" && jmpFun !== "GOSUB")
		throw lang.badFunctionCallFormat(lnum, `Not a jump statement: ${jmpFun}`)
	if (jmpTarget === undefined)
		return undefined;
	return bS.builtin[jmpFun].f(lnum, stmtnum, [jmpTarget]);
}},
"MIN" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (lh,rh) => (lh > rh) ? rh : lh);
}},
"MAX" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (lh,rh) => (lh < rh) ? rh : lh);
}},
"GETKEYSDOWN" : {argc:0, f:function(lnum, stmtnum, args) {
	let keys = [];
	sys.poke(-40, 255);
	for (let k = -41; k >= -48; k--) {
		keys.push(sys.peek(k));
	}
	return keys;
}},
"~<" : {argc:2, f:function(lnum, stmtnum, args) { 
	return twoArg(lnum, stmtnum, args, (fn, value) => {
		if (!isAST(fn)) throw lang.badFunctionCallFormat(lnum, "left-hand is not a function: got "+JStoBASICtype(fn));
		if (DBGON) {
			serial.println("[BASIC.BUILTIN.CURRY] currying this function tree...");
			serial.println(astToString(fn));
			serial.println("[BASIC.BUILTIN.CURRY] with this value: "+value);
			serial.println(Object.entries(value));
		}
		let curriedTree = curryDefun(fn, value);
		if (DBGON) {
			serial.println("[BASIC.BUILTIN.CURRY] Here's your curried tree:");
			serial.println(astToString(curriedTree));
		}
		return curriedTree;
	});
}},
"TYPEOF" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNul(lnum, stmtnum, args, bv => {
		if (bv === undefined) return "undefined";
		if (bv.bvType === undefined || !(bv instanceof BasicVar)) {
			let typestr = JStoBASICtype(bv);
			if (typestr == "monad")
				return bv.mType+"-"+typestr;
			else return typestr;
		}
		return bv.bvType;
	});
}},
"LEN" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, lh => {
		if (lh.length === undefined) throw lang.illegalType();
		return lh.length;
	});
}},
"HEAD" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, lh => {
		if (lh.length === undefined || lh.length < 1) throw lang.illegalType();
		return lh[0];
	});
}},
"TAIL" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, lh => {
		if (lh.length === undefined || lh.length < 1) throw lang.illegalType();
		return lh.slice(1, lh.length);
	});
}},
"INIT" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, lh => {
		if (lh.length === undefined || lh.length < 1) throw lang.illegalType();
		return lh.slice(0, lh.length - 1);
	});
}},
"LAST" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, lh => {
		if (lh.length === undefined || lh.length < 1) throw lang.illegalType();
		return lh[lh.length - 1];
	});
}},
"CLS" : {argc:0, f:function(lnum, stmtnum, args) {
	con.clear();
}},
"$" : {argc:2, f:function(lnum, stmtnum, args) {
	let fn = resolve(args[0]);
	let value = resolve(args[1]); 
	if (DBGON) {
		serial.println("[BASIC.BUILTIN.APPLY] applying this function tree... "+fn);
		serial.println(astToString(fn));
		serial.println("[BASIC.BUILTIN.APPLY] with this value: "+value);
		if (value !== undefined)
			serial.println(Object.entries(value));
	}
	if (fn.mType == "funseq") {
		return getMonadEvalFun(fn)(lnum, stmtnum, [value]);
	}
	else {
		let valueTree = new BasicAST();
		valueTree.astLnum = lnum;
		valueTree.astType = JStoBASICtype(value);
		valueTree.astValue = value;
		let newTree = new BasicAST();
		newTree.astLnum = lnum;
		newTree.astValue = fn;
		newTree.astType = "usrdefun";
		newTree.astLeaves = [valueTree];
		if (DBGON) {
			serial.println("[BASIC.BUILTIN.APPLY] Here's your applied tree:");
			serial.println(astToString(newTree));
		}
		return bF._executeSyntaxTree(lnum, stmtnum, newTree, 0);
	}
}},
"REDUCE" : {noprod:1, argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, bv => {
		if (isAST(bv)) {			
			if (DBGON) {
				serial.println("[BASIC.BUILTIN.REDUCE] reducing:");
				serial.println(astToString(bv));
			}
			let reduced = bF._uncapAST(bv, it => {
				return it;
			});
			if (DBGON) {
				serial.println("[BASIC.BUILTIN.REDUCE] reduced: "+reduced);
				serial.println(astToString(reduced));
			}
			let newTree = new BasicAST();
			newTree.astLnum = lnum;
			newTree.astType = JStoBASICtype(reduced);
			newTree.astValue = reduced;
			return newTree;
		}
		else {
			return bv;
		}
	});
}},
">>=" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (ma, a_to_mb) => {
		if (!isMonad(ma)) throw lang.badFunctionCallFormat(lnum, "left-hand is not a monad: got "+JStoBASICtype(ma));
		if (!isRunnable(a_to_mb)) throw lang.badFunctionCallFormat(lnum, "right-hand is not a usrdefun: got "+JStoBASICtype(a_to_mb));
		if (DBGON) {
			serial.println("[BASIC.BIND] binder:");
			serial.println(monadToString(ma));
			serial.println("[BASIC.BIND] bindee:");
			serial.println(astToString(a_to_mb));
		}
		let a = ma.mVal;
		let mb = bS.getDefunThunk(a_to_mb)(lnum, stmtnum, [a]);
		if (!isMonad(mb)) throw lang.badFunctionCallFormat(lnum, "right-hand function did not return a monad");
		if (DBGON) {
			serial.println("[BASIC.BIND] bound monad:");
			serial.println(monadToString(mb));
		}
		return mb;
	});
}},
">>~" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (ma, mb) => {
		if (!isMonad(ma)) throw lang.badFunctionCallFormat(lnum, "left-hand is not a monad: got "+JStoBASICtype(ma));
		if (!isMonad(mb)) throw lang.badFunctionCallFormat(lnum, "right-hand is not a monad: got "+JStoBASICtype(mb));
		if (DBGON) {
			serial.println("[BASIC.BIND] binder:");
			serial.println(monadToString(ma));
			serial.println("[BASIC.BIND] bindee:");
			serial.println(monadToString(mb));
		}
		let a = ma.mVal;
		let b = mb.mVal;
		return mb;
	});
}},
"." : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (fa, fb) => {
		if (!isRunnable(fa)) throw lang.badFunctionCallFormat(lnum, "left-hand is not a function/funseq: got"+JStoBASICtype(fa));
		if (!isRunnable(fb)) throw lang.badFunctionCallFormat(lnum, "left-hand is not a function/funseq: got"+JStoBASICtype(fb));
		let ma = (isAST(fa)) ? [fa] : fa.mVal;
		let mb = (isAST(fb)) ? [fb] : fb.mVal;
		let mc = mb.concat(ma);
		return new BasicFunSeq(mc);
	});
}},
"MLIST" : {noprod:1, argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNul(lnum, stmtnum, args, fn => {
		return new BasicListMonad([fn]);
	});
}},
"MRET" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArgNul(lnum, stmtnum, args, fn => {
		return new BasicMemoMonad(fn);
	});
}},
"MJOIN" : {argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, m => {
		if (!isMonad(m)) throw lang.illegalType(lnum, m);
		return m.mVal;
	});
}},
"GOTOYX" : {argc:2, f:function(lnum, stmtnum, args) {
	return twoArg(lnum, stmtnum, args, (y, x) => {
		con.move(y + (1-INDEX_BASE),x + (1-INDEX_BASE));
	});
}},
"TEXTFORE" : {argc:2, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, col => {
		print(String.fromCharCode(27,91)+"38;5;"+(col|0)+"m");
	});
}},
"TEXTBACK" : {argc:2, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, col => {
		print(String.fromCharCode(27,91)+"48;5;"+(col|0)+"m");
	});
}},
"OPTIONDEBUG" : {f:function(lnum, stmtnum, args) {
	oneArgNum(lnum, stmtnum, args, (lh) => {
		if (lh != 0 && lh != 1) throw lang.syntaxfehler(line);
		DBGON = (1 == lh|0);
	});
}},
"OPTIONTRACE" : {f:function(lnum, stmtnum, args) {
	oneArgNum(lnum, stmtnum, args, (lh) => {
		if (lh != 0 && lh != 1) throw lang.syntaxfehler(line);
		TRACEON = (1 == lh|0);
	});
}},
"PRINTMONAD" : {debugonly:1, argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, (it) => {
		println(monadToString(it));
	});
}}, 
"RESOLVE" : {debugonly:1, argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, (it) => {
		if (isAST(it)) {
			println(lnum+" RESOLVE PRINTTREE")
			println(astToString(it));
			if (typeof it.astValue == "object") {
				if (isAST(it.astValue)) {
					println(lnum+" RESOLVE PRINTTREE ASTVALUE PRINTTREE");
					println(astToString(it.astValue));
				}
				else {
					println(lnum+" RESOLVE PRINTTREE ASTVALUE");
					println(it.astValue);
				}
			}
		}
		else
			println(it);
	});
}},
"RESOLVEVAR" : {debugonly:1, argc:1, f:function(lnum, stmtnum, args) {
	return oneArg(lnum, stmtnum, args, (it) => {
		let v = bS.vars[args[0].troValue];
		if (v === undefined) println("Undefined variable: "+args[0].troValue);
		else println(`type: ${v.bvType}, value: ${v.bvLiteral}`);
	});
}},
"UNRESOLVE" : {debugonly:1, argc:1, f:function(lnum, stmtnum, args) {
	println(args[0]);
}},
"UNRESOLVE0" : {debugonly:1, argc:1, f:function(lnum, stmtnum, args) {
	println(Object.entries(args[0]));
}}
};
Object.freeze(bS.builtin);
let bF = {}; 
bF._1os = {"!":1,"~":1,"#":1,"<":1,"=":1,">":1,"*":1,"+":1,"-":1,"/":1,"^":1,":":1,"$":1,".":1,"@":1,"\\":1,"%":1,"|":1,"`":1};
bF._uos = {"+":1,"-":1,"NOT":1,"BNOT":1,"^":1,"@":1,"`":1};
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
bF._isUnary = function(code) {
	return bF._uos[String.fromCharCode(code)]
}
bF._isParenOpen = function(code) {
	return (code == 0x28 || code == 0x5B || code == 0x7B) || (code == '(' || code == '[' || code == '{');
};
bF._isParenClose = function(code) {
	return (code == 0x29 || code == 0x5D || code == 0x7D) || (code == ')' || code == ']' || code == '}');
};
bF._isMatchingParen = function(open, close) {
	return (open == '(' && close == ')' || open == '[' && close == ']' || open == '{' && close == '}');
};
bF._isParen = function(code) {
	return bF._isParenOpen(code) || bF._isParenClose(code);
};
bF._isSep = function(code) {
	return code == 0x2C || code == 0x3B;
};
bF._opPrc = {
	"`":10, 
	"^":20,
	"*":30,"/":30,"\\":20,
	"MOD":40,
	"+":50,"-":50,
	"NOT":60,"BNOT":60,
	"<<":70,">>":70,
	"<":80,">":80,"<=":80,"=<":80,">=":80,"=>":80,
	"==":90,"<>":90,"><":90,
	"MIN":100,"MAX":100,
	"BAND":200,
	"BXOR":201,
	"BOR":202,
	"AND":300,
	"OR":301,
	"TO":400,
	"STEP":401,
	"!":500,"~":501, 
	"#":502, 
	".": 600, 
	"$": 600, 
	"~<": 601, 
	"@":700, 
	"~>": 1000, 
	">>~": 1000, 
	">>=": 1000, 
	"=":9999,"IN":9999
}; 
bF._opRh = {"^":1,"=":1,"!":1,"IN":1,"~>":1,"$":1,".":1,">>=":1,">>~":1,">!>":1,"@":1,"`":1}; 
bF._tokenise = function(lnum, cmd) {
	var _debugprintStateTransition = false;
	var k;
	var tokens = [];
	var states = [];
	var sb = "";
	var mode = "lit"; 
	if (_debugprintStateTransition) println("@@ TOKENISE @@");
	if (_debugprintStateTransition) println("Ln "+lnum+" cmd "+cmd);
	for (k = 0; k < cmd.length; k++) {
		var char = cmd[k];
		var charCode = cmd.charCodeAt(k);
		if (_debugprintStateTransition) print("Char: "+char+"("+charCode+"), state: "+mode);
		if ("lit" == mode) {
			if (0x22 == charCode) { 
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
			if (bF._is1o(charCode)) {
				tokens.push(sb); sb = "" + char; states.push(mode);
				mode = "op";
			}
			else if (bF._isUnary(charCode)) {
				tokens.push(sb); sb = "" + char; states.push(mode);
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
		else if ("qot" == mode) {
			if (0x22 == charCode) {
				tokens.push(sb); sb = ""; states.push(mode);
				mode = "quote_end";
			}
			else {
				sb += char;
			}
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
	if (tokens[0].length == 0) {
		tokens = tokens.slice(1, tokens.length);
		states = states.slice(1, states.length);
	}
	for (k = 0; k < states.length; k++) {
		if (states[k] == "o2" || states[k] == "o3") states[k] = "op";
		else if (states[k] == "n2" || states[k] == "nsep") states[k] = "num";
	}
	if (tokens.length != states.length) {
		throw new BASICerror("size of tokens and states does not match (line: "+lnum+")\n"+
		tokens+"\n"+states);
	}
	return { "tokens": tokens, "states": states };
};
bF._parserElaboration = function(lnum, ltokens, lstates) {
	let _debugprintElaboration = (!PROD) && true;
	if (_debugprintElaboration) serial.println("@@ ELABORATION @@");
	let tokens = cloneObject(ltokens);
	let states = cloneObject(lstates);
	let k = 0;
	while (k < states.length) { 
		if (states[k] == "num" && !reNumber.test(tokens[k]))
			states[k] = "lit";
		else if (states[k] == "lit" && bF._opPrc[tokens[k].toUpperCase()] !== undefined)
			states[k] = "op";
		else if ((tokens[k].toUpperCase() == "TRUE" || tokens[k].toUpperCase() == "FALSE") && states[k] == "paren")
			states[k] = "bool";
		if (states[k] == "num") {
			if (tokens[k].toUpperCase().startsWith("0B")) {
				tokens[k] = parseInt(tokens[k].substring(2, tokens[k].length), 2) + "";
			}
		}
		k += 1;
	}
	k = 0; let l = states.length;
	while (k < l) {
		let lookahead012 = tokens[k]+tokens[k+1]+tokens[k+2];
		let lookahead01 = tokens[k]+tokens[k+1]
		if (k < states.length - 3 && states[k] == "op" && states[k+1] == "op" && states[k+2] == "op" && bF._opPrc[lookahead012]) {
			if (_debugprintElaboration) serial.println(`[ParserElaboration] Line ${lnum}: Trigraph (${lookahead012}) found starting from the ${lang.ord(k+1)} token of [${tokens}]`);
			tokens[k] = lookahead012
			let oldtkn = cloneObject(tokens);
			let oldsts = cloneObject(states);
			tokens = oldtkn.slice(0, k+1).concat(oldtkn.slice(k+3, oldtkn.length));
			states = oldsts.slice(0, k+1).concat(oldsts.slice(k+3, oldsts.length));
			l -= 2;
		}
		else if (k < states.length - 2 && states[k] == "op" && states[k+1] == "op" && bF._opPrc[lookahead01]) {
			if (_debugprintElaboration) serial.println(`[ParserElaboration] Line ${lnum}: Digraph (${lookahead01}) found starting from the ${lang.ord(k+1)} token of [${tokens}]`);
			tokens[k] = lookahead01;
			let oldtkn = cloneObject(tokens);
			let oldsts = cloneObject(states);
			tokens = oldtkn.slice(0, k+1).concat(oldtkn.slice(k+2, oldtkn.length));
			states = oldsts.slice(0, k+1).concat(oldsts.slice(k+2, oldsts.length));
			l -= 1;
		}
		else if (tokens[k] == ":" && states[k] == "op")
			states[k] = "seq";
		k += 1;
	}
	return {"tokens":tokens, "states":states};
};
bF._recurseApplyAST = function(tree, action) {
	if (!isAST(tree)) throw new BASICerror(`tree is not a AST (${tree})`);
	if (tree.astLeaves !== undefined && tree.astLeaves[0] === undefined) {
		return action(tree) || tree;
	}
	else {
		let newLeaves = tree.astLeaves.map(it => bF._recurseApplyAST(it, action))
		let newTree = action(tree);
		if (newTree !== undefined) {
			tree.astLnum = newTree.astLnum;
			tree.astValue = newTree.astValue;
			tree.astSeps = newTree.astSeps;
			tree.astType = newTree.astType;
			for (let k = 0; k < tree.astLeaves.length; k++) {
				if (newLeaves[k] !== undefined) tree.astLeaves[k] = newLeaves[k];
			}
		}
	}
}
bF._uncapAST = function(tree, action) {
	let expr = cloneObject(tree);
	bF._recurseApplyAST(expr, it => {
		if (isAST(it.astValue)) {
			let capTree = bF._uncapAST(it.astValue, action);
			it.astLnum = capTree.astLnum;
			it.astValue = capTree.astValue;
			it.astSeps = capTree.astSeps;
			it.astType = capTree.astType;
			it.astLeaves = capTree.astLeaves;
		}
		return action(it);
	});
	action(expr);
	return expr;
}
bF._EquationIllegalTokens = ["IF","THEN","ELSE","DEFUN","ON"];
bF.isSemanticLiteral = function(token, state) {
	return undefined == token || "]" == token || ")" == token || "}" == token ||
			"qot" == state || "num" == state || "bool" == state || "lit" == state;
}
bF.parserDoDebugPrint = (!PROD) && true;
bF.parserPrintdbg = any => { if (bF.parserDoDebugPrint) serial.println(any) };
bF.parserPrintdbg2 = function(icon, lnum, tokens, states, recDepth) {
	if (bF.parserDoDebugPrint) {
		let treeHead = "|  ".repeat(recDepth);
		bF.parserPrintdbg(`${icon}${lnum} ${treeHead}${tokens.join(' ')}`);
		bF.parserPrintdbg(`${icon}${lnum} ${treeHead}${states.join(' ')}`);
	}
}
bF.parserPrintdbgline = function(icon, msg, lnum, recDepth) {
	if (bF.parserDoDebugPrint) {
		let treeHead = "|  ".repeat(recDepth);
		bF.parserPrintdbg(`${icon}${lnum} ${treeHead}${msg}`);
	}
}
bF._parseTokens = function(lnum, tokens, states) {
	if (tokens.length !== states.length) throw Error("unmatched tokens and states length");
	bF.parserPrintdbg2('Line ', lnum, tokens, states, 0);
	if (tokens.length !== states.length) throw lang.syntaxfehler(lnum);
	if (tokens[0].toUpperCase() == "REM" && states[0] != "qot") return;
	let parenDepth = 0;
	let parenStart = -1;
	let parenEnd = -1;
	let seps = [];
	for (let k = 0; k < tokens.length; k++) {
		if (tokens[k] == "(" && states[k] == "paren") {
			parenDepth += 1;
			if (parenStart == -1 && parenDepth == 1) parenStart = k;
		}
		else if (tokens[k] == ")" && states[k] == "paren") {
			if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
			parenDepth -= 1;
		}
		if (parenDepth == 0 && tokens[k] == ":" && states[k] == "seq")
			seps.push(k);
	}
	let startPos = [0].concat(seps.map(k => k+1));
	let stmtPos = startPos.map((s,i) => {return{start:s, end:(seps[i] || tokens.length)}}); 
	return stmtPos.map((x,i) => {
		if (stmtPos.length > 1)
			bF.parserPrintdbgline('Line ', 'Statement #'+(i+1), lnum, 0);
		if (x.end - x.start <= 0) throw new ParserError("Malformed Line");
		let tree = bF._parseStmt(lnum,
			tokens.slice(x.start, x.end),
			states.slice(x.start, x.end),
			1
		);
		bF.parserPrintdbgline('Tree in ', '\n'+astToString(tree), lnum, 0);
		return tree;
	});
}
bF._parseStmt = function(lnum, tokens, states, recDepth) {
	bF.parserPrintdbg2('$', lnum, tokens, states, recDepth);
	if (tokens.length == 1 && states.length == 1) {
		bF.parserPrintdbgline('$', "Single Word Function Call", lnum, recDepth);
		return bF._parseLit(lnum, tokens, states, recDepth + 1, true);
	}
	let headTkn = tokens[0].toUpperCase();
	let headSta = states[0];
	let treeHead = new BasicAST();
	treeHead.astLnum = lnum;
	if (headTkn == "REM" && headSta != "qot") return;
	let parenDepth = 0;
	let parenStart = -1;
	let parenEnd = -1;
	let onGoPos = -1;
	let sepsZero = [];
	let sepsOne = [];
	for (let k = 0; k < tokens.length; k++) {
		if (tokens[k] == "(" && states[k] == "paren") {
			parenDepth += 1;
			if (parenStart == -1 && parenDepth == 1) parenStart = k;
		}
		else if (tokens[k] == ")" && states[k] == "paren") {
			if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
			parenDepth -= 1;
		}
		if (parenDepth == 0 && states[k] == "sep")
			sepsZero.push(k);
		if (parenDepth == 1 && states[k] == "sep")
			sepsOne.push(k);
		if (parenDepth == 0) {
			let tok = tokens[k].toUpperCase();
			if (-1 == onGoPos && ("GOTO" == tok || "GOSUB" == tok) && "lit" == states[k])
				onGoPos = k;
		}
	}
	if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
	try {
		bF.parserPrintdbgline('$', "Trying IF Statement...", lnum, recDepth);
		return bF._parseIfMode(lnum, tokens, states, recDepth + 1, false);
	}
	catch (e) {
		if (!(e instanceof ParserError)) throw e;
		bF.parserPrintdbgline('$', 'It was NOT!', lnum, recDepth);
	}
	if ("DEFUN" == headTkn && "lit" == headSta &&
		parenStart == 2 && tokens[parenEnd + 1] == "=" && states[parenEnd + 1] == "op"
	) {
		bF.parserPrintdbgline('$', 'DEFUN Stmt', lnum, recDepth);
		treeHead.astValue = "DEFUN";
		treeHead.astType = "function";
		if (tokens[1] == "(") {
			treeHead.astLeaves[0] = new BasicAST();
			treeHead.astLeaves[0].astLnum = lnum;
			treeHead.astLeaves[0].astType = "lit";
		}
		else {
			bF.parserPrintdbgline('$', 'DEFUN Stmt Function Name:', lnum, recDepth);
			treeHead.astLeaves[0] = bF._parseIdent(lnum, [tokens[1]], [states[1]], recDepth + 1);
		}
		bF.parserPrintdbgline('$', 'DEFUN Stmt Function Arguments -- ', lnum, recDepth);
		let defunArgDeclSeps = sepsOne.filter((i) => i < parenEnd + 1).map(i => i-1).concat([parenEnd - 1]);
		bF.parserPrintdbgline('$', 'DEFUN Stmt Function Arguments comma position: '+defunArgDeclSeps, lnum, recDepth);
		treeHead.astLeaves[0].astLeaves = defunArgDeclSeps.map(i=>bF._parseIdent(lnum, [tokens[i]], [states[i]], recDepth + 1));
		let parseFunction = bF._parseExpr;
		treeHead.astLeaves[1] = parseFunction(lnum,
			tokens.slice(parenEnd + 2, tokens.length),
			states.slice(parenEnd + 2, states.length),
			recDepth + 1
		);
		return treeHead;
	}
	if ("ON" == headTkn && "lit" == headSta) {
		bF.parserPrintdbgline('$', 'ON Stmt', lnum, recDepth);
		if (onGoPos == -1) throw ParserError("Malformed ON Statement");
		treeHead.astValue = "ON";
		treeHead.astType = "function";
		let testvalue = bF._parseExpr(lnum,
			tokens.slice(1, onGoPos),
			states.slice(1, onGoPos),
			recDepth + 1,
			true
		);
		let functionname = bF._parseExpr(lnum,
			[tokens[onGoPos]],
			[states[onGoPos]],
			recDepth + 1,
			true
		);
		let onArgSeps = sepsZero.filter(i => (i > onGoPos));
		let onArgStartPos = [onGoPos + 1].concat(onArgSeps.map(k => k + 1));
		let onArgPos = onArgStartPos.map((s,i) => {return{start:s, end: (onArgSeps[i] || tokens.length)}}); 
		treeHead.astLeaves = [testvalue, functionname].concat(onArgPos.map((x,i) => {
			bF.parserPrintdbgline('$', 'ON GOTO/GOSUB Arguments #'+(i+1), lnum, recDepth);
			if (x.end - x.start <= 0) throw new ParserError("Malformed ON arguments");
			return bF._parseExpr(lnum,
				tokens.slice(x.start, x.end),
				states.slice(x.start, x.end),
				recDepth + 1,
				true
			);
		}));
		return treeHead;
	}
	if (parenStart == 0 && parenEnd == tokens.length - 1) {
		bF.parserPrintdbgline('$', '( Stmt )', lnum, recDepth);
		return bF._parseStmt(lnum,
			tokens.slice(parenStart + 1, parenEnd),
			states.slice(parenStart + 1, parenEnd),
			recDepth + 1
		);
	}
	try {
		bF.parserPrintdbgline('$', 'Trying Expression Call...', lnum, recDepth);
		return bF._parseExpr(lnum, tokens, states, recDepth + 1);
	}
	catch (e) {
		bF.parserPrintdbgline('$', 'Error!', lnum, recDepth);
		throw new ParserError("Statement cannot be parsed in "+lnum+": "+e.stack);
	}
	throw new ParserError("Statement cannot be parsed in "+lnum);
} 
bF._parseExpr = function(lnum, tokens, states, recDepth, ifMode) {
	bF.parserPrintdbg2('e', lnum, tokens, states, recDepth);
	if (tokens[0] === undefined && states[0] === undefined) {
		let treeHead = new BasicAST();
		treeHead.astLnum = lnum;
		treeHead.astValue = undefined;
		treeHead.astType = "null";
		return treeHead;
	}
	let headTkn = tokens[0].toUpperCase();
	let headSta = states[0];
	if (!bF._EquationIllegalTokens.includes(headTkn) && tokens.length == 1) {
		bF.parserPrintdbgline('e', 'Literal Call', lnum, recDepth);
		return bF._parseLit(lnum, tokens, states, recDepth + 1);
	}
	let topmostOp;
	let topmostOpPrc = 0;
	let operatorPos = -1;
	let parenDepth = 0;
	let parenStart = -1;
	let parenEnd = -1;
	let curlyDepth = 0;
	let curlyStart = -1;
	let curlyEnd = -1;
	let uptkn = "";
	for (let k = 0; k < tokens.length; k++) {
		if (tokens[k] == "(" && states[k] == "paren") {
			parenDepth += 1;
			if (parenStart == -1 && parenDepth == 1) parenStart = k;
		}
		else if (tokens[k] == "{" && states[k] == "paren") {
			curlyDepth += 1;
			if (curlyStart == -1 && curlyDepth == 1) curlyStart = k;
		}
		else if (tokens[k] == ")" && states[k] == "paren") {
			if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
			parenDepth -= 1;
		}
		else if (tokens[k] == "}" && states[k] == "paren") {
			if (curlyEnd == -1 && curlyDepth == 1) curlyEnd = k;
			curlyDepth -= 1;
		}
		if (parenDepth == 0 && curlyDepth == 0) {
			let uptkn = tokens[k].toUpperCase();
			if (states[k] == "op" && bF.isSemanticLiteral(tokens[k-1], states[k-1]) &&
					((bF._opPrc[uptkn] > topmostOpPrc) ||
						(!bF._opRh[uptkn] && bF._opPrc[uptkn] == topmostOpPrc))
			) {
				topmostOp = uptkn;
				topmostOpPrc = bF._opPrc[uptkn];
				operatorPos = k;
			}
		}
	}
	if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
	if (curlyDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
	try {
		bF.parserPrintdbgline('e', "Trying Tuple...", lnum, recDepth);
		return bF._parseTuple(lnum, tokens, states, recDepth + 1, false);
	}
	catch (e) {
		if (!(e instanceof ParserError)) throw e;
		bF.parserPrintdbgline('e', 'It was NOT!', lnum, recDepth);
	}
	if (curlyStart == 0 && curlyEnd == tokens.length - 1) {
		bF.parserPrintdbgline('e', "Array", lnum, recDepth);
		return bF._parseArrayLiteral(lnum, tokens, states, recDepth + 1);
	}
	if (parenStart == 0 && parenEnd == tokens.length - 1) {
		bF.parserPrintdbgline('e', '( [Expr] )', lnum, recDepth);
		return bF._parseExpr(lnum,
			tokens.slice(parenStart + 1, parenEnd),
			states.slice(parenStart + 1, parenEnd),
			recDepth + 1
		);
	}
	try {
		bF.parserPrintdbgline('e', "Trying IF Expression...", lnum, recDepth);
		return bF._parseIfMode(lnum, tokens, states, recDepth + 1, false);
	}
	catch (e) {
		if (!(e instanceof ParserError)) throw e;
		bF.parserPrintdbgline('e', 'It was NOT!', lnum, recDepth);
	}
	if (bS.builtin[headTkn] && headSta == "lit" && !bF._opPrc[headTkn] &&
		states[1] != "paren" && tokens[1] != "("
	) {
		bF.parserPrintdbgline('e', 'Builtin Function Call w/o Paren', lnum, recDepth);
		return bF._parseFunctionCall(lnum, tokens, states, recDepth + 1);
	}
	if (topmostOp === undefined) { 
		try {
			bF.parserPrintdbgline('e', "Trying Function Call...", lnum, recDepth);
			return bF._parseFunctionCall(lnum, tokens, states, recDepth + 1);
		}
		catch (e) {
			if (!(e instanceof ParserError)) throw e;
			bF.parserPrintdbgline('e', 'It was NOT!', lnum, recDepth);
		}
	}
	if (topmostOp !== undefined) {
		bF.parserPrintdbgline('e', 'Operators', lnum, recDepth);
		if (ifMode && topmostOp == "=") throw lang.syntaxfehler(lnum, "'=' used on IF, did you mean '=='?");
		if (ifMode && topmostOp == ":") throw lang.syntaxfehler(lnum, "':' used on IF");
		let treeHead = new BasicAST();
		treeHead.astLnum = lnum;
		treeHead.astValue = topmostOp;
		treeHead.astType = "op";
		if (operatorPos > 0) {
			let subtknL = tokens.slice(0, operatorPos);
			let substaL = states.slice(0, operatorPos);
			let subtknR = tokens.slice(operatorPos + 1, tokens.length);
			let substaR = states.slice(operatorPos + 1, tokens.length);
			treeHead.astLeaves[0] = bF._parseExpr(lnum, subtknL, substaL, recDepth + 1);
			treeHead.astLeaves[1] = bF._parseExpr(lnum, subtknR, substaR, recDepth + 1);
		}
		else {
			if (topmostOp === "-") treeHead.astValue = "UNARYMINUS"
			else if (topmostOp === "+") treeHead.astValue = "UNARYPLUS"
			else if (topmostOp === "NOT") treeHead.astValue = "UNARYLOGICNOT"
			else if (topmostOp === "BNOT") treeHead.astValue = "UNARYBNOT"
			else if (topmostOp === "@") treeHead.astValue = "MRET"
			else if (topmostOp === "`") treeHead.astValue = "MJOIN"
			else throw new ParserError(`Unknown unary op '${topmostOp}'`);
			treeHead.astLeaves[0] = bF._parseExpr(lnum,
				tokens.slice(operatorPos + 1, tokens.length),
				states.slice(operatorPos + 1, states.length),
				recDepth + 1
			);
		}
		return treeHead;
	}
	throw new ParserError(`Expression "${tokens.join(" ")}" cannot be parsed in ${lnum}`);
} 
bF._parseArrayLiteral = function(lnum, tokens, states, recDepth) {
	bF.parserPrintdbg2('{', lnum, tokens, states, recDepth);
	let curlyDepth = 0;
	let curlyStart = -1;
	let curlyEnd = -1;
	let argSeps = [];
	for (let k = 0; k < tokens.length; k++) {
		if (tokens[k] == "{" && states[k] == "paren") {
			curlyDepth += 1;
			if (curlyStart == -1 && curlyDepth == 1) curlyStart = k;
		}
		else if (tokens[k] == "}" && states[k] == "paren") {
			if (curlyEnd == -1 && curlyDepth == 1) curlyEnd = k;
			curlyDepth -= 1;
		}
		if (curlyDepth == 1 && tokens[k] == "," && states[k] == "sep") {
			argSeps.push(k);
		}
	}
	if (curlyDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
	if (curlyStart == -1) throw new ParserError("not an array");
	bF.parserPrintdbgline('{', `curlyStart=${curlyStart}, curlyEnd=${curlyEnd}, argSeps=${argSeps}`, lnum, recDepth);
	let argStartPos = [1].concat(argSeps.map(k => k+1));
	let argPos = argStartPos.map((s,i) => {return{start:s, end:(argSeps[i] || curlyEnd)}}); 
	bF.parserPrintdbgline("{", "argPos = "+argPos.map(it=>`${it.start}/${it.end}`), lnum, recDepth);
	let treeHead = new BasicAST();
	treeHead.astLnum = lnum;
	treeHead.astValue = "ARRAY CONSTRUCTOR";
	treeHead.astType = "function";
	treeHead.astLeaves = argPos.map((x,i) => {
		bF.parserPrintdbgline("{", 'Array Element #'+(i+1), lnum, recDepth);
		if (x.end - x.start <= 0) throw new lang.syntaxfehler(lnum);
		return bF._parseExpr(lnum,
			tokens.slice(x.start, x.end),
			states.slice(x.start, x.end),
			recDepth + 1
		)}
	);
	return treeHead;
}
bF._parseIfMode = function(lnum, tokens, states, recDepth, exprMode) {
	bF.parserPrintdbg2('/', lnum, tokens, states, recDepth);
	let headTkn = tokens[0].toUpperCase();
	let headSta = states[0];
	let parseFunction = (exprMode) ? bF._parseExpr : bF._parseStmt
	let thenPos = -1;
	let elsePos = -1;
	let parenDepth = 0;
	let parenStart = -1;
	let parenEnd = -1;
	for (let k = 0; k < tokens.length; k++) {
		if (tokens[k] == "(" && states[k] == "paren") {
			parenDepth += 1;
			if (parenStart == -1 && parenDepth == 1) parenStart = k;
		}
		else if (tokens[k] == ")" && states[k] == "paren") {
			if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
			parenDepth -= 1;
		}
		if (parenDepth == 0) {
			if (-1 == thenPos && "THEN" == tokens[k].toUpperCase() && "lit" == states[k])
				thenPos = k;
			else if (-1 == elsePos && "ELSE" == tokens[k].toUpperCase() && "lit" == states[k])
				elsePos = k;
		}
	}
	if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
	let treeHead = new BasicAST();
	treeHead.astLnum = lnum;
	if ("IF" == headTkn && "lit" == headSta) {
		if (thenPos == -1) throw lang.syntaxfehler(lnum, "IF without THEN");
		treeHead.astValue = "IF";
		treeHead.astType = "function";
		treeHead.astLeaves[0] = bF._parseExpr(lnum,
			tokens.slice(1, thenPos),
			states.slice(1, thenPos),
			recDepth + 1,
			true 
		);
		treeHead.astLeaves[1] = parseFunction(lnum,
			tokens.slice(thenPos + 1, (elsePos != -1) ? elsePos : tokens.length),
			states.slice(thenPos + 1, (elsePos != -1) ? elsePos : tokens.length),
			recDepth + 1
		);
		if (elsePos != -1)
			treeHead.astLeaves[2] = parseFunction(lnum,
				tokens.slice(elsePos + 1, tokens.length),
				states.slice(elsePos + 1, tokens.length),
				recDepth + 1
			);
		return treeHead;
	}
	throw new ParserError("not an IF "+(exprMode) ? "expression" : "statement");
} 
bF._parseTuple = function(lnum, tokens, states, recDepth) {
	bF.parserPrintdbg2(']', lnum, tokens, states, recDepth);
	let parenDepth = 0;
	let parenStart = -1;
	let parenEnd = -1;
	let argSeps = []; 
	for (let k = 0; k < tokens.length; k++) {
		if (tokens[k] == "[" && states[k] == "paren") {
			parenDepth += 1;
			if (parenStart == -1 && parenDepth == 1) parenStart = k;
		}
		else if (tokens[k] == "]" && states[k] == "paren") {
			if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
			parenDepth -= 1;
		}
		if (parenDepth == 1 && parenEnd == -1 && states[k] == "sep")
			argSeps.push(k);
		if (parenStart != -1 && parenEnd != -1)
			break;
	}
	if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
	if (parenStart != 0 || parenEnd != tokens.length - 1)
		throw new ParserError("not a Tuple expression");
	let treeHead = new BasicAST();
	treeHead.astLnum = lnum;
	treeHead.astValue = undefined;
	treeHead.astType = "closure_args";
	bF.parserPrintdbgline(']', 'Tuple arguments -- ', lnum, recDepth);
	let defunArgDeclSeps = argSeps.map(i => i-1).concat([parenEnd - 1]);
	bF.parserPrintdbgline(']', 'Tuple comma position: '+defunArgDeclSeps, lnum, recDepth);
	treeHead.astLeaves = defunArgDeclSeps.map(i=>bF._parseIdent(lnum, [tokens[i]], [states[i]], recDepth + 1));
	return treeHead;
}
bF._parseFunctionCall = function(lnum, tokens, states, recDepth) {
	bF.parserPrintdbg2("F", lnum, tokens, states, recDepth);
	let parenDepth = 0;
	let parenStart = -1;
	let parenEnd = -1;
	let _argsepsOnLevelZero = []; 
	let _argsepsOnLevelOne = []; 
	let currentParenMode = []; 
	let depthsOfRoundParen = [];
	for (let k = 0; k < tokens.length; k++) {
		if (bF._isParenOpen(tokens[k]) && states[k] == "paren") {
			parenDepth += 1; currentParenMode.unshift(tokens[k]);
			if (currentParenMode[0] == '(') depthsOfRoundParen.push(parenDepth);
			if (parenStart == -1 && parenDepth == 1) parenStart = k;
		}
		else if (bF._isParenClose(tokens[k]) && states[k] == "paren") {
			if (!bF._isMatchingParen(currentParenMode[0], tokens[k]))
				throw lang.syntaxfehler(lnum, `Opening paren: ${currentParenMode[0]}, closing paren: ${tokens[k]}`); 
			if (parenEnd == -1 && parenDepth == 1) parenEnd = k;
			if (currentParenMode[0] == '(') depthsOfRoundParen.pop();
			parenDepth -= 1; currentParenMode.shift();
		}
		if (parenDepth == 0 && states[k] == "sep" && currentParenMode[0] === undefined)
			_argsepsOnLevelZero.push(k);
		if (parenDepth == depthsOfRoundParen[0] && states[k] == "sep" && currentParenMode[0] == "(")
			_argsepsOnLevelOne.push(k);
	}
	if (parenDepth != 0) throw lang.syntaxfehler(lnum, lang.unmatchedBrackets);
	let parenUsed = (parenStart == 1);
	bF.parserPrintdbgline("F", `parenStart: ${parenStart}, parenEnd: ${parenEnd}`, lnum, recDepth);
	bF.parserPrintdbgline("F", `Function Call (parenUsed: ${parenUsed})`, lnum, recDepth);
	let treeHead = new BasicAST();
	treeHead.astLnum = lnum;
	treeHead.astValue = bF._parseIdent(lnum, [tokens[0]], [states[0]], recDepth + 1).astValue; 
	let argSeps = parenUsed ? _argsepsOnLevelOne : _argsepsOnLevelZero; 
	bF.parserPrintdbgline("F", "argSeps = "+argSeps, lnum, recDepth);
	let argStartPos = [1 + (parenUsed)].concat(argSeps.map(k => k+1));
	bF.parserPrintdbgline("F", "argStartPos = "+argStartPos, lnum, recDepth);
	let argPos = argStartPos.map((s,i) => {return{start:s, end:(argSeps[i] || (parenUsed ? parenEnd : tokens.length) )}}); 
	bF.parserPrintdbgline("F", "argPos = "+argPos.map(it=>`${it.start}/${it.end}`), lnum, recDepth);
	treeHead.astLeaves = argPos.map((x,i) => {
		bF.parserPrintdbgline("F", 'Function Arguments #'+(i+1), lnum, recDepth);
		if (x.end - x.start < 0) throw new ParserError("not a function call because it's malformed");
		return bF._parseExpr(lnum,
			tokens.slice(x.start, x.end),
			states.slice(x.start, x.end),
			recDepth + 1
		)}
	);
	treeHead.astType = "function";
	treeHead.astSeps = argSeps.map(i => tokens[i]);
	bF.parserPrintdbgline("F", "astSeps = "+treeHead.astSeps, lnum, recDepth);
	return treeHead;
}
bF._parseIdent = function(lnum, tokens, states, recDepth) {
	bF.parserPrintdbg2('i', lnum, tokens, states, recDepth);
	if (!Array.isArray(tokens) && !Array.isArray(states)) throw new ParserError("Tokens and states are not array");
	if (tokens.length != 1 || states[0] != "lit") throw new ParserError(`illegal tokens '${tokens}' with states '${states}' in ${lnum}`);
	let treeHead = new BasicAST();
	treeHead.astLnum = lnum;
	treeHead.astValue = tokens[0].toUpperCase();
	treeHead.astType = "lit";
	return treeHead;
}
bF._parseLit = function(lnum, tokens, states, recDepth, functionMode) {
	bF.parserPrintdbg2('i', lnum, tokens, states, recDepth);
	if (!Array.isArray(tokens) && !Array.isArray(states)) throw new ParserError("Tokens and states are not array");
	if (tokens.length != 1) throw new ParserError("parseLit 1");
	let treeHead = new BasicAST();
	treeHead.astLnum = lnum;
	treeHead.astValue = ("qot" == states[0]) ? tokens[0] : tokens[0].toUpperCase();
	treeHead.astType = ("qot" == states[0]) ? "string" :
		("num" == states[0]) ? "num" :
		(functionMode) ? "function" : "lit";
	return treeHead;
}
bF._findDeBruijnIndex = function(varname, offset) {
	let recurseIndex = -1;
	let orderlyIndex = -1;
	for (recurseIndex = 0; recurseIndex < lambdaBoundVars.length; recurseIndex++) {
		orderlyIndex = lambdaBoundVars[recurseIndex].findIndex(it => it == varname);
		if (orderlyIndex != -1)
			return [recurseIndex + (offset || 0), orderlyIndex];
	}
	throw new ParserError("Unbound variable: "+varname);
}
bF._pruneTree = function(lnum, tree, recDepth) {	
	if (tree === undefined) return;
	if (DBGON) {
		serial.println("[Parser.PRUNE] pruning following subtree, lambdaBoundVars = "+Object.entries(lambdaBoundVars)); 
		serial.println(astToString(tree));
		if (isAST(tree) && isAST(tree.astValue)) {
			serial.println("[Parser.PRUNE] unpacking astValue:");
			serial.println(astToString(tree.astValue));
		}
	}
	let defunName = undefined;
	if (tree.astType == "op" && tree.astValue == "~>" || tree.astType == "function" && tree.astValue == "DEFUN") {
		let nameTree = tree.astLeaves[0];
		if (tree.astValue == "DEFUN") {
			defunName = nameTree.astValue;
			if (DBGON) {
				serial.println("[Parser.PRUNE.~>] met DEFUN, function name: "+defunName);
			}
		}
		let vars = nameTree.astLeaves.map((it, i) => {
			if (it.astType !== "lit") throw new ParserError("Malformed bound variable for function definition; tree:\n"+astToString(nameTree));
			return it.astValue;
		});
		lambdaBoundVars.unshift(vars);
		if (DBGON) {
			serial.println("[Parser.PRUNE.~>] added new bound variables: "+Object.entries(lambdaBoundVars));
		}
	}
	else if (tree.astValue == "UNARYMINUS" && tree.astType == "op" &&
		tree.astLeaves[1] === undefined && tree.astLeaves[0] !== undefined && tree.astLeaves[0].astType == "num"
	) {
		tree.astValue = -(tree.astLeaves[0].astValue);
		tree.astType = "num";
		tree.astLeaves = [];
	}
	else if (tree.astValue == "UNARYPLUS" && tree.astType == "op" &&
		tree.astLeaves[1] === undefined && tree.astLeaves[0] !== undefined && tree.astLeaves[0].astType == "num"
	) {
		tree.astValue = +(tree.astLeaves[0].astValue);
		tree.astType = "num";
		tree.astLeaves = [];
	}
	if (tree.astLeaves[0] != undefined) {
		tree.astLeaves.forEach(it => bF._pruneTree(lnum, it, recDepth + 1));
	}
	if (tree.astType == "op" && tree.astValue == "~>" || tree.astType == "function" && tree.astValue == "DEFUN") {
		if (tree.astLeaves.length !== 2) throw lang.syntaxfehler(lnum, tree.astLeaves.length+lang.aG);
		let nameTree = tree.astLeaves[0];
		let exprTree = tree.astLeaves[1];
		if (DBGON) {
			serial.println("[Parser.PRUNE.~>] closure bound variables: "+Object.entries(lambdaBoundVars));
		}
		bF._recurseApplyAST(exprTree, (it) => {
			if (it.astType == "lit" || it.astType == "function") {				
				try {
					let dbi = bF._findDeBruijnIndex(it.astValue);
					if (DBGON) {
						serial.println(`index for ${it.astValue}: ${dbi}`)
					}
					it.astValue = dbi;
					it.astType = "defun_args";
				}
				catch (_) {}
			}
		});
		tree.astType = "usrdefun";
		tree.astValue = exprTree;
		tree.astLeaves = [];
		lambdaBoundVars.shift();
	}
	if (defunName) {
		let nameTree = new BasicAST();
		nameTree.astLnum = tree.astLnum;
		nameTree.astType = "lit";
		nameTree.astValue = defunName;
		let newTree = new BasicAST();
		newTree.astLnum = tree.astLnum;
		newTree.astType = "op";
		newTree.astValue = "=";
		newTree.astLeaves = [nameTree, tree];
		tree = newTree;
		if (DBGON) {
			serial.println(`[Parser.PRUNE] has DEFUN, function name: ${defunName}`);
		}
	}
	if (DBGON) {
		serial.println("[Parser.PRUNE] pruned subtree:");
		serial.println(astToString(tree));
		if (isAST(tree) && isAST(tree.astValue)) {
			serial.println("[Parser.PRUNE] unpacking astValue:");
			serial.println(astToString(tree.astValue));
		}
		serial.println("======================================================\n");
	}
	return tree;
}
let JStoBASICtype = function(object) {
	if (typeof object === "boolean") return "bool";
	else if (object === undefined) return "null";
	else if (object.arrName !== undefined) return "internal_arrindexing_lazy";
	else if (object.asgnVarName !== undefined) return "internal_assignment_object";
	else if (isGenerator(object)) return "generator";
	else if (isAST(object)) return "usrdefun";
	else if (isMonad(object)) return "monad";
	else if (Array.isArray(object)) return "array";
	else if (isNumable(object)) return "num";
	else if (typeof object === "string" || object instanceof String) return "string";
	else throw Error("BasicIntpError: un-translatable object with typeof "+(typeof object)+",\ntoString = "+object+",\nentries = "+Object.entries(object));
}
let SyntaxTreeReturnObj = function(type, value, nextLine) {
	if (nextLine === undefined || !Array.isArray(nextLine))
		throw Error("TODO change format of troNextLine to [linenumber, stmtnumber]")
	this.troType = type;
	this.troValue = value;
	this.troNextLine = nextLine;
}
let JumpObj = function(targetLnum, targetStmtNum, fromLnum, rawValue) {
	this.jmpNext = [targetLnum, targetStmtNum];
	this.jmpFrom = fromLnum;
	this.jmpReturningValue = rawValue;
}
bF._makeRunnableFunctionFromExprTree = function(lnum, stmtnum, expression, args, recDepth, _debugExec, recWedge) {
	let defunArgs = args.map(it => {
		let rit = resolve(it);
		return [JStoBASICtype(rit), rit];
	});
	lambdaBoundVars.unshift(defunArgs);
	if (_debugExec) {
		serial.println(recWedge+"usrdefun dereference");
		serial.println(recWedge+"usrdefun dereference function: ");
		serial.println(astToString(expression));
		serial.println(recWedge+"usrdefun dereference bound vars: "+theLambdaBoundVars());
	}
	let bindVar = function(tree, recDepth) {
		bF._recurseApplyAST(tree, it => {
			if (_debugExec) {
				serial.println(recWedge+`usrdefun${recDepth} trying to bind some variables to:`);
				serial.println(astToString(it));
			}
			if (it.astType == "defun_args") {
				let recIndex = it.astValue[0] - recDepth;
				let varIndex = it.astValue[1];
				if (_debugExec) {
					serial.println(recWedge+`usrdefun${recDepth} bindvar d(${recIndex},${varIndex})`);
				}
				let theVariable = undefined;
				try {
					theVariable = lambdaBoundVars[recIndex][varIndex];
				}
				catch (e0) {}
				if (theVariable !== undefined) {
					it.astValue = theVariable[1];
					it.astType = theVariable[0];
				}
				if (_debugExec) {
					serial.println(recWedge+`usrdefun${recDepth} the bindvar: ${theVariable}`);
					serial.println(recWedge+`usrdefun${recDepth} modified tree:`);
					serial.println(astToString(it));
				}
			}
			else if (it.astType == "usrdefun") {
				bindVar(it.astValue, recDepth + 1);
			}
		});
	};bindVar(expression, 0);
	if (_debugExec) {
		serial.println(recWedge+"usrdefun dereference final tree:");
		serial.println(astToString(expression));
	}
	return bS.getDefunThunk(expression, true);
}
bF._troNOP = function(lnum, stmtnum) { return new SyntaxTreeReturnObj("null", undefined, [lnum, stmtnum+1]); }
bF._executeSyntaxTree = function(lnum, stmtnum, syntaxTree, recDepth) {
	if (syntaxTree == undefined) return bF._troNOP(lnum, stmtnum);
	if (syntaxTree.astLeaves === undefined && syntaxTree.astValue === undefined) {
		throw new BASICerror("not a syntax tree");
	}
	if (lnum === undefined || stmtnum === undefined) throw Error(`Line or statement number is undefined: (${lnum},${stmtnum})`);
	let _debugExec = (!PROD) && true;
	let _debugPrintCurrentLine = (!PROD) && true;
	let recWedge = ">".repeat(recDepth+1) + " ";
	let tearLine = "\n  =====ExecSyntaxTree=====  "+("<".repeat(recDepth+1))+"\n";
	if (_debugExec || _debugPrintCurrentLine) serial.println(recWedge+`@@ EXECUTE ${lnum}:${stmtnum} @@`);
	if (_debugPrintCurrentLine) {
		serial.println("Syntax Tree in "+lnum+":");
		serial.println(astToString(syntaxTree));
	}
	let callingUsrdefun = (syntaxTree.astType == "usrdefun" && syntaxTree.astLeaves[0] !== undefined);
	if (syntaxTree.astValue == undefined && syntaxTree.mVal == undefined) { 
		if (syntaxTree.astLeaves.length > 1) throw Error("WTF");
		return bF._executeSyntaxTree(lnum, stmtnum, syntaxTree.astLeaves[0], recDepth);
	}
	else if (syntaxTree.astType == "array" && syntaxTree.astLeaves[0] !== undefined) {
		let indexer = bS.getArrayIndexFun(lnum, stmtnum, "substituted array", syntaxTree.astValue);
		let args = syntaxTree.astLeaves.map(it => bF._executeSyntaxTree(lnum, stmtnum, it, recDepth + 1));
		let retVal = indexer(lnum, stmtnum, args);
		if (_debugExec) serial.println(recWedge+`indexing substituted array(${Object.entries(args)}) = ${Object.entries(retVal)}`);
		return new SyntaxTreeReturnObj(
				JStoBASICtype(retVal),
				retVal,
				[lnum, stmtnum + 1]
		);
	}
	else if (syntaxTree.astType == "op" && syntaxTree.astValue == "~>") {
		throw new BASICerror("Untended closure"); 
	}
	else if (syntaxTree.astType == "function" && syntaxTree.astValue == "DEFUN") {
		throw new BASICerror("Untended DEFUN"); 
	}
	else if (syntaxTree.astType == "function" || syntaxTree.astType == "op" || callingUsrdefun) {
		if (_debugExec) serial.println(recWedge+"function|operator");
		if (_debugExec) serial.println(recWedge+astToString(syntaxTree));
		let callerHash = syntaxTree.astHash;
		let funcName = (typeof syntaxTree.astValue.toUpperCase == "function") ? syntaxTree.astValue.toUpperCase() : "(usrdefun)";
		let lambdaBoundVarsAppended = (callingUsrdefun);
		let func = (callingUsrdefun)
				? bF._makeRunnableFunctionFromExprTree(
					lnum, stmtnum,
					cloneObject(syntaxTree.astValue),
					syntaxTree.astLeaves.map(it => bF._executeSyntaxTree(lnum, stmtnum, it, recDepth + 1)), 
					recDepth, _debugExec, recWedge
				)
			: (bS.builtin[funcName] === undefined)
				? undefined
			: (!DBGON && bS.builtin[funcName].debugonly) ? "NO_DBG4U" : (PROD && bS.builtin[funcName].noprod) ? "NO_PRODREADY" : bS.builtin[funcName].f;
		if (func === "NO_DBG4U") throw lang.syntaxfehler(lnum);
		if (func === "NO_PRODREADY") throw lang.syntaxfehler(lnum);
		if ("IF" == funcName) {
			if (syntaxTree.astLeaves.length != 2 && syntaxTree.astLeaves.length != 3) throw lang.syntaxfehler(lnum);
			var testedval = bF._executeSyntaxTree(lnum, stmtnum, syntaxTree.astLeaves[0], recDepth + 1);
			if (_debugExec) {
				serial.println(recWedge+"testedval:");
				serial.println(recWedge+"type="+testedval.troValue.astType);
				serial.println(recWedge+"value="+testedval.troValue.astValue);
				serial.println(recWedge+"nextLine="+testedval.troValue.astNextLine);
			}
			try {
				var iftest = bS.builtin["TEST"].f(lnum, stmtnum, [testedval]);
				let r = (!iftest && syntaxTree.astLeaves[2] !== undefined) ?
						bF._executeSyntaxTree(lnum, stmtnum, syntaxTree.astLeaves[2], recDepth + 1)
					: (iftest) ?
						bF._executeSyntaxTree(lnum, stmtnum, syntaxTree.astLeaves[1], recDepth + 1)
					: bF._troNOP(lnum, stmtnum);
				if (_debugExec) serial.println(tearLine);
				return r;
			}
			catch (e) {
				serial.printerr(`${e}\n${e.stack || "Stack trace undefined"}`);
				throw lang.errorinline(lnum, "TEST", e);
			}
		}
		else if ("ON" == funcName) {
			if (syntaxTree.astLeaves.length < 3) throw lang.badFunctionCallFormat(lnum);
			let testValue = bF._executeSyntaxTree(lnum, stmtnum, syntaxTree.astLeaves[0], recDepth + 1);
			let functionName = syntaxTree.astLeaves[1].astValue;
			let arrays = [];
			for (let k = 2; k < syntaxTree.astLeaves.length; k++)
				arrays.push(bF._executeSyntaxTree(lnum, stmtnum, syntaxTree.astLeaves[k], recDepth + 1));
			try  {
				let r = bS.builtin["ON"].f(lnum, stmtnum, [functionName, testValue].concat(arrays))
				let r2 = new SyntaxTreeReturnObj(JStoBASICtype(r.jmpReturningValue), r.jmpReturningValue, r.jmpNext);
				if (_debugExec) serial.println(tearLine);
				return r2;
			}
			catch (e) {
				serial.printerr(`${e}\n${e.stack || "Stack trace undefined"}`);
				throw lang.errorinline(lnum, "ON error", e);
			}
		}
		else {
			let args = syntaxTree.astLeaves.map(it => bF._executeSyntaxTree(lnum, stmtnum, it, recDepth + 1));
			if (_debugExec) {
				serial.println(recWedge+`fn caller: "${callerHash}"`);
				serial.println(recWedge+`fn call name: "${funcName}"`);
				serial.println(recWedge+"fn call args: "+(args.map(it => (it == undefined) ? it : (it.troType+" "+it.troValue)).join(", ")));
			}
			if (func === undefined) {
				var someVar = bS.vars[funcName];
				if (someVar !== undefined && DBGON) {
					serial.println(recWedge+`variable dereference of '${funcName}' : ${someVar.bvLiteral} (bvType: ${someVar.bvType})`);
					if (typeof someVar.bvLiteral == "object")
						serial.println(recWedge+"variable as an object : "+Object.entries(someVar.bvLiteral));
				}
				if (someVar === undefined) {
					throw lang.syntaxfehler(lnum, funcName + " is undefined");
				}
				else if ("array" == someVar.bvType) {
					func = bS.getArrayIndexFun(lnum, stmtnum, funcName, someVar.bvLiteral);
				}
				else if ("usrdefun" == someVar.bvType) {
					let expression = cloneObject(someVar.bvLiteral);
					lambdaBoundVarsAppended = true;
					func = bF._makeRunnableFunctionFromExprTree(lnum, stmtnum, expression, args, recDepth, _debugExec, recWedge);
				}
				else if ("monad" == someVar.bvType) {
					func = getMonadEvalFun(someVar.bvLiteral);
				}
				else {
					throw lang.syntaxfehler(lnum, funcName + " is not a function or an array");
				}
			}
			if (func === undefined) {
				serial.printerr(lnum+` ${funcName} is undefined`);
				throw lang.syntaxfehler(lnum, funcName + " is undefined");
			}
			let funcCallResult = func(lnum, stmtnum, args, syntaxTree.astSeps);
			if (funcCallResult instanceof SyntaxTreeReturnObj) return funcCallResult;
			let retVal = (funcCallResult instanceof JumpObj) ? funcCallResult.jmpReturningValue : funcCallResult;
			let theRealRet = new SyntaxTreeReturnObj(
				JStoBASICtype(retVal),
				retVal,
				(funcCallResult instanceof JumpObj) ? funcCallResult.jmpNext : [lnum, stmtnum + 1]
			);
			if (lambdaBoundVarsAppended) lambdaBoundVars.shift();
			if (_debugExec) serial.println(tearLine);
			return theRealRet;
		}
	}
	else if (syntaxTree.astType == "defun_args") {
		if (_debugExec) {
			serial.println(recWedge+"defun_args lambda bound vars: "+(lambdaBoundVars === undefined) ? undefined : theLambdaBoundVars());
			serial.println(recWedge+"defun_args defun args: "+syntaxTree.astValue);
		}
		let recIndex = syntaxTree.astValue[0];
		let varIndex = syntaxTree.astValue[1];
		let theVar = lambdaBoundVars[recIndex, varIndex];
		if (_debugExec) {
			serial.println(recWedge+"defun_args thevar: "+(theVar === undefined) ? undefined : Object.entries(theVar));
			serial.println(tearLine);
		}
		return theVar;
	}
	else if (syntaxTree.astType == "num") {
		if (_debugExec) serial.println(recWedge+"num "+(tonum(syntaxTree.astValue)));
		let r = new SyntaxTreeReturnObj(syntaxTree.astType, tonum(syntaxTree.astValue), [lnum, stmtnum + 1]);
		if (_debugExec) serial.println(tearLine);
		return r;
	}
	else if (syntaxTree.astType == "lit" || literalTypes.includes(syntaxTree.astType)) {
		if (_debugExec) {
			serial.println(recWedge+"literal with astType: "+syntaxTree.astType+", astValue: "+syntaxTree.astValue);
			if (isAST(syntaxTree.astValue)) {
				serial.println(recWedge+"astValue is a tree, unpacking: \n"+astToString(syntaxTree.astValue));
			}
		}
		let r = new SyntaxTreeReturnObj(syntaxTree.astType, syntaxTree.astValue, [lnum, stmtnum + 1]);
		if (_debugExec) serial.println(tearLine);
		return r;
	}
	else if (syntaxTree.astType == "null") {
		if (_debugExec) serial.println(recWedge+"null")
		let r = bF._executeSyntaxTree(lnum, stmtnum, syntaxTree.astLeaves[0], recDepth + 1);
		if (_debugExec) serial.println(tearLine);
		return r;
	}
	else {
		serial.println(recWedge+"Parsing error in "+lnum);
		serial.println(recWedge+astToString(syntaxTree));
		throw Error("Parsing error");
	}
}; 
bF._interpretLine = function(lnum, cmd) {
	let _debugprintHighestLevel = false;
	if (cmd.toUpperCase().startsWith("REM")) {
		if (_debugprintHighestLevel) serial.println(lnum+" "+cmd);
		return undefined;
	}
	let tokenisedObject = bF._tokenise(lnum, cmd);
	let tokens = tokenisedObject.tokens;
	let states = tokenisedObject.states;
	let newtoks = bF._parserElaboration(lnum, tokens, states);
	tokens = newtoks.tokens;
	states = newtoks.states;
	let syntaxTrees = bF._parseTokens(lnum, tokens, states).map(it => {
		if (lambdaBoundVars.length != 0)
			throw new BASICerror("lambdaBoundVars not empty");
		return bF._pruneTree(lnum, it, 0)
	});
	if (_debugprintHighestLevel) {
		syntaxTrees.forEach((t,i) => {
			serial.println("\nParsed Statement #"+(i+1));
			serial.println(astToString(t));
		});
	}
	return syntaxTrees;
}; 
bF._executeAndGet = function(lnum, stmtnum, syntaxTree) {
	if (lnum === undefined || stmtnum === undefined) throw Error(`Line or statement number is undefined: (${lnum},${stmtnum})`);
	try {
		if (lambdaBoundVars.length != 0) throw new BASICerror();
		var execResult = bF._executeSyntaxTree(lnum, stmtnum, syntaxTree, 0);
		if (DBGON) serial.println(`Line ${lnum} TRO: ${Object.entries(execResult)}`);
		return execResult.troNextLine;
	}
	catch (e) {
		serial.printerr(`ERROR on ${lnum}:${stmtnum} -- PARSE TREE:\n${astToString(syntaxTree)}\nERROR CONTENTS:\n${e}\n${e.stack || "Stack trace undefined"}`);
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
bF.list = function(args) { 
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
bF.system = function(args) { 
	tbasexit = true;
};
bF.new = function(args) { 
	if (args) cmdbuf = [];
	bS.vars = initBvars();
	gotoLabels = {};
	lambdaBoundVars = [];
	DATA_CONSTS = [];
	DATA_CURSOR = 0;
	INDEX_BASE = 0;
};
bF.renum = function(args) { 
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
	cmdbuf = newcmdbuf.slice(); 
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
bF.delete = function(args) {
	if (args.length != 2 && args.length != 3) throw lang.syntaxfehler();
	let start = 0; let end = 0;
	if (args.length == 2) {
		if (!isNumable(args[1])) throw lang.badFunctionCallFormat();
		start = args[1]|0;
		end = args[1]|0;
	}
	else {
		if (!isNumable(args[1]) && !isNumable(args[2])) throw lang.badFunctionCallFormat();
		start = args[1]|0;
		end = args[2]|0;
	}
	let newcmdbuf = [];
	cmdbuf.forEach((v,i) => {if (i < start || i > end) newcmdbuf[i]=v});
	cmdbuf = newcmdbuf;
};
bF.cls = function(args) {
	con.clear();
}
bF.prescanStmts = ["DATA","LABEL"];
bF.run = function(args) { 
	bF.new(false);
	let programTrees = [];
	prescan = true;
	cmdbuf.forEach((linestr, linenum) => {
		let trees = bF._interpretLine(linenum, linestr.trim());
		programTrees[linenum] = trees
		if (trees !== undefined) {
			trees.forEach((t, i) => {
				if (t !== undefined && bF.prescanStmts.includes(t.astValue)) {
					bF._executeAndGet(linenum, i, t);
				}
			})
		}
	});
	prescan = false;
	if (!PROD && DBGON) {
		serial.println("[BASIC] final DATA: "+DATA_CONSTS);
	}
	let lnum = 1;
	let stmtnum = 0;
	let oldnum = 1;
	let tree = undefined;
	do {
		if (programTrees[lnum] !== undefined) {
			if (TRACEON) {
				serial.println("[BASIC] Line "+lnum);
			}
			oldnum = lnum;
			tree = (programTrees[lnum] !== undefined) ? programTrees[lnum][stmtnum] : undefined;
			if (tree !== undefined) {
				let nextObj = bF._executeAndGet(lnum, stmtnum, tree);
				lnum = nextObj[0];
				stmtnum = nextObj[1];
			}
			else {
				lnum += 1;
				stmtnum = 0;
			}
		}
		else {
			lnum += 1;
		}
		if (lnum < 0) throw lang.badNumberFormat;
		if (con.hitterminate()) {
			println("Break in "+oldnum);
			break;
		}
	} while (lnum < cmdbuf.length)
	con.resetkeybuf();
};
bF.save = function(args) { 
	if (args[1] === undefined) throw lang.missingOperand;
	if (!args[1].toUpperCase().endsWith(".BAS"))
		args[1] += ".bas";
	fs.open(args[1], "W");
	var sb = "";
	cmdbuf.forEach((v, i) => sb += i+" "+v+"\n");
	fs.write(sb);
};
bF.load = function(args) { 
	if (args[1] === undefined) throw lang.missingOperand;
	var fileOpened = fs.open(args[1], "R");
	if (replUsrConfirmed || cmdbuf.length == 0) {
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
		bF.new(true);
		prg.split('\n').forEach((line) => {
			var i = line.indexOf(" ");
			var lnum = line.slice(0, i);
			if (isNaN(lnum)) throw lang.illegalType();
			cmdbuf[lnum] = line.slice(i + 1, line.length);
		});
	}
	else {
		replCmdBuf = ["load"].concat(args);
		println("Unsaved program will be lost, are you sure? (type 'yes' to confirm)");
	}
};
bF.yes = function() {
	if (replCmdBuf.length > 0) {
		replUsrConfirmed = true;
		bF[replCmdBuf[0].toLowerCase()](replCmdBuf.slice(1, replCmdBuf.length));
		replCmdBuf = [];
		replUsrConfirmed = false;
	}
	else {
		throw lang.syntaxfehler("interactive", "nothing to confirm!");
	}
};
bF.catalog = function(args) { 
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
if (exec_args !== undefined && exec_args[1] !== undefined) {
	bF.load(["load", exec_args[1]]);
	try {
		bF.run();
		return 0;
	}
	catch (e) {
		serial.printerr(`${e}\n${e.stack || "Stack trace undefined"}`);
		println(`${e}`);
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
				println(`${e}`);
			}
		}
		println(prompt);
	}
}
0;
