const fs = require('fs');

const code = fs.readFileSync('js/app.js', 'utf8');
let openCount = 0;
let stack = [];

// Simple tokenizer for quotes and comments so we ignore braces inside them
let inString = null; // '"', "'", "`"
let inComment = null; // 'line', 'block'

for (let i = 0; i < code.length; i++) {
  const char = code[i];
  const next = code[i+1];
  const prev = code[i-1];

  if (inComment === 'line') {
    if (char === '\n') inComment = null;
    continue;
  }
  if (inComment === 'block') {
    if (char === '*' && next === '/') {
      inComment = null;
      i++;
    }
    continue;
  }
  if (inString) {
    if (char === inString && prev !== '\\') {
      inString = null;
    }
    continue;
  }

  // Check comments
  if (char === '/' && next === '/') {
    inComment = 'line';
    i++;
    continue;
  }
  if (char === '/' && next === '*') {
    inComment = 'block';
    i++;
    continue;
  }

  // Check strings
  if (char === '"' || char === "'" || char === '`') {
    inString = char;
    continue;
  }

  // Track braces
  if (char === '{') {
    openCount++;
    // Get line number
    const lineNum = code.substring(0, i).split('\n').length;
    stack.push({ char, i, lineNum });
  } else if (char === '}') {
    openCount--;
    if (stack.length > 0) {
      stack.pop();
    } else {
      const lineNum = code.substring(0, i).split('\n').length;
      console.log(`Extra closing brace '}' at line ${lineNum}`);
    }
  }
}

console.log(`Final open count: ${openCount}`);
if (stack.length > 0) {
  console.log("Unclosed opening braces:");
  stack.forEach(item => {
    // Get some context
    const startPos = Math.max(0, item.i - 30);
    const endPos = Math.min(code.length, item.i + 50);
    const context = code.substring(startPos, endPos).replace(/\n/g, '\\n');
    console.log(`Line ${item.lineNum}: context: "... ${context} ..."`);
  });
}
