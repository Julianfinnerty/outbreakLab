# OutbreakLab

A GPU (WebGPU) regional, convection-allowing storm model you can set up like an idealized WRF case, with
every volume from any WSR-88D you pick exported as NEXRAD Level II for GR2Analyst, live or as files.

**Run:** double-click `start.bat` (needs Python 3 with numpy), which starts `server.py` on port 8820 and opens
`http://127.0.0.1:8820/` in Chrome or Edge (WebGPU with `float32-filterable`).

## Setup (left panel + map tools)

Settings are saved in the browser as you change them. **Reset everything** (top of the panel) puts every setting
back to the start-up example, stops a run or polling replay in progress and reloads the page (which also frees the
grid's GPU memory). Files already written to `output\` are kept.

1. **Warm-sector sounding**: a sample, a procedural SoundingGen sounding (regime, station, seed), or pasted
   SHARPpy text. This is the air in the open warm sector.
2. **Domain, time and speed**: grid preset, where it sits (the **Move domain** tool), the start time (UTC, used
   for the Level II timestamps), the length, a speed limit, and the microphysics (Lin-type or Thompson-style, see
   *What is simulated*). All grids are 20 km deep.

   | Grid | Domain | Speed, no radars (RTX 50-series) | A supercell lasts about |
   |---|---|---|---|
   | 2 km | 640 km | ~2900× real time | 65 min |
   | 1.5 km | 672 km / 960 km | ~870× / ~520× | 80 min |
   | 1 km | 640 km | ~290× | 95 min |
   | 500 m | 256 km | ~190× | 2 h |
   | 250 m | 128 km | ~70× | longer than it takes to cross the domain (> 100 min) |
   | 100 m | 51 km (room for one storm) | ~22× | crosses the domain in under an hour |

   Lifetimes are for one storm in the 3 May 1999 sounding: the finer the grid, the less the model's own numerical
   smoothing wears storms down. Exporting radars slows a run down (1.5 km with 4 radars: ~150×).

   **Custom grid** (last entry in the Grid list): pick the spacing (100 m – 2 km) and the width × height in km.
   The panel shows the cell count, the GPU memory it needs, the expected speed and the largest domain at that
   spacing. The real limit is WebGPU's 2 GiB per model field: the browser zero-fills each field before the first
   step through a single upload, which can't be bigger than 2 GiB, whatever the GPU memory. That caps a grid at about
   130 M cells (~24.5 GB) at any spacing:

   | Spacing | 250 m | 300 m | 500 m | 750 m | 1 km | 2 km |
   |---|---|---|---|---|---|---|
   | Largest square domain | 286 km | 348 km | 636 km | 1008 km | 1432 km | 3056 km |

   (Or the same area in another shape; at most 2040 cells per side.) Examples on an RTX 5090 (32 GB):

   | Custom grid | Cells | GPU memory | Speed, no radars |
   |---|---|---|---|
   | 500 m × 512 × 512 km | 84 M | 15.8 GB (measured) | 32× (measured) |
   | 1 km × 1024 × 1024 km | 67 M | ~12 GB | ~80× |
   | 250 m × 256 × 256 km | 105 M | ~19 GB | ~13× |

   Wider grids cost more per cell, because the exact pressure solver's sine transforms grow with the width (they
   are ~60 % of a step at 1024 cells wide). Reload the page to free the GPU memory of an earlier grid before
   allocating another big one.
