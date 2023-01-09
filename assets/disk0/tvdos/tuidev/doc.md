
DATA STRUCTURE

```
[
    [main Window Objects],
    [popup Window Objects] 
]
```

Window Object

```javascript
{
  "isFocused": false,
  "inputProcessor": (this, inputEvent) => { ... },
  "drawFrame": (this) => { ... },
  "drawContents": (this) => { ... },
  "width": 20,
  "height": 12,
  "x": 1,
  "y": 3,
  "title": undefined
}
```

BEHAVIOUR

1. Key event is parsed
2. If key is Tab, move focus to the next Window Object within the current window
3. If not, pass the event to the currently focused Window Object

No key combination will allow navigating between windows
e.g. Tabbing on the question popup will just loop through the Ok/Cancel buttons, until the buttons are pressed.

