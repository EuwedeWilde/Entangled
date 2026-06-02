"""
rules.py  —  THE FILE YOU EDIT.

The environment builds rows procedurally and every pattern it produces is
guaranteed-valid CrochetPARADE syntax. This file decides:

  1. STITCHES / COLUMNS   — the palette of column types per difficulty.
  2. ROW BUILDERS         — how a column-row is written.
  3. score(...)           — how good a finished pattern is. Bigger = better.

================================ GRANNY SQUARE ================================

Growth model:

  Round 0 : a magic ring  ->  `ring.R`
  Round 1 : 4 columns.   Round 2 : 8.   Round 3 : 12.   Round R : 4*R.
  Every round adds exactly +4 columns (one per corner).

THERE IS ONLY ONE ROW TYPE: a COLUMN ROW.

  A "column" is one of:
    * a CLUSTER of 3, 4, or 5 of a plain stitch
        3 x [sc,hdc,dc,tr,dtr,trtr]   (e.g. 3dc)
        4 x [sc,hdc,dc,tr,dtr,trtr]   (e.g. 4tr)
        5 x [sc,hdc,dc,tr,dtr,trtr]   (e.g. 5hdc)
    * a SINGLE plain stitch  (sc | hdc | dc | tr | dtr | trtr)
    * a SINGLE textured token, worked as its own column:
        hdc3puff / hdc4puff / hdc5puff       (puff stitches)
        dc3bobble / dc4bobble / dc5bobble    (double-crochet bobbles)
        tr4bobble                            (treble bobble)
        dc3pc / dc4pc / dc5pc                (popcorns)
        picot3                               (3-ch picot loop)

  Columns are separated by labelled chain-spaces. There are no "stitch rows".

LABELS — everything emitted is labelled:
  * every individual stitch  ->  st_R_n     (R = row, n = stitch index)
  * every column GROUP        ->  cl_R_k     ([...] carries .cl_R_k)
  * every chain-space GROUP    ->  cs_R_k    (the chain run carries .cs_R_k)

CHAINS — every chain run sits in the 2..5 range. The corner gap is always at
least 3 and the side gap is always at least 2; both are capped at 5. The side
gap and corner gap are each a single value per row, so EVERY side gap in a row
is identical and EVERY corner gap in a row is identical (e.g. sides=2,
corners=3).

SETUP CHAIN — the turning chain equals the column stitch's height
(sc=1 hdc=2 dc=3 tr=4 dtr=5 trtr=6) and is counted as the row's first stitch
(st_R_1) UNLESS the column is a textured single token (puff/bobble/popcorn/
picot), in which case it is a plain turning chain that is NOT a stitch. A real
stitch — never a lone `ch` — always follows the setup chain.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# =============================================================================
# 1. STITCH + COLUMN PALETTE
# =============================================================================

PLAIN_STITCHES = {"sc", "hdc", "dc", "tr", "dtr", "trtr"}

# Multi-stitch column clusters: name -> (base_stitch, count).
# A cluster can be any size 1..5 across every plain stitch. The size-1 entry
# (e.g. "1dc") is just an explicit single-stitch column; a bare "dc" resolves
# to the same thing via cluster_spec's fallback.
MULTI_CLUSTERS: dict[str, tuple[str, int]] = {}
for _n in (1, 2, 3, 4, 5):
    for _s in ("sc", "hdc", "dc", "tr", "dtr", "trtr"):
        MULTI_CLUSTERS[f"{_n}{_s}"] = (_s, _n)

# Single-token columns (one token that is itself a whole column).
# Their turning chain is NOT counted as a stitch.
#   - puffs:    hdcNpuff   (N = 3,4,5)
#   - bobbles:  dcNbobble  (N = 3,4,5), tr4bobble
#   - popcorns: dcNpc      (N = 3,4,5)
#   - picot:    picot3
SINGLE_CLUSTERS = {
    "hdc3puff", "hdc4puff", "hdc5puff",
    "dc3bobble", "dc4bobble", "dc5bobble",
    "tr4bobble",
    "dc3pc", "dc4pc", "dc5pc",
    # picot3 is intentionally NOT here: a picot is a self-closing 3ch loop with
    # no stitch "top", so it cannot serve as a round's anchor stitch (the
    # closer's ss@ would have nothing to bite). Picots only work tucked between
    # real stitches, which this single-cluster-per-column structure can't do.
}

STITCH_HEIGHTS = {
    "sc": 1, "hdc": 2, "dc": 3, "tr": 4, "dtr": 5, "trtr": 6,
    "hdc3puff": 2, "hdc4puff": 2, "hdc5puff": 2,
    "dc3bobble": 3, "dc4bobble": 3, "dc5bobble": 3,
    "tr4bobble": 4,
    "dc3pc": 3, "dc4pc": 3, "dc5pc": 3,
    "picot3": 1,
}

TEXTURED = SINGLE_CLUSTERS

BODY_BY_DIFFICULTY = {
    "low": [
        "3dc", "3hdc", "4dc", "dc", "hdc",
    ],
    "medium": [
        "3dc", "3hdc", "3tr", "4dc", "4hdc", "5dc",
        "dc", "hdc", "tr",
        "dc4bobble", "hdc3puff", "dc3pc",
    ],
    "high": [
        # clusters of 2 (sc, dc, tr, dtr, trtr — hdc intentionally omitted)
        "2sc", "2dc", "2tr", "2dtr", "2trtr",
        # clusters of 3/4/5 across every plain stitch
        "3sc", "3hdc", "3dc", "3tr", "3dtr", "3trtr",
        "4sc", "4hdc", "4dc", "4tr", "4dtr", "4trtr",
        "5sc", "5hdc", "5dc", "5tr", "5dtr", "5trtr",
        # single plain stitches
        "sc", "hdc", "dc", "tr", "dtr", "trtr",
        # textured single-token columns
        "hdc3puff", "hdc4puff", "hdc5puff",
        "dc3bobble", "dc4bobble", "dc5bobble", "tr4bobble",
        "dc3pc", "dc4pc", "dc5pc",
    ],
}

# =============================================================================
# STITCH SELECTION MENU
# =============================================================================
# The UI lets the user tick which stitches the agent may use, instead of
# picking a coarse difficulty. Each entry maps a human-facing menu id to the
# CrochetPARADE body token actually emitted. Add/rename here and the menu in
# train.html / train_simplified.html updates from the /menu broadcast.
#
#   id           label                token        default-checked
STITCH_MENU = [
    ("sc",        "Single",            "sc",        False),
    ("hdc",       "Half double",       "hdc",       True),
    ("dc",        "Double",            "dc",        True),
    ("tr",        "Treble",            "tr",        True),
    ("dtr",       "Double treble",     "dtr",       False),
    ("trtr",      "Triple treble",     "trtr",      False),
    ("hdc3puff",  "Half double puff",  "hdc3puff",  False),
    ("dc4bobble", "Double bobble",     "dc4bobble", False),
    ("tr4bobble", "Treble bobble",     "tr4bobble", False),
    ("dc3pc",     "Popcorn",           "dc3pc",     False),
]

# token -> menu id, for validating an incoming custom selection.
_MENU_TOKENS = {tok for (_id, _label, tok, _d) in STITCH_MENU}
_MENU_ID_TO_TOKEN = {mid: tok for (mid, _label, tok, _d) in STITCH_MENU}


def get_stitch_menu() -> list[dict]:
    """Menu definition sent to the UI to build the stitch checkboxes."""
    return [{"id": mid, "label": label, "token": tok, "default": default}
            for (mid, label, tok, default) in STITCH_MENU]


def resolve_custom_bodies(selection: list[str]) -> list[str]:
    """Turn a UI selection (menu ids or tokens) into a clean body-token list.

    Accepts either menu ids ('sc') or raw tokens ('dc3pc'); both map to tokens.
    Unknown entries are dropped. Order follows STITCH_MENU so runs are
    reproducible regardless of click order. Falls back to a sensible default
    if nothing valid was selected.

    Selecting a PLAIN stitch enables the single plus every cluster size of it,
    so e.g. ticking "Treble" yields tr, 2tr, 3tr, 4tr, 5tr. Textured tokens
    (puff/bobble/popcorn) are already self-contained multi-stitch columns with
    no cluster sizes, so they pass through unchanged."""
    chosen: list[str] = []
    want = set()
    for item in selection or []:
        s = str(item)
        tok = _MENU_ID_TO_TOKEN.get(s, s if s in _MENU_TOKENS else None)
        if tok:
            want.add(tok)
    for (_mid, _label, tok, _d) in STITCH_MENU:   # preserve menu order
        if tok not in want:
            continue
        if tok in PLAIN_STITCHES:
            # single (1x) + clusters of 2..5
            chosen.append(tok)                # bare single column
            for n in (2, 3, 4, 5):
                cl = f"{n}{tok}"
                if cl not in chosen:
                    chosen.append(cl)
        else:
            if tok not in chosen:
                chosen.append(tok)
    if not chosen:
        # Nothing valid ticked — default to single + double so the agent can
        # still build a square rather than erroring out.
        chosen = ["sc", "dc"]
    return chosen


# Side gaps: 2..5.  Corner gaps: 3..5.  (Both capped at 5.)
SIDE_GAP_CHOICES = [2, 3, 4, 5]
CORNER_GAP_CHOICES = [3, 4, 5]
# What the env offers as the shared gap-action vocabulary. We expose the full
# 2..5 range; the builders clamp side>=2 and corner>=3 on top of whatever the
# agent picks, so an out-of-policy pick is corrected rather than rejected.
GAP_CHOICES = [2, 3, 4, 5]


def get_body_stitches(difficulty: str,
                      custom: Optional[list[str]] = None) -> list[str]:
    """Bodies the agent may emit. If `custom` is given (a UI stitch
    selection), it wins and `difficulty` is ignored."""
    if custom:
        return resolve_custom_bodies(custom)
    return BODY_BY_DIFFICULTY.get(difficulty, BODY_BY_DIFFICULTY["medium"])


def get_gap_choices(difficulty: str) -> list[int]:
    return GAP_CHOICES


# Only column rows exist now.
ROW_TYPES = ["cluster"]


def get_row_types() -> list[str]:
    return ROW_TYPES


def stitch_height(stitch: str) -> int:
    return STITCH_HEIGHTS.get(stitch, 3)


def is_single_cluster(body: str) -> bool:
    return body in SINGLE_CLUSTERS


def is_textured(body: str) -> bool:
    return body in TEXTURED


def cluster_spec(body: str) -> tuple[str, int]:
    """Resolve a body into a (base_stitch, count) column.

    Multi clusters return their own (base, count). Single textured tokens
    (puff/bobble/popcorn/picot) are one token -> count 1. A plain stitch is a
    single-stitch column -> count 1.
    """
    if body in MULTI_CLUSTERS:
        return MULTI_CLUSTERS[body]
    if body in SINGLE_CLUSTERS:
        return (body, 1)
    # plain stitch -> single-stitch column
    return (body, 1)


def base_stitch_of(body: str) -> str:
    if body in MULTI_CLUSTERS:
        return MULTI_CLUSTERS[body][0]
    if body in SINGLE_CLUSTERS:
        if body == "picot3":
            return "sc"
        for base in ("trtr", "dtr", "tr", "dc", "hdc", "sc"):
            if body.startswith(base):
                return base
        return "dc"
    return body


# =============================================================================
# CONTEXT
# =============================================================================

@dataclass
class RowCtx:
    round_num:   int
    row_type:    str          # always "cluster" now
    body:        str
    side_gap:    int
    corner_gap:  int
    n_clusters:  int
    prev_cs:     list[str]
    prev_st:     list[str]
    prev_type:   str


# =============================================================================
# helpers
# =============================================================================

def _clamp_side(n: int) -> int:
    """Side gap: at least 2, at most 5."""
    return max(2, min(5, int(n)))


def _clamp_corner(n: int) -> int:
    """Corner gap: at least 3, at most 5."""
    return max(3, min(5, int(n)))


def _st_lbl(r: int, n: int) -> str:
    return f"st_{r}_{n}"


def _cs_lbl(r: int, k: int) -> str:
    return f"cs_{r}_{k}"


def _cl_lbl(r: int, k: int) -> str:
    return f"cl_{r}_{k}"


def _chain_run(n: int, label: Optional[str] = None,
               corner: bool = False) -> str:
    # Caller is responsible for clamping with _clamp_side / _clamp_corner.
    n = max(2, min(5, int(n)))
    s = f"{n}ch"
    if label:
        s = f"{s}.{label}"
    if corner:
        s = f"{s}+!"
    return s


def _setup_chain(ctx: RowCtx, first_st_label: str,
                 anchor: Optional[str]) -> tuple[str, bool]:
    """The row's turning chain, emitted as a SEPARATE height chain with a
    throwaway label: `(height-1)ch,ch.x`.

    It is NOT one of the drawn stitches — the full cluster count is drawn
    after it. Conceptually the turning chain stands in as the row's first
    stitch (standard granny convention), but in this notation the first
    *drawn* stitch carries st_R_1 and is the closer's attach target.

    Complex tokens (bobble/popcorn/puff) keep a plain height chain too; the
    token itself is then drawn as its own column.
    """
    base = base_stitch_of(ctx.body)
    height = min(5, stitch_height(base))           # capped (trtr would be 6)
    if is_single_cluster(ctx.body):
        return f"{height}ch", False
    lead = max(1, height - 1)
    return f"{lead}ch,ch.x", True


def _closer(round_num: int, anchor_label: str) -> str:
    """Slip-stitch into the row's first-stitch anchor, then turn."""
    return f"ss@{anchor_label},turn"