3. **Boundaries**: draw cold fronts, warm fronts, drylines, stationary fronts and outflow boundaries with the `+`
   tools (click points, double-click to finish). Each one has:
   - its motion (speed and heading);
   - the other air mass's temperature difference, depth, slope and moisture deficit;
   - that air mass's surface wind;
   - a storm-initiation rate along it;
   - whether it is kept up (nudged) over time;
   - how unevenly it lifts air (**Along-front variation**, below).

   Use **flip side** if the shading ends up on the wrong side.

   **Along-front variation** (0–1; 0.8 for cold fronts and drylines, 0.7 warm / stationary fronts, 0.6 outflow):
   a boundary lifts air through the depth of its air mass at the leading edge and its wind contrast (the
   convergence). With 0 that lift is the same along its whole length, so wherever the cap is weak or absent it
   fires one continuous fine line of storms at once. Above 0 the lift is concentrated in hot spots about every
   50 km (random spacing and strength, ~14 km wide), which fade and re-form elsewhere over ~1.5 h, and the air mass's
   depth and temperature contrast also vary smoothly along it. Storms then fire from a few spots at a time and can
   grow into discrete supercells before they merge (tested with an uncapped 3150 J/kg, 73 kt case: a solid fine line
   at 0, six separate cells after 30 min at 0.8).

   **Surface low:** where boundaries meet (the default cold front / warm front / dryline triple point) the map shows a
   red **L**. With **Edit boundary**, drag the L to move the low together with its fronts; Shift-drag it to move only
   the point where they meet (the fronts pivot around it); drag any other vertex to reshape a boundary, or a line to
   move one boundary. Dropping a boundary's end on another boundary's vertex joins them. **Move fronts** moves every
   boundary at once. During the run the joined ends move together with the low (by default at the average motion of
   its fronts, or at a speed and heading you set in the Surface low entry), so the fronts stay attached.
4. **Storm initiation**: random storms in the open warm sector and along boundaries (on their warm side) within a
   time window. **Add storm** places one by hand, before or during the run. Storms start at least the edge sponge +
   the push radius + 5 km inside the domain (about 36 km on a 240 km domain), and random starts keep 35 km (25 km
   along boundaries) away from existing storms. Each start is a 0–4 km updraft push (after Naylor & Gilmore 2012)
   that:
   - moves with the storm (Bunkers right-mover motion), so the storm is never left behind by its own push;
   - grows from a third of its radius and 40 % of its speed into a ~12 km dome, with satellite towers that go up at
     different times and merge into it, so the first echoes are small cells (aloft first) that merge;
   - only lifts air that is slower than its target (it never holds back the storm's own updraft), with a target
     that rises smoothly from the ground to 2 km (forcing the full speed from a few hundred metres up pulled in a
     ring of 25–38 m/s surface winds around every new storm), and ends after 25–38 min. Whether the storm lives on
     is up to the sounding.

   Every start is different: the main push's size (±20 %), strength (±10 %), growth time (10–18 min) and motion
   (±15 %, ±11°) are drawn at random, and it gets 0–5 satellites of random size, strength, height and timing,
   scattered over an ellipse of random shape (a round cluster … a line of towers) and orientation; along a
   boundary the towers line up roughly along it. The draws come from the run's random seed, so the same seed
   repeats the same storms.

   Tornadoes (below) can be turned off or scaled.
5. **Radars**: click sites with the **Radars** tool. Choose the VCP (212, 12, 215 or 35), velocity aliasing, and
   an echo floor (gates with weaker model reflectivity are left empty).
6. **Run**: *Start simulation*. The map shows composite / 1-km reflectivity, radial or storm-relative velocity,
   surface θ′, updraft helicity or max w, plus storm starts and tornado tracks.
   - **Radial velocity (0.5°)**: what one radar would see on its lowest scan. Pick the radar in the list next to the
     layer; the run's radars come first, then the nearest others. It shows the model wind along the beam at the
     beam's height (4/3-earth): the lowest level close to the radar, blending up to about 1 km farther out. It is
     only drawn where there is precipitation, as on a real radar, out to 300 km. The units are m/s; green is
     toward the radar and red is away. It is not aliased; the Level II export has its own aliasing setting.
   - **Storm-relative velocity (0.5°)**: the same with the sounding's Bunkers right-mover motion subtracted (shown in
     the legend), so rotation couplets stand out.
   - **Replay bar**: this appears along the bottom of the map once there are two frames. The map fields are saved
     every simulated minute on short runs, or every few minutes on long runs, so the whole run fits in about
     300 MB; grids over 640 cells a side are saved at reduced resolution. If a run outgrows that space, every other
     frame is dropped and the interval doubles.
     - Controls: play/pause (**Space**), step (**←** **→**), first/last frame, drag the slider, and a 2–15 fps rate.
       Playback loops and holds on the last frame.
     - It works while the run carries on: the map stays on the frame you picked until you press **Live**.
     - Every layer (velocity included), the boundaries, the tornado tracks and the storm starts show that frame's
       time.
     - Frames are kept only in the page, so they are gone after a reload or a new run.
     - It is separate from the GR2 *Replay* below, which re-sends a finished run's radar volumes to GR2.

