"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { compileFn } from "@/lib/viz-runtime";
import type { ThreeDSpec } from "@/lib/schemas";

type Props = {
  spec: ThreeDSpec;
  /** Called once per spec instance if the scene crashes (setup or update). */
  onRuntimeError?: (message: string) => void;
};

export default function ThreeDView({ spec, onRuntimeError }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reportedRef = useRef(false);

  useEffect(() => {
    setError(null);
    reportedRef.current = false;
    const reportError = (msg: string) => {
      setError(msg);
      if (!reportedRef.current) {
        reportedRef.current = true;
        onRuntimeError?.(msg);
      }
    };
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor("#ffffff", 1);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.05, 200);
    camera.position.set(0, 1.5, 4);

    const group = new THREE.Group();
    scene.add(group);

    // Pointer-orbit (lightweight, no extra dependency).
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;
    let yaw = 0;
    let pitch = 0;
    let userInteracted = false;
    let camDist = 4;
    const onDown = (e: PointerEvent) => {
      isDragging = true;
      userInteracted = true;
      lastX = e.clientX;
      lastY = e.clientY;
      mount.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      yaw -= dx * 0.005;
      pitch -= dy * 0.005;
      pitch = Math.max(-1.2, Math.min(1.2, pitch));
    };
    const onUp = () => {
      isDragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camDist *= 1 + e.deltaY * 0.001;
      camDist = Math.max(0.6, Math.min(20, camDist));
    };
    mount.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    mount.addEventListener("wheel", onWheel, { passive: false });

    let updateCb: ((t: number) => void) | null = null;

    // Stub OrbitControls-shaped object so model code that touches
    // controls.target / controls.update() etc. doesn't crash. Our own orbit
    // implementation handles camera movement instead.
    const controlsStub = {
      target: new THREE.Vector3(0, 0, 0),
      update: () => {},
      enableDamping: false,
      autoRotate: false,
      enableZoom: false,
      enablePan: false,
      enableRotate: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispose: () => {},
    };
    try {
      const fn = compileFn(spec.setup_code);
      const ret = fn({ THREE, scene, camera, renderer, controls: controlsStub, group }) as
        | { update?: (t: number) => void }
        | undefined;
      if (ret && typeof ret.update === "function") updateCb = ret.update;
    } catch (e) {
      // Use warn (not error) so Next.js dev overlay doesn't surface the
      // crash as an Issue — the orchestrator handles retries.
      console.warn("3D setup error (will be reported for repair):", e);
      reportError(`3D scene crashed: ${(e as Error).message}`);
    }

    // Auto-derive a reasonable initial framing from the group bbox.
    try {
      const bbox = new THREE.Box3().setFromObject(group);
      if (bbox.isEmpty() === false) {
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        bbox.getSize(size);
        bbox.getCenter(center);
        const radius = Math.max(size.x, size.y, size.z) * 0.6 + 0.3;
        camDist = Math.max(2.0, radius * 2.4);
        // Re-center the group so orbit looks natural.
        group.position.sub(center);
      }
    } catch {
      /* ignore */
    }

    let raf = 0;
    const t0 = performance.now();
    const animate = () => {
      const t = (performance.now() - t0) / 1000;
      // Auto-rotate slowly until the user grabs control.
      if (!userInteracted) yaw = t * 0.25;
      const cy = Math.cos(pitch);
      camera.position.set(
        Math.sin(yaw) * cy * camDist,
        Math.sin(pitch) * camDist + 0.3,
        Math.cos(yaw) * cy * camDist,
      );
      camera.lookAt(0, 0, 0);
      try {
        updateCb?.(t);
      } catch (e) {
        console.warn("3D update threw (will be reported for repair):", e);
        reportError(`3D scene update threw: ${(e as Error).message}`);
        cancelAnimationFrame(raf);
        return; // stop the loop; orchestrator will swap the spec out
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    // Catch "silent" failures: setup_code that runs without throwing but
    // never adds anything visible to the scene (e.g. objects added to a
    // local variable instead of the provided `group`/`scene`). A scene with
    // no renderable objects draws a blank canvas with no error — report it
    // so the repair path can regenerate the spec.
    const blankCheck = window.setTimeout(() => {
      if (reportedRef.current) return;
      let renderable = 0;
      scene.traverse((obj) => {
        const o = obj as any;
        if (
          o.isMesh ||
          o.isLine ||
          o.isPoints ||
          o.isSprite
        ) {
          renderable++;
        }
      });
      if (renderable === 0) {
        reportError(
          "3D scene rendered nothing — the generated code added no visible objects.",
        );
      }
    }, 900);

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(blankCheck);
      ro.disconnect();
      mount.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      mount.removeEventListener("wheel", onWheel);
      try {
        renderer.dispose();
        if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      } catch {}
      // Dispose of geometries & materials.
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry?.dispose?.();
        const mat = (obj as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
        else mat?.dispose?.();
      });
    };
    // We deliberately do not depend on onRuntimeError so a parent re-render
    // doesn't tear down the WebGL context. The ref captures the latest one
    // through closure since it is stable across the spec lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  return (
    <div className="relative h-full w-full">
      <div ref={mountRef} className="h-full w-full cursor-grab active:cursor-grabbing" />
      {error && (
        <div className="absolute bottom-3 left-3 right-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      )}
      <div className="pointer-events-none absolute right-3 top-3 rounded-md border border-[var(--border-subtle)] bg-white/85 px-2.5 py-1 text-[10px] uppercase tracking-wider text-[var(--ink-500)] backdrop-blur">
        drag · scroll
      </div>
    </div>
  );
}
