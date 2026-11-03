/** A text field of a form, or `""` when it is missing or a file. */
export const textField = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};
