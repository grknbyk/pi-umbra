# pi-umbra-preview

`/umb-preview <file>` opens a document in your browser, rendered. A Markdown file in the
terminal is its source text. This turns it into a page with pandoc.

```sh
pi install npm:pi-umbra-preview
```

| Command | Effect |
|---|---|
| `/umb-preview README.md` | render with pandoc, open in the browser |
| `/umb-preview @docs/plan.md` | a leading `@` from pi's file picker is fine |
| `/umb-preview report.pdf` | open as it is |

- A path is taken from the folder pi was started in.
- `.pdf`, `.html`, `.htm`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif` and `.webp` open directly.
- Anything else goes through pandoc into one self-contained file in
  `<temp>/pi-umbra-preview/`.
- Mermaid blocks are drawn as diagrams. The page loads mermaid from the jsDelivr CDN for that,
  so it needs a network connection.

## pandoc

pandoc is not included. Nothing checks for it until you preview a file, and if it is missing
pi tells you how to install it:

| System | Command |
|---|---|
| Linux | `sudo apt install pandoc`, or your distribution's package |
| macOS | `brew install pandoc` |
| Windows | `winget install --id JohnMacFarlane.Pandoc -e` |

MIT.
