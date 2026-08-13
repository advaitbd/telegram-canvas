import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("fullscreen canvas viewer", () => {
  it("preserves the strict iframe sandbox and viewer controls", () => {
    const html = readFileSync("public/index.html", "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");
    const iframe = document.querySelector<HTMLIFrameElement>("#artifact-iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(document.querySelector("#viewer-menu-toggle")).not.toBeNull();
    expect(document.querySelector("#back-to-gallery")).not.toBeNull();
  });

  it("keeps the public share controls in the fullscreen action panel", () => {
    const html = readFileSync("public/index.html", "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("#btn-share")).not.toBeNull();
    expect(document.querySelector("#public-share-list")).not.toBeNull();
  });
});
