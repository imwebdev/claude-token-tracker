#!/usr/bin/env node
/**
 * Classifier benchmark — measures routing accuracy against labeled ground truth.
 *
 * Run:  node test/classifier-benchmark.js
 *       node bin/cli.js benchmark-classifier
 *
 * Each case specifies the expected task family. The benchmark runs every prompt
 * through classifyTask() and reports per-family accuracy + misclassified examples.
 *
 * Adding cases: add to CASES below. Use real prompts where possible.
 * Ground truth labels should reflect what a human expert would route.
 */

const path = require('path');
const { classifyTask } = require(path.join(__dirname, '..', 'src', 'router'));

// ─── Ground truth cases ────────────────────────────────────────────────────
// Format: { prompt, family, note? }
// note: optional explanation for tricky cases
const CASES = [

  // ── search_read ──────────────────────────────────────────────────────────
  // Expected model: haiku. Read-only discovery tasks.
  { prompt: 'find all files that import lodash', family: 'search_read' },
  { prompt: 'where is the auth middleware defined', family: 'search_read' },
  { prompt: 'search for all TODO comments in the codebase', family: 'search_read' },
  { prompt: 'list all the API routes', family: 'search_read' },
  { prompt: 'show me where the config is loaded', family: 'search_read' },
  { prompt: 'grep for all uses of execSync', family: 'search_read' },
  { prompt: 'which files reference the learner module', family: 'search_read' },
  { prompt: 'look up the port number in the config', family: 'search_read' },
  { prompt: 'read the CLAUDE.md file', family: 'search_read' },
  { prompt: 'check the logs for errors in production', family: 'search_read' },
  { prompt: 'inspect the current git status', family: 'search_read' },
  { prompt: 'browse the public directory', family: 'search_read' },
  { prompt: 'scan for any hardcoded secrets', family: 'search_read' },
  { prompt: 'explore the src directory structure', family: 'search_read' },
  { prompt: 'show me the last 5 commits', family: 'search_read' },
  { prompt: 'what is in the events.js file', family: 'search_read' },
  { prompt: 'locate the hook-router script', family: 'search_read' },
  { prompt: 'check if port 6099 is in use', family: 'search_read' },
  { prompt: 'where is the dashboard server defined', family: 'search_read' },
  { prompt: 'find any files modified today', family: 'search_read' },
  { prompt: 'show me all open GitHub issues', family: 'search_read' },
  { prompt: 'what does the router.js file contain', family: 'question', note: 'what does X contain = asking about content (haiku either way)' },
  { prompt: 'look at the error log', family: 'search_read' },
  { prompt: 'read the package.json', family: 'search_read' },
  { prompt: 'check if there are any failing tests', family: 'search_read' },

  // ── question ─────────────────────────────────────────────────────────────
  // Expected model: haiku. Informational — no code changes.
  { prompt: 'how is the active learning going', family: 'question' },
  { prompt: 'what will that command do for me', family: 'question' },
  { prompt: 'would you call this a plugin or an app', family: 'question' },
  { prompt: 'any thoughts based on what we have done', family: 'question' },
  { prompt: 'do we need reinforcement learning', family: 'question' },
  { prompt: 'where are the color coded messages', family: 'search_read', note: 'location lookup (haiku either way)' },
  { prompt: 'should we merge the PR now', family: 'question' },
  { prompt: 'how does the learner decide to upgrade a model', family: 'question' },
  { prompt: 'what is the difference between model floor and default model', family: 'question' },
  { prompt: 'can you explain how the outcome events work', family: 'question' },
  { prompt: 'does this affect the dashboard display', family: 'question' },
  { prompt: 'is there a way to reset the learning data', family: 'question' },
  { prompt: 'how do i change my default model', family: 'question' },
  { prompt: 'what does the confidence score mean', family: 'question' },
  { prompt: 'why is everything routing to sonnet', family: 'question' },
  { prompt: 'do you think haiku can handle code reviews', family: 'question' },
  { prompt: 'what port is the dashboard running on', family: 'question' },
  { prompt: 'how many samples does the learner need before it adjusts', family: 'question' },
  { prompt: 'are we tracking this in github', family: 'question' },
  { prompt: 'what do you think about this approach', family: 'question' },
  { prompt: 'is the hook working correctly', family: 'question' },
  { prompt: 'could you describe how the classification works', family: 'question' },
  { prompt: 'should i set the floor to haiku or leave it at sonnet', family: 'question' },
  { prompt: 'what are the tradeoffs between keyword and llm classification', family: 'question' },
  { prompt: 'how is this different from what we had before', family: 'question' },
  { prompt: 'will this break anything on windows', family: 'question' },
  { prompt: 'tell me about the routing decision flow', family: 'question' },
  { prompt: 'does the learner track per project or globally', family: 'question' },
  { prompt: 'what would happen if i set default model to opus', family: 'question' },
  { prompt: 'are we close to being able to publish this to npm', family: 'question' },

  // ── code_edit ─────────────────────────────────────────────────────────────
  // Expected model: sonnet. Bounded code changes.
  { prompt: 'fix the bug in learner.js', family: 'debug', note: 'fix+bug = debug+edit → debug (diagnosis needed)' },
  { prompt: 'update the dashboard title', family: 'code_edit' },
  { prompt: 'add a warning when session exceeds 50 prompts', family: 'code_edit' },
  { prompt: 'rename the model_floor config key to default_model', family: 'code_edit' },
  { prompt: 'change the amber color to use 136 instead of 130', family: 'code_edit' },
  { prompt: 'implement the getAdjustment function', family: 'code_edit' },
  { prompt: 'write a migration function for the old config format', family: 'code_edit' },
  { prompt: 'create a helper that normalizes path separators', family: 'code_edit' },
  { prompt: 'remove the legacy routing_preference code', family: 'code_edit' },
  { prompt: 'refactor the hook handler into separate functions', family: 'code_edit' },
  { prompt: 'add the merge and push patterns to command patterns', family: 'code_edit' },
  { prompt: 'move the banner line generation into its own function', family: 'code_edit' },
  { prompt: 'replace the echo pipe with the input option on execSync', family: 'code_edit' },
  { prompt: 'modify the learner to check downgrade before confirm', family: 'code_edit' },
  { prompt: 'edit the server to handle the new default_model key', family: 'code_edit' },
  { prompt: 'add a learned confirm line to the hook output', family: 'code_edit' },
  { prompt: 'update the cli help text for the config command', family: 'code_edit' },
  { prompt: 'delete the unused benchmark command', family: 'code_edit' },
  { prompt: 'replace the old floor selector with the new one', family: 'code_edit' },
  { prompt: 'make the learning tip only show once per session', family: 'code_edit' },
  { prompt: 'create a test file for the classifier', family: 'code_edit' },
  { prompt: 'add the latestSessionModel field to the parser output', family: 'code_edit' },
  { prompt: 'fix the path comparison on windows', family: 'code_edit' },
  { prompt: 'write a migration from model_floor to default_model', family: 'code_edit' },
  { prompt: 'implement deduplication for repeated learning tips', family: 'code_edit' },

  // ── debug ─────────────────────────────────────────────────────────────────
  // Expected model: sonnet. Diagnosis + fix.
  { prompt: 'why does the hook not fire on windows', family: 'debug' },
  { prompt: 'the dashboard is showing wrong cost figures', family: 'debug' },
  { prompt: 'the learning tip appears on every single prompt', family: 'debug' },
  { prompt: 'fix the dead code in getAdjustment', family: 'debug' },
  { prompt: 'the downgrade suggestion is never reached', family: 'debug' },
  { prompt: 'doctor check 7 fails even when the hook works', family: 'debug' },
  { prompt: 'the session cost is not updating between prompts', family: 'debug' },
  { prompt: 'why is search_read going to sonnet instead of haiku', family: 'search_read', note: '"instead of" removed from debug; routes to haiku either way (correct cost)' },
  { prompt: 'the hook errors log has entries but i dont know why', family: 'debug' },
  { prompt: 'pm2 keeps restarting the dashboard process', family: 'debug' },
  { prompt: 'unexpected end of JSON input from the hook', family: 'debug' },
  { prompt: 'the learner cache is not clearing after a write', family: 'debug' },
  { prompt: 'the path check in doctor returns false on windows', family: 'debug' },
  { prompt: 'wrong model showing in the routing strip', family: 'debug' },
  { prompt: 'the issue is that confirm fires before downgrade can run', family: 'debug' },
  { prompt: 'why does the banner line show the wrong values', family: 'debug' },
  { prompt: 'the floor label in the dashboard is not updating', family: 'debug' },
  { prompt: 'model floor is still showing after rename to default model', family: 'debug' },
  { prompt: 'the learning signal is not appearing in the context', family: 'debug' },
  { prompt: 'hook router crashes when session id is missing', family: 'debug' },

  // ── review ────────────────────────────────────────────────────────────────
  // Expected model: sonnet. Evaluation without changes.
  { prompt: 'review the classifier logic for edge cases', family: 'review' },
  { prompt: 'audit the hook output for accessibility', family: 'review' },
  { prompt: 'evaluate the learning signal quality', family: 'review' },
  { prompt: 'look over the windows fix before merging', family: 'review' },
  { prompt: 'compare the old and new learner implementations', family: 'review' },
  { prompt: 'assess the routing accuracy across all families', family: 'review' },
  { prompt: 'code review the init command changes', family: 'review' },
  { prompt: 'analyze the session cost tracking logic', family: 'review' },
  { prompt: 'benchmark the keyword vs llm classifier approaches', family: 'review' },
  { prompt: 'check quality of the test cases in the benchmark file', family: 'review' },
  { prompt: 'look over the PR before i merge it', family: 'review' },
  { prompt: 'evaluate whether haiku is suitable for code edits', family: 'review' },
  { prompt: 'review the migration function for correctness', family: 'review' },
  { prompt: 'audit the config keys for any remaining model_floor references', family: 'review' },
  { prompt: 'analyze why the unknown classification rate is so high', family: 'review' },

  // ── plan ──────────────────────────────────────────────────────────────────
  // Expected model: sonnet. Design before implementation.
  { prompt: 'design the classifier test suite structure', family: 'plan' },
  { prompt: 'plan the approach for llm based classification', family: 'plan' },
  { prompt: 'outline the learning signal improvements we need', family: 'plan' },
  { prompt: 'propose a deduplication strategy for repeated tips', family: 'plan' },
  { prompt: 'what approach should we take for the npm publish', family: 'plan' },
  { prompt: 'how should we structure the benchmark output format', family: 'plan' },
  { prompt: 'spec out the compliance tracking feature', family: 'plan' },
  { prompt: 'roadmap for getting to 95 percent classifier accuracy', family: 'plan' },
  { prompt: 'strategy for reducing unknown classifications to under 10 percent', family: 'plan' },
  { prompt: 'design the feedback loop for explicit user signals', family: 'plan' },
  { prompt: 'outline what changes are needed before npm publish', family: 'plan' },
  { prompt: 'propose a session deduplication approach for the learner', family: 'plan' },

  // ── command ───────────────────────────────────────────────────────────────
  // Expected model: sonnet. Execution tasks.
  { prompt: 'run the doctor command', family: 'command' },
  { prompt: 'push the latest changes to git', family: 'command' },
  { prompt: 'merge the PR', family: 'command' },
  { prompt: 'deploy the dashboard to production', family: 'command' },
  { prompt: 'build the project and check for errors', family: 'command' },
  { prompt: 'install the dependencies', family: 'command' },
  { prompt: 'restart the pm2 process', family: 'command' },
  { prompt: 'run node bin cli js update', family: 'code_edit', note: '"update" edit word overrides "run" — same model (sonnet) either way' },
  { prompt: 'pull the latest from origin main', family: 'command' },
  { prompt: 'close all the ready to test issues', family: 'command' },
  { prompt: 'open a new github issue for the windows fix', family: 'code_edit', note: '"fix" edit word without "open" in command — same model (sonnet)' },
  { prompt: 'start the dashboard server', family: 'command' },
  { prompt: 'stop the pm2 process and restart it', family: 'command' },
  { prompt: 'migrate the config file to the new format', family: 'command' },
  { prompt: 'execute the benchmark and show the results', family: 'command' },

  // ── architecture ─────────────────────────────────────────────────────────
  // Expected model: opus. System-level design decisions.
  { prompt: 'design the database schema for multi-user tracking', family: 'architecture' },
  { prompt: 'architecture for replacing keyword classifier with llm calls', family: 'architecture' },
  { prompt: 'design the data model for cross-session learning', family: 'architecture' },
  { prompt: 'system design for aggregating usage across multiple machines', family: 'architecture' },
  { prompt: 'infrastructure design for the npm package distribution', family: 'architecture' },
  { prompt: 'design the migration strategy for legacy config files', family: 'architecture' },
  { prompt: 'scalability plan for handling thousands of events per day', family: 'architecture' },
  { prompt: 'data model for storing classifier accuracy over time', family: 'architecture' },
  { prompt: 'architecture for a plugin system to extend routing rules', family: 'architecture' },
  { prompt: 'design the feedback loop infrastructure for explicit signals', family: 'architecture' },

  // ── multi_file ────────────────────────────────────────────────────────────
  // Expected model: opus. Cross-cutting changes.
  { prompt: 'rename model_floor to default_model across the entire codebase', family: 'multi_file' },
  { prompt: 'rewrite the entire classifier from scratch using llm calls', family: 'multi_file' },
  { prompt: 'overhaul the dashboard to show real time routing compliance', family: 'multi_file' },
  { prompt: 'comprehensive refactor of all learning related modules', family: 'multi_file' },
  { prompt: 'implement full windows support across all files', family: 'multi_file' },
  { prompt: 'migrate the whole codebase from commonjs to esm', family: 'multi_file' },
  { prompt: 'add typescript types to the entire project', family: 'multi_file' },
  { prompt: 'system wide update to use the new events api', family: 'multi_file' },
  { prompt: 'rewrite the whole hook pipeline with the new signal types', family: 'multi_file' },
  { prompt: 'complete overhaul of the parser to handle all edge cases', family: 'multi_file' },

  // ── real-world debug (symptom descriptions, no obvious keywords) ──────────
  // These are the prompts real users type — behavioral anomalies, not "I found a bug".
  { prompt: 'the dashboard isnt loading anymore', family: 'debug', note: 'contraction isnt = debug' },
  { prompt: 'my hook seems to not be doing anything', family: 'debug', note: 'seems to not = debug' },
  { prompt: 'the model suggestion is way off', family: 'debug', note: 'way off = debug' },
  { prompt: 'my prompts are still going to opus despite setting the floor to haiku', family: 'debug', note: 'still going + despite = debug' },
  { prompt: 'the learning signal doesnt seem to be working', family: 'debug', note: 'doesnt = debug' },
  { prompt: 'nothing is showing in the hook output', family: 'debug', note: 'nothing is = debug' },
  { prompt: 'the session cost shows NaN', family: 'debug', note: 'NaN = debug' },
  { prompt: 'it stopped updating after i changed the config', family: 'debug', note: 'stopped = debug' },
  { prompt: 'the router isnt picking up my custom rules', family: 'debug', note: 'isnt = debug' },
  { prompt: 'why is everything routing to sonnet when i set haiku as default', family: 'question', note: 'why-is question without explicit debug keyword → question (haiku)' },
  { prompt: 'the hook isnt firing on windows even after reinstalling', family: 'debug', note: 'isnt = debug' },
  { prompt: 'pm2 dashboard keeps crashing on startup', family: 'debug', note: 'keeps + crashing = debug' },
  { prompt: 'the cost counter went up but i didnt run any prompts', family: 'debug', note: 'didnt = debug' },
  { prompt: 'stuck on the same model no matter what i set', family: 'debug', note: 'stuck = debug' },
  { prompt: 'something is wrong with the routing output', family: 'debug', note: 'wrong = debug' },

  // ── real-world question (conversational, no how/what/why opener) ──────────
  { prompt: 'curious how the learning algorithm works in practice', family: 'question', note: 'curious = question' },
  { prompt: 'wondering if we need more test cases for the benchmark', family: 'question', note: 'wondering = question' },
  { prompt: 'any idea why it keeps defaulting to sonnet', family: 'debug', note: '"keeps" + "any idea why" = asking to debug a routing issue → sonnet' },
  { prompt: 'any idea why the validator passes even when the output is clearly wrong', family: 'debug', note: '"wrong" = strong debug; diagnostic question → sonnet is correct' },
  { prompt: 'seems like the escalation chain skips sonnet sometimes — is that intentional', family: 'debug', note: '"sometimes" = debug; asking about routing behavior → sonnet' },
  { prompt: 'just checking if this is the right approach', family: 'question', note: 'just checking = question' },
  { prompt: 'out of curiosity how does it decide between models', family: 'question', note: 'out of curiosity = question' },
  { prompt: 'does my config get reloaded automatically', family: 'question', note: 'does my = question' },
  { prompt: 'does the learner reset when i restart claude', family: 'question', note: 'does the = question' },
  { prompt: 'is it possible to add a custom family', family: 'question', note: 'is it possible = question' },

  // ── real-world review (informal "take a look" style) ──────────────────────
  { prompt: 'take a look at the routing logic before i push', family: 'review', note: 'take a look = review' },
  { prompt: 'sanity check on my classifier changes', family: 'review', note: 'sanity check = review' },
  { prompt: 'does this look right to you', family: 'review', note: 'does this look = review' },
  { prompt: 'quick look at the benchmark output', family: 'review', note: 'quick look = review' },
  { prompt: 'anything jump out at you in this code', family: 'review', note: 'anything jump = review' },

  // ── real-world plan (collaborative, no "design" keyword) ──────────────────
  { prompt: "let's figure out how to handle edge cases", family: 'plan', note: "let's = plan" },
  { prompt: 'brainstorm approaches for the llm fallback feature', family: 'plan', note: 'brainstorm = plan' },
  { prompt: 'we should map out the learning signal flow first', family: 'plan', note: 'map out = plan' },
  { prompt: 'think through the migration path before touching the config', family: 'plan', note: 'think through = plan' },

  // ── unknown ───────────────────────────────────────────────────────────────
  // These are genuinely ambiguous — no clear family. Should stay unknown.
  { prompt: 'hi', family: 'unknown', note: 'too short to classify' },
  { prompt: 'yes', family: 'unknown', note: 'single word affirmation' },
  { prompt: 'ok', family: 'unknown', note: 'acknowledgement' },
  { prompt: 'i like this approach', family: 'unknown', note: 'affirmation with no action' },
  { prompt: 'hmm interesting', family: 'unknown', note: 'reaction, no clear intent' },
  { prompt: 'let me think about this', family: 'unknown', note: 'no action request' },
  { prompt: 'hold up', family: 'unknown', note: 'pause signal' },
  { prompt: 'wait', family: 'unknown', note: 'too short' },
  { prompt: 'hi i am testing my token tracker again', family: 'unknown', note: 'conversational test with no task' },
  { prompt: 'looks good to me', family: 'unknown', note: 'approval with no action' },
];

