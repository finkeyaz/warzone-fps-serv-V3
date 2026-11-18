/* ===== Moteur de mods / packs de textures / shaders =====
   Charge après le jeu. Le jeu reste identique. */
(function () {
  const LS = "wz_engine_v1";
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } })();
  if (!saved.shaders && saved.shader && saved.shader !== "none") saved.shaders = [saved.shader];
  if (!saved.packs && saved.pack && saved.pack !== "none") saved.packs = [saved.pack];
  delete saved.shader; delete saved.pack;
  const cfg = Object.assign({ shaders: [], packs: [], disabledMods: [] }, saved);
  const canManageResources = () => {
    const mp = window.WZ && window.WZ.multiplayer;
    if (!mp) return true; // utilisation locale hors session multijoueur
    if (mp.canManageResources) return !!mp.canManageResources();
    return !!(mp.online && mp.online() && mp.canAdmin && mp.canAdmin());
  };
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (e) {} };
  const resourcePayload = () => ({
    shaders: cfg.shaders.slice(),
    packs: cfg.packs.slice(),
    mods: modList.filter(m => !cfg.disabledMods.includes(m.file)).map(m => m.file)
  });
  const syncResources = () => {
    try { if (WZ.multiplayer && WZ.multiplayer.resourceChanged) WZ.multiplayer.resourceChanged(resourcePayload()); } catch (e) { console.warn("resource sync", e); }
  };
  const getJSON = async (u) => { const r = await fetch(u + "?t=" + Date.now()); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); };
  const BASE = "../";
  const ls = async (d) => { try { const r = await fetch("/_ls/" + d); return r.ok ? await r.json() : []; } catch (e) { return []; } };
  const log = []; let showLog = false;
  const addLog = (m) => { log.push(new Date().toLocaleTimeString() + "  " + m); if (log.length > 80) log.shift(); };
  window.addEventListener("error", e => addLog("ERREUR : " + e.message + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : "")));
  const notify = (m) => { addLog(m); try { showNotification(m); } catch (e) { console.log("[WZ]", m); } };

  const frameHooks = [];
  const WZ = window.WZ = {
    THREE, scene, camera, renderer,
    onFrame(fn) { frameHooks.push(fn); },
    notify,
    setShader: (id) => canManageResources() ? toggleShader(id) : false,
    setPack: (id) => canManageResources() ? togglePack(id) : false,
    applyServerResources: async (data) => {
      if (!data || typeof data !== "object") return;
      cfg.shaders = Array.isArray(data.shaders) ? data.shaders.slice() : [];
      cfg.packs = Array.isArray(data.packs) ? data.packs.slice() : [];
      pendingServerResources = data;
      await scanFolders(); // les fichiers importes depuis un autre PC deviennent visibles sans modifier le depot
      const enabledMods = Array.isArray(data.mods) ? data.mods : [];
      cfg.disabledMods = modList.map(m => m.file).filter(file => !enabledMods.includes(file));
      save();
      await applyPacks(); await applyShaders();
      await loadMods();
      refreshPanel();
    },
    config: cfg
  };

  const HEADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform float uTime;
