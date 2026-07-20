"use client";

import { useState } from "react";
import Image from "next/image";
import { isGoogleDriveConfigured, pickFilesFromGoogleDrive } from "@/lib/googleDrive";
import { Button } from "./ui/Button";

function DriveIcon() {
  return <Image src="/google-drive-icon.png" alt="" width={16} height={16} aria-hidden="true" />;
}

export function GoogleDriveImportButton({
  kind,
  multiple,
  disabled,
  onFilesSelected,
}: {
  kind: "image" | "video";
  multiple: boolean;
  disabled?: boolean;
  onFilesSelected: (files: File[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isGoogleDriveConfigured()) return null;

  async function handleClick() {
    setError(null);
    setLoading(true);
    try {
      const files = await pickFilesFromGoogleDrive(kind, multiple);
      if (files.length > 0) onFilesSelected(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import from Google Drive.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <Button type="button" variant="outline" size="sm" onClick={handleClick} loading={loading} disabled={disabled}>
        <DriveIcon />
        Import from Google Drive
      </Button>
      {error && <p className="mt-1.5 text-sm text-danger">{error}</p>}
    </div>
  );
}
