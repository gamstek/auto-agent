import { MessageSquare, Minimize2, Settings2 } from 'lucide-react';
import { IconButton } from '../IconButton/IconButton';
import { InstrumentIcon } from '../InstrumentIcon/InstrumentIcon';
import './NavigationRail.css';

type Page = 'chat' | 'instruments' | 'settings';

export function NavigationRail({
  page,
  onNavigate,
  onHide,
  instrumentsAvailable,
}: {
  page: Page;
  onNavigate: (page: Page, animate: boolean) => void;
  onHide: () => void;
  instrumentsAvailable: boolean;
}) {
  return (
    <nav className="navigation-rail" aria-label="主导航">
      <div className="navigation-rail-primary">
        <IconButton
          variant="rail"
          selected={page === 'chat'}
          label="聊天主页"
          title="聊天"
          onClick={(event) => onNavigate('chat', event.detail > 0)}
        >
          <MessageSquare size={20} />
        </IconButton>
        <IconButton
          variant="rail"
          selected={page === 'instruments'}
          label="仪器"
          disabled={!instrumentsAvailable}
          title={instrumentsAvailable ? '仪器' : '当前版本尚未接入仪器页'}
          onClick={(event) => onNavigate('instruments', event.detail > 0)}
        >
          <InstrumentIcon />
        </IconButton>
      </div>
      <div className="navigation-rail-utilities">
        <IconButton variant="rail" label="收起至悬浮助手" title="悬浮助手" onClick={onHide}>
          <Minimize2 size={19} />
        </IconButton>
        <IconButton
          variant="rail"
          selected={page === 'settings'}
          label="设置"
          onClick={(event) => onNavigate('settings', event.detail > 0)}
        >
          <Settings2 size={20} />
        </IconButton>
      </div>
    </nav>
  );
}
