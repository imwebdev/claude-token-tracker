const ORDER = ['haiku', 'sonnet', 'opus'];

function getNextModel(model) {
  const index = ORDER.indexOf(model);
  if (index < 0 || index === ORDER.length - 1) return null;
  return ORDER[index + 1];
}

function buildEscalationChain(startModel) {
  const chain = [];
  let current = startModel;
  while (current) {
    chain.push(current);
    current = getNextModel(current);
  }
  return chain;
}

function shouldEscalate(validation, currentModel) {
  if (!validation || validation.ok) return false;
  return Boolean(getNextModel(currentModel));
}

module.exports = {
  buildEscalationChain,
  getNextModel,
  shouldEscalate,
};
