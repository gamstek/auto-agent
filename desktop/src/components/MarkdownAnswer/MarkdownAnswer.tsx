import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { native } from '../../bridge';
import './MarkdownAnswer.css';

export function MarkdownAnswer({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) void native('open_link', { url: href }).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
          img: ({ alt }) => <span>[图片：{alt ?? '外部图片'}]</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
