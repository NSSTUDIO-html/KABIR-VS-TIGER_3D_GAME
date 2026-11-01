/* =====================================================================
   KABIR VS TIGER 3D  -  bullets.js

   Puts your bullet GLB models on the bullets that weapons.js fires.
   weapons.js is NOT changed: every time it spawns a bullet, this file
   hides the plain glowing sphere and rides a real bullet model on it
   (same speed, same homing, same damage, same hit effect).

   BULLET FILES  (folder: ../3_ASSETS/WEAPONS/BULLETS/)
     9mm_bullet.glb      -> pistols, dual-pistols
     10mm_bullet.glb     -> dual-rifles, shotgun pellets (smaller)
     sniper_bullet.glb   -> sniper-rifle

   ADD  (in BOTH html files, right AFTER weapons.js):
     <script src="../4_GAME_LOGICS/weapons.js"></script>
     <script src="../4_GAME_LOGICS/bullets.js"></script>

   If a bullet GLB fails to load, that weapon keeps its old glowing bullet,
   so the game never breaks.

   If a bullet flies BACKWARDS (tip at the back), fix it in the console:
       BulletDebug.flip("9mm")        (or "10mm" / "sniper")
   then set  flip: true  for that bullet in BULLETS below to keep it.
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     1) SETTINGS
     ------------------------------------------------------------------ */
  const BULLET_PATH = "../3_ASSETS/WEAPONS/BULLETS/";

  /*  file   : GLB file name inside BULLET_PATH
      length : bullet length as a fraction of hero height (hero ~18 units)
      spin   : spin speed around its own axis, radians per second (0 = none)
      flip   : true = turn it 180 degrees (use if the tip points backwards)
      roll   : degrees, if the model lies sideways                         */
  const BULLETS = {
    "9mm":    { file: "9mm_bullet.glb",    length: 0.09, spin: 30, flip: false, roll: 0 },
    "10mm":   { file: "10mm_bullet.glb",   length: 0.10, spin: 30, flip: false, roll: 0 },
    "sniper": { file: "sniper_bullet.glb", length: 0.18, spin: 12, flip: false, roll: 0 }
  };

  /* which bullet each gun uses (weapon id from weapons.js) */
  const BULLET_FOR = {
    "pistols":      "9mm",
    "dual-pistols": "9mm",
    "dual-rifles":  "10mm",
    "shotgun":      "10mm",
    "sniper-rifle": "sniper"
  };
  const DEFAULT_BULLET = "9mm";        // used for any gun not listed above

  /* size multiplier per weapon (shotgun pellets are smaller) */
  const SIZE_MUL = { "shotgun": 0.7 };

  const AUTO_TIP = true;   // detect which end is the pointed tip and make it face forward
  const GLOW = 0;          // 0 = hide the old glowing sphere, 0.3 = keep a faint glow around the model
  const DEBUG = false;

  /* ------------------------------------------------------------------
     2) Internals
     ------------------------------------------------------------------ */
  const V3 = BABYLON.Vector3;
  const HEROES = ["tiger", "kabir"];

  let scene = null;
  let paused = false;
  let ready = false;
  const tpl = {};                          // bullet id -> { root, flipNode, def }
  const roots = {};                        // hero name -> root node
  const heights = {};                      // hero name -> measured height
  const selected = { tiger: "hand-grips", kabir: "katana" };
  const pending = [];                      // new "bullet" spheres waiting for a model
  const live = [];                         // { sphere, spin, rate }

  function log() { if (DEBUG) console.log.apply(console, ["[bullets]"].concat([].slice.call(arguments))); }

  function getScene() {
    return (BABYLON.EngineStore && BABYLON.EngineStore.LastCreatedScene) ||
           (BABYLON.Engine && BABYLON.Engine.LastCreatedScene) || null;
  }

  /* world bounding box of a node and all its child meshes */
  function worldBounds(node) {
    node.computeWorldMatrix(true);
    node.getDescendants(false).forEach(n => n.computeWorldMatrix && n.computeWorldMatrix(true));
    const meshes = node.getChildMeshes(false).filter(m => m.getTotalVertices && m.getTotalVertices() > 0);
    if (!meshes.length) return null;
    const min = new V3(Infinity, Infinity, Infinity);
    const max = new V3(-Infinity, -Infinity, -Infinity);
    meshes.forEach(m => {
      const bb = m.getBoundingInfo().boundingBox;
      min.minimizeInPlace(bb.minimumWorld);
      max.maximizeInPlace(bb.maximumWorld);
    });
    return { min, max };
  }

  function heroHeight(name) {
    if (heights[name]) return heights[name];
    let H = 0;
    if (window.HeroControls && window.HeroControls.size) {
      const s = window.HeroControls.size(name);
      if (s && s.H > 0) H = s.H;
    }
    if (!H && roots[name]) {
      const b = worldBounds(roots[name]);
      if (b && isFinite(b.max.y - b.min.y) && b.max.y - b.min.y > 0.01) H = b.max.y - b.min.y;
    }
    if (!H) return 18;
    heights[name] = H;
    return H;
  }

  function loadContainer(file) {
    return new Promise(resolve => {
      BABYLON.SceneLoader.LoadAssetContainer(
        BULLET_PATH, file, scene,
        c => resolve(c), null,
        (s, msg, ex) => { console.warn("Bullet GLB failed:", file, msg, ex || ""); resolve(null); }
      );
    });
  }

  /* +1 if the pointed end of the model faces +z, -1 if it faces -z.
     (the pointed end is the end whose cross-section is smaller)         */
  function tipDirection(root) {
    const pts = [];
    root.computeWorldMatrix(true);
    root.getDescendants(false).forEach(n => n.computeWorldMatrix && n.computeWorldMatrix(true));
    root.getChildMeshes(false).forEach(m => {
      if (!m.getTotalVertices || m.getTotalVertices() < 1) return;
      const pos = m.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      if (!pos) return;
      const wm = m.getWorldMatrix();
      const n = pos.length / 3;
      const stepN = Math.max(1, Math.floor(n / 4000));
      for (let i = 0; i < n; i += stepN) {
        pts.push(V3.TransformCoordinates(new V3(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]), wm));
      }
    });
    if (pts.length < 20) return 1;

    let zmin = Infinity, zmax = -Infinity;
    pts.forEach(p => { if (p.z < zmin) zmin = p.z; if (p.z > zmax) zmax = p.z; });
    const len = zmax - zmin;
    if (!(len > 0)) return 1;

    let rLow = 0, nLow = 0, rHigh = 0, nHigh = 0;
    pts.forEach(p => {
      const r = Math.hypot(p.x, p.y), k = (p.z - zmin) / len;
      if (k < 0.2) { rLow += r; nLow++; } else if (k > 0.8) { rHigh += r; nHigh++; }
    });
    if (!nLow || !nHigh) return 1;
    rLow /= nLow; rHigh /= nHigh;
    if (Math.abs(rLow - rHigh) < 0.08 * Math.max(rLow, rHigh)) return 1;   // looks symmetric: leave it
    return rHigh < rLow ? 1 : -1;
  }

  /* ------------------------------------------------------------------
     3) Build one bullet template (length = 1 unit, pointing +z)
     ------------------------------------------------------------------ */
  async function buildTemplate(id, def) {
    const container = await loadContainer(def.file);
    if (!container) return null;

    const root = new BABYLON.TransformNode("bulletTpl_" + id, scene);
    const flipNode = new BABYLON.TransformNode("bulletTplFlip_" + id, scene);
    const wrap = new BABYLON.TransformNode("bulletTplWrap_" + id, scene);
    flipNode.parent = root;
    wrap.parent = flipNode;

    const inst = container.instantiateModelsToScene(n => "bulletTpl_" + id + "_" + n, false);
    inst.animationGroups.forEach(g => g.stop());
    inst.rootNodes.forEach(r => { r.parent = wrap; });
    wrap.getChildMeshes(false).forEach(m => { m.isPickable = false; });

    const b = worldBounds(wrap);
    if (!b) { root.dispose(); console.warn("Bullet GLB has no mesh:", def.file); return null; }

    // longest side becomes the bullet's length (+z)
    const e = b.max.subtract(b.min);
    const center = b.min.add(b.max).scale(0.5);
    let L = e.z, rx = 0, ry = 0;
    if (e.z >= e.x && e.z >= e.y) { L = e.z; }
    else if (e.x >= e.y)          { L = e.x; ry = -Math.PI / 2; }
    else                          { L = e.y; rx = Math.PI / 2; }

    inst.rootNodes.forEach(r => { r.position = center.negate(); });
    wrap.rotation.set(rx, ry, 0);
    wrap.scaling.setAll(L > 0 ? 1 / L : 1);

    let flip = false;
    if (AUTO_TIP) {
      flip = tipDirection(root) < 0;
      log(id, "pointed end faces", flip ? "-z (flipped)" : "+z");
    }
    if (def.flip) flip = !flip;
    flipNode.rotation.y = flip ? Math.PI : 0;
    flipNode.rotation.z = (def.roll || 0) * Math.PI / 180;

    root.setEnabled(false);               // template stays hidden; clones are shown
    console.log("Bullet model ready:", id, "(" + def.file + ")");
    return { root, flipNode, def };
  }

  /* ------------------------------------------------------------------
     4) Put a model on a bullet that weapons.js just created
     ------------------------------------------------------------------ */
  function ownerOf(mesh) {
    let best = null, bd = Infinity;
    HEROES.forEach(n => {
      const r = roots[n];
      if (!r) return;
      const dx = r.position.x - mesh.position.x;
      const dz = r.position.z - mesh.position.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = n; }
    });
    return best;
  }

  function showFallback(sphere) { sphere.isVisible = true; sphere.visibility = 1; }

  function attach(sphere) {
    const owner = ownerOf(sphere);
    const weapon = owner ? selected[owner] : null;
    const id = BULLET_FOR[weapon] || DEFAULT_BULLET;
    const t = tpl[id];
    if (!owner || !t) { showFallback(sphere); return; }       // GLB missing: keep the glowing bullet

    const L = t.def.length * heroHeight(owner) * (SIZE_MUL[weapon] || 1);
    const sx = sphere.scaling.x || 1, sy = sphere.scaling.y || 1, sz = sphere.scaling.z || 1;

    // weapons.js squashes the sphere (x, y, z*4); cancel that so the model keeps its true shape
    const comp = new BABYLON.TransformNode("bulletModelComp", scene);
    comp.parent = sphere;
    comp.scaling.set(L / sx, L / sy, L / sz);

    const spin = new BABYLON.TransformNode("bulletModelSpin", scene);
    spin.parent = comp;

    const model = t.root.clone("bulletModel", spin);
    if (!model) { comp.dispose(); showFallback(sphere); return; }
    model.setEnabled(true);
    model.getChildMeshes(false).forEach(m => { m.setEnabled(true); m.isPickable = false; });

    if (GLOW > 0) { sphere.isVisible = true; sphere.visibility = GLOW; }
    else sphere.isVisible = false;

    if (t.def.spin) live.push({ sphere, spin, rate: t.def.spin });
    log("model on bullet:", owner, weapon, "->", id);
  }

  /* ------------------------------------------------------------------
     5) Per-frame
     ------------------------------------------------------------------ */
  function frame() {
    const dt = paused ? 0 : Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);

    while (pending.length) {
      const m = pending.shift();
      if (m.isDisposed()) continue;
      try { attach(m); }
      catch (err) { console.warn("bullets.js attach error:", err); showFallback(m); }
    }

    for (let i = live.length - 1; i >= 0; i--) {
      const b = live[i];
      if (b.sphere.isDisposed()) { live.splice(i, 1); continue; }
      b.spin.rotation.z += b.rate * dt;
    }
  }

  /* ------------------------------------------------------------------
     6) Boot
     ------------------------------------------------------------------ */
  function init() {
    if (typeof selectedWeapons !== "undefined" && selectedWeapons) {
      HEROES.forEach(n => { if (selectedWeapons[n]) selected[n] = selectedWeapons[n]; });
    }
    window.addEventListener("weaponselect", e => {
      if (e.detail && e.detail.hero) selected[e.detail.hero] = e.detail.weapon;
    });
    window.addEventListener("gamepause", e => { paused = !!(e.detail && e.detail.paused); });

    // catch every bullet sphere the moment weapons.js creates it
    scene.onNewMeshAddedObservable.add(m => {
      if (m.name === "bullet") { m.isVisible = false; pending.push(m); }
    });
    scene.onBeforeRenderObservable.add(frame);

    const ids = Object.keys(BULLETS);
    Promise.all(ids.map(id => buildTemplate(id, BULLETS[id]).then(t => { tpl[id] = t; })))
      .then(() => { ready = true; console.log("bullets.js ready:", ids.filter(i => tpl[i]).join(", ") || "no models (using glowing bullets)"); });

    window.BulletModels = { bullets: BULLETS, bulletFor: BULLET_FOR, selected: selected, _tipDirection: tipDirection };
    window.BulletDebug = {
      flip: function (id) {
        const t = tpl[id];
        if (!t) { console.warn("No bullet model:", id); return; }
        t.flipNode.rotation.y += Math.PI;
        console.log(id, "flipped - fire again to see it");
      },
      roll: function (id, deg) {
        const t = tpl[id];
        if (t) t.flipNode.rotation.z = deg * Math.PI / 180;
      },
      info: function () {
        return Object.keys(BULLETS).map(i => i + ": " + (tpl[i] ? "loaded" : "NOT loaded"));
      }
    };
  }

  function boot() {
    scene = getScene();
    const k = scene && scene.getTransformNodeByName("kabirRoot");
    const t = scene && scene.getTransformNodeByName("tigerRoot");
    if (!k || !t) { setTimeout(boot, 250); return; }
    roots.kabir = k; roots.tiger = t;
    init();
  }

  boot();
})();


