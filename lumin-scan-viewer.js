import * as THREE from './vendor/three/build/three.module.js';
import { MTLLoader } from './vendor/three/examples/jsm/loaders/MTLLoader.js';
import { OrbitControls } from './vendor/three/examples/jsm/controls/OrbitControls.js';

function installTwoButtonPan(controls, element) {
  controls.mouseButtons.RIGHT = -1;
  let panning = false;
  const transition = event => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    const next = (event.buttons & 3) === 3;
    if (next === panning) return;
    panning = next;
    controls.mouseButtons.LEFT = next ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    // A second mouse button produces mousedown, not another pointerdown.
    // Restart the pinned OrbitControls gesture at the current cursor to avoid jumps.
    controls._onMouseDown({
      button: next || (event.buttons & 1) ? 0 : event.buttons & 2 ? 2 : -1,
      clientX: event.clientX, clientY: event.clientY,
      ctrlKey: next ? false : event.ctrlKey, metaKey: next ? false : event.metaKey,
      shiftKey: next ? false : event.shiftKey
    });
  };
  const cancel = () => { panning = false; controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; };
  element.addEventListener('mousedown', transition);
  element.addEventListener('mouseup', transition);
  element.addEventListener('pointermove', transition, true);
  element.addEventListener('pointercancel', cancel);
  return () => {
    element.removeEventListener('mousedown', transition);
    element.removeEventListener('mouseup', transition);
    element.removeEventListener('pointermove', transition, true);
    element.removeEventListener('pointercancel', cancel);
  };
}