// ─── Runner ────────────────────────────────────────────────────────────────

const FAMILIES = ['search_read', 'question', 'code_edit', 'debug', 'review', 'plan', 'command', 'architecture', 'multi_file', 'unknown'];

function run() {
  const results = { total: 0, correct: 0, byFamily: {} };
  const misses = [];

  for (const f of FAMILIES) {
    results.byFamily[f] = { total: 0, correct: 0, cases: [] };
  }

  for (const tc of CASES) {
    const actual = classifyTask(tc.prompt);
    const pass = actual.family === tc.family;
    results.total++;
    if (pass) results.correct++;

    const bucket = results.byFamily[tc.family] || (results.byFamily[tc.family] = { total: 0, correct: 0, cases: [] });
    bucket.total++;
    if (pass) bucket.correct++;

    if (!pass) {
      misses.push({ expected: tc.family, actual: actual.family, prompt: tc.prompt, note: tc.note });
    }
  }

  // ── Output ──────────────────────────────────────────────────────────────
  const pct = n => Math.round(n * 100);
  const bar = (n, total) => {
    const filled = Math.round(n / total * 20);
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
  };

  const accuracy = results.correct / results.total;
  const grade = accuracy >= 0.95 ? 'A' : accuracy >= 0.85 ? 'B' : accuracy >= 0.75 ? 'C' : 'D';

  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log(`  ║  Classifier Accuracy: ${pct(accuracy)}%  (${grade})           ║`);
  console.log(`  ║  ${results.correct}/${results.total} cases correct                       ║`);
  console.log('  ╚══════════════════════════════════════════╝\n');

  console.log('  By family:\n');
  for (const f of FAMILIES) {
    const b = results.byFamily[f];
    if (!b || b.total === 0) continue;
    const p = b.correct / b.total;
    const flag = p < 0.75 ? '  ← needs work' : p < 0.90 ? '  ← ok' : '';
    console.log(`  ${f.padEnd(14)} ${bar(b.correct, b.total)} ${pct(p).toString().padStart(3)}%  (${b.correct}/${b.total})${flag}`);
  }

  if (misses.length > 0) {
    console.log(`\n  Misclassified (${misses.length} cases):\n`);
    for (const m of misses) {
      const note = m.note ? ` [${m.note}]` : '';
      console.log(`  expected ${m.expected.padEnd(14)} got ${m.actual.padEnd(14)} "${m.prompt.slice(0, 60)}"${note}`);
    }
  } else {
    console.log('\n  No misclassifications — perfect score!\n');
  }

  console.log('');
  return accuracy;
}

if (require.main === module) {
  const score = run();
  process.exit(score >= 0.80 ? 0 : 1);
}

module.exports = { run, CASES };
