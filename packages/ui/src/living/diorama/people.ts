import * as THREE from "three";
import type { V2 } from "./navigate";
import type { Kit } from "./paper";

/**
 * The team as paper dolls on little stands: a folded cone of a body in a printed outfit, a
 * faceted head, hair cut from card. They move in stop-motion, twelve poses a second, so the
 * office looks like a papercraft film and costs little to draw.
 */

type Look = { skin: string; outfit: string; trim: string; hair: string; style: "bun" | "braid" | "short" | "curly"; kind: "saree" | "kurta" | "shirt"; glasses?: boolean };

export const LOOKS: Record<string, Look> = {
  "office-manager": { skin: "#8d5a3b", outfit: "#2f7f86", trim: "#d9a441", hair: "#1d1612", style: "bun", kind: "saree" },
  "customer-service": { skin: "#a06a48", outfit: "#b8452e", trim: "#efe6cf", hair: "#21170f", style: "braid", kind: "kurta" },
  accountant: { skin: "#a86f4c", outfit: "#c9962c", trim: "#f3ead7", hair: "#221a14", style: "braid", kind: "kurta", glasses: true },
  "credit-controller": { skin: "#7a4b30", outfit: "#3d5a8c", trim: "#e9e2d0", hair: "#15100c", style: "short", kind: "shirt" },
  "tax-clerk": { skin: "#9a6646", outfit: "#6a7f3e", trim: "#efe6cf", hair: "#2a1d14", style: "short", kind: "shirt", glasses: true },
  auditor: { skin: "#b07a55", outfit: "#8e2f5a", trim: "#e6c36a", hair: "#3a2a20", style: "bun", kind: "saree", glasses: true },
  "sales-rep": { skin: "#8a5536", outfit: "#2f5f8f", trim: "#f1ead8", hair: "#140f0b", style: "short", kind: "shirt" },
  "quote-desk": { skin: "#b88462", outfit: "#5d8a6a", trim: "#f4ecd9", hair: "#2a1c12", style: "braid", kind: "kurta" },
  "account-manager": { skin: "#6e4429", outfit: "#7a4e8c", trim: "#efe6cf", hair: "#120d09", style: "curly", kind: "shirt" },
  marketer: { skin: "#a06a48", outfit: "#d0643a", trim: "#f6e7c6", hair: "#2b1d14", style: "bun", kind: "kurta" },
  "market-watcher": { skin: "#8d5a3b", outfit: "#4f6e7d", trim: "#ece3cf", hair: "#1c140f", style: "short", kind: "kurta", glasses: true },
  "social-media-manager": { skin: "#b07a55", outfit: "#c2477a", trim: "#f6e1b0", hair: "#21160f", style: "curly", kind: "kurta" },
  storekeeper: { skin: "#6e4429", outfit: "#5d4a8a", trim: "#efe6cf", hair: "#1a1410", style: "curly", kind: "shirt" },
  buyer: { skin: "#9a6646", outfit: "#a33a2a", trim: "#e9c46a", hair: "#1f1610", style: "bun", kind: "saree" },
  "compliance-officer": { skin: "#7a4b30", outfit: "#33465c", trim: "#e9e2d0", hair: "#100c09", style: "short", kind: "shirt", glasses: true },
  "payroll-clerk": { skin: "#a86f4c", outfit: "#2f7a5a", trim: "#e6c36a", hair: "#241812", style: "braid", kind: "saree" },
};
export const lookFor = (id: string): Look => LOOKS[id] ?? { skin: "#8d5a3b", outfit: "#4f6e7d", trim: "#efe6cf", hair: "#1d1612", style: "short", kind: "shirt" };

const SPEED = 6;
const SIT = -0.62;

export class Doll {
  readonly root = new THREE.Group();
  private readonly doll = new THREE.Group();
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly shawl: THREE.Mesh;
  readonly pos = new THREE.Vector3();
  facing = 0;
  sitting = true;
  pop = 1;
  wave = false;
  /** Taken over by a piece of business (carrying a bill, being hired), so the director waits. */
  scripted = false;
  /** Where the person is now, as that place's way out to the corridor. */
  spot: V2[];
  /** Where the director wants them, by the same measure. */
  wanted: V2[];
  /** What the director asked for, so they can face the right way on arrival. */
  intent: unknown = undefined;
  private path: THREE.Vector3[] | null = null;
  private seg = 0;
  private done: (() => void) | null = null;
  private phase = 0;
  private stepAcc = 1;
  private carried: THREE.Object3D | null = null;

