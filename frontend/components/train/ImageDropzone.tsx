"use client";

import { useEffect, useMemo, useRef } from "react";
import { GoogleDriveImportButton } from "@/components/GoogleDriveImportButton";

/** File picker + thumbnail grid for one class's training images. Recommends
 * 20–25 images (per the training methodology) without hard-blocking fewer —
 * some classes are just easier to distinguish than others. */
export function ImageDropzone({
  files,
  onChange,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Derived from `files`, not independent state — useMemo avoids the extra
  // render a useEffect+setState round-trip would cost here.
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);

  useEffect(() => {
    return () => previews.forEach((u) => URL.revokeObjectURL(u));
  }, [previews]);

  function addFiles(newFiles: FileList | null) {
    if (!newFiles) return;
    const images = Array.from(newFiles).filter((f) => f.type.startsWith("image/"));
    onChange([...files, ...images]);
  }

  function removeAt(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  const countTone = files.length >= 20 ? "text-success" : files.length > 0 ? "text-warning" : "text-neutral-400";

  return (
    <div>
      <div
        className="cursor-pointer rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center hover:bg-neutral-100"
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!disabled) addFiles(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
      >
        <p className="text-sm font-medium text-text">Click or drop images here</p>
        <p className={`mt-1 text-sm ${countTone}`}>{files.length} image{files.length === 1 ? "" : "s"} added · recommended 20–25</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          disabled={disabled}
          className="sr-only"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="mt-2 flex justify-end">
        <GoogleDriveImportButton
          kind="image"
          multiple
          disabled={disabled}
          onFilesSelected={(driveFiles) => onChange([...files, ...driveFiles])}
        />
      </div>

      {previews.length > 0 && (
        <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6">
          {previews.map((src, i) => (
            <div key={src} className="group relative aspect-square overflow-hidden rounded-lg border border-neutral-200">
              {/* Local blob: object URLs — next/image can't optimize these, plain <img> is correct here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Example ${i + 1}`} className="h-full w-full object-cover" />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-sm text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Remove image ${i + 1}`}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
