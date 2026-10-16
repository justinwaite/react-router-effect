import { Effect } from "effect";
import { createStaticHandler } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { describe, expect, it } from "vite-plus/test";

import { makeEffectRouteFactory } from "../src/index.ts";

const { makeLoader } = makeEffectRouteFactory()(() => ({ errorHandlers: {} }));

describe("react-router with an aborted request", () => {
  it("rejects query() with the abort reason, interrupts the effect, and leaks no rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    let finalized = false;
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.never.pipe(Effect.ensuring(Effect.sync(() => void (finalized = true)))),
    );
    const handler = createStaticHandler([{ id: "root", path: "/", loader }]);

    const controller = new AbortController();
    const request = new Request("http://localhost/", { signal: controller.signal });
    const pending = handler.query(request).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    controller.abort(new Error("client went away"));

    const result = await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onUnhandled);

    expect(result.ok).toBe(false);
    expect(!result.ok && (result.error as Error).message).toBe("client went away");
    expect(finalized).toBe(true);
    expect(unhandled).toEqual([]);
  });
});
