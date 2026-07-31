"use client";

import { useEffect } from "react";

/** Full-screen zoomed preview over a set of images — click any thumbnail to
 * open, then ‹ › (or arrow keys) to step through the rest of that same
 * action without closing back out to the grid. Click the backdrop / × /
 * Escape to close. Renders nothing when `images` is empty, so it can sit at
 * the bottom of a page unconditionally, same pattern as ConfirmDialog. */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
  alt = "",
}: {
  images: string[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  alt?: string;
}) {
  const total = images.length;
  const src = total > 0 ? (images[index] ?? null) : null;
  const hasPrev = index > 0;
  const hasNext = index < total - 1;

  useEffect(() => {
    if (!src) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && hasPrev) onIndexChange(index - 1);
      if (e.key === "ArrowRight" && hasNext) onIndexChange(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, index, hasPrev, hasNext, onClose, onIndexChange]);

  if (!src) return null;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-xl text-white transition-colors hover:bg-black/70"
      >
        ×
      </button>

      {hasPrev && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onIndexChange(index - 1);
          }}
          aria-label="Previous image"
          className="absolute left-4 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-2xl text-white transition-colors hover:bg-black/70"
        >
          ‹
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onIndexChange(index + 1);
          }}
          aria-label="Next image"
          className="absolute right-4 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-2xl text-white transition-colors hover:bg-black/70"
        >
          ›
        </button>
      )}

      {/* Zoomed dataset/preview image — a blob: object URL fetched through
          the authed API, next/image can't optimize these anyway. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
      />

      {total > 1 && (
        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs font-medium text-white">
          {index + 1} / {total}
        </div>
      )}
    </div>
  );
}
