import { Data, Effect } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";
import type { LoaderFunctionArgs } from "react-router";
import { describe, expect, it } from "vite-plus/test";

import { makeLoaderOrActionFactory, Respond } from "../src/index.ts";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}
class BadInputError extends Data.TaggedError("BadInputError")<{ readonly message: string }> {}
class RecoverableError extends Data.TaggedError("RecoverableError")<{
  readonly fallback: number;
}> {}
class GoAwayError extends Data.TaggedError("GoAwayError")<{}> {}
class RedirectingError extends Data.TaggedError("RedirectingError")<{ readonly to: string }> {}

/** A declared domain error with no registered handler — falls through to the 500 default. */
class UnhandledDomainError extends Data.TaggedError("UnhandledDomainError")<{}> {}

/** A domain error that handles itself via `HttpServerRespondable` — no handler needed. */
class NotAuthorizedError extends Data.TaggedError("NotAuthorizedError")<{}> {
  [HttpServerRespondable.symbol](): Effect.Effect<HttpServerResponse.HttpServerResponse> {
    return HttpServerResponse.json({ error: "Not authorized" }, { status: 403 }).pipe(Effect.orDie);
  }
}

type DomainErrors =
  | FormError
  | BadInputError
  | RecoverableError
  | GoAwayError
  | RedirectingError
  | NotAuthorizedError
  | UnhandledDomainError;

const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
  errorHandlers: {
    // throw → error boundary, via a raw `Response`
    BadInputError: (error: BadInputError) =>
      Effect.fail(new Response(error.message, { status: 400 })),
    // recover → returnable library error
    FormError: (error: FormError) => Respond.early({ reply: error.reply }),
    // recover → Effect.succeed
    RecoverableError: (error: RecoverableError) => Effect.succeed({ recovered: error.fallback }),
    // throw → returnable library error
    GoAwayError: (_error: GoAwayError) => Respond.throw({ message: "go away" }, 418),
    // throw → redirect library error
    RedirectingError: (error: RedirectingError) => Respond.redirect(error.to, 302),
    // a registered handler still wins for a respondable error
    NotAuthorizedError: (_error: NotAuthorizedError) => Respond.early({ handledExplicitly: true }),
  },
});

const args = {} as LoaderFunctionArgs;

/** Run a route handler and report whether it resolved or rejected, with the value. */
async function settle<T>(promise: Promise<T>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    return { ok: false as const, error };
  }
}

const isData = (v: unknown): v is { type: string; data: unknown; init?: number | ResponseInit } =>
  typeof v === "object" && v !== null && (v as { type?: string }).type === "DataWithResponseInit";

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("makeLoader — success & direct route errors", () => {
  it("resolves with the effect's success value", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) => Effect.succeed(42));
    await expect(loader(args)).resolves.toBe(42);
  });

  it("recovers a directly-raised Respond.early with data(...)", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.early({ message: "missing foo" });
        return true;
      }),
    );
    const result = await settle(loader(args));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatchObject({
      type: "DataWithResponseInit",
      data: { message: "missing foo" },
    });
  });

  it("threads init through Respond.early", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.early({ ok: false }, 200);
        return true;
      }),
    );
    const value = await loader(args);
    expect(isData(value) && value.init).toEqual({ status: 200 });
  });

  it("throws a directly-raised Respond.throw as a DataWithResponseInit", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.throw({ boom: true }, 500);
        return true;
      }),
    );
    const result = await settle(loader(args));
    expect(result.ok).toBe(false);
    expect(isData(result.ok ? undefined : result.error)).toBe(true);
  });

  it("throws a directly-raised Respond.redirect as a redirect Response", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.redirect("/login", 302);
        return true;
      }),
    );
    const result = await settle(loader(args));
    expect(result.ok).toBe(false);
    const res = result.ok ? undefined : result.error;
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("location")).toBe("/login");
  });
});

describe("makeLoader — registered handlers", () => {
  it("throws when a handler returns Effect.fail(Response)", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new BadInputError({ message: "nope" });
        return true;
      }),
    );
    const result = await settle(loader(args));
    expect(result.ok).toBe(false);
    const res = result.ok ? undefined : result.error;
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
    await expect((res as Response).text()).resolves.toBe("nope");
  });

  it("recovers when a handler returns Respond.early", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FormError({ reply: "invalid" });
        return true;
      }),
    );
    const value = await loader(args);
    expect(value).toMatchObject({
      type: "DataWithResponseInit",
      data: { reply: "invalid" },
    });
  });

  it("recovers with the value when a handler returns Effect.succeed", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new RecoverableError({ fallback: 7 });
        return true;
      }),
    );
    await expect(loader(args)).resolves.toEqual({ recovered: 7 });
  });

  it("throws when a handler returns Respond.throw", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new GoAwayError();
        return true;
      }),
    );
    const result = await settle(loader(args));
    expect(result.ok).toBe(false);
    const err = result.ok ? undefined : result.error;
    expect(isData(err)).toBe(true);
    expect(isData(err) && err.data).toEqual({ message: "go away" });
    expect(isData(err) && err.init).toEqual({ status: 418 });
  });

  it("throws a redirect when a handler returns Respond.redirect", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new RedirectingError({ to: "/elsewhere" });
        return true;
      }),
    );
    const result = await settle(loader(args));
    const res = result.ok ? undefined : result.error;
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("location")).toBe("/elsewhere");
  });
});

describe("makeLoader — unhandled & respondable errors", () => {
  it("falls through to a 500 for a declared domain error with no handler", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new UnhandledDomainError();
        return true;
      }),
    );
    const result = await settle(loader(args));
    expect(result.ok).toBe(false);
    const res = result.ok ? undefined : result.error;
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(500);
  });

  it("auto-renders an unregistered error that implements HttpServerRespondable", async () => {
    const ownFactory = makeLoaderOrActionFactory()({ errorHandlers: {} });
    const loader = ownFactory.makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new NotAuthorizedError();
        return true;
      }),
    );
    const result = await settle(loader(args));
    expect(result.ok).toBe(false);
    const res = result.ok ? undefined : result.error;
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
    await expect((res as Response).json()).resolves.toEqual({ error: "Not authorized" });
  });

  it("prefers a registered handler over a respondable error's own response", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new NotAuthorizedError();
        return true;
      }),
    );
    // This factory registered a handler for NotAuthorizedError, so it recovers
    // rather than rendering the 403.
    await expect(loader(args)).resolves.toMatchObject({
      type: "DataWithResponseInit",
      data: { handledExplicitly: true },
    });
  });
});

describe("makeAction", () => {
  it("is the same wrapper as makeLoader", async () => {
    const action = makeAction((_a: LoaderFunctionArgs) => Effect.succeed("created"));
    await expect(action(args)).resolves.toBe("created");
  });

  it("recovers an action handler's Respond.early", async () => {
    const action = makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FormError({ reply: "bad form" });
        return true;
      }),
    );
    await expect(action(args)).resolves.toMatchObject({
      type: "DataWithResponseInit",
      data: { reply: "bad form" },
    });
  });
});
