import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Focus, Maximize2, Minimize2, Minus, Network, Plus, Type } from 'lucide-react';
import type { KnowledgePageEntry } from '@auto-agent/desktop-protocol';
import {
  knowledgeGraph,
  knowledgeKind,
  knowledgeKinds,
  layoutKnowledgeGraph,
} from '../../lib/knowledge-graph';
import { IconButton } from '../IconButton/IconButton';
import './KnowledgeGraph.css';

export function KnowledgeGraph({
  pages,
  selected,
  onSelect,
  graphOnly = false,
  onToggleFocus,
  floatingControls = false,
  active = true,
}: {
  pages: readonly KnowledgePageEntry[];
  selected?: string;
  onSelect: (page: KnowledgePageEntry) => void;
  graphOnly?: boolean;
  onToggleFocus?: () => void;
  floatingControls?: boolean;
  active?: boolean;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 360 });
  const [hovered, setHovered] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const [showLabels, setShowLabels] = useState(true);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const graph = useMemo(() => knowledgeGraph(pages), [pages]);
  const points = useMemo(() => layoutKnowledgeGraph(graph, size.width, size.height), [graph, size]);
  const positions = new Map(points.map((point) => [point.path, point]));
  const candidate = hovered ?? focused ?? selected;
  const highlight = graph.nodes.some((node) => node.path === candidate) ? candidate : undefined;
  const neighbors = new Set([highlight]);
  const degrees = new Map<string, number>();
  for (const link of graph.links) {
    degrees.set(link.from, (degrees.get(link.from) ?? 0) + 1);
    degrees.set(link.to, (degrees.get(link.to) ?? 0) + 1);
    if (link.from === highlight) neighbors.add(link.to);
    if (link.to === highlight) neighbors.add(link.from);
  }
  useLayoutEffect(() => {
    if (!active) return;
    const element = canvas.current!;
    const measure = () =>
      setSize((previous) => {
        if (!element.clientWidth || !element.clientHeight) return previous;
        const width = Math.max(240, Math.floor(element.clientWidth)),
          height = Math.max(280, element.clientHeight);
        return previous.width === width && previous.height === height
          ? previous
          : { width, height };
      });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    setTransform({ x: 0, y: 0, scale: 1 });
    setHovered(undefined);
    setFocused(undefined);
  }, [graph.nodes[0]?.reference.generation]);
  function zoom(delta: number) {
    setTransform((previous) => {
      const scale = Math.max(0.6, Math.min(1.8, previous.scale + delta));
      const factor = scale / previous.scale;
      return {
        scale,
        x: size.width / 2 - (size.width / 2 - previous.x) * factor,
        y: size.height / 2 - (size.height / 2 - previous.y) * factor,
      };
    });
  }
  return (
    <section
      className="knowledge-graph"
      aria-label="知识关联图"
      data-floating-controls={floatingControls}
    >
      <header>
        <div>
          <Network size={16} />
          <strong>知识关联</strong>
          <span>
            {graph.nodes.length} 个节点 · {graph.links.length} 条关联
          </span>
        </div>
        <div className="knowledge-graph-controls">
          <IconButton
            label="切换节点标签"
            aria-pressed={showLabels}
            onClick={() => setShowLabels((value) => !value)}
          >
            <Type size={14} />
          </IconButton>
          <IconButton
            label="聚焦选中节点"
            disabled={!selected || !positions.has(selected)}
            onClick={() => {
              const point = selected ? positions.get(selected) : undefined;
              if (point)
                setTransform({
                  scale: 1.2,
                  x: size.width / 2 - point.x * 1.2,
                  y: size.height / 2 - point.y * 1.2,
                });
            }}
          >
            <Crosshair size={14} />
          </IconButton>
          <IconButton label="缩小图谱" onClick={() => zoom(-0.2)} disabled={transform.scale <= 0.6}>
            <Minus size={14} />
          </IconButton>
          <IconButton label="重置图谱视图" onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>
            <Focus size={14} />
          </IconButton>
          <IconButton label="放大图谱" onClick={() => zoom(0.2)} disabled={transform.scale >= 1.8}>
            <Plus size={14} />
          </IconButton>
          {onToggleFocus && (
            <IconButton label={graphOnly ? '退出图谱专注' : '专注图谱'} onClick={onToggleFocus}>
              {graphOnly ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </IconButton>
          )}
        </div>
      </header>
      <div className="knowledge-graph-canvas" ref={canvas}>
        {graph.nodes.length ? (
          <svg
            viewBox={`0 0 ${size.width} ${size.height}`}
            role="group"
            aria-label="知识节点与明确关联"
            onPointerDown={(event) => {
              if ((event.target as Element).closest('[data-knowledge-node]')) return;
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                originX: transform.x,
                originY: transform.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (start)
                setTransform((previous) => ({
                  ...previous,
                  x: start.originX + event.clientX - start.x,
                  y: start.originY + event.clientY - start.y,
                }));
            }}
            onPointerUp={(event) => {
              drag.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <desc>
              连接来自已发布页面的 related 关联。拖动背景可移动视图，点选或按回车阅读知识页。
            </desc>
            <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
              {graph.links.map((link) => {
                const from = positions.get(link.from)!,
                  to = positions.get(link.to)!;
                return (
                  <line
                    key={JSON.stringify([link.from, link.to])}
                    className="knowledge-graph-edge"
                    data-highlight={
                      !!highlight && (link.from === highlight || link.to === highlight)
                    }
                    data-muted={!!highlight && link.from !== highlight && link.to !== highlight}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                  />
                );
              })}
              {points.map((point) => {
                const kind = knowledgeKind(point.type);
                const emphasized = neighbors.has(point.path);
                const label = showLabels || emphasized || selected === point.path;
                const radius = 6 + Math.min(7, Math.sqrt(degrees.get(point.path) ?? 0) * 1.8);
                return (
                  <g
                    key={point.path}
                    className="knowledge-graph-node"
                    data-knowledge-node={point.path}
                    data-selected={point.path === selected}
                    data-muted={!!highlight && !emphasized}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看知识页：${point.title}`}
                    onPointerEnter={(event) => {
                      if (event.pointerType === 'mouse') setHovered(point.path);
                    }}
                    onPointerLeave={() => setHovered(undefined)}
                    onFocus={() => setFocused(point.path)}
                    onBlur={() => setFocused(undefined)}
                    onClick={() => onSelect(point)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect(point);
                      }
                    }}
                  >
                    <title>
                      {point.title} · {kind.label}
                    </title>
                    <circle
                      className="knowledge-graph-halo"
                      cx={point.x}
                      cy={point.y}
                      r={radius + 10}
                      fill={kind.color}
                    />
                    <circle
                      className="knowledge-graph-dot"
                      cx={point.x}
                      cy={point.y}
                      r={radius}
                      fill={kind.color}
                    />
                    {label && (
                      <text x={point.x} y={point.y + radius + 16} textAnchor="middle">
                        {Array.from(point.title).slice(0, 13).join('')}
                        {Array.from(point.title).length > 13 ? '…' : ''}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        ) : (
          <div className="knowledge-graph-empty">
            <Network size={34} strokeWidth={1} />
            <strong>知识的连接，从一份资料开始</strong>
            <p>添加资料并明确开始整理后，已发布页面与关联会出现在这里。</p>
          </div>
        )}
      </div>
      <footer>
        <div className="knowledge-graph-legend">
          {Object.entries(knowledgeKinds).map(([type, kind]) => (
            <span key={type}>
              <i style={{ background: kind.color }} />
              {kind.label} {graph.nodes.filter((node) => node.type === type).length}
            </span>
          ))}
        </div>
        <span>
          {graph.partialLinks
            ? '部分关联未载入当前视图'
            : graph.total > graph.nodes.length
              ? `展示 ${graph.nodes.length}/${graph.total} 个已加载页面`
              : graph.nodes.length && !graph.links.length
                ? '已加载节点间暂无明确关联'
                : '仅展示已加载页面的明确关联'}
        </span>
      </footer>
    </section>
  );
}
