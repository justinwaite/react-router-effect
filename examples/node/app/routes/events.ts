import { Effect, Schedule, Stream } from "effect";
import type { EffectRouteArgs } from "react-router-effect";

import type { Route } from "./+types/events";

import { openStreams } from "../lib/event-streams.server";

/**
 * A resource route that streams server-sent events from an Effect `Stream`.
 * When the client leaves, the adapter cancels the body, which interrupts the
 * stream.
 */
export const loader = Effect.fn("loader.events")(({ request }: EffectRouteArgs<Route.LoaderArgs>) =>
  Effect.sync(() => {
    const count = Number(new URL(request.url).searchParams.get("count") ?? "10");
    const ticks = Stream.fromSchedule(Schedule.spaced("100 millis")).pipe(
      Stream.take(count),
      Stream.map((tick) => `data: ${JSON.stringify({ tick })}\n\n`),
      Stream.encodeText,
    );
    return new Response(Stream.toReadableStream(openStreams.track(ticks)), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }),
);
