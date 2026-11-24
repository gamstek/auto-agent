export function sumPoreBands(
  distribution: readonly { widthAngstrom: number; poreVolumeCm3G: number }[],
  edges = [1, 2, 5, 10, 20, 100],
) {
  if (edges.some((edge, i) => !(edge > (edges[i - 1] ?? 0))))
    throw new Error('孔宽分段边界必须严格递增。');
  let cumulativeCm3G = 0;
  const total = distribution.reduce((sum, bin) => sum + bin.poreVolumeCm3G, 0);
  return [...edges, Infinity].map((upper, i) => {
    const lower = edges[i - 1] ?? 0;
    const volumeCm3G = distribution.reduce((sum, bin) => {
      const width = bin.widthAngstrom / 10;
      return width >= lower && width < upper ? sum + bin.poreVolumeCm3G : sum;
    }, 0);
    cumulativeCm3G += volumeCm3G;
    return {
      minWidthNm: lower,
      maxWidthNm: Number.isFinite(upper) ? upper : null,
      volumeCm3G,
      cumulativeCm3G,
      fraction: total > 0 ? volumeCm3G / total : null,
    };
  });
}
