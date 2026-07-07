// Verifies the self-hosted AAC in-app browser test page renders as a
// self-contained, embed-friendly HTML document with the interaction surfaces
// the mechanism tests rely on (tap, type, scroll, subpage navigation).

import { renderBrowserTestPage } from "../dev/browser-test-page";

describe("renderBrowserTestPage", () => {
  const page1 = renderBrowserTestPage({ page: 1, selfPath: "/browser-test", otherPath: "/browser-test/page2" });
  const page2 = renderBrowserTestPage({ page: 2, selfPath: "/browser-test/page2", otherPath: "/browser-test" });

  test("is a complete standalone HTML document", () => {
    expect(page1.trimStart()).toMatch(/^<!doctype html>/i);
    expect(page1).toContain("</html>");
    expect(page1).toContain("<title>AAC Browser Test — Page 1</title>");
  });

  test("is self-contained — no external assets to trip a sandboxed frame", () => {
    expect(page1).not.toMatch(/src=["']https?:/i);
    expect(page1).not.toMatch(/href=["']https?:/i);
    expect(page1).not.toMatch(/<link[^>]+stylesheet/i);
  });

  test("exposes the four interaction surfaces (tap, type, scroll, navigate)", () => {
    expect(page1).toContain('id="btn-inc"');       // tap
    expect(page1).toContain('id="typebox"');        // type
    expect(page1).toContain('id="btn-bottom"');     // scroll
    expect(page1).toContain('href="/browser-test/page2"'); // navigate to subpage
  });

  test("marks interactive controls with data-dwell for eye-gaze", () => {
    expect(page1).toContain("data-dwell");
  });

  test("page 2 links back to the permitted parent", () => {
    expect(page2).toContain("<title>AAC Browser Test — Page 2</title>");
    expect(page2).toContain('href="/browser-test"');
  });
});
