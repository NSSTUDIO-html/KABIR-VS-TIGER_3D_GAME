/* =====================================================================
   KABIR VS TIGER 3D  -  keyboard-controls.js

   Connects keyboard keys to the HUMAN hero's on-screen buttons.
   Works in BOTH KABIR-VS-AI.html and TIGER-VS-AI.html (it reads the same
   "player_hero" value that weapon-access.js uses). The AI hero's buttons
   are never touched.

   It presses the REAL buttons (pointerdown / pointerup), so everything
   already wired to them keeps working: controls.js (move/jump/hide),
   weapons.js (shoot), shoot audio, weapon-access.js (locked weapons)
   and the pause lock.

   KEYS (human hero)
     Move forward / back / left / right : W A S D  or  Arrow keys
     SHOOT                              : Space  or  F  or  Enter
     JUMP                               : E  or  J
     HIDE (hold)                        : C  or  H
     Select weapon 1-5                  : 1 2 3 4 5  (locked weapons stay locked)
     Pause / resume                     : P or Esc   (already in pause.js)

   ADD (after weapon-access.js, in both HTML files):
     <script src="../4_GAME_LOGICS/keyboard-controls.js"></script>
   ===================================================================== */
(function () {
  'use strict';

  /* ---------------- SETTINGS: change keys here (use KeyboardEvent.code) ---------------- */
  const KEYS = {
    up:     ['KeyW', 'ArrowUp'],
    down:   ['KeyS', 'ArrowDown'],
    left:   ['KeyA', 'ArrowLeft'],
    right:  ['KeyD', 'ArrowRight'],
    shoot:  ['Space', 'KeyF', 'Enter'],
    jump:   ['KeyE', 'KeyJ'],
    crouch: ['KeyC', 'KeyH']                 // the HIDE button's data-action is "crouch"
  };
  const WEAPON_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];

  /* ---------------- helpers ---------------- */
  function getHero() {
    if (window.WeaponAccess && window.WeaponAccess.player) return window.WeaponAccess.player;
    try { return localStorage.getItem('player_hero') === 'tiger' ? 'tiger' : 'kabir'; }
    catch (e) { return 'kabir'; }
  }

  const codeToAction = {};
  Object.keys(KEYS).forEach(a => KEYS[a].forEach(c => { codeToAction[c] = a; }));

  const downCodes = new Set();    // physical keys currently held
  const pressed = new Set();      // actions currently pressed on the HUD
  let paused = false;

  function button(action) {
    return document.querySelector(
      '.control[data-hero="' + getHero() + '"][data-action="' + action + '"]');
  }

  function fire(el, type) {
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1,
      pointerType: 'mouse', isPrimary: true, button: 0
    }));
  }

  function press(action) {
    if (pressed.has(action)) return;
    const b = button(action);
    if (!b) return;
    pressed.add(action);
    fire(b, 'pointerdown');
  }

  function release(action) {
    if (!pressed.has(action)) return;
    pressed.delete(action);
    const b = button(action);
    if (b) fire(b, 'pointerup');
  }

  function releaseAll() {
    Array.from(pressed).forEach(release);
    downCodes.clear();
  }

  function selectWeapon(n) {
    const hero = getHero();
    const list = document.querySelectorAll('.weapon[data-hero="' + hero + '"][data-weapon]');
    const b = list[n];
    if (!b) return;
    // locked weapons: keep them locked (same rule as tapping them)
    if (window.WeaponAccess && !window.WeaponAccess.isUnlocked(hero, b.dataset.weapon)) {
      window.dispatchEvent(new CustomEvent('weaponlocked', { detail: { hero: hero, weapon: b.dataset.weapon } }));
      b.animate([{ transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }], { duration: 200 });
      return;
    }
    b.click();
  }

  function typing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  /* ---------------- key events ---------------- */
  window.addEventListener('keydown', function (e) {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;

    const wi = WEAPON_KEYS.indexOf(e.code);
    if (wi !== -1) {
      if (!e.repeat && !paused) selectWeapon(wi);
      return;
    }

    const action = codeToAction[e.code];
    if (!action) return;
    e.preventDefault();                       // no page scroll on arrows / space
    if (e.repeat || paused) return;
    downCodes.add(e.code);
    press(action);
  });

  window.addEventListener('keyup', function (e) {
    const action = codeToAction[e.code];
    if (!action) return;
    e.preventDefault();
    downCodes.delete(e.code);
    // two keys can share one action (W + ArrowUp): release only when none is held
    if (!KEYS[action].some(c => downCodes.has(c))) release(action);
  });

  /* ---------------- safety ---------------- */
  window.addEventListener('blur', releaseAll);                 // tab switch: no stuck movement
  window.addEventListener('gamepause', function (e) {          // pause.js fires this
    paused = !!(e.detail && e.detail.paused);
    if (paused) releaseAll();
  });
  window.addEventListener('healthchange', function (e) {       // a hero died: let go of keys
    if (e.detail && e.detail.health <= 0) releaseAll();
  });

  console.log('keyboard-controls.js ready  (hero: ' + getHero() + ')');
})();


