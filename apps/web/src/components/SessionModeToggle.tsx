import { useEffect, useRef, useState } from 'react';
import type { ChatSessionMode } from '@open-design/contracts';
import { Icon } from './Icon';

interface Props {
  mode: ChatSessionMode;
  onChange?: (mode: ChatSessionMode) => void;
  disabled?: boolean;
}

const MODE_META: Array<{
  mode: ChatSessionMode;
  label: string;
  icon: 'comment' | 'sparkles';
  title: string;
}> = [
  {
    mode: 'chat',
    label: 'Chat',
    icon: 'comment',
    title:
      'Chat mode: fast multi-turn answers with the same files, connectors, MCP servers, and attachments.',
  },
  {
    mode: 'design',
    label: 'Design Agent',
    icon: 'sparkles',
    title:
      'Design mode: agent mode for generating HTML, PPT, slides, images, video, audio, and project files.',
  },
];

export function SessionModeToggle({ mode, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const active = MODE_META.find((item) => item.mode === mode) ?? MODE_META[1]!;
  const disabledState = disabled || !onChange;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="session-mode-toggle" ref={rootRef}>
      <button
        type="button"
        className={`session-mode-toggle__trigger${open ? ' is-open' : ''}`}
        disabled={disabledState}
        title={active.title}
        aria-label={active.title}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="session-mode-trigger"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={active.icon} size={13} />
        <span className="session-mode-toggle__label">{active.label}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open ? (
        <div className="session-mode-toggle__menu" role="menu">
          {MODE_META.map((item) => {
            const itemActive = item.mode === mode;
            return (
              <button
                key={item.mode}
                type="button"
                role="menuitemradio"
                aria-checked={itemActive}
                className={`session-mode-toggle__option${itemActive ? ' is-active' : ''}`}
                title={item.title}
                aria-label={item.title}
                onClick={() => {
                  if (!itemActive) onChange?.(item.mode);
                  setOpen(false);
                }}
              >
                <Icon name={item.icon} size={13} />
                <span className="session-mode-toggle__label">{item.label}</span>
                <span className="session-mode-toggle__check" aria-hidden>
                  {itemActive ? <Icon name="check" size={13} /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
