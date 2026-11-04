/** The app's services: a todo list, and the request's information and visitor. */
import { Context, Data, Effect, Layer, Ref } from "effect";

export interface Todo {
  readonly id: number;
  readonly title: string;
}

/** A title the list does not accept. The route factory turns it into form data. */
export class InvalidTodo extends Data.TaggedError("InvalidTodo")<{ readonly message: string }> {}

/** A title already on the list. The action that adds todos handles it itself. */
export class DuplicateTodo extends Data.TaggedError("DuplicateTodo")<{ readonly title: string }> {}

/** An in-memory todo list, provided by the app's runtime. */
export class Todos extends Context.Service<
  Todos,
  {
    readonly list: Effect.Effect<ReadonlyArray<Todo>>;
    readonly add: (title: string) => Effect.Effect<Todo, InvalidTodo | DuplicateTodo>;
    readonly clear: Effect.Effect<void>;
  }
>()("example/Todos") {
  static readonly layer = Layer.effect(
    Todos,
    Effect.gen(function* () {
      const todos = yield* Ref.make<ReadonlyArray<Todo>>([
        { id: 1, title: "Read the adapter's README" },
        { id: 2, title: "Write a loader with Effect.fn" },
      ]);
      const add = Effect.fn("Todos.add")(function* (input: string) {
        const title = input.trim();
        if (title.length === 0) return yield* new InvalidTodo({ message: "A todo needs a title" });
        if (title.length > 80)
          return yield* new InvalidTodo({ message: "Keep it under 80 characters" });
        const current = yield* Ref.get(todos);
        if (current.some((todo) => todo.title === title))
          return yield* new DuplicateTodo({ title });
        const todo = { id: Math.max(0, ...current.map((todo) => todo.id)) + 1, title };
        yield* Ref.set(todos, [...current, todo]);
        return todo;
      });
      return { list: Ref.get(todos), add, clear: Ref.set(todos, []) };
    }),
  );
}

/** The request's id and start time. The adapter's `requestContext` builds it for each request. */
export class RequestInfo extends Context.Service<
  RequestInfo,
  { readonly id: string; readonly startedAt: number }
>()("example/RequestInfo") {}

/** Who is visiting. The root middleware provides it to everything downstream of `next()`. */
export class Visitor extends Context.Service<
  Visitor,
  { readonly name: string; readonly isNew: boolean }
>()("example/Visitor") {}