def _cluster_group(body: str, label: str,
                   stitch_labels: list[str],
                   anchor: Optional[str]) -> str:
    at = f"@{anchor}" if anchor else ""
    if is_single_cluster(body):
        # one token that is itself the whole column (puff/bobble/popcorn/picot)
        inner = f"{body}.{stitch_labels[0]}"
    else:
        # multi-stitch column (e.g. 3dc) OR a single plain stitch (count 1).
        # Expand every stitch label using the base stitch.
        base = base_stitch_of(body)
        inner = ",".join(f"{base}.{sl}" for sl in stitch_labels)
    return f"[{inner}].{label}{at}"


# =============================================================================
# 2. ROW BUILDERS
# =============================================================================

def _build_ring() -> str:
    return "ring.R"


def _anchor_pool(ctx: RowCtx) -> list[str]:
    if ctx.round_num == 1:
        return ["R"]
    # Every round ends with `turn`, which flips the work. Walking the previous
    # round's anchors FORWARD would twist the new round over the old one, so we
    # walk them in REVERSE — the new round starts in the previous round's LAST
    # chain-space (e.g. round 2 opens @cs_1_4, not @cs_1_1).
    if ctx.prev_cs:
        return list(reversed(ctx.prev_cs))
    if ctx.prev_st:
        return list(reversed(ctx.prev_st))
    return ["R"]


