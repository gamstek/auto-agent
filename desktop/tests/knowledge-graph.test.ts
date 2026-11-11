import { expect, test } from 'bun:test';
import type { KnowledgePageEntry } from '@auto-agent/desktop-protocol';
import { knowledgeGraph, layoutKnowledgeGraph } from '../src/lib/knowledge-graph';

function page(
  path: string,
  related: string[] = [],
  generation = 'fixed-publication',
): KnowledgePageEntry {
  return {
    path,
    title: path,
    summary: 'Published knowledge',
    type: 'concept',
    reference: { path, generation, sha256: 'a'.repeat(64) },
    related,
  };
}

test('graph edges come only from explicit links to known pages in the same publication', () => {
  const graph = knowledgeGraph([
    page('concepts/a.md', ['concepts/b#section', 'missing.md', 'concepts/a.md', 'other.md']),
    page('concepts/b.md', ['concepts/a.md']),
    page('other.md', [], 'different-publication'),
    { ...page('index.md'), type: 'navigation' },
  ]);
  expect(graph.nodes.map((node) => node.path)).toEqual(['concepts/a.md', 'concepts/b.md']);
  expect(graph.links).toEqual([{ from: 'concepts/a.md', to: 'concepts/b.md' }]);
  expect(graph.total).toBe(2);
});

test('unconnected pages stay unconnected and graph size stays bounded', () => {
  const pages = Array.from({ length: 100 }, (_, index) => page(`concepts/${index}.md`));
  const graph = knowledgeGraph(pages, 1000);
  expect(graph.nodes).toHaveLength(48);
  expect(graph.links).toEqual([]);
  expect(graph.total).toBe(100);
  expect(pages).toHaveLength(100);
});

test('layout is deterministic, bounded and does not change published metadata', () => {
  const pages = [page('a.md', ['b.md']), page('b.md'), page('c.md')];
  const original = JSON.stringify(pages);
  const graph = knowledgeGraph(pages);
  const points = layoutKnowledgeGraph(graph, 600, 360);
  expect(layoutKnowledgeGraph(graph, 600, 360)).toEqual(points);
  for (const point of points) {
    expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    expect(point.x >= 60 && point.x <= 540 && point.y >= 35 && point.y <= 310).toBe(true);
  }
  expect(JSON.stringify(pages)).toBe(original);
});
