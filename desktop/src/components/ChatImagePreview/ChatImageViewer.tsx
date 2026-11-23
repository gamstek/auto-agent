import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Maximize, Minus, Plus, Scan, X } from 'lucide-react';
import { api } from '../../bridge';
import type { ChatMedia } from '@auto-agent/desktop-protocol';
import { IconButton } from '../IconButton/IconButton';

export type ImagePreviewItem = { media: ChatMedia; route?: string };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function ChatImageViewer({
  items,
  index: initialIndex,
  initialSource,
  onClose,
}: {
  items: readonly ImagePreviewItem[];
  index: number;
  initialSource: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [index, setIndex] = useState(initialIndex);
  const [sources, setSources] = useState<Record<number, string>>({ [initialIndex]: initialSource });
  const [failed, setFailed] = useState<number | null>(null);
  const [approvedIndex, setApprovedIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const { media, route } = items[index];
  const source = media.kind === 'data' ? media.url : sources[index];
  const remote = media.kind === 'url';
  const waitingForLoad = remote && !source && approvedIndex !== index;
  const width = natural.width || media.width || 640;
  const height = natural.height || media.height || 360;
  const fit = Math.min(
    1,
    Math.max(1, viewport.width - 48) / width,
    Math.max(1, viewport.height - 32) / height,
  );
  const scale = zoom ?? fit;
  const bounds = (factor: number) => ({
    x: Math.max(0, (width * factor - viewport.width) / 2),
    y: Math.max(0, (height * factor - viewport.height) / 2),
  });
  const boundedPan = (x: number, y: number, factor = scale) => {
    const limit = bounds(factor);
    return { x: clamp(x, -limit.x, limit.x), y: clamp(y, -limit.y, limit.y) };
  };
  const position = boundedPan(pan.x, pan.y);
  const canPan = bounds(scale).x > 0 || bounds(scale).y > 0;

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      if (node?.open) node.close();
    };
  }, []);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (source || !route || waitingForLoad) return;
    let active = true;
    void api<{ mediaType: string; base64: string }>(remote ? `${route}&load=1` : route)
      .then((data) => {
        if (data.mediaType !== media.mediaType || !data.base64) throw new Error('Invalid media');
        if (active)
          setSources((prev) => ({
            ...prev,
            [index]: `data:${data.mediaType};base64,${data.base64}`,
          }));
      })
      .catch(() => {
        if (active) setFailed(index);
      });
    return () => {
      active = false;
    };
  }, [source, route, index, media.mediaType, remote, waitingForLoad]);

  function reset(factor: number | null = null) {
    setZoom(factor);
    setPan({ x: 0, y: 0 });
  }
  function move(delta: number) {
    const next = clamp(index + delta, 0, items.length - 1);
    if (next === index) return;
    setNatural({ width: 0, height: 0 });
    setFailed(null);
    setApprovedIndex(null);
    setIndex(next);
    reset();
  }
  function changeZoom(factor: number, x = 0, y = 0) {
    const next = clamp(factor, Math.min(0.25, fit), 4);
    setZoom(next);
    const ratio = next / scale;
    setPan(boundedPan(x - (x - position.x) * ratio, y - (y - position.y) * ratio, next));
  }
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!source) return;
      const rect = node.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      changeZoom(
        scale * Math.exp(-delta * 0.002),
        event.clientX - rect.left - rect.width / 2,
        event.clientY - rect.top - rect.height / 2,
      );
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  });

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !canPan) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: position.x,
      top: position.y,
    };
    setDragging(true);
  }

  return (
    <dialog
      className="chat-image-dialog"
      ref={dialog}
      aria-label={`图片预览：${media.filename}`}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          move(event.key === 'ArrowLeft' ? -1 : 1);
        }
        if (event.key === '+' || event.key === '=') changeZoom(scale + 0.25);
        if (event.key === '-') changeZoom(scale - 0.25);
      }}
    >
      <header className="chat-image-toolbar">
        <div className="chat-image-heading">
          <h2 title={media.filename}>{media.filename}</h2>
          <span>
            {width} × {height} px
          </span>
        </div>
        <form method="dialog">
          <IconButton type="submit" label="关闭预览" autoFocus>
            <X size={18} />
          </IconButton>
        </form>
      </header>
      <section className="chat-image-stage" aria-label="图片浏览">
        <div
          className="chat-image-canvas"
          ref={canvas}
          data-pan={canPan}
          data-dragging={dragging}
          onPointerDown={startDrag}
          onPointerMove={(event) => {
            const start = drag.current;
            if (start?.id === event.pointerId)
              setPan(
                boundedPan(
                  start.left + event.clientX - start.x,
                  start.top + event.clientY - start.y,
                ),
              );
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
        >
          {waitingForLoad && media.kind === 'url' ? (
            <div>
              <button type="button" className="ui-button" onClick={() => setApprovedIndex(index)}>
                加载远程图片
              </button>
              <p>{new URL(media.url).origin}</p>
            </div>
          ) : failed === index ? (
            <p role="status">图片无法预览</p>
          ) : source ? (
            <img
              key={index}
              src={source}
              alt={media.filename}
              draggable={false}
              width={width}
              height={height}
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => setFailed(index)}
              style={{
                width: width * scale,
                height: height * scale,
                transform: `translate(${position.x}px, ${position.y}px)`,
              }}
            />
          ) : (
            <p role="status">正在加载图片…</p>
          )}
        </div>
        {items.length > 1 && (
          <>
            <IconButton
              className="chat-image-previous"
              label="上一张"
              aria-disabled={index === 0}
              onClick={() => move(-1)}
            >
              <ChevronLeft size={22} />
            </IconButton>
            <IconButton
              className="chat-image-next"
              label="下一张"
              aria-disabled={index === items.length - 1}
              onClick={() => move(1)}
            >
              <ChevronRight size={22} />
            </IconButton>
          </>
        )}
      </section>
      <footer className="chat-image-controls" aria-label="图片缩放">
        {items.length > 1 && (
          <output aria-live="polite" aria-label="图片位置">
            {index + 1} / {items.length}
          </output>
        )}
        <IconButton label="适应窗口" selected={zoom === null} onClick={() => reset()}>
          <Maximize size={16} />
        </IconButton>
        <IconButton label="原始大小" selected={zoom === 1} onClick={() => reset(1)}>
          <Scan size={16} />
        </IconButton>
        <span className="chat-image-controls-divider" aria-hidden="true" />
        <IconButton
          label="缩小图片"
          disabled={scale <= Math.min(0.25, fit)}
          onClick={() => changeZoom(scale - 0.25)}
        >
          <Minus size={16} />
        </IconButton>
        <output aria-live="polite">{zoom === null ? '适应' : `${Math.round(scale * 100)}%`}</output>
        <IconButton label="放大图片" disabled={scale >= 4} onClick={() => changeZoom(scale + 0.25)}>
          <Plus size={16} />
        </IconButton>
      </footer>
    </dialog>
  );
}
