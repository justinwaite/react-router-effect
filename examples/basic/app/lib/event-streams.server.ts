import { Effect, Stream } from "effect";

let open = 0;

/** Counts the event streams that are open, from their first pull until they end or are interrupted. */
export const openStreams = {
  get count() {
    return open;
  },
  track: <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    Stream.suspend(() => {
      open += 1;
      return stream.pipe(Stream.ensuring(Effect.sync(() => (open -= 1))));
    }),
};
