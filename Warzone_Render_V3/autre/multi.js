/* ===== Multijoueur WARZONE : client (serveur = serve.py) ===== */
(function () {
  const qs = new URLSearchParams(location.search);
  const host = qs.get("server") || location.host || "localhost:8000";
  const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} };
  const SS = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} };
  let token = LS("wz_token"); if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); LS("wz_token", token); }
  const rndName = () => "user" + Math.floor(10000 + Math.random() * 90000);
  let nameKey = "wz_name_default", name = "", locked = false;

  const remotes = new Map(), rbullets = [], prevPos = new WeakMap();
  let ws = null, myId = null, lastSend = 0, wasDead = false, roster = [], cfgSrv = { dmg: 1, max: 0, locked: false };
  let isAdmin = false, godMode = false, frozen = false, flip = LS("wz_flip") === "1";
  let resourceUploadToken = "", resourceUploadTokenExpiry = 0, resourceTokenWaiters = [];
  let serverDisplayName = "WARZONE RENDER V2";
  const serverBots = new Map(), killToasts = new Set();
  let joinInfo = null, everJoined = false, badTries = 0, stop = false, panelOpen = false, selected = null, bans = [], pollT = null;
  const GEO = new THREE.SphereGeometry(0.12, 8, 8), MAT = new THREE.MeshBasicMaterial({ color: 0xff3355 });
  const notify = (m) => { try { showNotification(m); } catch (e) {} };
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const online = () => ws && ws.readyState === 1 && myId !== null;
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  // ---------- styles / UI ----------
  const st = document.createElement("style");
  st.textContent = `.wzui{font:12px/1.35 monospace;color:#dfe}.wzui button{background:#16202a;color:#cfe;border:1px solid #2c4a5a;border-radius:4px;padding:3px 7px;margin:2px;cursor:pointer;font:11px monospace}
.wzui button:hover{background:#1f3a4a}.wzui button.red{border-color:#a33;color:#fbb}.wzui button.grn{border-color:#2a7;color:#bfd}
.wzui input,.wzui select{background:#0b1218;color:#cfe;border:1px solid #2c4a5a;border-radius:4px;padding:3px;font:11px monospace}
.wzrow{padding:2px 4px;cursor:pointer;border-radius:3px;white-space:pre}.wzrow:hover{background:#16303d}.wzrow.sel{background:#1d4b60}
#wzpanel{position:fixed;top:0;right:0;width:370px;max-height:100vh;overflow:auto;background:rgba(8,12,16,.96);border-left:2px solid #00ff88;padding:10px;z-index:100000;display:none}
#wzpanel h4{margin:8px 0 3px;color:#00ff88;font-size:12px}
.wzmodal{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100001;display:flex;align-items:center;justify-content:center;text-align:center}
.wzbox{background:#0b1218;border:2px solid #00ff88;border-radius:10px;padding:22px 28px;max-width:420px}
#wzsuggest{display:none;position:absolute;left:0;bottom:30px;width:100%;max-height:190px;overflow:auto;background:rgba(5,10,14,.98);border:1px solid #456;border-radius:5px;box-shadow:0 8px 24px #000;z-index:100003}
.wz-suggestion{padding:5px 8px;color:#cde;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wz-suggestion:hover{background:#203442}
.wz-suggestion.active{background:#ffd400;color:#1b1800;font-weight:bold}
.wz-reminder{position:fixed;top:16px;left:16px;z-index:99990;width:min(360px,calc(100vw - 32px));padding:11px 14px 13px;border:1px solid rgba(72,218,201,.65);border-left:4px solid #48dac9;border-radius:12px;background:linear-gradient(135deg,rgba(7,22,29,.96),rgba(12,19,28,.92));box-shadow:0 10px 32px rgba(0,0,0,.42),0 0 20px rgba(72,218,201,.13);backdrop-filter:blur(10px);color:#e8fbff;opacity:0;transform:translateY(-10px);pointer-events:none;transition:opacity .24s ease,transform .24s ease;display:none}
.wz-reminder.visible{display:block;opacity:1;transform:translateY(0)}
.wz-reminder-head{display:flex;align-items:center;gap:8px;color:#71e8d8;font:800 10px/1.2 Segoe UI,sans-serif;letter-spacing:2px;margin-bottom:7px}
.wz-reminder-dot{width:7px;height:7px;border-radius:50%;background:#48dac9;box-shadow:0 0 10px #48dac9}
.wz-reminder-text{font:600 13px/1.5 Segoe UI,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;color:#f4fbff}`;
  document.head.appendChild(st);

  const hud = document.createElement("div");
  hud.className = "wzui"; hud.style.cssText = "position:fixed;top:44px;right:8px;z-index:50;background:rgba(0,0,0,.5);padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre;color:#9fe";
  document.body.appendChild(hud);
  const feed = document.createElement("div");
  feed.className = "wzui"; feed.style.cssText = "position:fixed;top:170px;right:8px;z-index:50;text-align:right;pointer-events:none";
  document.body.appendChild(feed);
  const reminderToast = document.createElement("div");
  reminderToast.className = "wz-reminder";
  reminderToast.innerHTML = '<div class="wz-reminder-head"><span class="wz-reminder-dot"></span><span>RAPPEL SERVEUR</span></div><div class="wz-reminder-text"></div>';
  document.body.appendChild(reminderToast);
  let reminderTimer = null;
  function showReminder(text) {
    reminderToast.querySelector(".wz-reminder-text").textContent = String(text || "");
    reminderToast.classList.add("visible");
    clearTimeout(reminderTimer);
    reminderTimer = setTimeout(() => reminderToast.classList.remove("visible"), 9000);
  }
  const banner = document.createElement("div");
  banner.style.cssText = "position:fixed;top:90px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(160,0,0,.9);color:#fff;font:bold 22px sans-serif;padding:12px 26px;border-radius:10px;display:none;pointer-events:none;text-align:center";
  document.body.appendChild(banner);
  let banT; function showBanner(t, ms) { banner.textContent = t; banner.style.display = "block"; clearTimeout(banT); if (ms) banT = setTimeout(() => banner.style.display = "none", ms); }
  const big = document.createElement("div");
  big.style.cssText = "position:fixed;inset:0;z-index:99998;display:none;align-items:center;justify-content:center;text-align:center;pointer-events:none;background:rgba(0,0,0,.35)";
  big.innerHTML = '<div style="max-width:86vw;font:900 clamp(32px,6vw,84px)/1.15 sans-serif;color:#ffd400;text-shadow:0 0 24px #ff9d00,0 4px 0 #000;word-break:break-word"></div>';
  document.body.appendChild(big);
  let bigT; function bigMsg(t) { big.firstChild.textContent = t; big.style.display = "flex"; clearTimeout(bigT); bigT = setTimeout(() => big.style.display = "none", Math.min(12000, 4000 + t.length * 90)); }
  function feedMsg(t) { const d = document.createElement("div"); d.textContent = t; d.style.cssText = "background:rgba(0,0,0,.55);padding:3px 7px;margin-top:3px;border-radius:4px"; feed.appendChild(d); setTimeout(() => d.remove(), 5000); }
  const GOLD = "color:#ffd400;font-weight:bold;text-shadow:0 0 6px #ffb300,0 0 2px #fff2a8";
  const nm = (n, adm) => adm ? '<span style="' + GOLD + '">' + esc(n) + "</span>" : esc(n);
  function drawHud(status) {
    const list = roster.slice().sort((a, b) => b.kills - a.kills).map(p => (p.id === myId ? ">" : " ") + String(p.id).padStart(2) + " " + nm(p.name, p.admin) + " ".repeat(Math.max(1, 17 - p.name.length)) + "K" + p.kills + " D" + p.deaths).join("\n");
    hud.innerHTML = '<span style="color:#52e4d2;font-weight:bold">' + esc(serverDisplayName) + '</span>\nONLINE ' + esc(status) + (cfgSrv.dmg !== 1 ? "  degats x" + cfgSrv.dmg : "") + "\n" + list;
  }
  drawHud("(connexion...)");

  function modal(html, keep) {
    const m = document.createElement("div"); m.className = "wzmodal wzui"; m.innerHTML = '<div class="wzbox">' + html + "</div>";
    ["keydown", "keyup", "mousedown", "mouseup", "mousemove", "click"].forEach(ev => m.addEventListener(ev, e => e.stopPropagation()));
    document.body.appendChild(m); try { document.exitPointerLock(); } catch (e) {} return m;
  }
  let overlay = null;
  function blockScreen(title, reason, sub) {
    if (overlay) overlay.remove();
    overlay = modal('<div style="font:bold 22px sans-serif;color:#ff5566">' + esc(title) + '</div><p style="font-size:14px">' + esc(reason) + '</p><p style="color:#789">' + esc(sub || "") + "</p>");
  }
  function clearBlock() { if (overlay) { overlay.remove(); overlay = null; } }

  const hello = () => { if (joinInfo) send({ t: "hello", name: joinInfo.name, token }); };
  function askJoin(reason) {
    if (overlay) overlay.remove();
    overlay = modal('<div style="font:bold 20px sans-serif;color:#00ff88">WARZONE RENDER V2</div><p style="color:#ff8;min-height:16px">' + esc(reason || "") + '</p>' +
      '<div>Pseudo ' + (locked ? '<span style="color:#789">(definitif sur cette instance)</span>' : "") + '<br><input id="wzn" maxlength="16" ' + (locked ? "readonly" : "") + ' style="width:210px;font-size:15px;margin:4px" value="' + esc(name) + '"></div>' +
      '<div style="margin-top:10px"><button id="wzplay" class="grn" style="font-size:14px">Jouer</button></div>');
    const n = overlay.querySelector("#wzn"), play = overlay.querySelector("#wzplay");
    const go = () => {
      if (!locked) name = (n.value.trim() || rndName()).slice(0, 16);
      joinInfo = { name }; clearBlock(); hello();
    };
    play.onclick = go; n.onkeydown = e => { if (e.key === "Enter") go(); };
    n.focus(); if (!locked) n.select();
  }
  // ---------- avatars des autres joueurs ----------
  function makeTag(txt, adm) {
    const c = document.createElement("canvas"); c.width = 256; c.height = 64;
    const g = c.getContext("2d"); g.font = "bold 34px sans-serif"; g.textAlign = "center"; g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(0, 8, 256, 48);
    g.fillStyle = adm ? "#ffd400" : "#fff"; if (adm) { g.shadowColor = "#ffb300"; g.shadowBlur = 10; } g.fillText(txt, 128, 45);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: true, depthWrite: false, transparent: true }));
    s.scale.set(1.6, 0.4, 1); s.position.y = 2.1; s.renderOrder = 10; return s;
  }
  const nameOf = (id) => { const p = roster.find(r => r.id === id); return p ? p.name : "#" + id; };
  function makeAvatar() {
    const holder = new THREE.Group(), av = createOperatorModel();
    av.rotation.y = flip ? Math.PI : 0; holder.add(av); holder.userData.av = av; return holder;
  }
  function addRemote(id) {
    if (id === myId) return null; if (remotes.has(id)) return remotes.get(id);
    const mesh = makeAvatar(); scene.add(mesh);
    const r = { mesh, tag: null, tagName: "", target: null, dead: false, snapped: false }; remotes.set(id, r); return r;
  }
  function removeRemote(id) { const r = remotes.get(id); if (r) { scene.remove(r.mesh); remotes.delete(id); } }
  function updateServerBot(data) {
    if (!data || !data.id) return;
    let r = serverBots.get(data.id);
    if (!r) {
      const mesh = makeAvatar(); scene.add(mesh);
      r = { mesh, target: null, tag: null, snapped: false }; serverBots.set(data.id, r);
      r.tag = makeTag(data.name || "BOT", false); r.mesh.add(r.tag);
    }
    r.target = data;
    const plate = r.mesh.getObjectByName("botPlateVisual");
    if (plate) plate.visible = Number(data.shield || 0) > 0;
    if (!r.snapped && data.p) { r.mesh.position.set(data.p[0], data.p[1] || 0, data.p[2]); r.snapped = true; }
  }
  function syncServerBots(items) {
    const keep = new Set(items.map(b => b.id));
    for (const id of [...serverBots.keys()]) if (!keep.has(id)) removeServerBot(id);
    items.forEach(updateServerBot);
  }
  function removeServerBot(id) {
    const r = serverBots.get(id); if (r) { scene.remove(r.mesh); serverBots.delete(id); }
  }
  let resourceResetTimer = null;
  function showResourceReset(seconds) {
    if (resourceResetTimer) clearInterval(resourceResetTimer);
    if (panelOpen) togglePanel(false);
    let left = Math.max(1, Math.min(60, Number(seconds) || 10));
    if (overlay) overlay.remove();
    overlay = modal('<div style="font:bold 20px sans-serif;color:#ffd45c">Un admin a redémarré pour des ajouts - Redémarrage dans <span id="wzresetcount">' + left + '</span> sec</div>');
    resourceResetTimer = setInterval(() => {
      left -= 1;
      const el = overlay && overlay.querySelector("#wzresetcount");
      if (el) el.textContent = String(Math.max(0, left));
      if (left <= 0) { clearInterval(resourceResetTimer); location.reload(); }
    }, 1000);
  }
  function applyFlip() { for (const r of remotes.values()) r.mesh.userData.av.rotation.y = flip ? Math.PI : 0; }

  // ---------- actions recues du serveur ----------
  const _dp = window.damagePlayer; if (typeof _dp === "function") window.damagePlayer = function () { if (godMode) return; return _dp.apply(this, arguments); };
  function giveItem(it, rawAmount) {
    const defaults = { ammo: 90, plate: 3, stim: 2, weapon: 1, health: 100, kit: 1 };
    const supplied = rawAmount !== undefined && rawAmount !== null && rawAmount !== "";
    const parsed = supplied ? Number(rawAmount) : defaults[it];
    const amount = Math.max(1, Math.min(9999, Math.floor(Number.isFinite(parsed) ? parsed : (defaults[it] || 1))));
    if (it === "ammo") reserveAmmo += amount;
    if (it === "plate") inventoryPlates += amount;
    if (it === "stim") inventoryStimulants += amount;
    if (it === "weapon" || it === "kit") { hasWeapon = true; ammo = maxMagazine; playerGun.visible = true; }
    if (it === "health") {
      if (supplied) playerHealth = Math.min(100, playerHealth + amount);
      else { playerHealth = 100; equippedPlates = 3; shieldPoints = 150; }
    }
    if (it === "kit") {
      reserveAmmo += 90 * amount;
      inventoryPlates += 3 * amount;
      inventoryStimulants += 2 * amount;
      playerHealth = 100; equippedPlates = 3; shieldPoints = 150;
    }
    updateHUD();
    const labels = { ammo: "munitions", plate: "plaques", stim: "stimulants", weapon: "arme", health: "PV", kit: "kits" };
    notify("L'admin t'a donne : " + amount + " " + (labels[it] || it));
  }
  function doAction(m) {
    switch (m.a) {
      case "tp": camera.position.set(m.p[0], m.p[1] + 1.7, m.p[2]); velocityY = 0; notify("Teleporte par l'admin"); break;
      case "give": giveItem(m.item, m.amount); break;
      case "heal": playerHealth = 100; equippedPlates = 3; shieldPoints = 150; updateHUD(); notify("Soigne par l'admin"); break;
      case "kill": if (!isDead) { playerHealth = 0; updateHUD(); playerDie(); } break;
      case "revive": if (isDead) respawnPlayer(); break;
      case "launch": velocityY = 0.9; isGrounded = false; break;
      case "freeze": frozen = !!m.on; if (frozen) { keys.KeyW = keys.KeyA = keys.KeyS = keys.KeyD = false; isShooting = false; showBanner("GELE PAR L'ADMIN", 0); } else banner.style.display = "none"; break;
      case "god": godMode = !!m.on; notify(godMode ? "Mode Dieu active" : "Mode Dieu desactive"); break;
    }
  }
  // gel : on coupe les entrees du jeu (capture, avant les ecouteurs du jeu)
  ["keydown", "mousedown", "mousemove"].forEach(t => window.addEventListener(t, e => {
    if (frozen && !(e.target.closest && e.target.closest(".wzui"))) { e.stopImmediatePropagation(); if (t === "keydown") e.preventDefault(); }
  }, true));

  // ---------- reseau ----------
  function connect() {
    if (stop) return;
    try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + host + "/ws"); } catch (e) { drawHud("(erreur)"); setTimeout(connect, 3000); return; }
    ws.onopen = () => hello();
    ws.onclose = () => {
      myId = null; isAdmin = false; consoleAuthenticated = false; consoleOpen = false; consoleBusy = false; consoleSnapshot = null; resourceUploadToken = ""; resourceUploadTokenExpiry = 0;
      resourceTokenWaiters.splice(0).forEach(w => { clearTimeout(w.timer); w.reject(new Error("Connexion au serveur perdue.")); });
      if (consolePanel) consolePanel.style.display = "none";
      if (consoleToggle) consoleToggle.style.display = "none"; for (const id of [...remotes.keys()]) removeRemote(id);
      if (!stop) { drawHud("(deconnecte...)"); setTimeout(connect, 2500); }
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.t) {
        case "resource_token_res":
          if (m.ok && m.token) { resourceUploadToken = m.token; resourceUploadTokenExpiry = Date.now() + 25 * 60 * 1000; }
          resourceTokenWaiters.splice(0).forEach(w => { clearTimeout(w.timer); m.ok && m.token ? w.resolve(m.token) : w.reject(new Error(m.message || "Jeton admin refuse.")); });
          break;
        case "console_auth_res": onConsoleAuthResult(m); break;
        case "console_ui_res": onConsoleUiResult(m); break;
        case "console_result": notify(m.output || ""); break;
        case "welcome":
          myId = m.id; everJoined = true; badTries = 0; roster = m.players; isAdmin = !!m.admin; clearBlock(); name = m.name; locked = true; LS(nameKey, name);
          if (m.settings) cfgSrv = m.settings;
          serverDisplayName = m.server_name || cfgSrv.server_name || serverDisplayName;
          document.title = serverDisplayName + " - WARZONE RENDER V2";
         
          notify("Connecte ! Tu es " + m.name + " (#" + myId + ")"); drawHud("(" + roster.length + ")"); break;
        case "badname":
          if (everJoined && badTries++ < 4) setTimeout(hello, 1500); else askJoin(m.reason); break;
        case "denied":
          if (m.ban) { stop = true; blockScreen("BANNI", m.reason, ""); } else blockScreen("Connexion refusee", m.reason, "Nouvelle tentative automatique...");
          break;
        case "kicked":
          stop = true; blockScreen(m.ban ? "BANNI" : "EXPULSE", m.reason, m.ban ? "" : "Recharge la page (F5) pour rejoindre a nouveau."); break;
        case "roster":
          roster = m.players; drawHud("(" + roster.length + ")");
          if (consoleSnapshot && Array.isArray(consoleSnapshot.players)) {
            const known = new Map(consoleSnapshot.players.map(p => [p.id, p]));
            consoleSnapshot.players = roster.map(p => Object.assign({}, known.get(p.id) || {}, p));
            if (consoleSnapshot.server) consoleSnapshot.server.players = roster.length;
            if (consoleOpen && ["home","players","ban","kick","promote","demote","mute","rename"].includes(consolePage) && consolePanel && !consolePanel.querySelector("#wzadm-content input:focus, #wzadm-content textarea:focus")) renderConsoleApp();
          }
          const wasAdmin = isAdmin;
          isAdmin = !!(roster.find(p => p.id === myId) || {}).admin;
         
          if (wasAdmin && !isAdmin) {
            if (panelOpen) togglePanel(false);
            if (window.WZ && WZ.closeResourcePanel) WZ.closeResourcePanel();
          }
          for (const p of roster) { const r = addRemote(p.id); const key = p.name + (p.admin ? "*" : ""); if (r && r.tagName !== key) { if (r.tag) r.mesh.remove(r.tag); r.tag = makeTag(p.name, p.admin); r.tagName = key; r.mesh.add(r.tag); } }
          for (const id of [...remotes.keys()]) if (!roster.find(p => p.id === id)) removeRemote(id);
          if (chatOpen) renderAutocomplete();
          break;
        case "settings": cfgSrv = m; if (window.wzBotRules) { window.wzBotRules.max = m.max_bots == null ? 12 : m.max_bots; window.wzBotRules.damage = m.bot_damage == null ? null : m.bot_damage; } if (m.bots === false && window.wzClearLocalBots) window.wzClearLocalBots(); if (consoleSnapshot) consoleSnapshot.cfg = Object.assign({}, consoleSnapshot.cfg || {}, m); if (m.server_name) serverDisplayName = m.server_name; drawHud("(" + roster.length + ")"); if (panelOpen) renderPanel(); if (consoleOpen && consolePanel && consolePage === "home") renderConsoleApp(); break;
        case "server_renamed": serverDisplayName = String(m.name || "WARZONE RENDER V2"); document.title = serverDisplayName + " - WARZONE RENDER V2"; drawHud("(" + roster.length + ")"); notify("Serveur renomme : " + serverDisplayName); break;
        case "admin_mode":
          if (typeof window.setWZAdminFreecam === "function") window.setWZAdminFreecam(!!m.freecam);
          notify("Modes admin — Vanish " + (m.vanish ? "ON" : "OFF") + " · Ghost " + (m.ghost ? "ON" : "OFF") + " · Freecam " + (m.freecam ? "ON" : "OFF"));
          break;
        case "role":
          isAdmin = !!m.admin;
          if (!isAdmin) { if (panelOpen) togglePanel(false); if (window.WZ && WZ.closeResourcePanel) WZ.closeResourcePanel(); }
          notify(isAdmin ? "Tu es maintenant administrateur." : "Tes droits admin ont ete retires."); break;
        case "resources": if (window.WZ && typeof WZ.applyServerResources === "function") WZ.applyServerResources(m.data || {}); break;
        case "resource_reset": showResourceReset(m.seconds || 10); break;
        // Les bots sont locaux : le serveur valide juste le spawn, puis chaque client gere SES bots.
        case "bot_spawn_ok": if (window.wzSpawnLocalBot) window.wzSpawnLocalBot(); break;
        case "bots_clear": if (window.wzClearLocalBots) window.wzClearLocalBots(); break;
        case "bots": break;
        case "bot_update": updateServerBot(m.bot); break;
        case "bot_kill":
          removeServerBot(m.id);
          if (m.killer_id === myId) { try { window.wzHitmarker && window.wzHitmarker(0, "health", true, m.victim); } catch (e) {} }
          feedMsg((m.killer ? m.killer + " a elimine " : "") + (m.victim || "un bot"));
          break;
        case "state": { const r = addRemote(m.id); if (!r) break; r.target = m; r.dead = !!m.dead; r.mesh.visible = !r.dead && !m.hidden; const plate = r.mesh.getObjectByName("botPlateVisual"); if (plate && m.shield != null) plate.visible = Number(m.shield) > 0; if (window.WZGameWeapons && WZGameWeapons.setRemoteWeapon) WZGameWeapons.setRemoteWeapon(r.mesh, m.weapon || null); if (!r.snapped) { r.mesh.position.set(m.p[0], m.p[1], m.p[2]); r.snapped = true; } break; }
        case "leave": removeRemote(m.id); break;
        case "weapon_world": if (window.WZGameWeapons && WZGameWeapons.applyWorldWeapon) WZGameWeapons.applyWorldWeapon(m.item || null); break;
        case "weapon_picked": if (window.WZGameWeapons && WZGameWeapons.weaponPicked) WZGameWeapons.weaponPicked(m, m.player === myId); break;
        case "weapon_action_res": if (window.WZGameWeapons && WZGameWeapons.weaponActionResult) WZGameWeapons.weaponActionResult(m); break;
        case "shoot": { const b = new THREE.Mesh(GEO, MAT); b.position.set(...m.o); b.userData.v = new THREE.Vector3(...m.d).multiplyScalar(4.5); b.userData.born = performance.now(); scene.add(b); rbullets.push(b); break; }
        case "hit": damagePlayer(m.dmg); break;
        case "hit_confirm":
          if (window.wzHitmarker) {
            if (m.shield_dmg > 0) window.wzHitmarker(m.shield_dmg, "shield", false, m.to || "");
            if (m.health_dmg > 0) window.wzHitmarker(m.health_dmg, "health", false, m.to || "");
            if (!(m.shield_dmg > 0) && !(m.health_dmg > 0)) window.wzHitmarker(m.dmg || 0, m.kind || "health", false, m.to || "");
            if (m.eliminated) window.wzHitmarker(0, "health", true, m.to || "");
          }
          break;
        case "eliminated":
          if (window.wzHitmarker) window.wzHitmarker(0, "health", true, m.victim || "");
          break;
        case "killfeed":
          feedMsg((m.killer ? m.killer + " a elimine " + m.victim : m.victim + " est mort"));
          if (m.killer_id === myId && window.wzHitmarker) window.wzHitmarker(0, "health", true, m.victim || "");
          break;
        case "do": doAction(m); break;
        case "msg": bigMsg(m.text); break;
        case "chat": addChat(m); break;
        case "reminder": showReminder(m.text); break;
        case "admin_res": notify(m.msg); break;
        case "alist": roster = m.players; bans = m.bans; cfgSrv = m.settings; drawHud("(" + roster.length + ")"); if (panelOpen) renderPanel(); break;
      }
    };
  }
  async function initMultiplayer() {
    try {
      const scheme = location.protocol === "https:" ? "https://" : "http://";
      const r = await fetch(scheme + host + "/_instance", { cache: "no-store" });
      if (r.ok) { const data = await r.json(); if (data && data.id) nameKey = "wz_name_" + data.id; }
    } catch (e) { nameKey = "wz_name_" + location.host; }
    const savedName = LS(nameKey);
    name = (savedName || qs.get("name") || "").trim() || rndName();
    locked = !!savedName;
    joinInfo = locked ? { name } : null;
    connect();
    if (!locked) askJoin();
  }
  initMultiplayer();

  // ---------- boucle ----------
  const _v = new THREE.Vector3(), _d = new THREE.Vector3();
  WZ.onFrame((dt, now) => {
    if (online() && now - lastSend > 0.05) {
      lastSend = now; camera.getWorldDirection(_d);
      send({ t: "state", p: [+camera.position.x.toFixed(2), +(camera.position.y - 1.7).toFixed(2), +camera.position.z.toFixed(2)], yaw: Math.atan2(_d.x, _d.z), pitch: _d.y, hp: Math.round(playerHealth), shield: shieldPoints, dead: isDead, weapon: window.WZGameWeapons && WZGameWeapons.getEquippedWeapon ? WZGameWeapons.getEquippedWeapon() : null });
    }
    if (isDead && !wasDead) send({ t: "dead" });
    wasDead = isDead;
    for (const r of remotes.values()) {
      const t = r.target; if (!t) continue; const k = Math.min(1, dt * 15);
      r.mesh.position.x += (t.p[0] - r.mesh.position.x) * k; r.mesh.position.y += (Math.max(0, t.p[1]) - r.mesh.position.y) * k; r.mesh.position.z += (t.p[2] - r.mesh.position.z) * k;
      let dy = t.yaw - r.mesh.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); r.mesh.rotation.y += dy * k;
    }
    for (const r of serverBots.values()) {
      const t = r.target; if (!t || !t.p) continue; const k = Math.min(1, dt * 10);
      r.mesh.position.x += (t.p[0] - r.mesh.position.x) * k;
      r.mesh.position.y += ((t.p[1] || 0) - r.mesh.position.y) * k;
      r.mesh.position.z += (t.p[2] - r.mesh.position.z) * k;
      let dy = (t.yaw || 0) - r.mesh.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); r.mesh.rotation.y += dy * k;
    }
    for (let i = rbullets.length - 1; i >= 0; i--) {
      const b = rbullets[i]; b.position.addScaledVector(b.userData.v, dt * 60);
      if (performance.now() - b.userData.born > 1500) { scene.remove(b); rbullets.splice(i, 1); }
    }
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      if (!b.userData.sent) { b.userData.sent = true; const dd = b.velocity.clone().normalize(); send({ t: "shoot", o: [b.position.x, b.position.y, b.position.z], d: [dd.x, dd.y, dd.z], weapon: window.WZGameWeapons && WZGameWeapons.getEquippedWeapon ? WZGameWeapons.getEquippedWeapon() : null }); }
      let prev = prevPos.get(b); if (!prev) prev = b.position.clone().sub(b.velocity);
      let hitSomething = false;
      for (const [id, r] of remotes) {
        if (r.dead || !r.mesh.visible) continue;
        const c = _v.set(r.mesh.position.x, r.mesh.position.y + 0.8, r.mesh.position.z), ab = _d.subVectors(b.position, prev), L2 = ab.lengthSq() || 1e-6;
        let u = ((c.x - prev.x) * ab.x + (c.y - prev.y) * ab.y + (c.z - prev.z) * ab.z) / L2; u = Math.max(0, Math.min(1, u));
        const dx = prev.x + ab.x * u - c.x, dy = prev.y + ab.y * u - c.y, dz = prev.z + ab.z * u - c.z;
        if (dx * dx + dz * dz < 0.25 && Math.abs(dy) < 1.0) {
          send({ t: "hit", to: id, dmg: 20 }); notify("Touche : " + nameOf(id)); hitSomething = true; break;
        }
      }
      if (!hitSomething) for (const [id, r] of serverBots) {
        const c = _v.set(r.mesh.position.x, r.mesh.position.y + 0.8, r.mesh.position.z), ab = _d.subVectors(b.position, prev), L2 = ab.lengthSq() || 1e-6;
        let u = ((c.x - prev.x) * ab.x + (c.y - prev.y) * ab.y + (c.z - prev.z) * ab.z) / L2; u = Math.max(0, Math.min(1, u));
        const dx = prev.x + ab.x * u - c.x, dy = prev.y + ab.y * u - c.y, dz = prev.z + ab.z * u - c.z;
        if (dx * dx + dy * dy + dz * dz < 0.55) { send({ t: "bot_hit", id, dmg: 20 }); hitSomething = true; break; }
      }
      if (hitSomething) { scene.remove(b); bullets.splice(i, 1); prevPos.delete(b); continue; }
      prevPos.set(b, b.position.clone());
    }
  });

  // ---------- touches admin : F2 = ressources, N = console ----------
  let chatOpen = false;
  window.addEventListener("keydown", (e) => {
    const isTyping = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.code === "Escape") {
      if (consoleOpen) { e.preventDefault(); e.stopImmediatePropagation(); toggleGameConsole(false); return; }
      if (chatOpen) { e.preventDefault(); e.stopImmediatePropagation(); closeChat(); return; }
      if (panelOpen) { e.preventDefault(); e.stopImmediatePropagation(); togglePanel(false); return; }
      if (window.WZ && WZ.isResourcePanelOpen && WZ.isResourcePanelOpen()) {
        e.preventDefault(); e.stopImmediatePropagation(); WZ.closeResourcePanel(); return;
      }
    }
    if (e.code === "F10" && consoleAuthenticated) {
      e.preventDefault(); e.stopImmediatePropagation(); toggleGameConsole(!consoleOpen); return;
    }
    if (e.code === "F2") {
      if (isTyping || !online() || !(isAdmin || consoleAuthenticated)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      return; // ouverture/fermeture geree par engine.js ; Echap ferme le panneau
    }
    if (e.code === "KeyN" && !isTyping) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (online() && isAdmin) togglePanel(!panelOpen);
      return; // aucun message pour les non-admins
    }
    if ((e.code === "KeyT" || e.key === "/" || e.key === "!") && online() && !chatOpen && !isTyping && !panelOpen && !overlay && !consoleOpen) {
      e.preventDefault(); e.stopImmediatePropagation(); openChat(e.key === "/" || e.key === "!" ? e.key : ""); return;
    }
  }, true);

  // ---------- chat (T = ecrire, / = commande, Tab = suggestion) ----------
  const chatBox = document.createElement("div"); chatBox.className = "wzui";
  chatBox.style.cssText = "position:fixed;left:30px;bottom:175px;width:min(470px,calc(100vw - 60px));z-index:60;position:fixed";
  chatBox.innerHTML = '<div id="wzlog" style="display:flex;flex-direction:column;justify-content:flex-end;max-height:250px;overflow:hidden"></div><div style="position:relative"><div id="wzsuggest"></div><input id="wzin" maxlength="200" autocomplete="off" style="display:none;width:100%;box-sizing:border-box;margin-top:4px;font-size:13px;padding:5px;background:rgba(0,0,0,.9)"></div>';
  document.body.appendChild(chatBox);
  const clog = chatBox.querySelector("#wzlog"), cin = chatBox.querySelector("#wzin"), suggestBox = chatBox.querySelector("#wzsuggest");
  ["keydown", "keyup", "mousedown", "mouseup", "mousemove"].forEach(t => chatBox.addEventListener(t, e => e.stopPropagation()));
  const instr = document.getElementById("instructions");
  function hint() { return isAdmin ? "Message... (/help commandes de jeu · Echap ferme)" : "Message... (/report nom raison · /all commandes · Echap ferme)"; }
  function openChat(pre) {
    if (window.wzResetInput) window.wzResetInput();
    chatOpen = true; cin.style.display = "block"; cin.placeholder = hint(); cin.value = pre || ""; clog.querySelectorAll(".wzc").forEach(l => l.style.display = "block");
    try { document.exitPointerLock(); } catch (e) {} setTimeout(() => { if (chatOpen && instr) instr.style.display = "none"; }, 100); cin.focus(); renderAutocomplete();
  }
  function closeChat() {
    chatOpen = false; cin.style.display = "none"; cin.blur(); cin.value = "";
    suggestBox.style.display = "none"; suggestBox.innerHTML = "";
    clog.querySelectorAll(".wzc").forEach(l => { if (l.dataset.old) l.style.display = "none"; });
    if (window.wzResetInput) window.wzResetInput(); if (!isDead) { if (window.wzRelock) window.wzRelock(); else { try { document.body.requestPointerLock(); } catch (e) {} } }
  }

  const ADMIN_AUTOCOMPLETE = [
    ["all", "message global"], ["god", "joueur|all [on|off]"], ["godmod", "alias de god"],
    ["tp", "joueur [destination]"], ["bring", "joueur|all (Base Admin)"], ["tpb", "aller a la Base Admin"],
    ["vanish", "invisibilite visuelle"], ["ghost", "invisible + cache de la liste joueurs"], ["freecam", "camera libre / traverse les murs"],
    ["give", "joueur|all objet [quantite]"],
    ["heal", "joueur|all"], ["kill", "joueur|all"], ["revive", "joueur|all"],
    ["launch", "joueur|all"], ["freeze", "joueur|all [on|off]"], ["unfreeze", "joueur|all"],
    ["mp", "joueur message"], ["help", "message aux admins"], ["report", "joueur raison"]
  ];
  const PLAYER_ARG_COMMANDS = new Set(["god", "godmod", "tp", "bring", "give", "heal", "kill", "revive", "launch", "freeze", "unfreeze"]);
  const ITEM_SUGGESTIONS = ["ammo", "plate", "stim", "weapon", "health", "kit"];
  let autocompleteItems = [], autocompleteIndex = 0;
  function computeSuggestions(value) {
    if (!value.startsWith("/")) return [];
    if (!isAdmin) {
      const publicCommands = [["report", "joueur raison"], ["mp", "joueur message"], ["help", "message aux admins"], ["all", "liste des commandes"]];
      const rawPublic = value.slice(1);
      const partsPublic = rawPublic.split(/\s+/);
      const trailingPublic = /\s$/.test(rawPublic);
      const cmdPublic = (partsPublic[0] || "").toLowerCase();
      if (partsPublic.length === 1 && !trailingPublic) {
        const termPublic = cmdPublic;
        return publicCommands.map(x => ({ value: "/" + x[0], label: "/" + x[0] + "  —  " + x[1] }))
          .filter(x => x.value.slice(1).toLowerCase().startsWith(termPublic));
      }
      const names = roster.slice().sort((a, b) => a.name.localeCompare(b.name)).map(x => x.name);
      const adminNames = roster.filter(x => x.admin).map(x => x.name).sort((a, b) => a.localeCompare(b));
      const argIndexPublic = partsPublic.length - 1;
      const tokenPublic = trailingPublic ? "" : (partsPublic[partsPublic.length - 1] || "");
      const choices = cmdPublic === "report" && argIndexPublic === 1 ? names :
        (cmdPublic === "mp" && argIndexPublic === 1 ? adminNames : []);
      const term = tokenPublic.toLowerCase();
      return choices.filter(x => !term || x.toLowerCase().startsWith(term) || x.toLowerCase().includes(term))
        .map(x => ({ value: x, label: x }));
    }
    const raw = value.slice(1);
    const parts = raw.split(/\s+/);
    const commandTyped = parts[0] || "";
    const hasTrailingSpace = /\s$/.test(raw);
    if (parts.length === 1 && !hasTrailingSpace) {
      const term = commandTyped.toLowerCase();
      return ADMIN_AUTOCOMPLETE.map(x => ({ value: "/" + x[0], label: "/" + x[0] + "  —  " + x[1] }))
        .filter(x => x.value.slice(1).toLowerCase().startsWith(term) || x.value.slice(1).toLowerCase().includes(term))
        .sort((a, b) => {
          const as = a.value.slice(1).toLowerCase().startsWith(term) ? 0 : 1;
          const bs = b.value.slice(1).toLowerCase().startsWith(term) ? 0 : 1;
          return as - bs || a.value.localeCompare(b.value);
        });
    }

    const cmd = commandTyped.toLowerCase();
    const argIndex = parts.length - 1;
    const argsBeforeCurrent = parts.slice(1, argIndex);
    let candidates = [];
    const playerNames = roster.slice().sort((a, b) => a.name.localeCompare(b.name)).map(x => x.name);
    const withAll = ["all", ...playerNames];
    if ((cmd === "mp" || cmd === "report") && argIndex === 1) candidates = playerNames;
    else if (PLAYER_ARG_COMMANDS.has(cmd) && argIndex === 1) candidates = cmd === "tp" ? playerNames : withAll;
    else if (cmd === "tp" && argIndex === 2) candidates = playerNames;
    else if ((cmd === "god" || cmd === "godmod") && argIndex === 2) candidates = ["on", "off"];
    else if (cmd === "give" && argIndex === 2) candidates = ITEM_SUGGESTIONS;
    else if (cmd === "give" && argIndex === 3) candidates = ["1", "2", "3", "5", "10", "25", "50", "90", "100"];
    else if ((cmd === "freeze") && argIndex === 2) candidates = ["on", "off"];

    const token = hasTrailingSpace ? "" : (parts[parts.length - 1] || "");
    // Les valeurs numeriques de quantite sont libres : les presets sont des raccourcis.
    const numericArg = cmd === "give" && argIndex === 3;
    if (numericArg && /^\d+(?:[.,]\d+)?$/.test(token) && !candidates.includes(token)) candidates = [...candidates, token];
    const term = token.toLowerCase();
    return candidates.map(value => ({ value: String(value), label: String(value) }))
      .filter(x => !term || x.value.toLowerCase().startsWith(term) || x.value.toLowerCase().includes(term))
      .sort((a, b) => {
        const as = a.value.toLowerCase().startsWith(term) ? 0 : 1;
        const bs = b.value.toLowerCase().startsWith(term) ? 0 : 1;
        return as - bs || a.value.localeCompare(b.value);
      });
  }
  function renderAutocomplete() {
    autocompleteItems = computeSuggestions(cin.value);
    autocompleteIndex = 0;
    suggestBox.innerHTML = "";
    if (!chatOpen || !autocompleteItems.length) { suggestBox.style.display = "none"; return; }
    autocompleteItems.slice(0, 8).forEach((item, index) => {
      const el = document.createElement("div");
      el.className = "wz-suggestion" + (index === autocompleteIndex ? " active" : "");
      el.textContent = item.label;
      el.addEventListener("mousedown", e => e.preventDefault());
      el.addEventListener("click", () => applyAutocomplete(index));
      suggestBox.appendChild(el);
    });
    suggestBox.style.display = "block";
  }
  function applyAutocomplete(index) {
    const item = autocompleteItems[index];
    if (!item) return;
    const start = cin.value.lastIndexOf(" ") + 1;
    cin.value = cin.value.slice(0, start) + item.value + " ";
    cin.focus();
    renderAutocomplete();
  }
  cin.addEventListener("input", renderAutocomplete);
  cin.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && suggestBox.style.display !== "none" && autocompleteItems.length) {
      e.preventDefault(); applyAutocomplete(autocompleteIndex); return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggestBox.style.display !== "none" && autocompleteItems.length) {
      e.preventDefault();
      autocompleteIndex = (autocompleteIndex + (e.key === "ArrowDown" ? 1 : -1) + Math.min(8, autocompleteItems.length)) % Math.min(8, autocompleteItems.length);
      [...suggestBox.children].forEach((el, i) => el.classList.toggle("active", i === autocompleteIndex)); return;
    }
    if (e.key === "Enter") {
      const v = cin.value.trim();
      if (/^![0-9]{60}$/.test(v)) {
        send({ t: "console_auth", code: v.slice(1) });
        closeChat();
      } else if (v.startsWith("!")) {
        notify("Code CMD invalide : tape ! suivi exactement de 60 chiffres.");
        cin.select();
      } else if (v) send({ t: "chat", text: v });
      if (!v.startsWith("!") || /^![0-9]{60}$/.test(v)) closeChat();
    }
    else if (e.key === "Escape") { e.preventDefault(); closeChat(); }
  });
  function addChat(m) {
    let h = "";
    const k = m.kind;
    if (k === "pub") h = nm(m.from, m.admin) + ": " + esc(m.text);
    else if (k === "mp") h = '<span style="color:#e6a0ff">[MP] ' + nm(m.from, (roster.find(p => p.name === m.from) || {}).admin) + " > toi : " + esc(m.text) + "</span>";
    else if (k === "mp_out") h = '<span style="color:#e6a0ff">[MP] toi > ' + esc(m.to) + " : " + esc(m.text) + "</span>";
    else if (k === "spy") h = '<span style="color:#8fd">[SPY] ' + esc(m.from) + " > " + esc(m.to) + " : " + esc(m.text) + "</span>";
    else if (k === "help") h = '<span style="color:#ff8a5c">[AIDE] ' + esc(m.from) + " : " + esc(m.text) + "  (repondre : /mp " + esc(m.from) + " ...)</span>";
    else if (k === "help_out") h = '<span style="color:#ff8a5c">[AIDE] toi > admins : ' + esc(m.text) + "</span>";
    else if (k === "report") h = '<span style="color:#ffbd66;font-weight:bold">[SIGNALEMENT] ' + esc(m.from) + ' → ' + esc(m.to) + ' : ' + esc(m.text) + "</span>";
    else h = '<span style="color:#ffe27a">' + esc(m.text) + "</span>";
    const l = document.createElement("div"); l.className = "wzc"; l.innerHTML = h;
    l.style.cssText = "background:rgba(0,0,0,.5);padding:2px 6px;margin-top:2px;border-radius:3px;font-size:13px;word-break:break-word";
    clog.appendChild(l); while (clog.children.length > 60) clog.firstChild.remove();
    setTimeout(() => { l.dataset.old = 1; if (!chatOpen) l.style.display = "none"; }, 9000);
  }
  // ---------- panel admin ----------

  // ---------- Centre d'administration integre (pages JavaScript + actions serveur structurees)
  let consoleAuthenticated = false, consoleOpen = false;
  let consolePanel = null, consoleToggle = null;
  let consoleSnapshot = null, consolePage = "home", consoleSelectedPlayerId = null;
  let consoleSelectedReminderId = null, consoleBusy = false, consoleRestoreRect = null;
  const consoleMenu = [
    {id:"players", n:"01", title:"Liste des joueurs", group:"Joueurs", desc:"Voir les joueurs connectes et leur etat"},
    {id:"limit", n:"02", title:"Limite de joueurs", group:"Serveur", desc:"Regler le nombre maximum de connexions"},
    {id:"ban", n:"03", title:"Bannir un joueur", group:"Sanctions", desc:"Bannir un joueur connecte avec un motif"},
    {id:"unban", n:"04", title:"Debannir", group:"Sanctions", desc:"Consulter la liste des bans et en retirer"},
    {id:"kick", n:"05", title:"Expulser un joueur", group:"Sanctions", desc:"Deconnecter un joueur avec un motif"},
    {id:"message", n:"06", title:"Message a tous", group:"Joueurs", desc:"Envoyer une annonce a tout le serveur"},
    {id:"lock", n:"07", title:"Verrouiller le serveur", group:"Serveur", desc:"Bloquer ou autoriser les nouvelles connexions"},
    {id:"damage", n:"08", title:"Degats des joueurs", group:"Serveur", desc:"Ajuster le multiplicateur de degats"},
    {id:"reset", n:"09", title:"Reset des scores", group:"Serveur", desc:"Remettre tous les scores K/D a zero"},
    {id:"promote", n:"10", title:"Promouvoir admin", group:"Roles", desc:"Choisir un joueur et lui donner le role admin"},
    {id:"demote", n:"11", title:"Retirer admin", group:"Roles", desc:"Choisir un admin et retirer ses droits"},
    {id:"info", n:"12", title:"Infos serveur", group:"Serveur", desc:"Instance, connexions, lien et evenements"},
    {id:"pvp", n:"13", title:"PVP ON / OFF", group:"Serveur", desc:"Activer ou desactiver le combat joueur contre joueur"},
    {id:"bots", n:"14", title:"Bots ON / OFF", group:"Bots", desc:"Activer ou desactiver les bots du serveur"},
    {id:"spawn", n:"15", title:"Droit de spawn", group:"Bots", desc:"Autoriser ou interdire le spawn des joueurs"},
    {id:"killbots", n:"16", title:"Supprimer les bots", group:"Bots", desc:"Eliminer tous les bots actuellement presents"},
    {id:"cooldown", n:"17", title:"Delai de spawn bots", group:"Bots", desc:"Definir le delai en secondes pour les non-admins"},
    {id:"reminders", n:"18", title:"Rappels en jeu", group:"Communauté", desc:"Creer, modifier, mettre en pause ou supprimer"},
    {id:"reports", n:"19", title:"Signalements joueurs", group:"Communauté", desc:"Lire les signalements et les marquer comme traites"},
    {id:"servername", n:"20", title:"Renommer le serveur", group:"Serveur", desc:"Changer le nom affiche dans le jeu"},
    {id:"banip", n:"21", title:"Ban IP", group:"Sanctions", desc:"Bannir une adresse IP precise"},
    {id:"mute", n:"22", title:"Mute joueur", group:"Sanctions", desc:"Bloquer le chat d'un joueur connecte"},
    {id:"mutes", n:"23", title:"Liste des mutes", group:"Sanctions", desc:"Consulter et retirer les sanctions de chat"},
    {id:"rename", n:"24", title:"Renommer un joueur", group:"Joueurs", desc:"Modifier le pseudo d'un joueur connecte"}
  ];
  const consoleGroups = ["Joueurs", "Roles", "Sanctions", "Serveur", "Bots", "Communauté"];
  const consoleEsc = esc;
  const consoleCall = (action, data = {}) => {
    if (!consoleAuthenticated || !online()) { notify("Connexion au serveur indisponible."); return; }
    if (consoleBusy) return;
    consoleBusy = true;
    send({ t:"console_ui", action, data });
    if (consolePanel) consolePanel.classList.add("wzadm-waiting");
  };
  function consoleSetPage(id) {
    consolePage = id;
    consoleSelectedPlayerId = null;
    consoleSelectedReminderId = null;
    renderConsoleApp();
    if (id !== "home") consoleCall("snapshot");
  }
  function consolePlayerRows(filter = () => true) {
    const source = consoleSnapshot && Array.isArray(consoleSnapshot.players) ? consoleSnapshot.players : roster;
    return source.slice().sort((a,b) => a.id-b.id).filter(filter);
  }
  function consoleStatus(value, onText="ACTIF", offText="INACTIF") {
    return `<span class="wzadm-status ${value ? "is-on" : "is-off"}"><i></i>${value ? onText : offText}</span>`;
  }
  function consoleField(label, id, value="", type="text", extra="") {
    return `<label class="wzadm-field"><span>${label}</span><input id="${id}" type="${type}" value="${consoleEsc(value)}" ${extra}></label>`;
  }
  function consoleTextArea(label, id, value="", extra="") {
    return `<label class="wzadm-field"><span>${label}</span><textarea id="${id}" ${extra}>${consoleEsc(value)}</textarea></label>`;
  }
  function consoleButton(label, action, cls="", extra="") {
    return `<button type="button" class="wzadm-btn ${cls}" data-submit="${action}" ${extra}>${label}</button>`;
  }
  function consolePlayerPick(filter, page, actionLabel, fieldsHtml="", danger=false) {
    const players = consolePlayerRows(filter);
    const chosen = players.find(p => p.id === consoleSelectedPlayerId);
    const cards = players.map(p => `<button class="wzadm-playerpick ${p.id === consoleSelectedPlayerId ? "selected" : ""}" data-pick-player="${p.id}" type="button">
      <span class="wzadm-avatar">${consoleEsc(String(p.name || "?").slice(0,1).toUpperCase())}</span><span class="wzadm-playertext"><b>${consoleEsc(p.name)}</b><small>#${p.id} · ${p.hp == null ? 100 : p.hp} PV · ${p.kills || 0}/${p.deaths || 0} K/D</small></span>
      <span class="wzadm-playerflags">${p.admin ? "ADMIN" : ""}${p.muted ? " MUTE" : ""}</span><span class="wzadm-pickmark">${p.id === consoleSelectedPlayerId ? "✓" : "›"}</span></button>`).join("");
    return `<div class="wzadm-section"><div class="wzadm-sectionhead"><div><h3>Choisir un joueur</h3><p>Clique sur le joueur concerne dans la liste ci-dessous.</p></div><span class="wzadm-count">${players.length} en ligne</span></div>
      <div class="wzadm-playergrid">${cards || `<div class="wzadm-empty">Aucun joueur ne correspond a cette action.</div>`}</div></div>
      ${chosen ? `<div class="wzadm-selected"><div><small>JOUEUR SELECTIONNE</small><b>${consoleEsc(chosen.name)} <em>#${chosen.id}</em></b></div><span>${consoleStatus(!!chosen.admin,"ADMIN","JOUEUR")}</span></div>
      <div class="wzadm-formcard">${fieldsHtml}<div class="wzadm-actions">${consoleButton(actionLabel, page, danger ? "danger" : "primary", players.length ? "" : "disabled")}</div></div>` : `<div class="wzadm-hint">Selectionne un joueur pour afficher les options et confirmer l'action.</div>`}`;
  }
  function consolePageHeader(title, desc, icon="⌘") {
    return `<div class="wzadm-pagehead"><div class="wzadm-pageicon">${icon}</div><div><h2>${title}</h2><p>${desc}</p></div></div>`;
  }
  function consoleRenderPage() {
    const s = consoleSnapshot || {players:roster,bans:[],mutes:[],reminders:[],reports:[],cfg:cfgSrv,server:{}};
    const cfg = s.cfg || cfgSrv || {};
    const server = s.server || {};
    const players = s.players || roster;
    const menu = consoleMenu.find(x => x.id === consolePage);
    if (consolePage === "home") {
      const tiles = [
        ["JOUEURS", `${server.players == null ? roster.length : server.players}/${cfg.max || 16}`, "#42d6cc"],
        ["BANS", String(server.bans == null ? (s.bans||[]).length : server.bans), "#ff7272"],
        ["MUTES", String(server.mutes == null ? (s.mutes||[]).length : server.mutes), "#f0c36a"],
        ["DEGATS", `x${Number(cfg.dmg == null ? 1 : cfg.dmg).toFixed(2)}`, "#87a7ff"]
      ];
      const cards = consoleMenu.map(x => `<button class="wzadm-actioncard" type="button" data-nav="${x.id}"><span class="wzadm-cardnum">${x.n}</span><span class="wzadm-cardtext"><b>${x.title}</b><small>${x.desc}</small></span><span class="wzadm-cardarrow">›</span></button>`).join("");
      return `<div class="wzadm-welcome"><div><span class="wzadm-eyebrow">WARZONE RENDER V2 · ADMINISTRATION</span><h1>Centre de controle</h1><p>Choisis une action. Chaque outil ouvre sa propre page avec les joueurs, les listes et les confirmations necessaires.</p></div><div class="wzadm-serverpill">${consoleStatus(!cfg.locked,"SERVEUR OUVERT","SERVEUR VERROUILLE")}</div></div>
        <div class="wzadm-stats">${tiles.map(t => `<div class="wzadm-stat"><small>${t[0]}</small><b style="color:${t[2]}">${t[1]}</b></div>`).join("")}</div>
        <div class="wzadm-sectionhead"><div><h3>Toutes les commandes</h3><p>Les 24 fonctions de l'ancien menu serveur sont disponibles ici.</p></div>${consoleButton("Actualiser", "refresh", "subtle")}</div>
        <div class="wzadm-cardgrid">${cards}</div>`;
    }
    if (consolePage === "players") {
      const rows = players.slice().sort((a,b)=>a.id-b.id).map(p => { const flags=[p.admin?"ADMIN":"",p.god?"DIEU":"",p.vanish?"VANISH":"",p.ghost?"GHOST":"",p.freecam?"FREECAM":"",p.frozen?"FREEZE":"",p.muted?"MUTE":"",p.dead?"MORT":""].filter(Boolean); return `<tr><td>#${p.id}</td><td><b>${consoleEsc(p.name)}</b></td><td>${consoleEsc(p.ip || "-")}</td><td>${p.hp == null ? 100 : p.hp}</td><td>${p.kills||0} / ${p.deaths||0}</td><td>${flags.length ? flags.map(f=>`<span class="wzadm-mini-tag">${f}</span>`).join(" ") : "<span class='wzadm-status is-on'><i></i>EN LIGNE</span>"}</td></tr>`; }).join("");
      return consolePageHeader("Liste des joueurs", "Vue en direct des connexions, adresses IP et etats.", "♙") + `<div class="wzadm-tablewrap"><table class="wzadm-table"><thead><tr><th>ID</th><th>PSEUDO</th><th>ADRESSE IP</th><th>PV</th><th>K / D</th><th>ETAT / ROLES</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="wzadm-emptycell">Aucun joueur connecte.</td></tr>`}</tbody></table></div>${consoleButton("Actualiser la liste", "refresh", "subtle")}`;
    }
    if (consolePage === "limit") return consolePageHeader("Limite de joueurs", "Definis le nombre maximum de connexions simultanees.", "⇧") + `<div class="wzadm-formcard compact"><div class="wzadm-current">Limite actuelle <b>${cfg.max || 16}</b> joueurs · ${players.length} actuellement connecte(s)</div>${consoleField("Nouvelle limite (1 a 200)", "adm-value", cfg.max || 16, "number", "min=1 max=200 required")}${consoleButton("Appliquer la limite", "set_limit", "primary")}</div>`;
    if (consolePage === "ban" || consolePage === "kick" || consolePage === "promote" || consolePage === "demote" || consolePage === "mute" || consolePage === "rename") {
      const isBan = consolePage === "ban", isKick = consolePage === "kick", isPromote = consolePage === "promote", isDemote = consolePage === "demote", isMute = consolePage === "mute", isRename = consolePage === "rename";
      const title = isBan ? "Bannir un joueur" : isKick ? "Expulser un joueur" : isPromote ? "Promouvoir admin" : isDemote ? "Retirer les droits admin" : isMute ? "Mute un joueur" : "Renommer un joueur";
      const desc = isBan ? "Le joueur sera banni du serveur et ne pourra plus le rejoindre." : isKick ? "Le joueur sera immediatement deconnecte." : isPromote ? "Selectionne le joueur qui recevra les droits administrateur." : isDemote ? "Selectionne un admin en ligne pour lui retirer ses droits." : isMute ? "Le joueur ne pourra plus envoyer de messages dans le chat." : "Choisis un joueur puis indique son nouveau pseudo.";
      const action = isBan ? "ban_player" : isKick ? "kick_player" : isPromote ? "promote_admin" : isDemote ? "demote_admin" : isMute ? "mute_player" : "rename_player";
      const heading = consolePageHeader(title, desc, isPromote ? "★" : isBan ? "⊘" : isMute ? "◌" : isKick ? "↯" : "♙");
      let fields = "";
      if (isBan || isKick || isMute) fields += consoleTextArea("Motif (facultatif)", "adm-reason", "", "maxlength=180 rows=3 placeholder='Indique le motif…'");
      if (isRename) fields += consoleField("Nouveau pseudo (2 a 16 caracteres)", "adm-name", "", "text", "minlength=2 maxlength=16 required");
      const filter = isPromote ? p => !p.admin : isDemote ? p => !!p.admin : () => true;
      return heading + consolePlayerPick(filter, action, isPromote ? "Confirmer la promotion admin" : isDemote ? "Confirmer le retrait admin" : isBan ? "Confirmer le ban" : isKick ? "Confirmer l'expulsion" : isMute ? "Confirmer le mute" : "Confirmer le nouveau pseudo", fields, isBan || isKick || isMute);
    }
    if (consolePage === "unban") {
      const bans = s.bans || [];
      return consolePageHeader("Debannir", "Consulte la liste des sanctions et retire un ban individuellement.", "⊘") + `<div class="wzadm-list">${bans.map(b => `<div class="wzadm-listitem"><div><b>${consoleEsc(b.name)}</b><small>IP : ${consoleEsc(b.ip)} · ${consoleEsc(b.when)}</small>${b.reason ? `<p>${consoleEsc(b.reason)}</p>` : ""}</div>${consoleButton("Debannir", "unban_one", "subtle", `data-index="${b.index}"`)}</div>`).join("") || `<div class="wzadm-empty">Aucun joueur banni.</div>`}</div>${bans.length ? consoleButton("Retirer tous les bans", "unban_all", "danger") : ""}`;
    }
    if (consolePage === "message") return consolePageHeader("Message a tous", "Cette annonce sera affichee a tous les joueurs connectes.", "✉") + `<div class="wzadm-formcard">${consoleTextArea("Message du serveur (160 caracteres maximum)", "adm-text", "", "maxlength=160 rows=4 placeholder='Ton message…' required")}${consoleButton("Envoyer le message", "message_all", "primary")}</div>`;
    if (consolePage === "lock") return consolePageHeader("Verrouiller / ouvrir", "Le verrouillage bloque uniquement les nouvelles connexions.", "⌑") + `<div class="wzadm-statecard"><div><small>ETAT ACTUEL</small><h3>${cfg.locked ? "Serveur verrouille" : "Serveur ouvert"}</h3><p>${cfg.locked ? "Les nouveaux joueurs ne peuvent pas rejoindre." : "Les nouveaux joueurs peuvent rejoindre."}</p></div>${consoleStatus(!cfg.locked,"OUVERT","VERROUILLE")}</div>${consoleButton(cfg.locked ? "Ouvrir le serveur" : "Verrouiller le serveur", "toggle_lock", cfg.locked ? "primary" : "danger")}`;
    if (consolePage === "damage") return consolePageHeader("Degats des joueurs", "Regle le multiplicateur global de degats (de 0 a 10).", "⚔") + `<div class="wzadm-formcard compact"><div class="wzadm-current">Multiplicateur actuel <b>x${Number(cfg.dmg == null ? 1 : cfg.dmg).toFixed(2)}</b></div>${consoleField("Nouveau multiplicateur", "adm-value", cfg.dmg == null ? 1 : cfg.dmg, "number", "min=0 max=10 step=0.05 required")}${consoleButton("Appliquer les degats", "set_damage", "primary")}</div>`;
    if (consolePage === "reset") return consolePageHeader("Reset des scores", "Remet les kills et morts de tous les joueurs a zero.", "↻") + `<div class="wzadm-warning"><b>Attention : action globale</b><p>Cette action remet tous les scores K/D des joueurs actuellement connectes a zero. Elle ne peut pas etre annulee.</p></div>${consoleButton("Confirmer le reset des scores", "reset_scores", "danger")}`;
    if (consolePage === "info") {
      const events = (server.events || []).slice().reverse().map(e => `<div class="wzadm-event">${consoleEsc(e)}</div>`).join("");
      return consolePageHeader("Informations serveur", "Details de l'instance et derniers evenements enregistres.", "ⓘ") + `<div class="wzadm-infogrid"><div><small>NOM DU SERVEUR</small><b>${consoleEsc(server.name || serverDisplayName)}</b></div><div><small>INSTANCE</small><b>${consoleEsc(server.instance || "-")}</b></div><div><small>PORT</small><b>${server.port || "-"}</b></div><div><small>JOUEURS</small><b>${server.players == null ? roster.length : server.players} / ${cfg.max || 16}</b></div><div><small>RESEAU LOCAL</small><b>${consoleEsc(server.lan_ip || "-")}</b></div><div><small>ETAT</small><b>${cfg.locked ? "VERROUILLE" : "OUVERT"}</b></div><div><small>PVP / BOTS</small><b>${cfg.pvp ? "PVP ON" : "PVP OFF"} · ${cfg.bots ? "BOTS ON" : "BOTS OFF"}</b></div></div><div class="wzadm-formcard"><small class="wzadm-label">LIEN INTERNET</small><div class="wzadm-url">${consoleEsc(server.url ? server.url + "/autre/index.html" : (server.tunnel_state || "Lien indisponible"))}</div>${server.url ? `<button class="wzadm-btn subtle" type="button" data-copy-url="${consoleEsc(server.url + "/autre/index.html")}">Copier le lien</button>` : ""}<small class="wzadm-label" style="margin-top:12px">LIEN RESEAU LOCAL</small><div class="wzadm-url">http://${consoleEsc(server.lan_ip || "127.0.0.1")}:${server.port || 8000}/autre/index.html</div><small class="wzadm-label">LIEN SUR CETTE MACHINE</small><div class="wzadm-url">${consoleEsc(server.local_url || "-")}</div></div><div class="wzadm-section"><h3>Derniers evenements</h3><div class="wzadm-events">${events || `<div class="wzadm-empty">Aucun evenement recent.</div>`}</div></div>${consoleButton("Actualiser les informations", "refresh", "subtle")}`;
    }
    if (["pvp","bots","spawn"].includes(consolePage)) {
      const cfgKey = consolePage === "pvp" ? "pvp" : consolePage === "bots" ? "bots" : "spawn_allowed";
      const title = consolePage === "pvp" ? "Combat PVP" : consolePage === "bots" ? "Bots du serveur" : "Droit de spawn des joueurs";
      const desc = consolePage === "pvp" ? "Autorise ou interdit les degats entre joueurs." : consolePage === "bots" ? "Active ou desactive le systeme de bots." : "Autorise ou interdit aux joueurs non-admins de faire apparaitre des bots.";
      const value = !!cfg[cfgKey];
      const action = consolePage === "pvp" ? "toggle_pvp" : consolePage === "bots" ? "toggle_bots" : "toggle_spawn";
      return consolePageHeader(title, desc, "◉") + `<div class="wzadm-statecard"><div><small>ETAT ACTUEL</small><h3>${value ? "Active" : "Desactive"}</h3><p>${desc}</p></div>${consoleStatus(value,"ON","OFF")}</div>${consoleButton(value ? "Desactiver" : "Activer", action, value ? "danger" : "primary")}`;
    }
    if (consolePage === "killbots") return consolePageHeader("Supprimer tous les bots", "Elimine tous les bots qui sont actuellement presents dans la partie.", "✕") + `<div class="wzadm-warning"><b>Action immediate</b><p>Les bots seront tous supprimes. Les joueurs humains ne sont pas affectes.</p></div>${consoleButton("Confirmer : eliminer tous les bots", "kill_all_bots", "danger")}`;
    if (consolePage === "cooldown") return consolePageHeader("Delai de spawn des bots", "Delai applique aux joueurs non-admins avant un nouveau spawn (0 a 3600 secondes).", "◷") + `<div class="wzadm-formcard compact"><div class="wzadm-current">Delai actuel <b>${cfg.spawn_cooldown == null ? 15 : cfg.spawn_cooldown} s</b></div>${consoleField("Nouveau delai (secondes)", "adm-value", cfg.spawn_cooldown == null ? 15 : cfg.spawn_cooldown, "number", "min=0 max=3600 step=1 required")}${consoleButton("Appliquer le delai", "set_bot_cooldown", "primary")}</div>`;
    if (consolePage === "servername") return consolePageHeader("Renommer le serveur", "Le nouveau nom sera affiche dans le jeu pour tous les joueurs.", "✎") + `<div class="wzadm-formcard compact">${consoleField("Nom du serveur (3 a 48 caracteres)", "adm-name", server.name || serverDisplayName, "text", "minlength=3 maxlength=48 required pattern='[A-Za-z0-9 _.-]+'")}<p class="wzadm-help">Lettres, chiffres, espaces, points, tirets et underscores.</p>${consoleButton("Enregistrer le nom", "rename_server", "primary")}</div>`;
    if (consolePage === "banip") return consolePageHeader("Bannir une adresse IP", "Cette adresse sera bloquee meme si le joueur change de pseudo.", "⊘") + `<div class="wzadm-formcard">${consoleField("Adresse IP a bannir", "adm-ip", "", "text", "maxlength=64 required placeholder='Ex. 192.0.2.10'")}${consoleTextArea("Motif (facultatif)", "adm-reason", "", "maxlength=180 rows=3")}${consoleButton("Bannir cette adresse IP", "ban_ip", "danger")}</div>`;
    if (consolePage === "mutes") {
      const mutes = s.mutes || [];
      return consolePageHeader("Liste des joueurs mutes", "Consulte les sanctions de chat et retire-les quand necessaire.", "◌") + `<div class="wzadm-list">${mutes.map(m => `<div class="wzadm-listitem"><div><b>${consoleEsc(m.name)}</b><small>${consoleEsc(m.when)}</small>${m.reason ? `<p>${consoleEsc(m.reason)}</p>` : ""}</div>${consoleButton("Demuter", "unmute_one", "subtle", `data-index="${m.index}"`)}</div>`).join("") || `<div class="wzadm-empty">Aucun joueur mute.</div>`}</div>${mutes.length ? consoleButton("Retirer tous les mutes", "unmute_all", "danger") : ""}`;
    }
    if (consolePage === "reminders") {
      const reminders = s.reminders || [];
      const chosen = reminders.find(r => r.id === consoleSelectedReminderId);
      const list = reminders.map(r => `<div class="wzadm-listitem"><div><b>Rappel #${r.id} ${consoleStatus(r.active,"ACTIF","PAUSE")}</b><small>Toutes les ${r.interval} seconde(s)</small><p>${consoleEsc(r.text).replace(/\n/g,"<br>")}</p></div><div class="wzadm-rowbuttons">${consoleButton("Modifier", "select_reminder", "subtle", `data-id="${r.id}"`)}${consoleButton(r.active ? "Pause" : "Reprendre", "reminder_toggle", "subtle", `data-id="${r.id}"`)}${consoleButton("Supprimer", "reminder_delete", "danger-outline", `data-id="${r.id}"`)}</div></div>`).join("");
      return consolePageHeader("Rappels en jeu", "Les rappels sont affiches automatiquement a tous les joueurs selon leur intervalle.", "◷") + `<div class="wzadm-list">${list || `<div class="wzadm-empty">Aucun rappel configure pour le moment.</div>`}</div><div class="wzadm-formcard"><h3>${chosen ? `Modifier le rappel #${chosen.id}` : "Creer un rappel"}</h3>${consoleField("Intervalle en secondes (1 et plus)", "adm-interval", chosen ? chosen.interval : 60, "number", "min=1 max=9999999999 required")}${consoleTextArea("Texte affiche en jeu", "adm-text", chosen ? chosen.text : "", "maxlength=800 rows=4 required")}${chosen ? `<div class="wzadm-actions">${consoleButton("Enregistrer les modifications", "reminder_edit", "primary")}${consoleButton("Annuler la modification", "cancel_reminder_edit", "subtle")}</div>` : consoleButton("Creer le rappel", "reminder_add", "primary")}</div>`;
    }
    if (consolePage === "reports") {
      const reports = s.reports || [];
      return consolePageHeader("Signalements joueurs", "Lis les signalements envoyes par les joueurs et marque ceux qui sont traites.", "⚑") + `<div class="wzadm-list">${reports.slice().reverse().map(r => `<div class="wzadm-report"><div class="wzadm-reporttop"><b>#${r.id} · ${consoleEsc(r.from)} → ${consoleEsc(r.target)}</b>${consoleStatus(r.reviewed,"TRAITE","NOUVEAU")}</div><small>${consoleEsc(r.when)}</small><p>${consoleEsc(r.reason)}</p>${!r.reviewed ? consoleButton("Marquer comme traite", "report_review", "subtle", `data-id="${r.id}"`) : ""}</div>`).join("") || `<div class="wzadm-empty">Aucun signalement pour le moment.</div>`}</div>${reports.some(r=>!r.reviewed) ? consoleButton("Marquer tous comme traites", "report_review_all", "primary") : ""}`;
    }
    return `<div class="wzadm-empty">Page introuvable.</div>`;
  }
  function renderConsoleApp() {
    if (!consolePanel) return;
    const title = consolePage === "home" ? "Centre de controle" : (consoleMenu.find(x=>x.id===consolePage)||{}).title || "Administration";
    const crumbs = consolePage === "home" ? "ACCUEIL" : `ACCUEIL  /  ${title.toUpperCase()}`;
    const sideLinks = consoleGroups.map(group => `<div class="wzadm-navgroup"><small>${group.toUpperCase()}</small>${consoleMenu.filter(x=>x.group===group).map(x=>`<button type="button" data-nav="${x.id}" class="${consolePage===x.id?"active":""}"><span>${x.n}</span>${x.title}</button>`).join("")}</div>`).join("");
    const cfg = (consoleSnapshot && consoleSnapshot.cfg) || cfgSrv || {};
    const titleTarget = consolePanel.querySelector("#wzadm-title");
    if (titleTarget) titleTarget.textContent = title;
    consolePanel.querySelector("#wzadm-crumbs").textContent = crumbs;
    consolePanel.querySelector("#wzadm-nav").innerHTML = `<button class="wzadm-navhome ${consolePage==="home"?"active":""}" data-nav="home" type="button"><span>⌂</span>Vue generale</button>${sideLinks}`;
    consolePanel.querySelector("#wzadm-content").innerHTML = consoleRenderPage();
    const serverName = (consoleSnapshot && consoleSnapshot.server && consoleSnapshot.server.name) || serverDisplayName;
    consolePanel.querySelector("#wzadm-servername").textContent = serverName;
    consolePanel.querySelector("#wzadm-connectstate").textContent = online() ? "CONNECTE AU SERVEUR" : "DECONNECTE";
    consolePanel.querySelector("#wzadm-connectstate").classList.toggle("off", !online());
  }
  function consoleRead(id) { const el = consolePanel && consolePanel.querySelector("#" + id); return el ? el.value : ""; }
  function consoleDispatch(action, extra = {}) {
    if (action === "refresh") { consoleCall("snapshot"); return; }
    const selected = consoleSelectedPlayerId;
    if (["ban_player","kick_player","promote_admin","demote_admin","mute_player","rename_player"].includes(action) && selected == null) { notify("Selectionne d'abord un joueur."); return; }
    const d = Object.assign({}, extra);
    if (["ban_player","kick_player","mute_player"].includes(action)) d.reason = consoleRead("adm-reason");
    if (action === "rename_player") d.name = consoleRead("adm-name");
    if (["set_limit","set_damage","set_bot_cooldown"].includes(action)) d.value = consoleRead("adm-value");
    if (action === "message_all") d.text = consoleRead("adm-text");
    if (action === "rename_server") d.name = consoleRead("adm-name");
    if (action === "ban_ip") { d.ip = consoleRead("adm-ip"); d.reason = consoleRead("adm-reason"); }
    if (action === "reminder_add" || action === "reminder_edit") {
      d.interval = consoleRead("adm-interval"); d.text = consoleRead("adm-text");
      if (action === "reminder_edit") d.id = consoleSelectedReminderId;
    }
    if (["ban_player","kick_player","promote_admin","demote_admin","mute_player","rename_player"].includes(action)) d.id = selected;
    if (action === "report_review_all") d.id = "all";
    consoleCall(action === "report_review_all" ? "report_review" : action, d);
  }
  function buildGameConsole() {
    if (consolePanel) return;
    const style = document.createElement("style");
    style.textContent = `
      #wz-console-toggle{position:fixed;right:18px;bottom:170px;z-index:130;width:46px;height:42px;border:1px solid #555;border-radius:6px;background:#202020;color:#eee;font:700 16px Consolas,monospace;box-shadow:0 4px 18px #000a;cursor:pointer;display:none}
      #wz-console-toggle:hover{background:#333;border-color:#00e5a0}
      #wz-console{position:fixed;z-index:150;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1120px,94vw);height:min(760px,90vh);min-width:650px;min-height:450px;display:none;flex-direction:column;resize:both;overflow:hidden;background:#101416;color:#e5eeee;border:1px solid #374247;border-radius:9px;box-shadow:0 24px 90px #000d;font:13px/1.45 'Segoe UI',Arial,sans-serif}
      #wz-console *{box-sizing:border-box}#wz-console button,#wz-console input,#wz-console textarea{font:inherit}
      #wz-console.wzadm-max{left:8px!important;top:8px!important;transform:none!important;width:calc(100vw - 16px)!important;height:calc(100vh - 16px)!important;resize:none!important}
      #wz-console .wzadm-titlebar{height:42px;flex:0 0 42px;display:flex;align-items:center;background:#171d20;border-bottom:1px solid #293337;user-select:none;touch-action:none;cursor:move}
      #wz-console .wzadm-appmark{width:42px;text-align:center;color:#55e0b1;font:bold 15px Consolas,monospace}#wz-console .wzadm-titletext{font-size:12px;color:#e5eded;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #wz-console .wzadm-titlehint{color:#829095;font-size:11px;margin-left:10px}#wz-console .wzadm-titlegrow{flex:1}
      #wz-console .wzadm-winbtn{width:44px;height:42px;border:0;background:transparent;color:#cbd3d5;cursor:pointer}#wz-console .wzadm-winbtn:hover{background:#30393d}#wz-console .wzadm-winbtn.close:hover{background:#bd3434;color:white}
      #wz-console .wzadm-body{display:flex;min-height:0;flex:1;background:#101719}
      #wz-console .wzadm-sidebar{width:238px;flex:0 0 238px;overflow:auto;padding:14px 10px;background:#141c20;border-right:1px solid #283438}
      #wz-console .wzadm-brand{padding:4px 9px 14px;border-bottom:1px solid #29363a;margin-bottom:12px}.wzadm-brand b{display:block;color:#57e1b1;font-size:13px;letter-spacing:2px}.wzadm-brand small{display:block;color:#829196;margin-top:3px;font-size:10px}
      #wz-console .wzadm-navhome,#wz-console .wzadm-navgroup button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 8px;margin:1px 0;border:0;border-radius:5px;background:transparent;color:#b8c5c7;font-size:11px;cursor:pointer}
      #wz-console .wzadm-navhome span{font-size:15px;width:18px;text-align:center;color:#68d9b4}#wz-console .wzadm-navhome:hover,#wz-console .wzadm-navgroup button:hover{background:#202d31;color:white}
      #wz-console .wzadm-navhome.active,#wz-console .wzadm-navgroup button.active{background:#203a36;color:#8af0c7}#wz-console .wzadm-navgroup{margin-top:13px}#wz-console .wzadm-navgroup>small{display:block;padding:0 8px 5px;color:#63777c;font-size:9px;letter-spacing:1.2px;font-weight:700}
      #wz-console .wzadm-navgroup button span{width:21px;color:#7e9699;font:10px Consolas,monospace}
      #wz-console .wzadm-main{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;background:#0d1315}
      #wz-console .wzadm-topline{height:52px;flex:0 0 52px;padding:0 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #263236;background:#11191c}
      #wz-console .wzadm-crumbs{font:10px Consolas,monospace;color:#72868a;letter-spacing:.8px}#wz-console .wzadm-crumbs b{color:#b4c5c8}
      #wz-console .wzadm-connect{font-size:9px;letter-spacing:1px;color:#64d5a8}#wz-console .wzadm-connect:before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:#4bd59b;margin-right:7px}#wz-console .wzadm-connect.off{color:#ef8585}#wz-console .wzadm-connect.off:before{background:#ef6565}
      #wz-console .wzadm-content{flex:1;overflow:auto;min-height:0;padding:22px 26px 30px;scrollbar-color:#3b5054 #121a1d;scrollbar-width:thin}
      #wz-console .wzadm-pagehead{display:flex;align-items:center;gap:14px;margin-bottom:21px}#wz-console .wzadm-pageicon{width:42px;height:42px;border:1px solid #31544a;border-radius:9px;display:grid;place-items:center;color:#72e1b7;background:#18302b;font-size:20px}
      #wz-console h1,#wz-console h2,#wz-console h3,#wz-console p{margin:0}#wz-console .wzadm-pagehead h2{font-size:20px;color:#eff8f6;font-weight:650}#wz-console .wzadm-pagehead p{font-size:11px;color:#829397;margin-top:4px}
      #wz-console .wzadm-welcome{display:flex;justify-content:space-between;gap:15px;align-items:flex-start;margin-bottom:20px}#wz-console .wzadm-eyebrow{color:#5bd4a8;letter-spacing:1.7px;font:10px Consolas,monospace}#wz-console .wzadm-welcome h1{font-size:26px;letter-spacing:-.5px;margin:5px 0;color:#f2f7f5}#wz-console .wzadm-welcome p{max-width:640px;color:#87989b;font-size:12px}#wz-console .wzadm-serverpill{padding-top:9px}
      #wz-console .wzadm-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:18px 0 25px}#wz-console .wzadm-stat{background:#151f22;border:1px solid #2b393d;border-radius:7px;padding:13px 15px}#wz-console .wzadm-stat small{display:block;color:#809196;font-size:9px;letter-spacing:1.1px}#wz-console .wzadm-stat b{display:block;font:22px Consolas,monospace;margin-top:7px}
      #wz-console .wzadm-sectionhead{display:flex;align-items:center;justify-content:space-between;margin:5px 0 12px}#wz-console .wzadm-sectionhead h3,#wz-console .wzadm-section h3{font-size:13px;color:#dce8e6}#wz-console .wzadm-sectionhead p{font-size:10px;color:#7c8f92;margin-top:3px}
      #wz-console .wzadm-cardgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}#wz-console .wzadm-actioncard{display:flex;align-items:center;min-width:0;text-align:left;padding:12px 13px;background:#141d20;border:1px solid #29383c;border-radius:6px;color:#e4eeeb;cursor:pointer;gap:12px;transition:.12s}
      #wz-console .wzadm-actioncard:hover{border-color:#4f9f82;background:#1a2928;transform:translateY(-1px)}#wz-console .wzadm-cardnum{color:#63d6a7;font:11px Consolas,monospace;border:1px solid #31544a;border-radius:4px;padding:4px 5px}
      #wz-console .wzadm-cardtext{flex:1;min-width:0}#wz-console .wzadm-cardtext b{display:block;font-size:11px;font-weight:650}#wz-console .wzadm-cardtext small{display:block;color:#819194;font-size:9px;margin-top:3px;line-height:1.35}#wz-console .wzadm-cardarrow{color:#6ebd9f;font-size:20px}
      #wz-console .wzadm-status{display:inline-flex;align-items:center;gap:6px;font:9px Consolas,monospace;letter-spacing:.5px;white-space:nowrap;color:#899b9e}#wz-console .wzadm-status i{width:6px;height:6px;border-radius:50%;background:#8b9698}#wz-console .wzadm-status.is-on{color:#74dcad}#wz-console .wzadm-status.is-on i{background:#4bd79c;box-shadow:0 0 8px #36b88477}#wz-console .wzadm-status.is-off{color:#ef8585}#wz-console .wzadm-status.is-off i{background:#ee6969}
      #wz-console .wzadm-btn{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:7px 13px;border-radius:5px;border:1px solid #3a514e;background:#1b2b2b;color:#dceae6;font-size:11px;font-weight:600;cursor:pointer;margin:0 6px 0 0}#wz-console .wzadm-btn:hover{filter:brightness(1.17);border-color:#6ba88f}#wz-console .wzadm-btn.primary{background:#1e5846;border-color:#337f64;color:#ddfff0}#wz-console .wzadm-btn.danger{background:#642c30;border-color:#9b454b;color:#ffe3e3}#wz-console .wzadm-btn.danger-outline{background:transparent;border-color:#724248;color:#f29a9c}#wz-console .wzadm-btn.subtle{background:#172124;border-color:#34464a;color:#b9c9c8}
      #wz-console .wzadm-formcard{margin-top:16px;padding:17px;background:#141e21;border:1px solid #2d3d41;border-radius:7px;max-width:660px}#wz-console .wzadm-formcard.compact{max-width:480px}#wz-console .wzadm-formcard h3{font-size:13px;margin-bottom:14px;color:#e4eeeb}
      #wz-console .wzadm-field{display:block;margin:0 0 13px}#wz-console .wzadm-field>span,#wz-console .wzadm-label{display:block;color:#9aabad;font-size:10px;margin-bottom:6px}#wz-console .wzadm-field input,#wz-console .wzadm-field textarea{display:block;width:100%;background:#0b1214;color:#e5efec;border:1px solid #3a4b4f;border-radius:5px;padding:9px 10px;outline:none;font-size:12px}#wz-console .wzadm-field textarea{resize:vertical;min-height:75px}#wz-console .wzadm-field input:focus,#wz-console .wzadm-field textarea:focus{border-color:#58b28d;box-shadow:0 0 0 2px #4cb78820}
      #wz-console .wzadm-current{font-size:11px;color:#8da0a2;margin-bottom:14px}#wz-console .wzadm-current b{color:#e5f6ef;font:17px Consolas,monospace;margin-left:8px}#wz-console .wzadm-help{font-size:10px;color:#809194;margin:-4px 0 13px}
      #wz-console .wzadm-actions{display:flex;gap:8px;flex-wrap:wrap}#wz-console .wzadm-hint{padding:14px;margin-top:14px;border:1px dashed #34464a;border-radius:6px;color:#829497;font-size:11px}
      #wz-console .wzadm-playergrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}#wz-console .wzadm-playerpick{display:flex;align-items:center;gap:9px;min-width:0;padding:9px;background:#141e21;border:1px solid #2e3e42;border-radius:6px;color:#e5eeea;text-align:left;cursor:pointer}#wz-console .wzadm-playerpick:hover{border-color:#528d76}#wz-console .wzadm-playerpick.selected{border-color:#59c99a;background:#18332b}
      #wz-console .wzadm-avatar{display:grid;place-items:center;width:31px;height:31px;border-radius:50%;background:#243b3d;color:#95e3c0;font-weight:700}#wz-console .wzadm-playertext{flex:1;min-width:0}#wz-console .wzadm-playertext b{display:block;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#wz-console .wzadm-playertext small{display:block;color:#829598;font-size:9px;margin-top:2px}#wz-console .wzadm-playerflags{color:#e6c96f;font-size:8px}#wz-console .wzadm-pickmark{color:#6bdba9;font-size:16px}
      #wz-console .wzadm-selected{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:14px;padding:12px 14px;background:#1b342e;border:1px solid #3d745c;border-radius:6px}#wz-console .wzadm-selected small{display:block;color:#82b49d;font-size:8px;letter-spacing:1px}#wz-console .wzadm-selected b{display:block;color:#edfff5;font-size:13px;margin-top:4px}#wz-console .wzadm-selected em{font-style:normal;color:#91b2a4;font:10px Consolas,monospace}
      #wz-console .wzadm-count{color:#8da1a2;font-size:10px}.wzadm-tablewrap{overflow:auto;border:1px solid #2b3a3d;border-radius:7px;margin-bottom:12px}#wz-console .wzadm-table{width:100%;border-collapse:collapse;min-width:620px;font-size:10px}#wz-console .wzadm-table th{text-align:left;padding:10px;background:#192427;color:#8da2a1;font-size:9px;letter-spacing:.6px}#wz-console .wzadm-table td{padding:10px;border-top:1px solid #283639;color:#cbd8d4}#wz-console .wzadm-table tr:hover td{background:#162326}#wz-console .wzadm-mini-tag{font:8px Consolas,monospace;color:#e7ce7a;background:#443a21;border-radius:3px;padding:2px 4px}
      #wz-console .wzadm-list{display:flex;flex-direction:column;gap:7px;max-width:800px}#wz-console .wzadm-listitem,#wz-console .wzadm-report{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 14px;background:#141e21;border:1px solid #2b3b3e;border-radius:6px}#wz-console .wzadm-listitem>div:first-child{min-width:0;flex:1}#wz-console .wzadm-listitem b{display:block;font-size:11px;color:#e2eeea}#wz-console .wzadm-listitem small{display:block;font-size:9px;color:#87999b;margin-top:3px}#wz-console .wzadm-listitem p{font-size:10px;color:#a9b8b5;margin-top:5px;overflow-wrap:anywhere}#wz-console .wzadm-rowbuttons{display:flex;gap:4px;flex-wrap:wrap}
      #wz-console .wzadm-warning{max-width:650px;border:1px solid #875044;border-left:3px solid #e08d55;background:#2b211d;border-radius:5px;padding:14px 16px;margin:12px 0 16px}#wz-console .wzadm-warning b{color:#ffc08d;font-size:12px}#wz-console .wzadm-warning p{color:#c8a994;font-size:11px;margin-top:5px}
      #wz-console .wzadm-statecard{display:flex;align-items:center;justify-content:space-between;gap:15px;max-width:650px;padding:17px;background:#151f22;border:1px solid #2b3b3e;border-radius:7px;margin:12px 0 15px}#wz-console .wzadm-statecard small{font-size:9px;color:#7e9294;letter-spacing:1px}#wz-console .wzadm-statecard h3{font-size:16px;margin:5px 0;color:#ecf6f2}#wz-console .wzadm-statecard p{font-size:10px;color:#819294}
      #wz-console .wzadm-infogrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:15px}#wz-console .wzadm-infogrid>div{padding:12px;background:#152024;border:1px solid #2a3a3e;border-radius:6px}#wz-console .wzadm-infogrid small{display:block;color:#819497;font-size:8px;letter-spacing:.8px}#wz-console .wzadm-infogrid b{display:block;color:#dce9e4;font-size:12px;margin-top:5px;overflow-wrap:anywhere}
      #wz-console .wzadm-url{font:11px Consolas,monospace;color:#80e4ba;padding:9px;background:#0b1315;border:1px solid #2b3d3e;border-radius:5px;overflow-wrap:anywhere;margin-bottom:9px}#wz-console .wzadm-section{margin-top:18px}#wz-console .wzadm-events{margin-top:8px;max-height:190px;overflow:auto;background:#10181b;border:1px solid #29383c;border-radius:6px;padding:7px}#wz-console .wzadm-event{padding:5px 6px;border-bottom:1px solid #233236;color:#8fa4a3;font:9px Consolas,monospace}#wz-console .wzadm-event:last-child{border:0}
      #wz-console .wzadm-report{display:block}#wz-console .wzadm-reporttop{display:flex;justify-content:space-between;gap:12px;align-items:center}#wz-console .wzadm-report b{font-size:11px;color:#e2eeea}#wz-console .wzadm-report small{display:block;color:#829598;margin:5px 0;font-size:9px}#wz-console .wzadm-report p{font-size:11px;color:#becbc7;margin-bottom:9px}
      #wz-console .wzadm-empty{padding:18px;text-align:center;color:#7f9295;font-size:11px;background:#141d20;border:1px dashed #334448;border-radius:6px}#wz-console .wzadm-emptycell{text-align:center!important;padding:22px!important;color:#839598!important}
      #wz-console .wzadm-foot{height:25px;flex:0 0 25px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#151e21;border-top:1px solid #293639;color:#697d80;font:9px Consolas,monospace}
      #wz-console.wzadm-waiting .wzadm-connect:after{content:' · synchro…';color:#e1c16d}
      @media(max-width:850px){#wz-console{min-width:0;width:96vw;height:92vh}#wz-console .wzadm-sidebar{width:185px;flex-basis:185px}#wz-console .wzadm-content{padding:16px}#wz-console .wzadm-cardgrid{grid-template-columns:1fr}}
      @media(max-width:620px){#wz-console .wzadm-sidebar{width:54px;flex-basis:54px;padding:8px 5px}#wz-console .wzadm-brand b{font-size:0}#wz-console .wzadm-brand b:after{content:'WZ';font-size:12px}#wz-console .wzadm-brand small,#wz-console .wzadm-navgroup>small{display:none}#wz-console .wzadm-navgroup button{font-size:0;justify-content:center;padding:8px 0}#wz-console .wzadm-navgroup button span{font-size:10px;width:auto}#wz-console .wzadm-navhome{font-size:0;justify-content:center}#wz-console .wzadm-navhome span{font-size:15px}#wz-console .wzadm-playergrid,#wz-console .wzadm-stats{grid-template-columns:repeat(2,minmax(0,1fr))}#wz-console .wzadm-infogrid{grid-template-columns:repeat(2,minmax(0,1fr))}#wz-console .wzadm-titlehint{display:none}}
    `;
    document.head.appendChild(style);
    consoleToggle = document.createElement("button");
    consoleToggle.id = "wz-console-toggle"; consoleToggle.type = "button"; consoleToggle.title = "Ouvrir le centre d'administration"; consoleToggle.textContent = ">_";
    consoleToggle.addEventListener("click", () => toggleGameConsole(true));
    ["keydown","keyup","mousedown","mouseup","mousemove","pointerdown","pointermove","pointerup"].forEach(type=>consoleToggle.addEventListener(type,e=>e.stopPropagation()));
    document.body.appendChild(consoleToggle);
    consolePanel = document.createElement("section"); consolePanel.id = "wz-console"; consolePanel.className = "wzui";
    consolePanel.innerHTML = `<div class="wzadm-titlebar" id="wzadm-titlebar"><div class="wzadm-appmark">&gt;_</div><span class="wzadm-titletext">WARZONE RENDER V2 - Administration</span><span class="wzadm-titlehint">console serveur integree</span><span class="wzadm-titlegrow"></span><button type="button" class="wzadm-winbtn" id="wzadm-min" title="Reduire">—</button><button type="button" class="wzadm-winbtn" id="wzadm-max" title="Agrandir">□</button><button type="button" class="wzadm-winbtn close" id="wzadm-close" title="Fermer">×</button></div>
      <div class="wzadm-body"><aside class="wzadm-sidebar"><div class="wzadm-brand"><b>WARZONE RENDER V2</b><small id="wzadm-servername">Administration du serveur</small></div><nav id="wzadm-nav"></nav></aside><main class="wzadm-main"><div class="wzadm-topline"><div class="wzadm-crumbs" id="wzadm-crumbs">ACCUEIL</div><div class="wzadm-connect" id="wzadm-connectstate">CONNECTE AU SERVEUR</div></div><div class="wzadm-content" id="wzadm-content"></div></main></div><div class="wzadm-foot"><span>WARZONE RENDER V2 · MENU ADMINISTRATEUR</span><span>F10 AFFICHER / MASQUER · ECHAP FERMER</span></div>`;
    document.body.appendChild(consolePanel);
    const hide=()=>toggleGameConsole(false);
    consolePanel.querySelector("#wzadm-close").addEventListener("click",hide);
    consolePanel.querySelector("#wzadm-min").addEventListener("click",hide);
    const maxBtn=consolePanel.querySelector("#wzadm-max");
    maxBtn.addEventListener("click",()=>{
      if(!consolePanel.classList.contains("wzadm-max")){const r=consolePanel.getBoundingClientRect();consoleRestoreRect={left:r.left,top:r.top,width:r.width,height:r.height};consolePanel.classList.add("wzadm-max");maxBtn.textContent="❐";}
      else{consolePanel.classList.remove("wzadm-max");if(consoleRestoreRect){Object.assign(consolePanel.style,{left:consoleRestoreRect.left+"px",top:consoleRestoreRect.top+"px",width:consoleRestoreRect.width+"px",height:consoleRestoreRect.height+"px",transform:"none"});}maxBtn.textContent="□";}
    });
    const titlebar=consolePanel.querySelector("#wzadm-titlebar");let drag=null;
    titlebar.addEventListener("pointerdown",e=>{if(e.button!==0||e.target.closest("button")||consolePanel.classList.contains("wzadm-max"))return;const r=consolePanel.getBoundingClientRect();consolePanel.style.transform="none";consolePanel.style.left=r.left+"px";consolePanel.style.top=r.top+"px";drag={x:e.clientX,y:e.clientY,left:r.left,top:r.top,id:e.pointerId};try{titlebar.setPointerCapture(e.pointerId);}catch(_){ }e.preventDefault();});
    titlebar.addEventListener("pointermove",e=>{if(!drag||e.pointerId!==drag.id)return;const left=Math.max(0,Math.min(window.innerWidth-consolePanel.offsetWidth,drag.left+e.clientX-drag.x));const top=Math.max(0,Math.min(window.innerHeight-42,drag.top+e.clientY-drag.y));consolePanel.style.left=left+"px";consolePanel.style.top=top+"px";});
    const stopDrag=e=>{if(drag&&(!e||e.pointerId===drag.id))drag=null;};titlebar.addEventListener("pointerup",stopDrag);titlebar.addEventListener("pointercancel",stopDrag);titlebar.addEventListener("dblclick",e=>{if(!e.target.closest("button"))maxBtn.click();});
    // Delegation sur toute la fenetre : les liens de navigation sont dans la barre laterale, pas dans le contenu.
    consolePanel.addEventListener("click",e=>{
      const nav=e.target.closest("[data-nav]");if(nav){consoleSetPage(nav.dataset.nav);return;}
      const pick=e.target.closest("[data-pick-player]");if(pick){consoleSelectedPlayerId=Number(pick.dataset.pickPlayer);renderConsoleApp();return;}
      const copy=e.target.closest("[data-copy-url]");if(copy){try{navigator.clipboard.writeText(copy.dataset.copyUrl);notify("Lien copie.");}catch(_){notify(copy.dataset.copyUrl);}return;}
      const btn=e.target.closest("[data-submit]");if(!btn)return;
      const action=btn.dataset.submit;
      if(action==="select_reminder"){consoleSelectedReminderId=Number(btn.dataset.id);renderConsoleApp();return;}
      if(action==="cancel_reminder_edit"){consoleSelectedReminderId=null;renderConsoleApp();return;}
      if(action==="unban_one"){consoleDispatch(action,{index:Number(btn.dataset.index)});return;}
      if(action==="unmute_one"){consoleDispatch(action,{index:Number(btn.dataset.index)});return;}
      if(action==="report_review"){consoleDispatch(action,{id:btn.dataset.id});return;}
      if(action==="reminder_toggle"||action==="reminder_delete"){const id=Number(btn.dataset.id);if(action==="reminder_delete"&&!confirm("Supprimer definitivement ce rappel ?"))return;consoleDispatch(action,{id});return;}
      if(["unban_all","unmute_all","reset_scores","kill_all_bots","ban_ip","ban_player","kick_player","promote_admin","demote_admin","mute_player"].includes(action)){
        const msg={unban_all:"Retirer tous les bans ?",unmute_all:"Retirer tous les mutes ?",reset_scores:"Remettre tous les scores a zero ?",kill_all_bots:"Supprimer tous les bots ?",ban_ip:"Confirmer le ban de cette adresse IP ?",ban_player:"Confirmer le ban de ce joueur ?",kick_player:"Expulser ce joueur ?",promote_admin:"Donner les droits admin a ce joueur ?",demote_admin:"Retirer les droits admin de ce joueur ?",mute_player:"Muter ce joueur ?"}[action];
        if(!confirm(msg))return;
      }
      consoleDispatch(action);
    });
    ["keydown","keyup","mousedown","mouseup","mousemove","wheel","pointerdown","pointermove","pointerup","pointercancel","touchstart","touchmove"].forEach(type=>consolePanel.addEventListener(type,e=>e.stopPropagation()));
    renderConsoleApp();
  }
  function toggleGameConsole(open) {
    if (!consoleAuthenticated) return;
    buildGameConsole(); consoleOpen=!!open;
    consolePanel.style.display=consoleOpen?"flex":"none";consoleToggle.style.display=consoleOpen?"none":"block";
    if(consoleOpen){try{document.exitPointerLock();}catch(_){ }if(instr)instr.style.display="none";renderConsoleApp();consoleCall("snapshot");}
    else if(!isDead&&!chatOpen&&!panelOpen){if(instr)instr.style.display="block";}
  }
  function onConsoleAuthResult(m) {
    if(!m.ok){notify(m.msg||"Authentification CMD refusee.");return;}
    consoleAuthenticated=true;consolePage="home";consoleSnapshot=null;buildGameConsole();consoleToggle.style.display="block";toggleGameConsole(true);
  }
  function onConsoleUiResult(m) {
    consoleBusy=false;if(consolePanel)consolePanel.classList.remove("wzadm-waiting");
    if(!m.ok){notify(m.message||"Action refusee.");return;}
    if(m.snapshot)consoleSnapshot=m.snapshot;
    if(m.message)notify(m.message);
    if(consolePanel&&consoleOpen)renderConsoleApp();
  }

  const panel = document.createElement("div"); panel.id = "wzpanel"; panel.className = "wzui"; document.body.appendChild(panel);
  ["keydown", "keyup", "mousedown", "mouseup", "mousemove", "wheel"].forEach(t => panel.addEventListener(t, e => e.stopPropagation()));
  function togglePanel(open) {
    panelOpen = open; panel.style.display = open ? "block" : "none";
    clearInterval(pollT);
    if (open) { try { document.exitPointerLock(); } catch (e) {} send({ t: "admin", cmd: "list" }); pollT = setInterval(() => send({ t: "admin", cmd: "list" }), 1200); renderPanel(true); }
    else if (!isDead) { try { document.body.requestPointerLock(); } catch (e) {} }
  }
  const adm = (o) => send(Object.assign({ t: "admin" }, o));
  let panelBuilt = false;
  function renderPanel(force) {
    if (!panelBuilt || force && !panel.querySelector("#wzlist")) {
      panelBuilt = true;
      panel.innerHTML = `<b style="color:#00ff88;font-size:14px">CONSOLE ADMIN SERVEUR</b> <span style="color:#789">(N / Echap = fermer)</span>
<h4>JOUEURS (clique pour selectionner)</h4><div id="wzlist"></div><div id="wzsel" style="margin:4px 0;color:#ff8"></div>
<h4>ACTIONS SUR LE JOUEUR SELECTIONNE</h4><div id="wzacts"></div>
<div>Give : <select id="wzitem"><option value="ammo">Munitions</option><option value="plate">Plaques</option><option value="stim">Stimulants</option><option value="weapon">Arme</option><option value="health">Sante</option><option value="kit">Kit complet</option></select>
Quantite <input id="wzgiveamount" type="number" min="1" max="9999" step="1" value="1" style="width:58px">
<button data-a="give">Donner au joueur</button><button data-a="give_all">A tous</button></div>
<h4>TOUS LES JOUEURS</h4><div><button data-a="bring_all">Bring tous (Base Admin)</button><button data-a="heal_all">Soigner tous</button><button data-a="freeze_all">Freeze tous</button><button data-a="unfreeze_all">Unfreeze tous</button><button data-a="launch_all">Lancer tous</button></div>
<h4>PARAMETRES SERVEUR EN DIRECT</h4>
<div><button data-a="pvp_toggle" id="wzpvp"></button><button data-a="bots_toggle" id="wzbots"></button><button data-a="spawn_toggle" id="wzspawn"></button></div>
<div><button data-a="spawn_bot">Spawn 1 bot</button><button data-a="kill_bots" class="red">Kill all bots</button><button data-a="reset_scores">Reset scores</button></div>
<div style="margin-top:5px">Limite bots <input id="wzbotlimit" type="number" min="0" max="64" value="12" style="width:48px"><button data-a="bot_limit">Appliquer</button>
Degats bots <input id="wzbotdmg" type="number" min="0" max="50" step="1" value="10" style="width:48px"><button data-a="bot_damage">Appliquer</button>
Delai spawn non-admin (s) <input id="wzbotcooldown" type="number" min="0" max="3600" value="15" style="width:54px"><button data-a="bot_cooldown">Appliquer</button></div>
<h4>RESSOURCES</h4><div><button data-a="resource_reset" class="red">Reset synchronise (redemarrage 10 sec)</button></div>
<h4>MOI</h4><div><button data-a="god_me" id="wzgod"></button><button data-a="flip" id="wzflip"></button></div>
`;
      panel.addEventListener("click", onPanelClick);
    }
    const list = panel.querySelector("#wzlist");
    list.innerHTML = roster.slice().sort((a, b) => a.id - b.id).map(p => `<div class="wzrow${p.id === selected ? " sel" : ""}" data-id="${p.id}">${String(p.id).padStart(2)}  ${nm(p.name, p.admin)}${' '.repeat(Math.max(1, 17 - p.name.length))}PV${String(p.hp).padStart(3)}  K${p.kills}/D${p.deaths} ${p.dead ? "MORT " : ""}${p.god ? "DIEU " : ""}${p.frozen ? "FREEZE " : ""}${p.id === myId ? " (moi)" : ""}</div>`).join("") || "<i>aucun joueur</i>";
    const sp = roster.find(p => p.id === selected);
    panel.querySelector("#wzsel").textContent = sp ? "Selection : #" + sp.id + " " + sp.name : "Selectionne un joueur dans la liste";
    const acts = panel.querySelector("#wzacts");
    if (!acts.dataset.built) {
      acts.dataset.built = 1;
      acts.innerHTML = [["bring", "Bring (Base Admin)", ""], ["goto", "TP (vers lui)", ""], ["heal", "Soigner", "grn"], ["kill", "Tuer", "red"], ["revive", "Reanimer", ""], ["freeze", "Freeze", ""], ["unfreeze", "Unfreeze", ""], ["god", "Dieu ON", ""], ["ungod", "Dieu OFF", ""], ["launch", "Lancer", ""]]
        .map(a => `<button class="${a[2]}" data-a="${a[0]}">${a[1]}</button>`).join("");
    }
    const mine = roster.find(p => p.id === myId);
    panel.querySelector("#wzgod").textContent = "Mode Dieu : " + (mine && mine.god ? "ON" : "OFF");
    panel.querySelector("#wzflip").textContent = "Inverser skins : " + (flip ? "ON" : "OFF");
    panel.querySelector("#wzpvp").textContent = "PVP : " + (cfgSrv.pvp === false ? "OFF" : "ON");
    panel.querySelector("#wzbots").textContent = "Bots : " + (cfgSrv.bots === false ? "OFF" : "ON");
    panel.querySelector("#wzspawn").textContent = "Spawn joueurs : " + (cfgSrv.spawn_allowed === false ? "OFF" : "ON");
    panel.querySelector("#wzbotlimit").value = cfgSrv.max_bots == null ? 12 : cfgSrv.max_bots;
    panel.querySelector("#wzbotdmg").value = cfgSrv.bot_damage == null ? 10 : cfgSrv.bot_damage;
    panel.querySelector("#wzbotcooldown").value = cfgSrv.spawn_cooldown == null ? 15 : cfgSrv.spawn_cooldown;
  }
  function onPanelClick(e) {
    const row = e.target.closest(".wzrow"); if (row) { selected = +row.dataset.id; renderPanel(); return; }
    const btn = e.target.closest("button"); if (!btn) return;
    const a = btn.dataset.a, id = selected, item = panel.querySelector("#wzitem").value;
    const giveAmount = Math.max(1, Math.min(9999, Math.floor(Number(panel.querySelector("#wzgiveamount").value) || 1)));
    const needSel = ["bring", "goto", "heal", "kill", "revive", "freeze", "unfreeze", "god", "ungod", "launch", "give"];
    if (needSel.includes(a) && id == null) { notify("Selectionne d'abord un joueur"); return; }
    if (a === "freeze" || a === "unfreeze") adm({ cmd: "freeze", id, on: a === "freeze" });
    else if (a === "god" || a === "ungod") adm({ cmd: "god", id, on: a === "god" });
    else if (a === "give") adm({ cmd: "give", id, item, amount: giveAmount });
    else if (a === "give_all") adm({ cmd: "give", id: "all", item, amount: giveAmount });
    else if (a === "bring_all") adm({ cmd: "bring", id: "all" });
    else if (a === "heal_all") adm({ cmd: "heal", id: "all" });
    else if (a === "launch_all") adm({ cmd: "launch", id: "all" });
    else if (a === "freeze_all" || a === "unfreeze_all") adm({ cmd: "freeze", id: "all", on: a === "freeze_all" });
    else if (a === "god_me") { const mine = roster.find(p => p.id === myId); adm({ cmd: "god", id: myId, on: !(mine && mine.god) }); }
    else if (a === "flip") { flip = !flip; LS("wz_flip", flip ? "1" : "0"); applyFlip(); renderPanel(); }
    else if (a === "pvp_toggle") adm({ cmd: "pvp", on: cfgSrv.pvp === false });
    else if (a === "bots_toggle") adm({ cmd: "bots", on: cfgSrv.bots === false });
    else if (a === "spawn_toggle") adm({ cmd: "spawn_allowed", on: cfgSrv.spawn_allowed === false });
    else if (a === "spawn_bot") adm({ cmd: "spawn_bot" });
    else if (a === "kill_bots") adm({ cmd: "killbots" });
    else if (a === "reset_scores") adm({ cmd: "reset" });
    else if (a === "bot_limit") adm({ cmd: "bot_limit", n: panel.querySelector("#wzbotlimit").value });
    else if (a === "bot_damage") adm({ cmd: "bot_damage", x: panel.querySelector("#wzbotdmg").value });
    else if (a === "bot_cooldown") adm({ cmd: "bot_cooldown", n: panel.querySelector("#wzbotcooldown").value });
    else if (a === "resource_reset") adm({ cmd: "resource_reset" });
    else adm({ cmd: a, id });
    setTimeout(() => adm({ cmd: "list" }), 250);
  }
  function getResourceUploadToken() {
    if (resourceUploadToken && Date.now() < resourceUploadTokenExpiry) return Promise.resolve(resourceUploadToken);
    if (!online() || !(isAdmin || consoleAuthenticated)) return Promise.reject(new Error("Import reserve aux administrateurs connectes."));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        resourceTokenWaiters = resourceTokenWaiters.filter(x => x !== waiter);
        reject(new Error("Le serveur n'a pas fourni de ticket d'import."));
      }, 10000);
      resourceTokenWaiters.push(waiter);
      send({ t: "resource_token" });
    });
  }
  async function uploadServerResource(category, file) {
    if (!file) throw new Error("Aucun fichier selectionne.");
    const ticket = await getResourceUploadToken();
    const response = await fetch("/_resource_upload", {
      method: "POST",
      headers: {
        "X-WZ-Upload-Token": ticket,
        "X-WZ-Category": category,
        "X-WZ-Filename": encodeURIComponent(file.name || "fichier"),
        "Content-Type": "application/octet-stream"
      },
      body: file
    });
    let result;
    try { result = await response.json(); } catch (_) { throw new Error("Reponse serveur illisible."); }
    if (!response.ok || !result.ok) throw new Error(result.message || ("Import refuse (" + response.status + ")."));
    if (result.resources && window.WZ && typeof WZ.applyServerResources === "function") await WZ.applyServerResources(result.resources);
    return result;
  }
  WZ.multiplayer = {
    send, remotes,
    online,
    canAdmin: () => isAdmin,
    canManageResources: () => online() && (isAdmin || consoleAuthenticated),
    uploadResource: uploadServerResource,
    sendBotSpawn: () => send({ t: "bot_spawn" }),
    resourceChanged: (data) => {
      if (!online()) return;
      if (isAdmin) adm({ cmd: "resources", data });
      else if (consoleAuthenticated) send({ t: "console_ui", action: "set_resources", data });
    },
    resetResources: () => {
      if (!online()) return;
      if (isAdmin) adm({ cmd: "resource_reset" });
      else if (consoleAuthenticated) send({ t: "console_ui", action: "resource_reset", data: {} });
    },
    inAdminBase: () => !!(typeof window.isWZInAdminBase === "function" && window.isWZInAdminBase()),
    isFreecam: () => !!(typeof window.isWZAdminFreecam === "function" && window.isWZAdminFreecam())
  };
})();
