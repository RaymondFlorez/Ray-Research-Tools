import { useEffect, useMemo, useRef, useState } from 'react';
import type { PatchOp, Viewport } from '@geoglobe/scene-schema';
import { useSceneStore } from '../store/sceneStore';
import { useInspectorStore } from '../store/inspectorStore';
import { useUiStore } from '../store/uiStore';

interface Command {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

const PLACES: { name: string; viewport: Viewport }[] = [
  {
    name: 'Whole globe',
    viewport: { longitude: 0, latitude: 20, zoom: 0.8, pitch: 0, bearing: 0 },
  },
  {
    name: 'Pacific Ring of Fire',
    viewport: { longitude: 160, latitude: 10, zoom: 1.6, pitch: 0, bearing: 0 },
  },
  { name: 'Tokyo', viewport: { longitude: 139.7, latitude: 35.7, zoom: 4, pitch: 0, bearing: 0 } },
  {
    name: 'San Francisco',
    viewport: { longitude: -122.4, latitude: 37.8, zoom: 4, pitch: 0, bearing: 0 },
  },
  {
    name: 'Himalaya',
    viewport: { longitude: 86.9, latitude: 28, zoom: 3.5, pitch: 0, bearing: 0 },
  },
  {
    name: 'Iceland',
    viewport: { longitude: -19, latitude: 64.9, zoom: 3.5, pitch: 0, bearing: 0 },
  },
  { name: 'Andes', viewport: { longitude: -70, latitude: -20, zoom: 2.5, pitch: 0, bearing: 0 } },
];

/**
 * Ctrl/Cmd+K command palette. Every scene change goes through `applyPatch` — the same
 * validated channel the Layer panel and the agent use — so palette actions are
 * indistinguishable from any other edit (and show up the same way in history).
 */
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const theme = useUiStore((s) => s.theme);
  const layers = useSceneStore((s) => s.scene.layers);
  const applyPatch = useSceneStore((s) => s.applyPatch);
  const select = useSceneStore((s) => s.select);
  const setPicked = useInspectorStore((s) => s.setPicked);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUiStore.getState().paletteOpen);
      } else if (e.key === 'Escape' && useUiStore.getState().paletteOpen) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const patch = (ops: PatchOp[]) => {
      try {
        applyPatch(ops);
      } catch (err) {
        console.error('Rejected palette patch', err);
      }
    };
    return [
      ...layers.map((layer, i) => ({
        id: `toggle-${layer.id}`,
        group: 'Layers',
        label: `${layer.visible ? 'Hide' : 'Show'} ${layer.id}`,
        run: () => patch([{ op: 'replace', path: `/layers/${i}/visible`, value: !layer.visible }]),
      })),
      ...PLACES.map((p) => ({
        id: `fly-${p.name}`,
        group: 'Fly to',
        label: p.name,
        run: () => patch([{ op: 'replace', path: '/viewport', value: p.viewport }]),
      })),
      {
        id: 'time-reset',
        group: 'Scene',
        label: 'Show all time',
        run: () => patch([{ op: 'replace', path: '/time/current', value: null }]),
      },
      {
        id: 'clear-selection',
        group: 'Scene',
        label: 'Clear selection',
        run: () => {
          select(null);
          setPicked(null);
        },
      },
      {
        id: 'clear-annotations',
        group: 'Scene',
        label: 'Clear annotations',
        run: () => patch([{ op: 'replace', path: '/annotations', value: [] }]),
      },
      {
        id: 'theme',
        group: 'View',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
        run: toggleTheme,
      },
      {
        id: 'focus-chat',
        group: 'View',
        label: 'Ask the globe… (focus chat)',
        run: () => document.querySelector<HTMLInputElement>('[data-testid="chat-input"]')?.focus(),
      },
    ];
  }, [layers, applyPatch, select, setPicked, theme, toggleTheme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q));
  }, [commands, query]);

  if (!open) return null;

  const runAt = (i: number) => {
    const cmd = filtered[i];
    if (!cmd) return;
    setOpen(false);
    cmd.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        data-testid="palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
          value={query}
          data-testid="palette-input"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runAt(active);
            }
          }}
        />
        <ul className="palette-list" role="listbox">
          {filtered.length === 0 && <li className="palette-empty">No matching commands</li>}
          {filtered.map((cmd, i) => (
            <li
              key={cmd.id}
              role="option"
              aria-selected={i === active}
              className={`palette-item${i === active ? ' palette-item-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => runAt(i)}
            >
              <span className="palette-group">{cmd.group}</span>
              <span>{cmd.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
