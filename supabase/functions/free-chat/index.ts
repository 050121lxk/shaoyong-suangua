import { createHandler } from '../_shared/handler.mjs';
import rulesJson from '../_shared/rules.json' with { type: 'json' };

Deno.serve(createHandler({ env: (key: string) => Deno.env.get(key), rules: rulesJson }));
