const fs = require('fs');
const content = fs.readFileSync('c:/SOTI AI/Extension/knowledge/PulseKnowledge.md', 'utf8');

console.time('split-regex');
try {
    content.split(/(?=^#{1,3}\s+)/m);
} catch (e) {
    console.log(e);
}
console.timeEnd('split-regex');

console.time('split-string');
content.split('\n# ');
console.timeEnd('split-string');
