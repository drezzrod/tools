# tools

## **BMP2JIM.JS**

### **Commands**

**node bmp2jim.js export TeamBlocks94.map.jim**   
writes a 4-bit, 16-colour TeamBlocks94.bmp at 88×448, using the palette in the jim.

**node bmp2jim.js import TeamBlocks94.bmp TeamBlocks94.map.jim**  
writes your edit back. It makes a .bak copy first, or you can send the result elsewhere with **--out.**

**node bmp2jim.js import sud.bmp TeamBlocks94.map.jim --team 28**  
puts a single 88×16 banner into one team’s rows. This is the command you’ll use for Sudbury (additional team).

**info**  
shows a file’s tile count, map size and palette lines.


### **What it does with colours**

_Indexed BMPs:_  
If you paint in an editor on a 16-colour BMP, the colour numbers stay exactly as you painted them, and number 0 stays transparent.

_24-bit BMPs:_  
These are snapped to the Genesis 3-bit-per-channel colours. If the picture has more than 16 colours, it is reduced to 16 with no dithering.

_Palette on partial imports:_  
With **--team** or **--at-row**, the palette already in the jim is kept. My first version wrote a new palette on every import, which recoloured all 27 other banners in the placeholder view. Add **--write-palette** if you do want the BMP’s palette written.

_Palette-less jims:_  
Files like logoTOR have no palette block of their own, so only the colour numbers are imported.


### **Layout**

Banner files that are already full blocks stay full blocks.

Condensed files such as the logos stay condensed, and repeated or mirrored tiles are shared again automatically.

**--dedupe** and **--expand** force one layout or the other.

Every import reads the file back and checks it pixel for pixel before it reports success.


**Where to put the result:**

build:dev can re-extract Extracted\ and overwrite your edits. Keep your edited jims somewhere safe, such as Custom\Graphics, and make sure the build reads from there.


**Not covered:**__

Palette lines: It writes a single palette line, which is all the banners and logos use. A picture that needs two or more palette lines at once would need the repo’s colour-reduce step.
Jzip files: It refuses packed .jzip files.


## **PAL2ACT.JS**

### **Usage:**

node pal2act.js MatchupPalANHA.pal writes the .act next to the .pal.
You can list several files, or pass a folder to convert every .pal in it, for example node pal2act.js Pals --out acts.
Add --short to write the 772-byte form, which also records that there are only 16 colours, with colour 0 as transparent. Use it if Photoshop shows 256 colours instead of 16.
64- or 128-byte palette files (2 or 4 lines) fill the ACT 16 colours per line, in order.

It doesn’t convert in the other direction yet. TO be created: act2pal, so an edited palette can go back into the game’s .pal files.


## **EXPAND_LOGOS.JS**

Turns each of the 28 team logo .JIM files into a full 6×6 picture of 36 tiles, one per map cell.

### **What it does**

Old layout: Retail ROM stores 17 to 36 unique tiles per logo, and the map repeats and mirrors them differently for each team.

New layout: Tile N is simply cell N, read row by row with 6 across. Nothing is mirrored or repeated.

Palette: Logo files have no palette of their own. The game supplies one from TeamLogoPalettes, and the tool leaves that alone.

Why the game still works: The logo routines read the tile count from the file header. Every screen that loads a logo already reserves 36 characters for it, which matches 36 tiles exactly. No game code is changed.

Cost: The logos take 7,584 more bytes of ROM in total.

How it works: Like the banner fix, it patches tools\extractAssets94.js so the extraction writes the logos in the full form, then runs the extraction again. build:dev won’t turn them back into the condensed form.

How to run it: Use **node expand_logos.js** from the repo folder. **--check** shows each logo’s current form and **--und**o restores the originals. Run it before you paint anything. It re-extracts Extracted\, which replaces your current logo files, though copies go to backup_before_logos\ first.

Painting a logo: bmp2jim.js already handles these files. Run **node bmp2jim.js export Extracted\NHL94\Graphics\logoANA.map.jim** to get a 48×48 BMP, then import writes your edit back. A round trip of the expanded Anaheim logo came back byte-identical.

Palettes while painting: The BMP shows a grey ramp, because the real colours come from TeamLogoPalettes in **title94.asm**. Paint with the colour numbers, and use **pal2act.js** on the team’s palette if you want the real colours loaded in your editor.
