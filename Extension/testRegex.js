const fs = require('fs');
console.time('read');
const content = fs.readFileSync('c:/SOTI AI/Extension/knowledge/PulseKnowledge.md', 'utf8');
console.timeEnd('read');
console.time('split');
const chunks = content.split(/(?=^#{1,3}\s+)/m);
console.timeEnd('split');
console.log('chunks length:', chunks.length);
