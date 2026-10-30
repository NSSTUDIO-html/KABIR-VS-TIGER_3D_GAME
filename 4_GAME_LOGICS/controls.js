/* =====================================================================
   KABIR VS TIGER 3D  -  controls.js   (all 12 non-shoot buttons)

   Per hero (Tiger + Kabir):
     UP    = move FORWARD  (toward the opponent)
     DOWN  = move BACKWARD (away from the opponent)
     LEFT  = step to the hero's left
     RIGHT = step to the hero's right
     JUMP  = jump
     HIDE  = duck down while the button is held

   Heroes always face each other, follow the island terrain, stay inside
   the arena and cannot walk through each other.

   ADD:  <script src="../4_GAME_LOGICS/controls.js"></script>
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     SETTINGS  (H = hero height, so it works for any model scale)
     ------------------------------------------------------------------ */
  const CFG = {
    speed: 0.6,          // walk speed, hero-heights per second
    hideSpeedMul: 0.45,  // walk speed multiplier while hiding
    jumpHeight: 0.35,    // fraction of H
    jumpTime: 0.8,       // seconds in the air
    hideScale: 0.6,      // body height while hiding (1 = normal)
    arenaRadius: 46,     // stay inside this radius from island centre
    turnSpeed: 12,       // how fast heroes turn to face the opponent

    // if a hero's model does not LOOK at the opponent, add degrees here
    faceFixDeg: { tiger: 0, kabir: 0 },

    // "hero"   : LEFT/RIGHT are the hero's own left/right
    // "screen" : LEFT/RIGHT follow what you see on screen (camera left/right)
    sideMode: "hero",

    knockFriction: 5,    // how fast knockback slides to a stop (higher = shorter slide)

    // set true to print every button press in the browser console (F12)
    debug: false
  };

  const V3 = BABYLON.Vector3;
  const HEROES = ["tiger", "kabir"];
  const OPP = { tiger: "kabir", kabir: "tiger" };

  let scene = null;
  let now = 0, paused = false, disabled = false;
  const state = {};

  function getScene() {
    return (BABYLON.EngineStore && BABYLON.EngineStore.LastCreatedScene) ||
           (BABYLON.Engine && BABYLON.Engine.LastCreatedScene) || null;
  }

  /* hero size from its meshes */
  function measureHero(root) {
    root.computeWorldMatrix(true);
    root.getDescendants(false).forEach(n => n.computeWorldMatrix && n.computeWorldMatrix(true));
    const meshes = root.getChildMeshes(false).filter(m => m.getTotalVertices && m.getTotalVertices() > 0);
    let H = 18, R = 3;
    if (meshes.length) {
      const min = new V3(Infinity, Infinity, Infinity);
      const max = new V3(-Infinity, -Infinity, -Infinity);
      meshes.forEach(m => {
        const bb = m.getBoundingInfo().boundingBox;
        min.minimizeInPlace(bb.minimumWorld);
        max.maximizeInPlace(bb.maximumWorld);
      });
      const h = max.y - min.y;
      const w = Math.max(max.x - min.x, max.z - min.z);
      if (isFinite(h) && h > 0.01) { H = h; R = Math.min(w / 2, h * 0.25); }
    }
    return { H, R };
  }

  /* terrain height under x,z (ray cast down onto the ice island) */
  let groundMesh = null;
  function groundY(x, z) {
    if (!groundMesh) groundMesh = scene.getMeshByName("iceIsland");
    if (!groundMesh) return null;
    const ray = new BABYLON.Ray(new V3(x, 300, z), new V3(0, -1, 0), 600);
    const hit = scene.pickWithRay(ray, m => m === groundMesh);
    return hit && hit.hit && hit.pickedPoint ? hit.pickedPoint.y : null;
  }

  /* camera right-hand direction on the ground (used only for sideMode "screen") */
  function cameraRight() {
    const cam = scene.activeCamera;
    let fx = 0, fz = 1;
    if (cam && cam.getTarget) {
      const t = cam.getTarget();
      fx = t.x - cam.position.x;
      fz = t.z - cam.position.z;
      const l = Math.hypot(fx, fz) || 1;
      fx /= l; fz /= l;
    }
    return { x: fz, z: -fx };
  }

  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /* ------------------------------------------------------------------
     Per-frame update
     ------------------------------------------------------------------ */
  function step(h, dt) {
    const p = h.root.position;
    const o = state[OPP[h.name]];
    const held = h.held;

    // unit vector from this hero to the opponent = "forward"
    let fx = o.root.position.x - p.x;
    let fz = o.root.position.z - p.z;
    const fl = Math.hypot(fx, fz);
    if (fl > 0.0001) { fx /= fl; fz /= fl; } else { fx = h.lastFx; fz = h.lastFz; }
    h.lastFx = fx; h.lastFz = fz;

    // ---- walking
    const forward = (held.up ? 1 : 0) - (held.down ? 1 : 0);
    const side = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    h.moving = false;

    if (!disabled && dt > 0 && (forward || side)) {
      let rx = fz, rz = -fx;                       // hero's right-hand side
      if (CFG.sideMode === "screen") {
        const c = cameraRight(); rx = c.x; rz = c.z;
      }
      let vx = fx * forward + rx * side;
      let vz = fz * forward + rz * side;
      const l = Math.hypot(vx, vz) || 1;
      vx /= l; vz /= l;
      const sp = CFG.speed * h.H * (h.hiding ? CFG.hideSpeedMul : 1);
      p.x += vx * sp * dt;
      p.z += vz * sp * dt;
      h.moving = true;
    }

    // ---- knockback (set by physics.js through HeroControls.impulse)
    if (dt > 0 && (h.kvx || h.kvz)) {
      p.x += h.kvx * dt;
      p.z += h.kvz * dt;
      const f = Math.exp(-CFG.knockFriction * dt);
      h.kvx *= f; h.kvz *= f;
      if (Math.abs(h.kvx) < 0.02 && Math.abs(h.kvz) < 0.02) { h.kvx = 0; h.kvz = 0; }
    }

    // stay on the island
    const rr = Math.hypot(p.x, p.z);
    if (rr > CFG.arenaRadius) { p.x *= CFG.arenaRadius / rr; p.z *= CFG.arenaRadius / rr; }

    // do not walk through the opponent
    let dx = o.root.position.x - p.x;
    let dz = o.root.position.z - p.z;
    const d = Math.hypot(dx, dz);
    const minDist = (h.R + o.R) * 0.9;
    if (d > 0.0001 && d < minDist) {
      p.x = o.root.position.x - (dx / d) * minDist;
      p.z = o.root.position.z - (dz / d) * minDist;
      dx = o.root.position.x - p.x;
      dz = o.root.position.z - p.z;
    }

    // ---- jump physics
    if (h.air && dt > 0) {
      h.vy -= h.gravity * dt;
      h.jy += h.vy * dt;
      if (h.jy <= 0) { h.jy = 0; h.vy = 0; h.air = false; }
    }

    // ---- hide (duck): smooth squash
    h.crouch += ((h.hiding ? 1 : 0) - h.crouch) * Math.min(1, dt * 10);
    h.root.scaling.y = h.baseScale.y * (1 - (1 - CFG.hideScale) * h.crouch);

    // ---- height: terrain + jump + tiny walk bob
    const g = groundY(p.x, p.z);
    const base = (g === null ? h.startY : g + h.yOff);
    const bob = (h.moving && !h.air) ? Math.abs(Math.sin(now * 10)) * 0.012 * h.H : 0;
    p.y = base + h.jy + bob;

    // ---- face the opponent
    if (Math.hypot(dx, dz) > 0.0001) {
      const target = Math.atan2(dx, dz) + h.faceOff;
      const cur = h.root.rotation.y;
      h.root.rotation.y = cur + angleDiff(target, cur) * Math.min(1, dt * CFG.turnSpeed);
    }
  }

  function frame() {
    let dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
    if (paused) dt = 0;
    now += dt;
    HEROES.forEach(n => {
      try { step(state[n], dt); }
      catch (err) { console.error("controls.js step error:", err); }
    });
  }

  /* ------------------------------------------------------------------
     HUD events
     ------------------------------------------------------------------ */
  function onControl(e) {
    const { hero, action, pressed } = e.detail;
    const h = state[hero];
    if (!h) return;
    if (CFG.debug) console.log("[controls]", hero, action, pressed);

    if (action === "up" || action === "down" || action === "left" || action === "right") {
      h.held[action] = !!pressed;
    } else if (action === "jump") {
      if (pressed && !disabled && !paused && !h.air && !h.hiding) {
        h.air = true;
        h.vy = h.jumpV;
      }
    } else if (action === "crouch") {
      h.hiding = !!pressed && !disabled;
    }
  }

  /* ------------------------------------------------------------------
     Boot: wait until both heroes exist
     ------------------------------------------------------------------ */
  function init(roots) {
    HEROES.forEach(name => {
      const root = roots[name];
      const opp = roots[OPP[name]];
      const m = measureHero(root);

      // keep the facing you already set (Kabir 0deg, Tiger 180deg)
      const yawToOpp = Math.atan2(opp.position.x - root.position.x, opp.position.z - root.position.z);
      const g0 = groundY(root.position.x, root.position.z);

      const jh = CFG.jumpHeight * m.H;
      const gravity = 8 * jh / (CFG.jumpTime * CFG.jumpTime);

      state[name] = {
        name, root, H: m.H, R: m.R,
        baseScale: root.scaling.clone(),
        startY: root.position.y,
        yOff: g0 === null ? 0 : root.position.y - g0,
        faceOff: (root.rotation.y - yawToOpp) + (CFG.faceFixDeg[name] || 0) * Math.PI / 180,
        held: { up: false, down: false, left: false, right: false },
        lastFx: 0, lastFz: 1, kvx: 0, kvz: 0,
        moving: false, hiding: false, crouch: 0,
        air: false, vy: 0, jy: 0,
        gravity, jumpV: gravity * CFG.jumpTime / 2
      };
    });

    scene.onBeforeRenderObservable.add(frame);

    window.addEventListener("hudcontrol", onControl);
    window.addEventListener("gamepause", e => { paused = !!e.detail.paused; });
    window.addEventListener("healthchange", e => {
      if (e.detail && e.detail.health <= 0) {
        disabled = true;
        HEROES.forEach(n => {
          const h = state[n];
          h.held.up = h.held.down = h.held.left = h.held.right = false;
          h.hiding = false;
        });
      }
    });

    window.HeroControls = {
      isHiding:  hero => !!(state[hero] && state[hero].hiding),
      isJumping: hero => !!(state[hero] && state[hero].air),
      isMoving:  hero => !!(state[hero] && state[hero].moving),
      size:      hero => state[hero] ? { H: state[hero].H, R: state[hero].R } : null,
      // push a hero: vx/vz = horizontal speed, vy = upward speed (units per second)
      impulse: (hero, vx, vz, vy) => {
        const h = state[hero];
        if (!h || disabled) return;
        h.kvx += vx; h.kvz += vz;
        if (vy > 0) { h.air = true; h.vy = Math.max(h.vy, vy); }
      },
      config: CFG
    };
    console.log("controls.js ready");
  }

  function boot() {
    scene = getScene();
    const k = scene && scene.getTransformNodeByName("kabirRoot");
    const t = scene && scene.getTransformNodeByName("tigerRoot");
    if (!k || !t) { setTimeout(boot, 250); return; }
    init({ kabir: k, tiger: t });
  }

  boot();
})();
