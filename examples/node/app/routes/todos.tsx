import { Effect } from "effect";
import { createCookie, data, Form, useFetcher } from "react-router";
import type { EffectRouteArgs } from "react-router-effect";

import type { Route } from "./+types/todos";

import { Respond } from "../lib/route-factory.server";
import { textField } from "../lib/form";
import { Todos } from "../lib/services.server";

/** Remembers the last todo added, a second cookie next to the visitor's. */
const lastAdded = createCookie("last-added", { path: "/todos", sameSite: "lax" });

export const loader = Effect.fn("loader.todos")(function* ({
  request,
}: EffectRouteArgs<Route.LoaderArgs>) {
  const last: unknown = yield* Effect.promise(() => lastAdded.parse(request.headers.get("cookie")));
  return { todos: yield* (yield* Todos).list, lastAdded: typeof last === "string" ? last : null };
});

/**
 * An Effect action. `InvalidTodo` is not handled here: the route factory turns
 * it into `{ error }` data with a 422. `DuplicateTodo` is handled here, with a
 * 409. Clearing the list redirects through `Respond.redirect`.
 *
 * `EffectRouteArgs` keeps `useFetcher<typeof action>()` typed: the fetcher's
 * data includes what the factory recovers and the action metadata.
 */
export const action = Effect.fn("action.todos")(function* ({
  request,
}: EffectRouteArgs<Route.ActionArgs>) {
  const form = yield* Effect.promise(() => request.formData());
  const todos = yield* Todos;
  if (form.get("intent") === "clear") {
    yield* todos.clear;
    return yield* Respond.redirect("/todos", 303);
  }
  const todo = yield* todos
    .add(textField(form, "title"))
    .pipe(
      Effect.catchTag("DuplicateTodo", (error) =>
        Respond.early({ error: `"${error.title}" is already on the list` }, 409),
      ),
    );
  const cookie = yield* Effect.promise(() => lastAdded.serialize(todo.title));
  return data({ todo }, { headers: { "set-cookie": cookie } });
});

export default function TodosPage({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const error = fetcher.data !== undefined && "error" in fetcher.data ? fetcher.data.error : null;
  return (
    <main>
      <h1>Todos</h1>
      <ul>
        {loaderData.todos.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
      {loaderData.lastAdded === null ? null : <p>Last added: {loaderData.lastAdded}</p>}
      <fetcher.Form method="post">
        <input name="title" aria-label="Title" />
        <button type="submit">Add</button>
        {error === null ? null : <p role="alert">{error}</p>}
        {fetcher.data?.__meta ? <small>Request {fetcher.data.__meta.requestId}</small> : null}
      </fetcher.Form>
      <Form method="post">
        <button type="submit" name="intent" value="clear">
          Clear
        </button>
      </Form>
    </main>
  );
}