  constructor(readonly id: string, kit: Kit, home: V2, homeSpot: V2[]) {
    const L = lookFor(id);
    const mat = (c: string) => new THREE.MeshLambertMaterial({ color: c, map: kit.fibre });
    this.doll.scale.setScalar(1.45);
    this.root.add(this.doll);
    this.doll.add(kit.cyl(0.55, 0.62, 0.08, kit.M.sheet, 20));
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.64, 1.75, 7), mat(L.outfit));
    body.position.y = 0.955;
    this.doll.add(body);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.645, 0.2, 7), mat(L.trim));
    band.position.y = 0.2;
    this.doll.add(band);
    if (L.kind === "saree") {
      const pallu = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.5, 0.05), mat(L.trim));
      pallu.position.set(0.05, 1.15, 0.36);
      pallu.rotation.set(0.25, 0, -0.55);
      this.doll.add(pallu);
    } else if (L.kind === "kurta") {
      const yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.33, 0.12, 7), mat(L.trim));
      yoke.position.y = 1.7;
      this.doll.add(yoke);
    } else {
      const collar = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.2, 3), mat("#fffaf0"));
      collar.position.set(0, 1.72, 0.2);
      collar.rotation.x = Math.PI;
      this.doll.add(collar);
    }
    this.shawl = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.7, 0.62, 7, 1, true), mat("#8e2f2f"));
    this.shawl.position.y = 1.55;
    this.shawl.visible = false;
    this.doll.add(this.shawl);
    const arm = (side: number) => {
      const p = new THREE.Group();
      p.position.set(side * 0.34, 1.78, 0);
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.85, 0.15), mat(L.outfit));
      a.position.y = -0.42;
      p.add(a);
      const hand = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), mat(L.skin));
      hand.position.y = -0.88;
      p.add(hand);
      p.rotation.z = side * 0.18;
      this.doll.add(p);
      return p;
    };
    this.armL = arm(-1);
    this.armR = arm(1);
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), mat(L.skin));
    head.position.y = 2.3;
    this.doll.add(head);
    const hair = mat(L.hair);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.455, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.52), hair);
    cap.position.y = 2.33;
    cap.rotation.x = -0.42;
    this.doll.add(cap);
    if (L.style === "bun") {
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), hair);
      b.position.set(0, 2.55, -0.38);
      this.doll.add(b);
    } else if (L.style === "braid") {
      for (let k = 0; k < 4; k++) {
        const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13 - k * 0.015, 0), hair);
        b.position.set(0, 2.1 - k * 0.24, -0.4 - k * 0.03);
        this.doll.add(b);
      }
    } else if (L.style === "curly") {
      for (let k = 0; k < 7; k++) {
        const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), hair);
        b.position.set(Math.cos(k) * 0.3, 2.62 + Math.sin(k * 2) * 0.05, Math.sin(k) * 0.3 - 0.05);
        this.doll.add(b);
      }
    }
    const eye = new THREE.MeshBasicMaterial({ color: "#1a1410" });
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), eye);
      e.position.set(s * 0.14, 2.34, 0.39);
      this.doll.add(e);
      if (L.glasses) {
        const g = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.015, 5, 14), kit.M.ink);
        g.position.set(s * 0.14, 2.34, 0.41);
        this.doll.add(g);
      }
    }
    this.doll.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = true;
      // Flat normals on the faceted parts, so they read as folded card without a separate shader.
      if (o.geometry.type === "IcosahedronGeometry") o.geometry.computeVertexNormals();
    });
    this.pos.set(home[0], 0, home[1]);
    this.spot = homeSpot;
    this.wanted = homeSpot;
    this.place();
  }

  get walking() {
    return this.path !== null;
  }

  /** Walk a route; resolves on arrival. Still people (reduced motion) arrive at once. */
  walk(points: V2[], still: boolean, ends: V2[]): Promise<void> {
    this.spot = ends;
    this.sitting = false;
    this.done?.();
    if (still || points.length < 2) {
      const last = points[points.length - 1];
      if (last) this.pos.set(last[0], 0, last[1]);
      this.path = null;
      this.place();
      return Promise.resolve();
    }
    this.path = points.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.seg = 1;
    return new Promise((res) => (this.done = res));
  }

  carry(mesh: THREE.Object3D | null) {
    if (this.carried) this.doll.remove(this.carried);
    this.carried = mesh;
    if (mesh) {
      mesh.position.set(0, 1.35, 0.55);
      mesh.rotation.set(-0.9, 0, 0);
      this.doll.add(mesh);
    }
    this.place();
  }

  set cold(on: boolean) {
    this.shawl.visible = on;
  }

  /** Moves along the path and, twelve times a second, takes a new pose. True when the pose changed. */
  update(dt: number, still: boolean): boolean {
    if (this.path) {
      let move = SPEED * dt;
      while (move > 0 && this.path) {
        const tgt = this.path[this.seg]!;
        const dx = tgt.x - this.pos.x, dz = tgt.z - this.pos.z, len = Math.hypot(dx, dz);
        if (len > 1e-4) this.facing = Math.atan2(dx, dz);
        if (len <= move) {
          this.pos.copy(tgt);
          move -= len;
          this.seg++;
          if (this.seg >= this.path.length) {
            this.path = null;
            const f = this.done;
            this.done = null;
            f?.();
          }
        } else {
          this.pos.x += (dx / len) * move;
          this.pos.z += (dz / len) * move;
          move = 0;
        }
      }
      this.phase += dt * 9;
    }
    this.stepAcc += dt;
    if (this.stepAcc < 1 / 12 && !still && !this.wave) return false;
    this.stepAcc = 0;
    this.place();
    return true;
  }

  place() {
    const walking = this.path !== null;
    const hop = walking ? Math.abs(Math.sin(this.phase)) * 0.2 : 0;
    this.root.position.set(this.pos.x, (this.sitting && !walking ? SIT : 0) + hop, this.pos.z);
    this.root.rotation.y = this.facing;
    this.doll.rotation.z = walking ? Math.sin(this.phase) * 0.07 : 0;
    const swing = walking ? Math.sin(this.phase) * 0.6 : 0;
    this.armL.rotation.x = this.carried ? -1.1 : swing;
    this.armR.rotation.x = this.carried ? -1.1 : -swing;
    this.armR.rotation.z = this.wave ? 2.6 + Math.sin(performance.now() / 120) * 0.35 : 0.18;
    this.root.scale.setScalar(Math.max(0.001, this.pop));
  }

  /** Where a speech bubble hangs: just above the head. */
  head(out: THREE.Vector3) {
    return out.set(this.root.position.x, this.root.position.y + 4.6 * Math.max(0.2, this.pop), this.root.position.z);
  }

  dispose() {
    this.done?.();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
