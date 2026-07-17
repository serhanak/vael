# Lossy-save test

This file mixes scripts that no single legacy (single-byte) encoding can hold,
so converting the document to one and saving must trigger the lossy dialog.

- Turkish (in Windows-1254): şğİıöüç
- Cyrillic (NOT in Windows-1254): Привет, мир
- An emoji (in no legacy encoding): 🚀

How to use: Convert the encoding to **Windows-1254** (status bar → encoding
menu), then press **Save** (or Ctrl+S). The Cyrillic and emoji cannot be
represented in Windows-1254, so the 3-option lossy dialog must appear:
"Save as UTF-8" / "Save anyway" / "Cancel".
