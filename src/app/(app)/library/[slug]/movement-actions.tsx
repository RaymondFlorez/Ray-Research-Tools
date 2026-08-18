"use client";

import * as React from "react";
import { Check, Heart, ListPlus } from "lucide-react";
import type { Movement } from "@/types";
import { Button } from "@/components/ui/button";
import { Modal, Toast } from "@/components/ui/overlay";
import { Field, Input } from "@/components/ui/primitives";
import { useAppStore, useStoreHydrated } from "@/lib/store/app-store";

/** Favourite + add-to-flow actions for a single movement. */
export function MovementActions({ movement }: { movement: Movement }) {
  const hydrated = useStoreHydrated();
  const favorite = useAppStore((s) => s.favorites.includes(movement.id));
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const flows = useAppStore((s) => s.flows);
  const createFlow = useAppStore((s) => s.createFlow);
  const updateFlow = useAppStore((s) => s.updateFlow);

  const [open, setOpen] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  const addToExisting = (flowId: string) => {
    const flow = flows.find((f) => f.id === flowId);
    if (!flow) return;
    if (flow.items.some((i) => i.movementId === movement.id)) {
      setToast("Already in that flow");
      setOpen(false);
      return;
    }
    updateFlow(flowId, {
      items: [
        ...flow.items,
        { movementId: movement.id, durationSec: movement.durationSec },
      ],
    });
    setOpen(false);
    setToast(`Added to ${flow.name}`);
  };

  const createWith = () => {
    createFlow(newName.trim() || `${movement.name} flow`, [
      { movementId: movement.id, durationSec: movement.durationSec },
    ]);
    setNewName("");
    setOpen(false);
    setToast("Flow created");
  };

  return (
    <>
      <div className="space-y-2">
        <Button
          className="w-full"
          variant={favorite && hydrated ? "secondary" : "primary"}
          onClick={() => toggleFavorite(movement.id)}
        >
          <Heart size={15} fill={favorite && hydrated ? "currentColor" : "none"} />
          {favorite && hydrated ? "In your favourites" : "Add to favourites"}
        </Button>
        <Button
          className="w-full"
          variant="secondary"
          onClick={() => setOpen(true)}
        >
          <ListPlus size={15} />
          Add to a flow
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add to a flow"
        description={`Where should ${movement.name} go?`}
        size="sm"
      >
        <div className="space-y-4">
          {flows.length > 0 && (
            <ul className="space-y-1.5">
              {flows.map((flow) => {
                const already = flow.items.some(
                  (i) => i.movementId === movement.id,
                );
                return (
                  <li key={flow.id}>
                    <button
                      onClick={() => addToExisting(flow.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-[11px] border border-line bg-surface/60 px-4 py-3 text-left transition-colors hover:border-line-strong"
                    >
                      <span>
                        <span className="block text-[13px] font-medium text-ink">
                          {flow.name}
                        </span>
                        <span className="block text-[12px] text-ink-3 tabular-nums">
                          {flow.items.length} movements
                        </span>
                      </span>
                      {already && <Check size={15} className="text-positive" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="rounded-[11px] border border-dashed border-line p-4">
            <Field label="Or start a new flow">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={`${movement.name} flow`}
              />
            </Field>
            <Button className="mt-3 w-full" size="sm" onClick={createWith}>
              Create flow with this movement
            </Button>
          </div>
        </div>
      </Modal>

      <Toast message={toast} open={Boolean(toast)} />
    </>
  );
}
