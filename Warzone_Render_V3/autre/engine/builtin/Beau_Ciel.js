/* ================================================================
   BEAU CIEL - mod pour WARZONE RENDER V2
   A mettre dans le dossier  mods/  (le jeu le charge tout seul).

   Ajoute :
    - un vrai ciel : degrade bleu, soleil avec halo, nuages animes
      eclaires par le soleil, voile de cirrus, brume a l'horizon
    - le brouillard prend la couleur de l'horizon (plus de bande noire)
    - lumiere du soleil chaude, dans la meme direction que le soleil
      visible, + lumiere bleutee du ciel
    - de vraies ombres du soleil qui suivent le joueur partout
      (avant : ombres seulement autour du centre de la map)

   Marche avec ou sans le shader RTX_Ultra (plus beau avec).
   Reglages : modifie l'objet CFG juste en dessous.
   ================================================================ */
(function () {
  "use strict";

  const W = window.WZ;
  if (!W || !W.THREE || !W.scene || !W.camera || !W.renderer) {
    console.error("[Beau_Ciel] moteur WZ introuvable : mod ignore");
    return;
  }
  if (window.__beauCielActif) return;
  window.__beauCielActif = true;

  const THREE = W.THREE, scene = W.scene, camera = W.camera, renderer = W.renderer;

  // ---------------- REGLAGES ----------------
  const CFG = {
    sunElevation: 28,            // hauteur du soleil en degres (10 = couchant, 60 = midi)
    sunAzimuth: 30,              // direction : 0 = devant (au spawn), 90 = a droite, -90 = a gauche, 180 = derriere
    clouds: 0.55,                // quantite de nuages : 0 = ciel degage, 1 = tres couvert
    cloudSpeed: 1.0,             // vitesse des nuages
    haze: [0.66, 0.78, 0.92],    // couleur de l'horizon / du brouillard (R,G,B de 0 a 1)
    fogNear: 30,                 // debut du brouillard (m)
    fogFar: 170,                 // fin du brouillard (m)
    sunColor: [1.0, 0.92, 0.78], // couleur de la lumiere du soleil
    sunIntensity: 1.15,
    ambientIntensity: 0.40,
    skyLightIntensity: 0.45,
    shadows: true,               // ombres du soleil
    shadowMapSize: 1024,         // 1024 = plus leger, 4096 = plus net
    shadowRange: 45,             // taille de la zone d'ombres autour du joueur (m)
    shadowAllMeshes: true        // les murs, ennemis, caisses... projettent une ombre
  };

  const deg = THREE.MathUtils.degToRad;
  const el = deg(CFG.sunElevation), az = deg(CFG.sunAzimuth);
  // le joueur regarde vers -Z au demarrage
  const sun = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
  const haze = new THREE.Vector3(CFG.haze[0], CFG.haze[1], CFG.haze[2]);

  // ---------------- DOME DE CIEL ----------------
  const VERT = [
    "varying vec3 vDir;",
    "void main() {",
    "  vDir = position;",
    "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
    "}"
  ].join("\n");

  const FRAG = [
    "varying vec3 vDir;",
    "uniform vec3 uSun;",
    "uniform float uTime;",
    "uniform float uCloud;",
    "uniform vec3 uHaze;",
    "",
    "float hash(vec2 p) {",
    "  p = fract(p * vec2(123.34, 456.21));",
    "  p += dot(p, p + 45.32);",
    "  return fract(p.x * p.y);",
    "}",
    "uniform sampler2D uNoise;",
    "// bruit de nuages deja calcule (texture) : 1 lecture au lieu de plusieurs octaves par pixel",
    "float fbm(vec2 p) { return texture2D(uNoise, p * 0.125).r; }",
    "float fbm3(vec2 p) { return texture2D(uNoise, p * 0.125 + vec2(0.37, 0.61)).r; }",
    "",
    "void main() {",
    "  vec3 dir = normalize(vDir);",
    "  float h = dir.y;",
    "  float sd = max(dot(dir, uSun), 0.0);",
    "  float up = clamp(h, 0.0, 1.0);",
    "",
    "  // degrade : brume -> bleu clair -> bleu profond",
    "  vec3 zenith = vec3(0.07, 0.22, 0.62);",
    "  vec3 mid = vec3(0.22, 0.46, 0.85);",
    "  vec3 sky = mix(uHaze, mid, smoothstep(0.0, 0.30, up));",
    "  sky = mix(sky, zenith, smoothstep(0.20, 0.95, up));",
    "",
    "  // halo chaud autour du soleil (nul a l'horizon pour raccorder le brouillard)",
    "  float horizonFade = smoothstep(0.0, 0.12, h);",
    "  vec3 warm = vec3(1.0, 0.80, 0.55);",
    "  sky += warm * pow(sd, 5.0) * 0.30 * horizonFade;",
    "  sky += warm * pow(sd, 24.0) * 0.45;",
    "  sky += vec3(1.0, 0.93, 0.80) * pow(sd, 200.0) * 0.9;",
    "",
    "  // disque du soleil",
    "  float disc = smoothstep(0.9993, 0.9997, sd);",
    "  sky = mix(sky, vec3(1.0, 0.97, 0.88), disc);",
    "",
    "  if (h > 0.0) {",
    "    // nuages (cumulus) avec ombre propre vers le soleil",
    "    vec2 p = dir.xz / (h + 0.14);",
    "    p = p * 0.5 + vec2(uTime * 0.010, uTime * 0.004);",
    "    float n = fbm(p);",
    "    float thr = mix(0.66, 0.40, uCloud);",
    "    float dens = smoothstep(thr, thr + 0.20, n);",
    "    if (dens > 0.001) {",
    "      float n2 = fbm3(p + uSun.xz * 0.07);",
    "      float lit = clamp(0.62 + (n - n2) * 5.0, 0.0, 1.0);",
    "      vec3 cc = mix(vec3(0.50, 0.58, 0.72), vec3(1.0, 0.98, 0.94), lit);",
    "      cc *= mix(1.0, 0.85, smoothstep(0.55, 1.0, dens));",
    "      float edge = smoothstep(0.0, 0.5, dens) * (1.0 - smoothstep(0.5, 1.0, dens));",
    "      cc += vec3(1.0, 0.82, 0.55) * edge * pow(sd, 3.0) * 1.1;",
    "      cc = mix(cc, uHaze, 0.35 * (1.0 - smoothstep(0.0, 0.5, h)));",
    "      float alpha = dens * smoothstep(0.0, 0.18, h) * 0.95;",
    "      sky = mix(sky, cc, alpha);",
    "    }",
    "    // voile de cirrus en altitude",
    "    vec2 q = dir.xz / (h + 0.35);",
    "    q = q * vec2(0.9, 2.6) + vec2(uTime * 0.006, 0.0);",
    "    float cir = smoothstep(0.52, 0.95, fbm3(q * 1.7));",
    "    sky = mix(sky, vec3(1.0), cir * 0.30 * smoothstep(0.08, 0.40, h));",
    "  }",
    "",
    "  sky += (hash(gl_FragCoord.xy) - 0.5) / 255.0;   // anti-banding",
    "  gl_FragColor = vec4(clamp(sky, 0.0, 1.0), 1.0);",
    "}"
  ].join("\n");

  // Texture de bruit "nuages" calculee UNE fois au demarrage (fBm tuilable, periode 8 unites).
  const noiseTex = (function () {
    const N = 512, PER = 8, data = new Uint8Array(N * N * 4);
    let seed = 1337; const rnd = function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const oct = [];
    for (let k = 0; k < 4; k++) { const c = PER * (1 << k), g = new Float32Array(c * c); for (let i = 0; i < g.length; i++) g[i] = rnd(); oct.push({ c: c, g: g }); }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let v = 0, a = 0.5;
      for (let k = 0; k < 4; k++) {
        const c = oct[k].c, g = oct[k].g, fx = x / N * c, fy = y / N * c;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        const x0 = ix % c, x1 = (ix + 1) % c, y0 = iy % c, y1 = (iy + 1) % c;
        const n = (g[y0 * c + x0] * (1 - tx) + g[y0 * c + x1] * tx) * (1 - ty) + (g[y1 * c + x0] * (1 - tx) + g[y1 * c + x1] * tx) * ty;
        v += a * n; a *= 0.5;
      }
      const b = Math.max(0, Math.min(255, Math.round(v * 1.07 * 255))), i = (y * N + x) * 4;
      data[i] = b; data[i + 1] = b; data[i + 2] = b; data[i + 3] = 255;
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.needsUpdate = true; return t;
  })();

  const skyMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uSun: { value: sun.clone() },
      uTime: { value: 0 },
      uNoise: { value: noiseTex },
      uCloud: { value: CFG.clouds },
      uHaze: { value: haze.clone() }
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 24), skyMat);
  dome.name = "BeauCielDome";
  dome.renderOrder = 1000;   // apres tous les objets opaques : pixels caches = aucun calcul de ciel
  dome.frustumCulled = false;
  dome.raycast = function () {};   // les balles ne touchent jamais le ciel
  scene.add(dome);

  // ---------------- BROUILLARD / FOND ----------------
  scene.background = new THREE.Color(haze.x, haze.y, haze.z);
  if (scene.fog) {
    scene.fog.color.setRGB(haze.x, haze.y, haze.z);
    scene.fog.near = CFG.fogNear;
    scene.fog.far = CFG.fogFar;
  } else {
    scene.fog = new THREE.Fog(new THREE.Color(haze.x, haze.y, haze.z), CFG.fogNear, CFG.fogFar);
  }

  // ---------------- LUMIERES ----------------
  let dirLight = null, ambient = null;
  scene.traverse(function (o) {
    if (o.isDirectionalLight && !dirLight) dirLight = o;
    if (o.isAmbientLight && !ambient) ambient = o;
  });
  if (ambient) {
    ambient.color.setRGB(0.81, 0.88, 1.0);
    ambient.intensity = CFG.ambientIntensity;
  }
  const skyLight = new THREE.HemisphereLight(0xa8ccff, 0x4a4e58, CFG.skyLightIntensity);
  skyLight.name = "BeauCielHemi";
  scene.add(skyLight);

  const RANGE = CFG.shadowRange, SIZE = CFG.shadowMapSize;
  const fwd = sun.clone().negate();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize();
  const upv = new THREE.Vector3().crossVectors(fwd, right).normalize();
  const target = new THREE.Vector3();

  if (dirLight) {
    dirLight.color.setRGB(CFG.sunColor[0], CFG.sunColor[1], CFG.sunColor[2]);
    dirLight.intensity = CFG.sunIntensity;
    dirLight.position.copy(sun).multiplyScalar(80);
    if (CFG.shadows) {
      dirLight.castShadow = true;
      const sh = dirLight.shadow;
      sh.mapSize.set(SIZE, SIZE);
      if (sh.map) { sh.map.dispose(); sh.map = null; }
      const c = sh.camera;
      c.left = -RANGE; c.right = RANGE; c.top = RANGE; c.bottom = -RANGE;
      c.near = 1; c.far = 220;
      c.updateProjectionMatrix();
      sh.bias = -0.0004;
      sh.normalBias = 0.03;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.shadowMap.autoUpdate = false;   // la carte d'ombres est recalculee 1 image sur 2 (voir boucle)
      scene.add(dirLight.target);
    }
  }

  // tout ce qui est solide projette et recoit des ombres
  const traites = new WeakSet();
  function activerOmbres() {
    scene.traverse(function (o) {
      if (!o.isMesh || o === dome || traites.has(o)) return;
      traites.add(o);
      const m = o.material;
      const ms = Array.isArray(m) ? m : [m];
      if (!ms.some(function (x) { return x && x.isMeshStandardMaterial && !x.transparent; })) return;
      for (let p = o.parent; p; p = p.parent) if (p === camera) return;   // l'arme du joueur : pas d'ombre
      const g = o.geometry;
      if (g && g.type === "PlaneGeometry" && g.parameters && g.parameters.width >= 100) {
        o.receiveShadow = true; o.castShadow = false; return;            // le sol
      }
      o.castShadow = true; o.receiveShadow = true;
    });
  }
  if (CFG.shadows && CFG.shadowAllMeshes) activerOmbres();

  // changement de type d'ombre : recompiler les materiaux une fois
  scene.traverse(function (o) {
    const m = o.material; if (!m) return;
    (Array.isArray(m) ? m : [m]).forEach(function (x) { if (x && x.isMeshStandardMaterial) x.needsUpdate = true; });
  });

  // ---------------- BOUCLE ----------------
  let frame = 0;
  W.onFrame(function (dt, t) {
    const cp = camera.position;
    dome.position.copy(cp);
    skyMat.uniforms.uTime.value = t * CFG.cloudSpeed;

    if (dirLight && CFG.shadows) {
      // la zone d'ombres suit le joueur, calee sur la grille de la shadow map (pas de scintillement)
      const texel = (2 * RANGE) / SIZE;
      const x = cp.dot(right), y = cp.dot(upv);
      const dx = Math.round(x / texel) * texel - x;
      const dy = Math.round(y / texel) * texel - y;
      target.copy(cp).addScaledVector(right, dx).addScaledVector(upv, dy);
      dirLight.target.position.copy(target);
      dirLight.position.copy(target).addScaledVector(sun, 80);
      dirLight.target.updateMatrixWorld();
    }

    if (CFG.shadows && frame % 2 === 0) renderer.shadowMap.needsUpdate = true;
    if (CFG.shadows && CFG.shadowAllMeshes && ++frame % 120 === 0) activerOmbres();   // nouveaux bots, etc.
  });

  W.notify("Beau ciel active");
  console.log("[Beau_Ciel] actif");
})();
