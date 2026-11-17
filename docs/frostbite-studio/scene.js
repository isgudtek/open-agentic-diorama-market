/**
 * scene.js: live Three.js diorama viewport. Procedural geometry only (no external 3D assets).
 * Three.js r187 is loaded as ES modules from jsDelivr; both imports resolve to the same three instance.
 * Units: 1 = 1 cm. Origin at the centre of the base top.
 */
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.187.0/+esm";
import { OrbitControls } from "https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/controls/OrbitControls.js/+esm";

const PALETTE = {
  desert: { ground: [0.83, 0.68, 0.45], ground2: [0.72, 0.55, 0.33], soil: 0x7a5a36, sky: 0xf3dcb4, amp: 1.1 },
  urban: { ground: [0.52, 0.5, 0.47], ground2: [0.4, 0.38, 0.36], soil: 0x4a4540, sky: 0xc9ccd2, amp: 0.25 },
  forest: { ground: [0.32, 0.45, 0.22], ground2: [0.42, 0.36, 0.2], soil: 0x4b3a22, sky: 0xcfe0c6, amp: 0.8 },
  snow: { ground: [0.93, 0.95, 0.98], ground2: [0.8, 0.85, 0.92], soil: 0x7d8796, sky: 0xdfe8f2, amp: 0.9 },
};

