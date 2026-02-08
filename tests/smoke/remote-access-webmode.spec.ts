import { expect, test } from "@playwright/test";

test.describe("Remote access web-mode smoke", () => {
  test("serves index and mounts root shell", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.locator("#root")).toHaveCount(1);
  });

  test("projects endpoint returns success", async ({ request }) => {
    const response = await request.get("/api/projects");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { success?: boolean; data?: unknown };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("provider session execute endpoint reports web-mode limitation", async ({ request }) => {
    const response = await request.get("/api/provider-sessions/execute");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("not available in web mode");
  });

  test("provider-session websocket accepts connection and emits structured error for invalid payload", async ({
    page,
  }) => {
    await page.goto("/");
    const payload = await page.evaluate(async () => {
      return await new Promise<{ type?: string; message?: string }>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error("Timed out waiting for websocket message"));
        }, 5000);

        const socket = new WebSocket("ws://127.0.0.1:8090/ws/provider-session");
        socket.onopen = () => {
          socket.send("{}");
        };

        socket.onmessage = (event) => {
          window.clearTimeout(timeout);
          try {
            const parsed = JSON.parse(String(event.data)) as { type?: string; message?: string };
            socket.close();
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        };

        socket.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error("WebSocket error event"));
        };
      });
    });

    expect(payload.type).toBe("error");
    expect(payload.message).toContain("Failed to parse request");
  });
});
