let src = "var tObj = {}; tObj.testvalue = 'hai'; tObj;"

var testGlobalObject = eval(src);

serial.println(testGlobalObject.testvalue);