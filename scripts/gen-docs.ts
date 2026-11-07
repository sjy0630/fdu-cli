// 生成 skills/fdu-cli/reference.md
import { writeFileSync } from 'node:fs';
import { referenceMarkdown } from '../src/reference';

writeFileSync(new URL('../skills/fdu-cli/reference.md', import.meta.url), referenceMarkdown());
