/**
 * Interactive REPL mode for task routing classification.
 * Type task descriptions to see model recommendations, cost multipliers, and fallback chains.
 */

'use strict';

const readline = require('readline');
const path = require('path');
const { classifyTask, recommendModel } = require(path.join(__dirname, 'router'));

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};

const modelColor = { haiku: C.green, sonnet: C.yellow, opus: C.magenta };
const complexityColor = { low: C.green, medium: C.yellow, high: C.red };

function colorize(str, ...codes) {
  return codes.join('') + str + C.reset;
}

// ── Output helpers ────────────────────────────────────────────────────────────

function printWelcome() {
  console.log('');
  console.log(colorize('  Claude Token Tracker — Interactive Router', C.bold, C.cyan));
  console.log(colorize('  Type a task description to get a routing recommendation.', C.dim));
  console.log(colorize('  Commands: help, quit, exit', C.dim));
  console.log('');
}

function printHelp() {
  console.log('');
  console.log(colorize('  Token Coach REPL — Help', C.bold));
  console.log('');
  console.log('  Type any task description to classify it and get a model recommendation.');
  console.log('');
  console.log('  Examples:');
  console.log(colorize('    search for TODO comments in the codebase', C.dim));
  console.log(colorize('    fix the authentication bug in login.js', C.dim));
  console.log(colorize('    design a new database schema for user permissions', C.dim));
  console.log(colorize('    refactor the entire codebase to use TypeScript', C.dim));
  console.log('');
  console.log('  Special commands:');
  console.log('    help      — show this message');
  console.log('    quit/exit — leave the REPL');
  console.log('');
}

function printResult(task) {
  const classification = classifyTask(task);
  const recommendation = recommendModel(classification);

  const { family, complexity, confidence, reasons: classReasons } = classification;
  const { model, fallbackChain, reasons: recReasons, costMultiplier, preference } = recommendation;

  const confLabel = confidence >= 0.8 ? 'high' : confidence >= 0.6 ? 'moderate' : 'low';
  const confColor = confidence >= 0.8 ? C.green : confidence >= 0.6 ? C.yellow : C.red;
  const mColor    = modelColor[model]     || C.white;
  const cxColor   = complexityColor[complexity] || C.white;

  console.log('');
  console.log('  ' + colorize('─'.repeat(56), C.dim));

  // Classification row
  console.log(
    '  ' +
    colorize('Family:    ', C.dim) +
    colorize(family.padEnd(14), C.bold) +
    colorize('Complexity: ', C.dim) +
    colorize(complexity.padEnd(8), C.bold, cxColor) +
    colorize('Confidence: ', C.dim) +
    colorize(`${(confidence * 100).toFixed(0)}% (${confLabel})`, C.bold, confColor)
  );

  // Model recommendation row
  console.log(
    '  ' +
    colorize('Model:     ', C.dim) +
    colorize(model.toUpperCase().padEnd(10), C.bold, mColor) +
    colorize('Cost ×', C.dim) +
    colorize(`${costMultiplier}`.padEnd(6), C.bold, mColor) +
    colorize('Pref: ', C.dim) +
    colorize(`${preference}/100`, C.dim)
  );

  // Fallback chain
  const chainStr = fallbackChain.map(m => {
    const mc = modelColor[m] || C.white;
    return colorize(m, mc);
  }).join(colorize(' → ', C.dim));
  console.log('  ' + colorize('Fallbacks: ', C.dim) + chainStr);

  // Reasons
  const allReasons = [...classReasons, ...recReasons];
  if (allReasons.length) {
    console.log('  ' + colorize('Reasons:   ', C.dim) + colorize(allReasons[0], C.dim));
    for (let i = 1; i < allReasons.length; i++) {
      console.log('  ' + ' '.repeat(11) + colorize(allReasons[i], C.dim));
    }
  }

  console.log('  ' + colorize('─'.repeat(56), C.dim));
  console.log('');
}

// ── Main REPL entry point ─────────────────────────────────────────────────────

function startRepl() {
  // If stdin is not a TTY (i.e. piped), process input without interactive prompts
  const isTTY = process.stdin.isTTY;

  const rl = readline.createInterface({
    input: process.stdin,
    output: isTTY ? process.stdout : null,
    terminal: false,
  });

  if (isTTY) {
    printWelcome();
  }

  function prompt() {
    if (isTTY) {
      process.stdout.write(colorize('> ', C.bold, C.cyan));
    }
  }

  prompt();

  rl.on('line', (line) => {
    const input = line.trim();

    if (!input) {
      prompt();
      return;
    }

    const lower = input.toLowerCase();

    if (lower === 'quit' || lower === 'exit') {
      if (isTTY) console.log(colorize('\n  Bye!\n', C.dim));
      rl.close();
      process.exit(0);
      return;
    }

    if (lower === 'help') {
      printHelp();
      prompt();
      return;
    }

    try {
      printResult(input);
    } catch (err) {
      console.error(colorize(`  Error: ${err.message}`, C.red));
    }

    prompt();
  });

  rl.on('close', () => {
    if (isTTY) console.log('');
    process.exit(0);
  });
}

module.exports = { startRepl };
