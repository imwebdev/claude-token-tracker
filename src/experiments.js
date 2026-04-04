/**
 * A/B routing experiments — test competing models for a task family
 * and measure which performs better before permanently adjusting routing.
 *
 * Experiments are stored at ~/.token-coach/experiments.json
 * One active experiment per family at a time.
 */

const fs = require('fs');
const dataHome = require('./data-home');

function experimentsPath() {
  return dataHome.getPath('experiments.json');
}

function loadExperiments() {
  const fp = experimentsPath();
  if (!fs.existsSync(fp)) return { active: {}, completed: [] };
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return { active: {}, completed: [] };
  }
}

function saveExperiments(data) {
  dataHome.ensureDataHome();
  fs.writeFileSync(experimentsPath(), JSON.stringify(data, null, 2) + '\n');
}

function nowIso() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  const sign = off <= 0 ? '+' : '-';
  const absH = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const absM = String(Math.abs(off) % 60).padStart(2, '0');
  return local.toISOString().replace('Z', `${sign}${absH}:${absM}`);
}

function makeId() {
  return 'exp-' + Date.now().toString(36);
}

/**
 * Get the active experiment for a given task family.
 * Returns the experiment object or null.
 */
function getActiveExperiment(family) {
  const data = loadExperiments();
  const exp = data.active[family];
  if (!exp || exp.status !== 'running') return null;
  return exp;
}

/**
 * Create a new experiment.
 * @param {string} family - Task family (e.g. 'code_edit')
 * @param {string[]} models - Two models to A/B test (e.g. ['haiku', 'sonnet'])
 * @param {number} target - Total assignments before auto-completing (default 50)
 * @param {number} split - % for models[0] (default 50)
 */
function createExperiment(family, models, target = 50, split = 50) {
  if (!family) throw new Error('family is required');
  if (!Array.isArray(models) || models.length < 2) throw new Error('models must be an array of 2 model names');

  const data = loadExperiments();

  // Archive any existing active experiment for this family
  if (data.active[family]) {
    const old = data.active[family];
    old.status = 'superseded';
    old.completedAt = nowIso();
    data.completed.push(old);
  }

  const results = {};
  for (const m of models) {
    results[m] = { total: 0, successes: 0 };
  }

  const exp = {
    id: makeId(),
    family,
    models,
    split: Math.max(0, Math.min(100, split)),
    count: 0,
    target,
    results,
    createdAt: nowIso(),
    status: 'running',
  };

  data.active[family] = exp;
  saveExperiments(data);
  return exp;
}

/**
 * Randomly assign a model from the experiment according to split ratio.
 * models[0] gets `split`% of assignments; models[1] gets the rest.
 */
function assignModel(experiment) {
  if (!experiment || !experiment.models || experiment.models.length < 2) return null;
  const roll = Math.random() * 100;
  return roll < experiment.split ? experiment.models[0] : experiment.models[1];
}

/**
 * Record the outcome of an assignment.
 * Automatically completes the experiment when it reaches target.
 */
function recordExperimentResult(family, model, success) {
  const data = loadExperiments();
  const exp = data.active[family];
  if (!exp || exp.status !== 'running') return null;
  if (!exp.results[model]) exp.results[model] = { total: 0, successes: 0 };

  exp.results[model].total++;
  if (success) exp.results[model].successes++;
  exp.count++;

  // Auto-complete when target is reached
  if (exp.count >= exp.target) {
    exp.status = 'completed';
    exp.completedAt = nowIso();
    exp.winner = _pickWinner(exp);
    data.completed.push(exp);
    delete data.active[family];
  }

  saveExperiments(data);
  return exp;
}

/**
 * Stop (cancel) the active experiment for a family.
 */
function stopExperiment(family) {
  const data = loadExperiments();
  const exp = data.active[family];
  if (!exp) return null;

  exp.status = 'stopped';
  exp.completedAt = nowIso();
  exp.winner = _pickWinner(exp);
  data.completed.push(exp);
  delete data.active[family];
  saveExperiments(data);
  return exp;
}

/**
 * Determine which model performed better (by success rate).
 * Returns the winning model name, or null if tied / insufficient data.
 */
function _pickWinner(exp) {
  let bestModel = null;
  let bestRate = -1;
  for (const model of exp.models) {
    const r = exp.results[model] || { total: 0, successes: 0 };
    const rate = r.total > 0 ? r.successes / r.total : 0;
    if (rate > bestRate) { bestRate = rate; bestModel = model; }
  }
  return bestModel;
}

/**
 * Get a summary report of all experiments (active + completed).
 */
function getExperimentReport() {
  const data = loadExperiments();

  const active = Object.values(data.active).map(exp => ({
    ...exp,
    progress: `${exp.count}/${exp.target}`,
    modelStats: _buildModelStats(exp),
  }));

  const completed = data.completed.map(exp => ({
    ...exp,
    progress: `${exp.count}/${exp.target}`,
    modelStats: _buildModelStats(exp),
  }));

  return {
    active,
    completed,
    totalExperiments: active.length + completed.length,
  };
}

function _buildModelStats(exp) {
  return exp.models.map(model => {
    const r = exp.results[model] || { total: 0, successes: 0 };
    return {
      model,
      total: r.total,
      successes: r.successes,
      rate: r.total > 0 ? Math.round(r.successes / r.total * 100) : null,
    };
  });
}

module.exports = {
  getActiveExperiment,
  createExperiment,
  assignModel,
  recordExperimentResult,
  stopExperiment,
  getExperimentReport,
};
