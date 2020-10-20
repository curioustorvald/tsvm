serial.println(typeof atob);

const inputstr =
"//////////////////////////////////////////j//////////////"+
"/////////////////j////////////////////////z8/P///j///+hoaGhof+hof////////Pz//////j//6Gh//////+hof////////Pz//////j//6"+
"Gh//////+hoaGhof//8/Pz8/P///j///+hoaH///+hof//oaH///Pz//////j//////6Gh//+hof//oaH///Pz//////j///////+hof+hof//oaH///P"+
"z//////j///////+hof+hof//oaH///Pz//////j//6GhoaGh//+hof//oaH///////////j///////////////////////////////j/////////////"+
"////////////////////////////////////////"
serial.println(inputstr);
//FIXME bad Base64.atob impl
serial.println(base64.btoa(base64.atob(inputstr)))

var zipbin = gzip.comp(base64.atob(inputstr));
var zipped = base64.btoa(zipbin);
serial.println(zipped);

//var unzipped = base64.btoa(gzip.decomp(zipbin));
var unzipped = base64.btoa(gzip.decomp(base64.atob(zipped)));

serial.println(unzipped);

serial.println("It is now safe to turn off");