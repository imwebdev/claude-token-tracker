/**
 * validate-log — Runs real-world task-log.csv entries through the classifier
 * and reports misclassification rate, worst offenders, and suggested fixes.
 *
 * Usage: node bin/cli.js validate-log [--csv path] [--min-confidence 0.7] [--json]
 */
const path = require('path');
const parser = require('./parser');
const router = require('./router');

const MODEL_TIER = { haiku: 0, sonnet: 1, opus: 2 };

/**
 * Parse ground truth model from task-log.csv model field.
 * "opus>sonnet" → "sonnet" (the subagent that handled the work)
 */
// Map non-standard model names to the closest tier
const MODEL_ALIASES = { codex: 'opus', gpt: 'opus', claude: 'sonnet' };

function parseGroundTruth(modelField) {
  if (!modelField) return null;
  const final = modelField.trim().split('>').pop().trim().toLowerCase();
  if (MODEL_TIER.hasOwnProperty(final)) return final;
  if (MODEL_ALIASES[final]) return MODEL_ALIASES[final];
  return null;
}

function runValidateLog(args = []) {
  // ── Parse flags ──
  let csvPath = null;
  let minConfidence = 0;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--csv' && args[i + 1]) { csvPath = args[++i]; }
    else if (args[i] === '--min-confidence' && args[i + 1]) { minConfidence = parseFloat(args[++i]) || 0; }
    else if (args[i] === '--json') { jsonOutput = true; }
  }

  // ── Load task log ──
  let records;
  if (csvPath) {
    const fs = require('fs');
    if (!fs.existsSync(csvPath)) {
      console.error(`validate-log: file not found: ${csvPath}`);
      process.exit(1);
    }
    records = fs.readFileSync(csvPath, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(line => {
        const match = line.match(/^([^,]+),([^,]+),([^,]+),([^,]+),(.+)$/);
        if (!match || match[1] === 'timestamp') return null;
        return { timestamp: match[1], project: match[2], model: match[3], size: match[4], description: match[5] };
      })
      .filter(Boolean);
  } else {
    records = parser.readTaskLog();
  }

  if (!records || records.length === 0) {
    console.error('validate-log: no task-log records found. Run `node bin/cli.js init` or specify --csv path.');
    process.exit(1);
  }

  // ── Classify each record ──
  const results = [];
  for (const rec of records) {
    const groundTruth = parseGroundTruth(rec.model);
    if (!groundTruth) continue; // skip rows with unrecognized model fields

    const classification = router.classifyTask(rec.description);
    const recommendation = router.recommendModel(classification);
    const predicted = recommendation.model;

    if (classification.confidence < minConfidence) continue;

    const gap = (MODEL_TIER[groundTruth] || 0) - (MODEL_TIER[predicted] || 0);
    const match = predicted === groundTruth;

    results.push({
      description: rec.description,
      project: rec.project,
      groundTruth,
      predicted,
      family: classification.family,
      confidence: classification.confidence,
      gap,        // positive = under-predicted (quality risk), negative = over-predicted (cost waste)
      match,
    });
  }

  if (results.length === 0) {
    console.error('validate-log: no valid records to evaluate (check --min-confidence threshold).');
    process.exit(1);
  }

  // ── Aggregate ──
  const total = results.length;
  const matched = results.filter(r => r.match).length;
  const mismatched = total - matched;
  const accuracy = Math.round(matched / total * 100);

  // Per-family breakdown
  const byFamily = {};
  for (const r of results) {
    if (!byFamily[r.family]) byFamily[r.family] = { total: 0, matched: 0, mismatches: [] };
    byFamily[r.family].total++;
    if (r.match) byFamily[r.family].matched++;
    else byFamily[r.family].mismatches.push(r);
  }

  // Worst offenders: largest |gap|, not matched
  const worstOffenders = results
    .filter(r => !r.match)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 10);

  // Suggested fixes: families with ≥3 consistent mispredictions in the same direction
  const suggestions = [];
  for (const [family, data] of Object.entries(byFamily)) {
    const underPredicted = data.mismatches.filter(r => r.gap > 0);
    const overPredicted = data.mismatches.filter(r => r.gap < 0);
    if (underPredicted.length >= 3) {
      const avgGap = (underPredicted.reduce((s, r) => s + r.gap, 0) / underPredicted.length).toFixed(1);
      suggestions.push(`${family}: ${underPredicted.length} cases under-predicted (avg +${avgGap} tier) — add complexity signals or raise model floor for this family`);
    }
    if (overPredicted.length >= 3) {
      const avgGap = (overPredicted.reduce((s, r) => s + r.gap, 0) / overPredicted.length).toFixed(1);
      suggestions.push(`${family}: ${overPredicted.length} cases over-predicted (avg ${avgGap} tier) — routing is too aggressive; tighten keyword patterns`);
    }
  }

  // ── Output ──
  if (jsonOutput) {
    console.log(JSON.stringify({ total, matched, mismatched, accuracy, byFamily, worstOffenders, suggestions }, null, 2));
    return;
  }

  const reset = '\x1b[0m';
  const bold  = '\x1b[1m';
  const dim   = '\x1b[2m';
  const green = '\x1b[38;5;107m';
  const amber = '\x1b[38;5;136m';
  const red   = '\x1b[38;5;167m';
  const gray  = '\x1b[38;5;243m';
  const cyan  = '\x1b[38;5;81m';

  const accColor = accuracy >= 90 ? green : accuracy >= 75 ? amber : red;

  console.log('');
  console.log(`${bold}Token Coach — Validate Log${reset}`);
  console.log(`${gray}${'─'.repeat(44)}${reset}`);
  console.log(`  ${gray}Records:${reset}  ${total}`);
  console.log(`  ${gray}Matched:${reset}  ${green}${matched} (${accuracy}%)${reset}`);
  console.log(`  ${gray}Mismatch:${reset} ${red}${mismatched} (${100 - accuracy}%)${reset}`);
  console.log(`  ${gray}Accuracy:${reset} ${accColor}${bold}${accuracy}%${reset}`);
  if (minConfidence > 0) console.log(`  ${gray}Filter:${reset}   confidence ≥ ${minConfidence}`);
  console.log('');

  console.log(`${bold}  By family${reset}`);
  const sortedFamilies = Object.entries(byFamily).sort((a, b) => b[1].total - a[1].total);
  for (const [family, data] of sortedFamilies) {
    const familyAcc = Math.round(data.matched / data.total * 100);
    const accC = familyAcc >= 90 ? green : familyAcc >= 70 ? amber : red;
    const bar = '█'.repeat(Math.round(familyAcc / 10)) + '░'.repeat(10 - Math.round(familyAcc / 10));
    console.log(`  ${gray}${family.padEnd(16)}${reset} ${accC}${bar}${reset} ${accC}${familyAcc}%${reset} ${dim}(${data.total} records, ${data.total - data.matched} miss)${reset}`);
  }
  console.log('');

  if (worstOffenders.length > 0) {
    console.log(`${bold}  Worst offenders${reset}`);
    for (const r of worstOffenders) {
      const dir = r.gap > 0 ? `${red}↑ under-predicted${reset}` : `${amber}↓ over-predicted${reset}`;
      const desc = r.description.length > 60 ? r.description.slice(0, 57) + '...' : r.description;
      console.log(`  ${gray}[${r.family}]${reset} ${cyan}predicted:${r.predicted}${reset}  ${gray}actual:${r.groundTruth}${reset}  gap:${r.gap > 0 ? red : amber}${r.gap > 0 ? '+' : ''}${r.gap}${reset} ${dir}`);
      console.log(`    ${dim}"${desc}"${reset}`);
    }
    console.log('');
  }

  if (suggestions.length > 0) {
    console.log(`${bold}  Suggested pattern fixes${reset}`);
    for (const s of suggestions) {
      console.log(`  ${amber}→${reset} ${s}`);
    }
    console.log('');
  } else {
    console.log(`  ${green}✓ No systematic patterns found — classifier looks well-calibrated.${reset}`);
    console.log('');
  }

  const grade = accuracy >= 90 ? 'A' : accuracy >= 80 ? 'B' : accuracy >= 70 ? 'C' : 'D';
  const gradeColor = accuracy >= 90 ? green : accuracy >= 80 ? amber : red;
  console.log(`${gray}${'─'.repeat(44)}${reset}`);
  console.log(`  Grade: ${gradeColor}${bold}${grade}${reset}  ${dim}(${accuracy}% on ${total} real-world records)${reset}`);
  console.log('');
}

module.exports = { runValidateLog };
