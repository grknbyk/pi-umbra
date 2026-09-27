// The model writes every question, label and description an extension shows, so they are
// untrusted bytes headed for a terminal - a parser, not a canvas. Strip at ingest, so the raw
// string is never stored and no renderer can ever see it.
//
// The C0/C1 range kills ESC, BEL and the 8-bit CSI/OSC introducers. No escape-sequence grammar
// is needed: remove the introducer and the residue ("]52;c;aGk=") is inert text the emulator
// never enters a parser state for.
//
// The bidi set is enumerated, not swept: ZWNJ and ZWJ sit right beside it at U+200C/U+200D and
// must survive, or emoji families split and Arabic, Persian and Hindi shaping breaks. Both
// patterns are built from escapes so the file stays pure ASCII and readable in a diff.
//
// This lives outside extensions/ for two reasons: pi loads every .ts in that folder as an
// extension, and keeping the helper free of imports is what lets tests/ask-clean.test.ts run
// without resolving pi's own packages.
const CONTROL = new RegExp("[\u0000-\u001f\u007f-\u009f]", "g");
const BIDI = new RegExp("[\u200e\u200f\u202a-\u202e\u2066-\u2069]", "g");

export const clean = (text: string) => text.replace(CONTROL, "").replace(BIDI, "");

// A preview is a block, not a line. The newline is the one control character it needs, and
// `clean` is right to take it everywhere else: folding an ASCII mockup onto one row is exactly
// what happened before this existed. Cleaning line by line keeps \n and still drops the rest of
// the C0/C1 range, carriage return included - that one moves the cursor, not the line.
export const cleanBlock = (text: string) => text.split("\n").map(clean).join("\n");
