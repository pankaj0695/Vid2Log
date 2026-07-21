"use client";

import { useEffect } from "react";
import { Button } from "./Button";

/**
 * Shared confirmation modal for destructive actions (deleting a video log,
 * deleting a model, ...). Renders nothing when `open` is false so it can sit
 * at the bottom of a page unconditionally rather than every call site having
 * to gate its own mount.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-bg/80 backdrop-blur-sm" onClick={busy ? undefined : onCancel} aria-hidden="true" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative w-full max-w-sm rounded-2xl border border-neutral-200 bg-surface p-6 shadow-2xl shadow-black/40"
      >
        <h2 id="confirm-dialog-title" className="text-lg font-semibold text-text">
          {title}
        </h2>
        {description && <div className="mt-2 text-sm text-neutral-500">{description}</div>}
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
