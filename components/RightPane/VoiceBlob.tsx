"use client";

import { useEffect, useRef } from "react";

export type BlobState = "idle" | "listening" | "speaking" | "thinking";

type Props = {
  state: BlobState;
  level: number;
  size?: number;
};

export default function VoiceBlob({ state, level, size = 280 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<BlobState>(state);
  const levelRef = useRef<number>(level);
  const smoothLevelRef = useRef<number>(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    const start = performance.now();

    const draw = () => {
      const now = performance.now();
      const t = (now - start) / 1000;
      const st = stateRef.current;

      let target = levelRef.current;
      if (st === "speaking") {
        const pulse = 0.45 + 0.4 * Math.abs(Math.sin(t * 5.2));
        target = Math.max(target, pulse);
      } else if (st === "thinking") {
        target = 0.25 + 0.1 * Math.sin(t * 1.4);
      } else if (st === "idle") {
        target = 0.12 + 0.06 * Math.sin(t * 0.9);
      }
      smoothLevelRef.current += (target - smoothLevelRef.current) * 0.18;
      const lvl = smoothLevelRef.current;

      const cx = size / 2;
      const cy = size / 2;
      const baseR = size * 0.42;
      const speed =
        st === "speaking" ? 1.6 : st === "listening" ? 1.4 : st === "thinking" ? 0.9 : 0.55;

      ctx.clearRect(0, 0, size, size);

      const halo = ctx.createRadialGradient(cx, cy, baseR * 0.7, cx, cy, baseR * 1.25);
      halo.addColorStop(0, `rgba(180,180,255,${0.18 + lvl * 0.18})`);
      halo.addColorStop(1, "rgba(180,180,255,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR * 1.25, 0, Math.PI * 2);
      ctx.fill();

      const sphere = ctx.createRadialGradient(
        cx - baseR * 0.35,
        cy - baseR * 0.45,
        baseR * 0.15,
        cx,
        cy,
        baseR,
      );
      sphere.addColorStop(0, "rgba(255,255,255,0.96)");
      sphere.addColorStop(0.55, "rgba(255,255,255,0.6)");
      sphere.addColorStop(1, "rgba(255,255,255,0.0)");
      ctx.fillStyle = sphere;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, baseR * 0.96, 0, Math.PI * 2);
      ctx.clip();

      const intensity = 0.55 + lvl * 0.6;
      const palette: Array<[number, number, number]> = [
        [140, 158, 255],
        [196, 162, 255],
        [168, 220, 232],
        [240, 198, 220],
      ];
      for (let i = 0; i < palette.length; i++) {
        const phase = t * speed + i * 1.6;
        const wobble = 0.5 + lvl * 0.7;
        const ox =
          Math.sin(phase * 0.7 + i * 1.3) * baseR * 0.42 * wobble;
        const oy =
          Math.cos(phase * 0.55 + i * 0.9) * baseR * 0.34 * wobble;
        const r = baseR * (0.5 + 0.18 * Math.sin(phase * 0.5));
        const [pr, pg, pb] = palette[i];
        const grad = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r);
        grad.addColorStop(0, `rgba(${pr},${pg},${pb},${0.55 * intensity})`);
        grad.addColorStop(1, `rgba(${pr},${pg},${pb},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx + ox, cy + oy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      const waveAmp = baseR * (0.06 + lvl * 0.32);
      const waveCy = cy + Math.sin(t * speed * 0.6) * baseR * 0.08;
      ctx.beginPath();
      ctx.moveTo(cx - baseR, waveCy + baseR);
      for (let x = -baseR; x <= baseR; x += 3) {
        const k = x / baseR;
        const envelope = Math.cos(k * Math.PI * 0.5);
        const y =
          waveCy +
          (Math.sin(x * 0.04 + t * speed * 1.6) * waveAmp +
            Math.sin(x * 0.018 + t * speed * 0.9) * waveAmp * 0.6) *
            envelope;
        ctx.lineTo(cx + x, y);
      }
      ctx.lineTo(cx + baseR, waveCy + baseR);
      ctx.closePath();
      const waveGrad = ctx.createLinearGradient(cx - baseR, waveCy, cx + baseR, waveCy);
      waveGrad.addColorStop(0, `rgba(120,150,255,${0.32 + lvl * 0.25})`);
      waveGrad.addColorStop(0.5, `rgba(190,160,255,${0.45 + lvl * 0.25})`);
      waveGrad.addColorStop(1, `rgba(150,210,225,${0.32 + lvl * 0.25})`);
      ctx.fillStyle = waveGrad;
      ctx.fill();

      ctx.restore();

      const rim = ctx.createRadialGradient(cx, cy, baseR * 0.84, cx, cy, baseR);
      rim.addColorStop(0, "rgba(255,255,255,0)");
      rim.addColorStop(0.85, "rgba(255,255,255,0.06)");
      rim.addColorStop(1, "rgba(255,255,255,0.5)");
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
      ctx.fill();

      const hi = ctx.createRadialGradient(
        cx - baseR * 0.3,
        cy - baseR * 0.45,
        0,
        cx - baseR * 0.3,
        cy - baseR * 0.45,
        baseR * 0.55,
      );
      hi.addColorStop(0, "rgba(255,255,255,0.65)");
      hi.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = hi;
      ctx.beginPath();
      ctx.arc(cx - baseR * 0.3, cy - baseR * 0.45, baseR * 0.55, 0, Math.PI * 2);
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: size,
        height: size,
        maxWidth: "100%",
        filter: "drop-shadow(0 12px 40px rgba(140,150,210,0.22))",
      }}
    />
  );
}
