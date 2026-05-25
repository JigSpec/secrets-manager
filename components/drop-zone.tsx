/**
 * components/drop-zone.tsx
 *
 * DropZone component and helper utilities for Issue #32.
 *
 * Provides:
 *   - buildDragDepthReducer  — factory for drag-depth tracking state machine
 *   - filterEncFiles          — reads .enc files from a drop event and invokes a callback
 *   - DropZone                — React component (default export)
 */

"use client";

import React, { useCallback, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// buildDragDepthReducer
// ---------------------------------------------------------------------------

/**
 * Creates a stateful drag-depth tracker.
 *
 * Browsers fire dragenter on every child element, paired with a dragleave, so
 * a naive boolean flag incorrectly hides the overlay when dragging over children.
 * Tracking a depth counter (increment on enter, decrement on leave) solves this.
 *
 * Usage:
 *   const reducer = buildDragDepthReducer();
 *   reducer.onDragEnter(); // depth → 1
 *   reducer.onDragEnter(); // depth → 2 (entered child)
 *   reducer.onDragLeave(); // depth → 1 (left child)
 *   reducer.onDragLeave(); // depth → 0 (left container)
 *   reducer.isOverlayVisible(); // false
 */
export function buildDragDepthReducer() {
  let depth = 0;

  return {
    /** Return the current drag depth. */
    getDepth(): number {
      return depth;
    },
    /** Increment depth on dragenter. */
    onDragEnter(): void {
      depth += 1;
    },
    /** Decrement depth on dragleave. */
    onDragLeave(): void {
      depth = Math.max(0, depth - 1);
    },
    /** Reset depth to 0 on drop. */
    onDrop(): void {
      depth = 0;
    },
    /** True when the drop overlay should be shown (depth > 0). */
    isOverlayVisible(): boolean {
      return depth > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// filterEncFiles
// ---------------------------------------------------------------------------

/**
 * Read each File that ends with `.enc` and invoke the callback with the
 * file's text content and its name. Non-.enc files are silently ignored.
 *
 * @param files      Array or FileList of File objects from a drop/input event.
 * @param onFileDrop Callback invoked for each accepted .enc file.
 */
export async function filterEncFiles(
  files: File[] | FileList,
  onFileDrop: (content: string, fileName: string) => void | Promise<void>,
): Promise<void> {
  const fileArray = Array.from(files);
  const encFiles = fileArray.filter((f) => f.name.toLowerCase().endsWith(".enc"));

  for (const file of encFiles) {
    try {
      const content = await file.text();
      await onFileDrop(content, file.name);
    } catch (err) {
      console.error(`Failed to process dropped file "${file.name}":`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// DropZone component
// ---------------------------------------------------------------------------

export type DropZoneProps = {
  /** Called when a .enc file is dropped. Receives file content and file name. */
  onFileDrop: (content: string, fileName: string) => void | Promise<void>;
  /** Child elements rendered inside the drop zone. */
  children?: React.ReactNode;
  /** Optional additional className for the outer container. */
  className?: string;
};

/**
 * DropZone wraps content with drag-and-drop support for .enc vault files.
 *
 * Displays a visual overlay while a file is being dragged over the zone.
 * When a .enc file is dropped, `onFileDrop` is called with the file content
 * and filename. Non-.enc files are silently ignored.
 */
export default function DropZone({
  onFileDrop,
  children,
  className = "",
}: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const reducerRef = useRef(buildDragDepthReducer());

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    reducerRef.current.onDragEnter();
    setIsDragging(reducerRef.current.isOverlayVisible());
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    reducerRef.current.onDragLeave();
    setIsDragging(reducerRef.current.isOverlayVisible());
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy"; // Safari falls back to native file-open without this
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      reducerRef.current.onDrop();
      setIsDragging(false);

      try {
        const files = e.dataTransfer.files;
        await filterEncFiles(files, onFileDrop);
      } catch (err) {
        console.error("Unexpected error handling dropped files:", err);
      }
    },
    [onFileDrop],
  );

  return (
    <div
      className={`relative ${className}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {isDragging && (
        <div
          className={
            "absolute inset-0 z-50 flex items-center justify-center " +
            "rounded-lg border-2 border-dashed border-primary bg-primary/10"
          }
        >
          <p className="text-lg font-semibold text-primary">
            Drop .enc vault file here
          </p>
        </div>
      )}
    </div>
  );
}
