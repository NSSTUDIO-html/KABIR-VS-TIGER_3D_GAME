/* =====================================================================
   KABIR VS TIGER 3D  -  weapons.js
   - Loads 10 GLB weapons (5 per hero)
   - Selected weapon floats IN FRONT of its hero
   - SHOOT on a GUN      -> bullets fly automatically (homing) to the opponent
   - SHOOT on a MELEE    -> weapon flies to the opponent, swings, hits, returns
   - Damage goes through your existing "healthchange" event (health bars)

   ADD THIS LINE at the very END of your HTML, after the HUD <script>:
       <script src="weapons.js"></script>
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     1) EDIT THESE: folder of your weapon GLBs + file names
     ------------------------------------------------------------------ */
  const WEAPON_PATH = "../3_ASSETS/WEAPONS/";

  /*  type   : "gun" | "melee"
      style  : gun   -> pistol | rifle | shotgun | sniper
               melee -> slash | chop | smash | punch
      count  : 1 or 2  (2 = the GLB is ONE weapon, it gets cloned for left+right hand.
                        If your GLB already contains the pair, set count: 1)
      length : weapon size as a fraction of hero height
      flip   : true if the weapon points backwards in game
      roll   : degrees, if the weapon is rotated sideways                    */
  const WEAPONS = {
    tiger: {
      "hand-grips":  { file: "../3_ASSETS/WEAPONS/knuckle_duster.glb",  type: "melee", style: "punch",   count: 2, length: 0.16, damage: 6,  cooldown: 0.35 },
      "hammer":      { file: "../3_ASSETS/WEAPONS/hammer.glb",      type: "melee", style: "smash",   count: 1, length: 0.50, damage: 16, cooldown: 1.00 },
      "shotgun":     { file: "../3_ASSETS/WEAPONS/shotgun.glb",     type: "gun",   style: "shotgun", count: 1, length: 0.42, damage: 3,  cooldown: 1.10, pellets: 5, speed: 150 },
      "pistols":     { file: "../3_ASSETS/WEAPONS/m1911_pistol.glb",     type: "gun",   style: "pistol",  count: 2, length: 0.20, damage: 4,  cooldown: 0.40, speed: 170 },
      "dual-swords": { file: "../3_ASSETS/WEAPONS/sword.glb", type: "melee", style: "slash",   count: 2, length: 0.50, damage: 9,  cooldown: 0.70 }
    },
    kabir: {
      "katana":       { file: "../3_ASSETS/WEAPONS/katana.glb",       type: "melee", style: "slash",  count: 1, length: 0.55, damage: 10, cooldown: 0.60 },
      "dual-rifles":  { file: "../3_ASSETS/WEAPONS/rifle-a.glb",  type: "gun",   style: "rifle",  count: 2, length: 0.40, damage: 3,  cooldown: 0.90, burst: 3, speed: 200 },
      "dual-axes":    { file: "../3_ASSETS/WEAPONS/axe_low_poly-compressed.glb",    type: "melee", style: "chop",   count: 2, length: 0.40, damage: 12, cooldown: 0.90 },
      "sniper-rifle": { file: "../3_ASSETS/WEAPONS/sniper_rifle.glb", type: "gun",   style: "sniper", count: 1, length: 0.60, damage: 20, cooldown: 1.60, speed: 320, bulletSize: 1.7 },
      "dual-pistols": { file: "../3_ASSETS/WEAPONS/m1911_pistol.glb", type: "gun",   style: "pistol", count: 2, length: 0.20, damage: 4,  cooldown: 0.40, speed: 170 }
    }
  };

  const DEFAULT_SELECTED = { tiger: "hand-grips", kabir: "katana" };

  /* Melee animation styles (angles in radians, x = pitch, z = roll) */
  const MELEE_STYLES = {
    slash: { idle: { x: -0.9,  z: 0 },    windup: { x: -1.0, z: -0.9 }, strike: { x: 0.6, z: 0.9 }, travel: 1.0, swing: 0.22 },
    chop:  { idle: { x: -0.9,  z: 0 },    windup: { x: -1.7, z: 0 },    strike: { x: 0.8, z: 0 },   travel: 1.0, swing: 0.20 },
    smash: { idle: { x: -0.9,  z: 0 },    windup: { x: -2.1, z: 0 },    strike: { x: 1.0, z: 0 },   travel: 1.2, swing: 0.26 },
    punch: { idle: { x: -0.1,  z: 0 },    windup: { x: -0.15, z: 0 },   strike: { x: -0.15, z: 0 }, travel: 0.8, swing: 0.18, pop: true }
  };

  /* ------------------------------------------------------------------
     2) Internals
     ------------------------------------------------------------------ */
  const V3 = BABYLON.Vector3;
  const HEROES = ["tiger", "kabir"];
  const OPP = { tiger: "kabir", kabir: "tiger" };
  const COLORS = { tiger: [0.2, 1.0, 0.55], kabir: [1.0, 0.35, 0.2] };

  let scene = null;
  let now = 0, paused = false, gameOver = false;
  const state = {};
  const bullets = [];
  const fx = [];
  const timers = [];
  const ownHealth = { tiger: 100, kabir: 100 };

  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = k => 1 - (1 - k) * (1 - k);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function getScene() {
    return (BABYLON.EngineStore && BABYLON.EngineStore.LastCreatedScene) ||
           (BABYLON.Engine && BABYLON.Engine.LastCreatedScene) || null;
  }

  /* world bounding box of a node and all its child meshes */
  function worldBounds(node) {
    node.computeWorldMatrix(true);
    node.getDescendants(false).forEach(n => n.computeWorldMatrix && n.computeWorldMatrix(true));
    const meshes = node.getChildMeshes(false).filter(m => m.getTotalVertices && m.getTotalVertices() > 0);
    if (node.getTotalVertices && node.getTotalVertices() > 0) meshes.push(node);
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

  function measureHero(root) {
    const b = worldBounds(root);
    let H = 18, R = 3, chestOff = 9;
    if (b) {
      const h = b.max.y - b.min.y;
      const w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
      if (isFinite(h) && h > 0.01) {
        H = h;
        R = Math.min(w / 2, h * 0.25);
        chestOff = (b.min.y + h * 0.58) - root.position.y;
      }
    }
    return { H, R, chestOff };
  }

  function chestPos(h) {
    return new V3(h.root.position.x, h.root.position.y + h.chestOff, h.root.position.z);
  }

  function makeMats(name) {
    const c = COLORS[name];
    const bullet = new BABYLON.StandardMaterial(name + "_bulletMat", scene);
    bullet.disableLighting = true;
    bullet.emissiveColor = new BABYLON.Color3(c[0], c[1], c[2]);
    const spark = new BABYLON.StandardMaterial(name + "_sparkMat", scene);
    spark.disableLighting = true;
    spark.emissiveColor = new BABYLON.Color3(1, 0.85, 0.3);
    return { bullet, spark };
  }

  /* ------------------------------------------------------------------
     3) Build weapons
     ------------------------------------------------------------------ */
  function loadContainer(file) {
    return new Promise(resolve => {
      // file can be a plain name (uses WEAPON_PATH) or a full path with folders
      const hasPath = file.indexOf("/") !== -1;
      BABYLON.SceneLoader.LoadAssetContainer(
        hasPath ? "" : WEAPON_PATH, file, scene,
        c => resolve(c), null,
        (s, msg, ex) => { console.warn("Weapon GLB failed:", file, msg, ex || ""); resolve(null); }
      );
    });
  }

  async function buildWeapon(h, id, cfg) {
    const tag = h.name + "_" + id;
    const holder = new BABYLON.TransformNode(tag + "_holder", scene);
    const pivot = new BABYLON.TransformNode(tag + "_pivot", scene);
    pivot.parent = holder;
    holder.setEnabled(false);

    const container = await loadContainer(cfg.file);
    const lenW = cfg.length * h.H;
    const count = cfg.count || 1;
    const slots = [];

    for (let i = 0; i < count; i++) {
      const slot = new BABYLON.TransformNode(tag + "_slot" + i, scene);
      const flip = new BABYLON.TransformNode(tag + "_flip" + i, scene);
      const wrap = new BABYLON.TransformNode(tag + "_wrap" + i, scene);
      slot.parent = pivot; flip.parent = slot; wrap.parent = flip;

      let roots;
      if (container) {
        const inst = container.instantiateModelsToScene(n => tag + "_" + i + "_" + n, false);
        inst.animationGroups.forEach(g => g.stop());
        roots = inst.rootNodes;
      } else {
        // fallback box so the game still works if a GLB is missing
        const box = BABYLON.MeshBuilder.CreateBox(tag + "_box" + i, { width: 1, height: 1, depth: 4 }, scene);
        const mat = new BABYLON.StandardMaterial(tag + "_boxMat", scene);
        const c = COLORS[h.name];
        mat.diffuseColor = new BABYLON.Color3(c[0], c[1], c[2]);
        box.material = mat;
        roots = [box];
      }
      roots.forEach(r => { r.parent = wrap; });
      wrap.getChildMeshes(false).forEach(m => { m.isPickable = false; });
      slots.push({ slot, flip, wrap, roots });
    }

    // Measure first copy (everything still at identity) and normalise it
    const b = worldBounds(slots[0].wrap);
    let center = new V3(0, 0, 0), rx = 0, ry = 0, scale = 1;
    if (b) {
      const e = b.max.subtract(b.min);
      center = b.min.add(b.max).scale(0.5);
      let L = e.z;
      if (e.z >= e.x && e.z >= e.y) { L = e.z; }
      else if (e.x >= e.y)          { L = e.x; ry = -Math.PI / 2; }
      else                          { L = e.y; rx = Math.PI / 2; }
      scale = L > 0 ? lenW / L : 1;
    }

    const side = h.R * (cfg.type === "gun" ? 0.5 : 0.6);
    const muzzles = [];
    slots.forEach((s, i) => {
      s.roots.forEach(r => { r.position = center.negate(); });
      s.wrap.rotation.set(rx, ry, 0);
      s.wrap.scaling.setAll(scale);
      s.flip.rotation.y = cfg.flip ? Math.PI : 0;
      s.flip.rotation.z = (cfg.roll || 0) * Math.PI / 180;
      s.slot.position.x = count === 1 ? 0 : (i === 0 ? side : -side);
      const mz = new BABYLON.TransformNode(tag + "_muzzle" + i, scene);
      mz.parent = s.slot;
      mz.position.z = lenW / 2;
      muzzles.push(mz);
    });

    const w = { id, cfg, holder, pivot, slots, muzzles, lenW, recoil: 0 };
    h.weapons[id] = w;
    holder.setEnabled(h.selected === id);
    console.log("Weapon ready:", tag, container ? "(GLB)" : "(placeholder)");
  }

  /* ------------------------------------------------------------------
     4) Damage, effects, bullets
     ------------------------------------------------------------------ */
  function damage(targetName, amount, point, attackerName) {
    if (gameOver) return;
    const cur = (typeof heroHealth !== "undefined" && typeof heroHealth[targetName] === "number")
      ? heroHealth[targetName] : ownHealth[targetName];
    const next = Math.max(0, Math.round(cur - amount));
    ownHealth[targetName] = next;
    window.dispatchEvent(new CustomEvent("healthchange", { detail: { hero: targetName, health: next } }));
    window.dispatchEvent(new CustomEvent("herohit", {
      detail: { hero: targetName, attacker: attackerName, amount, point: point.clone() }
    }));
    spark(point, attackerName);
    if (next <= 0) endGame(attackerName);
  }

  function spark(pos, attackerName) {
    const h = state[attackerName];
    const s = BABYLON.MeshBuilder.CreateSphere("spark", { diameter: 1, segments: 6 }, scene);
    s.material = h.mats.spark;
    s.isPickable = false;
    s.position.copyFrom(pos);
    fx.push({ mesh: s, t: 0, dur: 0.3, size: h.H * 0.12 });
  }

  function spawnBullet(h, w, muzzleIndex, spread) {
    const cfg = w.cfg;
    const mz = w.muzzles[muzzleIndex] || w.muzzles[0];
    mz.computeWorldMatrix(true);
    const p = mz.getAbsolutePosition().clone();

    const size = h.H * 0.016 * (cfg.bulletSize || 1);
    const mesh = BABYLON.MeshBuilder.CreateSphere("bullet", { diameter: 1, segments: 6 }, scene);
    mesh.material = h.mats.bullet;
    mesh.isPickable = false;
    mesh.position.copyFrom(p);
    mesh.scaling.set(size, size, size * 4);
    bullets.push({
      mesh, owner: h.name, target: OPP[h.name],
      speed: cfg.speed || 160, dmg: cfg.damage,
      offset: spread || new V3(0, 0, 0), life: 3
    });

    // muzzle flash
    const f = BABYLON.MeshBuilder.CreateSphere("flash", { diameter: 1, segments: 6 }, scene);
    f.material = h.mats.spark; f.isPickable = false; f.position.copyFrom(p);
    fx.push({ mesh: f, t: 0, dur: 0.08, size: h.H * 0.05 });
  }

  function schedule(delay, fn) { timers.push({ t: delay, fn }); }

  function fireGun(h, w) {
    const cfg = w.cfg;
    const n = w.muzzles.length;
    w.recoil = h.H * (cfg.style === "sniper" ? 0.05 : 0.025);

    if (cfg.style === "shotgun") {
      const pellets = cfg.pellets || 5;
      for (let i = 0; i < pellets; i++) {
        const sp = new V3((Math.random() - 0.5) * h.H * 0.22, (Math.random() - 0.5) * h.H * 0.22, (Math.random() - 0.5) * h.H * 0.22);
        spawnBullet(h, w, 0, sp);
      }
    } else if (cfg.style === "rifle") {
      const burst = cfg.burst || 3;
      for (let b = 0; b < burst; b++) {
        for (let i = 0; i < n; i++) {
          schedule((b * n + i) * 0.07, () => spawnBullet(h, w, i));
        }
      }
    } else {
      // pistol / sniper: one bullet from every muzzle, slightly staggered
      for (let i = 0; i < n; i++) schedule(i * 0.09, () => spawnBullet(h, w, i));
    }
  }

  function strikePoint(h, w) {
    const opp = state[OPP[h.name]];
    const t = chestPos(opp);
    const k = opp.R * 0.9 + w.lenW * 0.3;
    return new V3(t.x - h.dir.x * k, t.y, t.z - h.dir.z * k);
  }

  function startMelee(h, w) {
    const st = MELEE_STYLES[w.cfg.style] || MELEE_STYLES.slash;
    const travel = clamp(h.dist / 220, 0.22, 0.45) * st.travel;
    h.attack = { w, st, t: 0, travel, swing: st.swing, back: 0.3, hit: false };
    const total = travel + st.swing + 0.3;
    h.nextShot = now + total + w.cfg.cooldown * 0.3;
  }

  function tryAttack(h) {
    if (paused || gameOver || h.attack) return;
    if (now < h.nextShot) return;
    const w = h.weapons[h.selected];
    if (!w) return;
    if (w.cfg.type === "gun") {
      h.nextShot = now + w.cfg.cooldown;
      fireGun(h, w);
    } else {
      startMelee(h, w);
    }
  }

  function setWeapon(heroName, id) {
    const h = state[heroName];
    if (!h) return;
    h.selected = id;
    h.attack = null;
    Object.keys(h.weapons).forEach(k => {
      const w = h.weapons[k];
      w.pivot.scaling.setAll(1);
      w.holder.setEnabled(k === id);
    });
  }

  /* ------------------------------------------------------------------
     5) Per-frame update
     ------------------------------------------------------------------ */
  function updateHero(h, dt) {
    const w = h.weapons[h.selected];
    if (!w) return;

    const me = h.root.position;
    const yaw = Math.atan2(h.dir.x, h.dir.z);
    const isGun = w.cfg.type === "gun";

    w.recoil *= (1 - Math.min(1, dt * 12));
    const front = h.R * 0.85 + w.lenW * (isGun ? 0.25 : 0.1) - w.recoil;
    const bob = Math.sin(now * 2 + h.phase) * h.H * 0.008;
    const home = new V3(
      me.x + h.dir.x * front,
      me.y + h.chestOff - h.H * 0.05 + bob,
      me.z + h.dir.z * front
    );

    w.holder.rotation.y = yaw;
    const st = MELEE_STYLES[w.cfg.style] || MELEE_STYLES.slash;

    if (h.attack && h.attack.w === w) {
      const a = h.attack;
      a.t += dt;
      const strike = strikePoint(h, w);
      const tr = a.travel, sw = a.swing, bk = a.back;
      let pos, rx, rz;

      if (a.t < tr) {
        const k = ease(a.t / tr);
        pos = V3.Lerp(home, strike, k);
        rx = lerp(st.idle.x, st.windup.x, k);
        rz = lerp(st.idle.z, st.windup.z, k);
      } else if (a.t < tr + sw) {
        const u = (a.t - tr) / sw;
        pos = strike;
        rx = lerp(st.windup.x, st.strike.x, u);
        rz = lerp(st.windup.z, st.strike.z, u);
        if (st.pop) w.pivot.scaling.setAll(1 + 0.4 * Math.sin(u * Math.PI));
        if (!a.hit && u >= 0.5) { a.hit = true; damage(OPP[h.name], w.cfg.damage, strike, h.name); }
      } else if (a.t < tr + sw + bk) {
        if (!a.hit) { a.hit = true; damage(OPP[h.name], w.cfg.damage, strike, h.name); }
        const u = (a.t - tr - sw) / bk;
        const k = ease(u);
        pos = V3.Lerp(strike, home, k);
        rx = lerp(st.strike.x, st.idle.x, k);
        rz = lerp(st.strike.z, st.idle.z, k);
        w.pivot.scaling.setAll(1);
      } else {
        h.attack = null;
        w.pivot.scaling.setAll(1);
        pos = home; rx = st.idle.x; rz = st.idle.z;
      }
      w.holder.position.copyFrom(pos);
      w.pivot.rotation.x = rx;
      w.pivot.rotation.z = rz;
      return;
    }

    // idle pose
    w.holder.position.copyFrom(home);
    if (isGun) {
      const t = chestPos(state[OPP[h.name]]);
      w.pivot.rotation.x = -Math.atan2(t.y - home.y, h.dist);
      w.pivot.rotation.z = 0;
    } else {
      w.pivot.rotation.x = st.idle.x;
      w.pivot.rotation.z = st.idle.z;
    }
  }

  function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      const target = state[b.target];
      b.life -= dt;
      if (!target || b.life <= 0) { b.mesh.dispose(); bullets.splice(i, 1); continue; }

      const tp = chestPos(target).addInPlace(b.offset);
      const v = tp.subtract(b.mesh.position);
      const dist = v.length();
      const step = b.speed * dt;
      const hitR = target.R * 0.9;

      if (dist <= step + hitR) {
        damage(b.target, b.dmg, b.mesh.position.clone(), b.owner);
        b.mesh.dispose();
        bullets.splice(i, 1);
        continue;
      }
      if (dt > 0) {
        v.scaleInPlace(step / dist);
        b.mesh.position.addInPlace(v);
        b.mesh.lookAt(tp);
      }
    }
  }

  function updateFx(dt) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      f.mesh.scaling.setAll(f.size * (0.3 + k * 1.2));
      f.mesh.visibility = 1 - k;
      if (k >= 1) { f.mesh.dispose(); fx.splice(i, 1); }
    }
  }

  function frame() {
    let dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
    if (paused) dt = 0;
    now += dt;

    HEROES.forEach(n => {
      const h = state[n], o = state[OPP[n]];
      let dx = o.root.position.x - h.root.position.x;
      let dz = o.root.position.z - h.root.position.z;
      const d = Math.hypot(dx, dz) || 1;
      h.dir.set(dx / d, 0, dz / d);
      h.dist = d;
    });

    for (let i = timers.length - 1; i >= 0; i--) {
      timers[i].t -= dt;
      if (timers[i].t <= 0) { const fn = timers[i].fn; timers.splice(i, 1); if (!gameOver) fn(); }
    }

    HEROES.forEach(n => {
      const h = state[n];
      if (h.holding) tryAttack(h);
      updateHero(h, dt);
    });
    updateBullets(dt);
    updateFx(dt);
  }

  /* ------------------------------------------------------------------
     6) Game over
     ------------------------------------------------------------------ */
  function endGame(winner) {
    gameOver = true;
    HEROES.forEach(n => { state[n].holding = false; });
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;align-items:center;" +
      "justify-content:center;gap:18px;background:#000b;color:#fff;font:900 clamp(28px,7vw,64px) Arial;letter-spacing:4px;";
    el.innerHTML = "<div>" + winner.toUpperCase() + " WINS!</div>" +
      '<button style="font:900 18px Arial;padding:12px 26px;border-radius:12px;border:2px solid #fff;background:#171d27;color:#fff;">PLAY AGAIN</button>';
    el.querySelector("button").addEventListener("click", () => location.reload());
    document.body.appendChild(el);
  }

  /* ------------------------------------------------------------------
     7) Boot: wait until both heroes are loaded, then build everything
     ------------------------------------------------------------------ */
  function init(roots) {
    HEROES.forEach(name => {
      const m = measureHero(roots[name]);
      const sel = (typeof selectedWeapons !== "undefined" && selectedWeapons[name]) || DEFAULT_SELECTED[name];
      state[name] = {
        name, root: roots[name], H: m.H, R: m.R, chestOff: m.chestOff,
        weapons: {}, selected: sel, dir: new V3(0, 0, 1), dist: 50,
        nextShot: 0, holding: false, attack: null, phase: Math.random() * 6,
        mats: makeMats(name)
      };
    });

    HEROES.forEach(name => {
      Object.keys(WEAPONS[name]).forEach(id => buildWeapon(state[name], id, WEAPONS[name][id]));
    });

    scene.onBeforeRenderObservable.add(frame);

    window.addEventListener("hudcontrol", e => {
      const { hero, action, pressed } = e.detail;
      const h = state[hero];
      if (!h || action !== "shoot") return;
      h.holding = pressed;
      if (pressed) tryAttack(h);
    });
    window.addEventListener("weaponselect", e => setWeapon(e.detail.hero, e.detail.weapon));
    window.addEventListener("gamepause", e => { paused = !!e.detail.paused; });

    /* Console helpers if a weapon points the wrong way:
         WeaponDebug.flip("kabir","katana")      -> turn 180 degrees
         WeaponDebug.roll("kabir","katana", 90)  -> roll sideways          */
    window.WeaponDebug = {
      flip(hero, id) {
        const w = state[hero] && state[hero].weapons[id];
        if (w) w.slots.forEach(s => { s.flip.rotation.y += Math.PI; });
      },
      roll(hero, id, deg) {
        const w = state[hero] && state[hero].weapons[id];
        if (w) w.slots.forEach(s => { s.flip.rotation.z = deg * Math.PI / 180; });
      }
    };
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
