import { writeFile } from 'node:fs/promises';
import { documents, DOCUMENT_VERSION } from '../src/docs-content.js';

const parts = ['SunPhi — Working whitepaper', `Version ${DOCUMENT_VERSION}`, 'Token symbol: sun(φ)', 'Protocol proposal and conditional research. No live issuance, sale, or distributed-network security claim.', ''];
for (const [index, doc] of documents.entries()) {
  parts.push(`${index + 1}. ${doc.title.toUpperCase()}`, `Status: ${doc.status}`, doc.summary, '');
  for (const section of doc.sections) {
    parts.push(section.title);
    if (section.formula) parts.push(section.formula);
    if (section.paragraphs) parts.push(...section.paragraphs);
    if (section.bullets) parts.push(...section.bullets.map(x => `- ${x}`));
    if (section.table) parts.push(section.table.headers.join(' | '), ...section.table.rows.map(row => row.join(' | ')));
    if (section.links) parts.push(...section.links.map(([label, url]) => `${label}: ${url}`));
    parts.push('');
  }
}
parts.push('Interactive calculations: https://coin.sun-phi.com/#/probability', 'Economic sensitivity: https://coin.sun-phi.com/#/economics', 'Documentation: https://coin.sun-phi.com/#/docs');
await writeFile(new URL('../public/sunphi-whitepaper-draft.txt', import.meta.url), parts.join('\n') + '\n');
console.log(`Generated working whitepaper: ${documents.length} chapters.`);
