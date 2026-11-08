/**
 * Browser tests of `defer` through React Router's runtime: the loader data
 * renders before the deferred work finishes, `<Await>` renders the result,
 * and `errorElement` gets a rejection that holds no server details.
 *
 * `createRoutesStub` runs loaders in the browser, so these tests read the
 * promise that the factory's `defer` gives directly, without React Router's server stream.
 *
 * A client-side navigation does not interrupt deferred work: React Router
 * aborts a navigation's request only while its loaders run. The unit tests
 * cover the abort of the request itself.
 */
import { Data, Deferred, Effect } from "effect";
import { Suspense } from "react";
import {
  Await,
  isRouteErrorResponse,
  useAsyncError,
  useLoaderData,
  type LoaderFunctionArgs,
} from "react-router";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";

import { deferredFailureMessage, makeEffectRouteFactory } from "../src/index.ts";
import { renderRoute } from "./app/render-route.tsx";

class ReviewsDown extends Data.TaggedError("ReviewsDown")<{}> {}
class Forbidden extends Data.TaggedError("Forbidden")<{}> {}

const { makeLoader, defer } = makeEffectRouteFactory<ReviewsDown | Forbidden>()((Respond) => ({
  errorHandlers: {
    ReviewsDown: () => Respond.early("reviews are unavailable"),
    Forbidden: () => Respond.throw({ reason: "not yours" }, 403),
  },
}));

/** What `errorElement` shows: the rejection's message and whether it has a stack. */
function DeferredError() {
  const error = useAsyncError();
  return (
    <p data-testid="deferred-error">
      {isRouteErrorResponse(error)
        ? `${error.status} | ${JSON.stringify(error.data)}`
        : error instanceof Error
          ? `${error.message} | stack: ${String(error.stack)}`
          : "not an Error"}
    </p>
  );
}

/** Renders loader data that holds a `now` value and a deferred `later` value. */
function DeferredRoute() {
  const data = useLoaderData() as { now: string; later: Promise<string> };
  return (
    <div>
      <p data-testid="now">{data.now}</p>
      <Suspense fallback={<p data-testid="pending">pending</p>}>
        <Await resolve={data.later} errorElement={<DeferredError />}>
          {(later: string) => <p data-testid="later">{later}</p>}
        </Await>
      </Suspense>
    </div>
  );
}

describe("defer — through a real router", () => {
  it("renders the loader data first, then the deferred value in <Await>", async () => {
    const latch = Deferred.makeUnsafe<void>();
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        return {
          now: "now",
          later: yield* Deferred.await(latch).pipe(Effect.as("later"), defer),
        };
      }),
    );
    await renderRoute({ Component: DeferredRoute, loader });

    await expect.element(page.getByTestId("now")).toHaveTextContent("now");
    await expect.element(page.getByTestId("pending")).toBeVisible();

    Effect.runSync(Deferred.succeed(latch, undefined));
    await expect.element(page.getByTestId("later")).toHaveTextContent("later");
  });

  it("renders errorElement with no server details when the deferred work dies", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        return {
          now: "now",
          later: yield* defer(Effect.die(new Error("db password is hunter2"))),
        };
      }),
    );
    await renderRoute({ Component: DeferredRoute, loader });

    await expect.element(page.getByTestId("now")).toHaveTextContent("now");
    await expect
      .element(page.getByTestId("deferred-error"))
      .toHaveTextContent(`${deferredFailureMessage} | stack: undefined`);
  });

  it("renders what a handler recovers in <Await>", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        return { now: "now", later: yield* defer(new ReviewsDown()) };
      }),
    );
    await renderRoute({ Component: DeferredRoute, loader });

    await expect.element(page.getByTestId("later")).toHaveTextContent("reviews are unavailable");
  });

  it("gives errorElement the ErrorResponse of a handler's Respond.throw", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        return { now: "now", later: yield* defer(new Forbidden()) };
      }),
    );
    await renderRoute({ Component: DeferredRoute, loader });

    await expect
      .element(page.getByTestId("deferred-error"))
      .toHaveTextContent('403 | {"reason":"not yours"}');
  });
});
