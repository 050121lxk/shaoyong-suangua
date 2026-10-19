import { readFile, writeFile } from 'node:fs/promises';
import { assembleRules } from '../web/core.mjs';

const files = ['SKILL.md', 'REFERENCE.md', 'EXAMPLES.md', 'YAO_CI.md'];
const docs = await Promise.all(files.map(async name => [name, await readFile(new URL('../' + name, import.meta.url), 'utf8')]));
await writeFile(new URL('../supabase/functions/_shared/rules.json', import.meta.url), JSON.stringify(assembleRules(docs)) + '\n');
console.log('Updated server-side full skill prompt (no secrets).');
