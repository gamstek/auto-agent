import { kernelResponse, type Kernel, type Point } from './kernel';
import { setImmediate } from 'node:timers/promises';

export const nldftMethod = 'g12-kernel-discrete-nnls-v1';

const norm = (values: ArrayLike<number>) => Math.sqrt(dot(values, values));
function dot(a: ArrayLike<number>, b: ArrayLike<number>) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// Accelerated projected gradient for 1/2 x' H x - b' x with x >= 0.
async function solve(h: Float64Array[], b: Float64Array, signal?: AbortSignal) {
  const l = Math.max(...h.map((row) => row.reduce((sum, x) => sum + Math.abs(x), 0)));
  if (!l) throw new Error('模型核在选定区间内没有有效响应。');
  const tolerance = Math.max(...b.map(Math.abs)) * 2e-6;
  let current = new Float64Array(b.length);
  const y = new Float64Array(b.length);
  let next = new Float64Array(b.length);
  let momentum = 1;
  let iteration = 0;
  let converged = false;
  for (; iteration < 12_000; iteration++) {
    if (iteration % 128 === 0) await setImmediate(undefined, { signal });
    let restart = 0;
    for (let j = 0; j < b.length; j++) {
      next[j] = Math.max(0, y[j] - (dot(h[j], y) - b[j]) / l);
      restart += (y[j] - next[j]) * (next[j] - current[j]);
    }
    const t = restart > 0 ? 1 : (1 + Math.sqrt(1 + 4 * momentum ** 2)) / 2;
    const boost = restart > 0 ? 0 : (momentum - 1) / t;
    for (let j = 0; j < b.length; j++) y[j] = next[j] + boost * (next[j] - current[j]);
    momentum = t;
    [current, next] = [next, current];
    if (iteration % 32 === 0) {
      let kkt = 0;
      for (let j = 0; j < b.length; j++) {
        const g = dot(h[j], current) - b[j];
        kkt = Math.max(kkt, current[j] > 0 ? Math.abs(g) : Math.max(-g, 0));
      }
      if (kkt <= tolerance) {
        converged = true;
        break;
      }
    }
  }
  return { current, converged, iterations: Math.min(iteration + 1, 12_000) };
}

export async function fitNldft(
  kernel: Kernel,
  points: Point[],
  options: { minPP0?: number; maxPP0?: number; lambda?: number; signal?: AbortSignal } = {},
) {
  const min = Math.max(options.minPP0 ?? 0, kernel.pressures[0]);
  const max = Math.min(options.maxPP0 ?? 1, kernel.pressures.at(-1)!);
  const measured = points.filter(
    ({ pp0, uptake }) => pp0 >= min && pp0 <= max && uptake >= 0 && Number.isFinite(uptake),
  );
  if (new Set(measured.map((point) => point.pp0)).size < 3 || !measured.some((p) => p.uptake > 0)) {
    throw new Error('模型核与实测数据的重叠区间须有至少三个不同压力点和正吸附量。');
  }
  const a = measured.map((p) => kernelResponse(kernel, p.pp0));
  const n = kernel.widths.length;
  const m = a.length;
  if (m > 2000) throw new Error('拟合数据超过 2000 点，请缩小压力范围。');
  const scale2 = a.reduce((sum, row) => sum + dot(row, row), 0) / (m * n);
  if (!Number.isFinite(scale2) || scale2 <= 0) throw new Error('模型核没有可用的有限吸附响应。');
  const h = Array.from({ length: n }, () => new Float64Array(n));
  const b = new Float64Array(n);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      b[j] += a[i][j] * measured[i].uptake;
      for (let k = 0; k <= j; k++) h[j][k] += a[i][j] * a[i][k];
    }
  }
  for (let j = 0; j < n; j++) {
    b[j] /= m * scale2;
    for (let k = 0; k <= j; k++) h[k][j] = h[j][k] /= m * scale2;
  }
  // Smooth the discrete bin contributions within a geometry, not across geometry boundaries.
  const neighbors = kernel.widths
    .slice(1)
    .flatMap((_, j) => (kernel.geometryCodes?.[j] !== kernel.geometryCodes?.[j + 1] ? [] : [j]));
  const lambdas =
    options.lambda === undefined ? [0.0001, 0.001, 0.01, 0.1, 1, 10] : [options.lambda];
  const candidates = [];
  for (const lambda of lambdas) {
    const matrix = h.map((row) => row.slice());
    for (const j of neighbors) {
      matrix[j][j] += lambda;
      matrix[j + 1][j + 1] += lambda;
      matrix[j][j + 1] -= lambda;
      matrix[j + 1][j] -= lambda;
    }
    const solved = await solve(matrix, b, options.signal);
    const fitted = a.map((row) => dot(row, solved.current));
    const rmse = norm(fitted.map((value, i) => value - measured[i].uptake)) / Math.sqrt(m);
    const roughness = norm(neighbors.map((j) => solved.current[j + 1] - solved.current[j]));
    candidates.push({ ...solved, lambda, fitted, rmse, roughness });
  }
  // Select the corner of the sampled log residual–roughness curve.
  const eligible = candidates.filter((c) => c.converged);
  let selected = eligible[0] ?? candidates[0];
  let best = 0;
  for (let i = 1; i < eligible.length - 1; i++) {
    const [p, q, r] = eligible
      .slice(i - 1, i + 2)
      .map(({ rmse, roughness }) => [
        Math.log(Math.max(rmse, 1e-30)),
        Math.log(Math.max(roughness, 1e-30)),
      ]);
    const [ux, uy, vx, vy] = [q[0] - p[0], q[1] - p[1], r[0] - q[0], r[1] - q[1]];
    const curvature =
      (2 * Math.abs(ux * vy - uy * vx)) /
      (Math.hypot(ux, uy) * Math.hypot(vx, vy) * Math.hypot(ux + vx, uy + vy));
    if (curvature > best) {
      best = curvature;
      selected = eligible[i];
    }
  }
  let total = 0;
  return {
    method: nldftMethod,
    lambda: selected.lambda,
    selection: options.lambda !== undefined ? 'fixed' : best > 0 ? 'l-curve' : 'grid-fallback',
    converged: selected.converged,
    candidates: candidates.map(({ lambda, rmse, roughness, converged, iterations }) => ({
      lambda,
      rmse,
      roughness,
      converged,
      iterations,
    })),
    omittedPoints: points.length - m,
    rmse: selected.rmse,
    distribution: kernel.widths.map((widthAngstrom, j) => ({
      widthAngstrom,
      ...(kernel.geometryCodes && { geometryCode: kernel.geometryCodes[j] }),
      poreVolumeCm3G: selected.current[j],
      cumulativeCm3G: (total += selected.current[j]),
    })),
    totalPoreVolumeCm3G: total,
    fit: measured.map((point, i) => ({
      ...point,
      fitted: selected.fitted[i],
      residual: point.uptake - selected.fitted[i],
    })),
  };
}
