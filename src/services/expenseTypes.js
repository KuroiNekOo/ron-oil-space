// Compat shim : l'API historique `expenseTypes` délègue désormais au référentiel
// unifié `services/types.js` (modèle Prisma `Type` + `ExpenseTypeConfig`).
//
// /!\ Wrapper conservé pendant la fenêtre de migration prod : il alimente les
// routes /admin/expense-types/* qui restent ouvertes le temps de la transition.
// Sera supprimé dans le commit de cleanup une fois la migration validée.
const types = require('./types');

async function getExpenseTypes() {
  return types.getExpenseTypes();
}

async function createExpenseType({ key, label, reimbursementPercent }) {
  // Le `key` historique est ignoré : le slug est désormais dérivé du label.
  return types.createType({
    label,
    scope: { expense: true, reimbursementPercent },
  });
}

async function updateExpenseType(id, body) {
  const patch = {};
  if (body.label !== undefined) patch.label = body.label;
  if (body.reimbursementPercent !== undefined) {
    patch.scope = { reimbursementPercent: body.reimbursementPercent };
  }
  return types.updateType(parseInt(id), patch);
}

async function deleteExpenseType(id) {
  return types.deleteType(parseInt(id));
}

module.exports = {
  ensureSeeded: types.ensureSeeded,
  slugify: types.slugify,
  getExpenseTypes,
  createExpenseType,
  updateExpenseType,
  deleteExpenseType,
  computeRefund: types.computeRefund,
};