export class ScanViewer {
  constructor(host, labels) {
    this.host = host; this.labels = labels; this.panes = []; this.urls = [];
    this.linked = true; this.disposed = false; this.frame = 0;
    const canvas = document.createElement('canvas');
    if (!canvas.getContext('webgl2')) throw new Error('webglUnavailable');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.setScissorTest(true);
    canvas.className = 'scan-canvas'; host.append(canvas);
    this.contextLost = event => {
      event.preventDefault(); this.lost = true;
      host.dataset.graphicsLost = 'true'; this.showStatus(labels('contextLost'));
    };
    this.contextRestored = () => { this.lost = false; delete host.dataset.graphicsLost; this.showStatus(''); this.request(); };
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
    this.observer = new ResizeObserver(() => this.request()); this.observer.observe(host);
    this.fullscreenButton = document.createElement('button');
    this.fullscreenButton.type = 'button'; this.fullscreenButton.className = 'scan-fullscreen-toggle';
    this.fullscreenButton.dir = document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
    this.fullscreenButton.addEventListener('click', () => this.toggleFullscreen()); host.append(this.fullscreenButton);
    this.fullscreenChanged = () => { if (!this.disposed) this.updateFullscreenButton(); };
    this.fullscreenKey = event => {
      if (!this.expanded) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.exitExpanded(); }
      if (event.key === 'Tab') {
        const targets = [this.fullscreenButton, ...this.panes.map(pane => pane.element)];
        const index = targets.indexOf(document.activeElement);
        event.preventDefault(); targets[(index + (event.shiftKey ? targets.length - 1 : 1)) % targets.length].focus();
      }
    };
    document.addEventListener('fullscreenchange', this.fullscreenChanged); host.addEventListener('keydown', this.fullscreenKey);
    this.updateFullscreenButton();
  }
  updateFullscreenButton() {
    const active = this.expanded || document.fullscreenElement === this.host;
    const label = this.labels(active ? 'exitFullscreen' : 'fullscreen');
    this.fullscreenButton.title = label; this.fullscreenButton.setAttribute('aria-label', label);
    this.fullscreenButton.setAttribute('aria-pressed', String(!!active));
    this.fullscreenButton.innerHTML = `<i data-lucide="${active ? 'minimize' : 'maximize'}" aria-hidden="true"></i>`;
    if (window.lucide) lucide.createIcons();
    this.request();
  }
  async toggleFullscreen() {
    if (this.disposed || this.fullscreenButton.disabled) return;
    this.fullscreenButton.disabled = true;
    try {
      if (this.expanded) this.exitExpanded();
      else if (document.fullscreenElement === this.host) await document.exitFullscreen();
      else {
        if (this.host.requestFullscreen && document.fullscreenEnabled !== false) {
          try {
            await this.host.requestFullscreen();
            if (this.disposed && document.fullscreenElement === this.host) await document.exitFullscreen();
            return;
          } catch { if (this.disposed) return; }
        }
        // Browsers without element fullscreen still get a viewport-sized viewer.
        this.placeholder = document.createComment('scan-viewer'); this.host.before(this.placeholder);
        this.bodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
        document.body.append(this.host); this.host.classList.add('scan-expanded'); this.expanded = true;
        this.host.setAttribute('role', 'dialog'); this.host.setAttribute('aria-modal', 'true');
        this.host.setAttribute('aria-label', this.labels('title')); this.fullscreenButton.focus({ preventScroll: true });
      }
    } catch { /* Keep the exit control available if the browser declines to exit. */ }
    finally {
      this.fullscreenButton.disabled = false;
      if (!this.disposed) { this.updateFullscreenButton(); this.fullscreenButton.focus({ preventScroll: true }); }
    }
  }
  exitExpanded() {
    if (!this.expanded) return;
    this.expanded = false; this.host.classList.remove('scan-expanded');
    this.placeholder.replaceWith(this.host); this.placeholder = null;
    document.body.style.overflow = this.bodyOverflow;
    this.host.removeAttribute('role'); this.host.removeAttribute('aria-modal'); this.host.removeAttribute('aria-label');
    if (!this.disposed) { this.updateFullscreenButton(); this.fullscreenButton.focus({ preventScroll: true }); }
  }
  showStatus(message) {
    this.status?.remove();
    if (message) { this.status = document.createElement('p'); this.status.className = 'scan-graphics-status'; this.status.textContent = message; this.host.append(this.status); }
  }
  async setScans(scans) {
    this.clearPanes();
    this.host.classList.toggle('scan-compare', scans.length === 2);
    try {
      for (const scan of scans) {
        const scene = new THREE.Scene(), pair = new THREE.Group(); scene.add(pair);
        const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100); camera.up.set(0, 0, 1);
        const hemi = new THREE.HemisphereLight(0xffffff, 0x8c95a5, 2); scene.add(hemi);
        const light = new THREE.DirectionalLight(0xffffff, 2.5); light.position.set(2, -3, 5); scene.add(light);
        const element = document.createElement('div'); element.className = 'scan-pane'; element.style.touchAction = 'none';
        element.dataset.swipeBackIgnore = '';
        element.tabIndex = 0; element.setAttribute('aria-label', `${scan.name}. ${this.labels('gestureHint')}`);
        const label = document.createElement('span'); label.className = 'scan-pane-name'; label.textContent = scan.name;
        label.dir = document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr'; element.append(label);
        this.host.append(element);
        const controls = new OrbitControls(camera, element); controls.enableDamping = false;
        controls.minDistance = 0.2; controls.maxDistance = 15;
        const detachMousePan = installTwoButtonPan(controls, element);
        const pane = { scene, pair, camera, controls, element, hemi, light, arches: {}, resources: new Set(), detachMousePan }; this.panes.push(pane);
        controls.addEventListener('change', () => {
          if (this.linked && !this.syncing) {
            this.syncing = true;
            for (const other of this.panes) if (other !== pane) {
              other.camera.position.copy(camera.position); other.camera.up.copy(camera.up);
              other.controls.target.copy(controls.target); other.controls.update();
            }
            this.syncing = false;
          }
          this.request();
        });
        element.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', 'Home'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'Home') return this.view('front');
          const delta = camera.position.clone().sub(controls.target);
          if (event.key === '+' || event.key === '-') delta.multiplyScalar(event.key === '+' ? 0.9 : 1.1);
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') delta.applyAxisAngle(new THREE.Vector3(0, 0, 1), event.key === 'ArrowLeft' ? 0.12 : -0.12);
          else delta.applyAxisAngle(new THREE.Vector3(1, 0, 0), event.key === 'ArrowUp' ? 0.12 : -0.12);
          camera.position.copy(controls.target).add(delta); controls.update();
        });
        for (const archName of ['upper', 'lower']) {
          const arch = scan.data[archName], group = new THREE.Group(); pair.add(group); pane.arches[archName] = group;
          const manager = new THREE.LoadingManager(), urls = new Map();
          for (const [path, bytes] of Object.entries(arch.textures)) {
            const mime = /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg';
            // Inspect dimensions before allocating a GPU texture.
            const blob = new Blob([bytes], { type: mime });
            const bitmap = await createImageBitmap(blob);
            const tooLarge = bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 16777216;
            bitmap.close(); if (tooLarge) throw new Error('textureLimit');
            if (this.disposed) throw new DOMException('Cancelled', 'AbortError');
            const url = URL.createObjectURL(blob); this.urls.push(url); urls.set(path, url);
          }
          manager.setURLModifier(path => { if (!urls.has(path)) throw new Error('externalAsset'); return urls.get(path); });
          manager.onLoad = () => this.request();
          const materials = new Map();
          for (const text of arch.mtls) {
            const creator = new MTLLoader(manager).parse(text, ''); creator.preload();
            for (const name of Object.keys(creator.materialsInfo)) {
              const material = creator.create(name); materials.set(name, material); pane.resources.add(material);
            }
          }
          for (const meshData of arch.meshes) {
            const geometry = new THREE.BufferGeometry();
            for (const [name, attr] of Object.entries(meshData.attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(attr.array, attr.itemSize));
            for (const groupData of meshData.groups) geometry.addGroup(groupData.start, groupData.count, groupData.materialIndex);
            const mats = meshData.materials.map(name => materials.get(name) || new THREE.MeshStandardMaterial({ color: 0xe2ded6, roughness: 0.75 }));
            for (const mat of mats) { mat.side = THREE.DoubleSide; mat.userData.texture = mat.map; mat.userData.color = mat.color.clone(); }
            group.add(new THREE.Mesh(geometry, mats.length === 1 ? mats[0] : mats));
          }
        }
        // Change display coordinates once for the entire pair; meshes retain their exported coordinates.
        if (scan.orientation === 'y-up') pair.rotation.x = Math.PI / 2;
        pair.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(pair), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
        const extent = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(extent) || extent <= 1e-9) throw new Error('damagedObj');
        const scale = 2 / extent;
        pair.scale.setScalar(scale); pair.position.copy(center).multiplyScalar(-scale);
        pane.originalBounds = { min: bounds.min.toArray(), max: bounds.max.toArray() };
        controls.target.set(0, 0, 0); camera.position.set(0, 4.6, 0.5); controls.update();
      }
      this.apply(this.settings || {}); this.view('front');
    } catch (error) { this.clearPanes(); throw error; }
  }
  apply(settings) {
    this.settings = settings; const wasLinked = this.linked; this.linked = settings.linked !== false;
    if (this.linked && !wasLinked && this.panes.length > 1) {
      this.syncing = true; const first = this.panes[0];
      for (const other of this.panes.slice(1)) {
        other.camera.position.copy(first.camera.position); other.camera.up.copy(first.camera.up);
        other.controls.target.copy(first.controls.target); other.controls.update();
      }
      this.syncing = false;
    }
    for (const pane of this.panes) {
      pane.scene.background = new THREE.Color(settings.background === 'light' ? 0xf1f5f9 : 0x1e293b);
      pane.hemi.intensity = (settings.light ?? 1) * 2; pane.light.intensity = (settings.light ?? 1) * 2.5;
      const normal = new THREE.Vector3(settings.axis === 'x' ? 1 : 0, settings.axis === 'y' ? 1 : 0, !['x', 'y'].includes(settings.axis) ? 1 : 0);
      if (settings.reverse) normal.negate();
      const plane = new THREE.Plane(normal, -(settings.cutPosition ?? 0) * (settings.reverse ? -1 : 1));
      for (const name of ['upper', 'lower']) {
        pane.arches[name].visible = settings[name] !== false;
        pane.arches[name].traverse(mesh => {
          if (!mesh.isMesh) return;
          for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            mat.wireframe = settings.mode === 'wireframe';
            mat.map = settings.mode === 'solid' || settings.mode === 'wireframe' ? null : mat.userData.texture;
            mat.color.copy(mat.map ? mat.userData.color : new THREE.Color(name === 'upper' ? 0xdde4ec : 0xe4dccc));
            mat.opacity = settings[`${name}Opacity`] ?? 1; mat.transparent = mat.opacity < 1;
            mat.depthWrite = !mat.transparent; mat.clippingPlanes = settings.cut ? [plane] : []; mat.needsUpdate = true;
          }
        });
      }
    }
    this.request();
  }
  view(name) {
    const positions = { front: [0, 4.6, 0.5], left: [-4.6, 0, 0.5], right: [4.6, 0, 0.5], upper: [0, 0.001, -4.6], lower: [0, -0.001, 4.6] };
    this.syncing = true;
    for (const pane of this.panes) {
      pane.controls.target.set(0, 0, 0); pane.camera.position.set(...(positions[name] || positions.front));
      pane.camera.up.set(0, 0, 1); pane.controls.update();
    }
    this.syncing = false; this.request();
  }
  request() {
    if (this.disposed || this.lost || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }
  render() {
    if (this.disposed || this.lost) return;
    const bounds = this.host.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
    this.renderer.setSize(bounds.width, bounds.height, false);
    // Context restoration resets the GL scissor state even when the renderer retains its flag.
    this.renderer.setScissorTest(true);
    for (const pane of this.panes) {
      const rect = pane.element.getBoundingClientRect(), left = rect.left - bounds.left, bottom = bounds.bottom - rect.bottom;
      this.renderer.setViewport(left, bottom, rect.width, rect.height); this.renderer.setScissor(left, bottom, rect.width, rect.height);
      pane.camera.aspect = rect.width / rect.height; pane.camera.updateProjectionMatrix();
      this.renderer.render(pane.scene, pane.camera);
    }
  }
  clearPanes() {
    const materials = new Set(), textures = new Set();
    for (const pane of this.panes) {
      pane.resources.forEach(mat => materials.add(mat));
      pane.detachMousePan(); pane.controls.dispose(); pane.element.remove();
      pane.scene.traverse(mesh => {
        mesh.geometry?.dispose();
        if (mesh.material) for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(mat);
      });
    }
    for (const mat of materials) {
      for (const value of Object.values(mat)) if (value?.isTexture) textures.add(value);
      if (mat.userData.texture) textures.add(mat.userData.texture);
      mat.dispose();
    }
    textures.forEach(texture => texture.dispose()); this.urls.forEach(url => URL.revokeObjectURL(url));
    this.urls = []; this.panes = [];
  }
  dispose() {
    this.disposed = true; this.exitExpanded();
    if (document.fullscreenElement === this.host) document.exitFullscreen().catch(() => {});
    document.removeEventListener('fullscreenchange', this.fullscreenChanged); this.host.removeEventListener('keydown', this.fullscreenKey);
    this.fullscreenButton.remove();
    cancelAnimationFrame(this.frame); this.observer.disconnect(); this.clearPanes();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.contextLost); canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    this.renderer.dispose(); this.renderer.forceContextLoss(); canvas.remove(); this.status?.remove();
  }
}
