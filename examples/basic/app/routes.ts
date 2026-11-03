import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("todos", "routes/todos.tsx"),
  route("todos/old", "routes/todos-old.ts"),
  route("legacy", "routes/legacy.tsx"),
  route("events", "routes/events.ts"),
  route("events/status", "routes/events-status.ts"),
  route("bench/promise", "routes/bench-promise.tsx"),
  route("bench/effect", "routes/bench-effect.tsx"),
] satisfies RouteConfig;
