import type { Route } from "./+types/bench-promise";

import { benchItems } from "../lib/bench-items";
import { textField } from "../lib/form";

/** The benchmark's promise loader and action. `bench-effect.tsx` does the same with Effect. */
export async function loader() {
  return { items: benchItems };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  return { saved: textField(form, "title") };
}

export default function BenchPromise({ loaderData }: Route.ComponentProps) {
  return (
    <ul>
      {loaderData.items.map((item) => (
        <li key={item.id}>{item.title}</li>
      ))}
    </ul>
  );
}
