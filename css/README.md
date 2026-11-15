# css/

| File | What it is |
|---|---|
| `style.css` | Every style in the app, laid out for a fixed 1920×1080 screen. |

How it's organised:

- **Tokens** at the top, in `:root`: colours, the spacing scale (`--top`, `--s-xs` to `--s-xl`) and layout widths. Use these instead of new numbers.
- **Sections** follow the screen from top to bottom: side menu, banner, rows and cards, pop-ups (details, person, season, full text, Genre / Publisher, picture picker), Downloads, Settings, the player and the loading screen.
- **Layout maths** is written in comments next to the rules it explains (for example how a row adds up to 367 px). Keep them up to date when sizes change.

Rules from [AGENTS.md](../AGENTS.md) that apply here: it must work on Chromium 63 (no flex `gap`, `inset` or `aspect-ratio`), and only `transform` and `opacity` are animated, so movement stays smooth on the TV.
