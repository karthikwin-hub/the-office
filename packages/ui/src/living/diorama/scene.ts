import { AGENT_BY_ID, AGENTS, type PersonaNames } from "@office/contracts";
import * as THREE from "three";
import type { Spot } from "../director";
import { personaFor } from "../personas";
import { corridorSpot, doorPath, exitPath, outsideDoor, route, type Layout, type RoomGeo, type V2 } from "./navigate";
import { drawn, fibres, HAND, leafy, makeKit, PRINT, rng, type DrawnTexture, type Kit } from "./paper";
import { Doll, lookFor } from "./people";
import { daylight, istParts, lampsOn, moonAt, moonPhase, sceneDirection, skyColours, sunAt, sundialMarks } from "./sky";
import type { TrailEvent } from "./trail";

/**
 * The pop-up office: a red bahi-khata on a desk, opened, with the office standing up out
 * of the page. Rooms not yet hired for lie flat as a printed outline. The painted sky on
 * the upright page follows the real sun over the business's city, the lamps come on at
 * dusk, and every piece of paper the office handles can be watched on its way.
 *
 * Kept cheap on purpose: Lambert materials only, no point lights (lamplight is painted onto
 * the floor), a shadow map redrawn only when something moved, and shaders compiled before
 * the book opens.
 */

export type OfficeOptions = {
  layout: Layout;
  businessName: string;
  city: string | null;
  where: [lat: number, lon: number];
  hired: string[];
  names: PersonaNames;
  deskCount: number;
  reduced: boolean;
  lite: boolean;
};
export type Conditions = { now: number; tempC: number; cover: number };
export type Hit = { kind: "room"; id: string } | { kind: "vacant"; id: string } | { kind: "desk" } | null;

