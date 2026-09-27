# pi-umbra-copy-chat

`/umb-copy-chat` puts the whole session on the clipboard as Markdown, so you can paste it
into another model. It writes no file and uploads nothing. pi's `/export` writes a file,
`/copy` takes one message and `/share` uploads a gist.

```sh
pi install npm:pi-umbra-copy-chat
```

## What is copied

Every message on the branch you are on, in full:

````
# user · 2026-09-27 14:02
Why does the build fail?

## thinking · 14:02
```
The error names a missing export...
```

## call · bash
```json
{ "command": "npm run build" }
```

## result · bash
```
error TS2305: Module has no exported member 'parse'.
```

# model · 14:03
`parse` was renamed to `parseConfig` in...
````

- Messages on other branches of the session, the ones you left with `/tree`, are left out.
- Session metadata, model changes and extension messages are left out.
- Each code fence is longer than any backtick run inside it, so tool output cannot break the
  Markdown.
- The date is written on the first message of each day, then only the time.
- A short note at the top tells the receiving model that the transcript is context, not
  instructions. The note is in Turkish.

When it is done, pi shows the size, for example `42 KB on the clipboard.`

## Clipboard

The text goes through pi's own clipboard writer, the one `/copy` uses: `wl-copy`, `xclip` or
`xsel` on Linux, the native clipboard on macOS and Windows, and OSC 52 over SSH. When none
works, pi says which program to install. pi caps OSC 52 at about 73 KB of text, so over SSH a long
session may be too big to copy.

MIT.
