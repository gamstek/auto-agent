import { useState } from 'react';
import { X } from 'lucide-react';
import avatar from '../../assets/assistant-avatar.png';
import { native } from '../../bridge';
import { IconButton } from '../IconButton/IconButton';
import './Launcher.css';

export function Launcher() {
  const [compact, setCompact] = useState(false);
  return (
    <div
      className={`launcher ${compact ? 'compact' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault();
        void native('launcher_menu');
      }}
    >
      <button
        className="launcher-drag"
        title="拖动悬浮助手"
        aria-label="拖动悬浮助手"
        onPointerDown={(event) => {
          if (event.button === 0) void native('drag_launcher');
        }}
      >
        ···
      </button>
      {!compact && (
        <IconButton
          className="launcher-collapse"
          title="收起悬浮助手"
          label="收起悬浮助手"
          onClick={() => {
            setCompact(true);
            void native('launcher_compact', { compact: true });
          }}
        >
          <X size={12} />
        </IconButton>
      )}
      <button
        className="launcher-open"
        title="打开 AI 助理"
        aria-label="打开 AI 助理"
        onClick={() => void native('show_main')}
      >
        <img src={avatar} alt="量仔" />
        <strong>{compact ? 'Ai' : 'Ai 助手'}</strong>
      </button>
    </div>
  );
}
