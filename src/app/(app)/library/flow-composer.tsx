"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowUp, ListMusic, Trash2, X } from "lucide-react";
import type { Movement } from "@/types";
import { Button, IconButton } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { Modal, Toast } from "@/components/ui/overlay";
import { MovementRow } from "@/components/movement/movement-card";
import { useAppStore } from "@/lib/store/app-store";
import { formatDuration } from "@/lib/utils";

/**
 * Flow composer — a docked tray that collects movements as you browse, then
 * saves them as a named personal sequence. Reordering is explicit (up/down)
 * rather than drag-based here: the tray is narrow and often used one-handed.
 */
export function FlowComposer({
  draft,
  onRemove,
  onReorder,
  onClear,
}: {
  draft: Movement[];
  onRemove: (movementId: string) => void;
  onReorder: (next: Movement[]) => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const createFlow = useAppStore((s) => s.createFlow);

  // The tray opens expanded when it appears; collapsing is a viewer choice.
  const [collapsed, setCollapsed] = React.useState(false);
  const open = !collapsed;

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const totalSec = draft.reduce((sum, m) => sum + m.durationSec, 0);

  const move = (index: number, delta: number) => {
    const next = [...draft];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next);
  };

  const save = () => {
    if (!draft.length) return;
    createFlow(
      name.trim() || `Flow — ${draft.length} movements`,
      draft.map((m) => ({ movementId: m.id, durationSec: m.durationSec })),
      description.trim() || undefined,
    );
    setSaveOpen(false);
    setName("");
    setDescription("");
    onClear();
    setToast("Flow saved to your library");
    router.refresh();
  };

  return (
    <>
      <AnimatePresence>
        {draft.length > 0 && (
          <motion.div
            initial={{ y: 90, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 90, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className="fixed inset-x-3 bottom-20 z-50 mx-auto max-w-lg lg:right-8 lg:bottom-8 lg:left-auto lg:mx-0"
          >
            <div className="surface-elevated overflow-hidden">
              <button
                onClick={() => setCollapsed((v) => !v)}
                aria-expanded={open}
                className="flex w-full items-center gap-3 px-4 py-3 text-left"
              >
                <ListMusic size={16} className="text-accent" />
                <span className="flex-1">
                  <span className="block text-[13px] font-medium text-ink">
                    Flow in progress
                  </span>
                  <span className="block text-[12px] text-ink-3 tabular-nums">
                    {draft.length} movements ·{" "}
                    {formatDuration(Math.round(totalSec / 60))}
                  </span>
                </span>
                <span className="text-[12px] text-ink-3">
                  {open ? "Hide" : "Show"}
                </span>
              </button>

              {open && (
                <div className="max-h-64 space-y-1.5 overflow-y-auto border-t border-line px-3 py-3">
                  {draft.map((movement, index) => (
                    <MovementRow
                      key={movement.id}
                      movement={movement}
                      right={
                        <span className="flex items-center gap-1">
                          <button
                            onClick={() => move(index, -1)}
                            disabled={index === 0}
                            aria-label={`Move ${movement.name} earlier`}
                            className="grid h-6 w-6 place-items-center rounded-md text-ink-3 hover:text-ink disabled:opacity-25"
                          >
                            <ArrowUp size={13} />
                          </button>
                          <button
                            onClick={() => move(index, 1)}
                            disabled={index === draft.length - 1}
                            aria-label={`Move ${movement.name} later`}
                            className="grid h-6 w-6 place-items-center rounded-md text-ink-3 hover:text-ink disabled:opacity-25"
                          >
                            <ArrowDown size={13} />
                          </button>
                          <button
                            onClick={() => onRemove(movement.id)}
                            aria-label={`Remove ${movement.name}`}
                            className="grid h-6 w-6 place-items-center rounded-md text-ink-3 hover:text-danger"
                          >
                            <X size={13} />
                          </button>
                        </span>
                      }
                    />
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2 border-t border-line px-3 py-3">
                <Button size="sm" className="flex-1" onClick={() => setSaveOpen(true)}>
                  Save flow
                </Button>
                <IconButton label="Discard flow" onClick={onClear}>
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save this flow"
        description="Named sequences appear in your flows and can be dropped straight into a session."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save}>Save flow</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Morning joint prep"
              autoFocus
            />
          </Field>
          <Field
            label="Notes"
            hint="Optional — what this sequence is for, or when to use it."
          >
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Before any lower-body session. Barefoot."
            />
          </Field>
          <div className="rounded-[11px] border border-line bg-void/50 px-4 py-3">
            <p className="text-[12px] text-ink-3 tabular-nums">
              {draft.length} movements ·{" "}
              {formatDuration(Math.round(totalSec / 60))} total
            </p>
          </div>
        </div>
      </Modal>

      <Toast message={toast} open={Boolean(toast)} />
    </>
  );
}
