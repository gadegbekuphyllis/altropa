const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

// Sample obfuscated code
const obfuscatedCode = `
  var _0x1234 = "hello" + " " + "world";
  var _0x5678 = 0x12 + 0x34;
  console["\x6c\x6f\x67"](_0x1234, _0x5678);
`;

function deobfuscate(code) {
  // 1. Parse JS string into AST
  const ast = parser.parse(code, {
    sourceType: "script",
  });

  // 2. Define AST Visitors for transformation rules
  const visitor = {
    // Feature 1: Decodes Hex/Unicode String Literals
    StringLiteral(path) {
      if (path.node.extra) {
        // Removing 'extra' forces Babel generator to emit raw string representation
        delete path.node.extra;
      }
    },

    // Feature 2: Constant Folding (e.g. "a" + "b" -> "ab", 5 + 10 -> 15)
    BinaryExpression(path) {
      const { left, right, operator } = path.node;

      // Check if both sides are literals
      if (t.isLiteral(left) && t.isLiteral(right)) {
        const leftVal = left.value;
        const rightVal = right.value;

        let evaluated;
        if (operator === "+") evaluated = leftVal + rightVal;
        else if (operator === "-") evaluated = leftVal - rightVal;
        else if (operator === "*") evaluated = leftVal * rightVal;

        if (evaluated !== undefined) {
          path.replaceWith(t.valueToNode(evaluated));
        }
      }
    },

    // Feature 3: Convert Member Notation ( console["log"] -> console.log )
    MemberExpression(path) {
      if (
        path.node.computed &&
        t.isStringLiteral(path.node.property) &&
        /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(path.node.property.value)
      ) {
        path.node.computed = false;
        path.node.property = t.identifier(path.node.property.value);
      }
    }
  };

  // 3. Traverse AST & Apply Visitor Rules
  traverse(ast, visitor);

  // 4. Generate clean code back from modified AST
  const output = generate(ast, {
    comments: true,
    compact: false, // Ensures code is pretty-printed
  });

  return output.code;
}

console.log("=== DEOBFUSCATED CODE ===");
console.log(deobfuscate(obfuscatedCode));