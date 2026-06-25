/**
 * End-to-end browser integration tests. Each test builds a loader/action with
 * `makeLoader` / `makeAction`, mounts it in a real React Router runtime, and
 * asserts the rendered outcome — proving the whole recover / throw / redirect /
 * auto-respond / 500 lifecycle works through the framework, not just in types.
 */
import { Data, Effect } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";
import {
  Form,
  isRouteErrorResponse,
  useActionData,
  useLoaderData,
  useRouteError,
  type LoaderFunctionArgs,
} from "react-router";
import { page, userEvent } from "@vitest/browser/context";
import { describe, expect, it } from "vitest";

import { makeLoaderOrActionFactory, Respond } from "../src/index.ts";
import { renderRoute } from "./app/render-route.tsx";

// ---------------------------------------------------------------------------
// A consumer-style setup: domain errors + a configured factory.
// ---------------------------------------------------------------------------

class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}
class BadInputError extends Data.TaggedError("BadInputError")<{ readonly message: string }> {}
/** A declared domain error with no handler — falls through to the 500 default. */
class UnhandledDomainError extends Data.TaggedError("UnhandledDomainError")<{}> {}

/** Self-rendering domain error — handled via `HttpServerRespondable`, no handler. */
class NotAuthorizedError extends Data.TaggedError("NotAuthorizedError")<{}> {
  [HttpServerRespondable.symbol](): Effect.Effect<HttpServerResponse.HttpServerResponse> {
    return HttpServerResponse.json({ error: "Not authorized" }, { status: 403 }).pipe(Effect.orDie);
  }
}

type DomainErrors = FormError | BadInputError | UnhandledDomainError;

const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
  errorHandlers: {
    // recover → returns to the component
    FormError: (error: FormError) => Respond.early({ reply: error.reply }),
    // throw → error boundary
    BadInputError: (error: BadInputError) =>
      Effect.fail(new Response(error.message, { status: 400 })),
  },
});

// ---------------------------------------------------------------------------
// Shared route building blocks.
// ---------------------------------------------------------------------------

function ShowLoaderData() {
  const data = useLoaderData();
  return <pre data-testid="loader-data">{JSON.stringify(data)}</pre>;
}

function Boundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) {
    return (
      <div>
        <p data-testid="status">{error.status}</p>
        <pre data-testid="error-data">{JSON.stringify(error.data)}</pre>
      </div>
    );
  }
  return <p data-testid="unknown-error">{String(error)}</p>;
}

const Destination = () => <p data-testid="destination">arrived</p>;

// ---------------------------------------------------------------------------
// Loader lifecycle.
// ---------------------------------------------------------------------------

describe("makeLoader — through a real router", () => {
  it("renders the success value via useLoaderData", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) => Effect.succeed({ hello: "world" }));
    await renderRoute({ Component: ShowLoaderData, loader });

    await expect.element(page.getByTestId("loader-data")).toHaveTextContent('{"hello":"world"}');
  });

  it("recovers a directly-raised Respond.early into loaderData", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.early({ recovered: true });
        return { unreached: true };
      }),
    );
    await renderRoute({ Component: ShowLoaderData, loader });

    await expect.element(page.getByTestId("loader-data")).toHaveTextContent('{"recovered":true}');
  });

  it("sends a directly-raised Respond.throw to the error boundary", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.throw({ denied: true }, 403);
        return { unreached: true };
      }),
    );
    await renderRoute({ Component: ShowLoaderData, ErrorBoundary: Boundary, loader });

    await expect.element(page.getByTestId("status")).toHaveTextContent("403");
    await expect.element(page.getByTestId("error-data")).toHaveTextContent('{"denied":true}');
  });

  it("follows a directly-raised Respond.redirect", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.redirect("/dest");
        return { unreached: true };
      }),
    );
    await renderRoute({ Component: ShowLoaderData, loader }, [
      { path: "/dest", Component: Destination },
    ]);

    await expect.element(page.getByTestId("destination")).toBeVisible();
  });

  it("recovers a registered handler's Respond.early into loaderData", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FormError({ reply: "from handler" });
        return { unreached: true };
      }),
    );
    await renderRoute({ Component: ShowLoaderData, loader });

    await expect
      .element(page.getByTestId("loader-data"))
      .toHaveTextContent('{"reply":"from handler"}');
  });

  it("throws a registered handler's Effect.fail(Response) to the boundary", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new BadInputError({ message: "bad input" });
        return { unreached: true };
      }),
    );
    await renderRoute({ Component: ShowLoaderData, ErrorBoundary: Boundary, loader });

    await expect.element(page.getByTestId("status")).toHaveTextContent("400");
    await expect.element(page.getByTestId("error-data")).toHaveTextContent("bad input");
  });

  it("auto-renders an unregistered HttpServerRespondable error", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new NotAuthorizedError();
        return { unreached: true };
      }),
    );
    await renderRoute({ Component: ShowLoaderData, ErrorBoundary: Boundary, loader });

    await expect.element(page.getByTestId("status")).toHaveTextContent("403");
    await expect
      .element(page.getByTestId("error-data"))
      .toHaveTextContent('{"error":"Not authorized"}');
  });

  it("falls through to a 500 for a declared domain error with no handler", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new UnhandledDomainError();
        return { unreached: true };
      }),
    );
    await renderRoute({ Component: ShowLoaderData, ErrorBoundary: Boundary, loader });

    await expect.element(page.getByTestId("status")).toHaveTextContent("500");
  });
});

// ---------------------------------------------------------------------------
// Action lifecycle.
// ---------------------------------------------------------------------------

function FormRoute() {
  const data = useActionData() as { reply: string } | undefined;
  return (
    <Form method="post">
      <button type="submit">Submit</button>
      {data ? <pre data-testid="action-data">{JSON.stringify(data)}</pre> : null}
    </Form>
  );
}

describe("makeAction — through a real router", () => {
  it("recovers a handler's Respond.early into actionData after submit", async () => {
    const action = makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FormError({ reply: "server says hi" });
        return { unreached: true };
      }),
    );
    await renderRoute({ Component: FormRoute, action });

    await userEvent.click(page.getByRole("button", { name: "Submit" }));

    await expect
      .element(page.getByTestId("action-data"))
      .toHaveTextContent('{"reply":"server says hi"}');
  });

  it("sends a thrown action error to the boundary", async () => {
    const action = makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new BadInputError({ message: "invalid form" });
        return { unreached: true };
      }),
    );
    await renderRoute({ Component: FormRoute, ErrorBoundary: Boundary, action });

    await userEvent.click(page.getByRole("button", { name: "Submit" }));

    await expect.element(page.getByTestId("status")).toHaveTextContent("400");
    await expect.element(page.getByTestId("error-data")).toHaveTextContent("invalid form");
  });
});
