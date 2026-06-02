// Crochet Sandbox — entry point.
//
// This file is loaded BEFORE graph64.js so that:
//   1. window.alert is suppressed (parse64.js calls alert() on warnings while
//      the user is still typing).
//   2. window.DIM is set to 2 (forces a 2D layout: 1 = stitch count per row,
//      2 = row index).
//   3. The Module config exists when graph64.js (an emscripten loader) reads
//      it during its own load.
//   4. The sandbox glue at the bottom registers a 'layout-ready' listener
//      that graph64.js will fire once the WASM runtime is initialised.

// ---------------------------------------------------------------------------
// Silence parser warnings during live typing.
// ---------------------------------------------------------------------------
(function () {
  // CrochetPARADE's parser pops up alert() for warnings on half-typed input.
  // We swallow them and log instead.
  window.__cp_warnings = [];
  window.alert = function (msg) {
    window.__cp_warnings.push(String(msg));
    console.warn("[parser]", msg);
  };
  // DIM = 2 forces a 2D layout (1 = stitch count per row, 2 = row index)
  window.DIM = 2;
})();

// ---------------------------------------------------------------------------
// Emscripten module config; must exist before graph64.js loads.
// ---------------------------------------------------------------------------
var Module = {
  locateFile: function (path) {
    return "./" + path;
  },
  onRuntimeInitialized: function () {
    window.__layoutReady = true;
    document.dispatchEvent(new Event("layout-ready"));
  },
};

