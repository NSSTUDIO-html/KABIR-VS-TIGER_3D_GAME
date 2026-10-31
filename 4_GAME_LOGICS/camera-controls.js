/* =====================================================================
   KABIR VS TIGER 3D  -  camera-controls.js

   Adds ONE button  "📷 ORBIT"  under the PAUSE button. Each tap switches
   to the next camera view (smooth fly-in between views):

     ORBIT         your original camera (drag = rotate, pinch/wheel = zoom)
     3RD PERSON    behind your hero, over the shoulder
     1ST PERSON    through your hero's eyes (your own body is hidden)
     DUEL          side-on view that keeps BOTH heroes in frame (auto zoom)
     TOP           bird's-eye view of the whole island

   Keyboard:  V  = next camera view
   Drag still works in every view. In 3RD / 1ST / DUEL the camera slowly
   swings back behind / beside your hero when you let go.
   The chosen view is remembered (localStorage "camera_mode").

   Works in KABIR-VS-AI.html and TIGER-VS-AI.html: it follows the human
   hero (same "player_hero" that weapon-access.js uses).

   ADD (anywhere after the scene script, or right after weapon-access.js):
     <script src="../4_GAME_LOGICS/camera-controls.js"></script>

   Console helper:  CameraControls.setMode("first")   CameraControls.next()
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     SETTINGS   (H = hero height, so it fits any model scale)
     ------------------------------------------------------------------ */
  const CFG = {
    order: ['orbit', 'third', 'first', 'duel', 'top'],   // tap order
    key: 'KeyV',                  // keyboard shortcut
    blendTime: 0.7,               // seconds for the fly-in between views
    idleDelay: 1.2,               // seconds after you stop dragging before auto-recenter
    recenterSpeed: 3,             // how fast it swings back (higher = faster)
    eyeFromTop: 0.1,              // eye level = this fraction of H below the top of the head

    third: { radius: 2.4, beta: 1.2 },                  // radius in hero heights
    first: { fov: 1.2, beta: 1.5, lookRange: 0.9 },     // lookRange = how far you can look up/down (rad)
    duel:  { beta: 1.25, spread: 1.1, pad: 1.2 },       // pad in hero heights
    top:   { radius: 120, beta: 0.05 },

    remember: true,               // remember the last view
    debug: false
  };

  const LABELS = {
    orbit: '📷 ORBIT',
    third: '📷 3RD PERSON',
    first: '📷 1ST PERSON',
    duel:  '📷 DUEL',
    top:   '📷 TOP'
  };

  const V3 = BABYLON.Vector3;

  /* ------------------------------------------------------------------
     State
     ------------------------------------------------------------------ */
  let scene = null, cam = null, canvas = null;
  let me = 'kabir', opp = 'tiger';
  let mode = 'orbit';
  let blend = 1;                 // 0..1 while flying between views, 1 = done
  let snap = null;               // camera values when the switch started
  let orbitSaved = null;         // last ORBIT view (restored when you come back)
  let duelSide = 1;
  let dragging = false, lastDragEnd = 0;
  let hidden = false;
  const orig = {};               // original camera limits / fov
  const meas = {};               // per-hero measurements
  const hiddenMeshes = new Map();
  let btn = null;

  /* ------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------ */
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = t => t * t * (3 - 2 * t);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function log() { if (CFG.debug) console.log.apply(console, ['[camera]'].concat([].slice.call(arguments))); }

  function playerHero() {
    if (window.WeaponAccess && window.WeaponAccess.player) return window.WeaponAccess.player;
    try { return localStorage.getItem('player_hero') === 'tiger' ? 'tiger' : 'kabir'; }
    catch (e) { return 'kabir'; }
  }

  function heroRoot(name) {
    const reg = window.gameHeroes && window.gameHeroes[name];
    return (reg && reg.root) || (scene && scene.getTransformNodeByName(name + 'Root')) || null;
  }

  /* hero height + eye level, measured once while the hero stands still */
  function measure(name) {
    if (meas[name]) return meas[name];
    const root = heroRoot(name);
    if (!root) return { H: 18, eyeDy: 16, baseSY: 10, ok: false };
    let H = 1.8 * root.scaling.y, topDy = H;
    let ok = false;
    try {
      root.computeWorldMatrix(true);
      root.getDescendants(false).forEach(n => n.computeWorldMatrix && n.computeWorldMatrix(true));
      const meshes = root.getChildMeshes(false).filter(m => m.getTotalVertices && m.getTotalVertices() > 0);
      if (meshes.length) {
        const min = new V3(Infinity, Infinity, Infinity);
        const max = new V3(-Infinity, -Infinity, -Infinity);
        meshes.forEach(m => {
          const bb = m.getBoundingInfo().boundingBox;
          min.minimizeInPlace(bb.minimumWorld);
          max.maximizeInPlace(bb.maximumWorld);
        });
        const h = max.y - min.y;
        if (isFinite(h) && h > 0.01) { H = h; topDy = max.y - root.position.y; ok = true; }
      }
    } catch (err) { console.warn('[camera] measure failed:', err); }
    const m = { H: H, eyeDy: topDy - CFG.eyeFromTop * H, baseSY: root.scaling.y || 1, ok: ok };
    meas[name] = m;                  // measured once, reused every frame
    return m;
  }

  function eyePos(name) {
    const root = heroRoot(name);
    const m = measure(name);
    if (!root) return new V3(0, m.eyeDy, 0);
    const crouch = root.scaling.y / m.baseSY;            // follows the HIDE/duck squash
    return new V3(root.position.x, root.position.y + m.eyeDy * crouch, root.position.z);
  }

  function groundPos(name) {
    const root = heroRoot(name);
    return root ? root.position : new V3(0, 0, 0);
  }

  /* camera alpha that puts the camera BEHIND `a` (away from `b`) */
  function behindAlpha(a, b) {
    return Math.atan2(a.z - b.z, a.x - b.x);
  }
  /* camera alpha that looks at the A-B line from the side */
  function sideAlpha(a, b, side) {
    const dx = b.x - a.x, dz = b.z - a.z;
    return Math.atan2(dx, -dz) + (side < 0 ? Math.PI : 0);
  }

  /* first person: camera sits exactly at the eyes, looking where alpha/beta point */
  function fpRadius() { return Math.max(1, measure(me).H * 0.5); }
  function fpTarget(alpha, beta) {
    const r = fpRadius();
    const e = eyePos(me);
    return new V3(
      e.x - r * Math.cos(alpha) * Math.sin(beta),
      e.y - r * Math.cos(beta),
      e.z - r * Math.sin(alpha) * Math.sin(beta)
    );
  }

  /* ------------------------------------------------------------------
     What each view WANTS the camera to be
     ------------------------------------------------------------------ */
  function desired(m) {
    const H = measure(me).H;
    const P = groundPos(me), O = groundPos(opp);

    if (m === 'third') {
      const e = eyePos(me);
      return { alpha: behindAlpha(P, O), beta: CFG.third.beta, radius: CFG.third.radius * H,
               fov: orig.fov, target: new V3(e.x, e.y, e.z) };
    }
    if (m === 'first') {
      const a = behindAlpha(P, O), b = CFG.first.beta;
      return { alpha: a, beta: b, radius: fpRadius(), fov: CFG.first.fov, target: fpTarget(a, b) };
    }
    if (m === 'duel') {
      const dist = Math.hypot(O.x - P.x, O.z - P.z);
      const R = clamp(dist * CFG.duel.spread + H * CFG.duel.pad, H * 2, orig.upperRadius);
      return { alpha: sideAlpha(P, O, duelSide), beta: CFG.duel.beta, radius: R, fov: orig.fov,
               target: new V3((P.x + O.x) / 2, (P.y + O.y) / 2 + H * 0.5, (P.z + O.z) / 2) };
    }
    if (m === 'top') {
      return { alpha: snap ? snap.alpha : cam.alpha, beta: CFG.top.beta, radius: CFG.top.radius,
               fov: orig.fov, target: new V3(0, 0, 0) };
    }
    // orbit
    return { alpha: orbitSaved.alpha, beta: orbitSaved.beta, radius: orbitSaved.radius,
             fov: orig.fov, target: orbitSaved.target.clone() };
  }

  /* ------------------------------------------------------------------
     Limits (what you can do with drag / zoom in each view)
     ------------------------------------------------------------------ */
  function openLimits() {                 // wide open while the camera is flying
    cam.lowerBetaLimit = 0.01;
    cam.upperBetaLimit = Math.PI - 0.01;
    cam.lowerRadiusLimit = 0.01;
    cam.upperRadiusLimit = 1000;
  }

  function applyLimits(m) {
    const H = measure(me).H;
    if (m === 'third') {
      cam.lowerBetaLimit = 0.35;
      cam.upperBetaLimit = Math.PI / 2 - 0.05;
      cam.lowerRadiusLimit = H * 1.2;
      cam.upperRadiusLimit = H * 6;
    } else if (m === 'duel') {
      cam.lowerBetaLimit = 0.5;
      cam.upperBetaLimit = Math.PI / 2 - 0.05;
      cam.lowerRadiusLimit = H * 2;
      cam.upperRadiusLimit = orig.upperRadius;
    } else if (m === 'first') {
      const r = fpRadius();
      cam.lowerBetaLimit = Math.PI / 2 - CFG.first.lookRange;
      cam.upperBetaLimit = Math.PI / 2 + CFG.first.lookRange;
      cam.lowerRadiusLimit = r;
      cam.upperRadiusLimit = r;
    } else {                              // orbit + top = original limits
      cam.lowerBetaLimit = orig.lowerBeta;
      cam.upperBetaLimit = orig.upperBeta;
      cam.lowerRadiusLimit = orig.lowerRadius;
      cam.upperRadiusLimit = orig.upperRadius;
    }
  }

  /* ------------------------------------------------------------------
     Hide your own body in first person
     ------------------------------------------------------------------ */
  function hideBody(on) {
    if (on === hidden) return;
    const reg = window.gameHeroes && window.gameHeroes[me];
    const meshes = (reg && reg.meshes) || [];
    if (on) {
      meshes.forEach(m => {
        if (!hiddenMeshes.has(m)) hiddenMeshes.set(m, m.isVisible);
        m.isVisible = false;
      });
    } else {
      hiddenMeshes.forEach((vis, m) => { m.isVisible = vis; });
      hiddenMeshes.clear();
    }
    hidden = on;
  }

  /* ------------------------------------------------------------------
     Switching views
     ------------------------------------------------------------------ */
  function saveOrbit() {
    orbitSaved = {
      alpha: cam.alpha, beta: cam.beta, radius: cam.radius,
      target: cam.getTarget().clone()
    };
  }

  function setMode(id) {
    if (!cam || CFG.order.indexOf(id) === -1) return;
    if (id === mode && blend >= 1) return;

    if (mode === 'orbit' && blend >= 1) saveOrbit();     // remember where you left the orbit view
    snap = {
      alpha: cam.alpha, beta: cam.beta, radius: cam.radius, fov: cam.fov,
      target: cam.getTarget().clone()
    };

    if (id === 'duel') {                                  // pick the side nearest to where the camera is
      const P = groundPos(me), O = groundPos(opp);
      const d1 = Math.abs(angleDiff(sideAlpha(P, O, 1), snap.alpha));
      const d2 = Math.abs(angleDiff(sideAlpha(P, O, -1), snap.alpha));
      duelSide = d1 <= d2 ? 1 : -1;
    }

    if (id !== 'first') hideBody(false);
    cam.minZ = id === 'first' ? Math.min(orig.minZ, Math.max(0.1, measure(me).H * 0.01)) : orig.minZ;

    mode = id;
    blend = 0;
    openLimits();
    updateButton();
    if (CFG.remember) { try { localStorage.setItem('camera_mode', id); } catch (e) {} }
    window.dispatchEvent(new CustomEvent('cameramode', { detail: { mode: id } }));
    log('mode ->', id);
  }

  function next() {
    const i = CFG.order.indexOf(mode);
    setMode(CFG.order[(i + 1) % CFG.order.length]);
  }

  /* ------------------------------------------------------------------
     Per-frame update
     ------------------------------------------------------------------ */
  function frame() {
    const dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
    try { update(dt); } catch (err) { console.error('camera-controls.js update error:', err); }
  }

  function update(dt) {
    const tgt = cam.getTarget();      // the camera's own target vector (edited in place)

    /* ---- flying between two views ---- */
    if (blend < 1) {
      blend = Math.min(1, blend + dt / CFG.blendTime);
      const t = ease(blend);
      const D = desired(mode);
      cam.alpha = snap.alpha + angleDiff(D.alpha, snap.alpha) * t;
      cam.beta = lerp(snap.beta, D.beta, t);
      cam.radius = lerp(snap.radius, D.radius, t);
      cam.fov = lerp(snap.fov, D.fov, t);
      tgt.copyFromFloats(
        lerp(snap.target.x, D.target.x, t),
        lerp(snap.target.y, D.target.y, t),
        lerp(snap.target.z, D.target.z, t));
      cam.inertialAlphaOffset = cam.inertialBetaOffset = cam.inertialRadiusOffset = 0;

      if (mode === 'first' && blend > 0.6) hideBody(true);
      if (blend >= 1) { applyLimits(mode); snap = null; }
      return;
    }

    if (mode === 'orbit' || mode === 'top') return;       // free camera: you are in control

    const D = desired(mode);

    /* ---- swing back when you stop dragging ---- */
    const idle = !dragging &&
      (performance.now() - lastDragEnd) > CFG.idleDelay * 1000 &&
      Math.abs(cam.inertialAlphaOffset) < 1e-4 && Math.abs(cam.inertialBetaOffset) < 1e-4;
    if (idle) {
      const k = Math.min(1, dt * CFG.recenterSpeed);
      cam.alpha += angleDiff(D.alpha, cam.alpha) * k;
      if (mode === 'first') cam.beta += (D.beta - cam.beta) * k;
    }

    /* ---- follow the heroes ---- */
    if (mode === 'first') {
      const t = fpTarget(cam.alpha, cam.beta);            // exact: no lag at the eyes
      tgt.copyFromFloats(t.x, t.y, t.z);
    } else {
      const k = 1 - Math.exp(-14 * dt);
      tgt.copyFromFloats(
        lerp(tgt.x, D.target.x, k),
        lerp(tgt.y, D.target.y, k),
        lerp(tgt.z, D.target.z, k));
      if (mode === 'duel') cam.radius = lerp(cam.radius, D.radius, 1 - Math.exp(-4 * dt));
    }
  }

  /* ------------------------------------------------------------------
     The button
     ------------------------------------------------------------------ */
  function buildButton() {
    const css = document.createElement('style');
    css.textContent =
      '#camera-btn{position:fixed;z-index:21;top:12px;left:50%;transform:translateX(-50%);' +
      'padding:8px 14px;border:2px solid #ffffff70;border-radius:10px;background:#171d27ee;' +
      'color:#fff;font:900 11px Arial,sans-serif;letter-spacing:.5px;white-space:nowrap;' +
      'cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;' +
      'user-select:none;pointer-events:auto;}' +
      '#camera-btn.on{background:#18b4e8;color:#041018;border-color:#8fe3ff;}' +
      '#camera-btn:active{filter:brightness(1.25);}';
    document.head.appendChild(css);

    btn = document.createElement('button');
    btn.id = 'camera-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Change camera view');
    btn.addEventListener('click', next);
    document.body.appendChild(btn);
    updateButton();
    placeButton();

    window.addEventListener('resize', placeButton);
    window.addEventListener('orientationchange', function () { setTimeout(placeButton, 250); });
    window.addEventListener('gamepause', function () { setTimeout(placeButton, 0); });
    const pb = document.getElementById('pause-btn');
    if (pb && window.ResizeObserver) new ResizeObserver(placeButton).observe(pb);
    setTimeout(placeButton, 300);
    setTimeout(placeButton, 1500);
  }

  /* sits centred directly under the PAUSE button */
  function placeButton() {
    if (!btn) return;
    const pb = document.getElementById('pause-btn');
    if (!pb) return;
    const r = pb.getBoundingClientRect();
    if (!r.width) return;
    btn.style.top = (r.bottom + 6) + 'px';
    btn.style.left = (r.left + r.width / 2) + 'px';
    btn.style.transform = 'translateX(-50%)';
  }

  function updateButton() {
    if (!btn) return;
    btn.textContent = LABELS[mode] || '📷 CAMERA';
    btn.classList.toggle('on', mode !== 'orbit');
    placeButton();
  }

  /* ------------------------------------------------------------------
     Boot: wait for the scene, the orbit camera and both heroes
     ------------------------------------------------------------------ */
  function boot() {
    scene = window.gameScene ||
            (BABYLON.EngineStore && BABYLON.EngineStore.LastCreatedScene) ||
            (BABYLON.Engine && BABYLON.Engine.LastCreatedScene) || null;
    cam = scene && (scene.getCameraByName('orbit') || scene.activeCamera);
    me = playerHero();
    opp = me === 'kabir' ? 'tiger' : 'kabir';

    if (!scene || !cam || !heroRoot('kabir') || !heroRoot('tiger')) { setTimeout(boot, 250); return; }
    if (!(cam instanceof BABYLON.ArcRotateCamera)) {
      console.warn('[camera] camera-controls.js needs the ArcRotateCamera; not started.');
      return;
    }

    canvas = scene.getEngine().getRenderingCanvas();

    orig.lowerBeta = cam.lowerBetaLimit;
    orig.upperBeta = cam.upperBetaLimit;
    orig.lowerRadius = cam.lowerRadiusLimit;
    orig.upperRadius = cam.upperRadiusLimit;
    orig.fov = cam.fov;
    orig.minZ = cam.minZ;
    saveOrbit();
    measure('kabir'); measure('tiger');        // measure while both stand still

    if (canvas) canvas.addEventListener('pointerdown', function () { dragging = true; });
    const endDrag = function () { if (dragging) { dragging = false; lastDragEnd = performance.now(); } };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    window.addEventListener('keydown', function (e) {
      if (e.code !== CFG.key || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      next();
    });

    scene.onBeforeRenderObservable.add(frame);
    buildButton();

    window.CameraControls = {
      setMode: setMode,
      next: next,
      mode: function () { return mode; },
      modes: CFG.order.slice(),
      config: CFG
    };

    let saved = null;
    if (CFG.remember) { try { saved = localStorage.getItem('camera_mode'); } catch (e) {} }
    if (saved && saved !== 'orbit' && CFG.order.indexOf(saved) !== -1) setMode(saved);

    console.log('camera-controls.js ready  (following: ' + me + ', press V or tap the camera button)');
  }

  boot();
})();


