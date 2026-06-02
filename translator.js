// translator.js — converts CrochetPARADE pattern text into a line-by-line
// plain-English description.
//
// Design: small, deterministic, no AST. We scan each non-comment line
// token-by-token and emit a natural sentence. The translator never throws —
// anything it can't decode it passes through as `<unknown:…>` so the user can
// still see something useful next to broken or half-typed lines.
//
// Exposed as: window.translatePattern(text) -> string
//
// The shape of CrochetPARADE syntax (as used by this sandbox):
//
//   #  ............ line comment
//   DEF: name=...   definition of a custom stitch / macro
//   DOT: key=val    layout-engine config (ignored in translation)
//   ch              chain stitch
//   ss              slip stitch
//   sc / hdc / dc   single/half-double/double crochet
//   tr / dtr / trtr treble / double-treble / triple-treble
//   {n}{stitch}     repeat-count prefix (e.g. 6ch = 6 chains)
//   .Ring           close into a ring
//   .Name           label the previous stitch / cluster
//   +1!             increase markers (used by the parser)
//   [a,b,c]*N       repeat the bracketed group N times
//   ,               separator between stitches in a row
//   ss@[%,0]        attach at position — typically "join round to start"
//   $var=expr$      inline state (loop counters etc.)
//   <  >            row-bracket markers
//   sk              skip
//
// We don't try to model every nuance — the goal is "human-readable gloss",
// not "round-trip-faithful parse". A crocheter reading this should be able to
// imagine the row.

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Stitch dictionary — short token → English noun phrase.
  // Singular form on the left; the pluraliser below adds "s" when count > 1.
  // ---------------------------------------------------------------------------
  // Granny-square translation state.
  //
  // The granny generator labels every cluster K{round}_{n} and anchors each
  // new cluster onto a previous-round K-label with @. To render anchors as
  // "in the Nth chain gap of the previous row" we need to know how many
  // clusters the PREVIOUS round had (its max K index). We learn that by
  // pre-scanning each row's source and remembering the max per round.
  //
  // Anchor numbering (per the spec): for an anchor onto K{r}_idx, the gap
  // position N = (max clusters in round r) - idx + 1  — reverse order,
  // because the round walks the previous round's clusters in reverse.
  // ---------------------------------------------------------------------------
  var _gKMaxByRound = {};
  var _gSetupChainByRound = {};

  function _gResetState() { _gKMaxByRound = {}; _gSetupChainByRound = {}; }

  function _gOrdinal(n) {
    var s = ["th", "st", "nd", "rd"];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Pre-scan a row's source to record the max K-index for its round, so the
  // NEXT row's anchors can be numbered against it. Also record the setup-
  // chain length (the leading "Nch,ch.start{r}") so the round's closer can
  // say which chain of the setup it joins into (total = N + 1).
  function _gScanRowKMax(lineSrc) {
    var re = /K(\d+)_(\d+)/g, m;
    while ((m = re.exec(lineSrc)) !== null) {
      var r = parseInt(m[1], 10), n = parseInt(m[2], 10);
      if (_gKMaxByRound[r] === undefined || n > _gKMaxByRound[r]) {
        _gKMaxByRound[r] = n;
      }
    }
    var sm = lineSrc.match(/(\d+)ch\s*,\s*ch\.start(\d+)/);
    if (sm) _gSetupChainByRound[parseInt(sm[2], 10)] = parseInt(sm[1], 10) + 1;
  }

  // ---------------------------------------------------------------------------
  var STITCHES = {
    ch:   "chain",
    ss:   "slip stitch",
    sc:   "single crochet",
    hdc:  "half-double crochet",
    dc:   "double crochet",
    tr:   "treble crochet",
    dtr:  "double-treble crochet",
    trtr: "triple-treble crochet",
    sk:   "skip",
    rsc:  "reverse single crochet",
    scbl: "single crochet through back loop",
    scfl: "single crochet through front loop",
    hdcfl: "half-double crochet through front loop",
    hdcbl: "half-double crochet through back loop",
    dcfl: "double crochet through front loop",
    dcbl: "double crochet through back loop",
    trfl: "treble crochet through front loop",
    trbl: "treble crochet through back loop",
    dtrfl: "double-treble crochet through front loop",
    dtrbl: "double-treble crochet through back loop",
    trtrfl: "triple-treble crochet through front loop",
    trtrbl: "triple-treble crochet through back loop",
    // Common cluster-style stitches that appear in the default pattern
    p:       "picot",
    bobble:  "bobble",
    puff:    "puff stitch",
    popcorn: "popcorn stitch",
  };

  // Cluster-stitch keywords that often appear as suffixes/prefixes (e.g. dc4bobble)
  var CLUSTER_WORDS = ["bobble", "puff", "popcorn"];

  // ---------------------------------------------------------------------------
  // Pluraliser. Most of these phrases pluralise the head noun cleanly with "s"
  // ("chains", "single crochets"). A handful need special treatment.
  // ---------------------------------------------------------------------------
  function pluralise(phrase, n) {
    if (n === 1) return phrase;
    // "slip stitch" -> "slip stitches"
    if (phrase.endsWith("stitch")) return phrase + "es";
    if (phrase.endsWith("crochet")) return phrase + "s";
    if (phrase === "chain") return "chains";
    if (phrase === "skip") return "skips";
    return phrase + "s";
  }

  // ---------------------------------------------------------------------------
  // Capitalise the first letter of a sentence.
  // ---------------------------------------------------------------------------
  function cap(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------------------------------------------------------------------------
  // Token-level translator: given a single chunk (between commas / inside a
  // bracket group), return its English gloss. Returns null if the chunk is
  // empty / pure whitespace.
  // ---------------------------------------------------------------------------
  function translateChunk(chunk) {
    chunk = chunk.trim();
    if (!chunk) return null;

    // ---- DEF: / DOT: lines arrive here whole (no comma-split). Handle them
    // before the suffix-peel, which would treat the @-targets inside as
    // top-level attach syntax. ----
    if (/^DEF:/i.test(chunk)) {
      var defMatch = chunk.match(/^DEF:\s*([^=]+?)\s*=\s*(.*)$/i);
      if (defMatch) {
        return "define a custom stitch '" + defMatch[1].trim() +
          "' (see source for details)";
      }
      return "custom-stitch definition";
    }
    if (/^DOT:/i.test(chunk)) {
      return null; // layout-engine config — omit from translation
    }
    if (chunk.startsWith("#")) return null;

    // ---- Granny-square special tokens --------------------------------------
    // Magic ring: the generator emits `ring.Ring` as the whole round-0 line.
    if (/^ring\.Ring$/i.test(chunk)) return "make a magic loop";

    // `turn` (custom stitch the generator appends to close a round visually).
    if (chunk === "turn") return "turn piece";

    // ---- Inline state: $var=expr$ or $...$ ----
    if (/^\$.*\$$/.test(chunk)) {
      return "(set counter " + chunk.replace(/\$/g, "").trim() + ")";
    }

    // ---- Row bracket markers ----
    if (chunk === "<") return "(row-start marker)";
    if (chunk === ">") return "(row-end marker)";

    // ---- Suffix peel-off pass.
    // A chunk may carry several layered suffixes on its tail, in this order:
    //   1. trailing *N             — repeat
    //   2. trailing @target        — attachment
    //   3. trailing .Label[..]     — group label / ring-creation
    //   4. trailing markers [+!]+  — increase / hidden flags
    // We peel them off the right-hand side until none remain, then recurse on
    // what's left (the "head" — a bracket group or bare token).
    var repeat = null;
    var attach = null;
    var labels = [];         // collected innermost-first
    var markers = "";

    // 1. repeat (only at very tail)
    var repTail = chunk.match(/^(.*)\*\s*(\d+)\s*$/);
    if (repTail && depthsBalancedAt(repTail[1])) {
      repeat = parseInt(repTail[2], 10);
      chunk = repTail[1].trim();
    }

    // 2. attachment: take the LAST @ that sits at depth 0 of `chunk`.
    var atIdx = lastTopLevel(chunk, "@");
    if (atIdx >= 0) {
      attach = chunk.slice(atIdx + 1).trim();
      chunk = chunk.slice(0, atIdx).trim();
    }

    // 3. peel off .Label[...] suffixes repeatedly (e.g. ".Ring1[]@..." had
    //    already lost its @-part above; we may still have ".Ring1[]" sitting
    //    on the tail after a "]"). Allow zero-or-more bracket groups after the
    //    label name to absorb things like `.Tip[t++]` or `.Ring1[]`.
    while (true) {
      // markers first (right-most)
      var mTail = chunk.match(/^(.*?)([+!]+\d*[+!]*)$/);
      if (mTail && !/^\s*$/.test(mTail[1]) && depthsBalancedAt(mTail[1])) {
        markers = mTail[2] + markers;
        chunk = mTail[1].trim();
        continue;
      }
      // dot-label suffix: anything ending in `.NAME` or `.NAME[…]`
      var dotTail = chunk.match(/^(.*?)\.([A-Za-z_][\w]*(?:\[[^\]]*\])*)$/);
      if (dotTail && dotTail[1] && depthsBalancedAt(dotTail[1])) {
        labels.unshift(dotTail[2]);
        chunk = dotTail[1].trim();
        continue;
      }
      break;
    }

    // ---- Now `chunk` is the bare head: either a bracket group or a token ----
    var headGloss = null;
    var headIsGroup = false;

    // Bracket group head
    var grp = chunk.match(/^\[(.+)\]$/);
    if (grp && depthsBalancedAt(grp[1])) {
      var grpParts = splitTopLevel(grp[1], ",")
        .map(translateChunk)
        .filter(Boolean);
      headGloss = "(" + grpParts.join(", then ") + ")";
      headIsGroup = true;
    } else if (chunk === "") {
      headGloss = "attach";
    } else {
      headGloss = translateBareHead(chunk);
    }

    // ---- Reassemble with the peeled suffixes in human-readable order ----
    // If the head is a bracket group AND there is no repeat suffix, prefix it
    // with "as a group:" for readability. With a repeat, the "repeat N times:"
    // wrapper already implies grouping, so we skip the redundant prefix.
    var out;
    if (headIsGroup && repeat === null) {
      out = "as a group: " + headGloss;
    } else {
      out = headGloss;
    }

    labels.forEach(function (label) {
      var cleanLabel = label.replace(/\[\s*\]/g, "").replace(/[\[\]]/g, " ").trim();
      var labelGloss;
      if (/^Ring\d*$/.test(label)) {
        labelGloss = "join into a ring";
        if (label !== "Ring") labelGloss += " (label " + label + ")";
      } else if (/^Ring\d*\[/.test(label)) {
        labelGloss = "join into a ring (label " + label.replace(/\[\s*\]/g, "") + ")";
      } else if (/^chain_space/i.test(label)) {
        labelGloss = "as a chain-space (label " + label + ")";
      } else if (/^[KCS]\d+_\d+$/.test(label)) {
        // Internal generator labels — cluster anchors (K), corner spaces (C),
        // side markers (S). Meaningful to the generator, noise to a
        // crocheter. Hide them; the bare chain count still shows.
        labelGloss = null;
      } else {
        labelGloss = "labelled '" + label + "'";
      }
      if (labelGloss) out += ", " + labelGloss;
    });

    if (attach !== null) {
      out += " " + describeAttachTarget(attach);
    }

    var markerGloss = describeMarker(markers);
    if (markerGloss) out += ", " + markerGloss;

    if (repeat !== null) {
      // If head was a bracket group, `out` already starts with "(…)", so we
      // don't add another set of parens.
      if (headIsGroup && labels.length === 0 && attach === null && !markerGloss) {
        out = "repeat " + repeat + " times: " + out;
      } else {
        out = "repeat " + repeat + " times: (" + out + ")";
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Translate a head once all suffixes have been peeled off.
  // ---------------------------------------------------------------------------
  function translateBareHead(head) {
    head = head.trim();
    if (!head) return "attach";

    // Granny cluster form: N*[stitch]  e.g. 3*[hdc] -> "3 half-double crochets".
    // (CrochetPARADE also writes repeats as [..]*N, handled in translateChunk;
    // this is the count-first cluster the generator emits.)
    var clusterMatch = head.match(/^(\d+)\s*\*\s*\[\s*([a-zA-Z_][\w]*)\s*\]$/);
    if (clusterMatch) {
      var cnt = parseInt(clusterMatch[1], 10);
      var stName = lookupStitch(clusterMatch[2]);
      if (stName) return cnt + " " + pluralise(stName, cnt);
      return cnt + " × " + clusterMatch[2];
    }

    // DEF: name=...
    if (/^DEF:/i.test(head)) {
      var defMatch = head.match(/^DEF:\s*([^=]+?)\s*=\s*(.*)$/i);
      if (defMatch) {
        return "define a custom stitch '" + defMatch[1].trim() +
          "' (see source for details)";
      }
      return "custom-stitch definition";
    }

    // Count + stitch token. CrochetPARADE accepts both `3ch` and `ch3` —
    // numbers can sit on either side of the stitch name.
    var countMatch = head.match(/^(\d+)([a-zA-Z_]+[a-zA-Z_0-9]*)$/);
    if (countMatch) {
      var n = parseInt(countMatch[1], 10);
      var token = countMatch[2];
      var name = lookupStitch(token);
      if (name) return n + " " + pluralise(name, n);
      return n + " × " + token;
    }
    var countMatchRev = head.match(/^([a-zA-Z]+)(\d+)$/);
    if (countMatchRev) {
      var nR = parseInt(countMatchRev[2], 10);
      var tokenR = countMatchRev[1];
      var nameR = lookupStitch(tokenR);
      if (nameR) return nR + " " + pluralise(nameR, nR);
      // If the stitch part isn't recognised, fall through — could still be
      // a user-defined name that ends in digits.
    }

    // Bare stitch token
    var bareMatch = head.match(/^([a-zA-Z_]+[a-zA-Z_0-9]*)$/);
    if (bareMatch) {
      var tok = bareMatch[1];
      var nm = lookupStitch(tok);
      if (nm) return "1 " + nm;
      return "1 custom stitch '" + tok + "'";
    }

    // Parenthesised inner-group: (a,b) — translate as a group
    var paren = head.match(/^\((.+)\)$/);
    if (paren && depthsBalancedAt(paren[1])) {
      var pParts = splitTopLevel(paren[1], ",")
        .map(translateChunk)
        .filter(Boolean);
      return "as a group: (" + pParts.join(", then ") + ")";
    }

    return "<unrecognised: " + head + ">";
  }

  // ---------------------------------------------------------------------------
  // Helpers: balance check + last-index-of at top level.
  // ---------------------------------------------------------------------------
  function depthsBalancedAt(s) {
    var b = 0, p = 0, d = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === "$") d = 1 - d;
      else if (!d) {
        if (c === "[") b++;
        else if (c === "]") b--;
        else if (c === "(") p++;
        else if (c === ")") p--;
      }
      if (b < 0 || p < 0) return false;
    }
    return b === 0 && p === 0 && d === 0;
  }

  function lastTopLevel(s, ch) {
    var b = 0, p = 0, d = 0;
    var last = -1;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === "$") d = 1 - d;
      else if (!d) {
        if (c === "[") b++;
        else if (c === "]") b--;
        else if (c === "(") p++;
        else if (c === ")") p--;
      }
      if (c === ch && b === 0 && p === 0 && !d) last = i;
    }
    return last;
  }

  // ---------------------------------------------------------------------------
  // Look up a stitch token. Tries direct match first, then strips a trailing
  // numeric suffix (e.g. "dc4bobble" → bobble cluster of 4 dc).
  // ---------------------------------------------------------------------------
  function lookupStitch(token) {
    if (STITCHES[token]) return STITCHES[token];

    // Cluster patterns like "dc4bobble", "tr4bobble", "hdc3puff"
    for (var i = 0; i < CLUSTER_WORDS.length; i++) {
      var w = CLUSTER_WORDS[i];
      var re = new RegExp("^([a-z]+)(\\d+)" + w + "(.*)$");
      var m = token.match(re);
      if (m) {
        var stitchPart = STITCHES[m[1]] || m[1];
        var count = parseInt(m[2], 10);
        var rest = m[3] || "";
        var phrase = w + " of " + count + " " + pluralise(stitchPart, count);
        if (rest === "_start_new") phrase += " (start of new yarn)";
        else if (rest) phrase += " (" + rest.replace(/^_/, "").replace(/_/g, " ") + ")";
        return phrase;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Markers like +, !, +1!, etc.
  // ---------------------------------------------------------------------------
  function describeMarker(mark) {
    if (!mark) return "";
    var parts = [];
    if (mark.indexOf("+") !== -1) parts.push("with increase marker");
    if (mark.indexOf("!") !== -1) parts.push("hidden from chart");
    return parts.join(" and ");
  }

  // ---------------------------------------------------------------------------
  // Attach-target description. CrochetPARADE attach targets are dense:
  //
  //   [%,0]      = "at the start of the current row"
  //   [%,-4]     = "4 stitches back in the current row"
  //   [-1,-1]    = "at the last stitch of the previous row"
  //   Ring       = "at the ring"
  //   Ring1[]    = "at the ring labelled Ring1"
  //   Ring1[][0] = "at the first stitch of ring Ring1"
  //   chain_space[0,c++] = "at chain_space slot 0, counter c (then increment)"
  //   [@]        = "at the previous attachment point"
  //
  // We give a best-effort gloss and pass through anything weird.
  // ---------------------------------------------------------------------------
  function describeAttachTarget(t) {
    t = t.trim();
    if (!t) return "(attachment target missing)";

    if (t === "[@]") return "at the previous attachment point";

    // [%,0] — current row, position 0
    var pm = t.match(/^\[\s*%\s*,\s*(-?\d+)\s*\]$/);
    if (pm) {
      var pos = parseInt(pm[1], 10);
      if (pos === 0) return "at the start of the current row";
      if (pos > 0) return "at position " + pos + " of the current row";
      return "at " + (-pos) + " stitches back in the current row";
    }

    // [%, c++] — counter-driven position in current row
    var pmc = t.match(/^\[\s*%\s*,\s*([^\]]+?)\s*\]$/);
    if (pmc) return "at position " + pmc[1] + " of the current row";

    // [-1, -1] — last stitch of previous row
    var nm = t.match(/^\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]$/);
    if (nm) {
      var a = parseInt(nm[1], 10);
      var b = parseInt(nm[2], 10);
      var rowDesc =
        a === -1 ? "previous row" :
        a === 0 ? "current row" :
        a < 0 ? Math.abs(a) + " rows back" :
        "row " + a;
      var posDesc =
        b === -1 ? "last stitch" :
        b === 0 ? "first stitch" :
        b > 0 ? "stitch " + b :
        Math.abs(b) + " stitches back";
      return "at the " + posDesc + " of the " + rowDesc;
    }

    // Round closer: ss@start{r}. Join into the top chain of this round's
    // setup chain (the Nth chain, where N = setup-chain length).
    var startMatch = t.match(/^start(\d+)$/);
    if (startMatch) {
      var sr = parseInt(startMatch[1], 10);
      var len = _gSetupChainByRound[sr];
      if (len !== undefined) {
        return "to close the round in the " + _gOrdinal(len) +
          " chain of the setup chain";
      }
      return "to close the round in the top of the setup chain";
    }

    // Granny cluster anchor: K{round}_{idx}. Render as a chain-gap position
    // in the previous round, numbered in reverse: N = maxK(round) - idx + 1.
    var kMatch = t.match(/^K(\d+)_(\d+)$/);
    if (kMatch) {
      var kr = parseInt(kMatch[1], 10);
      var kidx = parseInt(kMatch[2], 10);
      var maxK = _gKMaxByRound[kr];
      if (maxK !== undefined) {
        var pos = maxK - kidx + 1;
        if (pos < 1) pos = 1;
        return "in the " + _gOrdinal(pos) + " chain gap of the previous row";
      }
      // Fall back if we somehow haven't scanned that round yet.
      return "in a chain gap of the previous row";
    }

    // Ring anchor — clusters worked into the magic loop.
    if (/^Ring\d*$/.test(t)) return "in the magic ring";

    // Ring1[][0] etc.
    var labelMatch = t.match(/^([A-Za-z_][\w]*)(\[.*\])?$/);
    if (labelMatch) {
      var lbl = labelMatch[1];
      var idx = labelMatch[2] || "";
      if (!idx) return "at " + lbl;
      // Strip outer brackets to summarise
      var clean = idx.replace(/\[\s*\]/g, "").replace(/[\[\]]/g, " ").trim();
      if (!clean) return "at " + lbl;
      return "at " + lbl + " (slot " + clean + ")";
    }

    return "at " + t;
  }

  // ---------------------------------------------------------------------------
  // Split a string by `sep` at the top level only (ignoring separators that
  // sit inside [], (), or $$). This is what lets us handle nested groups.
  // ---------------------------------------------------------------------------
  function splitTopLevel(s, sep) {
    var out = [];
    var depthBracket = 0;
    var depthParen = 0;
    var inDollar = false;
    var buf = "";
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === "$") inDollar = !inDollar;
      else if (!inDollar) {
        if (c === "[") depthBracket++;
        else if (c === "]") depthBracket--;
        else if (c === "(") depthParen++;
        else if (c === ")") depthParen--;
      }
      if (c === sep && depthBracket === 0 && depthParen === 0 && !inDollar) {
        out.push(buf);
        buf = "";
      } else {
        buf += c;
      }
    }
    if (buf.length) out.push(buf);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Translate one source line.
  // ---------------------------------------------------------------------------
  function translateLine(line, rowIndex) {
    var trimmed = line.trim();
    if (!trimmed) return { kind: "blank", text: "" };

    // Comments
    if (trimmed.startsWith("#")) {
      return { kind: "comment", text: trimmed.replace(/^#+\s*/, "") };
    }

    // DEF: / DOT: lines (translated as their own thing)
    if (/^(DEF|DOT):/i.test(trimmed)) {
      var sysGloss = translateChunk(trimmed);
      if (sysGloss === null) return { kind: "system", text: "" };
      return { kind: "system", text: cap(sysGloss) };
    }

    // Stitch row. Split on commas at the top level, translate each chunk,
    // then join with "then" between them.
    var chunks = splitTopLevel(trimmed, ",");

    // ---- Granny setup-pair collapse --------------------------------------
    // The generator opens every round with two chunks:  "Nch" then
    // "ch.start{r}". Together they mean: chain N+1, the top chain being the
    // one the closer slip-stitches into. Render them as a single readable
    // instruction and drop the internal label.
    var setupGloss = null;
    if (chunks.length >= 2) {
      var c0 = chunks[0].trim();
      var c1 = chunks[1].trim();
      var m0 = c0.match(/^(\d+)ch$/);
      var m1 = c1.match(/^ch\.st_\d+_1$/);
      if (m0 && m1) {
        var total = parseInt(m0[1], 10) + 1;
        setupGloss = "to start make " + total + " chain stitches (the top " +
          "one will be used to close this round)";
        chunks = chunks.slice(2);
      }
    }

    // ---- Consecutive-chain merge -----------------------------------------
    // Collapse runs of adjacent plain chain chunks ("2ch", "1ch", "3ch.C1_1")
    // into one chunk by summing their counts, so the reader sees "6 chains"
    // instead of "2 chains, then 1 chain, then 3 chains". A label on any
    // chunk in the run is preserved (attached to the merged chunk); if more
    // than one chunk is labelled we keep them all. The setup chain is already
    // removed above, so it is never merged into the body. Anything that isn't
    // a bare/labelled chain (clusters, gaps-with-@, ss, turn) breaks the run.
    var merged = [];
    var i = 0;
    while (i < chunks.length) {
      var ch = chunks[i].trim();
      var cm = ch.match(/^(\d+)ch(?:\.([A-Za-z_][\w]*))?$/);
      if (cm) {
        var sum = parseInt(cm[1], 10);
        var runLabels = cm[2] ? [cm[2]] : [];
        var j = i + 1;
        while (j < chunks.length) {
          var nx = chunks[j].trim().match(/^(\d+)ch(?:\.([A-Za-z_][\w]*))?$/);
          if (!nx) break;
          sum += parseInt(nx[1], 10);
          if (nx[2]) runLabels.push(nx[2]);
          j++;
        }
        // Rebuild a single chain chunk. Keep meaningful labels (the K-labels
        // are hidden downstream anyway); if several survive, chain them on.
        var rebuilt = sum + "ch";
        runLabels.forEach(function (l) { rebuilt += "." + l; });
        merged.push(rebuilt);
        i = j;
      } else {
        merged.push(chunks[i]);
        i++;
      }
    }
    chunks = merged;

    var parts = chunks.map(translateChunk).filter(Boolean);
    if (setupGloss) parts.unshift(setupGloss);
    if (!parts.length) {
      return { kind: "row", text: "(empty row)" };
    }

    var prefix = (rowIndex !== null && rowIndex !== undefined)
      ? "Row " + rowIndex + ": "
      : "";
    return { kind: "row", text: prefix + cap(parts.join(", then ")) + "." };
  }

  // ---------------------------------------------------------------------------
  // Translate a whole pattern.
  //
  // Returns a string with one line per source line, in the same order, so the
  // user can read the translation alongside the source.
  // ---------------------------------------------------------------------------
  function translatePattern(text) {
    if (!text) return "";
    try {
      var lines = text.split(/\r?\n/);
      var out = [];
      var rowCounter = 0;

      // Reset granny state, then pre-scan every line for K-label maxima so
      // anchors in later rows can be numbered against earlier rounds. (A
      // round's own anchors reference the PREVIOUS round, which always
      // appears earlier in the text, so a single forward pre-scan suffices.)
      _gResetState();
      for (var s = 0; s < lines.length; s++) _gScanRowKMax(lines[s]);

      for (var i = 0; i < lines.length; i++) {
        var res;
        try {
          res = translateLine(lines[i], null);
        } catch (lineErr) {
          // Translator hit a line it can't parse. Don't blow up the whole
          // translation — show the offending line raw with a marker so the
          // user can still see what they typed.
          out.push("<error on line " + (i + 1) + ": " + lines[i] + ">");
          continue;
        }
        if (res.kind === "blank") {
          out.push("");
        } else if (res.kind === "comment") {
          out.push("# " + res.text);
        } else if (res.kind === "system") {
          if (res.text) out.push(res.text);
          else out.push(""); // preserve line alignment for DOT: lines we skipped
        } else {
          rowCounter++;
          // Re-translate now that we know the row index, for the row prefix
          var withIdx;
          try {
            withIdx = translateLine(lines[i], rowCounter);
          } catch (e2) {
            withIdx = { text: "<error: " + lines[i] + ">" };
          }
          out.push(withIdx.text);
        }
      }
      return out.join("\n");
    } catch (outerErr) {
      // Last-ditch fallback. Should never fire, but guarantees the editor
      // pipeline is never broken by a translator bug.
      return "(translation unavailable: " + (outerErr && outerErr.message || outerErr) + ")";
    }
  }

  // Expose
  window.translatePattern = translatePattern;
})();