// Crochet Sandbox — live SVG preview of CrochetPARADE patterns as a real
// crochet chart with standard stitch symbols.
//
// Pipeline:
//   text -> processText() -> graph JSON + DOT
//   DOT  -> performLayout() WASM -> 2D node positions
//   merge into {objects, edges} with edge.start/edge.end attached
//   render via SVG.js using the original CrochetPARADE symbol library.

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Default pattern. Small, fast, valid — from the CrochetPARADE manual.
  // ---------------------------------------------------------------------------
  var DEFAULT_PATTERN = [
    "# Type CrochetPARADE instructions here.",
    "# The preview re-renders ~250 ms after you stop typing.",
    "#",
    "# Each line is a row/round. The chart on the right shows",
    "# standard crochet symbols. Edit anything to see it update.",
    "",
    'DEF: p=3ch,ss@1[%,%-4]',
    '6ch.Ring+1!,ss@[%,0]',
    '[ch,15sc].Ring1[]@Ring,ss@[%,0]',
    'ch,sk,sc,[2sc,<,p]*8,ss@[%,0],sc@Ring1[][0]',
    '$c=0$,@Ring1[][0],[5ch.chain_space[0,c++]+!,sk,>,sc]*8,ss@[-1,-1]',
    '$t=0,c=0$,ch,[sc,hdc,dc,p,tr.Tip[t++],dc,p,hdc,>,sc]@chain_space[0,c++]*8,ss@[%,0]',
    '# This starts a new yarn with chain-3 then 3dc together in base to form a starting dc-4 bobble:',
    'DEF: dc4bobble_start_new= &a dc bobble of 4 stitches^B(hidden);C(ch);D(ch),A(dc):B1~A-B1:E(line);F(line);G(line);H(line);I(line);J(line):!-skip-B;B1-0.001-B;B-0.7-C;C-0.8-D;D-0.7-A;B-0.7-E;E-0.8-F;F-0.7-A;B-0.7-G;G-0.8-H;H-0.7-A;B-0.7-I;I-0.8-J;J-0.7-A',
    '$t=0,c=0$,dc4bobble_start_new@Tip[t],[dc4bobble@Tip[t],<,2ch.chsp[c++]+!,tr4bobble@Tip[t],2ch.chsp[c++]+!,dc4bobble@Tip[t],4ch.chsp[c++]+!,hdc@Tip[++t],4ch.chsp[c++]+!,$t++$]*4,sc@[%,3]',
    '$c=0$,3ch,[3tr@chsp[c++],3ch,3tr@chsp[c++],ch,>,(4dc@chsp[c++],ch)*2]*4,4dc@chsp[c++],ch,3dc@chsp[c++],ss@[%,1]',
    'ch,2sk,5sc,[sc,dc@[@],sc@[@],13sc,>,6sc]*4,ss@[%,0]',
    'DOT: start=1',
    'DOT: viscous_iterations=20'
  ].join("\n");

  // ---------------------------------------------------------------------------
  // Symbol library — copied verbatim from CrochetPARADE / mesh64.js.
  // Each entry is an SVG path string describing one stitch symbol.
  // ---------------------------------------------------------------------------
  var symbolMap = {
    ch: "M-5,0 A5,5 0 1,1 5,0 A5,5 0 1,1 -5,0",
    ss: "M-5,0 A5,10 0 1,1 5,0 A5,10 0 1,1 -5,0 Z",
    sc: "M171.94102,111.30121 H179.71246 M175.82674,117.09468 V105.50773",
    hdc: "M186.2474,99.048099 V80.157868",
    dc: "M172.89806,96.912628 V73.520279 M170.84091,82.837921 L174.95521,85.213321",
    tr: "M102.7556,85.196435 L106.8699,87.571832 M104.81275,102.98371 V70.587124 M102.7556,82.021436 L106.8699,84.396833",
    dtr: "M124.91581,102.3795 V61.773159 M122.85866,75.853306 L126.97296,78.228703 M122.85866,78.499138 L126.97296,80.874535 M122.85866,81.14497 L126.97296,83.520367",
    trtr: "M143.53007,101.48366 V53.386772 M141.47292,70.641918 L145.58722,73.017315 M141.47292,73.28775 L145.58722,75.663147 M141.47292,75.933582 L145.58722,78.308979 M141.47292,78.579417 L145.58722,80.954814",
    rsc: "M131.74584,151.77464 H139.51728 M135.63156,157.56811 V145.98116 M132.48897,145.41015 C133.19121,144.42701 133.70618,144.28657 134.40842,144.28657 C135.11065,144.28657 136.09379,145.45696 136.93648,145.45696 C137.77917,145.45696 138.57503,144.38019 138.57503,144.38019",
    scbl: "M131.74584,151.77464 H139.51728 M135.63156,157.56811 V145.98116 M132.05252,161.34418 A3.5790462,2.8758667 0 0 1 135.63156,158.46831 A3.5790462,2.8758667 0 0 1 139.21061,161.34418",
    scfl: "M131.74584,151.77464 H139.51728 M135.63156,157.56811 V145.98116 M132.05252,158.33667 A3.5790462,2.8758667 0 0 0 135.63156,161.21254 A3.5790462,2.8758667 0 0 0 139.21061,158.33667",
    hdcfl:
      "M64.900616,100.54621 V81.655976 M61.321573,100.71371 A3.5790462,2.8758667 0 0 0 64.90062,103.58957 A3.5790462,2.8758667 0 0 0 68.479666,100.71371",
    dcfl: "M81.887972,99.159791 V75.767442 M79.830822,85.085084 L83.945122,87.460484 M78.308924,99.327293 A3.5790462,2.8758667 0 0 0 81.88797,102.20316 A3.5790462,2.8758667 0 0 0 85.46701,99.327293",
    trfl: "M104.81275,102.98371 V70.587124 M102.7556,82.021436 L106.8699,84.396833 M102.7556,85.196435 L106.8699,87.571832 M101.23371,103.15121 A3.5790462,2.8758667 0 0 0 104.81275,106.02707 A3.5790462,2.8758667 0 0 0 108.39179,103.15121",
    dtrfl:
      "M124.91581,102.3795 V61.773159 M122.85866,75.853306 L126.97296,78.228703 M122.85866,78.499138 L126.97296,80.874535 M122.85866,81.14497 L126.97296,83.520367 M121.33676,102.547 A3.5790462,2.8758667 0 0 0 124.91581,105.42286 A3.5790462,2.8758667 0 0 0 128.49486,102.547",
    trtrfl:
      "M143.53007,101.48366 V53.386772 M141.47292,70.641918 L145.58722,73.017315 M141.47292,73.28775 L145.58722,75.663147 M141.47292,75.933582 L145.58722,78.308979 M141.47292,78.579417 L145.58722,80.954814 M139.95103,101.65115 A3.5790462,2.8758667 0 0 0 143.53008,104.52702 A3.5790462,2.8758667 0 0 0 147.10912,101.65115",
    hdcbl:
      "M64.900616,100.54621 V81.655976 M61.321573,104.16475 A3.5790462,2.8758667 0 0 1 64.90062,101.28889 A3.5790462,2.8758667 0 0 1 68.479666,104.16475",
    dcbl: "M81.887972,99.159791 V75.767442 M79.830822,85.085084 L83.945122,87.460484 M78.308924,102.77833 A3.5790462,2.8758667 0 0 1 81.88797,99.90247 A3.5790462,2.8758667 0 0 1 85.46701,102.77833",
    trbl: "M104.81275,102.98371 V70.587124 M102.7556,82.021436 L106.8699,84.396833 M102.7556,85.196435 L106.8699,87.571832 M101.23371,106.60225 A3.5790462,2.8758667 0 0 1 104.81275,103.72639 A3.5790462,2.8758667 0 0 1 108.39179,106.60225",
    dtrbl:
      "M124.91581,102.3795 V61.773159 M122.85866,75.853306 L126.97296,78.228703 M122.85866,78.499138 L126.97296,80.874535 M122.85866,81.14497 L126.97296,83.520367 M121.33676,105.99804 A3.5790462,2.8758667 0 0 1 124.91581,103.12218 A3.5790462,2.8758667 0 0 1 128.49486,105.99804",
    trtrbl:
      "M143.53007,101.48366 V53.386772 M141.47292,70.641918 L145.58722,73.017315 M141.47292,73.28775 L145.58722,75.663147 M141.47292,75.933582 L145.58722,78.308979 M141.47292,78.579417 L145.58722,80.954814 M139.95103,105.10219 A3.5790462,2.8758667 0 0 1 143.53008,102.22633 A3.5790462,2.8758667 0 0 1 147.10912,105.10219",
    rscfl:
      "M131.74584,151.77464 H139.51728 M135.63156,157.56811 V145.98116 M132.58916,145.41015 C133.2914,144.42701 133.80637,144.28657 134.50861,144.28657 C135.21084,144.28657 136.19398,145.45696 137.03667,145.45696 C137.87936,145.45696 138.67522,144.38019 138.67522,144.38019 M132.05252,158.33667 A3.5790462,2.8758667 0 0 0 135.63156,161.21254 A3.5790462,2.8758667 0 0 0 139.21061,158.33667",
    rscbl:
      "M131.74584,151.77464 H139.51728 M135.63156,157.56811 V145.98116 M132.58916,145.41015 C133.2914,144.42701 133.80637,144.28657 134.50861,144.28657 C135.21084,144.28657 136.19398,145.45696 137.03667,145.45696 C137.87936,145.45696 138.67522,144.38019 138.67522,144.38019 M132.05252,161.34418 A3.5790462,2.8758667 0 0 1 135.63156,158.46831 A3.5790462,2.8758667 0 0 1 139.21061,161.34418",
    fphdc:
      "M37.880373,159.91315 V141.02292 M37.880363,159.78142 A4.7955728,4.7955728 0 0 1 42.310895,162.74181 A4.7955728,4.7955728 0 0 1 41.271345,167.96798 A4.7955728,4.7955728 0 0 1 36.045177,169.00753 A4.7955728,4.7955728 0 0 1 33.084791,164.577",
    fpdc: "M66.781348,166.26735 V142.875 M64.724198,152.19264 L68.838498,154.56804 M66.781342,166.13465 A4.7955728,4.7955728 0 0 1 71.211873,169.09499 A4.7955728,4.7955728 0 0 1 70.172323,174.32116 A4.7955728,4.7955728 0 0 1 64.946155,175.36071 A4.7955728,4.7955728 0 0 1 61.985769,170.93022",
    fptr: "M88.787161,166.55591 V134.15932 M86.730011,145.59363 L90.844311,147.96903 M86.730011,148.76863 L90.844311,151.14403 M88.787148,166.42292 A4.7955728,4.7955728 0 0 1 93.217679,169.38330 A4.7955728,4.7955728 0 0 1 92.178129,174.60947 A4.7955728,4.7955728 0 0 1 86.951961,175.64902 A4.7955728,4.7955728 0 0 1 83.991575,171.21849",
    bphdc:
      "M37.880373,159.91315 V141.02292 M37.880383,159.78142 A4.7955728,4.7955728 0 0 0 33.449851,162.74181 A4.7955728,4.7955728 0 0 0 34.489401,167.96798 A4.7955728,4.7955728 0 0 0 39.715569,169.00753 A4.7955728,4.7955728 0 0 0 42.675955,164.577",
    bpdc: "M66.781348,166.26735 V142.875 M64.724198,152.19264 L68.838498,154.56804 M66.781364,166.13465 A4.7955728,4.7955728 0 0 0 62.350833,169.09504 A4.7955728,4.7955728 0 0 0 63.390383,174.32120 A4.7955728,4.7955728 0 0 0 68.616551,175.36075 A4.7955728,4.7955728 0 0 0 71.576937,170.93022",
    bptr: "M88.787161,166.55591 V134.15932 M86.730011,145.59363 L90.844311,147.96903 M86.730011,148.76863 L90.844311,151.14403 M88.78717,166.42292 A4.7955728,4.7955728 0 0 0 84.356639,169.38330 A4.7955728,4.7955728 0 0 0 85.396189,174.60947 A4.7955728,4.7955728 0 0 0 90.622357,175.64902 A4.7955728,4.7955728 0 0 0 93.582743,171.21849",
    bpsc: "M29.10417,197.88098 H36.87561 M32.98989,203.67445 V192.0875 M32.989899,203.54151 A4.7955728,4.7955728 0 0 0 28.559367,206.50190 A4.7955728,4.7955728 0 0 0 29.598917,211.72806 A4.7955728,4.7955728 0 0 0 34.825085,212.76761 A4.7955728,4.7955728 0 0 0 37.785471,208.33708",
    fpsc: "M29.10417,197.88098 H36.87561 M32.98989,203.67445 V192.0875 M32.98988,203.54151 A4.7955728,4.7955728 0 0 1 37.420411,206.50190 A4.7955728,4.7955728 0 0 1 36.380862,211.72806 A4.7955728,4.7955728 0 0 1 31.154693,212.76761 A4.7955728,4.7955728 0 0 1 28.194307,208.33708",
    line: "M0,-5 L0,5",
    longsc:
      "M-10,33 H10 M0,43.051791 V21.459442 M0,42.746442 A13.596,25.696 0 0 1 13.595998,68.442442 A13.596,25.696 0 0 1 0,94.138442 M-13.595998,30",
    longdc:
      "M-3.389164,26.333015 L12.162136,35.308015 M0,0 C2.475,10.605 7.475,39.235 7.065,60.815 C6.66,82.355 3.53,103.595 0.36,158.375 M-12.162136,20",
    longtr:
      "M-3.389164,26.333015 L12.162136,35.308015 M-3.389164,36.899015 L12.162136,45.874015 M0,0 C2.475,10.605 7.475,54.095 7.065,75.675 C6.66,97.215 3.53,122.455 0.36,177.235 M-12.162136,20",
    hdc3puff:
      "M57.120701,31.14763 C55.060803,33.956587 53.492106,36.543907 53.492106,40.042647 C53.492106,43.599357 54.964508,46.479837 57.024409,48.11287 M57.262236,31.14763 C59.322134,33.956587 60.796733,36.543907 60.796733,40.042647 C60.796733,43.600657 59.322033,46.45643 57.262032,48.98448 M57.196217,31.257148 L57.196217,48.836517",
    hdc4puff:
      "M39.205329,30.997373 C37.972062,33.811537 36.976602,36.403667 37.033097,39.908907 C37.090527,43.472217 37.972061,46.358037 39.205330,48.890787 M39.059053,30.997373 C40.292320,33.811537 41.287780,36.403667 41.231284,39.908907 C41.173854,43.472217 40.290321,46.358037 39.056821,48.890787 M39.11983,31.117972 C36.421815,32.153600 33.285264,36.292047 33.370944,39.955787 C33.454124,43.512507 36.429274,47.570997 39.076499,48.775107 M39.123628,31.117972 C41.821644,32.153600 44.958194,36.292047 44.872514,39.955787 C44.789334,43.512507 41.814184,47.570997 39.167074,48.775107",
    hdc5puff:
      "M19.190388,32.840898 C17.13049,35.649847 15.467793,38.237177 15.562157,41.735917 C15.658087,45.292627 17.130489,48.173097 19.19039,50.701157 M19.110917,32.944915 C15.999325,33.980547 12.381975,38.118987 12.48079,41.782737 C12.57672,45.339447 15.997928,49.397947 19.050944,50.601847 M19.115298,32.944915 C22.22689,33.980547 25.84424,38.118987 25.745425,41.782737 C25.649495,45.339447 22.217287,49.397947 19.164271,50.601847 M19.048853,32.840898 C21.108751,35.649847 22.583452,38.096267 22.583452,41.759327 C22.583452,45.317337 21.108752,48.173097 19.048851,50.701157 M19.124369,32.950416 L19.124369,50.529787",
    dc5bobble:
      " M37.435782,99.271841 C35.375884,102.08079 33.713187,104.66812 33.807551,108.16686 C33.903481,111.72357 35.375883,114.60404 37.435784,117.1321 M37.356311,99.375858 C34.244719,100.41149 30.627369,104.54993 30.726184,108.21368 C30.822114,111.77039 34.253322,115.82889 37.306338,117.03279 M37.360692,99.375858 C40.472284,100.41149 44.089634,104.54993 43.990819,108.21368 C43.894889,111.77039 40.462681,115.82889 37.409665,117.03279 M37.294247,99.271841 C39.354145,102.08079 40.828846,104.52721 40.828846,108.19027 C40.828846,111.74828 39.354146,114.60404 37.294245,117.1321 M37.369763,99.381359 L37.369763,116.96073 M28.564143,108.17104 H46.175382",
    dc4bobble:
      "M49.741665,106.3441 H65.01211 M57.450723,97.428316 C56.217456,100.24248 55.221996,102.83461 55.278491,106.33985 C55.335921,109.90316 56.217455,112.78898 57.450724,115.32173 M57.304447,97.428316 C58.537714,100.24248 59.533174,102.83461 59.476678,106.33985 C59.419248,109.90316 58.535715,112.78898 57.304446,115.32173 M57.365224,97.548915 C54.667209,98.584543 51.530658,102.72299 51.616338,106.38673 C51.699518,109.94345 54.674668,114.00194 57.321893,115.20605 M57.369022,97.548915 C60.067038,98.584543 63.203588,102.72299 63.117908,106.38673 C63.034728,109.94345 59.975578,114.00194 57.323468,115.20605",
    dc3bobble:
      "M70.674659,106.47777 H80.208562 M75.50763,97.578573 C73.447732,100.38753 71.785035,102.97485 71.879399,106.47359 C71.975329,110.0303 73.447731,112.91078 75.507632,115.43881 M75.366095,97.578573 C77.425993,100.38753 78.900694,102.83394 78.900694,106.497 C78.900694,110.05501 77.425994,112.91078 75.366093,115.43881 M75.441611,97.688091 L75.441611,115.26746",
    tr4bobble:
      "M120.76981,152.18047C120.4435,152.92505,120.18012,153.61089,120.19507,154.53831C120.21027,155.48111,120.4435,156.24465,120.76981,156.91477M120.76981,152.18047C121.09611,152.92505,121.35949,153.61089,121.34454,154.53831C121.32934,155.48111,121.09344,156.24465,120.76981,156.91477M120.76981,152.18047C120.05596,152.4545,119.2261,153.54946,119.24877,154.51883C119.27077,155.45988,120.05795,156.53369,120.76981,156.91477M120.76981,152.18047C121.48366,152.4545,122.31354,153.54946,122.29087,154.51883C122.26887,155.45988,121.48168,156.53369,120.76981,156.91477M118.92313,154.15014L119.55729,154.51613M118.92313,154.58103L119.55729,154.94702M121.93807,154.15014L122.57223,154.51613M121.93807,154.58103L122.57223,154.94702M119.88142,154.15014L120.51558,154.51613M119.88142,154.58103L120.51558,154.94702M120.97978,154.15014L121.61394,154.51613M120.97978,154.58103L121.61394,154.94702",
    dc3pc:
      "M58.109607,138.62086 C60.169505,141.42981 60.81661,142.7507 60.81661,146.41376 C60.81661,149.97177 59.34191,152.82753 57.282009,155.35559 M56.583773,138.62086 C54.523875,141.42981 53.87677,142.7507 53.87677,146.41376 C53.87677,149.97177 55.35147,152.82753 57.408374,155.35559 M57.357527,138.69728 L57.357527,155.18422 M54.829525,137.92386 A2.5279996,0.77349651 0 0 1 57.357525,137.15036 A2.5279996,0.77349651 0 0 1 59.885525,137.92386 A2.5279996,0.77349651 0 0 1 57.357525,138.69736 A2.5279996,0.77349651 0 0 1 54.829525,137.92386 M52.590575,146.39453 H62.124478",
    dc4pc:
      "M41.440797,138.61782 C42.392682,140.55473 43.139863,142.76617 43.083367,146.27141 C43.025937,149.83472 42.144404,152.72054 40.911135,155.25329 M40.42111,138.61782 C39.469225,140.55473 38.722044,142.76617 38.77854,146.27141 C38.83597,149.83472 39.717503,152.72054 40.950772,155.25329 M42.568539,138.44048 C44.422407,139.98922 46.781017,142.65455 46.695337,146.31829 C46.612157,149.87501 43.637007,153.9335 40.989783,155.13741 M39.291645,138.44048 C37.437777,139.98922 35.079167,142.65455 35.164847,146.31829 C35.248027,149.87501 38.223177,153.9335 40.870401,155.13741 M33.348354,146.27566 H48.618799 M38.455578,137.86507 A2.5279996,0.77349651 0 0 1 40.983578,137.09157 A2.5279996,0.77349651 0 0 1 43.511578,137.86507 A2.5279996,0.77349651 0 0 1 40.983578,138.63857 A2.5279996,0.77349651 0 0 1 38.455578,137.86507",
    dc5pc:
      "M22.879128,140.19294 C25.527266,142.22169 27.696323,144.48149 27.597508,148.14524 C27.501578,151.70195 24.07037,155.76045 21.017354,156.96435 M19.075978,140.19294 C16.42784,142.22169 14.258783,144.48149 14.357598,148.14524 C14.453528,151.70195 17.884736,155.76045 20.937752,156.96435 M21.728532,140.32893 C23.78843,143.13788 24.435535,144.45877 24.435535,148.12183 C24.435535,151.67984 22.960835,154.5356 20.900934,157.06366 M20.202698,140.32893 C18.1428,143.13788 17.495695,144.45877 17.495695,148.12183 C17.495695,151.67984 18.970395,154.5356 21.028299,157.06366 M20.976452,140.40535 L20.976452,156.89229 M12.170832,148.1026 H29.782071 M18.448452,139.63193 A2.5279996,0.77349651 0 0 1 20.976452,138.85843 A2.5279996,0.77349651 0 0 1 23.504452,139.63193 A2.5279996,0.77349651 0 0 1 20.976452,140.40543 A2.5279996,0.77349651 0 0 1 18.448452,139.63193",
  };

  var hasTopBar = {
    ring: false,
    ch: false,
    ss: false,
    sc: false,
    hdc: true,
    dc: true,
    tr: true,
    dtr: true,
    trtr: true,
    rsc: false,
    scbl: false,
    scfl: false,
    hdcfl: true,
    dcfl: true,
    trfl: true,
    dtrfl: true,
    trtrfl: true,
    hdcbl: true,
    dcbl: true,
    trbl: true,
    dtrbl: true,
    trtrbl: true,
    rscfl: false,
    rscbl: false,
    fphdc: true,
    fpdc: true,
    fptr: true,
    bphdc: true,
    bpdc: true,
    bptr: true,
    bpsc: false,
    fpsc: false,
    line: false,
    longsc: false,
    longdc: true,
    longtr: true,
    hdc3puff: true,
    hdc4puff: true,
    hdc5puff: true,
    dc5bobble: true,
    dc4bobble: true,
    dc3bobble: true,
    tr4bobble: true,
    dc3pc: false,
    dc4pc: false,
    dc5pc: false,
  };

  // All supported symbols are X-centred for rotation; only 'ring' would
  // disable this, but we never need to.
  var recenterInX = {};
  Object.keys(symbolMap).forEach(function (k) {
    recenterInX[k] = true;
  });

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  var $editor = document.getElementById("editor");
  var $canvasHost = document.getElementById("canvas-host");
  var $errBox = document.getElementById("error-box");
  var $statusDot = document.getElementById("status-dot");
  var $statusTxt = document.getElementById("status-text");
  var $nodeCount = document.getElementById("node-count");
  var $charCount = document.getElementById("char-count");
  var $splash = document.getElementById("splash");
  var $download = document.getElementById("download-btn");
  var $translation = document.getElementById("translation");
  var $translationCount = document.getElementById("translation-count");

  $editor.value = DEFAULT_PATTERN;

  // Cross-page handoff: if the trainer page stashed a pattern under
  // `entangled.handoff` before opening the sandbox, swap it in here and
  // clear the slot so a manual reload of the sandbox doesn't keep
  // resurrecting the trainer's pattern.
  try {
    var handoff = sessionStorage.getItem("entangled.handoff");
    if (handoff && handoff.length > 0) {
      $editor.value = handoff;
      sessionStorage.removeItem("entangled.handoff");
    }
  } catch (_) { /* private mode etc. — fine, fall back to DEFAULT_PATTERN */ }

  function setStatus(state, text) {
    $statusDot.className =
      "controls__dot" + (state ? " controls__dot--" + state : "");
    $statusTxt.textContent = text || "";
  }
  function showError(msg) {
    $errBox.textContent = msg;
    $errBox.classList.add("error--visible");
  }
  function clearError() {
    $errBox.classList.remove("error--visible");
  }

  // -------------------------------------------------------------------------
  // Plain-English translation. Rendered into the bottom-left pane on every
  // keystroke (independent of the parse cycle, so the user still sees a
  // gloss when the parser is mid-rejection). Uses light DOM nodes — one
  // <span> per source line — so we can colour comments differently from
  // translated rows.
  // -------------------------------------------------------------------------
  function updateTranslation() {
    if (!$translation || typeof window.translatePattern !== "function") return;
    var text = $editor.value || "";
    var translated = window.translatePattern(text);
    var lines = translated.split("\n");

    // Wipe + rebuild. We're rendering tens of lines at most — no need for
    // anything more clever than innerHTML with the right escaping.
    $translation.textContent = "";

    if (!text.trim()) {
      var ph = document.createElement("span");
      ph.className = "translation__placeholder";
      ph.textContent = "Translation will appear here as you type.";
      $translation.appendChild(ph);
      $translationCount.textContent = "0 rows";
      return;
    }

    var rowCount = 0;
    // Append `text` to `span`, converting any @@I@@…@@/I@@ segments into
    // italic child spans. Used for row headers, which may carry the italic
    // flip note. Plain segments are added as text nodes so nothing is HTML-
    // interpreted.
    function appendWithItalics(span, text) {
      var parts = text.split(/@@I@@|@@\/I@@/);
      // Even indices are plain, odd indices were between the markers (italic).
      parts.forEach(function (seg, segIdx) {
        if (seg === "") return;
        if (segIdx % 2 === 1) {
          var em = document.createElement("span");
          em.className = "translation__note";
          em.textContent = seg;
          span.appendChild(em);
        } else {
          span.appendChild(document.createTextNode(seg));
        }
      });
    }

    lines.forEach(function (line, idx) {
      var span = document.createElement("span");
      var text = line;
      if (line.indexOf("@@ROW@@") === 0) {
        // Bold row header (may contain an italic flip-note segment).
        text = line.slice("@@ROW@@".length);
        span.className = "translation__row";
        rowCount++;
        appendWithItalics(span, text);
        $translation.appendChild(span);
        if (idx < lines.length - 1) {
          $translation.appendChild(document.createTextNode("\n"));
        }
        return;
      } else if (line.indexOf("@@STEP@@") === 0) {
        // Indented bullet step under a row.
        text = "    \u2022 " + line.slice("@@STEP@@".length);
        span.className = "translation__step";
      } else if (line.startsWith("#")) {
        span.className = "translation__comment";
      }
      span.textContent = text;
      $translation.appendChild(span);
      if (idx < lines.length - 1) {
        $translation.appendChild(document.createTextNode("\n"));
      }
    });
    $translationCount.textContent =
      rowCount + " row" + (rowCount === 1 ? "" : "s");
  }

  function whenLayoutReady(cb) {
    if (
      window.__layoutReady &&
      typeof Module !== "undefined" &&
      Module._malloc
    ) {
      cb();
    } else {
      document.addEventListener("layout-ready", cb, { once: true });
    }
  }

  function utf8ByteLength(str) {
    var len = 0;
    for (var i = 0; i < str.length; ++i) {
      var c = str.charCodeAt(i);
      if (c <= 0x7f) len += 1;
      else if (c <= 0x7ff) len += 2;
      else if (c >= 0xd800 && c <= 0xdfff) {
        len += 4;
        ++i;
      } else len += 3;
    }
    return len;
  }

  function performLayout(dotSimple) {
    var inputLength = utf8ByteLength(dotSimple);
    var inputPointer = Module._malloc(inputLength + 1);
    Module.stringToUTF8(dotSimple, inputPointer, inputLength + 1);
    var resultPointer = Module.ccall(
      "performLayout",
      "number",
      ["number"],
      [inputPointer],
    );
    var result = Module.UTF8ToString(resultPointer);
    Module._free(inputPointer);
    var json1 = "[" + result.slice(0, -1) + "]";
    json1 = json1.replace('"},]', '"}]');
    return json1;
  }

  // ---------------------------------------------------------------------------
  // Build the {objects, edges} graph the original mesh64 consumes.
  // Each object has .pos = [x, y, 0]; each edge has .start and .end populated.
  // ---------------------------------------------------------------------------
  function buildGraph(parserJson, layoutJson) {
    var data = JSON.parse(parserJson);
    var pos = JSON.parse('{"elements":' + layoutJson + "}");

    var posByName = Object.create(null);
    pos.elements.forEach(function (e) {
      var parts = String(e.pos).split(",").map(parseFloat);
      if (parts.length >= 2 && isFinite(parts[0]) && isFinite(parts[1])) {
        posByName[e.name] = [parts[0], parts[1], 0];
      }
    });

    var objects = [];
    var indexByName = Object.create(null);
    data.elements.forEach(function (el) {
      if (el.type !== "node") return;
      var i = objects.length;
      indexByName[el.name] = i;
      objects.push({
        _gvid: i,
        name: el.name,
        label: el.label || "",
        pos: posByName[el.name] || null,
      });
    });

    var edges = [];
    data.elements.forEach(function (el) {
      if (el.type !== "edge") return;
      var ti = indexByName[el.tail];
      var hi = indexByName[el.head];
      if (ti == null || hi == null) return;
      var t = objects[ti];
      var h = objects[hi];
      if (!t.pos || !h.pos) return;
      edges.push({
        tail: ti,
        head: hi,
        color: el.color || "gray",
        label: el.label || "",
        start: [t.pos[0], t.pos[1], t.pos[2]],
        end: [h.pos[0], h.pos[1], h.pos[2]],
      });
    });

    return { objects: objects, edges: edges };
  }

  // ---------------------------------------------------------------------------
  // Path helpers — ported from mesh64.js verbatim.
  // ---------------------------------------------------------------------------
  function tightenAndCenterBBox(draw, svgPath, nodeId) {
    var tempPath = draw.path(svgPath);
    var bbox = tempPath.bbox();
    tempPath.remove();

    var centerX = 0.0;
    if (recenterInX[nodeId]) centerX = bbox.x + bbox.width / 2;
    var centerY = bbox.y + bbox.height / 2;

    return svgPath.replace(
      /([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/g,
      function (match, cmd, args) {
        if (cmd === "Z") return cmd;
        var coords = args
          .trim()
          .split(/[\s,]+/)
          .map(parseFloat);
        switch (cmd.toUpperCase()) {
          case "A":
            coords[5] -= centerX;
            coords[6] -= centerY;
            break;
          case "V":
            coords[0] -= centerY;
            break;
          case "H":
            coords[0] -= centerX;
            break;
          default:
            for (var i = 0; i < coords.length; i++) {
              coords[i] -= i % 2 === 0 ? centerX : centerY;
            }
        }
        return cmd + coords.join(",");
      },
    );
  }

  function scalePathData(pathData, scaleX, scaleY) {
    return pathData.replace(
      /([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/g,
      function (match, cmd, args) {
        if (cmd === "Z") return cmd;
        var coords = args
          .trim()
          .split(/[\s,]+/)
          .map(parseFloat);
        switch (cmd.toUpperCase()) {
          case "A":
            coords[0] *= scaleX;
            coords[1] *= scaleY;
            coords[5] *= scaleX;
            coords[6] *= scaleY;
            break;
          case "V":
            coords[0] *= scaleY;
            break;
          case "H":
            coords[0] *= scaleX;
            break;
          default:
            for (var i = 0; i < coords.length; i++) {
              coords[i] *= i % 2 === 0 ? scaleX : scaleY;
            }
        }
        return cmd + coords.join(",");
      },
    );
  }

  // Lengthen the short diagonal tick segments (M start ... L end) that
  // distinguish dc/tr/dtr. Each tick is extended outward from its M start by
  // `factor` (1 = unchanged, 1.5 = 50% longer). Only pure straight M..L
  // subpaths are affected; posts (V), curves (C) and arcs (A) are untouched.
  function lengthenTicks(pathData, factor) {
    if (!factor || factor === 1) return pathData;
    return pathData.replace(
      /M\s*([-\d.eE]+)[,\s]+([-\d.eE]+)\s*L\s*([-\d.eE]+)[,\s]+([-\d.eE]+)/g,
      function (match, mx, my, lx, ly) {
        var sx = parseFloat(mx),
          sy = parseFloat(my),
          ex = parseFloat(lx),
          ey = parseFloat(ly);
        var nx = sx + (ex - sx) * factor;
        var ny = sy + (ey - sy) * factor;
        return "M" + sx + "," + sy + "L" + nx + "," + ny;
      },
    );
  }
  function drawSymbolAlongEdge(
    draw,
    start,
    end,
    symbolPath,
    size,
    isChain,
    nodeId,
    comesFromLine,
    color,
  ) {
    var x1 = (start[0] * size) / 2.0;
    var y1 = (-start[1] * size) / 2.0;
    var x2 = (end[0] * size) / 2.0;
    var y2 = (-end[1] * size) / 2.0;

    var angle = Math.atan2(y2 - y1, x2 - x1);
    var edgeLength = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
    if (edgeLength === 0) return;

    var centeredPath = tightenAndCenterBBox(draw, symbolPath, nodeId);

    var tempPath = draw.path(centeredPath);
    var symbolBBox = tempPath.bbox();
    tempPath.remove();

    var scaleY = (edgeLength * 0.9) / symbolBBox.height;
    var posted = false;
    if (nodeId.startsWith("fp") || nodeId.startsWith("bp")) {
      scaleY *= 1.1 / 0.9;
      posted = true;
      if (["fpsc", "bpsc"].indexOf(nodeId) !== -1) scaleY *= 1.2;
    }
    var scaleX = isChain ? scaleY : 1;
    // Stitches whose identity depends on short diagonal ticks (dc/tr/dtr) or a
    // short horizontal top bar (sc family) keep scaleX=1 in the original,
    // leaving that detail at its native ~5-unit width while the post is
    // stretched tall — so it becomes microscopic. Scale these in X too (a
    // fraction of scaleY) so the detail grows with the post and stays readable.
    var hasTicks =
      /M[^MZ]*L/.test(symbolPath) &&
      !/[ABCSQT]/.test((symbolPath.match(/M[^MZ]*L[^MZ]*/g) || []).join(" "));
    var hasHBar = /[Hh]/.test(symbolPath);
    if ((hasTicks || hasHBar) && !isChain) {
      scaleX = scaleY * 0.7;
    }
    if (
      [
        "hdc3puff",
        "hdc4puff",
        "hdc5puff",
        "dc3bobble",
        "dc4bobble",
        "dc5bobble",
        "tr4bobble",
        "dc3pc",
        "dc4pc",
        "dc5pc",
      ].indexOf(nodeId) !== -1
    ) {
      scaleX = scaleY / 1.6;
    }
    var fill = "none";
    if (nodeId === "ss") {
      fill = color;
      scaleY *= 0.4;
      scaleX = scaleY / 1.333;
    }
    var symbol = draw
      .path(centeredPath)
      .fill(fill)
      .stroke({ color: color, width: 2 })
      .attr("vector-effect", "non-scaling-stroke");
    if (nodeId === "line" || comesFromLine) {
      scaleY /= 0.9;
      scaleX = scaleY;
    }
    if (nodeId === "line" && !comesFromLine) {
      scaleY *= 0.95;
      scaleX *= 0.95;
    }
    var scaledPath = scalePathData(
      lengthenTicks(centeredPath, 1.0),
      scaleX,
      scaleY,
    );
    symbol.plot(scaledPath);

    var centerX, centerY;
    if (nodeId !== "ss" && nodeId !== "line" && !comesFromLine) {
      if (!posted) {
        centerX = x1 + (x2 - x1) * 0.55;
        centerY = y1 + (y2 - y1) * 0.55;
      } else if (["fpsc", "bpsc"].indexOf(nodeId) !== -1) {
        centerX = x1 + (x2 - x1) * (1 - (1.1 * 1.2) / 2);
        centerY = y1 + (y2 - y1) * (1 - (1.1 * 1.2) / 2);
      } else {
        centerX = x1 + (x2 - x1) * 0.45;
        centerY = y1 + (y2 - y1) * 0.45;
      }
    } else if (nodeId === "line" && !comesFromLine) {
      centerX = x1 + (x2 - x1) * (1.0 - 0.95 / 2.0);
      centerY = y1 + (y2 - y1) * (1.0 - 0.95 / 2.0);
    } else {
      centerX = (x1 + x2) / 2;
      centerY = (y1 + y2) / 2;
    }

    // SVG.js v2 transform: translate then rotate around the symbol's own
    // origin (0,0), which after tightenAndCenterBBox is the symbol centre.
    symbol.transform({
      translateX: centerX,
      translateY: centerY,
      rotate: ((angle + Math.PI / 2) * 180) / Math.PI,
      originX: 0,
      originY: 0,
    });
  }

  function drawChainBetweenEdges(
    draw,
    edge1,
    edge2,
    size,
    symbolPath,
    nodeId,
    color,
  ) {
    var avgPoint1, avgPoint2;
    if (edge1 === null) {
      avgPoint1 = edge2.start.map(function (c, i) {
        return c - (edge2.end[i] - edge2.start[i]) / 2;
      });
    } else {
      avgPoint1 = edge1.start.map(function (c, i) {
        return (c + edge1.end[i]) / 2;
      });
    }
    if (edge2 === null) {
      avgPoint2 = edge1.end.map(function (c, i) {
        return c + (edge1.end[i] - edge1.start[i]) / 2;
      });
    } else {
      avgPoint2 = edge2.start.map(function (c, i) {
        return (c + edge2.end[i]) / 2;
      });
    }

    var x1 = (avgPoint1[0] * size) / 2.0,
      y1 = (-avgPoint1[1] * size) / 2.0;
    var x2 = (avgPoint2[0] * size) / 2.0,
      y2 = (-avgPoint2[1] * size) / 2.0;

    var angle = Math.atan2(y2 - y1, x2 - x1);
    var edgeLength = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
    if (edgeLength === 0) return;

    var centeredPath = tightenAndCenterBBox(draw, symbolPath, "ch");
    var tempPath = draw.path(centeredPath);
    var symbolBBox = tempPath.bbox();
    tempPath.remove();

    var scaleY = (edgeLength * 0.93) / symbolBBox.height;
    var scaleX = scaleY / 4;
    if (nodeId === "ring") {
      scaleY *= 0.5;
      scaleX = scaleY;
    }

    var symbol = draw
      .path(centeredPath)
      .fill("none")
      .stroke({ color: color, width: 2 })
      .attr("vector-effect", "non-scaling-stroke");
    var scaledPath = scalePathData(centeredPath, scaleX, scaleY);
    symbol.plot(scaledPath);

    var centerX = (x1 + x2) / 2;
    var centerY = (y1 + y2) / 2;

    symbol.transform({
      translateX: centerX,
      translateY: centerY,
      rotate: ((angle + Math.PI / 2) * 180) / Math.PI,
      originX: "center",
      originY: "center",
    });
  }

  function drawLineBetweenEdges(
    draw,
    edge1,
    edge2,
    size,
    lineColor,
    lineWidth,
  ) {
    var avgPoint1, avgPoint2;
    if (edge1 === null) {
      avgPoint1 = edge2.start.map(function (c, i) {
        return c - (edge2.end[i] - edge2.start[i]) / 2;
      });
    } else {
      avgPoint1 = edge1.start.map(function (c, i) {
        return (c + edge1.end[i]) / 2;
      });
    }
    if (edge2 === null) {
      avgPoint2 = edge1.end.map(function (c, i) {
        return c + (edge1.end[i] - edge1.start[i]) / 2;
      });
    } else {
      avgPoint2 = edge2.start.map(function (c, i) {
        return (c + edge2.end[i]) / 2;
      });
    }

    var x1 = (avgPoint1[0] * size) / 2.0,
      y1 = (-avgPoint1[1] * size) / 2.0;
    var x2 = (avgPoint2[0] * size) / 2.0,
      y2 = (-avgPoint2[1] * size) / 2.0;

    if (lineColor === "#333") {
      // Top-bar: shorten to 80% of original length, centred on midpoint
      var x0 = (x1 + x2) / 2,
        y0 = (y1 + y2) / 2;
      var dx = x2 - x1,
        dy = y2 - y1;
      x1 = x0 - (dx / 2) * 0.8;
      y1 = y0 - (dy / 2) * 0.8;
      x2 = x0 + (dx / 2) * 0.8;
      y2 = y0 + (dy / 2) * 0.8;
    }

    draw
      .line(x1, y1, x2, y2)
      .stroke({ color: lineColor, width: lineWidth })
      .attr("vector-effect", "non-scaling-stroke");
  }

  // ---------------------------------------------------------------------------
  // The main symbol placement loop — adapted from addCrochetSymbolsBetweenNodes.
  // ---------------------------------------------------------------------------
  function drawChart(draw, graph, size) {
    var nodes = graph.objects;
    var edges = graph.edges;

    nodes.forEach(function (node) {
      var nodeId = node.label.split("|")[0];
      if (nodeId === "hidden") return;

      var edge1 =
        edges.find(function (e) {
          return e.head === node._gvid && e.color === "blue";
        }) || null;
      var edge2 =
        edges.find(function (e) {
          return e.tail === node._gvid && e.color === "blue";
        }) || null;

      var color = "#333";

      if (edge1 || edge2) {
        if (nodeId === "ch" || nodeId === "ring") {
          drawChainBetweenEdges(
            draw,
            edge1,
            edge2,
            size,
            symbolMap["ch"],
            nodeId,
            color,
          );
        } else {
          // Faint guide line connecting this stitch into its row.
          drawLineBetweenEdges(draw, edge1, edge2, size, "#aaa", 2);
          if (hasTopBar[nodeId]) {
            drawLineBetweenEdges(draw, edge1, edge2, size, "#333", 2);
          }
        }
      }

      if (nodeId === "ch") return;

      var incomingRedEdges = edges.filter(function (e) {
        return e.head === node._gvid && e.color === "red";
      });

      var clusterTypes = [
        "hdc3puff",
        "hdc4puff",
        "hdc5puff",
        "dc3bobble",
        "dc4bobble",
        "dc5bobble",
        "tr4bobble",
        "dc3pc",
        "dc4pc",
        "dc5pc",
      ];
      var isCluster = clusterTypes.indexOf(nodeId) !== -1;

      if (!isCluster) {
        incomingRedEdges.forEach(function (edge) {
          var incomingNode = nodes.find(function (n) {
            return edge.tail === n._gvid;
          });
          if (!incomingNode) return;
          var comesFromLine = incomingNode.label.split("|")[0] === "line";
          var incomingGvid = incomingNode._gvid;

          if (
            nodeId.endsWith("fl") ||
            nodeId.endsWith("bl") ||
            nodeId.startsWith("fp") ||
            nodeId.startsWith("bp")
          ) {
            var hop = edges.find(function (e) {
              return e.head === incomingGvid;
            });
            if (hop) incomingGvid = hop.tail;
          }

          var symbol = symbolMap[nodeId] || "M0,-2.5 L0,2.5";
          var start, end;

          try {
            var edge1e = edges.find(function (e) {
              return e.head === edge.head;
            });
            var edge2e = edges.find(function (e) {
              return e.tail === edge.head;
            });
            end = edge2e.start.map(function (c, i) {
              return (2 * c + edge1e.start[i] + edge2e.end[i]) / 4;
            });
            try {
              var edge1s = edges.find(function (e) {
                return e.head === incomingGvid;
              });
              var edge2s = edges.find(function (e) {
                return e.tail === incomingGvid;
              });
              start = edge.start;
              if (
                ["red", "blue"].indexOf(edge2s.color) !== -1 &&
                ["red", "blue"].indexOf(edge1s.color) !== -1
              ) {
                start = edge2s.start.map(function (c, i) {
                  return (2 * c + edge1s.start[i] + edge2s.end[i]) / 4;
                });
              }
            } catch (err2) {
              start = edge.start;
            }
            drawSymbolAlongEdge(
              draw,
              start,
              end,
              symbol,
              size,
              false,
              nodeId,
              comesFromLine,
              color,
            );
          } catch (err) {
            drawSymbolAlongEdge(
              draw,
              edge.start,
              edge.end,
              symbol,
              size,
              false,
              nodeId,
              comesFromLine,
              color,
            );
          }
        });
      } else {
        function findRedPathsWithoutBlue(currentTail, visited) {
          visited = visited || new Set();
          if (visited.has(currentTail)) return [];
          visited.add(currentTail);

          var hasBlueIncoming = edges.some(function (e) {
            return e.head === currentTail && e.color === "blue";
          });
          if (hasBlueIncoming) return [currentTail];

          var reds = edges.filter(function (e) {
            return e.head === currentTail && e.color === "red";
          });
          var results = [];
          reds.forEach(function (re) {
            results = results.concat(
              findRedPathsWithoutBlue(re.tail, new Set(visited)),
            );
          });
          if (!results.length) results.push(currentTail);
          return results;
        }

        var pathTails = [];
        incomingRedEdges.forEach(function (re) {
          pathTails = pathTails.concat(findRedPathsWithoutBlue(re.tail));
        });
        if (!pathTails.length) return;

        var smallestTail = Math.min.apply(null, pathTails);
        var edgeWithSmallestTail = edges.find(function (e) {
          return e.tail === smallestTail && e.color === "red";
        });
        if (!edgeWithSmallestTail) return;

        var symbol = symbolMap[nodeId] || "M0,-2.5 L0,2.5";
        try {
          var edge1e2 = edges.find(function (e) {
            return e.head === incomingRedEdges[0].head;
          });
          var edge2e2 = edges.find(function (e) {
            return e.tail === incomingRedEdges[0].head;
          });
          var end2 = edge2e2.start.map(function (c, i) {
            return (2 * c + edge1e2.start[i] + edge2e2.end[i]) / 4;
          });
          var edge1s2 = edges.find(function (e) {
            return e.head === edgeWithSmallestTail.tail;
          });
          var edge2s2 = edges.find(function (e) {
            return e.tail === edgeWithSmallestTail.tail;
          });
          var start2 = edge2s2.start.map(function (c, i) {
            return (2 * c + edge1s2.start[i] + edge2s2.end[i]) / 4;
          });
          drawSymbolAlongEdge(
            draw,
            start2,
            end2,
            symbol,
            size,
            false,
            nodeId,
            false,
            color,
          );
        } catch (err) {
          drawSymbolAlongEdge(
            draw,
            edgeWithSmallestTail.start,
            incomingRedEdges[0].end,
            symbol,
            size,
            false,
            nodeId,
            false,
            color,
          );
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Top-level render
  // ---------------------------------------------------------------------------
  var currentSvg = null;

  function render(graph) {
    $canvasHost.innerHTML = "";
    currentSvg = null;
    if (!graph.objects.length) {
      $nodeCount.textContent = "0 stitches";
      return;
    }

    var visibleNodes = graph.objects.filter(function (o) {
      return o.label.split("|")[0] !== "hidden";
    });
    $nodeCount.textContent = visibleNodes.length + " stitches";

    // Build a fresh SVG.js doc. Use a generous internal coordinate space
    // (size = 1500) so symbol path coordinates land in reasonable ranges.
    var host = document.createElement("div");
    host.style.width = "100%";
    host.style.height = "100%";
    $canvasHost.appendChild(host);

    var size = 1500;
    var draw = SVG().addTo(host).size(size, size);
    currentSvg = draw;

    drawChart(draw, graph, size);

    // Fit viewBox to the actual rendered content, then make the SVG
    // fill its container by clearing width/height.
    var rootNode = draw.node;
    var measureBox = null;
    try {
      measureBox = rootNode.getBBox();
    } catch (e) {
      measureBox = null;
    }

    if (measureBox && measureBox.width > 0 && measureBox.height > 0) {
      var pad = Math.max(measureBox.width, measureBox.height) * 0.05;
      var vbX = measureBox.x - pad;
      var vbY = measureBox.y - pad;
      var vbW = measureBox.width + 2 * pad;
      var vbH = measureBox.height + 2 * pad;
      rootNode.setAttribute("viewBox", vbX + " " + vbY + " " + vbW + " " + vbH);
      rootNode.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }
    rootNode.removeAttribute("width");
    rootNode.removeAttribute("height");
    rootNode.style.width = "100%";
    rootNode.style.height = "100%";
  }

  // ---------------------------------------------------------------------------
  // Compile pipeline
  // ---------------------------------------------------------------------------
  function compile() {
    var text = $editor.value;
    $charCount.textContent = text.length + " chars";

    if (!text.trim()) {
      clearError();
      $canvasHost.innerHTML = "";
      $nodeCount.textContent = "0 stitches";
      setStatus("", "empty");
      return;
    }

    setStatus("busy", "compiling…");

    setTimeout(function () {
      try {
        window.__cp_warnings = [];
        window.DIM = 2;

        var pair = processText(text, "");
        if (!Array.isArray(pair) || pair.length < 2) {
          throw new Error("Parser returned nothing usable. Check syntax.");
        }
        var json0 = pair[0];
        var dotSimple = pair[1];
        if (!json0 || !dotSimple) {
          throw new Error("Parser produced an empty result.");
        }

        var layoutJson = performLayout(dotSimple);
        var graph = buildGraph(json0, layoutJson);
        render(graph);
        clearError();
        setStatus("ok", "compiled");
      } catch (err) {
        var msg = err && err.message ? err.message : String(err);
        showError(msg);
        setStatus("err", "error");
        console.error(err);
      }
    }, 0);
  }

  var debounceTimer = null;
  function scheduleCompile() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(compile, 250);
  }
  $editor.addEventListener("input", function () {
    // Run the cheap translation on every keystroke, even before the parser
    // re-runs — gives instant feedback as the user types.
    updateTranslation();
    scheduleCompile();
  });

  // ---------------------------------------------------------------------------
  // Download SVG
  // ---------------------------------------------------------------------------
  $download.addEventListener("click", function () {
    if (!currentSvg) return;
    var node = currentSvg.node;
    if (!node) return;
    var xml = new XMLSerializer().serializeToString(node);
    if (xml.indexOf("xmlns=") === -1) {
      xml = xml.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    var blob = new Blob([xml], { type: "image/svg+xml" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "crochet-chart.svg";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  whenLayoutReady(function () {
    $splash.classList.add("splash--hidden");
    setTimeout(function () {
      $splash.style.display = "none";
    }, 500);
    updateTranslation();
    compile();
  });
})();