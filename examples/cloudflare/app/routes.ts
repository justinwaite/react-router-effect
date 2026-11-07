import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("notes/:id", "routes/note.tsx"),
  route("legacy", "routes/legacy.tsx"),
  route("background", "routes/background.ts"),
  route("stats", "routes/stats.ts"),
] satisfies RouteConfig;
