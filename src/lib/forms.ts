import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

/** Minimal Zod resolver for react-hook-form (keeps one validation library). */
export function zodResolver<S extends z.ZodType<FieldValues, FieldValues>>(schema: S): Resolver<z.input<S>, unknown, z.output<S>> {
  return async (values) => {
    const r = schema.safeParse(values);
    if (r.success) return { values: r.data, errors: {} };
    const errors: Record<string, { type: string; message: string }> = {};
    for (const issue of r.error.issues) {
      const key = issue.path.join('.') || 'root';
      if (!errors[key]) errors[key] = { type: issue.code, message: issue.message };
    }
    return { values: {}, errors: errors as FieldErrors<z.input<S>> };
  };
}
