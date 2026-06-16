"use client";

import { useEffect, useRef, useState } from "react";
import type { GraphSpec } from "@/lib/schemas";

type Props = {
  spec: GraphSpec;
  /** Called once per spec instance if the chart fails to render. */
  onRuntimeError?: (message: string) => void;
};

const COLORS = ["#5b66f1", "#d97706", "#db2777", "#7c3aed", "#059669", "#dc2626"];

function safeFn(expr: string): (x: number) => number {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function("Math", "x", `return (${expr});`) as (M: typeof Math, x: number) => number;
  return (x: number) => fn(Math, x);
}

export default function GraphView({ spec, onRuntimeError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reportedRef = useRef(false);
  const [themeVersion, setThemeVersion] = useState(0);

  // Re-draw when the html.dark class toggles.
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setThemeVersion((v) => v + 1));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

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
    const c = canvasRef.current;
    const cont = containerRef.current;
    if (!c || !cont) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio, 2);
    const W = cont.clientWidth;
    const H = cont.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const isDark = document.documentElement.classList.contains("dark");
    const ink = isDark ? "#d4d4d8" : "#2a2c33";
    const inkMuted = isDark ? "#a1a1aa" : "#6b6e78";
    ctx.fillStyle = isDark ? "#1a1a1f" : "#ffffff";
    ctx.fillRect(0, 0, W, H);

    const padL = 50;
    const padR = 20;
    const padT = 20;
    const padB = 40;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    type Pt = [number, number];
    type Series = { name?: string; color: string; points: Pt[] };

    const series: Series[] = [];

    try {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(spec.data_json) as Record<string, unknown>;
      } catch (parseErr) {
        throw new Error(`Could not parse graph data_json: ${(parseErr as Error).message}`);
      }
      if (spec.chart_type === "function") {
        const fn = safeFn((data.fn as string) || "x");
        const xMin = (data.x_min as number) ?? -5;
        const xMax = (data.x_max as number) ?? 5;
        const samples = Math.max(20, Math.min(2000, (data.samples as number) ?? 200));
        const pts: Pt[] = [];
        for (let i = 0; i <= samples; i++) {
          const x = xMin + ((xMax - xMin) * i) / samples;
          const y = fn(x);
          if (Number.isFinite(y)) pts.push([x, y]);
        }
        series.push({ color: COLORS[0], points: pts, name: spec.title });
      } else if (spec.chart_type === "points") {
        const pts = (data.points as Pt[]) ?? [];
        series.push({ color: COLORS[0], points: pts, name: spec.title });
      } else if (spec.chart_type === "lines") {
        const ss = (data.series as Array<{ name: string; color?: string; points: Pt[] }>) ?? [];
        ss.forEach((s, i) => series.push({ name: s.name, color: s.color || COLORS[i % COLORS.length], points: s.points }));
      } else if (spec.chart_type === "bars") {
        const bars = (data.bars as Array<{ label: string; value: number }>) ?? [];
        // draw bars directly
        const maxV = Math.max(...bars.map((b) => b.value), 1);
        const bw = (plotW / bars.length) * 0.7;
        const gap = (plotW / bars.length) * 0.3;
        ctx.font = "11px ui-sans-serif, system-ui";
        ctx.textAlign = "center";
        bars.forEach((b, i) => {
          const x = padL + i * (bw + gap) + gap / 2;
          const h = (b.value / maxV) * plotH;
          const y = padT + plotH - h;
          ctx.fillStyle = COLORS[i % COLORS.length];
          ctx.fillRect(x, y, bw, h);
          ctx.fillStyle = ink;
          ctx.fillText(b.label, x + bw / 2, padT + plotH + 16);
          ctx.fillStyle = inkMuted;
          ctx.fillText(String(b.value), x + bw / 2, y - 6);
        });
        // axis labels
        ctx.textAlign = "center";
        ctx.fillStyle = inkMuted;
        ctx.fillText(spec.x_label || "", W / 2, H - 6);
        ctx.save();
        ctx.translate(14, H / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(spec.y_label || "", 0, 0);
        ctx.restore();
        return;
      }

      // For non-bar charts: compute extents from all series.
      const allPts = series.flatMap((s) => s.points);
      if (!allPts.length) {
        ctx.fillStyle = isDark ? "#f87171" : "#9f1f3a";
        ctx.fillText("No data points", 20, 40);
        return;
      }
      const xs = allPts.map((p) => p[0]);
      const ys = allPts.map((p) => p[1]);
      let xMin = Math.min(...xs);
      let xMax = Math.max(...xs);
      let yMin = Math.min(...ys);
      let yMax = Math.max(...ys);
      if (xMin === xMax) {
        xMin -= 1;
        xMax += 1;
      }
      if (yMin === yMax) {
        yMin -= 1;
        yMax += 1;
      }
      // Pad y range a touch.
      const padY = (yMax - yMin) * 0.07;
      yMin -= padY;
      yMax += padY;

      const sx = (x: number) => padL + ((x - xMin) / (xMax - xMin)) * plotW;
      const sy = (y: number) => padT + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

      // Grid + axes
      ctx.strokeStyle = isDark ? "rgba(238,238,242,0.1)" : "rgba(20,22,26,0.08)";
      ctx.lineWidth = 1;
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.fillStyle = inkMuted;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const yTicks = 5;
      for (let i = 0; i <= yTicks; i++) {
        const y = yMin + ((yMax - yMin) * i) / yTicks;
        const py = sy(y);
        ctx.beginPath();
        ctx.moveTo(padL, py);
        ctx.lineTo(padL + plotW, py);
        ctx.stroke();
        ctx.fillText(y.toFixed(Math.abs(y) < 10 ? 2 : 0), padL - 6, py);
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const xTicks = 6;
      for (let i = 0; i <= xTicks; i++) {
        const x = xMin + ((xMax - xMin) * i) / xTicks;
        const px = sx(x);
        ctx.beginPath();
        ctx.moveTo(px, padT);
        ctx.lineTo(px, padT + plotH);
        ctx.stroke();
        ctx.fillText(x.toFixed(Math.abs(x) < 10 ? 2 : 0), px, padT + plotH + 4);
      }

      // Origin axes
      if (xMin <= 0 && xMax >= 0) {
        ctx.strokeStyle = isDark ? "rgba(238,238,242,0.3)" : "rgba(20,22,26,0.22)";
        ctx.beginPath();
        ctx.moveTo(sx(0), padT);
        ctx.lineTo(sx(0), padT + plotH);
        ctx.stroke();
      }
      if (yMin <= 0 && yMax >= 0) {
        ctx.strokeStyle = isDark ? "rgba(238,238,242,0.3)" : "rgba(20,22,26,0.22)";
        ctx.beginPath();
        ctx.moveTo(padL, sy(0));
        ctx.lineTo(padL + plotW, sy(0));
        ctx.stroke();
      }

      // Series
      series.forEach((s) => {
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = 2;
        if (spec.chart_type === "points") {
          for (const [px, py] of s.points) {
            ctx.beginPath();
            ctx.arc(sx(px), sy(py), 3, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          ctx.beginPath();
          s.points.forEach(([px, py], i) => {
            const X = sx(px);
            const Y = sy(py);
            if (i === 0) ctx.moveTo(X, Y);
            else ctx.lineTo(X, Y);
          });
          ctx.stroke();
        }
      });

      // Legend (lines/points only when multiple series)
      if (series.length > 1) {
        let lx = padL + 10;
        const ly = padT + 10;
        ctx.font = "11px ui-sans-serif, system-ui";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        series.forEach((s) => {
          ctx.fillStyle = s.color;
          ctx.fillRect(lx, ly - 3, 18, 6);
          ctx.fillStyle = ink;
          const txt = s.name || "";
          ctx.fillText(txt, lx + 24, ly);
          lx += 30 + ctx.measureText(txt).width;
        });
      }

      // Axis labels
      ctx.fillStyle = inkMuted;
      ctx.font = "11px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.fillText(spec.x_label || "x", padL + plotW / 2, H - 8);
      ctx.save();
      ctx.translate(14, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(spec.y_label || "y", 0, 0);
      ctx.restore();
    } catch (e) {
      console.warn("graph render threw (will be reported for repair):", e);
      reportError(`Graph render failed: ${(e as Error).message}`);
    }
    // onRuntimeError captured by closure; we don't re-render the chart on
    // every parent rerender that produces a new function reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, themeVersion]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full" />
      {error && (
        <div className="absolute bottom-3 left-3 right-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      )}
    </div>
  );
}
