/* =====================================================================
   KABIR VS TIGER 3D  -  physics.js
   Light, fast physics (no physics engine download needed):

     1) HIT KNOCKBACK  - every hit pushes the hero away from the attacker
                         and slides to a stop (friction). Strong hits
                         (hammer, sniper, axes...) also pop the hero up.
     2) ICE SHARDS     - each hit throws small ice pieces that fall with
                         gravity, bounce on the island and slide.
     3) CRYSTAL WALLS  - heroes cannot walk through the ice crystals.
     4) HIDE           - a ducked hero takes less knockback.

   Needs: controls.js and weapons.js (updated versions) loaded too.
   ADD:   <script src="../4_GAME_LOGICS/physics.js"></script>
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     SETTINGS  (H = hero height)
     ------------------------------------------------------------------ */
  const CFG = {
    knockPerDamage: 0.06,   // knockback speed = damage * this * H
    liftDamage: 15,         // hits at/above this damage also pop the hero up
    liftSpeed: 0.9,         // pop-up speed (H per second)
    hideKnockMul: 0.4,      // knockback multiplier while hiding

    shardsPerHit: 6,
    shardLife: 1.3,         // seconds
    shardSizeH: 0.03,       // shard size as fraction of H
    gravityH: 4.4,          // shard gravity (H per second squared)
    bounce: 0.4,            // how bouncy shards are (0..1)
    maxShards: 80,

    crystalCollision: true
  };

  const V3 = BABYLON.Vector3;
  const HEROES = ["tiger", "kabir"];

  let scene = null;
  let paused = false;
  const roots = {};
  const shards = [];
  const crystals = [];
  let shardMat = null;

  function getScene() {
    return (BABYLON.EngineStore && BABYLON.EngineStore.LastCreatedScene) ||
           (BABYLON.Engine && BABYLON.Engine.LastCreatedScene) || null;
  }

  /* terrain height under x,z */
  let groundMesh = null;
  function groundY(x, z) {
    if (!groundMesh) groundMesh = scene.getMeshByName("iceIsland");
    if (!groundMesh) return 0;
    const ray = new BABYLON.Ray(new V3(x, 300, z), new V3(0, -1, 0), 600);
    const hit = scene.pickWithRay(ray, m => m === groundMesh);
    return hit && hit.hit && hit.pickedPoint ? hit.pickedPoint.y : 0;
  }

  /* ------------------------------------------------------------------
     Hit -> knockback + shards
     ------------------------------------------------------------------ */
  function onHit(e) {
    const d = e.detail;
    if (!d) return;
    const target = roots[d.hero], attacker = roots[d.attacker];
    const size = window.HeroControls && window.HeroControls.size(d.hero);
    if (!target || !attacker || !size) return;

    let dx = target.position.x - attacker.position.x;
    let dz = target.position.z - attacker.position.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;

    let v = d.amount * CFG.knockPerDamage * size.H;
    if (window.HeroControls.isHiding(d.hero)) v *= CFG.hideKnockMul;
    const lift = d.amount >= CFG.liftDamage ? CFG.liftSpeed * size.H : 0;
    window.HeroControls.impulse(d.hero, dx * v, dz * v, lift);

    spawnShards(d.point, dx, dz, size.H);
  }

  function spawnShards(point, dx, dz, H) {
    if (!point) return;
    for (let i = 0; i < CFG.shardsPerHit; i++) {
      if (shards.length >= CFG.maxShards) { const old = shards.shift(); old.mesh.dispose(); }
      const s = BABYLON.MeshBuilder.CreateBox("shard", { size: 1 }, scene);
      const sz = H * CFG.shardSizeH * (0.5 + Math.random());
      s.scaling.set(sz, sz * (0.6 + Math.random()), sz * (0.6 + Math.random()));
      s.material = shardMat;
      s.isPickable = false;
      s.position.copyFrom(point);
      const sp = H * (0.8 + Math.random() * 1.2);
      shards.push({
        mesh: s, size: sz,
        vx: dx * sp * 0.5 + (Math.random() - 0.5) * sp,
        vy: sp * (0.5 + Math.random() * 0.8),
        vz: dz * sp * 0.5 + (Math.random() - 0.5) * sp,
        sx: (Math.random() - 0.5) * 12, sy: (Math.random() - 0.5) * 12,
        t: 0, H
      });
    }
  }

  function updateShards(dt) {
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      s.t += dt;
      if (s.t >= CFG.shardLife) { s.mesh.dispose(); shards.splice(i, 1); continue; }

      s.vy -= CFG.gravityH * s.H * dt;
      const p = s.mesh.position;
      p.x += s.vx * dt; p.y += s.vy * dt; p.z += s.vz * dt;
      s.mesh.rotation.x += s.sx * dt;
      s.mesh.rotation.y += s.sy * dt;

      const gy = groundY(p.x, p.z) + s.size * 0.5;
      if (p.y < gy) {
        p.y = gy;
        s.vy = Math.abs(s.vy) > s.H * 0.4 ? -s.vy * CFG.bounce : 0;
        s.vx *= 0.7; s.vz *= 0.7;
        s.sx *= 0.5; s.sy *= 0.5;
      }
      // shrink at the end of life
      const k = s.t / CFG.shardLife;
      if (k > 0.7) s.mesh.visibility = 1 - (k - 0.7) / 0.3;
    }
  }

  /* ------------------------------------------------------------------
     Crystal walls
     ------------------------------------------------------------------ */
  function findCrystals() {
    scene.meshes.forEach(m => {
      if (m.name.indexOf("crystal_") !== 0) return;
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      const w = Math.max(bb.maximumWorld.x - bb.minimumWorld.x, bb.maximumWorld.z - bb.minimumWorld.z);
      crystals.push({ x: m.position.x, z: m.position.z, r: w / 2 * 0.8 });
    });
  }

  function collideCrystals() {
    HEROES.forEach(n => {
      const root = roots[n];
      const size = window.HeroControls.size(n);
      const hr = size ? size.R * 0.5 : 1;
      crystals.forEach(c => {
        const dx = root.position.x - c.x;
        const dz = root.position.z - c.z;
        const d = Math.hypot(dx, dz);
        const min = c.r + hr;
        if (d < min) {
          const k = d > 0.0001 ? min / d : 1;
          root.position.x = c.x + (d > 0.0001 ? dx * k : min);
          root.position.z = c.z + (d > 0.0001 ? dz * k : 0);
        }
      });
    });
  }

  /* ------------------------------------------------------------------
     Frame
     ------------------------------------------------------------------ */
  function frame() {
    let dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
    if (paused) dt = 0;
    try {
      if (dt > 0) updateShards(dt);
      if (CFG.crystalCollision) collideCrystals();
    } catch (err) { console.error("physics.js error:", err); }
  }

  /* ------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------ */
  function boot() {
    scene = getScene();
    const k = scene && scene.getTransformNodeByName("kabirRoot");
    const t = scene && scene.getTransformNodeByName("tigerRoot");
    if (!k || !t || !window.HeroControls) { setTimeout(boot, 250); return; }
    roots.kabir = k; roots.tiger = t;

    shardMat = new BABYLON.StandardMaterial("shardMat", scene);
    shardMat.diffuseColor = new BABYLON.Color3(0.7, 0.9, 1.0);
    shardMat.emissiveColor = new BABYLON.Color3(0.25, 0.4, 0.5);
    shardMat.specularColor = new BABYLON.Color3(1, 1, 1);

    findCrystals();
    scene.onBeforeRenderObservable.add(frame);
    window.addEventListener("herohit", onHit);
    window.addEventListener("gamepause", e => { paused = !!(e.detail && e.detail.paused); });
    console.log("physics.js ready (" + crystals.length + " crystals)");
  }

  boot();
})();