uniform float uNear;
uniform float uFar;
float linearDepth(vec2 uv){
  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
`;
  const VERT = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
  const FX = { rt: null, mat: null, quad: null, scene: new THREE.Scene(), cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), on: false, t0: performance.now(), lib: [] };
  FX.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  FX.quad.frustumCulled = false; FX.scene.add(FX.quad);

  function makeRT(w, h) {
    if (FX.rt) { FX.rt.dispose(); if (FX.rt.depthTexture) FX.rt.depthTexture.dispose(); }
    FX.rt = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat });
    FX.rt.depthTexture = new THREE.DepthTexture(w, h);
    FX.rt.depthTexture.type = THREE.UnsignedIntType;
    (FX.pp || []).forEach(r => r.dispose());
    FX.pp = [0, 1].map(() => new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat }));
  }

  FX.passes = [];
  async function applyShaders() {
    const mats = [], names = [];
    for (const id of cfg.shaders.slice()) {
      const meta = FX.lib.find(s => s.id === id);
      if (!meta) continue;
      try {
        const src = await (await fetch(BASE + "shaders/" + meta.file + "?t=" + Date.now())).text();
        mats.push(new THREE.ShaderMaterial({
          vertexShader: VERT, fragmentShader: HEADER + src,
          uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, uResolution: { value: new THREE.Vector2() }, uTime: { value: 0 }, uNear: { value: camera.near }, uFar: { value: camera.far } },
          depthTest: false, depthWrite: false
        }));
        names.push(meta.name);
      } catch (e) { console.error(e); notify("Erreur shader " + meta.name + " (voir console)"); }
    }
    FX.passes.forEach(m => m.dispose());
    FX.passes = mats; FX.on = mats.length > 0;
    if (names.length) notify("Shaders : " + names.join(" + "));
    refreshPanel();
  }
  async function toggleShader(id) {
    const i = cfg.shaders.indexOf(id);
    if (i >= 0) cfg.shaders.splice(i, 1); else cfg.shaders.push(id);
    save(); await applyShaders(); syncResources();
  }

  const origRender = renderer.render.bind(renderer);
  let last = performance.now(), frame = 0;
  renderer.render = function (s, c) {
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    for (const fn of frameHooks) { try { fn(dt, now / 1000); } catch (e) { console.error("[mod onFrame]", e); } }
    if (++frame % 60 === 1) scanMaterials();
    if (!FX.on || s !== scene || !FX.passes.length) return origRender(s, c);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!FX.rt || FX.rt.width !== size.x || FX.rt.height !== size.y) makeRT(size.x, size.y);
    renderer.setRenderTarget(FX.rt); origRender(s, c);
    let input = FX.rt.texture;
    const n = FX.passes.length;
    for (let i = 0; i < n; i++) {
      const m = FX.passes[i], u = m.uniforms, out = i === n - 1 ? null : FX.pp[i % 2];
      u.tDiffuse.value = input; u.tDepth.value = FX.rt.depthTexture;
      u.uResolution.value.set(size.x, size.y); u.uTime.value = (now - FX.t0) / 1000;
      u.uNear.value = c.near; u.uFar.value = c.far;
      FX.quad.material = m;
      renderer.setRenderTarget(out); origRender(FX.scene, FX.cam);
      if (out) input = out.texture;
    }
    renderer.setRenderTarget(null);
  };

  const COLORS = {
    0x111318: "floor", 0x2d3748: "wall", 0x3f4c6b: "innerWall", 0x1a202c: "roof", 0x4a5568: "cover",
    0xffd700: "ammoBox", 0x242e38: "enemyJacket", 0x1b281b: "enemyPants", 0x1f1f1f: "enemyVest",
    0xd9b38c: "enemySkin", 0x141414: "enemyMask", 0x1a1a1f: "weaponBody", 0x1e242b: "weaponPolymer",
    0xd4af37: "weaponAccent", 0x22262e: "weaponMag", 0x3d3830: "glove"
  };
  const seen = new Map();
  let pack = null, texCache = {}, origBg = scene.background;
  const loader = new THREE.TextureLoader();

  function scanMaterials() {
    scene.traverse(o => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) {
        if (seen.has(m) || !m.color || m.type !== "MeshStandardMaterial") continue;
        const cat = (pack && pack.byColor && pack.byColor["#" + m.color.getHexString()]) || COLORS[m.color.getHex()] || null;
        seen.set(m, { cat, color: m.color.getHex(), map: m.map });
        if (pack && cat) applyTo(m, cat);
      }
    });
  }
  function getTex(cat) {
    const spec = pack && pack.textures && pack.textures[cat]; if (!spec) return null;
    const o = typeof spec === "string" ? { file: spec } : spec;
    const key = o.file;
    if (!texCache[key]) {
      const t = loader.load(o.file);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      const r = o.repeat || (cat === "floor" ? 100 : 1);
      t.repeat.set(r, r); t.anisotropy = 8;
      if (o.pixelated) t.magFilter = THREE.NearestFilter;
      texCache[key] = t;
    }
    return texCache[key];
  }
  function applyTo(m, cat) { const t = getTex(cat); if (!t) return; m.map = t; m.color.setHex(0xffffff); m.needsUpdate = true; }
  function restore() { for (const [m, d] of seen) { m.map = d.map || null; m.color.setHex(d.color); m.needsUpdate = true; } scene.background = origBg; }

  const injected = [];
  async function loadPack(id) {
    const base = BASE + "texturepacks/" + id + "/";
    const files = await ls("texturepacks/" + id);
    const names = files.filter(f => !f.dir).map(f => f.name);
    let p;
    if (names.includes("pack.json")) p = await getJSON(base + "pack.json");
    else {
      p = { name: id, textures: {} };
      const cats = Object.values(COLORS);
      for (const f of names) {
        const m = f.match(/^(.+)\.(png|jpe?g|webp)$/i); if (!m) continue;
        const key = cats.find(c => c.toLowerCase() === m[1].toLowerCase());
        if (key) p.textures[key] = f; else if (m[1].toLowerCase() === "sky") p.sky = f;
      }
      p.ui = {}; if (names.includes("ui.css")) p.ui.css = "ui.css"; if (names.includes("ui.js")) p.ui.js = "ui.js";
    }
    return { p, base };
  }
  async function applyPacks() {
    injected.splice(0).forEach(n => n.remove());
    restore(); pack = null; texCache = {};
    const used = [];
    if (cfg.packs.length) {
      const merged = { textures: {}, byColor: {}, sky: null, ui: [] };
      for (const id of cfg.packs.slice()) {
        try {
          const { p, base } = await loadPack(id);
          for (const [cat, spec] of Object.entries(p.textures || {})) {
            const o = typeof spec === "string" ? { file: spec } : Object.assign({}, spec);
            o.file = base + o.file; merged.textures[cat] = o;
          }
          Object.assign(merged.byColor, p.byColor || {});
          if (p.sky) merged.sky = base + p.sky;
          if (p.ui) merged.ui.push({ css: p.ui.css && base + p.ui.css, js: p.ui.js && base + p.ui.js });
          used.push(p.name || id);
        } catch (e) { console.error(e); notify("Erreur pack " + id + " (voir console)"); }
      }
      pack = merged;
      for (const [m, d] of seen) {
        const cat = merged.byColor["#" + new THREE.Color(d.color).getHexString()] || d.cat;
        d.cat = cat; if (cat) applyTo(m, cat);
      }
      if (merged.sky) loader.load(merged.sky, t => { scene.background = t; });
      for (const u of merged.ui) {
        if (u.css) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = u.css; document.head.appendChild(l); injected.push(l); }
        if (u.js) { const s = document.createElement("script"); s.src = u.js; document.body.appendChild(s); injected.push(s); }
      }
      if (used.length) notify("Packs : " + used.join(" + "));
    }
    refreshPanel();
  }
  async function togglePack(id) {
    const i = cfg.packs.indexOf(id);
    if (i >= 0) cfg.packs.splice(i, 1); else cfg.packs.push(id);
    save(); await applyPacks(); syncResources();
  }

  const modList = [];
  let pendingServerResources = null;
  async function loadMods() {
    const list = (await ls("mods")).filter(f => !f.dir && /\.js$/i.test(f.name)).map(f => f.name).sort();
    if (pendingServerResources && Array.isArray(pendingServerResources.mods)) {
      cfg.disabledMods = list.filter(file => !pendingServerResources.mods.includes(file));
    }
    for (const file of list) {
      if (modList.some(m => m.file === file)) continue;
      modList.push({ file, name: file.replace(/\.js$/i, "") });
      if (cfg.disabledMods.includes(file)) continue;
      await new Promise(res => {
        const s = document.createElement("script"); s.src = BASE + "mods/" + file + "?v=" + Date.now();
        s.onload = () => { console.log("Mod chargé :", file); addLog("Mod chargé : " + file); res(); };
        s.onerror = () => { console.error("Mod en erreur :", file); addLog("ERREUR mod : " + file); res(); };
        document.body.appendChild(s);
      });
    }
  }

  const panel = document.createElement("div");
  panel.style.cssText = "display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:520px;max-height:80vh;overflow:auto;background:rgba(10,10,14,.96);color:#dde;border:1px solid rgba(0,255,136,.4);border-radius:12px;padding:20px;z-index:100;font:14px Segoe UI,sans-serif;box-shadow:0 0 40px rgba(0,0,0,.8)";
  document.body.appendChild(panel);
  WZ.closeResourcePanel = () => { panel.style.display = "none"; };
  WZ.isResourcePanelOpen = () => panel.style.display !== "none";
  let packs = [];
  function section(title, items, checkedFn) {
    let h = `<h3 style="margin:14px 0 6px;color:#00ff88">${title}</h3>`;
    if (!items.length) return h + "<div style=\"color:#778\">Aucun</div>";
    for (const it of items) h += `<label style="display:block;padding:4px 0;cursor:pointer"><input type="checkbox" data-g="${title}" data-id="${it.id}" ${checkedFn(it.id) ? "checked" : ""}> ${it.name}</label>`;
    return h;
  }
  function refreshPanel() {
    panel.innerHTML = "<div style=\"display:flex;justify-content:space-between\"><b style=\"font-size:17px\">Mods · Textures · Shaders</b><span style=\"color:#778\">Echap ou F2 pour fermer</span></div>"
      + section("Shaders", FX.lib, id => cfg.shaders.includes(id))
      + section("Packs de textures", packs, id => cfg.packs.includes(id))
      + section("Mods (rechargement requis)", modList.map(m => ({ id: m.file, name: m.name })), id => !cfg.disabledMods.includes(id))
      + "<h3 style=\"margin:14px 0 6px;color:#00ff88\">Importer depuis mon PC · fichiers partages sur le serveur</h3>"
      + "<div style=\"display:grid;gap:8px;background:#111b20;border:1px solid #29404a;border-radius:8px;padding:10px\">"
      + "<div><b>Shader</b><div style=\"color:#8aa;font-size:11px;margin:3px 0 6px\">Fichier .frag ou .glsl</div><input id=\"wzUploadShader\" type=\"file\" accept=\".frag,.glsl\" style=\"display:none\"><button type=\"button\" id=\"wzChooseShader\" style=\"padding:7px 10px;background:#176b56;border:0;color:#fff;border-radius:5px;cursor:pointer\">Importer un shader</button></div>"
      + "<div><b>Pack de textures</b><div style=\"color:#8aa;font-size:11px;margin:3px 0 6px\">Archive .zip avec pack.json et les images</div><input id=\"wzUploadPack\" type=\"file\" accept=\".zip,application/zip\" style=\"display:none\"><button type=\"button\" id=\"wzChoosePack\" style=\"padding:7px 10px;background:#176b56;border:0;color:#fff;border-radius:5px;cursor:pointer\">Importer un pack</button></div>"
      + "<div><b>Mod</b><div style=\"color:#8aa;font-size:11px;margin:3px 0 6px\">Fichier JavaScript .js (execute chez tous les joueurs)</div><input id=\"wzUploadMod\" type=\"file\" accept=\".js,text/javascript\" style=\"display:none\"><button type=\"button\" id=\"wzChooseMod\" style=\"padding:7px 10px;background:#176b56;border:0;color:#fff;border-radius:5px;cursor:pointer\">Importer un mod</button></div>"
      + "<div id=\"wzUploadStatus\" style=\"color:#8bd8be;font-size:11px;min-height:15px\"></div></div>"
      + "<h3 style=\"margin:14px 0 6px;color:#00ff88\">Actions</h3>"
      + "<div style=\"display:flex;flex-wrap:wrap;gap:8px\">"
      + "<button id=\"wzRescan\" style=\"padding:8px 12px;background:#00aa66;border:0;color:#fff;border-radius:6px;cursor:pointer;font-weight:700\">🔄 Rafraîchir les dossiers</button>"
      + "<button id=\"wzTest\" style=\"padding:8px 12px;background:#a020f0;border:0;color:#fff;border-radius:6px;cursor:pointer;font-weight:700\">🧪 Lancer un test</button>"
      + "<button id=\"wzLog\" style=\"padding:8px 12px;background:#555;border:0;color:#fff;border-radius:6px;cursor:pointer;font-weight:700\">📋 Journal</button>"
      + "<button id=\"wzReset\" style=\"padding:8px 12px;background:#d03030;border:0;color:#fff;border-radius:6px;cursor:pointer;font-weight:700\">⟲ Reset synchronise (tous les joueurs)</button>"
      + "</div>"
      + (showLog ? "<pre style=\"margin-top:10px;max-height:180px;overflow:auto;background:#000;padding:8px;font-size:12px;white-space:pre-wrap\">" + (log.length ? log.join("\n").replace(/</g, "&lt;") : "Journal vide") + "</pre>" : "");
    panel.querySelectorAll("input[data-g]").forEach(i => i.onchange = () => {
      if (!canManageResources()) { i.checked = !i.checked; notify("Acces reserve aux administrateurs."); return; }
      const id = i.dataset.id, g = i.dataset.g;
      if (g === "Shaders") toggleShader(id);
      else if (g === "Packs de textures") togglePack(id);
      else { cfg.disabledMods = cfg.disabledMods.filter(x => x !== id); if (!i.checked) cfg.disabledMods.push(id); save(); syncResources(); notify("Mod synchronise. Reset necessaire pour appliquer le chargement."); }
    });
    panel.querySelector("#wzReset").onclick = () => {
      if (WZ.multiplayer && WZ.multiplayer.online && WZ.multiplayer.online()) {
        if (WZ.multiplayer.canManageResources ? WZ.multiplayer.canManageResources() : (WZ.multiplayer.canAdmin && WZ.multiplayer.canAdmin())) {
          WZ.multiplayer.resetResources();
          notify("Rechargement synchronise demande pour tous les joueurs.");
        } else notify("Authentifie-toi au centre admin pour redemarrer les ressources du serveur.");
      } else location.reload();
    };
    panel.querySelector("#wzRescan").onclick = () => rescan();
    const uploadDefs = [
      ["wzChooseShader", "wzUploadShader", "shaders"],
      ["wzChoosePack", "wzUploadPack", "packs"],
      ["wzChooseMod", "wzUploadMod", "mods"]
    ];
    for (const [buttonId, inputId, category] of uploadDefs) {
      const button = panel.querySelector("#" + buttonId), input = panel.querySelector("#" + inputId);
      if (!button || !input) continue;
      button.onclick = () => { if (!canManageResources()) { notify("Import reserve aux administrateurs authentifies."); return; } input.click(); };
      input.onchange = async () => {
        const file = input.files && input.files[0]; if (!file) return;
        const status = panel.querySelector("#wzUploadStatus");
        if (status) status.textContent = "Envoi de " + file.name + " vers le serveur...";
        button.disabled = true;
        try {
          if (!WZ.multiplayer || typeof WZ.multiplayer.uploadResource !== "function") throw new Error("Import serveur indisponible.");
          const result = await WZ.multiplayer.uploadResource(category, file);
          if (status) status.textContent = result.message || "Import termine.";
          notify(result.message || "Fichier importe sur le serveur.");
          await scanFolders(); refreshPanel();
        } catch (err) {
          if (status) status.textContent = "Erreur : " + err.message;
          notify("Import impossible : " + err.message);
        } finally { button.disabled = false; input.value = ""; }
      };
    }
    panel.querySelector("#wzTest").onclick = () => runTest();
    panel.querySelector("#wzLog").onclick = () => { showLog = !showLog; refreshPanel(); };
  }
  document.addEventListener("keydown", e => {
    if (e.code !== "F2") return;
    // Fermeture et ouverture sont toutes deux réservées aux admins en multijoueur.
    if (!canManageResources()) {
      e.preventDefault(); e.stopImmediatePropagation();
      panel.style.display = "none";
      return;
    }
    e.preventDefault();
    const open = panel.style.display === "none";
    panel.style.display = open ? "block" : "none";
    if (open) { try { document.exitPointerLock(); } catch (x) {} refreshPanel(); }
  }, true);

  /* ===== Lancer un test : vérifie tous les shaders, packs et mods (activés ou non) ===== */
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const imgOK = (u) => new Promise(r => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = u + "?t=" + Date.now(); });
  const fetchText = async (u) => { const r = await fetch(u + "?t=" + Date.now()); if (!r.ok) throw new Error("fichier introuvable (" + r.status + ")"); return r.text(); };

  async function testShader(meta) {
    let ok = 0, total = 4, err = "";
    let src;
    try { src = await fetchText(BASE + "shaders/" + meta.file); ok++; } catch (e) { return { pct: 0, err: e.message }; }
    const full = HEADER + src;
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return { pct: Math.round(ok / total * 100), err: "WebGL indisponible pour le test" };
    const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, full); gl.compileShader(fs);
    if (gl.getShaderParameter(fs, gl.COMPILE_STATUS)) ok++;
    else {
      const info = gl.getShaderInfoLog(fs) || "";
      const m = info.match(/ERROR:\s*\d+:(\d+):\s*'([^']*)'\s*:\s*(.*)/);
      if (m) { const line = (full.split("\n")[+m[1] - 1] || "").trim(); err = "« " + m[2] + " » : " + m[3] + (line ? "\n→ " + line : ""); }
      else err = info.split("\n")[0] || "erreur de compilation";
    }
    if (!err) {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, "attribute vec2 position; attribute vec2 uv; varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 0.0, 1.0); }"); gl.compileShader(vs);
      const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
      if (gl.getProgramParameter(p, gl.LINK_STATUS)) ok++; else err = "liaison impossible : " + (gl.getProgramInfoLog(p) || "").split("\n")[0];
    }
    if (/gl_FragColor/.test(src)) ok++; else if (!err) err = "« gl_FragColor » n'est jamais écrit";
    if (!err) ok++; // aucune erreur GL
    return { pct: Math.round(ok / total * 100), err };
  }

  async function testMod(m) {
    const enabled = !cfg.disabledMods.includes(m.file);
    let ok = 0, total = enabled ? 3 : 2, err = "";
    let code;
    try { code = await fetchText(BASE + "mods/" + m.file); ok++; } catch (e) { return { pct: 0, err: e.message }; }
    if (code.trim()) ok++; else err = "fichier vide";
    if (enabled) {
      const bad = log.filter(l => l.includes("ERREUR") && l.includes(m.file));
      if (bad.length) { if (!err) err = bad[bad.length - 1].replace(/^\S+\s+/, ""); } else ok++;
    }
    return { pct: Math.round(ok / total * 100), err, note: enabled ? "" : "désactivé : non exécuté" };
  }

  async function testPack(pk) {
    let ok = 0, total = 0; const bad = [];
    let data;
    try { data = await loadPack(pk.id); } catch (e) { return { pct: 0, err: "pack.json illisible : " + e.message }; }
    const { p, base } = data;
    const texFiles = Object.entries(p.textures || {}).map(([cat, spec]) => [cat, typeof spec === "string" ? spec : spec.file]);
    if (p.sky) texFiles.push(["sky", p.sky]);
    if (!texFiles.length && !(p.ui && (p.ui.css || p.ui.js))) return { pct: 0, err: "dossier vide : aucune texture ni interface" };
    for (const [cat, f] of texFiles) { total++; if (await imgOK(base + f)) ok++; else bad.push(cat + " → " + f); }
    if (p.ui && p.ui.css) { total++; try { await fetchText(base + p.ui.css); ok++; } catch (e) { bad.push("ui.css → " + e.message); } }
    if (p.ui && p.ui.js) { total++; try { const js = await fetchText(base + p.ui.js); if (js.trim()) ok++; else bad.push("ui.js est vide"); } catch (e) { bad.push("ui.js → " + e.message); } }
    return { pct: total ? Math.round(ok / total * 100) : 0, err: bad.join("\n") };
  }

  async function runTest() {
    await scanFolders();
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:200;background:rgba(5,5,8,.97);color:#dde;font:14px Segoe UI,sans-serif;overflow:auto;padding:30px";
    ov.innerHTML = `<div style="max-width:720px;margin:0 auto"><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:20px">🧪 Test des dossiers</b><button id="wzTClose" style="padding:6px 12px;cursor:pointer">Fermer</button></div><div style="margin:14px 0;height:10px;background:#222;border-radius:6px;overflow:hidden"><div id="wzTBar" style="height:100%;width:0;background:#00ff88;transition:width .2s"></div></div><div id="wzTStat" style="color:#99a;margin-bottom:10px">Chargement…</div><div id="wzTList"></div></div>`;
    document.body.appendChild(ov);
    ov.querySelector("#wzTClose").onclick = () => ov.remove();
    const jobs = [
      ...FX.lib.map(x => ["Shader", x.name, () => testShader(x)]),
      ...packs.map(x => ["Pack de textures", x.name, () => testPack(x)]),
      ...modList.map(x => ["Mod", x.name, () => testMod(x)])
    ];
    const list = ov.querySelector("#wzTList"), bar = ov.querySelector("#wzTBar"), stat = ov.querySelector("#wzTStat");
    if (!jobs.length) { stat.textContent = "Rien à tester : les dossiers mods, texturepacks et shaders sont vides."; bar.style.width = "100%"; return; }
    let done = 0, sum = 0;
    for (const [kind, name, fn] of jobs) {
      stat.textContent = "Test : " + kind + " « " + name + " »…";
      await sleep(150);
      let r; try { r = await fn(); } catch (e) { r = { pct: 0, err: String(e) }; }
      done++; sum += r.pct; bar.style.width = Math.round(done / jobs.length * 100) + "%";
      const icon = r.pct === 100 ? "✅" : r.pct === 0 ? "❌" : "⚠️", col = r.pct === 100 ? "#00ff88" : r.pct === 0 ? "#ff5555" : "#ffaa33";
      list.insertAdjacentHTML("beforeend", `<div style="padding:8px 10px;margin:6px 0;background:#12141a;border-left:4px solid ${col};border-radius:4px"><b>${icon} ${esc(name)}</b> <span style="color:#778">· ${kind}</span> <b style="float:right;color:${col}">${r.pct}%</b>${r.note ? `<div style="color:#778;font-size:12px">${esc(r.note)}</div>` : ""}${r.err ? `<pre style="margin:6px 0 0;color:#ff9a9a;font-size:12px;white-space:pre-wrap">${esc(r.err)}</pre>` : ""}</div>`);
    }
    stat.innerHTML = `<b style="color:#00ff88">Terminé</b> · ${jobs.length} élément(s) testé(s) · moyenne ${Math.round(sum / jobs.length)}%`;
  }

  async function scanFolders() {
    FX.lib = (await ls("shaders")).filter(f => !f.dir && /\.(frag|glsl)$/i.test(f.name)).map(f => ({ id: f.name, name: f.name.replace(/\.(frag|glsl)$/i, ""), file: f.name }));
    packs = (await ls("texturepacks")).filter(f => f.dir).map(f => ({ id: f.name, name: f.name }));
    await loadMods();
  }
  async function rescan() {
    await scanFolders();
    cfg.shaders = cfg.shaders.filter(id => FX.lib.some(l => l.id === id));
    cfg.packs = cfg.packs.filter(id => packs.some(p => p.id === id));
    save(); await applyPacks(); await applyShaders(); syncResources();
    notify("Dossiers rafraîchis");
  }

  (async () => {
    await scanFolders();
    scanMaterials();
    if (cfg.packs.length) await applyPacks();
    if (cfg.shaders.length) await applyShaders();
    refreshPanel();
  })();
})();
