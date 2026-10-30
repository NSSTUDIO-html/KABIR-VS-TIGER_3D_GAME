/* =====================================================================
   weapon-access.js  —  connects Kabir-Intro-Chat.html  ->  KABIR-VS-AI.html
   The chat/quiz pages save:  weapon_<subject> = "1"  (unlocked)
                              done_<subject>   = "1"  (answered)
   This file reads those keys and lets the game use ONLY unlocked weapons.

   HOW TO USE (KABIR-VS-AI.html), put this AFTER the HUD <script> block,
   just before </body>:
       <script src="../4_GAME_LOGICS/weapon-access.js"></script>

   Public API:  window.WeaponAccess
       .isUnlocked(hero, weapon)   -> true / false
       .unlockedList(hero)         -> ["katana", ...]
       .count(hero)                -> number
       .refresh()                  -> re-read storage and re-apply
   Events:   "weaponlocked"  detail {hero, weapon}   (tried a locked weapon)
             "weaponaccess"  detail {kabir:[...], tiger:[...]}  (after refresh)
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- 1) SUBJECT ORDER (same order as the 5 slots in the chat) ---------- */
  var SUBJECTS = ["maths", "physics", "chemistry", "coding", "english"];

  /* ---------- 2) WHICH WEAPON EACH SUBJECT UNLOCKS (edit here) ---------- */
  var MAP = {
    kabir: {
      maths: "katana",
      physics: "dual-rifles",
      chemistry: "dual-axes",
      coding: "sniper-rifle",
      english: "dual-pistols"
    },
    tiger: {
      maths: "hand-grips",
      physics: "hammer",
      chemistry: "shotgun",
      coding: "pistols",
      english: "dual-swords"
    }
  };

  /* Which hero is the human?  Set localStorage "player_hero" = "kabir" | "tiger"
     (default kabir). The AI hero is the other one. */
  var PLAYER = get("player_hero") === "tiger" ? "tiger" : "kabir";
  var AI = PLAYER === "kabir" ? "tiger" : "kabir";

  var secretAll = false; // set true by the weapon-bar swipe secret

  /* ---------- storage helpers ---------- */
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  /* ---------- who has what ---------- */
  var unlocked = { kabir: [], tiger: [] };

  function compute() {
    var all = { kabir: [], tiger: [] };
    var earned = [];                       // player's subjects answered correctly
    SUBJECTS.forEach(function (s) { if (get("weapon_" + s) === "1") earned.push(s); });

    if (secretAll) { // swipe secret: everything open for both heroes
      SUBJECTS.forEach(function (s) { all.kabir.push(MAP.kabir[s]); all.tiger.push(MAP.tiger[s]); });
      return all;
    }
    // human: exactly the weapons earned in the quiz
    earned.forEach(function (s) { all[PLAYER].push(MAP[PLAYER][s]); });
    // AI: unlocks the SAME NUMBER of weapons as the player (first N in order)
    for (var i = 0; i < earned.length; i++) all[AI].push(MAP[AI][SUBJECTS[i]]);
    return all;
  }

  function isUnlocked(hero, weapon) { return unlocked[hero] && unlocked[hero].indexOf(weapon) !== -1; }

  /* ---------- apply to the HUD buttons ---------- */
  function applyUI() {
    document.querySelectorAll(".weapon[data-weapon]").forEach(function (b) {
      var ok = isUnlocked(b.dataset.hero, b.dataset.weapon);
      b.classList.toggle("wa-locked", !ok);
      b.setAttribute("aria-disabled", ok ? "false" : "true");
      b.style.opacity = ok ? "" : "0.35";
      b.style.filter = ok ? "" : "grayscale(1)";
      b.style.position = "relative";
      var badge = b.querySelector(".wa-badge");
      if (!ok && !badge) {
        badge = document.createElement("span");
        badge.className = "wa-badge";
        badge.textContent = "🔒";
        badge.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:18px;pointer-events:none";
        b.appendChild(badge);
      } else if (ok && badge) { badge.remove(); }
    });
  }

  /* make sure each hero is holding an unlocked weapon */
  function ensureValidSelection() {
    if (typeof selectedWeapons === "undefined") return;       // HUD script not loaded yet
    ["kabir", "tiger"].forEach(function (hero) {
      if (isUnlocked(hero, selectedWeapons[hero])) return;
      var first = unlocked[hero][0];
      var btn = first && document.querySelector('.weapon[data-hero="' + hero + '"][data-weapon="' + first + '"]');
      if (btn) { btn.click(); }                                 // selects + fires "weaponselect"
      else {                                                    // nothing unlocked: bare hands
        selectedWeapons[hero] = null;
        document.querySelectorAll('.weapon[data-hero="' + hero + '"]').forEach(function (i) { i.classList.remove("selected"); });
        window.dispatchEvent(new CustomEvent("weaponselect", { detail: { hero: hero, weapon: null } }));
      }
    });
  }

  function refresh() {
    unlocked = compute();
    applyUI();
    ensureValidSelection();
    window.dispatchEvent(new CustomEvent("weaponaccess", { detail: unlocked }));
  }

  /* ---------- BLOCK locked weapons (runs before the game's own click code) ---------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".weapon[data-weapon]");
    if (!b || !e.isTrusted) return;                 // ignore our own programmatic clicks
    if (!isUnlocked(b.dataset.hero, b.dataset.weapon)) {
      e.stopImmediatePropagation(); e.preventDefault();
      window.dispatchEvent(new CustomEvent("weaponlocked", { detail: { hero: b.dataset.hero, weapon: b.dataset.weapon } }));
      b.animate([{ transform: "translateX(-3px)" }, { transform: "translateX(3px)" }, { transform: "none" }], { duration: 200 });
    }
  }, true);

  /* block SHOOT if the hero holds no unlocked weapon */
  function blockShoot(e) {
    var s = e.target.closest && e.target.closest('.control[data-action="shoot"]');
    if (!s || typeof selectedWeapons === "undefined") return;
    if (!isUnlocked(s.dataset.hero, selectedWeapons[s.dataset.hero])) {
      e.stopImmediatePropagation(); e.preventDefault();
    }
  }
  ["pointerdown", "mousedown", "touchstart", "click"].forEach(function (t) {
    document.addEventListener(t, blockShoot, true);
  });

  /* ---------- SECRET: swipe a weapon bar from first -> last = unlock all 5 ---------- */
  (function secretSwipe() {
    ["t-weapons", "k-weapons"].forEach(function (id) {
      var panel = document.getElementById(id);
      if (!panel) return;
      var startX = null, firstHit = false;
      panel.addEventListener("pointerdown", function (e) {
        var list = panel.querySelector(".weapon-list"), items = list ? list.querySelectorAll(".weapon") : [];
        var r = items.length ? items[0].getBoundingClientRect() : null;
        firstHit = !!r && e.clientX >= r.left - 10 && e.clientX <= r.right + 10 && e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10;
        startX = e.clientX;
      });
      panel.addEventListener("pointerup", function (e) {
        var items = panel.querySelectorAll(".weapon-list .weapon");
        var r = items.length ? items[items.length - 1].getBoundingClientRect() : null;
        if (firstHit && r && e.clientX >= r.left - 10 && Math.abs(e.clientX - startX) > r.width * 2) {
          secretAll = true; refresh();
        }
        startX = null; firstHit = false;
      });
    });
  })();

  /* ---------- go ---------- */
  window.WeaponAccess = {
    isUnlocked: isUnlocked,
    unlockedList: function (hero) { return (unlocked[hero] || []).slice(); },
    count: function (hero) { return (unlocked[hero] || []).length; },
    refresh: refresh,
    player: PLAYER,
    ai: AI
  };

  window.addEventListener("storage", refresh);       // chat tab changed while game open
  window.addEventListener("pageshow", refresh);      // came back via Back button
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh);
  else refresh();
})();


