/* =====================================================================
   KABIR VS TIGER 3D  -  pause.js
   Works with your existing PAUSE button (it fires the "gamepause" event).

   While PAUSED:
     - movement, jump, hide, bullets, weapon swings, cooldowns freeze
       (controls.js + weapons.js already stop on "gamepause")
     - snow particles freeze
     - weapon sounds pause (and continue on resume)
     - HUD buttons (move / shoot / jump / hide / weapon select) are locked
     - a big "PAUSED" label shows (camera can still be rotated)
   Extra:
     - press  P  or  Esc  on keyboard to pause / resume
     - game auto-pauses when you switch tab or minimise the browser

   ADD:  <script src="../4_GAME_LOGICS/pause.js"></script>
   ===================================================================== */
(function () {
  'use strict';

  let paused = false;
  let scene = null;
  const savedSpeed = new Map();   // particle system -> original updateSpeed
  let resumeAudio = [];           // audios that were playing when paused

  /* ---------- "PAUSED" label ---------- */
  const label = document.createElement("div");
  label.textContent = "PAUSED";
  label.style.cssText =
    "position:fixed;left:0;right:0;top:42%;z-index:15;text-align:center;pointer-events:none;" +
    "font:900 clamp(34px,9vw,84px) Arial,sans-serif;letter-spacing:8px;color:#fff;" +
    "text-shadow:0 0 18px #000,0 0 40px #e6a817;display:none;";
  document.body.appendChild(label);

  /* ---------- helpers ---------- */
  function getScene() {
    return (window.BABYLON && ((BABYLON.EngineStore && BABYLON.EngineStore.LastCreatedScene) ||
            (BABYLON.Engine && BABYLON.Engine.LastCreatedScene))) || null;
  }

  function allWeaponAudios() {
    const list = [];
    try {
      if (typeof weaponShootAudio !== "undefined") {
        Object.values(weaponShootAudio).forEach(hero =>
          Object.values(hero).forEach(a => list.push(a)));
      }
    } catch (e) { /* audio object not available */ }
    return list;
  }

  function freezeWorld() {
    scene = scene || getScene();
    if (scene) {
      scene.particleSystems.forEach(ps => {
        if (!savedSpeed.has(ps)) savedSpeed.set(ps, ps.updateSpeed);
        ps.updateSpeed = 0;
      });
      if (scene.animationGroups) {
        scene.animationGroups.forEach(g => { if (g.isPlaying) { g.pause(); g.__pausedByPause = true; } });
      }
    }
    resumeAudio = allWeaponAudios().filter(a => !a.paused && !a.ended);
    allWeaponAudios().forEach(a => a.pause());
  }

  function unfreezeWorld() {
    savedSpeed.forEach((speed, ps) => { ps.updateSpeed = speed; });
    savedSpeed.clear();
    if (scene && scene.animationGroups) {
      scene.animationGroups.forEach(g => { if (g.__pausedByPause) { g.play(g.loopAnimation); g.__pausedByPause = false; } });
    }
    resumeAudio.forEach(a => a.play().catch(() => {}));
    resumeAudio = [];
  }

  /* ---------- main switch ---------- */
  function setPaused(value) {
    value = !!value;
    if (value === paused) return;
    paused = value;
    label.style.display = paused ? "block" : "none";
    document.body.classList.toggle("game-paused", paused);
    if (paused) freezeWorld(); else unfreezeWorld();
  }

  // your PAUSE button already dispatches this event
  window.addEventListener("gamepause", e => setPaused(e.detail && e.detail.paused));

  /* ---------- lock HUD buttons while paused ----------
     Only the PRESS is blocked. Releases still go through, so a button that
     was held when you paused is released correctly.                        */
  document.addEventListener("pointerdown", e => {
    if (!paused) return;
    const t = e.target.closest ? e.target.closest(".control, .weapon") : null;
    if (t) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  document.addEventListener("click", e => {
    if (!paused) return;
    const t = e.target.closest ? e.target.closest(".weapon") : null;
    if (t) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  /* ---------- keyboard + auto pause ---------- */
  function pressPauseButton() {
    const btn = document.getElementById("pause-btn");
    if (btn) btn.click();
  }

  window.addEventListener("keydown", e => {
    if (e.repeat) return;
    if (e.key === "p" || e.key === "P" || e.key === "Escape") pressPauseButton();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !paused) pressPauseButton();
  });
})();


