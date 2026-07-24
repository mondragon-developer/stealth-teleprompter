# LinkedIn post

Draft for announcing Screen Script when it is ready to show. Post it with a
short screen recording: one half showing your monitor with the prompter
floating over your slides, the other half the live Zoom or Meet participant
view where the prompter simply does not exist. That clip is the whole
argument; the text only sets it up.

Before posting: replace the repo link placeholder, and rewrite the "why"
paragraph in your own words if you want a different personal angle.

## Main post

There was a teleprompter running on my screen during my entire last
presentation.

Nobody on the call saw it.

Not because they missed it. Because their screen share cannot capture it:
the window tells the operating system to exclude itself from every capture
API. Zoom, Meet, Teams and OBS all skip it. I see my script; you see my
slides.

I built it, and it is open source. It is called Screen Script.

Why: English is not my first language. I can improvise in Spanish all day,
but for a high-stakes presentation in English I want my exact words in
front of my eyes, at eye level, without looking down at notes and losing
the audience.

What it does:

- Floats over your slides, invisible to screen shares, recordings and
  screenshots
- Auto-scrolls at your speaking pace, with live speed control
- Global hotkeys that work while PowerPoint or the browser has focus
- Ghost mode: your mouse clicks straight through the prompter to the
  slides underneath
- Remembers your reading position in every script

The stack: Rust and Tauri 2 with a vanilla JavaScript frontend. Why Tauri
and not Electron? It renders in the operating system's own webview instead
of shipping a whole browser, so the installer is a few megabytes and memory
stays low. The core is Rust, which puts the native window APIs one call
away - the entire invisibility trick is a single flag,
SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE. And the same codebase
can become the iPhone app next. Everything else is teleprompter craft.

News anchors have used teleprompters for seventy years and nobody calls it
cheating. This one just fits in a video call.

Installers for Windows and macOS, and all the code: [repo link]

If you present in your second language, or you just want your notes where
your eyes already are, try it and tell me what to build next.

#opensource #rust #tauri #publicspeaking #remotework

## Alternative openers

Swap the first three lines for one of these if you want a different hook:

1. "What if your presentation notes floated right over your slides, and
   your screen share could never see them? I built that."

2. "News anchors get a teleprompter. Keynote speakers get a confidence
   monitor. On Zoom you get a sticky note on your bezel. I fixed that."

3. "I stopped memorizing presentations. My last one was word-perfect
   anyway. Here is the trick."

## Posting notes

- LinkedIn cuts the post after roughly the first three lines; everything
  before "see more" has to earn the click. That is why the draft opens on
  the claim, not the product name.
- Reach is better when the post itself has no external link. Put the repo
  link in the first comment and change the line above to "Link in the
  first comment."
- Reply to every comment in the first two hours; the algorithm rewards it.
- A follow-up post a week later ("what people asked me about the invisible
  teleprompter") usually outperforms the launch post.