function seeded(seedText) {
  let h = 2166136261;
  for (const ch of String(seedText)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const noise2 = (x, z) => Math.sin(x * 0.21) * Math.cos(z * 0.17) + 0.5 * Math.sin(x * 0.47 + z * 0.31) + 0.25 * Math.cos(x * 0.9 - z * 0.7);

export function createViewer(container, { onReady, theme = {} } = {}) {
  const PLINTH = theme.plinth ?? 0x3b2416, PLATE = theme.plate ?? 0xc9a24a;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.9;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.target.set(0, 2, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444033, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
  sun.position.set(40, 70, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  let model = new THREE.Group();
  scene.add(model);
  let leds = [];
  let water = null;
  let current = null;
  const clock = new THREE.Clock();

  function resize() {
    const w = container.clientWidth || 640, hgt = container.clientHeight || 400;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  function disposeGroup(g) {
    g.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => { x.map?.dispose?.(); x.dispose?.(); });
    });
  }

  const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...opts });
  const box = (w, hgt, d, material) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), material); m.castShadow = true; m.receiveShadow = true; return m; };

  function build(s) {
    const pal = PALETTE[s.terrain_type] || PALETTE.desert;
    const R = seeded(`${s.title}|${s.base_width}|${s.base_depth}|${s.terrain_type}`);
    const g = new THREE.Group();
    const W = s.base_width, D = s.base_depth;
    const snow = s.terrain_type === "snow";

    // Plinth: walnut frame with a brass plate.
    const plinth = box(W + 4, 3.2, D + 4, mat(PLINTH, { roughness: 0.55 }));
    plinth.position.y = -2.0 - 1.6;
    g.add(plinth);
    const plate = box(Math.min(12, W * 0.4), 1.1, 0.2, mat(PLATE, { metalness: 0.8, roughness: 0.3 }));
    plate.position.set(0, -3.6, D / 2 + 2.05);
    g.add(plate);
    const soil = box(W, 2, D, mat(pal.soil));
    soil.position.y = -1;
    g.add(soil);

    // Terrain: displaced plane, lowered along trenches and water, flat at the edges so it meets the soil block.
    const segs = Math.round(Math.min(160, Math.max(60, Math.max(W, D) * 2)));
    const geo = new THREE.PlaneGeometry(W, D, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const trenches = s.structures.filter((x) => x.type === "trench");
    const path = s.water_feature ? s.water_path : [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const edge = Math.min(1, (W / 2 - Math.abs(x)) / 3, (D / 2 - Math.abs(z)) / 3);
      let y = (noise2(x, z) * 0.5 + 0.55) * pal.amp * Math.max(0, edge);
      for (const t of trenches) {
        const [lx, lz] = toLocal(x, z, t);
        if (Math.abs(lx) < t.width / 2 && Math.abs(lz) < t.depth / 2 + 0.6) y = -1.1;
      }
      const dw = distToPath(x, z, path);
      if (dw < 3.6) y = Math.min(y, -0.5 + (dw / 3.6) * 0.4);
      pos.setY(i, y);
      const k = Math.min(1, Math.max(0, 0.5 + noise2(x * 1.7, z * 1.3) * 0.35));
      const c = pal.ground.map((v, j) => v * k + pal.ground2[j] * (1 - k));
      colors.set(c, i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    ground.receiveShadow = true;
    g.add(ground);

    // Water: a ribbon along the path (ice on snow bases).
    water = null;
    if (path.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(path.map(([x, z]) => new THREE.Vector3(x, 0, z)));
      const pts = curve.getPoints(80);
      const verts = [], idx = [];
      pts.forEach((p, i) => {
        const tgt = curve.getTangent(Math.min(1, i / (pts.length - 1)));
        const n = new THREE.Vector3(-tgt.z, 0, tgt.x).normalize().multiplyScalar(2.6);
        verts.push(p.x + n.x, -0.18, p.z + n.z, p.x - n.x, -0.18, p.z - n.z);
        if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      });
      const wg = new THREE.BufferGeometry();
      wg.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      wg.setIndex(idx);
      wg.computeVertexNormals();
      water = new THREE.Mesh(wg, new THREE.MeshPhysicalMaterial({ color: snow ? 0xcfeaff : 0x1f7fb0, roughness: snow ? 0.35 : 0.08, metalness: 0.1, transmission: 0, transparent: true, opacity: snow ? 0.92 : 0.82, emissive: snow ? 0x223344 : 0x0a3550, emissiveIntensity: 0.25, side: THREE.DoubleSide, clearcoat: 1 }));
      water.receiveShadow = true;
      g.add(water);
    }

    for (const st of s.structures) g.add(structure(st, s, R));

    // LEDs: emissive bulb + halo + point light (lights capped at 8).
    leds = [];
    s.led_points.slice(0, 8).forEach((p, i) => {
      const col = new THREE.Color(p.color);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), new THREE.MeshBasicMaterial({ color: col }));
      const halo = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
      const light = new THREE.PointLight(col, 60, 22, 1.6);
      const holder = new THREE.Group();
      holder.position.set(p.x, p.y, p.z);
      holder.add(bulb, halo, light);
      g.add(holder);
      const hsl = col.getHSL({}, THREE.SRGBColorSpace);
      leds.push({ light, halo, phase: i * 1.7, fire: hsl.h < 0.14 && hsl.l < 0.62 }); // saturated orange/red flickers like fire
    });

    // Frame the camera to the base.
    const span = Math.max(W, D);
    camera.position.set(span * 0.85, span * 0.75, span * 1.05);
    controls.minDistance = span * 0.5;
    controls.maxDistance = span * 3;
    controls.target.set(0, 1.5, 0);
    sun.shadow.camera.left = -span; sun.shadow.camera.right = span; sun.shadow.camera.top = span; sun.shadow.camera.bottom = -span;
    sun.shadow.camera.updateProjectionMatrix();
    scene.background = new THREE.Color(pal.sky);
    scene.fog = new THREE.Fog(pal.sky, span * 2.5, span * 6);
    controls.update();
    return g;
  }

  function structure(st, s, R) {
    const grp = new THREE.Group();
    grp.position.set(st.x, 0, st.z);
    grp.rotation.y = THREE.MathUtils.degToRad(st.rotation || 0);
    const snow = s.terrain_type === "snow";
    const cap = (w, d, y) => { if (!snow) return; const c = box(w * 1.02, 0.25, d * 1.02, mat(0xf4f7fb)); c.position.y = y; grp.add(c); };
    switch (st.type) {
      case "trench": {
        const floor = box(st.width, 0.3, st.depth, mat(0x3d2c1c));
        floor.position.y = -1.0;
        grp.add(floor);
        for (const side of [-1, 1]) {
          const rev = box(st.width, 1.4, 0.25, mat(0x6b4a2b));
          rev.position.set(0, -0.4, side * st.depth / 2);
          grp.add(rev);
          const berm = box(st.width * 1.02, 0.7, 1.6, mat(s.terrain_type === "desert" ? 0xc49a63 : 0x6d5a40));
          berm.position.set(0, 0.35, side * (st.depth / 2 + 0.9));
          grp.add(berm);
        }
        break;
      }
      case "sandbags": {
        const n = Math.max(2, Math.round(st.width / 1.5));
        const m = mat(0xb59a6a, { roughness: 1 });
        for (let row = 0; row < 2; row++) for (let i = 0; i < n - row; i++) {
          const bag = box(1.4, 0.65, 0.9, m);
          bag.position.set(-st.width / 2 + 0.75 + i * 1.45 + row * 0.72, 0.35 + row * 0.62, 0);
          bag.rotation.y = (R() - 0.5) * 0.2;
          grp.add(bag);
        }
        break;
      }
      case "ruin": {
        const m = mat(0x8a8178);
        const a = box(st.width, st.height, 0.7, m); a.position.set(0, st.height / 2, 0);
        const b = box(0.7, st.height * 0.7, st.depth * 1.6, m); b.position.set(st.width / 2 - 0.35, st.height * 0.35, st.depth * 0.8);
        grp.add(a, b);
        for (let i = 0; i < 3; i++) { const t = box(st.width * (0.15 + R() * 0.2), 0.6 + R(), 0.72, m); t.position.set(-st.width / 2 + R() * st.width, st.height + 0.2, 0); grp.add(t); }
        for (let i = 0; i < 6; i++) { const r = box(0.5 + R(), 0.4 + R() * 0.5, 0.5 + R(), m); r.position.set((R() - 0.5) * st.width, 0.25, 1 + R() * 2); r.rotation.y = R() * 3; grp.add(r); }
        break;
      }
      case "building": {
        const body = box(st.width, st.height, st.depth, mat(snow ? 0x7a5236 : 0xb8a58c));
        body.position.y = st.height / 2;
        grp.add(body);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(st.width, st.depth) * 0.75, st.height * 0.35, 4), mat(snow ? 0xeef3f8 : 0x7a3b2e));
        roof.position.y = st.height + st.height * 0.17;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        grp.add(roof);
        const win = mat(0x22262c, { emissive: 0x2a2010, emissiveIntensity: 0.4 });
        for (let fl = 0; fl < Math.max(1, Math.floor(st.height / 3)); fl++) for (let i = 0; i < 2; i++) {
          const wnd = box(st.width * 0.18, 0.9, 0.12, win);
          wnd.position.set((i ? 1 : -1) * st.width * 0.22, 1.6 + fl * 2.6, st.depth / 2 + 0.05);
          grp.add(wnd);
        }
        break;
      }
      case "tree": {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, st.height * 0.35, 8), mat(0x5a3b22));
        trunk.position.y = st.height * 0.175;
        trunk.castShadow = true;
        grp.add(trunk);
        for (let k = 0; k < 3; k++) {
          const rr = (st.width / 2) * (1 - k * 0.25);
          const cone = new THREE.Mesh(new THREE.ConeGeometry(rr, st.height * 0.4, 9), mat(snow && k === 2 ? 0xf2f6fa : snow ? 0x2f5240 : k % 2 ? 0x2f6b34 : 0x3a7a3c));
          cone.position.y = st.height * (0.42 + k * 0.2);
          cone.castShadow = true;
          grp.add(cone);
        }
        break;
      }
      case "rock": {
        const r = new THREE.Mesh(new THREE.DodecahedronGeometry(st.width / 2, 0), mat(snow ? 0x9aa3ad : 0x8c8273));
        r.scale.set(1, st.height / st.width, st.depth / st.width);
        r.position.y = st.height * 0.3;
        r.castShadow = true; r.receiveShadow = true;
        grp.add(r);
        cap(st.width * 0.6, st.depth * 0.6, st.height * 0.65);
        break;
      }
      case "tank": {
        const olive = mat(s.terrain_type === "desert" ? 0xa58b5a : 0x4d5b3a, { roughness: 0.7 });
        const dark = mat(0x2b2b2b);
        const hull = box(st.width, st.height * 0.45, st.depth * 0.8, olive); hull.position.y = st.height * 0.42;
        const tl = box(st.width * 1.02, st.height * 0.35, st.depth * 0.22, dark); tl.position.set(0, st.height * 0.2, st.depth * 0.42);
        const tr = tl.clone(); tr.position.z = -st.depth * 0.42;
        const turret = new THREE.Mesh(new THREE.CylinderGeometry(st.depth * 0.32, st.depth * 0.36, st.height * 0.3, 14), olive);
        turret.position.set(-st.width * 0.05, st.height * 0.8, 0); turret.castShadow = true;
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, st.width * 0.65, 10), dark);
        barrel.rotation.z = Math.PI / 2; barrel.position.set(st.width * 0.32, st.height * 0.82, 0); barrel.castShadow = true;
        grp.add(hull, tl, tr, turret, barrel);
        break;
      }
      case "wall": {
        const w = box(st.width, st.height, st.depth, mat(0x9b5a43));
        w.position.y = st.height / 2;
        grp.add(w);
        cap(st.width, st.depth, st.height + 0.1);
        break;
      }
      default:
    }
    return grp;
  }

  function render(s) {
    disposeGroup(model);
    scene.remove(model);
    model = build(s);
    scene.add(model);
    current = s;
    let tris = 0;
    model.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
    return { structures: s.structures.length, leds: leds.length, water: !!water, triangles: Math.round(tris) };
  }

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const t = clock.getElapsedTime();
    for (const l of leds) {
      const f = l.fire ? 0.55 + 0.45 * Math.abs(Math.sin(t * 7 + l.phase) * Math.sin(t * 2.3 + l.phase * 2)) : 0.85 + 0.15 * Math.sin(t * 2 + l.phase);
      l.light.intensity = 60 * f;
      l.halo.material.opacity = 0.12 + 0.25 * f;
    }
    if (water) water.material.emissiveIntensity = 0.18 + 0.1 * Math.sin(t * 1.6);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();
  onReady?.();

  return {
    render,
    get scene() { return current; },
    setAutoRotate(v) { controls.autoRotate = !!v; },
    resetView() { if (current) render(current); },
    snapshot() { return renderer.domElement.toDataURL("image/png"); },
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); disposeGroup(model); renderer.dispose(); renderer.domElement.remove(); },
  };
}

function toLocal(x, z, t) {
  const a = THREE.MathUtils.degToRad(t.rotation || 0); // inverse of the group's Y rotation
  const dx = x - t.x, dz = z - t.z;
  return [dx * Math.cos(a) - dz * Math.sin(a), dx * Math.sin(a) + dz * Math.cos(a)];
}
function distToPath(x, z, path) {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1];
    const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
    const u = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / L));
    best = Math.min(best, Math.hypot(x - (ax + u * dx), z - (az + u * dz)));
  }
  return best;
}
