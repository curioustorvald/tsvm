#include <stdio.h>
#include <stdint.h>
#include <string.h>

char word_to_byte(char * inbuf) {
    return
        ((*(inbuf + 0) & 1) << 7) | 
        ((*(inbuf + 1) & 1) << 6) |
        ((*(inbuf + 2) & 1) << 5) | 
        ((*(inbuf + 3) & 1) << 4) | 
        ((*(inbuf + 4) & 1) << 3) | 
        ((*(inbuf + 5) & 1) << 2) | 
        ((*(inbuf + 6) & 1) << 1) | 
        ((*(inbuf + 7) & 1) << 0);
}


int main(int argc, char const *argv[]) {
    FILE * infile;
    FILE * outfile;
    char word[8];
    
    infile = fopen(argv[1], "r");
    outfile = fopen(argv[2], "w");

    int exit = -1;
    while (exit < 0) {
        for (int i = 0; i < 8; i++) {
            int b = fgetc(infile);
            if (b == -1 && exit < 0) exit = i;
            word[i] = (char) b;
        }
        
        if (exit == 0) break; // if the first byte is EOF, do not write out
        
        fputc(word_to_byte(word), outfile);
    }
    
    fflush(outfile);
    fclose(infile);
    fclose(outfile);
    
    return 0;
}
