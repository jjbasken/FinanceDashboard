These two books were written by GnuCash 5.10 itself (through its Python bindings), from
`make.py`, with the same made-up content: once in GnuCash's default compressed XML format and
once as sqlite3. The importer tests check that both read identically.

To regenerate, build an image with Debian's `gnucash` and `python3-gnucash` packages (set
`LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu/gnucash`), run `make.py` with this folder mounted at
`/out`, and rename `book-xml.gnucash` and `book.sqlite` to the names here.
