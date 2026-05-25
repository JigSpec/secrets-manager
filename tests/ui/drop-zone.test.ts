import { describe, expect, it, vi } from "vitest";

import {
  buildDragDepthReducer,
  filterEncFiles,
} from "@/components/drop-zone";

// ---------------------------------------------------------------------------
// describe("DropZone drag depth counter logic")
// ---------------------------------------------------------------------------

describe("DropZone drag depth counter logic", () => {
  // The component maintains a depth counter so that nested dragenter/dragleave
  // events don't prematurely hide the overlay. We test the reducer/updater
  // function that encapsulates this logic.

  it("depth starts at 0", () => {
    const reducer = buildDragDepthReducer();
    expect(reducer.getDepth()).toBe(0);
  });

  it("increments on dragenter", () => {
    const reducer = buildDragDepthReducer();
    reducer.onDragEnter();
    expect(reducer.getDepth()).toBe(1);
  });

  it("decrements on dragleave", () => {
    const reducer = buildDragDepthReducer();
    reducer.onDragEnter();
    reducer.onDragLeave();
    expect(reducer.getDepth()).toBe(0);
  });

  it("overlay is shown (depth > 0) and hidden when depth === 0", () => {
    const reducer = buildDragDepthReducer();
    expect(reducer.isOverlayVisible()).toBe(false);
    reducer.onDragEnter();
    expect(reducer.isOverlayVisible()).toBe(true);
    reducer.onDragLeave();
    expect(reducer.isOverlayVisible()).toBe(false);
  });

  it("dragenter + dragleave pairs cancel out correctly for multiple nested events", () => {
    const reducer = buildDragDepthReducer();

    // Simulate: enter outer → enter inner → leave inner → leave outer
    reducer.onDragEnter(); // depth 1
    reducer.onDragEnter(); // depth 2
    expect(reducer.getDepth()).toBe(2);
    expect(reducer.isOverlayVisible()).toBe(true);

    reducer.onDragLeave(); // depth 1
    expect(reducer.isOverlayVisible()).toBe(true);

    reducer.onDragLeave(); // depth 0
    expect(reducer.getDepth()).toBe(0);
    expect(reducer.isOverlayVisible()).toBe(false);
  });

  it("onDrop resets depth to 0 regardless of depth", () => {
    const reducer = buildDragDepthReducer();
    reducer.onDragEnter();
    reducer.onDragEnter();
    reducer.onDrop();
    expect(reducer.getDepth()).toBe(0);
    expect(reducer.isOverlayVisible()).toBe(false);
  });

  it("depth cannot go below 0 via extra dragleave calls", () => {
    const reducer = buildDragDepthReducer();
    reducer.onDragLeave();
    expect(reducer.getDepth()).toBe(0);
    reducer.onDragLeave();
    expect(reducer.getDepth()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe("DropZone file filtering")
// ---------------------------------------------------------------------------

describe("DropZone file filtering", () => {
  // filterEncFiles takes a FileList-like iterable and an onFileDrop callback.
  // It reads .enc files and passes their text content + filename to the callback.
  // Non-.enc files are silently ignored.

  it("filters out non-.enc files and does not call onFileDrop", async () => {
    const onFileDrop = vi.fn();

    // Simulate two non-.enc files
    const files = [
      new File(["content1"], "readme.txt", { type: "text/plain" }),
      new File(["content2"], "image.png", { type: "image/png" }),
    ];

    await filterEncFiles(files, onFileDrop);

    expect(onFileDrop).not.toHaveBeenCalled();
  });

  it("calls onFileDrop with text content and file name for a .enc file", async () => {
    const onFileDrop = vi.fn();
    const encContent = "v1:aGVsbG8=:d29ybGQ=:dGVzdA==:dGFnaGVyZQ==";

    const files = [
      new File([encContent], "my-vault.enc", { type: "application/octet-stream" }),
    ];

    await filterEncFiles(files, onFileDrop);

    expect(onFileDrop).toHaveBeenCalledOnce();
    expect(onFileDrop).toHaveBeenCalledWith(encContent, "my-vault.enc");
  });

  it("processes only .enc files when mixed with other types", async () => {
    const onFileDrop = vi.fn();
    const encContent = "v1:aGVsbG8=:d29ybGQ=:dGVzdA==:dGFnaGVyZQ==";

    const files = [
      new File(["ignored"], "notes.txt", { type: "text/plain" }),
      new File([encContent], "vault.enc", { type: "application/octet-stream" }),
      new File(["also-ignored"], "data.json", { type: "application/json" }),
    ];

    await filterEncFiles(files, onFileDrop);

    expect(onFileDrop).toHaveBeenCalledOnce();
    expect(onFileDrop).toHaveBeenCalledWith(encContent, "vault.enc");
  });

  it("treats .ENC (uppercase) files the same as .enc", async () => {
    const onFileDrop = vi.fn();
    const content = "v1:abc:def:ghi:jkl";
    const files = [new File([content], "VAULT.ENC", { type: "application/octet-stream" })];
    await filterEncFiles(files, onFileDrop);
    expect(onFileDrop).toHaveBeenCalledOnce();
    expect(onFileDrop).toHaveBeenCalledWith(content, "VAULT.ENC");
  });

  it("handles an empty file array without calling onFileDrop", async () => {
    const onFileDrop = vi.fn();
    await filterEncFiles([], onFileDrop);
    expect(onFileDrop).not.toHaveBeenCalled();
  });

  it("processes multiple .enc files in order", async () => {
    const onFileDrop = vi.fn();
    const files = [
      new File(["content-a"], "a.enc"),
      new File(["content-b"], "b.enc"),
    ];
    await filterEncFiles(files, onFileDrop);
    expect(onFileDrop).toHaveBeenCalledTimes(2);
    expect(onFileDrop).toHaveBeenNthCalledWith(1, "content-a", "a.enc");
    expect(onFileDrop).toHaveBeenNthCalledWith(2, "content-b", "b.enc");
  });
});
