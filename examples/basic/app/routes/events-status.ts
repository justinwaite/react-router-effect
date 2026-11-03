import { openStreams } from "../lib/event-streams.server";

/** How many event streams are open. A plain resource route. */
export function loader() {
  return Response.json({ open: openStreams.count });
}
