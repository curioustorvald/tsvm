# Videotron2K

Videotron2K emulates hypothetical video display controller where target video device has framebuffer and the controller has a 1 scanline buffer and 16 registers and programmed in specialised assembly.

When program is running, video display controller must maintain the output signal (unless explicitly blanked, this behaviour depends on the display controller) and when the program ends, screen must be blanked.

## Registers

Videotron2K has 6 general and 4 special register, of which

- r1 through r6 : general register of 32 bit signed integer
- tmr : an RTC of signed integer, resolution of a milisecond
- frm : a frame counter of 32 bit signed integer
- px and py : a cursor where drawing operation is happening
- c1 through c6 : counter variable in 32 bit signed integer

Most commands accept pseudo-register of '0', which returns 0 when read and ignores any writing attempts.

The system uses two's complement for negative numbers.

## Assembly Format

Consider the following code snippet:

```
DEFINE RATEF 60  ; 60 fps
DEFINE height 448
DEFINE width 560

SCENE initialise
  @ mov r1 height     ; this line runs only once when the SCENE is called

    fillin 254 r1 0 width  ; fillin fills entire scanline.
                            ; Syntax: fillin pixel-value scanline x-start x-end-exclusive
                            ; final (px,py) will be (scanline,x-end-exclusive)
    dec r1
    exitzr r1          ; if condition is not met, the next line runs
                         ; if next line is not there, it goes to the first non-@ line
END SCENE

SCENE 0     ; indexed scene
    goto 100 100         ; moves pixel cursor to (x,y) = (100,100)   
    plot 1 54 231 7 82 64 22 5 ; writes following bytes into the framebuffer
END SCENE

SCENE 1     ; indexed scene
    goto 100 102         ; moves pixel cursor to (x,y) = (100,102)   
    plot 231 1 54 17 182 62 2 35 ; writes following bytes into the framebuffer
END SCENE

SCENE anim
  @ define cnt 2      ; definition of the local constant
  @ mov c1 0
    perform c1        ; accessing the indexed scene
    inc c1            ; slightly inefficient way to make comparision
    cmp c1 cnt r1     ; slightly inefficient way to make comparision
    exitzr r1
END SCENE

perform initialise   ; this command executes whatever defined in the target scene
                     ; perform only accepts scene name

perform anim

goto 0 447
plot 0 0 254 254

next                 ; advance a frame counter (frm) and sleeps until it is time to draw next frame
exeunt               ; this explicitly ends the program
```

### Conditional Postfixes

Commands can have "conditional postfix" used to execute the command conditionally.

- zr r : if r == 0
- nz r : if r != 0
- gt r : if r > 0
- ls r : if r < 0
- ge r : if r >= 0
- le r : if r <= 0

## Programming Guidelines

### Scene

* A scene will always need one or more `exit` command; scenes are infini-loop object and without `exit`, there will be no way to terminate the scene.

### Program

* A program will not infini-loop on its own; you need to explicitly enter the `loop` command.


## Available Commands

### Arithmetic

NOTE : immediates and variables can substitute registers

* add rA rB rC : rC = rA + rB
* sub rA rB rC : rC = rA - rB
* mul rA rB rC : rC = rA * rB
* div rA rB rC : rC = rA / rB
* and rA rB rC : rC = rA & rB
* or rA rB rC : rC = rA | rB
* xor rA rB rC : rC = rA ^ rB
* shl rA rB rC : rC = rA << rB
* shr rA rB rC : rC = rA >> rB
* ushr rA rB rC : rC = rA >>> rB

* inc R : R = R + 1
* dec R : R = R - 1
* not R : R = !R (ones' complement of R)
* neg R : R = -R (twos' complement of R)

### Conditional

NOTE : immediates and variables can substitute registers

* cmp rA rB rC : compares rA and rB and stores result to rC. 1 if rA > rB, -1 if rA < rB, 0 if rA == rB.

### Data Control

NOTE: Any drawing command will clobber internal memory starting from address zero.

* mov rA rB/I : assignes rA with contents of rB/constant I
* data rA/I bytes : writes bytes to the internal memory of address starting from rA/I
* mcp from y x len : copies part of the internal memory to the framebuffer, from the internal memory address `from`,
                        to scanline `y`, horizontal position `x`, with copying length of `len`.

### Flow Control

* perform scenename : gosub into the scenename
* jumpto label_name : goto the label name. JUMPTO only works when the label is within the same scope.
* next : advance a frame counter (frm) and sleeps until it is time to draw next frame
* loop : will jump to the beginning of the current scope (scene). @-padded line will NOT be executed. The opposite of EXIT
* exit : terminates current scene. System will error out if this command is used outside of a scene. The opposite of LOOP
* exeunt : completely terminates the program

### Drawing

NOTE: Any drawing command will clobber internal memory starting from address zero.

* fillin byte y x-start y-end-exclusive : fills entire scanline of `y` with `byte` from the horizontal position `x-start` through
                                          `y-end-exclusive` MINUS ONE. final (px,py) will be (scanline,x-end-exclusive)
* plot byte... : writes bytes into the framebuffer. The `px` register will auto-increment but `py` won't!
* fillscr byte : fills entire screen with a given byte
* goto x y : writes `x` to px and `y` to py (use `mov px <something>` to write to px/py only)
* border r g b : sets border colour

### Timing Control

* wait : waits for external signal before advancing to next frame.

### Assembler-only

* define : defines a global variable
* defvar : defines a scene-local variable
* scene name|number : defines a named scene
* end scene : ends a scene definition

#### Predefined Constants

* RATET : framerate defined by miliseconds between each frame. Mutually exclusive with RATEF.
* RATEF : framerate defined by how many frames must be shown in one second. Mutually exclusive with RATET.

### Auto-incrementation

Some instructions will cause a register to auto-increment. Auto-increment rule is as follows:

* `px` : px = (px + 1 fmod width)
* `py` : py = (py + 1 fmod height)
* If an arithmetic command is used against `px` or `py` register, above rules will apply to the registers.