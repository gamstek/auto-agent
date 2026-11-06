import { useState } from 'react';
import { Check, Copy, Heart, ThumbsDown } from 'lucide-react';
import { IconButton } from '../IconButton/IconButton';
import './ResponseActions.css';

export function ResponseActions({ message }: { message: { id: string; content: string } }) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState(
    () => localStorage.getItem(`feedback:${message.id}`) ?? '',
  );
  function vote(value: string) {
    const next = feedback === value ? '' : value;
    setFeedback(next);
    if (next) localStorage.setItem(`feedback:${message.id}`, next);
    else localStorage.removeItem(`feedback:${message.id}`);
  }
  return (
    <div className="response-actions">
      <IconButton
        label="复制回复"
        title="复制回复"
        onClick={() => {
          void navigator.clipboard.writeText(message.content).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={17} /> : <Copy size={17} />}
      </IconButton>
      <IconButton
        label="标记喜欢（仅本机）"
        title="标记喜欢（仅本机）"
        selected={feedback === 'like'}
        onClick={() => vote('like')}
      >
        <Heart size={18} fill={feedback === 'like' ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton
        label="标记不喜欢（仅本机）"
        title="标记不喜欢（仅本机）"
        selected={feedback === 'dislike'}
        onClick={() => vote('dislike')}
      >
        <ThumbsDown size={18} />
      </IconButton>
    </div>
  );
}