## Hurricane mode

Pick **Hurricane** under *Event type* (top of the panel). The hurricane setup keeps its own domain, grid, time,
radars and boundaries, so switching back to *Severe-weather outbreak* restores that setup as it was.

* **Tropical environment** (replaces the warm-sector sounding): sea-surface temperature (and an optional change per
  degree north), 700–500 hPa humidity, instability, the steering flow (toward / kt) and the 850–200 hPa shear
  (from / kt). A hurricane-season sounding is generated from them: 1012 hPa at sea level, surface air 1 °C cooler than
  the sea at 80 %, a mixed boundary layer, and above it the observed hurricane-season mean temperatures (Jordan 1958),
  shifted by half the SST's departure from 28.5 °C; *Instability* 3 = Jordan's own (≈ 3100 J/kg of surface-based CAPE
  at 29.5 °C), each K more is 1 K colder aloft. The storm is steered by the sounding's winds on an f-plane (no beta
  drift).
* **How it starts** (*Start from*):
  - **A balanced vortex** (default): maximum wind, radius of maximum wind and outer radius, placed with the **Place
    hurricane** tool (the circles show the two radii, the arrow 24 h of steering). It is warm-core, in gradient-wind and
    thermal-wind balance, inertially stable, with winds that barely weaken through the lowest ~4 km; *Moist core*
    starts it nearly saturated inside 2.5× its radius of maximum wind. The default 40 kt start is the cleanest.
  - **A cluster of active convection** (genesis, experimental): new thunderstorms keep firing at random in a patch of
    sea (radius, storms per hour, for how many hours), started as warm, moist bubbles and drifting with the mid-level
    wind, optionally around a weak mid-level vortex (a tropical wave's; 0 kt = convection alone). The cluster follows
    that vortex (its ζ at ~5 km). The map shows a *disturbance* until the model has a closed surface circulation with
    25 kt winds and a 2 hPa low for an hour; then the log reports a tropical depression and tracking starts. Before the
    rework below a test cluster rained for 11 h and slowly built a circulation without forming a depression; it has not
    been re-tested since, so treat it as an experiment.
* **Calm beyond (km)** (default 300): from there (fully by 1.5×) the air is held to the sounding within ~1 h and stray
  cloud dies away — the large-scale sinking that keeps a real hurricane's surroundings mostly clear. Without it, the
  unstable tropical air around the storm grew self-sustaining convective systems on all sides. Raise it for a wider
  field of outer convection.
* **Grids**: *Hurricane · 2 km · 1280 km* (default), *3 km · 1920 km* (fast, coarse eyewall) and *1.5 km · 1440 km*
  (slow); custom grids go up to 4 km. The default runs ~350–400× real time on an RTX 5090 (3 days in ~12 min).
* **Physics added for the sea** (all off in outbreak mode, which runs exactly as before):
  - bulk sea-surface fluxes of heat and moisture (Ck 1.3·10⁻³) and wind-dependent sea drag (Donelan, levelling off at
    2.0·10⁻³: Ck/Cd ≈ 0.8 in hurricane winds), with saturation at the actual surface pressure under the eye, and
    dissipative heating (the friction's heat returned to the lowest layer);
  - a K-profile turbulent boundary layer (lowest 1 km);
  - slow radiative cooling as a relaxation to the sounding (12 h, at most 2 K/day);
  - boundary-layer thermals under a developing storm (coherent ~6 km patches, ~15 min) to set off convection the 2 km
    grid can't start on its own; they fade out as the storm reaches 35–55 kt (otherwise they kept firing in its eye);
  - maritime microphysics: soft graupel (falls 1–9 m/s, not hail-like), rain evaporation at 10 % of Kessler's rate,
    cloud water raining out from 1 g/kg, and falling cloud ice;
  - numerics for strong rotation: full-strength MacCormack advection, midpoint (second-order) trajectories, 40 % of each
    step's pressure force carried along the trajectory, and a weak 4th-order filter on 2-cell noise (below);
  - land (US states from the map data; Mexico and the islands count as sea) gives no heat, only a little moisture
    (*Land moisture*) and more drag (z0 0.3 m), so storms weaken after landfall.
* **Map layers**: *Infrared satellite (simulated)*, *Surface wind* (~10 m, Saffir–Simpson colours) and *Sea-level
  pressure* (isobars every 4 hPa); they work in outbreak mode too. The satellite is the cloud-top brightness
  temperature from the model's cloud, ice and snow (thin cirrus translucent, thick overcast emitting from its top),
  drawn at 3× the model's resolution with bicubic interpolation and a fine cloud-top texture, in SatPainter's colours
  (the Tropical Tidbits GOES Ch13 colorbar, `js/palettes_ir.js`, −90…+40 °C). The map shows the track with a dot every
  6 h in the category colour (labelled every 12 h) and the storm's symbol; the status bar its category, wind,
  pressure, radius of maximum wind and motion; the log category changes and landfalls. Storm-relative velocity
  subtracts the hurricane's motion.
* **What to expect** (tested, 2 km, default setup: 40 kt start, SST 29.5 °C, 70 %, 5 kt shear, 6 kt NNW): a hurricane
  by ~15–18 h, rapid intensification with a clear eye and a 12–20 km eyewall, Category 4 (938 hPa) by 30 h, a
  Category 5 peak (146 kt, 919 hPa) just offshore at ~53 h, and landfall in south-central Louisiana as a Category 4
  (925 hPa). A stationary storm in the same conditions held Category 3–4 (945–961 hPa, 110–127 kt) for two days,
  with eyewall cycles. Keep the track well inside the domain: within ~200 km of the edge a vortex drifts along it,
  and the log warns when that happens.
* **What it took** (found while getting the first storms past Category 1):
  - *the sounding*: a moist adiabat from the warm boundary layer made the free troposphere 5–7 K too warm aloft
    (−2 °C at 500 hPa, −47 °C at 200 hPa), so storms stopped near 12 km under a warm, green "CDO" and topped out at
    Category 1–2. Anchoring it to the observed mean gave deep eyewall convection, a cold CDO and rapid intensification;
  - *rotation damping*: the projection applied the whole pressure force at the end of the step (backward Euler for the
    centripetal force: the speed shrinks by (ΩΔt)²/2 each step, worst in small, intense eyewalls) — a dry, frictionless
    65-kt vortex filled 1.3 hPa/h. Hurricane mode applies 40 % of the previous step's pressure force before advection
    (into its own wind field, ~16 B more per cell), averaging it along the trajectory (off-centred: exactly centred it
    blew up); the dry vortex now holds (+0.2 hPa/h). The weakened MacCormack correction of outbreak mode also held core
    updrafts to 3–6 m/s;
  - *the vortex*: an x·e^(1−x) profile was inertially unstable beyond 2× the radius of maximum wind and tore itself
    apart; storm starts that push updrafts every step fought the pressure scheme (930 hPa lows a few km wide), so
    hurricane-mode storm starts are warm bubbles;
  - *noise*: full-strength MacCormack advection left grid-scale stripes in the rain; a 4th-order hyperdiffusion run
    every 4th step (as WRF / CM1 filter) removes them without weakening the storm.

## GR2Analyst

* **Live:** File → Configure Polling → Add → `http://127.0.0.1:8820/poll/`, move it to the top of the source list
  (above Iowa State, or GR2 takes those radars from there), enable polling, then pick one of the run's radar sites.
  The server lays polling out like the Iowa State server: `grlevel2.cfg` (`Site: KTLX` per line, every WSR-88D, so
  later runs' radars work without re-adding the source), `<site>/dir.list` (`size name` per line) updated as volumes
  arrive, volumes named `KTLX_20240506_200054.bz2`. It serves the run that is sending volumes (after a restart, the
  newest run). Use a speed limit (10–20×) so GR2 keeps up.
* **Replay:** after a run, *Replay* feeds it through the same polling URL at 5–40× as if it were live.
* **Files:** `output\<run>\<ICAO>\<ICAO>YYYYMMDD_HHMMSS_V06` (Archive II, message 31, bzip2 LDM records):
  File → Open.

## What is simulated

* **Model** (`js/model.js`): TrailingHV's storm-scale cloud model in a ground-fixed domain, with its mixing and
  advection settings on every grid.
  - anelastic equations; semi-Lagrangian + MacCormack advection, which allows long time steps;
  - six-class Lin-type ice microphysics (slow, continental warm rain). Rain evaporates at 22 % of the Kessler rate,
    light rain less still (size sorting: it is mostly large drops). Single-moment rain evaporates far too readily:
    at the old 35 % a Dixie-type sounding at 300 m made −8 K cold pools over 700 km² within 50 min, so storms went
    outflow-dominant at once and only extreme SRH gave them a low-level mesocyclone; now a moderate cold pool
    (−2…−4 K over ~300 km², a −6 K core) and a strong cyclonic low-level meso at SRH ≈ 280;
  - or **Thompson-style** microphysics (Domain section → Microphysics), after Thompson et al. (2008). It ports the
    scheme's main ideas, not WRF's whole code (thousands of lines with lookup tables):
    - rain is double-moment: its drop number is predicted too (the spare 4th channel of the snow/graupel field, so
      no extra memory), with an exponential size distribution. The number falls slower than the mass, so drops
      size-sort; autoconversion makes ~80 µm drops, each melted graupel particle becomes one big drop, and
      self-collection / breakup (Seifert & Beheng) settles heavy rain at a median diameter of ~2.2 mm;
    - collection, evaporation and graupel melting use the actual size distributions (Lin et al. 1983 formulas);
      graupel has Thompson's intercept (200 / ρq, 10⁴–3·10⁶ m⁻⁴: more graupel = fewer, bigger particles),
      density 500 kg/m³ and fall speed 442 D^0.89, and most rimed snow stays snow;
    - reflectivity and ZDR come from the predicted drop sizes: ZDR ~2–2.5 dB in heavy rain, low where new small
      drops form near the updraft, and 3–4 dB where sorted big drops reach the forward flank's edge (a ZDR arc,
      broader than in real storms);
    - evaporation runs at 30 % of the physical rate. At 100 % a Dixie-type storm's cold pool reached −8 K over
      ~440 km² in 50 min; at 30 % it is close to the Lin-type scheme (−7 K core, ~280 km² below −2 K) and forms
      later (−1 K at 35 min vs −5 K). Cloud water, cloud ice and snow keep the Lin-type treatment;
  - surface drag: a bulk drag at the lowest level (roughness length 0.1 m, neutral log law) on the wind's departure
    from the environment's, so outflows, inflow jets and low-level vortices feel the ground while the sounding's
    own wind profile stays as given;
  - 2-D horizontal + vertical Smagorinsky mixing;
  - f-plane Coriolis on the departure from the large-scale wind;
  - lateral sponges (8 % of the domain, relaxing to the target at up to 1/100 s and removing cloud and
    precipitation, so storms that drift in die in its inner half) and Rayleigh damping aloft;
  - an exact pressure solve (`js/solver.js`: sine transforms as GEMMs + tridiagonal in z) on the grid padded by
    ~10 km on each side, with the pressure fixed only at the padded edge. Fixing it just outside the last cell (as
    before) let any storm's low or cold-pool high near an edge fall across half a cell, driving 100+ m/s winds
    through the edge and a runaway cold pool.
* **Boundaries**: every column has a target state, the warm-sector sounding plus the anomaly of whichever
  boundary air mass covers it. The target's hydrostatic pressure is part of the pressure, so air masses push on
  each other as density currents. Air masses end ~60 km beyond a boundary's end points, and are nudged back only
  well away from their boundary.
* **Radar** (`js/radar.js`):
  - **Beam geometry:** 4/3-earth beams along great circles from the site, with the real split-cut VCP layouts.
    Each cut is sampled when the model reaches its scan time.
  - **Only what the model holds:** precipitation and its winds. No clear-air returns, fine lines on boundaries,
    noise or texture, so fronts and outflow boundaries only show where they make rain.
  - **Reflectivity:** from rain, snow and graupel/hail, with beam filling over the beam's depth.
  - **Velocity:** the model wind minus the reflectivity-weighted fall speed, with aliasing; spectrum width from
    sub-grid turbulence, shear and fall speeds.
  - **Dual-pol:** ZDR, ρhv and KDP from the hydrometeor mix; ΦDP from integrated KDP.
* **Tornadoes** (sub-grid, 500 m – 2 km grids only): these grids resolve mesocyclones, not tornadoes. On the
  250 m and 100 m grids the scheme is off and the radar shows only the model's own vortices.
  - **Where:** only mature mesocyclones. Each one is tracked from map to map, and a tornado needs the 1-km ζ and
    2–5 km updraft helicity to have been strong for 8 min, the mesocyclone to be at least 15 min old and 10 min
    clear of any storm-start push, a precipitation core (≥ 40 dBZ at 1 km) and storm outflow (θ′ ≤ −1 K) nearby.
    The push itself spins up strong low-level rotation within minutes in high-SRH air, so without these checks
    storms made tornadoes as soon as they formed.
  - **How often and how strong:** spawned at a rate and EF rating scaled by the sounding's STP.
  - **Motion:** each rides with its mesocyclone.
  - **In the radar data** (the one thing not from the model): a beam-smeared vortex (TVS strength drops with
    range like the real thing), high spectrum width, and lofted debris (TDS: high Z, low ρhv) for EF1+.

## Files

`server.py` (HTTP + polling + Level II), `l2writer.py` (Archive II writer, adapted from StormLab's GR2-verified
one), `index.html`, `style.css`, `js/` (`util`, `noise`, `sounding`, `samples`, `soundinggen/`, `mapdata`, `geo`,
`solver`, `model`, `radar`, `hurricane` (hurricane mode: tropical sounding, land / SST map, Saffir–Simpson,
infrared colours, storm tracker), `app`).


## Deploy online for iPhone (Render)

This project includes a `render.yaml` and `requirements.txt` for deployment as a Python web service. Upload the contents of this folder to a GitHub repository, then in Render choose **New → Blueprint** and connect that repository. Review the detected service and select the Free plan if offered. After deployment, open the generated `https://…onrender.com` address in Safari. In Safari, use **Share → Add to Home Screen**.

**Important limitations:** The model itself uses WebGPU on the iPhone browser, so use a small grid first and confirm WebGPU is available. iPhone heat, memory, battery and browser limits may restrict large simulations. Render's free service sleeps after 15 minutes idle, and its local `output/` files are temporary; exported radar volumes may disappear after a restart/sleep/redeploy. This is a hobby/testing deployment, not durable storage. The app is public at its Render URL unless you add access controls.
