local args = {...}

-- bin file to JS source

local width = tonumber(args[2])
local height = tonumber(args[3])
local arrayname = args[4]
local arraydec = "var "..arrayname.."=[];"
local arrayopen = "["
local arrayclose = "]"
local lineend = ";"

-- row starts from zero
function arraypopulate(row, fulldata)
    offset = width * row
    ret = arrayopen..fulldata:byte(1 + offset)
    for i = 1, (width - 1) do
        ret = ret..","..tostring(fulldata:byte(1 + offset + i))
    end
    return arrayname..arrayopen..tostring(row)..arrayclose.."="..ret..arrayclose..lineend
end

local fi = assert(io.open(args[1], "rb"))
local content = fi:read("*all")
fi:close()

print(arraydec)
for k = 0, height - 1 do
    print(arraypopulate(k, content))
end