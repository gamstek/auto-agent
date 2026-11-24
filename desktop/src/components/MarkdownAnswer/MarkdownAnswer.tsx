import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { native } from '../../bridge';
import { localFileName, localFilePath, markdownFilePath } from '../../lib/local-files';
import { LocalFileLink } from '../LocalFileLink/LocalFileLink';
import './MarkdownAnswer.css';

export function MarkdownAnswer({
  text,
  localFiles = false,
}: {
  text: string;
  localFiles?: boolean;
}) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) =>
          localFiles && key === 'href' && markdownFilePath(url) ? url : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children }) => {
            const path = localFiles && href ? markdownFilePath(href) : undefined;
            if (path)
              return (
                <LocalFileLink
                  file={{
                    path,
                    label:
                      typeof children === 'string' && !localFilePath(children)
                        ? children
                        : localFileName(path),
                  }}
                />
              );
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  if (href) void native('open_link', { url: href }).catch(() => {});
                }}
              >
                {children}
              </a>
            );
          },
          img: ({ alt }) => <span>[图片：{alt ?? '外部图片'}]</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
