# Entangled

A live-preview editor for CrochetPARADE patterns. Type instructions on the
left; see the standard crochet chart on the right, with real stitch symbols
(chains, slip stitches, sc/hdc/dc/tr/dtr/trtr, post stitches, puffs, bobbles,
popcorns, etc.) — exactly the symbol library the original CrochetPARADE uses
for its SVG export.

The left pane is split: the top half is the editable pattern source, the
bottom half is an auto-generated plain-English translation that updates as
you type. The right pane is the chart simulator.

A small camera button in the bottom-left of every page captures a screenshot
of the current view plus context (pattern source on the sandbox, settings +
model state on the trainer) and submits it to a local Python feedback server
that forwards the bundle by SMTP for anonymous research collection.

This is a stripped-down spin-off of
[CrochetPARADE](https://www.crochetparade.org/) by Svetlin Tassev. The 3D
rendering, Pyodide translator, GLTF export, periphery analyzer, manual,
example dropdown, and animation features have been removed. What remains is
the bare pipeline:

```
your text  →  parse64.js / simplify64.js   →  graph + DOT
DOT        →  graph64.wasm (force-directed 2D layout)  →  node positions
positions  →  main.js (places standard crochet symbols along the edges
              of the graph using SVG.js, matching the original .svg export)
```

## Running it

### One-click (Windows)

Double-click `run.bat` from the project root. It will:

1. Check GitHub for updates (if this is a git checkout) and let you know if
   you're behind.
2. Create a Python virtualenv at `.venv` if one doesn't exist.
3. Install `server/requirements.txt` into that venv (only fully needed for
   training — the static server and feedback endpoint use only the stdlib).
4. Open two terminal windows: one for the static file server (port 8000)
   and one for the feedback HTTP endpoint (port 8766).
5. Open `http://localhost:8000/` in your browser.

Close the terminal windows to stop the servers.

### Manual

Because `graph64.js` loads `graph64.wasm` over `fetch()`, you need to serve
the folder over HTTP — opening `index.html` directly with `file://` won't
work in most browsers. Any static server works, for example:

```
cd crochet-sandbox
python3 -m http.server 8000
# then open http://localhost:8000
```

If you also want the camera button to send anything, run the feedback server
on the side:

```
python3 server/feedback_server.py
```

It listens on `127.0.0.1:8766` and forwards submissions by SMTP. The first
time you start it, it'll write a template `server/email_config.json` —
edit that with real SMTP credentials before the button will succeed.

## Feedback button

The small camera button in the bottom-left of both pages submits an
anonymous research bundle. It collects:

- A screenshot of the current view (via html2canvas; the button itself is
  excluded from the capture).
- On the **sandbox** page: the current pattern source.
- On the **trainer** page: the current settings (target rounds, difficulty,
  timesteps, reward overrides), the training stats visible in the UI,
  the best pattern found so far, the most recently generated pattern, and
  the generation prefix.

It does NOT collect IP, user-agent, browser fingerprint, or any identifying
header. The Python feedback server also strips its own metadata before
sending the email, so the message arrives from the configured noreply
account only.

See `server/feedback_server.py` for the wire format and `server/email_config.json`
(generated on first run) for the SMTP settings.

## How to use

- Edit the textarea on the left. Stop typing and the chart re-renders
  ~250 ms later.
- The status pill in the header turns plum while compiling, green when
  done, raspberry on error.
- An error overlay slides up over the canvas when the parser rejects your
  pattern. The last successful chart stays visible behind it so you can
  see what you're editing against.
- **Save SVG** downloads the current chart as a portable `.svg` file.

## How the chart is drawn

For each non-hidden stitch node in the parsed graph:

1. Find the two **blue** edges flanking it — these are the same-row links to
   the neighbouring stitches and define the stitch's position and angle.
2. For chains (`ch`) and rings (`ring`), draw the chain symbol between
   those flanks.
3. For everything else, draw a faint guide line (and, for stitches like
   `hdc` / `dc` / `tr` etc., a short black top-bar).
4. Then walk each incoming **red** edge — the within-stitch vertical link —
   and place the matching stitch symbol along it, scaled to ~90% of the
   edge length and rotated to match its angle. Cluster stitches (puffs,
   bobbles, popcorns) walk further back along the red graph to find their
   visual base.

The symbol path data is copied verbatim from CrochetPARADE / `mesh64.js`.

## File map

| File             | Purpose                                                |
| ---------------- | ------------------------------------------------------ |
| `index.html`     | Layout and script loading order                        |
| `style.css`      | All styling, organised with BEM class names            |
| `main.js`        | Entry point — parser-warning suppression, emscripten   |
|                  |   Module config, and the sandbox glue: parse →         |
|                  |   layout → place symbols, debouncing, download.        |
|                  |   Includes the full stitch symbol library.             |
| `parse64.js`     | Verbatim from CrochetPARADE: lexes the grammar         |
| `simplify64.js`  | Verbatim from CrochetPARADE: helpers used by parse64   |
| `graph64.js`     | Verbatim from CrochetPARADE: emscripten WASM loader    |
| `graph64.wasm`   | Verbatim from CrochetPARADE: the 2D layout solver      |
| `svg.min.js`     | Verbatim from CrochetPARADE: SVG.js v2, used for       |
|                  |   bounding-box math and transform composition          |

## CSS naming convention

Styles use [BEM](https://getbem.com/) (`block__element--modifier`). The
blocks are:

| Block        | Purpose                                          |
| ------------ | ------------------------------------------------ |
| `.header`    | The top bar                                      |
| `.brand`     | Title + tagline cluster on the left of `.header` |
| `.controls`  | Status pill + Save-SVG button on the right       |
| `.workspace` | The two-pane grid below the header               |
| `.pane`      | One side of the workspace (Pattern or Chart)     |
| `.editor`    | The pattern textarea                             |
| `.canvas`    | The grid-paper chart area                        |
| `.error`     | Parser-error overlay anchored inside `.canvas`   |
| `.splash`    | Full-screen loading overlay shown at boot        |

State is expressed via modifier classes the JS toggles:
`.controls__dot--ok / --err / --busy`, `.error--visible`,
`.splash--hidden`.

The original CrochetPARADE code is GPLv3.
