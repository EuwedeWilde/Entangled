# Crochet Pattern Trainer

A reinforcement-learning system that learns to write CrochetPARADE patterns.
The browser page (`train.html`) is the control panel. PPO training in PyTorch
and validation against the CrochetPARADE parser happen in a Python process
you run locally.

## The one file you edit: `rules.py`

Everything about *what makes a pattern good* lives in `server/rules.py`.
That file has two things you control:

1. **Vocabulary** — which token strings the agent can emit. Lists called
   `VOCAB_LOW`, `VOCAB_MEDIUM`, `VOCAB_HIGH`.
2. **Scoring** — a function `score(pattern, verdict, target_rounds, difficulty)`
   that returns a number. Big number = good pattern. Negative = bad.

Edit those, restart the trainer, watch the agent learn whatever you taught it
to want. Everything else (the RL plumbing, the websocket server, the UI) is
generic and updates automatically — including the reward editor in the UI,
which is built from the keys in your `rules.REWARDS` dict at runtime.

## Architecture

```
   Browser (train.html / train.js)
              │
              │  WebSocket (JSON messages)
              ▼
   Python server (server/train_server.py)
   ├── PPO via stable-baselines3
   ├── CrochetTokenEnv  (generic — emits one token at a time)
   ├── rules.py         (← YOU EDIT THIS)
   └── ParserClient ──┐
                      │
                      ▼
              Node worker (server/parser_worker.js)
                      ├── parse64.js
                      └── simplify64.js
```

## Prerequisites

- Python 3.10+
- Node.js 18+ (hosts the parser worker)
- A web server for the static files (`python3 -m http.server` works)

Install Python deps:

```bash
pip install -r server/requirements.txt
```

The Node worker has zero npm dependencies — it runs the project's
`parse64.js` and `simplify64.js` straight from the project root.

## Running it

Two terminals:

### 1. Start the trainer

```bash
cd entangled
python3 server/train_server.py
```

You should see:

```
crochet trainer listening on ws://127.0.0.1:8765
```

### 2. Serve the static site

```bash
cd entangled
python3 -m http.server 8000
```

Open `http://localhost:8000/train.html`. The status pill should turn into
"connected".

## Using the trainer

1. **Configure** in the left pane:
   - **Target rounds**: how many rounds the agent should aim for.
   - **Difficulty**: which vocabulary it gets to pick from
     (`VOCAB_LOW` / `VOCAB_MEDIUM` / `VOCAB_HIGH` in `rules.py`).
   - **Training timesteps**: PPO step budget. Token-level training is slower
     than procedural — start at 20,000 and scale up if needed.
   - **Reward weights** (under Advanced): overrides for `rules.REWARDS`.
     Leave a field blank to use the default from `rules.py`.

2. **Start training**. The centre pane shows mean episode reward over time
   and the best pattern found so far. Pause / resume / reset model at will.

3. **Generate from a prefix**. The right pane lets you type any starting
   CrochetPARADE source. When you hit Generate, the server seeds the env
   with your prefix, then rolls out the trained policy to extend it.

4. **Open in sandbox** sends the chosen pattern to the original sandbox
   page (`index.html`).

## Writing your own rules

Open `server/rules.py`. You'll see:

```python
VOCAB_LOW = ["6ch.Ring+1!", "ch", "sc", "dc", ",", "[", "]", "*4", "*2",
             "ss@[%,0]", "\n", "<END>"]
```

This is the list of tokens the agent can emit, one per step. Add or remove
anything you like — but keep `"<END>"` in there (that's how the agent signals
"pattern is finished, please score it") and `"\n"` (the round separator).

Then the scoring function:

```python
def score(pattern, verdict, target_rounds, difficulty):
    r = 0.0
    if verdict.ok:
        r += REWARDS["parses"]
    else:
        r += REWARDS["parse_fail"]
    # ... etc.
    return r
```

You get:
- `pattern` — the full text the agent produced.
- `verdict.ok` — did the parser accept it?
- `verdict.n_stitches` — total stitch count (only meaningful if `ok`).
- `verdict.error` — parser error string if `ok` is False.
- `target_rounds` — what the UI slider was set to.
- `difficulty` — `"low"` / `"medium"` / `"high"`.

Return a number. Done.

Tips:
- Keep returned numbers in roughly the `-50 .. +100` range. PPO is finicky
  about huge reward spikes.
- Reward shape > reward magnitude. Multiple small bonuses for things you like
  trains faster than one big bonus for the perfect pattern.
- If the agent finds a degenerate local minimum (e.g. just emitting one valid
  short pattern over and over), add a *variety* bonus — for example, hash
  the pattern and reward novelty.

## How the loop works (the boring part)

Each episode:
1. Env starts empty. Agent picks one token. Repeat.
2. When the agent emits `<END>`, or after `MAX_TOKENS_PER_EPISODE` tokens,
   the env joins everything into a string, asks the Node parser worker if
   it's valid CrochetPARADE, then calls `rules.score()`.
3. That single number is the entire episode's reward (sparse — every step
   gets 0 except the last).
4. PPO updates its policy from a batch of episodes and the loop repeats.

The Node worker stays alive for the whole training run and validates one
pattern per stdin line, so parser overhead is bounded to ~7ms per check.

## Troubleshooting

- **"ws error" / can't connect**: the Python trainer isn't running, or it's on
  a different port. Check the trainer terminal.
- **"parser worker died at startup"**: `node` isn't on PATH, or `parse64.js`
  has moved. The worker logs to the trainer's stderr.
- **Training stalls at very low reward**: your scoring function probably
  isn't giving enough signal for *partial* good behaviour. Add small bonuses
  for things on the way to good (e.g. "starts with a ring" gives +5 even if
  the rest is garbage). Sparse rewards are PPO's nightmare.
- **Patterns look random**: more training steps, or shrink the vocab. The
  smaller the vocab, the faster PPO converges.

## Files

| file                          | edit it? | purpose |
|-------------------------------|----------|---------|
| `server/rules.py`             | **yes**  | Vocab + score function. Your code. |
| `server/crochet_env.py`       | no       | Generic token-by-token Gym env. |
| `server/train_server.py`      | no       | WebSocket server + PPO supervision. |
| `server/parser_client.py`     | no       | Python ↔ Node parser worker bridge. |
| `server/parser_worker.js`     | no       | Persistent Node parser process. |
| `train.html` / `.css` / `.js` | no       | The UI. |