def build_cluster_row(ctx: RowCtx) -> tuple[str, list[str], list[str]]:
    """Build a COLUMN ROW: `total` columns around the square, separated by
    labelled chain-spaces. Corners get the corner gap (>=3), sides get the
    side gap (>=2)."""
    pool = _anchor_pool(ctx)
    pool_len = len(pool)
    side_gap = _clamp_side(ctx.side_gap)
    corner_gap = _clamp_corner(ctx.corner_gap)

    total = ctx.n_clusters
    # Two columns per corner-pair (doubled corner) start at round 2; the rest
    # of the columns are distributed evenly across the 4 sides.
    n_side_total = max(0, total - 8)
    per_side = n_side_total // 4

    parts: list[str] = []
    st_labels: list[str] = []
    cs_labels: list[str] = []

    first_lbl = _st_lbl(ctx.round_num, 1)
    state = {"n": 0, "cl_k": 0, "cs_k": 0, "pi": 0, "first": True}

    def new_st() -> str:
        state["n"] += 1
        lbl = _st_lbl(ctx.round_num, state["n"])
        st_labels.append(lbl)
        return lbl

    def new_cl() -> str:
        state["cl_k"] += 1
        return _cl_lbl(ctx.round_num, state["cl_k"])

    def next_anchor() -> str:
        a = pool[state["pi"] % pool_len]
        state["pi"] += 1
        return a

    def emit_cluster(anchor: str):
        _base, count = cluster_spec(ctx.body)

        if state["first"]:
            state["first"] = False
            setup, _counted = _setup_chain(ctx, first_lbl, anchor)
            parts.append(setup)
            state["n"] = 0
            clbl = new_cl()
            if is_single_cluster(ctx.body):
                # complex token: height chain + the token (drawn as st_R_1).
                lbl = new_st()
                parts.append(_cluster_group(ctx.body, clbl, [lbl], anchor))
            else:
                # plain stitch / multi cluster: turning chain is separate, the
                # FULL count is drawn. First drawn stitch == st_R_1 (the
                # closer's anchor). e.g. 3dc -> "2ch,ch.x,[dc,dc,dc]".
                labels = [new_st() for _ in range(count)]
                parts.append(_cluster_group(ctx.body, clbl, labels, anchor))
            return

        labels = [new_st() for _ in range(count)]
        clbl = new_cl()
        parts.append(_cluster_group(ctx.body, clbl, labels, anchor))

    def emit_cs(corner: bool):
        state["cs_k"] += 1
        cs = _cs_lbl(ctx.round_num, state["cs_k"])
        cs_labels.append(cs)
        gap = corner_gap if corner else side_gap
        parts.append(_chain_run(gap, cs, corner=corner))

    # CHAIN-SPACE / CORNER MODEL.
    # A corner occupies 2 chain-spaces AND 2 clusters (a doubled corner where
    # both clusters sit in their own chain-space). A side is 1 cs + 1 cluster.
    # clusters == chain-spaces ALWAYS. Total per row = 4*R.
    # There are always 4 corners (8 corner cs/clusters); the rest are sides.
    #   R2: 8  -> CC CC CC CC          (4 corners, 0 sides)
    #   R3: 12 -> s CC s CC s CC s CC  (4 corners, 4 sides; first corner @idx 1)
    #   R4: 16 -> ss CC ss CC ...      (first corner @idx 2)
    # First corner starts at index (R-2); each "quarter" = (sides_per + 2) cs.
    total_cs = 4 * ctx.round_num
    sides_total = total_cs - 8          # 8 cs are corners (4 corners x 2)
    sides_per = max(0, sides_total // 4)
    lead_sides = (ctx.round_num - 1) // 2   # R1,2->0  R3,4->1  R5,6->2 ...

    # Build the per-cs corner mask: lead_sides sides, then 4 times
    # (corner,corner, then sides_per sides), trimmed to total_cs.
    corner_mask: list[bool] = [False] * max(0, lead_sides)
    for _q in range(4):
        corner_mask += [True, True]            # the doubled corner (2 cs)
        corner_mask += [False] * sides_per
    corner_mask = corner_mask[:total_cs]

    if ctx.round_num == 1:
        # Classic granny ring round: 4 columns into the ring, all corners.
        for q in range(4):
            emit_cluster("R")
            emit_cs(corner=True)
    else:
        # Every column type — plain stitches, multi clusters, AND textured
        # single tokens (puff/bobble/popcorn) — uses the SAME corner walk.
        # A corner is two consecutive corner chain-spaces both worked into the
        # SAME anchor (the doubled corner); the two columns are placed
        # consecutively in that corner rather than on separate laps. Side
        # chain-spaces advance the anchor by one. emit_cluster / _setup_chain /
        # _cluster_group already branch on is_single_cluster internally, so the
        # turning-chain and single-token handling stays correct here.
        i = 0
        while i < total_cs:
            if corner_mask[i] and i + 1 < total_cs and corner_mask[i + 1]:
                # Consume the pair of corner cs into one shared anchor (the
                # doubled corner). Only the chain-space BETWEEN the two corner
                # clusters is a true corner gap (the wider corner_gap); the
                # chain-space AFTER the pair leads into the next side and must
                # use the side_gap.
                a = next_anchor()
                emit_cluster(a); emit_cs(corner=True)
                emit_cluster(a); emit_cs(corner=False)
                i += 2
            else:
                emit_cluster(next_anchor()); emit_cs(corner=bool(corner_mask[i]))
                i += 1

    parts.append(_closer(ctx.round_num, first_lbl))
    return ",".join(parts), cs_labels, st_labels


def build_row(ctx: RowCtx) -> tuple[str, list[str], list[str]]:
    # Only column rows exist; anything else funnels here too.
    return build_cluster_row(ctx)


def cluster_count_for_round(round_num: int) -> int:
    return 4 * round_num


# =============================================================================
# 3. SCORING
# =============================================================================

REWARDS = {
    "per_round":              4.0,
    "hit_target_rounds":     30.0,
    "short_penalty_per_missing_round": -4.0,

    "good_gap":               6.0,
    "gap_out_of_range":     -15.0,
    "gap_long_warn":         -3.0,
    "side_corner_distinct":   4.0,
    "corner_min_ok":          4.0,
    "side_min_ok":            4.0,

    "correct_growth":         8.0,
    "wrong_growth":         -12.0,

    "variety_body":          15.0,
    "repeats_immediately":  -20.0,
    "unique_bodies_bonus":    8.0,
    "all_same_body_penalty": -30.0,

    "uses_texture":          12.0,
    "texture_in_middle":      8.0,
}


def score(pattern: str,
          verdict,
          choices: list[dict],
          target_rounds: int,
          difficulty: str) -> float:
    r = 0.0
    agent = [c for c in choices if c.get("body") not in (None, "ring")]
    n_rounds = len(agent)

    r += REWARDS["per_round"] * n_rounds
    if n_rounds >= target_rounds:
        r += REWARDS["hit_target_rounds"]
    else:
        r += REWARDS["short_penalty_per_missing_round"] * (target_rounds - n_rounds)

    bodies = [c["body"] for c in agent]

    for c in agent:
        side = int(c.get("side_gap", 2))
        corner = int(c.get("corner_gap", 3))

        # side gap must be 2..5
        if side < 2 or side > 5:
            r += REWARDS["gap_out_of_range"]
        else:
            r += REWARDS["good_gap"] + REWARDS["side_min_ok"]
            if side == 5:
                r += REWARDS["gap_long_warn"]

        # corner gap must be 3..5
        if corner < 3 or corner > 5:
            r += REWARDS["gap_out_of_range"]
        else:
            r += REWARDS["good_gap"] + REWARDS["corner_min_ok"]
            if corner == 5:
                r += REWARDS["gap_long_warn"]

        if corner > side:
            r += REWARDS["side_corner_distinct"]

    for c in agent:
        rn = int(c.get("round", 0))
        want = cluster_count_for_round(rn)
        got = int(c.get("n_clusters", want))
        r += REWARDS["correct_growth"] if got == want else REWARDS["wrong_growth"]

    for i in range(1, len(bodies)):
        r += REWARDS["variety_body"] if bodies[i] != bodies[i - 1] \
            else REWARDS["repeats_immediately"]
    r += REWARDS["unique_bodies_bonus"] * len(set(bodies))
    if len(set(bodies)) == 1 and len(bodies) > 2:
        r += REWARDS["all_same_body_penalty"]

    if any(b in TEXTURED for b in bodies):
        r += REWARDS["uses_texture"]
    middle = bodies[1:-1] if len(bodies) > 2 else []
    if any(b in TEXTURED for b in middle):
        r += REWARDS["texture_in_middle"]

    return r