const RAD = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t: number) => 1 + 2.6 * Math.pow(t - 1, 3) + 1.6 * Math.pow(t - 1, 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The upright sky page is as tall as a full floor's page is deep, and shorter on a small office's page. */
const BD_MAX = 80;
const T = 0.35;
const DESK_TOP = 1.8;
const MAX_SHEETS = 30;

type Segment = { pivot: THREE.Group; fold: THREE.Group; horiz: boolean; owners: string[]; f: number; x: number; z: number; sign: number };
type Tween = { t: number; dur: number; fn: (p: number) => void; res: () => void };
type Pool = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
type Furnished = { group: THREE.Group; stroke?: THREE.Mesh; screen?: THREE.Mesh; blades?: THREE.Group; shade?: THREE.MeshLambertMaterial };

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BLUR = `
  uniform sampler2D tDiffuse; uniform vec2 uDir, uRes; uniform float uFocus, uMax, uBand, uHeat, uTime, uSat; uniform bool uFinal; varying vec2 vUv;
  void main(){
    vec2 uv = vUv;
    if (uFinal) uv.x += uHeat * 0.0016 * sin(uv.y * 160.0 + uTime * 5.0) * smoothstep(0.38, 0.0, uv.y);
    float r = uMax * smoothstep(uBand, uBand + 0.32, abs(uv.y - uFocus)); vec2 o = uDir / uRes * r;
    vec4 c = texture2D(tDiffuse, uv) * 0.2270;
    c += (texture2D(tDiffuse, uv + o * 1.3846) + texture2D(tDiffuse, uv - o * 1.3846)) * 0.3162;
    c += (texture2D(tDiffuse, uv + o * 3.2308) + texture2D(tDiffuse, uv - o * 3.2308)) * 0.0703;
    if (uFinal) {
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      vec2 v = vUv - 0.5; c.rgb *= 1.0 - dot(v, v) * 0.55;
    }
    gl_FragColor = vec4(c.rgb, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export class PopupOffice {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 1, 900);
  private readonly kit: Kit;
  private readonly L: Layout;
  private opts: OfficeOptions;
  private readonly hired: Set<string>;
  private names: PersonaNames;
  private readonly segments: Segment[] = [];
  private readonly furnished = new Map<string, Furnished>();
  private readonly pools = new Map<string, Pool>();
  private readonly corridorPools: Pool[] = [];
  private lampPool!: Pool;
  readonly dolls = new Map<string, Doll>();
  private readonly yardParts: THREE.Object3D[] = [];
  private readonly tweens: Tween[] = [];
  private readonly queue: TrailEvent[] = [];
  private running = false;
  private deskWanted: number;
  private pileShown: number;
  private readonly pileGroup = new THREE.Group();
  private readonly pileMeshes: THREE.Mesh[] = [];
  private readonly seal = new THREE.Group();
  private sealHome = new THREE.Vector3();
  private sealTex!: DrawnTexture;
  private pageTex!: DrawnTexture;
  private texts: DrawnTexture[] = [];
  private readonly backdrop = new THREE.Group();
  private readonly bdH: number;
  private skyMat!: THREE.ShaderMaterial;
  private sunDisc!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private moonDisc!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private moonTex!: DrawnTexture;
  private moonDrawn = -1;
  private readonly hemi = new THREE.HemisphereLight("#cfe0f2", "#d9c9a8", 1);
  private readonly sun = new THREE.DirectionalLight("#fff3dc", 2.5);
  private sunKey = "";
  private clockHands: { h: THREE.Group; m: THREE.Group } | null = null;
  private steam: THREE.Sprite[] = [];
  private kettleAt = new THREE.Vector3();
  private teaAt = new THREE.Vector3();
  private auto!: THREE.Mesh;
  private phone!: THREE.Mesh;
  private confetti!: THREE.InstancedMesh;
  private bits: { p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; s: number; life: number }[] = [];
  private readonly tmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), v: new THREE.Vector3() };
  private opening: { t: number; dur: number } | null = null;
  private shadowDirty = true;
  private time = 0;
  private lite: boolean;
  private rtA: THREE.WebGLRenderTarget | null = null;
  private rtB: THREE.WebGLRenderTarget | null = null;
  private blurH!: THREE.ShaderMaterial;
  private blurV!: THREE.ShaderMaterial;
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly view: { target: THREE.Vector3; dist: number; pitch: number };
  private readonly home: { target: THREE.Vector3; dist: number; pitch: number };
  private glide: {
    from: { target: THREE.Vector3; dist: number; pitch: number };
    to: { target: THREE.Vector3; dist: number; pitch: number };
    t: number;
    dur: number;
    res: () => void;
  } | null = null;
  private readonly pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, opts: OfficeOptions) {
    this.opts = opts;
    this.L = opts.layout;
    this.lite = opts.lite;
    this.hired = new Set(opts.hired.filter((id) => this.L.rooms[id]));
    this.names = opts.names;
    this.deskWanted = this.pileShown = opts.deskCount;
    this.bdH = Math.min(BD_MAX, (this.L.page.x1 - this.L.page.x0) * 0.56);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: opts.lite, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.lite ? 1 : 1.25));
    this.renderer.shadowMap.enabled = !opts.lite;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.kit = makeKit(this.renderer.capabilities.getMaxAnisotropy());
    this.scene.fog = new THREE.Fog(0x241c17, 160, 380);
    const pageMid = (this.L.page.z0 + this.L.page.z1) / 2;
    this.home = { target: new THREE.Vector3(0, 8, pageMid - 4), dist: 170, pitch: 34 * RAD };
    this.view = { target: this.home.target.clone(), dist: this.home.dist, pitch: this.home.pitch };
    this.buildBook();
    this.buildWalls();
    this.buildYard();
    this.buildCorridor();
    for (const id of this.hired) this.addRoom(id);
    this.buildLights();
    this.buildPost();
    this.quadScene.add(this.quad);
    this.closeBook();
  }

  /* ------------------------------------------------------------------ the book */

  private buildBook() {
    const { kit, L } = this;
    const PW = L.page.x1 - L.page.x0,
      PD = L.page.z1 - L.page.z0,
      pz = (L.page.z0 + L.page.z1) / 2;
    const desk = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ color: "#3b2c22" }));
    desk.rotation.x = -Math.PI / 2;
    desk.position.y = -2.5;
    desk.receiveShadow = true;
    this.scene.add(desk);
    const cloth = drawn(1024, 600, (g, w, h) => {
      g.fillStyle = "#8b1a1c";
      g.fillRect(0, 0, w, h);
      const r = rng(11);
      for (let y = 0; y < h; y += 2) {
        g.fillStyle = `rgba(0,0,0,${0.05 + r() * 0.06})`;
        g.fillRect(0, y, w, 1);
      }
      for (let x = 0; x < w; x += 2) {
        g.fillStyle = `rgba(255,220,200,${0.02 + r() * 0.03})`;
        g.fillRect(x, 0, 1, h);
      }
    });
    const clothMat = new THREE.MeshLambertMaterial({ map: cloth });
    this.scene.add(kit.box(PW + 4, 1.4, PD + 4, clothMat, { y: -2.4, z: pz, edges: false }));
    const block = drawn(64, 64, (g, w, h) => {
      g.fillStyle = "#efe6d2";
      g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 3) {
        g.fillStyle = "rgba(120,100,70,.18)";
        g.fillRect(0, y, w, 1);
      }
    });
    this.scene.add(kit.box(PW, 1.0, PD, new THREE.MeshLambertMaterial({ map: block }), { y: -1.0, z: pz, edges: false }));

    const S = 2048 / PW,
      PY = Math.round(2048 * (PD / PW));
    this.pageTex = drawn(2048, PY, (g) => this.drawPage(g, S), { anisotropy: kit.anisotropy });
    const page = new THREE.Mesh(new THREE.PlaneGeometry(PW, PD), new THREE.MeshLambertMaterial({ map: this.pageTex }));
    page.rotation.x = -Math.PI / 2;
    page.position.set((L.page.x0 + L.page.x1) / 2, 0.002, pz);
    page.receiveShadow = true;
    this.scene.add(page);

    // The upright page: the day's sky, painted, with the business's name at its head.
    this.backdrop.position.set(0, 0.2, L.page.z0);
    this.scene.add(this.backdrop);
    const overlay = drawn(2048, Math.round(2048 * (this.bdH / PW)), (g, w, h) => this.drawSkyPage(g, w, h, PW));
    this.texts.push(overlay);
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color() },
        uBot: { value: new THREE.Color() },
        uStars: { value: 0 },
        uTime: { value: 0 },
        uLight: { value: 1 },
        uOverlay: { value: overlay },
        uFibre: { value: kit.fibre },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 uTop, uBot; uniform float uStars, uTime, uLight; uniform sampler2D uOverlay, uFibre; varying vec2 vUv;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        void main(){
          vec3 sky = mix(uBot, uTop, smoothstep(0.08, 0.95, vUv.y));
          vec2 g = vUv * vec2(170.0, 96.0); float h = h21(floor(g));
          float star = step(0.982, h) * smoothstep(0.32, 0.0, length(fract(g) - 0.5)) * (0.55 + 0.45 * sin(uTime * 1.7 + h * 50.0));
          sky += vec3(1.0, 0.96, 0.85) * star * uStars * smoothstep(0.2, 0.45, vUv.y);
          vec4 ov = texture2D(uOverlay, vUv);
          vec3 col = mix(sky, ov.rgb * uLight, ov.a);
          col *= 0.93 + 0.07 * texture2D(uFibre, vUv * vec2(7.0, 4.0)).r;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(PW, this.bdH), this.skyMat);
    sky.position.set(0, this.bdH / 2, 0.02);
    this.backdrop.add(sky);
    const back = kit.box(PW + 4, 1.2, this.bdH + 2, clothMat, { edges: false, cast: false });
    back.geometry.translate(0, -0.6, 0);
    back.rotation.x = Math.PI / 2;
    back.position.set(0, this.bdH / 2, -0.62);
    this.backdrop.add(back);
    const coverTex = drawn(1600, 900, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.strokeStyle = "#d8b25a";
      g.lineWidth = 6;
      g.strokeRect(20, 20, w - 40, h - 40);
      g.lineWidth = 2;
      g.strokeRect(40, 40, w - 80, h - 80);
      g.fillStyle = "#e3c06d";
      g.textAlign = "center";
      fitText(g, this.opts.businessName, w - 200, 110, `700 {}px ${HAND}`);
      g.fillText(this.opts.businessName, w / 2, h / 2 - 20);
      g.font = `400 56px ${HAND}`;
      g.fillText(`Khata ${financialYear(Date.now())}`, w / 2, h / 2 + 70);
    });
    this.texts.push(coverTex);
    const coverText = new THREE.Mesh(new THREE.PlaneGeometry(PW - 10, this.bdH - 10), new THREE.MeshLambertMaterial({ map: coverTex, transparent: true }));
    coverText.position.set(0, this.bdH / 2, -1.25);
    coverText.rotation.set(0, Math.PI, Math.PI);
    this.backdrop.add(coverText);
    const sunTex = drawn(256, 256, (g, w) => {
      g.translate(w / 2, w / 2);
      g.fillStyle = "#ffd27a";
      g.beginPath();
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2,
          rr = i % 2 ? 92 : 122;
        g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
      g.fillStyle = "#fff1c9";
      g.beginPath();
      g.arc(0, 0, 70, 0, 7);
      g.fill();
    });
    this.sunDisc = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, depthWrite: false, fog: false }),
    );
    this.moonTex = drawn(256, 256, () => undefined);
    this.moonDisc = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshBasicMaterial({ map: this.moonTex, transparent: true, depthWrite: false, fog: false }),
    );
    this.sunDisc.renderOrder = this.moonDisc.renderOrder = 2;
    this.backdrop.add(this.sunDisc, this.moonDisc);
  }

  /** Everything flat is printed on the page: the ledger's rules, the yard, the floors, and the rooms not yet hired. */
  private drawPage(g: CanvasRenderingContext2D, S: number) {
    const { L } = this;
    const px = (x: number) => (x - L.page.x0) * S,
      pz = (z: number) => (z - L.page.z0) * S;
    const W = g.canvas.width,
      H = g.canvas.height,
      B = L.building,
      C = L.corridor;
    g.fillStyle = "#f4eedf";
    g.fillRect(0, 0, W, H);
    fibres(g, W, H, 0.9);
    g.strokeStyle = "rgba(80,110,170,.16)";
    g.lineWidth = 1;
    for (let z = L.page.z0 + 1.6; z < L.page.z1; z += 1.6) {
      g.beginPath();
      g.moveTo(0, pz(z));
      g.lineTo(W, pz(z));
      g.stroke();
    }
    g.strokeStyle = "rgba(190,40,40,.55)";
    g.lineWidth = 2;
    for (const x of [L.page.x0 + 2.4, L.page.x0 + 3.1, L.page.x1 - 3.1, L.page.x1 - 2.4]) {
      g.beginPath();
      g.moveTo(px(x), 0);
      g.lineTo(px(x), H);
      g.stroke();
    }
    const gut = g.createLinearGradient(0, 0, 0, pz(L.page.z0 + 6));
    gut.addColorStop(0, "rgba(70,50,30,.32)");
    gut.addColorStop(1, "rgba(70,50,30,0)");
    g.fillStyle = gut;
    g.fillRect(0, 0, W, pz(L.page.z0 + 6));
    // the road along the page's edge
    const Y = L.yard;
    g.fillStyle = "rgba(70,64,58,.16)";
    g.fillRect(px(Y.x0), pz(L.road.z0), px(Y.x1) - px(Y.x0), pz(L.road.z1) - pz(L.road.z0));
    g.strokeStyle = "rgba(250,246,236,.8)";
    g.lineWidth = 3;
    g.setLineDash([26, 22]);
    const mid = (L.road.z0 + L.road.z1) / 2;
    g.beginPath();
    g.moveTo(px(Y.x0), pz(mid));
    g.lineTo(px(Y.x1), pz(mid));
    g.stroke();
    g.setLineDash([]);
    // the yard's paving
    g.fillStyle = "#ebe2cd";
    g.fillRect(px(Y.x0), pz(Y.z0), px(Y.x1) - px(Y.x0), pz(Y.z1) - pz(Y.z0));
    g.strokeStyle = "rgba(120,100,70,.14)";
    g.lineWidth = 1;
    for (let x = Y.x0; x <= Y.x1; x += 3) {
      g.beginPath();
      g.moveTo(px(x), pz(Y.z0));
      g.lineTo(px(x), pz(Y.z1));
      g.stroke();
    }
    for (let z = Y.z0; z <= Y.z1; z += 3) {
      g.beginPath();
      g.moveTo(px(Y.x0), pz(z));
      g.lineTo(px(Y.x1), pz(z));
      g.stroke();
    }
    // stepping stones from the gate to the front door
    const r = rng(5),
      e = L.entrance;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12,
        x = lerp(L.gate.x, e.x - 4.6, t * t),
        z = lerp(L.gate.z - 1, e.z, Math.sqrt(t));
      g.fillStyle = "rgba(170,150,120,.45)";
      g.beginPath();
      g.ellipse(px(x + (r() - 0.5)), pz(z), S * 1.1, S * 0.8, r(), 0, 7);
      g.fill();
    }
    g.fillStyle = "#efe4cf";
    g.fillRect(px(B.x0), pz(B.z0), px(B.x1) - px(B.x0), pz(B.z1) - pz(B.z0));
    // kota stone in the corridor
    for (let x = C.x0; x < C.x1; x += 2.4)
      for (let z = C.z0; z < C.z1; z += 2.4) {
        g.fillStyle = (Math.round(x / 2.4) + Math.round(z / 2.4)) % 2 ? "#ddd5c2" : "#d5ccb7";
        g.fillRect(px(x), pz(z), Math.min(2.4, C.x1 - x) * S + 1, Math.min(2.4, C.z1 - z) * S + 1);
      }
    for (const id of L.order) {
      const rm = L.rooms[id]!;
      if (id === "office-manager") continue;
      if (this.hired.has(id)) {
        g.fillStyle = "#ece3d3";
        g.fillRect(px(rm.x0), pz(rm.z0), px(rm.x1) - px(rm.x0), pz(rm.z1) - pz(rm.z0));
        const rx = rm.cx - 1.2,
          rz = rm.cz - 0.2;
        g.fillStyle = "rgba(122,62,43,.16)";
        g.fillRect(px(rx - 4.2), pz(rz - 3.6), 8.4 * S, 7.2 * S);
        g.strokeStyle = "rgba(122,62,43,.35)";
        g.lineWidth = 2;
        g.setLineDash([6, 5]);
        g.strokeRect(px(rx - 3.8), pz(rz - 3.2), 7.6 * S, 6.4 * S);
        g.setLineDash([]);
      } else {
        g.fillStyle = "#f4eedf";
        g.fillRect(px(rm.x0), pz(rm.z0), px(rm.x1) - px(rm.x0), pz(rm.z1) - pz(rm.z0));
        g.strokeStyle = "rgba(79,70,60,.55)";
        g.lineWidth = 2;
        g.setLineDash([10, 8]);
        g.strokeRect(px(rm.x0 + 0.3), pz(rm.z0 + 0.3), px(rm.x1 - 0.3) - px(rm.x0 + 0.3), pz(rm.z1 - 0.3) - pz(rm.z0 + 0.3));
        g.setLineDash([]);
        g.textAlign = "center";
        g.fillStyle = "rgba(79,70,60,.62)";
        g.font = `700 ${S * 1.9}px ${HAND}`;
        g.fillText(personaFor(id, this.names).name, px(rm.cx), pz(rm.cz - 1.2));
        g.font = `400 ${S * 1.15}px ${HAND}`;
        g.fillText("could sit here", px(rm.cx), pz(rm.cz + 0.6));
        g.fillStyle = "rgba(122,62,43,.7)";
        g.fillText(AGENT_BY_ID[id]?.short ?? id, px(rm.cx), pz(rm.cz + 2.4));
        g.textAlign = "left";
      }
    }
    if (L.alcove) {
      const a = L.alcove,
        vacant = AGENTS.filter((x) => x.id !== "office-manager" && !this.hired.has(x.id)).length;
      g.fillStyle = "#f4eedf";
      g.fillRect(px(a.x0), pz(a.z0), px(a.x1) - px(a.x0), pz(a.z1) - pz(a.z0));
      g.strokeStyle = "rgba(79,70,60,.55)";
      g.lineWidth = 2;
      g.setLineDash([10, 8]);
      g.strokeRect(px(a.x0 + 0.3), pz(a.z0 + 0.3), px(a.x1 - 0.3) - px(a.x0 + 0.3), pz(a.z1 - 0.3) - pz(a.z0 + 0.3));
      g.setLineDash([]);
      g.textAlign = "center";
      g.fillStyle = "rgba(79,70,60,.66)";
      g.font = `700 ${S * 1.7}px ${HAND}`;
      g.fillText("Vacant rooms", px(a.cx), pz(a.cz - 1.2));
      g.font = `400 ${S * 1.15}px ${HAND}`;
      g.fillText(`${vacant} ${vacant === 1 ? "room is" : "rooms are"} empty`, px(a.cx), pz(a.cz + 0.6));
      g.fillStyle = "rgba(122,62,43,.7)";
      g.fillText("hire in the hiring hall", px(a.cx), pz(a.cz + 2.4));
      g.textAlign = "left";
    }
    g.fillStyle = "rgba(60,52,44,.7)";
    g.font = `700 ${S * 1.3}px ${HAND}`;
    for (const w of L.wings) g.fillText(w.text, px(w.x + 0.6), pz(w.z));
    g.fillText("Reception", px(B.x0 + 0.6), pz(B.z0 - 1.6));
    // the sundial's hours, true for today where the business is
    const [lat, lon] = this.opts.where;
    const { day } = istParts(Date.now());
    g.fillStyle = "rgba(60,52,44,.75)";
    g.font = `700 ${S * 1.25}px ${HAND}`;
    g.textAlign = "center";
    const [sx, sz] = L.sundial;
    for (const mk of sundialMarks(day, lat, lon)) g.fillText(String(((mk.hour + 11) % 12) + 1), px(sx + mk.dx), pz(sz + mk.dz) + S * 0.45);
    g.beginPath();
    g.fillStyle = "rgba(60,52,44,.35)";
    g.arc(px(sx), pz(sz), S * 0.9, 0, 7);
    g.fill();
    g.textAlign = "left";
    g.fillStyle = "rgba(60,52,44,.62)";
    g.font = `400 ${S * 1.15}px ${HAND}`;
    const d = new Date(day);
    g.fillText(
      `${d.getUTCDate()} ${d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()} · Folio ${folio(day)} · Dr. / Cr.`,
      px(Y.x0 + 1),
      pz(Y.z1 + 1.7),
    );
  }

  private drawSkyPage(g: CanvasRenderingContext2D, w: number, h: number, PW: number) {
    const s = w / PW,
      top = 9 * s,
      side = 3.2 * s,
      bottom = 3 * s;
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#f4eedf";
    g.fillRect(0, 0, w, top);
    g.fillRect(0, h - bottom, w, bottom);
    g.fillRect(0, 0, side, h);
    g.fillRect(w - side, 0, side, h);
    g.save();
    g.beginPath();
    g.rect(0, 0, w, top);
    g.rect(0, h - bottom, w, bottom);
    g.rect(0, 0, side, h);
    g.rect(w - side, 0, side, h);
    g.clip();
    fibres(g, w, h, 0.8);
    g.strokeStyle = "rgba(80,110,170,.16)";
    for (let y = 1.6 * s; y < top; y += 1.6 * s) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    g.restore();
    g.strokeStyle = "rgba(190,40,40,.55)";
    g.lineWidth = 2;
    g.strokeRect(side - 6, top - 6, w - 2 * side + 12, h - top - bottom + 12);
    g.fillStyle = "#2f2a24";
    fitText(g, this.opts.businessName, w * 0.62, s * 3.6, `700 {}px ${HAND}`);
    g.fillText(this.opts.businessName, side + 2 * s, top - 2.4 * s);
    g.textAlign = "right";
    g.fillStyle = "rgba(47,42,36,.72)";
    g.font = `400 ${s * 2.2}px ${HAND}`;
    g.fillText(`${this.opts.city ? `${this.opts.city} · ` : ""}Khata ${financialYear(Date.now())}`, w - side - 2 * s, top - 2.6 * s);
    g.textAlign = "left";
    // the skyline at the foot of the painting: hills, then a town of water tanks and palms
    const base = h - bottom,
      r = rng(41);
    g.fillStyle = "rgba(95,96,112,1)";
    g.beginPath();
    g.moveTo(side, base - 9 * s);
    for (let x = side; x <= w - side; x += 8) g.lineTo(x, base - (9 + 4 * Math.sin(x / 160) + 2.4 * Math.sin(x / 47 + 1)) * s);
    g.lineTo(w - side, base);
    g.lineTo(side, base);
    g.closePath();
    g.fill();
    g.fillStyle = "rgba(70,68,80,1)";
    let x = side;
    while (x < w - side) {
      const bw = (2.5 + r() * 5) * s,
        bh = (2 + r() * 6.5) * s;
      g.fillRect(x, base - bh, bw, bh);
      if (r() < 0.45) g.fillRect(x + bw * 0.3, base - bh - 1.1 * s, 1.2 * s, 1.1 * s);
      if (r() < 0.12) {
        const cx = x + bw + 0.6 * s;
        g.fillRect(cx, base - 8 * s, 0.25 * s, 8 * s);
        for (let k = 0; k < 6; k++) {
          g.beginPath();
          g.ellipse(cx, base - 8 * s, 2.2 * s, 0.45 * s, (k / 6) * Math.PI, 0, 7);
          g.fill();
        }
      }
      x += bw + r() * 1.5 * s;
    }
  }

  private drawMoon(phase: number) {
    const c = this.moonTex.image as HTMLCanvasElement,
      g = c.getContext("2d")!,
      w = c.width,
      r = 100;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, w);
    g.translate(w / 2, w / 2);
    g.fillStyle = "rgba(60,70,100,.55)";
    g.beginPath();
    g.arc(0, 0, r, 0, 7);
    g.fill();
    const lit = Math.cos(phase * Math.PI * 2),
      waxing = phase < 0.5;
    g.fillStyle = "#f6f0dc";
    g.beginPath();
    g.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, !waxing);
    g.ellipse(0, 0, Math.abs(lit) * r, r, 0, Math.PI / 2, -Math.PI / 2, lit > 0 ? !waxing : waxing);
    g.fill();
    this.moonTex.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ walls that fold up out of the page */

  private addSeg(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    h: number,
    owners: string[],
    o: { windows?: boolean; extras?: (fold: THREE.Group) => void } = {},
  ) {
    const { kit } = this;
    const horiz = Math.abs(z2 - z1) < 1e-6;
    const len = horiz ? x2 - x1 : z2 - z1;
    if (len <= 0.05) return;
    const pivot = new THREE.Group();
    pivot.position.set((x1 + x2) / 2, 0, (z1 + z2) / 2);
    const fold = new THREE.Group();
    pivot.add(fold);
    const piece = (l: number, y0: number, y1: number, off: number) => {
      const m = horiz ? kit.box(l, y1 - y0, T, kit.boxMats(kit.M.wall)) : kit.box(T, y1 - y0, l, kit.boxMats(kit.M.wall));
      m.position.y = y0;
      if (horiz) m.position.x = off;
      else m.position.z = off;
      fold.add(m);
    };
    if (o.windows && len > 7) {
      const n = Math.max(1, Math.floor(len / 6.2)),
        ww = 2.8,
        sill = 1.6,
        head = 4.0;
      piece(len, 0, sill, 0);
      piece(len, head, h, 0);
      let at = -len / 2;
      for (let i = 0; i < n; i++) {
        const c = -len / 2 + (len / n) * (i + 0.5);
        piece(c - ww / 2 - at, sill, head, (at + c - ww / 2) / 2);
        at = c + ww / 2;
      }
      piece(len / 2 - at, sill, head, (at + len / 2) / 2);
    } else piece(len, 0, h, 0);
    o.extras?.(fold);
    const seg: Segment = { pivot, fold, horiz, owners, f: 0, x: (x1 + x2) / 2, z: (z1 + z2) / 2, sign: 1 };
    this.segments.push(seg);
    this.scene.add(pivot);
  }
  private stands = (s: Segment) => s.owners.some((o) => o === "always" || this.hired.has(o));
  private fallSign(s: Segment) {
    const id = s.owners.find((o) => this.L.rooms[o] && !this.hired.has(o)) ?? s.owners.find((o) => this.L.rooms[o]);
    const r = id ? this.L.rooms[id] : undefined;
    if (!r) return 1;
    return s.horiz ? (r.cz > s.z ? 1 : -1) : r.cx > s.x ? 1 : -1;
  }
  private applySeg(s: Segment) {
    const a = (1 - s.f) * (Math.PI / 2) * s.sign;
    if (s.horiz) s.fold.rotation.x = a;
    else s.fold.rotation.z = -a;
  }

  private buildWalls() {
    const { L, kit } = this;
    const B = L.building,
      C = L.corridor,
      R = L.rooms["office-manager"];
    const rows = (row: "top" | "bottom") =>
      L.order
        .map((id) => L.rooms[id]!)
        .filter((r) => r.row === row)
        .sort((a, b) => a.x0 - b.x0);
    const top = rows("top"),
      bottom = rows("bottom");
    if (R) {
      this.addSeg(R.x0, B.z0, R.x1, B.z0, 5.6, [R.id], { windows: true, extras: (f) => f.add(this.makeClock((R.x0 + R.x1) / 2 - (R.x0 + R.x1) / 2)) });
      this.addSeg(R.x0, B.z1, R.x1, B.z1, 1.3, [R.id]);
      const e = L.entrance;
      this.addSeg(B.x0, B.z0, B.x0, e.z - e.half, 4.2, [R.id]);
      this.addSeg(B.x0, e.z + e.half, B.x0, B.z1, 4.2, [R.id]);
      const d = R.door;
      this.addSeg(R.x1, B.z0, R.x1, C.z0, 4.2, [R.id, ...(top[0] ? [top[0].id] : [])]);
      this.addSeg(R.x1, C.z0, R.x1, d.z - d.half, 4.2, [R.id]);
      this.addSeg(R.x1, d.z + d.half, R.x1, C.z1, 4.2, [R.id]);
      this.addSeg(R.x1, C.z1, R.x1, B.z1, 4.2, [R.id, ...(bottom[0] ? [bottom[0].id] : [])]);
    }
    for (const list of [top, bottom]) {
      list.forEach((r, i) => {
        const outer = r.row === "top" ? B.z0 : B.z1;
        this.addSeg(r.x0, outer, r.x1, outer, r.row === "top" ? 5.6 : 1.3, [r.id], { windows: r.row === "top" });
        const d0 = r.door.x - r.door.half,
          d1 = r.door.x + r.door.half;
        this.addSeg(r.x0, r.door.z, d0, r.door.z, 4.2, [r.id], {
          extras: (fold) => {
            const g = new THREE.Group();
            g.add(kit.box(3.1, 3.6, 0.12, kit.M.wood, { x: 1.55 }));
            g.position.set((d0 - r.x0) / 2, 0, 0);
            g.rotation.y = -r.door.inDir * 1.15;
            fold.add(g);
          },
        });
        this.addSeg(d1, r.door.z, r.x1, r.door.z, 4.2, [r.id]);
        const prev = list[i - 1];
        if (prev) this.addSeg(r.x0, r.z0, r.x0, r.z1, 4.2, [prev.id, r.id]);
      });
    }
    const end = (list: RoomGeo[]) => list.filter((r) => Math.abs(r.x1 - B.x1) < 0.05).map((r) => r.id);
    const lastTop = end(top),
      lastBottom = end(bottom);
    // Beside the vacant corner nothing stands; the wall lies flat with it.
    const owners = (ids: string[]) => (ids.length ? ids : L.alcove ? ["(vacant)"] : ["always"]);
    this.addSeg(B.x1, B.z0, B.x1, C.z0, 4.2, owners(lastTop));
    this.addSeg(B.x1, C.z0, B.x1, C.z1, 4.2, ["always"]);
    this.addSeg(B.x1, C.z1, B.x1, B.z1, 4.2, owners(lastBottom));
    for (const s of this.segments) {
      s.sign = this.fallSign(s);
      s.f = 0;
      this.applySeg(s);
    }
  }

  private makeClock(x: number) {
    const g = new THREE.Group();
    g.position.set(x, 4.7, 0.22);
    const face = drawn(128, 128, (c, w) => {
      c.fillStyle = "#fffaf0";
      c.beginPath();
      c.arc(w / 2, w / 2, w / 2 - 2, 0, 7);
      c.fill();
      c.strokeStyle = "#3a332c";
      c.lineWidth = 6;
      c.stroke();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        c.fillStyle = "#3a332c";
        c.fillRect(w / 2 + Math.cos(a) * 48 - 3, w / 2 + Math.sin(a) * 48 - 3, 6, 6);
      }
    });
    g.add(new THREE.Mesh(new THREE.CircleGeometry(0.75, 24), new THREE.MeshLambertMaterial({ map: face })));
    const hand = (l: number, w: number) => {
      const p = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, l, 0.03), this.kit.M.ink);
      m.position.y = l / 2;
      p.add(m);
      p.position.z = 0.03;
      g.add(p);
      return p;
    };
    this.clockHands = { h: hand(0.42, 0.09), m: hand(0.62, 0.06) };
    return g;
  }

  /* ------------------------------------------------------------------ the yard */

  private buildYard() {
    const { L, kit } = this;
    const yard = new THREE.Group();
    this.scene.add(yard);
    const part = <O extends THREE.Object3D>(o: O) => {
      yard.add(o);
      this.yardParts.push(o);
      return o;
    };
    const wall = (x1: number, z1: number, x2: number, z2: number) => {
      const horiz = Math.abs(z2 - z1) < 1e-6,
        len = horiz ? x2 - x1 : z2 - z1;
      const m = horiz ? kit.box(len, 1.5, 0.5, kit.boxMats(kit.M.wall)) : kit.box(0.5, 1.5, len, kit.boxMats(kit.M.wall));
      m.position.set((x1 + x2) / 2, 0, (z1 + z2) / 2);
      part(m);
    };
    const Y = L.yard,
      G = L.gate;
    wall(Y.x0, Y.z0, Y.x1, Y.z0);
    wall(Y.x0, Y.z0, Y.x0, Y.z1);
    wall(Y.x1, Y.z0, Y.x1, Y.z1);
    wall(Y.x0, Y.z1, G.x - G.half, Y.z1);
    wall(G.x + G.half, Y.z1, Y.x1, Y.z1);
    const gate = part(new THREE.Group());
    gate.position.set(G.x, 0, G.z);
    gate.add(kit.box(1.4, 4.2, 1.4, kit.boxMats(kit.M.wall), { x: -G.half }), kit.box(1.4, 4.2, 1.4, kit.boxMats(kit.M.wall), { x: G.half }));
    const boardTex = drawn(1024, 180, (g, w, h) => {
      g.fillStyle = "#f6f1e4";
      g.fillRect(0, 0, w, h);
      fibres(g, w, h, 0.8);
      g.strokeStyle = "#7a3e2b";
      g.lineWidth = 8;
      g.strokeRect(6, 6, w - 12, h - 12);
      g.fillStyle = "#7a3e2b";
      g.textAlign = "center";
      const name = this.opts.businessName.toUpperCase();
      fitText(g, name, w - 60, 84, `700 {}px ${PRINT}`);
      g.fillText(name, w / 2, h / 2 + 28);
    });
    this.texts.push(boardTex);
    const board = new THREE.Mesh(new THREE.BoxGeometry(G.half * 2 + 1.6, 2.2, 0.3), [
      kit.M.wall,
      kit.M.wall,
      kit.M.poche,
      kit.M.wall,
      new THREE.MeshLambertMaterial({ map: boardTex }),
      kit.M.wall,
    ]);
    board.position.set(0, 5.3, 0);
    board.castShadow = true;
    gate.add(board);
    // the lamp post that is also a sundial
    const lamp = part(new THREE.Group());
    lamp.position.set(L.sundial[0], 0, L.sundial[1]);
    lamp.add(kit.cyl(0.16, 0.22, 7.2, kit.M.ink, 10));
    lamp.add(kit.box(1.0, 0.7, 1.0, [kit.M.ink, kit.M.ink, kit.M.ink, kit.M.lampShade, kit.M.ink, kit.M.ink], { y: 7.0, edges: false }));
    this.lampPool = this.pool(L.sundial[0], L.sundial[1], 9);
    // the neem tree
    const tree = part(new THREE.Group());
    tree.position.set(L.tree[0], 0, L.tree[1]);
    tree.add(kit.cyl(0.45, 0.65, 6.2, kit.M.wood, 8));
    for (let k = 0; k < 3; k++) {
      const c = kit.cutout(13, 10, leafy(20 + k));
      c.position.y = 4.4;
      c.rotation.y = (k / 3) * Math.PI;
      tree.add(c);
    }
    // the tulsi by the front door
    const tulsi = part(new THREE.Group());
    tulsi.position.set(L.tulsi[0], 0, L.tulsi[1]);
    tulsi.add(kit.box(1.4, 1.2, 1.4, kit.M.pot, { edges: false }));
    for (let k = 0; k < 2; k++) {
      const c = kit.cutout(2.2, 2.2, leafy(30 + k));
      c.position.y = 1.1;
      c.rotation.y = (k * Math.PI) / 2;
      tulsi.add(c);
    }
    // the chai cart outside the gate, steaming
    const cart = part(new THREE.Group());
    cart.position.set(L.cart[0], 0, L.cart[1]);
    cart.add(
      kit.box(4.2, 1.6, 2, [kit.M.wall, kit.M.wall, kit.M.wood, kit.M.wall, new THREE.MeshLambertMaterial({ color: "#2f6f8f" }), kit.M.wall], { y: 0.7 }),
    );
    for (const x of [-1.4, 1.4]) {
      const w = kit.cyl(0.7, 0.7, 0.25, kit.M.ink, 14, { x, z: 1.05 });
      w.rotation.x = Math.PI / 2;
      cart.add(w);
    }
    const kettle = kit.cyl(0.42, 0.5, 0.8, kit.M.brass, 12, { x: -0.8, y: 2.3 });
    cart.add(kettle);
    cart.add(
      kit.box(5, 0.15, 2.8, [kit.M.chair, kit.M.chair, new THREE.MeshLambertMaterial({ color: "#c9452e" }), kit.M.chair, kit.M.chair, kit.M.chair], { y: 4.1 }),
    );
    cart.add(kit.cyl(0.08, 0.08, 2.5, kit.M.ink, 6, { x: -2.3, y: 1.6, z: -1.2 }), kit.cyl(0.08, 0.08, 2.5, kit.M.ink, 6, { x: 2.3, y: 1.6, z: -1.2 }));
    this.kettleAt.set(L.cart[0] - 0.8, 3.1, L.cart[1]);
    for (let i = 0; i < 7; i++) this.addSteam(i / 7, "cart");
    // a scooter parked in the yard
    const scooter = part(
      kit.cutout(4.4, 2.8, (g, w, h) => {
        g.fillStyle = "#d24b3a";
        g.beginPath();
        g.ellipse(w * 0.52, h * 0.55, w * 0.32, h * 0.2, 0, 0, 7);
        g.fill();
        g.fillRect(w * 0.18, h * 0.22, w * 0.08, h * 0.42);
        g.fillStyle = "#2f2a24";
        g.fillRect(w * 0.12, h * 0.18, w * 0.22, h * 0.06);
        for (const x of [0.2, 0.8]) {
          g.beginPath();
          g.arc(w * x, h * 0.82, h * 0.15, 0, 7);
          g.fill();
        }
      }),
    );
    scooter.position.set(L.scooter[0], 0, L.scooter[1]);
    scooter.rotation.y = -0.4;
    // the auto-rickshaw that passes now and then; it casts no shadow, so its trips never redraw the shadow map
    this.auto = kit.cutout(
      6.6,
      4.4,
      (g, w, h) => {
        g.fillStyle = "#2f2a24";
        for (const x of [0.2, 0.78]) {
          g.beginPath();
          g.arc(w * x, h * 0.84, h * 0.13, 0, 7);
          g.fill();
        }
        g.fillStyle = "#2e7d4f";
        g.beginPath();
        g.moveTo(w * 0.08, h * 0.78);
        g.lineTo(w * 0.1, h * 0.42);
        g.quadraticCurveTo(w * 0.3, h * 0.36, w * 0.5, h * 0.4);
        g.lineTo(w * 0.92, h * 0.5);
        g.lineTo(w * 0.94, h * 0.78);
        g.closePath();
        g.fill();
        g.fillStyle = "#f2c230";
        g.beginPath();
        g.moveTo(w * 0.12, h * 0.42);
        g.quadraticCurveTo(w * 0.35, h * 0.06, w * 0.88, h * 0.12);
        g.lineTo(w * 0.9, h * 0.48);
        g.lineTo(w * 0.12, h * 0.44);
        g.fill();
        g.fillStyle = "rgba(240,248,255,.7)";
        g.fillRect(w * 0.18, h * 0.24, w * 0.18, h * 0.16);
      },
      false,
    );
    this.auto.rotation.y = Math.PI;
    this.auto.visible = false;
    this.scene.add(this.auto);
  }

  private addSteam(t: number, where: "cart" | "tea") {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.kit.steamTex, transparent: true, depthWrite: false, opacity: 0.5 }));
    s.userData = { t, where };
    this.steam.push(s);
    this.scene.add(s);
  }

  /** Lamplight painted onto the floor: a warm pool that brightens as the evening comes. */
  private pool(x: number, z: number, r: number): Pool {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(r * 2, r * 2),
      new THREE.MeshBasicMaterial({ map: this.kit.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.08, z);
    m.renderOrder = 3;
    m.visible = false;
    this.scene.add(m);
    return m;
  }

  /* ------------------------------------------------------------------ the corridor: tea, your desk, the pile, the seal */

  private buildCorridor() {
    const { L, kit } = this;
    const [tx, tz] = L.tea;
    const tea = new THREE.Group();
    tea.add(kit.box(2.6, 1.6, 1.2, kit.M.wood, { x: tx, z: tz }));
    tea.add(kit.cyl(0.32, 0.38, 0.6, kit.M.brass, 12, { x: tx - 0.6, y: 1.6, z: tz }));
    for (let k = 0; k < 3; k++) tea.add(kit.cyl(0.16, 0.13, 0.28, kit.M.sheet, 10, { x: tx + 0.2 + k * 0.4, y: 1.6, z: tz + 0.1 }));
    this.scene.add(tea);
    this.teaAt.set(tx - 0.6, 2.3, tz);
    for (let i = 0; i < 4; i++) this.addSteam(i / 4, "tea");
    const [dx, dz] = L.desk;
    const desk = new THREE.Group();
    desk.add(kit.box(2.4, DESK_TOP, 3.6, kit.M.wood, { x: dx, z: dz }));
    desk.add(kit.box(1.3, 1.0, 1.3, kit.M.chair, { x: dx + 2.1, z: dz }));
    desk.add(kit.box(0.16, 1.6, 1.3, kit.M.chair, { x: dx + 2.8, z: dz, y: 1.0 }));
    desk.add(kit.cyl(0.5, 0.4, 1.1, kit.M.ink, 12, { x: dx + 0.2, z: dz + 2.7 })); // the bin
    this.scene.add(desk);
    this.sealTex = drawn(256, 256, (g, w) => {
      g.clearRect(0, 0, w, w);
      g.translate(w / 2, w / 2);
      g.strokeStyle = g.fillStyle = "#a3271d";
      g.lineWidth = 10;
      g.beginPath();
      g.arc(0, 0, 112, 0, 7);
      g.stroke();
      g.lineWidth = 4;
      g.beginPath();
      g.arc(0, 0, 92, 0, 7);
      g.stroke();
      g.textAlign = "center";
      g.font = `700 46px ${PRINT}`;
      g.fillText("CHECKED", 0, 14);
      g.font = `700 22px ${PRINT}`;
      g.fillText("BY YOU", 0, 48);
      g.font = `400 20px ${HAND}`;
      g.fillText(new Date(istParts(Date.now()).day).toISOString().slice(0, 10), 0, -34);
    });
    this.texts.push(this.sealTex);
    this.seal.position.set(dx - 0.2, DESK_TOP, dz - 1.25);
    this.seal.add(kit.cyl(0.55, 0.55, 0.32, kit.M.brass, 20));
    this.seal.add(kit.cyl(0.2, 0.28, 1.0, kit.M.wood, 12, { y: 0.32 }));
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 10), kit.M.wood);
    knob.position.y = 1.42;
    knob.castShadow = true;
    this.seal.add(knob);
    this.sealHome.copy(this.seal.position);
    this.scene.add(this.seal);
    this.pileGroup.position.set(dx - 0.2, DESK_TOP, dz + 0.55);
    this.scene.add(this.pileGroup);
    this.layoutPile();
    this.confetti = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.14, 10),
      new THREE.MeshLambertMaterial({ color: "#fffdf7", side: THREE.DoubleSide }),
      160,
    );
    this.confetti.frustumCulled = false;
    this.confetti.count = 0;
    this.scene.add(this.confetti);
    const c = L.corridor;
    for (const f of [0.2, 0.5, 0.8]) this.corridorPools.push(this.pool(lerp(c.x0, c.x1, f), L.lane, 7));
  }

  private sheet(agentId: string) {
    const edge = new THREE.MeshLambertMaterial({ color: lookFor(agentId).outfit });
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.07, 2.0), [edge, edge, this.kit.M.sheet, this.kit.M.sheet, edge, edge]);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
  /** The pile on your desk, one sheet per thing waiting, up to thirty. */
  private layoutPile() {
    const want = Math.min(MAX_SHEETS, Math.max(0, this.pileShown));
    while (this.pileMeshes.length < want) {
      const m = this.sheet(["accountant", "credit-controller", "office-manager", "auditor"][this.pileMeshes.length % 4]!);
      this.pileGroup.add(m);
      this.pileMeshes.push(m);
    }
    while (this.pileMeshes.length > want) this.pileGroup.remove(this.pileMeshes.pop()!);
    this.pileMeshes.forEach((m, i) => {
      m.position.set(Math.sin(i * 2.1) * 0.08, 0.04 + i * 0.075, Math.cos(i * 1.7) * 0.08);
      m.rotation.set(0, Math.sin(i * 3.3) * 0.12, 0);
    });
    this.shadowDirty = true;
  }

  /* ------------------------------------------------------------------ rooms and people */

  private addRoom(id: string) {
    const r = this.L.rooms[id];
    if (!r) return;
    this.furnish(r);
    this.pools.set(id, this.pool(r.row === "front" ? r.cx : r.cx - 1.2, r.row === "front" ? this.L.lane - 4 : r.cz, r.row === "front" ? 10 : 9));
    const d = new Doll(id, this.kit, r.home, exitPath(this.L, id));
    this.dolls.set(id, d);
    this.scene.add(d.root);
  }

  private furnish(r: RoomGeo) {
    const { kit, L } = this;
    const g = new THREE.Group();
    const f: Furnished = { group: g };
    const add = <O extends THREE.Object3D>(o: O) => {
      g.add(o);
      return o;
    };
    if (r.row === "front") {
      const cx = r.cx,
        lz = L.lane;
      add(kit.box(9.4, DESK_TOP, 1.4, kit.M.desk, { x: cx - 0.5, z: lz - 7.2 }));
      add(kit.box(1.4, DESK_TOP, 4.2, kit.M.desk, { x: cx - 5.5, z: lz - 9.8 }));
      add(kit.box(1.3, 1.0, 1.3, kit.M.chair, { x: cx, z: lz - 9.6 }));
      add(kit.box(1.3, 1.6, 0.16, kit.M.chair, { x: cx, z: lz - 10.4, y: 1.0 }));
      this.phone = add(kit.box(0.7, 0.25, 0.5, kit.M.ink.clone(), { x: cx - 2.8, y: DESK_TOP, z: lz - 7.2 }));
      add(kit.box(1.6, 0.12, 1.1, kit.M.wood, { x: cx + 2.4, y: DESK_TOP, z: lz - 7.2 }));
      add(kit.box(6, 1.2, 1.8, kit.M.wood, { x: cx, z: lz + 14 }));
      add(kit.cyl(0.6, 0.6, 2.4, new THREE.MeshLambertMaterial({ color: "#5a8fb0" }), 14, { x: cx - 6.4, z: lz + 18 }));
      const p = add(new THREE.Group());
      p.position.set(r.x1 - 1.9, 0, r.z0 + 2.4);
      p.add(kit.cyl(0.7, 0.55, 1.1, kit.M.pot, 10));
      const l = kit.cutout(2.4, 2.6, leafy(51));
      l.position.y = 1;
      p.add(l);
    } else {
      const dx = r.cx - 1.2,
        dz = r.cz + 0.8;
      add(kit.box(3.8, DESK_TOP, 1.9, kit.M.desk, { x: dx, z: dz }));
      add(kit.box(1.3, 0.06, 0.85, kit.M.ink, { x: dx + 0.6, y: DESK_TOP, z: dz - 0.2, edges: false }));
      const scr = add(kit.box(1.3, 0.9, 0.06, kit.M.screen.clone(), { x: dx + 0.6, y: DESK_TOP + 0.03, z: dz + 0.15, edges: false }));
      scr.rotation.x = -0.2;
      f.screen = scr;
      add(kit.box(1.3, 1.0, 1.3, kit.M.chair, { x: dx, z: r.cz - 1.2 }));
      add(kit.box(1.3, 1.6, 0.16, kit.M.chair, { x: dx, z: r.cz - 2.0, y: 1.0 }));
      const shelf = add(new THREE.Group());
      shelf.position.set(r.x0 + 0.75, 0, r.cz - 4.5);
      shelf.add(kit.box(0.8, 3.2, 3.2, kit.M.wood));
      const BIND = ["#7a3e2b", "#c9962c", "#2f6f8f", "#4f463c", "#a33a2a", "#6a7f3e"];
      for (let s = 0; s < 2; s++)
        for (let k = 0; k < 6; k++)
          shelf.add(
            kit.box(0.5, 0.9, 0.36, new THREE.MeshLambertMaterial({ color: BIND[(k + s * 2) % 6]! }), {
              x: 0.5,
              y: 0.4 + s * 1.4,
              z: -1.2 + k * 0.45,
              edges: false,
            }),
          );
      const sheet = add(new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.3), kit.M.sheet));
      sheet.rotation.set(-Math.PI / 2, 0, 0.12);
      sheet.position.set(dx - 0.8, DESK_TOP + 0.02, dz - 0.1);
      const stroke = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.14), kit.M.highlight);
      stroke.geometry.translate(0.4, 0, 0);
      stroke.position.set(-0.4, 0.15, 0.002);
      sheet.add(stroke);
      f.stroke = stroke;
      const lamp = add(new THREE.Group());
      lamp.position.set(dx - 1.6, DESK_TOP, dz + 0.4);
      lamp.add(kit.cyl(0.05, 0.05, 0.9, kit.M.ink, 6));
      const shadeMat = kit.M.lampShade.clone();
      lamp.add(kit.cyl(0.18, 0.4, 0.35, shadeMat, 12, { y: 0.85 }));
      f.shade = shadeMat;
      const fan = add(new THREE.Group());
      fan.position.set(dx + 1.55, DESK_TOP, dz + 0.2);
      fan.add(kit.cyl(0.22, 0.28, 0.2, kit.M.ink, 10), kit.cyl(0.05, 0.05, 0.7, kit.M.ink, 6));
      const blades = new THREE.Group();
      blades.position.set(0, 0.85, 0.12);
      for (let k = 0; k < 3; k++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.02), kit.M.sheet);
        b.geometry.translate(0, 0.25, 0);
        b.rotation.z = (k * Math.PI * 2) / 3;
        blades.add(b);
      }
      fan.add(blades);
      f.blades = blades;
      const plant = add(new THREE.Group());
      plant.position.set(r.x1 - 1.4, 0, r.row === "top" ? r.z0 + 1.6 : r.z1 - 1.6);
      plant.add(kit.cyl(0.55, 0.45, 0.9, kit.M.pot, 10));
      const pl = kit.cutout(2.0, 2.2, leafy(r.id.length * 7));
      pl.position.y = 0.8;
      plant.add(pl);
    }
    this.scene.add(g);
    this.furnished.set(r.id, f);
  }
  private growRoom(id: string, s: number) {
    const f = this.furnished.get(id);
    if (!f) return;
    f.group.scale.set(1, Math.max(0.001, s), 1);
    f.group.visible = s > 0.01;
  }

  /** Where the director wants someone: their chair, a colleague's door, or a cup at the tea point. */
  setWanted(agentId: string, spot: Spot) {
    const d = this.dolls.get(agentId);
    if (!d) return;
    if (spot.kind === "home") d.wanted = exitPath(this.L, agentId);
    else if (spot.kind === "door") d.wanted = outsideDoor(this.L, spot.agentId).length ? outsideDoor(this.L, spot.agentId) : exitPath(this.L, agentId);
    else d.wanted = corridorSpot(this.L, this.L.teaSpots[spot.slot]);
    d.intent = spot;
  }

  /* ------------------------------------------------------------------ lights and the miniature look */

  private buildLights() {
    this.scene.add(this.hemi);
    this.sun.castShadow = !this.lite;
    const size = Math.min(window.innerWidth, window.innerHeight) < 700 ? 1024 : 2048;
    this.sun.shadow.mapSize.set(size, size);
    Object.assign(this.sun.shadow.camera, { left: -88, right: 88, top: 88, bottom: -88, near: 10, far: 320 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.target.position.set(0, 0, (this.L.page.z0 + this.L.page.z1) / 2 - 2);
    this.scene.add(this.sun, this.sun.target);
  }

  private buildPost() {
    const uniforms = () => ({
      tDiffuse: { value: null as THREE.Texture | null },
      uDir: { value: new THREE.Vector2(1, 0) },
      uRes: { value: new THREE.Vector2(1, 1) },
      uFocus: { value: 0.45 },
      uMax: { value: 3 },
      uBand: { value: 0.13 },
      uHeat: { value: 0 },
      uTime: { value: 0 },
      uSat: { value: 1.12 },
      uFinal: { value: false },
    });
    this.blurH = new THREE.ShaderMaterial({ uniforms: uniforms(), vertexShader: VS, fragmentShader: BLUR, toneMapped: false });
    this.blurV = new THREE.ShaderMaterial({ uniforms: uniforms(), vertexShader: VS, fragmentShader: BLUR });
    this.blurV.uniforms.uDir!.value.set(0, 1);
    this.blurV.uniforms.uFinal!.value = true;
  }

  /** Drop the shadows and the miniature blur, for a machine that cannot keep up. */
  setLite(on: boolean) {
    if (this.lite === on) return;
    this.lite = on;
    this.renderer.shadowMap.enabled = !on;
    this.sun.castShadow = !on;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, on ? 1 : 1.25));
    this.resize(this.width, this.height);
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) for (const m of [o.material].flat()) m.needsUpdate = true;
    });
  }

  resize(w: number, h: number) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    const hf = 2 * Math.atan(Math.tan((this.camera.fov * RAD) / 2) * this.camera.aspect);
    const half = (this.L.yard.x1 - this.L.yard.x0) / 2 - 2;
    this.home.dist = Math.max(60, half / Math.tan(hf / 2));
    // A resize keeps a room in view if one is open; otherwise the whole office is refitted.
    if (!this.glide && !this.focusedOn) this.view.dist = this.opening ? this.home.dist * 1.18 : this.home.dist;
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtA = this.rtB = null;
    if (!this.lite) {
      const pr = this.renderer.getPixelRatio(),
        W = Math.floor(this.width * pr),
        H = Math.floor(this.height * pr);
      this.rtA = new THREE.WebGLRenderTarget(W, H, { samples: 2, type: THREE.HalfFloatType });
      this.rtB = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType });
      this.blurH.uniforms.uRes!.value.set(W, H);
      this.blurV.uniforms.uRes!.value.set(W, H);
    }
    this.shadowDirty = true;
  }

  /** Builds every shader before the book opens, so nothing stalls the opening. */
  async compile() {
    // Let the drawn ledger reach the screen first; then build every shader, hidden things included, in one go.
    await sleep(30);
    this.camera.position.set(0, 90, 150);
    this.camera.lookAt(this.home.target);
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    this.renderer.compile(this.scene, this.camera);
    for (const o of hidden) o.visible = false;
    for (const m of [this.blurH, this.blurV]) {
      this.quad.material = m;
      this.renderer.compile(this.quadScene, this.quadCam);
    }
  }

  /** Redraw the printed words once the handwriting font has arrived. */
  redrawText() {
    this.pageTex.redraw();
    for (const t of this.texts) t.redraw();
    this.shadowDirty = true;
  }
  /** The city and its position, once the weather has said where the viewer is. */
  setPlace(city: string | null, where: [number, number]) {
    if (city === this.opts.city && where[0] === this.opts.where[0] && where[1] === this.opts.where[1]) return;
    this.opts = { ...this.opts, city, where };
    this.redrawText();
  }
  setNames(names: PersonaNames) {
    if (JSON.stringify(names) === JSON.stringify(this.names)) return;
    this.names = names;
    this.pageTex.redraw();
  }

  /* ------------------------------------------------------------------ opening the book */

  private closeBook() {
    this.backdrop.rotation.x = Math.PI / 2;
    for (const s of this.segments) {
      s.f = 0;
      this.applySeg(s);
    }
    for (const p of this.yardParts) p.scale.y = 0.001;
    for (const id of this.hired) this.growRoom(id, 0);
    for (const d of this.dolls.values()) {
      d.pop = 0.001;
      d.place();
    }
  }
  /** Opens the book; `instant` when it was already open on this visit and is only being rebuilt. */
  open(instant = false) {
    this.opening = { t: 0, dur: this.opts.reduced || instant ? 0.001 : 3.2 };
    this.closeBook();
    this.view.dist = this.home.dist * 1.18;
  }
  get opened() {
    return !this.opening && this.backdrop.rotation.x < 0;
  }
  private stepOpening(dt: number) {
    if (!this.opening) return;
    const op = this.opening;
    op.t += dt;
    const o = clamp(op.t / op.dur, 0, 1);
    this.backdrop.rotation.x = lerp(Math.PI / 2, -0.1, easeInOut(clamp((o - 0.06) / 0.42, 0, 1)));
    const rise = (o - 0.4) / 0.5;
    const span = this.L.building.x1 - this.L.building.x0;
    for (const s of this.segments) {
      if (!this.stands(s)) {
        s.f = 0;
        this.applySeg(s);
        continue;
      }
      const d = 0.04 + 0.5 * ((s.x - this.L.building.x0) / span);
      s.f = easeOutBack(clamp((rise - d) / 0.42, 0, 1));
      this.applySeg(s);
    }
    for (const p of this.yardParts) p.scale.y = Math.max(0.001, easeOutBack(clamp((rise - 0.1) / 0.5, 0, 1)));
    for (const id of this.hired) this.growRoom(id, easeOutBack(clamp((rise - 0.45) / 0.35, 0, 1)));
    const pp = easeOutBack(clamp((o - 0.86) / 0.14, 0, 1));
    for (const d of this.dolls.values()) {
      d.pop = Math.max(0.001, pp);
      d.place();
    }
    if (!this.glide) this.view.dist = lerp(this.home.dist * 1.18, this.home.dist, easeInOut(o));
    this.shadowDirty = true;
    if (o >= 1) {
      this.opening = null;
      for (const s of this.segments) {
        s.f = this.stands(s) ? 1 : 0;
        this.applySeg(s);
      }
    }
  }

  /* ------------------------------------------------------------------ the paper trail */

  private tween(dur: number, fn: (p: number) => void): Promise<void> {
    return new Promise((res) => this.tweens.push({ t: 0, dur: this.opts.reduced ? 0.001 : dur, fn, res }));
  }
  private wait(ms: number) {
    return sleep(this.opts.reduced ? 0 : ms);
  }

  /** The number of things on the owner's desk; the pile catches up once anything being carried has arrived. */
  setDeskCount(n: number) {
    this.deskWanted = n;
    if (!this.running && !this.queue.length && this.pileShown !== n) {
      this.pileShown = n;
      this.layoutPile();
    }
  }

  /** Something to act out; one at a time, in order. */
  play(ev: TrailEvent) {
    this.queue.push(ev);
    void this.pump();
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      // Nothing is acted out until the book has opened.
      while (!this.opened && !this.disposed) await sleep(200);
      while (this.queue.length && !this.disposed) {
        const ev = this.queue.shift()!;
        try {
          await this.act(ev);
        } catch {
          /* a scene that could not be acted out is skipped; the office's own data is untouched */
        }
      }
    } finally {
      this.running = false;
      if (!this.disposed && this.pileShown !== this.deskWanted) {
        this.pileShown = this.deskWanted;
        this.layoutPile();
      }
    }
  }

  private async act(ev: TrailEvent) {
    if (this.opts.reduced) {
      if (ev.kind === "hire") this.hire(ev.agentId, true);
      if (ev.kind === "leave") this.leave(ev.agentId, true);
      return;
    }
    if (ev.kind === "arrive") return this.arrive(ev.agentId, ev.channel);
    if (ev.kind === "toDesk") return this.toDesk(ev.agentId, ev.count);
    if (ev.kind === "decide") return this.decide(ev.agentId, ev.status);
    if (ev.kind === "hire") return this.hire(ev.agentId, false);
    if (ev.kind === "leave") return this.leave(ev.agentId, false);
  }

  /** A person stops what they were doing to carry something, then goes back to where the director wants them. */
  private async errand(d: Doll, to: V2[], what: THREE.Object3D | null, then?: () => void) {
    d.scripted = true;
    d.carry(what);
    await d.walk(route(d.spot, to), false, to);
    d.carry(null);
    then?.();
    d.scripted = false;
  }

  private async arrive(agentId: string, channel: string) {
    const L = this.L,
      reception = L.rooms["office-manager"],
      kavya = this.dolls.get("office-manager");
    const target = L.rooms[agentId];
    if (!target) return;
    const viaReception = Boolean(kavya && reception && agentId !== "office-manager");
    if (channel === "email") {
      const tray =
        reception && kavya
          ? new THREE.Vector3(reception.cx + 2.4, 1.95, L.lane - 7.2)
          : new THREE.Vector3(target.door.x, 1.5, target.door.z + target.door.inDir * 1.8);
      await this.flyPlane(tray, Boolean(reception && kavya));
    } else if (channel === "whatsapp" && kavya) {
      const at = this.phone.position.clone();
      await this.tween(1.6, (p) => {
        this.phone.position.set(at.x + Math.sin(p * 80) * 0.06 * (1 - p), at.y + (Math.sin(p * 40) > 0 ? 0.05 : 0), at.z);
        (this.phone.material as THREE.MeshLambertMaterial).emissive.set(p < 1 && Math.sin(p * 30) > 0 ? "#3fbf6f" : "#000000");
      });
      this.phone.position.copy(at);
    } else {
      await this.dropSheet(agentId);
      return;
    }
    if (viaReception && kavya) {
      await this.wait(1200);
      const sheet = this.sheet(agentId);
      sheet.scale.set(0.8, 1, 0.8);
      await this.errand(kavya, doorPath(L, agentId), sheet);
    }
  }

  private async flyPlane(to: THREE.Vector3, viaEntrance: boolean) {
    const L = this.L,
      B = L.building,
      e = L.entrance;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [0, 0, 1.3, -0.8, 0.06, -0.6, 0, 0, -0.6, 0, 0, 1.3, 0, 0, -0.6, 0.8, 0.06, -0.6, 0, 0, 1.3, 0, -0.3, -0.6, 0, 0, -0.6],
        3,
      ),
    );
    geo.computeVertexNormals();
    const plane = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: "#fffdf7", side: THREE.DoubleSide }));
    plane.castShadow = true;
    this.scene.add(plane);
    const pts: [number, number, number][] = [
      [B.x0 - 52, 34, B.z1 + 25],
      [B.x0 - 2, 24, B.z1 + 23],
      [-10, 20, B.z1 + 9],
      [22, 18, L.lane + 8],
      [6, 15, L.lane - 14],
      [B.x0 + 22, 11, L.lane - 18],
      [B.x0 - 13.6, 7, L.lane - 6],
    ];
    if (viaEntrance) pts.push([B.x0 - 9.6, 3.5, e.z], [B.x0 - 1.6, 2.2, e.z], [to.x - 5.4, 2.6, to.z + 3.7]);
    else pts.push([B.x0 - 9.6, 3.5, e.z], [B.x0 + 2, 2.6, L.lane], [to.x, 2.4, L.lane]);
    pts.push([to.x, to.y, to.z]);
    const curve = new THREE.CatmullRomCurve3(
      pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      false,
      "catmullrom",
      0.4,
    );
    const tan = new THREE.Vector3(),
      prev = new THREE.Vector3(),
      look = new THREE.Vector3();
    await this.tween(6.2, (p) => {
      const e2 = 1 - Math.pow(1 - p, 1.6);
      curve.getPointAt(e2, plane.position);
      curve.getTangentAt(Math.min(e2, 0.999), tan);
      plane.lookAt(look.copy(plane.position).add(tan));
      plane.rotateZ(clamp((tan.x - prev.x) * 30, -0.8, 0.8));
      prev.copy(tan);
    });
    this.scene.remove(plane);
    geo.dispose();
  }

  /** An upload: the sheet comes down from above, from the owner's own hand, onto the agent's desk. */
  private async dropSheet(agentId: string) {
    const r = this.L.rooms[agentId];
    if (!r) return;
    const s = this.sheet(agentId);
    this.scene.add(s);
    const end = r.row === "front" ? new THREE.Vector3(r.cx + 2.4, 2, this.L.lane - 7.2) : new THREE.Vector3(r.cx - 2, DESK_TOP + 0.1, r.cz + 0.6);
    const start = end.clone().add(new THREE.Vector3(0, 40, 14));
    await this.tween(2.4, (p) => {
      const e = 1 - Math.pow(1 - p, 2.2);
      s.position.lerpVectors(start, end, e);
      s.position.x += Math.sin(p * 9) * (1 - p) * 1.4;
      s.rotation.set(Math.sin(p * 7) * 0.5 * (1 - p), p * 3, Math.cos(p * 6) * 0.4 * (1 - p));
    });
    await this.wait(900);
    this.scene.remove(s);
  }

  private async toDesk(agentId: string, count: number) {
    const d = this.dolls.get(agentId);
    const add = () => {
      this.pileShown += count;
      this.layoutPile();
    };
    if (!d) return add();
    const s = this.sheet(agentId);
    s.scale.set(0.8, 1, 0.8);
    await this.errand(d, corridorSpot(this.L, this.L.deskStand), s, add);
  }

  private async decide(agentId: string, status: "approved" | "rejected") {
    if (this.pileShown <= 0) return;
    const top = this.pileMeshes[this.pileMeshes.length - 1];
    const finish = () => {
      this.pileShown = Math.max(0, this.pileShown - 1);
      this.layoutPile();
    };
    if (!top) return finish();
    const world = new THREE.Vector3();
    top.getWorldPosition(world);
    if (status === "approved") {
      const above = new THREE.Vector3(this.pileGroup.position.x, DESK_TOP + 2.6, this.pileGroup.position.z);
      const from = this.seal.position.clone();
      await this.tween(0.55, (p) => {
        this.seal.position.lerpVectors(from, above, easeInOut(p));
        this.seal.position.y += Math.sin(p * Math.PI) * 1.2;
      });
      const hit = new THREE.Vector3(above.x, world.y + 0.05, above.z);
      await this.tween(0.14, (p) => this.seal.position.lerpVectors(above, hit, p * p));
      this.shake = 0.35;
      const imp = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3), new THREE.MeshBasicMaterial({ map: this.sealTex, transparent: true, depthWrite: false }));
      imp.rotation.set(-Math.PI / 2, 0, 0.2);
      imp.position.y = 0.04;
      top.add(imp);
      await this.wait(260);
      await this.tween(0.5, (p) => this.seal.position.lerpVectors(hit, this.sealHome, easeInOut(p)));
      this.pileGroup.remove(top);
      this.pileMeshes.pop();
      this.scene.add(top);
      top.position.copy(world);
      const r = this.L.rooms[agentId];
      const shelf =
        r && r.row !== "front" ? new THREE.Vector3(r.x0 + 1.1, 3.6, r.cz - 4.5) : new THREE.Vector3(this.L.building.x0 + 10.8, 1.9, this.L.lane - 7.2);
      await this.tween(1.6, (p) => {
        const e = easeInOut(p);
        top.position.lerpVectors(world, shelf, e);
        top.position.y += Math.sin(p * Math.PI) * 9;
        top.rotation.set(p * 1.2, 0, p * 6.3);
        top.scale.setScalar(1 - 0.5 * p);
      });
      this.scene.remove(top);
      this.pileShown = Math.max(0, this.pileShown - 1);
      this.shadowDirty = true;
    } else {
      // Rejected: crumpled into a ball and into the bin.
      this.pileGroup.remove(top);
      this.pileMeshes.pop();
      const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), this.kit.M.sheet);
      ball.geometry.computeVertexNormals();
      ball.castShadow = true;
      this.scene.add(ball);
      ball.position.copy(world);
      const bin = new THREE.Vector3(this.L.desk[0] + 0.2, 1.2, this.L.desk[1] + 2.7);
      await this.tween(0.35, (p) => ball.scale.setScalar(lerp(1.4, 1, p)));
      await this.tween(0.9, (p) => {
        ball.position.lerpVectors(world, bin, p);
        ball.position.y += Math.sin(p * Math.PI) * 3;
        ball.rotation.set(p * 9, p * 4, 0);
      });
      this.scene.remove(ball);
      this.pileShown = Math.max(0, this.pileShown - 1);
      this.shadowDirty = true;
    }
  }
  private shake = 0;

  private redrawFloor() {
    this.pageTex.redraw();
  }

  private async hire(id: string, still: boolean) {
    if (this.hired.has(id) || !this.L.rooms[id]) return;
    const rising = this.segments.filter((s) => s.owners.includes(id) && !this.stands(s));
    this.hired.add(id);
    this.redrawFloor();
    this.addRoom(id);
    const d = this.dolls.get(id)!;
    if (still) {
      for (const s of rising) {
        s.f = 1;
        this.applySeg(s);
      }
      this.growRoom(id, 1);
      d.pop = 1;
      d.place();
      return;
    }
    this.growRoom(id, 0);
    d.pop = 0.001;
    d.place();
    await this.tween(1.4, (p) => {
      rising.forEach((s, k) => {
        s.f = easeOutBack(clamp((p - k * 0.05) / 0.7, 0, 1));
        this.applySeg(s);
      });
      this.growRoom(id, easeOutBack(clamp((p - 0.45) / 0.55, 0, 1)));
    });
    const r = this.L.rooms[id]!;
    this.bits = Array.from({ length: 160 }, () => ({
      p: new THREE.Vector3(r.cx + (Math.random() - 0.5) * 6, 9 + Math.random() * 5, r.cz + (Math.random() - 0.5) * 6),
      v: new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3),
      r: new THREE.Euler(Math.random() * 6, Math.random() * 6, 0),
      s: Math.random() * 4 + 2,
      life: 6,
    }));
    this.confetti.count = this.bits.length;
    await this.tween(0.6, (p) => {
      d.pop = Math.max(0.001, easeOutBack(p));
      d.place();
    });
    d.wave = true;
    d.sitting = false;
    await this.wait(3200);
    d.wave = false;
    d.sitting = true;
    d.place();
  }

  private async leave(id: string, still: boolean) {
    if (!this.hired.has(id)) return;
    const d = this.dolls.get(id);
    if (d && !still)
      await this.tween(0.6, (p) => {
        d.pop = Math.max(0.001, 1 - p);
        d.place();
      });
    this.hired.delete(id);
    const falling = this.segments.filter((s) => s.owners.includes(id) && !this.stands(s));
    for (const s of falling) s.sign = this.fallSign(s);
    if (!still)
      await this.tween(1, (p) => {
        falling.forEach((s) => {
          s.f = 1 - easeInOut(p);
          this.applySeg(s);
        });
        this.growRoom(id, 1 - p);
      });
    for (const s of falling) {
      s.f = 0;
      this.applySeg(s);
    }
    if (d) {
      this.scene.remove(d.root);
      d.dispose();
      this.dolls.delete(id);
    }
    const f = this.furnished.get(id);
    if (f) {
      this.scene.remove(f.group);
      this.furnished.delete(id);
    }
    const p = this.pools.get(id);
    if (p) {
      this.scene.remove(p);
      this.pools.delete(id);
    }
    this.redrawFloor();
  }

  /* ------------------------------------------------------------------ looking around */

  setPointer(x: number, y: number) {
    this.pointer.x = clamp(x, -1, 1);
    this.pointer.y = clamp(y, -1, 1);
  }
  /** Glide in over a room: before its page opens, or while it is open in a panel beside the picture. */
  glideTo(id: string): Promise<void> {
    const r = id === "desk" ? { cx: this.L.desk[0] - 4, cz: this.L.desk[1] } : this.L.rooms[id];
    if (!r) return Promise.resolve();
    this.focusedOn = id;
    return this.glideView({ target: new THREE.Vector3(r.cx, 1.5, r.cz), dist: 42, pitch: 48 * RAD }, 0.55);
  }
  /** Back to the whole office. */
  glideHome(): Promise<void> {
    if (!this.focusedOn) return Promise.resolve();
    this.focusedOn = null;
    return this.glideView({ target: this.home.target.clone(), dist: this.home.dist, pitch: this.home.pitch }, 0.7);
  }
  private focusedOn: string | null = null;
  private glideView(to: { target: THREE.Vector3; dist: number; pitch: number }, dur: number): Promise<void> {
    this.glide?.res();
    return new Promise(
      (res) =>
        (this.glide = {
          from: { target: this.view.target.clone(), dist: this.view.dist, pitch: this.view.pitch },
          to,
          t: 0,
          dur: this.opts.reduced ? 0.01 : dur,
          res,
        }),
    );
  }
  /** What is under a point on the canvas, in CSS pixels from its corner. */
  hit(x: number, y: number): Hit {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return null;
    const [dx, dz] = this.L.desk;
    if (Math.abs(p.x - dx) < 3 && Math.abs(p.z - dz) < 3) return { kind: "desk" };
    for (const r of Object.values(this.L.rooms)) {
      if (p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1) return this.hired.has(r.id) ? { kind: "room", id: r.id } : { kind: "vacant", id: r.id };
    }
    const a = this.L.alcove;
    if (a && p.x > a.x0 && p.x < a.x1 && p.z > a.z0 && p.z < a.z1) return { kind: "vacant", id: "alcove" };
    return null;
  }

  /** Screen position, in CSS pixels, of a point in the scene; null when behind the camera. */
  project(v: THREE.Vector3): [number, number] | null {
    const p = this.tmp.v.copy(v).project(this.camera);
    if (p.z > 1) return null;
    return [(p.x * 0.5 + 0.5) * this.width, (-p.y * 0.5 + 0.5) * this.height];
  }
  /** Where a room's name plate is pinned: on top of its back wall, or its corridor wall for the near row. */
  plateAnchor(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const B = this.L.building;
    if (id === "desk") return out.set(this.L.desk[0] - 1.2, 3.4, this.L.desk[1] - 1.9);
    const r = this.L.rooms[id];
    if (!r) return null;
    if (r.row === "front") return out.set(B.x0 + 0.6, 4.4, this.L.lane + 6);
    return r.row === "top" ? out.set(r.x0 + 0.6, 5.9, B.z0) : out.set(r.x0 + 0.6, 4.4, r.door.z);
  }

  /* ------------------------------------------------------------------ the frame */

  /** Advances the world by `dt` seconds. True while something needs every frame (the opening, a glide, a flight). */
  step(dt: number, c: Conditions): boolean {
    this.time += dt;
    const reduced = this.opts.reduced;
    const [lat, lon] = this.opts.where;
    const date = new Date(c.now);
    const s = sunAt(date, lat, lon);
    const phase = moonPhase(date);
    const m = moonAt(s, phase, lat);
    const day = daylight(s.el);
    const hot = c.tempC >= 34;

    // the painted sky
    const { top, horizon } = skyColours(s.el, hot);
    const u = this.skyMat.uniforms;
    (u.uTop!.value as THREE.Color).setRGB(top[0] / 255, top[1] / 255, top[2] / 255, THREE.SRGBColorSpace);
    (u.uBot!.value as THREE.Color).setRGB(horizon[0] / 255, horizon[1] / 255, horizon[2] / 255, THREE.SRGBColorSpace);
    u.uStars!.value = (1 - smoothstep(-12, -3, s.el)) * (1 - c.cover * 0.9);
    u.uTime!.value = this.time;
    u.uLight!.value = 0.28 + 0.72 * day;
    const PW = this.L.page.x1 - this.L.page.x0;
    const hang = (az: number, el: number, mesh: THREE.Object3D) =>
      mesh.position.set(clamp((az - 180) / 100, -1.05, 1.05) * (PW / 2 - 8), this.bdH * 0.16 + (clamp(el, -10, 80) / 80) * (this.bdH * 0.7), 0.5);
    hang(s.az, s.el, this.sunDisc);
    this.sunDisc.material.opacity = smoothstep(-3, 3, s.el) * (1 - c.cover * 0.85);
    this.sunDisc.visible = this.sunDisc.material.opacity > 0.01;
    this.sunDisc.material.color.set(s.el < 8 ? "#ffb070" : "#ffffff");
    hang(m.az, m.el, this.moonDisc);
    this.moonDisc.material.opacity = smoothstep(-2, 4, m.el) * (1 - day * 0.75) * (1 - c.cover * 0.8);
    this.moonDisc.visible = this.moonDisc.material.opacity > 0.01;
    if (Math.abs(this.moonDrawn - phase) > 0.01) {
      this.drawMoon(phase);
      this.moonDrawn = phase;
    }

    // the light: the sun by day, the moon by night
    const sunI = smoothstep(-1, 8, s.el) * 2.9 * (1 - c.cover * 0.78) * (hot ? 1.15 : 1);
    const lit = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const moonI = smoothstep(0, 6, m.el) * 0.55 * lit * (1 - c.cover * 0.8) * (1 - day);
    const useSun = sunI >= moonI;
    const d = useSun ? sceneDirection(s.az, Math.max(s.el, 0.5)) : sceneDirection(m.az, m.el);
    this.sun.position.copy(this.sun.target.position).add(this.tmp.v.set(d.x, d.y, d.z).multiplyScalar(150));
    if (useSun) this.sun.color.set(s.el < 12 ? "#ffb67a" : "#fff3dc").lerp(new THREE.Color("#fff3dc"), smoothstep(4, 25, s.el));
    else this.sun.color.set("#9fb4e0");
    this.sun.intensity = useSun ? sunI : moonI;
    const key = `${useSun ? "s" : "m"}${Math.round((useSun ? s.az : m.az) * 5)}:${Math.round((useSun ? s.el : m.el) * 5)}`;
    if (key !== this.sunKey) {
      this.sunKey = key;
      this.shadowDirty = true;
    }
    this.hemi.color.setRGB(top[0] / 255, top[1] / 255, top[2] / 255, THREE.SRGBColorSpace).lerp(new THREE.Color("#ffffff"), 0.35);
    this.hemi.groundColor.set("#d9c9a8").multiplyScalar(0.35 + 0.65 * day);
    this.hemi.intensity = 0.22 + 0.95 * day * (1 - c.cover * 0.25);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setRGB(horizon[0] / 255, horizon[1] / 255, horizon[2] / 255, THREE.SRGBColorSpace).multiplyScalar(0.25 + 0.2 * day);
    this.renderer.setClearColor(fog.color);

    // lamps at dusk
    const lamps = clamp(lampsOn(s.el) + c.cover * 0.3, 0, 1);
    const glow = (p: Pool, v: number) => {
      p.material.opacity = Math.min(0.75, v);
      p.visible = v > 0.01;
    };
    for (const [id, p] of this.pools) glow(p, lamps * (id === "accountant" ? 0.75 : 0.62));
    for (const p of this.corridorPools) glow(p, lamps * 0.5);
    glow(this.lampPool, lamps * 0.7);
    this.kit.M.lampShade.emissiveIntensity = lamps * 2.2;
    for (const f of this.furnished.values()) {
      if (f.shade) f.shade.emissiveIntensity = lamps * 2.4;
      if (f.screen) (f.screen.material as THREE.MeshLambertMaterial).emissiveIntensity = 0.25 + lamps * 0.6;
      if (f.blades && !reduced) f.blades.rotation.z += dt * (c.tempC >= 34 ? 26 : c.tempC >= 24 ? 14 : 0);
      if (f.stroke && !reduced) f.stroke.scale.x = Math.max(0.02, Math.floor((this.time % 2.4) * 12) / 12 / 2.4);
    }

    // small life: steam, the clock, the passing rickshaw
    for (const sp of this.steam) {
      const t = (sp.userData.t = reduced ? sp.userData.t : (sp.userData.t + dt * 0.35) % 1) as number;
      const base = sp.userData.where === "cart" ? this.kettleAt : this.teaAt;
      sp.position.set(base.x + Math.sin(t * 6 + this.time) * 0.25, base.y + t * 3, base.z);
      sp.scale.setScalar(0.5 + t * 1.6);
      sp.material.opacity = (1 - t) * 0.5 * (this.opened ? 1 : 0);
    }
    if (this.clockHands) {
      const mins = istParts(c.now).minutes;
      this.clockHands.h.rotation.z = -(((mins / 60) % 12) / 12) * Math.PI * 2;
      this.clockHands.m.rotation.z = -((mins % 60) / 60) * Math.PI * 2;
    }
    const at = (this.time % 34) / 10;
    this.auto.visible = this.opened && !reduced && at < 1;
    if (this.auto.visible) {
      this.auto.position.set(
        lerp(this.L.yard.x1 + 18, this.L.yard.x0 - 18, at),
        Math.abs(Math.sin(this.time * 14)) * 0.12,
        (this.L.road.z0 + this.L.road.z1) / 2 - 1.6,
      );
    }
    for (const doll of this.dolls.values()) doll.cold = c.tempC <= 18;

    // confetti after a hire
    if (this.confetti.count) {
      let alive = 0;
      const { m: M4, q, s: S3 } = this.tmp;
      this.bits.forEach((b, i) => {
        b.life -= dt;
        if (b.p.y > 0.05) {
          b.v.y -= 9 * dt;
          b.v.multiplyScalar(0.985);
          b.p.addScaledVector(b.v, dt);
          b.r.x += b.s * dt;
          b.r.y += b.s * 0.7 * dt;
        } else {
          b.p.y = 0.04;
          b.r.set(-Math.PI / 2, 0, b.r.z);
        }
        const k = b.life > 1 ? 1 : Math.max(0, b.life);
        if (k > 0) alive++;
        M4.compose(b.p, q.setFromEuler(b.r), S3.set(k, k, k));
        this.confetti.setMatrixAt(i, M4);
      });
      this.confetti.instanceMatrix.needsUpdate = true;
      if (!alive) this.confetti.count = 0;
    }

    this.stepOpening(dt);
    const busy = this.tweens.length > 0;
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i]!;
      tw.t += dt;
      const p = clamp(tw.t / tw.dur, 0, 1);
      tw.fn(p);
      if (p >= 1) {
        this.tweens.splice(i, 1);
        tw.res();
      }
    }
    if (busy) this.shadowDirty = true;

    // people: the director's wishes, unless someone is busy carrying something
    for (const doll of this.dolls.values()) {
      if (!doll.scripted && !doll.walking && !this.opening && pathKey(doll.spot) !== pathKey(doll.wanted)) {
        const wanted = doll.wanted;
        const spot = doll.intent as Spot | undefined;
        void doll.walk(route(doll.spot, wanted), reduced, wanted).then(() => {
          if (pathKey(doll.wanted) !== pathKey(wanted)) return;
          if (!spot || spot.kind === "home") {
            doll.sitting = true;
            doll.facing = 0;
          } else if (spot.kind === "coffee") doll.facing = spot.slot === 0 ? Math.PI / 2 : -Math.PI / 2;
          doll.place();
        });
      }
      if (doll.update(dt, reduced)) this.shadowDirty = true;
    }

    // the camera
    let moving = Boolean(this.opening) || busy || this.confetti.count > 0;
    if (this.glide) {
      const g = this.glide;
      g.t += dt;
      const p = easeInOut(clamp(g.t / g.dur, 0, 1));
      this.view.target.lerpVectors(g.from.target, g.to.target, p);
      this.view.dist = lerp(g.from.dist, g.to.dist, p);
      this.view.pitch = lerp(g.from.pitch, g.to.pitch, p);
      moving = true;
      if (p >= 1) {
        this.glide = null;
        g.res();
      }
    }
    const k = reduced ? 1 : 1 - Math.pow(0.001, dt);
    const px = reduced ? 0 : this.pointer.x,
      py = reduced ? 0 : this.pointer.y;
    this.pointer.sx = lerp(this.pointer.sx, px, k * 0.5);
    this.pointer.sy = lerp(this.pointer.sy, py, k * 0.5);
    if (Math.abs(this.pointer.sx - px) > 0.002 || Math.abs(this.pointer.sy - py) > 0.002) moving = true;
    const breathe = reduced ? 0 : Math.sin(this.time * 0.13) * 0.012;
    const yaw = this.pointer.sx * 0.05 + breathe,
      pitch = this.view.pitch + this.pointer.sy * 0.025;
    const t = this.view.target;
    this.camera.position.set(
      t.x + Math.sin(yaw) * Math.cos(pitch) * this.view.dist,
      t.y + Math.sin(pitch) * this.view.dist,
      t.z + Math.cos(yaw) * Math.cos(pitch) * this.view.dist,
    );
    if (this.shake > 0) {
      this.camera.position.y -= this.shake * 0.6 * Math.sin(this.time * 80);
      this.shake = Math.max(0, this.shake - dt * 1.8);
      moving = true;
    }
    this.camera.lookAt(t);

    if (this.blurV) {
      const focus = this.project(t);
      const fy = focus ? 1 - focus[1] / this.height : 0.45;
      const pr = this.renderer.getPixelRatio();
      for (const mat of [this.blurH, this.blurV]) {
        mat.uniforms.uFocus!.value = fy;
        mat.uniforms.uMax!.value = (this.glide || this.view.dist < 80 ? 2.4 : 3.2) * pr;
        mat.uniforms.uBand!.value = this.view.dist < 80 ? 0.18 : 0.13;
      }
      this.blurV.uniforms.uTime!.value = this.time;
      this.blurV.uniforms.uHeat!.value = hot ? ((c.tempC - 33) / 8) * day : 0;
    }
    return moving;
  }

  render() {
    if (this.shadowDirty && !this.lite) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    if (this.lite || !this.rtA || !this.rtB) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.renderer.setRenderTarget(this.rtA);
    this.renderer.render(this.scene, this.camera);
    this.quad.material = this.blurH;
    this.blurH.uniforms.tDiffuse!.value = this.rtA.texture;
    this.renderer.setRenderTarget(this.rtB);
    this.renderer.render(this.quadScene, this.quadCam);
    this.quad.material = this.blurV;
    this.blurV.uniforms.tDiffuse!.value = this.rtB.texture;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  dispose() {
    this.disposed = true;
    for (const d of this.dolls.values()) d.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        for (const m of [o.material].flat()) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      }
    });
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.blurH.dispose();
    this.blurV.dispose();
    this.renderer.dispose();
  }
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const pathKey = (p: V2[]) => p.map(([x, z]) => `${x.toFixed(2)},${z.toFixed(2)}`).join(";");

/** Shrinks a font until the text fits; `pattern` has `{}` where the size goes. */
function fitText(g: CanvasRenderingContext2D, text: string, max: number, size: number, pattern: string) {
  let s = size;
  g.font = pattern.replace("{}", String(s));
  while (s > 10 && g.measureText(text).width > max) {
    s -= 2;
    g.font = pattern.replace("{}", String(s));
  }
}
/** "2026–27" for a date in India's financial year. */
export function financialYear(t: number) {
  const d = new Date(istParts(t).day);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}–${String((y + 1) % 100).padStart(2, "0")}`;
}
/** The page number in the year's ledger: days since 1 April. */
function folio(day: number) {
  const d = new Date(day);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return Math.floor((day - Date.UTC(y, 3, 1)) / 86_400_000) + 1;
}
