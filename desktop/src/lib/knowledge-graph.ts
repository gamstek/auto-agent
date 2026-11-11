import type { KnowledgePageEntry } from '@auto-agent/desktop-protocol';

export const knowledgeKinds: Record<string, { label: string; color: string }> = {
  source: { label: '来源', color: '#e6a055' },
  entity: { label: '实体', color: '#5d9ced' },
  concept: { label: '概念', color: '#a688d3' },
  topic: { label: '主题', color: '#56aaa2' },
};
export const knowledgeKind = (type: string) =>
  knowledgeKinds[type] ?? { label: '知识', color: '#8e9eb2' };

export function knowledgeGraph(pages: readonly KnowledgePageEntry[], limit = 48) {
  const unique = [
    ...new Map(
      pages.filter((page) => page.type !== 'navigation').map((page) => [page.path, page]),
    ).values(),
  ];
  const generation = unique[0]?.reference.generation;
  const eligible = unique.filter((page) => page.reference.generation === generation);
  const nodes = eligible.slice(0, Math.min(48, Math.max(0, Math.floor(limit))));
  const known = new Set(nodes.map((node) => node.path));
  const links = new Map<string, { from: string; to: string }>();
  for (const page of nodes)
    for (const related of page.related ?? []) {
      const path = related.split('|')[0]!.split('#')[0]!;
      const target = path.endsWith('.md') ? path : `${path}.md`;
      if (!known.has(target) || target === page.path) continue;
      const [from, to] = [page.path, target].sort() as [string, string];
      links.set(JSON.stringify([from, to]), { from, to });
    }
  return {
    nodes,
    links: [...links.values()],
    total: eligible.length,
    partialLinks: nodes.some((node) => node.relatedTruncated),
  };
}

/** Deterministic bounded layout. Positions carry no inferred semantic meaning. */
export function layoutKnowledgeGraph(
  graph: ReturnType<typeof knowledgeGraph>,
  width: number,
  height: number,
) {
  const points = graph.nodes.map((node, index) => {
    const angle = index * 2.3999632297;
    const radius = Math.sqrt((index + 0.5) / Math.max(1, graph.nodes.length));
    return {
      ...node,
      x: width / 2 + Math.cos(angle) * width * 0.3 * radius,
      y: height / 2 + Math.sin(angle) * height * 0.3 * radius,
    };
  });
  const indexes = new Map(points.map((point, index) => [point.path, index]));
  const distance = Math.min(160, Math.sqrt((width * height) / Math.max(1, points.length)) * 0.65);
  for (let step = 0; step < 70; step++) {
    const displacement = points.map(() => ({ x: 0, y: 0 }));
    for (let a = 0; a < points.length; a++)
      for (let b = a + 1; b < points.length; b++) {
        const dx = points[a]!.x - points[b]!.x,
          dy = points[a]!.y - points[b]!.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const force = (distance * distance) / length;
        displacement[a]!.x += (dx / length) * force;
        displacement[a]!.y += (dy / length) * force;
        displacement[b]!.x -= (dx / length) * force;
        displacement[b]!.y -= (dy / length) * force;
      }
    for (const link of graph.links) {
      const a = indexes.get(link.from)!,
        b = indexes.get(link.to)!;
      const dx = points[a]!.x - points[b]!.x,
        dy = points[a]!.y - points[b]!.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const force = ((length * length) / distance) * 0.2;
      displacement[a]!.x -= (dx / length) * force;
      displacement[a]!.y -= (dy / length) * force;
      displacement[b]!.x += (dx / length) * force;
      displacement[b]!.y += (dy / length) * force;
    }
    const temperature = 7 * (1 - step / 70);
    points.forEach((point, index) => {
      const delta = displacement[index]!;
      const centering = points.length < 8 ? 0.8 : 0.15;
      delta.x += (width / 2 - point.x) * centering;
      delta.y += (height / 2 - point.y) * centering;
      const length = Math.max(1, Math.hypot(delta.x, delta.y));
      point.x = Math.max(
        60,
        Math.min(width - 60, point.x + (delta.x / length) * Math.min(length, temperature)),
      );
      point.y = Math.max(
        35,
        Math.min(height - 50, point.y + (delta.y / length) * Math.min(length, temperature)),
      );
    });
  }
  return points;
}
