/* ================================================================
   AK-47 REALISTE - mod pour WARZONE RENDER V2
   A mettre dans le dossier  mods/  (le jeu le charge tout seul).
   Le shader lie a ce mod : shaders/RTX_Ultra_Armes.frag
   (le mod l'active tout seul au demarrage, a chaque lancement
    si tu ne l'as pas deja active dans F2).

   Ajoute :
    - une vraie AK-47 : bois, metal use, chargeur courbe, tube a gaz,
      guidon, hausse, frein de bouche, garde-main (joueur, bots, sol)
    - l'arme est retournee dans le bon sens (avant elle pointait vers toi)
    - tir : flash de bouche + lumiere, fumee,       douilles en laiton qui sautent et rebondissent, son de tir
    - balles : plus de boule verte ! de vraies balles avec traceurs
      lumineux (1 balle sur 3, les bots tirent en rouge)
    - impacts : trou de balle sur les murs/sol, etincelles, eclats,
      poussiere de la couleur de la surface (pas de gore sur les bots)

   Reglages : modifie l'objet CFG juste en dessous.
   ================================================================ */
(function () {
  "use strict";

  const W = window.WZ;
  if (!W || !W.THREE || !W.scene || !W.camera || !W.renderer) {
    console.error("[AK47_Realiste] moteur WZ introuvable : mod ignore");
    return;
  }
  if (window.__ak47RealisteActif) return;
  window.__ak47RealisteActif = true;

  const THREE = W.THREE, scene = W.scene, camera = W.camera;

  // ---------------- REGLAGES ----------------
  const CFG = {
    lierShader: false,                   // shader RTX optionnel absent du projet : desactive
    shaderId: "RTX_Ultra_Armes.frag",
    retournerArme: true,                 // false = garde l'ancienne orientation
    tracerEvery: 3,                      // 1 balle sur N a un traceur (1 = toutes)
    botTracers: true,                    // traceurs rouges des balles des bots
    tracerLength: 3.2,
    maxDecals: 70,                       // limite les decals pour garder les sessions longues fluides
    sparks: 0.75,                        // quantité réduite pour limiter les pics de particules
    dust: 0.75,                          // quantité réduite pour limiter les pics de particules
    casings: true,                       // douilles
    muzzleLight: 2.2,                    // lumiere du flash (0 = off)
    sound: true,
    volume: 0.35
  };

  const rnd = (a, b) => a + Math.random() * (b - a);
  const rv = (s) => new THREE.Vector3(rnd(-s, s), rnd(-s, s), rnd(-s, s));

  // ---------------- TEXTURES (dessinees en code) ----------------
  function canvasTex(w, h, draw) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    draw(c.getContext("2d"), w, h);
    return new THREE.CanvasTexture(c);
  }
  const texWood = canvasTex(256, 256, function (g, w, h) {
    g.fillStyle = "#6e3b1c"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 110; i++) {
      const x = rnd(0, w), dark = Math.random() < 0.6;
      g.strokeStyle = dark ? "rgba(38,16,5," + rnd(0.15, 0.4) + ")" : "rgba(170,105,55," + rnd(0.1, 0.25) + ")";
      g.lineWidth = rnd(1, 3.5);
      g.beginPath(); g.moveTo(x, 0); g.quadraticCurveTo(x + rnd(-14, 14), h / 2, x + rnd(-6, 6), h); g.stroke();
    }
  });
  const texMetal = canvasTex(128, 128, function (g, w, h) {
    g.fillStyle = "#3b3f46"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255," + rnd(0.03, 0.1) + ")" : "rgba(0,0,0," + rnd(0.1, 0.25) + ")";
      g.fillRect(rnd(0, w), rnd(0, h), rnd(1, 2), rnd(1, 3));
    }
    g.strokeStyle = "rgba(200,205,210,0.22)"; g.lineWidth = 1;
    for (let i = 0; i < 10; i++) { const x = rnd(0, w), y = rnd(0, h); g.beginPath(); g.moveTo(x, y); g.lineTo(x + rnd(-30, 30), y + rnd(-6, 6)); g.stroke(); }
  });
  const texSoft = canvasTex(64, 64, function (g, w, h) {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.4, "rgba(255,255,255,0.55)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
  const texStar = canvasTex(128, 128, function (g, w, h) {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.35);
    r.addColorStop(0, "rgba(255,255,230,1)"); r.addColorStop(0.5, "rgba(255,170,60,0.6)"); r.addColorStop(1, "rgba(255,120,20,0)");
    g.fillStyle = r; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "lighter";
    g.translate(w / 2, h / 2);
    for (let a = 0; a < 3; a++) {
      g.save(); g.rotate(a * Math.PI / 3 + 0.3);
      const l = g.createLinearGradient(-w / 2, 0, w / 2, 0);
      l.addColorStop(0, "rgba(255,160,50,0)"); l.addColorStop(0.5, "rgba(255,230,160,0.9)"); l.addColorStop(1, "rgba(255,160,50,0)");
      g.fillStyle = l; g.fillRect(-w / 2, -3, w, 6); g.restore();
    }
  });
  const texDecal = canvasTex(64, 64, function (g, w, h) {
    const r = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    r.addColorStop(0, "rgba(25,20,16,0.7)"); r.addColorStop(1, "rgba(25,20,16,0)");
    g.fillStyle = r; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(15,12,10,0.55)"; g.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      const a = rnd(0, 6.283), l = rnd(10, 27);
      g.beginPath(); g.moveTo(32, 32); g.lineTo(32 + Math.cos(a) * l, 32 + Math.sin(a) * l); g.stroke();
    }
    g.fillStyle = "rgba(4,4,4,0.97)"; g.beginPath(); g.arc(32, 32, 4.5, 0, 6.283); g.fill();
  });

  // ---------------- MODELE DE L'AK-47 ----------------
  const mMetal = new THREE.MeshStandardMaterial({ color: 0xffffff, map: texMetal, roughness: 0.45, metalness: 0.55 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.5, metalness: 0.5 });
  const mWood = new THREE.MeshStandardMaterial({ color: 0xffffff, map: texWood, roughness: 0.55, metalness: 0.05 });
  const MUZZLE = new THREE.Vector3(0, 0.085, -1.52);
  const EJECT = new THREE.Vector3(0.1, 0.1, 0.05);

  function box(g, w, h, d, x, y, z, m, rx) {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z); if (rx) o.rotation.x = rx; g.add(o); return o;
  }
  function cyl(g, r, len, x, y, z, m) {
    const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), m);
    o.rotation.x = Math.PI / 2; o.position.set(x, y, z); g.add(o); return o;
  }
  function buildAK(g) {
    while (g.children.length) g.remove(g.children[0]);
    box(g, 0.17, 0.17, 0.86, 0, 0.05, 0.12, mMetal);                 // boitier
    box(g, 0.15, 0.05, 0.82, 0, 0.165, 0.10, mMetal);                // couvercle
    for (let i = 0; i < 5; i++) box(g, 0.152, 0.012, 0.02, 0, 0.195, -0.2 + i * 0.14, mDark);
    cyl(g, 0.03, 1.0, 0, 0.085, -0.95, mDark);                       // canon
    cyl(g, 0.032, 0.62, 0, 0.158, -0.78, mMetal);                    // tube a gaz
    box(g, 0.15, 0.10, 0.5, 0, 0.045, -0.62, mWood);                 // garde-main bas
    box(g, 0.14, 0.05, 0.42, 0, 0.205, -0.66, mWood);                // garde-main haut
    box(g, 0.07, 0.09, 0.1, 0, 0.1, -1.0, mDark);                    // bloc de gaz
    box(g, 0.05, 0.03, 0.05, 0, 0.14, -1.2, mDark);                  // base guidon
    box(g, 0.014, 0.1, 0.014, 0, 0.2, -1.2, mDark);                  // guidon
    cyl(g, 0.042, 0.14, 0, 0.085, -1.45, mDark);                     // frein de bouche
    box(g, 0.05, 0.03, 0.12, 0, 0.205, -0.28, mDark);                // hausse
    box(g, 0.075, 0.27, 0.1, 0, -0.1, 0.42, mWood, -0.3);            // poignee
    box(g, 0.016, 0.02, 0.2, 0, -0.045, 0.24, mDark);                // pontet
    box(g, 0.016, 0.06, 0.02, 0, -0.02, 0.34, mDark);
    box(g, 0.012, 0.045, 0.012, 0, -0.015, 0.2, mDark, 0.3);         // detente
    for (let i = 0; i < 6; i++)                                      // chargeur courbe
      box(g, 0.08, 0.125, 0.17, 0, -0.1 - i * 0.11, -0.02 - 0.0085 * i * i, mMetal, 0.13 * i);
    box(g, 0.075, 0.17, 0.55, 0, 0.045, 0.82, mWood, 0.05);          // crosse
    box(g, 0.085, 0.24, 0.035, 0, 0.02, 1.1, mDark);                 // plaque de crosse
    const bh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 8), mDark);
    bh.rotation.z = Math.PI / 2; bh.position.set(0.12, 0.1, 0.0); g.add(bh);   // poignee d'armement
    const bb = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), mDark);
    bb.position.set(0.16, 0.1, 0.0); g.add(bb);
  }

  // ---------------- EFFETS : outils ----------------
  function fxObj(o) { o.userData.wzfx = true; return o; }

  // fumee / poussiere (sprites)
  const puffs = []; let puffI = 0;
  for (let i = 0; i < 44; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: texSoft, transparent: true, depthWrite: false, opacity: 0, fog: false }));
    s.visible = false; fxObj(s); scene.add(s);
    puffs.push({ s: s, life: 0, max: 1, v: new THREE.Vector3(), s0: 0.1, s1: 0.5, op: 0.5 });
  }
  function puff(pos, vel, col, s0, s1, life, op) {
    const p = puffs[puffI]; puffI = (puffI + 1) % puffs.length;
    p.s.position.copy(pos); p.v.copy(vel); p.s.material.color.copy(col); p.s.material.rotation = rnd(0, 6.28);
    p.life = p.max = life; p.s0 = s0; p.s1 = s1; p.op = op; p.s.visible = true;
  }

  // particules (Points) : etincelles (lumineuses) et eclats (sombres)
  function makePS(n, additive, size) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos[i * 3 + 1] = -9999;
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: size, map: texSoft, vertexColors: true, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, sizeAttenuation: true, fog: false });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; fxObj(pts); scene.add(pts);
    return { geo: geo, pos: pos, col: col, vel: new Float32Array(n * 3), base: new Float32Array(n * 3),
      life: new Float32Array(n), lmax: new Float32Array(n), n: n, i: 0, add: additive, live: 0 };
  }
  const sparkPS = makePS(300, true, 0.07);
  const chipPS = makePS(160, false, 0.06);
  function emit(ps, p, v, c, life) {
    const k = ps.i; ps.i = (ps.i + 1) % ps.n; const j = k * 3;
    ps.pos[j] = p.x; ps.pos[j + 1] = p.y; ps.pos[j + 2] = p.z;
    ps.vel[j] = v.x; ps.vel[j + 1] = v.y; ps.vel[j + 2] = v.z;
    ps.base[j] = c.r; ps.base[j + 1] = c.g; ps.base[j + 2] = c.b;
    ps.life[k] = ps.lmax[k] = life; ps.live = 60;
  }
  function stepPS(ps, dt, grav) {
    if (ps.live <= 0) return; ps.live--;
    for (let k = 0; k < ps.n; k++) {
      if (ps.life[k] <= 0) continue;
      const j = k * 3; ps.life[k] -= dt;
      if (ps.life[k] <= 0) { ps.pos[j + 1] = -9999; ps.col[j] = ps.col[j + 1] = ps.col[j + 2] = 0; continue; }
      ps.vel[j + 1] -= grav * dt;
      ps.pos[j] += ps.vel[j] * dt; ps.pos[j + 1] += ps.vel[j + 1] * dt; ps.pos[j + 2] += ps.vel[j + 2] * dt;
      if (ps.pos[j + 1] < 0.01 && ps.vel[j + 1] < 0) { ps.pos[j + 1] = 0.01; ps.vel[j + 1] *= -0.3; ps.vel[j] *= 0.6; ps.vel[j + 2] *= 0.6; }
      const f = ps.add ? ps.life[k] / ps.lmax[k] : 1;
      ps.col[j] = ps.base[j] * f; ps.col[j + 1] = ps.base[j + 1] * f; ps.col[j + 2] = ps.base[j + 2] * f;
    }
    ps.geo.attributes.position.needsUpdate = true; ps.geo.attributes.color.needsUpdate = true;
    ps.live = ps.live > 0 ? ps.live : 1;
    let any = false; for (let k = 0; k < ps.n; k++) if (ps.life[k] > 0) { any = true; break; }
    if (!any) ps.live = 0;
  }

  // trous de balle
  const decalMat = new THREE.MeshBasicMaterial({ map: texDecal, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: false });
  const decalGeo = new THREE.PlaneGeometry(1, 1);
  const decals = []; let decalI = 0;
  function decal(p, n) {
    let d;
    if (decals.length < CFG.maxDecals) { d = fxObj(new THREE.Mesh(decalGeo, decalMat)); scene.add(d); decals.push(d); }
    else { d = decals[decalI]; decalI = (decalI + 1) % decals.length; }
    const s = rnd(0.16, 0.26);
    d.scale.set(s, s, 1);
    d.position.copy(p).addScaledVector(n, 0.012);
    d.lookAt(p.x + n.x, p.y + n.y, p.z + n.z);
    d.rotateZ(rnd(0, 6.28));
  }

  // Cartouches ejectees : modele 3D fourni (meme modele pour AK-47 et M4), disparition apres 2 secondes.
  const casingFallbackGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.04, 10);
  const casingFallbackMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.9, emissive: 0x2a1c00 });
  const casings = []; let casI = 0;
  for (let i = 0; i < 20; i++) {
    const model = window.WZWeaponModels && window.WZWeaponModels.createCartridge
      ? window.WZWeaponModels.createCartridge()
      : new THREE.Mesh(casingFallbackGeo, casingFallbackMat);
    const m = fxObj(model); m.visible = false; scene.add(m);
    casings.push({ m: m, v: new THREE.Vector3(), w: new THREE.Vector3(), life: 0, rest: false });
  }
  const bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3();
  function ejectCasing() {
    const c = casings[casI]; casI = (casI + 1) % casings.length;
    const ejectPoint = pgun.userData && pgun.userData.wzEject ? pgun.userData.wzEject : EJECT;
    pgun.updateWorldMatrix(true, false);
    c.m.position.copy(pgun.localToWorld(ejectPoint.clone()));
    c.m.rotation.set(rnd(-3.14, 3.14), rnd(-3.14, 3.14), rnd(-3.14, 3.14));
    camera.matrixWorld.extractBasis(bx, by, bz);
    c.v.set(0, 0, 0).addScaledVector(bx, rnd(1.5, 2.5)).addScaledVector(by, rnd(0.9, 1.9)).addScaledVector(bz, rnd(0.1, 0.6));
    c.w.set(rnd(-25, 25), rnd(-25, 25), rnd(-25, 25));
    c.life = 2.0; c.rest = false; c.m.visible = true;
  }

  // flash de bouche + lumiere
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: texStar, color: 0xffd090, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, depthTest: false, fog: false }));
  flash.visible = false; flash.renderOrder = 999; fxObj(flash); flash.position.copy(MUZZLE);
  const light = new THREE.PointLight(0xffa860, 0, 14, 2); fxObj(light);
  camera.add(light); light.position.set(0.2, -0.1, -1.2);

  // son de tir
  let ac = null, noiseBuf = null;
  function shotSound() {
    if (!CFG.sound) return;
    try {
      if (!ac) { ac = new (window.AudioContext || window.webkitAudioContext)(); }
      if (ac.state === "suspended") ac.resume();
      if (!noiseBuf) {
        const n = Math.floor(ac.sampleRate * 0.22);
        noiseBuf = ac.createBuffer(1, n, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
      }
      const t = ac.currentTime;
      const src = ac.createBufferSource(); src.buffer = noiseBuf;
      const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 3200;
      const g = ac.createGain(); g.gain.value = CFG.volume;
      src.connect(f); f.connect(g); g.connect(ac.destination); src.start(t);
      const o = ac.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      const og = ac.createGain(); og.gain.setValueAtTime(CFG.volume * 1.1, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(og); og.connect(ac.destination); o.start(t); o.stop(t + 0.16);
    } catch (e) { /* pas de son, pas grave */ }
  }

  // ---------------- ARMES (retrouve et remplace les anciens modeles) ----------------
  let pgun = null, gunBase = new THREE.Vector3(0.23, -0.27, -0.32);
  function isOldAK(o) {
    const p = o.children && o.children[0] && o.children[0].geometry && o.children[0].geometry.parameters;
    return o.isGroup && !o.userData.akReal && o.children.length === 11 && p && p.depth === 1.5;
  }
  function upgradeGuns() {
    // Le nouveau slot contient directement le modele AK/M4 fourni : ne pas le reconstruire.
    const slot = camera.children.find(function (o) { return o && o.userData && o.userData.wzWeaponSlot; });
    if (slot) {
      if (pgun !== slot) {
        if (flash.parent) flash.parent.remove(flash);
        pgun = slot;
      }
      if (flash.parent !== pgun) pgun.add(flash);
      const muzzle = pgun.userData.wzMuzzle || MUZZLE;
      flash.position.copy(muzzle);
      return;
    }
    const found = [];
    scene.traverse(function (o) { if (isOldAK(o)) found.push(o); });
    found.forEach(function (g) {
      buildAK(g); g.userData.akReal = true;
      if (g.parent === camera) {
        pgun = g;
        if (CFG.retournerArme) { g.rotation.y = 0; g.position.copy(gunBase); }
        g.add(flash);
      }
    });
  }

  // ---------------- BALLES : traceurs + impacts ----------------
  const hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
  const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
  const addMat = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const mCoreP = addMat(0xfff2c0, 1.0), mGlowP = addMat(0xff9a2a, 0.45);
  const mCoreB = addMat(0xffb0a0, 1.0), mGlowB = addMat(0xff2a1a, 0.5);
  const tracked = []; let shotN = 0, kick = 0, flashT = 0;

  function tagBullet(b, friend) {
    b.userData.akT = true; b.material = hiddenMat;
    const vel = b.velocity;
    tracked.push({ b: b, friend: friend, prev: b.position.clone().sub(vel) });
    b.lookAt(b.position.clone().add(vel));
    const show = friend ? (++shotN % Math.max(1, CFG.tracerEvery) === 0) : CFG.botTracers;
    if (show) {
      const L = CFG.tracerLength;
      const core = new THREE.Mesh(tracerGeo, friend ? mCoreP : mCoreB); core.scale.set(0.022, 0.022, L); core.position.z = -L / 2;
      const glow = new THREE.Mesh(tracerGeo, friend ? mGlowP : mGlowB); glow.scale.set(0.07, 0.07, L * 0.8); glow.position.z = -L * 0.4;
      fxObj(core); fxObj(glow); b.add(core); b.add(glow);
    }
    if (friend) onShot();
  }
  function scanBullets() {
    const ch = scene.children;
    for (let i = 0; i < ch.length; i++) {
      const o = ch[i];
      if (o.isMesh && o.velocity && !o.userData.akT && o.material && o.material.color) {
        const hx = o.material.color.getHex();
        if (hx === 0x00ff88) tagBullet(o, true); else if (hx === 0xff3355) tagBullet(o, false);
      }
    }
  }

  function onShot() {
    shotSound();
    if (!pgun || pgun.parent !== camera) return;
    flashT = 0.045; flash.material.rotation = rnd(0, 6.28); flash.scale.setScalar(rnd(0.5, 0.8)); flash.visible = true;
    light.intensity = CFG.muzzleLight;
    pgun.updateWorldMatrix(true, false);
    const muzzlePoint = pgun.userData && pgun.userData.wzMuzzle ? pgun.userData.wzMuzzle : MUZZLE;
    flash.position.copy(muzzlePoint);
    const mp = pgun.localToWorld(muzzlePoint.clone());
    puff(mp, new THREE.Vector3(rnd(-0.1, 0.1), rnd(0.2, 0.5), rnd(-0.1, 0.1)), new THREE.Color(0.7, 0.7, 0.72), 0.12, 0.55, rnd(0.7, 1.1), 0.22);
    if (CFG.casings) ejectCasing();
  }

  // surfaces touchables (reconstruit de temps en temps)
  let targets = [], targetsT = 0;
  function getTargets() {
    const now = performance.now();
    if (now - targetsT < 400) return targets;
    targetsT = now; targets = [];
    const ch = scene.children;
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (c === camera || c.isLight || c.isPoints || c.isSprite || (c.userData && (c.userData.wzfx || c.userData.akT)) || c.velocity) continue;
      c.traverse(function (o) {
        if (!o.isMesh || !o.visible || o.velocity || (o.userData && (o.userData.wzfx || o.userData.akT))) return;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!m || m.visible === false || m.side === THREE.BackSide || m.opacity < 0.05) return;
        const g = o.geometry; if (!g) return;
        if (!g.boundingSphere) g.computeBoundingSphere();
        if (g.boundingSphere && g.boundingSphere.radius * Math.max(o.scale.x, o.scale.y, o.scale.z) > 300) return;
        targets.push(o);
      });
    }
    return targets;
  }
  const ray = new THREE.Raycaster();
  const tmpN = new THREE.Vector3();

  function isBotPart(o) {
    for (let p = o; p && p !== scene; p = p.parent) if (p.getObjectByName && p.getObjectByName("botPlateVisual")) return true;
    return false;
  }

  function onBulletGone(e) {
    const b = e.b, v = b.velocity; if (!v) return;
    const len = v.length(); if (len < 0.01) return;
    const dist = b.position.distanceTo(camera.position);
    if (!e.friend && dist < 2.5) return;          // balle de bot qui touche le joueur
    if (e.friend && dist > 78) return;            // balle perdue au loin
    const dir = v.clone().multiplyScalar(1 / len);
    ray.set(e.prev.clone().addScaledVector(dir, -0.2), dir); ray.far = len + 1.2;
    const hit = ray.intersectObjects(getTargets(), false)[0];
    let p, n, col = new THREE.Color(0.55, 0.5, 0.45), metal = false, body = false, wall = true;
    if (hit) {
      p = hit.point.clone();
      n = hit.face ? tmpN.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).clone() : dir.clone().negate();
      if (n.dot(dir) > 0) n.negate();
      const m = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material;
      if (m) { if (m.color) col.copy(m.color).lerp(new THREE.Color(0.6, 0.56, 0.5), 0.45); metal = (m.metalness || 0) > 0.55; }
      body = isBotPart(hit.object);
    } else {
      p = b.position.clone().addScaledVector(dir, -0.4); n = dir.clone().negate(); wall = false;
    }
    hitFX(p, n, col, metal, body, wall);
  }

  function hitFX(p, n, col, metal, body, wall) {
    if (body) {   // impact sur un bot : petit nuage sombre, pas de gore
      for (let i = 0; i < 3; i++) puff(p, rv(0.5).addScaledVector(n, 0.6), new THREE.Color(0.35, 0.3, 0.3), 0.1, rnd(0.3, 0.5), rnd(0.4, 0.7), 0.5, 0.45);
      for (let i = 0; i < 6; i++) emit(chipPS, p, rv(1.5).addScaledVector(n, rnd(1, 2.5)), new THREE.Color(0.2, 0.18, 0.18), rnd(0.3, 0.6));
      return;
    }
    if (wall) decal(p, n);
    const ns = Math.round((metal ? 18 : 8) * CFG.sparks);
    for (let i = 0; i < ns; i++) {
      const sp = rv(2.2).addScaledVector(n, rnd(1.5, 5));
      emit(sparkPS, p, sp, new THREE.Color(1.4, rnd(0.55, 0.85), 0.25), rnd(0.2, 0.5));
    }
    const dc = col.clone().multiplyScalar(0.55);
    for (let i = 0; i < 6; i++) emit(chipPS, p, rv(1.6).addScaledVector(n, rnd(1, 3)), dc, rnd(0.4, 0.8));
    const nd = Math.round(3 * CFG.dust);
    for (let i = 0; i < nd; i++) {
      const dv = rv(0.25).addScaledVector(n, rnd(0.4, 1.0)); dv.y += 0.25;
      puff(p.clone().addScaledVector(n, 0.05), dv, col, 0.14, rnd(0.55, 0.95), rnd(0.6, 1.1), 0.5);
    }
  }

  // ---------------- LIEN AVEC LE SHADER ----------------
  function lierShader() {
    const cfg = W.config;
    if (!cfg || !Array.isArray(cfg.shaders) || typeof W.setShader !== "function") return;
    try {
      if (cfg.shaders.indexOf("RTX_Ultra.frag") >= 0) W.setShader("RTX_Ultra.frag");   // evite le doublon : Armes est une version complete
      if (cfg.shaders.indexOf(CFG.shaderId) < 0) W.setShader(CFG.shaderId);
    } catch (e) { console.warn("[AK47_Realiste] shader non active", e); }
  }

  // ---------------- BOUCLE ----------------
  let frame = 0;
  W.onFrame(function (dt) {
    dt = Math.min(dt || 0.016, 0.05); frame++;
    if (frame % 45 === 1) upgradeGuns();
    scanBullets();
    for (let i = tracked.length - 1; i >= 0; i--) {
      const e = tracked[i];
      if (!e.b.parent) { tracked.splice(i, 1); try { onBulletGone(e); } catch (err) { console.warn("[AK47_Realiste] impact", err); } }
      else e.prev.copy(e.b.position);
    }
    if (flashT > 0) { flashT -= dt; if (flashT <= 0) flash.visible = false; }
    light.intensity = light.intensity > 0.02 ? light.intensity * Math.exp(-dt * 45) : 0;
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i]; if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      const k = 1 - p.life / p.max;
      p.s.position.addScaledVector(p.v, dt); p.v.multiplyScalar(Math.max(0, 1 - 1.6 * dt));
      const sz = p.s0 + (p.s1 - p.s0) * k; p.s.scale.set(sz, sz, 1);
      p.s.material.opacity = p.op * (1 - k) * (k < 0.1 ? k / 0.1 : 1);
    }
    for (let i = 0; i < casings.length; i++) {
      const c = casings[i]; if (c.life <= 0) continue;
      c.life -= dt;
      if (c.life <= 0) { c.m.visible = false; continue; }
      if (c.rest) continue;
      c.v.y -= 9.8 * dt; c.m.position.addScaledVector(c.v, dt);
      c.m.rotation.x += c.w.x * dt; c.m.rotation.y += c.w.y * dt; c.m.rotation.z += c.w.z * dt;
      if (c.m.position.y < 0.02) {
        c.m.position.y = 0.02;
        if (Math.abs(c.v.y) > 0.8) { c.v.y *= -0.35; c.v.x *= 0.6; c.v.z *= 0.6; } else c.rest = true;
      }
    }
    stepPS(sparkPS, dt, 9.8);
    stepPS(chipPS, dt, 9.8);
    if (frame === 90 && CFG.lierShader) lierShader();
  });

  upgradeGuns();
  window.WZAKRealisteRebind = upgradeGuns;
  W.notify("AK-47 realiste active");
  console.log("[AK47_Realiste] actif");
})();
