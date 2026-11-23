import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../../bridge';
import type { ChatMedia } from '@auto-agent/desktop-protocol';
import { ChatImageViewer, type ImagePreviewItem } from './ChatImageViewer';
import './ChatImagePreview.css';

export function ChatImagePreview({
  media,
  route,
  gallery,
}: {
  media: ChatMedia;
  route?: string;
  gallery?: () => { items: ImagePreviewItem[]; index: number };
}) {
  const figure = useRef<HTMLElement>(null);
  const [viewer, setViewer] = useState<{ items: ImagePreviewItem[]; index: number } | null>(null);
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  const [approvedRoute, setApprovedRoute] = useState<string>();
  const remote = media.kind === 'url';
  const mayLoad = !remote || (route !== undefined && approvedRoute === route);
  const label = media.filename;
  const video = media.mediaType.startsWith('video/');
  const [dimensions, setDimensions] = useState({
    width: media.width ?? 640,
    height: media.height ?? 360,
  });
  const image = { ...media, ...dimensions };
  const src = media.kind === 'data' ? media.url : source;
  useEffect(() => {
    if (!route || !mayLoad) return;
    let active = true;
    const load = () => {
      void api<{ mediaType: string; base64: string }>(remote ? `${route}&load=1` : route)
        .then((data) => {
          if (!active) return;
          if (
            data.mediaType !== media.mediaType ||
            typeof data.base64 !== 'string' ||
            !data.base64
          ) {
            setFailed(true);
          } else {
            setSource(`data:${media.mediaType};base64,${data.base64}`);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    };
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    });
    if (remote) load();
    else if (figure.current) observer.observe(figure.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [route, media.mediaType, remote, mayLoad]);

  if (!mayLoad && media.kind === 'url')
    return (
      <figure className="chat-image-preview">
        <button type="button" className="ui-button" onClick={() => setApprovedRoute(route)}>
          加载远程{video ? '视频' : '图片'}
        </button>
        <figcaption>{new URL(media.url).origin}</figcaption>
      </figure>
    );

  if (video)
    return (
      <figure className="chat-image-preview" ref={figure}>
        {failed ? (
          <p role="status">视频无法预览</p>
        ) : (
          <video
            className="chat-video-preview"
            controls
            preload="none"
            src={src || undefined}
            width={image.width}
            height={image.height}
            aria-label={label}
            onError={() => setFailed(true)}
          />
        )}
        <figcaption>{label}</figcaption>
      </figure>
    );

  return (
    <figure className="chat-image-preview" ref={figure}>
      {failed ? (
        <p role="status">图片无法预览</p>
      ) : (
        <div
          className="chat-image-frame"
          style={
            {
              '--image-ratio': `${image.width} / ${image.height}`,
              '--image-width': `${image.width}px`,
            } as CSSProperties
          }
        >
          {src && (
            <button
              type="button"
              className="chat-image-open"
              aria-label={`放大查看：${label}`}
              onClick={() => {
                const selection = gallery?.();
                setViewer(
                  selection && selection.index >= 0
                    ? selection
                    : { items: [{ media, route }], index: 0 },
                );
              }}
            >
              <img
                src={src}
                alt={label}
                width={image.width}
                height={image.height}
                decoding="async"
                onLoad={(event) =>
                  setDimensions({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                onError={() => setFailed(true)}
              />
            </button>
          )}
        </div>
      )}
      <figcaption>{label}</figcaption>
      {viewer && src && (
        <ChatImageViewer {...viewer} initialSource={src} onClose={() => setViewer(null)} />
      )}
    </figure>
  );
}
